#!/usr/bin/env node
/**
 * TarkovZero — marker icon vocabulary (`src/icons.js`).
 *
 * This suite exists for ONE reason: the loot families have to be told apart at the size the map
 * actually draws them. Before 2026-09-02 there were seven `ci` loot kinds in seven greys whose
 * closest pair was 5.5 apart in RGB and whose Rec.709 luma spread was 14.1 of 255 — a third of the
 * icon vocabulary rendering as one grey dot. Every colour assertion below is written so that the
 * OLD seven FAIL it by an order of magnitude, and `OLD_LOOT_COLORS` is kept here so the test can
 * prove that in-process instead of asking you to take it on trust (see "discriminates" tests).
 *
 * The other three things it pins:
 *   - no orphaned pre-collapse kind string survives anywhere in src/ or scripts/;
 *   - every container type in the SHIPPED map data resolves to a marker kind (41% used to be
 *     dropped silently by `classify()`);
 *   - the extract badge still pins its letter ink with `textLength`, which is what buys 2D/3D
 *     parity now that the face name has moved to IBM Plex Sans Condensed.
 *
 *   npm run test:icons
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

import {
  KINDS, CONTAINER_KIND, CONTAINER_TYPE, LEGACY_KIND,
  BADGE_TONES, GLYPH_HALO, HALO_W, glyphInk,
  iconDataUrl, iconHtml, dotColor, dotHtml, desaturate,
} from '../src/icons.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/* ------------------------------------------------------------ colour maths --- */
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
/** Rec.709 relative luma — the yardstick the 5.5 / 14.1 measurement of the old seven was taken with. */
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/**
 * Closest pair, and the spread, over a set of hex colours.
 *
 * `skip` exempts individual PAIRS by index — which is the whole point. `sq` used to be exempted as a
 * WHOLE FAMILY on a reason that covers exactly one of its ten pairs (`extract-pmc` and
 * `extract-shared` share one hue by design, so a pairwise minimum over the family is 0 and measures
 * nothing). Skipping the family to dodge that one pair also stopped measuring the other nine, and
 * nothing would have caught an extract-hue tweak pushing transit onto stash.
 *
 * `pair` is `[]` rather than `null` when there is nothing to compare, so a caller's `.join()` is
 * total — a one-member family used to TypeError with "Cannot read properties of null", an error that
 * says nothing about colours and reads as a broken test.
 */
function separation(hexes, { skip = [] } = {}) {
  const cols = hexes.map(rgb);
  const skipped = new Set(skip.map((p) => [...p].sort().join('|')));
  let min = Infinity, pair = [];
  for (let i = 0; i < cols.length; i++) {
    for (let j = i + 1; j < cols.length; j++) {
      if (skipped.has([hexes[i], hexes[j]].sort().join('|'))) continue;
      const d = dist(cols[i], cols[j]);
      if (d < min) { min = d; pair = [hexes[i], hexes[j]]; }
    }
  }
  const ls = cols.map(luma);
  return {
    min: min === Infinity ? Infinity : min,
    pair,
    spread: ls.length ? Math.max(...ls) - Math.min(...ls) : 0,
  };
}

/**
 * The floors. These are the whole point of the change, so they are stated as numbers rather than
 * derived from the palette they are meant to police.
 *
 * BADGE is the 12-22 px icon; DOT is the `dot` tier, where `desaturate()` has pulled every colour
 * 55% toward its own luma and colour is the ONLY channel left (no shape, no glyph, 6 px). The dot
 * floor is the one that decides whether a zoomed-out map reads.
 */
const FLOOR = { badgeMin: 90, badgeSpread: 55, dotMin: 45, dotSpread: 45 };

/** The seven greys this change replaced — kept so the assertions can be shown to discriminate. */
const OLD_LOOT_COLORS = ['#707875', '#81735E', '#7D7062', '#64786E', '#80785C', '#706866', '#706F65'];
/** The seven kind strings that must not survive anywhere. */
const OLD_LOOT_KINDS = ['loot-weapon', 'loot-crate', 'loot-cash', 'loot-med', 'loot-key', 'loot-dead', 'loot-loose'];

const LOOT_KINDS = Object.keys(KINDS).filter((k) => k.startsWith('loot-'));

/* --------------------------------------------------------- 1. the families --- */
test('loot collapses to exactly three families, all circles', () => {
  assert.deepEqual(LOOT_KINDS, ['loot-consumables', 'loot-valuables', 'loot-gear']);
  for (const k of LOOT_KINDS) assert.equal(KINDS[k].shape, 'ci', `${k} must stay a circle`);
});

test('the three loot hues separate at the BADGE tier', () => {
  const s = separation(LOOT_KINDS.map((k) => KINDS[k].color));
  console.log(`  badge tier: minRGB ${s.min.toFixed(1)} (${s.pair.join(' vs ')}) · luma709 spread ${s.spread.toFixed(1)}`);
  assert.ok(s.min >= FLOOR.badgeMin, `closest badge pair ${s.min.toFixed(1)} < floor ${FLOOR.badgeMin} (${s.pair})`);
  assert.ok(s.spread >= FLOOR.badgeSpread, `badge luma spread ${s.spread.toFixed(1)} < floor ${FLOOR.badgeSpread}`);
});

test('the three loot hues separate at the DOT tier, where colour is the only channel', () => {
  const s = separation(LOOT_KINDS.map((k) => dotColor(k)));
  console.log(`  dot tier:   minRGB ${s.min.toFixed(1)} (${s.pair.join(' vs ')}) · luma709 spread ${s.spread.toFixed(1)}`);
  assert.ok(s.min >= FLOOR.dotMin, `closest dot pair ${s.min.toFixed(1)} < floor ${FLOOR.dotMin} (${s.pair})`);
  assert.ok(s.spread >= FLOOR.dotSpread, `dot luma spread ${s.spread.toFixed(1)} < floor ${FLOOR.dotSpread}`);
});

test('the separation floors DISCRIMINATE — the old seven greys fail every one of them', () => {
  const badge = separation(OLD_LOOT_COLORS);
  const dot = separation(OLD_LOOT_COLORS.map((h) => desaturate(h)));
  console.log(`  OLD 7 badge: minRGB ${badge.min.toFixed(1)} · luma709 spread ${badge.spread.toFixed(1)}`);
  console.log(`  OLD 7 dot:   minRGB ${dot.min.toFixed(1)} · luma709 spread ${dot.spread.toFixed(1)}`);
  assert.ok(badge.min < FLOOR.badgeMin, 'old badge minRGB would have passed — the floor is too low to mean anything');
  assert.ok(badge.spread < FLOOR.badgeSpread, 'old badge luma spread would have passed');
  assert.ok(dot.min < FLOOR.dotMin, 'old dot minRGB would have passed');
  assert.ok(dot.spread < FLOOR.dotSpread, 'old dot luma spread would have passed');
});

/* --------------------------------- 1b. the OTHER two families, re-cut 2026-09-03 --- */
/*
 * The loot floors above were measured for the 7->3 collapse and are the repo's documented
 * standard. The spawn shields and the utility diamonds were never held to them, and they failed:
 *
 *   spawns      badge min 50.9 (sniper #e2793f vs boss #d24a4a) · dot min 39.0 · luma spread 64.3
 *   utilities   badge min 48.8 (weapon #6E6860 vs lock  #808682) · dot min 32.2 · luma spread 74.1
 *
 * Four near-white silhouettes on four desaturated mid-values, and two identical grey diamonds, all
 * drawn over brown-olive Customs terrain at `--marker-opacity:.72`. Both families are re-cut to
 * clear the SAME floors, and `OLD_*_COLORS` below keeps the previous palettes in-process so this
 * suite can show the floors discriminate instead of asking anyone to take it on trust.
 *
 * `sq` (extracts, transits, stashes) is deliberately not floored: `extract-pmc` and
 * `extract-shared` share one hue ON PURPOSE — shared is the single two-colour badge, half PMC
 * green and half scav orange via `color2` — so a pairwise minimum over that family is 0 by design
 * and would measure nothing. The one-kind `hex` family has no pair at all.
 */
const FAMILY_OF = (shape) => Object.keys(KINDS).filter((k) => KINDS[k].shape === shape);
const SPAWN_KINDS = FAMILY_OF('sh');
const UTILITY_KINDS = FAMILY_OF('dia');
/** The palettes this pass replaced, verbatim. */
const OLD_SPAWN_COLORS = { 'spawn-pmc': '#7fa0b4', 'spawn-scav': '#c9a463', 'spawn-sniper': '#e2793f', 'spawn-boss': '#d24a4a' };
const OLD_UTILITY_COLORS = { hazard: '#8258A6', weapon: '#6E6860', switch: '#D6B236', lock: '#808682' };

/** Report and assert one family against both floors, at both tiers. */
function assertFamilyFloors(title, kinds, colorOf, { skipPairs = [] } = {}) {
  // A family with fewer than two members has no pair to measure. Saying so and returning is what
  // stops `assertFamilyFloors('quests', FAMILY_OF('hex'), ...)` — the natural next step after the
  // cross-family test below — from failing with a TypeError that mentions no colours at all.
  if (kinds.length < 2) {
    console.log(`  ${title}: a single kind, so there is no pair to separate`);
    return null;
  }
  const skipHex = skipPairs.map((p) => p.map(colorOf));
  const badge = separation(kinds.map(colorOf), { skip: skipHex });
  const dot = separation(kinds.map((k) => desaturate(colorOf(k))), {
    skip: skipHex.map((p) => p.map((h) => desaturate(h))),
  });
  console.log(`  ${title} badge: minRGB ${badge.min.toFixed(1)} (${badge.pair.join(' vs ')}) · luma709 spread ${badge.spread.toFixed(1)}`);
  console.log(`  ${title} dot:   minRGB ${dot.min.toFixed(1)} (${dot.pair.join(' vs ')}) · luma709 spread ${dot.spread.toFixed(1)}`);
  assert.ok(badge.min >= FLOOR.badgeMin, `${title} closest badge pair ${badge.min.toFixed(1)} < floor ${FLOOR.badgeMin} (${badge.pair})`);
  assert.ok(badge.spread >= FLOOR.badgeSpread, `${title} badge luma spread ${badge.spread.toFixed(1)} < floor ${FLOOR.badgeSpread}`);
  assert.ok(dot.min >= FLOOR.dotMin, `${title} closest dot pair ${dot.min.toFixed(1)} < floor ${FLOOR.dotMin} (${dot.pair})`);
  assert.ok(dot.spread >= FLOOR.dotSpread, `${title} dot luma spread ${dot.spread.toFixed(1)} < floor ${FLOOR.dotSpread}`);
  return { badge, dot };
}

test('the four SPAWN shields separate at both tiers', () => {
  assert.deepEqual(SPAWN_KINDS, ['spawn-pmc', 'spawn-scav', 'spawn-sniper', 'spawn-boss']);
  assertFamilyFloors('spawns', SPAWN_KINDS, (k) => KINDS[k].color);
});

test('the four UTILITY diamonds separate at both tiers', () => {
  assert.deepEqual(UTILITY_KINDS, ['hazard', 'weapon', 'switch', 'lock']);
  assertFamilyFloors('utilities', UTILITY_KINDS, (k) => KINDS[k].color);
});

test('THE MEASURED DEFECTS: the two named pairs were under half the loot floor', () => {
  // Defect 1 — `weapon` vs `lock`: same diamond, same value, both on grey concrete.
  // Defect 2 — the spawn blob: sniper vs boss at the badge, scav vs sniper at the dot.
  const at = (a, b, colors) => separation([colors[a], colors[b]]).min;
  const before = {
    'weapon/lock': at('weapon', 'lock', OLD_UTILITY_COLORS),
    'sniper/boss': at('spawn-sniper', 'spawn-boss', OLD_SPAWN_COLORS),
    'scav/sniper': at('spawn-scav', 'spawn-sniper', OLD_SPAWN_COLORS),
  };
  const now = {
    'weapon/lock': separation([KINDS.weapon.color, KINDS.lock.color]).min,
    'sniper/boss': separation([KINDS['spawn-sniper'].color, KINDS['spawn-boss'].color]).min,
    'scav/sniper': separation([KINDS['spawn-scav'].color, KINDS['spawn-sniper'].color]).min,
  };
  for (const key of Object.keys(before)) {
    console.log(`  ${key.padEnd(12)} before ${before[key].toFixed(1).padStart(6)} -> after ${now[key].toFixed(1).padStart(6)}`);
    assert.ok(before[key] < FLOOR.badgeMin, `${key} would have passed the floor before the change — the floor means nothing`);
    assert.ok(now[key] >= FLOOR.badgeMin, `${key} is still ${now[key].toFixed(1)} apart, under the ${FLOOR.badgeMin} floor`);
  }
});

test('the family floors DISCRIMINATE — the old spawn and utility palettes fail them', () => {
  // If the two assertions above could pass with the PREVIOUS palettes still in place, they are
  // decoration. Both old sets are run through the same function and must throw.
  assert.throws(
    () => assertFamilyFloors('OLD spawns', SPAWN_KINDS, (k) => OLD_SPAWN_COLORS[k]),
    /closest (badge|dot) pair/,
    'the old spawn palette passed the floors — they are too low to mean anything',
  );
  assert.throws(
    () => assertFamilyFloors('OLD utilities', UTILITY_KINDS, (k) => OLD_UTILITY_COLORS[k]),
    /closest (badge|dot) pair/,
    'the old utility palette passed the floors — they are too low to mean anything',
  );
});

/* ------------------------------- 1b-bis. the sq family, measured PAIR by PAIR --- */
/*
 * `sq` was exempted from the floors WHOLESALE on a reason that covers one of its ten pairs:
 * `extract-pmc` and `extract-shared` share one hue on purpose (shared is the single two-colour
 * badge, half PMC green and half scav orange via `color2`), so a pairwise minimum over the family is
 * 0 by design. Skipping the family to dodge that pair also stopped measuring the other nine — a
 * green square extract 41.6 from an olive square stash at 6 px, and 34.8 from a blue transit, are
 * the same defect class this pass fixed elsewhere, and nothing would have caught an extract-hue
 * tweak pushing transit onto stash.
 *
 * So the PAIR is exempted, not the family, and the pairs that sit under the dot floor are recorded
 * with their measured numbers instead of being absent.
 */
const SQ_KINDS = FAMILY_OF('sq');
/** The one pair that is one hue by design. Measuring it would measure the design decision, not a defect. */
const SQ_BY_DESIGN = [['extract-pmc', 'extract-shared']];
/**
 * Accepted, shape-backstopped `sq` pairs that sit under the DOT floor of 45. Recorded as numbers so
 * a palette move that makes any of them worse is visible; all four are square-on-square, so colour
 * really is the only channel and these are the closest thing this vocabulary has to a known debt.
 */
const SQ_SUB_FLOOR_DOT = Object.freeze({
  'extract-pmc|extract-transit': 34.8,
  'extract-shared|extract-transit': 34.8,
  'extract-pmc|stash': 41.6,
  'extract-shared|stash': 41.6,
});
/**
 * ...and at the BADGE tier, one pair sits just under the 90 floor.
 *
 * This is the pair icons.js's floor note names: raising `FLOOR.badgeMin` above 88.6 would correctly
 * fail it. Accepted at 22 px because the two badges differ by a whole glyph (a running figure
 * through a door vs a double-headed arrow between posts) as well as by hue, and because green and
 * blue are far apart in hue even when close in RGB distance. Recorded so the accepted number is
 * visible instead of being hidden behind a family-wide exemption.
 */
const SQ_SUB_FLOOR_BADGE = Object.freeze({
  'extract-pmc|extract-transit': 88.6,
  'extract-shared|extract-transit': 88.6,
});

test('the sq family is measured pair by pair, and only the by-design hue share is exempt', () => {
  assert.deepEqual(SQ_KINDS, ['extract-pmc', 'extract-scav', 'extract-shared', 'extract-transit', 'stash']);
  const under = {};
  const underBadge = {};
  for (let i = 0; i < SQ_KINDS.length; i++) {
    for (let j = i + 1; j < SQ_KINDS.length; j++) {
      const [a, b] = [SQ_KINDS[i], SQ_KINDS[j]];
      if (SQ_BY_DESIGN.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) continue;
      const badge = separation([KINDS[a].color, KINDS[b].color]).min;
      const dot = separation([desaturate(KINDS[a].color), desaturate(KINDS[b].color)]).min;
      console.log(`  sq ${`${a} vs ${b}`.padEnd(38)} badge ${badge.toFixed(1).padStart(6)} · dot ${dot.toFixed(1).padStart(6)}`);
      if (badge < FLOOR.badgeMin) underBadge[`${a}|${b}`] = Number(badge.toFixed(1));
      if (dot < FLOOR.dotMin) under[`${a}|${b}`] = Number(dot.toFixed(1));
    }
  }
  assert.deepEqual(Object.keys(underBadge).sort(), Object.keys(SQ_SUB_FLOOR_BADGE).sort(),
    'the set of sq pairs under the BADGE floor changed');
  for (const [key, was] of Object.entries(SQ_SUB_FLOOR_BADGE)) {
    assert.ok(underBadge[key] >= was - 0.05, `${key} badge narrowed from ${was} to ${underBadge[key]}`);
  }
  // The SET is pinned, not just the count: a new sub-floor pair appearing, or a recorded one
  // silently being removed, both go red. Numbers may improve; they may not get worse.
  assert.deepEqual(Object.keys(under).sort(), Object.keys(SQ_SUB_FLOOR_DOT).sort(),
    'the set of sq pairs under the dot floor changed — accept it here with a number, or fix the hue');
  for (const [key, was] of Object.entries(SQ_SUB_FLOOR_DOT)) {
    assert.ok(under[key] >= was - 0.05, `${key} narrowed from ${was} to ${under[key]}`);
  }
});

/* ------------------------- 1b-ter. the cross-family landscape, no longer invisible --- */
/*
 * The floors were only ever applied WITHIN a shape family, so a pair drawn side by side on the same
 * map but belonging to two families was never measured at all. `loot-valuables` vs `quest-objective`
 * is 8.5 apart in the dot tier — the same order as the old seven greys' worst pair (3.0), the
 * benchmark the whole 7->3 collapse was justified against — and quest objectives are the
 * highest-intent marker on the map.
 *
 * Shape IS a real second channel across families, so a lower bar is legitimate. What is not
 * legitimate is having no bar and no number. This records the landscape: every cross-family pair
 * under the within-family floors is listed with its measurement, the set is pinned, and none may get
 * worse. The founder-approved palette is unchanged by this test — it makes the debt visible, which
 * is what was missing.
 */
const ALL_KINDS = Object.keys(KINDS);
const CROSS_FAMILY_SUB_FLOOR_DOT = Object.freeze({
  'loot-valuables|quest-objective': 8.5,
  'quest-objective|switch': 15.4,
  'loot-valuables|switch': 16.1,
  'loot-valuables|spawn-scav': 19.3,
  'spawn-scav|switch': 19.7,
  'extract-scav|quest-objective': 20.6,
  'extract-scav|loot-valuables': 22.3,
  'quest-objective|spawn-scav': 25.6,
  'loot-gear|spawn-sniper': 27.7,
  'loot-consumables|spawn-pmc': 28.1,
  'loot-consumables|stash': 31.0,
  'extract-pmc|loot-consumables': 31.5,
  'extract-shared|loot-consumables': 31.5,
  'extract-transit|loot-consumables': 31.7,
  'hazard|stash': 34.8,
  'extract-scav|switch': 35.4,
  'extract-scav|spawn-scav': 38.3,
  'hazard|loot-consumables': 38.3,
  'hazard|spawn-boss': 39.1,
  'extract-transit|spawn-pmc': 40.8,
  'spawn-sniper|weapon': 41.0,
  'hazard|spawn-pmc': 41.2,
  'extract-transit|hazard': 43.4,
  'loot-gear|stash': 44.7,
});

test('every CROSS-family pair is measured, and the ones under the floor are named', () => {
  const under = {};
  let worst = { key: null, dot: Infinity };
  for (let i = 0; i < ALL_KINDS.length; i++) {
    for (let j = i + 1; j < ALL_KINDS.length; j++) {
      const [a, b] = [ALL_KINDS[i], ALL_KINDS[j]];
      if (KINDS[a].shape === KINDS[b].shape) continue;   // within-family pairs are floored above
      const dot = separation([desaturate(KINDS[a].color), desaturate(KINDS[b].color)]).min;
      if (dot >= FLOOR.dotMin) continue;
      const key = [a, b].sort().join('|');
      under[key] = Number(dot.toFixed(1));
      if (dot < worst.dot) worst = { key, dot };
    }
  }
  console.log(`  ${Object.keys(under).length} cross-family pairs under the ${FLOOR.dotMin} dot floor`);
  console.log(`  worst: ${worst.key} at ${worst.dot.toFixed(1)} — shape is the only thing telling these apart at 6 px`);
  // Pinned as a SET. A new collision appearing is the regression this test exists to catch; a
  // recorded one disappearing means the palette improved and the row should be deleted on purpose.
  assert.deepEqual(Object.keys(under).sort(), Object.keys(CROSS_FAMILY_SUB_FLOOR_DOT).sort(),
    'the cross-family collision set changed — accept the new pair here with its number, or move the hue');
  for (const [key, was] of Object.entries(CROSS_FAMILY_SUB_FLOOR_DOT)) {
    assert.ok(under[key] >= was - 0.05, `${key} narrowed from ${was} to ${under[key]} — this pair got worse`);
  }
  // The stated backstop, asserted rather than assumed: every accepted collision really is
  // cross-family. The day one of these becomes same-shape, colour is the only channel left and the
  // exception is no longer justified by anything.
  for (const key of Object.keys(CROSS_FAMILY_SUB_FLOOR_DOT)) {
    const [a, b] = key.split('|');
    assert.notEqual(KINDS[a].shape, KINDS[b].shape, `${key} is same-family; shape cannot back it up`);
  }
});

test("the boss magenta's own justification — 70 RGB from the hazard purple — is asserted", () => {
  /*
   * This is the number that decided magenta over violet, i.e. the reason the founder is looking at
   * this colour at all, and nothing defended it: a later tweak to `hazard` #8258A6 would have walked
   * the boss shield back toward the rejected violet with the suite still green.
   */
  const REJECTED_VIOLET = '#8E4FC7';
  const badge = separation([KINDS['spawn-boss'].color, KINDS.hazard.color]).min;
  const dot = separation([desaturate(KINDS['spawn-boss'].color), desaturate(KINDS.hazard.color)]).min;
  const violetBadge = separation([REJECTED_VIOLET, KINDS.hazard.color]).min;
  console.log(`  boss/hazard badge ${badge.toFixed(1)} · dot ${dot.toFixed(1)} (rejected violet would be ${violetBadge.toFixed(1)})`);
  assert.ok(badge >= 70, `boss vs hazard is ${badge.toFixed(1)}, under the 70 the palette note claims`);
  // ...and the assertion is shown to discriminate: the colour that was REJECTED for being too close
  // must fail it, or 70 is a number that would accept anything.
  assert.ok(violetBadge < 70, 'the rejected violet passes the 70 — the claim means nothing');
  // The dot tier goes the OTHER way for this pair, and the palette note said "widens every spawn
  // pair at the dot tier" without saying that is true WITHIN the spawn family only. Stated here as
  // an accepted, shape-backstopped exception rather than left unmeasured.
  assert.ok(dot < FLOOR.dotMin, 'boss/hazard now clears the dot floor — delete this exception');
  assert.equal(Number(dot.toFixed(1)), 39.1);
  assert.notEqual(KINDS['spawn-boss'].shape, KINDS.hazard.shape, 'a shield and a diamond — shape is the backstop');
});

/* ---------------------------------------------- 1c-bis. the ink halo, asserted --- */
test('the ink halo is on the families that carry it, and CAN be shown to be absent', () => {
  /*
   * Half of this session's palette change, and no test anywhere mentioned it. Because the STENCIL
   * layer is emitted identically in both branches, replacing `glyphInk(...)` with a bare
   * `<g fill='${STENCIL}'>` — a plausible cleanup — left all 18 tests green while the four spawn
   * shields collapsed back into the pale blob this pass existed to fix.
   */
  const haloLayer = new RegExp(`stroke-width='${HALO_W}'`);
  for (const [kind, k] of Object.entries(KINDS)) {
    // Letter badges draw a <text>, not a glyph, so only the glyph path is under test here.
    const svg = iconDataUrl(kind, 24, null);
    const decoded = decodeURIComponent(svg.slice(svg.indexOf(',') + 1));
    const haloed = haloLayer.test(decoded);
    assert.equal(haloed, GLYPH_HALO.has(k.shape),
      `${kind} (${k.shape}) ${haloed ? 'has' : 'is missing'} the ink halo; GLYPH_HALO says otherwise`);
    if (haloed) assert.match(decoded, /<g fill='#0E1211' stroke='#0E1211'/, `${kind}'s halo must be drawn in the plate ink`);
  }
  // The mutation proof, in-process: the same function with a shape that is NOT in GLYPH_HALO must
  // emit no ink layer at all. Without this the assertion above could be satisfied by a `glyphInk`
  // that haloed everything.
  assert.doesNotMatch(glyphInk('ci', '<path d="M0 0"/>'), haloLayer);
  assert.match(glyphInk('sh', '<path d="M0 0"/>'), haloLayer);
  assert.deepEqual([...GLYPH_HALO].sort(), ['dia', 'sh']);
});

/**
 * The plate value below which a near-white glyph loses its silhouette and needs the ink keyline.
 *
 * Measured, not chosen freely: every haloed plate that motivated the change sits below it
 * (`lock` 81.9, `spawn-scav` 157.7, `spawn-boss` 176.1, `switch` 189.6) and the palest bare plate
 * sits just above (`loot-valuables` 191.5). The margin is 1.9 units, so this is a TIGHT boundary and
 * that is the point: the next hue tweak that pushes a bare plate lighter goes red here.
 */
const HALO_CONTRAST_THRESHOLD = 190;

test('the halo is keyed on shape, so the VALUE condition it exists for is checked separately', () => {
  /*
   * The defect the halo fixes is a near-white glyph on a LIGHT PLATE — a property of the COLOUR, not
   * of the shape. Keying `GLYPH_HALO` on shape is therefore a decision, not a derivation, and it is
   * only safe while no un-haloed plate is light enough to need one. Nothing checked that; the
   * exclusion was stated as a design decision when it was really an untested assumption about a
   * palette that has since moved twice.
   *
   * This does not re-key the halo — that would move pixels the founder approved. It asserts the
   * property the shape-keying is standing in for, so the assumption cannot go stale silently.
   */
  const contrast = (hex) => dist(rgb(hex), rgb(BADGE_TONES.stencil));
  const bare = [];
  const haloed = [];
  for (const [kind, k] of Object.entries(KINDS)) {
    const c = Number(contrast(k.color).toFixed(1));
    (GLYPH_HALO.has(k.shape) ? haloed : bare).push([kind, c]);
  }
  bare.sort((a, b) => a[1] - b[1]);
  haloed.sort((a, b) => a[1] - b[1]);
  console.log(`  palest BARE plate:   ${bare[0][0]} at ${bare[0][1]} (threshold ${HALO_CONTRAST_THRESHOLD})`);
  console.log(`  palest HALOED plate: ${haloed[0][0]} at ${haloed[0][1]}`);

  // THE PROPERTY: nothing below the threshold is left bare. This is what the halo is for.
  for (const [kind, c] of bare) {
    assert.ok(c >= HALO_CONTRAST_THRESHOLD,
      `${kind}'s plate is ${c} from STENCIL — a near-white glyph on it has no silhouette, and its`
      + ` shape (${KINDS[kind].shape}) is not in GLYPH_HALO. Halo it, re-hue it, or lower the threshold on purpose.`);
  }
  // ...and the threshold discriminates: it must be above the plates that actually motivated the
  // halo, or it would accept the pale scav shield this pass was written to fix.
  assert.ok(contrast(KINDS['spawn-scav'].color) < HALO_CONTRAST_THRESHOLD,
    'the scav shield — the plate the halo was written for — passes the threshold, so it means nothing');
  assert.ok(contrast(KINDS.lock.color) < HALO_CONTRAST_THRESHOLD);

  // The boundary is TIGHT (1.9 units), which is worth knowing before the next palette move: it is
  // one small hue tweak from being a real decision rather than a formality.
  assert.ok(bare[0][1] - HALO_CONTRAST_THRESHOLD < 5,
    'the margin has widened; re-derive the threshold rather than leaving a stale number');
});

test('an unknown kind is refused at BOTH tiers, not drawn as a plausible grey dot', () => {
  // `dotColor` used to fall back to the retired `lock` grey while `iconHtml` threw on the same
  // input, so a kind that went missing from KINDS vanished into legitimate-looking dots at the
  // zoomed-out tier and only surfaced on zooming in. The repo's own rule: fail where the bad value
  // is, rather than quietly inheriting one and being believed.
  for (const bad of ['loot-cash', 'not-a-kind', undefined]) {
    assert.throws(() => iconHtml(bad), `iconHtml must refuse ${String(bad)}`);
    assert.throws(() => dotColor(bad), /unknown marker kind/, `dotColor must refuse ${String(bad)}`);
    assert.throws(() => dotHtml(bad), /unknown marker kind/, `dotHtml must refuse ${String(bad)}`);
  }
  // ...and a real kind still works, so the guard is not just a blanket throw.
  assert.match(dotColor('stash'), /^#[0-9a-f]{6}$/i);
});

/* ------------------------------------------- 1c. shape survives the dot tier --- */
test('the DOT tier keeps the family shape — colour is no longer the only channel', () => {
  // The defect: at 6 px every kind drew the same CSS box, so family disambiguation collapsed onto
  // colour at exactly the zoom where colour is least reliable (55% desaturated, over terrain).
  const marks = new Map();
  for (const kind of Object.keys(KINDS)) {
    const html = dotHtml(kind, 6);
    const shape = KINDS[kind].shape;
    assert.match(html, new RegExp(`class="mk-dot mk-dot-${shape}"`), `${kind}'s dot must name its family`);
    assert.match(html, /<svg viewBox="0 0 12 12" width="6" height="6">/, `${kind}'s dot must be drawn, not a CSS box`);
    assert.match(html, new RegExp(`fill="${dotColor(kind)}"`), `${kind}'s dot lost its category colour`);
    // The geometry itself, not just the class name: strip the colour and keep the path.
    const geometry = html.replace(/fill="#[0-9a-f]{6}"/i, '');
    marks.set(shape, (marks.get(shape) ?? new Set()).add(geometry.replace(/mk-dot-\w+/, '')));
  }
  // Five families, five DISTINCT silhouettes. A regression that re-flattens them to one box makes
  // this set collapse to a single member.
  const silhouettes = new Set();
  for (const kind of Object.keys(KINDS)) {
    const html = dotHtml(kind, 6).replace(/fill="#[0-9a-f]{6}"/i, '').replace(/mk-dot-\w+/, '');
    silhouettes.add(html);
  }
  assert.equal(silhouettes.size, 5, `expected one silhouette per family, got ${silhouettes.size}`);
  assert.deepEqual([...new Set(Object.values(KINDS).map((k) => k.shape))].sort(), ['ci', 'dia', 'hex', 'sh', 'sq']);
  // …and no `background:` inline style, which is what the old one-box dot was.
  assert.doesNotMatch(dotHtml('lock', 6), /background:/);
});

test('each loot family carries omnibox search terms for the vocabulary the map face gave up', () => {
  // The collapse removed the "Safes & cash" / "Key spawns" / "Dead bodies" rows. `terms` is what
  // keeps `> show safes` working, so it is part of the contract, not decoration.
  for (const k of LOOT_KINDS) {
    assert.ok(Array.isArray(KINDS[k].terms) && KINDS[k].terms.length >= 5, `${k} needs search terms`);
  }
  const find = (q) => LOOT_KINDS.filter((k) => KINDS[k].terms.some((t) => t.includes(q)) || KINDS[k].label.toLowerCase().includes(q));
  assert.deepEqual(find('safe'), ['loot-valuables']);
  assert.deepEqual(find('key'), ['loot-valuables']);
  assert.deepEqual(find('bodies'), ['loot-gear']);
  assert.deepEqual(find('med'), ['loot-consumables']);
});

/* ------------------------------------------------- 2. no orphaned kind strings --- */
async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (['.js', '.mjs', '.cjs', '.html', '.css', '.json'].includes(extname(e.name))) yield p;
  }
}

test('no pre-collapse loot kind string survives in src/ or scripts/', async () => {
  const self = fileURLToPath(import.meta.url);
  const re = new RegExp(OLD_LOOT_KINDS.join('|'), 'g');
  const hits = [];
  for (const dir of ['src', 'scripts']) {
    for await (const file of walk(join(ROOT, dir))) {
      if (file === self) continue;   // this suite names them on purpose, above
      const text = await readFile(file, 'utf8');
      // icons.js's LEGACY_KIND migration is the one legal mention: it maps the dead strings onto
      // their family so a returning visitor's saved layer set survives. Anything else is an orphan.
      const body = text.replace(/export const LEGACY_KIND = \{[\s\S]*?\n\};/, '');
      for (const m of body.matchAll(re)) hits.push(`${file.slice(ROOT.length + 1)}: ${m[0]}`);
    }
  }
  assert.deepEqual(hits, [], `orphaned kind strings:\n  ${hits.join('\n  ')}`);
});

/* ------------------------------------------- 3. the container pipeline covers the data --- */
test('every container type in the shipped map data resolves to a marker kind', async () => {
  const missing = new Map(), total = new Map();
  let n = 0;
  for (const key of ['customs', 'reserve', 'woods']) {
    const data = JSON.parse(await readFile(join(ROOT, 'public/data', `${key}.json`), 'utf8'));
    for (const c of data.containers ?? []) {
      n++;
      total.set(c.type, (total.get(c.type) ?? 0) + 1);
      if (!CONTAINER_KIND[c.type]) missing.set(c.type, (missing.get(c.type) ?? 0) + 1);
    }
  }
  const dropped = [...missing.values()].reduce((a, b) => a + b, 0);
  console.log(`  ${n} containers across 3 maps · ${total.size} distinct types · ${dropped} unmapped`);
  assert.deepEqual([...missing.entries()], [], 'container types with no marker kind (these are dropped silently by classify())');
  // Every kind the table names must be real, and every type must have a per-item label to show on
  // hover — that label IS the distinction the 12 px badge gave up.
  for (const [type, kind] of Object.entries(CONTAINER_KIND)) {
    assert.ok(KINDS[kind], `${type} -> ${kind}, which is not a KIND`);
    assert.ok(CONTAINER_TYPE[type], `${type} has no per-item label in CONTAINER_TYPE`);
  }
});

test('the coverage assertion DISCRIMINATES — the pre-collapse table drops 41% of the data', async () => {
  // Verbatim copy of the table as it stood before this change. If the assertion above could not
  // fail, this would pass with `dropped === 0`.
  const OLD_TABLE = {
    container_stash: 'stash', container_weapon: 'x', container_crate: 'x', container_greencrate: 'x',
    container_duffle: 'x', container_jacket: 'x', container_supply: 'x', container_safe: 'x',
    container_cash: 'x', container_pc: 'x', container_drawer: 'x', container_medcase: 'x',
    container_medical: 'x', container_ammo: 'x', container_grenade: 'x', container_tool: 'x',
    loot_key: 'x', container_dead: 'x', loot_loose: 'x', loot_spt: 'x',
  };
  let n = 0, dropped = 0;
  for (const key of ['customs', 'reserve', 'woods']) {
    const data = JSON.parse(await readFile(join(ROOT, 'public/data', `${key}.json`), 'utf8'));
    for (const c of data.containers ?? []) { n++; if (!OLD_TABLE[c.type]) dropped++; }
  }
  console.log(`  OLD table: ${dropped}/${n} containers (${((dropped / n) * 100).toFixed(1)}%) would be dropped`);
  assert.ok(dropped / n > 0.3, 'the old table did not drop enough for this to be a real regression guard');
});

test('a saved layer set from before the collapse migrates onto a live kind', () => {
  assert.deepEqual(Object.keys(LEGACY_KIND).sort(), [...OLD_LOOT_KINDS].sort());
  for (const [old, now] of Object.entries(LEGACY_KIND)) assert.ok(KINDS[now], `${old} -> ${now} is not a KIND`);
  // The exact thing this protects: "I had safes and dead bodies on" survives the update.
  const saved = ['extract-pmc', 'loot-cash', 'loot-dead', 'a-kind-that-never-existed'];
  const migrated = saved.map((k) => LEGACY_KIND[k] ?? k).filter((k) => KINDS[k]);
  assert.deepEqual(migrated, ['extract-pmc', 'loot-valuables', 'loot-gear']);
});

/* --------------------------------------------------- 4. the extract badge letter --- */
const badgeOf = (kind, letter, level = 'surface', req = null) =>
  decodeURIComponent(iconDataUrl(kind, 48, letter, level, null, req).replace('data:image/svg+xml;charset=utf-8,', ''));

test('the extract badge sets IBM Plex Sans Condensed and no longer names Barlow', () => {
  const svg = badgeOf('extract-pmc', 'OG');
  assert.match(svg, /font-family='IBM Plex Sans Condensed, Arial Narrow, sans-serif'/);
  assert.doesNotMatch(svg, /Barlow/);
});

test('textLength still PINS the letter ink — this is what buys 2D/3D parity, not the font name', () => {
  // An SVG loaded as an <img> (the 3D atlas path) cannot see the page's webfonts and falls back to
  // a wider face. `textLength` + lengthAdjust='spacingAndGlyphs' forces both paths to the same ink
  // width, so a change to the font NAME cannot move the letter. Two- and three-character letters
  // are the ones that overran the plate; one character is deliberately left at its natural width.
  const two = badgeOf('extract-pmc', 'OG');
  assert.match(two, /textLength='12\.6' lengthAdjust='spacingAndGlyphs'/);
  const three = badgeOf('extract-transit', '17x');
  assert.match(three, /textLength='15\.6' lengthAdjust='spacingAndGlyphs'/);
  const one = badgeOf('extract-pmc', 'D');
  assert.doesNotMatch(one, /textLength/);
  assert.match(one, /font-size='13'/);
  // The pinned ink must fit inside the plate's keyline (1.8..22.2 with a 1.5 stroke -> 2.55..21.45,
  // i.e. 18.9 units usable). 15.6 was chosen against that number; assert it rather than trust it.
  for (const len of [12.6, 15.6]) assert.ok(len <= 18.9, `${len} overruns the plate's 18.9 usable units`);
});

test('the letter still renders, with its chips and dashed outline, at every level it has', () => {
  const plain = badgeOf('extract-pmc', 'SB');
  assert.match(plain, />SB<\/text>/);
  const under = badgeOf('extract-pmc', 'SB', 'underground', 'key');
  assert.match(under, />SB<\/text>/);
  assert.match(under, /stroke-dasharray='2\.3 1\.7'/);           // the underground outline
  assert.ok(under.includes("y='13.2'"), 'the baseline must lift when the badge carries a chip');
  assert.ok(plain.includes("y='16.6'"), 'a chip-less badge keeps the low baseline');
  // A loot circle never takes a letter, and its glyph must still be the near-white stencil.
  const loot = badgeOf('loot-valuables', null);
  assert.doesNotMatch(loot, /<text/);
  assert.match(loot, /fill='#F2F0E7'/);
});

test('every kind still renders as both HTML and a data URL', () => {
  for (const kind of Object.keys(KINDS)) {
    const html = iconHtml(kind, 22);
    assert.match(html, new RegExp(`class="mk ${KINDS[kind].shape} level-surface"`));
    assert.ok(badgeOf(kind, null).startsWith('<svg'), `${kind} produced no svg`);
  }
});
