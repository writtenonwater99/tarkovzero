/**
 * Fuel tanks and cooling towers — the detail planner for the `cylinder` archetype.
 *
 * Six buildings route here (`classifyAll(...).byArchetype.cylinder` = rows 12, 13, 14, 15, 16, 19).
 * Today every one of them is drawn as a bare extruded polygon: three 20 m x 6 m drums and three
 * 30 m towers, all with a flat lid and nothing else. That is the founder's "random boxes and
 * cylinders" in its purest form — a cylinder with no top, no rim, no foot and no plant is not a
 * tank, it is a primitive.
 *
 * This module is pure and GPU-free for the same reason `src/bridge-structure.js` and
 * `src/buildings.js` are: every number it produces has to be assertable against the real shipped
 * `public/data/customs-3d.json` in Node, without a renderer and without a real GPU, because
 * `gpuFrameMs` is null under SwiftShader and no frame-time claim in this repo is backed by anything.
 *
 * ---------------------------------------------------------------------------------------------
 * THE ONE CONSTRAINT THAT SHAPED EVERY DECISION HERE: DETAIL IS ADDITIVE.
 *
 * `addBuildings()` in src/map3d-three.js already extrudes the footprint to `height` and the
 * contract merges a planner's mesh INTO that mesh (`contract.js` §4: "merged into the owner
 * building's mesh"). There is no subtraction, no CSG and no "suppress the base mass" flag. So:
 *
 *   **no vertex this module emits may sit meaningfully inside the shell prism.**
 *
 * It may stand outside the footprint, or above the top cap, and nothing else. `SHELL_TUCK_M` is the
 * only slack — 0.10 m, enough for an annulus to tuck under the wall line so no hairline opens, far
 * too little to hide a wrong radius. `cylinderVertexAudit()` measures it and the test asserts it.
 *
 * The consequence worth stating out loud, because the build brief asked for the opposite: **a
 * cooling tower cannot be given a hyperbolic waist.** A waist is a radius SMALLER than the shell's
 * own, and the shell is already solid there. What this module does instead is produce the waisted
 * READ by contrast — a battered flare at the foot and an overhanging cornice + rim at the head, so
 * the untouched straight shaft between them is the narrowest thing in the silhouette. Same
 * gestalt, no subtraction, no vertex inside the prism. If a later pass gains the ability to replace
 * a building's base mass, `TOWER` is the block to revisit.
 *
 * ---------------------------------------------------------------------------------------------
 * 2026-09-02 — THAT PASS ARRIVED, AND THE PARAGRAPH ABOVE NO LONGER GOVERNS EVERY ROW.
 *
 * `src/map3d-three.js`'s `addBuildings()` honours `plan.replacesMass`: a plan that sets it gets NO
 * extrusion and no outline at all, and `assemble.js`'s `heightFitScale()` then measures containment
 * against the plan's own geometry instead of against a mass. `open-structure` and `lattice-tower`
 * were already using it for ten buildings.
 *
 * The defect that forced the change is the founder's literal complaint. `public/data/customs-3d.json`
 * rows **14 and 19** are `kind: "cooling_tower"`, `height: 30`, and their `poly` is a FOUR-VERTEX
 * RECTANGLE (13.86 x 10.00 m and 23.91 x 16.19 m, OBB fill 0.998 / 0.997). They route here
 * correctly, but with the mass left in place the renderer extruded those rectangles 30 m and this
 * module's 48 detail triangles were a battered foot and a cornice built ON A QUAD RING. The notes
 * said "radial"; the ring had four sides. They are the two tallest non-pylon objects on Customs,
 * they are named "Water Pump Cooling Tower", and they were boxes.
 *
 * So a tower whose footprint is NOT drawn round now REPLACES ITS MASS with an elliptic hyperboloid
 * of revolution, and the additive constraint stops applying to it — there is no shell prism to stay
 * out of, because this module draws the shell. Everything else in this file is unchanged: the three
 * tanks and the ONE cooling tower whose footprint really is a 16-gon (row 13) take the additive path
 * above, byte for byte.
 *
 * Two rules keep the replacement honest:
 *
 *  - **The section is derived from the rectangle's own minimum-area OBB and nothing else.** The
 *    largest smooth closed curve that fits inside a rectangle is its inscribed ellipse, so the
 *    section is that ellipse (inset `shellInsetM` so the 0.2-0.3% by which the polygon falls short
 *    of its own OBB cannot push a vertex outside the authored footprint), sampled at
 *    `shellSegments` azimuths. Public data in, public data out. A circle of radius `min(L,W)/2`
 *    would also be round and would throw away 47% of row 19's footprint; a circle of the equal
 *    AREA radius would stand 3.85 m outside the short side. The ellipse touches the rectangle at
 *    its four edge midpoints and is inside it everywhere else, so the object keeps both of the
 *    dimensions the data actually states.
 *  - **The tower may not grow.** The shell is built from `seat.baseY` to EXACTLY
 *    `seat.baseY + heightM`; the open rim is the top of the shell rather than an upstand above it,
 *    and the obstruction beacon hangs its 3.2 m FROM that plane rather than on top of it. So
 *    `heightFitScale()` finds nothing to squash and returns exactly 1 — which the test asserts,
 *    because a tower that overshot would be silently shrunk by the fit and nobody would see it.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THE SIX BUILDINGS ACTUALLY ARE (measured from the shipped JSON, nothing else)
 *
 *   row  place            kind           poly   area m2   D_eq   height   slenderness = h / D_eq
 *    12  ZB-1011          tank           16-gon   314.2   20.0        6   0.300
 *    15  (unnamed)        tank           16-gon   313.7   20.0        6   0.300
 *    16  Streamer House   tank           16-gon   312.1   19.9        6   0.301
 *    19  Water Pump       cooling_tower  QUAD     386.0   22.2       30   1.354
 *    13  Water Pump       cooling_tower  16-gon   313.7   20.0       30   1.501
 *    14  Water Pump       cooling_tower  QUAD     138.3   13.3       30   2.261
 *
 * Two facts fall out of that table and both are load-bearing:
 *
 *  1. **Slenderness splits the archetype cleanly, and `kind` would too — but slenderness is the
 *     one that survives a new row.** The measured band 0.301 -> 1.354 is empty, and
 *     `towerMinSlenderness` sits at 0.9 with 0.6 of clearance below and 0.45 above. Routing on
 *     `kind` alone would put a 30 m drum labelled `tank` under a dome and a 6 m drum labelled
 *     `cooling_tower` under an open rim; routing on the proportion cannot.
 *  2. **Only ONE of the three cooling towers has a round FOOTPRINT.** Rows 14 and 19 are four-vertex
 *     rectangles (OBB fill 0.998 and 0.997), row 13 is a 16-gon. The router sends all three here
 *     because `kind` says `cooling_tower`, and it is right to. `metrics.round` still decides which
 *     path a tower takes — but the two paths are no longer "revolution vs prism". A round footprint
 *     is DRESSED (cornice, open rim, risers, beacon) on top of the extruded 16-gon the renderer
 *     already draws; a rectangular one has its mass REPLACED by an elliptic hyperboloid inscribed
 *     in its own OBB. Both end up round in section; only the second one had to be, because the
 *     alternative was the box that is on screen today.
 *
 *     The tanks are all three 16-gons (fill 0.794 = pi/4 to three places), so "the cylinders are
 *     boxes" was never true of the fuel tanks — measured, not assumed. Only rows 14 and 19 were.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT VARIES, AND WHAT DRIVES IT (variation is the deliverable — 6 identical drums is the bug)
 *
 *   footprint `round`     a dressed crown (dome / cone / open rim) on an extruded footprint, or a
 *                         REPLACED mass: an elliptic hyperboloid shell
 *   slenderness           TANK assembly (pad, girder, crown, rail, vents, ladder)
 *                         vs TOWER assembly (flare, cornice, rim, cowls, beacon, risers)
 *   footprint area        vent count (area / 200 m2)
 *   height                riser count (h / 14 m) and whether a beacon mast exists (h >= 25 m)
 *   OBB length/width      the replaced shell's whole section: semi-axes, aspect, every ring above
 *   `roof` colour         the whole top assembly is emitted on material slot `roof`, so row 16's
 *                         authored [126, 76, 52] paints its girder and dome brown while rows 12
 *                         and 15, which carry no colour at all, take the derived grey. That field
 *                         is thrown away by the renderer today (`grep '\.roof' map3d-three.js` = 0
 *                         hits) and costs nothing to use.
 *   `classification.seed` dome vs cone, crown-rise jitter (+/-8%), and the ladder / vent / beacon
 *                         stations. Never `Math.random`, never an array index, never a clock.
 *
 * Worked, for the three tanks, which are otherwise near-identical rows (same kind, same height,
 * same floors, areas within 0.7%):
 *
 *   row 12  seed 4173800020  bit0=0 -> CONE crown,  ladder at vertex 2,  vents from vertex 7
 *   row 15  seed 3039207739  bit0=1 -> DOME crown,  ladder at vertex 1,  vents from vertex 6
 *   row 16  seed  691951573  bit0=1 -> DOME crown + authored brown roof, ladder at vertex 7
 *
 * ---------------------------------------------------------------------------------------------
 * BUDGET
 *
 * The mesh uses ONLY `wall` (0) and `roof` (1) — the two slots the building mesh already pays for
 * — so this archetype adds **zero per-building draw calls**. Everything metal (vent stacks,
 * ladders, risers, beacons, rail posts) is declared as an instanced family instead, which
 * is one map-wide `InstancedMesh` each and is shared with whatever the five sibling planners
 * declare. Worst case if no sibling declares any of them: 4 draw calls, 0.27% of a 1,461-call
 * frame. `planDrawCallDelta()` in contract.js is the accountant; this module does not estimate.
 *
 * SILHOUETTE, NOT SURFACE (build decision 4). Metres-per-pixel is 2^-zoom and the default 3D zoom
 * is 0, so at the default view **one pixel is one metre** and a 6 m tank is six pixels tall. Every
 * element below is sized against that: the girder is 0.9 m deep and stands 0.35 m proud, the crown
 * rises 1.2-1.5 m, the flare widens a tower by 1.2 m radially and the cornice overhangs it by 1.1.
 * There is no facade relief in this file at all — no ribs, no pilasters, no plate seams, no ladder
 * cage. Those are sub-pixel at the one view that matters and they are exactly the budget the brief
 * says not to spend.
 */
import { gameToWorld } from '../three-world.js';
import { MATERIAL_SLOT_INDEX, validatePlannerContext } from './contract.js';

// --------------------------------------------------------------------------------------------- //
// 1. The frozen dimension table. Every entry names what decided it.
// --------------------------------------------------------------------------------------------- //

export const CYLINDER_DETAIL = Object.freeze({
  /**
   * height / equivalent diameter. Below this the object is a storage vessel, above it a tower.
   * Measured over the six routed rows: 0.300, 0.300, 0.301 | 1.354, 1.501, 2.261. The band
   * (0.301, 1.354) is empty and this threshold sits in the middle of it.
   */
  towerMinSlenderness: 0.9,
  /**
   * How far a vertex may lie INSIDE the shell prism. An annulus tucks this far under the wall line
   * so no hairline can open at the seam; anything deeper would be geometry the extrusion hides,
   * which is the additive-detail equivalent of a metric that cannot fail.
   */
  shellTuckM: 0.1,
  /** Ground-borne elements are founded IN the earth, never parked on it (`bridge-structure.js`). */
  footEmbedM: 0.35,
  /** A prism thinner than this is a depth fight, not a detail. */
  minPrismHeightM: 0.15,

  // ----- TANK: a vertical storage vessel ------------------------------------------------------ //
  /** The ringwall foundation a tank stands on, stood proud of the shell. 0.45 m = ~4.5% of R. */
  padOutM: 0.45,
  /** ...and how far it rises above the wall base. Half a pixel at the default view, a kerb up close. */
  padTopM: 0.3,
  /**
   * The top wind girder / walkway. Its DEPTH is what separates roof from shell in the silhouette,
   * so it is a fixed 0.9 m rather than a ratio: on a 6 m tank a proportional girder would be 0.2 m
   * and invisible, on a 30 m one it would be a balcony.
   */
  curbBandM: 0.9,
  /** How far the girder stands above the shell top — the lip the roof springs from behind. */
  curbLipM: 0.35,
  /** Girder overhang: 3.5% of the equivalent radius, clamped so both ends of the range read. */
  curbOutFrac: 0.035,
  curbOutMinM: 0.3,
  curbOutMaxM: 0.7,
  /**
   * Fixed-roof rises, as a fraction of the RADIUS (not the height — a tank roof is a function of
   * its span). A dome at R/7 is D/14, mid-range for a self-supporting dome; a cone at R/8 is a
   * 1:8 slope, inside the 1:16-to-1:6 band a cone roof is built in.
   */
  domeRiseFrac: 1 / 7,
  coneRiseFrac: 1 / 8,
  /** Rings between springing and apex on a dome. 3 is where the profile stops reading as a cone. */
  domeRings: 3,
  /**
   * The ENTIRE top assembly — girder lip plus crown, or rim — may add at most this fraction of the
   * building's own height above the shell top. Heights are a standing decision (handoff §4.4): a
   * roof is not a height change, `building.height` is never read back or written and
   * `visibleWallHeight()` is untouched, but a crown that doubled the object would be re-opening
   * that decision through the back door. Measured against the shipped rows: the tallest tank lands
   * at 30.2% (0.35 m lip + 1.46 m dome on a 6 m shell — what a real 20 m fixed-roof tank looks
   * like) and the three 30 m towers at 4.7%. Nothing is clamped; the clamp is the backstop.
   */
  crownMaxRiseFracOfHeight: 0.32,
  /** Deterministic +/-8% on the crown rise, so two domes are not the same dome. */
  crownRiseJitter: 0.16,
  /** Roof handrail. Posts only — see `railPostM`. */
  railHeightM: 1.05,
  /**
   * 0.09 m posts are 1/11th of a pixel at the default view, which is why the RAIL BAR between them
   * is deliberately not built: a continuous bar would need a third material group on every tank —
   * a real draw call — to buy a line nobody can resolve. The posts ride a shared InstancedMesh and
   * cost nothing, and at the zoom where a handrail reads at all they are what reads.
   */
  railPostM: 0.09,
  railPostMax: 16,
  /** One vent per 200 m2 of roof: the 314 m2 tanks get 2. Capped at the family's own headroom. */
  ventAreaPerM2: 200,
  ventMax: 3,
  /** Vents stand on the crown at 42% of the radius, where a dome still has a near-flat seat. */
  ventBaseScale: 0.42,
  ventHeightM: 2,
  ventWidthM: 0.55,
  /** One access ladder, from the pad to the girder, on a seed-chosen footprint vertex. */
  ladderWidthM: 0.55,
  ladderDepthM: 0.14,

  // ----- TOWER: a cooling tower --------------------------------------------------------------- //
  /** The battered foot occupies the bottom 22% of the shaft. */
  flareTopFrac: 0.22,
  /** ...and widens it by 14% of the equivalent radius, capped at 1.2 m (2.4 m across = 2 px). */
  flareOutFrac: 0.14,
  flareOutMaxM: 1.2,
  /** The head band whose soffit throws the shadow line that reads as an overhang. */
  corniceBandM: 1.6,
  corniceOutFrac: 0.12,
  corniceOutMaxM: 1.1,
  /** The upstand above the cap of a ROUND tower: the lip a natural-draught shell finishes with. */
  rimHeightM: 1.4,
  /**
   * A ROUND tower's rim flares outward on the way up — the lip a natural-draught shell finishes
   * with, and the top half of the "wide foot, narrow waist, flaring head" read this module builds
   * instead of a waist it is not allowed to cut on the one tower whose mass it may not replace.
   */
  rimFlareM: 0.45,
  /** An obstruction light needs a tower to sit on. All three Customs towers are 30 m. */
  beaconMinHeightM: 25,
  beaconHeightM: 3.2,
  beaconWidthM: 0.45,
  /** One riser per 14 m of shaft: a 30 m tower gets 2. */
  riserPerM: 14,
  riserMax: 3,
  riserWidthM: 0.42,
  riserDepthM: 0.42,

  // ----- THE REPLACED SHELL: a tower whose footprint is not drawn round ----------------------- //
  /**
   * Azimuths in the drawn section. 24 puts a facet every 15 degrees; on row 19's 23.9 m section
   * that is a 2.9 m chord, i.e. 2.9 px at the default view where one pixel is one metre. The four
   * cylinders that already read correctly are 16-gons at 4.4 px per facet, so this is FINER than
   * the geometry the founder has already accepted, and it is the cheapest number that is.
   */
  shellSegments: 24,
  /** Vertical bands. 9 puts a ring every 3.33 m on a 30 m tower; the profile's whole sag is 38%. */
  shellRings: 9,
  /**
   * How far the inscribed ellipse is pulled in from its own OBB, in metres.
   *
   * The ellipse touches the OBB at four edge midpoints. The two footprints fill 99.81% and 99.72%
   * of their OBB rather than 100%, so a tangent point could otherwise sit a few centimetres outside
   * the authored polygon. 0.15 m is an order of magnitude more than that shortfall and a twentieth
   * of one facet.
   */
  shellInsetM: 0.15,
  /**
   * The hyperbola, in two numbers. Everything else about the profile is derived from them:
   *
   *   r(t) = rThroat * sqrt(1 + ((t - tThroat) / c)^2),   c = tThroat / sqrt(1/rThroat^2 - 1)
   *
   * which forces r(0) = 1 EXACTLY — the shell springs from the full section, so the base ring is
   * the footprint-derived ellipse itself and nothing is fudged at the ground. The rim radius is
   * then a consequence, not a third free parameter: r(1) = 0.658. Base 1.00, throat 0.62 at 78% of
   * the height, rim 0.66 is a textbook natural-draught silhouette.
   */
  throatRadiusFrac: 0.62,
  throatHeightFrac: 0.78,
  /** Shell wall thickness at the rim, and therefore everywhere: what makes the top read as OPEN. */
  shellThicknessM: 0.5,
  /**
   * Where the interior stops and the fill deck closes it, as a fraction of the height. Below this
   * the inside of the shell is never visible from any orbit angle the camera can reach, and 24
   * more bands of inward-facing wall would be triangles nobody can see.
   */
  basinHeightFrac: 4 / 9,
  /**
   * The batter at the foot is the hyperbola's OWN continuation one metre below the base plane,
   * not a separate flare constant: r(-1/h) is 1.026 on a 30 m tower, so the foot stands 2.6% proud
   * and no new number enters the file. Clamped so a degenerate height cannot run away with it.
   */
  footProfileDropM: 1,
  footProfileDropMaxFrac: 0.1,
});

/**
 * The instance prototype convention, stated here because it is the one thing six parallel planners
 * can silently disagree about: the renderer keeps ONE prototype per family and every planner's
 * instances ride it.
 *
 * A unit box, CENTRED in x and y, spanning z in [0, 1]. So an instance `offset` is the FOOT of the
 * object, `scales` are its full width, depth and height in metres, and `levelAboveBaseM` is that
 * foot's height above its owner's `seat.baseY`. A planner that centres z instead would half-bury
 * every instance it shares a family with.
 */
export const UNIT_PROTOTYPE_CONVENTION = Object.freeze({
  shape: 'box',
  xy: 'centred on the origin, unit width',
  z: '[0, 1] — the origin is the FOOT, not the centre',
  offsetMeans: 'world-space position of the foot',
  scalesMean: 'full extent in metres, per axis',
});

const SLOT = MATERIAL_SLOT_INDEX;

const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const clamp = (low, value, high) => Math.min(high, Math.max(low, value));

// --------------------------------------------------------------------------------------------- //
// 2. Footprint work. Shared by the spec and the mesh so the two can never disagree about a radius.
// --------------------------------------------------------------------------------------------- //

/**
 * Finite [x, z] pairs, duplicate closing vertex dropped, wound COUNTER-CLOCKWISE in game (x, z).
 *
 * Winding is not cosmetic here. Normals are omitted from the plan (the contract lets the renderer
 * compute them) so the only thing deciding which way a face points is the index order, and all six
 * shipped footprints are wound CLOCKWISE. Every ring in this module is normalised once, here, and
 * every triangle emitter below assumes CCW.
 */
export function cleanCcwRing(poly) {
  const ring = (Array.isArray(poly) ? poly : [])
    .filter((point) => Array.isArray(point)
      && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])))
    .map((point) => [Number(point[0]), Number(point[1])]);
  while (ring.length >= 2) {
    const [ax, az] = ring[0];
    const [bx, bz] = ring[ring.length - 1];
    if (Math.hypot(ax - bx, az - bz) > 1e-6) break;
    ring.pop();
  }
  if (ring.length < 3) return [];
  let twice = 0;
  for (let index = 0; index < ring.length; index++) {
    const [ax, az] = ring[index];
    const [bx, bz] = ring[(index + 1) % ring.length];
    twice += ax * bz - bx * az;
  }
  return twice < 0 ? ring.slice().reverse() : ring;
}

/**
 * Move every vertex `deltaM` along its own radial from `centre`.
 *
 * A constant radial offset rather than a scale factor, because a scale factor on a 23.9 x 16.2 m
 * rectangle grows the long side half again as much as the short one and the cornice stops looking
 * like a cornice. Negative values move inward — that is how an annulus tucks `shellTuckM` under
 * the wall line, and it is the ONLY inward motion in this file.
 */
export function offsetRing(ring, centre, deltaM) {
  const [cx, cz] = centre;
  return ring.map(([x, z]) => {
    const dx = x - cx;
    const dz = z - cz;
    const radius = Math.hypot(dx, dz);
    if (!(radius > 1e-9)) return [x, z];
    const scale = Math.max(0.05, radius + deltaM) / radius;
    return [cx + dx * scale, cz + dz * scale];
  });
}

/**
 * The ellipse inscribed in an oriented bounding box, sampled at `segments` azimuths, CCW in game
 * (x, z) — the same winding `cleanCcwRing` normalises every other ring in this file to.
 *
 * `yawRad` is `footprintMetrics().yawRad`, the azimuth of the OBB's LONG axis, so `semiLengthM`
 * runs along it and `semiWidthM` across. Nothing here reads the polygon: the OBB is the only input,
 * which is what makes the result a function of public data and of the minimum-area box alone.
 */
export function ellipseSection(centre, yawRad, semiLengthM, semiWidthM, segments) {
  const [cx, cz] = centre;
  const count = Math.max(3, Math.round(segments));
  const cos = Math.cos(yawRad);
  const sin = Math.sin(yawRad);
  const out = [];
  for (let k = 0; k < count; k++) {
    const theta = (2 * Math.PI * k) / count;
    const along = Math.max(0.05, semiLengthM) * Math.cos(theta);
    const across = Math.max(0.05, semiWidthM) * Math.sin(theta);
    out.push([cx + along * cos - across * sin, cz + along * sin + across * cos]);
  }
  return out;
}

/**
 * The hyperboloid's radius at height fraction `t`, in units of the SPRINGING radius.
 *
 * `t` may be negative — that is how the battered foot is built, by continuing the same curve below
 * the base plane rather than inventing a flare. `r(0) === 1` identically, by the derivation of `c`.
 */
export function hyperboloidRadiusFrac(throatRadiusFrac, throatHeightFrac, t) {
  const rt = clamp(0.05, throatRadiusFrac, 0.98);
  const yt = clamp(0.05, throatHeightFrac, 0.98);
  const c = yt / Math.sqrt(1 / (rt * rt) - 1);
  return rt * Math.sqrt(1 + ((t - yt) / c) ** 2);
}

/** Radially scale a ring about `centre` — used only for the crown, which IS a scaled profile. */
function scaleRing(ring, centre, factor) {
  const [cx, cz] = centre;
  return ring.map(([x, z]) => [cx + (x - cx) * factor, cz + (z - cz) * factor]);
}

/**
 * `count` points spread at EQUAL ARC LENGTH around a ring, with the outward radial azimuth at each.
 *
 * Not "one per vertex": a 16-gon's vertices are already evenly spaced but a 23.9 x 16.2 m rectangle
 * has four, and four posts on a rim is a corner marker, not a handrail. Walking the perimeter
 * gives the same even fringe on both.
 */
function perimeterStations(ring, centre, count) {
  const n = ring.length;
  if (n < 3 || count <= 0) return [];
  const spans = ring.map(([x, z], i) => {
    const [bx, bz] = ring[(i + 1) % n];
    return Math.hypot(bx - x, bz - z);
  });
  const total = spans.reduce((sum, span) => sum + span, 0);
  if (!(total > 1e-9)) return [];
  const out = [];
  let edge = 0;
  let consumed = 0;
  for (let k = 0; k < count; k++) {
    const target = (total * k) / count;
    while (edge < n - 1 && consumed + spans[edge] <= target) {
      consumed += spans[edge];
      edge++;
    }
    const t = spans[edge] > 1e-9 ? (target - consumed) / spans[edge] : 0;
    const [ax, az] = ring[edge];
    const [bx, bz] = ring[(edge + 1) % n];
    const x = ax + (bx - ax) * t;
    const z = az + (bz - az) * t;
    out.push({ x, z, yaw: worldYawOf(x - centre[0], z - centre[1]) });
  }
  return out;
}

/**
 * The world-frame azimuth of a game-frame direction.
 *
 * `gameToWorld` negates BOTH horizontal axes, so a game heading is a world heading turned by pi.
 * Every instance prototype in this module is a box, symmetric under exactly that rotation, so a
 * slip here would be unobservable — which is precisely why it is written down rather than guessed.
 */
function worldYawOf(dx, dz) {
  return Math.atan2(dz, dx) + Math.PI;
}

// --------------------------------------------------------------------------------------------- //
// 3. The spec — every dimension resolved from public data, before a single vertex exists.
// --------------------------------------------------------------------------------------------- //

/**
 * Bits from the deterministic centroid hash. Each field takes a DISJOINT slice, so changing one
 * decision cannot silently shift another.
 */
const bit = (seed, index) => (seed >>> index) & 1;
const byteAt = (seed, index) => (seed >>> index) & 0xff;

/**
 * The spherical-cap radius profile of a dome, in units of the springing radius.
 *
 * A cap of unit base radius and rise `f` sits on a sphere of radius rho = (1 + f^2) / 2f centred
 * `rho - f` below the springing, so r(y) = sqrt(rho^2 - (y - f + rho)^2) for y in [0, f]. r(0) = 1
 * and r(f) = 0 exactly, which is what keeps the crown welded to the girder at one end and closed
 * at the other.
 */
function domeRadiusAt(riseFrac, y) {
  const rho = (1 + riseFrac * riseFrac) / (2 * riseFrac);
  const inner = rho * rho - (y - riseFrac + rho) ** 2;
  return inner > 0 ? Math.sqrt(inner) : 0;
}

/** Height above the springing at which the crown has narrowed to `scale` of its base radius. */
function crownHeightAtScale(spec, scale) {
  const f = spec.crownRiseM / Math.max(1e-6, spec.radiusM);
  if (spec.crownForm === 'cone') return spec.crownRiseM * (1 - clamp(0, scale, 1));
  const rho = (1 + f * f) / (2 * f);
  const inner = rho * rho - scale * scale;
  if (!(inner > 0)) return spec.crownRiseM;
  return clamp(0, (f - rho + Math.sqrt(inner)) * spec.radiusM, spec.crownRiseM);
}

/**
 * Everything about one cylinder that does not depend on the terrain: which family it is, which
 * crown it gets, how many of each fitting, and where each fitting stands.
 *
 * Pure and seat-free ON PURPOSE — the form of a building may not change when the relief slider
 * moves, and this function is where the test proves it, by running it once and comparing against
 * the plan built at relief 1 and at relief 3.
 */
export function cylinderSpec(building, classification) {
  const C = CYLINDER_DETAIL;
  const metrics = classification?.metrics ?? {};
  const ring = cleanCcwRing(building?.poly);
  const centre = [num(metrics.centroidX), num(metrics.centroidZ)];
  const areaM2 = num(metrics.areaM2);
  const heightM = num(classification?.heightM, num(building?.height));
  const radiusM = Math.sqrt(Math.max(1e-6, areaM2) / Math.PI);
  const diameterM = radiusM * 2;
  const slenderness = diameterM > 1e-6 ? heightM / diameterM : 0;
  const family = slenderness >= C.towerMinSlenderness ? 'tower' : 'tank';
  const round = metrics.round === true;
  const seed = (classification?.seed ?? 0) >>> 0;
  const vertexCount = ring.length;

  /**
   * A tower whose footprint is not drawn round replaces its mass rather than dressing it.
   *
   * This is the ONE predicate that separates the two tower paths, and it is deliberately the same
   * `metrics.round` the module has always keyed on — not `kind`, not the archetype, not a place
   * name. A future row that ships a genuinely round cooling tower keeps the additive path; a future
   * row that ships another rectangle gets a shell, without anything here being edited.
   */
  const massReplaced = family === 'tower' && !round;

  // Crown form. A tank gets a fixed roof — dome or cone on the seed's low bit, both real
  // self-supporting roofs. A round tower gets an open top dressed onto its extruded 16-gon; a
  // rectangular one becomes a hyperboloid shell in its own right.
  let crownForm;
  if (family === 'tank') crownForm = !round ? 'cone' : (bit(seed, 0) ? 'dome' : 'cone');
  else crownForm = round ? 'open-rim' : 'hyperboloid-shell';

  const riseFrac = crownForm === 'dome' ? C.domeRiseFrac : C.coneRiseFrac;
  const jitter = 1 + ((byteAt(seed, 3) & 0x0f) / 15 - 0.5) * C.crownRiseJitter;
  const crownRiseM = family === 'tank'
    ? Math.min(radiusM * riseFrac * jitter, heightM * C.crownMaxRiseFracOfHeight - C.curbLipM)
    : 0;

  const curbOutM = clamp(C.curbOutMinM, radiusM * C.curbOutFrac, C.curbOutMaxM);
  const flareOutM = Math.min(radiusM * C.flareOutFrac, C.flareOutMaxM);
  const corniceOutM = Math.min(radiusM * C.corniceOutFrac, C.corniceOutMaxM);

  const ventCount = family === 'tank'
    ? clamp(1, Math.round(areaM2 / C.ventAreaPerM2), C.ventMax)
    : 0;
  /**
   * Risers are vertical boxes hugging a vertical wall. On the replaced shell the wall is not
   * vertical — a riser at the base radius stands 2 m proud of the shell by a quarter of the way up
   * on row 19 — so they are dropped there rather than made to lie.
   */
  const riserCount = family === 'tower' && !massReplaced
    ? clamp(1, Math.floor(heightM / C.riserPerM), C.riserMax)
    : 0;
  const beaconCount = family === 'tower' && heightM >= C.beaconMinHeightM ? 1 : 0;
  /**
   * A tank roof is walked; a cooling-tower rim is not, and a handrail on one would be a claim about
   * access that nothing supports. NO tower gets rail posts any more, and that is not a preference:
   * a tower is either round — a natural-draught shell rim, which nobody walks — or not round, in
   * which case its mass is replaced by a natural-draught shell and there is no deck at all. The
   * induced-draught FAN DECK this archetype used to build on rows 14 and 19, with its cowls
   * (`roof-vent`) and its kerb rail, is gone with them: the mutation harness proved the branch was
   * unreachable for every possible input the moment the shell replaced the box, and an unreachable
   * rule is the same defect as an assertion that cannot fail.
   */
  const railPostCount = vertexCount === 0 ? 0
    : family === 'tank' ? Math.min(vertexCount, C.railPostMax) : 0;

  // Stations. A footprint VERTEX, never an arbitrary azimuth: a fitting on a vertex is exactly on
  // the shell line on both a 16-gon and a rectangle, where an interpolated azimuth would float off
  // a rectangle's flat side.
  const station = (offsetBits, index, count) => (vertexCount === 0 ? 0
    : (byteAt(seed, offsetBits) + Math.round((index * vertexCount) / Math.max(1, count))) % vertexCount);

  // ----- the replaced shell's section, derived from the OBB and nothing else ------------------- //
  const obbYawRad = num(metrics.yawRad);
  const obbCentre = [num(metrics.centerX, centre[0]), num(metrics.centerZ, centre[1])];
  const semiLengthM = Math.max(0.05, num(metrics.lengthM) / 2 - C.shellInsetM);
  const semiWidthM = Math.max(0.05, num(metrics.widthM) / 2 - C.shellInsetM);
  const section = massReplaced
    ? ellipseSection(obbCentre, obbYawRad, semiLengthM, semiWidthM, C.shellSegments)
    : [];
  const footDropFrac = heightM > 1e-6
    ? Math.min(C.footProfileDropM / heightM, C.footProfileDropMaxFrac)
    : C.footProfileDropMaxFrac;
  const footScale = hyperboloidRadiusFrac(C.throatRadiusFrac, C.throatHeightFrac, -footDropFrac);
  /**
   * The ring whose lowest ground decides where the foot is founded. One field for all three paths,
   * so the seating rule ("bottom = lowest ground under the foot ring minus `footEmbedM`") is one
   * sentence rather than three, and a test can state it once.
   */
  const footRing = massReplaced
    ? scaleRing(section, obbCentre, footScale)
    : (ring.length >= 3
      ? offsetRing(ring, centre, family === 'tank' ? C.padOutM : Math.min(radiusM * C.flareOutFrac, C.flareOutMaxM))
      : []);

  return Object.freeze({
    family,
    round,
    /** True when this plan draws the whole building and the renderer extrudes nothing. */
    massReplaced,
    crownForm,
    vertexCount,
    ring,
    centre: Object.freeze(centre),
    areaM2,
    heightM,
    radiusM,
    diameterM,
    slenderness,
    seed,
    crownRiseM,
    curbOutM,
    curbBandM: C.curbBandM,
    curbLipM: C.curbLipM,
    padOutM: C.padOutM,
    padTopM: C.padTopM,
    flareOutM,
    flareTopM: heightM * C.flareTopFrac,
    corniceOutM,
    corniceBandM: Math.min(C.corniceBandM, heightM * 0.2),
    rimHeightM: C.rimHeightM,
    /** How far the rim's OUTER face stands proud at its top. Round towers flare; kerbs do not. */
    rimTopOutM: corniceOutM + (round ? C.rimFlareM : 0),
    ventCount,
    riserCount,
    beaconCount,
    railPostCount,
    ladderVertex: station(8, 0, 1),
    ventVertices: Object.freeze(Array.from({ length: ventCount }, (_, k) => station(16, k, ventCount))),
    riserVertices: Object.freeze(Array.from({ length: riserCount }, (_, k) => station(24, k, riserCount))),
    beaconVertex: station(12, 0, 1),
    // ----- the replaced shell ----------------------------------------------------------------- //
    section: Object.freeze(section.map((point) => Object.freeze(point))),
    sectionCentre: Object.freeze(obbCentre),
    sectionSegments: massReplaced ? C.shellSegments : 0,
    sectionSemiLengthM: massReplaced ? semiLengthM : 0,
    sectionSemiWidthM: massReplaced ? semiWidthM : 0,
    sectionYawRad: obbYawRad,
    shellRings: C.shellRings,
    shellThicknessM: C.shellThicknessM,
    throatRadiusFrac: C.throatRadiusFrac,
    throatHeightFrac: C.throatHeightFrac,
    basinHeightFrac: C.basinHeightFrac,
    /** The rim radius is a CONSEQUENCE of the throat, not a third parameter. Published so it shows. */
    rimRadiusFrac: hyperboloidRadiusFrac(C.throatRadiusFrac, C.throatHeightFrac, 1),
    footScale,
    footRing: Object.freeze(footRing.map((point) => Object.freeze(point))),
    /** Which section azimuth carries the obstruction beacon. Disjoint seed slice, as everything is. */
    beaconSection: massReplaced ? byteAt(seed, 12) % C.shellSegments : 0,
    obb: Object.freeze({
      yawRad: num(metrics.yawRad),
      centerX: num(metrics.centerX),
      centerZ: num(metrics.centerZ),
      lengthM: num(metrics.lengthM),
      widthM: num(metrics.widthM),
    }),
  });
}

// --------------------------------------------------------------------------------------------- //
// 4. Mesh assembly. Small, explicit, CCW-in, outward-out.
// --------------------------------------------------------------------------------------------- //

function meshBuilder() {
  const positions = [];
  const bySlot = new Map();
  const vertex = (x, z, y) => {
    positions.push(...gameToWorld(x, z, y));
    return positions.length / 3 - 1;
  };
  const tri = (slot, a, b, c) => {
    if (!bySlot.has(slot)) bySlot.set(slot, []);
    bySlot.get(slot).push(a, b, c);
  };
  return { positions, bySlot, vertex, tri };
}

/** Level accessor: a scalar or a per-vertex array, so a base can follow the ground and a top not. */
const levelAt = (level, index) => (Array.isArray(level) ? num(level[index]) : num(level));

/**
 * The outward-facing side wall between a lower ring and an upper ring.
 *
 * For a CCW ring the outside is to the RIGHT of the edge direction, so [lo_i, lo_i+1, up_i] and
 * [lo_i+1, up_i+1, up_i] both wind outward. Every other emitter here is a rotation of this one.
 */
function addWall(B, slot, lowerRing, lowerY, upperRing, upperY) {
  const n = lowerRing.length;
  if (n < 3) return;
  const lo = lowerRing.map(([x, z], i) => B.vertex(x, z, levelAt(lowerY, i)));
  const up = upperRing.map(([x, z], i) => B.vertex(x, z, levelAt(upperY, i)));
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    B.tri(slot, lo[i], lo[j], up[i]);
    B.tri(slot, lo[j], up[j], up[i]);
  }
}

/** A flat or tilted annulus between an inner and an outer ring. `up` false flips it to a soffit. */
function addAnnulus(B, slot, innerRing, innerY, outerRing, outerY, up = true) {
  const n = innerRing.length;
  if (n < 3 || outerRing.length !== n) return;
  const a = innerRing.map(([x, z], i) => B.vertex(x, z, levelAt(innerY, i)));
  const o = outerRing.map(([x, z], i) => B.vertex(x, z, levelAt(outerY, i)));
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (up) {
      B.tri(slot, a[i], o[i], o[j]);
      B.tri(slot, a[i], o[j], a[j]);
    } else {
      B.tri(slot, a[i], o[j], o[i]);
      B.tri(slot, a[i], a[j], o[j]);
    }
  }
}

/** The closing fan from a ring up to a single apex. */
function addFan(B, slot, ring, ringY, apex) {
  const n = ring.length;
  if (n < 3) return;
  const r = ring.map(([x, z], i) => B.vertex(x, z, levelAt(ringY, i)));
  const top = B.vertex(apex[0], apex[1], apex[2]);
  for (let i = 0; i < n; i++) B.tri(slot, r[i], r[(i + 1) % n], top);
}

/** Pack the builder into contract mesh data: one contiguous group per material slot, slot-ordered. */
function finishMesh(B) {
  const slots = [...B.bySlot.keys()].sort((a, b) => a - b);
  const indices = [];
  const groups = [];
  for (const slot of slots) {
    const list = B.bySlot.get(slot);
    if (!list.length) continue;
    groups.push({ start: indices.length, count: list.length, materialSlot: slot });
    indices.push(...list);
  }
  if (!indices.length) return null;
  return {
    positions: new Float32Array(B.positions),
    indices: new Uint32Array(indices),
    groups,
  };
}

// --------------------------------------------------------------------------------------------- //
// 5. Instanced fittings.
// --------------------------------------------------------------------------------------------- //

/** The shared unit box: 24 vertices so the renderer's computed normals stay crisp per face. */
function unitBoxPrototype() {
  const positions = [];
  const indices = [];
  const faces = [
    [[-0.5, -0.5, 0], [0.5, -0.5, 0], [0.5, -0.5, 1], [-0.5, -0.5, 1]],
    [[0.5, -0.5, 0], [0.5, 0.5, 0], [0.5, 0.5, 1], [0.5, -0.5, 1]],
    [[0.5, 0.5, 0], [-0.5, 0.5, 0], [-0.5, 0.5, 1], [0.5, 0.5, 1]],
    [[-0.5, 0.5, 0], [-0.5, -0.5, 0], [-0.5, -0.5, 1], [-0.5, 0.5, 1]],
    [[-0.5, -0.5, 1], [0.5, -0.5, 1], [0.5, 0.5, 1], [-0.5, 0.5, 1]],
    [[-0.5, 0.5, 0], [0.5, 0.5, 0], [0.5, -0.5, 0], [-0.5, -0.5, 0]],
  ];
  for (const face of faces) {
    const base = positions.length / 3;
    for (const [x, y, z] of face) positions.push(x, y, z);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** Collect instances per family, then freeze each into the contract's parallel typed arrays. */
function instanceCollector(buildingIndex, baseY) {
  const rows = new Map();
  const add = (familyId, { x, z, y, yaw, scale }) => {
    if (!rows.has(familyId)) rows.set(familyId, []);
    rows.get(familyId).push({ position: gameToWorld(x, z, y), yaw, scale, level: y - baseY });
  };
  const build = () => [...rows.entries()].map(([familyId, list]) => ({
    familyId,
    count: list.length,
    prototype: unitBoxPrototype(),
    offsets: new Float32Array(list.flatMap((row) => row.position)),
    yaws: new Float32Array(list.map((row) => row.yaw)),
    scales: new Float32Array(list.flatMap((row) => row.scale)),
    ownerIndex: new Int32Array(list.map(() => buildingIndex)),
    levelAboveBaseM: new Float32Array(list.map((row) => row.level)),
  }));
  return { add, build };
}

// --------------------------------------------------------------------------------------------- //
// 6. The planner.
// --------------------------------------------------------------------------------------------- //

/**
 * Plan the detail for one `cylinder` building.
 *
 * Returns `null` for any building this archetype does not own — that is the contract's honest
 * "nothing to add", and it is what keeps the router the single source of truth: this module never
 * second-guesses the archetype it was handed.
 *
 * `context` is validated against `PLANNER_CONTEXT_KEYS` before anything is read, so a caller that
 * tries to hand a planner the look flip fails loudly here rather than producing look-dependent
 * geometry (contract.js §1: the flip cannot move a vertex).
 */
export function planDetail(building, context) {
  validatePlannerContext(context);
  const { buildingIndex, classification, seat, groundYAt } = context;
  if (classification?.archetype !== 'cylinder') return null;

  const spec = cylinderSpec(building, classification);
  if (spec.vertexCount < 3) return null;

  const baseY = num(seat?.baseY, NaN);
  if (!Number.isFinite(baseY)) {
    throw new TypeError('cylinder planner: context.seat.baseY must be a finite displayed-metre level');
  }
  const ground = (x, z) => num(groundYAt(x, z), baseY);
  const C = CYLINDER_DETAIL;
  const shellTopY = baseY + spec.heightM;
  const centre = spec.centre;
  const ring = spec.ring;

  const B = meshBuilder();
  const instances = instanceCollector(buildingIndex, baseY);
  const notes = [];

  /** A ring tucked `shellTuckM` inside the wall line, so an annulus cannot open a hairline. */
  const tucked = offsetRing(ring, centre, -C.shellTuckM);
  /** Radial direction and shell radius at footprint vertex `i` — where every fitting stands. */
  const at = (index) => {
    const i = ((index % spec.vertexCount) + spec.vertexCount) % spec.vertexCount;
    const [x, z] = ring[i];
    const dx = x - centre[0];
    const dz = z - centre[1];
    const radius = Math.max(1e-6, Math.hypot(dx, dz));
    return { x, z, ux: dx / radius, uz: dz / radius, radius, yaw: worldYawOf(dx, dz) };
  };

  if (spec.family === 'tank') {
    // ---- foot: the concrete ringwall the shell stands on. It also closes the downhill gap under
    //      a tank on a cross-slope, which is the same defect `plinthBase`/`plinthHeight` exist for.
    const padRing = offsetRing(ring, centre, spec.padOutM);
    const padTopY = baseY + spec.padTopM;
    const padBottomY = padRing.map(([x, z]) => Math.min(
      ground(x, z) - C.footEmbedM,
      padTopY - C.minPrismHeightM,
    ));
    addWall(B, SLOT.wall, padRing, padBottomY, padRing, padTopY);
    addAnnulus(B, SLOT.wall, tucked, padTopY, padRing, padTopY, true);
    notes.push(`ringwall foundation ${spec.padOutM.toFixed(2)} m proud of the shell, founded ${C.footEmbedM} m in`);

    // ---- head: the wind girder. Its soffit is the shadow line that stops the drum reading as a
    //      lidded tube, and it is emitted on `roof` so an authored roof colour paints it.
    const curbRing = offsetRing(ring, centre, spec.curbOutM);
    const curbLowY = shellTopY - spec.curbBandM;
    const curbTopY = shellTopY + spec.curbLipM;
    addAnnulus(B, SLOT.roof, tucked, curbLowY, curbRing, curbLowY, false);
    addWall(B, SLOT.roof, curbRing, curbLowY, curbRing, curbTopY);
    addAnnulus(B, SLOT.roof, tucked, curbTopY, curbRing, curbTopY, true);

    // ---- crown: a fixed roof springing from the shell line at the girder's top level.
    const springY = curbTopY;
    if (!(spec.crownRiseM > 0.05)) {
      // A crown with no rise is a lid, and a lid is what this module exists to replace. A row that
      // reaches here has a degenerate footprint or height; it gets the girder and nothing above it.
      notes.push('crown omitted: derived rise is below 0.05 m');
    } else if (spec.crownForm === 'dome') {
      const f = spec.crownRiseM / spec.radiusM;
      let lowerRing = ring;
      let lowerY = springY;
      for (let k = 1; k <= C.domeRings; k++) {
        const y = (f * k) / C.domeRings;
        const factor = domeRadiusAt(f, y);
        const upperY = springY + y * spec.radiusM;
        if (k === C.domeRings) {
          addFan(B, SLOT.roof, lowerRing, lowerY, [centre[0], centre[1], springY + spec.crownRiseM]);
        } else {
          const upperRing = scaleRing(ring, centre, factor);
          addAnnulus(B, SLOT.roof, upperRing, upperY, lowerRing, lowerY, true);
          lowerRing = upperRing;
          lowerY = upperY;
        }
      }
    } else {
      addFan(B, SLOT.roof, ring, springY, [centre[0], centre[1], springY + spec.crownRiseM]);
    }
    notes.push(`${spec.crownForm} crown rising ${spec.crownRiseM.toFixed(2)} m (${(spec.crownRiseM / spec.heightM * 100).toFixed(0)}% of height, cap ${(C.crownMaxRiseFracOfHeight * 100).toFixed(0)}%)`);

    // ---- fittings.
    for (const post of perimeterStations(curbRing, centre, spec.railPostCount)) {
      instances.add('parapet-coping', {
        x: post.x, z: post.z, y: curbTopY, yaw: post.yaw,
        scale: [C.railPostM, C.railPostM, C.railHeightM],
      });
    }
    for (const vertexIndex of spec.ventVertices) {
      const v = at(vertexIndex);
      const r = v.radius * C.ventBaseScale;
      const seatY = springY + crownHeightAtScale(spec, C.ventBaseScale);
      instances.add('roof-stack', {
        x: centre[0] + v.ux * r,
        z: centre[1] + v.uz * r,
        y: seatY,
        yaw: v.yaw,
        scale: [C.ventWidthM, C.ventWidthM, C.ventHeightM],
      });
    }
    const ladder = at(spec.ladderVertex);
    instances.add('downpipe', {
      x: ladder.x + ladder.ux * (C.ladderDepthM / 2),
      z: ladder.z + ladder.uz * (C.ladderDepthM / 2),
      y: baseY + spec.padTopM,
      yaw: ladder.yaw,
      scale: [C.ladderDepthM, C.ladderWidthM, (curbTopY - baseY) - spec.padTopM],
    });
    notes.push(`${spec.railPostCount} rail posts, ${spec.ventCount} vent stacks (area/${C.ventAreaPerM2} m2), 1 ladder at vertex ${spec.ladderVertex}`);
  } else if (spec.massReplaced) {
    // ------------------------------------------------------------------------------------------ //
    // THE REPLACED SHELL. This plan IS the building; the renderer extrudes nothing for it.
    //
    // Read it as one curve sampled at `shellRings + 1` levels. Level 0 is the OBB's inscribed
    // ellipse — the widest thing the authored rectangle can hold — and every level above it is that
    // same ring scaled by the hyperbola, so the section can never stop being an ellipse and can
    // never grow past the base. The whole tower stands between `baseY` and `baseY + heightM`.
    // ------------------------------------------------------------------------------------------ //
    const section = spec.section.map((point) => [point[0], point[1]]);
    const hub = [spec.sectionCentre[0], spec.sectionCentre[1]];
    const levelOf = (t) => baseY + spec.heightM * t;
    const outerAt = (t) => scaleRing(section, hub, hyperboloidRadiusFrac(spec.throatRadiusFrac, spec.throatHeightFrac, t));
    const innerAt = (t) => offsetRing(outerAt(t), hub, -spec.shellThicknessM);

    // ---- foot: the same curve, continued below the base plane and founded in the earth. No new
    //      flare constant; `footScale` is r(-1 m) and the ring is `spec.footRing`.
    const footRing = spec.footRing.map((point) => [point[0], point[1]]);
    const footBottomY = footRing.map(([x, z]) => Math.min(
      ground(x, z) - C.footEmbedM,
      baseY - C.minPrismHeightM,
    ));
    addWall(B, SLOT.wall, footRing, footBottomY, section, baseY);

    // ---- the shell: `shellRings` bands from the springing to the rim.
    for (let k = 0; k < spec.shellRings; k++) {
      const tLow = k / spec.shellRings;
      const tHigh = (k + 1) / spec.shellRings;
      addWall(B, SLOT.wall, outerAt(tLow), levelOf(tLow), outerAt(tHigh), levelOf(tHigh));
    }

    // ---- the rim: a real wall thickness capped by an annulus, which is what makes the top read as
    //      an OPENING rather than a lid. The rim is the TOP OF THE SHELL, never an upstand above
    //      it — see the header: this tower may not grow.
    const rimOuter = outerAt(1);
    const rimInner = innerAt(1);
    addAnnulus(B, SLOT.roof, rimInner, shellTopY, rimOuter, shellTopY, true);

    // ---- the interior, faced inward. `addWall` winds outward from its first ring to its second,
    //      so handing it the HIGHER band first turns the surface into the shell's inside.
    const basinT = clamp(0, spec.basinHeightFrac, 1);
    const basinRing = innerAt(basinT);
    const basinY = levelOf(basinT);
    for (let k = spec.shellRings; k > 0; k--) {
      const tHigh = k / spec.shellRings;
      const tLow = (k - 1) / spec.shellRings;
      if (tLow < basinT - 1e-9) break;
      addWall(B, SLOT.roof, innerAt(tHigh), levelOf(tHigh), innerAt(tLow), levelOf(tLow));
    }
    // ---- the fill deck. Below it the inside of a 30 m shell is not reachable by any orbit angle,
    //      and 24 more inward-facing bands would be triangles nobody can see.
    addFan(B, SLOT.roof, basinRing, basinY, [hub[0], hub[1], basinY]);

    notes.push(
      `mass REPLACED by an elliptic hyperboloid: ${spec.sectionSegments}-gon section `
      + `${(spec.sectionSemiLengthM * 2).toFixed(2)} x ${(spec.sectionSemiWidthM * 2).toFixed(2)} m `
      + `inscribed in the ${num(classification?.metrics?.lengthM).toFixed(2)} x ${num(classification?.metrics?.widthM).toFixed(2)} m OBB `
      + `(inset ${C.shellInsetM} m), throat ${spec.throatRadiusFrac} of the base at ${spec.throatHeightFrac} of the height, `
      + `rim ${spec.rimRadiusFrac.toFixed(3)}, foot batter ${spec.footScale.toFixed(3)}`,
    );
    notes.push(
      `open rim ${spec.shellThicknessM} m thick over a fill deck at ${(basinT * 100).toFixed(0)}% of the height; `
      + `the shell spans exactly [baseY, baseY + ${spec.heightM}] so the height fit finds nothing to squash`,
    );

    // ---- the one fitting. An obstruction light on a 30 m tower is real, and it hangs its own
    //      height FROM the rim rather than standing on top of it, so the beacon's top IS the data
    //      height. A mast that stood proud would be a 3.2 m height increase wearing a light.
    if (spec.beaconCount > 0) {
      const post = rimOuter[spec.beaconSection % rimOuter.length];
      const dx = post[0] - hub[0];
      const dz = post[1] - hub[1];
      const radius = Math.max(1e-6, Math.hypot(dx, dz));
      instances.add('roof-stack', {
        x: post[0] + (dx / radius) * (C.beaconWidthM / 2),
        z: post[1] + (dz / radius) * (C.beaconWidthM / 2),
        y: shellTopY - C.beaconHeightM,
        yaw: worldYawOf(dx, dz),
        scale: [C.beaconWidthM, C.beaconWidthM, C.beaconHeightM],
      });
    }
    notes.push(`${spec.beaconCount} beacon hung from the rim at section ${spec.beaconSection}; no fan cowls, no rail, no risers — a natural-draught shell has none`);
  } else {
    // ---- foot: a battered flare. Widest at the ground, tapering into the shaft, so the shaft is
    //      the narrowest part of the silhouette without a single vertex inside the prism.
    const flareRing = offsetRing(ring, centre, spec.flareOutM);
    const flareTopY = baseY + spec.flareTopM;
    const flareBottomY = flareRing.map(([x, z]) => Math.min(
      ground(x, z) - C.footEmbedM,
      flareTopY - C.minPrismHeightM,
    ));
    addWall(B, SLOT.wall, flareRing, flareBottomY, ring, flareTopY);
    notes.push(`battered foot: +${spec.flareOutM.toFixed(2)} m radial over the bottom ${spec.flareTopM.toFixed(1)} m`);

    // ---- head: cornice + rim. The cornice's soffit is the overhang; the rim turns the flat lid
    //      into an open basin — the lip a natural-draught shell finishes with.
    const corniceRing = offsetRing(ring, centre, spec.corniceOutM);
    const corniceLowY = shellTopY - spec.corniceBandM;
    addAnnulus(B, SLOT.wall, tucked, corniceLowY, corniceRing, corniceLowY, false);
    addWall(B, SLOT.wall, corniceRing, corniceLowY, corniceRing, shellTopY);
    const rimTopY = shellTopY + spec.rimHeightM;
    const rimTopRing = offsetRing(ring, centre, spec.rimTopOutM);
    addWall(B, SLOT.roof, corniceRing, shellTopY, rimTopRing, rimTopY);
    // The rim's INNER face, deliberately built with its levels swapped: `addWall` winds outward
    // when its second ring is the higher one, so handing it the higher level first flips the
    // surface inward. That is the only way to face a wall into a basin with this one emitter.
    addWall(B, SLOT.roof, ring, rimTopY, ring, shellTopY);
    addAnnulus(B, SLOT.roof, ring, rimTopY, rimTopRing, rimTopY, true);
    notes.push(`${spec.crownForm}: cornice +${spec.corniceOutM.toFixed(2)} m over ${spec.corniceBandM.toFixed(1)} m, rim ${spec.rimHeightM} m above the cap flaring to +${spec.rimTopOutM.toFixed(2)} m`);

    // ---- fittings. Risers, and an obstruction light on anything tall enough to need one.
    for (const vertexIndex of spec.riserVertices) {
      const v = at(vertexIndex);
      instances.add('downpipe', {
        x: v.x + v.ux * (C.riserDepthM / 2),
        z: v.z + v.uz * (C.riserDepthM / 2),
        y: baseY + spec.flareTopM,
        yaw: v.yaw,
        scale: [C.riserDepthM, C.riserWidthM, shellTopY - (baseY + spec.flareTopM)],
      });
    }
    if (spec.beaconCount > 0) {
      const v = at(spec.beaconVertex);
      instances.add('roof-stack', {
        x: centre[0] + v.ux * (v.radius + spec.rimTopOutM / 2),
        z: centre[1] + v.uz * (v.radius + spec.rimTopOutM / 2),
        y: rimTopY,
        yaw: v.yaw,
        scale: [C.beaconWidthM, C.beaconWidthM, C.beaconHeightM],
      });
    }
    notes.push(`${spec.riserCount} risers (height/${C.riserPerM} m), ${spec.beaconCount} beacon`);
  }

  const mesh = finishMesh(B);
  if (classification.roofColor) {
    notes.push(`top assembly on slot "roof" — this row carries an authored roof colour [${classification.roofColor.join(', ')}]`);
  }
  return {
    buildingIndex,
    archetype: 'cylinder',
    mesh,
    instances: instances.build(),
    notes,
    /**
     * The renderer draws no extrusion and no outline for a plan that sets this, and `assemble.js`
     * measures the height fit against the plan's own geometry instead of against a mass. Only a
     * tower whose footprint is not drawn round sets it; the three tanks and the round tower are
     * untouched, additive detail exactly as before.
     */
    replacesMass: spec.massReplaced,
    /**
     * ...and the near-black skirt goes with the mass. It is built from the AUTHORED polygon, so on
     * a replaced row it would draw the rectangle's corners on the ground — up to 3.8 m of dark
     * quad sticking out past the shell on row 19, which is the box, at ankle height. The foot
     * batter above is founded `footEmbedM` under the lowest ground beneath the shell and closes
     * the same downhill gap the skirt exists for.
     */
    suppressPlinth: spec.massReplaced,
    /** Not part of the contract; carried so a census or a test can read the resolved dimensions. */
    spec,
    stats: {
      triangles: mesh ? mesh.indices.length / 3 : 0,
      vertices: mesh ? mesh.positions.length / 3 : 0,
      shellTopY,
      crownTopY: spec.family === 'tank'
        ? shellTopY + spec.curbLipM + spec.crownRiseM
        : (spec.massReplaced ? shellTopY : shellTopY + spec.rimHeightM),
    },
  };
}

export { planDetail as planCylinderDetail };

// --------------------------------------------------------------------------------------------- //
// 7. The audit that makes the additive constraint checkable rather than aspirational.
// --------------------------------------------------------------------------------------------- //

/**
 * How far, at worst, this plan reaches INSIDE its own building's shell prism, and how far it
 * reaches above its top.
 *
 * `worstInsetM` is the number the additive constraint lives or dies on: a positive value larger
 * than `shellTuckM` means geometry the extrusion hides, which is either a wasted triangle or — far
 * worse — a shape that silently contradicts the footprint. Vertices at or above the shell top are
 * excluded because the crown legitimately owns that region.
 *
 * **It does not apply to a plan that REPLACES its mass.** There is no extrusion to hide inside, so
 * on rows 14 and 19 a large inset is the deliverable rather than the defect: an ellipse inscribed
 * in a rectangle stands 3.6 m inside the footprint at row 19's corners, by construction. `worstInsetM`
 * is still measured and still reported there — it is how far the shell sits inside the rectangle,
 * which is worth reading — but `massReplaced` is published beside it so a caller cannot apply the
 * additive rule to a row the rule was never about. `worstOutsetM` applies to BOTH kinds and is the
 * one that matters on a replaced row: the shell may not leave the authored footprint.
 *
 * `worstOutsetM` is the other half, and it exists because of something the planner context cannot
 * see. The six cylinders sit in a 35 m cluster and three pairs of them ALREADY interpenetrate in
 * the shipped data: measured centroid-to-centroid clearance is -1.7 m between rows 12 and 14,
 * -1.6 m between 13 and 14, and -1.6 m between 15/16 and the warehouse at row 17. A planner is
 * handed one building at a time (`PLANNER_CONTEXT_KEYS` has no neighbour channel), so it cannot
 * check clearance and must instead stay small enough that it never needs to. Everything outward in
 * this module is bounded by ~1.2 m, which is why the bund wall a fuel tank would really have —
 * 3-4 m of ring at 1.35 x the radius, and by far the strongest "this is a fuel farm" cue available
 * — is deliberately NOT built here.
 *
 * The world frame is a 180-degree rotation of the game frame about the vertical
 * (`gameToWorld(x, z, y) = [-x, -z, y]`), so a radial distance measured about the negated centroid
 * in world space is the same number as in game space. That is asserted rather than assumed.
 */
export function cylinderVertexAudit(plan) {
  const spec = plan?.spec;
  const mesh = plan?.mesh;
  if (!spec || !mesh) return null;
  const worldCentre = gameToWorld(spec.centre[0], spec.centre[1], 0);
  const shellRadiusToward = (dx, dy) => {
    // Distance from the centroid to the footprint boundary along (dx, dy), by segment intersection.
    const length = Math.hypot(dx, dy);
    if (!(length > 1e-9)) return 0;
    const ux = dx / length;
    const uy = dy / length;
    let best = 0;
    for (let i = 0; i < spec.ring.length; i++) {
      const a = gameToWorld(spec.ring[i][0], spec.ring[i][1], 0);
      const b = gameToWorld(spec.ring[(i + 1) % spec.ring.length][0], spec.ring[(i + 1) % spec.ring.length][1], 0);
      const ex = b[0] - a[0];
      const ey = b[1] - a[1];
      const denominator = ux * ey - uy * ex;
      if (Math.abs(denominator) < 1e-12) continue;
      const ax = a[0] - worldCentre[0];
      const ay = a[1] - worldCentre[1];
      const t = (ax * ey - ay * ex) / denominator;
      const s = (ax * uy - ay * ux) / denominator;
      if (t >= 0 && s >= -1e-9 && s <= 1 + 1e-9) best = Math.max(best, t);
    }
    return best;
  };
  let worstInsetM = -Infinity;
  let worstOutsetM = -Infinity;
  let lowestY = Infinity;
  let highestY = -Infinity;
  const shellTopY = plan.stats.shellTopY;
  for (let index = 0; index < mesh.positions.length; index += 3) {
    const x = mesh.positions[index];
    const y = mesh.positions[index + 1];
    const z = mesh.positions[index + 2];
    lowestY = Math.min(lowestY, z);
    highestY = Math.max(highestY, z);
    const dx = x - worldCentre[0];
    const dy = y - worldCentre[1];
    const radius = Math.hypot(dx, dy);
    const shellRadius = shellRadiusToward(dx, dy);
    worstOutsetM = Math.max(worstOutsetM, radius - shellRadius);
    if (z >= shellTopY - 1e-6) continue;
    worstInsetM = Math.max(worstInsetM, shellRadius - radius);
  }
  return {
    massReplaced: spec.massReplaced === true,
    worstInsetM: Number.isFinite(worstInsetM) ? worstInsetM : 0,
    worstOutsetM: Number.isFinite(worstOutsetM) ? worstOutsetM : 0,
    lowestY,
    highestY,
    crownRiseAboveShellM: highestY - shellTopY,
  };
}

/** Smallest triangle area in a plan's mesh, in square metres. Zero means a degenerate face. */
export function minTriangleAreaM2(mesh) {
  if (!mesh) return 0;
  let smallest = Infinity;
  const P = mesh.positions;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i] * 3;
    const b = mesh.indices[i + 1] * 3;
    const c = mesh.indices[i + 2] * 3;
    const ux = P[b] - P[a];
    const uy = P[b + 1] - P[a + 1];
    const uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a];
    const vy = P[c + 1] - P[a + 1];
    const vz = P[c + 2] - P[a + 2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    smallest = Math.min(smallest, Math.hypot(cx, cy, cz) / 2);
  }
  return Number.isFinite(smallest) ? smallest : 0;
}
