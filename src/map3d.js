// 3D view: deck.gl OrbitView (orthographic, tilted) over the same game-coordinate data as the 2D map.
// deck cartesian = [-gameX, -gameZ, gameY] so on-screen orientation matches the 2D map at 0° orbit.
import { Deck, OrbitView, LightingEffect, AmbientLight, DirectionalLight, COORDINATE_SYSTEM } from '@deck.gl/core';
import { SolidPolygonLayer, PathLayer, IconLayer, TextLayer, LineLayer, PolygonLayer, ScatterplotLayer } from '@deck.gl/layers';
import { PathStyleExtension, CollisionFilterExtension } from '@deck.gl/extensions';
import { KINDS, iconDataUrl, arrowDataUrl, extractLetter } from './icons.js';
import { esc, COLORS } from './live.js';

const C = {
  grass: [62, 92, 48], grassHigh: [122, 140, 66], land: [62, 92, 48], water: [24, 44, 58], shore: [120, 170, 200, 160], pavement: [112, 116, 108],
  road: [128, 130, 124], roadEdge: [60, 62, 58], highway: [150, 140, 100], highwayEdge: [92, 84, 56], track: [104, 94, 66], dirt: [122, 108, 78],
  rail: [128, 118, 100], sleeper: [90, 84, 72], fence: [96, 88, 74], fenceTop: [60, 54, 46],
  building: [168, 158, 142], buildingMulti: [150, 140, 124], roofWarehouse: [128, 122, 112], roofHouse: [110, 96, 84], tank: [146, 150, 148], tower: [122, 124, 120],
  tree: [34, 62, 32], treeTop: [58, 96, 46], rock: [168, 158, 136], bridge: [126, 120, 108], bridgeRail: [70, 66, 60], pier: [104, 100, 92],
  contour: [46, 70, 36, 150], contourMajor: [36, 56, 28, 220], oob: [20, 24, 22], cliff: [44, 44, 40], cliffTop: [150, 142, 124], shade: [0, 0, 0, 60], floorLine: [0, 0, 0, 70],
  underground: [40, 40, 40, 110], buildingHover: [255, 214, 90], cream: [245, 242, 232], ink: [12, 16, 14], amber: [255, 214, 90],
};
const HYPSO = [[54, 84, 44], [62, 92, 48], [74, 104, 52], [88, 118, 56], [104, 130, 60], [122, 140, 66]];
const P = ([x, z], y = 0) => [-x, -z, y];
let H = () => 0; // terrain height at game (x, z); set once data is loaded
const Pg = ([x, z], dy = 0) => P([x, z], H(x, z) + dy); // draped point
const ringG = (poly, dy = 0) => poly.map((p) => Pg(p, dy));
function makeSampler(t) {
  const { x0, z0, step, cols, rows, heights } = t;
  return (x, z) => {
    const fx = Math.min(Math.max((x - x0) / step, 0), cols - 1.001), fz = Math.min(Math.max((z - z0) / step, 0), rows - 1.001);
    const c = Math.floor(fx), r = Math.floor(fz), tx = fx - c, tz = fz - r;
    const h00 = heights[r * cols + c], h10 = heights[r * cols + c + 1], h01 = heights[(r + 1) * cols + c], h11 = heights[(r + 1) * cols + c + 1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  };
}
function contours(t, interval = 2) { // marching squares isolines in game coords
  const { x0, z0, step, cols, rows, heights } = t, lines = [];
  const h = (r, c) => heights[r * cols + c];
  const hmax = Math.max(...heights);
  for (let lv = interval; lv <= hmax; lv += interval) for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
    const v = [h(r, c), h(r, c + 1), h(r + 1, c + 1), h(r + 1, c)]; const x = x0 + c * step, z = z0 + r * step;
    const pts = []; const edge = (a, b, pa, pb) => { if ((v[a] < lv) !== (v[b] < lv)) { const t2 = (lv - v[a]) / (v[b] - v[a]); pts.push([pa[0] + (pb[0] - pa[0]) * t2, pa[1] + (pb[1] - pa[1]) * t2]); } };
    edge(0, 1, [x, z], [x + step, z]); edge(1, 2, [x + step, z], [x + step, z + step]); edge(2, 3, [x + step, z + step], [x, z + step]); edge(3, 0, [x, z + step], [x, z]);
    const ok = (pp) => !t.limit || pp.every((q) => inPolyXZ(q, t.limit));
    if (pts.length === 2) { if (ok(pts)) lines.push({ path: pts, lv }); } else if (pts.length === 4) { if (ok([pts[0], pts[1]])) lines.push({ path: [pts[0], pts[1]], lv }); if (ok([pts[2], pts[3]])) lines.push({ path: [pts[2], pts[3]], lv }); }
  }
  return lines;
}
const inPolyXZ = ([x, z], poly) => { let inside = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, zi] = poly[i], [xj, zj] = poly[j]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside; } return inside; };
const VOID_Z = -14;
function voidRect(limit) { const xs = limit.map((p) => p[0]), zs = limit.map((p) => p[1]); const m = 60; return [[Math.min(...xs) - m, Math.min(...zs) - m], [Math.max(...xs) + m, Math.min(...zs) - m], [Math.max(...xs) + m, Math.max(...zs) + m], [Math.min(...xs) - m, Math.max(...zs) + m]]; }
// cliff skirt: a strip just outside each boundary segment, extruded from the void floor up to the ground height
function cliffStrips(limit) {
  const c = limit.reduce((a, p) => [a[0] + p[0] / limit.length, a[1] + p[1] / limit.length], [0, 0]); const out = [];
  for (let i = 0; i < limit.length; i++) {
    const a = limit[i], b = limit[(i + 1) % limit.length]; const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz); if (L < 0.5) continue;
    let nx = -dz / L, nz = dx / L; const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2; if ((mx + nx - c[0]) ** 2 + (mz + nz - c[1]) ** 2 < (mx - c[0]) ** 2 + (mz - c[1]) ** 2) { nx = -nx; nz = -nz; } // outward
    const w = 3; const poly = [a, b, [b[0] + nx * w, b[1] + nz * w], [a[0] + nx * w, a[1] + nz * w]];
    const h = (H(a[0], a[1]) + H(b[0], b[1])) / 2 - VOID_Z;
    out.push({ poly, h: h - 0.9, color: C.cliff }); out.push({ poly, h: h + 0.3, color: C.cliffTop, top: true });
  }
  return out;
}
function terrainQuads(t, base, limit) { // shaded ground quads (cheap hillshade baked into colour)
  const { x0, z0, cols, rows } = t, out = [], light = [-0.55, -0.4, 0.72], SUB = 3, step = t.step / SUB;
  const Hs = makeSampler(t);
  const hmin = Math.min(...t.heights), hmax = Math.max(...t.heights), span = Math.max(1, hmax - hmin);
  const ramp = (h) => { const f = Math.min(1, Math.max(0, (h - hmin) / span)) * (HYPSO.length - 1), k = Math.floor(f), u = f - k, a = HYPSO[k], b = HYPSO[Math.min(HYPSO.length - 1, k + 1)]; return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]; };
  for (let r = 0; r < (rows - 1) * SUB; r++) for (let c = 0; c < (cols - 1) * SUB; c++) {
    const h = (rr, cc) => Hs(x0 + cc * step, z0 + rr * step);
    const dx = (h(r, c + 1) - h(r, c)) / step, dz = (h(r + 1, c) - h(r, c)) / step; // slope
    const n = [-dx * 3, -dz * 3, 1], L = Math.hypot(...n); const shade = Math.max(0.42, Math.min(1.22, (n[0] * light[0] + n[1] * light[1] + n[2] * light[2]) / L + 0.32));
    const hm = (h(r, c) + h(r + 1, c + 1)) / 2;
    const x = x0 + c * step, z = z0 + r * step;
    if (limit && !inPolyXZ([x + step / 2, z + step / 2], limit)) continue; // nothing outside the playable area
    const col = ramp(hm);
    const sh = shade;
    out.push({ poly: [[x, z, h(r, c)], [x + step, z, h(r, c + 1)], [x + step, z + step, h(r + 1, c + 1)], [x, z + step, h(r + 1, c)]], color: col.map((v) => Math.min(255, v * sh)) });
  }
  return out;
}
const OVERLAY = { depthCompare: 'always', depthWriteEnabled: false };
// icons/labels always on top of geometry
const ring = (poly) => poly.map((p) => P(p));
const ringAt = (poly, y) => poly.map((p) => P(p, y));
const expand = (poly, m) => { const c = poly.reduce((a, p) => [a[0] + p[0] / poly.length, a[1] + p[1] / poly.length], [0, 0]); return poly.map(([x, z]) => { const dx = x - c[0], dz = z - c[1], L = Math.hypot(dx, dz) || 1; return [x + (dx / L) * m, z + (dz / L) * m]; }); };
// bridge deck as a 3D path: ramps up over the first/last 15 m, flat deck in between
function bridgePath(b) {
  const p = b.path, cum = [0]; for (let i = 1; i < p.length; i++) cum.push(cum[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]));
  const L = cum[cum.length - 1], ramp = Math.min(15, L / 3);
  return p.map((pt, i) => { const t = cum[i]; const h = t < ramp ? (t / ramp) * b.height : t > L - ramp ? ((L - t) / ramp) * b.height : b.height; return Pg(pt, h + 0.1); });
}
// offset a 3D path sideways by d metres (for railings on both sides of a deck)
function offsetPath(p, d) {
  return p.map((q, i) => { const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)]; const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1; return [q[0] - (dy / L) * d, q[1] + (dx / L) * d, q[2]]; });
}
function piers(b) { if (b.ford) return []; const p = bridgePath(b), out = []; for (let i = 3; i < p.length - 3; i += 3) if (p[i][2] >= b.height - 0.01) out.push({ pos: p[i], h: b.height - 0.3, w: b.width * 0.5 }); return out; }
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
function pylonParts(b, posts, slabs, edges) {
  const o = obb(b.poly), H0 = b.height || 22, base = b.base ?? 0, { mn, mx, toXZ } = o;
  const cx = (mn[0] + mx[0]) / 2, cy = (mn[1] + mx[1]) / 2, w = Math.max(3, Math.min(mx[0] - mn[0], mx[1] - mn[1]));
  for (const [du, dv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) posts.push({ pos: toXZ(cx + du * w * 0.38, cy + dv * w * 0.38), h: H0, w: 0.45, color: [120, 120, 118], base });
  const arm = [toXZ(cx - w * 0.9, cy), toXZ(cx + w * 0.9, cy)]; // cross-arm at the top
  edges.push({ path: [[...P(arm[0]), H0 - 1.5], [...P(arm[1]), H0 - 1.5]].map(([x, y, z]) => [x, y, z]), base, wide: true });
  slabs.push({ poly: [toXZ(cx - w * 0.45, cy - w * 0.45), toXZ(cx + w * 0.45, cy - w * 0.45), toXZ(cx + w * 0.45, cy + w * 0.45), toXZ(cx - w * 0.45, cy + w * 0.45)], z: H0, color: [130, 130, 128], base });
}
function buildingParts(bs) {
  const walls = [], roofs = [], slabs = [], posts = [], edges = [];
  for (const b of bs) {
    if (b.kind === 'powerline_towers') { pylonParts(b, posts, slabs, edges); continue; }
    const st = b.style || 'box';
    if (st === 'box' || st === 'tank') walls.push({ ...b, h: b.height });
    if (st === 'tank') slabs.push({ poly: b.poly, z: b.height + 0.02, color: [215, 220, 226], base: b.base });
    if (st === 'gable') {
      if (!isRectangular(b.poly)) { walls.push({ ...b, h: b.height }); slabs.push({ poly: b.poly, z: b.height + 0.02, color: b.roof ?? C.roofWarehouse, base: b.base }); continue; }
      walls.push({ ...b, h: b.height * 0.72 });
      const rc = b.roof ?? (['Crackhouse', 'Streamer House'].includes(b.place) ? C.roofHouse : C.roofWarehouse), shade = (k) => rc.map((c) => Math.min(255, c * k));
      hipRoof(b).forEach((pts, i) => roofs.push({ pts, color: shade([1, 0.82, 0.9, 0.9][i]), b }));
    }
    if (st === 'frame') { for (let k = 1; k <= b.floors; k++) { const z = k * 3.3; slabs.push({ poly: b.poly, z, color: [190, 190, 188, 205], base: b.base }); edges.push({ path: [...ringAt(b.poly, z), ringAt(b.poly, z)[0]], base: b.base }); } for (const c of columns(b.poly)) posts.push({ pos: c, h: b.floors * 3.3, w: 0.7, color: [175, 175, 172], base: b.base }); }
    if (st === 'canopy') { slabs.push({ poly: b.poly, z: b.height, color: b.color ?? [235, 235, 235], base: b.base }); edges.push({ path: [...ringAt(b.poly, b.height - 0.4), ringAt(b.poly, b.height - 0.4)[0]], base: b.base }); for (const c of columns(b.poly, 9)) posts.push({ pos: c, h: b.height, w: 0.5, color: [200, 200, 200], base: b.base }); }
  }
  return { walls, roofs, slabs, posts, edges };
}
// rotated box footprint in game coords: centre (x,z), w across, l along heading rot (deg)
function rbox(x, z, w, l, rot) { const a = (rot * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a); return [[-l / 2, -w / 2], [l / 2, -w / 2], [l / 2, w / 2], [-l / 2, w / 2]].map(([u, v]) => [x + u * c - v * sn, z + u * sn + v * c]); }
const circle = (x, z, r, n = 18) => Array.from({ length: n }, (_, i) => [x + r * Math.cos((i / n) * 2 * Math.PI), z + r * Math.sin((i / n) * 2 * Math.PI)]);
// thin strip polygon around a polyline (for fences/walls)
function strip(path, w) { const L = [], R = []; for (let i = 0; i < path.length; i++) { const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)]; const dx = b[0] - a[0], dz = b[1] - a[1], n = Math.hypot(dx, dz) || 1; L.push([path[i][0] - (dz / n) * w, path[i][1] + (dx / n) * w]); R.push([path[i][0] + (dz / n) * w, path[i][1] - (dx / n) * w]); } return [...L, ...R.reverse()]; }
const PROP_COLORS = { container: [200, 70, 60], tank: [200, 205, 212], tanker: [205, 205, 210], railcar: [90, 80, 75], vehicle: [120, 130, 140], crane: [220, 180, 60], wall: [190, 186, 180], pipe: [150, 150, 150] };
function propParts(props) { // -> extruded footprints with base at terrain
  return props.map((p) => {
    const base = H(p.x ?? p.path?.[0]?.[0] ?? 0, p.z ?? p.path?.[0]?.[1] ?? 0);
    const color = p.color ?? PROP_COLORS[p.type] ?? [160, 160, 160];
    if (p.type === 'wall' || p.type === 'pipe') return { poly: strip(p.path, (p.w ?? 0.4) / 2), h: p.h ?? 2.5, base, color, p };
    if (p.type === 'tank') return { poly: circle(p.x, p.z, p.r), h: p.h ?? 6, base, color, p };
    return { poly: rbox(p.x, p.z, p.w ?? 2.4, p.l ?? 6, p.rot ?? 0), h: p.h ?? 2.6, base: base + (p.dz ?? 0), color, p };
  });
}
const box = ([x, y], w) => [[x - w / 2, y - w / 2], [x + w / 2, y - w / 2], [x + w / 2, y + w / 2], [x - w / 2, y + w / 2]];

export async function createView3d(container, mapData, src) {
  const data = await (await fetch('/data/customs-3d.json')).json();
  if (data.terrain) { H = makeSampler(data.terrain); data.terrain.limit = data.limit; }
  const inLimit = (x, z) => !data.limit || inPolyXZ([x, z], data.limit);
  const centroidOf = (poly) => poly.reduce((a, p) => [a[0] + p[0] / poly.length, a[1] + p[1] / poly.length], [0, 0]);
  for (const b of data.buildings) { const c = centroidOf(b.poly); b.base = H(c[0], c[1]); }
  // Rasterise SVG icons into one canvas atlas (deck's icon loader is unreliable with SVG data URLs).
  async function buildAtlas(entries, cell) {
    const canvas = document.createElement('canvas'); canvas.width = cell * entries.length; canvas.height = cell;
    const ctx = canvas.getContext('2d'); const mapping = {};
    await Promise.all(entries.map(([name, url], i) => new Promise((res) => {
      const img = new Image(); img.onload = () => { ctx.drawImage(img, i * cell, 0, cell, cell); res(); }; img.onerror = res; img.src = url;
      mapping[name] = { x: i * cell, y: 0, width: cell, height: cell, anchorY: cell, mask: false };
    })));
    return { canvas, mapping };
  }
  const iconAtlas = await buildAtlas(Object.keys(KINDS).map((k) => [k, iconDataUrl(k, 64)]), 64);
  const letters = [...new Set(src.markers().filter((m) => m.kind.startsWith('extract')).map((m) => extractLetter(m.name)).filter(Boolean))];
  const letterAtlas = await buildAtlas(src.markers().filter((m) => m.kind.startsWith('extract') && extractLetter(m.name)).map((m) => [m.kind + ':' + extractLetter(m.name), iconDataUrl(m.kind, 64, extractLetter(m.name))]).filter((e, i, a) => a.findIndex((x) => x[0] === e[0]) === i), 64);
  Object.assign(iconAtlas.mapping, Object.fromEntries(Object.entries(letterAtlas.mapping).map(([k, m]) => [k, { ...m, x: m.x + iconAtlas.canvas.width }])));
  { const merged = document.createElement('canvas'); merged.width = iconAtlas.canvas.width + letterAtlas.canvas.width; merged.height = 64; const cx2 = merged.getContext('2d'); cx2.drawImage(iconAtlas.canvas, 0, 0); cx2.drawImage(letterAtlas.canvas, iconAtlas.canvas.width, 0); iconAtlas.canvas = merged; }
  const arrowAtlas = await buildAtlas(COLORS.map((c) => [c, arrowDataUrl(c, 64)]), 64);
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
  const capH = (b, h) => (floor === 'all' || floor === 'U' ? h : Math.min(h, (Number(floor) + 1) * 3.3 - 0.4 + (b.style === 'canopy' ? 10 : 0)));

  const lighting = new LightingEffect({
    ambient: new AmbientLight({ color: [255, 255, 255], intensity: 0.85 }),
    sun: new DirectionalLight({ color: [255, 250, 240], intensity: 0.9, direction: [-0.6, -0.4, -1] }),
  });

  const staticLayers = () => [
    ...(data.terrain ? [new PathLayer({ id: 'contours', shadowEnabled: false, data: contours(data.terrain, 2), getPath: (d) => d.path.map((p) => Pg(p, 0.15)), getColor: (d) => (d.lv % 10 === 0 ? C.contourMajor : C.contour), getWidth: (d) => (d.lv % 10 === 0 ? 0.9 : 0.5), widthUnits: 'meters', widthMinPixels: 1, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN })] : []),
    ...(data.limit ? [
      new SolidPolygonLayer({ id: 'void', shadowEnabled: false, data: [voidRect(data.limit)], getPolygon: (d) => d.map(([x, z]) => P([x, z], VOID_Z)), getFillColor: C.oob, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
      new SolidPolygonLayer({ id: 'cliff', data: cliffStrips(data.limit), getPolygon: (d) => d.poly.map(([x, z]) => P([x, z], VOID_Z)), extruded: true, getElevation: (d) => d.h, getFillColor: (d) => d.color, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, material: { ambient: 0.6, diffuse: 0.6, shininess: 0 } }),
    ] : []),
    data.terrain ? new SolidPolygonLayer({ id: 'terrain', shadowEnabled: false, data: terrainQuads(data.terrain, C.land, data.limit), getPolygon: (d) => d.poly.map(([x, z, y]) => P([x, z], y)), getFillColor: (d) => d.color, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, material: { ambient: 0.55, diffuse: 0.55, shininess: 0 } }) : new SolidPolygonLayer({ id: 'land', shadowEnabled: false, data: data.land, getPolygon: ring, getFillColor: C.land, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new SolidPolygonLayer({ id: 'pavement', shadowEnabled: false, data: data.pavement, getPolygon: (d) => ringG(d, 0.08), getFillColor: C.pavement, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new SolidPolygonLayer({ id: 'water', shadowEnabled: false, data: data.water, getPolygon: (d) => ringG(d, -0.2), getFillColor: C.water, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new PathLayer({ id: 'shore', shadowEnabled: false, data: data.water, getPath: (d) => ringG([...d, d[0]], 0.05), getColor: C.shore, getWidth: 0.4, widthUnits: 'meters', widthMinPixels: 1, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new SolidPolygonLayer({ id: 'underground', shadowEnabled: false, data: data.underground, getPolygon: (d) => ringG(d.poly, 0.1), getFillColor: () => (floor === 'U' ? [255, 120, 40, 200] : C.underground), updateTriggers: { getFillColor: floor }, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, pickable: true }),
    new PathLayer({ id: 'rail', shadowEnabled: false, data: data.railway, getPath: (d) => ringG(d.path, 0.1), getColor: C.rail, getWidth: 0.9, widthUnits: 'meters', widthMinPixels: 1, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new PathLayer({ id: 'sleepers', shadowEnabled: false, data: data.railway, getPath: (d) => ringG(d.path, 0.12), getColor: C.sleeper, getWidth: 2.2, widthUnits: 'meters', widthMinPixels: 1, getDashArray: [1.2, 1.2], extensions: [new PathStyleExtension({ dash: true })], coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new PathLayer({ id: 'road-edges', shadowEnabled: false, data: data.roads.filter((d) => d.kind !== 'track' && d.kind !== 'dirt'), getPath: (d) => ringG(d.path, 0.1), getColor: (d) => (d.kind === 'highway' ? C.highwayEdge : d.kind === 'dirt' ? C.dirtEdge : C.roadEdge), getWidth: (d) => d.width + 1.6, widthUnits: 'meters', widthMinPixels: 2.5, capRounded: true, jointRounded: true, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new PathLayer({ id: 'roads', shadowEnabled: false, data: data.roads.filter((d) => d.kind !== 'track' && d.kind !== 'dirt'), getPath: (d) => ringG(d.path, 0.12), getColor: (d) => (d.kind === 'highway' ? C.highway : C.road), getWidth: (d) => d.width, widthUnits: 'meters', widthMinPixels: 1.5, capRounded: true, jointRounded: true, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new PathLayer({ id: 'tracks', shadowEnabled: false, data: data.roads.filter((d) => d.kind === 'track' || d.kind === 'dirt'), getPath: (d) => ringG(d.path, 0.12), getColor: C.track, getWidth: (d) => (d.kind === 'dirt' ? 2.6 : 1.8), widthUnits: 'meters', widthMinPixels: 1, capRounded: true, jointRounded: true, getDashArray: [5, 3], dashJustified: true, extensions: [new PathStyleExtension({ dash: true })], coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new PathLayer({ id: 'road-centre', shadowEnabled: false, data: data.roads.filter((d) => d.kind === 'highway'), getPath: (d) => ringG(d.path, 0.14), getColor: [255, 255, 255, 180], getWidth: 0.25, widthUnits: 'meters', widthMinPixels: 1, getDashArray: [6, 6], dashJustified: true, extensions: [new PathStyleExtension({ dash: true })], coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new PathLayer({ id: 'cables', shadowEnabled: false, data: data.powerlines || [], getPath: (d) => ringG(d.path, 19), getColor: [90, 90, 90, 200], getWidth: 0.25, widthUnits: 'meters', widthMinPixels: 1, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new SolidPolygonLayer({ id: 'rocks', shadowEnabled: false, data: data.rocks, getPolygon: (d) => ringG(d, 0), extruded: true, getElevation: 1.2, getFillColor: C.rock, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, material: { ambient: 0.7, diffuse: 0.5, shininess: 4 } }),
    new SolidPolygonLayer({ id: 'trees', shadowEnabled: false, data: data.trees, getPolygon: (d) => ringG(d, 0), extruded: true, getElevation: 3, getFillColor: C.tree, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, material: { ambient: 0.75, diffuse: 0.45, shininess: 4 } }),
  ];
  const floorLines = data.buildings.flatMap((b) => Array.from({ length: Math.max(0, b.floors - 1) }, (_, k) => ({ path: [...ringAt(expand(b.poly, 0.15), (k + 1) * 3.3 + (b.base ?? 0)), ringAt(expand(b.poly, 0.15), (k + 1) * 3.3 + (b.base ?? 0))[0]] })));
  const propData = propParts(data.props || []);
  const fenceStrips = (data.fences || []).map((f) => ({ poly: strip(f.path, 0.12), base: 0 }));
  const extraLayers = () => [
    new SolidPolygonLayer({ id: 'props', data: propData, getPolygon: (d) => ringAt(d.poly, d.base), extruded: true, getElevation: (d) => d.h, getFillColor: (d) => d.color, pickable: true, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, material: { ambient: 0.7, diffuse: 0.55 } }),
    new PathLayer({ id: 'fence-tops', shadowEnabled: false, data: data.fences || [], getPath: (d) => ringG(d.path, 1.92), getColor: C.fenceTop, getWidth: 0.3, widthUnits: 'meters', widthMinPixels: 1, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new SolidPolygonLayer({ id: 'fences-3d', shadowEnabled: false, data: fenceStrips, getPolygon: (d) => ringG(d.poly, 0), extruded: true, getElevation: 1.9, getFillColor: C.fence, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new SolidPolygonLayer({ id: 'shade', shadowEnabled: false, data: data.buildings, getPolygon: (d) => ringG(expand(d.poly, 1.6), 0.05), getFillColor: C.shade, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new SolidPolygonLayer({ id: 'tree-tops', shadowEnabled: false, data: data.trees, getPolygon: (d) => ringG(d, 3.02), getFillColor: C.treeTop, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new SolidPolygonLayer({ id: 'piers', data: (data.bridges || []).flatMap(piers), getPolygon: (d) => box(d.pos, d.w).map(([x, y]) => [x, y, d.pos[2] - d.h]), extruded: true, getElevation: (d) => d.h, getFillColor: C.pier, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, material: { ambient: 0.7, diffuse: 0.5 } }),
    new PathLayer({ id: 'bridge-edges', shadowEnabled: false, data: (data.bridges || []).filter((b) => !b.ford), getPath: (d) => bridgePath(d).map((q) => [q[0], q[1], q[2] - 0.15]), getColor: [150, 150, 148], getWidth: (d) => d.width + 1.2, widthUnits: 'meters', widthMinPixels: 2, capRounded: false, jointRounded: true, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new PathLayer({ id: 'bridges', shadowEnabled: false, data: data.bridges || [], getPath: bridgePath, getColor: (d) => (d.foot ? [150, 120, 90] : d.ford ? [222, 214, 196] : C.bridge), getWidth: (d) => d.width, widthUnits: 'meters', widthMinPixels: 2, capRounded: false, jointRounded: true, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new PathLayer({ id: 'bridge-rails', shadowEnabled: false, data: (data.bridges || []).filter((b) => !b.ford).flatMap((b) => { const p = bridgePath(b).map((q) => [q[0], q[1], q[2] + 1.1]); return [offsetPath(p, b.width / 2 - 0.3), offsetPath(p, -(b.width / 2 - 0.3))]; }), getPath: (d) => d, getColor: C.bridgeRail, getWidth: 0.4, widthUnits: 'meters', widthMinPixels: 1, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new PathLayer({ id: 'floor-lines', shadowEnabled: false, data: floorLines, getPath: (d) => d.path, getColor: C.floorLine, getWidth: 0.35, widthUnits: 'meters', widthMinPixels: 1, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
  ];
  const parts = buildingParts(data.buildings);
  const buildingLayer = () => [
    new SolidPolygonLayer({
      id: 'buildings', data: parts.walls, getPolygon: (d) => ringAt(d.poly, d.base ?? 0), extruded: true, getElevation: (d) => capH(d, d.h), updateTriggers: { getElevation: floor, getFillColor: [hover, floor] },
      getFillColor: (d, { index }) => (hover === index ? C.buildingHover : d.color ? d.color : d.kind === 'tank' ? C.tank : d.kind === 'powerline_towers' ? C.tower : d.floors > 1 ? C.buildingMulti : C.building),
      pickable: true, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      material: { ambient: 0.7, diffuse: 0.55, shininess: 12, specularColor: [30, 30, 30] },
      onHover: (i) => { if (i.index !== hover) { hover = i.index; render(); } },
    }),
    new SolidPolygonLayer({ id: 'roofs', visible: floor === 'all' || floor === 'U', data: parts.roofs, getPolygon: (d) => d.pts.map(([x, z, y]) => P([x, z], y + (d.b.base ?? 0))), getFillColor: (d) => d.color, pickable: true, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, material: { ambient: 0.8, diffuse: 0.4 } }),
    new SolidPolygonLayer({ id: 'slabs', shadowEnabled: false, data: parts.slabs.filter((d) => floor === 'all' || floor === 'U' || d.z <= (Number(floor) + 1) * 3.3), getPolygon: (d) => ringAt(d.poly, d.z + (d.base ?? 0)), updateTriggers: { getPolygon: floor }, getFillColor: (d) => d.color, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new SolidPolygonLayer({ id: 'posts', data: parts.posts, getPolygon: (d) => box(P(d.pos), d.w).map(([x, y]) => [x, y, d.base ?? 0]), extruded: true, getElevation: (d) => d.h, getFillColor: (d) => d.color, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, material: { ambient: 0.7, diffuse: 0.5 } }),
    new PathLayer({ id: 'slab-edges', shadowEnabled: false, data: parts.edges, getPath: (d) => d.path.map((q) => [q[0], q[1], q[2] + (d.base ?? 0)]), getColor: [110, 110, 108], getWidth: (d) => (d.wide ? 0.9 : 0.3), widthUnits: 'meters', widthMinPixels: 1, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
  ];
  const major = (d) => (d.size ?? 100) >= 100;
  const lift = (d) => (major(d) ? 26 : 16) * ((d.size ?? 100) / 100);
  const ring16 = (pos, r, dy) => { const pts = []; for (let i = 0; i <= 16; i++) pts.push(Pg([pos[0] + r * Math.cos((i / 16) * 2 * Math.PI), pos[1] + r * Math.sin((i / 16) * 2 * Math.PI)], dy)); return pts; };
  const pingLayers = (labelsAll) => { const labels = labelsAll.filter((d) => major(d) || viewState.zoom >= 0.8); return [
    new PathLayer({ id: 'ping-ring', data: labels, getPath: (d) => ring16(d.position, major(d) ? 2.2 : 1.4, 0.1), getColor: [245, 242, 232, 190], getWidth: 1.5, widthUnits: 'pixels', parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new ScatterplotLayer({ id: 'ping-dot', data: labels, getPosition: (d) => Pg(d.position, 0.15), getRadius: 0.7, radiusUnits: 'meters', radiusMinPixels: 1.5, getFillColor: C.cream, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new LineLayer({ id: 'ping-stem-shadow', data: labels, getSourcePosition: (d) => Pg(d.position, 0.2), getTargetPosition: (d) => Pg(d.position, lift(d) - 1.5), getColor: [12, 16, 14, 160], getWidth: 3.5, widthUnits: 'pixels', parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new LineLayer({ id: 'ping-stem', data: labels, getSourcePosition: (d) => Pg(d.position, 0.2), getTargetPosition: (d) => Pg(d.position, lift(d) - 1.5), getColor: [245, 242, 232, 200], getWidth: 1.5, widthUnits: 'pixels', parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new ScatterplotLayer({ id: 'ping-cap', data: labels, getPosition: (d) => Pg(d.position, lift(d) - 1.5), getRadius: 3, radiusUnits: 'pixels', getFillColor: C.cream, getLineColor: C.ink, lineWidthMinPixels: 1, stroked: true, billboard: true, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
  ]; };
  const dynamicLayers = () => {
    const markers = src.markers().filter((m) => inLimit(m.position.x, m.position.z));
    const labels = src.labels().filter((d) => inLimit(d.position[0], d.position[1]));
    const players = src.players().filter((p) => p.last);
    return [
      new IconLayer({ id: 'markers-extract', data: markers.filter((d) => d.kind.startsWith('extract') || d.kind === 'spawn-boss'), getPosition: (d) => Pg([d.position.x, d.position.z], 0.5), iconAtlas: iconAtlas.canvas, iconMapping: iconAtlas.mapping, getIcon: (d) => (d.kind.startsWith('extract') && extractLetter(d.name) ? d.kind + ':' + extractLetter(d.name) : d.kind), getSize: 26, sizeUnits: 'pixels', sizeMinPixels: 20, sizeMaxPixels: 32, billboard: true, pickable: true, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
      // everything else lies flat on the ground like chips on a table
      new IconLayer({ id: 'markers-chips', data: markers.filter((d) => !d.kind.startsWith('extract') && d.kind !== 'spawn-boss'), getPosition: (d) => Pg([d.position.x, d.position.z], 0.3), iconAtlas: chipAtlas.canvas, iconMapping: chipAtlas.mapping, getIcon: (d) => d.kind, getSize: 22, sizeUnits: 'pixels', sizeMinPixels: 12, sizeMaxPixels: 24, billboard: false, pickable: true, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
      ...pingLayers(labels),
      ...[true, false].map((isMajor) => new TextLayer({ id: isMajor ? 'labels-major' : 'labels-minor',
        data: labels.filter((d) => major(d) === isMajor && (isMajor || viewState.zoom >= 0.8)).map((d) => ({ p: Pg(d.position, lift(d) + 1.5), t: isMajor ? d.text.toUpperCase() : d.text })),
        getPosition: (d) => d.p, getText: (d) => d.t, getSize: isMajor ? 9.5 : 7, sizeUnits: 'meters', sizeMinPixels: isMajor ? 11 : 9, sizeMaxPixels: isMajor ? 19 : 14,
        getColor: isMajor ? [245, 242, 232] : [214, 214, 200], fontFamily: LABEL_FONT(), fontWeight: 700, fontSettings: { sdf: true }, outlineWidth: 3, outlineColor: [12, 16, 14, 235],
        billboard: true, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN })),
      new PathLayer({ id: 'trails', data: players.filter((p) => p.trail), getPath: (p) => p.trail.getLatLngs().map((ll) => Pg([ll.lng, ll.lat], 0.3)), getColor: (p) => hex(p.color, 200), getWidth: 1.2, widthUnits: 'meters', widthMinPixels: 2, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
      new LineLayer({ id: 'drop', data: players, getSourcePosition: (p) => Pg([p.last.x, p.last.z], 0), getTargetPosition: (p) => P([p.last.x, p.last.z], Math.max(p.last.y ?? 0, H(p.last.x, p.last.z) + 0.2)), getColor: (p) => hex(p.color, 160), getWidth: 2, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
      new IconLayer({ id: 'players', data: players, getPosition: (p) => P([p.last.x, p.last.z], (p.last.y ?? 0) + 0.2), iconAtlas: arrowAtlas.canvas, iconMapping: arrowAtlas.mapping, getIcon: (p) => p.color, getSize: 12, sizeUnits: 'meters', sizeMinPixels: 22, sizeMaxPixels: 44, billboard: false, getAngle: (p) => -((p.last.yaw ?? 0) + (mapData.coordinateRotation ?? 0)), pickable: true, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, updateTriggers: { getPosition: players.map((p) => p.last), getAngle: players.map((p) => p.last) } }),
      ...([new TextLayer({ id: 'player-names', data: players, getPosition: (p) => P([p.last.x, p.last.z], Math.max((p.last.y ?? 0) + 0.2, H(p.last.x, p.last.z) + 0.3)), getText: (p) => p.name, getPixelOffset: [22, 0], getTextAnchor: 'start', getSize: 14, getColor: C.cream, outlineWidth: 4, outlineColor: [12, 16, 14, 230], fontFamily: LABEL_FONT(), fontSettings: { sdf: true }, fontWeight: 700, billboard: true, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN })]),
    ];
  };
  const hex = (h, a = 255) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a];

  container.addEventListener('contextmenu', (e) => e.preventDefault()); // right-drag = rotate/tilt, no browser menu
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
      if (layer.id === 'markers') return { html: object.html, className: 'deck-tooltip' };
      if (layer.id === 'players') { const y = object.last.y ?? 0, g = H(object.last.x, object.last.z), rel = y - g; const fl = rel < -1.5 ? 'underground' : rel < 2.6 ? 'ground' : `floor ${Math.floor(rel / 3.3) + 1}`; return { html: `<b>${esc(object.name)}</b><br>${fl} · x ${object.last.x} z ${object.last.z} y ${y}`, className: 'deck-tooltip' }; }
      return null;
    },
  });
  const base = staticLayers();
  const extras = extraLayers();
  initialised = true;
  function render() { deck.setProps({ layers: [...base, extras[0], ...buildingLayer(), ...extras.slice(1), ...dynamicLayers()] }); }
  render();
  return {
    refresh: render,
    setFloor: (f) => { floor = f; render(); },
    setView: ({ target, zoom }) => { viewState = { ...viewState, target, zoom }; deck.setProps({ viewState }); },
    deck,
  };
}
