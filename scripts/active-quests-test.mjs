#!/usr/bin/env node
/**
 * Active-quests rules test (docs/plans/ACTIVE-QUESTS.md).
 *
 * src/active-quests.js is the whole contract between the companion's quest log and the panel:
 * what a `{t:'quests'}` message means, which ids survive the intersection with quests.json, what
 * order the rows come out in, and — the one that can annoy a player badly if it drifts — exactly
 * when auto-select is allowed to put a quest on the map. All pure; no DOM, no network.
 *
 *   node scripts/active-quests-test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  MAX_IDS, normalizeIds, parseQuestsMessage, mergeQuestSets,
  activeRows, doneRows, autoSelectSlugs, sinceLabel, sinceCaveat,
} from '../src/active-quests.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// The `since` caveat is a LOCAL calendar date — it is read against EFT's own log filenames, which
// the game writes in local time. Pin a zone west of Greenwich so the assertions below are the same
// on every machine AND actually discriminate: 1785903953 is 2026-08-05 in UTC and 2026-08-04 here.
process.env.TZ = 'America/Denver';

/* ---------------------------------------------------------------- harness */
let pass = 0;
const fails = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (name, got, want) => check(name, Object.is(got, want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const same = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* --------------------------------------------------------------- fixtures */
// Deliberately hand-made, not read from quests.json: the rules must hold for any quest list.
const ALL = [
  { id: 'a1', slug: 'alpha', name: 'Alpha', trader: 'Prapor', maps: ['customs'], siteMaps: ['customs'] },
  { id: 'b2', slug: 'bravo', name: 'Bravo', trader: 'Therapist', maps: ['customs'], siteMaps: ['customs'] },
  { id: 'c3', slug: 'charlie', name: 'Charlie', trader: 'Skier', maps: ['woods'], siteMaps: ['woods'] },
  { id: 'd4', slug: 'delta', name: 'Delta', trader: 'Peacekeeper', maps: ['factory'], siteMaps: [] },
  { id: 'e5', slug: 'echo', name: 'Echo', trader: 'Mechanic', maps: ['customs', 'woods'], siteMaps: ['customs', 'woods'] },
];

/* ------------------------------------------------------------ normalising */
console.log('normalizeIds');
same('keeps order and drops duplicates', normalizeIds(['b2', 'a1', 'b2']), ['b2', 'a1']);
same('trims', normalizeIds([' a1 ']), ['a1']);
same('drops non-strings and empties', normalizeIds(['a1', 3, null, '', {}, ['b2']]), ['a1']);
same('drops ids with markup or spaces in them', normalizeIds(['<img src=x>', 'a b', 'ok_id-1']), ['ok_id-1']);
same('not an array is an empty list', normalizeIds('a1'), []);
eq('caps a flood', normalizeIds(Array.from({ length: 1400 }, (_, i) => `id${i}`)).length, MAX_IDS);

/* -------------------------------------------------------- message parsing */
console.log('parseQuestsMessage');
{
  const m = { t: 'quests', active: ['a1', 'b2'], done: ['c3'], failed: ['d4'], accountId: 12345, ts: 1700, since: '2026-08-04' };
  const q = parseQuestsMessage(m);
  same('active', q.active, ['a1', 'b2']);
  same('done', q.done, ['c3']);
  same('failed', q.failed, ['d4']);
  eq('accountId is stringified', q.accountId, '12345');
  eq('ts survives', q.ts, 1700);
  eq('since survives', q.since, '2026-08-04');
}
eq('a pos message is not a quest set', parseQuestsMessage({ type: 'pos', x: 1, z: 2 }), null);
eq('junk is not a quest set', parseQuestsMessage(null), null);
check('`type` is accepted as well as `t`', parseQuestsMessage({ type: 'quests', active: ['a1'] })?.active[0] === 'a1');
same('a finished quest never stays active',
  parseQuestsMessage({ t: 'quests', active: ['a1', 'b2'], done: ['b2'] }).active, ['a1']);
same('a failed quest never stays active',
  parseQuestsMessage({ t: 'quests', active: ['a1', 'b2'], failed: ['a1'] }).active, ['b2']);
check('a message with no lists is still a set', !!parseQuestsMessage({ t: 'quests' }));
check('ts defaults to now', parseQuestsMessage({ t: 'quests' }).ts >= 1);

/* ------------------------------------------------------------------ merge */
console.log('mergeQuestSets');
{
  const merged = mergeQuestSets([
    { active: ['a1'], done: ['b2'], failed: [], accountId: '1', ts: 10, since: '2026-08-04' },
    { active: ['b2', 'c3'], done: [], failed: ['d4'], accountId: '2', ts: 20, since: null },
  ]);
  same('active is the union, first source first', merged.active, ['a1', 'b2', 'c3']);
  same('a quest active for anyone is not listed as done', merged.done, []);
  same('failed keeps what is neither active nor done', merged.failed, ['d4']);
  eq('accountId is the first that has one', merged.accountId, '1');
  eq('since is the first that has one', merged.since, '2026-08-04');
  eq('ts is the newest', merged.ts, 20);
}
same('nothing to merge is an empty set', mergeQuestSets([]).active, []);

/* ------------------------------------------------------------------- rows */
console.log('activeRows — intersection and ordering');
{
  const rows = activeRows(ALL, ['c3', 'a1', 'zz', 'd4', 'b2'], 'customs');
  same('this map, in the order the game sent them', rows.here.map((r) => r.slug), ['alpha', 'bravo']);
  same('everything else, same rule', rows.elsewhere.map((r) => r.slug), ['charlie', 'delta']);
  same('ids with no quest are reported, never rendered', rows.unknown, ['zz']);
  same('an off-map row carries its maps as badges', rows.elsewhere[0].maps, ['woods']);
  eq('a row knows its trader', rows.here[0].trader, 'Prapor');
}
{
  const rows = activeRows(ALL, ['e5'], 'woods');
  same('a multi-map quest is "here" on either of them', rows.here.map((r) => r.slug), ['echo']);
  same('…and nowhere else', activeRows(ALL, ['a1'], 'woods').here, []);
}
same('an empty set has no rows', activeRows(ALL, [], 'customs').here, []);
same('an undefined set has no rows', activeRows(ALL, undefined, 'customs').elsewhere, []);
same('a quest with no site map is never "here"', activeRows(ALL, ['d4'], 'customs').here, []);

console.log('doneRows');
same('completed ids resolve the same way', doneRows(ALL, ['b2', 'nope', 'c3'], 'customs').map((r) => r.slug), ['bravo', 'charlie']);
check('a completed row still knows whether it is on this map',
  doneRows(ALL, ['b2'], 'customs')[0].here === true && doneRows(ALL, ['c3'], 'customs')[0].here === false);

/* ------------------------------------------------------------ auto-select */
console.log('autoSelectSlugs');
const auto = (o) => autoSelectSlugs({ all: ALL, mapKey: 'customs', ...o });
same('picks the active quests that have objectives here', auto({ activeIds: ['a1', 'c3', 'b2'] }), ['alpha', 'bravo']);
same('never picks a quest with nothing on this map', auto({ activeIds: ['c3', 'd4'] }), []);
same('off means off', auto({ activeIds: ['a1'], auto: false }), []);
same('never re-adds what is already selected', auto({ activeIds: ['a1', 'b2'], selected: ['alpha'] }), ['bravo']);
same('never fights a manual removal (applied once, never again)',
  auto({ activeIds: ['a1', 'b2'], selected: [], applied: new Set(['alpha']) }), ['bravo']);
same('a manual selection is never in the output, so it can never be dropped',
  auto({ activeIds: [], selected: ['charlie', 'alpha'] }), []);
same('duplicate ids do not produce duplicate slugs', auto({ activeIds: ['a1', 'a1'] }), ['alpha']);
same('unknown ids are ignored', auto({ activeIds: ['zzz'] }), []);
same('order follows the game, not the quest file', auto({ activeIds: ['b2', 'a1'] }), ['bravo', 'alpha']);
same('another map picks that map’s quests', autoSelectSlugs({ all: ALL, mapKey: 'woods', activeIds: ['a1', 'c3', 'e5'] }), ['charlie', 'echo']);

/* ---------------------------------------------------------------- caveats */
console.log('since caveat');
eq('ISO date', sinceLabel('2026-08-04'), '2026-08-04');
eq('ISO timestamp', sinceLabel('2026-08-04T21:25:52.179Z'), '2026-08-04');
eq('seconds epoch', sinceLabel(1785903953), '2026-08-04');
eq('ms epoch', sinceLabel(1785903953000), '2026-08-04');
eq('nothing means nothing', sinceLabel(null), '');
eq('unparseable is echoed, not crashed', sinceLabel('whenever'), 'whenever');
// The bug this pins: an evening-local log was reported as the NEXT day, which is the one direction
// a "data only reaches back this far" line must never round.
eq('an evening-local instant stays on its own day',
  sinceLabel(new Date('2026-08-04T21:00:00-06:00').getTime()), '2026-08-04');
eq('a date-only string is passed through, never re-parsed as UTC midnight',
  sinceLabel('2026-01-01'), '2026-01-01');
check('the caveat names the date', sinceCaveat('2026-08-04').includes('2026-08-04'));
eq('no since, no caveat line', sinceCaveat(null), '');

/* ------------------------------------------- the real quest file still fits */
console.log('against public/data/quests.json');
{
  const all = JSON.parse(readFileSync(join(root, 'public/data/quests.json'), 'utf8'));
  const customs = all.filter((q) => (q.siteMaps ?? []).includes('customs'));
  check('the file has Customs quests to work with', customs.length >= 3, String(customs.length));
  const ids = customs.slice(0, 3).map((q) => q.id);
  const rows = activeRows(all, [...ids, 'not-a-task'], 'customs');
  eq('real ids resolve to real rows', rows.here.length, 3);
  same('and auto-select would put exactly those on the map',
    autoSelectSlugs({ all, activeIds: ids, mapKey: 'customs' }), customs.slice(0, 3).map((q) => q.slug));
  eq('a non-task id is dropped, not drawn', rows.unknown.length, 1);
  // Every id in the file must survive normalisation, or a real quest would silently never match.
  const kept = all.map((q) => q.id).filter((id) => normalizeIds([id]).length === 1).length;
  eq('every quest id in the file survives normalisation', kept, all.length);
  // …and they must survive it TOGETHER. The cap is what a player's `done` list runs into at the end
  // of the game: at 500, against 517 quests, finished quests were dropped and came back as active.
  eq('the whole quest list fits under the id cap in one call', normalizeIds(all.map((q) => q.id)).length, all.length);
  check('the cap leaves headroom over the quest count', MAX_IDS >= all.length * 1.5, `${MAX_IDS} vs ${all.length}`);
}

/* -------------------------------------------------------------- summary */
console.log('');
if (fails.length) {
  console.error(`✗ active quests: ${fails.length} failed, ${pass} passed`);
  for (const f of fails) console.error(`   ${f}`);
  process.exit(1);
}
console.log(`✓ active quests: ${pass} checks passed`);
