// Build public/data/quests.json — the quest layer's data source.
//
// Inputs (all under scripts/data/tasks/, fetched on demand when missing):
//   tasks-mirror.json  tarkov.dev `Task` objects crawled from the Tarkov Tools mirror
//                      (scripts/crawl-tasks-mirror.mjs). Names/descriptions are Chinese on that
//                      mirror, but ids, types, maps and — crucially — objective ZONES with game
//                      coordinates are language-independent.
//   spt-en.json        SPT server's English locale. Same BSG ids, so `<taskId> name`,
//                      `<taskId> description`, `<objectiveId>` and `<itemId> Name` give us English.
//   spt-quests.json    SPT quests.json — a second source for the English quest name.
//   public/data/<map>-3d.json  terrain heightfield, used only to tag a zone as underground.
//   public/data/quest-images.json  (optional, written by a separate agent) wiki screenshots
//                      keyed by task id: { "<taskId>": [{ objectiveId?, url, caption, map? }] }
//
// Output: public/data/quests.json — an array of quests; see SHAPE at the bottom of this file.
//
// Run: node scripts/build-quests.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = path.join(ROOT, 'scripts/data/tasks');
const OUT = path.join(ROOT, 'public/data/quests.json');
const SPT_EN = 'https://raw.githubusercontent.com/sp-tarkov/server/master/project/assets/database/locales/global/en.json';
const SPT_QUESTS = 'https://raw.githubusercontent.com/sp-tarkov/server/master/project/assets/database/templates/quests.json';

const readJson = async (p, fallback = null) => {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; }
};
async function cached(file, url) {
  const p = path.join(DATA, file);
  if (existsSync(p)) return readJson(p);
  console.log(`fetching ${url}`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  const text = await r.text();
  await mkdir(DATA, { recursive: true });
  await writeFile(p, text);
  return JSON.parse(text);
}

/* ------------------------------------------------------------------ inputs -- */
const tasks = await readJson(path.join(DATA, 'tasks-mirror.json'));
if (!Array.isArray(tasks) || !tasks.length) {
  console.error('scripts/data/tasks/tasks-mirror.json missing or empty — run scripts/crawl-tasks-mirror.mjs first');
  process.exit(1);
}
const EN = await cached('spt-en.json', SPT_EN);
const SPT = await cached('spt-quests.json', SPT_QUESTS);
const images = (await readJson(path.join(ROOT, 'public/data/quest-images.json'), null)) ?? {};
if (!Object.keys(images).length) console.log('note: public/data/quest-images.json absent or empty — quests build without screenshots');

/* --------------------------------------------------------------- map lookup -- */
// The mirror only puts an `id` on zone.map, so build id -> normalizedName from every map object
// that does carry a name.
const MAP_NAME = {};
for (const t of tasks) {
  if (t.map?.id && t.map.normalizedName) MAP_NAME[t.map.id] = t.map.normalizedName;
  for (const o of t.objectives ?? []) for (const m of o.maps ?? []) if (m.id && m.normalizedName) MAP_NAME[m.id] = m.normalizedName;
}
const zoneMapName = (z) => z?.map?.normalizedName ?? MAP_NAME[z?.map?.id] ?? null;
// Maps the site actually renders. Everything else is kept in the file (for the list/search) but
// carries no geometry we can draw.
const SITE_MAPS = ['customs', 'reserve', 'woods'];
// A few tarkov.dev maps are variants of one physical location.
const CANON = { 'night-factory': 'factory', 'ground-zero-21': 'ground-zero', 'ground-zero-tutorial': 'ground-zero', 'the-lab-dark': 'the-lab' };
const canon = (m) => CANON[m] ?? m;

/* --------------------------------------------------------------- terrain ----- */
// Only to decide whether a zone is underground: sample the map's heightfield at the zone centre
// and compare with the zone's own y.
const terrainOf = {};
for (const key of SITE_MAPS) {
  const d = await readJson(path.join(ROOT, `public/data/${key}-3d.json`));
  if (d?.terrain?.heights) terrainOf[key] = d.terrain;
}
function groundAt(mapKey, x, z) {
  const t = terrainOf[mapKey];
  if (!t) return null;
  const fx = Math.min(Math.max((x - t.x0) / t.step, 0), t.cols - 1.001);
  const fz = Math.min(Math.max((z - t.z0) / t.step, 0), t.rows - 1.001);
  const c = Math.floor(fx), r = Math.floor(fz), tx = fx - c, tz = fz - r;
  const h = (rr, cc) => t.heights[rr * t.cols + cc];
  return (h(r, c) * (1 - tx) + h(r, c + 1) * tx) * (1 - tz) + (h(r + 1, c) * (1 - tx) + h(r + 1, c + 1) * tx) * tz;
}
const levelFor = (mapKey, pos) => {
  const g = groundAt(mapKey, pos.x, pos.z);
  if (g == null || !Number.isFinite(pos.y)) return 'surface';
  const rel = pos.y - g;
  return rel < -3.5 ? 'underground' : rel > 4 ? 'upper' : 'surface';
};

/* ---------------------------------------------------------------- English ---- */
const titleCase = (slug) => String(slug || '').split('-')
  .map((w) => (/^(of|the|a|an|and|to|in|on|for|at|from|with)$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
  .join(' ').replace(/^./, (c) => c.toUpperCase());
const hasCJK = (s) => /[㐀-鿿豈-﫿]/.test(String(s || ''));
const en = (v) => (typeof v === 'string' && v.trim() && !hasCJK(v) ? v.trim() : null);
const itemName = (it) => en(EN?.[`${it?.id} Name`]) ?? en(EN?.[`${it?.id} ShortName`]) ?? en(it?.name) ?? en(titleCase(it?.normalizedName)) ?? null;
const mapLabel = (m) => titleCase(m).replace('Of', 'of');

const traderName = (tr) => en(EN?.[`${tr?.id} Nickname`]) ?? en(tr?.name) ?? en(titleCase(tr?.normalizedName)) ?? null;

function questName(t) {
  return en(EN?.[`${t.id} name`]) ?? en(SPT?.[t.id]?.QuestName) ?? en(wikiName(t.wikiLink)) ?? titleCase(t.normalizedName ?? t.slug);
}
const wikiName = (link) => {
  const m = /\/wiki\/([^?#]+)/.exec(link || '');
  return m ? decodeURIComponent(m[1]).replace(/_/g, ' ') : null;
};

// Last resort when SPT's locale has no line for an objective (the mirror runs ahead of SPT):
// assemble readable English from the structured fields instead of shipping Chinese.
function synthText(o, mapNames) {
  const where = mapNames.length ? ` on ${mapNames.map(mapLabel).join(' / ')}` : '';
  const item = itemName(o.markerItem) ?? itemName(o.questItem) ?? itemName((o.items ?? [])[0]);
  const n = o.count && o.count > 1 ? `${o.count} ` : '';
  switch (o.type) {
    case 'mark': return `Mark ${item ? `with ${item}` : 'the objective'}${where}`;
    case 'shoot': return `Eliminate ${o.count ?? 1} target${(o.count ?? 1) > 1 ? 's' : ''}${where}`;
    case 'visit': return `Locate the objective${where}`;
    case 'extract': return `Extract${where}`;
    case 'findQuestItem': return `Find ${item ?? 'the quest item'}${where}`;
    case 'giveQuestItem': return `Hand over ${item ?? 'the quest item'}`;
    case 'plantItem': case 'plantQuestItem': return `Stash ${item ?? 'the item'}${where}`;
    case 'findItem': return `Find ${n}${item ?? 'the item'} in raid`;
    case 'giveItem': return `Hand over ${n}${item ?? 'the item'}`;
    case 'buildWeapon': return `Build ${item ?? 'the weapon'} to the required specification`;
    case 'useItem': return `Use ${item ?? 'the item'}${where}`;
    case 'skill': return `Reach the required skill level`;
    case 'traderLevel': case 'traderStanding': return `Reach the required trader loyalty`;
    case 'taskStatus': return `Complete the prerequisite task`;
    default: return `${titleCase(o.type)}${where}`;
  }
}

/* ----------------------------------------------------------------- images ---- */
const imgOut = (im) => ({ url: im.url, caption: im.caption ?? '', ...(im.map ? { map: im.map } : {}) });
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
function hintMatches(im, englishText) {
  const hint = norm(im.objectiveHint ?? im.caption);
  if (hint.length < 5) return false;
  const text = norm(englishText);
  if (text.includes(hint)) return true;
  // "Room 205" / "The tanker truck" — the caption is rarely a substring, so also accept when every
  // content word of the hint shows up in the objective line.
  const words = hint.split(' ').filter((w) => w.length > 3 && !['the', 'with', 'from', 'this', 'that', 'your', 'into', 'onto', 'location', 'marked'].includes(w));
  return words.length >= 2 && words.every((w) => text.includes(w));
}

/* ------------------------------------------------------------------ zones ---- */
const centroid = (pts) => pts.reduce((a, p) => [a[0] + p.x / pts.length, a[1] + p.z / pts.length], [0, 0]);
const dedupeKey = (z) => `${z.id}|${Math.round(z.position.x)}|${Math.round(z.position.z)}`;

function zonesOf(o) {
  const out = [], seen = new Set();
  for (const z of o.zones ?? []) {
    if (!z?.position || !Number.isFinite(z.position.x) || !Number.isFinite(z.position.z)) continue;
    const key = dedupeKey(z);
    if (seen.has(key)) continue;
    seen.add(key);
    const mapKey = canon(zoneMapName(z));
    const pos = { x: +z.position.x.toFixed(2), y: +(z.position.y ?? 0).toFixed(2), z: +z.position.z.toFixed(2) };
    // tarkov.dev's `outline` is usually the zone's ground rectangle, but a handful of rows carry a
    // stale/doubled polygon (e.g. Woods 'bunker1'). Trust it only when it agrees with the centre.
    let outline = null;
    const pts = (z.outline ?? []).filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.z));
    if (pts.length >= 3) {
      const [cx, cz] = centroid(pts);
      if (Math.hypot(cx - pos.x, cz - pos.z) <= 40) outline = pts.map((p) => [+p.x.toFixed(2), +p.z.toFixed(2)]);
    }
    out.push({ id: z.id ?? null, map: mapKey, position: pos, level: SITE_MAPS.includes(mapKey) ? levelFor(mapKey, pos) : 'surface', ...(outline ? { outline } : {}) });
  }
  return out;
}

/* ------------------------------------------------------------------ build ---- */
const slugOf = (t) => t.normalizedName ?? t.slug ?? t.id;
const quests = [];
for (const t of tasks) {
  const taskImages = images[t.id] ?? [];
  const objectives = [];
  for (const o of t.objectives ?? []) {
    const objMaps = [...new Set((o.maps ?? []).map((m) => canon(m.normalizedName)).filter(Boolean))];
    const zones = zonesOf(o);
    for (const z of zones) if (z.map && !objMaps.includes(z.map)) objMaps.push(z.map);
    const localised = en(EN?.[o.id]);
    const text = localised ?? synthText(o, objMaps);
    const item = itemName(o.markerItem) ?? itemName(o.questItem) ?? itemName((o.items ?? [])[0]);
    // Screenshots come keyed by task. Some carry an explicit objectiveId; the rest carry an
    // `objectiveHint` (the wiki's caption), which we attach to an objective only when the hint
    // actually reads as part of that objective's text. Anything left over stays at quest level,
    // so the card can fall back to it without duplicating the array under every objective.
    const imgs = taskImages.filter((im) => (im.objectiveId ? im.objectiveId === o.id : hintMatches(im, text)));
    objectives.push({
      id: o.id,
      synth: !localised || undefined,
      type: o.type ?? null,
      kind: String(o.__typename ?? '').replace(/^TaskObjective/, '').toLowerCase() || null,
      text,
      maps: objMaps,
      optional: !!o.optional,
      ...(o.count && o.count > 1 ? { count: o.count } : {}),
      ...(item ? { item } : {}),
      ...(zones.length ? { zones } : {}),
      ...(imgs.length ? { images: imgs.map(imgOut) } : {}),
    });
  }
  // Several optional objectives of one quest can synthesize to the same sentence ("Locate the
  // objective on Customs" ×7). Identical rows in a checklist are useless — number them.
  const bySynthText = new Map();
  for (const o of objectives) if (o.synth) bySynthText.set(o.text, [...(bySynthText.get(o.text) ?? []), o]);
  for (const [, group] of bySynthText) {
    if (group.length < 2) continue;
    group.forEach((o, i) => { o.text = `${o.text} (${i + 1} of ${group.length})`; });
  }
  for (const o of objectives) delete o.synth;

  const claimed = new Set(objectives.flatMap((o) => (o.images ?? []).map((im) => im.url)));
  const questImages = taskImages.filter((im) => !claimed.has(im.url));
  const maps = [...new Set([canon(t.map?.normalizedName), ...objectives.flatMap((o) => o.maps)].filter(Boolean))];
  const zoneMaps = [...new Set(objectives.flatMap((o) => (o.zones ?? []).map((z) => z.map)).filter(Boolean))];
  quests.push({
    id: t.id,
    slug: slugOf(t),
    name: questName(t),
    trader: traderName(t.trader),
    minLevel: t.minPlayerLevel ?? 0,
    wikiLink: t.wikiLink ?? null,
    maps,
    zoneMaps,
    // the maps this site can actually draw the quest on
    siteMaps: zoneMaps.filter((m) => SITE_MAPS.includes(m)),
    objectives,
    ...(questImages.length ? { images: questImages.map(imgOut) } : {}),
  });
}
quests.sort((a, b) => (a.minLevel - b.minLevel) || a.name.localeCompare(b.name));

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(quests));

/* ------------------------------------------------------------------ report --- */
const perMap = {};
for (const key of SITE_MAPS) {
  const qs = quests.filter((q) => q.siteMaps.includes(key));
  const objs = qs.flatMap((q) => q.objectives).filter((o) => (o.zones ?? []).some((z) => z.map === key));
  perMap[key] = {
    quests: qs.length,
    objectives: objs.length,
    zones: objs.flatMap((o) => o.zones).filter((z) => z.map === key).length,
    outlines: objs.flatMap((o) => o.zones).filter((z) => z.map === key && z.outline).length,
    underground: objs.flatMap((o) => o.zones).filter((z) => z.map === key && z.level === 'underground').length,
  };
}
// The mirror is Chinese: if anything user-facing slipped through untranslated, say so loudly
// rather than shipping it.
const leftover = [
  ...quests.filter((q) => hasCJK(q.name) || hasCJK(q.trader)).map((q) => `quest ${q.slug}: ${q.name} / ${q.trader}`),
  ...quests.flatMap((q) => q.objectives.filter((o) => hasCJK(o.text) || hasCJK(o.item)).map((o) => `objective ${q.slug}/${o.id}: ${o.text}`)),
];
if (leftover.length) {
  console.warn(`WARNING: ${leftover.length} untranslated strings still in quests.json`);
  for (const l of leftover.slice(0, 10)) console.warn('  ' + l);
} else console.log('English check: no CJK left in names, traders, objective text or item names');

const allObjectives = quests.flatMap((q) => q.objectives);
console.log(`quests.json  ${quests.length} quests, ${allObjectives.length} objectives, ${allObjectives.flatMap((o) => o.zones ?? []).length} zones`);
console.log(`with zones on any map: ${quests.filter((q) => q.zoneMaps.length).length}   on customs/reserve/woods: ${quests.filter((q) => q.siteMaps.length).length}`);
console.table(perMap);
console.log(`images: ${quests.filter((q) => q.images).length} quests carry screenshots`);
console.log(`size: ${(JSON.stringify(quests).length / 1024).toFixed(0)} KB -> ${path.relative(ROOT, OUT)}`);

// SHAPE (one quest):
// { id, slug, name, trader, minLevel, wikiLink,
//   maps: ['customs'], zoneMaps: ['customs'], siteMaps: ['customs'],
//   objectives: [{ id, type, kind, text, maps, optional, count?, item?,
//                  zones?: [{ id, map, position: {x,y,z}, level, outline?: [[x,z], ...] }],
//                  images?: [{ url, caption, map? }] }] }
