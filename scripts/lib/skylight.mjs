// Derive a small, shippable sky/ambient reference from an equirectangular HDRI.
//
// The plan (RENDER-REALISM.md Part C / Stage 1) wants the "Autumn Crossing" HDRI
// used as an ambient environment reference with a separate authored key light.
// Shipping the 1.8 MiB .hdr to browsers for that is waste, so this module
// reduces it to: 9 spherical-harmonic RADIANCE coefficients, hemisphere
// averages, an estimated dominant-light direction, and a tone-mapped preview.
//
// The SH coefficients are the plain projection L_lm = integral L(w) Y_lm(w) dw.
// They are NOT irradiance: a consumer that wants a Lambertian irradiance
// environment must convolve with the cosine lobe first by scaling each band by
// SH_LAMBERT_A[l] (Ramamoorthi/Hanrahan). The name says radiance for exactly
// that reason — the two differ per band, which is the kind of error that looks
// like a plausible lighting choice rather than a bug.
//
// Conventions (documented because the numbers are meaningless without them):
//   * Equirectangular, row 0 = zenith, row H-1 = nadir.
//   * theta = polar angle from +Y (up); phi = azimuth.
//   * World basis matches the game map: x east, y up, z south. Azimuth is
//     measured clockwise from +Z, the same compass the 3D HUD uses.
//   * Solid angle per texel = sin(theta) * (2*PI/W) * (PI/H).
import { linearToSrgb, makeImage } from './imageio.mjs';

const LUM = [0.2126, 0.7152, 0.0722];
const luminance = (r, g, b) => r * LUM[0] + g * LUM[1] + b * LUM[2];

/**
 * Lambertian cosine-lobe convolution factors per SH band (Ramamoorthi/Hanrahan
 * "An Efficient Representation for Irradiance Environment Maps", 2001):
 * A_0 = pi, A_1 = 2pi/3, A_2 = pi/4. Multiply a radiance coefficient of band l
 * by SH_LAMBERT_A[l] to get the irradiance coefficient.
 */
export const SH_LAMBERT_A = Object.freeze([Math.PI, (2 * Math.PI) / 3, Math.PI / 4]);

/** Band index (0, 1 or 2) of each of the 9 coefficients, in emission order. */
export const SH_BANDS = Object.freeze([0, 1, 1, 1, 2, 2, 2, 2, 2]);

/** Convolve radiance SH coefficients with the Lambertian cosine lobe. */
export function shRadianceToIrradiance(sh) {
  return sh.map((c, k) => c.map((v) => v * SH_LAMBERT_A[SH_BANDS[k]]));
}

function direction(x, y, width, height) {
  const theta = ((y + 0.5) / height) * Math.PI;
  const phi = ((x + 0.5) / width) * 2 * Math.PI;
  const st = Math.sin(theta);
  return [st * Math.sin(phi), Math.cos(theta), st * Math.cos(phi)];
}

/** Azimuth (deg clockwise from +Z) and elevation (deg above horizon). */
export function dirToAzEl(d) {
  const az = (Math.atan2(d[0], d[2]) * 180) / Math.PI;
  return {
    azimuthDeg: (az + 360) % 360,
    elevationDeg: (Math.asin(Math.max(-1, Math.min(1, d[1]))) * 180) / Math.PI,
  };
}

/**
 * Project an equirect radiance map onto 9 SH bands and gather hemisphere stats.
 * `shRadiance` is the unconvolved projection — see SH_LAMBERT_A above.
 * Returns plain numbers only, ready to be JSON-serialised.
 */
export function analyzeEquirect(img) {
  const { width: W, height: H, channels } = img;
  if (channels < 3) throw new Error('analyzeEquirect needs an RGB image');
  const dOmega = ((2 * Math.PI) / W) * (Math.PI / H);

  const sh = Array.from({ length: 9 }, () => [0, 0, 0]);
  const upper = [0, 0, 0];
  const lower = [0, 0, 0];
  let upperW = 0;
  let lowerW = 0;
  const zenith = [0, 0, 0];
  const horizon = [0, 0, 0];
  let zenithW = 0;
  let horizonW = 0;
  let totalLum = 0;
  let totalW = 0;

  // Pass 1: SH projection + band averages.
  for (let y = 0; y < H; y++) {
    const theta = ((y + 0.5) / H) * Math.PI;
    const st = Math.sin(theta);
    const w = st * dOmega;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * channels;
      const r = img.data[i];
      const g = img.data[i + 1];
      const b = img.data[i + 2];
      const d = direction(x, y, W, H);

      const Y = [
        0.282095,
        0.488603 * d[1],
        0.488603 * d[2],
        0.488603 * d[0],
        1.092548 * d[0] * d[1],
        1.092548 * d[1] * d[2],
        0.315392 * (3 * d[1] * d[1] - 1),
        1.092548 * d[0] * d[2],
        0.546274 * (d[0] * d[0] - d[2] * d[2]),
      ];
      for (let k = 0; k < 9; k++) {
        const c = Y[k] * w;
        sh[k][0] += r * c;
        sh[k][1] += g * c;
        sh[k][2] += b * c;
      }

      if (d[1] >= 0) { upper[0] += r * w; upper[1] += g * w; upper[2] += b * w; upperW += w; }
      else { lower[0] += r * w; lower[1] += g * w; lower[2] += b * w; lowerW += w; }
      if (d[1] > 0.85) { zenith[0] += r * w; zenith[1] += g * w; zenith[2] += b * w; zenithW += w; }
      if (Math.abs(d[1]) < 0.12) { horizon[0] += r * w; horizon[1] += g * w; horizon[2] += b * w; horizonW += w; }

      totalLum += luminance(r, g, b) * w;
      totalW += w;
    }
  }

  const norm = (acc, wsum) => (wsum > 0 ? acc.map((v) => v / wsum) : [0, 0, 0]);
  const meanLuminance = totalLum / totalW;

  // Pass 2: dominant-light estimate. Take the solid-angle-weighted centroid of
  // everything brighter than a high multiple of the mean, which on an overcast
  // HDRI resolves to the bright patch of sky rather than a hard sun disc.
  const threshold = meanLuminance * 8;
  const centroid = [0, 0, 0];
  const sunColor = [0, 0, 0];
  let sunW = 0;
  for (let y = 0; y < H; y++) {
    const theta = ((y + 0.5) / H) * Math.PI;
    const w = Math.sin(theta) * dOmega;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * channels;
      const r = img.data[i];
      const g = img.data[i + 1];
      const b = img.data[i + 2];
      const l = luminance(r, g, b);
      if (l <= threshold) continue;
      const d = direction(x, y, W, H);
      const ww = l * w;
      centroid[0] += d[0] * ww; centroid[1] += d[1] * ww; centroid[2] += d[2] * ww;
      sunColor[0] += r * w; sunColor[1] += g * w; sunColor[2] += b * w;
      sunW += ww;
    }
  }
  let dominant = null;
  if (sunW > 0) {
    const len = Math.hypot(centroid[0], centroid[1], centroid[2]) || 1;
    const d = [centroid[0] / len, centroid[1] / len, centroid[2] / len];
    dominant = { direction: d, ...dirToAzEl(d) };
  }

  return {
    meanLuminance,
    shRadiance: sh,
    upperHemisphere: norm(upper, upperW),
    lowerHemisphere: norm(lower, lowerW),
    zenith: norm(zenith, zenithW),
    horizon: norm(horizon, horizonW),
    dominant,
  };
}

/**
 * Exposure that maps the map's mean luminance onto `targetLuminance` in
 * display-referred space. Data-driven so the preview cannot drift when the
 * source is re-fetched, and reported in the lock file.
 */
export function autoExposure(meanLuminance, targetLuminance = 0.42) {
  if (!(meanLuminance > 0)) return 1;
  return targetLuminance / meanLuminance;
}

const tonemap = (v) => v / (1 + v); // Reinhard; monotonic, no parameters to drift

/** Tone-map an HDR image to display-referred sRGB, ready for encodePng. */
export function tonemapToSrgb(img, exposure) {
  const out = makeImage(img.width, img.height, 3);
  for (let i = 0, n = img.width * img.height; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      out.data[i * 3 + c] = linearToSrgb(tonemap(Math.max(0, img.data[i * img.channels + c] * exposure)));
    }
  }
  return out;
}

/**
 * A narrow vertical strip holding the sky's average colour per elevation band,
 * top = zenith. Usable directly as a background-gradient texture.
 */
export function skyGradientStrip(img, { width = 8, height = 128, exposure = 1 } = {}) {
  const out = makeImage(width, height, 3);
  const rowsPer = img.height / height;
  if (!Number.isInteger(rowsPer)) {
    throw new Error(`sky gradient height ${height} must divide the source height ${img.height}`);
  }
  for (let y = 0; y < height; y++) {
    const acc = [0, 0, 0];
    let wsum = 0;
    for (let sy = y * rowsPer; sy < (y + 1) * rowsPer; sy++) {
      const theta = ((sy + 0.5) / img.height) * Math.PI;
      const w = Math.sin(theta);
      for (let x = 0; x < img.width; x++) {
        const i = (sy * img.width + x) * img.channels;
        acc[0] += img.data[i] * w;
        acc[1] += img.data[i + 1] * w;
        acc[2] += img.data[i + 2] * w;
        wsum += w;
      }
    }
    for (let x = 0; x < width; x++) {
      const di = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) {
        out.data[di + c] = linearToSrgb(tonemap(Math.max(0, (acc[c] / wsum) * exposure)));
      }
    }
  }
  return out;
}

/** Display-referred hex for a linear RGB triple under `exposure`. */
export function linearToHex(rgb, exposure = 1) {
  const hex = rgb
    .slice(0, 3)
    .map((v) => {
      const s = linearToSrgb(tonemap(Math.max(0, v * exposure)));
      return Math.round(Math.max(0, Math.min(1, s)) * 255).toString(16).padStart(2, '0');
    })
    .join('');
  return `#${hex}`;
}
