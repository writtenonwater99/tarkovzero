#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { normalizeCustomsAssetManifest } from '../src/customs-asset-manifest.js';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));

export const CUSTOMS_AUTHORED_MANIFEST_PATH = resolve(
  SCRIPT_DIRECTORY,
  '../public/assets/3d/customs/scene-manifest.json',
);
export const CUSTOMS_AUTHORED_ROOT = resolve(
  SCRIPT_DIRECTORY,
  '../public/assets/3d/customs/authored',
);
export const CUSTOMS_AUTHORED_DELIVERY_BASE_URL = 'assets/3d/customs/authored/';

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_BIN_CHUNK = 0x004e4942;
const GLB_HEADER_BYTES = 12;
const GLB_CHUNK_HEADER_BYTES = 8;
const MAX_SAFE_TRIANGLES = Number.MAX_SAFE_INTEGER;

const DEFAULT_IO = Object.freeze({ readFile, realpath, stat });

export class CustomsAuthoredAssetVerificationError extends Error {
  constructor(code, path, message, details = {}) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'CustomsAuthoredAssetVerificationError';
    this.code = code;
    this.path = path;
    Object.assign(this, details);
  }
}

function fail(code, path, message, details) {
  throw new CustomsAuthoredAssetVerificationError(code, path, message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function byteView(value, path = 'bytes') {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  fail('ERR_CUSTOMS_AUTHORED_BYTES', path, 'must be an ArrayBuffer or typed byte view');
}

function safeInteger(value, path, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(
      'ERR_CUSTOMS_AUTHORED_GLTF_SCHEMA',
      path,
      `must be a safe integer greater than or equal to ${minimum}`,
    );
  }
  return value;
}

function objectArray(value, path) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail('ERR_CUSTOMS_AUTHORED_GLTF_SCHEMA', path, 'must be an array');
  }
  value.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      fail('ERR_CUSTOMS_AUTHORED_GLTF_SCHEMA', `${path}[${index}]`, 'must be an object');
    }
  });
  return value;
}

/** Return a manifest-formatted SHA-256 receipt for exactly these bytes. */
export function customsAuthoredSha256(value) {
  return `sha256:${createHash('sha256').update(byteView(value)).digest('hex')}`;
}

/**
 * Parse the binary container, not merely its JSON payload. The authored lane intentionally
 * accepts the portable GLB v2 shape only: one JSON chunk followed by at most one BIN chunk.
 */
export function parseCustomsAuthoredGlb(value, { path = 'glb' } = {}) {
  const bytes = byteView(value, path);
  if (bytes.byteLength < GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES) {
    fail('ERR_CUSTOMS_AUTHORED_GLB_HEADER', path, 'is too short to contain a GLB header and JSON chunk');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== GLB_MAGIC) {
    fail('ERR_CUSTOMS_AUTHORED_GLB_HEADER', path, 'has invalid GLB magic');
  }
  const version = view.getUint32(4, true);
  if (version !== GLB_VERSION) {
    fail('ERR_CUSTOMS_AUTHORED_GLB_HEADER', path, `must use GLB version ${GLB_VERSION}`);
  }
  const declaredLength = view.getUint32(8, true);
  if (declaredLength !== bytes.byteLength) {
    fail(
      'ERR_CUSTOMS_AUTHORED_GLB_LENGTH',
      path,
      `header declares ${declaredLength} bytes but file contains ${bytes.byteLength}`,
      { expected: declaredLength, actual: bytes.byteLength },
    );
  }

  const chunks = [];
  let offset = GLB_HEADER_BYTES;
  while (offset < bytes.byteLength) {
    if (offset + GLB_CHUNK_HEADER_BYTES > bytes.byteLength) {
      fail('ERR_CUSTOMS_AUTHORED_GLB_CHUNK', path, `has a truncated chunk header at byte ${offset}`);
    }
    const byteLength = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    if (byteLength % 4 !== 0) {
      fail(
        'ERR_CUSTOMS_AUTHORED_GLB_CHUNK',
        path,
        `chunk ${chunks.length} length ${byteLength} is not four-byte aligned`,
      );
    }
    const dataOffset = offset + GLB_CHUNK_HEADER_BYTES;
    const end = dataOffset + byteLength;
    if (!Number.isSafeInteger(end) || end > bytes.byteLength) {
      fail('ERR_CUSTOMS_AUTHORED_GLB_CHUNK', path, `chunk ${chunks.length} extends past the file`);
    }
    chunks.push({
      type,
      byteLength,
      data: bytes.subarray(dataOffset, end),
    });
    offset = end;
  }

  if (chunks.length === 0 || chunks[0].type !== GLB_JSON_CHUNK) {
    fail('ERR_CUSTOMS_AUTHORED_GLB_CHUNK', path, 'first chunk must be JSON');
  }
  if (chunks.length > 2) {
    fail('ERR_CUSTOMS_AUTHORED_GLB_CHUNK', path, 'may contain only one JSON chunk and one optional BIN chunk');
  }
  if (chunks[1] && chunks[1].type !== GLB_BIN_CHUNK) {
    fail('ERR_CUSTOMS_AUTHORED_GLB_CHUNK', path, 'second chunk must be BIN when present');
  }

  let jsonText;
  try {
    jsonText = new TextDecoder('utf-8', { fatal: true }).decode(chunks[0].data);
  } catch {
    fail('ERR_CUSTOMS_AUTHORED_GLB_JSON', path, 'JSON chunk is not valid UTF-8');
  }

  let json;
  try {
    json = JSON.parse(jsonText);
  } catch {
    fail('ERR_CUSTOMS_AUTHORED_GLB_JSON', path, 'first chunk does not contain valid JSON');
  }
  if (!isPlainObject(json)) {
    fail('ERR_CUSTOMS_AUTHORED_GLB_JSON', path, 'JSON chunk root must be an object');
  }

  return Object.freeze({
    json,
    version,
    declaredLength,
    jsonByteLength: chunks[0].byteLength,
    bin: chunks[1]?.data ?? null,
    chunkCount: chunks.length,
  });
}

/** Refuse every URI-bearing buffer or image; GLB delivery must be one self-contained file. */
export function assertCustomsAuthoredGltfSelfContained(
  gltf,
  { bin = null, path = 'glb.json' } = {},
) {
  if (!isPlainObject(gltf)) {
    fail('ERR_CUSTOMS_AUTHORED_GLTF_SCHEMA', path, 'must be an object');
  }
  if (!isPlainObject(gltf.asset) || gltf.asset.version !== '2.0') {
    fail('ERR_CUSTOMS_AUTHORED_GLTF_SCHEMA', `${path}.asset.version`, 'must declare glTF 2.0');
  }

  const buffers = objectArray(gltf.buffers, `${path}.buffers`);
  if (buffers.length > 1) {
    fail('ERR_CUSTOMS_AUTHORED_GLB_BUFFER', `${path}.buffers`, 'GLB may contain at most one embedded buffer');
  }
  buffers.forEach((buffer, index) => {
    if (Object.prototype.hasOwnProperty.call(buffer, 'uri')) {
      fail(
        'ERR_CUSTOMS_AUTHORED_EXTERNAL_URI',
        `${path}.buffers[${index}].uri`,
        'buffer URIs are forbidden, including data and remote URIs',
      );
    }
    safeInteger(buffer.byteLength, `${path}.buffers[${index}].byteLength`);
  });

  const binBytes = bin === null ? null : byteView(bin, `${path}.bin`);
  if (buffers.length === 0 && binBytes !== null) {
    fail('ERR_CUSTOMS_AUTHORED_GLB_BUFFER', `${path}.buffers`, 'BIN chunk has no matching buffer declaration');
  }
  if (buffers.length === 1 && binBytes === null) {
    fail('ERR_CUSTOMS_AUTHORED_GLB_BUFFER', `${path}.buffers[0]`, 'embedded buffer declaration requires a BIN chunk');
  }
  if (buffers.length === 1) {
    const expected = buffers[0].byteLength;
    if (binBytes.byteLength < expected || binBytes.byteLength > expected + 3) {
      fail(
        'ERR_CUSTOMS_AUTHORED_GLB_BUFFER',
        `${path}.buffers[0].byteLength`,
        `declares ${expected} bytes but BIN chunk contains ${binBytes.byteLength}`,
      );
    }
    for (const paddingByte of binBytes.subarray(expected)) {
      if (paddingByte !== 0) {
        fail('ERR_CUSTOMS_AUTHORED_GLB_BUFFER', `${path}.bin`, 'BIN padding bytes must be zero');
      }
    }
  }

  const bufferViews = objectArray(gltf.bufferViews, `${path}.bufferViews`);
  bufferViews.forEach((bufferView, index) => {
    const entryPath = `${path}.bufferViews[${index}]`;
    const bufferIndex = safeInteger(bufferView.buffer, `${entryPath}.buffer`);
    if (bufferIndex >= buffers.length) {
      fail('ERR_CUSTOMS_AUTHORED_GLB_BUFFER', `${entryPath}.buffer`, `references missing buffer ${bufferIndex}`);
    }
    const byteOffset = bufferView.byteOffset === undefined
      ? 0
      : safeInteger(bufferView.byteOffset, `${entryPath}.byteOffset`);
    const byteLength = safeInteger(bufferView.byteLength, `${entryPath}.byteLength`, { minimum: 1 });
    const end = byteOffset + byteLength;
    if (!Number.isSafeInteger(end) || end > buffers[bufferIndex].byteLength) {
      fail('ERR_CUSTOMS_AUTHORED_GLB_BUFFER', entryPath, 'extends past its embedded buffer');
    }
  });

  const images = objectArray(gltf.images, `${path}.images`);
  images.forEach((image, index) => {
    const entryPath = `${path}.images[${index}]`;
    if (Object.prototype.hasOwnProperty.call(image, 'uri')) {
      fail(
        'ERR_CUSTOMS_AUTHORED_EXTERNAL_URI',
        `${entryPath}.uri`,
        'image URIs are forbidden, including data and remote URIs',
      );
    }
    const bufferView = safeInteger(image.bufferView, `${entryPath}.bufferView`);
    if (bufferView >= bufferViews.length) {
      fail('ERR_CUSTOMS_AUTHORED_GLB_IMAGE', `${entryPath}.bufferView`, `references missing bufferView ${bufferView}`);
    }
    if (typeof image.mimeType !== 'string' || !/^image\/[A-Za-z0-9.+-]+$/.test(image.mimeType)) {
      fail('ERR_CUSTOMS_AUTHORED_GLB_IMAGE', `${entryPath}.mimeType`, 'must be an embedded image MIME type');
    }
  });

  return Object.freeze({
    buffers: buffers.length,
    bufferViews: bufferViews.length,
    images: images.length,
    binBytes: binBytes?.byteLength ?? 0,
  });
}

function referencedAccessor(accessors, index, path) {
  const accessorIndex = safeInteger(index, path);
  if (accessorIndex >= accessors.length) {
    fail('ERR_CUSTOMS_AUTHORED_GLTF_ACCESSOR', path, `references missing accessor ${accessorIndex}`);
  }
  return {
    accessor: accessors[accessorIndex],
    accessorIndex,
    count: safeInteger(
      accessors[accessorIndex].count,
      `${path} -> accessors[${accessorIndex}].count`,
      { minimum: 1 },
    ),
  };
}

/**
 * Count geometry receipts once per declared mesh primitive. Node instancing deliberately does
 * not multiply the result: each LOD receipt describes the physical GLB payload, not a scene draw.
 */
export function countCustomsAuthoredGltfTriangles(gltf, { path = 'glb.json' } = {}) {
  if (!isPlainObject(gltf)) {
    fail('ERR_CUSTOMS_AUTHORED_GLTF_SCHEMA', path, 'must be an object');
  }
  const accessors = objectArray(gltf.accessors, `${path}.accessors`);
  const meshes = objectArray(gltf.meshes, `${path}.meshes`);
  let triangles = 0;

  meshes.forEach((mesh, meshIndex) => {
    const meshPath = `${path}.meshes[${meshIndex}]`;
    if (!Array.isArray(mesh.primitives) || mesh.primitives.length === 0) {
      fail('ERR_CUSTOMS_AUTHORED_GLTF_SCHEMA', `${meshPath}.primitives`, 'must be a non-empty array');
    }
    mesh.primitives.forEach((primitive, primitiveIndex) => {
      const primitivePath = `${meshPath}.primitives[${primitiveIndex}]`;
      if (!isPlainObject(primitive)) {
        fail('ERR_CUSTOMS_AUTHORED_GLTF_SCHEMA', primitivePath, 'must be an object');
      }
      if (!isPlainObject(primitive.attributes)) {
        fail('ERR_CUSTOMS_AUTHORED_GLTF_SCHEMA', `${primitivePath}.attributes`, 'must be an object');
      }

      const mode = primitive.mode === undefined
        ? 4
        : safeInteger(primitive.mode, `${primitivePath}.mode`);
      if (mode > 6) {
        fail('ERR_CUSTOMS_AUTHORED_GLTF_SCHEMA', `${primitivePath}.mode`, 'must be a glTF primitive mode from 0 through 6');
      }

      const position = referencedAccessor(
        accessors,
        primitive.attributes.POSITION,
        `${primitivePath}.attributes.POSITION`,
      );
      if (position.accessor.type !== 'VEC3') {
        fail(
          'ERR_CUSTOMS_AUTHORED_GLTF_ACCESSOR',
          `${primitivePath}.attributes.POSITION`,
          'must reference a VEC3 accessor',
        );
      }

      let elementCount;
      if (primitive.indices !== undefined) {
        const reference = referencedAccessor(accessors, primitive.indices, `${primitivePath}.indices`);
        if (reference.accessor.type !== 'SCALAR' || ![5121, 5123, 5125].includes(reference.accessor.componentType)) {
          fail(
            'ERR_CUSTOMS_AUTHORED_GLTF_ACCESSOR',
            `${primitivePath}.indices`,
            'must reference an unsigned SCALAR accessor',
          );
        }
        elementCount = reference.count;
      } else {
        elementCount = position.count;
      }

      let primitiveTriangles = 0;
      if (mode === 4) {
        if (elementCount % 3 !== 0) {
          fail(
            'ERR_CUSTOMS_AUTHORED_GLTF_TRIANGLES',
            primitivePath,
            `TRIANGLES element count ${elementCount} is not divisible by three`,
          );
        }
        primitiveTriangles = elementCount / 3;
      } else if (mode === 5 || mode === 6) {
        if (elementCount < 3) {
          fail(
            'ERR_CUSTOMS_AUTHORED_GLTF_TRIANGLES',
            primitivePath,
            `${mode === 5 ? 'TRIANGLE_STRIP' : 'TRIANGLE_FAN'} needs at least three elements`,
          );
        }
        primitiveTriangles = elementCount - 2;
      }

      triangles += primitiveTriangles;
      if (!Number.isSafeInteger(triangles) || triangles > MAX_SAFE_TRIANGLES) {
        fail('ERR_CUSTOMS_AUTHORED_GLTF_TRIANGLES', path, 'triangle total exceeds the safe integer range');
      }
    });
  });

  return triangles;
}

/** Pure UTF-8/JSON/manifest normalization gate shared by the CLI and injected tests. */
export function parseAndNormalizeCustomsAuthoredManifest(
  value,
  { normalizeManifest = normalizeCustomsAssetManifest, path = 'scene-manifest.json' } = {},
) {
  let text;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(byteView(value, path));
    } catch (error) {
      if (error instanceof CustomsAuthoredAssetVerificationError) throw error;
      fail('ERR_CUSTOMS_AUTHORED_MANIFEST_JSON', path, 'is not valid UTF-8');
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('ERR_CUSTOMS_AUTHORED_MANIFEST_JSON', path, 'does not contain valid JSON');
  }
  return normalizeManifest(parsed);
}

function isStrictDescendant(root, candidate) {
  const relation = relative(root, candidate);
  return relation !== '' && relation !== '..' && !relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && !isAbsolute(relation);
}

function filesystemIdentity(fileStat) {
  const { dev, ino } = fileStat;
  if ((typeof dev !== 'number' && typeof dev !== 'bigint') || (typeof ino !== 'number' && typeof ino !== 'bigint')) {
    return null;
  }
  if (Number(ino) === 0) return null;
  return `${String(dev)}:${String(ino)}`;
}

/**
 * Read the live scene manifest and prove every LOD receipt against its canonical on-disk GLB.
 * Filesystem methods and the normalizer are injectable so adversarial tests need no Blender,
 * network, or game installation.
 */
export async function verifyCustomsAuthoredAssets({
  manifestPath = CUSTOMS_AUTHORED_MANIFEST_PATH,
  authoredRoot = CUSTOMS_AUTHORED_ROOT,
  expectedBaseUrl = CUSTOMS_AUTHORED_DELIVERY_BASE_URL,
  io = DEFAULT_IO,
  normalizeManifest = normalizeCustomsAssetManifest,
} = {}) {
  if (!io || typeof io.readFile !== 'function' || typeof io.realpath !== 'function' || typeof io.stat !== 'function') {
    fail('ERR_CUSTOMS_AUTHORED_IO', 'io', 'must provide readFile, realpath, and stat functions');
  }

  const manifestBytes = await io.readFile(manifestPath);
  const manifest = parseAndNormalizeCustomsAuthoredManifest(manifestBytes, {
    normalizeManifest,
    path: String(manifestPath),
  });
  if (manifest.delivery.baseUrl !== expectedBaseUrl) {
    fail(
      'ERR_CUSTOMS_AUTHORED_DELIVERY_ROOT',
      'manifest.delivery.baseUrl',
      `must be ${expectedBaseUrl} so verified bytes are the bytes loaded at runtime`,
    );
  }

  const declaredLods = manifest.delivery.assets.flatMap((asset, assetIndex) => (
    asset.lods.map((lod, lodIndex) => ({ asset, assetIndex, lod, lodIndex }))
  ));
  if (declaredLods.length === 0) {
    return Object.freeze({
      manifest,
      filesVerified: 0,
      totalBytes: 0,
      totalTriangles: 0,
      receipts: Object.freeze([]),
    });
  }

  const lexicalRoot = resolve(String(authoredRoot));
  let canonicalRoot;
  try {
    canonicalRoot = resolve(await io.realpath(lexicalRoot));
  } catch {
    fail('ERR_CUSTOMS_AUTHORED_ROOT', String(authoredRoot), 'authored asset root does not exist');
  }
  const rootStat = await io.stat(canonicalRoot);
  if (typeof rootStat.isDirectory !== 'function' || !rootStat.isDirectory()) {
    fail('ERR_CUSTOMS_AUTHORED_ROOT', String(authoredRoot), 'authored asset root must be a directory');
  }

  const physicalPaths = new Map();
  const physicalIdentities = new Map();
  const receipts = [];
  let totalBytes = 0;
  let totalTriangles = 0;

  for (const { asset, assetIndex, lod, lodIndex } of declaredLods) {
    const receiptPath = `manifest.delivery.assets[${assetIndex}].lods[${lodIndex}]`;
    const lexicalFile = resolve(lexicalRoot, ...lod.url.split('/'));
    if (!isStrictDescendant(lexicalRoot, lexicalFile)) {
      fail('ERR_CUSTOMS_AUTHORED_PATH_ESCAPE', `${receiptPath}.url`, `${lod.url} escapes the authored root`);
    }

    let canonicalFile;
    try {
      canonicalFile = resolve(await io.realpath(lexicalFile));
    } catch {
      fail('ERR_CUSTOMS_AUTHORED_FILE', `${receiptPath}.url`, `${lod.url} does not resolve to a file`);
    }
    if (!isStrictDescendant(canonicalRoot, canonicalFile)) {
      fail(
        'ERR_CUSTOMS_AUTHORED_PATH_ESCAPE',
        `${receiptPath}.url`,
        `${lod.url} resolves outside the authored root`,
      );
    }

    const fileStat = await io.stat(canonicalFile);
    if (typeof fileStat.isFile !== 'function' || !fileStat.isFile()) {
      fail('ERR_CUSTOMS_AUTHORED_FILE', `${receiptPath}.url`, `${lod.url} must resolve to a regular file`);
    }
    const identity = filesystemIdentity(fileStat);
    const priorPath = physicalPaths.get(canonicalFile);
    const priorIdentity = identity === null ? null : physicalIdentities.get(identity);
    const prior = priorPath ?? priorIdentity;
    if (prior) {
      fail(
        'ERR_CUSTOMS_AUTHORED_DUPLICATE_FILE',
        `${receiptPath}.url`,
        `${lod.url} resolves to the same physical file as ${prior}`,
      );
    }
    physicalPaths.set(canonicalFile, lod.url);
    if (identity !== null) physicalIdentities.set(identity, lod.url);

    const bytes = byteView(await io.readFile(canonicalFile), canonicalFile);
    if (bytes.byteLength !== lod.bytes) {
      fail(
        'ERR_CUSTOMS_AUTHORED_BYTE_RECEIPT',
        `${receiptPath}.bytes`,
        `declares ${lod.bytes} bytes but ${lod.url} contains ${bytes.byteLength}`,
        { expected: lod.bytes, actual: bytes.byteLength },
      );
    }
    const sha256 = customsAuthoredSha256(bytes);
    if (sha256 !== lod.sha256) {
      fail(
        'ERR_CUSTOMS_AUTHORED_HASH_RECEIPT',
        `${receiptPath}.sha256`,
        `declares ${lod.sha256} but ${lod.url} hashes to ${sha256}`,
        { expected: lod.sha256, actual: sha256 },
      );
    }

    const parsedGlb = parseCustomsAuthoredGlb(bytes, { path: lod.url });
    const embedded = assertCustomsAuthoredGltfSelfContained(parsedGlb.json, {
      bin: parsedGlb.bin,
      path: `${lod.url}.json`,
    });
    const triangles = countCustomsAuthoredGltfTriangles(parsedGlb.json, {
      path: `${lod.url}.json`,
    });
    if (triangles !== lod.triangles) {
      fail(
        'ERR_CUSTOMS_AUTHORED_TRIANGLE_RECEIPT',
        `${receiptPath}.triangles`,
        `declares ${lod.triangles} triangles but ${lod.url} contains ${triangles}`,
        { expected: lod.triangles, actual: triangles },
      );
    }

    totalBytes += bytes.byteLength;
    totalTriangles += triangles;
    receipts.push(Object.freeze({
      assetId: asset.id,
      lodLevel: lod.level,
      url: lod.url,
      bytes: bytes.byteLength,
      sha256,
      triangles,
      jsonBytes: parsedGlb.jsonByteLength,
      binBytes: embedded.binBytes,
      images: embedded.images,
    }));
  }

  return Object.freeze({
    manifest,
    filesVerified: receipts.length,
    totalBytes,
    totalTriangles,
    receipts: Object.freeze(receipts),
  });
}

async function main() {
  const result = await verifyCustomsAuthoredAssets();
  process.stdout.write(
    `Customs authored assets verified: ${result.filesVerified} GLB(s), `
      + `${result.totalBytes} bytes, ${result.totalTriangles} triangles.\n`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
