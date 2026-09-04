# Profiling the Three renderer — the founder's run

**Why this exists.** Handoff §8: *"`gpuFrameMs` is null under SwiftShader. No frame-time claim in
this repo is backed by anything."* On the Three path it is worse — there was no frame-time field to
be null. `renderStats().fps` counts how often the app *chose* to submit a frame, not how long a
frame takes, and every capture ever taken in this project was headless Chromium on SwiftShader.

**You have the only real GPU in this project.** This document is the ten minutes that turn that into
a baseline every later optimisation gets judged against.

---

## 1. The run, in order

### Step 0 — check nothing else is holding the port

The founder's preview owns **4173**. This procedure uses **4210–4399** if it needs a server at all;
it can also be run against the live site.

### Step 1 — open the map with the profiler armed

```
http://127.0.0.1:4173/?profile=1
```

or, on the live site,

```
https://tarkovzero.com/?profile=1
```

The build behind that URL has to contain the profiler. A `vite preview` started before this change
is serving the old `dist/` and `?profile=1` will do nothing — rebuild and restart it, or run against
a deploy made after this change.

`?profile=1` must be present **when the page loads**. It cannot be turned on afterwards, and
`tz.profile()` will tell you so rather than pretending: three reads `trackTimestamp` from the
renderer's constructor parameters (`Backend.js:76`) and never again, so the GPU timer only exists on
a page that was booted asking for it.

A panel appears bottom-left. It has four lines that matter:

```
backend      webgpu
gpu timer    YES
vegetation   loading — WAIT, this is not the shipped forest yet
frames       30 warm-up discarded, 180 sampled, 60x2 reflow probe
```

### Step 2 — WAIT for the vegetation line to say `MOUNTED — ready`

**This is the step that invalidates every measurement previously recorded in this repo.** The
authored vegetation pack is 93 GLBs plus 27 MB of texture arrays, it takes **60–85 seconds**, and it
is never awaited — the map is fully interactive on the procedural forest while it loads. The one
attributed frame on disk (`.e2e/report.json`: 1,397 draw calls, 3,050,579 triangles) was taken with
`mount loading` in its own notes. It does not describe the frame production draws.

Do not press the button until the panel says `MOUNTED — ready`. If it ends up `timed-out` or
`failed`, the run is still worth taking — the report records the phase either way — but say so when
you report the numbers, because it is a different frame.

### Step 3 — press **Run baseline**

It walks four camera presets, roughly 20–40 s in total:

| preset | what it is |
|---|---|
| `founder-a` | `#3.48/257.7/-42.3` — your own pose |
| `founder-b` | `#3.92/257.9/-22.1` — your own pose, one notch closer |
| `cover-fit` | the app's own whole-map framing, the first thing a visitor sees |
| `ground-close` | `#7.00/257.7/-42.3` at 12° — close in and low, the overlay's and the terrain shader's worst case |

At each preset it discards 30 warm-up frames, then measures 180, then runs a separate 60×2-frame
probe for the DOM overlay's forced-layout cost. **Frames are rendered continuously for the duration
of the run** — this app renders on demand, so these are the cost of a frame, not the rate the app
submits them at. The panel prints a one-line summary per preset.

### Step 4 — press **Download JSON**

The panel is a summary. The file is the measurement. Keep it — later runs are compared against it.

The console equivalent, if you prefer: `await tz.profile()` returns the same object, and
`tz.profileReport()` returns the last one.

---

## 2. What a good result looks like

Read these in order. The first four are structural — if they are wrong, the numbers below them do
not mean what you think.

| field | good | bad |
|---|---|---|
| `vegetation.mounted` | `true` | `false` — you measured the procedural forest, not the shipped one. Re-run. |
| `environment.gpuRenderer` | names your 5080 | `"unavailable"` — the report cannot say which machine it describes |
| `environment.backend` | `webgpu` | `webgl2` means the fallback ran; the numbers are real but they are not the shipped path |
| `gpuTiming.available` | `true` | `false` — `gpuFrameMs` is `null` everywhere and the `reason` says why. **CPU time is never substituted for it.** |
| `gpuTiming.health.suspectRepeatShare` | near 0 | above 0.5 — three returns its *previous* value on a GPU disjoint, so those milliseconds may be stale |
| `gpuTiming.health.disjointObserved` | always `null` here — see §5 | any number: that would mean a backend arrived that can count them, and `disjointObservable` would be `true` |
| `presets[].unaccountedMs.median` | small next to `cpuFrameMs.median` | large — the four phases do not explain the frame, and the breakdown is wrong |

Then the numbers themselves, per preset:

- **`cpuFrameMs.median` under ~8 ms** at every preset is comfortable at 60 Hz (16.7 ms budget) with
  headroom for the browser's own compositing. **Over 16.7 ms is a dropped frame every frame.**
- **`cpuFrameMs.p95` far above the median** is a hitch. A p95 of 3× the median means one frame in
  twenty is visibly worse than the rest, which is what a pan *feels* like even when the median is
  fine. p95 is nearest-rank, so it is a frame that actually happened.
- **`gpuFrameMs.median` vs `cpuFrameMs.median`** is the whole question of where to optimise. GPU
  above CPU → the frame is fill/shader bound (the terrain shader samples all 12 material layers
  unconditionally; shadows are on at 2048²). CPU above GPU → the frame is bound by the four phases
  below, and `phases` says which.
- **`phases.overlay` vs `phases.render`.** The DOM overlay projects and repositions up to ~1,250
  elements per rendered frame. If `overlay` is a large share of the frame, that is the lane.
- **`overlayReflow.forcedLayoutMs.median`** is the part of the overlay pass that is purely the
  read/write interleaving — measured by running the shipped loop and a batched variant on
  alternating frames. A large number here is a cheap fix; a near-zero number means the interleaving
  is not the problem and batching would buy nothing.
- **`events.raycast.msPerSecond`** only moves if you were moving the mouse. The raycast is
  unthrottled over five subtrees on every `pointermove`; move the cursor during a run if you want
  that number to be about anything.
- **`renderInfo.drawCalls` / `.triangles`** come from the render-frame latch — `renderer.info` read
  immediately after `render()`, the one number in this repo that was already trustworthy. Compare
  across presets: how much of the frame survives frustum culling at each pose has never been
  recorded.
- **`memory.heap.collectionsObserved`** over a 180-frame window is the GC signal. The overlay
  allocates ~6 short-lived objects per visible item per frame; this is whether that shows.
- **`waterfall`** is first paint, once, with overlapping phases kept visible. `spanMs` is wall clock
  to the last closed phase — deliberately not a sum, because the terrain fetches overlap the map
  JSON parse and a sum would report more time than the page took.

---

## 2a. What it already reported, headless

The instrument was run end to end on this machine — headless Chromium, `ANGLE (Google, Vulkan 1.3.0
(SwiftShader Device (Subzero)), SwiftShader driver)`, release build, 1400×985, DPR 1, procedural
vegetation, preset `founder-a`, 2 warm-up discarded and 8 sampled. It is **not a baseline** — it is
software rendering — but every channel produced a number, so the shape of the output is known:

```
cpuFrameMs      median 22.95 ms   (render 20.55 · overlay 2.25 · lod 0.00 · controls 0.10)
unaccountedMs   median  0.00 ms   ← the four phases explain the whole frame
drawCalls       1151 · triangles 3,038,257 · resident geometries 871 · textures 36
overlayReflow   forcedLayout median 1.9 ms over 112 visible items = 0.017 ms/item
heap            2 collections in 8 frames, median rise 198 KB/frame
gpuFrameMs      null — see below
waterfall       first render 4,721 ms; worldBuild 1,447 ms is the largest single phase
```

**The GPU channel refused itself, correctly.** SwiftShader *advertises*
`EXT_disjoint_timer_query_webgl2` — `timestampFeatureAtBoot: true`, `disjointExtensionPresent: true`
— and then never completes a resolve. The stall guard switched the channel off after 3 s and wrote
the reason into `gpuTiming.reason`; `gpuFrameMs` is `null` and CPU time was not put in its place.
That is the whole design working: a harness that had reported a plausible GPU number here would have
been reporting SwiftShader's CPU emulation as GPU time.

**Only your machine can produce a real `gpuFrameMs`.** Nothing here has exercised the WebGPU
timestamp path at all.

## 3. Proving the harness discriminates — do this once

Handoff §7's rule: *"when you add an assertion, prove it discriminates."* An instrument is an
assertion about cost, so add cost and check the numbers move. Two switches do it, both self-restoring
and both stamped into the report so a self-tested run can never be mistaken for a baseline.

**Injected CPU cost:**

```
http://127.0.0.1:4173/?profile=1&profilePresets=founder-a&profileSelfTest=busy:6
```

`phases.overlay.median` must rise by ≈6 ms and `cpuFrameMs.median` with it. If it does not, the
phase breakdown is not measuring the overlay pass.

**Removed frustum culling:**

```
http://127.0.0.1:4173/?profile=1&profilePresets=founder-a&profileSelfTest=nocull
```

`renderInfo.drawCalls` and `.triangles` must rise — every off-screen object is now submitted. If they
do not, the latch is not reading the frame you think it is.

Run each once, compare with the clean run, then discard both. `report.selfTest` is non-null in each,
and `report.notes[0]` says `SELF-TEST RUN — NOT A BASELINE`.

**It was run.** Five runs in one page load, headless, same build, same assets, preset `founder-a`,
8 sampled frames each — a 50 ms injection rather than 6 ms because SwiftShader's frames are already
tens of milliseconds:

| run | `phases.overlay` median | `cpuFrameMs` median | `drawCalls` | `triangles` |
|---|---|---|---|---|
| clean | 2.25 ms | 22.95 ms | 1151 | 3,038,257 |
| **`busy:50`** | **52.65 ms** (+50.4) | **70.65 ms** (+47.7) | 1151 | 3,038,257 |
| clean (restored) | 2.55 ms | 23.35 ms | 1151 | 3,038,257 |
| **`nocull`** | 1.90 ms | 19.30 ms | **1807** (+656) | **3,115,291** (+77,034) |
| clean (restored) | 2.10 ms | 16.80 ms | 1151 | 3,038,257 |

Read the columns, not the rows. **Injected CPU cost moved the timing channel by 50.4 ms against a
declared 50 ms and left the draw-call channel untouched. Removing frustum culling moved the
draw-call channel by 57% and left the timing channel untouched.** Each channel responded only to
the cost aimed at it, and both restored exactly — 1151 draw calls again, twice. A harness that
reported the same numbers either way would be worthless; this one does not.

`unaccountedMs.median` was 0.00 ms in all five runs: the four phases account for the whole frame.

---

## 3a. Attribution: what is the `render` phase actually spending?

**The question this answers.** The two biggest items on the optimisation list — stop re-rendering
the shadow map every frame, merge the prop and rock geometry into fewer draws — both assume the same
unproven thing: that `phases.render` is dominated by *scene-submission* work rather than by fill,
shading, or the terrain shader's twelve unconditional material layers. `phases.render` is one number
and cannot tell those apart. Building either optimisation blind is a day bet on a guess. Switching
the thing off costs one page load.

```
?profileAblate=shadow        sun.shadow.autoUpdate = false after one shadow render
?profileAblate=props         propGroup.visible = false
?profileAblate=rocks         rockGroup.visible = false
?profileAblate=props,rocks   both — commas combine, order does not matter
```

**Two classes, and they are not the same kind of evidence.**

- `shadow` should be **pixel-identical**. The sun's shadow camera is a fixed ortho frustum aimed at
  the map centre and does not follow the view, so on a static scene the depth map rendered on frame
  1 is the one frame 900 would have rendered. If it holds, this is a candidate optimisation you
  could ship. It is a hypothesis, not a fact — §3b is how you check it.
- `props` and `rocks` **change the picture on purpose**. They are attribution experiments and nothing
  else: a measurement of what that content costs. The app is supposed to draw props and rocks, so
  nothing produced under them is a candidate optimisation.

Every ablated report is stamped in `notes[0]` and can never be mistaken for a baseline, exactly as a
`profileSelfTest` run is — and the two classes are stamped *differently*, so a reader never has to
infer which they are holding:

```
ABLATION RUN — NOT A BASELINE. Pixel-identical BY HYPOTHESIS, which is the thing being tested…
ABLATION RUN — PIXELS DELIBERATELY REMOVED (props). NOT A BASELINE, AND NOT A CANDIDATE OPTIMISATION…
```

The report also carries `ablation.applied` (was the group even found?) and `ablation.verified` — the
targets are re-checked at the end of **every preset**, because `applyNature()` writes
`rockGroup.visible` and would silently restore what an ablation switched off. A run whose ablation
did not hold gets `heldThroughout: false` and a warning at the top of `notes`.

### The A/B/A/B run — do this one, not separate loads

Separate page loads differ in shader compilation, pipeline caches and texture residency, and GPU
numbers here already move 1–4 ms run to run for no attributable reason. A 2 ms delta between two
loads is not evidence of anything. **One flagged load, alternating arms inside it, is the strong
form** — and repeating each arm is what gives the comparison a noise floor to measure its own delta
against.

```
http://127.0.0.1:4173/?profile=1&profileAblate=shadow&profilePresets=founder-a,ground-close
```

Wait for `MOUNTED — ready`, then press **Run A/B/A/B**. It runs `A B A B` — A unablated, B ablated —
and prints, per metric, `A → B`, the delta, the widest within-arm spread, and a verdict:

```
the A→B delta is LARGER than the widest within-arm spread — this series attributes it
the A→B delta is INSIDE the within-arm spread — this series attributes nothing
```

**The second verdict is the one worth having.** A delta printed on its own invites belief; this says
whether the delta cleared the noise the run itself measured. Then **Download JSON** — the series file
holds every run plus the comparison.

Console equivalents: `await tz.profileAB({ ablate: 'shadow', repeats: 2 })`,
`tz.profileSeries()` for the last one, and `await tz.profile({ ablate: 'props' })` for a single
ablated run without reloading.

### The exact sequence to run

Four loads. Each is `Run A/B/A/B` then `Download JSON`; nothing else needs pressing, and each waits
for `MOUNTED — ready` first.

| # | URL | what it settles |
|---|---|---|
| 1 | `?shadows=live&profile=1&profileAblate=shadow&profilePresets=founder-a,ground-close` | Is the per-frame shadow pass a real share of `render`? Watch `renderInfo.frameCalls` — it falls by exactly 1 when the depth pass stops running. **`?shadows=live` is not optional on this row** — see the box below. **Run `await tz.profileShadowPixels()` in the console on this load** (§3b) before believing the delta is free. |
| 2 | `?profile=1&profileAblate=props&profilePresets=founder-a,ground-close` | What do the props cost, in draw calls and in milliseconds? This is the ceiling on what merging their geometry could return. |
| 3 | `?profile=1&profileAblate=rocks&profilePresets=founder-a,ground-close` | The same for rocks, separately — merging them is a separate job with a separate payoff. |
| 4 | `?profile=1&profileAblate=props,rocks&profilePresets=founder-a,ground-close` | Both together. If (4) ≈ (2) + (3) the costs are additive and either merge is worth doing alone; if (4) is much less, the frame is bound by something both were hiding and neither merge is the lane. |

> **⚠ THE SHADOW ABLATION HAS NO CONTROL ARM ON A DEFAULT LOAD — it now refuses to run there.**
> Since the freeze shipped (§3c), `sun.shadow.autoUpdate` is already `false` when the page opens.
> `?profileAblate=shadow` on its own therefore removes nothing: arm A and arm B are both frozen, and
> the run used to produce a fully-formed report with verdicts, `applied[0].found: true`,
> `heldThroughout: true` and a delta of ~0 — for an experiment in which nothing was ablated. Measured
> on the shipped tree: default load reports `autoUpdate:false / mode:"frozen-until-invalidated"`,
> `&shadows=live` reports `autoUpdate:true / mode:"live-every-frame"`. `run()` now throws rather than
> reporting, and the message names the fix. `heldThroughout` for this target is also a COUNTER now
> (`sunShadow.sequence` delta), not the `autoUpdate === false` flag — that flag was true in both arms
> and stayed true while real invalidations re-baked the "frozen" arm mid-run.

Rows 2–4 changed meaning with the freeze too, and the reports say so: props and rocks are casters, so
before the freeze their cost included the depth pass. Frozen, `?profileAblate=props` measures their
**colour-pass share only**. Pair with `?shadows=live` to get the old, all-in number. (Those two
ablations also now invalidate the depth map on both edges — without that they hid caster geometry
under a frozen map and drew prop shadows on ground with no props, which is the literal stale-shadow
signature, produced by the instrument.)

Two presets rather than four keeps each load to a few minutes. `founder-a` is the pose the founder
actually sits at; `ground-close` is the worst case for both the overlay and the terrain shader, and
is where a submission-bound frame and a fill-bound frame diverge most.

**Read the verdicts before the numbers.** If load 1 says *attributes nothing*, the shadow pass is not
where the frame goes and that optimisation is dead for the cost of one page load — which is the
entire point of running these first.

Every downloaded report now carries a top-level **`shadows`** block (`mode`, `autoUpdate`,
`invalidations`, `byReason`) and `buildProfileReport()` refuses a report without it. The shadow
policy is the single largest term in `render`, so a baseline that could not say which arm it was
taken in could not be compared with any other baseline — the same defect that produced this repo's
three irreconcilable draw-call numbers.

### 3b. Is the frozen shadow really pixel-identical? — TWO questions, two named verdicts

**This probe is the thing that produced the founder's `identical` true, false, true, false, and that
result was an artefact of the probe rather than a reading of the scene.** It is `async` now:

```js
await tz.profileShadowPixels()
```

Two defects were fixed, either of which alone voided the old reading:

1. **The arm labelled `live` was not live.** It inherited whatever `sun.shadow.autoUpdate` the page
   had — and since the freeze shipped, that is `false`. So the comparison was never live-vs-frozen:
   it was *"the depth map that happens to be resident right now"* against *"a map baked two renders
   ago"*. Under those labels `identical: false` reads as "the optimisation is unsound", when what it
   actually detected is **the resident map was stale at that moment** — the P1 defect signal,
   correctly seen and wrongly named.
2. **Every arm shared one `nodeFrame.frameId`.** All five renders ran in one synchronous task, and
   `ShadowNode.updateBefore()` (three 0.185.1, `ShadowNode.js:859-866`) forces `needsUpdate = false`
   whenever it has already handled this camera on this frame id — which three advances only from its
   own `Animation` loop, once per rAF tick. So *which arms could bake at all* depended on whether
   `animate()` had already rendered in the same tick. Nondeterministic, which is what an alternating
   verdict looks like.

Each arm now gets its own rAF tick, the live arm is **forced** through the controller rather than
inherited, and the result carries two separately named verdicts:

| field | question | meaningful on |
|---|---|---|
| `residentMapWasCurrent` | was the depth map the page was already showing stale? | the shipped **frozen** default — this is the P1 check |
| `freezeIsPixelFree` | does three's per-frame shadow differ from the frozen map? | `?shadows=live`, where a real control arm exists |

**Two controls, both taken first, either of which voids the run:**

- **NULL** — two consecutive renders with *nothing changed* must hash EQUAL. If they do not, the
  scene is mutating under the probe (a streaming attach, an LOD repack) and no difference below is
  attributable to the shadow. The old probe had no null control, and its absence is the most likely
  mechanical cause of an intermittent `false`.
- **READBACK** — a 0.35-unit camera nudge must hash DIFFERENTLY, or `toDataURL` is returning
  something constant and an "identical" here would prove nothing.

```
ok: false — VOID: two renders with nothing changed hashed DIFFERENTLY: the scene is
mutating under the probe, so no difference below can be attributed to the shadow
```

It also no longer writes `sun.shadow.*` directly — every flag change goes through the controller, so
`?shadowAudit=1` can never certify a bake the probe itself cancelled.

**Use `--pixelCheck 0` when capturing screenshots of the real frozen arm.** The probe ENDS by baking
a fresh depth map, which repairs the exact defect a screenshot is being taken to catch; run it as its
own labelled probe instead of before every capture.

### It was run — the discrimination readings

Nine passes in **one page load**, headless Chromium on SwiftShader, dev build, `founder-a`, 10
sampled frames each. Timing under software rendering means nothing; the draw-call and frame-call
channels are counted by three, not by the GPU, and they are what proves the flags remove the work
they name.

| run | `drawCalls` | `triangles` | `frameCalls` | `phases.render` median |
|---|---|---|---|---|
| clean | 1133 | 510,570 | 3 | 21.60 ms |
| **`props`** | **634** (−499) | 457,858 (−52,712) | 3 | 11.55 ms |
| clean (restored) | 1133 | 510,570 | 3 | 21.20 ms |
| **`rocks`** | **991** (−142) | 461,858 (−48,712) | 3 | 18.40 ms |
| clean (restored) | 1133 | 510,570 | 3 | 18.70 ms |
| **`shadow`** | **650** (−483) | 285,996 (−224,574) | **2** (−1) | 4.85 ms |
| clean (restored) | 1133 | 510,570 | 3 | 18.55 ms |
| **`props,rocks`** | **492** (−641) | 409,146 | 3 | 6.85 ms |
| clean (restored) | 1133 | 510,570 | 3 | 22.30 ms |

Each flag moved the channel it aims at, and **every clean run came back to 1133 draw calls and
510,570 triangles exactly — four times.** An ablation that leaked past its run would have shown up
here as a clean run that never returned to baseline.

`shadow` is the row to read twice: `frameCalls` 3 → 2 is the nested
`renderer.render(scene, shadow.camera)` disappearing, and 483 draw calls and 224,574 triangles go
with it. That is the *submission* half of the hypothesis confirmed — the depth pass really is a
second traversal of every caster. **Its 16.75 ms of `render` time is a SwiftShader artefact**
(software rasterisation of a 2048² depth map) and says nothing about the 5080. Whether the shadow
pass costs anything worth removing on real silicon is exactly what your load 1 is for.

The A/B/A/B series was run too, `props`, two cycles: `drawCalls` A 1133 → B 634, Δ −499 against a
within-arm spread of **0** — *attributes it*. `frameCalls` A 3 → B 3, Δ 0 — *attributes nothing*,
correctly, because removing props does not remove a render pass.

---

## 3c. The shadow map is now FROZEN — and the invalidation list is the whole change

**Shipped 2026-09-03.** `sun.shadow.autoUpdate = false`. The 2048² depth map is re-rendered only when
something that casts into it changed, or when the light moved.

### What it bought, measured on the founder's RTX 5080

A/B/A/B inside one page load, vegetation mounted, all 1,304 overlay layers:

| preset | metric | live | frozen | delta |
|---|---|---|---|---|
| founder-a | CPU frame | 16.00 ms | 9.85 | **−38%** |
| founder-a | render phase | 12.45 | 6.50 | −48% |
| ground-close | CPU frame | 22.45 | **15.60** | **−31%** |
| ground-close | render phase | 10.80 | 4.10 | −62% |
| both | draw calls | 1,528 / 743 | 1,046 / 261 | −482 |
| both | `frameCalls` | 3 | 2 | the nested shadow render disappears |

`ground-close` at 22.45 ms was the only measured configuration missing the 16.67 ms 60 Hz budget.

> **⚠ WHAT THOSE NUMBERS DESCRIBE: A PARKED CAMERA — and until 2026-09-03 evening, ONLY that.**
> `runPreset()` applies a pose, sleeps 500 ms, then samples, so no camera event fires inside the
> measurement window. That mattered, because the freeze was being lifted on **every camera event**:
> the authored streamer's `publishState()` runs on every pass — before its own empty-diff early
> return — and drove `applyProceduralSuppression()` → `sunShadow.invalidate('procedural-suppression')`
> unconditionally. Since this app renders **on demand**, frame time only exists while the camera is
> moving, so the optimisation was defeated in exactly the regime it was bought for and no A/B could
> see it. Measured on the shipped tree before the fix: six `tz.flyTo` calls produced **+14
> invalidations**, nine of them `procedural-suppression` over an unchanged set — plus 11
> `InstancedMesh` buffer rewrites and a GPU re-upload of 195 identical matrices per event.
>
> `syncProceduralSuppression()` is now gated on the resolved set actually changing, using the same
> dirty-key shape `syncPlinthSuppression()` already used. `rebuildWorld()` clears the key, because a
> rebuilt graph makes any earlier application void. `proceduralSuppressionKey()` is exported and
> unit-tested for the direction that matters — it must never compare EQUAL for two different sets,
> which would strand a procedural proxy under its authored replacement.

### Why the crude probe answered `identical` true, false, true, false

`?profileAblate=shadow` freezes the depth map ONCE, early. The authored-vegetation swap lands 60-85 s
later, and it **changes what casts**: the procedural tree proxies (`exact-pine-trunks`, both pine
crown layers, `exact-deciduous-trunks`, `exact-deciduous-crowns`, `exact-stumps`) are
`castShadow: true`, and authored vegetation deliberately is not
(`CUSTOMS_AUTHORED_VEGETATION_SHADOW_POLICY.mode === 'disabled'`,
`src/customs-authored-vegetation.js:1589`). A map frozen before the swap keeps the shadows of trees
that no longer exist. Confirmed by the audit below: at the swap the caster census moves
`exact-local-vegetation −5`, `building −1`, and +14 authored Fortress meshes.

**The freeze is only free if every one of those moments says so.** The boolean is trivial; the list is
the deliverable.

### The list, derived from the code

`SHADOW_INVALIDATION_REASONS` in `src/shadow-invalidation.js` is a **closed enum** — an invalidation
with a reason that is not on it throws rather than quietly doing nothing.

| reason | site | what changes |
|---|---|---|
| `world-build` | `rebuildWorld()` — `src/map3d-three.js:3528` | every procedural caster: buildings + detail instances, props, bridge decks/approaches/piers, rails, walls/fences/gates, rocks, tree proxies. Also the FIRST bake |
| `procedural-suppression` | `applyProceduralSuppression()` — `:3409` | authored replacements hide/show building and prop nodes; `refreshDetailInstances()` rewrites the roof-plant instance buffers |
| `nature-visibility` | `applyNature()` — `:3461` | `treeGroup.visible`, `rockGroup.visible` |
| `look` | `applyLook()` — `:3583` | `sun.intensity` and the terrain/understory material swap |
| `procedural-vegetation` | `rebuildProceduralVegetation()` — `:4668` | the tree proxies are disposed and rebuilt |
| `authored-vegetation-mount` | the swap — `:4596` | **the one that was broken** |
| `authored-vegetation-repack` | `repackAuthoredVegetationNow()` | conditional on `authoredVegetationCastsShadows`, read from the **constructed runtime's** normalised policy at the mount swap — NOT from the module default. `createCustomsAuthoredVegetationRuntime()` accepts a `shadowPolicy` override the renderer's gate would never see, and a gate reading the constant would sit false while lod-0 buckets cast and changed every 4 m |
| `authored-asset-attach` / `-detach` | the streamer's `onCastersChanged`, via the `AUTHORED_ASSET_SHADOW_REASON` table | one authored GLB enters or leaves `authoredRoot`; `seatAuthoredInstance()` writes `castShadow` from the manifest. A table, not a ternary, so an unrecognised kind reaches the closed enum's throw instead of being filed under `attach` |
| `renderer-context-restored` | the `webglcontextrestored` listener and the WebGPU `device.lost` promise, at construction | **the one stale path no fingerprint can see.** A context/device loss reallocates the depth texture EMPTY without touching a caster, so live it re-bakes next frame and nobody notices, while frozen it never re-bakes at all — the scene loses every sun shadow for the rest of the session with the audit reporting `clean` forever, because the caster set genuinely did not change. A failure mode the freeze itself introduces |
| `profiler-ablation` | `applyAblation()` / `armAblation()` / `shadowPixelCheck()` | `?profileAblate=props\|rocks` sets `propGroup.visible` / `rockGroup.visible` false, and both are caster groups. Un-declared, that drew prop shadows on ground with no props — the literal stale-shadow signature, produced by the instrument built to measure the freeze, and reachable in production because `?profile=1` is deliberately not behind `canShowDiagnosticReadouts()`. Invalidates on **both** edges |
| `sun` | declared, **RESERVED and unused** | nothing moves the sun today. The name exists so the day something does, it is already spelled — and it is now listed in an explicit `RESERVED_UNUSED_REASONS` allowlist in `scripts/three-renderer-test.mjs`, which asserts the enum in BOTH directions. A member with no call site is a coverage claim that does not exist; reserving one costs a line in that test, which is the point |

Two deliberate NON-entries, and the reason each is safe:

- **`refreshDynamicNow()`** — the 1 Hz live-player tick. Quest zones, quest pins and player cones are
  built with three's default `castShadow: false`, so none of them casts. Invalidating here would
  re-bake the depth map once a second.
- **`updateUnderstoryLod()`** — runs on every rendered frame. The tufts it switches between are
  `near.castShadow = medium.castShadow = false` at construction.

Both are pinned by a test that reads the source: if either ever builds a caster, it goes red.

And one that is deliberately NOT wired to the frame invalidation it sits beside: the authored
streamer's `onChanged` fires on **every camera pass**, so the shadow map hangs off a separate
`onCastersChanged` callback that only an attach or a detach reaches. Re-baking through a pan would
hand most of the win back.

That reasoning was right and was **defeated one call away**, which is worth recording as its own
lesson: `publishState()` — which also runs on every camera pass — reached
`applyProceduralSuppression()` through `syncSuppression`, and re-baked the map anyway. A callback
carefully kept off the camera path is worth nothing if a sibling call on the same path does the same
work. The dirty-key gate in `syncProceduralSuppression()` is what actually closes it, and the
discriminating test drives the key rather than the comment.

### `?shadowAudit=1` — the loud version of a dropped invalidation

A missed entry is silent: the frame renders, every count is green, and the only symptom is a shadow
of geometry that is not there. So the audit fingerprints the caster set — every visible `castShadow`
object's world matrix, geometry, instance count and alpha-relevant material fields, plus the light
and its shadow camera — and compares it with the fingerprint taken on the frame that baked the map.
A change with no invalidation behind it is a `console.error` and a row in
`renderStats().shadows.audit`, naming the delta **by `userData.kind`** rather than as a bare count.

It found a real one on its first headless run — and then a false one. Both are recorded here because
the second is the more useful:

- **Real:** it named the authored-vegetation swap and the Fortress attach as the moment the caster
  set moves, which is exactly the hypothesis this change was built on.
- **False:** it then reported the Fortress attach as a defect. The attach *had* invalidated; the
  depth map was re-baked before the next `requestAnimationFrame` (this scene renders at ~0.3 fps
  under SwiftShader), so a sampler watching `shadow.needsUpdate` never saw the window. It watches the
  invalidation **sequence counter** instead, which a slow sampler cannot miss. There is a named
  regression test for it.

**What the audit cannot see, stated.** It is a sampler, not a proof: a mutation followed by any
unrelated invalidation before the next tick is masked; a mutation and its reversal between two ticks
are invisible; matrices are quantised to 1/1024 unit; a material edited in place with no version bump
is invisible. A silent audit is evidence, never a guarantee — the unit tests are what pin the list.

### Reading the state

`renderStats().shadows` publishes `mode`, `invalidations`, `byReason` and `last`, in every
environment. A healthy production load reads:

```
mode        frozen-until-invalidated
byReason    world-build 1 · procedural-suppression 5 · nature-visibility 4 · look 1 ·
            procedural-vegetation 1 · authored-vegetation-mount 1 · authored-asset-attach 1
```

Fourteen bakes for the life of the page instead of one per frame — **and that is now true of a page
somebody is panning, not only of an idle one.** Before the suppression dirty-key gate the same
counter climbed by roughly one per camera event, so "fourteen for the life of the page" held only if
nobody moved the map. Six `tz.flyTo` calls used to add +14 on their own.

`stats()` also carries `bakesObserved: null` and says why: nothing samples `shadow.needsUpdate` per
frame on the shipped path — `animate()` is pinned to know nothing about shadows, deliberately — so
this module counts DECLARED invalidations and **cannot confirm a depth map ever actually rendered**.
`invalidations: 14` over a shadow node that never ran would read exactly like a healthy session. That
is stated rather than papered over; `?shadowAudit=1` is the reading that looks at the scene, and its
`stats()` now returns a `verdict` string that says `NOTHING WAS COMPARED` when `checks === 0` instead
of letting `{ checks: 0, defects: 0 }` read as clean.

### The fidelity verdict — re-run after the suppression gate landed

Headless Chromium, WebGL2/SwiftShader, 1400×985, release build, **authored vegetation mounted
(93/93) in every load**, `?shadowAudit=1` armed. Two page loads per arm; a shot is accepted only when
two consecutive captures are byte-identical AND the renderer's own `tz.project()` of three fixed game
points is unchanged across them. Numbers are pixels differing **outside** the `#find` caret band.

| scene | within-load floor | **C2 stale control** | **THE CLAIM** frozen vs live |
|---|---|---|---|
| `initial-nocamera` | 0 px | 35,288 px | **0 px** |
| `pan-arrive` (5-step pan, then back) | 0 px | **209,745 px** | **0 px** |
| `trees-off` / `trees-on` | 0 / 0 | 20,746 / 35,288 | **0 / 0** |
| `look-vector` / `look-realistic` | 0 / 0 | 35,228 / 35,288 | **0 / 0** |

**Read C2 first — it is what makes the claim mean anything.** It is the same build with every
invalidation after the first bake dropped, and it moves 20,746–209,745 px, with visible tree-shaped
shadow blobs on ground that has no tree. The comparator demonstrably sees a stale depth map, so a
0 px claim row is a measurement rather than a blind spot. The caret band itself is a second, free
positive control at 1,254–1,340 px per row.

`pan-arrive` is the row that matters for the suppression gate, and it carries the **largest** stale
signal of any scene — 209,745 px — against a claim of 0 px.

**Bonus, and the strongest single statement here:** the post-gate build was also diffed against the
PRE-gate build in both arms across all six scenes: **0 px outside the caret band, every row, maxΔ 0.**
The gate removed bakes without moving a pixel.

Invalidation counts, frozen arm, showing the gate working rather than merely present:

```
initial-nocamera  13   world-build 1 · procedural-suppression 4 · nature-visibility 4 · look 1 ·
                       procedural-vegetation 1 · authored-vegetation-mount 1 · authored-asset-attach 1
pan-arrive        31   procedural-suppression 10 · authored-asset-attach 4 · authored-asset-detach 3 …
audit                  4,092 comparisons, 0 skipped, 0 defects
```

Before the gate the same pan reported `procedural-suppression: 14`; the four removed were no-ops over
an unchanged set, and the six that remain each accompany a real attach/detach.

**What this run does NOT prove**, stated: it is **WebGL2/SwiftShader**. The founder's −38% / −31% and
the `frameCalls 3 → 2` claim are Chrome/WebGPU on an RTX 5080; the freeze logic is shared
(`WebGPURenderer` + `ShadowNode` on both backends) but no WebGPU pixel was rendered here. The pan is
six discrete `tz.flyTo` calls, not a continuous pointer drag. And GPU context loss/restore is
untested — nothing in a screenshot can see it.

### `?shadows=live` — the escape hatch, and the control arm

It restores three's per-frame behaviour exactly. Three things use it:

1. **The fidelity proof.** `.e2e/p1-shadow-capture.mjs` captures the same build twice — once with the
   flag, once without — and diffs the PNGs. Its one hard rule is that nothing is captured until
   `renderStats().vegetation.mount.phase === 'mounted'`; capturing before that is what made the
   earlier `identical` answers worthless, and the run FAILS rather than substituting the procedural
   forest.
2. **Keeping `?profileAblate=shadow` meaningful.** With the map already frozen the ablation has
   nothing to remove, so `run()` now **throws** rather than producing a report that says "attributed
   0.0 ms" about an experiment that did not happen. `?shadows=live&profileAblate=shadow` is the load
   on which the probe still discriminates, and is how you re-prove it after this change.
3. **A one-line rollback** if a stale shadow is ever seen on the live site.

---

## 4. Every knob

| parameter | default | what it does |
|---|---|---|
| `?profile=1` | off | arms the profiler and the GPU timer. `0`/`false`/`off`/`no` turn it back off. |
| `?profileFrames=N` | 180 | sampled frames per preset (10–2000) |
| `?profileWarmup=N` | 30 | frames discarded before sampling (0–600) |
| `?profileReflowFrames=N` | 60 | overlay-probe frames per variant; `0` skips the probe |
| `?profilePresets=a,b` | all four | which presets to run. An unknown name is reported and the full set is kept. |
| `?profileSelfTest=busy:N` | none | inject N ms into the overlay pass (max 200) |
| `?profileSelfTest=nocull` | none | disable frustum culling on the world roots for the run |
| `?shadows=live` | off | put three's per-frame shadow map back. The control arm of §3c's pixel proof, the load on which `?profileAblate=shadow` still discriminates, and the rollback |
| `?shadowAudit=1` | off | arm the stale-shadow audit — §3c. Dev instrument; it runs in its own rAF loop and touches neither `animate()` nor `renderOneFrame()` |
| `?profileAblate=shadow` | none | render the sun's shadow map once, then freeze it. **Since 2026-09-03 this is already the shipped behaviour**, so on a default load it removes nothing and the A/B correctly attributes nothing; pair it with `?shadows=live` to measure the pass again — §3a, §3c |
| `?profileAblate=props` | none | `propGroup.visible = false`. **Changes pixels on purpose** |
| `?profileAblate=rocks` | none | `rockGroup.visible = false`. **Changes pixels on purpose** |
| `?profileAblate=a,b` | none | combine any of the three. Unknown names are reported and dropped, never silently ignored |
| `?threeBackend=webgl2` | off | force the WebGL2 fallback — the profiler follows it and says so |

Any `?profileAblate=` also puts a **Run A/B/A/B** button on the panel. That is the one to press;
see §3a for why comparing two separate page loads is weaker evidence.

---

## 5. What this does NOT measure, stated

- **It is not the app's idle behaviour.** A run holds the render-on-demand gate open. `fps` in
  `renderStats()` is still what it always was and is still not a frame time.
- **`gpuFrameMs` is one number for the whole frame**, not per pass. There is no per-subsystem GPU
  attribution, and three's timestamp pool does not offer one.
- **Disjoints are NOT counted, and `disjointObserved` is `null` — not `0`.** It used to be a
  hardcoded zero, which is a field named for a condition holding a number nothing measured; a reader
  had every reason to take it as proof none occurred. Neither backend can count them:
  - **WebGPU** has no disjoint flag at all. `EXT_disjoint_timer_query` is a WebGL extension and
    three's `WebGPUTimestampQueryPool` has no disjoint branch — the question cannot be put.
  - **WebGL2 fallback** has `GPU_DISJOINT_EXT`, and *reading it resets it to false*. three's pool
    reads it as its own correctness check (`WebGLTimestampQueryPool.js:329-334`); a second read from
    the profiler would consume the flag before three saw it and make three accept a timing the spec
    calls unreliable. The instrument would corrupt what it measures, so it does not read it.

  What ships instead is `gpuTiming.health.adjacentDuplicates` — the symptom of the pool returning its
  previous value — with `disjointObservable: false` and `disjointReason` saying which of the two
  above applies. `health.adjacentDuplicatesMeaning` states that it is a proxy and how it can be
  wrong. The schema is `tz-render-profile/2` because of this change; a `/1` reader seeing `null`
  would treat it as a zero, which is the mistake the fix exists to stop.
- **The GPU-memory figure is an estimate**, computed by walking the scene. It overstates
  GPU-compressed (KTX2) textures and understates driver padding, and says both in its own
  `assumptions` array. `renderer.info.memory` counts *objects*, not bytes, and resident objects are
  not the same as drawn ones.
- **`performance.memory` is Chrome-only, quantised and rate-limited.** The allocation figure is a
  lower bound. The collection count is not.
- **A count cannot detect facing, presence or visibility.** A back-face-culled or occluded mesh is
  counted as drawn, here as everywhere else in this repo.
- **If a timestamp resolve hangs for 3 s the GPU channel switches itself off** mid-run, with
  `gpuTiming.reason` saying so. A backend that issues timer queries but never completes them would
  otherwise produce a run with no GPU samples and no explanation.
- **The defaults assume a real GPU.** Headless Chromium on SwiftShader — every capture previously
  taken in this project — renders this scene at roughly **2–4 seconds per frame**, so the default
  180 sampled frames per preset is a twenty-minute run there. Under SwiftShader use
  `?profileFrames=12&profileWarmup=3&profileReflowFrames=4`. On the 5080, leave the defaults alone.

---

## 6. Cost when the profiler is off

One `if (frameProfiler)` per *rendered* frame, one per `refreshDynamic()` call, one per
`pointermove`, and `trackTimestamp: false` at renderer construction — which is what three already
does today. Nothing was added to `updateOverlayPositions()`, the loop that runs per overlay item per
frame. `scripts/render-profiler.test.mjs` pins all of that by reading the source: it asserts that
`renderOneFrame()` is exactly the four calls it always was, that the overlay loop mentions no timing
symbol at all, and that `animate()` contains exactly one `frameProfiler` branch.

**The ablations meet the same standard, proved the same way.** `parseAblation` returns `null` when
`?profileAblate=` is absent, and every write they make — `sun.shadow.autoUpdate`, `propGroup.visible`,
`rockGroup.visible` — lives inside `createRenderProfiler()`, which is only built when `?profile=`
armed the run. A source test asserts that every occurrence of those symbols sits after
`function createRenderProfiler(`, that `applyNature()` (the function that would otherwise fight an
ablation) knows nothing about them, that neither arm of `animate()` mentions them, and that
`activeAblation.restore()` is in `run()`'s `finally` — an ablation that leaked past its run would
silently ablate the baseline arm of the next A/B series.

Measured, not asserted. A microbenchmark of the exact shape — the four calls inline (what
`animate()` used to hold) against `if (frameProfiler) … else renderOneFrame()` with the profiler
null — over 200,000,000 iterations, three alternating passes, median:

```
before (inline four calls)   25.95 ns
after  (branch + call)       32.30 ns
added                         6.35 ns per RENDERED frame
```

**6.35 ns against a 16,666,667 ns frame budget — 3.8 × 10⁻⁷ of one frame.** At a pathological 1,000
rendered frames per second that is 6 µs of CPU per second. The benchmark stands in trivial functions
for the four real calls on purpose: it isolates the wrapper, which is the only thing that was added.
What it does not prove is browser-JIT behaviour, which differs from Node's; the source-pinned tests
above are what prove that nothing was added to the per-item loop, where a real cost could hide.

---

## 7. Where the code is

| file | what |
|---|---|
| `src/shadow-invalidation.js` | pure — the closed enum of invalidation reasons, the shadow controller, the caster fingerprint and the stale-shadow audit. §3c. No DOM, no THREE. |
| `.e2e/p1-shadow-capture.mjs` | the fidelity proof: one arm per invocation (`--shadows frozen\|live`), gated on `vegetation.mount.phase === 'mounted'`. Diff with `.e2e/pngdiff.mjs`. |
| `src/render-profiler.js` | pure — presets, statistics, phase accounting, waterfall, ablation specs and A/B comparison, report shape and its refusals. No DOM, no THREE. |
| `src/map3d-three.js` | the browser half — GPU timer, phase marks, the batched overlay probe, the ablations, the shadow pixel check, the panel. Search `createRenderProfiler`. |
| `scripts/render-profiler.test.mjs` | `npm run test:render-profiler` |
| `src/main.js` | `tz.profile()`, `tz.profileReport()`, and `fitView` for the `cover-fit` preset |

**On the gate:** the profiler is deliberately *not* behind `canShowDiagnosticReadouts()` and does not
import `src/renderer-gate.js`. That predicate is dev + loopback, and both configurations where a
real-GPU baseline can be taken — a release `vite preview` on 127.0.0.1, and the live site on your
machine — answer it `false`. It publishes nothing local: every number describes the frame the visitor
is already being served. The full argument is in `src/render-profiler.js`'s header, and a test pins
that it stays separate.
