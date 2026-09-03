/**
 * The label TIER contract, and the derivation behind every shipped tier.
 *
 * Handoff §6: "a metric that cannot fail is worse than no metric." So every assertion here is
 * built to go red on a real mutation, and the discrimination proof for each one is recorded in
 * the report that shipped with this file. In particular:
 *
 *   - the totality check reads STYLE_KEYS and asserts each key is PRESENT AND WELL-TYPED, so
 *     deleting a property or setting it to undefined fails (a `key in obj` check would not);
 *   - the derivation check re-runs the scoring rule from public data and compares it row by row,
 *     so a hand-edited tier fails rather than drifting;
 *   - the extract-ownership check reads the same public data `main.js#classify` turns into
 *     extract markers, and asserts the names still collide, i.e. that tiering did not rename or
 *     resurrect a label an extract badge already draws.
 *
 * PUBLIC DATA ONLY: public/data/<map>{,-3d}.json, public/data/quests.json, and the PLACE_COLORS
 * tables in scripts/build-3d.mjs. Nothing under .local-game-derived/ or .local-candidates/.
 *
 * No deck.gl / three import anywhere in this file's graph — on /mnt/c a deck import alone costs
 * ~197 s (handoff §7). src/labels.js and src/label-tier.js are both dependency-free.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LABELS, CUSTOMS_LABELS, RESERVE_LABELS, WOODS_LABELS } from '../src/labels.js';
import {
  TIERS, TIER_RANK, TIER_STYLE, STYLE_KEYS, COLOR_KEYS, REFERENCE_MPP,
  isTier, styleFor, tierOf, visibleAtMpp, tiersAtMpp,
  metresPerPixel2d, metresPerPixel3d, minZoom2dFor, minZoom3dFor,
} from '../src/label-tier.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const MAPS = ['customs', 'reserve', 'woods'];
const labelKey = (t) => String(t ?? '').trim().toLowerCase(); // main.js#labelKey, verbatim

/* ============================================================== the vocabulary === */

test('the tier vocabulary is exactly the four founder-approved tiers, in importance order', () => {
  assert.deepEqual(TIERS, ['landmark', 'building', 'minor', 'zone']);
  assert.equal(Object.isFrozen(TIERS), true);
  assert.deepEqual(TIER_RANK, { landmark: 0, building: 1, minor: 2, zone: 3 });
  assert.deepEqual(Object.keys(TIER_STYLE).sort(), [...TIERS].sort());
});

/* ================================================== the contract is TOTAL ======== */

test('every tier resolves every style property, well-typed', () => {
  for (const tier of TIERS) {
    const s = styleFor(tier);
    assert.deepEqual(Object.keys(s).sort(), [...STYLE_KEYS].sort(), `${tier}: property set`);

    assert.equal(typeof s.fontSizePx, 'number', `${tier}.fontSizePx type`);
    assert.ok(Number.isFinite(s.fontSizePx) && s.fontSizePx >= 9 && s.fontSizePx <= 40, `${tier}.fontSizePx range (got ${s.fontSizePx})`);

    assert.equal(typeof s.fontWeight, 'number', `${tier}.fontWeight type`);
    assert.ok(Number.isInteger(s.fontWeight) && s.fontWeight >= 100 && s.fontWeight <= 900 && s.fontWeight % 100 === 0, `${tier}.fontWeight (got ${s.fontWeight})`);

    assert.equal(typeof s.letterSpacingEm, 'number', `${tier}.letterSpacingEm type`);
    assert.ok(Number.isFinite(s.letterSpacingEm) && s.letterSpacingEm >= 0 && s.letterSpacingEm <= 0.5, `${tier}.letterSpacingEm range`);

    assert.ok(['uppercase', 'none'].includes(s.textTransform), `${tier}.textTransform (got ${s.textTransform})`);

    assert.equal(typeof s.stemPx, 'number', `${tier}.stemPx type`);
    assert.ok(Number.isFinite(s.stemPx) && s.stemPx >= 0 && s.stemPx <= 80, `${tier}.stemPx range`);

    assert.equal(typeof s.showAtOrBelowMetresPerPixel, 'number', `${tier}.showAtOrBelowMetresPerPixel type`);
    assert.ok(Number.isFinite(s.showAtOrBelowMetresPerPixel) && s.showAtOrBelowMetresPerPixel > 0, `${tier}.showAtOrBelowMetresPerPixel positive`);

    assert.equal(typeof s.color, 'object', `${tier}.color type`);
    assert.deepEqual(Object.keys(s.color).sort(), [...COLOR_KEYS].sort(), `${tier}.color property set`);
    for (const k of ['ink', 'halo', 'inkOnLight', 'haloOnLight']) {
      assert.match(s.color[k], /^#[0-9A-Fa-f]{6}$/, `${tier}.color.${k} must be a 6-digit hex (got ${s.color[k]})`);
    }
    assert.ok(Number.isFinite(s.color.haloPx) && s.color.haloPx > 0, `${tier}.color.haloPx positive`);

    assert.equal(Object.isFrozen(s), true, `${tier} style must be frozen`);
    assert.equal(Object.isFrozen(s.color), true, `${tier} color must be frozen`);
  }
  assert.equal(REFERENCE_MPP, 1.0);
});

test('styleFor and tierOf fail loudly instead of falling back to a default (handoff §6)', () => {
  for (const bad of [undefined, null, '', 'Landmark', 'LANDMARK', 'major', 'minor ', 0, {}]) {
    assert.throws(() => styleFor(bad), TypeError, `styleFor(${JSON.stringify(bad)}) must throw`);
    assert.equal(isTier(bad), false, `isTier(${JSON.stringify(bad)})`);
  }
  assert.throws(() => tierOf({ text: 'Fortress' }), TypeError);
  assert.throws(() => tierOf({ text: 'Fortress', tier: 'major' }), TypeError);
  assert.equal(tierOf({ text: 'Fortress', tier: 'landmark' }), 'landmark');
  // the prototype chain must not be mistaken for a tier
  assert.equal(isTier('toString'), false);
  assert.equal(isTier('constructor'), false);
});

/* ==================================== thinning: four strictly ordered thresholds === */

test('the four zoom thresholds are strictly ordered — landmark survives furthest out, zone last', () => {
  const mpp = TIERS.map((t) => styleFor(t).showAtOrBelowMetresPerPixel);
  for (let i = 1; i < mpp.length; i++) {
    assert.ok(mpp[i] < mpp[i - 1],
      `threshold must strictly decrease across TIERS: ${TIERS[i - 1]}=${mpp[i - 1]} then ${TIERS[i]}=${mpp[i]}`);
  }
  // stated as zoom, both views: a later tier needs a strictly HIGHER zoom before it draws
  const z3 = TIERS.map((t) => minZoom3dFor(t));
  for (let i = 1; i < z3.length; i++) assert.ok(z3[i] > z3[i - 1], `3D minZoom must strictly increase: ${TIERS[i - 1]}=${z3[i - 1]} then ${TIERS[i]}=${z3[i]}`);
  for (const crsScale of [0.239, 0.395, 0.185]) {
    const z2 = TIERS.map((t) => minZoom2dFor(t, crsScale));
    for (let i = 1; i < z2.length; i++) assert.ok(z2[i] > z2[i - 1], `2D minZoom must strictly increase at crsScale ${crsScale}`);
  }
});

test('thinning actually thins: each scale step adds exactly one tier, never removes one', () => {
  const th = TIERS.map((t) => styleFor(t).showAtOrBelowMetresPerPixel);
  // just outside the widest threshold: nothing draws
  assert.deepEqual(tiersAtMpp(th[0] * 1.5), []);
  for (let i = 0; i < TIERS.length; i++) {
    const at = tiersAtMpp(th[i]);                 // exactly at the threshold: inclusive
    assert.deepEqual(at, TIERS.slice(0, i + 1), `at ${th[i]} m/px`);
    const justAbove = tiersAtMpp(th[i] * 1.0001); // a hair zoomed out: this tier is gone
    assert.deepEqual(justAbove, TIERS.slice(0, i), `just above ${th[i]} m/px`);
  }
  assert.equal(visibleAtMpp('landmark', th[3]), true, 'a landmark still draws where a zone does');
  assert.equal(visibleAtMpp('zone', th[0]), false, 'a zone must not draw at landmark scale');
});

test('style separates the tiers — a landmark cannot read like a shed', () => {
  // size is non-increasing down the ladder, and the ends are genuinely apart
  for (let i = 1; i < TIERS.length; i++) {
    assert.ok(styleFor(TIERS[i]).fontSizePx <= styleFor(TIERS[i - 1]).fontSizePx, `${TIERS[i]} must not be larger than ${TIERS[i - 1]}`);
  }
  assert.ok(styleFor('landmark').fontSizePx >= styleFor('minor').fontSizePx * 1.25,
    'landmark must be at least 25% larger than minor — the old `size` field spanned only 20% end to end, which is the defect this replaces');
  assert.ok(styleFor('landmark').fontWeight > styleFor('zone').fontWeight);
  // stems: shorter down the structure ladder, and an area has none by definition
  assert.ok(styleFor('landmark').stemPx > styleFor('building').stemPx);
  assert.ok(styleFor('building').stemPx > styleFor('minor').stemPx);
  assert.equal(styleFor('zone').stemPx, 0, 'a zone names ground, not a point — it gets no stem');
  // register: structures are caps except the deliberately quiet `minor`; zone is wide-tracked caps
  assert.equal(styleFor('minor').textTransform, 'none');
  assert.ok(styleFor('zone').letterSpacingEm > styleFor('landmark').letterSpacingEm, 'zones are tracked wider than landmarks (cartographic convention for a region)');
});

test('the two scale conversions agree with src/camera.js', () => {
  // 3D: m/px = 1 / 2^zoom
  assert.equal(metresPerPixel3d(0), 1);
  assert.ok(Math.abs(metresPerPixel3d(1) - 0.5) < 1e-12);
  // 2D: m/px = 1 / (crsScale * 2^zoom); Customs' crsScale is 2^-2.065
  const customs = 2 ** -2.065;
  assert.ok(Math.abs(metresPerPixel2d(2, customs) - 1 / (customs * 4)) < 1e-12);
  // a tier's minZoom is the zoom whose m/px IS its threshold, in both views
  for (const tier of TIERS) {
    const th = styleFor(tier).showAtOrBelowMetresPerPixel;
    assert.ok(Math.abs(metresPerPixel3d(minZoom3dFor(tier)) - th) < 1e-9, `${tier} 3D minZoom round-trip`);
    assert.ok(Math.abs(metresPerPixel2d(minZoom2dFor(tier, customs), customs) - th) < 1e-9, `${tier} 2D minZoom round-trip`);
  }
});

/* ============================================ every label, exactly one valid tier === */

test('every label in all three maps has exactly one valid tier', () => {
  assert.deepEqual(Object.keys(LABELS).sort(), [...MAPS].sort());
  assert.equal(LABELS.customs, CUSTOMS_LABELS);
  assert.equal(LABELS.reserve, RESERVE_LABELS);
  assert.equal(LABELS.woods, WOODS_LABELS);
  assert.equal(CUSTOMS_LABELS.length, 32, 'Customs still ships 32 place labels');
  let n = 0;
  for (const map of MAPS) {
    assert.ok(LABELS[map].length > 0, `${map} has labels`);
    for (const l of LABELS[map]) {
      n++;
      assert.equal(typeof l.tier, 'string', `${map}/${l.text}: tier must be a string`);
      assert.ok(isTier(l.tier), `${map}/${l.text}: invalid tier ${JSON.stringify(l.tier)}`);
      assert.equal(tierOf(l), l.tier);
      assert.doesNotThrow(() => styleFor(l.tier));
      assert.ok(Array.isArray(l.position) && l.position.length === 2 && l.position.every(Number.isFinite), `${map}/${l.text}: position`);
      assert.ok(typeof l.text === 'string' && l.text.trim().length > 0, `${map}: every label needs text`);
    }
  }
  assert.equal(n, 76, 'the three shipped maps carry 76 place labels in total');
});

test('no `size` field survives anywhere — the tier replaced it, it did not join it', () => {
  for (const map of MAPS) {
    for (const l of LABELS[map]) {
      assert.equal('size' in l, false, `${map}/${l.text} still carries size=${l.size}`);
      assert.equal(l.size, undefined, `${map}/${l.text} still carries size=${l.size}`);
    }
  }
  // and not in the source text either: a `size:` on a label row would be dead data a renderer
  // could still read (main.js/map3d.js/placeLabels.js all used `(l.size ?? 100) >= 100`).
  const src = fs.readFileSync(path.join(ROOT, 'src/labels.js'), 'utf8');
  assert.equal(/(^|[\s{,])["']?size["']?\s*:/.test(src), false, 'src/labels.js source still mentions a `size:` key');
});

test('the floor-gated rows stayed removed (2026-09-02 decision)', () => {
  for (const map of MAPS) for (const l of LABELS[map]) {
    assert.equal('floor' in l, false, `${map}/${l.text} reinstated a floor field`);
  }
  const reserveNames = new Set(RESERVE_LABELS.map((l) => l.text));
  assert.equal(reserveNames.has('D-2'), false, 'D-2 went out with the floor selector; do not reinstate');
});

/* ================================== an extract still owns its name (QA M1/M3) ===== */

/** The name set main.js#renderMarkers builds: every `extracts[].name` becomes an `extract-*`
 *  marker (see main.js#classify), and `ownedByExtract` keys on trim+lowercase of the text. */
function extractNameKeys(map) {
  return new Set((readJson(`public/data/${map}.json`).extracts || []).map((e) => labelKey(e.name)));
}
const ownedByExtract = (l, names) => names.has(labelKey(l?.text));

test('tiering did not resurrect a single extract-owned place name', () => {
  // These are the collisions in the CURRENTLY SHIPPED data. main.js's comment says eleven rows
  // across the three maps; the eleventh was Reserve's D-2, deleted with the floor selector on
  // 2026-09-02, so ten remain. Recorded here so the drift is visible rather than folklore.
  const expected = {
    customs: ['Trailer Park', 'Warehouse 4', 'Warehouse 17', 'ZB-1011', 'ZB-013'],
    reserve: ['Bunker Hermetic Door', 'Depot Hermetic Door'],
    woods: ['Scav House', 'Bridge V-Ex', 'Railway Bridge to Tarkov'],
  };
  let total = 0;
  for (const map of MAPS) {
    const names = extractNameKeys(map);
    assert.ok(names.size > 0, `${map}: extract list must be non-empty for this test to mean anything`);
    const owned = LABELS[map].filter((l) => ownedByExtract(l, names)).map((l) => l.text);
    assert.deepEqual(owned.sort(), [...expected[map]].sort(), `${map}: the owned set changed`);
    total += owned.length;
    // every owned row still carries a valid tier — the hide rule and the tier are independent,
    // and a hidden label must never become the reason a tier is missing
    for (const t of expected[map]) {
      const row = LABELS[map].find((l) => l.text === t);
      assert.ok(row, `${map}: ${t} vanished from the label set`);
      assert.ok(isTier(row.tier), `${map}/${t}: owned rows still need a tier`);
    }
  }
  assert.equal(total, 10, 'ten place names collide with extract marker names across the three maps');
});

test('the ownership rule reads `text` only — no tier value can un-hide a row', () => {
  const names = extractNameKeys('customs');
  const row = CUSTOMS_LABELS.find((l) => l.text === 'ZB-013');
  for (const tier of TIERS) {
    assert.equal(ownedByExtract({ ...row, tier }, names), true, `ZB-013 must stay owned at tier=${tier}`);
  }
  assert.equal(ownedByExtract({ text: '  zb-013  ' }, names), true, 'trim+lowercase keying preserved');
  assert.equal(ownedByExtract({ text: 'ZB-1012' }, names), false, 'the extract is "Smugglers\' Bunker (ZB-1012)" — that label is NOT owned');
});

/* =========================== the derivation: every tier traces back to evidence ==== */

// PLACE_COLORS from scripts/build-3d.mjs — a place with its own colour is one a human already
// judged visually distinct from the generic building palette. Parsed from the build script rather
// than copied, so the two cannot drift apart silently.
function identityPlaces(map) {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/build-3d.mjs'), 'utf8');
  const table = map === 'customs'
    ? src.match(/const CUSTOMS_COLORS = \{([^}]*)\}/)?.[1]
    : src.match(new RegExp(`${map}:\\s*\\{[\\s\\S]*?\\n\\s*colors:\\s*\\{([^}]*)\\}`))?.[1];
  assert.ok(table, `could not read the PLACE_COLORS table for ${map} out of scripts/build-3d.mjs`);
  const out = new Set();
  for (const m of table.matchAll(/(?:'([^']+)'|"([^"]+)"|([A-Za-z][\w]*))\s*:\s*\[/g)) out.add(m[1] ?? m[2] ?? m[3]);
  assert.ok(out.size >= 7, `${map}: PLACE_COLORS parse found only ${out.size} entries`);
  return out;
}

const polyArea = (p) => { let a = 0; for (let i = 0, n = p.length; i < n; i++) { const [x1, z1] = p[i], [x2, z2] = p[(i + 1) % n]; a += x1 * z2 - x2 * z1; } return Math.abs(a) / 2; };
const polyCentroid = (p) => { let x = 0, z = 0; for (const [a, b] of p) { x += a; z += b; } return [x / p.length, z / p.length]; };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Metres within which a quest zone is considered to belong to its nearest label. */
const QUEST_MAX_M = { customs: 70, reserve: 60, woods: 110 };
/** Below this footprint, on the LARGEST SINGLE element sharing a `place`, it is not a structure
 *  the reader navigates by — see the CLASS rule at the top of src/labels.js (2026-09-02: this used
 *  to be evaluated on the COMBINED footprint, which a cluster of hut-scale elements could clear by
 *  summing; POWERLINE TOWER (17+49 m²) and TRAILER PARK (53+18+18+48 m²) both did). */
const MIN_STRUCTURE_M2 = 60;
const LANDMARK_AT = 5;
const BUILDING_AT = 3;

function deriveEvidence(map) {
  const three = readJson(`public/data/${map}-3d.json`);
  const extracts = readJson(`public/data/${map}.json`).extracts || [];
  const quests = readJson('public/data/quests.json');
  const exNames = new Set(extracts.map((e) => labelKey(e.name)));
  const identity = identityPlaces(map);

  const byPlace = {};
  for (const b of three.buildings || []) {
    if (!b.place) continue;
    const a = (byPlace[b.place] ||= { n: 0, area: 0, maxArea: 0, h: 0, floors: 0, cents: [] });
    const ar = polyArea(b.poly);
    a.n += 1; a.area += ar; a.maxArea = Math.max(a.maxArea, ar);
    a.h = Math.max(a.h, b.height || 0); a.floors = Math.max(a.floors, b.floors || 0);
    a.cents.push(polyCentroid(b.poly));
  }
  for (const a of Object.values(byPlace)) {
    let s = 0; for (const p of a.cents) for (const q of a.cents) s = Math.max(s, dist(p, q));
    a.spread = s;
  }

  const labels = LABELS[map];
  const qsets = labels.map(() => new Set());
  for (const t of quests) for (const o of t.objectives || []) for (const z of o.zones || []) {
    if (z.map !== map) continue;
    let best = -1, bd = QUEST_MAX_M[map];
    labels.forEach((l, i) => { const d = dist(l.position, [z.position.x, z.position.z]); if (d <= bd) { bd = d; best = i; } });
    if (best >= 0) qsets[best].add(t.slug ?? t.id);
  }

  return labels.map((l, i) => {
    const pl = byPlace[l.text] || null;
    let nearest = Infinity;
    for (const e of extracts) nearest = Math.min(nearest, dist(l.position, [e.position.x, e.position.z]));
    return {
      text: l.text, tier: l.tier,
      n: pl?.n ?? 0, area: pl?.area ?? 0, maxArea: pl?.maxArea ?? 0, height: pl?.h ?? 0, floors: pl?.floors ?? 0, spread: pl?.spread ?? 0,
      isExtract: exNames.has(labelKey(l.text)), nearExtractM: nearest,
      quests: qsets[i].size, identity: identity.has(l.text),
    };
  });
}

/** The rule stated at the top of src/labels.js, executable. */
function deriveScore(r) {
  let s = 0;
  s += r.area >= 1500 ? 3 : r.area >= 700 ? 2 : r.area >= 200 ? 1 : 0;
  if (r.height >= 15 || r.floors >= 3) s += 1;
  if (r.isExtract || r.nearExtractM <= 50) s += 1;
  s += r.quests >= 8 ? 2 : r.quests >= 4 ? 1 : 0;
  s += r.spread >= 100 ? 2 : r.spread >= 60 ? 1 : 0;
  if (r.identity) s += 1;
  return s;
}
/** The CLASS test: a `place` is a structure only if its LARGEST SINGLE element clears the floor —
 *  never by summing several smaller ones. Exported in spirit (not literally) to the discrimination
 *  test below, which restores the old combined-footprint form to prove this line is load-bearing. */
function isStructure(r) {
  return r.n > 0 && r.maxArea >= MIN_STRUCTURE_M2;
}
function deriveTier(r) {
  const s = deriveScore(r);
  if (isStructure(r)) return s >= LANDMARK_AT ? 'landmark' : s >= BUILDING_AT ? 'building' : 'minor';
  return s >= LANDMARK_AT ? 'landmark' : 'zone';
}

test('every shipped tier is reproduced by the stated rule, from public data', () => {
  const wrong = [];
  for (const map of MAPS) {
    for (const r of deriveEvidence(map)) {
      const want = deriveTier(r);
      if (want !== r.tier) wrong.push(`${map}/${r.text}: shipped ${r.tier}, rule says ${want} (score ${deriveScore(r)}, ${r.n} bldg, ${Math.round(r.area)} m², ${r.quests} quests)`);
    }
  }
  assert.deepEqual(wrong, [], `tiers disagree with the rule in src/labels.js:\n  ${wrong.join('\n  ')}`);
});

/* ================================ hut clusters cannot sum into a structure ========= */

// The defect this rule replaced (2026-09-02): a COMBINED floor is clearable by several hut-scale
// elements even though none of them, alone, is building-scale. Both real Customs rows below prove
// it on live data — sumArea clears the old 60 m² floor, maxArea does not — and both must land on
// `zone`, never `structure`. Discrimination proof (recorded verbatim in the report that shipped
// with this change): swapping `isStructure()` back to `r.n > 0 && r.area >= MIN_STRUCTURE_M2` (the
// combined form) and re-running `npm run test:label-tier` turns this test, and "every shipped tier
// is reproduced by the stated rule", red.
test('a hut cluster cannot clear the structure floor by summing several small elements', () => {
  const customs = deriveEvidence('customs');
  const powerline = customs.find((r) => r.text === 'Powerline Tower');
  const trailerPark = customs.find((r) => r.text === 'Trailer Park');

  // Both rows genuinely clear the OLD combined floor...
  assert.ok(powerline.area >= MIN_STRUCTURE_M2, `Powerline Tower's combined footprint (${powerline.area} m²) must still exceed the old floor, or this test proves nothing`);
  assert.ok(trailerPark.area >= MIN_STRUCTURE_M2, `Trailer Park's combined footprint (${trailerPark.area} m²) must still exceed the old floor, or this test proves nothing`);
  // ...but neither has a single element at building scale — the same per-unit size as ZB-1012's
  // 33 m² pad and Bus Station's 34/18 m² canopy pieces, both correctly classed `area`.
  assert.ok(powerline.maxArea < MIN_STRUCTURE_M2, `Powerline Tower's largest element (${powerline.maxArea} m²) must be hut-scale`);
  assert.ok(trailerPark.maxArea < MIN_STRUCTURE_M2, `Trailer Park's largest element (${trailerPark.maxArea} m²) must be hut-scale`);
  assert.equal(isStructure(powerline), false, 'two hut-scale elements must not sum into a structure');
  assert.equal(isStructure(trailerPark), false, 'four hut-scale elements must not sum into a structure');
  assert.equal(deriveTier(powerline), 'zone');
  assert.equal(deriveTier(trailerPark), 'zone');

  // A genuine building split into a main volume plus small appendages must still classify as a
  // structure — the per-element floor is not just "the smallest place always wins": Crackhouse's
  // 395 m² main building plus a 19 m² appendage, and Storage's six buildings (all >= 481 m² on
  // their own), both clear the floor on their largest element alone.
  const crackhouse = customs.find((r) => r.text === 'Crackhouse');
  const storage = customs.find((r) => r.text === 'Storage');
  assert.ok(isStructure(crackhouse), 'Crackhouse must still classify as a structure');
  assert.ok(isStructure(storage), 'Storage must still classify as a structure');
});

test('the derivation is actually reading evidence, not returning a constant', () => {
  // If deriveEvidence silently produced empty rows (a moved data file, a renamed field), every
  // row would score 0 and the check above would still "pass" for the zone-heavy maps. Pin the
  // signals that make it discriminating.
  const customs = deriveEvidence('customs');
  const fortress = customs.find((r) => r.text === 'Fortress');
  assert.ok(fortress.area > 1400 && fortress.height > 17, `Fortress footprint/height not read (${fortress.area} m², ${fortress.height} m)`);
  assert.ok(fortress.identity, 'Fortress must be found in PLACE_COLORS');
  const dorms3 = customs.find((r) => r.text === 'Dorms 3-Story');
  assert.ok(dorms3.quests >= 4, `quest zones not being read (Dorms 3-Story got ${dorms3.quests})`);
  const sniperHill = customs.find((r) => r.text === 'Sniper Hill');
  assert.equal(sniperHill.n, 0, 'Sniper Hill must have no buildings carrying its name');
  assert.ok(deriveEvidence('woods').find((r) => r.text === 'Sawmill').spread > 100, 'district spread not read on Woods');
  // and the outcome is a real spread, not one tier for everything
  const tiers = new Set(MAPS.flatMap((m) => LABELS[m].map((l) => l.tier)));
  assert.deepEqual([...tiers].sort(), [...TIERS].sort(), 'all four tiers must actually be in use');
});

test('the tier mix is a ladder, not a flat list', () => {
  const counts = {};
  for (const map of MAPS) for (const l of LABELS[map]) counts[l.tier] = (counts[l.tier] || 0) + 1;
  // "the handful of places a player navigates the whole map by" — a map whose every name is a
  // landmark has no tiers at all.
  for (const map of MAPS) {
    const marks = LABELS[map].filter((l) => l.tier === 'landmark').length;
    assert.ok(marks >= 1, `${map} needs at least one landmark`);
    assert.ok(marks <= Math.ceil(LABELS[map].length / 2), `${map}: ${marks} of ${LABELS[map].length} labels are landmarks — that is not a handful`);
  }
  assert.ok(counts.landmark < counts.zone + counts.minor, 'the tail must outnumber the landmarks');
});

/* ================================ the founder's rule, pinned (2026-09-02) ========= */

// "I think all the building names should be on except the small huts." — every named building
// (landmark/building/minor) draws at the framing the founder is actually looking at; only zone
// (areas, and the huts MIN_STRUCTURE_M2 keeps out of `minor`) is still allowed to thin out there.
// Measured live 3D default: 0.776-1.0 m/px (docs/CONTINUATION-HANDOFF-2026-09-02.md, "CURRENT
// BEHAVIOUR"). Walk the whole observed range, not one point, so a threshold that only clears the
// low end cannot sneak through.
const DEFAULT_FRAMING_MPP = [0.776, 0.85, 0.9, 1.0];

test("the founder's rule: every `minor` label draws at the live 3D default framing, only `zone` thins", () => {
  for (const mpp of DEFAULT_FRAMING_MPP) {
    assert.deepEqual(tiersAtMpp(mpp), ['landmark', 'building', 'minor'],
      `at the measured default framing (${mpp} m/px) exactly landmark+building+minor must draw, zone must not`);
    for (const t of ['landmark', 'building', 'minor']) {
      assert.equal(visibleAtMpp(t, mpp), true, `${t} must draw at ${mpp} m/px (the default framing)`);
    }
    assert.equal(visibleAtMpp('zone', mpp), false, `zone must NOT draw at ${mpp} m/px — only huts/areas thin here`);
  }
  // and every actual `minor` label in the shipped data — not just the tier in the abstract —
  // resolves visible there, for all three maps at once
  for (const map of MAPS) {
    for (const l of LABELS[map].filter((x) => x.tier === 'minor')) {
      assert.equal(visibleAtMpp(l.tier, DEFAULT_FRAMING_MPP.at(-1)), true,
        `${map}/${l.text}: a minor label must still be visible at the widest default-framing measurement`);
    }
  }
});

/* ==================================================================================
 * THE RENDERERS — does the map actually draw the contract?
 * ==================================================================================
 *
 * Everything above tests the contract. This section tests the three passes that consume it, and it
 * exists because of the exact failure this work started from: `size` was deleted from all 76 rows
 * and five readers of `(l.size ?? 100) >= 100` were left behind. Nothing threw. The map rendered.
 * Every label silently became "major". That is handoff §6's "a metric that cannot fail is worse
 * than no metric", wearing a renderer's clothes — so the assertions here are written to go red when
 * a reader comes back, when a tier stops drawing its own leader, or when the ladder is re-derived
 * somewhere it should not be.
 *
 * Source-text assertions are legitimate HERE and only here: the thing being asserted is the absence
 * of a code path, and no behavioural test can prove a dead reader is gone. On /mnt/c importing
 * @deck.gl/core costs ~197 s (handoff §7), so this file still imports no renderer.
 */
import { LEADER_PIECES, hasLeader, labelCssProps, labelMarkup, labelClassName } from '../src/label-chrome.js';

const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/**
 * The same file with its comments removed.
 *
 * Every "this code path no longer exists" assertion below reads THIS, not the raw text — otherwise
 * the comment explaining what was deleted keeps the deletion from being provable, and the way out
 * of that is to stop writing the explanation, which is the wrong trade. Crude on purpose: it is a
 * regex over source we control, not a parser.
 */
const code = (rel) => readSrc(rel).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
/** Every file that draws a place label. */
const LABEL_PASSES = ['src/main.js', 'src/placeLabels.js', 'src/map3d.js', 'src/map3d-three.js'];

test('THE SILENT BREAK: no place-label pass reads `size` any more', () => {
  for (const rel of LABEL_PASSES) {
    const src = code(rel);
    // `(l.size ?? 100)` and friends: the idiom that was always true once `size` was deleted.
    assert.doesNotMatch(src, /\.size\s*(\?\?|\|\|)/,
      `${rel} still falls back on a missing \`size\` — that expression is now unconditionally true`);
    assert.doesNotMatch(src, /\.size\s*\)?\s*\/\s*100/, `${rel} still scales by a \`size\` percentage`);
    assert.doesNotMatch(src, /\bsize\s*>=\s*100|\bsize\s*<\s*100/, `${rel} still thresholds on \`size\``);
  }
  // The 2D pass and main.js must not mention a label's `size` at all.
  for (const rel of ['src/main.js', 'src/placeLabels.js']) {
    assert.doesNotMatch(code(rel), /\b[ld]\.size\b/, `${rel} still reads a label's \`size\``);
  }
  // map3d.js keeps EXACTLY TWO `d.size` reads, and they are not place labels: they are the extract
  // NAME rows built inside map3d (`size: lit ? 13.5 : 12`). Pinned by count so a third one fails.
  const deck = code('src/map3d.js');
  const deckSize = deck.match(/\bd\.size\b/g) ?? [];
  assert.equal(deckSize.length, 2,
    `src/map3d.js should read \`d.size\` exactly twice (the extract-name rows), found ${deckSize.length}`);
  assert.match(deck, /size: lit \? 13\.5 : 12/, 'the two surviving reads must still be the extract-name rows');
  // …and the tier contract is what replaced it, in every pass.
  for (const rel of LABEL_PASSES) {
    assert.match(readSrc(rel), /from '\.\/label-tier\.js'/, `${rel} must consume the tier contract`);
  }
});

test('nobody re-introduced a swallowing fallback for a bad tier', () => {
  for (const rel of LABEL_PASSES) {
    const src = code(rel);
    assert.doesNotMatch(src, /tierOf\([^)]*\)\s*(\?\?|\|\|)/, `${rel} swallows tierOf()'s throw with a default`);
    assert.doesNotMatch(src, /styleFor\([^)]*\)\s*(\?\?|\|\|)/, `${rel} swallows styleFor()'s throw with a default`);
    assert.doesNotMatch(src, /try\s*\{[^}]*\b(labelTierOf|tierOf)\(/, `${rel} catches the tier throw`);
  }
});

/* ------------------------------------------------------- the leader line ---------- */

test('every tier renders its OWN stem length, and zone renders no stem and no cap', () => {
  const stems = new Map(TIERS.map((t) => [t, labelCssProps(t)['--stem']]));
  // the three structure tiers each get a different, non-zero leader
  for (const t of ['landmark', 'building', 'minor']) {
    assert.equal(hasLeader(t), true, `${t} must draw a leader`);
    assert.equal(stems.get(t), `${styleFor(t).stemPx}px`, `${t} must render its own stemPx`);
    assert.notEqual(stems.get(t), '0px', `${t} must not collapse onto its anchor`);
    const html = labelMarkup(t, 'FORTRESS');
    for (const piece of LEADER_PIECES) assert.match(html, new RegExp(`class="${piece}"`), `${t} markup is missing ${piece}`);
    assert.match(html, new RegExp(`--stem:${styleFor(t).stemPx}px`), `${t} markup must carry its own stem`);
  }
  // no two structure tiers lift by the same amount — a leader that is the same length everywhere
  // is decoration, not a hierarchy
  const lengths = ['landmark', 'building', 'minor'].map((t) => stems.get(t));
  assert.equal(new Set(lengths).size, 3, `stem lengths must differ per tier, got ${lengths.join(' / ')}`);

  // ZONE: a region, not a pin.
  assert.equal(hasLeader('zone'), false);
  assert.equal(labelCssProps('zone')['--stem'], '0px');
  const zoneHtml = labelMarkup('zone', 'SNIPER HILL');
  assert.doesNotMatch(zoneHtml, /pl-stem/, 'zone must render NO stem');
  assert.doesNotMatch(zoneHtml, /pl-cap/, 'zone must render NO cap tick');
  assert.doesNotMatch(zoneHtml, /pl-ring/, 'zone names ground, not a point — no anchor ring either');
  assert.match(zoneHtml, /class="pl-name"/, 'the zone still draws its name');
  assert.equal(labelClassName('zone'), 'place-label tier-zone', 'style.css hangs the zone rules off this class');
});

test('the leader is drawn in all three passes, off the same contract', () => {
  // 2D (Leaflet divIcon) and Three (HTML overlay) share src/label-chrome.js…
  for (const rel of ['src/placeLabels.js', 'src/map3d-three.js']) {
    assert.match(readSrc(rel), /from '\.\/label-chrome\.js'/, `${rel} must draw the shared leader markup`);
  }
  /*
   * …and every piece of it is styled in BOTH DOM scopes. Scoped per pass on purpose: the two share
   * class names, so an unscoped `.pl-ring` match is satisfied by whichever pass still has the rule
   * — an assertion that cannot fail for the pass that lost it.
   */
  const css = code('src/style.css');
  for (const scope of ['\\.place-label', '\\.tz-three-marker-place']) {
    for (const piece of LEADER_PIECES) {
      assert.match(css, new RegExp(`${scope} \\.${piece}[,{]`), `style.css has no ${scope} rule for .${piece}`);
    }
    assert.match(css, new RegExp(`${scope} \\.pl-ring\\{[^}]*border:[^}]*background:none`, 's'),
      `${scope}: the anchor ring must be HOLLOW — a filled dot vanishes on a bright roof`);
    assert.match(css, new RegExp(`${scope} \\.pl-stem\\{[^}]*linear-gradient\\(to top`, 's'),
      `${scope}: the stem must fade upward`);
    // the cap sits at the TOP of the stem — it is what the name stands on, not decoration parked
    // anywhere on the leader, and it has to move whenever the collision pass grows `--stem`
    assert.match(css, new RegExp(`${scope} \\.pl-cap\\{[^}]*bottom:var\\(--stem\\)`, 's'),
      `${scope}: the cap tick must ride the top of the stem`);
    assert.match(css, new RegExp(`${scope} \\.pl-stem\\{[^}]*height:var\\(--stem\\)`, 's'),
      `${scope}: the stem's length must BE the tier's (and the collision pass's) --stem`);
  }
  // deck.gl has no DOM, so it rebuilds the same leader out of layers — assert the three ids exist.
  const deck = code('src/map3d.js');
  for (const id of ['label-stem', 'label-cap', 'label-anchor']) {
    assert.match(deck, new RegExp(`id: '${id}'`), `the deck pass is missing its ${id} layer`);
  }
  // scoped to the anchor layer's own definition: `stroked: true, filled: false` also appears on the
  // live-player ring, so an unscoped match would pass with the label ring filled in solid.
  assert.match(deck, /id: 'label-anchor'[^\n]*stroked: true, filled: false/,
    'the deck anchor ring must be hollow too — a filled dot vanishes on a bright roof');
  assert.match(deck, /e\.s\.stemPx/, 'the deck pass must take its stem length from the tier contract');
  // and the WORLD-SPACE beam it replaced is gone: 26 m / 16 m of light column driven by `size`
  assert.doesNotMatch(deck, /ping-beam|ping-base/, 'the old world-space ping survived');
});

/* ------------------------------------------------------- thinning --------------- */

test('thinning is driven by metres per pixel, in exactly one place', () => {
  const main = code('src/main.js');
  // THE ladder: the contract's function, fed the view's own m/px.
  assert.match(main, /tiersAtMpp\(metresPerPixel\(\)\)/,
    'main.js must thin on the contract ladder at the current metres per pixel');
  assert.match(main, /function activeTiers\(\)/, 'the ladder + density override must be one function');
  // and NOT a zoom integer anywhere in a label path — one zoom number is three different real
  // scales across Customs / Reserve / Woods (CRS offsets 2.065 / 1.340 / 2.431).
  const deck = code('src/map3d.js');
  assert.doesNotMatch(deck, /major\(d\) \|\| z >= 0\.8/, 'the deck pass re-introduced a zoom-integer label gate');
  assert.doesNotMatch(deck, /labelRows\s*\n?\s*\.filter/, 'the deck pass must not re-thin the rows main.js already thinned');
  // the Three overlay does not re-derive it either
  assert.match(readSrc('src/map3d-three.js'), /THINNING IS NOT DONE HERE/,
    'the Three pass must document that it consumes main.js labelSet(), not its own ladder');
});

test('the ladder is monotone: every step adds exactly one tier, and never at a zoom integer', () => {
  // The renderer-side statement of the contract test above: walking OUT from fully zoomed in, the
  // visible set only ever shrinks, and it shrinks one tier at a time.
  const stops = [];
  for (let mpp = 0.05; mpp <= 8; mpp *= 1.02) stops.push(mpp);
  let prev = tiersAtMpp(stops[0]);
  assert.deepEqual(prev, TIERS, 'fully zoomed in, every tier draws');
  let drops = 0;
  for (const mpp of stops.slice(1)) {
    const now = tiersAtMpp(mpp);
    assert.ok(now.length <= prev.length, `zooming out must never ADD a tier (${mpp} m/px)`);
    assert.deepEqual(now, prev.slice(0, now.length), `the set must stay a prefix of TIERS at ${mpp} m/px`);
    if (now.length !== prev.length) {
      assert.equal(prev.length - now.length, 1, `one tier at a time, not ${prev.length - now.length} (${mpp} m/px)`);
      drops++;
    }
    prev = now;
  }
  assert.equal(drops, 4, `all four tiers must drop out across the walk, got ${drops}`);
  assert.deepEqual(prev, [], 'fully zoomed out, nothing draws');
  // the same ladder is three DIFFERENT zoom numbers per map, which is why it is not a zoom integer
  const zooms = [0.239, 0.395, 0.185].map((crs) => Number(minZoom2dFor('building', crs).toFixed(4)));
  assert.equal(new Set(zooms).size, 3, `one m/px threshold must be three zoom numbers, got ${zooms.join(' / ')}`);
});

test('no tier is ever drawn below the legibility floor — the floor is the ladder, not a clamp', () => {
  // map3d.js ramps the contract's authored size with scale. Read the ramp out of the source rather
  // than restating it, so a change to the clamp or the exponent lands here instead of drifting.
  const deck = readSrc('src/map3d.js');
  const m = deck.match(/const labelRamp = \(mpp\) => Math\.min\(([\d.]+), Math\.max\(([\d.]+), \(REFERENCE_MPP \/ Math\.max\(1e-6, mpp\)\) \*\* ([\d.]+)\)\)/);
  assert.ok(m, 'could not read labelRamp() out of src/map3d.js');
  const [hi, lo, exp] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ramp = (mpp) => Math.min(hi, Math.max(lo, (REFERENCE_MPP / mpp) ** exp));
  // EVERY tier takes the same multiplier — that is what preserves the ratios the contract fixes.
  for (const mpp of [0.1, 0.3, 0.6, 1.2, 6]) {
    const r = ramp(mpp);
    assert.ok(Math.abs((styleFor('landmark').fontSizePx * r) / (styleFor('minor').fontSizePx * r)
      - styleFor('landmark').fontSizePx / styleFor('minor').fontSizePx) < 1e-12, 'the ramp must not change the tier ratios');
  }
  // A tier is only drawn at or below its own threshold, so its SMALLEST size is its size there.
  for (const tier of TIERS) {
    const at = styleFor(tier).showAtOrBelowMetresPerPixel;
    const px = styleFor(tier).fontSizePx * ramp(at);
    assert.ok(px >= 11, `${tier} bottoms out at ${px.toFixed(1)} px at its own ${at} m/px threshold (QA D13/M10 floor is 11)`);
  }
  // and the 2D pass's floor is the same number, derived the same way
  for (const tier of TIERS) {
    assert.equal(labelCssProps(tier)['--fs-min'], `${Math.max(11, styleFor(tier).fontSizePx - 2.5)}px`);
    assert.ok(parseFloat(labelCssProps(tier)['--fs-min']) >= 11, `${tier} 2D floor below 11 px`);
  }
});

/* ------------------------------------------------------- collision -------------- */

test('collision is resolved on the STEM, and hiding is the last resort', () => {
  const two = code('src/placeLabels.js');
  const deck = code('src/map3d.js');
  // 2D: the ladder walked is a stem delta, written back onto --stem, not a translate of the label.
  assert.match(two, /STEM_STEP/, '2D: no stem ladder');
  assert.match(two, /setProperty\('--stem', `\$\{stem0 \+ placed\.d\}px`\)/, '2D: the resolved rung must be written to --stem');
  assert.match(two, /rows\[i\]\.stemmed/, '2D: a zone (no stem) must be handled apart from a stemmed tier');
  // the anchor never moves: nothing translates the label ROOT, only the name inside it
  assert.doesNotMatch(two, /\.place-label['"]?\)?\.style\.transform/, '2D: the label root must never be translated');
  // deck: the vertical ladder is the stem, so seat() is handed a single-rung ladder
  assert.match(deck, /LABEL_STEM_RUNGS/, 'deck: no stem ladder');
  assert.match(deck, /seat\(p\[0\], cy, w, h, true, stem > 0 \? \[0\] : null\)/,
    'deck: a stemmed name must not also walk seat()\'s own up/down ladder');
  // and the stem the leader draws is derived from where the name LANDED, not from the rung asked
  // for — a cap tick at the rung height would float in the gap after a chrome nudge.
  assert.match(deck, /e\.stem = Math\.max\(0, -e\.off\[1\] - h \/ 2 - LABEL_NAME_GAP\)/,
    'deck: the drawn stem must be measured back out of the seated position');
});

/* ------------------------------------------------------- extract ownership ------ */

test('the extract-owned ten are still stood down in all three passes', () => {
  const main = code('src/main.js');
  // the rule itself
  assert.match(main, /const ownedByExtract = \(l\) => extractNames\.has\(labelKey\(l\?\.text\)\)/,
    'ownedByExtract must still key on the label TEXT against the live marker set');
  // 2D: handed to the layer as its `hidden` predicate
  assert.match(main, /hidden: ownedByExtract/, '2D: the place-label layer no longer consults ownedByExtract');
  assert.match(code('src/placeLabels.js'), /hidden\?\.\(rows\[i\]\.label\)/, '2D: the clip pass no longer applies `hidden`');
  // 3D (both renderers): filtered out of the set main.js hands them
  assert.match(main, /mapLabels\.filter\(\(l\) => !ownedByExtract\(l\) && tiers\.has\(labelTierOf\(l\)\)\)/,
    '3D: labelSet() must drop the extract-owned rows before either renderer sees them');
  // omnibox index
  assert.match(main, /for \(const l of mapLabels\) \{ if \(ownedByExtract\(l\)\) continue;/,
    'the omnibox index no longer drops the extract-owned rows');
  // and the count is still ten — the same ten the contract test pins from public data
  const owned = MAPS.flatMap((m) => LABELS[m].filter((l) => extractNameKeys(m).has(labelKey(l.text))));
  assert.equal(owned.length, 10, 'ten place names are owned by an extract badge');
  // hiding is independent of the tier: each of the ten still resolves a full style
  for (const l of owned) assert.doesNotThrow(() => styleFor(tierOf(l)), `${l.text} lost its style`);
});

/* ------------------------------------------------------- the webfont gate ------- */

test('the deck atlas cannot be built before the face resolves (the trap)', () => {
  const deck = code('src/map3d.js');
  // The face, and the gate around it.
  assert.match(deck, /const LABEL_FACE = 'IBM Plex Sans Condensed'/, 'the display face must be IBM Plex Sans Condensed');
  assert.doesNotMatch(deck, /Barlow/, 'the deck pass still names the old face somewhere');
  // fontsReady starts FALSE and is written in exactly one place: the resolved fonts promise.
  assert.match(deck, /let fontsReady = false/, 'fontsReady must start false');
  const writes = deck.match(/\bfontsReady\s*=/g) ?? [];
  assert.equal(writes.length, 2, `fontsReady must be assigned exactly twice (init + the fonts promise), found ${writes.length}`);
  assert.match(deck, /waitFonts\.then\(\(\) => \{ fontsReady = fontLoaded\(\);/,
    'the only writer of fontsReady must be the resolved document.fonts promise');
  // LABEL_FONT() names the face ONLY when fontsReady — that is what changes the atlas key.
  assert.match(deck, /const LABEL_FONT = \(\) => \(fontsReady \? `\$\{LABEL_FACE\}, \$\{LABEL_FALLBACK\}` : LABEL_FALLBACK\)/,
    'LABEL_FONT() must fall back until the face is confirmed');
  // nothing hands a TextLayer a hardcoded family behind the gate's back
  assert.doesNotMatch(deck, /fontFamily:\s*['"`](?!\$)/, 'a TextLayer names a font family literally, bypassing LABEL_FONT()');
  const families = deck.match(/fontFamily:/g) ?? [];
  const gated = deck.match(/fontFamily: LABEL_FONT\(\)/g) ?? [];
  assert.equal(families.length, gated.length, 'every fontFamily in the deck pass must come from LABEL_FONT()');
  // …and the gate waits for EVERY weight the contract resolves to, because deck bakes one atlas
  // per (family, weight): a weight that had not landed would bake the fallback into its own atlas.
  assert.match(deck, /const LABEL_WEIGHTS = \[\.\.\.new Set\(LABEL_TIERS\.map\(\(t\) => labelStyleFor\(t\)\.fontWeight\)\)\]/,
    'the gate must derive its weights from the tier contract, not list them by hand');
  assert.match(deck, /LABEL_WEIGHTS\.every\(\(w\) => document\.fonts\?\.check/, 'fontLoaded() must check every weight');
  assert.match(deck, /Promise\.all\(LABEL_WEIGHTS\.map\(\(w\) => document\.fonts\?\.load/, 'waitFonts must load every weight');
  // the width MEASUREMENT is keyed on the same epoch, or a fallback-width cache outlives the swap
  assert.match(deck, /const key = `\$\{fontsReady \? 1 : 0\}\|/, 'the measured-width cache must be keyed on the font epoch');
});

test('the page requests the face, at the weights the contract asks for', () => {
  const html = readSrc('index.html');
  const css = code('src/style.css');
  const link = html.match(/fonts\.googleapis\.com\/css2\?([^"]+)/)?.[1];
  assert.ok(link, 'index.html no longer requests any webfont');
  assert.match(link, /family=IBM\+Plex\+Sans\+Condensed:wght@([\d;]+)/, 'IBM Plex Sans Condensed is not requested');
  const asked = link.match(/family=IBM\+Plex\+Sans\+Condensed:wght@([\d;]+)/)[1].split(';').map(Number);
  for (const tier of TIERS) {
    assert.ok(asked.includes(styleFor(tier).fontWeight),
      `weight ${styleFor(tier).fontWeight} (${tier}) is never requested — its atlas would bake the fallback`);
  }
  assert.doesNotMatch(link, /Barlow\+Condensed/, 'the retired display face is still being fetched');
  // and the CSS token points at the same family, with the same fallback chain the atlas uses
  assert.match(css, /--f-display:'IBM Plex Sans Condensed','Arial Narrow'/, "--f-display must be the new face");
  assert.doesNotMatch(css, /Barlow Condensed/, 'style.css still names the retired face');
});
