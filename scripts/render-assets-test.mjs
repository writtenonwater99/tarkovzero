#!/usr/bin/env node
// Unit tests for the render-asset pipeline's hand-rolled codecs, resamplers and
// generators (scripts/lib/*).
// Run: npm run test:render-assets   (node --test, no test framework dependency)
//
// Why this file exists: `prepare-render-assets.mjs --check` compares regenerated
// bytes against the committed tree, which catches DRIFT FROM A BASELINE but is
// blind to a defect that was already present when the baseline was created. Swap
// the AO and roughness sources in the ORM pack and every hash changes together —
// the outputs still decode, `--check` still prints green, and terrain roughness
// silently reads the occlusion map forever. Nothing below depends on the network
// or on the git-ignored source cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import {
  crc32,
  decodeHdr,
  decodePng,
  downsample,
  encodePng,
  linearToSrgb,
  makeImage,
  packChannels,
  readZip,
  resizeTo,
  srgbToLinear,
  takeChannels,
} from './lib/imageio.mjs';
import { buildGroundMaps } from './lib/groundmaps.mjs';
import { GRADE_DEFAULTS, MID_GREY_LINEAR, bayer, contrastCurve, gradeLut, macroNoise } from './lib/imagegen.mjs';
import {
  SH_LAMBERT_A,
  analyzeEquirect,
  autoExposure,
  dirToAzEl,
  linearToHex,
  shRadianceToIrradiance,
  skyGradientStrip,
  tonemapToSrgb,
} from './lib/skylight.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/** An image whose every sample is distinguishable from every other. */
function ramp(width, height, channels, fn) {
  const img = makeImage(width, height, channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) img.data[(y * width + x) * channels + c] = fn(x, y, c);
    }
  }
  return img;
}

const constant = (size, channels, ...values) =>
  ramp(size, size, channels, (x, y, c) => values[c % values.length]);

/** Minimal ZIP writer, so readZip can be tested without a fixture file. */
function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data, store = false } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = store ? data : zlib.deflateRawSync(data);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    locals.push(local, body);

    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(store ? 0 : 8, 10);
    cd.writeUInt32LE(crc32(data), 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);
    central.push(cd);
    offset += local.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

/** Radiance .hdr in the new-style (per-plane) RLE the real sources use. */
function makeHdr(width, height, rgbeAt) {
  const parts = [Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`, 'latin1')];
  for (let y = 0; y < height; y++) {
    const head = Buffer.from([2, 2, (width >> 8) & 0xff, width & 0xff]);
    const planes = [];
    for (let c = 0; c < 4; c++) {
      // Literal runs only, chunked to the 128-byte maximum.
      for (let x = 0; x < width; x += 128) {
        const n = Math.min(128, width - x);
        const run = Buffer.alloc(n + 1);
        run[0] = n;
        for (let i = 0; i < n; i++) run[i + 1] = rgbeAt(x + i, y)[c];
        planes.push(run);
      }
    }
    parts.push(head, ...planes);
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------
test('PNG round-trips every supported channel count exactly', () => {
  for (const channels of [1, 3, 4]) {
    const src = ramp(16, 9, channels, (x, y, c) => ((x * 16 + y * 3 + c * 7) % 256) / 255);
    const back = decodePng(encodePng(src));
    assert.equal(back.width, 16);
    assert.equal(back.height, 9);
    assert.equal(back.channels, channels);
    for (let i = 0; i < src.data.length; i++) {
      assert.ok(near(back.data[i], src.data[i], 1 / 512), `channel set ${channels}, sample ${i}`);
    }
  }
});

test('PNG encoding is deterministic and carries no timestamp', () => {
  const img = ramp(32, 32, 3, (x, y, c) => ((x * y + c) % 251) / 255);
  const a = encodePng(img);
  const b = encodePng(img);
  assert.ok(a.equals(b), 'two encodes of the same image must be byte-identical');
  assert.equal(a.includes(Buffer.from('tIME', 'ascii')), false, 'no tIME chunk may be written');
});

test('the sRGB chunk is written only when asked for', () => {
  const img = constant(4, 3, 0.5, 0.5, 0.5);
  assert.ok(encodePng(img, { srgbChunk: true }).includes(Buffer.from('sRGB', 'ascii')));
  assert.equal(encodePng(img).includes(Buffer.from('sRGB', 'ascii')), false);
});

test('PNG quantisation clamps rather than wrapping', () => {
  const img = ramp(3, 1, 1, (x) => [-0.5, 0.5, 1.7][x]);
  const back = decodePng(encodePng(img));
  assert.equal(back.data[0], 0);
  assert.ok(near(back.data[1], 128 / 255));
  assert.equal(back.data[2], 1);
});

test('decodePng rejects what it cannot decode instead of guessing', () => {
  assert.throws(() => decodePng(Buffer.alloc(64)), /not a PNG file/);
  const png = encodePng(constant(8, 3, 0.25, 0.5, 0.75));
  const truncated = Buffer.from(png);
  // Blank the IDAT payload's tail: inflate still succeeds on some prefixes, so
  // aim at the declared height instead by rewriting IHDR's height field.
  truncated.writeUInt32BE(9999, 8 + 8 + 4);
  assert.throws(() => decodePng(truncated), /truncated PNG image data|invalid|incorrect/i);
});

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------
test('readZip reads stored and deflated members and lists names sorted', () => {
  const hello = Buffer.from('hello ground', 'utf8');
  const big = Buffer.from('x'.repeat(5000), 'utf8');
  const zip = readZip(makeZip([
    { name: 'b/stored.txt', data: hello, store: true },
    { name: 'a/deflated.txt', data: big },
  ]));
  assert.deepEqual(zip.names(), ['a/deflated.txt', 'b/stored.txt']);
  assert.ok(zip.has('b/stored.txt'));
  assert.equal(zip.has('nope'), false);
  assert.ok(zip.read('b/stored.txt').equals(hello));
  assert.ok(zip.read('a/deflated.txt').equals(big));
});

test('readZip fails loud on a corrupt member and a missing name', () => {
  const data = Buffer.from('payload that will be corrupted', 'utf8');
  const buf = makeZip([{ name: 'f.bin', data, store: true }]);
  const body = buf.indexOf(data);
  buf[body] ^= 0xff; // flip a byte inside the stored payload
  assert.throws(() => readZip(buf).read('f.bin'), /crc mismatch/);
  assert.throws(() => readZip(makeZip([{ name: 'f.bin', data }])).read('other'), /zip entry not found/);
  assert.throws(() => readZip(Buffer.alloc(100)), /not a zip file/);
});

// ---------------------------------------------------------------------------
// Radiance HDR
// ---------------------------------------------------------------------------
test('decodeHdr decodes new-style RLE with the standard RGBE exponent', () => {
  // The standard RGBE decode is mantissa * 2^(e-128) / 256, so e = 128 puts a
  // mantissa of 128 at exactly 0.5.
  const img = decodeHdr(makeHdr(16, 4, () => [128, 64, 32, 128]));
  assert.equal(img.width, 16);
  assert.equal(img.height, 4);
  assert.ok(near(img.data[0], 0.5));
  assert.ok(near(img.data[1], 0.25));
  assert.ok(near(img.data[2], 0.125));
  const last = (16 * 4 - 1) * 3;
  assert.ok(near(img.data[last], 0.5));
});

test('decodeHdr maps a zero exponent to black, not to a denormal', () => {
  const img = decodeHdr(makeHdr(8, 1, () => [200, 200, 200, 0]));
  assert.equal(img.data[0], 0);
  assert.equal(img.data[1], 0);
  assert.equal(img.data[2], 0);
});

test('decodeHdr rejects malformed input instead of hanging or fabricating pixels', () => {
  const header = Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 4\n', 'latin1');
  // Old-style repeat marker as the first pixel of a scanline: used to read
  // row[-4] (undefined -> 0) and return a run of fabricated black.
  assert.throws(
    () => decodeHdr(Buffer.concat([header, Buffer.from([1, 1, 1, 2, 9, 9, 9, 129, 9, 9, 9, 129, 9, 9, 9, 129])])),
    /RLE run at the start of a scanline/,
  );
  // Truncated new-style scanline: used to spin forever on `count = undefined`.
  const good = makeHdr(64, 4, (x) => [x & 255, 1, 2, 130]);
  assert.throws(() => decodeHdr(good.subarray(0, good.length - 40)), /truncated \.hdr/);
  // A zero-length run never advances x.
  const zeroRun = Buffer.concat([
    Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 8\n', 'latin1'),
    Buffer.from([2, 2, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0]),
  ]);
  assert.throws(() => decodeHdr(zeroRun), /zero-length RLE run/);
  assert.throws(() => decodeHdr(Buffer.from('#?RADIANCE\nFORMAT=rgbe\n\n-Y 1 +X 1\n', 'latin1')), /unsupported \.hdr format/);
});

// ---------------------------------------------------------------------------
// Resampling
// ---------------------------------------------------------------------------
test('linear downsampling is an exact box average', () => {
  const img = ramp(4, 4, 1, (x, y) => (y * 4 + x) / 16);
  const out = downsample(img, 2, 'linear');
  assert.equal(out.width, 2);
  // Top-left 2x2 block holds 0, 1, 4, 5 over 16.
  assert.ok(near(out.data[0], (0 + 1 + 4 + 5) / 4 / 16));
  assert.ok(near(out.data[3], (10 + 11 + 14 + 15) / 4 / 16));
});

test('sRGB downsampling averages in linear light, not in gamma', () => {
  // Deliberately NOT black and white: 0 and 1 are fixed points of the transfer
  // function, so they cannot tell the two averages apart. sRGB 0.2 and 0.8
  // average to sRGB 0.6013 in linear light and to 0.5 in gamma space.
  const img = ramp(2, 2, 3, (x) => (x === 0 ? 0.2 : 0.8));
  const expected = linearToSrgb((srgbToLinear(0.2) + srgbToLinear(0.8)) / 2);
  const out = downsample(img, 2, 'srgb');
  assert.ok(near(out.data[0], expected, 1e-6), `got ${out.data[0]}, expected ${expected}`);
  assert.ok(Math.abs(out.data[0] - 0.5) > 0.05, 'a gamma-space average would give 0.5');
  // Linear data must NOT be linearised on the way in.
  const linear = downsample(img, 2, 'linear');
  assert.ok(near(linear.data[0], 0.5, 1e-6), `linear space must plainly average, got ${linear.data[0]}`);
});

test('normal downsampling renormalises to unit length', () => {
  // Two opposing tilts around +Z that must average to something still unit-long.
  const img = ramp(2, 2, 3, (x, y, c) => {
    const tilt = x === 0 ? 0.9 : 0.1;
    return [tilt, 0.5, 1][c];
  });
  const out = downsample(img, 2, 'normal');
  const n = [out.data[0] * 2 - 1, out.data[1] * 2 - 1, out.data[2] * 2 - 1];
  assert.ok(near(Math.hypot(...n), 1, 1e-9), `normal length ${Math.hypot(...n)}`);
});

test('resampling refuses non-integer ratios rather than changing filter', () => {
  const img = makeImage(10, 10, 3);
  assert.throws(() => resizeTo(img, 4), /no integer box ratio/);
  assert.throws(() => downsample(img, 1.5), /positive integer/);
  assert.throws(() => downsample(img, 3), /cannot box-downsample/);
  assert.equal(resizeTo(img, 10), img, 'an identity resize returns the same object');
});

test('packChannels and takeChannels keep source order', () => {
  const a = constant(2, 1, 0.1);
  const b = constant(2, 3, 0.2, 0.3, 0.4);
  const packed = packChannels([{ img: a, channel: 0 }, { img: b, channel: 2 }, { constant: 0.9 }]);
  assert.equal(packed.channels, 3);
  assert.ok(near(packed.data[0], 0.1));
  assert.ok(near(packed.data[1], 0.4), 'channel selection must pick B, not R');
  assert.ok(near(packed.data[2], 0.9));
  const cut = takeChannels(b, 2);
  assert.equal(cut.channels, 2);
  assert.ok(near(cut.data[0], 0.2) && near(cut.data[1], 0.3));
});

// ---------------------------------------------------------------------------
// The ground-detail recipe (the ORM channel assignment in particular)
// ---------------------------------------------------------------------------
test('the ORM pack is occlusion, roughness, metalness in that order', () => {
  // Distinguishable constants: if AO and roughness are ever swapped at the call
  // site, R and G come back the other way round and this fails. `--check` cannot
  // see that, because both baselines move together.
  const maps = buildGroundMaps({
    color: constant(4, 3, 0.9, 0.9, 0.9),
    normal: constant(4, 3, 0.5, 0.5, 1),
    ao: constant(4, 1, 0.25),
    rough: constant(4, 1, 0.75),
  }, 2);
  assert.equal(maps.orm.channels, 3);
  assert.ok(near(maps.orm.data[0], 0.25), `R must be occlusion, got ${maps.orm.data[0]}`);
  assert.ok(near(maps.orm.data[1], 0.75), `G must be roughness, got ${maps.orm.data[1]}`);
  assert.equal(maps.orm.data[2], 0, 'B (metalness) is a constant 0 for ground');
});

test('the ground recipe resizes every map and drops alpha', () => {
  const maps = buildGroundMaps({
    color: constant(8, 4, 0.5, 0.5, 0.5, 1),
    normal: constant(8, 3, 0.5, 0.5, 1),
    ao: constant(8, 1, 0.5),
    rough: constant(8, 1, 0.5),
  }, 4);
  for (const img of [maps.albedo, maps.normal, maps.orm]) {
    assert.equal(img.width, 4);
    assert.equal(img.height, 4);
    assert.equal(img.channels, 3);
  }
});

test('the ground recipe refuses sources it cannot box-filter', () => {
  const ok = constant(8, 1, 0.5);
  assert.throws(() => buildGroundMaps({ color: ok, normal: ok, ao: ok, rough: ok }, 3), /integer box ratio/);
  const oblong = makeImage(8, 4, 1);
  assert.throws(() => buildGroundMaps({ color: oblong, normal: ok, ao: ok, rough: ok }, 4), /not square/);
});

// ---------------------------------------------------------------------------
// Generated maps
// ---------------------------------------------------------------------------
test('the grade LUT leaves a linear mid-grey tint alone', () => {
  // The whole point of normalising the tint terms: a neutral tint must be a
  // no-op. Subtracting the sRGB 0.5 from linear tint values made it a darkening.
  const mid = linearToSrgb(MID_GREY_LINEAR);
  const hexMid = `#${Array(3).fill(Math.round(mid * 255).toString(16).padStart(2, '0')).join('')}`;
  const lut = gradeLut({ shadowTint: hexMid, highlightTint: hexMid }, { size: 16, saturation: 1, contrast: 1 });
  let worst = 0;
  for (let b = 0; b < 16; b++) {
    for (let g = 0; g < 16; g++) {
      for (let r = 0; r < 16; r++) {
        const di = (g * 256 + b * 16 + r) * 3;
        worst = Math.max(
          worst,
          Math.abs(lut.data[di] - r / 15),
          Math.abs(lut.data[di + 1] - g / 15),
          Math.abs(lut.data[di + 2] - b / 15),
        );
      }
    }
  }
  assert.ok(worst < 0.002, `a neutral tint drifted by ${worst}`);
});

test('the grade LUT lifts shadows toward the tint instead of crushing them', () => {
  const lut = gradeLut({ shadowTint: '#979f9b', highlightTint: '#c8c2b2' }, { size: 16 });
  const at = (i) => {
    const di = (i * 256 + i * 16 + i) * 3;
    return [lut.data[di], lut.data[di + 1], lut.data[di + 2]];
  };
  const black = at(0);
  assert.ok(black.every((v) => v > 0.02), `pure black must be lifted, got ${black}`);
  // The lift carries the tint's hue: the fog colour is greener than it is red.
  assert.ok(black[1] > black[0], 'the shadow lift must carry the tint hue');
  // Monotonic along the neutral diagonal, with no plateau at either end.
  let prev = -1;
  for (let i = 0; i < 16; i++) {
    const v = at(i)[0];
    assert.ok(v > prev, `the neutral ramp stalled at index ${i}`);
    prev = v;
  }
});

test('the grade LUT does not clip the highlights', () => {
  const lut = gradeLut({ shadowTint: '#979f9b', highlightTint: '#c8c2b2' }, { size: 16 });
  let clipped = 0;
  for (let i = 0; i < lut.data.length; i += 3) {
    if (lut.data[i] >= 1 - 1e-9 || lut.data[i + 1] >= 1 - 1e-9 || lut.data[i + 2] >= 1 - 1e-9) clipped++;
  }
  // Only the genuine white corner may reach 1. The unshouldered power curve
  // returned 1.114 at linear 1.0 and clamped 395 of 4096 entries to white.
  assert.ok(clipped <= 16, `${clipped} of 4096 LUT entries clip to white`);
});

test('the contrast curve fixes both the pivot and white', () => {
  const { contrast, pivot } = GRADE_DEFAULTS;
  assert.ok(near(contrastCurve(pivot, contrast, pivot), pivot, 1e-12), 'the pivot must not move');
  assert.ok(near(contrastCurve(1, contrast, pivot), 1, 1e-12), 'white must stay white');
  assert.equal(contrastCurve(0, contrast, pivot), 0);
  assert.equal(contrastCurve(0.42, 1, pivot), 0.42, 'contrast 1 is the identity');
  let prev = -1;
  for (let v = 0; v <= 1.0001; v += 0.005) {
    const out = contrastCurve(v, contrast, pivot);
    assert.ok(out > prev, `the curve is not monotonic at ${v}`);
    assert.ok(out <= 1 + 1e-12, `the curve exceeds 1 at ${v}`);
    prev = out;
  }
  // It is a contrast increase: below the pivot it darkens, above it brightens
  // relative to the identity.
  assert.ok(contrastCurve(0.05, contrast, pivot) < 0.05);
  assert.ok(contrastCurve(0.6, contrast, pivot) > 0.6);
});

test('the grade LUT is deterministic and laid out as a horizontal strip', () => {
  const opts = { shadowTint: '#979f9b', highlightTint: '#c8c2b2' };
  const a = gradeLut(opts, { size: 8 });
  const b = gradeLut(opts, { size: 8 });
  assert.equal(a.width, 64);
  assert.equal(a.height, 8);
  assert.deepEqual([...a.data], [...b.data]);
});

test('the macro-noise tile is seamless, deterministic and Bayer-dithered', () => {
  const size = 64;
  const a = macroNoise({ size, seed: 7 });
  const b = macroNoise({ size, seed: 7 });
  assert.deepEqual([...a.data], [...b.data], 'the same seed must give the same tile');
  assert.notDeepEqual([...macroNoise({ size, seed: 8 }).data], [...a.data]);

  // Seamlessness: the wrap-around neighbour must be as close as an interior one.
  const px = (x, y, c) => a.data[((y % size) * size + (x % size)) * 4 + c];
  for (const c of [0, 1, 2]) {
    let wrap = 0;
    let interior = 0;
    for (let y = 0; y < size; y++) {
      wrap += Math.abs(px(size - 1, y, c) - px(0, y, c)) + Math.abs(px(y, size - 1, c) - px(y, 0, c));
      interior += Math.abs(px(10, y, c) - px(11, y, c)) + Math.abs(px(y, 10, c) - px(y, 11, c));
    }
    assert.ok(wrap <= interior * 1.5, `channel ${c} has a visible seam (${wrap} vs ${interior})`);
  }

  // Alpha is the 16x16 ordered-dither matrix, tiled.
  const m = bayer(4);
  assert.equal(m.length, 16);
  assert.ok(near(a.data[3], m[0][0]));
  assert.ok(near(a.data[(17 * size + 17) * 4 + 3], m[1][1]), 'the dither matrix must tile every 16 px');
  const values = new Set(m.flat());
  assert.equal(values.size, 256, 'a 16x16 Bayer matrix holds 256 distinct thresholds');
});

// ---------------------------------------------------------------------------
// Sky / SH analysis
// ---------------------------------------------------------------------------
test('a uniform sky projects onto band 0 only, with the analytic coefficient', () => {
  const L = 0.4;
  const img = ramp(64, 32, 3, () => L);
  const sh = analyzeEquirect(img).shRadiance;
  // L_00 = L * Y_00 * 4pi = 0.282095 * 4pi * L
  assert.ok(near(sh[0][0], 0.282095 * 4 * Math.PI * L, 1e-3), `got ${sh[0][0]}`);
  // Every other band integrates to zero over the sphere. The residual here is
  // midpoint-quadrature error at 64x32, ~0.1% of the band-0 coefficient.
  for (let k = 1; k < 9; k++) {
    for (let c = 0; c < 3; c++) {
      assert.ok(Math.abs(sh[k][c]) < sh[0][0] * 0.01, `band coefficient ${k} should vanish, got ${sh[k][c]}`);
    }
  }
});

test('hemisphere and luminance averages match a known constant sky', () => {
  const img = ramp(64, 32, 3, (x, y, c) => [0.2, 0.4, 0.6][c]);
  const a = analyzeEquirect(img);
  for (const band of [a.upperHemisphere, a.lowerHemisphere, a.zenith, a.horizon]) {
    assert.ok(near(band[0], 0.2, 1e-6) && near(band[1], 0.4, 1e-6) && near(band[2], 0.6, 1e-6));
  }
  assert.ok(near(a.meanLuminance, 0.2 * 0.2126 + 0.4 * 0.7152 + 0.6 * 0.0722, 1e-6));
  assert.equal(a.dominant, null, 'a flat sky has no dominant direction');
});

test('the dominant-light estimate points at the bright patch', () => {
  // One bright column at phi = 90 degrees (+X, i.e. azimuth 90), above the horizon.
  const W = 64;
  const H = 32;
  const img = ramp(W, H, 3, (x, y) => (x === Math.floor(W / 4) && y === Math.floor(H / 4) ? 50 : 0.01));
  const d = analyzeEquirect(img).dominant;
  assert.ok(d, 'a bright patch must be found');
  assert.ok(near(d.azimuthDeg, 90, 3), `azimuth ${d.azimuthDeg}`);
  assert.ok(d.elevationDeg > 30 && d.elevationDeg < 60, `elevation ${d.elevationDeg}`);
});

test('dirToAzEl follows the documented compass', () => {
  assert.ok(near(dirToAzEl([0, 0, 1]).azimuthDeg, 0), '+Z is azimuth 0');
  assert.ok(near(dirToAzEl([1, 0, 0]).azimuthDeg, 90), '+X is azimuth 90, clockwise');
  assert.ok(near(dirToAzEl([0, 1, 0]).elevationDeg, 90), '+Y is straight up');
});

test('the SH coefficients are radiance, and the Lambertian factors are per band', () => {
  const sh = analyzeEquirect(ramp(32, 16, 3, () => 1)).shRadiance;
  const irr = shRadianceToIrradiance(sh);
  assert.ok(near(irr[0][0] / sh[0][0], Math.PI, 1e-9), 'band 0 scales by pi');
  assert.deepEqual(SH_LAMBERT_A.map((v) => +v.toFixed(6)), [3.141593, 2.094395, 0.785398]);
  // The whole reason the field is not called irradiance: the factors differ.
  assert.notEqual(SH_LAMBERT_A[0], SH_LAMBERT_A[1]);
  assert.notEqual(SH_LAMBERT_A[1], SH_LAMBERT_A[2]);
});

test('autoExposure maps mean luminance onto the target', () => {
  assert.ok(near(autoExposure(0.21, 0.42), 2));
  assert.equal(autoExposure(0), 1, 'a black map must not divide by zero');
  assert.equal(autoExposure(-1), 1);
});

test('tone mapping is monotonic, bounded and never negative', () => {
  const img = ramp(8, 1, 3, (x, y, c) => [0, 0.01, 0.1, 0.5, 1, 4, 40, 400][x] + c * 0);
  const out = tonemapToSrgb(img, 1);
  let prev = -1;
  for (let x = 0; x < 8; x++) {
    const v = out.data[x * 3];
    assert.ok(v >= 0 && v <= 1, `tone-mapped value ${v} out of range`);
    assert.ok(v > prev, 'tone mapping must be monotonic');
    prev = v;
  }
  const negative = tonemapToSrgb(ramp(1, 1, 3, () => -5), 1);
  assert.equal(negative.data[0], 0);
});

test('the sky gradient strip averages per elevation band, zenith first', () => {
  // Bright top half, dark bottom half.
  const img = ramp(16, 8, 3, (x, y) => (y < 4 ? 1 : 0));
  const strip = skyGradientStrip(img, { width: 4, height: 8, exposure: 1 });
  assert.equal(strip.width, 4);
  assert.equal(strip.height, 8);
  assert.ok(strip.data[0] > 0.5, 'row 0 is the zenith and must be bright');
  assert.equal(strip.data[7 * 4 * 3], 0, 'the last row is the nadir and must be dark');
  for (let x = 1; x < 4; x++) {
    assert.equal(strip.data[x * 3], strip.data[0], 'every column of a row is identical');
  }
  assert.throws(() => skyGradientStrip(img, { height: 5 }), /must divide the source height/);
});

test('linearToHex round-trips through the same tone map the preview uses', () => {
  assert.equal(linearToHex([0, 0, 0], 1), '#000000');
  const grey = linearToHex([0.5, 0.5, 0.5], 1);
  assert.match(grey, /^#[0-9a-f]{6}$/);
  assert.equal(grey.slice(1, 3), grey.slice(3, 5), 'a neutral input must stay neutral');
  assert.equal(linearToHex([-1, -1, -1], 1), '#000000', 'negative radiance clamps to black');
});

// ---------------------------------------------------------------------------
// Colour space helpers
// ---------------------------------------------------------------------------
test('the sRGB transfer functions are exact inverses across the range', () => {
  for (let i = 0; i <= 100; i++) {
    const v = i / 100;
    assert.ok(near(linearToSrgb(srgbToLinear(v)), v, 1e-12), `round trip failed at ${v}`);
  }
  assert.equal(srgbToLinear(0), 0);
  assert.ok(near(srgbToLinear(1), 1, 1e-12));
  assert.ok(near(MID_GREY_LINEAR, 0.214041, 1e-6), 'linear mid grey is 0.2140, not 0.5');
});

test('crc32 matches the known IEEE check value', () => {
  assert.equal(crc32(Buffer.from('123456789', 'ascii')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});
