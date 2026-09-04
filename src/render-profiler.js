/**
 * The frame-time instrument this renderer has never had — the pure half.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `docs/CONTINUATION-HANDOFF-2026-09-03.md` §7 lists eight times a counter in this repo reported
 * success while something had silently fallen back, and §8 records the one that matters here:
 * *"No frame-time claim in this repo is backed by anything."* It is worse than that on the Three
 * path — there is no frame-time field to be null. `renderStats().fps` counts how often the app
 * CHOSE to submit a frame (`animate()` returns early unless invalidated), so an idle-but-capable
 * app reports a low number and a struggling one reports the same number as a fast one. Exactly one
 * value on this path is measured from the live pipeline: the draw-call latch sampled immediately
 * after `render()` (`src/render-frame-latch.js`).
 *
 * Every capture ever taken here was headless Chromium on SwiftShader. The founder's RTX 5080 is the
 * only real GPU this project has. So this module is not a dashboard: it is a one-shot instrument he
 * arms with `?profile=1`, runs once, and exports, to produce the baseline every later optimisation
 * is judged against.
 *
 * THE FOUR RULES IT IS BUILT TO
 * -----------------------------
 * 1. **Never substitute one number for another.** If the GPU timer is unavailable, `gpuFrameMs` is
 *    `null` and `gpuTiming.reason` says why. CPU frame time is never quietly promoted into its
 *    place. This is the shape of `map3d.js:2272`'s `gpuTimePerFrame || null`, which collapses a
 *    genuine 0 and a missing timer query into the same value — the mistake is not repeated.
 * 2. **Say what was measured.** A run that does not record the build, the viewport, the device
 *    pixel ratio, the GPU string, the layer set and whether the vegetation pack had finished
 *    mounting is what produced the contradictory 1,461 / 1,439 / 1,397 draw-call numbers already in
 *    this repo. `buildProfileReport()` REFUSES a report missing any of them.
 * 3. **Steady state, not the first frame after a change.** Warm-up frames are discarded and the
 *    count is recorded; the headline is median and p95, never a mean over a window whose first
 *    frames paid for a shader compile.
 * 4. **Zero cost when off.** Nothing in this module is reachable unless `?profile=` is present.
 *    `isProfilingRequested()` is one `URLSearchParams` read at boot.
 *
 * THE GATE QUESTION, ANSWERED HERE AND NOT BORROWED
 * -------------------------------------------------
 * `src/renderer-gate.js` question (c), `canShowDiagnosticReadouts()`, is dev + loopback: it governs
 * the CUSTOMS TRUTH strip and the vegetation notice, banners drawn over the middle of the map that
 * a visitor never asked for and cannot act on. Handoff §4: *"A source-pinned test refuses any
 * attempt to implement one of these by delegating to another."*
 *
 * The profiler is deliberately NOT behind it, and does not import it:
 *
 *   - `canShowDiagnosticReadouts()` is FALSE in exactly the configuration the baseline has to be
 *     taken in. `vite preview` of a release build on 127.0.0.1 is loopback but not `import.meta.env
 *     .DEV`, and `tarkovzero.com` on the founder's own machine is neither. Gating the instrument
 *     behind that predicate would make it unrunnable on the only real GPU in the project.
 *   - It publishes nothing local. Every number describes the frame the visitor is already being
 *     served — draw calls, milliseconds, heap bytes. No game-derived asset, no local package, no
 *     path. Question (b), `canLoadLocalGameDerivedAssets()`, is untouched and unreferenced.
 *   - It draws nothing unless asked. The banners were removed because they appeared uninvited; this
 *     panel exists only for a visitor who typed `?profile=1`, and sits in a corner, not over the map.
 *
 * So it gets its own predicate — `isProfilingRequested()`, right here, a pure function of the query
 * string and of nothing else. Not a fourth function in `renderer-gate.js`: a run switch a visitor
 * types is not a boundary, and putting it next to the two that are would invite exactly the fusion
 * that module's header exists to have fixed once.
 *
 * WHAT THIS FILE IS NOT
 * ---------------------
 * It has no DOM, no THREE, no `window`, no timer. It is arithmetic and report shape, so `node
 * --test scripts/render-profiler.test.mjs` can prove the statistics, the phase accounting and the
 * refusals without a browser. The browser half — GPU timer queries, `performance.mark`, the layout
 * probe, the panel — lives in `src/map3d-three.js`, which is where the renderer, the camera and the
 * overlay already are.
 */

/**
 * Bump when a field changes meaning. A reader that cannot parse the schema must not guess.
 *
 * `/2` — `gpuTiming.health.disjointObserved` changed from a hardcoded `0` (which asserted "no
 * disjoint occurred" while observing nothing) to `null` plus `disjointObservable` and
 * `disjointReason`. A `/1` reader that saw `null` where it expected a count would otherwise treat
 * the absence as a zero, which is the exact mistake the change was made to stop.
 */
export const PROFILE_SCHEMA = 'tz-render-profile/2';

/**
 * The camera presets, spelled the way the address bar spells them.
 *
 * `#zoom2d/x/z` is this app's permalink (`src/main.js:483`), so a preset is a link the founder can
 * paste and a reviewer can re-open. Two of them are his own — the poses he was sitting at while
 * this instrument was commissioned — because a baseline taken at a pose nobody looks at measures
 * nothing anybody cares about.
 *
 * `zoom3d = zoom2d - zoomOffsetFor(mapData)` and `target = [-x, -z, 0]`; the conversion lives with
 * the renderer, which is the only place that knows the map's CRS scale.
 */
export const PROFILE_PRESETS = Object.freeze([
  Object.freeze({
    name: 'founder-a',
    hash: '#3.48/257.7/-42.3',
    zoom2d: 3.48, x: 257.7, z: -42.3,
    note: 'the founder\'s own pose, 2026-09-03',
  }),
  Object.freeze({
    name: 'founder-b',
    hash: '#3.92/257.9/-22.1',
    zoom2d: 3.92, x: 257.9, z: -22.1,
    note: 'the founder\'s own pose, one notch closer',
  }),
  Object.freeze({
    // No hash: this one is whatever the app's OWN fit says, so it stays correct when the fit does.
    // Its resolved view state is written into the report, which is what makes the run reproducible.
    name: 'cover-fit',
    fit: true,
    note: 'the app\'s own whole-map framing — the first thing a visitor sees',
  }),
  Object.freeze({
    // Close-in and low: the worst case for the DOM overlay (most items on screen are near) and for
    // the terrain shader (ground fills the frame). rotationX 12 is above CAM.minRotationX = 9.
    name: 'ground-close',
    hash: '#7.00/257.7/-42.3',
    zoom2d: 7.0, x: 257.7, z: -42.3, rotationX: 12,
    note: 'close-in low-angle ground view — overlay-heavy and terrain-fill-heavy',
  }),
]);

export const PROFILE_PRESET_NAMES = Object.freeze(PROFILE_PRESETS.map((p) => p.name));

/** The four things a rendered frame does, in the order `animate()` does them. */
export const FRAME_PHASES = Object.freeze(['controls', 'lod', 'overlay', 'render']);

/** Work that is real but not per-frame: it is counted per event, and per second of the window. */
export const EVENT_PHASES = Object.freeze(['refreshDynamic', 'raycast', 'vegetationRepack']);

/** Named first-paint phases, in the order they can complete. `describeWaterfall` sorts by clock. */
export const WATERFALL_PHASES = Object.freeze([
  'boot',
  'mapDataFetch',
  'mapDataParse',
  'terrainPackage',
  'vegetationPlacements',
  'rendererInit',
  'terrainSurfaces',
  'terrainPbr',
  'worldBuild',
  'firstRender',
  'vegetationMount',
]);

const DEFAULTS = Object.freeze({
  warmupFrames: 30,
  sampleFrames: 180,
  reflowFrames: 60,
});

const finite = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

const clampInt = (value, lo, hi, dflt) => {
  // An ABSENT parameter is the default, not zero: `Number(null)` is 0, and a silent 0 here would
  // mean "no warm-up frames" for every visitor who did not name a count.
  if (value === null || value === undefined || String(value).trim() === '') return dflt;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};

/**
 * (d) Was a profiling run ASKED FOR? A pure function of the query string, and of nothing else.
 *
 * Deliberately takes no environment — no `dev`, no `hostname`, no map key. See the module header:
 * the two configurations where the baseline actually has to be taken (a release `vite preview` on
 * loopback, and the live site on the founder's machine) are precisely the ones every environment
 * predicate in `renderer-gate.js` answers `false` for.
 *
 * `?profile=0` / `?profile=false` / `?profile=off` mean off, because a URL a human types has to be
 * turn-off-able without deleting the parameter. Absent means off. Anything else means on.
 */
export function isProfilingRequested(search) {
  const raw = new URLSearchParams(String(search ?? '')).get('profile');
  if (raw === null) return false;
  const value = raw.trim().toLowerCase();
  return !(value === '0' || value === 'false' || value === 'off' || value === 'no');
}

/**
 * The whole run configuration, parsed once at boot.
 *
 * `selfTest` is the discrimination proof, and it is a first-class feature rather than something an
 * agent did once and wrote down: handoff §7's rule is *"when you add an assertion, prove it
 * discriminates"*. A harness whose numbers do not move when cost is added is worthless, and the
 * only way the founder can check that on his own machine is to be able to add the cost himself.
 *
 *   ?profileSelfTest=busy:4   4 ms of busy-loop injected into the overlay pass, every frame
 *   ?profileSelfTest=nocull   frustum culling disabled on the world roots for the run
 *
 * Both are restored when the run ends, and both are recorded in the report — a report produced
 * under a self-test says so in `selfTest`, so it can never be mistaken for a baseline.
 */
export function parseProfileRequest(search) {
  const params = new URLSearchParams(String(search ?? ''));
  const armed = isProfilingRequested(search);
  const requested = String(params.get('profilePresets') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const unknownPresets = requested.filter((name) => !PROFILE_PRESET_NAMES.includes(name));
  const presets = requested.length
    ? PROFILE_PRESET_NAMES.filter((name) => requested.includes(name))
    : [...PROFILE_PRESET_NAMES];
  return Object.freeze({
    armed,
    auto: armed && isProfilingRequested(`profile=${params.get('profileAuto') ?? '0'}`),
    presets: Object.freeze(presets.length ? presets : [...PROFILE_PRESET_NAMES]),
    unknownPresets: Object.freeze(unknownPresets),
    warmupFrames: clampInt(params.get('profileWarmup'), 0, 600, DEFAULTS.warmupFrames),
    sampleFrames: clampInt(params.get('profileFrames'), 10, 2000, DEFAULTS.sampleFrames),
    reflowFrames: clampInt(params.get('profileReflowFrames'), 0, 600, DEFAULTS.reflowFrames),
    selfTest: parseSelfTest(params.get('profileSelfTest')),
    ablate: parseAblation(params.get('profileAblate')),
  });
}

export function parseSelfTest(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value || value === 'none' || value === 'off' || value === '0') return null;
  if (value === 'nocull') return Object.freeze({ kind: 'nocull', label: 'frustum culling disabled on the world roots' });
  const busy = /^busy(?::(\d+(?:\.\d+)?))?$/.exec(value);
  if (busy) {
    const ms = Math.min(200, Math.max(0.1, Number(busy[1] ?? 4)));
    return Object.freeze({ kind: 'busy', busyMs: ms, label: `${ms} ms busy-loop injected into the overlay pass` });
  }
  return Object.freeze({ kind: 'unknown', raw: value, label: `unrecognised self-test "${value}" — ignored` });
}

/* ---------------------------------------------------------------------- ablations -- */

/**
 * Attribution spikes: switches that REMOVE a named piece of the frame so its cost can be measured
 * instead of inferred.
 *
 * WHY THESE EXIST. The two largest items on the optimisation plan — stop re-rendering the shadow
 * map every frame, merge the prop and rock geometry into fewer draws — both rest on the same
 * unproven inference: that the `render` phase is dominated by scene-SUBMISSION work rather than by
 * fill, shading or the terrain's twelve unconditional material layers. `phases.render` is one
 * number and cannot tell those apart. Eight hours of building either one blind is eight hours bet
 * on a guess; a run with the thing switched off costs one page load and settles it.
 *
 * TWO CLASSES, AND THEY ARE NOT THE SAME KIND OF EVIDENCE.
 *
 *   - `shadow` is **pixel-identical** — that IS the hypothesis under test. A directional light's
 *     shadow camera here is a fixed ortho frustum aimed at the map centre and does not follow the
 *     view, so on a static scene the depth map rendered on frame 1 is the depth map frame 900 would
 *     have rendered. If it holds, this is a candidate optimisation you could ship. It is a
 *     hypothesis, not a fact: verify it with the frame-hash check before believing it.
 *   - `props` and `rocks` **change the picture on purpose**. They are attribution experiments and
 *     nothing else — a measurement of what that content costs. Nothing produced under them is a
 *     candidate optimisation, because the app is supposed to draw props and rocks. A report taken
 *     under one of these must never be able to be mistaken for a baseline, which is why they get
 *     their own note at the top of `notes` and their own class in the stamp.
 *
 * Both classes stamp the report. `selfTest` stamps too, and the two are independent: a run can be
 * both, and then carries both notes.
 */
export const ABLATION_TARGETS = Object.freeze({
  shadow: Object.freeze({
    name: 'shadow',
    pixelIdentical: true,
    label: 'the sun\'s shadow depth map is rendered ONCE and then frozen (sun.shadow.autoUpdate = false)',
    hypothesis: 'the per-frame shadow pass is a whole second scene traversal and depth-only submission of every caster; if `render` is submission-bound, removing it moves phases.render and drawCalls together',
    expect: 'renderInfo.frameCalls falls by 1 (the nested renderer.render(scene, shadow.camera) is gone) and drawCalls falls by the caster count',
    // SINCE 2026-09-03 THIS IS ALREADY THE SHIPPED BEHAVIOUR (docs/PROFILING.md §3c). On a default
    // load there is nothing left for this flag to remove and the A/B will correctly report that it
    // attributes nothing — which is the optimisation having landed, not the probe having broken.
    // `?shadows=live&profileAblate=shadow` is the load on which it still discriminates.
    alreadyShipped: 'sun.shadow.autoUpdate is false by default; pair with ?shadows=live to measure the pass',
  }),
  props: Object.freeze({
    name: 'props',
    pixelIdentical: false,
    label: 'propGroup.visible = false — every prop is removed from the frame, and the depth map is re-baked without it',
    hypothesis: 'props are many small meshes; if `render` is submission-bound their draw calls are a measurable share of it',
    // SINCE 2026-09-03 THE SHADOW SHARE OF THIS NUMBER IS ZERO ON A DEFAULT LOAD. Props are casters,
    // so before the freeze they cost draw calls in BOTH the colour pass and the depth pass; frozen,
    // the depth pass does not run per frame and only the colour-pass share is left. `applyAblation`
    // invalidates on both edges so the picture is honest (no prop shadows on ground with no props),
    // but the depth-pass cost this used to include is now attributed to the shadow policy instead.
    expect: 'renderInfo.drawCalls falls by the visible prop count IN THE COLOUR PASS ONLY (the depth'
      + ' pass is frozen; pair with ?shadows=live to include their shadow cost); the picture is missing its props',
  }),
  rocks: Object.freeze({
    name: 'rocks',
    pixelIdentical: false,
    label: 'rockGroup.visible = false — every rock is removed from the frame, and the depth map is re-baked without it',
    hypothesis: 'as props: many separate meshes that a merge would collapse into few draws',
    expect: 'renderInfo.drawCalls falls by the visible rock count IN THE COLOUR PASS ONLY (the depth'
      + ' pass is frozen; pair with ?shadows=live to include their shadow cost); the picture is missing its rocks',
  }),
});

export const ABLATION_TARGET_NAMES = Object.freeze(Object.keys(ABLATION_TARGETS));

/**
 * `?profileAblate=shadow` · `?profileAblate=props,rocks`.
 *
 * Absent, `none`, `off` and `0` all mean no ablation, matching `parseSelfTest` — a URL a human
 * retypes has to be turn-off-able without deleting the parameter. An unrecognised name is REPORTED
 * and dropped rather than silently ignored: a typo that quietly produced a clean run would be a run
 * the founder believes is an ablation, which is worse than no run at all.
 */
export function parseAblation(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value || value === 'none' || value === 'off' || value === '0') return null;
  const requested = value.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = requested.filter((name) => !ABLATION_TARGET_NAMES.includes(name));
  // Canonical order, de-duplicated: `rocks,props` and `props,rocks,props` are the same run and must
  // produce the same label, so two reports of the same experiment compare as the same experiment.
  const targets = ABLATION_TARGET_NAMES.filter((name) => requested.includes(name));
  if (!targets.length) {
    return Object.freeze({
      kind: 'unknown',
      raw: value,
      targets: Object.freeze([]),
      unknown: Object.freeze(unknown),
      pixelIdentical: true,
      pixelChanging: Object.freeze([]),
      label: `unrecognised ablation "${value}" — ignored; known targets are ${ABLATION_TARGET_NAMES.join(', ')}`,
    });
  }
  const pixelChanging = targets.filter((name) => !ABLATION_TARGETS[name].pixelIdentical);
  return Object.freeze({
    kind: 'ablate',
    raw: value,
    targets: Object.freeze(targets),
    unknown: Object.freeze(unknown),
    // The whole set has to be pixel-identical for the run to be; one pixel-changing target makes
    // the combined run pixel-changing, and it is stamped as the stronger of the two warnings.
    pixelIdentical: pixelChanging.length === 0,
    pixelChanging: Object.freeze(pixelChanging),
    label: targets.map((name) => ABLATION_TARGETS[name].label).join('; '),
  });
}

/**
 * The note a report carries because of its ablation. Exported so the stamp is testable on its own
 * and so the panel can print the same sentence the JSON holds.
 */
export function describeAblationStamp(ablation) {
  if (!ablation || !ablation.targets?.length) return null;
  if (!ablation.pixelIdentical) {
    return `ABLATION RUN — PIXELS DELIBERATELY REMOVED (${ablation.pixelChanging.join(', ')}). NOT A BASELINE, AND NOT A CANDIDATE OPTIMISATION: this run draws a different picture on purpose to measure what that content costs. The app is supposed to draw it. ${ablation.label}`;
  }
  return `ABLATION RUN — NOT A BASELINE. Pixel-identical BY HYPOTHESIS, which is the thing being tested and not a finding: confirm it with the frame-hash check before believing any number here. ${ablation.label}`;
}

/**
 * An A/B/A/B series taken in ONE page load, and whether its delta survives its own noise.
 *
 * Two separate page loads differ in shader-compilation state, pipeline caches and texture
 * residency, and the GPU numbers already recorded in this project moved 1-4 ms between runs for no
 * attributable reason. A delta of 2 ms between two loads is therefore not evidence of anything.
 * Alternating arms inside one load holds all of that constant, and repeating each arm gives the
 * comparison something to measure its own delta AGAINST.
 *
 * The verdict is the point. `withinArmSpread` is the widest range either arm produced when nothing
 * changed between its runs; if the A→B delta does not exceed it, this series attributes nothing and
 * says so, rather than reporting a delta and letting a reader assume it means something.
 */
export const PROFILE_SERIES_SCHEMA = 'tz-render-profile-series/1';

const ABLATION_METRICS = Object.freeze({
  cpuFrameMedianMs: (preset) => preset?.cpuFrameMs?.median,
  renderPhaseMedianMs: (preset) => preset?.phases?.render?.median,
  overlayPhaseMedianMs: (preset) => preset?.phases?.overlay?.median,
  gpuFrameMedianMs: (preset) => preset?.gpuFrameMs?.median,
  drawCalls: (preset) => preset?.renderInfo?.drawCalls,
  triangles: (preset) => preset?.renderInfo?.triangles,
  frameCalls: (preset) => preset?.renderInfo?.frameCalls,
});

export const ABLATION_METRIC_NAMES = Object.freeze(Object.keys(ABLATION_METRICS));

function compareArms(a, b) {
  const spread = (values) => (values.length ? Math.max(...values) - Math.min(...values) : null);
  const middle = (values) => summarize(values)?.median ?? null;
  const aMedian = middle(a);
  const bMedian = middle(b);
  const delta = aMedian === null || bMedian === null ? null : bMedian - aMedian;
  // Noise is only knowable from REPEATED runs of the same arm. One run per arm gives none, and the
  // verdict says that instead of inventing a threshold.
  const withinArmSpread = a.length > 1 && b.length > 1 ? Math.max(spread(a), spread(b)) : null;
  let verdict;
  if (delta === null) verdict = 'not measured in both arms';
  else if (withinArmSpread === null) verdict = 'ONE RUN PER ARM — this delta is not separated from run-to-run variance. Repeat the series to get a noise floor.';
  else if (Math.abs(delta) > withinArmSpread) verdict = 'the A→B delta is LARGER than the widest within-arm spread — this series attributes it';
  else verdict = 'the A→B delta is INSIDE the within-arm spread — this series attributes nothing';
  return Object.freeze({
    a: Object.freeze([...a]),
    b: Object.freeze([...b]),
    aMedian,
    bMedian,
    delta,
    deltaRatio: aMedian ? bMedian / aMedian : null,
    withinArmSpread,
    verdict,
  });
}

export function describeAblationSeries(runs = []) {
  const arms = { A: [], B: [] };
  for (const run of Array.isArray(runs) ? runs : []) {
    if (run && (run.arm === 'A' || run.arm === 'B') && run.report) arms[run.arm].push(run.report);
  }
  const presetNames = [];
  for (const arm of ['A', 'B']) {
    for (const report of arms[arm]) {
      for (const preset of report.presets ?? []) {
        if (preset?.ok && !presetNames.includes(preset.name)) presetNames.push(preset.name);
      }
    }
  }
  const presets = {};
  for (const name of presetNames) {
    const pick = (arm) => arms[arm]
      .map((report) => (report.presets ?? []).find((preset) => preset.name === name))
      .filter(Boolean);
    const armA = pick('A');
    const armB = pick('B');
    const metrics = {};
    for (const [metric, read] of Object.entries(ABLATION_METRICS)) {
      metrics[metric] = compareArms(
        armA.map(read).map(finite).filter((v) => v !== null),
        armB.map(read).map(finite).filter((v) => v !== null),
      );
    }
    presets[name] = Object.freeze(metrics);
  }
  return Object.freeze({
    method: 'alternating arms within ONE page load — A is the unablated frame, B is the ablated one. Shader compilation, pipeline caches and texture residency are held constant across the arms, which comparing separate loads cannot do.',
    runsPerArm: Object.freeze({ A: arms.A.length, B: arms.B.length }),
    presets: Object.freeze(presets),
  });
}

/* --------------------------------------------------------------------- statistics -- */

/**
 * Median and p95 over a sample, and the count they came from.
 *
 * The mean is reported too, but last and beside the others, because a mean over a frame window is
 * the number that hides the hitch: 119 frames at 4 ms and one at 400 ms means 7.3 ms, which is a
 * lie about what the frame felt like. p95 is what says a hitch happened.
 *
 * `percentileMethod: 'nearest-rank'` — p95 is `sorted[ceil(0.95 * n) - 1]`, an OBSERVED sample and
 * never an interpolation between two, so every number in the report is a value that was actually
 * measured. The median interpolates on an even count, which is the one place a non-observed value
 * is reported and is labelled as such.
 */
export function summarize(values, { unit = 'ms' } = {}) {
  const clean = (Array.isArray(values) ? values : []).map(finite).filter((v) => v !== null);
  if (!clean.length) return null;
  const sorted = [...clean].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = n >> 1;
  const median = n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Object.freeze({
    n,
    unit,
    min: sorted[0],
    median,
    p95: sorted[Math.min(n - 1, Math.ceil(0.95 * n) - 1)],
    max: sorted[n - 1],
    mean: sorted.reduce((a, b) => a + b, 0) / n,
    percentileMethod: 'nearest-rank',
    medianInterpolated: n % 2 === 0,
  });
}

/** The difference between two summaries, for a discrimination check. `null` when either is absent. */
export function compareSummaries(before, after) {
  if (!before || !after) return null;
  return Object.freeze({
    medianDelta: after.median - before.median,
    p95Delta: after.p95 - before.p95,
    medianRatio: before.median === 0 ? null : after.median / before.median,
    unit: after.unit ?? before.unit ?? 'ms',
  });
}

/* ---------------------------------------------------------------- phase accounting -- */

/**
 * Per-frame phase accounting with an honest residual.
 *
 * The whole point of the residual: `frameTotal - sum(phases)` is the part of the rendered frame
 * this harness cannot name. If it is large, the breakdown is wrong and the report says so instead
 * of presenting four phases that happen to add up to less than the frame and letting a reader
 * assume they add up to all of it. `unaccounted` is reported with the same weight as any phase.
 */
export function createPhaseLedger(phases = FRAME_PHASES) {
  const names = [...phases];
  const samples = new Map(names.map((name) => [name, []]));
  const totals = [];
  const unaccounted = [];
  let open = null;

  return {
    /** Start a frame. Any unfinished previous frame is dropped, never half-counted. */
    beginFrame() { open = new Map(); },
    /** Record one phase of the open frame. A phase named twice in one frame is summed. */
    record(name, ms) {
      if (!open || !samples.has(name)) return;
      const value = finite(ms);
      if (value === null) return;
      open.set(name, (open.get(name) ?? 0) + value);
    },
    /** Close the frame with its measured total. Frames with no total are discarded entirely. */
    endFrame(totalMs) {
      const total = finite(totalMs);
      if (!open || total === null) { open = null; return false; }
      let sum = 0;
      for (const name of names) {
        const value = open.get(name);
        if (value !== undefined) { samples.get(name).push(value); sum += value; }
      }
      totals.push(total);
      unaccounted.push(total - sum);
      open = null;
      return true;
    },
    get frames() { return totals.length; },
    summarize() {
      const perPhase = {};
      for (const name of names) perPhase[name] = summarize(samples.get(name));
      return Object.freeze({
        frames: totals.length,
        total: summarize(totals),
        phases: Object.freeze(perPhase),
        // Named, not hidden: the share of the frame this breakdown does not explain.
        unaccounted: summarize(unaccounted),
      });
    },
  };
}

/**
 * Work that happens between frames, not inside them: a `refreshDynamic()` teardown, a pointermove
 * raycast, a vegetation repack. Counting these per frame would be a category error — they are
 * counted per event, and normalised to milliseconds per second of the sampling window so a run at
 * one frame rate can be compared with a run at another.
 */
export function createEventLedger(names = EVENT_PHASES) {
  const samples = new Map([...names].map((name) => [name, []]));
  return {
    record(name, ms) {
      const value = finite(ms);
      if (value === null || !samples.has(name)) return;
      samples.get(name).push(value);
    },
    summarize(windowMs) {
      const window = finite(windowMs);
      const out = {};
      for (const [name, values] of samples) {
        const stats = summarize(values);
        const totalMs = values.reduce((a, b) => a + b, 0);
        out[name] = Object.freeze({
          events: values.length,
          totalMs,
          msPerSecond: window && window > 0 ? (totalMs * 1000) / window : null,
          each: stats,
        });
      }
      return Object.freeze(out);
    },
  };
}

/* ---------------------------------------------------------------- first-paint waterfall -- */

/**
 * The first-paint waterfall.
 *
 * Every phase is an interval with a name, a start and an end, all relative to one origin, so the
 * report can state where the time went rather than only how long the whole thing took. The two
 * things a reader must be able to see: which phases OVERLAP (the terrain fetches are started before
 * the map JSON is awaited, so a serial sum would over-count), and which phase is still open when
 * the first frame lands — the authored vegetation mount is never awaited and takes 60–85 s, so a
 * waterfall that stopped at `firstRender` would describe a page that is still loading as finished.
 */
export function createWaterfall() {
  const open = new Map();
  const closed = [];
  return {
    begin(name, atMs) {
      const at = finite(atMs);
      if (at === null) return;
      open.set(name, at);
    },
    end(name, atMs) {
      const at = finite(atMs);
      const start = open.get(name);
      if (at === null || start === undefined) return;
      open.delete(name);
      closed.push({ phase: name, startMs: start, endMs: at, durationMs: at - start });
    },
    /** A phase with no duration — a milestone. Recorded as a zero-length interval. */
    mark(name, atMs) {
      const at = finite(atMs);
      if (at === null) return;
      closed.push({ phase: name, startMs: at, endMs: at, durationMs: 0 });
    },
    describe(nowMs) {
      const now = finite(nowMs);
      const stillOpen = [...open.entries()].map(([phase, startMs]) => ({
        phase, startMs, endMs: null, durationMs: null,
        openForMs: now === null ? null : now - startMs,
        note: 'still running when the report was taken',
      }));
      const all = [...closed, ...stillOpen].sort((a, b) => a.startMs - b.startMs);
      const spanEnd = closed.reduce((max, row) => Math.max(max, row.endMs), 0);
      return Object.freeze({
        phases: Object.freeze(all.map(Object.freeze)),
        // Wall clock from origin to the last CLOSED phase. Deliberately not a sum of durations:
        // several of these overlap, and a sum would report more time than the page took.
        spanMs: closed.length ? spanEnd : null,
        openPhases: Object.freeze(stillOpen.map((row) => row.phase)),
      });
    },
  };
}

/* ------------------------------------------------------------------------ GPU timing -- */

/**
 * The GPU-time channel, described honestly.
 *
 * three 0.185.1 implements timestamp queries on BOTH backends this app can reach — the WebGL2
 * fallback uses `EXT_disjoint_timer_query_webgl2` (`node_modules/three/src/renderers/webgl-fallback/
 * WebGLBackend.js:270`, pool at `utils/WebGLTimestampQueryPool.js:27`) and the WebGPU backend uses
 * `GPUFeatureName.TimestampQuery` (`webgpu/utils/WebGPUTimestampQueryPool.js`). Both require
 * `trackTimestamp: true` at RENDERER CONSTRUCTION — `Backend.js:76` reads it from the constructor
 * parameters and the WebGPU backend folds in its feature check at init — which is why the profiler
 * has to be armed from the URL before `new WebGPURenderer()` runs and cannot be switched on later.
 *
 * THE TRAP THIS FUNCTION EXISTS TO REPORT: three's pools return `this.lastValue` — the PREVIOUS
 * frame's number — whenever the GPU reports the disjoint flag, whenever a resolve is already in
 * flight, and whenever resolution throws (`WebGLTimestampQueryPool.js:329-334`, `:187-190`,
 * `:285-292`). Nothing in that path distinguishes "this frame took the same time" from "this
 * reading is the last one again". That is the §7 failure shape exactly, so the caller counts
 * resolves, accepted samples and adjacent duplicates, and this function publishes all three next to
 * the milliseconds — beside a STATED answer to whether the disjoint condition itself could be
 * counted, which on both backends this app can reach it cannot. See
 * `describeDisjointObservability` for why, and for why that field holds `null` and not `0`.
 *
 * `available: false` yields `frameMs: null`. CPU frame time is never substituted.
 */
export function describeGpuTiming({
  method = null, available = false, reason = null, values = [],
  resolveCalls = 0, disjoint = null, adjacentDuplicates = 0, backend = null,
} = {}) {
  const frameMs = available ? summarize(values) : null;
  const samples = frameMs?.n ?? 0;
  const observability = disjoint ?? describeDisjointObservability(backend);
  // A COUNT only when something actually counted. `null` otherwise — never a 0, which a reader
  // takes as proof that none occurred. See `describeDisjointObservability`.
  const observedCount = observability.observable === true ? finite(observability.observed) : null;
  const health = Object.freeze({
    resolveCalls,
    samplesAccepted: samples,
    adjacentDuplicates,
    adjacentDuplicatesMeaning: 'accepted GPU samples whose value equalled the previous ACCEPTED sample (not the previous frame — resolves are one at a time and skip frames). three returns `lastValue` on a disjoint, an in-flight resolve or a throw, so a repeat is the symptom of a stale reading. It is a PROXY, not a disjoint count: it over-counts when two frames genuinely take the same time.',
    disjointObserved: observedCount,
    disjointObservable: observability.observable === true,
    disjointReason: observability.reason ?? null,
    // A run where most resolves came back identical to the one before is a run whose GPU numbers
    // are probably three's `lastValue` repeating, not the GPU agreeing with itself.
    suspectRepeatShare: samples > 1 ? adjacentDuplicates / (samples - 1) : null,
  });
  const warnings = [];
  if (available && samples === 0) warnings.push('the timer was available but produced no samples');
  if (available && health.suspectRepeatShare !== null && health.suspectRepeatShare > 0.5) {
    warnings.push('more than half of the accepted GPU samples repeated the previous value — three returns its last value on a disjoint or an in-flight resolve, so these numbers may be stale');
  }
  if (observedCount !== null && observedCount > 0) {
    warnings.push(`the GPU disjoint flag was observed ${observedCount} time(s); those frames' timings are unreliable by specification`);
  }
  if (available && samples > 0 && health.disjointObservable === false) {
    warnings.push(`disjoints were NOT counted on this run: ${health.disjointReason} Read health.adjacentDuplicates and health.suspectRepeatShare instead — they are the staleness signal this backend affords.`);
  }
  return Object.freeze({
    available: available && samples > 0,
    method,
    backend,
    reason: available ? (samples > 0 ? null : 'no samples resolved') : reason,
    frameMs,
    health,
    warnings: Object.freeze(warnings),
  });
}

/**
 * Can the disjoint condition be COUNTED on this backend, and if not, why not — stated, not assumed.
 *
 * `gpuTiming.health.disjointObserved` used to be the literal `0`, written at the call site with a
 * comment explaining that it was not observed. A reader of the report saw a field named
 * "disjointObserved" holding a zero and had every reason to take it as proof that no disjoint
 * occurred. It observed nothing. That is handoff §7's failure shape — *a metric that cannot detect
 * the thing it exists to report* — and it is the same mistake as `map3d.js:2272`'s
 * `gpuTimePerFrame || null`, which this module's own header cites: a genuine measured value and a
 * missing one collapsed into one indistinguishable number.
 *
 * The field is kept rather than deleted, because a reader profiling a GPU goes looking for exactly
 * this word, and a missing field would leave them unable to tell "considered and not obtainable"
 * from "never thought about". It now holds `null` — the module's established idiom for a channel
 * that did not produce a number — beside the reason and an `observable` flag, and a slot that a
 * backend which CAN count them fills with a real integer.
 *
 * Neither backend this app can reach can count them:
 *
 *   - **WebGPU.** There is no disjoint flag. `EXT_disjoint_timer_query` is a WebGL extension;
 *     WebGPU's timestamp-query API exposes no equivalent, and three's `WebGPUTimestampQueryPool`
 *     has no disjoint branch at all — it returns `lastValue` on a re-entrant resolve, a mapped
 *     result buffer or a throw, and never because of a disjoint. "How many disjoints occurred" is
 *     not a question this backend can be asked.
 *   - **WebGL2 fallback.** `GPU_DISJOINT_EXT` exists — and reading it RESETS IT TO FALSE, by
 *     specification. three's pool reads it as its own correctness check
 *     (`WebGLTimestampQueryPool.js:329-334`) and discards the reading when it is set. A second read
 *     from this profiler would consume the flag before three saw it and make three accept a timing
 *     the spec says is unreliable — the instrument would corrupt the thing it was measuring. So it
 *     is deliberately not read, and `adjacentDuplicates` carries the signal instead.
 */
export function describeDisjointObservability(backend) {
  const name = String(backend ?? 'unknown');
  if (name === 'webgpu') {
    return Object.freeze({
      observable: false,
      observed: null,
      reason: 'WebGPU exposes no disjoint flag — EXT_disjoint_timer_query is a WebGL extension and three\'s WebGPUTimestampQueryPool has no disjoint branch, so this is not a question the backend can be asked.',
    });
  }
  if (name === 'webgl2' || name === 'webgl') {
    return Object.freeze({
      observable: false,
      observed: null,
      reason: 'GPU_DISJOINT_EXT is RESET TO FALSE BY READING IT, and three\'s own pool reads it as its correctness check (WebGLTimestampQueryPool.js:329-334); a second read here would consume the flag before three saw it and make three accept a timing the spec calls unreliable. It is deliberately not read.',
    });
  }
  return Object.freeze({
    observable: false,
    observed: null,
    reason: `no disjoint observation path is known for the "${name}" backend, so nothing was counted.`,
  });
}

/* ------------------------------------------------------------------- report assembly -- */

/**
 * Fields without which a measurement is not a measurement.
 *
 * This repo already holds three mutually inconsistent draw-call numbers — 1,461 hardcoded, 1,439 in
 * prose, 1,397 measured — and none of them records the pose, the backend, the layer set or whether
 * the vegetation pack had mounted, so none of them can be reconciled with any other. A report that
 * cannot say what it measured is what produced that, so this one refuses to exist without it.
 */
const REQUIRED_ENVIRONMENT = Object.freeze([
  'viewportWidth', 'viewportHeight', 'devicePixelRatio', 'rendererPixelRatio',
  'gpuVendor', 'gpuRenderer', 'backend',
]);
const REQUIRED_BUILD = Object.freeze(['href', 'threeVersion', 'renderer', 'mode']);

export function buildProfileReport(input = {}) {
  const {
    at, build, environment, layers, vegetation, waterfall, presets, selfTest = null,
    ablation = null, request = null, notes = [], shadows = null,
  } = input;

  const missing = [];
  for (const key of REQUIRED_BUILD) if (build?.[key] === undefined || build?.[key] === null) missing.push(`build.${key}`);
  for (const key of REQUIRED_ENVIRONMENT) if (environment?.[key] === undefined) missing.push(`environment.${key}`);
  if (vegetation?.mounted === undefined) missing.push('vegetation.mounted');
  // Since 2026-09-03 the shadow policy is the single largest term in `render` (12.45 -> 6.50 ms at
  // founder-a). A report that cannot say whether the depth map was frozen cannot be compared with
  // any other report — which is exactly the three-inconsistent-draw-call-numbers problem this
  // function exists to stop repeating, so it is a missing field and not an optional one.
  if (shadows?.mode === undefined) missing.push('shadows.mode');
  if (!Array.isArray(presets) || !presets.length) missing.push('presets');
  if (missing.length) {
    throw new Error(`render profile report is not self-describing; missing: ${missing.join(', ')}`);
  }
  const ablationStamp = describeAblationStamp(ablation);

  return Object.freeze({
    schema: PROFILE_SCHEMA,
    at: at ?? null,
    request,
    build: Object.freeze({ ...build }),
    environment: Object.freeze({ ...environment }),
    layers: Object.freeze({ ...(layers ?? {}) }),
    // Hoisted to the top level and never optional: every recorded measurement in this repo was
    // taken with the pack still loading, and every one of them is therefore about a forest that is
    // not the one production draws.
    vegetation: Object.freeze({ ...vegetation }),
    // `mode`, `invalidations` and `byReason` straight off the shadow controller. Not derived from
    // the URL: `?shadows=liv` is a typo that leaves the map frozen, and a report that quoted the URL
    // would say "live" about a frozen run.
    shadows: Object.freeze({ ...shadows }),
    waterfall: waterfall ?? null,
    presets: Object.freeze(presets.map((p) => Object.freeze({ ...p }))),
    // A self-tested run is a discrimination check, NOT a baseline. Present and non-null is the
    // whole warning; a reader who ignores it gets numbers with 4 ms of deliberate cost in them.
    selfTest,
    // An ablated run is an ATTRIBUTION SPIKE, also not a baseline — and `pixelIdentical` separates
    // "this should look the same and that is the claim under test" from "this deliberately draws a
    // different picture". Both stamp; they stamp differently. See `describeAblationStamp`.
    ablation,
    // Where a run was BOTH, both notes are here and neither is dropped for the other.
    notes: Object.freeze([
      ...(selfTest ? [`SELF-TEST RUN — NOT A BASELINE: ${selfTest.label ?? selfTest.kind}`] : []),
      ...(ablationStamp ? [ablationStamp] : []),
      ...(ablation && ablation.heldThroughout === false
        ? ['THE ABLATION DID NOT HOLD FOR THE WHOLE RUN — something restored what it switched off. Read ablation.verified; these numbers describe neither arm cleanly.']
        : []),
      ...notes,
    ]),
  });
}

/**
 * One preset's block. Kept separate from `buildProfileReport` so the per-preset shape can be
 * asserted on its own, and so a preset that failed to run can be recorded as a failure rather than
 * silently dropped — a missing preset would otherwise read as "not measured yet" forever.
 */
export function buildPresetResult({
  name, view, hash = null, note = null, error = null,
  warmupFrames = 0, phaseSummary = null, events = null, gpu = null,
  renderInfo = null, memory = null, overlayReflow = null, windowMs = null, overlayItems = null,
}) {
  if (!name) throw new Error('a preset result needs the preset name');
  if (error) {
    return Object.freeze({ name, hash, note, view: view ?? null, ok: false, error: String(error) });
  }
  return Object.freeze({
    name, hash, note, ok: true,
    view: Object.freeze({ ...(view ?? {}) }),
    frames: Object.freeze({
      warmupDiscarded: warmupFrames,
      // `?? null`, never `?? 0`: a preset with no phase summary was not measured, and a 0 here
      // would read as "measured, and zero frames landed" — a different and much worse claim.
      sampled: phaseSummary?.frames ?? null,
      windowMs,
    }),
    // CPU frame time is always present; GPU frame time is present only when a GPU timer produced it.
    cpuFrameMs: phaseSummary?.total ?? null,
    gpuFrameMs: gpu?.frameMs ?? null,
    gpuTiming: gpu ?? null,
    phases: phaseSummary?.phases ?? null,
    unaccountedMs: phaseSummary?.unaccounted ?? null,
    events,
    renderInfo: renderInfo ? Object.freeze({ ...renderInfo }) : null,
    memory: memory ? Object.freeze({ ...memory }) : null,
    overlayItems,
    overlayReflow,
  });
}

/**
 * The DOM overlay's forced-layout cost, as a difference between two variants of the SAME loop.
 *
 * `updateOverlayPositions()` writes `element.hidden`, reads `offsetWidth`/`offsetHeight`, then
 * writes `style.transform`, per item, in one loop. Any style write invalidates layout for the
 * document and the next read forces the browser to flush it, so the interleaving is the cost — but
 * a stopwatch around the whole loop cannot separate that from the projection maths, the allocation
 * or the transform writes, all of which happen in the same loop.
 *
 * So the probe runs the real loop and a batched variant that reads every box first and writes every
 * transform after, ALTERNATING frames so neither variant benefits from the other having just
 * flushed layout, and reports the difference. Both variants produce identical transforms; only the
 * read/write ordering differs. The delta is therefore attributable to the ordering and to nothing
 * else in the loop.
 *
 * It is a SEPARATE pass from the steady-state window, and its frames are excluded from the frame
 * times above — running two variants inside the measured window would have contaminated the number
 * the whole report is for.
 */
export function summarizeOverlayReflow({ interleaved = [], batched = [], visibleItems = null } = {}) {
  const a = summarize(interleaved);
  const b = summarize(batched);
  if (!a || !b) {
    return Object.freeze({
      measured: false,
      reason: 'the reflow probe needs samples of both loop variants',
      interleavedMs: a, batchedMs: b,
    });
  }
  const perItem = visibleItems && visibleItems > 0 ? (a.median - b.median) / visibleItems : null;
  return Object.freeze({
    measured: true,
    method: 'alternating frames: the shipped interleaved loop vs a read-all-then-write-all variant producing identical transforms',
    visibleItems,
    interleavedMs: a,
    batchedMs: b,
    forcedLayoutMs: Object.freeze({
      // A DIFFERENCE OF MEDIANS, not the median of per-frame differences: the two variants run on
      // alternating frames and are not paired observations of the same frame, so there is no
      // per-frame difference to take a median of. Named here so nobody reads `median` as "the
      // median forced-layout cost of a frame" — it is the median interleaved frame minus the median
      // batched frame, and the same for p95.
      basis: 'difference of medians (and of p95s) between two alternating frame populations — NOT a per-frame paired difference',
      median: a.median - b.median,
      p95: a.p95 - b.p95,
      perVisibleItemMs: perItem,
      unit: 'ms',
    }),
  });
}

/**
 * Heap movement across the sampling window, and what it can and cannot say.
 *
 * `performance.memory` is Chrome-only, and its `usedJSHeapSize` is quantised and rate-limited, so
 * the per-frame allocation figure below is a floor, not a total. What it IS good for is the GC
 * signal: the heap only shrinks when a collection ran, so a count of downward steps across a fixed
 * frame window is a real observation of collection frequency. §6.3 of the pipeline map puts ~6
 * short-lived objects per visible overlay item per rendered frame on this path; this is the
 * instrument that says whether that shows up.
 */
export function summarizeHeap(samples = []) {
  const clean = samples.map(finite).filter((v) => v !== null);
  if (clean.length < 2) {
    return Object.freeze({ measured: false, reason: 'performance.memory is not exposed on this browser' });
  }
  const rises = [];
  let collections = 0;
  let reclaimed = 0;
  for (let i = 1; i < clean.length; i += 1) {
    const delta = clean[i] - clean[i - 1];
    if (delta > 0) rises.push(delta);
    else if (delta < 0) { collections += 1; reclaimed += -delta; }
  }
  return Object.freeze({
    measured: true,
    source: 'performance.memory.usedJSHeapSize',
    // Both figures are LOWER BOUNDS, and the earlier wording of this caveat said the collection
    // count was not — an assertion nothing here measures. `usedJSHeapSize` is quantised and
    // rate-limited, so two collections between consecutive samples read as one downward step and a
    // collection that reclaims less than the quantum reads as none at all. `collectionsObserved`
    // is a count of DOWNWARD STEPS SEEN, which is what its name says and all it can be.
    caveat: 'quantised and rate-limited by Chrome. Allocation figures are a lower bound (rises are net of any collection inside the same interval), and so is the collection count (two collections between samples read as one; one smaller than the quantum reads as none). Neither is an upper bound on anything.',
    samples: clean.length,
    startBytes: clean[0],
    endBytes: clean[clean.length - 1],
    peakBytes: Math.max(...clean),
    netBytes: clean[clean.length - 1] - clean[0],
    perFrameRiseBytes: summarize(rises, { unit: 'bytes' }),
    collectionsObserved: collections,
    reclaimedBytes: reclaimed,
  });
}

/**
 * A GPU-memory estimate from what the scene actually holds, labelled as the estimate it is.
 *
 * `renderer.info.memory` counts RESIDENT geometries and textures — objects, not bytes — so it
 * cannot answer "how much VRAM". The byte figures here are computed from the attribute and image
 * dimensions the caller walked out of the scene graph, with the assumptions stated in the result,
 * because a number whose assumptions are not attached is the thing this whole file is a reaction to.
 */
export function summarizeGpuMemory({
  geometries = null, textures = null, attributeBytes = 0, indexBytes = 0, textureBytes = 0,
  compressedTextures = 0, mipmapAssumption = 1.3333,
} = {}) {
  return Object.freeze({
    method: 'scene-graph traversal; byte figures are ESTIMATES, not a VRAM reading',
    assumptions: Object.freeze([
      'attribute and index bytes are exact (typed-array byteLength)',
      `texture bytes assume 4 bytes/texel and a x${mipmapAssumption} mip chain where mipmaps are generated`,
      'GPU-compressed (KTX2/Basis) textures are counted at their uncompressed texel cost and are therefore OVERSTATED',
      'driver-side padding, alignment and render targets are not counted and are therefore UNDERSTATED',
    ]),
    residentGeometries: geometries,
    residentTextures: textures,
    compressedTextures,
    attributeBytes,
    indexBytes,
    textureBytes,
    totalBytes: attributeBytes + indexBytes + textureBytes,
  });
}
