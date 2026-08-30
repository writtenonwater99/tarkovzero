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
} from '../api/assistant.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const quests = JSON.parse(readFileSync(join(root, 'public/data/quests.json'), 'utf8'));
const entries = index(quests);

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

  // a quest whose markers are on another site map -> switchMap, never a flyTo
  const woodsOnly = quests.find((q) => (q.siteMaps ?? []).length === 1 && q.siteMaps[0] === 'woods');
  out = buildActions([{ q: woodsOnly }], { answer: '', actions: [], quests: [woodsOnly.slug] }, 'customs');
  ok(out.actions.some((a) => a.type === 'switchMap' && a.map === 'woods'), 'off-map quest asks for a map switch', JSON.stringify(out));
  ok(!out.actions.some((a) => a.type === 'flyTo'), 'no flyTo when nothing is on this map');

  out = buildActions(hits, { answer: '', actions: [], quests: [] }, 'customs');
  ok(out.actions.length === 0, 'no quest identified -> no actions');
}

console.log(`\n${fail ? 'FAILED' : 'PASSED'}  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
