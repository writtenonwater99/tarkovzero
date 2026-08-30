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
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import earcut from 'earcut';
import { allWaterRings, carveWaterHeightfield, makeWaterHeightCapper, waterLevelAt, waterPoly, waterHoles, pointInRing } from './water.js';
import {
  paletteFor, surfaceFor, terrainMaterialFor, groundDetailExtensionFor, toDeckDirection, resolveLook,
  skirtRamp, terrainMacro, waterTuning,
} from './atmosphere.js';
import { LIGHT, styleFor, ROAD_RIM, rgb255 } from './render-style.js';

// ---------------------------------------------------------------- tunables
const CELL = 2.5;          // mesh cell size in metres (10 m source grid subdivided 4x)
const PAD = 8;             // metres of mesh built outside the limit bbox (hidden, gives the skirt room)
const TEX_W = 2048;        // baked ground texture width
const DEFAULT_VOID_Z = -14;

// Light directions in DECK space (X=-gameX, Y=-gameZ, Z=up). `sunDir` is the travel direction of
// the key; the bake's key light is exactly its negation, so the two shading systems agree.
//
// STAGE 1: both looks now take the direction from the ONE frozen contract in render-style.js
// (azimuth 230, elevation 21), so the baked shading and the scene light can no longer drift apart
// — they are literally the same two numbers.
const sunDir = (look) => toDeckDirection(LIGHT[resolveLook(look)].keyDirection);
const FILL_DIR = [0.5, 0.35, -0.79];

// How hard the bake pushes relief.
//   vector     — 2.6, the pre-Stage-1 cartographic boost: the bake IS the relief cue, because the
//                terrain material runs ambient 0.95 and the scene light barely touches the ground.
//   realistic  — 1.0 and a tight clamp: the mesh normals plus the 21-degree key do the relief, and
//                a strong second hillshade on top of real lighting is exactly the "map board" read
//                Stage 1 exists to remove.
//
// R1.5 raised the vector floor from 0.60 to 0.70. At 0.60 a lee slope on Woods lost 40% of its
// albedo and, against the vector skin's BLACK void, the deepest folds of the mountain read as holes
// in the map rather than as shaded ground. The ceiling comes down with it so the total range — the
// thing that carries the relief — is nearly unchanged.
const SHADE = { vector: { gain: 2.6, lo: 0.70, hi: 1.26, contrast: 1.75 }, realistic: { gain: 1.0, lo: 0.84, hi: 1.14, contrast: 1.0 } };

// Bright field palette: still olive/green and desaturated, but no longer loses its middle values
// under the baked hillshade and the scene light. VECTOR ONLY — this is the hypsometric ramp the
// realistic look is required to drop.
//
// R1.5: the saturation boost drops 1.30 -> 1.12 and the stops come down with the shared vector
// palette. Mid-tone pastels against a black void were the contrast complaint; the ramp still spans
// the same number of values, it just sits lower.
const vib = (rgb, k = 1.12) => { const l = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]; return rgb.map((v) => Math.max(0, Math.min(255, l + (v - l) * k))); };
const GRASS = [[52, 74, 53], [62, 87, 57], [74, 98, 61], [92, 110, 67], [112, 125, 77]].map((c) => vib(c));
const GRASS_DRY = [122, 116, 92];
const GRASS_ROCK = [134, 128, 111];
const YARD_EARTH = [124, 94, 63];

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
//
// The final shift is LOGICAL, and that is the whole range of this function. With an arithmetic
// `>>`, bit 31 of `n >> 16` is bit 31 of `n`, so the XOR cancels it and the result can never have
// its top bit set: `hash2` returned [0, 0.5), `vnoise` inherited the bound, and every consumer
// with a threshold above 0.5 was dead code that rendered nothing. That was the `bare` dirt field
// (0.55) and all three TERRAIN_MACRO patches (0.55/0.60/0.57) — the entire macro-variation pass
// was authored against a range the helper had never had.
const hash2 = (i, j) => {
  let n = (i * 374761393 + j * 668265263) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
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
/**
 * A road path that comes back to where it started is an AREA, not a centreline.
 *
 * Reserve's dirt roads are all closed rings (12/12; no Customs or Woods road closes at all): the
 * builder handed the renderer the *outlines* of the gravel yards and the braided trails rather than
 * their spines. Stroking an outline at the road's own width traces both banks of the ribbon and
 * every hairpin twice, which is what the tangled tan loops at Reserve's east and west edges were.
 * Filling the ring instead draws the thing the outline describes.
 */
const isAreaRing = (path) => path.length > 3 && Math.hypot(path[0][0] - path[path.length - 1][0], path[0][1] - path[path.length - 1][1]) < 1;
/**
 * The dirt rim under every paved surface (R1.5, the plan's "edge darkening/dirt blending").
 *
 * A road that meets grass on a mathematically exact pixel edge is the single loudest "placed, not
 * built" cue in the frame. Three widening, fading strokes UNDER the road put a soft mud shoulder
 * around it instead — drawn into the same one baked texture, so it costs no layer, cannot z-fight,
 * and moves no road: the rim only ever darkens ground the road already touches.
 */
function drawRoadRim(ctx, data, rim) {
  const roads = (data.roads || []).filter((d) => Array.isArray(d.path) && d.path.length > 1);
  const rings = roads.filter((d) => isAreaRing(d.path));
  const lines = roads.filter((d) => !isAreaRing(d.path));
  ctx.save();
  for (let pass = rim.passes; pass >= 1; pass--) {
    const grow = (rim.widthMeters * pass) / rim.passes;
    ctx.globalAlpha = rim.alpha / rim.passes;
    ctx.strokeStyle = css(rgb255(rim.color));
    ctx.fillStyle = css(rgb255(rim.color));
    ctx.setLineDash([]);
    for (const poly of data.pavement || []) { ctx.lineWidth = grow * 2; if (trace(ctx, poly, true)) ctx.stroke(); }
    for (const d of rings) { ctx.lineWidth = grow * 2; if (trace(ctx, d.path, true)) ctx.stroke(); }
    for (const d of lines) { ctx.lineWidth = (d.width || 2) + grow * 2; if (trace(ctx, d.path)) ctx.stroke(); }
    for (const d of data.railway || []) { ctx.lineWidth = 3.4 + grow * 2; if (trace(ctx, d.path)) ctx.stroke(); }
  }
  ctx.restore();
}

function drawSurfaceNetwork(ctx, data, X0, Z0, mx, mz, SURFACE, rim = null) {
  ctx.save();
  ctx.setTransform(1 / mx, 0, 0, 1 / mz, -X0 / mx, -Z0 / mz);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';

  if (rim) drawRoadRim(ctx, data, rim);

  ctx.fillStyle = css(SURFACE.pavement);
  for (const poly of data.pavement || []) if (trace(ctx, poly, true)) ctx.fill();

  const roads = (data.roads || []).filter((d) => Array.isArray(d.path) && d.path.length > 1);
  const rings = roads.filter((d) => isAreaRing(d.path));
  const lines = roads.filter((d) => !isAreaRing(d.path));
  for (const d of rings) {
    const unpaved = d.kind === 'track' || d.kind === 'dirt';
    ctx.fillStyle = css(unpaved ? SURFACE.dirt : SURFACE.road);
    if (trace(ctx, d.path, true)) ctx.fill();
    strokeMapPath(ctx, d.path, unpaved ? SURFACE.dirtEdge : SURFACE.roadEdge, 0.7);
  }

  const paved = lines.filter((d) => d.kind !== 'track' && d.kind !== 'dirt');
  for (const d of paved) strokeMapPath(ctx, d.path, d.kind === 'highway' ? SURFACE.highwayEdge : SURFACE.roadEdge, d.width + 1.6);
  for (const d of paved) strokeMapPath(ctx, d.path, d.kind === 'highway' ? SURFACE.highway : SURFACE.road, d.width);
  for (const d of paved.filter((d) => d.kind === 'highway')) strokeMapPath(ctx, d.path, SURFACE.marking, 0.25, [6, 6]);

  for (const d of lines.filter((r) => r.kind === 'dirt')) {
    strokeMapPath(ctx, d.path, SURFACE.dirtEdge, d.width + 1.2);
    strokeMapPath(ctx, d.path, SURFACE.dirt, d.width);
  }
  for (const d of lines.filter((r) => r.kind === 'track')) {
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
export function buildTerrain(data, relief = 3, options = {}) {
  const look = resolveLook(options.look);
  const t = data.terrain;
  const { x0, z0, step, cols, rows } = t;
  relief = [1, 2, 3].includes(Number(relief)) ? Number(relief) : 3;
  const smoothed = gaussian5(t.heights, cols, rows, 1); // ~5 m sigma: smooth cell noise, retain surveyed crests
  // Re-assert the serialized basin after conditioning so blur cannot lift a bank or narrow pond
  // through its water plane. This uses the same levels/depths/falloff as the builder.
  const conditioned = carveWaterHeightfield(smoothed, t, data.water || []);
  // This is the sole relief transform. Everything below, including the exported H(), reads `grid`.
  const grid = Float32Array.from(conditioned, (h) => h * relief);
  const bicubicH = makeBicubic(grid, cols, rows, x0, z0, step);
  const capWater = makeWaterHeightCapper(data.water || [], relief);
  const H = (x, z) => capWater(bicubicH(x, z), x, z);
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
  const waterMask = rasterRings(allWaterRings(data.water || []), new Uint8Array(aw * ah), aw, ah, X0, Z0, AOC, AOC);
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

  /**
   * Bake the ground texture for ONE look.
   *
   * Everything above this point — the conditioned height field, H(), the fine raster, the AO
   * distance fields, and (below) the mesh — is look-independent and is built exactly once. The look
   * flip therefore changes a TEXTURE and a MATERIAL, never a vertex: the plan's rule that the
   * geometry cache key excludes `skin` holds by construction, and the two looks are guaranteed to
   * have an identical silhouette because they share one buffer.
   *
   *   vector    — the pre-Stage-1 cartographic sheet: 5-stop hypsometric ramp, strong two-light
   *               hillshade, slope tint, 2 m contours, then the road/rail symbols on top.
   *   realistic — no hypsometry and no contours at all. The base colour is a world-space blend of
   *               the contract's grass / forest-litter / dirt over macro noise, darkened on slope
   *               toward wet grass and then rock; the hillshade drops to a whisper because the
   *               scene key now lights the real mesh normals, and the Ground106 detail arrives in
   *               the shader (see atmosphere.js) rather than in this bake.
   */
  const bakeTexture = (mode) => {
    const C = paletteFor(mode);
    const realistic = mode === 'realistic';
    const S = realistic ? SHADE.realistic : SHADE.vector;
    const canvas = document.createElement('canvas');
    canvas.width = TEX_W; canvas.height = TH;
    const ctx = canvas.getContext('2d', { willReadFrequently: false });
    const img = ctx.createImageData(TEX_W, TH);
    const px8 = img.data;

    const SUN_DIR = sunDir(mode);
    const KEY = norm3([-SUN_DIR[0], -SUN_DIR[1], -SUN_DIR[2]]);
    const FILL = norm3([-FILL_DIR[0], -FILL_DIR[1], -FILL_DIR[2]]);
    const flatRaw = KEY[2] + 0.28 * FILL[2];      // response of a flat surface, so shade ~1 on the flats
    const GRAD_PX = 3;
    // Realistic ground stops, all from the frozen palette.
    const R_GRASS = C.grass, R_LITTER = C.grassHigh, R_DIRT = C.dirt, R_WET = C.grass1, R_ROCK = C.rock;
    const R_YARD = C.pavement;
    const MACRO = realistic ? terrainMacro().patches.map((p) => ({ ...p, rgb: rgb255(p.color) })) : [];

    for (let py = 0; py < TH_T; py++) {
      const gz = Z0 + (py + 0.5) * mz, o = py * TEX_W;
      const pyA = clamp(py - GRAD_PX, 0, TH_T - 1) * TEX_W, pyB = clamp(py + GRAD_PX, 0, TH_T - 1) * TEX_W;
      const dzSpan = (clamp(py + GRAD_PX, 0, TH_T - 1) - clamp(py - GRAD_PX, 0, TH_T - 1)) * mz || 1;
      for (let px = 0; px < TEX_W; px++) {
        const gx = X0 + (px + 0.5) * mx;
        const h = fine[o + px];
        let r, g, b;
        // gradient of the true field (both looks need it: slope drives colour AND the hillshade)
        const ia = clamp(px - GRAD_PX, 0, TEX_W - 1), ib = clamp(px + GRAD_PX, 0, TEX_W - 1);
        const dhdx = (fine[o + ib] - fine[o + ia]) / ((ib - ia) * mx || 1);
        const dhdz = (fine[pyB + px] - fine[pyA + px]) / dzSpan;
        const slope = Math.hypot(dhdx, dhdz);
        if (realistic) {
          // (a') land cover, NOT elevation. Two wide world-space noise fields decide how much of a
          // texel is open grass, forest litter or bare dirt. Nothing here reads `h`, so there are no
          // bands and no hypsometric read at any zoom.
          const cover = smoothstep(clamp((vnoise(gx + 211, gz - 137, 165) - 0.28) * 1.9, 0, 1));
          const bare = smoothstep(clamp((vnoise(gx - 389, gz + 57, 62) - 0.55) * 2.4, 0, 1));
          r = R_GRASS[0] + (R_LITTER[0] - R_GRASS[0]) * cover;
          g = R_GRASS[1] + (R_LITTER[1] - R_GRASS[1]) * cover;
          b = R_GRASS[2] + (R_LITTER[2] - R_GRASS[2]) * cover;
          r += (R_DIRT[0] - r) * bare * 0.5; g += (R_DIRT[1] - g) * bare * 0.5; b += (R_DIRT[2] - b) * bare * 0.5;
          // (b') R1.5 macro variation: large-scale autumn die-off / mud / dark-scrub splotches over
          // the land-cover base. Each patch is a thresholded value-noise field at its own frozen
          // wavelength and seed, so the three overlap into irregular blotches rather than a grid,
          // and none of them reads elevation — no bands, no hypsometric cue at any zoom.
          for (const patch of MACRO) {
            const w = smoothstep(clamp((vnoise(gx + patch.seed[0], gz + patch.seed[1], patch.wavelength) - patch.threshold) * patch.gain, 0, 1)) * patch.strength;
            if (w <= 0) continue;
            r += (patch.rgb[0] - r) * w; g += (patch.rgb[1] - g) * w; b += (patch.rgb[2] - b) * w;
          }
          // (c') slope: damp hollows first, then exposed rock on the steep faces.
          const wet = Math.min(0.35, Math.max(0, 0.09 - slope) * 3.4);
          r += (R_WET[0] - r) * wet; g += (R_WET[1] - g) * wet; b += (R_WET[2] - b) * wet;
          const rocky = Math.min(0.62, Math.max(0, slope - 0.22) * 1.5);
          r += (R_ROCK[0] - r) * rocky; g += (R_ROCK[1] - g) * rocky; b += (R_ROCK[2] - b) * rocky;
          if (yardMask?.[o + px]) {
            const earth = 0.92 + (vnoise(gx - 43, gz + 17, 11) - 0.5) * 0.1;
            r += (R_YARD[0] * earth - r) * 0.85; g += (R_YARD[1] * earth - g) * 0.85; b += (R_YARD[2] * earth - b) * 0.85;
          }
        } else {
          // (a) hypsometry — smoothstep across the 5 grass stops
          const f = clamp((h - hmin) / hspan, 0, 1) * (GRASS.length - 1);
          const k = Math.min(GRASS.length - 2, Math.floor(f)), u = smoothstep(f - k);
          const A = GRASS[k], B = GRASS[k + 1];
          r = A[0] + (B[0] - A[0]) * u; g = A[1] + (B[1] - A[1]) * u; b = A[2] + (B[2] - A[2]) * u;
          // (c) slope tint toward dry khaki — an independent relief cue
          const dry = Math.min(0.56, slope * 2.8);
          r += (GRASS_DRY[0] - r) * dry; g += (GRASS_DRY[1] - g) * dry; b += (GRASS_DRY[2] - b) * dry;
          const rocky = Math.min(0.34, Math.max(0, slope - 0.28) * 1.2);
          r += (GRASS_ROCK[0] - r) * rocky; g += (GRASS_ROCK[1] - g) * rocky; b += (GRASS_ROCK[2] - b) * rocky;
          if (yardMask?.[o + px]) {
            const earth = 0.82 + (vnoise(gx - 43, gz + 17, 11) - 0.5) * 0.12;
            r += (YARD_EARTH[0] * earth - r) * 0.88;
            g += (YARD_EARTH[1] * earth - g) * 0.88;
            b += (YARD_EARTH[2] * earth - b) * 0.88;
          }
        }
        // (b) two-light hillshade in deck space (Nx = +VE*dh/dx because deck X = -gameX)
        const nx = S.gain * dhdx, ny = S.gain * dhdz;
        const nl = Math.sqrt(nx * nx + ny * ny + 1);
        const horizontalFacing = (nx * KEY[0] + ny * KEY[1]) / nl;
        const raw = (Math.max(0, nx * KEY[0] + ny * KEY[1] + KEY[2]) + 0.28 * Math.max(0, nx * FILL[0] + ny * FILL[1] + FILL[2])) / nl;
        const lee = smoothstep(clamp((-horizontalFacing - 0.03) * 2.1, 0, 1)) * Math.min(1, slope * 5);
        const shade = clamp((1 + (raw - flatRaw) * S.contrast) * (1 - lee * 0.13), S.lo, S.hi);
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

    // (g) contours, drawn into the same canvas — perfectly smooth at any zoom, zero layers, no
    // z-fighting. Realistic mode draws none: contours are the single strongest "this is a map
    // board" signal, and Top-look decision 1 keeps them as a VECTOR-only parameter.
    if (styleFor(mode).flags.contours) drawContours(ctx, fine, TEX_W, TH_T, hmin, hmax, relief);
    // Roads/rail/pavement are last so map symbols cover contours exactly as they would on a printed
    // topographic sheet. This is still the terrain's one texture, not a second draped surface.
    // Realistic gets the dirt rim; vector is a diagram and a diagram's roads have clean edges.
    drawSurfaceNetwork(ctx, data, X0, Z0, mx, mz, surfaceFor(mode), realistic ? ROAD_RIM : null);

    // dev aid: ?debugtex shows the complete baked ground texture at 1:1.
    if (typeof location !== 'undefined' && location.search.includes('debugtex')) {
      canvas.style.cssText = 'position:fixed;left:280px;top:0;width:1100px;height:auto;z-index:9999;image-rendering:pixelated';
      setTimeout(() => document.body.appendChild(canvas), 0);
    }
    return canvas;
  };
  const bakes = new Map();
  const textureFor = (mode) => {
    const key = resolveLook(mode);
    if (!bakes.has(key)) bakes.set(key, bakeTexture(key));
    return bakes.get(key);
  };

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
  // Exact boundary clip. Keep only grid cells whose complete square is safely inside the ring;
  // the narrow remainder between that inset grid and the actual polygon is one constrained
  // earcut band. Its outer vertices are the <=2 m limit samples themselves, so neither the
  // terrain silhouette nor its skirt can inherit the old 2.5 m raster staircase.
  const centreInside = rasterRings([limit], new Uint8Array(NCX * NCZ), NCX, NCZ, X0, Z0, cw, ch);
  const nearEdge = new Uint8Array(NCX * NCZ), halfDiagonal = Math.hypot(cw, ch) / 2 + 1e-5;
  const segmentDistance = (x, z, a, b) => {
    const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1;
    const t = clamp(((x - a[0]) * dx + (z - a[1]) * dz) / l2, 0, 1);
    return Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz);
  };
  for (let q = 0; q < limit.length; q++) {
    const a = limit[q], b = limit[(q + 1) % limit.length];
    const i0 = clamp(Math.floor((Math.min(a[0], b[0]) - halfDiagonal - X0) / cw - 0.5), 0, NCX - 1);
    const i1 = clamp(Math.ceil((Math.max(a[0], b[0]) + halfDiagonal - X0) / cw - 0.5), 0, NCX - 1);
    const j0 = clamp(Math.floor((Math.min(a[1], b[1]) - halfDiagonal - Z0) / ch - 0.5), 0, NCZ - 1);
    const j1 = clamp(Math.ceil((Math.max(a[1], b[1]) + halfDiagonal - Z0) / ch - 0.5), 0, NCZ - 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = X0 + (i + 0.5) * cw, z = Z0 + (j + 0.5) * ch;
      if (segmentDistance(x, z, a, b) <= halfDiagonal) nearEdge[j * NCX + i] = 1;
    }
  }
  const full = new Uint8Array(NCX * NCZ);
  for (let k = 0; k < full.length; k++) full[k] = centreInside[k] && !nearEdge[k] ? 1 : 0;
  const kept = (i, j) => i >= 0 && j >= 0 && i < NCX && j < NCZ && full[j * NCX + i];
  const idx = [], insetEdges = [];
  for (let j = 0; j < NCZ; j++) for (let i = 0; i < NCX; i++) {
    if (!full[j * NCX + i]) continue;
    const a = j * NVX + i, b = a + 1, c = a + NVX + 1, d = a + NVX;
    idx.push(a, b, c, a, c, d);
    if (!kept(i, j - 1)) insetEdges.push([a, b]);
    if (!kept(i + 1, j)) insetEdges.push([b, c]);
    if (!kept(i, j + 1)) insetEdges.push([c, d]);
    if (!kept(i - 1, j)) insetEdges.push([d, a]);
  }
  // Stitch the exposed cell edges into one ring per inset component. Directed cell edges keep
  // filled ground on their left; a maximum-left-turn tie break separates diagonal point touches.
  const edgeStarts = new Map();
  insetEdges.forEach((edge, index) => { if (!edgeStarts.has(edge[0])) edgeStarts.set(edge[0], []); edgeStarts.get(edge[0]).push(index); });
  const edgeUsed = new Uint8Array(insetEdges.length), insetRings = [];
  const gridPoint = (vertex) => [X0 + (vertex % NVX) * cw, Z0 + Math.floor(vertex / NVX) * ch];
  for (let seed = 0; seed < insetEdges.length; seed++) {
    if (edgeUsed[seed]) continue;
    const vertices = [insetEdges[seed][0]]; let current = seed;
    for (let guard = 0; guard <= insetEdges.length; guard++) {
      edgeUsed[current] = 1;
      const end = insetEdges[current][1];
      if (end === vertices[0]) break;
      vertices.push(end);
      const candidates = (edgeStarts.get(end) || []).filter((edge) => !edgeUsed[edge]);
      if (!candidates.length) throw new Error('open inset terrain ring');
      if (candidates.length === 1) current = candidates[0];
      else {
        const from = insetEdges[current], a = gridPoint(from[0]), b = gridPoint(from[1]), dx = b[0] - a[0], dz = b[1] - a[1];
        current = candidates.sort((p, q) => {
          const pp = gridPoint(insetEdges[p][1]), qp = gridPoint(insetEdges[q][1]);
          const pa = Math.atan2(dx * (pp[1] - b[1]) - dz * (pp[0] - b[0]), dx * (pp[0] - b[0]) + dz * (pp[1] - b[1]));
          const qa = Math.atan2(dx * (qp[1] - b[1]) - dz * (qp[0] - b[0]), dx * (qp[0] - b[0]) + dz * (qp[1] - b[1]));
          return qa - pa;
        })[0];
      }
    }
    const ring = vertices.map(gridPoint);
    const signedArea = ring.reduce((sum, [x, z], i) => { const [nx, nz] = ring[(i + 1) % ring.length]; return sum + x * nz - nx * z; }, 0) / 2;
    if (ring.length >= 4 && signedArea > 1e-4) insetRings.push(ring);
  }

  const bandRings = [limit, ...insetRings], bandPoints = [], holes = [];
  for (let r = 0; r < bandRings.length; r++) {
    if (r) holes.push(bandPoints.length);
    bandPoints.push(...bandRings[r]);
  }
  const flatBand = bandPoints.flat(), bandIndices = earcut(flatBand, holes, 2);
  const deviation = earcut.deviation(flatBand, holes, 2, bandIndices);
  if (!bandIndices.length || deviation > 1e-5) throw new Error(`exact terrain boundary triangulation failed (deviation ${deviation})`);

  const TOT = NV + bandPoints.length;
  const positions = new Float32Array(TOT * 3), normals = new Float32Array(TOT * 3), texCoords = new Float32Array(TOT * 2);
  positions.set(pos); normals.set(nrm); texCoords.set(uv);
  for (let i = 0; i < bandPoints.length; i++) {
    const [gx, gz] = bandPoints[i], k = NV + i, h = H(gx, gz);
    positions[k * 3] = -gx; positions[k * 3 + 1] = -gz; positions[k * 3 + 2] = h;
    const dhdx = (H(gx + E, gz) - H(gx - E, gz)) / (2 * E), dhdz = (H(gx, gz + E) - H(gx, gz - E)) / (2 * E);
    const nl = Math.sqrt(dhdx * dhdx + dhdz * dhdz + 1);
    normals[k * 3] = dhdx / nl; normals[k * 3 + 1] = dhdz / nl; normals[k * 3 + 2] = 1 / nl;
    texCoords[k * 2] = clamp((gx - X0) / W, 0, 1); texCoords[k * 2 + 1] = clamp((gz - Z0) / D, 0, 1) * vTop;
  }
  for (const vertex of bandIndices) idx.push(NV + vertex);
  const indices = new Uint32Array(idx); // > 65k vertices: WebGL2 requires 32-bit indices
  const cliffEdges = limit.map((_, i) => [NV + i, NV + ((i + 1) % limit.length)]);

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
  /*
   * R1.5 — the skirt is feathered into the backdrop instead of ending on a hard band.
   *
   * COLOR_0 is a per-vertex MULTIPLIER on the layer's colour (SimpleMeshLayer: `vColor = colors *
   * instanceColors.rgb`), so one attribute turns the flat wall into a vertical ramp from the
   * contract's `skirtTop` earth value down toward `skirtBottom`, which is the void haze the plane
   * below it is painted with. The skirt is fogged as well, so the far side of the map loses the
   * edge entirely and the near side keeps a readable thickness. In vector the two colours are equal
   * and this is exactly a no-op.
   */
  const cliffCol = new Float32Array(cliffVerts.length * 2 * 3);
  // Built from the REALISTIC ramp unconditionally, because a buffer may not depend on the look —
  // the flip is a material state and the geometry cache key excludes it. Vector is unaffected in
  // practice: its skirt colour is already the void value, so a 0.76 multiplier on #0c0e0d lands
  // within a value of itself against a black background.
  const ramp = skirtRamp('realistic');
  const rampK = ramp.top.map((c, i) => (c > 0 ? 1 + ((ramp.bottom[i] / c) - 1) * ramp.feather : 1));
  for (let i = 0; i < cliffVerts.length; i++) {
    const v = cliffVerts[i], src = v * 3, top = i * 3, bottom = (i + cliffVerts.length) * 3;
    cliffPos.set([positions[src], positions[src + 1], positions[src + 2]], top);
    cliffPos.set([positions[src], positions[src + 1], voidZ], bottom);
    cliffNrm.set([0, 0, 1], top); cliffNrm.set([0, 0, 1], bottom); // ignored by material:false
    cliffCol.set([1, 1, 1], top); cliffCol.set(rampK, bottom);
  }
  for (let i = 0; i < cliffEdges.length; i++) {
    const a = cliffMap.get(cliffEdges[i][0]), b = cliffMap.get(cliffEdges[i][1]), q = i * 6;
    cliffIdx.set([a, b, b + cliffVerts.length, a, b + cliffVerts.length, a + cliffVerts.length], q);
  }
  const cliffMesh = new Geometry({
    topology: 'triangle-list',
    attributes: { POSITION: { value: cliffPos, size: 3 }, NORMAL: { value: cliffNrm, size: 3 }, COLOR_0: { value: cliffCol, size: 3 } },
    indices: { value: cliffIdx, size: 1 },
  });

  /* ================================================================ water surface (R1.5)
   *
   * The realistic water is a MESH welded out of the ground grid, not a flat polygon fill, because
   * the thing the plan asks for — "tint shallow water toward muddy/olive sediment, deepen toward
   * blue-gray ... slightly reveal the carved bed near shore" — needs per-fragment DEPTH, and the
   * only honest source of depth is the carved bed the heightfield already carries. A
   * SolidPolygonLayer has vertices at the shoreline and nowhere else, so it has no depth to shade.
   *
   * Each grid vertex inside (or one cell outside) a water body gets:
   *   COLOR_0.r = (level - bed) / WATER.depthMaxMeters, in REAL game metres
   *   COLOR_0.g = 1 inside the ring, 0 outside it -> the 2.5 m interpolation across a boundary cell
   *               IS the soft shore, with no distance field and no second layer
   * and sits at the body's own evidence-backed level. src/atmosphere.js's WaterExtension decodes
   * both. Vector keeps its flat SolidPolygonLayer fill (Part C's flip table), so this mesh is only
   * ever bound in realistic mode.
   */
  const waterBodies = (data.water || []).filter((w) => waterPoly(w).length >= 3);
  let waterMesh = null;
  const waterStats = { verts: 0, tris: 0 };
  if (waterBodies.length) {
    const depthMax = Math.max(0.1, waterTuning().depthMaxMeters);
    let padCells = 2;
    const specs = waterBodies.map((w) => {
      const ring = waterPoly(w), holes = waterHoles(w), bank = Number.isFinite(w.bank) ? w.bank : 5;
      const pad = Math.max(bank, cw * 2, ch * 2);
      padCells = Math.max(padCells, Math.ceil(pad / Math.min(cw, ch)));
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const [x, z] of ring) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
      return { w, ring, holes, x0: x0 - pad, x1: x1 + pad, z0: z0 - pad, z1: z1 + pad };
    });
    const level = new Float32Array(NV), inside = new Uint8Array(NV), covered = new Uint8Array(NV);
    /*
     * A vertex takes the surface level of a body that CONTAINS it — never of one whose padded
     * bounding box merely reaches it.
     *
     * The bbox version of this loop flooded Woods: body #9 (level 9.91) has a bbox of roughly
     * x[-851,174] z[-949,252], i.e. most of the map, so every vertex of the southern lake (#10,
     * level -13.07) north of z=252 took 9.91 and the sheet sat up to 23 m above its own shoreline,
     * with a vertical tear along z=252 where that bbox stopped. `waterLevelAt()` answers for any
     * point, so a bbox test is not a containment test; only `pointInRing` is. This is the same rule
     * `waterSurfaceAt()` in src/water.js has always used for everything else that asks for a level.
     */
    const q = [];
    for (let j = 0; j < NVZ; j++) {
      const gz = Z0 + j * ch;
      for (let i = 0; i < NVX; i++) {
        const gx = X0 + i * cw, k = j * NVX + i;
        let best = null;
        for (const s of specs) {
          if (gx < s.x0 || gx > s.x1 || gz < s.z0 || gz > s.z1) continue;
          if (!pointInRing([gx, gz], s.ring) || s.holes.some((hole) => pointInRing([gx, gz], hole))) continue;
          const l = waterLevelAt(s.w, gx, gz);
          if (l == null) continue;
          if (best == null || l > best) best = l;
        }
        if (best == null) continue;
        covered[k] = 1; level[k] = best; inside[k] = 1; q.push(k);
      }
    }
    /*
     * The shore pad: `padCells` rings of vertices grown OUTWARD from the wet ones, each carrying
     * the level of the wet vertex it grew from. That is the "nearest containing body" fallback the
     * bank needs, done on the grid the mesh is already made of — so a pad vertex can only ever
     * inherit a level from across ~5 m of shoreline, and never from a body on the far side of the
     * map. `inside` stays 0 out here, which is what makes the 2.5 m interpolation across the
     * boundary cell the soft shore (see the COLOR_0 note above).
     */
    for (let ring = 0, head = 0; ring < padCells; ring++) {
      const end = q.length;
      for (; head < end; head++) {
        const k = q[head], i = k % NVX, j = (k - i) / NVX;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ni = i + di, nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= NVX || nj >= NVZ) continue;
          const nk = nj * NVX + ni;
          if (covered[nk]) continue;
          covered[nk] = 1; level[nk] = level[k]; q.push(nk);
        }
      }
    }
    const waterIdx = [], remap = new Map();
    const use = (k) => { let n = remap.get(k); if (n === undefined) { n = remap.size; remap.set(k, n); } return n; };
    for (let j = 0; j < NCZ; j++) for (let i = 0; i < NCX; i++) {
      // Clipped to the playable limit exactly like the ground mesh (`full[]` above). A water ring
      // may cross the boundary — 242 of Woods' 1532 ring points do — and an unclipped sheet is
      // emitted past the terrain silhouette, floating over the void plane and overhanging the cliff
      // skirt. The old flat fill had the same footprint but no Fresnel sky term to make it obvious.
      if (!full[j * NCX + i]) continue;
      const a = j * NVX + i, b = a + 1, c = a + NVX + 1, d = a + NVX;
      if (!(covered[a] && covered[b] && covered[c] && covered[d])) continue;
      if (!(inside[a] || inside[b] || inside[c] || inside[d])) continue;
      waterIdx.push(use(a), use(b), use(c), use(a), use(c), use(d));
    }
    if (remap.size >= 3 && waterIdx.length) {
      const n = remap.size;
      const wPos = new Float32Array(n * 3), wNrm = new Float32Array(n * 3), wCol = new Float32Array(n * 3);
      for (const [k, slot] of remap) {
        const i = k % NVX, j = (k - i) / NVX, gx = X0 + i * cw, gz = Z0 + j * ch;
        const surface = level[k];
        // H() is already relief-scaled; the depth tint is authored in REAL metres, so divide back.
        const bed = H(gx, gz) / relief;
        wPos[slot * 3] = -gx; wPos[slot * 3 + 1] = -gz; wPos[slot * 3 + 2] = surface * relief;
        wNrm[slot * 3] = 0; wNrm[slot * 3 + 1] = 0; wNrm[slot * 3 + 2] = 1;
        wCol[slot * 3] = clamp(Math.max(0, surface - bed) / depthMax, 0, 1);
        wCol[slot * 3 + 1] = inside[k];
        wCol[slot * 3 + 2] = 0;
      }
      waterMesh = new Geometry({
        topology: 'triangle-list',
        attributes: { POSITION: { value: wPos, size: 3 }, NORMAL: { value: wNrm, size: 3 }, COLOR_0: { value: wCol, size: 3 } },
        indices: { value: new Uint32Array(waterIdx), size: 1 },
      });
      waterStats.verts = n; waterStats.tris = waterIdx.length / 3;
    }
  }

  /**
   * The ground mesh layer for one look.
   *
   * `extra.groundExtension` is the realistic-mode Ground106 triplanar material from atmosphere.js;
   * `extra.fogExtension` is the shared world fog. Both are LayerExtensions on the SAME mesh, so a
   * look flip changes `extensions` + `texture` + `material` and nothing else.
   */
  const layer = (mode = look, extra = {}) => {
    const extensions = [extra.groundExtension, extra.fogExtension].filter(Boolean);
    return new SimpleMeshLayer({
      id: 'terrain',
      data: [{ p: [0, 0, 0] }],
      getPosition: (d) => d.p,
      mesh,
      texture: textureFor(mode),
      getColor: [255, 255, 255],
      sizeScale: 1,
      shadowEnabled: false, // see the shadow note below
      pickable: false,
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      textureParameters: {
        minFilter: 'linear', mipmapFilter: 'linear', magFilter: 'linear',
        addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', maxAnisotropy: 16,
      },
      material: terrainMaterialFor(mode),
      extensions,
    });
  };
  const cliffLayer = (mode = look, extra = {}) => new SimpleMeshLayer({
    id: 'cliff', data: [{ p: [0, 0, 0] }], getPosition: (d) => d.p, mesh: cliffMesh,
    // Realistic: the skirt is the far edge of the world, so it takes the void value, which is
    // itself the far-fog colour darkened — the map stops at atmosphere, not at a black band.
    getColor: paletteFor(mode).cliff.slice(0, 3), sizeScale: 1, material: false, shadowEnabled: false, pickable: false,
    parameters: { cullMode: 'none' }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
    extensions: extra.fogExtension ? [extra.fogExtension] : [],
  });

  /**
   * The realistic water surface, or `null` when this map has no water / the look is vector.
   *
   * `getColor: [255,255,255]` is load-bearing, not a default: SimpleMeshLayer computes
   * `vColor = colors * instanceColors.rgb`, so a white instance colour is what lets the extension
   * read COLOR_0's depth and inside flags back out unchanged. `material: false` because the
   * extension does all the shading; `depthWriteEnabled: false` because a translucent surface that
   * writes depth hides everything drawn behind it afterwards.
   */
  const waterLayer = (mode = look, extra = {}) => {
    if (!waterMesh || !extra.waterExtension) return null;
    return new SimpleMeshLayer({
      id: 'water-surface',
      data: [{ p: [0, 0, 0] }],
      getPosition: (d) => d.p,
      mesh: waterMesh,
      getColor: [255, 255, 255],
      sizeScale: 1,
      material: false,
      shadowEnabled: false,
      pickable: false,
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      parameters: { depthWriteEnabled: false, cullMode: 'none' },
      extensions: [extra.waterExtension, ...(extra.fogExtension ? [extra.fogExtension] : [])],
    });
  };

  // NOTE on cast shadows (`_shadow: true` on the sun): they render correctly under OrbitView, but
  // deck gates casting AND receiving on the same `shadowEnabled` prop, so a ground surface that
  // receives building shadows also shadow-maps itself. Over a kilometre-scale relief surface lit at ~40
  // degrees, the depth16 shadow map has nowhere near the precision for that and the whole map goes
  // into acne. Verified in headless. Relief therefore comes from the mesh normals plus the baked
  // two-light hillshade, which need no extra pass.

  const maxBoundaryStep = limit.reduce((largest, point, i) => Math.max(largest, Math.hypot(point[0] - limit[(i + 1) % limit.length][0], point[1] - limit[(i + 1) % limit.length][1])), 0);
  return {
    H,
    voidZ,
    /** `layers(look, {fogExtension, groundExtension})` — geometry is shared, only material changes. */
    layers: (mode = look, extra = {}) => [cliffLayer(mode, extra), layer(mode, extra)],
    /** The realistic depth-tinted water surface, or `null`. Vector keeps map3d's flat fill. */
    waterLayer,
    hasWaterMesh: () => Boolean(waterMesh),
    /** Pre-bake a look's texture so a toggle does not stall on 2048x1110 of canvas work. */
    prebake: (mode) => { textureFor(mode); },
    /** Resident bytes of every baked ground texture currently held (RGBA8, no mips). */
    textureBytes: () => bakes.size * TEX_W * TH * 4,
    stats: { relief, range: [hmin, hmax], verts: TOT, tris: indices.length / 3, cliffSegments: cliffEdges.length, boundaryVerts: limit.length, boundaryBandTris: bandIndices.length / 3, fullCells: full.reduce((sum, value) => sum + value, 0), maxBoundaryStep, tex: [TEX_W, TH], water: waterStats },
  };
}

// ---------------------------------------------------------------- contours (baked, not a layer)
// marching squares on the fine bicubic field, Chaikin-smoothed twice, stroked straight onto the texture.
// 2 m minors / 10 m index lines: at 1 m the 11 m range draws concentric bullseyes around every dome.
// The interval is 2 REAL metres, so it is stepped by `relief` — the field handed in here is already
// exaggerated. Without that, 3x relief drew a line every 67 cm of real ground: three times the ink
// the map wants, and on Woods (a 145 m exaggerated range) 73 marching-squares passes over a 2048px
// raster instead of 24, which was the largest single cost in a Woods first paint.
function drawContours(ctx, fine, gw, gh, hmin, hmax, relief = 1) {
  const SS = 4;                                   // sample every 4th texel
  const step = 2 * (relief > 0 ? relief : 1), major = 10 * (relief > 0 ? relief : 1);
  const nx = Math.floor(gw / SS), nz = Math.floor(gh / SS);
  const at = (i, j) => fine[Math.min(gh - 1, j * SS) * gw + Math.min(gw - 1, i * SS)];
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (let lv = Math.ceil(hmin / step) * step; lv <= hmax; lv += step) {
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
    const isIndex = Math.abs(lv % major) < 1e-6;
    ctx.strokeStyle = isIndex ? 'rgba(20,32,20,0.38)' : 'rgba(26,42,26,0.20)';
    ctx.lineWidth = isIndex ? 1.45 : 0.9;
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
