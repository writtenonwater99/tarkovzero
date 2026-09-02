# `scripts/lib` — the shared asset-factory core

One definition of each helper the offline asset factories used to copy-paste.
Landed by the three-factory consolidation pass (2026-09-01), which changed
**zero asset bytes**: see "Regression oracle" below for how that was proven.

```
scripts/lib/
    bootstrap.py           sys.path helper for Blender-hosted --python scripts
    gltf/read.py           pure stdlib: GLB parsing, node transforms, scene walk
    gltf/lod.py            pure stdlib: the cross-LOD silhouette invariant
    blender/noise.py       hash01 / smoothstep / tile noise, as NAMED VARIANTS
    blender/materials.py   create_image, height-field → normal map, occlusion group
    blender/primitives.py  box geometry, metric UV, frozen glTF export settings
    blender/lod_grid.py    per-LOD part layouts that do not change the silhouette
    test_lib_core.py       37 tests pinning every variant to its original body
    test_lod_gate.py       25 tests on the invariant and the two layout helpers
```

`lib.gltf` is standard-library only and must never `import bpy` — the validators
have to run under plain `python3` in CI with no Blender on the machine.
`lib.blender` imports `bpy`; `lib.blender.noise` is the exception, being pure
arithmetic so its variants can be unit-tested without Blender.

## How a factory reaches it

Blender runs a `--python` script with `__name__ == "__main__"` and does not put
the script's tree on `sys.path`, so each factory and validator opens with:

```python
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.gltf.read import glb_json, require, sha256_file
```

`parents[1]` is `<repo>/scripts` for a file at `<repo>/scripts/<dir>/<file>.py`.
This is working-directory independent — verified by building an asset with
`cwd=/tmp` and getting the same digest.

## The divergences, and why they are still here

Three factories authored these helpers independently and the copies drifted.
**Unifying them would change texture pixels**, and one of the affected assets
(`fortress-shell`) is admitted with pinned SHA-256 digests in
`public/assets/3d/customs/scene-manifest.json`. Picking a winner is a
re-baseline that needs the founder's GPU review, not something a refactor
decides. So every divergence is preserved as an explicitly named variant with
**no default** — a new factory author has to choose in the open rather than
inherit whichever file they copied from.

| Helper | fortress | crackhouse | industrial |
| --- | --- | --- | --- |
| `hash01` | `HASH01_MASKED_SUM` | `HASH01_MASKED_SUM` | `HASH01_XOR_UNMASKED` |
| `smoothstep` | `SMOOTHSTEP_UNCLAMPED` | `SMOOTHSTEP_UNCLAMPED` | `SMOOTHSTEP_CLAMPED` |
| tile noise | `tile_noise_cell_pixels_lerp` | `tile_noise_cell_pixels_mix` | `tile_noise_cell_count_lerp` |
| box winding | `fortress-crackhouse-v1` | `fortress-crackhouse-v1` | `industrial-v1` |
| UV layer policy | fresh layer | fresh layer | reuse + `mesh.update()` first |

`FACTORY_NOISE_PROFILES` in `blender/noise.py` is the same table in code.

Two of these were not recorded in `docs/plans/BUILDING-MASSING.md` §4.1 before
this pass:

- **Tile noise** closes its bilinear as `a + (b-a)*t` in fortress and
  `a*(1-t) + b*t` in crackhouse. Algebraically equal, **not** equal in
  IEEE-754, so they genuinely produce different pixels.
- **Box winding** differs in the last three faces: fortress and crackhouse
  agree, industrial walks the side faces as a ring. Both wind outward, but the
  emitted vertex and index order differs, so the bytes differ.

`test_lib_core.py` holds a verbatim copy of each original body as a reference
oracle and asserts bit-equality against it. It also asserts the variants still
*disagree* — so a future "tidy-up" that collapses two of them fails loudly
instead of silently re-baselining an asset. Both failure modes were
mutation-tested when the tests were written.

## The cross-LOD silhouette gate (added 2026-09-01)

`gltf/lod.py` holds one rule: **`bounds(LOD n)` must be contained in
`bounds(LOD n-1)` and in `bounds(LOD 0)`, on every axis.** A coarser level may
lose material; it may never gain silhouette.

It is here rather than in one factory's QA folder because measuring every chain
the three factories produce found the defect in all three, from three unrelated
authoring mistakes: `crackhouse-shell` LOD1 +13.18 mm, `tanker-wagon` LOD1
+15.00 mm, and `fortress-shell` LOD1 +15.67 mm / LOD2 +40.00 mm. All three
validators now call `assert_contained()` on the bounds they already measure — it
takes bounds *records*, not files, so nobody walks a scene twice.

`fortress-shell` is the one asset that still grows, and the only admitted one.
Its five escapes are pinned exactly in `validate_fortress_outputs.py` as a
tripwire: an unpinned growth fails, and a pinned growth that changes or
disappears fails too, so fixing it stays a deliberate founder decision with a
stated cost (new digests in `scene-manifest.json` and a fresh GPU review) rather
than something an unrelated edit can do quietly.

`blender/lod_grid.py` is the authoring half — the two shapes that produce the
defect, each with a helper that does not:

| Mechanism | Seen in | Helper |
| --- | --- | --- |
| A per-LOD grid of overlapping parts laid on cell **centres** | crackhouse roof tiles, crackhouse stair treads | `overlapping_band` / `band_fraction` |
| A member that gets **thicker** at a coarser LOD, positioned by its **centre-line** | tanker tank bands + ladder stiles, fortress girder chords | `outer_anchored_center` |

Like `noise.py`, `lod_grid.py` lives under `lib/blender` but imports no `bpy`,
so it is unit-testable under plain `python3`.

## What is deliberately NOT shared

Merging these would be a fake abstraction that makes the twelve-building lane
worse, not better:

- **`tag_object`** — three different signatures and semantics. Fortress takes an
  explicit `asset_id`; crackhouse reads a module constant and records a
  hypothesis id; industrial reparents and records a component name.
- **`create_material`** — the node graph's layout, the material families, and
  whether base colour carries alpha are per-factory contracts. Only the
  height-field → normal kernel and `create_image` were common, and those moved.
- **Publication policy in `export_glb`** — the *export settings* are shared and
  frozen (`GLTF_EXPORT_SETTINGS`); what happens to the file afterwards is not.
  Fortress replaces its output, crackhouse and industrial refuse to clobber one.
  Those are different promises and merging them relaxes one.
- **`validate_industrial_props.glb_json`** — stricter than the shared reader:
  regular-non-symlink, an 8 KiB–8 MiB envelope, and exactly one JSON *and* one
  BIN chunk. Kept local rather than weakened or imposed on the others.
- **`geometry_stats`** — the three validators report different statistics
  (`boundsM` vs `bounds`, industrial also tallies vertices/draw calls and
  rejects instancing). The shared piece is the *walk*
  (`iter_mesh_primitives`); each validator keeps its own contract on top.
- **Comparison tolerances** — 1e-4 (fortress), 1e-5 (crackhouse), 0.002
  (industrial). `close`/`vector_close` take the tolerance explicitly with no
  default, so a shared default cannot silently loosen one.

## Regression oracle

`npm run test:factory-core` runs the 37 variant-pinning tests plus the 25 in
`test_lod_gate.py`. `npm run test:building-lod-silhouette` runs the CLI's own 19
tests and the two validators' gate tests.

The byte-level proof lives outside the repo, in the consolidation pass's
scratchpad: build all 24 assets before and after, then compare per file. 21 of
24 GLBs are byte-identical. The other three carry a **pre-existing** Blender
exporter nondeterminism — see below — and are compared structurally instead:
JSON chunk identical, all image bytes identical, POSITION / NORMAL / INDICES
bit-exact, and TEXCOORD_0 / TANGENT within the drift ceiling measured from two
runs of the *unmodified* factories.

## Known defect: three fortress outputs are not byte-reproducible

`fortress-shell-lod0`, `fortress-shell-lod1` and `zb013-basement-lod0` produce a
different SHA-256 on every build, from unmodified code, on the same machine.
Byte length, triangle count, bounds, the whole JSON chunk and every embedded
image are stable; only TEXCOORD_0 (≤ 9.54e-07, ~1 ULP) and TANGENT (≤ 3.1e-03)
move. Not fixed by `-t 1` or `PYTHONHASHSEED=0`.

This predates the consolidation and is not caused by it. It means the pinned
`fortress-shell` lod0/lod1 digests in `scene-manifest.json` **cannot be
reproduced by rebuilding** — the manifest still proves the shipped bytes are the
admitted bytes, but "rebuild and confirm" is unavailable for those two LODs.
The crackhouse and industrial factories are fully deterministic; so is
`fortress-shell-lod2`, which rebuilds to the shipped digest exactly.

## Provenance gap to close

A receipt pins `generator.scriptSha256` — the SHA-256 of the factory file
alone. Code that moved into this package is no longer covered by that pin.
`bootstrap.library_module_paths()` returns every `.py` here so a caller can hash
them, but no receipt does so yet, because adding a field would change an
admitted asset's receipt. That is a founder decision, deliberately left open.
