// Pure, renderer-neutral runtime contract for locally generated Customs terrain.
//
// The v1 payload is deliberately local-only. Every referenced file must be a safe
// relative path, heights are absolute EFT Unity world-Y metres, and display relief
// is a fixed 2x transform applied only after canonical sampling.

export const CUSTOMS_LOCAL_TERRAIN_SCHEMA_VERSION = 1;
export const CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME = 'eft-unity-world-metres-y-up';
export const CUSTOMS_LOCAL_TERRAIN_DISPLAY_RELIEF_SCALE = 2;

const MAP_ID = 'customs';
const CONTROL_CHANNELS = Object.freeze(['r', 'g', 'b', 'a']);
const HEIGHT_ENCODING = Object.freeze({
  storage: 'float32le',
  endianness: 'little',
  scalarType: 'float32',
  sampleOrder: 'row-major-z-times-columns-plus-x',
  values: 'canonical-world-y-metres',
});
const CONTROL_COLUMN_ORDER = 'x-min-to-x-max';
const CONTROL_ROW_ORDER = 'z-min-to-z-max';
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_PATH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const FLOAT_BYTES = 4;
const COORDINATE_EPSILON = 1e-9;

const manifestState = new WeakMap();
const runtimeState = new WeakMap();

/** Stable v1 invariants shared by the local producer and browser adapter. */
export const CUSTOMS_LOCAL_TERRAIN_MANIFEST_V1 = Object.freeze({
  schemaVersion: CUSTOMS_LOCAL_TERRAIN_SCHEMA_VERSION,
  map: MAP_ID,
  localOnly: true,
  sourceFrame: CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME,
  heightEncoding: HEIGHT_ENCODING,
  controlMapCount: 3,
  controlChannels: CONTROL_CHANNELS,
  controlColumnOrder: CONTROL_COLUMN_ORDER,
  controlRowOrder: CONTROL_ROW_ORDER,
  displayReliefScale: CUSTOMS_LOCAL_TERRAIN_DISPLAY_RELIEF_SCALE,
});

export class CustomsLocalTerrainError extends Error {
  constructor(code, path, message) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'CustomsLocalTerrainError';
    this.code = code;
    this.path = path;
  }
}

function fail(code, path, message) {
  throw new CustomsLocalTerrainError(code, path, message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function objectAt(value, path) {
  if (!isPlainObject(value)) fail('ERR_CUSTOMS_TERRAIN_SCHEMA', path, 'must be an object');
  return value;
}

function exactKeys(value, required, optional, path) {
  const object = objectAt(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) {
      fail('ERR_CUSTOMS_TERRAIN_SCHEMA', path, `is missing required field ${key}`);
    }
  }
  const unexpected = Object.keys(object).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    fail('ERR_CUSTOMS_TERRAIN_SCHEMA', path, `contains unsupported field(s): ${unexpected.join(', ')}`);
  }
  return object;
}

function finiteNumber(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('ERR_CUSTOMS_TERRAIN_NON_FINITE', path, 'must be a finite number');
  }
  return Object.is(value, -0) ? 0 : value;
}

function positiveNumber(value, path) {
  const number = finiteNumber(value, path);
  if (!(number > 0)) fail('ERR_CUSTOMS_TERRAIN_SCHEMA', path, 'must be greater than zero');
  return number;
}

function safeInteger(value, path, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail('ERR_CUSTOMS_TERRAIN_SCHEMA', path, `must be a safe integer greater than or equal to ${minimum}`);
  }
  return value;
}

function text(value, path) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    fail('ERR_CUSTOMS_TERRAIN_SCHEMA', path, 'must be a non-empty, already-trimmed string');
  }
  return value;
}

function stableId(value, path) {
  const id = text(value, path);
  if (id.length > 128 || !ID_PATTERN.test(id)) {
    fail('ERR_CUSTOMS_TERRAIN_SCHEMA', path, 'must be a portable stable ID');
  }
  return id;
}

function safeRelativePath(value, path) {
  const file = text(value, path);
  if (
    file.length > 512
    || !SAFE_PATH_PATTERN.test(file)
    || file.startsWith('/')
    || file.startsWith('\\')
    || file.includes('\\')
    || file.includes('%')
    || file.includes('?')
    || file.includes('#')
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(file)
  ) {
    fail('ERR_CUSTOMS_TERRAIN_UNSAFE_PATH', path, 'must be a safe relative local path');
  }
  const segments = file.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('ERR_CUSTOMS_TERRAIN_UNSAFE_PATH', path, 'must not contain empty or traversal segments');
  }
  return file;
}

function closeEnough(a, b) {
  return Math.abs(a - b) <= COORDINATE_EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function normalizeHeightEncoding(value, path) {
  const encoding = exactKeys(
    value,
    ['storage', 'endianness', 'scalarType', 'sampleOrder', 'values'],
    [],
    path,
  );
  for (const [key, expected] of Object.entries(HEIGHT_ENCODING)) {
    if (encoding[key] !== expected) {
      fail('ERR_CUSTOMS_TERRAIN_SCHEMA', `${path}.${key}`, `must be ${expected}`);
    }
  }
  return { ...HEIGHT_ENCODING };
}

function normalizeControlMaps(value, path) {
  if (!Array.isArray(value) || value.length !== 3) {
    fail('ERR_CUSTOMS_TERRAIN_SCHEMA', path, 'must contain exactly three RGBA control maps');
  }
  const ids = new Set();
  let expectedWidth;
  let expectedHeight;
  return value.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const control = exactKeys(
      entry,
      ['id', 'file', 'channels', 'width', 'height', 'columnOrder', 'rowOrder'],
      [],
      entryPath,
    );
    const id = stableId(control.id, `${entryPath}.id`);
    if (ids.has(id)) fail('ERR_CUSTOMS_TERRAIN_SCHEMA', `${entryPath}.id`, `duplicates ${id}`);
    ids.add(id);
    const file = safeRelativePath(control.file, `${entryPath}.file`);
    if (!file.toLowerCase().endsWith('.png')) {
      fail('ERR_CUSTOMS_TERRAIN_SCHEMA', `${entryPath}.file`, 'must reference a PNG');
    }
    if (!Array.isArray(control.channels) || control.channels.length !== CONTROL_CHANNELS.length) {
      fail('ERR_CUSTOMS_TERRAIN_SCHEMA', `${entryPath}.channels`, 'must be [r, g, b, a]');
    }
    CONTROL_CHANNELS.forEach((channel, channelIndex) => {
      if (control.channels[channelIndex] !== channel) {
        fail('ERR_CUSTOMS_TERRAIN_SCHEMA', `${entryPath}.channels`, 'must be [r, g, b, a] in that order');
      }
    });
    const width = safeInteger(control.width, `${entryPath}.width`, 1);
    const height = safeInteger(control.height, `${entryPath}.height`, 1);
    if (index === 0) {
      expectedWidth = width;
      expectedHeight = height;
    } else if (width !== expectedWidth || height !== expectedHeight) {
      fail('ERR_CUSTOMS_TERRAIN_SCHEMA', entryPath, 'all control maps in a tile must have equal dimensions');
    }
    if (control.columnOrder !== CONTROL_COLUMN_ORDER) {
      fail('ERR_CUSTOMS_TERRAIN_SCHEMA', `${entryPath}.columnOrder`, `must be ${CONTROL_COLUMN_ORDER}`);
    }
    if (control.rowOrder !== CONTROL_ROW_ORDER) {
      fail('ERR_CUSTOMS_TERRAIN_SCHEMA', `${entryPath}.rowOrder`, `must be ${CONTROL_ROW_ORDER}`);
    }
    return {
      id,
      file,
      channels: [...CONTROL_CHANNELS],
      width,
      height,
      columnOrder: CONTROL_COLUMN_ORDER,
      rowOrder: CONTROL_ROW_ORDER,
    };
  });
}

function normalizeLayers(value, controlMaps, path) {
  if (!Array.isArray(value) || value.length === 0 || value.length > controlMaps.length * CONTROL_CHANNELS.length) {
    fail('ERR_CUSTOMS_TERRAIN_SCHEMA', path, 'must contain from one through twelve terrain layers');
  }
  const ids = new Set();
  const indexes = new Set();
  const layers = value.map((entry, entryIndex) => {
    const entryPath = `${path}[${entryIndex}]`;
    const layer = exactKeys(entry, ['id', 'name', 'index', 'controlMapId', 'channel'], [], entryPath);
    const id = stableId(layer.id, `${entryPath}.id`);
    if (ids.has(id)) fail('ERR_CUSTOMS_TERRAIN_SCHEMA', `${entryPath}.id`, `duplicates ${id}`);
    ids.add(id);
    const index = safeInteger(layer.index, `${entryPath}.index`, 0);
    if (index >= controlMaps.length * CONTROL_CHANNELS.length) {
      fail('ERR_CUSTOMS_TERRAIN_SCHEMA', `${entryPath}.index`, 'exceeds the available control-map channels');
    }
    if (indexes.has(index)) fail('ERR_CUSTOMS_TERRAIN_SCHEMA', `${entryPath}.index`, `duplicates ${index}`);
    indexes.add(index);
    const expectedControl = controlMaps[Math.floor(index / CONTROL_CHANNELS.length)];
    const expectedChannel = CONTROL_CHANNELS[index % CONTROL_CHANNELS.length];
    const controlMapId = stableId(layer.controlMapId, `${entryPath}.controlMapId`);
    if (controlMapId !== expectedControl.id) {
      fail(
        'ERR_CUSTOMS_TERRAIN_SCHEMA',
        `${entryPath}.controlMapId`,
        `layer index ${index} must use ${expectedControl.id}`,
      );
    }
    if (layer.channel !== expectedChannel) {
      fail(
        'ERR_CUSTOMS_TERRAIN_SCHEMA',
        `${entryPath}.channel`,
        `layer index ${index} must use channel ${expectedChannel}`,
      );
    }
    return {
      id,
      name: text(layer.name, `${entryPath}.name`),
      index,
      controlMapId,
      channel: expectedChannel,
    };
  });
  for (let index = 0; index < layers.length; index += 1) {
    if (!indexes.has(index)) {
      fail('ERR_CUSTOMS_TERRAIN_SCHEMA', path, 'layer indexes must be contiguous from zero');
    }
  }
  return layers.sort((a, b) => a.index - b.index);
}

function normalizeVegetation(value, path) {
  const vegetation = exactKeys(value, ['file', 'format', 'count', 'prototypes'], [], path);
  const file = safeRelativePath(vegetation.file, `${path}.file`);
  if (vegetation.format !== 'json') fail('ERR_CUSTOMS_TERRAIN_SCHEMA', `${path}.format`, 'must be json');
  if (!file.toLowerCase().endsWith('.json')) {
    fail('ERR_CUSTOMS_TERRAIN_SCHEMA', `${path}.file`, 'must reference a JSON file');
  }
  if (!Array.isArray(vegetation.prototypes)) {
    fail('ERR_CUSTOMS_TERRAIN_SCHEMA', `${path}.prototypes`, 'must be an array');
  }
  const ids = new Set();
  const prototypes = vegetation.prototypes.map((entry, index) => {
    const entryPath = `${path}.prototypes[${index}]`;
    const prototype = exactKeys(entry, ['id', 'name'], [], entryPath);
    const id = stableId(prototype.id, `${entryPath}.id`);
    if (ids.has(id)) fail('ERR_CUSTOMS_TERRAIN_SCHEMA', `${entryPath}.id`, `duplicates ${id}`);
    ids.add(id);
    return { id, name: text(prototype.name, `${entryPath}.name`) };
  });
  const count = safeInteger(vegetation.count, `${path}.count`, 0);
  if (count > 0 && prototypes.length === 0) {
    fail('ERR_CUSTOMS_TERRAIN_SCHEMA', `${path}.prototypes`, 'must describe non-empty vegetation');
  }
  return { file, format: 'json', count, prototypes };
}

function normalizeTile(value, index) {
  const path = `tiles[${index}]`;
  const tile = exactKeys(
    value,
    [
      'id', 'origin', 'resolution', 'sampleSpacingM', 'heightEncoding',
      'heightFile', 'controlMaps', 'layers',
    ],
    ['vegetation'],
    path,
  );
  const origin = exactKeys(tile.origin, ['x', 'y', 'z'], [], `${path}.origin`);
  const resolution = exactKeys(tile.resolution, ['columns', 'rows'], [], `${path}.resolution`);
  const spacing = exactKeys(tile.sampleSpacingM, ['x', 'z'], [], `${path}.sampleSpacingM`);
  const columns = safeInteger(resolution.columns, `${path}.resolution.columns`, 2);
  const rows = safeInteger(resolution.rows, `${path}.resolution.rows`, 2);
  const sampleCount = columns * rows;
  if (!Number.isSafeInteger(sampleCount)) {
    fail('ERR_CUSTOMS_TERRAIN_SCHEMA', `${path}.resolution`, 'sample count exceeds the safe integer range');
  }
  const normalizedOrigin = {
    x: finiteNumber(origin.x, `${path}.origin.x`),
    y: finiteNumber(origin.y, `${path}.origin.y`),
    z: finiteNumber(origin.z, `${path}.origin.z`),
  };
  const normalizedSpacing = {
    x: positiveNumber(spacing.x, `${path}.sampleSpacingM.x`),
    z: positiveNumber(spacing.z, `${path}.sampleSpacingM.z`),
  };
  const maxX = normalizedOrigin.x + ((columns - 1) * normalizedSpacing.x);
  const maxZ = normalizedOrigin.z + ((rows - 1) * normalizedSpacing.z);
  if (!Number.isFinite(maxX) || !Number.isFinite(maxZ)) {
    fail('ERR_CUSTOMS_TERRAIN_NON_FINITE', path, 'derived tile bounds must be finite');
  }
  const controlMaps = normalizeControlMaps(tile.controlMaps, `${path}.controlMaps`);
  const layers = normalizeLayers(tile.layers, controlMaps, `${path}.layers`);
  const normalized = {
    id: stableId(tile.id, `${path}.id`),
    origin: normalizedOrigin,
    resolution: { columns, rows },
    sampleSpacingM: normalizedSpacing,
    heightEncoding: normalizeHeightEncoding(tile.heightEncoding, `${path}.heightEncoding`),
    heightFile: safeRelativePath(tile.heightFile, `${path}.heightFile`),
    controlMaps,
    layers,
  };
  if (Object.prototype.hasOwnProperty.call(tile, 'vegetation')) {
    normalized.vegetation = normalizeVegetation(tile.vegetation, `${path}.vegetation`);
  }
  return {
    tile: normalized,
    bounds: { minX: normalizedOrigin.x, maxX, minZ: normalizedOrigin.z, maxZ },
    sampleCount,
  };
}

function uniqueCoordinates(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const unique = [];
  for (const value of sorted) {
    if (unique.length === 0 || !closeEnough(unique[unique.length - 1], value)) unique.push(value);
  }
  return unique;
}

function tileCoversInterior(tileState, x, z) {
  const { bounds } = tileState;
  const epsilonX = COORDINATE_EPSILON * Math.max(1, Math.abs(x), Math.abs(bounds.minX), Math.abs(bounds.maxX));
  const epsilonZ = COORDINATE_EPSILON * Math.max(1, Math.abs(z), Math.abs(bounds.minZ), Math.abs(bounds.maxZ));
  return x >= bounds.minX - epsilonX
    && x <= bounds.maxX + epsilonX
    && z >= bounds.minZ - epsilonZ
    && z <= bounds.maxZ + epsilonZ;
}

function assertRectangleCoverage(tileStates, coverage, context, { allowGaps = false } = {}) {
  const xs = uniqueCoordinates([
    coverage.minX,
    coverage.maxX,
    ...tileStates.flatMap(({ bounds }) => [
      clamp(bounds.minX, coverage.minX, coverage.maxX),
      clamp(bounds.maxX, coverage.minX, coverage.maxX),
    ]),
  ]);
  const zs = uniqueCoordinates([
    coverage.minZ,
    coverage.maxZ,
    ...tileStates.flatMap(({ bounds }) => [
      clamp(bounds.minZ, coverage.minZ, coverage.maxZ),
      clamp(bounds.maxZ, coverage.minZ, coverage.maxZ),
    ]),
  ]);
  for (let xIndex = 0; xIndex < xs.length - 1; xIndex += 1) {
    if (closeEnough(xs[xIndex], xs[xIndex + 1])) continue;
    const x = (xs[xIndex] + xs[xIndex + 1]) / 2;
    for (let zIndex = 0; zIndex < zs.length - 1; zIndex += 1) {
      if (closeEnough(zs[zIndex], zs[zIndex + 1])) continue;
      const z = (zs[zIndex] + zs[zIndex + 1]) / 2;
      const covering = tileStates.filter((tileState) => tileCoversInterior(tileState, x, z));
      if (covering.length === 0 && !allowGaps) {
        fail('ERR_CUSTOMS_TERRAIN_GAP', context, `has a gap near game coordinate (${x}, ${z})`);
      }
      if (covering.length > 1) {
        fail(
          'ERR_CUSTOMS_TERRAIN_OVERLAP',
          context,
          `overlaps near game coordinate (${x}, ${z}) in tiles ${covering.map(({ tile }) => tile.id).join(', ')}`,
        );
      }
    }
  }
}

/**
 * Validate and deep-freeze a strict Customs terrain manifest v1.
 * Unknown fields are rejected so producer/runtime drift cannot silently alter coordinates.
 *
 * `localOnly` used to be pinned to `true` here, because every package this schema described was
 * local-only. Since 2026-09-02 the founder has approved PROMOTING the height and control surfaces
 * to `public/`, and the promoted package ships — so a `localOnly: true` on it would be a document
 * asserting the opposite of what shipping it means.
 *
 * The field is therefore still REQUIRED and still a strict boolean, and `expectLocalOnly` says
 * which value this caller will accept. It defaults to `true`, so every existing call site — the
 * loopback loader, the extractor's own tests, the audit — is unchanged: a package that claims to
 * be shippable is still refused where a local package is expected. The promoted loader passes
 * `false`, and refuses a package that claims to be local-only. Neither loader accepts both, which
 * is what keeps this a discriminating field rather than a decoration.
 */
export function validateCustomsLocalTerrainManifest(value, options = {}) {
  // A manifest that has already been normalized was validated by whoever normalized it, against
  // THEIR expectation. Re-checking it against this call's DEFAULT would make every downstream
  // re-validation — `createCustomsLocalTerrainRuntime`, `lookupCustomsTerrainTile`, the mesh
  // planner — impose a distribution policy none of them owns, and a promoted package would fail
  // inside the runtime builder rather than at its door. So the memoized path enforces the
  // expectation only when the caller stated one.
  if (manifestState.has(value)) {
    if (options.expectLocalOnly !== undefined && value.localOnly !== options.expectLocalOnly) {
      fail(
        'ERR_CUSTOMS_TERRAIN_NON_LOCAL',
        'manifest.localOnly',
        `must be ${options.expectLocalOnly} for this consumer`,
      );
    }
    return value;
  }
  const expectLocalOnly = options.expectLocalOnly ?? true;
  const root = exactKeys(
    value,
    ['schemaVersion', 'map', 'localOnly', 'sourceFrame', 'reliefOriginYM', 'tiles'],
    [],
    'manifest',
  );
  if (root.schemaVersion !== CUSTOMS_LOCAL_TERRAIN_SCHEMA_VERSION) {
    fail('ERR_CUSTOMS_TERRAIN_SCHEMA', 'manifest.schemaVersion', `must be ${CUSTOMS_LOCAL_TERRAIN_SCHEMA_VERSION}`);
  }
  if (root.map !== MAP_ID) fail('ERR_CUSTOMS_TERRAIN_SCHEMA', 'manifest.map', `must be ${MAP_ID}`);
  if (typeof root.localOnly !== 'boolean') {
    fail('ERR_CUSTOMS_TERRAIN_SCHEMA', 'manifest.localOnly', 'must be a boolean');
  }
  if (root.localOnly !== expectLocalOnly) {
    fail('ERR_CUSTOMS_TERRAIN_NON_LOCAL', 'manifest.localOnly', `must be ${expectLocalOnly}`);
  }
  if (root.sourceFrame !== CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME) {
    fail(
      'ERR_CUSTOMS_TERRAIN_FRAME',
      'manifest.sourceFrame',
      `must be ${CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME}`,
    );
  }
  if (!Array.isArray(root.tiles) || root.tiles.length === 0) {
    fail('ERR_CUSTOMS_TERRAIN_SCHEMA', 'manifest.tiles', 'must be a non-empty array');
  }

  const reliefOriginYM = finiteNumber(root.reliefOriginYM, 'manifest.reliefOriginYM');
  const tileStates = root.tiles.map(normalizeTile);
  const tileIds = new Set();
  const assetFiles = new Map();
  for (let index = 0; index < tileStates.length; index += 1) {
    const { tile } = tileStates[index];
    if (tileIds.has(tile.id)) fail('ERR_CUSTOMS_TERRAIN_SCHEMA', `tiles[${index}].id`, `duplicates ${tile.id}`);
    tileIds.add(tile.id);
    const files = [
      ['heightFile', tile.heightFile],
      ...tile.controlMaps.map((control, controlIndex) => [`controlMaps[${controlIndex}].file`, control.file]),
    ];
    if (tile.vegetation) files.push(['vegetation.file', tile.vegetation.file]);
    for (const [field, file] of files) {
      if (assetFiles.has(file)) {
        fail(
          'ERR_CUSTOMS_TERRAIN_SCHEMA',
          `tiles[${index}].${field}`,
          `reuses ${file}, already referenced by ${assetFiles.get(file)}`,
        );
      }
      assetFiles.set(file, `tile ${tile.id}`);
    }
  }

  const coverage = {
    minX: Math.min(...tileStates.map(({ bounds }) => bounds.minX)),
    maxX: Math.max(...tileStates.map(({ bounds }) => bounds.maxX)),
    minZ: Math.min(...tileStates.map(({ bounds }) => bounds.minZ)),
    maxZ: Math.max(...tileStates.map(({ bounds }) => bounds.maxZ)),
  };
  // A scene may legitimately contain disjoint TerrainData slices. Without a
  // declared coverage polygon, an empty part of the union bbox is not proof of
  // a missing tile. Positive-area overlap is always ambiguous and is rejected;
  // individual lookup and mesh-scope operations reject any gap they touch.
  assertRectangleCoverage(tileStates, coverage, 'manifest.tiles', { allowGaps: true });

  const normalized = deepFreeze({
    schemaVersion: CUSTOMS_LOCAL_TERRAIN_SCHEMA_VERSION,
    map: MAP_ID,
    localOnly: root.localOnly,
    sourceFrame: CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME,
    reliefOriginYM,
    tiles: tileStates.map(({ tile }) => tile),
  });
  const normalizedTileStates = tileStates.map((tileState, index) => ({
    ...tileState,
    tile: normalized.tiles[index],
  }));
  manifestState.set(normalized, {
    coverage: Object.freeze(coverage),
    tileStates: normalizedTileStates,
    tilesById: new Map(normalizedTileStates.map((tileState) => [tileState.tile.id, tileState])),
  });
  return normalized;
}

function byteView(value, path) {
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  fail('ERR_CUSTOMS_TERRAIN_BYTES', path, 'must be an ArrayBuffer or ArrayBuffer view');
}

/** Decode exactly `expectedSampleCount` little-endian Float32 canonical Y values. */
export function decodeCustomsTerrainFloat32LE(value, expectedSampleCount) {
  const count = safeInteger(expectedSampleCount, 'expectedSampleCount', 1);
  const expectedByteLength = count * FLOAT_BYTES;
  if (!Number.isSafeInteger(expectedByteLength)) {
    fail('ERR_CUSTOMS_TERRAIN_BYTES', 'expectedSampleCount', 'produces an unsafe byte length');
  }
  const bytes = byteView(value, 'height bytes');
  if (bytes.byteLength !== expectedByteLength) {
    fail(
      'ERR_CUSTOMS_TERRAIN_BYTE_LENGTH',
      'height bytes',
      `must contain exactly ${expectedByteLength} bytes for ${count} Float32 samples; received ${bytes.byteLength}`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const sample = view.getFloat32(index * FLOAT_BYTES, true);
    if (!Number.isFinite(sample)) {
      fail('ERR_CUSTOMS_TERRAIN_NON_FINITE', `height samples[${index}]`, 'must be finite');
    }
    samples[index] = Object.is(sample, -0) ? 0 : sample;
  }
  return samples;
}

function suppliedHeightFiles(value) {
  if (value instanceof Map) return new Map(value);
  const files = objectAt(value, 'heightFiles');
  return new Map(Object.entries(files));
}

/** Hydrate a validated manifest from caller-provided local height buffers. */
export function createCustomsLocalTerrainRuntime(manifestValue, heightFileValues) {
  const manifest = validateCustomsLocalTerrainManifest(manifestValue);
  const files = suppliedHeightFiles(heightFileValues);
  const expectedFiles = new Set(manifest.tiles.map(({ heightFile }) => heightFile));
  for (const key of files.keys()) {
    if (typeof key !== 'string' || !expectedFiles.has(key)) {
      fail('ERR_CUSTOMS_TERRAIN_BYTES', 'heightFiles', `contains unexpected file ${String(key)}`);
    }
  }
  const heightsByTileId = new Map();
  const state = manifestState.get(manifest);
  for (const tileState of state.tileStates) {
    const { tile, sampleCount } = tileState;
    if (!files.has(tile.heightFile)) {
      fail('ERR_CUSTOMS_TERRAIN_BYTES', 'heightFiles', `is missing ${tile.heightFile}`);
    }
    heightsByTileId.set(
      tile.id,
      decodeCustomsTerrainFloat32LE(files.get(tile.heightFile), sampleCount),
    );
  }
  const runtime = Object.freeze({ manifest });
  runtimeState.set(runtime, { heightsByTileId });
  return runtime;
}

function manifestFrom(value) {
  if (runtimeState.has(value)) return value.manifest;
  return validateCustomsLocalTerrainManifest(value);
}

function requireRuntime(value) {
  const state = runtimeState.get(value);
  if (!state) fail('ERR_CUSTOMS_TERRAIN_RUNTIME', 'runtime', 'must be created by createCustomsLocalTerrainRuntime');
  return state;
}

function normalizePoint(value, path = 'point') {
  const point = exactKeys(value, ['sourceFrame', 'x', 'z'], [], path);
  if (point.sourceFrame !== CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME) {
    fail('ERR_CUSTOMS_TERRAIN_FRAME', `${path}.sourceFrame`, `must be ${CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME}`);
  }
  return {
    sourceFrame: CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME,
    x: finiteNumber(point.x, `${path}.x`),
    z: finiteNumber(point.z, `${path}.z`),
  };
}

function partitionAxisContains(value, minimum, maximum, coverageMaximum) {
  const epsilon = COORDINATE_EPSILON * Math.max(1, Math.abs(value), Math.abs(minimum), Math.abs(maximum));
  if (value < minimum - epsilon || value > maximum + epsilon) return false;
  const ownsUpperEdge = closeEnough(maximum, coverageMaximum);
  return ownsUpperEdge ? value <= maximum + epsilon : value < maximum - epsilon;
}

function tileStateAt(manifest, point) {
  const state = manifestState.get(manifest);
  const { coverage } = state;
  const closedCandidates = state.tileStates.filter((tileState) => tileCoversInterior(
    tileState,
    point.x,
    point.z,
  ));
  if (closedCandidates.length === 0) {
    fail('ERR_CUSTOMS_TERRAIN_GAP', 'point', `is outside terrain coverage at (${point.x}, ${point.z})`);
  }
  if (closedCandidates.length === 1) return closedCandidates[0];

  // Edge-adjacent tiles share canonical samples. Assign their zero-area seam
  // deterministically to the +X/+Z side; positive-area overlaps were already
  // rejected by manifest validation.
  const candidates = closedCandidates.filter(({ bounds }) => (
    partitionAxisContains(point.x, bounds.minX, bounds.maxX, coverage.maxX)
    && partitionAxisContains(point.z, bounds.minZ, bounds.maxZ, coverage.maxZ)
  ));
  if (candidates.length !== 1) {
    fail(
      'ERR_CUSTOMS_TERRAIN_OVERLAP',
      'point',
      `matches ambiguous tile boundaries ${closedCandidates.map(({ tile }) => tile.id).join(', ')}`,
    );
  }
  return candidates[0];
}

/** Return the one tile owning a frame-explicit game coordinate. Shared edges are half-open. */
export function lookupCustomsTerrainTile(manifestOrRuntime, pointValue) {
  const manifest = manifestFrom(manifestOrRuntime);
  return tileStateAt(manifest, normalizePoint(pointValue)).tile;
}

/** Read one unmodified canonical grid value from a hydrated runtime. */
export function customsTerrainCanonicalGridSample(runtime, tileIdValue, columnValue, rowValue) {
  const runtimePrivate = requireRuntime(runtime);
  const manifest = runtime.manifest;
  const tileId = stableId(tileIdValue, 'tileId');
  const tileState = manifestState.get(manifest).tilesById.get(tileId);
  if (!tileState) fail('ERR_CUSTOMS_TERRAIN_SCHEMA', 'tileId', `does not exist: ${tileId}`);
  const column = safeInteger(columnValue, 'column', 0);
  const row = safeInteger(rowValue, 'row', 0);
  if (column >= tileState.tile.resolution.columns || row >= tileState.tile.resolution.rows) {
    fail('ERR_CUSTOMS_TERRAIN_SCHEMA', 'grid sample', 'is outside the tile resolution');
  }
  return runtimePrivate.heightsByTileId.get(tileId)[
    (row * tileState.tile.resolution.columns) + column
  ];
}

function snapGridCoordinate(value) {
  const rounded = Math.round(value);
  return closeEnough(value, rounded) ? rounded : value;
}

function bilinearCanonicalSample(runtime, point) {
  const runtimePrivate = requireRuntime(runtime);
  const tileState = tileStateAt(runtime.manifest, point);
  const { tile } = tileState;
  const lastColumn = tile.resolution.columns - 1;
  const lastRow = tile.resolution.rows - 1;
  const gridX = clamp(
    snapGridCoordinate((point.x - tile.origin.x) / tile.sampleSpacingM.x),
    0,
    lastColumn,
  );
  const gridZ = clamp(
    snapGridCoordinate((point.z - tile.origin.z) / tile.sampleSpacingM.z),
    0,
    lastRow,
  );
  const column0 = Math.floor(gridX);
  const row0 = Math.floor(gridZ);
  const column1 = Math.min(column0 + 1, lastColumn);
  const row1 = Math.min(row0 + 1, lastRow);
  const tx = gridX - column0;
  const tz = gridZ - row0;
  const heights = runtimePrivate.heightsByTileId.get(tile.id);
  const columns = tile.resolution.columns;
  const h00 = heights[(row0 * columns) + column0];
  const h10 = heights[(row0 * columns) + column1];
  const h01 = heights[(row1 * columns) + column0];
  const h11 = heights[(row1 * columns) + column1];
  const near = h00 + ((h10 - h00) * tx);
  const far = h01 + ((h11 - h01) * tx);
  return {
    tile,
    canonicalYM: near + ((far - near) * tz),
    grid: { column0, column1, row0, row1, tx, tz },
  };
}

/** Apply the one supported display transform without changing canonical elevation. */
export function customsTerrainDisplayY(canonicalYMValue, reliefOriginYMValue) {
  const canonicalYM = finiteNumber(canonicalYMValue, 'canonicalYM');
  const reliefOriginYM = finiteNumber(reliefOriginYMValue, 'reliefOriginYM');
  const displayYM = reliefOriginYM
    + ((canonicalYM - reliefOriginYM) * CUSTOMS_LOCAL_TERRAIN_DISPLAY_RELIEF_SCALE);
  if (!Number.isFinite(displayYM)) {
    fail('ERR_CUSTOMS_TERRAIN_NON_FINITE', 'displayYM', 'fixed-2x relief transform overflowed');
  }
  return displayYM;
}

/** Exact bilinear sample: raw canonical Y plus the separately derived fixed-2x display Y. */
export function sampleCustomsTerrainElevation(runtime, pointValue) {
  const point = normalizePoint(pointValue);
  const sample = bilinearCanonicalSample(runtime, point);
  const reliefOriginYM = runtime.manifest.reliefOriginYM;
  return deepFreeze({
    sourceFrame: CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME,
    tileId: sample.tile.id,
    canonicalYM: sample.canonicalYM,
    displayYM: customsTerrainDisplayY(sample.canonicalYM, reliefOriginYM),
    reliefOriginYM,
    displayReliefScale: CUSTOMS_LOCAL_TERRAIN_DISPLAY_RELIEF_SCALE,
    grid: sample.grid,
  });
}

export function sampleCustomsTerrainCanonicalElevation(runtime, pointValue) {
  return sampleCustomsTerrainElevation(runtime, pointValue).canonicalYM;
}

/**
 * Resolve the semantic layer control coordinate for a point. PNG scanline zero is
 * z-min, so CPU pixelY increases with +Z and no implicit vertical flip is applied.
 */
export function customsTerrainSemanticControlUv(manifestOrRuntime, pointValue, layerIdValue) {
  const manifest = manifestFrom(manifestOrRuntime);
  const point = normalizePoint(pointValue);
  const tileState = tileStateAt(manifest, point);
  const layerId = stableId(layerIdValue, 'layerId');
  const layer = tileState.tile.layers.find(({ id }) => id === layerId);
  if (!layer) fail('ERR_CUSTOMS_TERRAIN_SCHEMA', 'layerId', `does not exist on tile ${tileState.tile.id}: ${layerId}`);
  const controlMap = tileState.tile.controlMaps.find(({ id }) => id === layer.controlMapId);
  const u = clamp((point.x - tileState.bounds.minX) / (tileState.bounds.maxX - tileState.bounds.minX), 0, 1);
  const v = clamp((point.z - tileState.bounds.minZ) / (tileState.bounds.maxZ - tileState.bounds.minZ), 0, 1);
  return deepFreeze({
    sourceFrame: CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME,
    tileId: tileState.tile.id,
    layerId: layer.id,
    controlMapId: controlMap.id,
    channel: layer.channel,
    u,
    v,
    pixelX: u * (controlMap.width - 1),
    pixelY: v * (controlMap.height - 1),
    columnOrder: CONTROL_COLUMN_ORDER,
    rowOrder: CONTROL_ROW_ORDER,
  });
}

function normalizeScope(value) {
  const scope = exactKeys(value, ['sourceFrame', 'minX', 'maxX', 'minZ', 'maxZ'], [], 'scope');
  if (scope.sourceFrame !== CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME) {
    fail('ERR_CUSTOMS_TERRAIN_FRAME', 'scope.sourceFrame', `must be ${CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME}`);
  }
  const normalized = {
    sourceFrame: CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME,
    minX: finiteNumber(scope.minX, 'scope.minX'),
    maxX: finiteNumber(scope.maxX, 'scope.maxX'),
    minZ: finiteNumber(scope.minZ, 'scope.minZ'),
    maxZ: finiteNumber(scope.maxZ, 'scope.maxZ'),
  };
  if (!(normalized.maxX > normalized.minX) || !(normalized.maxZ > normalized.minZ)) {
    fail('ERR_CUSTOMS_TERRAIN_SCHEMA', 'scope', 'max must exceed min on X and Z');
  }
  return normalized;
}

function normalizeDecimation(optionsValue) {
  if (optionsValue === undefined) return { x: 1, z: 1 };
  const options = exactKeys(optionsValue, [], ['decimation'], 'options');
  if (options.decimation === undefined) return { x: 1, z: 1 };
  if (Number.isSafeInteger(options.decimation)) {
    const stride = safeInteger(options.decimation, 'options.decimation', 1);
    return { x: stride, z: stride };
  }
  const decimation = exactKeys(options.decimation, ['x', 'z'], [], 'options.decimation');
  return {
    x: safeInteger(decimation.x, 'options.decimation.x', 1),
    z: safeInteger(decimation.z, 'options.decimation.z', 1),
  };
}

function snappedRatio(value) {
  const rounded = Math.round(value);
  return closeEnough(value, rounded) ? rounded : value;
}

function sampleWindow(minimum, maximum, origin, spacing, lastIndex) {
  let start = clamp(Math.floor(snappedRatio((minimum - origin) / spacing)), 0, lastIndex);
  let end = clamp(Math.ceil(snappedRatio((maximum - origin) / spacing)), 0, lastIndex);
  if (start === end) {
    if (end < lastIndex) end += 1;
    else if (start > 0) start -= 1;
  }
  return { start, end };
}

function decimatedIndices(start, end, stride) {
  const indices = [];
  for (let index = start; index <= end; index += stride) indices.push(index);
  if (indices[indices.length - 1] !== end) indices.push(end);
  return indices;
}

/**
 * Return a renderer-neutral crop/decimation plan. Crop edges expand to surrounding
 * source samples, and the final row/column is always retained for full coverage.
 */
export function planCustomsTerrainMesh(manifestOrRuntime, scopeValue, optionsValue) {
  const manifest = manifestFrom(manifestOrRuntime);
  const scope = normalizeScope(scopeValue);
  const decimation = normalizeDecimation(optionsValue);
  const state = manifestState.get(manifest);
  const { coverage } = state;
  if (
    scope.minX < coverage.minX && !closeEnough(scope.minX, coverage.minX)
    || scope.maxX > coverage.maxX && !closeEnough(scope.maxX, coverage.maxX)
    || scope.minZ < coverage.minZ && !closeEnough(scope.minZ, coverage.minZ)
    || scope.maxZ > coverage.maxZ && !closeEnough(scope.maxZ, coverage.maxZ)
  ) {
    fail('ERR_CUSTOMS_TERRAIN_GAP', 'scope', 'extends outside terrain coverage');
  }
  assertRectangleCoverage(state.tileStates, scope, 'scope');

  const patches = [];
  let vertexCount = 0;
  let triangleCount = 0;
  for (const tileState of state.tileStates) {
    const crop = {
      minX: Math.max(scope.minX, tileState.bounds.minX),
      maxX: Math.min(scope.maxX, tileState.bounds.maxX),
      minZ: Math.max(scope.minZ, tileState.bounds.minZ),
      maxZ: Math.min(scope.maxZ, tileState.bounds.maxZ),
    };
    if (!(crop.maxX > crop.minX) || !(crop.maxZ > crop.minZ)) continue;
    const { tile } = tileState;
    const columns = sampleWindow(
      crop.minX,
      crop.maxX,
      tile.origin.x,
      tile.sampleSpacingM.x,
      tile.resolution.columns - 1,
    );
    const rows = sampleWindow(
      crop.minZ,
      crop.maxZ,
      tile.origin.z,
      tile.sampleSpacingM.z,
      tile.resolution.rows - 1,
    );
    const columnIndices = decimatedIndices(columns.start, columns.end, decimation.x);
    const rowIndices = decimatedIndices(rows.start, rows.end, decimation.z);
    const patchVertexCount = columnIndices.length * rowIndices.length;
    const patchTriangleCount = (columnIndices.length - 1) * (rowIndices.length - 1) * 2;
    if (!Number.isSafeInteger(patchVertexCount) || !Number.isSafeInteger(patchTriangleCount)) {
      fail('ERR_CUSTOMS_TERRAIN_SCHEMA', `mesh patch ${tile.id}`, 'exceeds the safe integer range');
    }
    vertexCount += patchVertexCount;
    triangleCount += patchTriangleCount;
    patches.push({
      tileId: tile.id,
      heightFile: tile.heightFile,
      cropBounds: crop,
      sampledBounds: {
        minX: tile.origin.x + (columns.start * tile.sampleSpacingM.x),
        maxX: tile.origin.x + (columns.end * tile.sampleSpacingM.x),
        minZ: tile.origin.z + (rows.start * tile.sampleSpacingM.z),
        maxZ: tile.origin.z + (rows.end * tile.sampleSpacingM.z),
      },
      sampleWindow: {
        columnStart: columns.start,
        columnEnd: columns.end,
        rowStart: rows.start,
        rowEnd: rows.end,
      },
      columnIndices,
      rowIndices,
      vertexColumns: columnIndices.length,
      vertexRows: rowIndices.length,
      vertexCount: patchVertexCount,
      triangleCount: patchTriangleCount,
    });
  }
  if (patches.length === 0) fail('ERR_CUSTOMS_TERRAIN_GAP', 'scope', 'does not intersect a terrain tile');
  if (!Number.isSafeInteger(vertexCount) || !Number.isSafeInteger(triangleCount)) {
    fail('ERR_CUSTOMS_TERRAIN_SCHEMA', 'mesh plan', 'exceeds the safe integer range');
  }
  return deepFreeze({
    map: MAP_ID,
    sourceFrame: CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME,
    scope,
    decimation,
    relief: {
      canonicalValuesPreserved: true,
      displayScale: CUSTOMS_LOCAL_TERRAIN_DISPLAY_RELIEF_SCALE,
      originYM: manifest.reliefOriginYM,
    },
    patches,
    vertexCount,
    triangleCount,
  });
}
