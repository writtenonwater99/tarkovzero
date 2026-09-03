/**
 * The map availability source, and the two things that must never disagree with it.
 *
 * Founder, 2026-09-02: *"on the live page for now on the maps tab put all the maps but lock them.
 * even the woods/reserve. so rn customs is what avalible."*
 *
 * The failure this file exists to prevent is the one the handoff's §6 keeps describing: a UI that
 * offers something the system will refuse. Before `src/map-availability.js` there were two lists —
 * `MAPS` in `src/mapdata.js` (what the picker offered) and `SITE_MAPS` in
 * `src/assistant-contract.js` (what the assistant could hand off to) — and nothing forced them to
 * agree. They agreed by coincidence. The moment one map is locked they must not, unless they are
 * the same list.
 *
 *   node --test scripts/map-availability.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  AVAILABLE_MAP_KEYS, EFT_MAPS, EFT_MAP_KEYS, LOCKED_BADGE, LOCKED_MAP_KEYS, LOCKED_NOTE,
  MAPPED_MAP_KEYS, MAP_NAMES, assertAvailabilityIsBuildable, isAvailableMap, isEftMap, isLockedMap,
  mapAvailability, mapName, normalizeMapRequestKey,
} from '../src/map-availability.js';
import { MAPS, CUSTOMS, resolveMapRequest, selectMap } from '../src/mapdata.js';
import {
  SITE_MAPS, MAP_LABELS, OTHER_MAP_LABELS, isSiteMap, knownMap, mapLabel, normalizeMapKey,
} from '../src/assistant-contract.js';

/* ------------------------------------------------------------------ the list -- */

test('the picker offers all eleven EFT maps, and exactly one of them opens', () => {
  assert.equal(EFT_MAPS.length, 11, `the picker lists ${EFT_MAPS.length} maps`);
  assert.equal(new Set(EFT_MAP_KEYS).size, 11, 'every key is distinct');
  assert.deepEqual(AVAILABLE_MAP_KEYS, ['customs'], 'Customs is what is available right now');
  assert.equal(LOCKED_MAP_KEYS.length, 10);
  // Derived, not typed: open + locked must account for the whole picker with no overlap.
  assert.deepEqual([...AVAILABLE_MAP_KEYS, ...LOCKED_MAP_KEYS].sort(), [...EFT_MAP_KEYS].sort());
  assert.ok(!LOCKED_MAP_KEYS.some((k) => AVAILABLE_MAP_KEYS.includes(k)), 'no map is both');
  for (const k of EFT_MAP_KEYS) assert.ok(MAP_NAMES[k], `${k} has no display name`);
});

test('Reserve and Woods are LOCKED, and their data is untouched', () => {
  // The founder's actual instruction. They work; he does not want them shown beside a finished
  // Customs. That is a navigation decision, so the registry keeps them and the availability list
  // does not.
  for (const k of ['reserve', 'woods']) {
    assert.ok(isLockedMap(k), `${k} should be locked`);
    assert.ok(!isAvailableMap(k), `${k} must not be openable`);
    assert.ok(MAPS[k], `${k} lost its map config — this was a lock, not a deletion`);
    assert.ok(MAPPED_MAP_KEYS.includes(k), `${k} lost its render-data entry`);
  }
  assert.deepEqual([...MAPPED_MAP_KEYS], ['customs', 'reserve', 'woods']);
  assert.deepEqual(Object.keys(MAPS).sort(), [...MAPPED_MAP_KEYS].sort(),
    'the render registry and the mapped-data list are one statement');
});

test('mapAvailability answers with exactly three words, and no fourth', () => {
  assert.equal(mapAvailability('customs'), 'available');
  assert.equal(mapAvailability('woods'), 'locked');
  assert.equal(mapAvailability('atlantis'), 'unknown');
  assert.equal(mapAvailability(''), 'unknown');
  assert.equal(mapAvailability(null), 'unknown');
  assert.ok(isEftMap('the-labyrinth') && !isEftMap('icebreaker'),
    'icebreaker appears in quests.json and is deliberately not one of the eleven');
});

test('an availability list naming a map with no data is refused at load', () => {
  assert.ok(assertAvailabilityIsBuildable(Object.keys(MAPS)));
  assert.throws(() => assertAvailabilityIsBuildable(['reserve', 'woods']), /no map data/,
    'a build that dropped the Customs data must not boot with Customs advertised as open');
});

/* ------------------------------------------------- one list, two consumers ----- */

test('the picker and the assistant read ONE list — SITE_MAPS *is* AVAILABLE_MAP_KEYS', () => {
  assert.equal(SITE_MAPS, AVAILABLE_MAP_KEYS,
    'SITE_MAPS must be the same frozen array, not a copy that can drift');
  assert.deepEqual(Object.keys(MAP_LABELS), [...AVAILABLE_MAP_KEYS]);
  assert.deepEqual(Object.keys(OTHER_MAP_LABELS).sort(), [...LOCKED_MAP_KEYS].sort(),
    'every locked map has a name the assistant can say');
  for (const k of EFT_MAP_KEYS) {
    assert.equal(mapLabel(k), MAP_NAMES[k], `${k} reads differently to the two halves`);
    assert.equal(knownMap(k), true, `${k} is unknown to the contract`);
    assert.equal(isSiteMap(k), isAvailableMap(k), `${k}: the two predicates disagree`);
  }
});

test('locking a map removes it as a handoff target, at the contract level', () => {
  for (const k of LOCKED_MAP_KEYS) {
    assert.equal(isSiteMap(k), false, `${k} is still a switchMap target`);
    assert.equal(normalizeMapKey(k), 'customs', `${k} still normalizes to itself`);
  }
  assert.equal(normalizeMapKey('customs'), 'customs');
  // Case is NOT folded here on purpose: an echoed 'CUSTOMS' must not survive into an envelope
  // whose `map` no longer string-compares against the tab it came from.
  assert.equal(normalizeMapKey('CUSTOMS'), 'customs');
});

/* ------------------------------------------------------------ ?map= and state -- */

test('?map=woods lands on Customs and says which map it wanted', () => {
  const woods = resolveMapRequest('woods');
  assert.equal(woods.status, 'locked');
  assert.equal(woods.requested, 'woods', 'the resolver remembers what the URL asked for');
  assert.equal(woods.map.key, 'customs');
  assert.equal(selectMap('woods').key, 'customs');
  assert.equal(selectMap('reserve').key, 'customs');
});

test('the other three ?map= outcomes are distinct, so the page can say the right thing', () => {
  assert.equal(resolveMapRequest('customs').status, 'available');
  assert.equal(resolveMapRequest('customs').map, MAPS.customs);
  assert.equal(resolveMapRequest(null).status, 'default');
  assert.equal(resolveMapRequest('').status, 'default');
  assert.equal(resolveMapRequest('atlantis').status, 'unknown');
  assert.equal(resolveMapRequest('../../etc/passwd').status, 'unknown');
  for (const v of [null, '', 'atlantis', 'woods', '  WOODS  ']) {
    assert.equal(resolveMapRequest(v).map, CUSTOMS, `${JSON.stringify(v)} did not fall back to Customs`);
  }
  // A human types into an address bar; the value is folded before it is judged.
  assert.equal(normalizeMapRequestKey('  Woods '), 'woods');
  assert.equal(resolveMapRequest('  Woods ').status, 'locked');
});

test('there is no saved map preference to go stale — the URL is the whole memory', () => {
  // Asserted rather than assumed. The only place a map choice is ever written down is the
  // assistant's `tz:askPending` sessionStorage handoff, which carries `{map, objectiveId, turns}`
  // and is dropped on arrival when its `map` does not equal the tab's (src/assistant.js `init`).
  // With Woods locked, a handoff written before the lock lands on a Customs page, fails that
  // comparison and is discarded — and it is removed from sessionStorage either way.
  const sources = ['../src/main.js', '../src/quests.js', '../src/live.js', '../src/shell.js'];
  for (const rel of sources) {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.ok(!/['"]tz:map['"]/.test(src), `${rel} persists a map key — this test's premise is broken`);
    assert.ok(!/(store|localStorage)\.(get|set|getItem|setItem)\(\s*['"]map['"]/.test(src),
      `${rel} reads or writes a stored map preference`);
  }
});

test('every path that can navigate the page asks the availability list first', () => {
  // Four ways to change map: the picker, `> map`, the raid-detection toast, and the assistant's
  // switchMap handoff. Three of them go through `goMap()`; the fourth reloads the page itself.
  // Pinned to source, because there is no DOM here and a missed gate is a silent page reload onto
  // a map the picker refuses — the URL would say `?map=woods` on a Customs page.
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(main, /const goMap = \(key\) => \{\n(?:.*\n)*?\s*if \(!isAvailableMap\(key\)\) return false;/,
    'goMap() must refuse a locked map before it reloads the page');
  assert.match(main, /if \(b\.dataset\.locked\)/, 'the picker click handler must recognise a locked row');
  assert.match(main, /const target = isAvailableMap\(p\.map\) \? MAPS\[p\.map\] : null;/,
    'the raid-switch toast must offer Switch only for an openable map');

  const assistant = readFileSync(new URL('../src/assistant.js', import.meta.url), 'utf8');
  assert.match(assistant, /if \(!isSiteMap\(map\)\) return false;/,
    'assistant switchMap() must refuse a locked map — window.tz is public and reloads the page itself');
});

/* --------------------------------------------------------------- the UI copy -- */

test('a locked row says what it is, in one short honest word', () => {
  assert.equal(LOCKED_BADGE, 'SOON');
  assert.equal(LOCKED_NOTE, 'not available yet');
  // The badge is decoration; the note is what a screen reader and a tooltip get. Both must be
  // present, because a greyed row with no explanation is the dead click the founder called out.
  assert.ok(LOCKED_BADGE.length <= 6 && LOCKED_NOTE.length <= 40);
  assert.equal(mapName('woods'), 'Woods');
  assert.equal(mapName('streets-of-tarkov'), 'Streets of Tarkov');
  assert.equal(mapName('atlantis'), 'atlantis', 'an unknown key reads back as itself, never as Customs');
});
