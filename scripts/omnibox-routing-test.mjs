#!/usr/bin/env node
/**
 * Omnibox routing test (step 2).
 *
 * `route()` decides what Enter does, so it is the one piece of the omnibox that must not drift:
 * free text must never reach the assistant on its own, `>` must always mean a command, and `?`
 * must always mean the model. Plain node, no deps — src/omnibox.js only imports src/icons.js and
 * neither touches the DOM at module scope.
 */
import { route, matchCommand, COMMANDS } from '../src/omnibox.js';

/* ------------------------------------------------------------- fixtures -- */
const INDEX = [
  { kind: 'extract', label: 'Dorms V-Ex', sub: 'pmc · surface', x: 1, z: 2, badge: 'D' },
  { kind: 'place', label: 'Dorms', sub: 'place', x: 3, z: 4 },
  { kind: 'place', label: 'Gas Station', sub: 'place', x: 5, z: 6 },
  { kind: 'lock', label: 'ZB-1011 key', sub: 'lock · surface', x: 7, z: 8, mk: 'lock' },
  { kind: 'quest', label: 'Gunsmith - Part 1', sub: 'Mechanic · here', slug: 'gunsmith-part-1', trader: 'Mechanic', here: true },
  { kind: 'layer', label: 'Scav spawn', sub: 'filter', mk: 'spawn-scav' },
];
const lookup = (q) => {
  const s = q.toLowerCase();
  return INDEX.filter((r) => r.label.toLowerCase().includes(s) || (r.trader ?? '').toLowerCase().includes(s));
};
const ctx = { lookup };

/* ---------------------------------------------------------------- harness */
let pass = 0;
const fails = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (name, got, want) => check(name, Object.is(got, want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ------------------------------------------------------------------ idle */
console.log('idle');
{
  const r = route('', ctx);
  eq('empty input is idle', r.mode, 'idle');
  eq('empty input has no rows', r.rows.length, 0);
  eq('empty input highlights nothing', r.index, -1);
}

/* -------------------------------------------------- no prefix: exact hit */
console.log('lookup — exact match');
{
  const r = route('Dorms', ctx);
  eq('mode', r.mode, 'lookup');
  eq('exact name is the highlighted row', r.rows[r.index]?.label, 'Dorms');
  eq('highlighted row is a result', r.rows[r.index]?.type, 'result');
  check('the exact row wins over the longer prefix match', r.rows[r.index].item.kind === 'place');
  eq('the last row is the Ask row', r.rows[r.rows.length - 1].type, 'ask');
  check('the Ask row is never the highlighted one', r.rows[r.index].type !== 'ask');
}

/* ---------------------------------------------- no prefix: partial match */
console.log('lookup — partial match');
{
  const r = route('dorm', ctx);
  eq('mode', r.mode, 'lookup');
  eq('first result is highlighted', r.index, 0);
  eq('first result is a result row', r.rows[0].type, 'result');
  check('both dorms rows are listed', r.rows.filter((x) => x.type === 'result').length === 2);
}

/* --------------------------------------------------- no prefix: no match */
console.log('lookup — no match');
{
  const r = route('xyzzy nothing here', ctx);
  eq('mode is still lookup — free text never auto-routes to the AI', r.mode, 'lookup');
  eq('one row', r.rows.length, 1);
  eq('and it is the Ask row', r.rows[0].type, 'ask');
  eq('carrying the typed text', r.rows[0].text, 'xyzzy nothing here');
  eq('nothing is highlighted, so Enter does nothing', r.index, -1);
  check('but the row is reachable with ArrowDown', r.rows[0].selectable === true);
}

/* --------------------------------------------------- `>` command parsing */
console.log('commands');
{
  const r = route('> layers scav', ctx);
  eq('mode', r.mode, 'command');
  eq('command name', r.rows[0].cmd.name, 'layers');
  eq('argument echo', r.rows[0].arg, 'scav');
  eq('highlighted', r.index, 0);
}
{
  const r = route('>lyr scav', ctx);
  eq('fuzzy: >lyr -> layers', r.rows[0].cmd.name, 'layers');
  eq('fuzzy keeps the argument', r.rows[0].arg, 'scav');
}
{
  const r = route('> flr 2', ctx);
  eq('fuzzy: >flr -> floor', r.rows[0].cmd.name, 'floor');
  eq('argument', r.rows[0].arg, '2');
}
{
  const r = route('> 3d', ctx);
  eq('exact short command', r.rows[0].cmd.name, '3d');
  eq('no argument', r.rows[0].arg, '');
}
{
  const r = route('> clear trails', ctx);
  eq('two-word command', r.rows[0].cmd.name, 'clear trails');
  eq('two-word command takes no argument', r.rows[0].arg, '');
}
{
  const r = route('> clear', ctx);
  eq('prefix of a two-word command', r.rows[0].cmd.name, 'clear trails');
}
{
  // `> my quests` opens the panel at the game's own quest log — and must not steal `> quests`.
  const r = route('> my quests', ctx);
  eq('two-word my quests', r.rows[0].cmd.name, 'my quests');
  eq('my quests takes no argument', r.rows[0].arg, '');
  eq('and Enter runs it', r.index, 0);
}
{
  eq('prefix of my quests', route('> my', ctx).rows[0].cmd.name, 'my quests');
  eq('`> quests` still means the panel', route('> quests', ctx).rows[0].cmd.name, 'quests');
  eq('the alias resolves too', route('> active quests', ctx).rows[0].cmd.name, 'my quests');
}
{
  const r = route('> pin quests', ctx);
  eq('pin command', r.rows[0].cmd.name, 'pin');
  eq('pin argument', r.rows[0].arg, 'quests');
}
{
  const r = route('>', ctx);
  eq('bare > lists the vocabulary', r.rows.length, COMMANDS.length);
  eq('…but highlights nothing', r.index, -1);
}
{
  const r = route('> zzzz', ctx);
  eq('unknown command has no selectable row', r.rows[0].selectable, false);
  eq('and highlights nothing', r.index, -1);
}
{
  eq('a command never falls through to lookup', route('> fit', ctx).mode, 'command');
  check('matchCommand rejects an unrelated word', matchCommand(COMMANDS.find((c) => c.name === 'floor'), 'wxyz') === null);
}

/* ------------------------------------------------------------ `?` -> AI */
console.log('assistant');
{
  const r = route('?where do I plant the marker', ctx);
  eq('mode', r.mode, 'ai');
  eq('one row', r.rows.length, 1);
  eq('ask row', r.rows[0].type, 'ask');
  eq('question text loses the prefix', r.rows[0].text, 'where do I plant the marker');
  eq('and Enter sends it', r.index, 0);
}
{
  const r = route('? dorms', ctx);
  eq('the ? prefix wins over an exact place name', r.mode, 'ai');
  eq('text is trimmed', r.rows[0].text, 'dorms');
}
{
  const r = route('?', ctx);
  eq('a bare ? is not sendable', r.index, -1);
}

/* -------------------------------------------------------------- summary */
console.log('');
if (fails.length) {
  console.error(`✗ omnibox routing: ${fails.length} failed, ${pass} passed`);
  for (const f of fails) console.error(`   ${f}`);
  process.exit(1);
}
console.log(`✓ omnibox routing: ${pass} checks passed`);
