/**
 * The render profiler's pure half, and the two properties the browser half has to keep.
 *
 * Handoff §7: *"when you add an assertion, prove it discriminates."* An instrument is an assertion
 * about cost, so the tests below are written to fail if it stops discriminating:
 *
 *  - the statistics move when the sample moves, and p95 is a value that was actually observed;
 *  - the phase ledger's residual is real arithmetic and grows when a phase goes unrecorded;
 *  - a report that cannot say what it measured is REFUSED, not emitted with holes;
 *  - GPU frame time is never backfilled from CPU frame time;
 *  - the shipped frame path in src/map3d-three.js carries no timing statement (source-pinned),
 *    which is the only way to check "zero cost when off" without a browser.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  FRAME_PHASES, PROFILE_PRESETS, PROFILE_PRESET_NAMES, PROFILE_SCHEMA,
  buildPresetResult, buildProfileReport, compareSummaries, createEventLedger, createPhaseLedger,
  createWaterfall, describeDisjointObservability, describeGpuTiming, isProfilingRequested,
  parseProfileRequest, parseSelfTest,
  summarize, summarizeGpuMemory, summarizeHeap, summarizeOverlayReflow,
  ABLATION_TARGETS, ABLATION_TARGET_NAMES, describeAblationSeries, describeAblationStamp,
  parseAblation,
} from '../src/render-profiler.js';

const renderer = await readFile(new URL('../src/map3d-three.js', import.meta.url), 'utf8');
const profiler = await readFile(new URL('../src/render-profiler.js', import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/** The same file with every comment removed — for assertions about what the CODE does. */
const profilerCode = stripComments(profiler);
const rendererCode = stripComments(renderer);

/* ------------------------------------------------------------------- the run switch -- */

test('(d) profiling is asked for by URL, and by nothing else', () => {
  assert.equal(isProfilingRequested('?profile=1'), true);
  assert.equal(isProfilingRequested('?profile'), true);
  assert.equal(isProfilingRequested('?profile=yes&renderer=three'), true);
  // Turn-off-able without deleting the parameter — a URL a human retypes has to have an off.
  for (const off of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.equal(isProfilingRequested(`?profile=${off}`), false, off);
  }
  assert.equal(isProfilingRequested(''), false);
  assert.equal(isProfilingRequested('?renderer=three'), false);
  assert.equal(isProfilingRequested(undefined), false);
});

test('(d) the run switch is NOT the diagnostic-readout gate, and cannot become it', () => {
  // The reason, in full, is in src/render-profiler.js's header: `canShowDiagnosticReadouts()` is
  // dev + loopback, and BOTH configurations where a real-GPU baseline can be taken (a release
  // `vite preview` on 127.0.0.1, and tarkovzero.com on the founder's machine) answer it false.
  // Pinned by source so a later hand cannot "tidy" the profiler behind the banner gate and make the
  // instrument unrunnable on the only real GPU in the project.
  assert.doesNotMatch(profiler, /^import[\s\S]*?renderer-gate/m, 'the profiler must not import the renderer gate');
  assert.doesNotMatch(profiler, /from '\.\/renderer-gate\.js'/);
  // The header explains the boundary at length, by name; what must not exist is a CALL to either
  // predicate, so the assertion is made against the CODE with comments stripped.
  assert.doesNotMatch(profilerCode, /canShowDiagnosticReadouts|canLoadLocalGameDerivedAssets/);
  assert.match(
    profiler,
    /export function isProfilingRequested\(search\) \{/,
    'the profiler predicate must be its own function taking only the query string',
  );
  // ...and the renderer must arm it from that predicate, never from the gate's readout answer.
  assert.match(renderer, /const profileRequest = parseProfileRequest\(location\.search\);/);
  assert.doesNotMatch(renderer, /profileRequest\.armed\s*&&\s*diagnosticReadoutsVisible/);
  assert.doesNotMatch(renderer, /diagnosticReadoutsVisible\s*&&\s*profileRequest\.armed/);
});

test('the request parses frames, presets and the self-test, and clamps nonsense', () => {
  const dflt = parseProfileRequest('?profile=1');
  assert.equal(dflt.armed, true);
  assert.equal(dflt.warmupFrames, 30);
  assert.equal(dflt.sampleFrames, 180);
  assert.deepEqual([...dflt.presets], [...PROFILE_PRESET_NAMES]);
  assert.equal(dflt.selfTest, null);

  const tuned = parseProfileRequest('?profile=1&profileFrames=60&profileWarmup=5&profilePresets=founder-a,cover-fit');
  assert.equal(tuned.sampleFrames, 60);
  assert.equal(tuned.warmupFrames, 5);
  assert.deepEqual([...tuned.presets], ['founder-a', 'cover-fit']);

  // A typo must not silently narrow the run to nothing — it is reported and the full set is kept.
  const typo = parseProfileRequest('?profile=1&profilePresets=founder-α');
  assert.deepEqual([...typo.unknownPresets], ['founder-α']);
  assert.deepEqual([...typo.presets], [...PROFILE_PRESET_NAMES]);

  // Absurd frame counts are clamped rather than accepted, so a run cannot be asked to sample 10
  // frames' worth of nothing or hang the page for an hour.
  assert.equal(parseProfileRequest('?profile=1&profileFrames=1').sampleFrames, 10);
  assert.equal(parseProfileRequest('?profile=1&profileFrames=999999').sampleFrames, 2000);
  assert.equal(parseProfileRequest('?profile=1&profileFrames=banana').sampleFrames, 180);
});

test('the self-test is parsed, bounded, and always labelled', () => {
  assert.equal(parseSelfTest(''), null);
  assert.equal(parseSelfTest('none'), null);
  assert.deepEqual({ ...parseSelfTest('busy:4') }, { kind: 'busy', busyMs: 4, label: '4 ms busy-loop injected into the overlay pass' });
  assert.equal(parseSelfTest('busy').busyMs, 4);
  assert.equal(parseSelfTest('busy:9999').busyMs, 200, 'a self-test must not be able to wedge the page');
  assert.equal(parseSelfTest('nocull').kind, 'nocull');
  assert.equal(parseSelfTest('wat').kind, 'unknown');
});

/* ---------------------------------------------------------------------- ablations -- */

test('the ablation flags parse, combine, canonicalise, and refuse a typo silently', () => {
  assert.equal(parseAblation(''), null);
  assert.equal(parseAblation(null), null);
  for (const off of ['none', 'off', '0', 'OFF']) assert.equal(parseAblation(off), null, off);

  const shadow = parseAblation('shadow');
  assert.deepEqual([...shadow.targets], ['shadow']);
  assert.equal(shadow.kind, 'ablate');

  // Combining is a first-class case: attributing prop AND rock geometry together is the question
  // the "merge the small meshes" plan actually asks.
  const both = parseAblation('rocks,props');
  // Canonical order and de-duplicated, so the same experiment written two ways compares as one.
  assert.deepEqual([...both.targets], ['props', 'rocks']);
  assert.deepEqual([...parseAblation('props,rocks,props').targets], ['props', 'rocks']);
  assert.equal(both.label, parseAblation('props,rocks').label);

  // A typo must not quietly produce a clean run the founder believes is an ablation.
  const typo = parseAblation('shadws');
  assert.equal(typo.kind, 'unknown');
  assert.deepEqual([...typo.targets], []);
  assert.deepEqual([...typo.unknown], ['shadws']);
  assert.match(typo.label, /unrecognised/);
  // A mixed list keeps what it knows AND reports what it did not.
  const mixed = parseAblation('shadow,tofu');
  assert.deepEqual([...mixed.targets], ['shadow']);
  assert.deepEqual([...mixed.unknown], ['tofu']);
  // Prototype keys are not targets.
  assert.equal(parseAblation('constructor').kind, 'unknown');
  assert.equal(parseAblation('toString').kind, 'unknown');
});

test('the two ablation classes are not interchangeable, and the stamp says which', () => {
  // `shadow` claims the picture is unchanged; `props`/`rocks` deliberately change it. A report
  // taken under either must be unmistakable for a baseline, and the two must not read alike —
  // one is a candidate optimisation, the other is an attribution experiment and nothing else.
  assert.equal(ABLATION_TARGETS.shadow.pixelIdentical, true);
  assert.equal(ABLATION_TARGETS.props.pixelIdentical, false);
  assert.equal(ABLATION_TARGETS.rocks.pixelIdentical, false);
  assert.deepEqual([...ABLATION_TARGET_NAMES], ['shadow', 'props', 'rocks']);

  const identical = describeAblationStamp(parseAblation('shadow'));
  const changing = describeAblationStamp(parseAblation('props'));
  for (const stamp of [identical, changing]) assert.match(stamp, /NOT A BASELINE/);
  assert.match(identical, /Pixel-identical BY HYPOTHESIS/);
  assert.doesNotMatch(identical, /PIXELS DELIBERATELY REMOVED/);
  assert.match(changing, /PIXELS DELIBERATELY REMOVED/);
  assert.match(changing, /NOT A CANDIDATE OPTIMISATION/);

  // One pixel-changing target makes the whole combination pixel-changing — the stronger warning
  // wins, so `shadow,props` can never be read as the pixel-identical experiment.
  const mixed = parseAblation('shadow,props');
  assert.equal(mixed.pixelIdentical, false);
  assert.deepEqual([...mixed.pixelChanging], ['props']);
  assert.match(describeAblationStamp(mixed), /PIXELS DELIBERATELY REMOVED/);

  assert.equal(describeAblationStamp(null), null);
  assert.equal(describeAblationStamp(parseAblation('nonsense')), null);
});

test('an ablated report is stamped at the top of its notes, beside a self-test if there is one', () => {
  const ablated = buildProfileReport({
    at: 'now', build: BUILD, environment: ENVIRONMENT, shadows: SHADOWS, vegetation: { mounted: true }, presets: [okPreset()],
    ablation: parseAblation('props'), notes: ['a later note'],
  });
  assert.match(ablated.notes[0], /ABLATION RUN/);
  assert.equal(ablated.notes.at(-1), 'a later note');
  assert.deepEqual([...ablated.ablation.targets], ['props']);

  // Both stamps when a run was both. Neither is dropped for the other.
  const both = buildProfileReport({
    at: 'now', build: BUILD, environment: ENVIRONMENT, shadows: SHADOWS, vegetation: { mounted: true }, presets: [okPreset()],
    selfTest: { kind: 'busy', busyMs: 4, label: '4 ms' }, ablation: parseAblation('shadow'),
  });
  assert.match(both.notes[0], /SELF-TEST RUN/);
  assert.match(both.notes[1], /ABLATION RUN/);

  // An unablated report keeps its old shape: `ablation` present and null, no stamp.
  const clean = buildProfileReport({
    at: 'now', build: BUILD, environment: ENVIRONMENT, shadows: SHADOWS, vegetation: { mounted: true }, presets: [okPreset()],
  });
  assert.equal(clean.ablation, null);
  assert.equal(clean.notes.length, 0);
});

test('an ablation that did not hold puts a warning at the top, not a footnote', () => {
  // applyNature() writes rockGroup.visible and would silently restore what an ablation switched
  // off. The run measures whether it held; a run that did not hold describes neither arm, and
  // saying so quietly would be the §7 shape all over again.
  const report = buildProfileReport({
    at: 'now', build: BUILD, environment: ENVIRONMENT, shadows: SHADOWS, vegetation: { mounted: true }, presets: [okPreset()],
    ablation: { ...parseAblation('rocks'), heldThroughout: false, verified: [{ preset: 'founder-a', target: 'rocks', held: false }] },
  });
  assert.ok(report.notes.some((n) => /DID NOT HOLD/.test(n)));
  const held = buildProfileReport({
    at: 'now', build: BUILD, environment: ENVIRONMENT, shadows: SHADOWS, vegetation: { mounted: true }, presets: [okPreset()],
    ablation: { ...parseAblation('rocks'), heldThroughout: true, verified: [{ preset: 'founder-a', target: 'rocks', held: true }] },
  });
  assert.ok(!held.notes.some((n) => /DID NOT HOLD/.test(n)));
});

test('the A/B series measures its delta against its own noise, and says when it cannot', () => {
  const run = (name, cpu, drawCalls) => ({
    presets: [{
      name, ok: true,
      cpuFrameMs: summarize([cpu]),
      phases: { render: summarize([cpu - 1]) },
      renderInfo: { drawCalls, triangles: 1000, frameCalls: drawCalls > 1200 ? 2 : 1 },
    }],
  });
  // A big, clean effect: 8.0/8.2 unablated against 5.0/5.1 ablated. The delta (3.05) dwarfs the
  // widest within-arm spread (0.2), so the series attributes it.
  const strong = describeAblationSeries([
    { arm: 'A', report: run('founder-a', 8.0, 1400) },
    { arm: 'B', report: run('founder-a', 5.0, 900) },
    { arm: 'A', report: run('founder-a', 8.2, 1400) },
    { arm: 'B', report: run('founder-a', 5.1, 900) },
  ]);
  const cpu = strong.presets['founder-a'].cpuFrameMedianMs;
  assert.equal(cpu.aMedian, 8.1);
  assert.equal(cpu.bMedian, 5.05);
  assert.ok(Math.abs(cpu.delta - -3.05) < 1e-9);
  assert.ok(Math.abs(cpu.withinArmSpread - 0.2) < 1e-9);
  assert.match(cpu.verdict, /LARGER than the widest within-arm spread/);
  assert.deepEqual({ ...strong.runsPerArm }, { A: 2, B: 2 });

  // THE DISCRIMINATION CHECK, in the direction that matters: a delta INSIDE the run-to-run noise
  // must not be reported as an attribution. GPU numbers here already move 1-4 ms for no reason.
  const noisy = describeAblationSeries([
    { arm: 'A', report: run('founder-a', 8.0, 1400) },
    { arm: 'B', report: run('founder-a', 7.6, 1400) },
    { arm: 'A', report: run('founder-a', 6.0, 1400) },
    { arm: 'B', report: run('founder-a', 9.2, 1400) },
  ]);
  assert.match(noisy.presets['founder-a'].cpuFrameMedianMs.verdict, /INSIDE the within-arm spread/);

  // One run per arm cannot know its own noise, and must say so rather than pick a threshold.
  const single = describeAblationSeries([
    { arm: 'A', report: run('founder-a', 8.0, 1400) },
    { arm: 'B', report: run('founder-a', 5.0, 900) },
  ]);
  assert.equal(single.presets['founder-a'].cpuFrameMedianMs.withinArmSpread, null);
  assert.match(single.presets['founder-a'].cpuFrameMedianMs.verdict, /ONE RUN PER ARM/);

  // A metric nothing produced is "not measured in both arms", never a zero delta.
  assert.equal(single.presets['founder-a'].gpuFrameMedianMs.delta, null);
  assert.match(single.presets['founder-a'].gpuFrameMedianMs.verdict, /not measured in both arms/);
  // And frameCalls is carried, because 2 → 1 is the crispest proof the shadow pass stopped running.
  assert.equal(strong.presets['founder-a'].frameCalls.aMedian, 2);
  assert.equal(strong.presets['founder-a'].frameCalls.bMedian, 1);

  assert.deepEqual({ ...describeAblationSeries([]).runsPerArm }, { A: 0, B: 0 });
  assert.deepEqual(describeAblationSeries(null).presets, {});
});

test('the presets include the founder\'s own two poses, verbatim', () => {
  const byName = Object.fromEntries(PROFILE_PRESETS.map((p) => [p.name, p]));
  assert.equal(byName['founder-a'].hash, '#3.48/257.7/-42.3');
  assert.equal(byName['founder-b'].hash, '#3.92/257.9/-22.1');
  assert.equal(byName['cover-fit'].fit, true);
  // The close-in view is close-in AND low: a top-down zoom would not stress the overlay or the
  // terrain shader, which is the whole reason this preset exists.
  assert.ok(byName['ground-close'].zoom2d > byName['founder-b'].zoom2d);
  assert.ok(byName['ground-close'].rotationX < 32);
  assert.ok(byName['ground-close'].rotationX > 9, 'below CAM.minRotationX the camera is underground');
});

/* --------------------------------------------------------------------- statistics -- */

test('summarize reports median, p95 and n — and p95 is an OBSERVED value', () => {
  const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  const s = summarize(values);
  assert.equal(s.n, 100);
  assert.equal(s.min, 1);
  assert.equal(s.max, 100);
  assert.equal(s.median, 50.5);
  // nearest-rank: ceil(0.95 * 100) = 95 → the 95th smallest, which is 95. An interpolating method
  // would return 95.05, a number nothing measured.
  assert.equal(s.p95, 95);
  assert.ok(values.includes(s.p95), 'p95 must be a value that was actually observed');
  assert.equal(s.percentileMethod, 'nearest-rank');
  assert.equal(s.medianInterpolated, true);
});

test('the mean hides the hitch that p95 reports — which is why both ship', () => {
  // 108 good frames and 12 stalls — a tenth of the window, which is what a hitchy pan feels like.
  const smooth = summarize(Array(120).fill(4));
  const hitched = summarize([...Array(108).fill(4), ...Array(12).fill(400)]);
  assert.equal(smooth.median, 4);
  assert.equal(hitched.median, 4, 'the median cannot see the stall either — p95 is why it is here');
  assert.equal(smooth.p95, 4);
  assert.equal(hitched.p95, 400, 'p95 is what makes the stall visible');
  // And a SINGLE stall in 120 frames is below the 95th percentile by construction: p95 reports 4,
  // and `max` is the field that carries it. Stated so nobody reads p95 as a hitch detector.
  assert.equal(summarize([...Array(119).fill(4), 400]).p95, 4);
  assert.equal(summarize([...Array(119).fill(4), 400]).max, 400);
});

test('summarize refuses to invent a sample', () => {
  assert.equal(summarize([]), null);
  assert.equal(summarize(null), null);
  assert.equal(summarize([NaN, undefined, 'x']), null);
  // Non-numbers are dropped, not coerced to zero — a zero would read as a free frame.
  assert.equal(summarize([5, NaN, 7]).n, 2);
});

test('compareSummaries is what a discrimination check reads', () => {
  const before = summarize(Array(50).fill(4));
  const after = summarize(Array(50).fill(8));
  const delta = compareSummaries(before, after);
  assert.equal(delta.medianDelta, 4);
  assert.equal(delta.medianRatio, 2);
  assert.equal(compareSummaries(null, after), null);
});

/* ----------------------------------------------------------------- phase accounting -- */

test('the phase ledger accounts for the whole frame, and names what it cannot explain', () => {
  const ledger = createPhaseLedger();
  for (let i = 0; i < 10; i += 1) {
    ledger.beginFrame();
    ledger.record('controls', 0.1);
    ledger.record('lod', 0.2);
    ledger.record('overlay', 3);
    ledger.record('render', 5);
    ledger.endFrame(9.3); // 8.3 named + 1.0 that nothing claimed
  }
  const summary = ledger.summarize();
  assert.equal(summary.frames, 10);
  assert.equal(summary.total.median, 9.3);
  assert.ok(Math.abs(summary.phases.overlay.median - 3) < 1e-9);
  assert.ok(Math.abs(summary.unaccounted.median - 1) < 1e-9, 'the residual must be real arithmetic');
});

test('an unrecorded phase shows up in the residual instead of vanishing', () => {
  // THE DISCRIMINATION CHECK for the breakdown. If a phase stops being timed, the numbers must
  // move — the failure this repo keeps hitting is a metric that reads the same either way.
  const complete = createPhaseLedger();
  const missing = createPhaseLedger();
  for (let i = 0; i < 20; i += 1) {
    complete.beginFrame();
    for (const [name, ms] of [['controls', 0.1], ['lod', 0.2], ['overlay', 3], ['render', 5]]) complete.record(name, ms);
    complete.endFrame(8.3);

    missing.beginFrame();
    for (const [name, ms] of [['controls', 0.1], ['lod', 0.2], ['render', 5]]) missing.record(name, ms);
    missing.endFrame(8.3);
  }
  assert.ok(Math.abs(complete.summarize().unaccounted.median) < 1e-9);
  assert.ok(Math.abs(missing.summarize().unaccounted.median - 3) < 1e-9);
  assert.equal(missing.summarize().phases.overlay, null, 'a phase with no samples reports null, not 0');
});

test('a frame with no total is discarded rather than half-counted', () => {
  const ledger = createPhaseLedger();
  ledger.beginFrame();
  ledger.record('render', 5);
  assert.equal(ledger.endFrame(undefined), false);
  assert.equal(ledger.frames, 0);
  assert.equal(ledger.summarize().total, null);
});

test('a phase recorded outside a frame, or under an unknown name, is ignored', () => {
  const ledger = createPhaseLedger();
  ledger.record('render', 99);            // no open frame
  ledger.beginFrame();
  ledger.record('teleportation', 99);     // not a phase this ledger knows
  ledger.record('render', 5);
  ledger.endFrame(5);
  assert.ok(Math.abs(ledger.summarize().unaccounted.median) < 1e-9);
  assert.deepEqual(Object.keys(ledger.summarize().phases), [...FRAME_PHASES]);
});

test('event work is counted per event and per second, never per frame', () => {
  const events = createEventLedger();
  events.record('refreshDynamic', 12);
  events.record('refreshDynamic', 8);
  events.record('raycast', 0.4);
  const summary = events.summarize(2000);
  assert.equal(summary.refreshDynamic.events, 2);
  assert.equal(summary.refreshDynamic.totalMs, 20);
  assert.equal(summary.refreshDynamic.msPerSecond, 10);
  assert.equal(summary.vegetationRepack.events, 0);
  assert.equal(summary.vegetationRepack.each, null);
});

/* ------------------------------------------------------------------------ waterfall -- */

test('the waterfall keeps overlap visible and never sums overlapping phases', () => {
  const wf = createWaterfall();
  wf.mark('boot', 0);
  wf.begin('terrainPackage', 10);
  wf.begin('mapDataFetch', 12);
  wf.end('mapDataFetch', 900);
  wf.end('terrainPackage', 1200);
  const described = wf.describe(1500);
  assert.deepEqual(described.phases.map((p) => p.phase), ['boot', 'terrainPackage', 'mapDataFetch']);
  // 888 + 1190 = 2078 ms of phase duration inside a 1200 ms span. A serial sum would have reported
  // the page as taking almost twice as long as it did.
  assert.equal(described.spanMs, 1200);
  assert.equal(described.phases.find((p) => p.phase === 'mapDataFetch').durationMs, 888);
});

test('a phase still running when the report is taken says so', () => {
  // The authored vegetation mount takes 60-85 s and is never awaited. A waterfall that closed it
  // silently would describe a page that is still loading as one that has finished — which is
  // exactly how every recorded measurement in this repo came to describe the wrong forest.
  const wf = createWaterfall();
  wf.begin('vegetationMount', 100);
  wf.mark('firstRender', 4000);
  const described = wf.describe(30000);
  const mount = described.phases.find((p) => p.phase === 'vegetationMount');
  assert.equal(mount.endMs, null);
  assert.equal(mount.durationMs, null);
  assert.equal(mount.openForMs, 29900);
  assert.deepEqual([...described.openPhases], ['vegetationMount']);
});

/* ----------------------------------------------------------------------- GPU timing -- */

test('no GPU timer means null, and CPU time is never substituted', () => {
  const gpu = describeGpuTiming({ available: false, reason: 'the webgl2 backend does not expose a timestamp query', values: [4, 4, 4] });
  assert.equal(gpu.available, false);
  assert.equal(gpu.frameMs, null, 'values must be ignored when the timer was not available');
  assert.match(gpu.reason, /timestamp query/);
});

test('an available timer that resolved nothing reports that, not a zero', () => {
  const gpu = describeGpuTiming({ available: true, method: 'x', values: [], resolveCalls: 40 });
  assert.equal(gpu.available, false);
  assert.equal(gpu.frameMs, null);
  assert.equal(gpu.reason, 'no samples resolved');
  assert.ok(gpu.warnings.some((w) => /no samples/.test(w)));
});

test('repeated GPU readings are surfaced, because three returns its last value on a disjoint', () => {
  // WebGLTimestampQueryPool.js:329-334 — on GPU_DISJOINT_EXT the pool resolves with `lastValue`.
  // A harness that averaged those would report a smooth GPU time for a frame nobody timed.
  const stale = describeGpuTiming({
    available: true, method: 'x', values: Array(20).fill(3.2), resolveCalls: 20, adjacentDuplicates: 19,
  });
  assert.equal(stale.health.suspectRepeatShare, 1);
  assert.ok(stale.warnings.some((w) => /stale/.test(w)), 'a fully repeating series must be called out');

  const healthy = describeGpuTiming({
    available: true, method: 'x', backend: 'webgpu',
    values: [3.1, 3.4, 3.2, 3.9, 3.3], resolveCalls: 5, adjacentDuplicates: 0,
  });
  assert.equal(healthy.available, true);
  assert.equal(healthy.frameMs.n, 5);
  // No STALENESS warning: nothing repeated. The one warning a clean run still carries is the
  // standing statement that disjoints went uncounted, which is true of every run on this backend
  // and must not be silently dropped just because the numbers look healthy.
  assert.ok(!healthy.warnings.some((w) => /may be stale|no samples/.test(w)));
  assert.deepEqual([...healthy.warnings].map((w) => w.slice(0, 26)), ['disjoints were NOT counted']);
});

test('an observed disjoint flag is always reported', () => {
  // The slot a backend that CAN count them fills. Passing an observable channel with a real count
  // must still produce the warning — this is the discrimination check for the field: if it only
  // ever reported "not observable", nothing would prove it can carry a number.
  const gpu = describeGpuTiming({
    available: true, method: 'x', values: [3, 4], backend: 'imaginary',
    disjoint: { observable: true, observed: 2, reason: 'a backend that counts them' },
  });
  assert.equal(gpu.health.disjointObserved, 2);
  assert.equal(gpu.health.disjointObservable, true);
  assert.ok(gpu.warnings.some((w) => /disjoint flag was observed 2 time/.test(w)));
  // ...and an observable channel that genuinely saw none reports 0, which is now a real zero.
  const clean = describeGpuTiming({
    available: true, method: 'x', values: [3, 4], backend: 'imaginary',
    disjoint: { observable: true, observed: 0, reason: 'a backend that counts them' },
  });
  assert.equal(clean.health.disjointObserved, 0);
  assert.ok(!clean.warnings.some((w) => /disjoint flag was observed/.test(w)));
});

test('disjointObserved is NULL, not zero, on every backend that cannot count them', () => {
  // THE FIX. `disjointObserved: 0` was hardcoded at the call site: a field named for a condition,
  // holding a number nothing observed, which any reader would take as proof none occurred. That is
  // handoff §7's shape — a metric that cannot detect the thing it exists to report — and the same
  // collapse of "measured zero" into "never looked" that this module's header cites at
  // map3d.js:2272. Both backends this app can reach are covered:
  for (const backend of ['webgpu', 'webgl2']) {
    const gpu = describeGpuTiming({
      available: true, method: 'x', backend, values: [3.1, 3.4, 3.2], resolveCalls: 3,
    });
    assert.equal(gpu.health.disjointObserved, null, `${backend}: must be null, never 0`);
    assert.notEqual(gpu.health.disjointObserved, 0, `${backend}: a 0 here reads as proof of absence`);
    assert.equal(gpu.health.disjointObservable, false, backend);
    assert.ok(gpu.health.disjointReason.length > 40, `${backend}: the reason must be stated, not implied`);
    // A run with usable GPU numbers must SAY that disjoints went uncounted, and point at what did
    // get counted — otherwise the null is a silent hole rather than a stated one.
    assert.ok(gpu.warnings.some((w) => /disjoints were NOT counted/.test(w)), backend);
    assert.ok(gpu.warnings.some((w) => /adjacentDuplicates/.test(w)), backend);
  }
  // WebGPU: the concept does not exist. WebGL2: the flag exists but READING IT CLEARS IT, out from
  // under three's own check — so reading it would corrupt the library's correctness test.
  assert.match(describeDisjointObservability('webgpu').reason, /no disjoint flag/i);
  assert.match(describeDisjointObservability('webgl2').reason, /RESET TO FALSE BY READING IT/);
  assert.match(describeDisjointObservability('vulkan-someday').reason, /no disjoint observation path is known/);
  for (const backend of ['webgpu', 'webgl2', 'vulkan-someday', undefined]) {
    assert.equal(describeDisjointObservability(backend).observable, false, String(backend));
    assert.equal(describeDisjointObservability(backend).observed, null, String(backend));
  }
});

test('a hardcoded disjoint count cannot come back — pinned by source, in both halves', () => {
  // The defect was one literal at one call site. This is the assertion that fails if a later hand
  // reintroduces it, in either file, in any of the ways it would be written.
  for (const [label, code] of [['src/render-profiler.js', profilerCode], ['src/map3d-three.js', rendererCode]]) {
    assert.doesNotMatch(code, /disjointObserved\s*[:=]\s*\d/, `${label}: disjointObserved must never be assigned a literal number`);
    assert.doesNotMatch(code, /disjointObserved\s*[:=]\s*(true|false)/, `${label}: nor a literal boolean`);
  }
  // The renderer must hand the pure half the OBSERVABILITY of its own backend, not a count.
  assert.match(rendererCode, /disjoint: describeDisjointObservability\(status\.backend\)/);
  // And the environment field about the WebGL extension must not claim a confident `false` on a
  // backend that has no such property — `Boolean(renderer.backend?.disjoint)` did exactly that.
  assert.doesNotMatch(rendererCode, /const disjointExtensionPresent = Boolean\(/);
  assert.match(rendererCode, /status\.backend === 'webgpu'\s*\n?\s*\? null/);
});

test('the schema was bumped, because a field changed meaning', () => {
  // A `/1` reader seeing `null` where it expected a count would treat the absence as a zero — the
  // exact mistake the change exists to stop. The version is the only thing that stops it.
  assert.equal(PROFILE_SCHEMA, 'tz-render-profile/2');
});

/* ----------------------------------------------------------------- the overlay probe -- */

test('the reflow probe reports the difference between the two loop orderings', () => {
  const probe = summarizeOverlayReflow({
    interleaved: [9, 10, 11, 10, 10],
    batched: [4, 4, 5, 4, 4],
    visibleItems: 600,
  });
  assert.equal(probe.measured, true);
  assert.equal(probe.forcedLayoutMs.median, 6);
  assert.equal(probe.forcedLayoutMs.perVisibleItemMs, 0.01);
  assert.match(probe.method, /identical transforms/);
  // `median` here is a difference of two medians, not the median of per-frame differences — the
  // variants run on alternating frames and are not paired observations. The field says so, because
  // "median" alone reads as "the median cost of a frame", which is not what it is.
  assert.match(probe.forcedLayoutMs.basis, /difference of medians/);
  assert.match(probe.forcedLayoutMs.basis, /NOT a per-frame paired difference/);
});

test('a preset with no phase summary reports null frames sampled, never zero', () => {
  // `?? 0` collapsed "not measured" into "measured, and zero frames landed". The second is a much
  // stronger claim than anything that path knows.
  const bare = buildPresetResult({ name: 'founder-a', view: {} });
  assert.equal(bare.frames.sampled, null);
  assert.notEqual(bare.frames.sampled, 0);
  assert.equal(bare.cpuFrameMs, null);
});

test('the reflow probe refuses to report a difference it did not measure', () => {
  const probe = summarizeOverlayReflow({ interleaved: [9, 10], batched: [], visibleItems: 600 });
  assert.equal(probe.measured, false);
  assert.equal(probe.forcedLayoutMs, undefined);
  assert.match(probe.reason, /both loop variants/);
});

/* ---------------------------------------------------------------------------- memory -- */

test('the heap summary counts collections, and says what it cannot count', () => {
  // Rising, rising, collected, rising — the sawtooth an allocation-per-frame loop makes.
  const heap = summarizeHeap([1000, 1400, 1900, 1100, 1500, 2000, 1200]);
  assert.equal(heap.measured, true);
  assert.equal(heap.collectionsObserved, 2);
  assert.equal(heap.peakBytes, 2000);
  assert.equal(heap.perFrameRiseBytes.n, 4);
  assert.match(heap.caveat, /lower bound/);
  // The caveat used to read "allocation figures are a lower bound, collection counts are not" —
  // an assertion nothing measures, and false: `usedJSHeapSize` is quantised and rate-limited, so
  // two collections between samples read as one and a sub-quantum collection reads as none. A
  // caveat that overclaims is worse than no caveat, because it is read as a guarantee.
  assert.doesNotMatch(heap.caveat, /collection counts are not/);
  assert.match(heap.caveat, /so is the collection count/);
});

test('a browser that does not expose performance.memory gets a stated absence', () => {
  const heap = summarizeHeap([]);
  assert.equal(heap.measured, false);
  assert.match(heap.reason, /performance\.memory/);
  assert.equal(heap.peakBytes, undefined);
});

test('the GPU memory figure ships its own assumptions, in both directions', () => {
  const memory = summarizeGpuMemory({ geometries: 808, textures: 15, attributeBytes: 100, indexBytes: 20, textureBytes: 900, compressedTextures: 4 });
  assert.equal(memory.totalBytes, 1020);
  assert.match(memory.method, /ESTIMATES/);
  assert.ok(memory.assumptions.some((a) => /OVERSTATED/.test(a)));
  assert.ok(memory.assumptions.some((a) => /UNDERSTATED/.test(a)));
});

/* ----------------------------------------------------------------------- report shape -- */

const ENVIRONMENT = Object.freeze({
  viewportWidth: 1400, viewportHeight: 985, devicePixelRatio: 2, rendererPixelRatio: 1.5,
  gpuVendor: 'NVIDIA', gpuRenderer: 'NVIDIA GeForce RTX 5080', backend: 'webgpu',
});
const BUILD = Object.freeze({ href: 'http://x/', threeVersion: '185', renderer: 'three', mode: 'release' });
/**
 * The shadow policy that produced the numbers — required since 2026-09-03, because it is the single
 * largest term in `render` (12.45 -> 6.50 ms at founder-a) and a report that cannot say whether the
 * depth map was frozen cannot be compared with any other report.
 */
const SHADOWS = Object.freeze({
  mode: 'frozen-until-invalidated', autoUpdate: false, pending: false,
  invalidations: 14, byReason: { 'world-build': 1, 'procedural-suppression': 13 },
});
const okPreset = () => buildPresetResult({
  name: 'founder-a', view: { zoom: 1.4 },
  phaseSummary: { frames: 2, total: summarize([8, 9]), phases: {}, unaccounted: summarize([0, 0]) },
});

test('a report that cannot say what it measured is REFUSED', () => {
  const good = buildProfileReport({
    at: 'now', build: BUILD, environment: ENVIRONMENT, shadows: SHADOWS,
    vegetation: { mounted: true }, presets: [okPreset()],
  });
  assert.equal(good.schema, PROFILE_SCHEMA);
  // ...and the policy is carried into the report, not merely demanded of the caller. A downloaded
  // JSON has to be able to say which arm it is.
  assert.equal(good.shadows.mode, 'frozen-until-invalidated');
  assert.equal(good.shadows.autoUpdate, false);
  assert.deepEqual(good.shadows.byReason, { 'world-build': 1, 'procedural-suppression': 13 });

  // Every one of these is a field whose absence produced a number in this repo that cannot be
  // reconciled with any other number in this repo.
  for (const [label, patch] of [
    ['no GPU string', { environment: { ...ENVIRONMENT, gpuRenderer: undefined } }],
    ['no device pixel ratio', { environment: { ...ENVIRONMENT, devicePixelRatio: undefined } }],
    ['no viewport', { environment: { ...ENVIRONMENT, viewportWidth: undefined } }],
    ['no backend', { environment: { ...ENVIRONMENT, backend: undefined } }],
    ['no build identity', { build: { ...BUILD, href: undefined } }],
    ['no vegetation state', { vegetation: {} }],
    // Added 2026-09-03 with the shadow freeze. Two reports taken a week apart would otherwise have
    // a ~6 ms difference in `render` attributed to whatever changed in between, when the actual
    // cause was one boolean. `null` and `{}` are both refused: a field present but empty is exactly
    // the shape that reads as answered.
    ['no shadow policy', { shadows: null }],
    ['an empty shadow policy', { shadows: {} }],
    ['no presets', { presets: [] }],
  ]) {
    assert.throws(
      () => buildProfileReport({
        at: 'now', build: BUILD, environment: ENVIRONMENT, shadows: SHADOWS, vegetation: { mounted: true }, presets: [okPreset()], ...patch,
      }),
      /not self-describing/,
      label,
    );
  }
});

test('a self-tested run is stamped as one, at the top of its own notes', () => {
  const report = buildProfileReport({
    at: 'now', build: BUILD, environment: ENVIRONMENT, shadows: SHADOWS, vegetation: { mounted: true }, presets: [okPreset()],
    selfTest: { kind: 'busy', busyMs: 4, label: '4 ms busy-loop injected into the overlay pass' },
    notes: ['a later note'],
  });
  assert.match(report.notes[0], /SELF-TEST RUN — NOT A BASELINE/);
  assert.equal(report.notes[1], 'a later note');
});

test('a preset that could not run is recorded as a failure, never dropped', () => {
  const failed = buildPresetResult({ name: 'cover-fit', error: 'this build supplies no fitView()' });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /fitView/);
  // A dropped preset would read as "not measured yet" forever; a present failure reads as a hole.
  const report = buildProfileReport({
    at: 'now', build: BUILD, environment: ENVIRONMENT, shadows: SHADOWS, vegetation: { mounted: false }, presets: [failed],
  });
  assert.equal(report.presets.length, 1);
  assert.equal(report.presets[0].ok, false);
});

test('a preset result separates CPU frame time from GPU frame time, always', () => {
  const withoutGpu = buildPresetResult({
    name: 'founder-a', view: {},
    phaseSummary: { frames: 3, total: summarize([8, 9, 10]), phases: {}, unaccounted: summarize([0, 0, 0]) },
    gpu: describeGpuTiming({ available: false, reason: 'SwiftShader exposes no timer query' }),
  });
  assert.equal(withoutGpu.cpuFrameMs.median, 9);
  assert.equal(withoutGpu.gpuFrameMs, null);
  assert.match(withoutGpu.gpuTiming.reason, /SwiftShader/);
});

/* ------------------------------------------------- zero cost when off, pinned by source -- */

test('the shipped frame path carries no timing statement', () => {
  // This is the "zero cost when off" claim, checked the only way it can be checked without a
  // browser: by reading the code that runs when the profiler is off.
  const renderOneFrame = /function renderOneFrame\(\) \{\n(?<body>[\s\S]*?)\n  \}/.exec(renderer);
  assert.ok(renderOneFrame, 'renderOneFrame() must exist');
  const body = renderOneFrame.groups.body;
  assert.equal(
    body.split('\n').map((line) => line.trim()).filter(Boolean).join(' '),
    'controls.update(); updateUnderstoryLod(); updateOverlayPositions(); renderer.render(scene, camera);',
    'the unprofiled frame must be exactly the four calls it was before the profiler existed',
  );
});

test('the per-item overlay loop gained nothing', () => {
  // The loop that would actually have mattered: up to ~1,250 elements per rendered frame. A branch
  // in here is the trap the whole exercise is about — a profiler that slows what it measures.
  const loop = /function updateOverlayPositions\(\) \{[\s\S]*?\n  \}/.exec(renderer);
  assert.ok(loop, 'updateOverlayPositions() must exist');
  assert.doesNotMatch(loop[0], /frameProfiler|profileRequest|performance\.(now|mark|measure)/);
});

test('animate() branches ONCE, and both arms call the same four functions in the same order', () => {
  const animate = /function animate\(\) \{[\s\S]*?\n  \}\n/.exec(renderer);
  assert.ok(animate, 'animate() must exist');
  assert.match(animate[0], /if \(frameProfiler\) frameProfiler\.renderProfiled\(\);\s*\n\s*else renderOneFrame\(\);/);
  // One `frameProfiler` mention in animate(): the branch itself.
  assert.equal((animate[0].match(/frameProfiler/g) ?? []).length, 2, 'exactly the one branch');

  const profiled = /function renderProfiled\(\) \{[\s\S]*?\n    \}/.exec(renderer);
  assert.ok(profiled, 'renderProfiled() must exist');
  const order = [...profiled[0].matchAll(/(controls\.update|updateUnderstoryLod|updateOverlayPositions(?:Batched)?|renderer\.render)\(/g)]
    .map((m) => m[1].replace('Batched', ''));
  assert.deepEqual(
    order,
    ['controls.update', 'updateUnderstoryLod', 'updateOverlayPositions', 'updateOverlayPositions', 'renderer.render'],
    'the profiled frame must do the same work in the same order (the overlay call is a two-arm variant switch)',
  );
});

test('the GPU timer is armed at renderer construction, from the URL and not from a gate', () => {
  // `Backend.js:76` reads `trackTimestamp` from the constructor parameters and never again, so this
  // line is the difference between a real GPU number and none at all.
  assert.match(renderer, /new THREE\.WebGPURenderer\(\{ antialias: true, forceWebGL, trackTimestamp: profileRequest\.armed \}\)/);
});

test('the ablations are inert when absent — the request parses to null and the scene is untouched', () => {
  // Same standard as the profiler's own "zero cost when off", proved the same way.
  assert.equal(parseProfileRequest('?profile=1').ablate, null);
  assert.equal(parseProfileRequest('?profile=1&profileAblate=').ablate, null);
  assert.equal(parseProfileRequest('?profile=1&profileAblate=off').ablate, null);
  assert.deepEqual([...parseProfileRequest('?profile=1&profileAblate=props,rocks').ablate.targets], ['props', 'rocks']);

  // Every write the ablations make lives INSIDE createRenderProfiler(), which is only built when
  // `?profile=` armed the run. Nothing on the shipped frame path can reach them.
  const profilerStart = rendererCode.indexOf('function createRenderProfiler()');
  assert.ok(profilerStart > 0, 'createRenderProfiler() must exist');
  for (const symbol of ['shadow.autoUpdate', 'armAblation', 'applyAblation', 'activeAblation', 'shadowPixelCheck']) {
    const hits = [...rendererCode.matchAll(new RegExp(symbol.replace('.', '\\.'), 'g'))].map((m) => m.index);
    assert.ok(hits.length > 0, `${symbol} must exist`);
    for (const at of hits) {
      // `profileShadowPixels` on the public api object is the one deliberate reference after the
      // profiler closes over it, so allow references to the returned handle but not to the guts.
      if (symbol === 'shadowPixelCheck' && rendererCode.slice(Math.max(0, at - 40), at).includes('frameProfiler')) continue;
      assert.ok(at > profilerStart, `${symbol} must not appear on the shipped path (offset ${at} < ${profilerStart})`);
    }
  }
  // applyNature() is the function that would silently fight an ablation. It must not have learned
  // about them — the profiler asks IT what it did, never the other way round.
  const applyNature = /function applyNature\(\) \{[\s\S]*?\n  \}/.exec(rendererCode);
  assert.ok(applyNature, 'applyNature() must exist');
  assert.doesNotMatch(applyNature[0], /ablat|profile/i);
  // ...and neither arm of animate() knows anything about them.
  const animate = /function animate\(\) \{[\s\S]*?\n  \}\n/.exec(rendererCode);
  assert.doesNotMatch(animate[0], /ablat|shadow/i);
});

test('?profileAblate=shadow REFUSES to produce a report when it has nothing to remove', () => {
  /*
   * A NULL EXPERIMENT THAT STILL PRINTS A VERDICT.
   *
   * Since the freeze shipped, `sun.shadow.autoUpdate` is already false on a default load. Arm A and
   * arm B are then both frozen; the old `held: sun.shadow.autoUpdate === false` check passed in BOTH
   * arms — a flag that cannot tell the arms apart — and the series produced a fully-formed report
   * with `applied[0].found: true`, `heldThroughout: true` and a delta of ~0 for an experiment in
   * which nothing was ablated. Verified against the shipped tree: default load reports
   * `autoUpdate:false / mode:"frozen-until-invalidated"`, `&shadows=live` reports
   * `autoUpdate:true / mode:"live-every-frame"`. So the run refuses, and the message names the fix.
   */
  const run = /async function run\(overrides = \{\}\) \{[\s\S]*?\n    \}\n\n    \/\*\*/.exec(renderer);
  assert.ok(run, 'run() must exist');
  assert.match(
    run[0],
    /if \(ablate\?\.targets\?\.includes\('shadow'\) && sunShadow\.live === false\) \{\s*\n\s*throw new Error\(/,
    'a shadow ablation on an already-frozen build must throw rather than report',
  );
  assert.match(run[0], /\?shadows=live&profileAblate=shadow/,
    'the refusal has to name the load that still discriminates, or it is just an error');

  // ...and the check that verifies the arm HELD is a counter, not a flag. `autoUpdate === false` is
  // true in both arms on a frozen build and stays true while real invalidations re-bake the map
  // mid-run; `sunShadow.sequence` cannot be missed by a slow sampler.
  const applyAblation = /function applyAblation\(ablation\) \{[\s\S]*?\n    \}/.exec(renderer);
  assert.ok(applyAblation, 'applyAblation() must exist');
  assert.match(applyAblation[0], /const bakesDuringRun = sunShadow\.sequence - bakesAtArm;/);
  assert.match(applyAblation[0], /held: sun\.shadow\.autoUpdate === false && bakesDuringRun === 0 && !wasAlreadyFrozen/);
  assert.match(applyAblation[0], /wasAlreadyFrozen = sunShadow\.live === false/);
});

test('the shadow pixel probe puts each arm in its own frame, and forces the live arm', () => {
  /*
   * The probe that returned the founder's `identical` true/false/true/false. Two defects, both of
   * which alone void the reading:
   *   (a) the arm labelled `live` inherited whatever `autoUpdate` the page had — which since the
   *       freeze is `false`, so it was a frozen render under a live label;
   *   (b) every arm rendered inside ONE synchronous task, therefore one `nodeFrame.frameId`, and
   *       `ShadowNode.updateBefore()` refuses to bake twice for one camera on one frame id — so
   *       which arms could bake at all depended on whether `animate()` had already rendered in the
   *       same tick. Nondeterministic, which is what an alternating verdict looks like.
   */
  const probe = /async function shadowPixelCheck\(\) \{[\s\S]*?\n    \}\n/.exec(renderer);
  assert.ok(probe, 'shadowPixelCheck() must exist and be async');
  const body = probe[0];
  // One tick per arm. Every snap awaits a rendered frame, and it re-arms the on-demand loop first
  // or `framesElapsed` would sit until its stall deadline and reject.
  assert.match(body, /const snap = async \(\) => \{\s*\n\s*invalidateRender\(\);\s*\n\s*await framesElapsed\(1\);/);
  assert.equal((body.match(/await snap\(\)/g) ?? []).length, 6, 'six arms: two null-control, nudge, entry, live, fresh');
  // The live arm is FORCED, through the controller, not inherited from the page.
  assert.match(body, /sunShadow\.setLive\(true\);\s*\n\s*sunShadow\.invalidate\('profiler-ablation'\);\s*\n\s*const liveFrame = await snap\(\);/);
  // Both controls, and both can void the run.
  assert.match(body, /sceneIsStatic: still1 === still2/);
  assert.match(body, /readbackDiscriminates: nudged !== still1/);
  assert.match(body, /const ok = controls_\.sceneIsStatic && controls_\.readbackDiscriminates;/);
  // Two named verdicts rather than one ambiguous `identical`.
  assert.match(body, /residentMapWasCurrent = ok \? \(atEntry === freshBake\) : null/);
  assert.match(body, /freezeIsPixelFree = ok \? \(liveFrame === freshBake\) : null/);
  assert.doesNotMatch(body, /shadowLive|shadowFrozen/,
    'the old labels described the pre-freeze world and inverted their own meaning once it shipped');
  // It never WRITES either flag behind the controller's back (`=` but not `===`, so a comparison
  // stays legal and only an assignment is caught).
  assert.doesNotMatch(body, /sun\.shadow\.needsUpdate\s*=(?!=)/);
  assert.doesNotMatch(body, /sun\.shadow\.autoUpdate\s*=(?!=)/);
});

test('armAblation cannot cancel a bake the app asked for', () => {
  // Writing `sun.shadow.needsUpdate = false` after the awaited frame discards any invalidation that
  // landed inside it — and the discard is self-certifying, because the audit sees `sequence` has
  // moved, re-baselines, and files the post-mutation fingerprint as `baked`. The window is the one
  // that matters: the authored-vegetation swap lands 60-85 s in, inside any real profiler run.
  const arm = /async function armAblation\(ablation\) \{[\s\S]*?\n    \}/.exec(renderer);
  assert.ok(arm, 'armAblation() must exist');
  assert.match(arm[0], /const atSequence = sunShadow\.sequence;\s*\n\s*await framesElapsed\(1\);/);
  assert.match(arm[0], /if \(!sunShadow\.settle\(atSequence\)\)/);
  assert.doesNotMatch(arm[0], /sun\.shadow\.needsUpdate = false/,
    'the raw write is what cancels a committed bake; settle() is the conditional version');
});

test('the ablation restores itself on every exit, including a throw', () => {
  // An ablation that leaked past its run would silently ablate the NEXT run — which in an A/B
  // series is the baseline arm, and would report a delta of zero for a real effect.
  const run = /async function run\(overrides = \{\}\) \{[\s\S]*?\n    \}\n\n    \/\*\*/.exec(renderer);
  assert.ok(run, 'run() must exist');
  const tail = run[0].slice(run[0].lastIndexOf('} finally {'));
  assert.match(tail, /activeAblation\?\.restore\(\)/, 'the restore must be in the finally block');
  assert.match(tail, /activeAblation = null/);
});

test('the batched overlay variant exists only as an instrument', () => {
  // It must never be reachable from animate() — the shipped loop is the one being measured, and a
  // probe that quietly replaced it would be measuring itself.
  const animate = /function animate\(\) \{[\s\S]*?\n  \}\n/.exec(renderer);
  assert.doesNotMatch(animate[0], /updateOverlayPositionsBatched/);
  assert.match(renderer, /function updateOverlayPositionsBatched\(\)/);
});

/* ------------------------------------------ (e) the instruments are gated, the profiler is not -- */
/*
 * Founder's ruling, 2026-09-03, at the push that makes tarkovzero.com this code:
 *
 *   KEEP public   `?profile=1` (with `?profilePresets=`, `tz.profile()`, the panel, the JSON
 *                 export) and `?shadows=live`. A baseline of the live site can only be taken on the
 *                 live site, and `?shadows=live` is a proven-pixel-identical escape hatch.
 *   GATE          `?profileAblate=`, `?profileSelfTest=`, `?shadowAudit=`. They hide caster groups,
 *                 burn main-thread time, disable frustum culling and run a second rAF loop. They
 *                 are instruments, never a candidate optimisation.
 *
 * The predicate is question (e) of `src/renderer-gate.js`, LOOPBACK-only, and its behaviour is
 * proved in `scripts/three-renderer-test.mjs`. What is proved HERE is the wiring, source-pinned the
 * same way "zero cost when off" is: that the refusal happens BEFORE the instrument is applied, on
 * every route into it, and that the profiler itself did not get gated with it.
 */

test('(e) the gated instruments are refused BEFORE they are applied, on every route in', () => {
  // The gate is question (e), read once, from the hostname and from nothing else.
  assert.match(renderer, /const sceneInstrumentsAllowed = canRunSceneMutatingInstruments\(\{ hostname: location\.hostname \}\);/);
  assert.doesNotMatch(rendererCode, /canRunSceneMutatingInstruments\(\{[^}]*\bdev\b/);

  /*
   * THE ORDER IS THE ASSERTION. `run()` is the one place both routes meet — the URL's
   * `profileRequest.ablate` and the console's `tz.profile({ ablate: 'props' })` — and the refusal
   * has to sit above the first line that applies anything. Below it, the run would complete and
   * stamp `notes[0] = 'ABLATION RUN — PIXELS DELIBERATELY REMOVED (props)'` on a report whose
   * numbers are a plain baseline: handoff §7's ninth instance, manufactured by this gate.
   */
  const run = /async function run\(overrides = \{\}\) \{[\s\S]*?\n    \}\n\n    \/\*\*/.exec(renderer);
  assert.ok(run, 'run() must exist');
  assert.match(
    run[0],
    /if \(!sceneInstrumentsAllowed\) \{\s*\n\s*if \(ablate\?\.kind === 'ablate'\) throw new Error\(refuseInstrument\('profileAblate'\)\);\s*\n\s*if \(selfTest\) throw new Error\(refuseInstrument\('profileSelfTest'\)\);\s*\n\s*\}\s*\n\s*if \(selfTest\?\.kind === 'busy'\) busyMs = selfTest\.busyMs;/,
    'the refusal must be the statement immediately before the first line that applies a self-test',
  );
  // It THROWS. A dropped flag is the silent fallback this project keeps failing by.
  assert.doesNotMatch(run[0], /if \(!sceneInstrumentsAllowed\) \{\s*\n\s*(?:ablate|selfTest) = null/);
  // …and it is inside the try, so the `finally` still restores the view and clears `inFlight`.
  const tryAt = run[0].indexOf('try {');
  assert.ok(tryAt > 0 && run[0].indexOf('if (!sceneInstrumentsAllowed)') > tryAt, 'a throw outside the try would wedge the profiler');

  // The A/B series refuses UP FRONT: arm A is the unablated one, so without this the page would
  // spend minutes measuring a baseline before discovering it can never take arm B.
  const series = /async function runSeries\(overrides = \{\}\) \{[\s\S]*?\n    \}\n/.exec(renderer);
  assert.ok(series, 'runSeries() must exist');
  assert.match(series[0], /if \(!sceneInstrumentsAllowed\) throw new Error\(refuseInstrument\('profileAblate'\)\);/);
  assert.ok(
    series[0].indexOf('sceneInstrumentsAllowed') < series[0].indexOf('for (let cycle'),
    'the refusal must precede the first arm',
  );

  // `?shadowAudit=1` has no run to throw from — it is armed at boot or never — so the arming
  // itself carries the gate, and the refusal is announced beside it.
  assert.match(renderer, /if \(shadowRequest\.audit && !sceneInstrumentsAllowed\) refuseInstrument\('shadowAudit'\);\n\s*const shadowAudit = shadowRequest\.audit && sceneInstrumentsAllowed\n\s*\? createShadowCasterAudit\(\{/);
});

test('(e) a refused instrument is never silent — four channels, one message', () => {
  /*
   * "A gated flag must FAIL LOUDLY and legibly when used in production, never silently no-op. A
   * user or you, months from now, must not think an ablation applied when it did not."
   *
   * Console at boot, a REFUSED line on the panel, a row in renderStats(), and a throw instead of a
   * report — all four from `sceneMutatingInstrumentRefusal()`, so they cannot drift apart.
   */
  const refuse = /const refuseInstrument = \(flag\) => \{[\s\S]*?\n  \};/.exec(renderer);
  assert.ok(refuse, 'refuseInstrument() must exist');
  assert.match(refuse[0], /sceneMutatingInstrumentRefusal\(flag, \{ hostname: location\.hostname \}\)/);
  assert.match(refuse[0], /console\.error\(`\[three-poc\] \$\{message\}`\)/, 'channel 1: the console, at boot');
  assert.match(refuse[0], /refusedInstruments\.push\(\{ flag, message \}\)/);
  assert.match(refuse[0], /return message;/, 'the same sentence is what the throw carries');

  // Channel 2: the panel prints it, and the ABLATION / SELF-TEST lines that would contradict it are
  // suppressed on a refused load — one line per flag, never two saying different things.
  assert.match(renderer, /\.\.\.refusedInstruments\.map\(\(row\) => `REFUSED\s+\?\$\{row\.flag\} — \$\{row\.message\}`\)/);
  assert.match(renderer, /profileRequest\.selfTest && sceneInstrumentsAllowed \?/);
  assert.match(renderer, /profileRequest\.ablate\?\.kind === 'ablate' && sceneInstrumentsAllowed/);
  assert.match(
    renderer,
    /abButton\.hidden = profileRequest\.ablate\?\.kind !== 'ablate' \|\| !sceneInstrumentsAllowed;/,
    'a button that can only throw is a promise the page cannot keep',
  );

  // Channel 3: the published state. A downloaded report, a screenshot or an `.e2e` capture taken on
  // a public host carries the evidence that its flags did nothing.
  assert.match(renderer, /instruments: \{\s*\n\s*sceneMutatingAllowed: sceneInstrumentsAllowed,\s*\n\s*refused: refusedInstruments\.map\(\(row\) => \(\{ \.\.\.row \}\)\),\s*\n\s*\}/);
  // `{ armed: false }` collapsed "nobody asked" and "the gate said no" into one reading. It cannot.
  const auditState = /const shadowAuditState = \(\) => \{[\s\S]*?\n  \};/.exec(renderer);
  assert.ok(auditState, 'shadowAuditState() must exist');
  assert.match(auditState[0], /if \(shadowRequest\.audit\) \{\s*\n\s*return \{ armed: false, refused: true, reason:/);
  assert.match(auditState[0], /return \{ armed: false, refused: false, reason: null \};/);
  assert.doesNotMatch(renderer, /audit: shadowAudit \? shadowAudit\.stats\(\) : \{ armed: false \}/,
    'the old two-readings-in-one shape must not come back');
});

test('(e) ?profile=1 and ?shadows=live are NOT gated — the instrument gate did not eat them', async () => {
  /*
   * The failure mode of this change, stated as its own test. The profiler exists BECAUSE the
   * founder's 5080 is the only real GPU in the project and the live site is one of the two places a
   * baseline can be taken; `?shadows=live` is pixel-identical by proof and is the rollback if a
   * frozen shadow ever misbehaves in the wild. A gate that also took those out would be a
   * regression dressed as hardening.
   */
  assert.match(renderer, /if \(profileRequest\.armed\) frameProfiler = createRenderProfiler\(\);/);
  assert.doesNotMatch(rendererCode, /profileRequest\.armed && sceneInstrumentsAllowed/);
  assert.doesNotMatch(rendererCode, /sceneInstrumentsAllowed && profileRequest\.armed/);
  // The GPU timer is still armed from the URL alone — it is a renderer-construction parameter and
  // cannot be turned on later, so a gate here would be unrecoverable rather than merely wrong.
  assert.match(renderer, /new THREE\.WebGPURenderer\(\{ antialias: true, forceWebGL, trackTimestamp: profileRequest\.armed \}\)/);
  // The panel is built for anyone who typed `?profile=`, on any host.
  assert.match(renderer, /let profilePanelInterval = 0;\n\s*if \(frameProfiler\) \{/);

  // `?shadows=live` reaches the controller unconditionally: it is the escape hatch AND the control
  // arm of the pixel-identity proof, and both uses die if a host can refuse it.
  assert.match(renderer, /const sunShadow = createShadowController\(\{\n\s*shadow: sun\.shadow,\n\s*live: shadowRequest\.live,/);
  assert.doesNotMatch(rendererCode, /live: shadowRequest\.live && sceneInstrumentsAllowed/);
  assert.doesNotMatch(rendererCode, /shadowRequest\.live && sceneInstrumentsAllowed/);
  // The pure parser still answers the URL and nothing else; only `audit` is gated downstream.
  const shadow = await readFile(new URL('../src/shadow-invalidation.js', import.meta.url), 'utf8');
  assert.doesNotMatch(shadow, /canRunSceneMutatingInstruments|sceneInstrumentsAllowed|renderer-gate/,
    'the shadow module parses what was ASKED FOR; authorising it is the renderer\'s job, not the parser\'s');
});
