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

## Fix pass 8 — water done right at every relief

### Changed

- The failure was the water layer, not the relief transform: every water vertex was sampled through `ringG`, so the polygon copied the terrain's slope, climbed both banks, and intersected the ground more severely as relief increased. Generated water is now structured data with an outer ring, optional island holes, unexaggerated `level`, `depth`, bank width, and an optional linear flow gradient. `src/map3d.js` renders that plane directly at `level × relief`; the 0.5 m shoreline follows the same plane 4 cm above it instead of being separately draped.
- The builder samples the fitted 5 m terrain inside and along each water body. Horizontal Woods lakes/ponds use the 10th-percentile sample height (outline-minimum fallback), a 2.5 m bed, and a 5.5 m soft outer bank. Customs' three SVG river reaches share one continuous north–south plane because their twelve binned low-percentile samples show a consistent trend (`R² 0.75`); the raw 1.63% terrain slope is capped to a gentle 0.4% flow grade. Stored reach-centre levels are `-0.10`, `0.39`, and `0.74 m`, with a 1.2 m bed and 5 m banks.
- Reversed nested SVG rings are preserved as holes. The small Customs island inside the main river therefore remains dry, is not carved, and contributes its own shoreline ring.
- `src/water.js` is the shared geometry/height authority. It carves the serialized field, reapplies the basin after runtime Gaussian conditioning, and uses indexed continuous caps so bicubic interpolation cannot overshoot through an exact shoreline. The cap never raises ground: water interiors are at most `level − depth`, while land transitions smoothly from the original height to the bank over the configured 4–6 m shoulder.
- Bridge bases now use the higher of current terrain and current water level. Decks and piers therefore remain valid over a carved bed at 1×/2×/3×. The road-cut pass still leaves no at-grade point under a deck. The shallow Customs river path, which some SVG revisions stop at the banks, is retained explicitly at its existing 0.4 m ford height; Main Bridge and Junk Bridge retain their raised deck/rail/pier treatment.

### Verified

- Rebuilt Customs, Woods, and Reserve deterministically while preserving `builtAt`. All generated values are finite. Customs emits three river bodies/four shoreline rings (one island hole), three crossings, and four piers. Woods emits eleven horizontal water bodies/shorelines, three bridges, and ten piers. Reserve's authoritative SVG has no water, so it correctly emits zero water bodies, shores, bridges, or piers at every relief rather than inventing any.
- A numerical runtime-equivalent gate applies Gaussian conditioning, the serialized carve, bicubic sampling, and the continuous shoreline cap. Every sampled Customs interior remains at least 1.2 m below its plane and every Woods interior at least 2.5 m below; no tested shoreline vertex protrudes above water. No output road point lies in water. Minimum Customs deck clearance is relief-invariant: Main Bridge `5.68 m`, Junk Bridge `1.52 m`, and the ford `0.34 m`.
- A persistent software-GL/CDP browser captured Customs Main/Junk Bridge, the ford, and the river ends at 1×/2×/3×; the river stays in its carved banks and retains its island. The same matrix covers the Woods Sawmill lake and USEC/Ponds cluster; every lake/pond remains horizontal while the surrounding relief changes. Reserve wide captures at all three reliefs confirm zero water/shore layers. Source and rendered-layer counts are invariant across relief for every map.
- `npm run build` passes with only Vite's existing deck.gl chunk-size advisory. `node --check` passes for the builder and edited runtime modules; a full Woods build now completes in about nine seconds on this host after indexed ring/edge acceleration. `git diff --check` passes.
- Captures are in `scratch/fix-pass-8/`: `customs-{main-junk,ford,river-ends}-relief-{1,2,3}x.png`, `woods-{sawmill-lake,usec-ponds}-relief-{1,2,3}x.png`, `reserve-wide-relief-{1,2,3}x.png`, plus `customs-water-contact-sheet.png` and `woods-water-contact-sheet.png`.
- Final generated 3D hashes are:

```text
a658ad62b731faec456407fabde3304f02c2d384668c2a8cdae6aaf38e3f1ed2  public/data/customs-3d.json
f46095b76d9cc97539669f63b2f25427bf22fead02d122de370d4121c7a40bcc  public/data/reserve-3d.json
d3d658decb230863a56d4e6eb49acf2ff292f56235c586a490591bd691b048d3  public/data/woods-3d.json
```

No deploy, push, or commit was performed.

## Fix pass 3 — terrain realism

### Changed

- Tree masks no longer render as raised green slabs with a lighter inset top. The original SVG/procedural polygons are now a low-alpha understory tint, while deterministic points inside them produce one crown layer of varied 6–12 m high, 1.5–4 m radius hex crowns in three green tones. Output counts are Customs 4,082 crowns / 37 understory masks, Reserve 412 / 11, and Woods 6,001 / 138. Customs' reviewed “green puzzle pieces” are gone.
- Rocks remain mapped geometry but now have deterministic height and four-colour variation. Customs' 111 previously uniform 1.2 m forms now range 0.8–4.0 m; Reserve and Woods retain their evidence/area-derived mass heights and gain tonal variation.
- Real elevation evidence was recovered from the official SPT 4.1.2 (40743) release archive (`https://spt-releases.modd.in/SPT-4.1.2-40743-cf04a11.7z`). Compact checked-in loot positions total 1,820 Customs, 4,148 Reserve, and 1,720 Woods. GitHub raw and jsDelivr still return only the Git LFS pointer, GitHub's media URL returns 404, and the former SPT Gitea endpoint is retired/redirected.
- `scripts/ingest-elevation.mjs <map> <file...>` merges those compact points, each map's SPT ground spawns, and companion survey JSONL. It validates the map, prefers survey over spawn over loot, takes a median within each 2 m cell, and emits deterministic `scripts/data/<map>/elevation-samples.json` files.
- `companion/companion.mjs` now appends every parsed screenshot position as `{map,x,y,z,t}` even when the relay is offline. Logging defaults to `elevation-<map>.jsonl` next to `companion.json`; `--elevation-log <file>` overrides it and `--elevation-log off` disables it. No relay code or other companion file was changed.
- Terrain is now a true-scale 5 m grid. Loose loot inside mapped buildings/rocks/underground is discarded; remaining rooftop and below-surface evidence more than ±2.5 m from its local robust median is rejected. A source-weighted local/broad IDW fit carries dense real evidence, with authored terrain features blended only where confidence is low. The runtime now applies only one ~5 m conditioning pass rather than blurring the source by ~22 m.
- Customs validates the data path: at the requested Powerline view the surface changes 4.85→15.65 m, and at the actual 22 m pylon base it changes 4.45→15.25 m. The dense 15–17 m loose-loot cluster therefore carries the tower on its real hill. Sniper Hill remains 8.36 m through sparse-data fallback pending a survey trace.
- Relief uses a stronger two-light bake, dry/rocky slope tint, directional lee-side darkening, and quieter 2 m / 10 m contours without changing geometry scale. Roads and paths continue to sample the same terrain surface. Buildings sample their centroid, vertices, and edge midpoints; a variable-depth plinth spans the local min/max ground so small slopes no longer leave a floating corner.

### Elevation datasets

After 2 m ingest dedupe, the source files contain 1,227 Customs, 1,903 Reserve, and 1,215 Woods cells. The robust builder retains 470 / 407 / 798 ground cells respectively. Full source provenance, filtering, and the survey workflow are in `docs/plans/ELEVATION.md`.

For the requested Customs survey run: bind EFT Make Screenshot to F11, then from `companion/` run `node companion.mjs --map customs --auto 1000`; walk ordinary ground across the base and crest of Powerline Tower, Sniper Hill, and the west/Crossroads rise. Stop with Ctrl+C, then merge with `node scripts/ingest-elevation.mjs customs companion/elevation-customs.jsonl` and rebuild. Avoid roofs, stairs, rocks, jumps, and underground routes.

### Verified

- `npm run build` passes; Vite reports only the existing deck.gl chunk-size advisory. `node --check` passes for the companion and ingestion script.
- All three 3D builders pass from the checked-in elevation inputs. Generated numbers are finite; every map has a 5 m grid, crown-schema trees, understory masks, and coloured positive-height rocks.
- A synthetic survey test merged two Customs frames into one y=15.8 survey cell, let survey priority win, rejected a Reserve-tagged frame, then restored the no-survey checked-in dataset and regenerated Customs.
- New deterministic data hashes:

```text
17a26028c1f8c09118a6cadf257284fb3a0b625d67daf167a73c56b30698ed0e  public/data/customs-3d.json
6a6d7107b9409fe0b91d09f596b66aecf9c43cea9aac6c04bc7226c8ed009411  public/data/reserve-3d.json
0223dda4aadd01f300113b14b1bbda5903c60fc0c992e8657d1b6f6f72043398  public/data/woods-3d.json
314265546709fc77d3b827da1d15881bd173571482f6b4e4fe2f5ecd4cd5e1d6  public/data/customs.json
```

- Required rendered captures are in `scratch/fix-pass-3/`: `customs-powerline.png` (`#2.6/497/110`), `customs-sniper-hill.png` (`#2.6/110/85`), `customs-west-hill.png` (`#2.2/-320/-80`), plus `customs-wide.png`, `reserve-wide.png`, and `woods-wide.png`.
- The prior Customs baseline is a black SwiftShader frame; the new CDP captures rendered successfully and can be compared structurally against the checked-in pre-pass data (10 m→5 m grid, 37 raised masks→4,082 crowns, Powerline pylon base 4.45→15.25 m). Software GL remains over-zoomed/blurry—especially the Woods wide fit—so the user's real GPU remains the sharpness/density gate.

No deploy, push, or commit was performed.

## Fix pass 4 — trees that don't fight the map

### Changed

- Tree generation is now deliberately open rather than canopy-filling. Customs drops from 4,082 to 1,327 crowns, Reserve from 412 to 113, and Woods from 6,001 to 2,166. Woods uses the lower open-forest density; deterministic edge-depth weighting makes the canopy polygon cores 2.38–3.48× denser than their edge bands.
- Crowns are 4.6–9.0 m tall (map means 6.70–6.84 m) and 1.4–3.2 m radius. Their three opaque RGB colours are muted, low-saturation greens close to the ground palette. Runtime crowns use ten-sided silhouettes, no stroke/outline, and a high-ambient, low-diffuse, zero-shininess material for soft shading without transparency.
- Clearance now uses exact point-to-segment distance instead of checking only sampled road vertices. The complete crown extent stays at least 3 m from every road edge and building footprint, including a generation margin for one-decimal JSON rounding. The measured final minima are 3.22 m from buildings and 3.27 m from roads.
- The View block now has independent `Trees` and `Rocks` ON/OFF segmented controls. Both default ON, persist as `tz:trees` / `tz:rocks`, and keep all pre-existing element and deck layer IDs unchanged. `?trees=0` and the parallel `?rocks=0` override saved state on load.
- Tree visibility controls both existing 3D layers (`trees` and `understory`) and the 2D vector Map base's `.trees` fills. Rock visibility controls the existing `rocks` 3D layer and the vector base's `.rock` fills. The vector tree colour is also changed from saturated light green to a quiet grey-green.

### Verified

- `node scripts/build-3d.mjs customs`, `reserve`, and `woods` pass. All output is finite, all crowns use opaque three-channel colours, and `builtAt` is preserved. Comparing against `HEAD` shows that `trees` is the only changed top-level key in each generated 3D document.
- A post-rounding geometry audit found no crown-clearance violations. Core/edge crown-density ratios are Customs 2.38×, Reserve 3.48×, and Woods 2.55×.
- `npm run build` passes; Vite reports only the existing deck.gl chunk-size advisory. `node --check` passes for the edited JavaScript and `git diff --check` passes.
- A live Chromium control test clicked both nature controls Off over the vector base, observed both SVG groups at `display:none`, read `false` from both localStorage keys, reloaded, and observed the Off controls and body state restored. A separate `?trees=0&rocks=0` load selected both Off controls without mutating saved state.
- Rendered captures are in `scratch/fix-pass-4/`: `customs-wide.png`, `customs-sniper-hill.png` (`#2.6/110/85`), and `woods-sawmill.png` (`#2.6/10/-3`). `customs-trees-off.png` additionally verifies the 3D query/toggle path. Labels, pings, and markers remain in their existing overlay layers above nature geometry.

Deterministic data hashes:

```text
141cea6095eb601bcd0a9722c36a868cdd23f0b408e1ebd4f83e87517394df57  public/data/customs-3d.json
a78d49717c94f3a4f49759205be4a06c9213d0bbff72b8541229b66c220b2c58  public/data/reserve-3d.json
f48e2bfc11daaf52e59d0368e6e98e09967ae0d577a0a5c5136efa73bdf74ed1  public/data/woods-3d.json
```

No deploy, push, or commit was performed.

## Fix pass 5 — readable relief and volumetric trees

### Changed

- The 3D View now has a `Relief` 1× / 2× / 3× segmented control. It defaults to 2×, persists as `tz:relief`, and accepts a non-mutating `?relief=1|2|3` query override. A direct 3D hash is handed to OrbitView before Leaflet can clamp a wide zoom, and the 3D camera now writes its own `#zoom/x/z` permalink values.
- `buildTerrain(data, relief)` applies the selected factor exactly once: to the conditioned grid that becomes the exported bicubic `H(x,z)`. The fine height raster, baked hillshade/contours, mesh vertices/normals, mesh skirt, map cliff top, and adaptive void depth all derive from that scaled field. Rebuilding relief also recomputes building bases/plinths, props, structure details, floors, roads, fences, bridges, water, rocks, labels, markers, player drop-lines, and every other draped layer through the same `H`/`Pg` path. Object heights are unchanged.
- Live player arrows, names, and drop-line tops now use `max(realY, H)` so an exaggerated surface cannot cover them. Player floor classification still compares the real game Y with `H / relief`; at 2× or 3× its tooltip explicitly says the ground height is visually exaggerated.
- The old extruded ten-sided crown prisms are gone. `src/trees.js` builds three reusable luma `Geometry` meshes and renders them with instanced `SimpleMeshLayer`s: dark 0.3–0.5 m trunks, stacked double-cone conifers, and faceted ellipsoid broadleaf crowns. The shared scene light now reveals volume; three muted green tones plus deterministic type, scale/aspect, rotation, trunk size, and LOD selection prevent cloned silhouettes.
- Generated conifers are 8–12 m tall and broadleaf trees are 6–9 m tall. Customs density rises from 1,327 to 2,348 trees; Reserve has 112 and Woods 2,166. At far zoom the deterministic LOD keeps 1,172 Customs trees (49.9%); closer views draw the full population. The existing Trees control hides the understory, trunks, and both canopy meshes together.

### Verified

- `node scripts/build-3d.mjs customs`, `reserve`, and `woods` pass and preserve `builtAt`. `npm run build` passes with only the existing deck.gl chunk-size advisory; `node --check` passes for every edited JavaScript module and builder; `git diff --check` passes.
- A post-rounding audit found zero invalid tree dimensions/types and exactly three opaque tones per map. Minimum crown-edge clearance is 3.19 m from roads / 3.20 m from buildings on Customs, 3.81 / 3.27 m on Reserve, and 3.93 / 3.15 m on Woods. Customs contains 1,169 conifers and 1,179 broadleaf trees.
- Chromium verified the live relief rebuild on all three maps. With a saved 3× preference, `?relief=1` selected 1× while leaving `tz:relief` at 3; reloading without the query restored 3×. Clicking Trees Off set `tz:trees=false` and visibly removed the understory plus every instanced trunk/canopy; the control was returned to On afterward.
- Eighteen 1400×900 captures in `scratch/fix-pass-5/` compare 1×, 2×, and 3× for Customs wide (`#1.3/160/-30`), Powerline Tower (`#2.6/497/110`), Sniper Hill (`#2.6/110/85`), Dorms (`#3/200/150`), Reserve Dome (`#2.6/-8/183`), and Woods sawmill (`#2.6/10/-3`). The corrected wide frame reports a 200 m scale, confirming the unclamped 1.3 camera. The comparisons show 2× as the balanced default: Powerline, Sniper Ridge, the west rise, and Dome read as geometry; 3× remains usable, and Woods' tall rock forms remain fixed-height rather than being tripled.
- `scratch/fix-pass-5/customs-powerline-trees-off.png` is the separate nature-toggle proof. All comparison images have distinct hashes; no relief level is a duplicate frame.

Deterministic data hashes:

```text
c77f2495de7b5895c4c9eea15078d173ed771348383db8b791e507402f36294d  public/data/customs-3d.json
f46095b76d9cc97539669f63b2f25427bf22fead02d122de370d4121c7a40bcc  public/data/reserve-3d.json
bb38391bb7f06130cfa64391d460316da7dbd88974539cdc3bfa3522829f836a  public/data/woods-3d.json
```

No deploy, push, or commit was performed.

## Fix pass 6 — toggleable loot, stashes, and objects

### Changed

- The community builder now emits Wiki `containers` with `type`, `name`, calibrated `position`, and `level` for the requested stash, weapon-box, crate/bag, safe/cash, medical/ammo/tool, dead-body, key-spawn, and marked-loose-loot categories. Cleaned Wiki descriptions are retained as optional `note` text for the shared popup. Explicit floor wording wins over footprint inference; real-Y SPT points are checked against the underground height ranges.
- Reserve and Woods reuse their existing surface-sheet calibration guards for the new categories. This excludes the detached Reserve floor/bunker panels and the Woods ZB-014 inset, whose pixels do not share the surface affine.
- The checked-in SPT loose-loot samples are clipped to each map's bounds and deterministically thinned to points more than 6 m apart after one-decimal output rounding, with a hard 1,500-point cap. The emitted dense subsets are 333 Customs, 462 Reserve, and 307 Woods points.
- The Objects group has eight new counted `data-kind` rows: Stashes, Weapon boxes, Crates & bags, Safes & cash, Med & ammo, Key spawns, Dead bodies, and Loose loot (dense). Stashes default ON; the other seven default OFF. Zero-count rows remain visible, so Reserve truthfully shows zero stashes rather than hiding the control.
- The live tarkov.dev response is enriched with the snapshot's community-only containers, just like switches and marker levels. Find indexes named stashes and turns the stash layer on before flying to a selected result. The same classified marker objects feed Leaflet popups and deck.gl tooltips.
- Eight muted Game Icons chips were added from upstream commit `82d948812bfe3f269ef8f731dcdb07b08160edc4`: Lorc `locked-chest`; sbed `ammo-box`, `medical-pack`, `key`, and `death-skull`; Delapouite `cargo-crate`, `strongbox`, and `two-coins`. The existing CC BY 3.0 source comment and visible game-icons.net footer credit remain. Existing `markers-chips` rendering keeps every new 3D object icon flat on the ground.

Sidebar counts, in row order (Stashes / Weapon boxes / Crates & bags / Safes & cash / Med & ammo / Key spawns / Dead bodies / Loose loot):

```text
Customs  65 / 59 / 166 / 36 / 38 / 25 / 11 / 333  (733 objects)
Reserve   0 / 29 /  44 / 16 / 19 /  2 /  3 / 462  (575 objects)
Woods    45 / 40 / 145 /  7 / 53 /  6 / 15 / 307  (618 objects)
```

### Verified

- All three community builders pass repeatedly and preserve `builtAt`. Every container has finite coordinates and a valid `surface`, `underground`, `upper`, or `rooftop` level. Final SPT minimum horizontal separations are 6.003 m Customs, 6.001 m Reserve, and 6.001 m Woods; all subsets are below the 1,500 cap.
- `npm run build` passes with only the existing deck.gl chunk-size advisory. `node --check` passes for the edited modules and builder; `git diff --check` passes. All eight stored Game Icons paths were compared byte-for-byte with their named SVG path at the upstream commit.
- A clean Chromium profile selected Stashes and left all seven other new rows off. All three maps displayed the sidebar counts above. Find returned Ground Cache stash results; selecting a marker enables its layer and flies to it. The popup capture shows `Unknown Key`, `Key spawn · surface`, and the cleaned multiline Wiki note `Inside the Dead Scav`.
- 2D captures: `scratch/fix-pass-6/customs-2d-stashes.png`, `reserve-2d-counts.png`, `woods-2d-stashes.png`, and `customs-2d-key-popup.png`.
- 3D captures: `scratch/fix-pass-6/customs-3d-stashes.png`, `reserve-3d-weapon-boxes.png`, and `woods-3d-stashes.png`. These visibly show the new chips draped flat over the rendered terrain on every map.

Final data hashes:

```text
8027b339b3c99bdda988dd2ccfed813d89caeaa06211a41a35aa33d308fef393  public/data/customs.json
c77f2495de7b5895c4c9eea15078d173ed771348383db8b791e507402f36294d  public/data/customs-3d.json
1c9882595d7e74948f8238ea150f14b9f9c4716168976f739ca75ac6ba5ac597  public/data/reserve.json
9e184a26860983f135273f7b705a6a2024626d279887e8795810982ec9e1a73b  public/data/woods.json
```

`customs-3d.json` is byte-identical to its pre-pass baseline. `customs.json` changed from `314265546709fc77d3b827da1d15881bd173571482f6b4e4fe2f5ecd4cd5e1d6` to the hash above solely through the new `containers` array.

No deploy, push, or commit was performed.

## Fix pass 7 — relief-complete surfaces, limit wall, and brighter map theme

### Changed

- Relief placement now has one authority at render time: the current terrain build's exaggerated bicubic `H(x,z)`. A relief rebuild replaces that sampler, advances a height epoch, and reconstructs building bases/plinths, rigid scene assemblies, building detail parts, prop parts, fences, bridges/piers, water/shore, rocks, trees, markers/chips, extract names, place-name pings, player trails/drop-lines, and the underground overlays from it. Rigid footprints sample their centroid, vertices, and edge midpoints and sit on the highest result; their plinth fills the downhill side. Long wall/pipe props remain vertex-draped. No prop or structure base cached at 1× survives a relief change.
- Extract/spawn badges and extract names sit `H + 0.7 m`; flat marker chips and loose-loot chips sit `H + 0.65 m`; place-name ping bases begin at `H + 0.65–0.7 m`; player trails sit at `H + 0.6 m`. This removes slope z-fighting at 3×. Extract-name decluttering projects against `H / relief`, and tree LOD reads camera zoom only, so relief cannot thin either population.
- The segmented cliff boxes, random colours, top band, and textured/lit mesh skirt are gone. `src/terrain.js` builds one separate `SimpleMeshLayer` whose welded top vertices are the terrain mesh's exact exposed edge vertices and whose bottom vertices meet the shared void plane. It is unlit, non-shadowing, double-sided, and uniformly `[12,14,13]`; the void floor remains.
- Pavement plus every at-grade paved road, highway, dirt road, wheel track, and railway is now painted into the terrain's one baked canvas in map metres. Paved roads retain casing/fill and highway dashes; dirt has its own casing/fill; tracks have twin dashed ruts; rail has sleepers and two rails. The former `pavement`, `rail`, `sleepers`, `road-edges`, `roads`, `tracks`, and `road-centre` deck layers were removed. Bridges, bridge rails/piers, fences, and power cables remain real 3D geometry.
- The coordinated field palette is approximately 15–20% lighter: brighter sage/olive ground, lighter roads and pavement, brighter blue water, lighter warm concrete, warmer roofs, clearer rocks/trees/trunks, and lifted authored prop/building colours. The vector `Map` base uses the same paper/sage/mineral family while the application chrome stays dark; its geometry and feature inventory are unchanged.
- Relief now defaults to 3× in the static control, persisted preference fallback, 3D view construction, terrain builder, and sampler fallback. `?relief=1|2|3` remains a non-mutating override. The map build playbook records the new default and flat limit skirt.

### Verified

- `npm run build` passes with only Vite's existing deck.gl chunk-size advisory. `node --check` passes for `src/terrain.js`, `src/map3d.js`, `src/trees.js`, `src/main.js`, and `src/roadmap.js`; `git diff --check` passes. A stale-layer grep finds none of the seven removed at-grade layer IDs and no `cliffStrips` implementation.
- A clean browser profile with no `tz:relief` selects 3× without creating a stored value. With stored 3×, `?relief=1` selects 1× while leaving the stored value at 3; the next URL without `relief` returns to 3×.
- A CDP inventory gate captured the same view at 1× and 3× and compared every source and rendered deck-layer count. All six requested pairs are exact. Customs keeps 71 buildings, 85 props, 76 fences, two bridges, 111 rocks, 2,348 trees, and 181 markers; its close views keep four bridge piers, while the wide view keeps the same deterministic 1,172-tree far LOD at both reliefs. Reserve keeps 56 / 44 / 28 / 68 / 112 / 81 buildings/props/fences/rocks/trees/markers. Woods keeps 121 / 44 / 33 / 335 / 2,166 / 191 and ten bridge piers.
- Mesh topology is invariant across relief: Customs has 93,408 vertices / 105,354 triangles / 1,518 skirt edges, Reserve 50,640 / 54,318 / 892, and Woods 313,500 / 447,966 / 2,544. Only height changes: Customs `-7.44..15.60` to `-22.32..46.80 m`, Reserve `-6.94..21.41` to `-20.83..64.24 m`, and Woods `-20.88..27.71` to `-62.65..83.12 m`.
- The final 1400×757 pairs are `scratch/fix-pass-7/customs-wide-relief-{1x,3x}.png`, `customs-powerline-relief-{1x,3x}.png`, `customs-warehouse-4-relief-{1x,3x}.png`, `customs-main-bridge-relief-{1x,3x}.png`, `reserve-dome-relief-{1x,3x}.png`, and `woods-sawmill-relief-{1x,3x}.png`. `relief-verification-contact-sheet.png` presents all twelve in one grid. The exact-view palette/edge comparison is `customs-wide-before-after.png` (Fix pass 5 versus Fix pass 7), and `customs-2d-map-theme-after.png` records the vector-base palette.
- No generated map data changed. Final hashes remain:

```text
8027b339b3c99bdda988dd2ccfed813d89caeaa06211a41a35aa33d308fef393  public/data/customs.json
c77f2495de7b5895c4c9eea15078d173ed771348383db8b791e507402f36294d  public/data/customs-3d.json
1c9882595d7e74948f8238ea150f14b9f9c4716168976f739ca75ac6ba5ac597  public/data/reserve.json
f46095b76d9cc97539669f63b2f25427bf22fead02d122de370d4121c7a40bcc  public/data/reserve-3d.json
9e184a26860983f135273f7b705a6a2024626d279887e8795810982ec9e1a73b  public/data/woods.json
bb38391bb7f06130cfa64391d460316da7dbd88974539cdc3bfa3522829f836a  public/data/woods-3d.json
```

No deploy, push, or commit was performed.
