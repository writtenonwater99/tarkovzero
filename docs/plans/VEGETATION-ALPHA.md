# VEGETATION-ALPHA — alpha strategy for the 31-family Customs vegetation pack

Design pass, 2026-09-01. Branch `work/customs-industrial-truth-2026-09-01`.
Scope: localhost-only dev renderer (`?renderer=three`, dev + loopback + Customs). Nothing here assumes a
production path and nothing here is promoted into `public/`.

**This pass changed no code.** All measurements below were produced by read-only inspection plus one
Blender rebuild into scratch.

---

## 0. Three premise corrections before anything else

The brief carried three premises that the evidence does not support. Two of them change the answer.

### 0.1 The adapter does NOT reject BLEND today. Nothing is being rejected.

`src/customs-authored-vegetation.js:40-42`:

```js
export const CUSTOMS_AUTHORED_VEGETATION_ALPHA_POLICY = Object.freeze({
  blend: 'report',
});
```

`'reject'` is a *legal* value of the policy (validated at `:883`, enforced at `:924`) but the only two call
sites that pass it are in `scripts/customs-authored-vegetation.test.mjs:494,508`. No production code path
sets it. The default export is `'report'`, and `prepareCustomsAuthoredVegetation` defaults to that constant
at `:1112`.

So "the adapter's strict `blend:'reject'` policy rejects 71.7% of placements at LOD0" describes a
*hypothetical* configuration, not live behaviour. The pack already passes admission — which matches the
established fact that coverage reports `complete: true` and 8805/8805 placements bind.

**What this means:** option (b) is not a change. It is the status quo. The question is not "how do we stop
rejecting 71.7%" but "is the status quo good enough, and if not, what is actually wrong?"

The 71.7% figure is real, though, and I reproduced it exactly — see §1.2.

### 0.2 The factory already has a working MASK/alphaCutoff path, and two finished proof packs exist.

`scripts/vegetation-asset-factory/vegetation_factory.py` carries a complete alpha-cutout implementation
behind two flags:

- `--pine-alpha-proof` (restricted to `pine01`, `:209`)
- `--deciduous-alpha-proof` (restricted to `tree02`, `:210-213`)

Both build real photographic foliage atlases from committed source PNGs, emit `alphaMode: "MASK"` with
`alphaCutoff` 0.376, and are already validated. The finished outputs are sitting on disk:

- `/mnt/c/Users/zeque/tarkovzero/.local-candidates/pine-alpha-proof-final/` (pine01 LOD0-2, 6 QA renders, 6 validation reports)
- `/mnt/c/Users/zeque/tarkovzero/.local-candidates/tree02-alpha-proof/` (tree02 LOD0-2, 13 QA renders, 7 validation reports)

`scripts/vegetation-asset-factory/build_full_pack.py:102-114` builds the 93-GLB pack **without** either
flag. That is the entire reason the pack has 22 BLEND materials and zero MASK materials.

**What this means:** option (a) is not speculative work. It is turning on a path that already exists,
already has validators (`validate_source_atlas.py`, `validate_embedded_alpha_atlas.py`,
`validate_fixed_camera_continuity.py`), and has already been visually reviewed once.

### 0.3 The pack is NOT byte-reproducible from committed code. I proved it.

The manifest records the factory that built it:

```
generation-manifest.json → generator.factorySha256 = sha256:03337cdb…c16f384
```

The committed and working-tree factory is a different file:

```
sha256sum scripts/vegetation-asset-factory/vegetation_factory.py
→ ef3b4b8aaba437cba520d61c0f263bd42c250bb9570743f592d57f69dd3da38c
```

`git log` shows exactly one commit ever touched that file (`47d81b5`), and that commit's blob also hashes to
`ef3b4b8a`. The factory that built the pack **exists nowhere in the repository or its history**. Line-ending
normalisation is not the explanation (the file is pure LF, 0 CR bytes).

I rebuilt `birch01-lod0` with the committed factory at the manifest's recorded seed and diffed it against
the packed GLB:

| | packed | rebuilt |
|---|---|---|
| sha256 | `d583759d…` | `308577c2…` |
| bytes | 463,524 | 463,660 |
| BIN chunk | **byte-identical** (456,784 B, same sha256) | |
| `materials`, `meshes`, `accessors`, `images`, `textures` | **identical** | |
| `nodes` | differs at node 3 only | |

The entire difference is four keys added to the root node's `extras`:

```
tz_pine_alpha_proof: false
tz_deciduous_alpha_proof: false
tz_fit_xy_scale: 0.6434632851579355
tz_fit_z_scale: 1.0997556389713146
```

So: **the pack is semantically reproducible and byte-unreproducible.** The drift is pure provenance
metadata added when the deciduous proof path landed after the pack was built. Geometry, textures, materials,
and the envelope fit are unchanged — which is also why `validation/reproducibility-report.json` still says
`byteIdentical: true`: that report is stale, generated before the factory edit.

Two consequences:

1. Every one of the 93 GLBs will fail a byte-reproducibility check against the current factory. All 93,
   not some. This is not a reason to panic — it is a reason to **rebuild the pack rather than patch it**,
   which we want to do anyway.
2. `verify_pack_reproducibility.py:45` hard-caps at 8 samples
   (`require(1 <= len(args.sample) <= 8, "use 1..8 reproducibility samples")`). "3 of 93 verified" was not a
   judgement call; the tool cannot express more than 8. That cap has to go.

---

## 1. What the pack actually contains

### 1.1 The 22 BLEND materials are five archetypes, and they are a minority of the geometry

All 22 BLEND materials are LOD0 leaf/needle cards. There are only **five distinct material archetypes**
among them, shared across families:

| archetype | prototypes | tris/instance |
|---|---|---|
| `TZ_VEG_needle_pine_card_PBR_L0` | pine01-05 | 960 |
| `TZ_VEG_leaf_shrub_card_PBR_L0` | filbert_01, filbert_big01-03, filbert_small01-03 | 320 |
| `TZ_VEG_leaf_broadleaf_card_PBR_L0` | tree01-03 | 672 |
| `TZ_VEG_leaf_birch_card_PBR_L0` | birch01-03 | 480 |
| `TZ_VEG_leaf_dry_card_PBR_L0` | brush_dry01-02, filbert_dry01, filbert_dry03 | 64 / 96 |

Crucially, the card is **not** the foliage. It sits on top of opaque modelled foliage blobs:

```
pine01  LOD0 = 8748 tris:  bark_pine 2028 OPAQUE | needle_pine 5760 OPAQUE | needle_pine_card 960 BLEND
birch01 LOD0 = 4140 tris:  bark_birch 588 OPAQUE | leaf_birch 3072 OPAQUE  | leaf_birch_card  480 BLEND
tree02  LOD0 = 4764 tris:  bark_broadleaf 508    | leaf_broadleaf 3584     | leaf_broadleaf_card 672 BLEND
```

The BLEND card is 11% of pine01's LOD0 triangles and 12% of birch01's. Look at
`.local-candidates/vegetation-full/qa/contact-sheets/woody-families-lods-v2.png` and the cards are barely
visible — the silhouette is entirely carried by the opaque blobs.

**The 22 BLEND materials contribute almost nothing to the current look.** They are a symptom of an
unfinished foliage treatment, not the cause of the visual problem.

### 1.2 71.7% confirmed exactly

Counted from `.local-game-derived/customs/terrain-{000,001}-vegetation.json` by resolving `prototypeId` →
`prototypes[].name`:

```
total                    8805
on a BLEND-card family   6312  = 71.7%
opaque-only families     2493  = 28.3%
```

Top rows: `pine01` 1830 (20.8% of the whole map), `grass_dry3` 1166 (opaque), `plant_wolf02` 635 (opaque),
`filbert_big01` 578, `pine05` 504. All five pines together = 3051 = 34.6%.

Tail rows that matter for prioritisation: `birch01` = **4 placements**, `fern02` = **1**,
`Stump04_update` = **24** (0.27%).

### 1.3 The procedural card alpha is already strictly binary

I extracted the embedded LOD0 base-colour PNG from `birch01-lod0.glb` and histogrammed its alpha channel:

```
alpha histogram: {0: 6037, 255: 10347}      ← two values, nothing between
128 × 128, 8-bit, colortype 6 (RGBA)
opaque texels 10347, edge texels 395 (3.8% perimeter)
near-black RGB among alpha≥96 texels: 0
```

This is exactly what the generator does (`vegetation_factory.py:318-328`):

```py
alpha = 1.0 if ny <= 0.985 and nx <= half_width else 0.0
if alpha == 0.0:
    color = (0.0, 0.0, 0.0)
```

**Converting these 22 materials from BLEND to MASK is texel-exact lossless.** There is no soft edge to
preserve; there never was one. Any `alphaCutoff` in `(0, 1)` reproduces the same texels; `0.5` is the
correct choice because it puts the cut on the 50% isoline of the bilinear/mip-filtered alpha, which is the
silhouette-preserving cut for a binary source.

Two caveats, both real:

- `color = (0,0,0)` in the transparent region means bilinear filtering pulls edge texels toward black. Under
  BLEND the low alpha hides it; under MASK the surviving edge texels keep full-strength black RGB → a dark
  fringe. **RGB dilation is required, not optional.** The factory already implements it for the atlas paths
  (`rgbDilationPixels: 8` pine, `4` deciduous).
- At 3.8% perimeter and 63% coverage, this "leaf card" is a fat rounded blob, not a leaf spray. Flipping
  its alpha mode does not make it look like foliage.

### 1.4 Blender 4.5 decides alphaMode from the node tree, and the factory's cutout settings are dead

Verified against the shipped exporter at
`~/.local/share/tarkovzero-tools/blender-4.5.13/4.5/scripts/addons_core/io_scene_gltf2/blender/exp/material/search_node_tree.py:487-556`:

```
# Alpha mode is determined by the nodes too (previously it used the Eevee blend_method).
```

- constant alpha 1 → `OPAQUE`
- a `ShaderNodeMath` with `GREATER_THAN` / `LESS_THAN` / `ROUND` between the image alpha and the BSDF's
  Alpha input → `MASK`, `alphaCutoff` = the constant operand (`detect_alpha_clip`, `:598-611`)
- anything else → `BLEND` (`:553`)

The procedural card path wires alpha straight through (`vegetation_factory.py:415-416`):

```py
if alpha_card:
    links.new(base_node.outputs["Alpha"], bsdf.inputs["Alpha"])
```

→ `BLEND`, every time.

Meanwhile `:392-393` sets:

```py
material.surface_render_method = "DITHERED"
material.alpha_threshold = 0.45
```

**Both are inert for glTF export.** They affect the Blender viewport only; the 4.2+ exporter never reads
them. The factory author authored a cutout, and the exporter silently gave them a blend. That is the bug,
and it is one line wide.

The proof path does it correctly (`:580-587`):

```py
clip = nodes.new("ShaderNodeMath")
clip.operation = "GREATER_THAN"
clip.inputs[1].default_value = PINE_ALPHA_CUTOFF
links.new(base_node.outputs["Alpha"], clip.inputs[0])
links.new(clip.outputs[0], bsdf.inputs["Alpha"])
```

### 1.5 Where 0.376 comes from — it is derived, not guessed

`0.376 ≈ 96/255`. `validate_source_atlas.py` pins it with two requirements against the actual atlas pixels:

- `:106` — at least 20% of the atlas must survive above alpha 96, so the cutoff cannot starve the foliage.
- `:141-153` — every saturated chroma-fringe pixel (neon green / hot red / hot blue, the generation
  artefacts around the sprays) must fall **below** the cutoff:
  `require(chroma_fringe_at_cutoff == 0, "saturated fringe pixels survive the proof alpha cutoff")`.

Measured on the committed source atlases (1254×1254 RGBA):

| | pine-scots | deciduous-broadleaf |
|---|---|---|
| alpha == 0 | 49.8% | 50.9% |
| alpha == 255 | 0.0% | 0.1% |
| intermediate | **50.2%** | **49.1%** |
| survives ≥96 (0.376) | 27.7% | 29.7% |
| survives ≥128 (0.5) | 25.7% | 28.9% |

These are genuinely soft ramps — the opposite of the procedural cards. 0.376 vs 0.5 costs only 2.0 / 0.8
points of coverage, so the value is not sensitive; the *binding* constraint is the chroma-fringe test, and
that is the right way to choose it. **Keep 0.376 for atlas materials. Do not unify it with the procedural
cards' 0.5** — they are different textures with different alpha distributions, and the receipts already
carry a per-material cutoff.

---

## 2. Options

### (a) Author MASK/alphaTest cutout materials in the factory and regenerate — RECOMMENDED, in two stages

**Real cost, established rather than assumed:**

- Factory committed and runnable: **yes.** Blender 4.5.13 verified at
  `~/.local/share/tarkovzero-tools/blender-4.5.13/blender` (163 MB, `Blender 4.5.13 LTS (hash daeeeca98fb0,
  built 2026-08-25)`), and I ran a full prototype build through it in ~1 min wall.
- Pack byte-reproducible: **no** (§0.3), but semantically reproducible with a BIN-chunk match. The fix is a
  full rebuild, which this plan needs anyway.
- Cutoff chosen from the textures: **yes**, by two different derivations for two different texture classes
  (§1.3, §1.5).
- Validators already exist: `validate_source_atlas.py`, `validate_embedded_alpha_atlas.py`,
  `validate_fixed_camera_continuity.py`, `validate_vegetation_outputs.py:208-222,428-458` already assert
  `alphaMode == "MASK"` and cutoff equality for the proof paths.

The catch, and it is the interesting one: **the proof path is not a material change, it is an architecture
change.**

```
pine01 procedural   L0 8748 tris / 3 materials   L1  552   L2  46      885 KB total
pine01 proof        L0 5964 tris / 2 materials   L1 2712   L2 128    4,536 KB total   (5.1×)

tree02 procedural   L0 4764 tris / 3 materials   L1  624   L2 136      614 KB total
tree02 proof        L0 2976 tris / 2 materials   L1 1068   L2 472      795 KB total   (1.3×)
```

The proof deletes the fake opaque foliage blobs entirely and replaces them with alpha-cut branch sprays.
The material count per prototype drops 3 → 2. Triangle counts *rise* at LOD1/LOD2, because the far LODs
finally carry a real silhouette.

The 5.1× vs 1.3× size gap is entirely texture resolution: pine uses 1024/512/256, deciduous uses 256/128/64.
It is a choice, not a property of the approach.

Two further size traps, both worth naming now:

- Each GLB embeds its own copy of the atlas. Five pines × six 1024² images each = five duplicate 1024
  atlases in VRAM for one archetype. **Atlases must be shared per archetype, not embedded per prototype**
  (or KTX2-compressed; `~/.local/share/tarkovzero-tools/ktx-4.4.2` is on disk).
- The pine proof's own review already flags this: *"The proof exceeds every existing full-pack byte and
  texture-resolution budget, and LOD1 also exceeds its triangle budget."*
  (`pine-alpha-proof-final/validation/visual-review.json`)

**Draw-call side effect, measured.** Counting distinct (prototype, material) pairs in the pack:
LOD0 = 85, LOD1 = 57, LOD2 = 57. Folding the opaque leaf blob into the atlas card removes one pair from
each of the 22 card families → **LOD0 goes 85 → 63, a 25.9% reduction**. Since the founder's draw-call count
is `cells × prototype × material`, that is a proportional cut on the 1,333–1,467 figure at LOD0. It does not
solve the draw-call problem, but it moves in the right direction instead of the wrong one — which is more
than option (b) or (c) can say.

**Verdict: recommended.** But not as a single 22-family leap — see §3.

### (b) Keep BLEND, relax to 'report', accept unsorted transparency — REJECTED (and already the status quo)

This is what ships today (§0.1), so "what does that actually look like" has a concrete answer.

Three.js `GLTFLoader` maps `alphaMode: "BLEND"` to `transparent = true, depthWrite = false`. Consequences at
8805 instances:

1. **Transparent-pass sorting is per-object, not per-instance.** Each cell × prototype card is one
   `InstancedMesh` with a single sort key (its bounding-sphere centre). Every instance inside it renders in
   fixed buffer order regardless of camera. With `prototypeCells = 703`, a cell is 128 m of Customs — dozens
   of pines deep. Their cards render back-to-front by nothing at all.
2. **Because the alpha is binary (§1.3), blending degenerates to overwrite.** `src·1 + dst·0` in the leaf
   interior means *the last card drawn wins*. So a leaf card 60 m behind you paints over one 5 m in front of
   you, whenever instance order says so. That is not a soft artefact; it is a hard wrong-depth pop.
3. **The pop is camera-dependent and instance-order-static**, so it flickers on orbit: as the cell sort
   order flips between two cells, whole clusters of leaves swap which one is "in front".
4. `depthWrite = false` means the cards never occlude anything, including each other. Overlapping cards
   inside one crown read as a flat colour patch rather than layered foliage.

What *saves* it today, and this is the honest part: the cards are 11% of the geometry and sit on top of
opaque blobs that do write depth (§1.1). The silhouette and the depth read come from the opaque geometry.
The artefact is confined to card-over-card, and the cards are barely visible. Shadows would normally make
this much worse, but `CUSTOMS_AUTHORED_VEGETATION_SHADOW_POLICY` is `mode: 'disabled'`
(`customs-authored-vegetation.js:35-38`), so there is no alpha-shadow pass to get wrong.

So (b) is survivable *precisely because the cards are nearly useless*. The moment the cards carry real
foliage — which is the whole point of fixing this — (b) becomes unacceptable. Rejected as a destination;
it is fine as the state we are leaving.

### (c) Hybrid — MASK for dense foliage, BLEND where soft edges matter — REJECTED

There is nowhere in this pack where a soft edge genuinely matters. Measured:

- The 22 procedural cards have strictly binary alpha (§1.3). A soft edge does not exist to preserve.
- The two real atlases have soft ramps, but their softness is *generation fringe* the validator explicitly
  requires to be cut away (`chroma_fringe_at_cutoff == 0`, §1.5), not authored translucency.
- There is no glass, no water plant, no smoke, no genuinely translucent species in the 31.

A hybrid buys nothing and costs a permanent two-mode contract in the adapter, the validators, and the
renderer's pass assignment. Reject.

### (d) Better — the one worth adding: LOD-aware alpha coverage

Alpha-tested foliage has a well-known failure that MASK alone does not fix: as mipmaps shrink, the mean
alpha of a sparse foliage texture falls below the cutoff and the foliage **dissolves at distance**. Our
LOD ladder walks 1024 → 512 → 256 (pine) or 128 → 64 → 32 (procedural), so we walk straight into it.

This is not theoretical here. The pine proof's own review already recorded the symptom:

> "LOD2 loses too much crown density relative to LOD1; screen-space thresholds and dithered transition are
> untested."
> "internal-cell gutter and mip-bleed behavior is not runtime-tested."

Three ways out, cheapest first:

1. **Per-LOD cutoff, authored in the factory.** The receipts already carry a per-material cutoff, and the
   validators already compare against a named constant. Choose LOD1/LOD2 cutoffs so the *accepted-alpha
   fraction* matches LOD0's, using the metric the repo already computes (§4.3). Zero runtime change.
2. **Coverage-preserving mip alpha** (rescale each mip level's alpha so its coverage at the cutoff matches
   mip 0). Requires the factory to bake mips and ship KTX2 rather than PNG. `ktx-4.4.2` is available.
3. **`alphaToCoverage`** in the renderer. Needs MSAA, is a runtime-side change, and is out of scope for a
   factory pass.

Take (1) now, hold (2) for the KTX2 pass, ignore (3).

---

## 3. Recommendation

**Adopt (a), staged, with (d.1) folded in. Two stages, gated.**

### Stage A — correct the alphaMode bug, rebuild the pack, re-baseline provenance

Flip the 22 procedural cards from BLEND to MASK. This is texel-exact lossless (§1.3), removes the sorting
artefact class described in (b), and is roughly six lines of factory change. It does **not** make the
vegetation look better — the cards are still fat blobs — but it:

- makes the pack correct by construction, so `blend: 'reject'` becomes a policy we *could* enforce
- moves 22 materials out of the transparent pass and into the opaque pass, where a depth prepass and
  occlusion culling can eventually reach them
- forces the pack rebuild that §0.3 makes necessary anyway, re-baselining the manifest against a factory
  that actually exists in git

Stage A is cheap, low-risk, and independently valuable. Do it first and do not wait on Stage B.

### Stage B — promote the atlas architecture across the five archetypes, at a capped texture budget

Generalise `--pine-alpha-proof` / `--deciduous-alpha-proof` from two hard-coded prototypes into a per-family
atlas treatment covering the five archetypes of §1.1. This is where the visual win lives, and it is also
what fixes the pine LOD1 discontinuity (§5).

**Cap the atlas at 256/128/64 for every archetype, including pine.** Evidence: the deciduous treatment at
256/128/64 costs 1.3× bytes and produced a `fixed-camera-continuity: pass`; the pine treatment at
1024/512/256 costs 5.1× and its own review calls the budget overrun a promotion blocker. Two archetypes need
new source atlases (`leaf_shrub`, `leaf_dry`); birch can provisionally borrow the deciduous atlas with a
tinted variant, which is a founder call (§7).

Stage B is a bigger build. Gate it behind Stage A shipping green and behind a founder look at the Stage A
contact sheets.

**Why this beats the alternatives:** (b) is only survivable while the cards are worthless, and stops being
survivable the moment they are not. (c) buys a permanent dual contract for a soft edge that does not exist
in any of the 199 materials measured. Doing nothing leaves a pack whose provenance record points at a
factory that exists nowhere, which will silently break the first real reproducibility gate anyone runs.

---

## 4. Exact factory changes

Not applied in this pass. All paths relative to `scripts/vegetation-asset-factory/`.

### 4.1 `vegetation_factory.py` — Stage A (the alphaMode fix)

**A1. Add a procedural-card cutoff constant** near `PINE_ALPHA_CUTOFF` (`:43`):

```py
PROCEDURAL_CARD_ALPHA_CUTOFF = 0.5   # binary source alpha; 0.5 is the filtered-silhouette isoline
```

**A2. In `create_material()`, replace the direct alpha link** (`:415-416`) with a `GREATER_THAN` clip, the
same shape the proof path uses at `:580-587`:

```py
if alpha_card:
    clip = nodes.new("ShaderNodeMath")
    clip.operation = "GREATER_THAN"
    clip.inputs[1].default_value = PROCEDURAL_CARD_ALPHA_CUTOFF
    links.new(base_node.outputs["Alpha"], clip.inputs[0])
    links.new(clip.outputs[0], bsdf.inputs["Alpha"])
    material["tz_alpha_cutoff"] = PROCEDURAL_CARD_ALPHA_CUTOFF
```

**A3. Delete the two inert lines** at `:392-393` (`surface_render_method`, `alpha_threshold`) or leave them
with a comment saying they are viewport-only. Deleting is better — they are the trap that caused this.

**A4. Dilate the card RGB.** In `material_sample()` (`:326-328`) the transparent region is written black.
Replace the `color = (0,0,0)` discard with a post-pass over `base_pixels` in `create_material()` that pushes
the nearest opaque texel's RGB outward by ≥2 texels into the alpha-0 region, keeping alpha at 0. At 128 px
with a 3.8% perimeter this touches ~800 texels per card and is not a measurable build cost. Without it,
MASK will introduce a dark fringe that BLEND was hiding.

**A5. Record the cutoff in the receipt** so `validate_vegetation_outputs.py` can assert it for the
procedural families the same way it already does for the atlas families.

### 4.2 `vegetation_factory.py` — Stage B (atlas generalisation)

**B1. Replace the two boolean flags with a treatment table.** `parse_args` (`:203-216`) currently restricts
`--pine-alpha-proof` to `pine01` and `--deciduous-alpha-proof` to `tree02`. Replace both with
`--foliage-treatment {procedural,atlas}` (default `atlas` once Stage B lands) and drive the archetype
selection off the prototype's `form` in `prototype_catalog.json`, which already partitions correctly:
`conical` → pine atlas, `round-crown` / `airy-oval` → deciduous atlas, `big`/`medium`/`small` → shrub atlas,
`dry-brush`/`dry-filbert` → dry atlas.

**B2. Add `ATLAS_TEXTURE_BY_LOD = {0: 256, 1: 128, 2: 64}` as the single cap for every archetype**, and
delete `PINE_ATLAS_TEXTURE_BY_LOD`'s 1024/512/256 (§3 Stage B rationale). If pine visibly needs more, raise
it *with a measurement*, not by default.

**B3. Per-LOD cutoffs** (option d.1). Turn `PINE_ALPHA_CUTOFF` / `DECIDUOUS_ALPHA_CUTOFF` into
`{lod: cutoff}` maps. Seed LOD0 at 0.376 from the existing derivation; choose LOD1/LOD2 by the procedure in
§4.3 so accepted-alpha fraction stays within ±5% of LOD0.

**B4. Share atlases across prototypes of an archetype** rather than embedding a copy per GLB, or defer to a
KTX2 pass. Five duplicate pine atlases is a VRAM bug waiting to be measured.

**B5. Delete the procedural blob geometry for atlas-treated families.** This is what takes the material
count 3 → 2 and buys the 25.9% LOD0 draw-call reduction. It is also the change that makes the atlas visible
instead of hidden behind opaque blobs.

### 4.3 Tooling changes (required for the validation plan to be runnable)

| file | change | why |
|---|---|---|
| `verify_pack_reproducibility.py:45` | raise the 8-sample cap; add `--all` | 93/93 is impossible today; the "3 of 93" gap is a tool limit, not a decision |
| `validate_fixed_camera_continuity.py:59` | `choices=("tree02",)` → any catalog prototype | the only LOD-continuity metric we have is locked to one prototype |
| `validate_vegetation_outputs.py` | assert `alphaMode == "MASK"` + cutoff for **all** card materials, not only the two proof paths | today MASK is asserted at `:208-222` only under the proof flags |
| `validate_full_pack.py` / `validate_full_pack.mjs` | add a pack-wide invariant: zero `BLEND` materials | makes the Stage A outcome a gate, not a hope |
| `build_full_pack.py:182` | after rebuild, the manifest re-hashes the factory automatically — verify the new `factorySha256` matches `git ls-files`'s blob | closes §0.3 permanently |

**How to choose the LOD1/LOD2 cutoffs (B3), concretely.** Render each LOD through `render_preview.py
--view standard` at a fixed camera, run `validate_fixed_camera_continuity.py`, read `acceptedAlphaFraction`,
and bisect the LOD1/LOD2 cutoff until each is within ±5% of LOD0's. The tree02 proof already demonstrates
the target: 0.1431 / 0.1359 / 0.1327 — a 7.2% spread across all three LODs. That is the number to beat, and
the tooling to measure it is already written.

---

## 5. The four flagged LOD concerns — which are alpha, which are geometry

Answer up front: **none of the four is caused by alpha mode. All four are geometry.** Two of them are
*fixed* by the Stage B atlas architecture, which is a geometry change that happens to also change alpha.

Evidence is `.local-candidates/vegetation-full/qa/contact-sheets/woody-families-lods-v2.png` plus the
per-material triangle counts.

### 5.1 Pine LOD1 silhouette discontinuity — GEOMETRY, fixed by Stage B

The needle-to-bark triangle ratio is non-monotonic across the ladder:

| | tris | needle | bark | needle:bark |
|---|---|---|---|---|
| pine01 LOD0 | 8748 | 6720 (incl. card) | 2028 | 3.3 : 1 |
| pine01 LOD1 | 552 | 160 | 392 | **0.41 : 1** |
| pine01 LOD2 | 46 | 30 | 16 | 1.9 : 1 |

LOD1 spends 71% of its budget on the trunk. The contact sheet shows exactly this: LOD0 is a dense column of
blobs, LOD1 is five thin flat stars on a bare pole you can see straight through, LOD2 is a solid green cone
— three different modelling paradigms in one ladder. It is not a discontinuity, it is two of them.

This is a canopy budget allocation bug in the LOD1 generator, and it affects 3051 placements (34.6% of the
map). Stage B fixes it structurally: the pine proof's LOD1 is 2712 tris with 528 of alpha-cut spray, and its
continuity sheet reads as one tree at three densities. Not alpha-mode related; alpha-*architecture* related.

### 5.2 Dry-shrub LOD2 nearly vanishes — GEOMETRY

`filbert_dry01`: leaf triangles go 1024 (L0) → 126 (L1) → **24** (L2). The contact sheet's LOD2 is one small
tan blob on two bare stems. 24 triangles cannot carry a shrub. Fix is the LOD2 leaf budget, or an atlas card
at LOD2 (Stage B). Affects 174 placements (`filbert_dry01` 99 + `filbert_dry03` 75) plus 508 for the
`brush_dry` pair — low priority relative to pine.

### 5.3 Ground-plant LOD2 at 12-16 triangles — GEOMETRY, and possibly correct

Confirmed: `fern01` L2 = 12 tris, `grass_dry3` L2 = 16, `plant_wolf01` L2 = 16. These families carry **no
alpha card at all** — they are 100% OPAQUE at every LOD, which is why they were in the 9-family
"safe subset". So this cannot be an alpha problem by construction.

Whether it is a *problem* depends on the LOD distance policy:
`CUSTOMS_AUTHORED_VEGETATION_LOD_POLICY` = `nearMaxM 110 / mediumMaxM 280 / hysteresisM 20`. A 0.4 m ground
plant at >280 m is a few pixels; 12 triangles may be exactly right. **This one needs a look at the real
renderer before spending anything on it** — it covers 2391 placements (27%) so a wrong call is expensive
either way. Measure before fixing.

### 5.4 Stump04 reads as a featureless pale box — GEOMETRY + PALETTE, not alpha

`Stump04_update` L0 = 170 tris: 120 `bark_broadleaf` + 14 `cut_wood` + 36 `moss`. L1 = 64 tris (moss gone).
L2 = 22 tris. The contact sheet confirms it: a pale beige tapered box at all three LODs, with a small broken
spur at LOD0 that disappears by LOD1.

Two independent defects:
- **Geometry**: 120 triangles of "broken stump" is a tapered box. A broken stump needs a splintered crown;
  the `broken-stump` form is not distinguished from `cut-stump` in the output.
- **Palette**: it is pink-beige. It shares `bark_broadleaf` with `tree02`, whose trunk reads correctly dark
  brown in the same sheet — so the stump is being lit differently or the moss/cut-wood tint is washing it.
  Worth one debug render before assuming geometry.

Priority: **lowest of the four.** 24 placements, 0.27% of the map. It is the most visually offensive and the
least consequential; do not let it jump the queue ahead of pine's 3051.

---

## 6. Validation

Nothing here is new tooling except where §4.3 says so.

### 6.1 Per-asset, automated (every rebuild)

1. **Khronos** — `validate_khronos_outputs.mjs` across all 93 GLBs. Bar: 0 errors, 0 warnings, unchanged
   from today's baseline.
2. **Alpha contract** — `validate_vegetation_outputs.py` extended per §4.3: every card material is
   `alphaMode: "MASK"`, `doubleSided: true`, cutoff equals the receipt's recorded value.
3. **Pack invariant** — `validate_full_pack.py`: **zero BLEND materials in the pack.** Today's count is 22;
   after Stage A it must be 0. This is the single assertion that makes the fix permanent.
4. **Embedded atlas** — `validate_embedded_alpha_atlas.py` (Stage B only): no saturated chroma survives the
   cutoff, cutoff unchanged per LOD, dilation present.
5. **RGB dilation** (new check, Stage A): no alpha-0 texel within 2 texels of an alpha-255 texel may be
   pure black. This is the guard against the §4.1-A4 dark fringe, and it is a ten-line addition to
   `validate_vegetation_outputs.py`.

### 6.2 Byte-reproducibility — the part that has to change

Current state: 3 of 93 verified, and the report is stale (§0.3). After the §4.3 cap removal, the gate is:

```
python3 verify_pack_reproducibility.py --all \
  --pack-root <new pack> \
  --blender ~/.local/share/tarkovzero-tools/blender-4.5.13/blender \
  --output <pack>/validation/reproducibility-report.json
```

**Bar: 93/93 byteIdentical.** Plus a new assertion that
`generation-manifest.json → generator.factorySha256` equals `sha256sum` of the committed
`vegetation_factory.py` — the check whose absence let §0.3 happen silently. If those two disagree again, the
pack is not reproducible and the report must not say `pass`.

### 6.3 Receipts

Every LOD receipt must record, per card material: `alphaMode`, `alphaCutoff`, `doubleSided`,
`rgbDilationPixels`, and for Stage B the source atlas id + sha256 + `derivedEmbeddedResolution`. The
`derivedTreatment` block at `:2493-2530` is already the right shape — extend it to the procedural families
instead of returning `[]` for them (`source_texture_records` `:2531`).

### 6.4 What a human must actually look at

Automation cannot answer any of these. Six frames, in this order:

1. **Contact sheet, before vs after Stage A** — `build_contact_sheet.py` over the same six woody rows as
   `woody-families-lods-v2.png`. *Question: did the dark fringe appear?* If §4.1-A4's dilation is wrong, it
   shows here as a black outline on every leaf blob. This is the one Stage A regression that automation will
   not catch.
2. **Pine LOD continuity, Stage B** — the three-panel sheet against
   `pine-alpha-proof-final/qa/pine01-lod-continuity.png`. *Question: does LOD1 still read as a bare pole?*
   Numeric backstop: `acceptedAlphaFraction` spread ≤ 7.2% across LODs, the number tree02 already achieves.
3. **In-renderer, 8805 instances, Customs, `?renderer=three`** — orbit through a dense pine stand.
   *Question: do leaf cards still pop over each other?* Under MASK they must not. This is the direct test
   that (b)'s failure mode is gone, and it cannot be done offline.
4. **In-renderer at the LOD boundaries** — sit the camera at 110 m and 280 m and cross them slowly.
   *Question: does foliage dissolve or pop as LOD swaps?* This is the (d) mip-coverage check; the offline
   fixed-camera gate approximates it but does not test the transition.
5. **Ground plants at range** (§5.3) — stand at 280 m+ and look at a `grass_dry3` field. *Question: is 16
   triangles enough, or is the ground bald?* This decides whether §5.3 is a bug at all, and it is worth
   answering before Stage B scopes any ground-plant work.
6. **Stump04 close** — one debug render. *Question: is the pale colour a lighting artefact or the albedo?*
   Cheap, and it decides whether §5.4 is a geometry job or a one-line tint.

Frames 3, 4 and 5 need a real GPU. The project's own `render-baseline` notes that `gpuFrameMs` is null under
SwiftShader — the same caveat applies to alpha-test behaviour, mip selection, and MSAA, none of which
SwiftShader represents faithfully. **Do not sign off Stage A or B on headless frames.**

---

## 7. Open questions for the founder

1. **Stage B texture budget.** 256/128/64 for every archetype (deciduous-like, ~1.3× pack bytes, ~19 MB) or
   keep pine at 1024/512/256 (~5.1× on pines, pack well past 40 MB)? I recommend the cap; pine's own proof
   review lists the budget overrun as a promotion blocker. Localhost-only means bandwidth does not matter,
   but VRAM still does.
2. **Two missing source atlases.** Stage B needs `leaf_shrub` (7 prototypes, 2065 placements) and `leaf_dry`
   (4 prototypes, 682 placements) atlases that do not exist. Generate two more, or start Stage B with the
   three archetypes that have coverage (pine / broadleaf / birch-borrows-deciduous, 3051 + 479 + 35 = 3565
   placements, 40% of the map) and leave shrub/dry procedural-with-MASK?
3. **Birch.** No birch atlas exists and birch is 35 placements total (0.4%). Borrow the deciduous atlas with
   a tint, or leave birch on Stage A's MASK-blob treatment permanently?
4. **§5.3 ground plants.** 2391 placements at 12-16 triangles at LOD2. Do you want that fixed, or is it
   correct? I will not spend on it without frame 5 (§6.4) answering the question first.
5. **Provenance.** §0.3 means the pack in `.local-candidates/vegetation-full` was built by a factory that no
   longer exists. Confirm it is disposable rebuild evidence (`.local-candidates/README.md` says it is) and
   that a full rebuild replacing it is fine — the plan assumes yes.
