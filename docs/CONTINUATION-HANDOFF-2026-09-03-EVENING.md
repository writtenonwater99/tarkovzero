# Continuation handoff — 2026-09-03, evening session

Supplements `CONTINUATION-HANDOFF-2026-09-03.md` (still the architectural cold-start). This file
covers only the evening session: marker fixes, an icon system for the Three overlay, a real-GPU
profiler, and a measured performance plan that is **part-executed**.

## 🔴 READ FIRST — the tree is mid-flight

**Nothing in this session is committed.** 15 changed/untracked files. `main` still diverges from
`origin/main`; a push to `main` auto-deploys.

`dist/` on disk was built BEFORE P1 (it is the P2 state), so the preview the founder last browsed
does not contain the freeze. **It was deliberately not rebuilt.**

### P1 — SHIPPED, with the two defects that made it worthless fixed (2026-09-03, close-out)

P1 is no longer partial. It was audited (42 findings), adversarially refuted from three angles, and
pixel-verified headless. **It ships.** Two things were wrong and both are fixed:

1. **The freeze was being lifted on every camera event, so it bought almost nothing in real use.**
   The authored streamer's `publishState()` runs on *every* pass — before its own empty-diff early
   return — and drove `applyProceduralSuppression()` → `sunShadow.invalidate('procedural-suppression')`
   unconditionally. Every OrbitControls `change` runs a pass. Since this app renders **on demand**,
   frame time only exists while the camera is moving, so the optimisation was defeated in exactly the
   regime it was bought for. The measured −38% / −31% describes a **parked camera** and nothing else:
   `runPreset()` sleeps 500 ms and samples with the camera still, so no A/B could ever have seen it.
   Measured on the shipped tree: six `tz.flyTo` calls produced **+14 invalidations** (nine of them
   `procedural-suppression` over an unchanged set), plus 11 `InstancedMesh` buffer rewrites and a GPU
   re-upload of 195 identical matrices per camera event.
   → `syncProceduralSuppression()` is now gated on the resolved set actually changing, using the
   dirty-key shape `syncPlinthSuppression()` already used. `rebuildWorld()` clears the key.

2. **The probe that produced `true, false, true, false` was measuring something other than its
   labels.** Two independent defects: (a) the arm labelled `live` inherited `sun.shadow.autoUpdate`,
   which since the freeze is `false` — so it was frozen-vs-frozen under a live label, and
   `identical: false` actually meant *the resident map was stale at that moment*, i.e. the P1 defect
   signal, correctly detected and wrongly named; (b) all five renders ran in one synchronous task,
   therefore one `nodeFrame.frameId`, and `ShadowNode.updateBefore()` refuses to bake twice for one
   camera on one frame id — so which arms could bake depended on whether `animate()` had already
   rendered in that tick. Nondeterministic, which is what an alternating verdict looks like.
   → `tz.profileShadowPixels()` is **async**, one rAF tick per arm, forces the live arm through the
   controller, and returns two named verdicts (`residentMapWasCurrent`, `freezeIsPixelFree`) plus a
   **null control** (two identical renders must hash equal) that the old probe did not have.

**One genuinely uncovered caster mutation existed and is fixed**: `applyAblation()`'s
`?profileAblate=props|rocks` hid `propGroup` / `rockGroup` — both caster groups — with no
invalidation, so under a frozen map it drew prop shadows on ground with no props. That is the exact
stale-shadow signature, manufactured by the instrument built to measure the freeze, and reachable in
production (`?profile=1` is deliberately not behind `canShowDiagnosticReadouts()`). An exhaustive
adversarial sweep of the streaming, LOD, suppression, repack, dynamic-root and understory lanes found
no other one.

**A new failure mode the freeze introduces is now closed**: GPU context/device loss reallocates the
depth texture EMPTY without touching a caster, so frozen it would never re-bake — the scene loses
every sun shadow for the rest of the session while the audit reports `clean` forever, because the
caster set genuinely did not change. `'renderer-context-restored'` + listeners on both backends.

**The fidelity verdict, re-run after the gate landed** (headless WebGL2, release build, authored
vegetation mounted 93/93 in every load, `?shadowAudit=1` armed, two loads per arm):

| scene | within-load floor | **stale positive control** | **CLAIM** frozen vs live |
|---|---|---|---|
| `initial-nocamera` | 0 px | 35,288 px | **0 px** |
| `pan-arrive` | 0 px | **209,745 px** | **0 px** |
| `trees-off` / `trees-on` | 0 / 0 | 20,746 / 35,288 | **0 / 0** |
| `look-vector` / `look-realistic` | 0 / 0 | 35,228 / 35,288 | **0 / 0** |

Read the control column first: it is the same build with every invalidation after the first bake
dropped, and it shows tree-shaped shadow blobs on ground with no tree. The comparator can see a stale
depth map, so 0 px is a measurement and not a blind spot — and `pan-arrive`, the row the suppression
gate most affects, carries the largest stale signal of any scene. Audit: **4,092 comparisons, 0
skipped, 0 defects.** The post-gate build was also diffed against the **pre-gate** build in both arms
across all six scenes: **0 px, maxΔ 0** — the gate removed bakes without moving a pixel.

Details, tables and the re-derived invalidation list: `docs/PROFILING.md` §3b and §3c.

Test state: **151/151** across `scripts/three-renderer-test.mjs` + `scripts/render-profiler.test.mjs`
(was 97 + 45), **24/24** icons, 85 LOD checks, 28 label-tier, DOM contract 119/22. Every new
assertion was mutation-proved red then restored green.

### 🔴 STILL UNPROVEN after this pass — do not read the above as more than it is
- **WebGPU.** Every one of the 15 verification loads reported `backend: "webgl2"` (headless
  SwiftShader). Pixel identity is proven on the WebGL2 `ShadowNode` path. The freeze logic is shared,
  but no WebGPU pixel was rendered.
- **A continuous drag.** The pan is six discrete `tz.flyTo` calls, not a pointer drag. Fidelity is
  argued to hold a fortiori; the **performance** win during a real drag is un-measured on real
  hardware, and that is the number the suppression gate exists to create.
- **GPU context loss / restore.** The handler and its reason are unit-tested; the actual loss →
  restore → re-bake path is not, and nothing in a screenshot could see it.
- **`founder-a` / `ground-close` pose loads** were verified in the pre-gate pass, not re-run in this
  one. They are static-pose loads where the camera is never touched, the class `initial-nocamera`
  covers, and the post-gate build is pixel-identical to the pre-gate build in every scene that WAS
  re-run.
- **Timings.** This pass measured fidelity only. No frame-time claim here is new.

---

## 1. What shipped this session (all uncommitted, all tested)

### Marker overlays were clipped to 19% of the map
`THREE_POC_SCOPE` — a leftover 360×300 m "industrial rail-yard golden cell" — gated every overlay
(labels, markers, extracts, quest zones, quest points) in the Three renderer, while terrain,
buildings, vegetation and the camera had all been promoted to the full 1,024×541 m limit.
Extracts drawn went **8/32 → 32/32**, place labels **12/32 → 32/32**. The gate is now derived from
`data.limit` at runtime (bbox + 40 m margin) and throws rather than falling back. deck.gl was never
affected — it gates on the real limit polygon.

### TRAIN / RED CONTAINER chips removed
`TACTICAL_PROP_CALLOUTS`, two hardcoded `kind: 'landmark'` chips. Deleted outright. A repo-wide
sweep confirmed no second source. The 3D props still render; only the floating labels are gone.

### The Three overlay had no icons at all
`makeOverlayItem()` set `element.textContent` and nothing else — every marker was an identical dark
text pill, which is why the map read as ~100 stacked "BURIED BARREL CACHE" chips. The existing
17-kind SVG badge vocabulary (used by 2D Leaflet and deck.gl) is now wired in, driven by the shared
`src/lod.js` ladder. Loot/spawn/utility = badge only, name on hover; extracts keep letter **and**
name; `kind: 'place'` labels untouched.

Palette, held to the repo's own measured floors (badge ≥103.8, dot ≥56.9 RGB distance):
`weapon`/`lock` 48.8 → 218.4 · `sniper`/`boss` 50.9 → 145.6 · `scav`/`pmc` spawn 61.4 → 138.8.
Plus an ink halo on shields and diamonds, and family shape carried into the dot tier.
**Open founder question: boss spawns went red → magenta `#C74FAE`.** Red-for-boss is the Tarkov
convention; easy to revert and buy the separation from the sniper side instead.

### Overlay marks were clamped into the viewport
`seatOverlayAnchor()` clamped off-screen marks against a rect that included the toolbar, HUD chips
and the Ask panel, so they pinned to a frame bound and slid with the camera. Replaced by
`anchorOverlayMark()` — returns the true position or `null`, never repositions. Measured under a
205.4 px pan: marks frozen in place 13 → **0**, marks on a clamp bound 35 → **0**.

### LOD threshold
`BOUNDS[0]` 0.33 → 0.465 so the founder's `#3.48` and `#3.92` are the same `icon` tier.
**`lod.js` is shared** — Customs at cover-fit+half-step now draws badges in all three renderers, and
**Reserve's cover fit moves dot → icon** (locked map, asserted in a test rather than hidden).

---

## 2. The profiler — `src/render-profiler.js` + `docs/PROFILING.md`

Built because **this repo had no frame-time instrument at all**. `fps` measures render-*request*
rate. Every prior capture was headless SwiftShader. The handoff's headline
"1,439 draw calls / 531,436 triangles" is superseded and wrong.

Run: `?profile=1`, wait for `MOUNTED — ready`, **Run baseline**, **Download JSON**.
`?profile=1` must be present **at load** — three reads `trackTimestamp` from the renderer
constructor and never again.

Ablation flags for attribution: `?profileAblate=shadow|props|rocks` (comma-combinable).
`Run A/B/A/B` alternates arms **within one page load**, holding shader/pipeline warmup and texture
residency constant, and refuses to call a delta attributed unless it clears the widest within-arm
spread. `tz.profileShadowPixels()` frame-hashes with a control that must differ or the check voids
itself. Self-test flags `?profileSelfTest=busy:N|nocull` are proven to discriminate on both
channels; such reports are stamped so they can never be read as a baseline.

**Instrument honesty fixes** (a Codex red team found the first): `disjointObserved` was **hardcoded
`0`** — a field that read as evidence and never observed anything. Now `null` + observability
reason. On WebGL2 the disjoint flag **resets when read**, so a profiler reading it would consume it
before three could and make three *accept* a timing the spec calls unreliable — so the honest answer
is not to read it. Five more asserted-not-measured fields were corrected. Schema bumped to
`tz-render-profile/2`.

---

## 3. The measured baseline (founder's RTX 5080 Laptop, Chrome, WebGPU, 2560×1295, veg mounted)

Medians in ms. **Brave distorts these** — it spoofs `hardwareConcurrency`, `deviceMemory` and the
GPU string, read GPU 6.82 where Chrome reads 11.24, and invented a 48 ms p95 spike that does not
reproduce. Use Chrome only.

| preset | cpu (225 items) | cpu (1,304) | render | overlay (1,304) |
|---|---|---|---|---|
| founder-a | 11.30 | 13.80 | 10.90 | 2.90 |
| founder-b | 11.70 | 14.30 | 10.35 | 3.90 |
| cover-fit | 11.80 | 16.00 | 12.70 | 3.20 |
| **ground-close** | 9.90 | **20.90** [30.60 p95] | 10.15 | **10.60** [13.80] |

`ground-close` + all layers is the **only** measured configuration over the 16.67 ms 60 Hz budget.
`controls` and `lod` are 0.00 ms. First paint: `worldBuild` 1,317 ms, `vegetationMount` 2,370 ms,
span 4,930 ms. 998 resident geometries.

**Do not compare cpu vs gpu per-frame causally**: GPU timing is a sampled distribution (50–71
samples per 180 CPU frames) returned from the most recently resolved frame, not paired with
`render`.

---

## 4. The plan, and what is done

Full document: `PERF-PLAN-FINAL.md` (scratchpad). Synthesised from two independent passes — Codex
`cxt-20260903-195542-mws0` and a Claude pass — then red-teamed by Codex `cxt-20260903-210116-trjd`,
which returned **proceed modified** and killed the plan's central inference: `render` being
invariant to item count and camera pose does **not** establish it is submission-bound. Under WebGPU
that phase also covers traversal, culling, shadow command encoding, binding and queue back-pressure.

- **P2 — overlay two-phase. ✅ DONE, pixel-identity proven.** Compute pass then write pass; element
  boxes cached with a `ResizeObserver`; no `offsetWidth` read in the frame loop; one hoisted
  `Vector3`; unchanged transforms skipped. Also reverted a regression introduced earlier the same
  day (dimensions read for all 1,304 items to place ~186). Headless ratio 3.5× at founder-a, **6.9×
  at ground-close**. Pixel proof carried a positive control (1,340 px, a blinking caret) and a
  noise floor; before-vs-after was 0 px, and 3 px in one box identical to the noise floor.
  `contain: layout paint` was tried, moved **102,428 px** (clips the anchor ring and label
  drop-shadows), bought ~0.15 ms, and was **declined**.
- **P1 — freeze the shadow map. ✅ SHIPPED, fidelity proven headless, two real defects fixed.**
  See the red banner. A/B/A/B, veg mounted, all layers: founder-a CPU 16.00 → **9.85** (−38%), render
  12.45 → 6.50; ground-close CPU 22.45 → **15.60** (−31%, under budget), render 10.80 → 4.10;
  draw calls −482; `frameCalls` 3 → 2 (the nested shadow render disappearing). Overlay correctly
  attributed **nothing**. Ignore the GPU channel here (founder-a read 8.18 → 0.13, ground-close
  flat — inconsistent, probably scoped to the shadow pass; unexplained, worth chasing).
  **Those numbers describe a PARKED CAMERA** — that is not a caveat, it is the reason the suppression
  dirty-key gate had to land: before it, a drag re-baked the depth map on every camera event, so P1
  bought nothing in the only regime where frame time exists. **Re-measure on the 5080 with a drag,
  not just with the presets** — that number does not exist yet.
  The vegetation-swap hypothesis in the old text was correct but was never the cause of the founder's
  alternating `identical`: the swap IS invalidated (`authored-vegetation-mount`), and the alternation
  came from the probe. See the banner.
- **P3 — merge 111 rock geometries + prop sub-meshes.** Not started. `?profileAblate=props|rocks`
  exist and are unrun on real hardware. **They changed meaning under the freeze and the reports now
  say so**: props and rocks are casters, so pre-freeze their cost included the depth pass; frozen,
  those flags measure the **colour-pass share only**. Pair with `?shadows=live` for the all-in number
  before sizing P3. P1's size may make P3 not worth its hover-fixture risk.
- **P4 (allocation churn) / P5 (first paint).** Gated on measurement. The ~20 MB/frame figure is
  **Brave-only and unconfirmed**.
- **Pointer raycast** — recursive over ~700 meshes incl. a 1,039-instance `InstancedMesh` on every
  `pointermove`. **UNMEASURED, not dismissed** — it sits outside the instrumented frame phases.

### Dropped, with reasons
- **Terrain 12-layer / 40-fetch shader branching** — GPU is not the consistent bottleneck; not
  provably pixel-identical (filtering and derivatives). Codex was right.
- **Wire-size gzip** — Vercel **already serves brotli** (curl-verified: 4.20 MB → 1.98 MB). The
  older handoff's "43 MB → 19.8 MB available" open item is **FALSE — delete it.**
- **Offline mip chains** — a correctness trap in three r185, not a win. The 36 loose terrain PNGs
  (~15.5 MB) are never fetched: deploy size only.
- **`fps` as a metric.** **Chasing the draw-call number for its own sake.**

---

## 5. Open decisions for the founder
1. **Commit strategy.** 15 files, ~2,900 insertions, one session. Well past the ≈400-line review
   unit — split before review. A push to `main` deploys.
2. ~~**P1: finish or revert.**~~ **Settled: it ships.** What is left is a *measurement*, not a
   decision — re-take the A/B on the 5080 **with the camera moving**, because every number on record
   was taken with it parked and the whole point of the suppression gate is that the drag case is now
   different. Also worth one look at `?shadows=live` side by side, by eye, on real hardware.
3. **Boss spawn magenta** vs the red convention. **Unchanged — the magenta stays.** Its own
   justification (70 RGB from the `hazard` purple, the number that chose it over violet) is now
   asserted in `scripts/icons-test.mjs`, with the rejected violet kept in-process so the assertion is
   shown to discriminate. Two things it turned up that are worth a founder glance, neither of which
   moves a pixel today:
   - at the **dot** tier boss/hazard is 39.1 apart, under the 45 floor — accepted because a shield
     and a diamond are different silhouettes, but it is now a recorded exception rather than an
     unmeasured one, and the palette note's "widens every spawn pair at the dot tier" is true
     *within* the spawn family only;
   - the floors were only ever enforced **within** a shape family, so 24 cross-family pairs sit under
     the dot floor and nothing measured them. Worst is `loot-valuables` vs `quest-objective` at
     **8.5** — the same order as the old seven greys' worst pair (3.0), the benchmark the whole 7→3
     collapse was justified against, on the highest-intent marker on the map. The set is now pinned
     with its numbers so it cannot get worse silently. Moving `quest-objective` off amber is a real
     option and is **your call, not a fix I made** — it changes a look you approved.
4. **Stash imagery** — real per-spot photos **do not exist**: tarkov.dev has no image capability for
   loot containers (verified in the decoded bytes), and the EFT Wiki marker schema's `link.url` is
   empty for **all 1,367** stash markers across three maps. The founder's 65 survey photos are
   rail-yard rolling stock, and raw captures are categorically unpromotable. Options: per-*type*
   wiki illustration (~4–8 h, ships) or his own photos (localhost only, forever).
5. ~~**Profiler gating.**~~ **SETTLED 2026-09-03, at the push.** `?profile=1` stays PUBLIC — it is
   deliberately NOT behind `canShowDiagnosticReadouts()` (dev+loopback), because both places a real
   baseline can be taken answer that `false`, and it has its own predicate with a test pinning them
   apart. Consequence, accepted: on production, `?profile=1` exposes render stats. `?shadows=live`
   stays public too (pixel-identical by proof, and the rollback if a frozen shadow ever misbehaves).
   What DID move: `?profileAblate=`, `?profileSelfTest=` and `?shadowAudit=` are now question (e) of
   `src/renderer-gate.js` — `canRunSceneMutatingInstruments({ hostname })`, **loopback only, taking
   no `dev`**, because §3a's ablation sequence and every `.e2e/` fidelity harness run a release
   `vite preview` on 127.0.0.1. Refused off loopback on four channels (console, panel, a throw
   instead of a report, `renderStats().instruments`), never a silent no-op. It is a RUNTIME refusal:
   the bodies are still in the chunk, unreachable, because the release bundle is also the bundle the
   instruments have to run in on loopback. Full statement: `docs/PROFILING.md` §0.
6. **Latent, preserved on purpose:** a mark whose box overlaps the frame but whose anchor point is
   off-screen stays hidden until the anchor comes on. Asymmetric; changing it would move pixels.

## 6. Known-ugly, not regressions
- **No label de-confliction in the Three overlay** — `labelObstacles()` is Leaflet-only. Visible as
  colliding extract names on the right bank and top right.
- **No marker clustering in Three** — 2D and deck.gl cluster below `full` tier; Three does not.
- **Railway geometry is still clipped to the old POC box** — 494/1,050 segments, 46% of the track.
  Deliberately left: it is geometry, not overlay.
- **The sun target still aims at the old golden cell** (`map3d-three.js:1444`).
- `src/roadmap.js:37` `TypeError` on cold load in **dev bundles under `vite preview`** only:
  `ASSETS` points at `/tiles`, a dev-server-only middleware route, so the SVG fetch returns the SPA
  `index.html`. Not a production path.
- Pre-existing `glDrawArraysInstancedANGLE: primcount < 0`.
