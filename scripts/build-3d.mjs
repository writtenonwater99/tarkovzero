// Build public/data/customs-3d.json from tarkov.dev's Customs SVG (+ floor extents from their maps.json).
// Everything is emitted in GAME coordinates (x, z) so the 3D view shares data with the 2D map.
import { readFile, writeFile } from 'node:fs/promises';

const SVG_URL = 'https://assets.tarkov.dev/maps/svg/Customs.svg';
const BOUNDS = { xMax: 698, xMin: -372, zMin: -307, zMax: 237 }; // tarkov.dev bounds for Customs

let svg;
try { svg = await readFile('.cache/maps/svg/Customs.svg', 'utf8'); } catch { svg = await (await fetch(SVG_URL)).text(); }
const maps = JSON.parse(await readFile('scripts/tarkov-dev-maps.json', 'utf8'));
const props = JSON.parse(await readFile('data/customs-props.json', 'utf8')).props;
const customs = maps.find((m) => m.normalizedName === 'customs').maps[0];
const [, , VW, VH] = svg.match(/viewBox="([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)"/).slice(1).map(Number);
const toGame = ([sx, sy]) => [+(BOUNDS.xMax - (sx / VW) * (BOUNDS.xMax - BOUNDS.xMin)).toFixed(1), +(BOUNDS.zMin + (sy / VH) * (BOUNDS.zMax - BOUNDS.zMin)).toFixed(1)];

// ---- minimal SVG parsing (no deps): groups by id, paths + circles, transforms translate/scale
function* elements(str) { const re = /<(g|path|circle|\/g)\b([^>]*)>/g; let m; while ((m = re.exec(str))) yield { tag: m[1], attrs: m[2] }; }
const attr = (a, n) => { const m = a.match(new RegExp(`\\b${n}="([^"]*)"`)); return m ? m[1] : null; };
function parseTransform(t) {
  let tx = 0, ty = 0, s = 1; if (!t) return { tx, ty, s };
  const tr = t.match(/translate\(([-\d.]+)[ ,]+([-\d.]+)\)/); if (tr) { tx = +tr[1]; ty = +tr[2]; }
  const sc = t.match(/scale\(([-\d.]+)\)/); if (sc) s = +sc[1];
  return { tx, ty, s };
}
// Flatten a path's d into polylines (absolute coords), curves sampled.
function flatten(d) {
  const toks = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g); const polys = []; let poly = null;
  let x = 0, y = 0, sx = 0, sy = 0, cmd = '', i = 0, px = 0, py = 0;
  const num = () => +toks[i++];
  const start = () => { poly = []; polys.push(poly); };
  let lastCurve = false;
  const cubic = (x1, y1, x2, y2, x3, y3) => { lastCurve = true; for (let t = 0.2; t <= 1.001; t += 0.2) { const u = 1 - t; poly.push([u*u*u*x + 3*u*u*t*x1 + 3*u*t*t*x2 + t*t*t*x3, u*u*u*y + 3*u*u*t*y1 + 3*u*t*t*y2 + t*t*t*y3]); } px = x2; py = y2; x = x3; y = y3; };
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase();
    if (!/[csqCSQ]/.test(cmd)) lastCurve = false;
    switch (cmd.toUpperCase()) {
      case 'M': { const nx = num(), ny = num(); x = rel ? x + nx : nx; y = rel ? y + ny : ny; start(); poly.push([x, y]); sx = x; sy = y; px = x; py = y; cmd = rel ? 'l' : 'L'; break; }
      case 'L': { const nx = num(), ny = num(); x = rel ? x + nx : nx; y = rel ? y + ny : ny; poly.push([x, y]); px = x; py = y; break; }
      case 'H': { const nx = num(); x = rel ? x + nx : nx; poly.push([x, y]); px = x; py = y; break; }
      case 'V': { const ny = num(); y = rel ? y + ny : ny; poly.push([x, y]); px = x; py = y; break; }
      case 'C': { let a = [num(), num(), num(), num(), num(), num()]; if (rel) a = [a[0]+x, a[1]+y, a[2]+x, a[3]+y, a[4]+x, a[5]+y]; cubic(...a); break; }
      case 'S': { let a = [num(), num(), num(), num()]; if (rel) a = [a[0]+x, a[1]+y, a[2]+x, a[3]+y]; const wasCurve = lastCurve; cubic(wasCurve ? 2*x - px : x, wasCurve ? 2*y - py : y, ...a); break; }
      case 'Q': { let a = [num(), num(), num(), num()]; if (rel) a = [a[0]+x, a[1]+y, a[2]+x, a[3]+y]; cubic(x + 2/3*(a[0]-x), y + 2/3*(a[1]-y), a[2] + 2/3*(a[0]-a[2]), a[3] + 2/3*(a[1]-a[3]), a[2], a[3]); break; }
      case 'A': { num(); num(); num(); num(); num(); const nx = num(), ny = num(); x = rel ? x + nx : nx; y = rel ? y + ny : ny; poly.push([x, y]); break; }
      case 'Z': { x = sx; y = sy; px = x; py = y; poly = null; if (i < toks.length && !/[a-zA-Z]/.test(toks[i])) { start(); poly.push([x, y]); } break; }
      default: i++;
    }
    if (poly === null && i < toks.length && /[a-zA-Z]/.test(toks[i]) === false) { start(); poly.push([x, y]); }
  }
  return polys.filter((p) => p.length > 1);
}

// Walk the SVG, collecting shapes with their group path and accumulated transform.
const shapes = []; const stack = [];
for (const el of elements(svg)) {
  if (el.tag === 'g') { const t = parseTransform(attr(el.attrs, 'transform')); const parent = stack[stack.length - 1] ?? { ids: [], tx: 0, ty: 0, s: 1 }; stack.push({ ids: [...parent.ids, attr(el.attrs, 'id') || ''], tx: parent.tx + t.tx * parent.s, ty: parent.ty + t.ty * parent.s, s: parent.s * t.s, cls: attr(el.attrs, 'class') || '' }); continue; }
  if (el.tag === '/g') { stack.pop(); continue; }
  const g = stack[stack.length - 1]; if (!g) continue;
  const apply = ([x, y]) => [g.tx + x * g.s, g.ty + y * g.s];
  if (el.tag === 'path') { const d = attr(el.attrs, 'd'); if (!d) continue; for (const poly of flatten(d)) shapes.push({ ids: g.ids, cls: g.cls, pts: poly.map(apply) }); }
  if (el.tag === 'circle') { const cx = +attr(el.attrs, 'cx'), cy = +attr(el.attrs, 'cy'), r = +attr(el.attrs, 'r'); const pts = []; for (let a = 0; a < 16; a++) pts.push(apply([cx + r * Math.cos(a / 16 * 2 * Math.PI), cy + r * Math.sin(a / 16 * 2 * Math.PI)])); shapes.push({ ids: g.ids, cls: g.cls, pts, circle: true }); }
}
const inGroup = (s, id) => s.ids.includes(id);
const ground = shapes.filter((s) => inGroup(s, 'Ground_Level'));
const bbox = (pts) => pts.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
const overlap = (a, b) => { const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1])); return (w * h) / Math.max(1e-6, (a[2]-a[0]) * (a[3]-a[1])); };

// ---- floor slabs from tarkov.dev layer extents (already game coords, [[x,z],[x,z],name])
const floorBoxes = [];
for (const layer of customs.layers) for (const ext of layer.extents) for (const b of ext.bounds) if (b.length === 3) floorBoxes.push({ layer: layer.name, name: b[2], x1: Math.min(b[0][0], b[1][0]), x2: Math.max(b[0][0], b[1][0]), z1: Math.min(b[0][1], b[1][1]), z2: Math.max(b[0][1], b[1][1]), y: ext.height });
const FLOOR_H = 3.3;

// ---- buildings
const defaultHeight = { 'Garages-2': 4, 'Big_Buildings-2': 9, 'Small_Buildings-2': 3.5, 'Powerline_Towers': 22 };
const buildings = [];
for (const s of ground) {
  const grp = Object.keys(defaultHeight).find((k) => inGroup(s, k)); if (!grp) continue;
  const poly = s.pts.map(toGame); const bx = bbox(poly);
  // floors from tarkov.dev extents: count distinct upper layers whose box covers most of this footprint
  const gb = [bx[0], bx[1], bx[2], bx[3]];
  const covering = floorBoxes.filter((f) => !/Underground/i.test(f.layer) && overlap(gb, [f.x1, f.z1, f.x2, f.z2]) > 0.5);
  const topY = covering.reduce((m, f) => Math.max(m, Math.min(f.y[1], f.y[0] + FLOOR_H)), 0);
  const floors = covering.length ? 1 + new Set(covering.map((f) => f.layer)).size : 1;
  const tank = s.circle;
  const height = topY > 0 ? +(topY + 0.5).toFixed(1) : tank ? 6 : defaultHeight[grp];
  buildings.push({ poly, height, floors, kind: tank ? 'tank' : grp.replace(/-2$/, '').toLowerCase(), name: covering[0]?.name ?? null });
}
// ---- underground volumes (bunkers/tunnels) from the Underground extents
const underground = floorBoxes.filter((f) => /Underground/i.test(f.layer)).map((f) => ({ name: f.name, poly: [[f.x1, f.z1], [f.x2, f.z1], [f.x2, f.z2], [f.x1, f.z2]], depth: 4 }));
// ---- other ground features
const polysIn = (id) => ground.filter((s) => inGroup(s, id)).map((s) => s.pts.map(toGame));
const linesIn = (id) => ground.filter((s) => inGroup(s, id)).map((s) => s.pts.map(toGame));
const roads = [
  ...linesIn('High_Roads').map((p) => ({ path: p, width: 12, kind: 'highway' })),
  ...linesIn('Main_Roads').map((p) => ({ path: p, width: 8, kind: 'main' })),
  ...linesIn('Roads').map((p) => ({ path: p, width: 5, kind: 'small' })),
  ...linesIn('Dirt_Roads').map((p) => ({ path: p, width: 5, kind: 'dirt' })),
];
// ---- tag buildings with the nearest place label (for colours / tooltips)
const labels = JSON.parse(await readFile('src/labels.js', 'utf8').then((t) => t.slice(t.indexOf('['), t.lastIndexOf(']') + 1)));
const centroid = (poly) => poly.reduce((a, p) => [a[0] + p[0] / poly.length, a[1] + p[1] / poly.length], [0, 0]);
for (const b of buildings) {
  const c = centroid(b.poly);
  let best = null, bd = 45;
  for (const l of labels) { const d = Math.hypot(l.position[0] - c[0], l.position[1] - c[1]); if (d < bd) { bd = d; best = l.text; } }
  if (best) b.place = best;
}
// ---- bridges: parts of roads/rail that run over water become elevated decks
const inPoly = ([x, z], poly) => { let inside = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, zi] = poly[i], [xj, zj] = poly[j]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside; } return inside; };
const overWater = (pt) => out0.water.some((w) => inPoly(pt, w));
const resample = (path, step) => { const r = [path[0]]; for (let i = 1; i < path.length; i++) { const [ax, az] = path[i - 1], [bx, bz] = path[i]; const L = Math.hypot(bx - ax, bz - az); for (let t = step; t < L; t += step) r.push([ax + ((bx - ax) * t) / L, az + ((bz - az) * t) / L]); r.push(path[i]); } return r; };
const out0 = { water: polysIn('River') };
const bridges = [];
for (const r of [...roads.map((r) => ({ ...r, cls: 'road' })), ...linesIn('Railway').map((p) => ({ path: p, width: 3, kind: 'rail', cls: 'rail' }))]) {
  const pts = resample(r.path, 3); let run = [];
  const flush = () => { if (run.length >= 3) { const i0 = pts.indexOf(run[0]), i1 = pts.indexOf(run[run.length - 1]); const span = pts.slice(Math.max(0, i0 - 5), Math.min(pts.length, i1 + 6)); bridges.push({ path: span, width: r.width, kind: r.kind, height: r.kind === 'rail' ? 8 : 6.5 }); } run = []; };
  for (const p of pts) { if (overWater(p)) run.push(p); else flush(); }
  flush();
}
// ---- playable boundary = the SVG 'Limit' (= ground polygon). Clip linear features to it; drop anything outside.
const LIMIT = polysIn('Ground')[0];
const inside = (pt) => inPoly(pt, LIMIT);
function clipPath(path, step = 3) { const out = []; let run = []; for (const q of resample(path, step)) { if (inside(q)) run.push(q); else { if (run.length >= 2) out.push(run); run = []; } } if (run.length >= 2) out.push(run); return out; }
const clipLines = (items) => items.flatMap((it) => clipPath(it.path).map((path) => ({ ...it, path })));
// keep real crossings only: no dirt tracks (swamp), and merge overlapping road paths
const mid = (b) => b.path[Math.floor(b.path.length / 2)];
const kept = [];
const PRI = { highway: 0, main: 1, small: 2, rail: 0 };
for (const b of bridges.filter((b) => b.kind !== 'dirt').sort((a, c) => PRI[a.kind] - PRI[c.kind] || c.path.length - a.path.length)) {
  const m = mid(b);
  if (!kept.some((k) => Math.hypot(mid(k)[0] - m[0], mid(k)[1] - m[1]) < 20)) kept.push(b);
}
bridges.length = 0;
// In-game river crossings (per playtest): Main Bridge (highway deck), Junk Bridge (foot bridge at the label, drawn as
// pavement in the SVG), and a ground-level path just north of Main Bridge. Every other crossing is outside the playable area.
const mainBridge = kept.find((b) => b.kind === 'highway');
if (mainBridge) bridges.push({ ...mainBridge, name: 'Main Bridge' });
const ford = kept.find((b) => Math.hypot(mid(b)[0] + 84, mid(b)[1] + 74) < 25);
if (ford) bridges.push({ ...ford, name: 'River path', ford: true, height: 0.4, width: 3 });
bridges.push({ name: 'Junk Bridge', kind: 'foot', foot: true, path: resample([[-68.5, 39.4], [-90.7, 39.4]], 3), width: 3, height: 2.5 });
// flat roads: drop the parts that are carried by a bridge deck, and pieces over water without a real crossing; clip to limit
const nearBridge = (pt) => bridges.some((b) => b.path.some((q) => Math.hypot(q[0] - pt[0], q[1] - pt[1]) < 4));
const roadsCut = [];
for (const r of roads) {
  const pts = resample(r.path, 3); let run = [];
  const flushRun = () => { if (run.length >= 2) roadsCut.push({ ...r, path: run }); run = []; };
  for (const q of pts) { if (nearBridge(q) && overWater(q)) flushRun(); else run.push(q); }
  flushRun();
}
const realCrossing = (q) => bridges.some((b) => b.path.some((p) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 8));
roads.length = 0; roads.push(...clipLines(roadsCut.filter((r) => !r.path.some((q) => overWater(q) && !realCrossing(q)))));
// 'small' roads are only paved where they serve an industrial yard (touch pavement or a building); elsewhere they are trails
const pav = polysIn('Pavement');
const nearPaved = (q) => pav.some((pp) => inPoly(q, pp)) || buildings.some((b) => { const c = centroid(b.poly); return Math.hypot(c[0] - q[0], c[1] - q[1]) < 25; });
for (const r of roads) {
  if (r.kind !== 'small') continue;
  const hits = r.path.filter(nearPaved).length;
  if (hits / r.path.length < 0.35) { r.kind = 'track'; r.width = 2.2; }
}
console.log(`roads: ${JSON.stringify(roads.reduce((a, r) => ((a[r.kind] = (a[r.kind] || 0) + 1), a), {}))}`);
// fences: clip to limit and open a gap where a road crosses (gates)
const fenceLines = linesIn('Fence').flatMap((p) => clipPath(p, 2));
const fencesCut = [];
for (const f of fenceLines) {
  const pts = resample(f, 2); let run = [];
  const flushF = () => { if (run.length >= 2) fencesCut.push({ path: run }); run = []; };
  for (const q of pts) { const onRoad = roads.some((r) => r.path.some((rp) => Math.hypot(rp[0] - q[0], rp[1] - q[1]) < r.width / 2 + 1.5)); if (onRoad) flushF(); else run.push(q); }
  flushF();
}
const PLACE_COLORS = { 'Big Red': [200, 60, 55], 'Crackhouse': [120, 88, 66], 'Dorms 2-Story': [214, 190, 160], 'Dorms 3-Story': [214, 190, 160], 'New Gas': [235, 235, 235], 'Old Gas': [190, 190, 185], 'Fortress': [180, 180, 178], 'Skeleton': [176, 176, 176], 'Repair Shop': [140, 160, 185], 'Warehouse 3': [150, 165, 185], 'Warehouse 4': [150, 165, 185], 'Warehouse 7': [150, 165, 185], 'Warehouse 17': [150, 165, 185], 'Depot': [165, 170, 178], 'Boiler': [170, 110, 90], 'Oil Rig': [160, 120, 95], 'Streamer House': [120, 95, 70], 'Bus Station': [235, 235, 232], 'Storage': [170, 175, 180], 'Powerline Tower': [150, 150, 150], 'Water Pump': [160, 170, 180], 'Military Checkpoint': [175, 180, 170] };
for (const b of buildings) if (b.place && PLACE_COLORS[b.place]) b.color = PLACE_COLORS[b.place];
// building identity: how each landmark is drawn (frame = unfinished concrete skeleton, gable = pitched roof, canopy = roof on posts)
const ROOF_COLORS = { 'Warehouse 3': [118, 134, 156], 'Warehouse 4': [118, 134, 156], 'Warehouse 7': [118, 134, 156], 'Warehouse 17': [118, 134, 156], 'Depot': [125, 130, 140], 'Storage': [130, 135, 142], 'Crackhouse': [96, 72, 56], 'Streamer House': [96, 72, 56], 'Repair Shop': [110, 125, 145], 'Boiler': [130, 85, 70] };
const PLACE_STYLE = { 'Skeleton': 'frame', 'Old Construction': 'frame', 'Crackhouse': 'gable', 'Streamer House': 'gable', 'Repair Shop': 'gable', 'Warehouse 3': 'gable', 'Warehouse 4': 'gable', 'Warehouse 7': 'gable', 'Warehouse 17': 'gable', 'Depot': 'gable', 'Boiler': 'gable', 'Storage': 'gable', 'New Gas': 'canopy', 'Old Gas': 'canopy', 'Bus Station': 'canopy' };
const area = (poly) => Math.abs(poly.reduce((a, [x, z], i) => { const [nx, nz] = poly[(i + 1) % poly.length]; return a + x * nz - nx * z; }, 0)) / 2;
for (const b of buildings) {
  const st = b.place && PLACE_STYLE[b.place];
  if (!st) { b.style = b.kind === 'tank' ? 'tank' : 'box'; continue; }
  const siblings = buildings.filter((o) => o.place === b.place);
  const largest = siblings.reduce((m, o) => (area(o.poly) > area(m.poly) ? o : m), siblings[0]);
  // canopy/frame apply to the main footprint only; smaller side buildings stay boxes
  b.style = (st === 'canopy' || st === 'frame') && b !== largest ? 'box' : st;
  if (b.style === 'frame' && b.floors < 2) b.floors = 2;
  if (b.style === 'frame') b.height = Math.max(b.height, b.floors * 3.3);
  if (b.style === 'canopy') b.height = 4.8;
  if (b.style === 'gable' && ROOF_COLORS[b.place]) b.roof = ROOF_COLORS[b.place];
}
// ---- terrain: true-to-scale height grid from SPT spawn points (ground-level ones only), IDW + smoothing
const spt = JSON.parse(await readFile('scripts/spt-bigmap-base.json', 'utf8'));
const groundPts = spt.SpawnPointParams.map((s) => ({ x: s.Position.x, z: s.Position.z, y: s.Position.y, zone: s.BotZoneName || '' })).filter((p) => p.y < 15 && p.y > -6 && !/snipe/i.test(p.zone));
// Hand-authored relief for hills the spawn points under-sample (approximate real heights, metres). Tune here.
const TERRAIN_FEATURES = [
  { name: 'west hill (behind Big Red, up to Crossroads)', x: -360, z: -80, rx: 95, rz: 150, h: 11 },
  { name: 'Sniper Hill', x: 110, z: 85, rx: 45, rz: 40, h: 9 },
  { name: 'south rise (Old Road)', x: 230, z: 215, rx: 160, rz: 60, h: 8 },
  { name: 'SE ridge (Sniper Ridge / checkpoint)', x: 540, z: 150, rx: 150, rz: 70, h: 10 },
  { name: 'north bank above river', x: -60, z: -250, rx: 120, rz: 45, h: 6 },
];
const STEP = 10, x0 = BOUNDS.xMin - 40, z0 = BOUNDS.zMin - 40, cols = Math.ceil((BOUNDS.xMax - BOUNDS.xMin + 80) / STEP) + 1, rows = Math.ceil((BOUNDS.zMax - BOUNDS.zMin + 80) / STEP) + 1;
// deterministic value noise so hills are irregular instead of perfect ellipses
const hash2 = (i, j) => { const n = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return n - Math.floor(n); };
const noise = (x, z) => { const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j, sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz); return (hash2(i, j) * (1 - sx) + hash2(i + 1, j) * sx) * (1 - sz) + (hash2(i, j + 1) * (1 - sx) + hash2(i + 1, j + 1) * sx) * sz; };
const raw = new Float32Array(cols * rows);
for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
  const x = x0 + c * STEP, z = z0 + r * STEP; let num = 0, den = 0;
  const n1 = noise(x / 90, z / 90) - 0.5, n2 = noise(x / 35 + 7, z / 35 + 3) - 0.5;
  for (const p of groundPts) { const d2 = (p.x - x) ** 2 + (p.z - z) ** 2; const w = 1 / Math.pow(d2 + 144, 1.5); num += w * p.y; den += w; } // ~12 m softening, steeper falloff
  let h = num / den;
  for (const f of TERRAIN_FEATURES) { const d = ((x - f.x) / (f.rx * (1 + 0.35 * n1))) ** 2 + ((z - f.z) / (f.rz * (1 - 0.3 * n1))) ** 2; const bump = f.h * Math.exp(-d * 1.6) * (1 + 0.15 * n2); h = Math.max(h, bump); }
  h += 0.6 * n2 + 0.4 * n1; // gentle undulation everywhere
  raw[r * cols + c] = h;
}
// one light smoothing pass
const heights = new Float32Array(cols * rows);
for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { let sum = 0, n = 0; for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { const rr = r + dr, cc = c + dc; if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) { sum += raw[rr * cols + cc]; n++; } } heights[r * cols + c] = +(sum / n).toFixed(2); }
const terrain = { x0, z0, step: STEP, cols, rows, heights: Array.from(heights) };
console.log(`props ${props.length}`);
console.log(`terrain ${cols}x${rows} @${STEP}m from ${groundPts.length} points, range ${Math.min(...heights).toFixed(1)}..${Math.max(...heights).toFixed(1)} m`);
const out = {
  props, terrain, bridges, limit: LIMIT,
  map: 'customs', builtAt: new Date().toISOString(), source: 'tarkov.dev SVG (CC BY-NC-SA) + tarkov.dev maps.json floor extents',
  land: polysIn('Ground'), water: polysIn('River'), pavement: polysIn('Pavement'), trees: polysIn('Trees'), rocks: polysIn('Rocks'),
  roads, railway: clipLines(linesIn('Railway').map((p) => ({ path: p }))), fences: fencesCut, powerlines: clipLines(linesIn('Powerlines').map((p) => ({ path: p }))),
  buildings, underground, floorBoxes,
};
await writeFile('public/data/customs-3d.json', JSON.stringify(out));
const multi = buildings.filter((b) => b.floors > 1);
console.log(`styles: ${JSON.stringify(buildings.reduce((a, b) => ((a[b.style] = (a[b.style] || 0) + 1), a), {}))}`);
console.log(`bridges ${bridges.length} (${bridges.map((b) => (b.name || b.kind) + (b.ford ? ' [ford]' : '')).join(', ')}), named ${buildings.filter((b) => b.place).length}, coloured ${buildings.filter((b) => b.color).length}`);
console.log(`buildings ${buildings.length} (multi-floor ${multi.length}: ${multi.map((b) => `${b.name}×${b.floors}`).join(', ')}), trees ${out.trees.length}, rocks ${out.rocks.length}, roads ${roads.length}, water ${out.water.length}, land ${out.land.length} → public/data/customs-3d.json (${(JSON.stringify(out).length / 1024).toFixed(0)} KB)`);
