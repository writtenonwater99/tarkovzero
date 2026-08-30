import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST_PATH = path.join(ROOT, 'scripts/data/tarkov-dev-exact-manifest.json');

export const EXACT_LAYER_SCHEMA_VERSION = 1;
export const EXACT_COLLECTIONS = Object.freeze([
  ['spawns', 'spawn'],
  ['extracts', 'extract'],
  ['transits', 'transit'],
  ['locks', 'lock'],
  ['switches', 'switch'],
  ['hazards', 'hazard'],
  ['lootContainers', 'lootContainer'],
  ['lootLoose', 'looseLoot'],
  ['stationaryWeapons', 'stationaryWeapon'],
  ['btrStops', 'btrStop'],
  ['artilleryZones', 'artilleryZone'],
]);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export const stableStringify = (value) => JSON.stringify(stableValue(value));

// Marker names are cross-provider witnesses, so compare their semantic text
// rather than display punctuation. Parenthetical suffixes such as "(Flare)" or
// "(Co-op)" are useful in the UI but do not distinguish the physical marker.
export function normalizeMarkerName(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{Mark}+/gu, '')
    .replace(/\([^)]*\)/g, '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

const markerDistance = (a, b) => a?.position && b?.position
  && Number.isFinite(a.position.x) && Number.isFinite(a.position.z)
  && Number.isFinite(b.position.x) && Number.isFinite(b.position.z)
  ? Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z)
  : Infinity;

const identityTokens = (row) => new Set(['sourceId', 'tarkovDevId', 'id', 'identityId']
  .map((field) => row?.[field])
  .filter((value) => value != null && value !== '')
  .map(String));

const sourceWitness = (row) => row?.source && (row.sourceId ?? row.id) != null
  ? `${row.source}:${row.sourceId ?? row.id}` : null;

const hasValue = (value) => value != null && value !== '';

/**
 * Reconcile authoritative exact markers with secondary SPT/Wiki witnesses.
 * Matching is deliberately ordered:
 *   1. shared source/tarkov.dev identity;
 *   2. normalized name plus faction and kind;
 *   3. nearest exact marker of the same kind within maxDistance.
 *
 * Exact rows always remain the output object. A matched Wiki row may only fill
 * descriptive fields that exact data does not provide; it can never replace
 * position, volume, outline, elevation, identity, or renderer semantics.
 */
export function reconcileMarkerRows(authoritative, secondary, {
  kindOf = (row) => row?.sourceKind,
  nameOf = (row) => row?.name,
  factionOf = (row) => row?.faction ?? '',
  maxDistance = 25,
  descriptiveFields = ['description', 'image', 'requirementText'],
  approximate = (row) => row?.source === 'eft-wiki',
} = {}) {
  const output = authoritative.map((row) => structuredClone(row));
  const exactIndices = output.map((_, index) => index);
  const kindOrder = [];
  const stats = new Map();
  const statFor = (kind) => {
    const token = String(kind ?? 'unknown');
    if (!stats.has(token)) {
      kindOrder.push(token);
      stats.set(token, { kind: token, exact: 0, secondary: 0, before: 0, matched: 0, after: 0, byId: 0, byName: 0, byDistance: 0 });
    }
    return stats.get(token);
  };
  for (const row of authoritative) { const stat = statFor(kindOf(row)); stat.exact++; stat.before++; }
  for (const row of secondary) { const stat = statFor(kindOf(row)); stat.secondary++; stat.before++; }

  const candidatesFor = (row) => exactIndices
    .filter((index) => kindOf(output[index]) === kindOf(row));
  const nearest = (indices, row) => indices
    .map((index) => ({ index, distance: markerDistance(output[index], row) }))
    .sort((a, b) => a.distance - b.distance || a.index - b.index)[0];

  for (const row of secondary) {
    const candidates = candidatesFor(row);
    const rowIds = identityTokens(row);
    let matchType = null;
    let choice = nearest(candidates.filter((index) => {
      const candidateIds = identityTokens(output[index]);
      return [...rowIds].some((id) => candidateIds.has(id));
    }), row);
    if (choice) matchType = 'Id';

    const rowName = normalizeMarkerName(nameOf(row));
    const rowFaction = String(factionOf(row) ?? '').toLowerCase();
    if (!choice && rowName) {
      choice = nearest(candidates.filter((index) => normalizeMarkerName(nameOf(output[index])) === rowName
        && String(factionOf(output[index]) ?? '').toLowerCase() === rowFaction), row);
      if (choice) matchType = 'Name';
    }

    if (!choice) {
      const distanceChoice = nearest(candidates, row);
      if (distanceChoice?.distance <= maxDistance) { choice = distanceChoice; matchType = 'Distance'; }
    }

    if (!choice) {
      output.push({ ...structuredClone(row), ...(approximate(row) ? { visualApproximate: true } : {}) });
      continue;
    }
    const hit = output[choice.index];
    const witnesses = [sourceWitness(hit), ...(hit.corroboratedBy ?? []), sourceWitness(row)].filter(Boolean);
    hit.corroboratedBy = [...new Set(witnesses)];
    if (row?.source === 'eft-wiki') for (const field of descriptiveFields) {
      if (!hasValue(hit[field]) && hasValue(row[field])) hit[field] = structuredClone(row[field]);
    }
    const stat = statFor(kindOf(row));
    stat.matched++;
    stat[`by${matchType}`]++;
  }

  for (const row of output) statFor(kindOf(row)).after++;
  return { rows: output, stats: kindOrder.map((kind) => stats.get(kind)) };
}

/**
 * Fail when a built map contains ambiguous same-kind semantic names. Repeated
 * generic physical markers (for example several Toolboxes) must be reviewed and
 * pinned to an exact count in data/<map>-features.json, so a new provider copy
 * cannot hide behind a broad exception.
 */
export function assertMarkerNameUniqueness(mapKey, collections, whitelist = []) {
  const groups = new Map();
  for (const collection of collections) for (const row of collection.rows ?? []) {
    const name = collection.nameOf?.(row) ?? row?.name;
    const normalizedName = normalizeMarkerName(name);
    if (!normalizedName) continue;
    const kind = String(collection.kindOf?.(row) ?? collection.kind ?? row?.sourceKind ?? 'unknown');
    const faction = String(collection.factionOf?.(row) ?? row?.faction ?? '').toLowerCase();
    const key = stableStringify([kind, normalizedName, faction]);
    if (!groups.has(key)) groups.set(key, { kind, name, normalizedName, faction, rows: [] });
    groups.get(key).rows.push(row);
  }

  const rules = whitelist.map((rule, index) => {
    if (!rule || typeof rule !== 'object' || !rule.kind || !rule.name || !Number.isInteger(rule.count) || rule.count < 2) {
      throw new Error(`${mapKey}: invalid markerDuplicateWhitelist entry ${index}; expected kind, name, and integer count >= 2`);
    }
    return {
      ...rule,
      normalizedName: normalizeMarkerName(rule.name),
      faction: String(rule.faction ?? '').toLowerCase(),
    };
  });
  const duplicateGroups = [...groups.values()].filter((group) => group.rows.length > 1);
  const problems = [];
  for (const group of duplicateGroups) {
    const rule = rules.find((candidate) => candidate.kind === group.kind
      && candidate.normalizedName === group.normalizedName && candidate.faction === group.faction);
    const sourceRows = group.rows.map((row) => `${row.source ?? 'unknown'}:${row.sourceId ?? row.id ?? '?'}`);
    const sources = `${sourceRows.slice(0, 6).join(', ')}${sourceRows.length > 6 ? `, ... +${sourceRows.length - 6}` : ''}`;
    if (!rule) problems.push(`${group.kind}/${group.name}/${group.faction || '-'} has ${group.rows.length} rows (${sources})`);
    else if (rule.count !== group.rows.length) problems.push(`${group.kind}/${group.name}/${group.faction || '-'} expected ${rule.count} whitelisted rows, got ${group.rows.length} (${sources})`);
  }
  for (const rule of rules) {
    const group = duplicateGroups.find((candidate) => candidate.kind === rule.kind
      && candidate.normalizedName === rule.normalizedName && candidate.faction === rule.faction);
    if (!group) problems.push(`stale whitelist ${rule.kind}/${rule.name}/${rule.faction || '-'} expected ${rule.count} duplicate rows`);
  }
  if (problems.length) throw new Error(`${mapKey}: duplicate marker name assertion failed:\n- ${problems.join('\n- ')}`);
  return duplicateGroups;
}

function cacheError(message) {
  return new Error(`${message}. Run: node scripts/fetch-map-primitives.mjs --date YYYY-MM-DD`);
}

async function loadManifest() {
  let raw;
  try {
    raw = await readFile(MANIFEST_PATH, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw cacheError('exact tarkov.dev cache manifest is missing');
    throw error;
  }
  let manifest;
  try { manifest = JSON.parse(raw); }
  catch (error) { throw cacheError(`exact tarkov.dev cache manifest is invalid JSON (${error.message})`); }
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.sources)) {
    throw cacheError(`unsupported exact tarkov.dev cache manifest schema ${manifest.schemaVersion}`);
  }
  return manifest;
}

async function loadSource(manifest, name) {
  const source = manifest.sources.find((candidate) => candidate.name === name);
  if (!source?.cachePath || !/^[a-f0-9]{64}$/.test(source.sha256 || '')) {
    throw cacheError(`exact tarkov.dev cache manifest has no valid ${name} source`);
  }
  const file = path.resolve(ROOT, source.cachePath);
  const cacheRoot = path.join(ROOT, 'scripts/data/tarkov-dev-exact') + path.sep;
  if (!file.startsWith(cacheRoot)) throw cacheError(`exact tarkov.dev ${name} cache path escapes scripts/data/tarkov-dev-exact`);
  let bytes;
  try { bytes = await readFile(file); }
  catch (error) {
    if (error?.code === 'ENOENT') throw cacheError(`exact tarkov.dev ${name} cache is missing at ${path.relative(ROOT, file)}`);
    throw error;
  }
  const actual = sha256(bytes);
  if (actual !== source.sha256) {
    throw cacheError(`exact tarkov.dev ${name} cache hash mismatch: expected ${source.sha256}, got ${actual}`);
  }
  let json;
  try { json = JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw cacheError(`exact tarkov.dev ${name} cache is invalid JSON (${error.message})`); }
  return { source, json };
}

function rawRecords(map, collection) {
  if (collection === 'artilleryZones') return map.artillery?.zones ?? [];
  return map[collection] ?? [];
}

function identityId(collection, raw) {
  if (raw?.id != null) return String(raw.id);
  if (collection === 'lootContainers' && raw?.lootContainer) return String(raw.lootContainer);
  if (collection === 'stationaryWeapons' && raw?.stationaryWeapon) return String(raw.stationaryWeapon);
  if (collection === 'btrStops' && raw?.name) return String(raw.name);
  return null;
}

function wrapRecords(collection, rows) {
  if (!Array.isArray(rows)) throw new Error(`exact tarkov.dev collection ${collection} is not an array`);
  const seen = new Map();
  return rows.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`exact tarkov.dev ${collection} contains a non-object record`);
    const rawId = raw.id == null ? null : String(raw.id);
    const generated = sha256(stableStringify(raw)).slice(0, 24);
    const base = rawId ?? `generated:${generated}`;
    const ordinal = (seen.get(base) ?? 0) + 1;
    seen.set(base, ordinal);
    return {
      sourceId: ordinal === 1 ? base : `${base}#${ordinal}`,
      ...(identityId(collection, raw) ? { identityId: identityId(collection, raw) } : {}),
      // `raw` is intentionally untouched: source spelling (including artillery's
      // current `botom` typo), precision, arrays and identity tokens stay verbatim.
      raw,
    };
  });
}

export function exactPosition(raw) {
  const position = raw?.position ?? raw;
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) return null;
  return { x: position.x, y: position.y, z: position.z };
}

export function translateExact(value, translations, suffix = '') {
  if (value == null || value === false) return '';
  const token = String(value);
  return translations?.[token + suffix] ?? translations?.[token] ?? token;
}

export function primitiveRows(exactLayer) {
  const out = [];
  for (const [collection, kind] of EXACT_COLLECTIONS) {
    for (const item of exactLayer.collections[collection] ?? []) out.push({ collection, kind, ...item });
  }
  return out;
}

export async function loadExactMap(mapKey) {
  const manifest = await loadManifest();
  const [{ source: mapsSource, json: mapsJson }, { source: namesSource, json: namesJson }] = await Promise.all([
    loadSource(manifest, 'maps'),
    loadSource(manifest, 'maps_en'),
  ]);
  const maps = mapsJson?.data?.maps;
  const translations = namesJson?.data;
  if (!maps || typeof maps !== 'object' || Array.isArray(maps)) throw cacheError('exact tarkov.dev maps cache has no data.maps object');
  if (!translations || typeof translations !== 'object' || Array.isArray(translations)) throw cacheError('exact tarkov.dev maps_en cache has no translation object');
  const map = Object.values(maps).find((candidate) => candidate?.normalizedName === mapKey);
  if (!map) throw new Error(`exact tarkov.dev cache has no map ${mapKey}`);

  const collections = {};
  for (const [collection] of EXACT_COLLECTIONS) collections[collection] = wrapRecords(collection, rawRecords(map, collection));
  const exact = {
    schemaVersion: EXACT_LAYER_SCHEMA_VERSION,
    source: {
      provider: 'tarkov.dev-json',
      cacheVersion: manifest.cacheVersion,
      fetchedDate: manifest.fetchedDate,
      urls: [mapsSource.url, namesSource.url],
      sha256: { maps: mapsSource.sha256, maps_en: namesSource.sha256 },
    },
    map: {
      id: map.id,
      normalizedName: map.normalizedName,
      nameId: map.nameId,
      name: translateExact(map.name, translations),
    },
    collections,
  };
  return {
    exact,
    map,
    translations,
    lookups: {
      lootContainers: mapsJson.data.lootContainers ?? {},
      stationaryWeapons: mapsJson.data.stationaryWeapons ?? {},
    },
  };
}
