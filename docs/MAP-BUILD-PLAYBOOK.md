# TarkovZero — How a map gets built (the Customs playbook)

This is the handover for building further maps (Reserve, Woods, …) the way Customs was built.
Everything below was learned the hard way on Customs; follow it and you skip a week of dead ends.

## 0. What a "map" is in this repo

A map = one **coordinate frame** + four data products + a small amount of hand authoring:

| Product | File (Customs) | Produced by |
|---|---|---|
| 2D config (tiles, bounds, transform) | `src/mapdata.js` | copied from tarkov.dev `maps.json` |
| Marker data (extracts/transits, spawns, bosses, hazards, locks, switches, guns, loot, BTR stops, artillery) | `public/data/customs.json` | `scripts/build-community-data.mjs` (verified tarkov.dev JSON cache first; SPT/Wiki witnesses second) |
| 3D geometry + raw exact layer (terrain, evidence buckets, floors, hard rock, buildings, roads, props, bridges, limit) | `public/data/customs-3d.json` | `scripts/build-3d.mjs` |
| Place labels | `src/labels.js` | tarkov.dev `maps.json` labels + hand additions |
| Hand-authored extras | `data/customs-props.json`, `data/customs-roads.json`, `data/customs-features.json`, sparse `TERRAIN_FEATURES`/`PLACE_*` tables in `scripts/build-3d.mjs` | tracing + reviewed assertions |

The shared builders currently cover Customs, Reserve, and Woods. Adding another map means adding one
configuration entry and the same products/manifests; Customs remains the regression gate unless a pass
explicitly intends data changes and records its before/after hashes.

## 1. Coordinate system — the one thing that must be right

* Game coordinates (Unity): `x, y, z` with `y` = height. We plot on `x` (east–west) and `z` (north–south).
* tarkov.dev's `maps.json` gives, per map: `transform [scaleX, offsetX, scaleY, offsetY]`, `coordinateRotation`
  (Customs 180°), `bounds` as **`[[x, z], [x, z]]`** (they swap to Leaflet `[z, x]` in `getBounds()`), `tileSize`, `minZoom/maxZoom`,
  `tilePath`, `svgPath`, `svgLayer`, `layers[]` with `extents` (floor boxes with real `height` ranges in game y!), and `labels[]` (`position` is `[x, z]`).
  Source: https://raw.githubusercontent.com/the-hideout/tarkov-dev/main/src/data/maps.json (a copy is in `scripts/tarkov-dev-maps.json`).
* Leaflet (2D): latLng = `[z, x]`; custom CRS in `src/crs.js` applies the transform + rotation exactly like tarkov.dev's `getCRS()`.
* deck.gl (3D): cartesian `[-x, -z, y]` (`P()` in `src/map3d.js`) so on-screen orientation matches 2D at 0° orbit. Heading on screen = `yaw + coordinateRotation`.
* SVG → game: the SVG `viewBox` maps linearly onto the map `bounds`:
  `x = xMax − (svgX / vbW) · (xMax − xMin)`, `z = zMin + (svgY / vbH) · (zMax − zMin)` (see `toGame()` in `scripts/build-3d.mjs`).
  Check other maps' `coordinateRotation` — if it is not 180 the SVG axis mapping must be derived from the transform, not copied.
* Wiki interactive map → game: affine fit from ≥4 known points (`CALIBRATION` in `scripts/build-community-data.mjs`); we used bunker/basement
  positions from `maps.json` `extents`. Keep residuals < 5 m.
* Satellite screenshot → game (for tracing): at Leaflet zoom `z`, px per metre = `0.239 · 2^z` (Customs transform scale; use the map's own scaleX).
  With a 1400×900 window and the sidebar (240 px), map centre is at px `(820, 450)`: `x = cx − (px − 820)/ppm`, `z = cz + (py − 450)/ppm`. **x decreases to the right.**

## 2. Data sources and what each is good for

| Source | Gives | Notes |
|---|---|---|
| tarkov.dev CDN `https://assets.tarkov.dev/maps/<key>_<ver>/main/{z}/{x}/{y}.png` | satellite tiles (ground truth for tracing) | version folder (`customs_0.16`) is in `maps.json` `tilePath` |
| tarkov.dev SVG `https://assets.tarkov.dev/maps/svg/<Name>.svg` | hand-drawn vector map: `Ground_Level` with semantic groups (Ground/Trees/River/Dirt_Roads/Pavement/Roads/Main_Roads/High_Roads/Railway/Fence/Buildings/Limit/Rocks/Powerlines…), floor groups `Underground_Level`, `First_Floor`… | CC BY-NC-SA. Building footprints are clean polygons; floor groups are wall drawings (use as textures, not geometry). Roads continue beyond the `Limit` polygon — always clip. Their "small road" class mixes paved yard roads and forest trails. Group ids differ per map — inspect first. |
| tarkov.dev `maps.json` | transform, bounds, tiles, labels, floor extents (heights!) | free, exact |
| tarkov.dev JSON `https://json.tarkov.dev/regular/maps` + `/maps_en` | exact source objects for extracts/transits/locks/switches/hazards, loot, weapons, BTR stops, artillery, plus names | fetch only with `scripts/fetch-map-primitives.mjs`; raw responses are versioned/hash-named and ignored, while `scripts/data/tarkov-dev-exact-manifest.json` commits URL/date/SHA-256. Builders are cache-only and verify hashes before parsing. |
| tarkov.dev GraphQL `https://api.tarkov.dev/graphql` | extracts/spawns/bosses/hazards/locks with positions | was down for days; `scripts/fetch-data.mjs` snapshot when it works |
| SPT server DB `https://raw.githubusercontent.com/sp-tarkov/server/master/project/assets/database/locations/<id>/base.json` | `SpawnPointParams` (x,y,z, sides, categories, zone), `BossLocationSpawn`, exits (names only) | map ids: customs=`bigmap`, reserve=`rezervbase`, woods=`woods`, shoreline=`shoreline`, interchange=`interchange`, lighthouse=`lighthouse`, streets=`tarkovstreets`, labs=`laboratory`, factory=`factory4_day`, ground zero=`sandbox`. `looseLoot.json` is LFS; compact Customs/Reserve/Woods positions were extracted from the official SPT 4.1.2 release archive. See `docs/plans/ELEVATION.md`. |
| EFT Wiki interactive map `https://escapefromtarkov.fandom.com/api.php?action=query&prop=revisions&titles=Map:<Name>&rvslots=main&rvprop=content&format=json` | extracts (pmc/scav/transit), boss/sniper spawns, levers, guns, locked doors in wiki-image pixels | needs a browser User-Agent; convert with the affine fit |
| re3mr renders (https://reemr.se/, mirrored on eft-ammo.com) | visual reference only (CC BY-NC-SA) | never copy assets |
| BSG game files | forbidden by ToS — don't | |

## 3. The pipeline, step by step (what `scripts/build-3d.mjs` does)

1. Parse the SVG: walk `<g>`/`<path>`/`<circle>`, accumulate `translate/scale`, flatten paths (M/L/H/V/C/S/Q/A/Z with curve sampling).
   **Bug we hit:** `s/S` reflect the previous control point — reset it after M/L/H/V/Z or roads become straight chords.
2. Convert to game coords (`toGame`). `Limit` (= `Ground`) is the playable boundary. Clip every linear feature to it, drop polygons whose centroid is outside.
3. Buildings: footprints from the `Buildings` group; floors = 1 + number of upper floor **extents** (from `maps.json`) covering ≥50 % of the footprint; height from the extent's real `y` ranges, else class defaults.
   Tag each building with the nearest label (`place`) → `PLACE_COLORS`, `ROOF_COLORS`, `PLACE_STYLE` (box | gable→hip | frame | canopy | tank). Hip roofs only on near-rectangular footprints. Then apply `data/<map>-features.json` by stable SVG source key/reviewed centroid. A target drift, wrong count, wrong floor/height/style/kind, or forbidden label is a build failure—not a silent nearest-label guess.
4. Roads: SVG road classes + `data/<map>-roads.json` hand-traced additions; non-fixed "small" roads become **tracks** unless they serve pavement/buildings; audited `reclassify`/`remove` by midpoint.
5. Bridges: road/rail runs over water polygons → decks with ramps/piers/rails; **verify with a playtest** which crossings are real (Customs: only Main Bridge, Junk Bridge footbridge, one ground path). Cut the flat road under decks.
6. Fences: strips with gaps where roads cross; powerline towers → lattice pylons + cables; towers within 10 m of the limit dropped.
7. Terrain: exact-cache positions, every SPT spawn/loose-loot position, and optional companion surveys enter one typed router with their original `y`. Every observation lands in exactly one `ground`, `rock`, `floor`, `roof`, or `underground` bucket with reason codes. Only a trusted 2 m-deduped view of `ground` fits the smooth 5 m heightfield; no other bucket is discarded. `rock` feeds hard geometry, while `floor`/`roof`/`underground` feed `floorSurfaces`. `TERRAIN_FEATURES` remain sparse-area fallback only. Generated horizontal and vertical data is canonical 1× metres. The 3D View's selectable 1×/2×/3× relief is the sole runtime sampler transform; it is never baked into JSON. See `docs/plans/ELEVATION.md`.
8. Props: `data/<map>-props.json` (containers, tankers, rail cars, vehicles, walls, cranes) traced from satellite screenshots at zoom 5 using the formula in §1.
9. Output one JSON; `src/map3d.js` renders it; `H(x,z)`/`Pg()` drape everything. The raw exact layer is embedded in `<map>-3d.json`, not split into a seventh public file: terrain/floor classification and geometry consume the same immutable source object, one request loads a map's canonical world, and the established six-file regression table still covers every public product. `<map>.json` contains only renderer projections plus cache provenance.

Marker data (`scripts/build-community-data.mjs`): verified exact-cache rows are projected first with source IDs and unrounded `(x,y,z)`. SPT and calibrated Wiki rows then corroborate by source identity and spatial distance; they cannot replace exact rows. Spatially distinct Wiki-only POIs survive with `visualApproximate: true`, and because Wiki pixels contain no height, their positions omit `y` instead of inventing zero. Output shape mirrors the tarkov.dev API so `src/api.js` can swap sources.

Refresh the optional exact cache explicitly, then rebuild cache-only:

```bash
node scripts/fetch-map-primitives.mjs --date YYYY-MM-DD
node scripts/build-community-data.mjs customs
node scripts/build-3d.mjs customs
```

A missing or hash-mismatched exact cache is a hard error with the fetch command; exact-source loading never silently uses the network.

## 4. Verification loop (do this constantly)

* `npm run build` then preview on :4173; headless screenshots:
  `chromium --headless=new --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist --window-size=1400,900 --timeout=24000 --screenshot=out.png "http://localhost:4173/?view=3d#<zoom>/<x>/<z>"`
  (software GL renders over-zoomed and slightly blurry — judge structure, not sharpness).
* Road accuracy: `http://localhost:5173/?base=satellite&debug=roads` draws the classified network over the satellite (yellow highway, red main, magenta paved, orange tracks, cyan bridges, red boundary). This overlay caught the flattener bug and the missing yard roads.
* Independent judge: `codex exec --skip-git-repo-check -s read-only -i overlay.png -i reference.png < prompt.txt` with a screen→game formula in the prompt so findings come back as coordinates.
* deck.gl TextLayer gotchas (9.3): no `CollisionFilterExtension` with pixel sizing; no `getAlignmentBaseline`; build the font atlas only after the webfont loaded (switch `fontFamily` when `document.fonts` confirms).
* The browser-free data gate is `node scripts/verify-map-pipeline.mjs --baseline=HEAD`. It validates cache projection, exact coordinates/source IDs, no fabricated Wiki Y, typed bucket accounting/reason codes, floor/rock consumers, reviewed features, 1× canonical data, pure 3× sampler scaling, eighteen named anchors, and all six before/after SHA-256 values.

## 5. Per-map checklist for a new map

1. `maps.json` entry → transform/rotation/bounds/tiles/SVG/labels/extents. Confirm `coordinateRotation` and derive the SVG mapping if ≠ 180.
2. Warm the tile cache (`scripts/warm-tiles.mjs` generalised to the map key) — the dev server caches under `.cache/`.
3. Inspect the SVG groups (`python: list g ids/classes`) — map them to the semantic roles above; some maps have no rail/river/powerlines, others have cliffs, bunkers, multiple water bodies.
4. SPT `base.json` for the map id → spawns/bosses; wiki `Map:<Name>` → extracts/locks/guns; pick ≥4 calibration points that exist in both (bunkers, basements, distinctive extracts) and check residuals.
5. Build 3D data; run the road overlay; compare against satellite; add `data/<map>-roads.json`, `TERRAIN_FEATURES`, `PLACE_*` tables; trace props.
6. Playtest facts to collect from the user: real river crossings, which "roads" are trails, map-limit quirks, landmark colours.
7. Verify 2D + 3D screenshots; Codex judge; iterate.

## 6. Known map-specific hints

* **Reserve** (`rezervbase`): mountainous — real elevation matters (bunkers, the hill with the radar, the pawn/knight/bishop/rook buildings, the train station and the underground tunnels). SVG likely has multiple underground layers; extracts include the armored train and manholes. Cliffs form the boundary on most sides.
* **Woods** (`woods`): large, rolling terrain, few buildings (sawmill, scav base, USEC camp, lumber mill), many rocks; roads are mostly dirt; the lake and river; the crash site. Terrain and rocks are the personality here — expect the SPT spawn coverage to be sparse in the forest, so hand-authored hills will carry more weight.
