/**
 * Place labels. `position` = [x, z] game coords. Base sets mirrored from tarkov.dev's maps.json;
 * detail labels derived from its SVG building groups and layer extents.
 *
 * EVERY ROW CARRIES A `tier`. THERE IS NO `size`.
 * ----------------------------------------------
 * `size` (a hand-tuned percentage, 80–90 on 19 of Customs' 32 rows against a default of 100) was
 * deleted on 2026-09-02. It was a 20 % range with no rule behind it, and both renderers turned it
 * back into a boolean at `>= 100`. The four tiers and the style/zoom contract they resolve to live
 * in `src/label-tier.js`; read the units note there before consuming this file.
 *
 * HOW A TIER WAS ASSIGNED — the rule, so a row can be argued with
 * --------------------------------------------------------------
 * Nobody working on this repo has Tarkov game knowledge, so no tier was picked by feel. Each row is
 * scored from PUBLIC repo data only (`public/data/<map>-3d.json`, `public/data/<map>.json`,
 * `public/data/quests.json`, and the `PLACE_COLORS` tables in `scripts/build-3d.mjs`), and the
 * score decides the tier. `scripts/label-tier.test.mjs` re-runs the whole derivation and fails if
 * any shipped tier disagrees with it — so an unexplained hand edit goes red rather than drifting.
 *
 *   CLASS.  A row is a `structure` if buildings in `<map>-3d.json` carry `place === text` AND
 *           the LARGEST SINGLE element among them is >= 60 m² (an 8 m shed); otherwise it is an
 *           `area`. The floor is evaluated PER ELEMENT, not on the combined footprint, since
 *           2026-09-02 — a combined floor is clearable by summing several hut-scale elements, and
 *           it was: Customs' POWERLINE TOWER carries two elements at 17 m² and 49 m² (66 m²
 *           combined, over the floor) despite neither element being building-scale, and TRAILER
 *           PARK carries four elements at 53/18/18/48 m² (138 m² combined) with the same problem.
 *           A per-element floor is invariant to how a `place` happens to be split in the source
 *           SVG: a genuine building's main volume clears 60 m² on its own no matter how many small
 *           appendages (a lean-to, a porch slab) ride along with it — every current `structure`
 *           row, including Storage's six-building depot and Crackhouse's 395 m²-plus-19 m² pair,
 *           has an element that clears the floor by itself — while a cluster of huts never
 *           produces one, no matter how many huts are in the cluster. The footprint floor is what
 *           separates SNIPER RIDGE (one 17 m² hut on a hill) from a building — the name is
 *           describing ground, not a structure.
 *
 *   SCORE.  footprint  >= 1500 m² +3 · >= 700 +2 · >= 200 +1     (summed over the `place`)
 *           tall       max height >= 15 m or floors >= 3         +1
 *           extract    text IS an extract name, or one within 50 m   +1
 *           quests     distinct quests whose objective zones' NEAREST label is this one:
 *                      >= 8 +2 · >= 4 +1   (nearest-wins, so a dense yard cannot smear one
 *                      quest across six identical sheds)
 *           district   buildings sharing the `place` spread >= 100 m +2 · >= 60 m +1
 *           identity   the place has its own colour in build-3d.mjs's PLACE_COLORS — a human
 *                      already judged it visually distinct from the generic palette   +1
 *
 *   TIER.   structure: >= 5 landmark · >= 3 building · else minor
 *           area:      >= 5 landmark · else zone
 *
 * NOT IN THIS FILE: which labels are hidden. Eleven names collide with EXTRACT marker names across
 * the three maps (ten in the current data — Reserve's D-2 went out with the floor selector on
 * 2026-09-02), and an extract's badge already draws its own name as a caption. `ownedByExtract()`
 * in main.js reads the LIVE marker set and stands those place labels down in 2D, in 3D and in the
 * omnibox index. Tiering does not and must not resurrect them: it never touches `text`, which is
 * the only field that rule reads. Asserted in scripts/label-tier.test.mjs.
 *
 * The floor-gated rows that used to live here went out with the floor selector on 2026-09-02.
 * Do not reinstate them; these maps are read from above.
 */
export const CUSTOMS_LABELS = [
  { position: [-215, -119], text: 'Big Red', tier: 'building' },
  { position: [404, 31], text: 'New Gas', tier: 'building' },
  { position: [331, -173], text: 'Old Gas', tier: 'building' },
  { position: [201, -127], text: 'Fortress', tier: 'landmark' },
  { position: [83, -153], text: 'Crackhouse', tier: 'minor' },
  { position: [567, -67], text: 'Streamer House', tier: 'building' },
  { position: [-69, 9], text: 'Main Bridge', rotation: '6', tier: 'zone' },
  { position: [110, 85], text: 'Sniper Hill', tier: 'zone' },
  { position: [-288, -134], text: 'Storage', tier: 'landmark' },
  { position: [-211, -219], text: 'Trailer Park', tier: 'zone' },
  { position: [-66, 46], text: 'Junk Bridge', tier: 'zone' },
  { position: [106, -90], text: 'Repair Shop', tier: 'landmark' },
  { position: [491, 63], text: 'Sniper Ridge', rotation: '5', tier: 'zone' },
  { position: [75, -9], text: 'Old Construction', tier: 'minor' },
  { position: [200, -13], text: 'Skeleton', rotation: '-9', tier: 'landmark' },
  { position: [390, -94], text: 'Warehouse 3', tier: 'building' },
  { position: [472, -67], text: 'Depot', tier: 'landmark' },
  { position: [555, -118], text: 'Warehouse 7', tier: 'building' },
  { position: [572, 0], text: 'Military Checkpoint', tier: 'building' },
  { position: [238, 53], text: 'Bus Station', tier: 'zone' },
  { position: [333, -67], text: 'Warehouse 4', tier: 'landmark' },
  { position: [497, 110], text: 'Powerline Tower', tier: 'zone' },
  { position: [46, -59], text: 'Warehouse 17', tier: 'landmark' },
  { position: [231, 150], text: 'Dorms 2-Story', tier: 'minor' },
  { position: [183, 167], text: 'Dorms 3-Story', tier: 'landmark' },
  { position: [612, -130], text: 'Water Pump', tier: 'landmark' },
  { position: [628, -131], text: 'ZB-1011', tier: 'minor' },
  { position: [466, -116], text: 'ZB-1012', tier: 'zone' },
  { position: [206, -148], text: 'ZB-013', tier: 'zone' },
  { position: [110, -50], text: 'Boiler', tier: 'zone' },
  { position: [262, -40], text: 'Oil Rig', tier: 'landmark' },
  { position: [183, -276], text: 'Scav Sniper', tier: 'zone' },
];

export const RESERVE_LABELS = [
  // Chess-piece names and positions mirror tarkov.dev. Combined aliases avoid
  // duplicate labels over the same landmark while retaining the common callout.
  { position: [-15, 182], text: 'White Queen / Dome', rotation: -15, bottom: -6, tier: 'landmark' },
  { position: [-104, 93], text: 'White Pawn', rotation: 14, bottom: -6, tier: 'landmark' },
  { position: [-140, -14.5], text: 'Black Bishop', rotation: 14, bottom: -6, tier: 'landmark' },
  { position: [-67, -30], text: 'White Bishop', rotation: 14, bottom: -6, tier: 'building' },
  { position: [-49.5, 15.5], text: 'White King', rotation: 14, bottom: -6, tier: 'landmark' },
  { position: [14.5, -10.8], text: 'Black Knight', bottom: -6, tier: 'building' },
  { position: [82.2, -30.2], text: 'White Knight', bottom: -6, tier: 'building' },
  { position: [158, -145], text: 'White Rook / Train Station', rotation: 14, bottom: -6, tier: 'landmark' },
  { position: [-173, 70], text: 'Black Pawn', bottom: -6, tier: 'building' },
  { position: [-127, 39], text: 'Helipad / Helicopter', bottom: -6, tier: 'zone' },
  { position: [174, -224], text: 'Military Guard Barracks', bottom: -6, tier: 'landmark' },
  { position: [48, -184], text: 'Bunker Hermetic Door', bottom: -6, tier: 'zone' },
  { position: [141, 25], text: 'Depot Hermetic Door', bottom: -6, tier: 'minor' },
  { position: [96, 30], text: 'Garage', rotation: -75, bottom: -6, tier: 'building' },
  { position: [55.5, 60.6], text: 'Mechanic', bottom: -6, tier: 'minor' },
  { position: [29.7, 29.5], text: 'Gas Station', rotation: 14, bottom: -6, tier: 'minor' },
  { position: [-31, -150], text: 'Shipping Yard', rotation: 14, bottom: -6, tier: 'zone' },
  { position: [-1, -71], text: 'Storage K1', rotation: 14, bottom: -6, tier: 'minor' },
  { position: [66, -90], text: 'Storage K2', rotation: 14, bottom: -6, tier: 'minor' },
  { position: [-5.5, -94], text: 'Storage K3', rotation: 14, bottom: -6, tier: 'minor' },
  { position: [60, -112], text: 'Storage K4', rotation: 14, bottom: -6, tier: 'minor' },
  { position: [-10.5, -115], text: 'Storage K5', rotation: 14, bottom: -6, tier: 'minor' },
  { position: [54, -132], text: 'Storage K6', rotation: 14, bottom: -6, tier: 'minor' },
  // The nine underground-only navigation labels that used to live here (D-2, Command Bunker, the
  // hermetic doors, the tunnel names) went out with the floor selector on 2026-09-02: they were
  // reachable only from the "U" cell, and the map is read from above. They are recoverable from
  // git history if an underground view ever comes back.
];

export const WOODS_LABELS = [
  { position: [10, -3], text: 'Sawmill', tier: 'landmark' },
  { position: [-485, -390], text: 'Scav Town', tier: 'landmark' },
  { position: [-517, -210], text: 'Old Sawmill', tier: 'building' },
  { position: [-80, -680], text: 'Sunken Village / Abandoned Village', tier: 'landmark' },
  { position: [290, -475], text: 'USEC CAMP', tier: 'building' },
  { position: [-188, 235], text: 'Military Camp', tier: 'building' },
  { position: [412, 240], text: 'Scav House', tier: 'minor' },
  { position: [-505, -530], text: 'Bridge V-Ex', tier: 'zone' },
  { position: [74, -876], text: 'Friendship / Scav Bridge', tier: 'zone' },
  { position: [-700, 118], text: 'Railway Bridge to Tarkov', tier: 'zone' },
  { position: [-5, -515], text: 'Ponds', tier: 'zone' },
  { position: [-252, -37], text: 'Crash Site', tier: 'zone' },
  { position: [239, -65], text: 'Checkpoint', tier: 'zone' },
  { position: [244, 125], text: 'Shack', tier: 'zone' },
  { position: [-16, -122], text: 'Lumber', tier: 'zone' },
  { position: [-3, -74], text: 'Cabins', tier: 'minor' },
  { position: [-234, 357], text: 'Bus Stop', tier: 'zone' },
  { position: [-327, 19], text: "Jaeger's Camp", tier: 'zone' },
  { position: [85, -147], text: 'Sniper Rock', tier: 'zone' },
  { position: [-198, -231], text: 'Mountain Spine', tier: 'zone' },
  { position: [200, -606], text: 'Convoy', tier: 'zone' },
];

export const LABELS = {
  customs: CUSTOMS_LABELS,
  reserve: RESERVE_LABELS,
  woods: WOODS_LABELS,
};
