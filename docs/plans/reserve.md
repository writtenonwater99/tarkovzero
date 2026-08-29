# Reserve production plan

## Source snapshot

The raw inputs are checked in under `scripts/data/reserve/`:

- `maps-entry.json`: fetched from the tarkov.dev `maps.json` source at commit `d3dc9b8401c9a4312dc5cd6b4e52e0a4e398a5cb` (2026-08-13).
- `Reserve.svg`: fetched from tarkov.dev's asset CDN; viewBox `0 0 827.28742 761.16437`.
- `spt-base.json`: SPT server `project/assets/database/locations/rezervbase/base.json`, master commit `8f1d50fb7ccf35d696a47b587448b9b79f7e8027` (2026-08-09).
- `wiki-api.json` and extracted `wiki-map.json`: `Map:Reserve` fetched through the MediaWiki API with a browser User-Agent.
- `wiki-page-api.json`: Reserve article revision 346590 (2026-06-08), used for current extract requirements and map-limit facts.

Primary URLs:

- https://raw.githubusercontent.com/the-hideout/tarkov-dev/main/src/data/maps.json
- https://assets.tarkov.dev/maps/svg/Reserve.svg
- https://raw.githubusercontent.com/sp-tarkov/server/master/project/assets/database/locations/rezervbase/base.json
- https://escapefromtarkov.fandom.com/api.php?action=query&prop=revisions&titles=Map%3AReserve&rvslots=main&rvprop=content&format=json
- https://escapefromtarkov.fandom.com/wiki/Reserve
- https://reemr.se/ (visual reference only; no asset reuse)

## Exact tarkov.dev map entry

The complete verbatim entry is in `scripts/data/reserve/maps-entry.json`. The interactive projection fields to implement are:

```json
{
  "key": "reserve",
  "projection": "interactive",
  "minZoom": 2,
  "maxZoom": 6,
  "transform": [0.395, 122.0, 0.395, 137.65],
  "coordinateRotation": 180,
  "bounds": [[289, -293], [-303, 244]],
  "svgBounds": [[289, -274], [-303, 272]],
  "svgPath": "https://assets.tarkov.dev/maps/svg/Reserve.svg",
  "svgLayer": "Ground_Level",
  "tilePath": "https://assets.tarkov.dev/maps/reserve/main/{z}/{x}/{y}.png",
  "heightRange": [-7, 10000]
}
```

`tileSize` is 256 in TarkovZero, matching the other interactive tile sets. The important exception is `svgBounds`: tarkov.dev itself overlays the SVG using `svgBounds ?? bounds`. Geometry must therefore use the 592 m × 546 m SVG box, not the 592 m × 537 m tile box.

Both the CRS and SVG use 180°, so no rotated general affine is needed for SVG geometry. With SVG point `(sx,sy)`:

```text
x = 289 - (sx / 827.28742) * 592
z = -274 + (sy / 761.16437) * 546
```

The 27 supplied labels, in game `[x,z]`, are: K Buildings `[28,-102]`; White Queen `[-25,180]`; White Pawn `[-104,93]`; Black Bishop `[-140,-14.5]`; White Bishop `[-67,-30]`; White King `[-49.5,15.5]`; Black Knight `[14.5,-10.8]`; White Knight `[82.2,-30.2]`; White Rook `[149,-124]`; Train Station `[161,-149]` (80%); Black Pawn `[-165,57]`; Barracks `[167,-222]`; E1 Bunkers `[-220,-13]`; E2 Bunkers `[173,-3]`; Д / Warehouse Bunkers `[80,-167]`; Garage `[96,30]` (80%); Mechanic `[55.5,60.6]` (80%); Gas Station `[29.7,29.5]` (80%); Shipping Yard `[-31,-150]` (80%); K1 `[-1,-71]`, K2 `[66,-90]`, K3 `[-5.5,-94]`, K4 `[60,-112]`, K5 `[-10.5,-115]`, K6 `[54,-132]` (all 80%); Dome `[-8.5,175]` (80%); Tarmac `[-120,37]` (80%). Preserve the supplied rotations and add only useful extract/tunnel detail labels.

### Floor extents

Reserve has authoritative upper-floor and bunker extents; the height pairs are real game `y`:

- 2nd Floor: Dome `[[-17,164],[1,199]]` at 22.1–25.7; Pawns `[[-177,26],[-77,106]]` at -3.5–-0.64; checkpoint fence tower `[[51,59],[62,108]]` at -3.5–-0.64; Black Bishop `[[-177,-37],[-104,5]]` at -3.5–-0.64; White Bishop `[[-85,-47],[-47,-18]]` at -3.9–-0.6; White King `[[-78,-13],[-19.91,39]]` at -4.3–-2.2; Knights `[[-2,-50],[99,7]]` at -3.8–-1.1; train depot `[[137,-175],[191,-120]]` at -1.9–11.3; five tower boxes at y 1–8; Scav Lands `[[-146,-139],[-128,-120]]` at -4.1–-1.2.
- 3rd Floor: Dome 25.7–29.3; Pawns -0.64–2.23; Black Bishop -0.64–2.23; White Bishop -0.6–10; White King -2.2–2.14; Knights -1.1–1.6, using the same boxes above.
- 4th Floor: Dome 29.3–36; Pawns 2.23–5; White King 2.15–6.6; Knights 1.6–4.7.
- 5th Floor: Pawns 5–9.5.
- Bunkers: storage bunker `[[18,-208],[128,-33]]` and command bunkers `[[-176,-42],[-46,127]]` below -7.27; D-2 `[[-124,124],[-40,189]]` below -12; dome tunnels `[[-65,173],[23,189]]` below 18; Hermetic bunkers `[[19,-196],[74,-149]]` at -7.27–-3.2; E1 `[[-274,-79],[-246,-53]]` and east bunkers `[[126,-26],[238,45]]` at -11–-4.6.

Floor assignment will count distinct covering layers as on Customs, but Reserve building ground is around y=-7, so wall height must be computed as top extent minus local terrain/base rather than treating an absolute negative upper-floor height as a short building. Bunker extents are navigation volumes, never terrain samples.

## SVG inventory and interpretation

The SVG has two top-level layers. Counts are source paths before compound paths are flattened.

| Group | Class | Paths | Use |
|---|---|---:|---|
| `Ground_Level` | — | 1 direct | Surface container/base layer. |
| `Terrains` | `land` | 1 | Playable land/ground fill. Confirm whether this or `Fence_ext` is the clipping ring. |
| `Dirty_roads` | `gravel` | 2 | Gravel/dirt service roads and tracks; classify by width/setting. |
| `Roads` | `tarmac` | 1 | Paved road network. |
| `Fence_ext` | `map_border` | 1 | Primary playable limit candidate. |
| `Fences_int` | `fence` | 31 | Interior fences; cut gates at roads. |
| `Trees` | `trees` | 11 | Tree/wooded polygons. |
| `Rocks` | `rock` | 73 | Rock/cliff footprints, especially Dome and boundary mountain. |
| `Railroad` | `railroad` | 6 | Rail lines/yard tracks. |
| `Concrete` | `cement` | 7 | Tarmac, aprons, courtyards, and hardstand. |
| `Bunker_entr` | `building` | 6 | Surface bunker mouths; render as low concrete entrance structures. |
| `Buildings` | `building` | 50 | Surface footprints. |
| `Misc` | `misc` | 36 | Inspect individually: walls, pads, small structures, barriers. |
| `Bunkers` | `floor shadow` | 2 | Separate underground linework; use for tunnel footprint/reference, not surface extrusion. |

The parser must understand Reserve's group aliases rather than Customs ids. Compound paths will be separated after flattening; holes and subpaths must not become accidental solid buildings.

## SPT data

Location database id/path: `RezervBase` / `locations/rezervbase/base.json` (`Name: ReserveBase`). `base.json` contains:

- 196 `SpawnPointParams`; all-y range -15.5040054 to 21.43 m.
- Category memberships: Player 79, Bot 76, Boss 16, Coop 41, Group 21, Opposite 20. Side memberships: All 79, Savage 76, PMC 41.
- Named AI-zone coverage: ZoneRailStrorage 21, ZoneBarrack 15, ZoneSubCommand 11, ZoneSubStorage 9, ZoneBunkerStorage 8, ZonePTOR1/2 6 each; 120 player/general points have no `BotZoneName`.
- Glukhar (`bossGluhar`) at 30% in ZoneRailStrorage, ZonePTOR2, ZoneBarrack, or ZoneSubStorage, with security followers. Zero-chance/event/PMC entries remain excluded from the UI boss summary.
- Six exit rule records: EXFIL_Train, Alpinist, EXFIL_ScavCooperation, EXFIL_Bunker, EXFIL_vent, and EXFIL_Bunker_D2. They give names/requirements/timers but no coordinates.

Terrain filtering is deliberately not a simple y cutoff: surface baseline is roughly -7 m, Dome ground samples rise above 15 m, while command/storage bunker samples are around -12 to -15 m. Reject points inside known bunker extents when their y is below the extent's ceiling; reject underground zones (`ZoneSubCommand`, `ZoneSubStorage`) for the surface field; retain genuine Dome/high-rock points; exclude points clearly on roofs/towers by category, local neighbors, and SVG footprint containment.

## Wiki marker inventory and calibration

The current interactive payload declares image `Reserve Interactive Map Base.png`, bounds `[[0,0],[4701,2785]]`, origin `bottom-left`, coordinate order `xy`, and 496 markers. Counts:

- extracts: 7 PMC, 9 Scav, 3 transit (duplicates across factions are merged by name only where appropriate);
- contacts: 16 PMC, 12 Scav, 5 Glukhar, 2 Raider-area markers;
- objects used by TarkovZero: 34 locked doors, 8 stationary guns, 3 levers/buttons;
- remaining loot containers: ammo 1, supply crates 34, corpses 7, drawers 67, duffles 62, wooden crates 38, grenade boxes 21, jackets 31, medcase 1, medbags 5, PCs 15, safes 4, toolboxes 41, weapon boxes 63, key spawns 7.

The sheet is composite: surface plan plus detached 1F–5F and underground panels. Marker coordinates such as D-2 `[4569.68,1646.14]` live on the underground-south inset, while Armored Train `[911.59,1893.10]` is on the surface. Therefore:

1. Classify marker coordinates into the surface polygon or a named inset rectangle.
2. Fit a full 2D affine for the surface (Reserve art is rotated relative to game axes, so independent x/z fits are insufficient).
3. Fit panel-specific affines only when at least three reliable room corners/doors exist; otherwise map important underground markers explicitly from tarkov.dev extents and omit uncertain locked-door coordinates rather than publishing confident-looking errors.

Surface calibration candidates (minimum four, use more in the actual least-squares fit):

| Wiki marker | Wiki `[x,y]` | Game anchor and rationale |
|---|---:|---|
| Armored Train | `[911.59,1893.10]` | Train Station label `[161,-149]` / train-depot extent center `[164,-147.5]`. |
| Scav Lands (Co-Op) | `[2150,2226]` | Scav Lands extent center `[-137,-129.5]`. |
| Checkpoint Fence | `[1576.5,574]` | Checkpoint fence tower extent center `[56.5,83.5]`; adjust to the visible gate, not tower center, during overlay check. |
| RB-ST / White Knight | `[1291,998.5]` | White Knight label `[82.2,-30.2]` and Knights box; door offset measured from the SVG footprint. |
| RB-KPRL / White Queen | `[2179.04,561.75]` | White Queen label `[-25,180]`; door offset measured from its footprint. |
| Cliff Descent | `[2061,353.5]` | Dome/Cliff area near Dome label `[-8.5,175]`, checked against the rock/fence edge. |

For residual testing, hold out at least two of the above plus surface gun emplacements. Target: <5 m median and <8 m max for surface markers. Do not include imprecise label centers in the reported residual without first moving the anchor to the corresponding SVG door/gate. D-2, its lever/button, bunker keys, and upper-floor room keys are validated under their panel transform independently.

### Calibration execution record

The build pass replaced the preliminary label-centre candidates with 13 direct correspondences between wiki surface `spawn_pmc` symbols and clustered SPT `Player` points. The fitted surface transform is:

```text
game x = -0.1893631553·wiki x - 0.04999996777·wiki y + 394.9645524
game z =  0.04888619387·wiki x - 0.1884791050·wiki y + 168.9507743
```

Residuals for wiki ids 378, 379, 380, 381, 383, 384, 385, 386, 387, 388, 389, 392, and 393 are respectively 1.7, 0.6, 1.3, 1.3, 1.8, 0.6, 0.6, 2.2, 1.6, 1.2, 1.8, 6.6, and 1.8 m (median 1.3 m). Marker 392 remains the single surface outlier. Surface-panel locked rooms are emitted; uncertain detached floor-panel locks are deliberately omitted. D-2, its two controls, Bunker Hermetic Door, and Depot Hermetic Door use explicit game-coordinate overrides because their wiki symbols are on detached underground panels.

## Terrain and underground strategy

Reserve's identity is the contrast between a low, engineered rail/base plateau and the steep Dome/mountain side.

- Use a 10 m true-scale terrain grid over SVG bounds plus 40 m pad.
- Seed IDW with filtered surface SPT points as described above. Preserve actual negative world heights; deck.gl can render them because all features are draped through `H(x,z)`.
- Hand-authored `TERRAIN_FEATURES` will include: Dome summit/plateau around `[-8,180]` reaching the observed high-surface band (~18–22 m); the south/east mountain mass and cliff boundary; the slope from White Pawn/Queen up to Dome; rocky west/north boundary shoulders; and shallow rail-yard/base grading around -7 to -4 m. Each feature is an irregular ridge/plateau, not a symmetric cone.
- Add hard terrain controls (target plateaus/valleys), not only `max()` hills, so the rail yard and helicopter/tarmac do not inherit Dome elevation by IDW bleed.
- Use the 73 SVG rock footprints as visible cliff/rock masses with scale derived from footprint area and local slope. Large Dome/boundary rocks get multi-metre elevation; small rocks retain the generic low treatment.
- Render bunker extents and the two `Bunkers` paths as underground volumes/paths activated by floor `U`. Surface bunker entrances come from `Bunker_entr`. Never raise surface terrain to match underground spawn y.
- The playable-limit skirt follows the true surface height; Reserve's mountain boundary should read as tall rock/cliff, while fenced/rail edges remain restrained rather than becoming a uniform canyon wall.

Terrain verification: sample `H` at Dome, central helicopter/tarmac, train yard, pawns, and each bunker entrance; compare against nearby retained SPT points; report source/terrain residuals and final range. Check building plinths, roads, rails, fences, and marker stems for drape errors at the Dome slope.

The executed grid is 69×64 at 10 m from 166 retained surface points, with a -7.1..20.8 m range. The first structural pass proved `Fence_ext` excludes the playable Dome spur; the satellite overlay selected the full `Terrains` ring as the correct clipping/skirt limit. The corrected output retains 68 in-limit rock masses with footprint-scaled 1.6..16 m heights.

## Buildings and props

Identity recipes use the official/tarkov.dev labels and floor extents, the wiki map/gallery, and re3mr only as a non-copied visual reference.

| Landmark family | Identity/style | Colour/material direction |
|---|---|---|
| Dome / White Queen | concrete/technical block plus radar sphere and mast scene; authoritative 4-floor extent | weathered grey concrete, pale radar dome, dark antenna steel |
| White/Black Pawn | long 4–5-storey barracks boxes with regular window bands, roof access/stair blocks | pale concrete versus darker/red-brown accents; chess glyph association via label, not copied texture |
| White/Black Bishop | institutional/medical and barracks blocks, 2–3 floors | light concrete, muted roof grey; Black Bishop darker/weathered |
| White King | technical/server building, 4 floors | warm-grey concrete, dark rooftop equipment |
| White/Black Knight | repair garages with wide vehicle doors and 4-floor maximum extents | industrial grey/olive, darker roof and door bays |
| White Rook / Train Station | large rail-depot hall, multi-level extent | yellowed concrete/industrial olive with steel roof |
| K1–K6 / Д storage | repeated low bunker/warehouse modules | olive/tan concrete, dark portals/vents |
| E1/E2 bunkers and entrances | low concrete portal scenes | raw concrete, black openings, earth contact shade |
| Gas Station / Garage / Mechanic | low service/canopy buildings | pale concrete/metal, restrained fuel accents |
| guard towers | narrow elevated platform recipe | concrete/steel, dark glazing |

Props to trace from zoom-5 satellite and cross-check with the wiki base: helicopter and central pad; radar sphere/masts; armored train locomotive/cars and parked railcars; BMP/APC/tank/anti-air vehicles; fuel tanks; containers; concrete barriers; checkpoint booths; antenna/radio structures; loading stacks; train-yard equipment. `Misc` paths will be audited first so existing vector geometry is reused. Satellite conversion uses Reserve ppm `0.395 * 2^5 = 12.64 px/m` and the actual screenshot map-centre pixel.

## Roads, rails, limits, and crossings

- `Roads/tarmac` starts as paved; `Dirty_roads/gravel` starts as dirt/gravel. The large concrete/tarmac aprons are polygons, not extra-wide roads.
- Railroads are independent paths with sleepers and must remain visible through the storage yard.
- Hand trace missing yard/service lanes, Dome switchbacks, checkpoint access, and bunker approaches from zoom-5 satellite. Reclassification is explicit/fixed for compact base roads; no Customs industrial-yard heuristic is reused blindly.
- Run `?map=reserve&base=satellite&debug=roads`; verify every class, clip to `Fence_ext`, cut fence gates, and ensure roads do not continue into mine/sniper void.
- Reserve SVG contains no water group and the map has no river/lake crossing problem. Emit no auto bridges. Overpasses/tunnel passages are modeled only if confirmed visually; underground paths are not surface roads.
- Limit hazards are operational facts, not decorative water: the official Wiki warns of both minefields and border snipers. Trace mine/unsafe boundary zones from the current wiki map as translucent hazards only if their coordinate transform is verified; always keep the hard 3D limit conservative.

## Current gameplay facts to encode/check

From Reserve Wiki revision 346590:

- Raid: 40 minutes, 9–11 PMCs. Glukhar's documented surface/underground areas match SPT's active zones.
- Armored Train is single-use, arrives with roughly 16–12 minutes left, stays seven minutes, and Raiders may appear in the yard.
- Bunker Hermetic Door requires the west-of-White-Pawn lever; activation lasts four minutes with a siren and can trigger Raiders.
- D-2 requires command-bunker power and then the sliding-door button; the action can trigger Raiders underground.
- Cliff Descent requires Red Rebel + paracord and no armor vest; Sewer Manhole requires no backpack; Scav Lands is co-op.
- Exit to Woods requires the Reserve minefield map. The surface boundary also uses minefields and invisible border snipers.
- Transits are available after one minute and sit at specific map borders; no geometry should invite travel beyond them.

## Risks and mitigations

- Composite wiki sheet: largest marker risk. Use panel classification and explicit anchors; omit unresolved inset locks and list them in `PROGRESS.md`.
- Negative surface/floor heights: compute relative extrusion from local base, test each named multi-floor building.
- Dome under-sampling: keep elevated surface points and use ridge/plateau controls; do not use height-only filtering.
- Compound SVG paths/holes: inspect flattened polygon count and centroids; compare vector overlay before extrusion.
- Exterior limit ambiguity (`Terrains` vs `Fence_ext`): overlay both against tiles and use the conservative playable polygon.
- Automated bridge logic is irrelevant and must not invent structures.
- Satellite reference may lag current raid changes; current wiki/SVG/SPT and user playtest outrank visual artwork.

## Execution and verification breakdown

1. Add registry config/labels and confirm Reserve 2D tiles plus vector overlay use `svgBounds`.
2. Generalized community build: load checked-in SPT/wiki inputs, implement surface/panel calibration, print all calibration/holdout residuals, generate marker JSON, and inspect duplicate/shared extracts.
3. Generalized 3D build: parse aliases, establish limit, polygons, buildings, rails/fences/rocks/bunkers; output an unstyled structural pass.
4. Terrain pass: classify SPT points, add plateau/ridge controls, report sample/range diagnostics, inspect north/south/east/west oblique screenshots.
5. Landmark pass: floor-relative heights, styles/colours, Dome scene, entrances/towers; inspect tooltips and floor selector including `U`.
6. Road/rail pass: satellite debug overlay, trace corrections, fence gates, clipping; no bridges.
7. Prop pass: trace the priority silhouette props at zoom 5, then secondary yard clutter.
8. Marker/label pass: ensure all points are inside limit or intentionally at an extract edge; search and filter counts match JSON.
9. Run production build; capture `scratch/reserve-2d.png`, `reserve-3d-fit.png`, four obliques, underground/floor view, and `reserve-roads.png`. Inspect via headless plus a real browser when available.
10. Iterate until structural completeness matches Customs; record only playtest-only uncertainties in `PROGRESS.md`.
