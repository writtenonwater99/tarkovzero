// The honesty contract of `renderStats().vegetation.warnings` and `.accountedPlacements`.
//
// Both fields exist to be trusted at a glance, and both used to lie in exactly the states a reader
// reaches for them:
//
//   * an independent reviewer measured a GLB-404 run in a live browser — the authored pack failed to
//     mount ENTIRELY, `mode: 'procedural'`, the whole forest gone — and `warnings` was `[]`. The old
//     collector knew two defects and both read fields off a LIVE runtime, so the one state where the
//     runtime does not exist skipped every branch and published the healthy answer;
//   * after `dispose()`, `accountedPlacements` collapsed from 8,805 to 1,697, because the sum was
//     four terms with `?? 0` on each and two of them had just been released.
//
// So the states are enumerated here, and the LAST test in this file is the contract itself: every
// enumerated degraded state produces a non-empty `warnings`, and only the fully-live one is empty.
// The numbers are the shipped Customs ones (8,805 declared / 7,108 in scope / 1,697 out of scope).

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VEGETATION_DEGRADATION_CODES,
  describeVegetationObservability,
  vegetationPlacementAccounting,
} from '../src/customs-vegetation-observability.js';

const DECLARED = 8805;
const CULLED_OUTSIDE_SCOPE = 1697;
const IN_SCOPE = DECLARED - CULLED_OUTSIDE_SCOPE;
const VISIBLE = 4586;
const FRUSTUM_CULLED = IN_SCOPE - VISIBLE;

/** The runtime status a healthy, array-textured mount publishes. */
function liveRuntime(overrides = {}) {
  return {
    materialMode: 'shared-array-texture',
    drawCalls: 31,
    liveBuckets: 31,
    visibleInstances: VISIBLE,
    frustumCulledInstances: FRUSTUM_CULLED,
    ...overrides,
  };
}

/** The whole hybrid, fully live: the state — and the only state — that warns about nothing. */
function healthy(overrides = {}) {
  return {
    mode: 'authored',
    request: null,
    reason: null,
    error: null,
    disposed: false,
    hasAuthoredPlan: true,
    mount: { phase: 'mounted', loaded: 93, expected: 93, elapsedMs: 71_400, sinceProgressMs: 120 },
    routing: { authored: IN_SCOPE, procedural: 0, rendered: IN_SCOPE, culled: CULLED_OUTSIDE_SCOPE, source: DECLARED },
    runtime: liveRuntime(),
    arrayTextures: { layers: 199, materials: 3, textures: 9, uploadBytes: 20_213_760 },
    arrayTextureFailure: null,
    proceduralPlacements: 0,
    declaredInstances: DECLARED,
    culledOutsideScope: CULLED_OUTSIDE_SCOPE,
    ...overrides,
  };
}

/**
 * The GLB-404 run, exactly as the reviewer measured it: the pack index or its assets never arrive,
 * nothing is swapped in, and the procedural plan is still the whole in-scope set.
 */
function totalMountFailure(overrides = {}) {
  return healthy({
    mode: 'procedural',
    reason: 'ERR_CUSTOMS_GLB_HTTP',
    error: 'authored vegetation GLB HTTP 404 from /@vegetation-authored/pine01/lod0.glb',
    mount: { phase: 'failed', loaded: 0, expected: 93, elapsedMs: 2_140, sinceProgressMs: 2_140 },
    routing: null,
    runtime: null,
    arrayTextures: null,
    proceduralPlacements: IN_SCOPE,
    ...overrides,
  });
}

const codesOf = (result) => result.degradations.map((entry) => entry.code);
const messageFor = (result, code) => {
  const entry = result.degradations.find((item) => item.code === code);
  assert.ok(entry, `expected a "${code}" degradation, got ${JSON.stringify(codesOf(result))}`);
  return entry.message;
};

test('a fully live authored path is the one state that warns about nothing', () => {
  const result = describeVegetationObservability(healthy());
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.degradations, []);
  assert.equal(result.accountedPlacements, DECLARED);
  assert.equal(result.accounting.balanced, true);
  assert.equal(result.accounting.unavailable, null);
});

test('a pack that fails to mount ENTIRELY warns, and says the whole pack is gone', () => {
  // The measured defect. `warnings: []` here is the bug; anything less than a named cause and a
  // stated cost is the same bug with more characters.
  const result = describeVegetationObservability(totalMountFailure());
  assert.ok(result.warnings.length > 0, 'a total mount failure must not publish an empty warnings array');
  assert.deepEqual(codesOf(result), ['mount-failed']);
  const message = messageFor(result, 'mount-failed');
  assert.match(message, /ERR_CUSTOMS_GLB_HTTP/, 'the reason must be named');
  assert.match(message, /lod0\.glb/, 'the underlying error must be carried, not swallowed');
  assert.match(message, new RegExp(`0 of ${DECLARED}`), 'the cost must be stated as placements lost to the fallback');
  assert.match(message, new RegExp(`all ${IN_SCOPE} are drawn as procedural proxies`));
  assert.equal(result.warnings[0], message);
});

test('a mount that failed still balances its placement sum: nothing was taken, so nothing is missing', () => {
  const result = describeVegetationObservability(totalMountFailure());
  assert.equal(result.accountedPlacements, DECLARED);
  assert.equal(result.accounting.balanced, true);
  assert.equal(result.accounting.unavailable, null);
  assert.deepEqual(result.accounting.parts, {
    authoredVisible: 0,
    authoredFrustumCulled: 0,
    procedural: IN_SCOPE,
    culledOutsideScope: CULLED_OUTSIDE_SCOPE,
  });
});

test('a mount still in flight is a degradation, not a health', () => {
  const result = describeVegetationObservability(totalMountFailure({
    reason: 'loading-assets',
    error: null,
    mount: { phase: 'loading', loaded: 41, expected: 93, elapsedMs: 38_200, sinceProgressMs: 640 },
  }));
  assert.deepEqual(codesOf(result), ['mount-in-flight']);
  const message = messageFor(result, 'mount-in-flight');
  assert.match(message, /41\/93 GLBs/);
  assert.match(message, /38200 ms elapsed/);
  assert.match(message, new RegExp(`${IN_SCOPE} placements are drawn as procedural proxies`));
});

test('a mount that timed out reports the deadline that fired, not silence', () => {
  const result = describeVegetationObservability(totalMountFailure({
    reason: 'mount-load-stalled',
    error: 'authored vegetation mount mount-load-stalled: 41/93 GLBs after 131400 ms',
    mount: { phase: 'timed-out', loaded: 41, expected: 93, elapsedMs: 131_400, sinceProgressMs: 90_100 },
  }));
  assert.deepEqual(codesOf(result), ['mount-failed']);
  assert.match(messageFor(result, 'mount-failed'), /mount-load-stalled/);
});

test('texture arrays that failed while the pack mounted name the file that failed and its cost', () => {
  // The blob case: `veg-l1-normal.bin` is dead, `veg-layers.json` is provably fine, and the warning
  // must send the reader to the former.
  const result = describeVegetationObservability(healthy({
    arrayTextures: null,
    arrayTextureFailure: {
      url: '/@vegetation-arraytex/veg-l1-normal.bin',
      indexUrl: '/@vegetation-arraytex/veg-layers.json',
      stage: 'blob',
      file: 'veg-l1-normal.bin',
      lod: 1,
      slot: 'normal',
      reason: 'ERR_CUSTOMS_VEGETATION_TEXTURE_ARRAY_HTTP',
      consequence:
        'materialMode falls back to authored-per-primitive; the 199 -> 3 material collapse did not run',
    },
    runtime: liveRuntime({ materialMode: 'authored-per-primitive', drawCalls: 199, liveBuckets: 31 }),
  }));
  assert.deepEqual(codesOf(result), ['array-textures-unavailable', 'material-mode-fallback']);
  const arrays = messageFor(result, 'array-textures-unavailable');
  assert.match(arrays, /veg-l1-normal\.bin/);
  assert.doesNotMatch(arrays, /veg-layers\.json/, 'the index is not what failed');
  assert.match(arrays, /199 -> 3 material collapse did not run/);
  assert.match(messageFor(result, 'material-mode-fallback'), /199 calls for 31 live buckets/);
});

test('a materialMode mismatch warns even with no recorded array failure', () => {
  const result = describeVegetationObservability(healthy({
    arrayTextures: null,
    runtime: liveRuntime({ materialMode: 'authored-per-primitive', drawCalls: 199, liveBuckets: 31 }),
  }));
  assert.deepEqual(codesOf(result), ['material-mode-fallback']);
});

test('draw calls above live buckets under the shared material still warn', () => {
  const result = describeVegetationObservability(healthy({
    runtime: liveRuntime({ drawCalls: 57, liveBuckets: 31 }),
  }));
  assert.deepEqual(codesOf(result), ['draw-calls-above-buckets']);
  assert.match(messageFor(result, 'draw-calls-above-buckets'), /57 != liveBuckets 31/);
});

test('a partial pack warns with the placements that fell back', () => {
  const authored = 5411;
  const procedural = IN_SCOPE - authored;
  const result = describeVegetationObservability(healthy({
    routing: { authored, procedural, rendered: IN_SCOPE, culled: CULLED_OUTSIDE_SCOPE, source: DECLARED },
    runtime: liveRuntime({ visibleInstances: 3500, frustumCulledInstances: authored - 3500 }),
    proceduralPlacements: procedural,
  }));
  assert.deepEqual(codesOf(result), ['partial-pack']);
  const message = messageFor(result, 'partial-pack');
  assert.match(message, new RegExp(`only ${authored} of ${DECLARED}`));
  assert.match(message, new RegExp(`${procedural} fell back to procedural proxies`));
  // The partition is still total, so the sum must still balance.
  assert.equal(result.accountedPlacements, DECLARED);
  assert.equal(result.accounting.balanced, true);
});

test('an absent vegetation package warns instead of reading as a clean procedural map', () => {
  const result = describeVegetationObservability(totalMountFailure({
    hasAuthoredPlan: false,
    reason: 'no-exact-vegetation-plan',
    error: null,
    mount: null,
    proceduralPlacements: 0,
    declaredInstances: null,
    culledOutsideScope: null,
  }));
  assert.deepEqual(codesOf(result), ['no-authored-plan']);
  assert.match(messageFor(result, 'no-authored-plan'), /no-exact-vegetation-plan/);
});

test('?vegetation=procedural is a suppressed authored path, and says so', () => {
  const result = describeVegetationObservability(totalMountFailure({
    request: 'procedural',
    reason: 'disabled-by-query',
    error: null,
    mount: null,
  }));
  assert.deepEqual(codesOf(result), ['authored-disabled-by-query']);
  assert.match(messageFor(result, 'authored-disabled-by-query'), new RegExp(`${IN_SCOPE} placements`));
});

test('a disposed view reports a released runtime and an UNAVAILABLE placement sum, not 1,697', () => {
  // The measured second defect: `mode` is still 'authored', the runtime and arrays are released,
  // and the old four-term sum with `?? 0` on each published 1,697 as though it were the answer.
  const result = describeVegetationObservability(healthy({ disposed: true, runtime: null }));
  assert.deepEqual(codesOf(result), ['runtime-disposed']);
  assert.equal(result.accountedPlacements, null);
  assert.notEqual(result.accountedPlacements, CULLED_OUTSIDE_SCOPE);
  assert.equal(result.accounting.unavailable, 'runtime-disposed');
  assert.equal(result.accounting.balanced, null, 'an unavailable sum cannot be balanced or unbalanced');
  assert.deepEqual(result.accounting.parts, {
    authoredVisible: null,
    authoredFrustumCulled: null,
    procedural: 0,
    culledOutsideScope: CULLED_OUTSIDE_SCOPE,
  });
});

test('a disposed view whose procedural half is populated is still unavailable, not a plausible sum', () => {
  // The trap: with a partial pack the released terms would leave a number that looks reasonable.
  const result = describeVegetationObservability(healthy({
    disposed: true,
    runtime: null,
    proceduralPlacements: 2_000,
  }));
  assert.equal(result.accountedPlacements, null);
  assert.equal(result.accounting.unavailable, 'runtime-disposed');
});

test('mode "authored" with no runtime is an inconsistency, and is reported as one', () => {
  const result = describeVegetationObservability(healthy({ runtime: null }));
  assert.deepEqual(codesOf(result), ['authored-runtime-missing']);
  assert.equal(result.accountedPlacements, null);
  assert.equal(result.accounting.unavailable, 'authored-runtime-absent');
});

test('a placement sum that does not balance warns with every term', () => {
  const result = describeVegetationObservability(healthy({
    runtime: liveRuntime({ frustumCulledInstances: FRUSTUM_CULLED - 12 }),
  }));
  assert.deepEqual(codesOf(result), ['placement-accounting-broken']);
  const message = messageFor(result, 'placement-accounting-broken');
  assert.match(message, new RegExp(`${DECLARED - 12} does not equal the declared ${DECLARED}`));
  assert.match(message, /lost or drawn twice/);
  assert.equal(result.accounting.balanced, false);
});

test('several degradations at once are all reported, most severe first', () => {
  const result = describeVegetationObservability(totalMountFailure({
    arrayTextureFailure: {
      url: '/@vegetation-arraytex/veg-layers.json',
      reason: 'ERR_CUSTOMS_VEGETATION_TEXTURE_ARRAY_HTTP',
      consequence: 'materialMode falls back to authored-per-primitive',
    },
  }));
  assert.deepEqual(codesOf(result), ['mount-failed', 'array-textures-unavailable']);
  assert.equal(result.warnings.length, 2);
});

test('the accounting helper never reports zero for a term it cannot read', () => {
  for (const state of [
    { disposed: true, mode: 'authored', runtime: null },
    { disposed: true, mode: 'procedural', runtime: null },
    { disposed: false, mode: 'authored', runtime: null },
  ]) {
    const sums = vegetationPlacementAccounting({
      ...state,
      proceduralPlacements: 0,
      declaredInstances: DECLARED,
      culledOutsideScope: CULLED_OUTSIDE_SCOPE,
    });
    assert.equal(sums.placements, null, JSON.stringify(state));
    assert.ok(sums.unavailable, 'an unreadable sum must say why');
    assert.equal(sums.parts.authoredVisible, null);
    assert.equal(sums.parts.authoredFrustumCulled, null);
  }
});

test('THE CONTRACT: empty warnings means, and only means, the authored path is fully live', () => {
  // Every enumerated degraded state, in one table. Any state added to the runtime that is not
  // represented here is a state whose honesty nothing checks.
  const degraded = {
    'runtime-disposed': healthy({ disposed: true, runtime: null }),
    'no-authored-plan': totalMountFailure({ hasAuthoredPlan: false, reason: 'no-exact-vegetation-plan', mount: null }),
    'authored-disabled-by-query': totalMountFailure({ request: 'procedural', reason: 'disabled-by-query', mount: null }),
    'mount-in-flight': totalMountFailure({ mount: { phase: 'loading', loaded: 41, expected: 93 } }),
    'mount-failed': totalMountFailure(),
    'authored-runtime-missing': healthy({ runtime: null }),
    'partial-pack': healthy({
      routing: { authored: 5411, procedural: 1697, rendered: IN_SCOPE, culled: CULLED_OUTSIDE_SCOPE, source: DECLARED },
      runtime: liveRuntime({ visibleInstances: 3500, frustumCulledInstances: 1911 }),
      proceduralPlacements: 1697,
    }),
    'array-textures-unavailable': healthy({
      arrayTextures: null,
      arrayTextureFailure: { url: '/@vegetation-arraytex/veg-l0-orm.bin', reason: 'ERR_HTTP', consequence: 'no collapse' },
    }),
    'material-mode-fallback': healthy({
      arrayTextures: null,
      runtime: liveRuntime({ materialMode: 'authored-per-primitive', drawCalls: 199 }),
    }),
    'draw-calls-above-buckets': healthy({ runtime: liveRuntime({ drawCalls: 57 }) }),
    'placement-accounting-broken': healthy({ runtime: liveRuntime({ visibleInstances: VISIBLE - 3 }) }),
  };

  assert.deepEqual(
    Object.keys(degraded).sort(),
    [...VEGETATION_DEGRADATION_CODES].sort(),
    'every declared degradation code must have a state that produces it',
  );

  for (const [code, snapshot] of Object.entries(degraded)) {
    const result = describeVegetationObservability(snapshot);
    assert.ok(result.warnings.length > 0, `${code}: warnings must not be empty in a degraded state`);
    assert.ok(codesOf(result).includes(code), `${code}: expected in ${JSON.stringify(codesOf(result))}`);
    for (const entry of result.degradations) {
      assert.ok(VEGETATION_DEGRADATION_CODES.includes(entry.code), `unknown code ${entry.code}`);
      assert.ok(entry.message.length > 40, `${entry.code}: a warning must name the cost, not just the fault`);
    }
    assert.deepEqual(result.warnings, result.degradations.map((entry) => entry.message));
  }

  assert.deepEqual(describeVegetationObservability(healthy()).warnings, []);
});
