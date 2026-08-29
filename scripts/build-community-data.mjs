// Build public/data/<map>.json from reproducible community-source snapshots.
//   spawns/bosses : SPT server database (game coordinates)
//   extracts/transits/locks/guns : EFT Wiki interactive map (wiki pixels -> game coords)
// Output matches the shape of the tarkov.dev GraphQL response used by src/api.js.
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const BOSS_NAMES = {
  bossBully: 'Reshala', bossGluhar: 'Glukhar', bossKojaniy: 'Shturman', bossKnight: 'Knight',
  followerBigPipe: 'Big Pipe', followerBirdEye: 'Birdeye', bossPartisan: 'Partisan',
  sectantPriest: 'Cultist Priest', gifter: 'Santa', bossKilla: 'Killa', bossTagilla: 'Tagilla',
};

const CONFIG = {
  customs: {
    name: 'Customs',
    spt: 'scripts/spt-bigmap-base.json',
    // Customs has no checked-in raw wiki response yet; retain the online fallback used by the original builder.
    wikiUrl: 'https://escapefromtarkov.fandom.com/api.php?action=query&prop=revisions&titles=Map:Customs&rvslots=main&rvprop=content&format=json',
    calibration: [
      { title: 'ZB-1011', game: [628, -131] },
      { title: "Smugglers' Bunker (ZB-1012)", game: [466, -116] },
      { title: 'ZB-013', game: [206, -148] },
      { title: 'Old Gas Station', game: [311, -178] },
    ],
    axisAligned: true,
  },
  reserve: {
    name: 'Reserve', spt: 'scripts/data/reserve/spt-base.json', wiki: 'scripts/data/reserve/wiki-map.json',
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
    include: (m) => !(['locked', 'loot_key'].includes(m.categoryId)
      && !(m.position[0] >= 374 && m.position[0] <= 3100 && m.position[1] >= 350 && m.position[1] <= 2420)),
  },
  woods: {
    name: 'Woods', spt: 'scripts/data/woods/spt-base.json', wiki: 'scripts/data/woods/wiki-map.json',
    // Mutual-nearest matches between current wiki PMC markers and current SPT Player points.
    calibration: [
      { id: '4', game: [487.358643, 328.52] },
      { id: '8', game: [367.74, -73.79001] },
      { id: '19', game: [-492.41, -50.23001] },
      { id: '24', game: [-524.17, 220.33] },
      { id: '16', game: [-413.22, -522.429932] },
      { id: '21', game: [-331.468018, -138.725983] },
    ],
    include: (m) => !(m.categoryId === 'locked' && m.position[0] < 500), // ZB-014 inset panel
  },
};

const key = (process.argv.slice(2).find((a) => !a.startsWith('-')) || 'customs').toLowerCase();
const cfg = CONFIG[key];
if (!cfg) throw new Error(`unknown map ${key}; expected ${Object.keys(CONFIG).join(', ')}`);
const stamp = process.argv.includes('--stamp');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

const spt = JSON.parse(await readFile(cfg.spt, 'utf8'));
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
const fx = cfg.axisAligned ? [...fit1d(pairs, 0, 0), 0] : fitAffine(pairs, 0);
const fz = cfg.axisAligned ? [0, ...fit1d(pairs, 1, 1)] : fitAffine(pairs, 1);
if (cfg.axisAligned) { // normalize to [wx, wy, constant]
  fx.splice(1, 0, 0); fx.length = 3;
  const [, a, b] = fz; fz[0] = 0; fz[1] = a; fz[2] = b;
}
const affine = ([wx, wy]) => ({ x: fx[0] * wx + fx[1] * wy + fx[2], y: 0, z: fz[0] * wx + fz[1] * wy + fz[2] });
const toGame = (m) => {
  const override = cfg.overrides?.[titleOf(m)];
  const p = override ? { x: override[0], y: 0, z: override[1] } : affine(m.position);
  return { x: +p.x.toFixed(1), y: 0, z: +p.z.toFixed(1) };
};
for (const p of pairs) {
  const q = affine(p.marker.position), err = Math.hypot(q.x - p.game[0], q.z - p.game[1]);
  console.log(`calib ${p.title || `marker ${p.id}`}: ${q.x.toFixed(1)},${q.z.toFixed(1)} vs ${p.game} (err ${err.toFixed(1)} m)`);
}
console.log(`affine x=[${fx.map((x) => x.toPrecision(10)).join(', ')}], z=[${fz.map((x) => x.toPrecision(10)).join(', ')}]`);

const markers = wiki.markers.filter((m) => !cfg.include || cfg.include(m));
const extracts = [];
for (const m of markers) {
  if (!m.categoryId.startsWith('exfil')) continue;
  const faction = { exfil_pmc: 'pmc', exfil_scav: 'scav', exfil_transit: 'transit' }[m.categoryId];
  const name = titleOf(m);
  const note = (m.popup.description || '').replace(/\[\[File:[^\]]*\]\]/g, '').replace(/\[\[([^\]|]*)(\|[^\]]*)?\]\]/g, '$1').trim();
  const same = extracts.find((e) => e.name === name && e.faction !== faction && e.faction !== 'transit' && faction !== 'transit');
  if (same) { same.faction = 'shared'; continue; }
  extracts.push({ id: `wiki-${m.id}`, name, faction, note, position: toGame(m) });
}

const spawns = spt.SpawnPointParams.map((s) => {
  const cats = s.Categories.map((c) => c.toLowerCase());
  const sides = s.Sides.map((c) => ({ pmc: 'pmc', savage: 'scav', all: 'all' }[c.toLowerCase()] ?? c.toLowerCase()));
  const categories = [];
  if (cats.includes('player')) categories.push('player');
  if (cats.includes('boss')) categories.push('boss');
  if (cats.includes('bot') && !cats.includes('boss')) categories.push(s.BotZoneName?.toLowerCase().includes('snipe') ? 'sniper' : 'scav');
  return { position: { x: +s.Position.x.toFixed(1), y: +s.Position.y.toFixed(1), z: +s.Position.z.toFixed(1) }, sides, categories, zoneName: s.BotZoneName || null };
});
const bosses = Object.values(spt.BossLocationSpawn.reduce((acc, b) => {
  if (b.BossName.startsWith('pmc') || b.BossChance === 0 || b.BossName === 'arenaFighterEvent') return acc;
  const name = BOSS_NAMES[b.BossName] ?? b.BossName;
  acc[name] ??= { name, spawnChance: b.BossChance / 100, spawnLocations: [] };
  for (const z of (b.BossZone || '').split(',').filter(Boolean)) acc[name].spawnLocations.push({ name: z, chance: 1 });
  return acc;
}, {}));

const locks = markers.filter((m) => m.categoryId === 'locked').map((m) => ({ lockType: 'door', key: { name: titleOf(m) }, position: toGame(m) }));
const stationaryWeapons = markers.filter((m) => m.categoryId === 'stationarygun').map((m) => ({ stationaryWeapon: { name: titleOf(m) }, position: toGame(m) }));
const hazards = [];
const switches = markers.filter((m) => m.categoryId === 'lever').map((m) => ({ name: titleOf(m), position: toGame(m) }));

const output = `public/data/${key}.json`;
let builtAt = new Date().toISOString();
if (!stamp) { try { builtAt = JSON.parse(await readFile(output, 'utf8')).builtAt || builtAt; } catch {} }
const out = { name: cfg.name, normalizedName: key, source: 'community (SPT database + EFT Wiki)', builtAt, extracts, spawns, bosses, hazards, stationaryWeapons, locks, switches };
await mkdir('public/data', { recursive: true });
await writeFile(output, JSON.stringify(out, null, 1));
console.log(`wrote ${output}: ${extracts.length} extracts, ${spawns.length} spawns, ${bosses.length} bosses, ${locks.length} locks, ${stationaryWeapons.length} guns, ${switches.length} switches`);
