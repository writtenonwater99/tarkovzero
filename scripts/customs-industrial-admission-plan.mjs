// Receipt-driven candidate planner for the nine Customs industrial rail-yard landmarks.
//
// The industrial prop factory (scripts/industrial-prop-asset-factory/) authors three
// recognizable, original prototype families — a diesel shunter, a tanker wagon and a
// 40-foot ISO-style shipping container — and pins one hash/bytes/triangles/bounds receipt
// per (family, variant, LOD). This module turns those receipts, plus the exact landmark
// mapping (featureId -> {family, variant}) and the reviewed feature list, into a candidate
// manifest-v2 *fragment* (assets, instances, one bounded cell, reversible prop replacement
// records). It never writes the live scene manifest: the fragment is printed for a human to
// review and merge.
//
// Everything here is pure. No fetch, no three.js, no filesystem and no package dependency:
// the CLI at the bottom is the only impure part and it only reads files and writes to
// stdout/stderr. The fragment is assembled into a complete manifest and validated against
// src/customs-asset-manifest.js before it is returned, so a candidate that could not load is
// a blocker, not output.
//
// Two deliberate, documented reconciliations:
//   * The receipts declare a "base-center at (0,0,0)" pivot; the v2 manifest's `base-center`
//     enum additionally asserts the footprint is laterally centred within 1 mm, which the
//     factory only guarantees to 12 cm (and only to 2 mm at the base). The planner still
//     *validates* the receipt's base-center claim at the factory's own tolerance, but emits
//     the honest `pivot: 'origin'` — the GLB origin IS the base-center, and the runtime
//     (customs-asset-runtime.js) reads up/forward axes, not pivot, for seating.
//   * LOD switch distances are not receipt data; the runtime owns LOD selection. The
//     manifest schema still requires a declared `maxDistanceM`, so the planner emits a
//     deterministic default policy, marked as such rather than as evidence.

import {
  CUSTOMS_ASSET_ENUMS,
  CustomsAssetManifestError,
  emptyCustomsAssetManifest,
  normalizeCustomsAssetManifest,
} from '../src/customs-asset-manifest.js';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/+$/, '');

export const INDUSTRIAL_MAP_ID = 'customs';

/** The rail-yard scope every candidate cell must stay inside. */
export const INDUSTRIAL_SCOPE = Object.freeze({
  id: 'customs-industrial-rail-yard',
  center: Object.freeze({ x: 230, z: -110 }),
  widthM: 360,
  depthM: 300,
});

export const INDUSTRIAL_BASE_URL = 'assets/3d/customs/authored/';
export const INDUSTRIAL_EVIDENCE_SOURCE_ID = 'tarkovzero-industrial-original-authoring';
export const INDUSTRIAL_CELL_ID = 'industrial-rail-yard-cell';
export const INDUSTRIAL_CELL_MARGIN_M = 8;
export const INDUSTRIAL_CELL_PAD_M = Object.freeze({ below: 2, above: 6 });
export const INDUSTRIAL_REPLACEMENT_TARGET_KIND = 'prop';
export const INDUSTRIAL_REPLACEMENT_POLICY = 'hide-mesh-and-picking';

/** Deterministic LOD switch policy. Not evidence — see the header note. */
export const INDUSTRIAL_LOD_MAX_DISTANCE_M = Object.freeze([60, 140, 260]);

/** The shipping budgets the candidate is checked against (mirrors the live manifest). */
export const INDUSTRIAL_BUDGETS = Object.freeze({
  totalBytes: 48 * 1024 * 1024,
  totalTriangles: 4_000_000,
  perCellBytes: 12 * 1024 * 1024,
  perCellTriangles: 900_000,
  maxConcurrentLoads: 4,
  drawDistanceM: 260,
});

/** Recognized prototype families and the prop feature type each one belongs to. */
export const INDUSTRIAL_FAMILY_TYPE = Object.freeze({
  'diesel-shunter': 'railcar',
  'tanker-wagon': 'railcar',
  'shipping-container': 'container',
});
export const INDUSTRIAL_FAMILIES = Object.freeze(Object.keys(INDUSTRIAL_FAMILY_TYPE));

const INDUSTRIAL_FAMILY_LABEL = Object.freeze({
  'diesel-shunter': 'diesel shunter',
  'tanker-wagon': 'tanker wagon',
  'shipping-container': 'shipping container',
});

/**
 * The exact featureId -> prototype assignment reviewed in
 * scripts/industrial-prop-asset-factory/build_proof.py (`LANDMARK_MAPPING`). This is the
 * *only* thing that ties a landmark to a prototype: position/tolerance fuzzy matching is
 * deliberately not used here.
 */
export const INDUSTRIAL_LANDMARK_MAPPING = Object.freeze({
  'customs.prop.industrial_rail_yard.locomotive_west': Object.freeze({ family: 'diesel-shunter', variant: 'default' }),
  'customs.prop.industrial_rail_yard.locomotive_east': Object.freeze({ family: 'diesel-shunter', variant: 'default' }),
  'customs.prop.industrial_rail_yard.tanker_1': Object.freeze({ family: 'tanker-wagon', variant: 'default' }),
  'customs.prop.industrial_rail_yard.tanker_2': Object.freeze({ family: 'tanker-wagon', variant: 'default' }),
  'customs.prop.industrial_rail_yard.tanker_3': Object.freeze({ family: 'tanker-wagon', variant: 'default' }),
  'customs.prop.industrial_rail_yard.tanker_4': Object.freeze({ family: 'tanker-wagon', variant: 'default' }),
  'customs.prop.industrial_rail_yard.red_container_stack': Object.freeze({ family: 'shipping-container', variant: 'red' }),
  'customs.prop.industrial_rail_yard.red_container_west': Object.freeze({ family: 'shipping-container', variant: 'red' }),
  'customs.prop.industrial_rail_yard.red_container_east': Object.freeze({ family: 'shipping-container', variant: 'red' }),
});

export const INDUSTRIAL_ADMISSION_ERRORS = Object.freeze({
  MISSING_LANDMARK: 'ERR_ADMISSION_MISSING_LANDMARK',
  AMBIGUOUS_PROP: 'ERR_ADMISSION_AMBIGUOUS_PROP',
  DUPLICATE_TARGET: 'ERR_ADMISSION_DUPLICATE_TARGET',
  YAW_UNCERTAIN: 'ERR_ADMISSION_YAW_UNCERTAIN',
  RECEIPT_DRIFT: 'ERR_ADMISSION_RECEIPT_DRIFT',
  UNSAFE_PATH: 'ERR_ADMISSION_UNSAFE_PATH',
  BUDGET_OVERFLOW: 'ERR_ADMISSION_BUDGET_OVERFLOW',
  UNSUPPORTED_REPLACEMENT_KIND: 'ERR_ADMISSION_UNSUPPORTED_REPLACEMENT_KIND',
  OUT_OF_SCOPE: 'ERR_ADMISSION_OUT_OF_SCOPE',
  INTERNAL_VALIDATION: 'ERR_ADMISSION_INTERNAL_VALIDATION',
});

/** A typed, fail-closed admission blocker. */
export class IndustrialAdmissionBlocker extends Error {
  constructor(code, path, message) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'IndustrialAdmissionBlocker';
    this.code = code;
    this.path = path;
  }

  toJSON() {
    return { code: this.code, path: this.path, message: this.message };
  }
}

function block(code, path, message) {
  return new IndustrialAdmissionBlocker(code, path, message);
}

const RECEIPT_SCHEMA_VERSION = 1;
const RECEIPT_DOCUMENT_TYPE = 'tarkovzero-customs-original-industrial-prop-receipt';
const RECEIPT_STATUS = 'offline-proof-only-not-live';
const RECEIPT_PIVOT_CONTRACT = Object.freeze({
  units: 'metres',
  pivot: 'base-center at (0,0,0)',
  gltfFrame: '+X length, +Y up, +Z width',
});
// Mirrors the factory validator (validate_industrial_props.py): the base sits within 2 mm of
// Y=0 and the footprint is centred within 12 cm. The v2 manifest's own base-center assertion
// is stricter (1 mm), which is why the emitted pivot is `origin` rather than `base-center`.
const BASE_CENTER_BASE_TOLERANCE_M = 2e-3;
const BASE_CENTER_LATERAL_TOLERANCE_M = 0.12;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SAFE_BASENAME_CHARS = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LOD_LEVELS = Object.freeze([0, 1, 2]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// ---------------------------------------------------------------------------
// identity helpers

export function prototypeIdentityKey(family, variant) {
  return `${family}/${variant}`;
}

export function lodIdentityKey(family, variant, lod) {
  return `${family}/${variant}/${lod}`;
}

/** The factory's deterministic GLB filename for a (family, variant, LOD). */
export function expectedLodFile(family, variant, lod) {
  const middle = variant === 'default' ? '' : `-${variant}`;
  return `${family}${middle}-lod${lod}.glb`;
}

export function slugOfFeatureId(featureId) {
  const index = featureId.lastIndexOf('.');
  return index === -1 ? featureId : featureId.slice(index + 1);
}

export function prototypeAssetId(family, variant) {
  return variant === 'default' ? `industrial-${family}` : `industrial-${family}-${variant}`;
}

export function instanceIdFor(featureId) {
  return `industrial-${slugOfFeatureId(featureId)}`;
}

export function instanceStableIdFor(family, variant, featureId) {
  return `customs.authored.${family}.${variant}.${slugOfFeatureId(featureId)}`;
}

export function replacementIdFor(featureId) {
  return `replace-industrial-${slugOfFeatureId(featureId)}`;
}

function prototypeLabel(family, variant) {
  const base = INDUSTRIAL_FAMILY_LABEL[family] ?? family;
  return variant === 'default' ? base : `${base} · ${variant}`;
}

// ---------------------------------------------------------------------------
// terrain sampling (bilinear over the customs-3d.json heightfield)

export function sampleTerrainHeight(terrain, x, z) {
  const { x0, z0, step, cols, rows, heights } = terrain;
  if (cols < 2 || rows < 2) {
    return heights.length > 0 ? heights[0] : 0;
  }
  const gx = (x - x0) / step;
  const gz = (z - z0) / step;
  const clampIndex = (value, max) => Math.max(0, Math.min(max, value));
  const ix = clampIndex(Math.floor(gx), cols - 2);
  const iz = clampIndex(Math.floor(gz), rows - 2);
  const clampT = (value) => Math.max(0, Math.min(1, value));
  const tx = clampT(gx - ix);
  const tz = clampT(gz - iz);
  const at = (column, row) => heights[row * cols + column];
  const top = at(ix, iz) + (at(ix + 1, iz) - at(ix, iz)) * tx;
  const bottom = at(ix, iz + 1) + (at(ix + 1, iz + 1) - at(ix, iz + 1)) * tx;
  const height = top + (bottom - top) * tz;
  return Number.isFinite(height) ? height : 0;
}

export function makeTerrainSampler(terrain) {
  return (x, z) => sampleTerrainHeight(terrain, x, z);
}

// ---------------------------------------------------------------------------
// receipt normalization

function readVector3(value, path) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw block(INDUSTRIAL_ADMISSION_ERRORS.RECEIPT_DRIFT, path, 'must be a 3-element array');
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      throw block(INDUSTRIAL_ADMISSION_ERRORS.RECEIPT_DRIFT, `${path}[${index}]`, 'must be a finite number');
    }
    return entry;
  });
}

function normalizeReceipt(receipt, index) {
  const path = `receipts[${index}]`;
  if (!isPlainObject(receipt)) {
    throw block(INDUSTRIAL_ADMISSION_ERRORS.RECEIPT_DRIFT, path, 'must be an object');
  }
  if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION
    || receipt.documentType !== RECEIPT_DOCUMENT_TYPE
    || receipt.status !== RECEIPT_STATUS) {
    throw block(INDUSTRIAL_ADMISSION_ERRORS.RECEIPT_DRIFT, path, 'does not match the industrial prop receipt schema');
  }

  const asset = receipt.asset;
  if (!isPlainObject(asset)) {
    throw block(INDUSTRIAL_ADMISSION_ERRORS.RECEIPT_DRIFT, `${path}.asset`, 'is missing the asset identity');
  }
  const { family, variant, lod } = asset;
  if (typeof family !== 'string' || family.length === 0) {
    throw block(INDUSTRIAL_ADMISSION_ERRORS.RECEIPT_DRIFT, `${path}.asset.family`, 'must be a non-empty family name');
  }
  if (typeof variant !== 'string' || variant.length === 0) {
    throw block(INDUSTRIAL_ADMISSION_ERRORS.RECEIPT_DRIFT, `${path}.asset.variant`, 'must be a non-empty variant name');
  }
  if (!LOD_LEVELS.includes(lod)) {
    throw block(INDUSTRIAL_ADMISSION_ERRORS.RECEIPT_DRIFT, `${path}.asset.lod`, 'must be 0, 1 or 2');
  }

  const contract = asset.axisPivotContract;
  if (!isPlainObject(contract)) {
    throw block(INDUSTRIAL_ADMISSION_ERRORS.RECEIPT_DRIFT, `${path}.asset.axisPivotContract`, 'is missing the pivot contract');
  }
  for (const [field, expected] of Object.entries(RECEIPT_PIVOT_CONTRACT)) {
    if (contract[field] !== expected) {
      throw block(
        INDUSTRIAL_ADMISSION_ERRORS.RECEIPT_DRIFT,
        `${path}.asset.axisPivotContract.${field}`,
        `must be ${expected}`,
      );
    }
  }

  const output = receipt.output;
  if (!isPlainObject(output)) {
    throw block(INDUSTRIAL_ADMISSION_ERRORS.RECEIPT_DRIFT, `${path}.output`, 'is missing the output record');
  }
  const file = output.file;
  if (typeof file !== 'string' || !SAFE_BASENAME_CHARS.test(file)) {
    throw block(INDUSTRIAL_ADMISSION_ERRORS.UNSAFE_PATH, `${path}.output.file`, 'must be a safe .glb basename');
  }
  if (!file.endsWith('.glb')) {
    throw block(INDUSTRIAL_ADMISSION_ERRORS.RECEIPT_DRIFT, `${path}.output.file`, 'must name a .glb file');
  }
  const expectedFile = expectedLodFile(family, variant, lod);
  if (file !== expectedFile) {
    throw block(
      INDUSTRIAL_ADMISSION_ERRORS.RECEIPT_DRIFT,
      `${path}.output.file`,
      `must be ${expectedFile} for this identity`,
    );
  }
  if (typeof output.sha256 !== 'string' || !SHA256_PATTERN.test(output.sha256)) {
    throw block(INDUSTRIAL_ADMISSION_ERRORS.RECEIPT_DRIFT, `${path}.output.sha256`, 'must be a sha256:<64 hex> hash');
  }
  if (!Number.isSafeInteger(output.bytes) || output.bytes <= 0) {
    throw block(INDUSTRIAL_ADMISSION_ERRORS.RECEIPT_DRIFT, `${path}.output.bytes`, 'must be a positive safe integer');
  }
  if (!Number.isSafeInteger(output.triangles) || output.triangles <= 0) {
    throw block(INDUSTRIAL_ADMISSION_ERRORS.RECEIPT_DRIFT, `${path}.output.triangles`, 'must be a positive safe integer');
  }

  const bounds = output.boundsGltfM;
  if (!isPlainObject(bounds)) {
    throw block(INDUSTRIAL_ADMISSION_ERRORS.RECEIPT_DRIFT, `${path}.output.boundsGltfM`, 'is missing the glTF bounds');
  }
  const min = readVector3(bounds.min, `${path}.output.boundsGltfM.min`);
  const max = readVector3(bounds.max, `${path}.output.boundsGltfM.max`);
  for (let axis = 0; axis < 3; axis += 1) {
    if (!(max[axis] > min[axis])) {
      throw block(INDUSTRIAL_ADMISSION_ERRORS.RECEIPT_DRIFT, `${path}.output.boundsGltfM`, 'max must exceed min on every axis');
    }
  }
  if (Math.abs(min[1]) > BASE_CENTER_BASE_TOLERANCE_M) {
    throw block(
      INDUSTRIAL_ADMISSION_ERRORS.RECEIPT_DRIFT,
      `${path}.output.boundsGltfM.min[1]`,
      'base-center pivot requires the base to touch Y=0',
    );
  }
  const centerX = (min[0] + max[0]) / 2;
  const centerZ = (min[2] + max[2]) / 2;
  if (Math.abs(centerX) > BASE_CENTER_LATERAL_TOLERANCE_M || Math.abs(centerZ) > BASE_CENTER_LATERAL_TOLERANCE_M) {
    throw block(
      INDUSTRIAL_ADMISSION_ERRORS.RECEIPT_DRIFT,
      `${path}.output.boundsGltfM`,
      'base-center pivot requires a laterally centred footprint',
    );
  }

  return {
    family,
    variant,
    lod,
    file,
    sha256: output.sha256,
    bytes: output.bytes,
    triangles: output.triangles,
    bounds: { min: { x: min[0], y: min[1], z: min[2] }, max: { x: max[0], y: max[1], z: max[2] } },
  };
}

// ---------------------------------------------------------------------------
// landmark resolution (exact featureId -> prototype, no fuzzy matching)

function normalizeLandmarkList(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length === 0) {
    throw block(INDUSTRIAL_ADMISSION_ERRORS.MISSING_LANDMARK, 'landmarks', 'must be a non-empty array');
  }
  return landmarks.map((landmark, index) => {
    const path = `landmarks[${index}]`;
    if (!isPlainObject(landmark)) {
      throw block(INDUSTRIAL_ADMISSION_ERRORS.MISSING_LANDMARK, path, 'must be an object');
    }
    const { featureId } = landmark;
    if (typeof featureId !== 'string' || featureId.length === 0) {
      throw block(INDUSTRIAL_ADMISSION_ERRORS.MISSING_LANDMARK, `${path}.featureId`, 'must be a non-empty feature ID');
    }
    for (const axis of ['x', 'z']) {
      if (typeof landmark[axis] !== 'number' || !Number.isFinite(landmark[axis])) {
        throw block(INDUSTRIAL_ADMISSION_ERRORS.MISSING_LANDMARK, `${path}.${axis}`, 'must be a finite number');
      }
    }
    const type = landmark.type === undefined ? null : landmark.type;
    if (type !== null && (typeof type !== 'string' || type.length === 0)) {
      throw block(INDUSTRIAL_ADMISSION_ERRORS.MISSING_LANDMARK, `${path}.type`, 'must be a non-empty string when present');
    }
    return { featureId, type, x: landmark.x, z: landmark.z };
  });
}

export function resolveIndustrialLandmarks(landmarks, mapping) {
  if (!isPlainObject(mapping)) {
    throw block(INDUSTRIAL_ADMISSION_ERRORS.MISSING_LANDMARK, 'mapping', 'must be an object');
  }
  const list = normalizeLandmarkList(landmarks);
  const seen = new Set();
  const resolved = [];
  for (const landmark of list) {
    if (seen.has(landmark.featureId)) {
      throw block(
        INDUSTRIAL_ADMISSION_ERRORS.DUPLICATE_TARGET,
        `landmarks`,
        `feature ${landmark.featureId} is listed more than once`,
      );
    }
    seen.add(landmark.featureId);

    const assignment = mapping[landmark.featureId];
    if (!isPlainObject(assignment)) {
      throw block(
        INDUSTRIAL_ADMISSION_ERRORS.MISSING_LANDMARK,
        `mapping.${landmark.featureId}`,
        'has no exact prototype assignment',
      );
    }
    const { family, variant } = assignment;
    if (typeof family !== 'string' || typeof variant !== 'string') {
      throw block(
        INDUSTRIAL_ADMISSION_ERRORS.AMBIGUOUS_PROP,
        `mapping.${landmark.featureId}`,
        'must resolve to exactly one {family, variant}',
      );
    }
    if (!INDUSTRIAL_FAMILIES.includes(family)) {
      throw block(
        INDUSTRIAL_ADMISSION_ERRORS.AMBIGUOUS_PROP,
        `mapping.${landmark.featureId}.family`,
        `unknown prototype family ${family}`,
      );
    }
    if (landmark.type !== null && INDUSTRIAL_FAMILY_TYPE[family] !== landmark.type) {
      throw block(
        INDUSTRIAL_ADMISSION_ERRORS.AMBIGUOUS_PROP,
        `mapping.${landmark.featureId}.family`,
        `family ${family} is a ${INDUSTRIAL_FAMILY_TYPE[family]}, but the feature is typed ${landmark.type}`,
      );
    }
    resolved.push({ ...landmark, family, variant, slug: slugOfFeatureId(landmark.featureId) });
  }
  resolved.sort((a, b) => (a.featureId < b.featureId ? -1 : a.featureId > b.featureId ? 1 : 0));
  return resolved;
}

// ---------------------------------------------------------------------------
// prototype derivation (receipt grouping + drift detection)

export function deriveIndustrialPrototypes(resolved, receipts) {
  const required = new Set(resolved.map((entry) => prototypeIdentityKey(entry.family, entry.variant)));
  const byLod = new Map();
  const files = new Map();
  const hashes = new Map();

  receipts.forEach((receipt, index) => {
    const record = normalizeReceipt(receipt, index);
    const key = lodIdentityKey(record.family, record.variant, record.lod);
    if (byLod.has(key)) {
      throw block(INDUSTRIAL_ADMISSION_ERRORS.RECEIPT_DRIFT, `receipts[${index}]`, `duplicates identity ${key}`);
    }
    byLod.set(key, record);
    const fileOwner = files.get(record.file);
    if (fileOwner !== undefined) {
      throw block(
        INDUSTRIAL_ADMISSION_ERRORS.RECEIPT_DRIFT,
        `receipts[${index}].output.file`,
        `is claimed by both ${fileOwner} and ${key}`,
      );
    }
    files.set(record.file, key);
    const hashOwner = hashes.get(record.sha256);
    if (hashOwner !== undefined) {
      throw block(
        INDUSTRIAL_ADMISSION_ERRORS.RECEIPT_DRIFT,
        `receipts[${index}].output.sha256`,
        `is shared by ${hashOwner} and ${key}`,
      );
    }
    hashes.set(record.sha256, key);
  });

  const requiredPairs = [...required].sort();
  const prototypes = [];
  for (const pair of requiredPairs) {
    const [family, variant] = pair.split('/');
    const lods = LOD_LEVELS.map((lod) => byLod.get(lodIdentityKey(family, variant, lod)));
    if (lods.some((record) => record === undefined)) {
      throw block(
        INDUSTRIAL_ADMISSION_ERRORS.RECEIPT_DRIFT,
        `prototype ${pair}`,
        'is missing a LOD 0/1/2 receipt',
      );
    }
    for (let level = 1; level < lods.length; level += 1) {
      if (!(lods[level].triangles < lods[level - 1].triangles)) {
        throw block(
          INDUSTRIAL_ADMISSION_ERRORS.RECEIPT_DRIFT,
          `prototype ${pair} lod${level}.triangles`,
          'LOD triangle counts must strictly fall',
        );
      }
      if (!(lods[level].bytes < lods[level - 1].bytes)) {
        throw block(
          INDUSTRIAL_ADMISSION_ERRORS.RECEIPT_DRIFT,
          `prototype ${pair} lod${level}.bytes`,
          'LOD byte counts must strictly fall',
        );
      }
    }
    prototypes.push({ family, variant, lods });
  }
  return prototypes;
}

// ---------------------------------------------------------------------------
// fragment construction

function buildAsset(prototype) {
  const { family, variant, lods } = prototype;
  const lod0 = lods[0].bounds;
  return {
    id: prototypeAssetId(family, variant),
    kind: 'prototype',
    name: `Customs ${prototypeLabel(family, variant)} prototype`,
    sourceId: INDUSTRIAL_EVIDENCE_SOURCE_ID,
    gltf: { unit: 'metre', upAxis: '+y', forwardAxis: '+x', pivot: 'origin' },
    bounds: { min: { ...lod0.min }, max: { ...lod0.max } },
    materialIds: [],
    masks: { floors: ['ground'], interior: false },
    proxies: {
      picking: { shape: 'box', inflateM: 0 },
      shadow: { mode: 'both' },
      collision: { shape: 'none' },
    },
    lods: lods.map((record, index) => ({
      level: index,
      url: `industrial/${record.file}`,
      sha256: record.sha256,
      bytes: record.bytes,
      triangles: record.triangles,
      maxDistanceM: INDUSTRIAL_LOD_MAX_DISTANCE_M[index],
    })),
  };
}

function assertYaw(yaw, resolved) {
  for (const entry of resolved) {
    const value = yaw[entry.featureId];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw block(
        INDUSTRIAL_ADMISSION_ERRORS.YAW_UNCERTAIN,
        `yaw.${entry.featureId}`,
        'yaw is missing or non-finite; the planner will not fabricate it',
      );
    }
    if (Math.abs(value) > 360) {
      throw block(INDUSTRIAL_ADMISSION_ERRORS.YAW_UNCERTAIN, `yaw.${entry.featureId}`, 'yaw must be within ±360 degrees');
    }
  }
}

function assertBudgetsFit(budgets, assets, instances, assetsById) {
  for (const [field, path] of [
    ['totalBytes', 'budgets.totalBytes'],
    ['totalTriangles', 'budgets.totalTriangles'],
    ['perCellBytes', 'budgets.perCellBytes'],
    ['perCellTriangles', 'budgets.perCellTriangles'],
  ]) {
    if (!Number.isSafeInteger(budgets[field]) || budgets[field] < 0) {
      throw block(INDUSTRIAL_ADMISSION_ERRORS.INTERNAL_VALIDATION, path, 'must be a non-negative safe integer');
    }
  }
  if (budgets.perCellBytes > budgets.totalBytes || budgets.perCellTriangles > budgets.totalTriangles) {
    throw block(INDUSTRIAL_ADMISSION_ERRORS.INTERNAL_VALIDATION, 'budgets', 'per-cell budgets must not exceed the totals');
  }

  const totalBytes = assets.reduce((sum, asset) => sum + asset.lods.reduce((s, lod) => s + lod.bytes, 0), 0);
  const sceneTriangles = instances.reduce(
    (sum, instance) => sum + assetsById.get(instance.assetId).lods[0].triangles,
    0,
  );
  if (totalBytes > budgets.totalBytes) {
    throw block(
      INDUSTRIAL_ADMISSION_ERRORS.BUDGET_OVERFLOW,
      'delivery.assets',
      `declare ${totalBytes} bytes, over the ${budgets.totalBytes} byte budget`,
    );
  }
  if (sceneTriangles > budgets.totalTriangles) {
    throw block(
      INDUSTRIAL_ADMISSION_ERRORS.BUDGET_OVERFLOW,
      'delivery.instances',
      `draw ${sceneTriangles} LOD0 triangles, over the ${budgets.totalTriangles} triangle budget`,
    );
  }
  if (totalBytes > budgets.perCellBytes) {
    throw block(
      INDUSTRIAL_ADMISSION_ERRORS.BUDGET_OVERFLOW,
      'delivery.cells[0]',
      `needs ${totalBytes} bytes, over the ${budgets.perCellBytes} per-cell budget`,
    );
  }
  if (sceneTriangles > budgets.perCellTriangles) {
    throw block(
      INDUSTRIAL_ADMISSION_ERRORS.BUDGET_OVERFLOW,
      'delivery.cells[0]',
      `draws ${sceneTriangles} LOD0 triangles, over the ${budgets.perCellTriangles} per-cell budget`,
    );
  }
  return { totalBytes, sceneTriangles };
}

export function buildIndustrialAdmissionFragment({ resolved, prototypes, yaw, terrainY, budgets, replacementTargetKinds, scope }) {
  const kinds = replacementTargetKinds ?? CUSTOMS_ASSET_ENUMS.replacementTargetKinds;
  if (!kinds.includes(INDUSTRIAL_REPLACEMENT_TARGET_KIND)) {
    throw block(
      INDUSTRIAL_ADMISSION_ERRORS.UNSUPPORTED_REPLACEMENT_KIND,
      'replacementTargetKinds',
      `schema does not support replacement target kind ${INDUSTRIAL_REPLACEMENT_TARGET_KIND}`,
    );
  }

  const assets = prototypes.map(buildAsset);
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));

  assertYaw(yaw, resolved);

  const instances = resolved.map((entry) => {
    const height = terrainY(entry.x, entry.z);
    if (typeof height !== 'number' || !Number.isFinite(height)) {
      throw block(INDUSTRIAL_ADMISSION_ERRORS.INTERNAL_VALIDATION, 'terrainY', 'must return a finite height');
    }
    return {
      id: instanceIdFor(entry.featureId),
      assetId: prototypeAssetId(entry.family, entry.variant),
      cellId: INDUSTRIAL_CELL_ID,
      stableId: instanceStableIdFor(entry.family, entry.variant, entry.featureId),
      featureId: entry.featureId,
      label: prototypeLabel(entry.family, entry.variant),
      pickable: true,
      transform: {
        position: { x: entry.x, y: height, z: entry.z },
        rotation: { yawDeg: yaw[entry.featureId] },
      },
      floor: 'ground',
    };
  });

  const xs = instances.map((instance) => instance.transform.position.x);
  const zs = instances.map((instance) => instance.transform.position.z);
  const ys = instances.map((instance) => instance.transform.position.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const cell = {
    id: INDUSTRIAL_CELL_ID,
    center: { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 },
    widthM: (maxX - minX) + 2 * INDUSTRIAL_CELL_MARGIN_M,
    depthM: (maxZ - minZ) + 2 * INDUSTRIAL_CELL_MARGIN_M,
    minY: minY - INDUSTRIAL_CELL_PAD_M.below,
    maxY: maxY + INDUSTRIAL_CELL_PAD_M.above,
    loadPriority: 0,
    instanceIds: instances.map((instance) => instance.id),
  };

  const scopeBounds = {
    minX: scope.center.x - scope.widthM / 2,
    maxX: scope.center.x + scope.widthM / 2,
    minZ: scope.center.z - scope.depthM / 2,
    maxZ: scope.center.z + scope.depthM / 2,
  };
  const cellBounds = {
    minX: cell.center.x - cell.widthM / 2,
    maxX: cell.center.x + cell.widthM / 2,
    minZ: cell.center.z - cell.depthM / 2,
    maxZ: cell.center.z + cell.depthM / 2,
  };
  if (
    cellBounds.minX < scopeBounds.minX
    || cellBounds.maxX > scopeBounds.maxX
    || cellBounds.minZ < scopeBounds.minZ
    || cellBounds.maxZ > scopeBounds.maxZ
  ) {
    throw block(INDUSTRIAL_ADMISSION_ERRORS.OUT_OF_SCOPE, 'delivery.cells[0]', 'extends outside the rail-yard scope');
  }

  const replacements = resolved.map((entry) => ({
    id: replacementIdFor(entry.featureId),
    target: { kind: INDUSTRIAL_REPLACEMENT_TARGET_KIND, featureId: entry.featureId },
    instanceIds: [instanceIdFor(entry.featureId)],
    policy: INDUSTRIAL_REPLACEMENT_POLICY,
    notes: 'Reversible only after the authored prototype attaches.',
  }));

  assertBudgetsFit(budgets, assets, instances, assetsById);

  return { assets, instances, cells: [cell], replacements };
}

// ---------------------------------------------------------------------------
// evidence + self-validation + result assembly

function buildEvidenceSource() {
  return {
    id: INDUSTRIAL_EVIDENCE_SOURCE_ID,
    kind: 'authored',
    title: 'TarkovZero industrial prop original-authored prototypes',
    holder: 'TarkovZero',
    license: 'Project-local original work',
    licenseUrl: 'https://github.com/writtenonwater99/tarkovzero',
    retrievedAt: '2026-08-31',
    notes: 'Original procedural geometry and PBR textures; no copied game mesh, topology, UV, texture pixels, shaders, brands, or baked lighting.',
  };
}

function assembleAndValidate(fragment, evidenceSources, budgets, scope) {
  const manifest = {
    ...emptyCustomsAssetManifest({ scope, budgets }),
    evidence: { sources: evidenceSources, observations: [] },
    delivery: {
      baseUrl: INDUSTRIAL_BASE_URL,
      materials: [],
      assets: fragment.assets,
      instances: fragment.instances,
      cells: fragment.cells,
      replacements: fragment.replacements,
    },
  };
  try {
    return normalizeCustomsAssetManifest(manifest);
  } catch (error) {
    if (error instanceof CustomsAssetManifestError) {
      const code = error.code === 'ERR_ASSET_MANIFEST_BUDGET'
        ? INDUSTRIAL_ADMISSION_ERRORS.BUDGET_OVERFLOW
        : INDUSTRIAL_ADMISSION_ERRORS.INTERNAL_VALIDATION;
      throw block(code, error.path, error.message);
    }
    throw error;
  }
}

function planAdmission(input) {
  const landmarks = input.landmarks;
  const mapping = input.mapping ?? {};
  const receipts = input.receipts ?? [];
  const yaw = input.yaw ?? {};
  const terrainY = input.terrainY ?? (() => 0);
  const budgets = input.budgets ?? INDUSTRIAL_BUDGETS;
  const replacementTargetKinds = input.replacementTargetKinds ?? CUSTOMS_ASSET_ENUMS.replacementTargetKinds;
  const scope = input.scope ?? INDUSTRIAL_SCOPE;

  const resolved = resolveIndustrialLandmarks(landmarks, mapping);
  const prototypes = deriveIndustrialPrototypes(resolved, receipts);
  const fragment = buildIndustrialAdmissionFragment({
    resolved,
    prototypes,
    yaw,
    terrainY,
    budgets,
    replacementTargetKinds,
    scope,
  });
  const evidenceSources = [buildEvidenceSource()];
  const normalized = assembleAndValidate(fragment, evidenceSources, budgets, scope);

  const totalBytes = fragment.assets.reduce(
    (sum, asset) => sum + asset.lods.reduce((s, lod) => s + lod.bytes, 0),
    0,
  );
  const assetsById = new Map(fragment.assets.map((asset) => [asset.id, asset]));
  const sceneTriangles = fragment.instances.reduce(
    (sum, instance) => sum + assetsById.get(instance.assetId).lods[0].triangles,
    0,
  );

  return {
    status: 'ok',
    fragment,
    evidenceSources,
    derivation: {
      prototypes: prototypes.map((prototype) => ({
        family: prototype.family,
        variant: prototype.variant,
        assetId: prototypeAssetId(prototype.family, prototype.variant),
        lodCount: prototype.lods.length,
      })),
      stackEnvelopeDerived: false,
      stackEnvelopeNote: 'No stacked or wide container geometry is present in the receipts, so red_container_stack is placed as a single standard container — not a near-1:1 stack.',
    },
    notes: [
      'Offline candidate only — not promoted to the live scene manifest.',
      'Prototypes are recognized silhouettes from reviewed scalar proportions; they are not near-1:1 replacements and carry no tactical, collision or source-game-equivalence claim.',
      'Yaw and terrain height are planner inputs, not receipt data. LOD switch distances are deterministic planner defaults, not evidence.',
      'The receipt pivot is base-center at (0,0,0); the emitted manifest pivot is origin because the v2 base-center assertion is stricter than the factory guarantee (see module header).',
    ],
    totals: {
      assets: fragment.assets.length,
      instances: fragment.instances.length,
      cells: fragment.cells.length,
      replacements: fragment.replacements.length,
      prototypes: prototypes.length,
      totalBytes,
      lod0Triangles: sceneTriangles,
      normalizedInstances: normalized.totals.instances,
    },
  };
}

/**
 * Plan a candidate admission fragment for the nine industrial rail-yard landmarks. Pure:
 * never mutates its inputs, never reads or writes anything. Returns `{status:'ok', …}` or
 * `{status:'blocked', blocker:{code,path,message}}`.
 */
export function planCustomsIndustrialAdmission(input) {
  try {
    return planAdmission(input);
  } catch (error) {
    if (error instanceof IndustrialAdmissionBlocker) {
      return { status: 'blocked', blocker: error.toJSON() };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// opt-in CLI — reads inputs, prints the candidate JSON to stdout only

function parseCliArgs(argv) {
  const args = {
    help: false,
    features: null,
    terrain: null,
    mapping: null,
    yawFile: null,
    receipt: [],
    yaw: [],
  };
  const value = (index, flag) => {
    if (index >= argv.length) throw new Error(`${flag} requires a value`);
    return argv[index];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--features') {
      args.features = value(++index, arg);
    } else if (arg === '--terrain') {
      args.terrain = value(++index, arg);
    } else if (arg === '--mapping') {
      args.mapping = value(++index, arg);
    } else if (arg === '--yaw-file') {
      args.yawFile = value(++index, arg);
    } else if (arg === '--receipt') {
      args.receipt.push(value(++index, arg));
    } else if (arg === '--yaw') {
      args.yaw.push(value(++index, arg));
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function parsePropFeatures(document) {
  const features = document?.features;
  if (!Array.isArray(features)) throw new Error('features document must carry a features array');
  return features.map((feature, index) => {
    const match = feature?.match;
    const position = match?.position;
    if (typeof feature.featureId !== 'string' || !Array.isArray(position) || position.length !== 2) {
      throw new Error(`features[${index}] must carry featureId and match.position [x, z]`);
    }
    return { featureId: feature.featureId, type: match.type, x: position[0], z: position[1] };
  });
}

const CLI_USAGE = [
  'Usage: node scripts/customs-industrial-admission-plan.mjs [options]',
  '  --receipt <path>        one industrial prop receipt (repeat; needs the 9 referenced receipts)',
  '  --yaw <featureId>=<deg> exact yaw for one landmark (repeat)',
  '  --yaw-file <path>       JSON object {featureId: yawDeg}',
  '  --features <path>       prop feature list (default data/customs-prop-features.json)',
  '  --terrain <path>        terrain heightfield (default public/data/customs-3d.json)',
  '  --mapping <path>        JSON {featureId: {family, variant}} (default: reviewed mapping)',
  '  --help                  print this usage',
].join('\n');

async function runCli(argv, { readFile, stdout, stderr }) {
  const args = parseCliArgs(argv);
  if (args.help) {
    stderr.write(`${CLI_USAGE}\n`);
    return 0;
  }
  const featuresPath = args.features ?? `${REPO_ROOT}/data/customs-prop-features.json`;
  const terrainPath = args.terrain ?? `${REPO_ROOT}/public/data/customs-3d.json`;

  const featuresDocument = JSON.parse(await readFile(featuresPath, 'utf8'));
  const landmarks = parsePropFeatures(featuresDocument);
  const mapping = args.mapping
    ? JSON.parse(await readFile(args.mapping, 'utf8'))
    : INDUSTRIAL_LANDMARK_MAPPING;
  const receipts = [];
  for (const path of args.receipt) {
    receipts.push(JSON.parse(await readFile(path, 'utf8')));
  }
  const terrainDocument = JSON.parse(await readFile(terrainPath, 'utf8'));
  const terrainY = makeTerrainSampler(terrainDocument.terrain);

  const yaw = args.yawFile ? { ...JSON.parse(await readFile(args.yawFile, 'utf8')) } : {};
  for (const entry of args.yaw) {
    const separator = entry.indexOf('=');
    if (separator === -1) throw new Error(`--yaw must be featureId=degrees, got ${entry}`);
    yaw[entry.slice(0, separator)] = Number(entry.slice(separator + 1));
  }

  const result = planCustomsIndustrialAdmission({ landmarks, mapping, receipts, yaw, terrainY });
  if (result.status === 'ok') {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  stderr.write(`${JSON.stringify(result, null, 2)}\n`);
  return 1;
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  import('node:fs/promises').then(async ({ readFile }) => {
    const code = await runCli(process.argv.slice(2), {
      readFile,
      stdout: process.stdout,
      stderr: process.stderr,
    });
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`industrial admission plan failed: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
