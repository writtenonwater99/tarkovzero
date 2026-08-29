// Build public/data/<map>-3d.json from a tarkov.dev SVG and floor extents.
// Everything is emitted in GAME coordinates (x, z) so the 3D view shares data with the 2D map.
import { readFile, writeFile } from 'node:fs/promises';
import { LABELS } from '../src/labels.js';

const CUSTOMS_COLORS = { 'Big Red': [142, 58, 50], 'Crackhouse': [139, 110, 90], 'Dorms 2-Story': [185, 169, 143], 'Dorms 3-Story': [185, 169, 143], 'New Gas': [196, 191, 180], 'Old Gas': [150, 146, 134], 'Fortress': [162, 158, 148], 'Skeleton': [162, 158, 148], 'Repair Shop': [138, 140, 136], 'Warehouse 3': [138, 140, 136], 'Warehouse 4': [138, 140, 136], 'Warehouse 7': [138, 140, 136], 'Warehouse 17': [138, 140, 136], 'Depot': [146, 142, 132], 'Boiler': [150, 130, 118], 'Oil Rig': [146, 138, 124], 'Streamer House': [139, 110, 90], 'Bus Station': [176, 172, 160], 'Storage': [144, 146, 142], 'Powerline Tower': [126, 126, 122], 'Water Pump': [140, 148, 152], 'Military Checkpoint': [160, 156, 146] };
const CUSTOMS_ROOFS = { 'Warehouse 3': [92, 102, 106], 'Warehouse 4': [92, 102, 106], 'Warehouse 7': [92, 102, 106], 'Warehouse 17': [92, 102, 106], 'Depot': [98, 100, 102], 'Storage': [96, 99, 100], 'Crackhouse': [126, 76, 52], 'Streamer House': [126, 76, 52], 'Repair Shop': [92, 102, 106], 'Boiler': [104, 96, 88] };
const CUSTOMS_STYLES = { 'Skeleton': 'frame', 'Old Construction': 'frame', 'Crackhouse': 'gable', 'Streamer House': 'gable', 'Repair Shop': 'gable', 'Warehouse 3': 'gable', 'Warehouse 4': 'gable', 'Warehouse 7': 'gable', 'Warehouse 17': 'gable', 'Depot': 'gable', 'Boiler': 'gable', 'Storage': 'gable', 'New Gas': 'canopy', 'Old Gas': 'canopy', 'Bus Station': 'canopy' };
const CONFIG = {
  customs: {
    svgName: 'Customs', svgUrl: 'https://assets.tarkov.dev/maps/svg/Customs.svg', maps: 'scripts/tarkov-dev-maps.json',
    props: 'data/customs-props.json', roads: 'data/customs-roads.json', spt: 'scripts/spt-bigmap-base.json',
    bounds: { xMax: 698, xMin: -372, zMin: -307, zMax: 237 }, base: 'Ground_Level',
    groups: { land: 'Ground', limit: 'Ground', water: 'River', pavement: 'Pavement', trees: 'Trees', rocks: 'Rocks', railway: 'Railway', fence: 'Fence', powerlines: 'Powerlines' },
    roadGroups: [['High_Roads', 12, 'highway'], ['Main_Roads', 8, 'main'], ['Roads', 5, 'small'], ['Dirt_Roads', 5, 'dirt']],
    buildingHeights: { 'Garages-2': 4, 'Big_Buildings-2': 9, 'Small_Buildings-2': 3.5, 'Powerline_Towers': 22 },
    underground: /Underground/i, colors: CUSTOMS_COLORS, roofs: CUSTOMS_ROOFS, styles: CUSTOMS_STYLES, autoSmallTracks: true,
    terrainFilter: (p) => p.y < 15 && p.y > -6 && !/snipe/i.test(p.zone),
    terrain: [
      { name: 'west hill (behind Big Red, up to Crossroads)', x: -360, z: -80, rx: 95, rz: 150, h: 11 },
      { name: 'Sniper Hill', x: 110, z: 85, rx: 45, rz: 40, h: 9 },
      { name: 'south rise (Old Road)', x: 230, z: 215, rx: 160, rz: 60, h: 8 },
      { name: 'SE ridge (Sniper Ridge / checkpoint)', x: 540, z: 150, rx: 150, rz: 70, h: 10 },
      { name: 'north bank above river', x: -60, z: -250, rx: 120, rz: 45, h: 6 },
    ],
  },
  reserve: {
    svgName: 'Reserve', svgUrl: 'https://assets.tarkov.dev/maps/svg/Reserve.svg', maps: 'scripts/data/reserve/maps-entry.json',
    props: 'data/reserve-props.json', roads: 'data/reserve-roads.json', spt: 'scripts/data/reserve/spt-base.json',
    bounds: { xMax: 289, xMin: -303, zMin: -274, zMax: 272 }, base: 'Ground_Level',
    groups: { land: 'Terrains', limit: 'Terrains', water: null, pavement: 'Concrete', trees: 'Trees', rocks: 'Rocks', railway: 'Railroad', fence: 'Fences_int', powerlines: null },
    roadGroups: [['Roads', 7, 'main'], ['Dirty_roads', 4, 'dirt']],
    buildingHeights: { Buildings: 8, Bunker_entr: 3 }, underground: /Bunkers/i, undergroundSvg: 'Bunkers',
    colors: { 'White Pawn': [180, 174, 158], 'Black Pawn': [136, 126, 116], 'White Bishop': [184, 179, 166], 'Black Bishop': [138, 128, 118], 'White King': [154, 153, 145], 'White Knight': [156, 158, 151], 'Black Knight': [124, 126, 122], 'White Rook / Train Station': [174, 166, 143], 'White Queen / Dome': [184, 184, 176], 'Military Guard Barracks': [142, 136, 124] },
    roofs: { 'White Pawn': [112, 92, 78], 'Black Pawn': [92, 82, 74], 'White Rook / Train Station': [92, 98, 96], 'White Queen / Dome': [132, 134, 132] },
    styles: { 'White Rook / Train Station': 'gable' },
    terrainFilter: (p) => p.y > -9 && !/ZoneSub(Command|Storage)/i.test(p.zone) && !/snipe/i.test(p.zone),
    terrain: [
      { name: 'Dome summit', x: -8, z: 183, rx: 72, rz: 62, h: 20 },
      { name: 'Dome approach ridge', x: -55, z: 125, rx: 115, rz: 70, h: 11 },
      { name: 'east mountain shoulder', x: -210, z: 55, rx: 85, rz: 190, h: 10 },
      { name: 'south rocky boundary', x: -80, z: 245, rx: 190, rz: 42, h: 14 },
    ],
  },
  woods: {
    svgName: 'Woods', svgUrl: 'https://assets.tarkov.dev/maps/svg/Woods.svg', maps: 'scripts/data/woods/maps-entry.json',
    props: 'data/woods-props.json', roads: 'data/woods-roads.json', spt: 'scripts/data/woods/spt-base.json',
    bounds: { xMax: 646, xMin: -761, zMin: -914, zMax: 442 }, base: 'Ground_Level',
    groups: { land: 'Base_Terrain', limit: 'Base_Terrain', water: 'Water', pavement: null, trees: null, rocks: 'Rocks', railway: 'Railroad', fence: 'Fences', powerlines: 'Power_Line', plane: 'Plane', pier: 'Pier', minefield: 'Minefield' },
    roadGroups: [['Roads', 6, 'main'], ['Small Roads', 4, 'small'], ['Dirt_Roads', 3.5, 'dirt']],
    buildingHeights: { Buildings: 4 }, underground: /$a/,
    colors: { Sawmill: [144, 139, 124], 'Old Sawmill': [128, 112, 94], 'Scav Town': [154, 143, 124], 'Scav House': [156, 119, 83], 'USEC CAMP': [108, 116, 96], 'Military Camp': [146, 148, 136], 'Sunken Village / Abandoned Village': [126, 112, 91] },
    roofs: { Sawmill: [88, 94, 92], 'Old Sawmill': [104, 82, 66], 'Scav Town': [110, 84, 66], 'Scav House': [132, 74, 57] },
    styles: { Sawmill: 'gable', 'Old Sawmill': 'gable', 'Scav Town': 'gable', 'Scav House': 'gable', 'Sunken Village / Abandoned Village': 'gable', 'USEC CAMP': 'gable', 'Military Camp': 'gable', Shack: 'gable', "Jaeger's Camp": 'gable' }, autoSmallTracks: true,
    labelRadius: 80,
    extraBuildings: [
      ...[[583.4,97], [520.5,-33.2], [450.3,-160.1], [354.8,-268], [250.6,-368.8], [116.3,-405.4], [-27.4,-424.5], [-160.5,-478.7], [-286.2,-550.7]].map(([x, z]) => ({ poly: [[x-2,z-2], [x+2,z-2], [x+2,z+2], [x-2,z+2]], height: 20, floors: 1, kind: 'powerline_towers', name: 'power pylon' })),
    ],
    proceduralTrees: true,
    terrainFilter: (p) => p.y > -25 && p.y < 55 && !/snipe/i.test(p.zone) && !/Zone(?:Big|High)Rocks/i.test(p.zone),
    rockEvidence: /Zone(?:Big|High)Rocks/i,
    terrain: [
      { name: 'Sniper Rock ground shoulder', x: 85, z: -147, rx: 95, rz: 90, h: 14 },
      { name: 'USEC ridge', x: 290, z: -475, rx: 165, rz: 105, h: 26 },
      { name: 'Scav Bunker ridge', x: 200, z: -724, rx: 180, rz: 100, h: 22 },
      { name: 'west ZB low ridge', x: 470, z: 40, rx: 150, rz: 260, h: -4 },
      { name: 'central west hills', x: -260, z: -30, rx: 220, rz: 175, h: 16 },
      { name: 'north village shoulder', x: -470, z: -340, rx: 190, rz: 170, h: 18 },
      { name: 'military camp low rise', x: -188, z: 235, rx: 180, rz: 120, h: 0 },
    ],
  },
};

const key = (process.argv.slice(2).find((a) => !a.startsWith('-')) || 'customs').toLowerCase();
const cfg = CONFIG[key];
if (!cfg) throw new Error(`unknown map ${key}; expected ${Object.keys(CONFIG).join(', ')}`);
const BOUNDS = cfg.bounds;

let svg;
try { svg = await readFile(`.cache/maps/svg/${cfg.svgName}.svg`, 'utf8'); } catch { svg = await (await fetch(cfg.svgUrl)).text(); }
const maps = JSON.parse(await readFile(cfg.maps, 'utf8'));
const props = JSON.parse(await readFile(cfg.props, 'utf8')).props;
const roadEdits = JSON.parse(await readFile(cfg.roads, 'utf8'));
const extraRoads = roadEdits.add;
const mapFamily = Array.isArray(maps) ? maps.find((m) => m.normalizedName === key) : maps;
const mapEntry = mapFamily.maps.find((m) => m.key === key);
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
const ground = shapes.filter((s) => inGroup(s, cfg.base));
const bbox = (pts) => pts.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
const overlap = (a, b) => { const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1])); return (w * h) / Math.max(1e-6, (a[2]-a[0]) * (a[3]-a[1])); };

// ---- floor slabs from tarkov.dev layer extents (already game coords, [[x,z],[x,z],name])
const floorBoxes = [];
for (const layer of mapEntry.layers || []) for (const ext of layer.extents) for (const b of ext.bounds) if (b.length === 3) floorBoxes.push({ layer: layer.name, name: b[2], x1: Math.min(b[0][0], b[1][0]), x2: Math.max(b[0][0], b[1][0]), z1: Math.min(b[0][1], b[1][1]), z2: Math.max(b[0][1], b[1][1]), y: ext.height });
const FLOOR_H = 3.3;

// ---- buildings
const defaultHeight = cfg.buildingHeights;
const buildings = [];
for (const s of ground) {
  const grp = Object.keys(defaultHeight).find((k) => inGroup(s, k)); if (!grp) continue;
  const poly = s.pts.map(toGame); const bx = bbox(poly);
  // floors from tarkov.dev extents: count distinct upper layers whose box covers most of this footprint
  const gb = [bx[0], bx[1], bx[2], bx[3]];
  const covering = floorBoxes.filter((f) => !cfg.underground.test(f.layer) && overlap(gb, [f.x1, f.z1, f.x2, f.z2]) > 0.5);
  const topY = covering.reduce((m, f) => Math.max(m, Math.min(f.y[1], f.y[0] + FLOOR_H)), 0);
  const floors = covering.length ? 1 + new Set(covering.map((f) => f.layer)).size : 1;
  const tank = s.circle;
  const height = topY > 0 ? +(topY + 0.5).toFixed(1) : tank ? 6 : defaultHeight[grp];
  const building = { poly, height, floors, kind: tank ? 'tank' : grp.replace(/-2$/, '').toLowerCase(), name: covering[0]?.name ?? null };
  // Reserve floor extents are absolute game Y (the rail yard itself is around -7 m),
  // unlike Customs' legacy relative-height interpretation. Retain the authoritative top
  // until the terrain grid exists, then convert it to a height above the local ground.
  if (key !== 'customs' && covering.length) building._topY = Math.max(...covering.map((f) => f.y[1]));
  buildings.push(building);
}
for (const b of cfg.extraBuildings || []) buildings.push(structuredClone(b));
// ---- underground volumes. Reserve's source SVG contains the real tunnel
// silhouettes; its floor extents are deliberately broad interaction boxes and
// made the old U view look like seven unrelated rectangles.
const undergroundBoxes = floorBoxes.filter((f) => cfg.underground.test(f.layer)).map((f) => ({ name: f.name, poly: [[f.x1, f.z1], [f.x2, f.z1], [f.x2, f.z2], [f.x1, f.z2]], depth: 4 }));
const undergroundPolys = cfg.undergroundSvg ? shapes.filter((s) => inGroup(s, cfg.undergroundSvg)).map((s) => s.pts.map(toGame)) : [];
const underground = undergroundPolys.length ? undergroundPolys.map((poly) => {
  const z = poly.reduce((sum, p) => sum + p[1] / poly.length, 0);
  return { name: z < -60 ? 'Storage Bunker Tunnels' : 'Command Bunker Tunnels', poly, depth: 4 };
}) : undergroundBoxes;
// ---- other ground features
const polysIn = (id) => ground.filter((s) => inGroup(s, id)).map((s) => s.pts.map(toGame));
const linesIn = (id) => ground.filter((s) => inGroup(s, id)).map((s) => s.pts.map(toGame));
const svgProps = [
  ...(cfg.groups.plane ? polysIn(cfg.groups.plane).map((poly, i) => ({ type: 'plane', name: i ? 'Crash-site wing' : 'Crash-site fuselage', poly, h: i ? 0.8 : 2.2, color: [112, 116, 112] })) : []),
  ...(cfg.groups.pier ? polysIn(cfg.groups.pier).map((poly) => ({ type: 'pier', name: 'Wooden pier', poly, h: 0.35, color: [114, 96, 70] })) : []),
];
const roads = [
  ...extraRoads.map((r) => ({ ...r, path: r.path.map(([x, z]) => [x, z]) })),
  ...cfg.roadGroups.flatMap(([group, width, kind]) => linesIn(group).map((path) => ({ path, width, kind }))),
];
// ---- tag buildings with the nearest place label (for colours / tooltips)
// Underground-only callouts describe tunnel connections, not the surface
// footprints above them, and must not steal chess-building colours/styles.
const labels = LABELS[key].filter((l) => l.floor !== 'U');
const centroid = (poly) => poly.reduce((a, p) => [a[0] + p[0] / poly.length, a[1] + p[1] / poly.length], [0, 0]);
for (const b of buildings) {
  const c = centroid(b.poly);
  let best = null, bd = cfg.labelRadius ?? 45;
  for (const l of labels) { const d = Math.hypot(l.position[0] - c[0], l.position[1] - c[1]); if (d < bd) { bd = d; best = l.text; } }
  if (best) b.place = best;
}
// ---- bridges: parts of roads/rail that run over water become elevated decks
const inPoly = ([x, z], poly) => { let inside = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, zi] = poly[i], [xj, zj] = poly[j]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside; } return inside; };
const overWater = (pt) => out0.water.some((w) => inPoly(pt, w));
const resample = (path, step) => { const r = [path[0]]; for (let i = 1; i < path.length; i++) { const [ax, az] = path[i - 1], [bx, bz] = path[i]; const L = Math.hypot(bx - ax, bz - az); for (let t = step; t < L; t += step) r.push([ax + ((bx - ax) * t) / L, az + ((bz - az) * t) / L]); r.push(path[i]); } return r; };
const out0 = { water: cfg.groups.water ? polysIn(cfg.groups.water) : [] };
const bridges = [];
for (const r of [...roads.map((r) => ({ ...r, cls: 'road' })), ...(cfg.groups.railway ? linesIn(cfg.groups.railway) : []).map((p) => ({ path: p, width: 3, kind: 'rail', cls: 'rail' }))]) {
  const pts = resample(r.path, 3); let run = [];
  const flush = () => { if (run.length >= 3) { const i0 = pts.indexOf(run[0]), i1 = pts.indexOf(run[run.length - 1]); const span = pts.slice(Math.max(0, i0 - 5), Math.min(pts.length, i1 + 6)); bridges.push({ path: span, width: r.width, kind: r.kind, height: r.kind === 'rail' ? 8 : 6.5 }); } run = []; };
  for (const p of pts) { if (overWater(p)) run.push(p); else flush(); }
  flush();
}
// ---- playable boundary = the SVG 'Limit' (= ground polygon). Clip linear features to it; drop anything outside.
const LIMIT = polysIn(cfg.groups.limit)[0];
if (!LIMIT) throw new Error(`${key}: no playable limit from SVG group ${cfg.groups.limit}`);
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
if (key === 'customs') {
  // Confirmed Customs crossings: Main Bridge, the shallow river path, and Junk Bridge footbridge.
  const mainBridge = kept.find((b) => b.kind === 'highway');
  if (mainBridge) bridges.push({ ...mainBridge, name: 'Main Bridge' });
  const ford = kept.find((b) => Math.hypot(mid(b)[0] + 84, mid(b)[1] + 74) < 25);
  if (ford) bridges.push({ ...ford, name: 'River path', ford: true, height: 0.4, width: 3 });
  bridges.push({ name: 'Junk Bridge', kind: 'foot', foot: true, path: resample([[-68.5, 39.4], [-90.7, 39.4]], 3), width: 3, height: 2.5 });
}
if (key === 'woods') {
  // All and only the three current edge crossings documented by the Wiki and visible
  // in the SVG/satellite: paid road bridge, co-op bridge, and the eastern rail deck.
  const crossing = (at, kind) => kept.filter((b) => !kind || b.kind === kind).sort((a, b) => Math.hypot(mid(a)[0] - at[0], mid(a)[1] - at[1]) - Math.hypot(mid(b)[0] - at[0], mid(b)[1] - at[1]))[0];
  const vehicle = crossing([-505, -530], 'main');
  const friendship = crossing([74, -876], 'main');
  const railway = crossing([-760, 118], 'rail');
  if (vehicle) bridges.push({ ...vehicle, name: 'Bridge V-Ex', height: 4.5 });
  if (friendship) bridges.push({ ...friendship, name: 'Friendship Bridge', height: 4.0 });
  if (railway) bridges.push({ ...railway, name: 'Railway Bridge to Tarkov', height: 5.0 });
}
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
const pav = cfg.groups.pavement ? polysIn(cfg.groups.pavement) : [];
const nearPaved = (q) => pav.some((pp) => inPoly(q, pp)) || buildings.some((b) => { const c = centroid(b.poly); return Math.hypot(c[0] - q[0], c[1] - q[1]) < 25; });
for (const r of roads) {
  if (!cfg.autoSmallTracks || r.kind !== 'small' || r.fixed) continue;
  const hits = r.path.filter(nearPaved).length;
  if (hits / r.path.length < 0.35) { r.kind = 'track'; r.width = 2.2; }
}
// audited edits: reclassify / remove roads by nearest midpoint (from data/customs-roads.json)
const midOf = (path) => path[Math.floor(path.length / 2)];
const nearestRoad = (pt) => roads.reduce((best, r) => { const m = midOf(r.path); const d = Math.hypot(m[0] - pt[0], m[1] - pt[1]); return d < best.d ? { d, r } : best; }, { d: Infinity, r: null });
for (const e of roadEdits.reclassify || []) { const n = nearestRoad(e.mid); if (n.r && n.d < 60) { n.r.kind = e.to; n.r.fixed = true; if (e.to === 'dirt' || e.to === 'track') n.r.width = e.to === 'dirt' ? 3.5 : 2.2; } }
for (const e of roadEdits.remove || []) { const n = nearestRoad(e.mid); if (n.r && n.d < 40) roads.splice(roads.indexOf(n.r), 1); }
console.log(`roads: ${JSON.stringify(roads.reduce((a, r) => ((a[r.kind] = (a[r.kind] || 0) + 1), a), {}))}`);
// fences: clip to limit and open a gap where a road crosses (gates)
const fenceLines = (cfg.groups.fence ? linesIn(cfg.groups.fence) : []).flatMap((p) => clipPath(p, 2));
const fencesCut = [];
for (const f of fenceLines) {
  const pts = resample(f, 2); let run = [];
  const flushF = () => { if (run.length >= 2) fencesCut.push({ path: run }); run = []; };
  for (const q of pts) { const onRoad = roads.some((r) => r.path.some((rp) => Math.hypot(rp[0] - q[0], rp[1] - q[1]) < r.width / 2 + 1.5)); if (onRoad) flushF(); else run.push(q); }
  flushF();
}
const PLACE_COLORS = cfg.colors || {};
for (const b of buildings) if (b.place && PLACE_COLORS[b.place]) b.color = PLACE_COLORS[b.place];
// building identity: how each landmark is drawn (frame = unfinished concrete skeleton, gable = pitched roof, canopy = roof on posts)
const ROOF_COLORS = cfg.roofs || {};
const PLACE_STYLE = cfg.styles || {};
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
const spt = JSON.parse(await readFile(cfg.spt, 'utf8'));
const sptPoints = spt.SpawnPointParams.map((s) => ({ x: s.Position.x, z: s.Position.z, y: s.Position.y, zone: s.BotZoneName || '' }));
const groundPts = sptPoints.filter(cfg.terrainFilter);
const rockEvidence = cfg.rockEvidence ? sptPoints.filter((p) => cfg.rockEvidence.test(p.zone)) : [];
const TERRAIN_FEATURES = cfg.terrain;
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
  for (const f of TERRAIN_FEATURES) {
    const d = ((x - f.x) / (f.rx * (1 + 0.35 * n1))) ** 2 + ((z - f.z) / (f.rz * (1 - 0.3 * n1))) ** 2;
    const weight = Math.exp(-d * 1.6);
    if (key === 'customs') {
      const bump = f.h * weight * (1 + 0.15 * n2);
      h = Math.max(h, bump);
    } else if (weight > 0.01 && f.h > h) {
      // New-map feature heights are absolute targets. Blending prevents the tail of a
      // positive mountain from flattening a map whose ordinary ground lies below y=0.
      const target = f.h * (1 + 0.08 * n2);
      h = Math.max(h, h * (1 - weight) + target * weight);
    }
  }
  h += 0.6 * n2 + 0.4 * n1; // gentle undulation everywhere
  raw[r * cols + c] = h;
}
// one light smoothing pass
const heights = new Float32Array(cols * rows);
for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { let sum = 0, n = 0; for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { const rr = r + dr, cc = c + dc; if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) { sum += raw[rr * cols + cc]; n++; } } heights[r * cols + c] = +(sum / n).toFixed(2); }
const terrain = { x0, z0, step: STEP, cols, rows, heights: Array.from(heights) };
const terrainHeight = (x, z) => {
  const fx = Math.min(Math.max((x - x0) / STEP, 0), cols - 1.001), fz = Math.min(Math.max((z - z0) / STEP, 0), rows - 1.001);
  const c = Math.floor(fx), r = Math.floor(fz), tx = fx - c, tz = fz - r;
  const h00 = heights[r * cols + c], h10 = heights[r * cols + c + 1], h01 = heights[(r + 1) * cols + c], h11 = heights[(r + 1) * cols + c + 1];
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
};
for (const b of buildings) if (b._topY != null) {
  const c = centroid(b.poly), fallback = b.kind === 'tank' ? 6 : defaultHeight[Object.keys(defaultHeight).find((k) => k.replace(/-2$/, '').toLowerCase() === b.kind)] ?? 4;
  b.height = +Math.max(fallback, b._topY - terrainHeight(c[0], c[1]) + 0.5).toFixed(1);
  delete b._topY;
}
console.log(`props ${props.length + svgProps.length}`);
console.log(`terrain ${cols}x${rows} @${STEP}m from ${groundPts.length} points, range ${Math.min(...heights).toFixed(1)}..${Math.max(...heights).toFixed(1)} m`);
// drop anything whose centroid is outside the playable boundary
const insideC = (poly) => inside(centroid(poly));
const edgeDist = (pt) => { let best = Infinity; for (let i = 0; i < LIMIT.length; i++) { const a = LIMIT[i], b = LIMIT[(i + 1) % LIMIT.length]; const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1; const t = Math.max(0, Math.min(1, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dz) / L2)); best = Math.min(best, Math.hypot(pt[0] - (a[0] + t * dx), pt[1] - (a[1] + t * dz))); } return best; };
// towers hugging the boundary are outside the real playable area (the SVG limit is slightly generous)
const keepB = buildings.filter((b) => insideC(b.poly) && !(b.kind === 'powerline_towers' && edgeDist(centroid(b.poly)) < 10)); buildings.length = 0; buildings.push(...keepB);
const propsIn = [...props, ...svgProps].filter((p) => p.poly ? insideC(p.poly) : (p.path ? inside(p.path[0]) : inside([p.x, p.z])));
const undergroundIn = underground.filter((u) => insideC(u.poly));
const rockPolys = (cfg.groups.rocks ? polysIn(cfg.groups.rocks) : []).filter(insideC);
const rockMasses = key === 'customs' ? rockPolys : rockPolys.map((poly) => {
  const h = Math.sqrt(area(poly)) * (key === 'reserve' ? 0.52 : 0.4);
  const evidence = rockEvidence.filter((p) => inPoly([p.x, p.z], poly));
  const observed = evidence.length ? Math.max(...evidence.map((p) => p.y - terrainHeight(p.x, p.z))) : 0;
  const cap = key === 'reserve' ? 16 : evidence.length ? 42 : 12;
  return { poly, height: +Math.max(1.6, Math.min(cap, Math.max(h, observed))).toFixed(1), evidence };
});
// Woods' largest SVG rocks describe whole ridges. A single full-height extrusion
// turns Sniper Rock and the mountain spine into flat monoliths, so retain a low
// base footprint and raise several separated, footprint-contained forms above it.
const distToRing = ([x, z], poly) => { let best = Infinity; for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length], dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2)); best = Math.min(best, Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz)); } return best; };
function splitWoodsRock({ poly, height, evidence }, index) {
  const A = area(poly);
  if (A < 650 || height < 7) return [{ poly, height }];
  const [x1, z1, x2, z2] = bbox(poly), step = Math.max(7, Math.min(15, Math.sqrt(A) / 5));
  const candidates = [];
  for (let z = z1 + step / 2; z < z2; z += step) for (let x = x1 + step / 2; x < x2; x += step) {
    if (!inPoly([x, z], poly)) continue;
    const edge = distToRing([x, z], poly);
    if (edge >= 4.5) candidates.push({ x, z, edge });
  }
  if (candidates.length < 2) return [{ poly, height }];
  const wanted = Math.min(7, Math.max(2, Math.round(Math.sqrt(A) / 25))), chosen = [];
  const topEvidence = [...evidence].sort((a, b) => (b.y - terrainHeight(b.x, b.z)) - (a.y - terrainHeight(a.x, a.z)))[0];
  const first = topEvidence
    ? candidates.reduce((best, q) => Math.hypot(q.x - topEvidence.x, q.z - topEvidence.z) < Math.hypot(best.x - topEvidence.x, best.z - topEvidence.z) ? q : best, candidates[0])
    : candidates.reduce((best, q) => q.edge > best.edge ? q : best, candidates[0]);
  chosen.push(first);
  while (chosen.length < wanted) {
    const next = candidates.filter((q) => !chosen.includes(q)).map((q) => ({ q, d: Math.min(...chosen.map((p) => Math.hypot(q.x - p.x, q.z - p.z))) })).sort((a, b) => b.d - a.d || b.q.edge - a.q.edge)[0];
    if (!next || next.d < 8) break;
    chosen.push(next.q);
  }
  const base = { poly, height: +Math.max(3, Math.min(10, height * 0.55)).toFixed(1), form: 'base' };
  const forms = chosen.map((q, i) => {
    const r = Math.min(20, Math.max(4.5, q.edge * 0.68)), rx = r * (0.85 + hash2(index + i * 7, 31) * 0.25), rz = r * (0.82 + hash2(index + 43, i * 11) * 0.28);
    const capPoly = Array.from({ length: 14 }, (_, k) => { const a = (k / 14) * Math.PI * 2; return [+(q.x + Math.cos(a) * rx).toFixed(1), +(q.z + Math.sin(a) * rz).toFixed(1)]; });
    const scale = i === 0 ? 1 : 0.62 + hash2(index * 13 + i, 79) * 0.3;
    return { poly: capPoly, height: +Math.max(base.height + 1.2, height * scale).toFixed(1), form: i === 0 ? 'summit' : 'outcrop' };
  });
  return [base, ...forms];
}
const rocksOut = key === 'customs' ? rockMasses : key === 'woods' ? rockMasses.flatMap(splitWoodsRock) : rockMasses.map(({ evidence, ...rock }) => rock);
const output = `public/data/${key}-3d.json`;
let builtAt = new Date().toISOString();
if (!process.argv.includes('--stamp')) { try { builtAt = JSON.parse(await readFile(output, 'utf8')).builtAt || builtAt; } catch {} }
const treePolys = (cfg.groups.trees ? polysIn(cfg.groups.trees) : []).filter(insideC);
if (cfg.proceduralTrees) {
  // Woods' SVG has no tree group. Use broad deterministic canopy clusters, kept away
  // from mapped roads/water/buildings, instead of pretending to trace every satellite dot.
  const step = 55;
  for (let z = BOUNDS.zMin + 20, j = 0; z <= BOUNDS.zMax - 20; z += step, j++) for (let x = BOUNDS.xMin + 20, i = 0; x <= BOUNDS.xMax - 20; x += step, i++) {
    if (hash2(i + 71, j + 113) < 0.62 || !inside([x, z]) || out0.water.some((w) => inPoly([x, z], w)) || buildings.some((b) => inPoly([x, z], b.poly))) continue;
    if (roads.some((r) => r.path.some((q) => Math.hypot(q[0] - x, q[1] - z) < r.width / 2 + 9))) continue;
    const rx = 7 + hash2(i + 5, j + 19) * 8, rz = 7 + hash2(i + 29, j + 3) * 8;
    const poly = Array.from({ length: 12 }, (_, k) => { const a = (k / 12) * Math.PI * 2, wobble = 0.82 + hash2(i * 13 + k, j * 17 - k) * 0.32; return [+(x + Math.cos(a) * rx * wobble).toFixed(1), +(z + Math.sin(a) * rz * wobble).toFixed(1)]; });
    if (insideC(poly)) treePolys.push(poly);
  }
}
const out = {
  props: propsIn, terrain, bridges, limit: LIMIT,
  map: key, builtAt, source: 'tarkov.dev SVG (CC BY-NC-SA) + tarkov.dev maps.json floor extents',
  land: polysIn(cfg.groups.land), water: out0.water, pavement: (cfg.groups.pavement ? polysIn(cfg.groups.pavement) : []).filter(insideC), trees: treePolys, rocks: rocksOut,
  roads, railway: clipLines((cfg.groups.railway ? linesIn(cfg.groups.railway) : []).map((p) => ({ path: p }))), fences: fencesCut, powerlines: clipLines((cfg.groups.powerlines ? linesIn(cfg.groups.powerlines) : []).map((p) => ({ path: p }))),
  buildings, underground: undergroundIn, floorBoxes,
};
if (cfg.groups.minefield) out.minefields = polysIn(cfg.groups.minefield).filter(insideC);
await writeFile(output, JSON.stringify(out));
const multi = buildings.filter((b) => b.floors > 1);
console.log(`styles: ${JSON.stringify(buildings.reduce((a, b) => ((a[b.style] = (a[b.style] || 0) + 1), a), {}))}`);
console.log(`bridges ${bridges.length} (${bridges.map((b) => (b.name || b.kind) + (b.ford ? ' [ford]' : '')).join(', ')}), named ${buildings.filter((b) => b.place).length}, coloured ${buildings.filter((b) => b.color).length}`);
console.log(`buildings ${buildings.length} (multi-floor ${multi.length}: ${multi.map((b) => `${b.name}×${b.floors}`).join(', ')}), trees ${out.trees.length}, rocks ${out.rocks.length}, roads ${roads.length}, water ${out.water.length}, land ${out.land.length} → ${output} (${(JSON.stringify(out).length / 1024).toFixed(0)} KB)`);
