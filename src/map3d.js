// 3D view: deck.gl OrbitView (orthographic, tilted) over the same game-coordinate data as the 2D map.
// deck cartesian = [-gameX, -gameZ, gameY] so on-screen orientation matches the 2D map at 0° orbit.
import { Deck, OrbitView, LightingEffect, AmbientLight, DirectionalLight, COORDINATE_SYSTEM } from '@deck.gl/core';
import { SolidPolygonLayer, PathLayer, IconLayer, TextLayer, LineLayer, ScatterplotLayer } from '@deck.gl/layers';
import { PathStyleExtension } from '@deck.gl/extensions';
import { KINDS, iconDataUrl, arrowDataUrl, soldierDataUrl, extractLetter } from './icons.js';
import { esc, COLORS } from './live.js';
import { buildTerrain } from './terrain.js'; // TRACK B: smooth terrain mesh + baked ground texture
import { prepareTrees, treeLayers } from './trees.js';
import { makeWaterHeightCapper, waterLevelAt, waterRings, waterSurfaceAt } from './water.js';

const C = {
  // Brighter field palette: sage/olive ground, warm mineral structures, restrained accents.
  grass1: [57, 82, 58], grass2: [68, 96, 62], grass3: [81, 108, 67], grass4: [101, 121, 73], grass5: [123, 137, 84],
  grass: [68, 96, 62], grassHigh: [123, 137, 84], land: [68, 96, 62], grassDry: [132, 126, 99], grassShadow: [31, 49, 35],
  water: [38, 86, 105], waterDeep: [25, 59, 76], shore: [99, 151, 161, 185],
  pavement: [112, 115, 108], pavementWorn: [123, 125, 116], road: [137, 142, 133], roadEdge: [86, 91, 83],
  highway: [150, 153, 141], highwayEdge: [96, 101, 91], roadMarking: [230, 226, 207, 190],
  track: [126, 105, 73], dirt: [139, 121, 88], dirtEdge: [103, 88, 64],
  rail: [132, 130, 121], sleeper: [99, 91, 75], fence: [119, 114, 99], fenceTop: [78, 73, 62],
  building: [181, 174, 159], buildingMulti: [165, 157, 143], buildingPlinth: [132, 126, 114], buildingHover: [255, 215, 112],
  glass: [37, 49, 52, 225], roofWarehouse: [119, 128, 130], roofHouse: [145, 92, 72], roofFlat: [126, 120, 108], roofRib: [0, 0, 0, 42],
  skylight: [190, 201, 196, 235], parapet: [145, 138, 125], dockDoor: [60, 52, 47],
  tank: [181, 186, 184], tankBand: [0, 0, 0, 55], tower: [150, 152, 145],
  understory: [48, 72, 49, 52], tree: [72, 99, 65], treeShadow: [23, 37, 28, 110], rock: [149, 144, 128],
  bridge: [137, 132, 119], bridgeRail: [88, 83, 73], pier: [112, 107, 96],
  contour: [26, 42, 26, 90], contourMajor: [20, 32, 20, 150],
  void: [10, 13, 12], oob: [10, 13, 12], voidRing: [24, 28, 26],
  shade: [8, 14, 10, 62], shadeSoft: [8, 14, 10, 26], floorLine: [0, 0, 0, 70],
  underground: [46, 44, 40, 120], undergroundOn: [255, 176, 48, 190],
  cream: [230, 227, 215], creamDim: [198, 196, 182], ink: [14, 18, 15], amber: [255, 208, 92],
  accentExtract: [45, 190, 108], accentExtractScav: [224, 135, 43], accentExtractTransit: [58, 150, 186], accentExtractNeutral: [128, 134, 130],
  accentPlayer: [56, 214, 200], accentDanger: [210, 69, 63], accentSpawn: [92, 122, 158], accentBoss: [190, 46, 48],
  sandbag: [151, 137, 105], rust: [149, 89, 61], bigRed: [163, 70, 59], bigRedTrim: [224, 216, 199],
  concreteRaw: [187, 181, 169], rebar: [159, 140, 108], hazardStripe: [226, 190, 67],
};
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
const makeSurfaceSampler = (base, hardRocks = [], relief = 1) => (x, z) => Math.max(base(x, z),
  ...hardRocks.filter((rock) => inPolyXZ([x, z], rock.poly))
    .map((rock) => Number.isFinite(rock.surfaceY) ? rock.surfaceY * relief : base(x, z) + rock.height * relief));
let VOID_Z = -14;
function voidRect(limit) { const xs = limit.map((p) => p[0]), zs = limit.map((p) => p[1]); const m = 60; return [[Math.min(...xs) - m, Math.min(...zs) - m], [Math.max(...xs) + m, Math.min(...zs) - m], [Math.max(...xs) + m, Math.max(...zs) + m], [Math.min(...xs) - m, Math.max(...zs) + m]]; }
const OVERLAY = { depthCompare: 'always', depthWriteEnabled: false };
// One SDF recipe for every TextLayer so glyph weight is identical across major/minor/extract text.
const LABEL_SDF = { sdf: true, fontSize: 64, buffer: 8, radius: 12 };
// The requirement line under an extract name. Hand-written because the raw notes are sentences
// ("Requires lever activation in warehouse #4 and Factory emergency exit key") and a HUD chip is not a paragraph.
const EXTRACT_SUB = {
  'Old Gas Station': 'REQ: GREEN FLARE', 'Railroad Passage (Flare)': 'REQ: GREEN FLARE',
  "Smugglers' Boat": 'REQ: VORON NOTE', "Smugglers' Bunker (ZB-1012)": 'REQ: VORON NOTE',
  'Dorms V-Ex': 'REQ: 20K ROUBLES', 'ZB-013': 'REQ: LEVER + KEY',
  'RUAF Roadblock': 'PVE ONLY', 'Boiler Room Basement (Co-op)': 'CO-OP · PMC + SCAV',
};
const SUB_BY_KIND = { 'extract-pmc': 'PMC ONLY', 'extract-scav': 'SCAV ONLY', 'extract-shared': 'PMC + SCAV', 'extract-transit': 'TRANSIT · 1 MIN' };
const subText = (m) => EXTRACT_SUB[(m.name || '').trim()] ?? SUB_BY_KIND[m.kind] ?? '';
// short form = full name minus any parenthetical: "Smugglers' Bunker (ZB-1012)" -> "SMUGGLERS' BUNKER"
const shortName = (n) => (n || '').replace(/\s*\([^)]*\)\s*/g, ' ').trim().toUpperCase();
const EXTRACT_ACCENT = { 'extract-pmc': C.accentExtract, 'extract-scav': C.accentExtractScav, 'extract-transit': C.accentExtractTransit, 'extract-shared': C.accentExtractNeutral };
const markerLevel = (m) => ['surface', 'underground', 'rooftop', 'upper'].includes(m?.level) ? m.level : 'surface';
const levelSuffix = (m) => markerLevel(m) === 'surface' ? '' : ` · ${markerLevel(m).toUpperCase()}`;
const markerIconKey = (m) => {
  const letter = m.kind.startsWith('extract') ? extractLetter(m.name) : null;
  return `${m.kind}${letter ? `:${letter}` : ''}${markerLevel(m) === 'surface' ? '' : `:${markerLevel(m)}`}`;
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
const BOX_WALL_TINTS = [[193, 185, 171], [182, 176, 164], [172, 166, 155], [162, 158, 149]];
const BOX_ROOF_TINTS = [[145, 142, 133], [136, 130, 119], [153, 145, 132]];
// Flat-roof colours for the landmarks the build script only colours the walls of. Seen from a
// tilted top-down camera the roof IS the building, so a landmark whose roof is generic grey is
// unrecognisable from overview zoom.
const ROOF_BY_PLACE = { 'Dorms 2-Story': [148, 94, 75], 'Dorms 3-Story': [148, 94, 75], 'Big Red': [142, 76, 63],
  'Fortress': [134, 127, 116], 'Oil Rig': [134, 126, 114], 'Military Checkpoint': [139, 132, 120], 'Old Gas': [141, 134, 121] };
// generic unnamed boxes must not all be the same grey; the tint is a deterministic hash of the
// centroid so it never flickers between frames.
function tintBuildings(bs) {
  for (const b of bs) {
    if (b.color || b.place || b.kind === 'powerline_towers') continue;
    const c = b.poly.reduce((a, p) => [a[0] + p[0] / b.poly.length, a[1] + p[1] / b.poly.length], [0, 0]);
    const r = hash1(c[0], c[1]);
    b.tint = BOX_WALL_TINTS[Math.floor(r * 4) % 4];
    b.roofTint = BOX_ROOF_TINTS[Math.floor(r * 97) % 3];
  }
}
function detailParts(bs, scenes = []) {
  const out = { boxes: [], flats: [], lines: [], dashes: [], dots: [] };
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
    const roof = b.roof ? liftTone(b.roof, 0.12) : ROOF_BY_PLACE[place] ?? b.roofTint ?? C.roofFlat;

    // --- 1. plinth: every building meets the ground instead of being pasted onto it
    if (st !== 'canopy') B(expand(b.poly, 0.25), b.plinthBase ?? base, b.plinthHeight ?? 0.75, mul(wall, 0.7), 0);

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
    const banded = st === 'box' && A >= 40 && !['Fortress', 'Big Red'].includes(place) && b.kind !== 'tank';
    if (banded) for (let k = 1; k <= b.floors; k++) {
      const z = k * 3.3 - 1.35; if (z > h - 0.4) break;
      D(closed(b.poly, base + z), C.glass, 1.15, place.startsWith('Dorms') ? [1.55, 1.35] : [1.6, 1.5], z);
    }

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
      if (b.floors >= 3) for (let k = 1; k <= 2; k++) {
        L(closed(expand(b.poly, 0.5), base + k * 3.3), mul(wall, 0.9), 0.9, k * 3.3);
        L(closed(expand(b.poly, 0.9), base + k * 3.3 + 0.9), C.bridgeRail, 0.12, k * 3.3);
      }
    }
    if (place === 'Fortress') {
      for (let k = 1; k <= 2; k++) D(closed(b.poly, base + k * 3.3 - 1.4), [26, 34, 36, 240], 0.55, [0.55, 2.6], k * 3.3);
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
      if (!isRectangular(b.poly)) { walls.push({ ...b, h: b.height }); slabs.push({ poly: b.poly, z: b.height + 0.02, color: b.roof ?? C.roofWarehouse, base: b.base }); continue; }
      walls.push({ ...b, h: b.height * 0.72 });
      const rc = b.roof ? liftTone(b.roof, 0.12) : (['Crackhouse', 'Streamer House'].includes(b.place) ? C.roofHouse : C.roofWarehouse), shade = (k) => rc.map((c) => Math.min(255, c * k));
      hipRoof(b).forEach((pts, i) => roofs.push({ pts, color: shade([1, 0.82, 0.9, 0.9][i]), b }));
    }
    if (st === 'frame') { for (let k = 1; k <= b.floors; k++) { const z = k * 3.3; slabs.push({ poly: b.poly, z, color: [C.concreteRaw[0], C.concreteRaw[1], C.concreteRaw[2], 235], base: b.base }); edges.push({ path: [...ringAt(b.poly, z), ringAt(b.poly, z)[0]], base: b.base }); } for (const c of columns(b.poly)) posts.push({ pos: c, h: b.floors * 3.3, w: 0.55, color: C.concreteRaw, base: b.base }); }
    if (st === 'canopy') { slabs.push({ poly: b.poly, z: b.height, color: b.color ?? C.roofFlat, base: b.base }); edges.push({ path: [...ringAt(b.poly, b.height - 0.4), ringAt(b.poly, b.height - 0.4)[0]], base: b.base }); for (const c of columns(b.poly, 9)) posts.push({ pos: c, h: b.height, w: 0.5, color: C.parapet, base: b.base }); }
  }
  return { walls, roofs, slabs, posts, edges, dots };
}
// rotated box footprint in game coords: centre (x,z), w across, l along heading rot (deg)
function rbox(x, z, w, l, rot) { const a = (rot * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a); return [[-l / 2, -w / 2], [l / 2, -w / 2], [l / 2, w / 2], [-l / 2, w / 2]].map(([u, v]) => [x + u * c - v * sn, z + u * sn + v * c]); }
const circle = (x, z, r, n = 18) => Array.from({ length: n }, (_, i) => [x + r * Math.cos((i / n) * 2 * Math.PI), z + r * Math.sin((i / n) * 2 * Math.PI)]);
// thin strip polygon around a polyline (for fences/walls)
function strip(path, w) { const L = [], R = []; for (let i = 0; i < path.length; i++) { const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)]; const dx = b[0] - a[0], dz = b[1] - a[1], n = Math.hypot(dx, dz) || 1; L.push([path[i][0] - (dz / n) * w, path[i][1] + (dx / n) * w]); R.push([path[i][0] + (dz / n) * w, path[i][1] - (dx / n) * w]); } return [...L, ...R.reverse()]; }
const PROP_COLORS = { container: [164, 88, 69], tank: [181, 186, 184], tanker: [188, 190, 190], railcar: [105, 97, 90], vehicle: [130, 139, 145], crane: [204, 166, 68], wall: [176, 170, 157], pipe: [153, 150, 141] };
// containers/vehicles get a deterministic rusted tint so the yards stop reading as one plastic red
const hash1 = (a, b) => { const n = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return n - Math.floor(n); };
const CONTAINER_TINTS = [[164, 88, 69], [121, 131, 125], [146, 138, 120], [134, 106, 83]];
const liftTone = (c, amount = 0.1, target = [232, 224, 207]) => c.map((v, i) => i < 3 ? Math.round(v + (target[i] - v) * amount) : v);
const centroid = (poly) => poly.reduce((a, p) => [a[0] + p[0] / poly.length, a[1] + p[1] / poly.length], [0, 0]);
function footprintGround(poly) {
  const points = [centroid(poly), ...poly, ...poly.map((p, i) => [(p[0] + poly[(i + 1) % poly.length][0]) / 2, (p[1] + poly[(i + 1) % poly.length][1]) / 2])];
  return Math.max(...points.map((p) => H(p[0], p[1])));
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
const box = ([x, y], w) => [[x - w / 2, y - w / 2], [x + w / 2, y - w / 2], [x + w / 2, y + w / 2], [x - w / 2, y + w / 2]];

export async function createView3d(container, mapData, src) {
  const data = await (await fetch(`/data/${mapData.key}-3d.json`)).json();
  // --- TRACK B (terrain.js) --------------------------------------------------------------
  // One surface, one sampler: the mesh below and every draped feature (roads, fences, props,
  // trees, shade rings, building bases, player drop-lines) must sample the SAME bicubic field,
  // or they float/sink by up to ~0.3 m and z-fight against the mesh.
  let relief = [1, 2, 3].includes(Number(src.relief)) ? Number(src.relief) : 3;
  let heightEpoch = 0;
  let terrain = null;
  const rebuildGround = () => {
    terrain = null;
    WATER = data.water || [];
    RELIEF = relief;
    if (!data.terrain) { BASE_H = () => 0; H = makeSurfaceSampler(BASE_H, data.hardRocks || [], relief); VOID_Z = -14; heightEpoch++; return; }
    data.terrain.limit = data.limit;
    try { terrain = buildTerrain(data, relief); BASE_H = terrain.H; VOID_Z = terrain.voidZ; }
    catch (e) {
      console.warn('terrain mesh failed, falling back to quads', e);
      const sample = makeSampler(data.terrain, relief), capWater = makeWaterHeightCapper(data.water || [], relief);
      BASE_H = (x, z) => capWater(sample(x, z), x, z);
      VOID_Z = Math.min(-14, Math.floor((Math.min(...data.terrain.heights) * relief - 10) / 2) * 2);
    }
    H = makeSurfaceSampler(BASE_H, data.hardRocks || [], relief);
    heightEpoch++;
  };
  rebuildGround();
  // --- end TRACK B ------------------------------------------------------------------------
  const inLimit = (x, z) => !data.limit || inPolyXZ([x, z], data.limit);
  const centroidOf = centroid;
  const placeBuildings = () => {
    for (const b of data.buildings) {
      const c = centroidOf(b.poly);
      const footprintSamples = [c, ...b.poly, ...b.poly.map((p, i) => [(p[0] + b.poly[(i + 1) % b.poly.length][0]) / 2, (p[1] + b.poly[(i + 1) % b.poly.length][1]) / 2])];
      const ground = footprintSamples.map((p) => H(p[0], p[1]));
      // A rigid footprint sits on the highest sampled point. The plinth fills the downhill gap;
      // neither the wall nor its details can be swallowed by a 3x slope.
      b.base = Math.max(...ground) + 0.06;
      b.plinthBase = Math.min(...ground) - 0.18;
      b.plinthHeight = Math.max(0.75, b.base - b.plinthBase + 0.12);
    }
  };
  placeBuildings();
  const treeSet = prepareTrees(data.trees, mapData.key);
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
  const markerEntries = src.markers().filter((m) => KINDS[m.kind]).map((m) => [markerIconKey(m), iconDataUrl(m.kind, 64, m.kind.startsWith('extract') ? extractLetter(m.name) : null, markerLevel(m))]);
  // Quest pins carry their sequence number inside the hexagon (1..12 covers every quest in the
  // data; anything beyond falls back to the plain flag).
  const QUEST_BADGES = Array.from({ length: 12 }, (_, i) => String(i + 1));
  const questEntries = QUEST_BADGES.map((b) => [`quest-objective:${b}`, iconDataUrl('quest-objective', 64, b)]);
  const atlasEntries = [...Object.keys(KINDS).map((k) => [k, iconDataUrl(k, 64)]), ...markerEntries, ...questEntries]
    .filter((e, i, all) => all.findIndex((x) => x[0] === e[0]) === i);
  const iconAtlas = await buildAtlas(atlasEntries, 64);
  const arrowAtlas = await buildAtlas(COLORS.map((c) => [c, arrowDataUrl(c, 64)]), 64);
  const soldierAtlas = await buildAtlas(COLORS.map((c) => [c, soldierDataUrl(c, 64)]), 64);
  for (const m of Object.values(arrowAtlas.mapping)) m.anchorY = 32;
  const chipAtlas = { canvas: iconAtlas.canvas, mapping: Object.fromEntries(Object.entries(iconAtlas.mapping).map(([k, m]) => [k, { ...m, anchorY: 32 }])) };
  let viewState = { target: [0, 0, 0], zoom: 0, rotationX: 62, rotationOrbit: 0, minZoom: -2, maxZoom: 5 };
  let hover = null;
  let fontsReady = false, initialised = false;
  // atlas is keyed on fontFamily: use the fallback stack until the webfont is confirmed, then switch (forces a fresh atlas)
  const LABEL_FONT = () => (fontsReady ? 'Barlow Condensed, Arial Narrow, system-ui, sans-serif' : 'Arial Narrow, system-ui, sans-serif');
  const fontLoaded = () => { try { return document.fonts?.check?.('700 16px "Barlow Condensed"') ?? true; } catch { return true; } };
  const waitFonts = (async () => { try { await Promise.race([document.fonts?.load?.('700 16px "Barlow Condensed"') ?? Promise.resolve(), new Promise((r) => setTimeout(r, 4000))]); } catch {} })();
  waitFonts.then(() => { fontsReady = fontLoaded(); if (initialised) render(); });
  let floor = 'all'; // 'all' | 0 | 1 | 2 | 3 | 'U'
  let nature = { trees: true, rocks: true };
  const capH = (b, h) => (floor === 'all' || floor === 'U' ? h : Math.min(h, (Number(floor) + 1) * 3.3 - 0.4 + (b.style === 'canopy' ? 10 : 0)));

  // TRACK B: lighting comes from terrain.js so the sun azimuth matches the baked hillshade exactly
  // (two shading systems lit from different sides fight each other and flatten the relief).
  const sceneLighting = () => terrain ? terrain.lighting : new LightingEffect({
    ambient: new AmbientLight({ color: [255, 255, 255], intensity: 0.85 }),
    sun: new DirectionalLight({ color: [255, 250, 240], intensity: 0.9, direction: [-0.6, -0.4, -1] }),
  });
  let lighting = sceneLighting();
  const shoreData = (data.water || []).flatMap((water) => waterRings(water).map((path) => ({ water, path })));

  const staticLayers = () => [
    // TRACK B: contours are baked into the ground texture (smooth at any zoom, no z-fighting, zero layers)
    ...(data.limit ? [
      new SolidPolygonLayer({ id: 'void', shadowEnabled: false, data: [voidRect(data.limit)], getPolygon: (d) => d.map(([x, z]) => P([x, z], VOID_Z)), getFillColor: C.oob, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    ] : []),
    ...(terrain ? terrain.layers() : [new SolidPolygonLayer({ id: 'land', shadowEnabled: false, data: data.land, getPolygon: (d) => ringG(d, 0), getFillColor: C.land, updateTriggers: { getPolygon: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN })]),
    // At-grade pavement, roads, dirt/tracks, and rail are in terrain.js's single baked texture.
    new SolidPolygonLayer({ id: 'water', shadowEnabled: false, data: data.water || [], getPolygon: (d) => waterPolygon(d), getFillColor: C.water, updateTriggers: { getPolygon: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new SolidPolygonLayer({ id: 'minefields', shadowEnabled: false, data: data.minefields || [], getPolygon: (d) => ringG(d, 0.14), getFillColor: [142, 88, 52, 62], updateTriggers: { getPolygon: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new SolidPolygonLayer({ id: 'understory', shadowEnabled: false, data: data.understory || [], getPolygon: (d) => ringG(d, 0.09), getFillColor: C.understory, updateTriggers: { getPolygon: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new PathLayer({ id: 'shore', shadowEnabled: false, data: shoreData, getPath: (d) => [...d.path, d.path[0]].map((point) => waterPoint(d.water, point, 0.04)), getColor: C.shore, getWidth: 0.5, widthUnits: 'meters', widthMinPixels: 1, updateTriggers: { getPath: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new PathLayer({ id: 'cables', shadowEnabled: false, data: data.powerlines || [], getPath: (d) => catenary(d.path, 19), getColor: [96, 96, 92, 170], getWidth: 0.2, widthUnits: 'meters', widthMinPixels: 1, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new SolidPolygonLayer({ id: 'hard-rocks', shadowEnabled: false, data: data.hardRocks || [], getPolygon: (d) => d.poly.map(([x, z]) => P([x, z], BASE_H(x, z) + 0.04)), extruded: true, getElevation: (d) => Number.isFinite(d.surfaceY) ? Math.max(0.1, d.surfaceY * RELIEF - BASE_H(d.anchor[0], d.anchor[1])) : d.height * RELIEF, getFillColor: (d) => d.color ? liftTone(d.color, 0.08) : C.rock, updateTriggers: { getPolygon: heightEpoch, getElevation: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, material: { ambient: 0.72, diffuse: 0.5, shininess: 2 } }),
    new SolidPolygonLayer({ id: 'rocks', shadowEnabled: false, data: data.rocks || [], getPolygon: (d) => ringG(d.poly ?? d, 0.04), extruded: true, getElevation: (d) => d.height ?? 1.2, getFillColor: (d) => d.color ? liftTone(d.color, 0.1) : C.rock, updateTriggers: { getPolygon: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, material: { ambient: 0.75, diffuse: 0.45, shininess: 3 } }),
  ];
  const makeFloorLines = () => data.buildings.flatMap((b) => Array.from({ length: Math.max(0, b.floors - 1) }, (_, k) => ({ path: [...ringAt(expand(b.poly, 0.15), (k + 1) * 3.3 + (b.base ?? 0)), ringAt(expand(b.poly, 0.15), (k + 1) * 3.3 + (b.base ?? 0))[0]] })));
  let floorLines = makeFloorLines();
  let propData = propParts(data.props || []);
  const fenceStrips = (data.fences || []).map((f) => ({ poly: strip(f.path, 0.12) }));
  const extraLayers = () => [
    new SolidPolygonLayer({ id: 'props', data: propData, getPolygon: (d) => d.drape ? ringG(d.poly, d.dz) : ringAt(d.poly, footprintGround(d.poly) + d.dz), extruded: true, getElevation: (d) => d.h, getFillColor: (d) => d.color, updateTriggers: { getPolygon: heightEpoch }, pickable: true, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, material: { ambient: 0.75, diffuse: 0.5 } }),
    new PathLayer({ id: 'fence-tops', shadowEnabled: false, data: data.fences || [], getPath: (d) => ringG(d.path, 1.98), getColor: C.fenceTop, getWidth: 0.3, widthUnits: 'meters', widthMinPixels: 1, updateTriggers: { getPath: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new SolidPolygonLayer({ id: 'fences-3d', shadowEnabled: false, data: fenceStrips, getPolygon: (d) => ringG(d.poly, 0.04), extruded: true, getElevation: 1.9, getFillColor: C.fence, updateTriggers: { getPolygon: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    // two rings instead of one: reads as a blurred contact shadow at every zoom
    new SolidPolygonLayer({ id: 'shade-soft', shadowEnabled: false, data: data.buildings, getPolygon: (d) => ringG(expand(d.poly, 3.2), 0.10), getFillColor: C.shadeSoft, updateTriggers: { getPolygon: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new SolidPolygonLayer({ id: 'shade', shadowEnabled: false, data: data.buildings, getPolygon: (d) => ringG(expand(d.poly, 1.1), 0.11), getFillColor: C.shade, updateTriggers: { getPolygon: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new SolidPolygonLayer({ id: 'piers', data: (data.bridges || []).flatMap(piers), getPolygon: (d) => box(d.pos, d.w).map(([x, y]) => [x, y, d.bottom]), extruded: true, getElevation: (d) => d.h, getFillColor: C.pier, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, material: { ambient: 0.75, diffuse: 0.45 } }),
    new PathLayer({ id: 'bridge-edges', shadowEnabled: false, data: (data.bridges || []).filter((b) => !b.ford), getPath: (d) => bridgePath(d).map((q) => [q[0], q[1], q[2] - 0.15]), getColor: [128, 124, 114], getWidth: (d) => d.width + 1.2, widthUnits: 'meters', widthMinPixels: 2, capRounded: false, jointRounded: true, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new PathLayer({ id: 'bridges', shadowEnabled: false, data: data.bridges || [], getPath: bridgePath, getColor: (d) => (d.foot ? [128, 108, 82] : d.ford ? [150, 143, 126] : C.bridge), getWidth: (d) => d.width, widthUnits: 'meters', widthMinPixels: 2, capRounded: false, jointRounded: true, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new PathLayer({ id: 'bridge-rails', shadowEnabled: false, data: (data.bridges || []).filter((b) => !b.ford).flatMap((b) => { const p = bridgePath(b).map((q) => [q[0], q[1], q[2] + 1.1]); return [offsetPath(p, b.width / 2 - 0.3), offsetPath(p, -(b.width / 2 - 0.3))]; }), getPath: (d) => d, getColor: C.bridgeRail, getWidth: 0.4, widthUnits: 'meters', widthMinPixels: 1, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new PathLayer({ id: 'floor-lines', shadowEnabled: false, data: floorLines, getPath: (d) => d.path, getColor: C.floorLine, getWidth: 0.35, widthUnits: 'meters', widthMinPixels: 1, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
  ];
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
    new SolidPolygonLayer({
      id: 'buildings', visible: floor !== 'U', data: parts.walls, getPolygon: (d) => ringAt(d.poly, d.base ?? footprintGround(d.poly)), extruded: true, getElevation: (d) => capH(d, d.h), updateTriggers: { getPolygon: heightEpoch, getElevation: floor, getFillColor: [hover, floor] },
      getFillColor: (d, { index }) => (hover === index ? C.buildingHover : d.color ? liftTone(d.color, 0.12) : d.tint ? d.tint : d.kind === 'tank' ? C.tank : d.kind === 'powerline_towers' ? C.tower : d.floors > 1 ? C.buildingMulti : C.building),
      pickable: true, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      material: { ambient: 0.7, diffuse: 0.55, shininess: 12, specularColor: [30, 30, 30] },
      onHover: (i) => { if (i.index !== hover) { hover = i.index; render(); } },
    }),
    new SolidPolygonLayer({ id: 'roofs', visible: floor === 'all', data: parts.roofs, getPolygon: (d) => d.pts.map(([x, z, y]) => P([x, z], y + (d.b.base ?? footprintGround(d.b.poly)))), getFillColor: (d) => d.color, updateTriggers: { getPolygon: heightEpoch }, pickable: true, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, material: { ambient: 0.82, diffuse: 0.38 } }),
    new SolidPolygonLayer({ id: 'slabs', visible: floor !== 'U', shadowEnabled: false, data: parts.slabs.filter((d) => floor === 'all' || d.z <= (Number(floor) + 1) * 3.3), getPolygon: (d) => ringAt(d.poly, d.z + (d.base ?? footprintGround(d.poly))), updateTriggers: { getPolygon: [floor, heightEpoch] }, getFillColor: (d) => d.color, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new SolidPolygonLayer({ id: 'posts', visible: floor !== 'U', data: parts.posts, getPolygon: (d) => box(P(d.pos), d.w).map(([x, y]) => [x, y, d.base ?? H(d.pos[0], d.pos[1])]), extruded: true, getElevation: (d) => d.h, getFillColor: (d) => d.color, updateTriggers: { getPolygon: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, material: { ambient: 0.75, diffuse: 0.45 } }),
    new SolidPolygonLayer({ id: 'detail-boxes', visible: floor !== 'U', data: details.boxes.filter(showLvl), getPolygon: (d) => ringAt(d.poly, d.base), extruded: true, getElevation: (d) => d.h, getFillColor: (d) => d.color, updateTriggers: { getPolygon: [floor, heightEpoch] }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, material: { ambient: 0.75, diffuse: 0.5 } }),
    new SolidPolygonLayer({ id: 'detail-flats', visible: floor !== 'U', shadowEnabled: false, data: details.flats.filter(showLvl), getPolygon: (d) => d.ring, getFillColor: (d) => d.color, updateTriggers: { getPolygon: [floor, heightEpoch] }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new PathLayer({ id: 'detail-lines', visible: floor !== 'U', shadowEnabled: false, data: details.lines.filter(showLvl), getPath: (d) => d.path, getColor: (d) => d.color, getWidth: (d) => d.w, widthUnits: 'meters', widthMinPixels: 1, updateTriggers: { getPath: [floor, heightEpoch] }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new PathLayer({ id: 'detail-dashes', visible: floor !== 'U', shadowEnabled: false, data: details.dashes.filter(showLvl), getPath: (d) => d.path, getColor: (d) => d.color, getWidth: (d) => d.w, widthUnits: 'meters', widthMinPixels: 1, getDashArray: (d) => d.dash, dashJustified: false, extensions: [new PathStyleExtension({ dash: true })], updateTriggers: { getPath: [floor, heightEpoch] }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new ScatterplotLayer({ id: 'detail-dots', visible: floor !== 'U', shadowEnabled: false, data: [...details.dots, ...parts.dots].filter(showLvl), getPosition: (d) => d.pos, getRadius: (d) => d.r, radiusUnits: 'meters', radiusMinPixels: 0.5, getFillColor: (d) => d.color, updateTriggers: { getPosition: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new PathLayer({ id: 'slab-edges', visible: floor !== 'U', shadowEnabled: false, data: parts.edges, getPath: (d) => d.path.map((q) => [q[0], q[1], q[2] + (d.base ?? 0)]), getColor: [143, 137, 125], getWidth: (d) => (d.wide ? 0.9 : 0.3), widthUnits: 'meters', widthMinPixels: 1, updateTriggers: { getPath: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
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
  function extractNameLayers(markers) {
    const z = viewState.zoom ?? 0;
    const full = z >= 0.6;
    let cand = markers.filter((m) => m.kind.startsWith('extract') && m.name).map((m) => {
      const k = eKey(m), lit = pinnedExtract === k || hoverExtract === k;
      return { m, k, lit, text: (full || lit ? (m.name || '').toUpperCase() : shortName(m.name)) + levelSuffix(m),
        sub: full || lit ? subText(m) : '', size: lit ? 13.5 : 12,
        pos: Pg([m.position.x, m.position.z], 0.7),
        // Collision ranking uses the real-height field so changing visual relief cannot thin names.
        rankPos: P([m.position.x, m.position.z], H(m.position.x, m.position.z) / relief + 0.7) };
    }).filter((d) => d.lit || z >= -0.6);
    if (!cand.length) return [];
    // Greedy screen-space AABB declutter. A fixed offset table cannot cope with the Dorms/rail
    // clusters; rejected extracts keep their badge and pop back as the camera moves.
    try {
      const vp = deck.getViewports?.()[0];
      if (vp) {
        for (const d of cand) { const q = vp.project(d.rankPos); d.px = q[0]; d.py = q[1]; }
        const rest = cand.filter((d) => !d.lit).sort((a, b) => (b.py - a.py)
          || (EXTRACT_PRIORITY[a.m.kind] ?? 9) - (EXTRACT_PRIORITY[b.m.kind] ?? 9) || a.text.length - b.text.length);
        const boxes = [], out = [];
        for (const d of [...cand.filter((x) => x.lit), ...rest]) {
          const w = d.text.length * 5.6 * (d.size / 12), h = d.size * 1.15;
          const b = [d.px - w / 2 - 4, d.py + 9 - h / 2 - 4, d.px + w / 2 + 4, d.py + 9 + h / 2 + 4 + (d.sub ? 15 : 0)];
          if (boxes.some((o) => b[0] < o[2] && o[0] < b[2] && b[1] < o[3] && o[1] < b[3])) continue;
          boxes.push(b); out.push(d);
        }
        cand = out;
      }
    } catch {}
    const trig = [pinnedExtract, hoverExtract, full];
    const text = (id, data, get, size, color, offset, chip) => new TextLayer({
      id, data, getPosition: (d) => d.pos, getText: get, characterSet: EXTRACT_CHARS,
      getSize: (d) => size(d), sizeUnits: 'pixels', sizeMinPixels: chip ? 10 : 9, sizeMaxPixels: chip ? 15 : 12,
      getColor: color, getTextAnchor: 'middle', getPixelOffset: offset,
      fontFamily: LABEL_FONT(), fontWeight: 700, fontSettings: LABEL_SDF,
      outlineWidth: chip ? 3 : 2.5, outlineColor: [...C.ink, 240],
      background: chip, getBackgroundColor: [10, 14, 12, 190], backgroundPadding: [5, 2, 5, 2],
      getBorderColor: (d) => markerLevel(d.m) === 'underground' ? [255, 176, 48] : EXTRACT_ACCENT[d.m.kind] ?? C.accentExtractNeutral, getBorderWidth: chip ? 1 : 0,
      billboard: true, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      updateTriggers: { getText: trig, getSize: trig, getPixelOffset: trig },
    });
    return [
      text('extract-names', cand, (d) => d.text, (d) => d.size, [...C.cream, 255], [0, 9], true),
      text('extract-sub', cand.filter((d) => d.sub), (d) => d.sub, () => 10, [...C.creamDim, 255], [0, 24], false),
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
    const iconKey = (d) => (iconAtlas.mapping[`quest-objective:${d.badge}`] ? `quest-objective:${d.badge}` : 'quest-objective');
    return [
      new SolidPolygonLayer({ id: 'quest-zone-fill', shadowEnabled: false, data: zones, getPolygon: (d) => ringG(d.outline, 0.5), getFillColor: (d) => [...d.color, d.level === 'underground' ? 45 : 70], parameters: OVERLAY, updateTriggers: { getPolygon: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
      new PathLayer({ id: 'quest-zone-line', shadowEnabled: false, data: zones, getPath: (d) => ringG([...d.outline, d.outline[0]], 0.55), getColor: (d) => [...d.color, 235], getWidth: 2, widthUnits: 'pixels', getDashArray: [5, 4], dashJustified: false, extensions: [new PathStyleExtension({ dash: true })], parameters: OVERLAY, updateTriggers: { getPath: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
      // the per-quest colour lives on a ground ring, so the hexagon badge can stay one readable gold
      new ScatterplotLayer({ id: 'quest-ring', data: pts, getPosition: (d) => Pg([d.pin.x, d.pin.z], 0.62), getRadius: 3.4, radiusUnits: 'meters', radiusMinPixels: 10, radiusMaxPixels: 26, stroked: true, filled: true, getFillColor: (d) => [...d.color, 40], getLineColor: (d) => [...d.color, d.done ? 110 : 235], lineWidthMinPixels: 2, parameters: OVERLAY, updateTriggers: { getPosition: heightEpoch, getLineColor: pts.map((d) => d.done) }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
      new IconLayer({ id: 'quest-markers', data: pts, getPosition: (d) => Pg([d.pin.x, d.pin.z], 0.7), iconAtlas: iconAtlas.canvas, iconMapping: iconAtlas.mapping, getIcon: iconKey, getSize: 30, sizeUnits: 'pixels', sizeMinPixels: 22, sizeMaxPixels: 40, billboard: true, pickable: true, parameters: OVERLAY, updateTriggers: { getPosition: heightEpoch, getIcon: pts.map((d) => d.badge) }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
        onClick: (i) => { if (!i.object) return false; src.onQuestClick?.(i.object); return true; } }),
    ];
  }

  const dynamicLayers = () => {
    const markers = src.markers().filter((m) => inLimit(m.position.x, m.position.z) && (floor !== 'U' || markerLevel(m) === 'underground'));
    const labels = src.labels().filter((d) => inLimit(d.position[0], d.position[1])
      && (floor === 'U' ? d.floor === 'U' || d.floor === 'both' : d.floor !== 'U'));
    const players = src.players().filter((p) => p.last);
    return [
      new IconLayer({ id: 'markers-extract', data: markers.filter((d) => d.kind.startsWith('extract') || d.kind.startsWith('spawn-')), getPosition: (d) => Pg([d.position.x, d.position.z], 0.7), iconAtlas: iconAtlas.canvas, iconMapping: iconAtlas.mapping, getIcon: markerIconKey, getSize: (d) => (eKey(d) === hoverExtract || eKey(d) === pinnedExtract ? 30 : 26), sizeUnits: 'pixels', sizeMinPixels: 20, sizeMaxPixels: 36, billboard: true, pickable: true, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
        getPixelOffset: (d) => (eKey(d) === hoverExtract || eKey(d) === pinnedExtract ? [0, -4] : [0, 0]),
        updateTriggers: { getPosition: heightEpoch, getSize: [hoverExtract, pinnedExtract], getPixelOffset: [hoverExtract, pinnedExtract] },
        onHover: (i) => { const k = i.object && i.object.kind.startsWith('extract') ? eKey(i.object) : null; if (k !== hoverExtract) { hoverExtract = k; render(); } },
        onClick: (i) => { if (!i.object || !i.object.kind.startsWith('extract')) return false; const k = eKey(i.object); pinnedExtract = pinnedExtract === k ? null : k; render(); return true; } }),
      // everything else lies flat on the ground like chips on a table
      new IconLayer({ id: 'markers-chips', data: markers.filter((d) => !d.kind.startsWith('extract') && !d.kind.startsWith('spawn-')), getPosition: (d) => Pg([d.position.x, d.position.z], 0.65), iconAtlas: chipAtlas.canvas, iconMapping: chipAtlas.mapping, getIcon: markerIconKey, getSize: 18, sizeUnits: 'pixels', sizeMinPixels: 10, sizeMaxPixels: 20, billboard: false, pickable: true, parameters: OVERLAY, updateTriggers: { getPosition: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
      ...pingLayers(labels),
      // TRACK C typography: majors are UPPERCASE/700, minors Title Case/600 — case, not a second grey,
      // carries the hierarchy, because a grey-on-grey difference dies at 9 px.
      ...[true, false].map((isMajor) => new TextLayer({ id: isMajor ? 'labels-major' : 'labels-minor',
        data: labels.filter((d) => major(d) === isMajor && (isMajor || viewState.zoom >= 0.8)).map((d) => ({ p: Pg(d.position, lift(d) + 1.5), t: isMajor ? d.text.toUpperCase() : d.text })),
        getPosition: (d) => d.p, getText: (d) => d.t, getSize: isMajor ? 6.2 : 4.6, sizeUnits: 'meters', sizeMinPixels: isMajor ? 10 : 8, sizeMaxPixels: isMajor ? 15 : 11,
        getColor: isMajor ? [...C.cream, 255] : [...C.creamDim, minorAlpha()], updateTriggers: { getColor: isMajor ? 0 : minorAlpha() },
        fontFamily: LABEL_FONT(), fontWeight: isMajor ? 700 : 600, fontSettings: LABEL_SDF,
        outlineWidth: isMajor ? 2.5 : 2, outlineColor: isMajor ? [...C.ink, 242] : [...C.ink, 230],
        billboard: true, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN })),
      ...extractNameLayers(markers),
      ...questLayers(),
      new PathLayer({ id: 'trails', data: players.filter((p) => p.trail), getPath: (p) => p.trail.getLatLngs().map((ll) => Pg([ll.lng, ll.lat], 0.6)), getColor: (p) => hex(p.color, 200), getWidth: 1.2, widthUnits: 'meters', widthMinPixels: 2, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
      // live player: field-of-view cone on the ground (direction = the cone) + beacon
      new SolidPolygonLayer({ id: 'player-cone', data: players, getPolygon: (p) => viewCone(p.last, 32, 60).map((q) => Pg(q, 0.7)), getFillColor: (p) => hex(p.color, 70), pickable: false, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, updateTriggers: { getPolygon: players.map((p) => p.last) } }),
      new SolidPolygonLayer({ id: 'player-cone-inner', data: players, getPolygon: (p) => viewCone(p.last, 12, 60).map((q) => Pg(q, 0.75)), getFillColor: (p) => hex(p.color, 120), pickable: false, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, updateTriggers: { getPolygon: players.map((p) => p.last) } }),
      new SolidPolygonLayer({ id: 'player-piece', data: players.flatMap((p) => { const g = Math.max(p.last.y ?? 0, H(p.last.x, p.last.z)); return [
          { p, poly: circle(p.last.x, p.last.z, 1.4, 20), z: g + 0.05, h: 0.5, k: 1 }, { p, poly: circle(p.last.x, p.last.z, 0.75, 16), z: g + 0.55, h: 1.7, k: 1.1 }, { p, poly: circle(p.last.x, p.last.z, 0.55, 14), z: g + 2.25, h: 0.7, k: 1.25 } ]; }),
        getPolygon: (d) => ringAt(d.poly, d.z), extruded: true, getElevation: (d) => d.h, getFillColor: (d) => hex(d.p.color, 255).map((v, i) => (i < 3 ? Math.min(255, v * d.k) : v)), pickable: true, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, material: { ambient: 0.55, diffuse: 0.7, shininess: 20, specularColor: [80, 80, 80] }, updateTriggers: { getPolygon: players.map((p) => p.last) } }),
      new ScatterplotLayer({ id: 'player-ring', data: players, getPosition: (p) => P([p.last.x, p.last.z], Math.max(p.last.y ?? 0, H(p.last.x, p.last.z)) + 0.45), getRadius: 2.6, radiusUnits: 'meters', radiusMinPixels: 8, stroked: true, filled: false, getLineColor: (p) => hex(p.color, 220), lineWidthMinPixels: 2, pickable: true, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, updateTriggers: { getPosition: players.map((p) => p.last) } }),
      new LineLayer({ id: 'player-beacon', data: players, getSourcePosition: (p) => P([p.last.x, p.last.z], Math.max(p.last.y ?? 0, H(p.last.x, p.last.z)) + 0.5), getTargetPosition: (p) => P([p.last.x, p.last.z], Math.max(p.last.y ?? 0, H(p.last.x, p.last.z)) + 9), getColor: (p) => hex(p.color, 150), getWidth: 3, widthUnits: 'pixels', parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, updateTriggers: { getSourcePosition: players.map((p) => p.last), getTargetPosition: players.map((p) => p.last) } }),
      new LineLayer({ id: 'drop', data: players, getSourcePosition: (p) => Pg([p.last.x, p.last.z], 0), getTargetPosition: (p) => P([p.last.x, p.last.z], Math.max(p.last.y ?? 0, H(p.last.x, p.last.z)) + 0.2), getColor: (p) => hex(p.color, 160), getWidth: 2, updateTriggers: { getSourcePosition: heightEpoch, getTargetPosition: heightEpoch }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
      ...([new TextLayer({ id: 'player-names', data: players, getPosition: (p) => P([p.last.x, p.last.z], Math.max(p.last.y ?? 0, H(p.last.x, p.last.z)) + 0.3), getText: (p) => p.name, getPixelOffset: [22, 0], getTextAnchor: 'start', getSize: 14, getColor: C.cream, outlineWidth: 4, outlineColor: [14, 18, 15, 240], fontFamily: LABEL_FONT(), fontSettings: { sdf: true }, fontWeight: 700, billboard: true, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, updateTriggers: { getPosition: relief } })]),
    ];
  };
  const hex = (h, a = 255) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a];

  container.addEventListener('contextmenu', (e) => e.preventDefault()); // right-drag = rotate/tilt, no browser menu
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pinnedExtract) { pinnedExtract = null; render(); } }); // Esc unpins an extract name
  const deck = new Deck({
    parent: container, views: new OrbitView({ orbitAxis: 'Z', fovy: 22 }), controller: { dragMode: 'pan', inertia: 300 }, // left-drag pans, right/shift-drag rotates
    initialViewState: viewState, effects: [lighting], getCursor: ({ isHovering }) => (isHovering ? 'pointer' : 'grab'),
    onViewStateChange: ({ viewState: v }) => { const zoomed = Math.abs((v.zoom ?? 0) - (viewState.zoom ?? 0)) > 0.05; viewState = v; deck.setProps({ viewState: v }); if (zoomed) render(); src.onViewChange?.(v); },
    getTooltip: ({ object, layer }) => {
      if (!object) return null;
      if (layer.id === 'buildings') return { html: `<b>${esc(object.place ?? object.name ?? object.kind)}</b><br>${object.floors} floor${object.floors > 1 ? 's' : ''} · ${object.height} m`, className: 'deck-tooltip' };
      if (layer.id === 'roofs') return { html: `<b>${esc(object.b.place ?? object.b.name ?? object.b.kind)}</b><br>${object.b.floors} floor${object.b.floors > 1 ? 's' : ''} · ${object.b.height} m`, className: 'deck-tooltip' };
      if (layer.id === 'props') return { html: `<b>${esc(object.p.name ?? object.p.type)}</b>`, className: 'deck-tooltip' };
      if (layer.id === 'underground') return { html: `<b>${esc(object.name)}</b><br>underground`, className: 'deck-tooltip' };
      if (layer.id === 'markers-extract' || layer.id === 'markers-chips') return { html: object.html, className: 'deck-tooltip' };
      if (layer.id === 'quest-markers') return { html: object.html, className: 'deck-tooltip' };
      if (layer.id === 'players' || layer.id === 'player-ring' || layer.id === 'player-piece') { if (layer.id === 'player-piece') object = object.p; const y = object.last.y ?? 0, g = H(object.last.x, object.last.z) / relief, rel = y - g; const fl = rel < -1.5 ? 'underground' : rel < 2.6 ? 'ground' : `floor ${Math.floor(rel / 3.3) + 1}`; const note = relief === 1 ? '' : `<br>Relief ${relief}× · ground height visually exaggerated`; return { html: `<b>${esc(object.name)}</b><br>${fl} · x ${object.last.x} z ${object.last.z} y ${y}${note}`, className: 'deck-tooltip' }; }
      return null;
    },
  });
  let base = staticLayers();
  let extras = extraLayers();
  initialised = true;
  function render() {
    const visibleBase = base.filter((layer) => (nature.trees || layer.id !== 'understory') && (nature.rocks || !['rocks', 'hard-rocks'].includes(layer.id)));
    const vegetation = nature.trees ? treeLayers({ treeSet, H, zoom: viewState.zoom ?? 0, relief }) : [];
    deck.setProps({ layers: [...visibleBase, ...vegetation, extras[0], ...buildingLayer(), ...extras.slice(1), ...dynamicLayers()] });
  }
  function setRelief(next) {
    next = [1, 2, 3].includes(Number(next)) ? Number(next) : 3;
    if (next === relief) return;
    relief = next;
    rebuildGround();
    placeBuildings();
    floorLines = makeFloorLines();
    propData = propParts(data.props || []);
    details = detailParts(data.buildings, scenes);
    parts = buildingParts(data.buildings);
    lighting = sceneLighting();
    base = staticLayers();
    extras = extraLayers();
    deck.setProps({ effects: [lighting] });
    render();
  }
  render();
  // Under software GL (and on a cold cache) the baked ground texture can finish uploading after
  // deck's first paint without setting a redraw flag, which leaves the terrain mesh black. A few
  // forced redraws cost nothing and make the first frame deterministic.
  for (const t of [300, 1200, 3500]) setTimeout(() => { try { deck.redraw('late-upload'); } catch {} }, t);
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
  const api = {
    refresh: render,
    setFloor: (f) => { floor = f; render(); },
    setNature: (next) => { nature = { ...nature, ...next }; render(); },
    setRelief,
    diagnostics,
    // sidebar hover/click can pin an extract's name in 3D (name+kind key, or null to clear)
    focusExtract: (name, kind) => { pinnedExtract = name ? (name + '|' + (kind ?? 'extract-pmc')) : null; render(); },
    setView: ({ target, zoom }) => { viewState = { ...viewState, target, zoom }; deck.setProps({ viewState }); },
    // game coords -> screen pixels, so main.js can pin an HTML card to a 3D point
    project: (x, z, dy = 0.7) => { try { const vp = deck.getViewports?.()[0]; return vp ? vp.project(Pg([x, z], dy)) : null; } catch { return null; } },
    deck,
  };
  // Non-enumerable test hook: CDP verification can compare the same layer inventory at 1x/3x
  // without shipping a visible debug UI or a global variable.
  Object.defineProperty(container, '__tz3d', { value: api, configurable: true });
  return api;
}
