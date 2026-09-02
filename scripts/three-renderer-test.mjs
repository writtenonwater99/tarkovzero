import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import {
  RAILWAY_TRACK_PROFILE, THREE_POC_SCOPE, UNDERSTORY_TUFT_BUDGET, buildUnderstoryTuftPlan, cameraPose, centroid,
  createAsyncAttachGuard, disposeMaterialResources, drapedLinearSegmentMeshData, gameToWorld, grassTuftMeshData, inRing,
  makeTerrainSampler, markerOverlaySpec, parseThreeFx, pointPropPose, questZoneSpec, reconcileOrbitView,
  railwayTrackMeshData, seatOverlayAnchor, terrainMeshData, terrainRelativeDisplayY, updateThreeFx, viewStateFromPose, visibleForFloor,
  visibleInteractionData, withinScope, worldToGame,
} from '../src/three-world.js';
import { buildOpenFrameBuildingAsset, buildPropAsset, propAssetKind, propDimensions } from '../src/three-prop-assets.js';
import {
  assertLocalThree, canUseLocalThree, isLoopbackHostname, localRendererMode, normalizeHostname,
} from '../src/local-renderer-gate.js';
import { createFloorSurfaceResolver, measuredSurfaceY, visibleBuildingHeight } from '../src/surfaces.js';
import { emptyCustomsAssetManifest, normalizeCustomsAssetManifest } from '../src/customs-asset-manifest.js';
import {
  authoredCameraFromWorldTarget,
  createAuthoredAssetStreamer,
  customsExactTerrainSurfaceStatus,
  customsTruthStripCopy,
  seatAuthoredInstance,
} from '../src/map3d-three.js';
import { describeVegetationObservability } from '../src/customs-vegetation-observability.js';

const customs3d = JSON.parse(await readFile(new URL('../public/data/customs-3d.json', import.meta.url), 'utf8'));
const close = (actual, expected, epsilon = 1e-9, message = '') => {
  assert.ok(Math.abs(actual - expected) <= epsilon, message || `${actual} != ${expected}`);
};
const round = (values, digits = 9) => Array.from(
  values,
  (value) => Number(Number(value).toFixed(digits)) + 0,
);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2;
};

const AUTHORED_SOURCE = Object.freeze({
  id: 'tarkovzero-original',
  kind: 'authored',
  title: 'TarkovZero original test asset',
  holder: 'TarkovZero',
  license: 'CC0-1.0',
  licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
  retrievedAt: '2026-08-31',
});

function oneCellAuthoredManifest() {
  const base = emptyCustomsAssetManifest({
    scope: { id: 'stream-test', center: { x: 0, z: 0 }, widthM: 1000, depthM: 1000 },
    budgets: {
      totalBytes: 10_000,
      totalTriangles: 10_000,
      perCellBytes: 10_000,
      perCellTriangles: 10_000,
      maxConcurrentLoads: 1,
      drawDistanceM: 50,
    },
  });
  return {
    ...base,
    evidence: { sources: [AUTHORED_SOURCE], observations: [] },
    delivery: {
      baseUrl: 'assets/3d/customs/authored/',
      materials: [],
      assets: [{
        id: 'stream-shed',
        kind: 'unique',
        name: 'Streaming shed',
        sourceId: AUTHORED_SOURCE.id,
        gltf: { unit: 'metre', upAxis: '+y', forwardAxis: '+z', pivot: 'base-center' },
        bounds: { min: { x: -2, y: 0, z: -2 }, max: { x: 2, y: 4, z: 2 } },
        materialIds: [],
        masks: { floors: ['ground'], interior: false },
        proxies: {
          picking: { shape: 'box' },
          shadow: { mode: 'both' },
          collision: { shape: 'box' },
        },
        lods: [{
          level: 0,
          url: 'stream-shed/lod0.glb',
          sha256: `sha256:${'ab'.repeat(32)}`,
          bytes: 1000,
          triangles: 500,
          maxDistanceM: 500,
        }],
      }],
      instances: [{
        id: 'stream-shed-a',
        assetId: 'stream-shed',
        cellId: 'stream-cell',
        stableId: 'customs.authored.stream.shed.a',
        featureId: 'customs.building.stream-shed',
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { yawDeg: 0 } },
        floor: 'ground',
      }],
      cells: [{
        id: 'stream-cell',
        center: { x: 0, z: 0 },
        widthM: 40,
        depthM: 40,
        minY: -10,
        maxY: 20,
        instanceIds: ['stream-shed-a'],
      }],
      replacements: [{
        id: 'retire-stream-shed',
        target: { kind: 'building', featureId: 'customs.building.stream-shed' },
        instanceIds: ['stream-shed-a'],
        policy: 'hide-mesh',
      }],
    },
  };
}

test('exact terrain status separates the best available surface from the active look', () => {
  assert.deepEqual(customsExactTerrainSurfaceStatus(), {
    available: 'legacy-fallback',
    active: 'legacy-fallback',
  });
  assert.deepEqual(customsExactTerrainSurfaceStatus({
    hasExactTerrain: true,
    pbrAvailable: true,
    paletteAvailable: true,
  }), {
    available: 'exact-control-mask-12-layer-original-pbr',
    active: 'exact-control-mask-12-layer-original-pbr',
  });
  assert.deepEqual(customsExactTerrainSurfaceStatus({
    hasExactTerrain: true,
    pbrAvailable: false,
    paletteAvailable: true,
  }), {
    available: 'exact-control-mask-original-palette',
    active: 'exact-control-mask-original-palette',
  });
  assert.deepEqual(customsExactTerrainSurfaceStatus({
    hasExactTerrain: true,
    pbrAvailable: false,
    paletteAvailable: false,
  }), {
    available: 'neutral-fallback',
    active: 'neutral-fallback',
  });
  assert.deepEqual(customsExactTerrainSurfaceStatus({
    hasExactTerrain: true,
    pbrAvailable: true,
    paletteAvailable: true,
    look: 'vector',
  }), {
    available: 'exact-control-mask-12-layer-original-pbr',
    active: 'vector-flat',
  });
  assert.deepEqual(customsExactTerrainSurfaceStatus({
    hasExactTerrain: true,
    pbrAvailable: true,
    paletteAvailable: true,
    detail: false,
  }), {
    available: 'exact-control-mask-12-layer-original-pbr',
    active: 'detail-off-flat',
  });
});

// ── The CUSTOMS TRUTH strip ────────────────────────────────────────────────────────────────────
// Every segment of that strip was a claim about what was PLANNED, written once. The one the
// reviewer measured said "7,108 AUTHORED VEGETATION" on a run where the pack failed to mount and 0
// of 8,805 placements were authored; the terrain segment had the same disease twice over (masks
// claimed before the atlases were fetched, PBR claimed forever after one flip to vector). The tests
// below pin the whole strip to measured state.

/** The vegetation segment as `describeVegetationObservability()` publishes it, in each state. */
const stripVegetation = (snapshot) => describeVegetationObservability(snapshot).strip;
const PLAN_ONLY_SNAPSHOT = Object.freeze({
  mode: 'authored',
  hasAuthoredPlan: true,
  mount: { phase: 'mounted', loaded: 93, expected: 93, elapsedMs: 71_400, sinceProgressMs: 120 },
  routing: { authored: 7108, procedural: 0, rendered: 7108, culled: 1697, source: 8805 },
  runtime: {
    materialMode: 'shared-array-texture',
    drawCalls: 31,
    liveBuckets: 31,
    visibleInstances: 4586,
    frustumCulledInstances: 2522,
  },
  arrayTextures: { layers: 199, materials: 3, textures: 9 },
  proceduralPlacements: 0,
  declaredInstances: 8805,
  culledOutsideScope: 1697,
});
/** The reviewer's GLB-404 run: the whole pack absent, every placement drawn as a procedural proxy. */
const MOUNT_FAILED_SNAPSHOT = Object.freeze({
  ...PLAN_ONLY_SNAPSHOT,
  mode: 'procedural',
  reason: 'ERR_CUSTOMS_GLB_HTTP',
  error: 'authored vegetation GLB HTTP 404 from /@vegetation-authored/pine01/lod0.glb',
  mount: { phase: 'failed', loaded: 0, expected: 93, elapsedMs: 2_140, sinceProgressMs: 2_140 },
  routing: null,
  runtime: null,
  arrayTextures: null,
  proceduralPlacements: 7108,
});

test('the truth strip names the surface that is DRAWING, not the best one that ever loaded', () => {
  // `available` is what was built; `active` is what the tiles carry right now. The strip must read
  // the second: a flip to vector or `?fx=none` swaps every tile to a flat material while the PBR
  // runtime stays alive, and the old strip kept its "12-LAYER AUTHORED PBR" claim across both.
  const vegetation = stripVegetation(PLAN_ONLY_SNAPSHOT);
  const pbr = { hasExactTerrain: true, pbrAvailable: true, paletteAvailable: true };
  const live = customsTruthStripCopy({
    hasExactTerrain: true, surface: customsExactTerrainSurfaceStatus(pbr), vegetation,
  });
  assert.equal(live.title, 'CUSTOMS TRUTH');
  assert.equal(live.detail, 'EXACT LOCAL TERRAIN · 12-LAYER AUTHORED PBR · 7,108 AUTHORED VEGETATION · FIXED RELIEF 2×');
  assert.equal(live.state, 'exact');

  const vector = customsTruthStripCopy({
    hasExactTerrain: true, surface: customsExactTerrainSurfaceStatus({ ...pbr, look: 'vector' }), vegetation,
  });
  assert.match(vector.detail, /VECTOR FLAT SURFACE/);
  assert.doesNotMatch(vector.detail, /PBR/, 'a vector frame draws no authored PBR');
  assert.equal(vector.state, 'requested', 'a look the user asked for is not a degradation');

  const detailOff = customsTruthStripCopy({
    hasExactTerrain: true, surface: customsExactTerrainSurfaceStatus({ ...pbr, detail: false }), vegetation,
  });
  assert.match(detailOff.detail, /FLAT SURFACE — DETAIL OFF/);
  assert.doesNotMatch(detailOff.detail, /PBR/);
});

test('a surface that fell back on its own says which fallback it is, and reads as degraded', () => {
  const vegetation = stripVegetation(PLAN_ONLY_SNAPSHOT);
  const palette = customsTruthStripCopy({
    hasExactTerrain: true,
    surface: customsExactTerrainSurfaceStatus({ hasExactTerrain: true, pbrAvailable: false, paletteAvailable: true }),
    vegetation,
  });
  assert.match(palette.detail, /12-LAYER SURFACE MASKS — NO PBR/);
  assert.equal(palette.state, 'degraded');

  // The control atlases failed: every tile draws the neutral material. The old strip claimed
  // "12-LAYER SURFACE MASKS" here, because it was written before those atlases were even fetched.
  const neutral = customsTruthStripCopy({
    hasExactTerrain: true,
    surface: customsExactTerrainSurfaceStatus({ hasExactTerrain: true, pbrAvailable: false, paletteAvailable: false }),
    vegetation,
  });
  assert.match(neutral.detail, /NEUTRAL SURFACE FALLBACK/);
  assert.doesNotMatch(neutral.detail, /12-LAYER/, 'nothing 12-layer is on screen');
  assert.equal(neutral.state, 'degraded');
});

test('THE MEASURED DEFECT: the strip cannot claim authored vegetation while the pack is absent', () => {
  const copy = customsTruthStripCopy({
    hasExactTerrain: true,
    surface: customsExactTerrainSurfaceStatus({ hasExactTerrain: true, pbrAvailable: true, paletteAvailable: true }),
    vegetation: stripVegetation(MOUNT_FAILED_SNAPSHOT),
  });
  assert.doesNotMatch(copy.detail, /7,108|7108/, 'the plan count must not appear on a failed mount');
  assert.match(copy.detail, /0 AUTHORED VEGETATION — PACK FAILED TO MOUNT/);
  assert.equal(copy.state, 'degraded', 'a green header over an amber chip is the contradiction being deleted');
});

test('a strip with nothing resolved yet says so, instead of borrowing the healthy wording', () => {
  const booting = customsTruthStripCopy({ hasExactTerrain: true });
  assert.equal(booting.detail, 'EXACT LOCAL TERRAIN · RESOLVING SURFACE · RESOLVING VEGETATION · FIXED RELIEF 2×');
  assert.equal(booting.state, 'pending');
  assert.doesNotMatch(booting.detail, /12-LAYER|AUTHORED VEGETATION/);
});

test('the legacy-terrain strip keeps its own title and still reports vegetation', () => {
  const copy = customsTruthStripCopy({
    hasExactTerrain: false,
    surface: customsExactTerrainSurfaceStatus(),
    vegetation: stripVegetation({ ...MOUNT_FAILED_SNAPSHOT, hasAuthoredPlan: false, reason: 'no-exact-vegetation-plan', mount: null }),
  });
  assert.equal(copy.title, 'THREE POC');
  assert.equal(copy.detail, 'LEGACY TERRAIN FALLBACK · LOCALHOST · 0 AUTHORED VEGETATION — NO AUTHORED PLAN · FIXED RELIEF 2×');
  assert.equal(copy.state, 'degraded');
});

test('the relief the strip prints is the relief the renderer uses, not a hand-typed 2', () => {
  const vegetation = stripVegetation(PLAN_ONLY_SNAPSHOT);
  const copy = customsTruthStripCopy({ hasExactTerrain: true, vegetation, relief: 3 });
  assert.match(copy.detail, /FIXED RELIEF 3×/);
  assert.doesNotMatch(copy.detail, /RELIEF 2×/);
});

test('THE CONTRACT: the strip wears the WORST of everything it reports', () => {
  // The failure mode this whole pass exists to delete is a green reassurance painted directly above
  // an amber contradiction. Green is reachable only when the terrain, the surface AND the
  // vegetation are all what the strip claims.
  const exact = customsExactTerrainSurfaceStatus({ hasExactTerrain: true, pbrAvailable: true, paletteAvailable: true });
  const healthyVeg = stripVegetation(PLAN_ONLY_SNAPSHOT);
  assert.equal(customsTruthStripCopy({ hasExactTerrain: true, surface: exact, vegetation: healthyVeg }).state, 'exact');

  for (const [label, copy] of [
    ['no exact terrain', customsTruthStripCopy({ hasExactTerrain: false, surface: exact, vegetation: healthyVeg })],
    ['degraded surface', customsTruthStripCopy({
      hasExactTerrain: true,
      surface: customsExactTerrainSurfaceStatus({ hasExactTerrain: true, pbrAvailable: false, paletteAvailable: false }),
      vegetation: healthyVeg,
    })],
    ['failed vegetation', customsTruthStripCopy({
      hasExactTerrain: true, surface: exact, vegetation: stripVegetation(MOUNT_FAILED_SNAPSHOT),
    })],
    ['unresolved vegetation', customsTruthStripCopy({ hasExactTerrain: true, surface: exact })],
  ]) {
    assert.notEqual(copy.state, 'exact', `${label}: the strip must not read as fully live`);
  }
});

test('EFT coordinates round-trip through the shared [-x,-z,y] world', () => {
  const world = gameToWorld(210.5, 146.25, 7.75);
  assert.deepEqual(world, [-210.5, -146.25, 7.75]);
  assert.deepEqual(worldToGame(...world), { x: 210.5, z: 146.25, y: 7.75 });
});

test('terrain sampler is bilinear and applies relief once', () => {
  const terrain = { x0: 0, z0: 0, step: 10, cols: 2, rows: 2, heights: [0, 10, 20, 30] };
  assert.equal(makeTerrainSampler(terrain, 1)(5, 5), 15);
  assert.equal(makeTerrainSampler(terrain, 3)(5, 5), 45);
});

test('terrain-relative vertical mapping exaggerates ground without stretching object height', () => {
  assert.equal(terrainRelativeDisplayY({ canonicalY: 8, canonicalGroundY: 5, displayGroundY: 10 }), 13);
  assert.equal(terrainRelativeDisplayY({ canonicalY: -1, canonicalGroundY: -3, displayGroundY: -6 }), -4);
  assert.equal(terrainRelativeDisplayY({ canonicalY: -5, canonicalGroundY: -3, displayGroundY: -6 }), -8);
  assert.equal(terrainRelativeDisplayY({ canonicalY: null, canonicalGroundY: 5, displayGroundY: 10 }), 10);
  assert.throws(() => terrainRelativeDisplayY({ canonicalY: 2, canonicalGroundY: 1, displayGroundY: NaN }), /displayGroundY/);
});

test('Main Bridge uses the measured Customs bridge-deck evidence, independently of ground', () => {
  const bridge = customs3d.bridges.find((item) => item.name === 'Main Bridge');
  const deckSamples = customs3d.terrain.evidence.buckets['bridge-deck'];
  assert.ok(bridge, 'Main Bridge must exist in the generated Customs artifact');
  assert.equal(bridge.evidence.classification, 'bridge-deck');
  assert.equal(bridge.evidence.sampleCount, deckSamples.length);
  assert.equal(bridge.evidence.sourceIds.length, deckSamples.length);
  assert.ok(deckSamples.every((sample) => sample.reasonCodes.includes('mapped-bridge-deck:Main Bridge')));

  const sampleYs = deckSamples.map((sample) => sample.y);
  assert.equal(Math.round(median(sampleYs) * 1e4) / 1e4, bridge.surfaceY);
  assert.equal(Math.round(Math.min(...sampleYs) * 1e3) / 1e3, bridge.evidence.minY);
  assert.equal(Math.round(Math.max(...sampleYs) * 1e3) / 1e3, bridge.evidence.maxY);
  assert.equal(measuredSurfaceY(bridge, 1), bridge.surfaceY);
  close(measuredSurfaceY(bridge, 3), bridge.surfaceY * 3);
  assert.equal(measuredSurfaceY({ height: 6.5 }, 1), null, 'legacy local height is not absolute evidence');

  const midpoint = bridge.path[Math.floor(bridge.path.length / 2)];
  const fittedGround = makeTerrainSampler(customs3d.terrain, 1)(midpoint[0], midpoint[1]);
  assert.ok(fittedGround < bridge.surfaceY - 5, 'the riverbed must not pull the measured deck down');
});

test('Customs floor, roof, and underground evidence resolves to render-ready absolute surfaces', () => {
  const resolver = createFloorSurfaceResolver(customs3d.floorSurfaces, 1);
  const stableIds = customs3d.floorSurfaces.map((row) => row.stableId);
  assert.equal(customs3d.floorSurfaces.length, 120);
  assert.equal(new Set(stableIds).size, stableIds.length);

  const dorms = customs3d.buildings.find((building) => building.featureId === 'customs.dorms.three_story.main');
  assert.ok(dorms, 'the reviewed Dorms 3-Story shell must be emitted');
  const dormsProfile = resolver.buildingProfile(dorms, { fallbackBase: 99, fallbackHeight: dorms.height });
  assert.deepEqual(dormsProfile.floorYs, [0.9, 3.886, 6.881]);
  assert.equal(dormsProfile.baseY, 0.9, 'floor zero must override terrain seating');
  close(visibleBuildingHeight(dormsProfile, '0'), 2.586);
  close(visibleBuildingHeight(dormsProfile, '1'), 5.581);
  close(visibleBuildingHeight(dormsProfile, '2'), 9.5);
  assert.deepEqual(dormsProfile.floorRows.map((row) => row.stableId), [
    'customs.surface.23e45b4ca4c30541d58d5cd6',
    'customs.surface.1cf6e4469d2d21c3f73b3b7c',
    'customs.surface.f809ce2ee9d8730d685d7d26',
  ]);

  const dormsCenter = centroid(dorms.poly);
  const ground1 = makeTerrainSampler(customs3d.terrain, 1)(...dormsCenter);
  const ground3 = makeTerrainSampler(customs3d.terrain, 3)(...dormsCenter);
  const dormsAt3 = createFloorSurfaceResolver(customs3d.floorSurfaces, 3)
    .buildingProfile(dorms, { fallbackBase: ground3, fallbackHeight: dorms.height });
  close(dormsAt3.floorYs[1] - dormsAt3.floorYs[0], 3.886 - 0.9);
  close(dormsAt3.floorYs[2] - dormsAt3.floorYs[0], 6.881 - 0.9);
  close(dormsAt3.baseY - ground3, 0.9 - ground1,
    1e-9, 'relief should translate the building with terrain without stretching its rooms');
  close(visibleBuildingHeight(dormsAt3, '0'), visibleBuildingHeight(dormsProfile, '0'));

  const warehouse = customs3d.buildings.find((building) => building.sourceKey?.endsWith('element-188:subpath-0'));
  const roofProfile = resolver.buildingProfile(warehouse, { fallbackBase: -50, fallbackHeight: warehouse.height });
  assert.equal(roofProfile.measuredRoof, true);
  assert.equal(roofProfile.baseY, 1.534);
  assert.equal(roofProfile.roofY, 9.8484);
  close(roofProfile.height, 8.3144);
  assert.equal(roofProfile.roofRow.stableId, 'customs.surface.52bc8fc15e7b5f4eaebf92b7');
  const warehouseCenter = centroid(warehouse.poly);
  const warehouseAt3 = createFloorSurfaceResolver(customs3d.floorSurfaces, 3).buildingProfile(warehouse, {
    fallbackBase: makeTerrainSampler(customs3d.terrain, 3)(...warehouseCenter),
    fallbackHeight: warehouse.height,
  });
  close(warehouseAt3.height, roofProfile.height, 1e-9, 'a measured roof must not become three times taller');

  const underground = new Map(customs3d.underground.map((item) => {
    const profile = resolver.undergroundProfile(item, { fallbackY: 999 });
    return [item.name, profile];
  }));
  assert.equal(underground.get('switch basement').surfaceY, -2.547);
  assert.equal(underground.get('switch basement').stableId, 'customs.surface.93c7975dbb9c918ee0aa8623');
  assert.equal(underground.get('zb-013').surfaceY, -1.7874);
  assert.ok([...underground.values()].every((profile) => profile.measured && profile.surfaceY !== 999));
  assert.equal(resolver.measuredFloorSlabs(customs3d.buildings).length, 62);
  assert.equal(resolver.measuredBuildingUndergroundSlabs(customs3d.buildings).length, 8);
});

test('late authored resources are rejected and every material texture map is disposed once', async () => {
  let attached = 0, materialDisposals = 0, textureDisposals = 0;
  const sharedTexture = { isTexture: true, dispose: () => { textureDisposals++; } };
  const material = {
    map: sharedTexture,
    normalMap: sharedTexture,
    uniforms: { detail: { value: sharedTexture } },
    dispose: () => { materialDisposals++; },
  };
  const guard = createAsyncAttachGuard((resource) => disposeMaterialResources(resource.material));
  const loading = Promise.resolve({ material });
  guard.dispose();
  const resource = await loading;
  assert.equal(guard.attach(resource, () => { attached++; }), false);
  assert.equal(attached, 0, 'a decoded GLTF must not attach after renderer disposal');
  assert.equal(textureDisposals, 1, 'shared texture maps must be deduplicated during disposal');
  assert.equal(materialDisposals, 1);
});

test('an authored GLB seats with the exact reflected EFT matrix and a real invisible picking proxy', () => {
  const authored = new THREE.Group();
  const visibleMesh = new THREE.Mesh(
    new THREE.BoxGeometry(4, 4, 4),
    new THREE.MeshBasicMaterial(),
  );
  authored.add(visibleMesh);
  const instance = {
    stableId: 'customs.authored.test-building',
    featureId: 'customs.building.test',
    label: 'Test building',
    assetId: 'test-building',
    floor: 'ground',
    interior: false,
    lodLevel: 0,
    gltf: { unit: 'metre', upAxis: '+y', forwardAxis: '+z', pivot: 'base-center' },
    bounds: {
      min: { x: -2, y: 0, z: -2 },
      max: { x: 2, y: 4, z: 2 },
      sizeM: { x: 4, y: 4, z: 4 },
      centerM: { x: 0, y: 2, z: 0 },
    },
    transform: {
      position: { x: 10, y: 6, z: 20 },
      rotation: { yawDeg: 0, pitchDeg: 0, rollDeg: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    pickable: true,
    picking: { shape: 'box', lodLevel: null, inflateM: 0 },
    shadow: { mode: 'both', lodLevel: null },
    collision: { shape: 'box' },
  };
  seatAuthoredInstance(authored, instance, { displayYFor: () => 6 });
  assert.equal(authored.matrixAutoUpdate, false);
  assert.deepEqual(round(authored.matrix.elements), [
    -1, 0, 0, 0,
    0, 0, 1, 0,
    0, -1, 0, 0,
    -10, -20, 6, 1,
  ]);
  assert.equal(visibleMesh.userData.pickable, false);
  assert.equal(visibleMesh.raycast(), undefined, 'the render mesh is not the declared pick target');

  const proxy = authored.children.find((node) => node.userData?.kind === 'authored-picking-proxy');
  assert.ok(proxy);
  assert.equal(proxy.visible, true);
  assert.equal(proxy.material.visible, false);
  authored.updateMatrixWorld(true);
  const hits = new THREE.Raycaster(
    new THREE.Vector3(-10, -20, 20),
    new THREE.Vector3(0, 0, -1),
  ).intersectObject(authored, true);
  assert.ok(hits.some((hit) => hit.object === proxy), 'the invisible coarse proxy must be raycastable');
  assert.equal(visibleInteractionData(hits.find((hit) => hit.object === proxy).object).label, 'Test building');
});

test('authored streaming plans from the real runtime focus in canonical EFT x/z', () => {
  assert.deepEqual(authoredCameraFromWorldTarget(new THREE.Vector3(-203, 128, 14)), {
    x: 203,
    z: -128,
  });
  assert.deepEqual(authoredCameraFromWorldTarget([-42.5, -17.25, 3]), { x: 42.5, z: 17.25 });
  assert.throws(() => authoredCameraFromWorldTarget({ x: NaN, y: 0 }), /finite runtime camera target/);
});

test('the authored streamer preserves hysteresis, detaches leaves, and restores suppression', async () => {
  const root = new THREE.Group();
  const status = {};
  const synchronized = [];
  let loads = 0;
  const streamer = createAuthoredAssetStreamer({
    root,
    status,
    guard: createAsyncAttachGuard(),
    manifestInput: oneCellAuthoredManifest(),
    baseHref: 'http://localhost/',
    displayYFor: (_x, _z, y) => y,
    loadAsset: async () => { loads++; return { scene: new THREE.Group() }; },
    syncSuppression(entries) {
      const featureIds = entries.map((entry) => entry.featureId);
      synchronized.push(featureIds);
      return { applied: featureIds, retained: [] };
    },
  });

  await streamer.update({ x: 0, z: 0 });
  assert.equal(loads, 1);
  assert.equal(root.children.length, 1);
  assert.equal(status.manifest.loaded, 1);
  assert.deepEqual(status.manifest.suppressed, ['customs.building.stream-shed']);

  // Cell edge is x=20 and draw distance is 50. Distance 52 is inside the 8% hold band,
  // so a previously visible cell stays attached; distance 55 crosses the 54 m leave edge.
  await streamer.update({ x: 72, z: 0 });
  assert.equal(root.children.length, 1, 'camera jitter inside hysteresis must not detach');
  assert.equal(loads, 1, 'a hysteresis hold must not reload the same LOD');
  await streamer.update({ x: 75, z: 0 });
  assert.equal(root.children.length, 0);
  assert.equal(status.manifest.loaded, 0);
  assert.deepEqual(status.manifest.suppressed, []);
  assert.ok(status.manifest.retained.some((entry) => entry.featureId === 'customs.building.stream-shed'));
  assert.deepEqual(synchronized.at(-1), [], 'leaving the plan must actively restore the fallback');
  streamer.dispose();
});

test('camera updates coalesce behind one non-reentrant authored load pass', async () => {
  const root = new THREE.Group();
  const status = {};
  let releaseLoad;
  const loadGate = new Promise((resolve) => { releaseLoad = resolve; });
  let loads = 0;
  const streamer = createAuthoredAssetStreamer({
    root,
    status,
    guard: createAsyncAttachGuard(),
    manifestInput: oneCellAuthoredManifest(),
    baseHref: 'http://localhost/',
    displayYFor: (_x, _z, y) => y,
    async loadAsset() {
      loads++;
      await loadGate;
      return { scene: new THREE.Group() };
    },
    syncSuppression: (entries) => ({
      applied: entries.map((entry) => entry.featureId),
      retained: [],
    }),
  });

  const first = streamer.update({ x: 0, z: 0 });
  while (loads === 0) await new Promise((resolve) => setImmediate(resolve));
  const transientFar = streamer.update({ x: 500, z: 0 });
  const latestNear = streamer.update({ x: 0, z: 0 });
  releaseLoad();
  await Promise.all([first, transientFar, latestNear]);
  assert.equal(loads, 1, 'the overwritten far target must not create a leave/re-enter reload');
  assert.equal(root.children.length, 1);
  assert.deepEqual(streamer.currentPlan.camera, { x: 0, z: 0 });
  streamer.dispose();
});

test('loader-host and attach failures are both surfaced from the ledger without duplicates', async () => {
  const runFailure = async ({ loaderHost = null, guard, loadAsset = null }) => {
    const root = new THREE.Group();
    const status = {};
    const streamer = createAuthoredAssetStreamer({
      root,
      status,
      guard,
      loaderHost,
      manifestInput: oneCellAuthoredManifest(),
      baseHref: 'http://localhost/',
      displayYFor: (_x, _z, y) => y,
      loadAsset,
      syncSuppression: (entries) => ({
        applied: entries.map((entry) => entry.featureId),
        retained: [],
      }),
    });
    await streamer.update({ x: 0, z: 0 });
    await streamer.update({ x: 0, z: 0 });
    const result = { root, status, streamer };
    return result;
  };

  const hostFailure = await runFailure({
    loaderHost: { acquire: async () => { throw new Error('loader host exploded'); } },
    guard: createAsyncAttachGuard(),
  });
  assert.deepEqual(hostFailure.status.manifest.errors, [
    'stream-shed-a: loader host exploded',
  ]);
  assert.equal(hostFailure.root.children.length, 0);
  hostFailure.streamer.dispose();

  const attachFailure = await runFailure({
    guard: {
      active: true,
      attach(resource, attachResource) {
        attachResource(resource);
        throw new Error('attach exploded');
      },
    },
    loadAsset: async () => ({ scene: new THREE.Group() }),
  });
  assert.deepEqual(attachFailure.status.manifest.errors, [
    'stream-shed-a: attach exploded',
  ]);
  assert.equal(attachFailure.root.children.length, 0);
  attachFailure.streamer.dispose();
});

test('disposing the authored streamer aborts an in-flight pass before attachment', async () => {
  const root = new THREE.Group();
  const status = {};
  let releaseLoad;
  const loadGate = new Promise((resolve) => { releaseLoad = resolve; });
  let started = false;
  const streamer = createAuthoredAssetStreamer({
    root,
    status,
    guard: createAsyncAttachGuard(),
    manifestInput: oneCellAuthoredManifest(),
    baseHref: 'http://localhost/',
    displayYFor: (_x, _z, y) => y,
    async loadAsset() {
      started = true;
      await loadGate;
      return { scene: new THREE.Group() };
    },
    syncSuppression: (entries) => ({
      applied: entries.map((entry) => entry.featureId),
      retained: [],
    }),
  });
  const pending = streamer.update({ x: 0, z: 0 });
  while (!started) await new Promise((resolve) => setImmediate(resolve));
  streamer.dispose();
  releaseLoad();
  await pending;
  assert.equal(root.children.length, 0);
  assert.equal(streamer.active, false);
});

test('camera view state survives a pose round-trip', () => {
  const view = { target: [-210, -146, 3], zoom: 2.4, rotationX: 32, rotationOrbit: -20, minZoom: -2, maxZoom: 5 };
  const pose = cameraPose(view, 900, 22);
  const result = viewStateFromPose(pose.position, pose.target, 900, 22, view);
  for (const key of ['zoom', 'rotationX', 'rotationOrbit']) close(result[key], view[key], 1e-9, `${key} drifted`);
  assert.deepEqual(result.target, view.target);
});

test('OrbitControls reconciliation reapplies one clamped pose and then becomes quiescent', () => {
  const viewportHeight = 900;
  const unsafe = {
    target: [-210, -146, 3], zoom: -4, rotationX: 2, rotationOrbit: -20,
    minZoom: -1, maxZoom: 5,
  };
  const clamp = (view) => ({
    ...view,
    zoom: Math.max(view.minZoom, Math.min(view.maxZoom, view.zoom)),
    rotationX: Math.max(9, Math.min(89, view.rotationX)),
  });
  let physical = cameraPose(unsafe, viewportHeight, 22);
  let state = unsafe;
  let poseWrites = 0;
  let reconciliation;
  for (let pass = 0; pass < 3; pass++) {
    reconciliation = reconcileOrbitView({
      position: physical.position,
      target: physical.target,
      previous: state,
      viewportHeight,
      fovy: 22,
      clamp,
    });
    state = reconciliation.view;
    if (!reconciliation.corrected) break;
    physical = reconciliation.pose;
    poseWrites++;
  }
  assert.equal(poseWrites, 1, 'the controller should write one correction, not feedback-loop');
  assert.equal(reconciliation.corrected, false);
  assert.equal(state.zoom, -1);
  assert.equal(state.rotationX, 9);

  const actual = viewStateFromPose(physical.position, physical.target, viewportHeight, 22, state);
  for (const key of ['zoom', 'rotationX', 'rotationOrbit']) close(actual[key], state[key], 1e-8, `${key} canvas/state divergence`);
  assert.deepEqual(actual.target, state.target);
});

test('terrain mesh omits cells outside the reviewed playable ring', () => {
  const terrain = { x0: 0, z0: 0, step: 1, cols: 3, rows: 3, heights: Array(9).fill(2) };
  const limit = [[0, 0], [1.1, 0], [1.1, 2], [0, 2]];
  const mesh = terrainMeshData(terrain, limit, 1);
  assert.equal(mesh.positions.length, 27);
  assert.equal(mesh.indices.length, 12, 'only two left-column cells should survive');
  const [a, b, c] = mesh.indices;
  const ax = mesh.positions[a * 3], ay = mesh.positions[a * 3 + 1];
  const bx = mesh.positions[b * 3], by = mesh.positions[b * 3 + 1];
  const cx = mesh.positions[c * 3], cy = mesh.positions[c * 3 + 1];
  const normalZ = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  assert.ok(normalZ > 0, 'the first flat terrain triangle must face upward in Three world space');
  const atlased = terrainMeshData(terrain, limit, 1, (x, z) => [x / 2, z / 2]);
  assert.deepEqual([...atlased.uvs.slice(0, 6)], [0, 0, 0.5, 0, 1, 0]);
  assert.deepEqual([...atlased.detailUvs.slice(0, 6)], [0, 0, 1 / 32, 0, 2 / 32, 0]);
});

test('the Three proof consumes every reviewed Customs understory polygon', () => {
  assert.equal(customs3d.understory.length, 37);
  assert.equal(customs3d.understory.reduce((total, ring) => total + ring.length, 0), 6346);
  assert.ok(customs3d.understory.every((ring) => ring.length >= 3));
});

test('reviewed understory deterministically yields a capped, boundary-inset tuft plan', () => {
  const first = buildUnderstoryTuftPlan(customs3d.understory);
  const second = buildUnderstoryTuftPlan(customs3d.understory);
  assert.equal(first.candidateCount, 12_164);
  assert.equal(first.placements.length, UNDERSTORY_TUFT_BUDGET.maxInstances);
  assert.equal(first.coveredRings, customs3d.understory.length);
  assert.deepEqual(second, first, 'tuft placement must be stable across rebuilds and machines');

  const boundaryDistanceSq = ({ x, z, ringIndex }) => {
    const ring = customs3d.understory[ringIndex];
    let best = Infinity;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, az] = ring[j], [bx, bz] = ring[i], dx = bx - ax, dz = bz - az;
      const denominator = dx * dx + dz * dz;
      const t = denominator ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / denominator)) : 0;
      const edgeX = ax + t * dx, edgeZ = az + t * dz;
      best = Math.min(best, (x - edgeX) ** 2 + (z - edgeZ) ** 2);
    }
    return best;
  };
  for (const placement of first.placements) {
    assert.equal(inRing([placement.x, placement.z], customs3d.understory[placement.ringIndex]), true);
    assert.ok(boundaryDistanceSq(placement) + 1e-9 >= first.footprintRadiusM ** 2,
      `tuft ${placement.x},${placement.z} straddles reviewed ring ${placement.ringIndex}`);
    assert.ok(placement.widthM / 2 <= first.footprintRadiusM,
      'the inset must contain the widest instanced blade base');
    assert.ok(placement.widthM >= 0.16 && placement.widthM <= 0.3,
      `tuft width ${placement.widthM}m is outside the authored clump budget`);
    assert.ok(placement.heightM >= 0.28 && placement.heightM <= 0.55,
      `tuft height ${placement.heightM}m is outside the authored blade budget`);
  }
  assert.equal(buildUnderstoryTuftPlan(customs3d.understory, { maxInstances: 23 }).placements.length, 23,
    'the instance budget must be a hard cap');
});

test('grass tuft meshes stand along world Z and respect the near/medium triangle budgets', () => {
  const near = grassTuftMeshData(3, true);
  const medium = grassTuftMeshData(2, false);
  const zs = near.positions.filter((_, index) => index % 3 === 2);
  assert.equal(Math.min(...zs), 0);
  assert.equal(Math.max(...zs), 1, 'tufts must rise along world Z, not lie in the XY ground plane');
  assert.equal(near.indices.length / 3, 6);
  assert.equal(medium.indices.length / 3, 2);
  assert.equal(UNDERSTORY_TUFT_BUDGET.maxInstances * near.indices.length / 3, 72_000);
  assert.equal(UNDERSTORY_TUFT_BUDGET.maxInstances * medium.indices.length / 3, 24_000);
});

test('the proof scope and floor filter preserve Customs surface semantics', () => {
  assert.equal(THREE_POC_SCOPE.id, 'customs-industrial-rail-yard');
  assert.equal(withinScope({ x: 230, z: -110 }), true);
  assert.equal(withinScope({ x: 600, z: -110 }), false);
  assert.equal(visibleForFloor('surface', 'all'), true);
  assert.equal(visibleForFloor('underground', 'all'), false);
  assert.equal(visibleForFloor('U', 'U'), true);
  assert.equal(visibleForFloor('both', 'U'), true);
});

test('point props preserve the canonical length axis and positive authored yaw', () => {
  const pose = pointPropPose({ x: 251.6, z: -184, rot: 57, dz: 0.2 }, 3.4);
  assert.deepEqual(pose.position, [-251.6, 184, 3.6]);
  close(pose.rotationZ, 57 * Math.PI / 180);
  assert.equal(pointPropPose({ type: 'wall', path: [[0, 0], [1, 0]] }, 0), null,
    'linear props must take the path placement branch instead of producing NaNs');
});

test('linear prop segments drape every footprint corner without tilting vertical walls', () => {
  const surface = (x, z) => x * 0.5 + z * 0.25;
  const segment = drapedLinearSegmentMeshData([0, 0], [10, 0], 2, 3, 0.4, surface);
  assert.ok(segment);
  assert.equal(segment.length, 10);
  assert.deepEqual(segment.footprint, [[0, 1], [0, -1], [10, 1], [10, -1]]);
  [0.65, 0.15, 5.65, 5.15].forEach((expected, index) => close(segment.bases[index], expected));
  for (let corner = 0; corner < 4; corner++) {
    close(segment.positions[(corner + 4) * 3], segment.positions[corner * 3]);
    close(segment.positions[(corner + 4) * 3 + 1], segment.positions[corner * 3 + 1]);
    close(segment.positions[(corner + 4) * 3 + 2] - segment.positions[corner * 3 + 2], 3, 1e-6);
  }
  assert.equal(segment.indices.length, 36);
});

test('reviewed railway centre-lines produce two physical rails and metric sleepers inside scope', () => {
  const track = railwayTrackMeshData(
    [{ path: [[0, 0], [10, 0]] }],
    (x, z) => x * 0.1 + z * 0.05,
    { center: { x: 5, z: 0 }, widthM: 20, depthM: 20 },
  );
  assert.equal(track.railSegmentCount, 2);
  assert.equal(track.railPositions.length, 48);
  assert.equal(track.railIndices.length, 72);
  assert.equal(track.sleepers.length, 14);
  assert.deepEqual(track.sleeperSize, [0.22, 2.5, 0.1]);
  close(track.profile.railTopOffsetFromSurfaceM, 0.24);
  close(track.profile.sleeperTopOffsetFromSurfaceM, 0.125);
  close(
    RAILWAY_TRACK_PROFILE.vehicleWheelBottomLiftM,
    RAILWAY_TRACK_PROFILE.trackBedLiftM + track.profile.railTopOffsetFromSurfaceM,
  );
  assert.ok(track.sleepers.every((sleeper) => Math.abs(sleeper.yaw) < 1e-12));
});

test('the procedural landmark kit distinguishes containers, locomotives, and tanker wagons', () => {
  const cases = [
    [{ type: 'container', name: 'Container', w: 2.5, l: 8, h: 2.6 }, 'shipping-container', 2],
    [{ type: 'railcar', name: 'Locomotive', w: 3.4, l: 14, h: 4 }, 'locomotive', 8],
    [{ type: 'railcar', name: 'Rail tanker car', w: 3.2, l: 12, h: 3.6 }, 'tanker-wagon', 7],
    [{ type: 'vehicle', name: 'Trailer', w: 3, l: 12, h: 3.2 }, 'road-trailer', 5],
    [{ type: 'vehicle', name: 'Truck with crane', w: 3, l: 8, h: 3 }, 'crane-truck', 7],
    [{ type: 'crane', name: 'Crane', w: 2, l: 20, h: 6 }, 'yard-crane', 7],
  ];
  for (const [prop, kind, minimumMeshes] of cases) {
    assert.equal(propAssetKind(prop), kind);
    assert.deepEqual(propDimensions(prop), { width: prop.w, length: prop.l, height: prop.h });
    const asset = buildPropAsset(prop);
    assert.equal(asset.userData.assetKind, kind);
    assert.ok(asset.children.length >= minimumMeshes, `${kind} should have a readable multi-part silhouette`);
    assert.ok(asset.children.every((child) => child.isMesh && child.geometry.getAttribute('position')));
    asset.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(asset);
    const size = bounds.getSize(new THREE.Vector3());
    assert.ok(size.x <= prop.l + 1e-6, `${kind} exceeds declared length: ${size.x} > ${prop.l}`);
    assert.ok(size.y <= prop.w + 1e-6, `${kind} exceeds declared width: ${size.y} > ${prop.w}`);
    assert.ok(size.z <= prop.h + 1e-6, `${kind} exceeds declared height: ${size.z} > ${prop.h}`);
    asset.traverse((node) => { node.geometry?.dispose?.(); node.material?.dispose?.(); });
  }
});

test('the open-frame landmark kit stays inside its measured footprint and height', () => {
  const frame = buildOpenFrameBuildingAsset({ length: 60, width: 25, height: 9.5 });
  frame.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(frame).getSize(new THREE.Vector3());
  assert.ok(size.x <= 60 + 1e-6);
  assert.ok(size.y <= 25 + 1e-6);
  assert.ok(size.z <= 9.5 + 1e-6);
  assert.ok(frame.getObjectByName('open-frame-structure'));
  frame.traverse((node) => { node.geometry?.dispose?.(); node.material?.dispose?.(); });
});

test('interaction lookup reaches nested labelled roots and rejects hidden hierarchies', () => {
  const root = { visible: true, userData: { label: 'Train', stableId: 'train-1' }, parent: null };
  const nested = { visible: true, userData: {}, parent: root };
  const mesh = { visible: true, userData: {}, parent: nested };
  assert.deepEqual(visibleInteractionData(mesh), root.userData);
  nested.visible = false;
  assert.equal(visibleInteractionData(mesh), null);
});

test('realistic FX honor the callback state and only accept the three visible controls', () => {
  assert.deepEqual(parseThreeFx('none'), { fog: false, grade: false, detail: false });
  assert.deepEqual(parseThreeFx('fog,detail'), { fog: true, grade: false, detail: true });
  assert.deepEqual(parseThreeFx('all'), { fog: true, grade: true, detail: true });
  assert.deepEqual(updateThreeFx(parseThreeFx('all'), { fog: false, imaginary: true }), {
    fog: false, grade: true, detail: true,
  });
});

test('generic filtered markers and quest zones have renderable callback specs', () => {
  assert.deepEqual(markerOverlaySpec({ kind: 'spawn-pmc', position: { x: 210, y: 4, z: 146 } }), {
    x: 210, y: 4, z: 146, kind: 'marker', markerKind: 'spawn-pmc',
    label: 'spawn pmc', title: 'spawn pmc', level: 'surface',
  });
  assert.equal(markerOverlaySpec({ kind: 'stash', position: { x: 'bad', z: 1 } }), null);
  assert.equal(markerOverlaySpec({ kind: 'extract-pmc', name: 'Dorms V-Ex', position: { x: 208, z: 143 } }).kind, 'extract');
  assert.deepEqual(questZoneSpec({ id: 'q1', outline: [[1, 2], [3, 4], [5, 6]], level: 'surface' }), {
    id: 'q1', outline: [[1, 2], [3, 4], [5, 6]], level: 'surface',
  });
  assert.equal(questZoneSpec({ outline: [[1, 2], [3, 4]] }), null);
});

test('DOM overlay anchors stay wholly inside the moving safe rectangle', () => {
  const options = {
    safeRect: { left: 100, top: 70, right: 900, bottom: 600 },
    containerWidth: 1000,
    containerHeight: 700,
    elementWidth: 100,
    elementHeight: 20,
    padding: 4,
  };
  assert.deepEqual(seatOverlayAnchor({ ...options, x: 20, y: 30 }), [154, 94]);
  assert.deepEqual(seatOverlayAnchor({ ...options, x: 980, y: 680 }), [846, 596]);
  assert.deepEqual(seatOverlayAnchor({ ...options, x: 400, y: 300 }), [400, 300]);
  assert.equal(seatOverlayAnchor({ ...options, x: NaN, y: 300 }), null);
});

test('Three proof gate requires Vite DEV, loopback, Customs, and an explicit request', () => {
  const allowed = { dev: true, hostname: 'localhost', mapKey: 'customs', rendererRequest: 'three' };
  assert.equal(canUseLocalThree(allowed), true);
  assert.equal(localRendererMode(allowed), 'three');
  for (const hostname of ['localhost', '127.0.0.1', '::1', '[::1]', 'LOCALHOST']) {
    assert.equal(isLoopbackHostname(hostname), true, hostname);
  }
  assert.equal(normalizeHostname('[::1]'), '::1');
  assert.equal(localRendererMode({ ...allowed, dev: false }), 'deck');
  assert.equal(localRendererMode({ ...allowed, hostname: 'tarkovzero.example' }), 'deck');
  assert.equal(localRendererMode({ ...allowed, mapKey: 'woods' }), 'deck');
  assert.equal(localRendererMode({ ...allowed, rendererRequest: null }), 'deck');
  assert.doesNotThrow(() => assertLocalThree(allowed));
  assert.throws(() => assertLocalThree({ ...allowed, hostname: '192.168.1.4' }), /loopback hostname/);
});

test('renderer integration consumes the shared contract without untracked outline materials', async () => {
  const [main, html, renderer, deckRenderer, styles, manifest] = await Promise.all([
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/map3d-three.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/map3d.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/style.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/assets/3d/customs/scene-manifest.json', import.meta.url), 'utf8'),
  ]);
  assert.match(main, /localRendererMode\(\{[\s\S]*dev: import\.meta\.env\?\.DEV === true,[\s\S]*hostname: location\.hostname/);
  assert.match(main, /document\.body\.classList\.toggle\('renderer-three', rendererMode === 'three'\)/);
  assert.match(main, /if \(rendererMode === 'three'\) \{[\s\S]*\$\('#relief-row'\)\?\.remove\(\)[\s\S]*\$\('#fx-row \[data-fx="fog"\]'\)\?\.remove\(\)/);
  assert.match(main, /const THREE_FIXED_RELIEF = 2/);
  assert.match(main, /let relief = rendererMode === 'three'[\s\S]*\? THREE_FIXED_RELIEF/);
  assert.match(main, /next = rendererMode === 'three' \? THREE_FIXED_RELIEF : Number\(next\)/);
  assert.match(main, /if \(persist && rendererMode !== 'three'\)/);
  assert.match(main, /if \(rendererMode === 'three'\) fx\.fog = false/);
  assert.match(main, /fxQuery \?\? \(rendererMode === 'three' \? null : stored == null \? null : String\(stored\)\)/);
  assert.match(main, /if \(rendererMode === 'three' && key === 'fog'\) return/);
  assert.match(main, /rendererMode === 'three' \? 'realistic' : String\(store\.get\('look', 'vector'\)\)/);
  assert.match(main, /if \(persist && rendererMode !== 'three'\) store\.set\('look', look\)/);
  assert.match(main, /if \(persist && rendererMode !== 'three'\) store\.set\('fx', fxParam\(\)\)/);
  assert.match(main, /safeRect: avoidRect/);
  assert.match(main, /store\.get\('relief', 1\)/);
  assert.match(html, /class="seg-cell on" data-relief="1" aria-pressed="true"/);
  assert.match(html, /id="relief-row"/);
  assert.match(renderer, /assertLocalThree\(\{/);
  assert.match(renderer, /let fx = \{ \.\.\.parseThreeFx\(src\.fx\), fog: false \}/);
  assert.match(renderer, /measuredSurfaceY\(bridge, relief\)/);
  assert.match(renderer, /const THREE_FIXED_RELIEF = 2/);
  assert.match(renderer, /let relief = THREE_FIXED_RELIEF/);
  assert.match(renderer, /let fx = \{ \.\.\.parseThreeFx\(src\.fx\), fog: false \}/);
  assert.match(renderer, /scene\.fog = null/);
  assert.doesNotMatch(renderer, /FogExp2/);
  assert.match(renderer, /setRelief: \(\) => relief/);
  assert.match(renderer, /for \(const \[index, ring\] of \(data\.understory \|\| \[\]\)\.entries\(\)\)/);
  assert.match(renderer, /positions\.setZ\(i, H\(gameX, gameZ\) \+ 0\.065\)/);
  assert.match(renderer, /mesh\.userData = \{ kind: 'understory', evidence: 'customs-3d\.understory' \}/);
  assert.match(renderer, /const groundcoverTextures = makeGroundcoverTextures\(\)/);
  assert.match(renderer, /map: textures\.grassAlbedo, normalMap: textures\.grassNormal/);
  assert.match(renderer, /terrainFlat: new THREE\.MeshStandardMaterial/);
  assert.match(renderer, /grassFlat: new THREE\.MeshStandardMaterial/);
  assert.doesNotMatch(renderer, /materials\.(?:terrain|grass)\.(?:map|normalMap|aoMap|roughnessMap|metalnessMap)\s*=/,
    'WebGPURenderer material observers must not be fed null texture mutations at runtime');
  assert.match(renderer, /const tuftPlan = buildUnderstoryTuftPlan\(data\.understory\)/);
  assert.match(renderer, /new THREE\.InstancedMesh\(/);
  assert.match(renderer, /near\.castShadow = medium\.castShadow = false/);
  assert.match(renderer, /activeDrawCalls: 0/);
  assert.match(renderer, /for \(const marker of src\.markers\?\.\(\) \|\| \[\]\)/);
  assert.match(renderer, /for \(const sourceZone of questData\.zones \|\| \[\]\)/);
  assert.match(renderer, /seatOverlayAnchor\(\{/);
  assert.match(renderer, /reconcileOrbitView\(\{/);
  assert.match(renderer, /if \(reconciled\.corrected\) writeControlledPose\(reconciled\.pose\)/);
  assert.match(renderer, /if \(suppressControlEvent\) return/);
  assert.match(renderer, /document\.hidden \|\| !document\.body\.classList\.contains\('view-3d'\)/);
  assert.match(renderer, /if \(!renderRequested && settleFrames <= 0\) return/);
  assert.match(renderer, /controls\.enableDamping = false/);
  assert.match(renderer, /const invalidateRender = \(frames = 0\)/);
  assert.match(renderer, /outline: new THREE\.LineBasicMaterial/);
  assert.match(renderer, /outlineFor\(mesh, materials\.outline\)/);
  assert.match(renderer, /createAsyncAttachGuard\(\(lateScene\) => disposeTree\(lateScene, \{ materials: true \}\)\)/);
  assert.match(renderer, /const seated = seatAuthoredInstance\(node, instance[\s\S]*const attached = guard\.attach\(seated/);
  // The exact handedness-changing affine transform comes from tested pure math; a quaternion
  // cannot represent it without losing the reflection and reversing EFT forward.
  assert.match(renderer, /customsAssetLinearMatrix\([\s\S]*instance\.transform\.rotation,[\s\S]*instance\.transform\.scale/);
  assert.match(renderer, /scene\.matrixAutoUpdate = false/);
  assert.match(renderer, /label: safeText\(instance\.label \?\? instance\.stableId\)/);
  assert.match(renderer, /authoredAbort\.abort\(\)/);
  assert.match(renderer, /authoredStreamer\.dispose\(\)/);
  assert.match(renderer, /authoredLoaderHost\.dispose\(\)/);
  assert.match(renderer, /authoredAssetCache\.clear\(\)/);
  assert.match(renderer, /disposeMaterialResources\(node\.material, disposed\)/);
  const outlineHelper = renderer.match(/function outlineFor\([^]*?\n\}/)?.[0] ?? '';
  assert.doesNotMatch(outlineHelper, /new THREE\.LineBasicMaterial/, 'outline helper must consume the tracked shared material');
  assert.match(styles, /\.tz-three-marker-marker/);
  assert.match(styles, /body\.renderer-three #relief-row\{display:none\}/);
  assert.match(styles, /body\.renderer-three #fx-row \[data-fx="fog"\]\{display:none\}/);
  assert.match(deckRenderer, /measuredSurfaceY\(b, RELIEF\)/);
  assert.match(renderer, /createFloorSurfaceResolver\(data\.floorSurfaces, relief\)/);
  assert.match(renderer, /visibleBuildingHeight\(mesh\.userData\.surfaceProfile, floor\)/);
  assert.match(renderer, /floorResolver\.undergroundProfile\(item/);
  assert.match(renderer, /buildPropAsset\(prop/);
  assert.match(renderer, /buildOpenFrameBuildingAsset\(/);
  assert.match(renderer, /railwayTrackMeshData\(data\.railway, railSurfaceY, THREE_POC_SCOPE\)/);
  assert.match(renderer, /rail-ballast:/);
  assert.match(renderer, /new THREE\.InstancedMesh\([\s\S]*new THREE\.BoxGeometry\(\.\.\.track\.sleeperSize\)/);
  assert.match(renderer, /buildTerrain\(data, THREE_FIXED_RELIEF/);
  assert.match(renderer, /groundBake\.groundTexture\('realistic'\)/);
  assert.match(renderer, /groundTextureMapping = null;/);
  assert.match(renderer, /gameToTerrainTextureUv\(x, z, groundTextureMapping\)/);
  assert.match(renderer, /texture\.colorSpace = THREE\.SRGBColorSpace/);
  assert.match(renderer, /texture\.flipY = mapping\?\.threeCanvasTextureFlipY !== false/);
  assert.match(renderer, /loadCustomsLocalTerrainPackage\(\{ signal: localTerrainAbort\.signal \}\)/);
  assert.match(renderer, /compileCustomsLocalTerrainMesh\(/);
  assert.match(renderer, /const CUSTOMS_EXACT_TERRAIN_DECIMATION = 1/);
  assert.match(renderer, /loadCustomsLocalVegetation\(exactTerrainPackage/);
  assert.match(renderer, /buildCustomsLocalVegetationRenderPlan\(exactVegetation/);
  assert.match(renderer, /terrainRelativeDisplayY\(\{/);
  assert.match(renderer, /RAILWAY_TRACK_PROFILE\.vehicleWheelBottomLiftM/);
  assert.match(renderer, /texture\.flipY = false/);
  assert.match(renderer, /renderedSeamGapM: 0/);
  assert.match(renderer, /geometry\.setAttribute\('uv1', new THREE\.BufferAttribute\(meshData\.detailUvs/);
  assert.match(renderer, /textures\.normal\.channel = 1/);
  assert.match(renderer, /root\.rotation\.z = pose\.rotationZ/);
  assert.match(renderer, /Array\.isArray\(prop\.path\)/);
  // `wallStructureGroup` joins the pick list so a GATE can report its inferred provenance on hover.
  // Nothing else under it carries a `userData.label`, so fence panels stay silent.
  assert.match(renderer, /\[buildingGroup, propGroup, wallStructureGroup, authoredRoot, dynamicRoot\]/);
  assert.match(renderer, /visibleInteractionData\(hit\.object\)/);
  assert.match(renderer, /customs\.prop\.industrial_rail_yard\.red_container_stack/);
  assert.match(renderer, /if \(container\.__tz3d === api\) delete container\.__tz3d/);
  assert.match(styles, /\.tz-three-marker-landmark/);
  assert.match(deckRenderer, /createFloorSurfaceResolver\(data\.floorSurfaces, relief\)/);
  assert.match(deckRenderer, /visibleBuildingHeight\(b\._surfaceProfile, floor\)/);
  assert.match(deckRenderer, /id: 'measured-floor-surfaces'/);
  assert.match(deckRenderer, /ringAt\(d\.poly, d\.surfaceY \+ 0\.04\)/);
  assert.doesNotMatch(renderer, /\(Number\(floor\) \+ 1\) \* 3\.3/);

  // The authored-asset seam is the v2 manifest contract, not the v1 `chunks` array: the
  // renderer must validate before it fetches, keep one long-lived loader host, replan from the
  // real OrbitControls focus, and synchronize suppression through the attachment ledger.
  assert.match(renderer, /normalizeCustomsAssetManifest\(await response\.json\(\)\)/);
  assert.match(renderer, /createCustomsAssetLoaderHost\(createThreeLoaderFactory\(\{ renderer \}\)\)/);
  assert.match(renderer, /loadVerifiedCustomsGlb\(\{[\s\S]*request,[\s\S]*parse: \(bytes, gltfBaseUrl\) => gltf\.parseAsync\(bytes, gltfBaseUrl\)/);
  assert.match(renderer, /if \(entering\.length === 0 && diff\.leave\.length === 0\) return/);
  assert.match(renderer, /previous: currentPlan/);
  assert.match(renderer, /diffCustomsAssetPlan\(currentPlan, nextPlan\)/);
  assert.match(renderer, /pendingCamera = \{ x, z \}/);
  assert.match(renderer, /authoredCameraFromWorldTarget\(controls\.target\)/);
  assert.match(renderer, /resolveProceduralSuppression\(registry, ledger\)/);
  assert.match(renderer, /syncSuppression\?\.\(resolved\.suppressed\)/);
  assert.match(renderer, /customsAssetLedgerFailureMessages\(ledger\)/);
  assert.match(renderer, /applyProceduralSuppression\(\)/);
  assert.match(renderer, /\[buildingGroup, propGroup, undergroundGroup\]/);
  assert.match(renderer, /restoreProceduralSuppression\(\);[\s\S]*suppressedProceduralFeatures\.clear\(\)/);
  assert.match(renderer, /setFloor: \(next\) => \{[\s\S]*applyFloor\(\);[\s\S]*refreshDynamic\(\)/);
  assert.doesNotMatch(renderer, /loadAuthoredAssets/);
  assert.doesNotMatch(renderer, /loadAuthoredChunks/);

  const parsed = JSON.parse(manifest);
  assert.equal(parsed.map, 'customs');
  assert.equal(parsed.schemaVersion, 2);
  const normalized = normalizeCustomsAssetManifest(parsed);
  assert.equal(normalized.proceduralFallback, false);
  assert.deepEqual(normalized.delivery.assets.map((asset) => asset.id), [
    'fortress-shell-original-baseline',
  ]);
  assert.deepEqual(normalized.delivery.cells.map((cell) => cell.id), ['fortress-golden-cell']);
  assert.equal(normalized.delivery.assets[0].proxies.collision.shape, 'none');
});

test('procedural exact vegetation negates Unity yaw to match the reflected EFT-to-world basis', async () => {
  // `presentationPosition` is `[-x, -z, y]`, a determinant -1 change of basis. Under that
  // reflection a positive Unity yaw about +Y maps to a NEGATIVE rotation about world +Z:
  // the authored vegetation path proves it (`customsAuthoredVegetationInstanceMatrix` applies
  // `Rz(-yaw)`) and the legacy tree/player fallbacks already negate their source yaw.
  const renderer = await readFile(new URL('../src/map3d-three.js', import.meta.url), 'utf8');
  assert.match(renderer, /dummy\.rotation\.set\(0, 0, -placement\.yawRadians\)/,
    'the exact-vegetation instancing must negate yaw, not apply it positively');
  assert.doesNotMatch(renderer, /dummy\.rotation\.set\(0, 0, placement\.yawRadians\)/,
    'the positive-yaw form must not survive');
  // Corroborating sign conventions elsewhere in the same renderer.
  assert.match(renderer, /dummy\.rotation\.z = -\(Number\(tree\.rotation\) \|\| 0\) \* Math\.PI \/ 180/,
    'the reviewed fallback trees negate their authored rotation');
  assert.match(renderer, /mesh\.rotation\.z = -\(Number\(last\.yaw \?\? last\.heading\) \|\| 0\) \* Math\.PI \/ 180/,
    'the live player arrow negates its game yaw');
});
