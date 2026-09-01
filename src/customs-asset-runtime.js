// Runtime planning and registry for the Customs authored-asset manifest (schema v2).
//
// Three jobs, all pure except for the small mutable attachment ledger:
//
//   1. Index a validated manifest into the lookups a frame needs (registry).
//   2. Decide, for a camera position, which cells are in play and which LOD each instance
//      should be at — with hysteresis on both, so a camera that dithers across a boundary does
//      not thrash the loader.
//   3. Track what has actually been attached to the scene graph, and derive from that which
//      procedural features may now be hidden. This is the rule that keeps the map honest:
//      **a procedural feature is suppressed only after every authored instance that replaces it
//      is attached.** A download that fails, a cell that has not streamed in yet, an instance
//      that was detached on invalidation — all of them leave the proxy standing. The failure
//      mode of authored assets is "you see the old approximation", never "you see a hole".
//
// No three.js, no DOM, no fetch. The renderer feeds positions in and gets a plan out; the
// tests feed positions in and assert on the plan.

import { isCustomsAssetManifestEmpty } from './customs-asset-manifest.js';

/**
 * Fraction of a switch distance you must overshoot before the decision flips. 8% sits well
 * outside orbit-control jitter and camera easing, and well inside a deliberate zoom step, so
 * a user who means to change detail gets it on the first frame and a trackpad wobble never does.
 */
export const CUSTOMS_ASSET_HYSTERESIS = 0.08;

/** Attachment lifecycle. Only `attached` earns procedural suppression. */
export const ATTACHMENT_STATES = Object.freeze(['idle', 'loading', 'attached', 'failed']);

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

/** Planar distance from a point to an axis-aligned cell footprint; 0 when inside. */
export function cellDistanceM(cell, x, z) {
  const dx = Math.max(cell.boundsM.minX - x, 0, x - cell.boundsM.maxX);
  const dz = Math.max(cell.boundsM.minZ - z, 0, z - cell.boundsM.maxZ);
  return Math.hypot(dx, dz);
}

/**
 * LOD choice with directional hysteresis.
 *
 * Without a previous level this is the plain rule: the first level whose `maxDistanceM` still
 * covers the distance. With one, each boundary crossing must be overshot — going coarser needs
 * `distance > maxDistanceM * (1 + h)`, going finer needs `distance <= maxDistanceM * (1 - h)` —
 * and the walk is one step at a time so a long jump still lands on the right level rather than
 * skipping the confirmation for the levels in between.
 */
export function selectLodLevel(lods, distanceM, previousLevel = null, hysteresis = CUSTOMS_ASSET_HYSTERESIS) {
  const coarsest = lods.length - 1;
  let target = 0;
  while (target < coarsest && distanceM > lods[target].maxDistanceM) target++;
  if (previousLevel === null || previousLevel === undefined) return target;
  const previous = clamp(Math.trunc(previousLevel), 0, coarsest);
  if (target === previous) return previous;
  if (target > previous) {
    let confirmed = previous;
    while (confirmed < target && distanceM > lods[confirmed].maxDistanceM * (1 + hysteresis)) confirmed++;
    return confirmed;
  }
  let confirmed = previous;
  while (confirmed > target && distanceM <= lods[confirmed - 1].maxDistanceM * (1 - hysteresis)) confirmed--;
  return confirmed;
}

// ---------------------------------------------------------------------------
// asset-local glTF -> canonical EFT -> runtime orientation
//
// Two separate corrections, and conflating them is the classic way authored geometry ends up
// lying on its side:
//
//   1. The asset's declared glTF right/up/forward basis is mapped into EFT +X/+Y/+Z.
//   2. The canonical EFT instance rotation is applied in that source frame.
//   3. The complete result is mapped through `[-x, -z, y]` into the renderer.
//
// The last mapping is a handedness flip, so the exact result has determinant -1. That is not a
// bug to "repair" with an eyeballed 180-degree rotation: doing so reverses either the object's
// forward direction or its asymmetric left/right detail. The renderer therefore consumes the
// complete affine matrix, rather than feeding it to a quaternion-only rotation API.

const AXIS_VECTORS = Object.freeze({
  '+x': [1, 0, 0], '-x': [-1, 0, 0],
  '+y': [0, 1, 0], '-y': [0, -1, 0],
  '+z': [0, 0, 1], '-z': [0, 0, -1],
});

/** Change of basis from EFT (x, y, z) to runtime (-x, -z, y). Orthogonal, determinant -1. */
const EFT_TO_RUNTIME = [[-1, 0, 0], [0, 0, -1], [0, 1, 0]];

function multiply3(a, b) {
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
    }
  }
  return out;
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** Asset-local -> EFT-source orientation: declared up -> +Y and forward -> +Z. */
export function customsAssetAxisMatrix(gltf) {
  const up = AXIS_VECTORS[gltf.upAxis];
  const forward = AXIS_VECTORS[gltf.forwardAxis];
  if (!up || !forward) throw new Error(`unknown glTF axis pair ${gltf.upAxis}/${gltf.forwardAxis}`);
  return [cross(up, forward), up, forward];
}

/** Unity's left-handed rotation matrices, applied in Unity's own Z-X-Y order. */
function eftRotationMatrix({ yawDeg, pitchDeg, rollDeg }) {
  const toRad = Math.PI / 180;
  const [cy, sy] = [Math.cos(yawDeg * toRad), Math.sin(yawDeg * toRad)];
  const [cx, sx] = [Math.cos(pitchDeg * toRad), Math.sin(pitchDeg * toRad)];
  const [cz, sz] = [Math.cos(rollDeg * toRad), Math.sin(rollDeg * toRad)];
  const ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
  const rx = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]];
  const rz = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]];
  return multiply3(ry, multiply3(rx, rz));
}

/**
 * Exact unscaled asset-local-to-runtime linear transform for one instance, row-major and flat.
 * It is orthogonal with determinant -1. Use it as a complete matrix; `setRotationFromMatrix`
 * and quaternions cannot preserve the reflection.
 */
export function customsAssetRotationMatrix(gltf, rotation) {
  const total = multiply3(
    multiply3(EFT_TO_RUNTIME, eftRotationMatrix(rotation)),
    customsAssetAxisMatrix(gltf),
  );
  return total.flat();
}

/**
 * Exact asset-local-to-runtime transform including positive asset-local scale.
 * Scale is deliberately local: reusable prototypes such as containers can vary along their
 * authored width/up/forward axes without the result changing when the instance yaws.
 */
export function customsAssetLinearMatrix(gltf, rotation, scale) {
  const orientation = customsAssetRotationMatrix(gltf, rotation);
  const localScale = [scale.x, scale.y, scale.z];
  return orientation.map((value, index) => value * localScale[index % 3]);
}

/** EFT canonical position to runtime world position, matching `gameToWorld`'s `[-x, -z, y]`. */
export function customsAssetWorldPosition({ x, y, z }) {
  return [-x, -z, y];
}

const CUSTOMS_ASSET_FLOOR_RANK = Object.freeze({
  terrain: 0,
  ground: 0,
  'floor-1': 1,
  'floor-2': 2,
  'floor-3': 3,
  roof: 4,
});

/** Match authored floor-tag visibility to the renderer's all/0/1/2/3/U selector. */
export function customsAssetVisibleForFloor(floorTag, selectedFloor) {
  if (selectedFloor === 'U') return floorTag === 'underground';
  if (floorTag === 'underground') return false;
  if (selectedFloor === 'all') return true;
  const selected = Number(selectedFloor);
  if (!Number.isInteger(selected) || selected < 0) return true;
  const rank = CUSTOMS_ASSET_FLOOR_RANK[floorTag];
  return Number.isInteger(rank) && rank <= selected;
}

/**
 * Index a validated manifest. Everything downstream reads these maps rather than re-scanning
 * arrays, and `revision` gives the renderer a cheap invalidation key.
 */
export function createCustomsAssetRegistry(manifest, { revision = 1 } = {}) {
  const assetsById = new Map(manifest.delivery.assets.map((asset) => [asset.id, asset]));
  const materialsById = new Map(manifest.delivery.materials.map((material) => [material.id, material]));
  const instancesById = new Map(manifest.delivery.instances.map((instance) => [instance.id, instance]));
  const cellsById = new Map(manifest.delivery.cells.map((cell) => [cell.id, cell]));
  const replacementsById = new Map(manifest.delivery.replacements.map((entry) => [entry.id, entry]));

  const replacementByFeatureId = new Map();
  const replacementByInstanceId = new Map();
  for (const replacement of manifest.delivery.replacements) {
    replacementByFeatureId.set(replacement.target.featureId, replacement);
    for (const instanceId of replacement.instanceIds) {
      const bucket = replacementByInstanceId.get(instanceId);
      if (bucket) bucket.push(replacement);
      else replacementByInstanceId.set(instanceId, [replacement]);
    }
  }

  const instancesByCell = new Map();
  for (const cell of manifest.delivery.cells) {
    instancesByCell.set(cell.id, cell.instanceIds.map((id) => instancesById.get(id)));
  }

  // Prototype assets are placed more than once; the loader must fetch their glTF exactly once
  // and the renderer should instance them rather than cloning a scene graph per placement.
  const instancesByAsset = new Map();
  for (const instance of manifest.delivery.instances) {
    const bucket = instancesByAsset.get(instance.assetId);
    if (bucket) bucket.push(instance);
    else instancesByAsset.set(instance.assetId, [instance]);
  }

  return Object.freeze({
    manifest,
    revision,
    assetsById,
    materialsById,
    instancesById,
    cellsById,
    replacementsById,
    replacementByFeatureId,
    replacementByInstanceId,
    instancesByCell,
    instancesByAsset,
    cells: manifest.delivery.cells,
    instances: manifest.delivery.instances,
    replacements: manifest.delivery.replacements,
    isEmpty: isCustomsAssetManifestEmpty(manifest),
    /** Every procedural feature this manifest intends to retire, attached or not. */
    replacedFeatureIds: Object.freeze(manifest.delivery.replacements.map((entry) => entry.target.featureId)),
  });
}

/**
 * Mutable ledger of what is actually in the scene graph. Deliberately tiny and deliberately
 * separate from the plan: the plan says what *should* be there, this says what *is*, and the
 * suppression decision is a function of the second, never the first.
 */
export function createCustomsAssetAttachmentLedger() {
  const states = new Map();
  const errors = new Map();
  let revision = 0;

  function set(instanceId, state) {
    if (!ATTACHMENT_STATES.includes(state)) {
      throw new Error(`unknown attachment state ${state}`);
    }
    if (states.get(instanceId) === state) return false;
    states.set(instanceId, state);
    revision++;
    return true;
  }

  return {
    get revision() { return revision; },
    stateOf(instanceId) { return states.get(instanceId) ?? 'idle'; },
    errorOf(instanceId) { return errors.get(instanceId) ?? null; },
    markLoading(instanceId) { return set(instanceId, 'loading'); },
    markAttached(instanceId) { errors.delete(instanceId); return set(instanceId, 'attached'); },
    markFailed(instanceId, error) {
      errors.set(instanceId, error ? String(error?.message ?? error) : 'unknown error');
      return set(instanceId, 'failed');
    },
    /** Detaching is what invalidation does; it must be able to un-suppress a feature. */
    markDetached(instanceId) { errors.delete(instanceId); return set(instanceId, 'idle'); },
    attachedIds() {
      return [...states].filter(([, state]) => state === 'attached').map(([id]) => id);
    },
    failedIds() {
      return [...states].filter(([, state]) => state === 'failed').map(([id]) => id);
    },
    reset() {
      if (states.size === 0 && errors.size === 0) return false;
      states.clear();
      errors.clear();
      revision++;
      return true;
    },
    snapshot() { return new Map(states); },
  };
}

/**
 * Which procedural features may be hidden right now, and which must keep their proxy.
 *
 * `suppressed` requires every replacing instance to be `attached`. Anything else — one instance
 * still loading, one failed, one never requested because its cell is out of range — lands in
 * `retained`, with the reason, so the status panel can say why the old geometry is still there.
 */
export function resolveProceduralSuppression(registry, ledger) {
  const suppressed = [];
  const retained = [];
  const reasons = new Map();
  for (const replacement of registry.replacements) {
    const pending = [];
    const failed = [];
    for (const instanceId of replacement.instanceIds) {
      const state = ledger.stateOf(instanceId);
      if (state === 'attached') continue;
      if (state === 'failed') failed.push(instanceId);
      else pending.push(instanceId);
    }
    const featureId = replacement.target.featureId;
    if (pending.length === 0 && failed.length === 0) {
      suppressed.push({ featureId, kind: replacement.target.kind, policy: replacement.policy });
      continue;
    }
    const reason = failed.length > 0
      ? `${failed.length} authored instance(s) failed to load`
      : `${pending.length} authored instance(s) not attached yet`;
    retained.push({ featureId, kind: replacement.target.kind, reason, failed, pending });
    reasons.set(featureId, reason);
  }
  return {
    suppressed,
    retained,
    reasons,
    suppressedFeatureIds: suppressed.map((entry) => entry.featureId),
    retainedFeatureIds: retained.map((entry) => entry.featureId),
  };
}

function cellVisibility(distanceM, drawDistanceM, previouslyVisible, hysteresis) {
  // There is no direction to hysteresis against on the first plan (or for a newly introduced
  // cell after a registry revision), so use the manifest's literal draw-distance contract.
  if (typeof previouslyVisible !== 'boolean') return distanceM <= drawDistanceM;
  if (distanceM <= drawDistanceM * (1 - hysteresis)) return true;
  if (distanceM > drawDistanceM * (1 + hysteresis)) return false;
  return previouslyVisible;
}

/**
 * Plan one frame: visible cells, an LOD per instance, the distinct LOD URLs that need fetching,
 * and the byte/triangle cost of the result measured against the manifest's own budgets.
 *
 * `previous` is the plan returned last time. Passing it in is what makes the hysteresis work —
 * both cell visibility and LOD level are resolved relative to what was decided before.
 */
export function planCustomsAssetFrame({
  registry,
  camera,
  previous = null,
  ledger = null,
  drawDistanceM = null,
  hysteresis = CUSTOMS_ASSET_HYSTERESIS,
  maxCells = Infinity,
} = {}) {
  if (!registry) throw new Error('planCustomsAssetFrame requires a registry');
  const x = Number(camera?.x);
  const z = Number(camera?.z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    throw new Error('planCustomsAssetFrame requires a finite camera {x, z}');
  }
  const range = drawDistanceM ?? registry.manifest.budgets.drawDistanceM;
  const previousCellVisible = new Map(
    (previous?.cells ?? []).map((cell) => [cell.id, cell.visible]),
  );
  const previousLod = new Map(
    (previous?.instances ?? []).map((instance) => [instance.instanceId, instance.lodLevel]),
  );

  const cells = registry.cells.map((cell) => {
    const distanceM = cellDistanceM(cell, x, z);
    return {
      id: cell.id,
      distanceM,
      loadPriority: cell.loadPriority,
      visible: cellVisibility(distanceM, range, previousCellVisible.get(cell.id), hysteresis),
    };
  });
  // Nearest first, then the manifest's own priority as the tiebreak: whoever authored the scene
  // knows which cell is the one the player is looking at.
  cells.sort((a, b) => (a.distanceM - b.distanceM) || (b.loadPriority - a.loadPriority) || (a.id < b.id ? -1 : 1));
  let budgetedCells = 0;
  for (const cell of cells) {
    if (!cell.visible) continue;
    if (budgetedCells >= maxCells) { cell.visible = false; continue; }
    budgetedCells++;
  }

  const instances = [];
  const urls = new Map();
  const distinctAssets = new Set();
  let triangles = 0;
  for (const cell of cells) {
    if (!cell.visible) continue;
    for (const instance of registry.instancesByCell.get(cell.id) ?? []) {
      const asset = registry.assetsById.get(instance.assetId);
      const distanceM = Math.hypot(
        instance.transform.position.x - x,
        instance.transform.position.z - z,
      );
      const lodLevel = selectLodLevel(
        asset.lods,
        distanceM,
        previousLod.get(instance.id) ?? null,
        hysteresis,
      );
      const lod = asset.lods[lodLevel];
      instances.push({
        instanceId: instance.id,
        assetId: asset.id,
        assetKind: asset.kind,
        cellId: cell.id,
        stableId: instance.stableId,
        featureId: instance.featureId,
        floor: instance.floor,
        interior: asset.masks.interior,
        pickable: instance.pickable,
        picking: asset.proxies.picking,
        shadow: asset.proxies.shadow,
        collision: asset.proxies.collision,
        gltf: asset.gltf,
        bounds: asset.bounds,
        transform: instance.transform,
        lodLevel,
        url: lod.url,
        sha256: lod.sha256,
        bytes: lod.bytes,
        triangles: lod.triangles,
        distanceM,
        state: ledger ? ledger.stateOf(instance.id) : 'idle',
      });
      triangles += lod.triangles;
      distinctAssets.add(asset.id);
      if (!urls.has(lod.url)) {
        urls.set(lod.url, {
          url: lod.url,
          assetId: asset.id,
          lodLevel,
          sha256: lod.sha256,
          bytes: lod.bytes,
          distanceM,
          instanceIds: [],
        });
      }
      const request = urls.get(lod.url);
      request.distanceM = Math.min(request.distanceM, distanceM);
      request.instanceIds.push(instance.id);
    }
  }

  const requests = [...urls.values()].sort((a, b) => a.distanceM - b.distanceM);
  const bytes = requests.reduce((sum, request) => sum + request.bytes, 0);
  const budgets = registry.manifest.budgets;

  return Object.freeze({
    revision: registry.revision,
    ledgerRevision: ledger ? ledger.revision : 0,
    camera: { x, z },
    drawDistanceM: range,
    hysteresis,
    cells,
    visibleCellIds: cells.filter((cell) => cell.visible).map((cell) => cell.id),
    instances,
    requests,
    cost: {
      bytes,
      triangles,
      assets: distinctAssets.size,
      withinBudget: bytes <= budgets.totalBytes && triangles <= budgets.totalTriangles,
    },
    maxConcurrentLoads: budgets.maxConcurrentLoads,
    proceduralFallback: registry.isEmpty,
  });
}

/**
 * Did anything the renderer acts on actually change? Camera moves every frame; the plan almost
 * never does. Comparing plans is how the seam avoids re-running attach work sixty times a second.
 */
export function customsAssetPlanChanged(previous, next) {
  if (!previous) return true;
  if (previous.revision !== next.revision) return true;
  if (previous.ledgerRevision !== next.ledgerRevision) return true;
  if (previous.visibleCellIds.length !== next.visibleCellIds.length) return true;
  for (const [index, id] of next.visibleCellIds.entries()) {
    if (previous.visibleCellIds[index] !== id) return true;
  }
  if (previous.instances.length !== next.instances.length) return true;
  for (const [index, instance] of next.instances.entries()) {
    const before = previous.instances[index];
    if (before.instanceId !== instance.instanceId || before.lodLevel !== instance.lodLevel) return true;
  }
  return false;
}

/**
 * What the loader should do next: fetch these, in this order, and drop anything already
 * attached at this LOD. Instances whose cell left the plan are reported for detachment so the
 * ledger — and therefore procedural suppression — can be walked back.
 */
export function diffCustomsAssetPlan(previous, next) {
  const previousByInstance = new Map((previous?.instances ?? []).map((entry) => [entry.instanceId, entry]));
  const nextByInstance = new Map(next.instances.map((entry) => [entry.instanceId, entry]));
  const enter = [];
  const relod = [];
  for (const instance of next.instances) {
    const before = previousByInstance.get(instance.instanceId);
    if (!before) enter.push(instance);
    else if (before.lodLevel !== instance.lodLevel) relod.push(instance);
  }
  const leave = [...previousByInstance.values()].filter((entry) => !nextByInstance.has(entry.instanceId));
  return { enter, relod, leave };
}
