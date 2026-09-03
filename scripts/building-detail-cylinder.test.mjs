/**
 * The `cylinder` detail planner — fuel tanks and cooling towers.
 *
 * Asserted against the REAL six buildings the router sends here out of
 * `public/data/customs-3d.json` (rows 12, 13, 14, 15, 16, 19), seated with the REAL terrain
 * sampler at relief 1 AND relief 3, through the same `seatBuilding()` the renderer uses. Nothing
 * here is a fixture: a change to the shipped JSON, to the router, to the seat or to the terrain
 * moves these numbers.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS FILE HAS A MUTATION HARNESS
 *
 * Handoff §6 lists five occasions in one day on which this project reported success while
 * something had silently fallen back, and the rule that fell out is that an assertion which cannot
 * fail is worse than no assertion. Two of the assertions below are exactly the shape that goes
 * wrong: `T4` measures a geometric invariant against a tolerance, and `T5` compares a computed
 * altitude against an expectation. Both would be vacuous if the tolerance and the expectation were
 * read out of the module they are testing — mutate the constant, both sides move, green forever.
 *
 * So `SHELL_TUCK_ALLOWANCE_M`, `OUTWARD_ALLOWANCE_M`, `FOOT_EMBED_M`, `CROWN_MAX_FRAC_OF_HEIGHT`
 * and `MIN_TRIANGLE_AREA_M2` below are DELIBERATELY duplicated literals, not imports. That
 * duplication is the whole point and it must not be "tidied" into an import.
 *
 * Part 2 then proves the rest: it takes the shipped source text, applies one targeted mutation,
 * writes the mutant beside the real module (so its relative imports still resolve), imports it and
 * re-runs the entire assertion set against it. A mutation nothing catches is a failure, and a
 * mutation whose search string has drifted out of the source is a failure too, so the harness
 * cannot rot into a no-op.
 *
 * Run: `node --test scripts/building-detail-cylinder.test.mjs`
 */
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { classifyAll, orientedBoundingBox } from '../src/building-archetype.js';
import { seatBuilding } from '../src/buildings.js';
import { makeTerrainSampler } from '../src/three-world.js';
import {
  INSTANCED_FAMILIES,
  MATERIAL_SLOT_INDEX,
  PLANNER_CONTEXT_KEYS,
  planDrawCallDelta,
  validateDetailPlan,
} from '../src/building-detail/contract.js';
import {
  DRAWN_HEIGHT_TOLERANCE_M,
  fitPlanToHeight,
  heightFitScale,
  planDrawnTopY,
} from '../src/building-detail/assemble.js';
import * as cylinderModule from '../src/building-detail/cylinder.js';

const CYLINDER_SRC = new URL('../src/building-detail/cylinder.js', import.meta.url);

const customs3d = JSON.parse(await readFile(new URL('../public/data/customs-3d.json', import.meta.url), 'utf8'));
const BUILDINGS = customs3d.buildings;
const BUILDING_COUNT = BUILDINGS.length;
const classified = classifyAll(BUILDINGS);
const CYLINDER_ROWS = classified.byArchetype.cylinder;

// --------------------------------------------------------------------------------------------- //
// Independently restated constants. See the header: these are duplicated ON PURPOSE.
// --------------------------------------------------------------------------------------------- //

/** How far a vertex may tuck under the wall line. Duplicated so a mutation cannot move both sides. */
const SHELL_TUCK_ALLOWANCE_M = 0.1;
/**
 * How far anything may stand OUTSIDE the footprint. Bounded by the measured cluster: rows 12/14
 * and 13/14 already overlap by ~1.7 m, and a planner cannot see its neighbours.
 */
const OUTWARD_ALLOWANCE_M = 1.7;
/** How deep a ground-borne element is founded. Duplicated for the same reason. */
const FOOT_EMBED_M = 0.35;
/** The whole top assembly's share of the building's own height. Duplicated for the same reason. */
const CROWN_MAX_FRAC_OF_HEIGHT = 0.32;
/** Below this a triangle is a degenerate sliver, not geometry. */
const MIN_TRIANGLE_AREA_M2 = 0.05;
/**
 * Float32 quantisation, not slack.
 *
 * `mesh.positions` is a Float32Array and Customs' cylinders sit around x = 620 m, where a float32
 * step is ~6e-5 m. A 0.10 m tuck therefore measures back as 0.100025, and a bare `<= 0.1` compare
 * fails on arithmetic rather than on geometry. 1 mm is forty times the quantisation and a hundred
 * times smaller than the tuck it guards, so the `tuck-becomes-cut` mutation below still trips it.
 */
const FLOAT32_SLACK_M = 0.001;
/** Pinned so a silent re-route into or out of this archetype is loud here too. */
const EXPECTED_CYLINDER_ROWS = [12, 13, 14, 15, 16, 19];
/**
 * A tower that REPLACES its mass draws the whole building, so it may not lean on the neighbour
 * allowance above: nothing of it belongs outside the footprint the data states except the batter at
 * its foot. Measured: row 14 stands 0.043 m proud at its widest, row 19 0.196 m, both of them the
 * hyperbola's own continuation one metre below the base plane. 0.35 m is under a fifth of the
 * additive allowance and under a tenth of the 3.85 m an equal-AREA circle would have stood out by.
 */
const REPLACED_OUTWARD_ALLOWANCE_M = 0.35;

// ----- what "round" means, stated in numbers rather than in the word --------------------------- //
/**
 * These four decide the founder's actual complaint, so they are literals here and are read from
 * nothing. The claim is about the DRAWN horizontal section, measured off the geometry that ships:
 *
 *   vertices        a quad is four. Anything a person would call round has many.
 *   fill            polygon area over its own minimum-area bounding box. A rectangle is 1.000; any
 *                   ellipse — circular or not — is pi/4 = 0.7854, whatever its aspect. This is the
 *                   test that does NOT quietly demand a circle: rows 14 and 19 are 1.39:1 and
 *                   1.48:1 rectangles and their inscribed ellipses keep that proportion.
 *   turn            the exterior angle at the sharpest vertex. A rectangle turns 90 degrees at
 *                   every corner; a 16-gon turns 23.8, a 24-gon ellipse 22.1.
 *
 * Measured today: footprints 12/13/15/16 (16-gons) fill 0.794 / turn 23.8; the DRAWN sections of
 * rows 14 and 19 fill 0.783 / turn 20.9 and 22.1. Before this lane, rows 14 and 19 were 4 vertices,
 * fill 0.998 and 0.997, turn 90.0 — every one of the three fails.
 */
const SECTION_MIN_VERTICES = 12;
const SECTION_FILL_PI_OVER_4 = Math.PI / 4;
const SECTION_FILL_TOLERANCE = 0.05;
const SECTION_MAX_TURN_DEG = 30;

/**
 * The golden record, at relief 1. Every field is a decision this planner made from public data;
 * if any of them moves, either the data moved or a rule did, and both deserve a red test.
 *
 * `faces` is a census of triangle orientations — outward / inward / up / down by the dominant
 * component of each geometric normal. It is here because winding is the only thing deciding which
 * way a face points (the plan omits normals and the renderer computes them), and a whole emitter
 * flipped inside out changes nothing else that any other assertion measures.
 */
const EXPECTED = Object.freeze({
  12: {
    place: 'ZB-1011', family: 'tank', crownForm: 'cone', round: true, slenderness: 0.3,
    crownRiseM: 1.283, ventCount: 2, riserCount: 0, beaconCount: 0, railPostCount: 16,
    ladderVertex: 2, ventVertices: [7, 15], riserVertices: [],
    triangles: 176, vertices: 177,
    instances: { 'parapet-coping': 16, 'roof-stack': 2, downpipe: 1 },
    faces: { outward: 64, inward: 0, up: 80, down: 32 },
    massReplaced: false,
  },
  13: {
    place: 'Water Pump', family: 'tower', crownForm: 'open-rim', round: true, slenderness: 1.501,
    crownRiseM: 0, ventCount: 0, riserCount: 2, beaconCount: 1, railPostCount: 0,
    ladderVertex: 7, ventVertices: [], riserVertices: [9, 1],
    triangles: 192, vertices: 192,
    instances: { downpipe: 2, 'roof-stack': 1 },
    faces: { outward: 96, inward: 32, up: 32, down: 32 },
    massReplaced: false,
  },
  14: {
    place: 'Water Pump', family: 'tower', crownForm: 'hyperboloid-shell', round: false, slenderness: 2.261,
    crownRiseM: 0, ventCount: 0, riserCount: 0, beaconCount: 1, railPostCount: 0,
    ladderVertex: 1, ventVertices: [], riserVertices: [],
    // 48 foot + 9 x 48 shell = 480 outward, 5 x 48 interior = 240 inward, 48 rim + 24 deck = 72 up.
    triangles: 792, vertices: 793,
    instances: { 'roof-stack': 1 },
    faces: { outward: 480, inward: 240, up: 72, down: 0 },
    massReplaced: true, sectionSegments: 24,
    sectionSizeM: [13.558, 9.698], beaconSection: 18,
  },
  15: {
    place: null, family: 'tank', crownForm: 'dome', round: true, slenderness: 0.3,
    crownRiseM: 1.42, ventCount: 2, riserCount: 0, beaconCount: 0, railPostCount: 16,
    ladderVertex: 1, ventVertices: [6, 14], riserVertices: [],
    triangles: 240, vertices: 241,
    instances: { 'parapet-coping': 16, 'roof-stack': 2, downpipe: 1 },
    faces: { outward: 64, inward: 0, up: 144, down: 32 },
    massReplaced: false,
  },
  16: {
    place: 'Streamer House', family: 'tank', crownForm: 'dome', round: true, slenderness: 0.301,
    crownRiseM: 1.462, ventCount: 2, riserCount: 0, beaconCount: 0, railPostCount: 16,
    ladderVertex: 7, ventVertices: [14, 6], riserVertices: [],
    triangles: 240, vertices: 241,
    instances: { 'parapet-coping': 16, 'roof-stack': 2, downpipe: 1 },
    faces: { outward: 64, inward: 0, up: 144, down: 32 },
    massReplaced: false,
  },
  19: {
    place: 'Water Pump', family: 'tower', crownForm: 'hyperboloid-shell', round: false, slenderness: 1.353,
    crownRiseM: 0, ventCount: 0, riserCount: 0, beaconCount: 1, railPostCount: 0,
    ladderVertex: 0, ventVertices: [], riserVertices: [],
    triangles: 792, vertices: 793,
    instances: { 'roof-stack': 1 },
    faces: { outward: 480, inward: 240, up: 72, down: 0 },
    massReplaced: true, sectionSegments: 24,
    sectionSizeM: [23.608, 15.889], beaconSection: 23,
  },
});

/** The two rows whose mass this planner now draws itself. Everything else stays additive detail. */
const EXPECTED_REPLACED_ROWS = [14, 19];

const EXPECTED_TOTAL_TRIANGLES = 2432;
const EXPECTED_TOTAL_INSTANCES = 62;
/**
 * `roof-vent` is gone. It carried the induced-draught fan cowls of the MECHANICAL-DRAFT reading of
 * a rectangular tower, and a natural-draught hyperbolic shell has no fans — the shape is the
 * draught. Rows 14 and 19 were the archetype's only source of that family.
 */
const EXPECTED_FAMILIES = ['downpipe', 'parapet-coping', 'roof-stack'];

// --------------------------------------------------------------------------------------------- //
// Harness. Everything a planner needs, built from the real terrain and the real seat function.
// --------------------------------------------------------------------------------------------- //

const samplerFor = (relief) => makeTerrainSampler(customs3d.terrain, relief);

/**
 * `seatBuilding()` returns the renderer's field names (`base`, `contact`, `lo`, ...); the planner
 * contract names them `baseY`, `contactY`, `loY`, ... This is the one adapter, written once.
 */
function contextFor(index, relief) {
  const building = BUILDINGS[index];
  const groundYAt = samplerFor(relief);
  const seat = seatBuilding(building, groundYAt);
  return {
    buildingIndex: index,
    classification: classified.assignments[index],
    seat: {
      baseY: seat.base,
      contactY: seat.contact,
      loY: seat.lo,
      hiY: seat.hi,
      plinthBaseY: seat.plinthBase,
      plinthHeightM: seat.plinthHeight,
    },
    groundYAt,
  };
}

const planAll = (mod, relief = 1) =>
  CYLINDER_ROWS.map((index) => mod.planDetail(BUILDINGS[index], contextFor(index, relief)));

/** Triangle-orientation census. A test instrument, deliberately not shipped in the module. */
function faceCensus(plan) {
  const tally = { outward: 0, inward: 0, up: 0, down: 0 };
  const P = plan.mesh.positions;
  const I = plan.mesh.indices;
  const centreX = -plan.spec.centre[0];
  const centreY = -plan.spec.centre[1];
  for (let i = 0; i < I.length; i += 3) {
    const a = I[i] * 3;
    const b = I[i + 1] * 3;
    const c = I[i + 2] * 3;
    const ux = P[b] - P[a];
    const uy = P[b + 1] - P[a + 1];
    const uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a];
    const vy = P[c + 1] - P[a + 1];
    const vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length; ny /= length; nz /= length;
    const gx = (P[a] + P[b] + P[c]) / 3 - centreX;
    const gy = (P[a + 1] + P[b + 1] + P[c + 1]) / 3 - centreY;
    const radial = Math.hypot(gx, gy) || 1;
    const outwardness = (nx * gx + ny * gy) / radial;
    if (Math.abs(outwardness) >= Math.abs(nz)) tally[outwardness > 0 ? 'outward' : 'inward'] += 1;
    else tally[nz > 0 ? 'up' : 'down'] += 1;
  }
  return tally;
}

/** Every directed edge, so a shared edge traversed the same way twice can be spotted. */
function inconsistentSharedEdges(mesh) {
  const seen = new Set();
  const bad = [];
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const tri = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]];
    for (let k = 0; k < 3; k++) {
      const key = `${tri[k]}>${tri[(k + 1) % 3]}`;
      if (seen.has(key)) bad.push(key);
      seen.add(key);
    }
  }
  return bad;
}

const roundTo = (value, places) => Number(value.toFixed(places));

// --------------------------------------------------------------------------------------------- //
// The roundness instrument. It lives HERE, not in the module, on purpose: Part 2 rewrites the
// module's source and re-runs every assertion against the mutant, so an instrument that shipped
// inside `cylinder.js` could be weakened by the very mutation it is supposed to catch.
// --------------------------------------------------------------------------------------------- //

/** Andrew's monotone chain. Collinear points are dropped, so a facet count is a real facet count. */
function convexHull(points) {
  if (points.length < 3) return [];
  const sorted = points.slice().sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list) => {
    const out = [];
    for (const point of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], point) <= 1e-7) out.pop();
      out.push(point);
    }
    out.pop();
    return out;
  };
  const hull = [...half(sorted), ...half(sorted.slice().reverse())];
  return hull.length >= 3 ? hull : [];
}

/**
 * The horizontal section this MESH draws at height `y`: every distinct vertex within `toleranceM`
 * of that level, hulled. Read straight off `mesh.positions`, which is the buffer that ships.
 */
function meshSectionAt(mesh, y, toleranceM = 0.02) {
  const seen = new Set();
  const points = [];
  for (let index = 0; index < mesh.positions.length; index += 3) {
    if (Math.abs(mesh.positions[index + 2] - y) > toleranceM) continue;
    const x = mesh.positions[index];
    const z = mesh.positions[index + 1];
    const key = `${Math.round(x * 1000)}:${Math.round(z * 1000)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    points.push([x, z]);
  }
  return convexHull(points);
}

const ringArea = (ring) => {
  let twice = 0;
  for (let index = 0; index < ring.length; index++) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[(index + 1) % ring.length];
    twice += x1 * y2 - x2 * y1;
  }
  return Math.abs(twice) / 2;
};

/** The sharpest exterior angle in a ring, in degrees. A rectangle is 90; a regular 24-gon is 15. */
function maxTurnDeg(ring) {
  let worst = 0;
  const n = ring.length;
  for (let index = 0; index < n; index++) {
    const a = ring[(index - 1 + n) % n];
    const b = ring[index];
    const c = ring[(index + 1) % n];
    const first = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const second = Math.atan2(c[1] - b[1], c[0] - b[0]);
    let delta = Math.abs(second - first);
    if (delta > Math.PI) delta = 2 * Math.PI - delta;
    worst = Math.max(worst, delta);
  }
  return (worst * 180) / Math.PI;
}

/**
 * Is this closed ring round? Three independent readings, all of them aspect-agnostic, so a 1.48:1
 * ellipse passes and a 1.0:1 square does not.
 */
function roundnessOf(ring) {
  const box = orientedBoundingBox(ring.map(([x, z]) => [x, z]));
  const boxArea = box.lengthM * box.widthM;
  return {
    vertices: ring.length,
    fill: boxArea > 1e-9 ? ringArea(ring) / boxArea : 1,
    turnDeg: maxTurnDeg(ring),
    lengthM: box.lengthM,
    widthM: box.widthM,
  };
}

function assertRound(reading, label) {
  assert.ok(
    reading.vertices >= SECTION_MIN_VERTICES,
    `${label}: the drawn section has ${reading.vertices} sides, and ${SECTION_MIN_VERTICES} is the fewest anything round has`,
  );
  assert.ok(
    Math.abs(reading.fill - SECTION_FILL_PI_OVER_4) <= SECTION_FILL_TOLERANCE,
    `${label}: the section fills ${reading.fill.toFixed(4)} of its own bounding box; an ellipse fills `
    + `${SECTION_FILL_PI_OVER_4.toFixed(4)} and a rectangle fills 1.0000`,
  );
  assert.ok(
    reading.turnDeg <= SECTION_MAX_TURN_DEG,
    `${label}: the section turns ${reading.turnDeg.toFixed(1)} degrees at its sharpest corner, cap ${SECTION_MAX_TURN_DEG} (a rectangle turns 90)`,
  );
}

// --------------------------------------------------------------------------------------------- //
// Part 1 — the assertion set. Each runs against a module namespace so it can be re-run against a
// deliberately broken copy below.
// --------------------------------------------------------------------------------------------- //

const ASSERTIONS = [
  {
    id: 'T1-contract',
    run(mod) {
      for (const [ordinal, plan] of planAll(mod).entries()) {
        const index = CYLINDER_ROWS[ordinal];
        assert.ok(plan, `row ${index} produced no plan`);
        validateDetailPlan(plan, { buildingCount: BUILDING_COUNT, archetype: 'cylinder' });
        assert.equal(plan.buildingIndex, index);
      }
    },
  },
  {
    id: 'T2-owns-only-cylinders',
    run(mod) {
      assert.deepEqual(CYLINDER_ROWS, EXPECTED_CYLINDER_ROWS);
      for (let index = 0; index < BUILDING_COUNT; index++) {
        const plan = mod.planDetail(BUILDINGS[index], contextFor(index, 1));
        const isCylinder = CYLINDER_ROWS.includes(index);
        if (isCylinder) assert.ok(plan && plan.mesh, `row ${index} is a cylinder and must get a mesh`);
        else assert.equal(plan, null, `row ${index} is not a cylinder and must get null`);
      }
    },
  },
  {
    id: 'T3-non-degenerate',
    run(mod) {
      for (const plan of planAll(mod)) {
        const { positions, indices } = plan.mesh;
        assert.ok(positions.length > 0 && indices.length > 0);
        for (const value of positions) assert.ok(Number.isFinite(value), 'a position is not finite');
        const smallest = mod.minTriangleAreaM2(plan.mesh);
        assert.ok(
          smallest >= MIN_TRIANGLE_AREA_M2,
          `row ${plan.buildingIndex}: smallest triangle is ${smallest.toFixed(4)} m2, below ${MIN_TRIANGLE_AREA_M2}`,
        );
      }
      // Relief 3 stretches the terrain threefold and is where a sliver would appear if one could.
      for (const plan of planAll(mod, 3)) {
        assert.ok(mod.minTriangleAreaM2(plan.mesh) >= MIN_TRIANGLE_AREA_M2, 'sliver at relief 3');
      }
    },
  },
  {
    id: 'T4-additive-invariant',
    run(mod) {
      for (const relief of [1, 3]) {
        for (const plan of planAll(mod, relief)) {
          const audit = mod.cylinderVertexAudit(plan);
          const replaced = plan.replacesMass === true;
          assert.equal(audit.massReplaced, replaced, `row ${plan.buildingIndex}: the audit and the plan disagree about who draws the mass`);
          assert.equal(replaced, EXPECTED_REPLACED_ROWS.includes(plan.buildingIndex),
            `row ${plan.buildingIndex}: the set of rows that replace their mass moved`);
          if (!replaced) {
            // The additive rule, and it applies ONLY where an extrusion is still drawn underneath.
            assert.ok(
              audit.worstInsetM <= SHELL_TUCK_ALLOWANCE_M + FLOAT32_SLACK_M,
              `row ${plan.buildingIndex} @relief ${relief}: reaches ${audit.worstInsetM.toFixed(3)} m INSIDE the shell prism, allowance ${SHELL_TUCK_ALLOWANCE_M}`,
            );
            assert.ok(
              audit.worstOutsetM <= OUTWARD_ALLOWANCE_M + FLOAT32_SLACK_M,
              `row ${plan.buildingIndex} @relief ${relief}: reaches ${audit.worstOutsetM.toFixed(3)} m OUTSIDE the footprint, allowance ${OUTWARD_ALLOWANCE_M} (the cluster's own clearance is negative)`,
            );
            continue;
          }
          // A replaced tower draws the whole building, so it gets the TIGHTER rule, not an exemption:
          // it may not leave the footprint the data states except for the batter at its foot.
          assert.ok(
            audit.worstOutsetM <= REPLACED_OUTWARD_ALLOWANCE_M + FLOAT32_SLACK_M,
            `row ${plan.buildingIndex} @relief ${relief}: the replaced shell stands ${audit.worstOutsetM.toFixed(3)} m OUTSIDE its own footprint, allowance ${REPLACED_OUTWARD_ALLOWANCE_M}`,
          );
          // ...and it must genuinely be inside, not merely not-outside: an ellipse inscribed in a
          // rectangle stands well inside it at the corners, and a section that did not would be a
          // rectangle again. Row 14 measures 6.98 m, row 19 8.67 m.
          assert.ok(
            audit.worstInsetM > 1,
            `row ${plan.buildingIndex}: the replaced shell never gets more than ${audit.worstInsetM.toFixed(3)} m inside its own rectangle — that is a box, not a section`,
          );
        }
      }
    },
  },
  {
    id: 'T5-seated',
    run(mod) {
      for (const relief of [1, 3]) {
        const groundYAt = samplerFor(relief);
        for (const [ordinal, plan] of planAll(mod, relief).entries()) {
          const index = CYLINDER_ROWS[ordinal];
          const context = contextFor(index, relief);
          const audit = mod.cylinderVertexAudit(plan);
          // ONE seating rule for all three paths: the foot's bottom is FOOT_EMBED_M under the
          // lowest ground beneath `spec.footRing` — the pad ring on a tank, the battered flare on a
          // dressed tower, the hyperbola continued below the base plane on a replaced one.
          const footRing = plan.spec.footRing;
          assert.ok(footRing.length >= 3, `row ${index}: no foot ring to found the building on`);
          const lowestGround = Math.min(...footRing.map(([x, z]) => groundYAt(x, z)));
          assert.ok(
            Math.abs(audit.lowestY - (lowestGround - FOOT_EMBED_M)) <= 0.02,
            `row ${index} @relief ${relief}: foot at ${audit.lowestY.toFixed(3)}, expected ${(lowestGround - FOOT_EMBED_M).toFixed(3)} (lowest ground under the foot ring minus ${FOOT_EMBED_M} m)`,
          );
          assert.ok(
            audit.lowestY < context.seat.baseY,
            `row ${index}: the foot must reach BELOW the wall base or the downhill gap stays open`,
          );
          if (plan.replacesMass === true) {
            // A replaced tower has no extrusion to stand above: it draws the WHOLE building, so its
            // highest vertex must BE the data height — reaching it, and not a millimetre past it.
            assert.ok(
              Math.abs(audit.highestY - (context.seat.baseY + plan.spec.heightM)) <= FLOAT32_SLACK_M,
              `row ${index} @relief ${relief}: the shell tops out at ${audit.highestY.toFixed(4)}, and its data height is ${(context.seat.baseY + plan.spec.heightM).toFixed(4)}`,
            );
          } else {
            assert.ok(
              audit.highestY > context.seat.baseY + plan.spec.heightM,
              `row ${index}: nothing was added above the shell top`,
            );
          }
        }
      }
    },
  },
  {
    id: 'T6-height-honesty',
    run(mod) {
      for (const plan of planAll(mod)) {
        const audit = mod.cylinderVertexAudit(plan);
        const share = audit.crownRiseAboveShellM / plan.spec.heightM;
        assert.ok(
          share <= CROWN_MAX_FRAC_OF_HEIGHT + FLOAT32_SLACK_M,
          `row ${plan.buildingIndex}: the top assembly adds ${(share * 100).toFixed(1)}% of the building height, cap ${(CROWN_MAX_FRAC_OF_HEIGHT * 100)}%`,
        );
        if (plan.replacesMass === true) {
          // Nothing is dressed on top of a replaced shell at all — it IS the building, and the
          // 1.4 m rim the dressed tower puts above its cap would be a 1.4 m height increase here.
          assert.ok(
            Math.abs(audit.crownRiseAboveShellM) <= FLOAT32_SLACK_M,
            `row ${plan.buildingIndex}: the replaced shell draws ${audit.crownRiseAboveShellM.toFixed(4)} m above its own top`,
          );
        }
        // Heights are a standing decision: the planner reads `height` and never writes it.
        assert.equal(plan.spec.heightM, BUILDINGS[plan.buildingIndex].height);
      }
    },
  },
  {
    id: 'T7-variation',
    run(mod) {
      const specs = new Map();
      for (const plan of planAll(mod)) {
        const expected = EXPECTED[plan.buildingIndex];
        const spec = plan.spec;
        specs.set(plan.buildingIndex, spec);
        const actual = {
          place: spec.ring.length ? (BUILDINGS[plan.buildingIndex].place ?? BUILDINGS[plan.buildingIndex].name ?? null) : null,
          family: spec.family,
          crownForm: spec.crownForm,
          round: spec.round,
          slenderness: roundTo(spec.slenderness, 3),
          crownRiseM: roundTo(spec.crownRiseM, 3),
          ventCount: spec.ventCount,
          riserCount: spec.riserCount,
          beaconCount: spec.beaconCount,
          railPostCount: spec.railPostCount,
          ladderVertex: spec.ladderVertex,
          ventVertices: [...spec.ventVertices],
          riserVertices: [...spec.riserVertices],
          triangles: plan.stats.triangles,
          vertices: plan.stats.vertices,
          instances: Object.fromEntries(plan.instances.map((family) => [family.familyId, family.count])),
          faces: faceCensus(plan),
          massReplaced: spec.massReplaced,
          ...(spec.massReplaced ? {
            sectionSegments: spec.sectionSegments,
            sectionSizeM: [roundTo(spec.sectionSemiLengthM * 2, 3), roundTo(spec.sectionSemiWidthM * 2, 3)],
            beaconSection: spec.beaconSection,
          } : {}),
        };
        assert.deepEqual(actual, expected, `row ${plan.buildingIndex} drifted from the golden record`);
      }
      // The point of the archetype, stated as a property rather than a table: identical treatment
      // on six drums would satisfy every other assertion in this file.
      const tanks = [12, 15, 16].map((index) => specs.get(index));
      assert.equal(new Set(tanks.map((spec) => spec.crownForm)).size > 1, true,
        'all three tanks got the same crown — the variation rule is dead');
      assert.equal(new Set(tanks.map((spec) => spec.ladderVertex)).size, 3,
        'the three tanks put their ladder on the same vertex');
      // The two replaced towers are the same FORM by design — both are natural-draught shells — so
      // the variation that has to survive is dimensional and stationed, and it comes from the two
      // places it should: the footprint's own OBB, and the seed.
      assert.notDeepEqual(
        [specs.get(14).sectionSemiLengthM, specs.get(14).sectionSemiWidthM],
        [specs.get(19).sectionSemiLengthM, specs.get(19).sectionSemiWidthM],
        'the two replaced towers derived the same section from different rectangles',
      );
      assert.notEqual(specs.get(14).beaconSection, specs.get(19).beaconSection,
        'the two replaced towers put their beacon on the same azimuth');
      // ...and the ellipse must be the footprint's OWN proportion, not a circle wearing its area:
      // 13.86 x 10.00 and 23.91 x 16.19 are 1.386:1 and 1.477:1 boxes and the sections keep that.
      for (const index of EXPECTED_REPLACED_ROWS) {
        const spec = specs.get(index);
        const box = orientedBoundingBox(BUILDINGS[index].poly.map(([x, z]) => [x, z]));
        assert.ok(
          Math.abs((spec.sectionSemiLengthM / spec.sectionSemiWidthM) - (box.lengthM / box.widthM)) < 0.06,
          `row ${index}: the section's aspect ${(spec.sectionSemiLengthM / spec.sectionSemiWidthM).toFixed(3)} `
          + `is not the footprint's ${(box.lengthM / box.widthM).toFixed(3)} — it stopped being derived from the OBB`,
        );
      }
      assert.notEqual(specs.get(13).crownForm, specs.get(14).crownForm,
        'the round tower and the rectangular tower got the same crown');
      assert.equal(specs.get(13).massReplaced, false,
        'the ONE cooling tower whose footprint really is a 16-gon must keep its extruded mass');
    },
  },
  {
    id: 'T8-deterministic',
    run(mod) {
      const first = planAll(mod);
      const second = planAll(mod);
      for (const [ordinal, plan] of first.entries()) {
        assert.deepEqual(Array.from(plan.mesh.positions), Array.from(second[ordinal].mesh.positions),
          `row ${plan.buildingIndex}: two identical calls produced different geometry`);
        assert.deepEqual(Array.from(plan.mesh.indices), Array.from(second[ordinal].mesh.indices));
      }
      // FORM may not depend on the relief slider — only altitudes may.
      const flat = planAll(mod, 1);
      const steep = planAll(mod, 3);
      for (const [ordinal, plan] of flat.entries()) {
        const other = steep[ordinal];
        assert.equal(plan.stats.triangles, other.stats.triangles, 'triangle count changed with relief');
        assert.equal(plan.spec.crownForm, other.spec.crownForm, 'crown form changed with relief');
        assert.equal(plan.spec.ladderVertex, other.spec.ladderVertex, 'a station moved with relief');
        assert.deepEqual(
          plan.instances.map((family) => [family.familyId, family.count]),
          other.instances.map((family) => [family.familyId, family.count]),
        );
      }
    },
  },
  {
    id: 'T9-cost',
    run(mod) {
      const plans = planAll(mod);
      const delta = planDrawCallDelta(plans);
      assert.equal(delta.perBuildingGroups, 0,
        'the cylinder mesh must use only the wall and roof slots the building already pays for');
      assert.equal(delta.worstPerBuilding, 0);
      assert.equal(delta.instancedFamilies, EXPECTED_FAMILIES.length);
      assert.equal(delta.total, EXPECTED_FAMILIES.length);
      assert.ok(delta.withinBudget);
      assert.ok(delta.framePct < 0.5, `draw-call delta is ${delta.framePct.toFixed(2)}% of the frame`);
      const slots = new Set(plans.flatMap((plan) => plan.mesh.groups.map((group) => group.materialSlot)));
      assert.deepEqual([...slots].sort(), [MATERIAL_SLOT_INDEX.wall, MATERIAL_SLOT_INDEX.roof].sort());
      const triangles = plans.reduce((sum, plan) => sum + plan.stats.triangles, 0);
      assert.equal(triangles, EXPECTED_TOTAL_TRIANGLES);
      const instances = plans.reduce(
        (sum, plan) => sum + plan.instances.reduce((count, family) => count + family.count, 0), 0);
      assert.equal(instances, EXPECTED_TOTAL_INSTANCES);
      const families = new Set(plans.flatMap((plan) => plan.instances.map((family) => family.familyId)));
      assert.deepEqual([...families].sort(), EXPECTED_FAMILIES);
    },
  },
  {
    id: 'T10-look-rejected',
    run(mod) {
      const context = contextFor(12, 1);
      assert.throws(
        () => mod.planDetail(BUILDINGS[12], { ...context, look: 'realistic' }),
        /forbidden/,
        'a planner that accepts the look flip can move a vertex when the skin changes',
      );
      assert.throws(() => mod.planDetail(BUILDINGS[12], { ...context, relief: 3 }), /forbidden/);
      const { groundYAt, ...withoutSampler } = context;
      assert.throws(() => mod.planDetail(BUILDINGS[12], withoutSampler), /missing required key/);
      assert.deepEqual([...PLANNER_CONTEXT_KEYS].sort(),
        ['buildingIndex', 'classification', 'groundYAt', 'seat']);
    },
  },
  {
    id: 'T11-face-orientation',
    run(mod) {
      for (const plan of planAll(mod)) {
        assert.deepEqual(faceCensus(plan), EXPECTED[plan.buildingIndex].faces,
          `row ${plan.buildingIndex}: a face is pointing the wrong way`);
        assert.deepEqual(inconsistentSharedEdges(plan.mesh), [],
          `row ${plan.buildingIndex}: two triangles share a directed edge — the strip is inside out`);
      }
    },
  },
  {
    id: 'T12-instance-prototype',
    run(mod) {
      for (const plan of planAll(mod)) {
        const context = contextFor(plan.buildingIndex, 1);
        for (const family of plan.instances) {
          assert.ok(family.familyId in INSTANCED_FAMILIES, `${family.familyId} is not registered`);
          assert.ok(family.count <= INSTANCED_FAMILIES[family.familyId].maxPerBuilding);
          // The shared unit box: centred in x and y, foot at z = 0, apex at z = 1. A planner that
          // centres z instead half-buries every instance it shares a family with.
          const P = family.prototype.positions;
          let minX = Infinity; let maxX = -Infinity;
          let minZ = Infinity; let maxZ = -Infinity;
          for (let i = 0; i < P.length; i += 3) {
            minX = Math.min(minX, P[i]); maxX = Math.max(maxX, P[i]);
            minZ = Math.min(minZ, P[i + 2]); maxZ = Math.max(maxZ, P[i + 2]);
          }
          assert.equal(minX, -0.5); assert.equal(maxX, 0.5);
          assert.equal(minZ, 0, `${family.familyId}: the prototype's foot must sit at z = 0`);
          assert.equal(maxZ, 1, `${family.familyId}: the prototype must be one metre tall`);
          assert.equal(family.prototype.groups, undefined);
          // `levelAboveBaseM` must be the instance's own height above ITS OWNER's base, not an
          // absolute world altitude: `fitPlanToHeight()` rescales it about that base.
          for (let i = 0; i < family.count; i++) {
            assert.equal(family.ownerIndex[i], plan.buildingIndex);
            assert.ok(
              Math.abs(family.levelAboveBaseM[i] - (family.offsets[i * 3 + 2] - context.seat.baseY)) < 1e-4,
              `${family.familyId}[${i}]: levelAboveBaseM does not match its own world height`,
            );
            assert.ok(family.levelAboveBaseM[i] > -1, 'an instance is buried below its building');
          }
        }
      }
    },
  },
  {
    id: 'T13-drawn-section-is-round',
    /**
     * The founder's complaint, as an assertion: "two 30 m cooling towers are rectangular boxes".
     *
     * What is on screen at a given height is the union of what the RENDERER extrudes and what this
     * planner draws, and which of the two owns a row is exactly `plan.replacesMass`. So the section
     * is read from the right source per row and never from a flag alone:
     *
     *   mass kept       the renderer extrudes `building.poly`, so the drawn section IS the authored
     *                   footprint at every height between base and eave. All four are 16-gons.
     *   mass replaced   the renderer extrudes nothing, so the drawn section is whatever this plan's
     *                   own `mesh.positions` contains at that height — measured at the springing,
     *                   at the fill deck and at the rim, the three levels the shell's whole profile
     *                   passes through.
     */
    run(mod) {
      let replacedChecked = 0;
      for (const plan of planAll(mod)) {
        const index = plan.buildingIndex;
        const context = contextFor(index, 1);
        if (plan.replacesMass !== true) {
          const footprint = BUILDINGS[index].poly.map(([x, z]) => [x, z]);
          assertRound(roundnessOf(footprint), `row ${index} (extruded footprint)`);
          continue;
        }
        const heightM = plan.spec.heightM;
        for (const [name, t] of [['springing', 0], ['fill deck', 4 / 9], ['rim', 1]]) {
          const section = meshSectionAt(plan.mesh, context.seat.baseY + heightM * t);
          const reading = roundnessOf(section);
          assertRound(reading, `row ${index} at the ${name} (${(t * 100).toFixed(0)}% of ${heightM} m)`);
          // ...and it must be a real 30 m object, not a round thing three metres across: the
          // section may never be wider than the rectangle it came out of, and the springing must
          // still be within a metre of it on both axes.
          const box = orientedBoundingBox(BUILDINGS[index].poly.map(([x, z]) => [x, z]));
          assert.ok(reading.lengthM <= box.lengthM + FLOAT32_SLACK_M && reading.widthM <= box.widthM + FLOAT32_SLACK_M,
            `row ${index} at the ${name}: ${reading.lengthM.toFixed(2)} x ${reading.widthM.toFixed(2)} m is outside the ${box.lengthM.toFixed(2)} x ${box.widthM.toFixed(2)} m footprint`);
          if (t === 0) {
            assert.ok(reading.lengthM > box.lengthM - 1 && reading.widthM > box.widthM - 1,
              `row ${index}: the shell springs from ${reading.lengthM.toFixed(2)} x ${reading.widthM.toFixed(2)} m inside a ${box.lengthM.toFixed(2)} x ${box.widthM.toFixed(2)} m footprint — it threw the building away to become round`);
          }
          replacedChecked += 1;
        }
        // The waist, which is the other half of "a cooling tower is a hyperboloid": the throat must
        // actually be narrower than the springing, or this is a round tube with a fancy note.
        const springing = roundnessOf(meshSectionAt(plan.mesh, context.seat.baseY));
        const throat = roundnessOf(meshSectionAt(
          plan.mesh, context.seat.baseY + heightM * plan.spec.throatHeightFrac, heightM / plan.spec.shellRings / 2));
        assert.ok(
          throat.widthM < springing.widthM * 0.75,
          `row ${index}: the throat is ${throat.widthM.toFixed(2)} m across against a ${springing.widthM.toFixed(2)} m springing — no waist`,
        );
      }
      assert.equal(replacedChecked, EXPECTED_REPLACED_ROWS.length * 3,
        'the section probe did not run on every replaced row at every level');
    },
  },
  {
    id: 'T14-fits-its-data-height',
    /**
     * Containment, measured through the REAL fit in `assemble.js` rather than at the planner's own
     * output, because that is what the renderer draws. Two claims, and the second is the one that
     * would otherwise hide a defect: a replaced tower that overshot its height would be silently
     * SQUASHED by the fit into a shorter, fatter tower and every other assertion here would stay
     * green. So its fit scale must be exactly 1 — it is built to fit, not fitted.
     */
    run(mod) {
      for (const plan of planAll(mod)) {
        const index = plan.buildingIndex;
        const { seat } = contextFor(index, 1);
        const heightM = plan.spec.heightM;
        const replaced = plan.replacesMass === true;
        const scale = heightFitScale(plan, seat.baseY, heightM, { replacesMass: replaced });
        const fitted = fitPlanToHeight(plan, seat.baseY, scale);
        const top = Math.max(planDrawnTopY(fitted), replaced ? -Infinity : seat.baseY + heightM * scale);
        assert.ok(
          top - (seat.baseY + heightM) <= DRAWN_HEIGHT_TOLERANCE_M,
          `row ${index}: after the fit it still draws ${(top - (seat.baseY + heightM)).toFixed(4)} m above its ${heightM} m data height`,
        );
        if (replaced) {
          assert.equal(scale, 1,
            `row ${index}: the replaced shell needed a ${scale.toFixed(4)} squash to fit its own height — it was built too tall and the fit hid it`);
          assert.ok(
            Math.abs(top - (seat.baseY + heightM)) <= DRAWN_HEIGHT_TOLERANCE_M,
            `row ${index}: the shell tops out ${(seat.baseY + heightM - top).toFixed(3)} m SHORT of its data height`,
          );
        }
      }
    },
  },
];

for (const assertion of ASSERTIONS) {
  test(`cylinder planner ${assertion.id}`, () => assertion.run(cylinderModule));
}

// --------------------------------------------------------------------------------------------- //
// Part 2 — proof that each assertion discriminates.
// --------------------------------------------------------------------------------------------- //

/**
 * Mutants are written BESIDE the real module, not into a temp directory: this module imports
 * `../three-world.js` and `./contract.js` by relative path, and a copy anywhere else resolves
 * neither. The names are dot-prefixed and removed in `test.after`.
 */
const SRC_DIR = fileURLToPath(new URL('../src/building-detail/', import.meta.url));
const SOURCE = await readFile(CYLINDER_SRC, 'utf8');
const written = [];
test.after(() => Promise.all(written.map((file) => rm(file, { force: true }))));

async function loadMutant(id, find, replace) {
  assert.ok(
    SOURCE.includes(find),
    `MUTATION HARNESS ROTTED: "${id}" searches for a string that is no longer in src — ${JSON.stringify(find.slice(0, 100))}`,
  );
  const mutated = SOURCE.replace(find, replace);
  assert.notEqual(mutated, SOURCE, `mutation "${id}" changed nothing`);
  const file = `${SRC_DIR}.tz-cylinder-mutant-${id}.mjs`;
  written.push(file);
  await writeFile(file, mutated, 'utf8');
  return import(pathToFileURL(file).href);
}

/** Which assertions reject this module. An assertion that throws is an assertion that caught it. */
function caughtBy(mod) {
  return ASSERTIONS.filter((assertion) => {
    try {
      assertion.run(mod);
      return false;
    } catch {
      return true;
    }
  }).map((assertion) => assertion.id);
}

const MUTATIONS = [
  {
    id: 'flare-inverted', expect: 'T4-additive-invariant',
    doc: 'batter the tower foot INWARD, hiding it inside the shell prism it can never cut',
    find: '    addWall(B, SLOT.wall, flareRing, flareBottomY, ring, flareTopY);',
    replace: '    addWall(B, SLOT.wall, offsetRing(ring, centre, -1.5), flareBottomY, ring, flareTopY);',
  },
  {
    id: 'flare-swallows-neighbours', expect: 'T4-additive-invariant',
    doc: 'grow the battered foot to 10 m, which would swallow the two towers 15 m away',
    find: '  flareOutFrac: 0.14,\n  flareOutMaxM: 1.2,',
    replace: '  flareOutFrac: 0.9,\n  flareOutMaxM: 12,',
  },
  {
    id: 'foot-floats', expect: 'T5-seated',
    doc: 'park the foot 0.6 m above the ground instead of founding it in the earth',
    find: '  footEmbedM: 0.35,',
    replace: '  footEmbedM: -0.6,',
  },
  {
    id: 'seat-ignored', expect: 'T5-seated',
    doc: 'ignore the seat and build every cylinder at world zero — the classic silent fallback',
    find: '  const baseY = num(seat?.baseY, NaN);',
    replace: '  const baseY = 0 * num(seat?.baseY, NaN) + 0;',
  },
  {
    id: 'crown-unclamped', expect: 'T6-height-honesty',
    doc: 'let the crown triple, so a 6 m tank wears a 4.4 m roof and reads as a 10 m building',
    find: '    ? Math.min(radiusM * riseFrac * jitter, heightM * C.crownMaxRiseFracOfHeight - C.curbLipM)',
    replace: '    ? radiusM * riseFrac * jitter * 3',
  },
  {
    id: 'one-crown-for-all', expect: 'T7-variation',
    doc: 'give every tank the same dome — 29 identical sheds, which is the bug this lane exists to fix',
    find: "  if (family === 'tank') crownForm = !round ? 'cone' : (bit(seed, 0) ? 'dome' : 'cone');",
    replace: "  if (family === 'tank') crownForm = 'dome';",
  },
  {
    id: 'stations-collapse', expect: 'T7-variation',
    doc: 'put every fitting on vertex 0, so the seed stops distinguishing three near-identical tanks',
    find: '    : (byteAt(seed, offsetBits) + Math.round((index * vertexCount) / Math.max(1, count))) % vertexCount);',
    replace: '    : 0);',
  },
  {
    id: 'tuck-becomes-cut', expect: 'T4-additive-invariant',
    doc: 'tuck annuli a metre inside the wall instead of 0.1 m — geometry the extrusion hides',
    find: '  shellTuckM: 0.1,',
    replace: '  shellTuckM: 1,',
  },
  {
    id: 'annulus-degenerate', expect: 'T3-non-degenerate',
    doc: 'a one-character index slip in the annulus emitter, which ships zero-area triangles',
    find: '      B.tri(slot, a[i], o[i], o[j]);',
    replace: '      B.tri(slot, a[i], a[i], o[j]);',
  },
  {
    id: 'wall-inside-out', expect: 'T11-face-orientation',
    doc: 'reverse the side-wall winding, so every wall in the archetype faces into the building',
    find: '    B.tri(slot, lo[i], lo[j], up[i]);\n    B.tri(slot, lo[j], up[j], up[i]);',
    replace: '    B.tri(slot, lo[j], lo[i], up[i]);\n    B.tri(slot, up[j], lo[j], up[i]);',
  },
  {
    id: 'crown-costs-a-slot', expect: 'T9-cost',
    doc: 'emit the tank crown on the metal slot, which is a real extra draw call on every tank',
    find: '      addFan(B, SLOT.roof, ring, springY, [centre[0], centre[1], springY + spec.crownRiseM]);',
    replace: '      addFan(B, SLOT.metal, ring, springY, [centre[0], centre[1], springY + spec.crownRiseM]);',
  },
  {
    id: 'plans-every-building', expect: 'T2-owns-only-cylinders',
    doc: 'let the cylinder planner claim all 71 buildings — the double-claim bug the router exists to stop',
    find: "  if (classification?.archetype !== 'cylinder') return null;",
    replace: '  if (false) return null;',
  },
  {
    id: 'context-unchecked', expect: 'T10-look-rejected',
    doc: 'skip context validation, so a caller can hand the planner the look flip',
    find: '  validatePlannerContext(context);',
    replace: '  void context;',
  },
  {
    id: 'owner-mislabelled', expect: 'T1-contract',
    doc: 'label every instance as building 0, breaking floor visibility and asset suppression',
    find: '    ownerIndex: new Int32Array(list.map(() => buildingIndex)),',
    replace: '    ownerIndex: new Int32Array(list.map(() => 0)),',
  },
  {
    id: 'prototype-centred', expect: 'T12-instance-prototype',
    doc: 'centre the unit prototype on z, which half-buries every instance sharing the family',
    find: '    for (const [x, y, z] of face) positions.push(x, y, z);',
    replace: '    for (const [x, y, z] of face) positions.push(x, y, z - 0.5);',
  },
  {
    id: 'section-is-the-rectangle-again', expect: 'T13-drawn-section-is-round',
    doc: "put the authored 4-vertex rectangle back as the shell's section — the founder's literal complaint, restored",
    find: '    ? ellipseSection(obbCentre, obbYawRad, semiLengthM, semiWidthM, C.shellSegments)',
    replace: '    ? cleanCcwRing(building?.poly)',
  },
  {
    id: 'four-segments', expect: 'T13-drawn-section-is-round',
    doc: 'sample the ellipse at four azimuths, which is a rhombus — round by intent, four-sided on screen',
    find: '  shellSegments: 24,',
    replace: '  shellSegments: 4,',
  },
  {
    id: 'no-waist', expect: 'T13-drawn-section-is-round',
    doc: 'flatten the hyperbola to a straight tube: still round, still contained, and no longer a cooling tower',
    find: '  throatRadiusFrac: 0.62,',
    replace: '  throatRadiusFrac: 0.999,',
  },
  {
    id: 'mass-not-replaced', expect: 'T13-drawn-section-is-round',
    doc: 'draw the shell but leave the flag off, so the renderer extrudes the rectangle around it — the defect as shipped',
    find: '    replacesMass: spec.massReplaced,',
    replace: '    replacesMass: false,',
  },
  {
    id: 'section-circumscribes', expect: 'T4-additive-invariant',
    doc: 'let the section escape its own OBB by 3 m, which is what an equal-AREA circle on row 19 would do',
    find: '  shellInsetM: 0.15,',
    replace: '  shellInsetM: -3,',
  },
  {
    id: 'rim-stands-proud', expect: 'T14-fits-its-data-height',
    doc: 'raise the open rim 1.4 m above the shell top, so the fit silently squashes a 30 m tower to make room',
    find: '    addAnnulus(B, SLOT.roof, rimInner, shellTopY, rimOuter, shellTopY, true);',
    replace: '    addAnnulus(B, SLOT.roof, rimInner, shellTopY + 1.4, rimOuter, shellTopY + 1.4, true);',
  },
  {
    id: 'seed-drifts', expect: 'T8-deterministic',
    doc: 'let the seed advance per call, so the renderer stops being reproducible run to run',
    find: '  const seed = (classification?.seed ?? 0) >>> 0;',
    replace: '  const seed = ((classification?.seed ?? 0) + (globalThis.__tzDrift = (globalThis.__tzDrift ?? 0) + 1)) >>> 0;',
  },
];

for (const mutation of MUTATIONS) {
  test(`discriminates [${mutation.expect}] <- mutation "${mutation.id}": ${mutation.doc}`, async () => {
    const mutant = await loadMutant(mutation.id, mutation.find, mutation.replace);
    const caught = caughtBy(mutant);
    assert.ok(caught.length > 0, `mutation "${mutation.id}" was not caught by ANY assertion`);
    assert.ok(
      caught.includes(mutation.expect),
      `mutation "${mutation.id}" was not caught by ${mutation.expect} (caught by: ${caught.join(', ') || 'nothing'})`,
    );
  });
}

test('every assertion is covered by at least one mutation', () => {
  const covered = new Set(MUTATIONS.map((mutation) => mutation.expect));
  const uncovered = ASSERTIONS.map((assertion) => assertion.id).filter((id) => !covered.has(id));
  assert.deepEqual(uncovered, [], `assertions nobody has proved can fail: ${uncovered.join(', ')}`);
});

test('the unmutated module passes every assertion', () => {
  assert.deepEqual(caughtBy(cylinderModule), []);
});
