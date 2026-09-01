// Strict renderer-neutral contract for TarkovZero's original-authored Customs
// terrain materials. This deployable material delivery is intentionally separate
// from localhost-only game-derived control/elevation truth.

export const CUSTOMS_TERRAIN_MATERIAL_SET_VERSION = 1;
export const CUSTOMS_TERRAIN_MATERIAL_MAP = 'customs';
export const CUSTOMS_TERRAIN_MATERIAL_DELIVERY = 'original-authored';
export const CUSTOMS_TERRAIN_AUTHORED_ASSET_ROOT = '/assets/3d/customs/terrain-authored/';
export const CUSTOMS_TERRAIN_LAYER_COUNT = 12;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_URL_CHARS = /^[A-Za-z0-9._/-]+$/;
const MAX_TEXTURE_DIMENSION = 4096;
const MAX_REPEAT_METRES = 256;
const ARRAY_ROLES = Object.freeze(['albedo', 'normal', 'orm']);
const ORM_CHANNELS = Object.freeze(['occlusion', 'roughness', 'metallic', 'unused']);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const CUSTOMS_TERRAIN_SEMANTIC_LAYERS = deepFreeze([
  { index: 0, semantic: 'grass', terrainLayerName: 'microsplat_layer_Grass_summer_D_0' },
  { index: 1, semantic: 'ground', terrainLayerName: 'microsplat_layer_Ground_summer_D_1' },
  { index: 2, semantic: 'gravel-road-a', terrainLayerName: 'microsplat_layer_Gravel_Road_A_summer_D_2' },
  { index: 3, semantic: 'forest-ground', terrainLayerName: 'microsplat_layer_Forest_Ground_summer_D_3' },
  { index: 4, semantic: 'stone-ground', terrainLayerName: 'microsplat_layer_Stone_Ground_summer_D_4' },
  { index: 5, semantic: 'rock-ground', terrainLayerName: 'microsplat_layer_Rock_Ground_summer_D_5' },
  { index: 6, semantic: 'gravel-road-b', terrainLayerName: 'microsplat_layer_Gravel_Road_B_summer_D_6' },
  { index: 7, semantic: 'gravel', terrainLayerName: 'microsplat_layer_Gravel_summer_D_7' },
  { index: 8, semantic: 'grassy-ground', terrainLayerName: 'microsplat_layer_Grassy_Ground_summer_D_8' },
  { index: 9, semantic: 'sand', terrainLayerName: 'microsplat_layer_Sand_summer_D_9' },
  { index: 10, semantic: 'pebbles-ground', terrainLayerName: 'microsplat_layer_Pebbles_Ground_summer_D_10' },
  { index: 11, semantic: 'soil-grass', terrainLayerName: 'microsplat_layer_Soil_Grass_summer_D_11' },
]);

export class CustomsTerrainMaterialContractError extends Error {
  constructor(code, path, message) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'CustomsTerrainMaterialContractError';
    this.code = code;
    this.path = path;
  }
}

function fail(code, path, message) {
  throw new CustomsTerrainMaterialContractError(code, path, message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function objectAt(value, path) {
  if (!isPlainObject(value)) fail('ERR_TERRAIN_MATERIAL_SCHEMA', path, 'must be an object');
  return value;
}

function exactKeys(value, required, optional, path) {
  const object = objectAt(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) {
      fail('ERR_TERRAIN_MATERIAL_MISSING', path, `is missing required field ${key}`);
    }
  }
  const unexpected = Object.keys(object).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    fail('ERR_TERRAIN_MATERIAL_SCHEMA', path, `contains unsupported field(s): ${unexpected.join(', ')}`);
  }
  return object;
}

function finiteInRange(value, path, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail(
      'ERR_TERRAIN_MATERIAL_RANGE',
      path,
      `must be a finite number from ${minimum} through ${maximum}`,
    );
  }
  return Object.is(value, -0) ? 0 : value;
}

function safeInteger(value, path, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('ERR_TERRAIN_MATERIAL_RANGE', path, `must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function sha256(value, path) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail('ERR_TERRAIN_MATERIAL_HASH', path, 'must be a lowercase 64-character SHA-256 hex digest');
  }
  return value;
}

function safeAuthoredUrl(value, path, extension) {
  if (
    typeof value !== 'string'
    || value.length > 512
    || !value.startsWith(CUSTOMS_TERRAIN_AUTHORED_ASSET_ROOT)
    || !SAFE_URL_CHARS.test(value)
    || value.includes('\\')
    || value.includes('%')
    || value.includes('?')
    || value.includes('#')
    || value.startsWith('//')
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
  ) {
    fail(
      'ERR_TERRAIN_MATERIAL_UNSAFE_URL',
      path,
      `must be a same-origin URL below ${CUSTOMS_TERRAIN_AUTHORED_ASSET_ROOT}`,
    );
  }
  const segments = value.split('/');
  if (segments.some((segment, index) => index > 0 && (segment === '' || segment === '.' || segment === '..'))) {
    fail('ERR_TERRAIN_MATERIAL_UNSAFE_URL', path, 'must not contain empty or traversal segments');
  }
  if (!value.toLowerCase().endsWith(extension)) {
    fail('ERR_TERRAIN_MATERIAL_SCHEMA', path, `must end in ${extension}`);
  }
  const lower = value.toLowerCase();
  if (lower.includes('local-game-derived') || lower.includes('/@local-')) {
    fail('ERR_TERRAIN_MATERIAL_SOURCE_MIX', path, 'must not reference localhost-only truth delivery');
  }
  return value;
}

function normalizeReceipts(value, path) {
  const receipts = exactKeys(value, ['provenance', 'originalLicense'], [], path);
  const normalizeReceipt = (entry, entryPath) => {
    const receipt = exactKeys(entry, ['url', 'sha256'], [], entryPath);
    return {
      url: safeAuthoredUrl(receipt.url, `${entryPath}.url`, '.json'),
      sha256: sha256(receipt.sha256, `${entryPath}.sha256`),
    };
  };
  const provenance = normalizeReceipt(receipts.provenance, `${path}.provenance`);
  const originalLicense = normalizeReceipt(receipts.originalLicense, `${path}.originalLicense`);
  if (provenance.url === originalLicense.url) {
    fail(
      'ERR_TERRAIN_MATERIAL_DUPLICATE',
      path,
      'provenance and original-license receipts must be separate artifacts',
    );
  }
  return { provenance, originalLicense };
}

function textureDimension(value, path) {
  const dimension = safeInteger(value, path, 1, MAX_TEXTURE_DIMENSION);
  if ((dimension & (dimension - 1)) !== 0) {
    fail('ERR_TERRAIN_MATERIAL_DIMENSIONS', path, 'must be a power-of-two texture dimension');
  }
  return dimension;
}

function fullMipCount(width, height) {
  return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

function assertFullMipChain(mipLevels, width, height, path) {
  const expected = fullMipCount(width, height);
  if (mipLevels !== expected) {
    fail(
      'ERR_TERRAIN_MATERIAL_MIPS',
      path,
      `must contain the complete ${expected}-level mip chain for ${width}x${height}`,
    );
  }
}

function normalizeLayer(value, position) {
  const path = `layers[${position}]`;
  const layer = exactKeys(
    value,
    [
      'index', 'semantic', 'terrainLayerName', 'arrayIndex',
      'metresPerRepeat', 'normalStrength', 'ormStrength',
    ],
    [],
    path,
  );
  const expected = CUSTOMS_TERRAIN_SEMANTIC_LAYERS[position];
  const index = safeInteger(layer.index, `${path}.index`, 0, CUSTOMS_TERRAIN_LAYER_COUNT - 1);
  if (index !== position) {
    fail('ERR_TERRAIN_MATERIAL_ORDER', `${path}.index`, `must be ${position} in terrain manifest order`);
  }
  if (layer.semantic !== expected.semantic) {
    fail(
      'ERR_TERRAIN_MATERIAL_ORDER',
      `${path}.semantic`,
      `must be ${expected.semantic} at terrain layer ${position}`,
    );
  }
  if (layer.terrainLayerName !== expected.terrainLayerName) {
    fail(
      'ERR_TERRAIN_MATERIAL_ORDER',
      `${path}.terrainLayerName`,
      `must be ${expected.terrainLayerName}`,
    );
  }
  const arrayIndex = safeInteger(
    layer.arrayIndex,
    `${path}.arrayIndex`,
    0,
    CUSTOMS_TERRAIN_LAYER_COUNT - 1,
  );
  if (arrayIndex !== index) {
    fail('ERR_TERRAIN_MATERIAL_ARRAY_INDEX', `${path}.arrayIndex`, `must equal layer index ${index}`);
  }
  return {
    index,
    semantic: expected.semantic,
    terrainLayerName: expected.terrainLayerName,
    arrayIndex,
    metresPerRepeat: finiteInRange(
      layer.metresPerRepeat,
      `${path}.metresPerRepeat`,
      0.05,
      MAX_REPEAT_METRES,
    ),
    normalStrength: finiteInRange(layer.normalStrength, `${path}.normalStrength`, 0, 4),
    ormStrength: finiteInRange(layer.ormStrength, `${path}.ormStrength`, 0, 2),
  };
}

function normalizeArrayDescriptor(value, position) {
  const path = `arrays[${position}]`;
  const baseRequired = [
    'kind', 'role', 'url', 'width', 'height', 'slices', 'mipLevels',
    'colorSpace', 'sha256', 'receipts',
  ];
  const roleCandidate = isPlainObject(value) ? value.role : undefined;
  const roleSpecific = roleCandidate === 'normal'
    ? ['normalSpace']
    : roleCandidate === 'orm'
      ? ['channels']
      : [];
  const descriptor = exactKeys(value, [...baseRequired, ...roleSpecific], [], path);
  if (!ARRAY_ROLES.includes(descriptor.role)) {
    fail('ERR_TERRAIN_MATERIAL_SCHEMA', `${path}.role`, `must be one of ${ARRAY_ROLES.join(', ')}`);
  }
  if (descriptor.kind !== 'ktx2-array') {
    fail('ERR_TERRAIN_MATERIAL_SCHEMA', `${path}.kind`, 'must be ktx2-array');
  }
  const width = textureDimension(descriptor.width, `${path}.width`);
  const height = textureDimension(descriptor.height, `${path}.height`);
  const slices = safeInteger(descriptor.slices, `${path}.slices`, 1, CUSTOMS_TERRAIN_LAYER_COUNT);
  if (slices !== CUSTOMS_TERRAIN_LAYER_COUNT) {
    fail(
      'ERR_TERRAIN_MATERIAL_SLICES',
      `${path}.slices`,
      `must contain exactly ${CUSTOMS_TERRAIN_LAYER_COUNT} slices`,
    );
  }
  const mipLevels = safeInteger(descriptor.mipLevels, `${path}.mipLevels`, 1, 32);
  assertFullMipChain(mipLevels, width, height, `${path}.mipLevels`);
  const expectedColorSpace = descriptor.role === 'albedo' ? 'srgb' : 'linear';
  if (descriptor.colorSpace !== expectedColorSpace) {
    fail(
      'ERR_TERRAIN_MATERIAL_COLOR_SPACE',
      `${path}.colorSpace`,
      `${descriptor.role} must use ${expectedColorSpace}`,
    );
  }
  const normalized = {
    kind: 'ktx2-array',
    role: descriptor.role,
    url: safeAuthoredUrl(descriptor.url, `${path}.url`, '.ktx2'),
    width,
    height,
    slices,
    mipLevels,
    colorSpace: expectedColorSpace,
    sha256: sha256(descriptor.sha256, `${path}.sha256`),
    receipts: normalizeReceipts(descriptor.receipts, `${path}.receipts`),
  };
  if (descriptor.role === 'normal') {
    if (descriptor.normalSpace !== 'tangent') {
      fail('ERR_TERRAIN_MATERIAL_NORMAL_SPACE', `${path}.normalSpace`, 'must be tangent');
    }
    normalized.normalSpace = 'tangent';
  }
  if (descriptor.role === 'orm') {
    if (
      !Array.isArray(descriptor.channels)
      || descriptor.channels.length !== ORM_CHANNELS.length
      || ORM_CHANNELS.some((channel, index) => descriptor.channels[index] !== channel)
    ) {
      fail(
        'ERR_TERRAIN_MATERIAL_CHANNELS',
        `${path}.channels`,
        'must be [occlusion, roughness, metallic, unused]',
      );
    }
    normalized.channels = [...ORM_CHANNELS];
  }
  return normalized;
}

function normalizeArrays(value) {
  if (!Array.isArray(value) || value.length !== ARRAY_ROLES.length) {
    fail('ERR_TERRAIN_MATERIAL_MISSING', 'arrays', 'must contain albedo, normal, and ORM KTX2 arrays');
  }
  const descriptors = value.map(normalizeArrayDescriptor);
  const byRole = new Map();
  const assetUrls = new Set();
  for (let index = 0; index < descriptors.length; index += 1) {
    const descriptor = descriptors[index];
    if (byRole.has(descriptor.role)) {
      fail('ERR_TERRAIN_MATERIAL_DUPLICATE', `arrays[${index}].role`, `duplicates ${descriptor.role}`);
    }
    if (assetUrls.has(descriptor.url)) {
      fail('ERR_TERRAIN_MATERIAL_DUPLICATE', `arrays[${index}].url`, `duplicates ${descriptor.url}`);
    }
    byRole.set(descriptor.role, descriptor);
    assetUrls.add(descriptor.url);
  }
  for (const role of ARRAY_ROLES) {
    if (!byRole.has(role)) fail('ERR_TERRAIN_MATERIAL_MISSING', 'arrays', `is missing ${role}`);
  }
  const canonical = ARRAY_ROLES.map((role) => byRole.get(role));
  const reference = canonical[0];
  for (let index = 1; index < canonical.length; index += 1) {
    const descriptor = canonical[index];
    if (descriptor.width !== reference.width || descriptor.height !== reference.height) {
      fail(
        'ERR_TERRAIN_MATERIAL_DIMENSIONS',
        `arrays.${descriptor.role}`,
        `must match the albedo ${reference.width}x${reference.height} dimensions`,
      );
    }
    if (descriptor.mipLevels !== reference.mipLevels) {
      fail(
        'ERR_TERRAIN_MATERIAL_MIPS',
        `arrays.${descriptor.role}`,
        `must match the albedo ${reference.mipLevels}-level mip chain`,
      );
    }
  }
  return { arrays: canonical, assetUrls };
}

function normalizeMacro(value) {
  const path = 'macro';
  const macro = exactKeys(
    value,
    [
      'kind', 'role', 'url', 'width', 'height', 'mipLevels', 'colorSpace',
      'metresPerRepeat', 'strength', 'sha256', 'receipts',
    ],
    [],
    path,
  );
  if (macro.kind !== 'ktx2-2d') fail('ERR_TERRAIN_MATERIAL_SCHEMA', `${path}.kind`, 'must be ktx2-2d');
  if (macro.role !== 'macro-albedo') {
    fail('ERR_TERRAIN_MATERIAL_SCHEMA', `${path}.role`, 'must be macro-albedo');
  }
  const width = textureDimension(macro.width, `${path}.width`);
  const height = textureDimension(macro.height, `${path}.height`);
  const mipLevels = safeInteger(macro.mipLevels, `${path}.mipLevels`, 1, 32);
  assertFullMipChain(mipLevels, width, height, `${path}.mipLevels`);
  if (macro.colorSpace !== 'srgb') {
    fail('ERR_TERRAIN_MATERIAL_COLOR_SPACE', `${path}.colorSpace`, 'macro albedo must use srgb');
  }
  return {
    kind: 'ktx2-2d',
    role: 'macro-albedo',
    url: safeAuthoredUrl(macro.url, `${path}.url`, '.ktx2'),
    width,
    height,
    mipLevels,
    colorSpace: 'srgb',
    metresPerRepeat: finiteInRange(
      macro.metresPerRepeat,
      `${path}.metresPerRepeat`,
      1,
      4096,
    ),
    strength: finiteInRange(macro.strength, `${path}.strength`, 0, 1),
    sha256: sha256(macro.sha256, `${path}.sha256`),
    receipts: normalizeReceipts(macro.receipts, `${path}.receipts`),
  };
}

/** Validate and deeply freeze an original-authored Customs material-set v1. */
export function validateCustomsTerrainMaterialSet(value) {
  const root = exactKeys(
    value,
    ['schemaVersion', 'map', 'delivery', 'layers', 'arrays', 'macro'],
    [],
    'materialSet',
  );
  if (root.schemaVersion !== CUSTOMS_TERRAIN_MATERIAL_SET_VERSION) {
    fail(
      'ERR_TERRAIN_MATERIAL_SCHEMA',
      'materialSet.schemaVersion',
      `must be ${CUSTOMS_TERRAIN_MATERIAL_SET_VERSION}`,
    );
  }
  if (root.map !== CUSTOMS_TERRAIN_MATERIAL_MAP) {
    fail('ERR_TERRAIN_MATERIAL_SCHEMA', 'materialSet.map', `must be ${CUSTOMS_TERRAIN_MATERIAL_MAP}`);
  }
  if (root.delivery !== CUSTOMS_TERRAIN_MATERIAL_DELIVERY) {
    fail(
      'ERR_TERRAIN_MATERIAL_SOURCE_MIX',
      'materialSet.delivery',
      `must be ${CUSTOMS_TERRAIN_MATERIAL_DELIVERY}; local truth has a separate contract`,
    );
  }
  if (!Array.isArray(root.layers) || root.layers.length !== CUSTOMS_TERRAIN_LAYER_COUNT) {
    fail(
      'ERR_TERRAIN_MATERIAL_MISSING',
      'materialSet.layers',
      `must contain exactly ${CUSTOMS_TERRAIN_LAYER_COUNT} semantic layers`,
    );
  }
  const layers = root.layers.map(normalizeLayer);
  const layerIndexes = new Set(layers.map(({ index }) => index));
  const arrayIndexes = new Set(layers.map(({ arrayIndex }) => arrayIndex));
  if (layerIndexes.size !== CUSTOMS_TERRAIN_LAYER_COUNT || arrayIndexes.size !== CUSTOMS_TERRAIN_LAYER_COUNT) {
    fail('ERR_TERRAIN_MATERIAL_DUPLICATE', 'materialSet.layers', 'contains duplicate layer or array indexes');
  }
  const normalizedArrays = normalizeArrays(root.arrays);
  const macro = normalizeMacro(root.macro);
  if (normalizedArrays.assetUrls.has(macro.url)) {
    fail('ERR_TERRAIN_MATERIAL_DUPLICATE', 'materialSet.macro.url', 'duplicates a material array URL');
  }
  return deepFreeze({
    schemaVersion: CUSTOMS_TERRAIN_MATERIAL_SET_VERSION,
    map: CUSTOMS_TERRAIN_MATERIAL_MAP,
    delivery: CUSTOMS_TERRAIN_MATERIAL_DELIVERY,
    semanticLayerOrder: CUSTOMS_TERRAIN_SEMANTIC_LAYERS.map(({ semantic }) => semantic),
    layers,
    arrays: normalizedArrays.arrays,
    macro,
  });
}
