// 3D view: deck.gl OrbitView (orthographic, tilted) over the same game-coordinate data as the 2D map.
// deck cartesian = [-gameX, -gameZ, gameY] so on-screen orientation matches the 2D map at 0° orbit.
import { Deck, OrbitView, COORDINATE_SYSTEM } from '@deck.gl/core';
import { SolidPolygonLayer, PathLayer, IconLayer, TextLayer, LineLayer, ScatterplotLayer } from '@deck.gl/layers';
import { PathStyleExtension } from '@deck.gl/extensions';
import { KINDS, iconDataUrl, arrowDataUrl, soldierDataUrl, extractLetter, extractReq, subText, dotRgb, clusterCount } from './icons.js';
import { updateTier, currentTier, cellFor, clusterPoints, countsVisible } from './lod.js';
import { esc, COLORS } from './live.js';
import { buildTerrain } from './terrain.js'; // TRACK B: smooth terrain mesh + baked ground texture
import { prepareTrees, treeLayers } from './trees.js';
import { makeWaterHeightCapper, waterLevelAt, waterRings, waterSurfaceAt } from './water.js';
import { CAM, clampCamera } from './camera.js';
import {
  resolveLook, DEFAULT_LOOK, paletteFor, lightingFor, backgroundFor, backgroundCss,
  fogExtensionFor, limitDiagonal, fogParams, postFor, surfaceMaterial, referenceGroundMeters,
  loadRenderAssets, createGroundTextures, createLutTexture, groundDetailExtensionFor, gradeEffectFor,
  waterExtensionFor, voidMargin, shadowRings, materialTint,
} from './atmosphere.js';
import { buildingMaterialId, roofMaterialId } from './render-style.js';
// Where a building's walls meet the ground, and what fills the downhill gap. Pure module, shared
// verbatim with scripts/building-height-test.mjs — see its header for the foundation bug it exists
// to prevent.
import {
  placeBuildings as seatBuildings, seatBuilding, floorLevels, plinthColor, PLINTH_EXPAND_M,
} from './buildings.js';

/* ------------------------------------------------------------------ the look ---
 * `C` is the one colour table every recipe in this module draws from. Stage 1 makes it a function
 * of the render style: `vector` is the pre-Stage-1 table value for value, `realistic` is the same
 * key set re-tuned from the frozen contract in src/render-style.js.
 *
 * It is a module-level `let` because the ~20 building/prop/scene recipes below are module-level
 * functions that all read it. Only one 3D view exists at a time (createView3d owns the single deck
 * instance), so a single binding is correct; `applyLook()` is the only writer and it runs before
 * any layer is rebuilt.
 */
let LOOK = DEFAULT_LOOK;
let C = paletteFor(LOOK);
let CONTAINER_TINTS = C.containerTints;
// Flat-roof colours for the landmarks the build script only colours the walls of. Seen from a
// tilted top-down camera the roof IS the building, so a landmark whose roof is generic grey is
// unrecognisable from overview zoom.
const roofByPlace = (t) => (t === 'realistic'
  ? { 'Dorms 2-Story': [146, 108, 92], 'Dorms 3-Story': [146, 108, 92], 'Big Red': [134, 90, 76],
      'Fortress': [136, 134, 124], 'Oil Rig': [132, 130, 120], 'Military Checkpoint': [135, 133, 123], 'Old Gas': [137, 135, 125] }
  : { 'Dorms 2-Story': [148, 94, 75], 'Dorms 3-Story': [148, 94, 75], 'Big Red': [142, 76, 63],
      'Fortress': [134, 127, 116], 'Oil Rig': [134, 126, 114], 'Military Checkpoint': [139, 132, 120], 'Old Gas': [141, 134, 121] });
let ROOF_BY_PLACE = roofByPlace(LOOK);
const propColors = (t) => (t === 'realistic'
  ? { container: [104, 119, 111], tank: [157, 155, 144], tanker: [164, 162, 151], railcar: [96, 90, 83],
      vehicle: [102, 111, 114], crane: [184, 156, 80], wall: [141, 139, 129], pipe: [126, 124, 115] }
  : { container: [164, 88, 69], tank: [181, 186, 184], tanker: [188, 190, 190], railcar: [105, 97, 90],
      vehicle: [130, 139, 145], crane: [204, 166, 68], wall: [176, 170, 157], pipe: [153, 150, 141] });
let PROP_COLORS = propColors(LOOK);

/** Point every module-level colour table at one look. The ONLY writer of `C`. */
function applyLook(look) {
  LOOK = resolveLook(look);
  C = paletteFor(LOOK);
  CONTAINER_TINTS = C.containerTints;
  ROOF_BY_PLACE = roofByPlace(LOOK);
  PROP_COLORS = propColors(LOOK);
  return LOOK;
}
const P = ([x, z], y = 0) => [-x, -z, y];
let BASE_H = () => 0, H = () => 0; // canonical surface samplers; set once data is loaded
let WATER = [], RELIEF = 3;
const Pg = ([x, z], dy = 0) => P([x, z], H(x, z) + dy); // draped point
const ringG = (poly, dy = 0) => poly.map((p) => Pg(p, dy));
const waterPoint = (water, [x, z], dy = 0) => {
  const level = waterLevelAt(water, x, z);
  return P([x, z], level == null ? H(x, z) + dy : level * RELIEF + dy);
};
const waterPolygon = (water, dy = 0) => {
  const rings = waterRings(water).map((ring) => ring.map((point) => waterPoint(water, point, dy)));
  return rings.length === 1 ? rings[0] : rings;
};
const bridgeGround = (point) => {
  const water = waterSurfaceAt(WATER, point);
  return Math.max(H(point[0], point[1]), water == null ? -Infinity : water * RELIEF);
};
function makeSampler(t, relief = 3) {
  const { x0, z0, step, cols, rows, heights } = t;
  return (x, z) => {
    const fx = Math.min(Math.max((x - x0) / step, 0), cols - 1.001), fz = Math.min(Math.max((z - z0) / step, 0), rows - 1.001);
    const c = Math.floor(fx), r = Math.floor(fz), tx = fx - c, tz = fz - r;
    const h00 = heights[r * cols + c], h10 = heights[r * cols + c + 1], h01 = heights[(r + 1) * cols + c], h11 = heights[(r + 1) * cols + c + 1];
    return ((h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz) * relief;
  };
}
const inPolyXZ = ([x, z], poly) => { let inside = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, zi] = poly[i], [xj, zj] = poly[j]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside; } return inside; };
/**
 * H(x, z) — the canonical ground sampler: the terrain, raised to the top of any hard rock the point
 * is inside. This is the hottest function in the module (every draped vertex, every tree, every
 * drop-line, the tooltip; ~1e5 calls in a first paint), so it is written for the common case:
 *
 *  - no hard rocks at all (Customs) -> it IS the bicubic sampler, with no wrapper cost;
 *  - a point nowhere near a rock (almost every point) -> rejected on a precomputed bounding box,
 *    which is 4 comparisons instead of a point-in-polygon walk. Woods' 7 rocks carry 497 edges
 *    between them, and the old version ran all of them, plus two array allocations, per call.
 */
function makeSurfaceSampler(base, hardRocks = [], relief = 1) {
  const rocks = (hardRocks ?? []).filter((r) => Array.isArray(r?.poly) && r.poly.length >= 3).map((rock) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [px, pz] of rock.poly) {
      if (px < x0) x0 = px; if (px > x1) x1 = px;
      if (pz < z0) z0 = pz; if (pz > z1) z1 = pz;
    }
    return { poly: rock.poly, x0, x1, z0, z1, surfaceY: Number.isFinite(rock.surfaceY) ? rock.surfaceY * relief : null, lift: rock.height * relief };
  });
  if (!rocks.length) return base;
  return (x, z) => {
    const ground = base(x, z);
    let h = ground;
    for (const r of rocks) {
      if (x < r.x0 || x > r.x1 || z < r.z0 || z > r.z1) continue;
      if (!inPolyXZ([x, z], r.poly)) continue;
      // Each rock is measured from the TERRAIN, never from another rock's roof.
      const top = r.surfaceY ?? ground + r.lift;
      if (top > h) h = top;
    }
    return h;
  };
}
let VOID_Z = -14;
// R1.5: the margin is a parameter, because the realistic void plane is no longer a 60 m apron under
// the map — it is the ground haze the diorama sits in, and it has to reach far enough past the
// limit that the world fog can carry it all the way to the far-fog value before it runs out.
/*
 * The backdrop plane, as a GRID of quads rather than one rectangle.
 *
 * The fog is written per VERTEX (`vs:DECKGL_FILTER_GL_POSITION` in src/atmosphere.js) and
 * interpolated across the primitive. A rectangle has four vertices, all of them out past
 * `1.4 x map diagonal`, and all four clamp to `FOG.realistic.maxDensity` — and a varying
 * interpolated between four identical values is a CONSTANT. So the whole backdrop, including the
 * band just outside the limit where the true fog value is 0.00-0.05, rendered at a uniform
 * `mix(ground haze, far fog, 0.92)`: 8% of the darker ground colour survived and the near-dark →
 * far-haze ramp the plane exists for never appeared anywhere on it. (The horizon gradient visible
 * in the frames is the grade pass's screen-space `skyness` ramp — a different mechanism, above the
 * horizon, doing nothing for this.)
 *
 * Breaks are square-law from each limit edge outward, so the vertices are dense where the fog
 * curve bends hardest (just past the limit) and sparse where it has already flattened at
 * maxDensity. 900 quads, one draw call, and no change to the plane's colour, height or extent.
 * `outward = 12` is where the worst linear-interpolation error against the true exponential drops
 * under 0.035 on all three maps (it is 0.069 on Reserve at 8, and 16 only buys another 0.005).
 */
function voidGrid(limit, m = 60, outward = 12, across = 6) {
  const xs = limit.map((p) => p[0]), zs = limit.map((p) => p[1]);
  const breaks = (lo, hi) => {
    const b = [];
    for (let i = outward; i >= 1; i--) b.push(lo - m * (i / outward) ** 2);
    for (let i = 0; i <= across; i++) b.push(lo + ((hi - lo) * i) / across);
    for (let i = 1; i <= outward; i++) b.push(hi + m * (i / outward) ** 2);
    return b;
  };
  const bx = breaks(Math.min(...xs), Math.max(...xs)), bz = breaks(Math.min(...zs), Math.max(...zs));
  const quads = [];
  for (let j = 0; j + 1 < bz.length; j++) {
    for (let i = 0; i + 1 < bx.length; i++) {
      quads.push([[bx[i], bz[j]], [bx[i + 1], bz[j]], [bx[i + 1], bz[j + 1]], [bx[i], bz[j + 1]]]);
    }
  }
  return quads;
}
/** The same plane as one rectangle: what the backdrop is when no fog needs a gradient across it. */
function voidQuad(limit, m = 60) {
  const xs = limit.map((p) => p[0]), zs = limit.map((p) => p[1]);
  const x0 = Math.min(...xs) - m, x1 = Math.max(...xs) + m;
  const z0 = Math.min(...zs) - m, z1 = Math.max(...zs) + m;
  return [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
}
const OVERLAY = { depthCompare: 'always', depthWriteEnabled: false };
// One instance, reused: a fresh LayerExtension every render() makes deck rebuild the shader.
const dashExt = new PathStyleExtension({ dash: true });
// One SDF recipe for every TextLayer so glyph weight is identical across major/minor/extract text.
const LABEL_SDF = { sdf: true, fontSize: 64, buffer: 8, radius: 12 };
// The requirement line under an extract name now lives in icons.js — the 2D popup, the 2D hover
// chip and the 3D chip all quote the same string, and the badge's corner glyph is keyed off the
// same table. It is no longer drawn permanently: only on hover or selection (step 4).
// short form = full name minus any parenthetical: "Smugglers' Bunker (ZB-1012)" -> "SMUGGLERS' BUNKER"
const shortName = (n) => (n || '').replace(/\s*\([^)]*\)\s*/g, ' ').trim().toUpperCase();
const EXTRACT_ACCENT = { 'extract-pmc': C.accentExtract, 'extract-scav': C.accentExtractScav, 'extract-transit': C.accentExtractTransit, 'extract-shared': C.accentExtractNeutral };
const markerLevel = (m) => ['surface', 'underground', 'rooftop', 'upper'].includes(m?.level) ? m.level : 'surface';
const levelSuffix = (m) => markerLevel(m) === 'surface' ? '' : ` · ${markerLevel(m).toUpperCase()}`;
const markerIconKey = (m) => {
  const isExtract = m.kind.startsWith('extract');
  const letter = isExtract ? extractLetter(m.name) : null;
  const req = isExtract ? extractReq(m.name) : null;
  return `${m.kind}${letter ? `:${letter}` : ''}${markerLevel(m) === 'surface' ? '' : `:${markerLevel(m)}`}${req ? `:${req}` : ''}`;
};

// icons/labels always on top of geometry
const ringAt = (poly, y) => poly.map((p) => P(p, y));
const expand = (poly, m) => { const c = poly.reduce((a, p) => [a[0] + p[0] / poly.length, a[1] + p[1] / poly.length], [0, 0]); return poly.map(([x, z]) => { const dx = x - c[0], dz = z - c[1], L = Math.hypot(dx, dz) || 1; return [x + (dx / L) * m, z + (dz / L) * m]; }); };
// Bridge height is local to the road, never an absolute world Z. Keeping the local lift separate
// is important: relief may make the sampled ground negative, but that must not delete a pier.
function bridgeProfile(b) {
  const p = b.path, cum = [0]; for (let i = 1; i < p.length; i++) cum.push(cum[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]));
  const L = cum[cum.length - 1], ramp = Math.min(15, L / 3);
  return p.map((pt, i) => { const t = cum[i]; return { pt, lift: t < ramp ? (t / ramp) * b.height : t > L - ramp ? ((L - t) / ramp) * b.height : b.height }; });
}
const bridgePath = (b) => bridgeProfile(b).map(({ pt, lift }) => P(pt, bridgeGround(pt) + lift + 0.1));
// offset a 3D path sideways by d metres (for railings on both sides of a deck)
function offsetPath(p, d) {
  return p.map((q, i) => { const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)]; const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1; return [q[0] - (dy / L) * d, q[1] + (dx / L) * d, q[2]]; });
}
function piers(b) {
  if (b.ford) return [];
  const p = bridgeProfile(b), out = [];
  for (let i = 3; i < p.length - 3; i += 3) {
    if (p[i].lift < b.height - 0.01) continue;
    const top = P(p[i].pt, bridgeGround(p[i].pt) + p[i].lift - 0.05), bottom = H(p[i].pt[0], p[i].pt[1]) + 0.25;
    out.push({ pos: top, bottom, h: Math.max(0.2, top[2] - bottom), w: b.width * 0.5 });
  }
  return out;
}
// ---- building identity geometry
// oriented bounding rectangle (min area over edge directions) -> 4 corners in game coords, long axis first
function obb(poly) {
  let best = null;
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length]; const L = Math.hypot(bx - ax, bz - az); if (L < 0.5) continue;
    const ux = (bx - ax) / L, uz = (bz - az) / L; // axis
    let mn = [Infinity, Infinity], mx = [-Infinity, -Infinity];
    for (const [x, z] of poly) { const u = x * ux + z * uz, v = -x * uz + z * ux; mn = [Math.min(mn[0], u), Math.min(mn[1], v)]; mx = [Math.max(mx[0], u), Math.max(mx[1], v)]; }
    const a = (mx[0] - mn[0]) * (mx[1] - mn[1]);
    if (!best || a < best.a) best = { a, ux, uz, mn, mx };
  }
  const { ux, uz, mn, mx } = best; const toXZ = (u, v) => [u * ux - v * uz, u * uz + v * ux];
  const long = mx[0] - mn[0] >= mx[1] - mn[1];
  return { corners: [toXZ(mn[0], mn[1]), toXZ(mx[0], mn[1]), toXZ(mx[0], mx[1]), toXZ(mn[0], mx[1])], long, toXZ, mn, mx };
}
const polyArea = (poly) => Math.abs(poly.reduce((a, [x, z], i) => { const [nx, nz] = poly[(i + 1) % poly.length]; return a + x * nz - nx * z; }, 0)) / 2;
// hip roof: four slopes from the eaves up to a ridge along the long axis (no open gable ends)
function hipRoof(b) {
  const o = obb(b.poly), eave = b.height * 0.72, ridge = b.height + 0.4, { mn, mx, toXZ } = o;
  let [u0, u1, v0, v1] = [mn[0], mx[0], mn[1], mx[1]];
  if (!o.long) [u0, u1, v0, v1] = [mn[1], mx[1], mn[0], mx[0]];
  const T = o.long ? toXZ : (u, v) => toXZ(v, u);
  const w = v1 - v0, vm = (v0 + v1) / 2, r0 = u0 + w / 2, r1 = u1 - w / 2; // ridge inset by half width
  const E = (u, v) => [...T(u, v), eave], R = (u) => [...T(u, vm), ridge];
  return [
    [E(u0, v0), E(u1, v0), R(r1), R(r0)],
    [R(r0), R(r1), E(u1, v1), E(u0, v1)],
    [E(u0, v0), R(r0), E(u0, v1)],
    [E(u1, v0), E(u1, v1), R(r1)],
  ];
}
// only near-rectangular footprints get a pitched roof; L-shapes etc. stay flat so walls always sit under the roof
function isRectangular(poly) { const o = obb(poly); const a = (o.mx[0] - o.mn[0]) * (o.mx[1] - o.mn[1]); return polyArea(poly) / a > 0.85; }
function columns(poly, spacing = 6) { const out = []; for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); const n = Math.max(1, Math.round(L / spacing)); for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]); } return out; }
// Lattice pylon: 4 legs tapering inward over 3 stacked segments, two cross-arms, insulator dots
// and diagonal bracing. Straight untapered posts were the most obviously-CG thing on the ridge.
function pylonParts(b, posts, slabs, edges, dots) {
  const o = obb(b.poly), H0 = b.height || 22, base = b.base ?? 0, { mn, mx, toXZ } = o;
  const cx = (mn[0] + mx[0]) / 2, cy = (mn[1] + mx[1]) / 2, w = Math.max(3, Math.min(mx[0] - mn[0], mx[1] - mn[1]));
  const legs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const spread = (t) => w * (0.38 - 0.135 * t); // 35% narrower at the top
  for (const [du, dv] of legs) for (let i = 0; i < 3; i++) {
    const t = (i + 0.5) / 3, f = spread(t);
    posts.push({ pos: toXZ(cx + du * f, cy + dv * f), h: H0 / 3 + 0.2, w: 0.34 - i * 0.05, color: [126, 126, 122], base: base + (i * H0) / 3 });
  }
  const armAt = (z, len) => { const a = toXZ(cx - len, cy), c = toXZ(cx + len, cy);
    edges.push({ path: [[...P(a), z], [...P(c), z]], base, wide: true });
    for (const q of [a, toXZ(cx, cy), c]) dots.push({ pos: [...P(q), base + z + 0.12], r: 0.22, color: [206, 202, 192], lvl: 0 });
    for (const q of [a, c]) posts.push({ pos: q, h: 0.5, w: 0.15, color: [110, 110, 106], base: base + z - 0.5 }); };
  armAt(H0 - 1.5, w * 0.9);
  armAt(H0 * 0.72, w * 0.66);
  // diagonal bracing on two faces
  for (const [du, dv] of [[-1, -1], [1, 1]]) {
    const lo = spread(0.1), hi = spread(0.75);
    edges.push({ path: [[...P(toXZ(cx + du * lo, cy + dv * lo)), 0.5], [...P(toXZ(cx - du * hi, cy + dv * hi)), H0 * 0.62]], base });
    edges.push({ path: [[...P(toXZ(cx - du * lo, cy + dv * lo)), 0.5], [...P(toXZ(cx + du * hi, cy + dv * hi)), H0 * 0.62]], base });
  }
  slabs.push({ poly: [toXZ(cx - w * 0.28, cy - w * 0.28), toXZ(cx + w * 0.28, cy - w * 0.28), toXZ(cx + w * 0.28, cy + w * 0.28), toXZ(cx - w * 0.28, cy + w * 0.28)], z: H0, color: [126, 126, 122], base });
}
// power cables hang; a straight line between two towers reads as a wireframe, not a wire
const catenary = (path, y, sag = 1.2) => {
  const out = [];
  for (let i = 0; i < path.length - 1; i++) { const a = path[i], b = path[i + 1];
    for (let k = 0; k < 4; k++) { const t = k / 4; out.push(Pg([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], y - sag * 4 * t * (1 - t))); } }
  out.push(Pg(path[path.length - 1], y));
  return out;
};
// ---- TRACK C: building personality -------------------------------------------------------
// Every recipe below composes the primitives that already exist (obb / expand / rbox / circle /
// strip / ringAt / columns) into FIVE shared buckets — extruded boxes, flat quads, solid lines,
// dashed lines, dots — so ~20 identity recipes cost 5 draw calls, not 100.
// `lvl` on each item is its height ABOVE the building base, so the floor selector can cut it.
const mul = (c, k) => [Math.min(255, Math.round(c[0] * k)), Math.min(255, Math.round(c[1] * k)), Math.min(255, Math.round(c[2] * k)), c[3] ?? 255];
// generic unnamed boxes must not all be the same grey; the tint is a deterministic hash of the
// centroid so it never flickers between frames.
/**
 * Resolve every building's WALL and ROOF material class, then colour it from that class.
 *
 * R1.5. The pre-R1.5 version picked a wall tint out of a bag of four greys and a roof tint out of a
 * bag of three, by centroid hash — deterministic, but it meant a corrugated warehouse and a precast
 * concrete block were the same material with a different random grey, which is exactly the
 * "featureless grey blocks ... the exact same matte shader properties" read. Now the class comes
 * from src/render-style.js's deterministic resolver (landmark override -> kind -> form style ->
 * conservative default), the colour comes from that class's authored albedo (realistic) or semantic
 * fill (vector), and the centroid hash is demoted to a +/-6% value jitter so a yard of warehouses
 * still is not one flat sheet.
 *
 * Buildings the DATA gives an explicit colour or a landmark place keep theirs; the class is still
 * recorded on them, because the roof colour and the specular family read it.
 *
 * Note the ORDER below: the `b.color || b.place` early exit comes AFTER the roof assignment, so
 * `b.roofTint` is set for every building except a pylon. `roofMaterialId()` always resolves to a
 * class and `materialTint()` always answers a colour, so it is never undefined — which is why
 * buildingParts() below no longer carries `?? C.roofHouse / C.roofWarehouse / C.roofFlat`
 * fallbacks. Those read like live landmark overrides and could not fire.
 */
function tintBuildings(bs) {
  for (const b of bs) {
    b.materialId = buildingMaterialId(b);
    b.roofMaterialId = roofMaterialId(b);
    if (b.kind === 'powerline_towers') continue;
    const c = b.poly.reduce((a, p) => [a[0] + p[0] / b.poly.length, a[1] + p[1] / b.poly.length], [0, 0]);
    const seed = Math.floor(hash1(c[0], c[1]) * 1000) + 1;
    // A roof is a different material from the wall under it, always — that is the whole point.
    b.roofTint = materialTint(LOOK, b.roofMaterialId, seed, true);
    if (b.color || b.place) continue;
    b.tint = materialTint(LOOK, b.materialId, seed);
  }
}
function detailParts(bs, scenes = []) {
  const out = { boxes: [], plinths: [], flats: [], lines: [], dashes: [], dots: [] };
  const B = (poly, base, h, color, lvl = 0) => { if (poly && poly.length > 2 && h > 0.02) out.boxes.push({ poly, base, h, color, lvl }); };
  const F = (poly, z, color, lvl = 0) => { if (poly && poly.length > 2) out.flats.push({ ring: ringAt(poly, z), color, lvl }); };
  const F3 = (ring, color, lvl = 0) => out.flats.push({ ring, color, lvl });
  const L = (path, color, w, lvl = 0) => { if (path.length > 1) out.lines.push({ path, color, w, lvl }); };
  const D = (path, color, w, dash, lvl = 0) => { if (path.length > 1) out.dashes.push({ path, color, w, dash, lvl }); };
  const T = (pos, r, color, lvl = 0) => out.dots.push({ pos, r, color, lvl });
  const closed = (poly, z) => { const r = ringAt(poly, z); return [...r, r[0]]; };
  const seg = (a, b, za, zb) => [P(a, za), P(b, zb ?? za)];

  for (const b of bs) {
    if (b.kind === 'powerline_towers') continue; // pylonParts owns those
    const st = b.style || 'box', place = b.place || '';
    const base = b.base ?? 0, h = b.height, A = polyArea(b.poly);
    const o = obb(b.poly);
    const cen = b.poly.reduce((a, p) => [a[0] + p[0] / b.poly.length, a[1] + p[1] / b.poly.length], [0, 0]);
    const rnd = hash1(cen[0], cen[1]);
    const uLong = o.mx[0] - o.mn[0] >= o.mx[1] - o.mn[1];
    const u0 = uLong ? o.mn[0] : o.mn[1], u1 = uLong ? o.mx[0] : o.mx[1];
    const v0 = uLong ? o.mn[1] : o.mn[0], v1 = uLong ? o.mx[1] : o.mx[0];
    const pt = uLong ? (u, v) => o.toXZ(u, v) : (u, v) => o.toXZ(v, u);
    const rect = (a0, a1, c0, c1) => [pt(a0, c0), pt(a1, c0), pt(a1, c1), pt(a0, c1)];
    const LEN = u1 - u0, WID = v1 - v0, vm = (v0 + v1) / 2;
    const wall = b.color ? liftTone(b.color, 0.12) : b.tint ?? (b.floors > 1 ? C.buildingMulti : C.building);
    // ROOF_BY_PLACE is a live landmark override; `roofTint` is the class colour under it and is
    // always set for anything that reaches here (pylons already `continue`d), so there is no third
    // fallback to write.
    const roof = b.roof ? liftTone(b.roof, 0.12) : ROOF_BY_PLACE[place] ?? b.roofTint;

    /* --- 1. plinth: every building meets the ground instead of being pasted onto it.
     *
     * It is NOT wall material and it is NOT in `out.boxes`. Until 2026-08-30 it was both: a
     * `wall x 0.7` box, lit, expanded 0.25 m outward, spanning the full relief-amplified drop under
     * the footprint — 10 m of apparent building under Dorms 3-Story at relief 3. It now goes to its
     * own near-black, `material: false` layer (see the `building-plinths` layer below), barely
     * expanded, and capped by `skirtCap()` in src/buildings.js, so it reads as the shadow a
     * building sits in. */
    if (st !== 'canopy') {
      const ph = b.plinthHeight ?? 0.47;
      if (ph > 0.02) out.plinths.push({ poly: expand(b.poly, PLINTH_EXPAND_M), base: b.plinthBase ?? base - 0.35, h: ph, lvl: 0 });
    }

    // Audited cooling towers are hyperboloid shells, not short storage tanks.
    // Stacked circular frustums keep the recipe in the existing shared box layer.
    if (st === 'cooling-tower') {
      const segments = 14, baseRadius = Math.max(2.4, Math.sqrt(A / Math.PI));
      const profile = (t) => baseRadius * (1 - 0.43 * Math.sin(Math.PI * t) - 0.22 * t);
      for (let i = 0; i < segments; i++) {
        const t0 = i / segments, t1 = (i + 1) / segments;
        const radius = Math.max(profile(t0), profile(t1));
        B(circle(cen[0], cen[1], radius, 28), base + h * t0, h / segments + 0.04, mul(C.concreteRaw, 0.92 + 0.05 * (i % 2)), h * t0);
      }
      const rimRadius = profile(1);
      L(closed(circle(cen[0], cen[1], rimRadius, 32), base + h + 0.18), C.parapet, 0.55, h);
      L([P([cen[0] + rimRadius + 0.12, cen[1]], base + 0.4), P([cen[0] + rimRadius + 0.12, cen[1]], base + h - 0.3)], C.tower, 0.22, 0);
      continue;
    }

    // --- 2. window bands: one dashed ring per floor. Dashes read as glass, gaps as piers.
    // `floorLevels()` measures off b.height / b.floors — the REAL building — never off the extruded
    // span or the plinth, so a slope cannot invent a storey line.
    const banded = st === 'box' && A >= 40 && !['Fortress', 'Big Red'].includes(place) && b.kind !== 'tank';
    if (banded) for (const z of floorLevels(b, { inset: 1.35 }))
      D(closed(b.poly, base + z), C.glass, 1.15, place.startsWith('Dorms') ? [1.55, 1.35] : [1.6, 1.5], z);

    // --- 3. parapet lip + roof slab: roof and wall stop being the same grey
    if (st === 'box') {
      L(closed(expand(b.poly, 0.04), base + h + 0.30), C.parapet, 0.35, h);
      F(expand(b.poly, -0.35), base + h + 0.02, roof, h);
    }

    // --- 4. door + threshold on the long facade
    if (st !== 'canopy' && st !== 'frame' && A >= 25 && LEN > 4) {
      const dw = Math.min(1.3, LEN * 0.22), dh = Math.min(2.1, h - 0.3);
      const doorAt = (t) => { const um = u0 + LEN * t; B(rect(um - dw / 2, um + dw / 2, v0 - 0.14, v0 + 0.10), base, dh, C.dockDoor, 0);
        L(seg(pt(um - dw / 2 - 0.2, v0 - 0.22), pt(um + dw / 2 + 0.2, v0 - 0.22), base + 0.05), [...C.cream, 150], 0.18, 0); };
      doorAt(0.42); if (A > 400) doorAt(0.72);
    }

    // --- 5. roof clutter + corner pilasters (deterministic from the centroid hash)
    if (st === 'box' && A >= 60 && LEN > 6 && WID > 5) {
      const n = 1 + Math.floor(rnd * 3);
      for (let i = 0; i < n; i++) {
        const t = (rnd * (i + 3) * 7.13) % 1, s = (rnd * (i + 5) * 3.71) % 1;
        const cu = u0 + 2.2 + (LEN - 4.4) * t, cv = v0 + 2 + (WID - 4) * s;
        B(rect(cu - 0.45, cu + 0.45, cv - 0.45, cv + 0.45), base + h, 0.6, C.tower, h);
      }
      if (b.floors >= 2) B(rect(u0 + LEN * 0.2 - 1.6, u0 + LEN * 0.2 + 1.6, vm - 1.2, vm + 1.2), base + h, 2.4, mul(wall, 0.93), h);
    }
    if (st === 'box' && LEN > 20) for (const [cu, cv] of [[u0, v0], [u1, v0], [u0, v1], [u1, v1]])
      B(rect(cu - 0.2, cu + 0.2, cv - 0.2, cv + 0.2), base, h, mul(wall, 0.88), 0);

    // --- 6. gable roofs: ridge cap, eave line, corrugation ribs, skylight strips
    if (st === 'gable' && isRectangular(b.poly)) {
      const eave = h * 0.72, ridge = h + 0.4, r0 = u0 + WID / 2, r1 = u1 - WID / 2;
      const zOn = (v) => eave + (ridge - eave) * Math.min(1, Math.abs(v - (v < vm ? v0 : v1)) / (WID / 2 || 1));
      L(seg(pt(r0, vm), pt(r1, vm), base + ridge + 0.06), mul(roof, 1.2), 0.5, h);
      L(closed(expand(b.poly, 0.05), base + eave), [...C.ink, 90], 0.3, eave);
      const nRib = Math.max(4, Math.min(12, Math.round(LEN / 4)));
      for (let i = 1; i < nRib; i++) {
        const u = u0 + (LEN * i) / nRib, uc = Math.min(r1, Math.max(r0, u));
        L([P(pt(u, v0), base + eave), P(pt(uc, vm), base + ridge)], C.roofRib, 0.18, eave);
        L([P(pt(u, v1), base + eave), P(pt(uc, vm), base + ridge)], C.roofRib, 0.18, eave);
      }
      for (let i = 0; i < 3; i++) {
        const ua = u0 + LEN * (0.18 + i * 0.28), ub = ua + Math.min(1.6, LEN * 0.06);
        for (const side of [-1, 1]) {
          const va = side < 0 ? v0 + WID * 0.28 : v1 - WID * 0.28, vb = side < 0 ? v0 + WID * 0.44 : v1 - WID * 0.44;
          F3([P(pt(ua, va), base + zOn(va) + 0.04), P(pt(ub, va), base + zOn(va) + 0.04), P(pt(ub, vb), base + zOn(vb) + 0.04), P(pt(ua, vb), base + zOn(vb) + 0.04)], C.skylight, h);
        }
      }
      D(closed(b.poly, base + 1.4), mul(wall, 0.86), 0.25, [0.5, 0.5], 1.4);
      if (eave > 4.2) D(closed(b.poly, base + 3.6), mul(wall, 0.86), 0.25, [0.5, 0.5], 3.6);
    }

    // --- 7. frame (Skeleton, Old Construction): a real column grid, edge beams, a shear core
    if (st === 'frame') {
      const top = b.floors * 3.3;
      for (let u = u0 + 2.2; u < u1 - 1; u += 4.5) for (let v = v0 + 2.2; v < v1 - 1; v += 4.5) {
        const q = pt(u, v); if (!inPolyXZ(q, b.poly)) continue;
        B(rect(u - 0.28, u + 0.28, v - 0.28, v + 0.28), base, top - 0.25, C.concreteRaw, 0);
      }
      for (let k = 1; k <= b.floors; k++) L(closed(expand(b.poly, 0.04), base + k * 3.3 - 0.15), mul(C.concreteRaw, 0.78), 0.3, k * 3.3);
      B(rect(u0 + 0.4, u0 + 5.4, vm - 2, vm + 2), base, top, mul(C.concreteRaw, 0.88), 0);
      for (const q of columns(b.poly, 6)) T([...P(q), base + top + 0.45], 0.1, C.rebar, top);
      F(rect(u1 - 5, u1 - 1.5, vm - 1.5, vm + 1.5), base + top + 0.03, [26, 28, 26], top);
      for (let i = 0; i < 5; i++) {
        const a = hash1(cen[0] + i * 13.3, cen[1] - i * 7.7), a2 = hash1(cen[0] - i * 5.1, cen[1] + i * 11.9);
        F(circle(cen[0] + (a - 0.5) * (LEN + 12), cen[1] + (a2 - 0.5) * (WID + 12), 1.4 + a * 2, 7), base + 0.05, C.rock, 0);
      }
      B(rect(u0 - 2.6, u0 - 0.2, vm - 1.2, vm + 1.2), base, 0.12, mul(C.concreteRaw, 0.8), 0);
    }

    // --- 8. canopy (New Gas, Old Gas, Bus Station): fascia, accent stripe, trapped shade, pumps
    if (st === 'canopy') {
      const fascia = place === 'New Gas' ? C.bigRedTrim : place === 'Old Gas' ? [150, 146, 134] : [176, 172, 160];
      const stripe = place === 'New Gas' ? C.bigRed : place === 'Old Gas' ? [86, 110, 124] : C.hazardStripe;
      B(expand(b.poly, 0.18), base + h - 0.45, 0.45, fascia, h);
      L(closed(expand(b.poly, 0.24), base + h - 0.18), stripe, 0.22, h);
      F(expand(b.poly, -0.25), base + h - 0.62, [8, 14, 10, 120], h - 0.62);
      const nIsl = place === 'Old Gas' ? 1 : 2;
      for (let i = 0; i < nIsl; i++) {
        const v = nIsl === 1 ? vm : v0 + WID * (0.32 + 0.36 * i);
        B(rect(u0 + LEN * 0.22, u0 + LEN * 0.78, v - 0.5, v + 0.5), base, 0.18, C.pavementWorn, 0);
        for (const t of [0.34, 0.66]) B(rect(u0 + LEN * t - 0.3, u0 + LEN * t + 0.3, v - 0.25, v + 0.25), base + 0.18, 1.7, [188, 186, 178], 0);
      }
      if (place === 'Old Gas') { const q = pt(u0 + LEN * 0.5, v1 - 1.4); B(circle(q[0], q[1], 0.6, 10), base, 1.2, C.concreteRaw, 0); }
      if (place === 'New Gas') { const q = pt(u1 + 3, vm); B(circle(q[0], q[1], 0.18, 8), base, 4.5, C.parapet, 0); B(rect(u1 + 1.7, u1 + 4.3, vm - 0.12, vm + 0.12), base + 3.6, 0.9, C.bigRed, 0); }
    }

    // --- 9. tanks: domed cap, hoop bands, catwalk + rail, ladder, bund wall
    if (st === 'tank' || b.kind === 'tank') {
      const r = Math.sqrt(A / Math.PI);
      F(circle(cen[0], cen[1], r * 0.72, 20), base + h + 0.55, [206, 210, 207], h);
      for (const f of [0.3, 0.55, 0.8]) L(closed(circle(cen[0], cen[1], r + 0.04, 20), base + h * f), C.tankBand, 0.22, h * f);
      L(closed(circle(cen[0], cen[1], r + 0.5, 20), base + h * 0.78), [140, 144, 142], 0.6, h * 0.78);
      L(closed(circle(cen[0], cen[1], r + 0.5, 20), base + h * 0.78 + 0.9), C.bridgeRail, 0.15, h * 0.78);
      for (const dv of [-0.22, 0.22]) L([P([cen[0] + (r + 0.1), cen[1] + dv], base), P([cen[0] + (r + 0.1), cen[1] + dv], base + h + 0.6)], [150, 152, 150], 0.09, 0);
      D([P([cen[0] + r + 0.1, cen[1]], base), P([cen[0] + r + 0.1, cen[1]], base + h + 0.6)], [150, 152, 150], 0.44, [0.15, 0.25], 0);
      const bd = circle(cen[0], cen[1], r + 3.2, 24);
      B(strip([...bd, bd[0]], 0.2), base, 0.9, mul(C.concreteRaw, 0.85), 0);
      F(circle(cen[0], cen[1], r + 3.0, 24), base + 0.04, mul(C.pavement, 0.88), 0);
    }

    // --- 10. landmarks -------------------------------------------------------------------
    if (place === 'Big Red') {
      for (let u = u0 + 1.5; u < u1 - 1; u += 3.0) for (const v of [v0, v1])
        B(rect(u - 0.11, u + 0.11, v - 0.12, v + 0.12), base, h, mul(wall, 0.86), 0);
      L(closed(expand(b.poly, 0.08), base + 5.2), C.bigRedTrim, 0.8, 5.2);
      for (const t of [0.22, 0.5, 0.78]) {
        B(rect(u0 + LEN * t - 2.25, u0 + LEN * t + 2.25, v0 - 0.16, v0 + 0.06), base, 4.2, C.dockDoor, 0);
        L(closed(rect(u0 + LEN * t - 2.4, u0 + LEN * t + 2.4, v0 - 0.24, v0 - 0.2), base + 4.35), C.bigRedTrim, 0.15, 4.35);
      }
      F(rect(u0, u1, v0 - 8, v0 - 0.1), base + 0.06, C.pavement, 0);
      for (const t of [0.35, 0.65]) L(seg(pt(u0 + LEN * t, v0 - 7.6), pt(u0 + LEN * t, v0 - 0.6), base + 0.08), C.roadMarking, 0.18, 0);
      for (const t of [0.3, 0.7]) B(rect(u0 + LEN * t - 0.45, u0 + LEN * t + 0.45, vm - 0.45, vm + 0.45), base + h + 0.4, 1.1, C.tower, h);
    }
    if (place.startsWith('Dorms') && A > 300) {
      B(rect(u0 - 0.15, u0 + 3.6, vm - 2.1, vm + 2.1), base, h + 1.4, mul(wall, 0.97), 0);
      B(rect(u0 + 0.5, u0 + 1.0, vm - 2.2, vm + 2.2), base, h + 1.4, C.glass, 0);
      B(rect(u0 + LEN * 0.5 - 1.7, u0 + LEN * 0.5 + 1.7, v0 - 1.6, v0), base + 3.0, 0.2, C.parapet, 3.0);
      for (const t of [-1.5, 1.5]) B(rect(u0 + LEN * 0.5 + t - 0.09, u0 + LEN * 0.5 + t + 0.09, v0 - 1.4, v0 - 1.22), base, 3.0, C.parapet, 0);
      const q = pt(u1 - 3, vm); B(circle(q[0], q[1], 0.8, 14), base + h + 0.55, 1.2, C.tank, h);
      if (b.floors >= 3) for (const z of floorLevels(b).slice(0, 2)) {
        L(closed(expand(b.poly, 0.5), base + z), mul(wall, 0.9), 0.9, z);
        L(closed(expand(b.poly, 0.9), base + z + 0.9), C.bridgeRail, 0.12, z);
      }
    }
    if (place === 'Fortress') {
      for (const z of floorLevels(b, { inset: 1.4 })) D(closed(b.poly, base + z), [26, 34, 36, 240], 0.55, [0.55, 2.6], z + 1.4);
      D(closed(expand(b.poly, 0.06), base + h + 0.55), [196, 192, 182], 0.55, [1.25, 1.25], h);
      const rim = columns(expand(b.poly, -0.6), Math.max(2.2, (LEN + WID) * 2 / 14));
      rim.forEach((q, i) => B(rbox(q[0], q[1], 0.5, 0.9, i * 37 % 180), base + h + 0.06, 0.5, C.sandbag, h));
      B(rect(u1 - 2.2, u1 - 0.6, v0 + 0.6, v0 + 2.2), base + h + 0.06, 0.9, mul(C.concreteRaw, 0.8), h);
      for (const t of [0.33, 0.66]) for (const v of [v0, v1]) L(seg(pt(u0 + LEN * t, v - 0.1), pt(u0 + LEN * t, v + 0.1), base + h * 0.5), [...C.ink, 120], 0.25, 0);
      for (let i = 0; i < 6; i++) { const q = pt(u0 + LEN * (0.1 + i * 0.16), v0 - 4 - (i % 2) * 1.6); B(rbox(q[0], q[1], 0.6, 1.8, (i % 2) * 8), base, 1.0, C.concreteRaw, 0); }
    }
    if (place === 'Crackhouse' || place === 'Streamer House') {
      const eave = h * 0.72, ridge = h + 0.4;
      B(rect(u0 + LEN * 0.3 - 0.42, u0 + LEN * 0.3 + 0.42, v1 - 1.4, v1 - 0.56), base + eave - 1, ridge + 1.6 - eave + 1, mul(wall, 0.88), h);
      B(rect(u0 + LEN * 0.55 - 1.5, u0 + LEN * 0.55 + 1.5, v0 - 2.4, v0), base + 2.4, 0.18, mul(wall, 0.8), 2.4);
      for (const t of [-1.3, 1.3]) B(rect(u0 + LEN * 0.55 + t - 0.09, u0 + LEN * 0.55 + t + 0.09, v0 - 2.2, v0 - 2.02), base, 2.4, C.parapet, 0);
      for (let i = 0; i < 3; i++) B(rect(u0 + LEN * 0.55 - 0.6, u0 + LEN * 0.55 + 0.6, v0 - 2.4 - i * 0.3, v0 - 2.15 - i * 0.3), base, 0.12 * (3 - i), [138, 116, 92], 0);
      const va = v0 + WID * 0.3, vb = v0 + WID * 0.46, zA = eave + (ridge - eave) * 0.6, zB = eave + (ridge - eave) * 0.92;
      const ua = u0 + LEN * 0.4, ub = ua + 2.4;
      F3([P(pt(ua, va), base + zA + 0.05), P(pt(ub, va), base + zA + 0.05), P(pt(ub, vb), base + zB + 0.05), P(pt(ua, vb), base + zB + 0.05)], [16, 19, 18, 225], h);
      for (let i = 1; i < 5; i++) { const u = ua + (2.4 * i) / 5; L([P(pt(u, va), base + zA + 0.07), P(pt(u, vb), base + zB + 0.07)], [96, 72, 56], 0.1, h); }
    }
    if (place === 'Boiler') {
      for (const t of [0.28, 0.62]) { const q = pt(u0 + LEN * t, vm); B(circle(q[0], q[1], 0.9, 18), base + h * 0.7, 9, [140, 136, 128], h);
        for (let i = 0; i < 3; i++) L(closed(circle(q[0], q[1], 0.95, 18), base + h * 0.7 + 7.6 + i * 0.5), i % 2 ? C.cream : C.bigRed, 0.5, h); }
      L(seg(pt(u0 + 1, v0 - 3.2), pt(u1 - 1, v0 - 3.2), base + 1.75), [132, 128, 120], 0.35, 0);
      for (let u = u0 + 2; u < u1 - 1; u += 6) B(rect(u - 0.12, u + 0.12, v0 - 3.35, v0 - 3.05), base, 1.75, C.parapet, 0);
    }
    if (place === 'Water Pump') {
      const q = pt((u0 + u1) / 2, vm); B(circle(q[0], q[1], 1.1, 16), base + h, 2.2, C.tank, h);
      L(closed(circle(q[0], q[1], 0.55, 12), base + 1.2), [150, 152, 150], 0.14, 1.2);
    }
  }

  // --- 11. scenes with no footprint in the data: bunker mouths + checkpoints ---------------
  for (const s of scenes) {
    const [x, z] = s.pos, a = s.rot, ca = Math.cos(a), sa = Math.sin(a);
    const R = (du, dv) => [x + du * ca - dv * sa, z + du * sa + dv * ca];
    // Scene recipes are rigid little assemblies. Seat their shared base on the highest sampled
    // point in their footprint so a relief-amplified cross-slope cannot swallow half the parts.
    const g = Math.max(...[[0, 0], [-8, -6], [-8, 6], [8, -6], [8, 6], [-4, 0], [4, 0]].map(([du, dv]) => { const q = R(du, dv); return H(q[0], q[1]); }));
    if (s.type === 'bunker') {
      out.boxes.push({ poly: rbox(...R(0, 0), 1.1, 3.2, (a * 180) / Math.PI), base: g, h: 2.6, color: [146, 142, 132], lvl: 0 });
      out.boxes.push({ poly: rbox(...R(-0.62, 0), 0.35, 2.0, (a * 180) / Math.PI), base: g, h: 2.2, color: [20, 24, 20, 235], lvl: 0 });
      out.flats.push({ ring: ringAt(rbox(...R(2.4, 0), 4, 3, (a * 180) / Math.PI), g + 0.06), color: mul(C.pavement, 0.85), lvl: 0 });
      for (const dv of [-2.2, 2.2]) out.boxes.push({ poly: circle(...R(0.4, dv), 0.3, 10), base: g, h: 1.2, color: [122, 120, 112], lvl: 0 });
      L([P(R(-0.8, -1.05), g + 2.25), P(R(-0.8, 1.05), g + 2.25)], [...C.cream, 170], 0.16, 0);
    }
    if (s.type === 'checkpoint') {
      out.boxes.push({ poly: rbox(...R(-4, 3.4), 3, 3, (a * 180) / Math.PI), base: g, h: 2.8, color: [160, 156, 146], lvl: 0 });
      out.boxes.push({ poly: rbox(...R(-4, 1.95), 0.3, 2.0, (a * 180) / Math.PI), base: g + 0.9, h: 1.3, color: C.glass, lvl: 0 });
      out.flats.push({ ring: ringAt(rbox(...R(-4, 3.4), 3.6, 3.6, (a * 180) / Math.PI), g + 2.85), color: [110, 106, 100], lvl: 0 });
      // boom barrier: two overlaid dashed paths read as hazard chevrons
      const bA = P(R(-2.4, 2.2), g + 1.15), bB = P(R(-2.4, -4.4), g + 1.15);
      D([bA, bB], [...C.cream, 255], 0.28, [0.8, 0.8], 0);
      D([[bA[0] + 0.55, bA[1], bA[2]], [bB[0] + 0.55, bB[1], bB[2]]], C.bigRed, 0.28, [0.8, 0.8], 0);
      out.boxes.push({ poly: rbox(...R(-2.4, 2.5), 0.5, 0.5, 0), base: g, h: 1.3, color: [120, 118, 112], lvl: 0 });
      for (let i = 0; i < 6; i++) out.boxes.push({ poly: rbox(...R(1.6 + (i % 2) * 1.2, -3.5 + i * 1.4), 0.6, 2.4, (a * 180) / Math.PI + (i % 2) * 8), base: g, h: 0.95, color: [148, 144, 136], lvl: 0 });
      out.boxes.push({ poly: circle(...R(4.4, 3.6), 2.2, 18), base: g, h: 0.95, color: C.sandbag, lvl: 0 });
      out.boxes.push({ poly: circle(...R(-6, -1), 0.2, 8), base: g, h: 4.5, color: [120, 118, 112], lvl: 0 });
      out.boxes.push({ poly: rbox(...R(-6, -1), 0.35, 0.7, (a * 180) / Math.PI), base: g + 4.5, h: 0.3, color: [150, 148, 142], lvl: 0 });
      out.flats.push({ ring: ringAt(rbox(...R(-0.5, -1), 3, 6, (a * 180) / Math.PI), g + 0.07), color: [30, 34, 32, 120], lvl: 0 });
      if (s.tower) {
        for (const [du, dv] of [[-1.4, -1.4], [1.4, -1.4], [1.4, 1.4], [-1.4, 1.4]]) out.boxes.push({ poly: rbox(...R(6 + du, 5 + dv), 0.35, 0.35, 0), base: g, h: 4.5, color: [126, 124, 118], lvl: 0 });
        out.flats.push({ ring: ringAt(rbox(...R(6, 5), 3.2, 3.2, (a * 180) / Math.PI), g + 4.6), color: [130, 126, 118], lvl: 0 });
        L(closed(rbox(...R(6, 5), 3.2, 3.2, (a * 180) / Math.PI), g + 5.5), C.bridgeRail, 0.12, 0);
        out.flats.push({ ring: ringAt(rbox(...R(6, 5), 3.6, 3.6, (a * 180) / Math.PI), g + 6.6), color: [110, 106, 100], lvl: 0 });
      }
    }
  }
  return out;
}

function buildingParts(bs) {
  const walls = [], roofs = [], slabs = [], posts = [], edges = [], dots = [];
  for (const b of bs) {
    if (b.kind === 'powerline_towers') { pylonParts(b, posts, slabs, edges, dots); continue; }
    const st = b.style || 'box';
    if (st === 'box' || st === 'tank') walls.push({ ...b, h: b.height });
    if (st === 'tank') slabs.push({ poly: b.poly, z: b.height + 0.02, color: [196, 200, 198], base: b.base });
    if (st === 'gable') {
      if (!isRectangular(b.poly)) { walls.push({ ...b, h: b.height }); slabs.push({ poly: b.poly, z: b.height + 0.02, color: b.roof ?? b.roofTint, base: b.base }); continue; }
      walls.push({ ...b, h: b.height * 0.72 });
      // R1.5: a roof takes its own MATERIAL CLASS — corrugated metal on a gable, tile on a house
      // (ROOF_MATERIAL.byPlace maps Crackhouse and Streamer House to 'roof-tile') — not one shared
      // warehouse grey. tintBuildings() sets `roofTint` on every non-pylon building, so the old
      // `?? (place is a house ? roofHouse : roofWarehouse)` tail could never be reached; it read
      // like a live landmark override and was the opposite of what the class resolver decides.
      const rc = b.roof ? liftTone(b.roof, 0.12) : b.roofTint, shade = (k) => rc.map((c) => Math.min(255, c * k));
      hipRoof(b).forEach((pts, i) => roofs.push({ pts, color: shade([1, 0.82, 0.9, 0.9][i]), b }));
    }
    if (st === 'frame') { for (let k = 1; k <= b.floors; k++) { const z = k * 3.3; slabs.push({ poly: b.poly, z, color: [C.concreteRaw[0], C.concreteRaw[1], C.concreteRaw[2], 235], base: b.base }); edges.push({ path: [...ringAt(b.poly, z), ringAt(b.poly, z)[0]], base: b.base }); } for (const c of columns(b.poly)) posts.push({ pos: c, h: b.floors * 3.3, w: 0.55, color: C.concreteRaw, base: b.base }); }
    if (st === 'canopy') { slabs.push({ poly: b.poly, z: b.height, color: b.color ?? b.roofTint, base: b.base }); edges.push({ path: [...ringAt(b.poly, b.height - 0.4), ringAt(b.poly, b.height - 0.4)[0]], base: b.base }); for (const c of columns(b.poly, 9)) posts.push({ pos: c, h: b.height, w: 0.5, color: C.parapet, base: b.base }); }
  }
  return { walls, roofs, slabs, posts, edges, dots };
}
// rotated box footprint in game coords: centre (x,z), w across, l along heading rot (deg)
function rbox(x, z, w, l, rot) { const a = (rot * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a); return [[-l / 2, -w / 2], [l / 2, -w / 2], [l / 2, w / 2], [-l / 2, w / 2]].map(([u, v]) => [x + u * c - v * sn, z + u * sn + v * c]); }
const circle = (x, z, r, n = 18) => Array.from({ length: n }, (_, i) => [x + r * Math.cos((i / n) * 2 * Math.PI), z + r * Math.sin((i / n) * 2 * Math.PI)]);
// thin strip polygon around a polyline (for fences/walls)
function strip(path, w) { const L = [], R = []; for (let i = 0; i < path.length; i++) { const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)]; const dx = b[0] - a[0], dz = b[1] - a[1], n = Math.hypot(dx, dz) || 1; L.push([path[i][0] - (dz / n) * w, path[i][1] + (dx / n) * w]); R.push([path[i][0] + (dz / n) * w, path[i][1] - (dx / n) * w]); } return [...L, ...R.reverse()]; }
// containers/vehicles get a deterministic rusted tint so the yards stop reading as one plastic red
const hash1 = (a, b) => { const n = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return n - Math.floor(n); };
// The lift target is part of the look: vector pulls an authored colour toward cream (its bright
// field palette), realistic toward a cool overcast grey, so a data-authored landmark colour lands
// in the right value range in both skins instead of staying at its raw saturation.
const liftTone = (c, amount = 0.1, target = C.liftTarget) => c.map((v, i) => i < 3 ? Math.round(v + (target[i] - v) * amount) : v);
const centroid = (poly) => poly.reduce((a, p) => [a[0] + p[0] / poly.length, a[1] + p[1] / poly.length], [0, 0]);
/**
 * The seat a building falls back to when `placeBuildings()` has not written one (a layer built
 * before the pass, or a hand-made row). Same rule as `seatBuilding()`: the ground under the
 * CENTROID, not the highest ground under the footprint — seating on the maximum stilts a building
 * over its own downhill corner by the full relief-amplified cross-slope.
 */
function footprintGround(poly) {
  return seatBuilding({ poly, height: 0 }, H).base;
}
function propParts(props) { // -> game-coordinate footprints; the layer samples H when it renders
  return props.map((p) => {
    let color = p.color ? liftTone(p.color, 0.09) : PROP_COLORS[p.type] ?? [176, 172, 162];
    if (!p.color && p.type === 'container') color = CONTAINER_TINTS[Math.floor(hash1(p.x ?? 0, p.z ?? 0) * CONTAINER_TINTS.length) % CONTAINER_TINTS.length];
    if (p.poly) return { poly: p.poly, h: p.h ?? 1, dz: p.dz ?? 0, color, p };
    if (p.type === 'wall' || p.type === 'pipe') return { poly: strip(p.path, (p.w ?? 0.4) / 2), h: p.h ?? 2.5, dz: p.dz ?? 0, drape: true, color, p };
    if (p.type === 'tank') return { poly: circle(p.x, p.z, p.r), h: p.h ?? 6, dz: p.dz ?? 0, color, p };
    return { poly: rbox(p.x, p.z, p.w ?? 2.4, p.l ?? 6, p.rot ?? 0), h: p.h ?? 2.6, dz: p.dz ?? 0, color, p };
  });
}
function viewCone(last, r, fovDeg) {
  const yaw = ((last.yaw ?? 0) * Math.PI) / 180, half = (fovDeg * Math.PI) / 360, pts = [[last.x, last.z]];
  for (let i = 0; i <= 14; i++) { const a = yaw - half + (2 * half * i) / 14; pts.push([last.x + r * Math.sin(a), last.z + r * Math.cos(a)]); }
  return pts;
}
/*
 * How long the live player's cone is, in metres.
 *
 * A fixed 32 m cone is ~29 px at the default Customs framing and about half that once the 32°
 * tilt foreshortens it along the view axis — QA H2 measured the whole live marker as a 14x8 px
 * hollow ellipse and called it the least visible thing on the map, on the frame the Live panel is
 * open for. So the cone has a SCREEN-SPACE FLOOR: it is 32 m of real ground wherever 32 m is
 * already big enough to read, and grows toward MIN_CONE_PX pixels when it is not. The cap keeps a
 * far-out camera from painting a wedge across the whole map.
 */
const CONE_M = 32, MIN_CONE_PX = 52, MAX_CONE_M = 190;
export function coneMetresFor(zoom) {
  const pxPerM = Math.pow(2, Number(zoom) || 0);
  if (!(pxPerM > 0)) return CONE_M;
  return Math.min(MAX_CONE_M, Math.max(CONE_M, MIN_CONE_PX / pxPerM));
}
/** The vertical beacon's height, on the same screen-space floor as the cone. */
export function beaconMetresFor(zoom) {
  const pxPerM = Math.pow(2, Number(zoom) || 0);
  if (!(pxPerM > 0)) return 9;
  return Math.min(70, Math.max(9, 30 / pxPerM));
}
const box = ([x, y], w) => [[x - w / 2, y - w / 2], [x + w / 2, y - w / 2], [x + w / 2, y + w / 2], [x - w / 2, y + w / 2]];

export async function createView3d(container, mapData, src) {
  const bootMs = performance.now();
  const data = await (await fetch(`/data/${mapData.key}-3d.json`)).json();

  /* --- the icon atlas, started FIRST -------------------------------------------------------
   * QA D1: on a cold load the map showed every text label with no marker or extract badge under
   * it for >16 s — names floating over nothing, which reads as broken rather than as loading.
   *
   * The cause was ORDER, not the atlas. `buildAtlas` decodes ~50 SVG data URLs, and decoding is
   * off the main thread — but the loads did not START until after the heightfield, the building
   * placement pass and the tree preparation had all run to completion SYNCHRONOUSLY, because the
   * three `await buildAtlas(...)` calls sat below them. So the one piece of work that could have
   * overlapped the expensive prep was the one piece queued behind it, and under software GL that
   * prep is seconds long.
   *
   * The loads are kicked off here, before any of that, and awaited where the atlas is first
   * needed — which is after the same prep, so nothing else moves. `atlasReadyMs` /
   * `firstBadgeMs` in renderStats().timing are what the e2e report measures it with.
   */
  let atlasReadyMs = null, atlasWaitMs = null, prepMs = null, firstLabelMs = null, firstBadgeMs = null, markersReadyMs = null;
  // Rasterise SVG icons into one canvas atlas (deck's icon loader is unreliable with SVG data URLs).
  async function buildAtlas(entries, cell) {
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, cell * entries.length); canvas.height = cell;
    const ctx = canvas.getContext('2d'); const mapping = {};
    await Promise.all(entries.map(([name, url], i) => new Promise((res) => {
      const img = new Image(); img.onload = () => { ctx.drawImage(img, i * cell, 0, cell, cell); res(); }; img.onerror = res; img.src = url;
      mapping[name] = { x: i * cell, y: 0, width: cell, height: cell, anchorY: cell, mask: false };
    })));
    return { canvas, mapping };
  }
  // Quest pins carry their sequence number inside the hexagon. It used to be BAKED — one atlas
  // entry per number, `quest-objective:1` … `:12` — on the claim that "1..12 covers every quest in
  // the data". It does not: Hot Wheels alone has 19 mapped objectives, and every pin past the
  // twelfth silently fell back to the plain flag at the one tier that is supposed to number
  // (QA M3). The number is drawn as text over an EMPTY hexagon instead, which is uncapped, is the
  // same trick `cluster-counts` already uses, and takes 12 glyphs out of the cold-load atlas.
  const QUEST_BLANK = 'quest-objective:blank';
  /**
   * The per-marker half of the atlas, which is DATA-DEPENDENT and therefore cannot be settled here.
   *
   * `src.markers()` is main.js's marker list, and it is empty until the marker fetch
   * (`/data/<map>.json`, behind a tarkov.dev GraphQL attempt) resolves in renderMarkers(). While the
   * atlas build sat below the heightfield/building/tree prep it usually won that race by hundreds of
   * ms; moving it to the top of createView3d() — the D1 fix — made it lose almost every warm load.
   * When it loses, the atlas holds only the plain kind names, every lettered/underground key
   * (`extract-scav:D`, `extract-pmc:OG:underground:flare`, …) is absent from `iconMapping`, and the
   * IconLayer draws NOTHING for those markers. On Customs, where all 32 extract keys carry a letter,
   * that is every extract badge on the map gone — under the extract names, which do draw.
   *
   * So the atlas is built from whatever markers exist now, and `ensureMarkerIcons()` below rebuilds
   * it when markers with keys it does not hold turn up. Both halves are needed: building early is
   * what keeps the cold load fast, rebuilding is what makes it correct.
   */
  const markerAtlasEntries = () => src.markers().filter((m) => KINDS[m.kind]).map((m) => {
    const isExtract = m.kind.startsWith('extract');
    return [markerIconKey(m), iconDataUrl(m.kind, 64, isExtract ? extractLetter(m.name) : null, markerLevel(m), null, isExtract ? extractReq(m.name) : null)];
  });
  const dedupe = (entries) => entries.filter((e, i, all) => all.findIndex((x) => x[0] === e[0]) === i);
  const iconEntries = () => dedupe([...Object.keys(KINDS).map((k) => [k, iconDataUrl(k, 64)]), ...markerAtlasEntries(),
    [QUEST_BLANK, iconDataUrl('quest-objective', 64, ' ')]]);
  const atlasPromises = {
    icons: buildAtlas(iconEntries(), 64),
    arrows: buildAtlas(COLORS.map((c) => [c, arrowDataUrl(c, 64)]), 64),
    soldiers: buildAtlas(COLORS.map((c) => [c, soldierDataUrl(c, 64)]), 64),
  };

  /* --- clip the draped sheets to the playable limit ----------------------------------------
   * QA M2: on Woods, 242 of the water sheet's 1,532 vertices and 15 of the 63 bridge-deck ones sit
   * OUTSIDE `data.limit`. The east river therefore ran on past the terrain as a solid blue band
   * over the void, and a blue wedge sat in the bottom-left corner with no ground under it — worst
   * in the vector frame, where the void is black. The source polygons come from tarkov.dev's SVG,
   * which has no reason to stop where the playable area does.
   *
   * A vertex outside the ring is pulled to the nearest point ON it, and a hair inside. This is a
   * SNAP, not a boolean intersection: the excursions are shallow bulges past the edge, and a snap
   * cannot introduce the self-intersections that clipping against a 2,636-point CONCAVE ring
   * would. It runs on `data` before anything reads it, so terrain.js's realistic water MESH and
   * map3d's vector water POLYGON are clipped by the same pass and neither file learns about it.
   *
   * Snapping the VERTICES is not enough, and the first version of this pass stopped there. The
   * limit is a 2,636-point concave ring, and an EDGE between two points that are both on or inside
   * it can still cut the corner across a bay — which is exactly what the SVG river does once its
   * outlying vertices have been pulled onto the boundary. Measured on Woods after the vertex snap:
   * unprojecting the drawn vector water back onto the ground plane still put 119 of 4,145 sampled
   * water pixels outside `data.limit`, the worst 30 m out, with black void under them (QA M2, the
   * east river's "solid blue band past the terrain edge"). So an edge whose midpoint lands outside
   * is split and the split point snapped too, up to SPLIT_PASSES times — each pass halves the worst
   * excursion, and a bay the ring itself resolves in 2 m needs four of them at most. It stays a
   * snap: no new topology, no boolean, and an edge that never leaves the ring is never touched.
   */
  const clippedVerts = (() => {
    const ring = data.limit;
    if (!Array.isArray(ring) || ring.length < 3) return 0;
    /*
     * A bridge deck is allowed to run to the rim — it is a road, and the rim is where the road
     * leaves the map. A WATER SURFACE is not: snapping it flush to the limit put the Woods lake's
     * south shore exactly on the boundary, where the ground mesh's cliff skirt drops away under
     * it, so the sheet was seen overhanging the void with a fold along the last row of cells and a
     * black notch under it (QA M2). Water is therefore clipped to a LAND RING inset from the
     * limit, which is the only inset that guarantees ground beneath every water vertex. The
     * realistic mesh grows a ~5 m shore pad back outward from the polygon, so the inset has to
     * cover that and still leave a visible rim.
     */
    const BRIDGE_INSET_M = 0.4, WATER_INSET_M = 14;
    const SPLIT_PASSES = 4;
    /** Pull a point onto the ring inset by `inset`, or leave it where it is if already that deep. */
    const snapTo = (pt, inset) => {
      if (!Array.isArray(pt) || pt.length < 2) return pt;
      const inside = inPolyXZ(pt, ring);
      // Every water vertex AND every split midpoint asks for this now (an inside point has to know
      // how deep inside it is), so the 2,636-segment scan gets a bbox reject against the best
      // distance so far. Same answer, a fraction of the arithmetic.
      let bx = pt[0], bz = pt[1], bd = Infinity;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const ax = ring[j][0], az = ring[j][1], cx = ring[i][0], cz = ring[i][1];
        if (bd < Infinity) {
          const r = Math.sqrt(bd);
          if (pt[0] < Math.min(ax, cx) - r || pt[0] > Math.max(ax, cx) + r
            || pt[1] < Math.min(az, cz) - r || pt[1] > Math.max(az, cz) + r) continue;
        }
        const dx = cx - ax, dz = cz - az;
        const len = dx * dx + dz * dz;
        const t = len > 0 ? Math.max(0, Math.min(1, ((pt[0] - ax) * dx + (pt[1] - az) * dz) / len)) : 0;
        const qx = ax + dx * t, qz = az + dz * t;
        const d = (qx - pt[0]) ** 2 + (qz - pt[1]) ** 2;
        if (d < bd) { bd = d; bx = qx; bz = qz; }
      }
      if (inside && bd >= inset * inset) return pt;
      const vx = bx - pt[0], vz = bz - pt[1], vl = Math.hypot(vx, vz);
      if (!(vl > 1e-6)) return pt;
      // `b - pt` points outward from an inside point and inward from an outside one, so the sign
      // of the step is the only difference between pulling a stray vertex in and pushing a
      // too-shallow one deeper.
      const s = (inside ? -inset : inset) / vl;
      return [bx + vx * s, bz + vz * s];
    };
    let moved = 0;
    /** @param {boolean} closed a water ring wraps back to its first point; a bridge path does not. */
    const clipRing = (poly, closed, inset) => {
      if (!Array.isArray(poly)) return poly;
      const deepEnough = (pt) => snapTo(pt, inset) === pt;
      let out = poly.map((p) => { const q = snapTo(p, inset); if (q !== p) moved++; return q; });
      for (let pass = 0; pass < SPLIT_PASSES && out.length >= 2; pass++) {
        const next = [];
        let split = false;
        const last = closed ? out.length : out.length - 1;
        for (let i = 0; i < out.length; i++) {
          const a = out[i];
          next.push(a);
          if (i >= last) continue;
          const b = out[(i + 1) % out.length];
          const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          if (deepEnough(mid)) continue;
          next.push(snapTo(mid, inset)); moved++; split = true;
        }
        out = next;
        if (!split) break;
      }
      return out;
    };
    for (const w of data.water || []) {
      w.poly = clipRing(w.poly, true, WATER_INSET_M);
      if (Array.isArray(w.holes)) w.holes = w.holes.map((h) => clipRing(h, true, WATER_INSET_M));
    }
    for (const b of data.bridges || []) b.path = clipRing(b.path, false, BRIDGE_INSET_M);
    return moved;
  })();

  // --- TRACK B (terrain.js) --------------------------------------------------------------
  // One surface, one sampler: the mesh below and every draped feature (roads, fences, props,
  // trees, shade rings, building bases, player drop-lines) must sample the SAME bicubic field,
  // or they float/sink by up to ~0.3 m and z-fight against the mesh.
  let relief = [1, 2, 3].includes(Number(src.relief)) ? Number(src.relief) : 3;
  let heightEpoch = 0;
  let terrain = null;

  /* --- STAGE 1: the render style ---------------------------------------------------------
   * `look` is a MATERIAL state. It selects the colour table, the light, the fog, the background,
   * the terrain bake and the post grade — and nothing else. Geometry buffers, transforms, feature
   * ids, picking colours, LOD placement, floor filtering and the camera are invariant across it.
   */
  let look = applyLook(src.look ?? DEFAULT_LOOK);
  /* --- the atmosphere switches -----------------------------------------------------------
   * Founder, 2026-08-30: "items like fog take performance without adding fidelity."
   *
   * Every R1/R1.5 addition that costs a shader — the world fog extension, the post grade pass, the
   * triplanar ground detail — is REALISTIC-ONLY and individually switchable, so the cost of each
   * can be measured on the real GPU instead of argued about. `fxOn()` is the single gate; there is
   * no other place in this module that decides whether an effect is armed.
   *
   *   ?fx=            (absent)  every realistic effect on — the shipping realistic look
   *   ?fx=none                  realistic with no fog, no grade, no ground detail
   *   ?fx=fog,detail            only those two
   *
   * Vector is short-circuited before the switches are even read: it is the pre-R1 layer set and the
   * pre-R1 per-layer cost, and nothing here can opt it back into a shader.
   */
  const FX_KEYS = ['fog', 'grade', 'detail'];
  let fx = (() => {
    const raw = src.fx;
    if (raw == null || raw === '') return Object.fromEntries(FX_KEYS.map((k) => [k, true]));
    const want = new Set(String(raw).toLowerCase().split(',').map((s) => s.trim()).filter(Boolean));
    if (want.has('all')) return Object.fromEntries(FX_KEYS.map((k) => [k, true]));
    return Object.fromEntries(FX_KEYS.map((k) => [k, want.has(k)]));
  })();
  /** Is one realistic-only effect armed right now? The only reader of `look` for effect cost. */
  const fxOn = (key) => look === 'realistic' && fx[key] !== false;
  const mapDiagonal = limitDiagonal(data.limit);
  // The fog's height term is metres above the ground, so it needs the map's own ground level (real
  // game metres, relief applied in the shader) and the relief the camera is drawing at. Read live,
  // so changing relief does not mean a new extension and a recompile of every world shader.
  const groundMeters = referenceGroundMeters(data.terrain);
  const fogScene = () => ({ groundMeters, relief: RELIEF });
  // ONE extension instance per look. Creating a fresh one on every render() would make deck see
  // `extensionsChanged` every frame and recompile every world shader — the extensions are cached
  // here and only replaced by setLook().
  let fogExt = fxOn('fog') ? fogExtensionFor(look, mapDiagonal, fogScene) : null;
  // The realistic water material. Like the fog extension it is cached per look, never rebuilt per
  // render, or deck sees `extensionsChanged` every frame and recompiles the water shader.
  let waterExt = waterExtensionFor(look);
  let groundExt = null;   // realistic ground detail; armed once the textures upload
  let gradeEffect = null; // the combined post pass; armed once the LUT uploads
  let renderAssets = null, groundTextures = null, lutTexture = null;
  /** Spread into any WORLD layer. Labels/icons/quest/live/selection never call this. */
  const fogged = () => (fogExt ? { extensions: [fogExt] } : {});
  /** Same, for a layer that already carries its own extension (dashed paths). */
  const foggedWith = (...exts) => ({ extensions: fogExt ? [...exts, fogExt] : exts });

  const rebuildGround = () => {
    terrain = null;
    WATER = data.water || [];
    RELIEF = relief;
    if (!data.terrain) { BASE_H = () => 0; H = makeSurfaceSampler(BASE_H, data.hardRocks || [], relief); VOID_Z = -14; heightEpoch++; return; }
    data.terrain.limit = data.limit;
    try { terrain = buildTerrain(data, relief, { look }); BASE_H = terrain.H; VOID_Z = terrain.voidZ; }
    catch (e) {
      console.warn('terrain mesh failed, falling back to quads', e);
      const sample = makeSampler(data.terrain, relief), capWater = makeWaterHeightCapper(data.water || [], relief);
      BASE_H = (x, z) => capWater(sample(x, z), x, z);
      VOID_Z = Math.min(-14, Math.floor((Math.min(...data.terrain.heights) * relief - 10) / 2) * 2);
    }
    H = makeSurfaceSampler(BASE_H, data.hardRocks || [], relief);
    heightEpoch++;
  };
  const tGround = performance.now();
  rebuildGround();
  // --- end TRACK B ------------------------------------------------------------------------
  const inLimit = (x, z) => !data.limit || inPolyXZ([x, z], data.limit);
  const centroidOf = centroid;
  /**
   * Seat every building on the draped ground. The rule (and the foundation bug it replaces) lives
   * in src/buildings.js so `npm run test:buildings` can assert against the same functions: the
   * walls sit on the ground under the footprint centroid and stand exactly `height` metres, and
   * the downhill gap is closed by the dark, unlit, capped skirt — never by wall-coloured mass.
   */
  const placeBuildings = () => seatBuildings(data.buildings, H);
  const tBuildings = performance.now();
  placeBuildings();
  const tTrees = performance.now();
  const treeSet = prepareTrees(data.trees, mapData.key);
  const tAtlas = performance.now();
  prepMs = { ground: Math.round(tBuildings - tGround), buildings: Math.round(tTrees - tBuildings), trees: Math.round(tAtlas - tTrees) };
  let iconAtlas = await atlasPromises.icons;
  const arrowAtlas = await atlasPromises.arrows;
  const soldierAtlas = await atlasPromises.soldiers;
  // What the atlas cost ON TOP of the synchronous prep it now overlaps, and when it was ready.
  atlasWaitMs = Math.round(performance.now() - tAtlas);
  atlasReadyMs = Math.round(performance.now() - bootMs);
  for (const m of Object.values(arrowAtlas.mapping)) m.anchorY = 32;
  const chipOf = (atlas) => ({ canvas: atlas.canvas, mapping: Object.fromEntries(Object.entries(atlas.mapping).map(([k, m]) => [k, { ...m, anchorY: 32 }])) });
  let chipAtlas = chipOf(iconAtlas);
  /** Marker icon keys the current atlas cannot draw — 0 is the invariant, and renderStats reports it. */
  const missingIconKeys = () => {
    const out = new Set();
    for (const m of src.markers()) if (KINDS[m.kind]) { const k = markerIconKey(m); if (!iconAtlas.mapping[k]) out.add(k); }
    return out;
  };
  /**
   * Re-cut the icon atlas when markers arrive with keys it does not hold (see markerAtlasEntries).
   *
   * Called from `refresh()`, which main.js calls exactly when the marker set can have changed — the
   * fetch landing, a layer filter, a live tick. One rebuild at a time; a rebuild that finds nothing
   * missing costs one pass over ~150 markers and returns.
   */
  let atlasRebuilding = null;
  function ensureMarkerIcons() {
    if (atlasRebuilding || !missingIconKeys().size) return;
    atlasRebuilding = buildAtlas(iconEntries(), 64).then((next) => {
      iconAtlas = next;
      chipAtlas = chipOf(next);
      atlasRebuilding = null;
      if (initialised) render();
    }).catch(() => { atlasRebuilding = null; });
  }
  let viewState = { target: [0, 0, 0], zoom: 0, rotationX: CAM.rotationX, rotationOrbit: CAM.rotationOrbit, minZoom: -2, maxZoom: 5 };
  /**
   * The ground rect the zoom floor frames: the playable limit's own bbox, in game metres. This is
   * the same box main.js's fit3dZoom() covers (it reads the Leaflet bounds, which are the same
   * span), so the floor sits below the fit on every map and a fitted camera is never touched.
   */
  const groundExtent = (() => {
    const ring = data.limit;
    if (!Array.isArray(ring) || ring.length < 3) return {};
    const xs = ring.map((p) => p[0]), zs = ring.map((p) => p[1]);
    return { width: Math.max(...xs) - Math.min(...xs), depth: Math.max(...zs) - Math.min(...zs) };
  })();
  /**
   * Every camera move — dragged or programmatic — goes through camera.js's one clamp: the eye never
   * goes under the map, AND the map never shrinks to a slab in the void.
   *
   * The zoom floor is the half that used to be missing. A permalink (`#1.4/-209/-280` on Woods),
   * the wheel and the `-` key could all take the camera a zoom level and a half under `contain`,
   * where the diorama is a small rectangle centred in grey haze with the terrain mesh's black
   * underside on show along its lower edge. `minFitZoom()` is the floor that stops it, and this is
   * its only call site — a floor that is never called is not a floor.
   */
  const clampView = (v) => clampCamera(v, {
    ...groundExtent,
    viewportWidth: container.clientWidth || 1200,
    viewportHeight: container.clientHeight || 800,
    ground: (() => { try { return H(-(v.target?.[0] ?? 0), -(v.target?.[1] ?? 0)) ?? 0; } catch { return 0; } })(),
  });
  let hover = null;
  // The viewport deck's last redraw actually used — textLayout()'s fallback when getViewports()
  // has not been populated yet (see the note there).
  let lastViewport = null;
  let fontsReady = false, initialised = false;
  // atlas is keyed on fontFamily: use the fallback stack until the webfont is confirmed, then switch (forces a fresh atlas)
  const LABEL_FONT = () => (fontsReady ? 'Barlow Condensed, Arial Narrow, system-ui, sans-serif' : 'Arial Narrow, system-ui, sans-serif');
  const fontLoaded = () => { try { return document.fonts?.check?.('700 16px "Barlow Condensed"') ?? true; } catch { return true; } };
  const waitFonts = (async () => { try { await Promise.race([document.fonts?.load?.('700 16px "Barlow Condensed"') ?? Promise.resolve(), new Promise((r) => setTimeout(r, 4000))]); } catch {} })();
  waitFonts.then(() => { fontsReady = fontLoaded(); if (initialised) render(); });
  let floor = 'all'; // 'all' | 0 | 1 | 2 | 3 | 'U'
  let nature = { trees: true, rocks: true };
  const capH = (b, h) => (floor === 'all' || floor === 'U' ? h : Math.min(h, (Number(floor) + 1) * 3.3 - 0.4 + (b.style === 'canopy' ? 10 : 0)));

  // TRACK B / STAGE 1: the scene light and the terrain bake's key light now come from the SAME two
  // frozen numbers in src/render-style.js (azimuth 230, elevation 21), so the two shading systems
  // cannot be lit from different sides and flatten the relief between them.
  const sceneLighting = () => lightingFor(look);
  let lighting = sceneLighting();
  /** Every effect deck should be running right now, in order: lighting, then the combined grade. */
  const sceneEffects = () => [lighting, ...(gradeEffect ? [gradeEffect] : [])];
  const shoreData = (data.water || []).flatMap((water) => waterRings(water).map((path) => ({ water, path })));

  // ---- rock masses -----------------------------------------------------------------------
  // The relief factor is applied in exactly one place per surface: the terrain field inside
  // terrain.js, and a hard rock's own top here, in `hardRockLift`. `makeSurfaceSampler` above and
  // every layer below read those two — nothing multiplies by RELIEF a second time.
  const hardRocks = (data.hardRocks || []).filter((r) => Array.isArray(r?.poly) && r.poly.length >= 3);
  // The ground under each mass, sampled once per relief change rather than per frame per vertex.
  let rockGroundEpoch = -1, rockGroundCache = new Map();
  const rockGround = (d) => {
    if (rockGroundEpoch !== heightEpoch) { rockGroundCache = new Map(); rockGroundEpoch = heightEpoch; }
    let g = rockGroundCache.get(d);
    if (!g) {
      let lo = Infinity, hi = -Infinity;
      for (const [x, z] of d.poly) { const h = BASE_H(x, z); if (h < lo) lo = h; if (h > hi) hi = h; }
      g = { lo: lo - 0.5, hi };
      rockGroundCache.set(d, g);
    }
    return g;
  };
  /**
   * A hard rock's top in displayed metres — the same number `makeSurfaceSampler` puts in H().
   *
   * A measured mass (`surfaceY`) is a flat lid at an absolute altitude, so it is drawn from a base
   * buried under the mass's lowest ground; the old layer extruded a constant height from the
   * *draped* base instead, which tilted the lid with the hillside while H() held it flat — the
   * sampler and the geometry disagreeing by the cross-slope, times relief. A mass without a measured
   * top is a lift above the ground it stands on, and stays draped, which is what H() says too.
   */
  const hardRockTop = (d) => (Number.isFinite(d.surfaceY) ? d.surfaceY * RELIEF : rockGround(d).hi + (d.height ?? 1.2) * RELIEF);
  /** The extrusion of a MEASURED mass: it is drawn from a base buried under its lowest ground. */
  const hardRockLift = (d) => Math.max(0.1, hardRockTop(d) - rockGround(d).lo);
  /**
   * How tall the mass actually stands above the ground it stands on — its own height, not its lift.
   *
   * For a draped mass this is exactly `height * RELIEF` (it is drawn draped, so that is its height
   * over every point of its footprint); for a measured one it is the lid minus the highest ground
   * under it. The two differ by the ground drop across the footprint, which on Woods' widest mass
   * (17,199 m², 49 m of drop at relief 3) is more than the mass is tall.
   */
  const hardRockHeight = (d) => Math.max(0.1, hardRockTop(d) - rockGround(d).hi);
  /**
   * Talus steps under every hard rock.
   *
   * The masses carry a measured absolute top (Woods' Sniper Mountain: 77.52 / 64.62 / 52.27 m) and
   * that top has to stay exactly where the sampler puts it — markers, trees and players are all
   * placed from H(). What read as a "giant untextured grey slab" was the SIDE: one prism per mass is
   * a vertical curtain from the grass to the lid, 170 m of it once relief exaggerates the field. So
   * each mass also gets a short flight of outward, downward steps: the silhouette slopes into a
   * talus, the faces catch different light, and no step reaches the mass's own top.
   *
   * Each step is a DRAPED prism — its base follows the terrain — so its height above the ground it
   * stands on is its elevation, and scaling that elevation by the mass's *lift* was wrong: the lift
   * carries the whole ground drop across the footprint on top of the real height. Woods' hardRocks[0]
   * is 48 m tall and lifted 97 m, so its innermost step stood 75.7 m over the grass, 27.7 m proud of
   * the summit it was supposed to buttress. Two numbers fix it: the step keeps a fraction of the
   * mass's own HEIGHT, and it is additionally capped by the headroom under the mass's top at the
   * highest ground its own ring crosses — so `groundᵢ + elevation <= ringHi + headroom = rockTop`
   * holds at every vertex, on any slope, for measured and draped masses alike.
   */
  const TALUS = [0.78, 0.56, 0.34, 0.16];   // fraction of the mass's own height each step keeps
  /** How far the foot of the slope spreads: about half the rise, never more than three footprints. */
  const talusReach = (d) => Math.min(Math.max(2, hardRockHeight(d) * 0.55), Math.sqrt(Math.max(1, polyArea(d.poly))) * 3);
  const groundCeiling = (poly) => { let hi = -Infinity; for (const [x, z] of poly) { const h = BASE_H(x, z); if (h > hi) hi = h; } return hi; };
  let talusEpoch = -1, talusRows = [];
  const talusData = () => {
    if (talusEpoch === heightEpoch) return talusRows;
    talusEpoch = heightEpoch;
    talusRows = hardRocks.flatMap((d) => {
      const reach = talusReach(d), rise = hardRockHeight(d), top = hardRockTop(d);
      return TALUS.map((keep, i) => {
        const poly = expand(d.poly, (reach * (i + 1)) / TALUS.length);
        return {
          rock: d, keep, poly,
          height: Math.max(0.1, Math.min(rise, top - groundCeiling(poly)) * keep),
          color: mul(d.color ? liftTone(d.color, 0.08) : C.rock, 0.95 - i * 0.045),
        };
      });
    });
    return talusRows;
  };
  /**
   * Trees standing in the talus band are inside solid rock: the steps are drawn OUTSIDE the mass's
   * polygon, where H() is still bare terrain, so nothing placed from H() knows they are there
   * (markers escape only because they draw with depthCompare 'always'). 118 of Woods' 2,307 trees
   * were inside prisms taller than any conifer. A scree slope has no trees on it anyway.
   *
   * The band is measured at relief 3 whatever the current relief is, because tree DENSITY must not
   * change with a display preference (src/trees.js: "Relief changes placement, never density").
   */
  if (hardRocks.length) {
    const bands = hardRocks.map((d) => {
      const poly = expand(d.poly, talusReach(d) * (3 / (RELIEF || 3)));
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const [x, z] of poly) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
      return { poly, x0, x1, z0, z1 };
    });
    const inTalus = (t) => bands.some((b) => t.x >= b.x0 && t.x <= b.x1 && t.z >= b.z0 && t.z <= b.z1 && inPolyXZ([t.x, t.z], b.poly));
    treeSet.all = treeSet.all.filter((t) => !inTalus(t));
    treeSet.far = treeSet.far.filter((t) => !inTalus(t));
  }
  // A "rock" wider than ~40 m across is a landform, not a boulder. Extruding one as a flat-lidded
  // prism is what turned Reserve's 22,000 m² southern cliff mass into a grey slab with a hard edge
  // straight across half the map; those are draped as rocky ground instead, so the relief the
  // heightfield already carries shows through. Customs' largest is 847 m², so it keeps every prism.
  const ROCK_MASS_AREA = 1200;
  const rockRows = (data.rocks || []).map((r) => ({ poly: r.poly ?? r, height: r.height ?? 1.2, color: r.color })).filter((r) => Array.isArray(r.poly) && r.poly.length >= 3);
  const boulders = rockRows.filter((r) => polyArea(r.poly) <= ROCK_MASS_AREA);
  const rockMasses = rockRows.filter((r) => polyArea(r.poly) > ROCK_MASS_AREA);

  const staticLayers = () => {
  const waterSurface = terrain?.waterLayer?.(look, { fogExtension: fogExt, waterExtension: waterExt }) ?? null;
  return [
    // TRACK B: contours are baked into the ground texture (smooth at any zoom, no z-fighting, zero layers)
    ...(data.limit ? [
      /*
       * The backdrop plane. R1.5 made it FOGGED and much wider than the map.
       *
       * It used to be painted the exact clear colour, 60 m past the limit — so the whole background
       * was one flat sheet and the map ended on a hard cut ("floating diorama"). It is now the
       * contract's darker ground haze, reaching `voidMargin` past the limit, and the same
       * distance fog every world layer takes washes it to the far-fog value on its way out. The
       * frame reads sky at the top, haze at the horizon, and the two meet in a gradient rather
       * than at an edge.
       *
       * It is a GRID of quads, not one rectangle — see voidGrid(): a four-vertex plane cannot
       * carry a per-vertex fog gradient at all.
       *
       * ...which is exactly why VECTOR gets one rectangle. With no fog there is no gradient to
       * carry, and 961 quads of flat colour is 959 quads of nothing: vector is back to the pre-R1
       * single plane, tessellated on demand only when the fog that needs it is armed.
       */
      new SolidPolygonLayer({ id: 'void', shadowEnabled: false, data: fogExt ? voidGrid(data.limit, voidMargin(look, mapDiagonal)) : [voidQuad(data.limit, voidMargin(look, mapDiagonal))], getPolygon: (d) => d.map(([x, z]) => P([x, z], VOID_Z)), getFillColor: C.oob, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...fogged() }),
    ] : []),
    ...(terrain
      ? terrain.layers(look, { fogExtension: fogExt, groundExtension: groundExt })
      : [new SolidPolygonLayer({ id: 'land', shadowEnabled: false, data: data.land, getPolygon: (d) => ringG(d, 0), getFillColor: C.land, updateTriggers: { getPolygon: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...fogged() })]),
    // At-grade pavement, roads, dirt/tracks, and rail are in terrain.js's single baked texture.
    //
    // Water is TWO mutually exclusive layers with two ids, never one id whose class changes: deck
    // matches layers across renders by id and transfers the old layer's state onto the new one, so
    // swapping a SolidPolygonLayer for a SimpleMeshLayer under one id hands the mesh layer a state
    // with no model in it. Realistic draws the depth-tinted surface (terrain.js's water mesh);
    // vector keeps the flat semantic fill Part C's flip table asks for.
    ...(waterSurface ? [waterSurface] : [
      new SolidPolygonLayer({ id: 'water', shadowEnabled: false, data: data.water || [], getPolygon: (d) => waterPolygon(d), getFillColor: C.water, updateTriggers: { getPolygon: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...fogged() }),
    ]),
    new SolidPolygonLayer({ id: 'minefields', shadowEnabled: false, data: data.minefields || [], getPolygon: (d) => ringG(d, 0.14), getFillColor: [142, 88, 52, 62], updateTriggers: { getPolygon: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...fogged() }),
    new SolidPolygonLayer({ id: 'understory', shadowEnabled: false, data: data.understory || [], getPolygon: (d) => ringG(d, 0.09), getFillColor: C.understory, updateTriggers: { getPolygon: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...fogged() }),
    new PathLayer({ id: 'shore', shadowEnabled: false, data: shoreData, getPath: (d) => [...d.path, d.path[0]].map((point) => waterPoint(d.water, point, 0.04)), getColor: C.shore, getWidth: 0.5, widthUnits: 'meters', widthMinPixels: 1, updateTriggers: { getPath: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...fogged() }),
    new PathLayer({ id: 'cables', shadowEnabled: false, data: data.powerlines || [], getPath: (d) => catenary(d.path, 19), getColor: [96, 96, 92, 170], getWidth: 0.2, widthUnits: 'meters', widthMinPixels: 1, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...fogged() }),
    // Rock material: the old ambient 0.72 / diffuse 0.5 lit every face of a mass to within a few
    // values of every other, which is exactly how a rock stops looking like a rock. Letting the sun
    // do the work separates lid from wall and one wall from the next.
    new SolidPolygonLayer({ id: 'rock-talus', shadowEnabled: false, data: talusData(), getPolygon: (d) => d.poly.map(([x, z]) => P([x, z], BASE_H(x, z) + 0.02)), extruded: true, getElevation: (d) => d.height, getFillColor: (d) => d.color, updateTriggers: { getPolygon: heightEpoch, getElevation: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...fogged(), material: surfaceMaterial(look, 'rock') }),
    new SolidPolygonLayer({ id: 'hard-rocks', shadowEnabled: false, data: hardRocks, getPolygon: (d) => (Number.isFinite(d.surfaceY) ? d.poly.map(([x, z]) => P([x, z], rockGround(d).lo)) : d.poly.map(([x, z]) => P([x, z], BASE_H(x, z) + 0.04))), extruded: true, getElevation: (d) => (Number.isFinite(d.surfaceY) ? hardRockLift(d) : Math.max(0.1, (d.height ?? 1.2) * RELIEF)), getFillColor: (d) => d.color ? liftTone(d.color, 0.08) : C.rock, updateTriggers: { getPolygon: heightEpoch, getElevation: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...fogged(), material: surfaceMaterial(look, 'rock') }),
    new SolidPolygonLayer({ id: 'rock-masses', shadowEnabled: false, data: rockMasses, getPolygon: (d) => ringG(d.poly, 0.05), getFillColor: (d) => [...(d.color ? liftTone(d.color, 0.06) : C.rock).slice(0, 3), 150], updateTriggers: { getPolygon: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...fogged() }),
    new SolidPolygonLayer({ id: 'rocks', shadowEnabled: false, data: boulders, getPolygon: (d) => ringG(d.poly, 0.04), extruded: true, getElevation: (d) => d.height, getFillColor: (d) => d.color ? liftTone(d.color, 0.1) : C.rock, updateTriggers: { getPolygon: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...fogged(), material: surfaceMaterial(look, 'boulder') }),
  ];
  };
  const makeFloorLines = () => data.buildings.flatMap((b) => Array.from({ length: Math.max(0, b.floors - 1) }, (_, k) => ({ path: [...ringAt(expand(b.poly, 0.15), (k + 1) * 3.3 + (b.base ?? 0)), ringAt(expand(b.poly, 0.15), (k + 1) * 3.3 + (b.base ?? 0))[0]] })));
  let floorLines = makeFloorLines();
  let propData = propParts(data.props || []);
  const fenceStrips = (data.fences || []).map((f) => ({ poly: strip(f.path, 0.12) }));
  const extraLayers = () => {
  const SHADE_RINGS = shadowRings(look);
  return [
    new SolidPolygonLayer({ id: 'props', data: propData, getPolygon: (d) => d.drape ? ringG(d.poly, d.dz) : ringAt(d.poly, footprintGround(d.poly) + d.dz), extruded: true, getElevation: (d) => d.h, getFillColor: (d) => d.color, updateTriggers: { getPolygon: heightEpoch }, pickable: true, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...fogged(), material: surfaceMaterial(look, 'prop') }),
    new PathLayer({ id: 'fence-tops', shadowEnabled: false, data: data.fences || [], getPath: (d) => ringG(d.path, 1.98), getColor: C.fenceTop, getWidth: 0.3, widthUnits: 'meters', widthMinPixels: 1, updateTriggers: { getPath: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...fogged() }),
    new SolidPolygonLayer({ id: 'fences-3d', shadowEnabled: false, data: fenceStrips, getPolygon: (d) => ringG(d.poly, 0.04), extruded: true, getElevation: 1.9, getFillColor: C.fence, updateTriggers: { getPolygon: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...fogged() }),
    /*
     * The contact shadow: THREE rings now, not two, and a cool damp blue-grey rather than ink.
     *
     * deck's cast shadow is gated on Stage 7 (and on a kilometre-scale relief surface its depth16
     * map goes straight into acne — see the note in terrain.js), so this stack IS the soft shadow.
     * Widening it from two rings to three, with the outermost at 7% opacity, is what "soften shadow
     * edges" means without a shadow map: the penumbra is approximated by more, fainter steps. The
     * colour comes from SHADOW.realistic — an overcast shadow is lit by the whole sky dome, so it
     * is blue-grey; #0a0c0a was a night-time value on a damp afternoon.
     */
    new SolidPolygonLayer({ id: 'shade-wide', shadowEnabled: false, data: data.buildings, getPolygon: (d) => ringG(expand(d.poly, SHADE_RINGS[2]), 0.09), getFillColor: C.shadeWide, updateTriggers: { getPolygon: [heightEpoch, look] }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...fogged() }),
    new SolidPolygonLayer({ id: 'shade-soft', shadowEnabled: false, data: data.buildings, getPolygon: (d) => ringG(expand(d.poly, SHADE_RINGS[1]), 0.10), getFillColor: C.shadeSoft, updateTriggers: { getPolygon: [heightEpoch, look] }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...fogged() }),
    new SolidPolygonLayer({ id: 'shade', shadowEnabled: false, data: data.buildings, getPolygon: (d) => ringG(expand(d.poly, SHADE_RINGS[0]), 0.11), getFillColor: C.shade, updateTriggers: { getPolygon: [heightEpoch, look] }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...fogged() }),
    new SolidPolygonLayer({ id: 'piers', data: (data.bridges || []).flatMap(piers), getPolygon: (d) => box(d.pos, d.w).map(([x, y]) => [x, y, d.bottom]), extruded: true, getElevation: (d) => d.h, getFillColor: C.pier, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...fogged(), material: surfaceMaterial(look, 'slabLike') }),
    new PathLayer({ id: 'bridge-edges', shadowEnabled: false, data: (data.bridges || []).filter((b) => !b.ford), getPath: (d) => bridgePath(d).map((q) => [q[0], q[1], q[2] - 0.15]), getColor: [128, 124, 114], getWidth: (d) => d.width + 1.2, widthUnits: 'meters', widthMinPixels: 2, capRounded: false, jointRounded: true, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...fogged() }),
    new PathLayer({ id: 'bridges', shadowEnabled: false, data: data.bridges || [], getPath: bridgePath, getColor: (d) => (d.foot ? [128, 108, 82] : d.ford ? [150, 143, 126] : C.bridge), getWidth: (d) => d.width, widthUnits: 'meters', widthMinPixels: 2, capRounded: false, jointRounded: true, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...fogged() }),
    new PathLayer({ id: 'bridge-rails', shadowEnabled: false, data: (data.bridges || []).filter((b) => !b.ford).flatMap((b) => { const p = bridgePath(b).map((q) => [q[0], q[1], q[2] + 1.1]); return [offsetPath(p, b.width / 2 - 0.3), offsetPath(p, -(b.width / 2 - 0.3))]; }), getPath: (d) => d, getColor: C.bridgeRail, getWidth: 0.4, widthUnits: 'meters', widthMinPixels: 1, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...fogged() }),
    new PathLayer({ id: 'floor-lines', shadowEnabled: false, data: floorLines, getPath: (d) => d.path, getColor: C.floorLine, getWidth: 0.35, widthUnits: 'meters', widthMinPixels: 1, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...fogged() }),
  ];
  };
  tintBuildings(data.buildings);
  // Scenes for things the footprint data has no polygon for: the ZB bunker mouths and the road
  // checkpoints. Oriented towards the middle of the map so the door always faces the player.
  const mid = data.limit ? centroidOf(data.limit) : [0, 0];
  const SCENES = { 'ZB-1011': 'bunker', 'ZB-013': 'bunker', "Smugglers' Bunker (ZB-1012)": 'bunker',
    'Scav Checkpoint': 'checkpoint', 'Military Base CP': 'checkpoint', 'RUAF Roadblock': 'checkpoint' };
  const scenes = src.markers().filter((m) => SCENES[(m.name || '').trim()]).map((m) => ({
    type: SCENES[m.name.trim()], pos: [m.position.x, m.position.z], tower: m.name.trim() === 'Military Base CP',
    rot: Math.atan2(mid[1] - m.position.z, mid[0] - m.position.x) }));
  let details = detailParts(data.buildings, scenes);
  const showLvl = (d) => floor === 'all' || floor === 'U' || d.lvl <= (Number(floor) + 1) * 3.3;
  let parts = buildingParts(data.buildings);
  const undergroundLayers = () => floor !== 'U' ? [] : [
    new SolidPolygonLayer({ id: 'underground', shadowEnabled: false, data: data.underground || [], getPolygon: (d) => ringG(d.poly, 0.4), getFillColor: C.undergroundOn, updateTriggers: { getPolygon: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, pickable: true, parameters: OVERLAY }),
    new PathLayer({ id: 'underground-outline', shadowEnabled: false, data: data.underground || [], getPath: (d) => ringG([...d.poly, d.poly[0]], 0.44), getColor: [255, 220, 150, 235], getWidth: 2, widthUnits: 'pixels', updateTriggers: { getPath: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, parameters: OVERLAY }),
    new TextLayer({ id: 'underground-badges', data: (data.underground || []).filter((d) => polyArea(d.poly) > 1000), getPosition: (d) => Pg(centroidOf(d.poly), 0.7), getText: () => 'U', getSize: 13, sizeUnits: 'pixels', getColor: C.ink, background: true, getBackgroundColor: [255, 176, 48, 245], backgroundPadding: [4, 2, 4, 2], fontFamily: LABEL_FONT(), fontWeight: 700, fontSettings: LABEL_SDF, billboard: true, parameters: OVERLAY, updateTriggers: { getPosition: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
  ];
  const buildingLayer = () => [...undergroundLayers(),
    /*
     * The dark skirt that closes the gap between a wall base and the downhill ground.
     *
     * Its own layer, and it must stay that way. `material: false` is the load-bearing prop: deck
     * lights an `extruded: true` SolidPolygonLayer, and a LIT box in a wall-ish tint is exactly the
     * "foundation that makes it look like a 10 story building when it's 3" the founder reported on
     * 2026-08-30. Unlit + near-black (`plinthColor`) + `PLINTH_EXPAND_M` instead of the old 0.25 m
     * ledge means the skirt reads as the shadow under a building, and only the wall above it can
     * ever be counted as storeys.
     */
    new SolidPolygonLayer({
      id: 'building-plinths', visible: floor !== 'U', shadowEnabled: false, data: details.plinths,
      getPolygon: (d) => ringAt(d.poly, d.base), extruded: true, getElevation: (d) => d.h,
      getFillColor: plinthColor(look), material: false,
      updateTriggers: { getPolygon: heightEpoch, getFillColor: look },
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...fogged(),
    }),
    new SolidPolygonLayer({
      id: 'buildings', visible: floor !== 'U', data: parts.walls, getPolygon: (d) => ringAt(d.poly, d.base ?? footprintGround(d.poly)), extruded: true, getElevation: (d) => capH(d, d.h), updateTriggers: { getPolygon: heightEpoch, getElevation: floor, getFillColor: [hover, floor] },
      getFillColor: (d, { index }) => (hover === index ? C.buildingHover : d.color ? liftTone(d.color, 0.12) : d.tint ? d.tint : d.kind === 'tank' ? C.tank : d.kind === 'powerline_towers' ? C.tower : d.floors > 1 ? C.buildingMulti : C.building),
      pickable: true, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...fogged(),
      material: surfaceMaterial(look, 'building'),
      onHover: (i) => { if (i.index !== hover) { hover = i.index; render(); } },
    }),
    new SolidPolygonLayer({ id: 'roofs', visible: floor === 'all', data: parts.roofs, getPolygon: (d) => d.pts.map(([x, z, y]) => P([x, z], y + (d.b.base ?? footprintGround(d.b.poly)))), getFillColor: (d) => d.color, updateTriggers: { getPolygon: heightEpoch }, pickable: true, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...fogged(), material: surfaceMaterial(look, 'roof') }),
    /*
     * Flat roof decks. No `material` here, and none is missing: deck's SolidPolygonLayer only calls
     * `lighting_getLightColor` when `extruded` is true (solid-polygon-layer-vertex-main.glsl), so
     * every flat cap in this module — slabs, detail-flats, and the pitched `roofs` layer — is
     * UNLIT and takes its albedo verbatim. That is why a roof's sky lobe is folded into its colour
     * by atmosphere.js's materialTint() instead of being asked for as a Phong specular here.
     */
    new SolidPolygonLayer({ id: 'slabs', visible: floor !== 'U', shadowEnabled: false, data: parts.slabs.filter((d) => floor === 'all' || d.z <= (Number(floor) + 1) * 3.3), getPolygon: (d) => ringAt(d.poly, d.z + (d.base ?? footprintGround(d.poly))), updateTriggers: { getPolygon: [floor, heightEpoch] }, getFillColor: (d) => d.color, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...fogged() }),
    new SolidPolygonLayer({ id: 'posts', visible: floor !== 'U', data: parts.posts, getPolygon: (d) => box(P(d.pos), d.w).map(([x, y]) => [x, y, d.base ?? H(d.pos[0], d.pos[1])]), extruded: true, getElevation: (d) => d.h, getFillColor: (d) => d.color, updateTriggers: { getPolygon: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...fogged(), material: surfaceMaterial(look, 'slabLike') }),
    new SolidPolygonLayer({ id: 'detail-boxes', visible: floor !== 'U', data: details.boxes.filter(showLvl), getPolygon: (d) => ringAt(d.poly, d.base), extruded: true, getElevation: (d) => d.h, getFillColor: (d) => d.color, updateTriggers: { getPolygon: [floor, heightEpoch] }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...fogged(), material: surfaceMaterial(look, 'prop') }),
    new SolidPolygonLayer({ id: 'detail-flats', visible: floor !== 'U', shadowEnabled: false, data: details.flats.filter(showLvl), getPolygon: (d) => d.ring, getFillColor: (d) => d.color, updateTriggers: { getPolygon: [floor, heightEpoch] }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...fogged() }),
    new PathLayer({ id: 'detail-lines', visible: floor !== 'U', shadowEnabled: false, data: details.lines.filter(showLvl), getPath: (d) => d.path, getColor: (d) => d.color, getWidth: (d) => d.w, widthUnits: 'meters', widthMinPixels: 1, updateTriggers: { getPath: [floor, heightEpoch] }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...fogged() }),
    new PathLayer({ id: 'detail-dashes', visible: floor !== 'U', shadowEnabled: false, data: details.dashes.filter(showLvl), getPath: (d) => d.path, getColor: (d) => d.color, getWidth: (d) => d.w, widthUnits: 'meters', widthMinPixels: 1, getDashArray: (d) => d.dash, dashJustified: false, updateTriggers: { getPath: [floor, heightEpoch] }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...foggedWith(dashExt) }),
    new ScatterplotLayer({ id: 'detail-dots', visible: floor !== 'U', shadowEnabled: false, data: [...details.dots, ...parts.dots].filter(showLvl), getPosition: (d) => d.pos, getRadius: (d) => d.r, radiusUnits: 'meters', radiusMinPixels: 0.5, getFillColor: (d) => d.color, updateTriggers: { getPosition: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...fogged() }),
    new PathLayer({ id: 'slab-edges', visible: floor !== 'U', shadowEnabled: false, data: parts.edges, getPath: (d) => d.path.map((q) => [q[0], q[1], q[2] + (d.base ?? 0)]), getColor: [143, 137, 125], getWidth: (d) => (d.wide ? 0.9 : 0.3), widthUnits: 'meters', widthMinPixels: 1, updateTriggers: { getPath: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, ...fogged() }),
  ];
  const major = (d) => (d.size ?? 100) >= 100;
  const lift = (d) => (major(d) ? 26 : 16) * ((d.size ?? 100) / 100);
  // name "beam": a soft vertical light column from the ground to the name (no cap, no outline)
  const pingLayers = (labelsAll) => { const labels = labelsAll.filter((d) => major(d) || viewState.zoom >= 0.8); return [
    new ScatterplotLayer({ id: 'ping-base', data: labels, getPosition: (d) => Pg(d.position, 0.65), getRadius: (d) => (major(d) ? 2.4 : 1.6), radiusUnits: 'meters', radiusMinPixels: 2, getFillColor: [255, 255, 255, 110], parameters: OVERLAY, updateTriggers: { getPosition: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new LineLayer({ id: 'ping-beam-glow', data: labels, getSourcePosition: (d) => Pg(d.position, 0.7), getTargetPosition: (d) => Pg(d.position, lift(d) - 0.5), getColor: [255, 255, 255, 38], getWidth: 7, widthUnits: 'pixels', parameters: OVERLAY, updateTriggers: { getSourcePosition: heightEpoch, getTargetPosition: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new LineLayer({ id: 'ping-beam-mid', data: labels, getSourcePosition: (d) => Pg(d.position, 0.7), getTargetPosition: (d) => Pg(d.position, lift(d) - 0.5), getColor: [255, 255, 255, 90], getWidth: 3, widthUnits: 'pixels', parameters: OVERLAY, updateTriggers: { getSourcePosition: heightEpoch, getTargetPosition: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new LineLayer({ id: 'ping-beam-core', data: labels, getSourcePosition: (d) => Pg(d.position, 0.7), getTargetPosition: (d) => Pg(d.position, lift(d) - 0.5), getColor: [255, 255, 255, 230], getWidth: 1, widthUnits: 'pixels', parameters: OVERLAY, updateTriggers: { getSourcePosition: heightEpoch, getTargetPosition: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
  ]; };

  /* --- screen-space text placement -------------------------------------------------------
   * Everything with words in it is laid out ONCE per frame, in screen pixels, against one
   * occupancy list. Three independent world-space TextLayers cannot de-conflict with each
   * other, with the quest pins, or with the floating HUD, and every one of those was a defect:
   *
   *   D3/M8  a label whose ANCHOR is on screen but whose BOX is not was drawn cut — "HECKPOINT",
   *          "WER SNIPER RIDGE", "RAILWAY BRIDGE TO TAR…". Nothing decided that a half-drawn
   *          word is worse than no word.
   *   D4     the bottom row was drawn under the omnibox ("UN ROADBLOCK", and a bare badge below it).
   *   M1     "DEPOT" and "SMUGGLERS' BUNKER (ZB-1012) · UNDERGROUND" printed through each other
   *          on every Customs frame; same for OLD GAS and FORTRESS.
   *   D6     a quest pin landed centred on "CRACKHOUSE" and ate a letter.
   *
   * One pass, in priority order — quest pins (they are why the panel is open) → major place
   * names → the extract names that belong under them → minor place names. Each box is first
   * NUDGED into the safe rect (never cut), then walked up/down a short ladder until it is clear
   * of everything already seated; a box that can do neither is hidden. Hiding beats cutting: a
   * word the reader cannot finish is worse than a landmark they can still see the ping of.
   */
  const LABEL_INSET = 12;   // px of clear air between a label's ink and the chrome
  const LABEL_NUDGE = 22;   // px a label may slide to escape the chrome before it is hidden
  // M10: Woods place labels bottomed out at 10 px, ≈7 px of cap height — shapes, not words, on the
  // physically largest map. The floor is the one number that decides the smallest map's type.
  const MAJOR_MIN_PX = 12, MINOR_MIN_PX = 11;
  // The live marker's own screen footprint (ring + dot), and the name plate that hangs off it.
  const PLAYER_MARK_PX = 30, PLAYER_NAME_PX = 13, PLAYER_NAME_GAP = 15;
  /*
   * How wide a label's ink actually is, MEASURED — not estimated.
   *
   * This used to be `text.length * px * (weight >= 700 ? 0.52 : 0.47)`, a per-glyph average for
   * Barlow Condensed. A name that draws WIDER than its estimate clears boxHit() against a
   * neighbour that is already seated and is then seated straight on top of it. That is QA H1 on
   * the Customs default frame: "POWERLINE TOWER" and "SNIPER RIDGE" printing as one word,
   * "DEPOT" over "SMUGGLERS' BUNKER · UNDERGROUND", which in turn ran under "WAREHOUSE 3".
   * Digits, spaces and punctuation are where a per-character average is worst, and the long
   * underground names are all three at once.
   *
   * One 2d context answers it, in the same font string deck's own TextLayer atlas is built from
   * (LABEL_FONT()), so the two cannot disagree. Text metrics are linear in font size, so each
   * string is measured ONCE at a reference size and scaled — the cache is bounded by the number
   * of distinct names, not by the continuum of zoom-driven pixel sizes. The font epoch is part of
   * the key: LABEL_FONT() switches from the Arial Narrow fallback to Barlow Condensed the moment
   * document.fonts confirms it, and a width measured against the fallback is wrong afterwards.
   */
  const MEASURE_PX = 100;
  const measureCtx = (() => { try { return document.createElement('canvas').getContext('2d'); } catch { return null; } })();
  const widthCache = new Map();
  const estWidth = (text, px, weight) => text.length * px * (weight >= 700 ? 0.52 : 0.47);
  function refWidth(text, weight) {
    const key = `${fontsReady ? 1 : 0}|${weight}|${text}`;
    const hit = widthCache.get(key);
    if (hit !== undefined) return hit;
    let w = 0;
    if (measureCtx) {
      try {
        const want = `${weight} ${MEASURE_PX}px ${LABEL_FONT()}`;
        measureCtx.font = want;
        // An invalid shorthand is silently IGNORED by the setter and the context keeps its old
        // font, which would hand back confident nonsense. Only trust a font that stuck.
        if (measureCtx.font.includes(`${MEASURE_PX}px`)) {
          const m = measureCtx.measureText(text);
          const ink = Number.isFinite(m.actualBoundingBoxLeft) && Number.isFinite(m.actualBoundingBoxRight)
            ? m.actualBoundingBoxLeft + m.actualBoundingBoxRight : 0;
          w = Math.max(m.width || 0, ink);
        }
      } catch { w = 0; }
    }
    if (!(w > 0)) w = estWidth(text, MEASURE_PX, weight);   // no canvas (tests, exotic hosts)
    widthCache.set(key, w);
    return w;
  }
  const inkWidth = (text, px, weight) => (refWidth(text, weight) * px) / MEASURE_PX;
  const boxHit = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  /** The avoid rect, inset, in the deck canvas' own pixels — or the whole canvas if there is none. */
  function textRect(vp) {
    let r = null;
    try { r = src.safeRect?.(); } catch { r = null; }
    const base = r && Number.isFinite(r.left) && r.right > r.left && r.bottom > r.top
      ? r : { left: 0, top: 0, right: vp.width, bottom: vp.height };
    return { left: Math.max(0, base.left) + LABEL_INSET, top: Math.max(0, base.top) + LABEL_INSET,
      right: Math.min(base.right, vp.width) - LABEL_INSET, bottom: Math.min(base.bottom, vp.height) - LABEL_INSET };
  }

  /**
   * What the last pass did, for `renderStats().labels`.
   *
   * A pass that BAILS hands every name back unseated, which looks exactly like no pass at all —
   * and that is how QA H1's overprint stayed on screen with a working seating pass in the file.
   * `bail` names the reason, so "the labels print through each other" is one read-out away from
   * "the pass never ran" instead of a bisect.
   */
  let layoutStats = { bail: 'not-yet-run', seated: 0, hidden: 0, rect: null };

  /**
   * @returns {{place:object[],extract:object[]}} draw-ready rows. `off` is the pixel offset the
   *   TextLayer applies; rows that could not be seated are simply absent. With no viewport yet
   *   (the very first frame) both lists come back unculled — drawing every name beats drawing none.
   */
  function textLayout(labelRows, markers, questPts, players = []) {
    const z = viewState.zoom ?? 0;
    const full = z >= 0.6;
    const place = labelRows
      .filter((d) => major(d) || z >= 0.8)
      .map((d) => ({ d, major: major(d), text: major(d) ? d.text.toUpperCase() : d.text,
        pos: Pg(d.position, lift(d) + 1.5), off: [0, 0] }));
    // Every extract marker gets a badge seat; only some of them get their NAME drawn.
    const extractAll = markers.filter((m) => m.kind.startsWith('extract')).map((m) => {
      const k = eKey(m), lit = pinnedExtract === k || hoverExtract === k;
      // The requirement is on the badge as a corner glyph now. Printing "REQ. GREEN FLARE" under
      // every extract at every zoom was half the marker soup, so the words only appear for the
      // one extract you are pointing at or have pinned.
      return { m, k, lit, text: (full || lit ? (m.name || '').toUpperCase() : shortName(m.name)) + levelSuffix(m),
        sub: lit ? subText(m) : '', size: lit ? 13.5 : 12, off: [0, 8],
        pos: Pg([m.position.x, m.position.z], 0.7),
        // Collision ranking uses the real-height field so changing visual relief cannot thin names.
        rankPos: P([m.position.x, m.position.z], H(m.position.x, m.position.z) / relief + 0.7) };
    });
    const extract = extractAll.filter((d) => d.m.name && (d.lit || z >= -0.6));

    /*
     * The viewport this pass measures in.
     *
     * `deck.getViewports()` is EMPTY until deck's own first redraw, and `dynamicLayers()` runs
     * inside `render()`, which is what feeds that redraw — so on a still map, where render() is
     * called once and no camera event ever follows, every frame after that keeps the layer set
     * built by the one pass that bailed. That is QA H1: a seating pass in the file, and thirteen
     * unseated names on the landing frame. `viewport` is the OrbitViewport the last redraw
     * actually used, kept by onAfterRender, and it is the honest answer on every frame but the
     * very first; getViewports() is only the fast path.
     */
    let vp = null;
    try { vp = deck?.getViewports?.()[0] ?? lastViewport; } catch { vp = lastViewport; }
    if (!vp || !vp.width || !vp.height) { layoutStats = { bail: 'no-viewport', seated: 0, hidden: place.length, rect: null }; return { place, extract, badge: null }; }
    const rect = textRect(vp);
    if (rect.right - rect.left < 60 || rect.bottom - rect.top < 60) {
      layoutStats = { bail: 'rect-too-small', seated: 0, hidden: place.length, rect };
      return { place, extract, badge: null };
    }
    const taken = [];
    const project = (world) => { try { const q = vp.project(world); return Number.isFinite(q?.[0]) && Number.isFinite(q?.[1]) ? q : null; } catch { return null; } };
    /** Pixels per world metre AT this point — the only honest way to size `sizeUnits:'meters'` text. */
    const perMetre = (world, at) => { const b = project([world[0] + 1, world[1], world[2]]); return b ? Math.hypot(b[0] - at[0], b[1] - at[1]) : 0; };
    /**
     * Nudge a box into the rect, then walk it clear of everything seated. Returns the pixel
     * offset to apply, or null when the box belongs nowhere on this frame.
     */
    function seat(cx, cy, w, h, upFirst) {
      if (w > rect.right - rect.left || h > rect.bottom - rect.top) return null;
      const b = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
      const dx = b[2] > rect.right ? rect.right - b[2] : b[0] < rect.left ? rect.left - b[0] : 0;
      const dy = b[3] > rect.bottom ? rect.bottom - b[3] : b[1] < rect.top ? rect.top - b[1] : 0;
      if (Math.abs(dx) > LABEL_NUDGE || Math.abs(dy) > LABEL_NUDGE) return null;
      const step = h + 4;
      const ladder = upFirst ? [0, -step, step, -2 * step, 2 * step] : [0, step, -step, 2 * step, -2 * step];
      for (const k of ladder) {
        const c = [b[0] + dx, b[1] + dy + k, b[2] + dx, b[3] + dy + k];
        if (c[1] < rect.top || c[3] > rect.bottom || c[0] < rect.left || c[2] > rect.right) continue;
        if (taken.some((o) => boxHit(c, o))) continue;
        taken.push(c);
        return [dx, dy + k];
      }
      return null;
    }

    // 1. quest pins. They are not moved and they are not dropped — everything else moves around
    //    them. The badge hangs ABOVE its anchor (buildAtlas anchors at the bottom edge).
    const pinPx = currentTier() === 'full' ? 30 : 21;
    for (const q of questPts) {
      const p = project(Pg([q.pin.x, q.pin.z], 0.7));
      if (!p) continue;
      taken.push([p[0] - pinPx / 2, p[1] - pinPx, p[0] + pinPx / 2, p[1] + 6]);
    }
    // 2. extract badges. The badge is the map's content, not a caption, so it is never dropped for
    //    a neighbour — but a badge half under the omnibox, or sliced by the bottom edge, is a
    //    marker nobody can use (QA D4). It is lifted into the safe rect with its name, and only
    //    hidden when even that cannot clear the chrome. Reserved before any label is placed.
    const badge = new Map();
    const BADGE_PX = 26;   // markers-extract getSize, anchored at its bottom edge
    for (const d of extractAll) {
      const p = project(d.pos);
      if (!p) { badge.set(d.k, null); continue; }
      const b = [p[0] - BADGE_PX / 2, p[1] - BADGE_PX, p[0] + BADGE_PX / 2, p[1]];
      const dx = b[2] > rect.right ? rect.right - b[2] : b[0] < rect.left ? rect.left - b[0] : 0;
      const dy = b[3] > rect.bottom ? rect.bottom - b[3] : b[1] < rect.top ? rect.top - b[1] : 0;
      if (Math.abs(dx) > BADGE_PX || Math.abs(dy) > BADGE_PX) { badge.set(d.k, null); continue; }
      badge.set(d.k, [dx, dy]);
      d.shift = [dx, dy];
      taken.push([b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy]);
    }
    // 2b. live players, after the badges so a name plate never lands on an extract. The marker is
    //     the whole reason the Live panel is open: its box is reserved so a place name moves off
    //     it, and its NAME is seated like every other word on the map — it used to print through
    //     RUAF ROADBLOCK with both unreadable (QA H2). A player's name is never DROPPED, only
    //     moved: it goes right of the marker, else left of it, else back to the plain offset.
    const player = new Map();
    const playerConeM = coneMetresFor(z);
    for (const p of players) {
      const at = project(P([p.last.x, p.last.z], Math.max(p.last.y ?? 0, H(p.last.x, p.last.z)) + 0.3));
      if (!at) continue;
      // Reserve the ring AND the projected cone, and remember which way the cone points: a name
      // plate parked on the wedge hides the one thing the wedge is for, and a name walked four
      // rungs down the ladder to escape it is a caption nothing ties to the marker any more. So
      // the plate is offered the side AWAY from the heading first, and only then the near side.
      const mark = [at[0] - PLAYER_MARK_PX / 2, at[1] - PLAYER_MARK_PX / 2, at[0] + PLAYER_MARK_PX / 2, at[1] + PLAYER_MARK_PX / 2];
      let cx = 0, cy = 0, n = 0;
      for (const q of viewCone(p.last, playerConeM, 60)) {
        const c = project(Pg(q, 0.7));
        if (!c) continue;
        mark[0] = Math.min(mark[0], c[0]); mark[1] = Math.min(mark[1], c[1]);
        mark[2] = Math.max(mark[2], c[0]); mark[3] = Math.max(mark[3], c[1]);
        cx += c[0]; cy += c[1]; n++;
      }
      taken.push(mark);
      const w = inkWidth(p.name || '', PLAYER_NAME_PX, 700) + 12;   // + the plate's own padding
      const h = PLAYER_NAME_PX * 1.18 + 6;
      const reach = PLAYER_MARK_PX / 2 + PLAYER_NAME_GAP + w / 2;
      const away = n && cx / n < at[0] ? 1 : -1;   // the cone leans left -> the name goes right
      // seat() answers in box-centre space; the layer anchors the text's LEFT edge at the offset.
      const offFor = (centreX, s) => [centreX + s[0] - at[0] - w / 2, s[1]];
      let off = null;
      for (const side of [away, -away]) {
        const centreX = at[0] + side * reach;
        const s = seat(centreX, at[1], w, h, true);
        if (s) { off = offFor(centreX, s); break; }
      }
      player.set(p.code, off ?? [PLAYER_MARK_PX / 2 + PLAYER_NAME_GAP, 0]);
    }
    // 3. major place names, longest first so the landmark that needs the room asks for it first.
    //    upFirst: a quest pin under the name pushes the NAME up, which is the D6 fix.
    const seatPlace = (rows) => rows.filter((e) => {
      const p = project(e.pos);
      if (!p) return false;
      const px = Math.max(e.major ? MAJOR_MIN_PX : MINOR_MIN_PX,
        Math.min(e.major ? 15 : 12, (e.major ? 6.2 : 4.6) * perMetre(e.pos, p)));
      const off = seat(p[0], p[1], inkWidth(e.text, px, e.major ? 700 : 600) + 6, px * 1.18 + 4, true);
      if (!off) return false;
      e.off = off;
      return true;
    });
    const placedMajor = seatPlace(place.filter((e) => e.major).sort((a, b) => b.text.length - a.text.length));
    // 4. extract names, stacked BELOW their badge and below any place name they would print
    //    through. Ranked south-first, then by faction, so the same frame decides the same way.
    for (const d of extract) { const p = project(d.rankPos); d.px = p ? p[0] : 0; d.py = p ? p[1] : 0; }
    const rest = extract.filter((d) => !d.lit).sort((a, b) => (b.py - a.py)
      || (EXTRACT_PRIORITY[a.m.kind] ?? 9) - (EXTRACT_PRIORITY[b.m.kind] ?? 9) || a.text.length - b.text.length);
    const placedExtract = [...extract.filter((x) => x.lit), ...rest].filter((d) => {
      if (!d.shift) return false;   // its badge could not be placed; the caption goes with it
      const raw = project(d.pos);
      const p = raw && [raw[0] + d.shift[0], raw[1] + d.shift[1]];
      if (!p) return false;
      const px = Math.max(10, Math.min(15, d.size));
      const nameH = px * 1.18;
      // ONE AABB over the name AND its requirement line: reserving only the name let the sub
      // print through whatever sat below it.
      const w = Math.max(inkWidth(d.text, px, 700), d.sub ? inkWidth(d.sub, 10, 600) : 0) + 6;
      const h = nameH + (d.sub ? 16 : 0) + 4;
      const off = seat(p[0], p[1] + 8 + (h - nameH) / 2 - 2, w, h, false);
      if (!off) return false;
      // the name rides its badge's lift, then its own seat on top of it
      d.off = [d.shift[0] + off[0], d.shift[1] + 8 + off[1]];
      return true;
    });
    // 5. minor names last: they are the tier the map can afford to lose.
    const placedMinor = seatPlace(place.filter((e) => !e.major));
    const seated = placedMajor.length + placedMinor.length;
    layoutStats = { bail: null, seated, hidden: place.length - seated, rect };
    return { place: [...placedMajor, ...placedMinor], extract: placedExtract, badge, player };
  }

  // --- TRACK C: extract names in 3D -----------------------------------------------------
  // buildAtlas() anchors the badge at its BOTTOM edge (anchorY = cell), so the badge occupies
  // -26..0 px ABOVE the anchor point. Names therefore go BELOW it — a negative offset would
  // draw the text straight through the badge.
  let pinnedExtract = null, hoverExtract = null;
  const eKey = (m) => (m.name || '') + '|' + m.kind;
  const minorAlpha = () => Math.round(120 + 135 * Math.min(1, Math.max(0, ((viewState.zoom ?? 0) - 0.8) / 0.4)));
  const EXTRACT_PRIORITY = { 'extract-pmc': 0, 'extract-shared': 1, 'extract-scav': 2, 'extract-transit': 3 };
  const EXTRACT_CHARS = [...new Set(
    src.markers().filter((m) => m.kind.startsWith('extract') && m.name).flatMap((m) => [(m.name || '').toUpperCase(), shortName(m.name), subText(m)]).join('')
    + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:+-()’\'#·')];
  /** Draws the rows textLayout() already seated — the declutter itself lives up there now. */
  function extractNameLayers(cand) {
    if (!cand.length) return [];
    const trig = [pinnedExtract, hoverExtract, (viewState.zoom ?? 0) >= 0.6, cand];
    // Unboxed, like the place names (Gemini, 2026-08-29: the black plate with an orange keyline
    // "clashes completely with the sleek HUD aesthetic" next to SKELETON / CRACKHOUSE floating in
    // clean type). The plate was doing two jobs: legibility over a bright tile, and carrying the
    // faction colour on its border. Legibility moves to a heavier ink outline — the same trick the
    // place labels use — and the colour moves into the type itself, lifted 45% toward cream so a
    // PMC green still reads as green without being a 45%-luminance word on grass.
    const toneOf = (rgb) => rgb.map((c, i) => Math.round(c + (C.cream[i] - c) * 0.55));
    const nameColor = (d) => [...toneOf(markerLevel(d.m) === 'underground' ? [255, 176, 48] : EXTRACT_ACCENT[d.m.kind] ?? C.accentExtractNeutral), 255];
    const text = (id, data, get, size, color, offset, weight) => new TextLayer({
      id, data, getPosition: (d) => d.pos, getText: get, characterSet: EXTRACT_CHARS,
      getSize: (d) => size(d), sizeUnits: 'pixels', sizeMinPixels: weight === 700 ? 10 : 9, sizeMaxPixels: weight === 700 ? 15 : 12,
      getColor: color, getTextAnchor: 'middle', getPixelOffset: offset,
      fontFamily: LABEL_FONT(), fontWeight: weight, fontSettings: LABEL_SDF,
      // QA D16: the extract names are coloured type on grass with no plate behind them — at 12 px
      // the old halo left them low-contrast wherever the terrain was pale. Wider, opaquer ink.
      outlineWidth: weight === 700 ? 4.2 : 3.2, outlineColor: [...C.ink, 255],
      billboard: true, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      updateTriggers: { getText: trig, getSize: trig, getPixelOffset: trig, getColor: trig },
    });
    // `off` is the seat textLayout() found for this name — its own stack offset plus whatever it
    // took to keep it out of the chrome. The sub-line rides 14 px under the name it belongs to.
    return [
      text('extract-names', cand, (d) => d.text, (d) => d.size, nameColor, (d) => d.off, 700),
      text('extract-sub', cand.filter((d) => d.sub), (d) => d.sub, () => 10, [...C.creamDim, 255], (d) => [d.off[0], d.off[1] + 14], 600),
    ];
  }
  // --- quest layer -----------------------------------------------------------------------
  // Fed by src/quests.js: objective points (numbered) and their zone outlines, in game coords.
  // Everything draws with OVERLAY parameters so a pin inside a warehouse is still findable.
  function questLayers() {
    const q = src.quests?.() ?? null;
    if (!q || (!q.points?.length && !q.zones?.length)) return [];
    const zones = (q.zones ?? []).filter((d) => d.outline?.length >= 3);
    const pts = (q.points ?? []).filter((d) => inLimit(d.position.x, d.position.z));
    // Quest pins ride the shared LOD tier too (Gemini, 2026-08-29: at fit zoom the gold hexes were
    // bigger than the terrain features they point at, and their numbers were unreadable anyway).
    // Below `full` the hex loses 30% of its size and drops the number for the plain objective
    // glyph — the numbers are for reading a checklist against the map, which is a zoomed-in job.
    // lodMarkerLayers() has already folded this frame's m/px into the shared tier.
    const small = currentTier() !== 'full';
    // At `full` the hexagon is empty and the number is drawn into it; below it the pin keeps the
    // objective glyph and no number. Uncapped either way — see QUEST_BLANK.
    const iconKey = () => (small ? 'quest-objective' : QUEST_BLANK);
    const pinPx = small ? 21 : 30;
    return [
      new SolidPolygonLayer({ id: 'quest-zone-fill', shadowEnabled: false, data: zones, getPolygon: (d) => ringG(d.outline, 0.5), getFillColor: (d) => [...d.color, d.level === 'underground' ? 45 : 70], parameters: OVERLAY, updateTriggers: { getPolygon: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
      new PathLayer({ id: 'quest-zone-line', shadowEnabled: false, data: zones, getPath: (d) => ringG([...d.outline, d.outline[0]], 0.55), getColor: (d) => [...d.color, 235], getWidth: 2, widthUnits: 'pixels', getDashArray: [5, 4], dashJustified: false, extensions: [dashExt], parameters: OVERLAY, updateTriggers: { getPath: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
      // the per-quest colour lives on a ground ring, so the hexagon badge can stay one readable gold
      new ScatterplotLayer({ id: 'quest-ring', data: pts, getPosition: (d) => Pg([d.pin.x, d.pin.z], 0.62), getRadius: small ? 2.4 : 3.4, radiusUnits: 'meters', radiusMinPixels: small ? 7 : 10, radiusMaxPixels: small ? 18 : 26, stroked: true, filled: true, getFillColor: (d) => [...d.color, 40], getLineColor: (d) => [...d.color, d.done ? 110 : 235], lineWidthMinPixels: 2, parameters: OVERLAY, updateTriggers: { getPosition: heightEpoch, getRadius: small, getLineColor: pts.map((d) => d.done) }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
      new IconLayer({ id: 'quest-markers', data: pts, getPosition: (d) => Pg([d.pin.x, d.pin.z], 0.7), iconAtlas: iconAtlas.canvas, iconMapping: iconAtlas.mapping, getIcon: iconKey, getSize: pinPx, sizeUnits: 'pixels', sizeMinPixels: small ? 15 : 22, sizeMaxPixels: small ? 28 : 40, billboard: true, pickable: true, parameters: OVERLAY, updateTriggers: { getPosition: heightEpoch, getSize: small, getIcon: small }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
        onClick: (i) => { if (!i.object) return false; src.onQuestClick?.(i.object); return true; } }),
      // The number, at `full` only. The badge is anchored at its BOTTOM edge, and the hexagon's
      // optical centre sits ~46% of its height above that, which is where the digits go.
      ...(small ? [] : [new TextLayer({ id: 'quest-numbers', data: pts, getPosition: (d) => Pg([d.pin.x, d.pin.z], 0.7),
        getText: (d) => String(d.badge ?? ''), characterSet: QUEST_NUM_CHARS,
        getSize: (d) => (String(d.badge ?? '').length > 1 ? 13 : 15), sizeUnits: 'pixels', sizeMinPixels: 10, sizeMaxPixels: 17,
        getPixelOffset: [0, -Math.round(pinPx * 0.46)], getTextAnchor: 'middle',
        getColor: (d) => [242, 240, 231, d.done ? 150 : 255],
        fontFamily: LABEL_FONT(), fontWeight: 700, fontSettings: LABEL_SDF,
        billboard: true, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
        updateTriggers: { getPosition: heightEpoch, getColor: pts.map((d) => d.done) } })]),
    ];
  }

  /* --- marker LOD ------------------------------------------------------------------------
   * The 3D view reads the same rule as the 2D map (src/lod.js): the tier is decided by metres per
   * pixel, which in an OrbitView is 1 / 2^zoom — the same number the HUD scale bar draws.
   *
   * zoomOffsetFor() (src/camera.js) is now the map's CRS scale and nothing else, so a 3D camera and
   * the 2D view it mirrors onto report the SAME m/px and therefore the same tier — toggling views
   * no longer moves the marker tier under the player. The two *fits* can still differ by a little,
   * because a 2D cover fits the map's box and the 3D fit covers the rhombus the tilt makes of it.
   *
   * Extracts stay exempt and keep their own layer with its hover/pin behaviour; everything else
   * is a dot, a badge, or a counted cluster.
   */
  const zoomIntoCluster = (c) => {
    viewState = clampView({ ...viewState, target: [-c.x, -c.z, 0], zoom: Math.min(viewState.maxZoom ?? 5, (viewState.zoom ?? 0) + 1) });
    deck.setProps({ viewState });
    src.onViewChange?.(viewState);
    render();
  };
  const COUNT_CHARS = [...'0123456789+'];
  const QUEST_NUM_CHARS = [...'0123456789'];
  function lodMarkerLayers(markers) {
    const mpp = 1 / Math.pow(2, viewState.zoom ?? 0);
    const t = updateTier(mpp);
    const rest = markers.filter((d) => !d.kind.startsWith('extract'));
    let singles = rest, clusters = [];
    if (t !== 'full') {
      // Cluster inside a kind, never across kinds: merging a boss spawn into a scav count would
      // throw away the one thing the colour is carrying.
      const cell = cellFor(mpp);
      singles = rest.filter((d) => !d.kind.startsWith('spawn-'));
      const spawns = rest.filter((d) => d.kind.startsWith('spawn-'));
      for (const kind of [...new Set(spawns.map((d) => d.kind))].sort()) {
        for (const c of clusterPoints(spawns.filter((d) => d.kind === kind), cell)) {
          if (c.count === 1) singles.push(c.points[0]);
          else clusters.push({ ...c, kind, id: `${kind}:${c.key}` });
        }
      }
    }
    const dotColour = (d) => [...dotRgb(d.kind), 235];
    const out = [];
    if (t === 'dot') {
      // 6 px across, no glyph: the category survives as colour, the clutter does not.
      out.push(new ScatterplotLayer({ id: 'markers-dots', data: singles, getPosition: (d) => Pg([d.position.x, d.position.z], 0.65),
        getRadius: 3, radiusUnits: 'pixels', radiusMinPixels: 3, radiusMaxPixels: 3,
        stroked: true, lineWidthUnits: 'pixels', getLineWidth: 1, getLineColor: [...C.ink, 200], getFillColor: dotColour,
        pickable: true, parameters: OVERLAY, updateTriggers: { getPosition: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }));
    } else {
      out.push(new IconLayer({ id: 'markers-spawn', data: singles.filter((d) => d.kind.startsWith('spawn-')), getPosition: (d) => Pg([d.position.x, d.position.z], 0.7), iconAtlas: iconAtlas.canvas, iconMapping: iconAtlas.mapping, getIcon: markerIconKey, getSize: 26, sizeUnits: 'pixels', sizeMinPixels: 20, sizeMaxPixels: 36, billboard: true, pickable: true, parameters: OVERLAY, updateTriggers: { getPosition: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }));
      // everything else lies flat on the ground like chips on a table
      out.push(new IconLayer({ id: 'markers-chips', data: singles.filter((d) => !d.kind.startsWith('spawn-')), getPosition: (d) => Pg([d.position.x, d.position.z], 0.65), iconAtlas: chipAtlas.canvas, iconMapping: chipAtlas.mapping, getIcon: markerIconKey, getSize: 18, sizeUnits: 'pixels', sizeMinPixels: 10, sizeMaxPixels: 20, billboard: false, pickable: true, parameters: OVERLAY, updateTriggers: { getPosition: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }));
    }
    if (clusters.length) {
      const anchor = (d) => Pg([d.x, d.z], t === 'dot' ? 0.65 : 0.7);
      // One id per LAYER CLASS. deck matches layers across renders by id and transfers the old
      // layer's state onto the new one; hand it the same id for a ScatterplotLayer one frame and an
      // IconLayer the next and the IconLayer inherits a state with no iconManager in it — "Cannot
      // read properties of undefined (reading 'setProps')", then a getTexture throw on every draw
      // and every picking pass. It only stayed hidden because a `dot` -> `full` step deletes the
      // cluster layers entirely; `dot` -> `icon` (which is what a fly-to lands on now that the two
      // views agree about metres per pixel) swaps the class under one id.
      out.push(t === 'dot'
        ? new ScatterplotLayer({ id: 'cluster-marks-dot', data: clusters, getPosition: anchor, getRadius: 4.5, radiusUnits: 'pixels', radiusMinPixels: 4.5, radiusMaxPixels: 4.5,
          stroked: true, lineWidthUnits: 'pixels', getLineWidth: 1, getLineColor: [...C.ink, 220], getFillColor: dotColour,
          pickable: true, onClick: (i) => { if (!i.object) return false; zoomIntoCluster(i.object); return true; },
          parameters: OVERLAY, updateTriggers: { getPosition: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN })
        : new IconLayer({ id: 'cluster-marks-icon', data: clusters, getPosition: anchor, iconAtlas: iconAtlas.canvas, iconMapping: iconAtlas.mapping, getIcon: (d) => d.kind, getSize: 24, sizeUnits: 'pixels', sizeMinPixels: 18, sizeMaxPixels: 32, billboard: true,
          pickable: true, onClick: (i) => { if (!i.object) return false; zoomIntoCluster(i.object); return true; },
          parameters: OVERLAY, updateTriggers: { getPosition: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }));
      // The count bubble, from the `icon` tier in. A TextLayer with a background is the whole
      // bubble — no second atlas, and the character set is 11 glyphs, so it costs nothing. At `dot`
      // there is no bubble at all (lod.js `countsVisible`): the 4.5 px cluster mark against its
      // 3 px neighbours is the whole message, and the exact count is on the hover tooltip.
      if (countsVisible(t)) out.push(new TextLayer({ id: 'cluster-counts', data: clusters, getPosition: anchor, getText: (d) => clusterCount(d.count), characterSet: COUNT_CHARS,
        getSize: 10, sizeUnits: 'pixels', sizeMinPixels: 9, sizeMaxPixels: 12, getPixelOffset: [11, -12],
        getColor: [...C.cream, 255], fontFamily: LABEL_FONT(), fontWeight: 700, fontSettings: LABEL_SDF,
        background: true, getBackgroundColor: [10, 14, 12, 235], backgroundPadding: [3, 1, 3, 1],
        getBorderColor: [...C.creamDim, 140], getBorderWidth: 1,
        billboard: true, parameters: OVERLAY, updateTriggers: { getPosition: heightEpoch, getPixelOffset: t }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }));
    }
    return out;
  }

  const dynamicLayers = () => {
    const markers = src.markers().filter((m) => inLimit(m.position.x, m.position.z) && (floor !== 'U' || markerLevel(m) === 'underground'));
    const labels = src.labels().filter((d) => inLimit(d.position[0], d.position[1])
      && (floor === 'U' ? d.floor === 'U' || d.floor === 'both' : d.floor !== 'U'));
    const players = src.players().filter((p) => p.last);
    // One screen-space pass decides where every word goes — see textLayout(). The quest points it
    // lays out around are the same ones questLayers() draws, filtered the same way.
    const questPts = ((src.quests?.() ?? null)?.points ?? []).filter((d) => inLimit(d.position.x, d.position.z));
    const laid = textLayout(labels, markers, questPts, players);
    const coneM = coneMetresFor(viewState.zoom);
    const beaconM = beaconMetresFor(viewState.zoom);
    // A place name that was hidden takes its ping with it: a beam pointing at nothing is worse
    // clutter than the label was (QA L2 — twelve of them out-contrast the buildings they mark).
    return [
      // Extracts are exempt from the LOD tier: they are what the map is for. They are NOT exempt
      // from the chrome — a badge sliced by the bottom edge or buried under the omnibox is a
      // marker nobody can use, so textLayout() lifts it clear (`laid.badge`) or, when even that
      // will not fit, drops it until the camera gives it room (QA D4).
      new IconLayer({ id: 'markers-extract', data: markers.filter((d) => d.kind.startsWith('extract') && (!laid.badge || laid.badge.get(eKey(d)))), getPosition: (d) => Pg([d.position.x, d.position.z], 0.7), iconAtlas: iconAtlas.canvas, iconMapping: iconAtlas.mapping, getIcon: markerIconKey, getSize: (d) => (eKey(d) === hoverExtract || eKey(d) === pinnedExtract ? 30 : 26), sizeUnits: 'pixels', sizeMinPixels: 20, sizeMaxPixels: 36, billboard: true, pickable: true, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
        getPixelOffset: (d) => { const s = laid.badge?.get(eKey(d)) ?? [0, 0]; return eKey(d) === hoverExtract || eKey(d) === pinnedExtract ? [s[0], s[1] - 4] : s; },
        updateTriggers: { getPosition: heightEpoch, getSize: [hoverExtract, pinnedExtract], getPixelOffset: [hoverExtract, pinnedExtract, laid.badge] },
        onHover: (i) => { const k = i.object && i.object.kind.startsWith('extract') ? eKey(i.object) : null; if (k !== hoverExtract) { hoverExtract = k; render(); } },
        onClick: (i) => { if (!i.object || !i.object.kind.startsWith('extract')) return false; const k = eKey(i.object); pinnedExtract = pinnedExtract === k ? null : k; render(); return true; } }),
      ...lodMarkerLayers(markers),
      ...pingLayers(laid.place.map((e) => e.d)),
      // TRACK C typography: majors are UPPERCASE/700, minors Title Case/600 — case, not a second grey,
      // carries the hierarchy, because a grey-on-grey difference dies at 9 px.
      ...[true, false].map((isMajor) => new TextLayer({ id: isMajor ? 'labels-major' : 'labels-minor',
        data: laid.place.filter((e) => e.major === isMajor),
        getPosition: (d) => d.pos, getText: (d) => d.text, getSize: isMajor ? 6.2 : 4.6, sizeUnits: 'meters',
        sizeMinPixels: isMajor ? MAJOR_MIN_PX : MINOR_MIN_PX, sizeMaxPixels: isMajor ? 15 : 12,
        // The seat textLayout() found: 0,0 for a label with room, otherwise the slide that kept it
        // out of the chrome and off its neighbour.
        getPixelOffset: (d) => d.off,
        getColor: isMajor ? [...C.cream, 255] : [...C.creamDim, minorAlpha()], updateTriggers: { getColor: isMajor ? 0 : minorAlpha() },
        fontFamily: LABEL_FONT(), fontWeight: isMajor ? 700 : 600, fontSettings: LABEL_SDF,
        // QA D13, both halves. The minor tier used to bottom out at 8 px of sentence-case type over
        // hillshade, where neither a 2 px halo nor a second grey is enough separation to read the
        // word — the 2D half of the same defect raised `.place-label` to 12.5/11 px in 32ce1cc, and
        // leaving 3D at 8 made one defect behave two ways. QA M10 then found Woods, the physically
        // largest map, sitting ON that floor at ~7 px of cap height, so the floor is 12/11 now.
        outlineWidth: isMajor ? 3.2 : 3, outlineColor: isMajor ? [...C.ink, 252] : [...C.ink, 250],
        billboard: true, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN })),
      ...extractNameLayers(laid.extract),
      ...questLayers(),
      new PathLayer({ id: 'trails', data: players.filter((p) => p.trail), getPath: (p) => p.trail.getLatLngs().map((ll) => Pg([ll.lng, ll.lat], 0.6)), getColor: (p) => hex(p.color, 200), getWidth: 1.2, widthUnits: 'meters', widthMinPixels: 2, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
      // Live player: a field-of-view cone on the ground (the direction IS the cone), an outline
      // that survives whatever it is drawn over, a ring, and the vertical beacon. The cone and the
      // beacon are on a screen-space floor — see coneMetresFor() — because the marker the Live
      // panel exists for was the least visible thing on the map (QA H2).
      new SolidPolygonLayer({ id: 'player-cone', data: players, getPolygon: (p) => viewCone(p.last, coneM, 60).map((q) => Pg(q, 0.7)), getFillColor: (p) => hex(p.color, 96), pickable: false, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, updateTriggers: { getPolygon: [players.map((p) => p.last), coneM] } }),
      new SolidPolygonLayer({ id: 'player-cone-inner', data: players, getPolygon: (p) => viewCone(p.last, coneM * 0.42, 60).map((q) => Pg(q, 0.75)), getFillColor: (p) => hex(p.color, 165), pickable: false, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, updateTriggers: { getPolygon: [players.map((p) => p.last), coneM] } }),
      // The keyline is what makes a translucent wedge read as a heading over bright terrain.
      new PathLayer({ id: 'player-cone-edge', data: players, getPath: (p) => { const c = viewCone(p.last, coneM, 60); return [...c, c[0]].map((q) => Pg(q, 0.8)); }, getColor: (p) => hex(p.color, 235), getWidth: 2, widthUnits: 'pixels', widthMinPixels: 2, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, updateTriggers: { getPath: [players.map((p) => p.last), coneM] } }),
      new SolidPolygonLayer({ id: 'player-piece', data: players.flatMap((p) => { const g = Math.max(p.last.y ?? 0, H(p.last.x, p.last.z)); return [
          { p, poly: circle(p.last.x, p.last.z, 1.4, 20), z: g + 0.05, h: 0.5, k: 1 }, { p, poly: circle(p.last.x, p.last.z, 0.75, 16), z: g + 0.55, h: 1.7, k: 1.1 }, { p, poly: circle(p.last.x, p.last.z, 0.55, 14), z: g + 2.25, h: 0.7, k: 1.25 } ]; }),
        getPolygon: (d) => ringAt(d.poly, d.z), extruded: true, getElevation: (d) => d.h, getFillColor: (d) => hex(d.p.color, 255).map((v, i) => (i < 3 ? Math.min(255, v * d.k) : v)), pickable: true, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, material: surfaceMaterial(look, 'player'), updateTriggers: { getPolygon: players.map((p) => p.last) } }),
      new ScatterplotLayer({ id: 'player-ring', data: players, getPosition: (p) => P([p.last.x, p.last.z], Math.max(p.last.y ?? 0, H(p.last.x, p.last.z)) + 0.45), getRadius: 2.6, radiusUnits: 'meters', radiusMinPixels: 11, stroked: true, filled: false, getLineColor: (p) => hex(p.color, 235), lineWidthMinPixels: 2.5, pickable: true, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, updateTriggers: { getPosition: players.map((p) => p.last) } }),
      // The one solid mark that says "this exact point". The ring around it is 22 px across, so
      // the pair reads at the fit zoom without hiding the terrain the player is standing on.
      new ScatterplotLayer({ id: 'player-dot', data: players, getPosition: (p) => P([p.last.x, p.last.z], Math.max(p.last.y ?? 0, H(p.last.x, p.last.z)) + 0.5), getRadius: 1.1, radiusUnits: 'meters', radiusMinPixels: 4.5, stroked: true, filled: true, getFillColor: (p) => hex(p.color, 255), getLineColor: [10, 14, 12, 235], lineWidthMinPixels: 1.5, pickable: false, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, updateTriggers: { getPosition: players.map((p) => p.last) } }),
      new LineLayer({ id: 'player-beacon', data: players, getSourcePosition: (p) => P([p.last.x, p.last.z], Math.max(p.last.y ?? 0, H(p.last.x, p.last.z)) + 0.5), getTargetPosition: (p) => P([p.last.x, p.last.z], Math.max(p.last.y ?? 0, H(p.last.x, p.last.z)) + beaconM), getColor: (p) => hex(p.color, 195), getWidth: 3.5, widthUnits: 'pixels', parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, updateTriggers: { getSourcePosition: players.map((p) => p.last), getTargetPosition: [players.map((p) => p.last), beaconM] } }),
      new LineLayer({ id: 'drop', data: players, getSourcePosition: (p) => Pg([p.last.x, p.last.z], 0), getTargetPosition: (p) => P([p.last.x, p.last.z], Math.max(p.last.y ?? 0, H(p.last.x, p.last.z)) + 0.2), getColor: (p) => hex(p.color, 160), getWidth: 2, updateTriggers: { getSourcePosition: heightEpoch, getTargetPosition: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
      // The live name goes through textLayout()'s seating pass like everything else with words in
      // it — it used to print straight through RUAF ROADBLOCK — and it wears the player's own
      // colour as a keyline, so the plate and the marker read as one object (QA H2).
      ...([new TextLayer({ id: 'player-names', data: players, getPosition: (p) => P([p.last.x, p.last.z], Math.max(p.last.y ?? 0, H(p.last.x, p.last.z)) + 0.3), getText: (p) => p.name,
        getPixelOffset: (p) => laid.player?.get(p.code) ?? [PLAYER_NAME_GAP, 0], getTextAnchor: 'start', getSize: PLAYER_NAME_PX, sizeUnits: 'pixels',
        getColor: [...C.cream, 255], outlineWidth: 3, outlineColor: [14, 18, 15, 240],
        background: true, getBackgroundColor: [10, 14, 12, 226], backgroundPadding: [5, 2, 5, 2],
        getBorderColor: (p) => hex(p.color, 240), getBorderWidth: 1.2,
        fontFamily: LABEL_FONT(), fontSettings: LABEL_SDF, fontWeight: 700, billboard: true, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
        updateTriggers: { getPosition: relief, getPixelOffset: laid.player } })]),
    ];
  };
  const hex = (h, a = 255) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a];

  container.addEventListener('contextmenu', (e) => e.preventDefault()); // right-drag = rotate/tilt, no browser menu
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pinnedExtract) { pinnedExtract = null; render(); } }); // Esc unpins an extract name
  /**
   * The background.
   *
   * Realistic clears to the contract's far-fog value, so geometry that fades into fog fades into
   * the sky rather than into a hole, and the whole frame (background included) goes through the
   * one grade pass. Vector keeps the pre-Stage-1 void, because the vector skin's job is to
   * reproduce today's map. The container's CSS is set to match so the canvas never flashes a
   * different colour before the first paint.
   *
   * `clear: true` is load-bearing, not decoration: deck reads `clearColor` only inside
   * `if (clear)` (@deck.gl/core layers-pass.js), so without it the prop is inert and the buffer
   * stays at [0,0,0,0]. That was survivable while the canvas was transparent and the CSS below
   * showed through — but the Stage 1 grade pass ends `tzGrade_sampleColor` with alpha 1.0, so the
   * canvas became opaque and the transparent clear went through the LUT and came out at ~[13,17,15].
   * The realistic look was rendering its diorama against a black sky with a hard edge along the
   * void plane. One boolean is the whole difference.
   */
  const viewFor = (mode) => new OrbitView({ orbitAxis: 'Z', fovy: CAM.fovy, clear: true, clearColor: backgroundFor(mode) });
  let assetsReady = false, assetsError = null;
  /*
   * The R1 asset set (Ground106 albedo/normal/ORM + the 16^3 grade LUT) is REALISTIC-ONLY cargo:
   * a fetch, three decodes and a few MB of resident texture that vector has no shader for. A
   * vector-first session therefore never loads it, and the first flip into realistic (or the first
   * FX toggle that needs it) is what pays. `armDevice` holds the luma device the upload needs.
   */
  let armDevice = null, armStarted = false;
  const armAssetsOnce = () => { if (!armStarted && armDevice) { armStarted = true; armRenderAssets(armDevice); } };
  container.style.background = backgroundCss(look);
  const deck = new Deck({
    parent: container, views: viewFor(look), controller: { dragMode: 'pan', inertia: 300 }, // left-drag pans, right/shift-drag rotates
    initialViewState: viewState, effects: sceneEffects(), getCursor: ({ isHovering }) => (isHovering ? 'pointer' : 'grab'),
    // The Stage 1 assets need a luma device to upload against; this is the first moment one exists.
    onDeviceInitialized: (device) => { armDevice = device; if (fxOn('grade') || fxOn('detail')) armAssetsOnce(); },
    // QA D1's measurement, not its fix: the first frame in which a place NAME actually has glyphs
    // on screen, and the first in which a marker BADGE does. The gap between the two is the window
    // where the map showed names floating over nothing. Both stop being written after the first
    // hit, so this costs one array scan per frame until then and nothing afterwards.
    onAfterRender: () => {
      // The screen-space text pass needs a viewport, and the FIRST layer build happens before deck
      // has one. Remember the one this redraw used and re-run the pass the moment it appears (or
      // changes size), or the landing frame keeps the unseated layer set forever — QA H1.
      try {
        const v = deck.getViewports()[0];
        if (v?.width && v?.height && (!lastViewport || lastViewport.width !== v.width || lastViewport.height !== v.height)) {
          const first = !lastViewport;
          lastViewport = v;
          if (first && initialised) scheduleRender();
        }
      } catch {}
      if (markersReadyMs == null && src.markers().length) markersReadyMs = Math.round(performance.now() - bootMs);
      if (firstLabelMs != null && firstBadgeMs != null) return;
      const layers = deck.props.layers || [];
      // TextLayer is a CompositeLayer: its models live on the sublayer, so `getModels()` on the
      // parent is always empty and a naive check never fires.
      const hasModels = (l) => !!(l?.getModels?.().length) || !!(l?.getSubLayers?.().some((s) => s?.getModels?.().length));
      const drawn = (id) => { const l = layers.find((x) => x && x.id === id); return !!(l && l.props.data?.length && hasModels(l)); };
      const t = Math.round(performance.now() - bootMs);
      if (firstLabelMs == null && drawn('labels-major')) firstLabelMs = t;
      if (firstBadgeMs == null && drawn('markers-extract')) {
        const l = layers.find((x) => x && x.id === 'markers-extract');
        // an IconLayer with no atlas texture yet draws nothing — that WAS the defect. Neither does
        // one whose per-marker icon KEY is missing from the mapping, which is the same defect wearing
        // the atlas' clothes: it reported "badges painted, lag 0 ms" on frames with no badge pixel on
        // them. The milestone is the first frame a badge could actually be drawn in.
        const painted = l.props.data.some((d) => iconAtlas.mapping[markerIconKey(d)]);
        if (painted && l.state?.iconManager?.isLoaded !== false) firstBadgeMs = t;
      }
    },
    // Every camera change goes through the tilt clamp — right-drag can lower the eye to the ground
    // plane and no further, and closing in on a hill raises the floor instead of burying the camera.
    onViewStateChange: ({ viewState: raw }) => {
      const v = clampView(raw);
      const zoomed = Math.abs((v.zoom ?? 0) - (viewState.zoom ?? 0)) > 0.05;
      viewState = v;
      deck.setProps({ viewState: v });
      // A zoom changes the LOD tier, so it rebuilds immediately. A PAN used to rebuild nothing,
      // which was fine while every label was placed in world space — textLayout() places them in
      // SCREEN space, so a pan that slides a name under the omnibox has to be re-seated. One
      // rebuild per animation frame at most; the layer set is diffed by id, so the static scene
      // is untouched by it.
      if (zoomed) render(); else scheduleRender();
      src.onViewChange?.(v);
    },
    getTooltip: ({ object, layer }) => {
      if (!object) return null;
      if (layer.id === 'buildings') return { html: `<b>${esc(object.place ?? object.name ?? object.kind)}</b><br>${object.floors} floor${object.floors > 1 ? 's' : ''} · ${object.height} m`, className: 'deck-tooltip' };
      if (layer.id === 'roofs') return { html: `<b>${esc(object.b.place ?? object.b.name ?? object.b.kind)}</b><br>${object.b.floors} floor${object.b.floors > 1 ? 's' : ''} · ${object.b.height} m`, className: 'deck-tooltip' };
      if (layer.id === 'props') return { html: `<b>${esc(object.p.name ?? object.p.type)}</b>`, className: 'deck-tooltip' };
      if (layer.id === 'underground') return { html: `<b>${esc(object.name)}</b><br>underground`, className: 'deck-tooltip' };
      if (layer.id.startsWith('cluster-')) return { html: `<b>${object.count} ${esc((KINDS[object.kind]?.label ?? 'markers').toLowerCase())}</b>click to zoom in`, className: 'deck-tooltip' };
      if (layer.id.startsWith('markers-')) return object.html ? { html: object.html, className: 'deck-tooltip' } : null;
      if (layer.id === 'quest-markers') return { html: object.html, className: 'deck-tooltip' };
      if (layer.id === 'players' || layer.id === 'player-ring' || layer.id === 'player-piece') { if (layer.id === 'player-piece') object = object.p; const y = object.last.y ?? 0, g = H(object.last.x, object.last.z) / relief, rel = y - g; const fl = rel < -1.5 ? 'underground' : rel < 2.6 ? 'ground' : `floor ${Math.floor(rel / 3.3) + 1}`; const note = relief === 1 ? '' : `<br>Relief ${relief}× · ground height visually exaggerated`; return { html: `<b>${esc(object.name)}</b><br>${fl} · x ${object.last.x} z ${object.last.z} y ${y}${note}`, className: 'deck-tooltip' }; }
      return null;
    },
  });
  let base = staticLayers();
  let extras = extraLayers();
  initialised = true;
  let renderPending = 0;
  /** At most one layer rebuild per animation frame, however many moves land inside it. */
  function scheduleRender() {
    if (renderPending) return;
    renderPending = requestAnimationFrame(() => { renderPending = 0; render(); });
  }
  function render() {
    const visibleBase = base.filter((layer) => (nature.trees || layer.id !== 'understory') && (nature.rocks || !['rocks', 'hard-rocks', 'rock-talus', 'rock-masses'].includes(layer.id)));
    const vegetation = nature.trees ? treeLayers({ treeSet, H, zoom: viewState.zoom ?? 0, relief, look, fogExtension: fogExt }) : [];
    deck.setProps({ layers: [...visibleBase, ...vegetation, extras[0], ...buildingLayer(), ...extras.slice(1), ...dynamicLayers()] });
  }
  /** Rebuild every colour-carrying layer array. Geometry accessors are untouched. */
  function rebuildMaterialLayers() {
    details = detailParts(data.buildings, scenes);
    parts = buildingParts(data.buildings);
    propData = propParts(data.props || []);
    base = staticLayers();
    extras = extraLayers();
  }
  function setRelief(next) {
    next = [1, 2, 3].includes(Number(next)) ? Number(next) : 3;
    if (next === relief) return;
    relief = next;
    rebuildGround();
    placeBuildings();
    floorLines = makeFloorLines();
    lighting = sceneLighting();
    rebuildMaterialLayers();
    deck.setProps({ effects: sceneEffects() });
    render();
  }
  /**
   * Re-arm every look-dependent shader from `look` + `fx`. The ONLY writer of the four effect
   * handles — `fxOn()` decides, and vector can therefore never end up holding one.
   */
  function armEffects() {
    fogExt = fxOn('fog') ? fogExtensionFor(look, mapDiagonal, fogScene) : null;
    waterExt = waterExtensionFor(look);
    groundExt = fxOn('detail') ? groundDetailExtensionFor(look, groundTextures) : null;
    gradeEffect = fxOn('grade') ? gradeEffectFor(look, lutTexture) : null;
  }
  /**
   * Turn one realistic effect on or off live, so its cost can be read off `renderStats()` on the
   * real GPU. Vector ignores it: `fxOn()` short-circuits on the look.
   */
  function setFx(next) {
    const before = JSON.stringify(fx);
    fx = { ...fx, ...Object.fromEntries(FX_KEYS.filter((k) => k in (next || {})).map((k) => [k, Boolean(next[k])])) };
    if (JSON.stringify(fx) === before) return { ...fx };
    // The grade needs its LUT and the detail its textures; a first flip into either while vector was
    // showing has to fetch them, exactly as a look flip does.
    if ((fx.grade || fx.detail) && look === 'realistic' && !assetsReady && !assetsError) armAssetsOnce();
    armEffects();
    rebuildMaterialLayers();
    deck.setProps({ effects: sceneEffects() });
    render();
    return { ...fx };
  }
  /**
   * Flip the render style. `realistic` <-> `vector`, material state only.
   *
   * What changes: the colour table, the terrain's baked texture and material, the light, the fog
   * extension, the background clear colour, the post grade, and every layer array that captured a
   * colour at build time.
   *
   * What does NOT change: the terrain mesh and its skirt (built once by buildTerrain and shared by
   * both bakes), H(), every geometry accessor, feature ids, picking colours, the floor state, the
   * LOD tier, and the camera. `rebuildGround()` is deliberately NOT called.
   */
  function setLook(next) {
    const wanted = resolveLook(next);
    if (wanted === look) return look;
    look = applyLook(wanted);
    // Vector never pays for the R1 assets. Flipping INTO realistic is what fetches them.
    if (look === 'realistic' && !assetsReady && !assetsError) armAssetsOnce();
    armEffects();
    lighting = sceneLighting();
    terrain?.prebake(look);
    tintBuildings(data.buildings);
    rebuildMaterialLayers();
    container.style.background = backgroundCss(look);
    deck.setProps({ views: viewFor(look), effects: sceneEffects() });
    render();
    // The bake for a look is uploaded on first use; force the same late redraws a cold start gets.
    for (const t of [80, 400]) setTimeout(() => { try { deck.redraw('look-change'); } catch {} }, t);
    return look;
  }
  /**
   * Upload the Stage 1 assets once a device exists, then arm the ground detail and the grade.
   * Failure is non-fatal by design: a missing/blocked asset leaves the base bake and the untouched
   * frame, which is still a complete map — it must never take the renderer down.
   */
  async function armRenderAssets(device) {
    try {
      renderAssets = await loadRenderAssets();
      groundTextures = createGroundTextures(device, renderAssets.images);
      lutTexture = createLutTexture(device, renderAssets.images);
      armEffects();
      deck.setProps({ effects: sceneEffects() });
      base = staticLayers();
      render();
      assetsReady = true;
    } catch (e) {
      assetsError = String(e?.message ?? e);
      // console.ERROR, not warn: the frame stays up (that is the point of catching), but the look
      // the branch ships is not on screen, and a warn is invisible to every gate we have — the e2e
      // console check records `error`/`exception` only, so the whole Stage 1 asset set could go
      // missing and every check stayed green.
      console.error('render assets unavailable; ground detail and grade are off', e);
    }
  }
  render();
  // Under software GL (and on a cold cache) the baked ground texture can finish uploading after
  // deck's first paint without setting a redraw flag, which leaves the terrain mesh black. A few
  // forced redraws cost nothing and make the first frame deterministic.
  for (const t of [300, 1200, 3500]) setTimeout(() => { try { deck.redraw('late-upload'); } catch {} }, t);
  // Stage 1 instrumentation: one line, once, after the scene has settled — the plan's "the first
  // implementation stage must establish the real baseline". DEV only: `window.tz.renderStats()`
  // re-reads it on demand and scripts/render-baseline.mjs collects it through that hook, not
  // through this line, so in a production build the log had no consumer and every visitor got a
  // ~500-byte dump of texture byte counts and frame timings in their console.
  if (import.meta.env?.DEV) setTimeout(() => { try { console.log('[tz] renderStats', JSON.stringify(renderStats())); } catch {} }, 4000);
  const diagnostics = () => ({
    relief,
    terrain: terrain?.stats ?? null,
    sources: {
      buildings: data.buildings.length, props: propData.length, fences: (data.fences || []).length, hardRocks: (data.hardRocks || []).length,
      bridges: (data.bridges || []).length, rocks: (data.rocks || []).length,
      treesAll: treeSet.all.length, treesFar: treeSet.far.length,
      water: (data.water || []).length,
      markers: src.markers().filter((m) => inLimit(m.position.x, m.position.z)).length,
    },
    water: (data.water || []).map((w) => ({ level: w.level, depth: w.depth, bank: w.bank, gradient: w.gradient ?? null, rings: waterRings(w).length })),
    layers: Object.fromEntries((deck.props.layers || []).map((layer) => {
      const d = layer.props.data; return [layer.id, Array.isArray(d) || ArrayBuffer.isView(d) ? d.length : null];
    })),
  });
  /**
   * STAGE 1 metrics: what the frame actually costs, so the plan's estimates can be replaced with
   * measurements. Draw count is deck's own "Layers rendered" sample; GPU/CPU frame time comes from
   * luma's timer-query stats (0 on adapters without EXT_disjoint_timer_query — swiftshader is one,
   * so a headless number of 0 means "not measured", not "free"). Texture bytes are counted two
   * ways: luma's live resident total, and our own accounting of what Stage 1 added.
   */
  function renderStats() {
    try { deck._updateMetrics?.(); } catch {}
    const m = deck.metrics ?? {};
    const layers = deck.props.layers || [];
    const models = layers.reduce((n, layer) => n + (layer?.getModels?.().length ?? 0), 0);
    const [tw, th] = terrain?.stats?.tex ?? [0, 0];
    const atlasBytes = [iconAtlas, arrowAtlas, soldierAtlas]
      .reduce((n, a) => n + (a?.canvas ? a.canvas.width * a.canvas.height * 4 : 0), 0);
    const fog = fogParams(look, mapDiagonal);
    return {
      map: mapData.key,
      look,
      relief,
      layers: layers.length,
      drawLayers: m.drawLayersCount ?? null,
      models,
      /**
       * What this frame is actually paying for. `effects` counts what deck holds (the scene light
       * is always one of them); `postEffects` is the R1 additions alone, and must be 0 in vector.
       * `fx` is the live switch state — see the `?fx=` gate above.
       */
      effects: (deck.props.effects || []).length,
      postEffects: gradeEffect ? 1 : 0,
      fx: { ...fx, fogArmed: Boolean(fogExt), gradeArmed: Boolean(gradeEffect), detailArmed: Boolean(groundExt), waterMesh: Boolean(waterExt) },
      /**
       * The screen-space text pass. `bail` is null on a healthy frame; anything else means every
       * name was handed back UNSEATED and the frame is free to print names through each other.
       */
      labels: { ...layoutStats },
      fps: m.fps ?? null,
      gpuFrameMs: m.gpuTimePerFrame || null,   // null = the adapter has no timer query
      cpuFrameMs: m.cpuTimePerFrame || null,
      textureBytes: {
        terrainBakes: terrain?.textureBytes?.() ?? 0,
        terrainBakeEach: tw * th * 4,
        groundDetail: groundTextures?.bytes ?? 0,
        gradeLut: lutTexture?.bytes ?? 0,
        iconAtlases: atlasBytes,
        lumaResident: m.textureMemory || null,
      },
      assets: { ready: assetsReady, error: assetsError, sourceBytes: renderAssets?.sourceBytes ?? 0 },
      fog: { enabled: fog.enabled, diagonalMeters: Math.round(mapDiagonal), startMeters: Math.round(fog.startMeters), targetMeters: Math.round(fog.targetMeters), maxDensity: fog.maxDensity },
      post: { ...postFor(look), armed: Boolean(gradeEffect) },
      groundDetail: Boolean(groundExt),
      /**
       * Cold-load milestones, in ms since createView3d() started (QA D1). `firstBadgeMs` minus
       * `firstLabelMs` IS the defect: the window in which the map showed place names with no
       * marker under them. Null means "has not happened yet in this session".
       */
      timing: { atlasReadyMs, atlasWaitMs, prepMs, firstLabelMs, firstBadgeMs, markersReadyMs,
        badgeLagMs: firstBadgeMs != null && firstLabelMs != null ? firstBadgeMs - firstLabelMs : null,
        /**
         * The gateable half of D1. `badgeLagMs` measures the badge against the LABELS, and the
         * labels are drawn from data that is already in the bundle while the badges wait on a
         * network fetch this branch never touched — so it is a stopwatch on the marker fetch and it
         * failed 1 run in 4 on an unmodified tree. This one measures the badge against the arrival
         * of its own data, which is what the atlas work is actually responsible for.
         */
        badgeAfterDataMs: firstBadgeMs != null && markersReadyMs != null ? firstBadgeMs - markersReadyMs : null },
      /** Marker icon keys the atlas cannot draw. Anything but 0 is badges missing from the map. */
      markerIconMisses: missingIconKeys().size,
      /** Draped vertices this map's limit ring had to pull back inside it (QA M2). */
      clippedVerts,
    };
  }
  const api = {
    // Every caller of refresh() is a "the marker set may have changed" event, so this is where the
    // atlas is checked against it — see ensureMarkerIcons().
    refresh: () => { ensureMarkerIcons(); render(); },
    setFloor: (f) => { floor = f; render(); },
    setNature: (next) => { nature = { ...nature, ...next }; render(); },
    setRelief,
    setLook,
    getLook: () => look,
    setFx,
    getFx: () => ({ ...fx }),
    renderStats,
    diagnostics,
    // sidebar hover/click can pin an extract's name in 3D (name+kind key, or null to clear)
    focusExtract: (name, kind) => { pinnedExtract = name ? (name + '|' + (kind ?? 'extract-pmc')) : null; render(); },
    /**
     * Move the camera from outside — main.js's set3d(), which is every fly, fit, zoom key, HUD
     * button, compass reset and live-follow in the app.
     *
     * Two rules, and they are the reason this is the ONLY way in (main.js must never push a
     * viewState at `deck` itself):
     *  1. a programmatic move goes through exactly the clamp a right-drag goes through, so
     *     camera.js's guarantee — the eye never goes under the map — is about the camera and not
     *     about which code moved it;
     *  2. what was actually applied is handed back, so the caller's mirror of the view state cannot
     *     drift from deck's own. The view's zoom limits are applied here too, for the same reason.
     */
    setView: (patch = {}) => {
      const next = { ...viewState };
      for (const k of ['target', 'zoom', 'rotationX', 'rotationOrbit']) if (patch[k] !== undefined) next[k] = patch[k];
      const z = Number(next.zoom);
      next.zoom = Math.min(next.maxZoom ?? 5, Math.max(next.minZoom ?? -2, Number.isFinite(z) ? z : 0));
      viewState = clampView(next);
      deck.setProps({ viewState });
      return { ...viewState };
    },
    // game coords -> screen pixels, so main.js can pin an HTML card to a 3D point
    project: (x, z, dy = 0.7) => { try { const vp = deck.getViewports?.()[0]; return vp ? vp.project(Pg([x, z], dy)) : null; } catch { return null; } },
    deck,
  };
  // Non-enumerable test hook: CDP verification can compare the same layer inventory at 1x/3x
  // without shipping a visible debug UI or a global variable.
  Object.defineProperty(container, '__tz3d', { value: api, configurable: true });
  return api;
}
