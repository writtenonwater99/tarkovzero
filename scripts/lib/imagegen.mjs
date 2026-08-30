// Deterministic, self-authored image generators for the render-asset pipeline.
//
// Nothing here downloads anything: these are the "own-made" Stage 1 assets the
// plan calls for (a macro/breakup noise tile and a colour-grade LUT). Every
// function is a pure function of its arguments, uses only integer hashing and
// IEEE doubles in a fixed order, and therefore produces byte-identical output
// on every run.
import { linearToSrgb, makeImage, srgbToLinear } from './imageio.mjs';

// ---------------------------------------------------------------------------
// Integer hash -> [0, 1). 32-bit throughout so it cannot drift with FP details.
// ---------------------------------------------------------------------------
function hash2(x, y, seed) {
  let h = (Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) | 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10); // quintic smoothstep

/**
 * Tileable value noise. The lattice wraps at `period`, so the resulting image
 * tiles seamlessly at any resolution that is a multiple of the period.
 */
function valueNoise(u, v, period, seed) {
  const x = u * period;
  const y = v * period;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = fade(x - x0);
  const fy = fade(y - y0);
  const wrap = (n) => ((n % period) + period) % period;
  const xa = wrap(x0);
  const xb = wrap(x0 + 1);
  const ya = wrap(y0);
  const yb = wrap(y0 + 1);
  const n00 = hash2(xa, ya, seed);
  const n10 = hash2(xb, ya, seed);
  const n01 = hash2(xa, yb, seed);
  const n11 = hash2(xb, yb, seed);
  const top = n00 + (n10 - n00) * fx;
  const bot = n01 + (n11 - n01) * fx;
  return top + (bot - top) * fy;
}

/** Tileable fractal Brownian motion, normalised to 0..1. */
function fbm(u, v, basePeriod, octaves, seed) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(u, v, basePeriod * (1 << o), seed + o * 101);
    norm += amp;
    amp *= 0.5;
  }
  return sum / norm;
}

/** Recursive Bayer ordered-dither matrix of side 2^levels, values in 0..1. */
export function bayer(levels) {
  let m = [[0, 2], [3, 1]];
  for (let l = 1; l < levels; l++) {
    const n = m.length * 2;
    const next = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let y = 0; y < m.length; y++) {
      for (let x = 0; x < m.length; x++) {
        const v = m[y][x] * 4;
        next[y][x] = v;
        next[y][x + m.length] = v + 2;
        next[y + m.length][x] = v + 3;
        next[y + m.length][x + m.length] = v + 1;
      }
    }
    m = next;
  }
  const n = m.length;
  return m.map((row) => row.map((v) => v / (n * n)));
}

/**
 * The Stage 1 macro/breakup tile.
 *   R = low-frequency macro tint variation (hides 1K texture repetition)
 *   G = mid-frequency surface breakup (wetness / grime masks)
 *   B = high-frequency detail noise
 *   A = Bayer ordered dither threshold (LOD cross-fades, alpha-to-coverage)
 * Seamless: every channel wraps on the tile.
 */
export function macroNoise({ size = 256, seed = 20260829 } = {}) {
  const img = makeImage(size, size, 4);
  const dither = bayer(4); // 16x16
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const i = (y * size + x) * 4;
      img.data[i] = fbm(u, v, 2, 3, seed);
      img.data[i + 1] = fbm(u, v, 8, 3, seed + 7919);
      img.data[i + 2] = fbm(u, v, 32, 2, seed + 15731);
      img.data[i + 3] = dither[y % 16][x % 16];
    }
  }
  return img;
}

// ---------------------------------------------------------------------------
// Overcast colour-grade LUT
//
// Layout is the common horizontal-strip LUT: width = size*size, height = size.
// Pixel (x, y) holds the graded value of input (r, g, b) where
//   r = (x % size) / (size - 1)
//   g = y / (size - 1)
//   b = floor(x / size) / (size - 1)
// i.e. `size` slices of constant blue, laid left to right.
// ---------------------------------------------------------------------------
const LUM = [0.2126, 0.7152, 0.0722];

// The grade runs entirely in linear light, so the neutral point the tint terms
// are measured against must be linear too. sRGB 0.5 is linear 0.2140 — using the
// sRGB number here is what made a mid-grey tint darken instead of doing nothing.
export const MID_GREY_LINEAR = srgbToLinear(0.5);

export const GRADE_DEFAULTS = Object.freeze({
  size: 16,
  saturation: 0.82, // pull chroma down; the target is damp overcast, not grey
  contrast: 1.06, // gentle S-curve through the pivot; see contrastCurve()
  pivot: 0.18,
  shadowLift: 0.055, // shadows drift toward the far-fog blue-grey
  highlightWarmth: 0.03, // a weak, slightly warm key survives in the highlights
  exposure: 1.0,
});

/**
 * @param {{shadowTint: string, highlightTint: string}} tints hex colours,
 *        normally PALETTE.fogFar and LIGHT.realistic.keyColor.
 */
export function gradeLut(tints, options = {}) {
  const o = { ...GRADE_DEFAULTS, ...options };
  const size = o.size;
  const shadow = hexToLinear(tints.shadowTint);
  const highlight = hexToLinear(tints.highlightTint);
  const img = makeImage(size * size, size, 3);
  const rgb = [0, 0, 0];
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        rgb[0] = srgbToLinear(r / (size - 1));
        rgb[1] = srgbToLinear(g / (size - 1));
        rgb[2] = srgbToLinear(b / (size - 1));
        const out = grade(rgb, shadow, highlight, o);
        const x = b * size + r;
        const di = (g * size * size + x) * 3;
        img.data[di] = linearToSrgb(out[0]);
        img.data[di + 1] = linearToSrgb(out[1]);
        img.data[di + 2] = linearToSrgb(out[2]);
      }
    }
  }
  return img;
}

function hexToLinear(color) {
  const v = Number.parseInt(color.slice(1), 16);
  return [
    srgbToLinear(((v >> 16) & 255) / 255),
    srgbToLinear(((v >> 8) & 255) / 255),
    srgbToLinear((v & 255) / 255),
  ];
}

/**
 * Gentle S-curve that fixes BOTH ends instead of only the pivot.
 *
 *   v <= pivot : v' = pivot * (v/pivot)^contrast          — the plain power curve
 *   v >  pivot : a quadratic through (pivot, pivot) and (1, 1) whose slope at
 *                the pivot equals the power curve's, so the two halves join
 *                smoothly and white stays white.
 *
 * The bare power curve returns pivot*(1/pivot)^contrast = 1.114 at v = 1 for the
 * shipped contrast of 1.06, so everything above linear 0.908 used to clamp to
 * pure white (395 of 4096 LUT entries). The shoulder removes that clip while
 * keeping the pivot — and therefore the overall exposure — where it was.
 */
export function contrastCurve(v, contrast, pivot) {
  if (v <= 0) return v;
  if (contrast === 1) return v;
  if (v <= pivot) return pivot * Math.pow(v / pivot, contrast);
  const u = (v - pivot) / (1 - pivot);
  return pivot + (1 - pivot) * (contrast * u + (1 - contrast) * u * u);
}

function grade(lin, shadow, highlight, o) {
  const out = [lin[0] * o.exposure, lin[1] * o.exposure, lin[2] * o.exposure];
  const L = out[0] * LUM[0] + out[1] * LUM[1] + out[2] * LUM[2];

  for (let c = 0; c < 3; c++) {
    // 1. desaturate toward luminance
    let v = L + (out[c] - L) * o.saturation;
    // 2. tint: shadows toward the fog colour, highlights toward the weak key.
    //    Both weights are normalised against LINEAR mid grey, so a mid-grey tint
    //    is exactly a no-op and a bright tint cannot silently raise exposure.
    const shadowW = (1 - L) * (1 - L);
    const highW = L * L;
    v += o.shadowLift * shadowW * (shadow[c] - MID_GREY_LINEAR);
    v += o.highlightWarmth * highW * (highlight[c] - MID_GREY_LINEAR);
    // 3. gentle contrast around the pivot, shouldered so white stays white
    v = contrastCurve(v, o.contrast, o.pivot);
    out[c] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return out;
}
