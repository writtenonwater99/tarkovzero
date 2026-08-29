# Reserve and Woods production report

## Outcome

Reserve and Woods are first-class TarkovZero maps selected with `?map=reserve` and `?map=woods`. Both have 2D satellite/vector maps, authoritative labels and raid facts, community marker snapshots, generated 3D structure, terrain, roads, crossings, limits, and map-specific landmark treatment. No deployment or push was performed.

The site is now registry-driven rather than Customs-driven. The header title is the native map selector; changing it preserves the current query options and clears the old map-coordinate hash. Data, debug roads, labels, floors, live-position filtering, and 3D loading all select the current map. The generalized builders accept `customs`, `reserve`, or `woods` and preserve an existing `builtAt` unless passed `--stamp`.

## Customs regression gate

The generalized 3D builder was run for Customs after every shared-pipeline change. Both checked-in outputs remain byte-for-byte identical to the pre-work baseline:

```text
a6aadd836a978892f5b342c3412c9a00ed36463e695f9800b6502e3671f90d26  public/data/customs-3d.json
7fa80f4f896998b0537c18d4da3cf6af8e19cb3be7127e0c1520f08547d9ebdf  public/data/customs.json
```

The before/after Customs 2D captures have the same layout and visible styling. ImageMagick reports 2,321 changed pixel-equivalents out of 1,260,000 (0.184%, normalized RMSE 0.0073), attributable to independent Chromium font/tile rasterization; the generated data regression is exact.

## Reserve built

- Inputs: exact tarkov.dev maps entry/SVG, current SPT `RezervBase` base database, and Wiki revision 346590 are stored under `scripts/data/reserve/`.
- Markers: 14 merged extracts/transits, 196 SPT spawns, Glukhar, five calibrated surface locks, eight stationary guns, and three bunker controls.
- Calibration: 13 wiki-surface/clustered-SPT PMC correspondences; median residual 1.3 m, 12/13 residuals at 0.6–2.2 m, one 6.6 m outlier. Detached-panel D-2/Hermetic points use explicit game-coordinate overrides.
- Geometry: 56 buildings, 16 multi-floor footprints, 32 authoritative floor boxes, five underground volumes, 19 clipped road segments, six rail paths, 28 cut fence segments, 11 canopy/tree polygons, and no invented water or bridges.
- Terrain: 69×64 true-scale 10 m grid from 166 filtered surface points, range -7.1..20.8 m. The audited `Terrains` outer ring includes the Dome spur; `Fence_ext` was proven too short in the satellite overlay.
- Identity: floor heights are relative to sampled local terrain, Dome reaches its authoritative four floors and carries a restrained radar/pedestal cue, key chess buildings are named/coloured, and 68 in-limit rock/cliff masses use 1.6–16 m footprint-scaled heights.
- Props: 38 zoom-5 traces cover the tarmac aircraft/service vehicles, White Rook rail stock, train/K/shipping-yard clutter, and Dome equipment.

## Woods built

- Inputs: exact tarkov.dev maps entry/SVG, current SPT `Woods` base database, and Wiki revision 355184 are stored under `scripts/data/woods/`.
- Markers: 22 merged extracts/transits, 336 SPT spawns, Partisan/Goons/Shturman/Cultist Priest, five surface locks, and two stationary guns.
- Calibration: six mutual-nearest wiki/SPT PMC correspondences; residuals 0.8–4.7 m (median 1.75 m).
- Geometry: 121 structures including nine generated pylons, 27 clipped road segments, one rail route, 33 fence groups after clipping/gates, 11 water polygons, four minefield polygons, and 282 rock masses.
- Crossings: an explicit whitelist emits only Bridge V-Ex, Friendship Bridge, and Railway Bridge to Tarkov. All three were found as real SVG road/rail-water intersections and verified in the satellite debug overlay.
- Terrain: 150×145 true-scale 10 m grid from 326 surface points, range -19.4..27.4 m. `ZoneBigRocks`/`ZoneHighRocks` samples are excluded from soil and transferred to containing rock masses; the tallest rock rises 42 m from its local base to reproduce the SPT 61.46 m top sample.
- Forest/identity: 137 sparse broad canopy clusters compensate for the SVG's missing tree group without creating a tree per satellite dot. Camps/towns/sawmills use map-specific colours and gable treatment; power pylons support the SVG cable route.
- Props: two exact SVG aircraft shapes and four exact pier shapes plus 38 zoom-5 traces for Military/USEC camps, sawmill log stacks/vehicles, convoy wrecks, and the Scav Bunker antenna.

## Verification performed

- `npm run build` passes. Vite only reports the existing deck.gl chunk-size advisory.
- `node scripts/build-community-data.mjs reserve woods` was exercised one key at a time; each fit prints its residuals and produces finite JSON.
- `node scripts/build-3d.mjs customs`, `reserve`, and `woods` passes; all output numbers are finite and repeat deterministically while preserving `builtAt`.
- `sha256sum -c /tmp/tarkovzero-customs-baseline.sha256` passes after the final shared builder/runtime changes.
- `git diff --check` passes.
- 2D fit, labels, default filters, marker alignment, limits, and satellite road overlays were visually inspected for both maps.
- Reserve's outer limit was iterated after the first overlay exposed that `Fence_ext` omitted Dome.
- Woods' only three automatic crossing candidates matched the three documented whitelist crossings exactly.

Selected captures:

- Customs baseline: `scratch/baseline/customs-2d.png`, `scratch/baseline/customs-3d.png`
- Customs after refactor: `scratch/multimap/customs-2d-final.png`
- Reserve: `scratch/reserve/reserve-2d.png`, `scratch/reserve/roads-overlay-final.png`, `scratch/reserve/reserve-3d.png`
- Woods: `scratch/woods/woods-2d-final.png`, `scratch/woods/roads-overlay.png`, `scratch/woods/woods-3d.png`
- Zoom-5 trace evidence: `scratch/reserve/reference/` and `scratch/woods/reference/`

The SwiftShader/headless environment renders the deck.gl canvas black for Customs, Reserve, and Woods alike. The 3D screenshots therefore prove route/UI/floor initialization but cannot be used to judge scene lighting or silhouettes. Generated geometry, terrain samples, draping inputs, layer construction, and data invariants were verified structurally; a real-GPU browser remains the final visual gate.

## Known gaps and playtest questions

1. Reserve's Wiki sheet has detached floor/underground panels. Five surface locks are calibrated; uncertain room-panel locks are omitted rather than published at false surface coordinates. Should those be exposed only while their matching floor is selected in a future panel-specific calibration pass?
2. Please confirm D-2, Depot Hermetic Door, Bunker Hermetic Door, and the two D-2 controls against an in-game position trace. Their panel symbols cannot share the surface affine.
3. Please confirm Woods' playable endpoints at Bridge V-Ex, Friendship Bridge, and Railway Bridge to Tarkov, especially how much deck should remain before the mine/sniper void. No other water crossing is currently modeled.
4. Woods `Roads` follows the SVG's tarmac classification and aligns with the satellite. Are any northern/Scav Town segments tactically dirt rather than paved in the current game?
5. A real-GPU pass should inspect Dome/White Pawn floor heights, Reserve's mountain skirt, the Woods 61.5 m evidenced rock top, canopy density, camp tents, and all three bridge ramps. SwiftShader cannot render these scenes here.
6. The radar is represented with deck.gl primitives as a cylindrical equipment cue rather than a sphere; this respects the no-custom-shader constraint but is an intentionally simplified silhouette.

## Repository-state limitation

Commits could not be created in this worktree. `.git` points to `/home/zeq/tarkovzero/.git/worktrees/tarkovzero-codex`, and that shared metadata path is read-only in the current managed filesystem; Git fails while creating `index.lock`. All requested files and screenshots are present in the workspace, no push was attempted, and no existing user change was discarded. Once the Git metadata is writable, the intended phase commits are: plans, multi-map refactor, Reserve, Woods, and this final report.
