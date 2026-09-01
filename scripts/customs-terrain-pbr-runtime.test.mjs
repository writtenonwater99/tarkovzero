import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import { texture, uv } from 'three/tsl';
import {
  CUSTOMS_TERRAIN_SEMANTIC_LAYERS,
} from '../src/customs-terrain-material-contract.js';
import {
  buildCustomsTerrainControlAtlases,
} from '../src/customs-terrain-control-atlas.js';
import {
  CUSTOMS_TERRAIN_PBR_FIXED_RELIEF,
  CUSTOMS_TERRAIN_PBR_MATERIAL_SET_URL,
  CUSTOMS_TERRAIN_PBR_SHADER_CONTRACT,
  createCustomsTerrainPbrRuntime,
  decodeCustomsTerrainControlWeights,
  loadCustomsTerrainPbrMaterialSet,
  loadVerifiedCustomsTerrainKtx2,
  normalizeCustomsTerrainControlWeights,
  resolveCustomsTerrainPbrUrl,
  validateCustomsTerrainPbrControlAtlasSet,
} from '../src/customs-terrain-pbr-runtime.js';

const ROOT = '/assets/3d/customs/terrain-authored/';
const BASE = 'http://127.0.0.1:4173/maps/customs';
const RECEIPT_HASHES = Object.freeze({
  provenance: 'e'.repeat(64),
  license: 'f'.repeat(64),
});

function bytesFor(role) {
  return new TextEncoder().encode(`deterministic-${role}-ktx2-fixture-v1`);
}

function digestBytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function receipts(label) {
  return {
    provenance: {
      url: `${ROOT}receipts/${label}-provenance.json`,
      sha256: RECEIPT_HASHES.provenance,
    },
    originalLicense: {
      url: `${ROOT}receipts/${label}-original-license.json`,
      sha256: RECEIPT_HASHES.license,
    },
  };
}

function arrayDescriptor(role) {
  const payload = bytesFor(role);
  const result = {
    kind: 'ktx2-array',
    role,
    url: `${ROOT}customs-terrain-${role}-array.ktx2`,
    width: 8,
    height: 8,
    slices: 12,
    mipLevels: 4,
    colorSpace: role === 'albedo' ? 'srgb' : 'linear',
    sha256: digestBytes(payload),
    receipts: receipts(role),
  };
  if (role === 'normal') result.normalSpace = 'tangent';
  if (role === 'orm') result.channels = ['occlusion', 'roughness', 'metallic', 'unused'];
  return result;
}

function materialSet() {
  const macroBytes = bytesFor('macro-albedo');
  return {
    schemaVersion: 1,
    map: 'customs',
    delivery: 'original-authored',
    layers: CUSTOMS_TERRAIN_SEMANTIC_LAYERS.map((layer) => ({
      ...layer,
      arrayIndex: layer.index,
      metresPerRepeat: 1.5 + (layer.index * 0.25),
      normalStrength: 0.75 + (layer.index * 0.05),
      ormStrength: 1,
    })),
    // The validator, not input array position, establishes binding order.
    arrays: [arrayDescriptor('orm'), arrayDescriptor('albedo'), arrayDescriptor('normal')],
    macro: {
      kind: 'ktx2-2d',
      role: 'macro-albedo',
      url: `${ROOT}customs-terrain-macro-albedo.ktx2`,
      width: 8,
      height: 8,
      mipLevels: 4,
      colorSpace: 'srgb',
      metresPerRepeat: 256,
      strength: 0.16,
      sha256: digestBytes(macroBytes),
      receipts: receipts('macro'),
    },
  };
}

function control(id, slot, values) {
  return {
    id: `${id}-control-${slot}`,
    slot,
    width: 2,
    height: 2,
    rgba: new Uint8Array([...values, ...values, ...values, ...values]),
  };
}

function controlAtlasSet() {
  return buildCustomsTerrainControlAtlases({
    // Deliberately reversed. Canonical EFT bounds, not array position, own placement.
    tiles: [
      {
        id: 'east',
        origin: { x: 10, z: 0 },
        bounds: { minX: 10, maxX: 20, minZ: 0, maxZ: 10 },
        controls: [
          control('east', 2, [90, 100, 110, 120]),
          control('east', 0, [10, 20, 30, 40]),
          control('east', 1, [50, 60, 70, 80]),
        ],
      },
      {
        id: 'west',
        origin: { x: 0, z: 0 },
        bounds: { minX: 0, maxX: 10, minZ: 0, maxZ: 10 },
        controls: [
          control('west', 1, [5, 6, 7, 8]),
          control('west', 2, [9, 10, 11, 12]),
          control('west', 0, [1, 2, 3, 4]),
        ],
      },
    ],
  });
}

function makeMipmaps(width, height, count) {
  return Array.from({ length: count }, (_, level) => ({
    width: Math.max(1, width >> level),
    height: Math.max(1, height >> level),
    data: new Uint8Array(16),
  }));
}

function fakeTexture(descriptor, { wrongWidth = false } = {}) {
  const width = wrongWidth ? descriptor.width / 2 : descriptor.width;
  const mipmaps = makeMipmaps(width, descriptor.height, descriptor.mipLevels);
  const value = descriptor.kind === 'ktx2-array'
    ? new THREE.CompressedArrayTexture(
      mipmaps,
      width,
      descriptor.height,
      descriptor.slices,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    )
    : new THREE.CompressedTexture(
      mipmaps,
      width,
      descriptor.height,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    );
  value.colorSpace = descriptor.colorSpace === 'srgb' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  value.userData.disposeCalls = 0;
  value.addEventListener('dispose', () => { value.userData.disposeCalls += 1; });
  return value;
}

function responseFor(payload, { contentLength = payload.byteLength, status = 200 } = {}) {
  let reads = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return name.toLowerCase() === 'content-length' && contentLength !== null
          ? String(contentLength)
          : null;
      },
    },
    async arrayBuffer() {
      reads += 1;
      return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
    },
    get reads() { return reads; },
  };
}

function runtimeHarness({ wrongRole = null } = {}) {
  const set = materialSet();
  const payloads = new Map(
    [...set.arrays, set.macro].map((descriptor) => [descriptor.url, bytesFor(descriptor.role)]),
  );
  const requests = [];
  const parsed = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    const payload = payloads.get(new URL(url).pathname);
    assert.ok(payload, `unexpected fixture URL ${url}`);
    return responseFor(payload);
  };
  const digestImpl = async (buffer) => digestBytes(new Uint8Array(buffer));
  const parseKtx2 = async (buffer, descriptor, url) => {
    assert.ok(buffer instanceof ArrayBuffer);
    assert.equal(new URL(url).pathname, descriptor.url);
    const value = fakeTexture(descriptor, { wrongWidth: descriptor.role === wrongRole });
    parsed.push(value);
    return value;
  };
  return { set, payloads, requests, parsed, fetchImpl, digestImpl, parseKtx2 };
}

test('resolves only literal same-origin authored paths', () => {
  assert.equal(
    resolveCustomsTerrainPbrUrl(`${ROOT}nested/albedo.ktx2`, BASE),
    'http://127.0.0.1:4173/assets/3d/customs/terrain-authored/nested/albedo.ktx2',
  );
  for (const value of [
    'https://evil.test/albedo.ktx2',
    '//evil.test/albedo.ktx2',
    `${ROOT}../private/albedo.ktx2`,
    `${ROOT}nested//albedo.ktx2`,
    `${ROOT}%2e%2e/albedo.ktx2`,
    `${ROOT}albedo.ktx2?raw=1`,
    `${ROOT}albedo.ktx2#fragment`,
    `${ROOT}albedo\\evil.ktx2`,
  ]) {
    assert.throws(
      () => resolveCustomsTerrainPbrUrl(value, BASE),
      { name: 'CustomsTerrainPbrRuntimeError', code: 'ERR_TERRAIN_PBR_UNSAFE_URL' },
      value,
    );
  }
  assert.throws(
    () => resolveCustomsTerrainPbrUrl(`${ROOT}albedo.ktx2`, 'file:///tmp/index.html'),
    /HTTP\(S\)/,
  );
});

test('the default live material-set URL validates and binds exact checked-in KTX2 hashes', async () => {
  assert.equal(
    CUSTOMS_TERRAIN_PBR_MATERIAL_SET_URL,
    '/assets/3d/customs/terrain-authored/material-set.json',
  );
  assert.equal(
    CUSTOMS_TERRAIN_PBR_SHADER_CONTRACT.materialSetUrl,
    CUSTOMS_TERRAIN_PBR_MATERIAL_SET_URL,
  );
  const source = await readFile(
    new URL('../public/assets/3d/customs/terrain-authored/material-set.json', import.meta.url),
    'utf8',
  );
  const sourceLength = new TextEncoder().encode(source).byteLength;
  const requested = [];
  const validated = await loadCustomsTerrainPbrMaterialSet({
    baseHref: BASE,
    fetchImpl: async (url, options) => {
      requested.push({ url, options });
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => name === 'content-length' ? String(sourceLength) : null },
        text: async () => source,
      };
    },
  });
  assert.equal(requested.length, 1);
  assert.equal(new URL(requested[0].url).pathname, CUSTOMS_TERRAIN_PBR_MATERIAL_SET_URL);
  assert.equal(requested[0].options.cache, 'no-store');
  assert.deepEqual(validated.arrays.map(({ role }) => role), ['albedo', 'normal', 'orm']);
  assert.equal(validated.layers.length, 12);

  for (const descriptor of [...validated.arrays, validated.macro]) {
    const artifact = await readFile(new URL(`../public${descriptor.url}`, import.meta.url));
    assert.equal(digestBytes(artifact), descriptor.sha256, descriptor.role);
  }
});

test('runtime fetches the canonical material set when no document is injected', async () => {
  const harness = runtimeHarness();
  const source = JSON.stringify(harness.set);
  const sourceLength = new TextEncoder().encode(source).byteLength;
  let materialSetRequests = 0;
  const runtime = await createCustomsTerrainPbrRuntime({
    controlAtlasSet: controlAtlasSet(),
    baseHref: BASE,
    fetchImpl: async (url, options) => {
      if (new URL(url).pathname === CUSTOMS_TERRAIN_PBR_MATERIAL_SET_URL) {
        materialSetRequests += 1;
        return {
          ok: true,
          status: 200,
          headers: { get: () => String(sourceLength) },
          text: async () => source,
        };
      }
      return harness.fetchImpl(url, options);
    },
    digestImpl: harness.digestImpl,
    parseKtx2: harness.parseKtx2,
  });
  assert.equal(materialSetRequests, 1);
  assert.equal(harness.requests.length, 4);
  runtime.dispose();
});

test('hashes received KTX2 bytes before invoking the decoder', async () => {
  const descriptor = arrayDescriptor('albedo');
  const payload = bytesFor('albedo');
  const response = responseFor(payload);
  let parsed = 0;
  const value = await loadVerifiedCustomsTerrainKtx2({
    descriptor,
    baseHref: BASE,
    fetchImpl: async (url, options) => {
      assert.equal(new URL(url).pathname, descriptor.url);
      assert.deepEqual(
        {
          method: options.method,
          mode: options.mode,
          credentials: options.credentials,
          cache: options.cache,
          redirect: options.redirect,
        },
        {
          method: 'GET',
          mode: 'same-origin',
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
        },
      );
      return response;
    },
    digestImpl: async (buffer) => digestBytes(new Uint8Array(buffer)),
    parse: async (buffer, receivedDescriptor) => {
      parsed += 1;
      assert.equal(receivedDescriptor, descriptor);
      return new Uint8Array(buffer)[0];
    },
  });
  assert.equal(value, payload[0]);
  assert.equal(response.reads, 1);
  assert.equal(parsed, 1);

  const bad = { ...descriptor, sha256: '0'.repeat(64) };
  parsed = 0;
  await assert.rejects(
    loadVerifiedCustomsTerrainKtx2({
      descriptor: bad,
      baseHref: BASE,
      fetchImpl: async () => responseFor(payload),
      digestImpl: async (buffer) => digestBytes(new Uint8Array(buffer)),
      parse: async () => { parsed += 1; },
    }),
    { code: 'ERR_TERRAIN_PBR_HASH' },
  );
  assert.equal(parsed, 0, 'unverified bytes must never reach KTX2Loader');
});

test('fails closed on HTTP, malformed lengths, byte mismatches, and size limits', async () => {
  const descriptor = arrayDescriptor('normal');
  const payload = bytesFor('normal');
  const common = {
    descriptor,
    baseHref: BASE,
    digestImpl: async (buffer) => digestBytes(new Uint8Array(buffer)),
    parse: async () => assert.fail('invalid bytes must not parse'),
  };
  await assert.rejects(
    loadVerifiedCustomsTerrainKtx2({ ...common, fetchImpl: async () => responseFor(payload, { status: 404 }) }),
    { code: 'ERR_TERRAIN_PBR_HTTP' },
  );
  await assert.rejects(
    loadVerifiedCustomsTerrainKtx2({
      ...common,
      fetchImpl: async () => responseFor(payload, { contentLength: payload.byteLength + 1 }),
    }),
    { code: 'ERR_TERRAIN_PBR_BYTES' },
  );
  const tooLarge = responseFor(payload, { contentLength: 33 });
  await assert.rejects(
    loadVerifiedCustomsTerrainKtx2({ ...common, fetchImpl: async () => tooLarge, maxBytes: 32 }),
    { code: 'ERR_TERRAIN_PBR_BYTES' },
  );
  assert.equal(tooLarge.reads, 0, 'known oversized responses must be rejected before buffering');
});

test('keeps the exact RGBA0, RGBA1, RGBA2 layer order and normalizes linearly', () => {
  const decoded = decodeCustomsTerrainControlWeights([
    { r: 0.01, g: 0.02, b: 0.03, a: 0.04 },
    [0.05, 0.06, 0.07, 0.08],
    { r: 0.09, g: 0.10, b: 0.11, a: 0.12 },
  ]);
  assert.deepEqual(decoded, [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.10, 0.11, 0.12]);
  const normalized = normalizeCustomsTerrainControlWeights(decoded);
  const total = decoded.reduce((sum, value) => sum + value, 0);
  decoded.forEach((value, index) => assert.equal(normalized[index], value / total));
  assert.ok(Math.abs(normalized.reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
  assert.deepEqual(
    normalizeCustomsTerrainControlWeights(Array(12).fill(0)),
    [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  );
  assert.deepEqual(
    normalizeCustomsTerrainControlWeights([1e-12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    'non-zero weights are normalized exactly rather than treated as an empty texel',
  );
  assert.equal(CUSTOMS_TERRAIN_PBR_SHADER_CONTRACT.zeroWeightFallbackLayer, 1);
  assert.deepEqual(
    CUSTOMS_TERRAIN_PBR_SHADER_CONTRACT.layerWeights,
    [
      [0, 'r'], [0, 'g'], [0, 'b'], [0, 'a'],
      [1, 'r'], [1, 'g'], [1, 'b'], [1, 'a'],
      [2, 'r'], [2, 'g'], [2, 'b'], [2, 'a'],
    ].map(([controlAtlasSlot, channel], layerIndex) => ({ layerIndex, controlAtlasSlot, channel })),
  );
});

test('validates control-atlas payloads, canonical slots, tile transforms, and bytes', () => {
  const atlas = controlAtlasSet();
  const validated = validateCustomsTerrainPbrControlAtlasSet(atlas);
  assert.equal(validated.width, 4);
  assert.equal(validated.height, 2);
  assert.deepEqual(validated.tiles.map(({ id, uv }) => ({ id, uv })), [
    { id: 'west', uv: { scale: { u: 0.5, v: 1 }, offset: { u: 0, v: 0 } } },
    { id: 'east', uv: { scale: { u: 0.5, v: 1 }, offset: { u: 0.5, v: 0 } } },
  ]);
  assert.deepEqual(validated.tiles.map(({ id, sampleUv }) => ({ id, sampleUv })), [
    { id: 'west', sampleUv: { scale: { u: 0.25, v: 0.5 }, offset: { u: 0.125, v: 0.25 } } },
    { id: 'east', sampleUv: { scale: { u: 0.25, v: 0.5 }, offset: { u: 0.625, v: 0.25 } } },
  ]);

  const badSlot = { ...atlas, atlases: atlas.atlases.map((entry) => ({ ...entry })) };
  badSlot.atlases[0].slot = 1;
  assert.throws(() => validateCustomsTerrainPbrControlAtlasSet(badSlot), /canonical slot 0/);

  const badBytes = { ...atlas, atlases: atlas.atlases.map((entry) => ({ ...entry })) };
  badBytes.atlases[2].bytes = new Uint8Array(3);
  assert.throws(() => validateCustomsTerrainPbrControlAtlasSet(badBytes), /exactly 32 Uint8 bytes/);

  const badPixelRect = {
    ...atlas,
    tiles: atlas.tiles.map((entry) => ({ ...entry, pixelRect: { ...entry.pixelRect } })),
  };
  badPixelRect.tiles[0].pixelRect.width = 3;
  assert.throws(
    () => validateCustomsTerrainPbrControlAtlasSet(badPixelRect),
    /pixel rectangle exactly/,
  );
});

test('constructs the real Three r185 TSL 12-layer material graph without a GPU', async () => {
  const harness = runtimeHarness();
  const runtime = await createCustomsTerrainPbrRuntime({
    materialSet: harness.set,
    controlAtlasSet: controlAtlasSet(),
    baseHref: BASE,
    fetchImpl: harness.fetchImpl,
    digestImpl: harness.digestImpl,
    parseKtx2: harness.parseKtx2,
    anisotropy: 4,
  });

  assert.equal(THREE.REVISION, '185');
  assert.equal(typeof THREE.MeshStandardNodeMaterial, 'function');
  assert.equal(typeof texture(runtime.textures.albedo, uv()).depth, 'function');
  assert.deepEqual(runtime.materialSet.arrays.map(({ role }) => role), ['albedo', 'normal', 'orm']);
  assert.equal(runtime.fixedRelief, CUSTOMS_TERRAIN_PBR_FIXED_RELIEF);
  assert.equal(runtime.fixedRelief, 2);
  assert.equal(runtime.fog, false);
  assert.equal(harness.requests.length, 4);
  assert.ok(harness.requests.every(({ options }) => options.cache === 'no-store'));

  for (const [role, value] of Object.entries(runtime.textures)) {
    assert.equal(value.wrapS, THREE.RepeatWrapping, role);
    assert.equal(value.wrapT, THREE.RepeatWrapping, role);
    assert.equal(value.anisotropy, 4, role);
    assert.equal(value.generateMipmaps, false, role);
    assert.equal(
      value.colorSpace,
      ['albedo', 'macro'].includes(role) ? THREE.SRGBColorSpace : THREE.NoColorSpace,
      role,
    );
  }
  for (const [index, value] of runtime.controlTextures.entries()) {
    assert.equal(value.isDataTexture, true);
    assert.equal(value.name, `customs-terrain-control-${index}`);
    assert.equal(value.colorSpace, THREE.NoColorSpace);
    assert.equal(value.flipY, false);
    assert.equal(value.generateMipmaps, false);
  }

  const material = runtime.createTileMaterial('east');
  assert.equal(material.isMeshStandardNodeMaterial, true);
  assert.equal(material.fog, false);
  assert.equal(material.positionNode, null);
  assert.equal(material.displacementMap, null);
  assert.ok(material.colorNode?.isNode);
  assert.ok(material.normalNode?.isNode);
  assert.ok(material.aoNode?.isNode);
  assert.ok(material.roughnessNode?.isNode);
  assert.ok(material.metalnessNode?.isNode);
  assert.deepEqual(material.userData.customsTerrainPbr.controlUv, {
    scale: { u: 0.25, v: 0.5 },
    offset: { u: 0.625, v: 0.25 },
  });
  assert.deepEqual(material.userData.customsTerrainPbr.controlPixelRectUv, {
    scale: { u: 0.5, v: 1 },
    offset: { u: 0.5, v: 0 },
  });
  assert.deepEqual(material.userData.customsTerrainPbr.controlPixelRect, {
    x: 2, y: 0, width: 2, height: 2,
  });
  assert.deepEqual(
    material.userData.customsTerrainPbr.semanticLayerOrder,
    CUSTOMS_TERRAIN_SEMANTIC_LAYERS.map(({ semantic }) => semantic),
  );
  assert.equal(material.userData.customsTerrainPbr.fixedRelief, 2);
  assert.equal(material.userData.customsTerrainPbr.fog, false);
  assert.equal(material.userData.customsTerrainPbr.geometryDisplacement, false);

  const graphNodes = new Set();
  for (const node of [
    material.colorNode,
    material.normalNode,
    material.aoNode,
    material.roughnessNode,
    material.metalnessNode,
  ]) {
    node.traverse((entry) => graphNodes.add(entry));
  }
  const textureNodes = [...graphNodes].filter(({ isTextureNode }) => isTextureNode);
  const textureValues = new Set(textureNodes.map(({ value }) => value));
  assert.deepEqual(
    textureValues,
    new Set([...Object.values(runtime.textures), ...runtime.controlTextures]),
    'the shader graph must bind exactly three material arrays, one macro, and three controls',
  );
  for (const role of ['albedo', 'normal', 'orm']) {
    const value = runtime.textures[role];
    const layers = new Set(
      textureNodes
        .filter((node) => node.value === value && node.depthNode !== null)
        .map((node) => node.depthNode.value),
    );
    assert.deepEqual(layers, new Set(Array.from({ length: 12 }, (_, index) => index)), role);
  }

  assert.throws(() => runtime.createTileMaterial('missing'), { code: 'ERR_TERRAIN_PBR_TILE' });
  runtime.dispose();
});

test('disposes every owned texture and created material exactly once', async () => {
  const harness = runtimeHarness();
  const runtime = await createCustomsTerrainPbrRuntime({
    materialSet: harness.set,
    controlAtlasSet: controlAtlasSet(),
    baseHref: BASE,
    fetchImpl: harness.fetchImpl,
    digestImpl: harness.digestImpl,
    parseKtx2: harness.parseKtx2,
  });
  const controlDisposeCalls = runtime.controlTextures.map(() => 0);
  runtime.controlTextures.forEach((value, index) => {
    value.addEventListener('dispose', () => { controlDisposeCalls[index] += 1; });
  });
  const material = runtime.createTileMaterial('west');
  let materialDisposeCalls = 0;
  material.addEventListener('dispose', () => { materialDisposeCalls += 1; });

  runtime.dispose();
  runtime.dispose();
  assert.equal(runtime.disposed, true);
  assert.equal(materialDisposeCalls, 1);
  assert.deepEqual(controlDisposeCalls, [1, 1, 1]);
  assert.ok(harness.parsed.every((value) => value.userData.disposeCalls === 1));
  assert.throws(() => runtime.createTileMaterial('west'), { code: 'ERR_TERRAIN_PBR_DISPOSED' });
});

test('cleans all fulfilled textures if any decoded texture violates its descriptor', async () => {
  const harness = runtimeHarness({ wrongRole: 'albedo' });
  await assert.rejects(
    createCustomsTerrainPbrRuntime({
      materialSet: harness.set,
      controlAtlasSet: controlAtlasSet(),
      baseHref: BASE,
      fetchImpl: harness.fetchImpl,
      digestImpl: harness.digestImpl,
      parseKtx2: harness.parseKtx2,
    }),
    { code: 'ERR_TERRAIN_PBR_TEXTURE' },
  );
  assert.equal(harness.parsed.length, 4);
  assert.ok(harness.parsed.every((value) => value.userData.disposeCalls === 1));
});

test('validates material and atlas contracts before opening any request', async () => {
  const harness = runtimeHarness();
  const invalidMaterial = materialSet();
  invalidMaterial.layers.pop();
  await assert.rejects(
    createCustomsTerrainPbrRuntime({
      materialSet: invalidMaterial,
      controlAtlasSet: controlAtlasSet(),
      baseHref: BASE,
      fetchImpl: harness.fetchImpl,
      digestImpl: harness.digestImpl,
      parseKtx2: harness.parseKtx2,
    }),
    /exactly 12 semantic layers/,
  );
  assert.equal(harness.requests.length, 0);

  const invalidAtlas = { ...controlAtlasSet(), format: 'rgba16f' };
  await assert.rejects(
    createCustomsTerrainPbrRuntime({
      materialSet: harness.set,
      controlAtlasSet: invalidAtlas,
      baseHref: BASE,
      fetchImpl: harness.fetchImpl,
      digestImpl: harness.digestImpl,
      parseKtx2: harness.parseKtx2,
    }),
    /rgba8-unorm/,
  );
  assert.equal(harness.requests.length, 0);
});
