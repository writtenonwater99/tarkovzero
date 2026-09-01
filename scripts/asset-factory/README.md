# Customs Fortress asset factory

## Current admission status

The brighter weathered-roof V2 Fortress shell passed its separate live localhost A/B and is
admitted only as an original-authored structural/coordinate baseline; it is not a near-1:1
tactical model. ZB-013 remains an offline slab-box baseline and is not admitted.

Do not promote a candidate or change live manifest replacement records without a fresh visual gate.
Near-1:1 admission still requires materially better facade articulation, recognizable openings and
cover, material/weathering response, and a measured ZB-013 room layout.
Collision must remain `none`; tactical openings and cover are original-authored hypotheses rather
than accuracy-certified geometry.

This lane creates original, metric glTF assets for the Customs Fortress golden cell. It does not
open the EFT install and contains no copied game mesh, topology, UV, texture, shader, decal, sign,
brand, or baked light. Its only reference inputs are the sanitized scalar facts listed in
`fortress_factory.py` and, when explicitly provided, one hash-pinned scalar-only recipe.

The factory intentionally emits two independently streamable asset families:

- `fortress-shell`: ground slab, upper floor, open concrete/brick/cement-board facade, 11 exact
  girder stations, 22 roof supports, an intentionally incomplete 60-panel weathered gable roof,
  two stairs, and four exterior ramps;
- `zb013-basement`: separately seated underground shell, circulation lane, structural supports,
  and generic utility detail. The measured basement elevation is exact; the unmeasured internal
  room plan is explicitly marked as a hypothesis in the receipt.

## Pinned invocation

Use Blender 4.5 LTS. `--factory-startup` removes workstation preferences from the build,
`--disable-autoexec` prevents embedded or discovered scripts from running, and
`--python-exit-code 1` makes validation failures visible to automation. Outputs should first go to
a temporary directory; only validated binaries belong in the final asset package.

```bash
BLENDER=/home/Zequence106/.local/share/tarkovzero-tools/blender-4.5.13/blender

"$BLENDER" --background --factory-startup --disable-autoexec --python-exit-code 1 \
  --python scripts/asset-factory/fortress_factory.py -- \
  --asset fortress-shell --lod 0 \
  --structure-scalars .local-game-derived/asset-factory/customs/fortress-structure-scalars-v1.json \
  --output /tmp/tz-fortress-shell-lod0.glb \
  --receipt /tmp/tz-fortress-shell-lod0.receipt.json

"$BLENDER" --background --factory-startup --disable-autoexec --python-exit-code 1 \
  --python scripts/asset-factory/fortress_factory.py -- \
  --asset zb013-basement --lod 0 \
  --output /tmp/tz-zb013-basement-lod0.glb \
  --receipt /tmp/tz-zb013-basement-lod0.receipt.json
```

Repeat with `--lod 1` and `--lod 2`. Geometry complexity, object count, texture resolution, and GLB
bytes are designed to fall at each step. Verify that they actually do using the receipt fields
before admitting the files to Manifest v2.

`--structure-scalars` accepts only the reviewed 129 KiB document whose SHA-256 is pinned in the
source. The loader also requires the exact scalar-only schema, 334-object/category ledger, bounded
finite vectors, root transform, and explicit payload-exclusion list. Any other file is rejected.
For the shell, reviewed origins seat the 60 roof panels, 11 girders, 22 supports, four ramps, and
nonzero above-root opaque modules; their mesh dimensions, UVs, and PBR pixels are still original.
For ZB-013 the recipe validates the shared root pose only—the supplied facts do not identify a
complete playable basement room plan.

## Coordinate and placement contract

- Authoring: Blender metres, `+Z` up.
- GLB: glTF metres, `+Y` up, `+X` forward.
- Shell pivot/placement: canonical EFT root `(202.898880005, 1.729503632, -127.68775177)` and
  `-10.342808°` plan yaw. Its exact surveyed local footprint is a four-corner quadrilateral; the
  ground and upper playable tops remain at world Y `2.447` and `8.183` metres.
- ZB-013 pivot/placement: independent pivot `(206, -1.7874, -147.5)`, `+90°` plan yaw, and a
  `26 × 21 m` authored shell. Its playable floor top is local Y zero. This does not certify the
  original-authored room/opening hypotheses as measured or collidable.
- Relief: all assets are authored at canonical 1× physical metres. TarkovZero owns its fixed 2×
  display relief; the factory must never pre-distort elevation.

## PBR and lighting contract

Each LOD embeds deterministic, original procedural base-color, tangent-normal, and ORM textures for
concrete, brick, cement board, steel, and three muted corrugated-roof weathering families. The roof
families use coordinate-hashed assignment and UV phase offsets instead of an alternating checker.
Their shared midtone keeps whole panels from reading as binary dark/light blocks, while localized
grime/corrosion frequency carries the authored variation. None is measured per panel. The source
equations are seeded integer/noise functions, not game pixels. General LOD0/1/2
tiles use 256/128/64 pixels; roof tiles use 128/64/32 pixels at a broader metric scale to reduce
close-up repetition without creating clean-new or neon surfaces.

Before export, static meshes are joined by collection, floor, and material. The 60 measured LOD0
roof panels remain separate and inspectable; other repeated boxes do not become hundreds of browser
draw calls. Batching hard-fails if recomputed asset bounds drift by more than 1 cm. The validator
hard-fails a shell above 150 mesh/draw proxies or a basement above 50.

No light, camera, fog, irradiance, ambient occlusion bake, light map, or environment map is
exported. Runtime lighting remains the renderer's job.

## Required admission checks

The output is a high-fidelity production baseline, not evidence that every opening is exact. Before
an asset replaces the procedural Fortress, validate all of the following:

1. GLB opens cleanly and contains only embedded resources.
2. LOD triangle and byte costs strictly decrease.
3. Bounds preserve the measured root-local ground/basement offsets and the declared origin pivot.
4. Fixed-camera footprint and roof silhouette match held-out references.
5. Gate/window, stair, ramp, floor, cover, and ZB-013 navigation anchors pass measured tolerance.
6. Material scale and roughness read correctly under TarkovZero's runtime lights.
7. Manifest hashes/bytes/triangles are copied from the final validation receipt, never estimated.

The supplied facts do not determine exact facade damage, opening widths, signs, clutter, or the
complete ZB-013 room plan. Those remain the largest fidelity limitations and must stay visible in
QA rather than being promoted as measured truth.

After all three receipts exist in one directory, run the dependency-free admission validator:

```bash
python3 scripts/asset-factory/validate_fortress_outputs.py --asset fortress-shell \
  /tmp/tz-fortress-shell-lod0.receipt.json \
  /tmp/tz-fortress-shell-lod1.receipt.json \
  /tmp/tz-fortress-shell-lod2.receipt.json
```

It derives triangle totals and transformed scene bounds from the exported accessors, cross-checks
material/image counts, verifies real file hashes/bytes, strict LOD cost reduction, embedded-only
resources, complete PBR channels, both placement contracts, exact playable floor elevations, the
shell footprint slab, and the LOD0 roof/girder/support ledger. Run the Blender-hosted geometry tests
and validator mutation tests as additional admission gates; none of these checks upgrades authored
tactical openings or the ZB-013 room plan to certified truth/collision geometry.
