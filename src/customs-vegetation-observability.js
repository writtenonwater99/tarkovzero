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
 *  2b. the same absent plan on a RELEASE build — which since the 2026-09-02 vegetation promotion is
 *      a DEFECT rather than the design: the pack ships from `public/assets/3d/customs/authored/
 *      vegetation/`, so a release frame without it means the promoted package did not load;
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
  'promoted-vegetation-missing',
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
  // Whether local game-derived data was ALLOWED to load at all (`canLoadLocalGameDerivedAssets()`).
  //
  // Until 2026-09-02 this decided whether an authored plan was even EXPECTED: the 8,805 placements
  // were reachable only through the loopback route, so a release build had none by construction and
  // saying so calmly was the honest thing to do. The pack is promoted now — placements, geometry
  // and texture arrays all ship — so a release build without a plan is a failed load, and this
  // input no longer separates "designed" from "broken". It separates WHICH LOADER was asked, and
  // therefore which of `no-authored-plan` and `promoted-vegetation-missing` names the failure.
  // Both are defects; they differ only in where to go looking.
  localEnhancements = true,
  // Which vegetation package supplied the placements: `'promoted-public'`, `'local-package'`, or
  // null when none did. Named in the mount-failure message so a reader is told which package to
  // check rather than left to infer it from the environment.
  vegetationDistribution = null,
  // Which terrain package the ground is drawn from: `'promoted-public'`, `'local-package'`, or
  // null when the exact ground is not on screen at all.
  //
  // This exists because the release notice used to be one sentence about "local game-derived
  // data", and by 2026-09-02 that sentence was not true of either half. The terrain height and
  // control surfaces were promoted first, and the authored vegetation the same day; production now
  // draws the exact ground AND the authored forest. A notice that describes the whole frame with
  // one clause misdescribes it whenever the two subsystems disagree, which is precisely the failure
  // mode handoff §6 is about. The message below states them separately, always.
  terrainDistribution = null,
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
  } else if (!hasAuthoredPlan && localEnhancements === false) {
    // Per SUBSYSTEM, because the two can fail independently and a single sentence about "the
    // release build" would describe neither.
    const ground = terrainDistribution === 'promoted-public'
      ? 'the terrain IS exact here: the height and control surfaces were promoted and ship from '
        + '/assets/3d/customs/terrain/, so this is the same ground the local build draws'
      : terrainDistribution === 'local-package'
        ? 'the terrain is the exact local package'
        : 'the terrain is the public heightfield from /data/customs-3d.json, NOT the exact surfaces '
          + '— the promoted package did not load, which is a defect, not the shipped configuration';
    push(
      'promoted-vegetation-missing',
      `this is a release build, and BOTH subsystems are promoted here. GROUND: ${ground}.`
      + ' VEGETATION: the authored pack IS promoted — 31 families, their shared texture arrays and'
      + ' the 8,805-row placement table all ship from /assets/3d/customs/authored/vegetation/ — but'
      + ` this frame has no placements to route (${why ?? 'promoted-vegetation-unavailable'}), so`
      + ` every tree on screen stands on a public tree position from /data/customs-3d.json —`
      + ` ${procedural} of them — drawn as a procedural proxy. That is a FAILED LOAD, not the`
      + ' shipped configuration: production is supposed to draw the authored forest',
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
      const which = vegetationDistribution === 'promoted-public'
        ? ' the promoted pack under /assets/3d/customs/authored/vegetation/'
        : vegetationDistribution === 'local-package'
          ? ' the local pack under /@vegetation-authored/'
          : '';
      push(
        'mount-failed',
        `the authored vegetation pack did not mount (${why ?? phase ?? 'unknown'}`
        + `${detail ? `: ${detail}` : ''}): the ENTIRE pack is absent — 0 of`
        + ` ${routedSource ?? procedural} placements are authored, all ${procedural} are drawn as`
        + ' procedural proxies, and neither the shared texture arrays nor the (family, LOD)'
        + ` instanced batching are on screen.${which ? ` Check${which}.` : ''}`,
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
 * The on-screen answer to "which forest is this", derived from `degradations` and nothing else.
 *
 * This exists because a 71.5 s authored mount (>12 min after a camera move) made it possible to open
 * the review URL, see A forest, and judge it — while the one on screen was the procedural fallback
 * that has been there since August. `renderStats().vegetation.warnings` already named that state
 * correctly; nothing surfaced it on screen, so the founder had to paste a console expression to find
 * out which forest he was looking at.
 *
 * The five mutually-exclusive codes below are the ones `vegetationDegradations` pushes from its one
 * if/else-if chain — a snapshot produces at most one of them — so finding one here IS finding the
 * reason nothing authored is confirmed live, never a choice among candidates. Everything past that
 * chain (`partial-pack`, the array/material/draw-call/accounting codes) can coexist WITH
 * `mode: 'authored'`, and is folded into `secondary`: authored of full pack (open, healthy) vs.
 * authored-but-degraded are different indicator states even though both have a live runtime.
 *
 * The load-bearing property, asserted in the test file: `healthy` here is `degradations.length === 0`
 * — the exact same emptiness `warnings` already reports — so the indicator can no more disagree with
 * `warnings` than a value can disagree with itself. There is no second read of the runtime anywhere
 * in this function.
 */
const PRIMARY_INDICATOR_CODES = new Set([
  'runtime-disposed',
  'no-authored-plan',
  'promoted-vegetation-missing',
  'authored-disabled-by-query',
  'mount-in-flight',
  'mount-failed',
  'authored-runtime-missing',
]);

/** `90000` -> `"1:30"`, `8400` -> `"8s"`. Never negative, never fractional. */
function formatClock(ms) {
  const totalSeconds = Math.max(0, Math.round(int(ms, 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, '0')}` : `${seconds}s`;
}

/** What step the loader is inside, for a mount whose GLB count is what actually moves. */
const MOUNT_STEP_LABEL = Object.freeze({
  'pack-index': 'fetching the pack index',
  'texture-arrays': 'loading shared texture arrays',
  assets: 'loading GLBs',
});

/**
 * "41 of 93 GLBs · loading GLBs · 38s elapsed — 12s since the last file" — real counts, not a
 * spinner. `mount` is read directly (not reconstructed from a warning's prose) because the mount-time
 * fields (`loaded`, `expected`, `elapsedMs`, `sinceProgressMs`, `step`) are already the exact snapshot
 * `vegetationDegradations` used to write the `mount-in-flight` message beside this one — same object,
 * two views of it.
 */
function formatMountProgress(mount) {
  const loaded = int(mount?.loaded, 0);
  const expected = int(mount?.expected, null);
  const since = int(mount?.sinceProgressMs, 0);
  const phase = text(mount?.phase);
  const stepLabel = MOUNT_STEP_LABEL[text(mount?.step)] ?? (phase === 'assembling' ? 'assembling' : 'loading');
  const count = expected !== null ? `${loaded} of ${expected} GLBs` : `${loaded} GLBs`;
  const stale = since >= 5000 ? ` — ${formatClock(since)} since the last file` : '';
  return `${count} · ${stepLabel} · ${formatClock(mount?.elapsedMs)} elapsed${stale}`;
}

/**
 * One frozen `{state, healthy, headline, detail, code}` for whatever `degradations` found.
 *
 * `state` is a small closed vocabulary a UI can key CSS/color off (`loading`, `procedural`,
 * `authored`, `authored-degraded`, `disposed`, `inconsistent`) — never free text, so a caller cannot
 * accidentally fork the wording between the on-screen chip and this function.
 */
function vegetationIndicatorFromDegradations({ mount, degradations }) {
  const primary = degradations.find((entry) => PRIMARY_INDICATOR_CODES.has(entry.code)) ?? null;
  if (primary) {
    switch (primary.code) {
      case 'mount-in-flight':
        return Object.freeze({
          state: 'loading', healthy: false, code: primary.code,
          headline: 'Loading authored vegetation…',
          detail: formatMountProgress(mount),
        });
      case 'runtime-disposed':
        return Object.freeze({
          state: 'disposed', healthy: false, code: primary.code,
          headline: 'Vegetation view disposed', detail: primary.message,
        });
      case 'authored-runtime-missing':
        return Object.freeze({
          state: 'inconsistent', healthy: false, code: primary.code,
          headline: 'Vegetation status inconsistent — reload', detail: primary.message,
        });
      case 'no-authored-plan':
        return Object.freeze({
          state: 'procedural', healthy: false, code: primary.code,
          headline: 'Procedural forest — no authored plan for this map', detail: primary.message,
        });
      case 'promoted-vegetation-missing':
        // The headline changed with the promotion, and the change is the point. It used to read
        // "public tree positions (release build)" — accurate then, because the pack was gated and a
        // release visitor was seeing exactly what shipped. The pack ships now, so the same words
        // would describe a broken frame as the design. `healthy: false` was already correct; what
        // was wrong was the calm.
        return Object.freeze({
          state: 'procedural', healthy: false, code: primary.code,
          headline: 'Procedural forest — the promoted vegetation pack did not load',
          detail: primary.message,
        });
      case 'authored-disabled-by-query':
        return Object.freeze({
          state: 'procedural', healthy: false, code: primary.code,
          headline: 'Procedural forest — disabled by ?vegetation=procedural', detail: primary.message,
        });
      default: // 'mount-failed'
        return Object.freeze({
          state: 'procedural', healthy: false, code: primary.code,
          headline: 'Procedural forest — authored pack failed to mount', detail: primary.message,
        });
    }
  }
  // No primary code fired: `vegetationDegradations`' if/else-if chain only reaches here when
  // `mode === 'authored'` AND a live runtime exists. What is left is whether anything in the
  // secondary set (partial pack, array textures, material fallback, draw calls, accounting) fired
  // alongside it — the difference between "fully live" and "live but degraded".
  const secondary = degradations; // every remaining entry, since primary is null
  if (secondary.length === 0) {
    return Object.freeze({
      state: 'authored', healthy: true, code: null,
      headline: 'Authored vegetation — live', detail: null,
    });
  }
  return Object.freeze({
    state: 'authored-degraded', healthy: false, code: secondary[0].code,
    headline: `Authored vegetation — ${secondary.length} degradation${secondary.length === 1 ? '' : 's'}`,
    detail: secondary.map((entry) => entry.message).join(' '),
  });
}

/**
 * The CUSTOMS TRUTH strip's vegetation segment — the same verdict as the chip, in the strip's voice.
 *
 * The strip used to paint `${exactVegetationPlan.renderedCount} AUTHORED VEGETATION` from the render
 * PLAN. A plan is a statement of intent: it is 7,108 whether the pack mounted, failed, was still
 * loading, or was suppressed by query. An independent reviewer measured the strip reading
 * "7,108 AUTHORED VEGETATION" on a GLB-404 run where 0 of 8,805 placements were authored — thirty
 * pixels above the chip that correctly said the pack had failed. A green reassurance directly over
 * an amber failure is worse than either alone, because the reader believes the one that agrees with
 * what he hoped, and the two forests are near-indistinguishable at the default orbit.
 *
 * So the number here is a function of `indicator.state` and NOTHING else:
 *
 *   * `authored` / `authored-degraded` — a live runtime exists, so the authored half is countable:
 *     the placements it actually holds (drawn + frustum-rejected), from the same `accounting` the
 *     conservation sum uses;
 *   * `loading` / `procedural` — by the definition of those states nothing authored is on screen, so
 *     the count is literally `0`, never the plan's ambition;
 *   * `disposed` / `inconsistent` — the authored half cannot be read at all, so there is NO number.
 *     `accountedPlacements` is null in exactly these states for exactly this reason; a strip that
 *     printed `0` here would be asserting a measurement it does not have.
 *
 * A positive count is therefore reachable only from a state whose chip says a live authored runtime
 * exists. The strip cannot claim authored vegetation while the chip denies it — not because the two
 * were written to agree, but because they are two renderings of one `indicator`.
 */
const STRIP_QUALIFIER = Object.freeze({
  'runtime-disposed': 'VIEW DISPOSED',
  'no-authored-plan': 'NO AUTHORED PLAN',
  // Not `PUBLIC TREE POSITIONS`. That named the source and let the segment read as a description of
  // the shipped frame; the promoted pack ships, so the segment has to name the FAILURE.
  'promoted-vegetation-missing': 'PROMOTED PACK DID NOT LOAD',
  'authored-disabled-by-query': 'PROCEDURAL BY REQUEST',
  'mount-in-flight': 'PACK LOADING',
  'mount-failed': 'PACK FAILED TO MOUNT',
  'authored-runtime-missing': 'STATUS INCONSISTENT',
});

/** States in which a live authored runtime exists and its placements can be counted. */
const AUTHORED_LIVE_STATES = new Set(['authored', 'authored-degraded']);
/** States in which nothing authored is on screen — a measured zero, not an unknown. */
const AUTHORED_ABSENT_STATES = new Set(['loading', 'procedural']);

export function vegetationTruthSegment({ indicator, accounting } = {}) {
  const state = indicator?.state ?? 'inconsistent';
  const visible = accounting?.parts?.authoredVisible ?? null;
  const frustumCulled = accounting?.parts?.authoredFrustumCulled ?? null;
  let authoredPlacements = null;
  if (AUTHORED_LIVE_STATES.has(state)) {
    authoredPlacements = visible === null || frustumCulled === null ? null : visible + frustumCulled;
  } else if (AUTHORED_ABSENT_STATES.has(state)) {
    authoredPlacements = 0;
  }
  const lead = authoredPlacements === null
    ? 'AUTHORED VEGETATION UNREADABLE'
    : `${authoredPlacements.toLocaleString('en-US')} AUTHORED VEGETATION`;
  const qualifier = indicator?.healthy
    ? null
    : (STRIP_QUALIFIER[indicator?.code] ?? 'DEGRADED');
  return Object.freeze({
    // An em dash, never the strip's own ` · ` separator: a qualifier joined with the separator
    // reads as a fifth top-level claim rather than as this segment's own caveat.
    text: qualifier ? `${lead} — ${qualifier}` : lead,
    state,
    healthy: Boolean(indicator?.healthy),
    code: indicator?.code ?? null,
    authoredPlacements,
  });
}

/**
 * The whole observability answer for one `renderStats()` call.
 *
 * `warnings` stays an array of strings — that is the field readers already know — `degradations`
 * carries the same list with a stable code beside each message, `indicator` is the one-sentence,
 * on-screen answer built from that same `degradations` array (see `vegetationIndicatorFromDegradations`
 * above), and `strip` is that same indicator in the CUSTOMS TRUTH strip's voice — so a test can name
 * a state without matching prose, and neither on-screen readout can say something `warnings`
 * disagrees with.
 *
 * `strip` is returned from HERE, rather than left for the caller to compute, so that a caller cannot
 * paint the chip from this snapshot and the strip from a second, differently-timed read. One call,
 * one verdict, two renderings of it.
 */
export function describeVegetationObservability(snapshot = {}) {
  const accounting = vegetationPlacementAccounting(snapshot);
  const degradations = vegetationDegradations({ ...snapshot, accounting });
  const indicator = vegetationIndicatorFromDegradations({ mount: snapshot.mount, degradations });
  return Object.freeze({
    accounting,
    accountedPlacements: accounting.placements,
    degradations,
    warnings: Object.freeze(degradations.map((entry) => entry.message)),
    indicator,
    strip: vegetationTruthSegment({ indicator, accounting }),
  });
}
