// Build public/data/<map>.json from community sources when the tarkov.dev API is unavailable.
//   spawns/bosses : SPT server database (game coordinates)
//   extracts/transits/locks/guns : EFT Wiki interactive map (wiki pixels -> game coords via calibration)
// Output matches the shape of the tarkov.dev GraphQL response used by src/api.js.
import { writeFile, mkdir } from 'node:fs/promises';

const SPT = 'https://raw.githubusercontent.com/sp-tarkov/server/master/project/assets/database/locations/bigmap/base.json';
const WIKI = 'https://escapefromtarkov.fandom.com/api.php?action=query&prop=revisions&titles=Map:Customs&rvslots=main&rvprop=content&format=json';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

// Known points in both systems: wiki extract marker  ->  game [x, z] (from tarkov.dev layer extents).
const CALIBRATION = [
  ['ZB-1011', [628, -131]],
  ["Smugglers' Bunker (ZB-1012)", [466, -116]],
  ['ZB-013', [206, -148]],
  ['Old Gas Station', [311, -178]],
];
const BOSS_NAMES = { bossBully: 'Reshala', bossKnight: 'Knight', followerBigPipe: 'Big Pipe', followerBirdEye: 'Birdeye', bossPartisan: 'Partisan', sectantPriest: 'Cultist Priest', gifter: 'Santa', bossKilla: 'Killa', bossTagilla: 'Tagilla' };

const [spt, wikiRes] = await Promise.all([
  fetch(SPT).then((r) => r.json()),
  fetch(WIKI, { headers: { 'User-Agent': UA } }).then((r) => r.json()),
]);
const wiki = JSON.parse(Object.values(wikiRes.query.pages)[0].revisions[0].slots.main['*']);

// ---- calibration: independent 1-D linear fits (both maps are north-up, so no cross terms)
const byTitle = Object.fromEntries(wiki.markers.filter((m) => m.categoryId.startsWith('exfil')).map((m) => [m.popup.title.trim(), m.position]));
function fit1d(pairs) { // least squares y = a*x + b
  const n = pairs.length, sx = pairs.reduce((s, [x]) => s + x, 0), sy = pairs.reduce((s, [, y]) => s + y, 0);
  const sxx = pairs.reduce((s, [x]) => s + x * x, 0), sxy = pairs.reduce((s, [x, y]) => s + x * y, 0);
  const a = (n * sxy - sx * sy) / (n * sxx - sx * sx); return [a, (sy - a * sx) / n];
}
const fx = fit1d(CALIBRATION.map(([t, g]) => [byTitle[t][0], g[0]]));
const fz = fit1d(CALIBRATION.map(([t, g]) => [byTitle[t][1], g[1]]));
const toGame = ([wx, wy]) => ({ x: +(fx[0] * wx + fx[1]).toFixed(1), y: 0, z: +(fz[0] * wy + fz[1]).toFixed(1) });
for (const [t, g] of CALIBRATION) { const p = toGame(byTitle[t]); console.log(`calib ${t}: ${p.x},${p.z} vs ${g} (err ${Math.hypot(p.x - g[0], p.z - g[1]).toFixed(1)})`); }

// ---- extracts (merge PMC+Scav markers of the same name into "shared")
const extracts = [];
for (const m of wiki.markers) {
  if (!m.categoryId.startsWith('exfil')) continue;
  const faction = { exfil_pmc: 'pmc', exfil_scav: 'scav', exfil_transit: 'transit' }[m.categoryId];
  const name = m.popup.title.trim();
  const note = (m.popup.description || '').replace(/\[\[File:[^\]]*\]\]/g, '').replace(/\[\[([^\]|]*)(\|[^\]]*)?\]\]/g, '$1').trim();
  const same = extracts.find((e) => e.name === name && e.faction !== faction && e.faction !== 'transit' && faction !== 'transit');
  if (same) { same.faction = 'shared'; continue; }
  extracts.push({ id: `wiki-${m.id}`, name, faction, note, position: toGame(m.position) });
}

// ---- spawns from SPT (already game coords)
const spawns = spt.SpawnPointParams.map((s) => {
  const cats = s.Categories.map((c) => c.toLowerCase()); // player | bot | boss | coop ...
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

const locks = wiki.markers.filter((m) => m.categoryId === 'locked').map((m) => ({ lockType: 'door', key: { name: m.popup.title.trim() }, position: toGame(m.position) }));
const stationaryWeapons = wiki.markers.filter((m) => m.categoryId === 'stationarygun').map((m) => ({ stationaryWeapon: { name: m.popup.title.trim() }, position: toGame(m.position) }));
const hazards = [];
const switches = wiki.markers.filter((m) => m.categoryId === 'lever').map((m) => ({ name: m.popup.title.trim(), position: toGame(m.position) }));

const out = { name: 'Customs', normalizedName: 'customs', source: 'community (SPT database + EFT Wiki)', builtAt: new Date().toISOString(), extracts, spawns, bosses, hazards, stationaryWeapons, locks, switches };
await mkdir('public/data', { recursive: true });
await writeFile('public/data/customs.json', JSON.stringify(out, null, 1));
console.log(`wrote public/data/customs.json: ${extracts.length} extracts, ${spawns.length} spawns, ${bosses.length} bosses, ${locks.length} locks, ${stationaryWeapons.length} guns, ${switches.length} switches`);
