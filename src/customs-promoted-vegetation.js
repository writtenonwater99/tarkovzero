/**
 * The PROMOTED Customs vegetation package: its public document shape and its placement codec.
 *
 * ── Why this file exists, and what it is careful about ────────────────────────────────────────
 *
 * On 2026-09-02 the terrain height and control surfaces were promoted out of `.local-game-derived/`
 * and now ship from `public/assets/3d/customs/terrain/`. The founder then approved promoting the
 * authored vegetation the same way. Three things had to travel for that to mean anything on screen:
 *
 *   1. THE GEOMETRY — 31 authored families x 3 LODs = 93 GLBs, 16 MB. STRONG receipt: every family
 *      reports `geometryEvidence: "original approximation from scalar prototype identity and
 *      fallback envelope"`, and `validation/factory-provenance-report.json` hashes the pack against
 *      the git-tracked factory (`scripts/vegetation-asset-factory/vegetation_factory.py`) and
 *      catalog (`prototype_catalog.json`). Re-running the committed factory REGENERATES those
 *      bytes. That is a provenance chain, not a claim, and it is what makes the geometry promotable.
 *
 *   2. THE SHARED TEXTURE ARRAYS — 9 blobs, 26 MB, built by the committed
 *      `build_texture_arrays.py` from the same authored source textures. Same class of receipt.
 *
 *   3. THE 8,805 PLACEMENTS — and these are NOT the same class, which is the whole reason this
 *      module says so out loud.
 *
 * ── The placements, stated honestly ───────────────────────────────────────────────────────────
 *
 * `pack-index.json`'s own `placements[]` mirror carries only identity — `(tileId, prototypeId,
 * assetId, instanceIndex)` — and NO coordinates. The coordinates exist in exactly one place in this
 * repository: `.local-game-derived/customs/terrain-{000,001}-vegetation.json`, the raw Unity
 * TerrainData dump, which is a REGISTERED RAW CAPTURE (`CAPTURE_SUBTREES` in
 * `scripts/lib/asset-promotion.mjs`) and never ships, under any name, by any route.
 *
 * So the placement table shipped here is a DERIVED SCALAR EXTRACT of that capture, produced by
 * `scripts/promote-authored-vegetation.mjs`. It carries, per placement, only the seven scalars the
 * render plan actually consumes plus its identity:
 *
 *      worldPosition x/y/z · rotationRadians · widthScale · heightScale · instance colour · which
 *      of the 58 (tile, prototype) bindings it belongs to · its per-tile instance index
 *
 * and it DROPS everything else the capture holds: `positionNormalized`, `lightmapColor`, the
 * prototype records (`kind`, `bendFactor`, `navMeshLod`, prototype ordinals), the per-tile document
 * structure, and the JSON encoding itself.
 *
 * That makes its receipt the TERRAIN class, not the vegetation class: these are MEASUREMENTS, and
 * what authorises them is the founder's ruling, recorded as such — not a factory that regenerates
 * them from committed inputs. `scripts/lib/asset-promotion.mjs` states plainly that a transformed
 * capture is exactly what its byte-identity boundary cannot see, and that the control for that
 * class is review of the pipeline that writes `public/`. This file and that script ARE that
 * pipeline; they are written to be read.
 *
 * Nothing here reads a file, fetches a URL, or touches THREE. It is the shared shape and codec, so
 * the promotion script and the browser loader cannot drift apart about what a placement row is.
 */

/** Where the promoted package lives in `public/`, and therefore in `dist/` and on the origin. */
export const CUSTOMS_PROMOTED_VEGETATION_BASE_URL = '/assets/3d/customs/authored/vegetation/';
export const CUSTOMS_PROMOTED_VEGETATION_MANIFEST_PATH =
  `${CUSTOMS_PROMOTED_VEGETATION_BASE_URL}vegetation-manifest.json`;
/**
 * The shared texture arrays sit in their own subdirectory with their own index.
 *
 * The index is NOT named `veg-layers.json`: that name is on `FORBIDDEN_FILE_NAMES` in
 * `scripts/verify-build-boundary.mjs` precisely so the local one can never appear in `dist/`, and
 * the promoted document is a regenerated subset anyway (no `packRoot`, no builder identity, no
 * `status: offline-…`), so it is a different document with a different name.
 */
export const CUSTOMS_PROMOTED_VEGETATION_ARRAY_BASE_URL =
  `${CUSTOMS_PROMOTED_VEGETATION_BASE_URL}arrays/`;
export const CUSTOMS_PROMOTED_VEGETATION_ARRAY_INDEX_FILE = 'arrays/veg-arrays.json';
export const CUSTOMS_PROMOTED_VEGETATION_PLACEMENTS_FILE = 'veg-placements.bin';

export const CUSTOMS_PROMOTED_VEGETATION_DOCUMENT_TYPE =
  'tarkovzero-customs-promoted-vegetation-manifest';
export const CUSTOMS_PROMOTED_VEGETATION_SCHEMA_VERSION = 1;
export const CUSTOMS_PROMOTED_VEGETATION_DISTRIBUTION = 'promoted-public';

/** The frame the scalars are in — identical to the local package's, because they are the same numbers. */
export const CUSTOMS_PROMOTED_VEGETATION_SOURCE_FRAME = 'eft-unity-world-metres-y-up';

/** The placement table's own format id, carried in the manifest and in the blob's header. */
export const CUSTOMS_PROMOTED_PLACEMENT_FORMAT =
  'tarkovzero-customs-vegetation-placement-table-v1';
export const CUSTOMS_PROMOTED_PLACEMENT_MAGIC = 'TZVEGPL1';
export const CUSTOMS_PROMOTED_PLACEMENT_HEADER_BYTES = 48;
export const CUSTOMS_PROMOTED_PLACEMENT_STRIDE_BYTES = 48;
/** 8,805 today. A ceiling, not a promise — it exists so a malformed header cannot allocate a GB. */
export const CUSTOMS_PROMOTED_PLACEMENT_MAX_ROWS = 200_000;

/**
 * The row layout, little-endian, in one table so the encoder, the decoder and the manifest's
 * `fields` list are three readings of one definition.
 *
 * WHY f64 FOR POSITION AND f32 FOR THE REST. Measured over all 8,805 rows of the source: 8,581 of
 * the x values and 8,249 of the z values are NOT float32-representable (Unity computes them as
 * `terrainOrigin + normalized * terrainSize` in double), while every `rotationRadians`,
 * `widthScale` and `heightScale` is exactly float32. Storing position as f32 would move a tree by
 * up to ~0.06 mm — invisible, and still a silent, unnecessary edit to a number this repo calls
 * exact. f64 costs 12 bytes a row and makes the round-trip bit-identical, which is a property a
 * test can assert instead of a tolerance it has to choose.
 *
 * COLOUR IS u8/255 BECAUSE THAT IS WHAT IT IS. All 103 distinct colour values in the source satisfy
 * `Math.round(v * 255) / 255 === v` exactly, i.e. Unity stored them as bytes. Round-tripping
 * through u8 is lossless, verified over the whole set rather than assumed.
 */
export const CUSTOMS_PROMOTED_PLACEMENT_FIELDS = Object.freeze([
  Object.freeze({ name: 'worldPositionX', offset: 0, type: 'float64' }),
  Object.freeze({ name: 'worldPositionY', offset: 8, type: 'float64' }),
  Object.freeze({ name: 'worldPositionZ', offset: 16, type: 'float64' }),
  Object.freeze({ name: 'rotationRadians', offset: 24, type: 'float32' }),
  Object.freeze({ name: 'widthScale', offset: 28, type: 'float32' }),
  Object.freeze({ name: 'heightScale', offset: 32, type: 'float32' }),
  Object.freeze({ name: 'instanceIndex', offset: 36, type: 'uint32' }),
  Object.freeze({ name: 'bindingIndex', offset: 40, type: 'uint16' }),
  Object.freeze({ name: 'flags', offset: 42, type: 'uint8', detail: 'bit0: the source declared a colour' }),
  Object.freeze({ name: 'colorR', offset: 43, type: 'uint8', detail: 'value/255' }),
  Object.freeze({ name: 'colorG', offset: 44, type: 'uint8', detail: 'value/255' }),
  Object.freeze({ name: 'colorB', offset: 45, type: 'uint8', detail: 'value/255' }),
  Object.freeze({ name: 'colorA', offset: 46, type: 'uint8', detail: 'value/255' }),
  Object.freeze({ name: 'reserved', offset: 47, type: 'uint8' }),
]);

const PLACEMENT_HAS_COLOR = 1;

export class CustomsPromotedVegetationError extends Error {
  constructor(message, { code = 'ERR_CUSTOMS_PROMOTED_VEGETATION', resource = null, cause } = {}) {
    super(message);
    this.name = 'CustomsPromotedVegetationError';
    this.code = code;
    this.resource = resource;
    if (cause !== undefined) this.cause = cause;
  }
}

function fail(message, options) {
  throw new CustomsPromotedVegetationError(message, options);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    fail(`${label} must be a non-empty exact string`, { resource: label });
  }
  return value;
}

function safeInteger(value, label, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) {
    fail(`${label} must be a safe integer >= ${min}`, { resource: label });
  }
  return value;
}

const SHA256_DECLARATION = /^sha256:[0-9a-f]{64}$/;

/**
 * File names the promoted package may reference, and nothing else.
 *
 * This is the second of the two places the raw capture is refused (the first is the closed capture
 * registry, which has no promotable key rooted at it). A promoted manifest that names
 * `terrain-000-vegetation.json` — by mistake, by a stale generator, or on purpose — is rejected
 * HERE, before any URL is built, so the promoted loader cannot be pointed at a capture even if one
 * were somehow sitting on the origin.
 */
const RAW_CAPTURE_FILE_NAME = /terrain-\d{3}-vegetation\.json/i;

function assertNotCaptureReference(value, label) {
  if (typeof value === 'string' && RAW_CAPTURE_FILE_NAME.test(value)) {
    fail(
      `${label} references the raw Unity vegetation dump (${value}); that file is a registered raw `
      + 'capture and is never promoted, referenced or served',
      { code: 'ERR_CUSTOMS_PROMOTED_VEGETATION_CAPTURE', resource: label },
    );
  }
  return value;
}

/**
 * Walk the whole document once looking for a capture reference.
 *
 * Field-by-field checks only cover the fields somebody thought of. The capture's file name has a
 * shape nothing else in this package produces, so scanning every string in the document is both
 * cheap and complete — and it keeps holding if a future field is added and nobody remembers to
 * check it.
 */
export function assertCustomsPromotedVegetationHasNoCaptureReference(value, path = 'manifest') {
  if (typeof value === 'string') return assertNotCaptureReference(value, path);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertCustomsPromotedVegetationHasNoCaptureReference(entry, `${path}[${index}]`));
    return value;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      assertNotCaptureReference(key, `${path}.${key} (key)`);
      assertCustomsPromotedVegetationHasNoCaptureReference(entry, `${path}.${key}`);
    }
  }
  return value;
}

/**
 * Validate the public manifest document.
 *
 * Deliberately mirrors `loadCustomsPromotedTerrainPackage`'s two refusals and adds one:
 *
 *   * `localOnly` must be FALSE. The local vegetation payloads declare `localOnly: true` and
 *     `loadCustomsLocalVegetation` REQUIRES that, so neither loader accepts the other's package —
 *     the same property the terrain loader pair has.
 *   * `distribution` must be `promoted-public`, so a document cannot be silently repurposed.
 *   * no string anywhere in it may name the raw capture.
 *
 * The catalog half of the document is intentionally the same field names `pack-index.json` uses
 * (`map`, `runtimeContract`, `authoredAssets`, `prototypeBindings`, `counts`, `status`), so
 * `normalizeCustomsAuthoredVegetationCatalog()` consumes this document directly with no adapter and
 * therefore applies exactly the same 31-family / 58-binding strictness it applies on localhost.
 */
export function validateCustomsPromotedVegetationManifest(value) {
  if (!isPlainObject(value)) fail('the promoted vegetation manifest must be an object', { resource: 'manifest' });
  assertCustomsPromotedVegetationHasNoCaptureReference(value);

  if (value.documentType !== CUSTOMS_PROMOTED_VEGETATION_DOCUMENT_TYPE) {
    fail(
      `the promoted vegetation manifest documentType ${JSON.stringify(value.documentType)} is not `
      + CUSTOMS_PROMOTED_VEGETATION_DOCUMENT_TYPE,
      { resource: 'manifest.documentType' },
    );
  }
  if (value.schemaVersion !== CUSTOMS_PROMOTED_VEGETATION_SCHEMA_VERSION) {
    fail(`the promoted vegetation manifest schemaVersion must be ${CUSTOMS_PROMOTED_VEGETATION_SCHEMA_VERSION}`, {
      resource: 'manifest.schemaVersion',
    });
  }
  if (value.map !== 'customs') fail('the promoted vegetation manifest must target Customs', { resource: 'manifest.map' });
  if (value.localOnly !== false) {
    fail(
      'the promoted vegetation manifest must declare localOnly: false; a package that calls itself '
      + 'local-only is the loopback package and is never served from public/',
      { code: 'ERR_CUSTOMS_PROMOTED_VEGETATION_LOCAL_ONLY', resource: 'manifest.localOnly' },
    );
  }
  if (value.distribution !== CUSTOMS_PROMOTED_VEGETATION_DISTRIBUTION) {
    fail(`the promoted vegetation manifest must declare distribution ${CUSTOMS_PROMOTED_VEGETATION_DISTRIBUTION}`, {
      resource: 'manifest.distribution',
    });
  }
  if (value.sourceFrame !== CUSTOMS_PROMOTED_VEGETATION_SOURCE_FRAME) {
    fail(`the promoted vegetation manifest sourceFrame must be ${CUSTOMS_PROMOTED_VEGETATION_SOURCE_FRAME}`, {
      resource: 'manifest.sourceFrame',
    });
  }

  const placements = value.placements;
  if (!isPlainObject(placements)) fail('manifest.placements must be an object', { resource: 'manifest.placements' });
  if (placements.file !== CUSTOMS_PROMOTED_VEGETATION_PLACEMENTS_FILE) {
    fail(`manifest.placements.file must be ${CUSTOMS_PROMOTED_VEGETATION_PLACEMENTS_FILE}`, {
      resource: 'manifest.placements.file',
    });
  }
  if (placements.format !== CUSTOMS_PROMOTED_PLACEMENT_FORMAT) {
    fail(`manifest.placements.format must be ${CUSTOMS_PROMOTED_PLACEMENT_FORMAT}`, {
      resource: 'manifest.placements.format',
    });
  }
  if (placements.stride !== CUSTOMS_PROMOTED_PLACEMENT_STRIDE_BYTES) {
    fail(`manifest.placements.stride must be ${CUSTOMS_PROMOTED_PLACEMENT_STRIDE_BYTES}`, {
      resource: 'manifest.placements.stride',
    });
  }
  const count = safeInteger(placements.count, 'manifest.placements.count', { min: 1 });
  if (count > CUSTOMS_PROMOTED_PLACEMENT_MAX_ROWS) {
    fail(`manifest.placements.count ${count} exceeds the ${CUSTOMS_PROMOTED_PLACEMENT_MAX_ROWS}-row ceiling`, {
      resource: 'manifest.placements.count',
    });
  }
  const bytes = safeInteger(placements.bytes, 'manifest.placements.bytes', { min: 1 });
  const expectedBytes = CUSTOMS_PROMOTED_PLACEMENT_HEADER_BYTES + count * CUSTOMS_PROMOTED_PLACEMENT_STRIDE_BYTES;
  if (bytes !== expectedBytes) {
    fail(
      `manifest.placements.bytes ${bytes} is not header ${CUSTOMS_PROMOTED_PLACEMENT_HEADER_BYTES} + `
      + `${count} x ${CUSTOMS_PROMOTED_PLACEMENT_STRIDE_BYTES} = ${expectedBytes}`,
      { resource: 'manifest.placements.bytes' },
    );
  }
  const sha256 = text(placements.sha256, 'manifest.placements.sha256');
  if (!SHA256_DECLARATION.test(sha256)) {
    fail('manifest.placements.sha256 must be a lowercase sha256:<64 hex> declaration', {
      resource: 'manifest.placements.sha256',
    });
  }

  const arrays = value.arrays;
  if (!isPlainObject(arrays)) fail('manifest.arrays must be an object', { resource: 'manifest.arrays' });
  if (arrays.indexFile !== CUSTOMS_PROMOTED_VEGETATION_ARRAY_INDEX_FILE) {
    fail(`manifest.arrays.indexFile must be ${CUSTOMS_PROMOTED_VEGETATION_ARRAY_INDEX_FILE}`, {
      resource: 'manifest.arrays.indexFile',
    });
  }

  if (!Array.isArray(value.prototypeBindings) || value.prototypeBindings.length === 0) {
    fail('manifest.prototypeBindings must be a non-empty array', { resource: 'manifest.prototypeBindings' });
  }
  const bindings = value.prototypeBindings.map((raw, index) => {
    const at = `manifest.prototypeBindings[${index}]`;
    if (!isPlainObject(raw)) fail(`${at} must be an object`, { resource: at });
    return Object.freeze({
      tileId: text(raw.tileId, `${at}.tileId`),
      prototypeId: text(raw.prototypeId, `${at}.prototypeId`),
      prototypeName: text(raw.prototypeName, `${at}.prototypeName`),
      assetId: text(raw.assetId, `${at}.assetId`),
    });
  });

  return Object.freeze({
    manifest: value,
    bindings: Object.freeze(bindings),
    placements: Object.freeze({
      file: placements.file,
      format: placements.format,
      stride: CUSTOMS_PROMOTED_PLACEMENT_STRIDE_BYTES,
      count,
      bytes,
      sha256,
    }),
    arrays: Object.freeze({ indexFile: arrays.indexFile }),
  });
}

/**
 * Encode the placement table.
 *
 * `instances` must already be in flat order — tile order, then per-tile `index` ascending — because
 * `flatIndex` is the ROW ORDINAL and is not stored. That is the same order
 * `buildInstancingIndex()` assigns on localhost, which is what makes the promoted plan and the
 * local plan the same plan rather than two plans that happen to agree.
 */
export function encodeCustomsPromotedVegetationPlacements(instances, bindingIndexOf) {
  if (!Array.isArray(instances) || instances.length === 0) {
    fail('encodeCustomsPromotedVegetationPlacements requires a non-empty instance array');
  }
  const count = instances.length;
  const bytes = new Uint8Array(
    CUSTOMS_PROMOTED_PLACEMENT_HEADER_BYTES + count * CUSTOMS_PROMOTED_PLACEMENT_STRIDE_BYTES,
  );
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < CUSTOMS_PROMOTED_PLACEMENT_MAGIC.length; index += 1) {
    bytes[index] = CUSTOMS_PROMOTED_PLACEMENT_MAGIC.charCodeAt(index);
  }
  view.setUint32(8, CUSTOMS_PROMOTED_VEGETATION_SCHEMA_VERSION, true);
  view.setUint32(12, CUSTOMS_PROMOTED_PLACEMENT_STRIDE_BYTES, true);
  view.setUint32(16, count, true);

  for (let row = 0; row < count; row += 1) {
    const instance = instances[row];
    const base = CUSTOMS_PROMOTED_PLACEMENT_HEADER_BYTES + row * CUSTOMS_PROMOTED_PLACEMENT_STRIDE_BYTES;
    const bindingIndex = bindingIndexOf(instance, row);
    if (!Number.isSafeInteger(bindingIndex) || bindingIndex < 0 || bindingIndex > 0xffff) {
      fail(`placement ${row} does not resolve to a prototype binding index`);
    }
    view.setFloat64(base + 0, Number(instance.worldPosition.x), true);
    view.setFloat64(base + 8, Number(instance.worldPosition.y), true);
    view.setFloat64(base + 16, Number(instance.worldPosition.z), true);
    view.setFloat32(base + 24, Number(instance.rotationRadians ?? 0), true);
    view.setFloat32(base + 28, Number(instance.widthScale ?? 1), true);
    view.setFloat32(base + 32, Number(instance.heightScale ?? 1), true);
    view.setUint32(base + 36, safeInteger(instance.index, `placement ${row}.index`), true);
    view.setUint16(base + 40, bindingIndex, true);
    const color = instance.color ?? null;
    view.setUint8(base + 42, color ? PLACEMENT_HAS_COLOR : 0);
    const channel = (key) => {
      if (!color || color[key] === undefined) return 255;
      const scaled = Math.round(Number(color[key]) * 255);
      if (!Number.isFinite(scaled) || scaled < 0 || scaled > 255 || scaled / 255 !== Number(color[key])) {
        fail(
          `placement ${row} colour channel ${key} (${color[key]}) is not an exact byte value; the `
          + 'promoted table would not round-trip it',
        );
      }
      return scaled;
    };
    view.setUint8(base + 43, channel('r'));
    view.setUint8(base + 44, channel('g'));
    view.setUint8(base + 45, channel('b'));
    view.setUint8(base + 46, channel('a'));
  }
  return bytes;
}

/**
 * Decode the placement table into the same instance shape `loadCustomsLocalVegetation()` produces.
 *
 * `classify` is injected rather than imported so this module stays free of the local vegetation
 * loader (which imports the loopback terrain loader, which is gated). Callers pass
 * `classifyCustomsVegetationPrototype`.
 */
export function decodeCustomsPromotedVegetationPlacements(buffer, { bindings, classify, expected = null } = {}) {
  if (!Array.isArray(bindings) || bindings.length === 0) {
    fail('decodeCustomsPromotedVegetationPlacements requires the prototype bindings');
  }
  if (typeof classify !== 'function') {
    fail('decodeCustomsPromotedVegetationPlacements requires a classification function');
  }
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < CUSTOMS_PROMOTED_PLACEMENT_HEADER_BYTES) {
    fail('the promoted placement table is shorter than its own header', {
      code: 'ERR_CUSTOMS_PROMOTED_VEGETATION_PLACEMENTS',
    });
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < CUSTOMS_PROMOTED_PLACEMENT_MAGIC.length; index += 1) {
    if (view.getUint8(index) !== CUSTOMS_PROMOTED_PLACEMENT_MAGIC.charCodeAt(index)) {
      fail(`the promoted placement table does not start with ${CUSTOMS_PROMOTED_PLACEMENT_MAGIC}`, {
        code: 'ERR_CUSTOMS_PROMOTED_VEGETATION_PLACEMENTS',
      });
    }
  }
  if (view.getUint32(8, true) !== CUSTOMS_PROMOTED_VEGETATION_SCHEMA_VERSION) {
    fail('the promoted placement table declares an unsupported schema version', {
      code: 'ERR_CUSTOMS_PROMOTED_VEGETATION_PLACEMENTS',
    });
  }
  const stride = view.getUint32(12, true);
  if (stride !== CUSTOMS_PROMOTED_PLACEMENT_STRIDE_BYTES) {
    fail(`the promoted placement table declares stride ${stride}, not ${CUSTOMS_PROMOTED_PLACEMENT_STRIDE_BYTES}`, {
      code: 'ERR_CUSTOMS_PROMOTED_VEGETATION_PLACEMENTS',
    });
  }
  const count = view.getUint32(16, true);
  if (count === 0 || count > CUSTOMS_PROMOTED_PLACEMENT_MAX_ROWS) {
    fail(`the promoted placement table declares ${count} rows`, {
      code: 'ERR_CUSTOMS_PROMOTED_VEGETATION_PLACEMENTS',
    });
  }
  if (expected !== null && count !== expected) {
    fail(`the promoted placement table holds ${count} rows; the manifest declares ${expected}`, {
      code: 'ERR_CUSTOMS_PROMOTED_VEGETATION_PLACEMENTS',
    });
  }
  const needed = CUSTOMS_PROMOTED_PLACEMENT_HEADER_BYTES + count * stride;
  if (bytes.byteLength !== needed) {
    fail(`the promoted placement table is ${bytes.byteLength} bytes; ${count} rows need ${needed}`, {
      code: 'ERR_CUSTOMS_PROMOTED_VEGETATION_PLACEMENTS',
    });
  }

  // One group per binding, in binding order, so `groupIndex` is stable and every placement has one.
  const groups = bindings.map((binding, groupIndex) => ({
    groupIndex,
    tileId: binding.tileId,
    prototypeId: binding.prototypeId,
    prototypeName: binding.prototypeName,
    classification: classify(binding.prototypeName),
    instanceIndexes: [],
  }));
  const instances = new Array(count);
  const tileOrder = [];
  const tileRows = new Map();

  for (let row = 0; row < count; row += 1) {
    const base = CUSTOMS_PROMOTED_PLACEMENT_HEADER_BYTES + row * stride;
    const bindingIndex = view.getUint16(base + 40, true);
    const binding = bindings[bindingIndex];
    if (!binding) {
      fail(`promoted placement ${row} names prototype binding ${bindingIndex}, which does not exist`, {
        code: 'ERR_CUSTOMS_PROMOTED_VEGETATION_PLACEMENTS',
      });
    }
    const group = groups[bindingIndex];
    const flags = view.getUint8(base + 42);
    const color = (flags & PLACEMENT_HAS_COLOR) === 0 ? null : Object.freeze({
      r: view.getUint8(base + 43) / 255,
      g: view.getUint8(base + 44) / 255,
      b: view.getUint8(base + 45) / 255,
      a: view.getUint8(base + 46) / 255,
    });
    const instance = Object.freeze({
      flatIndex: row,
      groupIndex: bindingIndex,
      tileId: binding.tileId,
      index: view.getUint32(base + 36, true),
      prototypeId: binding.prototypeId,
      prototypeName: binding.prototypeName,
      classification: group.classification,
      worldPosition: Object.freeze({
        x: view.getFloat64(base + 0, true),
        y: view.getFloat64(base + 8, true),
        z: view.getFloat64(base + 16, true),
      }),
      widthScale: view.getFloat32(base + 28, true),
      heightScale: view.getFloat32(base + 32, true),
      rotationRadians: view.getFloat32(base + 24, true),
      color,
      lightmapColor: null,
    });
    instances[row] = instance;
    group.instanceIndexes.push(row);
    if (!tileRows.has(binding.tileId)) {
      tileRows.set(binding.tileId, []);
      tileOrder.push(binding.tileId);
    }
    tileRows.get(binding.tileId).push(row);
  }

  return Object.freeze({
    schemaVersion: CUSTOMS_PROMOTED_VEGETATION_SCHEMA_VERSION,
    map: 'customs',
    // The mirror image of the local package's `localOnly: true`. A consumer that requires one
    // cannot be handed the other.
    localOnly: false,
    distribution: CUSTOMS_PROMOTED_VEGETATION_DISTRIBUTION,
    sourceFrame: CUSTOMS_PROMOTED_VEGETATION_SOURCE_FRAME,
    count,
    prototypes: Object.freeze(groups.map((group) => Object.freeze({
      tileId: group.tileId,
      id: group.prototypeId,
      name: group.prototypeName,
      classification: group.classification,
    }))),
    instances: Object.freeze(instances),
    groups: Object.freeze(groups.map((group) => Object.freeze({
      groupIndex: group.groupIndex,
      tileId: group.tileId,
      prototypeId: group.prototypeId,
      prototypeName: group.prototypeName,
      classification: group.classification,
      instanceIndexes: Object.freeze(group.instanceIndexes),
    }))),
    tiles: Object.freeze(tileOrder.map((tileId) => Object.freeze({
      tileId,
      instanceIndexes: Object.freeze(tileRows.get(tileId)),
    }))),
  });
}
