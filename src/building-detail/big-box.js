/**
 * Big-box detail planner — the ten gabled warehouses and three flat-roofed blocks.
 *
 * These are the biggest objects on Customs. Thirteen rows carry 58.6% of all building footprint
 * area between them, and today every one of them is an extruded polygon with a flat lid: Warehouse 4
 * is a 67.6 m unbroken mass, Warehouse 3 a 54.6 x 38.1 m one, and the founder's verdict on the set
 * was that the buildings "look like random boxes and cylinders".
 *
 * This module is PURE — no THREE, no DOM, no fs, no clock, no `Math.random` — for the same reason
 * `src/buildings.js`, `src/building-archetype.js` and `src/bridge-structure.js` are: it decides the
 * shape of the largest things on the map, and `scripts/building-detail-big-box.test.mjs` has to be
 * able to assert against the very function the renderer runs rather than a re-implementation of it.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS FILE WAS REWORKED (measured, 2026-09-02)
 *
 * The first version of this planner spent the archetype's detail budget on the wrong buildings.
 * Measured across the shipped system:
 *
 *     archetype       n    footprint         detail tri      tri / 100 m2
 *     lattice-tower   4      195 m2 (0.7%)   3,960 (44.9%)   2026
 *     big-box        13   17,209 m2 (58.6%)    482 ( 5.5%)      2.8
 *
 * Four powerline pylons took 45% of the map's detail triangles; the thirteen buildings that ARE the
 * founder's complaint took 5.5%. The named worst cases were Streamer House (859 m2) at SIX
 * triangles, Crackhouse (395 m2) at six, Warehouse 7 (1,025 m2) at sixteen and Warehouse 3
 * (2,075 m2) at thirty-two. Two causes, both fixed here:
 *
 *   1. A rectilinear unit narrower than `minUnitWidthM` was DROPPED from the decomposition rather
 *      than roofed some other way, so Streamer House's 8-vertex plan got one ridge over 97.7% of
 *      itself and 1.80 m of bare extruded lid beside it. Units are now a PARTITION: every rectangle
 *      is kept, and one too narrow to carry a legible ridge gets a flat roof deck instead of being
 *      deleted. Roof-plan coverage is asserted per building, on a lattice, in the test.
 *   2. Everything except the ridge was gated on one flag, `program === 'industrial' && !tiled`, so a
 *      tiled or occupied row received ONE RIDGE and nothing else. Detail is now gated on the thing
 *      each element actually needs — a monitor on bay depth, a dormer on a tiled pitch, a louvre on
 *      a ridge tall enough to hold one — and every gate scales its COUNT with the size of the unit
 *      it sits on, which is what makes the budget follow the footprint.
 *
 * ---------------------------------------------------------------------------------------------
 * WHERE THE PIXELS ARE, AND WHERE THEY ARE NOT
 *
 * Metres-per-pixel is exactly 2^-zoom and the default 3D zoom is 0, so AT THE DEFAULT VIEW ONE
 * PIXEL IS ONE METRE. That single fact decides the whole budget:
 *
 *   spent here            roof form (ridges, bays, monitors), parapets and roof decks, roof plant
 *                         sized 1-4 m, dormers, gable louvres, headhouses, dock canopies —
 *                         everything 1 m or larger that changes the OUTLINE against the sky or
 *                         casts a shadow a person can see.
 *   deliberately not      wall ribs, pilasters, eave fascias, downpipes, window reveals. A 0.35 m
 *                         rib is a THIRD of a pixel at the view that matters; it costs triangles and
 *                         returns nothing. `downpipe` is a registered instanced family and this
 *                         planner declines it on exactly that ground.
 *
 * ---------------------------------------------------------------------------------------------
 * THE FOUR RULES THAT SHAPE EVERY NUMBER BELOW
 *
 *  1. **ONE RIDGE PER RECTILINEAR UNIT, NEVER ONE PER PLAN, AND EVERY UNIT IS ROOFED** (build
 *     decision 3). Six of the thirteen have `metrics.rectilinear === false`: Streamer House
 *     (fill 0.89), Depot (0.94), Dorms 3-Story (0.74), Oil Rig (0.78), Warehouse 17 (0.66) and
 *     Repair Shop (0.54). Throwing one ridge across Repair Shop's plan would put a roof over
 *     3,540 m2 of oriented bounding box for a building whose footprint is 1,921 m2.
 *     `decomposeFootprint` cuts each plan into axis-aligned rectangles IN ITS OWN OBB FRAME; a
 *     rectangle wide enough for a ridge gets one (`role: 'ridge'`), and one that is not gets a flat
 *     roof deck (`role: 'deck'`). NOTHING is dropped, because a dropped rectangle is a piece of
 *     building with no roof on it.
 *
 *  2. **PITCH FIRST, AND THEN BAYS — never a constant ridge rise.** A constant rise is what puts a
 *     6-degree roof on a 38 m span, which is a flat lid with a crease in it. So the pitch is a
 *     property of the ROOF MATERIAL (`tanPitchFor`, read off the authored `roof` colour) and the
 *     SPAN is what varies: a unit wider than `maxGableSpanM` is not given a taller triangle, it is
 *     divided into that many parallel BAYS, which is what a real long-span shed is. Warehouse 3's
 *     38.1 m span becomes two 19.05 m bays with two ridges 19 m apart; Warehouse 7's 24.1 m span
 *     stays one bay.
 *
 *  3. **HEIGHTS ARE NEVER CHANGED** (handoff §4, standing decision 4). `height` is read and never
 *     written. The authored height is the EAVE — the top of the box the renderer extrudes — and roof
 *     form is added above it. Nothing here alters `b.height`, `b.floors` or the seat.
 *
 *  4. **...AND THE ROOF FORM IS BOUNDED, because `assemble.js` pays for it out of the walls.**
 *     `fitPlanToHeight()` keeps a building's TOTAL drawn height inside its data height by scaling
 *     the whole plan about the base, so every metre a planner adds above the eave is a metre the
 *     walls lose. Measured on the shipped planner: Warehouse 7 put 6.20 m above an 8.31 m eave —
 *     a 74% overshoot that squashed its wall to 4.76 m. Every element here is therefore capped at
 *     `aboveEaveBudgetFor(heightM)` = `maxRoofRiseFraction * heightM`, per element, at construction:
 *     the flue is shortened before the monitor, the monitor before the ridge, and the ridge itself
 *     only in the degenerate case. The bound is a pure function of the data height, so the test can
 *     assert it without re-deriving the geometry.
 *
 * ---------------------------------------------------------------------------------------------
 * THE ONE THING THAT LEAVES THE FOOTPRINT
 *
 * `dockCanopy` is the only element that projects past the walls, by `canopyProjectM` (2.4 m), and
 * the only one that lives BELOW the eave — which also makes it the only detail here that is free in
 * rule 4's budget. The side is chosen by probing the footprint ring, so a canopy is placed on an
 * edge that is really on the outside of the building rather than on an interior partition line. It
 * has never been seen on a real GPU and it is one constant from zero if it clashes with a neighbour.
 *
 * ---------------------------------------------------------------------------------------------
 * THE LOOK FLIP CANNOT MOVE A VERTEX
 *
 * `planDetail` takes `PLANNER_CONTEXT_KEYS` and nothing else; `look` is a forbidden key and
 * `validatePlannerContext` throws on it. Every number below comes from public data
 * (`poly`, `height`, `floors`, `kind`, `style`, `roof`, `color`) plus `classification.seed`, a hash
 * of the footprint centroid. There is no randomness, no game-derived coordinate and no per-building
 * literal anywhere in this file.
 */

import { gameToWorld } from '../three-world.js';
import {
  MATERIAL_SLOT_INDEX,
  emptyDetailPlan,
} from './contract.js';

const SLOT = MATERIAL_SLOT_INDEX;
const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const clamp = (low, value, high) => Math.min(high, Math.max(low, value));

// --------------------------------------------------------------------------------------------- //
// Frozen constants. Every one names the measurement or the pixel argument it came from.
// --------------------------------------------------------------------------------------------- //

export const BIG_BOX = Object.freeze({
  /**
   * TWO PITCHES, CHOSEN BY THE AUTHORED ROOF COLOUR — the cheapest real differentiation in the data.
   *
   * `building.roof` is present on 18 rows map-wide, 8 of them here, and `map3d-three.js` throws it
   * away today (`grep '.roof'` returns nothing). It is not decoration: it separates two families of
   * roof by construction. The warehouses carry the cool grey-blue [92,102,106] / [98,100,102] of
   * profiled metal sheet; Streamer House and Crackhouse carry the warm brown [126,76,52] of tile.
   * A metal sheet roof drains at a shallow pitch and a tiled one cannot — tiles need slope to shed
   * water — so the material the colour names decides the angle.
   *
   * 14 degrees is also the shallowest pitch that still READS at 1 m/pixel: a bay of span `s` puts
   * its ridge `s/2 * tan(14°)` = 0.249 * s/2 pixels above its eave, so the narrowest unit here
   * (Depot's 5.8 m wing) clears 0.7 px and the widest metal bay clears 2.4 px. Below about
   * 8 degrees every bay in this set falls under a pixel and renders as the flat lid it replaced.
   */
  industrialRoofPitchDeg: 14,
  tiledRoofPitchDeg: 24,
  /**
   * How much redder than bluer an authored roof must be to count as tile rather than metal. The two
   * families in this data are [126,76,52] (r - b = +74) and [92,102,106] / [98,100,102]
   * (r - b = -14 and -4), so the threshold sits in a 78-unit empty band and nothing is near it.
   */
  tiledRoofRedBias: 20,
  /**
   * The span above which a unit gets ANOTHER BAY instead of a taller ridge. 26 m is the widest
   * single-span portal frame that reads as one hall rather than a hangar, and it is what keeps the
   * rise bounded: 26/2 * tan(14°) = 3.24 m, on buildings 6.5-15.5 m tall. Measured effect on the
   * ten ridged rows: spans of 10.0, 16.2, 18.8, 24.1 and 24.7 m stay one bay; 30.1, 32.0, 36.5,
   * 38.1 and 38.9 m become two. Nothing here reaches three.
   */
  maxGableSpanM: 26,
  /** Below this a ridge is a crease, not a roof; the unit takes the flat-deck branch instead. */
  minRidgeRiseM: 0.45,
  /**
   * The verge/eave oversail. Zero triangles — it only moves the roof-plane corners outward — and it
   * is the difference between a roof that sits ON the walls and a lid that is flush with them.
   */
  eaveOverhangM: 0.45,

  /**
   * RULE 4'S BOUND, as a fraction of the building's own data height.
   *
   * `assemble.js` fits the whole plan inside the data height by scaling about the base, so a
   * building whose roof form stands `r` above its eave draws its eave at `h / (1 + r/h)`. At 0.45
   * the worst wall on Customs keeps 69% of its authored height; the shipped planner's worst was
   * Warehouse 7 at 0.746, which left 4.76 m of wall under an 8.31 m roof. It is a CEILING, not a
   * target: nine of the thirteen rows sit under it without being clamped at all.
   */
  maxRoofRiseFraction: 0.45,

  /**
   * Footprint decomposition. `gridMergeToleranceM` collapses coordinates closer than this into one
   * grid line, which is what stops the shipped SVG's tracing noise from becoming units: Depot's
   * ring carries a 0.4 m step ([489.7,-94.3] to [489.7,-93.9]) and Warehouse 17 a 0.3 m one, and
   * without the merge each becomes its own 0.4 m-wide "wing" with its own ridge.
   */
  gridMergeToleranceM: 0.75,
  /** A unit narrower than this cannot carry a legible ridge; it becomes a flat roof DECK, not a hole. */
  minUnitWidthM: 3,
  /** ...and one smaller than this is an annex rather than a hall: also a deck. */
  minUnitAreaM2: 20,
  /**
   * Below THIS a rectangle is tracing noise and is genuinely dropped. It is two orders of magnitude
   * under `minUnitAreaM2` on purpose: the difference between "too small for a ridge" and "not part
   * of the building" is the difference between a deck and a hole, and the first version of this
   * module conflated them.
   */
  minSliverWidthM: 0.6,
  minSliverAreaM2: 3,
  /** A hard stop on ridge units, so a pathological future footprint cannot explode the mesh. */
  maxUnits: 6,
  /** ...and on the total, decks included. */
  maxCoverUnits: 14,

  /**
   * Flat roof decks — the treatment for a unit too narrow or too small for a ridge, and the reason
   * `decomposeFootprint` no longer deletes anything. A deck stands `deckRiseM` proud of the eave so
   * that it reads as a separate lower-roofed annex against the hall beside it rather than as more
   * of the same lid; a big one gets a rim around a recessed deck instead of a solid block.
   */
  deckRiseM: 0.55,
  deckRimMinAreaM2: 60,
  deckParapetHeightM: 0.9,
  deckParapetThicknessM: 0.35,
  deckSlabRiseM: 0.06,

  /**
   * Parapets — the flat-parapet branch (Dorms 2-Story, Dorms 3-Story, Oil Rig). A Soviet panel
   * block's roofline is a rim, not an edge, and 1.0 m is the standard guard height. It stands ABOVE
   * the authored height for the same reason the ridge does: the renderer already draws a filled cap
   * at `roofY`, so a parapet recessed below it would be hidden by the very lid it is replacing.
   */
  parapetHeightM: 1.0,
  parapetThicknessM: 0.35,

  /**
   * Roof monitors — the raised clerestory that lights a deep floor plate. TWO THINGS CHANGED from
   * the first version, and both are why the big sheds were flat:
   *
   *   - The gate is GEOMETRY plus roof material, not `program`. A hall deep enough and long enough
   *     to need daylight gets one whatever the router thinks its programme is; a TILED roof never
   *     does, because a clerestory lantern on a house is a factory part on a home.
   *   - It is a RUN of lanterns, not one continuous spine. A 67.6 m ridge with one 47 m box on it
   *     reads as a thicker ridge; four 8.5 m lanterns 16 m apart read as a roof. The count comes
   *     from the bay LENGTH, which is what makes the triangle budget follow the building's size.
   */
  monitorMinBaySpanM: 9,
  monitorMinBayLengthM: 12,
  monitorHeightM: 1.5,
  /** A monitor squeezed under `maxRoofRiseFraction` to less than this is not worth its triangles. */
  monitorMinRiseM: 0.55,
  /**
   * One lantern per this much bay length, capped. 12 m is a real structural bay for a portal frame
   * and it is ~12 px between ridge interruptions at the view that matters: Warehouse 4's 67.6 m
   * ridge takes five, Warehouse 3's 54.6 m four, Warehouse 7's 42.6 m three.
   */
  monitorPitchM: 12,
  monitorMaxCount: 6,
  monitorRunMaxM: 11,
  /** Across the bay, as a fraction of the bay span, clamped so it is neither a rib nor a second roof. */
  monitorSpanFraction: 0.22,
  monitorMinWidthM: 1.6,
  monitorMaxWidthM: 5,
  /** The run of lanterns lives between these fractions of the bay length, leaving the ends clear. */
  monitorStartFraction: 0.15,
  monitorEndFraction: 0.85,

  /**
   * Gable-end louvres — the big ventilation panel under the apex of a metal shed's gable. 3 x 2 m
   * is three pixels by two at the view that matters, in `glazing`, which is the SAME slot the
   * monitors already take, so a louvre costs no draw call on any building that has a monitor and at
   * most the archetype's one permitted extra slot on any building that does not.
   *
   * It is offset `louvreProudM` out of the gable plane rather than drawn flush, because two
   * coplanar surfaces in different materials z-fight.
   */
  louvreMinRiseM: 1.6,
  louvreWidthFraction: 0.16,
  louvreMinWidthM: 2,
  louvreMaxWidthM: 4,
  louvreHeightFraction: 0.5,
  louvreMinHeightM: 0.9,
  louvreMaxHeightM: 2.6,
  louvreProudM: 0.12,
  louvreDepthM: 0.24,
  /** The apex is left clear by this fraction of the rise so the louvre sits under it, not through it. */
  louvreApexClearFraction: 0.15,

  /**
   * Dormers — what a TILED pitch gets where a metal one gets a lantern. Streamer House and
   * Crackhouse are the two rows with a tile roof colour, they are houses, and a dormer run is the
   * single most recognisable thing on a house roof at 1 m/pixel. Sized so the top of the box always
   * lands BELOW the ridge, which is why dormers cost nothing in rule 4's budget.
   */
  dormerPitchM: 9,
  dormerMaxPerSlope: 6,
  dormerLengthM: 2.6,
  dormerDepthM: 2.2,
  dormerRiseM: 1.1,
  dormerSillDropM: 0.5,
  /** Centre of the dormer, across the bay, as a fraction of the bay span from the ridge. */
  dormerOffsetFraction: 0.26,

  /**
   * Stair headhouse — the lift/stair overrun on a flat roof. Only on `flat-parapet` blocks with
   * `floors >= 2`, because a single-storey shed has no stair to overrun. 2.8 m puts it 1.8 m proud
   * of the parapet, so it breaks the rim line instead of hiding behind it. A block of four storeys
   * or more gets a lift overrun beside it, which is what a real panel block carries.
   */
  headhouseHeightM: 2.8,
  headhouseInsetM: 1.6,
  liftOverrunMinFloors: 4,
  /**
   * 3.4 m, not 3.7. The overrun stands 0.6 m proud of the headhouse and 2.4 m proud of the parapet,
   * which is enough for a second block to read in plan, and it is the tallest thing on a
   * flat-parapet roof — so under rule 4 every extra 0.3 m of it comes straight off Oil Rig's wall
   * (15.00 m of data height draws a 12.36 m eave at 3.4 and a 12.03 m one at 3.7).
   */
  liftOverrunHeightM: 3.4,

  /**
   * The roof plant screen — the low wall a Soviet block's plant deck sits behind. It is what makes
   * the flat roofs read as a RECESSED DECK inside a rim rather than as a lid with boxes on it, and
   * it is where the plant grid now lives, so the screen can never be drawn through the headhouse.
   */
  plantScreenHeightM: 1.1,
  plantScreenThicknessM: 0.3,
  plantScreenLengthFraction: 0.34,
  plantScreenWidthFraction: 0.55,
  plantScreenMinLengthM: 6,
  plantScreenMaxLengthM: 22,
  plantScreenMinWidthM: 5,
  plantScreenMaxWidthM: 16,
  plantScreenMarginM: 1.4,

  /**
   * Roof plant. Instanced map-wide, so the whole family costs ONE draw call however many buildings
   * contribute. SIZES ARE THE FIX HERE: the first version shipped 1.2 m plant blocks and 0.3 m
   * hatches, which are one pixel and a third of one. Everything below is 1-4 m, per the brief.
   */
  plantAreaPerUnitM2: 380,
  plantMaxCount: 12,
  plantSizeM: Object.freeze([2.8, 2.2, 1.9]),
  /** The biggest unit on a roof is a chiller, not another vent. Deterministic: always index 0. */
  chillerSizeM: Object.freeze([4.0, 3.0, 2.6]),
  plantEdgeInsetM: 2.6,
  /** Deterministic, seed-driven, and small enough that it never walks a block off its own deck. */
  plantJitterM: 0.6,
  /** A stair bulkhead, not a lid flush with the deck: 0.3 m tall was a third of a pixel. */
  hatchSizeM: Object.freeze([1.8, 1.3, 1.4]),
  hatchAreaThresholdsM2: Object.freeze([400, 1200, 2000]),
  /** A deck on a ridged plan big enough to carry plant of its own. */
  deckPlantMinAreaM2: 40,

  /**
   * Flues and chimneys. The first version required `program === 'industrial'` AND a 20 m span, which
   * left ten of the thirteen rows with none at all. A metal-roofed hall gets a FLUE off its widest
   * span; a tiled house gets a CHIMNEY, which is smaller and sits on the slope rather than the
   * ridge. Both are clamped to rule 4's ceiling and dropped rather than stubbed if they do not fit.
   */
  stackMinSpanM: 8,
  stackAreaPerUnitM2: 900,
  stackMaxCount: 4,
  stackSizeM: Object.freeze([1.1, 1.1, 3.6]),
  chimneySizeM: Object.freeze([0.9, 0.9, 2.4]),
  minStackHeightM: 1.2,
  /** Stacks ride the ridge line at these fractions, outside the monitor run. */
  stackFractions: Object.freeze([0.06, 0.94, 0.28, 0.72]),

  /**
   * Dock canopies — see "THE ONE THING THAT LEAVES THE FOOTPRINT" above. Only on a metal-roofed
   * hall's largest unit, only when that unit is long enough for a real dock, and only on a side
   * whose outward probe lands OUTSIDE the footprint ring, so a canopy is never hung off an interior
   * partition line where it would be buried inside the mass.
   */
  canopyMinUnitLengthM: 30,
  canopyProjectM: 2.4,
  canopyThicknessM: 0.4,
  canopyLengthFraction: 0.64,
  canopyHeightFraction: 0.42,
  canopyMinDropM: 2.5,
  canopyMaxDropM: 5.5,
  canopyProbeM: 0.8,

  /**
   * DOORS. The shipped planner declared none at all — on thirteen warehouses — which is why the
   * long walls read as blank extrusions however much roof went on top of them.
   *
   * They are `door-module` INSTANCES, so a dock door costs zero mesh triangles and the family costs
   * one draw call map-wide however many buildings hang doors off it. A 4.2 x 4.4 m roller shutter
   * is four pixels by four at the default view; its 0.3 m reveal is a third of one, which is why the
   * depth is only there to stop the panel z-fighting with the wall it sits in.
   *
   * Height is a FRACTION of the data height, never a constant: `assemble.js` scales the whole plan
   * to fit the data height, so a fraction stays proportional to the wall after the fit and a
   * constant would grow relative to it on exactly the buildings that get squashed most.
   */
  dockDoorWidthM: 4.2,
  dockDoorHeightFraction: 0.46,
  dockDoorMinHeightM: 3,
  dockDoorMaxHeightM: 5.2,
  personnelDoorWidthM: 2.2,
  personnelDoorHeightFraction: 0.32,
  personnelDoorMinHeightM: 2.1,
  personnelDoorMaxHeightM: 2.8,
  doorDepthM: 0.3,
  doorPitchM: 12,
  doorMinCount: 2,
  doorMaxCount: 8,
  /** The doors occupy this fraction of the wall, leaving the corners solid. */
  doorRunFraction: 0.86,

  /**
   * THE PROPORTIONALITY FLOOR, stated as arithmetic so the test does not have to invent one.
   *
   * `minDetailTrianglesFor(areaM2)` is the fewest mesh triangles a big-box row may carry. The
   * constants come from the defect: at 0.03 tri/m2 Warehouse 4 (2,027 m2) owes 71 triangles where
   * the shipped planner gave it 32, Warehouse 3 owes 68 against 32, Streamer House owes 32 against
   * 6 and Crackhouse 18 against 6. It is a FLOOR and not a target — the reworked planner clears it
   * by 21-180% — and it is deliberately below what this module now produces so that it fails on
   * regression rather than on rounding.
   */
  minDetailTriangleBase: 6,
  minDetailTrianglePerM2: 0.03,
});

const TAN_INDUSTRIAL_PITCH = Math.tan((BIG_BOX.industrialRoofPitchDeg * Math.PI) / 180);
const TAN_TILED_PITCH = Math.tan((BIG_BOX.tiledRoofPitchDeg * Math.PI) / 180);

/**
 * True when the authored roof colour names TILE rather than profiled metal sheet. Absent authored
 * colour means metal: the unauthored rows here (Big Red, the unnamed hall) are single-storey
 * industrial sheds, and assuming tile would put a house roof on a 61 m warehouse.
 */
export function hasTiledRoof(classification) {
  const colour = classification?.roofColor;
  if (!Array.isArray(colour) || colour.length < 3) return false;
  return num(colour[0]) - num(colour[2]) > BIG_BOX.tiledRoofRedBias;
}

/** The pitch this building's roof is built at, as a tangent. */
export const tanPitchFor = (classification) => (hasTiledRoof(classification) ? TAN_TILED_PITCH : TAN_INDUSTRIAL_PITCH);

/**
 * Rule 4, as a function of the data height alone — metres this planner may draw above the eave.
 *
 * It takes nothing but the height on purpose. A bound derived from the geometry it is bounding is
 * the metric that cannot fail (handoff §6); this one can be computed by a reader, by the test, and
 * by `assemble.js`, and all three get the same number.
 */
export const aboveEaveBudgetFor = (heightM) => Math.max(0, num(heightM)) * BIG_BOX.maxRoofRiseFraction;

/** The fewest mesh triangles a big-box row of this footprint may carry. See the constant block. */
export const minDetailTrianglesFor = (areaM2) => (
  BIG_BOX.minDetailTriangleBase + BIG_BOX.minDetailTrianglePerM2 * Math.max(0, num(areaM2))
);

// --------------------------------------------------------------------------------------------- //
// Footprint decomposition — the half of this module that decision 3 is about.
// --------------------------------------------------------------------------------------------- //

const toUV = (x, z, cos, sin) => [x * cos + z * sin, -x * sin + z * cos];

/**
 * Grid lines along one axis: every vertex coordinate, with anything inside
 * `gridMergeToleranceM` of its predecessor merged away, and the extreme always preserved.
 *
 * Preserving the extreme is not a nicety. Dropping it shrinks the grid, and a grid that does not
 * reach the footprint's own edge leaves a strip of roofless building along one side.
 */
function gridLines(values, tolerance) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (!sorted.length) return [];
  const out = [sorted[0]];
  for (const value of sorted.slice(1)) {
    if (value - out[out.length - 1] > tolerance) out.push(value);
  }
  const max = sorted[sorted.length - 1];
  if (max - out[out.length - 1] > 1e-9) {
    if (out.length >= 2) out[out.length - 1] = max;
    else out.push(max);
  }
  return out;
}

/** Ray-cast point-in-polygon. The ring may be concave; every plan here except six of them is. */
function pointInRing(ring, px, pz) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [xi, zi] = ring[index];
    const [xj, zj] = ring[previous];
    if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Cut one footprint into axis-aligned rectangles IN ITS OWN OBB FRAME, and give every one of them
 * a roof role.
 *
 * The method is a rectangular partition, not a heuristic: the vertex coordinates themselves supply
 * the grid lines, each cell is kept or dropped by testing its centre against the ring, and adjacent
 * kept cells are merged greedily into maximal rectangles in a fixed scan order — so the same
 * footprint always yields the same units, in the same order, forever.
 *
 * THE ROLE IS THE FIX. A rectangle wide and large enough for a legible ridge is `role: 'ridge'`;
 * anything smaller is `role: 'deck'` and gets a flat roof. Only genuine tracing noise — under
 * `minSliverWidthM` or `minSliverAreaM2` — is dropped, because the previous rule (drop anything
 * under `minUnitWidthM`) deleted Streamer House's 1.80 m leg and left it with no roof over it.
 *
 * It works because these plans really are rectilinear in their own frame: they were traced from an
 * SVG of rectilinear buildings. Measured over the thirteen big-box rows, every emitted unit lies
 * >= 98.9% inside the real footprint. The test asserts that AND the complementary property the
 * first version lacked: that the units cover the footprint on a lattice, so a roof that misses a
 * corner of its own building shows up as a coverage failure rather than as bare extruded lid.
 *
 * @returns {{units: Array, coveredAreaM2: number, footprintAreaM2: number, coverage: number,
 *            ridgeUnits: number, deckUnits: number, droppedSlivers: number}}
 */
export function decomposeFootprint(poly, metrics) {
  const ring2d = (Array.isArray(poly) ? poly : [])
    .filter((point) => Array.isArray(point) && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])))
    .map((point) => [Number(point[0]), Number(point[1])]);
  const footprintAreaM2 = num(metrics?.areaM2);
  const empty = {
    units: [], coveredAreaM2: 0, footprintAreaM2, coverage: 0,
    ridgeUnits: 0, deckUnits: 0, droppedSlivers: 0,
  };
  if (ring2d.length < 3) return empty;

  const yaw = num(metrics?.yawRad);
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const ring = ring2d.map(([x, z]) => toUV(x, z, cos, sin));
  const us = gridLines(ring.map((point) => point[0]), BIG_BOX.gridMergeToleranceM);
  const vs = gridLines(ring.map((point) => point[1]), BIG_BOX.gridMergeToleranceM);
  const columns = us.length - 1;
  const rows = vs.length - 1;
  if (columns < 1 || rows < 1) return empty;

  const filled = [];
  for (let row = 0; row < rows; row++) {
    const line = [];
    for (let column = 0; column < columns; column++) {
      line.push(pointInRing(ring, (us[column] + us[column + 1]) / 2, (vs[row] + vs[row + 1]) / 2));
    }
    filled.push(line);
  }

  // Maximal-rectangle merge, fixed scan order: grow right as far as the row allows, then grow down
  // while the whole width stays available. Deterministic by construction.
  const taken = filled.map((line) => line.map(() => false));
  const rectangles = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      if (!filled[row][column] || taken[row][column]) continue;
      let lastColumn = column;
      while (lastColumn + 1 < columns && filled[row][lastColumn + 1] && !taken[row][lastColumn + 1]) lastColumn++;
      let lastRow = row;
      grow: while (lastRow + 1 < rows) {
        for (let probe = column; probe <= lastColumn; probe++) {
          if (!filled[lastRow + 1][probe] || taken[lastRow + 1][probe]) break grow;
        }
        lastRow++;
      }
      for (let r = row; r <= lastRow; r++) for (let c = column; c <= lastColumn; c++) taken[r][c] = true;
      rectangles.push([us[column], us[lastColumn + 1], vs[row], vs[lastRow + 1]]);
    }
  }

  const all = rectangles.map(([u0, u1, v0, v1]) => {
    const du = u1 - u0;
    const dv = v1 - v0;
    const cu = (u0 + u1) / 2;
    const cv = (v0 + v1) / 2;
    const alongU = du >= dv;
    return {
      // The unit's own long axis. THIS is the ridge axis — never the whole plan's `metrics.yawRad`.
      yawRad: alongU ? yaw : yaw + Math.PI / 2,
      lengthM: Math.max(du, dv),
      widthM: Math.min(du, dv),
      areaM2: du * dv,
      centerX: cu * cos - cv * sin,
      centerZ: cu * sin + cv * cos,
    };
  });

  const survives = (unit) => unit.widthM >= BIG_BOX.minSliverWidthM && unit.areaM2 >= BIG_BOX.minSliverAreaM2;
  const ridgeWorthy = (unit) => unit.widthM >= BIG_BOX.minUnitWidthM && unit.areaM2 >= BIG_BOX.minUnitAreaM2;
  const byArea = (a, b) => (b.areaM2 - a.areaM2) || (a.centerX - b.centerX) || (a.centerZ - b.centerZ);

  const kept = all.filter(survives);
  const droppedSlivers = all.length - kept.length;
  const ridges = kept.filter(ridgeWorthy).sort(byArea).slice(0, BIG_BOX.maxUnits);
  const ridgeSet = new Set(ridges);
  const decks = kept.filter((unit) => !ridgeSet.has(unit)).sort(byArea);

  const units = [
    ...ridges.map((unit) => Object.freeze({ ...unit, role: 'ridge' })),
    ...decks.map((unit) => Object.freeze({ ...unit, role: 'deck' })),
  ].slice(0, BIG_BOX.maxCoverUnits);

  const coveredAreaM2 = units.reduce((sum, unit) => sum + unit.areaM2, 0);
  return {
    units,
    coveredAreaM2,
    footprintAreaM2,
    coverage: footprintAreaM2 > 0 ? coveredAreaM2 / footprintAreaM2 : 0,
    ridgeUnits: units.filter((unit) => unit.role === 'ridge').length,
    deckUnits: units.filter((unit) => unit.role === 'deck').length,
    droppedSlivers,
  };
}

/**
 * The bays of one unit, and the ridge each one carries.
 *
 * Rule 2 in one function: the count comes from the SPAN and the pitch is fixed by the roof material,
 * so the rise is a consequence rather than a choice. `riseM` below `minRidgeRiseM` means the bay
 * would be a crease — the caller sends the unit down the flat-deck branch instead.
 */
export function roofBays(unit, tanPitch = TAN_INDUSTRIAL_PITCH) {
  const span = num(unit?.widthM);
  const length = num(unit?.lengthM);
  if (!(span > 0) || !(length > 0)) return [];
  const count = Math.max(1, Math.ceil(span / BIG_BOX.maxGableSpanM));
  const baySpan = span / count;
  const riseM = (baySpan / 2) * tanPitch;
  if (riseM < BIG_BOX.minRidgeRiseM) return [];
  const bays = [];
  for (let index = 0; index < count; index++) {
    const bLo = -span / 2 + index * baySpan;
    bays.push({
      index,
      count,
      bLo,
      bHi: bLo + baySpan,
      bMid: bLo + baySpan / 2,
      baySpanM: baySpan,
      bayLengthM: length,
      riseM,
      /** Only the outermost eaves oversail; an interior valley has nothing to oversail into. */
      overhangLo: index === 0,
      overhangHi: index === count - 1,
    });
  }
  return bays;
}

/**
 * The evenly spaced lantern runs along one bay's ridge, in the unit's own `a` coordinate.
 *
 * One box 70% of the ridge long reads as a thicker ridge; a run of short ones reads as a roof, and
 * the COUNT following the bay length is what makes the triangle budget follow the building's size.
 * Pure and separately exported so the test can assert the count against the bay it came from.
 */
export function monitorRuns(bayLengthM) {
  const length = num(bayLengthM);
  if (!(length > 0)) return [];
  const count = clamp(1, Math.floor(length / BIG_BOX.monitorPitchM), BIG_BOX.monitorMaxCount);
  const startA = (BIG_BOX.monitorStartFraction - 0.5) * length;
  const endA = (BIG_BOX.monitorEndFraction - 0.5) * length;
  const available = endA - startA;
  const slot = available / count;
  const runM = Math.min(BIG_BOX.monitorRunMaxM, slot * 0.72);
  if (!(runM > 0.5)) return [];
  const runs = [];
  for (let index = 0; index < count; index++) {
    const centre = startA + slot * (index + 0.5);
    runs.push({ index, count, aLo: centre - runM / 2, aHi: centre + runM / 2, runM });
  }
  return runs;
}

// --------------------------------------------------------------------------------------------- //
// Mesh accumulation. Triangles are bucketed by material slot and concatenated in slot order, so the
// contract's "groups must be contiguous, sorted and cover every index" holds by construction rather
// than by a caller remembering to emit in the right order.
// --------------------------------------------------------------------------------------------- //

function createMesh() {
  const positions = [];
  const buckets = new Map();
  const push = (slot, a, b, c) => {
    if (!buckets.has(slot)) buckets.set(slot, []);
    buckets.get(slot).push(a, b, c);
  };
  return {
    /** A vertex in GAME coordinates plus a height; stored in WORLD space, as the contract requires. */
    vertex(x, z, y) {
      const [wx, wy, wz] = gameToWorld(x, z, y);
      positions.push(wx, wy, wz);
      return positions.length / 3 - 1;
    },
    tri: push,
    quad(slot, a, b, c, d) { push(slot, a, b, c); push(slot, a, c, d); },
    triangleCount() {
      let total = 0;
      for (const list of buckets.values()) total += list.length / 3;
      return total;
    },
    build() {
      if (!buckets.size) return null;
      const slots = [...buckets.keys()].sort((a, b) => a - b);
      const indices = [];
      const groups = [];
      for (const slot of slots) {
        const list = buckets.get(slot);
        groups.push({ start: indices.length, count: list.length, materialSlot: slot });
        indices.push(...list);
      }
      return {
        positions: new Float32Array(positions),
        indices: new Uint32Array(indices),
        groups,
      };
    },
  };
}

/** A point in a unit's own frame: `a` runs along the ridge, `b` across the span. */
const localPoint = (unit, a, b) => {
  const cos = Math.cos(unit.yawRad);
  const sin = Math.sin(unit.yawRad);
  return [unit.centerX + a * cos - b * sin, unit.centerZ + a * sin + b * cos];
};

/**
 * The four upright faces and the lid of a box standing on a CCW ring.
 *
 * Winding is the one thing here that cannot be checked by eye, so it is derived once and reused:
 * `gameToWorld` is a 180-degree rotation of the ground plane, which PRESERVES orientation, so a ring
 * wound counter-clockwise in game (x, z) is counter-clockwise in world (X, Y) and its lid faces +Z.
 * Walking that ring in order and emitting (P_low, Q_low, Q_high, P_high) puts each side's normal on
 * the ring's outside. `scripts/building-detail-big-box.test.mjs` asserts both facts on real output.
 */
function pushPrism(mesh, ring, loY, hiY, sideSlot, topSlot) {
  const low = ring.map(([x, z]) => mesh.vertex(x, z, loY));
  const high = ring.map(([x, z]) => mesh.vertex(x, z, hiY));
  for (let index = 0; index < ring.length; index++) {
    const next = (index + 1) % ring.length;
    mesh.quad(sideSlot, low[index], low[next], high[next], high[index]);
  }
  for (let index = 2; index < ring.length; index++) mesh.tri(topSlot, high[0], high[index - 1], high[index]);
}

/**
 * A rim standing on a ring: one prism per edge, inset by `thickness` on the ring's inside.
 *
 * Extracted so the parapet on a flat-parapet block, the rim around a recessed roof deck and the
 * roof-plant screen are all THE SAME GEOMETRY. Each segment is extended by its own thickness at
 * both ends, so corners overlap instead of leaving a notch: overlapping solids are seamless, and a
 * mitre on a concave corner is not.
 *
 * @param {Array<[number,number]>} ring  counter-clockwise, in GAME (x, z)
 */
function pushRim(mesh, ring, loY, hiY, thickness, sideSlot, topSlot) {
  let segments = 0;
  for (let index = 0; index < ring.length; index++) {
    const [px, pz] = ring[index];
    const [qx, qz] = ring[(index + 1) % ring.length];
    const dx = qx - px;
    const dz = qz - pz;
    const run = Math.hypot(dx, dz);
    if (!(run > 1e-6)) continue;
    const ex = dx / run;
    const ez = dz / run;
    // Outward normal of a CCW ring's edge: the edge direction rotated by -90 degrees.
    const nx = ez;
    const nz = -ex;
    const a = [px - ex * thickness, pz - ez * thickness];
    const b = [qx + ex * thickness, qz + ez * thickness];
    const c = [b[0] - nx * thickness, b[1] - nz * thickness];
    const d = [a[0] - nx * thickness, a[1] - nz * thickness];
    pushPrism(mesh, [a, b, c, d], loY, hiY, sideSlot, topSlot);
    segments += 1;
  }
  return segments;
}

/** A CCW rectangle ring in a unit's frame. */
const localRect = (unit, aLo, aHi, bLo, bHi) => [
  localPoint(unit, aLo, bLo),
  localPoint(unit, aHi, bLo),
  localPoint(unit, aHi, bHi),
  localPoint(unit, aLo, bHi),
];

// --------------------------------------------------------------------------------------------- //
// Instanced families. One unit prototype, shared by every family; the per-instance `scales` array
// carries the real metres, which is what lets three differently-sized objects ride one InstancedMesh.
// --------------------------------------------------------------------------------------------- //

/**
 * A unit box: 1 x 1 in plan, centred on the origin, standing from z = 0 to z = 1, +Z up, wound
 * outward. Built directly in WORLD axes because an instance prototype is never transformed through
 * `gameToWorld` — the offsets are.
 */
export function unitBoxPrototype() {
  const half = 0.5;
  const corners = [[-half, -half], [half, -half], [half, half], [-half, half]];
  const positions = [];
  const indices = [];
  const vertex = (x, y, z) => { positions.push(x, y, z); return positions.length / 3 - 1; };
  const low = corners.map(([x, y]) => vertex(x, y, 0));
  const high = corners.map(([x, y]) => vertex(x, y, 1));
  const quad = (a, b, c, d) => indices.push(a, b, c, a, c, d);
  for (let index = 0; index < 4; index++) {
    const next = (index + 1) % 4;
    quad(low[index], low[next], high[next], high[index]);
  }
  quad(high[0], high[1], high[2], high[3]);            // lid, +Z
  quad(low[0], low[3], low[2], low[1]);                // floor, -Z
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/**
 * A second deterministic hash, seeded from the building's centroid hash and an ordinal.
 *
 * `classification.seed` is one number per building; jittering N roof units apart needs N of them.
 * FNV-1a over the pair, exactly as `seedFor` hashes the centroid — same family, same guarantees,
 * and never `Math.random`, which is unavailable and would make the renderer irreproducible.
 */
function subSeed(seed, ordinal) {
  let hash = (seed ^ 0x9e3779b9) >>> 0;
  hash = Math.imul(hash ^ (ordinal + 0x85ebca6b), 0x01000193) >>> 0;
  hash ^= hash >>> 15;
  return hash >>> 0;
}
/** The sub-seed as a signed unit value in [-1, 1). */
const subUnit = (seed, ordinal) => (subSeed(seed, ordinal) / 0x100000000) * 2 - 1;

function familyDeclaration(familyId, buildingIndex, rows) {
  const count = rows.length;
  if (!count) return null;
  const offsets = new Float32Array(count * 3);
  const yaws = new Float32Array(count);
  const scales = new Float32Array(count * 3);
  const ownerIndex = new Int32Array(count);
  const levelAboveBaseM = new Float32Array(count);
  rows.forEach((row, index) => {
    const [wx, wy, wz] = gameToWorld(row.x, row.z, row.y);
    offsets[index * 3] = wx;
    offsets[index * 3 + 1] = wy;
    offsets[index * 3 + 2] = wz;
    // A game-frame heading of `yaw` is a world-frame heading of `yaw + PI` (world X is -gameX and
    // world Y is -gameZ, i.e. the plane is rotated by 180 degrees).
    yaws[index] = row.yawRad + Math.PI;
    scales[index * 3] = row.size[0];
    scales[index * 3 + 1] = row.size[1];
    scales[index * 3 + 2] = row.size[2];
    ownerIndex[index] = buildingIndex;
    levelAboveBaseM[index] = row.levelAboveBaseM;
  });
  return {
    familyId,
    count,
    prototype: unitBoxPrototype(),
    offsets,
    yaws,
    scales,
    ownerIndex,
    levelAboveBaseM,
  };
}

// --------------------------------------------------------------------------------------------- //
// The planner.
// --------------------------------------------------------------------------------------------- //

/**
 * Plan the detail for one `big-box` building.
 *
 * Returns `null` for any other archetype — a planner claims its own rows and nothing else, which is
 * the other half of the one-router invariant: the router assigns exactly one archetype per building
 * and each planner answers for exactly one archetype, so no building can be built twice.
 *
 * `context.groundYAt` is REQUIRED BY THE CONTRACT AND DELIBERATELY UNUSED HERE. Everything this
 * planner builds hangs off `seat.baseY + height`, which `seatBuilding()` has already reconciled with
 * the view's relief — the dock canopy included, because it is measured DOWN from the eave rather
 * than up from the ground. A planner that re-sampled the terrain would apply relief a second time.
 *
 * WHAT EACH BUILDING GETS, AND THE RULE BEHIND IT:
 *
 *   ridge unit          a gable roof per bay, bays from the span (rule 2), ridge on the unit's own
 *                       long axis (rule 1). Roof planes in `roof` and gable ends in `wall`, because
 *                       a gable end IS wall. Both slots are already on the building mesh: 0 calls.
 *   deck unit           a flat roof deck — a rim around a recessed deck when it is big enough for
 *                       one, a low solid block when it is not. This is what stops a wing from being
 *                       left as bare extruded lid (`wall` + `roof`: 0 calls).
 *   metal + deep bay    a RUN of clerestory lanterns along the ridge, one per `monitorPitchM`
 *                       (`glazing` + `roof`).
 *   metal + tall ridge  a gable-end louvre under each apex (`glazing`), same slot as the lanterns.
 *   tiled pitch         a run of dormers on each slope (`wall` + `roof`), never a factory lantern.
 *   flat-parapet        a 1.0 m parapet rim around the real footprint, a stair headhouse from two
 *                       storeys, a lift overrun from four, and a screened plant deck (`wall`+`trim`).
 *   metal hall          a flue on the ridge; a tiled house a chimney on the slope — instanced.
 *   flat roofs          walk-on plant, one chiller and roof hatches — instanced, 0 calls.
 *   long metal hall     one cantilevered dock canopy, BELOW the eave, on a side that is really
 *                       outside the footprint (`wall` + `roof`).
 *
 * Every count above is a function of the size of the thing it sits on, which is the whole point:
 * detail proportionate to how much of the screen the building occupies.
 */
export function planDetail(building, context) {
  const classification = context?.classification;
  if (!classification || classification.archetype !== 'big-box') return null;

  const buildingIndex = context.buildingIndex;
  const plan = emptyDetailPlan(buildingIndex, 'big-box');
  const seat = context.seat ?? {};
  const baseY = Number(seat.baseY);
  if (!Number.isFinite(baseY)) {
    // Loud, not silent. `seatBuilding()` names this field `base` and the contract names it `baseY`;
    // a planner that quietly accepted either would seat a roof on 0 the day the seam moved, and
    // handoff §6 is four pages of exactly that failure.
    throw new Error(`big-box planner: context.seat.baseY is required and must be finite (got ${seat.baseY})`);
  }

  const heightM = num(classification.heightM);
  const floors = Math.max(1, Math.floor(num(classification.floors, 1)));
  const seed = num(classification.seed) >>> 0;
  const roofY = baseY + heightM;
  // Rule 4: the ceiling every element below is clamped to, in absolute displayed metres.
  const budgetM = aboveEaveBudgetFor(heightM);
  const capY = roofY + budgetM;
  const metrics = classification.metrics ?? {};

  const decomposition = decomposeFootprint(building?.poly, metrics);
  const { units } = decomposition;
  plan.decomposition = decomposition;

  const elements = {
    ridgeBays: 0, decks: 0, monitors: 0, louvres: 0, dormers: 0,
    parapetSegments: 0, headhouses: 0, liftOverruns: 0, plantScreens: 0, canopies: 0,
  };
  plan.roofElements = elements;

  if (!units.length) {
    plan.notes.push('no rectilinear unit survived decomposition — the existing flat cap stands');
    return plan;
  }
  plan.notes.push(
    `${decomposition.ridgeUnits} ridge + ${decomposition.deckUnits} deck unit(s) cover `
    + `${(decomposition.coverage * 100).toFixed(1)}% of the ${decomposition.footprintAreaM2.toFixed(0)} m2 `
    + `footprint (fill ${num(metrics.fill).toFixed(3)}, ${decomposition.droppedSlivers} sliver(s) dropped)`,
  );

  const mesh = createMesh();
  const ring = (building?.poly ?? []).map(([x, z]) => [Number(x), Number(z)]);
  const largest = units[0]; // ridge units first, sorted by area, in `decomposeFootprint`
  const plantRows = [];
  const stackRows = [];
  const hatchRows = [];
  const doorRows = [];

  const tiled = hasTiledRoof(classification);
  const tanPitch = tanPitchFor(classification);

  /**
   * Which side of a unit's long axis is really on the OUTSIDE of the building.
   *
   * A decomposed plan's unit edges are partition lines as often as they are walls, and a door or a
   * canopy hung off an interior partition line is buried inside the mass beside it — geometry that
   * costs its triangles and is never seen. So the side is decided by probing the footprint ring,
   * and only when BOTH sides are outside does the centroid hash break the tie. `0` means neither
   * side is a wall and the caller must decline.
   */
  const outwardSideOf = (unit, probeM) => {
    if (ring.length < 3) return 0;
    const outward = [1, -1].filter((side) => {
      const [px, pz] = localPoint(unit, 0, side * (unit.widthM / 2 + probeM));
      return !pointInRing(ring, px, pz);
    });
    if (!outward.length) return 0;
    return outward.length === 1 ? outward[0] : (subSeed(seed, 3) & 1 ? 1 : -1);
  };
  const dockSide = outwardSideOf(largest, BIG_BOX.canopyProbeM);

  /**
   * Doors, on the largest unit's outward long wall — the same wall the dock canopy hangs over, on
   * purpose, because a loading dock is a canopy above a row of shutters.
   *
   * A hall gets roller shutters and anything else gets a personnel door. Both are instances, so the
   * whole set costs zero mesh triangles and one shared `door-module` mesh map-wide.
   */
  if (dockSide !== 0 && largest.lengthM > 6) {
    const hall = !tiled && classification.program === 'industrial';
    const width = hall ? BIG_BOX.dockDoorWidthM : BIG_BOX.personnelDoorWidthM;
    const doorHeightM = hall
      ? clamp(BIG_BOX.dockDoorMinHeightM, heightM * BIG_BOX.dockDoorHeightFraction, BIG_BOX.dockDoorMaxHeightM)
      : clamp(BIG_BOX.personnelDoorMinHeightM, heightM * BIG_BOX.personnelDoorHeightFraction, BIG_BOX.personnelDoorMaxHeightM);
    const run = largest.lengthM * BIG_BOX.doorRunFraction;
    const count = clamp(
      BIG_BOX.doorMinCount,
      Math.floor(largest.lengthM / BIG_BOX.doorPitchM),
      Math.min(BIG_BOX.doorMaxCount, Math.max(1, Math.floor(run / (width * 1.6)))),
    );
    // Half the reveal proud of the wall so the panel cannot z-fight with the extrusion behind it.
    const b = dockSide * (largest.widthM / 2 + BIG_BOX.doorDepthM / 2 - 0.05);
    for (let index = 0; index < count; index++) {
      const a = ((index + 0.5) / count - 0.5) * run;
      const [x, z] = localPoint(largest, a, b);
      doorRows.push({
        x, z, y: baseY,
        yawRad: largest.yawRad,
        size: [width, BIG_BOX.doorDepthM, doorHeightM],
        levelAboveBaseM: 0,
      });
    }
    plan.notes.push(
      `${count} ${hall ? 'dock shutter' : 'personnel door'}(s) ${width.toFixed(1)}x${doorHeightM.toFixed(1)} m `
      + `on the ${dockSide > 0 ? '+' : '-'} wall of the largest unit`,
    );
  }

  /**
   * A flat roof deck over one unit. The branch a wing takes when a ridge on it would be a crease.
   *
   * A big one becomes a RIM around a recessed deck, which is what makes an annex read as a roof
   * rather than as a taller lid; a small one becomes a low solid block, because a rim 0.35 m thick
   * around a 1.8 m wing is two walls with nothing between them.
   */
  const pushDeck = (unit) => {
    const topY = Math.min(roofY + BIG_BOX.deckRiseM, capY);
    if (!(topY > roofY + 1e-3)) return;
    const outline = localRect(unit, -unit.lengthM / 2, unit.lengthM / 2, -unit.widthM / 2, unit.widthM / 2);
    // The rim branch needs room for a rim on both sides AND a slab between them; below that the
    // inset rectangle inverts and ships a back-to-front triangle.
    const roomForRim = unit.widthM > 2 * (BIG_BOX.deckParapetThicknessM + 0.3);
    if (unit.areaM2 >= BIG_BOX.deckRimMinAreaM2 && roomForRim) {
      const rimTopY = Math.min(roofY + BIG_BOX.deckParapetHeightM, capY);
      pushRim(mesh, outline, roofY, rimTopY, BIG_BOX.deckParapetThicknessM, SLOT.wall, SLOT.roof);
      const slabY = Math.min(roofY + BIG_BOX.deckSlabRiseM, capY);
      const inset = BIG_BOX.deckParapetThicknessM;
      const slab = localRect(
        unit,
        -unit.lengthM / 2 + inset, unit.lengthM / 2 - inset,
        -unit.widthM / 2 + inset, unit.widthM / 2 - inset,
      );
      const corners = slab.map(([x, z]) => mesh.vertex(x, z, slabY));
      mesh.quad(SLOT.roof, corners[0], corners[1], corners[2], corners[3]);
    } else {
      pushPrism(mesh, outline, roofY, topY, SLOT.wall, SLOT.roof);
    }
    elements.decks += 1;
  };

  if (classification.roofForm === 'ridged') {
    let plannedStacks = 0;
    for (const unit of units) {
      const bays = unit.role === 'ridge' ? roofBays(unit, tanPitch) : [];
      if (!bays.length) {
        pushDeck(unit);
        continue;
      }
      const halfLength = unit.lengthM / 2;
      const overhang = BIG_BOX.eaveOverhangM;
      for (const bay of bays) {
        // Rule 4 applied to the ridge itself. On the shipped data no row reaches this clamp — the
        // tallest ridge is Streamer House's 4.18 m against a 4.27 m budget — but a future taller
        // pitch on a short building must not be allowed to eat the wall it stands on.
        const riseM = Math.min(bay.riseM, budgetM);
        const ridgeY = roofY + riseM;
        const effTanPitch = bay.baySpanM > 1e-6 ? (2 * riseM) / bay.baySpanM : tanPitch;
        elements.ridgeBays += 1;
        const eaveLo = bay.bLo - (bay.overhangLo ? overhang : 0);
        const eaveHi = bay.bHi + (bay.overhangHi ? overhang : 0);
        const aLo = -halfLength - overhang;
        const aHi = halfLength + overhang;

        // Two sloping planes. Wound counter-clockwise in (a, b), hence up-facing in world.
        for (const [from, to, fromY, toY] of [
          [eaveLo, bay.bMid, roofY, ridgeY],
          [bay.bMid, eaveHi, ridgeY, roofY],
        ]) {
          const p0 = localPoint(unit, aLo, from);
          const p1 = localPoint(unit, aHi, from);
          const p2 = localPoint(unit, aHi, to);
          const p3 = localPoint(unit, aLo, to);
          mesh.quad(
            SLOT.roof,
            mesh.vertex(p0[0], p0[1], fromY),
            mesh.vertex(p1[0], p1[1], fromY),
            mesh.vertex(p2[0], p2[1], toY),
            mesh.vertex(p3[0], p3[1], toY),
          );
        }

        // The gable ends: the triangle of WALL between the eave line and the ridge. At the +a end
        // the outward normal wants b increasing; at the -a end, b decreasing.
        for (const [a, first, second] of [
          [halfLength, bay.bLo, bay.bHi],
          [-halfLength, bay.bHi, bay.bLo],
        ]) {
          const g0 = localPoint(unit, a, first);
          const g1 = localPoint(unit, a, second);
          const apex = localPoint(unit, a, bay.bMid);
          mesh.tri(
            SLOT.wall,
            mesh.vertex(g0[0], g0[1], roofY),
            mesh.vertex(g1[0], g1[1], roofY),
            mesh.vertex(apex[0], apex[1], ridgeY),
          );
        }

        /**
         * A clerestory lantern is a METAL-ROOFED HALL's daylight. The gate is the GEOMETRY — a
         * plate deep enough that its middle is far from a window and a ridge long enough for the
         * run to read — plus the roof material, and nothing else. The first version also required
         * `program === 'industrial'`, which on this data changed no row that `!tiled` had not
         * already decided, while reading as though programme were doing the work.
         *
         * The tiled veto is the load-bearing half: it keeps a factory lantern off Streamer House,
         * a two-storey gabled house the router calls `industrial` on a 4.75 m storey ratio.
         */
        const deepEnough = bay.baySpanM >= BIG_BOX.monitorMinBaySpanM;
        const longEnough = bay.bayLengthM >= BIG_BOX.monitorMinBayLengthM;
        if (!tiled && deepEnough && longEnough) {
          const width = clamp(
            BIG_BOX.monitorMinWidthM,
            bay.baySpanM * BIG_BOX.monitorSpanFraction,
            BIG_BOX.monitorMaxWidthM,
          );
          const halfWidth = width / 2;
          const topY = Math.min(ridgeY + BIG_BOX.monitorHeightM, capY);
          // The box is sunk to where the roof planes have already fallen below its own flanks, so
          // the buried part is hidden by the roof it stands on rather than floating over it.
          const sillY = ridgeY - halfWidth * effTanPitch - 0.3;
          if (topY - ridgeY >= BIG_BOX.monitorMinRiseM && sillY > roofY + 1e-3) {
            for (const run of monitorRuns(bay.bayLengthM)) {
              pushPrism(
                mesh,
                localRect(unit, run.aLo, run.aHi, bay.bMid - halfWidth, bay.bMid + halfWidth),
                sillY, topY, SLOT.glazing, SLOT.roof,
              );
              elements.monitors += 1;
            }
          }
        }

        /**
         * The gable-end louvre. Sized off the rise so it always fits under the apex it hangs from,
         * and skipped outright when the ridge is too shallow to hold one — a louvre taller than its
         * own gable would poke out through both roof planes.
         */
        if (!tiled && riseM >= BIG_BOX.louvreMinRiseM) {
          const width = clamp(
            BIG_BOX.louvreMinWidthM,
            bay.baySpanM * BIG_BOX.louvreWidthFraction,
            BIG_BOX.louvreMaxWidthM,
          );
          const topY = ridgeY - riseM * BIG_BOX.louvreApexClearFraction;
          const height = clamp(
            BIG_BOX.louvreMinHeightM,
            riseM * BIG_BOX.louvreHeightFraction,
            BIG_BOX.louvreMaxHeightM,
          );
          const sillY = topY - height;
          // Inside the gable triangle at the sill, and above the eave line.
          const halfRoom = effTanPitch > 1e-6 ? (ridgeY - sillY) / effTanPitch : 0;
          if (sillY > roofY + 0.05 && halfRoom > width / 2 + 0.2) {
            for (const a of [halfLength, -halfLength]) {
              const sign = a > 0 ? 1 : -1;
              const outer = a + sign * (BIG_BOX.louvreProudM + BIG_BOX.louvreDepthM);
              const inner = a + sign * BIG_BOX.louvreProudM;
              const [aLo2, aHi2] = sign > 0 ? [inner, outer] : [outer, inner];
              pushPrism(
                mesh,
                localRect(unit, aLo2, aHi2, bay.bMid - width / 2, bay.bMid + width / 2),
                sillY, topY, SLOT.glazing, SLOT.glazing,
              );
              elements.louvres += 1;
            }
          }
        }

        /**
         * Dormers — the tiled pitch's answer to a lantern. The box top lands below the ridge by
         * construction (it is measured off the roof surface at its own upslope edge), which is why
         * dormers cost nothing against rule 4's budget.
         */
        if (tiled) {
          const count = clamp(1, Math.floor(bay.bayLengthM / BIG_BOX.dormerPitchM), BIG_BOX.dormerMaxPerSlope);
          const halfDepth = BIG_BOX.dormerDepthM / 2;
          const offset = bay.baySpanM * BIG_BOX.dormerOffsetFraction;
          if (offset - halfDepth > 0.4) {
            for (const side of [1, -1]) {
              const centreB = bay.bMid + side * offset;
              const nearB = bay.bMid + side * (offset - halfDepth);
              const farB = bay.bMid + side * (offset + halfDepth);
              const surfaceNear = ridgeY - Math.abs(nearB - bay.bMid) * effTanPitch;
              const surfaceFar = ridgeY - Math.abs(farB - bay.bMid) * effTanPitch;
              const topY = surfaceNear + BIG_BOX.dormerRiseM;
              const sillY = surfaceFar - BIG_BOX.dormerSillDropM;
              if (sillY < roofY + 0.05 || topY > ridgeY - 1e-3) continue;
              for (let index = 0; index < count; index++) {
                const a = ((index + 0.5) / count - 0.5) * bay.bayLengthM;
                pushPrism(
                  mesh,
                  localRect(
                    unit,
                    a - BIG_BOX.dormerLengthM / 2, a + BIG_BOX.dormerLengthM / 2,
                    centreB - halfDepth, centreB + halfDepth,
                  ),
                  sillY, topY, SLOT.wall, SLOT.roof,
                );
                elements.dormers += 1;
              }
            }
          }
        }
      }

      /**
       * Flues and chimneys. A metal hall's flue rides the ridge of its widest unit; a tiled house's
       * chimney sits on the slope, smaller. Both are clamped to `capY` — the flue was the single
       * worst contributor to the shipped planner's overshoot, 3.4 m of pipe on top of a 3.0 m ridge
       * on an 8.31 m building — and dropped rather than stubbed when the ceiling leaves no room.
       */
      if (unit === largest && unit.widthM >= BIG_BOX.stackMinSpanM && !plannedStacks) {
        const count = clamp(1, Math.floor(num(metrics.areaM2) / BIG_BOX.stackAreaPerUnitM2), BIG_BOX.stackMaxCount);
        const ridgeRise = Math.min(bays[0].riseM, budgetM);
        const size = tiled ? BIG_BOX.chimneySizeM : BIG_BOX.stackSizeM;
        // A tiled chimney stands on the slope a third of the way down; a flue on the ridge.
        const slopeOffset = tiled ? bays[0].baySpanM * 0.18 : 0;
        const footY = roofY + ridgeRise - (tiled ? slopeOffset * ((2 * ridgeRise) / bays[0].baySpanM) : 0.2);
        const height = Math.min(size[2], capY - footY);
        if (height >= BIG_BOX.minStackHeightM) {
          for (let index = 0; index < count; index++) {
            const fraction = BIG_BOX.stackFractions[index % BIG_BOX.stackFractions.length];
            const [x, z] = localPoint(
              unit,
              (fraction - 0.5) * unit.lengthM,
              bays[0].bMid + (index % 2 === 0 ? slopeOffset : -slopeOffset),
            );
            stackRows.push({
              x, z,
              y: footY,
              yawRad: unit.yawRad,
              size: [size[0], size[1], height],
              levelAboveBaseM: footY - baseY,
            });
          }
          plannedStacks = count;
        }
      }

      /** A deck on a ridged plan big enough to walk on gets plant of its own. */
      if (unit.role === 'deck' && unit.areaM2 >= BIG_BOX.deckPlantMinAreaM2 && plantRows.length < 2) {
        const [x, z] = localPoint(unit, 0, 0);
        plantRows.push({
          x, z,
          y: Math.min(roofY + BIG_BOX.deckRiseM, capY),
          yawRad: unit.yawRad,
          size: [...BIG_BOX.plantSizeM],
          levelAboveBaseM: Math.min(roofY + BIG_BOX.deckRiseM, capY) - baseY,
        });
      }
    }

    /**
     * The dock canopy — the one element below the eave and the one element outside the walls.
     * Its side is chosen by probing the ring, so it is hung off a real outside wall rather than an
     * interior partition line where it would be swallowed by the mass.
     */
    if (!tiled && largest.role === 'ridge' && largest.lengthM >= BIG_BOX.canopyMinUnitLengthM && dockSide !== 0) {
      {
        const side = dockSide;
        const dropM = clamp(BIG_BOX.canopyMinDropM, heightM * BIG_BOX.canopyHeightFraction, BIG_BOX.canopyMaxDropM);
        const topY = roofY - dropM;
        const halfRun = (largest.lengthM * BIG_BOX.canopyLengthFraction) / 2;
        const bEdge = side * (largest.widthM / 2);
        const bOut = bEdge + side * BIG_BOX.canopyProjectM;
        const [bLo, bHi] = side > 0 ? [bEdge, bOut] : [bOut, bEdge];
        if (topY - BIG_BOX.canopyThicknessM > baseY + 1.5) {
          pushPrism(
            mesh,
            localRect(largest, -halfRun, halfRun, bLo, bHi),
            topY - BIG_BOX.canopyThicknessM, topY, SLOT.wall, SLOT.roof,
          );
          elements.canopies += 1;
        }
      }
    }

    plan.notes.push(
      `ridged at ${tiled ? BIG_BOX.tiledRoofPitchDeg : BIG_BOX.industrialRoofPitchDeg} degrees `
      + `(${tiled ? 'tiled' : 'metal'} authored roof): ${elements.ridgeBays} bay(s), `
      + `${elements.monitors} lantern(s), ${elements.louvres} gable louvre(s), `
      + `${elements.dormers} dormer(s), ${elements.decks} deck(s), ${elements.canopies} dock canopy(ies), `
      + `${stackRows.length} ${tiled ? 'chimney' : 'flue'}(s)`,
    );
  } else if (classification.roofForm === 'flat-parapet') {
    // The parapet follows the REAL footprint, not the decomposition: a rim is a plan-following
    // element and cutting it at unit boundaries would draw a wall across the middle of a roof.
    const ccw = ringIsCounterClockwise(ring) ? ring : ring.slice().reverse();
    const parapetTopY = Math.min(roofY + BIG_BOX.parapetHeightM, capY);
    elements.parapetSegments = pushRim(
      mesh, ccw, roofY, parapetTopY, BIG_BOX.parapetThicknessM, SLOT.wall, SLOT.trim,
    );
    plan.notes.push(`flat-parapet: ${elements.parapetSegments}-segment parapet rim at ${(parapetTopY - roofY).toFixed(2)} m`);

    // Which END of the largest unit the stair core sits on is a coin flip the centroid hash owns.
    const side = subSeed(seed, 1) & 1 ? 1 : -1;
    if (floors >= 2) {
      const length = clamp(3.5, largest.widthM * 0.28, 7);
      const width = clamp(3, largest.widthM * 0.2, 5);
      const a = side * Math.max(0, largest.lengthM / 2 - BIG_BOX.headhouseInsetM - length / 2);
      const topY = Math.min(roofY + BIG_BOX.headhouseHeightM, capY);
      pushPrism(mesh, localRect(largest, a - length / 2, a + length / 2, -width / 2, width / 2), roofY, topY, SLOT.wall, SLOT.roof);
      elements.headhouses = 1;
      plan.notes.push(`headhouse ${length.toFixed(1)}x${width.toFixed(1)} m at the ${side > 0 ? '+' : '-'} end (floors ${floors})`);

      if (floors >= BIG_BOX.liftOverrunMinFloors) {
        const overrunTopY = Math.min(roofY + BIG_BOX.liftOverrunHeightM, capY);
        const a2 = a - side * (length / 2 + 1.2 + width / 2);
        if (overrunTopY > topY + 0.2 && Math.abs(a2) + width / 2 < largest.lengthM / 2) {
          pushPrism(mesh, localRect(largest, a2 - width / 2, a2 + width / 2, -width / 2, width / 2), roofY, overrunTopY, SLOT.wall, SLOT.roof);
          elements.liftOverruns = 1;
          plan.notes.push(`lift overrun ${width.toFixed(1)} m square at ${(overrunTopY - roofY).toFixed(2)} m (floors ${floors})`);
        }
      }
    }

    /**
     * The screened plant deck. The screen is the rim; the plant grid lives INSIDE it, which is both
     * how a real block is arranged and the reason plant can never be drawn through the headhouse:
     * the screen is placed at the opposite end of the same unit.
     */
    const screenLength = clamp(
      BIG_BOX.plantScreenMinLengthM,
      largest.lengthM * BIG_BOX.plantScreenLengthFraction,
      Math.min(BIG_BOX.plantScreenMaxLengthM, largest.lengthM - 2 * BIG_BOX.plantEdgeInsetM),
    );
    const screenWidth = clamp(
      BIG_BOX.plantScreenMinWidthM,
      largest.widthM * BIG_BOX.plantScreenWidthFraction,
      Math.min(BIG_BOX.plantScreenMaxWidthM, largest.widthM - 2 * BIG_BOX.plantEdgeInsetM),
    );
    const screenA = -side * Math.max(0, Math.min(largest.lengthM * 0.2, largest.lengthM / 2 - screenLength / 2 - 0.5));
    const screenTopY = Math.min(roofY + BIG_BOX.plantScreenHeightM, capY);
    let screenRing = null;
    if (screenLength > 2 && screenWidth > 2 && screenTopY > roofY + 0.1) {
      screenRing = localRect(
        largest,
        screenA - screenLength / 2, screenA + screenLength / 2,
        -screenWidth / 2, screenWidth / 2,
      );
      pushRim(mesh, screenRing, roofY, screenTopY, BIG_BOX.plantScreenThicknessM, SLOT.wall, SLOT.trim);
      elements.plantScreens = 1;
    }

    // Walk-on plant, on a grid inside the screen. The first block is a chiller, not another vent:
    // one 4.0 x 3.0 x 2.6 m object on a roof reads at 1 m/pixel where six 1.2 m ones do not.
    const plantCount = clamp(2, Math.round(num(metrics.areaM2) / BIG_BOX.plantAreaPerUnitM2), BIG_BOX.plantMaxCount);
    const columns = Math.max(1, Math.ceil(Math.sqrt(plantCount)));
    const rows = Math.max(1, Math.ceil(plantCount / columns));
    const margin = BIG_BOX.plantScreenMarginM;
    const spanA = Math.max(0, (screenRing ? screenLength : largest.lengthM - 2 * BIG_BOX.plantEdgeInsetM) - 2 * margin);
    const spanB = Math.max(0, (screenRing ? screenWidth : largest.widthM - 2 * BIG_BOX.plantEdgeInsetM) - 2 * margin);
    const gridA = screenRing ? screenA : 0;
    for (let index = 0; index < plantCount; index++) {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const fa = columns > 1 ? column / (columns - 1) - 0.5 : 0;
      const fb = rows > 1 ? row / (rows - 1) - 0.5 : 0;
      const a = gridA + fa * spanA + subUnit(seed, 10 + index) * BIG_BOX.plantJitterM;
      const b = fb * spanB + subUnit(seed, 40 + index) * BIG_BOX.plantJitterM;
      const [x, z] = localPoint(largest, a, b);
      const size = index === 0 ? BIG_BOX.chillerSizeM : BIG_BOX.plantSizeM;
      plantRows.push({
        x, z, y: roofY,
        yawRad: largest.yawRad,
        size: [size[0], size[1], Math.min(size[2], budgetM)],
        levelAboveBaseM: heightM,
      });
    }

    const area = num(metrics.areaM2);
    const hatchCount = BIG_BOX.hatchAreaThresholdsM2.filter((threshold) => area >= threshold).length;
    const hatchInset = BIG_BOX.plantEdgeInsetM;
    for (let index = 0; index < hatchCount; index++) {
      const a = (index === 0 ? -0.32 : index === 1 ? 0.3 : 0.06) * Math.max(0, largest.lengthM - 2 * hatchInset);
      const b = (index === 1 ? -0.28 : 0.24) * Math.max(0, largest.widthM - 2 * hatchInset);
      const [x, z] = localPoint(largest, a, b);
      hatchRows.push({
        x, z, y: roofY,
        yawRad: largest.yawRad,
        size: [BIG_BOX.hatchSizeM[0], BIG_BOX.hatchSizeM[1], Math.min(BIG_BOX.hatchSizeM[2], budgetM)],
        levelAboveBaseM: heightM,
      });
    }
    plan.notes.push(
      `${plantCount} plant block(s) on a ${columns}x${rows} grid inside ${elements.plantScreens} screen(s), `
      + `${hatchCount} hatch(es)`,
    );
  } else {
    plan.notes.push(`roofForm "${classification.roofForm}" is not a big-box branch — mass left as extruded`);
  }

  plan.mesh = mesh.build();
  for (const [familyId, rows] of [
    ['roof-vent', plantRows],
    ['roof-hatch', hatchRows],
    ['roof-stack', stackRows],
    ['door-module', doorRows],
  ]) {
    const declaration = familyDeclaration(familyId, buildingIndex, rows);
    if (declaration) plan.instances.push(declaration);
  }
  plan.triangles = mesh.triangleCount();
  /** The floor this row had to clear, carried so a report does not have to re-derive it. */
  plan.minDetailTriangles = minDetailTrianglesFor(metrics.areaM2);
  plan.aboveEaveBudgetM = budgetM;
  return plan;
}

/** Signed-area sign of a ring in game (x, z). CCW is what every winding rule above assumes. */
export function ringIsCounterClockwise(ring) {
  let twice = 0;
  for (let index = 0; index < ring.length; index++) {
    const [ax, az] = ring[index];
    const [bx, bz] = ring[(index + 1) % ring.length];
    twice += ax * bz - bx * az;
  }
  return twice > 0;
}
