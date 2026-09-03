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
  iconDataUrl, iconHtml, dotColor, desaturate,
} from '../src/icons.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/* ------------------------------------------------------------ colour maths --- */
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
/** Rec.709 relative luma — the yardstick the 5.5 / 14.1 measurement of the old seven was taken with. */
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** Closest pair, and the spread, over a set of hex colours. */
function separation(hexes) {
  const cols = hexes.map(rgb);
  let min = Infinity, pair = null;
  for (let i = 0; i < cols.length; i++) {
    for (let j = i + 1; j < cols.length; j++) {
      const d = dist(cols[i], cols[j]);
      if (d < min) { min = d; pair = [hexes[i], hexes[j]]; }
    }
  }
  const ls = cols.map(luma);
  return { min, pair, spread: Math.max(...ls) - Math.min(...ls) };
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
