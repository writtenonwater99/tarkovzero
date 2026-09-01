# Customs terrain PBR factory v2.1

This factory authors the twelve Customs terrain material families from deterministic code. It does
not read EFT files, screenshots, downloaded textures, or the network. The output is CC0-1.0,
original-authored material source for TarkovZero's terrain renderer.

V2 is the live-visual-QA revision. It replaces the conspicuous 2.2--6 m source loops with
13.2--36 m loops, while scaling stamp counts and radii so grass clumps, stones, pebbles, leaf
litter, and broken tread marks retain their intended dimensions and density in metres. Living
ground uses a muted olive palette, dirt/grass/gravel have deliberately separated roughness bands,
and long axis-locked road ruts, sand ripples, rock strata, and dominant crack networks have been
replaced by stochastic local features. The separate 256 m macro map still provides broad color
breakup.

V2.1 is a bounded close-surface revision over those unchanged V2 repeats. It adds deterministic,
non-directional micro-grit at nominal 12 cm, 7 cm, and 3 cm bands. Dirt, road aggregate, gravel,
stone, rock, pebbles, and soil receive the strongest normal/roughness treatment; grass, forest,
grassy ground, and sand remain restrained. Albedo grit stays within 1.5--5 sRGB code values so the
normal and roughness channels carry most of the tactile read without creating a repeated speckle
map. Living and earth colors receive a further measured ash/olive grade while preserving family
contrast.

The 512 px output cannot resolve every nominal band for every physical footprint: a rock tile spans
36 m, or about 7 cm per texel. Normal grit therefore clamps to a two-texel footprint instead of
pretending to encode sub-Nyquist 3 cm relief that would shimmer in motion. The existing finest
albedo/ORM grain carries the sub-texel statistical breakup through the mip chain.

| Semantic | V1 repeat | V2 repeat |
| --- | ---: | ---: |
| grass | 2.4 m | 14.4 m |
| ground | 3.5 m | 21.0 m |
| gravel-road-a | 4.5 m | 27.0 m |
| forest-ground | 3.2 m | 19.2 m |
| stone-ground | 4.0 m | 24.0 m |
| rock-ground | 6.0 m | 36.0 m |
| gravel-road-b | 4.2 m | 25.2 m |
| gravel | 2.2 m | 13.2 m |
| grassy-ground | 2.8 m | 16.8 m |
| sand | 3.0 m | 18.0 m |
| pebbles-ground | 2.5 m | 15.0 m |
| soil-grass | 3.0 m | 18.0 m |

## Generate

```bash
python3 scripts/terrain-pbr-factory/terrain_pbr_factory.py \
  --output /tmp/customs-terrain-pbr \
  --size 512
```

`--size` must be a power of two from 32 through 1024. The output directory must be new. To replace
only known regular factory artifacts in an existing directory, pass `--force`; unrelated files are
preserved. Root, traversal, and symlink output paths fail closed.

Supplying a trusted `toktx` executable also builds full-mip KTX2 delivery artifacts:

```bash
python3 scripts/terrain-pbr-factory/terrain_pbr_factory.py \
  --output /tmp/customs-terrain-pbr-ktx2 \
  --size 512 \
  --toktx /absolute/path/to/toktx
```

The encoder runs without a shell, with one compression thread and `TOKTX_OPTIONS` removed from its
environment. Albedo uses ETC1S/sRGB. Tangent-space normals and packed linear ORM use UASTC+Zstd.
The macro albedo is a separate ETC1S/sRGB 2D texture. All four KTX2 products have a complete mip
chain, and the three texture-array slice order is always:

1. grass
2. ground
3. gravel-road-a
4. forest-ground
5. stone-ground
6. rock-ground
7. gravel-road-b
8. gravel
9. grassy-ground
10. sand
11. pebbles-ground
12. soil-grass

## Output contract

The factory writes 36 semantic source PNGs (`albedo`, height-derived tangent `normal`, and RGBA
`ORM`), plus `customs-terrain-macro-albedo.png`. Every PNG has an exact periodic border: its final
row/column duplicate its first row/column.

Height fields exist only transiently to derive tangent-space normals and ambient occlusion. No
height texture is emitted and the material set never performs runtime height/displacement mapping;
the renderer's exact terrain geometry and fixed 2x elevation presentation remain authoritative.
The factory never reads or modifies control/splat masks, and V2.1 adds no runtime texture samples.

`receipt.json` records generator version, seeds, physical repeat scales, channel meanings, byte
counts, SHA-256 digests, provenance, license, encoder commands, KTX2 metadata, the sixfold V2
repeat revision, the V2.1 physical micro-grit configuration, palette grade, and the explicit
no-displacement contract.
`provenance.json` and `original-license.json` are the separate receipts required by the runtime
contract.

`material-set.template.json` has the exact closed shape accepted by
`src/customs-terrain-material-contract.js`, including canonical array role order and the 256 m macro
repeat. With `--toktx`, every content hash is the exact generated KTX2 digest and the template is
ready to relocate beneath `/assets/3d/customs/terrain-authored/`. Without `--toktx`, the KTX2 content
digests are explicit all-zero placeholders and `receipt.json` marks `contentHashesFinal: false`;
this keeps the template structurally testable without pretending missing KTX2 files exist.

## Test

```bash
python3 -m unittest discover \
  -s scripts/terrain-pbr-factory \
  -p 'test_*.py' -v
```

Exercise the optional real encoder and its cross-run byte determinism with:

```bash
TARKOVZERO_TEST_TOKTX=/absolute/path/to/toktx \
python3 -m unittest discover \
  -s scripts/terrain-pbr-factory \
  -p 'test_*.py' -v
```

Run the production high-frequency, color, roughness, repeat-correlation, and directionality gates
against retained V1/V2 evidence plus a fresh V2.1 output with:

```bash
TARKOVZERO_TERRAIN_V1_QA=/absolute/path/to/v1 \
TARKOVZERO_TERRAIN_V2_QA=/absolute/path/to/v2 \
TARKOVZERO_TERRAIN_V21_QA=/absolute/path/to/v2.1 \
python3 -m unittest discover \
  -s scripts/terrain-pbr-factory \
  -p 'test_*.py' -v
```
