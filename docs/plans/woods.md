# Woods production plan

## Source snapshot

Raw inputs are checked in under `scripts/data/woods/`:

- `maps-entry.json`: current tarkov.dev entry at commit `d3dc9b8401c9a4312dc5cd6b4e52e0a4e398a5cb` (2026-08-13).
- `Woods.svg`: tarkov.dev asset, viewBox `0 0 1472.7926 1420.5995`.
- `spt-base.json`: SPT `project/assets/database/locations/woods/base.json` at master `8f1d50fb7ccf35d696a47b587448b9b79f7e8027` (2026-08-09).
- `wiki-api.json`, extracted `wiki-map.json`, and `wiki-page-api.json`: MediaWiki browser-UA fetches. The article is revision 355184 (2026-08-19).

Primary URLs:

- https://raw.githubusercontent.com/the-hideout/tarkov-dev/main/src/data/maps.json
- https://assets.tarkov.dev/maps/svg/Woods.svg
- https://raw.githubusercontent.com/sp-tarkov/server/master/project/assets/database/locations/woods/base.json
- https://escapefromtarkov.fandom.com/api.php?action=query&prop=revisions&titles=Map%3AWoods&rvslots=main&rvprop=content&format=json
- https://escapefromtarkov.fandom.com/wiki/Woods
- https://escapefromtarkov.fandom.com/wiki/Map_of_Tarkov (minefield/border-sniper behavior)
- https://reemr.se/ (visual reference only; no asset reuse)

## Exact tarkov.dev map entry

The complete entry is in `scripts/data/woods/maps-entry.json`. Implement:

```json
{
  "key": "woods",
  "projection": "interactive",
  "minZoom": 2,
  "maxZoom": 6,
  "transform": [0.1855, 112.95, 0.1855, 167.85],
  "coordinateRotation": 180,
  "bounds": [[646, -914], [-761, 442]],
  "svgPath": "https://assets.tarkov.dev/maps/svg/Woods.svg",
  "svgLayer": "Ground_Level",
  "tilePath": "https://assets.tarkov.dev/maps/woods/main_0.16/{z}/{x}/{y}.png",
  "layers": []
}
```

`tileSize` is 256. There is no separate `svgBounds` and no floor extent data. Rotation is 180°, so SVG geometry uses:

```text
x = 646 - (sx / 1472.7926) * 1407
z = -914 + (sy / 1420.5995) * 1356
```

The 16 supplied labels are: Sawmill `[10,-3]`; Scav Town `[-485,-390]`; Old Sawmill `[-517,-210]`; Cultist Village `[-80,-680]`; USEC Camp `[290,-475]`; Military Camp `[-188,235]`; Ponds `[-5,-515]` (80%); Crash Site `[-252,-37]` (80%); Checkpoint `[239,-65]` (70%); Shack `[244,125]` (70%); Lumber `[-16,-122]` (70%); Cabins `[-3,-74]` (70%); Bus Stop `[-234,357]` (70%); Jaeger's Camp `[-327,19]` (70%); Sniper Rock `[85,-147]` (70%); Convoy `[200,-606]` (70%). Add Scav Bunker, ZB-014/016, Scav House, Outskirts, Friendship Bridge, Bridge V-Ex, northern river, and southern lake only when label density remains legible.

## SVG inventory and interpretation

Counts are source paths before compound-path separation.

| Group | Class | Paths | Use |
|---|---|---:|---|
| `Ground_Level` | — | 0 direct | Surface container. |
| `Base_Terrain` | `land` | 1 | Main land/playable fill candidate. |
| `Dirt` | `gravel` | 1 | Broad dirt/ground area, not automatically a road. |
| `Water` | `water` | 11 | Northern river, southern lake, ponds/wetlands. |
| `Pier` | `wood` | 4 | Docks/wooden crossings; preserve separately. |
| `Dirt_Roads` | `road_gravel road_small` | 1 | Gravel/dirt network. |
| `Roads` | `road_tarmac road_medium` | 15 | Medium paved roads. |
| `Small Roads` | `road_tarmac road_small` | 9 | Narrow paved roads, but audit against satellite for tracks. |
| `Railroad` | `railroad` | 1 | Rail route/extract line. |
| `Fences` | `fence` | 33 | Interior/exterior fences; gate cutting required. |
| `Map_Limit` | `map_border` | 6 | Mine/sniper/edge segments; combine into the conservative playable ring rather than treating each as land. |
| `Rocks` | `rock` | 281 | Core visual identity: boulders, ridges, Sniper Rock/cliffs. |
| `Buildings` | `building` | 111 | Cabins, sawmills, camps, villages, small sheds. |
| `Plane` | `plane` | 2 | Crash Site fuselage/wings; render as a distinct low prop/scene. |
| `Power_Line` | `powerline` | 1 | Pylon/cable route. |
| `Minefield` | `danger` | 4 | Internal/boundary mine areas; hazard polygons and limit evidence. |

Woods has many compound rock/building subpaths. The build will inspect closed/open status, area, and centroid; small closed subpaths become individual objects, while open subpaths never become solid extrusions.

## SPT data

Location id/path: `Woods` / `locations/woods/base.json`. It provides:

- 336 spawn points, y range -20.94 to 61.4642448 m.
- Category memberships: Player 213, Bot 112, All 43, Boss 25, Coop 41, Group 21, Opposite 20. Side memberships: PMC 181 and Savage 155.
- 14 zone names plus unzoned player points. Largest named sets: ZoneDepo 23, ZoneBrokenVill 17, ZoneStoneBunker 15, ZoneClearVill 15, ZoneRoad 14, ZoneWoodCutter 13, ZoneScavBase2 12, ZoneRedHouse 11, ZoneHouse 10, ZoneBigRocks 9, ZoneUsecBase 9, ZoneMiniHouse 6, ZoneHighRocks 1.
- Active bosses: Partisan 30% (global/empty zone); Goons (`bossKnight`) 30% at ZoneScavBase2; Shturman (`bossKojaniy`) 30% at ZoneWoodCutter; Cultist Priest 15% at ZoneMiniHouse and ZoneBrokenVill.
- Nine SPT exit rule records: ZB-016, Outskirts, UN Roadblock, RUAF Gate, ZB-014, South V-Ex, Factory Gate, `un-sec`, and `wood_sniper_exit`; again, names/rules but no coordinates.

Terrain samples must keep the broad surface range but distinguish earth from objects. Exclude points inside building footprints and obvious sniper/roof samples. `ZoneHighRocks` and elevated Sniper Rock points are evidence for the rock mass, not automatically the soil surface; feed them to rock/terrain controls after neighbor comparison. Do not apply Customs' y<15 filter: Woods genuinely rises far above that.

## Wiki marker inventory and calibration

The payload uses `Woods Interactive Map Base.png`, bounds `[[0,0],[6994,6843]]`, origin `bottom-left`, `xy`, with 402 markers:

- extracts: 10 PMC, 12 Scav, 4 transit;
- contacts: 28 PMC, 16 Scav, 2 boss, 3 cultist, 1 sniper;
- objects: 6 locks, 2 stationary guns;
- loot/reference: ammo 5, supply crates 30, bodies 15, drawers 6, duffles 51, wooden crates 48, grenade boxes 8, jackets 18, medbags 7, safe 1, caches 45, toolboxes 33, weapon boxes 41, key spawns 6, keycards 4.

Woods is a single north-up sheet, so use one affine. Start with a full affine implementation, then constrain cross terms to zero only if residuals show the art and game axes are aligned. Candidate anchors present in wiki and game/vector data:

| Wiki marker | Wiki `[x,y]` | Game anchor/check |
|---|---:|---|
| Shturman Boss Spawn | `[3246.33,2333.45]` | Sawmill `[10,-3]`; refine to the SPT ZoneWoodCutter/SVG yard position. |
| Goons Boss Spawn | `[2394,5790]` | ZoneScavBase2 centroid `[201.6,-724.5]`, then refine to the antenna/bunker SVG position. |
| Shturman's Stash | `[3130.89,2450.12]` | Sawmill stash structure, near Sawmill label/ZoneWoodCutter; derive exact point from the building footprint. |
| ZB-014 door/extract | door `[68.41,2567.5]`, extract `[1179.81,2000.05]` | ZB-014 bunker on the southwest/west boundary, exact bunker footprint/gate from SVG and satellite. The separated door inset marker must be recognized as an inset and not used in the surface fit. |
| Yotota Car | `[3270.55,2614.17]` | Lumber/sawmill vehicle visible in SVG/satellite, exact traced centre. |
| Scav Bunker / antenna | `[2181.5,5661.5]` | SPT ZoneScavBase2 plus antenna/powerline/rock geometry. |
| PMC spawn markers | 28 points | Match to SPT Player points using an initial bounds transform and mutual-nearest/RANSAC; use at least four unambiguous pairs as exact calibration/holdouts. |

The raw-bounds initial guess is approximately `x = 646 - wx*(1407/6994)`, `z = 442 - wy*(1356/6843)`. It already places central features within tens of metres, enough for mutual-nearest matching. Solve the affine with the confirmed pairs, reject ambiguous spawn matches, and print every residual. Target <5 m median and <8 m max. Hold out Shturman, Goons/Scav Bunker, and at least two PMC spawn matches. Panel/inset markers such as the ZB-014 grate must be explicitly classified or omitted.

### Calibration execution record

Six mutual-nearest correspondences between wiki PMC symbols and current SPT `Player` points (wiki ids 4, 8, 19, 24, 16, and 21) produced:

```text
game x = -0.2090742825·wiki x + 0.0005516958985·wiki y + 680.7290264
game z = -0.0001680692365·wiki x - 0.2073825494·wiki y + 478.0887388
```

Their residuals are 1.6, 1.1, 0.8, 1.9, 3.2, and 4.7 m (median 1.75 m, max 4.7 m). The very small cross terms confirm the art is almost axis-aligned while retaining the full affine avoids a systematic edge error. The ZB-014 inset lock is excluded; five surface lock markers remain.

## Terrain and rock strategy

Woods is terrain-first. A flat green sheet with 1.2 m rock extrusions is not acceptable.

- Use a 10 m true-scale grid over the 1.4 km square plus pad, with IDW from filtered SPT surface points, deterministic low-amplitude roughness, and plateau/ridge/valley constraints.
- Hand-authored `TERRAIN_FEATURES`/controls: Sniper Rock high mass around `[85,-147]`; USEC Camp ridge `[290,-475]`; northwest Scav Bunker/antenna high ground near `[200,-724]`; western ridge around ZB-014/Outskirts; central ridge systems around Jaeger's Camp/Crash Site; rolling northern Ponds/Cultist Village ground; Scav Town/Old Sawmill shoulders; the southern-lake basin and shore; and Military Camp/Bus Stop high ground. Features should be elongated, overlapping ridges and basins, never isolated domes.
- Use local SPT medians to set target heights and clamp handcrafted additions to observed true-scale range. Preserve low southern lake/river banks. Report final min/max and samples at every named control.
- Upgrade rock geometry generically: the 281 polygons receive a deterministic height based on area, local terrain slope, and membership in named high-rock regions. Large cliff masses get layered/tapered silhouettes (still deck.gl primitives); small boulders remain low. Customs arrays fall back to 1.2 m, preserving its visual.
- The SVG has no tree group. Generate sparse, deterministic broad canopy clusters inside the limit and away from mapped roads/water/buildings so rocks and routes remain readable; do not create a literal tree per satellite dot.
- The `Plane` group becomes a distinct fuselage/wing scene draped at Crash Site.
- Minefield polygons contribute to the limit/hazard overlay but never to terrain height.

Verification will inspect north/south/east/west obliques and close views of Sniper Rock, USEC ridge, Scav Bunker ridge, central sawmill, and lake shore. Roads/powerlines/fences/buildings must use the exact same `H()` sampler.

The executed ground grid is 150×145 at 10 m from 326 retained surface points and spans -19.4..27.4 m. `ZoneBigRocks`/`ZoneHighRocks` samples were removed from soil IDW and applied to their containing rock objects instead: the highest evidenced polygon rises 42 m from local terrain, reproducing the SPT 61.46 m rock-top sample without deforming the surrounding ground. The final output contains 282 rock masses, 137 restrained deterministic canopy clusters (the source SVG has no tree group), four minefield polygons, and the exact two plane/four pier SVG shapes.

## Buildings, landmark identity, and props

Sources are tarkov.dev labels/SVG/tiles, the current official Wiki map/gallery, and re3mr only as visual reference.

| Landmark | Style/geometry | Colour/material direction |
|---|---|---|
| Sawmill / Lumber / Cabins | industrial mill halls, low gables, log/loading yard | weathered grey/olive metal, tan timber, dark roofs |
| Old Sawmill | older clustered mill/house sheds | dark weathered timber, rusted metal roofs |
| Scav Town | repeated small cottages with pitched roofs/outbuildings | muted timber/plaster, varied brown/grey roofs |
| Cultist Village / Ponds | ruined/dilapidated houses and sheds | dark desaturated timber, broken/low silhouettes |
| USEC Camp | tents, containers, barricades, vehicles rather than one building | olive canvas, grey/green containers, raw barriers |
| Military/EMERCOM Camp | medical tents, container structures, fenced camp | pale/olive canvas, muted white/green utility units |
| Scav Bunker / antenna | concrete bunker portal + radio mast scene | raw concrete, black opening, dark steel mast |
| ZB-014 / ZB-016 | low bunker-mouth scenes | raw concrete, earth contact shade, green/dark grate |
| Scav House / Shack / Jaeger | isolated wood cabins | weathered dark timber and low gable roofs |
| Crash Site | plane group plus scattered wreckage | dull aluminium/grey, dark torn edges |
| Convoy / checkpoints | military trucks/APCs, roadblocks, booths | olive drab, concrete grey, restrained hazard accents |

Priority props to trace at zoom 5: crash-site fuselage debris; USEC and Military Camp tents/containers/walls; sawmill log stacks, forklifts/vehicles and trailers; convoy; Scav Bunker antenna; Scav Town/Old Sawmill vehicles and fences; docks/boats at the southern lake and ponds; BTR stops/signs only as static roadside cues; power pylons; roadblock containers. Woods ppm at zoom 5 is `0.1855*32 = 5.936 px/m`; use the actual screenshot centre, not the Customs 7.65 ppm constant.

## Roads, tracks, water, limits, and crossings

- Start `Roads` as paved medium, `Dirt_Roads` as gravel/dirt, and `Small Roads` as narrow paved. Audit every path against satellite because narrow tarmac and forest tracks are visually easy to confuse.
- Hand trace forest trails that are tactically clear on tiles but absent from SVG; keep minor footpaths sparse so 3D does not become orange spaghetti.
- The rail group is one route; clip it to the playable limit and preserve the extract-end bridge geometry separately.
- Road overlay URL: `?map=woods&base=satellite&debug=roads`. Check all paved junctions around sawmill, towns/camps, the west/east boundary roads, and BTR route.
- Water has three roles: the northern boundary river, southern lake, and inland ponds. Ponds/lake are not traversable road crossings. Docks from `Pier` are wooden props, not bridges.
- Explicit bridge/crossing whitelist:
  - Bridge V-Ex at the northeast river road is a real road bridge up to the vehicle/extract; border snipers are beyond the vehicle.
  - Friendship Bridge is a real bridge/co-op extract at the northern edge; only the playable approach/deck is modeled.
  - Railway Bridge to Tarkov is rail/extract geometry at the eastern/southeastern edge and requires the Woods minefield map; do not invite continuation into void.
  - Any other road-water intersection is rejected unless satellite and wiki agree. No automatic bridge over the southern lake or ponds.
- `Map_Limit` has six segments and `Minefield` four danger paths. Build a conservative closed limit using land plus these edges, compare with the current wiki mine/sniper lines, and clip every road/rail/fence/powerline. The official wiki notes both marked and unmarked minefields (notably west of USEC Camp in the general map guide) and invisible border snipers.

## Current gameplay facts to encode/check

From Woods Wiki revision 355184 and the current map payload:

- Raid: 35 minutes, 10–14 PMCs; Shturman at sawmill, Goons at the northwest antenna/Scav Bunker, Cultists near ritual areas.
- Bridge V-Ex is paid, single-use, max four players, with border snipers beyond the vehicle.
- Friendship Bridge requires PMC + Scav. Northern UN and UN Roadblock have border snipers beyond the gate/containers.
- Power Line Passage requires a correctly fired green flare in the signal zone.
- Railway Bridge to Tarkov requires the Woods minefield map.
- ZB-014 and ZB-016 availability is indicated by green flares in the current article; ZB-014 also uses its key as shown.
- The Woods perimeter uses minefields and border snipers; minefields are invisible/respawn in the general map rules, so visual limit conservatism matters.
- Four transits become available after one minute.

## Risks and mitigations

- Sparse/biased elevation points: use robust local medians, named ridge/basin controls, and true-scale sample diagnostics.
- High points on rocks/sniper platforms: separate ground and rock evidence via neighbors/zone/footprints.
- Huge runtime terrain: keep JSON grid at 10 m; the existing runtime mesh can subdivide smoothly. Measure 3D load/memory on Woods.
- Rock overload: area/zoom-aware geometry and palette variation; keep small rocks simple.
- Limit composed from multiple SVG paths: polygonize/test closure and use the conservative inside mask.
- Wiki inset markers (ZB grate/interiors): panel classify; do not contaminate surface affine.
- Bridge false positives: whitelist only the three named edge structures.
- Recent Woods expansions/current story state may differ from older tiles/art: current SPT/wiki and user playtest override old guides.

## Execution and verification breakdown

1. Register Woods config/labels and verify 2D satellite/vector fit at several landmarks/edges.
2. Build marker affine from confirmed SPT/vector pairs; print fit/holdout residuals and generate community marker JSON.
3. Parse/map all SVG aliases, close the limit, and produce the structural 3D pass with water/rocks/buildings/roads/rail/powerline/mines.
4. Terrain pass with sample filtering and named controls; inspect ridge/basin truth and report range/residuals.
5. Rock/plane/building identity pass; verify main silhouettes at fit and close zoom.
6. Road/water pass using satellite overlay; trace missing tactical routes, whitelist three crossing structures, and clip all edges.
7. Prop pass at zoom 5 with camps, sawmill, convoy, plane debris, pylons, roadblocks, docks.
8. Marker/label/hazard pass; verify extracts against crossing/limit geometry and search/filter counts.
9. Production build and captures: `scratch/woods-2d.png`, `woods-3d-fit.png`, four obliques, `woods-roads.png`, and close-ups for Sniper Rock/USEC/Sawmill/lake/Scav Bunker.
10. Iterate to Customs-level structural completeness; leave only real-GPU or in-game crossing/limit confirmations in `PROGRESS.md`.
