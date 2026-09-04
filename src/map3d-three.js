/**
 * Localhost-only Three.js renderer proof for Customs.
 *
 * This deliberately consumes the same canonical JSON and callback surface as map3d.js. It proves
 * that TarkovZero can replace only its 3D presentation layer without rewriting live tracking,
 * quests, filters, coordinates, camera hand-off, or the 2D map. Current procedural meshes
 * remain visibly labelled provisional; audited GLB/KTX2 chunks can replace them through the scene
 * manifest without moving their stable EFT-space anchors.
 */
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { paletteFor } from './atmosphere.js';
import { BRIDGE_STRUCTURE, bridgeApproachPlan, bridgeStructurePlan } from './bridge-structure.js';
import { CAM, clampCamera, zoomOffsetFor } from './camera.js';
import { placeBuildings, plinthColor } from './buildings.js';
import { MATERIAL_SLOT_INDEX } from './building-detail/contract.js';
import {
  assembleBuildingGeometry,
  buildingRenderStatsNow,
  planBuildingDetail,
  plinthMeshData,
  visibleInstanceIndices,
} from './building-detail/assemble.js';
import {
  CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME,
  sampleCustomsTerrainElevation,
} from './customs-local-terrain.js';
import {
  loadCustomsLocalTerrainPackage,
  loadCustomsPromotedTerrainPackage,
} from './customs-local-terrain-loader.js';
import {
  BRIDGE_SEATING,
  bridgeDeckAnchor,
  bridgeSeating,
  mergeCustomsLocalBridges,
} from './customs-local-bridges.js';
import { loadCustomsLocalBridgesPackage } from './customs-local-bridges-loader.js';
import {
  WATER_SURFACE_SEATING,
  deckWaterClearance,
  waterSurfacePlan,
} from './water-surface.js';
import { compileCustomsLocalTerrainMesh } from './customs-local-terrain-mesh.js';
import { loadCustomsLocalVegetation } from './customs-local-vegetation.js';
import { loadCustomsPromotedVegetationPackage } from './customs-promoted-vegetation-loader.js';
import {
  CUSTOMS_PROMOTED_VEGETATION_ARRAY_BASE_URL,
  CUSTOMS_PROMOTED_VEGETATION_BASE_URL,
} from './customs-promoted-vegetation.js';
import { buildCustomsLocalVegetationRenderPlan } from './customs-local-vegetation-render.js';
import {
  CUSTOMS_AUTHORED_VEGETATION_SHADOW_POLICY,
  createCustomsAuthoredVegetationRuntime,
  normalizeCustomsAuthoredVegetationCatalog,
} from './customs-authored-vegetation.js';
import {
  assertCustomsAuthoredVegetationRouteTotals,
  routeCustomsAuthoredVegetationRollout,
} from './customs-authored-vegetation-rollout.js';
import {
  loadCustomsVegetationTextureArrays,
  stripCustomsVegetationGlbImages,
  validateCustomsVegetationTextureArrayIndex,
} from './customs-vegetation-texture-arrays.js';
import {
  VEGETATION_MOUNT_ASSEMBLE_MS,
  VEGETATION_MOUNT_STALL_MS,
  VEGETATION_MOUNT_TOTAL_MS,
  VEGETATION_REPACK_EPSILON_M,
  decideVegetationRepack,
  evaluateVegetationMount,
  vegetationCameraSignature,
} from './customs-vegetation-mount-policy.js';
import { describeVegetationObservability } from './customs-vegetation-observability.js';
import {
  createShadowCasterAudit,
  createShadowController,
  parseShadowRequest,
  shadowCasterFingerprint,
} from './shadow-invalidation.js';
import {
  EMPTY_RENDER_FRAME_LATCH,
  describeRenderFrame,
  latchRenderFrame,
  sampleRenderFrame,
} from './render-frame-latch.js';
import {
  customsTerrainSurfaceCanvas,
  decodeCustomsTerrainControlPng,
} from './customs-terrain-surface.js';
import { buildCustomsTerrainControlAtlases } from './customs-terrain-control-atlas.js';
import { createCustomsTerrainPbrRuntime } from './customs-terrain-pbr-runtime.js';
import { normalizeCustomsAssetManifest } from './customs-asset-manifest.js';
import {
  applyCustomsAssetPlan,
  createCustomsAssetCache,
  createCustomsAssetLoaderHost,
  createThreeLoaderFactory,
  loadVerifiedCustomsGlb,
} from './customs-asset-loader.js';
import {
  createCustomsAssetAttachmentLedger,
  createCustomsAssetRegistry,
  customsAssetLinearMatrix,
  diffCustomsAssetPlan,
  planCustomsAssetFrame,
  resolveProceduralSuppression,
} from './customs-asset-runtime.js';
import { assertThreeRenderer, describeRendererGate } from './renderer-gate.js';
// The frame-time instrument (src/render-profiler.js). Its predicate is its own — see that module's
// header for why `?profile=` is deliberately NOT question (c) of the renderer gate: the two places
// the baseline has to be taken (a release `vite preview` on loopback, and the live site on the
// founder's GPU) are exactly the two `canShowDiagnosticReadouts()` answers false for.
import {
  PROFILE_PRESETS, PROFILE_SERIES_SCHEMA, buildPresetResult, buildProfileReport, createEventLedger,
  createPhaseLedger, createWaterfall, describeAblationSeries, describeDisjointObservability,
  describeGpuTiming, parseAblation, parseProfileRequest, summarizeGpuMemory, summarizeHeap,
  summarizeOverlayReflow,
} from './render-profiler.js';
import { createFloorSurfaceResolver, measuredSurfaceY } from './surfaces.js';
// The PLACE-LABEL tier contract — the same one the 2D map and the deck diorama draw from. Aliased
// on import so the four label tiers can never be confused with this file's own scene vocabulary.
import { styleFor as labelStyleFor, tierOf as labelTierOf } from './label-tier.js';
// …and the shared spelling of it. One definition of the leader's pieces and custom properties for
// both DOM passes (this overlay and the 2D Leaflet layer) — see src/label-chrome.js.
import { LEADER_PIECES, labelCssProps } from './label-chrome.js';
// The MARKER vocabulary — src/icons.js's 17 badges, carried into this overlay by src/marker-overlay.js.
// Aliased on import for the same reason the label tier is: `tier` here means the MARKER ladder in
// src/lod.js (dot / icon / full), which is a different ladder from the four place-label tiers.
import { paintMarkerOverlay } from './marker-overlay.js';
import { currentTier as currentMarkerTier, updateTier as updateMarkerTier } from './lod.js';
import { buildTerrain, gameToTerrainTextureUv } from './terrain.js';
import { buildPropAsset } from './three-prop-assets.js';
import { DRAPE, drapedPanelMeshData, miteredEdges, planWallStructures, resamplePath } from './wall-runs.js';
import {
  RAILWAY_TRACK_PROFILE, THREE_POC_SCOPE, UNDERSTORY_TUFT_BUDGET, alphaCoverageMipChain,
  anchorOverlayMark, buildUnderstoryTuftPlan, cameraPose, centroid,
  createAsyncAttachGuard, disposeMaterialResources, drapedPrismStripMeshData, gameToWorld,
  grassTuftMeshData, inRing, makeTerrainSampler,
  markerOverlaySpec, parseThreeFx, pointPropPose, questZoneSpec, reconcileOrbitView,
  overlayScopeFromLimit, railwayTrackMeshData, terrainMeshData, updateThreeFx, withinOverlayScope,
  terrainRelativeDisplayY, visibleInteractionData,
} from './three-world.js';

const POC_MANIFEST = '/assets/3d/customs/scene-manifest.json';
const MATERIAL_URLS = {
  albedo: '/assets/3d/materials/ground106-albedo-512.png',
  normal: '/assets/3d/materials/ground106-normal-512.png',
  orm: '/assets/3d/materials/ground106-orm-512.png',
};
const THREE_FIXED_RELIEF = 2;
const CUSTOMS_EXACT_TERRAIN_DECIMATION = 1;
const VALID_LOOK = new Set(['realistic', 'vector']);
/**
 * Dev-only, loopback-only routes for the independently-authored vegetation pack and its runtime
 * texture arrays. Both packages live under `.local-candidates/`, OUTSIDE `public/`, so a
 * production build can neither copy them nor gain the routes that read them — a `fetch` here
 * simply 404s in `dist/`, which is exactly the fallback path below.
 */
const CUSTOMS_AUTHORED_VEGETATION_ROUTE = '/@vegetation-authored/';
const CUSTOMS_VEGETATION_ARRAY_ROUTE = '/@vegetation-arraytex/';
const VALID_VEGETATION_REQUEST = new Set(['procedural', 'authored']);
// A camera nudge smaller than this cannot move any placement across a LOD seam far enough to be
// worth a full 8,805-instance re-partition, so a slow orbit does not repack every frame. It gates
// TRANSLATION only — a projection change has no metre-scale equivalent and is never thresholded.
const AUTHORED_VEGETATION_REPACK_EPSILON_M = VEGETATION_REPACK_EPSILON_M;
/**
 * Does the authored forest cast into the sun's depth map?
 *
 * This is the MODULE DEFAULT only, and that distinction is load-bearing. It reads
 * `CUSTOMS_AUTHORED_VEGETATION_SHADOW_POLICY`, which is what
 * `createCustomsAuthoredVegetationRuntime()` falls back to when no `shadowPolicy` is passed — and a
 * caller CAN pass one. A gate that reads this constant while the meshes read the runtime's
 * normalised policy is one indirection away from describing two different policies: buckets would
 * become casters whose `count` and `visible` change on every 4 m repack with the invalidation
 * compiled out, i.e. a per-camera stale shadow standing under a comment asserting it cannot happen.
 *
 * So this is the DEFAULT, and `repackAuthoredVegetationNow()` reads the live runtime instead. The
 * two are asserted equal at mount, where a divergence is loud.
 */
const AUTHORED_VEGETATION_CASTS_SHADOWS = CUSTOMS_AUTHORED_VEGETATION_SHADOW_POLICY.mode !== 'disabled';
/**
 * An authored GLB entering or leaving the streaming root -> the enum reason that names it.
 *
 * A table rather than a ternary so an unrecognised kind hits `invalidate()`'s closed-enum throw
 * instead of being silently filed under 'attach'.
 */
const AUTHORED_ASSET_SHADOW_REASON = Object.freeze({
  attach: 'authored-asset-attach',
  detach: 'authored-asset-detach',
});
/*
 * There used to be a TACTICAL_PROP_CALLOUTS table here: two floating DOM chips, 'RED CONTAINER'
 * and 'TRAIN', anchored to `customs.prop.industrial_rail_yard.red_container_stack` and
 * `.locomotive_west`. Removed 2026-09-03 (founder: "idk why they show up" — they read as noise,
 * not landmarks). The two props themselves still render normally as 3D geometry; only the
 * always-on text chip above them is gone. Nothing else referenced the constant, so it and its
 * loop in refreshDynamic() were deleted outright rather than disabled.
 */
/**
 * Bridge structure colours, taken from the deck renderer's own table rather than reinvented here.
 *
 * `main.js` pins the Three renderer to the realistic look (`rendererMode === 'three' ? 'realistic'`)
 * and there is no look control for it, so one table is read once — the same `C.bridge` /
 * `C.bridgeRail` / `C.pier` that `src/map3d.js` draws its piers, edges and rails with.
 */
const BRIDGE_COLORS = paletteFor('realistic');
const rgb = (value, fallback = [128, 128, 128]) => {
  const c = Array.isArray(value) ? value : fallback;
  return new THREE.Color().setRGB(
    (c[0] || 0) / 255,
    (c[1] || 0) / 255,
    (c[2] || 0) / 255,
    THREE.SRGBColorSpace,
  );
};
const safeText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

export function customsExactTerrainSurfaceStatus({
  hasExactTerrain,
  pbrAvailable,
  paletteAvailable,
  look = 'realistic',
  detail = true,
} = {}) {
  if (!hasExactTerrain) return Object.freeze({ available: 'legacy-fallback', active: 'legacy-fallback' });
  const available = pbrAvailable
    ? 'exact-control-mask-12-layer-original-pbr'
    : paletteAvailable ? 'exact-control-mask-original-palette' : 'neutral-fallback';
  const active = look !== 'realistic'
    ? 'vector-flat'
    : detail === false ? 'detail-off-flat' : available;
  return Object.freeze({ available, active });
}

/**
 * What the CUSTOMS TRUTH strip is allowed to say, given what is actually on screen.
 *
 * Every segment of that strip used to be a claim about what was PLANNED, written once and never
 * re-read:
 *
 *   * `12-LAYER SURFACE MASKS` was painted the moment an exact terrain mesh compiled — before the
 *     control atlases had even been fetched. If they failed, every tile drew the neutral material
 *     and the strip said masks anyway;
 *   * `12-LAYER AUTHORED PBR` was written inside the `try` that BUILT the PBR runtime, so it
 *     survived every later flip to vector or `?fx=none`, both of which swap those same tiles to a
 *     flat material. `status.exactTerrain.surface` was already updated on that flip; the strip was
 *     not;
 *   * `N AUTHORED VEGETATION` came from the render plan's `renderedCount` — see
 *     `vegetationTruthSegment` in customs-vegetation-observability.js for the run where that read
 *     7,108 with zero authored placements on screen;
 *   * `FIXED RELIEF 2×` was a hand-typed `2` beside a `THREE_FIXED_RELIEF = 2` constant.
 *
 * So the strip is composed here, from measured state only, and repainted on the same tick as the
 * vegetation chip. `surface` is `customsExactTerrainSurfaceStatus()`'s result and the label comes
 * from its `active` field — what the tiles are drawing — never `available`. `vegetation` is the
 * `strip` field of ONE `describeVegetationObservability()` call, the same call the chip's
 * `indicator` comes from. `null` for either means "not resolved yet" and says so; it never
 * borrows the healthy wording while it waits.
 *
 * `state` is the strip's own colour key, and it is the WORST of the three: a green header over an
 * amber chip is the exact contradiction this whole pass exists to delete.
 */
export const CUSTOMS_TRUTH_SURFACE_COPY = Object.freeze({
  'exact-control-mask-12-layer-original-pbr': Object.freeze({ label: '12-LAYER AUTHORED PBR', state: 'exact' }),
  'exact-control-mask-original-palette': Object.freeze({ label: '12-LAYER SURFACE MASKS — NO PBR', state: 'degraded' }),
  'neutral-fallback': Object.freeze({ label: 'NEUTRAL SURFACE FALLBACK', state: 'degraded' }),
  'vector-flat': Object.freeze({ label: 'VECTOR FLAT SURFACE', state: 'requested' }),
  'detail-off-flat': Object.freeze({ label: 'FLAT SURFACE — DETAIL OFF', state: 'requested' }),
  'legacy-fallback': Object.freeze({ label: 'LEGACY TERRAIN FALLBACK', state: 'degraded' }),
});

/** exact < requested < pending < degraded. The strip wears the worst thing it is reporting. */
const TRUTH_STATE_RANK = Object.freeze({ exact: 0, requested: 1, pending: 2, degraded: 3 });
const worstTruthState = (...states) => states.reduce(
  (worst, state) => ((TRUTH_STATE_RANK[state] ?? 3) > (TRUTH_STATE_RANK[worst] ?? 3) ? state : worst),
  'exact',
);

/** The vegetation segment's contribution to the strip's colour, keyed off the shared indicator. */
function vegetationTruthState(vegetation) {
  if (!vegetation) return 'pending';
  if (vegetation.healthy) return 'exact';
  if (vegetation.state === 'loading') return 'pending';
  // ONE code means "you are looking at exactly what was asked for" rather than "something broke":
  // the query switch. Painting that amber trains the reader to ignore the one colour that has to
  // mean something.
  //
  // `promoted-vegetation-missing` used to be the second one, and losing that exemption is the whole
  // point of this pass. While the pack was gated, a release build with no authored forest WAS the
  // shipped configuration and amber would have been a false alarm. The pack ships now, so the same
  // frame is a failed load, and a fallback that reads as the design is exactly the defect handoff
  // §6 is about. It is degraded, in every environment.
  if (vegetation.code === 'authored-disabled-by-query') return 'requested';
  return 'degraded';
}

/**
 * The ground the RELEASE build is drawing, when there is no exact local terrain to draw instead.
 *
 * The public heightfield is textured by the shared realistic terrain bake (`buildTerrain()`'s
 * semantic ground atlas). If that bake fails, the tiles fall back to a tileable material — a real
 * degradation, and the only one of these two that should read as one.
 */
export const CUSTOMS_PUBLIC_SURFACE_COPY = Object.freeze({
  'semantic-ground-atlas': Object.freeze({ label: 'SEMANTIC GROUND ATLAS', state: 'requested' }),
  'tileable-fallback': Object.freeze({ label: 'TILEABLE GROUND FALLBACK', state: 'degraded' }),
});

/**
 * @param {boolean} localEnhancements Whether local game-derived data was even ALLOWED to load
 *   (`canLoadLocalGameDerivedAssets()`). This is the difference between "the exact package was
 *   permitted and did not arrive" — a defect, amber — and "this is a release build serving public
 *   data, exactly as designed" — not a defect. Without it the production strip called its own
 *   intended configuration a failure, and read `LEGACY TERRAIN FALLBACK · LOCALHOST` on a page
 *   that is neither legacy nor localhost.
 * @param {string|null} publicSurface Which ground material the public heightfield is wearing, when
 *   `localEnhancements` is false. `null` means not resolved yet.
 */
export function customsTruthStripCopy({
  hasExactTerrain = false,
  surface = null,
  vegetation = null,
  relief = THREE_FIXED_RELIEF,
  localEnhancements = true,
  publicSurface = null,
  // Which terrain package is drawn: `'local-package'`, `'promoted-public'`, or null when the
  // exact ground is not on screen. Since the terrain promotion, EXACT and LOCAL are different
  // facts, and a strip that says "EXACT LOCAL TERRAIN" on tarkovzero.com is wrong about the second
  // one even though it is right about the first.
  terrainDistribution = null,
} = {}) {
  const releasePublicData = !hasExactTerrain && !localEnhancements;
  let surfaceCopy;
  if (hasExactTerrain) {
    surfaceCopy = surface
      ? (CUSTOMS_TRUTH_SURFACE_COPY[surface.active]
        ?? Object.freeze({ label: String(surface.active ?? 'UNKNOWN SURFACE').toUpperCase(), state: 'degraded' }))
      : Object.freeze({ label: 'RESOLVING SURFACE', state: 'pending' });
  } else if (releasePublicData) {
    surfaceCopy = publicSurface
      ? (CUSTOMS_PUBLIC_SURFACE_COPY[publicSurface]
        ?? Object.freeze({ label: String(publicSurface).toUpperCase(), state: 'degraded' }))
      : Object.freeze({ label: 'RESOLVING SURFACE', state: 'pending' });
  } else {
    // Local data was permitted and did not arrive. The first segment already names that fallback;
    // repeating it as the surface label would pad the strip without adding a fact.
    surfaceCopy = Object.freeze({ label: 'LOCALHOST', state: 'degraded' });
  }
  const terrainSegment = hasExactTerrain
    ? (terrainDistribution === 'promoted-public'
      ? 'EXACT TERRAIN — PROMOTED'
      : terrainDistribution === 'local-package'
        ? 'EXACT LOCAL TERRAIN'
        : 'EXACT TERRAIN')
    // A release build reaching this branch is no longer the intended configuration. Since the
    // terrain surfaces were promoted, production SHIPS the exact ground; falling back to the
    // heightfield fitted from spawn and loot points means the promoted package did not load. The
    // segment names that, and the state below is degraded — a fallback that reads as "requested"
    // is the metric-that-cannot-fail this file's own header warns about.
    : releasePublicData ? 'PUBLIC HEIGHTFIELD — PROMOTED TERRAIN MISSING' : 'LEGACY TERRAIN FALLBACK';
  const segments = [
    terrainSegment,
    surfaceCopy.label,
    vegetation ? vegetation.text : 'RESOLVING VEGETATION',
    `FIXED RELIEF ${relief}×`,
  ];
  return Object.freeze({
    title: hasExactTerrain ? 'CUSTOMS TRUTH' : releasePublicData ? 'CUSTOMS PUBLIC DATA' : 'THREE POC',
    detail: segments.join(' · '),
    segments: Object.freeze(segments),
    state: worstTruthState(
      // No exact terrain is now a degradation in EVERY environment. Before the promotion a release
      // build had no exact ground by design and 'requested' was the honest colour; now it has one
      // by design, so its absence is a failure wherever it happens.
      hasExactTerrain ? 'exact' : 'degraded',
      surfaceCopy.state,
      vegetationTruthState(vegetation),
    ),
  });
}

function disposeTree(root, { materials = false } = {}) {
  const disposed = { textures: new Set(), materials: new Set() };
  root.traverse?.((node) => {
    node.geometry?.dispose?.();
    if (materials) disposeMaterialResources(node.material, disposed);
  });
  root.clear();
}

function shapeFromRing(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const shape = new THREE.Shape();
  ring.forEach(([x, z], index) => {
    const [wx, wy] = gameToWorld(x, z);
    if (index === 0) shape.moveTo(wx, wy); else shape.lineTo(wx, wy);
  });
  shape.closePath();
  return shape;
}

function ribbonGeometry(path, width, H, lift = 0.05) {
  const points = (path || []).filter((p, i, all) => Array.isArray(p) && p.length >= 2
    && (i === 0 || Math.hypot(p[0] - all[i - 1][0], p[1] - all[i - 1][1]) > 1e-4));
  if (points.length < 2) return null;
  const positions = [], uvs = [], indices = [];
  let distance = 0;
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)], next = points[Math.min(points.length - 1, i + 1)];
    const dx = next[0] - prev[0], dz = next[1] - prev[1], len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len, nz = dx / len;
    if (i) distance += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    for (const side of [-1, 1]) {
      const x = points[i][0] + nx * width * side / 2;
      const z = points[i][1] + nz * width * side / 2;
      positions.push(...gameToWorld(x, z, H(x, z) + lift));
      uvs.push(distance / 12, side < 0 ? 0 : 1);
    }
    if (i) {
      const a = (i - 1) * 2, b = a + 1, c = i * 2, d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function lineGeometry(path, H, lift = 0.2) {
  const points = (path || []).filter((p) => Array.isArray(p) && p.length >= 2)
    .map(([x, z]) => new THREE.Vector3(...gameToWorld(x, z, H(x, z) + lift)));
  return points.length >= 2 ? new THREE.BufferGeometry().setFromPoints(points) : null;
}

/** The coverage a chain-link fragment must reach to be drawn at all. Shared with the mip builder. */
const CHAIN_LINK_ALPHA_TEST = 0.42;

/**
 * The diamond mask that makes a chain-link panel read as chain-link.
 *
 * It is drawn rather than shipped because it is four strokes, and because an alpha MASK — not a
 * blended translucent slab — is what lets the fence cast a fence-shaped shadow: `alphaTest` is
 * honoured by the depth pass, so the holes are holes to the shadow map too. Blending would give a
 * smoked-glass wall that shadows like a solid one.
 *
 * WHY THIS IS A HAND-MIPPED DataTexture AND NOT A CanvasTexture. Measured on the GPU's own mip
 * chain (`textureLod` readback, Chromium/ANGLE, WebGL2), the fraction of texels that clear
 * `alphaTest` on the shipped canvas texture ran 0.69 at LOD 0, 0.63 at LOD 1, 0.50 at LOD 2 and
 * **0 from LOD 3 down** — every fragment of every panel discarded. Two things did that:
 *
 *   * a box-filtered alpha mask loses coverage at every level (see `rescaleLevelToCoverage` in
 *     three-world.js, where the fix lives so it can be tested without a GPU), and
 *   * the texture was uploaded as sRGB, and an sRGB texture is DECODED BEFORE it is filtered, so
 *     the wire's 0.796 read as 0.60 and the tile mean landed at 0.4039 — just under the 0.42 test.
 *     In linear the same mask means 0.5412 and would have gone solid instead of gone.
 *
 * That is not an extreme-distance case. Measured on one real run (`fence:50`) at the default
 * browsing pose — zoom 5, rotationX 26 — its posts projected between 9 and 30 px per ground metre
 * across the frame, so the 0.62 m mask tile covered 6 to 19 px and the run sampled LOD 1.8 to 3.5
 * end to end. Everything past LOD 3 drew nothing at all, which is why the map showed rails and
 * posts with grass visible between them. So the mask now carries its own levels, is uploaded with
 * NO colour space (it is a coverage number, not a colour), and the wire's tint moved to
 * `material.color`, where no filter can eat it.
 */
function chainLinkAlphaTexture(size = 64) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.clearRect(0, 0, size, size);
  context.strokeStyle = '#ffffff';
  context.lineWidth = Math.max(1.5, size / 22);
  context.lineCap = 'square';
  // Two families of diagonals, wrapped, so the tile repeats without a visible seam.
  for (const sign of [1, -1]) {
    for (let offset = -size; offset <= size * 2; offset += size / 4) {
      context.beginPath();
      context.moveTo(offset, sign > 0 ? 0 : size);
      context.lineTo(offset + size, sign > 0 ? size : 0);
      context.stroke();
    }
  }

  // Coverage is the canvas ALPHA — white strokes on a cleared ground, so a texel's alpha is
  // exactly how much wire covers it, with no colour term to be decoded out from under it.
  const source = context.getImageData(0, 0, size, size).data;
  const alpha = new Float32Array(size * size);
  for (let index = 0; index < alpha.length; index++) alpha[index] = source[index * 4 + 3] / 255;
  const { mipmaps } = alphaCoverageMipChain(alpha, size, CHAIN_LINK_ALPHA_TEST);

  const texture = new THREE.DataTexture(mipmaps[0].data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.mipmaps = mipmaps;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  // NOT sRGB: three reads `alphaMap.g`, and a colour-space decode on a coverage mask is what put
  // its mean under `alphaTest` in the first place.
  texture.colorSpace = THREE.NoColorSpace;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

async function loadTexture(url, { color = false } = {}) {
  try {
    const texture = await new THREE.TextureLoader().loadAsync(url);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 4;
    if (color) texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  } catch (error) {
    console.warn(`[three-poc] texture unavailable: ${url}`, error);
    return null;
  }
}

function canvasGroundTexture(canvas, mapping) {
  if (!canvas) return null;
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'customs-semantic-ground-atlas';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 8;
  texture.flipY = mapping?.threeCanvasTextureFlipY !== false;
  texture.needsUpdate = true;
  return texture;
}

function exactTerrainScope(limit, manifest) {
  const points = Array.isArray(limit) ? limit.filter((point) => Array.isArray(point)
    && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]))) : [];
  if (points.length < 3) throw new Error('Customs playable limit is unavailable');
  const tiles = manifest?.tiles ?? [];
  const coverage = {
    minX: Math.min(...tiles.map((tile) => tile.origin.x)),
    maxX: Math.max(...tiles.map((tile) => tile.origin.x
      + (tile.resolution.columns - 1) * tile.sampleSpacingM.x)),
    minZ: Math.min(...tiles.map((tile) => tile.origin.z)),
    maxZ: Math.max(...tiles.map((tile) => tile.origin.z
      + (tile.resolution.rows - 1) * tile.sampleSpacingM.z)),
  };
  const xs = points.map((point) => Number(point[0]));
  const zs = points.map((point) => Number(point[1]));
  return {
    sourceFrame: CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME,
    minX: Math.max(coverage.minX, Math.min(...xs)),
    maxX: Math.min(coverage.maxX, Math.max(...xs)),
    minZ: Math.max(coverage.minZ, Math.min(...zs)),
    maxZ: Math.min(coverage.maxZ, Math.max(...zs)),
  };
}

function exactTerrainSampler(localPackage, fallback, elevationField = 'displayYM') {
  if (!localPackage?.runtime) return fallback;
  const bounds = localPackage.manifest.tiles.map((tile) => ({
    minX: tile.origin.x,
    maxX: tile.origin.x + (tile.resolution.columns - 1) * tile.sampleSpacingM.x,
    minZ: tile.origin.z,
    maxZ: tile.origin.z + (tile.resolution.rows - 1) * tile.sampleSpacingM.z,
  }));
  return (xValue, zValue) => {
    const x = Number(xValue), z = Number(zValue);
    if (!Number.isFinite(x) || !Number.isFinite(z)
      || !bounds.some((box) => x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ)) {
      return fallback(x, z);
    }
    return sampleCustomsTerrainElevation(localPackage.runtime, {
      sourceFrame: CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME,
      x,
      z,
    })[elevationField];
  };
}

async function loadLocalControlPixels(url, signal, cache = 'no-store') {
  const response = await fetch(url, {
    method: 'GET', mode: 'same-origin', credentials: 'same-origin', cache,
    redirect: 'error', signal,
  });
  if (!response.ok) throw new Error(`control map HTTP ${response.status}`);
  return decodeCustomsTerrainControlPng(await response.arrayBuffer());
}

async function loadExactTerrainSurfaceAssets(localPackage, signal) {
  if (!localPackage) return { createFallbackCanvases: null, controlAtlasSet: null };
  const tiles = await Promise.all(localPackage.assets.map(async (asset) => {
    const tile = localPackage.manifest.tiles.find((candidate) => candidate.id === asset.tileId);
    if (!tile) throw new Error(`missing exact terrain tile ${asset.tileId}`);
    // A promoted control map is an immutable public asset: `no-store` would re-download 2.8 MB of
    // PNG on every navigation for nothing. The local package stays uncached — it is regenerated.
    const controlCache = localPackage.distribution === 'promoted-public' ? 'default' : 'no-store';
    const controls = await Promise.all(asset.controlMaps.map(async (control, slot) => ({
      id: control.id,
      slot,
      ...await loadLocalControlPixels(control.url, signal, controlCache),
    })));
    const maxX = tile.origin.x + (tile.resolution.columns - 1) * tile.sampleSpacingM.x;
    const maxZ = tile.origin.z + (tile.resolution.rows - 1) * tile.sampleSpacingM.z;
    return {
      id: asset.tileId,
      origin: { x: tile.origin.x, z: tile.origin.z },
      bounds: { minX: tile.origin.x, maxX, minZ: tile.origin.z, maxZ },
      controls,
      layers: tile.layers,
    };
  }));
  return {
    controlAtlasSet: buildCustomsTerrainControlAtlases({
      tiles: tiles.map(({ layers: _layers, ...tile }) => tile),
    }),
    createFallbackCanvases: () => new Map(tiles.map((tile) => [
      tile.id,
      customsTerrainSurfaceCanvas(tile.controls, tile.layers),
    ])),
  };
}

function exactSurfaceTexture(canvas, tileId) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = `customs-exact-surface:${tileId}`;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 8;
  // PNG/canvas row zero is z-min and control UV-v zero is z-min. Do not apply
  // Three's usual display-image flip; this is a geospatial raster, not a photo.
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

function detailUvsForExactPatch(patch) {
  const detailUvs = new Float32Array(patch.vertexCount * 2);
  for (let index = 0; index < patch.vertexCount; index++) {
    detailUvs[index * 2] = -patch.positions[index * 3] / 32;
    detailUvs[index * 2 + 1] = -patch.positions[index * 3 + 1] / 32;
  }
  return detailUvs;
}

function smoothExactTerrainSeamNormals(meshes) {
  const byPosition = new Map();
  for (const mesh of meshes) {
    const positions = mesh.geometry.getAttribute('position');
    const normals = mesh.geometry.getAttribute('normal');
    for (let index = 0; index < positions.count; index++) {
      const key = `${positions.getX(index).toFixed(5)}|${positions.getY(index).toFixed(5)}|${positions.getZ(index).toFixed(5)}`;
      if (!byPosition.has(key)) byPosition.set(key, []);
      byPosition.get(key).push({ normals, index });
    }
  }
  for (const matches of byPosition.values()) {
    if (matches.length < 2) continue;
    const normal = new THREE.Vector3();
    for (const match of matches) {
      normal.x += match.normals.getX(match.index);
      normal.y += match.normals.getY(match.index);
      normal.z += match.normals.getZ(match.index);
    }
    normal.normalize();
    for (const match of matches) match.normals.setXYZ(match.index, normal.x, normal.y, normal.z);
  }
  for (const mesh of meshes) mesh.geometry.getAttribute('normal').needsUpdate = true;
}

function makeGroundcoverTextures(size = 128) {
  const texelCount = size * size;
  const height = new Float32Array(texelCount);
  const albedo = new Uint8Array(texelCount * 4);
  const normal = new Uint8Array(texelCount * 4);
  const hash2 = (x, y) => {
    let value = Math.imul(x + 17, 0x45d9f3b) ^ Math.imul(y + 31, 0x119de1f3);
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    return ((value ^ (value >>> 16)) >>> 0) / 0x100000000;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x, u = x / size, v = y / size;
      const macro = Math.sin(u * Math.PI * 4 + 0.6) * 0.5
        + Math.sin(v * Math.PI * 6 - 1.1) * 0.3
        + Math.sin((u + v) * Math.PI * 8) * 0.2;
      const grain = hash2(x, y) - 0.5;
      const straw = hash2(x + 211, y - 97) > 0.965 ? 1 : 0;
      height[i] = macro * 0.38 + grain * 0.62;
      albedo[i * 4] = Math.round(92 + macro * 12 + grain * 15 + straw * 42);
      albedo[i * 4 + 1] = Math.round(136 + macro * 18 + grain * 18 + straw * 15);
      albedo[i * 4 + 2] = Math.round(56 + macro * 8 + grain * 10 + straw * 10);
      albedo[i * 4 + 3] = 255;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sample = (sx, sy) => height[((sy + size) % size) * size + ((sx + size) % size)];
      const dx = (sample(x + 1, y) - sample(x - 1, y)) * 1.15;
      const dy = (sample(x, y + 1) - sample(x, y - 1)) * 1.15;
      const invLength = 1 / Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      normal[i] = Math.round((-dx * invLength * 0.5 + 0.5) * 255);
      normal[i + 1] = Math.round((-dy * invLength * 0.5 + 0.5) * 255);
      normal[i + 2] = Math.round((invLength * 0.5 + 0.5) * 255);
      normal[i + 3] = 255;
    }
  }
  const configure = (texture, { color = false } = {}) => {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = 4;
    if (color) texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  };
  return {
    albedo: configure(new THREE.DataTexture(albedo, size, size, THREE.RGBAFormat), { color: true }),
    normal: configure(new THREE.DataTexture(normal, size, size, THREE.RGBAFormat)),
  };
}

function grassTuftGeometry(blades, taperedQuad) {
  const { positions, uvs, indices } = grassTuftMeshData(blades, taperedQuad);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function exactVegetationInstancedMesh({
  geometry,
  material,
  placements,
  name,
  component,
  castShadow = false,
  transform,
}) {
  if (!placements.length) return null;
  const mesh = new THREE.InstancedMesh(geometry, material, placements.length);
  mesh.name = name;
  mesh.userData = {
    kind: 'exact-local-vegetation',
    component,
    source: 'terrain-tree-instance-scalars',
    placementAccuracy: 'canonical-game-authored',
    geometryAccuracy: 'original-procedural-class-proxy',
    instances: placements.length,
  };
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  placements.forEach((placement, index) => {
    dummy.position.set(...placement.presentationPosition);
    // `presentationPosition` is the reflected [-x, -z, y] world, so a positive Unity yaw about
    // +Y becomes a negative rotation about world +Z. Match the authored `Rz(-yaw)` convention and
    // the legacy tree/player fallbacks; a positive sign here mirrored every non-cardinal asset.
    dummy.rotation.set(0, 0, -placement.yawRadians);
    dummy.scale.set(1, 1, 1);
    transform(dummy, placement);
    dummy.updateMatrix();
    mesh.setMatrixAt(index, dummy.matrix);
    tint.setRGB(placement.tint.r, placement.tint.g, placement.tint.b);
    mesh.setColorAt(index, tint);
  });
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  mesh.computeBoundingSphere();
  return mesh;
}

/** Seat one authored instance in the runtime frame, then tag it for picking. */
export function seatAuthoredInstance(scene, instance, { displayYFor }) {
  // A cached unique glTF scene can leave and re-enter the stream. Picking proxies are runtime
  // furniture, not authored nodes, so remove the previous seating's proxy before adding the
  // current one. Otherwise every re-entry would add another invisible geometry and the old
  // proxy's disabled raycast method would survive into the new seating.
  const stalePickingProxies = [];
  scene.traverse?.((node) => {
    if (node.userData?.kind === 'authored-picking-proxy') stalePickingProxies.push(node);
  });
  for (const proxy of stalePickingProxies) {
    proxy.removeFromParent?.();
    proxy.geometry?.dispose?.();
    if (Array.isArray(proxy.material)) proxy.material.forEach((material) => material?.dispose?.());
    else proxy.material?.dispose?.();
  }

  const { position } = instance.transform;
  const displayY = typeof displayYFor === 'function'
    ? displayYFor(position.x, position.z, position.y)
    : position.y;
  const [worldX, worldY, worldZ] = gameToWorld(position.x, position.z, displayY);
  // The exact EFT -> runtime change of basis has determinant -1. Preserve that reflection in
  // the complete affine matrix; a quaternion or setRotationFromMatrix would silently lose it
  // and place zero-yaw assets facing backward.
  const linear = customsAssetLinearMatrix(
    instance.gltf,
    instance.transform.rotation,
    instance.transform.scale,
  );
  scene.matrix.set(
    linear[0], linear[1], linear[2], worldX,
    linear[3], linear[4], linear[5], worldY,
    linear[6], linear[7], linear[8], worldZ,
    0, 0, 0, 1,
  );
  scene.matrixAutoUpdate = false;
  scene.matrixWorldNeedsUpdate = true;

  const castsAtThisLod = instance.shadow.lodLevel == null
    || instance.shadow.lodLevel === instance.lodLevel;
  const castShadow = castsAtThisLod
    && (instance.shadow.mode === 'cast' || instance.shadow.mode === 'both');
  const receiveShadow = instance.shadow.mode === 'receive' || instance.shadow.mode === 'both';
  scene.userData = {
    ...scene.userData,
    kind: 'authored-asset',
    label: safeText(instance.label ?? instance.stableId),
    stableId: instance.stableId,
    instanceId: instance.instanceId,
    featureId: instance.featureId,
    floor: instance.floor,
    interior: instance.interior,
    assetId: instance.assetId,
    lodLevel: instance.lodLevel,
    source: 'authored-manifest-v2',
  };
  scene.traverse((node) => {
    if (!node.isMesh) return;
    node.castShadow = castShadow;
    node.receiveShadow = receiveShadow;
    node.userData.stableId ||= instance.stableId;
    node.userData.floor ??= instance.floor;
    // A 120k-triangle mesh must not silently become the raycast target. Only assets that
    // declared `picking.shape: 'lod-mesh'` stay in the picking set; the rest are marked out of
    // it and the coarse proxy shape is the staged follow-up.
    node.userData.authoredOriginalRaycast ??= node.raycast;
    node.userData.pickable = instance.pickable
      && instance.picking.shape === 'lod-mesh'
      && instance.picking.lodLevel === instance.lodLevel;
    node.raycast = node.userData.pickable ? node.userData.authoredOriginalRaycast : () => {};
  });

  if (instance.pickable && (instance.picking.shape === 'box' || instance.picking.shape === 'sphere')) {
    const { centerM, sizeM } = instance.bounds;
    const inflate = instance.picking.inflateM;
    const geometry = instance.picking.shape === 'box'
      ? new THREE.BoxGeometry(sizeM.x + inflate * 2, sizeM.y + inflate * 2, sizeM.z + inflate * 2)
      : new THREE.SphereGeometry(Math.hypot(sizeM.x, sizeM.y, sizeM.z) / 2 + inflate, 12, 8);
    // `material.visible=false` keeps this out of the render pass while Three's Raycaster still
    // intersects it. `Object3D.visible=false` would also remove it from picking.
    const material = new THREE.MeshBasicMaterial({ visible: false, toneMapped: false });
    const proxy = new THREE.Mesh(geometry, material);
    proxy.name = `${instance.stableId}:picking-${instance.picking.shape}`;
    proxy.position.set(centerM.x, centerM.y, centerM.z);
    proxy.userData = {
      kind: 'authored-picking-proxy',
      label: safeText(instance.label ?? instance.stableId),
      stableId: instance.stableId,
      featureId: instance.featureId,
      pickable: true,
      collisionShape: instance.collision.shape,
    };
    scene.add(proxy);
  }
  return scene;
}

/** Convert the real Z-up runtime focus back to canonical EFT map coordinates. */
export function authoredCameraFromWorldTarget(target) {
  const worldX = Number(Array.isArray(target) ? target[0] : target?.x);
  const worldY = Number(Array.isArray(target) ? target[1] : target?.y);
  if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) {
    throw new Error('authored streaming requires a finite runtime camera target');
  }
  return { x: -worldX, z: -worldY };
}

/** Every failed ledger entry is status-visible exactly once, including host and attach errors. */
export function customsAssetLedgerFailureMessages(ledger) {
  return [...new Set(
    ledger.failedIds().sort().map((instanceId) => (
      `${instanceId}: ${ledger.errorOf(instanceId) ?? 'unknown error'}`
    )),
  )];
}

function clearAuthoredPickingProxies(node) {
  const proxies = [];
  node?.traverse?.((child) => {
    if (child.userData?.kind === 'authored-picking-proxy') proxies.push(child);
  });
  for (const proxy of proxies) {
    proxy.removeFromParent?.();
    proxy.geometry?.dispose?.();
    if (Array.isArray(proxy.material)) proxy.material.forEach((material) => material?.dispose?.());
    else proxy.material?.dispose?.();
  }
}

/**
 * Long-lived, camera-driven authored asset streamer.
 *
 * `update()` is intentionally cheap to call from every real camera change. While a pass is in
 * flight, new targets overwrite one pending slot; the drain performs the latest target next,
 * never overlaps loader passes, and preserves the previous plan so cell and LOD hysteresis work.
 * The loader host and decoded cache are injected view-lifetime resources and are not disposed
 * here. `dispose()` only aborts this controller; the owning view tears those shared resources
 * down exactly once.
 */
/**
 * The resolved procedural-suppression set, reduced to a string that changes iff the set changed.
 *
 * WHY A KEY EXISTS AT ALL. The authored streamer calls `publishState()` on EVERY pass — before its
 * own empty-diff early return — and every OrbitControls 'change' runs a pass. So without a dirty
 * check the whole suppression pass ran on every frame of a drag: restore-and-re-hide the same nodes,
 * rewrite 11 `InstancedMesh` buffers with identical matrices, and re-bake the 2048² shadow depth
 * map. That last one negated P1 in the only regime where frame time exists (this app renders on
 * demand), and no measurement could see it, because `runPreset()` samples with the camera parked.
 *
 * WHAT IT MUST NOT DO is compare equal for two sets that differ, which would leave a procedural
 * proxy standing under its authored replacement forever. So:
 *   - `policy` and `kind` are in the key, not just `featureId` — a feature re-attached under a
 *     different suppression policy IS a different suppression;
 *   - it is ORDER-INDEPENDENT (`sort()`), because the ledger's iteration order is not a promise and
 *     a reordering is not a change;
 *   - the three fields are JSON-encoded rather than joined with a separator. A plain `a|b|c` join
 *     makes `{id:'a|building', kind:'x'}` and `{id:'a', kind:'building|x'}` the SAME string, and two
 *     different sets sharing a key is precisely the false skip that would strand a procedural proxy
 *     under its authored replacement. (Written as a separator join first; the test below caught it.)
 *
 * Exported purely so those properties are directly testable rather than argued for in a comment.
 */
export function proceduralSuppressionKey(entries = []) {
  return entries
    .map(({ featureId, policy, kind }) => JSON.stringify([String(featureId), String(kind), String(policy)]))
    .sort()
    .join('\n');
}

export function createAuthoredAssetStreamer({
  root,
  status,
  guard,
  signal = null,
  displayYFor,
  syncSuppression,
  loaderHost = null,
  cache = null,
  baseHref = globalThis.location?.href ?? 'http://localhost/',
  manifestInput = null,
  manifestUrl = POC_MANIFEST,
  fetchImpl = globalThis.fetch,
  loadAsset = null,
  onChanged = () => {},
  /*
   * The SCENE GRAPH changed — an authored node entered or left `root` — as opposed to `onChanged`,
   * which also fires for every status publish and therefore on every camera pass.
   *
   * They are separate because the renderer's two listeners want different things. `onChanged`
   * invalidates the FRAME, which is cheap and correct to do on a camera move. This one invalidates
   * the sun's frozen SHADOW MAP, and doing that on every camera pass would re-bake the depth map
   * throughout a pan — which is most of the cost the freeze exists to remove. `seatAuthoredInstance`
   * writes `castShadow` from the manifest, so an attach or a detach is a real caster change and this
   * is the only place in the streamer where one happens.
   */
  onCastersChanged = () => {},
} = {}) {
  if (!root?.add || !root?.remove) throw new Error('authored streamer requires a scene root');
  if (!status || typeof status !== 'object') throw new Error('authored streamer requires status');
  if (!guard?.attach) throw new Error('authored streamer requires an attachment guard');

  const streamAbort = new AbortController();
  const controllerErrors = new Set();
  let manifest = null;
  let registry = null;
  let ledger = null;
  let currentPlan = null;
  let pendingCamera = null;
  let drainPromise = null;
  let disposed = false;
  let initializationError = null;

  const abortFromOwner = () => streamAbort.abort(signal?.reason);
  if (signal?.aborted) abortFromOwner();
  else signal?.addEventListener?.('abort', abortFromOwner, { once: true });

  function resetManifestStatus() {
    status.manifest = {
      version: manifest.schemaVersion,
      proceduralFallback: manifest.proceduralFallback,
      declared: manifest.totals.instances,
      cells: manifest.totals.cells,
      replacements: manifest.totals.replacements,
      loaded: 0,
      visibleCells: [],
      camera: null,
      suppressed: [],
      retained: [],
      errors: [],
    };
  }

  function fatalStatus(error) {
    if (disposed || error?.name === 'AbortError') return;
    const message = `${error?.code ? `${error.code} ` : ''}${error?.message ?? error}`;
    status.manifest = {
      version: null, proceduralFallback: true, declared: 0, cells: 0, replacements: 0,
      loaded: 0, visibleCells: [], camera: null, suppressed: [], retained: [],
      errors: [message],
    };
    onChanged();
  }

  function authoredNodeFor(instance) {
    return root.children.find((child) => (
      child.userData?.instanceId === instance.instanceId
      || child.userData?.stableId === instance.stableId
    ));
  }

  function detachInstance(instance) {
    // GLTF geometry and materials are cache-owned and may be shared by prototype clones. Only
    // runtime-created picking proxies are disposed here; the authored node is simply detached.
    const node = authoredNodeFor(instance);
    if (!node) return false;
    clearAuthoredPickingProxies(node);
    root.remove(node);
    onCastersChanged('detach');
    onChanged();
    return true;
  }

  function publishState() {
    if (!registry || !ledger || disposed || !guard.active) return;
    const resolved = resolveProceduralSuppression(registry, ledger);
    let synchronized = { applied: [], retained: [] };
    try {
      synchronized = syncSuppression?.(resolved.suppressed) ?? synchronized;
    } catch (error) {
      controllerErrors.add(`suppression sync: ${error?.message ?? error}`);
      synchronized = {
        applied: [],
        retained: resolved.suppressed.map((entry) => ({
          featureId: entry.featureId,
          reason: `attached, but procedural suppression failed for ${entry.kind}`,
        })),
      };
    }
    const applied = new Set((synchronized.applied ?? []).map((entry) => (
      typeof entry === 'string' ? entry : entry.featureId
    )));
    const retained = [
      ...resolved.retained.map((entry) => ({ featureId: entry.featureId, reason: entry.reason })),
      ...(synchronized.retained ?? []),
      ...resolved.suppressed
        .filter((entry) => !applied.has(entry.featureId)
          && !(synchronized.retained ?? []).some((row) => row.featureId === entry.featureId))
        .map((entry) => ({
          featureId: entry.featureId,
          reason: `attached, but this renderer cannot retire a procedural ${entry.kind}`,
        })),
    ];
    const retainedKeys = new Set();
    status.manifest.loaded = ledger.attachedIds().length;
    status.manifest.visibleCells = [...(currentPlan?.visibleCellIds ?? [])];
    status.manifest.camera = currentPlan ? { ...currentPlan.camera } : null;
    status.manifest.suppressed = [...applied];
    status.manifest.retained = retained.filter((entry) => {
      const key = `${entry.featureId}|${entry.reason}`;
      if (retainedKeys.has(key)) return false;
      retainedKeys.add(key);
      return true;
    });
    status.manifest.errors = [...new Set([
      ...customsAssetLedgerFailureMessages(ledger),
      ...controllerErrors,
    ])];
    onChanged();
  }

  async function initialize() {
    try {
      if (manifestInput) manifest = normalizeCustomsAssetManifest(manifestInput);
      else {
        if (typeof fetchImpl !== 'function') throw new Error('manifest fetch is unavailable');
        const response = await fetchImpl(manifestUrl, {
          method: 'GET', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store',
          redirect: 'error', signal: streamAbort.signal,
        });
        if (!response.ok) throw new Error(`manifest HTTP ${response.status}`);
        manifest = normalizeCustomsAssetManifest(await response.json());
      }
      if (disposed || !guard.active || streamAbort.signal.aborted) return;
      registry = createCustomsAssetRegistry(manifest);
      ledger = createCustomsAssetAttachmentLedger();
      resetManifestStatus();
      publishState();
    } catch (error) {
      initializationError = error;
      fatalStatus(error);
    }
  }

  const ready = initialize();

  async function defaultLoadAsset(url, { request, signal: requestSignal }) {
    if (!loaderHost) throw new Error('authored loader host is unavailable');
    const { gltf } = await loaderHost.acquire();
    return loadVerifiedCustomsGlb({
      url,
      request,
      signal: requestSignal,
      parse: (bytes, gltfBaseUrl) => gltf.parseAsync(bytes, gltfBaseUrl),
    });
  }

  async function runPass(camera) {
    const nextPlan = planCustomsAssetFrame({
      registry,
      camera,
      previous: currentPlan,
      ledger,
    });
    const diff = diffCustomsAssetPlan(currentPlan, nextPlan);
    const entering = [...diff.enter, ...diff.relod];

    // A stale authored LOD must not overlap the replacement load. Restore the procedural proxy
    // before the first await, detach leaves/re-LODs, then let the ledger gate re-suppress only
    // after the replacement really attaches.
    for (const instance of [...diff.leave, ...diff.relod]) {
      detachInstance(instance);
      ledger.markDetached(instance.instanceId);
    }
    for (const instance of entering) ledger.markLoading(instance.instanceId);
    currentPlan = nextPlan;
    publishState();

    if (entering.length === 0 && diff.leave.length === 0) return;
    try {
      await applyCustomsAssetPlan({
        plan: nextPlan,
        manifest,
        ledger,
        loaderHost,
        cache,
        baseHref,
        signal: streamAbort.signal,
        // Leaves were detached synchronously above so fallback restoration is never delayed by
        // a loader await. `applyCustomsAssetPlan` still owns the entering/relod load lifecycle.
        diff: { enter: diff.enter, relod: diff.relod, leave: [] },
        load: loadAsset ?? defaultLoadAsset,
        attach(instance, gltf) {
          if (!gltf?.scene) throw new Error('decoded GLB has no scene');
          // Prototypes are placed more than once from one cached glTF, so each placement needs
          // its own node; geometry and materials remain cache-owned and shared.
          const node = registry.assetsById.get(instance.assetId).kind === 'prototype'
            ? gltf.scene.clone(true)
            : gltf.scene;
          detachInstance(instance);
          const seated = seatAuthoredInstance(node, instance, { displayYFor });
          try {
            const attached = guard.attach(seated, (resource) => root.add(resource));
            if (!attached) throw new Error('view torn down before attach');
          } catch (error) {
            // An attachment hook may fail after mutating the graph. Roll that partial mutation
            // back before the ledger marks failure, so restoring the proxy cannot leave an
            // untracked authored double in the same place.
            if (seated.parent === root) root.remove(seated);
            clearAuthoredPickingProxies(seated);
            // The rollback removed what the hook had already added, so the caster set moved twice
            // in one synchronous block. Report it anyway: a rollback that failed to restore the
            // graph must not be the one mutation the shadow map never hears about.
            onCastersChanged('detach');
            throw error;
          }
          onCastersChanged('attach');
          onChanged();
        },
        detach: detachInstance,
      });
    } catch (error) {
      for (const instance of entering) {
        if (ledger.stateOf(instance.instanceId) === 'loading') {
          ledger.markFailed(instance.instanceId, error);
        }
      }
      if (entering.length === 0) controllerErrors.add(error?.message ?? String(error));
    } finally {
      if (!disposed && guard.active) publishState();
    }
  }

  async function drain(resolveIdle) {
    try {
      await ready;
      if (initializationError || !registry) return;
      while (!disposed && guard.active && !streamAbort.signal.aborted && pendingCamera) {
        const camera = pendingCamera;
        pendingCamera = null;
        await runPass(camera);
      }
    } catch (error) {
      if (disposed || error?.name === 'AbortError') return;
      controllerErrors.add(`stream pass: ${error?.message ?? error}`);
      if (registry && ledger) publishState();
      else fatalStatus(error);
    } finally {
      // Clear the shared idle promise in the same async continuation that observed an empty
      // pending slot. There is no promise-reaction gap where update() could enqueue work yet
      // receive a promise that settles before that work runs.
      drainPromise = null;
      resolveIdle();
      if (!disposed && pendingCamera) update(pendingCamera);
    }
  }

  function update(camera) {
    if (disposed || streamAbort.signal.aborted) return Promise.resolve(false);
    const x = Number(camera?.x), z = Number(camera?.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      return Promise.reject(new Error('authored streamer update requires finite camera {x, z}'));
    }
    pendingCamera = { x, z };
    if (!drainPromise) {
      let resolveIdle;
      drainPromise = new Promise((resolve) => { resolveIdle = resolve; });
      void drain(resolveIdle);
    }
    return drainPromise;
  }

  return {
    get manifest() { return manifest; },
    get registry() { return registry; },
    get ledger() { return ledger; },
    get currentPlan() { return currentPlan; },
    get active() { return !disposed && !streamAbort.signal.aborted; },
    ready,
    update,
    dispose() {
      if (disposed) return;
      disposed = true;
      pendingCamera = null;
      signal?.removeEventListener?.('abort', abortFromOwner);
      streamAbort.abort();
      try { syncSuppression?.([]); } catch { /* view teardown remains best effort */ }
    },
  };
}

export async function createView3d(container, mapData, src) {
  // Question (a): may this renderer run? Customs, on an explicit request, in any environment.
  // One read of the query string feeds both halves, so the assertion and the published gate can
  // never disagree about what was asked for.
  const rendererRequest = new URLSearchParams(location.search).get('renderer');
  const rendererGate = describeRendererGate({
    dev: import.meta.env?.DEV === true,
    hostname: location.hostname,
    mapKey: mapData.key,
    rendererRequest,
  });
  assertThreeRenderer({
    mapKey: mapData.key,
    rendererRequest,
  });
  // Question (b): may it load local game-derived enhancements? Dev + loopback ONLY — unchanged.
  // In a release build the answer is no, so the request is never made: `loadCustomsLocalTerrainPackage`
  // would refuse the origin anyway (and the dev-only Vite route does not exist in `vite preview` or
  // on Vercel), but not asking is what lets the frame say "release build" instead of presenting an
  // unfetched package as a failure. This is layer 1 of four — see src/renderer-gate.js.
  const localEnhancementsAllowed = rendererGate.localEnhancements;
  // Question (c): may the CUSTOMS TRUTH strip and the vegetation notice be DRAWN? Dev + loopback.
  // Founder, 2026-09-02: "also remove the notification boxes in the middle about the build."
  //
  // This hides two DOM nodes and nothing else. Every number behind them is still computed on the
  // same tick, still published by `renderStats().truth` / `.vegetation`, and still what the e2e
  // gate asserts production's ground and forest against. A hidden banner is a presentation choice;
  // an unmeasured subsystem would be the metric-that-cannot-fail this file's header warns about.
  const diagnosticReadoutsVisible = rendererGate.diagnosticReadouts;
  const bootAt = performance.now();
  /*
   * Question (d): was a PROFILING RUN asked for? `?profile=1`, and nothing else — no `dev`, no
   * hostname, no map key. See src/render-profiler.js's header for why this is its own predicate in
   * its own module rather than a fourth function beside the gate's three: a run switch a visitor
   * types is not a boundary, and the gate's environment predicates are false in exactly the two
   * configurations (release preview on loopback; the live site on the founder's machine) where the
   * only real GPU in this project can be measured.
   *
   * It is read HERE, before the renderer is constructed, because it has to be. three 0.185.1 reads
   * `trackTimestamp` from the renderer's constructor parameters (`Backend.js:76`) and the WebGPU
   * backend folds its own feature check in at init, so the GPU timer cannot be switched on later.
   * A profiler that can only be armed at boot is the price of a GPU number that is real.
   */
  const profileRequest = parseProfileRequest(location.search);
  const profileWaterfall = profileRequest.armed ? createWaterfall() : null;
  // Bound once each, so the OFF path is an empty function call and not a `performance.now()` that
  // is computed and thrown away at a dozen mount sites.
  const wfBegin = profileWaterfall ? (name) => profileWaterfall.begin(name, performance.now() - bootAt) : () => {};
  const wfEnd = profileWaterfall ? (name) => profileWaterfall.end(name, performance.now() - bootAt) : () => {};
  const wfMark = profileWaterfall ? (name) => profileWaterfall.mark(name, performance.now() - bootAt) : () => {};
  wfMark('boot');
  const localTerrainAbort = new AbortController();
  const localTerrainRequest = localEnhancementsAllowed
    ? loadCustomsLocalTerrainPackage({ signal: localTerrainAbort.signal })
      .then((value) => ({ value, error: null }))
      .catch((error) => ({ value: null, error }))
    : Promise.resolve({ value: null, error: null });
  // The PROMOTED terrain surfaces (2026-09-02). Same bytes, shipped: `public/assets/3d/customs/
  // terrain/`, admitted by `asset-promotion-manifest.json` and re-proved by digest after every
  // build. This is what makes production draw the exact ground rather than the heightfield fitted
  // from spawn and loot points — the difference the founder saw when he said "not even the floor
  // ground correct".
  //
  // It is requested only when the local package is NOT allowed, and that is a bandwidth decision,
  // not a boundary one: on dev + loopback the identical surfaces are already coming from the local
  // route, and fetching 10.7 MiB of the same numbers twice would help nobody. Production takes
  // this branch, every time, with no gate involved.
  const promotedTerrainRequest = localEnhancementsAllowed
    ? Promise.resolve({ value: null, error: null })
    : loadCustomsPromotedTerrainPackage({ signal: localTerrainAbort.signal })
      .then((value) => ({ value, error: null }))
      .catch((error) => ({ value: null, error }));
  const localBridgeRequest = localEnhancementsAllowed
    ? loadCustomsLocalBridgesPackage({ signal: localTerrainAbort.signal })
      .then((value) => ({ value, error: null }))
      .catch((error) => ({ value: null, error }))
    : Promise.resolve({ value: null, error: null });
  wfBegin('mapDataFetch');
  const response = await fetch('/data/customs-3d.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Customs 3D data HTTP ${response.status}`);
  wfEnd('mapDataFetch');
  // Split from the fetch on purpose: this is 2.68 MB through a main-thread `JSON.parse`, and a
  // waterfall that folded it into "download" would send an optimiser after the wire.
  wfBegin('mapDataParse');
  const data = await response.json();
  wfEnd('mapDataParse');
  /*
   * The DOM-overlay gate, derived ONCE from the map's own playable limit — the same `data.limit`
   * the terrain, the buildings, the vegetation and `clampCamera()`'s `groundExtent` are built from.
   *
   * Until 2026-09-03 every overlay was gated on `THREE_POC_SCOPE`, a 360x300 m proof-of-concept
   * cell covering ~19% of a 1024x541 m map: 24 of 32 extracts and 20 of 32 place labels never
   * drew, while `renderStats()` still called the scope `customs-industrial-rail-yard` and reported
   * nothing that could see the loss. `overlayScopeFromLimit()` throws on a missing or non-finite
   * limit rather than falling back to a box (handoff §7 — no silent fallbacks).
   */
  const overlayScope = overlayScopeFromLimit(data.limit);
  // These two promises were CREATED before the map JSON was awaited, so this span is only what is
  // left of them; the waterfall's overlapping intervals are what make that visible.
  wfBegin('terrainPackage');
  const localTerrainOutcome = await localTerrainRequest;
  const promotedTerrainOutcome = await promotedTerrainRequest;
  wfEnd('terrainPackage');
  let exactTerrainPackage = localTerrainOutcome.value ?? promotedTerrainOutcome.value;
  let exactTerrainMesh = null;
  let exactTerrainError = localTerrainOutcome.error ?? promotedTerrainOutcome.error;
  if (exactTerrainPackage) {
    try {
      exactTerrainMesh = compileCustomsLocalTerrainMesh(
        exactTerrainPackage.runtime,
        exactTerrainScope(data.limit, exactTerrainPackage.manifest),
        { decimation: CUSTOMS_EXACT_TERRAIN_DECIMATION },
      );
    } catch (error) {
      exactTerrainError = error;
      exactTerrainPackage = null;
      exactTerrainMesh = null;
    }
  }
  let exactVegetation = null;
  let exactVegetationPlan = null;
  let exactVegetationError = null;
  // Which vegetation package the placements came from: `'local-package'`, `'promoted-public'`, or
  // null when there are none. Read off the package, never inferred from the gate — the same
  // discipline `exactTerrainSource` follows, and for the same reason.
  let exactVegetationSource = null;
  // The promoted package carries its own catalog and array index, so the mount reads them from the
  // ONE document it already fetched instead of asking a dev route that does not exist in
  // production. Null on the local path, where the dev routes are the answer.
  let promotedVegetationPackage = null;
  if (exactTerrainPackage && exactTerrainMesh) {
    try {
      wfBegin('vegetationPlacements');
      if (localEnhancementsAllowed) {
        // UNCHANGED. Still the loopback route, still the raw Unity dumps, still `localOnly: true`.
        exactVegetation = await loadCustomsLocalVegetation(exactTerrainPackage, {
          signal: localTerrainAbort.signal,
        });
        exactVegetationSource = 'local-package';
      } else {
        // The PROMOTED package (2026-09-02). Ordinary public assets under
        // `asset-promotion-manifest.json`; no gate is consulted because nothing it fetches is
        // local. `canLoadLocalGameDerivedAssets()` did not move — vegetation simply stopped being
        // one of the things it governs.
        promotedVegetationPackage = await loadCustomsPromotedVegetationPackage({
          signal: localTerrainAbort.signal,
        });
        exactVegetation = promotedVegetationPackage.vegetation;
        exactVegetationSource = 'promoted-public';
      }
      // ONE plan builder, two loaders. Two code paths that each build their own plan drift; a
      // single builder fed by two loaders cannot, so the promoted forest is the reviewed forest by
      // construction rather than by resemblance.
      exactVegetationPlan = buildCustomsLocalVegetationRenderPlan(exactVegetation, {
        scope: exactTerrainMesh.scope,
        reliefOriginYM: exactTerrainPackage.manifest.reliefOriginYM,
      });
      wfEnd('vegetationPlacements');
    } catch (error) {
      // Closed on the failure path too: an open phase is reported as "still running when the
      // report was taken", which would describe a load that gave up as one that never finished.
      wfEnd('vegetationPlacements');
      exactVegetationError = error;
      exactVegetation = null;
      exactVegetationSource = null;
      promotedVegetationPackage = null;
      console.warn(
        `[three-poc] ${localEnhancementsAllowed ? 'exact local' : 'promoted'} Customs vegetation`
        + ' unavailable; retaining reviewed fallback vegetation',
        error,
      );
    }
  }
  if (exactTerrainError) {
    console.info('[three-poc] exact Customs terrain unavailable; using complete legacy terrain', exactTerrainError);
  }
  // WHICH package is on screen, read off the package itself rather than inferred from the gate.
  // `null` means the exact ground is not drawn at all. Every readout below takes its wording from
  // this one value, so the strip, `renderStats()` and the vegetation notice cannot disagree about
  // where the ground came from.
  const exactTerrainSource = exactTerrainMesh ? (exactTerrainPackage?.distribution ?? null) : null;

  // -------------------------------------------------------------------------------------------
  // Local-only bridge corrections.
  //
  // `scripts/build-3d.mjs` emits a bridge only where a road/rail path crosses a WATER polygon, and
  // both Customs railway bridges span a ROAD — so that detector can never see them and they are
  // absent from `public/data/customs-3d.json` by construction. The Junk Bridge is hardcoded there
  // as a straight 22 m line that stops on a mid-river island. The corrections are game-derived, so
  // they are LOCAL ONLY (handoff §9): production keeps exactly the bridges customs-3d.json ships.
  //
  // The merge additionally REQUIRES the exact terrain. A local record states its deck's canonical
  // game Y, and a canonical Y is only meaningful against canonical ground: the public heightfield
  // is fitted from spawn and loot points, never sits on a riverbed (it reads -7.07 where the junk
  // bridge's own walkable planes sit at -12.97), and would seat these decks metres out. No exact
  // terrain, no authored bridges — and the reason is reported rather than inferred from a count.
  const localBridgeOutcome = await localBridgeRequest;
  let localBridgeMerge = null;
  let localBridgeReason = 'applied';
  if (!localEnhancementsAllowed) localBridgeReason = rendererGate.localEnhancementReason;
  else if (!exactTerrainMesh) localBridgeReason = 'requires-exact-terrain';
  else if (!localBridgeOutcome.value) localBridgeReason = 'package-unavailable';
  else localBridgeMerge = mergeCustomsLocalBridges(data.bridges, localBridgeOutcome.value);
  if (localBridgeOutcome.error && localEnhancementsAllowed) {
    console.info('[three-poc] local Customs bridge corrections unavailable; using public bridges', localBridgeOutcome.error);
  }
  if (localBridgeMerge?.unmatchedReplaceTargets.length) {
    console.warn('[three-poc] local bridge records name public bridges that no longer exist', localBridgeMerge.unmatchedReplaceTargets);
  }
  const bridgeRows = localBridgeMerge?.bridges ?? data.bridges ?? [];
  const localBridgeStatus = Object.freeze({
    applied: Boolean(localBridgeMerge),
    reason: localBridgeReason,
    added: localBridgeMerge?.added ?? 0,
    replaced: localBridgeMerge?.replaced ?? [],
    unmatchedReplaceTargets: localBridgeMerge?.unmatchedReplaceTargets ?? [],
    publicCount: data.bridges?.length ?? 0,
    error: localBridgeOutcome.error ? String(localBridgeOutcome.error.message) : null,
  });

  container.replaceChildren();
  container.classList.add('three-poc');
  const forceWebGL = new URLSearchParams(location.search).get('threeBackend') === 'webgl2';
  /*
   * `trackTimestamp` is the GPU-time switch, and it is a CONSTRUCTOR parameter on both backends.
   *
   *   WebGL2  → `EXT_disjoint_timer_query_webgl2`  (three 0.185.1: WebGLBackend.js:270, pool at
   *             renderers/webgl-fallback/utils/WebGLTimestampQueryPool.js:27)
   *   WebGPU  → `GPUFeatureName.TimestampQuery`    (webgpu/utils/WebGPUTimestampQueryPool.js)
   *
   * `Backend.js:76` reads it from these parameters and never again, so it cannot be turned on at
   * runtime — which is why `?profile=` has to be parsed at boot. When it is false, three's
   * `initTimestampQuery()` returns at its first line on every frame, which is exactly what happens
   * today: passing `false` here costs nothing that the current code does not already cost.
   */
  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL, trackTimestamp: profileRequest.armed });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.93;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
  try { renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; } catch {}
  wfBegin('rendererInit');
  await renderer.init();
  wfEnd('rendererInit');
  renderer.domElement.className = 'tz-three-canvas';
  renderer.domElement.setAttribute('aria-label', 'Three.js Customs renderer proof');
  container.append(renderer.domElement);

  const overlay = document.createElement('div');
  overlay.className = 'tz-three-overlay';
  // The CUSTOMS TRUTH strip. Every segment is written by `customsTruthStripCopy()` from measured
  // state, and repainted on the same tick as the vegetation chip below by `updateTruthReadouts()`
  // — the strip and the chip are two renderings of ONE observability call, so the frame can no
  // longer show a green claim directly above an amber contradiction. Here at boot neither the
  // control surfaces nor the vegetation mount has resolved, and the strip says exactly that
  // instead of borrowing the healthy wording while it waits.
  //
  // It is BUILT and PAINTED in every environment and only ATTACHED on dev + loopback (question (c)
  // above). Building it unconditionally is what keeps one code path: the composition, the state
  // ranking and the repaint tick are the same lines in production as on a dev box, so
  // `renderStats().truth` cannot describe a strip that was assembled differently from the one a
  // developer is reading. What production loses is the pixels.
  const proofChip = document.createElement('div');
  proofChip.className = 'tz-three-proof-chip';
  const proofChipTitle = document.createElement('b');
  const proofChipDetail = document.createElement('span');
  proofChip.append(proofChipTitle, proofChipDetail);
  // The last copy `paintTruthStrip` was given, so `renderStats()` publishes exactly what the strip
  // says (or would say) rather than re-deriving it from a second call that could drift.
  let truthStripCopy = customsTruthStripCopy({
    hasExactTerrain: Boolean(exactTerrainMesh),
    terrainDistribution: exactTerrainSource,
    localEnhancements: localEnhancementsAllowed,
  });
  const paintTruthStrip = (copy) => {
    truthStripCopy = copy;
    proofChip.dataset.state = copy.state;
    proofChipTitle.textContent = copy.title;
    proofChipDetail.textContent = copy.detail;
  };
  paintTruthStrip(truthStripCopy);
  if (diagnosticReadoutsVisible) overlay.append(proofChip);
  const hoverChip = document.createElement('div');
  hoverChip.className = 'tz-three-hover';
  hoverChip.hidden = true;
  overlay.append(hoverChip);
  // The vegetation status chip — see `updateTruthReadouts()` below, near
  // `vegetationObservabilitySnapshot`, for what drives it and why it cannot disagree with
  // `renderStats().vegetation.warnings` OR with the strip above it. Built here, alongside the rest
  // of the always-on HUD, so it exists on the very first frame rather than appearing only once a
  // mount is in flight.
  //
  // Same rule as the strip: built and painted everywhere, attached on dev + loopback only. Its
  // verdict still reaches `renderStats().vegetation.indicator` in production, which is where the
  // e2e gate reads it.
  const vegetationChip = document.createElement('div');
  vegetationChip.className = 'tz-veg-chip';
  vegetationChip.hidden = true;
  const vegetationChipHeadline = document.createElement('b');
  const vegetationChipDetail = document.createElement('span');
  vegetationChip.append(vegetationChipHeadline, vegetationChipDetail);
  if (diagnosticReadoutsVisible) overlay.append(vegetationChip);
  container.append(overlay);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CAM.fovy, 1, 0.25, 6000);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.screenSpacePanning = true;
  controls.zoomToCursor = true;
  controls.minPolarAngle = (90 - CAM.maxRotationX) * Math.PI / 180;
  controls.maxPolarAngle = (90 - CAM.minRotationX) * Math.PI / 180;

  const hemi = new THREE.HemisphereLight(0xcbd7d8, 0x727469, 2.05);
  const ambient = new THREE.AmbientLight(0x8a958d, 0.24);
  scene.add(hemi, ambient);
  const sun = new THREE.DirectionalLight(0xffedd0, 2.65);
  sun.position.set(-240, 340, 430);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -260;
  sun.shadow.camera.right = sun.shadow.camera.top = 260;
  sun.shadow.camera.near = 20;
  sun.shadow.camera.far = 1100;
  sun.shadow.bias = -0.00012;
  sun.shadow.normalBias = 0.025;
  sun.shadow.radius = 2.2;
  sun.target.position.set(...gameToWorld(THREE_POC_SCOPE.center.x, THREE_POC_SCOPE.center.z, 0));
  scene.add(sun, sun.target);
  /*
   * THE DEPTH MAP IS RENDERED ON CHANGE, NOT ON EVERY FRAME.
   *
   * Constructing the controller sets `sun.shadow.autoUpdate = false` and arms one bake. From here
   * on, every point at which a caster or the light can change calls `sunShadow.invalidate(<reason>)`
   * from the CLOSED enum in `src/shadow-invalidation.js` — which is where the reasoning, the
   * measured win, and the list itself live. A reason that is not on that list throws rather than
   * quietly doing nothing.
   *
   * `?shadows=live` puts three's per-frame behaviour back. It is the control arm of the
   * pixel-identity proof and the escape hatch if a stale shadow is ever seen.
   */
  const shadowRequest = parseShadowRequest(location.search);
  const sunShadow = createShadowController({
    shadow: sun.shadow,
    live: shadowRequest.live,
    now: () => performance.now(),
  });
  if (shadowRequest.unknown.length) {
    console.warn(`[three-poc] unrecognised shadow parameter(s) ignored: ${shadowRequest.unknown.join(', ')}`);
  }
  /*
   * A RESTORED GPU CONTEXT NEEDS A NEW BAKE, AND NOTHING ELSE WOULD ASK FOR ONE.
   *
   * This is the one stale path the freeze INTRODUCES and the one no fingerprint can see. On a WebGL2
   * context loss or a WebGPU device loss the backend reallocates every texture — the depth map
   * included — empty. Live, three re-renders it on the very next frame and the user never notices.
   * Frozen, nothing ever re-bakes it: the scene renders with a dead shadow map for the rest of the
   * session while every counter stays green and `?shadowAudit=1` reports `clean`, because the caster
   * set never changed. Two lines, and it closes a permanent silent whole-scene regression.
   */
  const invalidateShadowOnContextRestore = () => {
    sunShadow.invalidate('renderer-context-restored');
    invalidateRender(2);
  };
  renderer.domElement?.addEventListener?.('webglcontextrestored', invalidateShadowOnContextRestore);
  // WebGPU has no `webglcontextrestored`; the device exposes a `lost` promise instead. `?.` all the
  // way down because the backend may not be initialized yet and neither shape is guaranteed.
  try {
    renderer.backend?.device?.lost?.then?.(() => invalidateShadowOnContextRestore());
  } catch { /* no device on this backend; the WebGL2 listener above is the live path */ }

  const worldRoot = new THREE.Group();
  worldRoot.name = exactTerrainMesh ? 'customs-exact-local-world' : 'customs-procedural-fallback';
  const authoredRoot = new THREE.Group();
  authoredRoot.name = 'customs-authored-chunks';
  const dynamicRoot = new THREE.Group();
  dynamicRoot.name = 'customs-live-and-quests';
  // The authored vegetation buckets hang off their own top-level root rather than inside
  // `worldRoot`, whose `rebuildWorld()` starts with `disposeTree(worldRoot)`: a world rebuild must
  // not silently destroy 93 buckets it has no way to rebuild.
  const vegetationRoot = new THREE.Group();
  vegetationRoot.name = 'customs-authored-vegetation-root';
  scene.add(worldRoot, authoredRoot, vegetationRoot, dynamicRoot);
  const authoredAbort = new AbortController();
  const authoredGuard = createAsyncAttachGuard((lateScene) => disposeTree(lateScene, { materials: true }));
  const authoredLoaderHost = createCustomsAssetLoaderHost(createThreeLoaderFactory({ renderer }));
  const authoredAssetCache = createCustomsAssetCache();

  let groundBake = null, groundTextureMapping = null, groundCanvas = null;
  if (!exactTerrainMesh) {
    try {
      groundBake = buildTerrain(data, THREE_FIXED_RELIEF, { look: 'realistic' });
      groundTextureMapping = groundBake.groundTextureMapping;
      groundCanvas = groundBake.groundTexture('realistic');
    } catch (error) {
      groundBake = null;
      groundTextureMapping = null;
      groundCanvas = null;
      console.warn('[three-poc] semantic ground atlas unavailable; retaining the tileable fallback', error);
    }
  }
  let exactSurfaceCanvases = new Map(), exactSurfaceCanvasFactory = null;
  let exactControlAtlasSet = null, exactSurfaceError = null;
  if (exactTerrainMesh) {
    try {
      wfBegin('terrainSurfaces');
      const exactSurfaceAssets = await loadExactTerrainSurfaceAssets(
        exactTerrainPackage,
        localTerrainAbort.signal,
      );
      exactSurfaceCanvasFactory = exactSurfaceAssets.createFallbackCanvases;
      exactControlAtlasSet = exactSurfaceAssets.controlAtlasSet;
      wfEnd('terrainSurfaces');
    } catch (error) {
      wfEnd('terrainSurfaces');
      exactSurfaceError = error;
      exactSurfaceCanvasFactory = null;
      exactControlAtlasSet = null;
      console.warn('[three-poc] exact control surfaces unavailable; retaining exact geometry with a neutral material', error);
    }
  }
  let exactTerrainPbrRuntime = null, exactTerrainPbrError = null;
  let exactTerrainMaterials = new Map();
  if (exactControlAtlasSet) {
    let candidateRuntime = null;
    try {
      wfBegin('terrainPbr');
      candidateRuntime = await createCustomsTerrainPbrRuntime({
        controlAtlasSet: exactControlAtlasSet,
        renderer,
        signal: localTerrainAbort.signal,
      });
      wfEnd('terrainPbr');
      if (localTerrainAbort.signal.aborted) {
        candidateRuntime.dispose();
        candidateRuntime = null;
        const abortError = new Error('terrain PBR initialization was aborted');
        abortError.name = 'AbortError';
        throw abortError;
      }
      const candidateMaterials = new Map(exactTerrainMesh.patches.map((patch) => [
        patch.tileId,
        candidateRuntime.createTileMaterial(patch.tileId),
      ]));
      exactTerrainPbrRuntime = candidateRuntime;
      exactTerrainMaterials = candidateMaterials;
      exactSurfaceCanvasFactory = null;
      // No strip write here. This block knows only that the PBR runtime was BUILT; whether those
      // materials are what the tiles draw depends on `look` and `fx.detail`, which the user flips
      // at runtime. `updateTruthReadouts()` reads that, every tick, from the same
      // `customsExactTerrainSurfaceStatus()` call `renderStats().exactTerrain.surface` reports.
    } catch (error) {
      candidateRuntime?.dispose?.();
      wfEnd('terrainPbr');
      exactTerrainPbrError = error;
      console.warn('[three-poc] authored 12-layer terrain PBR unavailable; retaining exact-mask fallback', error);
    }
  }
  if (!exactTerrainPbrRuntime && exactSurfaceCanvasFactory) {
    try {
      exactSurfaceCanvases = exactSurfaceCanvasFactory();
    } catch (error) {
      exactSurfaceError ??= error;
      exactSurfaceCanvases = new Map();
      console.warn('[three-poc] exact-mask fallback could not be created; retaining neutral terrain', error);
    } finally {
      exactSurfaceCanvasFactory = null;
    }
  }
  const groundcoverTextures = makeGroundcoverTextures();
  const needsLegacyTerrainTextures = !exactTerrainMesh || !exactTerrainPbrRuntime;
  const textures = {
    groundAtlas: canvasGroundTexture(groundCanvas, groundTextureMapping),
    albedo: !needsLegacyTerrainTextures || groundCanvas
      ? null
      : await loadTexture(MATERIAL_URLS.albedo, { color: true }),
    normal: needsLegacyTerrainTextures ? await loadTexture(MATERIAL_URLS.normal) : null,
    orm: needsLegacyTerrainTextures ? await loadTexture(MATERIAL_URLS.orm) : null,
    grassAlbedo: groundcoverTextures.albedo,
    grassNormal: groundcoverTextures.normal,
  };
  // UV0 is the one-shot semantic atlas; UV1 remains world-repeat detail for normal/ORM.
  if (textures.normal) textures.normal.channel = 1;
  if (textures.orm) textures.orm.channel = 1;
  const exactSurfaceTextures = new Map([...exactSurfaceCanvases].map(([tileId, canvas]) => [
    tileId,
    exactSurfaceTexture(canvas, tileId),
  ]));
  if (!exactTerrainPbrRuntime) exactTerrainMaterials = new Map([...exactSurfaceTextures].map(([tileId, map]) => [
      tileId,
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map,
        normalMap: textures.normal,
        aoMap: textures.orm,
        roughnessMap: textures.orm,
        metalnessMap: textures.orm,
        normalScale: new THREE.Vector2(0.72, 0.72),
        aoMapIntensity: 0.72,
        roughness: 0.98,
        metalness: 0,
      }),
    ]));
  const chainLinkTexture = chainLinkAlphaTexture();
  const materials = {
    terrain: new THREE.MeshStandardMaterial({
      color: textures.groundAtlas ? 0xffffff : 0x9ea783,
      map: textures.groundAtlas ?? textures.albedo, normalMap: textures.normal,
      aoMap: textures.orm, roughnessMap: textures.orm, metalnessMap: textures.orm,
      normalScale: new THREE.Vector2(0.72, 0.72), aoMapIntensity: 0.72,
      roughness: 0.98, metalness: 0,
    }),
    terrainFlat: new THREE.MeshStandardMaterial({
      color: textures.groundAtlas ? 0xffffff : 0x8f9578,
      map: textures.groundAtlas ?? null,
      roughness: 1, metalness: 0,
    }),
    terrainExactFlat: new THREE.MeshStandardMaterial({ color: 0x6f735f, roughness: 1, metalness: 0 }),
    terrainVector: new THREE.MeshStandardMaterial({ color: 0x617061, roughness: 1, metalness: 0 }),
    grass: new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0x14220d, emissiveIntensity: 0.13,
      map: textures.grassAlbedo, normalMap: textures.grassNormal,
      normalScale: new THREE.Vector2(0.62, 0.62),
      roughness: 1, metalness: 0, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }),
    grassFlat: new THREE.MeshStandardMaterial({ color: 0x6f9148, roughness: 1, metalness: 0, side: THREE.DoubleSide }),
    grassVector: new THREE.MeshStandardMaterial({ color: 0x668a55, roughness: 1, metalness: 0, side: THREE.DoubleSide }),
    grassBlade: new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.94, metalness: 0, side: THREE.DoubleSide,
      emissive: 0x0b1607, emissiveIntensity: 0.1,
    }),
    grassBladeVector: new THREE.MeshStandardMaterial({ color: 0x78985c, roughness: 1, metalness: 0, side: THREE.DoubleSide }),
    road: new THREE.MeshStandardMaterial({ color: 0x575b55, roughness: 0.96, metalness: 0.01 }),
    dirt: new THREE.MeshStandardMaterial({ color: 0x756d5b, roughness: 1, metalness: 0 }),
    // The bridge deck keeps `road`; these three dress the structure the deck renderer already
    // draws (piers / edges / rails), in the deck renderer's own colours.
    bridgeEdge: new THREE.MeshStandardMaterial({ color: rgb(BRIDGE_COLORS.bridge), roughness: 0.94, metalness: 0.02 }),
    bridgeRail: new THREE.MeshStandardMaterial({ color: rgb(BRIDGE_COLORS.bridgeRail), roughness: 0.68, metalness: 0.24 }),
    pier: new THREE.MeshStandardMaterial({ color: rgb(BRIDGE_COLORS.pier), roughness: 0.96, metalness: 0.02 }),
    water: new THREE.MeshPhysicalMaterial({ color: 0x4f7474, roughness: 0.2, metalness: 0.06, transmission: 0.08, transparent: true, opacity: 0.86, side: THREE.DoubleSide }),
    // A chain-link panel is a surface with holes, not a translucent slab: `alphaTest` keeps it
    // opaque where the wire is, invisible where it is not, and shadow-casting in exactly that
    // shape. `chainLinkTexture` is null only when there is no DOM (tests), and the material then
    // degrades to a thin solid panel rather than disappearing.
    //
    // The wire's tint is the material COLOUR, not a `map`. The old map sampled the same masked
    // canvas, so every mip mixed the wire with the black of the holes and the fabric darkened
    // toward nothing as it minified — on top of the alpha collapse the mask itself was suffering.
    // The map carried exactly one colour where it drew at all, so nothing is lost by dropping it.
    //
    // Metalness is low on purpose. There is no environment map in this scene (three lights, no
    // IBL), so a metal has nothing to reflect: at 0.42 the fabric's vertical faces returned almost
    // no light and the little that survived the alpha test was black on dark grass.
    chainLink: new THREE.MeshStandardMaterial({
      color: 0x9aa096,
      alphaMap: chainLinkTexture,
      alphaTest: chainLinkTexture ? CHAIN_LINK_ALPHA_TEST : 0,
      transparent: false, side: THREE.DoubleSide,
      roughness: 0.78, metalness: 0.22,
    }),
    fenceSteel: new THREE.MeshStandardMaterial({ color: 0x7e837b, roughness: 0.62, metalness: 0.26 }),
    // A shade lighter than the run it interrupts, so the two jambs and the swung leaves separate
    // from the fabric either side of them instead of reading as more fence.
    gateSteel: new THREE.MeshStandardMaterial({ color: 0x9ba196, roughness: 0.54, metalness: 0.3 }),
    rail: new THREE.LineBasicMaterial({ color: 0x686762, transparent: true, opacity: 0.9 }),
    railSteel: new THREE.MeshStandardMaterial({ color: 0x5d615f, roughness: 0.44, metalness: 0.72 }),
    sleeper: new THREE.MeshStandardMaterial({ color: 0x554638, roughness: 0.96, metalness: 0.03 }),
    ballast: new THREE.MeshStandardMaterial({ color: 0x77756d, roughness: 1, metalness: 0 }),
    rock: new THREE.MeshStandardMaterial({ color: 0x75766c, roughness: 0.93, metalness: 0.01 }),
    trunk: new THREE.MeshStandardMaterial({ color: 0x514332, roughness: 1 }),
    foliage: new THREE.MeshStandardMaterial({ color: 0x5c7653, roughness: 0.98, side: THREE.DoubleSide }),
    pineFoliage: new THREE.MeshStandardMaterial({ color: 0x3e6248, roughness: 1, side: THREE.DoubleSide }),
    deciduousFoliage: new THREE.MeshStandardMaterial({ color: 0x58784e, roughness: 1, side: THREE.DoubleSide }),
    shrubFoliage: new THREE.MeshStandardMaterial({ color: 0x64764d, roughness: 1, side: THREE.DoubleSide }),
    groundPlant: new THREE.MeshStandardMaterial({ color: 0x708552, roughness: 1, side: THREE.DoubleSide }),
    quest: new THREE.MeshStandardMaterial({ color: 0xe7b64b, emissive: 0x4e2d00, emissiveIntensity: 0.45, roughness: 0.48 }),
    questZone: new THREE.MeshBasicMaterial({ color: 0xe7b64b, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }),
    questZoneLine: new THREE.LineBasicMaterial({ color: 0xf3cf7b, transparent: true, opacity: 0.92 }),
    player: new THREE.MeshStandardMaterial({ color: 0x38d6c8, emissive: 0x083f3a, emissiveIntensity: 0.75, roughness: 0.4 }),
    floorSurface: new THREE.MeshStandardMaterial({ color: 0x9a978d, transparent: true, opacity: 0.88, roughness: 1, side: THREE.DoubleSide }),
    outline: new THREE.LineBasicMaterial({ color: 0x232b27, transparent: true, opacity: 0.42 }),
    // ---- the four MAP-WIDE building-detail slots (contract.js MATERIAL_SLOTS 2..5). `wall` and
    // `roof` are per building and come from `materialForBuilding`; these four are shared by every
    // building on the map, which is what keeps the detail lane's draw-call delta bounded — one
    // extra call per building that uses one of them, never one per element.
    detailTrim: new THREE.MeshStandardMaterial({ color: 0xa8a79b, roughness: 0.8, metalness: 0.03 }),
    detailMetal: new THREE.MeshStandardMaterial({ color: 0x6f746f, roughness: 0.56, metalness: 0.55 }),
    detailGlazing: new THREE.MeshStandardMaterial({ color: 0x2b3c42, roughness: 0.24, metalness: 0.12 }),
    detailDark: new THREE.MeshStandardMaterial({ color: 0x1b1f1c, roughness: 0.94, metalness: 0.02 }),
    // The skirt under a building on a cross-slope. UNLIT (`MeshBasic`) and near-black, exactly as
    // the deck renderer draws it — `src/buildings.js` documents why a lit, wall-coloured plinth put
    // 19.3 m of apparent building under a 9.5 m roof.
    plinth: new THREE.MeshBasicMaterial({ color: rgb(plinthColor('realistic')) }),
  };
  const buildingMaterials = new Map();
  const propMaterials = new Map();
  const materialForBuilding = (building, roof = false) => {
    const place = safeText(building.place ?? building.name);
    // `building.roof` is an AUTHORED roof colour on 18 of the 71 Customs rows and this renderer
    // threw it away (`grep '.roof' map3d-three.js` returned nothing before this lane): every roof
    // was the wall colour scaled by a constant. Reading it is free differentiation — no extra
    // draw call, no extra geometry — and it is what makes a roof-slot detail element read as roof.
    const authoredRoof = roof && Array.isArray(building.roof) ? building.roof : null;
    // The authored colour is part of the key: two rows can share a `place` and differ here, and a
    // key that ignored it would hand the second row the first one's material.
    const key = `${place || building.kind}:${roof ? 'roof' : 'wall'}:${authoredRoof ? authoredRoof.join(',') : ''}`;
    if (buildingMaterials.has(key)) return buildingMaterials.get(key);
    const base = authoredRoof ?? building.color ?? (place.includes('Dorms') ? [176, 151, 132] : [145, 145, 136]);
    const color = rgb(base);
    if (roof && !authoredRoof) color.multiplyScalar(place.includes('Dorms') ? 0.7 : 0.82);
    const material = new THREE.MeshStandardMaterial({ color, roughness: roof ? 0.84 : 0.78, metalness: building.kind?.includes('industrial') ? 0.12 : 0.02 });
    buildingMaterials.set(key, material);
    return material;
  };
  /**
   * The six-slot material array every building mesh carries, in `MATERIAL_SLOTS` order, so a
   * group's `materialSlot` from a planner indexes it directly. Slots 0/1 are the building's own;
   * slots 2-5 are the shared map-wide four.
   */
  const buildingSlotMaterials = (building) => [
    materialForBuilding(building, false),
    materialForBuilding(building, true),
    materials.detailTrim,
    materials.detailMetal,
    materials.detailGlazing,
    materials.detailDark,
  ];
  const materialForProp = (prop, role = 'body') => {
    const color = Array.isArray(prop.color) ? prop.color : [105, 109, 105];
    const metallic = ['container', 'railcar', 'vehicle', 'tanker', 'tank'].includes(prop.type);
    const key = `${prop.type ?? 'prop'}:${color.join(',')}:${metallic}:${role}`;
    const tone = rgb(color);
    if (role === 'dark') tone.multiplyScalar(0.29);
    else if (role === 'metal') tone.set(0x5c615e);
    else if (role === 'glass') tone.set(0x263b3d);
    if (!propMaterials.has(key)) propMaterials.set(key, new THREE.MeshStandardMaterial({
      color: tone,
      roughness: role === 'glass' ? 0.28 : role === 'metal' ? 0.62 : 0.78,
      metalness: role === 'metal' ? 0.68 : role === 'glass' ? 0.14 : metallic ? 0.24 : 0.05,
    }));
    return propMaterials.get(key);
  };

  // Deliberately independent of query/localStorage/callback input: this proof has one visual target.
  let relief = THREE_FIXED_RELIEF;
  let look = VALID_LOOK.has(src.look) ? src.look : 'realistic';
  let nature = { trees: true, rocks: true };
  let fx = { ...parseThreeFx(src.fx), fog: false };
  let H = exactTerrainSampler(exactTerrainPackage, makeTerrainSampler(data.terrain, relief));
  let HCanonical = exactTerrainSampler(
    exactTerrainPackage,
    makeTerrainSampler(data.terrain, 1),
    'canonicalYM',
  );
  const displayCanonicalObjectY = (
    canonicalY,
    canonicalGroundX,
    canonicalGroundZ,
    displayGroundX = canonicalGroundX,
    displayGroundZ = canonicalGroundZ,
  ) => terrainRelativeDisplayY({
    canonicalY,
    canonicalGroundY: HCanonical(canonicalGroundX, canonicalGroundZ),
    displayGroundY: H(displayGroundX, displayGroundZ),
  });
  let floorResolver = createFloorSurfaceResolver(data.floorSurfaces, relief);
  let seatedBuildings = [];
  let surfaceRenderStats = { floors: 0, roofs: 0, stableIds: [] };
  let treeGroup = null, rockGroup = null, propGroup = null, understoryGroup = null, understoryTuftGroup = null;
  /**
   * Public tree positions (`customs-3d.json`'s `trees`) currently seated by `addTreesAndRocks()`.
   *
   * This is the procedural half's placement count on the RELEASE path, where there is no exact
   * local vegetation plan to read `renderedCount` off. Measured at seat time from the array that
   * was actually walked, so it cannot drift from what is drawn.
   */
  let publicTreePlacements = 0;
  let wallStructureGroup = null;
  // Which half of the exact vegetation plan the PROCEDURAL proxies draw. It starts as the whole
  // plan and is narrowed to the router's procedural complement the moment the authored pack
  // mounts — never before, which is what makes the swap atomic.
  let proceduralVegetationPlan = exactVegetationPlan;
  let authoredVegetationRuntime = null;
  /**
   * Whether the MOUNTED authored forest casts into the depth map, read off the runtime that was
   * actually constructed rather than off the module default. `false` until a mount has published a
   * policy — nothing is in the scene to cast before then.
   */
  let authoredVegetationCastsShadows = false;
  let authoredVegetationArrays = null;
  let buildingGroup = null, understoryLod = 'overview';
  let understoryRenderStats = {
    polygons: 0, vertices: 0, candidateTufts: 0, tuftInstances: 0, coveredRings: 0,
    maxInstances: UNDERSTORY_TUFT_BUDGET.maxInstances, lod: understoryLod,
  };
  let overlayItems = [];
  let railwayRenderStats = { railSegments: 0, ballastSegments: 0, sleepers: 0, triangles: 0 };
  // `fords` is reported beside the structure counts on purpose: a ford drawing zero piers and zero
  // rails is the correct outcome, and a reader who cannot see how many fords there were cannot
  // tell that outcome apart from the structure pass having silently failed.
  let bridgeRenderStats = {
    decks: 0, fords: 0, fascias: 0, rails: 0, piers: 0, triangles: 0, overWater: null,
  };
  // Every water sheet drawn this rebuild, with the seating decision that put it there. `addBridges`
  // reads it to report how much clearance each deck actually keeps over the water it crosses —
  // `local.applied: true` could not tell an applied bridge from a submerged one, and that is the
  // exact hole this defect fell through.
  let waterSurfacePlans = [];
  let waterRenderStats = { surfaces: 0, seating: null, exactShoreline: 0, surfaceDetail: [] };
  let wallRenderStats = {
    runs: 0, panels: 0, posts: 0, gates: 0, lengthM: 0, triangles: 0,
    byClass: {}, gateProvenance: [], dimensionStatus: {},
  };
  /**
   * The building-detail lane's state. `buildingDetail` is the whole routed, planned, validated
   * result from `src/building-detail/assemble.js`; the three maps beside it are the lookups the
   * authored-asset suppression walk needs to reach an INSTANCE, which is a separate object from
   * the building that owns it and therefore does not ride its `visible` flag.
   */
  let buildingDetail = null;
  let buildingIndexByFeatureId = new Map();
  let buildingProfilesByIndex = new Map();
  let detailInstanceMeshes = [];
  let plinthMesh = null;
  let plinthRenderStats = { buildings: 0, triangles: 0 };
  let buildingRenderStats = null;
  let plinthSuppressionKey = null;
  /**
   * The last suppression set actually applied, and the answer that was published for it.
   *
   * `null` means "nothing has been applied yet, so nothing can be skipped" — and it is set back to
   * `null` by `rebuildWorld()`, whose new procedural graph makes every earlier application void.
   */
  let appliedProceduralSuppressionKey = null;
  let proceduralSuppressionResult = Object.freeze({ applied: Object.freeze([]), retained: Object.freeze([]) });
  /** `MATERIAL_SLOTS` index -> the shared map-wide material an instanced family draws with. */
  const DETAIL_SLOT_MATERIAL = Object.freeze({
    [MATERIAL_SLOT_INDEX.trim]: 'detailTrim',
    [MATERIAL_SLOT_INDEX.metal]: 'detailMetal',
    [MATERIAL_SLOT_INDEX.glazing]: 'detailGlazing',
    [MATERIAL_SLOT_INDEX.dark]: 'detailDark',
  });
  /**
   * One plan for every barrier on the map, built once and shared by the fence pass and the prop
   * pass. Heights and thicknesses come from `wall-runs.js`'s class table and nowhere else, so the
   * mesh-bounds lane replaces numbers in that table instead of editing this file.
   */
  let wallPlanCache = null;
  const wallStructurePlan = () => (wallPlanCache ??= planWallStructures({
    fences: data.fences, props: data.props, roads: data.roads,
  }));
  /*
   * The live profiler, or `null`. Declared here — above everything that can be timed — so the OFF
   * path is one `null` comparison and never a TDZ hazard.
   *
   * THE ZERO-COST-WHEN-OFF CONTRACT, in full:
   *   - `animate()` branches ONCE per rendered frame, between `renderOneFrame()` (the four calls,
   *     unchanged) and `frameProfiler.renderProfiled()` (the same four calls with marks between).
   *     No per-item work is added to `updateOverlayPositions()`, which is the loop that would have
   *     mattered.
   *   - `refreshDynamic()` and `repackAuthoredVegetation()` branch once per call, on paths that run
   *     a few times a second at most.
   *   - the pointermove raycast branches once per pointer event.
   *   - the waterfall helpers are bound to empty functions when off.
   *   - `trackTimestamp: false` leaves three's own timestamp path exactly where it is today.
   * Nothing else in this file consults it. `scripts/render-profiler.test.mjs` pins that by source.
   */
  let frameProfiler = null;
  let renderRequested = true, settleFrames = 0;
  const exactTerrainSurfaceStatus = () => customsExactTerrainSurfaceStatus({
    hasExactTerrain: Boolean(exactTerrainMesh),
    pbrAvailable: Boolean(exactTerrainPbrRuntime),
    paletteAvailable: exactTerrainMaterials.size === exactTerrainPackage?.manifest?.tiles?.length,
    look,
    detail: fx.detail,
  });
  /**
   * Which ground material the PUBLIC heightfield is wearing. Measured from the bake that actually
   * built (`groundCanvas`), not from the intent to build one — the same rule the exact-terrain
   * surface status follows, for the same reason.
   */
  const publicSurfaceKind = () => (groundCanvas ? 'semantic-ground-atlas' : 'tileable-fallback');
  // `updateTruthReadouts()` (defined far below, beside the chip it paints) reads `vegetationStatus`,
  // which does not exist until the authored-vegetation section. Everything that wants a repaint
  // before then — `applyLook()` on the initial world build — goes through this, and is a no-op
  // until the readouts are armed. The boot strip states RESOLVING for both halves in the meantime.
  let readoutsArmed = false;
  const noteVegetationTransition = () => { if (readoutsArmed) updateTruthReadouts(); };
  const invalidateRender = (frames = 0) => {
    renderRequested = true;
    settleFrames = Math.max(settleFrames, Math.max(0, Number(frames) || 0));
  };
  const status = {
    backend: renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl2',
    // What the OVERLAYS are actually gated on. This read `THREE_POC_SCOPE.id` until 2026-09-03,
    // i.e. the renderer called itself the industrial rail-yard golden cell while drawing the whole
    // map and clipping 24 of 32 extracts — a stat that could not detect its own failure (§7).
    scope: `customs-overlay-${overlayScope.source}`,
    overlayScope: { ...overlayScope },
    manifest: null,
    groundAtlas: groundTextureMapping ? {
      textureSize: [...groundTextureMapping.textureSize],
      bounds: { ...groundTextureMapping.bounds },
      source: 'shared-realistic-terrain-bake',
    } : null,
    exactTerrain: exactTerrainMesh ? {
      // `mode` names the DISTRIBUTION, because after 2026-09-02 "exact" no longer implies "local":
      // `promoted-public` is the exact ground, shipped, and calling it `local-exact` in production
      // would be the same class of lie as a strip that says LOCALHOST on tarkovzero.com.
      mode: exactTerrainSource === 'promoted-public' ? 'promoted-public-exact' : 'local-exact',
      distribution: exactTerrainSource,
      source: exactTerrainSource === 'promoted-public'
        ? '/assets/3d/customs/terrain/terrain-manifest.json'
        : '/@local-game-derived/customs/manifest.json',
      schemaVersion: exactTerrainPackage.manifest.schemaVersion,
      tiles: exactTerrainPackage.manifest.tiles.length,
      heightBytes: exactTerrainPackage.manifest.tiles.reduce(
        (sum, tile) => sum + tile.resolution.columns * tile.resolution.rows * 4,
        0,
      ),
      vegetationInstances: exactTerrainPackage.manifest.tiles.reduce(
        (sum, tile) => sum + (tile.vegetation?.count ?? 0),
        0,
      ),
      vertices: exactTerrainMesh.vertexCount,
      triangles: exactTerrainMesh.triangleCount,
      decimation: CUSTOMS_EXACT_TERRAIN_DECIMATION,
      renderedSeamGapM: 0,
      boundaryHeightOwnership: exactTerrainMesh.boundaryHeightOwnership,
      surfaceAvailable: exactTerrainSurfaceStatus().available,
      surface: exactTerrainSurfaceStatus().active,
      surfaceError: exactSurfaceError ? String(exactSurfaceError?.message ?? exactSurfaceError) : null,
      pbrError: exactTerrainPbrError ? String(exactTerrainPbrError?.message ?? exactTerrainPbrError) : null,
    } : localEnhancementsAllowed ? {
      mode: 'legacy-fallback',
      distribution: null,
      reason: exactTerrainError?.code ?? exactTerrainError?.name ?? 'missing-local-package',
    } : {
      // A release build with no promoted package on the origin. Since 2026-09-02 that is a real
      // DEFECT, not the intended configuration: the promoted surfaces ship, so reaching this
      // branch in production means the fetch failed or the assets are missing from the deploy.
      // The old wording ('release-build-local-enhancements-gated') described a build that never
      // asked; this one asked and did not get an answer, and must not borrow the calm phrasing.
      mode: 'public-heightfield',
      distribution: null,
      reason: exactTerrainError?.code ?? exactTerrainError?.name ?? 'promoted-terrain-unavailable',
      source: '/data/customs-3d.json',
      surface: publicSurfaceKind(),
    },
    exactVegetation: exactVegetationPlan ? {
      mode: 'exact-placement-original-procedural-assets',
      // WHICH package the placements came from, and where it was read. `promoted-public` is the
      // shipped one; calling it local in production would be the same class of lie as a strip that
      // says LOCALHOST on tarkovzero.com.
      distribution: exactVegetationSource,
      source: exactVegetationSource === 'promoted-public'
        ? promotedVegetationPackage?.manifestUrl ?? CUSTOMS_PROMOTED_VEGETATION_BASE_URL
        : '/@local-game-derived/customs/manifest.json',
      // Whether the promoted placement table's sha256 receipt was actually checked. `crypto.subtle`
      // is absent on an insecure non-loopback origin, and a check that silently did not run must
      // not read the same as one that passed.
      placementsVerified: exactVegetationSource === 'promoted-public'
        ? promotedVegetationPackage?.placements?.verified ?? false
        : null,
      declaredInstances: exactVegetationPlan.sourceCount,
      renderedInstances: exactVegetationPlan.renderedCount,
      culledOutsidePlayableBounds: exactVegetationPlan.culledCount,
      classes: { ...exactVegetationPlan.counts },
      sourceFrame: exactVegetation.sourceFrame,
      geometry: exactVegetationPlan.geometry,
    } : {
      mode: 'reviewed-fallback',
      distribution: null,
      reason: exactVegetationError?.code ?? exactVegetationError?.name
        ?? (exactTerrainMesh
          ? (localEnhancementsAllowed ? 'missing-local-vegetation' : 'promoted-vegetation-unavailable')
          : 'exact-terrain-unavailable'),
    },
    firstFrameMs: null,
    dataBytes: Number(response.headers.get('content-length')) || null,
  };

  function addTerrain() {
    if (exactTerrainMesh) {
      const group = new THREE.Group();
      group.name = 'terrain';
      group.userData = {
        kind: 'exact-local-terrain',
        sourceFrame: exactTerrainMesh.sourceFrame,
        relief: THREE_FIXED_RELIEF,
      };
      const seamMeshes = [];
      for (const patch of exactTerrainMesh.patches) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(patch.positions, 3));
        geometry.setAttribute('uv', new THREE.BufferAttribute(patch.controlUvs, 2));
        geometry.setAttribute('uv1', new THREE.BufferAttribute(detailUvsForExactPatch(patch), 2));
        geometry.setIndex(new THREE.BufferAttribute(patch.indices, 1));
        geometry.computeVertexNormals();
        const material = look === 'realistic'
          ? (fx.detail ? exactTerrainMaterials.get(patch.tileId) : materials.terrainExactFlat)
          : materials.terrainVector;
        const mesh = new THREE.Mesh(geometry, material ?? materials.terrainExactFlat);
        mesh.name = `terrain:${patch.tileId}`;
        mesh.userData = {
          kind: 'exact-local-terrain-tile',
          tileId: patch.tileId,
          canonicalElevationField: 'exactTerrainMesh.patches[].canonicalYM',
        };
        mesh.receiveShadow = true;
        group.add(mesh);
        seamMeshes.push(mesh);
      }
      smoothExactTerrainSeamNormals(seamMeshes);
      worldRoot.add(group);
      return;
    }
    const meshData = terrainMeshData(
      data.terrain,
      data.limit,
      relief,
      textures.groundAtlas ? (x, z) => gameToTerrainTextureUv(x, z, groundTextureMapping) : null,
    );
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(meshData.positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(meshData.uvs, 2));
    geometry.setAttribute('uv1', new THREE.BufferAttribute(meshData.detailUvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(meshData.indices, 1));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, look === 'realistic' ? materials.terrain : materials.terrainVector);
    mesh.name = 'terrain';
    mesh.receiveShadow = true;
    worldRoot.add(mesh);
  }

  function addUnderstory() {
    if (exactVegetationPlan) {
      // The exact terrain controls already describe grass/forest/soil coverage and the
      // canonical vegetation package supplies discrete plants. The old blanket polygons
      // would paint over those authored boundaries and duplicate thousands of placements.
      understoryGroup = null;
      understoryTuftGroup = null;
      understoryRenderStats = {
        mode: 'exact-control-masks-and-authored-vegetation',
        polygons: 0,
        vertices: 0,
        candidateTufts: exactVegetationPlan.counts['ground-plant'],
        tuftInstances: exactVegetationPlan.counts['ground-plant'],
        coveredRings: 0,
        maxInstances: exactVegetationPlan.counts['ground-plant'],
        activeDrawCalls: exactVegetationPlan.counts['ground-plant'] ? 1 : 0,
        activeTriangles: exactVegetationPlan.counts['ground-plant'] * 4,
        lod: 'canonical-placements',
      };
      return;
    }
    understoryGroup = new THREE.Group();
    understoryGroup.name = 'reviewed-understory-carpet';
    for (const [index, ring] of (data.understory || []).entries()) {
      const shape = shapeFromRing(ring);
      if (!shape) continue;
      const geometry = new THREE.ShapeGeometry(shape, 12);
      const positions = geometry.getAttribute('position');
      const uvs = geometry.getAttribute('uv');
      for (let i = 0; i < positions.count; i++) {
        const gameX = -positions.getX(i), gameZ = -positions.getY(i);
        positions.setZ(i, H(gameX, gameZ) + 0.065);
        // World-metre UVs keep the source ground detail at a believable scale instead of stretching
        // one copy across a several-hundred-vertex vegetation polygon.
        uvs?.setXY(i, gameX / 7, gameZ / 7);
      }
      positions.needsUpdate = true;
      if (uvs) uvs.needsUpdate = true;
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, look === 'realistic' ? materials.grass : materials.grassVector);
      mesh.name = `understory:${index}`;
      mesh.userData = { kind: 'understory', evidence: 'customs-3d.understory' };
      mesh.receiveShadow = true;
      mesh.renderOrder = 1;
      understoryGroup.add(mesh);
    }
    worldRoot.add(understoryGroup);

    const tuftPlan = buildUnderstoryTuftPlan(data.understory);
    const nearGeometry = grassTuftGeometry(3, true);
    const mediumGeometry = grassTuftGeometry(2, false);
    const near = new THREE.InstancedMesh(
      nearGeometry,
      look === 'realistic' ? materials.grassBlade : materials.grassBladeVector,
      tuftPlan.placements.length,
    );
    const medium = new THREE.InstancedMesh(
      mediumGeometry,
      look === 'realistic' ? materials.grassBlade : materials.grassBladeVector,
      tuftPlan.placements.length,
    );
    near.name = 'understory-tufts-near';
    medium.name = 'understory-tufts-medium';
    near.userData = { kind: 'understory-tufts', lod: 'near', trianglesPerInstance: 6 };
    medium.userData = { kind: 'understory-tufts', lod: 'medium', trianglesPerInstance: 2 };
    const dummy = new THREE.Object3D();
    const bladeColor = new THREE.Color();
    for (const [index, placement] of tuftPlan.placements.entries()) {
      dummy.position.set(...gameToWorld(placement.x, placement.z, H(placement.x, placement.z) + 0.035));
      dummy.rotation.set(0, 0, placement.yaw);
      dummy.scale.set(placement.widthM, placement.widthM, placement.heightM);
      dummy.updateMatrix();
      near.setMatrixAt(index, dummy.matrix);
      medium.setMatrixAt(index, dummy.matrix);
      bladeColor.setHSL(0.235 + placement.shade * 0.055, 0.34 + placement.shade * 0.16, 0.34 + placement.shade * 0.12);
      near.setColorAt(index, bladeColor);
      medium.setColorAt(index, bladeColor);
    }
    near.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    medium.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    near.instanceMatrix.needsUpdate = medium.instanceMatrix.needsUpdate = true;
    if (near.instanceColor) near.instanceColor.needsUpdate = true;
    if (medium.instanceColor) medium.instanceColor.needsUpdate = true;
    near.computeBoundingSphere();
    medium.computeBoundingSphere();
    // Thousands of distant blades casting into the one full-map shadow map is all cost, no signal.
    near.castShadow = medium.castShadow = false;
    near.receiveShadow = medium.receiveShadow = true;
    understoryTuftGroup = new THREE.Group();
    understoryTuftGroup.name = 'reviewed-understory-tufts';
    understoryTuftGroup.add(near, medium);
    worldRoot.add(understoryTuftGroup);
    understoryRenderStats = {
      polygons: data.understory?.length ?? 0,
      vertices: (data.understory || []).reduce((total, ring) => total + ring.length, 0),
      candidateTufts: tuftPlan.candidateCount,
      tuftInstances: tuftPlan.placements.length,
      coveredRings: tuftPlan.coveredRings,
      maxInstances: tuftPlan.maxInstances,
      densityPerSquareM: tuftPlan.densityPerSquareM,
      footprintRadiusM: tuftPlan.footprintRadiusM,
      nearTriangles: tuftPlan.placements.length * 6,
      mediumTriangles: tuftPlan.placements.length * 2,
      activeDrawCalls: 0,
      activeTriangles: 0,
      lod: understoryLod,
    };
  }

  function addWater() {
    // The shipped `level` is fitted from the public heightfield, which is interpolated from spawn
    // and loot points and never sits on a riverbed. With the EXACT terrain mounted the bed drops to
    // its real canonical depth while `level` does not, so that expression floats the sheet over
    // anything seated against the exact ground — which is how both Junk Bridge spans ended up
    // rendered underwater with every bridge counter green. `waterSurfacePlan` therefore takes this
    // renderer's own canonical/display sampler pair and seats the sheet at the display height of
    // the terrain along the polygon's own traced shoreline. Handing it null samplers is the release
    // path and reproduces `level * relief + 0.08` exactly, so production does not move.
    waterSurfacePlans = [];
    for (const water of data.water || []) {
      const shape = shapeFromRing(water.poly);
      if (!shape) continue;
      for (const hole of water.holes || []) {
        const h = shapeFromRing(hole);
        if (h) shape.holes.push(h);
      }
      const plan = waterSurfacePlan(water, {
        relief,
        lift: 0.08,
        canonicalGroundAt: exactTerrainMesh ? HCanonical : null,
        displayGroundAt: exactTerrainMesh ? H : null,
      });
      const geometry = new THREE.ShapeGeometry(shape, 12);
      const mesh = new THREE.Mesh(geometry, materials.water);
      mesh.position.z = plan.displayY;
      mesh.name = `water:${water.kind ?? 'surface'}`;
      mesh.receiveShadow = true;
      worldRoot.add(mesh);
      waterSurfacePlans.push({ water, plan });
    }
    const modes = [...new Set(waterSurfacePlans.map((entry) => entry.plan.mode))];
    waterRenderStats = {
      surfaces: waterSurfacePlans.length,
      seating: modes.length === 1 ? modes[0] : modes.sort().join('+') || null,
      exactShoreline: waterSurfacePlans
        .filter((entry) => entry.plan.mode === WATER_SURFACE_SEATING.EXACT_SHORELINE).length,
      surfaceDetail: waterSurfacePlans.map(({ water, plan }) => ({
        kind: water.kind ?? 'surface',
        mode: plan.mode,
        reason: plan.reason,
        displayY: plan.displayY,
        levelStatus: plan.level.status,
        shoreline: plan.shoreline,
      })),
    };
  }

  function addRoadsAndLines() {
    // The exact control masks already carry road, gravel, forest and soil boundaries.
    // Legacy ribbons remain an all-or-nothing package fallback; drawing both creates
    // doubled shoulders and reintroduces the approximate geometry we just replaced.
    if (!exactTerrainMesh) {
      for (const road of data.roads || []) {
        const geometry = ribbonGeometry(road.path, Number(road.width) || (road.kind === 'major' ? 9 : 4), H, 0.08);
        if (!geometry) continue;
        const mesh = new THREE.Mesh(geometry, road.kind === 'dirt' || road.kind === 'track' ? materials.dirt : materials.road);
        mesh.name = `road:${road.name ?? road.kind ?? 'road'}`;
        mesh.userData.semanticGroundOverlay = true;
        mesh.receiveShadow = true;
        worldRoot.add(mesh);
      }
      for (const pavement of data.pavement || []) {
        const shape = shapeFromRing(pavement.poly ?? pavement);
        if (!shape) continue;
        const geometry = new THREE.ShapeGeometry(shape);
        const mesh = new THREE.Mesh(geometry, materials.road);
        mesh.userData.semanticGroundOverlay = true;
        const c = centroid(pavement.poly ?? pavement);
        mesh.position.z = H(c[0], c[1]) + 0.07;
        mesh.receiveShadow = true;
        worldRoot.add(mesh);
      }
    }
    addBridges();
    addWallStructures();
    const railSurfaceY = exactTerrainMesh
      ? (x, z) => H(x, z) + RAILWAY_TRACK_PROFILE.trackBedLiftM
      : H;
    let ballastSegments = 0;
    if (exactTerrainMesh) {
      for (const rail of data.railway || []) {
        for (const [width, lift] of [[3.6, 0.035], [2.9, 0.15]]) {
          const geometry = ribbonGeometry(rail.path, width, H, lift);
          if (!geometry) continue;
          const ballast = new THREE.Mesh(geometry, materials.ballast);
          ballast.name = `rail-ballast:${rail.name ?? ballastSegments}`;
          ballast.receiveShadow = true;
          worldRoot.add(ballast);
          ballastSegments++;
        }
      }
    }
    for (const rail of data.railway || []) {
      const geometry = lineGeometry(rail.path, railSurfaceY, 0.14);
      if (geometry) {
        const line = new THREE.Line(geometry, materials.rail);
        line.userData.semanticGroundOverlay = true;
        worldRoot.add(line);
      }
    }
    const track = railwayTrackMeshData(data.railway, railSurfaceY, THREE_POC_SCOPE);
    if (track.railIndices.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(track.railPositions, 3));
      geometry.setIndex(new THREE.BufferAttribute(track.railIndices, 1));
      geometry.computeVertexNormals();
      const rails = new THREE.Mesh(geometry, materials.railSteel);
      rails.name = 'physical-rails';
      rails.castShadow = rails.receiveShadow = true;
      worldRoot.add(rails);
    }
    if (track.sleepers.length) {
      const sleepers = new THREE.InstancedMesh(
        new THREE.BoxGeometry(...track.sleeperSize),
        materials.sleeper,
        track.sleepers.length,
      );
      sleepers.name = 'physical-sleepers';
      const dummy = new THREE.Object3D();
      track.sleepers.forEach((sleeper, index) => {
        dummy.position.set(...gameToWorld(
          sleeper.x,
          sleeper.z,
          sleeper.y + track.sleeperSize[2] / 2 + track.profile.sleeperCenterLiftM,
        ));
        dummy.rotation.set(0, 0, sleeper.yaw);
        dummy.updateMatrix();
        sleepers.setMatrixAt(index, dummy.matrix);
      });
      sleepers.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      sleepers.instanceMatrix.needsUpdate = true;
      sleepers.castShadow = false;
      sleepers.receiveShadow = true;
      sleepers.computeBoundingSphere();
      worldRoot.add(sleepers);
    }
    railwayRenderStats = {
      railSegments: track.railSegmentCount,
      ballastSegments,
      sleepers: track.sleepers.length,
      triangles: track.railIndices.length / 3 + track.sleepers.length * 12,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Bridges
  //
  // The deck keeps its measured-surface contract: a bridge with surveyed evidence is seated on
  // `measuredSurfaceY`, never re-seated on interpolated ground, and FLAT end to end — a deck is a
  // level structure, and the attempt to close its end gaps by bending it down to grade produced a
  // folded ribbon at a 102% local grade, not a bridge. The gap between a flat deck and its banks is
  // filled by structure instead: `bridgeApproachPlan` puts an abutment under each deck end and an
  // approach embankment behind it, carrying the road out to the ground at a 10% grade. Everything
  // the deck stands on or carries is planned by `bridge-structure.js` from that same deck altitude,
  // so the structure cannot drift off the surface it belongs to. Dimensions come from the bridge's
  // own width — this file holds no bridge literals.
  // -------------------------------------------------------------------------------------------

  /** Wrap pure prism mesh data (world-space positions, already `gameToWorld`-ed) in a Mesh. */
  function structureMesh(meshData, material, name) {
    if (!meshData?.indices?.length) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(meshData.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(meshData.indices, 1));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = mesh.receiveShadow = true;
    return mesh;
  }

  function addBridges() {
    const group = new THREE.Group();
    group.name = 'bridge-structures';
    const piers = [];
    // Abutments and embankments are collected across every bridge and merged into ONE mesh each,
    // for the same reason the piers are one InstancedMesh: they are the same solid in the same
    // material, and a draw call per end of every bridge buys nothing.
    const abutments = [], embankments = [], approaches = [];
    let decks = 0, fascias = 0, rails = 0, fords = 0, triangles = 0;
    // A deck is only rendered if it is above the water it crosses. Counting applied records cannot
    // see that; measuring the gap can, and a negative one names the bridge that vanished.
    const overWater = {
      decks: 0, minClearanceM: null, minClearanceDeck: null, submerged: [], fordsBelowSurface: 0,
    };
    for (const bridge of bridgeRows) {
      const lift = Math.max(0.1, Number(bridge.height) || 0.7);
      // A local record states its deck's CANONICAL game Y instead of a lift above interpolated
      // terrain, and it is converted here by the same `displayCanonicalObjectY` every other
      // canonical-Y object in this renderer goes through. It deliberately does NOT go through
      // `measuredSurfaceY`, which multiplies by `relief` — correct for the public rows' fitted
      // altitudes, wrong for a game altitude, which relief must never stretch. The deck stays flat
      // at that one altitude, as a deck does; the fascia, rails and piers follow from it.
      const seating = bridgeSeating(bridge);
      const anchor = seating.mode === BRIDGE_SEATING.CANONICAL
        ? bridgeDeckAnchor(bridge, HCanonical)
        : null;
      const surfaceY = anchor
        ? displayCanonicalObjectY(seating.canonicalYM, anchor[0], anchor[1])
        : measuredSurfaceY(bridge, relief);
      // ONE deck altitude, shared by the ribbon and every structural part below. A measured deck is
      // one flat absolute altitude everywhere — the ends included. Nothing here bends it.
      const deckYAt = surfaceY == null ? (x, z) => H(x, z) + lift : () => surfaceY + 0.08;
      const geometry = ribbonGeometry(bridge.path, Number(bridge.width) || 5, deckYAt, 0);
      if (!geometry) continue;
      const mesh = new THREE.Mesh(geometry, materials.road);
      mesh.name = `bridge:${bridge.name ?? 'bridge'}`;
      mesh.userData = { surfaceY, evidence: bridge.evidence ?? null };
      mesh.castShadow = mesh.receiveShadow = true;
      worldRoot.add(mesh);
      decks++;
      triangles += geometryTriangles(geometry);

      const plan = bridgeStructurePlan(bridge, { deckYAt, groundYAt: H });
      // A ford is a crossing THROUGH the water, so it is counted and never faulted for being under
      // the surface; a deck that is under it is invisible and is named.
      const { clearanceM, crossings } = deckWaterClearance(bridge.path, deckYAt, waterSurfacePlans);
      if (crossings > 0 && clearanceM != null) {
        if (plan.ford) {
          if (clearanceM < 0) overWater.fordsBelowSurface += 1;
        } else {
          overWater.decks += 1;
          if (overWater.minClearanceM == null || clearanceM < overWater.minClearanceM) {
            overWater.minClearanceM = clearanceM;
            overWater.minClearanceDeck = safeText(bridge.name) || 'bridge';
          }
          if (clearanceM <= 0) overWater.submerged.push(safeText(bridge.name) || 'bridge');
        }
      }
      if (plan.ford) { fords++; continue; }
      const label = safeText(bridge.name) || 'bridge';
      const fascia = structureMesh(plan.fascia, materials.bridgeEdge, `bridge-fascia:${label}`);
      if (fascia) { group.add(fascia); fascias++; triangles += geometryTriangles(fascia.geometry); }
      for (const rail of plan.rails) {
        const railMesh = structureMesh(rail, materials.bridgeRail, `bridge-rail:${label}:${rail.side}`);
        if (railMesh) { group.add(railMesh); rails++; triangles += geometryTriangles(railMesh.geometry); }
      }
      piers.push(...plan.piers);

      // WHERE THE DECK LANDS. Only a MEASURED deck gets abutments, and that is the guard, not an
      // oversight — the same guard the abandoned deck ramp needed, for the same reason. A
      // `terrain-lift` deck already tracks the ground at a constant lift, and a `canonical-game-y`
      // deck is pinned to its HIGHEST bank by `bridgeDeckAnchor` so its ends are flush already;
      // building an abutment down to a sampled bed under the Junk Bridge, which clears the river by
      // 0.48 m, is how that deck goes back under the water and disappears.
      const approach = seating.mode === BRIDGE_SEATING.MEASURED
        ? bridgeApproachPlan(bridge, { deckYAt, groundYAt: H })
        : null;
      for (const end of approach?.ends ?? []) {
        if (end.abutment) { abutments.push(end.abutment); triangles += end.abutment.indices.length / 3; }
        if (end.embankment) { embankments.push(end.embankment); triangles += end.embankment.indices.length / 3; }
        // The carriageway the embankment carries: the SAME road material the deck is drawn with, so
        // the road reads as arriving at the bridge rather than as a concrete wedge behind it.
        const ramp = end.embankment
          ? ribbonGeometry(end.approachPath, Number(bridge.width) || 5, end.topYAt, BRIDGE_STRUCTURE.approachSurfaceM)
          : null;
        if (ramp) {
          const rampMesh = new THREE.Mesh(ramp, materials.road);
          rampMesh.name = `bridge-approach:${label}:${end.side}`;
          rampMesh.castShadow = rampMesh.receiveShadow = true;
          worldRoot.add(rampMesh);
          triangles += geometryTriangles(ramp);
        }
        approaches.push({
          bridge: label,
          side: end.side,
          gapM: end.gapM,
          gradePct: end.approachGradePct,
          lengthM: end.approachLengthM,
          meetsGrade: end.meetsGrade,
          residualGapM: end.residualGapM,
        });
      }
    }
    for (const [name, prisms] of [['bridge-abutments', abutments], ['bridge-embankments', embankments]]) {
      const geometry = mergedPrismGeometry(prisms);
      if (!geometry) continue;
      const mesh = new THREE.Mesh(geometry, materials.pier);
      mesh.name = name;
      mesh.castShadow = mesh.receiveShadow = true;
      group.add(mesh);
    }
    if (piers.length) {
      const pierMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), materials.pier, piers.length);
      pierMesh.name = 'bridge-piers';
      const dummy = new THREE.Object3D();
      piers.forEach((pier, index) => {
        dummy.position.set(...gameToWorld(pier.x, pier.z, (pier.topY + pier.bottomY) / 2));
        // Same convention as the sleepers: the box is symmetric, so the reflected world basis's
        // half-turn is immaterial and the game-space heading can be used directly.
        dummy.rotation.set(0, 0, pier.yaw);
        dummy.scale.set(pier.depthM, pier.widthM, pier.heightM);
        dummy.updateMatrix();
        pierMesh.setMatrixAt(index, dummy.matrix);
      });
      pierMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      pierMesh.instanceMatrix.needsUpdate = true;
      pierMesh.castShadow = pierMesh.receiveShadow = true;
      pierMesh.computeBoundingSphere();
      group.add(pierMesh);
      triangles += 12 * piers.length;
    }
    if (group.children.length) worldRoot.add(group);
    if (overWater.submerged.length) {
      console.warn('[three-poc] bridge decks are UNDER the water surface and cannot be seen',
        overWater.submerged, overWater.minClearanceM);
    }
    // `approaches` carries the gap each deck end actually had and how far above the ground its
    // approach still finishes, because `abutments: 2` cannot tell a landed deck from a floating one.
    bridgeRenderStats = {
      decks, fords, fascias, rails, piers: piers.length, triangles, overWater,
      abutments: abutments.length, embankments: embankments.length, approaches,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Walls, fences and gates
  //
  // Every number below arrives on `run.spec` / `gate.spec`, which is one entry of `wall-runs.js`'s
  // class table. There is deliberately no literal height, thickness, post width or spacing in this
  // section: when the mesh-bounds lane lands, it edits that table and this code does not move.
  // -------------------------------------------------------------------------------------------

  const geometryTriangles = (geometry) => (geometry?.index
    ? geometry.index.count
    : geometry?.attributes?.position?.count ?? 0) / 3;

  /**
   * One draped closed prism along a whole path — the shape a solid wall, a rail or a coping is.
   *
   * Two things happen before the prism is built, and both are about the ground rather than the
   * barrier. The path is RESAMPLED at `DRAPE.maxSegmentM`, because a prism only samples the terrain
   * at its own corners: the five Fortress rows each ship as one 38–66 m segment, and measured
   * against the exact Customs terrain at the fixed 2x relief the worst of them floated 6.10 m over
   * the ground (the inner wall, over the trench at [205.2, -140.4]) and buried itself 2.77 m in it
   * (the west wall at [217.8, -137.7]) — on a wall 3.5 m tall. At 1 m the worst gap anywhere in
   * those five runs is 0.46 m. Then the corners are MITERED, so a bend does not leave a wedge of
   * nothing on its outside.
   *
   * It returns an array because the merge below takes one, and because a path that cannot produce a
   * strip must produce none rather than a degenerate one.
   */
  function prismsAlongPath(path, widthM, heightM, offsetM = 0) {
    const edges = miteredEdges(resamplePath(path, DRAPE.maxSegmentM), widthM / 2, DRAPE.miterLimit);
    const strip = drapedPrismStripMeshData(edges, heightM, offsetM, H);
    return strip ? [strip] : [];
  }

  function mergedPrismGeometry(prisms) {
    if (!prisms.length) return null;
    const positions = [], indices = [];
    let vertex = 0;
    for (const prism of prisms) {
      for (const value of prism.positions) positions.push(value);
      for (const index of prism.indices) indices.push(index + vertex);
      vertex += prism.positions.length / 3;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }

  /**
   * Merge the alpha-masked panels of one or more mesh-fill paths into a single geometry.
   *
   * `u` accumulates along each path so the wire pattern stays continuous across a run's vertices
   * instead of restarting — a restart is visible as a seam every 2 m on a resampled fence.
   */
  function mergedPanelGeometry(paths, spec, heightM = spec.heightM) {
    const positions = [], uvs = [], indices = [];
    let vertex = 0;
    for (const source of paths) {
      // Same drape resolution as the prisms: a panel samples the ground only at its two ends, so a
      // long quad hangs over a dip exactly the way a long prism does.
      const path = resamplePath(source, DRAPE.maxSegmentM);
      let u = 0;
      for (let index = 1; index < path.length; index++) {
        const quad = drapedPanelMeshData(path[index - 1], path[index], heightM, 0, H, spec.meshUvScaleM, u);
        if (!quad) continue;
        for (const [x, z, y] of quad.corners) positions.push(...gameToWorld(x, z, y));
        for (const value of quad.uvs) uvs.push(value);
        for (const index2 of quad.indices) indices.push(index2 + vertex);
        vertex += 4;
        u += quad.lengthM;
      }
    }
    if (!indices.length) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }

  /** One draw call for every post of a class; a unit box translated so its base sits on the ground. */
  function postInstancedMesh(posts, material, name) {
    if (!posts.length) return null;
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    geometry.translate(0, 0, 0.5);
    const mesh = new THREE.InstancedMesh(geometry, material, posts.length);
    const dummy = new THREE.Object3D();
    posts.forEach((post, index) => {
      // A 9 cm square post is orientation-invariant at every zoom this map reaches, so no yaw is
      // carried; the run's direction is already read from the panel and the rails.
      dummy.position.set(...gameToWorld(post.x, post.z, H(post.x, post.z)));
      dummy.scale.set(post.widthM, post.widthM, post.heightM);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    mesh.name = name;
    return mesh;
  }

  const addWallMesh = (parent, geometry, material, name) => {
    if (!geometry) return 0;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = mesh.receiveShadow = true;
    parent.add(mesh);
    return geometryTriangles(geometry);
  };

  /** Panels, rails and posts for the mesh-fill (chain-link) half of one run. */
  function buildMeshRunParts(paths, spec, parent, label) {
    let triangles = 0;
    triangles += addWallMesh(parent, mergedPanelGeometry(paths, spec), materials.chainLink, `${label}:infill`);
    const rails = [];
    for (const path of paths) {
      for (const offsetM of spec.railOffsetsM) {
        rails.push(...prismsAlongPath(path, spec.railThicknessM, spec.railThicknessM, offsetM));
      }
    }
    triangles += addWallMesh(parent, mergedPrismGeometry(rails), materials.fenceSteel, `${label}:rails`);
    return triangles;
  }

  /** A solid wall run: the wall body plus its coping, kept as one node per source row. */
  function buildSolidWallNode(run, material) {
    const group = new THREE.Group();
    group.name = `wall-run:${run.id}`;
    const bodies = [], caps = [];
    for (const panel of run.panels) {
      bodies.push(...prismsAlongPath(panel.path, run.spec.thicknessM, run.spec.heightM, 0));
      if (run.spec.capHeightM > 0) {
        caps.push(...prismsAlongPath(panel.path, run.spec.capWidthM, run.spec.capHeightM, run.spec.heightM));
      }
    }
    let triangles = 0;
    triangles += addWallMesh(group, mergedPrismGeometry(bodies), material, 'body');
    triangles += addWallMesh(group, mergedPrismGeometry(caps), materials.fenceSteel, 'coping');
    const posts = postInstancedMesh(run.posts, materials.fenceSteel, 'posts');
    if (posts) { group.add(posts); triangles += geometryTriangles(posts.geometry) * run.posts.length; }
    return group.children.length ? { group, triangles } : null;
  }

  /**
   * A gate: two jambs and two leaves standing in an opening.
   *
   * The opening is not created here — it is already a gap in the source runs. What this adds is the
   * structure that says "this is a way through a fence" instead of "the fence stops for no reason".
   * The label carries the gate's provenance verbatim, because none of these was measured.
   */
  function buildGateNode(gate) {
    const group = new THREE.Group();
    group.name = `gate:${gate.id}`;
    let triangles = 0;
    const jambs = postInstancedMesh(gate.jambs, materials.gateSteel, 'jambs');
    if (jambs) { group.add(jambs); triangles += geometryTriangles(jambs.geometry) * gate.jambs.length; }
    const leafPaths = gate.leaves.map((leaf) => [leaf.a, leaf.b]);
    if (gate.spec.fill === 'mesh') {
      triangles += addWallMesh(group, mergedPanelGeometry(leafPaths, gate.spec), materials.chainLink, 'leaves');
      const frame = [];
      const stiles = [];
      for (const path of leafPaths) {
        for (const offsetM of gate.spec.railOffsetsM) {
          frame.push(...prismsAlongPath(path, gate.spec.gate.leafFrameThicknessM, gate.spec.gate.leafFrameThicknessM, offsetM));
        }
        // The stile on the leaf's FREE edge. A swing leaf is a welded frame with fabric stretched
        // inside it, and that closing edge is the one thing that says "this panel is a door" rather
        // than "the fence carries on at an angle" — the hinge edge is already the jamb, so it is
        // deliberately not doubled here.
        stiles.push({
          x: path[1][0], z: path[1][1],
          widthM: gate.spec.gate.leafFrameThicknessM,
          heightM: gate.spec.heightM,
        });
      }
      triangles += addWallMesh(group, mergedPrismGeometry(frame), materials.gateSteel, 'leaf-frames');
      const leafStiles = postInstancedMesh(stiles, materials.gateSteel, 'leaf-stiles');
      if (leafStiles) { group.add(leafStiles); triangles += geometryTriangles(leafStiles.geometry) * stiles.length; }
    } else {
      const leaves = [];
      for (const path of leafPaths) {
        leaves.push(...prismsAlongPath(path, gate.spec.gate.leafFrameThicknessM, gate.spec.heightM, 0));
      }
      triangles += addWallMesh(group, mergedPrismGeometry(leaves), materials.gateSteel, 'leaves');
    }
    group.userData = {
      kind: 'gate', assetKind: 'wall-gate',
      label: `Gate · ${gate.spanM.toFixed(1)} m opening · ${gate.provenance} · dimensions ${gate.spec.status}`,
      provisional: true, stableId: null,
      provenance: gate.provenance, evidence: gate.evidence,
    };
    return group.children.length ? { group, triangles } : null;
  }

  function addWallStructures() {
    const plan = wallStructurePlan();
    wallStructureGroup = new THREE.Group();
    wallStructureGroup.name = 'wall-structures';
    let triangles = 0;

    // Solid runs come from prop rows and are attached in addProps(), where hover labels and
    // authored-asset suppression already work. Only the mesh-fill runs — every
    // `data.fences` row — are drawn here, batched per class into three draw calls.
    const meshRuns = plan.runs.filter((run) => run.spec.fill === 'mesh');
    const byClass = new Map();
    for (const run of meshRuns) {
      const bucket = byClass.get(run.classId) ?? { spec: run.spec, paths: [], posts: [] };
      for (const panel of run.panels) bucket.paths.push(panel.path);
      bucket.posts.push(...run.posts);
      byClass.set(run.classId, bucket);
    }
    for (const [classId, bucket] of byClass) {
      const group = new THREE.Group();
      group.name = `wall-class:${classId}`;
      triangles += buildMeshRunParts(bucket.paths, bucket.spec, group, classId);
      const posts = postInstancedMesh(bucket.posts, materials.fenceSteel, `${classId}:posts`);
      if (posts) { group.add(posts); triangles += geometryTriangles(posts.geometry) * bucket.posts.length; }
      if (group.children.length) wallStructureGroup.add(group);
    }

    const gateGroup = new THREE.Group();
    gateGroup.name = 'gates';
    for (const gate of plan.gates) {
      const built = buildGateNode(gate);
      if (!built) continue;
      triangles += built.triangles;
      gateGroup.add(built.group);
    }
    if (gateGroup.children.length) wallStructureGroup.add(gateGroup);
    worldRoot.add(wallStructureGroup);

    wallRenderStats = {
      runs: plan.stats.runs,
      panels: plan.runs.reduce((total, run) => total + run.panels.length, 0),
      posts: plan.stats.posts,
      gates: gateGroup.children.length,
      lengthM: plan.stats.lengthM,
      panelLengthM: plan.stats.panelLengthM,
      openingLengthM: plan.stats.openingLengthM,
      triangles,
      byClass: plan.stats.byClass,
      gateProvenance: plan.stats.gateProvenance,
      gateCandidates: plan.inference?.candidates ?? null,
      gateRejected: plan.inference?.rejected.length ?? null,
      dimensionStatus: plan.stats.dimensionStatus,
    };
  }

  /**
   * Buildings, dressed.
   *
   * ONE router (`classifyBuilding`) assigns exactly one archetype per building, ONE planner per
   * archetype returns pure geometry data, and this function is the only place any of it meets
   * THREE. Everything decided here is decided in `src/building-detail/assemble.js` so it can be
   * tested without a GPU; what is left below is buffer plumbing.
   *
   * Two things that were true before this lane and must stay true: `userData.kind === 'building'`
   * (the authored-asset suppression walk and the hover label both read it), and exactly
   * ONE outline per building — built from the shell alone, never over the detail. `EdgesGeometry`
   * across 8,828 detail triangles emits thousands of segments and reads as hatching; the shell IS
   * the silhouette, and a roof rib's own edge is sub-pixel at the default view where one pixel is
   * one metre.
   */
  function addBuildings() {
    buildingGroup = new THREE.Group();
    buildingGroup.name = 'buildings';
    seatedBuildings = placeBuildings((data.buildings || []).map((building) => ({ ...building, poly: building.poly.map((p) => [...p]) })), H);
    buildingDetail = planBuildingDetail(seatedBuildings, {
      groundYAt: H,
      profileFor: (building) => {
        const profile = floorResolver.buildingProfile(building, {
          fallbackBase: building.base,
          fallbackHeight: building.height,
        });
        building._surfaceProfile = profile;
        return profile;
      },
    });
    buildingIndexByFeatureId = new Map();
    buildingProfilesByIndex = new Map();
    let massTriangles = 0;
    let detailTriangles = 0;
    let outlines = 0;
    let groups = 0;

    for (const row of buildingDetail.rows) {
      const { building, profile, plan } = row;
      const height = profile.height;
      buildingProfilesByIndex.set(row.index, profile);
      const stableId = building.featureId ?? building.sourceKey ?? null;
      if (stableId) buildingIndexByFeatureId.set(stableId, row.index);

      // ---- the mass. A planner that REPLACES it (an open frame, a fuel canopy, a lattice pylon)
      //      gets no extrusion at all: columns inside a solid block are invisible, and a canopy is
      //      defined by the void under its deck. This is keyed on the ROUTER, which is what retires
      //      the `place === 'skeleton'` literal that used to be the only way a building was open.
      let mass = null;
      let outline = null;
      if (!row.replacesMass) {
        const shape = shapeFromRing(building.poly);
        if (!shape) continue;
        // `row.massHeightM`, NOT `profile.height`. The planners build their roof forms upward from
        // the plane they are handed, so the assembler fits the whole plan into the data height and
        // hands back the eave the roof now lands on; extruding to `profile.height` here would put
        // the ridge back above it. Standing decision 4 — see item 5 in assemble.js's header.
        const extrusion = new THREE.ExtrudeGeometry(shape, {
          depth: row.massHeightM,
          bevelEnabled: true,
          bevelSegments: 1,
          bevelSize: 0.08,
          bevelThickness: 0.08,
          curveSegments: 2,
        });
        // `ExtrudeGeometry` is non-indexed and emits materialIndex 0 for the lids and 1 for the
        // sides — which is why the pre-lane material array read `[roof, wall]`. Re-labelled here
        // into the contract's slot numbering so a planner group and a mass group mean the same
        // thing in one array.
        mass = {
          positions: extrusion.attributes.position.array,
          normals: extrusion.attributes.normal?.array ?? null,
          groups: extrusion.groups.map((group) => ({
            start: group.start,
            count: group.count,
            materialSlot: group.materialIndex === 0 ? MATERIAL_SLOT_INDEX.roof : MATERIAL_SLOT_INDEX.wall,
          })),
        };
        massTriangles += extrusion.attributes.position.count / 3;
        outline = new THREE.LineSegments(new THREE.EdgesGeometry(extrusion, 28), materials.outline);
        outline.renderOrder = 2;
        outlines += 1;
        extrusion.dispose();
      }

      const assembled = assembleBuildingGeometry({ mass, detail: plan.mesh, originZ: profile.baseY });
      if (!assembled.vertices) continue;
      detailTriangles += row.detailTriangles;
      groups += assembled.groups.length;

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(assembled.positions, 3));
      if (assembled.normals) geometry.setAttribute('normal', new THREE.BufferAttribute(assembled.normals, 3));
      else geometry.computeVertexNormals();
      for (const group of assembled.groups) geometry.addGroup(group.start, group.count, group.materialSlot);
      geometry.computeBoundingSphere();

      const mesh = new THREE.Mesh(geometry, buildingSlotMaterials(building));
      mesh.position.z = profile.baseY;
      mesh.castShadow = mesh.receiveShadow = true;
      if (outline) mesh.add(outline);
      mesh.name = safeText(building.place ?? building.name ?? building.kind) || 'building';
      mesh.userData = {
        kind: 'building', label: mesh.name, stableId,
        floors: profile.floorCount, realHeight: height, surfaceProfile: profile,
        surfaceStableIds: profile.rows.map((row2) => row2.stableId).filter(Boolean),
        provisional: !building.featureId,
        buildingIndex: row.index,
        archetype: row.classification.archetype,
        roofForm: row.classification.roofForm,
        program: row.classification.program,
        detailSlots: assembled.slots,
      };
      buildingGroup.add(mesh);

      for (const row2 of profile.floorRows) {
        const surfaceY = profile.floorYs[row2.floorIndex];
        const floorShape = shapeFromRing(building.poly);
        if (!floorShape || surfaceY == null) continue;
        const slab = new THREE.Mesh(new THREE.ShapeGeometry(floorShape), materials.floorSurface);
        slab.position.z = surfaceY + 0.025;
        slab.name = `${mesh.name}:floor:${row2.floorIndex}`;
        slab.receiveShadow = true;
        slab.userData = {
          kind: 'floor-surface', label: slab.name, floorIndex: row2.floorIndex,
          surfaceY, stableId: row2.stableId ?? null,
        };
        buildingGroup.add(slab);
        surfaceRenderStats.floors++;
        if (row2.stableId) surfaceRenderStats.stableIds.push(row2.stableId);
      }
      if (profile.measuredRoof) {
        surfaceRenderStats.roofs++;
        if (profile.roofRow?.stableId) surfaceRenderStats.stableIds.push(profile.roofRow.stableId);
      }
    }

    addBuildingDetailInstances();
    rebuildPlinths();

    // ONLY the numbers that cannot change after the mount. Everything that CAN — the skirt counts,
    // the draw-call total, the triangle total, how many instances are drawing — is derived at read
    // time by `buildingStatsNow()`, because a snapshot taken here reported 67 skirts / 756 triangles
    // forever while `rebuildPlinths()` had already cut the frame to 66 / 748 on a suppression.
    buildingRenderStats = {
      ...buildingDetail.stats,
      groups,
      outlinesBuilt: outlines,
      massTriangles,
      detailTriangles,
    };
    worldRoot.add(buildingGroup);
  }

  /**
   * The buildings' cost as of RIGHT NOW — one call per material group, one per outline, one per
   * instanced mesh, one for the skirt while there is a skirt to draw.
   *
   * Live inputs only: `plinthRenderStats` is reassigned by `rebuildPlinths()` on every change to the
   * authored ledger, `plinthMesh` is null when the skirt has no geometry left to draw, and
   * `entry.mesh.count` is what `refreshDetailInstances()` last set. Read at call time, never stored.
   */
  function buildingStatsNow() {
    return buildingRenderStatsNow(buildingRenderStats, {
      plinths: plinthRenderStats,
      instancedMeshes: detailInstanceMeshes.length,
      instancesDrawn: detailInstanceMeshes.reduce((sum, entry) => sum + entry.mesh.count, 0),
      skirtDrawCalls: plinthMesh ? 1 : 0,
    });
  }

  /**
   * ONE `InstancedMesh` per (family, prototype), for the whole map.
   *
   * Not one per family, which is what `contract.js` assumed: measured against the shipped data
   * `roof-stack` arrives with three distinct unit prototypes, `roof-vent` with three and
   * `roof-hatch` with two, because different planners size their own. Merging those into one mesh
   * keeps one shape and silently discards the rest — see `mergeInstancedFamilies`. Eleven meshes,
   * 195 instances, 2,540 triangles.
   */
  function addBuildingDetailInstances() {
    for (const family of buildingDetail.families) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(family.prototype.positions), 3));
      geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(family.prototype.indices), 1));
      if (family.prototype.normals) {
        geometry.setAttribute('normal', new THREE.BufferAttribute(Float32Array.from(family.prototype.normals), 3));
      } else {
        geometry.computeVertexNormals();
      }
      const mesh = new THREE.InstancedMesh(geometry, materials[DETAIL_SLOT_MATERIAL[family.materialSlot]], family.count);
      mesh.name = `building-detail:${family.familyId}:${family.prototypeDigest}`;
      mesh.castShadow = mesh.receiveShadow = true;
      // The instances are scattered across the map, so one bounding sphere around all of them is
      // the whole map: culling it as a unit can only ever remove the roof plant while the roofs
      // stay, which is worse than not culling 11 small meshes.
      mesh.frustumCulled = false;
      mesh.userData = {
        kind: 'building-detail-instances',
        familyId: family.familyId,
        prototypeDigest: family.prototypeDigest,
        label: null,
        stableId: null,
      };
      const matrices = new Float32Array(family.count * 16);
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      const matrix = new THREE.Matrix4();
      const axis = new THREE.Vector3(0, 0, 1);
      for (let index = 0; index < family.count; index++) {
        position.set(family.offsets[index * 3], family.offsets[index * 3 + 1], family.offsets[index * 3 + 2]);
        quaternion.setFromAxisAngle(axis, family.yaws[index]);
        scale.set(family.scales[index * 3], family.scales[index * 3 + 1], family.scales[index * 3 + 2]);
        matrix.compose(position, quaternion, scale);
        matrices.set(matrix.elements, index * 16);
        mesh.setMatrixAt(index, matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      buildingGroup.add(mesh);
      detailInstanceMeshes.push({ mesh, family, matrices });
    }
  }

  /** Which buildings are currently retired in favour of an authored GLB. */
  function suppressedBuildingIndices() {
    const out = new Set();
    for (const [featureId, entry] of suppressedProceduralFeatures) {
      if (entry.kind !== 'building') continue;
      const index = buildingIndexByFeatureId.get(featureId);
      if (index !== undefined) out.add(index);
    }
    return out;
  }

  /**
   * The skirt, as ONE mesh for all 71 buildings.
   *
   * `src/buildings.js` has computed `plinthBase`/`plinthHeight` since 2026-08-30 and `placeBuildings`
   * has written them onto every row; `grep plinth src/map3d-three.js` returned nothing until now, so
   * on a cross-slope these buildings had an open gap on their downhill side and no shadow skirt at
   * all. Drawn UNLIT and near-black exactly as the deck renderer draws it.
   *
   * Rebuilt rather than hidden when the authored ledger changes: 67 skirts are 756 triangles, and a
   * per-building node would cost 67 draw calls to buy a `visible` flag.
   */
  function rebuildPlinths() {
    const data2 = plinthMeshData(buildingDetail?.rows ?? [], suppressedBuildingIndices());
    plinthRenderStats = { buildings: data2.buildings, triangles: data2.triangles };
    if (plinthMesh) {
      plinthMesh.geometry.dispose();
      plinthMesh.removeFromParent();
      plinthMesh = null;
    }
    if (!data2.triangles) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data2.positions, 3));
    geometry.computeBoundingSphere();
    plinthMesh = new THREE.Mesh(geometry, materials.plinth);
    plinthMesh.name = 'building-plinths';
    // Unlit and never a shadow caster: it IS the shadow. `castShadow` would darken the ground it
    // is trying to explain.
    plinthMesh.castShadow = false;
    plinthMesh.receiveShadow = false;
    plinthMesh.userData = { kind: 'building-plinth', label: null, stableId: null };
    buildingGroup?.add(plinthMesh);
  }

  /**
   * An instance is a separate object: it does not ride its owner's `visible = false`, so the
   * authored-asset suppression walk has to hide it by owner. That is one pass over `ownerIndex`,
   * which is exactly why the contract makes that array mandatory.
   */
  function refreshDetailInstances() {
    if (!detailInstanceMeshes.length) return;
    const suppressed = suppressedBuildingIndices();
    for (const entry of detailInstanceMeshes) {
      const visible = visibleInstanceIndices(entry.family, { suppressed });
      const array = entry.mesh.instanceMatrix.array;
      for (const [slot, index] of visible.entries()) {
        array.set(entry.matrices.subarray(index * 16, index * 16 + 16), slot * 16);
      }
      entry.mesh.count = visible.length;
      entry.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  function propInteractionLabel(prop, assetKind) {
    const stableId = safeText(prop.featureId);
    if (stableId.includes('red_container')) return stableId.endsWith('stack') ? 'Red container stack' : 'Red container';
    if (assetKind === 'locomotive') return 'Train · locomotive';
    if (assetKind === 'tanker-wagon' && prop.type === 'railcar') return 'Train · tanker wagon';
    return safeText(prop.name ?? prop.type) || 'prop';
  }

  /** Wall-prop runs from the shared plan, indexed by their row position in `data.props`. */
  let wallRunsByPropIndexCache = null;
  const wallRunsByPropIndex = () => (wallRunsByPropIndexCache ??= new Map(
    wallStructurePlan().runs
      .filter((run) => run.meta?.kind === 'wall-prop')
      .map((run) => [run.meta.sourceIndex, run]),
  ));
  const unclassifiedPathProps = [];

  function addProps() {
    propGroup = new THREE.Group();
    propGroup.name = 'props';
    for (const [propIndex, prop] of (data.props || []).entries()) {
      const root = new THREE.Group();
      let assetKind = prop.type ?? 'prop';
      if (Array.isArray(prop.path) && prop.path.length >= 2) {
        // `prop.h` and `prop.w` are deliberately NOT read. A wall's height and thickness come from
        // the class table in wall-runs.js, which is the one place the bounds lane has to edit;
        // a row that keeps its own numbers puts them back out of reach. A path row the planner
        // did not classify is skipped and counted rather than drawn at an invented size.
        const run = wallRunsByPropIndex().get(propIndex);
        if (!run) { unclassifiedPathProps.push(prop.name ?? prop.type ?? `prop:${propIndex}`); continue; }
        const built = buildSolidWallNode(run, materialForProp(prop));
        if (!built) continue;
        root.add(built.group);
        // addProps() runs after addWallStructures(), so the solid runs' cost is folded in here;
        // otherwise `renderStats().walls.triangles` would describe the fences only and read low.
        wallRenderStats.triangles += built.triangles;
        assetKind = 'linear-wall';
      } else if (Array.isArray(prop.poly) && prop.poly.length >= 3) {
        const shape = shapeFromRing(prop.poly);
        if (!shape) continue;
        const h = Math.max(0.2, Number(prop.h) || 1);
        const geometry = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
        const mesh = new THREE.Mesh(geometry, materialForProp(prop));
        const c = centroid(prop.poly);
        mesh.position.z = H(c[0], c[1]) + (Number(prop.dz) || 0);
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.name = 'footprint-prop';
        root.add(mesh);
        assetKind = 'footprint-prop';
      } else {
        const onRail = prop.type === 'railcar' || prop.type === 'tanker';
        const pose = pointPropPose(
          prop,
          H(prop.x, prop.z)
            + (exactTerrainMesh && onRail ? RAILWAY_TRACK_PROFILE.vehicleWheelBottomLiftM : 0),
        );
        if (!pose) continue;
        const asset = buildPropAsset(prop, (role) => materialForProp(prop, role));
        root.add(asset);
        root.position.set(...pose.position);
        root.rotation.z = pose.rotationZ;
        assetKind = asset.userData.assetKind;
      }
      if (!root.children.length) continue;
      root.name = safeText(prop.name ?? prop.type) || 'prop';
      root.userData = {
        kind: 'prop', assetKind, label: propInteractionLabel(prop, assetKind),
        stableId: prop.featureId ?? null, provisional: !prop.featureId,
      };
      propGroup.add(root);
    }
    worldRoot.add(propGroup);
  }

  /**
   * Build the procedural proxy meshes for one exact vegetation plan.
   *
   * Takes the plan as an argument rather than reading `exactVegetationPlan`, because once the
   * authored pack mounts this runs again over the ROUTER'S PROCEDURAL HALF — the complement of
   * whatever the authored pack admitted. With all 31 families admitted that half is empty and
   * every one of these eight batches disappears; with a partial pack it is a real, smaller set.
   *
   * Each geometry is constructed lazily, so an empty class costs no orphaned buffer.
   */
  function addExactVegetationMeshes(vegPlan, group) {
    const add = (spec) => {
      const placements = spec.placements ?? [];
      if (placements.length === 0) return;
      const mesh = exactVegetationInstancedMesh({ ...spec, placements, geometry: spec.geometry() });
      if (mesh) group.add(mesh);
    };
    const pine = vegPlan.groups.pine ?? [];
    const deciduous = vegPlan.groups.deciduous ?? [];
    const shrubs = vegPlan.groups.shrub ?? [];
    const stumps = vegPlan.groups.stump ?? [];
    const groundPlants = vegPlan.groups['ground-plant'] ?? [];

    add({
      geometry: () => {
        const geometry = new THREE.CylinderGeometry(1, 1, 1, 7);
        geometry.rotateX(Math.PI / 2);
        return geometry;
      },
      material: materials.trunk, placements: pine,
      name: 'exact-pine-trunks', component: 'pine-trunk', castShadow: true,
      transform: (dummy, placement) => {
        const { trunkHeight, trunkRadius } = placement.dimensions;
        dummy.position.z += trunkHeight / 2;
        dummy.scale.set(trunkRadius, trunkRadius, trunkHeight);
      },
    });
    for (const [layer, radiusFactor, heightFactor, centerFactor] of [
      ['lower', 0.5, 0.74, 0.51],
      ['upper', 0.34, 0.54, 0.76],
    ]) {
      add({
        geometry: () => {
          const geometry = new THREE.ConeGeometry(1, 1, 8);
          geometry.rotateX(Math.PI / 2);
          return geometry;
        },
        material: materials.pineFoliage, placements: pine,
        name: `exact-pine-crowns-${layer}`, component: `pine-crown-${layer}`,
        castShadow: layer === 'lower',
        transform: (dummy, placement) => {
          const { height, width, trunkHeight } = placement.dimensions;
          const crownHeight = Math.max(0.2, height - trunkHeight);
          dummy.position.z += trunkHeight + crownHeight * centerFactor;
          dummy.scale.set(width * radiusFactor, width * radiusFactor, crownHeight * heightFactor);
        },
      });
    }

    add({
      geometry: () => {
        const geometry = new THREE.CylinderGeometry(1, 0.82, 1, 7);
        geometry.rotateX(Math.PI / 2);
        return geometry;
      },
      material: materials.trunk, placements: deciduous,
      name: 'exact-deciduous-trunks', component: 'deciduous-trunk', castShadow: true,
      transform: (dummy, placement) => {
        const { trunkHeight, trunkRadius } = placement.dimensions;
        dummy.position.z += trunkHeight / 2;
        dummy.scale.set(trunkRadius, trunkRadius, trunkHeight);
      },
    });
    add({
      geometry: () => new THREE.DodecahedronGeometry(1, 0),
      material: materials.deciduousFoliage,
      placements: deciduous,
      name: 'exact-deciduous-crowns', component: 'deciduous-crown', castShadow: true,
      transform: (dummy, placement) => {
        const { height, width, trunkHeight } = placement.dimensions;
        const crownHeight = Math.max(0.2, height - trunkHeight);
        dummy.position.z += trunkHeight + crownHeight * 0.48;
        dummy.scale.set(width * 0.5, width * 0.44, crownHeight * 0.54);
      },
    });
    add({
      geometry: () => new THREE.DodecahedronGeometry(1, 0),
      material: materials.shrubFoliage,
      placements: shrubs,
      name: 'exact-shrubs', component: 'shrub',
      transform: (dummy, placement) => {
        const { height, width } = placement.dimensions;
        dummy.position.z += height * 0.43;
        dummy.scale.set(width * 0.5, width * 0.43, height * 0.52);
      },
    });
    add({
      geometry: () => {
        const geometry = new THREE.CylinderGeometry(1, 0.84, 1, 7);
        geometry.rotateX(Math.PI / 2);
        return geometry;
      },
      material: materials.trunk, placements: stumps,
      name: 'exact-stumps', component: 'stump', castShadow: true,
      transform: (dummy, placement) => {
        const { height, trunkRadius } = placement.dimensions;
        dummy.position.z += height / 2;
        dummy.scale.set(trunkRadius, trunkRadius, height);
      },
    });
    add({
      geometry: () => grassTuftGeometry(2, true),
      material: materials.groundPlant,
      placements: groundPlants,
      name: 'exact-ground-plants', component: 'ground-plant',
      transform: (dummy, placement) => {
        const { height, width } = placement.dimensions;
        dummy.position.z += 0.025;
        dummy.scale.set(width, width, height);
      },
    });
  }

  function exactVegetationGroupUserData(vegPlan) {
    return {
      kind: 'exact-local-vegetation',
      declaredInstances: vegPlan.sourceCount,
      renderedInstances: vegPlan.renderedCount,
      classes: { ...vegPlan.counts },
      placementAccuracy: 'canonical-game-authored',
      geometryAccuracy: 'original-procedural-class-proxies',
    };
  }

  function addTreesAndRocks() {
    treeGroup = new THREE.Group();
    treeGroup.name = proceduralVegetationPlan ? 'exact-local-vegetation' : 'trees';
    // Reset on every world rebuild: this is a measurement of the group that exists right now, not
    // a running total across rebuilds.
    publicTreePlacements = 0;
    if (proceduralVegetationPlan) {
      treeGroup.userData = exactVegetationGroupUserData(proceduralVegetationPlan);
      addExactVegetationMeshes(proceduralVegetationPlan, treeGroup);
    } else {
      const trees = data.trees || [];
      const trunkGeometry = new THREE.CylinderGeometry(1, 1, 1, 6);
      const crownGeometry = new THREE.ConeGeometry(1, 1, 7);
      trunkGeometry.rotateX(Math.PI / 2);
      crownGeometry.rotateX(Math.PI / 2);
      const trunks = new THREE.InstancedMesh(trunkGeometry, materials.trunk, trees.length);
      const crowns = new THREE.InstancedMesh(crownGeometry, materials.foliage, trees.length);
      const dummy = new THREE.Object3D();
      trees.forEach((tree, i) => {
        const h = Math.max(3, Number(tree.height) || 8), r = Math.max(0.8, Number(tree.radius) || 1.8);
        const base = H(tree.x, tree.z), trunkH = Math.max(1.4, Number(tree.trunkHeight) || h * 0.25);
        dummy.position.set(...gameToWorld(tree.x, tree.z, base + trunkH / 2));
        dummy.scale.set(Math.max(0.1, Number(tree.trunkRadius) || 0.2), Math.max(0.1, Number(tree.trunkRadius) || 0.2), trunkH);
        dummy.rotation.z = -(Number(tree.rotation) || 0) * Math.PI / 180;
        dummy.updateMatrix(); trunks.setMatrixAt(i, dummy.matrix);
        dummy.position.set(...gameToWorld(tree.x, tree.z, base + trunkH + (h - trunkH) / 2));
        dummy.scale.set(r, r, h - trunkH);
        dummy.updateMatrix(); crowns.setMatrixAt(i, dummy.matrix);
      });
      trunks.instanceMatrix.needsUpdate = crowns.instanceMatrix.needsUpdate = true;
      trunks.castShadow = crowns.castShadow = true;
      trunks.receiveShadow = crowns.receiveShadow = true;
      // Tagged so the observability collector can COUNT what is on screen. Untagged, these two
      // meshes were invisible to `authoredVegetationRenderStats()`, which filters on
      // `userData.kind`, and a production frame drawing 2,348 public trees reported
      // `procedural.placements: 0` — the identical defect class this module exists to delete, one
      // branch further along. A placement that is drawn is counted or it is not drawn.
      trunks.userData = { kind: 'public-tree-proxy', part: 'trunk', source: 'customs-3d.trees' };
      crowns.userData = { kind: 'public-tree-proxy', part: 'crown', source: 'customs-3d.trees' };
      treeGroup.add(trunks, crowns);
      publicTreePlacements = trees.length;
    }
    worldRoot.add(treeGroup);

    rockGroup = new THREE.Group();
    rockGroup.name = 'rocks';
    for (const rock of data.rocks || []) {
      const shape = shapeFromRing(rock.poly);
      if (!shape) continue;
      const geometry = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.2, Number(rock.height) || 1), bevelEnabled: true, bevelSize: 0.12, bevelThickness: 0.08, bevelSegments: 1 });
      const mesh = new THREE.Mesh(geometry, materials.rock);
      const c = centroid(rock.poly);
      mesh.position.z = H(c[0], c[1]) + 0.02;
      mesh.castShadow = mesh.receiveShadow = true;
      rockGroup.add(mesh);
    }
    worldRoot.add(rockGroup);
  }

  // Procedural features retired by the *current* attachment ledger, keyed by feature ID. The
  // synchronized map is replaceable: when a cell leaves, an LOD fails, or a replacement starts
  // reloading, its procedural node is restored before the next asynchronous loader wait.
  const suppressedProceduralFeatures = new Map();
  const suppressedProceduralNodes = new Map();

  function proceduralFeatureNodes(featureId, kind) {
    const nodes = [];
    const acceptedKinds = kind === 'surface' ? new Set(['floor-surface']) : new Set([kind]);
    for (const group of [buildingGroup, propGroup]) {
      group?.traverse?.((node) => {
        if (node === group || node.userData?.stableId !== featureId) return;
        if (!acceptedKinds.has(node.userData?.kind)) return;
        nodes.push(node);
      });
    }
    return nodes;
  }

  function restoreProceduralSuppression() {
    for (const records of suppressedProceduralNodes.values()) {
      for (const { node, visible } of records) {
        node.visible = visible;
        delete node.userData.authoredSuppressionPolicy;
      }
    }
    suppressedProceduralNodes.clear();
  }

  function applyProceduralSuppression() {
    // Restore the last baseline before capturing this one. This makes a world rebuild or a ledger
    // change while suppressed reversible instead of preserving a stale hidden state forever.
    restoreProceduralSuppression();
    for (const [featureId, entry] of suppressedProceduralFeatures) {
      const records = [];
      for (const node of proceduralFeatureNodes(featureId, entry.kind)) {
        records.push({ node, visible: node.visible });
        // `visibleInteractionData` walks ancestors for `visible === false`, so hiding the node
        // takes it out of picking too. A hidden-but-still-pickable variant, which is what
        // `hide-mesh` versus `hide-mesh-and-picking` would distinguish, is staged.
        node.visible = false;
        node.userData.authoredSuppressionPolicy = entry.policy;
      }
      if (records.length) suppressedProceduralNodes.set(featureId, records);
    }
    // Detail instances and the merged skirt are NOT nodes with a `stableId`, so the walk above
    // cannot reach them. Without this the roof plant would hover over the Fortress GLB forever and
    // its skirt would stay under it — the same class of half-applied state as a building mesh that
    // is hidden while its floor slabs are not. `applyProceduralSuppression` is the one function
    // both `rebuildWorld` and `syncProceduralSuppression` funnel through, which is why it is here.
    refreshDetailInstances();
    syncPlinthSuppression();
    // Buildings and props are casters, and `refreshDetailInstances()` rewrites the roof-plant
    // instance buffers. Every path that retires or restores a procedural feature funnels through
    // here — `rebuildWorld`, `syncProceduralSuppression` (the authored ledger) and
    // `rebuildProceduralVegetation` — so this is the one invalidation the suppression lane needs.
    sunShadow.invalidate('procedural-suppression');
    invalidateRender();
  }

  /** Rebuild the merged skirt only when the retired set actually changed. */
  function syncPlinthSuppression() {
    const key = [...suppressedBuildingIndices()].sort((a, b) => a - b).join(',');
    if (key === plinthSuppressionKey) return;
    plinthSuppressionKey = key;
    rebuildPlinths();
  }

  /**
   * Synchronize, rather than append to, the set justified by the attachment ledger.
   *
   * IT RETURNS EARLY WHEN THE SET DID NOT CHANGE, AND THAT IS THE POINT.
   *
   * The authored streamer calls `publishState()` on EVERY pass, before its own empty-diff early
   * return, and every OrbitControls 'change' runs a pass. Without this gate a camera event —
   * i.e. every frame of a drag, an orbit or a zoom — ran the whole suppression pass: it restored and
   * re-hid the same nodes, rewrote 11 `InstancedMesh` buffers and set `instanceMatrix.needsUpdate`
   * on all of them (a GPU re-upload of 195 identical matrices), and called
   * `sunShadow.invalidate('procedural-suppression')`, which re-renders the 2048² depth map.
   *
   * That last one negated P1 exactly when it is worth having. This app renders ON DEMAND, so frame
   * time only exists while the camera is moving — which was the one regime in which the freeze was
   * being lifted every frame. The measured −38% / −31% was taken with the camera parked and did not
   * describe a drag at all. Measured on the shipped tree before this gate: six `tz.flyTo` calls
   * produced +14 invalidations, nine of them `procedural-suppression` with an unchanged set.
   *
   * WHAT MAKES THE SKIP SAFE, rather than merely cheap. When the key is equal the work below is
   * already a no-op by construction: the same features are restored and re-hidden to the same
   * `visible` values, `visibleInstanceIndices` returns the same slots, and `syncPlinthSuppression`
   * has its own identical early return. The one thing that could make it unsafe is the NODES having
   * changed underneath while the key did not — which is `rebuildWorld()`, and `rebuildWorld()`
   * clears the key (and calls `applyProceduralSuppression()` directly on the new graph) for exactly
   * that reason.
   */
  function syncProceduralSuppression(entries = []) {
    const key = proceduralSuppressionKey(entries);
    if (key === appliedProceduralSuppressionKey) return proceduralSuppressionResult;
    restoreProceduralSuppression();
    suppressedProceduralFeatures.clear();
    const applied = [];
    const retained = [];
    for (const { featureId, policy, kind } of entries) {
      // Trees, rocks and understory are drawn as InstancedMesh; removing one instance means
      // rebuilding the buffer, which is the next pass. Buildings, props and their floor surfaces
      // are individual nodes and can be retired now.
      if (kind !== 'building' && kind !== 'prop' && kind !== 'surface') {
        retained.push({
          featureId,
          reason: `attached, but this renderer cannot retire a procedural ${kind}`,
        });
        continue;
      }
      if (proceduralFeatureNodes(featureId, kind).length === 0) {
        retained.push({
          featureId,
          reason: `attached, but no matching procedural ${kind} node exists`,
        });
        continue;
      }
      suppressedProceduralFeatures.set(featureId, { policy, kind });
      applied.push(featureId);
    }
    applyProceduralSuppression();
    // Cached with the key, because `publishState()` reads `applied`/`retained` on every pass and a
    // skipped pass must publish the same answer it published last time — not an empty one. A skip
    // that quietly emptied `status.manifest.suppressed` would be a status field that goes blank
    // whenever nothing changed, which is worse than the cost it saves.
    appliedProceduralSuppressionKey = key;
    proceduralSuppressionResult = Object.freeze({
      applied: Object.freeze(applied),
      retained: Object.freeze(retained),
    });
    return proceduralSuppressionResult;
  }

  function applyNature() {
    if (treeGroup) treeGroup.visible = nature.trees !== false;
    vegetationRoot.visible = nature.trees !== false;
    if (understoryGroup) understoryGroup.visible = nature.trees !== false;
    if (understoryTuftGroup) understoryTuftGroup.visible = nature.trees !== false && fx.detail !== false;
    if (rockGroup) rockGroup.visible = nature.rocks !== false;
    // `treeGroup` (procedural trunks and crowns) and `rockGroup` are both caster groups; hiding one
    // removes its shadows, and a frozen depth map would keep drawing them over hidden geometry.
    // `vegetationRoot` is in the list above but casts nothing today — see the repack invalidation.
    sunShadow.invalidate('nature-visibility');
    invalidateRender();
  }

  function updateUnderstoryLod() {
    if (!understoryTuftGroup) return;
    if (nature.trees === false) understoryLod = 'hidden';
    else if (fx.detail === false) understoryLod = 'carpet-only';
    else {
      const distance = camera.position.distanceTo(controls.target);
      const { nearMaxDistanceM, mediumMaxDistanceM, hysteresisM } = UNDERSTORY_TUFT_BUDGET;
      if (understoryLod === 'near' && distance <= nearMaxDistanceM + hysteresisM) understoryLod = 'near';
      else if (understoryLod === 'medium' && distance < nearMaxDistanceM - hysteresisM) understoryLod = 'near';
      else if (understoryLod === 'medium' && distance <= mediumMaxDistanceM + hysteresisM) understoryLod = 'medium';
      else if (understoryLod === 'overview' && distance > mediumMaxDistanceM - hysteresisM) understoryLod = 'overview';
      else if (distance <= nearMaxDistanceM) understoryLod = 'near';
      else if (distance <= mediumMaxDistanceM) understoryLod = 'medium';
      else understoryLod = 'overview';
    }
    understoryTuftGroup.visible = nature.trees !== false && fx.detail !== false;
    for (const mesh of understoryTuftGroup.children) {
      mesh.visible = understoryTuftGroup.visible && mesh.userData.lod === understoryLod;
    }
    understoryRenderStats.lod = understoryLod;
    understoryRenderStats.activeDrawCalls = ['near', 'medium'].includes(understoryLod) ? 1 : 0;
    understoryRenderStats.activeTriangles = understoryLod === 'near'
      ? understoryRenderStats.nearTriangles
      : understoryLod === 'medium' ? understoryRenderStats.mediumTriangles : 0;
  }

  function rebuildWorld() {
    disposeTree(worldRoot);
    H = exactTerrainSampler(exactTerrainPackage, makeTerrainSampler(data.terrain, relief));
    HCanonical = exactTerrainSampler(
      exactTerrainPackage,
      makeTerrainSampler(data.terrain, 1),
      'canonicalYM',
    );
    floorResolver = createFloorSurfaceResolver(data.floorSurfaces, relief);
    surfaceRenderStats = { floors: 0, roofs: 0, stableIds: [] };
    // `disposeTree(worldRoot)` above has already released every building geometry; these handles
    // would otherwise point at disposed buffers and the next suppression pass would write into
    // them. Cleared here rather than inside `addBuildings` so the state cannot outlive one world.
    detailInstanceMeshes = [];
    plinthMesh = null;
    plinthSuppressionKey = null;
    // Every procedural node the last suppression pass hid has just been disposed, so the set that
    // was applied describes a graph that no longer exists. Clearing the key is what makes
    // `syncProceduralSuppression`'s no-op skip safe: without it, the first ledger publish after a
    // world rebuild would compare equal and decline to re-hide the new proxies.
    appliedProceduralSuppressionKey = null;
    plinthRenderStats = { buildings: 0, triangles: 0 };
    buildingRenderStats = null;
    buildingDetail = null;
    buildingIndexByFeatureId = new Map();
    buildingProfilesByIndex = new Map();
    addTerrain();
    addUnderstory();
    addWater();
    addRoadsAndLines();
    addBuildings();
    addProps();
    addTreesAndRocks();
    applyProceduralSuppression();
    applyNature();
    // `applyProceduralSuppression` re-applies the synchronized suppression map after rebuilding
    // every procedural group, so a world refresh cannot resurrect an authored replacement's proxy.
    updateUnderstoryLod();
    // Every caster in the frame except the authored GLBs was just disposed and rebuilt: buildings
    // and their detail instances, props, bridge decks/approaches/piers, rails, walls/fences/gates,
    // rocks and the procedural tree proxies. This is also the FIRST bake — `rebuildWorld()` is the
    // initial world build, called once from the boot sequence below.
    sunShadow.invalidate('world-build');
    invalidateRender();
  }

  function applyLook() {
    const real = look === 'realistic';
    scene.background = new THREE.Color(real ? 0x353d36 : 0x0a100e);
    scene.fog = null;
    // A MATERIAL change, never a geometry one: the flip "cannot move a vertex" and the skirt's
    // buffer is built once, in `rebuildPlinths`, from data that has no `look` in it.
    materials.plinth.color.copy(rgb(plinthColor(look)));
    hemi.intensity = real ? 2.05 : 1.2;
    ambient.intensity = real ? 0.24 : 0.08;
    sun.intensity = real ? 2.65 : 2;
    renderer.toneMapping = real && fx.grade ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
    renderer.toneMappingExposure = real && fx.grade ? 0.93 : 1;
    const terrain = worldRoot.getObjectByName('terrain');
    terrain?.traverse?.((node) => {
      if (!node.isMesh) return;
      if (node.userData?.kind === 'exact-local-terrain-tile') {
        node.material = real
          ? (fx.detail ? (exactTerrainMaterials.get(node.userData.tileId) ?? materials.terrainExactFlat) : materials.terrainExactFlat)
          : materials.terrainVector;
      } else {
        node.material = real
          ? (fx.detail ? materials.terrain : materials.terrainFlat)
          : materials.terrainVector;
      }
    });
    // The shared realistic atlas already contains evidence-aligned pavement, road shoulders,
    // rails and sleepers. The legacy flat ribbons masked that authored detail at close zoom; keep
    // them only as the vector-look fallback or if atlas generation failed.
    const showFlatSurfaceNetwork = !real || !textures.groundAtlas;
    worldRoot.traverse((node) => {
      if (node.userData?.semanticGroundOverlay) node.visible = showFlatSurfaceNetwork;
    });
    if (understoryGroup) for (const mesh of understoryGroup.children) {
      mesh.material = real ? (fx.detail ? materials.grass : materials.grassFlat) : materials.grassVector;
    }
    if (understoryTuftGroup) for (const mesh of understoryTuftGroup.children) {
      mesh.material = real ? materials.grassBlade : materials.grassBladeVector;
    }
    if (status.exactTerrain?.mode === 'local-exact') {
      status.exactTerrain.surface = exactTerrainSurfaceStatus().active;
    }
    // The flip just changed which material every terrain tile draws, so the strip's surface claim
    // changed with it. Repaint on the transition rather than waiting out the 400 ms tick — the
    // whole point of the claim is that it describes the frame in front of the reader.
    noteVegetationTransition();
    applyNature();
    updateUnderstoryLod();
    // `sun.intensity` moved above, and the terrain/understory materials were swapped. Neither of
    // those is a depth-map input as the scene stands today (terrain and understory do not cast), so
    // this invalidation is belt-and-braces on a rare user action — a look flip is a click, not a
    // frame — and it is what keeps "any change to the sun" true rather than merely believed.
    sunShadow.invalidate('look');
    invalidateRender();
  }

  /*
   * THE PLACE-NAME LEADER, in the HTML overlay (founder-approved, 2026-09-02).
   *
   *     anchor ring at the real position -> hairline stem rising -> cap tick -> the name above it
   *
   * `updateOverlayPositions()` anchors every overlay element BOTTOM-CENTRE on its projected point,
   * so the leader lives in the element's own bottom padding: the box's bottom edge IS the ground
   * position, the ring sits on it, and the word rides `stemPx` above. Every number — size, weight,
   * tracking, case, ink, halo, stem length — comes from src/label-tier.js through custom
   * properties, exactly as in the 2D pass; style.css holds no tier value of its own.
   *
   * `zone` has `stemPx: 0` by definition, so it gets no ring, no stem and no cap; its padding
   * centres the word on the anchor instead, the cartographic convention for a region name.
   */
  function placeLabelChrome(element, text, tier) {
    const s = labelStyleFor(tier);       // THROWS on an unknown tier — deliberately, see label-tier.js
    element.classList.add(`tier-${tier}`);
    for (const [prop, value] of Object.entries(labelCssProps(tier))) element.style.setProperty(prop, value);
    element.textContent = '';
    const name = document.createElement('span');
    name.className = 'pl-name';
    // The tier decides the register; the overlay's CSS `text-transform` does the drawing, so the
    // text node keeps the real string and a screen reader is not handed shouted capitals.
    name.textContent = text;
    element.append(name);
    if (s.stemPx > 0) for (const cls of LEADER_PIECES) {
      const piece = document.createElement('i');
      piece.className = cls;
      element.append(piece);
    }
  }

  /*
   * THE MARKER BADGE, in the HTML overlay (2026-09-03).
   *
   * Everything a marker draws — which mark, at which tier, and whether its name comes with it —
   * lives in src/marker-overlay.js, on top of the same src/icons.js vocabulary the 2D map and the
   * deck diorama draw. This function only decides WHEN to repaint. `null` back from
   * paintMarkerOverlay() means the kind is not in the vocabulary, and the plain text pill the
   * caller already wrote stays: a marker we cannot name must never be drawn as a badge we made up.
   */
  const paintMarker = (item, tier) => {
    const painted = paintMarkerOverlay(item.element, item.spec, tier);
    if (painted) item.mark = painted.mark;
    return painted;
  };

  /*
   * THE OVERLAY'S ELEMENT BOXES, CACHED — the whole reason `updateOverlayPositions()` can be a pure
   * computation (P2, 2026-09-03).
   *
   * `anchorOverlayMark()` needs the element's width and height to decide whether its BOX overlaps
   * the frame. Until now the frame loop read `offsetWidth`/`offsetHeight` for that, per item, per
   * frame, in between two style writes — one forced synchronous layout per item. Worse, the
   * anchoring fix earlier the same day moved the read ABOVE the on-screen test, so the layout was
   * forced for all 1,304 items when only 186 of them were on screen at `ground-close`.
   *
   * A box changes for exactly three reasons and none of them is "a frame was rendered":
   *   1. the element was just built           -> measureOverlayItems() at the end of refreshDynamic
   *   2. the LOD tier repainted its mark      -> measureOverlayItems() at the end of syncMarkerTier
   *   3. anything else (a web font landing, a class flip, a name change, a stylesheet edit)
   *                                           -> the ResizeObserver below
   *
   * The observer is the honest half of this: it makes the cache self-correcting rather than a list
   * of assumptions about which code paths resize a marker. It reads `offsetWidth` in its own
   * callback, which the browser delivers AFTER layout and BEFORE paint — the value is byte-identical
   * to what the frame loop used to read, and reading it there forces nothing. `borderBoxSize` was
   * deliberately not used in its place: it is fractional where `offsetWidth` is rounded, so it would
   * have moved the on-screen test by up to half a pixel and changed which marks draw at the frame
   * edge. This cache must not change one pixel, so it stores the number the old read stored.
   *
   * A HIDDEN element measures 0x0 (`[hidden]{display:none!important}`), and the loop it replaces
   * read exactly that. So a 0 is never written into the cache — it is applied at USE time, from the
   * item's own last-written `hidden`, in `updateOverlayPositions()`. That reproduces the shipped
   * hysteresis exactly: a mark is admitted on its anchor POINT (0x0 box) and kept on its real box.
   */
  const overlayItemByElement = new WeakMap();
  function measureOverlayItem(item) {
    // A hidden element has no box. Measuring one would cache a 0 and shrink the on-screen test.
    if (item.element.hidden) return;
    const width = item.element.offsetWidth, height = item.element.offsetHeight;
    // Nor does ANY of them while the stage is `display:none` — which is the whole of the 2D view,
    // and `syncMarkerTier()` runs there (main.js's updateHud drives the ladder in both views). A 0
    // cached from that would make the first 3D frame after the switch test every mark against a
    // 0x0 box. A real element is never 0x0, so refusing the pair costs nothing.
    if (width === 0 && height === 0) return;
    item.width = width;
    item.height = height;
  }
  /** One read pass over every item — called only after a build or a repaint, never inside a frame. */
  function measureOverlayItems() {
    for (const item of overlayItems) measureOverlayItem(item);
  }
  const overlayResizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const item = overlayItemByElement.get(entry.target);
        // The observer fires with a 0x0 box every time an element is hidden. That is the state the
        // cache deliberately does not hold; the loop applies it from `hidden` instead.
        if (!item || entry.target.hidden) continue;
        const width = entry.target.offsetWidth, height = entry.target.offsetHeight;
        // The stage going `display:none` on a 2D switch delivers a 0x0 for every observed element
        // with `hidden` still false. Same refusal as measureOverlayItem(), same reason.
        if (width === 0 && height === 0) continue;
        if (width === item.width && height === item.height) continue;
        item.width = width;
        item.height = height;
        changed = true;
      }
      // A box that changed can change whether its mark is on screen, so the frame has to be redrawn
      // — but only when something actually moved, or this would be a self-feeding render loop.
      if (changed) invalidateRender();
    })
    : null;

  function makeOverlayItem({ label, x, z, y = null, kind = 'place', markerKind = null, level = 'surface', onClick = null, title = '', tier = null }) {
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(z))) return;
    const element = document.createElement(onClick ? 'button' : 'div');
    if (onClick) element.type = 'button';
    element.className = `tz-three-marker tz-three-marker-${kind}`;
    element.textContent = safeText(label);
    element.title = safeText(title || label);
    if (tier) placeLabelChrome(element, safeText(label), tier);
    if (markerKind) element.dataset.markerKind = markerKind;
    if (onClick) element.addEventListener('click', (event) => { event.stopPropagation(); onClick(); });
    overlay.append(element);
    const gx = Number(x), gz = Number(z);
    const gy = Number.isFinite(Number(y)) ? Number(y) : null;
    // The world point, resolved ONCE. `H` is reassigned only by `rebuildWorld()`, which runs before
    // the `refreshDynamic()` that builds these items and is never called again, so the height under
    // a label cannot go stale behind this. Held as three scalars rather than a Vector3 so the frame
    // loop can `set()` a single reused vector instead of allocating 1,304 of them per frame.
    const [wx, wy, wz] = gameToWorld(gx, gz, gy ?? H(gx, gz) + 1.2);
    const item = {
      element, x: gx, z: gz, y: gy, wx, wy, wz, kind, tier,
      spec: markerKind ? { markerKind, label: safeText(label), title: safeText(title || label), level } : null,
      mark: null,
      // The cached box (see measureOverlayItem above) and the two last-written DOM values. Both
      // start at what the element actually is right now: appended, visible, no transform written.
      width: 0, height: 0, hiddenNow: false, lastTransform: '', anchor: null,
    };
    // A place label is NOT a marker: it keeps the leader-line chrome above and never gets a badge.
    if (item.spec && !tier) paintMarker(item, overlayMarkerTier);
    overlayItemByElement.set(element, item);
    overlayResizeObserver?.observe(element);
    overlayItems.push(item);
  }

  /*
   * THE MARKER LADDER, live under a moving camera.
   *
   * src/lod.js is the one ladder — metres per pixel, ±10% hysteresis, dot / icon / full — and
   * deck.gl already drives it. Three raises `onViewChange` on every camera move, and main.js's
   * updateHud() folds that into the same shared tier; this renderer folds the SAME metres-per-pixel
   * in itself (`1 / 2^zoom`, the definition map3d.js uses) so the overlay cannot be one frame or
   * one code path behind the number the HUD is printing. `updateTier` is idempotent, so both
   * callers agreeing costs nothing.
   *
   * Repainting is gated on the tier CHANGING, not on the camera moving: a badge that is rebuilt on
   * every wheel notch is 200 innerHTML writes per frame for no visible difference.
   */
  let overlayMarkerTier = currentMarkerTier();
  // The camera's own zoom, pushed here by every path that moves it. Held separately from
  // `viewState` because that binding is declared much further down this closure and the first
  // `refreshDynamic()` runs before it exists — reading it from here would be a TDZ throw, not a
  // fallback. `null` means "no camera yet": the shared tier is then the only honest answer.
  let overlayCameraZoom = null;
  const noteCameraZoom = (zoom) => {
    if (Number.isFinite(Number(zoom))) overlayCameraZoom = Number(zoom);
    return syncMarkerTier();
  };
  function syncMarkerTier(force = false) {
    if (overlayCameraZoom == null) return overlayMarkerTier;
    const t = updateMarkerTier(1 / Math.pow(2, overlayCameraZoom));
    if (!force && t === overlayMarkerTier) return t;
    overlayMarkerTier = t;
    let repainted = 0;
    for (const item of overlayItems) if (item.spec && paintMarker(item, t)) repainted += 1;
    // A tier repaint replaces the mark, and a dot is not the size of a badge. Re-measured HERE, in
    // one read pass after every write, rather than in the frame loop that used to read it back.
    if (repainted) { measureOverlayItems(); invalidateRender(); }
    return t;
  }

  function clearOverlays() {
    // Disconnect before the elements go, so the observer is never holding a detached node.
    overlayResizeObserver?.disconnect();
    for (const item of overlayItems) item.element.remove();
    overlayItems = [];
  }

  /*
   * The one profiler hook on an EVENT path.
   *
   * `refreshDynamic()` is a full overlay + dynamicRoot teardown and rebuild, reached from nine
   * `main.js` call sites including the 1 Hz live-player tick, so it is real cost that never appears
   * inside a rendered frame. Timing it by wrapping rather than by editing its body means the
   * profiled and unprofiled paths run byte-identical code, and the OFF path costs one comparison
   * against `null` plus one call — on a function that runs at most a few times a second.
   */
  function refreshDynamic() {
    if (!frameProfiler) return refreshDynamicNow();
    const startedAt = performance.now();
    try { return refreshDynamicNow(); }
    finally { frameProfiler.event('refreshDynamic', performance.now() - startedAt); }
  }

  function refreshDynamicNow() {
    clearOverlays();
    disposeTree(dynamicRoot);
    /*
     * THINNING IS NOT DONE HERE. `src.labels()` is main.js's labelSet(), which has already applied
     * the metres-per-pixel ladder in src/label-tier.js plus the Density override — one ladder for
     * all three renderers. main.js re-runs it from updateHud(), and this renderer raises
     * onViewChange on every camera move, so refresh() lands here whenever the tier set changes.
     */
    for (const label of src.labels?.() || []) {
      const [x, z] = label.position || [];
      if (withinOverlayScope([x, z], overlayScope)) {
        // tierOf() THROWS on a row with no valid tier: a label that lost its tier must fail where
        // the bad value is, not quietly inherit one and be believed (handoff §6).
        makeOverlayItem({ label: label.text ?? label.name, x, z, kind: 'place', tier: labelTierOf(label) });
      }
    }
    for (const marker of src.markers?.() || []) {
      const spec = markerOverlaySpec(marker);
      if (!spec || !withinOverlayScope([spec.x, spec.z], overlayScope)) continue;
      makeOverlayItem({
        ...spec,
        y: spec.y == null
          ? null
          : displayCanonicalObjectY(spec.y, spec.x, spec.z) + 0.8,
      });
    }
    const questData = src.quests?.() || {};
    for (const sourceZone of questData.zones || []) {
      const zone = questZoneSpec(sourceZone);
      if (!zone || !zone.outline.some((point) => withinOverlayScope(point, overlayScope))) continue;
      const shape = shapeFromRing(zone.outline);
      if (!shape) continue;
      const geometry = new THREE.ShapeGeometry(shape);
      const mesh = new THREE.Mesh(geometry, materials.questZone);
      mesh.position.z = zone.outline.reduce((sum, [x, z]) => sum + H(x, z) / zone.outline.length, 0) + 0.28;
      mesh.renderOrder = 3;
      mesh.userData = { kind: 'quest-zone', label: 'Quest objective zone', stableId: zone.id };
      dynamicRoot.add(mesh);
      const line = lineGeometry([...zone.outline, zone.outline[0]], H, 0.36);
      if (line) {
        const outline = new THREE.Line(line, materials.questZoneLine);
        outline.renderOrder = 4;
        dynamicRoot.add(outline);
      }
    }
    for (const point of questData.points || []) {
      const pos = point.pin ?? point.position;
      if (!pos || !withinOverlayScope(pos, overlayScope)) continue;
      const canonicalPosition = point.position ?? pos;
      const y = displayCanonicalObjectY(
        canonicalPosition.y,
        canonicalPosition.x,
        canonicalPosition.z,
        pos.x,
        pos.z,
      ) + 0.9;
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.85, 14, 10), materials.quest);
      mesh.position.set(...gameToWorld(pos.x, pos.z, y));
      mesh.userData = { kind: 'quest', label: safeText(point.name ?? point.title ?? `Objective ${point.badge ?? ''}`), stableId: point.id ?? null };
      dynamicRoot.add(mesh);
      makeOverlayItem({
        label: point.badge ? `Q${point.badge}` : 'QUEST', x: pos.x, z: pos.z, y,
        kind: 'quest', title: mesh.userData.label, onClick: () => src.onQuestClick?.(point),
      });
    }
    for (const player of src.players?.() || []) {
      if (!player.last) continue;
      const last = player.last;
      const canonicalY = last.y == null ? null : Number(last.y);
      const y = displayCanonicalObjectY(canonicalY, last.x, last.z) + 1.2;
      const mesh = new THREE.Mesh(new THREE.ConeGeometry(1.15, 3.4, 7), materials.player);
      mesh.rotation.x = Math.PI / 2;
      mesh.rotation.z = -(Number(last.yaw ?? last.heading) || 0) * Math.PI / 180;
      mesh.position.set(...gameToWorld(last.x, last.z, y));
      mesh.userData = { kind: 'player', label: safeText(player.name ?? player.code ?? 'LIVE') };
      dynamicRoot.add(mesh);
      makeOverlayItem({ label: mesh.userData.label || 'LIVE', x: last.x, z: last.z, y: y + 2.4, kind: 'player' });
    }
    // Every element is in the document and painted; measure them all in ONE read pass. Measuring
    // inside makeOverlayItem() would have been a forced layout per item — the very cost this change
    // removes from the frame loop, moved onto a path that runs on the 1 Hz live-player tick.
    measureOverlayItems();
    invalidateRender();
  }

  /*
   * The frame loop's scratch, allocated ONCE for the life of the renderer.
   *
   * The loop below runs over up to ~1,304 items on every rendered frame. Allocating a `Vector3`, an
   * ndc array and an options object per item per frame is ~3,900 short-lived objects a frame, which
   * is what `memory.heap.collectionsObserved` in the profile report is counting. `anchorOverlayMark`
   * is pure and retains neither argument, so both can safely be the same object every time.
   */
  const overlayProjection = new THREE.Vector3();
  const overlayNdc = [0, 0, 0];
  const overlayAnchorArgs = {
    ndc: overlayNdc, elementWidth: 0, elementHeight: 0, containerWidth: 1, containerHeight: 1,
  };

  /*
   * WHERE EVERY OVERLAY MARK GOES, once per frame.
   *
   * A mark is a claim about a place on the ground, so there are exactly two outcomes: it is drawn
   * at the pixel its world point projects to, or it is hidden. It is NEVER repositioned. Until
   * 2026-09-03 this loop admitted anything within 15% of the NDC cube and then ran the survivors
   * through a clamp into the safe rect, which pinned off-frame marks to the frame edge and slid
   * them along it as the camera moved (founder: "the icons don't stay where they belong ... they
   * come with the screen movement"). The whole decision — depth guard included — now lives in
   * `anchorOverlayMark()`, which is pure and is asserted against a real camera in
   * scripts/three-renderer-test.mjs; the measurements that killed the clamp are in its doc block.
   *
   * TWO PHASES, AND WHY (P2, 2026-09-03). The founder's 5080 measured this pass at 10.60 ms median
   * / 13.80 p95 at `ground-close` with 1,304 items — over half of a 20.90 ms frame, and the only
   * configuration in the whole baseline that misses the 16.67 ms 60 Hz budget. A Codex red team
   * (cxt-20260903-210116-trjd) found the shape: only 186 of those 1,304 elements were on screen,
   * and the loop read layout for all 1,304 — because the anchoring fix earlier that day moved the
   * `offsetWidth` read ABOVE the on-screen test. Read, write, read, write, per item: every read
   * flushes the layout the previous item's write invalidated.
   *
   *   PHASE 1 computes. It touches no DOM at all — the world point is three scalars resolved at
   *           creation, the projection reuses ONE Vector3, the arguments reuse one array and one
   *           object, and the box comes from the cache above. Nothing here can force a layout,
   *           because nothing here reads one.
   *   PHASE 2 writes, and only what changed. A `hidden` that is already right and a transform
   *           string identical to the one on the element are both skipped; on a still camera that
   *           is the entire pass reduced to a comparison per item.
   *
   * The OUTPUT is byte-for-byte what the interleaved loop produced. Same `anchorOverlayMark()`,
   * same arguments (including the 0x0 box a hidden element reported), same `toFixed(1)` string.
   */
  function updateOverlayPositions() {
    const width = Math.max(1, container.clientWidth), height = Math.max(1, container.clientHeight);
    overlayAnchorArgs.containerWidth = width;
    overlayAnchorArgs.containerHeight = height;
    // ── Phase 1: compute. No DOM read, no DOM write, no per-item allocation. ──
    for (const item of overlayItems) {
      overlayProjection.set(item.wx, item.wy, item.wz).project(camera);
      overlayNdc[0] = overlayProjection.x;
      overlayNdc[1] = overlayProjection.y;
      overlayNdc[2] = overlayProjection.z;
      // The 0x0 box of a hidden element, applied from the last write rather than read back out of
      // the DOM. This is what keeps the admit-on-the-point / keep-on-the-box behaviour identical.
      overlayAnchorArgs.elementWidth = item.hiddenNow ? 0 : item.width;
      overlayAnchorArgs.elementHeight = item.hiddenNow ? 0 : item.height;
      item.anchor = anchorOverlayMark(overlayAnchorArgs);
    }
    // ── Phase 2: write. Nothing below reads layout, so no write here forces one. ──
    for (const item of overlayItems) {
      const anchor = item.anchor;
      item.anchor = null;
      const hidden = !anchor;
      if (hidden !== item.hiddenNow) {
        item.element.hidden = hidden;
        item.hiddenNow = hidden;
      }
      if (!anchor) continue;
      const transform = `translate3d(${anchor[0].toFixed(1)}px,${anchor[1].toFixed(1)}px,0) translate(-50%,-100%)`;
      if (transform === item.lastTransform) continue;
      item.element.style.transform = transform;
      item.lastTransform = transform;
    }
  }

  /**
   * The SAME loop, read/write ordering reversed. Instrument only — never on the render path.
   *
   * `updateOverlayPositions()` above reads `offsetWidth`/`offsetHeight` and then writes `hidden`
   * and `style.transform`, per item, in one pass. A style write invalidates layout for the
   * document, so the next item's `offsetWidth` read forces the browser to flush it: one forced
   * synchronous layout per item per rendered frame, on a loop that runs over up to ~1,250 elements.
   * That is the shape §6.3 of the render map describes and that nothing in this repo has ever
   * measured.
   *
   * A stopwatch around the shipped loop cannot separate the reflow from the projection maths, the
   * `Vector3` allocation and the transform writes, which all happen in the same pass. So the probe
   * runs BOTH orderings on alternating frames and reports the difference. This variant reads every
   * box first (one layout flush for the whole pass, at most), then writes every result. The output
   * is identical — same `anchorOverlayMark` call, same arguments, same transform string — so the
   * delta is attributable to the ordering and to nothing else.
   *
   * It is deliberately NOT the shipped implementation. Batching costs an array of ~1,250 pairs per
   * frame and this file is not the place to make that trade; the profiler exists to say what the
   * trade would be worth, and the founder decides.
   */
  const overlayBoxes = [];
  function updateOverlayPositionsBatched() {
    const width = Math.max(1, container.clientWidth), height = Math.max(1, container.clientHeight);
    overlayBoxes.length = 0;
    // Pass 1 — reads only. Nothing above writes style, so at most one layout flush happens here.
    for (const item of overlayItems) overlayBoxes.push(item.element.offsetWidth, item.element.offsetHeight);
    // Pass 2 — writes only. No read follows a write, so no write forces a flush.
    let i = 0;
    for (const item of overlayItems) {
      const v = new THREE.Vector3(...gameToWorld(item.x, item.z, item.y ?? H(item.x, item.z) + 1.2)).project(camera);
      const anchor = anchorOverlayMark({
        ndc: [v.x, v.y, v.z],
        elementWidth: overlayBoxes[i],
        elementHeight: overlayBoxes[i + 1],
        containerWidth: width,
        containerHeight: height,
      });
      i += 2;
      item.element.hidden = !anchor;
      // The probe writes unconditionally — that is the ordering it exists to measure — but it must
      // leave the shipped loop's caches describing the DOM it just wrote, or the next interleaved
      // frame would skip a write the element still needs.
      item.hiddenNow = !anchor;
      if (!anchor) continue;
      const transform = `translate3d(${anchor[0].toFixed(1)}px,${anchor[1].toFixed(1)}px,0) translate(-50%,-100%)`;
      item.element.style.transform = transform;
      item.lastTransform = transform;
    }
  }

  /** How many overlay marks are on screen right now. Read once per probe, not per frame. */
  const visibleOverlayCount = () => overlayItems.reduce((n, item) => (item.element.hidden ? n : n + 1), 0);

  // One contiguous synchronous block — there is no yielding anywhere between `addTerrain()` and
  // the last overlay element, so this interval is a single main-thread task and the waterfall says
  // so rather than implying it was scheduled work.
  wfBegin('worldBuild');
  rebuildWorld();
  applyLook();
  refreshDynamic();
  wfEnd('worldBuild');
  const authoredStreamer = createAuthoredAssetStreamer({
    root: authoredRoot, status, guard: authoredGuard, signal: authoredAbort.signal,
    displayYFor: (x, z, canonicalY) => displayCanonicalObjectY(canonicalY, x, z),
    syncSuppression: syncProceduralSuppression,
    loaderHost: authoredLoaderHost,
    cache: authoredAssetCache,
    onChanged: () => invalidateRender(1),
    // An authored GLB entering or leaving the scene. `seatAuthoredInstance()` writes `castShadow`
    // from the instance's `shadow.mode`, so Fortress and every other streamed asset is a caster the
    // frozen depth map has to be told about. Deliberately NOT `onChanged`, which also fires on every
    // status publish — i.e. on every camera pass — and would re-bake the map through a whole pan.
    // Mapped explicitly, so an unrecognised kind reaches the closed enum's throw instead of being
    // absorbed into 'attach' by a ternary's else branch. It still invalidates either way, so no
    // stale shadow was ever possible here — but `stats().byReason` and `stats().last.reason` are the
    // fields the audit prints so a missing invalidation can be placed in the sequence, and a ledger
    // that quietly files a detach as an attach degrades exactly that.
    onCastersChanged: (kind) => sunShadow.invalidate(AUTHORED_ASSET_SHADOW_REASON[kind] ?? kind),
  });
  const updateAuthoredAssetsForTarget = () => {
    // OrbitControls' target is the real focus used by the user, in runtime [-x,-z,y]. The
    // streamer's planner consumes canonical EFT x/z, so never substitute the fixed proof scope.
    void authoredStreamer.update(authoredCameraFromWorldTarget(controls.target));
    scheduleAuthoredVegetationRepack();
  };

  // ── Authored vegetation: the hybrid router and its atomic mount ─────────────────────────────
  const vegetationRequest = (() => {
    const requested = new URLSearchParams(location.search).get('vegetation');
    return VALID_VEGETATION_REQUEST.has(requested) ? requested : null;
  })();
  // Where this mount reads its pack from. Chosen ONCE, off the package that actually loaded, so
  // the URLs, the catalog and the status can never describe different distributions.
  const promotedVegetation = exactVegetationSource === 'promoted-public';
  const vegetationRoutes = promotedVegetation
    ? { pack: CUSTOMS_PROMOTED_VEGETATION_BASE_URL, arrays: CUSTOMS_PROMOTED_VEGETATION_ARRAY_BASE_URL }
    : { pack: CUSTOMS_AUTHORED_VEGETATION_ROUTE, arrays: CUSTOMS_VEGETATION_ARRAY_ROUTE };
  const vegetationStatus = {
    mode: 'procedural',
    request: vegetationRequest,
    // Which package the 8,805 placements came from. `renderStats()` and the on-screen readouts both
    // take their wording from this one value.
    distribution: exactVegetationSource,
    // `promoted-vegetation-unavailable` (2026-09-02, vegetation promotion). Both of the codes it
    // replaced described a release build with no authored forest as the shipped configuration —
    // first by naming the symptom (public tree positions), then by naming the pack as not promoted.
    // The pack IS promoted now: it ships from public/assets/3d/customs/authored/vegetation/ and
    // production draws it. So a release build without a plan is a DEFECT, and the reason has to
    // read like one. `three-renderer-test.mjs` asserts both old spellings are gone from this file;
    // do not reintroduce either, even in a comment.
    reason: exactVegetationPlan
      ? 'pending'
      // The placements are seated against the exact ground and culled to its scope, so no exact
      // terrain means no plan for a reason that has nothing to do with the vegetation package.
      // Naming the vegetation package there would send a reader to the wrong subsystem.
      : !exactTerrainMesh
        ? 'requires-exact-terrain'
        : localEnhancementsAllowed ? 'no-exact-vegetation-plan' : 'promoted-vegetation-unavailable',
    routes: vegetationRoutes,
    totals: null,
    // Declared, not implied. `warnings` reads both of these, and a field that only exists once
    // something has gone wrong is a field a reader cannot tell "healthy" from "never written".
    error: null,
    disposed: false,
    arrayTextures: null,
    arrayTextureError: null,
    // The full diagnosis, not just a code: which URL, why, and what it costs. Null until
    // something actually fails, so a truthy value is always a real defect.
    arrayTextureFailure: null,
    runtime: null,
    // Filled in while the pack loads (see `mountAuthoredVegetation`) so a mount in flight can be
    // told apart from a mount that is wedged, and so the repack that corrects the mount-time
    // partition is visible rather than assumed.
    mount: null,
    lastRepack: null,
  };
  status.authoredVegetation = vegetationStatus;

  const vegetationFrustum = new THREE.Frustum();
  const vegetationProjection = new THREE.Matrix4();
  function cameraFrustumForVegetation() {
    camera.updateMatrixWorld();
    vegetationProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    vegetationFrustum.setFromProjectionMatrix(vegetationProjection);
    return vegetationFrustum;
  }

  let vegetationRepackFrame = 0;
  /** Camera signature — position AND projection — the live partition was built for. */
  let vegetationPackedFor = null;
  /**
   * The signature of the camera as it stands right now.
   *
   * `camera.projectionMatrix` is read, not `aspect`/`fov` separately: the frustum the partition is
   * cut against is derived from that matrix and nothing else, so a change there is exactly the
   * question "could a different set of placements be visible now".
   */
  function liveVegetationCameraSignature() {
    camera.updateMatrixWorld();
    return vegetationCameraSignature(camera.position.toArray(), camera.projectionMatrix.elements);
  }
  function repackAuthoredVegetation(reason = 'requested') {
    if (!frameProfiler) return repackAuthoredVegetationNow(reason);
    const startedAt = performance.now();
    try { return repackAuthoredVegetationNow(reason); }
    finally { frameProfiler.event('vegetationRepack', performance.now() - startedAt); }
  }
  // A camera move of 4 m — or ANY projection change — repacks every authored placement inside one
  // rAF. It is not a per-frame cost and must not be averaged into one, so it is counted per event.
  function repackAuthoredVegetationNow(reason = 'requested') {
    if (!authoredVegetationRuntime?.active) return null;
    const signature = liveVegetationCameraSignature();
    authoredVegetationRuntime.update({
      cameraWorldPosition: [...signature.position],
      frustum: cameraFrustumForVegetation(),
    });
    vegetationPackedFor = signature;
    // A repack rewrites every authored bucket's instance list and LOD tier. Today that changes no
    // caster — the pack ships `shadowPolicy.mode: 'disabled'`, so `mesh.castShadow` is false for
    // every bucket at every LOD (customs-authored-vegetation.js:1589) — and invalidating here
    // unconditionally would re-bake the depth map every 4 m of camera movement, which is most of
    // the win. The condition is read from the LIVE RUNTIME's normalised policy (set at the mount
    // swap), never from the module default, so the gate and the meshes cannot describe two
    // different policies: the day a pack or a caller supplies `near-lod`, this becomes a real
    // invalidation with nobody having to remember it exists.
    if (authoredVegetationCastsShadows) sunShadow.invalidate('authored-vegetation-repack');
    vegetationStatus.lastRepack = {
      reason,
      atMs: Math.round(performance.now()),
      cameraWorldPosition: [...signature.position],
    };
    invalidateRender();
    return vegetationStatus.lastRepack;
  }
  function scheduleAuthoredVegetationRepack() {
    if (!authoredVegetationRuntime?.active || vegetationRepackFrame) return;
    // A viewport resize can widen the frustum without moving the camera one metre — `cameraPose()`
    // derives distance from clientHeight and zoom alone — so the projection is part of the gate,
    // not just the position. Measured before this check existed: widening 700 -> 2400 px left
    // 2,522 of 7,108 placements frustum-rejected against a frustum that no longer existed.
    const decision = decideVegetationRepack({
      next: liveVegetationCameraSignature(),
      last: vegetationPackedFor,
      epsilonMeters: AUTHORED_VEGETATION_REPACK_EPSILON_M,
    });
    if (!decision.repack) return;
    vegetationRepackFrame = requestAnimationFrame(() => {
      vegetationRepackFrame = 0;
      repackAuthoredVegetation(decision.reason);
    });
  }

  /**
   * Fetch one of the dev routes' JSON documents, refusing anything that is not JSON.
   *
   * `response.ok` is NOT enough, and assuming it was is what let an unregistered route ship. A
   * `/@…` prefix with no Vite plugin behind it falls through to the SPA fallback, which answers
   * **HTTP 200 with index.html**. `!response.ok` never fires, `response.json()` then throws
   * `Unexpected token '<'` somewhere far from the cause, and a caller that treats a parse failure
   * as "this artifact is unavailable" degrades silently instead of reporting a missing server.
   *
   * The content type is the one thing that separates the two: both dev routes set
   * `application/json`, and the SPA fallback sets `text/html`. Checking it turns a missing route
   * into a named, loud failure at the fetch, which is where it is diagnosable.
   */
  async function fetchLocalVegetationJson(url, { signal = null, cache = 'no-store' } = {}) {
    const response = await fetch(url, { cache, credentials: 'same-origin', signal });
    if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
    const contentType = String(response.headers?.get?.('content-type') ?? '').trim();
    if (!/^application\/json\b/i.test(contentType)) {
      const error = new Error(
        `${url} answered HTTP ${response.status} with content-type "${contentType || '(none)'}", not JSON`
        + ' — the dev route serving it is almost certainly not registered in vite.config.js, and Vite'
        + ' answered the SPA fallback instead',
      );
      error.code = 'ERR_LOCAL_ROUTE_NOT_JSON';
      throw error;
    }
    return response.json();
  }

  /**
   * Deadlines for one mount.
   *
   * Overridable from the query string for one reason: a deadline whose failure path nobody has ever
   * seen fire is a deadline nobody knows works, and the only other way to reach it is to wait out a
   * real 90-second stall.
   */
  const vegetationMountDeadlines = (() => {
    const params = new URLSearchParams(location.search);
    const ms = (name, fallback) => {
      const raw = Number(params.get(name));
      return Number.isFinite(raw) && raw > 0 ? raw : fallback;
    };
    return Object.freeze({
      stallMs: ms('vegetationStallMs', VEGETATION_MOUNT_STALL_MS),
      assembleMs: ms('vegetationAssembleMs', VEGETATION_MOUNT_ASSEMBLE_MS),
      totalMs: ms('vegetationDeadlineMs', VEGETATION_MOUNT_TOTAL_MS),
    });
  })();

  /**
   * Load the authored pack and swap it in as ONE step, or change nothing at all.
   *
   * Nothing here touches the scene until `createCustomsAuthoredVegetationRuntime` has resolved,
   * which it only does when every family at every LOD has decoded, merged and seated. A 404 on the
   * dev route (a production build, or a machine without the pack), a rejected alpha mode, a broken
   * receipt or an aborted view all leave the procedural vegetation exactly as it is — there is no
   * intermediate state in which half the forest is authored.
   *
   * The load takes 60-85 s at the default pose and minutes under contention, and for that whole
   * window it used to publish exactly one word — `pending` — with no count, no deadline and no way
   * to tell a slow loader from a dead one. `vegetationStatus.mount` now carries the count and the
   * clock, and a missed deadline aborts the mount and reports the failure instead of waiting
   * forever on a promise that will not settle.
   */
  async function mountAuthoredVegetation() {
    if (!exactVegetationPlan) return;
    wfBegin('vegetationMount');
    if (vegetationRequest === 'procedural') {
      vegetationStatus.reason = 'disabled-by-query';
      noteVegetationTransition();
      wfEnd('vegetationMount');
      return;
    }
    // A mount of its own, so a deadline can cancel THIS load without aborting the authored-asset
    // streamer that shares `authoredAbort`. Aborting the view still cancels the mount, one way.
    const mountAbort = new AbortController();
    const propagateAbort = () => mountAbort.abort(authoredAbort.signal.reason);
    if (authoredAbort.signal.aborted) propagateAbort();
    else authoredAbort.signal.addEventListener('abort', propagateAbort, { once: true });

    const progress = {
      phase: 'loading',
      step: 'pack-index',
      // `expected` is 3 GLBs per admitted family and is unknown until the router has run; until
      // then the stall and total deadlines still apply, only the fraction is withheld.
      expected: null,
      requested: 0,
      loaded: 0,
      fraction: null,
      startedMs: Math.round(performance.now()),
      elapsedMs: 0,
      sinceProgressMs: 0,
      lastProgressMs: null,
      deadlines: vegetationMountDeadlines,
      timedOut: null,
      cameraAtStart: camera.position.toArray(),
      cameraMovedDuringLoadM: null,
      // Embedded PNGs the array material made unnecessary to decode (597 for the whole pack), and
      // the reason the strip refused if it did. `glbImagesSkipped: 0` with a live array material
      // means the mount paid the full GLTF image decode for textures it then threw away.
      glbImagesSkipped: 0,
      glbImageStripFailure: null,
      // Where the mount's wall clock actually goes, measured rather than guessed. Every field is
      // milliseconds. The `glb*` rows are SUMMED across all 93 loads (so they exceed the wall span
      // whenever anything overlaps); `packIndexMs`, `arrayIndexMs`, `arrayBlobsMs`, `glbWallMs` and
      // `assembleMs` are disjoint wall-clock spans that add up to `totalMs`.
      timings: {
        packIndexMs: null,
        routeMs: null,
        arrayIndexMs: null,
        arrayBlobsMs: null,
        // How much of the array load was NOT already covered by the pack-index/route head that
        // runs beside it. `arrayIndexMs + arrayBlobsMs` is what the arrays cost; `arrayWaitMs` is
        // what they cost the MOUNT, and a healthy overlap drives it toward zero.
        arrayWaitMs: null,
        glbWallMs: null,
        glbFetchMs: 0,
        glbHashMs: 0,
        glbParseMs: 0,
        glbBytes: 0,
        assembleMs: null,
        swapMs: null,
        totalMs: null,
      },
    };
    vegetationStatus.mount = progress;
    vegetationStatus.reason = 'loading-pack-index';
    noteVegetationTransition();
    let timeoutFailure = null;
    const watchdog = setInterval(() => {
      const verdict = evaluateVegetationMount({
        nowMs: performance.now(),
        startedMs: progress.startedMs,
        lastProgressMs: progress.lastProgressMs,
        loaded: progress.loaded,
        expected: progress.expected,
        ...vegetationMountDeadlines,
      });
      progress.phase = verdict.phase;
      progress.fraction = verdict.fraction;
      progress.elapsedMs = Math.round(verdict.elapsedMs);
      progress.sinceProgressMs = Math.round(verdict.sinceProgressMs);
      vegetationStatus.reason = verdict.phase === 'assembling' ? 'assembling' : `loading-${progress.step}`;
      if (!verdict.expired || timeoutFailure) return;
      // Report from HERE, not from the catch below. A mount can miss its deadline because a fetch
      // never settles, in which case the promise this watchdog guards never rejects and the catch
      // never runs; the abort is a courtesy to the loader, not the thing that publishes the
      // failure. The interval stops with it, so nothing overwrites this reason on the next tick.
      clearInterval(watchdog);
      progress.phase = 'timed-out';
      timeoutFailure = {
        reason: verdict.reason,
        loaded: progress.loaded,
        expected: progress.expected,
        elapsedMs: progress.elapsedMs,
        sinceProgressMs: progress.sinceProgressMs,
        step: progress.step,
      };
      progress.timedOut = timeoutFailure;
      const error = new Error(
        `authored vegetation mount ${verdict.reason}: ${progress.loaded}/${progress.expected ?? '?'} GLBs`
        + ` after ${progress.elapsedMs} ms, ${progress.sinceProgressMs} ms since the last one`,
      );
      error.code = 'ERR_CUSTOMS_VEGETATION_MOUNT_TIMEOUT';
      vegetationStatus.mode = 'procedural';
      vegetationStatus.reason = verdict.reason;
      vegetationStatus.error = error.message;
      console.warn(`[three-poc] ${error.message} — procedural vegetation is retained`);
      // The deadline fired here, and the `finally` below may not run for a long time (a fetch that
      // never settles is exactly what this watchdog exists for). Publish the verdict now.
      noteVegetationTransition();
      mountAbort.abort(error);
    }, 1000);

    let arrays = null;
    let runtime = null;
    // Reported, not assumed. `glbImagesSkipped` is how many embedded PNGs the array material made
    // unnecessary to decode; `glbImageStripFailure` is non-null exactly when the strip refused and
    // the mount fell back to the full, slow decode.
    let glbImagesSkipped = 0;
    let glbImageStripFailure = null;
    const timings = progress.timings;
    const clock = () => performance.now();
    let phaseAt = clock();
    const stamp = (field) => {
      const at = clock();
      timings[field] = Math.round(at - phaseAt);
      phaseAt = at;
    };
    // ── The two heads of the mount, started together ───────────────────────────────────────────
    //
    // The texture-array set is addressed by a FIXED URL and depends on nothing the pack index or
    // the router produces, so waiting for a 1.85 MB `pack-index.json` before asking for the first
    // array blob only ever cost wall clock. Measured serially at the default pose: 1,003 ms for
    // the pack index, 48 ms for the array index and 624 ms for the nine blobs — 672 ms of the
    // mount spent strictly after work that could have been running the whole time.
    //
    // This task RESOLVES on failure rather than throwing. The arrays are an optimisation, not a
    // correctness requirement (without them the pack still batches per (family, LOD), just with
    // its own per-primitive materials), so their absence is a reported DEGRADATION and must not
    // abandon the swap — see `arrayTextureFailure` below, which is what makes a 199 -> 3 material
    // collapse that never ran distinguishable from one that did.
    // The promoted package's array index is an immutable, digest-pinned public asset, so it is
    // CACHEABLE — `no-store` there would re-download 186 KB on every navigation for no safety. The
    // dev route keeps `no-store` because the founder regenerates the pack underneath it.
    const arrayIndexUrl = promotedVegetation
      ? promotedVegetationPackage.arrayIndexUrl
      : `${CUSTOMS_VEGETATION_ARRAY_ROUTE}veg-layers.json`;
    const arrayTask = (async () => {
      const startedAt = clock();
      let indexAt = startedAt;
      try {
        const arrayIndex = validateCustomsVegetationTextureArrayIndex(
          await fetchLocalVegetationJson(arrayIndexUrl, {
            signal: mountAbort.signal,
            cache: promotedVegetation ? 'default' : 'no-store',
          }),
        );
        indexAt = clock();
        const loaded = await loadCustomsVegetationTextureArrays({
          index: arrayIndex,
          baseUrl: vegetationRoutes.arrays,
          signal: mountAbort.signal,
        });
        return {
          arrays: loaded,
          error: null,
          indexMs: Math.round(indexAt - startedAt),
          blobsMs: Math.round(clock() - indexAt),
        };
      } catch (error) {
        return {
          arrays: null,
          error,
          indexMs: Math.round(indexAt - startedAt),
          blobsMs: Math.round(clock() - indexAt),
        };
      }
    })();

    try {
      // On the promoted path the catalog is ALREADY HERE: the same `vegetation-manifest.json` that
      // carried the 8,805 placements carries the 31 families and their 58 bindings, under the same
      // field names `pack-index.json` uses, so `normalizeCustomsAuthoredVegetationCatalog()` below
      // applies the identical strictness with no adapter and the mount spends zero requests on it.
      // (Measured on the dev route: 1,003 ms for a 1.85 MB pack index that the promoted package
      // does not need to fetch at all.)
      const packIndex = promotedVegetation
        ? promotedVegetationPackage.catalogSource
        : await fetchLocalVegetationJson(
          `${CUSTOMS_AUTHORED_VEGETATION_ROUTE}pack-index.json`,
          { signal: mountAbort.signal },
        );
      stamp('packIndexMs');
      const catalog = normalizeCustomsAuthoredVegetationCatalog(packIndex);
      // Founder decision: admit ALL 31 authored families, not a subset. The router still runs —
      // it is what proves the two halves are complementary and total, and it is the seam a
      // partial pack would flow through unchanged.
      const route = routeCustomsAuthoredVegetationRollout({
        plan: exactVegetationPlan,
        catalog,
        admittedAssetIds: catalog.assets.map((entry) => entry.assetId),
      });
      const totals = assertCustomsAuthoredVegetationRouteTotals(route);
      if (totals.authored === 0) throw new Error('authored vegetation admitted no placements');
      // Every admitted family is resident at all three LODs from the first build, so this is the
      // exact number of GLBs the runtime will request — the denominator of the progress count.
      progress.expected = route.authored.assetIds.reduce(
        (sum, assetId) => sum + (catalog.assetsById[assetId]?.lods?.length ?? 0),
        0,
      );
      stamp('routeMs');
      progress.step = 'texture-arrays';

      // Everything above ran WITH the array task, not before it, so this is only the part of the
      // array load that the pack index did not already cover.
      const arrayResult = await arrayTask;
      stamp('arrayWaitMs');
      timings.arrayIndexMs = arrayResult.indexMs;
      timings.arrayBlobsMs = arrayResult.blobsMs;
      arrays = arrayResult.arrays;
      if (arrays) {
        vegetationStatus.arrayTextures = { ...arrays.stats };
        vegetationStatus.arrayTextureError = null;
        vegetationStatus.arrayTextureFailure = null;
      } else {
        const error = arrayResult.error;
        const reason = error?.code ?? error?.name ?? 'unavailable';
        // WHICH url failed, not which url the sequence started at. Nine blobs hang off this index
        // and any one of them can be the failure; naming veg-layers.json for a dead
        // `veg-l1-normal.bin` sends the reader to a file that is provably fine. The loader
        // annotates its errors with the blob it was fetching (`error.url`/`error.file`), so an
        // absent `error.url` is exactly "the index itself never arrived".
        const failedUrl = typeof error?.url === 'string' && error.url ? error.url : arrayIndexUrl;
        vegetationStatus.arrayTextureError = reason;
        vegetationStatus.arrayTextureFailure = {
          url: failedUrl,
          indexUrl: arrayIndexUrl,
          stage: failedUrl === arrayIndexUrl ? 'index' : 'blob',
          file: typeof error?.file === 'string' ? error.file : null,
          lod: Number.isInteger(error?.lod) ? error.lod : null,
          slot: typeof error?.slot === 'string' ? error.slot : null,
          route: CUSTOMS_VEGETATION_ARRAY_ROUTE,
          reason,
          message: String(error?.message ?? error),
          consequence:
            'materialMode falls back to authored-per-primitive; the 199 -> 3 material collapse did not run',
        };
        console.warn(
          `[three-poc] vegetation texture arrays did NOT load from ${failedUrl} (${reason}).`
          + ' The authored pack is drawing with its own per-primitive materials, so the draw-call'
          + ' count is the 199-material ceiling, not the 93-bucket floor.',
          error,
        );
      }

      // Explicit rather than inherited from the last `stamp()`: the array phase has a catch that
      // can leave `phaseAt` pointing at whichever sub-step threw, and a GLB span measured from
      // there would silently bill the arrays' failure to the loader.
      phaseAt = clock();
      let lastGlbDoneAt = null;
      progress.step = 'assets';

      /**
       * Hand the GLTF parser bytes with no images in them when the array material is live.
       *
       * The pack's own 597 PNGs are never sampled once the shared `DataArrayTexture` material is
       * built — the runtime releases the whole decoded value straight after the merge — so
       * decoding them is pure cost, and the measured cost was the mount: 3,781 ms of summed parse
       * against 49 ms of SHA-256 and 64 ms of merge.
       *
       * The strip runs INSIDE `parse`, i.e. after `loadVerifiedCustomsGlb` has already bound the
       * receipt to the bytes that arrived, so the integrity check is untouched. When it refuses
       * (a pack shape it has not proved safe), the original bytes are parsed instead: the mount
       * gets slower and stays exactly as correct. That is reported once, not per file, and lands
       * beside the other degradations.
       */
      const parseAuthoredGlb = (gltf) => (bytes, gltfBaseUrl) => {
        if (!arrays) return gltf.parseAsync(bytes, gltfBaseUrl);
        let prepared = null;
        try {
          prepared = stripCustomsVegetationGlbImages(bytes);
        } catch (error) {
          if (!glbImageStripFailure) {
            glbImageStripFailure = String(error?.message ?? error);
            console.warn(
              '[three-poc] vegetation GLBs are being parsed WITH their embedded images because the'
              + ` image strip refused them (${glbImageStripFailure}). Every one of those images is`
              + ' decoded and then discarded by the array material, so the mount pays the full'
              + ' GLTF decode for nothing. Correctness is unaffected.',
              error,
            );
          }
          return gltf.parseAsync(bytes, gltfBaseUrl);
        }
        glbImagesSkipped += prepared.images;
        return gltf.parseAsync(prepared.bytes, gltfBaseUrl);
      };
      runtime = await createCustomsAuthoredVegetationRuntime({
        plan: route.authored,
        catalog,
        baseUrl: vegetationRoutes.pack,
        cameraWorldPosition: camera.position.toArray(),
        frustum: cameraFrustumForVegetation(),
        textureArrays: arrays,
        signal: mountAbort.signal,
        loadGlb: async (url, { request, signal: requestSignal }) => {
          progress.requested += 1;
          const { gltf } = await authoredLoaderHost.acquire();
          const value = await loadVerifiedCustomsGlb({
            url,
            request,
            signal: requestSignal,
            parse: parseAuthoredGlb(gltf),
            onTiming: (row) => {
              timings.glbFetchMs += row.fetchMs;
              timings.glbHashMs += row.hashMs;
              timings.glbParseMs += row.parseMs;
              timings.glbBytes += row.bytes;
            },
          });
          // The only progress signal that exists: one verified, decoded GLB. Counted AFTER the
          // parse, so a loader that opens 93 requests and finishes none reads as zero progress
          // rather than as a mount that is nearly done.
          progress.loaded += 1;
          progress.lastProgressMs = performance.now();
          lastGlbDoneAt = progress.lastProgressMs;
          return value;
        },
      });
      // The runtime resolves only after it has merged and seated everything, so the span past the
      // last decoded GLB is exactly the CPU assembly: primitive slicing, layer binding,
      // mergeGeometries, 8,805 instance matrices and the first partition.
      const runtimeReadyAt = clock();
      progress.glbImagesSkipped = glbImagesSkipped;
      progress.glbImageStripFailure = glbImageStripFailure;
      timings.glbWallMs = Math.round((lastGlbDoneAt ?? runtimeReadyAt) - phaseAt);
      timings.assembleMs = Math.round(runtimeReadyAt - (lastGlbDoneAt ?? runtimeReadyAt));
      timings.glbFetchMs = Math.round(timings.glbFetchMs);
      timings.glbHashMs = Math.round(timings.glbHashMs);
      timings.glbParseMs = Math.round(timings.glbParseMs);
      phaseAt = runtimeReadyAt;

      /*
       * THE GATE AND THE MESHES MUST DESCRIBE THE SAME POLICY.
       *
       * `AUTHORED_VEGETATION_CASTS_SHADOWS` is the MODULE DEFAULT;
       * `createCustomsAuthoredVegetationRuntime()` accepts a `shadowPolicy` override that the
       * renderer's repack gate would never see. If the two ever diverge, lod-0 buckets become
       * casters whose `count` and `visible` change on every 4 m repack while the gate stays false —
       * a per-camera stale shadow with a source comment asserting it cannot happen. So the effective
       * policy is read off the constructed runtime and the repack gate is driven by THAT, with the
       * disagreement made loud rather than left silent.
       */
      const effectiveVegetationShadowMode = runtime.status.shadowPolicy?.mode ?? null;
      if (effectiveVegetationShadowMode === null) {
        throw new Error('the authored vegetation runtime published no shadowPolicy.mode; the repack'
          + ' shadow gate has nothing to read and would silently default to "does not cast"');
      }
      authoredVegetationCastsShadows = effectiveVegetationShadowMode !== 'disabled';
      if (authoredVegetationCastsShadows !== AUTHORED_VEGETATION_CASTS_SHADOWS) {
        console.warn(`[three-poc] the authored vegetation runtime's shadow policy is`
          + ` "${effectiveVegetationShadowMode}", not the module default`
          + ` "${CUSTOMS_AUTHORED_VEGETATION_SHADOW_POLICY.mode}". The repack invalidation follows the`
          + ' RUNTIME, which is the one the meshes were built from.');
      }
      // Single swap. Everything above this line is reversible by doing nothing.
      authoredVegetationRuntime = runtime;
      authoredVegetationArrays = arrays;
      vegetationRoot.add(runtime.group);
      rebuildProceduralVegetation(route.procedural);
      vegetationStatus.mode = 'authored';
      vegetationStatus.reason = null;
      vegetationStatus.totals = totals;
      // The partition inside `runtime` was cut against the camera as it stood when the load
      // STARTED — 60-85 s ago at the default pose, longer under contention — and this line used to
      // record the POST-load camera as the pose it had been packed for. That is the exact
      // falsehood the epsilon gate then believed: the first thing on screen after the swap was a
      // forest partitioned for a camera that had moved, and no repack was ever scheduled to fix
      // it. `vegetationPackedFor` stays null until a repack against the LIVE camera has run, and
      // this is that repack.
      progress.cameraMovedDuringLoadM = Math.hypot(
        camera.position.x - progress.cameraAtStart[0],
        camera.position.y - progress.cameraAtStart[1],
        camera.position.z - progress.cameraAtStart[2],
      );
      repackAuthoredVegetation('mount');
      applyNature();
      // Declared HERE as well as inside `rebuildProceduralVegetation`, because this line is the
      // swap: 93 authored buckets entered the scene and the procedural proxies left it in the same
      // synchronous block. Naming the moment separately is what makes the mount a searchable
      // invalidation rather than one that happens to be covered by a callee.
      sunShadow.invalidate('authored-vegetation-mount');
      invalidateRender(2);
      stamp('swapMs');
    } catch (error) {
      runtime?.dispose?.();
      arrays?.dispose?.();
      // The array task was started BEFORE the pack index was awaited, so a failure up there can
      // land while nine `DataArrayTexture`s are still being built behind it. `arrays` is null on
      // that path and disposing it releases nothing; the task's own result has to be collected and
      // released, or the mount leaks 20 MB of GPU textures every time the pack index 404s.
      arrayTask.then((result) => {
        if (result?.arrays && result.arrays !== arrays) result.arrays.dispose?.();
      }, () => {});
      vegetationStatus.mode = 'procedural';
      // A deadline that already fired owns the reason. The error that arrives here is the abort it
      // raised, and reporting `AbortError` over it would hide the diagnosis in the noise of every
      // other cancellation.
      vegetationStatus.reason = timeoutFailure?.reason
        ?? error?.code ?? error?.name ?? 'authored-vegetation-unavailable';
      vegetationStatus.error = String(error?.message ?? error);
      if (vegetationRequest === 'authored') {
        console.warn('[three-poc] authored vegetation was requested but did not load; procedural vegetation is retained', error);
      } else {
        console.info('[three-poc] authored vegetation unavailable; procedural vegetation is retained', error);
      }
    } finally {
      clearInterval(watchdog);
      authoredAbort.signal.removeEventListener('abort', propagateAbort);
      const settled = evaluateVegetationMount({
        nowMs: performance.now(),
        startedMs: progress.startedMs,
        lastProgressMs: progress.lastProgressMs,
        loaded: progress.loaded,
        expected: progress.expected,
        settled: true,
        ...vegetationMountDeadlines,
      });
      progress.elapsedMs = Math.round(settled.elapsedMs);
      progress.sinceProgressMs = Math.round(settled.sinceProgressMs);
      progress.fraction = settled.fraction;
      progress.timings.totalMs = progress.elapsedMs;
      progress.phase = timeoutFailure ? 'timed-out' : (vegetationStatus.mode === 'authored' ? 'mounted' : 'failed');
      // The phase the whole baseline hangs on. Every measurement ever recorded in this repo was
      // taken while this was still open — `.e2e/report.json` says `mount loading` beside its 1,397
      // draw calls — so it is in the waterfall and in the report header both.
      wfEnd('vegetationMount');
      // The mount has settled one way or the other — swapped in, failed, or timed out. This is the
      // transition a reviewer is watching for, and the one moment where a stale readout would
      // paint a verdict that is already wrong. Repaint now; the 400 ms timer is the floor.
      noteVegetationTransition();
    }
  }

  /** Retire the procedural proxies the authored pack has taken over, and only those. */
  function rebuildProceduralVegetation(nextPlan) {
    proceduralVegetationPlan = nextPlan;
    if (!treeGroup) return;
    for (const mesh of [...treeGroup.children]) {
      if (mesh.userData?.kind !== 'exact-local-vegetation') continue;
      mesh.removeFromParent();
      // The proxy geometries are created per batch here and owned by this group. The materials
      // are the shared `materials.*` set and must survive.
      mesh.geometry?.dispose?.();
      mesh.dispose?.();
    }
    treeGroup.userData = exactVegetationGroupUserData(nextPlan);
    addExactVegetationMeshes(nextPlan, treeGroup);
    applyProceduralSuppression();
    // THE BUG THIS WHOLE CHANGE IS ABOUT. `exact-pine-trunks`, both pine crown layers,
    // `exact-deciduous-trunks`, `exact-deciduous-crowns` and `exact-stumps` are `castShadow: true`,
    // and this function has just disposed every one of them and rebuilt a smaller set. A depth map
    // baked before this call draws the shadows of trees that no longer exist.
    sunShadow.invalidate('procedural-vegetation');
    invalidateRender();
  }

  /**
   * The plain-data view of the vegetation state that the observability collector reasons over.
   *
   * Assembled here and passed WHOLE, rather than letting the collector reach into closures: every
   * state it has to answer for — including the ones where the runtime is gone — is then a value in
   * one object that a test can construct by hand.
   */
  function vegetationObservabilitySnapshot(runtime) {
    return {
      mode: vegetationStatus.mode,
      request: vegetationStatus.request,
      reason: vegetationStatus.reason,
      error: vegetationStatus.error,
      disposed: vegetationStatus.disposed,
      hasAuthoredPlan: Boolean(exactVegetationPlan),
      // Whether local game-derived data was reachable at all. Since the vegetation promotion this
      // no longer decides whether an authored plan is EXPECTED — the promoted package supplies one
      // in production — it only decides WHICH loader was asked, and therefore which failure a
      // missing plan is. See `promoted-vegetation-missing`.
      localEnhancements: localEnhancementsAllowed,
      // ...and which ground and which forest it is looking at, so the release notice states the two
      // subsystems separately instead of describing the whole frame with one sentence.
      terrainDistribution: exactTerrainSource,
      vegetationDistribution: exactVegetationSource,
      mount: vegetationStatus.mount,
      routing: vegetationStatus.totals,
      runtime,
      arrayTextures: vegetationStatus.arrayTextures,
      arrayTextureFailure: vegetationStatus.arrayTextureFailure,
      // The exact plan's rendered count when there is one; otherwise the public tree positions
      // actually seated. Never a bare 0 while trees are on screen.
      proceduralPlacements: proceduralVegetationPlan?.renderedCount ?? publicTreePlacements,
      declaredInstances: exactVegetationPlan?.sourceCount ?? null,
      culledOutsideScope: exactVegetationPlan?.culledCount ?? null,
    };
  }

  function authoredVegetationRenderStats() {
    const runtime = authoredVegetationRuntime?.active ? authoredVegetationRuntime.status : null;
    const observability = describeVegetationObservability(vegetationObservabilitySnapshot(runtime));
    // Both proxy kinds: the exact-placement proxies (local path) and the public tree proxies
    // (release path). A filter that knew only the first reported 0 batches and 0 instances on a
    // frame drawing 2,348 public trees.
    const isProceduralProxy = (mesh) => mesh.userData?.kind === 'exact-local-vegetation'
      || mesh.userData?.kind === 'public-tree-proxy';
    const proceduralBatches = treeGroup ? treeGroup.children.filter(isProceduralProxy).length : 0;
    const proceduralInstances = treeGroup
      ? treeGroup.children.reduce((sum, mesh) => (isProceduralProxy(mesh) ? sum + (mesh.count ?? 0) : sum), 0)
      : 0;
    return {
      mode: vegetationStatus.mode,
      request: vegetationStatus.request,
      reason: vegetationStatus.reason,
      // Which package supplied the placements — `promoted-public`, `local-package`, or null — and
      // the two URLs this mount is actually reading. A frame that cannot name its own source is how
      // the truth strip came to claim 7,108 authored placements over a procedural forest.
      distribution: vegetationStatus.distribution,
      routes: { ...vegetationStatus.routes },
      // What the mount is doing right now, with a count and a clock: `loading` with 41/93 after
      // 38 s is a slow route, `loading` with 41/93 and 90 s since the last file is a wedged one,
      // and `timed-out` is the deadline having said so rather than a promise nobody can see.
      mount: vegetationStatus.mount && { ...vegetationStatus.mount },
      // The partition on screen is only correct for the camera it was cut against. This is that
      // camera, and the reason the last cut was made.
      packedFor: vegetationPackedFor && { position: [...vegetationPackedFor.position] },
      lastRepack: vegetationStatus.lastRepack && { ...vegetationStatus.lastRepack },
      source: {
        declaredInstances: exactVegetationPlan?.sourceCount ?? null,
        renderedInstances: exactVegetationPlan?.renderedCount ?? null,
        culledOutsideScope: exactVegetationPlan?.culledCount ?? null,
      },
      routing: vegetationStatus.totals,
      authored: runtime && {
        families: runtime.loadedAssets,
        buckets: runtime.instancedMeshes,
        bucketCeiling: runtime.bucketCeiling,
        liveBuckets: runtime.buckets,
        drawCalls: runtime.drawCalls,
        materialMode: runtime.materialMode,
        sharedMaterials: runtime.sharedMaterials,
        visibleInstances: runtime.visibleInstances,
        frustumCulledInstances: runtime.frustumCulledInstances,
        lodVisibleCounts: runtime.lodVisibleCounts,
        estimatedRenderedTriangles: runtime.estimatedRenderedTriangles,
        instanceBufferBytes: runtime.instanceBufferBytes,
        residentBytes: runtime.residentBytes,
        lastRepackMs: runtime.lastRepackMs,
        alphaModes: runtime.alphaContract.primitiveMaterialModes,
      },
      procedural: {
        batches: proceduralBatches,
        // Placements the procedural half owns, and the InstancedMesh instances it opens to draw
        // them. They are NOT the same number: a pine proxy is a trunk plus two crown cones, so
        // 8 batches carry ~1.6 instances per placement. Only `placements` belongs in the
        // conservation check below.
        // The SAME expression the observability snapshot feeds its accounting, not a second read
        // of the plan: this field said 0 on a release frame drawing 2,348 public trees while
        // `accountedPlacements` beside it said 2,348.
        placements: observability.accounting.parts.procedural,
        proxyInstances: proceduralInstances,
      },
      // The one number the whole hybrid rests on: nothing lost, nothing duplicated. Authored
      // (drawn + frustum-rejected) + procedural + out-of-scope === the declared source count.
      // NULL when the authored half cannot be read at all (a disposed view, or `mode: 'authored'`
      // with no runtime); `accounting.unavailable` says which. It used to be a bare four-term sum
      // with `?? 0` on each, so a disposed view published 1,697 — a wrong number wearing a right
      // number's clothes.
      accountedPlacements: observability.accountedPlacements,
      accounting: observability.accounting,
      arrayTextures: vegetationStatus.arrayTextures,
      arrayTextureError: vegetationStatus.arrayTextureError,
      arrayTextureFailure: vegetationStatus.arrayTextureFailure,
      // Degradations that are otherwise invisible in a healthy-looking status object. An empty
      // array is the assertion "the authored path is fully live"; anything in it is a defect with a
      // named cause and a stated cost, and it is the first thing `renderStats()` should be read
      // for. The enumeration and its wording live in `customs-vegetation-observability.js`.
      warnings: observability.warnings,
      degradations: observability.degradations,
      // The exact objects the two on-screen readouts are painted from — see
      // `updateTruthReadouts()`. `indicator` is the chip, `strip` is the CUSTOMS TRUTH strip's
      // vegetation segment, and both come from this one call. Exposed here so a console/e2e reader
      // can assert either readout agrees with `renderStats()` without scraping the DOM.
      indicator: observability.indicator,
      strip: observability.strip,
    };
  }

  /**
   * Paint BOTH on-screen vegetation readouts — the chip and the CUSTOMS TRUTH strip's vegetation
   * segment — from ONE `describeVegetationObservability()` call, the same call
   * `renderStats().vegetation.warnings` reads.
   *
   * One call, deliberately. The chip already could not disagree with `warnings` (see
   * customs-vegetation-observability.js `vegetationIndicatorFromDegradations`); the strip could, and
   * did — it read the render PLAN's `renderedCount` and told a reviewer "7,108 AUTHORED VEGETATION"
   * thirty pixels above a chip correctly reporting that the pack had failed to mount. Two readouts
   * fed by one `indicator` cannot fork; two readouts each fetching their own state always
   * eventually do.
   *
   * The terrain half of the strip is repainted here too, from `exactTerrainSurfaceStatus()` — the
   * same accessor `renderStats().exactTerrain.surface` publishes — because `look` and `fx.detail`
   * swap the terrain materials at runtime and a one-shot claim about them goes stale on the first
   * flip.
   *
   * Polled on its own timer rather than from `animate()` or the mount's watchdog: a 60-85 s mount
   * (>12 min after a camera move — see docs at the top of `mountAuthoredVegetation`) updates `mount`
   * fields without ever calling `invalidateRender()`, and these readouts own none of that timing
   * code — they only read what that code already publishes. The timer is a floor, not the only
   * trigger: every transition that moves `vegetationStatus` calls this directly (see
   * `noteVegetationTransition`), so the readouts are stale for a frame, not for up to 400 ms.
   */
  let vegetationChipHealthySinceMs = null;
  function updateTruthReadouts() {
    const runtime = authoredVegetationRuntime?.active ? authoredVegetationRuntime.status : null;
    const { indicator, strip } = describeVegetationObservability(vegetationObservabilitySnapshot(runtime));
    paintTruthStrip(customsTruthStripCopy({
      hasExactTerrain: Boolean(exactTerrainMesh),
      terrainDistribution: exactTerrainSource,
      surface: exactTerrainSurfaceStatus(),
      vegetation: strip,
      relief,
      localEnhancements: localEnhancementsAllowed,
      publicSurface: publicSurfaceKind(),
    }));
    vegetationChip.hidden = false;
    vegetationChip.dataset.state = indicator.state;
    vegetationChipHeadline.textContent = indicator.headline;
    vegetationChipDetail.textContent = indicator.detail ?? '';
    vegetationChipDetail.hidden = !indicator.detail;
    // "Say so plainly and then get out of the way": once healthy, the chip keeps its full,
    // unmissable size for a few seconds — long enough to register as a verdict, not a flicker — then
    // shrinks and dims rather than vanishing outright, because a truthful indicator that disappears
    // is indistinguishable from one that was never wired up. Any non-healthy tick resets the clock
    // immediately, so a mount that degrades mid-review is never left looking settled.
    if (indicator.healthy) {
      if (vegetationChipHealthySinceMs === null) vegetationChipHealthySinceMs = performance.now();
      vegetationChip.classList.toggle('settled', performance.now() - vegetationChipHealthySinceMs > 4000);
    } else {
      vegetationChipHealthySinceMs = null;
      vegetationChip.classList.remove('settled');
    }
  }
  // Arms the readouts. `applyLook()` runs before `vegetationStatus` is even constructed (the
  // initial world build is above), and painting from there would read a const in its temporal dead
  // zone; the flag makes "not paintable yet" an explicit state rather than a thrown error, and the
  // boot strip already says RESOLVING for both halves until this line.
  readoutsArmed = true;
  updateTruthReadouts();
  const vegetationChipInterval = setInterval(updateTruthReadouts, 400);

  const groundExtent = (() => {
    const xs = data.limit.map((p) => p[0]), zs = data.limit.map((p) => p[1]);
    return { width: Math.max(...xs) - Math.min(...xs), depth: Math.max(...zs) - Math.min(...zs) };
  })();
  let viewState = { target: [0, 0, 0], zoom: 0, rotationX: CAM.rotationX, rotationOrbit: CAM.rotationOrbit, minZoom: -2, maxZoom: 5 };
  const clampView = (next) => clampCamera(next, {
    ...groundExtent,
    viewportWidth: container.clientWidth || 1200,
    viewportHeight: container.clientHeight || 800,
    ground: (() => { try { return H(-(next.target?.[0] ?? 0), -(next.target?.[1] ?? 0)); } catch { return 0; } })(),
  });
  let suppressControlEvent = false;
  function distanceForZoom(zoom) {
    return (Math.max(1, container.clientHeight) / 2) / (Math.pow(2, zoom) * Math.tan((CAM.fovy * Math.PI) / 360));
  }
  function writeControlledPose(pose) {
    // OrbitControls emits `change` from update(). Keep that echo out of the user-input path while
    // writing the authoritative, clamped pose back to the real camera.
    suppressControlEvent = true;
    try {
      controls.target.fromArray(pose.target);
      camera.position.fromArray(pose.position);
      camera.up.set(0, 0, 1);
      camera.lookAt(controls.target);
      controls.update();
    } finally {
      suppressControlEvent = false;
    }
  }
  function applyView(next, notify = false) {
    viewState = clampView({ ...viewState, ...next });
    const pose = cameraPose(viewState, container.clientHeight || 800, CAM.fovy);
    controls.minDistance = distanceForZoom(viewState.maxZoom ?? 5);
    controls.maxDistance = distanceForZoom(viewState.minZoom ?? -2);
    writeControlledPose(pose);
    updateAuthoredAssetsForTarget();
    // The marker ladder is a function of the camera, so it is folded in HERE — before the frame is
    // invalidated — rather than waiting for main.js to call back. A zoom that crosses a tier
    // boundary must not be able to paint one frame at the old tier.
    noteCameraZoom(viewState.zoom);
    invalidateRender();
    if (notify) src.onViewChange?.({ ...viewState });
    return { ...viewState };
  }
  let controlNotify = 0;
  controls.addEventListener('change', () => {
    if (suppressControlEvent) return;
    const reconciled = reconcileOrbitView({
      position: camera.position.toArray(),
      target: controls.target.toArray(),
      previous: viewState,
      viewportHeight: container.clientHeight || 800,
      fovy: CAM.fovy,
      clamp: clampView,
    });
    viewState = reconciled.view;
    // A clamp is not merely bookkeeping. Reapply it synchronously, before queuing the permalink /
    // HUD / hidden-2D notification, so all four surfaces describe the camera on the canvas.
    if (reconciled.corrected) writeControlledPose(reconciled.pose);
    updateAuthoredAssetsForTarget();
    noteCameraZoom(viewState.zoom);
    invalidateRender();
    if (!controlNotify) controlNotify = requestAnimationFrame(() => {
      controlNotify = 0;
      src.onViewChange?.({ ...viewState });
    });
  });
  applyView(viewState);
  // Started after the camera is seated so the first partition uses the real orbit pose, and never
  // awaited: the map is fully interactive on procedural vegetation while the pack loads.
  void mountAuthoredVegetation();

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  renderer.domElement.addEventListener('pointermove', (event) => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    // `wallStructureGroup` joins the pick list for its GATES only: nothing else under it carries a
    // `userData.label`, and `visibleInteractionData` returns null without one, so hovering a fence
    // panel stays silent while a gate can say out loud that its placement was inferred.
    // Timed only when a profiler exists: this runs on EVERY pointermove, unthrottled, recursively
    // over five subtrees, so it is main-thread cost that never appears inside a rendered frame and
    // a per-frame average of it would be a category error. One branch when off.
    const raycastAt = frameProfiler ? performance.now() : 0;
    const interaction = raycaster.intersectObjects([buildingGroup, propGroup, wallStructureGroup, authoredRoot, dynamicRoot].filter(Boolean), true)
      .map((hit) => ({ hit, user: visibleInteractionData(hit.object) }))
      .find((candidate) => candidate.user);
    if (frameProfiler) frameProfiler.event('raycast', performance.now() - raycastAt);
    const user = interaction?.user;
    hoverChip.hidden = !user?.label;
    renderer.domElement.style.cursor = user?.label ? 'help' : '';
    if (user?.label) {
      hoverChip.textContent = `${user.label}${user.stableId ? ` · ${user.stableId}` : ''}${user.provisional ? ' · provisional' : ''}`;
      hoverChip.style.left = `${event.clientX - rect.left + 14}px`;
      hoverChip.style.top = `${event.clientY - rect.top + 14}px`;
    }
  });
  renderer.domElement.addEventListener('pointerleave', () => {
    hoverChip.hidden = true;
    renderer.domElement.style.cursor = '';
  });

  /**
   * The frame, exactly as it was before this file gained a profiler. Four calls, in order.
   *
   * `animate()` calls this OR `frameProfiler.renderProfiled()`, never both and never a mixture, so
   * the shipped path carries no timing statement at all. Kept as its own function purely so the two
   * arms of that branch can be read side by side and pinned by a source test.
   */
  function renderOneFrame() {
    controls.update();
    updateUnderstoryLod();
    updateOverlayPositions();
    renderer.render(scene, camera);
  }

  /* --------------------------------------------------------------- render profiler -- */

  /**
   * The instrument. Built only when `?profile=` asked for it; `null` otherwise, and the whole
   * on-path cost of it existing is the single `if (frameProfiler)` in `animate()`.
   *
   * WHAT IT FORCES, AND WHY THAT IS THE POINT. This app renders on demand — `animate()` returns
   * early unless something invalidated the frame — so `fps` measures how often the app CHOSE to
   * submit, not how long a frame takes. A run therefore holds `renderRequested` true for its
   * duration and renders continuously. The numbers it produces are the COST OF A FRAME. They are
   * deliberately not a statement about the app's idle behaviour, and the report says so.
   */
  function createRenderProfiler() {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    /** How long one GPU timestamp resolve may hang before the channel is declared unusable. */
    const GPU_RESOLVE_STALL_MS = 3000;
    let running = false;
    let collector = null;
    let overlayVariant = 'interleaved';
    let overlayProbe = null;
    let busyMs = 0;
    let pendingFrames = null;

    // GPU timing. three resolves its timestamp pool asynchronously and, on a disjoint or an
    // in-flight resolve, RETURNS THE PREVIOUS VALUE rather than nothing (WebGLTimestampQueryPool.js
    // :187-190, :329-334). That is the failure shape handoff §7 is about, so every resolve is
    // counted, every accepted sample is compared with the one before it, and both counts ship in
    // the report beside the milliseconds. `renderer.hasFeature('timestamp-query')` is three's own
    // mapping of `EXT_disjoint_timer_query_webgl2` on the WebGL2 backend and of
    // `GPUFeatureName.TimestampQuery` on WebGPU (webgl-fallback/utils/WebGLConstants.js:10).
    const gpu = {
      requested: profileRequest.armed,
      supported: false,
      method: null,
      reason: null,
      inFlight: false,
      resolveStartedAt: null,
      resolveCalls: 0,
      lastValue: null,
      adjacentDuplicates: 0,
    };
    try {
      gpu.supported = profileRequest.armed && renderer.hasFeature?.('timestamp-query') === true;
      if (gpu.supported) {
        gpu.method = status.backend === 'webgpu'
          ? 'three TimestampQueryPool → WebGPU GPUFeatureName.TimestampQuery'
          : 'three TimestampQueryPool → EXT_disjoint_timer_query_webgl2';
      } else {
        gpu.reason = profileRequest.armed
          ? `the ${status.backend} backend does not expose a timestamp query on this machine`
          : 'profiling was not armed at renderer construction';
      }
    } catch (error) {
      gpu.supported = false;
      gpu.reason = `timestamp-query feature check threw: ${String(error?.message ?? error)}`;
    }
    // What the feature check said at boot, kept separately from `gpu.supported`, which the stall
    // guard can flip to false mid-run.
    gpu.supportedAtBoot = gpu.supported;
    /*
     * Independently: is the backend's own extension handle there? Recorded, never substituted —
     * a `true` here with `supported: false` would say three declined a timer the browser has.
     *
     * `null` on WebGPU, and that is the whole point of the ternary. `renderer.backend.disjoint` is
     * a WebGLBackend field (`WebGLBackend.js:160`); the WebGPU backend has no such property, so
     * `Boolean(undefined)` reported a confident `false` — "the disjoint extension is not present" —
     * about a backend where the extension is not a thing that could be present. That is an
     * assertion, not a measurement, in a field a reader would use to explain a missing timer.
     */
    const disjointExtensionPresent = status.backend === 'webgpu'
      ? null
      : Boolean(renderer.backend?.disjoint);

    const measure = (name, start, end) => {
      try { performance.measure(`tz:${name}`, { start, end }); } catch { /* buffer full or unsupported */ }
    };
    const busy = (ms) => { const until = performance.now() + ms; while (performance.now() < until) { /* deliberate */ } };

    /**
     * One profiled frame: the same four calls `renderOneFrame()` makes, in the same order, with a
     * `performance.now()` on each side and a `performance.measure()` so a DevTools trace taken at
     * the same time is annotated with the same phases this report names.
     */
    function renderProfiled() {
      const t0 = performance.now();
      controls.update();
      const t1 = performance.now();
      updateUnderstoryLod();
      const t2 = performance.now();
      if (overlayVariant === 'batched') updateOverlayPositionsBatched();
      else updateOverlayPositions();
      // The self-test injection point. Declared cost, in the overlay pass, recorded in the report.
      if (busyMs) busy(busyMs);
      const t3 = performance.now();
      renderer.render(scene, camera);
      const t4 = performance.now();

      measure('frame', t0, t4);
      measure('controls', t0, t1);
      measure('lod', t1, t2);
      measure('overlay', t2, t3);
      measure('render', t3, t4);

      if (overlayProbe) overlayProbe[overlayVariant].push(t3 - t2);

      if (collector) {
        collector.ledger.beginFrame();
        collector.ledger.record('controls', t1 - t0);
        collector.ledger.record('lod', t2 - t1);
        collector.ledger.record('overlay', t3 - t2);
        collector.ledger.record('render', t4 - t3);
        collector.ledger.endFrame(t4 - t0);
        const heap = performance.memory?.usedJSHeapSize;
        if (heap !== undefined) collector.heap.push(heap);
      }

      /*
       * Resolve GPU timestamps ONLY inside a sampling window, and only one at a time.
       *
       * three's WebGL pool resolves by polling `QUERY_RESULT_AVAILABLE` on a 1 ms `setTimeout`
       * (WebGLTimestampQueryPool.js:318-322). Firing one of those on every frame from page load —
       * through a 60-85 s vegetation mount — floods the timer queue with pending polls on any
       * backend whose queries do not complete promptly, and starves the very rAF loop being
       * measured. Samples are only wanted from the measured window anyway.
       *
       * The stall guard is the other half: a backend that never completes a resolve gets the GPU
       * channel switched OFF with a stated reason, rather than being allowed to hold `inFlight`
       * forever and silently produce a run with zero GPU samples and no explanation.
       */
      if (collector && gpu.supported && !gpu.inFlight) {
        gpu.inFlight = true;
        gpu.resolveStartedAt = t4;
        gpu.resolveCalls += 1;
        renderer.resolveTimestampsAsync('render').then((ms) => {
          gpu.inFlight = false;
          if (!Number.isFinite(ms)) return;
          if (gpu.lastValue !== null && ms === gpu.lastValue) gpu.adjacentDuplicates += 1;
          gpu.lastValue = ms;
          if (collector) collector.gpu.push(ms);
        }, () => { gpu.inFlight = false; });
      } else if (gpu.inFlight && gpu.resolveStartedAt !== null && t4 - gpu.resolveStartedAt > GPU_RESOLVE_STALL_MS) {
        gpu.supported = false;
        gpu.reason = `the ${status.backend} backend did not complete a timestamp resolve within ${GPU_RESOLVE_STALL_MS} ms; the GPU channel was switched off mid-run rather than left to report nothing without saying why`;
      }

      if (pendingFrames) {
        pendingFrames.seen += 1;
        if (pendingFrames.seen >= pendingFrames.need) { const done = pendingFrames.resolve; pendingFrames = null; done(); }
        else pendingFrames.bump();
      }
      // Hold the render-on-demand gate open for the duration of the run. Restored by `stop()`.
      if (running) renderRequested = true;
    }

    /*
     * Wait for N RENDERED frames — with a deadline, because the founder gets one shot at this.
     *
     * `animate()` stops doing anything at all when the tab is hidden or when the 2D map takes the
     * viewport, and a run that hit either would otherwise wait forever with the button greyed out
     * and no explanation. A rejection that names the cause is the difference between "the profiler
     * is broken" and "come back to the tab".
     *
     * It watches the GAP BETWEEN frames, not the total, and the gap timer is reset by every frame
     * that arrives. A total-time budget would have been a budget on frame time — a false alarm
     * against the one thing this instrument exists to measure, and one that fires on exactly the
     * slow hardware a baseline is most worth taking on. Headless Chromium on SwiftShader renders
     * this scene at ~6 s a frame and must not trip it; a tab that stopped rendering must.
     */
    const framesElapsed = (need, stallMs = 25_000) => (need <= 0
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
        const record = { need, seen: 0, resolve: null, bump: null };
        let timer = 0;
        const fail = () => {
          if (pendingFrames === record) pendingFrames = null;
          reject(new Error(`no frame rendered for ${stallMs} ms (${record.seen}/${need} done); the 3D view must stay visible and in front for the whole run`));
        };
        const arm = () => { clearTimeout(timer); timer = setTimeout(fail, stallMs); };
        record.bump = arm;
        record.resolve = () => { clearTimeout(timer); resolve(); };
        arm();
        pendingFrames = record;
      }));

    function event(name, ms) { collector?.events.record(name, ms); }

    /* ---------------------------------------------------------------- the ablations -- */

    /**
     * Switch a named piece of the frame OFF for the duration of a run, and be able to prove it
     * stayed off.
     *
     * The reasoning for the three targets and for the two classes they fall into is in
     * `src/render-profiler.js` beside `ABLATION_TARGETS`. This is the half that touches the scene.
     *
     * WHAT IT REFUSES TO ASSUME. A group that does not exist in this build is recorded as
     * `found: false` and NOTHING IS ABLATED — never as a silent success, which would produce a run
     * that reads as "props cost nothing". And `applyNature()` writes `rockGroup.visible` from the
     * nature toggles; if it fired mid-run it would quietly restore what this switched off, so every
     * target is re-checked at the end of every preset and the answers ship in the report. A run
     * whose ablation did not hold gets a note saying so at the top, because its numbers describe
     * neither arm.
     *
     * The shadow target needs one frame of arming. `ShadowNode.updateBefore()` re-renders the depth
     * map whenever `needsUpdate || autoUpdate` (three 0.185.1, `ShadowNode.js:855`), so the sequence
     * is: force one update, let one frame render it, then clear BOTH flags. From then on the
     * lighting samples a depth texture nothing rewrites. The shadow camera is a fixed ortho frustum
     * aimed at the map centre and does not follow the view, so one render is valid at every preset.
     *
     * SINCE 2026-09-03 `autoUpdate` IS ALREADY FALSE on a default load — the freeze shipped
     * (docs/PROFILING.md §3c). This target therefore removes nothing on a default load and the A/B
     * will say it attributes nothing, correctly. `?shadows=live` is the arm on which it still has
     * something to take away, and it is how the probe is re-proved after that change. The one thing
     * this must NOT do is undo the shipped state on restore, which is why the restorer replays
     * `before.autoUpdate` rather than assuming `true`.
     */
    function applyAblation(ablation) {
      const restorers = [];
      const applied = [];
      const checks = [];
      for (const target of ablation?.targets ?? []) {
        if (target === 'shadow') {
          const wasAlreadyFrozen = sunShadow.live === false;
          const before = { autoUpdate: sun.shadow.autoUpdate };
          const bakesAtArm = sunShadow.sequence;
          restorers.push(() => { sunShadow.setLive(before.autoUpdate); sunShadow.invalidate('profiler-ablation'); });
          applied.push({
            target,
            // A NULL EXPERIMENT IS NOT AN APPLIED ONE. Since the freeze shipped, `autoUpdate` is
            // already false on a default load: arm A and arm B are then both frozen, the A/B
            // compares frozen with frozen, and the report would say "attributed 0.0 ms" for a run in
            // which nothing was ablated. `runSeries` refuses on this flag; it is recorded here as
            // well so a report that somehow gets written still carries the reason.
            found: !wasAlreadyFrozen,
            wasAlreadyFrozen,
            note: wasAlreadyFrozen
              ? 'sun.shadow.autoUpdate was ALREADY false (the freeze is the shipped default) — NOTHING WAS ABLATED'
                + ' and this run compares frozen with frozen. Reload with ?shadows=live&profileAblate=shadow.'
              : 'sun.shadow.autoUpdate was true; the depth map is rendered once more, then frozen',
          });
          // A FLAG CANNOT DETECT THE EVENT. `autoUpdate === false` is true in both arms on a frozen
          // build, so the old check passed while the comparison was vacuous; and on a live build a
          // real invalidation firing mid-run silently re-bakes the "frozen" arm with the check still
          // green. `sequence` is a counter, and a counter cannot be missed by a slow sampler — the
          // same reasoning `createShadowCasterAudit` is built on.
          checks.push(() => {
            const bakesDuringRun = sunShadow.sequence - bakesAtArm;
            return {
              target,
              held: sun.shadow.autoUpdate === false && bakesDuringRun === 0 && !wasAlreadyFrozen,
              autoUpdate: sun.shadow.autoUpdate,
              bakesDuringRun,
              wasAlreadyFrozen,
              note: wasAlreadyFrozen
                ? 'never applied — the depth map was already frozen before this run'
                : (bakesDuringRun > 0
                  ? `${bakesDuringRun} invalidation(s) re-baked the map inside the run; the arm was not frozen throughout`
                  : undefined),
            };
          });
          continue;
        }
        const group = target === 'props' ? propGroup : (target === 'rocks' ? rockGroup : null);
        if (!group) {
          // Stated, not swallowed. A missing group is the one way this could report "free".
          applied.push({ target, found: false, note: `no ${target} group exists in this build — NOTHING WAS ABLATED for this target and its cost is NOT what this run measured` });
          checks.push(() => ({ target, held: false, note: 'never applied' }));
          continue;
        }
        const before = group.visible;
        group.visible = false;
        /*
         * BOTH EDGES INVALIDATE. `propGroup` and `rockGroup` are caster groups (`mesh.castShadow =
         * mesh.receiveShadow = true` where they are built), and since the freeze shipped the depth
         * map does not re-render on its own. Without these two calls `?profileAblate=props` on a
         * default load draws prop shadows on ground with no props — the literal stale-shadow
         * signature, manufactured by the instrument built to measure the freeze — and the restored
         * arm then draws props against a depth map baked while they were hidden. It is also
         * reachable in production: `?profile=1` is deliberately not behind
         * `canShowDiagnosticReadouts()` (evening handoff §5.5).
         */
        sunShadow.invalidate('profiler-ablation');
        restorers.push(() => {
          group.visible = before;
          sunShadow.invalidate('profiler-ablation');
          invalidateRender();
        });
        applied.push({ target, found: true, note: `${group.name}.visible set false (was ${before}); the depth map is invalidated on both edges` });
        checks.push(() => ({ target, held: group.visible === false }));
      }
      return {
        applied: Object.freeze(applied.map(Object.freeze)),
        verify: () => checks.map((check) => check()),
        restore: () => { for (const restore of restorers) restore(); },
      };
    }

    /**
     * The one frame of arming the shadow target needs. Separated so `applyAblation` stays sync.
     *
     * IT GOES THROUGH THE CONTROLLER, and the settle is conditional. Writing
     * `sun.shadow.needsUpdate = false` here unconditionally discards any invalidation the app
     * declared inside the awaited frame — and the discard is silent AND self-certifying: the audit
     * sees `controller.sequence` has moved, re-baselines, and files the post-mutation fingerprint as
     * `baked`. `settle()` refuses when the sequence moved, so a bake the app asked for survives the
     * instrument that was measuring it. The window is the one that matters: the authored-vegetation
     * swap lands 60-85 s in, and a profiler run is longer than that.
     */
    async function armAblation(ablation) {
      const state = applyAblation(ablation);
      if (ablation?.targets?.includes('shadow')) {
        sunShadow.setLive(true);
        sunShadow.invalidate('profiler-ablation');
        const atSequence = sunShadow.sequence;
        await framesElapsed(1);
        sunShadow.setLive(false);
        if (!sunShadow.settle(atSequence)) {
          // Not a failure — the app legitimately wants another bake. Say so rather than dropping it.
          console.warn('[three-poc] a shadow invalidation landed while the ablation was arming;'
            + ' the bake it asked for was KEPT and this arm starts one frame later than planned');
        }
      }
      return state;
    }

    /**
     * TWO QUESTIONS, TWO NAMED VERDICTS — and one rAF tick per arm.
     *
     * This is the probe that returned the founder's `identical` **true, false, true, false**, and
     * that result was an artefact of the probe, not a reading of the scene. Two independent defects,
     * both fixed here, and both worth writing down because they are the same shape as everything
     * else in handoff §7 — an instrument reporting a verdict having measured something other than
     * what its labels say.
     *
     *  1. THE ARM CALLED `live` WAS NOT LIVE. It was captured with whatever `sun.shadow.autoUpdate`
     *     the page happened to have, and since the freeze shipped that is `false`. So the comparison
     *     was never live-vs-frozen: it was "the depth map that happens to be resident right now"
     *     against "a map baked two renders ago". Under those labels `identical === false` reads as
     *     "the optimisation is unsound", when what it actually detected is THE RESIDENT MAP WAS
     *     STALE AT THAT MOMENT — the P1 defect signal, correctly seen and wrongly named.
     *
     *  2. EVERY ARM SHARED ONE `nodeFrame.frameId`. All five renders ran in one synchronous task,
     *     and `ShadowNode.updateBefore()` (three 0.185.1, ShadowNode.js:859-866) forces
     *     `needsUpdate = false` whenever it has already handled this camera on this frame id — which
     *     three advances only from its own `Animation` loop, once per rAF tick. So which arms could
     *     bake at all depended on whether `animate()` had rendered in the same tick: nondeterministic,
     *     and enough on its own to alternate a verdict across repeated runs.
     *
     * So each arm now gets its own tick via `framesElapsed(1)`, the live arm is FORCED rather than
     * inherited, and the two questions are reported separately under names that say which is which:
     *
     *   `residentMapWasCurrent`  the frame the page was already showing vs a fresh bake of the same
     *                            pose. FALSE MEANS A STALE SHADOW WAS ON SCREEN. This is the P1
     *                            defect check and it is meaningful on the shipped default load.
     *   `freezeIsPixelFree`      three's per-frame shadow vs the frozen map. This is the original
     *                            hypothesis, and it only means anything on `?shadows=live`, where
     *                            there is a real live arm to compare against.
     *
     * TWO CONTROLS, BOTH FIRST, both able to void the run:
     *   - NULL — two consecutive renders with nothing changed at all must hash EQUAL. If they do
     *     not, the scene is not static (a streaming attach, an LOD repack) and every difference
     *     below is unattributable. This is the control the old probe lacked, and its absence is the
     *     most likely mechanical cause of an intermittent `false`.
     *   - READBACK — a camera nudge must hash DIFFERENTLY, or `toDataURL` is returning something
     *     constant and an "identical" here would prove nothing.
     */
    async function shadowPixelCheck() {
      const canvas = renderer.domElement;
      const hash = (text) => {
        if (typeof text !== 'string' || text.length < 64) return null;
        let h = 0x811c9dc5;
        for (let i = 0; i < text.length; i += 1) {
          h ^= text.charCodeAt(i);
          h = Math.imul(h, 0x01000193) >>> 0;
        }
        return `${h.toString(16).padStart(8, '0')}:${text.length}`;
      };
      /*
       * One arm = one rAF tick.
       *
       * three advances `nodeFrame.frameId` only from its own `Animation` loop (once per rAF), and
       * `ShadowNode.updateBefore()` refuses to bake twice for one camera on one frame id. So a tick
       * boundary is what makes an arm's shadow state real rather than inherited — which is defect
       * (2) above, and it is why every arm awaits.
       *
       * `invalidateRender()` first because this app renders ON DEMAND: with no run in flight
       * `animate()` returns early, no frame is produced, and `framesElapsed` would sit until its
       * 25 s stall deadline and reject. The awaited frame is the app's own profiled frame — the one
       * that consumes `needsUpdate` and bakes; the `render()` below re-reads that same map into the
       * canvas for the hash (the frame-id guard means it cannot bake a second time).
       */
      const snap = async () => {
        invalidateRender();
        await framesElapsed(1);
        renderer.render(scene, camera);
        try { return hash(canvas.toDataURL('image/png')); } catch { return null; }
      };
      // Read through the controller as well as written through it: `sunShadow.live` and
      // `sun.shadow.autoUpdate` are the same bit, and having ONE name for it is what stops a report
      // describing a state the controller did not choose.
      const wasLive = sunShadow.live;
      const entryMode = wasLive ? 'live' : 'frozen';
      const method = 'canvas.toDataURL("image/png") hashed FNV-1a 32 + byte length, one requestAnimationFrame tick per arm; equal hashes are a whole-canvas pixel equality';
      try {
        controls.update();

        // ── CONTROL 1 (null): nothing changes between these two.
        const still1 = await snap();
        const still2 = await snap();

        // ── CONTROL 2 (readback): a nudge must move the hash.
        const held = camera.position.clone();
        camera.position.x += 0.35;
        camera.updateMatrixWorld(true);
        const nudged = await snap();
        camera.position.copy(held);
        camera.updateMatrixWorld(true);

        // ── ARM: the map the page was already showing, re-rendered with no invalidation.
        const atEntry = await snap();

        // ── ARM: a FORCED live frame. `setLive(true)` plus a declared invalidation, then a whole
        //    tick, so three really does re-render the depth map before this is read.
        sunShadow.setLive(true);
        sunShadow.invalidate('profiler-ablation');
        const liveFrame = await snap();

        // ── ARM: frozen against that fresh bake.
        sunShadow.setLive(false);
        const freshBake = await snap();

        const readback = [still1, still2, nudged, atEntry, liveFrame, freshBake].every((h) => h !== null);
        if (!readback) {
          return Object.freeze({
            ok: false, method, entryMode,
            reason: 'the canvas could not be read back (toDataURL returned nothing usable on this backend); nothing was compared',
            hashes: { still1, still2, nudged, atEntry, liveFrame, freshBake },
          });
        }
        const controls_ = Object.freeze({
          sceneIsStatic: still1 === still2,
          readbackDiscriminates: nudged !== still1,
          note: 'sceneIsStatic: two renders with NOTHING changed must hash equal, or the scene is mutating'
            + ' under the probe and no difference below is attributable to the shadow policy.'
            + ' readbackDiscriminates: a 0.35-unit camera nudge must hash differently, or the readback'
            + ' cannot see a changed frame and an "identical" would prove nothing.',
        });
        const ok = controls_.sceneIsStatic && controls_.readbackDiscriminates;
        const residentMapWasCurrent = ok ? (atEntry === freshBake) : null;
        const freezeIsPixelFree = ok ? (liveFrame === freshBake) : null;
        return Object.freeze({
          ok,
          method,
          entryMode,
          control: controls_,
          hashes: Object.freeze({ still1, still2, nudged, atEntry, liveFrame, freshBake }),
          residentMapWasCurrent,
          freezeIsPixelFree,
          verdict: !ok
            ? (controls_.sceneIsStatic
              ? 'VOID — the canvas readback did not change when the camera moved, so nothing here is a measurement'
              : 'VOID — two renders with nothing changed hashed DIFFERENTLY: the scene is mutating under the probe'
                + ' (a streaming attach or an LOD repack), so no difference below can be attributed to the shadow')
            : `${residentMapWasCurrent
              ? 'the depth map resident on entry was CURRENT — the frame on screen was not stale'
              : 'THE DEPTH MAP RESIDENT ON ENTRY WAS STALE — the frame on screen differed from a fresh bake of the same pose'
              }; ${freezeIsPixelFree
                ? 'and a frozen map is pixel-identical to a live one at this pose'
                : 'and a frozen map DIFFERS from a live one at this pose'}`,
          caveat: entryMode === 'frozen'
            ? 'On a default (frozen) load `residentMapWasCurrent` is the P1 check and `freezeIsPixelFree` compares'
              + ' a forced live frame against the bake that immediately follows it — a weaker control arm than'
              + ' `?shadows=live` gives. One pose, one moment, either way.'
            : 'On ?shadows=live both verdicts are meaningful, but this is still one pose at one moment.',
        });
      } finally {
        sunShadow.setLive(wasLive);
        sunShadow.invalidate('profiler-ablation');
        invalidateRender();
      }
    }

    /* ------------------------------------------------------------ what was measured -- */

    /**
     * The GPU string, from whichever source this backend has.
     *
     * On the WebGL2 backend `WEBGL_debug_renderer_info` is on the live context. On WebGPU there is
     * no WebGL context to ask, so a throwaway 1x1 WebGL2 context is created purely to read the same
     * two strings — it names the same adapter and costs one context that is immediately lost. The
     * WebGPU adapter's own `info` is recorded beside it when it is reachable, never instead of it.
     */
    function describeGpu() {
      const out = { gpuVendor: null, gpuRenderer: null, gpuSource: null, adapterInfo: null };
      const readFrom = (gl, source) => {
        if (!gl || out.gpuRenderer) return;
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        if (!ext) return;
        out.gpuVendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) ?? null;
        out.gpuRenderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? null;
        out.gpuSource = source;
      };
      try { readFrom(renderer.backend?.gl, 'live WebGL2 context'); } catch { /* not a WebGL backend */ }
      if (!out.gpuRenderer) {
        try {
          const probe = document.createElement('canvas');
          readFrom(probe.getContext('webgl2') ?? probe.getContext('webgl'), 'throwaway WebGL2 probe context');
        } catch { /* no WebGL at all */ }
      }
      try {
        const info = renderer.backend?.adapter?.info ?? renderer.backend?.device?.adapterInfo ?? null;
        if (info) out.adapterInfo = { vendor: info.vendor ?? null, architecture: info.architecture ?? null, device: info.device ?? null, description: info.description ?? null };
      } catch { /* WebGPU adapter info not exposed */ }
      // A run whose GPU is unnamed is still a run, but it must SAY it is unnamed rather than leave
      // the field out and let a reader assume the machine was the one they had in mind.
      out.gpuVendor = out.gpuVendor ?? 'unavailable';
      out.gpuRenderer = out.gpuRenderer ?? 'unavailable';
      return out;
    }

    /** Unique geometries, materials and textures actually hanging off the scene, with byte sizes. */
    function walkSceneMemory() {
      const geometries = new Set(), materials = new Set(), textures = new Map();
      let attributeBytes = 0, indexBytes = 0;
      for (const root of [scene]) {
        root.traverse((object) => {
          const geometry = object.geometry;
          if (geometry && !geometries.has(geometry)) {
            geometries.add(geometry);
            for (const attribute of Object.values(geometry.attributes ?? {})) {
              attributeBytes += attribute?.array?.byteLength ?? 0;
            }
            indexBytes += geometry.index?.array?.byteLength ?? 0;
          }
          const list = Array.isArray(object.material) ? object.material : (object.material ? [object.material] : []);
          for (const material of list) {
            if (!material || materials.has(material)) continue;
            materials.add(material);
            for (const value of Object.values(material)) {
              if (value && value.isTexture && !textures.has(value)) textures.set(value, value);
            }
          }
        });
      }
      let textureBytes = 0, compressedTextures = 0;
      for (const texture of textures.values()) {
        const image = texture.image ?? {};
        const width = image.width ?? 0, height = image.height ?? 0, depth = image.depth ?? 1;
        if (texture.isCompressedTexture) compressedTextures += 1;
        const base = width * height * Math.max(1, depth) * 4;
        textureBytes += texture.generateMipmaps ? Math.round(base * 1.3333) : base;
      }
      return summarizeGpuMemory({
        geometries: renderer.info?.memory?.geometries ?? null,
        textures: renderer.info?.memory?.textures ?? null,
        attributeBytes, indexBytes, textureBytes, compressedTextures,
      });
    }

    function snapshotRenderInfo() {
      const frame = describeRenderFrame(renderFrameLatch, renderer.info, performance.now());
      return {
        drawCalls: frame.drawCalls,
        triangles: frame.triangles,
        // `renderer.render()` invocations inside the LAST rAF tick — three resets it per tick, and
        // the nested `renderer.render(scene, shadow.camera)` a shadow update makes counts as one.
        // So 2 means the shadow map was re-rendered on that frame and 1 means it was not: the
        // crispest single check that the `shadow` ablation actually took effect.
        frameCalls: renderFrameLatch.frameCalls,
        drawCallsSource: frame.drawCallsSource,
        drawCallsAgeMs: frame.drawCallsAgeMs,
        renderedFrames: frame.renderedFrames,
        // renderer.info.memory — RESIDENT objects, not drawn ones. Named accordingly.
        residentGeometries: renderer.info?.memory?.geometries ?? null,
        residentTextures: renderer.info?.memory?.textures ?? null,
        programs: renderer.info?.memory?.programs ?? null,
        programsSize: renderer.info?.memory?.programsSize ?? null,
      };
    }

    /* ------------------------------------------------------------------- the presets -- */

    const zoomOffset = zoomOffsetFor(mapData);
    function resolvePreset(preset) {
      if (preset.fit) {
        const view = src.fitView?.();
        if (!view) return { error: 'this build supplies no fitView(); the cover-fit preset cannot be resolved and is NOT substituted' };
        return { view };
      }
      return {
        view: {
          target: [-preset.x, -preset.z, 0],
          zoom: preset.zoom2d - zoomOffset,
          rotationX: preset.rotationX ?? CAM.rotationX,
          rotationOrbit: preset.rotationOrbit ?? CAM.rotationOrbit,
        },
      };
    }

    /* ------------------------------------------------------------------------- the run -- */

    async function runPreset(preset, options) {
      const resolved = resolvePreset(preset);
      if (resolved.error) return buildPresetResult({ name: preset.name, hash: preset.hash ?? null, note: preset.note ?? null, error: resolved.error });

      // Applied with `notify: true`, so main.js's HUD, permalink and — critically — the label-tier
      // sync run for this pose. A preset applied without notifying would be measured against an
      // overlay built for the previous camera.
      const applied = applyView(resolved.view, true);
      // Long enough for main.js's `refresh()` and the 4 m-epsilon vegetation repack (one rAF) to
      // have landed, so the warm-up frames are warming up a settled scene rather than paying for it.
      await sleep(options.settleMs ?? 500);

      collector = null;
      await framesElapsed(options.warmupFrames);

      collector = { ledger: createPhaseLedger(), events: createEventLedger(), gpu: [], heap: [] };
      // Snapshotted per preset: the GPU counters accumulate for the life of the run, and a health
      // figure that carried the previous preset's resolves would describe the wrong window.
      const gpuAtStart = { resolveCalls: gpu.resolveCalls, adjacentDuplicates: gpu.adjacentDuplicates };
      const windowStart = performance.now();
      await framesElapsed(options.sampleFrames);
      const windowMs = performance.now() - windowStart;
      const sampled = collector;
      collector = null;

      // Did what was switched off STAY off for this preset's window? `applyNature()` writes
      // `rockGroup.visible` and would silently undo an ablation; asking after the fact is the only
      // way to know, and the answer ships whether or not it is the one that was hoped for.
      if (activeAblation) {
        for (const check of activeAblation.verify()) ablationChecks.push({ preset: preset.name, ...check });
      }

      const overlayItemsSeen = overlayItems.length;
      const visibleItems = visibleOverlayCount();

      // The reflow probe: a SEPARATE pass, so its batched frames never enter the numbers above.
      let overlayReflow = null;
      if (options.reflowFrames > 0) {
        overlayProbe = { interleaved: [], batched: [] };
        for (let i = 0; i < options.reflowFrames; i += 1) {
          overlayVariant = 'interleaved';
          await framesElapsed(1);
          overlayVariant = 'batched';
          await framesElapsed(1);
        }
        overlayVariant = 'interleaved';
        overlayReflow = summarizeOverlayReflow({ ...overlayProbe, visibleItems });
        overlayProbe = null;
      }

      return buildPresetResult({
        name: preset.name,
        hash: preset.hash ?? null,
        note: preset.note ?? null,
        view: { ...applied, zoom2d: (applied.zoom ?? 0) + zoomOffset },
        warmupFrames: options.warmupFrames,
        phaseSummary: sampled.ledger.summarize(),
        events: sampled.events.summarize(windowMs),
        windowMs,
        overlayItems: overlayItemsSeen,
        gpu: describeGpuTiming({
          method: gpu.method,
          available: gpu.supported,
          reason: gpu.reason,
          backend: status.backend,
          values: sampled.gpu,
          resolveCalls: gpu.resolveCalls - gpuAtStart.resolveCalls,
          // NOT a count of zero — nothing here counts disjoints, and a `0` in a field named
          // `disjointObserved` reads as proof that none occurred. `describeDisjointObservability`
          // answers, per backend, whether the condition can be counted at all: WebGPU has no such
          // flag, and on the WebGL2 fallback reading GPU_DISJOINT_EXT CLEARS it out from under
          // three's own correctness check. The report gets `null` plus the reason.
          disjoint: describeDisjointObservability(status.backend),
          adjacentDuplicates: gpu.adjacentDuplicates - gpuAtStart.adjacentDuplicates,
        }),
        renderInfo: snapshotRenderInfo(),
        memory: { heap: summarizeHeap(sampled.heap), gpuEstimate: walkSceneMemory() },
        overlayReflow,
      });
    }

    let lastReport = null;
    let lastSeries = null;
    let inFlight = null;
    let onProgress = null;
    /** The ablation in force for the run currently executing, and every held/not-held answer taken. */
    let activeAblation = null;
    let ablationChecks = [];
    /** `'props,rocks'` or an already-parsed spec, both accepted. `null`/absent means no ablation. */
    const asAblation = (value) => (typeof value === 'string' ? parseAblation(value) : (value ?? null));

    async function run(overrides = {}) {
      if (inFlight) return inFlight;
      if (!document.body.classList.contains('view-3d')) {
        throw new Error('the render profiler measures the 3D frame; switch to the 3D view first');
      }
      const options = {
        warmupFrames: profileRequest.warmupFrames,
        sampleFrames: profileRequest.sampleFrames,
        reflowFrames: profileRequest.reflowFrames,
        presets: profileRequest.presets,
        settleMs: 500,
        ...overrides,
      };
      inFlight = (async () => {
        const restoreView = { ...viewState };
        const selfTest = overrides.selfTest !== undefined ? overrides.selfTest : profileRequest.selfTest;
        // `overrides.ablate` is how the A/B series alternates arms without reloading: arm A passes
        // `null` even when the URL asked for one, so a single page load can produce both. A STRING
        // is accepted and parsed — `tz.profile({ ablate: 'props' })` is what a hand types at a
        // console, and making the caller import the parser to type it would be a trap.
        const ablate = asAblation(overrides.ablate !== undefined ? overrides.ablate : profileRequest.ablate);
        const culled = [];
        ablationChecks = [];
        running = true;
        renderRequested = true;
        try {
          if (selfTest?.kind === 'busy') busyMs = selfTest.busyMs;
          if (selfTest?.kind === 'nocull') {
            for (const root of [worldRoot, authoredRoot, vegetationRoot, dynamicRoot]) {
              root?.traverse((object) => {
                if (object.frustumCulled) { culled.push(object); object.frustumCulled = false; }
              });
            }
          }
          /*
           * A NULL EXPERIMENT MUST NOT PRODUCE A REPORT.
           *
           * `?profileAblate=shadow` on a default load has nothing to remove: the freeze IS the
           * shipped behaviour, so arm A and arm B are both frozen, `heldThroughout` is true in both
           * (the flag cannot tell the arms apart), and a fully-formed report comes out attributing
           * ~0 ms to a pass that was never switched off. A reader who does not know why concludes
           * the measured win was imaginary and reverts a change worth ~6 ms of frame time. So this
           * refuses, and names the load that still discriminates.
           */
          if (ablate?.targets?.includes('shadow') && sunShadow.live === false) {
            throw new Error('?profileAblate=shadow has nothing to remove on this load — the shipped'
              + ' build already freezes the depth map (sun.shadow.autoUpdate is false). Reload with'
              + ' ?shadows=live&profileAblate=shadow to measure the shadow pass.');
          }
          if (ablate?.kind === 'ablate') activeAblation = await armAblation(ablate);
          const presets = PROFILE_PRESETS.filter((preset) => options.presets.includes(preset.name));
          const results = [];
          for (const preset of presets) {
            onProgress?.(`${preset.name}: measuring`);
            // eslint-disable-next-line no-await-in-loop -- presets are measured one at a time on purpose
            results.push(await runPreset(preset, options));
          }
          const veg = authoredVegetationRenderStats();
          const report = buildProfileReport({
            at: new Date().toISOString(),
            request: { ...profileRequest, presets: [...profileRequest.presets] },
            build: {
              href: location.href,
              // In a production build this is the CONTENT-HASHED chunk name, so two reports can be
              // told apart by the code that produced them rather than by when they were taken.
              moduleUrl: import.meta.url,
              threeVersion: THREE.REVISION,
              renderer: 'three',
              mode: import.meta.env?.DEV === true ? 'dev' : 'release',
              gate: { ...rendererGate },
              look, relief, fx: { ...fx },
            },
            environment: {
              ...describeGpu(),
              backend: status.backend,
              forceWebGL,
              viewportWidth: container.clientWidth,
              viewportHeight: container.clientHeight,
              windowInnerWidth: window.innerWidth,
              windowInnerHeight: window.innerHeight,
              devicePixelRatio: window.devicePixelRatio ?? null,
              // The renderer CLAMPS the device ratio to 1.5 (`setPixelRatio` at construction), so a
              // report that only recorded `window.devicePixelRatio` would overstate the pixels
              // actually shaded on a 2x display by 78%.
              rendererPixelRatio: renderer.getPixelRatio?.() ?? null,
              drawingBufferWidth: renderer.domElement?.width ?? null,
              drawingBufferHeight: renderer.domElement?.height ?? null,
              userAgent: navigator.userAgent,
              hardwareConcurrency: navigator.hardwareConcurrency ?? null,
              deviceMemoryGb: navigator.deviceMemory ?? null,
              // Both answers, because they can differ: the feature can be advertised at boot and
              // still never complete a resolve, which is exactly what headless SwiftShader does.
              // Reporting only the final value would have read as "this browser has no timer".
              timestampFeatureAtBoot: gpu.supportedAtBoot,
              timestampFeature: gpu.supported,
              // `null` on WebGPU: the extension is a WebGL concept and the backend has no such
              // field, so `false` would have been an assertion about a question that cannot be put.
              disjointExtensionPresent,
            },
            /*
             * WHICH SHADOW POLICY PRODUCED THESE NUMBERS.
             *
             * Since 2026-09-03 the shadow policy is the single largest term in `render` (12.45 ->
             * 6.50 ms at founder-a). A report that cannot say whether the freeze was on is not
             * self-describing — the exact property `buildProfileReport` otherwise enforces by
             * throwing — and two reports compared next week would have their difference attributed
             * to something else entirely. It records the EFFECTIVE parsed state, never the URL.
             */
            shadows: { ...sunShadow.stats() },
            layers: {
              overlayItems: overlayItems.length,
              markerRows: (() => { try { return src.markers?.().length ?? null; } catch { return null; } })(),
              labelRows: (() => { try { return src.labels?.().length ?? null; } catch { return null; } })(),
              questPoints: (() => { try { return src.quests?.().points?.length ?? null; } catch { return null; } })(),
              livePlayers: (() => { try { return src.players?.().length ?? null; } catch { return null; } })(),
              markerTier: currentMarkerTier(),
            },
            vegetation: {
              // The single field that decides whether this report describes the shipped forest.
              // Every measurement previously recorded in this repo was taken with it false.
              mounted: veg?.mount?.phase === 'mounted' && veg?.mode === 'authored',
              mountPhase: veg?.mount?.phase ?? null,
              mountElapsedMs: veg?.mount?.elapsedMs ?? null,
              mode: veg?.mode ?? null,
              distribution: veg?.distribution ?? null,
              warnings: veg?.warnings ?? null,
              liveBuckets: veg?.authored?.liveBuckets ?? null,
              families: veg?.authored?.families ?? null,
            },
            waterfall: profileWaterfall?.describe(performance.now() - bootAt) ?? null,
            presets: results,
            selfTest,
            // The spec the URL asked for, PLUS what the scene said back: which targets were found,
            // and whether each was still switched off at the end of every preset. `heldThroughout`
            // is a measurement, not a promise — a false there puts a warning at the top of `notes`.
            ablation: activeAblation && ablate?.kind === 'ablate'
              ? {
                ...ablate,
                targets: [...ablate.targets],
                unknown: [...ablate.unknown],
                pixelChanging: [...ablate.pixelChanging],
                applied: activeAblation.applied.map((row) => ({ ...row })),
                verified: ablationChecks.map((row) => ({ ...row })),
                heldThroughout: ablationChecks.length > 0 && ablationChecks.every((row) => row.held),
              }
              : null,
            notes: [
              'Frames were rendered CONTINUOUSLY for the duration of this run. This app renders on demand, so these numbers are the cost of a frame, not the rate at which the app submits frames.',
              'drawCalls/triangles come from the render-frame latch — renderer.info sampled immediately after render() — and describe the last frame of the sampling window at that preset.',
              gpu.supported
                ? 'GPU frame time came from three\'s timestamp query pool. three returns its PREVIOUS value on a disjoint or an in-flight resolve, so gpuTiming.health.adjacentDuplicates is the signal that a number may be stale.'
                : 'NO GPU TIMER. gpuFrameMs is null at every preset; CPU frame time has not been substituted for it.',
              ...(Array.isArray(options.extraNotes) ? options.extraNotes : []),
            ],
          });
          lastReport = report;
          return report;
        } finally {
          busyMs = 0;
          for (const object of culled) object.frustumCulled = true;
          // Restored on EVERY exit, including a throw. An ablation that leaked past its run would
          // make the next run — the baseline arm of an A/B series — silently ablated too.
          activeAblation?.restore();
          activeAblation = null;
          overlayVariant = 'interleaved';
          overlayProbe = null;
          collector = null;
          running = false;
          applyView(restoreView, true);
          inFlight = null;
          onProgress?.(null);
        }
      })();
      return inFlight;
    }

    /**
     * A/B/A/B in ONE page load — the strong form of the comparison.
     *
     * Separate page loads differ in shader compilation, pipeline caches and texture residency, and
     * the GPU numbers this project has recorded moved 1-4 ms run to run for no attributable reason.
     * A 2 ms delta across two loads is therefore not evidence. Alternating arms inside one load
     * holds all of that constant, and repeating each arm is what gives the comparison a noise floor
     * to measure its own delta against — `describeAblationSeries` refuses to call a delta
     * attributed unless it exceeds the widest within-arm spread.
     *
     * Arm A is unablated and arm B is ablated, always in that order, so a monotonic drift (thermal
     * throttling, a background tab) shows up as A and B both moving rather than as a fake delta.
     */
    async function runSeries(overrides = {}) {
      const ablate = asAblation(overrides.ablate !== undefined ? overrides.ablate : profileRequest.ablate);
      if (ablate?.kind !== 'ablate') {
        throw new Error('an A/B series needs an ablation to alternate; reload with ?profileAblate=shadow (or props, rocks, or a comma-separated combination)');
      }
      const repeats = Math.min(6, Math.max(1, Math.round(Number(overrides.repeats ?? 2) || 2)));
      const runs = [];
      for (let cycle = 0; cycle < repeats; cycle += 1) {
        for (const arm of ['A', 'B']) {
          onProgress?.(`A/B series: cycle ${cycle + 1}/${repeats}, arm ${arm}${arm === 'B' ? ` (${ablate.targets.join(', ')})` : ' (unablated)'}`);
          // eslint-disable-next-line no-await-in-loop -- the arms are alternated on purpose
          const report = await run({
            ...overrides,
            ablate: arm === 'A' ? null : ablate,
            extraNotes: [`A/B SERIES, arm ${arm}, cycle ${cycle + 1} of ${repeats}. Read this run against its siblings in the same series, never on its own.`],
          });
          runs.push({ arm, cycle: cycle + 1, report });
        }
      }
      lastSeries = Object.freeze({
        schema: PROFILE_SERIES_SCHEMA,
        at: new Date().toISOString(),
        ablation: { ...ablate, targets: [...ablate.targets], pixelChanging: [...ablate.pixelChanging] },
        repeats,
        order: Object.freeze(runs.map((entry) => entry.arm)),
        comparison: describeAblationSeries(runs),
        runs: Object.freeze(runs),
      });
      return lastSeries;
    }

    return {
      renderProfiled,
      event,
      run,
      runSeries,
      shadowPixelCheck,
      get report() { return lastReport; },
      get series() { return lastSeries; },
      get busy() { return Boolean(inFlight); },
      set onProgress(fn) { onProgress = fn; },
      gpuAvailable: () => gpu.supported,
      gpuReason: () => gpu.reason,
    };
  }

  if (profileRequest.armed) frameProfiler = createRenderProfiler();

  /**
   * The profiler's own chrome: a corner panel, and only for a visitor who typed `?profile=`.
   *
   * Not the CUSTOMS TRUTH strip and not gated like it. That strip was removed from the live page
   * because it appeared uninvited over the middle of the map and said something a visitor could not
   * act on; this is a control surface someone asked for by URL, and it sits in a corner. It is
   * built inside `container` rather than inside `overlay`, because `.tz-three-overlay` is
   * `pointer-events: none` and this has a button on it.
   *
   * Styled inline on purpose: a panel that exists only under a query parameter should not be able
   * to be broken by an unrelated edit to src/style.css, and should leave no trace when off.
   */
  let profilePanel = null;
  let profilePanelInterval = 0;
  if (frameProfiler) {
    profilePanel = document.createElement('div');
    profilePanel.className = 'tz-three-profile';
    profilePanel.style.cssText = 'position:absolute;left:10px;bottom:10px;z-index:9;max-width:min(46ch,46vw);max-height:60%;overflow:auto;padding:8px 10px;border-radius:5px;background:rgba(8,10,12,.88);color:#dfe6ec;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;box-shadow:0 4px 14px rgba(0,0,0,.5);pointer-events:auto;white-space:pre-wrap';
    const title = document.createElement('div');
    title.textContent = 'RENDER PROFILER';
    title.style.cssText = 'font-weight:700;letter-spacing:.08em;margin-bottom:4px';
    const body = document.createElement('div');
    const runButton = document.createElement('button');
    runButton.type = 'button';
    runButton.textContent = 'Run baseline';
    runButton.style.cssText = 'margin-top:6px;margin-right:6px;padding:4px 9px;border-radius:4px;border:1px solid #4a5560;background:#1b2026;color:inherit;font:inherit;cursor:pointer';
    // Only when an ablation was asked for: A/B/A/B in this page load, which is stronger evidence
    // than two loads compared by hand because it holds shader and pipeline warmup constant.
    const abButton = document.createElement('button');
    abButton.type = 'button';
    abButton.textContent = 'Run A/B/A/B';
    abButton.style.cssText = runButton.style.cssText;
    abButton.hidden = profileRequest.ablate?.kind !== 'ablate';
    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.textContent = 'Download JSON';
    copyButton.disabled = true;
    copyButton.style.cssText = runButton.style.cssText;
    profilePanel.append(title, body, runButton, abButton, copyButton);
    container.append(profilePanel);

    const describeReadiness = () => {
      const veg = authoredVegetationRenderStats();
      const mounted = veg?.mount?.phase === 'mounted' && veg?.mode === 'authored';
      return [
        `backend      ${status.backend}${forceWebGL ? ' (forced)' : ''}`,
        `gpu timer    ${frameProfiler.gpuAvailable() ? 'YES' : `NO — ${frameProfiler.gpuReason() ?? 'unavailable'}`}`,
        // The line that decides whether a run is worth taking. 60-85 s, never awaited.
        `vegetation   ${mounted ? 'MOUNTED — ready' : `${veg?.mount?.phase ?? 'not started'} — WAIT, this is not the shipped forest yet`}`,
        `presets      ${profileRequest.presets.join(', ')}`,
        `frames       ${profileRequest.warmupFrames} warm-up discarded, ${profileRequest.sampleFrames} sampled, ${profileRequest.reflowFrames}x2 reflow probe`,
        profileRequest.selfTest ? `SELF-TEST    ${profileRequest.selfTest.label} — NOT A BASELINE` : null,
        // Two classes, spelled differently on purpose: one claims the picture is unchanged and the
        // other deliberately changes it. A reader must not have to infer which they are looking at.
        profileRequest.ablate?.kind === 'ablate'
          ? `ABLATION     ${profileRequest.ablate.targets.join(', ')} — ${profileRequest.ablate.pixelIdentical ? 'PIXEL-IDENTICAL BY HYPOTHESIS (verify it)' : `PIXELS CHANGE ON PURPOSE (${profileRequest.ablate.pixelChanging.join(', ')})`} — NOT A BASELINE`
          : null,
        profileRequest.ablate?.kind === 'unknown' ? `ignored      ${profileRequest.ablate.label}` : null,
        profileRequest.ablate?.unknown?.length ? `ignored      unknown ablation targets: ${profileRequest.ablate.unknown.join(', ')}` : null,
        profileRequest.unknownPresets.length ? `ignored      unknown presets: ${profileRequest.unknownPresets.join(', ')}` : null,
      ].filter(Boolean).join('\n');
    };
    let profilePanelTail = null;
    const paintPanel = (extra) => { body.textContent = `${describeReadiness()}${extra ? `\n\n${extra}` : ''}`; };
    paintPanel(null);
    // The readiness block above changes while the vegetation pack loads, so it is repainted — but
    // never while a run is in flight, because a `textContent` write is layout the measurement would
    // then be paying for.
    profilePanelInterval = setInterval(() => { if (!frameProfiler.busy) paintPanel(profilePanelTail); }, 700);
    frameProfiler.onProgress = (text) => { if (text) paintPanel(text); };

    /** The last thing either button produced, for `Download JSON` — a report OR a series. */
    let downloadable = null;
    const ms = (summary) => (summary ? `${summary.median.toFixed(2)}/${summary.p95.toFixed(2)}` : 'no samples');
    runButton.addEventListener('click', async () => {
      runButton.disabled = abButton.disabled = true;
      paintPanel('running…');
      try {
        const report = await frameProfiler.run();
        const rows = report.presets.map((p) => (p.ok
          ? `${p.name.padEnd(13)} cpu ${ms(p.cpuFrameMs)} ms (med/p95) · gpu ${p.gpuFrameMs ? `${p.gpuFrameMs.median.toFixed(2)} ms` : 'null'} · ${p.renderInfo?.drawCalls ?? '?'} calls · ${p.renderInfo?.triangles ?? '?'} tris`
          : `${p.name.padEnd(13)} FAILED — ${p.error}`));
        profilePanelTail = `${rows.join('\n')}\n\nDownload the JSON — the panel is a summary, the file is the measurement.`;
        paintPanel(profilePanelTail);
        downloadable = { kind: 'profile', value: report };
        copyButton.disabled = false;
      } catch (error) {
        profilePanelTail = `RUN FAILED — ${String(error?.message ?? error)}`;
        paintPanel(profilePanelTail);
      } finally {
        runButton.disabled = false;
        abButton.disabled = abButton.hidden;
      }
    });

    /*
     * A/B/A/B, and a panel summary that reports the VERDICT rather than only the delta.
     *
     * A delta printed on its own invites the reader to believe it. `describeAblationSeries` knows
     * the widest spread each arm produced when nothing changed, so the line says whether the delta
     * cleared that or sat inside it — which is the only question this series was run to answer.
     */
    abButton.addEventListener('click', async () => {
      runButton.disabled = abButton.disabled = true;
      paintPanel('A/B series: this runs the whole preset set twice per arm…');
      try {
        const series = await frameProfiler.runSeries();
        const lines = [];
        for (const [preset, metrics] of Object.entries(series.comparison.presets)) {
          lines.push(`${preset}  (A = unablated, B = ${series.ablation.targets.join('+')})`);
          for (const metric of ['cpuFrameMedianMs', 'renderPhaseMedianMs', 'gpuFrameMedianMs', 'drawCalls', 'frameCalls']) {
            const row = metrics[metric];
            if (row?.delta === null || row?.delta === undefined) continue;
            const noise = row.withinArmSpread === null ? 'no noise floor' : `±${row.withinArmSpread.toFixed(2)} within-arm`;
            lines.push(`  ${metric.padEnd(20)} A ${row.aMedian.toFixed(2)} → B ${row.bMedian.toFixed(2)}  Δ ${row.delta >= 0 ? '+' : ''}${row.delta.toFixed(2)}  (${noise})`);
            lines.push(`  ${''.padEnd(20)} ${row.verdict}`);
          }
        }
        profilePanelTail = `${lines.join('\n')}\n\nDownload the JSON — the series file holds every run.`;
        paintPanel(profilePanelTail);
        downloadable = { kind: 'series', value: series };
        copyButton.disabled = false;
      } catch (error) {
        profilePanelTail = `A/B SERIES FAILED — ${String(error?.message ?? error)}`;
        paintPanel(profilePanelTail);
      } finally {
        runButton.disabled = false;
        abButton.disabled = false;
      }
    });
    copyButton.addEventListener('click', () => {
      const payload = downloadable ?? (frameProfiler.report ? { kind: 'profile', value: frameProfiler.report } : null);
      if (!payload) return;
      const blob = new Blob([JSON.stringify(payload.value, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      const stamp = String(payload.value.at ?? new Date().toISOString()).replace(/[:.]/g, '-');
      link.download = `tz-render-${payload.kind === 'series' ? 'ablation-series' : 'profile'}-${stamp}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 5000);
    });
  }

  let frames = 0, fps = null, fpsWindowAt = performance.now(), stopped = false;
  /**
   * The last frame this renderer actually submitted.
   *
   * `renderer.info` cannot be read from `renderStats()` directly: three's WebGPU `Animation` loop
   * calls `info.reset()` on every rAF tick whether or not anything rendered, and this app renders
   * on demand, so an idle frame reports 0 draw calls and 0 triangles under a fully drawn scene.
   * Sampling immediately after `render()` — which is synchronous once the backend is initialized —
   * is the point in the frame where the numbers are true.
   */
  let renderFrameLatch = EMPTY_RENDER_FRAME_LATCH;
  function animate() {
    if (stopped) return;
    requestAnimationFrame(animate);
    // Keep the expensive full-resolution scene alive for instant 2D↔3D handoff, but do not
    // continue submitting ~2.9M triangles while the 2D map owns the viewport.
    if (document.hidden || !document.body.classList.contains('view-3d')) {
      frames = 0;
      fps = 0;
      fpsWindowAt = performance.now();
      return;
    }
    if (!renderRequested && settleFrames <= 0) return;
    renderRequested = false;
    // ONE branch. The `else` arm is the frame exactly as it was before the profiler existed; the
    // `if` arm calls the same four functions in the same order with `performance.mark()` between
    // them, and `scripts/render-profiler.test.mjs` pins that by reading this source.
    if (frameProfiler) frameProfiler.renderProfiled();
    else renderOneFrame();
    renderFrameLatch = latchRenderFrame(renderFrameLatch, sampleRenderFrame(renderer.info, performance.now()));
    if (settleFrames > 0) {
      settleFrames--;
      renderRequested = true;
    }
    frames++;
    const now = performance.now();
    if (status.firstFrameMs == null) { status.firstFrameMs = Math.round(now - bootAt); wfMark('firstRender'); }
    if (now - fpsWindowAt >= 1000) {
      fps = Math.round(frames * 1000 / (now - fpsWindowAt));
      frames = 0; fpsWindowAt = now;
    }
  }
  animate();

  /*
   * THE STALE-SHADOW AUDIT — `?shadowAudit=1`, dev instrument, never on the shipped path.
   *
   * A dropped `sunShadow.invalidate(...)` is invisible: the frame renders, every count is green, and
   * the only symptom is a shadow of geometry that is no longer there. That is precisely the
   * handoff-§7 shape, so this converts it into something loud. Each tick it fingerprints the caster
   * set (`shadowCasterFingerprint`) and compares it with the fingerprint taken on the frame that
   * baked the depth map; a difference with no invalidation behind it is reported to the console and
   * published in `renderStats().shadows.audit`.
   *
   * It runs in its OWN rAF loop, deliberately: `animate()` and `renderOneFrame()` are the shipped
   * frame, pinned line-for-line by `scripts/render-profiler.test.mjs`, and an instrument that had to
   * be spliced into them would be paying for itself on every frame of every visitor's session. The
   * loop is registered after `animate()`, so within a tick the audit observes a frame three has
   * already rendered and `matrixWorld` is current.
   */
  const shadowAudit = shadowRequest.audit
    ? createShadowCasterAudit({
      controller: sunShadow,
      fingerprint: () => shadowCasterFingerprint(scene, { light: sun }),
      onDefect: (defect) => console.error(
        '[three-poc] STALE SHADOW: the shadow-casting set changed with no invalidation.'
        + ` Casters baked ${defect.baked.casters}, now ${defect.observed.casters}`
        + ` (delta ${defect.casterDelta} — ${JSON.stringify(defect.byKind)}).`
        + ` Last invalidation: ${JSON.stringify(defect.lastInvalidation)}.`
        + ' Something mutated a caster without calling sunShadow.invalidate() — see'
        + ' src/shadow-invalidation.js SHADOW_INVALIDATION_REASONS.',
        defect,
      ),
    })
    : null;
  if (shadowAudit) {
    const auditTick = () => {
      if (stopped) return;
      shadowAudit.observe();
      requestAnimationFrame(auditTick);
    };
    requestAnimationFrame(auditTick);
  }

  const resize = new ResizeObserver(() => {
    const width = Math.max(1, container.clientWidth), height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    applyView(viewState);
    invalidateRender();
  });
  resize.observe(container);

  const api = {
    renderer: 'three',
    backend: status.backend,
    refresh: refreshDynamic,
    setNature: (next) => { nature = { ...nature, ...next }; applyNature(); updateUnderstoryLod(); },
    setRelief: () => relief,
    setLook: (next) => { look = VALID_LOOK.has(next) ? next : 'realistic'; applyLook(); return look; },
    getLook: () => look,
    setFx: (next) => { fx = { ...updateThreeFx(fx, next), fog: false }; applyLook(); return { ...fx }; },
    getFx: () => ({ ...fx }),
    // An extract's element no longer spells its own name in text — it carries a letter badge plus a
    // name chip, and in a real DOM `textContent` would concatenate the SVG's letter with the name
    // ("D" + "Dorms V-Ex"). Match on the spec the item was built from, which is the string the
    // marker data actually holds.
    focusExtract: (name) => {
      const wanted = safeText(name);
      for (const item of overlayItems) {
        const own = safeText(item.spec ? item.spec.label : item.element.textContent);
        item.element.classList.toggle('focused', item.kind === 'extract' && own === wanted);
      }
    },
    setView: (patch = {}) => applyView(patch),
    project: (x, z, dy = 0.7) => {
      const v = new THREE.Vector3(...gameToWorld(x, z, H(x, z) + dy)).project(camera);
      if (!(v.z > -1 && v.z < 1)) return null;
      return [(v.x + 1) * container.clientWidth / 2, (-v.y + 1) * container.clientHeight / 2];
    },
    /**
     * The render profiler, or a refusal that says how to arm it.
     *
     * `null` would have been the easy answer for an unarmed page and the wrong one: the GPU timer
     * is a renderer-construction parameter, so "profiling is off" and "profiling cannot be turned
     * on from here" are the same state and a reader has to be told which. `?profile=1` is the whole
     * answer, and it is a RELOAD, not a toggle.
     */
    profile: (overrides) => {
      if (!frameProfiler) {
        return Promise.reject(new Error('the render profiler was not armed at boot; reload with ?profile=1 (the GPU timer is a renderer-construction parameter and cannot be enabled later)'));
      }
      return frameProfiler.run(overrides);
    },
    /**
     * A/B/A/B in one page load. Same refusal as `profile()`, plus one of its own: without an
     * ablation there is nothing to alternate, and the error says which URL to reload with.
     */
    profileAB: (overrides) => {
      if (!frameProfiler) {
        return Promise.reject(new Error('the render profiler was not armed at boot; reload with ?profile=1&profileAblate=shadow'));
      }
      return frameProfiler.runSeries(overrides);
    },
    /**
     * TWO verdicts, ASYNC — `await tz.profileShadowPixels()`.
     *
     * `residentMapWasCurrent` is the P1 defect check (was the depth map on screen stale?) and is
     * meaningful on the shipped frozen load. `freezeIsPixelFree` is the original hypothesis and
     * wants `?shadows=live`. It renders one frame per arm, one arm per rAF tick, and voids itself if
     * either control fails — two identical renders that hash differently (the scene is moving), or a
     * camera nudge that does not (the readback is blind).
     */
    profileShadowPixels: () => {
      if (!frameProfiler) throw new Error('the render profiler was not armed at boot; reload with ?profile=1');
      return frameProfiler.shadowPixelCheck();
    },
    profileReport: () => frameProfiler?.report ?? null,
    profileSeries: () => frameProfiler?.series ?? null,
    profileArmed: () => Boolean(frameProfiler),
    renderStats: () => ({
      map: 'customs', renderer: 'three', backend: status.backend, scope: status.scope, look, relief, fx: { ...fx }, fps,
      // WHAT THE FRAME SAYS ABOUT ITSELF, whether or not it is allowed to say it on screen.
      //
      // This is the last painted `customsTruthStripCopy()` — the same object `paintTruthStrip`
      // wrote into the DOM node — plus `shown`, which is question (c) of the renderer gate. In a
      // release build `shown` is false and every other field is exactly what a dev box would read.
      // That is the whole contract of hiding the banner: the pixels go, the state does not.
      truth: { ...truthStripCopy, shown: diagnosticReadoutsVisible },
      // Both halves of the renderer gate, as measured at boot. `gate.localEnhancements === false`
      // is the single field that says "this frame is public data" — every degraded-looking
      // vegetation/terrain field below has to be read against it.
      gate: { ...rendererGate },
      // `info.render.calls` is CUMULATIVE `renderer.render()` invocations since page load on the
      // WebGPU renderer (Renderer.js), not per-frame draw calls; the per-frame counter is
      // `info.render.drawCalls` (Info.js). Reading `.calls` reported a frame counter, which made
      // every draw-call claim on this renderer meaningless. Both are exposed, correctly named.
      //
      // And neither can be read HERE. The renderer's own animation loop resets both counters every
      // rAF tick, including the ticks on which this on-demand app renders nothing, so reading them
      // from a console call lands on an idle frame roughly as often as not and reports 0. These
      // come from the latch instead: `drawCalls` is the last frame actually submitted,
      // `drawCallsAgeMs` says how long ago that was, and `liveDrawCalls` keeps the raw counter
      // beside it so the difference stays visible.
      ...describeRenderFrame(renderFrameLatch, renderer.info, performance.now()),
      geometries: renderer.info?.memory?.geometries ?? null, textures: renderer.info?.memory?.textures ?? null,
      firstFrameMs: status.firstFrameMs, dataBytes: status.dataBytes, authored: status.manifest,
      groundAtlas: status.groundAtlas, exactTerrain: status.exactTerrain,
      exactVegetation: status.exactVegetation,
      vegetation: authoredVegetationRenderStats(),
      // The sun's depth map: frozen or live, how many times it has been invalidated and by what.
      // `byReason` is the invalidation list actually exercised by this session, which is the only
      // way to tell a lane that never fires from one that fires and is not counted.
      shadows: { ...sunShadow.stats(), audit: shadowAudit ? shadowAudit.stats() : { armed: false } },
      floorSurfaces: { ...surfaceRenderStats, stableIds: [...new Set(surfaceRenderStats.stableIds)] },
      groundcover: { ...understoryRenderStats },
      railway: { ...railwayRenderStats },
      water: { ...waterRenderStats },
      bridges: { ...bridgeRenderStats, local: localBridgeStatus },
      walls: { ...wallRenderStats, unclassifiedPathProps: [...unclassifiedPathProps] },
      // The building-detail lane's cost, counted from the objects that were built. `drawCalls.after`
      // is groups + outlines + instanced meshes + the one merged skirt; `before` is what the
      // pre-lane renderer drew for the same rows (two material groups and one outline each, and one
      // group with no outline for the row that took the `place === 'skeleton'` open-frame literal).
      // Floor slabs are in neither and are reported by `floorSurfaces`.
      buildings: buildingStatsNow(),
      provisional: true,
    }),
    diagnostics: () => ({
      // `scope` names the OVERLAY gate (bbox + source + margin), because that is what decides
      // whether a label, marker, extract or quest pin is drawn. `railwayGeometryScope` is the
      // separate proof-of-concept cell that still clips the rail mesh, reported so the two cannot
      // be confused for one another again.
      scope: { ...overlayScope, id: `customs-overlay-${overlayScope.source}` },
      railwayGeometryScope: THREE_POC_SCOPE,
      backend: status.backend, gate: { ...rendererGate }, authored: status.manifest,
      truth: { ...truthStripCopy, shown: diagnosticReadoutsVisible },
      groundAtlas: status.groundAtlas, exactTerrain: status.exactTerrain,
      exactVegetation: status.exactVegetation,
      vegetation: authoredVegetationRenderStats(),
      shadows: { ...sunShadow.stats(), audit: shadowAudit ? shadowAudit.stats() : { armed: false } },
      sources: { buildings: data.buildings?.length ?? 0, props: data.props?.length ?? 0, trees: data.trees?.length ?? 0, exactVegetation: exactVegetationPlan?.renderedCount ?? 0, understory: data.understory?.length ?? 0, rocks: data.rocks?.length ?? 0, water: data.water?.length ?? 0, floorSurfaces: data.floorSurfaces?.length ?? 0 },
      floorSurfaces: { ...surfaceRenderStats, stableIds: [...new Set(surfaceRenderStats.stableIds)] },
      groundcover: { ...understoryRenderStats },
      railway: { ...railwayRenderStats },
      water: { ...waterRenderStats },
      bridges: { ...bridgeRenderStats, local: localBridgeStatus },
      walls: { ...wallRenderStats, unclassifiedPathProps: [...unclassifiedPathProps] },
      buildings: buildingStatsNow(),
      buildingArchetypes: buildingDetail
        ? { ...buildingDetail.byArchetype, roofForms: { ...buildingDetail.roofCensus }, programs: { ...buildingDetail.programCensus } }
        : null,
    }),
    dispose: () => {
      stopped = true;
      clearInterval(vegetationChipInterval);
      if (profilePanelInterval) clearInterval(profilePanelInterval);
      frameProfiler = null;
      profilePanel = null;
      localTerrainAbort.abort();
      authoredStreamer.dispose();
      authoredAbort.abort();
      authoredGuard.dispose();
      authoredLoaderHost.dispose();
      authoredAssetCache.clear();
      if (controlNotify) cancelAnimationFrame(controlNotify);
      if (vegetationRepackFrame) cancelAnimationFrame(vegetationRepackFrame);
      // Recorded BEFORE the runtime is released, because `renderStats()` outlives this call — the
      // api object is still reachable by whoever held it. Without this flag a disposed view is
      // indistinguishable from a mount that has not started, and its placement sum silently loses
      // the authored half's two terms instead of reporting that it cannot read them.
      vegetationStatus.disposed = true;
      authoredVegetationRuntime?.dispose();
      authoredVegetationRuntime = null;
      authoredVegetationArrays?.dispose();
      authoredVegetationArrays = null;
      resize.disconnect(); controls.dispose(); renderer.dispose();
      disposeTree(worldRoot); disposeTree(authoredRoot, { materials: true }); disposeTree(dynamicRoot);
      for (const material of [...Object.values(materials), ...buildingMaterials.values(), ...propMaterials.values()]) material?.dispose?.();
      if (exactTerrainPbrRuntime) exactTerrainPbrRuntime.dispose();
      else for (const material of exactTerrainMaterials.values()) material?.dispose?.();
      for (const texture of exactSurfaceTextures.values()) texture?.dispose?.();
      for (const texture of Object.values(textures)) texture?.dispose?.();
      chainLinkTexture?.dispose?.();
      if (container.__tz3d === api) delete container.__tz3d;
      container.replaceChildren();
    },
  };
  Object.defineProperty(container, '__tz3d', { value: api, configurable: true });
  return api;
}
