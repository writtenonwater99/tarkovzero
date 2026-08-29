// 3D view: deck.gl OrbitView (orthographic, tilted) over the same game-coordinate data as the 2D map.
// deck cartesian = [-gameX, -gameZ, gameY] so on-screen orientation matches the 2D map at 0° orbit.
import { Deck, OrbitView, LightingEffect, AmbientLight, DirectionalLight, COORDINATE_SYSTEM } from '@deck.gl/core';
import { SolidPolygonLayer, PathLayer, IconLayer, TextLayer, LineLayer, PolygonLayer } from '@deck.gl/layers';
import { KINDS, iconDataUrl, arrowDataUrl } from './icons.js';
import { esc, COLORS } from './live.js';

const C = {
  land: [238, 240, 242], water: [156, 196, 245], pavement: [224, 224, 224], tree: [183, 217, 154], rock: [205, 205, 205],
  road: [255, 255, 255], highway: [253, 226, 147], dirt: [245, 239, 224], rail: [160, 160, 160], fence: [200, 200, 200],
  building: [222, 214, 203], buildingMulti: [206, 194, 178], tank: [200, 205, 212], tower: [180, 180, 180], underground: [40, 40, 40, 70],
  buildingHover: [96, 165, 250], treeTop: [196, 226, 168], shade: [0, 0, 0, 28], floorLine: [0, 0, 0, 45], bridge: [225, 225, 222], bridgeRail: [120, 120, 120], pier: [190, 190, 188],
};
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
    if (pts.length === 2) lines.push({ path: pts, lv }); else if (pts.length === 4) { lines.push({ path: [pts[0], pts[1]], lv }); lines.push({ path: [pts[2], pts[3]], lv }); }
  }
  return lines;
}
function terrainQuads(t, base) { // shaded ground quads (cheap hillshade baked into colour)
  const { x0, z0, step, cols, rows, heights } = t, out = [], light = [-0.5, -0.35, 0.8];
  for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
    const h = (rr, cc) => heights[rr * cols + cc];
    const dx = (h(r, c + 1) - h(r, c)) / step, dz = (h(r + 1, c) - h(r, c)) / step; // slope
    const n = [-dx * 2.2, -dz * 2.2, 1], L = Math.hypot(...n); const shade = Math.max(0.5, Math.min(1.18, (n[0] * light[0] + n[1] * light[1] + n[2] * light[2]) / L + 0.32));
    const hm = (h(r, c) + h(r + 1, c + 1)) / 2, tint = Math.min(1, Math.max(0, hm / 12)); // higher ground slightly warmer/lighter
    const x = x0 + c * step, z = z0 + r * step;
    out.push({ poly: [[x, z, h(r, c)], [x + step, z, h(r, c + 1)], [x + step, z + step, h(r + 1, c + 1)], [x, z + step, h(r + 1, c)]], color: [Math.min(255, (base[0] + 8 * tint) * shade), Math.min(255, (base[1] + 4 * tint) * shade), Math.min(255, (base[2] - 10 * tint) * shade)] });
  }
  return out;
}
const OVERLAY = { depthCompare: 'always', depthWriteEnabled: false }; // icons/labels always on top of geometry
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
function piers(b) { const p = bridgePath(b), out = []; for (let i = 3; i < p.length - 3; i += 3) if (p[i][2] >= b.height - 0.01) out.push({ pos: p[i], h: b.height - 0.3, w: b.width * 0.5 }); return out; }
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
function buildingParts(bs) {
  const walls = [], roofs = [], slabs = [], posts = [], edges = [];
  for (const b of bs) {
    const st = b.style || 'box';
    if (st === 'box' || st === 'tank') walls.push({ ...b, h: b.height });
    if (st === 'tank') slabs.push({ poly: b.poly, z: b.height + 0.02, color: [215, 220, 226], base: b.base });
    if (st === 'gable') {
      if (!isRectangular(b.poly)) { walls.push({ ...b, h: b.height }); slabs.push({ poly: b.poly, z: b.height + 0.02, color: b.roof ?? [150, 140, 130], base: b.base }); continue; }
      walls.push({ ...b, h: b.height * 0.72 });
      const rc = b.roof ?? [150, 140, 130], shade = (k) => rc.map((c) => Math.min(255, c * k));
      hipRoof(b).forEach((pts, i) => roofs.push({ pts, color: shade([1, 0.82, 0.9, 0.9][i]), b }));
    }
    if (st === 'frame') { for (let k = 1; k <= b.floors; k++) { const z = k * 3.3; slabs.push({ poly: b.poly, z, color: [190, 190, 188, 205], base: b.base }); edges.push({ path: [...ringAt(b.poly, z), ringAt(b.poly, z)[0]], base: b.base }); } for (const c of columns(b.poly)) posts.push({ pos: c, h: b.floors * 3.3, w: 0.7, color: [175, 175, 172], base: b.base }); }
    if (st === 'canopy') { slabs.push({ poly: b.poly, z: b.height, color: b.color ?? [235, 235, 235], base: b.base }); edges.push({ path: [...ringAt(b.poly, b.height - 0.4), ringAt(b.poly, b.height - 0.4)[0]], base: b.base }); for (const c of columns(b.poly, 9)) posts.push({ pos: c, h: b.height, w: 0.5, color: [200, 200, 200], base: b.base }); }
  }
  return { walls, roofs, slabs, posts, edges };
}
const box = ([x, y], w) => [[x - w / 2, y - w / 2], [x + w / 2, y - w / 2], [x + w / 2, y + w / 2], [x - w / 2, y + w / 2]];

export async function createView3d(container, mapData, src) {
  const data = await (await fetch('/data/customs-3d.json')).json();
  if (data.terrain) H = makeSampler(data.terrain);
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
  const arrowAtlas = await buildAtlas(COLORS.map((c) => [c, arrowDataUrl(c, 64)]), 64);
  for (const m of Object.values(arrowAtlas.mapping)) m.anchorY = 32;
  const chipAtlas = { canvas: iconAtlas.canvas, mapping: Object.fromEntries(Object.entries(iconAtlas.mapping).map(([k, m]) => [k, { ...m, anchorY: 32 }])) };
  let viewState = { target: [0, 0, 0], zoom: 0, rotationX: 62, rotationOrbit: 0, minZoom: -2, maxZoom: 5 };
  let hover = null;

  const lighting = new LightingEffect({
    ambient: new AmbientLight({ color: [255, 255, 255], intensity: 0.85 }),
    sun: new DirectionalLight({ color: [255, 250, 240], intensity: 0.9, direction: [-0.6, -0.4, -1] }),
  });

  const staticLayers = () => [
    ...(data.terrain ? [new PathLayer({ id: 'contours', shadowEnabled: false, data: contours(data.terrain, 2), getPath: (d) => d.path.map((p) => Pg(p, 0.15)), getColor: (d) => (d.lv % 10 === 0 ? [120, 110, 95, 200] : [140, 130, 115, 130]), getWidth: (d) => (d.lv % 10 === 0 ? 0.8 : 0.5), widthUnits: 'meters', widthMinPixels: 1, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN })] : []),
    data.terrain ? new SolidPolygonLayer({ id: 'terrain', shadowEnabled: false, data: terrainQuads(data.terrain, C.land), getPolygon: (d) => d.poly.map(([x, z, y]) => P([x, z], y)), getFillColor: (d) => d.color, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }) : new SolidPolygonLayer({ id: 'land', shadowEnabled: false, data: data.land, getPolygon: ring, getFillColor: C.land, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new SolidPolygonLayer({ id: 'pavement', shadowEnabled: false, data: data.pavement, getPolygon: (d) => ringG(d, 0.08), getFillColor: C.pavement, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new SolidPolygonLayer({ id: 'water', shadowEnabled: false, data: data.water, getPolygon: (d) => ringG(d, 0.06), getFillColor: C.water, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new SolidPolygonLayer({ id: 'underground', shadowEnabled: false, data: data.underground, getPolygon: (d) => ringG(d.poly, 0.1), getFillColor: C.underground, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, pickable: true }),
    new PathLayer({ id: 'rail', shadowEnabled: false, data: data.railway, getPath: (d) => ringG(d.path, 0.15), getColor: C.rail, getWidth: 2, widthUnits: 'meters', widthMinPixels: 1, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new PathLayer({ id: 'roads', shadowEnabled: false, data: data.roads, getPath: (d) => ringG(d.path, 0.12), getColor: (d) => (d.kind === 'highway' ? C.highway : d.kind === 'dirt' ? C.dirt : C.road), getWidth: (d) => d.width, widthUnits: 'meters', widthMinPixels: 1.5, capRounded: true, jointRounded: true, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new PathLayer({ id: 'fences', shadowEnabled: false, data: data.fences, getPath: (d) => ringG(d.path, 0.1), getColor: C.fence, getWidth: 0.6, widthUnits: 'meters', widthMinPixels: 0.5, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new SolidPolygonLayer({ id: 'rocks', shadowEnabled: false, data: data.rocks, getPolygon: (d) => ringG(d, 0), extruded: true, getElevation: 1.2, getFillColor: C.rock, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, material: { ambient: 0.75, diffuse: 0.45, shininess: 8 } }),
    new SolidPolygonLayer({ id: 'trees', shadowEnabled: false, data: data.trees, getPolygon: (d) => ringG(d, 0), extruded: true, getElevation: 3, getFillColor: C.tree, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, material: { ambient: 0.75, diffuse: 0.45, shininess: 4 } }),
  ];
  const floorLines = data.buildings.flatMap((b) => Array.from({ length: Math.max(0, b.floors - 1) }, (_, k) => ({ path: [...ringAt(expand(b.poly, 0.15), (k + 1) * 3.3 + (b.base ?? 0)), ringAt(expand(b.poly, 0.15), (k + 1) * 3.3 + (b.base ?? 0))[0]] })));
  const extraLayers = () => [
    new SolidPolygonLayer({ id: 'shade', shadowEnabled: false, data: data.buildings, getPolygon: (d) => ringG(expand(d.poly, 1.6), 0.05), getFillColor: C.shade, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new SolidPolygonLayer({ id: 'tree-tops', shadowEnabled: false, data: data.trees, getPolygon: (d) => ringG(d, 3.02), getFillColor: C.treeTop, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new SolidPolygonLayer({ id: 'piers', data: (data.bridges || []).flatMap(piers), getPolygon: (d) => box(d.pos, d.w).map(([x, y]) => [x, y, d.pos[2] - d.h]), extruded: true, getElevation: (d) => d.h, getFillColor: C.pier, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, material: { ambient: 0.7, diffuse: 0.5 } }),
    new PathLayer({ id: 'bridge-edges', shadowEnabled: false, data: data.bridges || [], getPath: (d) => bridgePath(d).map((q) => [q[0], q[1], q[2] - 0.15]), getColor: [150, 150, 148], getWidth: (d) => d.width + 1.2, widthUnits: 'meters', widthMinPixels: 2, capRounded: false, jointRounded: true, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new PathLayer({ id: 'bridges', shadowEnabled: false, data: data.bridges || [], getPath: bridgePath, getColor: C.bridge, getWidth: (d) => d.width, widthUnits: 'meters', widthMinPixels: 2, capRounded: false, jointRounded: true, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new PathLayer({ id: 'bridge-rails', shadowEnabled: false, data: (data.bridges || []).flatMap((b) => { const p = bridgePath(b).map((q) => [q[0], q[1], q[2] + 1.1]); return [offsetPath(p, b.width / 2 - 0.3), offsetPath(p, -(b.width / 2 - 0.3))]; }), getPath: (d) => d, getColor: C.bridgeRail, getWidth: 0.4, widthUnits: 'meters', widthMinPixels: 1, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new PathLayer({ id: 'floor-lines', shadowEnabled: false, data: floorLines, getPath: (d) => d.path, getColor: C.floorLine, getWidth: 0.35, widthUnits: 'meters', widthMinPixels: 1, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
  ];
  const parts = buildingParts(data.buildings);
  const buildingLayer = () => [
    new SolidPolygonLayer({
      id: 'buildings', data: parts.walls, getPolygon: (d) => ringAt(d.poly, d.base ?? 0), extruded: true, getElevation: (d) => d.h,
      getFillColor: (d, { index }) => (hover === index ? C.buildingHover : d.color ? d.color : d.kind === 'tank' ? C.tank : d.kind === 'powerline_towers' ? C.tower : d.floors > 1 ? C.buildingMulti : C.building),
      updateTriggers: { getFillColor: hover }, pickable: true, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      material: { ambient: 0.7, diffuse: 0.55, shininess: 12, specularColor: [30, 30, 30] },
      onHover: (i) => { if (i.index !== hover) { hover = i.index; render(); } },
    }),
    new SolidPolygonLayer({ id: 'roofs', data: parts.roofs, getPolygon: (d) => d.pts.map(([x, z, y]) => P([x, z], y + (d.b.base ?? 0))), getFillColor: (d) => d.color, pickable: true, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, material: { ambient: 0.8, diffuse: 0.4 } }),
    new SolidPolygonLayer({ id: 'slabs', shadowEnabled: false, data: parts.slabs, getPolygon: (d) => ringAt(d.poly, d.z + (d.base ?? 0)), getFillColor: (d) => d.color, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new SolidPolygonLayer({ id: 'posts', data: parts.posts, getPolygon: (d) => box(P(d.pos), d.w).map(([x, y]) => [x, y, d.base ?? 0]), extruded: true, getElevation: (d) => d.h, getFillColor: (d) => d.color, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, material: { ambient: 0.7, diffuse: 0.5 } }),
    new PathLayer({ id: 'slab-edges', shadowEnabled: false, data: parts.edges, getPath: (d) => d.path.map((q) => [q[0], q[1], q[2] + (d.base ?? 0)]), getColor: [110, 110, 108], getWidth: 0.3, widthUnits: 'meters', widthMinPixels: 1, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
  ];
  const dynamicLayers = () => {
    const markers = src.markers();
    const players = src.players().filter((p) => p.last);
    return [
      new IconLayer({ id: 'markers-extract', data: markers.filter((d) => d.kind.startsWith('extract')), getPosition: (d) => Pg([d.position.x, d.position.z], 0.5), iconAtlas: iconAtlas.canvas, iconMapping: iconAtlas.mapping, getIcon: (d) => d.kind, getSize: 14, sizeUnits: 'meters', sizeMinPixels: 16, sizeMaxPixels: 32, billboard: true, pickable: true, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
      // everything else lies flat on the ground like chips on a table
      new IconLayer({ id: 'markers-chips', data: markers.filter((d) => !d.kind.startsWith('extract')), getPosition: (d) => Pg([d.position.x, d.position.z], 0.3), iconAtlas: chipAtlas.canvas, iconMapping: chipAtlas.mapping, getIcon: (d) => d.kind, getSize: 5, sizeUnits: 'meters', sizeMinPixels: 8, sizeMaxPixels: 22, billboard: false, pickable: true, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
      new LineLayer({ id: 'label-leaders', data: src.labels(), getSourcePosition: (d) => Pg(d.position, 0), getTargetPosition: (d) => Pg(d.position, 22 * ((d.size ?? 100) / 100)), getColor: [90, 95, 100, 170], getWidth: 1.2, widthUnits: 'pixels', parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
      new TextLayer({ id: 'labels', data: src.labels(), getPosition: (d) => Pg(d.position, 22 * ((d.size ?? 100) / 100)), getText: (d) => d.text, getAlignmentBaseline: 'bottom', getSize: (d) => 9 * ((d.size ?? 100) / 100), sizeUnits: 'meters', sizeMinPixels: 9, sizeMaxPixels: 22, getColor: [50, 55, 60], fontFamily: 'system-ui, sans-serif', fontWeight: 700, outlineWidth: 4, outlineColor: [255, 255, 255, 230], fontSettings: { sdf: true }, billboard: true, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
      new PathLayer({ id: 'trails', data: players.filter((p) => p.trail), getPath: (p) => p.trail.getLatLngs().map((ll) => Pg([ll.lng, ll.lat], 0.3)), getColor: (p) => hex(p.color, 200), getWidth: 1.2, widthUnits: 'meters', widthMinPixels: 2, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
      new LineLayer({ id: 'drop', data: players, getSourcePosition: (p) => Pg([p.last.x, p.last.z], 0), getTargetPosition: (p) => P([p.last.x, p.last.z], Math.max(p.last.y ?? 0, H(p.last.x, p.last.z) + 0.2)), getColor: (p) => hex(p.color, 160), getWidth: 2, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
      new IconLayer({ id: 'players', data: players, getPosition: (p) => P([p.last.x, p.last.z], (p.last.y ?? 0) + 0.2), iconAtlas: arrowAtlas.canvas, iconMapping: arrowAtlas.mapping, getIcon: (p) => p.color, getSize: 12, sizeUnits: 'meters', sizeMinPixels: 22, sizeMaxPixels: 44, billboard: false, getAngle: (p) => -((p.last.yaw ?? 0) + (mapData.coordinateRotation ?? 0)), pickable: true, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, updateTriggers: { getPosition: players.map((p) => p.last), getAngle: players.map((p) => p.last) } }),
      new TextLayer({ id: 'player-names', data: players, getPosition: (p) => P([p.last.x, p.last.z], Math.max((p.last.y ?? 0) + 0.2, H(p.last.x, p.last.z) + 0.3)), getText: (p) => p.name, getPixelOffset: [22, 0], getTextAnchor: 'start', getSize: 13, getColor: [255, 255, 255], outlineWidth: 5, outlineColor: [0, 0, 0, 220], fontSettings: { sdf: true }, fontWeight: 700, billboard: true, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    ];
  };
  const hex = (h, a = 255) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a];

  container.addEventListener('contextmenu', (e) => e.preventDefault()); // right-drag = rotate/tilt, no browser menu
  const deck = new Deck({
    parent: container, views: new OrbitView({ orbitAxis: 'Z', fovy: 22 }), controller: { dragMode: 'pan', inertia: 300 }, // left-drag pans, right/shift-drag rotates
    initialViewState: viewState, effects: [lighting], getCursor: ({ isHovering }) => (isHovering ? 'pointer' : 'grab'),
    onViewStateChange: ({ viewState: v }) => { viewState = v; deck.setProps({ viewState: v }); src.onViewChange?.(v); },
    getTooltip: ({ object, layer }) => {
      if (!object) return null;
      if (layer.id === 'buildings') return { html: `<b>${esc(object.place ?? object.name ?? object.kind)}</b><br>${object.floors} floor${object.floors > 1 ? 's' : ''} · ${object.height} m`, className: 'deck-tooltip' };
      if (layer.id === 'roofs') return { html: `<b>${esc(object.b.place ?? object.b.name ?? object.b.kind)}</b><br>${object.b.floors} floor${object.b.floors > 1 ? 's' : ''} · ${object.b.height} m`, className: 'deck-tooltip' };
      if (layer.id === 'underground') return { html: `<b>${esc(object.name)}</b><br>underground`, className: 'deck-tooltip' };
      if (layer.id === 'markers') return { html: object.html, className: 'deck-tooltip' };
      if (layer.id === 'players') return { html: `<b>${esc(object.name)}</b><br>x ${object.last.x} z ${object.last.z} y ${object.last.y ?? 0}`, className: 'deck-tooltip' };
      return null;
    },
  });
  const base = staticLayers();
  const extras = extraLayers();
  function render() { deck.setProps({ layers: [...base, extras[0], ...buildingLayer(), ...extras.slice(1), ...dynamicLayers()] }); }
  render();
  return {
    refresh: render,
    setView: ({ target, zoom }) => { viewState = { ...viewState, target, zoom }; deck.setProps({ viewState }); },
    deck,
  };
}
