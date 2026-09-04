import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import {
  OVERLAY_SCOPE_MARGIN_M,
  RAILWAY_TRACK_PROFILE, THREE_POC_SCOPE, UNDERSTORY_TUFT_BUDGET, alphaCoverageMipChain,
  anchorOverlayMark, buildUnderstoryTuftPlan, cameraPose, centroid,
  createAsyncAttachGuard, disposeMaterialResources, drapedLinearSegmentMeshData, gameToWorld, grassTuftMeshData,
  halveCoverageLevel, inRing,
  makeTerrainSampler, markerOverlaySpec, overlayScopeFromLimit, parseThreeFx, pointPropPose, questZoneSpec, reconcileOrbitView,
  railwayTrackMeshData, terrainMeshData, terrainRelativeDisplayY, updateThreeFx, viewStateFromPose,
  visibleInteractionData, withinOverlayScope, withinScope, worldToGame,
} from '../src/three-world.js';
import { CUSTOMS_LABELS } from '../src/labels.js';
import { FakeDocument } from './lib/fake-dom.mjs';
import { KINDS, dotHtml, iconHtml } from '../src/icons.js';
import { tierOf } from '../src/lod.js';
import {
  markerOverlayContent, markerTier, paintMarkerOverlay, safeOverlayLevel,
} from '../src/marker-overlay.js';
import { buildOpenFrameBuildingAsset, buildPropAsset, propAssetKind, propDimensions } from '../src/three-prop-assets.js';
import { BRIDGE_STRUCTURE, bridgeApproachPlan, bridgeStructurePlan, bridgeStructureProfile } from '../src/bridge-structure.js';
import {
  DECK_RENDERER_REQUEST, RENDERER_REQUESTS, THREE_RENDERER_MAPS,
  assertThreeRenderer, canLoadLocalGameDerivedAssets, canRunThreeRenderer, canShowDiagnosticReadouts,
  describeRendererGate,
  isKnownRendererRequest, isLoopbackHostname, normalizeHostname, normalizeRendererRequest,
  resolveRendererMode,
} from '../src/renderer-gate.js';
import { loadCustomsLocalTerrainPackage } from '../src/customs-local-terrain-loader.js';
import { deckWaterClearance } from '../src/water-surface.js';
import { buildingFloorLevels, createFloorSurfaceResolver, measuredSurfaceY } from '../src/surfaces.js';
import { emptyCustomsAssetManifest, normalizeCustomsAssetManifest } from '../src/customs-asset-manifest.js';
import {
  authoredCameraFromWorldTarget,
  createAuthoredAssetStreamer,
  customsExactTerrainSurfaceStatus,
  customsTruthStripCopy,
  proceduralSuppressionKey,
  seatAuthoredInstance,
} from '../src/map3d-three.js';
import { describeVegetationObservability } from '../src/customs-vegetation-observability.js';
import {
  SHADOW_INVALIDATION_REASONS,
  createShadowCasterAudit,
  createShadowController,
  parseShadowRequest,
  shadowCasterFingerprint,
} from '../src/shadow-invalidation.js';

const customs3d = JSON.parse(await readFile(new URL('../public/data/customs-3d.json', import.meta.url), 'utf8'));
const customs = JSON.parse(await readFile(new URL('../public/data/customs.json', import.meta.url), 'utf8'));
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
    hasExactTerrain: true, terrainDistribution: 'local-package',
    surface: customsExactTerrainSurfaceStatus(pbr), vegetation,
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
  const booting = customsTruthStripCopy({ hasExactTerrain: true, terrainDistribution: 'local-package' });
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

// ── The RELEASE strip: the production frame must describe itself, not a localhost one ──────────
//
// Before the gate split, the production Three renderer could not run, so nothing had to be true of
// this strip. Running it unchanged in production would have printed
// `THREE POC · LEGACY TERRAIN FALLBACK · LOCALHOST · … — NO AUTHORED PLAN` on tarkovzero.com: three
// wrong words (it is not a POC of anything the visitor can change, it is not legacy, it is not
// localhost) and one alarm (`NO AUTHORED PLAN`) for the shipped configuration. Both readouts still
// come from ONE `describeVegetationObservability()` call — the release wording is a code in that
// module, not a second source of truth in the renderer.

/**
 * A release build whose PROMOTED vegetation package did not load.
 *
 * Before 2026-09-02 this snapshot was the shipped configuration and the readouts were written to
 * say so calmly. The pack ships now — geometry, texture arrays and the 8,805-row placement table —
 * so the same snapshot is a failed load, and every assertion below exists to prove the readouts
 * moved with it instead of keeping the old reassurance.
 */
const RELEASE_VEGETATION_SNAPSHOT = Object.freeze({
  mode: 'procedural',
  hasAuthoredPlan: false,
  localEnhancements: false,
  reason: 'promoted-vegetation-unavailable',
  mount: null,
  routing: null,
  runtime: null,
  arrayTextures: null,
  // The public tree positions the release frame actually seats — measured on a real `vite preview`
  // run of `dist/` at 2,348 (`diagnostics().sources.trees`). It is NOT zero, and the readouts must
  // not say it is: see the `publicTreePlacements` note in map3d-three.js.
  proceduralPlacements: 2348,
  declaredInstances: null,
  culledOutsideScope: null,
});

test('a release build with NEITHER promoted package reads as two failures, not as the design', () => {
  // NOTE (2026-09-02): this snapshot is a release build with no promoted terrain AND no promoted
  // vegetation — both defects now. The per-subsystem case (exact ground, missing forest) is the
  // test immediately below.
  const observability = describeVegetationObservability(RELEASE_VEGETATION_SNAPSHOT);
  assert.equal(observability.indicator.code, 'promoted-vegetation-missing');
  assert.equal(observability.indicator.state, 'procedural');
  assert.equal(observability.indicator.healthy, false, 'no authored vegetation IS on screen');
  assert.equal(
    observability.indicator.headline,
    'Procedural forest — the promoted vegetation pack did not load',
  );
  assert.match(observability.indicator.detail, /public tree position from \/data\/customs-3d\.json/);
  assert.match(
    observability.indicator.detail,
    /That is a FAILED LOAD, not the shipped configuration/,
    'the pack ships now, so an absent forest is a defect and must read as one',
  );
  assert.doesNotMatch(
    observability.indicator.detail,
    /is NOT promoted|still gated to dev \+ loopback/,
    'the pre-promotion wording described the pack as gated; it ships from public/ now',
  );
  assert.match(
    observability.indicator.detail,
    /— 2348 of them —/,
    'the release message must state the placements actually drawn, never a bare 0',
  );
  assert.equal(observability.accounting.parts.procedural, 2348);
  // The chip and the strip are two renderings of that one verdict, as they already were.
  assert.equal(observability.strip.authoredPlacements, 0);
  assert.equal(observability.strip.code, observability.indicator.code);

  const copy = customsTruthStripCopy({
    hasExactTerrain: false,
    localEnhancements: false,
    publicSurface: 'semantic-ground-atlas',
    vegetation: observability.strip,
  });
  assert.equal(copy.title, 'CUSTOMS PUBLIC DATA');
  assert.equal(
    copy.detail,
    'PUBLIC HEIGHTFIELD — PROMOTED TERRAIN MISSING · SEMANTIC GROUND ATLAS'
    + ' · 0 AUTHORED VEGETATION — PROMOTED PACK DID NOT LOAD · FIXED RELIEF 2×',
  );
  assert.doesNotMatch(copy.detail, /EXACT LOCAL TERRAIN/, 'the release frame has no exact terrain to claim');
  assert.doesNotMatch(copy.detail, /LOCALHOST|LEGACY/, 'it is neither');
  assert.doesNotMatch(
    copy.detail,
    /PUBLIC TREE POSITIONS/,
    'naming the source let the segment read as a description of the shipped frame',
  );
  // Since the two promotions this IS a degradation on both counts: production ships the exact
  // ground and the authored forest, so drawing neither means neither package loaded.
  assert.equal(copy.state, 'degraded', 'a release build with neither promoted package is a defect');
});

// ── The release frame after BOTH 2026-09-02 promotions ─────────────────────────────────────────
//
// The founder opened production and said "this is far from what we worked on. not even the floor
// ground correct." The height and control surfaces were promoted first; the authored vegetation
// followed the same day. Production now draws the exact ground AND the authored forest, so the
// release frame still has to describe TWO subsystems that can disagree — but the vegetation half is
// no longer allowed to describe its own absence as the design.

/** A release build with the promoted ground on screen and the promoted forest missing. */
const PROMOTED_RELEASE_SNAPSHOT = Object.freeze({
  ...RELEASE_VEGETATION_SNAPSHOT,
  terrainDistribution: 'promoted-public',
});

test('THE PER-SUBSYSTEM NOTICE: exact ground and a missing forest are stated separately', () => {
  const observability = describeVegetationObservability(PROMOTED_RELEASE_SNAPSHOT);
  assert.equal(observability.indicator.code, 'promoted-vegetation-missing');
  const detail = observability.indicator.detail;

  // The ground half: named, sourced, and NOT described as gated.
  assert.match(detail, /GROUND: the terrain IS exact here/);
  assert.match(detail, /\/assets\/3d\/customs\/terrain\//);
  // The vegetation half: promoted, absent, and said so in its own clause.
  assert.match(detail, /VEGETATION: the authored pack IS promoted/);
  assert.match(detail, /\/assets\/3d\/customs\/authored\/vegetation\//);
  assert.match(detail, /2348 of them/);
  assert.match(detail, /That is a FAILED LOAD, not the shipped configuration/);

  // DISCRIMINATION: neither of the two superseded claims may survive here.
  assert.doesNotMatch(
    detail,
    /local game-derived data is gated to dev \+ loopback, so the authored/,
    'the pre-terrain-promotion wording described the whole frame as gated; the ground no longer is',
  );
  assert.doesNotMatch(
    detail,
    /Exact ground, procedural trees: that is the shipped configuration/,
    'the pre-vegetation-promotion wording called a procedural forest the shipped configuration',
  );

  // ...and the strip built from that same verdict names the promoted terrain AND the failure.
  const copy = customsTruthStripCopy({
    hasExactTerrain: true,
    terrainDistribution: 'promoted-public',
    localEnhancements: false,
    surface: customsExactTerrainSurfaceStatus({
      hasExactTerrain: true, pbrAvailable: true, paletteAvailable: true,
    }),
    vegetation: observability.strip,
  });
  assert.equal(copy.title, 'CUSTOMS TRUTH');
  assert.equal(
    copy.detail,
    'EXACT TERRAIN — PROMOTED · 12-LAYER AUTHORED PBR'
    + ' · 0 AUTHORED VEGETATION — PROMOTED PACK DID NOT LOAD · FIXED RELIEF 2×',
  );
  assert.doesNotMatch(copy.detail, /LOCAL/, 'a promoted package that ships is not local');
  assert.equal(
    copy.state,
    'degraded',
    'a fallback must read as degraded: the promoted forest ships, so its absence is a defect',
  );
});

// ── THE SHIPPED release frame: both promotions live ────────────────────────────────────────────

test('THE SHIPPED FRAME: promoted ground and a live authored forest read as fully exact', () => {
  // The healthy production frame after both promotions. Nothing is gated, nothing fell back, and
  // this is the ONE arrangement in which the strip is allowed to be green.
  const observability = describeVegetationObservability({
    mode: 'authored',
    hasAuthoredPlan: true,
    localEnhancements: false,
    vegetationDistribution: 'promoted-public',
    terrainDistribution: 'promoted-public',
    reason: null,
    mount: { phase: 'mounted', loaded: 93, expected: 93 },
    routing: { authored: 7108, procedural: 0, rendered: 7108, culled: 1697, source: 8805 },
    runtime: {
      materialMode: 'shared-array-texture',
      drawCalls: 31,
      liveBuckets: 31,
      visibleInstances: 5200,
      frustumCulledInstances: 1908,
    },
    arrayTextures: { layers: 199, textures: 9 },
    arrayTextureFailure: null,
    proceduralPlacements: 0,
    declaredInstances: 8805,
    culledOutsideScope: 1697,
  });
  assert.deepEqual(observability.warnings, [], 'a healthy promoted mount has nothing to explain');
  assert.equal(observability.indicator.state, 'authored');
  assert.equal(observability.indicator.healthy, true);
  assert.equal(observability.strip.authoredPlacements, 7108);

  const copy = customsTruthStripCopy({
    hasExactTerrain: true,
    terrainDistribution: 'promoted-public',
    localEnhancements: false,
    surface: customsExactTerrainSurfaceStatus({
      hasExactTerrain: true, pbrAvailable: true, paletteAvailable: true,
    }),
    vegetation: observability.strip,
  });
  assert.equal(
    copy.detail,
    'EXACT TERRAIN — PROMOTED · 12-LAYER AUTHORED PBR · 7,108 AUTHORED VEGETATION · FIXED RELIEF 2×',
  );
  assert.equal(copy.state, 'exact');
});

test('DISCRIMINATION: the same release snapshot WITHOUT the promoted ground says the opposite', () => {
  // Same code, same subsystem split, opposite ground clause — so the ground half of the notice is
  // driven by measured state and not by a constant.
  const missing = describeVegetationObservability({
    ...PROMOTED_RELEASE_SNAPSHOT, terrainDistribution: null,
  });
  assert.match(missing.indicator.detail, /the terrain is the public heightfield/);
  assert.match(missing.indicator.detail, /which is a defect, not the shipped configuration/);
  assert.doesNotMatch(missing.indicator.detail, /the terrain IS exact here/);

  // And on a dev machine drawing the local package, the ground clause names THAT.
  const localGround = describeVegetationObservability({
    ...PROMOTED_RELEASE_SNAPSHOT, terrainDistribution: 'local-package',
  });
  assert.match(localGround.indicator.detail, /the terrain is the exact local package/);
});

test('a release build still reports a ground bake that actually failed', () => {
  const copy = customsTruthStripCopy({
    hasExactTerrain: false,
    localEnhancements: false,
    publicSurface: 'tileable-fallback',
    vegetation: describeVegetationObservability(RELEASE_VEGETATION_SNAPSHOT).strip,
  });
  assert.match(copy.detail, /TILEABLE GROUND FALLBACK/);
  assert.equal(copy.state, 'degraded', 'a bake that fell back on its own is a real defect, gate or no gate');

  const booting = customsTruthStripCopy({ hasExactTerrain: false, localEnhancements: false });
  assert.equal(
    booting.detail,
    'PUBLIC HEIGHTFIELD — PROMOTED TERRAIN MISSING · RESOLVING SURFACE · RESOLVING VEGETATION'
    + ' · FIXED RELIEF 2×',
  );
  // 'degraded' outranks 'pending': the missing promoted terrain is already a known fact here, and
  // the strip wears the worst thing it is reporting.
  assert.equal(booting.state, 'degraded');

  // The booting strip for the SHIPPED configuration still says pending, because nothing has gone
  // wrong yet — the promoted ground is on screen and only the surface/vegetation are unresolved.
  const bootingPromoted = customsTruthStripCopy({
    hasExactTerrain: true, terrainDistribution: 'promoted-public', localEnhancements: false,
  });
  assert.equal(
    bootingPromoted.detail,
    'EXACT TERRAIN — PROMOTED · RESOLVING SURFACE · RESOLVING VEGETATION · FIXED RELIEF 2×',
  );
  assert.equal(bootingPromoted.state, 'pending');
});

test('the release code cannot be reached by an absent plan on a dev machine', () => {
  // Same missing plan, opposite meaning. `localEnhancements` is the only input that separates them,
  // so a dev machine whose local package failed still gets the amber defect wording it needs.
  const devMachine = describeVegetationObservability({
    ...RELEASE_VEGETATION_SNAPSHOT, localEnhancements: true, reason: 'no-exact-vegetation-plan',
  });
  assert.equal(devMachine.indicator.code, 'no-authored-plan');
  assert.equal(
    customsTruthStripCopy({ hasExactTerrain: false, vegetation: devMachine.strip }).state,
    'degraded',
  );
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

// ------------------------------------------------------------------------------------ bridges
// `main.js` pins the Three renderer to relief 2, and the renderer seats a bridge deck on its
// measured surface when it has one and on a local lift above the ground when it does not. Both
// halves are reproduced here so the structure is asserted against the deck the renderer actually
// draws, not against a convenient flat plane.
const THREE_RELIEF = 2;
const bridgeSeating = (bridge) => {
  const H = makeTerrainSampler(customs3d.terrain, THREE_RELIEF);
  const surfaceY = measuredSurfaceY(bridge, THREE_RELIEF);
  const lift = Math.max(0.1, Number(bridge.height) || 0.7);
  // ONE sampler, as in the renderer. A measured deck is one flat altitude end to end; nothing
  // bends it, and the gap that leaves at each bank is filled by `bridgeApproachPlan`'s structure.
  return { H, deckYAt: surfaceY == null ? (x, z) => H(x, z) + lift : () => surfaceY + 0.08 };
};
/** Prism mesh data carries world positions `[-x, -z, y]`; read each vertex back in game space. */
const meshVertices = (meshData) => Array.from(
  { length: meshData.positions.length / 3 },
  (_, index) => ({
    x: -meshData.positions[index * 3],
    z: -meshData.positions[index * 3 + 1],
    y: meshData.positions[index * 3 + 2],
  }),
);

test('a ford is a crossing, not a structure — no rails, no piers, no deck edge', () => {
  const ford = customs3d.bridges.find((item) => item.name === 'River path');
  assert.ok(ford, 'the Customs artifact must still carry the River path crossing');
  assert.equal(ford.ford, true, 'this test discriminates on the ford flag; the fixture must have it');
  const { H, deckYAt } = bridgeSeating(ford);
  const plan = bridgeStructurePlan(ford, { deckYAt, groundYAt: H });

  assert.equal(plan.ford, true);
  assert.equal(plan.fascia, null, 'a ford has no deck edge to show');
  assert.deepEqual(plan.rails, [], 'railings on a ford would claim a bridge the game does not have');
  assert.deepEqual(plan.piers, [], 'nothing holds a ford up');

  // The exclusion must be the FLAG, not an empty path or a degenerate width: the same geometry
  // with the flag off has to produce a full structure, or this test proves nothing.
  assert.ok(plan.lengthM > 60, `the ford path is real (${plan.lengthM.toFixed(1)} m), so zero structure is a decision`);
  const asBridge = bridgeStructurePlan({ ...ford, ford: false }, { deckYAt, groundYAt: H });
  assert.ok(asBridge.fascia, 'the same path DOES get a deck edge once it is not a ford');
  assert.equal(asBridge.rails.length, 2, 'and railings on both sides');
});

test('the Junk Bridge gets structure scaled to its own 3 m deck, not the Main Bridge\'s', () => {
  const foot = customs3d.bridges.find((item) => item.name === 'Junk Bridge');
  const main = customs3d.bridges.find((item) => item.name === 'Main Bridge');
  assert.equal(foot.foot, true);
  assert.equal(foot.width, 3, 'the footbridge fixture is the narrow case this test exists for');
  const { H, deckYAt } = bridgeSeating(foot);
  const plan = bridgeStructurePlan(foot, { deckYAt, groundYAt: H });
  const mainProfile = bridgeStructureProfile(main.width);

  assert.ok(plan.fascia, 'a small bridge still needs a deck with thickness');
  assert.equal(plan.rails.length, 2, 'a small bridge still needs both railings');
  assert.ok(plan.piers.length >= 2, `a 22 m deck standing 2.5 m up needs supports (got ${plan.piers.length})`);

  // Scaled to ITS OWN width. Every one of these is false if main-bridge dimensions are hardcoded.
  assert.ok(plan.profile.pierWidthM < mainProfile.pierWidthM);
  assert.ok(plan.profile.railBarWidthM < mainProfile.railBarWidthM);
  assert.ok(plan.profile.deckThicknessM < mainProfile.deckThicknessM);
  assert.ok(plan.profile.pierWidthM <= foot.width, 'a pier wider than the deck it carries is not a bridge');
  assert.ok(plan.profile.railHalfSpanM < foot.width / 2, 'railings stand ON the deck, not beside it');
  assert.ok(plan.profile.railHeightM >= 0.9, 'a parapet under ~0.9 m is invisible at map zoom');

  for (const pier of plan.piers) {
    close(pier.topY, deckYAt(pier.x, pier.z) - plan.profile.deckThicknessM, 1e-9, 'a pier meets the deck underside');
    assert.ok(pier.bottomY < H(pier.x, pier.z), 'a pier foot is IN the ground, not floating above it');
    assert.ok(pier.heightM > 2, `a 2.5 m clearance leaves a real support (got ${pier.heightM.toFixed(2)} m)`);
  }
  for (const rail of plan.rails) {
    for (const vertex of meshVertices(rail)) {
      const deck = deckYAt(vertex.x, vertex.z);
      assert.ok(vertex.y >= deck - 1e-6, 'no railing vertex may drop below the deck it stands on');
      assert.ok(vertex.y <= deck + plan.profile.railHeightM + 0.05, 'nor float above its own height');
    }
  }
  for (const vertex of meshVertices(plan.fascia)) {
    const deck = deckYAt(vertex.x, vertex.z);
    assert.ok(vertex.y <= deck, 'the deck edge hangs BELOW the running surface');
    assert.ok(vertex.y >= deck - plan.profile.deckThicknessM - 0.05, 'and only by its own thickness');
  }
});

// `bridgeStructurePlan`'s own contract: whatever deck sampler it is handed, the fascia and rails
// ride it and only the piers reach for the ground.
test('bridge structure rides the measured deck; only the piers follow the ground', () => {
  const main = customs3d.bridges.find((item) => item.name === 'Main Bridge');
  const { H, deckYAt } = bridgeSeating(main);
  assert.ok(measuredSurfaceY(main, THREE_RELIEF) != null, 'the Main Bridge is the measured case');
  const seated = bridgeStructurePlan(main, { deckYAt, groundYAt: H });
  assert.ok(seated.piers.length >= 1 && seated.rails.length === 2 && seated.fascia);

  // Drop the riverbed 40 m. A deck with surveyed evidence may not follow it, and neither may
  // anything the deck carries; the piers must simply reach further down.
  const dropped = bridgeStructurePlan(main, { deckYAt, groundYAt: (x, z) => H(x, z) - 40 });
  assert.deepEqual(round(dropped.fascia.positions, 6), round(seated.fascia.positions, 6),
    'the deck edge is seated on the measured deck, not on interpolated ground');
  assert.deepEqual(round(dropped.rails[0].positions, 6), round(seated.rails[0].positions, 6),
    'railings are seated on the measured deck too');
  assert.equal(dropped.piers.length, seated.piers.length);
  for (const [index, pier] of dropped.piers.entries()) {
    close(pier.topY, seated.piers[index].topY, 1e-9, 'a pier still meets the same deck underside');
    close(pier.heightM - seated.piers[index].heightM, 40, 1e-6, 'and grows by exactly the drop');
  }
  // The gorge is deep enough at 2x relief that the midspan pier is a real column, not a kerb.
  assert.ok(Math.max(...seated.piers.map((pier) => pier.heightM)) > 8);
});

/**
 * The two end cross-sections of the deck ribbon, in game coordinates.
 *
 * `ribbonGeometry` is module-private to `map3d-three.js`, so its first and last quads are rebuilt
 * here by the same rule: the centre-line vertex plus a half-width offset along the segment normal.
 * These four points are literally the corners the founder is looking at.
 */
const deckEndCorners = (bridge) => {
  const path = bridge.path;
  const ends = [[path[0], path[1]], [path[path.length - 1], path[path.length - 2]]];
  return ends.flatMap(([end, inner]) => {
    const dx = inner[0] - end[0], dz = inner[1] - end[1];
    const length = Math.hypot(dx, dz) || 1;
    const nx = -dz / length, nz = dx / length;
    const half = (Number(bridge.width) || 5) / 2;
    return [-1, 1].map((side) => [end[0] + nx * half * side, end[1] + nz * half * side]);
  });
};

test('the Main Bridge deck is FLAT — a bridge deck, not a folded ribbon', () => {
  // The founder, at a low close angle, on the deck that eased its last 15 m down to grade at each
  // end: "need a fix this aint a bridge no more". A deck is a level structure; the vertical
  // difference between its ends is carried by ABUTMENTS and an approach EMBANKMENT, never by
  // bending the running surface. This assertion is the one that fails the moment a deck is bent.
  const main = customs3d.bridges.find((item) => item.name === 'Main Bridge');
  const { deckYAt } = bridgeSeating(main);
  const level = measuredSurfaceY(main, THREE_RELIEF) + 0.08;
  assert.ok(Number.isFinite(level), 'the Main Bridge is the measured case this test is about');
  // Path vertices AND the four corners the founder is looking at: a ribbon is bent at its edges
  // too, and a centre-line-only check would pass a deck whose corners were dragged down.
  for (const [x, z] of [...main.path, ...deckEndCorners(main)]) {
    close(deckYAt(x, z), level, 1e-9,
      `deck vertex at ${x.toFixed(1)}, ${z.toFixed(1)} sits at ${deckYAt(x, z).toFixed(3)}, not on the measured ${level.toFixed(3)}`);
  }
});

/**
 * How far a prism's base may miss the ground it is founded on, in metres.
 *
 * Mesh positions are stored as Float32Array, so a base computed in doubles at ~5 m comes back with
 * about 5e-7 m of storage error; 1 mm is that, with room to spare, and is three orders of magnitude
 * below the 0.35 m founding embed the assertion is actually about.
 */
const SEAT_TOLERANCE_M = 1e-3;

/** The closed footprint ring of a prism whose vertices interleave left, right, left, right… */
const prismRing = (meshData) => {
  const lefts = meshData.footprint.filter((_, index) => index % 2 === 0);
  const rights = meshData.footprint.filter((_, index) => index % 2 === 1);
  return [...lefts, ...rights.reverse()];
};

test('each Main Bridge abutment is a solid mass founded on the bank under the deck end', () => {
  const main = customs3d.bridges.find((item) => item.name === 'Main Bridge');
  const { H, deckYAt } = bridgeSeating(main);
  const approach = bridgeApproachPlan(main, { deckYAt, groundYAt: H });
  const profile = approach.profile;

  // The defect this exists for. If the fixture ever stops stranding its ends, everything below
  // stops meaning anything, so the gap is asserted to be REAL before it is asserted to be filled.
  const gaps = [main.path[0], main.path[main.path.length - 1]].map(([x, z]) => deckYAt(x, z) - H(x, z));
  assert.ok(gaps.every((gap) => gap > 2),
    `a flat measured deck ends above its banks (${gaps.map((gap) => gap.toFixed(2)).join(' / ')} m)`);
  assert.equal(approach.ends.length, 2, 'both ends of the Main Bridge stand above grade');

  const undersideY = deckYAt(...main.path[0]) - profile.deckThicknessM - BRIDGE_STRUCTURE.fasciaTopGapM;
  for (const end of approach.ends) {
    const abutment = end.abutment;
    assert.ok(abutment, `${end.side}: an end standing ${end.gapM.toFixed(2)} m up needs an abutment`);

    // 1. It covers the DECK UNDERSIDE. All four corners the founder is looking at stand over it,
    //    and its top face is exactly the plane the fascia's base sits on — no seam, no gap.
    const ring = prismRing(abutment);
    const endCorners = deckEndCorners(main).filter(([x, z]) => Math.abs(
      (x - end.x) * Math.cos(end.yaw) + (z - end.z) * Math.sin(end.yaw),
    ) < 1e-6);
    assert.equal(endCorners.length, 2, `${end.side}: this end contributes two deck corners`);
    for (const corner of endCorners) {
      assert.ok(inRing(corner, ring), `${end.side}: deck corner ${corner.map((v) => v.toFixed(1))} is not over the abutment`);
    }
    for (const y of abutment.tops) close(y, undersideY, 1e-9, `${end.side}: the abutment top IS the deck underside`);
    for (const vertex of meshVertices(abutment).slice(abutment.footprint.length)) {
      close(vertex.y, undersideY, SEAT_TOLERANCE_M, `${end.side}: an abutment top vertex left the deck underside`);
    }

    // 2. It touches the ground at EVERY corner — no floating, no burial past the founding embed.
    for (const vertex of meshVertices(abutment).slice(0, abutment.footprint.length)) {
      const groundY = H(vertex.x, vertex.z);
      assert.ok(vertex.y <= groundY + SEAT_TOLERANCE_M,
        `${end.side}: an abutment corner floats ${(vertex.y - groundY).toFixed(3)} m over the bank`);
      assert.ok(vertex.y >= groundY - BRIDGE_STRUCTURE.abutmentFootEmbedM - SEAT_TOLERANCE_M,
        `${end.side}: an abutment corner is buried ${(groundY - vertex.y).toFixed(3)} m, past the ${BRIDGE_STRUCTURE.abutmentFootEmbedM} m embed`);
    }

    // 3. It is a little wider than the deck and reaches back under it, so it reads as founded.
    assert.ok(profile.abutmentHalfWidthM > main.width / 2, 'an abutment narrower than its deck is a stub');
    assert.ok(profile.abutmentInsetM > 0, 'the deck end BEARS on the abutment, it does not abut a wall');
    assert.ok(profile.abutmentDepthM >= 2.5, 'and the mass continues behind the deck end');
  }
});

test('the approach embankment carries the road to the ground at a road grade, not a ramp grade', () => {
  const main = customs3d.bridges.find((item) => item.name === 'Main Bridge');
  const { H, deckYAt } = bridgeSeating(main);
  const approach = bridgeApproachPlan(main, { deckYAt, groundYAt: H });
  const deckLevel = deckYAt(...main.path[0]);

  for (const end of approach.ends) {
    assert.ok(end.embankment, `${end.side}: a ${end.gapM.toFixed(2)} m drop needs an embankment, not a cliff`);
    // The grade the founder rejected was 102% locally. A road is not.
    assert.ok(end.approachGradePct >= 8 && end.approachGradePct <= 12,
      `${end.side}: the approach runs at ${end.approachGradePct.toFixed(1)}%, outside a plausible road grade`);
    assert.ok(end.meetsGrade,
      `${end.side}: the approach never reached the ground inside ${BRIDGE_STRUCTURE.approachMaxLengthM} m`);
    assert.ok(Math.abs(end.residualGapM) <= BRIDGE_STRUCTURE.approachGradeLiftM + 0.05,
      `${end.side}: the approach still finishes ${end.residualGapM.toFixed(3)} m off the ground`);
    // The carriageway ON the embankment: level with the deck where they meet, and at the ground
    // where it ends. `topYAt` is the fill's top; the road ribbon rides `approachSurfaceM` above it.
    const road = (x, z) => end.topYAt(x, z) + BRIDGE_STRUCTURE.approachSurfaceM;
    close(road(end.x, end.z), deckLevel, 1e-9, `${end.side}: the road leaves the deck at deck level`);
    const [tailX, tailZ] = end.approachPath[end.approachPath.length - 1];
    assert.ok(Math.abs(road(tailX, tailZ) - H(tailX, tailZ)) <= BRIDGE_STRUCTURE.approachGradeLiftM + 0.05,
      `${end.side}: the far end of the approach must meet the road on the ground`);

    // Every corner of the fill sits on the bank, exactly as the abutment's does.
    for (const vertex of meshVertices(end.embankment).slice(0, end.embankment.footprint.length)) {
      const groundY = H(vertex.x, vertex.z);
      assert.ok(vertex.y <= groundY + SEAT_TOLERANCE_M,
        `${end.side}: an embankment corner floats ${(vertex.y - groundY).toFixed(3)} m over the ground`);
      assert.ok(vertex.y >= groundY - BRIDGE_STRUCTURE.abutmentFootEmbedM - SEAT_TOLERANCE_M,
        `${end.side}: an embankment corner is buried past the founding embed`);
    }
    // Nowhere may the fill's own top break the grade it claims: measured between consecutive
    // path stations, which is where a bump in the terrain would show up.
    for (let index = 1; index < end.approachPath.length; index += 1) {
      const [ax, az] = end.approachPath[index - 1], [bx, bz] = end.approachPath[index];
      const run = Math.hypot(bx - ax, bz - az);
      const rise = Math.abs(end.topYAt(bx, bz) - end.topYAt(ax, az));
      assert.ok(rise / run <= BRIDGE_STRUCTURE.approachGrade + 1e-6,
        `${end.side}: the approach breaks its own grade (${((rise / run) * 100).toFixed(1)}%) at ${ax.toFixed(1)}, ${az.toFixed(1)}`);
    }
  }
});

test('a ford and a non-measured deck get no abutment and no embankment', () => {
  // The seating gate, from the planner's side. `customs-local-bridges.test.mjs` owns the renderer's
  // half of it; what has to hold here is that a ford is excluded by its FLAG, not by its geometry.
  const ford = customs3d.bridges.find((item) => item.name === 'River path');
  const { H, deckYAt } = bridgeSeating(ford);
  assert.deepEqual(bridgeApproachPlan(ford, { deckYAt, groundYAt: H }).ends, [],
    'a ford is a crossing, not a structure');
  const asBridge = bridgeApproachPlan({ ...ford, ford: false }, { deckYAt, groundYAt: H });
  assert.ok(asBridge.ends.length > 0,
    'the exclusion is the FLAG: the same geometry DOES plan approaches once it is not a ford');

  // The Junk Bridge is the row that must never be pulled toward a sampled bed.
  const foot = customs3d.bridges.find((item) => item.name === 'Junk Bridge');
  const seat = bridgeSeating(foot);
  assert.equal(measuredSurfaceY(foot, THREE_RELIEF), null, 'the Junk Bridge is NOT measured seating');
  const gaps = foot.path.map(([x, z]) => seat.deckYAt(x, z) - seat.H(x, z));
  assert.ok(gaps.every((gap) => Math.abs(gap - gaps[0]) < 1e-9),
    'a terrain-lift deck already rides its own ground at a constant lift');
});

test('the flat deck and its abutments never put a deck back under the water', () => {
  // The Junk Bridge clears the river surface by under half a metre once exact terrain is mounted,
  // and a deck under the sheet is invisible with every applied counter green. The renderer's own
  // over-water bookkeeping is reproduced here across all three public rows.
  const plans = (customs3d.water || []).map((water) => ({
    water,
    plan: { displayY: (Number(water.level) || 0) * THREE_RELIEF + 0.08 },
  }));
  const submerged = [];
  let crossings = 0;
  for (const bridge of customs3d.bridges) {
    const { deckYAt } = bridgeSeating(bridge);
    const clearance = deckWaterClearance(bridge.path, deckYAt, plans);
    crossings += clearance.crossings;
    if (clearance.crossings > 0 && clearance.clearanceM <= 0 && bridge.ford !== true) submerged.push(bridge.name);
  }
  assert.ok(crossings > 0, 'these decks do cross water, so an empty `submerged` is not vacuous');
  assert.deepEqual(submerged, [], 'no deck may be left under the water surface');

  const main = customs3d.bridges.find((item) => item.name === 'Main Bridge');
  const { deckYAt } = bridgeSeating(main);
  const clearance = deckWaterClearance(main.path, deckYAt, plans);
  assert.ok(clearance.crossings > 0, 'the Main Bridge does cross water, so this assertion can fail');
  assert.ok(clearance.clearanceM > 5,
    `the flat Main Bridge stands well clear of the river (${clearance.clearanceM.toFixed(2)} m)`);
});

test('the Three renderer builds the bridge structure it plans', async () => {
  // A source assertion, not a render: the Three scene needs a GPU. What it CAN prove is that the
  // one deck altitude reaches every part, that the ford short-circuit is in the renderer and not
  // only in the planner, and that the deck's measured seating was not disturbed.
  const renderer = await readFile(new URL('../src/map3d-three.js', import.meta.url), 'utf8');
  // ONE flat deck altitude. No wrapper, no ramp, no second sampler: this line IS the founder's fix.
  assert.match(renderer, /const deckYAt = surfaceY == null \? \(x, z\) => H\(x, z\) \+ lift : \(\) => surfaceY \+ 0\.08;/);
  assert.doesNotMatch(renderer, /bridgeDeckRamp/, 'nothing in the renderer may bend a deck to its bank');
  assert.match(
    renderer,
    /const geometry = ribbonGeometry\(bridge\.path, Number\(bridge\.width\) \|\| 5, deckYAt, 0\);/,
    'the deck ribbon is drawn from the same flat sampler the structure is planned with',
  );
  // Abutments are wired to MEASURED seating ONLY — a terrain-lift or canonical-game-Y deck must
  // never be given a mass reaching down to a sampled bed, or the Junk Bridge goes under the river.
  assert.match(
    renderer,
    /const approach = seating\.mode === BRIDGE_SEATING\.MEASURED\s*\n\s*\? bridgeApproachPlan\(bridge, \{ deckYAt, groundYAt: H \}\)\s*\n\s*: null;/,
  );
  assert.match(
    renderer,
    /\['bridge-abutments', abutments\], \['bridge-embankments', embankments\]/,
    'both solids are merged and batched, the way the piers are',
  );
  assert.match(renderer, /const mesh = new THREE\.Mesh\(geometry, materials\.pier\);/,
    'an abutment is concrete, in the same family as the piers');
  assert.match(
    renderer,
    /ribbonGeometry\(end\.approachPath, Number\(bridge\.width\) \|\| 5, end\.topYAt, BRIDGE_STRUCTURE\.approachSurfaceM\)/,
    'the approach carries the road material on top of its own fill',
  );
  assert.match(renderer, /abutments: abutments\.length, embankments: embankments\.length, approaches,/);
  assert.match(renderer, /const plan = bridgeStructurePlan\(bridge, \{ deckYAt, groundYAt: H \}\);/);
  assert.match(renderer, /if \(plan\.ford\) \{ fords\+\+; continue; \}/);
  assert.match(renderer, /structureMesh\(plan\.fascia, materials\.bridgeEdge, `bridge-fascia:\$\{label\}`\)/);
  assert.match(renderer, /structureMesh\(rail, materials\.bridgeRail, `bridge-rail:\$\{label\}:\$\{rail\.side\}`\)/);
  assert.match(renderer, /pierMesh\.name = 'bridge-piers'/);
  assert.match(renderer, /new THREE\.InstancedMesh\(new THREE\.BoxGeometry\(1, 1, 1\), materials\.pier, piers\.length\)/);
  assert.match(renderer, /bridges: \{ \.\.\.bridgeRenderStats, local: localBridgeStatus \}/);
  // A local row's deck altitude is a CANONICAL game Y and must reach `displayCanonicalObjectY`,
  // never `measuredSurfaceY` — which multiplies by relief and would stretch a game altitude.
  assert.match(renderer, /const seating = bridgeSeating\(bridge\);/);
  // The anchor is chosen against the CANONICAL sampler — the deck is pinned to its highest bank.
  assert.match(renderer, /\? bridgeDeckAnchor\(bridge, HCanonical\)/);
  assert.match(
    renderer,
    /const surfaceY = anchor\s*\n\s*\? displayCanonicalObjectY\(seating\.canonicalYM, anchor\[0\], anchor\[1\]\)\s*\n\s*: measuredSurfaceY\(bridge, relief\);/,
  );
  // The public rows stay the renderer's default: the merged list falls back to `data.bridges`.
  assert.match(renderer, /const bridgeRows = localBridgeMerge\?\.bridges \?\? data\.bridges \?\? \[\];/);
  // The three colours are the deck renderer's, read from the shared palette rather than reinvented.
  assert.match(renderer, /const BRIDGE_COLORS = paletteFor\('realistic'\);/);
  for (const key of ['bridge', 'bridgeRail', 'pier']) {
    assert.match(renderer, new RegExp(`rgb\\(BRIDGE_COLORS\\.${key}\\)`), `materials must draw C.${key}`);
  }
});

test('the water sheet is seated by the plan, and only exact terrain may change where it sits', async () => {
  // The renderer half of the underwater-bridge defect. `waterSurfacePlan` is unit-tested in
  // `customs-local-bridges.test.mjs`; what has to hold HERE is that the renderer actually uses it,
  // that the exact-terrain samplers are the only thing that can move the sheet, and that the
  // clearance a deck keeps over the water is reported instead of assumed.
  const renderer = await readFile(new URL('../src/map3d-three.js', import.meta.url), 'utf8');
  assert.match(renderer, /mesh\.position\.z = plan\.displayY;/, 'the sheet takes its altitude from the plan');
  assert.doesNotMatch(
    renderer,
    /mesh\.position\.z = \(Number\(water\.level\) \|\| 0\) \* relief/,
    'the raw fitted-level expression may not survive anywhere in the renderer',
  );
  // Null samplers are the release path, and `waterSurfacePlan` reproduces `level * relief + lift`
  // exactly when they are null — so this ternary IS the production-unchanged guarantee.
  assert.match(renderer, /canonicalGroundAt: exactTerrainMesh \? HCanonical : null,/);
  assert.match(renderer, /displayGroundAt: exactTerrainMesh \? H : null,/);
  assert.match(renderer, /water: \{ \.\.\.waterRenderStats \},/);
  // The metric that can fail: a deck under the surface is named, not counted as applied.
  assert.match(renderer, /const \{ clearanceM, crossings \} = deckWaterClearance\(bridge\.path, deckYAt, waterSurfacePlans\);/);
  assert.match(renderer, /if \(clearanceM <= 0\) overWater\.submerged\.push/);
  assert.match(renderer, /bridge decks are UNDER the water surface and cannot be seen/);
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
  // The surveyed storey planes ARTICULATE the shell — storey separator lines and window bands —
  // and survived the floor selector's removal on 2026-09-02 precisely because they were never the
  // selector. `buildingFloorLevels` is the one function both renderers band against.
  const dormsBands = buildingFloorLevels(dormsProfile);
  assert.equal(dormsBands.length, 2, 'Dorms 3-Story must still articulate two storey lines');
  close(dormsBands[0], 2.986);
  close(dormsBands[1], 5.981);
  close(buildingFloorLevels(dormsProfile, { inset: 1.35 })[0], 1.636, 1e-9,
    'the window band must still drop below its slab line');
  assert.equal(buildingFloorLevels(dormsProfile, { includeRoof: true }).length, 3);
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
  close(buildingFloorLevels(dormsAt3)[0], dormsBands[0], 1e-9,
    'relief must not move a storey line relative to its own base');

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

/* ═══════════════════════════════════════ the sun's frozen shadow depth map (P1) ═══════════ */

const shadowNode = ({ id, castShadow = false, visible = true, children = [], matrix = null,
  count = undefined, material = undefined, geometryId = 7, kind = 'trunk-batch' } = {}) => ({
  id,
  castShadow,
  visible,
  children,
  userData: { kind },
  matrixWorld: { elements: matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
  ...(count === undefined ? {} : { count, instanceMatrix: { version: 0 } }),
  ...(material === undefined ? {} : { material }),
  geometry: { id: geometryId },
});
const fakeSun = () => ({
  castShadow: true,
  visible: true,
  position: { x: -240, y: 340, z: 430 },
  target: { position: { x: 1, y: 2, z: 0 } },
  shadow: {
    autoUpdate: true,
    needsUpdate: false,
    mapSize: { width: 2048, height: 2048 },
    camera: { left: -260, right: 260, top: 260, bottom: -260, near: 20, far: 1100, zoom: 1 },
  },
});

test('constructing the shadow controller freezes the depth map and arms exactly one bake', () => {
  const sun = fakeSun();
  const controller = createShadowController({ shadow: sun.shadow });
  assert.equal(sun.shadow.autoUpdate, false, 'the whole optimisation is this flag');
  assert.equal(sun.shadow.needsUpdate, true, 'without the first bake there would be NO shadows at all');
  assert.equal(controller.live, false);
  assert.equal(controller.pending, true);

  // three consumes the flag on the frame it renders the depth map.
  sun.shadow.needsUpdate = false;
  assert.equal(controller.pending, false);
  assert.equal(controller.stats().invalidations, 0, 'the boot bake is not an invalidation');
});

test('?shadows=live leaves three doing exactly what it did before this change', () => {
  const sun = fakeSun();
  const controller = createShadowController({ shadow: sun.shadow, live: true });
  assert.equal(sun.shadow.autoUpdate, true);
  assert.equal(controller.live, true);
  assert.equal(controller.stats().mode, 'live-every-frame');
});

test('the invalidation reasons are a CLOSED enum — a typo throws instead of doing nothing', () => {
  const sun = fakeSun();
  const controller = createShadowController({ shadow: sun.shadow, now: () => 1234 });
  sun.shadow.needsUpdate = false;

  controller.invalidate('procedural-vegetation');
  assert.equal(sun.shadow.needsUpdate, true);
  assert.deepEqual(controller.stats().last, { reason: 'procedural-vegetation', atMs: 1234 });
  sun.shadow.needsUpdate = false;
  controller.invalidate('procedural-vegetation');
  controller.invalidate('world-build');
  assert.deepEqual(controller.stats().byReason, { 'world-build': 1, 'procedural-vegetation': 2 });

  // The discriminating half: a reason nobody declared is a build-time-visible failure, not a
  // silent no-op that ships a stale shadow.
  sun.shadow.needsUpdate = false;
  assert.throws(() => controller.invalidate('vegetation-swap'), /unknown shadow invalidation reason/);
  assert.equal(sun.shadow.needsUpdate, false, 'a refused invalidation must not half-apply');
});

test('parseShadowRequest defaults to OFF and reports a value it did not recognise', () => {
  assert.deepEqual({ ...parseShadowRequest('') }, { live: false, audit: false, unknown: [] });
  assert.equal(parseShadowRequest('?shadows=live').live, true);
  assert.equal(parseShadowRequest('?shadows=LIVE').live, true);
  assert.equal(parseShadowRequest('?shadows=1').live, true);
  assert.equal(parseShadowRequest('?shadows=off').live, false);
  assert.equal(parseShadowRequest('?shadows=frozen').live, false, 'the mode name, not just the falsy vocabulary');
  assert.equal(parseShadowRequest('?shadowAudit=1').audit, true);
  // A misspelling must not silently take the default — that is how a control arm ends up being the
  // arm under test.
  const typo = parseShadowRequest('?shadows=liv');
  assert.equal(typo.live, false);
  assert.deepEqual([...typo.unknown], ['shadows=liv']);
});

test('a BARE ?shadowAudit arms the audit instead of silently disarming it', () => {
  // `''` used to be in the falsy set, so `?shadowAudit` typed bare — the way a human types a
  // switch — read as `false` and produced a session whose only trace was `{ armed: false }`. That
  // is the one instrument built to catch a dropped invalidation, turned off by the act of asking
  // for it. A flag that is PRESENT is on.
  const bare = parseShadowRequest('?shadowAudit');
  assert.equal(bare.audit, true, 'a bare ?shadowAudit must arm the audit');
  assert.deepEqual([...bare.unknown], []);
  assert.equal(parseShadowRequest('?shadowAudit=').audit, true);
  // ...and it is still switchable OFF without deleting the parameter.
  assert.equal(parseShadowRequest('?shadowAudit=0').audit, false);

  // `?shadows` names a MODE, so bare names nothing: it is reported rather than guessed in either
  // direction. Guessing `live` would silently un-ship the optimisation; guessing `frozen` would
  // silently ignore a request for the control arm.
  const bareMode = parseShadowRequest('?shadows');
  assert.equal(bareMode.live, false);
  assert.deepEqual([...bareMode.unknown], ['shadows= (present with no value)']);
});

test('the caster fingerprint sees every kind of caster change, and ignores the rest', () => {
  const sun = fakeSun();
  const build = () => {
    const trunk = shadowNode({ id: 1, castShadow: true, count: 900 });
    const crown = shadowNode({ id: 2, castShadow: true, count: 900 });
    const trees = shadowNode({ id: 3, children: [trunk, crown] });
    const tuft = shadowNode({ id: 4, castShadow: false, count: 40_000 });
    const scene = shadowNode({ id: 0, children: [trees, tuft] });
    return { scene, trees, trunk, crown, tuft };
  };
  const world = build();
  const base = shadowCasterFingerprint(world.scene, { light: sun });
  assert.equal(base.casters, 2);
  assert.equal(shadowCasterFingerprint(build().scene, { light: sun }).hash, base.hash,
    'the same scene twice must fingerprint the same, or nothing below means anything');

  // 1. a caster leaves — the authored-vegetation swap
  const removed = build();
  removed.trees.children = [removed.trunk];
  assert.notEqual(shadowCasterFingerprint(removed.scene, { light: sun }).hash, base.hash);
  assert.equal(shadowCasterFingerprint(removed.scene, { light: sun }).casters, 1);

  // 2. a caster group is hidden — applyNature()
  const hidden = build();
  hidden.trees.visible = false;
  assert.notEqual(shadowCasterFingerprint(hidden.scene, { light: sun }).hash, base.hash);

  // 3. an instance count changes — refreshDetailInstances()
  const fewer = build();
  fewer.trunk.count = 880;
  assert.notEqual(shadowCasterFingerprint(fewer.scene, { light: sun }).hash, base.hash);

  // 4. a caster moves
  const moved = build();
  moved.crown.matrixWorld.elements[12] = 4;
  assert.notEqual(shadowCasterFingerprint(moved.scene, { light: sun }).hash, base.hash);

  // 5. the light moves, and so does its target and its frustum
  for (const mutate of [
    (s) => { s.position.x += 1; },
    (s) => { s.target.position.z += 1; },
    (s) => { s.shadow.camera.far = 1200; },
    (s) => { s.castShadow = false; },
  ]) {
    const light = fakeSun();
    mutate(light);
    assert.notEqual(shadowCasterFingerprint(world.scene, { light }).hash, base.hash);
  }

  // ...and the negative control. A NON-caster changing must NOT move the fingerprint, or the audit
  // would cry stale on every understory LOD flip and be turned off within the hour.
  const tuftMoved = build();
  tuftMoved.tuft.count = 12_000;
  tuftMoved.tuft.visible = false;
  assert.equal(shadowCasterFingerprint(tuftMoved.scene, { light: sun }).hash, base.hash);
});

test('the stale-shadow audit fires on a caster change nobody invalidated for, and only then', () => {
  const sun = fakeSun();
  const controller = createShadowController({ shadow: sun.shadow });
  const trunk = shadowNode({ id: 1, castShadow: true, count: 900 });
  const scene = shadowNode({ id: 0, children: [trunk] });
  const defects = [];
  const audit = createShadowCasterAudit({
    controller,
    fingerprint: () => shadowCasterFingerprint(scene, { light: sun }),
    onDefect: (defect) => defects.push(defect),
  });

  // The boot bake is owed; the audit waits for it rather than baselining a frame that has not drawn.
  assert.equal(audit.observe().state, 'pending');
  sun.shadow.needsUpdate = false;                 // three rendered the depth map
  assert.equal(audit.observe().state, 'baked');
  assert.equal(audit.observe().state, 'clean');
  assert.equal(defects.length, 0);

  // A caster mutation WITH its invalidation: declared, so not a defect.
  scene.children = [];
  controller.invalidate('procedural-vegetation');
  assert.equal(audit.observe().state, 'pending');
  sun.shadow.needsUpdate = false;
  assert.equal(audit.observe().state, 'baked');
  assert.equal(defects.length, 0, 'a declared change must never be reported');

  // The same mutation with the invalidation DROPPED — the bug this exists to catch.
  scene.children = [trunk];
  const verdict = audit.observe();
  assert.equal(verdict.state, 'stale');
  assert.equal(verdict.casterDelta, 1);
  assert.deepEqual(verdict.byKind, { 'trunk-batch': 1 }, 'a defect names the kind, never just a count');
  assert.equal(defects.length, 1);
  assert.equal(audit.stats().defects, 1);
  assert.equal(audit.stats().firstDefect.lastInvalidation.reason, 'procedural-vegetation',
    'the audit names the last invalidation, so the missing one can be placed in the sequence');
});

test('REGRESSION: an invalidate-and-bake inside one frame is not reported as a defect', () => {
  // The audit's first headless run called the Fortress attach stale. The attach HAD invalidated;
  // the depth map was re-baked before the next rAF tick (this scene renders at ~0.3 fps under
  // SwiftShader), so a sampler watching `pending` never saw the window. It watches the invalidation
  // SEQUENCE instead, which a slow sampler cannot miss. This is that case, at tick resolution.
  const sun = fakeSun();
  const controller = createShadowController({ shadow: sun.shadow });
  const scene = shadowNode({ id: 0, children: [shadowNode({ id: 1, castShadow: true })] });
  const defects = [];
  const audit = createShadowCasterAudit({
    controller,
    fingerprint: () => shadowCasterFingerprint(scene, { light: sun }),
    onDefect: (d) => defects.push(d),
  });
  sun.shadow.needsUpdate = false;
  assert.equal(audit.observe().state, 'baked');

  // One tick's worth of app activity: a caster attaches, its invalidation fires, three bakes — all
  // between two observations, so `pending` is false again by the time the audit looks.
  scene.children = [...scene.children, shadowNode({ id: 2, castShadow: true })];
  controller.invalidate('authored-asset-attach');
  sun.shadow.needsUpdate = false;
  assert.equal(audit.observe().state, 'baked', 'a declared change must re-baseline, not report');
  assert.equal(defects.length, 0);
  assert.equal(audit.observe().state, 'clean');

  // ...and the discriminating half: the identical mutation with no invalidation still fires.
  scene.children = [...scene.children, shadowNode({ id: 3, castShadow: true })];
  assert.equal(audit.observe().state, 'stale');
  assert.equal(defects.length, 1);
});

test('the audit refuses to claim anything while three is rendering the depth map every frame', () => {
  const sun = fakeSun();
  const controller = createShadowController({ shadow: sun.shadow, live: true });
  const scene = shadowNode({ id: 0, children: [shadowNode({ id: 1, castShadow: true })] });
  const audit = createShadowCasterAudit({
    controller,
    fingerprint: () => shadowCasterFingerprint(scene, { light: sun }),
  });
  assert.equal(audit.observe().state, 'live');
  scene.children = [];
  assert.equal(audit.observe().state, 'live');
  assert.equal(audit.stats().defects, 0);
});

test('the authored streamer separates a SCENE GRAPH change from a status publish', async () => {
  // The distinction the frozen shadow map lives on. `onChanged` fires on every camera pass, and
  // re-baking a 2048² depth map on every pass is most of the cost the freeze removes. Only an
  // attach or a detach is a caster change, because only those write `castShadow`.
  const root = new THREE.Group();
  const status = {};
  const changed = [];
  const casters = [];
  const streamer = createAuthoredAssetStreamer({
    root,
    status,
    guard: createAsyncAttachGuard(),
    manifestInput: oneCellAuthoredManifest(),
    baseHref: 'http://localhost/',
    displayYFor: (_x, _z, y) => y,
    loadAsset: async () => ({ scene: new THREE.Group() }),
    syncSuppression: (entries) => ({ applied: entries.map((entry) => entry.featureId), retained: [] }),
    onChanged: () => changed.push('changed'),
    onCastersChanged: (kind) => casters.push(kind),
  });

  await streamer.update({ x: 0, z: 0 });
  assert.equal(root.children.length, 1);
  assert.deepEqual(casters, ['attach'], 'exactly one caster change for one attached asset');
  const changedAfterAttach = changed.length;

  // A camera move that changes nothing in the graph. `onChanged` fires (the frame is invalidated,
  // which is right); `onCastersChanged` must NOT.
  await streamer.update({ x: 1, z: 1 });
  assert.ok(changed.length > changedAfterAttach, 'the frame is still invalidated on a camera pass');
  assert.deepEqual(casters, ['attach'], 'a camera pass that moved no geometry must not re-bake the shadow map');

  // Leaving the draw distance detaches — a real caster change again.
  await streamer.update({ x: 75, z: 0 });
  assert.equal(root.children.length, 0);
  assert.deepEqual(casters, ['attach', 'detach']);
  streamer.dispose();
});

test('the suppression key skips an unchanged set and CANNOT skip a changed one', () => {
  /*
   * THE FIX FOR THE BUG THAT MADE P1 NEARLY WORTHLESS.
   *
   * `publishState()` runs on every streamer pass — before its own empty-diff early return — and
   * every camera event runs a pass, so `syncProceduralSuppression()` was re-running the whole
   * suppression pass on every frame of a drag and calling
   * `sunShadow.invalidate('procedural-suppression')` each time. Since this app renders ON DEMAND,
   * frame time only exists while the camera is moving: the freeze was being lifted in exactly the
   * regime it was bought for, and no A/B could see it (`runPreset()` samples with the camera
   * parked). Measured on the shipped tree before the gate: six `tz.flyTo` calls, +14 invalidations.
   *
   * The dangerous direction is the FALSE SKIP — comparing equal for two sets that differ would
   * leave a procedural proxy standing under its authored replacement forever. Each property below
   * is one way that could happen.
   */
  const entry = (featureId, kind = 'building', policy = 'hide-mesh') => ({ featureId, kind, policy });

  // 1. The same set, twice, is the same key. This is the whole optimisation.
  assert.equal(
    proceduralSuppressionKey([entry('a'), entry('b')]),
    proceduralSuppressionKey([entry('a'), entry('b')]),
  );
  // 2. ...and order is not a change. The ledger's iteration order is not a promise.
  assert.equal(
    proceduralSuppressionKey([entry('a'), entry('b')]),
    proceduralSuppressionKey([entry('b'), entry('a')]),
  );
  // 3. A feature ENTERING the set must not skip.
  assert.notEqual(
    proceduralSuppressionKey([entry('a')]),
    proceduralSuppressionKey([entry('a'), entry('b')]),
  );
  // 4. A feature LEAVING the set must not skip — this is the direction that resurrects a proxy.
  assert.notEqual(
    proceduralSuppressionKey([entry('a'), entry('b')]),
    proceduralSuppressionKey([entry('b')]),
  );
  // 5. The SAME id under a different policy is a different suppression.
  assert.notEqual(
    proceduralSuppressionKey([entry('a', 'building', 'hide-mesh')]),
    proceduralSuppressionKey([entry('a', 'building', 'hide-mesh-and-picking')]),
  );
  // 6. ...and under a different kind. `syncProceduralSuppression` branches on `kind`, so a
  //    prop-turned-building would be routed differently while the key compared equal.
  assert.notEqual(
    proceduralSuppressionKey([entry('a', 'building')]),
    proceduralSuppressionKey([entry('a', 'prop')]),
  );
  // 7. Field boundaries cannot be forged. Without this, `{id:'a|b', kind:'c'}` and
  //    `{id:'a', kind:'b|c'}` would join into one identical string and two different sets would
  //    silently share a key.
  assert.notEqual(
    proceduralSuppressionKey([{ featureId: 'a|building', kind: 'x', policy: 'p' }]),
    proceduralSuppressionKey([{ featureId: 'a', kind: 'building|x', policy: 'p' }]),
  );
  // 8. The empty set has a key of its own and is not confusable with "nothing applied yet"
  //    (`null`), which is what `rebuildWorld()` resets to.
  assert.equal(proceduralSuppressionKey([]), '');
  assert.notEqual(proceduralSuppressionKey([]), null);
});

test('the suppression pass is gated on the key, and a world rebuild clears it', async () => {
  // The gate itself lives in the renderer closure and cannot be imported, so its two load-bearing
  // lines are pinned where they are spelled. The DANGEROUS one is the reset: without it, the first
  // ledger publish after `rebuildWorld()` compares equal against a set applied to a scene graph that
  // has since been disposed, and declines to re-hide the new proxies — an authored replacement with
  // its procedural twin visible through it, permanently.
  const renderer = await readFile(new URL('../src/map3d-three.js', import.meta.url), 'utf8');
  const bodyOf = (name) => {
    const match = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`).exec(renderer);
    assert.ok(match, `${name}() must exist`);
    return match[0];
  };
  assert.match(
    bodyOf('syncProceduralSuppression'),
    /const key = proceduralSuppressionKey\(entries\);\s*\n\s*if \(key === appliedProceduralSuppressionKey\) return proceduralSuppressionResult;/,
    'an unchanged suppression set must not re-run the pass or re-bake the depth map',
  );
  assert.match(bodyOf('rebuildWorld'), /appliedProceduralSuppressionKey = null;/,
    'a world rebuild disposes every suppressed node, so the applied key describes a graph that is gone');
  // A skipped pass must publish the SAME answer as the pass it skipped, not an empty one — a status
  // field that goes blank whenever nothing changed is worse than the cost it saves.
  assert.match(bodyOf('syncProceduralSuppression'), /proceduralSuppressionResult = Object\.freeze\(\{/);
});

test('every invalidation point named in the enum is wired, at the site that owns the mutation', async () => {
  // THE INVALIDATION LIST IS THE DELIVERABLE. A dropped `sunShadow.invalidate(...)` is a silent
  // stale shadow that no count can see (handoff §7), so each one is pinned to the function whose
  // mutation it declares. Delete one and this goes red naming it.
  const renderer = await readFile(new URL('../src/map3d-three.js', import.meta.url), 'utf8');
  const bodyOf = (name) => {
    const match = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`).exec(renderer);
    assert.ok(match, `${name}() must exist`);
    return match[0];
  };
  const expected = [
    ['rebuildWorld', 'world-build'],
    ['applyProceduralSuppression', 'procedural-suppression'],
    ['applyNature', 'nature-visibility'],
    ['applyLook', 'look'],
    ['rebuildProceduralVegetation', 'procedural-vegetation'],
    ['mountAuthoredVegetation', 'authored-vegetation-mount'],
    ['repackAuthoredVegetationNow', 'authored-vegetation-repack'],
  ];
  for (const [fn, reason] of expected) {
    assert.match(bodyOf(fn), new RegExp(`sunShadow\\.invalidate\\('${reason}'\\)`),
      `${fn}() must invalidate the shadow map with reason '${reason}'`);
  }
  // The two streaming reasons are wired through the streamer's own callback rather than a function
  // body, so they are pinned where they are actually spelled.
  // Mapped through a table, not a ternary: an unrecognised kind must reach the closed enum's throw
  // instead of being absorbed into 'attach' by an else branch, which would quietly mislabel the
  // `byReason` ledger the audit prints when it reports a defect.
  assert.match(renderer, /onCastersChanged: \(kind\) => sunShadow\.invalidate\(AUTHORED_ASSET_SHADOW_REASON\[kind\] \?\? kind\)/);
  assert.match(renderer, /const AUTHORED_ASSET_SHADOW_REASON = Object\.freeze\(\{\s*\n\s*attach: 'authored-asset-attach',\s*\n\s*detach: 'authored-asset-detach',\s*\n\s*\}\);/);

  // Nothing may invent a reason: every string handed to invalidate() is in the closed enum.
  const used = [...renderer.matchAll(/sunShadow\.invalidate\('([a-z-]+)'\)/g)].map((m) => m[1]);
  const spelled = [...renderer.matchAll(/'(authored-asset-(?:attach|detach))'/g)].map((m) => m[1]);
  for (const reason of new Set([...used, ...spelled])) {
    assert.ok(SHADOW_INVALIDATION_REASONS.includes(reason), `${reason} is not a declared reason`);
  }

  /*
   * ...AND THE REVERSE, which is the half that was missing.
   *
   * A closed enum's whole value is that its membership IS the coverage claim, so a member with no
   * call site claims coverage that does not exist — and the forward check above cannot see it, by
   * construction. `sun` was exactly that: declared, never invoked, and the one function that moves
   * the light files its invalidation under `look`, so `byReason` could never attribute anything to
   * it. Reserving a name is legitimate; it now costs a line HERE, which is the point.
   */
  const RESERVED_UNUSED_REASONS = new Set([
    // Nothing moves the sun, its target or the shadow camera today. The name is kept so that the
    // day something does, it does not get filed under a neighbouring reason.
    'sun',
  ]);
  const declared = new Set([...used, ...spelled]);
  for (const reason of SHADOW_INVALIDATION_REASONS) {
    if (RESERVED_UNUSED_REASONS.has(reason)) {
      assert.ok(!declared.has(reason), `'${reason}' is now invoked — take it out of RESERVED_UNUSED_REASONS`);
      continue;
    }
    assert.ok(declared.has(reason),
      `'${reason}' is declared in the enum but no call site invokes it; either wire it or add it to`
      + ' RESERVED_UNUSED_REASONS with a reason');
  }

  // The repack's invalidation is CONDITIONAL on the policy the RUNTIME actually normalised, not on
  // the module default and not on a comment. The module constant is only the default the runtime
  // falls back to; a caller can pass a `shadowPolicy` the renderer's gate would never see, and a
  // gate reading the constant would then be false while lod-0 buckets cast and changed every 4 m.
  assert.match(
    renderer,
    /const AUTHORED_VEGETATION_CASTS_SHADOWS = CUSTOMS_AUTHORED_VEGETATION_SHADOW_POLICY\.mode !== 'disabled';/,
  );
  assert.match(bodyOf('repackAuthoredVegetationNow'), /if \(authoredVegetationCastsShadows\) sunShadow\.invalidate/);
  assert.match(renderer, /authoredVegetationCastsShadows = effectiveVegetationShadowMode !== 'disabled';/,
    'the repack gate must be set from the constructed runtime, not from the module default');
  assert.match(renderer, /runtime\.status\.shadowPolicy\?\.mode/,
    'the effective policy has to be READ off the runtime for the gate to mean anything');
});

test('the profiler ablation declares its caster mutation — propGroup/rockGroup are casters', async () => {
  /*
   * THE ONE UNCOVERED CASTER MUTATION AN ADVERSARIAL PASS FOUND, and it is not in the streaming or
   * LOD lanes. `applyAblation()` sets `propGroup.visible = false` / `rockGroup.visible = false`;
   * both are caster groups; frozen, the depth map then keeps the shadows of geometry that is no
   * longer drawn. It is reachable on the shipped bundle (`?profile=1` is gated on `profileRequest`
   * alone, deliberately), so `?profileAblate=props` produced prop shadows on ground with no props —
   * the literal signature the stale-arm control in the P1 verification produced and called proof.
   *
   * Pinned as a PROPERTY of the branch, not as the presence of a string: every `.visible = false`
   * inside applyAblation must be followed by an invalidation before that branch ends.
   */
  const renderer = await readFile(new URL('../src/map3d-three.js', import.meta.url), 'utf8');
  const match = /function applyAblation\(ablation\) \{[\s\S]*?\n    \}/.exec(renderer);
  assert.ok(match, 'applyAblation() must exist');
  // Comments stripped — this is an assertion about what the CODE does, and a doc block explaining
  // the invalidation must not be able to satisfy an assertion that the invalidation is there.
  const body = match[0].replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // THE PREMISE, CHECKED RATHER THAN ASSUMED, so this test cannot outlive the reason it exists.
  // If props and rocks ever stop casting, this goes red and the invalidation below can be dropped
  // on purpose instead of being carried by habit.
  const propAssets = await readFile(new URL('../src/three-prop-assets.js', import.meta.url), 'utf8');
  assert.match(propAssets, /castShadow = true/, 'props are casters — three-prop-assets.js sets it');
  assert.match(renderer, /mesh\.castShadow = mesh\.receiveShadow = true;\n\s*rockGroup\.add\(mesh\);/,
    'rocks are casters — rockGroup is populated with castShadow meshes');

  const hides = [...body.matchAll(/\.visible = false;/g)];
  assert.ok(hides.length > 0, 'applyAblation no longer hides a group — this assertion has rotted');
  for (const hide of hides) {
    const after = body.slice(hide.index, hide.index + 500);
    assert.match(after, /sunShadow\.invalidate\('profiler-ablation'\)/,
      'a group hidden by the ablation must declare the caster change, or the frozen map keeps its shadows');
  }
  // The RESTORE edge too: putting the geometry back changes the caster set exactly as much as
  // taking it away did, and a restored arm drawn against a map baked while it was hidden is the
  // same defect with the sign flipped.
  assert.match(body, /restorers\.push\(\(\) => \{\s*group\.visible = before;\s*sunShadow\.invalidate\('profiler-ablation'\);/);
});

test('the frame loop and the 1 Hz dynamic refresh create no shadow casters', async () => {
  // Why they are NOT on the invalidation list, checked rather than asserted. `refreshDynamicNow()`
  // runs on the live-player tick and `updateUnderstoryLod()` runs on every rendered frame;
  // invalidating from either would hand most of the win back. Both are safe only for as long as
  // nothing they build casts, so that is the thing pinned.
  const renderer = await readFile(new URL('../src/map3d-three.js', import.meta.url), 'utf8');
  const bodyOf = (name) => {
    const match = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`).exec(renderer);
    assert.ok(match, `${name}() must exist`);
    return match[0];
  };
  const dynamic = bodyOf('refreshDynamicNow');
  assert.doesNotMatch(dynamic, /castShadow/,
    'a quest pin or player cone that cast a shadow would need refreshDynamic() on the invalidation list');
  assert.doesNotMatch(bodyOf('updateUnderstoryLod'), /castShadow/);
  assert.match(bodyOf('addUnderstory'), /near\.castShadow = medium\.castShadow = false;/);
  // ...and the understory tufts the LOD switch toggles are declared non-casters at construction.

  /*
   * THE PREMISE THE KEYWORD GREP RESTS ON, ASSERTED — because a grep for `castShadow` in one
   * function body is exactly the "a count cannot detect presence" shape one level up: a quest pin
   * built through a HELPER that sets the flag itself walks straight past it. Two halves:
   *
   *  1. Non-casting is three's default, not something these lines achieve. If a future three ever
   *     flipped it, dynamicRoot would start casting at 1 Hz with every assertion here still green.
   *  2. `refreshDynamicNow` builds its meshes INLINE (`new THREE.Mesh(...)`) and calls none of the
   *     asset builders that do set the flag. That is what makes (1) sufficient.
   */
  assert.equal(new THREE.Mesh().castShadow, false,
    'this whole test assumes three defaults castShadow to false; it does not any more');
  assert.equal(new THREE.Object3D().castShadow, false);
  for (const helper of ['buildPropAsset', 'buildOpenFrameBuildingAsset', 'buildSolidWallNode', 'addMesh']) {
    assert.ok(!dynamic.includes(helper),
      `refreshDynamicNow() calls ${helper}(), which can set castShadow itself — the grep above cannot`
      + ' see that, so either declare a reason for the 1 Hz rebuild or keep the helper out');
  }
  assert.match(dynamic, /new THREE\.Mesh\(/, 'it builds meshes inline; if it stopped, re-derive this test');
});

test('the shipped renderer never writes shadow.autoUpdate itself — the controller owns it', async () => {
  // `src/shadow-invalidation.js` is the single writer on the shipped path. The profiler's ablation
  // is the only other writer in the codebase and it lives inside `createRenderProfiler()`, which is
  // built only when `?profile=` armed the run — pinned separately by render-profiler.test.mjs.
  const [renderer, module_] = await Promise.all([
    readFile(new URL('../src/map3d-three.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/shadow-invalidation.js', import.meta.url), 'utf8'),
  ]);
  // Comments stripped: this is an assertion about what the CODE does, and a doc comment naming the
  // flag is exactly the thing that must stay legal.
  const code = renderer.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const profilerStart = code.indexOf('function createRenderProfiler()');
  assert.ok(profilerStart > 0);
  const writes = [...code.matchAll(/\.autoUpdate\s*=/g)].map((m) => m.index);
  assert.ok(writes.length > 0, 'the profiler ablation still writes it, so a zero here means the regex rotted');
  for (const at of writes) {
    assert.ok(at > profilerStart, `an autoUpdate write at ${at} is on the shipped path`);
  }

  /*
   * ...AND `needsUpdate`, WHICH IS THE FLAG THAT ACTUALLY DECIDES WHETHER A BAKE HAPPENS.
   *
   * `autoUpdate` only decides whether it happens unconditionally. The test's name claimed ownership
   * of the pair and checked one of them, so a shipped-path `sun.shadow.needsUpdate = false` — the
   * single most damaging line anyone could add to this subsystem, a permanent silent freeze — went
   * straight through green. Only `shadow.`-qualified writes count: `instanceMatrix.needsUpdate` and
   * the attribute flags are a different thing entirely and are legal everywhere.
   */
  const shadowFlagWrites = [...code.matchAll(/shadow\.needsUpdate\s*=/g)].map((m) => m.index);
  for (const at of shadowFlagWrites) {
    assert.ok(at > profilerStart,
      `a shadow.needsUpdate write at ${at} is on the shipped path — only the controller may lower it`);
  }
  assert.match(module_, /export function createShadowController\(/);
  assert.match(module_, /shadow\.autoUpdate = !frozen;/);
  assert.match(module_, /shadow\.needsUpdate = true;/);
});

test('the shadow controller refuses to settle over an invalidation it did not see', () => {
  /*
   * `armAblation()` has to arm a bake, wait a frame, and then lower the flag. Writing
   * `sun.shadow.needsUpdate = false` to do that DISCARDS anything the app declared inside the
   * awaited frame — and the discard is self-certifying: the audit sees `sequence` has moved,
   * re-baselines, and files the post-mutation fingerprint as `baked`. So the operation is
   * conditional, and this is the condition.
   */
  const sun = fakeSun();
  const controller = createShadowController({ shadow: sun.shadow });
  sun.shadow.needsUpdate = false;

  // Nothing happened in between: the settle is allowed.
  controller.invalidate('profiler-ablation');
  const quiet = controller.sequence;
  assert.equal(controller.settle(quiet), true);
  assert.equal(sun.shadow.needsUpdate, false);

  // An invalidation lands inside the awaited frame: the bake is OWED and must survive.
  const atArm = controller.sequence;
  controller.invalidate('authored-vegetation-mount');
  assert.equal(controller.settle(atArm), false, 'a bake the app asked for must not be cancelled');
  assert.equal(sun.shadow.needsUpdate, true, 'the flag stays raised — this is the whole point');

  // setLive routes the other flag through the same owner.
  assert.equal(controller.setLive(true), true);
  assert.equal(sun.shadow.autoUpdate, true);
  assert.equal(controller.live, true);
  controller.setLive(false);
  assert.equal(sun.shadow.autoUpdate, false);
});

test('a restored GPU context re-bakes the depth map — the one stale path no fingerprint can see', async () => {
  /*
   * A context/device loss reallocates the depth texture EMPTY without touching a single caster. Live,
   * three re-renders it next frame. Frozen, nothing ever does: the scene loses all sun shadows for
   * the rest of the session while `shadowCasterFingerprint` stays bit-identical and the audit
   * reports `clean` forever. It is a permanent silent regression the freeze itself introduces, so
   * the freeze carries the handler.
   */
  const sun = fakeSun();
  const controller = createShadowController({ shadow: sun.shadow });
  sun.shadow.needsUpdate = false;
  assert.equal(controller.pending, false);
  controller.invalidate('renderer-context-restored');
  assert.equal(controller.pending, true, 'the reason must actually arm a bake');
  assert.deepEqual(controller.stats().byReason, { 'renderer-context-restored': 1 });

  // ...and it is wired to both backends' loss signals, not merely declared.
  const renderer = await readFile(new URL('../src/map3d-three.js', import.meta.url), 'utf8');
  assert.match(renderer, /addEventListener\?\.\('webglcontextrestored', invalidateShadowOnContextRestore\)/);
  assert.match(renderer, /renderer\.backend\?\.device\?\.lost\?\.then\?\.\(/,
    'WebGPU has no webglcontextrestored; the device.lost promise is its equivalent');
  assert.match(renderer, /sunShadow\.invalidate\('renderer-context-restored'\)/);
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

test('the overlay scope is the only thing that filters an overlay, now the floor filter is gone', async () => {
  // The PROOF-OF-CONCEPT box is still here, and still behaves as it always did — but as of
  // 2026-09-03 it gates the RAILWAY MESH ONLY. Overlays are gated by `withinOverlayScope()`
  // against `overlayScopeFromLimit(data.limit)`; the tests below prove the difference.
  assert.equal(THREE_POC_SCOPE.id, 'customs-industrial-rail-yard');
  assert.equal(withinScope({ x: 230, z: -110 }), true);
  assert.equal(withinScope({ x: 600, z: -110 }), false);
  // `visibleForFloor(level, floor)` hid every underground marker, label and quest zone unless the
  // rail sat on "U" — which meant the UNDERGROUND badge could not be seen on the default view at
  // all. The rail went out 2026-09-02; the level VOCABULARY stays (it is what icons.js draws the
  // dashed outline and the corner chip from), but nothing filters on it any more.
  const world = await import('../src/three-world.js');
  assert.equal(world.visibleForFloor, undefined, 'the floor visibility predicate must be gone');
  const runtime = await import('../src/customs-asset-runtime.js');
  assert.equal(runtime.customsAssetVisibleForFloor, undefined,
    'the authored floor-tag predicate must be gone');
  const surfaces = await import('../src/surfaces.js');
  assert.equal(surfaces.visibleBuildingHeight, undefined,
    'the selector wall-height function must be gone');

  // KEEP LIST. The marker vocabulary the selector used to filter on is ICON semantics and survives
  // intact: an underground marker still draws the dashed extract outline, the bottom-right corner
  // chip with its down/stairs arrow, and the level class the sidebar styles from. This is how a
  // player knows a stash is in a basement now that nothing hides it.
  const { iconHtml } = await import('../src/icons.js');
  const underground = iconHtml('extract-pmc', 24, 'D', 'underground');
  const surface = iconHtml('extract-pmc', 24, 'D', 'surface');
  assert.match(underground, /class="mk sq level-underground"/);
  assert.match(underground, /stroke-dasharray/, 'the dashed underground outline is gone');
  assert.match(underground, /#FFD28A/, 'the underground corner chip is gone');
  assert.doesNotMatch(surface, /stroke-dasharray/, 'a surface marker must not be dashed');
  assert.doesNotMatch(surface, /#FFD28A/, 'a surface marker must not carry the underground chip');
});

/*
 * OVERLAY SCOPE — the 2026-09-03 fix.
 *
 * Every DOM overlay in the Three renderer (place labels, POI markers, EXTRACTS, quest zones,
 * quest points, tactical prop callouts) was gated on `THREE_POC_SCOPE`: a 360x300 m cell centred
 * on (230, -110), accepting x in [50, 410] and z in [-260, 40]. The map is 1024x541 m. The gate
 * therefore covered ~19% of the ground the terrain, the buildings, the vegetation and the camera
 * all already drew, and the founder saw exactly that: "all points/icons are in the middle, and
 * extracts; some extracts are not even showing up."
 *
 * These tests are written against the REAL shipped data, not fixtures, and the counts are computed
 * from the files rather than hardcoded — but the assertions are absolute (zero dropped), because a
 * count recomputed from the same source it is asserting against cannot fail on its own.
 */
const overlayScopeFixture = () => overlayScopeFromLimit(customs3d.limit);
const extractPoints = () => customs.extracts.map((extract) => ({
  name: String(extract.name ?? extract.id),
  x: Number(extract.position.x),
  z: Number(extract.position.z),
}));

test('the overlay scope is derived from the playable limit and carries its provenance', () => {
  const scope = overlayScopeFixture();
  const xs = customs3d.limit.map((point) => Number(point[0]));
  const zs = customs3d.limit.map((point) => Number(point[1]));
  assert.equal(scope.source, 'limit-bbox', 'the scope must say where it came from');
  assert.equal(scope.marginM, OVERLAY_SCOPE_MARGIN_M);
  close(scope.minX, Math.min(...xs) - OVERLAY_SCOPE_MARGIN_M, 1e-9);
  close(scope.maxX, Math.max(...xs) + OVERLAY_SCOPE_MARGIN_M, 1e-9);
  close(scope.minZ, Math.min(...zs) - OVERLAY_SCOPE_MARGIN_M, 1e-9);
  close(scope.maxZ, Math.max(...zs) + OVERLAY_SCOPE_MARGIN_M, 1e-9);
  assert.ok(Object.isFrozen(scope), 'the scope must be frozen — nothing may widen it at runtime');
  // Not a hollow tautology: this is the bbox of the SHIPPED limit ring, and it is the same ring
  // `groundExtent` clamps the camera to. If the data changes under us, these move together.
  close(scope.maxX - scope.minX, 1023.9 + 2 * OVERLAY_SCOPE_MARGIN_M, 1e-6);
  close(scope.maxZ - scope.minZ, 541.4 + 2 * OVERLAY_SCOPE_MARGIN_M, 1e-6);
});

test('every shipped Customs extract passes the overlay scope', () => {
  const scope = overlayScopeFixture();
  const extracts = extractPoints();
  assert.ok(extracts.length >= 30, `expected the full extract set, read ${extracts.length}`);
  const dropped = extracts.filter((point) => !withinOverlayScope([point.x, point.z], scope));
  assert.deepEqual(
    dropped.map((point) => `${point.name} (${point.x}, ${point.z})`),
    [],
    `${dropped.length} of ${extracts.length} extracts are gated out of the Three overlay`,
  );
  // And by the object form the marker path actually passes.
  const droppedObjects = extracts.filter((point) => !withinOverlayScope(point, scope));
  assert.equal(droppedObjects.length, 0, 'the {x,z} input shape must gate identically to [x,z]');
});

test('every shipped Customs place label passes the overlay scope', () => {
  const scope = overlayScopeFixture();
  assert.ok(CUSTOMS_LABELS.length >= 30, `expected the full label set, read ${CUSTOMS_LABELS.length}`);
  const dropped = CUSTOMS_LABELS.filter((label) => !withinOverlayScope(label.position, scope));
  assert.deepEqual(
    dropped.map((label) => `${label.text} (${label.position.join(', ')})`),
    [],
    `${dropped.length} of ${CUSTOMS_LABELS.length} place labels are gated out of the Three overlay`,
  );
});

test('DISCRIMINATION: the old proof-of-concept box drops most of what the new scope admits', () => {
  // If this test can pass with the OLD gate still wired to the overlays, the two tests above prove
  // nothing. It measures the gap, states it, and fails if the gap ever closes to nothing.
  const scope = overlayScopeFixture();
  const extracts = extractPoints();

  const extractsOld = extracts.filter((point) => withinScope([point.x, point.z])).length;
  const extractsNew = extracts.filter((point) => withinOverlayScope([point.x, point.z], scope)).length;
  const labelsOld = CUSTOMS_LABELS.filter((label) => withinScope(label.position)).length;
  const labelsNew = CUSTOMS_LABELS.filter((label) => withinOverlayScope(label.position, scope)).length;
  const measured = `extracts old=${extractsOld}/${extracts.length} new=${extractsNew}/${extracts.length}; `
    + `labels old=${labelsOld}/${CUSTOMS_LABELS.length} new=${labelsNew}/${CUSTOMS_LABELS.length}`;

  assert.equal(extractsNew, extracts.length, `new gate must admit every extract — ${measured}`);
  assert.equal(labelsNew, CUSTOMS_LABELS.length, `new gate must admit every label — ${measured}`);
  assert.ok(
    extracts.length - extractsOld >= 20,
    `THE OLD GATE MUST BE MEASURABLY WORSE, else these assertions are vacuous — ${measured}`,
  );
  assert.ok(
    CUSTOMS_LABELS.length - labelsOld >= 15,
    `THE OLD GATE MUST BE MEASURABLY WORSE, else these assertions are vacuous — ${measured}`,
  );
  // The three extracts that sit outside the CONCAVE limit polygon, and are the reason the fix is a
  // padded bbox and not `inRing(point, limit)`. Named so a future polygon rewrite fails here.
  for (const name of ['Administration Gate', 'Railroad Passage (Flare)', 'Transit to Shoreline']) {
    const point = extracts.find((candidate) => candidate.name === name);
    assert.ok(point, `${name} is missing from public/data/customs.json`);
    assert.equal(withinOverlayScope([point.x, point.z], scope), true,
      `${name} must draw: it is outside the limit ring, which is why the margin exists`);
    assert.equal(inRing([point.x, point.z], customs3d.limit), false,
      `${name} is inside the limit ring now — re-derive the margin rationale before trusting it`);
  }
});

test('the overlay scope still discriminates, and a missing limit fails loudly', () => {
  const scope = overlayScopeFixture();
  // Far-field garbage must not draw. A gate that admits everything is not a gate.
  assert.equal(withinOverlayScope([5000, 5000], scope), false);
  assert.equal(withinOverlayScope({ x: -5000, z: 0 }, scope), false);
  assert.equal(withinOverlayScope([0, -5000], scope), false);
  assert.equal(withinOverlayScope([Number.NaN, 0], scope), false, 'NaN must not be read as 0');
  assert.equal(withinOverlayScope(null, scope), false);
  // Just inside and just outside each edge.
  assert.equal(withinOverlayScope([scope.minX + 0.001, scope.minZ + 0.001], scope), true);
  assert.equal(withinOverlayScope([scope.maxX - 0.001, scope.maxZ - 0.001], scope), true);
  assert.equal(withinOverlayScope([scope.minX - 0.001, 0], scope), false);
  assert.equal(withinOverlayScope([0, scope.maxZ + 0.001], scope), false);

  // NO SILENT FALLBACK (handoff §7). A missing or corrupt limit must throw, never quietly hand back
  // a box — a fallback box is precisely the failure this whole fix is undoing.
  assert.throws(() => overlayScopeFromLimit([]), TypeError);
  assert.throws(() => overlayScopeFromLimit(null), TypeError);
  assert.throws(() => overlayScopeFromLimit(undefined), TypeError);
  assert.throws(() => overlayScopeFromLimit([[0, 0], [Number.NaN, 10]]), TypeError);
  assert.throws(() => overlayScopeFromLimit([[0, 0], [10, Number.POSITIVE_INFINITY]]), TypeError);
  assert.throws(() => overlayScopeFromLimit([[0, 0], ['left', 'right']]), TypeError);
  assert.throws(() => overlayScopeFromLimit(customs3d.limit, Number.NaN), TypeError);
  assert.throws(() => overlayScopeFromLimit(customs3d.limit, -1), TypeError);
  assert.throws(() => withinOverlayScope([0, 0], null), TypeError);
  assert.throws(() => withinOverlayScope([0, 0], { minX: 0, maxX: Number.NaN, minZ: 0, maxZ: 1 }), TypeError);
});

test('the renderer gates overlays on the limit-derived scope, not the proof-of-concept box', async () => {
  const renderer = await readFile(new URL('../src/map3d-three.js', import.meta.url), 'utf8');
  assert.match(renderer, /const overlayScope = overlayScopeFromLimit\(data\.limit\)/,
    'the overlay scope must be derived once, from the map data');
  assert.doesNotMatch(renderer, /withinScope\(/,
    'no overlay may be gated on THREE_POC_SCOPE again — use withinOverlayScope(point, overlayScope)');
  // The remaining four overlay call sites. There were five as of this test's original writing;
  // the fifth — `!withinOverlayScope(prop, overlayScope)`, the TACTICAL_PROP_CALLOUTS prop lookup
  // — was deleted whole on 2026-09-03 along with the RED CONTAINER / TRAIN chips it gated
  // (founder: "idk why they show up"), not re-pointed at a different gate.
  for (const site of [
    /withinOverlayScope\(\[x, z\], overlayScope\)/,
    /!withinOverlayScope\(\[spec\.x, spec\.z\], overlayScope\)/,
    /withinOverlayScope\(point, overlayScope\)/,
    /!withinOverlayScope\(pos, overlayScope\)/,
  ]) assert.match(renderer, site, `an overlay call site is not on the new gate: ${site}`);
  // The stat must not be able to lie about what is drawn: it reported `THREE_POC_SCOPE.id` while
  // the renderer drew the whole map and clipped 24 of 32 extracts.
  assert.doesNotMatch(renderer, /scope: THREE_POC_SCOPE\.id/,
    'renderStats() must not name the proof-of-concept cell as the scope it drew');
  assert.match(renderer, /scope: `customs-overlay-\$\{overlayScope\.source\}`/);
  assert.match(renderer, /overlayScope: \{ \.\.\.overlayScope \}/);
  assert.match(renderer, /railwayGeometryScope: THREE_POC_SCOPE/,
    'the railway cell must still be reported, separately and by its own name');
  // Item 3 of the fix brief: the railway geometry gate is deliberately UNCHANGED.
  assert.match(renderer, /railwayTrackMeshData\(data\.railway, railSurfaceY, THREE_POC_SCOPE\)/);
});

test('the RED CONTAINER / TRAIN tactical prop callouts are gone (founder: "idk why they show up")', async () => {
  // 2026-09-03: the only two `kind: landmark` overlay chips on Customs were the RED CONTAINER and
  // TRAIN labels, floated above the rail-yard container stack and locomotive props by a lookup
  // table read in refreshDynamic(). The founder called them noise, not landmarks. The props
  // themselves still draw as 3D geometry — only the always-on text chip is removed. Asserted on
  // the concrete declaration/usage forms (not a bare identifier) so this test cannot be tripped by
  // a prose comment that merely mentions the removed feature.
  const renderer = await readFile(new URL('../src/map3d-three.js', import.meta.url), 'utf8');
  assert.doesNotMatch(renderer, /const TACTICAL_PROP_CALLOUTS = Object\.freeze/,
    'the tactical prop callout table must not be declared in the Three renderer');
  assert.doesNotMatch(renderer, /for \(const callout of TACTICAL_PROP_CALLOUTS\)/,
    'refreshDynamic() must not loop over a tactical prop callout table');
  assert.doesNotMatch(renderer, /label: 'RED CONTAINER'/);
  assert.doesNotMatch(renderer, /label: 'TRAIN'/);
  assert.doesNotMatch(renderer, /kind: 'landmark'/,
    'no overlay item may be built with kind: landmark — that kind existed only for these two chips');
});

/*
 * THE MARKER BADGES — the 2026-09-03 fix.
 *
 * `makeOverlayItem()` did `element.textContent = safeText(label)` and nothing else, so the Three
 * renderer — the DEFAULT for Customs — never called the icon system at all. Every one of ~200
 * markers was an identical dark text pill, and the live view was roughly a hundred chips reading
 * "BURIED BARREL CACHE" stacked on each other with the extracts lost inside them.
 *
 * These assertions are written against a REAL DOM (scripts/lib/fake-dom.mjs) rather than against
 * the source text, because handoff §7 is explicit that a count is not evidence: counting overlay
 * nodes could not tell a badge from a text pill, which is exactly how the defect survived. What is
 * asserted is the markup that lands in the element and the text that does or does not come with it.
 * `fake-dom` STORES innerHTML without parsing, so `element.textContent` is the name chip's text and
 * nothing else — the badge's own SVG letter cannot leak into it and flatter the assertion.
 */
const overlaySpec = (markerKind, label, level = 'surface') => ({
  markerKind, label, title: label, level,
});
/** Paint one marker into a throwaway element and hand back both the element and the content. */
function paintInto(spec, tier) {
  const doc = new FakeDocument();
  const element = doc.createElement('div');
  element.className = 'tz-three-marker tz-three-marker-marker';
  element.textContent = spec.label;      // the OLD behaviour, so the repaint has something to clear
  const content = paintMarkerOverlay(element, spec, tier, doc);
  return { doc, element, content, markHtml: element.children.map((c) => c.innerHTML).join('') };
}

test('a LOOT marker draws the real icons.js badge and NO name text', () => {
  const { element, content, markHtml } = paintInto(overlaySpec('loot-valuables', 'Buried barrel cache'), 'icon');
  assert.equal(content.mark, 'badge');
  // The badge markup is icons.js's, byte for byte — not a lookalike this module drew.
  assert.equal(markHtml, iconHtml('loot-valuables', 22, null, 'surface', null, null));
  assert.match(markHtml, /<svg viewBox="0 0 24 24"/, 'a badge must be an SVG, not a styled box');
  assert.match(markHtml, /class="mk ci level-surface"/, 'the loot family circle must be drawn');
  assert.match(markHtml, new RegExp(`fill='${KINDS['loot-valuables'].color}'`), 'the kind colour is missing');
  // THE COLLISION FIX. The name is on the title, and nowhere on the map face.
  assert.equal(content.name, null);
  assert.equal(element.textContent, '', 'a loot marker must carry no name text — this is the bug');
  assert.doesNotMatch(element.textContent, /Buried barrel cache/);
  assert.equal(element.dataset.markerKind, 'loot-valuables');
  assert.equal(element.dataset.mark, 'badge');
  assert.ok(element.classList.contains('has-mark') && element.classList.contains('mark-badge'));
});

test('an EXTRACT keeps its letter badge AND its name, at every tier', () => {
  for (const tier of ['dot', 'icon', 'full']) {
    const { element, content, markHtml } = paintInto(overlaySpec('extract-pmc', 'Dorms V-Ex'), tier);
    // LOD-exempt by the rule in src/lod.js: an extract is never dimmed to a dot.
    assert.equal(content.tier, 'full', `an extract must ignore the ${tier} tier`);
    assert.equal(content.mark, 'badge');
    assert.match(markHtml, />D<\/text>/, `the extract letter is missing at ${tier}`);
    // Dorms V-Ex costs 20k roubles, so its badge carries the `cash` corner chip — the extract's
    // requirement CLASS rides the badge in 3D exactly as it does in 2D.
    assert.equal(markHtml, iconHtml('extract-pmc', 26, 'D', 'surface', null, 'cash'));
    assert.equal(content.name, 'Dorms V-Ex');
    assert.equal(element.textContent, 'Dorms V-Ex', `the extract name is missing at ${tier}`);
    assert.equal(element.children.length, 2, 'an extract draws a mark AND a name chip');
    assert.equal(element.children[1].className, 'tz-three-mark-name');
  }
  // …and its requirement corner-chip still rides along, from the same EXTRACT_REQ table.
  const flare = paintInto(overlaySpec('extract-scav', 'Old Gas Station'), 'full');
  assert.match(flare.markHtml, />OG<\/text>/);
  assert.match(flare.markHtml, /textLength='12\.6'/, 'the letter pin must survive the 3D path');
  assert.match(flare.markHtml, /M5\.8 15\.5v5\.4/, 'the REQ: GREEN FLARE corner chip is missing');
});

test('the LOD TIER decides which of dot / icon / full a marker draws', () => {
  const spec = overlaySpec('spawn-pmc', 'PMC spawn');
  const dot = paintInto(spec, 'dot');
  assert.equal(dot.content.mark, 'dot');
  assert.equal(dot.markHtml, dotHtml('spawn-pmc', 6));
  assert.match(dot.markHtml, /class="mk-dot mk-dot-sh"/, 'the dot must still carry its family shape');
  assert.doesNotMatch(dot.markHtml, /class="mk /, 'a dot-tier marker must not draw a badge');
  assert.ok(dot.element.classList.contains('mark-dot'));
  assert.equal(dot.element.dataset.lodTier, 'dot');

  for (const tier of ['icon', 'full']) {
    const badge = paintInto(spec, tier);
    assert.equal(badge.content.mark, 'badge', `${tier} must draw a badge`);
    assert.equal(badge.markHtml, iconHtml('spawn-pmc', 22, null, 'surface', null, null));
    assert.equal(badge.element.dataset.lodTier, tier);
    assert.ok(!badge.element.classList.contains('mark-dot'));
  }
  // The ladder is src/lod.js's, not a second one invented here: the same m/px the renderer folds in
  // has to produce the same answer. Customs cover-fit is 0.55 m/px, one zoom in is 0.276.
  assert.equal(markerTier('spawn-pmc', tierOf(0.55)), 'dot');
  assert.equal(markerTier('spawn-pmc', tierOf(0.276)), 'icon');
  assert.equal(markerTier('spawn-pmc', tierOf(0.138)), 'full');
  // Repainting in place is what a camera move does — it must REPLACE the mark, not append to it.
  const doc = new FakeDocument();
  const element = doc.createElement('div');
  paintMarkerOverlay(element, spec, 'full', doc);
  paintMarkerOverlay(element, spec, 'dot', doc);
  assert.equal(element.children.length, 1);
  assert.equal(element.children[0].innerHTML, dotHtml('spawn-pmc', 6));
  assert.equal(element.dataset.lodTier, 'dot');
});

test('an unknown kind keeps its text pill instead of inventing a badge', () => {
  // `quest`, `player` and place labels have no `markerKind`, and a data row could carry a kind this
  // build does not know. None of them may be drawn as a badge we made up.
  const doc = new FakeDocument();
  const element = doc.createElement('div');
  element.textContent = 'QUEST';
  assert.equal(paintMarkerOverlay(element, overlaySpec('a-kind-that-never-shipped', 'x'), 'icon', doc), null);
  assert.equal(element.textContent, 'QUEST', 'the caller\'s text fallback must survive untouched');
  assert.ok(!element.classList.contains('has-mark'));
  assert.equal(markerOverlayContent({ markerKind: null }, 'icon'), null);
  assert.equal(markerOverlayContent(null, 'icon'), null);
});

test('no data string can reach innerHTML — only the icons.js vocabulary does', () => {
  // The badge SVG is trusted because every byte of it is looked up in icons.js. The two data-derived
  // fields that reach `iconHtml` are the LEVEL (interpolated into a class name) and the NAME (used
  // only as a key into the hand-written EXTRACT_LETTER / EXTRACT_REQ tables).
  const hostile = '" onload="alert(1)';
  const level = paintInto(overlaySpec('lock', 'Padlock', hostile), 'icon');
  assert.match(level.markHtml, /class="mk dia level-surface"/, 'an unknown level must fall back to surface');
  assert.doesNotMatch(level.markHtml, /onload/);
  const name = paintInto(overlaySpec('extract-pmc', `<img src=x onerror=alert(1)>`), 'full');
  assert.doesNotMatch(name.markHtml, /<img/, 'a marker name must never be interpolated into the badge');
  assert.doesNotMatch(name.markHtml, /onerror/);
  // …and the name that IS drawn goes in as text, on its own element.
  assert.equal(name.element.children[1].innerHTML, '', 'the name chip must be written with textContent');
  assert.equal(name.element.textContent, '<img src=x onerror=alert(1)>');
  for (const level2 of ['surface', 'underground', 'rooftop', 'upper']) {
    assert.equal(safeOverlayLevel(level2), level2, 'the four real levels must survive the whitelist');
  }
});

test('the Three renderer wires the badge path in, and repaints it on a camera move', async () => {
  const renderer = await readFile(new URL('../src/map3d-three.js', import.meta.url), 'utf8');
  // The overlay must go THROUGH the shared module — a second badge implementation in this file is
  // how the two views drifted apart in the first place.
  assert.match(renderer, /import \{ paintMarkerOverlay \} from '\.\/marker-overlay\.js'/);
  assert.match(renderer, /paintMarkerOverlay\(item\.element, item\.spec, tier\)/);
  assert.match(renderer, /if \(item\.spec && !tier\) paintMarker\(item, overlayMarkerTier\)/,
    'a marker must be painted when it is created, and a place label must not be');
  // `level` has to survive markerOverlaySpec() -> makeOverlayItem(), or every underground badge
  // silently becomes a surface one.
  assert.match(renderer, /function makeOverlayItem\(\{[^}]*, level = 'surface',/);
  assert.match(renderer, /spec: markerKind \? \{ markerKind, label: safeText\(label\), title: safeText\(title \|\| label\), level \} : null/);
  // The ladder is the SHARED one, folded in from the camera rather than re-derived.
  assert.match(renderer, /import \{ currentTier as currentMarkerTier, updateTier as updateMarkerTier \} from '\.\/lod\.js'/);
  assert.match(renderer, /updateMarkerTier\(1 \/ Math\.pow\(2, overlayCameraZoom\)\)/);
  assert.doesNotMatch(renderer, /const (BOUNDS|TIERS|HYSTERESIS) =/,
    'the marker LOD ladder must not be re-declared in the renderer — src/lod.js owns it');
  // Both camera paths raise it: applyView() (permalinks, fit, resize) and the OrbitControls echo.
  assert.equal((renderer.match(/noteCameraZoom\(viewState\.zoom\)/g) ?? []).length, 2,
    'both the applyView and the controls-change paths must fold the camera into the marker tier');
  // The repaint is gated on the tier CHANGING, not on the camera moving.
  assert.match(renderer, /if \(!force && t === overlayMarkerTier\) return t;/);
  // focusExtract() used to compare `element.textContent === name`; an extract element now contains
  // its badge's SVG letter as well, so that comparison would silently stop matching.
  assert.doesNotMatch(renderer, /item\.element\.textContent === name/);
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

/**
 * THE MEASURED DEFECT (chain-link fences were invisible at map-browsing distance).
 *
 * The fence's alpha MASK was mipped by the GPU's own box filter. Measured on the shipped texture
 * with a `textureLod` readback in Chromium/ANGLE (WebGL2), the fraction of texels that cleared
 * `alphaTest: 0.42` ran 0.69 at LOD 0, 0.63 at LOD 1, 0.50 at LOD 2 and **0 from LOD 3 down**. A
 * real run at the default browsing pose samples LOD 1.8 to 3.5 across one frame, so most of every
 * fence had every fragment discarded and only its posts and rails were left. A box filter conserves
 * a mask's MEAN, and an alpha test reads its COVERAGE; those are different numbers, and the gap
 * only widens as the wire goes sub-texel.
 *
 * This is that measurement as an offline test: the same box chain, the same threshold, the same
 * collapse — and the coverage-preserving chain holding level 0's fraction all the way down.
 */
test('an alpha-tested mask keeps its coverage down the whole mip chain', () => {
  const size = 64, alphaTest = 0.42;
  const diagonalMask = (pitch, wire) => {
    const level = new Float32Array(size * size);
    for (let row = 0; row < size; row++) {
      for (let column = 0; column < size; column++) {
        const onWire = ((row + column) % pitch) < wire || ((row - column + size) % pitch) < wire;
        level[row * size + column] = onWire ? 1 : 0;
      }
    }
    return level;
  };
  const passFraction = (values) => values.reduce((total, value) => total + (value >= alphaTest ? 1 : 0), 0) / values.length;
  const boxChain = (level0) => {
    const fractions = [];
    let level = level0;
    for (let width = size; width > 1; width >>= 1) {
      level = halveCoverageLevel(level, width);
      fractions.push(passFraction(level));
    }
    return fractions;
  };

  // A box filter conserves a mask's MEAN, so wherever that mean falls relative to the threshold is
  // where the coverage ends up — nowhere near where it started. Both failure directions are real:
  // a thin wire dissolves to nothing (the shipped fence, once the sRGB decode had dropped its mean
  // under 0.42), a dense one floods to solid.
  const thin = diagonalMask(16, 2);
  const dense = diagonalMask(8, 2);
  assert.equal(boxChain(thin).at(-1), 0, 'a thin wire box-filters away to nothing');
  assert.ok(boxChain(thin).some((fraction) => fraction === 0), 'and gets there before the last level');
  assert.equal(boxChain(dense).at(-1), 1, 'a dense one box-filters up to a solid slab');

  for (const [name, level0] of [['thin', thin], ['dense', dense]]) {
    const target = passFraction(level0);
    assert.ok(target > 0.1 && target < 0.9, `${name} is a real mask, not a solid one (${target})`);
    const { mipmaps, targetCoverage } = alphaCoverageMipChain(level0, size, alphaTest);
    close(targetCoverage, target, 1e-12);
    assert.equal(mipmaps.length, Math.log2(size) + 1, 'every level down to 1x1');
    for (const [index, mip] of mipmaps.entries()) {
      assert.equal(mip.width, size >> index);
      assert.equal(mip.data.length, mip.width * mip.height * 4);
      // three reads `alphaMap.g`; the byte lands on all four channels so a level is inspectable.
      for (let texel = 0; texel < mip.width * mip.height; texel++) {
        assert.equal(mip.data[texel * 4], mip.data[texel * 4 + 1]);
        assert.equal(mip.data[texel * 4 + 3], mip.data[texel * 4 + 1]);
      }
      const green = Array.from({ length: mip.width * mip.height }, (_, texel) => mip.data[texel * 4 + 1] / 255);
      assert.ok(passFraction(green) >= target - 1 / green.length,
        `${name} LOD ${index} still draws (${passFraction(green)} vs ${target})`);
    }
    // The last level cannot hold a fraction, so it resolves to a solid haze rather than to nothing:
    // its one texel clears the test, and a fence at extreme range draws as a continuous line.
    assert.ok(mipmaps.at(-1).data[1] / 255 >= alphaTest, `${name} 1x1 level still draws`);
  }
  assert.throws(() => alphaCoverageMipChain(thin, 63, alphaTest), /power-of-two/);
  assert.throws(() => alphaCoverageMipChain(thin.slice(0, 10), size, alphaTest), /square/);
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

/*
 * ═══ THE OVERLAY ANCHOR ═══════════════════════════════════════════════════════════════════════
 *
 * Founder, 2026-09-03: "the icons doesnt stay where they belong, they dont go out of screen, they
 * comes with the screen movement." The cause was `seatOverlayAnchor`, which CLAMPED a projected
 * point into the safe rect: a mark whose world position was off-frame was pinned to the frame edge
 * and then slid along it with the camera. Measured at his own #3.92/257.9/-22.1 on a 1920x1080
 * frame, under a 70 m pan that moved the world origin 205 px: 24 marks held a `dy` of EXACTLY 0.0
 * on the clamp bound, and 13 more did not move at all.
 *
 * These assertions are positional, never counts (handoff §7): a count of anchored marks cannot see
 * whether any of them is in the right place, which is the entire bug.
 */
test('an overlay mark is drawn where it projects or not at all — never moved', () => {
  const box = { elementWidth: 100, elementHeight: 20, containerWidth: 1000, containerHeight: 700 };
  const px = (a) => (a === null ? null : a.map((n) => Math.round(n * 1e6) / 1e6));
  assert.deepEqual(px(anchorOverlayMark({ ...box, ndc: [0, 0, 0] })), [500, 350],
    'a point at the middle of the frame lands at the middle');

  // A mark whose anchor is off the left/top of the frame but whose BOX still overlaps it draws at
  // its true position, with negative/small coordinates. The old clamp moved these to [154, 94].
  assert.deepEqual(px(anchorOverlayMark({ ...box, ndc: [-0.96, 0.94, 0] })), [20, 21]);
  // And one off the right/bottom keeps its true position instead of being pulled to [846, 596].
  assert.deepEqual(px(anchorOverlayMark({ ...box, ndc: [0.96, -0.94, 0] })), [980, 679]);

  // Wholly outside the frame: hidden, not repositioned. The 100 px element is 50 px either side of
  // its anchor, so it leaves the frame for good just past x = -50 and x = 1050.
  assert.equal(anchorOverlayMark({ ...box, ndc: [-1.11, 0, 0] }), null, 'off the left edge');
  assert.equal(anchorOverlayMark({ ...box, ndc: [1.11, 0, 0] }), null, 'off the right edge');
  assert.equal(anchorOverlayMark({ ...box, ndc: [0, 1.01, 0] }), null, 'off the top edge');
  assert.equal(anchorOverlayMark({ ...box, ndc: [0, -1.06, 0] }), null, 'off the bottom edge');
  // The old test's ±1.15 NDC slop is what let these through to the clamp in the first place.
  assert.equal(anchorOverlayMark({ ...box, ndc: [1.14, 1.14, 0] }), null, 'inside the old 1.15 slop');

  // Depth. `project()` mirrors a point behind the camera through the origin and hands back a
  // plausible on-screen x/y; only z says so.
  assert.equal(anchorOverlayMark({ ...box, ndc: [0, 0, 1.0029] }), null, 'behind the camera');
  assert.equal(anchorOverlayMark({ ...box, ndc: [0, 0, -1.2] }), null, 'in front of the near plane');
  assert.equal(anchorOverlayMark({ ...box, ndc: [NaN, 0, 0] }), null, 'not a number');
  assert.equal(anchorOverlayMark({ ...box, ndc: null }), null, 'no projection at all');
});

test('an overlay mark tracks its WORLD position across a camera move', () => {
  // A real camera at the renderer's oblique default, and three real world points.
  const camera = new THREE.PerspectiveCamera(45, 1920 / 1080, 0.5, 20000);
  camera.up.set(0, 0, 1);
  const look = (at) => {
    camera.position.set(at[0], at[1] - 260, 190);
    camera.lookAt(at[0], at[1], 0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
  };
  const box = { elementWidth: 22, elementHeight: 22, containerWidth: 1920, containerHeight: 1080 };
  const anchorOf = (world) => {
    const v = new THREE.Vector3(...world).project(camera);
    return anchorOverlayMark({ ...box, ndc: [v.x, v.y, v.z] });
  };
  const near = [0, 0, 0];          // in frame at both camera positions
  const wide = [-200, 40, 0];      // in frame at the first, off the left edge at the second
  const behind = [0, -700, 190];   // behind the camera at both

  look([0, 0]);
  const a = { near: anchorOf(near), wide: anchorOf(wide), behind: anchorOf(behind) };
  look([120, 0]);                  // pan 120 m east
  const b = { near: anchorOf(near), wide: anchorOf(wide), behind: anchorOf(behind) };

  assert.ok(a.near && b.near, 'the near point is on screen at both camera positions');
  // It must MOVE, and move the way the world does: the camera went east, so the ground goes west.
  assert.ok(b.near[0] < a.near[0] - 100,
    `a world-anchored mark travels with the ground: ${a.near[0]} -> ${b.near[0]}`);
  // A clamped mark's giveaway was a delta of exactly zero on one axis while the world moved.
  assert.notEqual(b.near[0], a.near[0]);

  assert.ok(a.wide, 'the wide point starts on screen');
  assert.equal(b.wide, null, 'and is HIDDEN once the camera moves past it, not pinned to the edge');

  assert.equal(a.behind, null, 'a point behind the camera never draws');
  assert.equal(b.behind, null, 'and still does not after the camera moves');
});

/*
 * ═══ P2: THE OVERLAY PASS IS TWO PHASES AND READS NO LAYOUT ═══════════════════════════════════
 *
 * Measured on the founder's 5080 (docs/PROFILING.md, 2026-09-03): `phases.overlay` at `ground-close`
 * with 1,304 items was 10.60 ms median / 13.80 p95 inside a 20.90 ms frame — the only configuration
 * in the baseline over the 16.67 ms 60 Hz budget. Codex red team cxt-20260903-210116-trjd found the
 * shape: only 186 of the 1,304 elements were on screen and layout was read for all 1,304, because
 * the anchoring fix earlier that day moved the `offsetWidth` read ABOVE the on-screen test.
 *
 * These are source assertions because the loop lives inside a closure that needs a DOM and a WebGPU
 * device to run at all — the same reason every other renderer-shape test in this file reads text.
 * Each one was mutated and watched go red before it was kept; a green assertion nobody has seen fail
 * is exactly the "system reports success" shape handoff §7 is about.
 */
const overlayLoopSource = (renderer) => {
  const loop = /\n  function updateOverlayPositions\(\) \{\n([\s\S]*?)\n  \}\n/.exec(renderer);
  assert.ok(loop, 'updateOverlayPositions() must exist');
  return loop[1];
};

test('P2 — the overlay frame loop reads NO element geometry', async () => {
  const renderer = await readFile(new URL('../src/map3d-three.js', import.meta.url), 'utf8');
  const loop = overlayLoopSource(renderer);
  // The regression this exists to stop: one forced synchronous layout per item per frame, paid for
  // 1,304 items to place 186 of them.
  assert.doesNotMatch(loop, /offsetWidth|offsetHeight|getBoundingClientRect|getComputedStyle|offsetTop|offsetLeft|clientTop/,
    'no layout read may appear inside updateOverlayPositions()');
  // The two container reads that were always there and are per FRAME, not per item, stay legal.
  assert.match(loop, /container\.clientWidth/);
  // …and they must sit before the loop, not inside it.
  const firstItemLoop = loop.indexOf('for (const item of overlayItems)');
  assert.ok(firstItemLoop > loop.indexOf('container.clientWidth'),
    'the container size is read once per frame, above the per-item loops');

  // The dimensions come from the cache instead, and the cache is filled OFF the frame loop.
  assert.match(loop, /item\.hiddenNow \? 0 : item\.width/);
  assert.match(loop, /item\.hiddenNow \? 0 : item\.height/);
  assert.match(renderer, /function measureOverlayItem\(item\) \{[\s\S]*?if \(item\.element\.hidden\) return;\n\s*const width = item\.element\.offsetWidth, height = item\.element\.offsetHeight;[\s\S]*?if \(width === 0 && height === 0\) return;\n\s*item\.width = width;\n\s*item\.height = height;\n\s*\}/,
    'measureOverlayItem() is the one place that reads a box, and it refuses a hidden element');
  // A 0x0 is what EVERY overlay element measures while the stage is display:none — the 2D view,
  // where syncMarkerTier() still runs. Caching it would hand the first 3D frame after the switch a
  // 0x0 box for every mark. Both readers refuse the pair.
  assert.equal((renderer.match(/if \(width === 0 && height === 0\) (?:return|continue);/g) ?? []).length, 2,
    'both the batch measure and the ResizeObserver must refuse a 0x0 box');
});

test('P2 — the loop allocates nothing per item: one Vector3, one ndc array, one args object', async () => {
  const renderer = await readFile(new URL('../src/map3d-three.js', import.meta.url), 'utf8');
  const loop = overlayLoopSource(renderer);
  assert.doesNotMatch(loop, /new THREE\.Vector3/,
    'a Vector3 per item per frame is ~1,300 allocations a frame — reuse the hoisted one');
  assert.doesNotMatch(loop, /gameToWorld\(/,
    'the world point is resolved once at creation; calling gameToWorld() per frame re-allocates an array per item');
  assert.doesNotMatch(loop, /anchorOverlayMark\(\{/,
    'the arguments object is hoisted too — a fresh literal per item is a fresh allocation per item');
  assert.match(loop, /overlayProjection\.set\(item\.wx, item\.wy, item\.wz\)\.project\(camera\)/);
  assert.match(loop, /item\.anchor = anchorOverlayMark\(overlayAnchorArgs\)/);
  // The hoisted scratch is created once, outside any function that runs per frame.
  assert.match(renderer, /const overlayProjection = new THREE\.Vector3\(\);\n\s*const overlayNdc = \[0, 0, 0\];/);
  // And the world scalars really are computed at creation, from the same expression the loop used.
  assert.match(renderer, /const \[wx, wy, wz\] = gameToWorld\(gx, gz, gy \?\? H\(gx, gz\) \+ 1\.2\);/);
});

test('P2 — a write that would not change the DOM is skipped', async () => {
  const renderer = await readFile(new URL('../src/map3d-three.js', import.meta.url), 'utf8');
  const loop = overlayLoopSource(renderer);
  assert.match(loop, /if \(hidden !== item\.hiddenNow\) \{\n\s*item\.element\.hidden = hidden;\n\s*item\.hiddenNow = hidden;\n\s*\}/,
    '`hidden` is written only when it changes');
  assert.match(loop, /if \(transform === item\.lastTransform\) continue;\n\s*item\.element\.style\.transform = transform;\n\s*item\.lastTransform = transform;/,
    'the transform is written only when the string differs from the one already on the element');
  // The two caches must be seeded with what the element ACTUALLY is at creation — a `hiddenNow`
  // that started true, or a `lastTransform` that started non-empty, would skip a needed first write.
  assert.match(renderer, /width: 0, height: 0, hiddenNow: false, lastTransform: '', anchor: null,/);
});

test('P2 — the dimension cache is refilled on a tier repaint and by a ResizeObserver', async () => {
  const renderer = await readFile(new URL('../src/map3d-three.js', import.meta.url), 'utf8');
  // A dot is not the size of a badge: the LOD repaint changes every mark's box, so the cache is
  // refilled in one read pass right after the write pass that changed them.
  assert.match(renderer, /for \(const item of overlayItems\) if \(item\.spec && paintMarker\(item, t\)\) repainted \+= 1;\n(?:\s*\/\/[^\n]*\n)*\s*if \(repainted\) \{ measureOverlayItems\(\); invalidateRender\(\); \}/,
    'syncMarkerTier() must re-measure after a repaint, or a dot would keep a badge\'s box');
  // …and every other reason a box can change — a web font landing, a class flip, a name edit — is
  // caught by the observer rather than by a list of assumptions about which paths resize a marker.
  assert.match(renderer, /new ResizeObserver\(\(entries\) => \{/);
  assert.match(renderer, /overlayResizeObserver\?\.observe\(element\)/,
    'every overlay element must be observed as it is built');
  assert.match(renderer, /overlayResizeObserver\?\.disconnect\(\)/,
    'clearOverlays() must disconnect, or the observer holds detached nodes');
  // The observer re-reads offsetWidth rather than trusting entry.borderBoxSize, which is fractional
  // where offsetWidth is rounded — using it would move the on-screen test by up to half a pixel.
  assert.match(renderer, /const width = entry\.target\.offsetWidth, height = entry\.target\.offsetHeight;/);
  assert.doesNotMatch(renderer, /borderBoxSize\s*(?:\?\.)?\[/,
    'borderBoxSize is fractional; the cache must hold the same integer the old frame read held');
  // A hidden element reports 0x0. Caching that would shrink the on-screen test for every item that
  // came back into frame, which is exactly the "appears at the wrong moment" failure.
  assert.match(renderer, /if \(!item \|\| entry\.target\.hidden\) continue;/);
  // Guarded: an observer that invalidated on every delivery would feed itself frames forever.
  assert.match(renderer, /if \(changed\) invalidateRender\(\);/);
  // And the freshly built overlay is measured in ONE pass, not per item as it is appended.
  assert.match(renderer, /measureOverlayItems\(\);\n\s*invalidateRender\(\);\n\s*\}/,
    'refreshDynamicNow() must measure every item once, after the last element is in the document');
});

// ── The renderer gate: two questions, deliberately not one ────────────────────────────────────
//
// The old gate fused them into `canUseLocalThree({dev, hostname, mapKey, rendererRequest})`, so the
// only way to let the renderer run in production was to relax the boundary that keeps the founder's
// game-derived data off the internet. These tests pin the split: (a) may Three run, (b) may it read
// local data — and specifically that no input to (a) can move (b).

test('(a) the Three renderer runs for Customs on an explicit request, in ANY environment', () => {
  const asked = { mapKey: 'customs', rendererRequest: 'three' };
  assert.equal(canRunThreeRenderer(asked), true);
  assert.equal(resolveRendererMode(asked), 'three');
  // Production is the case that used to be refused. It is now the point.
  assert.equal(
    describeRendererGate({ ...asked, dev: false, hostname: 'tarkovzero.com' }).renderer,
    'three',
  );
  assert.equal(resolveRendererMode({ ...asked, mapKey: 'woods' }), 'deck', 'Reserve/Woods have no Three path');
  assert.equal(resolveRendererMode({ ...asked, mapKey: 'reserve' }), 'deck');
  assert.doesNotThrow(() => assertThreeRenderer(asked));
  assert.throws(() => assertThreeRenderer({ ...asked, mapKey: 'woods' }), /\?renderer=deck/);
  assert.throws(() => assertThreeRenderer({ mapKey: 'customs', rendererRequest: 'deck' }), /\?renderer=deck/);
});

// ── (a) the default, flipped 2026-09-02 ────────────────────────────────────────────────────────
//
// The founder opened tarkovzero.com and got deck.gl's older geometry under today's labels: "is
// this what i am supposed to see? cause the map we build is not this." Customs is Three now, with
// deck.gl one `?renderer=deck` away, and Reserve/Woods untouched because they have no Three data.

test('(a) Customs with NO renderer param is Three; every other map is deck.gl', () => {
  for (const rendererRequest of [null, undefined, '', '   ']) {
    assert.equal(
      resolveRendererMode({ mapKey: 'customs', rendererRequest }),
      'three',
      `Customs must default to Three (request ${JSON.stringify(rendererRequest)})`,
    );
  }
  assert.equal(resolveRendererMode({ mapKey: 'customs' }), 'three');
  assert.equal(canRunThreeRenderer({ mapKey: 'customs' }), true);
  assert.doesNotThrow(() => assertThreeRenderer({ mapKey: 'customs' }));

  // Reserve and Woods have no Three data path, so the default cannot reach them and neither can an
  // explicit request. This is the assertion that keeps the flip to ONE map.
  for (const mapKey of ['reserve', 'woods']) {
    for (const rendererRequest of [null, 'three', 'deck']) {
      assert.equal(
        resolveRendererMode({ mapKey, rendererRequest }),
        'deck',
        `${mapKey} must stay on deck.gl (request ${rendererRequest})`,
      );
    }
    assert.throws(() => assertThreeRenderer({ mapKey, rendererRequest: 'three' }), /\?renderer=deck/);
  }
  // An unknown map key is not a Three map either — the list is a membership test, not a default.
  assert.equal(resolveRendererMode({}), 'deck');
  assert.equal(resolveRendererMode({ mapKey: 'shoreline' }), 'deck');
  assert.deepEqual(THREE_RENDERER_MAPS, ['customs']);
});

test('(a) ?renderer=deck is the opt-out, and it is read the way a human types it', () => {
  assert.equal(DECK_RENDERER_REQUEST, 'deck');
  assert.deepEqual(RENDERER_REQUESTS, ['three', 'deck']);
  for (const rendererRequest of ['deck', 'DECK', 'Deck', ' deck ', '\tdeck\n']) {
    assert.equal(
      resolveRendererMode({ mapKey: 'customs', rendererRequest }),
      'deck',
      `?renderer=${JSON.stringify(rendererRequest)} must reach deck.gl — it is the escape hatch`,
    );
    assert.equal(canRunThreeRenderer({ mapKey: 'customs', rendererRequest }), false);
  }
  assert.equal(normalizeRendererRequest(' DECK '), 'deck');
  assert.equal(normalizeRendererRequest('  '), null);
  assert.equal(normalizeRendererRequest(null), null);
  assert.equal(normalizeRendererRequest(undefined), null);

  // `three` still names the renderer explicitly, in any casing, and is still what Reserve refuses.
  for (const rendererRequest of ['three', 'THREE', ' Three ']) {
    assert.equal(resolveRendererMode({ mapKey: 'customs', rendererRequest }), 'three');
  }

  // A typo is not a silent opt-out: it leaves the map on its default renderer AND is reportable,
  // so `main.js` can say so on the console instead of a visitor wondering why `?renderer=dekc`
  // changed nothing.
  for (const typo of ['dekc', 'deck.gl', 'off', 'webgl', '0']) {
    assert.equal(isKnownRendererRequest(typo), false, typo);
    assert.equal(resolveRendererMode({ mapKey: 'customs', rendererRequest: typo }), 'three');
    assert.equal(resolveRendererMode({ mapKey: 'woods', rendererRequest: typo }), 'deck');
  }
  for (const known of [null, '', 'three', 'deck', 'DECK']) assert.equal(isKnownRendererRequest(known), true, String(known));
});

test('(a) a PRODUCTION Customs load is Three on PUBLIC data, and says which', () => {
  // The whole point of the gate split, in one assertion: the renderer default moved, the boundary
  // did not. tarkovzero.com, no query string at all.
  const production = describeRendererGate({ dev: false, hostname: 'tarkovzero.com', mapKey: 'customs' });
  assert.equal(production.renderer, 'three');
  assert.equal(production.localEnhancements, false);
  assert.equal(production.localEnhancementReason, 'release-build');
  // `dev` is absent from a production bundle entirely, which is the shape this actually ships in.
  const bundled = describeRendererGate({ hostname: 'tarkovzero.com', mapKey: 'customs' });
  assert.equal(bundled.renderer, 'three');
  assert.equal(bundled.localEnhancements, false);
  assert.equal(bundled.localEnhancementReason, 'release-build');
  // …and on the preview host, and on a LAN address, and on loopback with no dev server behind it:
  // three of them are Three, none of them reach local data, and the reason is never a failure.
  for (const hostname of ['tarkovzero.vercel.app', '192.168.1.4', 'localhost']) {
    const gate = describeRendererGate({ dev: false, hostname, mapKey: 'customs' });
    assert.equal(gate.renderer, 'three', hostname);
    assert.equal(gate.localEnhancements, false, hostname);
    assert.equal(gate.localEnhancementReason, 'release-build', hostname);
  }
});

test('(a) the default flip did not move the boundary predicate', async () => {
  // A source-level assertion, deliberately: the risk this diff carries is not that
  // `canLoadLocalGameDerivedAssets` returns the wrong value today, it is that a later hand widens
  // it to make the now-default renderer look better. Both halves of the conjunction are pinned to
  // the text, and (b)'s signature is pinned to environment inputs only.
  const gate = await readFile(new URL('../src/renderer-gate.js', import.meta.url), 'utf8');
  assert.match(
    gate,
    /export function canLoadLocalGameDerivedAssets\(\{ dev, hostname \} = \{\}\) \{\n\s*return dev === true && isLoopbackHostname\(hostname\);\n\}/,
    'the boundary predicate must stay `dev === true && isLoopbackHostname(hostname)`, taking nothing else',
  );
  assert.doesNotMatch(
    gate,
    /canLoadLocalGameDerivedAssets\(\{[^}]*\b(?:mapKey|rendererRequest)\b/,
    'no renderer or map input may reach the boundary predicate',
  );
  assert.match(gate, /const LOOPBACK_HOSTS = new Set\(\['localhost', '127\.0\.0\.1', '::1'\]\);/);
});

test('(b) local game-derived data stays dev + loopback ONLY — unchanged by the release gate', () => {
  assert.equal(canLoadLocalGameDerivedAssets({ dev: true, hostname: 'localhost' }), true);
  for (const hostname of ['localhost', '127.0.0.1', '::1', '[::1]', 'LOCALHOST']) {
    assert.equal(isLoopbackHostname(hostname), true, hostname);
    assert.equal(canLoadLocalGameDerivedAssets({ dev: true, hostname }), true, hostname);
  }
  assert.equal(normalizeHostname('[::1]'), '::1');

  // A production build: DEV is absent from the bundle entirely, so `undefined` must not read as
  // permission, and no hostname can buy it back.
  for (const hostname of ['tarkovzero.com', 'tarkovzero.vercel.app', '192.168.1.4', 'localhost']) {
    assert.equal(canLoadLocalGameDerivedAssets({ dev: false, hostname }), false, hostname);
    assert.equal(canLoadLocalGameDerivedAssets({ hostname }), false, `undefined dev: ${hostname}`);
    assert.equal(canLoadLocalGameDerivedAssets({ dev: 'true', hostname }), false, `string dev: ${hostname}`);
    assert.equal(canLoadLocalGameDerivedAssets({ dev: 1, hostname }), false, `truthy dev: ${hostname}`);
  }
  // A dev server bound to a LAN address is not loopback either.
  assert.equal(canLoadLocalGameDerivedAssets({ dev: true, hostname: '192.168.1.4' }), false);
  assert.equal(canLoadLocalGameDerivedAssets({ dev: true, hostname: 'tarkovzero.com' }), false);
  assert.equal(canLoadLocalGameDerivedAssets({}), false);

  // The load-bearing separation: nothing that answers (a) is an input to (b).
  for (const mapKey of ['customs', 'woods', 'reserve', null]) {
    for (const rendererRequest of ['three', 'deck', null]) {
      assert.equal(
        canLoadLocalGameDerivedAssets({ dev: false, hostname: 'tarkovzero.com', mapKey, rendererRequest }),
        false,
        `${mapKey}/${rendererRequest} must not unlock local data`,
      );
    }
  }
});

/* ── (c) the build notices come off the live page ────────────────────────────────────────────── */
//
// Founder, 2026-09-02: *"also remove the notification boxes in the middle about the build."* The
// CUSTOMS TRUTH strip and the vegetation notice are instruments — the orange box is what says the
// exact terrain silently failed and the frame is back on the fitted heightfield. A visitor cannot
// act on either. So they are drawn on dev + loopback and nowhere else, and NOTHING about the
// measurement moves: `renderStats().truth` publishes the same composed strip in both places.

test('(c) the diagnostic readouts are drawn on dev + loopback and nowhere else', () => {
  assert.equal(canShowDiagnosticReadouts({ dev: true, hostname: 'localhost' }), true);
  for (const hostname of ['localhost', '127.0.0.1', '::1', '[::1]', 'LOCALHOST']) {
    assert.equal(canShowDiagnosticReadouts({ dev: true, hostname }), true, hostname);
  }
  // Every shape a release build actually ships in. `dev` is ABSENT from a production bundle, so
  // `undefined` must not read as permission — the same identity check the boundary predicate uses.
  for (const hostname of ['tarkovzero.com', 'tarkovzero.vercel.app', '192.168.1.4', 'localhost']) {
    assert.equal(canShowDiagnosticReadouts({ dev: false, hostname }), false, hostname);
    assert.equal(canShowDiagnosticReadouts({ hostname }), false, `undefined dev: ${hostname}`);
    assert.equal(canShowDiagnosticReadouts({ dev: 'true', hostname }), false, `string dev: ${hostname}`);
  }
  // `vite preview` on 127.0.0.1 is a RELEASE build on a loopback host — the exact configuration the
  // e2e walkthrough runs, and the one a loopback-only rule would have got wrong.
  assert.equal(canShowDiagnosticReadouts({ dev: false, hostname: '127.0.0.1' }), false);
  assert.equal(canShowDiagnosticReadouts({}), false);
});

test('(c) hiding the banner does not move the boundary, and vice versa', async () => {
  // Two predicates that currently agree, kept apart on purpose: one is a licensing boundary and one
  // is a presentation choice. Pinned to the source so a later hand cannot collapse them into one
  // and make a UI decision quietly widen the thing that keeps game-derived assets off Vercel.
  const gate = await readFile(new URL('../src/renderer-gate.js', import.meta.url), 'utf8');
  assert.match(
    gate,
    /export function canShowDiagnosticReadouts\(\{ dev, hostname \} = \{\}\) \{\n\s*return dev === true && isLoopbackHostname\(hostname\);\n\}/,
    'the readout predicate must be its own function taking only the environment',
  );
  assert.doesNotMatch(gate, /canLoadLocalGameDerivedAssets\s*=\s*canShowDiagnosticReadouts/);
  assert.doesNotMatch(gate, /canShowDiagnosticReadouts\s*=\s*canLoadLocalGameDerivedAssets/);
  assert.doesNotMatch(
    gate,
    /return canLoadLocalGameDerivedAssets\(\{ dev, hostname \}\);\n\}\n\n\/\*\*\n \* \(c\)/,
    'the readout question must not be implemented by delegating to the boundary question',
  );
});

test('(c) the state behind the hidden banner is still composed, in full, everywhere', () => {
  // The rule the founder set and the one this file's header is about: hide the pixels, keep the
  // measurement. `customsTruthStripCopy()` is pure and takes no environment at all — there is no
  // `localEnhancements`-shaped input that could make a production frame compose a *different*
  // strip from the one a dev box would read, only a different decision about drawing it.
  const args = {
    hasExactTerrain: true,
    terrainDistribution: 'promoted-public',
    surface: { available: 'exact-control-mask-12-layer-original-pbr', active: 'exact-control-mask-12-layer-original-pbr' },
    vegetation: { text: '8,805 AUTHORED VEGETATION', healthy: true, state: 'authored' },
    relief: 2,
    localEnhancements: false,
  };
  const copy = customsTruthStripCopy(args);
  assert.equal(copy.title, 'CUSTOMS TRUTH');
  assert.equal(copy.state, 'exact');
  assert.match(copy.detail, /EXACT TERRAIN — PROMOTED/);
  assert.match(copy.detail, /8,805 AUTHORED VEGETATION/);
  // …and a degraded production load still reads as degraded. This is the assertion that would have
  // caught "the banner is gone, so nothing says the ground fell back": the composed state, which
  // renderStats() publishes, is what carries it now.
  //
  // ONE subsystem down, the other perfect. This is the isolating case: the vegetation term is
  // healthy, so the only thing that can carry the degradation is the terrain term. A frame whose
  // exact ground silently fell back has to read `degraded` here or nothing on the live page — where
  // the banner is gone — would ever say so.
  const groundOnly = customsTruthStripCopy({
    hasExactTerrain: false,
    localEnhancements: false,
    publicSurface: 'semantic-ground-atlas',
    vegetation: { text: '8,805 AUTHORED VEGETATION', healthy: true, state: 'authored' },
  });
  assert.equal(groundOnly.state, 'degraded', 'a fallen-back ground with a healthy forest must still read degraded');
  assert.equal(groundOnly.title, 'CUSTOMS PUBLIC DATA', 'and it must not keep the CUSTOMS TRUTH title');
  assert.match(groundOnly.detail, /PUBLIC HEIGHTFIELD — PROMOTED TERRAIN MISSING/);
  assert.notEqual(groundOnly.state, copy.state, 'a healthy and a fallen-back frame must not read alike');
  // …and the mirror image: the ground is exact and the promoted forest did not arrive.
  const forestOnly = customsTruthStripCopy({
    hasExactTerrain: true,
    terrainDistribution: 'promoted-public',
    surface: { available: 'exact-control-mask-12-layer-original-pbr', active: 'exact-control-mask-12-layer-original-pbr' },
    localEnhancements: false,
    vegetation: { text: '0 AUTHORED VEGETATION — PROMOTED PACK DID NOT LOAD', healthy: false, state: 'fallback', code: 'promoted-vegetation-missing' },
  });
  assert.equal(forestOnly.state, 'degraded', 'a missing promoted forest must read degraded in a release build');
});

test('(c) the renderer attaches the readouts on the gate, and never on anything else', async () => {
  // The wiring, pinned to source, because there is no DOM here to mount it in — the e2e walkthrough
  // is what checks the pixels (step 12 release-hidden, step 13 dev-shown). What this asserts is
  // that BOTH nodes are attached behind the same one flag and that the flag comes from the gate.
  const view = await readFile(new URL('../src/map3d-three.js', import.meta.url), 'utf8');
  assert.match(view, /const diagnosticReadoutsVisible = rendererGate\.diagnosticReadouts;/);
  assert.match(view, /if \(diagnosticReadoutsVisible\) overlay\.append\(proofChip\);/);
  assert.match(view, /if \(diagnosticReadoutsVisible\) overlay\.append\(vegetationChip\);/);
  // The hover label is NOT a build notice and must keep its unconditional mount.
  assert.match(view, /hoverChip\.hidden = true;\n\s*overlay\.append\(hoverChip\);/);
  // The repaint tick is unconditional: a hidden strip that stops being recomputed would publish a
  // stale `renderStats().truth`, which is the metric-that-cannot-fail all over again.
  assert.match(view, /const vegetationChipInterval = setInterval\(updateTruthReadouts, 400\);/);
  assert.doesNotMatch(view, /if \(diagnosticReadoutsVisible\)[^\n]*setInterval/);
  // …and both readers publish it.
  assert.match(view, /truth: \{ \.\.\.truthStripCopy, shown: diagnosticReadoutsVisible \}/);
  assert.equal((view.match(/truth: \{ \.\.\.truthStripCopy, shown: diagnosticReadoutsVisible \}/g) ?? []).length, 2,
    'renderStats() and diagnostics() must both carry the strip');
});

test('(b) production cannot reach local data even if the gate were bypassed', async () => {
  // The gate is layer 1 of four. This is layer 2, asserted directly: the loader refuses a
  // non-loopback page origin BEFORE it fetches, with its own hostname set that does not import
  // from the gate module. A regression in the gate cannot make this pass.
  const fetchThatMustNotRun = () => {
    throw new Error('the loader fetched from a production origin');
  };
  for (const origin of ['https://tarkovzero.com/', 'https://tarkovzero.vercel.app/?renderer=three', 'http://192.168.1.4:4173/']) {
    await assert.rejects(
      loadCustomsLocalTerrainPackage({ fetch: fetchThatMustNotRun, location: origin }),
      (error) => {
        assert.equal(error.code, 'ERR_CUSTOMS_LOCAL_TERRAIN_UNAVAILABLE');
        assert.match(error.message, /localhost, 127\.0\.0\.1, or \[::1\]/);
        return true;
      },
      origin,
    );
  }
});

test('describeRendererGate names WHY local data is out of reach, so a frame can say so', () => {
  const production = describeRendererGate({
    dev: false, hostname: 'tarkovzero.com', mapKey: 'customs', rendererRequest: 'three',
  });
  assert.deepEqual({ ...production }, {
    renderer: 'three',
    request: 'three',
    mapKey: 'customs',
    localEnhancements: false,
    // (c) — the CUSTOMS TRUTH strip and the vegetation notice are not DRAWN on the live page
    // (founder, 2026-09-02: "remove the notification boxes in the middle about the build").
    // Their state is still published: `renderStats().truth` carries the same composed strip.
    diagnosticReadouts: false,
    localEnhancementReason: 'release-build',
  });
  assert.equal(
    describeRendererGate({ dev: true, hostname: '192.168.1.4', mapKey: 'customs', rendererRequest: 'three' })
      .localEnhancementReason,
    'non-loopback-host',
    'a LAN-bound dev server is refused for a different reason than a release build, and says which',
  );
  assert.equal(
    describeRendererGate({ dev: true, hostname: 'localhost', mapKey: 'customs', rendererRequest: 'three' })
      .localEnhancementReason,
    'dev-loopback',
  );
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
  // main.js asks question (a) ONLY: no environment inputs reach the renderer selector any more.
  assert.match(main, /const rendererMode = resolveRendererMode\(\{ mapKey: mapData\.key, rendererRequest \}\)/);
  assert.doesNotMatch(main, /resolveRendererMode\([\s\S]{0,200}location\.hostname/);
  // The console has to keep telling the truth after the flip. The Customs-only warning fires on an
  // explicit `three` that did not get Three (Reserve/Woods) — it must NOT fire for a bare load or
  // for the opt-out, which are not refusals — and an unrecognised value announces itself instead
  // of being silently treated as a choice.
  assert.match(main, /if \(normalizeRendererRequest\(rendererRequest\) === 'three' && rendererMode !== 'three'\) console\.warn\(/);
  assert.match(main, /if \(!isKnownRendererRequest\(rendererRequest\)\) console\.warn\(/);
  assert.doesNotMatch(main, /The Three renderer is Customs-only; using deck\.gl/,
    'the warning may not hard-code a map list that THREE_RENDERER_MAPS owns');
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
  // The renderer's own entry point asks question (a) with NO environment inputs.
  assert.match(renderer, /assertThreeRenderer\(\{\n\s*mapKey: mapData\.key,\n\s*rendererRequest,\n\s*\}\)/);
  // THE BOUNDARY, asserted on the source: the ONE call that reaches the local game-derived package
  // is behind `localEnhancementsAllowed`, and that flag comes from the gate's (b) half. A future
  // edit that fetches the package unconditionally fails here, not in a browser.
  assert.match(
    renderer,
    /const localEnhancementsAllowed = rendererGate\.localEnhancements;/,
  );
  assert.match(
    renderer,
    /const localTerrainRequest = localEnhancementsAllowed\n\s*\? loadCustomsLocalTerrainPackage\(/,
  );
  assert.equal(
    (renderer.match(/loadCustomsLocalTerrainPackage\(/g) ?? []).length,
    1,
    'exactly one call site may reach the local terrain package, and it is the gated one',
  );
  // THE PROMOTED PACKAGE, on the other side of the same flag. It is requested exactly when the
  // local one is NOT, so a production load fetches the exact ground and a dev load does not fetch
  // 10.7 MiB of the same numbers twice. Both halves asserted on the source, so a future edit that
  // makes production skip the promoted terrain — or that fetches both — fails here.
  assert.match(
    renderer,
    /const promotedTerrainRequest = localEnhancementsAllowed\n\s*\? Promise\.resolve\(\{ value: null, error: null \}\)\n\s*: loadCustomsPromotedTerrainPackage\(/,
  );
  assert.equal(
    (renderer.match(/loadCustomsPromotedTerrainPackage\(/g) ?? []).length,
    1,
    'exactly one call site may reach the promoted terrain package',
  );
  assert.match(
    renderer,
    /let exactTerrainPackage = localTerrainOutcome\.value \?\? promotedTerrainOutcome\.value;/,
  );
  // The readouts read the package's own `distribution`, never the gate. A frame that infers its
  // ground from an environment flag is one refactor away from lying about it.
  assert.match(
    renderer,
    /const exactTerrainSource = exactTerrainMesh \? \(exactTerrainPackage\?\.distribution \?\? null\) : null;/,
  );
  assert.doesNotMatch(
    renderer,
    /release-build-public-tree-positions/,
    'the pre-promotion reason code named the whole frame; it must be gone',
  );
  assert.doesNotMatch(
    renderer,
    /release-build-vegetation-not-promoted/,
    'the pre-vegetation-promotion reason code said the pack was not promoted; it ships now',
  );
  assert.match(renderer, /promoted-vegetation-unavailable/);
  // The vegetation loader pair, mirroring the terrain pair above it: the promoted package is
  // requested exactly when the local one is not, and the readouts read the package's own source.
  assert.match(
    renderer,
    /promotedVegetationPackage = await loadCustomsPromotedVegetationPackage\(/,
  );
  assert.equal(
    (renderer.match(/loadCustomsPromotedVegetationPackage\(/g) ?? []).length,
    1,
    'exactly one call site may reach the promoted vegetation package',
  );
  assert.match(renderer, /const promotedVegetation = exactVegetationSource === 'promoted-public';/);
  // The mount's URLs come from that one decision, never from a constant chosen elsewhere.
  assert.match(renderer, /baseUrl: vegetationRoutes\.pack,/);
  assert.match(renderer, /baseUrl: vegetationRoutes\.arrays,/);
  // The release path's placement count is MEASURED from the trees it seated, not defaulted to 0.
  assert.match(renderer, /proceduralPlacements: proceduralVegetationPlan\?\.renderedCount \?\? publicTreePlacements/);
  assert.match(renderer, /publicTreePlacements = trees\.length/);
  assert.match(renderer, /kind: 'public-tree-proxy'/);
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
  assert.match(renderer, /anchorOverlayMark\(\{/);
  // The mark's position comes straight out of the projection and is written unchanged. Nothing
  // between `project()` and the transform may clamp, inset or otherwise move it, and the safe rect
  // — the old clamp's target — must not be read on this path at all (founder, 2026-09-03).
  // The shipped loop became two-phase on 2026-09-03 (P2), so the old single-pass shape
  // `hidden = !anchor; if (!anchor) continue;` is gone from it. The RULE it pinned is not: `hidden`
  // is still exactly the negation of the anchor, and the anchor's two numbers still reach the
  // transform having had nothing done to them.
  assert.match(renderer, /const hidden = !anchor;\n\s*if \(hidden !== item\.hiddenNow\) \{\n\s*item\.element\.hidden = hidden;/);
  assert.match(renderer, /translate3d\(\$\{anchor\[0\]\.toFixed\(1\)\}px,\$\{anchor\[1\]\.toFixed\(1\)\}px,0\)/);
  // The clamp, stated as a prohibition rather than as one shape of loop: no arithmetic and no
  // Math.min/max may touch an anchor component anywhere in this file.
  assert.doesNotMatch(renderer, /anchor\[[01]\]\s*[-+*\/]/,
    'nothing may do arithmetic on an anchor component — that is how the clamp came back last time');
  assert.doesNotMatch(renderer, /Math\.(?:min|max)\([^)]*anchor\[[01]\]/,
    'a mark is drawn where it projects or not at all; it is never clamped into a rect');
  assert.doesNotMatch(renderer, /safeRect/,
    'the Three overlay must not seat marks against the chrome rect — a mark is a world position');
  assert.doesNotMatch(renderer, /v\.x > -1\.15/,
    'the ±1.15 NDC slop admitted off-frame marks for the clamp to pin to the edge');
  assert.match(renderer, /reconcileOrbitView\(\{/);
  assert.match(renderer, /if \(reconciled\.corrected\) writeControlledPose\(reconciled\.pose\)/);
  assert.match(renderer, /if \(suppressControlEvent\) return/);
  assert.match(renderer, /document\.hidden \|\| !document\.body\.classList\.contains\('view-3d'\)/);
  assert.match(renderer, /if \(!renderRequested && settleFrames <= 0\) return/);
  assert.match(renderer, /controls\.enableDamping = false/);
  assert.match(renderer, /const invalidateRender = \(frames = 0\)/);
  assert.match(renderer, /outline: new THREE\.LineBasicMaterial/);
  // The `outlineFor()` helper went out with the underground view on 2026-09-02 — it was that
  // builder's only caller. The rule it enforced did not: the ONE surviving outline, the building
  // shell's, must still consume the tracked shared material rather than minting its own.
  assert.match(renderer, /new THREE\.LineSegments\(new THREE\.EdgesGeometry\(extrusion, 28\), materials\.outline\)/);
  assert.doesNotMatch(renderer, /function outlineFor\(/);
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
  assert.match(styles, /\.tz-three-marker-marker/);
  assert.match(styles, /body\.renderer-three #relief-row\{display:none\}/);
  assert.match(styles, /body\.renderer-three #fx-row \[data-fx="fog"\]\{display:none\}/);
  assert.match(deckRenderer, /measuredSurfaceY\(b, RELIEF\)/);
  assert.match(renderer, /createFloorSurfaceResolver\(data\.floorSurfaces, relief\)/);
  assert.match(renderer, /buildPropAsset\(prop/);
  // Was `buildOpenFrameBuildingAsset(`. One building on the map was open — Skeleton — because of a
  // `place === 'skeleton'` string compare, while Old Construction carried the identical
  // `style: 'frame'` and three fuel canopies carried `style: 'canopy'` and all four were solid
  // blocks. The open path is now keyed on the ROUTER (`archetype: 'open-structure'` and
  // `'lattice-tower'` both replace their mass), so ten buildings are open instead of one and the
  // literal is gone. Asserted in full by scripts/building-detail-assemble.test.mjs.
  assert.match(renderer, /buildingDetail = planBuildingDetail\(seatedBuildings, \{/);
  assert.doesNotMatch(renderer, /safeText\(building\.place\)\.toLowerCase\(\) === 'skeleton'/);
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
  assert.match(renderer, /if \(container\.__tz3d === api\) delete container\.__tz3d/);
  assert.match(styles, /\.tz-three-marker-landmark/);
  assert.match(deckRenderer, /createFloorSurfaceResolver\(data\.floorSurfaces, relief\)/);
  assert.match(deckRenderer, /id: 'measured-floor-surfaces'/);

  /*
   * THE FLOOR SELECTOR IS GONE (2026-09-02, founder: "remove the floor filter not needed, these
   * maps are for viewing from above and its too much work to make the floors have usability.. so
   * floor system fully out the project").
   *
   * Asserted as ABSENCE against the renderer SOURCE, both renderers, because "hidden" and "gone"
   * look identical from the outside and only the second one is what was asked for. What must NOT
   * come back: a `floor` state variable, a `setFloor` on either API, the `mesh.scale.z` squash that
   * shortened a building to a shown floor, and any `visible:` / `.visible =` gated on a floor.
   *
   * What stays, and is asserted present a few lines up: the floorSurfaces evidence resolver, the
   * measured floor slabs it renders, and `buildingFloorLevels`' storey lines and window bands.
   */
  for (const [name, source] of [['map3d-three.js', renderer], ['map3d.js', deckRenderer]]) {
    assert.doesNotMatch(source, /visibleBuildingHeight/, `${name}: selector wall height`);
    assert.doesNotMatch(source, /\bsetFloor\b/, `${name}: setFloor on the renderer API`);
    assert.doesNotMatch(source, /\bapplyFloor\b|applyFloorVisibility/, `${name}: the selector pass`);
    assert.doesNotMatch(source, /let floor = /, `${name}: the selector's state`);
    assert.doesNotMatch(source, /mesh\.scale\.z = /, `${name}: the building squash`);
    assert.doesNotMatch(source, /visibleForFloor|customsAssetVisibleForFloor/, `${name}: floor gates`);
    assert.doesNotMatch(source, /floor !== 'U'|floor === 'U'|floor === 'all'/, `${name}: floor branches`);
  }
  // The squash's removal is only safe because the selector's own "ALL" scale was exactly 1 — the
  // walls must still stand their full measured height, unconditionally.
  assert.match(renderer, /realHeight: height,/);
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
  assert.match(renderer, /\[buildingGroup, propGroup\]/);
  assert.match(renderer, /restoreProceduralSuppression\(\);[\s\S]*suppressedProceduralFeatures\.clear\(\)/);
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
