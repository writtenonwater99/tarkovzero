// Dependency-free, deterministic image I/O for the render-asset pipeline.
//
// Everything here is written against Node built-ins only (zlib + Buffer) so that
// `scripts/prepare-render-assets.mjs` can run without adding a native or wasm
// dependency to the project. Determinism rules that every function obeys:
//   * no timestamps are ever written (PNG gets no tIME chunk);
//   * zlib is always called with a pinned level/strategy/windowBits/memLevel;
//   * all arithmetic is integer or IEEE double with a fixed evaluation order.
//
// Byte-identical output therefore depends only on (input bytes, options, zlib
// version). The zlib version is recorded in the generated lock file.
import zlib from 'node:zlib';

// ---------------------------------------------------------------------------
// CRC32 (used by both PNG chunks and ZIP entry verification)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf, seed = 0) {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

// Pinned deflate settings. Anything that writes a PNG must go through this.
const DEFLATE_OPTS = Object.freeze({
  level: 9,
  strategy: zlib.constants.Z_DEFAULT_STRATEGY,
  windowBits: 15,
  memLevel: 9,
});

export const deflateSettings = () => ({ ...DEFLATE_OPTS, zlibVersion: zlib.constants.ZLIB_VERNUM });

// ---------------------------------------------------------------------------
// ZIP reading (stored + deflate members, which is all ambientCG ships)
// ---------------------------------------------------------------------------
export function readZip(buf) {
  // Locate the end-of-central-directory record by scanning backwards.
  const maxComment = 0xffff;
  const start = Math.max(0, buf.length - maxComment - 22);
  let eocd = -1;
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file: no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error(`bad central directory header at ${off}`);
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const compSize = buf.readUInt32LE(off + 20);
    const rawSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.set(name, { name, method, crc, compSize, rawSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: () => [...entries.keys()].sort(),
    has: (name) => entries.has(name),
    read(name) {
      const e = entries.get(name);
      if (!e) throw new Error(`zip entry not found: ${name}`);
      if (buf.readUInt32LE(e.localOff) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
      const nameLen = buf.readUInt16LE(e.localOff + 26);
      const extraLen = buf.readUInt16LE(e.localOff + 28);
      const dataOff = e.localOff + 30 + nameLen + extraLen;
      const raw = buf.subarray(dataOff, dataOff + e.compSize);
      let out;
      if (e.method === 0) out = Buffer.from(raw);
      else if (e.method === 8) out = zlib.inflateRawSync(raw);
      else throw new Error(`unsupported zip compression method ${e.method} for ${name}`);
      if (out.length !== e.rawSize) throw new Error(`size mismatch for ${name}: ${out.length} != ${e.rawSize}`);
      if (crc32(out) !== e.crc) throw new Error(`crc mismatch for zip entry ${name}`);
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Image container
//   { width, height, channels, data: Float32Array }  values normalised 0..1
//   (HDR images keep values above 1; that is intentional.)
// ---------------------------------------------------------------------------
export function makeImage(width, height, channels) {
  return { width, height, channels, data: new Float32Array(width * height * channels) };
}

// ---------------------------------------------------------------------------
// PNG decode — bit depths 8/16, colour types 0/2/3/4/6, non-interlaced.
// ---------------------------------------------------------------------------
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('not a PNG file');
  let off = 8;
  let ihdr = null;
  let palette = null;
  let trns = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr) throw new Error('PNG has no IHDR');
  if (ihdr.interlace !== 0) throw new Error('interlaced PNG is not supported');
  if (ihdr.depth !== 8 && ihdr.depth !== 16) throw new Error(`unsupported PNG bit depth ${ihdr.depth}`);

  const srcChannels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.colorType];
  if (srcChannels === undefined) throw new Error(`unsupported PNG colour type ${ihdr.colorType}`);

  const bytesPerSample = ihdr.depth / 8;
  const bpp = srcChannels * bytesPerSample; // filter offset, in bytes
  const rowBytes = ihdr.width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < (rowBytes + 1) * ihdr.height) throw new Error('truncated PNG image data');

  // Un-filter in place into a contiguous sample buffer.
  const px = Buffer.alloc(rowBytes * ihdr.height);
  let prev = Buffer.alloc(rowBytes);
  for (let y = 0; y < ihdr.height; y++) {
    const filter = raw[y * (rowBytes + 1)];
    const line = raw.subarray(y * (rowBytes + 1) + 1, y * (rowBytes + 1) + 1 + rowBytes);
    const cur = px.subarray(y * rowBytes, (y + 1) * rowBytes);
    line.copy(cur);
    switch (filter) {
      case 0: break;
      case 1: for (let i = bpp; i < rowBytes; i++) cur[i] = (cur[i] + cur[i - bpp]) & 0xff; break;
      case 2: for (let i = 0; i < rowBytes; i++) cur[i] = (cur[i] + prev[i]) & 0xff; break;
      case 3:
        for (let i = 0; i < rowBytes; i++) {
          const a = i >= bpp ? cur[i - bpp] : 0;
          cur[i] = (cur[i] + ((a + prev[i]) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let i = 0; i < rowBytes; i++) {
          const a = i >= bpp ? cur[i - bpp] : 0;
          const b = prev[i];
          const c = i >= bpp ? prev[i - bpp] : 0;
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          cur[i] = (cur[i] + pred) & 0xff;
        }
        break;
      default: throw new Error(`unknown PNG filter type ${filter}`);
    }
    prev = cur;
  }

  // Expand to float 0..1, resolving palettes to RGB(A).
  const outChannels = ihdr.colorType === 3 ? (trns ? 4 : 3) : srcChannels;
  const img = makeImage(ihdr.width, ihdr.height, outChannels);
  const maxV = ihdr.depth === 16 ? 65535 : 255;
  for (let y = 0; y < ihdr.height; y++) {
    for (let x = 0; x < ihdr.width; x++) {
      const si = y * rowBytes + x * bpp;
      const di = (y * ihdr.width + x) * outChannels;
      if (ihdr.colorType === 3) {
        const idx = px[si];
        img.data[di] = palette[idx * 3] / 255;
        img.data[di + 1] = palette[idx * 3 + 1] / 255;
        img.data[di + 2] = palette[idx * 3 + 2] / 255;
        if (outChannels === 4) img.data[di + 3] = (idx < trns.length ? trns[idx] : 255) / 255;
      } else {
        for (let c = 0; c < srcChannels; c++) {
          const v = ihdr.depth === 16 ? px.readUInt16BE(si + c * 2) : px[si + c];
          img.data[di + c] = v / maxV;
        }
      }
    }
  }
  return img;
}

// ---------------------------------------------------------------------------
// PNG encode — 8-bit, colour type chosen from `channels` (1 = grey, 3 = RGB,
// 4 = RGBA). Adaptive per-row filtering with the standard minimum-sum heuristic.
// ---------------------------------------------------------------------------
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function encodePng(img, { srgbChunk = false } = {}) {
  const { width, height, channels } = img;
  const colorType = { 1: 0, 3: 2, 4: 6 }[channels];
  if (colorType === undefined) throw new Error(`cannot encode ${channels}-channel PNG`);
  const rowBytes = width * channels;

  // Quantise once, deterministically (round-half-up on a clamped 0..1 value).
  const px = Buffer.alloc(rowBytes * height);
  for (let i = 0; i < width * height * channels; i++) {
    const v = img.data[i];
    px[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
  }

  const raw = Buffer.alloc((rowBytes + 1) * height);
  const cand = [Buffer.alloc(rowBytes), Buffer.alloc(rowBytes), Buffer.alloc(rowBytes), Buffer.alloc(rowBytes), Buffer.alloc(rowBytes)];
  let prev = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y++) {
    const cur = px.subarray(y * rowBytes, (y + 1) * rowBytes);
    let best = 0, bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const out = cand[f];
      let score = 0;
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= channels ? cur[i - channels] : 0;
        const b = prev[i];
        const c = i >= channels ? prev[i - channels] : 0;
        let v;
        if (f === 0) v = cur[i];
        else if (f === 1) v = cur[i] - a;
        else if (f === 2) v = cur[i] - b;
        else if (f === 3) v = cur[i] - ((a + b) >> 1);
        else {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = cur[i] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
        out[i] = v & 0xff;
        score += out[i] < 128 ? out[i] : 256 - out[i];
      }
      if (score < bestScore) { bestScore = score; best = f; }
    }
    raw[y * (rowBytes + 1)] = best;
    cand[best].copy(raw, y * (rowBytes + 1) + 1);
    prev = cur;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const parts = [PNG_SIG, chunk('IHDR', ihdr)];
  // sRGB chunk (rendering intent 0) marks colour maps; linear data omits it.
  if (srgbChunk) parts.push(chunk('sRGB', Buffer.from([0])));
  parts.push(chunk('IDAT', zlib.deflateSync(raw, DEFLATE_OPTS)));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Radiance .hdr decode (32-bit_rle_rgbe, new- and old-style RLE)
// ---------------------------------------------------------------------------
export function decodeHdr(buf) {
  let pos = 0;
  const nextLine = () => {
    const end = buf.indexOf(0x0a, pos);
    if (end < 0) throw new Error('malformed .hdr header');
    const line = buf.toString('latin1', pos, end);
    pos = end + 1;
    return line;
  };
  const magic = nextLine();
  if (!magic.startsWith('#?')) throw new Error('not a Radiance .hdr file');
  let format = null;
  for (;;) {
    const line = nextLine();
    if (line === '') break;
    const m = /^FORMAT=(.*)$/.exec(line);
    if (m) format = m[1].trim();
  }
  if (format !== '32-bit_rle_rgbe') throw new Error(`unsupported .hdr format: ${format}`);
  const dims = /^-Y (\d+) \+X (\d+)$/.exec(nextLine());
  if (!dims) throw new Error('unsupported .hdr scanline ordering (need -Y H +X W)');
  const height = Number(dims[1]);
  const width = Number(dims[2]);

  const rgbe = new Uint8Array(width * height * 4);
  const row = new Uint8Array(width * 4);
  for (let y = 0; y < height; y++) {
    if (width >= 8 && width < 0x8000 && buf[pos] === 2 && buf[pos + 1] === 2 &&
        ((buf[pos + 2] << 8) | buf[pos + 3]) === width) {
      pos += 4;
      // New-style RLE: four separate component planes.
      for (let c = 0; c < 4; c++) {
        let x = 0;
        while (x < width) {
          let count = buf[pos++];
          if (count > 128) {
            count -= 128;
            const v = buf[pos++];
            for (let i = 0; i < count; i++) row[(x++) * 4 + c] = v;
          } else {
            for (let i = 0; i < count; i++) row[(x++) * 4 + c] = buf[pos++];
          }
        }
      }
    } else {
      // Flat / old-style RLE.
      let x = 0;
      let shift = 0;
      while (x < width) {
        const r = buf[pos], g = buf[pos + 1], b = buf[pos + 2], e = buf[pos + 3];
        pos += 4;
        if (r === 1 && g === 1 && b === 1) {
          const count = e << shift;
          const base = (x - 1) * 4;
          for (let i = 0; i < count; i++, x++) {
            row[x * 4] = row[base]; row[x * 4 + 1] = row[base + 1];
            row[x * 4 + 2] = row[base + 2]; row[x * 4 + 3] = row[base + 3];
          }
          shift += 8;
        } else {
          row[x * 4] = r; row[x * 4 + 1] = g; row[x * 4 + 2] = b; row[x * 4 + 3] = e;
          x++; shift = 0;
        }
      }
    }
    rgbe.set(row, y * width * 4);
  }

  const img = makeImage(width, height, 3);
  for (let i = 0, n = width * height; i < n; i++) {
    const e = rgbe[i * 4 + 3];
    // 2^(e-136) == 2^(e-128) / 256, the standard RGBE decode.
    const f = e === 0 ? 0 : Math.pow(2, e - 136);
    img.data[i * 3] = rgbe[i * 4] * f;
    img.data[i * 3 + 1] = rgbe[i * 4 + 1] * f;
    img.data[i * 3 + 2] = rgbe[i * 4 + 2] * f;
  }
  return img;
}

// ---------------------------------------------------------------------------
// Colour space + resampling helpers
// ---------------------------------------------------------------------------
export const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
export const linearToSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/**
 * Box downsample by an exact integer factor. Refuses non-integer ratios so a
 * silent quality/determinism change can never sneak in.
 * @param {'srgb'|'linear'|'normal'} space how samples are averaged.
 */
export function downsample(img, factor, space = 'linear') {
  if (!Number.isInteger(factor) || factor < 1) throw new Error(`downsample factor must be a positive integer, got ${factor}`);
  if (factor === 1) return img;
  if (img.width % factor || img.height % factor) {
    throw new Error(`cannot box-downsample ${img.width}x${img.height} by ${factor}`);
  }
  const w = img.width / factor, h = img.height / factor, c = img.channels;
  const out = makeImage(w, h, c);
  const inv = 1 / (factor * factor);
  const acc = new Float64Array(c);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      acc.fill(0);
      for (let dy = 0; dy < factor; dy++) {
        const srow = (y * factor + dy) * img.width;
        for (let dx = 0; dx < factor; dx++) {
          const si = (srow + x * factor + dx) * c;
          for (let ch = 0; ch < c; ch++) {
            let v = img.data[si + ch];
            if (space === 'srgb' && ch < 3) v = srgbToLinear(v);
            else if (space === 'normal' && ch < 3) v = v * 2 - 1;
            acc[ch] += v;
          }
        }
      }
      const di = (y * w + x) * c;
      if (space === 'normal') {
        const nx = acc[0] * inv, ny = acc[1] * inv, nz = acc[2] * inv;
        const len = Math.hypot(nx, ny, nz) || 1;
        out.data[di] = (nx / len) * 0.5 + 0.5;
        out.data[di + 1] = (ny / len) * 0.5 + 0.5;
        out.data[di + 2] = (nz / len) * 0.5 + 0.5;
        for (let ch = 3; ch < c; ch++) out.data[di + ch] = acc[ch] * inv;
      } else {
        for (let ch = 0; ch < c; ch++) {
          let v = acc[ch] * inv;
          if (space === 'srgb' && ch < 3) v = linearToSrgb(v);
          out.data[di + ch] = v;
        }
      }
    }
  }
  return out;
}

/** Downsample to an exact target width, requiring an integer ratio. */
export function resizeTo(img, targetWidth, space = 'linear') {
  if (img.width === targetWidth) return img;
  if (img.width % targetWidth) {
    throw new Error(`no integer box ratio from ${img.width} to ${targetWidth}`);
  }
  return downsample(img, img.width / targetWidth, space);
}

/** Build an N-channel image by picking one source channel per output channel. */
export function packChannels(sources) {
  const { width, height } = sources[0].img;
  const out = makeImage(width, height, sources.length);
  for (let i = 0, n = width * height; i < n; i++) {
    for (let c = 0; c < sources.length; c++) {
      const s = sources[c];
      out.data[i * sources.length + c] = s.img
        ? s.img.data[i * s.img.channels + (s.channel ?? 0)]
        : s.constant;
    }
  }
  return out;
}

/** Drop an image to `n` leading channels. */
export function takeChannels(img, n) {
  if (img.channels === n) return img;
  const out = makeImage(img.width, img.height, n);
  for (let i = 0, px = img.width * img.height; i < px; i++) {
    for (let c = 0; c < n; c++) out.data[i * n + c] = c < img.channels ? img.data[i * img.channels + c] : 0;
  }
  return out;
}
