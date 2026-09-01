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
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { customsVegetationProxyDimensions } from './customs-local-vegetation-render.js';

export const CUSTOMS_AUTHORED_VEGETATION_EXPECTED_ASSETS = 31;
export const CUSTOMS_AUTHORED_VEGETATION_EXPECTED_BINDINGS = 58;
// 128 m is the fixed compromise between frustum-culling granularity and prototype/primitive
// batch count. Cell coordinates are anchored at world metre zero and therefore remain stable
// across runs and camera motion.
export const CUSTOMS_AUTHORED_VEGETATION_CELL_SIZE_M = 128;

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
const SAFE_ASSET_FILE = /^assets\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+-lod[0-2]\.glb$/u;
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
  return Object.freeze({
    flatIndex,
    tileId: binding.tileId,
    prototypeId: binding.prototypeId,
    prototypeName: binding.prototypeName,
    classification: text(placement.classification, 'placement.classification'),
    assetId: asset.assetId,
    asset,
    presentationPosition,
    yawRadians: finite(placement.yawRadians ?? 0, 'placement.yawRadians'),
    tint: normalizedTint,
    scale: resolveCustomsAuthoredVegetationScale(placement),
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

function spatialCellId(cellX, cellY) {
  return `${cellX}:${cellY}`;
}

function assetLodKey(assetId, lod) {
  return `${assetId}${BINDING_SEPARATOR}${lod}`;
}

function normalizedPreviousCellLods(value) {
  if (value === null || value === undefined) return null;
  const source = value instanceof Map ? Object.fromEntries(value) : object(value, 'previousCellLods');
  const entries = [];
  for (const [cellId, lod] of Object.entries(source)) {
    if (!/^-?\d+:-?\d+$/u.test(cellId) || !LODS.includes(lod)) {
      fail(`previousCellLods contains invalid entry ${cellId}`);
    }
    entries.push([cellId, lod]);
  }
  return nullRecord(entries);
}

function distanceFromCameraToCell(camera, bounds, averageBaseZ) {
  const axisDistance = (value, minimum, maximum) => (
    value < minimum ? minimum - value : value > maximum ? value - maximum : 0
  );
  const dx = axisDistance(camera[0], bounds.minX, bounds.maxX);
  const dy = axisDistance(camera[1], bounds.minY, bounds.maxY);
  const dz = camera[2] - averageBaseZ;
  return Math.hypot(dx, dy, dz);
}

/**
 * Partition exact placements into stable 128 m world cells and select one hysteretic LOD per
 * spatial cell. Every placement occurs in exactly one prototype cell; the offline placement
 * mirror remains irrelevant.
 */
export function partitionCustomsAuthoredVegetationCells(compiledPlan, {
  cameraWorldPosition,
  previousCellLods = null,
  lodPolicy = CUSTOMS_AUTHORED_VEGETATION_LOD_POLICY,
} = {}) {
  const compiled = object(compiledPlan, 'compiledPlan');
  if (!Array.isArray(compiled.placements)) fail('compiledPlan.placements must be an array');
  const camera = normalizedCameraWorldPosition(cameraWorldPosition);
  const previous = normalizedPreviousCellLods(previousCellLods);
  const policy = Object.freeze(normalizedLodPolicy(lodPolicy));
  const cellsById = new Map();

  for (const placement of compiled.placements) {
    const worldX = finite(placement.presentationPosition?.[0], 'placement.presentationPosition[0]');
    const worldY = finite(placement.presentationPosition?.[1], 'placement.presentationPosition[1]');
    const worldZ = finite(placement.presentationPosition?.[2], 'placement.presentationPosition[2]');
    const cellX = Math.floor(worldX / CUSTOMS_AUTHORED_VEGETATION_CELL_SIZE_M);
    const cellY = Math.floor(worldY / CUSTOMS_AUTHORED_VEGETATION_CELL_SIZE_M);
    const cellId = spatialCellId(cellX, cellY);
    let cell = cellsById.get(cellId);
    if (!cell) {
      cell = {
        cellId,
        cellX,
        cellY,
        baseZSum: 0,
        placements: [],
        prototypeGroups: new Map(),
      };
      cellsById.set(cellId, cell);
    }
    cell.baseZSum += worldZ;
    cell.placements.push(placement);
    let prototype = cell.prototypeGroups.get(placement.assetId);
    if (!prototype) {
      prototype = { asset: placement.asset, placements: [] };
      cell.prototypeGroups.set(placement.assetId, prototype);
    }
    prototype.placements.push(placement);
  }

  const requiredByKey = new Map();
  const cellLodEntries = [];
  const lodCellCounts = { 0: 0, 1: 0, 2: 0 };
  const lodPrototypeCellCounts = { 0: 0, 1: 0, 2: 0 };
  let prototypeCellPlacementInstances = 0;
  const cells = [...cellsById.values()]
    .sort((a, b) => a.cellX - b.cellX || a.cellY - b.cellY)
    .map((cell) => {
      const bounds = Object.freeze({
        minX: cell.cellX * CUSTOMS_AUTHORED_VEGETATION_CELL_SIZE_M,
        maxX: (cell.cellX + 1) * CUSTOMS_AUTHORED_VEGETATION_CELL_SIZE_M,
        minY: cell.cellY * CUSTOMS_AUTHORED_VEGETATION_CELL_SIZE_M,
        maxY: (cell.cellY + 1) * CUSTOMS_AUTHORED_VEGETATION_CELL_SIZE_M,
      });
      const averageBaseZ = cell.baseZSum / cell.placements.length;
      const cameraDistanceM = distanceFromCameraToCell(camera, bounds, averageBaseZ);
      const lod = selectCustomsAuthoredVegetationLod(
        cameraDistanceM,
        previous?.[cell.cellId] ?? null,
        policy,
      );
      cellLodEntries.push([cell.cellId, lod]);
      lodCellCounts[lod] += 1;
      const prototypeGroups = [...cell.prototypeGroups.values()]
        .sort((a, b) => a.asset.assetId.localeCompare(b.asset.assetId))
        .map((entry) => {
          const placements = Object.freeze([...entry.placements].sort((a, b) => a.flatIndex - b.flatIndex));
          prototypeCellPlacementInstances += placements.length;
          lodPrototypeCellCounts[lod] += 1;
          const key = assetLodKey(entry.asset.assetId, lod);
          if (!requiredByKey.has(key)) {
            requiredByKey.set(key, Object.freeze({ key, asset: entry.asset, lod }));
          }
          return Object.freeze({
            cellId: cell.cellId,
            asset: entry.asset,
            lod,
            placements,
          });
        });
      return Object.freeze({
        cellId: cell.cellId,
        cellX: cell.cellX,
        cellY: cell.cellY,
        bounds,
        averageBaseZ,
        cameraDistanceM,
        lod,
        placementCount: cell.placements.length,
        prototypeGroups: Object.freeze(prototypeGroups),
      });
    });

  if (prototypeCellPlacementInstances !== compiled.renderedCount) {
    fail('spatial vegetation partition duplicated or lost exact placements');
  }
  const requiredAssetLods = [...requiredByKey.values()]
    .sort((a, b) => a.asset.assetId.localeCompare(b.asset.assetId) || a.lod - b.lod);
  return Object.freeze({
    cellSizeM: CUSTOMS_AUTHORED_VEGETATION_CELL_SIZE_M,
    cameraWorldPosition: camera,
    lodPolicy: policy,
    cells: Object.freeze(cells),
    cellLods: nullRecord(cellLodEntries),
    spatialCellCount: cells.length,
    prototypeCellCount: cells.reduce((sum, cell) => sum + cell.prototypeGroups.length, 0),
    prototypeCellPlacementInstances,
    lodCellCounts: Object.freeze(lodCellCounts),
    lodPrototypeCellCounts: Object.freeze(lodPrototypeCellCounts),
    requiredAssetLods: Object.freeze(requiredAssetLods),
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
 * Load the cell-local LOD plan atomically and return an unattached Three.Group. A caller can keep
 * the procedural group until this promise resolves, then swap once. Camera-driven LOD changes use
 * `planCells()`/`requiresReload()` and the returned `cellLods` as the next build's hysteresis input.
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
  previousCellLods = null,
  lodPolicy = CUSTOMS_AUTHORED_VEGETATION_LOD_POLICY,
  shadowPolicy = CUSTOMS_AUTHORED_VEGETATION_SHADOW_POLICY,
  alphaPolicy = CUSTOMS_AUTHORED_VEGETATION_ALPHA_POLICY,
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
  const catalog = suppliedCatalog ?? normalizeCustomsAuthoredVegetationCatalog(packIndex);
  if (requireCompleteCatalog && !catalog.currentFactoryCoverage.complete) {
    fail(
      `authored vegetation catalog is incomplete: ${catalog.currentFactoryCoverage.assets}/${catalog.currentFactoryCoverage.expectedAssets} assets and ${catalog.currentFactoryCoverage.bindings}/${catalog.currentFactoryCoverage.expectedBindings} bindings`,
      'ERR_CUSTOMS_VEGETATION_INCOMPLETE_CATALOG',
      catalog.currentFactoryCoverage,
    );
  }
  const compiled = planCustomsAuthoredVegetationInstances(plan, catalog);
  const cellPlan = partitionCustomsAuthoredVegetationCells(compiled, {
    cameraWorldPosition,
    previousCellLods,
    lodPolicy,
  });

  const controller = new AbortController();
  const loadedValues = new Set();
  const createdGeometries = new Set();
  const createdInstancedMeshes = new Set();
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
    for (const entry of loaded?.values?.() ?? []) release(entry.value);
  };

  let loaded = null;
  let group = null;
  try {
    loaded = await loadAssetGroups({
      assetLodRequests: cellPlan.requiredAssetLods,
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
    group.name = 'customs-authored-vegetation-cells';
    let primitiveGroups = 0;
    let primitiveInstances = 0;
    let prototypeCellPlacementInstances = 0;
    let shadowCastingPrimitiveGroups = 0;
    let receiptTrianglesAcrossLoadedAssetLods = 0;
    let estimatedRenderedTriangles = 0;
    const preparedByKey = new Map();
    const alphaRecords = [];
    const loadedAssetUrls = cellPlan.requiredAssetLods.map((entry) => {
      const loadedEntry = loaded.get(entry.key);
      if (!loadedEntry) fail(`authored vegetation load lost ${entry.asset.assetId} LOD${entry.lod}`);
      const primitives = authoredPrimitives(
        loadedEntry.value,
        entry.asset.assetId,
        entry.lod,
        alpha,
      );
      for (const primitive of primitives) {
        alphaRecords.push(primitive.alpha);
      }
      const batch = mergeAuthoredPrimitives(primitives, entry.asset.assetId, entry.lod);
      createdGeometries.add(batch.geometry);
      preparedByKey.set(entry.key, Object.freeze({ loadedEntry, batch }));
      receiptTrianglesAcrossLoadedAssetLods += loadedEntry.request.triangles;
      return loadedEntry.url;
    });

    for (const cell of cellPlan.cells) {
      for (const prototypeCell of cell.prototypeGroups) {
        const key = assetLodKey(prototypeCell.asset.assetId, cell.lod);
        const prepared = preparedByKey.get(key);
        if (!prepared) fail(`authored vegetation preparation lost ${prototypeCell.asset.assetId} LOD${cell.lod}`);
        prototypeCellPlacementInstances += prototypeCell.placements.length;
        estimatedRenderedTriangles += prepared.loadedEntry.request.triangles
          * prototypeCell.placements.length;
        const mesh = new THREE.InstancedMesh(
          prepared.batch.geometry,
          prepared.batch.material,
          prototypeCell.placements.length,
        );
        createdInstancedMeshes.add(mesh);
        mesh.name = `${prototypeCell.asset.assetId}:${cell.cellId}:lod${cell.lod}`;
        mesh.castShadow = shadows.mode === 'near-lod' && cell.lod === 0;
        mesh.receiveShadow = shadows.receive;
        mesh.frustumCulled = true;
        if (mesh.castShadow) shadowCastingPrimitiveGroups += prepared.batch.materialCount;
        mesh.renderOrder = prepared.batch.renderOrder;
        mesh.userData = {
          kind: 'customs-authored-vegetation',
          assetId: prototypeCell.asset.assetId,
          prototypeName: prototypeCell.asset.prototypeName,
          cellId: cell.cellId,
          cellX: cell.cellX,
          cellY: cell.cellY,
          cellBounds: cell.bounds,
          cellCameraDistanceM: cell.cameraDistanceM,
          sourceNodes: prepared.batch.sourceNodes,
          materialCount: prepared.batch.materialCount,
          alphaModes: prepared.batch.alphaModes,
          lod: cell.lod,
          instances: prototypeCell.placements.length,
          collision: 'none',
          placementAccuracy: 'exact-scalar-placement',
          geometryAccuracy: 'original-authored-approximation-not-source-game-topology',
        };
        const color = new THREE.Color();
        prototypeCell.placements.forEach((placement, instanceIndex) => {
          mesh.setMatrixAt(instanceIndex, customsAuthoredVegetationInstanceMatrix(placement));
          color.setRGB(placement.tint.r, placement.tint.g, placement.tint.b);
          mesh.setColorAt(instanceIndex, color);
        });
        mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingBox();
        mesh.computeBoundingSphere();
        group.add(mesh);
        primitiveGroups += prepared.batch.materialCount;
        primitiveInstances += prototypeCell.placements.length * prepared.batch.materialCount;
      }
    }
    if (prototypeCellPlacementInstances !== compiled.renderedCount) {
      fail('runtime prototype-cell accounting duplicated or lost exact vegetation placements');
    }
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
    const usedAssetIds = new Set(cellPlan.requiredAssetLods.map((entry) => entry.asset.assetId));
    const baseStatus = Object.freeze({
      mode: 'exact-scalar-placement-original-authored-vegetation',
      geometry: 'original-authored-approximation-not-source-game-topology',
      collision: 'none',
      packStatus: catalog.status,
      livePromotion: catalog.livePromotion,
      globalLod: false,
      cellLocalLod: true,
      cellSizeM: cellPlan.cellSizeM,
      spatialCells: cellPlan.spatialCellCount,
      prototypeCells: cellPlan.prototypeCellCount,
      cellLods: cellPlan.cellLods,
      lodCellCounts: cellPlan.lodCellCounts,
      lodPrototypeCellCounts: cellPlan.lodPrototypeCellCounts,
      lodPolicy: cellPlan.lodPolicy,
      sourceInstances: compiled.sourceCount,
      scopedInstances: compiled.renderedCount,
      renderedInstances: compiled.renderedCount,
      culledOutsideScope: compiled.culledCount,
      uniquePlacementInstances: compiled.renderedCount,
      authoredAssetsInCatalog: catalog.assets.length,
      authoredBindingsInCatalog: catalog.bindings.length,
      currentFactoryCoverage: catalog.currentFactoryCoverage,
      loadedAssets: usedAssetIds.size,
      loadedAssetLods: cellPlan.requiredAssetLods.length,
      unusedCatalogAssets: catalog.assets.length - usedAssetIds.size,
      instancedMeshes: group.children.length,
      primitiveGroups,
      drawCalls: primitiveGroups,
      primitiveInstances,
      prototypeCellPlacementInstances,
      receiptTrianglesAcrossLoadedAssetLods,
      estimatedRenderedTriangles,
      frustumCullBatches: group.children.length,
      shadowPolicy: shadows,
      shadowCastingPrimitiveGroups,
      alphaContract,
      scaleSources: compiled.scaleSources,
      classes: compiled.counts,
      duplicateOfflinePlacementListConsumed: false,
      loadedAssetUrls: Object.freeze(loadedAssetUrls),
    });
    group.userData = { ...baseStatus, kind: 'customs-authored-vegetation-root' };

    let disposed = false;
    runtime = {
      group,
      catalog,
      cellLods: cellPlan.cellLods,
      get active() { return !disposed; },
      get status() { return Object.freeze({ ...baseStatus, active: !disposed, disposed }); },
      planCells(nextCameraWorldPosition, previousCellLods = cellPlan.cellLods) {
        return partitionCustomsAuthoredVegetationCells(compiled, {
          cameraWorldPosition: nextCameraWorldPosition,
          previousCellLods,
          lodPolicy: cellPlan.lodPolicy,
        });
      },
      selectCellLods(nextCameraWorldPosition, previousCellLods = cellPlan.cellLods) {
        return this.planCells(nextCameraWorldPosition, previousCellLods).cellLods;
      },
      requiresReload(nextCameraWorldPosition, previousCellLods = cellPlan.cellLods) {
        const next = this.selectCellLods(nextCameraWorldPosition, previousCellLods);
        return Object.keys(previousCellLods).some((cellId) => next[cellId] !== previousCellLods[cellId]);
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
