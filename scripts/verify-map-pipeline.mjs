#!/usr/bin/env node
// Deterministic, browser-free checks for the shared marker/elevation/3D pipeline.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { carveWaterHeightfield, makeWaterHeightCapper } from '../src/water.js';
import {
  assertMarkerNameUniqueness, loadExactMap, normalizeMarkerName, reconcileMarkerRows, stableStringify,
} from './lib/exact-map-primitives.mjs';

const MAPS = ['customs', 'reserve', 'woods'];
const BASELINE = process.argv.find((argument) => argument.startsWith('--baseline='))?.slice('--baseline='.length) || 'HEAD';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fail = (message) => { throw new Error(message); };
const assert = (condition, message) => { if (!condition) fail(message); };
const close = (actual, expected, tolerance, message) => assert(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const inPoly = ([x, z], poly) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
};
const cr = (p0, p1, p2, p3, u) => {
  const u2 = u * u, u3 = u2 * u;
  return p0 * (-0.5 * u3 + u2 - 0.5 * u) + p1 * (1.5 * u3 - 2.5 * u2 + 1)
    + p2 * (-1.5 * u3 + 2 * u2 + 0.5 * u) + p3 * (0.5 * u3 - 0.5 * u2);
};
function gaussianOnce(heights, cols, rows) {
  const kernel = [1, 4, 6, 4, 1], source = Float32Array.from(heights), temp = new Float32Array(source.length), output = new Float32Array(source.length);
  for (let row = 0; row < rows; row++) for (let column = 0; column < cols; column++) {
    let sum = 0;
    for (let offset = -2; offset <= 2; offset++) sum += source[row * cols + clamp(column + offset, 0, cols - 1)] * kernel[offset + 2];
    temp[row * cols + column] = sum / 16;
  }
  for (let row = 0; row < rows; row++) for (let column = 0; column < cols; column++) {
    let sum = 0;
    for (let offset = -2; offset <= 2; offset++) sum += temp[clamp(row + offset, 0, rows - 1) * cols + column] * kernel[offset + 2];
    output[row * cols + column] = sum / 16;
  }
  return output;
}
function canonicalTerrainSampler(document) {
  const terrain = document.terrain;
  const { x0, z0, step, cols, rows } = terrain;
  const grid = carveWaterHeightfield(gaussianOnce(terrain.heights, cols, rows), terrain, document.water || []);
  const at = (column, row) => grid[clamp(row, 0, rows - 1) * cols + clamp(column, 0, cols - 1)];
  const bicubic = (x, z) => {
    const fx = (x - x0) / step, fz = (z - z0) / step;
    const column = Math.floor(fx), row = Math.floor(fz), u = fx - column, v = fz - row;
    return cr(
      cr(at(column - 1, row - 1), at(column, row - 1), at(column + 1, row - 1), at(column + 2, row - 1), u),
      cr(at(column - 1, row), at(column, row), at(column + 1, row), at(column + 2, row), u),
      cr(at(column - 1, row + 1), at(column, row + 1), at(column + 1, row + 1), at(column + 2, row + 1), u),
      cr(at(column - 1, row + 2), at(column, row + 2), at(column + 1, row + 2), at(column + 2, row + 2), u),
      v,
    );
  };
  const capWater = makeWaterHeightCapper(document.water || [], 1);
  return (x, z) => capWater(bicubic(x, z), x, z);
}
function surfaceSampler(document, relief = 1) {
  const canonical = canonicalTerrainSampler(document);
  return (x, z) => {
    const base = canonical(x, z) * relief;
    return Math.max(base, ...(document.hardRocks || []).filter((rock) => inPoly([x, z], rock.poly))
      .map((rock) => Number.isFinite(rock.surfaceY) ? rock.surfaceY * relief : base + rock.height * relief));
  };
}
function baselineFile(path) {
  try {
    return execFileSync('git', ['show', `${BASELINE}:${path}`], { maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    // Some managed sandboxes return the completed stdout with status 0 while
    // wrapping the child-process call in EPERM. The bytes are still the exact
    // git object; only accept this narrow successful-output case.
    if (error?.status === 0 && error.stdout?.length) return error.stdout;
    throw error;
  }
}
function markerRows(markers, collection) {
  const target = {
    spawns: 'spawns', extracts: 'extracts', transits: 'extracts', locks: 'locks', switches: 'switches',
    hazards: 'hazards', lootContainers: 'containers', lootLoose: 'containers', stationaryWeapons: 'stationaryWeapons',
    btrStops: 'btrStops', artilleryZones: 'artilleryZones',
  }[collection];
  return markers[target] || [];
}
const SOURCE_KIND = {
  spawns: 'spawn', extracts: 'extract', transits: 'transit', locks: 'lock', switches: 'switch', hazards: 'hazard',
  lootContainers: 'lootContainer', lootLoose: 'looseLoot', stationaryWeapons: 'stationaryWeapon', btrStops: 'btrStop', artilleryZones: 'artilleryZone',
};
const EXPECTED_MARKER_COUNTS = {
  customs: { extract: 28, transit: 4, lock: 62, switch: 1, hazard: 5, lootContainer: 619, looseLoot: 416, spawn: 283, stationaryWeapon: 7, btrStop: 0, artilleryZone: 2 },
  reserve: { extract: 11, transit: 3, lock: 33, switch: 5, hazard: 4, lootContainer: 1002, looseLoot: 766, spawn: 167, stationaryWeapon: 8, btrStop: 0, artilleryZone: 2 },
  woods: { extract: 20, transit: 4, lock: 5, switch: 0, hazard: 64, lootContainer: 437, looseLoot: 387, spawn: 368, stationaryWeapon: 2, btrStop: 8, artilleryZone: 2 },
};
const EXPECTED_ANCHOR_HEIGHTS = {
  customs: { 'Big Red': 1.81, 'Dorms 2-Story': 0.75, Fortress: 1.74, 'Old Gas': 2.03, 'Water Pump': 1.18, 'Main Bridge': -6.68 },
  reserve: { 'White Pawn': -1.25, Helipad: -5.09, 'White Queen / Dome': 19.54, 'D-2': 15.60, 'White Rook / Train Station': -6.25, 'Bunker Hermetic Door': -0.35 },
  woods: { 'Sniper Mountain Summit': 77.52, 'Upper Mountain': 64.62, 'Mountain Flank': 52.27, 'Train Depot': 9.05, 'USEC Camp': 24.57, Sawmill: -2.83 },
};
const EXPECTED_OUTPUT_HASHES = {
  'public/data/customs.json': 'fe49b31cd7791ab8a46201180d9f019efabc35f0f9a73d656d27c09aa2ed2257',
  'public/data/customs-3d.json': '2fc39043aeb7627d8ba46d7e0ed353a0ce0cc19d9bec8b02505f247a9ec1306c',
  'public/data/reserve.json': '0dc4ceeca5228ea7012f0c52f0d37aa425a32433886c0f7e28ae01a128178036',
  'public/data/reserve-3d.json': '81d67bf8a6b845e40cc8c4b4ed9d82fa70399b1096cda9338b2f0259829d1bbf',
  'public/data/woods.json': '95dfe4fd6e67e4af980cc48c853f01f886c38b9b97d2029b9741d6b7f52dadbd',
  'public/data/woods-3d.json': '375a7359c772991b48a7b0ebeeda202fdcdf4c704993b1486750619160265702',
};

// A small contract fixture catches matcher-order and exact-geometry regressions
// even when a particular live cache happens not to exercise every branch.
const mergerFixture = reconcileMarkerRows([
  { source: 'tarkov.dev-json', sourceKind: 'extract', sourceId: 'exact-fixture', id: 'dev-fixture', name: 'Railroad Passage (Flare)', faction: 'pmc', level: 'surface', position: { x: 1, y: 9, z: 2 }, size: { x: 3 }, outline: [{ x: 0, y: 9, z: 2 }], top: 10, bottom: 8 },
], [
  { source: 'eft-wiki', sourceKind: 'extract', sourceId: 'wiki-fixture', name: 'railroad passage', faction: 'pmc', level: 'underground', position: { x: 500, z: 500 }, description: 'Wiki description', requirementText: 'Fire flare' },
]);
assert(normalizeMarkerName(' Railroad Passage (Flare) ') === 'railroadpassage', 'marker-name normalization contract failed');
assert(mergerFixture.rows.length === 1 && mergerFixture.stats[0].byName === 1, 'name-first marker reconciliation contract failed');
assert(stableStringify(mergerFixture.rows[0].position) === stableStringify({ x: 1, y: 9, z: 2 })
  && mergerFixture.rows[0].level === 'surface' && mergerFixture.rows[0].top === 10 && mergerFixture.rows[0].description === 'Wiki description',
'exact geometry / Wiki enrichment reconciliation contract failed');
const priorityFixture = reconcileMarkerRows([
  { source: 'tarkov.dev-json', sourceKind: 'lock', sourceId: 'exact-id', name: 'ID target', position: { x: 0, y: 1, z: 0 } },
  { source: 'tarkov.dev-json', sourceKind: 'lock', sourceId: 'exact-name', name: 'Name target', position: { x: 100, y: 2, z: 0 } },
], [
  { source: 'eft-wiki', sourceKind: 'lock', sourceId: 'wiki', tarkovDevId: 'exact-id', name: 'Name target', position: { x: 100, z: 0 } },
], { maxDistance: 25 });
assert(priorityFixture.stats[0].byId === 1
  && priorityFixture.rows[0].corroboratedBy.includes('eft-wiki:wiki')
  && !priorityFixture.rows[1].corroboratedBy,
'ID-first matcher priority contract failed');
const multiWitnessFixture = reconcileMarkerRows([
  { source: 'tarkov.dev-json', sourceKind: 'spawn', sourceId: 'exact-spawn', position: { x: 0, y: 1, z: 0 } },
], [
  { source: 'spt-4.1.2', sourceKind: 'spawn', sourceId: 'spt-a', position: { x: 1, y: 1, z: 0 } },
  { source: 'spt-4.1.2', sourceKind: 'spawn', sourceId: 'spt-b', position: { x: 2, y: 1, z: 0 } },
], { nameOf: () => '' });
assert(multiWitnessFixture.rows.length === 1 && multiWitnessFixture.stats[0].byDistance === 2
  && multiWitnessFixture.rows[0].corroboratedBy.length === 3,
'multiple-secondary-witness reconciliation contract failed');
const duplicateFixture = [{
  rows: [
    { source: 'tarkov.dev-json', sourceKind: 'extract', sourceId: 'checkpoint-a', name: 'Scav Checkpoint', faction: 'scav' },
    { source: 'tarkov.dev-json', sourceKind: 'extract', sourceId: 'checkpoint-b', name: 'Scav Checkpoint (Co-op)', faction: 'scav' },
  ],
  kindOf: (row) => row.sourceKind, nameOf: (row) => row.name, factionOf: (row) => row.faction,
}];
let duplicateRejected = false;
try { assertMarkerNameUniqueness('fixture', duplicateFixture); } catch { duplicateRejected = true; }
assert(duplicateRejected, 'unwhitelisted duplicate marker contract failed');
assert(assertMarkerNameUniqueness('fixture', duplicateFixture, [
  { kind: 'extract', name: 'Scav Checkpoint', faction: 'scav', count: 2 },
]).length === 1, 'duplicate marker whitelist contract failed');
function sourcePosition(collection, raw) {
  if (collection === 'btrStops') return { x: raw.x, y: raw.y, z: raw.z };
  return raw.position;
}
function semanticMarkerCollections(markers) {
  return [
    { rows: markers.extracts, kindOf: (row) => row.sourceKind, nameOf: (row) => row.name, factionOf: (row) => row.faction },
    { rows: markers.locks, kindOf: (row) => row.sourceKind, nameOf: (row) => row.key?.name },
    { rows: markers.switches, kindOf: (row) => row.sourceKind, nameOf: (row) => row.name },
    { rows: markers.hazards, kindOf: (row) => row.sourceKind, nameOf: (row) => row.name },
    { rows: markers.containers, kindOf: (row) => row.sourceKind, nameOf: (row) => row.name },
    { rows: markers.spawns, kindOf: (row) => row.sourceKind, nameOf: (row) => row.name },
    { rows: markers.stationaryWeapons, kindOf: (row) => row.sourceKind, nameOf: (row) => row.stationaryWeapon?.name },
    { rows: markers.btrStops, kindOf: (row) => row.sourceKind, nameOf: (row) => row.name },
  ];
}
function markerKindCounts(markers) {
  const rows = [
    ...markers.extracts, ...markers.locks, ...markers.switches, ...markers.hazards,
    ...markers.containers, ...markers.spawns, ...markers.stationaryWeapons, ...markers.btrStops,
  ];
  return Object.fromEntries(Object.keys(EXPECTED_MARKER_COUNTS.customs)
    .map((kind) => [kind, rows.filter((row) => row.sourceKind === kind).length]));
}
function assertFeatureResults(map, document) {
  const assignments = document.features.assignments;
  if (map === 'customs') {
    const dorms = assignments.find((item) => item.featureRoot === 'customs.dorms.two_story.main');
    assert(dorms?.floors === 2, 'Customs Dorms 2-Story floor assertion failed');
    assert(assignments.filter((item) => item.featureRoot === 'customs.water_pump.cooling_towers' && item.kind === 'cooling_tower' && item.heightM >= 24).length === 3, 'Customs cooling-tower assertion failed');
  }
  if (map === 'reserve') {
    assert(assignments.find((item) => item.featureRoot === 'reserve.white_pawn.main')?.floors === 5, 'Reserve White Pawn assertion failed');
    assert(assignments.find((item) => item.featureRoot === 'reserve.helipad.service_footprint')?.heightM <= 4.5, 'Reserve Helipad footprint assertion failed');
  }
  if (map === 'woods') {
    assert(document.props.filter((item) => item.featureRoot === 'woods.train_depot.freight_cars' && item.type === 'railcar').length === 6, 'Woods freight-car assertion failed');
    assert(document.props.filter((item) => item.featureRoot === 'woods.train_depot.cargo' && item.type === 'container').length === 10, 'Woods depot-cargo assertion failed');
    assert(!assignments.some((item) => item.featureRoot.startsWith('woods.train_depot.') && item.place === 'Railway Bridge to Tarkov'), 'Woods depot still carries Railway Bridge label');
  }
}

const anchorRows = [], hashRows = [];
for (const map of MAPS) {
  const markerPath = `public/data/${map}.json`, geometryPath = `public/data/${map}-3d.json`;
  const [markerBytes, geometryBytes, featureBytes] = await Promise.all([
    readFile(markerPath), readFile(geometryPath), readFile(`data/${map}-features.json`),
  ]);
  const markers = JSON.parse(markerBytes), document = JSON.parse(geometryBytes);
  const featureManifest = JSON.parse(featureBytes);
  const oldMarkerBytes = baselineFile(markerPath), oldGeometryBytes = baselineFile(geometryPath);
  const oldDocument = JSON.parse(oldGeometryBytes);
  const markerHash = sha256(markerBytes), geometryHash = sha256(geometryBytes);
  assert(markerHash === EXPECTED_OUTPUT_HASHES[markerPath], `${map}: marker output hash drifted`);
  assert(geometryHash === EXPECTED_OUTPUT_HASHES[geometryPath], `${map}: 3D output hash drifted`);
  hashRows.push([markerPath, sha256(oldMarkerBytes), markerHash], [geometryPath, sha256(oldGeometryBytes), geometryHash]);

  assert(document.canonicalScale === 1 && document.terrain.units?.scale === 1, `${map}: canonical output is not 1x`);
  const reliefKeys = [];
  const scan = (value, path = '') => {
    if (Array.isArray(value)) return value.forEach((item, index) => scan(item, `${path}[${index}]`));
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) { if (/relief/i.test(key)) reliefKeys.push(`${path}.${key}`); scan(child, `${path}.${key}`); }
  };
  scan(document);
  assert(!reliefKeys.length, `${map}: relief was baked into generated data at ${reliefKeys.join(', ')}`);
  const heightHash = sha256(Buffer.from(JSON.stringify(document.terrain.heights)));
  const surface1 = surfaceSampler(document, 1), surface3 = surfaceSampler(document, 3), oldSurface = surfaceSampler(oldDocument, 1);
  for (const anchor of document.features.anchors) {
    const [x, z] = anchor.position, before = oldSurface(x, z), after = surface1(x, z);
    close(surface3(x, z), after * 3, 1e-4, `${map}/${anchor.name}: 3x sampler is not a pure view skin`);
    assert(Object.hasOwn(EXPECTED_ANCHOR_HEIGHTS[map], anchor.name), `${map}/${anchor.name}: unexpected verification anchor`);
    close(after, EXPECTED_ANCHOR_HEIGHTS[map][anchor.name], 0.015, `${map}/${anchor.name}: canonical anchor height drifted`);
    anchorRows.push([map, anchor.name, x, z, before, after, after - before]);
  }
  assert(document.features.anchors.length === Object.keys(EXPECTED_ANCHOR_HEIGHTS[map]).length, `${map}: expected anchor count drifted`);
  assert(heightHash === sha256(Buffer.from(JSON.stringify(document.terrain.heights))), `${map}: sampler mutated canonical heights`);

  const exactSource = await loadExactMap(map);
  assert(stableStringify(document.exact) === stableStringify(exactSource.exact), `${map}: serialized exact layer differs from verified cache`);
  assert(markers.exactCache?.cacheVersion === document.exact.source.cacheVersion, `${map}: marker and geometry exact-cache versions differ`);
  for (const [collection, sourceItems] of Object.entries(document.exact.collections)) {
    const rendered = markerRows(markers, collection);
    for (const sourceItem of sourceItems) {
      const projected = rendered.find((row) => row.source === 'tarkov.dev-json' && row.sourceKind === SOURCE_KIND[collection] && row.sourceId === sourceItem.sourceId);
      assert(projected, `${map}: ${collection}/${sourceItem.sourceId} was not projected into renderer markers`);
      const exactPosition = sourcePosition(collection, sourceItem.raw);
      if (exactPosition && projected.position) {
        assert(projected.position.x === exactPosition.x && projected.position.y === exactPosition.y && projected.position.z === exactPosition.z,
          `${map}: ${collection}/${sourceItem.sourceId} lost exact position precision`);
      }
      for (const field of ['size', 'outline']) if (sourceItem.raw[field] != null) {
        assert(stableStringify(projected[field]) === stableStringify(sourceItem.raw[field]), `${map}: ${collection}/${sourceItem.sourceId} lost exact ${field}`);
      }
      if (Number.isFinite(sourceItem.raw.top)) assert(projected.top === sourceItem.raw.top, `${map}: ${collection}/${sourceItem.sourceId} lost exact top`);
      if (Number.isFinite(sourceItem.raw.bottom ?? sourceItem.raw.botom)) {
        assert(projected.bottom === (sourceItem.raw.bottom ?? sourceItem.raw.botom), `${map}: ${collection}/${sourceItem.sourceId} lost exact bottom`);
      }
    }
  }
  assert(stableStringify(markerKindCounts(markers)) === stableStringify(EXPECTED_MARKER_COUNTS[map]), `${map}: reconciled marker counts drifted`);
  assertMarkerNameUniqueness(map, semanticMarkerCollections(markers), featureManifest.markerDuplicateWhitelist ?? []);
  for (const group of ['extracts', 'locks', 'switches', 'stationaryWeapons', 'containers', 'spawns']) for (const row of markers[group] || []) {
    if (!row.corroboratedBy?.length) continue;
    const ownWitness = `${row.source}:${row.sourceId ?? row.id}`;
    assert(row.corroboratedBy.includes(ownWitness), `${map}: ${group}/${row.sourceId} corroboration omits authoritative source`);
    assert(row.corroboratedBy.some((witness) => witness !== ownWitness), `${map}: ${group}/${row.sourceId} corroboration has no secondary source`);
    assert(new Set(row.corroboratedBy).size === row.corroboratedBy.length, `${map}: ${group}/${row.sourceId} repeats a corroboration source`);
  }
  for (const group of ['extracts', 'locks', 'switches', 'stationaryWeapons', 'containers']) for (const row of markers[group] || []) {
    if (row.source === 'eft-wiki') {
      assert(row.visualApproximate === true, `${map}: Wiki-only ${group}/${row.sourceId} lacks visualApproximate`);
      assert(!Object.hasOwn(row.position || {}, 'y'), `${map}: Wiki-only ${group}/${row.sourceId} fabricated Y`);
    }
  }
  assert(markers.hazards.length >= document.exact.collections.hazards.length + document.exact.collections.artilleryZones.length, `${map}: hazards/artillery were dropped`);
  if (map === 'reserve') assert(markers.locks.filter((item) => item.source === 'tarkov.dev-json').length === 33, 'Reserve exact locks were dropped');

  const evidence = document.terrain.evidence;
  assert(evidence.schemaVersion === 2, `${map}: typed elevation evidence schema missing`);
  assert(Object.values(evidence.bucketCounts).reduce((sum, count) => sum + count, 0) === evidence.input, `${map}: evidence buckets do not account for every input`);
  for (const [bucket, points] of Object.entries(evidence.buckets)) for (const point of points) {
    assert([point.x, point.y, point.z].every(Number.isFinite), `${map}: ${bucket} contains a non-finite point`);
    assert(point.reasonCodes?.length, `${map}: ${bucket}/${point.sourceId} has no reason code`);
  }
  const routedExactIds = new Set(Object.values(evidence.buckets).flat().filter((point) => point.provider === 'tarkov.dev-json').map((point) => point.sourceId));
  for (const [collection, items] of Object.entries(document.exact.collections)) for (const item of items) {
    if (sourcePosition(collection, item.raw)) assert(routedExactIds.has(`${collection}:${item.sourceId}`), `${map}: exact Y ${collection}/${item.sourceId} never entered the elevation router`);
  }
  assert(evidence.buckets.ground.some((point) => point.provider === 'tarkov.dev-json') && evidence.buckets.ground.some((point) => point.provider === 'spt-4.1.2'), `${map}: exact and SPT evidence do not share the ground pipeline`);
  assert(document.floorSurfaces.length > 0 && document.floorSurfaces.some((surface) => surface.classification === 'underground') && document.floorSurfaces.some((surface) => surface.classification === 'roof'), `${map}: roof/underground evidence did not feed floor classification`);
  if (map === 'woods') {
    assert(evidence.buckets.rock.length > 0 && document.hardRocks.length > 0, 'Woods rock evidence did not feed hard-rock geometry');
    const contactForms = document.hardRocks.filter((rock) => rock.form === 'contact');
    assert(document.hardRocks.every((rock) => rock.evidenceSourceIds.length > 0), 'Woods hard-rock form has no routed rock evidence');
    assert(!document.rocks.some((rock) => contactForms.some((contact) => inPoly(rock.poly.reduce((sum, point) => [sum[0] + point[0] / rock.poly.length, sum[1] + point[1] / rock.poly.length], [0, 0]), contact.poly))), 'Woods legacy rock geometry stacks on the hard-rock region');
    close(surface1(-209.22, -279.78), 77.52, 0.01, 'Woods central summit');
  }
  assertFeatureResults(map, document);
}

console.log(`verified ${MAPS.length} maps: exact cache projection, typed elevation routing, reviewed feature assertions, and sampler-only 1x/3x relief`);
console.log('\nAnchor heights (canonical 1x metres)');
console.log('| Map | Anchor | X | Z | Before | After | Delta |');
console.log('|---|---|---:|---:|---:|---:|---:|');
for (const [map, name, x, z, before, after, delta] of anchorRows) console.log(`| ${map} | ${name} | ${x.toFixed(2)} | ${z.toFixed(2)} | ${before.toFixed(2)} | ${after.toFixed(2)} | ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} |`);
console.log(`\nHashes (${BASELINE} before, worktree after)`);
console.log('| File | Before SHA-256 | After SHA-256 |');
console.log('|---|---|---|');
for (const [file, before, after] of hashRows) console.log(`| ${file} | \`${before}\` | \`${after}\` |`);
