// Marker icons: a two-tone stencil. The badge carries the category COLOUR and its shape; the
// game-icons glyph on top is always the same near-white, never tinted (step 4, UI-REWORK.md).
//
// Before this pass the badge was three tones — a coloured fill, an ink keyline AND a cream inner
// rule — and the spawn glyphs broke the rule outright by painting the glyph itself in the category
// colour on a bare dark disc. At 22 px that reads as noise: the eye has to decode the artwork to
// learn the category. Now colour = category, shape = family, glyph = what the thing is:
//
//   sq  rounded square   extracts / transits / stashes
//   sh  shield           spawns (people)
//   ci  circle           loot containers
//   dia diamond          utilities (switches, locks, hazards, stationary weapons)
//   hex hexagon          quest objectives (nothing else uses it)
//
// The glyph SET is unchanged — that was the founder's art decision, and Gemini's "trash the icons"
// stays declined.
const S = 'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"';
import { ART } from './icon-art.js';
import { countsVisible, CLUSTER_DOT_PX } from './lod.js';
const A = (k) => `<g transform='scale(0.046875)'><path d='${ART[k]}'/></g>`; // 512 -> 24
const GLYPH = {
  gi_exit: A('exit'), gi_transit: A('transit'), gi_gasmask: A('gasmask'), gi_hood: A('hood'), gi_crosshair: A('crosshair'), gi_crownskull: A('crownskull'), gi_radioactive: A('radioactive'), gi_sentry: A('sentry'), gi_lever: A('lever'), gi_padlock: A('padlock'), gi_stairs: A('stairs'),
  gi_flagobjective: A('flagobjective'), gi_checklist: A('checklist'),
  gi_lockedchest: A('lockedchest'), gi_ammobox: A('ammobox'), gi_cargocrate: A('cargocrate'), gi_strongbox: A('strongbox'),
  gi_medicalpack: A('medicalpack'), gi_lootkey: A('lootkey'), gi_deathskull: A('deathskull'), gi_twocoins: A('twocoins'),
  // gi_ammobox / gi_strongbox / gi_lootkey / gi_deathskull are not bound by any KIND since the
  // 2026-09-02 loot collapse (three families, see KINDS below). They stay: they are the credited
  // game-icons.net art set, ~200 bytes each, and they are what a per-item tier would draw if the
  // families ever split again. Removing them would also orphan their paths in icon-art.js.
  // toy-soldier silhouettes (one colour, no badge). 24x24, feet at y=23.
  armyman: `<path d='M12 1.5a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8zM9.2 6.6h5.6l1.4 1.2 3.9-1.6.7 1.6-4 2.3-.8 5.4h-1.1l.3 7.5h-2.2l-.6-6h-.8l-.6 6H9.8l.3-7.5H9l-.8-5.2-3.3-1 .4-1.7 3.2.6z'/><path d='M4 23h16v.8H4z' opacity='.9'/>`,
  hoodman: `<path d='M12 1.2c-2.2 0-3.3 1.8-3.3 3.6v1.7h6.6V4.8c0-1.8-1.1-3.6-3.3-3.6zM9.3 7.1h5.4l1.1 1 3.5 3.6-1.2 1.2-2.4-2.1-.3 5h-1l.4 7.5h-2.1l-.5-6h-.8l-.5 6H9.1l.4-7.5h-1l-.3-5-2.4 2.1-1.2-1.2 3.5-3.6z'/><path d='M4 23h16v.8H4z' opacity='.9'/>`,
  prone: `<path d='M20.5 12.2a1.9 1.9 0 1 1-3.8 0 1.9 1.9 0 0 1 3.8 0zM2.5 17.6l14.2-.4 1.1-2.9h2.6l1 .9-2.2 4.5-1.6.3-.3 2.4h-1.6l-.2-2.3-6.1.2-1.7 2.1H6.2l1.1-2.1H2.5z'/><path d='M12.6 9.4l7.9-4.2.6 1.1-7.7 4.5z'/><path d='M2 23h20v.8H2z' opacity='.9'/>`,
  bossman: `<path d='M12 .8a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6zM8.6 6.9h6.8l1.9 1.4 4 .9-.4 1.8-3.6-.4-.9 5.6h-1.2l.4 7.8h-2.4l-.7-6.3h-1l-.7 6.3H8.4l.4-7.8H7.6l-.9-5.6-3.6.4-.4-1.8 4-.9z'/><path d='M9.4 1.2h5.2l-.6 1.6h-4z'/><path d='M4 23h16v.8H4z' opacity='.9'/>`,
  exit: `<path d='M4 3h9v4h-3V6H7v12h3v-1h3v4H4z' fill='#fff'/><path d='M13 12h6.5m0 0-3-3m3 3-3 3' stroke='#fff' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round' fill='none'/>`,
  exitScav: `<path d='M4 3h9v4h-3V6H7v12h3v-1h3v4H4z' fill='#fff'/><path d='M13 12h6.5m0 0-3-3m3 3-3 3' stroke='#fff' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round' fill='none'/><path d='M6 2.2q3-2 6 0' stroke='#fff' stroke-width='1.6' fill='none'/>`,
  transit: `<path d='M5 6v12M19 6v12' stroke='#fff' stroke-width='2.2' stroke-linecap='round'/><path d='M3 12h15m0 0-3.5-3.5M18 12l-3.5 3.5' stroke='#fff' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round' fill='none'/>`,
  soldier: `<path d='M7.5 10a4.5 4.5 0 0 1 9 0v1h-9z' fill='#fff'/><circle cx='12' cy='12' r='2.6' fill='#fff'/><path d='M5 21c0-4 3-6.5 7-6.5s7 2.5 7 6.5z' fill='#fff'/><path d='M16.5 13.5 21 9' stroke='#fff' stroke-width='2' stroke-linecap='round'/>`,
  hood: `<path d='M12 3 6.5 13h11z' fill='#fff'/><circle cx='12' cy='11.5' r='2' fill='#2a2a2a'/><path d='M5 21c0-4 3-6.5 7-6.5s7 2.5 7 6.5z' fill='#fff'/>`,
  crosshair: `<circle cx='12' cy='12' r='6' stroke='#fff' stroke-width='2.2' fill='none'/><path d='M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5' stroke='#fff' stroke-width='2.2' stroke-linecap='round'/><circle cx='12' cy='12' r='1.6' fill='#fff'/>`,
  skull: `<path d='M5 8l2.5 2 2-3 2.5 3 2.5-3 2 3L19 8v2H5z' fill='#fff'/><path d='M12 9.5a6 6 0 0 0-6 6c0 2 1 3.4 2.4 4.3V22h7.2v-2.2C17 18.9 18 17.5 18 15.5a6 6 0 0 0-6-6z' fill='#fff'/><circle cx='9.8' cy='15.5' r='1.3' fill='#b91c1c'/><circle cx='14.2' cy='15.5' r='1.3' fill='#b91c1c'/>`,
  trefoil: `<circle cx='12' cy='12' r='2' fill='#fff'/><path d='M12 12 8.5 5.9a7 7 0 0 1 7 0zM12 12l6.5 3.3a7 7 0 0 1-3.5 6.2zM12 12l-6.5 3.3a7 7 0 0 0 3.5 6.2z' fill='#fff'/>`,
  turret: `<path d='M3 9h12l5 2-5 2H9' fill='#fff'/><circle cx='7' cy='11' r='2.6' fill='#fff'/><path d='M7 13.5 4 21M7 13.5l3 7.5' stroke='#fff' stroke-width='2' stroke-linecap='round'/>`,
  lever: `<path d='M4 19h16' stroke='#fff' stroke-width='2.4' stroke-linecap='round'/><path d='M8 19 15 6' stroke='#fff' stroke-width='2.6' stroke-linecap='round'/><circle cx='15.5' cy='5.5' r='2.4' fill='#fff'/><circle cx='8' cy='19' r='2.2' fill='#fff'/>`,
  lock: `<rect x='5' y='11' width='14' height='9' rx='2' fill='#fff'/><path d='M8 11V8a4 4 0 0 1 8 0v3' stroke='#fff' stroke-width='2.4' fill='none'/><circle cx='12' cy='15.5' r='1.3' fill='#111'/>`,
};

// Palette (TRACK C accents): greens = your way out, blues/ambers = people, reds = danger,
// neutrals = utilities. The four extract hues are re-used by the 3D name chips' borders and by
// the sidebar rows, so toggling 'Scav extracts' visibly removes exactly the orange-bordered chips.
//
// LOOT: THREE FAMILIES, NOT SEVEN MUDS (2026-09-02)
// ------------------------------------------------
// Loot used to be seven `ci` kinds in seven greys — weapon boxes #707875, crates & bags #81735E,
// safes & cash #7D7062, med & ammo #64786E, key spawns #80785C, dead bodies #706866, loose loot
// #706F65 (their kind ids are gone; the only place they still appear is LEGACY_KIND, and
// `scripts/icons-test.mjs` fails on any other mention, comments included — including this one).
// Measured on that set: the closest pair (crate vs key) was **5.5 apart in RGB distance** and the
// Rec.709 luma spread across all seven was **14.1 of 255**. A third of the icon vocabulary was one
// grey dot, and the engraved glyph that was supposed to tell them apart does not survive 12 px —
// the only size the map draws them at once you are zoomed out far enough to plan a route.
//
// The collapse is keyed on the DECISION a player makes, not on what the item is:
//
//   loot-consumables  what you burn in the raid   meds, ammo, grenades, rations
//   loot-valuables    what you pocket for money   loose loot, drawers, jackets, toolboxes,
//                                                 safes, tills, PCs, key spawns
//   loot-gear         big kit and bodies          weapon boxes, duffles, crates, dead PMCs/scavs
//
// Hues are muted enough for a dark realistic map and far enough apart to survive the DOT tier,
// where colour is the only channel left (`desaturate()` below pulls each 55% toward its own luma,
// so the dot tier is the number that actually matters):
//
//   MEASURED on the three loot hues:
//     badge tier  min RGB distance 103.8 · luma spread 72.9   (was 5.5 / 14.1)
//     dot tier    min RGB distance  56.9 · luma spread 64.5   (was 3.0 / 12.2)
//   ENFORCED FLOOR (`FLOOR` in scripts/icons-test.mjs), which is a different thing and lower:
//     badge min 90 · badge luma spread 55 · dot min 45 · dot luma spread 45
//
// The two are stated apart deliberately. Collapsing them into one sentence is what let a later brief
// repeat "the documented floors (badge 103.8, dot 56.9)" as if those were the numbers CI enforces:
// a pair measuring 95 would then read as a failure to a human and as a pass to the suite. The floors
// are set below the measurement on purpose — raising `badgeMin` above 88.6 would correctly fail
// `extract-pmc` vs `extract-transit`, which is a real, accepted, shape-backstopped pair.
//
// `scripts/icons-test.mjs` asserts the enforced floors; the OLD seven fail them by an order of
// magnitude, and it proves that in-process rather than asking anyone to take it on trust.
// The per-item distinction is NOT lost — it moves off the map face into the data: the marker keeps
// its own name ("Duffle bag", "Medbag SMU06"), the hover label and the popup print it, and the
// `terms` array below keeps "safe", "keys", "bodies" and friends findable in the omnibox.
export const KINDS = {
  'extract-pmc':     { label: 'PMC extracts',       glyph: 'gi_exit',      color: '#2DBE6C', shape: 'sq'  },
  'extract-scav':    { label: 'Scav extracts',      glyph: 'gi_exit',  color: '#E0872B', shape: 'sq'  },
  'extract-shared':  { label: 'Shared extracts',    glyph: 'gi_exit',      color: '#2DBE6C', color2: '#E0872B', shape: 'sq' },
  'extract-transit': { label: 'Transits',           glyph: 'gi_transit',   color: '#3A96BA', shape: 'sq'  },
  // THE FOUR SHIELDS, RE-CUT (2026-09-03). Measured before this pass: the closest badge pair was
  // sniper #e2793f vs boss #d24a4a at **50.9** in RGB and the closest dot pair (scav vs sniper) was
  // **39.0** — under
  // half the loot floor, on four near-white silhouettes that differ only by artwork at 22 px. The
  // 3D overlay draws these over brown-olive terrain at `--marker-opacity:.72`, which is where they
  // collapsed into one pale blob. Four hue families now, one per decision:
  //   pmc     deep steel blue   the other players
  //   scav    khaki tan         UNCHANGED — it already cleared the floor against everything but orange
  //   sniper  deep maroon       a shot you do not see coming
  //   boss    orchid            the one that is not like the others
  // Orange had to leave: tan and orange are the same hue, and no amount of value separation gets a
  // scav shield and a sniper shield apart at the dot tier. See `badgeSvg`'s GLYPH_HALO — the shields
  // also gained an ink outline, because colour alone was never going to carry four near-white
  // silhouettes. `scripts/icons-test.mjs` asserts both floors and proves the OLD four fail them.
  'spawn-pmc':       { label: 'PMC spawns',         glyph: 'gi_gasmask',   color: '#2C6FAE', shape: 'sh' },
  'spawn-scav':      { label: 'Scav spawns',        glyph: 'gi_hood',   color: '#c9a463', shape: 'sh' },
  'spawn-sniper':    { label: 'Sniper scav spawns', glyph: 'gi_crosshair',     color: '#9E2F26', shape: 'sh' },
  // Magenta rather than violet: measured off the live frame, a violet boss shield sat only 60 RGB
  // from the `hazard` purple diamond, and a cross-family near-miss is what shape is a backstop
  // FOR, not a licence for. #C74FAE puts 70 between them and widens every spawn pair at the dot
  // tier at the same time (min 60.6 -> 61.9).
  'spawn-boss':      { label: 'Boss spawns',        glyph: 'gi_crownskull',   color: '#C74FAE', shape: 'sh' },
  'stash':           { label: 'Stashes',            glyph: 'gi_lockedchest', color: '#77845A', shape: 'sq' },
  'loot-consumables': { label: 'Meds & ammo',       glyph: 'gi_medicalpack', color: '#3C8D80', shape: 'ci',
    terms: ['med', 'meds', 'medical', 'medcase', 'medbag', 'ammo', 'grenade', 'ration', 'food', 'consumable'] },
  'loot-valuables':  { label: 'Valuables & keys',   glyph: 'gi_twocoins',    color: '#CBA33C', shape: 'ci',
    terms: ['loose', 'loose loot', 'cash', 'money', 'safe', 'safes', 'till', 'register', 'drawer', 'jacket', 'toolbox', 'tool', 'pc', 'key', 'keys', 'valuable'] },
  'loot-gear':       { label: 'Gear & bodies',      glyph: 'gi_cargocrate',  color: '#8E4F3E', shape: 'ci',
    terms: ['weapon', 'weapon box', 'gun', 'crate', 'crates', 'bag', 'bags', 'duffle', 'body', 'bodies', 'dead', 'corpse', 'gear'] },
  'hazard':          { label: 'Hazards',            glyph: 'gi_radioactive',   color: '#8258A6', shape: 'dia' },
  // THE TWO GREY DIAMONDS, SPLIT (2026-09-03). `weapon` #6E6860 and `lock` #808682 were **48.8**
  // apart in RGB — the same diamond, the same value, both sitting on Customs' grey concrete, and
  // the only thing telling them apart was a sentry-gun vs a padlock at 22 px. They are now opposite
  // ends of the value axis and read as their own materials: oiled gun steel, galvanised padlock.
  'weapon':          { label: 'Stationary weapons', glyph: 'gi_sentry',    color: '#4A403A', shape: 'dia' },
  'switch':          { label: 'Switches / levers',  glyph: 'gi_lever',     color: '#D6B236', shape: 'dia' },
  'lock':            { label: 'Locks',              glyph: 'gi_padlock',      color: '#B9C4C0', shape: 'dia' },
  // Quest objectives are their own class: a hexagon nobody else uses, so a quest pin never reads
  // as an extract or a loot chip. Colour is overridden per selected quest (see `tint`).
  'quest-objective': { label: 'Quest objectives',   glyph: 'gi_flagobjective', color: '#D8A32B', shape: 'hex' },
};
/**
 * Container type -> marker kind. Lives here, next to KINDS, because it IS the vocabulary: main.js
 * only consumes it, and a DOM-free module is what lets `scripts/icons-test.mjs` assert it against
 * the real `public/data/*.json`.
 *
 * Two type vocabularies feed this table and BOTH are live:
 *   - `scripts/build-community-data.mjs` exact path: `container_${lookup.normalizedName}` straight
 *     off tarkov.dev — `container_weapon_box`, `container_duffle_bag`, `container_toolbox`,
 *     `container_pmc_body`, `container_medbag_smu06`, ...
 *   - its EFT-Wiki path: the shorter hand-written `WIKI_CONTAINER_TYPES` set (`container_weapon`,
 *     `container_crate`, `container_tool`, `container_dead`, ...), plus `loot_spt` from the SPT
 *     loose-loot samples.
 *
 * The table only ever carried the WIKI names, and `classify()` silently `continue`s on a type it
 * does not know — so **1,480 of the 3,627 containers in the three shipped maps (40.8%) were dropped
 * before they reached a layer**, with nothing anywhere reporting it (§6's failure mode exactly: a
 * filter that cannot say what it discarded). Both vocabularies are mapped now and the coverage is
 * asserted against the shipped data, so the next new type fails a test instead of vanishing.
 *
 * The `loot-*` split is by what the player DECIDES, not by what the item is. Judgement calls worth
 * knowing: a toolbox is barter money, so it is a VALUABLE (it used to sit under "Med & ammo"); a
 * ration crate is something you consume; a technical supply crate is a crate, so it is gear.
 */
export const CONTAINER_KIND = {
  // Hidden stashes keep their OWN kind (square, olive) — they are not loot you walk past.
  container_stash: 'stash', container_buried_barrel_cache: 'stash', container_ground_cache: 'stash',
  container_shturmans_stash: 'stash',
  // Consumables: what you burn in the raid.
  container_medcase: 'loot-consumables', container_medical: 'loot-consumables',
  container_medbag_smu06: 'loot-consumables', container_medical_supply_crate: 'loot-consumables',
  container_ammo: 'loot-consumables', container_wooden_ammo_box: 'loot-consumables',
  container_grenade_box: 'loot-consumables', container_grenade: 'loot-consumables',
  container_ration_supply_crate: 'loot-consumables',
  // Valuables: what you pocket for money.
  loot_loose: 'loot-valuables', loot_spt: 'loot-valuables', loot_key: 'loot-valuables',
  container_drawer: 'loot-valuables', container_jacket: 'loot-valuables',
  container_toolbox: 'loot-valuables', container_tool: 'loot-valuables',
  container_safe: 'loot-valuables', container_cash_register: 'loot-valuables', container_cash: 'loot-valuables',
  container_pc: 'loot-valuables', container_pc_block: 'loot-valuables',
  // Gear: big kit containers and bodies.
  container_weapon_box: 'loot-gear', container_weapon: 'loot-gear',
  container_duffle_bag: 'loot-gear', container_duffle: 'loot-gear',
  container_wooden_crate: 'loot-gear', container_crate: 'loot-gear', container_greencrate: 'loot-gear',
  container_supply: 'loot-gear', container_technical_supply_crate: 'loot-gear',
  container_pmc_body: 'loot-gear', container_dead_scav: 'loot-gear', container_civilian_body: 'loot-gear',
  container_dead: 'loot-gear',
};
/**
 * The per-item name the map face no longer draws. The badge says "valuables"; the hover label and
 * the popup still say "Medbag SMU06" — the data does not lose the distinction, only the 12 px icon
 * does. `c.name` from the API wins where it exists; this is the fallback and the popup's second
 * line, so it has to cover every type above.
 */
export const CONTAINER_TYPE = {
  container_stash: 'Hidden stash', container_buried_barrel_cache: 'Buried barrel cache',
  container_ground_cache: 'Ground cache', container_shturmans_stash: "Shturman's stash",
  container_medcase: 'Medcase', container_medical: 'Medical bag', container_medbag_smu06: 'Medbag SMU06',
  container_medical_supply_crate: 'Medical supply crate', container_ammo: 'Ammo box',
  container_wooden_ammo_box: 'Wooden ammo box', container_grenade_box: 'Grenade box',
  container_grenade: 'Grenade box', container_ration_supply_crate: 'Ration supply crate',
  loot_loose: 'Marked loose loot', loot_spt: 'SPT loose-loot point', loot_key: 'Key spawn',
  container_drawer: 'Drawer', container_jacket: 'Jacket', container_toolbox: 'Toolbox',
  container_tool: 'Tool container', container_safe: 'Safe', container_cash_register: 'Cash register',
  container_cash: 'Cash register', container_pc: 'PC', container_pc_block: 'PC block',
  container_weapon_box: 'Weapon box', container_weapon: 'Weapon box', container_duffle_bag: 'Duffle bag',
  container_duffle: 'Sports bag', container_wooden_crate: 'Wooden crate', container_crate: 'Supply crate',
  container_greencrate: 'Wooden crate', container_supply: 'Supply container',
  container_technical_supply_crate: 'Technical supply crate', container_pmc_body: 'PMC body',
  container_dead_scav: 'Dead scav', container_civilian_body: 'Civilian body', container_dead: 'Dead body',
};
/**
 * A returning visitor's saved layer set (`tz:kinds`) still names the seven pre-collapse loot kinds.
 * Fold them onto their family so "I had safes on" stays true across the update; main.js drops
 * anything this build no longer knows, so an unknown string cannot live in storage forever.
 *
 * This is the ONE place the dead kind strings may appear — `scripts/icons-test.mjs` scans src/ and
 * scripts/ for them and excludes exactly this table.
 */
export const LEGACY_KIND = {
  'loot-med': 'loot-consumables',
  'loot-cash': 'loot-valuables', 'loot-key': 'loot-valuables', 'loot-loose': 'loot-valuables',
  'loot-weapon': 'loot-gear', 'loot-crate': 'loot-gear', 'loot-dead': 'loot-gear',
};

// Letter codes for extracts (re3mr-style badges); null -> draw the glyph
export const EXTRACT_LETTER = { 'Dorms V-Ex': 'D', 'Crossroads': 'C', 'Trailer Park': 'TP', 'Old Gas Station': 'OG', 'RUAF Roadblock': 'R', "Smugglers' Boat": 'SB', 'ZB-1011': '11', 'Smugglers\' Bunker (ZB-1012)': '12', 'ZB-013': '13', 'Railroad to Tarkov': 'R2', 'Railroad to Port': 'R1', 'Railroad to Military Base': 'R3', 'Sniper Roadblock': 'N', 'Old Road Gate': 'O', 'Passage Between Rocks': 'P', 'Military Base CP': 'M', 'Scav Checkpoint': 'S', 'Administration Gate': 'A', 'Factory Far Corner': 'F', 'Warehouse 4': '4', 'Factory Shacks': 'Y', 'Old Gas Station Gate': 'L', 'Warehouse 17': '17', "Trailer Park Workers' Shack": 'I', 'Boiler Room Basement (Co-op)': 'Z', 'Railroad Passage (Flare)': 'W', 'Transit to Factory': 'H', 'Transit to Reserve': 'V', 'Transit to Interchange': 'G', 'Transit to Shoreline': 'E' };
export const extractLetter = (name) => EXTRACT_LETTER[(name || '').trim()] ?? null;

/* ------------------------------------------------- extract requirements --- */
// What an extract asks of you, short enough to be a HUD chip. The raw notes are sentences
// ("Requires lever activation in warehouse #4 and Factory emergency exit key"), so these are
// hand-written. Lives here rather than in map3d.js because 2D shows the same text in the popup
// and the hover tooltip, and both views share the corner glyph keyed off `EXTRACT_REQ`.
export const EXTRACT_SUB = {
  'Old Gas Station': 'REQ: GREEN FLARE', 'Railroad Passage (Flare)': 'REQ: GREEN FLARE',
  "Smugglers' Boat": 'REQ: VORON NOTE', "Smugglers' Bunker (ZB-1012)": 'REQ: VORON NOTE',
  'Dorms V-Ex': 'REQ: 20K ROUBLES', 'ZB-013': 'REQ: LEVER + KEY',
  'RUAF Roadblock': 'PVE ONLY', 'Boiler Room Basement (Co-op)': 'CO-OP · PMC + SCAV',
};
export const SUB_BY_KIND = { 'extract-pmc': 'PMC ONLY', 'extract-scav': 'SCAV ONLY', 'extract-shared': 'PMC + SCAV', 'extract-transit': 'TRANSIT · 1 MIN' };
/** The requirement line for one extract marker ({kind, name}). */
export const subText = (m) => EXTRACT_SUB[(m?.name || '').trim()] ?? SUB_BY_KIND[m?.kind] ?? '';
/**
 * The requirement CLASS, drawn as a corner glyph on the badge. The full line only appears on
 * hover/selection now (step 4) — a permanent second line under every extract at every zoom was
 * half the marker soup — so the badge itself has to say "this one costs you something".
 */
export const EXTRACT_REQ = {
  'Old Gas Station': 'flare', 'Railroad Passage (Flare)': 'flare',
  "Smugglers' Boat": 'key', "Smugglers' Bunker (ZB-1012)": 'key', 'ZB-013': 'key',
  'Dorms V-Ex': 'cash', 'Boiler Room Basement (Co-op)': 'coop',
};
export const extractReq = (name) => EXTRACT_REQ[(name || '').trim()] ?? null;

// badge key line; ink and cream come straight from the TRACK C palette
const KEY = '#0E1211', CREAM = '#E6E3D7';
// The one glyph tone. Near-white, not pure white: at 22 px pure white on a mid-value badge blooms.
const STENCIL = '#F2F0E7';
const HEX = 'M12 1.6 21.1 6.8v10.4L12 22.4 2.9 17.2V6.8z';
const SHIELD = 'M12 1.7 21.2 5v7.4c0 4.7-4.3 7.9-9.2 9.9-4.9-2-9.2-5.2-9.2-9.9V5z';
/*
 * Badge layout (24-unit viewBox, plate 1.8..22.2 with a 1.5 keyline, so ~2.55..21.45 is inside).
 *
 * QA H3: the badge cut the top of its own letter against the plate edge and the bottom of its
 * corner chips against the opposite one, and the dashed underground outline drew over the letter.
 * Two causes, both about assuming a face we do not have:
 *
 *   - The letter was set at a font size tuned for the display face with no width constraint. The
 *     3D atlas rasterises these through an `<img>`, and an SVG loaded as an image cannot see the
 *     PAGE's webfonts — it falls back to a much wider face, and "OG" / "SB" measured 15.9 of the
 *     18.9 units the plate has inside its keyline, running into both edges. `textLength` pins the
 *     ink instead, which also makes 2D and 3D draw the badge identically for the first time (the
 *     document path DOES see the webfont, so the two used to be different widths).
 *
 *     2026-09-02: the display face moved Barlow Condensed -> IBM Plex Sans Condensed, so the
 *     `font-family` on this <text> moved with it. That is a NAME change only — the pinning is what
 *     makes it safe. `textLength` + `lengthAdjust='spacingAndGlyphs'` forces any face, webfont or
 *     `<img>` fallback, to the same 12.6 / 15.6 units for 2- and 3-character letters, so 2D/3D
 *     parity is a property of the pin and not of which font happens to resolve. The unpinned case
 *     (len 0) is single letters only, which have never been near the plate edge at size 13.
 *     Verified headless: same SVG drawn inline (webfont visible) and via an `<img>` data URL
 *     (webfont invisible) rasterises to the SAME letter ink bounding box for "OG"/"SB"/"17" —
 *     see the run recorded in the loot-collapse handoff.
 *   - The corner chips were an 8.2-unit square placed at 14.1..22.3, i.e. across the plate's
 *     rounded corner and 0.1 past its bottom edge. They are 7.2 units inside the plate now, in
 *     their own band under the letter, which is why the letter's baseline lifts when a badge
 *     carries one.
 */
const PLATE = { top: 1.8, bottom: 22.2, size: 20.4, r: 5 };
// The plate's corners are rounded (rx 5), so the bottom of the band is NARROWER than the plate:
// at the chips' bottom edge the plate's own left boundary is x ≈ 3.13, not 1.8. These four
// numbers are what keeps a chip inside the corner instead of poking out of it.
const CHIP = { size: 6.6, top: 14.0, left: 3.1, right: 14.3 };
// The chips' art is authored against the ORIGINAL 8.2-unit box at (1.7|14.1, 14.1); this is the
// transform that drops that box onto the band above, so the drawings themselves never move.
const CHIP_S = CHIP.size / 8.2;
const chipAt = (x0) => `translate(${(x0 - CHIP_S * (x0 === CHIP.left ? 1.7 : 14.1)).toFixed(3)} ${(CHIP.top - CHIP_S * 14.1).toFixed(3)}) scale(${CHIP_S.toFixed(4)})`;
/** Letter metrics: font size, the ink width it is pinned to, and the baseline. */
function letterBox(letter, hasChip) {
  const n = letter.length;
  const size = n > 2 ? 9 : n > 1 ? 11 : 13;
  // One glyph keeps its natural width — `spacing` has nothing to adjust and `spacingAndGlyphs`
  // would only distort it. Two and three are the ones that overran the plate.
  const len = n > 2 ? 15.6 : n > 1 ? 12.6 : 0;
  return { size, len, base: hasChip ? 13.2 : 16.6 };
}

// Corner marks. ~7 px square in the badge's bottom-left, ink plate + one near-white stroke, so a
// requirement reads as "there is a condition" at icon size and as which one when you lean in.
const REQ_MARK = {
  flare: `<path d='M5.8 15.5v5.4M3.5 16.9l4.6 2.6M8.1 16.9l-4.6 2.6' fill='none' stroke='${STENCIL}' stroke-width='1.15' stroke-linecap='round'/>`,
  key: `<circle cx='4.7' cy='17.1' r='1.55' fill='none' stroke='${STENCIL}' stroke-width='1.1'/><path d='M5.8 18.2 8.4 20.8M7.1 19.5l-.9.9' fill='none' stroke='${STENCIL}' stroke-width='1.1' stroke-linecap='round'/>`,
  cash: `<path d='M4.6 15.5v5.4M4.6 15.5h2a1.6 1.6 0 0 1 0 3.2h-2M3.4 19.7h3.5' fill='none' stroke='${STENCIL}' stroke-width='1.1' stroke-linecap='round'/>`,
  coop: `<circle cx='4.6' cy='18.1' r='1.5' fill='none' stroke='${STENCIL}' stroke-width='1.05'/><circle cx='7.1' cy='18.1' r='1.5' fill='none' stroke='${STENCIL}' stroke-width='1.05'/>`,
};
// Where the glyph sits inside each shape. A shield's usable area is higher and narrower than a
// circle's, so one shared transform would push the spawn art through the point.
const GLYPH_FIT = { sq: 'translate(4.6 4.6) scale(.62)', ci: 'translate(4.6 4.6) scale(.62)', hex: 'translate(4.9 4.9) scale(.59)', dia: 'translate(5.2 5.2) scale(.57)', sh: 'translate(4.9 3.9) scale(.59)' };
/*
 * THE INK HALO (2026-09-03) — shields and diamonds only.
 *
 * The one-tone stencil rule says the glyph is always the same near-white. That works over a
 * mid-value plate and fails at both ends of the value axis: a near-white crosshair on a pale tan
 * scav shield is a white-on-white silhouette, and the whole reason the four spawns read as one
 * blob at 22 px. The fix is not a second glyph tone — it is a KEYLINE, the same ink the plate's
 * own border uses, drawn under the glyph so the silhouette has an edge whatever the plate is
 * doing. It is what lets `lock` be pale steel and `weapon` be near-black in the same family.
 *
 * Squares (extracts/stashes), circles (loot) and the quest hexagon are deliberately NOT haloed:
 * their plates are mid-value by construction and the founder approved that look as it stands.
 *
 * The width is in the ART's own 512-unit space, because `A()` wraps every glyph in
 * `scale(0.046875)` and a stroke-width set outside it is still resolved on the path. 64 units ->
 * 64 * 0.046875 * 0.59 ≈ 1.77 badge units ≈ 1.6 px on a 22 px shield, half of which sits outside
 * the silhouette: enough to give the glyph an edge, not enough to close the crosshair's arms.
 */
/*
 * WHICH FAMILIES ARE HALOED, AND WHY IT IS KEYED ON SHAPE RATHER THAN ON MEASURED PLATE VALUE.
 *
 * The defect the halo fixes is a property of the COLOUR (a near-white glyph on a light plate), not
 * of the shape — so keying on shape is a decision, not a derivation, and two of the three excluded
 * families do contain light plates: `quest-objective` #D8A32B and `loot-valuables` #CBA33C keep the
 * bare look at the two kinds a player most needs to read. That is the founder's approved look as it
 * stands, so it is recorded here as an explicit accepted trade rather than left implicit.
 *
 * `scripts/icons-test.mjs` measures every plate's contrast against `STENCIL` and asserts the haloed
 * SET matches this one, printing the numbers. So the day a palette move creates a third low-contrast
 * plate, the suite says which kind and by how much instead of staying silent.
 */
export const GLYPH_HALO = new Set(['sh', 'dia']);
export const HALO_W = 64;
export const glyphInk = (shape, art) => (GLYPH_HALO.has(shape)
  ? `<g fill='${KEY}' stroke='${KEY}' stroke-width='${HALO_W}' stroke-linejoin='round' opacity='.85'>${art}</g>`
  : '') + `<g fill='${STENCIL}'>${art}</g>`;
/** The badge palette's two fixed tones, exported so a test can measure contrast against them. */
export const BADGE_TONES = Object.freeze({ ink: KEY, stencil: STENCIL, cream: CREAM });
function badgeSvg(k0, letter, level = 'surface', tint = null, req = null) {
  const k = tint ? { ...k0, color: tint, color2: null } : k0;
  const path = k.shape === 'hex' ? HEX : k.shape === 'sh' ? SHIELD : null;
  const shape = k.shape === 'ci' ? `<circle cx='12' cy='12' r='10.4' fill='${k.color}'/>`
    : k.shape === 'sq' ? `<rect x='${PLATE.top}' y='${PLATE.top}' width='${PLATE.size}' height='${PLATE.size}' rx='${PLATE.r}' fill='${k.color}'/>`
    : path ? `<path d='${path}' fill='${k.color}'/>`
    : `<rect x='4' y='4' width='16' height='16' rx='3' transform='rotate(45 12 12)' fill='${k.color}'/>`;
  // Shared extracts are the one two-colour badge: half PMC green, half scav orange.
  const split = k.color2 ? `<clipPath id='c'><rect x='1.8' y='1.8' width='20.4' height='20.4' rx='5'/></clipPath><path d='M1.8 22.2 22.2 1.8v20.4z' fill='${k.color2}' clip-path='url(#c)'/>` : '';
  // One keyline, in ink — it is what holds the badge together over a bright satellite tile. The
  // cream inner rule that used to sit inside it was a third tone and pure noise below ~20 px.
  const key = k.shape === 'ci' ? `<circle cx='12' cy='12' r='10.4' fill='none' stroke='${KEY}' stroke-width='1.5'/>`
    : k.shape === 'sq' ? `<rect x='${PLATE.top}' y='${PLATE.top}' width='${PLATE.size}' height='${PLATE.size}' rx='${PLATE.r}' fill='none' stroke='${KEY}' stroke-width='1.5'/>`
    : path ? `<path d='${path}' fill='none' stroke='${KEY}' stroke-width='1.5'/>`
    : `<rect x='4' y='4' width='16' height='16' rx='3' transform='rotate(45 12 12)' fill='none' stroke='${KEY}' stroke-width='1.5'/>`;
  const ring = k.ring ? `<circle cx='12' cy='12' r='11.6' fill='none' stroke='${CREAM}' stroke-width='0.8'/>` : '';
  const isUnder = level === 'underground';
  const hasChip = isUnder || !!REQ_MARK[req];
  const lb = letter ? letterBox(letter, hasChip) : null;
  const inner = letter
    ? `<text x='12' y='${lb.base}' text-anchor='middle'${lb.len ? ` textLength='${lb.len}' lengthAdjust='spacingAndGlyphs'` : ''} font-family='IBM Plex Sans Condensed, Arial Narrow, sans-serif' font-weight='700' font-size='${lb.size}' fill='${STENCIL}'>${letter}</text>`
    : `<g transform='${GLYPH_FIT[k.shape] ?? GLYPH_FIT.sq}'>${glyphInk(k.shape, GLYPH[k.glyph])}</g>`;
  // An underground badge must remain recognisable even when its colour is muted by
  // the marker-opacity setting: dashed extract outline + a universal down/stairs cue. The outline
  // is drawn UNDER the letter — it is the plate's border, and it used to cross the glyphs.
  const dash = isUnder && k.shape === 'sq'
    ? `<rect x='2.8' y='2.8' width='18.4' height='18.4' rx='4.2' fill='none' stroke='#FFD28A' stroke-width='1.2' stroke-dasharray='2.3 1.7'/>` : '';
  const underground = isUnder
    ? `<g transform='${chipAt(CHIP.right)}'><rect x='14.1' y='14.1' width='8.2' height='8.2' rx='2' fill='${KEY}' stroke='#FFD28A' stroke-width='.7'/><path d='M18.2 15.8v4.5m-1.7-1.7 1.7 1.7 1.7-1.7' fill='none' stroke='#FFD28A' stroke-width='1.25' stroke-linecap='round' stroke-linejoin='round'/></g>`
    : '';
  // Bottom-LEFT, because the underground cue owns the bottom-right corner and an extract can
  // easily be both (Smugglers' Bunker is underground and needs the Voron note).
  const reqMark = REQ_MARK[req]
    ? `<g transform='${chipAt(CHIP.left)}'><rect x='1.7' y='14.1' width='8.2' height='8.2' rx='2' fill='${KEY}' stroke='${STENCIL}' stroke-width='.8' stroke-opacity='.8'/>${REQ_MARK[req]}</g>`
    : '';
  return `${shape}${split}${key}${ring}${dash}${inner}${underground}${reqMark}`;
}
export function iconHtml(kind, size = 24, letter = null, level = 'surface', tint = null, req = null) {
  const k = KINDS[kind];
  return `<div class="mk ${k.shape} level-${level}" style="width:${size}px;height:${size}px"><svg viewBox="0 0 24 24" width="${size}" height="${size}">${badgeSvg(k, letter, level, tint, req)}</svg></div>`;
}
export function iconDataUrl(kind, size = 48, letter = null, level = 'surface', tint = null, req = null) {
  const k = KINDS[kind];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}">${badgeSvg(k, letter, level, tint, req)}</svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

/* ---------------------------------------------------------------- dot tier --- */
// Above ~0.33 m/px a badge is a lie: it claims 22 px of importance for a loose-loot point you
// cannot even walk to yet. The dot tier keeps the CATEGORY (its colour) and drops everything else.
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
/** Pull a category colour toward its own grey and darken it a touch. */
export function desaturate(hex, amount = 0.55, dim = 0.92) {
  const [r, g, b] = rgbOf(hex);
  const l = 0.299 * r + 0.587 * g + 0.114 * b;
  const mix = (c) => (c + (l - c) * amount) * dim;
  return `#${hex2(mix(r))}${hex2(mix(g))}${hex2(mix(b))}`;
}
/**
 * The dot colour for a kind, as CSS hex / as an RGB array for deck.gl.
 *
 * IT THROWS ON AN UNKNOWN KIND, exactly as `iconHtml` does. Until 2026-09-03 it fell back to
 * `desaturate('#808682')` — the RETIRED `lock` grey — so the same input crashed loudly at the badge
 * tier and drew a plausible grey circle at the dot tier. A kind that went missing from `KINDS` (a
 * rename, a bad `LEGACY_KIND` migration) therefore vanished into legitimate-looking dots at exactly
 * the zoom where a reviewer is looking at the whole map, and only became visible on zooming in far
 * enough to hit the badge. That is this repo's recurring failure shape, and its own rule applies:
 * fail where the bad value is, rather than quietly inheriting one and being believed.
 *
 * `src/marker-overlay.js` already refuses rather than guesses (`if (!KINDS[kind]) return null`);
 * this is the icons module stopping undercutting it for every other caller.
 */
export function dotColor(kind) {
  const k = KINDS[kind];
  if (!k) throw new Error(`unknown marker kind: ${String(kind)}`);
  return desaturate(k.color);
}
export const dotRgb = (kind) => rgbOf(dotColor(kind));
/*
 * THE DOT KEEPS ITS FAMILY (2026-09-03).
 *
 * The dot tier used to be one CSS box per kind — `background: <colour>` on a `.mk-dot` div — so at
 * 6 px every marker on the map was the same mark and family disambiguation collapsed onto colour
 * at exactly the zoom where colour is least reliable (55% desaturated, over terrain, at
 * `--marker-opacity`). Shape is the ONE channel that survives a 6 px mark: a diamond and a circle
 * differ in silhouette even when both are mud.
 *
 * So the dot is now the family's own outline, drawn as a 12-unit SVG scaled to `size`, with the
 * plate's ink as a keyline exactly as the badge has. Colour still says WHICH kind; shape says
 * which FAMILY, and the two are independent again. The paths are the badge shapes reduced to a
 * 12-unit box — not new artwork, and nothing here re-draws a glyph.
 */
const DOT_SHAPE = {
  sq:  `<rect x='1.5' y='1.5' width='9' height='9' rx='2'/>`,
  ci:  `<circle cx='6' cy='6' r='4.6'/>`,
  dia: `<path d='M6 1 11 6 6 11 1 6z'/>`,
  sh:  `<path d='M6 1.1 10.6 2.8v3.8c0 2.3-2.2 3.6-4.6 4.3-2.4-.7-4.6-2-4.6-4.3V2.8z'/>`,
  hex: `<path d='M6 1 10.3 3.5v5L6 11 1.7 8.5v-5z'/>`,
};
/**
 * 6 px desaturated mark in the category colour, cut to the FAMILY shape — no glyph, no letter.
 *
 * Throws on an unknown kind (via `dotColor`), so the dot tier and the badge tier now agree about
 * what an unknown kind is. A `?? 'ci'` here would have drawn a circle for it, which is a real loot
 * family.
 */
export function dotHtml(kind, size = 6) {
  const shape = KINDS[kind]?.shape;
  if (!shape) throw new Error(`unknown marker kind: ${String(kind)}`);
  return `<div class="mk-dot mk-dot-${shape}" style="width:${size}px;height:${size}px">`
    + `<svg viewBox="0 0 12 12" width="${size}" height="${size}">`
    + `<g fill="${dotColor(kind)}" stroke="${KEY}" stroke-width="1.5" stroke-linejoin="round">${DOT_SHAPE[shape]}</g>`
    + `</svg></div>`;
}

/* -------------------------------------------------------------- clustering --- */
/** How a count is written on a cluster: 3-digit crowds become "99+" rather than blowing the bubble. */
export const clusterCount = (n) => (n > 99 ? '99+' : String(n));
/**
 * One cluster marker: the tier's own mark (dot or badge), plus a count bubble from the `icon` tier
 * in. Clicking it zooms one step in, which is what splits it — see main.js / map3d.js.
 *
 * At `dot` the mark is just a slightly larger dot: the count would be unreadable at that scale and
 * only adds noise (see `countsVisible` in lod.js — both views read that one rule). The exact count
 * is still one hover away, on the tooltip main.js binds.
 */
export function clusterHtml(kind, count, tier = 'dot') {
  if (!countsVisible(tier)) {
    return `<div class="mk-cluster mk-cluster-dot">${dotHtml(kind, CLUSTER_DOT_PX)}</div>`;
  }
  return `<div class="mk-cluster mk-cluster-${tier}">${iconHtml(kind, 20)}<span class="mk-count mono">${clusterCount(count)}</span></div>`;
}
export const soldierDataUrl = (color, size = 64) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}"><circle cx="12" cy="12" r="11.5" fill="#0a0e0c" fill-opacity=".55"/><g fill="${color}" transform="translate(2.6 2.6) scale(.78)">${GLYPH.gi_gasmask}</g></svg>`);
export const arrowDataUrl = (color, size = 64) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}"><path d="M12 2 20 21l-8-4-8 4z" fill="${color}" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>`);
