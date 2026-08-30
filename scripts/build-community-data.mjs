// Build public/data/<map>.json from the verified tarkov.dev exact cache, then
// merge SPT/Wiki witnesses and additions without replacing exact primitives.
// Wiki pixels have only visual X/Z; SPT and tarkov.dev retain game X/Y/Z.
// Output matches the shape of the tarkov.dev GraphQL response used by src/api.js.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadExactMap, stableStringify, translateExact } from './lib/exact-map-primitives.mjs';

const WIKI_CONTAINER_TYPES = new Set([
  'container_stash', 'container_weapon', 'container_crate', 'container_greencrate',
  'container_duffle', 'container_jacket', 'container_supply', 'container_safe',
  'container_cash', 'container_pc', 'container_drawer', 'container_tool',
  'container_medcase', 'container_medical', 'container_ammo', 'container_grenade',
  'container_dead', 'loot_key', 'loot_loose',
]);
// These symbols must belong to the calibrated surface sheet. Reserve and Woods
// also contain detached floor/bunker panels that need their own future affine.
const CALIBRATED_WIKI_TYPES = new Set(['locked', ...WIKI_CONTAINER_TYPES]);
const SPT_LOOSE_RADIUS = 6;
const SPT_LOOSE_MAX = 1500;

const BOSS_NAMES = {
  bossBully: 'Reshala', bossGluhar: 'Glukhar', bossKojaniy: 'Shturman', bossKnight: 'Knight',
  followerBigPipe: 'Big Pipe', followerBirdEye: 'Birdeye', bossPartisan: 'Partisan',
  sectantPriest: 'Cultist Priest', gifter: 'Santa', bossKilla: 'Killa', bossTagilla: 'Tagilla',
};

const CONFIG = {
  customs: {
    name: 'Customs',
    spt: 'scripts/spt-bigmap-base.json',
    maps: 'scripts/tarkov-dev-maps.json',
    // Customs has no checked-in raw wiki response yet; retain the online fallback used by the original builder.
    wikiUrl: 'https://escapefromtarkov.fandom.com/api.php?action=query&prop=revisions&titles=Map:Customs&rvslots=main&rvprop=content&format=json',
    calibration: [
      { title: 'ZB-1011', game: [628, -131] },
      { title: "Smugglers' Bunker (ZB-1012)", game: [466, -116] },
      { title: 'ZB-013', game: [206, -148] },
      { title: 'Old Gas Station', game: [311, -178] },
    ],
    axisAligned: true,
    // Frozen against the checked-in Customs snapshot. The live Wiki image width
    // shifted slightly after the original calibration; keeping this affine makes
    // the regression gate change only through the newly emitted level fields.
    affine: { x: [-0.24374729, 0, 674.1179914778126], z: [0, -0.2611668507, 282.5499042] },
    // Underground extents in maps.json identify the bunker/basement panels. These
    // names cover entrances whose calibrated Wiki point sits just outside the box.
    levelOverrides: {
      extract: {
        'ZB-1011': 'underground', "Smugglers' Bunker (ZB-1012)": 'underground',
        'ZB-013': 'underground', 'Old Gas Station': 'underground',
        'Boiler Room Basement (Co-op)': 'underground',
      },
      lock: {
        "Tarcone Director's Office": 'upper', 'Dorm Room 206': 'upper',
        'Dorm Room 220': 'upper', 'Dorm Room 218': 'upper', 'Dorm Room 214': 'upper',
        'Dorm Room 203': 'upper', 'Dorm Room 204': 'upper', 'Dorm Room 303': 'upper',
        'Dorm Room 306': 'upper', 'Dorm Room 315': 'upper', 'Dorm Room 308': 'upper',
        'Marked Dorm Room 314': 'upper', "Company Director's Room": 'upper',
      },
      switch: { 'ZB-013 power lever': 'upper' },
    },
  },
  reserve: {
    name: 'Reserve', spt: 'scripts/data/reserve/spt-base.json', wiki: 'scripts/data/reserve/wiki-map.json', maps: 'scripts/data/reserve/maps-entry.json',
    // Surface-sheet PMC symbols matched to the corresponding SPT Player-spawn clusters.
    // The wiki image is rotated/skewed and also contains separate building/bunker inset panels,
    // so this full affine is deliberately fitted only from the authoritative surface panel.
    calibration: [
      { id: '378', game: [145.77, 38.12] },
      { id: '379', game: [58.81, 64.69] },
      { id: '380', game: [24.21, 6.41] },
      { id: '381', game: [189.43, -101.33] },
      { id: '383', game: [168.88, -166.60] },
      { id: '384', game: [164.00, -234.91] },
      { id: '385', game: [63.68, -171.99] },
      { id: '386', game: [-35.62, -166.34] },
      { id: '387', game: [-135.94, -129.99] },
      { id: '388', game: [87.04, -32.72] },
      { id: '389', game: [-117.59, -23.11] },
      { id: '392', game: [-48.57, 16.37] },
      { id: '393', game: [-75.88, 192.95] },
    ],
    overrides: {
      'D-2': [-82, 157],
      'D-2 power lever': [-92, 27],
      'D-2 sliding door button': [-82, 157],
      'Bunker Hermetic Door': [48, -184],
      'Depot Hermetic Door': [141, 25],
    },
    include: (m) => !(CALIBRATED_WIKI_TYPES.has(m.categoryId)
      && !(m.position[0] >= 374 && m.position[0] <= 3100 && m.position[1] >= 350 && m.position[1] <= 2420)),
    // D-2 and both Hermetic exits fall inside authoritative negative-Y Bunkers
    // extents. The Hermetic power lever is the explicit surface exception: it is
    // in the shack west of White Pawn even though its X/Z overlaps the tunnels.
    levelOverrides: {
      extract: { 'D-2': 'underground', 'Bunker Hermetic Door': 'underground', 'Depot Hermetic Door': 'underground', 'Cliff Descent': 'surface' },
      switch: { 'Bunker Hermetic Door power lever': 'surface', 'D-2 power lever': 'underground', 'D-2 sliding door button': 'underground' },
      lock: { 'RB-KPRL': 'upper' },
    },
  },
  woods: {
    name: 'Woods', spt: 'scripts/data/woods/spt-base.json', wiki: 'scripts/data/woods/wiki-map.json', maps: 'scripts/data/woods/maps-entry.json',
    // Mutual-nearest matches between current wiki PMC markers and current SPT Player points.
    calibration: [
      { id: '4', game: [487.358643, 328.52] },
      { id: '8', game: [367.74, -73.79001] },
      { id: '19', game: [-492.41, -50.23001] },
      { id: '24', game: [-524.17, 220.33] },
      { id: '16', game: [-413.22, -522.429932] },
      { id: '21', game: [-331.468018, -138.725983] },
    ],
    include: (m) => !(CALIBRATED_WIKI_TYPES.has(m.categoryId) && m.position[0] < 500), // ZB-014 inset panel
  },
};

const key = (process.argv.slice(2).find((a) => !a.startsWith('-')) || 'customs').toLowerCase();
const cfg = CONFIG[key];
if (!cfg) throw new Error(`unknown map ${key}; expected ${Object.keys(CONFIG).join(', ')}`);
const stamp = process.argv.includes('--stamp');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

const exactSource = await loadExactMap(key);
const spt = JSON.parse(await readFile(cfg.spt, 'utf8'));
const mapFamily = JSON.parse(await readFile(cfg.maps, 'utf8'));
const mapEntry = (Array.isArray(mapFamily) ? mapFamily.find((m) => m.normalizedName === key) : mapFamily)?.maps?.find((m) => m.key === key);
if (!mapEntry) throw new Error(`missing maps.json entry for ${key}`);
let wiki;
if (cfg.wiki) wiki = JSON.parse(await readFile(cfg.wiki, 'utf8'));
else {
  const res = await fetch(cfg.wikiUrl, { headers: { 'User-Agent': UA } }).then((r) => r.json());
  wiki = JSON.parse(Object.values(res.query.pages)[0].revisions[0].slots.main['*']);
}

const titleOf = (m) => (m.popup?.title || '').trim();
const markerFor = (c) => wiki.markers.find((m) => (c.id && String(m.id) === String(c.id)) || (c.title && titleOf(m) === c.title));
const pairs = cfg.calibration.map((c) => ({ ...c, marker: markerFor(c) }));
if (pairs.some((p) => !p.marker)) throw new Error(`missing calibration marker(s): ${pairs.filter((p) => !p.marker).map((p) => p.title || p.id).join(', ')}`);

function fit1d(ps, wi, gi) { // least squares y = a*x + b
  const n = ps.length, sx = ps.reduce((s, p) => s + p.marker.position[wi], 0), sy = ps.reduce((s, p) => s + p.game[gi], 0);
  const sxx = ps.reduce((s, p) => s + p.marker.position[wi] ** 2, 0), sxy = ps.reduce((s, p) => s + p.marker.position[wi] * p.game[gi], 0);
  const a = (n * sxy - sx * sy) / (n * sxx - sx * sx); return [a, (sy - a * sx) / n];
}
function solve3(A, b) {
  const m = A.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < 3; i++) {
    let p = i; for (let j = i + 1; j < 3; j++) if (Math.abs(m[j][i]) > Math.abs(m[p][i])) p = j;
    [m[i], m[p]] = [m[p], m[i]]; const d = m[i][i]; if (Math.abs(d) < 1e-9) throw new Error('singular calibration');
    for (let k = i; k < 4; k++) m[i][k] /= d;
    for (let j = 0; j < 3; j++) if (j !== i) { const f = m[j][i]; for (let k = i; k < 4; k++) m[j][k] -= f * m[i][k]; }
  }
  return m.map((r) => r[3]);
}
function fitAffine(ps, gi) { // least squares game = a*wx + b*wy + c
  const A = ps.map((p) => [p.marker.position[0], p.marker.position[1], 1]);
  const ata = Array.from({ length: 3 }, (_, i) => Array.from({ length: 3 }, (_, j) => A.reduce((s, r) => s + r[i] * r[j], 0)));
  const atb = Array.from({ length: 3 }, (_, i) => A.reduce((s, r, k) => s + r[i] * ps[k].game[gi], 0));
  return solve3(ata, atb);
}
const fx = cfg.affine?.x ? [...cfg.affine.x] : cfg.axisAligned ? [...fit1d(pairs, 0, 0), 0] : fitAffine(pairs, 0);
const fz = cfg.affine?.z ? [...cfg.affine.z] : cfg.axisAligned ? [0, ...fit1d(pairs, 1, 1)] : fitAffine(pairs, 1);
if (cfg.axisAligned && !cfg.affine) { // normalize to [wx, wy, constant]
  fx.splice(1, 0, 0); fx.length = 3;
  const [, a, b] = fz; fz[0] = 0; fz[1] = a; fz[2] = b;
}
const affine = ([wx, wy]) => ({ x: fx[0] * wx + fx[1] * wy + fx[2], z: fz[0] * wx + fz[1] * wy + fz[2] });
const toGame = (m) => {
  const override = cfg.overrides?.[titleOf(m)];
  const p = override ? { x: override[0], z: override[1] } : affine(m.position);
  // Wiki sheets have no vertical coordinate. Omitting Y is honest; zero was a
  // fabricated surface that later contaminated level/elevation decisions.
  return { x: +p.x.toFixed(1), z: +p.z.toFixed(1) };
};
const VALID_LEVELS = new Set(['surface', 'underground', 'rooftop', 'upper']);
const floorExtents = (mapEntry.layers || []).flatMap((layer) => (layer.extents || []).flatMap((ext) => (ext.bounds || []).map((bounds) => ({
  layer: layer.name, height: ext.height, bounds,
}))));
const inExtent = (p, ext) => {
  const [a, b] = ext.bounds;
  return p.x >= Math.min(a[0], b[0]) && p.x <= Math.max(a[0], b[0])
    && p.z >= Math.min(a[1], b[1]) && p.z <= Math.max(a[1], b[1]);
};
function levelFor(m, type, position) {
  const title = titleOf(m);
  const override = cfg.levelOverrides?.[type]?.[title];
  if (override) return override;
  if (type === 'container') {
    const detail = `${title} ${cleanWikiNote(m.popup?.description)}`;
    if (/\broof(?:top)?\b/i.test(detail)) return 'rooftop';
    if (/\b(?:second|third|2nd|3rd|upper) floor\b|\bupstairs\b|\bon the tower\b/i.test(detail)) return 'upper';
    if (/\bunderground\b|\bbasement\b|\bbunker\b|\btunnel\b/i.test(detail)) return 'underground';
  }
  // The named underground/Bunkers layers carry negative-Y extents. Check the
  // panel name as well as height so above-ground Reserve buildings whose absolute
  // floors happen to be below Y=0 are never mistaken for tunnels.
  if (type !== 'extract' && floorExtents.some((ext) => /underground|bunkers/i.test(ext.layer) && ext.height?.[1] <= 18 && inExtent(position, ext))) return 'underground';
  return 'surface';
}
function sptLevelFor(position) {
  // SPT points carry real Y, unlike Wiki pixels. Use it to avoid classifying
  // surface loot above a bunker footprint as underground.
  return floorExtents.some((ext) => /underground|bunkers/i.test(ext.layer) && inExtent(position, ext)
    && Number.isFinite(ext.height?.[0]) && Number.isFinite(ext.height?.[1])
    && position.y >= Math.min(...ext.height) - 0.75 && position.y <= Math.max(...ext.height) + 0.75)
    ? 'underground' : 'surface';
}
const withLevel = (m, type) => {
  const position = toGame(m), level = levelFor(m, type, position);
  if (!VALID_LEVELS.has(level)) throw new Error(`${key}: invalid ${type} level ${level} for ${titleOf(m)}`);
  return { position, level };
};
for (const p of pairs) {
  const q = affine(p.marker.position), err = Math.hypot(q.x - p.game[0], q.z - p.game[1]);
  console.log(`calib ${p.title || `marker ${p.id}`}: ${q.x.toFixed(1)},${q.z.toFixed(1)} vs ${p.game} (err ${err.toFixed(1)} m)`);
}
console.log(`affine x=[${fx.map((x) => x.toPrecision(10)).join(', ')}], z=[${fz.map((x) => x.toPrecision(10)).join(', ')}]`);

const markers = wiki.markers.filter((m) => !cfg.include || cfg.include(m));
const wikiExtracts = [];
for (const m of markers) {
  if (!m.categoryId.startsWith('exfil')) continue;
  const faction = { exfil_pmc: 'pmc', exfil_scav: 'scav', exfil_transit: 'transit' }[m.categoryId];
  const name = titleOf(m);
  const note = (m.popup.description || '').replace(/\[\[File:[^\]]*\]\]/g, '').replace(/\[\[([^\]|]*)(\|[^\]]*)?\]\]/g, '$1').trim();
  const located = withLevel(m, 'extract');
  const same = wikiExtracts.find((e) => e.name === name && e.faction !== faction && e.faction !== 'transit' && faction !== 'transit');
  if (same) {
    if (same.level !== located.level) throw new Error(`${key}: conflicting levels for merged extract ${name}`);
    same.faction = 'shared'; continue;
  }
  wikiExtracts.push({ id: `wiki-${m.id}`, sourceId: String(m.id), source: 'eft-wiki', name, faction, level: located.level, note, position: located.position });
}

const sptSpawns = spt.SpawnPointParams.map((s) => {
  const cats = s.Categories.map((c) => c.toLowerCase());
  const sides = s.Sides.map((c) => ({ pmc: 'pmc', savage: 'scav', all: 'all' }[c.toLowerCase()] ?? c.toLowerCase()));
  const categories = [];
  if (cats.includes('player')) categories.push('player');
  if (cats.includes('boss')) categories.push('boss');
  if (cats.includes('bot') && !cats.includes('boss')) categories.push(s.BotZoneName?.toLowerCase().includes('snipe') ? 'sniper' : 'scav');
  return {
    sourceId: `generated:${createHash('sha256').update(stableStringify(s)).digest('hex').slice(0, 24)}`,
    source: 'spt-4.1.2',
    position: { x: s.Position.x, y: s.Position.y, z: s.Position.z },
    sides, categories, zoneName: s.BotZoneName || null,
  };
});
const bosses = Object.values(spt.BossLocationSpawn.reduce((acc, b) => {
  if (b.BossName.startsWith('pmc') || b.BossChance === 0 || b.BossName === 'arenaFighterEvent') return acc;
  const name = BOSS_NAMES[b.BossName] ?? b.BossName;
  acc[name] ??= { name, spawnChance: b.BossChance / 100, spawnLocations: [] };
  for (const z of (b.BossZone || '').split(',').filter(Boolean)) acc[name].spawnLocations.push({ name: z, chance: 1 });
  return acc;
}, {}));

const wikiLocks = markers.filter((m) => m.categoryId === 'locked').map((m) => ({ sourceId: String(m.id), source: 'eft-wiki', lockType: 'door', key: { name: titleOf(m) }, ...withLevel(m, 'lock') }));
const wikiStationaryWeapons = markers.filter((m) => m.categoryId === 'stationarygun').map((m) => ({ sourceId: String(m.id), source: 'eft-wiki', stationaryWeapon: { name: titleOf(m) }, position: toGame(m) }));
const wikiSwitches = markers.filter((m) => m.categoryId === 'lever').map((m) => ({ sourceId: String(m.id), source: 'eft-wiki', name: titleOf(m), ...withLevel(m, 'switch') }));

function cleanWikiNote(raw = '') {
  return raw
    .replace(/\[\[File:[^\]]*\]\]/gi, '')
    .replace(/\[\[([^\]|]*)(\|[^\]]*)?\]\]/g, '$1')
    .replace(/<\/?br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .split(/\n+/).map((line) => line.trim()).filter(Boolean).join('\n');
}

const wikiContainers = markers.filter((m) => WIKI_CONTAINER_TYPES.has(m.categoryId)).map((m) => {
  const note = cleanWikiNote(m.popup?.description);
  return {
    sourceId: String(m.id),
    source: 'eft-wiki',
    type: m.categoryId,
    name: titleOf(m) || m.categoryId,
    ...withLevel(m, 'container'),
    ...(note ? { note } : {}),
  };
});

function thinLooseLoot(points) {
  const [[ax, az], [bx, bz]] = mapEntry.bounds;
  const minX = Math.min(ax, bx), maxX = Math.max(ax, bx), minZ = Math.min(az, bz), maxZ = Math.max(az, bz);
  const sorted = points
    .filter((p) => Array.isArray(p) && p.length >= 3 && p.slice(0, 3).every(Number.isFinite)
      && p[0] >= minX && p[0] <= maxX && p[2] >= minZ && p[2] <= maxZ)
    // Cluster the exact coordinates that will be emitted so one-decimal JSON
    // rounding cannot move two retained points back inside the 6 m radius.
    .map(([x, y, z]) => [+x.toFixed(1), +y.toFixed(1), +z.toFixed(1)])
    .sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1]);
  const grid = new Map(), accepted = [];
  for (const p of sorted) {
    const gx = Math.floor(p[0] / SPT_LOOSE_RADIUS), gz = Math.floor(p[2] / SPT_LOOSE_RADIUS);
    let clustered = false;
    for (let dx = -1; dx <= 1 && !clustered; dx++) for (let dz = -1; dz <= 1 && !clustered; dz++) {
      for (const i of grid.get(`${gx + dx},${gz + dz}`) ?? []) {
        const q = accepted[i];
        if (Math.hypot(p[0] - q[0], p[2] - q[2]) <= SPT_LOOSE_RADIUS) { clustered = true; break; }
      }
    }
    if (clustered) continue;
    const index = accepted.push(p) - 1, cell = `${gx},${gz}`;
    if (!grid.has(cell)) grid.set(cell, []);
    grid.get(cell).push(index);
  }
  if (accepted.length <= SPT_LOOSE_MAX) return accepted;
  return Array.from({ length: SPT_LOOSE_MAX }, (_, i) => accepted[Math.floor(i * accepted.length / SPT_LOOSE_MAX)]);
}

let sptLoose = [];
try {
  const loose = JSON.parse(await readFile(`scripts/data/${key}/loose-loot-samples.json`, 'utf8'));
  if (loose.map && loose.map !== key) throw new Error(`loose-loot map is ${loose.map}`);
  sptLoose = thinLooseLoot(loose.points ?? []).map(([x, y, z]) => {
    const position = { x: +x.toFixed(1), y: +y.toFixed(1), z: +z.toFixed(1) };
    return {
      sourceId: `generated:${createHash('sha256').update(`${x},${y},${z}`).digest('hex').slice(0, 24)}`,
      source: 'spt-4.1.2', type: 'loot_spt', name: 'Loose loot (SPT)', position, level: sptLevelFor(position),
    };
  });
} catch (e) {
  if (e?.code !== 'ENOENT') throw new Error(`${key}: invalid SPT loose-loot samples: ${e.message}`);
}

// ---- exact cache -> renderer markers ---------------------------------------------------
// The raw records themselves are serialized once in <map>-3d.json. This projection
// keeps full-precision coordinates/volumes and only adds renderer-facing names,
// levels and provenance. Wiki/SPT can corroborate or add records, never replace it.
const exactItems = (collection) => exactSource.exact.collections[collection] ?? [];
const provenance = (item, kind) => ({ source: 'tarkov.dev-json', sourceKind: kind, sourceId: item.sourceId });
const volume = (raw) => ({
  position: structuredClone(raw.position),
  ...(raw.size ? { size: structuredClone(raw.size) } : {}),
  ...(raw.outline ? { outline: structuredClone(raw.outline) } : {}),
  ...(Number.isFinite(raw.top) ? { top: raw.top } : {}),
  ...(Number.isFinite(raw.bottom ?? raw.botom) ? { bottom: raw.bottom ?? raw.botom } : {}),
});
function exactLevel(type, name, position) {
  const override = cfg.levelOverrides?.[type]?.[name];
  if (override) return override;
  const matches = floorExtents.filter((ext) => inExtent(position, ext)
    && Number.isFinite(position.y) && Number.isFinite(ext.height?.[0]) && Number.isFinite(ext.height?.[1])
    && position.y >= Math.min(...ext.height) - 0.75 && position.y <= Math.max(...ext.height) + 0.75);
  if (matches.some((ext) => /underground|bunkers/i.test(ext.layer))) return 'underground';
  if (matches.some((ext) => !/ground|underground|bunkers/i.test(ext.layer))) return 'upper';
  return 'surface';
}
const exactExtracts = [
  ...exactItems('extracts').map((item) => {
    const raw = item.raw, name = translateExact(raw.name, exactSource.translations);
    return { ...provenance(item, 'extract'), id: raw.id, name, faction: raw.faction, level: exactLevel('extract', name, raw.position), ...volume(raw) };
  }),
  ...exactItems('transits').map((item) => {
    const raw = item.raw, name = translateExact(raw.description, exactSource.translations);
    return { ...provenance(item, 'transit'), id: `transit-${raw.id}`, name, faction: 'transit', level: exactLevel('extract', name, raw.position), targetMapId: raw.map, ...volume(raw) };
  }),
];
const exactSpawns = exactItems('spawns').map((item) => ({
  ...provenance(item, 'spawn'), position: structuredClone(item.raw.position),
  sides: structuredClone(item.raw.sides ?? []), categories: structuredClone(item.raw.categories ?? []), zoneName: item.raw.zoneName ?? null,
}));
const exactLocks = exactItems('locks').map((item) => {
  const raw = item.raw, name = translateExact(raw.key, exactSource.translations, ' Name');
  return {
    ...provenance(item, 'lock'), id: raw.id, lockType: raw.lockType, key: { id: raw.key, name },
    needsPower: raw.needsPower, level: exactLevel('lock', name, raw.position), ...volume(raw),
  };
});
const exactSwitches = exactItems('switches').map((item) => {
  const raw = item.raw, name = translateExact(raw.name, exactSource.translations);
  return { ...provenance(item, 'switch'), id: raw.id, name, switchType: raw.switchType, level: exactLevel('switch', name, raw.position), ...volume(raw) };
});
const exactHazards = exactItems('hazards').map((item) => {
  const raw = item.raw;
  return { ...provenance(item, 'hazard'), id: raw.id, name: translateExact(raw.name, exactSource.translations), hazardType: raw.hazardType, ...volume(raw) };
});
const artilleryZones = exactItems('artilleryZones').map((item) => ({
  ...provenance(item, 'artilleryZone'), id: item.raw.id, name: `Artillery zone ${item.raw.id}`, hazardType: 'artillery', ...volume(item.raw),
}));
const exactStationaryWeapons = exactItems('stationaryWeapons').map((item) => {
  const raw = item.raw, lookup = exactSource.lookups.stationaryWeapons[raw.stationaryWeapon] ?? {};
  const name = translateExact(lookup.name ?? raw.stationaryWeapon, exactSource.translations, lookup.name ? '' : ' Name');
  return {
    ...provenance(item, 'stationaryWeapon'),
    stationaryWeapon: { id: raw.stationaryWeapon, name, ...(lookup.normalizedName ? { normalizedName: lookup.normalizedName } : {}) },
    position: structuredClone(raw.position),
  };
});
const exactContainers = [
  ...exactItems('lootContainers').map((item) => {
    const raw = item.raw, lookup = exactSource.lookups.lootContainers[raw.lootContainer] ?? {};
    const normalized = lookup.normalizedName?.replace(/-/g, '_') ?? 'unknown';
    const name = translateExact(lookup.name ?? raw.lootContainer, exactSource.translations, lookup.name ? '' : ' Name');
    return {
      ...provenance(item, 'lootContainer'), type: `container_${normalized}`, name,
      lootContainerId: raw.lootContainer, position: structuredClone(raw.position), level: exactLevel('container', name, raw.position),
    };
  }),
  ...exactItems('lootLoose').map((item) => ({
    ...provenance(item, 'looseLoot'), type: 'loot_loose', name: 'Loose loot',
    position: structuredClone(item.raw.position), items: structuredClone(item.raw.items ?? []),
    level: exactLevel('container', 'Loose loot', item.raw.position),
  })),
];
const btrStops = exactItems('btrStops').map((item) => ({
  ...provenance(item, 'btrStop'), name: translateExact(item.raw.name, exactSource.translations),
  position: { x: item.raw.x, y: item.raw.y, z: item.raw.z },
}));

const normalName = (value) => String(value ?? '').toLowerCase().replace(/\b(?:the|key|room|door)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const distance = (a, b) => a?.position && b?.position && Number.isFinite(a.position.x) && Number.isFinite(a.position.z)
  && Number.isFinite(b.position.x) && Number.isFinite(b.position.z)
  ? Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z) : Infinity;
function mergeSecondary(authoritative, secondary, { radius, identity = () => '', distanceOnly = false, approximate = false }) {
  const outputRows = authoritative.map((row) => ({ ...row }));
  for (const row of secondary) {
    const rowIdentity = normalName(identity(row));
    const hit = outputRows.find((candidate) => {
      const sameId = row.id != null && candidate.id != null && String(row.id) === String(candidate.id);
      const candidateIdentity = normalName(identity(candidate));
      const semanticMatch = distanceOnly || !rowIdentity || !candidateIdentity || rowIdentity === candidateIdentity
        || rowIdentity.includes(candidateIdentity) || candidateIdentity.includes(rowIdentity);
      // Cross-provider display names are witnesses, not global identities: the
      // same key/container/extract can legitimately occur more than once. Only
      // a source ID match or a semantic match inside the spatial radius dedupes.
      return sameId || (distance(candidate, row) <= radius && semanticMatch);
    });
    if (hit) {
      const witness = `${row.source}:${row.sourceId}`;
      hit.corroboratedBy = [...new Set([...(hit.corroboratedBy ?? []), witness])];
    } else outputRows.push({ ...row, ...(approximate ? { visualApproximate: true } : {}) });
  }
  return outputRows;
}

const extracts = mergeSecondary(exactExtracts, wikiExtracts, { radius: 12, identity: (row) => row.name, approximate: true });
const spawns = mergeSecondary(exactSpawns, sptSpawns, { radius: 0.35, distanceOnly: true });
const locks = mergeSecondary(exactLocks, wikiLocks, { radius: 12, identity: (row) => row.key?.name, approximate: true });
const switches = mergeSecondary(exactSwitches, wikiSwitches, { radius: 12, identity: (row) => row.name, approximate: true });
const stationaryWeapons = mergeSecondary(exactStationaryWeapons, wikiStationaryWeapons, { radius: 12, identity: (row) => row.stationaryWeapon?.name, approximate: true });
const containers = mergeSecondary(exactContainers, [...wikiContainers, ...sptLoose], {
  radius: 7.5, identity: (row) => row.name, distanceOnly: true, approximate: false,
}).map((row) => row.source === 'eft-wiki' ? { ...row, visualApproximate: true } : row);
const hazards = [...exactHazards, ...artilleryZones];

const output = `public/data/${key}.json`;
let builtAt = new Date().toISOString();
if (!stamp) { try { builtAt = JSON.parse(await readFile(output, 'utf8')).builtAt || builtAt; } catch {} }
const out = {
  name: cfg.name, normalizedName: key,
  source: 'tarkov.dev exact cache + SPT 4.1.2 + EFT Wiki visual approximations', builtAt,
  exactCache: exactSource.exact.source,
  extracts, spawns, bosses, hazards, stationaryWeapons, locks, switches, containers, btrStops, artilleryZones,
};
await mkdir('public/data', { recursive: true });
await writeFile(output, JSON.stringify(out, null, 1));
console.log(`wrote ${output}: ${extracts.length} extracts/transits, ${spawns.length} spawns, ${bosses.length} bosses, ${locks.length} locks, ${hazards.length} hazards/artillery, ${stationaryWeapons.length} guns, ${switches.length} switches, ${containers.length} loot markers, ${btrStops.length} BTR stops`);
