#!/usr/bin/env node
// Deterministic, browser-free checks for the shared marker/elevation/3D pipeline.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { carveWaterHeightfield, makeWaterHeightCapper } from '../src/water.js';
import { loadExactMap, stableStringify } from './lib/exact-map-primitives.mjs';

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
  return execFileSync('git', ['show', `${BASELINE}:${path}`], { maxBuffer: 64 * 1024 * 1024 });
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
function sourcePosition(collection, raw) {
  if (collection === 'btrStops') return { x: raw.x, y: raw.y, z: raw.z };
  return raw.position;
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
  const [markerBytes, geometryBytes] = await Promise.all([readFile(markerPath), readFile(geometryPath)]);
  const markers = JSON.parse(markerBytes), document = JSON.parse(geometryBytes);
  const oldMarkerBytes = baselineFile(markerPath), oldGeometryBytes = baselineFile(geometryPath);
  const oldDocument = JSON.parse(oldGeometryBytes);
  hashRows.push([markerPath, sha256(oldMarkerBytes), sha256(markerBytes)], [geometryPath, sha256(oldGeometryBytes), sha256(geometryBytes)]);

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
    anchorRows.push([map, anchor.name, x, z, before, after, after - before]);
  }
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
    }
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
