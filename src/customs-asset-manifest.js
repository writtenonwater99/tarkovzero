// Pure, renderer-neutral contract for the Customs authored-asset manifest, schema v2.
//
// v1 shipped a flat `chunks` array whose only real invariant was "has a url and a stableId".
// That is not enough to let near-1:1 authored geometry into a scene that is already drawing a
// procedural approximation of the same ground: two independent placements of the same building
// double the shadows, double the picking hits, and disagree about which floor a marker sits on.
//
// v2 therefore states, up front and refuses to load without:
//
//   * where the bytes came from and under what licence (`evidence`), kept strictly apart from
//     what is shipped to the renderer (`delivery`) — truth data is not delivery data, and the
//     delivery side may only reference evidence by ID;
//   * what each asset IS in metres: glTF unit, up axis, forward axis, pivot, local bounds. An
//     asset that does not say which way is up cannot be seated on measured terrain;
//   * every LOD's URL, content hash, byte count and triangle count, strictly decreasing in cost
//     and strictly increasing in switch distance, so a budget can be checked before a fetch;
//   * which procedural feature each authored instance REPLACES, by stable feature ID. The
//     runtime suppresses the procedural original only once the replacement is actually attached
//     (see customs-asset-runtime.js) — a failed download leaves the proxy standing rather than
//     punching a hole in the map;
//   * explicit picking / shadow / collision proxy policy per asset, so a 200k-triangle mesh is
//     not silently made the raycast target;
//   * floor and interior masks, so the floor resolver keeps working under authored geometry.
//
// An empty v2 manifest (no materials, no assets, no instances, no cells, no replacements) is
// valid and means "draw the procedural fallback": that is the state the map ships in today.
//
// Everything here is pure. No fetch, no three.js, no filesystem — the browser adapter and the
// Node tests validate the exact same bytes.

export const CUSTOMS_ASSET_SCHEMA_VERSION = 2;
export const CUSTOMS_ASSET_SOURCE_FRAME = 'eft-unity-world-metres-y-up';
export const CUSTOMS_ASSET_RUNTIME_FRAME = 'three-z-up-metres';
export const CUSTOMS_ASSET_RUNTIME_FROM_SOURCE = '[-x, -z, y]';

const MAP_ID = 'customs';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FEATURE_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/;
const SAFE_PATH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HTTPS_URL_MAX = 512;

const AXES = Object.freeze(['+x', '-x', '+y', '-y', '+z', '-z']);
const GLTF_UNITS = Object.freeze(['metre']);
const GLTF_PIVOTS = Object.freeze(['origin', 'base-center', 'bounds-center']);
const ASSET_KINDS = Object.freeze(['prototype', 'unique']);
const MATERIAL_KINDS = Object.freeze(['basecolor', 'normal', 'orm', 'emissive', 'gltf-material']);
const COLOR_SPACES = Object.freeze(['srgb', 'linear']);
const PICKING_SHAPES = Object.freeze(['box', 'sphere', 'lod-mesh', 'none']);
const COLLISION_SHAPES = Object.freeze(['box', 'none']);
const SHADOW_MODES = Object.freeze(['none', 'cast', 'receive', 'both']);
const FLOOR_TAGS = Object.freeze(['terrain', 'ground', 'floor-1', 'floor-2', 'floor-3', 'roof', 'underground']);
const REPLACEMENT_TARGET_KINDS = Object.freeze(['building', 'prop', 'tree', 'surface', 'road']);
const REPLACEMENT_POLICIES = Object.freeze(['hide-mesh', 'hide-mesh-and-picking']);
const EVIDENCE_KINDS = Object.freeze(['reference-photo', 'survey', 'measurement', 'third-party-asset', 'authored']);

// Loosest sane physical limits. These exist so a typo cannot enqueue a terabyte or place a
// 40 km building; they are not the shipping budget, which the manifest states for itself.
const MAX_EXTENT_M = 4000;
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_TRIANGLES = 200_000_000;
const MAX_LODS = 8;
const PIVOT_EPSILON_M = 1e-3;
const GEOMETRY_EPSILON_M = 1e-6;

/** Frame declaration every v2 manifest must repeat verbatim. */
export const CUSTOMS_ASSET_FRAMES = Object.freeze({
  source: CUSTOMS_ASSET_SOURCE_FRAME,
  runtime: CUSTOMS_ASSET_RUNTIME_FRAME,
  runtimeFromSource: CUSTOMS_ASSET_RUNTIME_FROM_SOURCE,
});

export class CustomsAssetManifestError extends Error {
  constructor(code, path, message) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'CustomsAssetManifestError';
    this.code = code;
    this.path = path;
  }
}

function fail(code, path, message) {
  throw new CustomsAssetManifestError(code, path, message);
}

const schema = (path, message) => fail('ERR_ASSET_MANIFEST_SCHEMA', path, message);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function objectAt(value, path) {
  if (!isPlainObject(value)) schema(path, 'must be an object');
  return value;
}

function exactKeys(value, required, optional, path) {
  const object = objectAt(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) {
      schema(path, `is missing required field ${key}`);
    }
  }
  const unexpected = Object.keys(object).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    schema(path, `contains unsupported field(s): ${unexpected.join(', ')}`);
  }
  return object;
}

function arrayAt(value, path, { max = 100_000 } = {}) {
  if (!Array.isArray(value)) schema(path, 'must be an array');
  if (value.length > max) schema(path, `must not hold more than ${max} entries`);
  return value;
}

function finiteNumber(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('ERR_ASSET_MANIFEST_NON_FINITE', path, 'must be a finite number');
  }
  return Object.is(value, -0) ? 0 : value;
}

function positiveNumber(value, path) {
  const number = finiteNumber(value, path);
  if (!(number > 0)) schema(path, 'must be greater than zero');
  return number;
}

function safeInteger(value, path, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    schema(path, `must be a safe integer greater than or equal to ${minimum}`);
  }
  return value;
}

function boundedInteger(value, path, minimum, maximum) {
  const number = safeInteger(value, path, minimum);
  if (number > maximum) schema(path, `must be less than or equal to ${maximum}`);
  return number;
}

function boolean(value, path) {
  if (typeof value !== 'boolean') schema(path, 'must be a boolean');
  return value;
}

function text(value, path, { max = 200 } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    schema(path, 'must be a non-empty, already-trimmed string');
  }
  if (value.length > max) schema(path, `must not exceed ${max} characters`);
  // Control characters travel badly through JSON, DOM text and log lines alike.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) schema(path, 'must not contain control characters');
  return value;
}

function stableId(value, path) {
  const id = text(value, path, { max: 128 });
  if (!ID_PATTERN.test(id)) schema(path, 'must be a portable stable ID');
  return id;
}

function featureId(value, path) {
  const id = text(value, path, { max: 160 });
  if (!FEATURE_ID_PATTERN.test(id) || !id.startsWith(`${MAP_ID}.`)) {
    schema(path, `must be a dotted ${MAP_ID}.* feature ID`);
  }
  return id;
}

function enumValue(value, allowed, path) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    schema(path, `must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function isoDate(value, path) {
  const day = text(value, path, { max: 10 });
  if (!DATE_PATTERN.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
    schema(path, 'must be an ISO YYYY-MM-DD date');
  }
  return day;
}

function contentHash(value, path) {
  const hash = text(value, path, { max: 71 });
  if (!SHA256_PATTERN.test(hash)) {
    fail('ERR_ASSET_MANIFEST_HASH', path, 'must be a lowercase sha256:<64 hex> content hash');
  }
  return hash;
}

/**
 * A shipped file reference. Deliberately a relative path and never a URL: a manifest that can
 * name a scheme can name `javascript:`, `data:` or somebody else's CDN, and the fetch happens
 * with the app's credentials. Traversal, percent-escapes (which hide `..` as `%2e%2e`),
 * backslashes, queries and fragments are all rejected here rather than at resolve time.
 */
function safeRelativePath(value, path) {
  const file = text(value, path, { max: 512 });
  if (
    !SAFE_PATH_PATTERN.test(file)
    || file.startsWith('/')
    || file.includes('\\')
    || file.includes('%')
    || file.includes('?')
    || file.includes('#')
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(file)
  ) {
    fail('ERR_ASSET_MANIFEST_UNSAFE_URL', path, 'must be a safe relative same-origin path');
  }
  const segments = file.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('ERR_ASSET_MANIFEST_UNSAFE_URL', path, 'must not contain empty or traversal segments');
  }
  return file;
}

function safeBasePath(value, path) {
  const base = safeRelativePath(value.endsWith('/') ? value.slice(0, -1) : value, path);
  return `${base}/`;
}

/** Evidence may cite the public web; delivery may not fetch from it. https only, no creds. */
function evidenceUrl(value, path) {
  const raw = text(value, path, { max: HTTPS_URL_MAX });
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail('ERR_ASSET_MANIFEST_UNSAFE_URL', path, 'must be a valid absolute URL');
  }
  if (url.protocol !== 'https:') {
    fail('ERR_ASSET_MANIFEST_UNSAFE_URL', path, 'must use https');
  }
  if (url.username || url.password) {
    fail('ERR_ASSET_MANIFEST_UNSAFE_URL', path, 'must not carry credentials');
  }
  return url.href;
}

function extensionOf(file) {
  const name = file.slice(file.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function requireExtension(file, allowed, path) {
  if (!allowed.includes(extensionOf(file))) {
    schema(path, `must reference a file with one of these extensions: ${allowed.join(', ')}`);
  }
  return file;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function uniqueIds(entries, path, label) {
  const seen = new Set();
  entries.forEach((entry, index) => {
    if (seen.has(entry.id)) {
      fail('ERR_ASSET_MANIFEST_DUPLICATE_ID', `${path}[${index}].id`, `duplicates ${label} ${entry.id}`);
    }
    seen.add(entry.id);
  });
  return seen;
}

function requireReference(id, pool, path, label) {
  if (!pool.has(id)) {
    fail('ERR_ASSET_MANIFEST_MISSING_REF', path, `references unknown ${label} ${id}`);
  }
  return id;
}

// ---------------------------------------------------------------------------
// geometry primitives

function vector3(value, path) {
  const point = exactKeys(value, ['x', 'y', 'z'], [], path);
  return {
    x: finiteNumber(point.x, `${path}.x`),
    y: finiteNumber(point.y, `${path}.y`),
    z: finiteNumber(point.z, `${path}.z`),
  };
}

function boundedVector3(value, path) {
  const point = vector3(value, path);
  for (const axis of ['x', 'y', 'z']) {
    if (Math.abs(point[axis]) > MAX_EXTENT_M) {
      fail('ERR_ASSET_MANIFEST_BOUNDS', `${path}.${axis}`, `must be within ±${MAX_EXTENT_M} m`);
    }
  }
  return point;
}

function boundsBox(value, path) {
  const box = exactKeys(value, ['min', 'max'], [], path);
  const min = boundedVector3(box.min, `${path}.min`);
  const max = boundedVector3(box.max, `${path}.max`);
  for (const axis of ['x', 'y', 'z']) {
    if (!(max[axis] - min[axis] > GEOMETRY_EPSILON_M)) {
      fail('ERR_ASSET_MANIFEST_BOUNDS', `${path}.${axis}`, 'max must exceed min on every axis');
    }
  }
  return {
    min,
    max,
    sizeM: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    centerM: { x: (max.x + min.x) / 2, y: (max.y + min.y) / 2, z: (max.z + min.z) / 2 },
  };
}

function axisLetter(axis) {
  return axis[1];
}

/**
 * Canonical EFT placement. Rotation is Tait-Bryan degrees about the source frame's axes.
 * Scale is a positive uniform factor or a positive triple in the asset's declared local glTF
 * x/y/z axes, applied before axis conversion and EFT rotation. Zero and negative authored scale
 * are rejected; the one required EFT/runtime handedness flip is owned by the frame transform.
 */
function canonicalTransform(value, path) {
  const transform = exactKeys(value, ['position', 'rotation'], ['scale'], path);
  const position = boundedVector3(transform.position, `${path}.position`);
  const rotationValue = exactKeys(
    transform.rotation,
    ['yawDeg'],
    ['pitchDeg', 'rollDeg'],
    `${path}.rotation`,
  );
  const rotation = {
    yawDeg: finiteNumber(rotationValue.yawDeg, `${path}.rotation.yawDeg`),
    pitchDeg: rotationValue.pitchDeg === undefined
      ? 0
      : finiteNumber(rotationValue.pitchDeg, `${path}.rotation.pitchDeg`),
    rollDeg: rotationValue.rollDeg === undefined
      ? 0
      : finiteNumber(rotationValue.rollDeg, `${path}.rotation.rollDeg`),
  };
  for (const [key, degrees] of Object.entries(rotation)) {
    if (Math.abs(degrees) > 360) {
      fail('ERR_ASSET_MANIFEST_TRANSFORM', `${path}.rotation.${key}`, 'must be within ±360 degrees');
    }
  }
  let scale = { x: 1, y: 1, z: 1 };
  if (transform.scale !== undefined) {
    if (typeof transform.scale === 'number') {
      const uniform = finiteNumber(transform.scale, `${path}.scale`);
      if (!(uniform > 0)) {
        fail('ERR_ASSET_MANIFEST_TRANSFORM', `${path}.scale`, 'must be greater than zero');
      }
      scale = { x: uniform, y: uniform, z: uniform };
    } else {
      const triple = vector3(transform.scale, `${path}.scale`);
      for (const axis of ['x', 'y', 'z']) {
        if (!(triple[axis] > 0)) {
          fail('ERR_ASSET_MANIFEST_TRANSFORM', `${path}.scale.${axis}`, 'must be greater than zero');
        }
      }
      scale = triple;
    }
  }
  return { position, rotation, scale };
}

// ---------------------------------------------------------------------------
// evidence — truth data. Never fetched by the renderer.

function normalizeEvidenceSource(value, path) {
  const source = exactKeys(
    value,
    ['id', 'kind', 'title', 'holder', 'license', 'licenseUrl', 'retrievedAt'],
    ['originUrl', 'notes'],
    path,
  );
  return {
    id: stableId(source.id, `${path}.id`),
    kind: enumValue(source.kind, EVIDENCE_KINDS, `${path}.kind`),
    title: text(source.title, `${path}.title`, { max: 200 }),
    holder: text(source.holder, `${path}.holder`, { max: 200 }),
    license: text(source.license, `${path}.license`, { max: 80 }),
    licenseUrl: evidenceUrl(source.licenseUrl, `${path}.licenseUrl`),
    retrievedAt: isoDate(source.retrievedAt, `${path}.retrievedAt`),
    originUrl: source.originUrl === undefined ? null : evidenceUrl(source.originUrl, `${path}.originUrl`),
    notes: source.notes === undefined ? null : text(source.notes, `${path}.notes`, { max: 600 }),
  };
}

function normalizeEvidenceObservation(value, path, sourceIds) {
  const observation = exactKeys(
    value,
    ['id', 'sourceId', 'subject', 'positionM', 'toleranceM'],
    ['featureId', 'notes'],
    path,
  );
  return {
    id: stableId(observation.id, `${path}.id`),
    sourceId: requireReference(
      stableId(observation.sourceId, `${path}.sourceId`),
      sourceIds,
      `${path}.sourceId`,
      'evidence source',
    ),
    subject: text(observation.subject, `${path}.subject`, { max: 200 }),
    positionM: boundedVector3(observation.positionM, `${path}.positionM`),
    toleranceM: positiveNumber(observation.toleranceM, `${path}.toleranceM`),
    featureId: observation.featureId === undefined
      ? null
      : featureId(observation.featureId, `${path}.featureId`),
    notes: observation.notes === undefined ? null : text(observation.notes, `${path}.notes`, { max: 600 }),
  };
}

function normalizeEvidence(value, path) {
  const evidence = exactKeys(value, ['sources', 'observations'], [], path);
  const sources = arrayAt(evidence.sources, `${path}.sources`, { max: 512 })
    .map((entry, index) => normalizeEvidenceSource(entry, `${path}.sources[${index}]`));
  const sourceIds = uniqueIds(sources, `${path}.sources`, 'evidence source');
  const observations = arrayAt(evidence.observations, `${path}.observations`, { max: 20_000 })
    .map((entry, index) => normalizeEvidenceObservation(entry, `${path}.observations[${index}]`, sourceIds));
  uniqueIds(observations, `${path}.observations`, 'observation');
  return { sources, observations, sourceIds };
}

// ---------------------------------------------------------------------------
// delivery — what actually ships

function normalizeMaterial(value, path, sourceIds) {
  const material = exactKeys(
    value,
    ['id', 'kind', 'file', 'sha256', 'bytes', 'colorSpace', 'sourceId'],
    ['name'],
    path,
  );
  const file = requireExtension(
    safeRelativePath(material.file, `${path}.file`),
    ['png', 'ktx2', 'jpg', 'json'],
    `${path}.file`,
  );
  return {
    id: stableId(material.id, `${path}.id`),
    kind: enumValue(material.kind, MATERIAL_KINDS, `${path}.kind`),
    name: material.name === undefined ? null : text(material.name, `${path}.name`),
    file,
    sha256: contentHash(material.sha256, `${path}.sha256`),
    bytes: boundedInteger(material.bytes, `${path}.bytes`, 1, MAX_BYTES),
    colorSpace: enumValue(material.colorSpace, COLOR_SPACES, `${path}.colorSpace`),
    sourceId: requireReference(
      stableId(material.sourceId, `${path}.sourceId`),
      sourceIds,
      `${path}.sourceId`,
      'evidence source',
    ),
  };
}

/**
 * glTF interpretation. Without all four of these the file is not placeable: unit fixes scale,
 * up and forward fix orientation, pivot fixes where the origin sits relative to the geometry.
 * Up and forward sharing an axis letter is ambiguous — it leaves the third axis undetermined —
 * so it is rejected rather than guessed at.
 */
function normalizeGltfDeclaration(value, path) {
  const gltf = exactKeys(value, ['unit', 'upAxis', 'forwardAxis', 'pivot'], [], path);
  const upAxis = enumValue(gltf.upAxis, AXES, `${path}.upAxis`);
  const forwardAxis = enumValue(gltf.forwardAxis, AXES, `${path}.forwardAxis`);
  if (axisLetter(upAxis) === axisLetter(forwardAxis)) {
    fail('ERR_ASSET_MANIFEST_AMBIGUOUS_AXES', path, 'upAxis and forwardAxis must not share an axis');
  }
  return {
    unit: enumValue(gltf.unit, GLTF_UNITS, `${path}.unit`),
    upAxis,
    forwardAxis,
    pivot: enumValue(gltf.pivot, GLTF_PIVOTS, `${path}.pivot`),
  };
}

/** The pivot declaration has to agree with the declared bounds, or seating is a guess. */
function assertPivotAgreesWithBounds(gltf, bounds, path) {
  const up = axisLetter(gltf.upAxis);
  const lateral = ['x', 'y', 'z'].filter((axis) => axis !== up);
  const near = (value) => Math.abs(value) <= PIVOT_EPSILON_M;
  if (gltf.pivot === 'bounds-center') {
    for (const axis of ['x', 'y', 'z']) {
      if (!near(bounds.centerM[axis])) {
        fail('ERR_ASSET_MANIFEST_BOUNDS', `${path}.bounds`, 'bounds-center pivot requires bounds centred on the origin');
      }
    }
    return;
  }
  if (gltf.pivot === 'base-center') {
    for (const axis of lateral) {
      if (!near(bounds.centerM[axis])) {
        fail('ERR_ASSET_MANIFEST_BOUNDS', `${path}.bounds`, 'base-center pivot requires bounds centred laterally on the origin');
      }
    }
    const base = gltf.upAxis[0] === '+' ? bounds.min[up] : -bounds.max[up];
    if (!near(base)) {
      fail('ERR_ASSET_MANIFEST_BOUNDS', `${path}.bounds`, 'base-center pivot requires the base to sit at the origin');
    }
  }
}

/**
 * LOD chain, finest first. Cost must fall and switch distance must rise, strictly, at every
 * step: an LOD1 that is not cheaper than LOD0 is either a mislabelled export or a budget lie,
 * and either way the runtime would spend bandwidth to make the frame slower.
 */
function normalizeLods(value, path) {
  const lods = arrayAt(value, path, { max: MAX_LODS });
  if (lods.length === 0) fail('ERR_ASSET_MANIFEST_LOD', path, 'must declare at least one LOD');
  const levels = lods.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const lod = exactKeys(
      entry,
      ['level', 'url', 'sha256', 'bytes', 'triangles', 'maxDistanceM'],
      [],
      entryPath,
    );
    const level = boundedInteger(lod.level, `${entryPath}.level`, 0, MAX_LODS - 1);
    if (level !== index) {
      fail('ERR_ASSET_MANIFEST_LOD', `${entryPath}.level`, `must equal its array index (${index})`);
    }
    return {
      level,
      url: requireExtension(
        safeRelativePath(lod.url, `${entryPath}.url`),
        ['glb'],
        `${entryPath}.url`,
      ),
      sha256: contentHash(lod.sha256, `${entryPath}.sha256`),
      bytes: boundedInteger(lod.bytes, `${entryPath}.bytes`, 1, MAX_BYTES),
      triangles: boundedInteger(lod.triangles, `${entryPath}.triangles`, 1, MAX_TRIANGLES),
      maxDistanceM: positiveNumber(lod.maxDistanceM, `${entryPath}.maxDistanceM`),
    };
  });
  for (let index = 1; index < levels.length; index++) {
    const previous = levels[index - 1];
    const current = levels[index];
    if (current.triangles >= previous.triangles) {
      fail(
        'ERR_ASSET_MANIFEST_LOD',
        `${path}[${index}].triangles`,
        `must be strictly fewer than LOD ${previous.level} (${previous.triangles})`,
      );
    }
    if (current.bytes >= previous.bytes) {
      fail(
        'ERR_ASSET_MANIFEST_LOD',
        `${path}[${index}].bytes`,
        `must be strictly smaller than LOD ${previous.level} (${previous.bytes})`,
      );
    }
    if (current.maxDistanceM <= previous.maxDistanceM) {
      fail(
        'ERR_ASSET_MANIFEST_LOD',
        `${path}[${index}].maxDistanceM`,
        `must be strictly greater than LOD ${previous.level} (${previous.maxDistanceM})`,
      );
    }
  }
  const urls = new Set();
  for (const [index, lod] of levels.entries()) {
    if (urls.has(lod.url)) {
      fail('ERR_ASSET_MANIFEST_DUPLICATE_ID', `${path}[${index}].url`, `duplicates LOD url ${lod.url}`);
    }
    urls.add(lod.url);
  }
  return levels;
}

function normalizeProxies(value, path, lods) {
  const proxies = exactKeys(value, ['picking', 'shadow', 'collision'], [], path);

  const pickingValue = exactKeys(proxies.picking, ['shape'], ['lodLevel', 'inflateM'], `${path}.picking`);
  const pickingShape = enumValue(pickingValue.shape, PICKING_SHAPES, `${path}.picking.shape`);
  let pickingLodLevel = null;
  if (pickingShape === 'lod-mesh') {
    if (pickingValue.lodLevel === undefined) {
      schema(`${path}.picking.lodLevel`, 'is required when the picking shape is lod-mesh');
    }
    pickingLodLevel = boundedInteger(pickingValue.lodLevel, `${path}.picking.lodLevel`, 0, MAX_LODS - 1);
    if (pickingLodLevel >= lods.length) {
      fail('ERR_ASSET_MANIFEST_MISSING_REF', `${path}.picking.lodLevel`, `references undeclared LOD ${pickingLodLevel}`);
    }
  } else if (pickingValue.lodLevel !== undefined) {
    schema(`${path}.picking.lodLevel`, 'is only meaningful when the picking shape is lod-mesh');
  }
  const pickingInflateM = pickingValue.inflateM === undefined
    ? 0
    : finiteNumber(pickingValue.inflateM, `${path}.picking.inflateM`);
  if (pickingInflateM < 0 || pickingInflateM > 100) {
    fail(
      'ERR_ASSET_MANIFEST_BOUNDS',
      `${path}.picking.inflateM`,
      'must be between 0 and 100 metres',
    );
  }

  const shadowValue = exactKeys(proxies.shadow, ['mode'], ['lodLevel'], `${path}.shadow`);
  const shadowMode = enumValue(shadowValue.mode, SHADOW_MODES, `${path}.shadow.mode`);
  let shadowLodLevel = null;
  if (shadowValue.lodLevel !== undefined) {
    if (shadowMode === 'none' || shadowMode === 'receive') {
      schema(`${path}.shadow.lodLevel`, 'is only meaningful when the asset casts a shadow');
    }
    shadowLodLevel = boundedInteger(shadowValue.lodLevel, `${path}.shadow.lodLevel`, 0, MAX_LODS - 1);
    if (shadowLodLevel >= lods.length) {
      fail('ERR_ASSET_MANIFEST_MISSING_REF', `${path}.shadow.lodLevel`, `references undeclared LOD ${shadowLodLevel}`);
    }
  }

  const collisionValue = exactKeys(proxies.collision, ['shape'], [], `${path}.collision`);
  return {
    picking: {
      shape: pickingShape,
      lodLevel: pickingLodLevel,
      inflateM: pickingInflateM,
    },
    shadow: { mode: shadowMode, lodLevel: shadowLodLevel },
    collision: { shape: enumValue(collisionValue.shape, COLLISION_SHAPES, `${path}.collision.shape`) },
  };
}

function normalizeMasks(value, path) {
  const masks = exactKeys(value, ['floors', 'interior'], [], path);
  const floors = arrayAt(masks.floors, `${path}.floors`, { max: FLOOR_TAGS.length });
  if (floors.length === 0) schema(`${path}.floors`, 'must name at least one floor tag');
  const seen = new Set();
  const normalized = floors.map((entry, index) => {
    const tag = enumValue(entry, FLOOR_TAGS, `${path}.floors[${index}]`);
    if (seen.has(tag)) {
      fail('ERR_ASSET_MANIFEST_DUPLICATE_ID', `${path}.floors[${index}]`, `duplicates floor tag ${tag}`);
    }
    seen.add(tag);
    return tag;
  });
  return { floors: normalized, interior: boolean(masks.interior, `${path}.interior`) };
}

function normalizeAsset(value, path, { sourceIds, materialIds }) {
  const asset = exactKeys(
    value,
    ['id', 'kind', 'name', 'sourceId', 'gltf', 'bounds', 'materialIds', 'masks', 'proxies', 'lods'],
    [],
    path,
  );
  const gltf = normalizeGltfDeclaration(asset.gltf, `${path}.gltf`);
  const bounds = boundsBox(asset.bounds, `${path}.bounds`);
  assertPivotAgreesWithBounds(gltf, bounds, path);
  const lods = normalizeLods(asset.lods, `${path}.lods`);
  const materials = arrayAt(asset.materialIds, `${path}.materialIds`, { max: 256 })
    .map((entry, index) => requireReference(
      stableId(entry, `${path}.materialIds[${index}]`),
      materialIds,
      `${path}.materialIds[${index}]`,
      'material',
    ));
  if (new Set(materials).size !== materials.length) {
    fail('ERR_ASSET_MANIFEST_DUPLICATE_ID', `${path}.materialIds`, 'must not repeat a material');
  }
  return {
    id: stableId(asset.id, `${path}.id`),
    kind: enumValue(asset.kind, ASSET_KINDS, `${path}.kind`),
    name: text(asset.name, `${path}.name`),
    sourceId: requireReference(
      stableId(asset.sourceId, `${path}.sourceId`),
      sourceIds,
      `${path}.sourceId`,
      'evidence source',
    ),
    gltf,
    bounds,
    materialIds: materials,
    masks: normalizeMasks(asset.masks, `${path}.masks`),
    proxies: normalizeProxies(asset.proxies, `${path}.proxies`, lods),
    lods,
    totalBytes: lods.reduce((sum, lod) => sum + lod.bytes, 0),
  };
}

function normalizeInstance(value, path, { assetsById }) {
  const instance = exactKeys(
    value,
    ['id', 'assetId', 'cellId', 'stableId', 'transform', 'floor'],
    ['featureId', 'label', 'pickable'],
    path,
  );
  const assetId = stableId(instance.assetId, `${path}.assetId`);
  const asset = assetsById.get(assetId);
  if (!asset) {
    fail('ERR_ASSET_MANIFEST_MISSING_REF', `${path}.assetId`, `references unknown asset ${assetId}`);
  }
  const floor = enumValue(instance.floor, FLOOR_TAGS, `${path}.floor`);
  if (!asset.masks.floors.includes(floor)) {
    fail(
      'ERR_ASSET_MANIFEST_MISSING_REF',
      `${path}.floor`,
      `floor ${floor} is not declared by asset ${assetId} (${asset.masks.floors.join(', ')})`,
    );
  }
  return {
    id: stableId(instance.id, `${path}.id`),
    assetId,
    cellId: stableId(instance.cellId, `${path}.cellId`),
    stableId: stableId(instance.stableId, `${path}.stableId`),
    featureId: instance.featureId === undefined
      ? null
      : featureId(instance.featureId, `${path}.featureId`),
    label: instance.label === undefined ? null : text(instance.label, `${path}.label`),
    pickable: instance.pickable === undefined ? true : boolean(instance.pickable, `${path}.pickable`),
    transform: canonicalTransform(instance.transform, `${path}.transform`),
    floor,
  };
}

function normalizeCell(value, path) {
  const cell = exactKeys(
    value,
    ['id', 'center', 'widthM', 'depthM', 'minY', 'maxY', 'instanceIds'],
    ['loadPriority'],
    path,
  );
  const center = exactKeys(cell.center, ['x', 'z'], [], `${path}.center`);
  const minY = finiteNumber(cell.minY, `${path}.minY`);
  const maxY = finiteNumber(cell.maxY, `${path}.maxY`);
  if (!(maxY - minY > GEOMETRY_EPSILON_M)) {
    fail('ERR_ASSET_MANIFEST_BOUNDS', `${path}.maxY`, 'must exceed minY');
  }
  const widthM = positiveNumber(cell.widthM, `${path}.widthM`);
  const depthM = positiveNumber(cell.depthM, `${path}.depthM`);
  if (widthM > MAX_EXTENT_M || depthM > MAX_EXTENT_M) {
    fail('ERR_ASSET_MANIFEST_BOUNDS', path, `must not exceed ${MAX_EXTENT_M} m on a side`);
  }
  const instanceIds = arrayAt(cell.instanceIds, `${path}.instanceIds`, { max: 20_000 })
    .map((entry, index) => stableId(entry, `${path}.instanceIds[${index}]`));
  if (new Set(instanceIds).size !== instanceIds.length) {
    fail('ERR_ASSET_MANIFEST_DUPLICATE_ID', `${path}.instanceIds`, 'must not repeat an instance');
  }
  const x = finiteNumber(center.x, `${path}.center.x`);
  const z = finiteNumber(center.z, `${path}.center.z`);
  return {
    id: stableId(cell.id, `${path}.id`),
    center: { x, z },
    widthM,
    depthM,
    minY,
    maxY,
    boundsM: {
      minX: x - widthM / 2,
      maxX: x + widthM / 2,
      minZ: z - depthM / 2,
      maxZ: z + depthM / 2,
    },
    loadPriority: cell.loadPriority === undefined
      ? 0
      : boundedInteger(cell.loadPriority, `${path}.loadPriority`, 0, 1000),
    instanceIds,
  };
}

function normalizeReplacement(value, path, { instancesById }) {
  const replacement = exactKeys(
    value,
    ['id', 'target', 'instanceIds', 'policy'],
    ['notes'],
    path,
  );
  const target = exactKeys(replacement.target, ['kind', 'featureId'], [], `${path}.target`);
  const instanceIds = arrayAt(replacement.instanceIds, `${path}.instanceIds`, { max: 4096 })
    .map((entry, index) => {
      const id = stableId(entry, `${path}.instanceIds[${index}]`);
      if (!instancesById.has(id)) {
        fail(
          'ERR_ASSET_MANIFEST_UNRESOLVED_REPLACEMENT',
          `${path}.instanceIds[${index}]`,
          `references unknown instance ${id}`,
        );
      }
      return id;
    });
  if (instanceIds.length === 0) {
    fail(
      'ERR_ASSET_MANIFEST_UNRESOLVED_REPLACEMENT',
      `${path}.instanceIds`,
      'must name at least one authored instance',
    );
  }
  if (new Set(instanceIds).size !== instanceIds.length) {
    fail('ERR_ASSET_MANIFEST_DUPLICATE_ID', `${path}.instanceIds`, 'must not repeat an instance');
  }
  return {
    id: stableId(replacement.id, `${path}.id`),
    target: {
      kind: enumValue(target.kind, REPLACEMENT_TARGET_KINDS, `${path}.target.kind`),
      featureId: featureId(target.featureId, `${path}.target.featureId`),
    },
    instanceIds,
    policy: enumValue(replacement.policy, REPLACEMENT_POLICIES, `${path}.policy`),
    notes: replacement.notes === undefined ? null : text(replacement.notes, `${path}.notes`, { max: 600 }),
  };
}

function normalizeBudgets(value, path) {
  const budgets = exactKeys(
    value,
    ['totalBytes', 'totalTriangles', 'perCellBytes', 'perCellTriangles', 'maxConcurrentLoads', 'drawDistanceM'],
    [],
    path,
  );
  const totalBytes = boundedInteger(budgets.totalBytes, `${path}.totalBytes`, 0, MAX_BYTES);
  const perCellBytes = boundedInteger(budgets.perCellBytes, `${path}.perCellBytes`, 0, MAX_BYTES);
  const totalTriangles = boundedInteger(budgets.totalTriangles, `${path}.totalTriangles`, 0, MAX_TRIANGLES);
  const perCellTriangles = boundedInteger(budgets.perCellTriangles, `${path}.perCellTriangles`, 0, MAX_TRIANGLES);
  if (perCellBytes > totalBytes) {
    fail('ERR_ASSET_MANIFEST_BUDGET', `${path}.perCellBytes`, 'must not exceed totalBytes');
  }
  if (perCellTriangles > totalTriangles) {
    fail('ERR_ASSET_MANIFEST_BUDGET', `${path}.perCellTriangles`, 'must not exceed totalTriangles');
  }
  return {
    totalBytes,
    totalTriangles,
    perCellBytes,
    perCellTriangles,
    maxConcurrentLoads: boundedInteger(budgets.maxConcurrentLoads, `${path}.maxConcurrentLoads`, 1, 32),
    drawDistanceM: positiveNumber(budgets.drawDistanceM, `${path}.drawDistanceM`),
  };
}

function normalizeScope(value, path) {
  const scope = exactKeys(value, ['id', 'center', 'widthM', 'depthM'], [], path);
  const center = exactKeys(scope.center, ['x', 'z'], [], `${path}.center`);
  const x = finiteNumber(center.x, `${path}.center.x`);
  const z = finiteNumber(center.z, `${path}.center.z`);
  const widthM = positiveNumber(scope.widthM, `${path}.widthM`);
  const depthM = positiveNumber(scope.depthM, `${path}.depthM`);
  if (widthM > MAX_EXTENT_M || depthM > MAX_EXTENT_M) {
    fail('ERR_ASSET_MANIFEST_BOUNDS', path, `must not exceed ${MAX_EXTENT_M} m on a side`);
  }
  return {
    id: stableId(scope.id, `${path}.id`),
    center: { x, z },
    widthM,
    depthM,
    boundsM: {
      minX: x - widthM / 2,
      maxX: x + widthM / 2,
      minZ: z - depthM / 2,
      maxZ: z + depthM / 2,
    },
  };
}

function normalizeFrames(value, path) {
  const frames = exactKeys(value, ['source', 'runtime', 'runtimeFromSource'], [], path);
  for (const [key, expected] of Object.entries(CUSTOMS_ASSET_FRAMES)) {
    if (frames[key] !== expected) {
      fail('ERR_ASSET_MANIFEST_AMBIGUOUS_AXES', `${path}.${key}`, `must be ${expected}`);
    }
  }
  return { ...CUSTOMS_ASSET_FRAMES };
}

// ---------------------------------------------------------------------------
// cross-entity invariants

function assertCellMembership(cells, instances, path) {
  const cellsById = new Map(cells.map((cell) => [cell.id, cell]));
  const claimedBy = new Map();
  for (const cell of cells) {
    for (const instanceId of cell.instanceIds) {
      const previous = claimedBy.get(instanceId);
      if (previous) {
        fail(
          'ERR_ASSET_MANIFEST_DUPLICATE_ID',
          `${path}.cells`,
          `instance ${instanceId} is listed by both cell ${previous} and cell ${cell.id}`,
        );
      }
      claimedBy.set(instanceId, cell.id);
    }
  }
  instances.forEach((instance, index) => {
    const instancePath = `${path}.instances[${index}]`;
    const cell = cellsById.get(instance.cellId);
    if (!cell) {
      fail('ERR_ASSET_MANIFEST_MISSING_REF', `${instancePath}.cellId`, `references unknown cell ${instance.cellId}`);
    }
    const owner = claimedBy.get(instance.id);
    if (owner !== instance.cellId) {
      fail(
        'ERR_ASSET_MANIFEST_MISSING_REF',
        `${instancePath}.cellId`,
        owner === undefined
          ? `is not listed by cell ${instance.cellId}`
          : `disagrees with cell ${owner}, which claims this instance`,
      );
    }
    const { x, y, z } = instance.transform.position;
    if (x < cell.boundsM.minX || x > cell.boundsM.maxX || z < cell.boundsM.minZ || z > cell.boundsM.maxZ) {
      fail('ERR_ASSET_MANIFEST_BOUNDS', `${instancePath}.transform.position`, `falls outside cell ${cell.id}`);
    }
    if (y < cell.minY || y > cell.maxY) {
      fail('ERR_ASSET_MANIFEST_BOUNDS', `${instancePath}.transform.position.y`, `falls outside cell ${cell.id} height range`);
    }
  });
  const known = new Set(instances.map((instance) => instance.id));
  for (const [instanceId, cellId] of claimedBy) {
    if (!known.has(instanceId)) {
      fail('ERR_ASSET_MANIFEST_MISSING_REF', `${path}.cells`, `cell ${cellId} lists unknown instance ${instanceId}`);
    }
  }
}

function assertCellsWithinScope(cells, scope, path) {
  cells.forEach((cell, index) => {
    const { boundsM } = cell;
    if (
      boundsM.minX < scope.boundsM.minX
      || boundsM.maxX > scope.boundsM.maxX
      || boundsM.minZ < scope.boundsM.minZ
      || boundsM.maxZ > scope.boundsM.maxZ
    ) {
      fail('ERR_ASSET_MANIFEST_BOUNDS', `${path}.cells[${index}]`, `extends outside scope ${scope.id}`);
    }
  });
}

/**
 * A `unique` asset describes one authored object, not a reusable prototype. Requiring exactly
 * one placement prevents both orphaned delivery bytes and accidental clones of a landmark.
 */
function assertAssetInstanceCardinality(assets, instances, path) {
  const countsByAssetId = new Map();
  for (const instance of instances) {
    countsByAssetId.set(instance.assetId, (countsByAssetId.get(instance.assetId) ?? 0) + 1);
  }
  assets.forEach((asset, index) => {
    if (asset.kind !== 'unique') return;
    const count = countsByAssetId.get(asset.id) ?? 0;
    if (count !== 1) {
      fail(
        'ERR_ASSET_MANIFEST_SCHEMA',
        `${path}.assets[${index}].kind`,
        `unique asset ${asset.id} must have exactly one instance (found ${count})`,
      );
    }
  });
}

function assertReplacementsResolve(replacements, instances, path) {
  const featureIds = new Set();
  replacements.forEach((replacement, index) => {
    const replacementPath = `${path}.replacements[${index}]`;
    if (featureIds.has(replacement.target.featureId)) {
      fail(
        'ERR_ASSET_MANIFEST_UNRESOLVED_REPLACEMENT',
        `${replacementPath}.target.featureId`,
        `is already replaced by another entry (${replacement.target.featureId})`,
      );
    }
    featureIds.add(replacement.target.featureId);
  });
  // One authored building commonly retires several procedural records: its
  // exterior mesh, measured floor slabs, and an underground proxy. Reusing an
  // attached instance across distinct targets is therefore intentional. The
  // target feature remains unique, so no two replacement policies can fight.
  // An authored instance that claims a featureId must be doing so through a replacement, or the
  // procedural original keeps drawing underneath it forever.
  const replaced = new Set(replacements.map((replacement) => replacement.target.featureId));
  instances.forEach((instance, index) => {
    if (instance.featureId && !replaced.has(instance.featureId)) {
      fail(
        'ERR_ASSET_MANIFEST_UNRESOLVED_REPLACEMENT',
        `${path}.instances[${index}].featureId`,
        `claims ${instance.featureId} but no replacement entry retires that procedural feature`,
      );
    }
  });
}

function assertBudgets(budgets, assets, cells, instances, path) {
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const totalBytes = assets.reduce((sum, asset) => sum + asset.totalBytes, 0);
  if (totalBytes > budgets.totalBytes) {
    fail(
      'ERR_ASSET_MANIFEST_BUDGET',
      `${path}.assets`,
      `declare ${totalBytes} bytes, over the ${budgets.totalBytes} byte budget`,
    );
  }
  const instancesById = new Map(instances.map((instance) => [instance.id, instance]));
  let sceneTriangles = 0;
  for (const cell of cells) {
    // A prototype's bytes are paid once per cell however many times it is placed; its triangles
    // are paid per instance, because that is what the GPU actually draws.
    const distinctAssets = new Set();
    let cellTriangles = 0;
    for (const instanceId of cell.instanceIds) {
      const asset = assetsById.get(instancesById.get(instanceId).assetId);
      distinctAssets.add(asset.id);
      cellTriangles += asset.lods[0].triangles;
    }
    let cellBytes = 0;
    for (const assetId of distinctAssets) cellBytes += assetsById.get(assetId).totalBytes;
    if (cellBytes > budgets.perCellBytes) {
      fail(
        'ERR_ASSET_MANIFEST_BUDGET',
        `${path}.cells`,
        `cell ${cell.id} needs ${cellBytes} bytes, over the ${budgets.perCellBytes} per-cell budget`,
      );
    }
    if (cellTriangles > budgets.perCellTriangles) {
      fail(
        'ERR_ASSET_MANIFEST_BUDGET',
        `${path}.cells`,
        `cell ${cell.id} draws ${cellTriangles} triangles at LOD0, over the ${budgets.perCellTriangles} per-cell budget`,
      );
    }
    sceneTriangles += cellTriangles;
  }
  if (sceneTriangles > budgets.totalTriangles) {
    fail(
      'ERR_ASSET_MANIFEST_BUDGET',
      `${path}.instances`,
      `draw ${sceneTriangles} triangles at LOD0, over the ${budgets.totalTriangles} budget`,
    );
  }
  return { totalBytes, sceneTriangles };
}

// ---------------------------------------------------------------------------
// entry points

/**
 * Validate and normalize a v2 manifest. Throws `CustomsAssetManifestError` on the first
 * violation, with a `code` and a JSON path. The returned object is deep-frozen: callers cannot
 * mutate a validated manifest back into an invalid one.
 */
export function normalizeCustomsAssetManifest(value) {
  const path = 'manifest';
  const manifest = exactKeys(
    value,
    ['schemaVersion', 'map', 'frames', 'scope', 'budgets', 'evidence', 'delivery'],
    ['generator', 'notes'],
    path,
  );
  if (manifest.schemaVersion !== CUSTOMS_ASSET_SCHEMA_VERSION) {
    fail(
      'ERR_ASSET_MANIFEST_VERSION',
      `${path}.schemaVersion`,
      `must be ${CUSTOMS_ASSET_SCHEMA_VERSION}`,
    );
  }
  if (manifest.map !== MAP_ID) schema(`${path}.map`, `must be ${MAP_ID}`);

  const frames = normalizeFrames(manifest.frames, `${path}.frames`);
  const scope = normalizeScope(manifest.scope, `${path}.scope`);
  const budgets = normalizeBudgets(manifest.budgets, `${path}.budgets`);
  const { sources, observations, sourceIds } = normalizeEvidence(manifest.evidence, `${path}.evidence`);

  const deliveryPath = `${path}.delivery`;
  const delivery = exactKeys(
    manifest.delivery,
    ['baseUrl', 'materials', 'assets', 'instances', 'cells', 'replacements'],
    [],
    deliveryPath,
  );
  const baseUrl = safeBasePath(text(delivery.baseUrl, `${deliveryPath}.baseUrl`, { max: 512 }), `${deliveryPath}.baseUrl`);

  const materials = arrayAt(delivery.materials, `${deliveryPath}.materials`, { max: 4096 })
    .map((entry, index) => normalizeMaterial(entry, `${deliveryPath}.materials[${index}]`, sourceIds));
  const materialIds = uniqueIds(materials, `${deliveryPath}.materials`, 'material');

  const assets = arrayAt(delivery.assets, `${deliveryPath}.assets`, { max: 4096 })
    .map((entry, index) => normalizeAsset(entry, `${deliveryPath}.assets[${index}]`, { sourceIds, materialIds }));
  uniqueIds(assets, `${deliveryPath}.assets`, 'asset');
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));

  const allUrls = new Set();
  assets.forEach((asset, assetIndex) => {
    asset.lods.forEach((lod, lodIndex) => {
      if (allUrls.has(lod.url)) {
        fail(
          'ERR_ASSET_MANIFEST_DUPLICATE_ID',
          `${deliveryPath}.assets[${assetIndex}].lods[${lodIndex}].url`,
          `is already claimed by another asset (${lod.url})`,
        );
      }
      allUrls.add(lod.url);
    });
  });

  const instances = arrayAt(delivery.instances, `${deliveryPath}.instances`, { max: 50_000 })
    .map((entry, index) => normalizeInstance(entry, `${deliveryPath}.instances[${index}]`, { assetsById }));
  uniqueIds(instances, `${deliveryPath}.instances`, 'instance');
  const instanceStableIds = new Set();
  instances.forEach((instance, index) => {
    if (instanceStableIds.has(instance.stableId)) {
      fail(
        'ERR_ASSET_MANIFEST_DUPLICATE_ID',
        `${deliveryPath}.instances[${index}].stableId`,
        `duplicates stable ID ${instance.stableId}`,
      );
    }
    instanceStableIds.add(instance.stableId);
  });
  assertAssetInstanceCardinality(assets, instances, deliveryPath);
  const instancesById = new Map(instances.map((instance) => [instance.id, instance]));

  const cells = arrayAt(delivery.cells, `${deliveryPath}.cells`, { max: 4096 })
    .map((entry, index) => normalizeCell(entry, `${deliveryPath}.cells[${index}]`));
  uniqueIds(cells, `${deliveryPath}.cells`, 'cell');
  assertCellsWithinScope(cells, scope, deliveryPath);
  assertCellMembership(cells, instances, deliveryPath);

  const replacements = arrayAt(delivery.replacements, `${deliveryPath}.replacements`, { max: 20_000 })
    .map((entry, index) => normalizeReplacement(entry, `${deliveryPath}.replacements[${index}]`, { instancesById }));
  uniqueIds(replacements, `${deliveryPath}.replacements`, 'replacement');
  assertReplacementsResolve(replacements, instances, deliveryPath);

  const totals = assertBudgets(budgets, assets, cells, instances, deliveryPath);

  const generator = manifest.generator === undefined
    ? null
    : (() => {
      const value_ = exactKeys(manifest.generator, ['name', 'version'], [], `${path}.generator`);
      return {
        name: text(value_.name, `${path}.generator.name`),
        version: text(value_.version, `${path}.generator.version`, { max: 64 }),
      };
    })();

  return deepFreeze({
    schemaVersion: CUSTOMS_ASSET_SCHEMA_VERSION,
    map: MAP_ID,
    frames,
    scope,
    budgets,
    generator,
    notes: manifest.notes === undefined ? null : text(manifest.notes, `${path}.notes`, { max: 600 }),
    evidence: { sources, observations },
    delivery: { baseUrl, materials, assets, instances, cells, replacements },
    totals: {
      declaredBytes: totals.totalBytes,
      lod0Triangles: totals.sceneTriangles,
      assets: assets.length,
      instances: instances.length,
      cells: cells.length,
      replacements: replacements.length,
    },
    // The renderer reads exactly this flag to decide whether procedural geometry is the
    // deliverable rather than a placeholder.
    proceduralFallback: instances.length === 0,
  });
}

/** True when the manifest ships nothing and the procedural scene stands on its own. */
export function isCustomsAssetManifestEmpty(manifest) {
  return manifest.delivery.instances.length === 0
    && manifest.delivery.assets.length === 0
    && manifest.delivery.cells.length === 0
    && manifest.delivery.replacements.length === 0;
}

/**
 * Resolve a delivery-relative path against the document base, and refuse anything that leaves
 * the manifest's own directory or the app's origin. Validation already rejected traversal in the
 * literal string; this is the second gate, against a hostile *base* — a manifest served from an
 * unexpected location must not be able to reach the rest of the origin.
 */
export function resolveCustomsAssetUrl(manifest, relativePath, baseHref) {
  const base = new URL(baseHref);
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    fail('ERR_ASSET_MANIFEST_UNSAFE_URL', 'baseHref', 'must be an http(s) URL');
  }
  const root = new URL(manifest.delivery.baseUrl, base);
  if (root.origin !== base.origin) {
    fail('ERR_ASSET_MANIFEST_UNSAFE_URL', 'manifest.delivery.baseUrl', 'must stay on the document origin');
  }
  const resolved = new URL(relativePath, root);
  if (resolved.origin !== base.origin) {
    fail('ERR_ASSET_MANIFEST_UNSAFE_URL', relativePath, 'resolves cross-origin');
  }
  if (!resolved.pathname.startsWith(root.pathname)) {
    fail('ERR_ASSET_MANIFEST_UNSAFE_URL', relativePath, `escapes the delivery root ${root.pathname}`);
  }
  if (resolved.search || resolved.hash) {
    fail('ERR_ASSET_MANIFEST_UNSAFE_URL', relativePath, 'must not carry a query or fragment');
  }
  return resolved.href;
}

/**
 * The shipped shape of "nothing authored yet". Kept here so the JSON on disk and the fallback
 * the renderer uses when the fetch fails cannot drift apart.
 */
export function emptyCustomsAssetManifest({ scope, budgets, notes } = {}) {
  return {
    schemaVersion: CUSTOMS_ASSET_SCHEMA_VERSION,
    map: MAP_ID,
    frames: { ...CUSTOMS_ASSET_FRAMES },
    scope: scope ?? {
      id: 'customs-industrial-rail-yard',
      center: { x: 230, z: -110 },
      widthM: 360,
      depthM: 300,
    },
    budgets: budgets ?? {
      totalBytes: 48 * 1024 * 1024,
      totalTriangles: 4_000_000,
      perCellBytes: 12 * 1024 * 1024,
      perCellTriangles: 900_000,
      maxConcurrentLoads: 4,
      drawDistanceM: 260,
    },
    ...(notes ? { notes } : {}),
    evidence: { sources: [], observations: [] },
    delivery: {
      baseUrl: 'assets/3d/customs/authored/',
      materials: [],
      assets: [],
      instances: [],
      cells: [],
      replacements: [],
    },
  };
}

export const CUSTOMS_ASSET_ENUMS = Object.freeze({
  axes: AXES,
  assetKinds: ASSET_KINDS,
  materialKinds: MATERIAL_KINDS,
  pivots: GLTF_PIVOTS,
  floorTags: FLOOR_TAGS,
  pickingShapes: PICKING_SHAPES,
  shadowModes: SHADOW_MODES,
  collisionShapes: COLLISION_SHAPES,
  replacementPolicies: REPLACEMENT_POLICIES,
  replacementTargetKinds: REPLACEMENT_TARGET_KINDS,
  evidenceKinds: EVIDENCE_KINDS,
});
