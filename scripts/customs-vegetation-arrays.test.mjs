// Runtime contract for the vegetation texture arrays.
//
// Two halves. The first needs no local package and always runs: the index validator, the
// `vegLayer` attribute, and the merge precondition that makes one material per LOD tier possible.
// The second runs against the real artifact in `.local-candidates/vegetation-arraytex-v1/` and
// skips cleanly when it is absent, because that directory is git-ignored offline evidence.
//
// Builder-side assertions (determinism, pixel fidelity, the baked normalScale) live in
// `scripts/vegetation-asset-factory/test_texture_arrays.py`, next to the source images.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  createCustomsAuthoredVegetationRuntime,
  normalizeCustomsAuthoredVegetationCatalog,
} from '../src/customs-authored-vegetation.js';
import {
  CUSTOMS_VEGETATION_LAYER_ATTRIBUTE,
  CUSTOMS_VEGETATION_TEXTURE_ARRAY_CONTRACT,
  CUSTOMS_VEGETATION_TEXTURE_ARRAY_DOCUMENT_TYPE,
  CUSTOMS_VEGETATION_TEXTURE_ARRAY_SLOTS,
  CustomsVegetationTextureArrayError,
  applyCustomsVegetationLayerAttribute,
  applyCustomsVegetationLayerAttributes,
  createCustomsVegetationArrayTexture,
  customsVegetationLayerKey,
  loadCustomsVegetationTextureArrays,
  resolveCustomsVegetationLayer,
  sliceCustomsVegetationArrayLevel,
  stripCustomsVegetationGlbImages,
  validateCustomsVegetationTextureArrayIndex,
} from '../src/customs-vegetation-texture-arrays.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARRAY_ROOT = join(HERE, '..', '.local-candidates', 'vegetation-arraytex-v1');
const ARTIFACT_PRESENT = existsSync(join(ARRAY_ROOT, 'veg-layers.json'));
const SKIP_ARTIFACT = ARTIFACT_PRESENT
  ? false
  : 'vegetation-arraytex-v1 is not built locally';

// The measured shape of the real set. Pinned so a rebuild that changes it fails here.
const EXPECTED_ARRAYS = [
  { lod: 0, depth: 85, resolution: 128, mipLevels: 8, normalScaleBaked: 0.78 },
  { lod: 1, depth: 57, resolution: 64, mipLevels: 7, normalScaleBaked: 0.62 },
  { lod: 2, depth: 57, resolution: 32, mipLevels: 6, normalScaleBaked: 0.48 },
];
const EXPECTED_LAYERS = 199;
const EXPECTED_PRIMITIVES = 199;
const EXPECTED_TOTAL_BYTES = 26_950_884;
const EXPECTED_LEVEL0_BYTES = 20_213_760;

// ── synthetic fixture ────────────────────────────────────────────────────────────────────────
// Two LOD tiers' worth of shape at toy resolutions, so the validator's arithmetic is exercised
// without carrying megabytes. `arrays` must still cover all three LODs, which the contract requires.

function levelTable(resolution, depth, mipLevels) {
  const levels = [];
  let byteOffset = 0;
  for (let level = 0; level < mipLevels; level += 1) {
    const size = resolution >> level;
    const byteLength = depth * size * size * 4;
    levels.push({ byteLength, byteOffset, height: size, level, width: size });
    byteOffset += byteLength;
  }
  return { levels, total: byteOffset };
}

function fakeSha(seed) {
  return `sha256:${createHash('sha256').update(String(seed)).digest('hex')}`;
}

function syntheticIndex(overrides = {}) {
  const arrays = [
    { lod: 0, resolution: 4, depth: 2, mipLevels: 3 },
    { lod: 1, resolution: 2, depth: 1, mipLevels: 2 },
    { lod: 2, resolution: 2, depth: 1, mipLevels: 1 },
  ].map(({ lod, resolution, depth, mipLevels }) => {
    const { levels, total } = levelTable(resolution, depth, mipLevels);
    const blobs = {};
    for (const slot of CUSTOMS_VEGETATION_TEXTURE_ARRAY_SLOTS) {
      blobs[slot] = { bytes: total, file: `veg-l${lod}-${slot}.bin`, sha256: fakeSha(`${lod}${slot}`) };
    }
    return { blobs, depth, height: resolution, levels, lod, mipLevels, normalScaleBaked: 0.5, width: resolution };
  });

  const layers = [
    { assetId: 'a', lod: 0, layer: 0, materialName: 'bark', alphaMode: 'OPAQUE', alphaCutoff: null },
    { assetId: 'a', lod: 0, layer: 1, materialName: 'card', alphaMode: 'MASK', alphaCutoff: 0.485 },
    { assetId: 'a', lod: 1, layer: 0, materialName: 'bark_l1', alphaMode: 'OPAQUE', alphaCutoff: null },
    { assetId: 'a', lod: 2, layer: 0, materialName: 'bark_l2', alphaMode: 'OPAQUE', alphaCutoff: null },
  ];
  const primitives = layers.map((layer, index) => ({
    assetId: layer.assetId,
    layer: layer.layer,
    lod: layer.lod,
    materialIndex: index,
    materialName: layer.materialName,
    meshIndex: 0,
    primitiveIndex: index,
  }));

  return {
    arrays,
    documentType: CUSTOMS_VEGETATION_TEXTURE_ARRAY_DOCUMENT_TYPE,
    layerAttribute: { itemSize: 1, name: CUSTOMS_VEGETATION_LAYER_ATTRIBUTE, type: 'float32' },
    layers,
    map: 'customs',
    packIndexSha256: fakeSha('pack'),
    primitives,
    schemaVersion: 1,
    ...overrides,
  };
}

function rejects(mutate, fragment) {
  const document = syntheticIndex();
  mutate(document);
  assert.throws(
    () => validateCustomsVegetationTextureArrayIndex(document),
    (error) => {
      assert.ok(error instanceof CustomsVegetationTextureArrayError, `not a contract error: ${error}`);
      assert.match(error.message, fragment);
      return true;
    },
  );
}

function triangle(vertices = 3) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(vertices * 3), 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(vertices * 3), 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(vertices * 2), 2));
  return geometry;
}

// ── contract ─────────────────────────────────────────────────────────────────────────────────

test('the runtime contract records the measured three-0.185.1 mip behaviour', () => {
  assert.equal(CUSTOMS_VEGETATION_TEXTURE_ARRAY_CONTRACT.materialsPerLodTier, 1);
  assert.equal(CUSTOMS_VEGETATION_TEXTURE_ARRAY_CONTRACT.layerAttribute, 'vegLayer');
  assert.equal(CUSTOMS_VEGETATION_TEXTURE_ARRAY_CONTRACT.uploadsLevel, 0);
  assert.equal(CUSTOMS_VEGETATION_TEXTURE_ARRAY_CONTRACT.mipmapSource, 'renderer');
  assert.equal(CUSTOMS_VEGETATION_TEXTURE_ARRAY_CONTRACT.offlineMipsAssignable, false);
  assert.equal(CUSTOMS_VEGETATION_TEXTURE_ARRAY_CONTRACT.normalScaleBakedOffline, true);
  assert.ok(Object.isFrozen(CUSTOMS_VEGETATION_TEXTURE_ARRAY_CONTRACT));
});

// ── index validation ─────────────────────────────────────────────────────────────────────────

test('a well-formed index validates and exposes the layer lookup', () => {
  const index = validateCustomsVegetationTextureArrayIndex(syntheticIndex());
  assert.equal(index.counts.layers, 4);
  assert.equal(index.counts.primitives, 4);
  assert.equal(index.arrays.length, 3);
  assert.equal(index.layerByKey.get(customsVegetationLayerKey('a', 0, 'card')).layer, 1);
  assert.equal(index.byLod.get(0).depth, 2);
  // 4x4x4 * 2 layers over 3 levels = 128 + 32 + 8, times 3 slots.
  assert.equal(index.arrays[0].totalBytes, 168);
  assert.equal(index.totalBytes, 3 * (168 + 20 + 16));
  assert.equal(index.uploadBytesLevel0, 3 * (128 + 16 + 16));
});

test('every primitive resolves to exactly one layer and no layer is orphaned', () => {
  rejects(
    (document) => { document.primitives = document.primitives.filter((entry) => entry.materialName !== 'card'); },
    /never referenced by a primitive/u,
  );
  rejects(
    (document) => { document.primitives[0].materialName = 'not-a-material'; },
    /resolves to no layer/u,
  );
  rejects(
    (document) => { document.layers[1].layer = 0; },
    /claimed twice/u,
  );
  rejects(
    (document) => {
      // LOD0 still declares 2 layers, but only layer 0 is described.
      document.layers = document.layers.filter((entry) => !(entry.lod === 0 && entry.layer === 1));
      document.primitives = document.primitives.filter((entry) => !(entry.lod === 0 && entry.layer === 1));
    },
    /LOD0 layer 1 is orphaned/u,
  );
  rejects(
    (document) => { document.layers.push({ ...document.layers[0], materialIndex: 9 }); },
    /claimed twice/u,
  );
});

test('the layer key is (assetId, lod, materialName) and a collision is refused', () => {
  rejects(
    (document) => {
      document.layers[1].materialName = 'bark';
      document.primitives[1].materialName = 'bark';
    },
    /resolves to two layers/u,
  );
});

test('a level table that does not match layers x res x res x 4 is refused', () => {
  rejects((document) => { document.arrays[0].levels[1].byteLength += 4; }, /is not layers\*res\*res\*4/u);
  rejects((document) => { document.arrays[0].levels[1].byteOffset += 4; }, /byteOffset/u);
  rejects((document) => { document.arrays[0].levels[1].width = 3; }, /is not 2x2/u);
  rejects((document) => { document.arrays[0].mipLevels = 9; }, /mip levels/u);
  rejects((document) => { document.arrays[0].width = 5; document.arrays[0].height = 5; }, /not a power of two/u);
});

test('a blob whose declared size disagrees with its level table is refused', () => {
  rejects((document) => { document.arrays[0].blobs.orm.bytes += 4; }, /the level table sums to/u);
  rejects((document) => { document.arrays[0].blobs.orm.sha256 = 'nope'; }, /sha256 receipt/u);
  rejects((document) => { document.arrays[0].blobs.orm.file = '../secret.bin'; }, /unsafe/u);
  rejects((document) => { document.arrays[0].blobs.orm.file = 'veg-l1-orm.bin'; }, /does not match its slot/u);
  rejects((document) => { delete document.arrays[0].blobs.normal; }, /missing the normal blob/u);
});

test('a document that is not this contract is refused before anything is read', () => {
  rejects((document) => { document.documentType = 'something-else'; }, /documentType/u);
  rejects((document) => { document.schemaVersion = 2; }, /schemaVersion/u);
  rejects((document) => { document.map = 'woods'; }, /not the Customs set/u);
  rejects((document) => { document.packIndexSha256 = 'sha256:zz'; }, /pack index sha256/u);
  rejects((document) => { document.layerAttribute.type = 'uint8'; }, /layer attribute/u);
  rejects((document) => { document.arrays = document.arrays.slice(0, 2); }, /one array per LOD tier/u);
});

test('a declared total that disagrees with the blob table is refused', () => {
  rejects((document) => { document.totalBytes = 999; }, /declares 999 total bytes/u);
});

// ── the per-vertex layer attribute ───────────────────────────────────────────────────────────

test('applying a layer adds one constant float attribute and leaves the rest alone', () => {
  const geometry = triangle(6);
  const before = geometry.attributes.position.array;
  applyCustomsVegetationLayerAttribute(geometry, 42);
  const attribute = geometry.getAttribute(CUSTOMS_VEGETATION_LAYER_ATTRIBUTE);
  assert.equal(attribute.itemSize, 1);
  assert.equal(attribute.count, 6);
  assert.ok(attribute.array instanceof Float32Array);
  assert.deepEqual([...attribute.array], [42, 42, 42, 42, 42, 42]);
  assert.equal(geometry.attributes.position.array, before, 'position must not be touched');
});

test('a geometry with no position, or a negative layer, is refused', () => {
  assert.throws(() => applyCustomsVegetationLayerAttribute(new THREE.BufferGeometry(), 0), /position attribute/u);
  assert.throws(() => applyCustomsVegetationLayerAttribute(triangle(), -1), /non-negative integer/u);
  assert.throws(() => applyCustomsVegetationLayerAttribute(triangle(), 1.5), /non-negative integer/u);
});

test('binding a group is all-or-nothing, which is the merge precondition', () => {
  const index = validateCustomsVegetationTextureArrayIndex(syntheticIndex());
  const primitives = [
    { geometry: triangle(3), materialName: 'bark' },
    { geometry: triangle(3), materialName: 'card' },
  ];
  const bound = applyCustomsVegetationLayerAttributes(index, 'a', 0, primitives);
  assert.deepEqual(bound.map((entry) => entry.layer), [0, 1]);

  const unknown = [{ geometry: triangle(3), materialName: 'bark' }, { geometry: triangle(3), materialName: 'ghost' }];
  assert.throws(() => applyCustomsVegetationLayerAttributes(index, 'a', 0, unknown), /no texture-array layer/u);
  assert.equal(
    unknown[1].geometry.getAttribute(CUSTOMS_VEGETATION_LAYER_ATTRIBUTE),
    undefined,
    'an unresolved primitive must not be half-bound',
  );
});

test('after a useGroups:false merge the layer still varies at the primitive boundary', () => {
  // This is the whole reason the index is per-vertex: the merged bucket is ONE draw covering
  // primitives with different layers, so neither a uniform nor a per-instance value would do.
  const index = validateCustomsVegetationTextureArrayIndex(syntheticIndex());
  const primitives = [
    { geometry: triangle(3), materialName: 'bark' },
    { geometry: triangle(3), materialName: 'card' },
  ];
  applyCustomsVegetationLayerAttributes(index, 'a', 0, primitives);
  const merged = mergeGeometries(primitives.map((entry) => entry.geometry), false);
  assert.ok(merged, 'primitives carrying vegLayer must still merge');
  assert.equal(merged.groups.length, 0, 'useGroups:false must not leave per-material groups behind');
  const attribute = merged.getAttribute(CUSTOMS_VEGETATION_LAYER_ATTRIBUTE);
  assert.equal(attribute.count, 6);
  assert.deepEqual([...attribute.array], [0, 0, 0, 1, 1, 1]);
});

test('an unresolved lookup names what was missing instead of guessing a layer', () => {
  const index = validateCustomsVegetationTextureArrayIndex(syntheticIndex());
  assert.throws(
    () => resolveCustomsVegetationLayer(index, { assetId: 'a', lod: 0, materialName: 'ghost' }),
    (error) => {
      assert.equal(error.code, 'ERR_CUSTOMS_VEGETATION_TEXTURE_ARRAY_UNBOUND');
      assert.match(error.message, /ghost/u);
      return true;
    },
  );
});

// ── level slicing and texture construction ───────────────────────────────────────────────────

test('slicing returns the exact level slab and rejects a blob of the wrong size', () => {
  const index = validateCustomsVegetationTextureArrayIndex(syntheticIndex());
  const array = index.byLod.get(0);
  const bytes = new Uint8Array(array.totalBytes);
  bytes.fill(7, array.levels[1].byteOffset, array.levels[1].byteOffset + array.levels[1].byteLength);
  const level1 = sliceCustomsVegetationArrayLevel(bytes, array, 1);
  assert.equal(level1.byteLength, array.levels[1].byteLength);
  assert.ok(level1.every((value) => value === 7));
  assert.throws(() => sliceCustomsVegetationArrayLevel(new Uint8Array(4), array, 0), /level table sums to/u);
  assert.throws(() => sliceCustomsVegetationArrayLevel(bytes, array, 99), /has no level 99/u);
});

test('a built texture uploads level 0 and leaves mip generation to the renderer', () => {
  const index = validateCustomsVegetationTextureArrayIndex(syntheticIndex());
  const array = index.byLod.get(0);
  const bytes = new Uint8Array(array.totalBytes);
  const texture = createCustomsVegetationArrayTexture(bytes, array, 'basecolor');
  assert.equal(texture.isDataArrayTexture, true);
  assert.equal(texture.image.width, 4);
  assert.equal(texture.image.height, 4);
  assert.equal(texture.image.depth, 2);
  assert.equal(texture.image.data.byteLength, array.levels[0].byteLength);
  assert.equal(texture.colorSpace, THREE.SRGBColorSpace);
  assert.equal(texture.wrapS, THREE.RepeatWrapping);
  assert.equal(texture.wrapT, THREE.RepeatWrapping);
  assert.equal(texture.minFilter, THREE.LinearMipmapLinearFilter);
  assert.equal(texture.flipY, false);
  assert.equal(texture.generateMipmaps, true);
  assert.equal(texture.mipmaps.length, 0, 'assigning mipmaps here suppresses generation on three 0.185.1');

  const linear = createCustomsVegetationArrayTexture(bytes, array, 'orm');
  assert.equal(linear.colorSpace, THREE.NoColorSpace);
  assert.throws(() => createCustomsVegetationArrayTexture(bytes, array, 'roughness'), /unknown texture array slot/u);
});

// ── the real artifact ────────────────────────────────────────────────────────────────────────

async function realIndex() {
  return JSON.parse(await readFile(join(ARRAY_ROOT, 'veg-layers.json'), 'utf8'));
}

test('the real index validates, and its shape is the measured one', { skip: SKIP_ARTIFACT }, async () => {
  const raw = await realIndex();
  const index = validateCustomsVegetationTextureArrayIndex(raw);
  assert.equal(index.counts.layers, EXPECTED_LAYERS);
  assert.equal(index.counts.primitives, EXPECTED_PRIMITIVES);
  assert.equal(index.totalBytes, EXPECTED_TOTAL_BYTES);
  assert.equal(index.uploadBytesLevel0, EXPECTED_LEVEL0_BYTES);
  assert.deepEqual(raw.alphaModeCounts, { MASK: 22, OPAQUE: 177 });
  for (const expected of EXPECTED_ARRAYS) {
    const array = index.byLod.get(expected.lod);
    assert.equal(array.depth, expected.depth);
    assert.equal(array.width, expected.resolution);
    assert.equal(array.height, expected.resolution);
    assert.equal(array.mipLevels, expected.mipLevels);
    assert.equal(array.normalScaleBaked, expected.normalScaleBaked);
  }
});

test('every one of the 199 primitives resolves to exactly one layer', { skip: SKIP_ARTIFACT }, async () => {
  const raw = await realIndex();
  const index = validateCustomsVegetationTextureArrayIndex(raw);
  const claimed = new Set();
  for (const primitive of raw.primitives) {
    const layer = resolveCustomsVegetationLayer(index, primitive);
    assert.equal(layer.layer, primitive.layer);
    claimed.add(`${layer.lod} ${layer.layer}`);
  }
  assert.equal(raw.primitives.length, EXPECTED_PRIMITIVES);
  assert.equal(claimed.size, EXPECTED_LAYERS, 'a layer is orphaned');
  assert.equal(claimed.size, index.arrays.reduce((sum, array) => sum + array.depth, 0));
});

test('the nine blobs on disk match their receipts byte for byte', { skip: SKIP_ARTIFACT }, async () => {
  const index = validateCustomsVegetationTextureArrayIndex(await realIndex());
  let total = 0;
  for (const array of index.arrays) {
    for (const slot of CUSTOMS_VEGETATION_TEXTURE_ARRAY_SLOTS) {
      const blob = array.blobs[slot];
      const path = join(ARRAY_ROOT, blob.file);
      assert.equal((await stat(path)).size, blob.bytes, `${blob.file} size`);
      const bytes = await readFile(path);
      assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, blob.sha256, `${blob.file} sha256`);
      total += blob.bytes;
    }
  }
  assert.equal(total, EXPECTED_TOTAL_BYTES);
  assert.ok(total <= 27_000_000, 'the array set outgrew the planned ~27 MB');
});

test('the loader builds nine array textures from the real blobs', { skip: SKIP_ARTIFACT }, async () => {
  const index = validateCustomsVegetationTextureArrayIndex(await realIndex());
  const fetched = [];
  const fetchImpl = async (url) => {
    const file = url.slice(url.lastIndexOf('/') + 1);
    fetched.push(file);
    const bytes = await readFile(join(ARRAY_ROOT, file));
    return {
      ok: true,
      headers: { get: (name) => (name === 'content-length' ? String(bytes.byteLength) : null) },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };

  const set = await loadCustomsVegetationTextureArrays({ index, baseUrl: '/@vegetation-arraytex', fetchImpl });
  try {
    assert.equal(fetched.length, 9);
    assert.equal(new Set(fetched).size, 9);
    assert.equal(set.textures.size, 9);
    assert.equal(set.stats.layers, EXPECTED_LAYERS);
    assert.equal(set.stats.uploadBytes, EXPECTED_LEVEL0_BYTES);
    for (const expected of EXPECTED_ARRAYS) {
      for (const slot of CUSTOMS_VEGETATION_TEXTURE_ARRAY_SLOTS) {
        const texture = set.texture(expected.lod, slot);
        assert.equal(texture.image.width, expected.resolution);
        assert.equal(texture.image.depth, expected.depth);
        assert.equal(
          texture.image.data.byteLength,
          expected.depth * expected.resolution * expected.resolution * 4,
        );
        assert.equal(texture.mipmaps.length, 0);
        assert.equal(texture.generateMipmaps, true);
        assert.equal(
          texture.colorSpace,
          slot === 'basecolor' ? THREE.SRGBColorSpace : THREE.NoColorSpace,
        );
      }
    }
  } finally {
    set.dispose();
  }
  assert.equal(set.textures.size, 0, 'dispose must release every texture');
});

test('a blob whose bytes do not match its receipt fails closed', { skip: SKIP_ARTIFACT }, async () => {
  const index = validateCustomsVegetationTextureArrayIndex(await realIndex());
  const fetchImpl = async (url) => {
    const file = url.slice(url.lastIndexOf('/') + 1);
    const bytes = await readFile(join(ARRAY_ROOT, file));
    const copy = Uint8Array.from(bytes);
    copy[0] ^= 0xff;
    return {
      ok: true,
      headers: { get: () => String(copy.byteLength) },
      arrayBuffer: async () => copy.buffer,
    };
  };
  await assert.rejects(
    loadCustomsVegetationTextureArrays({ index, baseUrl: '/@vegetation-arraytex', fetchImpl }),
    (error) => {
      assert.equal(error.code, 'ERR_CUSTOMS_VEGETATION_TEXTURE_ARRAY_INTEGRITY');
      return true;
    },
  );
});

// ── a failing blob names ITSELF, not the index that listed it ────────────────────────────────
//
// Nine blobs hang off one `veg-layers.json`. The loader used to fail with `texture array blob HTTP
// 404` and no location at all, so the renderer had nothing to report but the index URL — which is
// the one file that is provably fine, because it is what named the blob. The reader was sent to
// look at a healthy artifact.

/** Serve the synthetic index's blobs as real bytes, with receipts that actually hash. */
function servableSyntheticIndex() {
  const raw = syntheticIndex();
  const bodies = new Map();
  for (const array of raw.arrays) {
    for (const slot of CUSTOMS_VEGETATION_TEXTURE_ARRAY_SLOTS) {
      const blob = array.blobs[slot];
      const bytes = new Uint8Array(blob.bytes).fill((array.lod * 3) + slot.length);
      blob.sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      bodies.set(blob.file, bytes);
    }
  }
  return { bodies, index: validateCustomsVegetationTextureArrayIndex(raw) };
}

test('a dead blob is reported with its own url, file, lod and slot', async () => {
  const { bodies, index } = servableSyntheticIndex();
  const dead = 'veg-l1-basecolor.bin';
  const fetched = [];
  const fetchImpl = async (url) => {
    const file = url.slice(url.lastIndexOf('/') + 1);
    fetched.push(file);
    if (file === dead) return { ok: false, status: 404, headers: { get: () => null } };
    const bytes = bodies.get(file);
    return {
      ok: true,
      headers: { get: (name) => (name === 'content-length' ? String(bytes.byteLength) : null) },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };

  await assert.rejects(
    loadCustomsVegetationTextureArrays({ index, baseUrl: '/@vegetation-arraytex/', fetchImpl }),
    (error) => {
      assert.ok(error instanceof CustomsVegetationTextureArrayError);
      assert.equal(error.code, 'ERR_CUSTOMS_VEGETATION_TEXTURE_ARRAY_HTTP');
      assert.equal(error.url, `/@vegetation-arraytex/${dead}`, 'the failing blob URL must travel with the error');
      assert.equal(error.file, dead);
      assert.equal(error.lod, 1);
      assert.equal(error.slot, 'basecolor');
      // "which of the nine" has to be answerable from the message alone, because that is what
      // reaches the console.
      assert.match(error.message, new RegExp(dead.replace('.', '\\.')));
      assert.match(error.message, /HTTP 404/);
      assert.doesNotMatch(error.message, /veg-layers\.json/, 'the index is not what failed');
      return true;
    },
  );
  // The loader opens all nine at once, so the diagnosis cannot lean on request ORDER the way it
  // could when the fetches were serial: the dead blob is the fourth of nine by declaration and
  // may be the first, last or middle one to settle. Every one of the nine was asked for, and the
  // error above still named exactly which of them failed.
  assert.equal(fetched.length, 9, 'all nine blobs are requested concurrently, not one at a time');
  assert.ok(fetched.includes(dead));
  assert.equal(new Set(fetched).size, 9, 'each blob is requested exactly once');
});

test('one dead blob disposes every texture the other eight already built', async () => {
  const { bodies, index } = servableSyntheticIndex();
  // The dead blob settles FIRST and the eight healthy ones settle after it. That ordering is the
  // whole point: under `Promise.all` the loader would reject and run `dispose()` on an empty map
  // at t=0, and the eight textures built afterwards would never be released at all. `allSettled`
  // waits for every one of them, so the disposal covers all eight.
  const dead = 'veg-l0-basecolor.bin';
  const fetchImpl = async (url) => {
    const file = url.slice(url.lastIndexOf('/') + 1);
    const bytes = bodies.get(file);
    if (file === dead) return { ok: false, status: 500, headers: { get: () => null } };
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    return {
      ok: true,
      headers: { get: (name) => (name === 'content-length' ? String(bytes.byteLength) : null) },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
  const disposed = [];
  const originalDispose = THREE.DataArrayTexture.prototype.dispose;
  THREE.DataArrayTexture.prototype.dispose = function trackedDispose(...args) {
    disposed.push(this.name);
    return originalDispose.apply(this, args);
  };
  try {
    await assert.rejects(
      loadCustomsVegetationTextureArrays({ index, baseUrl: '/@vegetation-arraytex/', fetchImpl }),
      (error) => error.code === 'ERR_CUSTOMS_VEGETATION_TEXTURE_ARRAY_HTTP',
    );
  } finally {
    THREE.DataArrayTexture.prototype.dispose = originalDispose;
  }
  assert.equal(disposed.length, 8, 'every texture built before the failure is released');
});

test('a transport-level rejection is annotated with the blob, not replaced', async () => {
  const { bodies, index } = servableSyntheticIndex();
  const dead = 'veg-l0-normal.bin';
  const fetchImpl = async (url) => {
    const file = url.slice(url.lastIndexOf('/') + 1);
    if (file === dead) throw new TypeError('Failed to fetch');
    const bytes = bodies.get(file);
    return {
      ok: true,
      headers: { get: () => String(bytes.byteLength) },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
  await assert.rejects(
    loadCustomsVegetationTextureArrays({ index, baseUrl: '/@vegetation-arraytex/', fetchImpl }),
    (error) => {
      assert.ok(error instanceof TypeError, 'the original error and its stack are the diagnosis');
      assert.equal(error.message, 'Failed to fetch');
      assert.equal(error.url, `/@vegetation-arraytex/${dead}`);
      assert.equal(error.file, dead);
      assert.equal(error.slot, 'normal');
      return true;
    },
  );
});

// ── the collapse itself: materialMode and drawCalls under a real runtime ──────────────────────
//
// This is the assertion whose absence let a dead /@vegetation-arraytex/ route ship. Every other
// test in this file measures the arrays in ISOLATION — the index validates, the blobs hash, nine
// textures build — and every one of them passed while the running app drew 57 calls at the
// default orbit against a committed 31, because nothing asserted that the arrays actually reached
// `createCustomsAuthoredVegetationRuntime` and changed how it batches.
//
// The two halves are run against the SAME fixture so the difference is attributable: without the
// arrays, pine01's two primitive materials cost two draw calls inside one bucket; with them, every
// bucket is exactly one call, so `drawCalls === liveBuckets` is the collapse, stated as an
// equation rather than as a number that could drift with the fixture.

const ARRAY_RUNTIME_ASSETS = [
  { assetId: 'customs.vegetation.pine01', prototypeName: 'pine01', materials: ['pine-bark', 'pine-card'] },
  { assetId: 'customs.vegetation.tree02', prototypeName: 'tree02', materials: ['tree-card'] },
];
const ARRAY_RUNTIME_LODS = [
  { lod: 0, resolution: 4, mipLevels: 3 },
  { lod: 1, resolution: 2, mipLevels: 2 },
  { lod: 2, resolution: 2, mipLevels: 1 },
];

function runtimePack() {
  return {
    map: 'customs',
    status: 'offline-production-draft-not-live',
    runtimeContract: {
      collision: 'none',
      exactScalarPlacement: true,
      livePromotion: false,
      geometry: 'original approximation; not source-game topology',
    },
    counts: { authoredAssets: 2, tilePrototypeBindings: 2, placements: 3 },
    authoredAssets: ARRAY_RUNTIME_ASSETS.map(({ assetId, prototypeName }) => ({
      assetId,
      prototypeName,
      collision: 'none',
      geometryEvidence: 'original approximation for test',
      gltf: { unit: 'metre', upAxis: '+y', forwardAxis: '+z', pivot: 'base-center' },
      lods: [0, 1, 2].map((lod) => ({
        lod,
        file: `assets/${prototypeName}/${prototypeName}-lod${lod}.glb`,
        bytes: 100 + lod,
        sha256: `sha256:${'a'.repeat(64)}`,
        triangles: 12 - lod * 3,
      })),
    })),
    prototypeBindings: [
      {
        tileId: 'terrain-000', prototypeId: 'terrain-000-vegetation-001',
        prototypeName: 'pine01', assetId: 'customs.vegetation.pine01',
      },
      {
        tileId: 'terrain-000', prototypeId: 'terrain-000-vegetation-000',
        prototypeName: 'tree02', assetId: 'customs.vegetation.tree02',
      },
    ],
  };
}

function runtimePlacement(flatIndex, prototypeName) {
  const pine = prototypeName === 'pine01';
  return {
    flatIndex,
    tileId: 'terrain-000',
    prototypeId: pine ? 'terrain-000-vegetation-001' : 'terrain-000-vegetation-000',
    prototypeName,
    classification: pine ? 'pine' : 'deciduous',
    presentationPosition: [flatIndex * 2, 0, 0],
    yawRadians: 0,
    dimensions: pine ? { width: 4.75, height: 10.8 } : { width: 4.7, height: 8.1 },
    tint: { r: 1, g: 1, b: 1 },
  };
}

function runtimeRenderPlan() {
  const placements = [
    runtimePlacement(0, 'pine01'),
    runtimePlacement(1, 'pine01'),
    runtimePlacement(2, 'tree02'),
  ];
  const groups = { pine: [], deciduous: [], shrub: [], stump: [], 'ground-plant': [] };
  for (const entry of placements) groups[entry.classification].push(entry);
  return {
    sourceCount: placements.length,
    renderedCount: placements.length,
    culledCount: 0,
    counts: Object.fromEntries(Object.entries(groups).map(([key, values]) => [key, values.length])),
    groups,
  };
}

function runtimeGlb(materials) {
  const scene = new THREE.Group();
  const child = new THREE.Group();
  child.name = 'authored-child';
  scene.add(child);
  materials.forEach((name, index) => {
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff });
    material.name = name;
    const mesh = new THREE.Mesh(triangle(3), material);
    mesh.name = `primitive-${index}`;
    child.add(mesh);
  });
  return { scene };
}

/**
 * Build a real loaded array set over the fixture's own material names.
 *
 * Goes through `loadCustomsVegetationTextureArrays` rather than hand-rolling textures, so the
 * runtime receives exactly the object shape the app hands it — including the sha256 verification,
 * which is computed here from the same bytes the fake fetch serves.
 */
async function runtimeArraySet() {
  const layers = [];
  const arrays = ARRAY_RUNTIME_LODS.map(({ lod, resolution, mipLevels }) => {
    let layerIndex = 0;
    for (const asset of ARRAY_RUNTIME_ASSETS) {
      for (const materialName of asset.materials) {
        layers.push({
          assetId: asset.assetId,
          lod,
          layer: layerIndex,
          materialName,
          alphaMode: 'OPAQUE',
          alphaCutoff: null,
        });
        layerIndex += 1;
      }
    }
    const { levels, total } = levelTable(resolution, layerIndex, mipLevels);
    return {
      blobs: Object.fromEntries(CUSTOMS_VEGETATION_TEXTURE_ARRAY_SLOTS.map((slot) => [slot, {
        bytes: total,
        file: `veg-l${lod}-${slot}.bin`,
        sha256: null,
      }])),
      depth: layerIndex,
      height: resolution,
      levels,
      lod,
      mipLevels,
      normalScaleBaked: 0.5,
      width: resolution,
    };
  });

  // Deterministic bytes per (lod, slot), then the receipt is the digest of exactly those bytes.
  const bodies = new Map();
  for (const array of arrays) {
    for (const slot of CUSTOMS_VEGETATION_TEXTURE_ARRAY_SLOTS) {
      const blob = array.blobs[slot];
      const bytes = new Uint8Array(blob.bytes);
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index + array.lod) & 0xff;
      blob.sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      bodies.set(blob.file, bytes);
    }
  }

  const index = validateCustomsVegetationTextureArrayIndex({
    arrays,
    documentType: CUSTOMS_VEGETATION_TEXTURE_ARRAY_DOCUMENT_TYPE,
    layerAttribute: { itemSize: 1, name: CUSTOMS_VEGETATION_LAYER_ATTRIBUTE, type: 'float32' },
    layers,
    map: 'customs',
    packIndexSha256: fakeSha('pack'),
    primitives: layers.map((layer, ordinal) => ({ ...layer, materialIndex: ordinal, primitiveIndex: ordinal })),
    schemaVersion: 1,
  });

  return loadCustomsVegetationTextureArrays({
    index,
    baseUrl: '/@vegetation-arraytex/',
    fetchImpl: async (url) => {
      const bytes = bodies.get(url.slice(url.lastIndexOf('/') + 1));
      assert.ok(bytes, `the fixture fetch was asked for an undeclared blob: ${url}`);
      return {
        ok: true,
        headers: { get: (name) => (name === 'content-length' ? String(bytes.byteLength) : null) },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    },
  });
}

async function runtimeWith(textureArrays) {
  const catalog = normalizeCustomsAuthoredVegetationCatalog(runtimePack());
  const byPrototype = new Map(ARRAY_RUNTIME_ASSETS.map((entry) => [entry.prototypeName, entry.materials]));
  return createCustomsAuthoredVegetationRuntime({
    plan: runtimeRenderPlan(),
    catalog,
    requireCompleteCatalog: false,
    cameraWorldPosition: [0, 0, 200],
    textureArrays,
    loadGlb: async (_url, { asset }) => runtimeGlb(byPrototype.get(asset.prototypeName)),
    disposeLoadedGlb() {},
  });
}

test('with the arrays present the runtime collapses to one material per LOD and one call per bucket', async () => {
  const arrays = await runtimeArraySet();
  const runtime = await runtimeWith(arrays);
  try {
    const status = runtime.status;
    // The two claims the app's own status object makes, and that nothing checked before.
    assert.equal(status.materialMode, 'shared-array-texture');
    assert.equal(
      status.drawCalls,
      status.liveBuckets,
      'the shared array material must make every live (family, LOD) bucket exactly one draw call',
    );
    assert.equal(status.liveBuckets, 2, 'both families sit in one LOD band at this camera');
    assert.equal(status.drawCalls, 2);
    assert.equal(status.buckets, status.liveBuckets, 'buckets and liveBuckets are the same number');
    // One material per LOD tier, three tiers — not one per primitive, and not one per family.
    assert.equal(status.sharedMaterials, 3);
    assert.equal(status.boundArrayLayers, 9, 'three primitives x three LODs each carry a bound layer');
    assert.equal(status.visibleInstances, 3);
    assert.equal(status.textureUploadBytes, arrays.stats.uploadBytes);

    // Every mesh really does hold ONE material object, shared across families inside its tier.
    const byLod = new Map();
    for (const mesh of runtime.group.children) {
      assert.equal(Array.isArray(mesh.material), false, `${mesh.name} kept a material array`);
      assert.equal(mesh.geometry.groups.length, 0, `${mesh.name} kept per-material groups`);
      assert.ok(mesh.geometry.getAttribute(CUSTOMS_VEGETATION_LAYER_ATTRIBUTE), `${mesh.name} has no vegLayer`);
      const seen = byLod.get(mesh.userData.lod);
      if (seen) assert.equal(mesh.material, seen, 'two families in one tier must share one material');
      else byLod.set(mesh.userData.lod, mesh.material);
    }
    assert.equal(byLod.size, 3);
    assert.equal(new Set(byLod.values()).size, 3, 'the three tier materials are distinct objects');

    // The equation must survive a camera move, not just the first build.
    const moved = runtime.update({ cameraWorldPosition: [0, 0, 12] });
    assert.equal(moved.materialMode, 'shared-array-texture');
    assert.equal(moved.drawCalls, moved.liveBuckets);
  } finally {
    runtime.dispose();
    arrays.dispose();
  }
});

test('the same fixture without the arrays pays one call per primitive, which is the regression', async () => {
  const runtime = await runtimeWith(null);
  try {
    const status = runtime.status;
    assert.equal(status.materialMode, 'authored-per-primitive');
    assert.equal(status.sharedMaterials, 0);
    assert.equal(status.liveBuckets, 2);
    // pine01 merges two primitive materials and pays for both; only the array material collapses
    // them. This inequality is what the running app was reporting while claiming to be healthy.
    assert.equal(status.drawCalls, 3);
    assert.notEqual(status.drawCalls, status.liveBuckets);
  } finally {
    runtime.dispose();
  }
});

// ── stripping the pack's dead images out of a verified GLB ───────────────────────────────────
//
// Under the array material every one of the pack's 597 embedded PNGs is decoded by GLTFLoader and
// then released unused. Removing them from the JSON chunk is what takes the mount's dominant cost
// (3,781 ms of summed `gltf.parseAsync`) off the clock, and the property that makes it safe is
// that NOTHING the array path reads is lost: geometry, the binary chunk, and each material's name,
// alpha mode and cutoff all survive byte for byte.

const PACK_ROOT = join(HERE, '..', '.local-candidates', 'vegetation-full-v2');
const PACK_PRESENT = existsSync(join(PACK_ROOT, 'pack-index.json'));
const SKIP_PACK = PACK_PRESENT ? false : 'vegetation-full-v2 is not built locally';

const GLB_JSON = 0x4e4f534a;

function glbChunks(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  assert.equal(view.getUint32(16, true), GLB_JSON);
  return {
    json: JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))),
    bin: bytes.subarray(20 + jsonLength),
    total: view.getUint32(8, true),
    byteLength: bytes.byteLength,
  };
}

function minimalGlb(json, bin = new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0])) {
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const padded = (encoded.byteLength + 3) & ~3;
  const out = new Uint8Array(20 + padded + 8 + bin.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.byteLength, true);
  view.setUint32(12, padded, true);
  view.setUint32(16, GLB_JSON, true);
  out.fill(0x20, 20 + encoded.byteLength, 20 + padded);
  out.set(encoded, 20);
  view.setUint32(20 + padded, bin.byteLength, true);
  view.setUint32(24 + padded, 0x004e4942, true);
  out.set(bin, 28 + padded);
  return out.buffer;
}

test('the strip keeps every material identity the array path binds on', () => {
  const source = minimalGlb({
    asset: { version: '2.0' },
    materials: [
      {
        name: 'TZ_VEG_leaf_card_L0',
        alphaMode: 'MASK',
        alphaCutoff: 0.5,
        doubleSided: true,
        extras: { tz_material_family: 'leaf' },
        normalTexture: { index: 0, scale: 0.78 },
        occlusionTexture: { index: 1 },
        pbrMetallicRoughness: { baseColorTexture: { index: 2 }, metallicRoughnessTexture: { index: 1 } },
      },
    ],
    images: [{ mimeType: 'image/png', bufferView: 0 }],
    textures: [{ source: 0, sampler: 0 }],
    samplers: [{ wrapS: 10497, wrapT: 10497 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }],
    buffers: [{ byteLength: 8 }],
  });
  const stripped = stripCustomsVegetationGlbImages(source);
  assert.equal(stripped.images, 1);
  assert.equal(stripped.materials, 1);

  const before = glbChunks(source);
  const after = glbChunks(stripped.bytes);
  assert.deepEqual(after.json.materials, [{
    name: 'TZ_VEG_leaf_card_L0',
    alphaMode: 'MASK',
    alphaCutoff: 0.5,
    doubleSided: true,
    extras: { tz_material_family: 'leaf' },
  }], 'name, alpha mode, cutoff and sidedness are what the array path reads');
  assert.equal(after.json.images, undefined);
  assert.equal(after.json.textures, undefined);
  assert.equal(after.json.samplers, undefined);
  // Nothing is renumbered, so every accessor offset the geometry depends on is still correct.
  assert.deepEqual(after.json.meshes, before.json.meshes);
  assert.deepEqual(after.json.accessors, before.json.accessors);
  assert.deepEqual(after.json.bufferViews, before.json.bufferViews);
  assert.deepEqual(after.json.buffers, before.json.buffers);
  assert.deepEqual([...after.bin], [...before.bin], 'the binary chunk is carried over byte for byte');
  assert.equal(after.total, after.byteLength, 'the rebuilt header declares its own real length');
});

test('the strip refuses a shape it has not proved safe, rather than flattening it', () => {
  const withExtension = minimalGlb({
    asset: { version: '2.0' },
    extensionsUsed: ['KHR_texture_transform'],
    materials: [{ name: 'a' }],
  });
  assert.throws(
    () => stripCustomsVegetationGlbImages(withExtension),
    (error) => error.code === 'ERR_CUSTOMS_VEGETATION_GLB_STRIP_UNSUPPORTED',
  );
  const unknownMaterialKey = minimalGlb({
    asset: { version: '2.0' },
    materials: [{ name: 'a', clearcoatTexture: { index: 0 } }],
  });
  assert.throws(
    () => stripCustomsVegetationGlbImages(unknownMaterialKey),
    (error) => error.code === 'ERR_CUSTOMS_VEGETATION_GLB_STRIP_UNSUPPORTED',
  );
  assert.throws(
    () => stripCustomsVegetationGlbImages(new Uint8Array(64).buffer),
    (error) => error.code === 'ERR_CUSTOMS_VEGETATION_GLB_STRIP',
  );
});

test('every GLB in the real pack strips to zero images with its geometry intact', { skip: SKIP_PACK }, async () => {
  const packIndex = JSON.parse(await readFile(join(PACK_ROOT, 'pack-index.json'), 'utf8'));
  let images = 0;
  let materials = 0;
  let files = 0;
  for (const asset of packIndex.authoredAssets) {
    for (const lod of asset.lods) {
      const source = await readFile(join(PACK_ROOT, lod.file));
      const buffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
      const stripped = stripCustomsVegetationGlbImages(buffer);
      const before = glbChunks(buffer);
      const after = glbChunks(stripped.bytes);
      assert.equal(after.json.images, undefined, `${lod.file} still declares images`);
      assert.deepEqual(after.json.accessors, before.json.accessors, `${lod.file} accessors moved`);
      assert.deepEqual(after.json.bufferViews, before.json.bufferViews, `${lod.file} bufferViews moved`);
      assert.deepEqual(after.json.nodes, before.json.nodes, `${lod.file} node hierarchy changed`);
      assert.equal(after.bin.byteLength, before.bin.byteLength, `${lod.file} binary chunk resized`);
      assert.deepEqual(
        after.json.materials.map((material) => material.name),
        before.json.materials.map((material) => material.name),
        `${lod.file} lost a material name, which is the texture-array layer key`,
      );
      images += stripped.images;
      materials += stripped.materials;
      files += 1;
    }
  }
  // The measured pack: 93 GLBs, 199 materials, 597 embedded PNGs that the array material makes
  // dead on arrival. Pinned so a rebuild that changes the shape fails here rather than silently.
  assert.equal(files, 93);
  assert.equal(materials, 199);
  assert.equal(images, 597);
});
