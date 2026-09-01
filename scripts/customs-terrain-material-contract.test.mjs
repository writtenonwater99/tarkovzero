import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CUSTOMS_TERRAIN_SEMANTIC_LAYERS,
  validateCustomsTerrainMaterialSet,
} from '../src/customs-terrain-material-contract.js';

const ROOT = '/assets/3d/customs/terrain-authored/';
const DIGESTS = Object.freeze({
  albedo: 'a'.repeat(64),
  normal: 'b'.repeat(64),
  orm: 'c'.repeat(64),
  macro: 'd'.repeat(64),
  provenance: 'e'.repeat(64),
  license: 'f'.repeat(64),
});

function receipts(label) {
  return {
    provenance: {
      url: `${ROOT}receipts/${label}-provenance.json`,
      sha256: DIGESTS.provenance,
    },
    originalLicense: {
      url: `${ROOT}receipts/${label}-original-license.json`,
      sha256: DIGESTS.license,
    },
  };
}

function textureArray(role) {
  const descriptor = {
    kind: 'ktx2-array',
    role,
    url: `${ROOT}customs-${role}.ktx2`,
    width: 1024,
    height: 1024,
    slices: 12,
    mipLevels: 11,
    colorSpace: role === 'albedo' ? 'srgb' : 'linear',
    sha256: DIGESTS[role],
    receipts: receipts(role),
  };
  if (role === 'normal') descriptor.normalSpace = 'tangent';
  if (role === 'orm') descriptor.channels = ['occlusion', 'roughness', 'metallic', 'unused'];
  return descriptor;
}

function materialSet() {
  return {
    schemaVersion: 1,
    map: 'customs',
    delivery: 'original-authored',
    layers: CUSTOMS_TERRAIN_SEMANTIC_LAYERS.map((layer) => ({
      ...layer,
      arrayIndex: layer.index,
      metresPerRepeat: 2 + (layer.index * 0.25),
      normalStrength: 0.8 + (layer.index * 0.02),
      ormStrength: 1,
    })),
    // Input order is not role authority; normalization emits shader-binding order.
    arrays: [textureArray('orm'), textureArray('albedo'), textureArray('normal')],
    macro: {
      kind: 'ktx2-2d',
      role: 'macro-albedo',
      url: `${ROOT}customs-macro-albedo.ktx2`,
      width: 1024,
      height: 1024,
      mipLevels: 11,
      colorSpace: 'srgb',
      metresPerRepeat: 256,
      strength: 0.16,
      sha256: DIGESTS.macro,
      receipts: receipts('macro'),
    },
  };
}

test('normalizes and deeply freezes the exact 12-layer authored material set v1', () => {
  const result = validateCustomsTerrainMaterialSet(materialSet());
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.map, 'customs');
  assert.equal(result.delivery, 'original-authored');
  assert.equal(result.layers.length, 12);
  assert.deepEqual(
    result.layers.map(({ semantic }) => semantic),
    CUSTOMS_TERRAIN_SEMANTIC_LAYERS.map(({ semantic }) => semantic),
  );
  assert.deepEqual(result.arrays.map(({ role }) => role), ['albedo', 'normal', 'orm']);
  assert.equal(result.arrays[1].normalSpace, 'tangent');
  assert.deepEqual(result.arrays[2].channels, ['occlusion', 'roughness', 'metallic', 'unused']);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.layers));
  assert.ok(Object.isFrozen(result.layers[0]));
  assert.ok(Object.isFrozen(result.arrays[0].receipts.originalLicense));
  assert.ok(Object.isFrozen(result.macro));
});

test('requires all 12 layers in exact terrain-manifest semantic order', () => {
  const missing = materialSet();
  missing.layers.pop();
  assert.throws(() => validateCustomsTerrainMaterialSet(missing), /exactly 12 semantic layers/);

  const wrongOrder = materialSet();
  [wrongOrder.layers[0], wrongOrder.layers[1]] = [wrongOrder.layers[1], wrongOrder.layers[0]];
  assert.throws(() => validateCustomsTerrainMaterialSet(wrongOrder), /terrain manifest order/);

  const wrongName = materialSet();
  wrongName.layers[3].terrainLayerName = 'Forest_Ground_summer';
  assert.throws(
    () => validateCustomsTerrainMaterialSet(wrongName),
    /terrainLayerName.*microsplat_layer_Forest_Ground_summer_D_3/,
  );
});

test('rejects missing, duplicate, or wrongly indexed array slices', () => {
  const missingArray = materialSet();
  missingArray.arrays.pop();
  assert.throws(() => validateCustomsTerrainMaterialSet(missingArray), /albedo, normal, and ORM/);

  const duplicateRole = materialSet();
  duplicateRole.arrays[0] = textureArray('albedo');
  assert.throws(() => validateCustomsTerrainMaterialSet(duplicateRole), /duplicates albedo/);

  const wrongSlices = materialSet();
  wrongSlices.arrays[0].slices = 11;
  assert.throws(() => validateCustomsTerrainMaterialSet(wrongSlices), /exactly 12 slices/);

  const wrongArrayIndex = materialSet();
  wrongArrayIndex.layers[5].arrayIndex = 6;
  assert.throws(() => validateCustomsTerrainMaterialSet(wrongArrayIndex), /arrayIndex.*must equal layer index 5/);
});

test('enforces matching array dimensions, complete mips, and role color spaces', () => {
  const mismatchedDimensions = materialSet();
  const normal = mismatchedDimensions.arrays.find(({ role }) => role === 'normal');
  normal.width = 512;
  normal.height = 512;
  normal.mipLevels = 10;
  assert.throws(
    () => validateCustomsTerrainMaterialSet(mismatchedDimensions),
    /must match the albedo 1024x1024 dimensions/,
  );

  const incompleteMips = materialSet();
  incompleteMips.arrays.find(({ role }) => role === 'orm').mipLevels = 10;
  assert.throws(() => validateCustomsTerrainMaterialSet(incompleteMips), /complete 11-level mip chain/);

  const albedoLinear = materialSet();
  albedoLinear.arrays.find(({ role }) => role === 'albedo').colorSpace = 'linear';
  assert.throws(() => validateCustomsTerrainMaterialSet(albedoLinear), /albedo must use srgb/);

  const normalSrgb = materialSet();
  normalSrgb.arrays.find(({ role }) => role === 'normal').colorSpace = 'srgb';
  assert.throws(() => validateCustomsTerrainMaterialSet(normalSrgb), /normal must use linear/);

  const ormSrgb = materialSet();
  ormSrgb.arrays.find(({ role }) => role === 'orm').colorSpace = 'srgb';
  assert.throws(() => validateCustomsTerrainMaterialSet(ormSrgb), /orm must use linear/);

  const macroLinear = materialSet();
  macroLinear.macro.colorSpace = 'linear';
  assert.throws(() => validateCustomsTerrainMaterialSet(macroLinear), /macro albedo must use srgb/);

  const macroMips = materialSet();
  macroMips.macro.mipLevels = 9;
  assert.throws(() => validateCustomsTerrainMaterialSet(macroMips), /complete 11-level mip chain/);
});

test('requires tangent normals and canonical ORM channel packing', () => {
  const objectSpace = materialSet();
  objectSpace.arrays.find(({ role }) => role === 'normal').normalSpace = 'object';
  assert.throws(() => validateCustomsTerrainMaterialSet(objectSpace), /normalSpace.*must be tangent/);

  const badChannels = materialSet();
  badChannels.arrays.find(({ role }) => role === 'orm').channels = [
    'roughness', 'occlusion', 'metallic', 'unused',
  ];
  assert.throws(() => validateCustomsTerrainMaterialSet(badChannels), /occlusion, roughness, metallic, unused/);
});

test('fails closed on unsafe, traversal, remote, or local-truth URLs', () => {
  for (const unsafeUrl of [
    'https://example.test/customs-albedo.ktx2',
    `${ROOT}../customs-albedo.ktx2`,
    `${ROOT}materials//customs-albedo.ktx2`,
    `${ROOT}customs-albedo.ktx2?raw=1`,
    `${ROOT}local-game-derived/customs-albedo.ktx2`,
  ]) {
    const value = materialSet();
    value.arrays.find(({ role }) => role === 'albedo').url = unsafeUrl;
    assert.throws(
      () => validateCustomsTerrainMaterialSet(value),
      /same-origin URL|traversal segments|empty or traversal segments|localhost-only truth delivery/,
      unsafeUrl,
    );
  }
});

test('requires content, provenance, and original-license SHA-256 receipts', () => {
  const badContentHash = materialSet();
  badContentHash.macro.sha256 = 'ABC';
  assert.throws(() => validateCustomsTerrainMaterialSet(badContentHash), /64-character SHA-256/);

  const badReceiptHash = materialSet();
  badReceiptHash.arrays[0].receipts.provenance.sha256 = '0'.repeat(63);
  assert.throws(() => validateCustomsTerrainMaterialSet(badReceiptHash), /64-character SHA-256/);

  const missingLicense = materialSet();
  delete missingLicense.arrays[1].receipts.originalLicense;
  assert.throws(() => validateCustomsTerrainMaterialSet(missingLicense), /missing required field originalLicense/);

  const sameReceipt = materialSet();
  sameReceipt.macro.receipts.originalLicense.url = sameReceipt.macro.receipts.provenance.url;
  assert.throws(() => validateCustomsTerrainMaterialSet(sameReceipt), /must be separate artifacts/);
});

test('keeps deployable original-authored delivery separate from local truth', () => {
  const local = materialSet();
  local.delivery = 'local-game-derived';
  assert.throws(
    () => validateCustomsTerrainMaterialSet(local),
    /must be original-authored; local truth has a separate contract/,
  );

  const duplicateAsset = materialSet();
  duplicateAsset.macro.url = duplicateAsset.arrays.find(({ role }) => role === 'albedo').url;
  assert.throws(() => validateCustomsTerrainMaterialSet(duplicateAsset), /duplicates a material array URL/);
});

test('rejects invalid physical scale and strength values', () => {
  const badRepeat = materialSet();
  badRepeat.layers[0].metresPerRepeat = 0;
  assert.throws(() => validateCustomsTerrainMaterialSet(badRepeat), /metresPerRepeat.*0.05/);

  const badNormalStrength = materialSet();
  badNormalStrength.layers[0].normalStrength = Number.NaN;
  assert.throws(() => validateCustomsTerrainMaterialSet(badNormalStrength), /normalStrength.*finite/);

  const badMacroStrength = materialSet();
  badMacroStrength.macro.strength = 1.1;
  assert.throws(() => validateCustomsTerrainMaterialSet(badMacroStrength), /strength.*from 0 through 1/);
});
