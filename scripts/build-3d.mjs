// Build public/data/<map>-3d.json from a tarkov.dev SVG and floor extents.
// Everything is emitted in GAME coordinates (x, z) so the 3D view shares data with the 2D map.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { LABELS } from '../src/labels.js';
import { carveWaterHeightfield, pointInWater, waterRings } from '../src/water.js';
import { exactPosition, loadExactMap, primitiveRows, stableStringify } from './lib/exact-map-primitives.mjs';

const CUSTOMS_COLORS = { 'Big Red': [142, 58, 50], 'Crackhouse': [139, 110, 90], 'Dorms 2-Story': [185, 169, 143], 'Dorms 3-Story': [185, 169, 143], 'New Gas': [196, 191, 180], 'Old Gas': [150, 146, 134], 'Fortress': [162, 158, 148], 'Skeleton': [162, 158, 148], 'Repair Shop': [138, 140, 136], 'Warehouse 3': [138, 140, 136], 'Warehouse 4': [138, 140, 136], 'Warehouse 7': [138, 140, 136], 'Warehouse 17': [138, 140, 136], 'Depot': [146, 142, 132], 'Boiler': [150, 130, 118], 'Oil Rig': [146, 138, 124], 'Streamer House': [139, 110, 90], 'Bus Station': [176, 172, 160], 'Storage': [144, 146, 142], 'Powerline Tower': [126, 126, 122], 'Water Pump': [140, 148, 152], 'Military Checkpoint': [160, 156, 146] };
const CUSTOMS_ROOFS = { 'Warehouse 3': [92, 102, 106], 'Warehouse 4': [92, 102, 106], 'Warehouse 7': [92, 102, 106], 'Warehouse 17': [92, 102, 106], 'Depot': [98, 100, 102], 'Storage': [96, 99, 100], 'Crackhouse': [126, 76, 52], 'Streamer House': [126, 76, 52], 'Repair Shop': [92, 102, 106], 'Boiler': [104, 96, 88] };
const CUSTOMS_STYLES = { 'Skeleton': 'frame', 'Old Construction': 'frame', 'Crackhouse': 'gable', 'Streamer House': 'gable', 'Repair Shop': 'gable', 'Warehouse 3': 'gable', 'Warehouse 4': 'gable', 'Warehouse 7': 'gable', 'Warehouse 17': 'gable', 'Depot': 'gable', 'Boiler': 'gable', 'Storage': 'gable', 'New Gas': 'canopy', 'Old Gas': 'canopy', 'Bus Station': 'canopy' };
const CONFIG = {
  customs: {
    svgName: 'Customs', svgUrl: 'https://assets.tarkov.dev/maps/svg/Customs.svg', maps: 'scripts/tarkov-dev-maps.json',
    props: 'data/customs-props.json', roads: 'data/customs-roads.json', spt: 'scripts/spt-bigmap-base.json',
    bounds: { xMax: 698, xMin: -372, zMin: -307, zMax: 237 }, base: 'Ground_Level',
    groups: { land: 'Ground', limit: 'Ground', water: 'River', pavement: 'Pavement', trees: 'Trees', rocks: 'Rocks', railway: 'Railway', fence: 'Fence', powerlines: 'Powerlines' },
    waterProfile: { kind: 'river', depth: 1.2, bank: 5, flowAxis: [0, 1], maxSlope: 0.004 },
    roadGroups: [['High_Roads', 12, 'highway'], ['Main_Roads', 8, 'main'], ['Roads', 5, 'small'], ['Dirt_Roads', 5, 'dirt']],
    buildingHeights: { 'Garages-2': 4, 'Big_Buildings-2': 9, 'Small_Buildings-2': 3.5, 'Powerline_Towers': 22 },
    underground: /Underground/i, colors: CUSTOMS_COLORS, roofs: CUSTOMS_ROOFS, styles: CUSTOMS_STYLES, autoSmallTracks: true,
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
    terrain: [
      { name: 'Dome summit', x: -8, z: 183, rx: 72, rz: 62, h: 20 },
      { name: 'Dome approach ridge', x: -55, z: 125, rx: 115, rz: 70, h: 11 },
      { name: 'east mountain shoulder', x: -210, z: 55, rx: 85, rz: 190, h: 10 },
      { name: 'south rocky boundary', x: -80, z: 245, rx: 190, rz: 42, h: 14 },
    ],
  },
  woods: {
    svgName: 'Woods', svgUrl: 'https://assets.tarkov.dev/maps/svg/Woods.svg', maps: 'scripts/data/woods/maps-entry.json',
    props: 'data/woods-props.json', roads: 'data/woods-roads.json', yards: 'data/woods-yards.json', spt: 'scripts/data/woods/spt-base.json',
    bounds: { xMax: 646, xMin: -761, zMin: -914, zMax: 442 }, base: 'Ground_Level',
    groups: { land: 'Base_Terrain', limit: 'Base_Terrain', water: 'Water', pavement: null, trees: null, rocks: 'Rocks', railway: 'Railroad', fence: 'Fences', powerlines: 'Power_Line', plane: 'Plane', pier: 'Pier', minefield: 'Minefield' },
    waterProfile: { kind: 'lake', depth: 2.5, bank: 5.5 },
    roadGroups: [['Roads', 6, 'main'], ['Small Roads', 4, 'small'], ['Dirt_Roads', 3.5, 'dirt']],
    buildingHeights: { Buildings: 4 }, underground: /$a/,
    colors: { Sawmill: [132, 109, 78], 'Old Sawmill': [128, 112, 94], 'Scav Town': [154, 143, 124], 'Scav House': [156, 119, 83], 'USEC CAMP': [108, 116, 96], 'Military Camp': [146, 148, 136], 'Sunken Village / Abandoned Village': [126, 112, 91] },
    roofs: { Sawmill: [91, 78, 61], 'Old Sawmill': [104, 82, 66], 'Scav Town': [110, 84, 66], 'Scav House': [132, 74, 57] },
    styles: { Sawmill: 'gable', 'Old Sawmill': 'gable', 'Scav Town': 'gable', 'Scav House': 'gable', 'Sunken Village / Abandoned Village': 'gable', 'USEC CAMP': 'gable', 'Military Camp': 'gable', Shack: 'gable', "Jaeger's Camp": 'gable' }, autoSmallTracks: true,
    labelRadius: 80,
    extraBuildings: [
      ...[[583.4,97], [520.5,-33.2], [450.3,-160.1], [354.8,-268], [250.6,-368.8], [116.3,-405.4], [-27.4,-424.5], [-160.5,-478.7], [-286.2,-550.7]].map(([x, z]) => ({ poly: [[x-2,z-2], [x+2,z-2], [x+2,z+2], [x-2,z+2]], height: 20, floors: 1, kind: 'powerline_towers', name: 'power pylon' })),
    ],
    proceduralTrees: true,
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
const exactSource = await loadExactMap(key);
const featureManifest = JSON.parse(await readFile(`data/${key}-features.json`, 'utf8'));
if (featureManifest.schemaVersion !== 1 || featureManifest.map !== key || !Array.isArray(featureManifest.features) || !Array.isArray(featureManifest.anchors)) {
  throw new Error(`${key}: invalid data/${key}-features.json manifest`);
}

let svg;
try { svg = await readFile(`.cache/maps/svg/${cfg.svgName}.svg`, 'utf8'); } catch { svg = await (await fetch(cfg.svgUrl)).text(); }
const maps = JSON.parse(await readFile(cfg.maps, 'utf8'));
const community = JSON.parse(await readFile(`public/data/${key}.json`, 'utf8'));
const props = JSON.parse(await readFile(cfg.props, 'utf8')).props;
const roadEdits = JSON.parse(await readFile(cfg.roads, 'utf8'));
const yards = cfg.yards ? JSON.parse(await readFile(cfg.yards, 'utf8')).yards : [];
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
const shapes = []; const stack = []; let sourceElementIndex = 0;
for (const el of elements(svg)) {
  if (el.tag === 'g') { const t = parseTransform(attr(el.attrs, 'transform')); const parent = stack[stack.length - 1] ?? { ids: [], tx: 0, ty: 0, s: 1 }; stack.push({ ids: [...parent.ids, attr(el.attrs, 'id') || ''], tx: parent.tx + t.tx * parent.s, ty: parent.ty + t.ty * parent.s, s: parent.s * t.s, cls: attr(el.attrs, 'class') || '' }); continue; }
  if (el.tag === '/g') { stack.pop(); continue; }
  const g = stack[stack.length - 1]; if (!g) continue;
  const apply = ([x, y]) => [g.tx + x * g.s, g.ty + y * g.s];
  const sourceElementId = attr(el.attrs, 'id') || `element-${sourceElementIndex}`;
  const sourcePrefix = `svg:${g.ids.filter(Boolean).join('/')}:${sourceElementId}`;
  sourceElementIndex++;
  if (el.tag === 'path') {
    const d = attr(el.attrs, 'd'); if (!d) continue;
    for (const [subpath, poly] of flatten(d).entries()) shapes.push({ ids: g.ids, cls: g.cls, pts: poly.map(apply), sourceKey: `${sourcePrefix}:subpath-${subpath}` });
  }
  if (el.tag === 'circle') {
    const cx = +attr(el.attrs, 'cx'), cy = +attr(el.attrs, 'cy'), r = +attr(el.attrs, 'r'); const pts = [];
    for (let a = 0; a < 16; a++) pts.push(apply([cx + r * Math.cos(a / 16 * 2 * Math.PI), cy + r * Math.sin(a / 16 * 2 * Math.PI)]));
    shapes.push({ ids: g.ids, cls: g.cls, pts, circle: true, sourceKey: sourcePrefix });
  }
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
  const building = { sourceKey: s.sourceKey, poly, height, floors, kind: tank ? 'tank' : grp.replace(/-2$/, '').toLowerCase(), name: covering[0]?.name ?? null };
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
// ---- canonical identity manifest -------------------------------------------------------
// Nearest-label/floor rectangles remain useful hints, but these reviewed records
// are the final verdict for high-salience features. Centroid drift is a hard
// failure so an upstream SVG change cannot silently retarget an override.
const featureAssignments = [];
for (const definition of featureManifest.features) {
  const targets = definition.match?.centroids ?? (definition.match?.centroid ? [definition.match.centroid] : []);
  const tolerance = definition.match?.toleranceM ?? 0.5;
  if (!definition.featureId || !targets.length) throw new Error(`${key}: feature ${definition.featureId ?? '(missing id)'} has no centroid target`);
  const matches = [];
  for (const [targetIndex, target] of targets.entries()) {
    const candidates = buildings.map((building) => ({ building, distance: Math.hypot(centroid(building.poly)[0] - target[0], centroid(building.poly)[1] - target[1]) }))
      .filter(({ building, distance }) => distance <= tolerance && !featureAssignments.some((assignment) => assignment.building === building))
      .sort((a, b) => a.distance - b.distance || String(a.building.sourceKey ?? '').localeCompare(String(b.building.sourceKey ?? '')));
    if (candidates.length !== 1) throw new Error(`${key}: ${definition.featureId} target ${target.join(',')} matched ${candidates.length} buildings within ${tolerance} m`);
    const building = candidates[0].building;
    const featureId = targets.length === 1 ? definition.featureId : `${definition.featureId}.${targetIndex + 1}`;
    const set = definition.set ?? {};
    building.featureId = featureId;
    if (set.featureClass) building.featureClass = set.featureClass;
    if (set.name) building.name = set.name;
    if (set.place) building.place = set.place;
    if (set.kind) building.kind = set.kind;
    if (set.style) building.style = set.style;
    if (Number.isInteger(set.floorCount)) building.floors = set.floorCount;
    if (Number.isFinite(set.heightM)) building.height = set.heightM;
    featureAssignments.push({ definition, building, targetIndex });
    matches.push(building);
  }
  if (definition.assert?.count != null && matches.length !== definition.assert.count) throw new Error(`${key}: ${definition.featureId} expected ${definition.assert.count} matches, got ${matches.length}`);
}
// ---- bridges: parts of roads/rail that run over water become elevated decks
const inPoly = ([x, z], poly) => { let inside = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, zi] = poly[i], [xj, zj] = poly[j]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside; } return inside; };
const resample = (path, step) => { const r = [path[0]]; for (let i = 1; i < path.length; i++) { const [ax, az] = path[i - 1], [bx, bz] = path[i]; const L = Math.hypot(bx - ax, bz - az); for (let t = step; t < L; t += step) r.push([ax + ((bx - ax) * t) / L, az + ((bz - az) * t) / L]); r.push(path[i]); } return r; };
const ringArea = (ring) => ring.reduce((sum, [x, z], i) => { const [nx, nz] = ring[(i + 1) % ring.length]; return sum + x * nz - nx * z; }, 0) / 2;
const samePoint = (a, b, eps = 1e-7) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= eps;
const cleanRing = (ring) => {
  const out = [];
  for (const p of ring) if (!out.length || !samePoint(p, out[out.length - 1])) out.push(p);
  if (out.length > 1 && samePoint(out[0], out[out.length - 1])) out.pop();
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i + out.length - 1) % out.length], b = out[i], c = out[(i + 1) % out.length];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(cross) <= 1e-8 && (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) >= 0) {
        out.splice(i, 1); changed = true; break;
      }
    }
  }
  return out;
};
const ccw = (ring) => ringArea(ring) < 0 ? [...ring].reverse() : [...ring];
const ringDistance = ([x, z], ring) => {
  let distance = Infinity, nearest = null;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2));
    const point = [a[0] + t * dx, a[1] + t * dz], d = Math.hypot(x - point[0], z - point[1]);
    if (d < distance) { distance = d; nearest = point; }
  }
  return { inside: inPoly([x, z], ring), distance, nearest };
};
const circleRing = ([x, z], radius, maxStep = 1.75) => {
  const count = Math.max(24, Math.ceil((2 * Math.PI * radius) / maxStep));
  return Array.from({ length: count }, (_, i) => { const a = (i / count) * 2 * Math.PI; return [x + Math.cos(a) * radius, z + Math.sin(a) * radius]; });
};
const capsuleRing = (a, b, radius, maxStep = 1.75) => {
  const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
  if (samePoint(a, b)) return circleRing(a, radius, maxStep);
  const count = Math.max(12, Math.ceil((Math.PI * radius) / maxStep)), ring = [];
  for (let i = 0; i <= count; i++) { const q = angle - Math.PI / 2 + (i / count) * Math.PI; ring.push([b[0] + Math.cos(q) * radius, b[1] + Math.sin(q) * radius]); }
  for (let i = 0; i <= count; i++) { const q = angle + Math.PI / 2 + (i / count) * Math.PI; ring.push([a[0] + Math.cos(q) * radius, a[1] + Math.sin(q) * radius]); }
  return cleanRing(ring);
};
const segmentIntersection = (a, b, c, d) => {
  const rx = b[0] - a[0], rz = b[1] - a[1], sx = d[0] - c[0], sz = d[1] - c[1];
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-10) return null;
  const qx = c[0] - a[0], qz = c[1] - a[1];
  const t = (qx * sz - qz * sx) / den, u = (qx * rz - qz * rx) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  const tc = Math.max(0, Math.min(1, t)), uc = Math.max(0, Math.min(1, u));
  return { t: tc, u: uc, point: [a[0] + tc * rx, a[1] + tc * rz] };
};
// Boundary-overlay union for two overlapping simple rings. Marker patches are convex and always
// overlap the current playable ring; retaining only the pieces outside the other ring leaves the
// union outline while preserving every untouched SVG segment geometrically.
function unionRings(leftInput, rightInput) {
  const left = ccw(cleanRing(leftInput)), right = ccw(cleanRing(rightInput));
  const leftSplits = left.map((p, i) => [{ t: 0, point: p }, { t: 1, point: left[(i + 1) % left.length] }]);
  const rightSplits = right.map((p, i) => [{ t: 0, point: p }, { t: 1, point: right[(i + 1) % right.length] }]);
  let intersections = 0;
  for (let i = 0; i < left.length; i++) for (let j = 0; j < right.length; j++) {
    const hit = segmentIntersection(left[i], left[(i + 1) % left.length], right[j], right[(j + 1) % right.length]);
    if (!hit) continue;
    leftSplits[i].push({ t: hit.t, point: hit.point }); rightSplits[j].push({ t: hit.u, point: hit.point }); intersections++;
  }
  if (intersections < 2) {
    if (inPoly(right[0], left)) return left;
    if (inPoly(left[0], right)) return right;
    throw new Error(`disconnected limit patch (${intersections} boundary intersections)`);
  }
  const pieces = (ring, splits, other) => {
    const out = [];
    for (let i = 0; i < ring.length; i++) {
      const points = splits[i].sort((a, b) => a.t - b.t).filter((v, k, all) => !k || Math.abs(v.t - all[k - 1].t) > 1e-8);
      for (let j = 1; j < points.length; j++) {
        const a = points[j - 1].point, b = points[j].point;
        if (samePoint(a, b)) continue;
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (!inPoly(mid, other)) out.push([a, b]);
      }
    }
    return out;
  };
  const edges = [...pieces(left, leftSplits, right), ...pieces(right, rightSplits, left)];
  const keyOf = (p) => `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)}`;
  const starts = new Map();
  edges.forEach((edge, i) => { const key = keyOf(edge[0]); if (!starts.has(key)) starts.set(key, []); starts.get(key).push(i); });
  const used = new Uint8Array(edges.length), rings = [];
  for (let seed = 0; seed < edges.length; seed++) {
    if (used[seed]) continue;
    const ring = [edges[seed][0]], start = keyOf(edges[seed][0]); let edgeIndex = seed;
    for (let guard = 0; guard <= edges.length; guard++) {
      if (used[edgeIndex]) break;
      used[edgeIndex] = 1;
      const end = edges[edgeIndex][1]; ring.push(end);
      if (keyOf(end) === start) break;
      const next = (starts.get(keyOf(end)) || []).find((i) => !used[i]);
      if (next == null) {
        const endKey = keyOf(end), outgoing = starts.get(endKey)?.length || 0;
        throw new Error(`open limit ring after marker union at ${end.map((v) => v.toFixed(6)).join(',')} (key ${endKey}, outgoing ${outgoing}, edges ${edges.length}, intersections ${intersections})`);
      }
      edgeIndex = next;
    }
    const cleaned = cleanRing(ring);
    if (cleaned.length >= 3) rings.push(cleaned);
  }
  if (!rings.length) throw new Error('empty limit ring after marker union');
  return ccw(rings.sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)))[0]);
}
const resampleRing = (ring, step = 2) => {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    out.push(a);
    for (let d = step; d < length - 1e-8; d += step) out.push([a[0] + ((b[0] - a[0]) * d) / length, a[1] + ((b[1] - a[1]) * d) / length]);
  }
  return out;
};
const MARKER_GROUPS = ['extracts', 'spawns', 'hazards', 'stationaryWeapons', 'switches', 'locks', 'containers', 'btrStops'];
const markerPoints = MARKER_GROUPS.flatMap((group) => (community[group] || []).map((marker, index) => ({
  group, index, name: marker.name || marker.key?.name || marker.stationaryWeapon?.name || marker.zoneName || marker.type || `${group} #${index + 1}`,
  point: [marker.position?.x, marker.position?.z],
}))).filter((marker) => {
  if (marker.point.every(Number.isFinite)) return true;
  throw new Error(`${key}: invalid ${marker.group} marker position for ${marker.name}`);
});
const MARKER_MARGIN = 18, PATCH_RADIUS = 18.25;
// Nearby marker bumps can otherwise leave a comb of narrow bays between overlapping gameplay
// evidence. Removing only local concave vertices fills those bays (it can only add playable area),
// while natural SVG concavities away from a deficient marker remain geometrically unchanged.
function fillMarkerBays(input, deficientMarkers, influence = 75, maxChord = 120) {
  const ring = ccw(cleanRing(input)); let removed = 0, changed = true;
  const crossesOtherEdge = (a, c, at) => {
    for (let j = 0; j < ring.length; j++) {
      if (j === at || j === (at + ring.length - 1) % ring.length || j === (at + 1) % ring.length) continue;
      const hit = segmentIntersection(a, c, ring[j], ring[(j + 1) % ring.length]);
      if (hit && hit.t > 1e-7 && hit.t < 1 - 1e-7 && hit.u > 1e-7 && hit.u < 1 - 1e-7) return true;
    }
    return false;
  };
  while (changed) {
    changed = false;
    for (let i = 0; i < ring.length && ring.length > 3; i++) {
      const a = ring[(i + ring.length - 1) % ring.length], b = ring[i], c = ring[(i + 1) % ring.length];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (cross >= -1e-7 || Math.hypot(c[0] - a[0], c[1] - a[1]) > maxChord) continue;
      if (!deficientMarkers.some((marker) => Math.hypot(marker.point[0] - b[0], marker.point[1] - b[1]) <= influence)) continue;
      if (crossesOtherEdge(a, c, i)) continue;
      ring.splice(i, 1); removed++; changed = true; i--;
    }
  }
  return { ring, removed };
}
function expandLimitForMarkers(rawLimit) {
  let limit = ccw(cleanRing(rawLimit)), patches = 0;
  const rawStats = markerPoints.map((marker) => ({ marker, ...ringDistance(marker.point, limit) }));
  const pending = rawStats.filter((d) => !d.inside || d.distance < MARKER_MARGIN)
    .sort((a, b) => (a.inside ? MARKER_MARGIN - a.distance : MARKER_MARGIN + a.distance) - (b.inside ? MARKER_MARGIN - b.distance : MARKER_MARGIN + b.distance)
      || a.marker.group.localeCompare(b.marker.group) || a.marker.index - b.marker.index);
  for (const { marker } of pending) {
    const state = ringDistance(marker.point, limit);
    if (state.inside && state.distance >= MARKER_MARGIN) continue;
    let error = null, joined = null;
    for (let attempt = 0; attempt < 4 && !joined; attempt++) {
      const radius = PATCH_RADIUS + attempt * 0.75;
      const patch = !state.inside && state.distance >= radius
        ? capsuleRing(state.nearest, marker.point, radius)
        : circleRing(marker.point, radius);
      try { joined = unionRings(limit, patch); } catch (cause) { error = cause; }
    }
    if (!joined) throw new Error(`${key}: marker limit patch failed for ${marker.group}[${marker.index}] ${marker.name} @ ${marker.point.join(',')}: ${error.message}`, { cause: error });
    limit = joined;
    patches++;
  }
  const cleaned = fillMarkerBays(limit, pending.map((d) => d.marker));
  limit = resampleRing(cleaned.ring, 1.9).map(([x, z]) => [+x.toFixed(2), +z.toFixed(2)])
    .filter((point, index, all) => !index || !samePoint(point, all[index - 1], 1e-9));
  console.log(`limit: ${rawLimit.length} SVG points -> ${limit.length} smooth points; ${rawStats.filter((d) => !d.inside).length} raw outside markers; ${patches} local buffered expansions; ${cleaned.removed} narrow-bay vertices filled`);
  return limit;
}
function assertMarkerContainment(limit) {
  const offenders = markerPoints.map((marker) => ({ marker, ...ringDistance(marker.point, limit) }))
    .filter((d) => !d.inside || d.distance < MARKER_MARGIN - 0.02);
  if (offenders.length) {
    console.error(`${key}: ${offenders.length} marker containment offenders (required ${MARKER_MARGIN} m margin):`);
    for (const d of offenders) console.error(`  ${d.marker.group}[${d.marker.index}] ${d.marker.name} @ ${d.marker.point.join(',')}: ${d.inside ? `${d.distance.toFixed(2)} m margin` : `${d.distance.toFixed(2)} m outside`}`);
    throw new Error(`${key}: playable limit does not contain every marker`);
  }
  console.log(`marker containment: ${markerPoints.length} shared 2D/3D markers checked; 0 offenders; >=${MARKER_MARGIN} m margin`);
}
// Compound SVG water paths use reversed nested rings for islands. Preserve those as holes so
// neither the basin carve nor the water fill erases dry land in the middle of a river.
const waterRaw = cfg.groups.water ? polysIn(cfg.groups.water) : [];
const signedRingArea = (poly) => poly.reduce((sum, [x, z], i) => { const [nx, nz] = poly[(i + 1) % poly.length]; return sum + x * nz - nx * z; }, 0) / 2;
const waterParents = waterRaw.map((ring, i) => waterRaw.map((outer, j) => ({
  j, area: Math.abs(signedRingArea(outer)),
  contains: i !== j && signedRingArea(ring) * signedRingArea(outer) < 0 && inPoly(centroid(ring), outer),
})).filter((d) => d.contains).sort((a, b) => a.area - b.area)[0]?.j ?? -1);
const out0 = { water: waterRaw.map((poly, i) => ({ poly, holes: waterRaw.filter((_, j) => waterParents[j] === i) })).filter((_, i) => waterParents[i] < 0) };
const overWater = (pt) => out0.water.some((water) => pointInWater(pt, water));
const bridges = [];
for (const r of [...roads.map((r) => ({ ...r, cls: 'road' })), ...(cfg.groups.railway ? linesIn(cfg.groups.railway) : []).map((p) => ({ path: p, width: 3, kind: 'rail', cls: 'rail' }))]) {
  const pts = resample(r.path, 3); let run = [];
  const flush = () => { if (run.length >= 3) { const i0 = pts.indexOf(run[0]), i1 = pts.indexOf(run[run.length - 1]); const span = pts.slice(Math.max(0, i0 - 5), Math.min(pts.length, i1 + 6)); bridges.push({ path: span, width: r.width, kind: r.kind, height: r.kind === 'rail' ? 8 : 6.5 }); } run = []; };
  for (const p of pts) { if (overWater(p)) run.push(p); else flush(); }
  flush();
}
// ---- playable boundary = SVG ground plus deterministic local buffers around every shared marker.
// tarkov.dev's visual Ground/Limit ring is not the true gameplay edge everywhere (Dorms V-Ex is
// the clearest example). Preserve its unaffected segments, attach only the buffered marker patches,
// then resample the final outline at <=2 m so the terrain and flat cliff follow one clean curve.
const RAW_LIMIT = polysIn(cfg.groups.limit)[0];
if (!RAW_LIMIT) throw new Error(`${key}: no playable limit from SVG group ${cfg.groups.limit}`);
const LIMIT = expandLimitForMarkers(RAW_LIMIT);
assertMarkerContainment(LIMIT);
const inside = (pt) => inPoly(pt, LIMIT);
function clipPath(path, step = 3) { const out = []; let run = []; for (const q of resample(path, step)) { if (inside(q)) run.push(q); else { if (run.length >= 2) out.push(run); run = []; } } if (run.length >= 2) out.push(run); return out; }
const clipLines = (items) => items.flatMap((it) => clipPath(it.path).map((path) => ({ ...it, path })));
// keep real crossings only: no dirt tracks (swamp), and merge overlapping road paths
const mid = (b) => b.path[Math.floor(b.path.length / 2)];
const detectedBridges = [...bridges];
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
  // The shallow northern ground path is a dirt crossing, so it is intentionally excluded from
  // the elevated-deck de-duplication above. Some SVG revisions stop its track at the banks, so
  // retain the audited crossing explicitly when automatic intersection detection cannot see it.
  const ford = detectedBridges.find((b) => Math.hypot(mid(b)[0] + 84, mid(b)[1] + 74) < 25)
    ?? { kind: 'dirt', path: resample([[-113, -74], [-50, -74]], 3), width: 3, height: 0.4 };
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
// Some SVG roads are long compound paths crossing multiple surface types. Split
// at an audited spatial boundary so a northern dirt run does not turn the paved
// southern approach into dirt with it.
for (const zone of roadEdits.reclassifyZones || []) {
  const [[x1, z1], [x2, z2]] = zone.bounds;
  const inZone = ([x, z]) => x >= Math.min(x1, x2) && x <= Math.max(x1, x2) && z >= Math.min(z1, z2) && z <= Math.max(z1, z2);
  const split = [];
  for (const road of roads) {
    if (zone.from?.length && !zone.from.includes(road.kind)) { split.push(road); continue; }
    let kind = inZone(road.path[0]) ? zone.to : road.kind, run = [road.path[0]];
    const flush = () => { if (run.length >= 2) split.push({ ...road, kind, width: kind === 'dirt' ? 3.5 : kind === 'track' ? 2.2 : road.width, fixed: true, path: run }); };
    for (let i = 1; i < road.path.length; i++) {
      const nextKind = inZone(road.path[i]) ? zone.to : road.kind;
      if (nextKind !== kind) { run.push(road.path[i]); flush(); run = [road.path[i - 1], road.path[i]]; kind = nextKind; }
      else run.push(road.path[i]);
    }
    flush();
  }
  roads.length = 0; roads.push(...split);
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
  const st = b.style || (b.place && PLACE_STYLE[b.place]);
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
// ---- terrain: typed exact/SPT/survey evidence ------------------------------------------
// Every finite point is retained with a bucket and reason code. Only the ground
// bucket is deduplicated into the single-valued heightfield; rock/floor/roof/
// underground remain available to their corresponding hard-surface classifiers.
const spt = JSON.parse(await readFile(cfg.spt, 'utf8'));
const TERRAIN_FEATURES = cfg.terrain;
const SAMPLE_SOURCE_WEIGHT = { exactSpawn: 3, sptSpawn: 2.5, exactLoot: 1.5, sptLoot: 1, survey: 4, exactInteractive: 1.25 };
const evidenceInput = [];
const evidenceIds = new Map();
const addEvidence = (point) => {
  if (![point.x, point.y, point.z].every(Number.isFinite)) throw new Error(`${key}: non-finite elevation evidence from ${point.sourceKind}`);
  const base = point.sourceId || `generated:${createHash('sha256').update(stableStringify(point)).digest('hex').slice(0, 24)}`;
  const seen = (evidenceIds.get(`${point.provider}:${base}`) ?? 0) + 1;
  evidenceIds.set(`${point.provider}:${base}`, seen);
  evidenceInput.push({ ...point, sourceId: seen === 1 ? base : `${base}#${seen}` });
};
for (const row of primitiveRows(exactSource.exact)) {
  const p = exactPosition(row.raw); if (!p) continue;
  addEvidence({
    ...p, provider: 'tarkov.dev-json', source: row.kind === 'spawn' ? 'exactSpawn' : ['lootContainer', 'looseLoot'].includes(row.kind) ? 'exactLoot' : 'exactInteractive',
    sourceKind: row.kind, sourceId: `${row.collection}:${row.sourceId}`, zone: row.raw.zoneName || '',
  });
}
for (const spawn of spt.SpawnPointParams ?? []) addEvidence({
  x: spawn.Position.x, y: spawn.Position.y, z: spawn.Position.z,
  provider: 'spt-4.1.2', source: 'sptSpawn', sourceKind: 'spawn', zone: spawn.BotZoneName || '',
  sourceId: `spawn:${createHash('sha256').update(stableStringify(spawn)).digest('hex').slice(0, 24)}`,
});
try {
  const loose = JSON.parse(await readFile(`scripts/data/${key}/loose-loot-samples.json`, 'utf8'));
  for (const [index, point] of (loose.points ?? []).entries()) if (Array.isArray(point) && point.length >= 3) addEvidence({
    x: point[0], y: point[1], z: point[2], provider: 'spt-4.1.2', source: 'sptLoot', sourceKind: 'looseLoot', zone: '',
    sourceId: `looseLoot:${createHash('sha256').update(stableStringify(point)).digest('hex').slice(0, 24)}:${index}`,
  });
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
try {
  const doc = JSON.parse(await readFile(`scripts/data/${key}/elevation-samples.json`, 'utf8'));
  const names = doc.sourceTypes || ['looseLoot', 'spawn', 'survey'];
  const rows = doc.points ?? doc.samples ?? [];
  for (const [index, point] of rows.entries()) {
    if (!Array.isArray(point) || point.length < 3 || names[point[3] ?? 2] !== 'survey') continue;
    addEvidence({ x: point[0], y: point[1], z: point[2], provider: 'companion-survey', source: 'survey', sourceKind: 'survey', zone: point[4] || '', sourceId: `survey:${index}` });
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const rawRockPolys = cfg.groups.rocks ? polysIn(cfg.groups.rocks) : [];
const hardRockRegions = (featureManifest.hardRocks ?? []).map((rock) => ({ ...rock, poly: circleRing(rock.contactCenter, rock.contactRadiusM, 3) }));
const median = (values) => { const a = [...values].sort((x, y) => x - y), m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const percentile = (values, p) => {
  const a = [...values].sort((x, y) => x - y);
  if (!a.length) return null;
  const at = (a.length - 1) * p, lo = Math.floor(at), hi = Math.ceil(at), mix = at - lo;
  return a[lo] * (1 - mix) + a[hi] * mix;
};
function spatialIndex(points, size = 20) {
  const bins = new Map();
  for (const p of points) { const k = `${Math.floor(p.x / size)},${Math.floor(p.z / size)}`; if (!bins.has(k)) bins.set(k, []); bins.get(k).push(p); }
  return (x, z, radius) => {
    const out = [], x1 = Math.floor((x - radius) / size), x2 = Math.floor((x + radius) / size), z1 = Math.floor((z - radius) / size), z2 = Math.floor((z + radius) / size), r2 = radius * radius;
    for (let iz = z1; iz <= z2; iz++) for (let ix = x1; ix <= x2; ix++) for (const p of bins.get(`${ix},${iz}`) || []) if ((p.x - x) ** 2 + (p.z - z) ** 2 <= r2) out.push(p);
    return out;
  };
}
const undergroundExtentAt = (p) => floorBoxes.some((ext) => cfg.underground.test(ext.layer)
  && p.x >= ext.x1 && p.x <= ext.x2 && p.z >= ext.z1 && p.z <= ext.z2
  && Number.isFinite(ext.y?.[0]) && Number.isFinite(ext.y?.[1]) && p.y >= Math.min(...ext.y) - 1 && p.y <= Math.max(...ext.y) + 1);
const buildingAt = (p) => buildings.find((building) => inPoly([p.x, p.z], building.poly));
const rockReasons = (p) => [
  ...(/(?:Zone)?(?:Big|High)Rocks/i.test(p.zone) ? ['semantic-rock-zone'] : []),
  ...(rawRockPolys.some((poly) => inPoly([p.x, p.z], poly)) ? ['svg-rock-footprint'] : []),
  ...(hardRockRegions.some((rock) => inPoly([p.x, p.z], rock.poly)) ? ['manifest-hard-rock-region'] : []),
];
const bootstrap = evidenceInput.filter((p) => inside([p.x, p.z]) && !buildingAt(p) && !rockReasons(p).length
  && !undergroundExtentAt(p) && !/ZoneSub(Command|Storage)/i.test(p.zone));
const nearbyBootstrap = spatialIndex(bootstrap, 24);
const localGround = (p) => {
  for (const radius of [18, 40, 90]) {
    const neighbours = nearbyBootstrap(p.x, p.z, radius);
    if (neighbours.length >= (radius === 18 ? 4 : 2)) return median(neighbours.map((candidate) => candidate.y));
  }
  return null;
};
const evidenceBuckets = { ground: [], rock: [], floor: [], roof: [], underground: [] };
for (const p of evidenceInput) {
  const reasons = [], local = localGround(p), building = buildingAt(p), rocks = rockReasons(p);
  let bucket;
  if (!inside([p.x, p.z])) { bucket = 'roof'; reasons.push('outside-playable-nonterrain'); }
  else if (undergroundExtentAt(p) || /ZoneSub(Command|Storage)/i.test(p.zone)) { bucket = 'underground'; reasons.push(undergroundExtentAt(p) ? 'exact-underground-extent' : 'semantic-underground-zone'); }
  else if (['hazard', 'artilleryZone'].includes(p.sourceKind)) { bucket = 'roof'; reasons.push('interaction-volume-center-nonterrain'); }
  else if (rocks.length) { bucket = 'rock'; reasons.push(...rocks); }
  else if (building) {
    const delta = local == null ? null : p.y - local;
    if (delta != null && delta < -2.5) { bucket = 'underground'; reasons.push('building-below-local-ground'); }
    else if (delta != null && delta >= Math.max(4, building.height - 1.25)) { bucket = 'roof'; reasons.push('building-roof-band'); }
    else { bucket = 'floor'; reasons.push(delta == null ? 'building-no-ground-context' : 'building-floor-band'); }
  } else if (local == null) {
    if (['exactLoot', 'sptLoot', 'exactInteractive'].includes(p.source)) { bucket = 'roof'; reasons.push('isolated-object-no-ground-context'); }
    else { bucket = 'ground'; reasons.push('trusted-isolated-ground'); }
  } else if (p.y - local > 2.5) { bucket = 'roof'; reasons.push('elevated-local-outlier'); }
  else if (p.y - local < -2.5) { bucket = 'underground'; reasons.push('below-local-ground'); }
  else { bucket = 'ground'; reasons.push('within-local-ground-band'); }
  evidenceBuckets[bucket].push({ ...p, reasonCodes: reasons });
}
// A trusted source wins each 2 m ground cell. Retaining the uncollapsed ground
// bucket above keeps every observation auditable while preventing duplicate
// current/legacy samples from overweighting one location in the fit.
const groundCells = new Map();
for (const point of evidenceBuckets.ground) {
  const cell = `${Math.round(point.x / 2)},${Math.round(point.z / 2)}`;
  if (!groundCells.has(cell)) groundCells.set(cell, []);
  groundCells.get(cell).push(point);
}
const groundPts = [];
for (const points of groundCells.values()) {
  const priority = Math.max(...points.map((point) => SAMPLE_SOURCE_WEIGHT[point.source] ?? 0));
  const chosen = points.filter((point) => (SAMPLE_SOURCE_WEIGHT[point.source] ?? 0) === priority);
  groundPts.push({ ...chosen[0], x: median(chosen.map((p) => p.x)), y: median(chosen.map((p) => p.y)), z: median(chosen.map((p) => p.z)) });
}
groundPts.sort((a, b) => a.z - b.z || a.x - b.x || a.sourceId.localeCompare(b.sourceId));
const rockEvidence = evidenceBuckets.rock;
if (!groundPts.length) throw new Error(`${key}: typed elevation routing produced no ground samples`);
const nearGround = spatialIndex(groundPts, 30);
const STEP = 5, x0 = BOUNDS.xMin - 40, z0 = BOUNDS.zMin - 40, cols = Math.ceil((BOUNDS.xMax - BOUNDS.xMin + 80) / STEP) + 1, rows = Math.ceil((BOUNDS.zMax - BOUNDS.zMin + 80) / STEP) + 1;
// deterministic value noise so hills are irregular instead of perfect ellipses
const hash2 = (i, j) => { const n = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return n - Math.floor(n); };
const noise = (x, z) => { const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j, sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz); return (hash2(i, j) * (1 - sx) + hash2(i + 1, j) * sx) * (1 - sz) + (hash2(i, j + 1) * (1 - sx) + hash2(i + 1, j + 1) * sx) * sz; };
const raw = new Float32Array(cols * rows);
for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
  const x = x0 + c * STEP, z = z0 + r * STEP;
  const n1 = noise(x / 90, z / 90) - 0.5, n2 = noise(x / 35 + 7, z / 35 + 3) - 0.5;
  let points = nearGround(x, z, 90);
  if (points.length < 5) points = nearGround(x, z, 180);
  if (!points.length) points = groundPts;
  let coarseNum = 0, coarseDen = 0, fineNum = 0, fineDen = 0, density = 0, nearest = Infinity;
  for (const p of points) {
    const d2 = (p.x - x) ** 2 + (p.z - z) ** 2, sw = SAMPLE_SOURCE_WEIGHT[p.source] || 1;
    const coarseW = sw / Math.pow(d2 + 225, 0.9); // broad, non-conical background
    coarseNum += coarseW * p.y; coarseDen += coarseW;
    if (d2 <= 55 ** 2) { const fineW = sw / Math.pow(d2 + 49, 1.1); fineNum += fineW * p.y; fineDen += fineW; }
    if (d2 <= 45 ** 2) density += sw * Math.exp(-d2 / (2 * 18 ** 2));
    nearest = Math.min(nearest, Math.sqrt(d2));
  }
  const coarse = coarseNum / coarseDen, fine = fineDen ? fineNum / fineDen : coarse;
  const fineMix = Math.min(1, density / 3);
  const dataHeight = coarse + (fine - coarse) * fineMix;
  const confidence = Math.min(1, density / 3) * Math.min(1, Math.max(0, 1 - nearest / 55));
  let fallback = coarse;
  for (const f of TERRAIN_FEATURES) {
    const d = ((x - f.x) / (f.rx * (1 + 0.35 * n1))) ** 2 + ((z - f.z) / (f.rz * (1 - 0.3 * n1))) ** 2;
    const weight = Math.exp(-d * 1.6);
    if (weight > 0.01 && f.h > fallback) {
      const target = f.h * (1 + 0.08 * n2);
      fallback = Math.max(fallback, fallback * (1 - weight) + target * weight);
    }
  }
  let h = dataHeight * confidence + fallback * (1 - confidence);
  h += (1 - confidence) * (0.25 * n2 + 0.16 * n1); // only invent texture where evidence is thin
  raw[r * cols + c] = h;
}
// One compact Gaussian pass (~5 m sigma) removes sample noise without erasing real hill crests.
const heights = new Float32Array(cols * rows);
for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { let sum = 0, den = 0; for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { const rr = Math.max(0, Math.min(rows - 1, r + dr)), cc = Math.max(0, Math.min(cols - 1, c + dc)), w = (dr ? 1 : 2) * (dc ? 1 : 2); sum += raw[rr * cols + cc] * w; den += w; } heights[r * cols + c] = +(sum / den).toFixed(2); }
const terrainHeight = (x, z) => {
  const fx = Math.min(Math.max((x - x0) / STEP, 0), cols - 1.001), fz = Math.min(Math.max((z - z0) / STEP, 0), rows - 1.001);
  const c = Math.floor(fx), r = Math.floor(fz), tx = fx - c, tz = fz - r;
  const h00 = heights[r * cols + c], h10 = heights[r * cols + c + 1], h01 = heights[(r + 1) * cols + c], h11 = heights[(r + 1) * cols + c + 1];
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
};

// Infer water surfaces from the uncarved fitted field. Grid points inside a polygon and samples
// along its outline feed a low percentile; an outline minimum is the sparse-polygon fallback.
// Customs' separated SVG river reaches share one gently capped flow plane when their binned low
// samples agree, preventing artificial waterfalls at the path breaks.
const waterSampleSets = out0.water.map((water) => {
  const [x1, z1, x2, z2] = bbox(water.poly), interior = [], outline = [];
  const c1 = Math.max(0, Math.floor((x1 - x0) / STEP)), c2 = Math.min(cols - 1, Math.ceil((x2 - x0) / STEP));
  const r1 = Math.max(0, Math.floor((z1 - z0) / STEP)), r2 = Math.min(rows - 1, Math.ceil((z2 - z0) / STEP));
  for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
    const x = x0 + c * STEP, z = z0 + r * STEP;
    if (inside([x, z]) && pointInWater([x, z], water)) interior.push({ x, z, h: heights[r * cols + c] });
  }
  for (const ring of waterRings(water)) for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const count = Math.max(1, Math.ceil(length / 2.5));
    for (let q = 0; q < count; q++) {
      const u = q / count, x = a[0] + (b[0] - a[0]) * u, z = a[1] + (b[1] - a[1]) * u;
      if (inside([x, z])) outline.push({ x, z, h: terrainHeight(x, z) });
    }
  }
  const points = interior.length ? [...interior, ...outline] : outline;
  const fallback = outline.length ? Math.min(...outline.map((p) => p.h)) : Math.min(...water.poly.map(([x, z]) => terrainHeight(x, z)));
  return { water, points, low: interior.length ? percentile(points.map((p) => p.h), 0.1) : fallback };
});

const profile = cfg.waterProfile;
if (profile && waterSampleSets.length) {
  let flow = null;
  if (profile.flowAxis) {
    const length = Math.hypot(...profile.flowAxis) || 1, axis = profile.flowAxis.map((v) => v / length);
    const points = waterSampleSets.flatMap((set) => set.points).map((p) => ({ ...p, u: p.x * axis[0] + p.z * axis[1] }));
    const uMin = Math.min(...points.map((p) => p.u)), uMax = Math.max(...points.map((p) => p.u)), bins = Array.from({ length: 12 }, () => []);
    for (const p of points) bins[Math.min(bins.length - 1, Math.floor(((p.u - uMin) / (uMax - uMin || 1)) * bins.length))].push(p);
    const lows = bins.filter((bin) => bin.length >= 5).map((bin) => ({
      u: bin.reduce((sum, p) => sum + p.u, 0) / bin.length,
      h: percentile(bin.map((p) => p.h), 0.1),
    }));
    if (lows.length >= 5) {
      const u0 = lows.reduce((sum, p) => sum + p.u, 0) / lows.length, h0 = lows.reduce((sum, p) => sum + p.h, 0) / lows.length;
      const den = lows.reduce((sum, p) => sum + (p.u - u0) ** 2, 0);
      const observed = den ? lows.reduce((sum, p) => sum + (p.u - u0) * (p.h - h0), 0) / den : 0;
      const sst = lows.reduce((sum, p) => sum + (p.h - h0) ** 2, 0);
      const sse = lows.reduce((sum, p) => sum + (p.h - (h0 + observed * (p.u - u0))) ** 2, 0);
      const r2 = sst ? 1 - sse / sst : 0, observedDrop = observed * (uMax - uMin);
      if (Math.abs(observedDrop) >= 0.25 && r2 >= 0.55) {
        const slope = Math.max(-profile.maxSlope, Math.min(profile.maxSlope, observed));
        flow = { axis, u0, h0, slope, observed, observedDrop, r2 };
      }
    }
  }
  for (const set of waterSampleSets) {
    const c = centroid(set.water.poly), u = profile.flowAxis ? c[0] * (flow?.axis[0] ?? 0) + c[1] * (flow?.axis[1] ?? 0) : 0;
    const level = flow ? flow.h0 + flow.slope * (u - flow.u0) : set.low;
    set.water.level = +level.toFixed(2);
    set.water.depth = profile.depth;
    set.water.bank = profile.bank;
    set.water.kind = profile.kind;
    if (!set.water.holes.length) delete set.water.holes;
    if (flow) set.water.gradient = { axis: flow.axis.map((v) => +v.toFixed(4)), origin: c.map((v) => +v.toFixed(2)), slope: +flow.slope.toFixed(6) };
  }
  const flowNote = flow ? `; flow ${(flow.slope * 100).toFixed(3)}% (observed ${(flow.observed * 100).toFixed(2)}%, R2 ${flow.r2.toFixed(2)})` : '';
  console.log(`water levels ${out0.water.map((w) => w.level.toFixed(2)).join(', ')} m; ${profile.depth} m ${profile.kind} bed; ${profile.bank} m banks${flowNote}`);
  const carved = carveWaterHeightfield(heights, { x0, z0, step: STEP, cols, rows }, out0.water);
  for (let i = 0; i < heights.length; i++) heights[i] = +carved[i].toFixed(2);
}
for (const bucket of Object.values(evidenceBuckets)) bucket.sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y || a.sourceId.localeCompare(b.sourceId));
const reasonCodeCounts = {};
for (const bucket of Object.values(evidenceBuckets)) for (const point of bucket) for (const code of point.reasonCodes) reasonCodeCounts[code] = (reasonCodeCounts[code] ?? 0) + 1;
const bucketCounts = Object.fromEntries(Object.entries(evidenceBuckets).map(([bucket, points]) => [bucket, points.length]));
const terrain = {
  x0, z0, step: STEP, cols, rows, heights: Array.from(heights),
  // Canonical heights and every source Y remain 1x metres. The renderer's relief
  // multiplier is a sampler-only view skin and is never serialized here.
  units: { horizontal: 'metre', vertical: 'metre', scale: 1 },
  evidence: {
    schemaVersion: 2,
    input: evidenceInput.length,
    heightfieldSamples: groundPts.length,
    bucketCounts,
    reasonCodeCounts: Object.fromEntries(Object.entries(reasonCodeCounts).sort(([a], [b]) => a.localeCompare(b))),
    buckets: evidenceBuckets,
  },
};
for (const b of buildings) if (b._topY != null) {
  const c = centroid(b.poly), fallback = b.kind === 'tank' ? 6 : defaultHeight[Object.keys(defaultHeight).find((k) => k.replace(/-2$/, '').toLowerCase() === b.kind)] ?? 4;
  b.height = +Math.max(fallback, b._topY - terrainHeight(c[0], c[1]) + 0.5).toFixed(1);
  delete b._topY;
}
// Floor extents can assign a plausible shell before the terrain fit exists, but
// reviewed identities are the final authority. Reapply their assertions after
// absolute top-Y conversion and use exact primitive tops only when they describe
// a physically tall volume inside the reviewed footprint.
for (const { definition, building } of featureAssignments) {
  const set = definition.set ?? {};
  if (Number.isInteger(set.floorCount)) building.floors = set.floorCount;
  if (Number.isFinite(set.heightM)) building.height = set.heightM;
  if (set.heightSource === 'exact-top-or-fallback') {
    const exactTops = primitiveRows(exactSource.exact).flatMap((row) => {
      const position = exactPosition(row.raw);
      if (!position || !Number.isFinite(row.raw.top) || !inPoly([position.x, position.z], building.poly)) return [];
      const heightM = row.raw.top - terrainHeight(position.x, position.z);
      return [{ sourceId: `${row.collection}:${row.sourceId}`, kind: row.kind, topY: row.raw.top, heightM }];
    }).filter((candidate) => candidate.heightM >= (set.minimumExactHeightM ?? 0))
      .sort((a, b) => b.heightM - a.heightM || a.sourceId.localeCompare(b.sourceId));
    if (exactTops.length) {
      building.height = +exactTops[0].heightM.toFixed(2);
      building.heightEvidence = { method: 'exact-primitive-top', ...exactTops[0] };
    } else {
      building.heightEvidence = { method: 'manifest-fallback', heightM: building.height, reasonCode: 'no-qualifying-exact-top-in-footprint' };
    }
  }
}
function assertReviewedFeatures(stage, propsOut = []) {
  for (const definition of featureManifest.features) {
    const assignments = featureAssignments.filter((assignment) => assignment.definition === definition);
    const expected = definition.assert ?? {};
    if (expected.count != null && assignments.length !== expected.count) throw new Error(`${key}: ${definition.featureId} expected ${expected.count} assignments at ${stage}, got ${assignments.length}`);
    for (const { building } of assignments) {
      if (expected.floorCount != null && building.floors !== expected.floorCount) throw new Error(`${key}: ${definition.featureId} expected ${expected.floorCount} floors at ${stage}, got ${building.floors}`);
      if (expected.minHeightM != null && building.height < expected.minHeightM) throw new Error(`${key}: ${definition.featureId} expected height >=${expected.minHeightM} m at ${stage}, got ${building.height}`);
      if (expected.maxHeightM != null && building.height > expected.maxHeightM) throw new Error(`${key}: ${definition.featureId} expected height <=${expected.maxHeightM} m at ${stage}, got ${building.height}`);
      if (expected.style != null && building.style !== expected.style) throw new Error(`${key}: ${definition.featureId} expected style ${expected.style} at ${stage}, got ${building.style}`);
      if (expected.kind != null && building.kind !== expected.kind) throw new Error(`${key}: ${definition.featureId} expected kind ${expected.kind} at ${stage}, got ${building.kind}`);
      if (expected.notPlace != null && building.place === expected.notPlace) throw new Error(`${key}: ${definition.featureId} must not be labelled ${expected.notPlace}`);
      if (building.floors * 2.5 > building.height + 0.25) throw new Error(`${key}: ${definition.featureId} contradicts its own floor/height shell (${building.floors} floors, ${building.height} m)`);
    }
    if (expected.emitAsProp && stage === 'output') {
      const emitted = propsOut.filter((prop) => prop.featureRoot === definition.featureId && prop.type === expected.emitAsProp);
      if (emitted.length !== expected.count) throw new Error(`${key}: ${definition.featureId} expected ${expected.count} ${expected.emitAsProp} props, got ${emitted.length}`);
    }
  }
}
assertReviewedFeatures('post-height-fit');
// Route the non-ground vertical observations into a compact floor-classification
// index. The full exact-Y records remain in terrain.evidence.buckets; this index
// is the derived answer used by floor-aware geometry and future UI work.
const floorGroups = new Map();
for (const bucketName of ['floor', 'roof', 'underground']) for (const point of evidenceBuckets[bucketName]) {
  const building = buildingAt(point);
  const extent = floorBoxes.find((candidate) => point.x >= candidate.x1 && point.x <= candidate.x2 && point.z >= candidate.z1 && point.z <= candidate.z2
    && (!Number.isFinite(candidate.y?.[0]) || point.y >= Math.min(...candidate.y) - 1)
    && (!Number.isFinite(candidate.y?.[1]) || point.y <= Math.max(...candidate.y) + 1));
  const relativeY = point.y - terrainHeight(point.x, point.z);
  const floorIndex = bucketName === 'underground' ? 'U' : building
    ? Math.max(0, Math.min(Math.max(0, building.floors - 1), Math.round(relativeY / FLOOR_H)))
    : bucketName === 'roof' ? 'roof' : 0;
  const scope = building ? `building:${building.sourceKey ?? building.featureId ?? 'unknown'}`
    : extent ? `extent:${extent.layer}:${extent.name}`
      : `cell:${Math.floor(point.x / 20)},${Math.floor(point.z / 20)}`;
  const groupKey = `${scope}|${bucketName}|${floorIndex}`;
  if (!floorGroups.has(groupKey)) floorGroups.set(groupKey, {
    scope, classification: bucketName, floorIndex,
    ...(building?.featureId ? { featureId: building.featureId } : {}),
    ...(extent ? { layer: extent.layer, name: extent.name } : {}),
    points: [],
  });
  floorGroups.get(groupKey).points.push(point);
}
const floorSurfaces = [...floorGroups.values()].map(({ points, ...surface }) => ({
  ...surface,
  surfaceY: +median(points.map((point) => point.y)).toFixed(4),
  minY: +Math.min(...points.map((point) => point.y)).toFixed(4),
  maxY: +Math.max(...points.map((point) => point.y)).toFixed(4),
  evidenceSourceIds: points.map((point) => `${point.provider}:${point.sourceId}`).sort(),
})).sort((a, b) => a.scope.localeCompare(b.scope) || String(a.floorIndex).localeCompare(String(b.floorIndex)) || a.classification.localeCompare(b.classification));
console.log(`props ${props.length + svgProps.length}`);
console.log(`terrain ${cols}x${rows} @${STEP}m from ${groundPts.length}/${evidenceInput.length} points, buckets ${JSON.stringify(bucketCounts)}, range ${Math.min(...heights).toFixed(1)}..${Math.max(...heights).toFixed(1)} m`);
// drop anything whose centroid is outside the playable boundary
const insideC = (poly) => inside(centroid(poly));
const edgeDist = (pt) => ringDistance(pt, LIMIT).distance;
// towers hugging the boundary are outside the real playable area (the SVG limit is slightly generous)
const keepB = buildings.filter((b) => insideC(b.poly) && !(b.kind === 'powerline_towers' && edgeDist(centroid(b.poly)) < 10)); buildings.length = 0; buildings.push(...keepB);
const manifestProps = [];
for (const { definition, building } of featureAssignments) {
  const type = definition.set?.emitAsProp;
  if (!type) continue;
  const index = buildings.indexOf(building);
  if (index < 0) throw new Error(`${key}: ${definition.featureId} was clipped before ${type} prop conversion`);
  buildings.splice(index, 1);
  manifestProps.push({
    type, name: building.name, place: building.place, featureId: building.featureId,
    featureRoot: definition.featureId, poly: building.poly, h: building.height,
    sourceKey: building.sourceKey, evidence: definition.evidence,
  });
}
const propsIn = [...props, ...svgProps, ...manifestProps].filter((p) => p.poly ? insideC(p.poly) : (p.path ? inside(p.path[0]) : inside([p.x, p.z])));
assertReviewedFeatures('output', propsIn);
if (key === 'woods') for (const p of propsIn) if (/^Sawmill log stack/i.test(p.name || '')) p.color = [116, 88, 58];
const undergroundIn = underground.filter((u) => insideC(u.poly));
const rockPolys = (cfg.groups.rocks ? polysIn(cfg.groups.rocks) : []).filter(insideC);
const rockMasses = rockPolys.map((poly, index) => {
  const h = key === 'customs'
    ? Math.sqrt(area(poly)) * (0.15 + hash2(index + 17, 59) * 0.12)
    : Math.sqrt(area(poly)) * (key === 'reserve' ? 0.52 : 0.4);
  const evidence = rockEvidence.filter((p) => inPoly([p.x, p.z], poly));
  const observed = evidence.length ? Math.max(...evidence.map((p) => p.y - terrainHeight(p.x, p.z))) : 0;
  const cap = key === 'customs' ? 4.8 : key === 'reserve' ? 16 : evidence.length ? 42 : 12;
  const floor = key === 'customs' ? 0.8 : 1.6;
  return { poly, height: +Math.max(floor, Math.min(cap, Math.max(h, observed))).toFixed(1), evidence };
});
// Woods' largest SVG rocks describe whole ridges. A single full-height extrusion
// turns Sniper Rock and the mountain spine into flat monoliths, so retain a low
// base footprint and raise several separated, footprint-contained forms above it.
const distToRing = ([x, z], poly) => { let best = Infinity; for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length], dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2)); best = Math.min(best, Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz)); } return best; };
const distToPath = ([x, z], path) => { let best = Infinity; for (let i = 1; i < path.length; i++) { const a = path[i - 1], b = path[i], dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2)); best = Math.min(best, Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz)); } return best; };
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
const ROCK_COLORS = [[126, 122, 108], [112, 112, 102], [138, 130, 112], [102, 106, 98]];
const rocksRaw = key === 'woods' ? rockMasses.flatMap(splitWoodsRock) : rockMasses.map(({ evidence, ...rock }) => rock);
// Reviewed hard-rock regions replace, rather than stack on, the older decorative
// SVG extrusion at the same centroid. Otherwise the legacy form would be draped
// on the new summit surface and double the mountain's visible height.
const rocksOut = rocksRaw.filter((rock) => !hardRockRegions.some((region) => inPoly(centroid(rock.poly), region.poly)))
  .map((rock, index) => ({ ...rock, color: ROCK_COLORS[Math.floor(hash2(index + 101, 43) * ROCK_COLORS.length) % ROCK_COLORS.length] }));
// Hard rock is a separate canonical surface, not heightfield noise. A broad
// contact mass comes from the routed rock bucket; nested shoulder/summit caps
// land the reviewed exact-Y anchors without baking the renderer's relief skin.
const hardRocksOut = hardRockRegions.flatMap((region) => {
  const evidence = rockEvidence.filter((point) => inPoly([point.x, point.z], region.poly));
  const observedRises = evidence.map((point) => point.y - terrainHeight(point.x, point.z)).filter((rise) => rise > 0);
  const evidenceContact = observedRises.length ? percentile(observedRises, 0.25) : null;
  const contactHeight = +Math.max(region.contactRiseM, Math.min(region.contactRiseM + 4, evidenceContact ?? region.contactRiseM)).toFixed(4);
  const common = {
    featureRoot: region.featureId,
    name: region.name,
    evidenceSourceIds: evidence.map((point) => `${point.provider}:${point.sourceId}`).sort(),
  };
  const forms = [{ ...common, featureId: `${region.featureId}.contact`, form: 'contact', poly: region.poly, height: contactHeight, color: ROCK_COLORS[1] }];
  for (const [index, anchor] of region.anchors.entries()) {
    const rise = anchor.topY - terrainHeight(anchor.position[0], anchor.position[1]);
    if (rise <= 0) throw new Error(`${key}: ${anchor.name} exact top ${anchor.topY} is below fitted terrain`);
    const shoulderHeight = +Math.max(contactHeight + 1, contactHeight + (rise - contactHeight) * 0.58).toFixed(4);
    forms.push({
      ...common, featureId: `${region.featureId}.shoulder.${index + 1}`, form: 'shoulder',
      poly: circleRing(anchor.position, region.shoulderRadiusM, 2), height: shoulderHeight,
      anchor: anchor.position, topY: anchor.topY, sourceId: anchor.sourceId, color: ROCK_COLORS[2],
    });
    forms.push({
      ...common, featureId: `${region.featureId}.summit.${index + 1}`, form: 'summit',
      poly: circleRing(anchor.position, region.summitRadiusM, 1.5), height: +rise.toFixed(4),
      anchor: anchor.position, topY: anchor.topY, surfaceY: anchor.topY, sourceId: anchor.sourceId, color: ROCK_COLORS[0],
    });
  }
  return forms;
});
const hardRockSurface = (x, z) => Math.max(terrainHeight(x, z), ...hardRocksOut.filter((rock) => inPoly([x, z], rock.poly))
  .map((rock) => Number.isFinite(rock.surfaceY) ? rock.surfaceY : terrainHeight(x, z) + rock.height));
for (const region of hardRockRegions) for (const anchor of region.anchors) {
  const actual = hardRockSurface(anchor.position[0], anchor.position[1]);
  if (Math.abs(actual - anchor.topY) > 0.011) throw new Error(`${key}: ${anchor.name} hard-rock top is ${actual.toFixed(3)} m, expected ${anchor.topY.toFixed(3)} m`);
}
const anchorHeights = featureManifest.anchors.map((anchor) => ({
  name: anchor.name, position: anchor.position,
  terrainY: +terrainHeight(anchor.position[0], anchor.position[1]).toFixed(4),
  surfaceY: +hardRockSurface(anchor.position[0], anchor.position[1]).toFixed(4),
}));
const output = `public/data/${key}-3d.json`;
let builtAt = new Date().toISOString();
if (!process.argv.includes('--stamp')) { try { builtAt = JSON.parse(await readFile(output, 'utf8')).builtAt || builtAt; } catch {} }
const treePolys = (cfg.groups.trees ? polysIn(cfg.groups.trees) : []).filter(insideC);
if (cfg.proceduralTrees) {
  // Woods' SVG has no tree group. Use broad deterministic canopy clusters, kept away
  // from mapped roads/water/buildings, instead of pretending to trace every satellite dot.
  const step = 55;
  for (let z = BOUNDS.zMin + 20, j = 0; z <= BOUNDS.zMax - 20; z += step, j++) for (let x = BOUNDS.xMin + 20, i = 0; x <= BOUNDS.xMax - 20; x += step, i++) {
    if (hash2(i + 71, j + 113) < 0.62 || !inside([x, z]) || overWater([x, z]) || buildings.some((b) => inPoly([x, z], b.poly))) continue;
    if (roads.some((r) => r.path.some((q) => Math.hypot(q[0] - x, q[1] - z) < r.width / 2 + 9))) continue;
    const rx = 7 + hash2(i + 5, j + 19) * 8, rz = 7 + hash2(i + 29, j + 3) * 8;
    const poly = Array.from({ length: 12 }, (_, k) => { const a = (k / 12) * Math.PI * 2, wobble = 0.82 + hash2(i * 13 + k, j * 17 - k) * 0.32; return [+(x + Math.cos(a) * rx * wobble).toFixed(1), +(z + Math.sin(a) * rz * wobble).toFixed(1)]; });
    if (insideC(poly)) treePolys.push(poly);
  }
}
// The SVG canopy rings are only a forest mask. Rendering them as raised slabs created the
// reviewed green puzzle pieces. Retain them as a quiet understory tint and fill each ring with
// deterministic individual crowns. Forest is deliberately open overall, while an edge-depth
// acceptance bias gathers more crowns in each canopy polygon's core. Crown extents (not merely
// their centres) stay at least 3 m from every road edge and building footprint.
const totalTreeArea = treePolys.reduce((sum, poly) => sum + area(poly), 0);
const wantedTrees = key === 'customs'
  ? Math.min(3200, Math.round(totalTreeArea * 0.115))
  : Math.min(key === 'woods' ? 2600 : 1800, Math.round(totalTreeArea * (key === 'woods' ? 0.045 : 0.065)));
const treeDensity = totalTreeArea ? wantedTrees / totalTreeArea : 0;
const TREE_COLORS = [[57, 80, 52], [68, 91, 58], [79, 103, 64]];
const treeCrowns = [];
for (let index = 0; index < treePolys.length; index++) {
  const poly = treePolys[index], [x1, z1, x2, z2] = bbox(poly);
  const count = Math.max(1, Math.round(area(poly) * treeDensity));
  let accepted = 0;
  for (let attempt = 0; accepted < count && attempt < count * 80; attempt++) {
    const x = x1 + hash2(index * 100003 + attempt * 17, 211) * (x2 - x1);
    const z = z1 + hash2(index * 70001 + attempt * 29, 307) * (z2 - z1);
    if (!inPoly([x, z], poly) || overWater([x, z])) continue;
    const edgeDepth = distToRing([x, z], poly);
    const coreScale = Math.max(3, Math.min(x2 - x1, z2 - z1) * 0.24);
    const coreWeight = 0.28 + 0.72 * Math.min(1, edgeDepth / coreScale);
    if (hash2(index * 17011 + attempt * 47, 353) > coreWeight) continue;
    const coniferChance = key === 'woods' ? 0.64 : key === 'reserve' ? 0.42 : 0.5;
    const type = hash2(index * 271 + attempt, 389) < coniferChance ? 'conifer' : 'broadleaf';
    const radius = type === 'conifer'
      ? 1.8 + hash2(index * 313 + attempt, 401) * 0.9
      : 2 + hash2(index * 313 + attempt, 401) * 1.2;
    // Leave a small generation margin so one-decimal JSON rounding cannot eat into 3 m.
    const clearance = radius + 3.2;
    if (buildings.some((b) => inPoly([x, z], b.poly) || distToRing([x, z], b.poly) < clearance)) continue;
    if (roads.some((r) => distToPath([x, z], r.path) < r.width / 2 + clearance)) continue;
    const height = type === 'conifer'
      ? 8 + hash2(index * 431 + attempt, 503) * 4
      : 6 + hash2(index * 431 + attempt, 503) * 3;
    const color = TREE_COLORS[Math.floor(hash2(index * 541 + attempt, 601) * TREE_COLORS.length) % TREE_COLORS.length];
    treeCrowns.push({
      x: +x.toFixed(1), z: +z.toFixed(1), type,
      radius: +radius.toFixed(1), height: +height.toFixed(1),
      trunkRadius: +(0.15 + hash2(index * 653 + attempt, 677) * 0.1).toFixed(2),
      trunkHeight: +(2 + hash2(index * 691 + attempt, 709)).toFixed(1),
      aspect: +(0.84 + hash2(index * 733 + attempt, 751) * 0.3).toFixed(2),
      rotation: +Math.round(hash2(index * 773 + attempt, 797) * 359),
      lodKeep: hash2(index * 811 + attempt, 829) >= 0.5,
      color,
    });
    accepted++;
  }
}
const out = {
  map: key, builtAt,
  source: 'tarkov.dev exact JSON cache + tarkov.dev SVG/maps.json + SPT 4.1.2 spawn/loot elevation + reviewed feature manifests',
  canonicalScale: 1,
  exact: exactSource.exact,
  features: {
    schemaVersion: featureManifest.schemaVersion,
    manifestSha256: createHash('sha256').update(stableStringify(featureManifest)).digest('hex'),
    assignments: featureAssignments.map(({ definition, building }) => ({
      featureRoot: definition.featureId, featureId: building.featureId,
      sourceKey: building.sourceKey, class: building.featureClass, kind: building.kind,
      name: building.name, place: building.place, floors: building.floors, heightM: building.height,
      emittedAs: definition.set?.emitAsProp ?? 'building',
    })),
    anchors: anchorHeights,
  },
  props: propsIn, terrain, floorSurfaces, hardRocks: hardRocksOut, bridges, limit: LIMIT,
  land: [LIMIT], water: out0.water, pavement: (cfg.groups.pavement ? polysIn(cfg.groups.pavement) : []).filter(insideC), understory: treePolys, trees: treeCrowns, rocks: rocksOut,
  roads, railway: clipLines((cfg.groups.railway ? linesIn(cfg.groups.railway) : []).map((p) => ({ path: p }))), fences: fencesCut, powerlines: clipLines((cfg.groups.powerlines ? linesIn(cfg.groups.powerlines) : []).map((p) => ({ path: p }))),
  buildings, underground: undergroundIn, floorBoxes,
};
if (yards.length) out.yards = yards;
if (cfg.groups.minefield) out.minefields = polysIn(cfg.groups.minefield).filter(insideC);
await writeFile(output, JSON.stringify(out));
const multi = buildings.filter((b) => b.floors > 1);
console.log(`styles: ${JSON.stringify(buildings.reduce((a, b) => ((a[b.style] = (a[b.style] || 0) + 1), a), {}))}`);
console.log(`bridges ${bridges.length} (${bridges.map((b) => (b.name || b.kind) + (b.ford ? ' [ford]' : '')).join(', ')}), named ${buildings.filter((b) => b.place).length}, coloured ${buildings.filter((b) => b.color).length}`);
console.log(`buildings ${buildings.length} (multi-floor ${multi.length}: ${multi.map((b) => `${b.name}×${b.floors}`).join(', ')}), trees ${out.trees.length}, rocks ${out.rocks.length}+${out.hardRocks.length} hard, floor surfaces ${out.floorSurfaces.length}, roads ${roads.length}, water ${out.water.length}, land ${out.land.length} → ${output} (${(JSON.stringify(out).length / 1024).toFixed(0)} KB)`);
