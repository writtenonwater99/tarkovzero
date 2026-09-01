# Vegetation draw calls — making all 31 authored families admissible

Design pass, 2026-09-01. Localhost-only (dev + loopback + Customs + `?renderer=three`). No production
path is assumed and nothing here is promoted into `public/`.

Every number below was produced by a measurement script run against the real pack and the real
placement plan on this machine. Scripts live in the session scratchpad
(`measure-veg.mjs`, `measure-veg2.mjs`, `measure-veg3.mjs`, `measure-veg4.mjs`, `measure-alpha.mjs`,
`measure-poses.mjs`, `bench-batched.mjs`, `bench-churn.mjs`) and are reproduced as a permanent
harness in §7. Nothing in `src/`, `scripts/` or `package.json` was modified by this pass.

---

## 0. The one-paragraph answer

The 180× draw-call explosion is **not caused by admitting 31 families**. It is caused by two
decisions that are independent of family count and can both be reversed without touching a single
GLB: (1) the runtime opens one `InstancedMesh` per **cell × prototype × material**, so the 128 m
spatial grid multiplies the batch count by 703; (2) the pack ships **199 distinct materials** that
differ only in which small texture they sample, so each prototype-cell costs 2–3 draw calls instead
of 1. Collapse the 199 materials into **one** material backed by a texture array, and drop the cell
grid in favour of per-instance LOD, and the count falls from a measured **1,333–2,016** to a
structural ceiling of **93**, measured **31 at the default orbit camera** and **≤82 at any of seven
sampled camera poses**. `BatchedMesh` is real, is present in the installed three, and would take
this further — but on this project's renderer (WebGPU backend) it does **not** produce one draw
call, and that is the reason it is staged second rather than first.

---

## 1. Corrections to the established facts

Four of the briefed facts need amending before the design rests on them.

**1.1 `renderStats().drawCalls` is currently reporting the wrong number.**
`src/map3d-three.js:2445` reads `renderer.info?.render?.calls`. Under `WebGPURenderer` that field is
**cumulative `renderer.render()` invocations since page load** (`Renderer.js:1598`), not per-frame
draw calls. The per-frame draw-call counter in the common `Info` class is `render.drawCalls`
(`Info.js:158`). Any draw-call figure ever read out of `window.tz.renderStats()` on the Three
renderer is a frame counter. **This must be fixed before any measurement in this plan means
anything** — it is step 0 of the implementation sequence, and it is a one-line change.

**1.2 The adapter's default alpha policy is `report`, not `reject`.**
`CUSTOMS_AUTHORED_VEGETATION_ALPHA_POLICY = { blend: 'report' }`
(`src/customs-authored-vegetation.js:40-43`). `reject` is opt-in by the caller. The 71.7 % figure
is right as arithmetic — the 22 families that carry a LOD0 BLEND card own **6,312 / 8,805 = 71.7 %**
of placements, and the 9 families with no card own the other 2,493, which is exactly the
"9-family subset" the founder rejected — but nothing in the shipped defaults rejects anything today.

**1.3 Worst case is 2,016, not 1,467.**
Measured over the real placement plan at the frozen 128 m cell size:

| every cell at | prototype-cells | draw calls |
|---|---|---|
| LOD0 | 703 | **2,016** |
| LOD1 | 703 | **1,333** |
| LOD2 | 703 | **1,333** |

1,333 is the floor, not the typical. The worst *realistic* camera pose measured (player eye, open
field, mixed LOD bands) gives **1,503**. The briefed 1,467 sits inside that band and is fine as an
order of magnitude; the ceiling is 2,016.

**1.4 "No MASK material and no alphaCutoff anywhere" is true, and it is a labelling error in the
pack, not a real alpha requirement.**
Decoded every base-colour PNG in the pack (all 199 are 8-bit RGBA, non-interlaced):

- All **177 OPAQUE** layers have base-colour alpha **= 255 at every texel**. Zero exceptions.
- All **22 BLEND** layers have **strictly binary alpha**: the per-image histogram has exactly two
  non-empty buckets, `α < 32` and `α ∈ [224, 255]`, and `fracBelow128 == fracBelow32` for every one
  of the 22. There is no partially transparent texel anywhere in the pack.

So converting the 22 cards to `alphaTest = 0.5` is **lossless by measurement**, not a judgement
call. This is the single fact that unlocks everything else: it means one material can serve all 199
layers, and it retires the BLEND admission problem instead of working around it.

---

## 2. What the pack actually is (measured)

| property | value | why it matters |
|---|---|---|
| families × LODs | 31 × 3 = 93 GLBs | |
| total GLB bytes | 15,328,292 | |
| primitives (= material slices) | **199** | this is the draw-call multiplier, not 31 |
| materials | 199, all distinct signatures | zero sharing between families |
| alpha modes | 177 OPAQUE / 0 MASK / 22 BLEND | §1.4 |
| doubleSided | 199 / 199 | one `side: DoubleSide` for everything |
| per-LOD material counts | L0: 3 assets×1, 2×2, 26×3 · L1/L2: 5×1, 26×2 | |
| **vertex attributes** | `POSITION, NORMAL, TANGENT, TEXCOORD_0` on **all 93** | uniform — `BatchedMesh` and `mergeGeometries` both accept the whole pack unmodified |
| index component type | `UNSIGNED_SHORT` on all 93 | |
| triangles | L0 104,940 · L1 12,450 · L2 2,202 (whole pack, one of each) | |
| vertices | L0 122,966 · L1 16,814 · L2 3,144 → **142,924 total** | the entire pack is 6.86 MB of vertex data |
| texture slot combo | `baseColor + metallicRoughness + normal + occlusion` — **identical on all 199** | one shader signature; ORM shares one image (`R=occlusion, G=roughness, B=metallic`, per `extras.tz_orm_channels`) |
| images | 597, all distinct, all PNG RGBA8, 128/64/32 px | 7.29 MB compressed |
| material scalars | `normalScale` = 0.78 (L0) / 0.62 (L1) / 0.48 (L2); **every other factor is absent on all 199** | only one scalar varies, and only by LOD |
| semantic material families (`extras.tz_material_family`) | **18** (12 at L1/L2, +6 `-card` families that exist only at L0) | the 6 card families are exactly the 22 BLEND materials |
| **UVs** | **173 / 199 primitives have UVs outside [0,1]**, global range U ∈ [−1.03, 2.16], V ∈ [−4.19, 1.04]; every sampler wraps `REPEAT/REPEAT` | **this is what kills naive atlasing** |
| LOD1/LOD2 textures vs LOD0 | not downsamples: mean |Δ| = 4.6/255, worst image mean 13.0, worst texel 170 | independently generated per LOD |

Placement plan (from `.local-game-derived/customs/`, mirrored exactly by
`buildCustomsLocalVegetationRenderPlan`): 8,805 instances, 0 unbound, extent **1,397 × 698 m**.
Instance distribution is very uneven — `pine01` alone is 1,830 (20.8 %), `grass_dry3` 1,166, and the
bottom 6 families are 30, 25, 24, 18, 17, 14, 4, 1 instances.

---

## 3. The options, measured

### (a) `three.js BatchedMesh` — present, capable, and **not one draw call on this renderer**

**Installed and exported.** `three@0.185.1`, `src/objects/BatchedMesh.js`, exported from
`Three.Core.js:18` and therefore from `three/webgpu`, which is what every renderer module in this
repo imports (`map3d-three.js:10`, `customs-authored-vegetation.js:18`,
`customs-terrain-pbr-runtime.js:8`, `three-prop-assets.js:9`). It is the modern API with
`addGeometry` / `addInstance` separated, `setGeometryIdAt`, `setVisibleAt`, `perObjectFrustumCulled`,
`sortObjects`, `setColorAt`, `optimize()`. Both backends handle it:
`WebGPUBackend.js:1806`, `WebGLBackend.js:1023`, `GLSLNodeBuilder.js:1325`.

**Limits, measured by building one with the real pack's counts and the real 8,805 placements:**

| | value |
|---|---|
| geometries added | 93 (all families × all LODs in **one** mesh) |
| instances | 8,805 |
| vertex buffer | 6,860,352 B |
| index buffer | 1,435,104 B (auto-promoted to `Uint32` because maxVertexCount > 65535 — `BatchedMesh.js:400`) |
| matrices texture | 565,504 B (192×192 RGBA32F) |
| colors texture | 141,376 B (94×94 RGBA32F) — per-placement tint survives |
| indirect texture | 35,344 B, **re-uploaded every frame** (`onBeforeRender` sets `needsUpdate = true` unconditionally) |
| multiDraw scratch arrays | 70,440 B |
| **total** | **≈ 9.1 MB** for every family, every LOD, every instance |

`maxInstanceCount` / `maxVertexCount` / `maxIndexCount` are constructor arguments with no hard
ceiling; the practical ceilings are the matrices texture (grows as √(4N)) and `Uint32` indices.
Nothing in this pack comes near either.

**Per-frame CPU cost** — `onBeforeRender` is an O(N) JS loop over every instance doing
`getMatrixAt` → `getBoundingSphereAt` → `applyMatrix4` → `frustum.intersectsSphere`, plus a full
sort of the survivors when `sortObjects` is on. Measured on this machine, 240 frames per pose,
8,805 instances, one BatchedMesh:

| camera pose | visible after cull | ms/frame cull+sort | ms/frame cull only |
|---|---|---|---|
| ground level, centre | 1,861 | 0.436 | 0.235 |
| orbit default (1.5 km) | 8,805 | 1.327 | 0.277 |
| orbit close (400 m) | 6,453 | 1.008 | 0.260 |
| top-down whole map | 8,805 | 1.356 | 0.267 |
| corner, looking away | 0 | 0.178 | 0.215 |
| nothing changed, cull+sort off | — | **0.000** (early-out at `BatchedMesh.js:1521`) | |

Two operational conclusions with numbers behind them: **`sortObjects = false`** saves ~1.0 ms/frame
at 8,805 visible and is correct once the cards are `alphaTest` (nothing needs back-to-front); and
per-object frustum culling is worth keeping — at ground level it removes 79 % of instances for
0.24 ms.

**The disqualifier for stage 1.** `BatchedMesh` is one draw call *only where multi-draw exists*:

- **WebGL2 fallback**: `WebGLBackend._draw` calls `renderer.renderMultiDraw(...)` when
  `WEBGL_multi_draw` is present — genuinely one GL call. Without the extension it loops
  `gl.uniform1ui(nodeUniformDrawId, i)` + `renderer.render(...)` per element.
- **WebGPU backend** (the default here; `forceWebGL` is opt-in via `?threeBackend=webgl2`):
  `WebGPUBackend.js:1806` loops `passEncoderGPU.drawIndexed(counts[i], 1, starts[i]/bpe, 0, i)`
  once per visible element, and calls `info.update(...)` each time, which increments
  `render.drawCalls` (`Info.js:158`). **`renderer.info.render.drawCalls` will read 8,805 at the
  default orbit pose.**

Those 8,805 commands share one pipeline and one bind group, so they are far cheaper than 8,805
ordinary draws — but "cheaper" is a claim about GPU/encoder time on a real device, and this project
already knows it cannot measure that (`gpuFrameMs` is null under SwiftShader). Betting the primary
strategy on an unmeasurable is the wrong shape of bet when a strategy exists whose ceiling is
structural.

**Verdict: viable, excellent, staged second.** It is the right answer to per-instance LOD (see §6)
and the right answer if the WebGPU command-count question resolves favourably on the founder's real
GPU. It is not the right *first* move.

### (b) Texture atlasing across prototypes — **rejected on measurement**

The blocker is not the build cost. It is that **173 of 199 primitives have UVs outside the unit
square**, on samplers that all wrap `REPEAT/REPEAT`, with a global range of U ∈ [−1.03, 2.16] and
V ∈ [−4.19, 1.04]. A tiled UV set cannot be packed into an atlas without either re-baking the
texture across its full tiled extent, or emulating `fract()` in the shader (which breaks the mip
derivative at every tile seam and needs explicit gradients).

Measured re-bake cost, at each LOD's native resolution, per primitive's actual tile extent:

| LOD | primitives | native texels | re-baked texels | median tile factor | worst |
|---|---|---|---|---|---|
| 0 | 85 | 1,392,640 | 6,455,296 | 2× | 21× |
| 1 | 57 | 233,472 | 1,277,952 | 4× | 21× |
| 2 | 57 | 58,368 | 316,416 | 4× | 21× |
| **total** | 199 | 1,684,480 | **8,049,664** | | |

8.05 M texels needs a 2,838² square, i.e. a 4096² page **per slot**; with four slots collapsed to
three images (baseColor, ORM, normal) that is 4096²×4×3 = **201 MB** before mips, against 1.68 M
native texels. The atlas costs 4.8× the texture memory of the source and requires rewriting UVs on
199 primitives and re-baking 597 images.

And it leaves the cell grid untouched: at 128 m the floor is still **703** draw calls (one per
prototype-cell), because an atlas collapses materials, not geometries. To get below 703 the cells
have to merge too — which is option (c), or is unnecessary under §4.

**Verdict: rejected.** The goal an atlas serves (one material) is achieved for **27 MB and zero UV
edits** by a texture array, because array layers wrap independently — see §4.

### (c) Raising the 128 m cell constant

**Why it is "frozen": it isn't, in any load-bearing sense.** The constant is
`CUSTOMS_AUTHORED_VEGETATION_CELL_SIZE_M = 128` at `src/customs-authored-vegetation.js:27`, with a
comment calling it "the fixed compromise between frustum-culling granularity and prototype/primitive
batch count", and it is asserted twice in `scripts/customs-authored-vegetation.test.mjs:298-299`.
That is the entire dependency. `pack-index.json` never mentions cells. The placement source never
mentions cells. `customsVegetationProxyDimensions`, the scale recovery, the yaw convention and the
GLB pivot contract are all cell-independent. The offline pack does not know cells exist. **Nothing
breaks if it changes except two test assertions.**

What it *does* control, measured over the real placements:

| cell (m) | spatial cells | prototype-cells | draw calls @L1/L2 | draw calls @L0 | median inst/cell | max inst/cell | proto-cells with 1 instance |
|---|---|---|---|---|---|---|---|
| 64 | 229 | 1,602 | 3,033 | 4,596 | 21 | 267 | 473 |
| 96 | 108 | 987 | 1,873 | 2,831 | 53 | 369 | 202 |
| **128** | **64** | **703** | **1,333** | **2,016** | **106** | **534** | **136** |
| 160 | 52 | 587 | 1,116 | 1,688 | 90 | 683 | 120 |
| 192 | 30 | 427 | 807 | 1,220 | 242 | 950 | 55 |
| 256 | 24 | 321 | 607 | 917 | 205 | 1,376 | 45 |
| 384 | 9 | 181 | 340 | 513 | 794 | 1,991 | 5 |
| 512 | 8 | 151 | 282 | 425 | 1,507 | 2,724 | 6 |
| 1024 | 4 | 106 | 197 | 296 | 1,956 | 4,263 | 14 |

Culling cost of bigger cells, measured as cells surviving a frustum test at seven poses: at 128 m
the grid rejects 64→29 cells at a player-eye pose and 64→1 at a map corner; at 384 m only 9 cells
exist at all, so a single cell entering the frustum drags in up to 1,991 instances. And the LOD
granularity degrades with the same constant — one LOD per cell means at 384 m a whole quadrant of
the map flips LOD at once, which is both a visible pop and a 1,991-instance rebuild.

Note also the tail: at 128 m, **136 of 703 prototype-cells hold exactly one instance** and 260 hold
fewer than four. Those are 260 draw calls carrying 1–3 instances each. The cell grid is spending
most of its batches on nothing.

**Verdict: viable as a stopgap, rejected as the answer.** 256 m gets to 607–917, which is still
75–115× the baseline, and buys it by making both culling and LOD worse. Raising the constant is
trading one axis of the problem for another. The right move is to delete the axis (§4).

### (d) LOD-aware admission at realistic camera poses

Measured over seven poses spanning the real 1,397 × 698 m extent, using the pack's own LOD policy
(near ≤ 110 m, medium ≤ 280 m) applied **per instance**, with a per-instance frustum test
(canopy sphere r = 4 m × heightScale at +3 m):

| pose | instances in frustum | tris in frustum | current design, no cull | current, after cell cull |
|---|---|---|---|---|
| A orbit default (1.5 km) | 8,805 (100 %) | 514,074 | 1,333 | 1,333 |
| B orbit mid (600 m) | 7,866 (89 %) | 443,910 | 1,333 | 1,242 |
| C orbit close (250 m) | 4,857 (55 %) | 486,192 | 1,333 | 925 |
| D player eye, open field | 2,846 (32 %) | 638,706 | 1,503 | 662 |
| E player eye, dense woods | 5,291 (60 %) | 489,364 | 1,387 | 960 |
| F top-down whole map | 8,805 (100 %) | 514,074 | 1,333 | 1,333 |
| G map corner, outward | 0 (0 %) | 0 | 1,389 | 34 |

Two things this settles. **Distance culling buys almost nothing at the camera that matters**: the
default orbit framing and the top-down framing both hold the entire 1,397 m map inside the frustum,
so 100 % of instances are visible and the current design's cell culling removes zero. The poses
where culling helps (D, G) are exactly the poses where the current design is *already* under 700.
**LOD-aware admission cannot be the strategy** — it improves the cases that were never the problem
and leaves the default view at 1,333.

The triangle budget, by contrast, is a non-issue at every pose: 443 k–639 k triangles in frustum,
against 514 k for the whole map at the default LOD distribution. Vegetation is not triangle-bound
here. It is batch-bound.

**Verdict: keep per-instance LOD and per-instance culling as mechanisms** (they are free under §4
and they are what makes pose D cost 68 instead of 144). **Reject them as the strategy.**

### (e) The one that wins — collapse the materials, delete the cells

Neither (a) nor (b) nor (c) attacks the actual multiplier. The multiplier is
`draw calls = prototypeCells × materialsPerAsset`, and both terms are removable:

- **`materialsPerAsset` → 1.** All 199 materials have the *identical* texture-slot signature
  (`baseColor + metallicRoughness + normal + occlusion`), the *identical* double-sidedness, and no
  PBR factors at all. They differ only in which small image they sample, plus one `normalScale` per
  LOD. Put every layer into a `DataArrayTexture` and select the layer with a per-vertex attribute
  index; the 22 cards become `alphaTest = 0.5` (lossless, §1.4); bake `normalScale` into the normal
  layers at build time. **One material for the whole pack.** Array layers wrap independently, so
  the REPEAT UVs that killed the atlas need no edit at all.
- **`prototypeCells` → 31.** With one material, the only reason to hold a cell grid was per-cell
  LOD and per-cell culling. Move LOD to per-instance, and batch per **(family, LOD)** instead of
  per (cell, family, material). 31 families × 3 LOD tiers = **93 objects, ceiling**, and only the
  tiers that are actually populated exist.

Texture-array budget, measured (per-LOD arrays at native resolution, RGBA8, ×4/3 for mips, three
slots each):

| LOD | layers | res | bytes/slot (no mips) | all 3 slots, with mips |
|---|---|---|---|---|
| 0 | 85 | 128 | 5,570,560 | 22,282,240 |
| 1 | 57 | 64 | 933,888 | 3,735,552 |
| 2 | 57 | 32 | 233,472 | 933,888 |
| **total** | 199 | | | **26,951,680 (≈ 27 MB)** |

Against 201 MB for the atlas, and against the current runtime, which uploads 199 separate small
textures and 199 material objects.

---

## 4. Recommendation

**Ship "S2": one shared array-texture material, per-instance LOD, one `InstancedMesh` per
(family, LOD). Delete the 128 m cell grid.**

### Target

| | draw calls |
|---|---|
| procedural baseline today (6 proxy shapes, 8,805 instances) | 8 |
| current authored design, floor / worst realistic / ceiling | 1,333 / 1,503 / 2,016 |
| **S2 target — hard structural ceiling** | **93** |
| **S2 at the default orbit camera (measured)** | **31** |
| **S2 worst measured pose (player eye, open field)** | **82** |
| S2 in-frustum draws, per pose (A…G) | 31, 31, 54, 68, 52, 31, 0 |
| stage-4 `BatchedMesh` upgrade | 1 object, 0–8,805 encoder commands on WebGPU / 1 GL call on WebGL2 |

**The commitment: ≤ 93 at every camera, ≤ 82 across the sampled pose set, 31 at the default view.**
That is a 16–65× reduction against the current design and 3.9–10× the procedural baseline, while
rendering 31 authored families instead of 6 procedural proxy shapes at 8 calls.

Note the intermediate: **the material collapse alone, keeping the 128 m cells, already takes 1,333
→ 703.** If the cell deletion turns out to be contentious, the material work is still the larger
half of the win and is independent.

### Why this beats the alternatives

- **vs. BatchedMesh first (a):** S2's ceiling of 93 is structural — it is a count of objects in the
  scene graph and cannot be wrong. BatchedMesh's cost on this renderer is a count of encoder
  commands whose price is only knowable on a real GPU. Do the strategy whose number you can prove
  first, then take the upgrade with a measurement in hand.
- **vs. atlasing (b):** the array delivers the same "one material" outcome for 27 MB instead of
  201 MB, with **zero UV rewriting** and zero re-baking of 597 images, because 173/199 primitives
  tile their UVs and array layers wrap per-layer.
- **vs. bigger cells (c):** 256 m reaches 607–917 and degrades both culling and LOD granularity.
  S2 reaches 31–82 and *improves* both (per-instance beats per-cell on each).
- **vs. LOD-aware admission (d):** does not touch the default orbit pose, which is 100 % visible.

### Instance-buffer and churn cost of S2, measured

Sizing every (family, LOD) `InstancedMesh` to the family's full instance count and using
`mesh.count` as the live prefix:

| | value |
|---|---|
| instance-matrix bytes allocated, all 93 buckets | 1,690,560 B (1.7 MB) |
| live buckets, orbit default | **31** |
| live buckets, player eye open field | **82** |
| live buckets, player eye woods | **67** |
| full 8,805-instance LOD re-evaluation + repack | **1.10–1.29 ms** |
| instances changing LOD on a large camera move (A→D) | 3,755 |

Matrices are composed once at build and copied on a LOD change, never recomposed — that is what
keeps the repack near 1 ms. The repack is triggered by the existing hysteresis, not per frame, and
can be split across frames if it ever shows up in a profile. For comparison, the equivalent
`BatchedMesh` operation (`setGeometryIdAt` per changed instance) measured **0.86–0.92 ms** for the
same full sweep — the same order, which is precisely why BatchedMesh's LOD advantage is not on its
own a reason to take it first.

---

## 5. Implementation sequence

Each step is independently testable and independently revertable. Steps 0–2 are the win; 3–4 are
polish; 5 is the optional upgrade.

**Step 0 — fix the metric (blocking, ~10 lines).**
`src/map3d-three.js:2445`: read `renderer.info.render.drawCalls`, not `.calls`. Add
`renderCalls: renderer.info.render.calls` alongside if the cumulative counter is wanted. Add a
`vegetation: { objects, instances, buckets, lodBands }` block to `renderStats()`. Without this every
subsequent claim is unverifiable. New test: `scripts/three-renderer-test.mjs` asserts that a stubbed
`info` with `{calls: 7, drawCalls: 123}` reports 123.

**Step 1 — offline: build the texture arrays and the layer index (new script, no `src/` change).**
`scripts/build-customs-vegetation-atlas.mjs` (name it *arrays*, not atlas) reads the 93 GLBs from
`.local-candidates/vegetation-full/`, and emits, per LOD, three tightly-packed layer blobs plus one
JSON index:

- `veg-l{0,1,2}-basecolor.bin` — RGBA8, `layers × res × res × 4`, layer order deterministic and
  recorded.
- `veg-l{0,1,2}-orm.bin` — same, `R=occlusion, G=roughness, B=metallic` per the pack's own
  `extras.tz_orm_channels`.
- `veg-l{0,1,2}-normal.bin` — same, with `normalScale` (0.78 / 0.62 / 0.48) **pre-baked** as
  `xy' = (xy − 0.5) · s + 0.5`, so the runtime material needs no per-layer scalar. Exact, because
  three applies `normal.xy *= normalScale` linearly.
- `veg-layers.json` — `{ assetId, lod, materialIndex, primitiveIndex, layer, alphaCard, family }`
  per record, plus a `sha256` per blob, in the pack's existing receipt style.
- Mip chains generated offline and shipped alongside (`.mip1`, `.mip2`, …). This avoids depending on
  three generating mips for `DataArrayTexture` on both backends, which is the one uncertain piece of
  runtime plumbing here. If runtime generation proves reliable, drop the extra blobs.

Output goes to `.local-candidates/vegetation-full/runtime/`. **Not `public/`.**

**Step 2 — dev-only serving.**
Extend `scripts/lib/local-game-derived-dev.mjs`, or add a sibling plugin with the same shape
(`apply: 'serve'`, loopback-only client *and* host check, method allowlist, path-segment caps,
extension allowlist) on a new fixed prefix `/@local-vegetation/`. Add `.bin` to `CONTENT_TYPES`.
`scripts/verify-build-boundary.mjs` gets `.local-candidates` added to its forbidden-root list so a
`vite build` that ever references it fails loudly.

**Step 3 — runtime: one material, one bucket per (family, LOD).**
Rework `createCustomsAuthoredVegetationRuntime` in `src/customs-authored-vegetation.js`:

- `authoredPrimitives()` keeps its reflection/winding/pivot handling verbatim — none of that
  changes — but each primitive geometry gains a `vegLayer` `Float32BufferAttribute` (itemSize 1)
  filled with its layer index from `veg-layers.json`.
- `mergeAuthoredPrimitives()` merges with `useGroups = false`. One geometry, one material, per
  (family, LOD). All primitives already share `POSITION/NORMAL/TANGENT/TEXCOORD_0`, so the merge is
  legal today with no attribute work.
- One `NodeMaterial` (or `MeshStandardNodeMaterial`) per LOD tier, `side: DoubleSide`,
  `alphaTest: 0.5`, sampling `texture(arrayTex, uv()).depth(attribute('vegLayer','float').toInt())`.
  Three tiers because the arrays are per-LOD at native resolution; that is 3 materials total, not
  199. A per-instance `instanceColor` carries the existing tint unchanged.
- `partitionCustomsAuthoredVegetationCells` is replaced by
  `partitionCustomsAuthoredVegetationByLod(compiledPlan, { cameraWorldPosition, previousLods })` —
  same hysteresis policy, same `selectCustomsAuthoredVegetationLod`, applied per placement instead of
  per cell. `CUSTOMS_AUTHORED_VEGETATION_CELL_SIZE_M` and the cell partitioner are deleted, along
  with the two test assertions that pin 128.
- LOD change: rewrite the affected buckets' `instanceMatrix` prefix and set `mesh.count`. Matrices
  are cached, never recomposed. No GLB refetch — all 93 geometries are resident from the first
  build (9 MB), so `requiresReload()` and the whole reload path go away.
- `alphaPolicy` collapses to a contract assertion: every material is `MASK`; a BLEND material in a
  future pack is a hard failure, and the runtime reports `alphaModeCounts` in `status` as it does now.

**Step 4 — wire it into `map3d-three.js`.**
`src/customs-authored-vegetation-rollout.js` (260 lines, currently imported by nothing) becomes the
seam: route the plan into authored + procedural halves, mount the authored group, retire the
matching procedural `InstancedMesh`es. With all 31 admitted the procedural half is empty and all 8
proxy meshes retire — the net change in the scene is **8 objects out, ≤93 in**. Keep the
`?vegetation=procedural|authored` escape hatch for A/B.

**Step 5 (optional upgrade) — `BatchedMesh`.**
Only after step 0 gives a trustworthy `drawCalls` reading on the founder's real GPU. Swap the 93
`InstancedMesh`es for one `BatchedMesh` per LOD tier (three, one per array) with
`perObjectFrustumCulled = true`, `sortObjects = false`, all 8,805 instances resident in each tier and
`setVisibleAt` as the LOD selector. Everything needed is already true of the pack: uniform
attributes, ≤ 143 k vertices, positive-determinant instance matrices, per-instance colour.
**Falsifier, decided in advance:** if `render.drawCalls` × real-GPU frame time is not better than
S2's on the founder's machine, this step is abandoned and S2 stands. Do not ship it on the
theory that BatchedMesh "is" one draw call — on the WebGPU backend it is not (§3a).

---

## 6. What changes in the contract, and what does not

**Unchanged, deliberately:** the `[-x, -z, y]` point conversion; the baked X reflection and winding
flip; `Rz(-yaw)` (already fixed at `map3d-three.js:436` — untouched); base-centre pivots at y = 0;
the exact scale recovery; `collision: 'none'`; the "original authored approximation, not source
topology" honesty labels; the refusal to consume the pack's duplicate `placements` mirror; the
per-placement tint; the LOD distance policy and its hysteresis; the strict catalog validation and
its 31/58 coverage gate; every GLB byte and every receipt.

**Deleted:** `CUSTOMS_AUTHORED_VEGETATION_CELL_SIZE_M`, `partitionCustomsAuthoredVegetationCells`,
`spatialCells` / `prototypeCells` / `cellLods` in `status`, `requiresReload()`, and the
reload-on-LOD-change path.

**Added:** `vegLayer` per-vertex attribute; three array-texture materials; per-instance LOD state;
`status.buckets` / `status.lodBands` / `status.drawCalls` (now a count of live buckets, which is
exactly what the renderer will issue).

**Changed with evidence:** 22 materials go BLEND → `alphaTest 0.5`. This is lossless (§1.4) and is
recorded in `status.alphaContract` as `materialsRewritten: true` with the measured justification, so
the honesty label stays accurate.

---

## 7. Test and measurement harness — what proves this before any visual review

All of it runs headless, in `node --test`, with no GPU.

**7.1 `scripts/customs-vegetation-drawcalls.test.mjs` (new) — the budget gate.**
The load-bearing test. Loads the real placement plan and the real `pack-index.json`, runs the LOD
partitioner at seven fixed camera poses (the A–G table in §3d, frozen as data), and asserts:

- `buckets ≤ 93` at every pose — the structural ceiling;
- `buckets ≤ 82` across the pose set and `= 31` at pose A — the measured commitment, so a
  regression that quietly doubles the count fails the build;
- `Σ instances over buckets === 8805` at every pose — no placement duplicated or lost, the same
  invariant `partitionCustomsAuthoredVegetationCells` enforces today;
- every bucket's `(family, lod)` key is unique;
- triangles in frustum ≤ 700,000 at every pose (measured max 638,706, so this catches a LOD
  regression with ~10 % headroom).

**7.2 `scripts/customs-vegetation-materials.test.mjs` (new) — the pack census, as an assertion.**
Re-derives §2 from the 93 GLBs on every run and pins it: 199 primitives; 199 materials; slot combo
identical on all 199; attributes exactly `POSITION/NORMAL/TANGENT/TEXCOORD_0` on all 93; 22 cards,
177 opaque; **every opaque base-colour texel α = 255 and every card texture bimodal with no texel in
[32, 224)** — this is the assertion that keeps the `alphaTest` rewrite lossless if the pack is ever
regenerated. Skips cleanly (not fails) when `.local-candidates/` is absent, like the existing local
suites.

**7.3 `scripts/customs-vegetation-arrays.test.mjs` (new) — array-build determinism.**
Runs the step-1 builder into a temp dir twice and asserts byte-identical blobs and identical
`sha256`s; asserts every one of the 199 (asset, lod, primitive) records maps to exactly one layer and
no layer is orphaned; asserts each blob's length is exactly `layers × res × res × 4`; asserts the
baked `normalScale` round-trips to 0.78 / 0.62 / 0.48 within 1/255 by inverting the bake on a sample.

**7.4 Extend `scripts/customs-authored-vegetation.test.mjs`.**
Remove the two `128` assertions. Add: a placement whose LOD flips across the hysteresis band changes
bucket without changing its matrix (compare the composed `Matrix4` before and after, exactly);
`status.drawCalls === group.children.length` (the runtime's self-report cannot drift from the scene
graph); a BLEND material in a synthetic pack is a hard contract failure.

**7.5 Extend `scripts/three-renderer-test.mjs`.**
Assert `renderStats().drawCalls` reads `info.render.drawCalls` (step 0), and that
`renderStats().vegetation.objects` equals the authored group's child count.

**7.6 Benchmark, reported but never asserted: `scripts/bench-vegetation.mjs`.**
Prints the §4 churn table (full LOD sweep ms, live buckets per pose) and, if a `BatchedMesh` build is
present, its `onBeforeRender` ms per pose. **Never a pass/fail gate** — it is CPU-only JS timing on
whatever machine ran it, and its job is to catch an order-of-magnitude regression by eye, not to
certify performance.

**7.7 The visual gate, after all of the above.**
`npm run render-baseline` at the 9 fixed bookmarks under `?renderer=three`, procedural vs authored,
then the founder's real-GPU look. Per the project's own standard: no look ships that loses to what
is live.

---

## 8. What is genuinely unknowable without a real GPU

Stated plainly, because the project's own `CLAUDE.md` already records that `gpuFrameMs` is null under
SwiftShader and that headless timings are not a performance verdict.

1. **Whether 93 draw calls is fast.** Nothing here measures GPU time. 93 is a *count*, and the claim
   attached to it is only "93 ≪ 1,333", not "93 is fast enough". The 8-call procedural baseline
   renders acceptably today on the founder's machine; whether 93 objects with 8,805 instances and
   514 k triangles does too is a real-GPU question.
2. **The actual price of a WebGPU `drawIndexed` on one bound pipeline.** This is the whole basis of
   the stage-5 decision. 8,805 commands could be 0.5 ms or 5 ms depending on the browser's encoder,
   the driver and the device. Unmeasurable here; measurable in one afternoon on the real machine
   once step 0 makes `drawCalls` trustworthy.
3. **Whether `alphaTest` on 22 double-sided foliage-card materials costs fill rate.** Alpha-test
   defeats early-Z on some tilers and some desktop drivers. Structurally it is strictly better than
   BLEND (no sorting, no order dependence). Numerically, unknown.
4. **Texture-array upload and sampling cost**, and whether three generates `DataArrayTexture` mips
   correctly on both backends. Step 1 hedges this by shipping mips offline, but which path is
   actually taken is a runtime observation.
5. **Whether 27 MB of vegetation texture plus 9 MB of geometry fits the frame budget** alongside the
   terrain PBR runtime and the authored asset manifest already resident. Memory *totals* are
   measured; residency pressure on a real GPU is not.
6. **Whether the LOD1/LOD2 textures matter visually.** They differ from a box-downsample of LOD0 by
   a mean of 4.6/255. If they turn out to be visually redundant, the three per-LOD arrays collapse
   into one 85-layer 128² array (22 MB, and one material instead of three) — and then a single
   `BatchedMesh` can hold every geometry at every LOD. That is a real simplification waiting on one
   screenshot A/B, not on more analysis.

---

## 9. Open questions for the founder

1. **Is 93 objects acceptable, or is the bar "close to 8"?** If the bar is single digits, the answer
   is stage 5 (`BatchedMesh`) plus the §8.6 collapse, and the plan is one stage longer. If ≤93 is
   fine, S2 ships and BatchedMesh stays optional.
2. **May the 22 BLEND cards be rewritten to `alphaTest`?** The measurement says it is lossless
   (§1.4). It is still a change to authored material declarations, and this pack's whole value is
   that it is authored and receipted. Alternative: regenerate the 22 materials in the pack factory
   with `alphaMode: MASK, alphaCutoff: 0.5` so the GLBs themselves carry the truth and the runtime
   rewrites nothing. That costs a pack regeneration and 22 new receipts; it is the cleaner answer if
   the pack is still cheap to rebuild.
3. **Deleting the 128 m cell constant** removes a documented design decision. It has no offline
   dependency (§3c) — confirming that no one is holding it for a future streaming design.
