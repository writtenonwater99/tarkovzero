// The local-only Customs bridge package: contract, merge, dev route, and the boundary.
//
// Every assertion here was shown to FAIL before it was kept — the mutations and their red output
// are recorded in the task report. Per handoff §6, an assertion that cannot fail is worse than none.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BRIDGE_SEATING,
  CUSTOMS_LOCAL_BRIDGES_SEGMENTS,
  PROVISIONAL_UNMEASURED,
  bridgeDeckAnchor,
  bridgeSeating,
  mergeCustomsLocalBridges,
  validateCustomsLocalBridgesPackage,
} from '../src/customs-local-bridges.js';
import { bridgeApproachPlan, bridgeStructurePlan } from '../src/bridge-structure.js';
import {
  WATER_SURFACE_SEATING,
  deckWaterClearance,
  waterSurfaceContains,
  waterSurfacePlan,
} from '../src/water-surface.js';
import { terrainRelativeDisplayY } from '../src/three-world.js';
import { measuredSurfaceY } from '../src/surfaces.js';
import { loadCustomsLocalBridgesPackage } from '../src/customs-local-bridges-loader.js';
import { canLoadLocalGameDerivedAssets } from '../src/renderer-gate.js';
import {
  LOCAL_GAME_DERIVED_DIRNAME,
  LOCAL_GAME_DERIVED_ROUTE,
  createLocalGameDerivedMiddleware,
} from './lib/local-game-derived-dev.mjs';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CUSTOMS_3D = join(REPOSITORY_ROOT, 'public', 'data', 'customs-3d.json');
const GENERATOR = join(REPOSITORY_ROOT, 'scripts', 'extract-customs-bridges-local.mjs');

/** A structurally complete package. No real game coordinates: this file is git-tracked. */
const dimension = (source) => ({ status: PROVISIONAL_UNMEASURED, source });
const PACKAGE_VALUE = {
  schemaVersion: 1,
  map: 'customs',
  localOnly: true,
  sourceFrame: 'eft-unity-world-metres-y-up',
  generator: 'scripts/extract-customs-bridges-local.mjs',
  bridges: [
    {
      id: 'rail-one',
      name: 'Rail One',
      kind: 'rail',
      path: [[0, 0], [10, 1]],
      width: 9,
      deckCanonicalYM: 3,
      dimensions: { path: dimension('abutment pivots'), width: dimension('portal pivots') },
    },
    {
      id: 'foot-one',
      name: 'Foot One (span 1 of 2)',
      kind: 'foot',
      foot: true,
      replaces: 'Junk Bridge',
      path: [[0, 20], [8, 22]],
      width: 2.5,
      deckCanonicalYM: -12,
      dimensions: { path: dimension('plane pivots') },
    },
    {
      id: 'foot-two',
      name: 'Foot One (span 2 of 2)',
      kind: 'foot',
      foot: true,
      replaces: 'Junk Bridge',
      path: [[20, 24], [30, 25]],
      width: 2.5,
      deckCanonicalYM: -12,
      dimensions: { path: dimension('plane pivots') },
    },
  ],
};
const PUBLIC_ROWS = [
  { name: 'Main Bridge', kind: 'highway' },
  { name: 'River path', ford: true },
  { name: 'Junk Bridge', kind: 'foot' },
];

test('the package contract accepts a complete package and freezes it', () => {
  const validated = validateCustomsLocalBridgesPackage(PACKAGE_VALUE);
  assert.equal(validated.bridges.length, 3);
  assert.ok(Object.isFrozen(validated.bridges[0]));
});

test('a dimension may not claim to be anything but provisional-unmeasured', () => {
  const laundered = structuredClone(PACKAGE_VALUE);
  laundered.bridges[0].dimensions.width.status = 'measured-mesh-bounds';
  assert.throws(
    () => validateCustomsLocalBridgesPackage(laundered),
    /must be provisional-unmeasured; the facts dump carries no bounds/,
  );
});

test('a record may not carry a terrain-relative height instead of a canonical deck Y', () => {
  // `kind: 'rail'` in build-3d.mjs implies an 8 m lift above interpolated terrain. These decks sit
  // ~2.5 m above their own abutment pivots, so the field is refused outright rather than ignored.
  const lifted = structuredClone(PACKAGE_VALUE);
  lifted.bridges[0].height = 8;
  assert.throws(() => validateCustomsLocalBridgesPackage(lifted), /unsupported field\(s\): height/);
  const missing = structuredClone(PACKAGE_VALUE);
  delete missing.bridges[0].deckCanonicalYM;
  assert.throws(() => validateCustomsLocalBridgesPackage(missing), /missing required field deckCanonicalYM/);
});

test('a repeated path point is refused: a zero-length segment has no tangent for a pier', () => {
  const repeated = structuredClone(PACKAGE_VALUE);
  repeated.bridges[0].path = [[0, 0], [10, 1], [10, 1]];
  assert.throws(() => validateCustomsLocalBridgesPackage(repeated), /repeats the previous point/);
});

test('the merge replaces one public row in place with both of its spans and appends the rest', () => {
  const merged = mergeCustomsLocalBridges(PUBLIC_ROWS, PACKAGE_VALUE);
  assert.deepEqual(merged.bridges.map((bridge) => bridge.name), [
    'Main Bridge',
    'River path',
    'Foot One (span 1 of 2)',
    'Foot One (span 2 of 2)',
    'Rail One',
  ]);
  assert.equal(merged.added, 1);
  assert.deepEqual(merged.replaced, ['Junk Bridge']);
  assert.deepEqual(merged.unmatchedReplaceTargets, []);
  // The public array is an input, never a target.
  assert.deepEqual(PUBLIC_ROWS.map((bridge) => bridge.name), ['Main Bridge', 'River path', 'Junk Bridge']);
});

test('a replacement target that the public data no longer ships is REPORTED, not swallowed', () => {
  const merged = mergeCustomsLocalBridges(
    PUBLIC_ROWS.filter((bridge) => bridge.name !== 'Junk Bridge'),
    PACKAGE_VALUE,
  );
  assert.deepEqual(merged.unmatchedReplaceTargets, ['Junk Bridge']);
  assert.deepEqual(merged.replaced, []);
  assert.equal(merged.bridges.length, 5);
});

test('a local deck is seated on canonical game Y, never on relief-multiplied evidence', () => {
  const [rail] = validateCustomsLocalBridgesPackage(PACKAGE_VALUE).bridges;
  const seat = bridgeSeating(rail);
  assert.equal(seat.mode, BRIDGE_SEATING.CANONICAL);
  assert.equal(seat.canonicalYM, 3);
  // Relief must never stretch a game altitude: `measuredSurfaceY` would, which is why the canonical
  // rule exists as its own mode rather than as a `surfaceY` in disguise.
  assert.equal(measuredSurfaceY(rail, 2), null);
});

test('a deck is pinned to its highest bank, not to the hole it spans', () => {
  const span = {
    // Two banks and a cut between them, as both rail decks and both junk spans actually are.
    path: [[0, 0], [5, 0], [10, 0], [15, 0]],
    deckCanonicalYM: 4,
  };
  const ground = (x) => ({ 0: 3.6, 5: -0.2, 10: -0.2, 15: 3.76 })[x];
  const anchor = bridgeDeckAnchor(span, (x) => ground(x));
  assert.deepEqual(anchor, [15, 0], 'the highest bank is the point a deck has to meet');

  // What the rejected alternative costs, in this renderer's own fixed 2x display relief: pinning
  // mid-span puts the deck BELOW the display height of both of its own banks.
  const display = (x) => ground(x) * 2;
  const seatAt = (x) => display(x) + (span.deckCanonicalYM - ground(x));
  assert.ok(seatAt(15) > display(0) && seatAt(15) > display(15), 'bank-pinned: both ends stay clear');
  assert.ok(seatAt(5) < display(0) && seatAt(5) < display(15), 'mid-pinned: both ends are buried');

  assert.equal(bridgeDeckAnchor(span, () => NaN), null, 'no finite ground, no guessed seat');
  assert.equal(bridgeDeckAnchor(span, null), null);
});

test('a canonical-game-Y deck is never given an abutment reaching for a sampled bed', () => {
  // THE SEATING GATE, from the local package's side. A measured public deck ends above its bank and
  // is landed with an abutment and an approach embankment. A `canonical-game-y` deck is a different
  // animal: `bridgeDeckAnchor` already pins it to its HIGHEST bank so its ends are flush, and the
  // junk-bridge planks clear the river by 0.48 m. Founding structure under one against a sampled
  // bed is how those decks went under the water and disappeared — the defect below this line.
  const [rail] = validateCustomsLocalBridgesPackage(PACKAGE_VALUE).bridges;
  assert.equal(bridgeSeating(rail).mode, BRIDGE_SEATING.CANONICAL);
  // The planner is willing: handed this deck it WOULD build both ends, which is exactly why the
  // renderer's `seating.mode === BRIDGE_SEATING.MEASURED` guard is the thing under test and not a
  // decoration. `scripts/three-renderer-test.mjs` asserts that guard against the renderer source.
  const willing = bridgeApproachPlan(rail, { deckYAt: () => 3, groundYAt: () => 1 });
  assert.equal(willing.ends.length, 2, 'the planner has no opinion about seating — the caller does');
  assert.ok(willing.ends.every((end) => end.abutment && end.embankment));
});

test('every bridge the public artifact ships keeps its existing seating rule', async () => {
  const data = JSON.parse(await readFile(CUSTOMS_3D, 'utf8'));
  const modes = data.bridges.map((bridge) => [bridge.name, bridgeSeating(bridge).mode]);
  assert.deepEqual(modes, [
    ['Main Bridge', BRIDGE_SEATING.MEASURED],
    ['River path', BRIDGE_SEATING.LIFT],
    ['Junk Bridge', BRIDGE_SEATING.LIFT],
  ]);
});

test('a local record flows through the SAME structure pipeline the public bridges use', () => {
  const [rail] = validateCustomsLocalBridgesPackage(PACKAGE_VALUE).bridges;
  // Ground two metres under the deck, as the abutment pivots put it — enough for a real pier.
  const plan = bridgeStructurePlan(rail, { deckYAt: () => 3, groundYAt: () => 1 });
  assert.equal(plan.ford, false);
  assert.ok(plan.fascia, 'a local deck gets the same fascia as a public one');
  assert.equal(plan.rails.length, 2);
  assert.ok(plan.piers.length >= 1, 'and piers planned from its own width, not from a literal');
  assert.equal(plan.profile.widthM, rail.width);
  // `kind: 'rail'` in build-3d.mjs means an 8 m lift above terrain. These decks stand ~2 m above
  // their abutments, so a lift-seated deck would float about six metres over the game's geometry.
  assert.ok(Math.abs((1 + 8) - rail.deckCanonicalYM) > 5);
});

// -----------------------------------------------------------------------------------------------
// THE MEASURED DEFECT: a bridge can be "applied" and still be invisible.
//
// `renderStats().bridges.local` reported `applied: true`, `replaced: ["Junk Bridge"]`, six decks and
// eleven piers — every counter green — while BOTH junk spans rendered underneath the river sheet and
// could not be seen at all. Handoff §6: a metric that cannot fail is worse than no metric, so the
// assertion below is not "was it applied" but "does the deck sit ABOVE the water at its own span".
//
// The two authorities that disagreed: a deck states a CANONICAL game Y and is seated
// terrain-relative against the EXACT local riverbed, keeping its true clearance; the water sheet was
// seated by multiplying the shipped `level` — a value fitted from the public heightfield, which is
// interpolated from spawn and loot points and never sits on a riverbed — by display relief. The
// numbers below are invented and reproduce that geometry class; no game coordinate is in this file.
// -----------------------------------------------------------------------------------------------

/** A channel: dry banks, a traced shoreline part-way down, a bed in the middle. Canonical metres. */
const CHANNEL = { dryY: -4, shoreY: -6, bedY: -9, shoreXA: 8, shoreXB: 32 };
/** Piecewise-linear cross-section, x -> canonical ground Y. Continuous, so no vertex sits on a step. */
const CHANNEL_PROFILE = [
  [4, CHANNEL.dryY], [CHANNEL.shoreXA, CHANNEL.shoreY], [14, CHANNEL.bedY],
  [26, CHANNEL.bedY], [CHANNEL.shoreXB, CHANNEL.shoreY], [36, CHANNEL.dryY],
];
const channelGroundAt = (x) => {
  if (x <= CHANNEL_PROFILE[0][0]) return CHANNEL_PROFILE[0][1];
  for (let i = 1; i < CHANNEL_PROFILE.length; i += 1) {
    const [x0, y0] = CHANNEL_PROFILE[i - 1], [x1, y1] = CHANNEL_PROFILE[i];
    if (x <= x1) return y0 + ((y1 - y0) * ((x - x0) / (x1 - x0)));
  }
  return CHANNEL_PROFILE[CHANNEL_PROFILE.length - 1][1];
};
const CHANNEL_RELIEF = 2;
const canonicalGroundAt = (x) => channelGroundAt(Number(x));
const displayGroundAt = (x) => channelGroundAt(Number(x)) * CHANNEL_RELIEF;
/**
 * The traced water outline, both banks, down the length of the channel.
 *
 * Its vertices deliberately WANDER either side of the true shoreline: a hand-traced SVG outline
 * does, and a fixture whose samples are all identical cannot tell one estimator from another.
 */
const WATER_ROW = {
  kind: 'river',
  // A fitted level that never saw the bed — metres above it, as the public heightfield's is.
  level: 0,
  poly: [
    [6.5, 0], [CHANNEL.shoreXA, 20], [9.5, 40], [CHANNEL.shoreXA, 60],
    [CHANNEL.shoreXB, 60], [33.5, 40], [CHANNEL.shoreXB, 20], [30.5, 0],
  ],
};
/** A plank span across the channel: 4 m of real clearance over the bed, 1 m over its own banks. */
const PLANK_SPAN = {
  id: 'plank-span', name: 'Plank Span', kind: 'foot', foot: true,
  path: [[8, 30], [14, 30], [20, 30], [26, 30], [32, 30]],
  width: 2.5,
  deckCanonicalYM: -5,
  dimensions: { path: dimension('plane pivots') },
};

/** Exactly how `map3d-three.js` seats a canonical deck: pinned to its highest bank vertex. */
function seatedDeckDisplayY(bridge) {
  const anchor = bridgeDeckAnchor(bridge, (x) => canonicalGroundAt(x));
  assert.ok(anchor, 'the fixture must have finite ground under it, or this proves nothing');
  return terrainRelativeDisplayY({
    canonicalY: bridgeSeating(bridge).canonicalYM,
    canonicalGroundY: canonicalGroundAt(anchor[0]),
    displayGroundY: displayGroundAt(anchor[0]),
  });
}

test('THE DEFECT: the fitted water level drowns a deck that really clears the riverbed', () => {
  const deckY = seatedDeckDisplayY(PLANK_SPAN);
  // Real clearance over the real bed. This deck is walkable in game; it is not a submerged prop.
  assert.ok(PLANK_SPAN.deckCanonicalYM - CHANNEL.bedY > 2, 'the fixture deck stands clear of its bed');

  // The old rule: `level * relief + 0.08`, with `level` fitted from the public heightfield.
  const fitted = waterSurfacePlan(WATER_ROW, { relief: CHANNEL_RELIEF, lift: 0.08 });
  assert.equal(fitted.mode, WATER_SURFACE_SEATING.PUBLIC_LEVEL);
  assert.ok(
    deckY < fitted.displayY,
    'the fitted level must bury this deck, or the defect is not reproduced and nothing below discriminates',
  );
  assert.ok(fitted.displayY - deckY > 10, 'and by metres, not by a rounding error');
});

/** The exact-terrain seating under test, applied to the fixture channel. */
const shorelinePlan = () => waterSurfacePlan(WATER_ROW, {
  relief: CHANNEL_RELIEF, lift: 0.08, canonicalGroundAt, displayGroundAt,
});

test('the sheet is seated at the display height of the terrain under its own traced shoreline', () => {
  const plan = shorelinePlan();
  assert.equal(plan.mode, WATER_SURFACE_SEATING.EXACT_SHORELINE);
  assert.equal(plan.level.status, PROVISIONAL_UNMEASURED);
  assert.match(plan.level.source, /no water-surface object exists in the facts dump/);
  // The water's own edge meets the ground it is drawn against, and the altitude is the median of
  // the outline's samples — never the highest, which would drown whatever stands in the channel.
  assert.equal(plan.displayY, (CHANNEL.shoreY * CHANNEL_RELIEF) + 0.08);
  assert.equal(plan.shoreline.samples, WATER_ROW.poly.length);
  assert.equal(plan.shoreline.canonicalYM, CHANNEL.shoreY);
  // The traced outline wanders, so median, highest and lowest are three different answers here.
  assert.ok(plan.shoreline.spreadM > 1, `a flat fixture proves nothing (spread ${plan.shoreline.spreadM})`);
  assert.equal(plan.shoreline.holeRings, 0);
});

test('THE ACCEPTANCE TEST: the deck sits ABOVE the water at its own span, not merely applied', () => {
  // What `local.applied: true` could not see. This is the founder's criterion — "as long as it
  // looks like there is a tiny bridge below the main bridge, it's good" — as an assertion.
  const deckY = seatedDeckDisplayY(PLANK_SPAN);
  const plan = shorelinePlan();
  const { clearanceM, crossings } = deckWaterClearance(
    PLANK_SPAN.path, () => deckY, [{ water: WATER_ROW, plan }],
  );
  assert.ok(crossings > 0, 'the span must actually stand over the water, or the check is vacuous');
  assert.ok(clearanceM > 0, `the deck must sit ABOVE the surface (clearance ${clearanceM})`);
  assert.equal(clearanceM, deckY - plan.displayY);
});

test('a deck over dry land reports NO crossing, which is not the same as clearing the water', () => {
  const plan = waterSurfacePlan(WATER_ROW, {
    relief: CHANNEL_RELIEF, lift: 0.08, canonicalGroundAt, displayGroundAt,
  });
  const away = deckWaterClearance([[100, 30], [140, 30]], () => -26, [{ water: WATER_ROW, plan }]);
  assert.equal(away.crossings, 0);
  assert.equal(away.clearanceM, null, 'null clearance may never read as "clears the surface"');
  // An island cut out of the polygon is dry land inside the outline, and is treated as such.
  const withIsland = { ...WATER_ROW, holes: [[[18, 26], [22, 26], [22, 34], [18, 34]]] };
  assert.equal(waterSurfaceContains(withIsland, 20, 30), false, 'the island is not water');
  assert.equal(waterSurfaceContains(withIsland, 10, 30), true, 'the channel beside it still is');
});

test('with no exact terrain the shipped expression is reproduced EXACTLY — production cannot move', async () => {
  const data = JSON.parse(await readFile(CUSTOMS_3D, 'utf8'));
  assert.ok(data.water.length > 0, 'the artifact must ship water rows for this to prove anything');
  for (const water of data.water) {
    const plan = waterSurfacePlan(water, { relief: 2, lift: 0.08 });
    assert.equal(plan.mode, WATER_SURFACE_SEATING.PUBLIC_LEVEL);
    assert.equal(plan.reason, 'no-exact-terrain');
    assert.equal(plan.displayY, (Number(water.level) || 0) * 2 + 0.08, water.kind);
    assert.equal(plan.shoreline, null);
  }
  // Samplers that cannot answer are the same thing as no exact terrain, and say which it was.
  const degenerate = waterSurfacePlan({ level: -6, poly: [[0, 0], [1, 1]] }, {
    relief: 2, lift: 0.08, canonicalGroundAt, displayGroundAt,
  });
  assert.equal(degenerate.mode, WATER_SURFACE_SEATING.PUBLIC_LEVEL);
  assert.equal(degenerate.reason, 'insufficient-shoreline-samples');
  assert.equal(
    waterSurfacePlan(WATER_ROW, { relief: 2, lift: 0.08, canonicalGroundAt, displayGroundAt: () => NaN }).reason,
    'shoreline-anchor-has-no-display-height',
  );
});

// -----------------------------------------------------------------------------------------------
// The boundary. Production must keep exactly the bridges `customs-3d.json` ships.
// -----------------------------------------------------------------------------------------------

test('production cannot load local game-derived assets, so its bridge set is the public one', async () => {
  for (const host of ['tarkovzero.com', 'tarkovzero.vercel.app', '10.0.0.4', 'localhost.evil.test']) {
    assert.equal(canLoadLocalGameDerivedAssets({ dev: false, hostname: host }), false, host);
    assert.equal(canLoadLocalGameDerivedAssets({ dev: true, hostname: host }), false, host);
  }
  const data = JSON.parse(await readFile(CUSTOMS_3D, 'utf8'));
  assert.deepEqual(data.bridges.map((bridge) => bridge.name), ['Main Bridge', 'River path', 'Junk Bridge']);
  // No local record's identity, and no canonical-Y seat, may exist in the shipped artifact.
  for (const bridge of data.bridges) {
    assert.equal(bridge.deckCanonicalYM, undefined, bridge.name);
    assert.ok(!/span \d of \d|Railway Underbridge|Old Gas Railway/.test(bridge.name), bridge.name);
  }
});

test('the loader refuses a production origin before it reaches the network', async () => {
  let fetches = 0;
  const fetchImplementation = async () => {
    fetches += 1;
    return { ok: true, json: async () => PACKAGE_VALUE };
  };
  // Layer 2: even handed a fetch that WOULD succeed, a non-loopback page origin is refused here,
  // independently of `renderer-gate.js`.
  await assert.rejects(
    loadCustomsLocalBridgesPackage({ fetch: fetchImplementation, location: 'https://tarkovzero.com/?renderer=three' }),
    /disabled outside localhost/,
  );
  assert.equal(fetches, 0);
  const loaded = await loadCustomsLocalBridgesPackage({
    fetch: fetchImplementation,
    location: 'http://localhost:5173/?renderer=three',
  });
  assert.equal(fetches, 1);
  assert.equal(loaded.bridges.length, 3);
});

test("a dev route that answers 200 with Vite's SPA fallback is not a package", async () => {
  await assert.rejects(
    loadCustomsLocalBridgesPackage({
      fetch: async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } }),
      location: 'http://127.0.0.1:5173/',
    }),
    /not valid JSON/,
  );
});

test('the generator is git-tracked and therefore holds no game coordinate it emits', async () => {
  const source = await readFile(GENERATOR, 'utf8');
  const emitted = new Set();
  for (const bridge of PACKAGE_VALUE.bridges) {
    for (const [x, z] of bridge.path) { emitted.add(x); emitted.add(z); }
  }
  // Real emitted values are three-decimal metres. Any such literal in the tracked source would be a
  // coordinate that escaped the gitignored package.
  const literals = source.match(/-?\d+\.\d{3,}/g) ?? [];
  assert.deepEqual(literals, [], `tracked generator holds coordinate-shaped literals: ${literals.join(', ')}`);
  assert.ok(emitted.size > 0);
});

// -----------------------------------------------------------------------------------------------
// The dev-only route. The package is its own authorization document.
// -----------------------------------------------------------------------------------------------

async function routeFixture(packageValue) {
  const root = await mkdtemp(join(tmpdir(), 'tz-local-bridges-'));
  const packageRoot = join(root, LOCAL_GAME_DERIVED_DIRNAME);
  await mkdir(join(packageRoot, 'customs'), { recursive: true });
  await writeFile(join(packageRoot, 'customs', 'bridges.json'), JSON.stringify(packageValue));
  await writeFile(join(packageRoot, 'customs', 'bridges-notes.json'), '{"sibling":true}');
  return { root, packageRoot };
}

async function call(middleware, url, { remoteAddress = '127.0.0.1', host = 'localhost:5173' } = {}) {
  const state = { statusCode: 200, headers: new Map(), body: null, next: 0 };
  const res = {
    get statusCode() { return state.statusCode; },
    set statusCode(value) { state.statusCode = value; },
    setHeader(name, value) { state.headers.set(name.toLowerCase(), String(value)); },
    end(body) { state.body = body ?? null; },
  };
  await middleware({ method: 'GET', url, headers: { host }, socket: { remoteAddress } }, res, () => { state.next += 1; });
  return state;
}

test('the route serves the bridge package only while it satisfies its own contract', async (t) => {
  const { root, packageRoot } = await routeFixture(PACKAGE_VALUE);
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = createLocalGameDerivedMiddleware(packageRoot);
  const route = `${LOCAL_GAME_DERIVED_ROUTE}${CUSTOMS_LOCAL_BRIDGES_SEGMENTS.join('/')}`;

  const served = await call(middleware, route);
  assert.equal(served.statusCode, 200);
  assert.equal(JSON.parse(served.body.toString('utf8')).bridges.length, 3);
  assert.equal(served.headers.get('cache-control'), 'no-store');

  // A sibling .json in the same directory shares the suffix and is still unreachable.
  const sibling = await call(middleware, `${LOCAL_GAME_DERIVED_ROUTE}customs/bridges-notes.json`);
  assert.equal(sibling.statusCode, 404);

  // Non-loopback callers never reach authorization at all.
  assert.equal((await call(middleware, route, { remoteAddress: '203.0.113.7' })).statusCode, 403);
  assert.equal((await call(middleware, route, { host: 'tarkovzero.com' })).statusCode, 403);
});

test('an invalid bridge package authorizes nothing, including itself', async (t) => {
  const broken = structuredClone(PACKAGE_VALUE);
  broken.bridges[0].dimensions.width.status = 'measured-mesh-bounds';
  const { root, packageRoot } = await routeFixture(broken);
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = createLocalGameDerivedMiddleware(packageRoot);
  const served = await call(
    middleware,
    `${LOCAL_GAME_DERIVED_ROUTE}${CUSTOMS_LOCAL_BRIDGES_SEGMENTS.join('/')}`,
  );
  assert.equal(served.statusCode, 404);
});
