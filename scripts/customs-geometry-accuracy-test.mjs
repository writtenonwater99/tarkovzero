#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stableStringify } from './lib/exact-map-primitives.mjs';

const markers = JSON.parse(await readFile('public/data/customs.json', 'utf8'));
const geometry = JSON.parse(await readFile('public/data/customs-3d.json', 'utf8'));

const exactLocks = geometry.exact.collections.locks;
assert.equal(markers.locks.length, exactLocks.length, 'only exact Customs locks may be world-positioned');
for (const source of exactLocks) {
  const projected = markers.locks.find((lock) => lock.source === 'tarkov.dev-json' && lock.sourceId === source.sourceId);
  assert(projected, `exact lock ${source.sourceId} was not projected`);
  assert.deepEqual(projected.position, source.raw.position, `exact lock ${source.sourceId} lost its authoritative position`);
  assert.equal(projected.positionAuthority, 'tarkov.dev-json');
}
assert(markers.locks.some((lock) => lock.corroboratedBy?.some((source) => source.startsWith('eft-wiki:'))),
  'matched Wiki locks should remain as corroboration metadata on exact locks');

const quarantinedLocks = markers.quarantinedMarkers?.locks ?? [];
assert.equal(quarantinedLocks.length, 28, 'the detached Wiki floor panels should quarantine 28 unmatched locks');
for (const lock of quarantinedLocks) {
  assert.equal(lock.reasonCode, 'detached-floor-panel-unanchored');
  assert.equal(lock.coordinateStatus, 'unanchored-wiki-panel');
  assert(!Object.hasOwn(lock, 'position'), `quarantined Wiki lock ${lock.sourceId} leaked a world position`);
}

assert.equal(geometry.boundary.authority, 'tarkov.dev-svg');
assert.equal(geometry.boundary.markerPolicy, 'diagnostic-only');
assert.equal(geometry.boundary.markerCount, [
  'extracts', 'spawns', 'hazards', 'stationaryWeapons', 'switches', 'locks', 'containers', 'btrStops',
].reduce((sum, group) => sum + (markers[group]?.length ?? 0), 0));
assert(geometry.limit.every(([x, z]) => x >= -372 && x <= 698 && z >= -307 && z <= 237),
  'marker evidence expanded the Customs source-SVG boundary');

const evidence = geometry.terrain.evidence;
assert.equal(evidence.schemaVersion, 3);
assert.deepEqual(evidence.heightfieldBuckets, ['ground', 'road']);
for (const bucket of ['ground', 'road', 'bridge-deck', 'water', 'rock', 'floor', 'roof', 'underground']) {
  assert(Array.isArray(evidence.buckets[bucket]), `missing ${bucket} evidence bucket`);
}
assert(evidence.buckets['bridge-deck'].length > 0, 'no bridge-deck evidence was routed');
assert(evidence.buckets.water.length > 0, 'no water evidence was routed');
const mainBridge = geometry.bridges.find((bridge) => bridge.name === 'Main Bridge');
assert(mainBridge?.evidence?.classification === 'bridge-deck' && mainBridge.evidence.sampleCount === evidence.buckets['bridge-deck'].length,
  'Main Bridge did not retain its routed deck evidence');
assert(Number.isFinite(mainBridge.surfaceY) && mainBridge.surfaceY > 0.5 && mainBridge.surfaceY < 2,
  'Main Bridge has no plausible measured deck altitude');

const heightfieldIds = new Set([...evidence.buckets.ground, ...evidence.buckets.road]
  .map((point) => `${point.provider}:${point.sourceId}`));
for (const bucket of ['bridge-deck', 'water', 'floor', 'roof', 'underground', 'rock']) {
  for (const point of evidence.buckets[bucket]) {
    assert(!heightfieldIds.has(`${point.provider}:${point.sourceId}`), `${bucket} point ${point.sourceId} entered the heightfield fit`);
  }
}
assert.equal(Object.values(evidence.bucketCounts).reduce((sum, count) => sum + count, 0), evidence.input,
  'typed evidence buckets do not account for every input');

const dormsThreeStorySourceKey = 'svg:Ground_Level/Buildings/Big_Buildings-2:element-194:subpath-0';
const dormsThreeStory = geometry.features.assignments.find((assignment) => assignment.featureId === 'customs.dorms.three_story.main');
assert.deepEqual({
  sourceKey: dormsThreeStory?.sourceKey,
  floors: dormsThreeStory?.floors,
  heightM: dormsThreeStory?.heightM,
  emittedAs: dormsThreeStory?.emittedAs,
}, {
  sourceKey: dormsThreeStorySourceKey,
  floors: 3,
  heightM: 9.5,
  emittedAs: 'building',
}, 'Dorms 3-Story does not resolve to its reviewed main shell');
assert(geometry.buildings.some((building) => building.sourceKey === dormsThreeStorySourceKey
  && building.featureId === dormsThreeStory.featureId && building.floors === 3 && building.height === 9.5),
'Dorms 3-Story reviewed assignment is dangling');

// Golden-cell lock: the authored Fortress factory is allowed to improve visual detail, but it
// must remain seated on this exact reviewed footprint and these measured playable elevations.
const fortressSourceKey = 'svg:Ground_Level/Buildings/Big_Buildings-2:element-196:subpath-0';
const fortress = geometry.buildings.find((building) => building.featureId === 'customs.building.fortress.main');
assert.deepEqual({
  sourceKey: fortress?.sourceKey,
  floors: fortress?.floors,
  heightM: fortress?.height,
  style: fortress?.style,
}, {
  sourceKey: fortressSourceKey,
  floors: 2,
  heightM: 18.1,
  style: 'frame',
}, 'Fortress does not resolve to its reviewed construction-factory shell');
const fortressCentroid = fortress.poly.reduce((sum, [x, z]) => [
  sum[0] + x / fortress.poly.length,
  sum[1] + z / fortress.poly.length,
], [0, 0]);
assert.deepEqual(fortressCentroid, [203, -128], 'Fortress reviewed footprint centroid drifted');
const fortressEdges = fortress.poly.map(([x, z], index) => {
  const [nextX, nextZ] = fortress.poly[(index + 1) % fortress.poly.length];
  return Math.hypot(nextX - x, nextZ - z);
}).sort((a, b) => a - b);
assert(Math.abs(fortressEdges[0] - 25.106572844575993) < 1e-9
  && Math.abs(fortressEdges[3] - 61.27723884118801) < 1e-9,
'Fortress reviewed footprint dimensions drifted');
for (const [stableId, classification, floorIndex, surfaceY] of [
  ['customs.surface.6af471a2ddbe2b71904bf384', 'floor', 0, 2.447],
  ['customs.surface.088520ea863c78b8cb29d787', 'floor', 1, 8.183],
  ['customs.surface.d20aeb8b845ab39db5f1bc8f', 'underground', 'U', -1.7874],
]) {
  const surface = geometry.floorSurfaces.find((candidate) => candidate.stableId === stableId);
  assert.deepEqual({
    classification: surface?.classification,
    floorIndex: surface?.floorIndex,
    featureId: surface?.featureId,
    surfaceY: surface?.surfaceY,
  }, {
    classification,
    floorIndex,
    featureId: fortress.featureId,
    surfaceY,
  }, `Fortress playable surface ${stableId} drifted`);
}

const buildingsBySource = new Map(geometry.buildings.map((building) => [building.sourceKey, building]));
const stableSurfaceIds = new Set();
for (const surface of geometry.floorSurfaces) {
  const expectedId = `customs.surface.${createHash('sha256').update(stableStringify([
    'customs', surface.scope, surface.classification, String(surface.floorIndex),
  ])).digest('hex').slice(0, 24)}`;
  assert.equal(surface.stableId, expectedId, `non-deterministic floor surface ID for ${surface.scope}`);
  assert(!stableSurfaceIds.has(surface.stableId), `duplicate floor surface ID ${surface.stableId}`);
  stableSurfaceIds.add(surface.stableId);
  if (!surface.scope.startsWith('building:')) continue;
  assert.equal(surface.scope, `building:${surface.buildingSourceKey}`, `${surface.stableId} has no explicit building source binding`);
  const building = buildingsBySource.get(surface.buildingSourceKey);
  assert(building, `${surface.stableId} binds missing building ${surface.buildingSourceKey}`);
  if (surface.buildingId != null) {
    assert.equal(surface.buildingId, building.featureId, `${surface.stableId} buildingId drifted`);
    assert.equal(surface.featureId, surface.buildingId, `${surface.stableId} featureId alias drifted`);
  }
}
for (const [stableId, featureId] of [
  ['customs.surface.3f03ef2c6b3b917900b5f2fe', 'customs.dorms.two_story.main'],
  ['customs.surface.23e45b4ca4c30541d58d5cd6', 'customs.dorms.three_story.main'],
]) {
  const surface = geometry.floorSurfaces.find((candidate) => candidate.stableId === stableId);
  assert(surface && surface.classification === 'floor' && surface.floorIndex === 0
    && surface.buildingId === featureId && Number.isFinite(surface.surfaceY),
  `${featureId} floor-0 selector is not resolvable`);
}

console.log(`Customs geometry accuracy checks passed: ${markers.locks.length} exact locks, ${quarantinedLocks.length} quarantined locks, ${geometry.boundary.outsideCount} outside-marker diagnostics, ${stableSurfaceIds.size} stable floor surfaces, buckets ${JSON.stringify(evidence.bucketCounts)}`);
