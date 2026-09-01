/**
 * What the authored-vegetation hybrid is degraded BY, and what that degradation cost.
 *
 * `renderStats().vegetation.warnings` carries one promise: an empty array means the authored path is
 * fully live. That promise was false. The first version of this collector only knew two defects —
 * a texture-array load that failed and a `materialMode` that disagreed with it — and both of them
 * read fields off a LIVE runtime. So the one state where everything is wrong, the pack failing to
 * mount at all, skipped both branches and published `warnings: []`: measured in a GLB-404 run as
 * `mode: 'procedural'`, the whole pack gone, and the field whose contract says "nothing quietly fell
 * back" saying exactly that. A field that reports "healthy" hardest when the subject is dead is
 * worse than no field, because it is the one a reader trusts.
 *
 * So the states are enumerated here, deliberately and exhaustively, rather than discovered one
 * incident at a time:
 *
 *   1. the view was disposed — the runtime and its textures are released;
 *   2. there is no exact local vegetation plan, so the authored pack was never routed;
 *   3. `?vegetation=procedural` suppressed the mount by request;
 *   4. the mount is still in flight — procedural proxies are on screen until it swaps;
 *   5. the mount failed or timed out ENTIRELY — the defect above;
 *   6. `mode: 'authored'` with no live runtime — an inconsistency, not a health;
 *   7. the pack mounted but covers only part of the placements (a partial admission);
 *   8. the texture arrays failed while the authored pack mounted;
 *   9. `materialMode` is the per-primitive fallback;
 *  10. draw calls exceed live buckets under the shared array material;
 *  11. the placement conservation sum does not balance.
 *
 * The placement accounting lives here too, for the same reason. `accountedPlacements` used to be a
 * bare sum of four terms with `?? 0` on each, which is correct only while every term is knowable:
 * after `dispose()` the authored half's two terms are gone and the sum quietly collapsed from 8,805
 * to 1,697 — a wrong number, presented exactly like a right one. A term that cannot be read is
 * `null` with a stated reason, never zero.
 *
 * Everything here is a pure function of a plain snapshot: no THREE objects, no DOM, no clock.
 */

/** The one material mode that means the 199 -> 3 collapse actually ran. */
export const VEGETATION_SHARED_MATERIAL_MODE = 'shared-array-texture';

/** Every code this module can emit. Frozen so a test can pin the enumeration itself. */
export const VEGETATION_DEGRADATION_CODES = Object.freeze([
  'runtime-disposed',
  'no-authored-plan',
  'authored-disabled-by-query',
  'mount-in-flight',
  'mount-failed',
  'authored-runtime-missing',
  'partial-pack',
  'array-textures-unavailable',
  'material-mode-fallback',
  'draw-calls-above-buckets',
  'placement-accounting-broken',
]);

/** Mount phases that mean the load is still working rather than finished. */
const IN_FLIGHT_PHASES = new Set([null, 'pending', 'loading', 'assembling']);

const int = (value, fallback = null) => {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
};

const text = (value) => {
  if (value === null || value === undefined) return null;
  const string = String(value);
  return string === '' ? null : string;
};

/**
 * Add up the placements the hybrid is holding, or say why the sum cannot be taken.
 *
 * The conservation law is: authored (drawn + frustum-rejected) + procedural + out-of-scope ===
 * the declared source count. It holds while the authored half can be read. It cannot be read after
 * a dispose, or in the inconsistent state where the status claims `authored` and no runtime exists,
 * and in both of those `placements` is null with `unavailable` naming the reason — the field is
 * explicitly missing rather than silently short.
 *
 * A mount that never ran, or failed, is NOT unavailable: the authored half legitimately holds zero
 * and the procedural plan still owns every rendered placement, so the sum balances at the declared
 * count. That is the difference between "nothing was taken" and "what was taken cannot be counted".
 */
export function vegetationPlacementAccounting({
  runtime = null,
  disposed = false,
  mode = 'procedural',
  proceduralPlacements = 0,
  declaredInstances = null,
  culledOutsideScope = null,
} = {}) {
  const procedural = int(proceduralPlacements, 0);
  const culled = int(culledOutsideScope, 0);
  const expected = int(declaredInstances, null);

  let unavailable = null;
  let authoredVisible = null;
  let authoredFrustumCulled = null;
  if (disposed) {
    unavailable = 'runtime-disposed';
  } else if (runtime) {
    authoredVisible = int(runtime.visibleInstances, 0);
    authoredFrustumCulled = int(runtime.frustumCulledInstances, 0);
  } else if (mode === 'authored') {
    // The status says the authored half owns placements and there is nothing to ask how many.
    unavailable = 'authored-runtime-absent';
  } else {
    authoredVisible = 0;
    authoredFrustumCulled = 0;
  }

  const placements = unavailable
    ? null
    : authoredVisible + authoredFrustumCulled + procedural + culled;
  const balanced = placements === null || expected === null ? null : placements === expected;

  return Object.freeze({
    placements,
    unavailable,
    expected,
    balanced,
    parts: Object.freeze({
      authoredVisible,
      authoredFrustumCulled,
      procedural,
      culledOutsideScope: culled,
    }),
  });
}

/**
 * Every way the vegetation can be running and wrong at the same time, each named with its cost.
 *
 * @param {object} snapshot Flat, plain-data view of `vegetationStatus` plus the two plans.
 * @returns {ReadonlyArray<{code: string, message: string}>}
 */
export function vegetationDegradations({
  mode = 'procedural',
  request = null,
  reason = null,
  error = null,
  disposed = false,
  hasAuthoredPlan = true,
  mount = null,
  routing = null,
  runtime = null,
  arrayTextures = null,
  arrayTextureFailure = null,
  accounting = null,
  proceduralPlacements = 0,
  declaredInstances = null,
  culledOutsideScope = null,
} = {}) {
  const sums = accounting ?? vegetationPlacementAccounting({
    runtime, disposed, mode, proceduralPlacements, declaredInstances, culledOutsideScope,
  });
  const found = [];
  const push = (code, message) => { found.push(Object.freeze({ code, message })); };

  const procedural = sums.parts.procedural;
  const declared = sums.expected;
  const routedAuthored = int(routing?.authored, null);
  const routedProcedural = int(routing?.procedural, null);
  const routedSource = int(routing?.source, null) ?? declared;
  const phase = text(mount?.phase);
  const why = text(reason);
  const detail = text(error);

  if (disposed) {
    push(
      'runtime-disposed',
      'the 3D view was disposed: the authored vegetation runtime and its texture arrays are'
      + ' released, so nothing authored is drawn and the authored half of the'
      + ` ${routedAuthored ?? declared ?? 'declared'} placements can no longer be counted`
      + ' (accountedPlacements is null, not a short sum)',
    );
  } else if (!hasAuthoredPlan) {
    push(
      'no-authored-plan',
      `no exact local vegetation plan is loaded (${why ?? 'no-exact-vegetation-plan'}), so the`
      + ' authored pack was never routed: every tree on screen is a procedural proxy and the'
      + ' authored geometry, texture arrays and (family, LOD) batching are all absent',
    );
  } else if (request === 'procedural') {
    push(
      'authored-disabled-by-query',
      '?vegetation=procedural suppressed the authored mount by request:'
      + ` ${procedural} placements are drawn as procedural proxies, none as authored GLBs`,
    );
  } else if (mode !== 'authored') {
    if (IN_FLIGHT_PHASES.has(phase)) {
      const loaded = int(mount?.loaded, 0);
      const expectedGlbs = int(mount?.expected, null);
      push(
        'mount-in-flight',
        `the authored vegetation mount has not swapped in yet (${phase ?? why ?? 'pending'},`
        + ` ${loaded}/${expectedGlbs ?? '?'} GLBs, ${int(mount?.elapsedMs, 0)} ms elapsed,`
        + ` ${int(mount?.sinceProgressMs, 0)} ms since the last one):`
        + ` ${procedural} placements are drawn as procedural proxies until it does`,
      );
    } else {
      push(
        'mount-failed',
        `the authored vegetation pack did not mount (${why ?? phase ?? 'unknown'}`
        + `${detail ? `: ${detail}` : ''}): the ENTIRE pack is absent — 0 of`
        + ` ${routedSource ?? procedural} placements are authored, all ${procedural} are drawn as`
        + ' procedural proxies, and neither the shared texture arrays nor the (family, LOD)'
        + ' instanced batching are on screen',
      );
    }
  } else if (!runtime) {
    push(
      'authored-runtime-missing',
      'status reports mode "authored" with no live runtime: the swap either never completed or the'
      + ' runtime was released underneath it, so nothing authored can be measured and the'
      + ' placement accounting is unavailable',
    );
  }

  if (mode === 'authored' && routedProcedural !== null && routedProcedural > 0) {
    push(
      'partial-pack',
      `the authored pack covers only ${routedAuthored ?? '?'} of ${routedSource ?? '?'} placements:`
      + ` ${routedProcedural} fell back to procedural proxies because their families are not in the`
      + ' pack, so those trees keep the proxy geometry and its per-batch draw calls',
    );
  }

  if (arrayTextureFailure) {
    const failure = arrayTextureFailure;
    push(
      'array-textures-unavailable',
      `texture arrays unavailable (${text(failure.reason) ?? 'unknown'}) from`
      + ` ${text(failure.url) ?? 'the array route'}: ${text(failure.consequence) ?? 'the shared array material did not build'}`,
    );
  }

  if (runtime && runtime.materialMode !== VEGETATION_SHARED_MATERIAL_MODE) {
    push(
      'material-mode-fallback',
      `materialMode is "${runtime.materialMode}", not "${VEGETATION_SHARED_MATERIAL_MODE}": the pack`
      + ` is drawing ${runtime.drawCalls} calls for ${runtime.liveBuckets} live buckets instead of`
      + ' one per bucket',
    );
  }

  if (runtime && arrayTextures && runtime.materialMode === VEGETATION_SHARED_MATERIAL_MODE
    && runtime.drawCalls !== runtime.liveBuckets) {
    push(
      'draw-calls-above-buckets',
      `drawCalls ${runtime.drawCalls} != liveBuckets ${runtime.liveBuckets} under the shared array`
      + ' material, which should collapse every bucket to exactly one call',
    );
  }

  if (sums.balanced === false) {
    push(
      'placement-accounting-broken',
      `accountedPlacements ${sums.placements} does not equal the declared ${sums.expected}:`
      + ` authored ${sums.parts.authoredVisible} drawn + ${sums.parts.authoredFrustumCulled}`
      + ` frustum-rejected, procedural ${sums.parts.procedural}, out of scope`
      + ` ${sums.parts.culledOutsideScope} — a placement is lost or drawn twice`,
    );
  }

  return Object.freeze(found);
}

/**
 * The whole observability answer for one `renderStats()` call.
 *
 * `warnings` stays an array of strings — that is the field readers already know — and `degradations`
 * carries the same list with a stable code beside each message, so a test can name a state without
 * matching prose.
 */
export function describeVegetationObservability(snapshot = {}) {
  const accounting = vegetationPlacementAccounting(snapshot);
  const degradations = vegetationDegradations({ ...snapshot, accounting });
  return Object.freeze({
    accounting,
    accountedPlacements: accounting.placements,
    degradations,
    warnings: Object.freeze(degradations.map((entry) => entry.message)),
  });
}
