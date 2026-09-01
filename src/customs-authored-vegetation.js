/**
 * Atomic runtime adapter for the independently-authored Customs vegetation pack.
 *
 * The exact local vegetation package remains the only owner of placement truth. This adapter
 * consumes its already-scoped render plan and the pack's small authored-asset/binding catalog;
 * it deliberately ignores the offline pack's duplicate `placements` audit list.
 *
 * Coordinate contract:
 *   EFT/Unity point -> Three Z-up point: [-x, -z, y]
 *   authored GLB: +Y up, +Z forward, base-centre pivot
 *
 * That point conversion changes handedness. Three.js InstancedMesh does not support a negative
 * instance scale, so the fixed X reflection is baked once into each cloned primitive (including
 * the GLTF child transform and corrected triangle winding). Every instance matrix then has a
 * positive determinant: T * Rz(-yaw) * Rx(+90deg) * S(width, height, width).
 */

import * as THREE from 'three/webgpu';
import { attribute, normalMap, texture, uv } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { customsVegetationProxyDimensions } from './customs-local-vegetation-render.js';
import {
  CUSTOMS_VEGETATION_LAYER_ATTRIBUTE,
  applyCustomsVegetationLayerAttributes,
} from './customs-vegetation-texture-arrays.js';

export const CUSTOMS_AUTHORED_VEGETATION_EXPECTED_ASSETS = 31;
export const CUSTOMS_AUTHORED_VEGETATION_EXPECTED_BINDINGS = 58;

/**
 * There is no spatial cell grid any more.
 *
 * The former `CUSTOMS_AUTHORED_VEGETATION_CELL_SIZE_M = 128` opened one `InstancedMesh` per
 * (cell x prototype x material), which multiplied the batch count by 703 prototype-cells and put
 * the measured draw call count at 1,333 (floor) to 2,016 (ceiling) — see
 * docs/plans/VEGETATION-DRAWCALLS.md §3c. Batching per (family, LOD) instead gives a hard
 * structural ceiling of 31 families x 3 LOD tiers = 93 objects, and moves LOD selection and
 * frustum rejection from per-cell to per-instance, which is strictly finer on both axes.
 */
export const CUSTOMS_AUTHORED_VEGETATION_BUCKET_CEILING = CUSTOMS_AUTHORED_VEGETATION_EXPECTED_ASSETS * 3;

export const CUSTOMS_AUTHORED_VEGETATION_LOD_POLICY = Object.freeze({
  nearMaxM: 110,
  mediumMaxM: 280,
  hysteresisM: 20,
});

export const CUSTOMS_AUTHORED_VEGETATION_SHADOW_POLICY = Object.freeze({
  mode: 'disabled',
  receive: true,
});

export const CUSTOMS_AUTHORED_VEGETATION_ALPHA_POLICY = Object.freeze({
  blend: 'report',
});

const GLB_FRAME = Object.freeze({
  unit: 'metre',
  upAxis: '+y',
  forwardAxis: '+z',
  pivot: 'base-center',
});
const LODS = Object.freeze([0, 1, 2]);
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
/**
 * The adapter's own single source of truth for a legal authored-asset path. Exported so the
 * dev-only vegetation serving route (scripts/lib/vegetation-authored-dev.mjs) can authorize
 * requests against exactly the same file shapes this adapter will ever ask for, instead of
 * re-deriving the pattern independently and risking drift.
 */
export const SAFE_ASSET_FILE = /^assets\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+-lod[0-2]\.glb$/u;
const BINDING_SEPARATOR = '\u0000';
const GEOMETRY_X_REFLECTION = new THREE.Matrix4().makeScale(-1, 1, 1);
const GLB_Y_UP_TO_WORLD_Z_UP = new THREE.Matrix4().makeRotationX(Math.PI / 2);

export class CustomsAuthoredVegetationContractError extends Error {
  constructor(message, code = 'ERR_CUSTOMS_AUTHORED_VEGETATION_CONTRACT', details = null) {
    super(message);
    this.name = 'CustomsAuthoredVegetationContractError';
    this.code = code;
    this.details = details;
  }
}

export class CustomsAuthoredVegetationAbort extends Error {
  constructor(message = 'Customs authored vegetation loading was aborted.', cause = undefined) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AbortError';
    this.code = 'ERR_CUSTOMS_AUTHORED_VEGETATION_ABORT';
  }
}

function fail(message, code, details) {
  throw new CustomsAuthoredVegetationContractError(message, code, details);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function text(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    fail(`${label} must be a non-empty exact string`);
  }
  if (value.includes(BINDING_SEPARATOR)) fail(`${label} contains a reserved character`);
  return value;
}

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) fail(`${label} must be finite`);
  return Object.is(number, -0) ? 0 : number;
}

function positive(value, label) {
  const number = finite(value, label);
  if (!(number > 0)) fail(`${label} must be greater than zero`);
  return number;
}

function safeInteger(value, label, { positive: mustBePositive = false } = {}) {
  if (!Number.isSafeInteger(value) || (mustBePositive && value <= 0)) {
    fail(`${label} must be ${mustBePositive ? 'a positive' : 'a'} safe integer`);
  }
  return value;
}

function bindingKey(tileId, prototypeId) {
  return `${tileId}${BINDING_SEPARATOR}${prototypeId}`;
}

function nullRecord(entries) {
  const result = Object.create(null);
  for (const [key, value] of entries) result[key] = value;
  return Object.freeze(result);
}

function normalizeLod(raw, assetId, index) {
  const lod = object(raw, `authoredAssets:${assetId}.lods[${index}]`);
  const level = safeInteger(lod.lod, `authoredAssets:${assetId}.lods[${index}].lod`);
  if (!LODS.includes(level)) fail(`authored asset ${assetId} declares unsupported LOD ${level}`);
  const file = text(lod.file, `authoredAssets:${assetId}.lods[${index}].file`);
  if (!SAFE_ASSET_FILE.test(file) || file.includes('..') || file.includes('\\')) {
    fail(`authored asset ${assetId} has an unsafe LOD file`, undefined, { file });
  }
  const sha256 = text(lod.sha256, `authoredAssets:${assetId}.lods[${index}].sha256`);
  if (!SHA256.test(sha256)) fail(`authored asset ${assetId} has an invalid SHA-256 receipt`);
  return Object.freeze({
    lod: level,
    file,
    bytes: safeInteger(lod.bytes, `authoredAssets:${assetId}.lods[${index}].bytes`, { positive: true }),
    sha256,
    triangles: safeInteger(lod.triangles, `authoredAssets:${assetId}.lods[${index}].triangles`),
  });
}

/**
 * Validate and compact the authored-assets/bindings portion of the offline pack index.
 * `packIndex.placements` is intentionally neither inspected nor retained.
 */
export function normalizeCustomsAuthoredVegetationCatalog(packIndex) {
  const source = object(packIndex, 'packIndex');
  if (source.map !== 'customs') fail('authored vegetation pack must target Customs');
  const runtimeContract = object(source.runtimeContract, 'packIndex.runtimeContract');
  if (runtimeContract.collision !== 'none') fail('authored vegetation collision must remain none');
  if (runtimeContract.exactScalarPlacement !== true) {
    fail('authored vegetation pack must declare exact scalar placement');
  }

  if (!Array.isArray(source.authoredAssets) || source.authoredAssets.length === 0) {
    fail('packIndex.authoredAssets must be a non-empty array');
  }
  const assets = [];
  const assetsByIdEntries = [];
  const assetsByNameEntries = [];
  const seenIds = new Set();
  const seenNames = new Set();
  for (let index = 0; index < source.authoredAssets.length; index += 1) {
    const raw = object(source.authoredAssets[index], `packIndex.authoredAssets[${index}]`);
    const assetId = text(raw.assetId, `packIndex.authoredAssets[${index}].assetId`);
    const prototypeName = text(raw.prototypeName, `packIndex.authoredAssets[${index}].prototypeName`);
    if (!assetId.startsWith('customs.vegetation.')) fail(`invalid Customs vegetation asset id ${assetId}`);
    if (seenIds.has(assetId)) fail(`duplicate authored vegetation asset id ${assetId}`);
    if (seenNames.has(prototypeName)) fail(`duplicate authored vegetation prototype ${prototypeName}`);
    if (raw.collision !== 'none') fail(`authored vegetation asset ${assetId} must have collision none`);
    const frame = object(raw.gltf, `authoredAssets:${assetId}.gltf`);
    for (const [key, expected] of Object.entries(GLB_FRAME)) {
      if (frame[key] !== expected) fail(`authored vegetation asset ${assetId} has unsupported GLTF ${key}`);
    }
    if (!Array.isArray(raw.lods) || raw.lods.length !== LODS.length) {
      fail(`authored vegetation asset ${assetId} must declare LOD0, LOD1, and LOD2`);
    }
    const lods = raw.lods.map((lod, lodIndex) => normalizeLod(lod, assetId, lodIndex));
    lods.sort((a, b) => a.lod - b.lod);
    if (!LODS.every((level, lodIndex) => lods[lodIndex]?.lod === level)) {
      fail(`authored vegetation asset ${assetId} does not declare each required LOD exactly once`);
    }
    const asset = Object.freeze({
      assetId,
      prototypeName,
      collision: 'none',
      geometryEvidence: String(raw.geometryEvidence ?? 'original authored approximation'),
      lods: Object.freeze(lods),
    });
    seenIds.add(assetId);
    seenNames.add(prototypeName);
    assets.push(asset);
    assetsByIdEntries.push([assetId, asset]);
    assetsByNameEntries.push([prototypeName, asset]);
  }
  assets.sort((a, b) => a.assetId.localeCompare(b.assetId));
  const assetsById = nullRecord(assetsByIdEntries);
  const assetsByName = nullRecord(assetsByNameEntries);

  if (!Array.isArray(source.prototypeBindings) || source.prototypeBindings.length === 0) {
    fail('packIndex.prototypeBindings must be a non-empty array');
  }
  const bindings = [];
  const bindingsByKeyEntries = [];
  const seenBindings = new Set();
  for (let index = 0; index < source.prototypeBindings.length; index += 1) {
    const raw = object(source.prototypeBindings[index], `packIndex.prototypeBindings[${index}]`);
    const tileId = text(raw.tileId, `packIndex.prototypeBindings[${index}].tileId`);
    const prototypeId = text(raw.prototypeId, `packIndex.prototypeBindings[${index}].prototypeId`);
    const prototypeName = text(raw.prototypeName, `packIndex.prototypeBindings[${index}].prototypeName`);
    const assetId = text(raw.assetId, `packIndex.prototypeBindings[${index}].assetId`);
    const asset = assetsById[assetId];
    if (!asset) fail(`prototype binding ${prototypeId} references unknown asset ${assetId}`);
    if (asset.prototypeName !== prototypeName) {
      fail(`prototype binding ${prototypeId} name does not match authored asset ${assetId}`);
    }
    const key = bindingKey(tileId, prototypeId);
    if (seenBindings.has(key)) fail(`duplicate authored vegetation binding ${tileId}/${prototypeId}`);
    seenBindings.add(key);
    const binding = Object.freeze({ tileId, prototypeId, prototypeName, assetId });
    bindings.push(binding);
    bindingsByKeyEntries.push([key, binding]);
  }
  bindings.sort((a, b) => bindingKey(a.tileId, a.prototypeId)
    .localeCompare(bindingKey(b.tileId, b.prototypeId)));

  if (source.counts?.authoredAssets !== undefined
    && source.counts.authoredAssets !== assets.length) {
    fail('packIndex counts.authoredAssets does not match authoredAssets');
  }
  if (source.counts?.tilePrototypeBindings !== undefined
    && source.counts.tilePrototypeBindings !== bindings.length) {
    fail('packIndex counts.tilePrototypeBindings does not match prototypeBindings');
  }

  return Object.freeze({
    map: 'customs',
    status: String(source.status ?? 'unspecified'),
    collision: 'none',
    geometry: String(runtimeContract.geometry ?? 'original authored approximation'),
    exactScalarPlacement: true,
    livePromotion: runtimeContract.livePromotion === true,
    assets: Object.freeze(assets),
    bindings: Object.freeze(bindings),
    assetsById,
    assetsByName,
    bindingsByKey: nullRecord(bindingsByKeyEntries),
    // Coverage is reported, not inferred from the offline placement mirror.
    currentFactoryCoverage: Object.freeze({
      expectedAssets: CUSTOMS_AUTHORED_VEGETATION_EXPECTED_ASSETS,
      expectedBindings: CUSTOMS_AUTHORED_VEGETATION_EXPECTED_BINDINGS,
      assets: assets.length,
      bindings: bindings.length,
      complete: assets.length === CUSTOMS_AUTHORED_VEGETATION_EXPECTED_ASSETS
        && bindings.length === CUSTOMS_AUTHORED_VEGETATION_EXPECTED_BINDINGS,
    }),
  });
}

/** Resolve one exact tile/prototype identity. No fuzzy name or family fallback is allowed. */
export function resolveCustomsAuthoredVegetationBinding(catalog, placement) {
  const tileId = text(placement?.tileId, 'placement.tileId');
  const prototypeId = text(placement?.prototypeId, 'placement.prototypeId');
  const prototypeName = text(placement?.prototypeName, 'placement.prototypeName');
  const binding = catalog?.bindingsByKey?.[bindingKey(tileId, prototypeId)];
  if (!binding) {
    fail(
      `unsupported Customs vegetation prototype ${tileId}/${prototypeId}`,
      'ERR_CUSTOMS_VEGETATION_UNSUPPORTED_PROTOTYPE',
      { tileId, prototypeId, prototypeName },
    );
  }
  if (binding.prototypeName !== prototypeName) {
    fail(
      `prototype identity mismatch for ${tileId}/${prototypeId}: expected ${binding.prototypeName}, received ${prototypeName}`,
      'ERR_CUSTOMS_VEGETATION_PROTOTYPE_IDENTITY_MISMATCH',
      { tileId, prototypeId, prototypeName, expectedPrototypeName: binding.prototypeName },
    );
  }
  const asset = catalog.assetsById[binding.assetId];
  if (!asset) fail(`binding ${tileId}/${prototypeId} lost asset ${binding.assetId}`);
  return Object.freeze({ binding, asset });
}

/**
 * Non-throwing identity probe for one exact tile/prototype placement.
 *
 * `resolveCustomsAuthoredVegetationBinding` throws on an unsupported prototype, which is correct
 * for the single-source runtime but unusable for a router that must partition one plan into
 * authored and procedural halves. This probe returns `{ binding, asset, nameMatches }` when the
 * tile/prototype pair is in the catalog and `null` otherwise. It never throws; a `nameMatches`
 * of `false` still exposes the identity mismatch so the caller can fail closed.
 */
export function probeCustomsAuthoredVegetationBinding(catalog, placement) {
  const tileId = placement?.tileId;
  const prototypeId = placement?.prototypeId;
  const prototypeName = placement?.prototypeName;
  if (typeof tileId !== 'string' || typeof prototypeId !== 'string'
    || typeof prototypeName !== 'string') {
    return null;
  }
  if (tileId.length === 0 || prototypeId.length === 0 || prototypeName.length === 0
    || tileId.includes(BINDING_SEPARATOR) || prototypeId.includes(BINDING_SEPARATOR)
    || prototypeName.includes(BINDING_SEPARATOR)) {
    return null;
  }
  const binding = catalog?.bindingsByKey?.[bindingKey(tileId, prototypeId)];
  if (!binding) return null;
  const asset = catalog?.assetsById?.[binding.assetId];
  if (!asset) return null;
  return Object.freeze({
    binding,
    asset,
    nameMatches: binding.prototypeName === prototypeName,
  });
}

/**
 * Recover a placement's `prototypeName` by joining it to the catalog's `prototypeBindings` on the
 * exact `(tileId, prototypeId)` pair.
 *
 * The offline pack's own `placements[]` rows carry only
 * `{ assetId, instanceIndex, placementOrdinal, prototypeId, tileId }` — no `prototypeName` — so
 * feeding them straight into `probeCustomsAuthoredVegetationBinding()` makes every one of the
 * 8,805 rows return `null`, which reads as "0 admitted" rather than as the missing-field error it
 * really is. `prototypeBindings[]` is the document that owns the name, and `(tileId, prototypeId)`
 * is its primary key, so the join is exact and total: 8,805/8,805 resolve with 0 unbound.
 *
 * The live runtime does not need this — `buildCustomsLocalVegetationRenderPlan` already carries
 * `prototypeName` from the local package's own per-tile `prototypes` table, which is the source
 * of placement truth and is never the pack's duplicate mirror. This exists so any caller holding
 * bare `(tileId, prototypeId)` rows joins them the one correct way instead of guessing, and it
 * fails closed rather than inventing a name.
 *
 * @returns {string|null} the exact bound prototype name, or `null` when the pair is unbound.
 */
export function resolveCustomsAuthoredVegetationPrototypeName(catalog, placement) {
  const tileId = placement?.tileId;
  const prototypeId = placement?.prototypeId;
  if (typeof tileId !== 'string' || typeof prototypeId !== 'string') return null;
  if (tileId.length === 0 || prototypeId.length === 0) return null;
  if (tileId.includes(BINDING_SEPARATOR) || prototypeId.includes(BINDING_SEPARATOR)) return null;
  const binding = catalog?.bindingsByKey?.[bindingKey(tileId, prototypeId)];
  return binding ? binding.prototypeName : null;
}

/**
 * Return a placement that is guaranteed to expose `prototypeName`, joining it in from
 * `prototypeBindings` when the row does not already carry one.
 *
 * A row that already has a name is returned untouched — the join never overwrites a declared
 * identity, because a disagreement between a declared name and its binding is a contract failure
 * the resolver and the router must still see and reject, not something to silently paper over.
 */
export function joinCustomsAuthoredVegetationPrototypeName(catalog, placement) {
  if (typeof placement?.prototypeName === 'string' && placement.prototypeName.length > 0) {
    return placement;
  }
  const prototypeName = resolveCustomsAuthoredVegetationPrototypeName(catalog, placement);
  if (prototypeName === null) return placement;
  return { ...placement, prototypeName };
}

/**
 * Recover the exact authored width/height multipliers from the current plan.
 *
 * Newer plans may carry the raw values directly. The existing plan carries exact scaled proxy
 * width/height, so the same deterministic nominal envelope is divided out without approximation.
 */
export function resolveCustomsAuthoredVegetationScale(placement) {
  const hasWidth = placement?.widthScale !== undefined;
  const hasHeight = placement?.heightScale !== undefined;
  const nominal = customsVegetationProxyDimensions({
    prototypeName: placement?.prototypeName,
    classification: placement?.classification,
    widthScale: 1,
    heightScale: 1,
  });
  const inferredWidth = placement?.dimensions?.width === undefined
    ? null
    : positive(placement.dimensions.width, 'placement.dimensions.width') / nominal.width;
  const inferredHeight = placement?.dimensions?.height === undefined
    ? null
    : positive(placement.dimensions.height, 'placement.dimensions.height') / nominal.height;
  const widthScale = hasWidth
    ? positive(placement.widthScale, 'placement.widthScale')
    : inferredWidth;
  const heightScale = hasHeight
    ? positive(placement.heightScale, 'placement.heightScale')
    : inferredHeight;
  if (!(widthScale > 0) || !(heightScale > 0)) {
    fail('placement must expose exact widthScale/heightScale or exact proxy dimensions');
  }
  const close = (a, b) => Math.abs(a - b) <= Math.max(1e-8, Math.abs(a) * 1e-7);
  if (hasWidth && inferredWidth !== null && !close(widthScale, inferredWidth)) {
    fail('placement.widthScale disagrees with its exact proxy dimensions');
  }
  if (hasHeight && inferredHeight !== null && !close(heightScale, inferredHeight)) {
    fail('placement.heightScale disagrees with its exact proxy dimensions');
  }
  return Object.freeze({
    widthScale,
    heightScale,
    source: hasWidth && hasHeight
      ? 'exact-plan-scalars'
      : hasWidth || hasHeight ? 'mixed-exact-scalars-and-derived-envelope' : 'exact-plan-envelope-ratio',
  });
}

function normalizedPlacement(placement, catalog) {
  const { binding, asset } = resolveCustomsAuthoredVegetationBinding(catalog, placement);
  if (!Array.isArray(placement.presentationPosition) || placement.presentationPosition.length !== 3) {
    fail('placement.presentationPosition must be a three-component array');
  }
  const presentationPosition = Object.freeze(placement.presentationPosition.map((value, index) => (
    finite(value, `placement.presentationPosition[${index}]`)
  )));
  const tint = object(placement.tint, 'placement.tint');
  const normalizedTint = Object.freeze({
    r: finite(tint.r, 'placement.tint.r'),
    g: finite(tint.g, 'placement.tint.g'),
    b: finite(tint.b, 'placement.tint.b'),
  });
  if (Object.values(normalizedTint).some((channel) => channel < 0 || channel > 1)) {
    fail('placement tint channels must be normalized');
  }
  const flatIndex = safeInteger(placement.flatIndex, 'placement.flatIndex');
  const classification = text(placement.classification, 'placement.classification');
  const scale = resolveCustomsAuthoredVegetationScale(placement);
  // Per-instance frustum rejection needs one bounding sphere per placement, and it has to be a
  // sphere the authored GLB actually fits inside. The authored bake matches
  // `customsVegetationProxyDimensions` exactly at scale 1 with a base-centre pivot at y = 0
  // (measured; that is what makes the proxy -> authored swap size-preserving), so the exact
  // upright box is height x width x width standing on the placement origin, and the smallest
  // sphere containing it is centred at height/2 with radius hypot(height/2, width/sqrt(2)).
  const dimensions = customsVegetationProxyDimensions({
    prototypeName: binding.prototypeName,
    classification,
    widthScale: scale.widthScale,
    heightScale: scale.heightScale,
  });
  const halfHeight = dimensions.height / 2;
  const halfDiagonal = (dimensions.width / 2) * Math.SQRT2;
  return Object.freeze({
    flatIndex,
    tileId: binding.tileId,
    prototypeId: binding.prototypeId,
    prototypeName: binding.prototypeName,
    classification,
    assetId: asset.assetId,
    asset,
    presentationPosition,
    yawRadians: finite(placement.yawRadians ?? 0, 'placement.yawRadians'),
    tint: normalizedTint,
    scale,
    boundsCenterZOffsetM: halfHeight,
    boundsRadiusM: Math.hypot(halfHeight, halfDiagonal),
  });
}

/** Compile the exact render plan into deterministic per-authored-prototype instance groups. */
export function planCustomsAuthoredVegetationInstances(plan, catalog) {
  const source = object(plan, 'plan');
  const groups = object(source.groups, 'plan.groups');
  const placements = [];
  for (const classification of Object.keys(groups).sort()) {
    if (!Array.isArray(groups[classification])) fail(`plan.groups.${classification} must be an array`);
    for (const placement of groups[classification]) {
      if (placement?.classification !== classification) {
        fail(`plan.groups.${classification} contains a ${placement?.classification ?? '(missing)'} placement`);
      }
      placements.push(normalizedPlacement(placement, catalog));
    }
  }
  placements.sort((a, b) => a.flatIndex - b.flatIndex
    || a.tileId.localeCompare(b.tileId)
    || a.prototypeId.localeCompare(b.prototypeId));
  const seen = new Set();
  for (const placement of placements) {
    if (placement.flatIndex < 0) fail('placement.flatIndex must be non-negative');
    if (seen.has(placement.flatIndex)) fail(`duplicate exact vegetation flat index ${placement.flatIndex}`);
    seen.add(placement.flatIndex);
  }
  if (source.renderedCount !== undefined && source.renderedCount !== placements.length) {
    fail('plan.renderedCount does not match the exact placement groups');
  }

  const grouped = new Map();
  for (const placement of placements) {
    const existing = grouped.get(placement.assetId);
    if (existing) existing.placements.push(placement);
    else grouped.set(placement.assetId, { asset: placement.asset, placements: [placement] });
  }
  const assetGroups = [...grouped.values()]
    .sort((a, b) => a.asset.assetId.localeCompare(b.asset.assetId))
    .map((entry) => Object.freeze({
      asset: entry.asset,
      placements: Object.freeze(entry.placements),
    }));
  const scaleSources = {};
  for (const placement of placements) {
    scaleSources[placement.scale.source] = (scaleSources[placement.scale.source] ?? 0) + 1;
  }
  const sourceCount = safeInteger(source.sourceCount ?? placements.length, 'plan.sourceCount');
  const culledCount = safeInteger(source.culledCount ?? 0, 'plan.culledCount');
  if (sourceCount < 0 || culledCount < 0) fail('plan source/culled counts must be non-negative');
  if (sourceCount !== placements.length + culledCount) {
    fail('plan.sourceCount must equal rendered placements plus plan.culledCount');
  }
  // Classification counts are recomputed from the groups, never trusted from the plan's own
  // `counts` mirror. The mirror is only cross-checked per classification, in both directions,
  // so a plan whose `counts` disagrees with its `groups` cannot slip through on a matching sum.
  const counts = {};
  for (const classification of Object.keys(groups).sort()) {
    counts[classification] = groups[classification].length;
  }
  if (source.counts !== undefined) {
    const supplied = object(source.counts, 'plan.counts');
    const suppliedKeys = new Set(Object.keys(supplied));
    for (const classification of Object.keys(counts)) {
      if (!suppliedKeys.has(classification)) {
        fail(`plan.counts is missing classification ${classification}`);
      }
    }
    for (const classification of Object.keys(supplied)) {
      const count = supplied[classification];
      if (!Number.isSafeInteger(count) || count < 0) {
        fail(`plan.counts.${classification} must be non-negative`);
      }
      if (counts[classification] === undefined) {
        fail(`plan.counts declares unknown classification ${classification}`);
      }
      if (count !== counts[classification]) {
        fail(`plan.counts.${classification} does not match plan.groups.${classification}`);
      }
    }
  }
  return Object.freeze({
    sourceCount,
    renderedCount: placements.length,
    culledCount,
    counts: Object.freeze(counts),
    placements: Object.freeze(placements),
    assetGroups: Object.freeze(assetGroups),
    scaleSources: Object.freeze(scaleSources),
  });
}

function normalizedLodPolicy(policy) {
  const source = object(policy, 'LOD policy');
  const nearMaxM = positive(source.nearMaxM, 'LOD policy.nearMaxM');
  const mediumMaxM = positive(source.mediumMaxM, 'LOD policy.mediumMaxM');
  const hysteresisM = finite(source.hysteresisM, 'LOD policy.hysteresisM');
  if (hysteresisM < 0) fail('LOD policy.hysteresisM must be non-negative');
  if (!(nearMaxM < mediumMaxM)) fail('LOD policy near threshold must be below medium threshold');
  if (!(nearMaxM + hysteresisM < mediumMaxM - hysteresisM)) {
    fail('LOD hysteresis bands must not overlap');
  }
  return { nearMaxM, mediumMaxM, hysteresisM };
}

/** Select one spatial cell's vegetation LOD with deterministic hysteresis around both seams. */
export function selectCustomsAuthoredVegetationLod(
  cameraDistanceM,
  previousLod = null,
  policy = CUSTOMS_AUTHORED_VEGETATION_LOD_POLICY,
) {
  const distance = finite(cameraDistanceM, 'cameraDistanceM');
  if (distance < 0) fail('cameraDistanceM must be non-negative');
  const { nearMaxM, mediumMaxM, hysteresisM } = normalizedLodPolicy(policy);
  if (previousLod === null || previousLod === undefined) {
    return distance <= nearMaxM ? 0 : distance <= mediumMaxM ? 1 : 2;
  }
  if (!LODS.includes(previousLod)) fail(`previousLod must be 0, 1, or 2`);
  if (previousLod === 0) {
    if (distance <= nearMaxM + hysteresisM) return 0;
    return distance <= mediumMaxM + hysteresisM ? 1 : 2;
  }
  if (previousLod === 1) {
    if (distance < nearMaxM - hysteresisM) return 0;
    if (distance > mediumMaxM + hysteresisM) return 2;
    return 1;
  }
  if (distance < nearMaxM - hysteresisM) return 0;
  if (distance < mediumMaxM - hysteresisM) return 1;
  return 2;
}

function normalizedCameraWorldPosition(value) {
  if (!Array.isArray(value) || value.length !== 3) {
    fail('cameraWorldPosition must be a Three-world [x, y, z] array');
  }
  return Object.freeze(value.map((component, index) => (
    finite(component, `cameraWorldPosition[${index}]`)
  )));
}

export function customsAuthoredVegetationBucketKey(assetId, lod) {
  return `${assetId}${BINDING_SEPARATOR}${lod}`;
}

/**
 * Previous per-instance LOD state, index-aligned with `compiledPlan.placements`.
 *
 * Index-aligned rather than keyed by `flatIndex` on purpose: `planCustomsAuthoredVegetationInstances`
 * already sorts placements into one deterministic order, so ordinal position is a stable identity,
 * and a typed array of 8,805 entries costs 8.8 kB and no hashing. `-1` means "no previous LOD"
 * (first partition, or a placement whose state was never recorded) and selects the un-hystereticised
 * branch, which is exactly what a cold start should do.
 */
function normalizedPreviousLods(value, length) {
  if (value === null || value === undefined) return null;
  const isTyped = ArrayBuffer.isView(value) && typeof value.length === 'number';
  if (!isTyped && !Array.isArray(value)) fail('previousLods must be an array index-aligned with the placements');
  if (value.length !== length) fail('previousLods must have exactly one entry per compiled placement');
  for (let index = 0; index < value.length; index += 1) {
    const lod = value[index];
    if (lod !== -1 && !LODS.includes(lod)) fail(`previousLods[${index}] is not -1, 0, 1, or 2`);
  }
  return value;
}

/**
 * Partition exact placements into one bucket per (authored family, LOD), with per-instance LOD
 * selection and optional per-instance frustum rejection.
 *
 * This replaces the 128 m spatial cell grid. The bucket count has a hard structural ceiling of
 * `families x 3` — 93 for the complete pack — and does not depend on how the placements are spread
 * across the map, which is the whole reason the cell grid had to go: at 128 m, 136 of its 703
 * prototype-cells held exactly one instance and 260 held fewer than four, so most of its batches
 * were carrying nothing.
 *
 * LOD is selected for EVERY placement, including ones the frustum rejects, so the returned `lods`
 * can be fed straight back in as `previousLods` and hysteresis stays coherent across a camera move
 * that swings something out of view and back.
 *
 * `frustum` is anything exposing `intersectsSphere(sphere)` — a `THREE.Frustum` is the intended
 * caller. Pass `null` to admit everything.
 */
export function partitionCustomsAuthoredVegetationByLod(compiledPlan, {
  cameraWorldPosition,
  previousLods = null,
  lodPolicy = CUSTOMS_AUTHORED_VEGETATION_LOD_POLICY,
  frustum = null,
} = {}) {
  const compiled = object(compiledPlan, 'compiledPlan');
  if (!Array.isArray(compiled.placements)) fail('compiledPlan.placements must be an array');
  const placements = compiled.placements;
  const camera = normalizedCameraWorldPosition(cameraWorldPosition);
  const policy = Object.freeze(normalizedLodPolicy(lodPolicy));
  const previous = normalizedPreviousLods(previousLods, placements.length);
  if (frustum !== null && typeof frustum?.intersectsSphere !== 'function') {
    fail('frustum must expose intersectsSphere(sphere)');
  }
  const sphere = frustum ? new THREE.Sphere() : null;

  const lods = new Int8Array(placements.length);
  const bucketsByKey = new Map();
  const lodInstanceCounts = { 0: 0, 1: 0, 2: 0 };
  const lodVisibleCounts = { 0: 0, 1: 0, 2: 0 };
  let visibleInstances = 0;
  let frustumCulledInstances = 0;

  for (let index = 0; index < placements.length; index += 1) {
    const placement = placements[index];
    const worldX = placement.presentationPosition[0];
    const worldY = placement.presentationPosition[1];
    const worldZ = placement.presentationPosition[2];
    const centreZ = worldZ + placement.boundsCenterZOffsetM;
    const distance = Math.hypot(camera[0] - worldX, camera[1] - worldY, camera[2] - centreZ);
    const lod = selectCustomsAuthoredVegetationLod(
      distance,
      previous === null || previous[index] === -1 ? null : previous[index],
      policy,
    );
    lods[index] = lod;
    lodInstanceCounts[lod] += 1;
    if (sphere) {
      sphere.center.set(worldX, worldY, centreZ);
      sphere.radius = placement.boundsRadiusM;
      if (!frustum.intersectsSphere(sphere)) {
        frustumCulledInstances += 1;
        continue;
      }
    }
    visibleInstances += 1;
    lodVisibleCounts[lod] += 1;
    const key = customsAuthoredVegetationBucketKey(placement.assetId, lod);
    let bucket = bucketsByKey.get(key);
    if (!bucket) {
      bucket = { key, asset: placement.asset, assetId: placement.assetId, lod, indices: [] };
      bucketsByKey.set(key, bucket);
    }
    // `placements` is already in ascending deterministic order, so pushing keeps every bucket
    // ordered without a sort — which is what makes a full repack cheap enough to run inline.
    bucket.indices.push(index);
  }

  // Deliverable invariant, asserted in code rather than only in a test: every exact placement is
  // either in exactly one bucket or was rejected by the frustum. Nothing is duplicated or lost.
  if (visibleInstances + frustumCulledInstances !== placements.length) {
    fail('authored vegetation LOD partition duplicated or lost exact placements');
  }
  if (placements.length !== compiled.renderedCount) {
    fail('compiledPlan.placements does not match compiledPlan.renderedCount');
  }
  let bucketedInstances = 0;
  for (const bucket of bucketsByKey.values()) bucketedInstances += bucket.indices.length;
  if (bucketedInstances !== visibleInstances) {
    fail('authored vegetation bucket totals disagree with the visible placement count');
  }

  const buckets = [...bucketsByKey.values()]
    .sort((a, b) => a.assetId.localeCompare(b.assetId) || a.lod - b.lod)
    .map((bucket) => Object.freeze({
      key: bucket.key,
      asset: bucket.asset,
      assetId: bucket.assetId,
      lod: bucket.lod,
      indices: Object.freeze(bucket.indices),
      instances: bucket.indices.length,
    }));

  return Object.freeze({
    cameraWorldPosition: camera,
    lodPolicy: policy,
    buckets: Object.freeze(buckets),
    bucketCount: buckets.length,
    lods,
    visibleInstances,
    frustumCulledInstances,
    sourceInstances: placements.length,
    frustumCullingApplied: frustum !== null,
    lodInstanceCounts: Object.freeze(lodInstanceCounts),
    lodVisibleCounts: Object.freeze(lodVisibleCounts),
  });
}

/** Positive-determinant matrix stored in InstancedMesh after the fixed reflection is baked. */
export function customsAuthoredVegetationInstanceMatrix(placement) {
  const scale = placement.scale ?? resolveCustomsAuthoredVegetationScale(placement);
  if (!Array.isArray(placement.presentationPosition) || placement.presentationPosition.length !== 3) {
    fail('placement.presentationPosition must be a three-component array');
  }
  const position = placement.presentationPosition.map((value, index) => (
    finite(value, `placement.presentationPosition[${index}]`)
  ));
  const yaw = finite(placement.yawRadians ?? 0, 'placement.yawRadians');
  return new THREE.Matrix4()
    .makeTranslation(...position)
    .multiply(new THREE.Matrix4().makeRotationZ(-yaw))
    .multiply(GLB_Y_UP_TO_WORLD_Z_UP)
    .multiply(new THREE.Matrix4().makeScale(
      positive(scale.widthScale, 'placement scale.widthScale'),
      positive(scale.heightScale, 'placement scale.heightScale'),
      positive(scale.widthScale, 'placement scale.widthScale'),
    ));
}

/** Full mathematical source-vertex matrix, useful for deterministic coordinate verification. */
export function customsAuthoredVegetationWorldMatrix(
  placement,
  childMatrix = new THREE.Matrix4(),
) {
  if (!childMatrix?.isMatrix4) fail('childMatrix must be a Three.Matrix4');
  return customsAuthoredVegetationInstanceMatrix(placement)
    .multiply(GEOMETRY_X_REFLECTION)
    .multiply(childMatrix);
}

function resolveAssetUrl(baseUrl, file, pageUrl) {
  const base = text(baseUrl, 'baseUrl');
  if (/[?#]/u.test(base)) fail('baseUrl must not include query or fragment state');
  let page;
  try {
    page = new URL(text(pageUrl, 'pageUrl'));
  } catch {
    fail('pageUrl must be an absolute URL');
  }
  if (!['http:', 'https:'].includes(page.protocol) || page.username || page.password) {
    fail('pageUrl must be an uncredentialed HTTP(S) URL');
  }
  const baseWithSlash = `${base.replace(/\/+$/u, '')}/`;
  const resolvedBase = new URL(baseWithSlash, page);
  const resolved = new URL(file, resolvedBase);
  if (resolvedBase.origin !== page.origin || resolved.origin !== page.origin
      || resolvedBase.username || resolvedBase.password
      || resolved.username || resolved.password
      || !resolved.pathname.startsWith(resolvedBase.pathname)) {
    fail('authored vegetation URLs must stay on-origin and inside baseUrl');
  }
  return resolved.href;
}

function abortError(signal) {
  return new CustomsAuthoredVegetationAbort(undefined, signal?.reason);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function disposeMaterial(material, state) {
  if (Array.isArray(material)) {
    for (const entry of material) disposeMaterial(entry, state);
    return;
  }
  if (!material || state.materials.has(material)) return;
  state.materials.add(material);
  const disposeTexture = (value) => {
    if (Array.isArray(value)) {
      for (const entry of value) disposeTexture(entry);
      return;
    }
    if (!value?.isTexture || state.textures.has(value)) return;
    state.textures.add(value);
    value.dispose?.();
  };
  for (const value of Object.values(material)) disposeTexture(value);
  for (const uniform of Object.values(material.uniforms ?? {})) disposeTexture(uniform?.value);
  material.dispose?.();
}

/** Default ownership release for a decoded, uncached GLTF value. */
export function disposeCustomsAuthoredVegetationGlb(value) {
  const root = value?.scene ?? value;
  const state = { geometries: new Set(), materials: new Set(), textures: new Set() };
  const disposeNode = (node) => {
    if (node.geometry && !state.geometries.has(node.geometry)) {
      state.geometries.add(node.geometry);
      node.geometry.dispose?.();
    }
    disposeMaterial(node.material, state);
  };
  if (typeof root?.traverse === 'function') root.traverse(disposeNode);
  else if (root) disposeNode(root);
}

/**
 * Estimate the CPU-resident bytes a decoded GLTF `value` still holds, for reporting only — it never
 * decides what to free; `disposeCustomsAuthoredVegetationGlb` remains the single dispose path.
 *
 * Mirrors that function's own traversal (same node walk, same per-geometry/per-material/per-texture
 * dedup via `Set`s) so the number is "what `disposeCustomsAuthoredVegetationGlb` would free right
 * now", not a guess. It exists because the per-primitive fallback path (no texture arrays) keeps
 * `value` alive on purpose — its materials are the merged batch's own `material`, not a clone — so
 * that memory is genuinely resident for as long as the runtime is, and `residentBytes` must count it
 * or it understates the pack's real footprint by exactly the amount the array-texture path frees
 * early (see the `release(loadedEntry.value)` call this mirrors, a few hundred lines below).
 *
 * Texture bytes are a decoded-RGBA8 estimate (`width * height * 4`) per unique image, which is what
 * an ImageBitmap/HTMLImageElement actually costs once decoded — there is no smaller, still-accurate
 * number to read off a three.js texture without a GPU query. A texture backed by a typed array
 * (`image.data`) reports that array's own `byteLength` instead, which is exact.
 */
function estimateRetainedGlbBytes(value) {
  const root = value?.scene ?? value;
  const state = { geometries: new Set(), materials: new Set(), textures: new Set() };
  let bytes = 0;
  const addTextureBytes = (candidate) => {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) addTextureBytes(entry);
      return;
    }
    if (!candidate?.isTexture || state.textures.has(candidate)) return;
    state.textures.add(candidate);
    const image = candidate.image;
    const data = image?.data;
    if (data && typeof data.byteLength === 'number') {
      bytes += data.byteLength;
      return;
    }
    const width = Number(image?.width);
    const height = Number(image?.height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      bytes += width * height * 4;
    }
  };
  const addMaterialBytes = (material) => {
    if (Array.isArray(material)) {
      for (const entry of material) addMaterialBytes(entry);
      return;
    }
    if (!material || state.materials.has(material)) return;
    state.materials.add(material);
    for (const candidate of Object.values(material)) addTextureBytes(candidate);
    for (const uniform of Object.values(material.uniforms ?? {})) addTextureBytes(uniform?.value);
  };
  const visitNode = (node) => {
    if (node.geometry && !state.geometries.has(node.geometry)) {
      state.geometries.add(node.geometry);
      for (const attribute of Object.values(node.geometry.attributes ?? {})) {
        bytes += attribute?.array?.byteLength ?? 0;
      }
      bytes += node.geometry.index?.array?.byteLength ?? 0;
    }
    addMaterialBytes(node.material);
  };
  if (typeof root?.traverse === 'function') root.traverse(visitNode);
  else if (root) visitNode(root);
  return bytes;
}

function flipTriangleWinding(geometry) {
  const vertexCount = geometry.getAttribute('position')?.count ?? 0;
  if (geometry.index) {
    const source = geometry.index.array;
    if (source.length % 3 !== 0) fail('authored primitive index count is not triangular');
    const reversed = source.slice();
    for (let index = 0; index < reversed.length; index += 3) {
      [reversed[index + 1], reversed[index + 2]] = [reversed[index + 2], reversed[index + 1]];
    }
    geometry.setIndex(new THREE.BufferAttribute(reversed, 1));
  } else {
    if (vertexCount % 3 !== 0) fail('authored non-indexed primitive vertex count is not triangular');
    const IndexArray = vertexCount > 65535 ? Uint32Array : Uint16Array;
    const indices = new IndexArray(vertexCount);
    for (let index = 0; index < vertexCount; index += 3) {
      indices[index] = index;
      indices[index + 1] = index + 2;
      indices[index + 2] = index + 1;
    }
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  }
  const tangent = geometry.getAttribute('tangent');
  if (tangent?.itemSize === 4) {
    for (let index = 0; index < tangent.count; index += 1) tangent.setW(index, -tangent.getW(index));
    tangent.needsUpdate = true;
  }
}

function groupIndexArray(geometry, groups) {
  const source = geometry.index?.array ?? null;
  const count = geometry.getAttribute('position')?.count ?? 0;
  const values = [];
  for (const group of groups) {
    const end = group.start + group.count;
    if (group.start < 0 || group.count < 0 || end > (source?.length ?? count)) {
      fail('authored primitive material group is out of bounds');
    }
    for (let index = group.start; index < end; index += 1) values.push(source ? source[index] : index);
  }
  if (values.length % 3 !== 0) fail('authored primitive material group is not triangular');
  const IndexArray = count > 65535 ? Uint32Array : Uint16Array;
  return new IndexArray(values);
}

function sourcePrimitiveSlices(node) {
  const materials = Array.isArray(node.material) ? node.material : [node.material];
  if (materials.some((material) => !material)) fail(`authored mesh ${node.name || '(unnamed)'} has no material`);
  if (materials.length === 1) return [{ geometry: node.geometry.clone(), material: materials[0], materialIndex: 0 }];
  const groupsByMaterial = new Map();
  for (const group of node.geometry.groups ?? []) {
    if (!groupsByMaterial.has(group.materialIndex)) groupsByMaterial.set(group.materialIndex, []);
    groupsByMaterial.get(group.materialIndex).push(group);
  }
  if (groupsByMaterial.size === 0) fail('multi-material authored mesh has no primitive groups');
  const result = [];
  try {
    for (const [materialIndex, groups] of [...groupsByMaterial].sort((a, b) => a[0] - b[0])) {
      const material = materials[materialIndex];
      if (!material) fail(`authored mesh references missing material ${materialIndex}`);
      let geometry = null;
      try {
        geometry = node.geometry.clone();
        const indices = groupIndexArray(node.geometry, groups);
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
        geometry.setDrawRange(0, indices.length);
        geometry.clearGroups();
        result.push({ geometry, material, materialIndex });
      } catch (error) {
        geometry?.dispose?.();
        throw error;
      }
    }
  } catch (error) {
    for (const primitive of result) primitive.geometry.dispose?.();
    throw error;
  }
  return result;
}

function visibleFromRoot(node, root) {
  let current = node;
  while (current) {
    if (current.visible === false) return false;
    if (current === root) return true;
    current = current.parent;
  }
  return false;
}

function normalizedShadowPolicy(value) {
  const policy = object(value, 'shadowPolicy');
  if (!['disabled', 'near-lod'].includes(policy.mode)) {
    fail('shadowPolicy.mode must be disabled or near-lod');
  }
  if (typeof policy.receive !== 'boolean') fail('shadowPolicy.receive must be boolean');
  return Object.freeze({ mode: policy.mode, receive: policy.receive });
}

function normalizedAlphaPolicy(value) {
  const policy = object(value, 'alphaPolicy');
  if (typeof policy.blend !== 'string' || !['report', 'reject'].includes(policy.blend)) {
    fail('alphaPolicy.blend must be "report" or "reject"');
  }
  return Object.freeze({ blend: policy.blend });
}

function classifyMaterialAlpha(material, { assetId, lod, sourceNode, materialIndex, alphaPolicy }) {
  if (!material?.isMaterial) fail(`authored vegetation ${assetId} has an unknown material object`);
  const name = String(material.name || `${sourceNode}:material${materialIndex}`);
  const alphaTest = finite(material.alphaTest ?? 0, `material ${name}.alphaTest`);
  const opacity = finite(material.opacity ?? 1, `material ${name}.opacity`);
  if (alphaTest < 0 || alphaTest > 1) fail(`material ${name} alphaTest must be normalized`);
  if (opacity < 0 || opacity > 1) fail(`material ${name} opacity must be normalized`);
  if (material.alphaHash === true) {
    fail(`material ${name} uses unsupported alphaHash; only OPAQUE, MASK/alphaTest, or reported BLEND are admitted`);
  }
  let mode;
  if (material.transparent === true) {
    if (alphaTest > 0) {
      fail(`material ${name} mixes BLEND and MASK semantics`);
    }
    mode = 'BLEND';
  } else if (alphaTest > 0) {
    if (opacity !== 1) fail(`MASK material ${name} must keep opacity 1`);
    mode = 'MASK';
  } else {
    if (opacity !== 1) {
      fail(`opaque material ${name} has opacity ${opacity} without explicit BLEND`);
    }
    mode = 'OPAQUE';
  }
  const record = Object.freeze({
    assetId,
    lod,
    sourceNode,
    materialIndex,
    materialName: name,
    mode,
    alphaTest,
    foliageLike: /(?:leaf|needle|foliage|card|grass|fern|plant|shrub|brush)/iu.test(name),
  });
  if (mode === 'BLEND' && alphaPolicy.blend === 'reject') {
    fail(
      `BLEND vegetation material ${name} is rejected by alpha policy; author MASK/alphaTest or opt into explicit reporting`,
      'ERR_CUSTOMS_VEGETATION_BLEND_REJECTED',
      record,
    );
  }
  return record;
}

function authoredPrimitives(value, assetId, lod, alphaPolicy) {
  const root = value?.scene ?? value;
  if (!root?.isObject3D || typeof root.traverse !== 'function') {
    fail(`loaded vegetation asset ${assetId} has no GLTF scene`);
  }
  root.updateWorldMatrix(true, true);
  const parentInverse = new THREE.Matrix4();
  if (root.parent) {
    root.parent.updateWorldMatrix(true, false);
    parentInverse.copy(root.parent.matrixWorld).invert();
  }
  const primitives = [];
  const ownedGeometries = new Set();
  try {
    root.traverse((node) => {
      if (!node.isMesh || !node.geometry || !visibleFromRoot(node, root)) return;
      if (node.isSkinnedMesh || Object.keys(node.geometry.morphAttributes ?? {}).length > 0) {
        fail(`authored vegetation mesh ${node.name || '(unnamed)'} is not static-instancing compatible`);
      }
      const childMatrix = parentInverse.clone().multiply(node.matrixWorld);
      const bakedMatrix = GEOMETRY_X_REFLECTION.clone().multiply(childMatrix);
      const determinant = bakedMatrix.determinant();
      if (Math.abs(determinant) < 1e-10) fail(`authored vegetation mesh ${node.name || '(unnamed)'} has a singular transform`);
      const slices = sourcePrimitiveSlices(node);
      for (const slice of slices) ownedGeometries.add(slice.geometry);
      for (const slice of slices) {
        const alpha = classifyMaterialAlpha(slice.material, {
          assetId,
          lod,
          sourceNode: node.name || 'mesh',
          materialIndex: slice.materialIndex,
          alphaPolicy,
        });
        slice.geometry.applyMatrix4(bakedMatrix);
        if (determinant < 0) flipTriangleWinding(slice.geometry);
        slice.geometry.computeBoundingBox();
        slice.geometry.computeBoundingSphere();
        primitives.push(Object.freeze({
          geometry: slice.geometry,
          material: slice.material,
          sourceNode: node.name || 'mesh',
          materialIndex: slice.materialIndex,
          castShadow: node.castShadow,
          receiveShadow: node.receiveShadow,
          renderOrder: node.renderOrder,
          alpha,
        }));
      }
    });
  } catch (error) {
    for (const geometry of ownedGeometries) geometry.dispose?.();
    throw error;
  }
  if (primitives.length === 0) fail(`loaded vegetation asset ${assetId} has no visible mesh primitives`);
  return primitives;
}

/**
 * Merge one (family, LOD) group's primitives into ONE geometry drawn with ONE shared material.
 *
 * `useGroups: false` is the whole point: with the 199 pack materials collapsed into one
 * array-texture material, a merged geometry needs no material groups, and a bucket that carries no
 * groups is one draw call instead of two or three. The per-vertex `vegLayer` attribute (added by
 * `applyCustomsVegetationLayerAttributes` before this runs) is what still lets each primitive
 * sample its own array layer inside that single call.
 */
function mergeAuthoredPrimitivesShared(primitives, sharedMaterial, assetId, lod) {
  const renderOrder = primitives[0].renderOrder;
  if (primitives.some((primitive) => primitive.renderOrder !== renderOrder)) {
    for (const primitive of primitives) primitive.geometry.dispose?.();
    fail(`authored vegetation ${assetId} LOD${lod} primitives disagree on renderOrder`);
  }
  let geometry;
  try {
    geometry = primitives.length === 1
      ? primitives[0].geometry
      : mergeGeometries(primitives.map((primitive) => primitive.geometry), false);
    if (!geometry) {
      fail(`authored vegetation ${assetId} LOD${lod} primitives cannot share one array-texture batch`);
    }
    if (geometry.groups?.length) geometry.clearGroups();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  } catch (error) {
    if (geometry !== primitives[0]?.geometry) geometry?.dispose?.();
    for (const primitive of primitives) primitive.geometry.dispose?.();
    throw error;
  }
  if (primitives.length > 1) {
    for (const primitive of primitives) primitive.geometry.dispose?.();
  }
  return Object.freeze({
    geometry,
    material: sharedMaterial,
    materialCount: 1,
    renderOrder,
    sourceNodes: Object.freeze(primitives.map((primitive) => primitive.sourceNode)),
    alphaModes: Object.freeze(primitives.map((primitive) => primitive.alpha.mode)),
  });
}

function mergeAuthoredPrimitives(primitives, assetId, lod) {
  if (primitives.length === 1) {
    const [primitive] = primitives;
    return Object.freeze({
      geometry: primitive.geometry,
      material: primitive.material,
      materialCount: 1,
      renderOrder: primitive.renderOrder,
      sourceNodes: Object.freeze([primitive.sourceNode]),
      alphaModes: Object.freeze([primitive.alpha.mode]),
    });
  }
  const renderOrder = primitives[0].renderOrder;
  if (primitives.some((primitive) => primitive.renderOrder !== renderOrder)) {
    for (const primitive of primitives) primitive.geometry.dispose?.();
    fail(`authored vegetation ${assetId} LOD${lod} primitives disagree on renderOrder`);
  }
  let geometry;
  try {
    geometry = mergeGeometries(primitives.map((primitive) => primitive.geometry), true);
    if (!geometry) fail(`authored vegetation ${assetId} LOD${lod} primitives cannot share one cell batch`);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  } catch (error) {
    geometry?.dispose?.();
    for (const primitive of primitives) primitive.geometry.dispose?.();
    throw error;
  }
  for (const primitive of primitives) primitive.geometry.dispose?.();
  return Object.freeze({
    geometry,
    material: primitives.map((primitive) => primitive.material),
    materialCount: primitives.length,
    renderOrder,
    sourceNodes: Object.freeze(primitives.map((primitive) => primitive.sourceNode)),
    alphaModes: Object.freeze(primitives.map((primitive) => primitive.alpha.mode)),
  });
}

async function loadAssetGroups({
  assetLodRequests,
  baseUrl,
  pageUrl,
  loadGlb,
  signal,
  concurrency,
  release,
  cancel,
}) {
  const loaded = new Map();
  let next = 0;
  let firstError = null;
  const limit = Math.min(Math.max(1, Math.trunc(concurrency)), assetLodRequests.length || 1);
  async function worker() {
    while (!firstError) {
      throwIfAborted(signal);
      const index = next++;
      if (index >= assetLodRequests.length) return;
      const entry = assetLodRequests[index];
      const request = entry.asset.lods[entry.lod];
      const url = resolveAssetUrl(baseUrl, request.file, pageUrl);
      try {
        const value = await loadGlb(url, {
          request,
          signal,
          asset: entry.asset,
          lod: entry.lod,
        });
        if (signal.aborted) {
          release(value);
          throw abortError(signal);
        }
        loaded.set(entry.key, Object.freeze({
          key: entry.key,
          value,
          url,
          request,
          asset: entry.asset,
          lod: entry.lod,
        }));
      } catch (error) {
        if (!firstError) {
          firstError = error;
          cancel?.(error);
        }
        return;
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker().catch((error) => {
    if (!firstError) {
      firstError = error;
      cancel?.(error);
    }
  })));
  if (firstError) {
    for (const entry of loaded.values()) release(entry.value);
    throw firstError;
  }
  throwIfAborted(signal);
  return loaded;
}

/**
 * Build the ONE material a whole LOD tier draws with, backed by that tier's texture arrays.
 *
 * All 199 pack materials carry the identical texture-slot signature
 * (`baseColor + metallicRoughness + normal + occlusion`), the identical double-sidedness, and no
 * PBR factors at all; they differ only in which small image they sample. A `DataArrayTexture` per
 * slot plus a per-vertex layer index reproduces that exactly, in one material, and — unlike an
 * atlas — needs no UV rewriting, because array layers wrap independently and 173 of the 199
 * primitives tile their UVs outside [0, 1] on REPEAT samplers.
 *
 * `normalScale` is pre-baked into the normal layers offline, so nothing per-layer survives into
 * the runtime material.
 */
export function createCustomsAuthoredVegetationArrayMaterial({
  basecolor,
  orm,
  normal,
  lod,
  alphaCutoff,
}) {
  if (!basecolor?.isTexture || !orm?.isTexture || !normal?.isTexture) {
    fail('an array-texture vegetation material needs basecolor, orm and normal DataArrayTextures');
  }
  // `null` is the honest value for a LOD tier that carries no MASK card at all — the pack's 22
  // cutouts exist only at LOD0 — and it means "no alpha test", not "test at some default". An
  // alphaTest of 0 skips the discard branch entirely instead of testing every fragment of 177
  // fully opaque layers against a threshold none of them can fail.
  const cutoff = alphaCutoff === null || alphaCutoff === undefined
    ? 0
    : finite(alphaCutoff, 'alphaCutoff');
  if (cutoff < 0 || cutoff >= 1) fail('alphaCutoff must be null or inside [0, 1)');
  const sampleUv = uv();
  const layer = attribute(CUSTOMS_VEGETATION_LAYER_ATTRIBUTE, 'float').toInt();
  const base = texture(basecolor, sampleUv).depth(layer);
  const ormSample = texture(orm, sampleUv).depth(layer);
  const packedNormal = texture(normal, sampleUv).depth(layer).rgb;

  const material = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  material.name = `customs-authored-vegetation-lod${lod}`;
  material.side = THREE.DoubleSide;
  // MASK, never BLEND: measured over the pack, every card texture is strictly binary alpha (two
  // histogram buckets, nothing in [32, 224)), so alpha-testing is lossless and buys order
  // independence. A BLEND material reaching here is a contract failure, not a thing to sort.
  material.transparent = false;
  material.alphaTest = cutoff;
  // A vec3 colorNode is promoted to vec4(rgb, 1.0) by the node builder, so `instanceColor` (the
  // per-placement authored tint) still multiplies in through NodeMaterial's own instancing path
  // and the texture's own alpha reaches `diffuseColor.a` through opacityNode untouched.
  material.colorNode = base.rgb;
  material.opacityNode = base.a;
  material.normalNode = normalMap(packedNormal);
  material.aoNode = ormSample.r;
  material.roughnessNode = ormSample.g.clamp(0.04, 1);
  material.metalnessNode = ormSample.b;
  material.fog = false;
  material.userData = {
    kind: 'customs-authored-vegetation-array-material',
    lod,
    alphaCutoff: cutoff,
    layerAttribute: CUSTOMS_VEGETATION_LAYER_ATTRIBUTE,
    ormChannels: 'r=occlusion,g=roughness,b=metallic',
    normalScaleBakedOffline: true,
  };
  return material;
}

function residentAssetLodRequests(compiled) {
  const requests = [];
  for (const group of compiled.assetGroups) {
    for (const lod of LODS) {
      requests.push(Object.freeze({
        key: customsAuthoredVegetationBucketKey(group.asset.assetId, lod),
        asset: group.asset,
        lod,
      }));
    }
  }
  return Object.freeze(requests);
}

/**
 * Load every authored family at every LOD atomically and return an unattached Three.Group holding
 * one `InstancedMesh` per (family, LOD).
 *
 * Atomic by construction: the group is only returned once all 93 GLBs have decoded, merged and
 * seated. Any failure — a bad fetch, a rejected alpha mode, an aborted signal — disposes every
 * partial product and rejects, so a caller that keeps its procedural vegetation until this promise
 * resolves can never end up with a half-swapped scene.
 *
 * Every geometry is resident from the first build (≈9 MB for the whole pack), so a camera-driven
 * LOD change is a buffer repack, never a refetch: `requiresReload()` and the whole reload path are
 * gone. Call `update()` on camera motion.
 */
export async function createCustomsAuthoredVegetationRuntime({
  plan,
  packIndex,
  catalog: suppliedCatalog = null,
  baseUrl = '/assets/3d/customs/authored/vegetation/',
  pageUrl = globalThis.location?.href ?? 'http://localhost/',
  requireCompleteCatalog = true,
  loadGlb,
  disposeLoadedGlb = disposeCustomsAuthoredVegetationGlb,
  cameraWorldPosition,
  previousLods = null,
  lodPolicy = CUSTOMS_AUTHORED_VEGETATION_LOD_POLICY,
  shadowPolicy = CUSTOMS_AUTHORED_VEGETATION_SHADOW_POLICY,
  alphaPolicy = CUSTOMS_AUTHORED_VEGETATION_ALPHA_POLICY,
  textureArrays = null,
  frustum = null,
  concurrency = 4,
  signal = null,
} = {}) {
  if (typeof loadGlb !== 'function') fail('authored vegetation runtime requires loadGlb()');
  if (typeof disposeLoadedGlb !== 'function') fail('disposeLoadedGlb must be a function');
  const shadows = normalizedShadowPolicy(shadowPolicy);
  const alpha = normalizedAlphaPolicy(alphaPolicy);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    fail('concurrency must be a safe integer from 1 through 16');
  }
  if (textureArrays !== null && typeof textureArrays?.texture !== 'function') {
    fail('textureArrays must be the loaded set returned by loadCustomsVegetationTextureArrays()');
  }
  const catalog = suppliedCatalog ?? normalizeCustomsAuthoredVegetationCatalog(packIndex);
  if (requireCompleteCatalog && !catalog.currentFactoryCoverage.complete) {
    fail(
      `authored vegetation catalog is incomplete: ${catalog.currentFactoryCoverage.assets}/${catalog.currentFactoryCoverage.expectedAssets} assets and ${catalog.currentFactoryCoverage.bindings}/${catalog.currentFactoryCoverage.expectedBindings} bindings`,
      'ERR_CUSTOMS_VEGETATION_INCOMPLETE_CATALOG',
      catalog.currentFactoryCoverage,
    );
  }
  const compiled = planCustomsAuthoredVegetationInstances(plan, catalog);
  const residentRequests = residentAssetLodRequests(compiled);
  // Fail before a single byte is fetched if the camera or the LOD policy is unusable.
  const initialPartition = partitionCustomsAuthoredVegetationByLod(compiled, {
    cameraWorldPosition,
    previousLods,
    lodPolicy,
    frustum,
  });

  const controller = new AbortController();
  const loadedValues = new Set();
  const createdGeometries = new Set();
  const createdInstancedMeshes = new Set();
  const createdMaterials = new Set();
  const release = (value) => {
    if (value == null || loadedValues.has(value)) return;
    loadedValues.add(value);
    try { disposeLoadedGlb(value); } catch { /* cleanup remains best effort */ }
  };
  let runtime = null;
  const externalAbort = () => {
    controller.abort(signal?.reason);
    runtime?.dispose();
  };
  if (signal?.aborted) throw abortError(signal);
  signal?.addEventListener?.('abort', externalAbort, { once: true });
  const disposePartial = (group, loaded) => {
    group?.removeFromParent?.();
    for (const mesh of createdInstancedMeshes) {
      try { mesh.dispose?.(); } catch { /* cleanup remains best effort */ }
    }
    createdInstancedMeshes.clear();
    group?.clear?.();
    for (const geometry of createdGeometries) {
      try { geometry.dispose?.(); } catch { /* cleanup remains best effort */ }
    }
    createdGeometries.clear();
    // Only materials this runtime created are disposed. The pack's own decoded materials belong to
    // the loaded GLTF value and are released by `disposeLoadedGlb`, and the caller's texture arrays
    // outlive this runtime.
    for (const material of createdMaterials) {
      try { material.dispose?.(); } catch { /* cleanup remains best effort */ }
    }
    createdMaterials.clear();
    for (const entry of loaded?.values?.() ?? []) release(entry.value);
  };

  let loaded = null;
  let group = null;
  try {
    loaded = await loadAssetGroups({
      assetLodRequests: residentRequests,
      baseUrl,
      pageUrl,
      loadGlb,
      signal: controller.signal,
      concurrency,
      release,
      cancel: (error) => controller.abort(error),
    });
    throwIfAborted(controller.signal);
    group = new THREE.Group();
    group.name = 'customs-authored-vegetation';

    // One shared material per LOD tier when the texture arrays are present; otherwise the pack's
    // own per-primitive authored materials, which still batch per (family, LOD) but cost one draw
    // call per primitive slice inside each bucket.
    const arrayIndex = textureArrays?.index ?? null;
    const sharedMaterialByLod = new Map();
    if (textureArrays) {
      for (const lod of LODS) {
        const declaredCutoff = arrayIndex?.alphaCutoffByLod?.[String(lod)]
          ?? arrayIndex?.alphaCutoffByLod?.[lod];
        const cutoff = typeof declaredCutoff === 'number' ? declaredCutoff : null;
        const material = createCustomsAuthoredVegetationArrayMaterial({
          basecolor: textureArrays.texture(lod, 'basecolor'),
          orm: textureArrays.texture(lod, 'orm'),
          normal: textureArrays.texture(lod, 'normal'),
          lod,
          alphaCutoff: cutoff,
        });
        createdMaterials.add(material);
        sharedMaterialByLod.set(lod, material);
      }
    }

    let receiptTrianglesAcrossLoadedAssetLods = 0;
    // Bytes the per-primitive fallback path keeps alive on purpose (see `estimateRetainedGlbBytes`
    // above) because it must not release `loadedEntry.value` — its materials are still in use.
    // Stays 0 whenever `textureArrays` is present, since that path releases every entry instead.
    let retainedDecodedGlbBytes = 0;
    const preparedByKey = new Map();
    const alphaRecords = [];
    const boundLayerRecords = [];
    const loadedAssetUrls = residentRequests.map((entry) => {
      const loadedEntry = loaded.get(entry.key);
      if (!loadedEntry) fail(`authored vegetation load lost ${entry.asset.assetId} LOD${entry.lod}`);
      const primitives = authoredPrimitives(
        loadedEntry.value,
        entry.asset.assetId,
        entry.lod,
        alpha,
      );
      for (const primitive of primitives) alphaRecords.push(primitive.alpha);
      let batch;
      if (textureArrays) {
        // Bind every primitive's array layer BEFORE the merge: `mergeGeometries` demands an
        // identical attribute set across its inputs, so binding some and not others would fail
        // far from its cause.
        const bound = applyCustomsVegetationLayerAttributes(
          arrayIndex,
          entry.asset.assetId,
          entry.lod,
          primitives,
        );
        for (const record of bound) boundLayerRecords.push(record);
        batch = mergeAuthoredPrimitivesShared(
          primitives,
          sharedMaterialByLod.get(entry.lod),
          entry.asset.assetId,
          entry.lod,
        );
      } else {
        batch = mergeAuthoredPrimitives(primitives, entry.asset.assetId, entry.lod);
      }
      createdGeometries.add(batch.geometry);
      preparedByKey.set(entry.key, Object.freeze({
        loadedEntry,
        batch,
        primitiveCount: primitives.length,
      }));
      receiptTrianglesAcrossLoadedAssetLods += loadedEntry.request.triangles;
      if (textureArrays) {
        // Under the array material NOTHING of the decoded GLTF survives the merge: the geometries
        // are deep clones and the pack's 199 materials and 597 decoded images are unreferenced.
        // Release them now rather than holding ~20 MB of dead ImageBitmaps for the session.
        // (The per-primitive fallback path DOES keep the pack's materials, so it must not.)
        release(loadedEntry.value);
      } else {
        // Not released — the merged batch's `material` array IS `loadedEntry.value`'s own decoded
        // materials, referenced directly (see `mergeAuthoredPrimitives`), not a clone. Count what
        // stays resident here so `residentBytes` reports it instead of silently going quiet about
        // exactly the memory the array-texture path frees a few lines above.
        retainedDecodedGlbBytes += estimateRetainedGlbBytes(loadedEntry.value);
      }
      return loadedEntry.url;
    });

    // Precompose every instance matrix and tint exactly once. A LOD change copies these 64-byte
    // rows into a bucket's instance buffer; it never recomposes a matrix, which is what keeps a
    // full 8,805-placement repack near a millisecond.
    const placements = compiled.placements;
    const placementMatrices = new Float32Array(placements.length * 16);
    const placementColors = new Float32Array(placements.length * 3);
    for (let index = 0; index < placements.length; index += 1) {
      const matrix = customsAuthoredVegetationInstanceMatrix(placements[index]);
      placementMatrices.set(matrix.elements, index * 16);
      placementColors[index * 3] = placements[index].tint.r;
      placementColors[index * 3 + 1] = placements[index].tint.g;
      placementColors[index * 3 + 2] = placements[index].tint.b;
    }

    // Every bucket is sized to its family's FULL placement count, and `mesh.count` is the live
    // prefix. That is 3 x 8,805 instance matrices allocated for the complete pack — 1.69 MB — in
    // exchange for a LOD change that never reallocates a buffer.
    const capacityByAsset = new Map(
      compiled.assetGroups.map((entry) => [entry.asset.assetId, entry.placements.length]),
    );
    const meshByKey = new Map();
    let instanceMatrixBytes = 0;
    for (const entry of residentRequests) {
      const prepared = preparedByKey.get(entry.key);
      if (!prepared) fail(`authored vegetation preparation lost ${entry.asset.assetId} LOD${entry.lod}`);
      const capacity = capacityByAsset.get(entry.asset.assetId) ?? 0;
      const mesh = new THREE.InstancedMesh(prepared.batch.geometry, prepared.batch.material, capacity);
      createdInstancedMeshes.add(mesh);
      mesh.name = `${entry.asset.assetId}:lod${entry.lod}`;
      mesh.castShadow = shadows.mode === 'near-lod' && entry.lod === 0;
      mesh.receiveShadow = shadows.receive;
      // Per-instance frustum rejection happens in the partitioner, which repacks the live prefix.
      // Three's own object-level cull reads a bounding sphere that the repack invalidates, so it
      // must stay off; an empty bucket is hidden outright instead.
      mesh.frustumCulled = false;
      mesh.renderOrder = prepared.batch.renderOrder;
      mesh.count = 0;
      mesh.visible = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      instanceMatrixBytes += mesh.instanceMatrix.array.byteLength + mesh.instanceColor.array.byteLength;
      mesh.userData = {
        kind: 'customs-authored-vegetation',
        assetId: entry.asset.assetId,
        prototypeName: entry.asset.prototypeName,
        lod: entry.lod,
        capacity,
        instances: 0,
        sourceNodes: prepared.batch.sourceNodes,
        materialCount: prepared.batch.materialCount,
        primitiveCount: prepared.primitiveCount,
        alphaModes: prepared.batch.alphaModes,
        receiptTriangles: prepared.loadedEntry.request.triangles,
        collision: 'none',
        placementAccuracy: 'exact-scalar-placement',
        geometryAccuracy: 'original-authored-approximation-not-source-game-topology',
      };
      meshByKey.set(entry.key, mesh);
      group.add(mesh);
    }

    const live = {
      partition: null,
      buckets: 0,
      drawCalls: 0,
      instances: 0,
      frustumCulled: 0,
      renderedTriangles: 0,
      lodVisibleCounts: { 0: 0, 1: 0, 2: 0 },
      lodInstanceCounts: { 0: 0, 1: 0, 2: 0 },
      frustumCullingApplied: false,
      repackMs: 0,
    };

    function applyPartition(partition) {
      const startedAt = (globalThis.performance ?? Date).now();
      for (const mesh of meshByKey.values()) {
        mesh.count = 0;
        mesh.visible = false;
        mesh.userData.instances = 0;
      }
      let buckets = 0;
      let drawCalls = 0;
      let instances = 0;
      let renderedTriangles = 0;
      for (const bucket of partition.buckets) {
        const mesh = meshByKey.get(bucket.key);
        if (!mesh) fail(`authored vegetation partition names an unbuilt bucket ${bucket.key}`);
        if (bucket.instances > mesh.userData.capacity) {
          fail(`authored vegetation bucket ${bucket.key} exceeds its family capacity`);
        }
        const matrixArray = mesh.instanceMatrix.array;
        const colorArray = mesh.instanceColor.array;
        for (let slot = 0; slot < bucket.indices.length; slot += 1) {
          const source = bucket.indices[slot];
          matrixArray.set(placementMatrices.subarray(source * 16, source * 16 + 16), slot * 16);
          colorArray.set(placementColors.subarray(source * 3, source * 3 + 3), slot * 3);
        }
        mesh.count = bucket.instances;
        mesh.visible = bucket.instances > 0;
        mesh.userData.instances = bucket.instances;
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor.needsUpdate = true;
        buckets += 1;
        drawCalls += mesh.userData.materialCount;
        instances += bucket.instances;
        renderedTriangles += mesh.userData.receiptTriangles * bucket.instances;
      }
      if (instances !== partition.visibleInstances) {
        fail('authored vegetation repack duplicated or lost exact placements');
      }
      live.partition = partition;
      live.buckets = buckets;
      live.drawCalls = drawCalls;
      live.instances = instances;
      live.frustumCulled = partition.frustumCulledInstances;
      live.renderedTriangles = renderedTriangles;
      live.lodVisibleCounts = partition.lodVisibleCounts;
      live.lodInstanceCounts = partition.lodInstanceCounts;
      live.frustumCullingApplied = partition.frustumCullingApplied;
      live.repackMs = (globalThis.performance ?? Date).now() - startedAt;
      return partition;
    }

    applyPartition(initialPartition);

    const alphaModeCounts = { OPAQUE: 0, MASK: 0, BLEND: 0 };
    for (const record of alphaRecords) alphaModeCounts[record.mode] += 1;
    const blendMaterials = Object.freeze(alphaRecords.filter((record) => record.mode === 'BLEND'));
    const alphaContract = Object.freeze({
      blendPolicy: alpha.blend,
      primitiveMaterialModes: Object.freeze(alphaModeCounts),
      blendMaterials,
      warnings: Object.freeze(blendMaterials.length > 0 ? [
        `${blendMaterials.length} BLEND primitive material(s) retained without rewriting; alpha sorting remains an admission/performance risk`,
      ] : []),
      materialsRewritten: false,
    });
    const materialMode = textureArrays ? 'shared-array-texture' : 'authored-per-primitive';
    // What is actually held after the build, not what was downloaded: merged vertex+index buffers,
    // the instance matrix/colour buffers, and the level-0 texture upload.
    let geometryBytes = 0;
    for (const geometry of createdGeometries) {
      for (const attribute of Object.values(geometry.attributes ?? {})) {
        geometryBytes += attribute.array?.byteLength ?? 0;
      }
      geometryBytes += geometry.index?.array?.byteLength ?? 0;
    }
    // `retainedDecodedGlbBytes` is the fallback path's unreleased decoded materials/images/geometry
    // (see the `else` branch above); it is 0 whenever `textureArrays` is present, since that path
    // releases every loaded value as it goes. Omitting it here is exactly the bug this fixes: the
    // reported total would silently understate real residency by the whole retained pack.
    const residentBytes = instanceMatrixBytes + geometryBytes
      + (textureArrays?.stats?.uploadBytes ?? 0) + retainedDecodedGlbBytes;
    const baseStatus = {
      mode: 'exact-scalar-placement-original-authored-vegetation',
      geometry: 'original-authored-approximation-not-source-game-topology',
      collision: 'none',
      packStatus: catalog.status,
      livePromotion: catalog.livePromotion,
      globalLod: false,
      cellLocalLod: false,
      perInstanceLod: true,
      spatialCellGrid: null,
      materialMode,
      sharedMaterials: sharedMaterialByLod.size,
      boundArrayLayers: boundLayerRecords.length,
      sourceInstances: compiled.sourceCount,
      scopedInstances: compiled.renderedCount,
      renderedInstances: compiled.renderedCount,
      culledOutsideScope: compiled.culledCount,
      uniquePlacementInstances: compiled.renderedCount,
      authoredAssetsInCatalog: catalog.assets.length,
      authoredBindingsInCatalog: catalog.bindings.length,
      currentFactoryCoverage: catalog.currentFactoryCoverage,
      loadedAssets: compiled.assetGroups.length,
      loadedAssetLods: residentRequests.length,
      unusedCatalogAssets: catalog.assets.length - compiled.assetGroups.length,
      bucketCeiling: compiled.assetGroups.length * LODS.length,
      instancedMeshes: group.children.length,
      instanceBufferBytes: instanceMatrixBytes,
      geometryBytes,
      textureUploadBytes: textureArrays?.stats?.uploadBytes ?? 0,
      retainedDecodedGlbBytes,
      residentBytes,
      decodedGlbReleasedAfterMerge: Boolean(textureArrays),
      receiptTrianglesAcrossLoadedAssetLods,
      shadowPolicy: shadows,
      alphaContract,
      scaleSources: compiled.scaleSources,
      classes: compiled.counts,
      duplicateOfflinePlacementListConsumed: false,
      loadedAssetUrls: Object.freeze(loadedAssetUrls),
    };
    const liveStatus = () => ({
      lodPolicy: live.partition.lodPolicy,
      buckets: live.buckets,
      liveBuckets: live.buckets,
      drawCalls: live.drawCalls,
      frustumCullBatches: live.buckets,
      visibleInstances: live.instances,
      frustumCulledInstances: live.frustumCulled,
      frustumCullingApplied: live.frustumCullingApplied,
      lodVisibleCounts: live.lodVisibleCounts,
      lodInstanceCounts: live.lodInstanceCounts,
      estimatedRenderedTriangles: live.renderedTriangles,
      lastRepackMs: live.repackMs,
      cameraWorldPosition: live.partition.cameraWorldPosition,
    });
    group.userData = { ...baseStatus, ...liveStatus(), kind: 'customs-authored-vegetation-root' };

    let disposed = false;
    runtime = {
      group,
      catalog,
      compiled,
      get lods() { return live.partition.lods; },
      get active() { return !disposed; },
      get status() {
        return Object.freeze({ ...baseStatus, ...liveStatus(), active: !disposed, disposed });
      },
      /** Re-select every placement's LOD and repack the live prefixes. No GLB is refetched. */
      update({
        cameraWorldPosition: nextCamera,
        frustum: nextFrustum = null,
        previousLods: nextPrevious = live.partition.lods,
      } = {}) {
        if (disposed) fail('a disposed authored vegetation runtime cannot be updated');
        const partition = partitionCustomsAuthoredVegetationByLod(compiled, {
          cameraWorldPosition: nextCamera,
          previousLods: nextPrevious,
          lodPolicy: live.partition.lodPolicy,
          frustum: nextFrustum,
        });
        applyPartition(partition);
        Object.assign(group.userData, liveStatus());
        return this.status;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        controller.abort(new CustomsAuthoredVegetationAbort('Customs authored vegetation runtime disposed.'));
        signal?.removeEventListener?.('abort', externalAbort);
        disposePartial(group, loaded);
      },
    };
    throwIfAborted(controller.signal);
    return runtime;
  } catch (error) {
    controller.abort(error);
    signal?.removeEventListener?.('abort', externalAbort);
    disposePartial(group, loaded);
    if (signal?.aborted || error?.name === 'AbortError') {
      if (error instanceof CustomsAuthoredVegetationAbort) throw error;
      throw new CustomsAuthoredVegetationAbort(undefined, error);
    }
    throw error;
  }
}
