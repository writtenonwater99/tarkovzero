# TarkovZero 3D map fidelity audit

**Maps:** Customs, Reserve, Woods  
**Audit date:** 2026-08-29 (America/Los_Angeles)  
**Scope:** research and judgment only; no production data or code was changed  
**Target:** one near-real, true-scale world dataset whose later “vector” presentation is only a skin  

## Executive verdict

TarkovZero already has a useful macro-map skeleton: world-coordinate bounds, SVG-derived building and road outlines, a deterministic terrain surface, large water polygons, named landmarks, and enough markers to orient a user. It does **not** yet contain a near-real 3D world. Its geometry is predominantly a cartographic extrusion of 2D shapes. Building identity, vertical structure, openings, road construction, shoreline form, vegetation landcover, clutter, and underground topology are either generalized or absent.

The strongest immediately usable source is not another artist's map. It is the live `json.tarkov.dev` cache, which currently exposes exact game-coordinate points and volumes for spawns, extracts, transits, locks, switches, hazards, loot, stationary weapons, BTR stops, and artillery zones. The current build uses only a subset and sometimes replaces exact 3D data with pixel-to-world Wiki transforms at `y = 0`. Incorporating those primitives is the cleanest first data upgrade.

The largest single geometric error is on Woods. The generated heightfield reaches only **27.7 m**, while current exact game-coordinate task zones place the Sniper Mountain summit at **77.52 m**. At the summit coordinate `(-209.22, -279.78)`, the generated surface is `23.85 m`: approximately **53.7 m too low**. The elevation ingest deliberately rejects the relevant high-rock spawn evidence and all samples at or above 55 m. The default 3× runtime relief makes the silhouette look taller, but it does not repair the world geometry and breaks true vertical scale.

Reserve's defining feature—the connected underground bunker and D-2 network—is represented by broad, surface-draped polygon overlays at a single nominal depth. Exact current data contains levels down to roughly `y = -29.31`, and the public tunnel reference shows rooms, corridors, stairs, doors, and multiple access points. Customs likewise lacks real interiors; notably the “Dorms 2-Story” shell is assigned three floors, while Big Red is assigned one floor even though an exact lock point exists around `y = 8.10` in its upper office.

The visual gap is mostly **semantic geometry**, not polygon count alone. For example, three enormous Customs cooling towers are currently represented in the Water Pump region by low 6–9 m tank/box recipes. Reserve's five-floor White Pawn is only 8 m high, and a Helipad-adjacent footprint is incorrectly assigned five floors. Woods has only 44 explicit props over 1.44 km² and a whole-map tree density of 15.9 trees/ha despite being the forest map.

The best independent visual references—Re3mr maps and the dedicated tarkov.dev SVG maps—are CC BY-NC-SA 4.0. MapGenie and Tarkov-Market are proprietary, with Tarkov-Market explicitly prohibiting automated scraping. These are excellent QA references but are not a safe commercial ingestion path without written permission and license review. Client-derived Unity terrain, navmesh, collider, or scene extraction tools are a hard red line under this audit's no-BSG-game-files constraint, even when the extractor's code is open-source.

Accordingly, the recommended route is:

1. ingest all exact current world primitives already available from permitted APIs/databases;
2. enforce a true-scale vertical contract and repair semantic assignment failures;
3. expand the shared geometry schema and parser where licensing permits;
4. use TarkovZero's own companion survey logs and screenshots to create the missing hard terrain, landmark props, openings, interiors, and vegetation boundaries;
5. treat Customs as the shared-pipeline regression gate, but prioritize the Woods mountain and Reserve bunker as the two highest-severity per-map corrections.

## Audit method and evidence standard

### Coordinate convention

Game coordinates are treated as authoritative throughout this report:

- game/world horizontal coordinates: `(x, z)`;
- game/world vertical coordinate: `y`;
- Leaflet convention in this repository: `[z, x]`;
- deck.gl rendering convention in this repository: `[-x, -z, y]`.

Pixel maps and raster art are evidence for topology and appearance only. Their affine transforms are useful for tracing, but an exact API/SPT/survey point wins whenever the two disagree.

### What was inspected

The following repository inputs were read in full or traced through their consumers:

- `docs/AGENT-ONBOARDING.md`
- `docs/MAP-BUILD-PLAYBOOK.md`
- `docs/plans/PROGRESS.md` (including the latest fix pass)
- `docs/plans/ELEVATION.md`
- `scripts/build-3d.mjs`
- `scripts/ingest-elevation.mjs`
- `scripts/build-community-data.mjs`
- `src/map3d.js`
- `src/terrain.js`
- `src/water.js`
- `src/trees.js`
- `public/data/{customs,reserve,woods}.json`
- `public/data/{customs,reserve,woods}-3d.json`
- `data/{customs,reserve,woods}-props.json`
- `data/{customs,reserve,woods}-roads.json`
- `data/woods-yards.json`

The generated JSON was measured directly with `scratch/codex-3d-audit/audit-current.mjs`. Dedicated SVGs and community web SVGs were parsed and counted with the companion audit scripts in this folder. Six large public reference images were fetched into `scratch/codex-3d-audit/references/` and inspected as visual evidence; no browser automation or screenshots were used.

### Confidence labels

- **Exact:** current world-coordinate point or bounding volume from a permitted API/database or TarkovZero-owned survey.
- **Derived:** deterministic transform or interpolation from exact points.
- **Traced:** geometry copied from a public map image/SVG; shape may be good, but alignment and licensing must be verified.
- **Visual:** useful for judging identity, topology, density, and omission, but not safe as a coordinate source.
- **Inferred:** conclusion from multiple signals, called out where material.

### Important licensing distinction

“Allowed by this project's ToS constraint” is not the same as “licensed for unrestricted commercial reuse.” The user explicitly permits tarkov.dev, SPT, the EFT Wiki, community maps/tools, and first-party surveys, but several of those sources carry non-commercial/share-alike terms or unclear provenance. This report flags that distinction rather than making a legal determination.

## Current-data baseline

| Metric | Customs | Reserve | Woods |
|---|---:|---:|---:|
| Playable bounds `(minX,minZ) → (maxX,maxZ)` | `(-353.9,-305.6) → (681.5,287.0)` | `(-301.1,-276.1) → (315.4,270.4)` | `(-761.0,-914.0) → (646.0,454.2)` |
| Approx. playable area | 0.497 km² | 0.219 km² | 1.444 km² |
| Terrain grid | 231×126 = 29,106 cells | 136×127 = 17,272 | 299×289 = 86,411 |
| Terrain grid spacing | 5 m | 5 m | 5 m |
| Generated `y` range | -7.5 to 15.8 m | -7.0 to 21.4 m | -20.9 to 27.7 m |
| Accepted terrain evidence | 470 | 409 | 798 |
| Evidence sources | 196 loose-loot + 274 spawn | 253 loose-loot + 156 spawn | 499 loose-loot + 299 spawn |
| First-party survey points | 0 | 0 | 0 |
| Median distance from a 10 m grid point to evidence | 28.3 m | 21.2 m | 45.6 m |
| 10 m grid cells within 25 m of evidence | 44.3% | 58.4% | 23.9% |
| Building components | 74 | 56 | 121 (including 9 synthetic pylons) |
| Building footprint area | 29,499.5 m² (5.94%) | 19,716.0 m² (9.01%) | 9,702.7 m² (0.67%) |
| Explicit props | 87 | 44 | 44 |
| Road centerline length | 6,332.9 m | 5,957.0 m | 7,562.3 m |
| Rail centerline length | 3,155.7 m | 1,171.5 m | 535.7 m |
| Fence centerline length | 2,402.0 m | 1,259.5 m | SVG-derived, not separately measured in output summary |
| Water bodies/reaches | 3 | 0 | 11 |
| Explicit trees | 2,348 | 112 | 2,298 |
| Whole-map tree density | 47.25/ha | 5.12/ha | 15.92/ha |
| Understory/forest-mask share | 4.10% | 0.94% | 3.54% |
| Underground output | 6 rectangles | 10 broad silhouettes | none |

Current serialized community-layer counts provide a second baseline:

| Marker/layer | Customs | Reserve | Woods |
|---|---:|---:|---:|
| Extract markers | 30 | 14 | 22 |
| Spawn markers | 297 | 196 | 336 |
| Boss markers | 4 | 1 | 4 |
| Stationary-gun markers | 4 | 8 | 2 |
| Lock markers | 34 | 5 | 5 |
| Switch markers | 1 | 3 | 0 |
| Hazard records | 0 | 0 | 0 |
| Container/loot markers | 733 | 575 | 618 |

These are heterogeneous merged/display counts, not one-for-one equivalents of the live-cache collections. Their divergence is itself the problem: current output cannot be audited back to one authoritative source/ID for every marker, Reserve drops most exact locks, and all three maps lose hazard volumes.

The baseline is not a measure of “how many objects the game has.” It measures what TarkovZero serializes. It makes the representation gap visible: the public Re3mr pages describe 18,788 modeled Customs objects, 3,703 Reserve objects, and 27,042 Woods objects, whereas TarkovZero carries 87, 44, and 44 explicit props respectively. Those definitions are not identical, so the ratio is not a precise completeness percentage; it is still compelling order-of-magnitude evidence that the current world is sparse.

# Part A — external source inventory

## Source table

| Source | Verified URL(s) | What it contains; count / coordinate system / precision | License and ToS risk | Already used? | Near-real 3D value | Recommended ingest |
|---|---|---|---|---|---|---|
| **tarkov.dev live JSON map cache** | `https://json.tarkov.dev/regular/maps`; `.../regular/maps_en`; PvE/dev variants also respond | Current exact world points and, for extracts/transits/locks/switches/hazards, `position`, `size`, `outline`, `top`, and `bottom`. Counts measured below. Loot and weapons have exact `(x,y,z)`. Game coordinates, typically centimeter-like serialized precision, though real accuracy is source-dependent. | Permitted by project constraint. API/repository code is MIT, but data provenance and downstream asset terms should remain recorded; do not assume all embedded art/data is MIT. | **Partly.** Current community output does not retain most volume geometry and emits `hazards: []`; much marker data still comes through Wiki affine transforms and/or thinned SPT samples. | **High.** Best immediate source for vertical/floor evidence, doors, hazards, exact props/loot density, and regression anchors. | Add a versioned cache fetch. Preserve source IDs and full 3D primitives verbatim in a raw layer, then derive renderer layers. Never force `y=0`. Use IDs for deterministic diffs and dedupe against SPT. |
| **tarkov.dev GraphQL endpoint** | `https://api.tarkov.dev/graphql` | Normally exposes maps and related entities with queryable fields; on the audit date POST returned HTTP 422 with `GraphQL server unavailable`. `https://tarkov.dev/api/graphql` returned 405; `https://tarkov-api.vercel.app/graphql` returned 404. | Same provenance caution as JSON cache. | Build scripts were written around GraphQL-era data, but the live endpoint was unavailable. | Medium while unavailable; high when restored. | Prefer JSON cache for deterministic builds now. Keep a schema-tested GraphQL adapter as optional source, not a hard build dependency. |
| **Dedicated tarkov.dev SVG map repository** | `https://github.com/the-hideout/tarkov-dev-svg-maps`; CDN `https://assets.tarkov.dev/maps/svg/Customs.svg`, `Reserve.svg`, `Woods.svg` | Layered vector paths in a map-space coordinate system with published affine transforms to game `(x,z)`. Customs: 506 paths, 4 circles, 65 `<use>`; Reserve: 228 paths; Woods: 481 paths. Includes buildings, roads, rails, water, rocks, fences, vegetation masks, levels/bunkers, and map-specific objects. Shapes are traced/cartographic, not game mesh precision. | **CC BY-NC-SA 4.0** plus anti-cheat language. High commercial/share-alike risk. Existing use does not erase the need for legal review or permission. | **Yes, partially.** Main macro paths are used; parser ignores or weakly handles several element types, `<use>`, complex transforms, and semantic layers. | High for macro shells, floors, fences, rock fields, shoreline, and layer topology—if rights are resolved. | Replace the ad-hoc parser with a standards-complete deterministic SVG normalization stage. Preserve group/layer IDs and source element IDs. Ingest only approved layers; retain provenance per feature. |
| **tarkov.dev map metadata/transforms** | `https://raw.githubusercontent.com/the-hideout/tarkov-dev/main/src/data/maps.json` | Game bounds, SVG bounds/transforms, rotation, zoom/tile metadata, and floor extents. Customs has 17 second-floor, 4 third-floor, 1 fourth-floor, and 6 underground extents; Reserve 14/6/4/1 upper extents and 7 bunker extents; Woods has no level extents. | tarkov-dev repository code is MIT; referenced third-party map assets have their own licenses. | **Yes.** Local metadata matched upstream byte-for-meaning for the three maps during inspection. | High as alignment metadata; low as new geometry. | Pin upstream revision/hash; validate corner/landmark transforms with exact world anchors. Treat rectangular level extents as classification aids, not geometry. |
| **tarkov.dev raster tile sets** | Customs `https://assets.tarkov.dev/maps/customs_0.16/main/0/0/0.png`; Reserve `https://assets.tarkov.dev/maps/reserve/main/0/0/0.png`; Woods `https://assets.tarkov.dev/maps/woods/main_0.16/0/0/0.png` | Multi-zoom raster imagery aligned through map metadata. Strong visual evidence for topology, named-place context, and forest/ground patterns; no direct vector/world coordinates beyond transform and pixel sampling. | Artwork licensing varies; the public map art is commonly CC BY-NC-SA or author-controlled. Commercial tracing/reuse needs permission. | Used as map presentation context, not as a structured 3D source. | Medium for QA and manual survey planning; low as an automatic ingest. | Do not image-vectorize into production without rights. Use as an overlay in an internal comparator to find omissions against exact anchors. |
| **tarkov.dev public Re3mr/Jindouz/monki map images** | Repo directory `https://github.com/the-hideout/tarkov-dev/tree/main/public/maps` | High-resolution public 2D/3D illustrations and floor insets: Customs 3D + Dorms, Reserve 3D + tunnels, Woods 3D, plus 2D works. Pixel coordinates only unless aligned through metadata. | tarkov-dev's MIT repository does not necessarily relicense third-party art. Re3mr's originals are CC BY-NC-SA 4.0. Treat as visual-only unless the author grants compatible rights. | Some images are used by the site ecosystem; not ingested as world geometry. | High for visual omission checking, building identity, prop density, and interiors; low as legally clean data. | Internal QA overlay only. Create a checklist from observations; acquire coordinates independently through permitted APIs or first-party survey. |
| **SPT server database (legacy TypeScript)** | `https://github.com/sp-tarkov/server`; paths `project/assets/database/locations/{bigmap,rezervbase,woods}/` | `base.json`: spawn points/colliders, zones, OpenZones, waves, bosses, exits/config, bounds, rotations. Local counts: Customs 297 spawns, Reserve 196, Woods 336. `looseLoot.json`: exact world loot points (Git LFS upstream); release archive supplied usable files. `staticContainers.json`: IDs and counts but main Positions are zeroed, so not world geometry. Doors arrays are empty. No building footprints, navmesh, water, or terrain mesh. | User explicitly permits SPT database. Legacy repo says NCSA; current repo licensing has changed/conflicts. Data ultimately describes EFT. Commercial reuse/provenance needs review. **Do not use SPT client assets or exported scenes.** | **Yes.** 4.1.2 loose-loot and spawn points are the terrain evidence source; substantial filtering is applied. | High for exact terrain samples, zones, spawn semantics; low for physical scene geometry. | Pin release archive and file hashes. Import raw points/volumes and source tags. Preserve rejected points with reason codes so hard terrain is not silently lost. |
| **SPT current C# server database** | `https://github.com/sp-tarkov/server-csharp`; path `Libraries/SPTarkov.Server.Assets/SPT_Data/database/locations/` | Current form of the same location database: spawns, zones, exits, waves, loose loot/static IDs. Public server data still lacks meshes, navmesh, building surfaces, water, and meaningful static-container transforms. | Repository LICENSE inspected as CC BY-NC-SA 4.0 while README language references NCSA, creating an ambiguity. User allows SPT, but commercial licensing still needs resolution. | Not the pinned input for current terrain build. | Medium as a future-current dataset; little novel geometry beyond legacy SPT. | Add a schema adapter and semantic diff before upgrading versions. Never silently mix versions in one terrain build. |
| **SPT 4.1.2 release archive** | `https://spt-releases.modd.in/SPT-4.1.2-40743-cf04a11.7z` | Working distribution route for large LFS-backed location JSON when Git LFS host refused access. The audited local source files correspond to this release. | Same SPT licensing/provenance caveat. Download executable/server packages only into a quarantined research workflow; ingest JSON database files, not game/client files. | **Yes.** This is the practical origin of current loose-loot samples. | High for reproducibility of existing elevation evidence. | Record release, archive hash, per-file hash, extraction path, and schema version in the build manifest. |
| **EFT Wiki map/location pages** | `https://escapefromtarkov.fandom.com/wiki/Customs`, `/Reserve`, `/Woods`; API `https://escapefromtarkov.fandom.com/api.php` | Named areas, extracts, transits, key/door lists, screenshots, floor plan images, map images. Counts from page/API inspection: Customs 107 images / 33 key links / 27 extracts / 4 transits; Reserve 84 / 31 / 11 / 3; Woods 68 / 6 / 18 / 4. Mostly prose and pixels. | Wiki rights endpoint reports CC BY-NC-SA terms. Individual images may have separate attribution/provenance. Non-commercial/share-alike risk. | **Yes.** `build-community-data.mjs` transforms interactive-map pixel markers to world coordinates and sets `y=0`. | Medium for semantic verification, door/extract names, floor plans, and survey checklists; low as exact geometry. | Replace coordinates with exact JSON cache IDs when possible. Retain Wiki only for labels/descriptions and visual QA, with revision ID and attribution. |
| **EFT Wiki interactive map JSON** | `Map:Customs`, `Map:Reserve`, `Map:Woods` through the Fandom parse/API endpoint | Base-image dimensions and pixel markers: Customs 4097×2142 / 523 markers; Reserve 4701×2785 / 496; Woods 6994×6843 / 402. Revisions verified as 355611, 355616, 355623. Coordinates are map pixels with category/name metadata, no trustworthy `y`. | Same Wiki CC BY-NC-SA and image-provenance risk. | **Yes, heavily** for community marker generation. Reserve/Woods inset panels are specially excluded. | Medium for coverage audit; low where exact API equivalents exist. | Build an ID/name crosswalk to the exact cache. Keep unmatched Wiki-only POIs as `visualApproximate`, never as terrain or collision evidence. |
| **Re3mr direct Customs map** | `https://reemr.se/customs/`; image `https://maps.reemr.se/Customs/re3mrCustoms2.png`; Dorms `https://maps.reemr.se/Customs/re3mrCustomsDorms.png` | Current page advertises v1.0D, approx. 938×527 m, 18,788 modeled objects. High-detail axonometric exterior plus dedicated 2- and 3-story Dorms floor plans: rooms, corridors, stairs, blocked/locked doors. Pixel/art coordinates, alignable but not authoritative. | Explicit **CC BY-NC-SA 4.0**; page says not for commercial profit. High risk for a commercial/live product. | No structured ingest. | **High visual value.** Best checked reference for the eastern industrial expansion, cooling towers, tanks/pipes, containers, bridges, construction, and Dorms topology. | Visual QA and first-party survey planning only unless written permission is obtained. Do not trace production geometry from it under present terms. |
| **Re3mr direct Reserve map/tunnels** | `https://reemr.se/reserve/`; surface `https://reemr.se/maps/Reserve/Re3mrReserveLossless.png`; tunnels `https://maps.reemr.se/Reserve/re3mrReserveTunnels.png` | Page advertises v1.3F, approx. 307×396 m, 3,703 objects. Detailed surface identity, military clutter, rail yard, Dome/radar, barracks; separate connected bunker/tunnel plan with rooms, corridors, stairs, and access points. | Explicit CC BY-NC-SA 4.0; no commercial profit. | No structured ingest. | **High visual value**, especially for Reserve's defining underground topology. | Use as a topology checklist; anchor every production node from exact API points and first-party survey. Seek permission before tracing shapes. |
| **Re3mr direct Woods / Train Depot maps** | `https://reemr.se/woods/`; overview `https://www.reemr.se/maps/Woods/WoodsRe3mrPNG.png`; depot `https://reemr.se/maps/Woods/TrainDepotHQ.png` | Page advertises v1.7, approx. 910×800 m, 27,042 objects. Strong forest-edge, rock/mountain, ponds/lake/river, path, pylon, compound, and Train Depot evidence. Pixel/art coordinates. | Explicit CC BY-NC-SA 4.0; no commercial profit. | No structured ingest. | **High visual value.** Makes the missing mountain mass, dense landcover, path web, and Depot clutter unmistakable. | Visual QA and survey planning only; no production tracing without permission. |
| **Tarkov-Market semantic inline SVG maps** | `https://tarkov-market.com/maps/customs`, `/reserve`, `/woods`; ToS `https://tarkov-market.com/legal/tos` | Rich inline SVG with semantic groups. Customs: 145 paths, 30 polygons, 198 polylines, 156 lines, 193 rects, 96 text nodes, groups for water/rail/roads/fences/buildings/basement/levels/Dorms/Fortress. Reserve: 132 paths, 21 polygons, floor 2–5 and bunker groups. Woods: 32 paths plus water/ground/rail/rocks/roads/buildings/fences/objects/mines/BTR/signal zones. SVG pixel coordinates, precision unknown. | ToS updated 2026-05-01: automated tools/scrapers prohibited; code/design/branding owned by developer. No open geometry license or clear provenance. **Do not scrape or ingest.** | No. This audit fetched the public HTML only to determine whether a usable open dataset existed. | Medium/high as a manual semantic comparator; zero as an authorized automated source today. | Ask for written data/API permission and provenance. Otherwise use only manually observed omissions and independently survey coordinates. |
| **MapGenie** | `https://mapgenie.io/tarkov/maps/customs`, `/reserve`, `/woods` | Proprietary tiled maps and markers; public pages returned HTTP 403 during this audit. Community downloader code reveals tile URL patterns, not permission. Pixel tiles, no open world-coordinate dataset verified. | Proprietary/premium; no open content license. Avoid tile scraping or downloader endpoints. | No. | Medium visual reference if viewed manually; low ingest value. | Manual comparison only, or pursue a formal license/API arrangement. |
| **tarkov.help** | `https://tarkov.help/en/map/customs`, `/reserve`, `/woods` | JavaScript interactive maps, proprietary raster layers and markers; no openly licensed geometry located. Mostly duplicates known POIs. | No compatible open license verified. | No. | Low/medium QA value. | Do not ingest; use public pages manually only if needed to reconcile a label. |
| **TarkovTracker / TarkovLab snapshots and overlays** | `https://github.com/TarkovTracker/tarkovdata`; `https://github.com/TarkovLab/TarkovData`; `https://github.com/tarkovtracker-org/tarkov-data-overlay`; `https://github.com/sayser/TarkovTracker` | Bounds, map metadata, task zones, corrections, API snapshots, and the same dedicated SVGs. Overlay code is MIT, but the underlying map assets keep their source licenses. No novel independent terrain/building mesh was found. | Mixed: MIT code in places; no license in others; upstream assets retain CC/provenance. | Much of the content is already present through tarkov.dev/Wiki. | Medium as fallback/version history; low as novel geometry. | Use only for diff/correction records and API outage recovery, with upstream provenance preserved. Do not treat a mirror as relicensing. |
| **Raid Signal / QTtrash map** | `https://github.com/QTtrash/tarkov-map` | Apache-licensed application code, API snapshots, and an asset ledger pointing back to tarkov.dev SVGs. No independent geometry source found. | Code is permissive; map assets are not thereby relicensed. | No. | Low as data; medium as a companion-map implementation reference. | Reuse only code patterns compatible with project needs; fetch geometry from original permitted sources. |
| **Tarkov Nexus / coordinate logging tools** | `https://github.com/ObsidianNetwork/Tarkov-Nexus` | Companion workflows that derive/log world `(x,y,z)` from screenshot filenames or game-visible telemetry. No novel bundled map geometry. | Tool code license applies to code; a project's own captured logs/screenshots are first-party evidence. Avoid any technique requiring protected game-file extraction or anti-cheat bypass. | TarkovZero already has a companion survey concept, but no survey points are present in the audited terrain output. | **High enabling value.** This is the legally clean route to exact terrain, floors, thresholds, shores, and props. | Extend TarkovZero's own logger schema; capture position, tag, yaw, timestamp, and screenshot ID. Ingest signed/versioned survey logs with map/build metadata. |
| **Old community map art repositories** | `https://github.com/monK87/EFT-Maps`; `https://github.com/glory4lyfe/EFT-Maps`; `https://github.com/caioctt/tarkov-3dmaps` | 2020-era Affinity/PNG/JPG maps; flat art, old layouts, no authoritative world-coordinate geometry. | No usable license found in the inspected repos; stale and likely derivative. | No. | Low. | Do not ingest. At most use to understand historical map expansion boundaries. |
| **Unlicensed backend dump (`carlsmei/tarkovdata`)** | `https://github.com/carlsmei/tarkovdata` | Unlicense repository containing a raw-looking `locations.json` with base config, spawns, OpenZones, exits, empty doors. It duplicates SPT-like data and has no meshes. | Repository license cannot cleanly grant rights to third-party/game-derived content. Provenance is ambiguous; redundant to the explicitly permitted SPT path. | No. | Low. | Do not use; retain SPT as the documented source. |
| **Atlas client extractor** | `https://github.com/ConocoFieldsForever/atlas` | MIT extractor code for Unity client terrain, navmesh, colliders, scenes, and maps. Does not provide a clean independently licensed dataset; its useful output requires BSG client files. | **Prohibited for this project.** Open-source extractor code does not make extracted game assets permissible. High ToS/copyright risk. | No. | Technically high, legally unusable. | Never run against EFT client data; never accept derived meshes/heightmaps without independently verifiable clean-room provenance. |
| **SPT MapCleaner and runtime-navmesh mods** | `https://github.com/DrakiaXYZ/SPT-MapCleaner`; SAIN and similar runtime navmesh projects found through GitHub search | Tools clean/export client maps or query the game's runtime navmesh; no openly licensed geometry dataset for these three maps was found. | **Prohibited output path** under no-BSG-game-files rule. MIT code does not sanitize output provenance. | No. | Technically medium/high, usable value zero. | Do not use. Survey walkable paths and obstacles directly instead. |
| **RatScanner / EFT-Ammo and similar named tools** | Public GitHub searches for RatScanner, EFT-Ammo, “Tarkov navmesh,” “heightmap,” and coordinate datasets | RatScanner is item OCR; EFT-Ammo is item/ammunition data. Search results did not reveal an independently surveyed, openly licensed heightmap, navmesh, or scene mesh for Customs, Reserve, or Woods. | Varies; no relevant geometry to license. | No. | None for 3D geometry. | Exclude from geometry roadmap. |

## Exact live-cache counts by map

The live JSON cache is materially richer than the current serialized community layers:

| Entity | Customs | Reserve | Woods | Geometry retained by source |
|---|---:|---:|---:|---|
| Extracts | 27 | 11 | 20 | point + 3D volume/outline |
| Transits | 4 | 3 | 4 | point + 3D volume/outline |
| Spawn positions | 278 | 167 | 327 | exact `(x,y,z)` |
| Locks | 34 | 33 | 4 | point + 3D volume/outline |
| Switches | 1 | 3 | 0 | point + 3D volume/outline |
| Hazards | 5 (3 sniper, 2 minefield) | 4 (3 sniper, 1 minefield) | 64 (39 sniper, 25 minefield) | point + volume/outline |
| Loot containers | 551 | 991 | 428 | exact `(x,y,z)` and identity |
| Loose loot | 416 | 766 | 387 | exact `(x,y,z)` and identity |
| Stationary weapons | 4 | 8 | 2 | exact position/orientation fields |
| BTR stops | 0 | 0 | 8 | exact route-stop points |
| Artillery zones | 2 | 2 | 2 | zone geometry |

Vertical ranges are also informative: Customs container `y` spans about -11.90 to 16.21 m; Reserve -21.91 to 32.90 m; Woods -16.23 to 76.95 m. Those values are not all terrain samples—many are on shelves, roofs, floors, or underground—but that is precisely why they are valuable for floor classification and why they must not be blindly fed into a ground interpolator.

## What the public SPT database does and does not imply

SPT's server database is valuable but easy to overstate. Spawn colliders and OpenZones imply **activity regions**, not walls or building footprints. A spherical spawn region with a 100 m radius says bots may spawn/move around that zone; it does not describe a circular clearing. Likewise a rectangular trigger volume can confirm a place and vertical band but not an architectural shell.

The inspected public location database provides no clean building mesh, terrain heightmap, road surface, shoreline, fence collider set, or navmesh. The `staticContainers` records for these maps link IDs but leave principal positions at zero, so they cannot position boxes or crates. `doors` arrays were empty. Any apparent route from SPT to full scene geometry would cross into client-derived files and violates the audit constraint.

## Source-selection conclusion

For production coordinates, the safe hierarchy is:

1. TarkovZero's own in-game survey logs and exact current permitted API points;
2. version-pinned SPT server database positions/volumes, with provenance and rejection reasons;
3. dedicated SVG/world transforms only where the asset license is compatible or permission is obtained;
4. Wiki and community art as visual QA/checklists, not coordinate truth;
5. no client extraction, regardless of the extractor's open-source license.

# Part B — current 3D data versus the map evidence

## Shared-pipeline findings

### 1. The data model is a cartographic extrusion model, not yet a world model

`build-3d.mjs` converts selected SVG subpaths into footprints, centerlines, masks, and low-detail recipes. `map3d.js` then adds procedural presentation: dashed bands that suggest windows, one generic door, roof vents, plinths, simple gables/canopies/frames, and several named landmark treatments. This is effective for a vector map, but it does not encode the physical facts a near-real renderer needs:

- wall segments with material, thickness, openings, and damage state;
- doors/windows as apertures linked to floors and rooms;
- roof planes, pitches, parapets, machinery, ladders, and access;
- interior rooms, corridors, stairs, shafts, and blocked passages;
- structural columns, slabs, ramps, curbs, retaining walls, and foundations;
- prop instances with identity, pose, scale, and collision footprint;
- vertical connections between surface, upper floors, and underground levels.

The current `PLACE_STYLE` recipes are styling heuristics applied after footprint assignment. They should remain useful as fallback skins, but should not be the canonical geometry. Near-real data needs named, stable feature records and subcomponents.

### 2. Semantic assignment can contradict the geometry

Buildings inherit names and floor extents through spatial heuristics. That produces obvious contradictions:

- “Dorms 2-Story” is serialized as 3 floors / 9.5 m.
- White Pawn is serialized as 5 floors but only 8 m high.
- a Reserve footprint at `(-96.2, 36.6)` assigned to “Helipad / Helicopter” inherits 5 floors and 16.1 m.
- two physically separate Customs components get the “Dorms 3-Story” name, including a small component around `(175.5, 128.3)`.
- 21 Woods Train Depot/freight-zone shapes are labeled “Railway Bridge to Tarkov.”

These are not renderer polish problems; they are identity and schema failures. The builder needs a stable override/manifest layer keyed by source feature ID or verified polygon centroid, plus assertions such as `floorCount × minimumFloorHeight <= height + tolerance`.

### 3. The vertical contract is internally inconsistent

The raw generated terrain is expressed in true meters. Runtime defaults to `relief = 3`, while buildings and props are placed using the same sampled relief transformation. This gives an exaggerated terrain presentation rather than a near-real world. It also masks missing terrain features: a 24 m Woods summit rendered at 3× resembles a 72 m mountain visually, but every grade, object relationship, stair/floor comparison, water elevation, and line of sight is no longer physically faithful.

Near-real mode should be 1× by default, with 3× retained only as an explicit cartographic skin. A build-time and runtime assertion suite should verify exact anchors at relief 1×. Changing the default alone is cheap but should ship with the hard-terrain corrections, otherwise it will expose the currently flattened Woods mountain.

### 4. Terrain density is not terrain fidelity

The output grids are dense because they are resampled every 5 m, but the observations feeding them are sparse and uneven. Across a 10 m evaluation lattice:

- Customs has a median 28.3 m and maximum 277.3 m distance to accepted evidence.
- Reserve has a median 21.2 m and maximum 155.8 m.
- Woods has a median 45.6 m and maximum 211.9 m.

Interpolation fills every cell, so there are no holes in the JSON, but low-frequency interpolation cannot invent ridges, cut banks, quarries, drainage ditches, berms, rock faces, road crowns, or building pads. The build also filters rooftop, underground, building, isolated, and high-rock points. Filtering is necessary, but the current single “ground surface” model loses useful **non-ground vertical surfaces** instead of routing them to rock/building/underground layers.

The correct architecture is a base terrain heightfield plus hard feature surfaces:

- rock masses/cliffs and retaining walls;
- road/rail profiles and embankments;
- water banks and bed constraints;
- building pads/foundations;
- underground slabs/corridors;
- survey confidence and source masks.

### 5. The SVG parser leaves real source geometry on the floor

The dedicated SVG audit found element types and layer structure that the current path/circle-focused parser does not faithfully preserve. It handles simple `translate`/uniform `scale`, samples curves sparsely, and reduces arcs essentially to endpoints. It ignores or inadequately resolves `<use>`, `rect`, `line`, `polyline`, nested transforms, and semantic source IDs.

Concrete losses include:

- Customs: 65 `<use>` elements, including repeated floor/ladder-like elements; multiple floor groups and locked-door geometry are not turned into architectural topology.
- Reserve: `Misc`, fence-extension, bunker entrance, direct chopper/object geometry, and full bunker semantics are partly ignored or collapsed.
- Woods: map-limit, dirt, minefield, fence, power/rail, pier/plane, and rock elements do not all reach an appropriately typed 3D layer.

This is a high-leverage shared fix, but only after the CC BY-NC-SA/commercial issue for the SVGs is resolved.

### 6. Roads are strokes, water is a flat fill, vegetation is decorative scatter

Road records are centerlines with class and nominal width. They are draped on the terrain without a complete cross-section: no crown/camber, shoulder, ditch, curb, sidewalk, rail ballast, switch geometry, cut/fill, or intersection blending. The only elevated structures are simple bridge decks; approaches and piers are not terrain-integrated.

Water is a polygon at one level with constant depth. It lacks shoreline slope, bank material, shallow shelves, channel thalweg, culverts, wetland transition, bridge interaction, and reliable clipping to playable bounds.

Trees are deterministic random points inside sparse masks or procedural land classifications. This makes rebuilds stable but does not reproduce tree lines, species clusters, lanes, clearings, stump fields, log piles, or tactical sight corridors. Density is especially implausible on Woods.

### 7. Current exact community data is discarded or flattened

The live cache exposes exact 3D points and volumes, yet current outputs show only 34/5/5 locks for Customs/Reserve/Woods, compared with 34/33/4 in the cache, and serialize no hazards at all. Wiki-derived points are transformed from pixels and assigned `y=0`. This both throws away accuracy and creates misleading ground/elevation relationships.

The raw layer should preserve every exact primitive with source, version, ID, full position, dimensions/outline, and confidence. Renderers may decide what to show; builders should not destroy the evidence.

## Customs

### Current inventory

- **74** building components covering **29,499.5 m²** (5.94% of the playable rectangle).
- Floor assignments: 60 one-floor, 10 two-floor, 3 three-floor, 1 four-floor.
- Styles: 48 boxes, 18 gables, 3 canopies, 2 frames, 3 tanks.
- **87** explicit props: 39 containers, 18 railcars, 7 tankers, 17 vehicles, 5 walls, 1 crane.
- Roads: 1,586.0 m dirt, 736.0 m highway, 979.5 m main, 2,455.4 m small, 576.0 m track; 3,155.7 m rail.
- Three bridge/ford records: Main Bridge 55.8 m, river ford 63.0 m, Junk Bridge 22.2 m.
- 2,402.0 m of fences and 1,039 m of power lines.
- 3 water reaches; 2,348 trees; 125 rock features.
- Terrain evidence: 470 accepted from 1,227 inputs; 698 were rejected as building points, 20 rooftop, 10 below-surface, 27 isolated.

### Buildings and named places

#### Eastern industrial expansion / Water Pump: major type and scale failure

**Region:** approximately `x=575..640`, `z=-140..-55`; the three Water Pump components are centered near `(603.7,-98.2)`, `(618.5,-100.0)`, and `(611.5,-130.2)`.

The strongest public visual references show three enormous hyperboloid cooling towers dominating this region, surrounded by industrial sheds, tanks, pipes, platforms, service roads, and clutter. TarkovZero assigns the region three low tank/box-style structures only **6–9 m** tall. The problem is not a missing texture; the landmark silhouette, scale, and structural type are wrong.

**Fix evidence:** use current exact POIs/loot/quest anchors to align the region, then first-party survey the tower centers, base diameters, visible height angles, nearby pads, tanks, and pipe corridors. Re3mr and public tarkov.dev tiles may be used as visual checklists only unless permission permits tracing. A parametric cooling-tower primitive is suitable once dimensions are surveyed.

#### Dorms: shell identity exists, topology does not

**Region:** 3-Story main footprint around `(183.8,168.1)`; 2-Story around `(231.0,149.8)`.

The main 3-Story shell is marked as three floors, but a small adjacent component around `(175.5,128.3)` is also tagged “Dorms 3-Story” and inherits the same classification. More seriously, “Dorms 2-Story” is assigned **three floors and 9.5 m**. Renderer recipes add facade-like bands and generic doors but there are no real rooms, corridors, stairs, balconies, window/door openings, blocked passages, or floor slabs.

The cache contains locks around `y≈0.8`, `3.84`, and `6.85`, which provide exact vertical anchors. The public Dorms floor plan confirms topology but is non-commercial visual reference. A survey should log every exterior corner, entrance threshold, stair landing, corridor turn, window/open-door aperture, and floor datum at 1 m cadence in the interior.

#### Big Red: upper office omitted by floor assignment

**Region:** main shell center `(-205.9,-114.2)`.

The building is represented as one floor / 9 m. An exact current lock point near `y=8.10` establishes usable upper-level space. The roof volume may be visually tall, but the data does not encode the office mezzanine, stairs, doors, loading openings, platform, or interior obstructions.

**Fix evidence:** exact lock/loot vertical clusters plus first-party interior survey. Keep the outer SVG footprint as a shell only if its license is resolved; otherwise survey its exterior corners.

#### Fortress / Stronghold and Crackhouse: recognizable recipe, generic physical model

**Regions:** Fortress `(203,-128)`; Crackhouse components `(83.9,-156.2)` and `(70.4,-172.6)`.

Fortress is a two-floor 9.5 m box with a named recipe. It lacks the open bays, stairs, mounted weapon positions, central circulation, roof/upper platforms, and wall openings that determine its tactical shape. Crackhouse is split into two components and styled, but not modeled as connected rooms/openings. Current exact stationary-weapon and loot/lock points can anchor several features; remaining geometry needs survey.

#### Construction / Skeleton: structure class is too coarse

**Regions:** Old Construction around `(79.6,-11.6)` and `(100.0,26.3)`; Skeleton components around `(163..203,-31..14)`.

Two “frame” styles acknowledge incomplete construction, but a footprint-level frame cannot represent columns, slabs, stairs, ramps, holes, cranes/scaffolding, and sightlines. The public map shows distinct construction stages and adjacent clutter. Create a reusable structural-frame grammar, but drive bay counts, slab elevations, and missing sections from survey—not random procedural placement.

#### Storage, Trailer Park, Old/New Gas, warehouses

- Storage has six coarse components around `x=-316..-253`, `z=-161..-109`, with no storage-unit rows, doors, internal alleys, fences, container clutter, or vehicle pose fidelity.
- Trailer Park components around `x=-249..-187`, `z=-223..-187` are simple shells; the trailers, barriers, walls, and extract approach need object-level placement.
- New Gas around `(413.3,28.9)` and Old Gas around `x=314..348`, `z=-185..-170` have named place identity but lack pump islands, canopy structure, vehicles, barriers, tanks, and precise interior openings.
- Warehouse 3/4/7, Depot, and Warehouse 17 have macro footprints but not the roof machinery, loading bays, pipework, platforms, internal partitions, or yard clutter visible in the public references.

### Terrain

The generated Customs terrain spans `y=-7.5..15.8`. Accepted evidence density is 945.7 points/km², but only 44.3% of 10 m evaluation points lie within 25 m of evidence. The worst gap is the northwest/top-left region around `x=-310..-240`, `z=250..280`, where the nearest accepted point can be 259–277 m away.

High-value corrections:

- **Crossroads / Trailer Park / Big Red west:** survey road crowns, yard pads, rail embankments, and perimeter ditches. A smooth fill over the northwest evidence void can create false grades and sightlines.
- **River corridor:** `x≈-120..-39`, `z≈-246..146`. Current water reaches are flat, but banks, floodplain shelves, bridge abutments, ford depth, and approach grades need paired shore transects.
- **Construction corridor:** `x≈60..280`, `z≈-180..40`. Building/rooftop rejections leave the complex's pads, ramps, rubble berms, and excavations underconstrained.
- **Eastern industrial grade:** `x≈450..650`, `z≈-150..50`. The reworked industrial region needs road/pad/tower-base samples; loot/spawn points alone cannot distinguish slab tops from terrain.
- **Dorms / bus / sniper ridge:** survey the road climb, tree-line breaks, building pads, and ridge crest around `x≈165..525`, `z≈45..190`.

The current filters are directionally correct, but rejected points should be retained in typed buckets. For example, clustered “building” or “rooftop” points can prove floor slabs even when they must not shape the ground.

### Roads, rail, bridges, and paths

Macro connectivity is good enough for navigation but not near-real:

- paved/dirt classes are present, but intersections do not encode lane/shoulder/curb geometry;
- the river crossing contains bridge/ford records, but the decks lack surveyed elevations, abutments, piers, guardrails, approach grading, and water interaction;
- 11 rail centerlines have no ballast profile, sleepers, switches, loading platforms, or grade crossings;
- industrial service lanes and storage alleys are underrepresented as surfaces;
- narrow tactical footpaths through Dorms woods, construction, and river banks are not captured comprehensively.

The exact cache will not solve road geometry. The existing centerlines are a good seed; first-party drive/walk transects should add width changes, surface events, junction polygons, bridge endpoints, and vertical profiles.

### Water

Three reaches cover outer polygon areas of roughly 6,833.6, 3,520.8, and 4,580.5 m², at nominal levels `-0.09`, `0.39`, and `0.75`, each with 1.2 m constant depth. The first includes one island hole. This is sufficient for a flat cartographic ribbon, not a river:

- adjacent reaches should not have unexplained discrete levels without a surveyed grade/drop;
- shoreline needs bank top, water edge, and shallow-shelf lines;
- ford and bridge beds require local bathymetry and collision/clearance;
- culverts, reeds/wet margins, debris, and under-bridge shadow/structure are missing.

Survey both banks at 5 m cadence, tightening to 1 m at corners, ford limits, islands, and bridge abutments. Log water surface `y` separately from ground `y`.

### Vegetation

Customs has 2,348 explicit trees and 37 understory polygons totaling 20,418.6 m² (4.1% of the playable rectangle). This conveys “some wooded areas” but not real forest edges or sightline control. Priority areas are Dorms woods, riverbanks, sniper ridge/checkpoint, construction margins, and the eastern perimeter. First-party panoramic screenshots plus entry/exit points along transects are sufficient to define landcover polygons and tactical openings; individual-tree surveying should be reserved for landmark trees and critical lanes.

### Props and clutter

Eighty-seven props are far below near-real density. Highest-value missing classes are:

- cooling towers, tanks, pipe racks, pumps, ducts, catwalks, industrial stacks;
- container stacks with orientation/height, pallets, drums, crates, forklifts;
- concrete walls, Jersey barriers, sandbags, wire, gates, guardrails;
- buses, cars, trucks, tankers, wrecks, rail wagons, cranes and crane booms;
- construction columns, rubble piles, excavators, rebar, scaffolds;
- signs, light poles, utility poles/pylons, transformers, cables;
- checkpoint booths, roadblocks, fuel pumps, canopies;
- dumpsters, furniture, shelves, lockers, machinery, and interior occluders.

The current quest dataset already provides several exact semantic anchors that the 3D builder ignores, including four fuel-tank objectives near `(430,16)`, `(101,-14)`, `(335,-190)`, and `(-335,-163)`, plus vehicle-inspection positions. Import these only through an allowlist because quest trigger volumes are not universally physical object footprints.

### Underground and upper levels

Six rectangles represent ZB-1011, ZB-1012, Old Gas, Switch Basement, ZB-013, and Boiler underground areas. They are silhouettes, not rooms/tunnels, and are not connected vertically to entrances. The floor selector exposes rectangular level areas rather than traversable floors. Priority upper/underground work is:

1. Dorms floor slabs, rooms, corridors, stairs, and apertures;
2. Big Red upper office and access;
3. Fortress upper circulation and mounted positions;
4. ZB-1011/ZB-1012/ZB-013 entrances, stair/shaft profiles, rooms, and door volumes;
5. Old Gas/Switch basements only where visible or tactically relevant.

## Reserve

### Current inventory

- **56** building components covering **19,716.0 m²** (9.01% of playable rectangle).
- Floor assignments: 40 one-floor, 7 two-floor, 2 three-floor, 4 four-floor, 3 five-floor.
- 55 box styles and one gable; almost no building-type variety.
- **44** explicit props: 11 containers, 6 railcars, 4 tanks, 1 tanker, 21 vehicles, 1 crane.
- Roads: 1,472 m dirt and 4,485 m main; rail 1,171.5 m; no bridge records.
- 112 trees, 72 rock features, no water (appropriate at map scale).
- Terrain evidence: 409 accepted samples over 0.219 km²; best of the three maps, but still smooth between structural surfaces.
- 10 underground silhouettes, dominated by Command at 12,660 m² and Storage at 7,242.8 m².

### Buildings

Reserve's macro footprint coverage is the strongest of the three maps, but nearly every shell is a generic box. That is particularly damaging here because the chess buildings, Dome, rail station, garages, and underground entrances are visually and tactically distinct.

#### Pawn/Bishop/King buildings: floor/height contradictions

- **White Pawn:** main component `(-103.4,93.5)`, 5 floors but only 8 m; second component `(-61.8,79.6)`, one floor.
- **Black Pawn:** main `(-164.2,55.3)`, 5 floors / 15.7 m; another component at `(-154.5,108.1)` is one floor.
- **White Bishop:** `(-67.3,-30.1)`, 3 floors / 16.8 m.
- **Black Bishop:** `(-146.4,-5.6)`, 3 floors / 8.3 m.
- **White King:** components around `(-17.1,17.3)` and `(-47.5,6.4)`, with no actual internal machinery, server rooms, passages, or openings.
- **Helipad region:** a footprint at `(-96.2,36.6)` is classified as 5 floors / 16.1 m due a broad floor extent or nearest-place association, despite being labeled “Helipad / Helicopter.”

These inconsistencies prove that rectangular level extents cannot assign building floors by themselves. Exact lock/loot `y` clusters should seed floor planes; each major building then needs a verified identity manifest and survey.

#### Dome / White Queen

**Region:** components around `x=-42..-10`, `z=172..192`; main Dome center `(-10.3,175.3)`, 4 floors / 21.5 m.

The main height is plausible as a coarse mass, but the output does not model the spherical radar dome, support structure, antennae, railings, rock/platform interface, access building, stair/tunnel entry, or exact floor connections. Exact lock data near `y=23.42` and surface/underground route points provide vertical anchors. A reusable radar-dome primitive plus survey is appropriate.

#### Knights, train station, depot, and barracks

- Black Knight components around `(-5.8,13.3)` and `(19.1,2.5)` and White Knight `(82.3,-30.9)` need garage bays, ramps, roof profiles, workshop openings, and vehicle clutter.
- White Rook / Train Station `(161.1,-151.1)` is a 2-floor, 17.1 m gable; its platform, tracks, doors, roof bays, railcars, towers, and Hermetic connection are not represented physically.
- Military Guard Barracks components near `x=157..188`, `z=-257..-215` are boxes with no wall/fence/yard identity.
- K-storage buildings from `x≈6..52`, `z≈-158..-67` have macro shells but not loading doors, service alleys, overhead utilities, stacked materiel, or exact bunker entrances.

### Terrain and hard surfaces

Reserve's base terrain range is `-7.0..21.4 m`, but exact cache entities extend from roughly `y=-21.91` to `32.90`, and task/lock evidence reaches `y≈-29.31` underground. This should not expand the ground heightfield; it demonstrates multiple surfaces.

Priority surface corrections:

- **Dome hill:** `x≈-70..20`, `z≈150..220`. Capture the rock mass, road switchbacks, retaining cuts, radar platform, cliff faces, and tunnel entrances as hard surfaces. A smoothed heightfield cannot represent near-vertical rock.
- **Chess-building courtyards/helipad:** `x≈-180..100`, `z≈-60..125`. Survey building pads, ramps, sunken entries, walls, stairs, and the helicopter pad plane.
- **Rail/storage south:** `x≈0..220`, `z≈-260..-60`. Add rail ballast/embankments, platform levels, Hermetic ramps, and bunker access depressions.
- **Map perimeter/bounds:** validate cliffs, walls, mine/sniper boundaries, and extraction grades against exact volumes rather than raster edges.

The worst evidence gap lies near `x=-220..-190`, `z=230..260`, with up to 155.8 m to an accepted point—precisely where topography and perimeter rocks matter.

### Roads and rail

The 4.5 km “main” classification is too coarse for Reserve's mix of paved parade roads, service lanes, concrete pads, rail crossings, ramps, and tunnel approaches. There are six rail centerlines but no sleepers, ballast, switches, buffers, platform edges, level crossings, or railcar placement fidelity. Vehicle yards need drivable-surface polygons rather than overlapping strokes.

First-party survey should record centerline `y`, left/right edges, surface, width, curb/ditch events, junction polygon, and obstruction. The rail yard deserves a separate schema because track gauge, switch nodes, platform offsets, and rolling-stock alignment can be generated deterministically from a surveyed centerline graph.

### Vegetation

Reserve appropriately has far fewer trees than Woods, but **112 trees over 0.219 km²** and only 2,064.7 m² of masks still underspecify the perimeter groves, courtyard plantings, Dome slopes, and sightline-breaking shrubs. Here the major visual gain is not blanket density; it is correct tree clusters and scrub edges around Dome, perimeter walls, and building courts. Survey landcover polygons, then place only landmark trees explicitly.

### Props and military clutter

Reserve is a military base, yet it has 44 explicit props. The public reference shows dense, identity-defining clutter:

- BMPs/tanks/APCs, trucks, fuelers, forklifts, railcars and armored trains;
- the central helicopter, radar/dish components, antennae and mast arrays;
- sandbags, HESCO/concrete barriers, guard booths, gates and perimeter wall segments;
- cargo pallets, crates, barrels, cable reels, generators, floodlights;
- train switches, buffers, platforms and loading equipment;
- bunker blast doors, ventilation stacks, ducts, pipes and electrical cabinets;
- rubble, destroyed vehicles, weapon emplacements, and checkpoint furniture.

Exact quest zones already contain four useful BMP-like inspection anchors around `(-100,-156)`, `(54,123)`, `(79,-32)`, and `(102,64)`. The exact cache also has eight stationary weapons. These can seed a verified prop manifest; they should not be procedurally scattered.

### Underground: the dominant fidelity deficit

Current output creates ten underground polygons at nominal depth 4, including one 12,660 m² “Command” silhouette centered roughly `(-91,89)` and one 7,242.8 m² “Storage” silhouette near `(80.5,-97.9)`. They are rendered as surface-draped overlays. This misses the defining structure:

- D-2 extraction rooms and approach;
- command bunker corridors/rooms under the chess buildings;
- connected tunnels among Pawns, Bishops, King, and Dome approaches;
- storage/Hermetic bunker rooms and ramps;
- doors, blast gates, shafts, stair flights, elevation changes, and surface access nodes.

Exact current locks reach around `y=-11.1`; task-zone evidence reaches `y=-29.31`. The public tunnel map demonstrates connectivity but is a visual/non-commercial source. The production network should therefore be surveyed as a graph:

```text
node: exact (x,y,z), kind=door|turn|landing|room-center|shaft|extract
edge: from/to, width, height, slope/stairs, material, blocked state
room: boundary at floor y, ceiling y, openings[], props[]
portal: surface feature ID ↔ underground node ID
```

Sample every corridor turn and door threshold, every stair landing, and every 2–3 m along sloped passages. A topology-complete low-detail tunnel is worth more than a visually rich but disconnected room.

## Woods

### Current inventory

- **121** components, but 9 are synthetic pylons and many Train Depot/freight shapes are treated as buildings.
- **9,702.7 m²** of building footprint, only 0.67% of the playable rectangle.
- Every non-pylon structure is one floor and 4 m high; styles are 67 boxes and 54 gables.
- **44** explicit props: 22 containers (including 12 log-related records), 4 piers, 2 plane parts, 12 vehicles, 3 walls, 1 crane.
- Roads: 3,257.8 m dirt, 3,447.6 m main, 30.5 m small, 826.4 m track; only 535.7 m rail.
- 11 water polygons, 2,298 trees, 335 rocks.
- No underground output and no upper-floor boxes.
- Terrain evidence: 798 accepted points across 1.444 km²; only 23.9% of 10 m cells lie within 25 m of evidence.

### Terrain: Sniper Mountain is numerically wrong by more than 50 m

This is the most severe provable error in the audit.

| World `(x,z)` | Generated terrain `y` | Exact current zone/entity `y` | Difference | Meaning |
|---|---:|---:|---:|---|
| `(-209.22,-279.78)` | 23.85 | 77.52 | -53.67 m | Sniper Mountain summit/task zone |
| `(-219.23,-224.43)` | 27.60 | 64.62 | -37.02 m | upper mountain/high-rock zone |
| `(-156.09,-273.32)` | 22.20 | 52.27 | -30.07 m | mountain flank/high zone |

The SPT spawn evidence itself reaches `y=61.46`, but `ingest-elevation.mjs` rejects `ZoneBigRocks` and `ZoneHighRocks` and rejects all `y>=55`. Those guardrails prevent rock/roof points from corrupting a single-valued ground heightfield, but the output has no separate rock-surface layer to receive them. The result is a low rounded hill where a massive central rock/mountain should exist.

**Required fix:** keep the base earth terrain conservative, but route high-rock evidence and first-party survey into a triangulated/parametric rock-mass layer with lower contact ring, ridge/summit lines, cliff faces, traversable shelves, and holes/overhangs where visible. Survey the mountain at high density; do not simply lift a Gaussian hill to 77.5 m.

### Other terrain regions

- **Northern ponds/wetlands:** roughly `x=-100..280`, `z=-725..-430`. The nine smaller water polygons confirm multiple basins, but banks, peat/wet ground, rock outcrops, and narrow land bridges need explicit shore and hard-surface samples.
- **Sunken Village:** buildings from `x=-155..-48`, `z=-749..-621`. Survey depressed pads, flooded/sunken edges, road cuts, walls, and the transition into wetland.
- **USEC Camp/ridge:** `x≈272..308`, `z≈-514..-435`. Camps, rock shelves, berms, mines/bounds, ramps, and vehicle pads are smoothed into terrain.
- **Old Sawmill:** `x≈-566..-477`, `z≈-217..-169`; **Sawmill:** `x≈-27..78`, `z≈-43..47`. Both need yard pads, lumber piles, road crowns, depressions, shoreline relation, and structure foundations.
- **Military Camp:** `x≈-211..-168`, `z≈210..271`. The camp surface, tents/containers, trenches/berms, walls, and road approach are not captured.
- **Train Depot:** `x≈-740..-533`, `z≈105..182`. Current terrain around `(-615,140)` is about 9.02 m; exact Depot task zones around `x=-615..-684`, `z=106..154` also sit near 8.09 m, so the broad datum is plausible. The missing fidelity is hard rail/pad/ditch geometry and object identity, not a gross vertical offset.
- **Southeastern evidence void:** worst coverage around `x=520..560`, `z=-270..-230`, over 200 m from accepted samples. Survey perimeter grade, road/path, forest floor, and any mine/sniper boundary transition.

### Buildings and compounds

All non-pylon Woods structures are serialized as one floor / 4 m. This removes legitimate height and type variation among houses, cabins, mill buildings, guard structures, bunkers, tents, industrial sheds, and depot buildings.

#### Sunken Village / Scav Town

Sunken Village has seven coarse buildings around `x=-155..-48`, `z=-749..-621`; Scav Town has about fifteen around `x=-511..-447`, `z=-434..-333`. The footprints indicate compound existence but lack porches, fences, sheds, doors/windows, roof variation, destroyed walls, gardens, vehicles, and interior rooms visible through openings.

#### USEC Camp and Military Camp

USEC Camp has five shells around `x=272..308`, `z=-514..-435`; Military Camp has roughly fourteen small components around `x=-211..-168`, `z=210..271`. The source SVG “building” category cannot distinguish tents, containers, bunkers, watch structures, canopies, and permanent buildings. A semantic object manifest is required before visual refinement.

#### Sawmill / Old Sawmill

Both compounds have only a handful of 4 m boxes/gables. Near-real fidelity requires sawmill sheds, open frames, log stacks, lumber piles, machinery, vehicles, trailers, cabins, fences, and yard surfaces. The current 12 log-container records are a start but not a spatial reconstruction.

#### Train Depot / Railway Bridge label contamination

Twenty-one components around `x=-739..-633`, `z=105..182` are assigned the place “Railway Bridge to Tarkov.” Many are freight/industrial objects or small structures rather than one named building. All are treated as 4 m building shells. The public Depot reference shows cranes, railcars, platforms, sandbags, armored vehicles/trucks, barriers, buildings, and a much denser track environment.

The first action is semantic: reclassify each source element as `building`, `railcar`, `container`, `platform`, `crane`, `wall`, `bridge`, or `misc-prop`, keyed by source ID/centroid. Then survey pose and vertical datum for the landmark objects.

### Roads, trails, and rail

Woods has about 7.56 km of road centerline but only 0.83 km classified as track/trail, even though public visual references show a dense web of narrow dirt paths and tactical desire lines. Near-real priorities are:

- distinguish paved road, graded dirt road, two-track, foot trail, muddy rut, and cleared utility corridor;
- record widths and split/merge polygons rather than using one width per class;
- create road cuts/fills, ditches, culverts, bridge abutments, and wet crossings;
- capture the three bridge structures: Bridge V-Ex near `(-505,-530)`, Friendship Bridge near `(74,-876)`, and rail bridge around `(-700,118)`;
- rebuild the Depot rail graph with gauge, ballast, switches, sidings, platforms, buffers, and rolling stock;
- survey routes through forest edges because path geometry and vegetation openings must agree.

### Water

The 11 polygons are a meaningful macro asset:

- nine northern ponds/wetlands between approximately `x=-93..278`, `z=-725..-429`, with nominal levels around 9.2–23.7 m;
- one very large boundary/northern-river polygon (about 93,781 m²) spanning `x=-845.5..169.4`, `z=-943.6..246.9`, nominal level 9.31 m;
- the southern lake (about 89,284 m²) spanning `x=-95.5..214.1`, `z=90.3..479.3`, nominal level -12.57 m.

All use 2.5 m constant depth. The two large polygons extend beyond playable bounds and the renderer does not clip them. The main lake basin, northern river, ponds, marshes, and channels therefore look like flat plates and may render outside intended limits.

Priority corrections:

1. clip render geometry to an explicit visual/world boundary while retaining full source shape for provenance;
2. survey water-surface `y` at multiple points to detect distinct pools/reaches;
3. trace first-party water edge, bank top, and wetland edge separately;
4. add shallow shelves/thalweg constraints and bridge/culvert interaction;
5. model reeds/marsh/shore materials as landcover, not random trees.

At ZB-014, an exact lock point around `(448.62,-13.27,65.58)` and nearby quest zones around `x≈443..449`, `z≈66..71`, `y≈-15..-13` confirm a subterranean bunker surface near the eastern/lake-side terrain. Do not mistake those low points for lake bathymetry.

### Vegetation: the dominant surface-appearance deficit

Woods carries 2,298 trees across 1.444 km²: **15.92 trees/ha** over the whole map. Its 145 understory polygons cover only 51,151 m², or **3.54%** of the playable rectangle. Even allowing for clearings, rock, compounds, and water, that is not a near-real representation of a forest landscape.

The issue is not simply “multiply tree count.” Tactical fidelity depends on:

- true forest-edge boundaries around Scav Town, Sunken Village, camps, Sawmill, lake, ponds, roads, and power corridor;
- species/height/age clusters (conifer, broadleaf, sapling, snag);
- underbrush density and height;
- explicit clearings, lanes, trails, stump zones, log piles, and canopy gaps;
- rock/tree exclusion and shoreline/wetland species transitions;
- landmark trees and fallen trunks where they affect navigation or sightlines.

Use first-party panoramic transects to map landcover polygons. Then procedural placement can fill each polygon deterministically using surveyed density/species parameters. This preserves efficiency without inventing the forest edge.

### Props and clutter

Forty-four props over this map cannot describe the camps, mills, villages, convoy, crash site, Depot, checkpoints, and utility infrastructure. Missing high-value classes include:

- log/lumber stacks, saw equipment, forklifts, sheds, trailers, fuel tanks;
- tents, containers, sandbags, camouflage netting, crates, generators, watch positions;
- convoy trucks/APCs, wrecks, ambulances, roadblocks, signs;
- plane wreck sections, debris trail, cargo and impact-ground changes;
- Train Depot railcars, crane geometry, platforms, armored vehicles, barriers and floodlights;
- village fences, gates, porches, garden structures, furniture visible through openings;
- power pylons with cables/insulators and cleared right-of-way;
- rocks/boulders/cliffs as 3D masses rather than flat polygons;
- fallen trees, stumps, logs, brush piles, and shoreline debris.

Exact task zones provide a useful semantic seed for Depot, USEC/convoy, bunker, and mountain locations. They should be whitelisted one entity at a time and verified visually/surveyed; a quest trigger volume is often larger than the object it references.

### Underground and upper levels

Woods currently emits no underground areas despite exact evidence for bunkers:

- **ZB-014:** lock around `(448.62,-13.27,65.58)`; nearby task/bunker zones at `y≈-15..-13`.
- **Mountain bunker entrance:** approximately `(-282.79,12.88,-414.77)`; generated terrain at the horizontal coordinate is about 9.46 m.
- **Scav bunker/radio area:** around `(222.16,21.38,-706.6)`, likely surface/entry evidence rather than an underground floor.
- a Woods bunker/quest zone around `(-256,9.58,9.7)` requires field verification before classifying it as ZB-016.

At minimum, each bunker needs entrance portal, stairs/slope, floor/ceiling slabs, room outline, door/lock volume, and connection to the surface terrain. Upper floors are less important than on Customs/Reserve, but towers, elevated platforms, bridge decks, and large mill/depot structures still need explicit upper surfaces.

# Part C — ranked improvement plan

## How to read the estimates

“Fleet-hours” (FH) means aggregate focused implementation, data preparation, review, and deterministic verification time across the team; it is not elapsed calendar time. Raid capture time is shown separately where it materially constrains the task. Estimates assume the present codebase and do not include negotiation time for third-party licenses.

The scope column uses:

- **Shared / Customs gate:** changes the common pipeline; Customs must pass structural and visual regression before Reserve/Woods are accepted.
- **Per-map:** data or geometry unique to one map.
- **Shared + per-map:** reusable schema/generator plus authored map records.

“Fetchable” means technically obtainable from the network today. It does **not** mean automatically cleared for commercial redistribution.

## Combined priority order

| Rank | Improvement | Lane | Scope | Expected fidelity gain | Estimated effort | Principal risk/dependency |
|---:|---|---|---|---|---:|---|
| 1 | Preserve and use all live tarkov.dev exact 3D primitives | Fetchable F1 | Shared / Customs gate | Very high evidence quality; immediate doors/floors/hazards/props gain | 10–16 FH | Schema drift, dedupe, provenance |
| 2 | Add a canonical building/feature identity manifest and floor-height assertions | Fetchable + authored F2 | Shared / Customs gate | Very high; fixes visibly wrong landmark types and vertical contradictions | 14–24 FH | Manual ID mapping must be reviewed |
| 3 | Establish true-scale 1× fidelity mode and vertical-contract tests | Pipeline F3 | Shared / Customs gate | High correctness for very little code; prevents cartographic exaggeration becoming canonical | 5–9 FH | Should be exposed only with Woods mountain fix ready |
| 4 | Rebuild Woods Sniper Mountain as a surveyed hard terrain/rock mass | Survey S1 | Per-map Woods, shared hard-surface primitive | **Extreme**; corrects a 30–54 m proven error and the central silhouette | 24–40 FH, including 6–10 raid-hours | Survey access/safety; non-single-valued rock geometry |
| 5 | Route rejected evidence into typed surfaces and emit confidence/provenance | Fetchable F4 | Shared / Customs gate | High enabling gain; stops discarding mountains, floors, and bunkers | 12–20 FH | Misclassification; needs strict source tags |
| 6 | Import a whitelisted semantic prop-anchor layer from exact quest/map data | Fetchable F5 | Shared + per-map | High per effort: fuel tanks, BMPs, Depot/bunker/convoy anchors | 8–14 FH | Quest volumes may exceed object bounds; whitelist only |
| 7 | Correct Customs eastern industrial landmark geometry, led by the three cooling towers | Survey S2 | Per-map Customs + reusable industrial primitives | Very high skyline and place-recognition gain | 24–38 FH, including 4–7 raid-hours | Dimensions require survey; reference-art license |
| 8 | Build Reserve's underground network as true stacked rooms/edges/portals | Survey S3 | Per-map Reserve + shared level graph | Extreme tactical/topological gain | 50–85 FH, including 10–16 raid-hours | Largest authoring task; vertical/topology QA |
| 9 | Replace the partial SVG parser with semantic normalization | Fetchable F6 | Shared / Customs gate | High macro completeness: floors, uses, lines, fences, mines, objects | 24–40 FH | CC BY-NC-SA permission/commercial compatibility first |
| 10 | Upgrade roads/rails/bridges from strokes to profiled surface graphs | Mixed F7/S4 | Shared + per-map; Customs gate | High continuous visual gain across every view | 30–52 FH plus 4–8 raid-hours/map | Width/elevation survey; junction complexity |
| 11 | Rebuild Woods landcover, forest edges, and tactical clearings | Survey S5 | Per-map Woods + shared landcover scatterer | Very high environmental and sightline gain | 40–70 FH, including 10–18 raid-hours | Individual-tree perfection is infeasible; parameterize |
| 12 | Add shoreline/bank/bed data and clip water geometry | Mixed F8/S6 | Shared + Customs gate, per-map surveys | Medium/high; removes flat-plate rivers/lakes and bad bridge contact | 20–34 FH plus 3–7 raid-hours/map with water | Water level access and seasonal appearance |
| 13 | Model high-value interiors/openings: Dorms, Big Red, Fortress, Reserve chess buildings, Woods bunkers | Survey S7 | Shared schema + per-map | Extreme at close range; modest whole-map silhouette gain | 90–160 FH, including 18–30 raid-hours | Scope explosion; visible/interactable spaces first |
| 14 | Build reusable prop kits and surveyed landmark manifests | Mixed F9/S8 | Shared + per-map | High cumulative realism and scale cues | 45–90 FH for first kit + priority placements | Asset production/licensing; avoid random clutter |
| 15 | Expand long-tail facade, utility, vegetation, and clutter coverage compound by compound | Survey S9 | Per-map | Medium per increment; necessary for the final near-real target | 120–250+ FH | Diminishing returns and QA load |

Ranks 1–6 are foundational and should be one milestone. Rank 4 can run in parallel with that foundation because its survey is independent. Rank 9 is conditional on resolving SVG rights; if rights are not resolved, replace it with first-party tracing/survey rather than delaying the rest of the plan.

## Fetchable-data lane

### F1. Exact map primitive cache

**What:** add a version-pinned ingest of `json.tarkov.dev/regular/maps` that retains full 3D geometry for extracts, transits, spawns, locks, switches, hazards, loose loot, loot containers, stationary weapons, BTR stops, and artillery zones.

**Source:** live tarkov.dev JSON cache, with SPT 4.1.2 used only as a separately tagged corroborating/current-build input.

**Ingest sketch:** 

```js
// scripts/fetch-map-primitives.mjs (proposed)
const raw = await fetchPinned(JSON_CACHE_URL);
assertSchema(raw, MAP_PRIMITIVE_SCHEMA_VERSION);
for (const map of wantedMaps(raw)) {
  const out = [];
  for (const [kind, rows] of supportedCollections(map)) {
    for (const row of rows) {
      out.push({
        source: 'tarkov.dev-json', sourceRevision, kind,
        sourceId: row.id,
        position: exactXYZ(row.position),
        size: optionalXYZ(row.size),
        outline: optionalXYZRing(row.outline),
        top: optionalNumber(row.top), bottom: optionalNumber(row.bottom),
        semantic: normalizeSemanticFields(row),
        confidence: 'exact-source'
      });
    }
  }
  writeDeterministicRawLayer(map.id, sortByStableKey(out));
}
```

Then derive display markers without mutating the raw layer. Crosswalk by stable ID first, normalized name second, and distance only as a flagged last resort. Do not merge Wiki and cache records just because they are nearby.

**Expected gain:** exact doors/locks and vertical floor clusters; all mine/sniper hazards; exact loot/container density anchors; Reserve stationary weapons; Woods BTR route; 3D extraction/transition volumes.

**Risk:** API schema drift, uncertain embedded-data licensing, duplicate entities across modes/sources, accidental use of loot points as terrain. Mitigate with source snapshots, schema tests, per-kind use rules, and raw/derived separation.

**Effort:** 10–16 FH. **Scope:** shared; Customs regression gate.

### F2. Canonical feature identity and architectural constraints

**What:** create per-map manifests that assign stable identity and physical class to every important source polygon/component; stop using nearest place/floor rectangles as the final verdict.

**Source:** current SVG source IDs/centroids, exact cache point clusters, current quest/task zones, and independently verified labels. No new third-party tracing is required for the first correction pass.

**Ingest sketch:** 

```json
{
  "sourceKey": "svg:Buildings:path-42:subpath-0",
  "centroidXZ": [231.0, 149.8],
  "featureId": "customs.dorms.two_story.main",
  "class": "building",
  "archetype": "masonry-dormitory",
  "floorPlanesY": [0.8, 3.84],
  "heightM": 7.2,
  "review": { "method": "exact-lock-cluster+survey", "status": "needs-survey" }
}
```

Builder checks should reject or loudly flag impossible combinations, duplicate landmark IDs, place-label leakage, footprint collisions, and `height / floors` outside an archetype range.

**Expected gain:** immediately fixes Dorms 2-Story, White Pawn, Bishop, Helipad, Train Depot label pollution, cooling-tower classification, and similar high-salience errors.

**Risk:** an override file can become opaque technical debt. Require stable source keys, a reason/evidence field, centroid drift alarms, and review-by version.

**Effort:** 14–24 FH for framework and three-map priority manifest. **Scope:** shared; Customs regression gate.

### F3. True-scale vertical mode and invariant suite

**What:** make 1× vertical scale the canonical “fidelity” world. Retain 3× only as a named vector/cartographic view transform. Test terrain, floor, water, bridge, underground, and object placement in world meters before view transforms.

**Source:** current game-coordinate convention and exact cache/task/survey anchors.

**Implementation sketch:** separate `worldY` from `viewY`; serialize only real meters; apply optional presentation exaggeration in the camera/view layer. Add fixtures for Big Red upper lock, Reserve bunker/Dome points, ZB-014, and Woods summit.

**Expected gain:** correctness across every downstream system and eliminates accidental dependence on 3× relief.

**Risk:** switching immediately exposes the flattened Woods mountain and other subtle terrain. Land behind a named fidelity mode until S1 passes, then make it default.

**Effort:** 5–9 FH. **Scope:** shared; Customs regression gate plus required Woods anchor tests.

### F4. Typed evidence routing and confidence surface

**What:** replace the accepted/rejected binary terrain filter with classification into `ground`, `road`, `rock`, `building-floor`, `roof`, `underground`, `water`, `unknown-isolated`. Retain every point and rejection reason. Emit distance-to-evidence/confidence tiles for audit tooling.

**Source:** existing SPT points, exact cache entities, and future survey logs.

**Ingest sketch:**

```js
for (const p of allEvidence) {
  const classification = classifyEvidence(p, semanticZones, neighbors);
  evidenceBuckets[classification.kind].push({ ...p, classification });
}
baseTerrain = interpolate(evidenceBuckets.ground, { barriers: hardEdges });
rockSeeds = cluster3D(evidenceBuckets.rock);
floorSeeds = clusterByBuildingAndY(evidenceBuckets['building-floor']);
emitConfidence(baseTerrain, evidenceBuckets.ground);
```

At build end, report counts by source/kind/reason and fail on unexpected deltas. The current Woods `ZoneHighRocks` exclusion should become a rock-layer route, not deletion.

**Expected gain:** directly enables the mountain, floor, and bunker work; exposes underconstrained terrain regions instead of presenting interpolated cells as equal confidence.

**Risk:** semantic misclassification can create worse surfaces. Start with conservative routing and manual review of clusters; never let non-ground buckets modify terrain automatically.

**Effort:** 12–20 FH. **Scope:** shared; Customs regression gate.

### F5. Whitelisted exact semantic prop anchors

**What:** turn a small set of exact task/map locations into named prop anchors where the task clearly references one physical object.

**Source:** existing `public/data/quests.json`, the live cache, and current task-zone data. Examples: four Customs fuel tanks, four Reserve BMP inspection positions, Woods Depot/convoy/bunker points.

**Ingest sketch:** maintain `data/semantic-prop-allowlist.json` keyed by source task/zone ID. Each record declares physical class, whether the source point is center/interaction/volume, expected maximum offset, and review status. A build script resolves only allowlisted IDs and refuses fuzzy name matching.

**Expected gain:** fast, exact placement of visually distinctive assets and survey waypoints.

**Risk:** many task zones describe areas, triggers, or interactions rather than object bounds. Never infer dimensions from a zone unless its semantics explicitly support that; mark anchors as a point with uncertainty radius.

**Effort:** 8–14 FH. **Scope:** shared plus per-map allowlist.

### F6. Standards-complete SVG normalization, conditional on rights

**What:** parse all relevant SVG primitives and transforms into a normalized, stable intermediate representation while preserving layers/source IDs.

**Source:** the dedicated tarkov.dev SVGs.

**Ingest sketch:** use a maintained XML/SVG path library; recursively resolve transform matrices and `<use>` references; convert rect/line/polyline/polygon/path/circle/ellipse; adaptively flatten curves to a declared world-space tolerance (for example 0.15 m); repair rings; preserve holes and group hierarchy; then map SVG space to game `(x,z)` using pinned metadata.

**Expected gain:** recovers omitted fences, floor shapes, objects, minefields, repeated elements, bunker entrances, and more faithful curved geometry. It also makes semantic manifests durable.

**Risk:** **license gate.** CC BY-NC-SA 4.0 may be incompatible with the live product's intended use. Get written permission/legal review before increasing reliance. Parser correctness also needs golden fixtures for transforms/arcs/holes.

**Effort:** 24–40 FH. **Scope:** shared; Customs is the parser regression fixture because it has the richest mix (`<use>`, floors, circles, underground).

### F7. Road/rail/bridge surface graph

**What:** replace independent strokes with a graph whose edges carry width, surface, vertical profile, shoulder/ditch/curb, and whose nodes carry junction polygons. Add rail gauge, switch, ballast, platform, and crossing records; add bridge deck/abutment/pier/clearance records.

**Source:** current road/rail centerlines as seeds, source SVG where licensed, exact survey profiles for width/elevation and missing trails.

**Build sketch:** snap endpoints within a tolerance; split crossings; resolve classes; sweep cross-section meshes along sampled `worldY` profile; blend junctions; carve or overlay terrain using explicit priority rules. Rail mesh is generated from a track graph, not a widened road line.

**Expected gain:** high because roads and rails are continuous visual structures and provide scale/grade cues across all maps.

**Risk:** terrain z-fighting, self-intersections, bad junction triangulation, and overfitting uncertain centerlines. Use a diagnostic wireframe and per-segment provenance.

**Effort:** 30–52 FH plus per-map survey. **Scope:** shared; Customs' river crossings, rail yard, and mixed classes are the regression gate.

### F8. Water system schema and mesh

**What:** represent separate water surface, bank-top, water-edge, wetland-edge, and bed constraints; clip visual geometry; integrate bridges/culverts.

**Source:** current SVG polygons where allowed plus first-party shoreline/water-level surveys.

**Build sketch:** normalize/clip rings, preserve source polygon outside playable bounds, split reaches by surveyed level, triangulate surface with holes, construct shore strip between bank and edge, interpolate a conservative bed between shallow shelf and thalweg constraints, and explicitly subtract bridge piers/culverts where required.

**Expected gain:** medium/high on Customs and Woods; low on Reserve. Removes the flat-plate appearance and spatial conflicts.

**Risk:** invented bathymetry can imply false walkability. Mark unsurveyed bed as visual-only/non-navigable and keep collision conservative.

**Effort:** 20–34 FH plus survey. **Scope:** shared; Customs river is the regression gate.

### F9. Reusable near-real prop/archetype library

**What:** define code-native parametric kits for repeated non-branded structures—cooling towers, tanks, pipes, railcars, container stacks, concrete barriers, pylons, lights, simple vehicles, sandbags, log stacks, fences, road signs—and a manifest format for pose/variant/damage.

**Source:** independently authored geometry based on measured dimensions and first-party observations; do not copy game meshes or unlicensed artist assets.

**Build sketch:** each archetype exposes physical parameters and LODs; instances carry exact `(x,y,z)`, yaw, scale, variant, damage/visibility, source, and confidence. Procedural variation must be seeded by stable feature ID.

**Expected gain:** makes surveyed coordinates visually useful and avoids bespoke modeling for every recurring object.

**Risk:** authored geometry can accidentally imitate copyrighted meshes too closely; use generic real-world forms and independently measured proportions. Performance/LOD budget must be tested.

**Effort:** 45–90 FH for first priority kit and placements. **Scope:** shared + per-map manifests; Customs industrial pass is the first gate.

## First-party survey lane

### Survey log contract

Every route below should write a structured log rather than only screenshots:

```json
{
  "map": "woods",
  "gameBuild": "...",
  "timestamp": "...",
  "position": { "x": -209.22, "y": 77.52, "z": -279.78 },
  "yawDeg": 135.0,
  "tag": "rock-ridge",
  "featureId": "woods.sniper_mountain.ridge.07",
  "event": "sample",
  "screenshotId": "...",
  "notes": "traversable shelf; cliff east"
}
```

Minimum tags: `ground`, `road-center`, `road-edge`, `rail`, `shore-water`, `shore-bank`, `rock-contact`, `rock-ridge`, `cliff-top`, `cliff-bottom`, `building-corner`, `threshold`, `floor`, `stair-landing`, `corridor-turn`, `door`, `window`, `tree-edge`, `understory-edge`, `prop-anchor`, `water-level`.

Sampling rules:

- ordinary terrain/road/forest transect: every 5 m and at every slope/surface change;
- shore, stairs, openings, bunker corridors, small props: every 1 m or every geometric event;
- large flat pads/floors: corners + center + every elevation discontinuity;
- panoramas: four cardinal views at landmark nodes, with yaw and screenshot ID;
- keep terrain samples on exposed ground; tag roofs/floors/rocks explicitly rather than pretending they are ground;
- capture at least one closed loop per landmark so coordinate drift and missed connections are detectable.

### S1. Woods mountain, rock, lake, and northern wetland survey

**Highest-value route:** start at Scav Bunker/radio around `(220,-704)`, traverse the USEC Camp/ridge around `(290,-475)`, run a closed Mountain Spine circuit covering roughly `x=-300..-130`, `z=-430..-190`, capture the summit around `(-209,-280)`, and descend toward the northern ponds around `x=-100..200`, `z=-600..-430`. A second loop should follow the southern lake shore from approximately `(-95,90)` around the accessible edge toward `(214,454)`.

**Capture:** lower rock contact ring, ridge/summit lines, cliff top/bottom, traversable shelves, cave/bunker portals, path crossings, forest edge, shore water/bank/wetland edges, and exact water levels.

**Ingest:** `scripts/ingest-survey.mjs` validates bounds/build/version, classifies tags, deduplicates within 0.25 m, and produces separate ground/rock/water/landcover evidence. Build the mountain as a hard mesh, not an unconstrained terrain interpolation.

**Gain:** corrects Woods' central silhouette and navigation reference, then supplies the hardest forest/water transitions.

**Risk:** dangerous/inaccessible sniper zones may prevent direct summit loops. Use safe accessible contours and exact existing summit/task points; mark occluded faces as lower confidence instead of inventing them.

**Effort:** 24–40 FH including 6–10 raid-hours. **Scope:** Woods + reusable hard-surface support.

### S2. Customs landmark and grade survey

Run four linked routes:

1. **Eastern industrial:** `x≈450..650`, `z≈-150..50`, including all three cooling-tower bases, Water Pump, Warehouse 7, Depot, tanks, pipes, road edges, tower-base pads, and visible height-angle baselines.
2. **Construction:** `x≈60..280`, `z≈-180..40`, including Crackhouse, Fortress, Old Construction, Skeleton, slabs, ramps, columns, rubble, and road/rail grades.
3. **Dorms/Big Red:** perimeter and every visible/accessible floor for Dorms at `x≈165..243`, `z≈125..190`; Big Red at `x≈-223..-190`, `z≈-135..-85`.
4. **River/crossings:** both banks through `x≈-120..-39`, `z≈-246..146`, tightening at Main/Junk bridges and ford.

**Capture:** landmark dimensions, exterior corners, floor/threshold `y`, openings, pad grades, prop anchors/poses, bridge decks/abutments/piers, road widths, shoreline/water levels, and forest edges.

**Gain:** fixes the worst Customs skyline error and supplies the regression map with representative industrial, interior, road, river, and vegetation data.

**Risk:** tower height cannot be measured from a single point. Use two or more surveyed baselines/angles or known real-world structural ratios, and retain uncertainty until cross-checked.

**Effort:** 38–64 FH for all four loops; eastern industrial priority subset 24–38 FH including 4–7 raid-hours. **Scope:** Customs; exercises shared schemas.

### S3. Reserve underground and vertical-building survey

**Route:** begin at D-2/underground approach around the exact task depth near `y=-29.31`; traverse every accessible tunnel to Command, Pawn/Bishop/King access nodes, and Dome approach; separately traverse the storage/Hermetic network roughly under `x=20..128`, `z=-208..-33`. Close each loop at a known surface portal. Surface passes should cover White/Black Pawn, Bishops, King, Dome, Knights, train station, and Hermetic entries.

**Capture:** every threshold and door plane, corridor turn, room boundary, stair landing, slope endpoint, shaft, blast gate, floor/ceiling estimate, surface portal, and exact lock/switch/extract volume. For buildings, capture floor planes and exterior aperture rows before decor.

**Ingest:** create the node/edge/room/portal graph described in Part B, validate connectivity, then extrude low-detail corridors/rooms. Doors reference exact cache IDs. Surface building floor records reference the same portal IDs.

**Gain:** transforms Reserve from a surface diagram into a faithful multi-level map; highest tactical information gain in the project.

**Risk:** missed portal or wrong `y` breaks route topology. Validate graph reachability and have a second independent traversal review every branch.

**Effort:** 50–85 FH including 10–16 raid-hours. **Scope:** Reserve + shared stacked-level graph.

### S4. Road/rail profile surveys

- **Customs regression loop:** Crossroads → Big Red/rail → river bridges/ford → Construction → Old/New Gas → eastern industrial → Dorms return.
- **Reserve loop:** Dome switchbacks → chess-building courts → Knight garages → storage/Hermetic → rail station/yard.
- **Woods loop:** Bridge V-Ex → Scav Town/Sunken Village → northern ponds/USEC → Sawmill/lake → Military Camp → Train Depot/rail bridge, split across raids as needed.

At each class change or junction, record center, both edges, surface, width, `y`, curb/ditch/shoulder, bridge/culvert, and obstruction. For rail, record centerline nodes, switches, platform edges, crossings, buffers, and rolling-stock anchors.

**Effort:** 4–8 raid-hours and 12–20 processing FH per map, overlapping with other survey routes. **Scope:** shared data model, per-map data.

### S5. Woods landcover transects

Use multiple cross-map transects rather than attempting to log every tree:

- Sunken Village `(-80,-680)` → northern ponds → Mountain/USEC edge → eastern boundary;
- Old Sawmill `(-520,-185)` → Mountain Spine → Sawmill `(20,10)` → Scav House `(414,241)`;
- lake shore → Military Camp `(-190,235)` → Bus Stop `(-236,360)` → Train Depot `(-650,140)`;
- walk both sides of the power-line corridor and major roads to record cleared width and regrowth.

Log entry/exit for forest, dense understory, sparse understory, clearing, wetland, stump/log field, rock exclusion, and path corridor. Take cardinal panoramas at each transition and rough canopy-density counts in fixed-radius sample plots.

**Ingest:** hand-review/merge the traversed boundaries into landcover polygons; attach species mix, stems/ha, height distribution, understory density, and seed. Explicitly place only landmark/fallen trees and tactical blockers.

**Effort:** 40–70 FH including 10–18 raid-hours. **Scope:** Woods + shared landcover generator.

### S6. Shoreline and water-profile surveys

- **Customs:** both river banks, island, ford, Main/Junk bridge interfaces, culvert/drain transitions.
- **Woods:** nine northern ponds, reachable northern river margins, the full accessible main-lake shore, Friendship/rail bridge contacts.

Capture water surface separately, then paired water-edge/bank-top samples and conservative shallow-depth probes only where observable/permitted. Record wetland/reed transitions and inaccessible segments as such.

**Effort:** 3–7 raid-hours/map plus 8–14 processing FH. **Scope:** per-map data, shared water builder.

### S7–S9. Interior, prop, and long-tail passes

After the macro/vertical foundation is stable:

1. **Interior priority:** Customs Dorms → Big Red → Fortress/Crackhouse; Reserve Command/D-2 → Pawns/Bishops/King → Knights/Rook; Woods ZB bunkers → mill/depot structures. Model visible/interactable rooms first, then inaccessible rooms as exterior-only volumes.
2. **Prop priority:** Customs cooling-tower/industrial and construction; Reserve central military yard/rail/storage; Woods Sawmill/USEC/convoy/Depot.
3. **Long tail:** facade openings, utilities, walls/fences, minor sheds, vegetation clusters, debris and interior furniture compound by compound.

Use an “evidence first, mesh second” rule: no production placement without a source record, coordinate confidence, and feature ID. Survey screenshots can guide independently authored generic geometry, but game meshes/textures remain prohibited.

## Shared-pipeline regression gate

Customs should gate any shared change because it exercises the widest feature mixture: multiple road classes, long rail network, river/island/bridges/ford, multi-floor and underground areas, industrial/tank/frame/gable structures, vegetation, power lines, and the most varied SVG constructs.

Minimum automated acceptance for every shared-pipeline change:

1. deterministic output bytes or a reviewed, explained manifest diff;
2. coordinate transform fixtures at map corners and at least five exact landmark anchors;
3. no loss of source IDs/provenance;
4. no building floor/height invariant violations;
5. no invalid/self-intersecting rings after normalization;
6. no water/road/building NaN or out-of-bounds geometry without an explicit clipping/provenance flag;
7. terrain error report at exact ground anchors plus separate reporting for rock/floor/underground anchors;
8. stable counts by feature class and an allowlisted reason for count changes;
9. renderer test in 1× fidelity mode and 3× cartographic skin, proving world data does not change;
10. performance budgets for triangle/instance counts and LOD transitions.

Map-specific hard gates:

- **Customs:** Dorms 2-Story is two floors; Big Red upper office anchor is retained; cooling towers are not tank/box primitives; three river crossings align with roads and banks.
- **Reserve:** exact upper/underground anchors are assigned to distinct surfaces; the bunker graph is connected between verified portals; White Pawn/Bishop height/floor contradictions are gone.
- **Woods:** surface/rock representation reaches the exact 77.52 m summit anchor without raising surrounding base ground indiscriminately; ZB-014 stays underground; water clips correctly; landcover retains surveyed clearings.

## Definition of “near-real” for the next phase

The goal should be measurable. A useful acceptance target for the first near-real milestone is:

- 100% of named major landmarks have a stable feature ID, correct physical class, surveyed/verified footprint, and plausible height/floor count;
- all exact source points/volumes are retained in raw data with provenance and classified to the correct surface type;
- terrain within high-priority traversable areas has a ground observation within 15 m, tightening to 5 m at roads, shores, ridges, entrances, and hard grade changes;
- every major road/rail segment has class, measured width, vertical profile, and connected junctions;
- every water body has surveyed surface level, shoreline, bank transition, and explicit uncertainty for bed depth;
- every surface/upper/underground portal is connected in a level graph;
- Woods forest edges and tactical clearings are surveyed even if individual trees remain procedural;
- high-salience prop zones meet a reviewed manifest rather than a global random-density target;
- canonical data renders at 1× vertical scale; alternative vector relief is a reversible view transform only.

# Top ten findings

1. **Woods' central mountain is missing as a true physical feature.** The generated surface is 23.85 m at an exact 77.52 m summit anchor, a -53.67 m error caused by routing high-rock evidence to rejection rather than a rock layer.
2. **Reserve's underground is a diagram, not a 3D network.** Broad flat silhouettes replace connected rooms, corridors, stairs, doors, and portals reaching approximately `y=-29.31`.
3. **A high-value exact source is live but underused.** `json.tarkov.dev/regular/maps` currently provides full 3D points/volumes for locks, hazards, extracts, transits, loot, weapons, and more; current output flattens or discards much of it.
4. **The three Customs cooling towers are the wrong object class and scale.** Low 6–9 m tank/box components occupy the Water Pump region where enormous cooling towers should define the skyline.
5. **Building semantics create provable contradictions.** Dorms 2-Story has three floors; White Pawn has five floors in eight meters; a Helipad-adjacent footprint gets five floors; many Woods freight objects become “Railway Bridge” buildings.
6. **The default 3× relief is a cartographic effect, not near-real geometry.** It visually hides missing elevation while breaking true slopes, height relationships, and line-of-sight scale. The canonical dataset is capable of 1× and should use it.
7. **Object density is orders of magnitude short of near-real.** TarkovZero has only 87/44/44 explicit props for Customs/Reserve/Woods; public reference authors describe 18,788/3,703/27,042 modeled objects under broader definitions.
8. **Woods is not represented as a forest landcover system.** It has 15.92 explicit trees/ha over the whole map and understory masks cover only 3.54%; real forest edges, clearings, paths, wetlands, and tactical lanes are largely procedural guesses.
9. **Roads, rails, and water have connectivity but little construction.** Centerline strokes and constant-depth flat polygons omit cross-sections, grades, switches, platforms, banks, beds, abutments, piers, culverts, and junction form.
10. **The best visual references are not clean production data.** Re3mr and dedicated map SVGs are CC BY-NC-SA; MapGenie/Tarkov-Market are proprietary; client extractors are prohibited. The sustainable fidelity path is exact permitted APIs plus TarkovZero-owned surveys and independently authored geometry.

# Appendix A — exact network sources and current status

All statuses below were personally fetched or inspected on **2026-08-29**. A 200 response means the resource was reachable during the audit, not that its license authorizes production reuse.

## tarkov.dev and the-hideout

| Resource | Exact URL | Audit result |
|---|---|---|
| Live regular map cache | `https://json.tarkov.dev/regular/maps` | HTTP 200; 9,568,349 bytes; `Last-Modified: Sat, 29 Aug 2026 23:34:30 GMT` |
| English map metadata cache | `https://json.tarkov.dev/regular/maps_en` | HTTP 200; 22,962 bytes; `Last-Modified: Wed, 26 Aug 2026` |
| PvE map cache | `https://json.tarkov.dev/pve/maps` | HTTP 200 |
| Development map cache | `https://json.tarkov.dev/dev/maps` | HTTP 200 |
| GraphQL | `https://api.tarkov.dev/graphql` | POST returned HTTP 422, body reporting GraphQL server unavailable |
| Alternate site GraphQL path | `https://tarkov.dev/api/graphql` | POST returned HTTP 405 |
| Historical Vercel mirror | `https://tarkov-api.vercel.app/graphql` | HTTP 404 |
| Frontend cache request implementation | `https://raw.githubusercontent.com/the-hideout/tarkov-dev/main/src/modules/api-request.mjs` | HTTP 200; confirms cache route behavior |
| Map metadata | `https://raw.githubusercontent.com/the-hideout/tarkov-dev/main/src/data/maps.json` | HTTP 200; inspected and compared with local metadata |
| Dedicated SVG repo | `https://github.com/the-hideout/tarkov-dev-svg-maps` | HTTP 200 |
| Dedicated SVG license | `https://raw.githubusercontent.com/the-hideout/tarkov-dev-svg-maps/main/LICENSE.md` | HTTP 200; CC BY-NC-SA 4.0 plus anti-cheat condition |
| Customs SVG | `https://assets.tarkov.dev/maps/svg/Customs.svg` | HTTP 200; 190,123 bytes; parsed |
| Reserve SVG | `https://assets.tarkov.dev/maps/svg/Reserve.svg` | HTTP 200; 87,545 bytes; parsed |
| Woods SVG | `https://assets.tarkov.dev/maps/svg/Woods.svg` | HTTP 200; 134,316 bytes; parsed |
| Customs tile probe | `https://assets.tarkov.dev/maps/customs_0.16/main/0/0/0.png` | HTTP 200 |
| Reserve tile probe | `https://assets.tarkov.dev/maps/reserve/main/0/0/0.png` | HTTP 200 |
| Woods tile probe | `https://assets.tarkov.dev/maps/woods/main_0.16/0/0/0.png` | HTTP 200 |
| Public map-art directory | `https://github.com/the-hideout/tarkov-dev/tree/main/public/maps` | HTTP 200; authors/files inspected |

The GraphQL availability probe used a JSON POST equivalent to:

```http
POST https://api.tarkov.dev/graphql
Content-Type: application/json

{"query":"query { maps { id name normalizedName } }"}
```

The count audit selected map records with normalized names for Customs, Reserve, and Woods, then enumerated their `extracts`, `transits`, `spawnPositions`, `locks`, `switches`, `hazards`, `lootContainers`, `lootLoose`, `stationaryWeapons`, `btr`, and `artillery` collections. For volume-bearing records it verified the presence of `position`, `size`, `outline`, `top`, and `bottom` rather than counting a marker icon as geometry.

## SPT

| Resource | Exact URL/path | Audit result |
|---|---|---|
| Legacy server repo | `https://github.com/sp-tarkov/server` | Reachable; location database and NCSA-era repository context inspected |
| Current C# server repo | `https://github.com/sp-tarkov/server-csharp` | Reachable; current database layout and LICENSE inspected |
| Legacy Customs base | `project/assets/database/locations/bigmap/base.json` | Inspected via repository/local pinned data |
| Legacy Reserve base | `project/assets/database/locations/rezervbase/base.json` | Inspected |
| Legacy Woods base | `project/assets/database/locations/woods/base.json` | Inspected |
| Legacy loose loot | `project/assets/database/locations/{bigmap,rezervbase,woods}/looseLoot.json` | Git files are LFS pointers; direct LFS object delivery failed during audit |
| Legacy static containers | `project/assets/database/locations/{bigmap,rezervbase,woods}/staticContainers.json` | Inspected; main positions zeroed / IDs only |
| C# asset root | `Libraries/SPTarkov.Server.Assets/SPT_Data/database/locations/` | Inspected in current repo |
| SPT 4.1.2 release | `https://spt-releases.modd.in/SPT-4.1.2-40743-cf04a11.7z` | HTTP 200; viable route to the pinned server JSON used by current pipeline |

Relevant fields inspected in `base.json` included `SpawnPointParams`, collider/position/rotation fields, `OpenZones`, waves, boss zones, exits, transits, bounds, and `doors`. No public server-side mesh, heightmap, navmesh, building footprint set, water geometry, or useful static-container transforms were found.

## EFT Wiki / Fandom API

Base API:

```text
https://escapefromtarkov.fandom.com/api.php
```

Page parse query template used:

```text
https://escapefromtarkov.fandom.com/api.php?action=parse&page=Customs&prop=sections%7Cimages%7Clinks%7Cexternallinks%7Cwikitext&redirects=1&format=json&origin=*
```

`page` was replaced with `Reserve`, `Woods`, `Map:Customs`, `Map:Reserve`, and `Map:Woods` as appropriate. Site rights were checked through:

```text
https://escapefromtarkov.fandom.com/api.php?action=query&meta=siteinfo&siprop=rightsinfo&format=json&origin=*
```

Verified interactive-map records:

| Page | Revision ID | Base image size | Marker count |
|---|---:|---:|---:|
| `Map:Customs` | 355611 | 4097×2142 | 523 |
| `Map:Reserve` | 355616 | 4701×2785 | 496 |
| `Map:Woods` | 355623 | 6994×6843 | 402 |

Direct location pages inspected:

- `https://escapefromtarkov.fandom.com/wiki/Customs`
- `https://escapefromtarkov.fandom.com/wiki/Reserve`
- `https://escapefromtarkov.fandom.com/wiki/Woods`

## Re3mr visual references

| Reference | Exact URL | Local audit copy |
|---|---|---|
| Customs page | `https://reemr.se/customs/` | n/a |
| Customs overview | `https://maps.reemr.se/Customs/re3mrCustoms2.png` | `references/customs-reemr.png` |
| Customs Dorms | `https://maps.reemr.se/Customs/re3mrCustomsDorms.png` | `references/customs-dorms.png` |
| Reserve page | `https://reemr.se/reserve/` | n/a |
| Reserve overview | `https://reemr.se/maps/Reserve/Re3mrReserveLossless.png` | `references/reserve-reemr.png` |
| Reserve tunnels | `https://maps.reemr.se/Reserve/re3mrReserveTunnels.png` | `references/reserve-tunnels.png` |
| Woods page | `https://reemr.se/woods/` | n/a |
| Woods overview | `https://www.reemr.se/maps/Woods/WoodsRe3mrPNG.png` | `references/woods-reemr.png` |
| Woods Train Depot | `https://reemr.se/maps/Woods/TrainDepotHQ.png` | `references/woods-train-depot.png` |

The downloaded images were inspected locally for topology, landmark identity, prop/vegetation density, and omissions only. They were not used to modify production data.

## Other community sources checked

| Source | Exact URL | Result |
|---|---|---|
| Tarkov-Market Customs | `https://tarkov-market.com/maps/customs` | HTTP 200; semantic inline SVG inspected/count-audited |
| Tarkov-Market Reserve | `https://tarkov-market.com/maps/reserve` | HTTP 200; semantic inline SVG inspected/count-audited |
| Tarkov-Market Woods | `https://tarkov-market.com/maps/woods` | HTTP 200; semantic inline SVG inspected/count-audited |
| Tarkov-Market ToS | `https://tarkov-market.com/legal/tos` | HTTP 200; automation/scraping and ownership clauses inspected |
| MapGenie Customs | `https://mapgenie.io/tarkov/maps/customs` | HTTP 403 during audit |
| MapGenie Reserve | `https://mapgenie.io/tarkov/maps/reserve` | HTTP 403 |
| MapGenie Woods | `https://mapgenie.io/tarkov/maps/woods` | HTTP 403 |
| tarkov.help Customs | `https://tarkov.help/en/map/customs` | HTTP 200; JS/proprietary map, no open geometry located |
| tarkov.help Reserve | `https://tarkov.help/en/map/reserve` | HTTP 200 |
| tarkov.help Woods | `https://tarkov.help/en/map/woods` | HTTP 200 |
| TarkovTracker data | `https://github.com/TarkovTracker/tarkovdata` | Bounds/assets duplicate upstream sources; no novel mesh/heightmap |
| TarkovLab data | `https://github.com/TarkovLab/TarkovData` | Task/world positions and same SVG ecosystem; no novel clean 3D geometry |
| TarkovTracker overlay | `https://github.com/tarkovtracker-org/tarkov-data-overlay` | MIT corrections/overlay; no geometry corpus |
| sayser mirror | `https://github.com/sayser/TarkovTracker` | API/SVG snapshots; fallback rather than novel source |
| Raid Signal map | `https://github.com/QTtrash/tarkov-map` | Apache app; asset ledger points upstream |
| Tarkov Nexus | `https://github.com/ObsidianNetwork/Tarkov-Nexus` | Coordinate-logging/screenshot workflow reference |
| Atlas | `https://github.com/ConocoFieldsForever/atlas` | Client extractor; prohibited output path |
| SPT MapCleaner | `https://github.com/DrakiaXYZ/SPT-MapCleaner` | Client-map export/cleanup; prohibited output path |
| Old monK maps | `https://github.com/monK87/EFT-Maps` | Stale raster/source art, no usable license found |
| Old glory4lyfe maps | `https://github.com/glory4lyfe/EFT-Maps` | Stale art, no usable license found |
| Old 3D map art | `https://github.com/caioctt/tarkov-3dmaps` | Flat/outdated JPG presentation only |
| Backend dump | `https://github.com/carlsmei/tarkovdata` | Redundant SPT-like config; ambiguous third-party provenance |

Representative GitHub searches performed broadly enough to test the premise of an open independent geometry corpus:

```text
https://github.com/search?q=%22escape+from+tarkov%22+map+coordinates&type=repositories
https://github.com/search?q=tarkov+heightmap&type=repositories
https://github.com/search?q=tarkov+navmesh&type=repositories
https://github.com/search?q=%22SPT%22+%22map+data%22&type=repositories
https://github.com/search?q=tarkov+svg+map&type=repositories
```

No openly licensed, independently surveyed heightmap, navmesh, or building/scene mesh for Customs, Reserve, or Woods was verified. Results that did expose terrain/navmesh relied on installed client files and were rejected.

# Appendix B — exact local inputs and audit artifacts

## Production inputs inspected

```text
docs/AGENT-ONBOARDING.md
docs/MAP-BUILD-PLAYBOOK.md
docs/plans/PROGRESS.md
docs/plans/ELEVATION.md
scripts/build-3d.mjs
scripts/ingest-elevation.mjs
scripts/build-community-data.mjs
src/map3d.js
src/terrain.js
src/water.js
src/trees.js
public/data/customs.json
public/data/reserve.json
public/data/woods.json
public/data/customs-3d.json
public/data/reserve-3d.json
public/data/woods-3d.json
data/customs-props.json
data/reserve-props.json
data/woods-props.json
data/customs-roads.json
data/reserve-roads.json
data/woods-roads.json
data/woods-yards.json
public/data/quests.json
```

Current generated 3D hashes:

```text
9de71f7e59994de5c60c6cb6f3bfbc656a5c40d1832b51245bb491a83fccbeee  public/data/customs-3d.json
2d8ca348deaffa4fbd80643ce91cc997ec67910699c999099bc0179502608348  public/data/reserve-3d.json
00606d0791b92c6cb9129c35955f45afd4cec334cd68052a33685300c4d50645  public/data/woods-3d.json
```

These match the prefixes recorded for the latest fix pass in `docs/plans/PROGRESS.md`.

## Scratch-only audit scripts

```text
scratch/codex-3d-audit/audit-current.mjs
scratch/codex-3d-audit/audit-svg.mjs
scratch/codex-3d-audit/audit-community.mjs
```

Reproduction commands:

```bash
node scratch/codex-3d-audit/audit-current.mjs
node scratch/codex-3d-audit/audit-svg.mjs
node scratch/codex-3d-audit/audit-community.mjs
```

The scripts are diagnostic and do not mutate production files.

## Downloaded visual-reference hashes

```text
4c34f91babe1b673cf96665e86cfe76ddf7dda0dd9bf0761826d188f1c36a6d8  references/customs-dorms.png
ae142108844d12f2dacd394965fb664cefd9a52c03bfca151066200aae33abad  references/customs-reemr.png
b00692eba5c04cdab77429edca280b6bb5d2328da3420c852185c4dc5ce6066f  references/reserve-reemr.png
f7c786a58d0ccab5ebee953347e38e4b4492da1cb8eac33b2b8a3d1e1b932eb4  references/reserve-tunnels.png
2ae933f667d1b70ca48d2fde97336a9a5c807be3589a8c838092cf14202c2e85  references/woods-reemr.png
42af5c9f9a51f364bd22da6865ef233a50e0a99397eb54912efec3ab0487c0f0  references/woods-train-depot.png
```

Paths are relative to `scratch/codex-3d-audit/`. These copies remain source reference material subject to the original CC BY-NC-SA terms and should not be shipped as TarkovZero assets.

# Appendix C — limitations and judgment calls

- No headless browser was available or used, as requested. Public raster references were fetched directly and inspected as local image data.
- No live in-game survey was performed, and the current terrain metadata reports zero first-party survey points. All proposed survey coordinates are route anchors, not claims that a complete route is safely traversable in one raid.
- Public maps are artistic/cartographic products. Object counts advertised by their authors are not directly comparable to TarkovZero's `props` array; the report uses them only to establish the order-of-magnitude density gap.
- An exact `y` point on loot, a lock, or a quest trigger is evidence for a surface at that location, but not automatically the ground. This report deliberately separates ground, floor, roof, rock, water, and underground surfaces.
- SVG footprints are not assumed to be exact collision hulls. Their precision is limited by tracing, source art, transform, curve flattening, and the current parser.
- License descriptions are factual audit flags, not legal advice. Permission from the relevant authors or counsel may change what can be used.
- Map content can change with EFT updates. Every ingest and survey must record game/data revision and remain diffable.
- The audit found no clean open mesh/heightmap/navmesh corpus. That negative result is bounded by the repositories and searches listed above; it should be rechecked before a later phase, but not used as a reason to accept client extraction.

# Final recommendation

Do not begin with prettier shaders or a larger random prop scatter. First make the world data honest: retain exact primitives, separate physical surfaces, correct feature identity, and enforce real meters. Then perform three flagship corrections—Woods Mountain, Customs cooling-tower/industrial region, and Reserve's connected bunker graph. Those three areas exercise the hard geometry types the shared schema needs and will reveal whether the new pipeline can truly support a later vector skin without compromising the underlying near-real world.
