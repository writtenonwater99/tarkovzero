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

## Fix pass 1

### Changed

- Woods: made `USEC CAMP` literal and unambiguous; replaced Cultist Village with `Sunken Village / Abandoned Village`; added major labels for Scav House, Sniper Rock, the mountain spine, Bridge V-Ex, Friendship / Scav Bridge, and Railway Bridge to Tarkov. Scav House now tags the correct footprint and gets a distinct warm wall/roof palette and gable treatment.
- Woods rock forms: large SVG ridge footprints now keep a low base and receive separated, footprint-contained summits/outcrops with deterministic varied heights. The generated set grows from 282 undifferentiated extrusions to 335 forms. Sniper Rock is a 6.2 m base with 11.2 m and 8.7 m forms; the mountain-spine base is 10 m with separated forms up to the evidenced 42 m rise.
- Reserve chess audit: retained the complete tarkov.dev set (White/Black Pawn, White/Black Bishop, White/Black Knight, White King, White Rook, White Queen) and removed the duplicate/generic label collisions. The shared landmarks are now `White Rook / Train Station` and `White Queen / Dome`; Black Pawn is a clear horizontal major label beside the helipad cluster.
- Reserve landmarks: replaced the misidentified central transport-plane props with a 23.5 m helipad, H markings, fuselage, tail boom, crossed main rotor, and tail rotor at the SVG `Chopper` location. Added a brighter radar pedestal/cap/mast so Dome carries a stronger hilltop silhouette. `Barracks` is now `Military Guard Barracks`.
- Reserve callouts: replaced E1/E2/warehouse-bunker generalities with Bunker Hermetic Door, Depot Hermetic Door, D-2, Command Bunker, Storage Bunker Tunnels, Dome Tunnels, K1–K6 storage labels, and the five named pawn/bishop/King hermetic connections.
- Reserve underground: the builder now uses the actual `Bunkers` SVG subpaths rather than seven coarse floor-extent rectangles. Selecting U hides the surface buildings, highlights the command/storage networks in amber with outlined `U` badges, and swaps surface labels for the underground callout set. `?floor=U` is accepted for a reproducible permalink/capture, and a saved/query floor is applied when 3D first initializes.
- Cross-map: no place-label size exceeds Customs' maximum (all three maps max at `size: 100`), and the shared `labels-major`/`labels-minor` sizes were not changed. Map/extract/chip icons remain pixel-sized with fixed pixel clamps. The existing 3D compass now also carries a literal `N`, and still rotates with the orbit on every map.

### Verified

- Audited Reserve against the stored exact tarkov.dev map entry/SVG and Wiki revision: all nine chess anchors are present; the Wiki's command-bunker/D-2/hermetic terminology is represented; Black Rook was not invented because tarkov.dev has no such Reserve label.
- `?map=woods&base=satellite&debug=roads`: all three cyan bridge decks remain on the satellite crossings and keep their documented names. The fitted overlay shows Bridge V-Ex and Railway Bridge to Tarkov; the focused Friendship capture proves the co-op/Scav crossing and road endpoint.
- `?map=reserve&base=satellite&debug=roads`: road classes and the limit remain aligned after the label/landmark work; the fitted view shows every chess anchor, both named hermetic doors, the helicopter label, Military Guard Barracks, and White Queen / Dome.
- Generated-data invariants: Reserve has nine helicopter/helipad pieces, four Dome radar pieces, ten real underground SVG subpaths grouped into command/storage networks, and finite output. Scav House resolves 2.6 m from its labelled building centroid and receives both colour and gable style. Woods' three label anchors resolve to the generated bridge midpoints (the railway label is shifted inward for edge safety).
- `npm run build` passes; Vite reports only the existing deck.gl chunk-size advisory. `node scripts/build-3d.mjs reserve`, `woods`, and `customs` pass deterministically; `git diff --check` passes.
- Customs regression gate remains byte-identical after the shared builder/runtime edits:

```text
a6aadd836a978892f5b342c3412c9a00ed36463e695f9800b6502e3671f90d26  public/data/customs-3d.json
7fa80f4f896998b0537c18d4da3cf6af8e19cb3be7127e0c1520f08547d9ebdf  public/data/customs.json
```

Selected captures:

- Woods: `scratch/fix-pass-1/woods-2d.png`, `woods-roads.png`, `woods-friendship-roads.png`, `woods-3d-rocks.png`
- Reserve: `scratch/fix-pass-1/reserve-2d.png`, `reserve-roads.png`, `reserve-3d-underground.png`

### Remains

1. SwiftShader still intermittently renders the heavier Reserve surface scene black; native headless GL does the same on this host. The successful Reserve U and Woods rock captures are extremely over-zoomed/blurry as warned in the playbook, so a real-GPU pass remains the final silhouette/antialias gate for the helicopter, Dome cap/mast, and ridge transitions.
2. Icons are screen-sized, and the new per-map hierarchy removes the reviewed worst label collisions, but count-based marker clustering and general automatic 2D place-label collision/edge avoidance remain separate lower-priority UI work.
3. The Reserve underground shape/labels are authoritative map geometry and terminology, but the detached Wiki-panel controls and D-2/Hermetic endpoints still warrant the in-game position trace already requested above.

## Fix pass 2

### Changed

- Marker levels: the community builder now emits a validated `level` (`surface`, `underground`, `rooftop`, or `upper`) for every extract/transit, lock, and switch. It combines audited Wiki-panel/name overrides with the named negative-Y underground extents in maps.json. Customs' affine is frozen to the checked-in calibration because the live Wiki image width shifted slightly; rebuilding therefore preserves every prior Customs coordinate.
- Reserve: D-2, Bunker Hermetic Door, and Depot Hermetic Door are `underground`; Cliff Descent and all other extracts/transits are `surface`. The D-2 power lever and sliding-door button are underground, while the Bunker Hermetic Door power lever remains correctly surface-level in its shack. RB-KPRL is marked `upper`. Woods has no underground extracts; its ZB markers remain surface entrances, matching the reviewed instruction.
- Marker rendering: the live tarkov.dev response is enriched with the generated community levels so production and snapshot fallback agree. Non-surface levels are appended to 2D popups/tooltips and 3D extract chips; find results list the level. Underground badges carry a dashed inner rule, amber down/stairs corner mark, and stronger highlight. U floor mode filters to underground markers, so Reserve's underground exits and controls remain available over the bunker network.
- Woods roads: a data-driven spatial reclassification splits the long SVG paths at `z=-250`; current-game northern and Scav Town runs are dirt while southern paved approaches remain paved. The road builder now supports auditable reclassification zones without changing bridge detection, and all three whitelisted bridge decks remain intact.
- Woods terrain/identity: two zoom-5 satellite traces add the Sawmill sawdust/log yard and Military Camp hardstand as Woods-only bare-earth polygons baked into the terrain texture, retaining normal terrain hillshade and mottle. Scav House was audited and intentionally omitted because its visible compound is grass. Sawmill walls/roofs and 14 log-stack props now use weathered timber tones.
- Map picker: the invisible native select is replaced by an obvious title button with chevron, pointer, hover/focus treatment, and a visible Customs / Reserve / Woods menu. The current map is checked and exposed through `menuitemradio` state. Arrow keys, Home/End, Enter/Space, Escape, Tab, outside click, and focus return are supported; `#map-switcher` and the existing title hooks remain stable.

### Verified

- `npm run build` passes; Vite reports only the existing deck.gl chunk-size advisory. All six community/3D builder runs pass deterministically, all generated JSON numbers are finite, every generated extract/lock/switch has a valid level, and `git diff --check` passes.
- Reserve's exact underground extract set is `D-2`, `Bunker Hermetic Door`, and `Depot Hermetic Door`; Woods' non-surface extract set is empty. The Woods output has two yard polygons, 12 dirt road runs, and no `main` road point north of the audited transition (apart from the shared 3 m split sample at the boundary).
- Customs semantic gate: deleting only `level` from the new extracts, locks, and switches produces a structure identical to the pre-pass `public/data/customs.json`. The old JSON hash `7fa80f4f896998b0537c18d4da3cf6af8e19cb3be7127e0c1520f08547d9ebdf` becomes:

```text
314265546709fc77d3b827da1d15881bd173571482f6b4e4fe2f5ecd4cd5e1d6  public/data/customs.json
a6aadd836a978892f5b342c3412c9a00ed36463e695f9800b6502e3671f90d26  public/data/customs-3d.json
```

  `customs-3d.json` is byte-identical to the pre-pass baseline.
- Browser keyboard verification opened the picker from `#map-switcher` with ArrowDown, moved focus from Reserve to Woods with the next ArrowDown, closed it with Escape, returned focus to the trigger, and retained Reserve as the checked menu item.
- SwiftShader rendered the focused 3D scenes successfully on this pass. Screenshots cover both 2D and 3D behavior:
  - Underground/UI: `scratch/fix-pass-2/reserve-2d-level-popup-find.png`, `reserve-3d-underground.png`, `reserve-3d-underground-all-extracts.png`, `map-picker-2d.png`, and `map-picker-3d.png`.
  - Woods: `scratch/fix-pass-2/woods-roads.png`, `woods-3d-sawmill.png`, `woods-3d-scav-town-dirt.png`, and `woods-3d-military-yard.png`.

No deploy, push, or commit was performed.
