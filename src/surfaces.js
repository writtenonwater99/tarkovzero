/**
 * Return an independently measured absolute surface altitude in displayed metres.
 *
 * `surfaceY` is not a lift above terrain. Keeping that distinction in one helper prevents
 * bridge decks (and future surveyed hard surfaces) from inheriting a carved or fitted ground Y.
 */
export function measuredSurfaceY(feature, relief = 1) {
  if (!Number.isFinite(feature?.surfaceY)) return null;
  const factor = [1, 2, 3].includes(Number(relief)) ? Number(relief) : 1;
  return feature.surfaceY * factor;
}

const factorFor = (relief) => ([1, 2, 3].includes(Number(relief)) ? Number(relief) : 1);
const cleanName = (value) => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const buildingScope = (building) => building?.sourceKey ? `building:${building.sourceKey}` : null;

/**
 * Resolve the compact floorSurfaces index into render-ready absolute elevations.
 *
 * Binding order is deliberately explicit: the reviewed feature ID wins, then the emitted
 * building source key, then the legacy scope string. Cell rows have measured Y but no trustworthy
 * footprint and therefore remain evidence-only; inventing a 20 m square would be false geometry.
 */
export function createFloorSurfaceResolver(rows = [], relief = 1) {
  const factor = factorFor(relief);
  const valid = (Array.isArray(rows) ? rows : []).filter((row) =>
    ['floor', 'roof', 'underground'].includes(row?.classification) && Number.isFinite(row?.surfaceY));
  const byBuildingId = new Map(), byBuildingSourceKey = new Map(), byScope = new Map();
  const add = (map, key, row) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  };
  for (const row of valid) {
    add(byBuildingId, row.buildingId ?? row.featureId, row);
    add(byBuildingSourceKey, row.buildingSourceKey, row);
    add(byScope, row.scope, row);
  }

  const rowsForBuilding = (building) => {
    const candidates = [
      building?.featureId && byBuildingId.get(building.featureId),
      building?.sourceKey && byBuildingSourceKey.get(building.sourceKey),
      buildingScope(building) && byScope.get(buildingScope(building)),
    ];
    return candidates.find((candidate) => candidate?.length) ?? [];
  };

  const buildingProfile = (building, { fallbackBase = 0, fallbackHeight = building?.height ?? 0 } = {}) => {
    const linked = rowsForBuilding(building);
    const measuredFloors = linked.filter((row) => row.classification === 'floor' && Number.isInteger(row.floorIndex) && row.floorIndex >= 0)
      .sort((a, b) => a.floorIndex - b.floorIndex);
    const floorCount = Math.max(1, Math.floor(Number(building?.floors) || 1), ...measuredFloors.map((row) => row.floorIndex + 1));
    const floorZero = measuredFloors.find((row) => row.floorIndex === 0) ?? null;
    const localBase = Number(fallbackBase) || 0;
    // Relief exaggerates the terrain datum, never the height of a room. Translate every surveyed
    // plane by the same local-ground delta so 1x remains exact while 2x/3x keep real storey gaps.
    const rawLocalBase = localBase / factor;
    const toDisplayY = (surfaceY) => factor === 1
      ? Number(surfaceY)
      : localBase + (Number(surfaceY) - rawLocalBase);
    const baseY = floorZero ? toDisplayY(floorZero.surfaceY) : localBase;
    const roof = linked.filter((row) => row.classification === 'roof')
      .sort((a, b) => (b.evidenceSourceIds?.length ?? 0) - (a.evidenceSourceIds?.length ?? 0) || b.surfaceY - a.surfaceY)[0] ?? null;
    const measuredRoofY = roof ? toDisplayY(roof.surfaceY) : null;
    const fallbackTopY = baseY + Math.max(0.4, Number(fallbackHeight) || 0.4);
    const measuredByIndex = new Map(measuredFloors.map((row) => [row.floorIndex, toDisplayY(row.surfaceY)]));
    const highestMeasuredFloor = Math.max(baseY, ...measuredByIndex.values());
    const roofY = measuredRoofY != null && measuredRoofY > highestMeasuredFloor + 0.2 ? measuredRoofY : Math.max(fallbackTopY, highestMeasuredFloor + 0.4);
    const floorYs = Array.from({ length: floorCount }, (_, index) => measuredByIndex.get(index)
      ?? (index === 0 ? baseY : baseY + ((roofY - baseY) * index) / floorCount));
    return {
      building,
      rows: linked,
      floorRows: measuredFloors,
      roofRow: roof,
      floorCount,
      baseY,
      roofY,
      height: Math.max(0.4, roofY - baseY),
      floorYs,
      toDisplayY,
      measuredBase: Boolean(floorZero),
      measuredRoof: measuredRoofY != null && roofY === measuredRoofY,
    };
  };

  const namedUnderground = new Map();
  for (const row of valid.filter((candidate) => candidate.classification === 'underground' && cleanName(candidate.name))) {
    const key = cleanName(row.name);
    const rank = row.scope?.startsWith('building:') ? 3 : row.scope?.startsWith('extent:') ? 2 : 1;
    const current = namedUnderground.get(key);
    if (!current || rank > current.rank || (rank === current.rank && (row.evidenceSourceIds?.length ?? 0) > (current.row.evidenceSourceIds?.length ?? 0))) {
      namedUnderground.set(key, { row, rank });
    }
  }
  const undergroundProfile = (item, { fallbackY = 0, fallbackReferenceY = null } = {}) => {
    const row = namedUnderground.get(cleanName(item?.name))?.row ?? null;
    const localY = Number(fallbackY) || 0;
    const rawReferenceY = Number.isFinite(fallbackReferenceY) ? Number(fallbackReferenceY) : localY / factor;
    return {
      item,
      row,
      surfaceY: row ? (factor === 1 ? row.surfaceY : localY + (row.surfaceY - rawReferenceY)) : localY,
      measured: Boolean(row),
      stableId: row?.stableId ?? null,
    };
  };

  const measuredFloorSlabs = (buildings = []) => buildings.flatMap((building) => {
    const profile = building?._surfaceProfile
      ?? buildingProfile(building, { fallbackBase: building?.base, fallbackHeight: building?.height });
    return profile.floorRows.map((row) => ({
      building,
      row,
      floorIndex: row.floorIndex,
      surfaceY: profile.floorYs[row.floorIndex],
      stableId: row.stableId ?? null,
    }));
  });

  const measuredBuildingUndergroundSlabs = (buildings = []) => buildings.flatMap((building) => {
    const profile = building?._surfaceProfile
      ?? buildingProfile(building, { fallbackBase: building?.base, fallbackHeight: building?.height });
    return rowsForBuilding(building)
      .filter((row) => row.classification === 'underground')
      .map((row) => ({
        building,
        row,
        surfaceY: profile.toDisplayY(row.surfaceY),
        stableId: row.stableId ?? null,
      }));
  });

  return {
    factor,
    rows: valid,
    rowsForBuilding,
    buildingProfile,
    undergroundProfile,
    measuredFloorSlabs,
    measuredBuildingUndergroundSlabs,
    stats: {
      input: valid.length,
      buildingBound: new Set(valid.filter((row) => row.buildingSourceKey || row.scope?.startsWith('building:')).map((row) => row.stableId ?? `${row.scope}|${row.classification}|${row.floorIndex}`)).size,
      namedUnderground: namedUnderground.size,
    },
  };
}

/** Relative storey planes, measured when available and shell-proportional only as a fallback. */
export function buildingFloorLevels(profile, { inset = 0, includeRoof = false } = {}) {
  if (!profile) return [];
  const levels = profile.floorYs.slice(1).map((surfaceY) => surfaceY - profile.baseY - inset)
    .filter((height) => height > 0.02 && height < profile.height - 0.02);
  if (includeRoof) levels.push(profile.height);
  return levels;
}

/** Wall height visible for the existing `all | 0..3 | U` floor selector contract. */
export function visibleBuildingHeight(profile, selectedFloor, inset = 0.4) {
  if (!profile) return 0;
  if (selectedFloor === 'all' || selectedFloor === 'U') return profile.height;
  const floorIndex = Math.max(0, Math.floor(Number(selectedFloor) || 0));
  if (floorIndex >= profile.floorCount - 1) return profile.height;
  const nextFloorY = profile.floorYs[floorIndex + 1];
  return Math.max(0.04, Math.min(profile.height, nextFloorY - profile.baseY - inset));
}
