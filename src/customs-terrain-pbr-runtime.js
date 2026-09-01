// Runtime binding for the original-authored Customs terrain material set.
//
// The local terrain extractor owns geometry/elevation truth. This module only
// shades that already-seated geometry: it never moves vertices, changes the
// fixed 2x relief, or enables fog. Three's node material is compiled by either
// WebGPU or the WebGL 2 backend selected by WebGPURenderer.

import * as THREE from 'three/webgpu';
import {
  float,
  normalMap,
  positionWorld,
  texture,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import {
  CUSTOMS_TERRAIN_AUTHORED_ASSET_ROOT,
  CUSTOMS_TERRAIN_LAYER_COUNT,
  validateCustomsTerrainMaterialSet,
} from './customs-terrain-material-contract.js';
import {
  CUSTOMS_TERRAIN_CONTROL_ATLAS_COUNT,
  CUSTOMS_TERRAIN_CONTROL_ATLAS_FORMAT,
  CUSTOMS_TERRAIN_CONTROL_ATLAS_LIMITS,
  CUSTOMS_TERRAIN_CONTROL_ATLAS_VERSION,
} from './customs-terrain-control-atlas.js';

export const CUSTOMS_TERRAIN_PBR_RUNTIME_VERSION = 1;
export const CUSTOMS_TERRAIN_PBR_FIXED_RELIEF = 2;
export const CUSTOMS_TERRAIN_PBR_MAX_KTX2_BYTES = 512 * 1024 * 1024;
export const CUSTOMS_TERRAIN_PBR_MAX_MATERIAL_SET_BYTES = 256 * 1024;
export const CUSTOMS_TERRAIN_PBR_DEFAULT_TRANSCODER_PATH = '/assets/3d/vendor/basis/';
export const CUSTOMS_TERRAIN_PBR_MATERIAL_SET_URL =
  `${CUSTOMS_TERRAIN_AUTHORED_ASSET_ROOT}material-set.json`;

const CONTROL_CHANNEL_NAMES = Object.freeze(['r', 'g', 'b', 'a']);
const ARRAY_ROLES = Object.freeze(['albedo', 'normal', 'orm']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_URL_CHARS = /^[A-Za-z0-9._/-]+$/;
const MACRO_MID_GREY_LINEAR = 0.21404114048223255;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value) && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const CUSTOMS_TERRAIN_PBR_SHADER_CONTRACT = deepFreeze({
  version: CUSTOMS_TERRAIN_PBR_RUNTIME_VERSION,
  backend: 'three-tsl-webgpu-or-webgl2',
  threeRevision: '185',
  fixedRelief: CUSTOMS_TERRAIN_PBR_FIXED_RELIEF,
  fog: false,
  geometryDisplacement: false,
  materialSetUrl: CUSTOMS_TERRAIN_PBR_MATERIAL_SET_URL,
  controlFormat: CUSTOMS_TERRAIN_CONTROL_ATLAS_FORMAT,
  controlWeightPolicy: 'rgba0-rgba1-rgba2-linear-sum-normalized',
  controlSamplePolicy: 'per-tile-texel-centres-no-cross-tile-bilinear-bleed',
  zeroWeightFallbackLayer: 1,
  horizontalUvFrame: 'negated-positionWorld.xy-equals-canonical-game-xz-metres',
  layerWeights: Array.from({ length: CUSTOMS_TERRAIN_LAYER_COUNT }, (_, layerIndex) => ({
    layerIndex,
    controlAtlasSlot: Math.floor(layerIndex / CONTROL_CHANNEL_NAMES.length),
    channel: CONTROL_CHANNEL_NAMES[layerIndex % CONTROL_CHANNEL_NAMES.length],
  })),
  arrayRoleOrder: [...ARRAY_ROLES],
  normalBlend: 'unpack-tangent-strength-weight-sum-normalize-repack-normalMap',
  ormChannels: ['occlusion', 'roughness', 'metallic', 'unused'],
  macroBlend: 'linear-srgb-sample-relative-to-srgb-mid-grey-then-strength',
});

export class CustomsTerrainPbrRuntimeError extends Error {
  constructor(code, path, message, options = undefined) {
    super(path ? `${path}: ${message}` : message, options);
    this.name = 'CustomsTerrainPbrRuntimeError';
    this.code = code;
    this.path = path;
  }
}

function fail(code, path, message, cause = undefined) {
  const options = cause === undefined ? undefined : { cause };
  throw new CustomsTerrainPbrRuntimeError(code, path, message, options);
}

function finiteNumber(value, path, minimum = -Infinity, maximum = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail('ERR_TERRAIN_PBR_RANGE', path, `must be a finite number from ${minimum} through ${maximum}`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function safeInteger(value, path, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('ERR_TERRAIN_PBR_RANGE', path, `must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function safeBaseUrl(value) {
  let base;
  try {
    base = new URL(value);
  } catch (error) {
    fail('ERR_TERRAIN_PBR_UNSAFE_URL', 'baseHref', 'must be an absolute HTTP(S) URL', error);
  }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
    fail('ERR_TERRAIN_PBR_UNSAFE_URL', 'baseHref', 'must be an uncredentialed HTTP(S) URL');
  }
  return base;
}

/** Resolve one validated authored URL without allowing origin or path escape. */
export function resolveCustomsTerrainPbrUrl(value, baseHref) {
  if (
    typeof value !== 'string'
    || value.length > 512
    || !value.startsWith(CUSTOMS_TERRAIN_AUTHORED_ASSET_ROOT)
    || !SAFE_URL_CHARS.test(value)
    || value.includes('\\')
    || value.includes('%')
    || value.includes('?')
    || value.includes('#')
  ) {
    fail(
      'ERR_TERRAIN_PBR_UNSAFE_URL',
      'url',
      `must be a literal same-origin path below ${CUSTOMS_TERRAIN_AUTHORED_ASSET_ROOT}`,
    );
  }
  const segments = value.split('/');
  if (segments.some((segment, index) => index > 0 && (segment === '' || segment === '.' || segment === '..'))) {
    fail('ERR_TERRAIN_PBR_UNSAFE_URL', 'url', 'must not contain empty or traversal segments');
  }
  const base = safeBaseUrl(baseHref);
  const resolved = new URL(value, base);
  if (
    resolved.origin !== base.origin
    || resolved.pathname !== value
    || resolved.search
    || resolved.hash
    || !resolved.pathname.startsWith(CUSTOMS_TERRAIN_AUTHORED_ASSET_ROOT)
  ) {
    fail('ERR_TERRAIN_PBR_UNSAFE_URL', 'url', 'escaped the authored same-origin asset root');
  }
  return resolved.href;
}

async function browserSha256(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) fail('ERR_TERRAIN_PBR_CRYPTO', 'crypto.subtle', 'Web Crypto SHA-256 is unavailable');
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function requestOptions(signal) {
  return {
    method: 'GET',
    mode: 'same-origin',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal,
  };
}

function contentLength(response, path, maximum) {
  const raw = response.headers?.get?.('content-length');
  if (raw === null || raw === undefined || raw === '') return null;
  if (!/^[0-9]+$/.test(raw)) {
    fail('ERR_TERRAIN_PBR_BYTES', path, 'content-length must be a non-negative integer');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    fail('ERR_TERRAIN_PBR_BYTES', path, `content-length exceeds the ${maximum}-byte limit`);
  }
  return value;
}

/** Fetch and validate the canonical live original-authored material-set document. */
export async function loadCustomsTerrainPbrMaterialSet({
  url = CUSTOMS_TERRAIN_PBR_MATERIAL_SET_URL,
  baseHref,
  fetchImpl = globalThis.fetch,
  signal = null,
} = {}) {
  if (typeof url !== 'string' || !url.toLowerCase().endsWith('.json')) {
    fail('ERR_TERRAIN_PBR_DESCRIPTOR', 'materialSetUrl', 'must name a JSON document');
  }
  if (typeof fetchImpl !== 'function') fail('ERR_TERRAIN_PBR_FETCH', 'fetchImpl', 'fetch is unavailable');
  const resolvedUrl = resolveCustomsTerrainPbrUrl(url, baseHref);
  let response;
  try {
    response = await fetchImpl(resolvedUrl, requestOptions(signal));
  } catch (error) {
    fail('ERR_TERRAIN_PBR_HTTP', 'materialSet', 'material-set request failed', error);
  }
  if (!response?.ok) {
    fail('ERR_TERRAIN_PBR_HTTP', 'materialSet', `material-set HTTP ${response?.status ?? 'failure'}`);
  }
  const declaredLength = contentLength(
    response,
    'materialSet',
    CUSTOMS_TERRAIN_PBR_MAX_MATERIAL_SET_BYTES,
  );
  if (typeof response.text !== 'function') {
    fail('ERR_TERRAIN_PBR_BYTES', 'materialSet', 'response cannot be read as text');
  }
  let source;
  try {
    source = await response.text();
  } catch (error) {
    fail('ERR_TERRAIN_PBR_BYTES', 'materialSet', 'could not read the material-set document', error);
  }
  const sourceBytes = new TextEncoder().encode(source).byteLength;
  if (sourceBytes < 1 || sourceBytes > CUSTOMS_TERRAIN_PBR_MAX_MATERIAL_SET_BYTES) {
    fail(
      'ERR_TERRAIN_PBR_BYTES',
      'materialSet',
      `document must contain 1 through ${CUSTOMS_TERRAIN_PBR_MAX_MATERIAL_SET_BYTES} bytes`,
    );
  }
  const contentEncoding = response.headers?.get?.('content-encoding');
  if (
    declaredLength !== null
    && (!contentEncoding || contentEncoding === 'identity')
    && declaredLength !== sourceBytes
  ) {
    fail(
      'ERR_TERRAIN_PBR_BYTES',
      'materialSet',
      `content-length ${declaredLength} does not match received ${sourceBytes}`,
    );
  }
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    fail('ERR_TERRAIN_PBR_DESCRIPTOR', 'materialSet', 'is not valid JSON', error);
  }
  return validateCustomsTerrainMaterialSet(value);
}

function validateDescriptorForLoad(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') {
    fail('ERR_TERRAIN_PBR_DESCRIPTOR', 'descriptor', 'must be a validated texture descriptor');
  }
  if (!SHA256_PATTERN.test(descriptor.sha256 ?? '')) {
    fail('ERR_TERRAIN_PBR_DESCRIPTOR', 'descriptor.sha256', 'must be a lowercase SHA-256 digest');
  }
  if (!['ktx2-array', 'ktx2-2d'].includes(descriptor.kind)) {
    fail('ERR_TERRAIN_PBR_DESCRIPTOR', 'descriptor.kind', 'must be ktx2-array or ktx2-2d');
  }
  if (typeof descriptor.url !== 'string' || !descriptor.url.toLowerCase().endsWith('.ktx2')) {
    fail('ERR_TERRAIN_PBR_DESCRIPTOR', 'descriptor.url', 'must name a KTX2 asset');
  }
}

/** Fetch, hash, and only then parse one KTX2 artifact. */
export async function loadVerifiedCustomsTerrainKtx2({
  descriptor,
  baseHref,
  fetchImpl = globalThis.fetch,
  digestImpl = browserSha256,
  parse,
  signal = null,
  maxBytes = CUSTOMS_TERRAIN_PBR_MAX_KTX2_BYTES,
} = {}) {
  validateDescriptorForLoad(descriptor);
  if (typeof fetchImpl !== 'function') fail('ERR_TERRAIN_PBR_FETCH', 'fetchImpl', 'fetch is unavailable');
  if (typeof digestImpl !== 'function') fail('ERR_TERRAIN_PBR_CRYPTO', 'digestImpl', 'must be a function');
  if (typeof parse !== 'function') fail('ERR_TERRAIN_PBR_PARSE', 'parse', 'must be a function');
  safeInteger(maxBytes, 'maxBytes', 1, CUSTOMS_TERRAIN_PBR_MAX_KTX2_BYTES);

  const resolvedUrl = resolveCustomsTerrainPbrUrl(descriptor.url, baseHref);
  let response;
  try {
    response = await fetchImpl(resolvedUrl, requestOptions(signal));
  } catch (error) {
    fail('ERR_TERRAIN_PBR_HTTP', descriptor.role, 'KTX2 request failed', error);
  }
  if (!response?.ok) {
    fail('ERR_TERRAIN_PBR_HTTP', descriptor.role, `KTX2 HTTP ${response?.status ?? 'failure'}`);
  }

  const declaredLength = contentLength(response, descriptor.role, maxBytes);

  let bytes;
  try {
    bytes = await response.arrayBuffer();
  } catch (error) {
    fail('ERR_TERRAIN_PBR_BYTES', descriptor.role, 'could not read KTX2 bytes', error);
  }
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 1 || bytes.byteLength > maxBytes) {
    fail('ERR_TERRAIN_PBR_BYTES', descriptor.role, `KTX2 must contain 1 through ${maxBytes} bytes`);
  }
  const contentEncoding = response.headers?.get?.('content-encoding');
  if (
    declaredLength !== null
    && (!contentEncoding || contentEncoding === 'identity')
    && declaredLength !== bytes.byteLength
  ) {
    fail(
      'ERR_TERRAIN_PBR_BYTES',
      descriptor.role,
      `content-length ${declaredLength} does not match received ${bytes.byteLength}`,
    );
  }

  let digest;
  try {
    digest = await digestImpl(bytes);
  } catch (error) {
    fail('ERR_TERRAIN_PBR_CRYPTO', descriptor.role, 'SHA-256 calculation failed', error);
  }
  if (!SHA256_PATTERN.test(digest ?? '') || digest !== descriptor.sha256) {
    fail('ERR_TERRAIN_PBR_HASH', descriptor.role, 'KTX2 SHA-256 does not match the material-set receipt');
  }

  try {
    return await parse(bytes, descriptor, resolvedUrl);
  } catch (error) {
    fail('ERR_TERRAIN_PBR_PARSE', descriptor.role, 'verified KTX2 parsing failed', error);
  }
}

function controlSampleChannels(sample, path) {
  const channels = Array.isArray(sample)
    ? sample
    : [sample?.r, sample?.g, sample?.b, sample?.a];
  if (channels.length !== CONTROL_CHANNEL_NAMES.length) {
    fail('ERR_TERRAIN_PBR_CONTROL', path, 'must contain exactly RGBA channels');
  }
  return channels.map((value, channel) => finiteNumber(value, `${path}.${CONTROL_CHANNEL_NAMES[channel]}`, 0, 1));
}

/** Decode the canonical three RGBA controls without rounding or dominance reduction. */
export function decodeCustomsTerrainControlWeights(controlSamples) {
  if (!Array.isArray(controlSamples) || controlSamples.length !== CUSTOMS_TERRAIN_CONTROL_ATLAS_COUNT) {
    fail('ERR_TERRAIN_PBR_CONTROL', 'controlSamples', 'must contain exactly three RGBA samples');
  }
  return controlSamples.flatMap((sample, index) => controlSampleChannels(sample, `controlSamples[${index}]`));
}

/** Normalize all 12 weights linearly; an empty texel retains the established ground fallback. */
export function normalizeCustomsTerrainControlWeights(weights) {
  if (!Array.isArray(weights) || weights.length !== CUSTOMS_TERRAIN_LAYER_COUNT) {
    fail('ERR_TERRAIN_PBR_CONTROL', 'weights', `must contain exactly ${CUSTOMS_TERRAIN_LAYER_COUNT} values`);
  }
  const normalizedInput = weights.map((value, index) => finiteNumber(value, `weights[${index}]`, 0, 1));
  const total = normalizedInput.reduce((sum, value) => sum + value, 0);
  if (total === 0) {
    return Object.freeze([0, 1, ...Array(CUSTOMS_TERRAIN_LAYER_COUNT - 2).fill(0)]);
  }
  return Object.freeze(normalizedInput.map((value) => value / total));
}

function validateVector2(value, path) {
  if (!value || typeof value !== 'object') fail('ERR_TERRAIN_PBR_ATLAS', path, 'must be an object');
  return {
    u: finiteNumber(value.u, `${path}.u`, 0, 1),
    v: finiteNumber(value.v, `${path}.v`, 0, 1),
  };
}

function validatePixelRect(value, path, atlasWidth, atlasHeight) {
  if (!value || typeof value !== 'object') fail('ERR_TERRAIN_PBR_ATLAS', path, 'must be an object');
  const rect = {
    x: safeInteger(value.x, `${path}.x`, 0, atlasWidth - 1),
    y: safeInteger(value.y, `${path}.y`, 0, atlasHeight - 1),
    width: safeInteger(value.width, `${path}.width`, 1, atlasWidth),
    height: safeInteger(value.height, `${path}.height`, 1, atlasHeight),
  };
  if (rect.x + rect.width > atlasWidth || rect.y + rect.height > atlasHeight) {
    fail('ERR_TERRAIN_PBR_ATLAS', path, 'must remain inside the control atlas');
  }
  return rect;
}

function closeUnit(left, right) {
  return Math.abs(left - right) <= 1e-12;
}

/** Validate the immutable output of buildCustomsTerrainControlAtlases(). */
export function validateCustomsTerrainPbrControlAtlasSet(value) {
  if (!value || typeof value !== 'object') fail('ERR_TERRAIN_PBR_ATLAS', 'controlAtlasSet', 'must be an object');
  if (value.schemaVersion !== CUSTOMS_TERRAIN_CONTROL_ATLAS_VERSION) {
    fail('ERR_TERRAIN_PBR_ATLAS', 'controlAtlasSet.schemaVersion', `must be ${CUSTOMS_TERRAIN_CONTROL_ATLAS_VERSION}`);
  }
  if (value.format !== CUSTOMS_TERRAIN_CONTROL_ATLAS_FORMAT) {
    fail('ERR_TERRAIN_PBR_ATLAS', 'controlAtlasSet.format', `must be ${CUSTOMS_TERRAIN_CONTROL_ATLAS_FORMAT}`);
  }
  const width = safeInteger(
    value.width,
    'controlAtlasSet.width',
    1,
    CUSTOMS_TERRAIN_CONTROL_ATLAS_LIMITS.maxAtlasDimension,
  );
  const height = safeInteger(
    value.height,
    'controlAtlasSet.height',
    1,
    CUSTOMS_TERRAIN_CONTROL_ATLAS_LIMITS.maxAtlasDimension,
  );
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount > CUSTOMS_TERRAIN_CONTROL_ATLAS_LIMITS.maxAtlasPixels) {
    fail('ERR_TERRAIN_PBR_ATLAS', 'controlAtlasSet', 'pixel count exceeds the control-atlas limit');
  }
  const expectedBytes = pixelCount * CONTROL_CHANNEL_NAMES.length;
  if (!Array.isArray(value.atlases) || value.atlases.length !== CUSTOMS_TERRAIN_CONTROL_ATLAS_COUNT) {
    fail('ERR_TERRAIN_PBR_ATLAS', 'controlAtlasSet.atlases', 'must contain exactly three atlases');
  }
  const atlases = value.atlases.map((atlas, index) => {
    const path = `controlAtlasSet.atlases[${index}]`;
    if (!atlas || typeof atlas !== 'object') fail('ERR_TERRAIN_PBR_ATLAS', path, 'must be an object');
    if (atlas.slot !== index) fail('ERR_TERRAIN_PBR_ATLAS', `${path}.slot`, `must be canonical slot ${index}`);
    if (atlas.width !== width || atlas.height !== height || atlas.format !== CUSTOMS_TERRAIN_CONTROL_ATLAS_FORMAT) {
      fail('ERR_TERRAIN_PBR_ATLAS', path, `must be ${width}x${height} ${CUSTOMS_TERRAIN_CONTROL_ATLAS_FORMAT}`);
    }
    if (!(atlas.bytes instanceof Uint8Array) || atlas.bytes.byteLength !== expectedBytes) {
      fail('ERR_TERRAIN_PBR_ATLAS', `${path}.bytes`, `must contain exactly ${expectedBytes} Uint8 bytes`);
    }
    return {
      slot: atlas.slot,
      width: atlas.width,
      height: atlas.height,
      format: atlas.format,
      bytes: atlas.bytes,
    };
  });
  if (!Array.isArray(value.tiles) || value.tiles.length < 1) {
    fail('ERR_TERRAIN_PBR_ATLAS', 'controlAtlasSet.tiles', 'must contain at least one tile');
  }
  const ids = new Set();
  const tiles = value.tiles.map((tile, index) => {
    const path = `controlAtlasSet.tiles[${index}]`;
    if (!tile || typeof tile !== 'object' || typeof tile.id !== 'string' || tile.id.length < 1) {
      fail('ERR_TERRAIN_PBR_ATLAS', `${path}.id`, 'must be a non-empty tile ID');
    }
    if (ids.has(tile.id)) fail('ERR_TERRAIN_PBR_ATLAS', `${path}.id`, `duplicates ${tile.id}`);
    ids.add(tile.id);
    const scale = validateVector2(tile.uv?.scale, `${path}.uv.scale`);
    const offset = validateVector2(tile.uv?.offset, `${path}.uv.offset`);
    if (scale.u <= 0 || scale.v <= 0 || offset.u + scale.u > 1 || offset.v + scale.v > 1) {
      fail('ERR_TERRAIN_PBR_ATLAS', `${path}.uv`, 'must define a positive transform inside the atlas');
    }
    const pixelRect = validatePixelRect(tile.pixelRect, `${path}.pixelRect`, width, height);
    const expectedScale = { u: pixelRect.width / width, v: pixelRect.height / height };
    const expectedOffset = { u: pixelRect.x / width, v: pixelRect.y / height };
    if (
      !closeUnit(scale.u, expectedScale.u)
      || !closeUnit(scale.v, expectedScale.v)
      || !closeUnit(offset.u, expectedOffset.u)
      || !closeUnit(offset.v, expectedOffset.v)
    ) {
      fail('ERR_TERRAIN_PBR_ATLAS', `${path}.uv`, 'must match the declared pixel rectangle exactly');
    }
    // uv0 spans terrain vertices from 0 through 1, while RGBA controls are texels.
    // Sampling the full pixel rectangle would put the end vertices on texel edges and
    // bilinearly bleed into the neighbouring tile. Inset to first/last texel centres.
    const sampleUv = {
      scale: {
        u: (pixelRect.width - 1) / width,
        v: (pixelRect.height - 1) / height,
      },
      offset: {
        u: (pixelRect.x + 0.5) / width,
        v: (pixelRect.y + 0.5) / height,
      },
    };
    return deepFreeze({ id: tile.id, uv: { scale, offset }, pixelRect, sampleUv });
  });
  return deepFreeze({ width, height, atlases: [...atlases], tiles });
}

function disposeBestEffort(value) {
  try {
    value?.dispose?.();
  } catch {
    // Teardown should continue through the remaining resources.
  }
}

function expectedMipLevels(descriptor) {
  return Math.floor(Math.log2(Math.max(descriptor.width, descriptor.height))) + 1;
}

function configureAndValidateKtx2Texture(textureValue, descriptor, anisotropy) {
  const path = descriptor.role;
  if (!textureValue?.isTexture) fail('ERR_TERRAIN_PBR_TEXTURE', path, 'parser did not return a Three texture');
  const isArray = descriptor.kind === 'ktx2-array';
  if (isArray && textureValue.isCompressedArrayTexture !== true) {
    fail('ERR_TERRAIN_PBR_TEXTURE', path, 'must decode to a CompressedArrayTexture');
  }
  if (!isArray && (textureValue.isCompressedTexture !== true || textureValue.isCompressedArrayTexture === true)) {
    fail('ERR_TERRAIN_PBR_TEXTURE', path, 'must decode to a 2D CompressedTexture');
  }
  if (textureValue.image?.width !== descriptor.width || textureValue.image?.height !== descriptor.height) {
    fail(
      'ERR_TERRAIN_PBR_TEXTURE',
      path,
      `decoded dimensions must be ${descriptor.width}x${descriptor.height}`,
    );
  }
  if (isArray && textureValue.image?.depth !== descriptor.slices) {
    fail('ERR_TERRAIN_PBR_TEXTURE', path, `decoded array depth must be ${descriptor.slices}`);
  }
  const mipLevels = Array.isArray(textureValue.mipmaps) ? textureValue.mipmaps.length : 0;
  if (mipLevels !== descriptor.mipLevels || mipLevels !== expectedMipLevels(descriptor)) {
    fail('ERR_TERRAIN_PBR_TEXTURE', path, `decoded texture must expose ${descriptor.mipLevels} mip levels`);
  }
  if (descriptor.colorSpace === 'srgb' && textureValue.colorSpace !== THREE.SRGBColorSpace) {
    fail('ERR_TERRAIN_PBR_TEXTURE', path, 'decoded KTX2 color space must be sRGB');
  }
  if (
    descriptor.colorSpace === 'linear'
    && ![THREE.NoColorSpace, THREE.LinearSRGBColorSpace].includes(textureValue.colorSpace)
  ) {
    fail('ERR_TERRAIN_PBR_TEXTURE', path, 'decoded KTX2 color space must be linear data');
  }
  textureValue.colorSpace = descriptor.colorSpace === 'srgb' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  textureValue.wrapS = THREE.RepeatWrapping;
  textureValue.wrapT = THREE.RepeatWrapping;
  textureValue.anisotropy = anisotropy;
  textureValue.generateMipmaps = false;
  textureValue.minFilter = THREE.LinearMipmapLinearFilter;
  textureValue.magFilter = THREE.LinearFilter;
  textureValue.name = `customs-terrain-${descriptor.role}`;
  textureValue.needsUpdate = true;
  return textureValue;
}

function createControlTextures(controlAtlas) {
  return controlAtlas.atlases.map((atlas) => {
    const value = new THREE.DataTexture(
      atlas.bytes,
      controlAtlas.width,
      controlAtlas.height,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    );
    value.name = `customs-terrain-control-${atlas.slot}`;
    value.colorSpace = THREE.NoColorSpace;
    value.wrapS = THREE.ClampToEdgeWrapping;
    value.wrapT = THREE.ClampToEdgeWrapping;
    value.minFilter = THREE.LinearFilter;
    value.magFilter = THREE.LinearFilter;
    value.generateMipmaps = false;
    value.flipY = false;
    value.unpackAlignment = 1;
    value.needsUpdate = true;
    return value;
  });
}

function ktx2ParsePromise(loader, bytes) {
  return new Promise((resolve, reject) => loader.parse(bytes, resolve, reject));
}

async function createKtx2Parser({ renderer, parseKtx2, ktx2Loader, transcoderPath }) {
  if (typeof parseKtx2 === 'function') {
    return { parse: parseKtx2, loader: null, ownsLoader: false };
  }
  if (!renderer) fail('ERR_TERRAIN_PBR_RENDERER', 'renderer', 'is required to select KTX2 GPU formats');
  let loader = ktx2Loader;
  let ownsLoader = false;
  if (!loader) {
    const { KTX2Loader } = await import('three/addons/loaders/KTX2Loader.js');
    loader = new KTX2Loader();
    ownsLoader = true;
  }
  if (typeof loader?.parse !== 'function' || typeof loader?.detectSupport !== 'function') {
    if (ownsLoader) disposeBestEffort(loader);
    fail('ERR_TERRAIN_PBR_PARSE', 'ktx2Loader', 'must expose detectSupport() and parse()');
  }
  const transcoderSegments = typeof transcoderPath === 'string' ? transcoderPath.split('/') : [];
  if (
    typeof transcoderPath !== 'string'
    || !transcoderPath.startsWith('/')
    || !transcoderPath.endsWith('/')
    || !SAFE_URL_CHARS.test(transcoderPath)
    || transcoderPath.includes('\\')
    || transcoderPath.includes('%')
    || transcoderPath.includes('?')
    || transcoderPath.includes('#')
    || transcoderSegments.some((segment, index) => (
      index > 0
      && index < transcoderSegments.length - 1
      && (segment === '' || segment === '.' || segment === '..')
    ))
  ) {
    if (ownsLoader) disposeBestEffort(loader);
    fail('ERR_TERRAIN_PBR_UNSAFE_URL', 'transcoderPath', 'must be a root-relative path without traversal');
  }
  try {
    loader.setTranscoderPath?.(transcoderPath);
    loader.detectSupport(renderer);
  } catch (error) {
    if (ownsLoader) disposeBestEffort(loader);
    fail('ERR_TERRAIN_PBR_RENDERER', 'renderer', 'KTX2 capability detection failed', error);
  }
  return {
    parse: (bytes) => ktx2ParsePromise(loader, bytes),
    loader,
    ownsLoader,
  };
}

function shaderWeights(controlTextures, tile) {
  const controlUv = uv(0)
    .mul(vec2(tile.sampleUv.scale.u, tile.sampleUv.scale.v))
    .add(vec2(tile.sampleUv.offset.u, tile.sampleUv.offset.v));
  const samples = controlTextures.map((controlTexture) => texture(controlTexture, controlUv));
  const weights = samples.flatMap((sample) => [sample.r, sample.g, sample.b, sample.a]);
  const total = weights.reduce((sum, weight) => sum.add(weight), float(0));
  const empty = total.equal(0);
  const denominator = empty.select(1, total);
  return weights.map((weight, index) => empty.select(index === 1 ? 1 : 0, weight.div(denominator)));
}

function createTerrainMaterial({ materialSet, textures, controlTextures, tile }) {
  const weights = shaderWeights(controlTextures, tile);
  // Terrain presentation mirrors game X/Z into world X/Y. Negation recovers
  // canonical game-space metres and keeps tangent normal orientation aligned
  // with the patch's +X/+Z control UV basis.
  const horizontalMetres = positionWorld.xy.negate();
  let albedo = vec3(0);
  let tangentNormal = vec3(0);
  let occlusion = float(0);
  let roughness = float(0);
  let metallic = float(0);

  for (const layer of materialSet.layers) {
    const weight = weights[layer.index];
    const layerUv = horizontalMetres.div(layer.metresPerRepeat);
    const albedoSample = texture(textures.albedo, layerUv).depth(layer.arrayIndex).rgb;
    const normalSample = texture(textures.normal, layerUv).depth(layer.arrayIndex).rgb;
    const ormSample = texture(textures.orm, layerUv).depth(layer.arrayIndex).rgb;
    const unpackedNormal = normalSample
      .mul(2)
      .sub(1)
      .mul(vec3(layer.normalStrength, layer.normalStrength, 1))
      .normalize();
    const layerAo = float(1).sub(float(1).sub(ormSample.r).mul(layer.ormStrength)).clamp(0, 1);
    const layerRoughness = float(1)
      .sub(float(1).sub(ormSample.g).mul(layer.ormStrength))
      .clamp(0.04, 1);
    const layerMetallic = ormSample.b.mul(layer.ormStrength).clamp(0, 1);

    albedo = albedo.add(albedoSample.mul(weight));
    tangentNormal = tangentNormal.add(unpackedNormal.mul(weight));
    occlusion = occlusion.add(layerAo.mul(weight));
    roughness = roughness.add(layerRoughness.mul(weight));
    metallic = metallic.add(layerMetallic.mul(weight));
  }

  const macroUv = horizontalMetres.div(materialSet.macro.metresPerRepeat);
  const macroSample = texture(textures.macro, macroUv).rgb;
  const macroMultiplier = vec3(1).add(
    macroSample.div(MACRO_MID_GREY_LINEAR).sub(1).mul(materialSet.macro.strength),
  );
  const packedNormal = tangentNormal.normalize().mul(0.5).add(0.5);

  const material = new THREE.MeshStandardNodeMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
  });
  material.name = `customs-terrain-pbr-${tile.id}`;
  material.colorNode = albedo.mul(macroMultiplier).clamp(0, 1);
  material.normalNode = normalMap(packedNormal);
  material.aoNode = occlusion.clamp(0, 1);
  material.roughnessNode = roughness.clamp(0.04, 1);
  material.metalnessNode = metallic.clamp(0, 1);
  material.fog = false;
  material.positionNode = null;
  material.displacementMap = null;
  material.userData.customsTerrainPbr = deepFreeze({
    runtimeVersion: CUSTOMS_TERRAIN_PBR_RUNTIME_VERSION,
    shaderContract: CUSTOMS_TERRAIN_PBR_SHADER_CONTRACT,
    tileId: tile.id,
    controlUv: tile.sampleUv,
    controlPixelRectUv: tile.uv,
    controlPixelRect: tile.pixelRect,
    semanticLayerOrder: [...materialSet.semanticLayerOrder],
    fixedRelief: CUSTOMS_TERRAIN_PBR_FIXED_RELIEF,
    fog: false,
    geometryDisplacement: false,
  });
  return material;
}

/**
 * Load a validated 12-layer material delivery and bind it to exact control atlases.
 * Call `createTileMaterial(tileId)` for each already-built terrain patch and call
 * `dispose()` once when the map view is torn down.
 */
export async function createCustomsTerrainPbrRuntime({
  materialSet: materialSetInput = null,
  materialSetUrl = CUSTOMS_TERRAIN_PBR_MATERIAL_SET_URL,
  controlAtlasSet: controlAtlasSetInput,
  renderer = null,
  baseHref = globalThis.location?.href,
  fetchImpl = globalThis.fetch,
  digestImpl = browserSha256,
  parseKtx2 = null,
  ktx2Loader = null,
  transcoderPath = CUSTOMS_TERRAIN_PBR_DEFAULT_TRANSCODER_PATH,
  signal = null,
  maxTextureBytes = CUSTOMS_TERRAIN_PBR_MAX_KTX2_BYTES,
  anisotropy = 8,
} = {}) {
  safeBaseUrl(baseHref);
  safeInteger(maxTextureBytes, 'maxTextureBytes', 1, CUSTOMS_TERRAIN_PBR_MAX_KTX2_BYTES);
  safeInteger(anisotropy, 'anisotropy', 1, 16);
  const controlAtlas = validateCustomsTerrainPbrControlAtlasSet(controlAtlasSetInput);
  const materialSet = materialSetInput === null || materialSetInput === undefined
    ? await loadCustomsTerrainPbrMaterialSet({
      url: materialSetUrl,
      baseHref,
      fetchImpl,
      signal,
    })
    : validateCustomsTerrainMaterialSet(materialSetInput);

  const parserState = await createKtx2Parser({ renderer, parseKtx2, ktx2Loader, transcoderPath });
  const descriptors = [...materialSet.arrays, materialSet.macro];
  const settled = await Promise.allSettled(descriptors.map(async (descriptor) => {
    const value = await loadVerifiedCustomsTerrainKtx2({
      descriptor,
      baseHref,
      fetchImpl,
      digestImpl,
      parse: parserState.parse,
      signal,
      maxBytes: maxTextureBytes,
    });
    try {
      return configureAndValidateKtx2Texture(value, descriptor, anisotropy);
    } catch (error) {
      disposeBestEffort(value);
      throw error;
    }
  }));

  const failed = settled.find((result) => result.status === 'rejected');
  if (failed) {
    for (const result of settled) {
      if (result.status === 'fulfilled') disposeBestEffort(result.value);
    }
    if (parserState.ownsLoader) disposeBestEffort(parserState.loader);
    throw failed.reason;
  }

  const loaded = settled.map((result) => result.value);
  const textures = Object.freeze({
    albedo: loaded[0],
    normal: loaded[1],
    orm: loaded[2],
    macro: loaded[3],
  });
  const controlTextures = Object.freeze(createControlTextures(controlAtlas));
  const tiles = new Map(controlAtlas.tiles.map((tile) => [tile.id, tile]));
  const materials = new Set();
  let disposed = false;

  return Object.freeze({
    version: CUSTOMS_TERRAIN_PBR_RUNTIME_VERSION,
    fixedRelief: CUSTOMS_TERRAIN_PBR_FIXED_RELIEF,
    fog: false,
    shaderContract: CUSTOMS_TERRAIN_PBR_SHADER_CONTRACT,
    materialSet,
    controlAtlas,
    textures,
    controlTextures,
    get disposed() { return disposed; },
    createTileMaterial(tileId) {
      if (disposed) fail('ERR_TERRAIN_PBR_DISPOSED', 'runtime', 'has been disposed');
      const tile = tiles.get(tileId);
      if (!tile) fail('ERR_TERRAIN_PBR_TILE', 'tileId', `unknown control-atlas tile ${tileId}`);
      const material = createTerrainMaterial({ materialSet, textures, controlTextures, tile });
      materials.add(material);
      return material;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const material of materials) disposeBestEffort(material);
      materials.clear();
      for (const value of Object.values(textures)) disposeBestEffort(value);
      for (const value of controlTextures) disposeBestEffort(value);
      if (parserState.ownsLoader) disposeBestEffort(parserState.loader);
    },
  });
}
