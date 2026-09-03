/**
 * Offline checks for the assistant function's pure parts: retrieval ranking, the grounding
 * block, robust reply parsing and server-side action validation. No API key, no network.
 *
 *   node scripts/test-assistant.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  index, rank, groundingFor, parseReply, buildActions,
  normalizeActiveIds, activeQuestNames, cacheKeyFor, MAX_ACTIVE,
  imageCatalog, buildImages, crossMapFor, mapCoverage,
} from '../api/assistant.js';
import {
  isValidAction, isValidImageRef, isAllowedImageUrl, validateEnvelope,
  PROTOCOL_VERSION, MAX_IMAGES, SITE_MAPS, MAP_LABELS, OTHER_MAP_LABELS,
} from '../src/assistant-contract.js';
import { AVAILABLE_MAP_KEYS, EFT_MAP_KEYS, LOCKED_MAP_KEYS } from '../src/map-availability.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const quests = JSON.parse(readFileSync(join(root, 'public/data/quests.json'), 'utf8'));
const entries = index(quests);

// The screenshot index, exactly as the server loads it: quest id -> the set of URLs the wiki
// scraper recorded. Every image reference the assistant returns must be in here.
const imageFile = JSON.parse(readFileSync(join(root, 'public/data/quest-images.json'), 'utf8'));
const allow = new Map(Object.entries(imageFile)
  .filter(([k, v]) => !k.startsWith('_') && Array.isArray(v))
  .map(([k, v]) => [k, new Set(v.map((im) => im.url))]));

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? `  -> ${extra}` : ''}`); }
};
const top = (msg, map = 'customs') => rank(entries, msg, map)[0]?.q ?? null;

console.log(`quests loaded: ${quests.length}\n\n# ranking`);
ok(top('How do I do Abandoned Cargo?')?.slug === 'abandoned-cargo', 'exact quest name', top('How do I do Abandoned Cargo?')?.slug);
ok(top('abandonned cargoo')?.slug === 'abandoned-cargo', 'fuzzy / typo name', top('abandonned cargoo')?.slug);
{
  const hits = rank(entries, 'where are the terragroup cargo boxes').map((h) => h.q.slug);
  ok(hits.includes('abandoned-cargo'), 'objective-text match reaches the model context', hits.join(', '));
}
// NB: quests.json slugs do not always match the part number in the name (a pre-existing
// build-quests slug collision), so these assert on the name, which is what the model reads.
ok(top('the punisher part 1')?.name === 'The Punisher - Part 1', 'multi-word name', top('the punisher part 1')?.name);
ok(top('punisher part 4')?.name === 'The Punisher - Part 4', 'the part number decides between siblings', top('punisher part 4')?.name);

{
  const hits = rank(entries, "What's on this map for Prapor?", 'customs');
  ok(hits.length > 0 && hits.every((h) => h.q.trader === 'Prapor'), 'trader query returns Prapor quests', hits.map((h) => `${h.q.name}/${h.q.trader}`).join(', '));
  ok(hits.every((h) => (h.q.maps ?? []).includes('customs')), 'trader query prefers the current map', hits.map((h) => h.q.maps.join('+')).join(', '));
}
{
  // same words, different map -> the map bonus must reorder the results
  const c = rank(entries, 'mark the cargo', 'customs')[0];
  const w = rank(entries, 'mark the cargo', 'woods')[0];
  ok(!!c && !!w, 'ranks on every map');
  ok(rank(entries, 'a', 'customs').length <= 3, 'never returns more than 3 hits');
  ok(rank(entries, 'zzzqqxx nonsense', 'customs').length === 0, 'no hits for nonsense');
}

/* ------------------------------------------------------------- active quests */
// The server half of the active-quest feature (commit 2bdec1d): what the request body may contain,
// which ids the model is told about, the +5 ranking nudge, and the cache key that keeps a question
// asked before and after accepting a quest apart. None of it was covered — every line of it could
// be deleted and this file stayed green.
console.log('\n# active quests (the game\'s own log)');
{
  ok(normalizeActiveIds(['  a1  ', 'b-2', 'C_3']).join(',') === 'a1,b-2,C_3', 'ids are trimmed and kept');
  ok(normalizeActiveIds(['<img src=x>', 'a b', 'x'.repeat(65), '', 7, null]).length === 0, 'anything not id-shaped is dropped');
  ok(normalizeActiveIds('a1').length === 0, 'a non-array is an empty list');
  ok(normalizeActiveIds(Array.from({ length: 200 }, (_, i) => `id${i}`)).length === MAX_ACTIVE, `a flood is capped at ${MAX_ACTIVE}`);
}
{
  const real = quests.slice(0, 3);
  const names = activeQuestNames(entries, real.map((q) => q.id));
  ok(names.length === 3 && names.every((n, i) => n === real[i].name), 'ids resolve to the names the prompt uses', names.join(' | '));
  ok(activeQuestNames(entries, ['not-a-task']).length === 0, 'an id with no quest never reaches the model');
  ok(activeQuestNames(entries, []).length === 0, 'no active set, no names');
  ok(activeQuestNames(entries, quests.slice(0, 40).map((q) => q.id)).length === 12, 'the prompt list is capped at 12');
}
{
  // The nudge, on the real file: a question that names a quest family without saying which part.
  // Whichever sibling wins without grounding, the one the GAME says the player is on must win with
  // it — and it must be a nudge, not an override (a quest named outright still wins).
  const family = quests.filter((q) => /^The Punisher - Part \d$/.test(q.name ?? ''));
  const blind = rank(entries, 'how do I finish the punisher', 'customs')[0]?.q;
  const other = family.find((q) => q.id !== blind?.id);
  ok(!!blind && !!other, 'found a quest family to test the nudge with', `${blind?.name} vs ${other?.name}`);
  const nudged = rank(entries, 'how do I finish the punisher', 'customs', { activeIds: new Set([other.id]) })[0]?.q;
  ok(nudged?.id === other.id, 'the active sibling outranks the one plain retrieval picked', `${blind?.name} -> ${nudged?.name}`);
  const named = rank(entries, `how do I finish ${blind.name}`, 'customs', { activeIds: new Set([other.id]) })[0]?.q;
  ok(named?.id === blind.id, 'but a quest the player names outright still wins — it is a nudge, not an override', named?.name);
  ok(rank(entries, 'how do I finish the punisher', 'customs', { activeIds: new Set(['not-a-task']) })[0]?.id === blind?.id
    || rank(entries, 'how do I finish the punisher', 'customs', { activeIds: new Set(['not-a-task']) })[0]?.q?.id === blind?.id,
  'an unknown active id changes nothing');
  ok(rank(entries, 'how do I finish the punisher', 'customs', { activeIds: null })[0]?.q?.id === blind?.id, 'a null active set is the plain ranking');
}
{
  const base = { map: 'customs', message: 'Where is it?', history: [] };
  ok(cacheKeyFor(base) === cacheKeyFor({ ...base }), 'the same request is the same key');
  ok(cacheKeyFor({ ...base, activeIds: ['a1'] }) !== cacheKeyFor(base), 'accepting a quest is a different question');
  ok(cacheKeyFor({ ...base, activeIds: ['a1', 'b2'] }) !== cacheKeyFor({ ...base, activeIds: ['a1'] }), 'so is accepting another');
  ok(cacheKeyFor({ ...base, message: 'WHERE IS IT?' }) === cacheKeyFor(base), 'case is not a different question');
  ok(cacheKeyFor({ ...base, map: 'woods' }) !== cacheKeyFor(base), 'a different map is');
}

console.log('\n# grounding');
{
  const hits = rank(entries, 'Abandoned Cargo', 'customs');
  const g = groundingFor(hits, 'customs');
  ok(g.includes('slug: abandoned-cargo'), 'includes the slug');
  ok(/id [0-9a-f]{24}/.test(g), 'includes objective ids');
  ok(g.includes('marked location'), 'says how many markers are on this map');
  ok(!/\d+\.\d+, ?-?\d+\.\d+/.test(g), 'never leaks raw coordinates into the prompt');
  ok(g.length < 6000, `grounding stays compact (${g.length} chars)`);
}

console.log('\n# reply parsing');
const A = '{"answer":"Go to the warehouse.","actions":[{"type":"selectQuest","slug":"abandoned-cargo"}],"quests":["abandoned-cargo"]}';
ok(parseReply(A).parsed && parseReply(A).quests[0] === 'abandoned-cargo', 'plain JSON');
ok(parseReply('```json\n' + A + '\n```').parsed, 'fenced JSON');
ok(parseReply('Sure!\n' + A + '\nHope that helps.').parsed, 'JSON with prose around it');
ok(parseReply('Just some text.').answer === 'Just some text.' && !parseReply('Just some text.').parsed, 'plain-text fallback');
ok(parseReply('{"answer":1}').answer === '{"answer":1}', 'wrong-typed answer falls back to text');
ok(parseReply('').answer === '' && parseReply(null).actions.length === 0, 'empty reply is harmless');
ok(parseReply('{"answer":"x","actions":"nope","quests":[1,"a"]}').quests.length === 1, 'bad action/quest types are dropped');

console.log('\n# action validation');
{
  const hits = rank(entries, 'Abandoned Cargo', 'customs');
  const lead = hits[0].q;
  const first = lead.objectives.find((o) => (o.zones ?? []).some((z) => z.map === 'customs'));

  let out = buildActions(hits, parseReply(A), 'customs');
  ok(out.actions[0].type === 'selectQuest' && out.actions[0].slug === lead.slug, 'selectQuest first');
  ok(out.actions[1]?.type === 'flyTo' && out.actions[1].objectiveId === first.id, 'flyTo the first objective on this map');

  out = buildActions(hits, parseReply('{"answer":"x","actions":[{"type":"selectQuest","slug":"totally-made-up"},{"type":"flyTo","objectiveId":"deadbeef"}],"quests":["also-fake"]}'), 'customs');
  ok(out.actions.length === 0 && out.quests.length === 0, 'invented slugs and ids are discarded', JSON.stringify(out));

  out = buildActions(hits, parseReply('{"answer":"x","actions":[{"type":"switchMap","map":"../../etc"}],"quests":["abandoned-cargo"]}'), 'customs');
  ok(out.actions.every((a) => a.type !== 'switchMap'), 'a bogus switchMap never survives', JSON.stringify(out));

  // A quest whose markers are only on WOODS. Woods still has all its zones in quests.json and is
  // still in that quest's `siteMaps` — and it is LOCKED (src/map-availability.js), so the answer is
  // prose: no flyTo (nothing here) and no switchMap (nowhere to go).
  const woodsOnly = quests.find((q) => (q.siteMaps ?? []).length === 1 && q.siteMaps[0] === 'woods');
  out = buildActions([{ q: woodsOnly }], { answer: '', actions: [], quests: [woodsOnly.slug] }, 'customs');
  ok(!out.actions.some((a) => a.type === 'switchMap'), 'a locked map is never offered as a switch', JSON.stringify(out));
  ok(!out.actions.some((a) => a.type === 'flyTo'), 'no flyTo when nothing is on this map');
  ok(out.actions.every((a) => a.type === 'selectQuest'), 'the quest can still be selected, and that is all', JSON.stringify(out));

  out = buildActions(hits, { answer: '', actions: [], quests: [] }, 'customs');
  ok(out.actions.length === 0, 'no quest identified -> no actions');
}

/* --------------------------------------------------------------- map awareness */
// The map the tab is on is not decoration: it decides what the model is told about coverage and
// what the cross-map handoff offers. quests.json covers all eleven EFT maps; this repo ships render
// data for three; the site OPENS the ones in AVAILABLE_MAP_KEYS, which is Customs alone since
// 2026-09-02. Availability, not data coverage, is what the assistant is allowed to act on.

console.log('\n# map awareness');
const woodsOnly = quests.find((q) => (q.siteMaps ?? []).length === 1 && q.siteMaps[0] === 'woods');
const offSiteOnly = quests.find((q) => !(q.siteMaps ?? []).length
  && (q.objectives ?? []).some((o) => (o.zones ?? []).length));

// The one list. Every assertion below about what is offerable derives from it, so unlocking a map
// changes this file's expectations with it instead of leaving a literal behind that says otherwise.
ok(SITE_MAPS.length >= 1, 'at least one map is open', SITE_MAPS.join(','));
ok(SITE_MAPS.every((m) => !LOCKED_MAP_KEYS.includes(m)), 'no map is both open and locked');
ok(EFT_MAP_KEYS.length === SITE_MAPS.length + LOCKED_MAP_KEYS.length,
  'open + locked accounts for every EFT map the picker lists', String(EFT_MAP_KEYS.length));
ok(LOCKED_MAP_KEYS.every((m) => m in OTHER_MAP_LABELS),
  'every locked map has a display name for the "we cannot open that" sentence');
ok(Object.keys(MAP_LABELS).join(',') === SITE_MAPS.join(','),
  'MAP_LABELS names exactly the open maps', Object.keys(MAP_LABELS).join(','));
{
  const cov = mapCoverage(woodsOnly, 'customs');
  ok(!cov.here, 'a woods quest is not on the customs tab', JSON.stringify(cov));
  ok(!cov.elsewhere.length, 'and there is no other OPEN map to send the player to', JSON.stringify(cov.elsewhere));
  ok(cov.offSite.includes('woods'), 'woods reads as an unopenable map, exactly like shoreline', JSON.stringify(cov.offSite));

  const g = groundingFor(rank(entries, `where is ${woodsOnly.name}`, 'customs'), 'customs');
  ok(g.includes('NOTHING TO DRAW ON customs'), 'the prompt says outright that the quest is not on this map');
  ok(!g.includes('openable here instead'), 'and never names a locked map as somewhere to go', g.slice(0, 400));
  ok(g.includes('also on woods - MAPS TARKOVZERO CANNOT OPEN'),
    'a locked map is described the way Shoreline is', g.split('\n').find((l) => l.includes('woods')));
  ok(g.includes('CURRENT MAP') === false, 'the CURRENT MAP line belongs to the handler, not the block');
}
{
  // Off-site quests (Shoreline, Streets, …) must never be offered as a switch — there is no map
  // to switch to. 110 of the 517 quests are in exactly this state; the locked maps join them.
  const g = groundingFor(rank(entries, `where is ${offSiteOnly.name}`, 'customs'), 'customs');
  ok(g.includes('MAPS TARKOVZERO CANNOT OPEN'), 'a quest on an unshipped map is flagged as such to the model', offSiteOnly.name);
  ok(crossMapFor(offSiteOnly, 'customs') === null, 'and it produces no switchMap action');
}

console.log('\n# cross-map handoff — unreachable while one map is open');
{
  // The handoff is not deleted; it is starved. `crossMapFor` filters the quest's maps through
  // SITE_MAPS, so with one open map there is never a target — for ANY quest in the file, which is
  // the claim that matters (the founder's ask was "lock reserve and woods", and this is what makes
  // it true server-side rather than in the picker only).
  ok(crossMapFor(woodsOnly, 'customs') === null, 'a woods quest offers no switch from customs');
  ok(crossMapFor(null, 'customs') === null, 'no quest, no switch');
  for (const wanted of ['woods', 'reserve', 'shoreline', 'atlantis', null]) {
    ok(crossMapFor(woodsOnly, 'customs', wanted) === null,
      `the model asking for "${wanted}" cannot conjure a target`, JSON.stringify(crossMapFor(woodsOnly, 'customs', wanted)));
  }
  const offered = quests.filter((q) => crossMapFor(q, 'customs') !== null);
  ok(offered.length === 0, 'NO quest in quests.json can produce a switchMap from customs', String(offered.length));

  // …and end to end, from a model reply, which is what the client actually receives.
  const hits = rank(entries, `where is ${woodsOnly.name}`, 'customs');
  ok(hits[0]?.q.slug === woodsOnly.slug, 'the woods quest is still the lead hit from the customs tab', hits[0]?.q.slug);
  for (const asked of ['woods', 'reserve', 'shoreline', 'streets-of-tarkov', 'customs', '../../etc', '', null, 42]) {
    const built = buildActions(hits, parseReply(JSON.stringify({
      answer: 'x', actions: [{ type: 'switchMap', map: asked }], quests: [woodsOnly.slug],
    })), 'customs');
    ok(!built.actions.some((a) => a.type === 'switchMap'),
      `a model-asked switchMap "${asked}" never leaves the server`, JSON.stringify(built.actions));
    ok(!built.actions.some((a) => a.type === 'flyTo'), 'and never a flyTo for a map we are not on');
  }
}
{
  for (const locked of LOCKED_MAP_KEYS) {
    ok(!isValidAction({ type: 'switchMap', map: locked, slug: 'x', objectiveId: null }, { map: 'customs' }),
      `the contract rejects a switch to ${locked}, which this site will not open`);
  }
  ok(!isValidAction({ type: 'switchMap', map: 'customs', slug: 'x', objectiveId: null }, { map: 'customs' }),
    'the contract rejects a switch to the map we are already on');
  ok(!isValidAction({ type: 'flyTo', objectiveId: 'a'.repeat(24), slug: 'x', map: 'woods' }, { map: 'customs' }),
    'the contract rejects a flyTo aimed at another map');
  ok(!isValidAction({ type: 'openHideout', slug: 'x' }, { map: 'customs' }), 'an action type outside the vocabulary is rejected');
}

/* --------------------------------------------------------------------- images */
// The failure mode that matters: an invented image URL. The model is never shown one — it picks
// server-minted ids out of a catalogue built from quests.json AND cross-checked against
// quest-images.json — so there is no field in its output that any code path reads a URL from.

console.log('\n# images');
const imgQuest = quests.find((q) => allow.has(q.id) && (q.images ?? []).length >= 2);
{
  const hits = rank(entries, `how do I do ${imgQuest.name}`, 'customs');
  ok(hits[0]?.q.slug === imgQuest.slug, 'the image-bearing quest is the lead hit', hits[0]?.q.slug);
  const cat = imageCatalog(hits, allow, 'customs');
  ok(cat.available && cat.refs.length > 0, `catalogue built (${cat.refs.length} refs)`);
  ok(cat.refs.every((r, i) => r.id === `img${i + 1}`), 'ids are minted img1..imgN', cat.refs.map((r) => r.id).join(','));
  ok(cat.refs.every(isValidImageRef), 'every ref satisfies the contract shape');
  ok(cat.refs.every((r) => allow.get(r.questSlug ? quests.find((q) => q.slug === r.questSlug).id : '')?.has(r.url)),
    'EVERY ref resolves to a real entry in quest-images.json under its own quest id');
  ok(cat.refs.every((r) => r.depicts.length > 0 && r.credit.includes('EFT Wiki')), 'every ref says what it depicts and carries its credit');
  ok(cat.refs.every((r) => new URL(r.url).host === 'static.wikia.nocookie.net'), 'one host, https only');

  const pick = { actions: [{ type: 'showImages', imageIds: [cat.refs[1].id, cat.refs[0].id] }], quests: [] };
  const got = buildImages(cat, pick);
  ok(got.length === 2 && got[0].id === cat.refs[1].id, 'the model picks by id, in its own order', got.map((g) => g.id).join(','));

  ok(buildImages(cat, { actions: [{ type: 'showImages', imageIds: ['img99', 'nope', 'img0'] }], quests: [] }).length === 0,
    'an id that was never minted resolves to nothing');
  ok(buildImages(cat, { actions: [{ type: 'showImages', imageIds: [{ url: 'https://evil.example/x.png' }] }], quests: [] }).length === 0,
    'an object where an id belongs is dropped');
  // the model hands us a complete, plausible, entirely invented image record
  const forged = buildImages(cat, {
    actions: [{ type: 'showImages', imageIds: ['img1'], url: 'https://evil.example/fake.png', images: [{ url: 'https://evil.example/fake.png', caption: 'Dorms' }] }],
    quests: [],
  });
  ok(forged.length === 1 && forged[0].url === cat.refs[0].url && !JSON.stringify(forged).includes('evil.example'),
    'a URL the model supplies is never read — only the id is', JSON.stringify(forged[0]?.url));
  ok(buildImages(cat, { actions: [], quests: [] }, [imgQuest.slug]).length > 0,
    'no showImages but the quest has photos -> the quest\'s own photos, still from the catalogue');
  ok(buildImages(cat, { actions: [{ type: 'showImages', imageIds: cat.refs.map((r) => r.id) }], quests: [] }).length <= MAX_IMAGES,
    `at most ${MAX_IMAGES} refs reach the client`);
}
{
  // a subject with no screenshot yields ZERO refs — never a placeholder, never a broken URL
  const bare = quests.find((q) => !allow.has(q.id) && !(q.images ?? []).length
    && !(q.objectives ?? []).some((o) => (o.images ?? []).length));
  const cat = imageCatalog([{ q: bare }], allow, 'customs');
  ok(cat.refs.length === 0, 'a quest with no wiki gallery has an empty catalogue', bare.slug);
  ok(buildImages(cat, { actions: [{ type: 'showImages', imageIds: ['img1'] }], quests: [] }).length === 0,
    'and asking for a photo there returns none rather than a broken one');
}
{
  // the index is a SECOND source: a quests.json row the index does not confirm is dropped.
  // One quest only, so the count is exactly the number of rows the index still vouches for.
  const solo = [{ q: imgQuest }];
  const full = imageCatalog(solo, allow, 'customs').refs.length;
  const half = new Map(allow);
  half.set(imgQuest.id, new Set([...allow.get(imgQuest.id)].slice(0, 1)));
  const halved = imageCatalog(solo, half, 'customs').refs.length;
  ok(full > 1 && halved === 1, 'an embedded row missing from quest-images.json is dropped', `${full} -> ${halved}`);
  const poisoned = new Map(allow);
  poisoned.set(imgQuest.id, new Set(['http://static.wikia.nocookie.net/x.png', 'https://evil.example/x.png']));
  ok(imageCatalog(solo, poisoned, 'customs').refs.length === 0, 'a wrong-host or non-https entry never becomes a ref');
  ok(imageCatalog(solo, null, 'customs').available === false, 'no index -> the catalogue reports itself unavailable');
  ok(imageCatalog(solo, null, 'customs').refs.length === 0, 'and offers nothing');
  ok(!isAllowedImageUrl('http://static.wikia.nocookie.net/x.png') && !isAllowedImageUrl('https://evil.example/x.png')
    && !isAllowedImageUrl('javascript:alert(1)') && isAllowedImageUrl(imageCatalog(solo, allow, 'customs').refs[0].url),
  'the URL gate holds');
}

/* ------------------------------------------------------------------ envelope */
console.log('\n# envelope (what the UI is handed)');
{
  const e = validateEnvelope({
    protocol: PROTOCOL_VERSION,
    map: 'woods',
    answer: 'x',
    actions: [
      { type: 'selectQuest', slug: 'abandoned-cargo', name: 'Abandoned Cargo' },
      { type: 'switchMap', map: 'shoreline', slug: 'abandoned-cargo', objectiveId: null },
      { type: 'showImages', imageIds: ['img7'] },
    ],
    images: [{ id: 'img1', url: 'https://evil.example/x.png', depicts: 'x', questSlug: 'a', objectiveId: null }],
    quests: ['abandoned-cargo', 'NOT A SLUG'],
  }, { map: 'customs' });
  // Staleness is judged on the RAW echo. `normalizeMapKey` folds `woods` onto `customs` now that
  // Woods is locked, and if `stale` were read off the folded value this envelope would look like a
  // Customs answer and its map-less `selectQuest` would have drawn a button on a map the answer
  // was never about. `echoedMap` is what the body said; `map` is what it normalizes to.
  ok(e.stale === true, 'an answer for another map is reported stale, not replayed', JSON.stringify([e.map, e.echoedMap]));
  ok(e.echoedMap === 'woods', 'the envelope remembers the map it was actually computed for', e.echoedMap);
  ok(e.map === 'customs', 'while `map` still normalizes to an openable key', e.map);
  ok(validateEnvelope({ protocol: PROTOCOL_VERSION, map: 'customs', answer: 'x' }, { map: 'customs' }).stale === false,
    'and an answer for the map we are on is not stale');
  ok(e.images.length === 0, 'an image ref on a foreign host is dropped client-side too');
  ok(!e.actions.some((a) => a.type === 'switchMap'), 'a switch to an unshipped map is dropped client-side too');
  ok(!e.actions.some((a) => a.type === 'showImages'), 'a showImages naming no surviving ref is dropped');
  ok(e.quests.length === 1, 'a malformed slug is dropped');
  ok(validateEnvelope(null).protocol === 0 && validateEnvelope(null).actions.length === 0, 'garbage in, empty envelope out');
  ok(validateEnvelope({ imageIndexOk: false }).imageIndexOk === false, 'an index outage stays visible to the UI');
}

console.log(`\n${fail ? 'FAILED' : 'PASSED'}  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
