# R1 asset pipeline — Stage 1 of RENDER-REALISM

**Branch:** `render-r1-assets` · **Scope:** assets + style contract only. The renderer
(`src/map3d.js`, `src/terrain.js`) is untouched; wiring these assets in is a later stage on
another branch.

This covers Stage 1 of [`RENDER-REALISM.md`](RENDER-REALISM.md): the processed `Ground106`
detail subset, the `Autumn Crossing` 1K environment reference, and the self-authored
noise/LUT. Nothing here changes map data, geometry, feature IDs, or picking.

## What shipped

| Asset | Path (under `public/assets/3d/`) | Bytes | What it is for |
|---|---|---:|---|
| `ground106-albedo` | `materials/ground106-albedo-512.png` | 498,642 | Terrain ground-detail base colour, tiled in world space |
| `ground106-normal` | `materials/ground106-normal-512.png` | 554,465 | Ground-detail normal (OpenGL +Y), surface frequency without displacement |
| `ground106-orm` | `materials/ground106-orm-512.png` | 445,101 | Packed R=AO, G=roughness, B=metalness(0) — one sampler, not three |
| `macro-noise` | `materials/macro-noise-256.png` | 149,744 | Seamless breakup tile: macro tint / wetness mask / detail / Bayer dither |
| `autumn-crossing-sky` | `environment/autumn-crossing-sky-256.png` | 64,046 | Tone-mapped equirect sky/ambient reference |
| `autumn-crossing-light` | `environment/autumn-crossing-light.json` | 2,372 | SH9 **radiance** (unconvolved), hemisphere colours, dominant-light estimate |
| `overcast-grade-lut` | `environment/overcast-grade-lut-16.png` | 3,470 | 16³ colour-grade LUT (256×16 strip) for the combined post pass |
| `autumn-crossing-gradient` | `environment/autumn-crossing-gradient.png` | 391 | 8×128 background gradient strip, zenith at top |
| `render-assets.json` | `render-assets.json` | 4,299 | Shipped asset index + attribution |
| **Total** | | **1,722,128 (1.64 MiB)** | **13.7% of the 12 MiB Stage 1 budget** |

Nothing was dropped for budget. The budget is enforced in the script, not just documented:
the run is aborted **before anything is written** if the shipped total would exceed it.

`autumn-crossing-light.json` ships `shRadiance`, not irradiance: it is the plain projection
`L_lm = ∫ L(ω) Y_lm(ω) dω`, with no Lambertian convolution. A renderer that wants an
irradiance environment must scale band *l* by `A_l = [π, 2π/3, π/4]` (Ramamoorthi/Hanrahan)
first — the factors differ per band, so skipping them gives an ambient that is both too dark
and too directional while still looking plausible. The file carries the factors and the
instruction in its `conventions.shConvolution` / `conventions.shLambertA` fields, and
`scripts/lib/skylight.mjs` exports `shRadianceToIrradiance()`.

### Sizes before and after

| Source | Downloaded | Shipped derivative | Reduction |
|---|---:|---:|---:|
| `Ground106_1K-PNG.zip` (11 files, 1024²) | 20,293,422 | 1,498,208 (3 maps at 512²) | 92.6% |
| `autumn_crossing_1k.hdr` (1024×512 HDR) | 1,889,442 | 66,407 (preview + gradient + SH JSON) | 96.5% |
| generated (no download) | 0 | 153,214 | — |
| **Total** | **22,182,864 (21.16 MiB)** | **1,722,128 (1.64 MiB)** | **92.2%** |

Source packs stay in the git-ignored cache and are never committed or served.

## Licences

Every source is CC0. Each licence page was fetched and checked on the date below;
`--verify-licenses` re-runs that check and fails the build if any page stops saying CC0.

| Asset | Author | Licence | Licence page | Verified | Used in Stage 1 |
|---|---|---|---|---|---|
| [Ground106](https://ambientcg.com/a/Ground106) | ambientCG (Lennart Demes) | CC0-1.0 | https://docs.ambientcg.com/license/ | 2026-08-29 | yes |
| [Autumn Crossing](https://polyhaven.com/a/autumn_crossing) | Greg Zaal (Poly Haven) | CC0-1.0 | https://polyhaven.com/license | 2026-08-29 | yes |
| macro-noise, grade LUT | TarkovZero | CC0-1.0 | — | — | yes |
| Quaternius | Quaternius | CC0-1.0 | https://quaternius.com/faq.html | 2026-08-29 | no (later stages) |
| Kenney | Kenney | CC0-1.0 | https://kenney.nl/support | 2026-08-29 | no (later stages) |

CC0 requires no attribution; the plan's hard licensing gate requires the record anyway, so
author/source/licence travel with every asset in both
`scripts/data/render-assets-manifest.json` and the shipped `render-assets.json`.

No BSG or extracted game asset entered the manifest. No Sketchfab item was used.

## How to re-run

```bash
npm run prepare-render-assets              # fetch (cached) + rebuild everything
node scripts/prepare-render-assets.mjs --check             # verify, write nothing
node scripts/prepare-render-assets.mjs --offline           # fail instead of downloading
node scripts/prepare-render-assets.mjs --verify-licenses   # re-check all four licence pages
node scripts/prepare-render-assets.mjs --ktx2-report        # measure the KTX2 alternative
npm run test:render-style                  # unit tests for the style contract
```

First run downloads ~21 MiB into `.cache/render-assets/` (git-ignored). Later runs are
offline and take a few seconds.

### Determinism

Two consecutive runs produce byte-identical output, so **`git status` is the regression
gate** — a clean tree after a rebuild means nothing drifted. Verified:

```
run 1 and run 2 sha256 over public/assets/3d/** + the manifest: identical
9129e2112174781456b3163d3427ae420896a4e02ae370c84a0c0bc080e42e2a  ground106-albedo-512.png
5ef97b01869452f10fc554a7392a3f7a72b2bd13624e52222615361f1300567d  ground106-normal-512.png
060e727f2ef4ccf09415546bd5c51cb6e5a942111898933f071e8e39b9afdc02  ground106-orm-512.png
9d84bc296cdabbfc83d7d44328976053dfc3a4d1ce9bda314d48847654236f37  autumn-crossing-sky-256.png
956bb6f0b3d9f057ed8256073643d9f6cb2bc161d27254a945d8d752bba54714  autumn-crossing-gradient.png
f827e9a05a33aa259e3d8960ec2bf988c4ae7a7344598143b5b84f05cabe7a6f  autumn-crossing-light.json
5143d269dc3ea7fd6383669ffe68ba75408e8ab0ee27bbe0449fc23fbe3983b1  macro-noise-256.png
b08c5d63a3405fb4ea91c49d941fd9cfbdc2953d8313c5b7069d3139167d0bc1  overcast-grade-lut-16.png
d077ecf749cd7b7207756584d800c8b59347f9907c535552139b22aa539e1bbb  render-assets.json
```

What makes that hold:

- **No dependencies.** `scripts/lib/imageio.mjs` implements the ZIP reader and the PNG and
  Radiance-HDR codecs against Node built-ins. Nothing was added to `package.json`, so there
  is no transitive encoder that can change output under us.
- **Pinned deflate.** Every PNG is written with one fixed level/strategy/windowBits/memLevel;
  the zlib version is recorded in the manifest's `toolchain` block.
- **No timestamps.** No `tIME` chunk, no `generatedAt` field, no mtime in any output.
- **Pinned sources.** Each download is checked against its recorded sha256; a changed
  upstream file fails the run with both hashes rather than silently reprocessing.
- **Integer-ratio resampling only.** Box filters refuse a non-integer ratio, so a resolution
  change can never silently become a different filter. Colour is averaged in linear light,
  normals are averaged then renormalised, and linear data (AO/roughness) is averaged as-is.
- **Floats are rounded** to 6 decimals before serialisation so no platform's float printing
  can leak into the JSON.

## Texture format: PNG now, KTX2 measured

The plan prefers KTX2/Basis. A pure-Node encoder does exist — `ktx2-encoder@0.6.0`, wasm,
no native build — and it was evaluated properly rather than assumed away. It works headless
and is deterministic (identical sha256 across repeated encodes). Measured on this exact
asset set with `--ktx2-report`:

| Map | PNG | KTX2 | Mode |
|---|---:|---:|---|
| albedo | 487.0 KiB | 71.6 KiB | ETC1S q190 |
| normal | 541.5 KiB | 322.9 KiB | UASTC + zstd, normal-map preset |
| ORM | 434.7 KiB | 65.9 KiB | ETC1S q190 |
| **total** | **1,463.1 KiB** | **460.3 KiB** | **69% smaller** |

**PNG ships anyway, deliberately.** Two reasons:

1. **Nothing in this checkout can decode KTX2 at runtime.** Consuming it needs
   `@loaders.gl/textures` (present only transitively) plus a Basis transcoder — a renderer
   change, and this branch is explicitly forbidden from touching the renderer. Shipping
   `.ktx2` now would ship bytes nothing can load and would pre-decide a renderer question
   that belongs to the Stage 1 renderer branch.
2. **The budget does not force the choice.** At 1.64 MiB we use 13.7% of 12 MiB. The
   ~1 MiB KTX2 saves is worth having, but not worth pre-empting a renderer decision for.

So the TODO is recorded with real numbers rather than a guess, in
`scripts/data/render-assets-manifest.json` under `toolchain.textureFormatTodo`, and
`--ktx2-report` reproduces the measurement on demand. **`ktx2-encoder` is not a declared
dependency** — the report path imports it dynamically and prints an install hint if absent.
That was a deliberate constraint here: this worktree's `node_modules` is a symlink to the
main worktree's, so installing into it would touch another worktree.

The KTX2 switch should happen in the same change that gives the renderer a transcoder, and
it should re-measure rather than trust this table — transcoded GPU residency is the number
that matters, and it is not the file size.

## Style contract

`src/render-style.js` is the `realistic`/`vector` contract from Part C, as data only: no
imports, no rendering, no deck.gl. It is consumed by the browser renderer (later), by this
pipeline (the grade LUT is generated from the same palette and key-light colour), and by
the tests — so the contract and the assets cannot drift apart.

It exports frozen `PALETTE`, `LIGHT`, `FOG`, `BACKGROUND`, `POST`, `MATERIALS` (30 materials
across terrain/water/building/vegetation/prop, each with both a `real` and a `vector`
variant), and the pure `styleFor(mode)`.

Two decisions worth flagging:

- **The key light is pinned** at azimuth 230°, elevation 21° — the midpoints of the plan's
  220–240° / 18–24° windows — so screenshots are deterministic. The HDRI's own dominant
  direction (79.5° elevation, near-overhead, as expected for an overcast sky) is recorded in
  `autumn-crossing-light.json` as a *reference*, and does not drive the key.
- **Fog** follows the plan exactly: `start = max(250 m, 0.12 D)`, with the coefficient
  solved so density hits 0.70 at `0.65 D`, times a `exp(-height / 120 m)` near-ground term.
  Measured playable diagonals: Customs 1193 m, Reserve 824 m, Woods 1963 m. The 250 m floor
  binds on all three — 0.12 D only takes over above ~2083 m — so the test also covers a
  synthetic 4000 m diagonal to exercise the other branch.

### Tests

`npm run test:render-style` — 20 tests, `node --test`, no test framework added. Covers both
modes existing and resolving, `styleFor` purity and deep-freezing, every material carrying
both variants with the same id set in both modes, every authored colour being valid hex,
real-variant numerics inside their contract ranges, the fog formula against all three
measured map diagonals plus the synthetic one, fog monotonicity and the height term, the key
light's unit-vector and azimuth convention, and the parameter flip (vector mode reaching
zero samplers).

## Independent corroboration worth keeping

The HDRI analysis and the hand-authored palette agree without being fitted to each other:
the derived upper-hemisphere colour is `#adb0bb` against the plan's authored sky `#a6aeac`.
The derived lower hemisphere is `#52473d` (warm forest floor) and the horizon is dark
(`#3f3926`) because Autumn Crossing is a forest path with an obstructed sky view. That is
why the background gradient in `BACKGROUND.realistic` stays authored from the palette and
the HDRI is used as the *ambient* reference — a forest-obstructed horizon is the wrong
background for a kilometre-wide map.

## Verification performed

- Fetcher run twice → byte-identical outputs (hashes above); `--check` passes against the
  committed tree.
- `--verify-licenses` → all four licence pages fetched, all still CC0.
- `npm run test:render-style` → 20/20 pass.
- `npm run build` → passes (968 modules, built in 35.8s). `public/` is copied verbatim by
  Vite; the shipped PNGs land in `dist/assets/3d/` with identical sha256, so no bundler
  transform touches them.
- Every decoded output was inspected as an image, not just hashed: the albedo is wet soil
  with leaf litter, the normal map is a valid tangent-space map, and the sky preview is the
  expected overcast autumn forest path.

## Not verified

- **Nothing has been rendered.** No deck.gl layer consumes these assets yet, so tiling
  quality at the map's real world-space UV scale, the fog constants against a real camera,
  and the grade LUT's effect on a real frame are all unconfirmed. The plan's Stage 1
  screenshot harness is renderer work and is not part of this branch.
- **512² is a judgement call, not a measurement.** The plan starts repeating terrain
  materials at 1K. 512 was chosen because PNG at 1K roughly quadruples to ~6 MiB and the
  detail map is tiled every 2–2.5 m, where 512 is ample. Re-evaluate when KTX2 lands: at
  that point 1K costs about what 512 costs today. To change it: set `detailSize` in the
  manifest **and rename the three `-512.png` output paths to match**. The resolution lives
  in the filename, so the run refuses to write until the two agree — `-512.png` holding
  1024² pixels used to pass silently, and `--check` afterwards still printed green.
- **GPU residency, draw calls and frame time** are untouched — the plan's Stage 1 estimates
  (+6–10 MiB VRAM, +0.4–1.1 ms) remain estimates until the renderer branch measures them.
