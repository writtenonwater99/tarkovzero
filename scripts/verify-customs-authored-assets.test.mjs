import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { emptyCustomsAssetManifest } from '../src/customs-asset-manifest.js';
import {
  CustomsAuthoredAssetVerificationError,
  assertCustomsAuthoredGltfSelfContained,
  countCustomsAuthoredGltfTriangles,
  customsAuthoredSha256,
  parseCustomsAuthoredGlb,
  verifyCustomsAuthoredAssets,
} from './verify-customs-authored-assets.mjs';

const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

function pad4(bytes, fill) {
  const padding = (4 - (bytes.length % 4)) % 4;
  return padding === 0 ? bytes : Buffer.concat([bytes, Buffer.alloc(padding, fill)]);
}

function makeGlb(json, { bin = Buffer.alloc(64), firstChunkType = JSON_CHUNK } = {}) {
  const jsonBytes = pad4(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const binBytes = bin === null ? null : pad4(Buffer.from(bin), 0);
  const length = 12 + 8 + jsonBytes.length + (binBytes === null ? 0 : 8 + binBytes.length);
  const glb = Buffer.alloc(length);
  glb.writeUInt32LE(0x46546c67, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(length, 8);
  glb.writeUInt32LE(jsonBytes.length, 12);
  glb.writeUInt32LE(firstChunkType, 16);
  jsonBytes.copy(glb, 20);
  if (binBytes !== null) {
    const binHeader = 20 + jsonBytes.length;
    glb.writeUInt32LE(binBytes.length, binHeader);
    glb.writeUInt32LE(BIN_CHUNK, binHeader + 4);
    binBytes.copy(glb, binHeader + 8);
  }
  return glb;
}

function triangleDocument({ elementCount = 6, mode = 4, bufferUri, imageUri } = {}) {
  const buffer = { byteLength: 64 };
  if (bufferUri !== undefined) buffer.uri = bufferUri;
  const image = imageUri === undefined
    ? { bufferView: 2, mimeType: 'image/png' }
    : { uri: imageUri, mimeType: 'image/png' };
  return {
    asset: { version: '2.0', generator: 'adversarial test fixture' },
    buffers: [buffer],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 12 },
      { buffer: 0, byteOffset: 12, byteLength: 48 },
      { buffer: 0, byteOffset: 60, byteLength: 4 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5123, count: elementCount, type: 'SCALAR' },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
    ],
    images: [image],
    meshes: [{
      primitives: [{ attributes: { POSITION: 1 }, indices: 0, mode }],
    }],
    nodes: [{ mesh: 0 }, { mesh: 0 }],
    scenes: [{ nodes: [0, 1] }],
    scene: 0,
  };
}

function source() {
  return {
    id: 'original-authored-test',
    kind: 'authored',
    title: 'Original deterministic test asset',
    holder: 'TarkovZero',
    license: 'Project-local original work',
    licenseUrl: 'https://example.invalid/original-work',
    retrievedAt: '2026-08-31',
  };
}

function assetFor(receipt, index) {
  return {
    id: `fixture-${index}`,
    kind: 'prototype',
    name: `Fixture ${index}`,
    sourceId: 'original-authored-test',
    gltf: { unit: 'metre', upAxis: '+y', forwardAxis: '+z', pivot: 'base-center' },
    bounds: { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 2, z: 1 } },
    materialIds: [],
    masks: { floors: ['ground'], interior: false },
    proxies: {
      picking: { shape: 'none' },
      shadow: { mode: 'none' },
      collision: { shape: 'none' },
    },
    lods: [{
      level: 0,
      url: receipt.url,
      sha256: receipt.sha256,
      bytes: receipt.bytes,
      triangles: receipt.triangles,
      maxDistanceM: 250,
    }],
  };
}

function manifestFor(receipts, { baseUrl = 'assets/3d/customs/authored/' } = {}) {
  return {
    ...emptyCustomsAssetManifest(),
    evidence: { sources: receipts.length === 0 ? [] : [source()], observations: [] },
    delivery: {
      baseUrl,
      materials: [],
      assets: receipts.map(assetFor),
      instances: [],
      cells: [],
      replacements: [],
    },
  };
}

function receipt(url, bytes, triangles = 2) {
  return {
    url,
    bytes: bytes.byteLength,
    sha256: customsAuthoredSha256(bytes),
    triangles,
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'tarkovzero-authored-receipts-'));
  const authoredRoot = join(root, 'authored');
  const manifestPath = join(root, 'scene-manifest.json');
  await mkdir(authoredRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, authoredRoot, manifestPath };
}

async function writeManifest(manifestPath, manifest) {
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function throwsCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error?.code, code, error?.stack);
    return true;
  });
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code, error?.stack);
    return true;
  });
}

test('parses a strict GLB v2 container and counts mesh payload triangles once', () => {
  const bytes = makeGlb(triangleDocument());
  const parsed = parseCustomsAuthoredGlb(bytes);
  assert.equal(parsed.version, 2);
  assert.equal(parsed.declaredLength, bytes.length);
  assert.equal(parsed.chunkCount, 2);
  assert.equal(parsed.bin.byteLength, 64);

  const embedded = assertCustomsAuthoredGltfSelfContained(parsed.json, { bin: parsed.bin });
  assert.deepEqual(embedded, { buffers: 1, bufferViews: 3, images: 1, binBytes: 64 });
  // Two nodes instance the same mesh, but a physical-file receipt counts its primitive once.
  assert.equal(countCustomsAuthoredGltfTriangles(parsed.json), 2);
});

test('counts TRIANGLES, TRIANGLE_STRIP, and TRIANGLE_FAN accessor topology exactly', () => {
  const gltf = {
    accessors: [
      { count: 6, type: 'SCALAR', componentType: 5123 },
      { count: 5, type: 'SCALAR', componentType: 5125 },
      { count: 4, type: 'VEC3', componentType: 5126 },
      { count: 8, type: 'SCALAR', componentType: 5121 },
    ],
    meshes: [{ primitives: [
      { attributes: { POSITION: 2 }, indices: 0 },
      { attributes: { POSITION: 2 }, indices: 1, mode: 5 },
      { attributes: { POSITION: 2 }, mode: 6 },
      { attributes: { POSITION: 2 }, indices: 3, mode: 1 },
    ] }],
  };
  assert.equal(countCustomsAuthoredGltfTriangles(gltf), 2 + 3 + 2);
});

test('rejects malformed GLB magic, version, declared length, alignment, and first chunk', () => {
  const valid = makeGlb(triangleDocument());
  const cases = [
    ['ERR_CUSTOMS_AUTHORED_GLB_HEADER', 0, 0],
    ['ERR_CUSTOMS_AUTHORED_GLB_HEADER', 4, 1],
    ['ERR_CUSTOMS_AUTHORED_GLB_LENGTH', 8, valid.length - 4],
    ['ERR_CUSTOMS_AUTHORED_GLB_CHUNK', 12, valid.readUInt32LE(12) - 1],
    ['ERR_CUSTOMS_AUTHORED_GLB_CHUNK', 16, BIN_CHUNK],
  ];
  for (const [code, offset, replacement] of cases) {
    const corrupted = Buffer.from(valid);
    corrupted.writeUInt32LE(replacement, offset);
    throwsCode(() => parseCustomsAuthoredGlb(corrupted), code);
  }
});

test('rejects invalid UTF-8 and syntactically invalid JSON in the first chunk', () => {
  const invalidUtf8 = makeGlb(triangleDocument());
  invalidUtf8[20] = 0xff;
  throwsCode(() => parseCustomsAuthoredGlb(invalidUtf8), 'ERR_CUSTOMS_AUTHORED_GLB_JSON');

  const invalidJson = makeGlb({ valid: true });
  invalidJson[20] = 0x5b;
  throwsCode(() => parseCustomsAuthoredGlb(invalidJson), 'ERR_CUSTOMS_AUTHORED_GLB_JSON');
});

test('rejects external, data, and remote buffer or image URIs', () => {
  const cases = [
    triangleDocument({ bufferUri: 'buffer.bin' }),
    triangleDocument({ bufferUri: 'data:application/octet-stream;base64,AAAA' }),
    triangleDocument({ bufferUri: 'https://example.invalid/buffer.bin' }),
    triangleDocument({ imageUri: 'texture.png' }),
    triangleDocument({ imageUri: 'data:image/png;base64,AAAA' }),
    triangleDocument({ imageUri: 'https://example.invalid/texture.png' }),
  ];
  for (const gltf of cases) {
    throwsCode(
      () => assertCustomsAuthoredGltfSelfContained(gltf, { bin: Buffer.alloc(64) }),
      'ERR_CUSTOMS_AUTHORED_EXTERNAL_URI',
    );
  }
});

test('rejects missing image embedding, mismatched BIN storage, and unsafe buffer views', () => {
  const missingImageView = triangleDocument();
  delete missingImageView.images[0].bufferView;
  throwsCode(
    () => assertCustomsAuthoredGltfSelfContained(missingImageView, { bin: Buffer.alloc(64) }),
    'ERR_CUSTOMS_AUTHORED_GLTF_SCHEMA',
  );

  throwsCode(
    () => assertCustomsAuthoredGltfSelfContained(triangleDocument(), { bin: Buffer.alloc(59) }),
    'ERR_CUSTOMS_AUTHORED_GLB_BUFFER',
  );

  const escapingView = triangleDocument();
  escapingView.bufferViews[2].byteLength = 5;
  throwsCode(
    () => assertCustomsAuthoredGltfSelfContained(escapingView, { bin: Buffer.alloc(64) }),
    'ERR_CUSTOMS_AUTHORED_GLB_BUFFER',
  );
});

test('rejects malformed triangle accessors instead of guessing a receipt', () => {
  const indivisible = triangleDocument({ elementCount: 5 });
  throwsCode(() => countCustomsAuthoredGltfTriangles(indivisible), 'ERR_CUSTOMS_AUTHORED_GLTF_TRIANGLES');

  const missing = triangleDocument();
  missing.meshes[0].primitives[0].indices = 99;
  throwsCode(() => countCustomsAuthoredGltfTriangles(missing), 'ERR_CUSTOMS_AUTHORED_GLTF_ACCESSOR');

  const signed = triangleDocument();
  signed.accessors[0].componentType = 5122;
  throwsCode(() => countCustomsAuthoredGltfTriangles(signed), 'ERR_CUSTOMS_AUTHORED_GLTF_ACCESSOR');

  const noPosition = triangleDocument();
  delete noPosition.meshes[0].primitives[0].attributes.POSITION;
  throwsCode(() => countCustomsAuthoredGltfTriangles(noPosition), 'ERR_CUSTOMS_AUTHORED_GLTF_SCHEMA');
});

test('empty manifest passes with zero and never touches a missing authored root', async () => {
  let rootCalls = 0;
  const io = {
    readFile: async () => Buffer.from(JSON.stringify(manifestFor([]))),
    realpath: async () => { rootCalls += 1; throw new Error('must not run'); },
    stat: async () => { rootCalls += 1; throw new Error('must not run'); },
  };
  const result = await verifyCustomsAuthoredAssets({
    manifestPath: '/injected/scene-manifest.json',
    authoredRoot: '/injected/missing-authored',
    io,
  });
  assert.equal(result.filesVerified, 0);
  assert.equal(result.totalBytes, 0);
  assert.equal(result.totalTriangles, 0);
  assert.equal(rootCalls, 0);
});

test('verifies live-delivery byte, hash, GLB, embedding, and triangle receipts', async (t) => {
  const { authoredRoot, manifestPath } = await fixture(t);
  const bytes = makeGlb(triangleDocument());
  await writeFile(join(authoredRoot, 'valid.glb'), bytes);
  await writeManifest(manifestPath, manifestFor([receipt('valid.glb', bytes)]));

  const result = await verifyCustomsAuthoredAssets({ manifestPath, authoredRoot });
  assert.equal(result.filesVerified, 1);
  assert.equal(result.totalBytes, bytes.length);
  assert.equal(result.totalTriangles, 2);
  assert.deepEqual(result.receipts[0], {
    assetId: 'fixture-0',
    lodLevel: 0,
    url: 'valid.glb',
    bytes: bytes.length,
    sha256: customsAuthoredSha256(bytes),
    triangles: 2,
    jsonBytes: parseCustomsAuthoredGlb(bytes).jsonByteLength,
    binBytes: 64,
    images: 1,
  });
});

test('rejects wrong byte, hash, and triangle receipts independently', async (t) => {
  const bytes = makeGlb(triangleDocument());

  for (const [label, mutate, code] of [
    ['bytes', (value) => { value.bytes += 1; }, 'ERR_CUSTOMS_AUTHORED_BYTE_RECEIPT'],
    ['hash', (value) => { value.sha256 = `sha256:${'0'.repeat(64)}`; }, 'ERR_CUSTOMS_AUTHORED_HASH_RECEIPT'],
    ['triangles', (value) => { value.triangles += 1; }, 'ERR_CUSTOMS_AUTHORED_TRIANGLE_RECEIPT'],
  ]) {
    const { authoredRoot, manifestPath } = await fixture(t);
    await writeFile(join(authoredRoot, `${label}.glb`), bytes);
    const declared = receipt(`${label}.glb`, bytes);
    mutate(declared);
    await writeManifest(manifestPath, manifestFor([declared]));
    await rejectsCode(verifyCustomsAuthoredAssets({ manifestPath, authoredRoot }), code);
  }
});

test('rejects manifest traversal before touching the filesystem', async () => {
  const bytes = makeGlb(triangleDocument());
  const manifest = manifestFor([receipt('../escape.glb', bytes)]);
  await rejectsCode(
    verifyCustomsAuthoredAssets({
      manifestPath: '/injected/scene-manifest.json',
      authoredRoot: '/injected/authored',
      io: {
        readFile: async () => Buffer.from(JSON.stringify(manifest)),
        realpath: async () => { throw new Error('must not run'); },
        stat: async () => { throw new Error('must not run'); },
      },
    }),
    'ERR_ASSET_MANIFEST_UNSAFE_URL',
  );
});

test('rejects an authored symlink that escapes the canonical root', async (t) => {
  const { root, authoredRoot, manifestPath } = await fixture(t);
  const bytes = makeGlb(triangleDocument());
  const outside = join(root, 'outside.glb');
  await writeFile(outside, bytes);
  await symlink(outside, join(authoredRoot, 'escape.glb'));
  await writeManifest(manifestPath, manifestFor([receipt('escape.glb', bytes)]));

  await rejectsCode(
    verifyCustomsAuthoredAssets({ manifestPath, authoredRoot }),
    'ERR_CUSTOMS_AUTHORED_PATH_ESCAPE',
  );
});

test('rejects two URLs resolving to one file through an in-root symlink', async (t) => {
  const { authoredRoot, manifestPath } = await fixture(t);
  const bytes = makeGlb(triangleDocument());
  await writeFile(join(authoredRoot, 'original.glb'), bytes);
  await symlink('original.glb', join(authoredRoot, 'alias.glb'));
  await writeManifest(manifestPath, manifestFor([
    receipt('original.glb', bytes),
    receipt('alias.glb', bytes),
  ]));

  await rejectsCode(
    verifyCustomsAuthoredAssets({ manifestPath, authoredRoot }),
    'ERR_CUSTOMS_AUTHORED_DUPLICATE_FILE',
  );
});

test('rejects two URLs resolving to one inode through hard links', async (t) => {
  const { authoredRoot, manifestPath } = await fixture(t);
  const bytes = makeGlb(triangleDocument());
  const original = join(authoredRoot, 'original.glb');
  await writeFile(original, bytes);
  await link(original, join(authoredRoot, 'hardlink.glb'));
  await writeManifest(manifestPath, manifestFor([
    receipt('original.glb', bytes),
    receipt('hardlink.glb', bytes),
  ]));

  await rejectsCode(
    verifyCustomsAuthoredAssets({ manifestPath, authoredRoot }),
    'ERR_CUSTOMS_AUTHORED_DUPLICATE_FILE',
  );
});

test('binds verification to the runtime delivery base URL', async () => {
  const manifest = manifestFor([], { baseUrl: 'assets/3d/customs/not-authored/' });
  await rejectsCode(
    verifyCustomsAuthoredAssets({
      manifestPath: '/injected/scene-manifest.json',
      io: {
        readFile: async () => Buffer.from(JSON.stringify(manifest)),
        realpath: async () => { throw new Error('must not run'); },
        stat: async () => { throw new Error('must not run'); },
      },
    }),
    'ERR_CUSTOMS_AUTHORED_DELIVERY_ROOT',
  );
});

test('verification errors carry stable codes and receipt paths', async (t) => {
  const { authoredRoot, manifestPath } = await fixture(t);
  const bytes = makeGlb(triangleDocument());
  await writeFile(join(authoredRoot, 'wrong.glb'), bytes);
  const declared = receipt('wrong.glb', bytes);
  declared.bytes += 1;
  await writeManifest(manifestPath, manifestFor([declared]));

  await assert.rejects(
    verifyCustomsAuthoredAssets({ manifestPath, authoredRoot }),
    (error) => {
      assert.ok(error instanceof CustomsAuthoredAssetVerificationError);
      assert.equal(error.code, 'ERR_CUSTOMS_AUTHORED_BYTE_RECEIPT');
      assert.equal(error.path, 'manifest.delivery.assets[0].lods[0].bytes');
      assert.equal(error.expected, bytes.length + 1);
      assert.equal(error.actual, bytes.length);
      return true;
    },
  );
});
