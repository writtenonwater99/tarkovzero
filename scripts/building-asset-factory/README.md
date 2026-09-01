# Crackhouse original building-asset factory

This isolated factory creates an **offline-only**, original-authored Crackhouse/mechanic
shell for the Customs accuracy program. It does not read game files, call the network,
modify public assets, or place anything into the live renderer. The GLBs contain no game
meshes, textures, shaders, baked lighting, fog, collision, cameras, or lights.

The factory is a golden-cell authoring and QA candidate, not a tactical or near-1:1
certification. Its real door/window voids, frames, glazing, damage, stair, partitions,
plinth, roof tiles, and weathered PBR maps are independently authored hypotheses.

## Public truth anchors and transform contract

`crackhouse_facts.json` records one building row and its two stable-ID floor surfaces
from `public/data/customs-3d.json` (SHA-256
`9a6df2ad1d62371e0f139b0c017ea1fdc1426d44905042cd9a4f34a575141dad`).

- EFT XZ footprint: `[[94.3,-166.5],[89.5,-142.6],[73.6,-145.9],[78.4,-169.7]]`
- Public height/floors/style/place: `6.5 m`, `2`, `gable`, `Crackhouse`
- World floor elevations: ground `1.983 m`, upper `5.4932 m`; upper local elevation `3.5102 m`
- Canonical base-centre EFT pivot: `(83.95, 1.983, -156.175) m`
- Canonical yaw: `-11.379260726349447 degrees`
- Mean opposing-edge dimensions: length `24.3282263496601 m`, width `16.228829278137322 m`
- GLB contract: metres, `+Y` up, `+X` forward, base-centre origin; placement remains receipt metadata

The pivot is the arithmetic mean of the four footprint vertices. The long axis is the
normalized mean of `p0 -> p1` and the reversed opposing edge `p3 -> p2`. Yaw is
`atan2(longAxis.x, longAxis.z)` because authored `+X` forward maps to EFT `+Z` at zero
yaw. Length and width are the means of their opposing edge lengths. The factory and
independent validator derive these values separately.

## Deterministic outputs

The Blender 4.5.13 LTS factory emits LOD0/1/2 GLBs with embedded base-colour, normal,
and packed occlusion/metallic-roughness textures. It batches authored fragments by
material family and by **measured vertical occupancy**, preserves named slab nodes and
opening-void empties, and removes unused duplicate UV layers before export. Every output
and receipt uses a no-clobber contract; pre-existing targets cause failure.

A batch band is earned, not declared. `ground` contains nothing above the upper floor,
`floor-1` nothing below it, and a piece that genuinely spans both — a downpipe, a stair
rail — lands in `cross-floor` rather than being filed under whichever floor its top edge
touches. `receipt.asset.floors` reports the bands that actually shipped, so a consumer
slicing by band gets the geometry the name promises.

Create a fresh candidate directory and build all three LODs:

```bash
TZ_CRACKHOUSE_OUT="$(mktemp -d --tmpdir tarkovzero-crackhouse.XXXXXX)"
mkdir "$TZ_CRACKHOUSE_OUT/qa"
TZ_CRACKHOUSE_BLENDER="$HOME/.local/share/tarkovzero-tools/blender-4.5.13/blender"

for TZ_LOD in 0 1 2; do
  "$TZ_CRACKHOUSE_BLENDER" --background --factory-startup --disable-autoexec \
    --python-exit-code 1 --python scripts/building-asset-factory/crackhouse_factory.py -- \
    --lod "$TZ_LOD" \
    --facts scripts/building-asset-factory/crackhouse_facts.json \
    --output "$TZ_CRACKHOUSE_OUT/crackhouse-shell-lod$TZ_LOD.glb" \
    --receipt "$TZ_CRACKHOUSE_OUT/crackhouse-shell-lod$TZ_LOD.receipt.json"
done
```

## Verification

Verify the checked-in scalar selection and its public-source hash:

```bash
python3 scripts/building-asset-factory/derive_crackhouse_facts.py \
  --source public/data/customs-3d.json \
  --facts scripts/building-asset-factory/crackhouse_facts.json
python3 -m unittest scripts/building-asset-factory/test_derive_crackhouse_facts.py -v
```

Run Blender-hosted topology, opening, transform, bounds, batching, and UV contracts:

```bash
"$TZ_CRACKHOUSE_BLENDER" --background --factory-startup --disable-autoexec \
  --python-exit-code 1 --python scripts/building-asset-factory/test_crackhouse_factory.py
```

Run the independent receipt/GLB validator and its four corruption-rejection tests:

```bash
python3 scripts/building-asset-factory/validate_crackhouse_outputs.py \
  "$TZ_CRACKHOUSE_OUT/crackhouse-shell-lod0.receipt.json" \
  "$TZ_CRACKHOUSE_OUT/crackhouse-shell-lod1.receipt.json" \
  "$TZ_CRACKHOUSE_OUT/crackhouse-shell-lod2.receipt.json"

TZ_CRACKHOUSE_QA_RECEIPTS="$TZ_CRACKHOUSE_OUT/crackhouse-shell-lod0.receipt.json,$TZ_CRACKHOUSE_OUT/crackhouse-shell-lod1.receipt.json,$TZ_CRACKHOUSE_OUT/crackhouse-shell-lod2.receipt.json" \
  python3 -m unittest scripts/building-asset-factory/test_validate_crackhouse_outputs.py -v
```

Run the official Khronos glTF Validator with a strict-zero issue threshold:

```bash
node scripts/building-asset-factory/validate_khronos_outputs.mjs \
  --output "$TZ_CRACKHOUSE_OUT/qa/khronos-validation.json" \
  --glb "$TZ_CRACKHOUSE_OUT/crackhouse-shell-lod0.glb" \
  --glb "$TZ_CRACKHOUSE_OUT/crackhouse-shell-lod1.glb" \
  --glb "$TZ_CRACKHOUSE_OUT/crackhouse-shell-lod2.glb"
```

For byte reproducibility, build the same three files into a second fresh directory and run:

```bash
python3 scripts/building-asset-factory/verify_crackhouse_reproducibility.py \
  --reference "$TZ_CRACKHOUSE_OUT" --candidate "$TZ_CRACKHOUSE_REPRO" \
  --output "$TZ_CRACKHOUSE_OUT/qa/reproducibility.json"
```

Run the QA camera-rig contracts before trusting any render as evidence. Pointing
`TZ_CRACKHOUSE_QA_GLBS` at the built LODs adds the real-model framing check:

```bash
TZ_CRACKHOUSE_QA_GLBS="$TZ_CRACKHOUSE_OUT/crackhouse-shell-lod0.glb,$TZ_CRACKHOUSE_OUT/crackhouse-shell-lod1.glb,$TZ_CRACKHOUSE_OUT/crackhouse-shell-lod2.glb" \
  "$TZ_CRACKHOUSE_BLENDER" --background --factory-startup --disable-autoexec \
  --python-exit-code 1 --python scripts/building-asset-factory/test_crackhouse_qa_rig.py
```

Create fixed-camera visual evidence (run once per view: `oblique`, `south`, `east`):

```bash
python3 scripts/building-asset-factory/build_contact_sheet.py \
  --title "Crackhouse shell · oblique · LOD progression" --view oblique \
  --item "LOD0=$TZ_CRACKHOUSE_OUT/crackhouse-shell-lod0.glb" \
  --item "LOD1=$TZ_CRACKHOUSE_OUT/crackhouse-shell-lod1.glb" \
  --item "LOD2=$TZ_CRACKHOUSE_OUT/crackhouse-shell-lod2.glb" \
  --output "$TZ_CRACKHOUSE_OUT/qa/crackhouse-lod-oblique.png"
```

### What the QA rig is, and what it is not

Every camera, light, and the ground plane come from one frozen reference envelope
(`REFERENCE_MIN`/`REFERENCE_MAX` in `render_crackhouse_preview.py`). Nothing in the rig
reads the imported GLB, so the three panels of a sheet are one camera and one light rig
and the LODs can be compared against each other. `ortho_scale` is derived by projecting
that envelope and adding `FRAME_MARGIN`, so a view cannot silently crop the subject; a
model that leaves the envelope fails the render instead of being framed out of it.

`QA_Ground` sits 4 mm below the envelope floor, not below the model's own floor. It is an
asset-base datum that exposes base-pivot drift between LODs. It is **not** terrain
evidence and these renders make no foundation-contact claim.

## Admission boundary

The offline gates establish deterministic geometry, real opening gaps, truthful provenance,
embedded PBR completeness, LOD reduction, transform/bounds consistency, and glTF
conformance. They do **not** establish the following, which remain blockers for live use:

- surveyed facade opening, door, glazing, roof-tile, damage, or interior placement;
- collision, navigation, cover, loot, quest, or tactical correctness;
- held-out in-raid silhouette/object comparison from all four facades;
- runtime world-placement, terrain-contact, lighting, draw-call, and frame-time acceptance;
- visual near-1:1 certification or permission to describe this hypothesis shell as exact.
