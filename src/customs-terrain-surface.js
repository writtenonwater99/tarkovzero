/**
 * Original TarkovZero surface styling driven by exact local Customs control masks.
 *
 * The game-derived local package contributes only twelve scalar blend weights per
 * texel. These colors are ours: deliberately restrained, lighting-neutral base
 * albedos that avoid the random green/brown noise of the old procedural ground.
 */

export const CUSTOMS_TERRAIN_LAYER_COLORS = Object.freeze({
  grass: Object.freeze([86, 101, 58]),
  ground: Object.freeze([105, 94, 72]),
  'gravel-road-a': Object.freeze([91, 90, 84]),
  'forest-ground': Object.freeze([75, 70, 51]),
  'stone-ground': Object.freeze([103, 102, 96]),
  'rock-ground': Object.freeze([91, 92, 88]),
  'gravel-road-b': Object.freeze([108, 105, 97]),
  gravel: Object.freeze([114, 112, 104]),
  'grassy-ground': Object.freeze([94, 104, 68]),
  sand: Object.freeze([130, 119, 91]),
  pebbles: Object.freeze([116, 114, 106]),
  'soil-grass': Object.freeze([94, 84, 62]),
});

const FALLBACK_LAYER_ORDER = Object.freeze([
  'grass', 'ground', 'gravel-road-a', 'forest-ground',
  'stone-ground', 'rock-ground', 'gravel-road-b', 'gravel',
  'grassy-ground', 'sand', 'pebbles', 'soil-grass',
]);

function fail(message) {
  throw new TypeError(`Customs terrain surface: ${message}`);
}

function layerKind(name, index) {
  const normalized = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (normalized.includes('gravel-road-a')) return 'gravel-road-a';
  if (normalized.includes('gravel-road-b')) return 'gravel-road-b';
  if (normalized.includes('forest-ground')) return 'forest-ground';
  if (normalized.includes('stone-ground')) return 'stone-ground';
  if (normalized.includes('rock-ground')) return 'rock-ground';
  if (normalized.includes('grassy-ground')) return 'grassy-ground';
  if (normalized.includes('pebbles-ground')) return 'pebbles';
  if (normalized.includes('soil-grass')) return 'soil-grass';
  if (normalized.includes('gravel')) return 'gravel';
  if (normalized.includes('sand')) return 'sand';
  if (normalized.includes('grass')) return 'grass';
  if (normalized.includes('ground')) return 'ground';
  return FALLBACK_LAYER_ORDER[index] ?? 'ground';
}

export function customsTerrainPaletteForLayers(layers) {
  if (!Array.isArray(layers) || layers.length !== 12) fail('expected exactly twelve ordered layers');
  return layers.map((layer, index) => {
    if (Number(layer?.index) !== index) fail(`layer ${index} is out of order`);
    return [...CUSTOMS_TERRAIN_LAYER_COLORS[layerKind(layer?.name, index)]];
  });
}

const srgbToLinear = (byte) => {
  const value = byte / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

const linearToSrgbByte = (value) => {
  const clamped = Math.max(0, Math.min(1, value));
  const srgb = clamped <= 0.0031308
    ? clamped * 12.92
    : 1.055 * (clamped ** (1 / 2.4)) - 0.055;
  return Math.round(srgb * 255);
};

function pixelBytes(value, expected, label) {
  if (!(value instanceof Uint8Array) && !(value instanceof Uint8ClampedArray)) {
    fail(`${label} must be RGBA8 bytes`);
  }
  if (value.byteLength !== expected) fail(`${label} has the wrong byte length`);
  return value;
}

function byteView(value, label) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  fail(`${label} must be bytes`);
}

const PNG_SIGNATURE = Object.freeze([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * Decode the exact RGBA8/filter-0 PNGs emitted by the local extractor.
 *
 * Browser image/canvas decode is forbidden here: PNG alpha is terrain layer 3,
 * not opacity, so ordinary premultiplication can destroy the other RGB weights.
 */
export async function decodeCustomsTerrainControlPng(value, options = {}) {
  const bytes = byteView(value, 'control PNG');
  if (bytes.length < PNG_SIGNATURE.length
    || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) fail('control PNG signature is invalid');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE.length;
  let width = null, height = null, sawEnd = false;
  const idat = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) fail('control PNG chunk is truncated');
    const length = view.getUint32(offset, false);
    const typeOffset = offset + 4;
    const dataOffset = offset + 8;
    const end = dataOffset + length;
    if (!Number.isSafeInteger(end + 4) || end + 4 > bytes.length) fail('control PNG chunk length is invalid');
    const type = String.fromCharCode(...bytes.subarray(typeOffset, typeOffset + 4));
    const data = bytes.subarray(dataOffset, end);
    if (type === 'IHDR') {
      if (width != null || length !== 13) fail('control PNG IHDR is invalid');
      width = view.getUint32(dataOffset, false);
      height = view.getUint32(dataOffset + 4, false);
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
        || width < 1 || height < 1 || width > 4096 || height > 4096
        || data[8] !== 8 || data[9] !== 6 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        fail('control PNG must be non-interlaced RGBA8');
      }
    } else if (type === 'IDAT') {
      if (width == null) fail('control PNG IDAT precedes IHDR');
      idat.push(data);
    } else if (type === 'IEND') {
      if (length !== 0) fail('control PNG IEND is invalid');
      sawEnd = true;
      break;
    }
    offset = end + 4; // skip CRC; zlib/shape validation still fails closed on corruption.
  }
  if (width == null || height == null || idat.length === 0 || !sawEnd) fail('control PNG is incomplete');
  const compressedLength = idat.reduce((sum, chunk) => sum + chunk.length, 0);
  const compressed = new Uint8Array(compressedLength);
  let cursor = 0;
  for (const chunk of idat) {
    compressed.set(chunk, cursor);
    cursor += chunk.length;
  }
  const DecompressionStreamValue = options.DecompressionStream ?? globalThis.DecompressionStream;
  const BlobValue = options.Blob ?? globalThis.Blob;
  const ResponseValue = options.Response ?? globalThis.Response;
  if (typeof DecompressionStreamValue !== 'function'
    || typeof BlobValue !== 'function' || typeof ResponseValue !== 'function') {
    fail('browser deflate support is unavailable');
  }
  let inflated;
  try {
    const stream = new BlobValue([compressed]).stream()
      .pipeThrough(new DecompressionStreamValue('deflate'));
    inflated = new Uint8Array(await new ResponseValue(stream).arrayBuffer());
  } catch (error) {
    fail(`control PNG deflate failed (${error?.name ?? 'error'})`);
  }
  const stride = width * 4;
  if (inflated.length !== height * (stride + 1)) fail('control PNG inflated length is invalid');
  const rgba = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const source = row * (stride + 1);
    if (inflated[source] !== 0) fail('control PNG must use extractor filter 0');
    rgba.set(inflated.subarray(source + 1, source + 1 + stride), row * stride);
  }
  return { width, height, rgba };
}

/** Blend three RGBA controls into an original sRGB base-color atlas. */
export function blendCustomsTerrainControlPixels({ controls, width, height, palette }) {
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    fail('width and height must be positive integers');
  }
  if (!Array.isArray(controls) || controls.length !== 3) fail('expected exactly three RGBA controls');
  if (!Array.isArray(palette) || palette.length !== 12) fail('expected exactly twelve palette colors');
  const expected = width * height * 4;
  const sources = controls.map((control, index) => pixelBytes(control, expected, `control ${index}`));
  const linearPalette = palette.map((color, index) => {
    if (!Array.isArray(color) || color.length !== 3
      || color.some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 255)) {
      fail(`palette color ${index} must be three finite 0..255 channels`);
    }
    return color.map(srgbToLinear);
  });
  const output = new Uint8ClampedArray(expected);
  for (let offset = 0; offset < expected; offset += 4) {
    let total = 0;
    const rgb = [0, 0, 0];
    for (let layer = 0; layer < 12; layer += 1) {
      const weight = sources[Math.floor(layer / 4)][offset + (layer % 4)] / 255;
      total += weight;
      rgb[0] += linearPalette[layer][0] * weight;
      rgb[1] += linearPalette[layer][1] * weight;
      rgb[2] += linearPalette[layer][2] * weight;
    }
    if (total <= 1e-8) {
      rgb[0] = linearPalette[1][0];
      rgb[1] = linearPalette[1][1];
      rgb[2] = linearPalette[1][2];
      total = 1;
    }
    output[offset] = linearToSrgbByte(rgb[0] / total);
    output[offset + 1] = linearToSrgbByte(rgb[1] / total);
    output[offset + 2] = linearToSrgbByte(rgb[2] / total);
    output[offset + 3] = 255;
  }
  return output;
}

/** Browser helper: turn three losslessly decoded controls into one exact-mask canvas. */
export function customsTerrainSurfaceCanvas(decodedControls, layers, documentValue = globalThis.document) {
  if (!Array.isArray(decodedControls) || decodedControls.length !== 3) fail('expected three decoded controls');
  if (!documentValue?.createElement) fail('a browser document is required');
  const width = Number(decodedControls[0]?.width);
  const height = Number(decodedControls[0]?.height);
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    fail('decoded controls have invalid dimensions');
  }
  const controls = decodedControls.map((control, index) => {
    if (control?.width !== width || control?.height !== height) fail(`decoded control ${index} dimensions differ`);
    return pixelBytes(control.rgba, width * height * 4, `decoded control ${index}`);
  });
  const pixels = blendCustomsTerrainControlPixels({
    controls,
    width,
    height,
    palette: customsTerrainPaletteForLayers(layers),
  });
  const canvas = documentValue.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) fail('2D canvas is unavailable');
  const imageData = context.createImageData(width, height);
  imageData.data.set(pixels);
  context.putImageData(imageData, 0, 0);
  return canvas;
}
