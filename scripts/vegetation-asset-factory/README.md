# Customs vegetation asset factory

This lane authors original, metre-scale vegetation prototypes for the exact local Customs
placement census. It does not open the EFT installation. Its only input is
`prototype_catalog.json`, a privacy-safe ledger of 31 prototype names, family mappings, aggregate
counts, and the nominal envelopes already used by TarkovZero's procedural fallback.

The key separation is deliberate:

- exact local truth stays in the runtime placement records: position, terrain elevation, yaw,
  width/height scale, tint, prototype identity, and the requested fixed 2x display relief;
- this factory supplies independently authored geometry and PBR pixels at canonical 1x metres;
- no game mesh, topology, UV, material, shader, texture pixel, executable, or install path is read,
  copied, exported, or required.

## Census coverage

| Authored family | Exact prototype names | Local placements |
| --- | --- | ---: |
| Birch | `birch01`, `birch02`, `birch03` | 35 |
| Deciduous broadleaf | `tree01`, `tree02`, `tree03` | 479 |
| Pine | `pine01` through `pine05` | 3,051 |
| Filbert / shrub | `filbert_01`, big/small/dry filberts, `brush_dry01/02` | 2,747 |
| Stump | `Stump01_update` through `Stump04_update` | 102 |
| Ground plant | `grass_dry3`, `fern01/02`, `plant_wolf01/02` | 2,391 |

Total: 31 prototype names and 8,805 exact local placements. The catalog preserves case-sensitive
prototype identity so a later renderer adapter can replace each current instanced fallback without
changing the placement contract.

## Visual construction

- Pines have a tapered leader, branch whorls, drooping scaffold limbs, and layered needle sprays.
- Birches use a slender bent trunk, high forks, an airy crown, folded leaf cards, and original
  white/dark-marked bark maps.
- Broadleaf trees use a heavier trunk, lower scaffold branches, secondary twigs, and a wider,
  layered round crown.
- Filbert/shrub variants use multi-stem branching and leaf clusters; dry brush keeps a deliberately
  sparse twig/leaf silhouette.
- Stumps have an irregular taper and cut plane; near LOD adds root flares, moss, and broken snags.
- Ground plants are authored as dry grass blades, fern rachises with paired leaflets, or broadleaf
  rosettes rather than crossed billboard placeholders.

LOD0/1/2 reduce branch depth, foliage clusters/cards, mesh sides, and embedded texture resolution
(128/64/32). Every material contains deterministic original base-color, tangent-normal, and ORM
textures embedded in the GLB. No camera, light, fog, animation, or external URI is exported.

## Pinned build

Use the reviewed Blender 4.5 LTS binary and always build into a temporary directory first:

```bash
BLENDER=/home/Zequence106/.local/share/tarkovzero-tools/blender-4.5.13/blender
OUT=/tmp/tarkovzero-vegetation-pine01
mkdir -p "$OUT"

for LOD in 0 1 2; do
  "$BLENDER" --background --factory-startup --disable-autoexec --python-exit-code 1 \
    --python scripts/vegetation-asset-factory/vegetation_factory.py -- \
    --prototype pine01 --lod "$LOD" --seed 106 \
    --output "$OUT/pine01-lod$LOD.glb" \
    --receipt "$OUT/pine01-lod$LOD.receipt.json"
done
```

The factory refuses to overwrite either final path. It exports to private partial files, validates
embedded GLB structure and PBR channels, then publishes the GLB and receipt with create-if-absent
hard links. If the receipt path loses a race, the newly linked GLB is rolled back. Each receipt
records the exact arguments after `--`, Blender version and binary hash, factory/catalog hashes,
seed, geometry/texture costs, bounds, output hash/bytes, and the source-payload boundary.

Validate the three real outputs together:

```bash
python3 scripts/vegetation-asset-factory/validate_vegetation_outputs.py \
  --prototype pine01 \
  "$OUT/pine01-lod0.receipt.json" \
  "$OUT/pine01-lod1.receipt.json" \
  "$OUT/pine01-lod2.receipt.json"
```

The gate re-hashes the actual sibling GLBs, parses their embedded glTF JSON, rejects external
buffers/images and private/source markers, verifies root/base-center/frame/PBR receipts, and
requires triangle count, byte count, and texture resolution to fall strictly at both LOD steps.

Run dependency-free unit tests with:

```bash
python3 -m unittest -v scripts/vegetation-asset-factory/test_vegetation_factory.py
```

The optional real-Blender round trip is intentionally opt-in:

```bash
TARKOVZERO_RUN_BLENDER_VEGETATION_TEST=1 \
  python3 -m unittest -v scripts/vegetation-asset-factory/test_vegetation_factory.py
```

For a neutral visual QA frame (also no-clobber), render any temporary GLB with:

```bash
"$BLENDER" --background --factory-startup --disable-autoexec --python-exit-code 1 \
  --python scripts/vegetation-asset-factory/render_preview.py -- \
  --prototype pine01 --input "$OUT/pine01-lod0.glb" \
  --output "$OUT/pine01-lod0-preview.png"
```

## Complete offline draft pack

Generate all 31 reviewed prototype names at all three LODs into a new, empty temporary directory:

```bash
PACK=$(mktemp -d /tmp/tarkovzero-vegetation-full.XXXXXX)

python3 scripts/vegetation-asset-factory/build_full_pack.py \
  --blender "$BLENDER" --output-root "$PACK" --jobs 4
```

`build_full_pack.py` derives a stable, distinct seed for each prototype from the pinned
`tarkovzero-customs-vegetation-pack-v1` namespace. It writes 93 GLBs, 93 receipts, generation
logs, and `generation-manifest.json`; the destination must be empty and every asset path remains
no-clobber.

Bind the two exact local scalar vegetation tiles without copying their coordinates into the pack:

```bash
python3 scripts/vegetation-asset-factory/build_pack_index.py \
  --pack-root "$PACK" \
  --vegetation .local-game-derived/customs/terrain-000-vegetation.json \
  --vegetation .local-game-derived/customs/terrain-001-vegetation.json \
  --output "$PACK/pack-index.json" \
  --receipt "$PACK/pack-index.receipt.json"
```

The resulting index contains 58 tile-local prototype bindings and one compact asset mapping for
each of the 8,805 placements. It intentionally omits coordinates because the existing validated
local package remains their canonical owner.

Run the complete custom and official Khronos gates with:

```bash
mkdir -p "$PACK/validation"

python3 scripts/vegetation-asset-factory/validate_full_pack.py \
  --pack-root "$PACK" --pack-index "$PACK/pack-index.json" \
  --output "$PACK/validation/custom-report.json"

node scripts/vegetation-asset-factory/validate_full_pack.mjs \
  --pack-root "$PACK" --output "$PACK/validation/khronos-report.json"
```

The full-pack validator applies explicit per-asset and aggregate byte/triangle/texture budgets;
the Node pass keeps the official Khronos validator warm in one process and requires zero errors,
warnings, infos, and hints across all 93 files.

Sample byte determinism and no-clobber behavior across different families/LODs:

```bash
python3 scripts/vegetation-asset-factory/verify_pack_reproducibility.py \
  --pack-root "$PACK" --blender "$BLENDER" \
  --sample pine01:0 --sample filbert_dry01:1 --sample grass_dry3:2 \
  --output "$PACK/validation/reproducibility-report.json"
```

The verifier rebuilds each sample to a fresh path, requires a byte-identical GLB, then deliberately
targets the published output/receipt pair and requires the factory to fail without changing it.

For visual review, render one representative form from every family at LOD0/1/2 with
`render_preview.py`, then pass each labelled PNG triplet to `build_contact_sheet.py`:

```bash
python3 scripts/vegetation-asset-factory/build_contact_sheet.py \
  --title "Customs vegetation — pine LOD review" \
  --output "$PACK/qa/pine-lods.png" --receipt "$PACK/qa/pine-lods.receipt.json" \
  --row "Pine | pine01" \
  "$PACK/qa/pine01-lod0.png" "$PACK/qa/pine01-lod1.png" "$PACK/qa/pine01-lod2.png"
```

The sheet and its input-hash receipt are no-clobber. A passing structural gate does not make a
sheet visually acceptable: reviewers should explicitly assess silhouette, branch/leaf read,
material breakup, and LOD continuity before any promotion.

## Bounded pine01 alpha-card proof

`source-textures/pine-scots-branch-sprays-openai-v1.png` is an immutable, project-bound copy of an
OpenAI-generated original 4-by-3 Scots-pine spray atlas. Its sibling provenance JSON records the
exact prompt, SHA-256, dimensions, OpenAI C2PA origin, approved proof-only use, and the explicit
boundary that it is not an EFT/source-game texture or a 1:1 equivalence claim.

Validate the source before use:

```bash
python3 scripts/vegetation-asset-factory/validate_source_atlas.py \
  --atlas scripts/vegetation-asset-factory/source-textures/pine-scots-branch-sprays-openai-v1.png \
  --provenance scripts/vegetation-asset-factory/source-textures/pine-scots-branch-sprays-openai-v1.provenance.json \
  --output "$PROOF/validation/source-atlas-report.json"
```

The source has meaningful transparent separation and twelve populated cells, but only 36 fully
opaque pixels and black RGB beneath zero alpha. Direct use therefore fails the edge gate. The
proof factory resizes in memory, dilates credible foliage RGB eight pixels beneath transparency,
uses guarded atlas-cell UVs, and exports one double-sided glTF `MASK` material at cutoff `0.376`
with embedded base/derived-normal/ORM maps.

The lane is deliberately opt-in so the normal 31-prototype build and its budgets do not silently
change:

```bash
PROOF=$(mktemp -d /tmp/tarkovzero-pine-alpha-proof.XXXXXX)
mkdir -p "$PROOF/assets/pine01" "$PROOF/validation"

for LOD in 0 1 2; do
  "$BLENDER" --background --factory-startup --disable-autoexec --python-exit-code 1 \
    --python scripts/vegetation-asset-factory/vegetation_factory.py -- \
    --prototype pine01 --lod "$LOD" --seed 997817530 --pine-alpha-proof \
    --output "$PROOF/assets/pine01/pine01-lod$LOD.glb" \
    --receipt "$PROOF/assets/pine01/pine01-lod$LOD.receipt.json"
done
```

`pine01` proof geometry uses tapered primary/secondary branches and branch-endpoint-anchored,
physically layered atlas sprays. It contains no closed foliage spheres or cone tiers. Validate the
three receipts with `validate_vegetation_outputs.py`, the three GLBs with
`validate_khronos_outputs.mjs`, and byte/no-clobber behavior with
`verify_prototype_reproducibility.py` before rendering the fixed standard/close/side/top views.

This is a visual proof, not a production-budget admission. Its uncompressed embedded PNG cost is
expected to exceed the existing full-pack LOD budgets until runtime texture compression, atlas
gutter/mip testing, and target-hardware instancing are completed.

## Bounded tree02 deciduous alpha-card proof

`source-textures/deciduous-broadleaf-branch-sprays-openai-v1.png` is an immutable, project-bound
OpenAI-generated original 4-by-3 atlas. Its sibling provenance record pins the exact prompt,
SHA-256, dimensions, OpenAI C2PA origin, proof-only use, and the explicit boundary that it is not
an EFT/source-game texture or 1:1 source-asset claim.

The source gate deliberately reports two generated-image risks: accepted alpha touches horizontal
source-cell seams and saturated red/green fringe exists below the intended cutoff. Direct use is
therefore forbidden. The `tree02` path independently resamples every cell into a bounded 4/2/1 px
LOD0/1/2 gutter, discards all below-cutoff RGB before four-pixel accepted-color dilation, and uses
gutter-safe UVs. `validate_embedded_alpha_atlas.py` verifies those properties again on the PNG
actually embedded in every GLB.

Generate the opt-in proof without changing the normal 31-prototype pack lane:

```bash
PROOF=$(mktemp -d /tmp/tarkovzero-tree02-alpha-proof.XXXXXX)
mkdir -p "$PROOF/assets/tree02" "$PROOF/validation" "$PROOF/qa"

for LOD in 0 1 2; do
  "$BLENDER" --background --factory-startup --disable-autoexec --python-exit-code 1 \
    --python scripts/vegetation-asset-factory/vegetation_factory.py -- \
    --prototype tree02 --lod "$LOD" --seed 1210025002 --deciduous-alpha-proof \
    --output "$PROOF/assets/tree02/tree02-lod$LOD.glb" \
    --receipt "$PROOF/assets/tree02/tree02-lod$LOD.receipt.json"
done
```

The proof uses an asymmetric tapered trunk, buttress roots, four uneven primary scaffolds with
hierarchically attached child limbs, core/cap twigs, and branch-attached layered sprays. Shared
LOD scaffold/core landmarks come from keyed RNG streams and must remain exact nested subsets;
global envelope scaling must remain exactly 1.0. It contains no closed foliage ellipsoid, sphere,
procedural leaf blob, or evenly spaced radial branch wheel. LOD cost, alpha
`MASK`/cutoff/double-sided semantics, embedded PBR maps, source hash, gutters, deterministic replay,
and no-clobber behavior are hard validation gates.

Run the proof-specific gates with:

```bash
python3 scripts/vegetation-asset-factory/validate_vegetation_outputs.py \
  --prototype tree02 --output "$PROOF/validation/custom-report.json" \
  "$PROOF/assets/tree02/tree02-lod0.receipt.json" \
  "$PROOF/assets/tree02/tree02-lod1.receipt.json" \
  "$PROOF/assets/tree02/tree02-lod2.receipt.json"

python3 scripts/vegetation-asset-factory/validate_embedded_alpha_atlas.py \
  --prototype tree02 --output "$PROOF/validation/embedded-atlas-report.json" \
  "$PROOF/assets/tree02/tree02-lod0.glb" \
  "$PROOF/assets/tree02/tree02-lod1.glb" \
  "$PROOF/assets/tree02/tree02-lod2.glb"

node scripts/vegetation-asset-factory/validate_khronos_outputs.mjs \
  --output "$PROOF/validation/khronos-report.json" \
  --glb "$PROOF/assets/tree02/tree02-lod0.glb" \
  --glb "$PROOF/assets/tree02/tree02-lod1.glb" \
  --glb "$PROOF/assets/tree02/tree02-lod2.glb"

python3 scripts/vegetation-asset-factory/verify_prototype_reproducibility.py \
  --proof-root "$PROOF" --blender "$BLENDER" --prototype tree02 \
  --output "$PROOF/validation/reproducibility-report.json"

for LOD in 0 1 2; do
  "$BLENDER" --background --factory-startup --disable-autoexec --python-exit-code 1 \
    --python scripts/vegetation-asset-factory/render_preview.py -- \
    --input "$PROOF/assets/tree02/tree02-lod$LOD.glb" \
    --output "$PROOF/qa/tree02-lod$LOD-silhouette.png" \
    --prototype tree02 --size 512 --view standard --transparent-silhouette
done

python3 scripts/vegetation-asset-factory/validate_fixed_camera_continuity.py \
  --prototype tree02 --output "$PROOF/validation/fixed-camera-continuity.json" \
  "$PROOF/qa/tree02-lod0-silhouette.png" \
  "$PROOF/qa/tree02-lod1-silhouette.png" \
  "$PROOF/qa/tree02-lod2-silhouette.png"
```

The custom gate reports a geometric surface-load proxy—single-sided atlas-card surface area divided
by nominal canopy footprint—and requires it to decrease without collapsing across LODs. This is an
offline overdraw-risk proxy only. It does not replace target-browser GPU timing, alpha-shadow,
screen-space overdraw, mip-transition, wind, or 279-instance stress tests. The transparent-mask
gate measures occupied silhouette and crown-envelope continuity from one exact camera; it does not
replace orbit views or target-runtime LOD transition review.

## Admission boundary and limitations

This directory is a source factory only. It does not write `public/`, change Manifest v2, replace
the current renderer, deploy, or include generated binaries. Promotion is a separate reviewed step
after GLB validation, fixed-camera visual inspection, target-hardware frame/memory tests, and a
prototype-to-instancing adapter.

The exact scalar names and placements do not reveal the original botanical species, source-mesh
bounds, branch topology, leaf cutouts, bark pixels, wind response, or seasonal state. Those parts
are original visual approximations. Standard builds still use geometry foliage; the bounded
`pine01` proof uses the separately provenanced original alpha atlas. These prototypes should
materially improve recognizable grass/tree/shrub form, but they are not a 1:1 source-asset claim
until held-out in-game comparisons and runtime correspondence tests say so.
