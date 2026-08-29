// src/terrain.js — smooth ground surface for the 3D view.
//
// Replaces the old per-quad `terrainQuads()` SolidPolygonLayer + `contours` PathLayer with a
// pre-built, smoothly-shaded ground mesh plus one continuous flat limit-skirt mesh.
//
// The old look ("puzzle pieces") had three causes, all fixed here together:
//   a) per-quad flat colour from a 5-stop ramp  -> per-texel gradient baked into a 2048px texture
//   b) bilinear interpolation of the 10 m grid (C0: every cell edge is a crease)
//                                              -> Gaussian-conditioned grid + bicubic Catmull-Rom
//   c) per-quad forward-difference shading      -> smooth per-vertex normals + baked two-light hillshade
// The source grid is a robust 5 m fit over survey, loose-loot and SPT spawn samples. One compact
// Gaussian pass conditions quantisation without smearing a real crest into its surroundings.
//
// Relief is applied once, to the conditioned height field that becomes H(x,z). The mesh, flat
// limit skirt, contours and every map3d layer therefore consume the same exaggerated ground.
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { Geometry } from '@luma.gl/engine';
import { COORDINATE_SYSTEM, LightingEffect, AmbientLight, DirectionalLight } from '@deck.gl/core';

// ---------------------------------------------------------------- tunables
const CELL = 2.5;          // mesh cell size in metres (10 m source grid subdivided 4x)
const PAD = 8;             // metres of mesh built outside the limit bbox (hidden, gives the skirt room)
const TEX_W = 2048;        // baked ground texture width
const SHADE_GAIN = 2.6;    // mild cartographic boost on top of the displayed surface's real normals
const DEFAULT_VOID_Z = -14;

// Light directions in DECK space (X=-gameX, Y=-gameZ, Z=up). `SUN_DIR` is the travel direction of
// the sun; the bake's key light is exactly its negation, so the two shading systems agree.
const SUN_DIR = [-0.62, -0.42, -0.66];
const FILL_DIR = [0.5, 0.35, -0.79];

// Bright field palette: still olive/green and desaturated, but no longer loses its middle values
// under the baked hillshade and the scene light.
const vib = (rgb, k = 1.3) => { const l = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]; return rgb.map((v) => Math.max(0, Math.min(255, l + (v - l) * k))); };
const GRASS = [[57, 82, 58], [68, 96, 62], [81, 108, 67], [101, 121, 73], [123, 137, 84]].map((c) => vib(c));
const GRASS_DRY = [132, 126, 99];
const GRASS_ROCK = [145, 138, 120];
const YARD_EARTH = [133, 101, 68];
const SURFACE = {
  pavement: [112, 115, 108],
  road: [137, 142, 133], roadEdge: [86, 91, 83],
  highway: [150, 153, 141], highwayEdge: [96, 101, 91], marking: [230, 226, 207],
  dirt: [139, 121, 88], dirtEdge: [103, 88, 64], track: [126, 105, 73],
  rail: [132, 130, 121], sleeper: [99, 91, 75],
};

// ---------------------------------------------------------------- small maths helpers
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (u) => u * u * (3 - 2 * u);
// Catmull-Rom through p1..p2 (p0/p3 are the outer control points)
const cr = (p0, p1, p2, p3, u) => {
  const u2 = u * u, u3 = u2 * u;
  return p0 * (-0.5 * u3 + u2 - 0.5 * u) + p1 * (1.5 * u3 - 2.5 * u2 + 1)
       + p2 * (-1.5 * u3 + 2 * u2 + 0.5 * u) + p3 * (0.5 * u3 - 0.5 * u2);
};
const norm3 = (v) => { const L = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / L, v[1] / L, v[2] / L]; };
// deterministic integer hash -> [0,1)
const hash2 = (i, j) => {
  let n = (i * 374761393 + j * 668265263) | 0;
  n = Math.imul(n ^ (n >> 13), 1274126177);
  return ((n ^ (n >> 16)) >>> 0) / 4294967296;
};
// 2D value noise with smoothstep interpolation
function vnoise(x, z, wl) {
  const fx = x / wl, fz = z / wl, i = Math.floor(fx), j = Math.floor(fz);
  const su = smoothstep(fx - i), sv = smoothstep(fz - j);
  const a = hash2(i, j), b = hash2(i + 1, j), c = hash2(i, j + 1), d = hash2(i + 1, j + 1);
  const t = a + (b - a) * su;
  return t + ((c + (d - c) * su) - t) * sv;
}

// ---------------------------------------------------------------- step 1: conditioned height field
// N passes of a separable 5x5 Gaussian [1,4,6,4,1], edges clamped (variance 1 cell^2 per pass per axis)
function gaussian5(heights, cols, rows, passes = 2) {
  const K = [1, 4, 6, 4, 1];
  let src = Float32Array.from(heights);
  const tmp = new Float32Array(src.length);
  for (let p = 0; p < passes; p++) {
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      let s = 0;
      for (let i = -2; i <= 2; i++) s += src[r * cols + clamp(c + i, 0, cols - 1)] * K[i + 2];
      tmp[r * cols + c] = s / 16;
    }
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      let s = 0;
      for (let i = -2; i <= 2; i++) s += tmp[clamp(r + i, 0, rows - 1) * cols + c] * K[i + 2];
      src[r * cols + c] = s / 16;
    }
  }
  return src;
}

// bicubic (tensor-product Catmull-Rom) sampler over the conditioned grid — this becomes map3d's H()
function makeBicubic(grid, cols, rows, x0, z0, step) {
  const at = (c, r) => grid[clamp(r, 0, rows - 1) * cols + clamp(c, 0, cols - 1)];
  return (x, z) => {
    const fx = (x - x0) / step, fz = (z - z0) / step;
    const cx = Math.floor(fx), cz = Math.floor(fz), u = fx - cx, v = fz - cz;
    const r0 = cr(at(cx - 1, cz - 1), at(cx, cz - 1), at(cx + 1, cz - 1), at(cx + 2, cz - 1), u);
    const r1 = cr(at(cx - 1, cz), at(cx, cz), at(cx + 1, cz), at(cx + 2, cz), u);
    const r2 = cr(at(cx - 1, cz + 1), at(cx, cz + 1), at(cx + 1, cz + 1), at(cx + 2, cz + 1), u);
    const r3 = cr(at(cx - 1, cz + 2), at(cx, cz + 2), at(cx + 1, cz + 2), at(cx + 2, cz + 2), u);
    return cr(r0, r1, r2, r3, v);
  };
}

// ---------------------------------------------------------------- rasterisation helpers
// scanline fill of one or more rings into a Uint8 mask sampled at cell centres (never per-cell point-in-poly)
function rasterRings(rings, mask, gw, gh, x0, z0, cw, ch) {
  const xsBuf = [];
  for (let j = 0; j < gh; j++) {
    const z = z0 + (j + 0.5) * ch;
    xsBuf.length = 0;
    for (const poly of rings) {
      for (let i = 0, n = poly.length; i < n; i++) {
        const a = poly[i], b = poly[(i + 1) % n];
        const za = a[1], zb = b[1];
        if ((za > z) === (zb > z)) continue;
        xsBuf.push(a[0] + ((z - za) / (zb - za)) * (b[0] - a[0]));
      }
    }
    if (!xsBuf.length) continue;
    xsBuf.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xsBuf.length; k += 2) {
      let ia = Math.ceil((xsBuf[k] - x0) / cw - 0.5), ib = Math.floor((xsBuf[k + 1] - x0) / cw - 0.5);
      ia = Math.max(0, ia); ib = Math.min(gw - 1, ib);
      for (let i = ia; i <= ib; i++) mask[j * gw + i] = 1;
    }
  }
  return mask;
}
// chamfer 3-4 distance (in cells) from every seed cell (mask===1)
function chamfer(mask, gw, gh) {
  const BIG = 1e6, d = new Float32Array(gw * gh);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 0 : BIG;
  const rel = (i, j, w) => { if (i < 0 || j < 0 || i >= gw || j >= gh) return BIG; return d[j * gw + i] + w; };
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
    const k = j * gw + i;
    d[k] = Math.min(d[k], rel(i - 1, j, 3), rel(i, j - 1, 3), rel(i - 1, j - 1, 4), rel(i + 1, j - 1, 4));
  }
  for (let j = gh - 1; j >= 0; j--) for (let i = gw - 1; i >= 0; i--) {
    const k = j * gw + i;
    d[k] = Math.min(d[k], rel(i + 1, j, 3), rel(i, j + 1, 3), rel(i + 1, j + 1, 4), rel(i - 1, j + 1, 4));
  }
  for (let i = 0; i < d.length; i++) d[i] /= 3; // chamfer units -> cells
  return d;
}

// ---------------------------------------------------------------- baked map materials
const css = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
function trace(ctx, path, close = false) {
  if (!path?.length) return false;
  ctx.beginPath(); ctx.moveTo(path[0][0], path[0][1]);
  for (let i = 1; i < path.length; i++) ctx.lineTo(path[i][0], path[i][1]);
  if (close) ctx.closePath();
  return true;
}
function strokeMapPath(ctx, path, color, width, dash = []) {
  if (!trace(ctx, path)) return;
  ctx.strokeStyle = css(color); ctx.lineWidth = width; ctx.setLineDash(dash); ctx.stroke();
}
function offsetLine(path, distance) {
  return path.map((p, i) => {
    const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
    const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz) || 1;
    return [p[0] - (dz / len) * distance, p[1] + (dx / len) * distance];
  });
}
function drawSleepers(ctx, path, spacing = 2.4, halfWidth = 1.25) {
  let next = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
    if (!len) continue;
    while (next <= len) {
      const t = next / len, x = a[0] + dx * t, z = a[1] + dz * t, nx = -dz / len, nz = dx / len;
      ctx.beginPath(); ctx.moveTo(x - nx * halfWidth, z - nz * halfWidth); ctx.lineTo(x + nx * halfWidth, z + nz * halfWidth); ctx.stroke();
      next += spacing;
    }
    next -= len;
  }
}

// Pavement and every at-grade transport line are painted into the terrain texture. They therefore
// share the mesh's exact vertices and can never stack, step, float, or z-fight on a steep relief.
function drawSurfaceNetwork(ctx, data, X0, Z0, mx, mz) {
  ctx.save();
  ctx.setTransform(1 / mx, 0, 0, 1 / mz, -X0 / mx, -Z0 / mz);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';

  ctx.fillStyle = css(SURFACE.pavement);
  for (const poly of data.pavement || []) if (trace(ctx, poly, true)) ctx.fill();

  const paved = (data.roads || []).filter((d) => d.kind !== 'track' && d.kind !== 'dirt');
  for (const d of paved) strokeMapPath(ctx, d.path, d.kind === 'highway' ? SURFACE.highwayEdge : SURFACE.roadEdge, d.width + 1.6);
  for (const d of paved) strokeMapPath(ctx, d.path, d.kind === 'highway' ? SURFACE.highway : SURFACE.road, d.width);
  for (const d of paved.filter((d) => d.kind === 'highway')) strokeMapPath(ctx, d.path, SURFACE.marking, 0.25, [6, 6]);

  for (const d of (data.roads || []).filter((r) => r.kind === 'dirt')) {
    strokeMapPath(ctx, d.path, SURFACE.dirtEdge, d.width + 1.2);
    strokeMapPath(ctx, d.path, SURFACE.dirt, d.width);
  }
  for (const d of (data.roads || []).filter((r) => r.kind === 'track')) {
    const width = Math.max(2.2, d.width || 0);
    strokeMapPath(ctx, d.path, SURFACE.dirt, width + 0.8);
    for (const side of [-1, 1]) strokeMapPath(ctx, offsetLine(d.path, side * width * 0.24), SURFACE.track, 0.48, [4.5, 2.8]);
  }

  for (const d of data.railway || []) {
    ctx.strokeStyle = css(SURFACE.sleeper); ctx.lineWidth = 0.34; ctx.setLineDash([]);
    drawSleepers(ctx, d.path);
    for (const side of [-0.72, 0.72]) strokeMapPath(ctx, offsetLine(d.path, side), SURFACE.rail, 0.28);
  }
  ctx.restore();
}

// ---------------------------------------------------------------- main
export function buildTerrain(data, relief = 3) {
  const t = data.terrain;
  const { x0, z0, step, cols, rows } = t;
  relief = [1, 2, 3].includes(Number(relief)) ? Number(relief) : 3;
  const conditioned = gaussian5(t.heights, cols, rows, 1); // ~5 m sigma: smooth cell noise, retain surveyed crests
  // This is the sole relief transform. Everything below, including the exported H(), reads `grid`.
  const grid = Float32Array.from(conditioned, (h) => h * relief);
  const H = makeBicubic(grid, cols, rows, x0, z0, step);
  let hmin = Infinity, hmax = -Infinity;
  for (let i = 0; i < grid.length; i++) { if (grid[i] < hmin) hmin = grid[i]; if (grid[i] > hmax) hmax = grid[i]; }
  const hspan = Math.max(1, hmax - hmin);
  // Keep the void below the lowest exaggerated ground (important on Woods at 3x).
  const voidZ = Math.min(DEFAULT_VOID_Z, Math.floor((hmin - 10) / 2) * 2);

  // ---- bbox of the built surface (limit bbox + padding)
  const limit = data.limit;
  const lx = limit.map((p) => p[0]), lz = limit.map((p) => p[1]);
  const X0 = Math.min(...lx) - PAD, X1 = Math.max(...lx) + PAD;
  const Z0 = Math.min(...lz) - PAD, Z1 = Math.max(...lz) + PAD;
  const W = X1 - X0, D = Z1 - Z0;

  // ================================================================ texture
  const TH_T = Math.round((TEX_W * D) / W);     // rows covering the ground
  const TH = TH_T;
  const mx = W / TEX_W, mz = D / TH_T;          // metres per texel

  // fine height raster at texture resolution, built separably (bicubic == CR in x then CR in z)
  const cxA = new Int32Array(TEX_W), cuA = new Float32Array(TEX_W);
  for (let px = 0; px < TEX_W; px++) {
    const fx = (X0 + (px + 0.5) * mx - x0) / step, c = Math.floor(fx);
    cxA[px] = c; cuA[px] = fx - c;
  }
  const gAt = (c, r) => grid[clamp(r, 0, rows - 1) * cols + clamp(c, 0, cols - 1)];
  const rowX = new Float32Array(rows * TEX_W);
  for (let r = 0; r < rows; r++) for (let px = 0; px < TEX_W; px++) {
    const c = cxA[px];
    rowX[r * TEX_W + px] = cr(gAt(c - 1, r), gAt(c, r), gAt(c + 1, r), gAt(c + 2, r), cuA[px]);
  }
  const fine = new Float32Array(TEX_W * TH_T);
  for (let py = 0; py < TH_T; py++) {
    const fz = (Z0 + (py + 0.5) * mz - z0) / step, cz = Math.floor(fz), v = fz - cz;
    const R = (k) => clamp(cz + k, 0, rows - 1) * TEX_W;
    const a = R(-1), b = R(0), c2 = R(1), d2 = R(2), o = py * TEX_W;
    for (let px = 0; px < TEX_W; px++) fine[o + px] = cr(rowX[a + px], rowX[b + px], rowX[c2 + px], rowX[d2 + px], v);
  }

  // coarse (4 m) distance rasters for the edge / shoreline ambient occlusion
  const AOC = 4, aw = Math.ceil(W / AOC), ah = Math.ceil(D / AOC);
  const insideMask = rasterRings([limit], new Uint8Array(aw * ah), aw, ah, X0, Z0, AOC, AOC);
  const outsideMask = new Uint8Array(aw * ah);
  for (let i = 0; i < outsideMask.length; i++) outsideMask[i] = insideMask[i] ? 0 : 1;
  const dEdge = chamfer(outsideMask, aw, ah);                       // cells from the limit boundary, inwards
  const waterMask = rasterRings(data.water || [], new Uint8Array(aw * ah), aw, ah, X0, Z0, AOC, AOC);
  const dWater = chamfer(waterMask, aw, ah);
  const yardRings = (data.yards || []).map((d) => d.poly ?? d);
  // Woods-only compacted compounds are part of the terrain material, not flat
  // overlays, so the same hillshade/mottle and mesh silhouette continue through them.
  const yardMask = yardRings.length
    ? rasterRings(yardRings, new Uint8Array(TEX_W * TH_T), TEX_W, TH_T, X0, Z0, mx, mz)
    : null;
  const sampleAO = (raster, px, py) => {
    const i = clamp(Math.floor(((px + 0.5) * mx) / AOC), 0, aw - 1);
    const j = clamp(Math.floor(((py + 0.5) * mz) / AOC), 0, ah - 1);
    return raster[j * aw + i] * AOC; // metres
  };

  const canvas = document.createElement('canvas');
  canvas.width = TEX_W; canvas.height = TH;
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  const img = ctx.createImageData(TEX_W, TH);
  const px8 = img.data;

  const KEY = norm3([-SUN_DIR[0], -SUN_DIR[1], -SUN_DIR[2]]);
  const FILL = norm3([-FILL_DIR[0], -FILL_DIR[1], -FILL_DIR[2]]);
  const flatRaw = KEY[2] + 0.28 * FILL[2];      // response of a flat surface, so shade ~1 on the flats
  const GRAD_PX = 3;

  for (let py = 0; py < TH_T; py++) {
    const gz = Z0 + (py + 0.5) * mz, o = py * TEX_W;
    const pyA = clamp(py - GRAD_PX, 0, TH_T - 1) * TEX_W, pyB = clamp(py + GRAD_PX, 0, TH_T - 1) * TEX_W;
    const dzSpan = (clamp(py + GRAD_PX, 0, TH_T - 1) - clamp(py - GRAD_PX, 0, TH_T - 1)) * mz || 1;
    for (let px = 0; px < TEX_W; px++) {
      const gx = X0 + (px + 0.5) * mx;
      const h = fine[o + px];
      // (a) hypsometry — smoothstep across the 5 grass stops
      const f = clamp((h - hmin) / hspan, 0, 1) * (GRASS.length - 1);
      const k = Math.min(GRASS.length - 2, Math.floor(f)), u = smoothstep(f - k);
      const A = GRASS[k], B = GRASS[k + 1];
      let r = A[0] + (B[0] - A[0]) * u, g = A[1] + (B[1] - A[1]) * u, b = A[2] + (B[2] - A[2]) * u;
      // gradient of the true field
      const ia = clamp(px - GRAD_PX, 0, TEX_W - 1), ib = clamp(px + GRAD_PX, 0, TEX_W - 1);
      const dhdx = (fine[o + ib] - fine[o + ia]) / ((ib - ia) * mx || 1);
      const dhdz = (fine[pyB + px] - fine[pyA + px]) / dzSpan;
      // (c) slope tint toward dry khaki — an independent relief cue
      const slope = Math.hypot(dhdx, dhdz), dry = Math.min(0.56, slope * 2.8);
      r += (GRASS_DRY[0] - r) * dry; g += (GRASS_DRY[1] - g) * dry; b += (GRASS_DRY[2] - b) * dry;
      const rocky = Math.min(0.34, Math.max(0, slope - 0.28) * 1.2);
      r += (GRASS_ROCK[0] - r) * rocky; g += (GRASS_ROCK[1] - g) * rocky; b += (GRASS_ROCK[2] - b) * rocky;
      if (yardMask?.[o + px]) {
        const earth = 0.82 + (vnoise(gx - 43, gz + 17, 11) - 0.5) * 0.12;
        r += (YARD_EARTH[0] * earth - r) * 0.88;
        g += (YARD_EARTH[1] * earth - g) * 0.88;
        b += (YARD_EARTH[2] * earth - b) * 0.88;
      }
      // (b) two-light hillshade in deck space (Nx = +VE*dh/dx because deck X = -gameX)
      const nx = SHADE_GAIN * dhdx, ny = SHADE_GAIN * dhdz;
      const nl = Math.sqrt(nx * nx + ny * ny + 1);
      const horizontalFacing = (nx * KEY[0] + ny * KEY[1]) / nl;
      const raw = (Math.max(0, nx * KEY[0] + ny * KEY[1] + KEY[2]) + 0.28 * Math.max(0, nx * FILL[0] + ny * FILL[1] + FILL[2])) / nl;
      const lee = smoothstep(clamp((-horizontalFacing - 0.03) * 2.1, 0, 1)) * Math.min(1, slope * 5);
      const shade = clamp((1 + (raw - flatRaw) * 1.9) * (1 - lee * 0.13), 0.60, 1.34);
      r *= shade; g *= shade; b *= shade;
      // (d) mottle, two octaves
      const m = 1 + (vnoise(gx, gz, 28) - 0.5) * 0.085;
      const m2 = (vnoise(gx + 91, gz - 37, 7) - 0.5) * 0.04;
      r *= m; g *= m * (1 + m2); b *= m;
      // (e) edge / shoreline ambient occlusion
      const ao = (1 - 0.14 * clamp(1 - sampleAO(dEdge, px, py) / 8, 0, 1))
               * (1 - 0.10 * clamp(1 - sampleAO(dWater, px, py) / 3, 0, 1));
      r *= ao; g *= ao; b *= ao;
      // (f) dither — the ramp spans ~60 values, it WILL band on 8-bit without this
      const dth = (hash2(px, py) - 0.5) * 5;
      const q = (o + px) * 4;
      px8[q] = clamp(r + dth, 0, 255); px8[q + 1] = clamp(g + dth, 0, 255); px8[q + 2] = clamp(b + dth, 0, 255); px8[q + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // (g) contours, drawn into the same canvas — perfectly smooth at any zoom, zero layers, no z-fighting
  drawContours(ctx, fine, TEX_W, TH_T, hmin, hmax);
  // Roads/rail/pavement are last so map symbols cover contours exactly as they would on a printed
  // topographic sheet. This is still the terrain's one texture, not a second draped surface.
  drawSurfaceNetwork(ctx, data, X0, Z0, mx, mz);

  // dev aid: ?debugtex shows the complete baked ground texture at 1:1.
  if (typeof location !== 'undefined' && location.search.includes('debugtex')) {
    canvas.style.cssText = 'position:fixed;left:280px;top:0;width:1100px;height:auto;z-index:9999;image-rendering:pixelated';
    setTimeout(() => document.body.appendChild(canvas), 0);
  }

  // ================================================================ mesh
  const NCX = Math.round(W / CELL), NCZ = Math.round(D / CELL);
  const cw = W / NCX, ch = D / NCZ;
  const NVX = NCX + 1, NVZ = NCZ + 1, NV = NVX * NVZ;
  const vTop = 1;
  const pos = new Float32Array(NV * 3), nrm = new Float32Array(NV * 3), uv = new Float32Array(NV * 2);
  const E = CELL;                               // central-difference step for the normals
  for (let j = 0; j < NVZ; j++) {
    const gz = Z0 + j * ch;
    for (let i = 0; i < NVX; i++) {
      const gx = X0 + i * cw, k = j * NVX + i;
      const h = H(gx, gz);
      pos[k * 3] = -gx; pos[k * 3 + 1] = -gz; pos[k * 3 + 2] = h;
      const dhdx = (H(gx + E, gz) - H(gx - E, gz)) / (2 * E);
      const dhdz = (H(gx, gz + E) - H(gx, gz - E)) / (2 * E);
      // deck X = -gameX and deck Y = -gameZ, so the normal keeps the *positive* derivative
      const nx = dhdx, ny = dhdz, nl = Math.sqrt(nx * nx + ny * ny + 1);
      nrm[k * 3] = nx / nl; nrm[k * 3 + 1] = ny / nl; nrm[k * 3 + 2] = 1 / nl;
      uv[k * 2] = clamp((gx - X0) / W, 0, 1);
      uv[k * 2 + 1] = clamp((gz - Z0) / D, 0, 1) * vTop;
    }
  }
  // clip: keep only cells whose centre is inside the limit polygon (scanline, ~2 ms)
  const keep = rasterRings([limit], new Uint8Array(NCX * NCZ), NCX, NCZ, X0, Z0, cw, ch);
  const kept = (i, j) => i >= 0 && j >= 0 && i < NCX && j < NCZ && keep[j * NCX + i];
  const idx = [], cliffEdges = [];
  for (let j = 0; j < NCZ; j++) for (let i = 0; i < NCX; i++) {
    if (!keep[j * NCX + i]) continue;
    const a = j * NVX + i, b = a + 1, c = a + NVX + 1, d = a + NVX;
    idx.push(a, b, c, a, c, d);
    if (!kept(i - 1, j)) cliffEdges.push([d, a]);
    if (!kept(i + 1, j)) cliffEdges.push([b, c]);
    if (!kept(i, j - 1)) cliffEdges.push([a, b]);
    if (!kept(i, j + 1)) cliffEdges.push([c, d]);
  }
  const TOT = NV;
  const positions = pos, normals = nrm, texCoords = uv;
  const indices = new Uint32Array(idx); // > 65k vertices: WebGL2 requires 32-bit indices

  const mesh = new Geometry({
    topology: 'triangle-list',
    attributes: {
      POSITION: { value: positions, size: 3 },
      NORMAL: { value: normals, size: 3 },
      TEXCOORD_0: { value: texCoords, size: 2 },
    },
    indices: { value: indices, size: 1 },
  });

  // One unlit mesh is welded directly to every exposed terrain edge. Its top vertices are the
  // terrain's own vertices (not a separately sampled approximation), so the seam is exact at all
  // relief settings. Every bottom vertex lands on the shared void plane; there are no caps, bands,
  // segment colours, lit boxes, or shadow receivers.
  const cliffVerts = [...new Set(cliffEdges.flat())], cliffMap = new Map(cliffVerts.map((v, i) => [v, i]));
  const cliffPos = new Float32Array(cliffVerts.length * 2 * 3), cliffNrm = new Float32Array(cliffVerts.length * 2 * 3), cliffIdx = new Uint32Array(cliffEdges.length * 6);
  for (let i = 0; i < cliffVerts.length; i++) {
    const v = cliffVerts[i], src = v * 3, top = i * 3, bottom = (i + cliffVerts.length) * 3;
    cliffPos.set([pos[src], pos[src + 1], pos[src + 2]], top);
    cliffPos.set([pos[src], pos[src + 1], voidZ], bottom);
    cliffNrm.set([0, 0, 1], top); cliffNrm.set([0, 0, 1], bottom); // ignored by material:false
  }
  for (let i = 0; i < cliffEdges.length; i++) {
    const a = cliffMap.get(cliffEdges[i][0]), b = cliffMap.get(cliffEdges[i][1]), q = i * 6;
    cliffIdx.set([a, b, b + cliffVerts.length, a, b + cliffVerts.length, a + cliffVerts.length], q);
  }
  const cliffMesh = new Geometry({
    topology: 'triangle-list',
    attributes: { POSITION: { value: cliffPos, size: 3 }, NORMAL: { value: cliffNrm, size: 3 } },
    indices: { value: cliffIdx, size: 1 },
  });

  const layer = () => new SimpleMeshLayer({
    id: 'terrain',
    data: [{ p: [0, 0, 0] }],
    getPosition: (d) => d.p,
    mesh,
    texture: canvas,
    getColor: [255, 255, 255],
    sizeScale: 1,
    shadowEnabled: false, // see the shadow note below
    pickable: false,
    coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
    textureParameters: {
      minFilter: 'linear', mipmapFilter: 'linear', magFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', maxAnisotropy: 16,
    },
    material: { ambient: 0.95, diffuse: 0.55, shininess: 1, specularColor: [10, 12, 10] }, // ambient is high so the baked shading (not the flat-normal diffuse) sets the ground value
  });
  const cliffLayer = () => new SimpleMeshLayer({
    id: 'cliff', data: [{ p: [0, 0, 0] }], getPosition: (d) => d.p, mesh: cliffMesh,
    getColor: [12, 14, 13], sizeScale: 1, material: false, shadowEnabled: false, pickable: false,
    parameters: { cullMode: 'none' }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
  });

  const lighting = new LightingEffect({
    ambient: new AmbientLight({ color: [214, 224, 232], intensity: 0.62 }),
    sun: new DirectionalLight({ color: [255, 246, 226], intensity: 1.05, direction: SUN_DIR }),
  });
  // NOTE on cast shadows (`_shadow: true` on the sun): they render correctly under OrbitView, but
  // deck gates casting AND receiving on the same `shadowEnabled` prop, so a ground surface that
  // receives building shadows also shadow-maps itself. Over a kilometre-scale relief surface lit at ~40
  // degrees, the depth16 shadow map has nowhere near the precision for that and the whole map goes
  // into acne. Verified in headless. Relief therefore comes from the mesh normals plus the baked
  // two-light hillshade, which need no extra pass.

  return { H, voidZ, layers: () => [cliffLayer(), layer()], lighting, stats: { relief, range: [hmin, hmax], verts: TOT, tris: indices.length / 3, cliffSegments: cliffEdges.length, tex: [TEX_W, TH] } };
}

// ---------------------------------------------------------------- contours (baked, not a layer)
// marching squares on the fine bicubic field, Chaikin-smoothed twice, stroked straight onto the texture.
// 2 m minors / 10 m index lines: at 1 m the 11 m range draws concentric bullseyes around every dome.
function drawContours(ctx, fine, gw, gh, hmin, hmax) {
  const SS = 4;                                   // sample every 4th texel
  const nx = Math.floor(gw / SS), nz = Math.floor(gh / SS);
  const at = (i, j) => fine[Math.min(gh - 1, j * SS) * gw + Math.min(gw - 1, i * SS)];
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (let lv = Math.ceil(hmin / 2) * 2; lv <= hmax; lv += 2) {
    const segs = [];
    for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const v = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
      const P4 = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
      const pts = [];
      for (let e = 0; e < 4; e++) {
        const a = e, b = (e + 1) % 4;
        if ((v[a] < lv) === (v[b] < lv)) continue;
        const s = (lv - v[a]) / (v[b] - v[a]);
        pts.push([(P4[a][0] + (P4[b][0] - P4[a][0]) * s) * SS, (P4[a][1] + (P4[b][1] - P4[a][1]) * s) * SS]);
      }
      if (pts.length === 2) segs.push(pts);
      else if (pts.length === 4) { segs.push([pts[0], pts[1]]); segs.push([pts[2], pts[3]]); }
    }
    if (!segs.length) continue;
    const major = lv % 10 === 0;
    ctx.strokeStyle = major ? 'rgba(20,32,20,0.38)' : 'rgba(26,42,26,0.20)';
    ctx.lineWidth = major ? 1.45 : 0.9;
    ctx.beginPath();
    for (const s of joinSegments(segs)) {
      const p = chaikin(chaikin(s));
      ctx.moveTo(p[0][0], p[0][1]);
      for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
    }
    ctx.stroke();
  }
}
// stitch marching-squares segments into polylines so Chaikin has something to smooth
function joinSegments(segs) {
  const key = (p) => `${Math.round(p[0] * 4)},${Math.round(p[1] * 4)}`;
  const ends = new Map();
  for (const s of segs) for (const p of [s[0], s[1]]) {
    const k = key(p); if (!ends.has(k)) ends.set(k, []); ends.get(k).push(s);
  }
  const used = new Set(), out = [];
  for (const s of segs) {
    if (used.has(s)) continue;
    used.add(s);
    const line = [s[0], s[1]];
    for (let dir = 0; dir < 2; dir++) {
      for (;;) {
        const tip = dir ? line[0] : line[line.length - 1];
        const cand = (ends.get(key(tip)) || []).find((c) => !used.has(c));
        if (!cand) break;
        used.add(cand);
        const next = key(cand[0]) === key(tip) ? cand[1] : cand[0];
        if (dir) line.unshift(next); else line.push(next);
        if (line.length > 4000) break;
      }
    }
    if (line.length > 2) out.push(line);
  }
  return out;
}
function chaikin(p) {
  if (p.length < 3) return p;
  const out = [p[0]];
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i], b = p[i + 1];
    out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
    out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
  }
  out.push(p[p.length - 1]);
  return out;
}
