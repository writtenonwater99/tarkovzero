/**
 * Garage blocks — the `garage` archetype's detail planner.
 *
 * Twelve Customs buildings route here (`kind: 'garages'`, 4,463 m2, 15.2% of all building
 * footprint). Every one of them is 4.0 m tall with `floors: 1`, so HEIGHT CARRIES NO INFORMATION
 * for this archetype: all twelve are the same box height, and if the variation between them does
 * not come out of the footprint, the terrain and the seed, there is no variation at all. That is
 * the whole problem this module exists to solve — twelve identical extruded rectangles is exactly
 * the "random boxes" the founder is looking at.
 *
 * A garage rank is one continuous mass with a BAY RHYTHM: a row of 3-4 m door bays along a long
 * face, under one roof, with a ridge or a single fall. Three things decide whether it reads:
 *
 *   1. the roof form and its ridge line (the only thing here that changes the SILHOUETTE),
 *   2. the door rhythm on the correct long face (the only thing that says "garage" and not "shed"),
 *   3. whether the plan is one mass or two.
 *
 * ---------------------------------------------------------------------------------------------
 * THE MEASUREMENT THAT DECIDES (3), AND THE BUG IT PREVENTS
 *
 * Four of the twelve are the "Storage" sheds — 15.4-15.6 m deep, far too deep for a single 6 m bay,
 * so they are two ranks back to back. The obvious model is two rows sharing a SPINE WALL, and it is
 * wrong: a coherence judge measured the polygons and found solid rectangles with a small jog, not
 * two separated rows. This module re-measured the shipped JSON in each plan's own OBB frame and got
 * the same answer, as the offset between the two lanes' end lines:
 *
 *     building  8   lane offsets 0.63 / 0.63 m
 *     building  9   lane offsets 0.36 / 0.56 m
 *     building 11   lane offsets 0.01 / 0.51 m
 *     building 10   lane offsets 0.41 / 4.29 m     <- the only real articulation
 *
 * So `laneMergeM` is a threshold with a MEASURED EMPTY BAND behind it, in the style the router uses:
 * nothing at all lies between 0.63 m and 4.29 m, and 1.5 m sits in that band with 0.87 m of
 * clearance below and 2.79 m above. Below it the two lanes are ONE unit under ONE ridge and NO
 * SPINE IS BUILT; above it they are two units with their own ridges and their own lengths. Without
 * that merge pass a 0.5 m jog becomes a fake wing on three of the four biggest garages — a visible
 * defect invented out of a rounding artefact in the source SVG.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THE ROOF MAY STAND ABOVE `height`, AND EXACTLY HOW FAR
 *
 * The walls are already drawn as a box up to `seat.baseY + height` and this module may not touch
 * them (handoff §4: heights are a standing decision). A pitched roof therefore has to start AT the
 * wall head and rise above it: an eave BELOW the wall head would be buried inside a box that is
 * still drawn to 4.0 m, and the ridge would read as a fin on a flat roof.
 *
 * The rise is capped at the envelope the deck.gl renderer — the one production served for months,
 * whose massing the founder has already accepted — gives the same building. Its gable recipe is
 * `eave = h * 0.72, ridge = h + 0.4` (src/map3d.js), i.e. a total rise of `0.28h + 0.4`, which on a
 * 4.0 m garage is 1.52 m. So `ridgeRiseCap()` is not a taste call: a garage detailed here is never
 * taller than the same garage already is in production. The constant pitch (decision 3) applies
 * until it meets that cap; the cap then binds only on the four 15.4 m-deep sheds, taking them from
 * 14 deg to 11.2 deg, which is a shallower but entirely real shed pitch. `unit.pitchDeg` reports
 * what was ACHIEVED, never what was asked for, and the test asserts the achieved value stays in a
 * plausible band — a reported constant 14 could not fail.
 *
 * ---------------------------------------------------------------------------------------------
 * SILHOUETTE OVER SURFACE (decision 4)
 *
 * At the default 3D zoom one pixel is one metre, so nothing thinner than about a metre earns
 * triangles. Deliberately NOT built: wall ribs, pilasters, door frames, downpipes, gutters,
 * corrugation, roof plant. A garage rank has no roof plant, and every one of those is sub-pixel.
 *
 * Built instead: the roof form with its overhang (a ridge line on a 104 m rank is 104 px long), the
 * gable or wedge end walls (the silhouette at each end), the ridge cap, and the door rhythm. The
 * doors are the one non-silhouette element and they earn it on TONE, not relief: a 3.0 x 3.0 m dark
 * opening is ~9 px2 against a light wall and a row of them is the archetype's whole identity. They
 * stand 0.06 m PROUD of the wall rather than recessed, because the wall mesh belongs to the
 * renderer and a recess cut behind it would simply be hidden by it.
 *
 * ---------------------------------------------------------------------------------------------
 * BUDGET
 *
 * One extra material slot per building (`dark`, for the doors) and ZERO instanced families: 12
 * extra draw calls map-wide, 0.8% of a 1,461-call frame, against a budget of one extra slot per
 * building. `door-module` instancing was considered and rejected on the contract's own numbers —
 * `INSTANCED_FAMILIES['door-module'].maxPerBuilding` is 16 and building 4 alone is a 104 m rank of
 * 28 bays, so a third of the map's garage doors would have been silently dropped at the validator.
 * The ridge cap takes the `wall` slot rather than `trim` for the same reason: `trim` would be a
 * SECOND non-free slot. That is not a loss — all six roof-coloured garages carry `roof` [96,99,100]
 * against `color` [144,146,142], so a wall-coloured cap is a light line on a dark roof, which is
 * exactly what a ridge cap should look like.
 *
 * PUBLIC DATA ONLY. Everything below derives from `poly`, `height`, `floors`, `style`, `kind` and
 * the terrain sampler the renderer already seats walls with. No game-derived coordinate appears
 * here, nothing is traced from an asset, and no height is changed.
 */

import { MATERIAL_SLOT_INDEX, emptyDetailPlan, validatePlannerContext } from './contract.js';
import { gameToWorld } from '../three-world.js';

const clamp = (low, value, high) => Math.min(high, Math.max(low, value));
const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const DEG = Math.PI / 180;

// --------------------------------------------------------------------------------------------- //
// The frozen constant table. Every entry states the measurement or the precedent behind it.
// --------------------------------------------------------------------------------------------- //

export const GARAGE = Object.freeze({
  /**
   * Above this footprint depth the plan is two ranks back to back and gets doors on BOTH long
   * faces. Measured over the twelve: eight sit at 4.6-6.4 m (one 6 m bay plus its walls) and four
   * at 15.4-15.6 m. The band 6.4 -> 15.4 m is empty, so 10 m has 3.6 m of clearance either side.
   */
  doubleRankMinDepthM: 10,
  /**
   * How far the two lanes' end lines may differ before they stop being one mass. Measured band:
   * 0.63 m (the largest jog on sheds 8/9/11) -> 4.29 m (shed 10's real step). See the header.
   */
  laneMergeM: 1.5,
  /** Scanlines per lane when measuring its own length. Odd, so the median is a real sample. */
  laneSamples: 9,

  /**
   * The constant plausible pitches (decision 3). 14 deg is an ordinary industrial shed gable; 7 deg
   * is a single-fall rank draining across its own depth. Both are then bounded by `ridgeRiseCap`.
   */
  ridgePitchDeg: 14,
  monoPitchDeg: 7,
  /**
   * The deck.gl renderer's own gable envelope, `ridge - eave = (h - 0.72h) + 0.4` (src/map3d.js).
   * A garage detailed here never stands taller than the same garage already does in production.
   */
  riseCapHeightFrac: 0.28,
  riseCapBaseM: 0.4,
  /** Below this a "pitch" is a construction seam, not a roof: the unit is skipped, never faked. */
  minRiseM: 0.12,

  /** Roof slab depth: thin enough to be honest at 1 m/px, thick enough to show a fascia at the eave. */
  roofSlabThicknessM: 0.16,
  /** Overhang past the wall, across the slope and at the verge. Ratio for the family, clamps for legibility. */
  overhangRatio: 0.05,
  minOverhangM: 0.25,
  maxOverhangM: 0.6,
  /** The end wall closing the triangle above the box top. Thin: it is a gable, not a buttress. */
  endWallThicknessM: 0.22,
  /** The ridge cap: one line the full length of the unit. */
  ridgeCapHalfWidthM: 0.22,
  ridgeCapProudM: 0.1,
  /** How far the cap beds into the roof slab, so no sliver of sky shows along the ridge seam. */
  ridgeCapBedM: 0.03,

  /**
   * Bay rhythm. A single garage door leaf is 2.5-3.0 m; with its pier a bay lands at 3.0-4.5 m and
   * 3.6 m is the middle of that. `bayCountFor` rounds to whole bays and then WALKS the count until
   * the pitch is inside the band, so the rhythm is always a real garage rhythm and never whatever
   * the remainder of a division happened to be.
   */
  targetBayPitchM: 3.6,
  minBayPitchM: 3,
  maxBayPitchM: 4.5,
  /** The pier between two doors. Sub-pixel as relief, so it is spacing only — no geometry is built for it. */
  pierRatio: 0.16,
  minPierM: 0.35,
  maxPierM: 0.8,
  /** Narrower than this is a personnel door, not a vehicle bay: the pier gives way before the door does. */
  minDoorWidthM: 2.2,
  /** The rank stops this far short of each end of its lane, so a door is never flush with a corner. */
  rankEndInsetM: 0.35,

  maxDoorHeightM: 3,
  minDoorHeightM: 2,
  /** Header above the door: the lintel plus the wall head. */
  doorHeadClearanceM: 0.9,
  /** Off the wall base, clear of the plinth skirt seam. */
  doorSillLiftM: 0.04,
  /** Proud of the wall face. The wall mesh is not ours to cut, so a door is applied, not recessed. */
  doorProudM: 0.06,

  /**
   * A rank of at least this many bays gets exactly one BLANK bay — a bricked-up or shuttered
   * opening, chosen by the seed. Twelve stamped ranks read as one repeated asset; one irregularity
   * per rank is what stops that, and it is deterministic because `Math.random` is forbidden.
   */
  blankBayMinBays: 4,

  /**
   * Choosing the door face. The ground is probed this far out from each candidate long face, at
   * this many stations, and the LOWER mean wins: a rank cut into a slope opens downhill, because
   * the uphill side is the cut. Inside `doorFaceTieM` the ground is flat as far as this decision
   * goes, and the seed breaks the tie — deterministically, and differently per building.
   */
  doorFaceProbeOffsetM: 1.5,
  doorFaceProbes: 5,
  doorFaceTieM: 0.15,
});

/** The envelope cap, in metres, for a building of this height. See the header. */
export const ridgeRiseCap = (heightM) =>
  GARAGE.riseCapHeightFrac * Math.max(0, num(heightM)) + GARAGE.riseCapBaseM;

// --------------------------------------------------------------------------------------------- //
// The OBB frame. Every length below is measured in it, so a rank's "long face" is the plan's own
// dominant axis and not whichever way the map happens to be drawn.
// --------------------------------------------------------------------------------------------- //

function cleanRing(poly) {
  if (!Array.isArray(poly)) return [];
  return poly
    .filter((p) => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
    .map((p) => [Number(p[0]), Number(p[1])]);
}

/**
 * The (u, v) frame: u along `metrics.yawRad` (the plan's dominant long axis, measured by the router
 * over the same convex hull), v across it.
 *
 * `(u, v) -> game (x, z)` is a pure rotation and `gameToWorld` is a 180-degree rotation of the
 * ground plane, so the composite has a positive determinant and ORIENTATION IS PRESERVED end to
 * end. That is what lets `pushFace` below decide winding from a direction expressed in (u, v, y)
 * without ever converting a normal by hand.
 */
export function obbFrame(ring, yawRad) {
  const ux = Math.cos(yawRad), uz = Math.sin(yawRad);
  const uv = ring.map(([x, z]) => [x * ux + z * uz, -x * uz + z * ux]);
  const us = uv.map((p) => p[0]), vs = uv.map((p) => p[1]);
  return {
    ux, uz, uv,
    toGame: (u, v) => [u * ux - v * uz, u * uz + v * ux],
    uMin: Math.min(...us), uMax: Math.max(...us),
    vMin: Math.min(...vs), vMax: Math.max(...vs),
  };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[(sorted.length - 1) >> 1] : NaN;
};

/**
 * The u-extent of the polygon on one scanline of constant v: the outermost crossings.
 *
 * The edge test is half-open (`av <= v < bv`), so an edge lying exactly along the scanline is
 * skipped instead of counted twice. The Storage sheds' jogs are exactly such edges.
 */
export function spanAtV(uv, v) {
  const crossings = [];
  for (let index = 0; index < uv.length; index++) {
    const [au, av] = uv[index];
    const [bu, bv] = uv[(index + 1) % uv.length];
    if ((av <= v && bv > v) || (bv <= v && av > v)) {
      crossings.push(au + ((bu - au) * (v - av)) / (bv - av));
    }
  }
  return crossings.length ? [Math.min(...crossings), Math.max(...crossings)] : null;
}

/**
 * Decompose a garage plan into rectilinear UNITS, and run the merge pass.
 *
 * A plan deeper than `doubleRankMinDepthM` is split across its short axis into two lanes, and each
 * lane's own length is measured by MEDIAN scanline so that a single 0.5 m jog edge cannot move it.
 * The lanes are then merged back into one unit unless BOTH end lines differ by at least
 * `laneMergeM`. A merged unit takes the outer envelope of both lanes, so the shorter lane gets half
 * a metre of eave over it — which is what makes the jog vanish instead of becoming a wing.
 *
 * Returns `units` in the (u, v) frame; `lanes` and `offsets` are kept so a test can assert the
 * merge decision against the measurement that drove it rather than against its own re-derivation.
 */
export function decomposeUnits(frame) {
  const depth = frame.vMax - frame.vMin;
  const laneCount = depth >= GARAGE.doubleRankMinDepthM ? 2 : 1;
  const lanes = [];
  for (let index = 0; index < laneCount; index++) {
    const vLo = frame.vMin + (depth / laneCount) * index;
    const vHi = vLo + depth / laneCount;
    const los = [], his = [];
    for (let sample = 0; sample < GARAGE.laneSamples; sample++) {
      // Inset from the lane's own edges: a scanline on the boundary between two lanes is ambiguous
      // and one on the outer wall line is degenerate.
      const t = 0.06 + (0.88 * sample) / (GARAGE.laneSamples - 1);
      const span = spanAtV(frame.uv, vLo + (vHi - vLo) * t);
      if (span) { los.push(span[0]); his.push(span[1]); }
    }
    if (!los.length) return { laneCount, merged: laneCount === 1, lanes: [], offsets: null, units: [] };
    lanes.push({ vLo, vHi, uLo: median(los), uHi: median(his) });
  }

  if (laneCount === 1) {
    const [lane] = lanes;
    return {
      laneCount, merged: true, lanes, offsets: null,
      units: [{ uLo: lane.uLo, uHi: lane.uHi, vLo: frame.vMin, vHi: frame.vMax, laneIndices: [0] }],
    };
  }

  const offsets = [Math.abs(lanes[0].uLo - lanes[1].uLo), Math.abs(lanes[0].uHi - lanes[1].uHi)];
  const merged = offsets.every((offset) => offset < GARAGE.laneMergeM);
  const units = merged
    ? [{
        uLo: Math.min(lanes[0].uLo, lanes[1].uLo),
        uHi: Math.max(lanes[0].uHi, lanes[1].uHi),
        vLo: frame.vMin, vHi: frame.vMax, laneIndices: [0, 1],
      }]
    : lanes.map((lane, index) => ({
        uLo: lane.uLo, uHi: lane.uHi, vLo: lane.vLo, vHi: lane.vHi, laneIndices: [index],
      }));
  return { laneCount, merged, lanes, offsets, units };
}

// --------------------------------------------------------------------------------------------- //
// Bay rhythm.
// --------------------------------------------------------------------------------------------- //

/**
 * How many bays fit a rank of `lengthM`, and the pitch that gives.
 *
 * Rounding alone is not enough: `round(L / 3.6)` can leave a short rank outside the plausible band,
 * and a 5.2 m bay is a hangar door, not a garage. So the count is walked until the pitch is inside
 * [minBayPitchM, maxBayPitchM] or it bottoms out at a single bay.
 */
export function bayCountFor(lengthM) {
  const length = Math.max(0, num(lengthM));
  if (!(length > 0)) return { bays: 0, bayPitchM: 0 };
  let bays = Math.max(1, Math.round(length / GARAGE.targetBayPitchM));
  while (length / bays > GARAGE.maxBayPitchM) bays += 1;
  while (bays > 1 && length / bays < GARAGE.minBayPitchM) bays -= 1;
  return { bays, bayPitchM: length / bays };
}

/**
 * One rank of doors on one face of one unit.
 *
 * `faceSign` is -1 for the v-minimum face and +1 for the v-maximum face. `vFace` is that face's own
 * v, taken from the LANE and not from a merged envelope, so a lane's doors sit on the lane's own
 * wall rather than hanging half a metre out over the jog.
 */
export function planRank(uLo, uHi, faceSign, vFace, seed, wallHeightM) {
  const usableM = (uHi - uLo) - 2 * GARAGE.rankEndInsetM;
  if (!(usableM > GARAGE.minDoorWidthM)) return null;
  const { bays, bayPitchM } = bayCountFor(usableM);
  if (!bays) return null;

  const pierM = clamp(
    GARAGE.minPierM,
    Math.min(bayPitchM * GARAGE.pierRatio, bayPitchM - GARAGE.minDoorWidthM),
    GARAGE.maxPierM,
  );
  const doorWidthM = bayPitchM - pierM;
  const doorHeightM = clamp(
    GARAGE.minDoorHeightM,
    wallHeightM - GARAGE.doorHeadClearanceM,
    GARAGE.maxDoorHeightM,
  );
  // One blank bay per rank, chosen by the seed. The face sign is mixed in so the two ranks of a
  // back-to-back shed do not put their blank bay in the same place.
  const blankBay = bays >= GARAGE.blankBayMinBays
    ? ((seed ^ (faceSign > 0 ? 0x9e3779b9 : 0)) >>> 0) % bays
    : -1;

  return {
    faceSign, vFace, bays, bayPitchM, pierM, doorWidthM, doorHeightM, blankBay,
    uStart: uLo + GARAGE.rankEndInsetM,
    doorCount: bays - (blankBay >= 0 ? 1 : 0),
  };
}

/**
 * Which long face carries the doors on a single-rank garage.
 *
 * A rank cut into a slope opens downhill: the uphill side is the cut face. Each candidate is probed
 * `doorFaceProbes` times, `doorFaceProbeOffsetM` out from the wall, and the lower mean wins. Inside
 * `doorFaceTieM` the ground is flat as far as this decision goes and the seed decides.
 *
 * This is also what sets the mono-pitch high side: the doors need the headroom, and a lean-to cut
 * into a bank is low against the cut and high at the opening.
 */
export function chooseDoorFace(frame, unit, groundYAt, seed) {
  const probe = (vFace, sign) => {
    let total = 0;
    for (let index = 0; index < GARAGE.doorFaceProbes; index++) {
      const t = (index + 0.5) / GARAGE.doorFaceProbes;
      const u = unit.uLo + (unit.uHi - unit.uLo) * t;
      const [x, z] = frame.toGame(u, vFace + sign * GARAGE.doorFaceProbeOffsetM);
      total += num(groundYAt(x, z), 0);
    }
    return total / GARAGE.doorFaceProbes;
  };
  const lowSide = probe(unit.vLo, -1);
  const highSide = probe(unit.vHi, +1);
  const deltaM = highSide - lowSide;
  if (Math.abs(deltaM) >= GARAGE.doorFaceTieM) {
    return deltaM > 0
      ? { faceSign: -1, vFace: unit.vLo, reason: 'terrain:downhill', deltaM }
      : { faceSign: +1, vFace: unit.vHi, reason: 'terrain:downhill', deltaM };
  }
  return ((seed >>> 3) & 1)
    ? { faceSign: +1, vFace: unit.vHi, reason: 'seed:flat-ground-tie', deltaM }
    : { faceSign: -1, vFace: unit.vLo, reason: 'seed:flat-ground-tie', deltaM };
}

// --------------------------------------------------------------------------------------------- //
// Mesh assembly. Positions are WORLD space; indices are grouped by material slot.
// --------------------------------------------------------------------------------------------- //

/**
 * A vertex sink with one rule: EVERY FACE GETS ITS OWN VERTICES.
 *
 * That is deliberate, not laziness. The contract lets the renderer compute normals, and a shared
 * vertex between a roof slope and a gable end would be averaged into a smooth normal across a hard
 * arris — a garage would come back looking inflated. Per-face vertices give flat shading for free.
 * The cost is ~2,100 vertices for all twelve buildings, which is nothing.
 */
function makeSink(frame) {
  const positions = [];
  const bySlot = new Map();
  let vertices = 0;

  const vertex = (u, v, y) => {
    const [x, z] = frame.toGame(u, v);
    positions.push(...gameToWorld(x, z, y));
    return vertices++;
  };
  const triangle = (slot, a, b, c) => {
    if (!bySlot.has(slot)) bySlot.set(slot, []);
    bySlot.get(slot).push(a, b, c);
  };
  return { positions, bySlot, vertex, triangle, vertexCount: () => vertices };
}

/** A direction in the (u, v, y) frame, expressed in world axes. Linear, so no translation term. */
const directionToWorld = (frame, du, dv, dy) => [
  -(du * frame.ux - dv * frame.uz),
  -(du * frame.uz + dv * frame.ux),
  dy,
];

/**
 * One convex polygon, wound so its normal points along `outward` (given in the (u, v, y) frame).
 *
 * The winding is decided by an explicit dot product against the face's own outward reference rather
 * than by a hand-derived rule, because a hand-derived rule is exactly the sort of thing that is
 * silently 180 degrees wrong on half the faces and only shows up as missing geometry on a GPU
 * nobody has looked at yet.
 */
function pushFace(sink, frame, slot, pointsUVY, outward) {
  if (pointsUVY.length < 3) return 0;
  const ids = pointsUVY.map(([u, v, y]) => sink.vertex(u, v, y));
  const at = (index) => sink.positions.slice(ids[index] * 3, ids[index] * 3 + 3);
  const [p0, p1, p2] = [at(0), at(1), at(2)];
  const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
  const normal = [
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ];
  const reference = directionToWorld(frame, outward[0], outward[1], outward[2]);
  const dot = normal[0] * reference[0] + normal[1] * reference[1] + normal[2] * reference[2];
  const order = dot >= 0 ? ids : [...ids].reverse();
  let triangles = 0;
  for (let index = 1; index < order.length - 1; index++) {
    sink.triangle(slot, order[0], order[index], order[index + 1]);
    triangles += 1;
  }
  return triangles;
}

/**
 * A solid: one convex cross-section in the (v, y) plane, extruded along u from `uA` to `uB`.
 *
 * Every element in this module is one of these — roof slabs, gable wedges, mono end wedges, the
 * ridge cap, the mono upstand band. Outward references come from the section's own centroid, which
 * is valid for any convex section and is why there is no per-element winding code.
 */
function pushExtrusion(sink, frame, slot, sectionVY, uA, uB) {
  if (sectionVY.length < 3 || Math.abs(uB - uA) < 1e-9) return 0;
  const centreV = sectionVY.reduce((sum, [v]) => sum + v, 0) / sectionVY.length;
  const centreY = sectionVY.reduce((sum, [, y]) => sum + y, 0) / sectionVY.length;
  const sign = uB > uA ? 1 : -1;
  let triangles = 0;
  triangles += pushFace(sink, frame, slot, sectionVY.map(([v, y]) => [uA, v, y]), [-sign, 0, 0]);
  triangles += pushFace(sink, frame, slot, sectionVY.map(([v, y]) => [uB, v, y]), [sign, 0, 0]);
  for (let index = 0; index < sectionVY.length; index++) {
    const [v0, y0] = sectionVY[index];
    const [v1, y1] = sectionVY[(index + 1) % sectionVY.length];
    triangles += pushFace(
      sink, frame, slot,
      [[uA, v0, y0], [uA, v1, y1], [uB, v1, y1], [uB, v0, y0]],
      [0, (v0 + v1) / 2 - centreV, (y0 + y1) / 2 - centreY],
    );
  }
  return triangles;
}

// --------------------------------------------------------------------------------------------- //
// The roof of one unit.
// --------------------------------------------------------------------------------------------- //

/**
 * Roof geometry for one rectilinear unit, seated with its EAVE ON THE WALL HEAD.
 *
 * The underside plane passes exactly through the wall line at the eave, so the overhang hangs BELOW
 * the wall head the way a real eave does and there is no slot along the long face to see through.
 * On a mono-pitch the high side's gap is closed by an upstand band, which is a genuine element
 * (0.6-0.8 m of wall running the whole length) rather than a patch over a modelling mistake.
 */
function planUnitRoof(unit, roofForm, wallHeadY, heightM, highSign) {
  const spanM = unit.vHi - unit.vLo;
  if (!(spanM > 1e-6)) return null;
  const overhangM = clamp(GARAGE.minOverhangM, spanM * GARAGE.overhangRatio, GARAGE.maxOverhangM);
  const capM = ridgeRiseCap(heightM);

  if (roofForm === 'ridged') {
    const halfSpanM = spanM / 2;
    const riseM = Math.min(halfSpanM * Math.tan(GARAGE.ridgePitchDeg * DEG), capM);
    if (!(riseM >= GARAGE.minRiseM)) return null;
    return {
      form: 'ridged', spanM, halfSpanM, overhangM, riseM,
      slope: riseM / halfSpanM,
      vRidge: (unit.vLo + unit.vHi) / 2,
      cappedByEnvelope: halfSpanM * Math.tan(GARAGE.ridgePitchDeg * DEG) > capM + 1e-9,
      pitchDeg: Math.atan(riseM / halfSpanM) / DEG,
      highSign: 0,
    };
  }

  const riseM = Math.min(spanM * Math.tan(GARAGE.monoPitchDeg * DEG), capM);
  if (!(riseM >= GARAGE.minRiseM)) return null;
  return {
    form: 'mono-pitch', spanM, halfSpanM: spanM, overhangM, riseM,
    slope: riseM / spanM,
    vRidge: null,
    cappedByEnvelope: spanM * Math.tan(GARAGE.monoPitchDeg * DEG) > capM + 1e-9,
    pitchDeg: Math.atan(riseM / spanM) / DEG,
    highSign,
  };
}

/**
 * The roof underside height at a given v, for one unit's roof. Exact at the wall lines, and it
 * KEEPS FALLING past them so the overhang hangs below the wall head the way an eave does.
 *
 * The mono-pitch branch is signed on purpose. An absolute-value form (`|v - vLow|`) is symmetric
 * about the low wall, so the overhang on that side turns UPWARD and the roof leaves the building
 * hovering 4 cm clear of its own wall head — which is what the first version of this function did,
 * and what G4 caught.
 */
function undersideYFor(unit, roof, wallHeadY) {
  if (roof.form === 'ridged') {
    return (v) => wallHeadY + (roof.halfSpanM - Math.abs(v - roof.vRidge)) * roof.slope;
  }
  const vLow = roof.highSign > 0 ? unit.vLo : unit.vHi;
  const vHigh = roof.highSign > 0 ? unit.vHi : unit.vLo;
  const direction = vHigh >= vLow ? 1 : -1;
  return (v) => wallHeadY + (v - vLow) * direction * roof.slope;
}

function pushUnitRoof(sink, frame, unit, roof, wallHeadY) {
  const thickness = GARAGE.roofSlabThicknessM;
  const roofSlot = MATERIAL_SLOT_INDEX.roof;
  const wallSlot = MATERIAL_SLOT_INDEX.wall;
  const under = undersideYFor(unit, roof, wallHeadY);
  const u0 = unit.uLo - roof.overhangM, u1 = unit.uHi + roof.overhangM;
  const counts = { slabs: 0, endWalls: 0, ridgeCap: 0, upstand: 0 };

  if (roof.form === 'ridged') {
    for (const side of [-1, +1]) {
      const vEave = (side < 0 ? unit.vLo : unit.vHi) + side * roof.overhangM;
      const section = [
        [vEave, under(vEave)],
        [roof.vRidge, under(roof.vRidge)],
        [roof.vRidge, under(roof.vRidge) + thickness],
        [vEave, under(vEave) + thickness],
      ];
      counts.slabs += pushExtrusion(sink, frame, roofSlot, section, u0, u1);
    }
    // The gable ends: the wedge between the box top and the roof underside, on the unit's own wall
    // line. The verge oversails it by `overhangM`, which is why it reads as a gable and not a
    // sawn-off end.
    const wedge = [
      [unit.vLo, wallHeadY],
      [unit.vHi, wallHeadY],
      [roof.vRidge, wallHeadY + roof.riseM],
    ];
    counts.endWalls += pushExtrusion(sink, frame, wallSlot, wedge, unit.uLo, unit.uLo + GARAGE.endWallThicknessM);
    counts.endWalls += pushExtrusion(sink, frame, wallSlot, wedge, unit.uHi - GARAGE.endWallThicknessM, unit.uHi);

    // The ridge cap. In the WALL slot: `trim` would be a second non-free slot, and every garage
    // that carries an authored `roof` colour is darker on the roof than on the wall, so a
    // wall-coloured cap reads as the light line a ridge cap is.
    const capBase = wallHeadY + roof.riseM + thickness - GARAGE.ridgeCapBedM;
    const cap = [
      [roof.vRidge - GARAGE.ridgeCapHalfWidthM, capBase],
      [roof.vRidge + GARAGE.ridgeCapHalfWidthM, capBase],
      [roof.vRidge + GARAGE.ridgeCapHalfWidthM, capBase + GARAGE.ridgeCapProudM],
      [roof.vRidge - GARAGE.ridgeCapHalfWidthM, capBase + GARAGE.ridgeCapProudM],
    ];
    counts.ridgeCap += pushExtrusion(sink, frame, wallSlot, cap, u0, u1);
    return counts;
  }

  const vLow = roof.highSign > 0 ? unit.vLo : unit.vHi;
  const vHigh = roof.highSign > 0 ? unit.vHi : unit.vLo;
  const vLowOuter = vLow + (vLow < vHigh ? -1 : 1) * roof.overhangM;
  const vHighOuter = vHigh + (vHigh < vLow ? -1 : 1) * roof.overhangM;
  const section = [
    [vLowOuter, under(vLowOuter)],
    [vHighOuter, under(vHighOuter)],
    [vHighOuter, under(vHighOuter) + thickness],
    [vLowOuter, under(vLowOuter) + thickness],
  ];
  counts.slabs += pushExtrusion(sink, frame, roofSlot, section, u0, u1);

  const wedge = [
    [vLow, wallHeadY],
    [vHigh, wallHeadY],
    [vHigh, wallHeadY + roof.riseM],
  ];
  counts.endWalls += pushExtrusion(sink, frame, wallSlot, wedge, unit.uLo, unit.uLo + GARAGE.endWallThicknessM);
  counts.endWalls += pushExtrusion(sink, frame, wallSlot, wedge, unit.uHi - GARAGE.endWallThicknessM, unit.uHi);

  // The upstand: the high face's wall between the box top and the roof underside. Without it the
  // whole length of that face is an open slot into the roof void.
  const inward = vHigh < vLow ? 1 : -1;
  const upstand = [
    [vHigh, wallHeadY],
    [vHigh + inward * GARAGE.endWallThicknessM, wallHeadY],
    [vHigh + inward * GARAGE.endWallThicknessM, wallHeadY + roof.riseM],
    [vHigh, wallHeadY + roof.riseM],
  ];
  counts.upstand += pushExtrusion(sink, frame, wallSlot, upstand, unit.uLo, unit.uHi);
  return counts;
}

// --------------------------------------------------------------------------------------------- //
// The planner.
// --------------------------------------------------------------------------------------------- //

/**
 * Plan the detail for one garage block.
 *
 * Returns `null` for anything the router did not send here, which is a legitimate answer under the
 * contract and is how this planner stays a garage planner instead of drifting into a second router.
 *
 * WHAT VARIES BETWEEN THE TWELVE, AND WHAT DRIVES IT — all deterministic, none of it random:
 *
 *   roof form            authored `style` via the router (6 ridged, 6 mono-pitch)
 *   unit count / ridges  the lane merge measurement (11 buildings -> 1 unit, building 10 -> 2)
 *   ridge height, pitch  the unit's own span, bounded by the deck renderer's envelope
 *   bay count and pitch  the rank's own length (2 to 28 bays across the twelve)
 *   door faces           footprint depth: 1 face under 10 m, 2 above it
 *   which face           the terrain under each candidate face; the seed on flat ground
 *   blank bay            the seed, per rank
 *   roof colour          the authored `roof` field, via material slot 1 (present on 6 of the 12)
 */
export function planDetail(building, context) {
  validatePlannerContext(context);
  const { buildingIndex, classification, seat, groundYAt } = context;
  if (!classification || classification.archetype !== 'garage') return null;

  const ring = cleanRing(building?.poly);
  const metrics = classification.metrics;
  if (ring.length < 3 || !(metrics?.lengthM > 0)) return emptyDetailPlan(buildingIndex, 'garage');

  const heightM = num(classification.heightM, num(building?.height));
  const baseY = num(seat?.baseY);
  const wallHeadY = baseY + heightM;
  const seed = classification.seed >>> 0;

  const frame = obbFrame(ring, metrics.yawRad);
  const decomposition = decomposeUnits(frame);
  if (!decomposition.units.length) return emptyDetailPlan(buildingIndex, 'garage');

  const sink = makeSink(frame);
  const notes = [];
  const units = [];
  const ranks = [];
  const counts = { slabs: 0, endWalls: 0, ridgeCap: 0, upstand: 0, doors: 0 };

  for (const [unitIndex, unit] of decomposition.units.entries()) {
    // Which faces carry doors. A plan deep enough for two ranks opens on both outer long faces; a
    // single-rank plan opens downhill. An unmerged lane opens only on its OUTER face — the inner
    // one abuts the other lane, and putting doors there would be a rank opening into a wall.
    let doorFaces;
    let faceReason;
    if (decomposition.laneCount === 2 && decomposition.merged) {
      doorFaces = [{ faceSign: -1, vFace: decomposition.lanes[0].vLo }, { faceSign: +1, vFace: decomposition.lanes[1].vHi }];
      faceReason = 'depth:back-to-back-ranks';
    } else if (decomposition.laneCount === 2) {
      const outer = unit.laneIndices[0] === 0
        ? { faceSign: -1, vFace: unit.vLo }
        : { faceSign: +1, vFace: unit.vHi };
      doorFaces = [outer];
      faceReason = 'lane:outer-face';
    } else {
      const chosen = chooseDoorFace(frame, unit, groundYAt, seed);
      doorFaces = [{ faceSign: chosen.faceSign, vFace: chosen.vFace }];
      faceReason = chosen.reason;
    }

    // The mono-pitch high side is the door side: the doors need the headroom, and a lean-to cut
    // into a bank is low against the cut. With two door faces there is no single opening side, so
    // it falls back to the plan's own +v side, which is deterministic and never fires on Customs
    // (every double-rank garage here is `ridged`).
    const highSign = doorFaces.length === 1 ? doorFaces[0].faceSign : 1;
    const roof = planUnitRoof(unit, classification.roofForm, wallHeadY, heightM, highSign);
    if (!roof) {
      notes.push(`unit ${unitIndex}: span ${(unit.vHi - unit.vLo).toFixed(2)} m gives less than ${GARAGE.minRiseM} m of rise — no roof built`);
      continue;
    }
    const built = pushUnitRoof(sink, frame, unit, roof, wallHeadY);
    counts.slabs += built.slabs;
    counts.endWalls += built.endWalls;
    counts.ridgeCap += built.ridgeCap;
    counts.upstand += built.upstand;

    const unitRanks = [];
    for (const face of doorFaces) {
      // The rank runs along the LANE the face belongs to, so on a merged shed the doors follow the
      // lane's own end line and are not hung out over the 0.5 m jog.
      const lane = decomposition.laneCount === 2 && decomposition.merged
        ? decomposition.lanes[face.faceSign < 0 ? 0 : 1]
        : unit;
      const rank = planRank(lane.uLo, lane.uHi, face.faceSign, face.vFace, seed, heightM);
      if (!rank) continue;
      const yLo = baseY + GARAGE.doorSillLiftM;
      const yHi = yLo + rank.doorHeightM;
      const vDoor = rank.vFace + rank.faceSign * GARAGE.doorProudM;
      for (let bay = 0; bay < rank.bays; bay++) {
        if (bay === rank.blankBay) continue;
        const centre = rank.uStart + rank.bayPitchM * (bay + 0.5);
        const uA = centre - rank.doorWidthM / 2, uB = centre + rank.doorWidthM / 2;
        counts.doors += pushFace(
          sink, frame, MATERIAL_SLOT_INDEX.dark,
          [[uA, vDoor, yLo], [uB, vDoor, yLo], [uB, vDoor, yHi], [uA, vDoor, yHi]],
          [0, rank.faceSign, 0],
        );
      }
      unitRanks.push(rank);
      ranks.push({ unitIndex, ...rank });
    }

    units.push({
      index: unitIndex, ...unit, roof,
      wallHeadY, ridgeY: wallHeadY + roof.riseM,
      eaveLowY: wallHeadY - roof.overhangM * roof.slope,
      doorFaceCount: unitRanks.length,
      faceReason,
    });
  }

  if (!units.length) return emptyDetailPlan(buildingIndex, 'garage');

  // Groups in ascending slot order, which makes them sorted and contiguous by construction.
  const slots = [...sink.bySlot.keys()].sort((a, b) => a - b);
  const indices = [];
  const groups = [];
  for (const slot of slots) {
    const list = sink.bySlot.get(slot);
    groups.push({ start: indices.length, count: list.length, materialSlot: slot });
    indices.push(...list);
  }

  notes.push(
    `${units.length} unit(s) from ${decomposition.laneCount} lane(s); merge=${decomposition.merged}` +
      (decomposition.offsets ? ` (lane offsets ${decomposition.offsets.map((o) => o.toFixed(2)).join(' / ')} m vs ${GARAGE.laneMergeM} m)` : ''),
    `roof ${classification.roofForm}: ` + units.map((u) => `${u.roof.pitchDeg.toFixed(1)} deg rise ${u.roof.riseM.toFixed(2)} m${u.roof.cappedByEnvelope ? ' (capped by deck envelope)' : ''}`).join('; '),
    `${ranks.length} rank(s), ${ranks.reduce((sum, r) => sum + r.doorCount, 0)} doors, bay pitch ` +
      ranks.map((r) => r.bayPitchM.toFixed(2)).join(' / ') + ' m',
  );

  return {
    buildingIndex,
    archetype: 'garage',
    mesh: {
      positions: new Float32Array(sink.positions),
      indices: new Uint32Array(indices),
      groups,
    },
    instances: [],
    notes,
    /**
     * The structured plan behind the mesh. Not part of the contract — the renderer ignores it — but
     * it is what lets a test assert against the DECISION (this shed merged, that one did not, this
     * pitch came out at 11.2 degrees) instead of re-deriving the decision inside the test and
     * asserting that two copies of the same arithmetic agree.
     */
    garage: {
      frame: { yawRad: metrics.yawRad, uMin: frame.uMin, uMax: frame.uMax, vMin: frame.vMin, vMax: frame.vMax },
      depthM: frame.vMax - frame.vMin,
      laneCount: decomposition.laneCount,
      merged: decomposition.merged,
      laneOffsets: decomposition.offsets,
      lanes: decomposition.lanes,
      units,
      ranks,
      wallHeadY,
      baseY,
      riseCapM: ridgeRiseCap(heightM),
      triangles: {
        ...counts,
        total: Object.values(counts).reduce((sum, value) => sum + value, 0),
      },
      vertices: sink.vertexCount(),
    },
  };
}

export default planDetail;
