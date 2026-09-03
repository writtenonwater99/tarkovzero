/**
 * The small-box detail planner, asserted against the REAL thirty small-box buildings of
 * `public/data/customs-3d.json` (public fields only) and against `seatBuilding()` from
 * src/buildings.js — the same seating function the renderer uses.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS FILE HAS A MUTATION HARNESS
 *
 * Handoff §6: five times in one day this project reported success while something had silently
 * fallen back, and `payloadBytesRead` was identically zero BY CONSTRUCTION. The rule is that an
 * assertion which cannot fail is worse than no assertion. So the second half of this file takes the
 * SHIPPED module source, applies one targeted mutation, writes the mutant to a temp module, imports
 * it and re-runs the entire assertion set against it. A mutation caught by nothing is a failure. A
 * mutation whose search string no longer matches the source is ALSO a failure, so the harness
 * cannot rot into a no-op when the module is edited.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THE GROUND IS SYNTHETIC AND WHY THAT IS THE RIGHT CHOICE
 *
 * The real sampler lives behind `buildTerrain()` in src/terrain.js, which pulls in `@deck.gl/core`
 * — 197 s of drvfs import cost on this machine (handoff §7) for a module this planner never talks
 * to. What this planner actually needs from the ground is a CONTRACT: a function of (x, z) in
 * displayed metres. A steeply tilted synthetic plane exercises that contract harder than the real
 * terrain does, because it guarantees every one of the thirty buildings sits on a cross-slope and
 * therefore that the door-reaches-the-ground path runs on real footprints rather than on flat luck.
 *
 * Run: `node --test scripts/building-detail-small-box.test.mjs`
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { classifyAll } from '../src/building-archetype.js';
import { seatBuilding } from '../src/buildings.js';
import {
  DETAIL_DRAW_CALL_BUDGET, MATERIAL_SLOTS, planDrawCallDelta, validateDetailPlan,
  validatePlannerContext,
} from '../src/building-detail/contract.js';
import * as shipped from '../src/building-detail/small-box.js';

const MODULE_SRC = new URL('../src/building-detail/small-box.js', import.meta.url);

const customs3d = JSON.parse(await readFile(new URL('../public/data/customs-3d.json', import.meta.url), 'utf8'));
const BUILDINGS = customs3d.buildings;
const BUILDING_COUNT = 71;
const ARCHETYPE = 'small-box';

/** Pinned from the shipped data. If a rebuild changes these, the numbers below are stale, not wrong. */
const EXPECTED_SMALL_BOX_COUNT = 30;
const EXPECTED_ROOF_SPLIT = { ridged: 14, 'mono-pitch': 14, 'flat-parapet': 2 };

/**
 * A steep tilted plane in displayed metres. Deliberately harsh: 6% east and 4.5% north puts a
 * 0.5–1.0 m cross-fall under even the 6 m sheds, which is what makes the door-seating path real.
 */
const groundYAt = (x, z) => 12 + 0.06 * Number(x) - 0.045 * Number(z);

const classification = classifyAll(BUILDINGS);
const SMALL_BOX_INDICES = classification.byArchetype[ARCHETYPE];

function contextFor(index) {
  const building = BUILDINGS[index];
  const seat = seatBuilding(building, groundYAt);
  return {
    buildingIndex: index,
    classification: classification.assignments[index],
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

/** Plan every small-box building with one planner implementation. */
function planAll(planDetail) {
  return SMALL_BOX_INDICES.map((index) => {
    const context = contextFor(index);
    validatePlannerContext(context);
    return { index, context, plan: planDetail(BUILDINGS[index], context) };
  });
}

// --------------------------------------------------------------------------------------------- //
// Geometry readers used by the assertions. These are INDEPENDENT of the module: they read the
// emitted buffers and the raw JSON poly, never the planner's own helpers.
// --------------------------------------------------------------------------------------------- //

const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Triangles of one material slot, as world-space vertex triples read back out of the buffers. */
function trianglesOfSlot(mesh, slotName) {
  const slot = MATERIAL_SLOTS.indexOf(slotName);
  const out = [];
  for (const group of mesh.groups) {
    if (group.materialSlot !== slot) continue;
    for (let i = group.start; i < group.start + group.count; i += 3) {
      out.push([0, 1, 2].map((k) => {
        const v = mesh.indices[i + k] * 3;
        return [mesh.positions[v], mesh.positions[v + 1], mesh.positions[v + 2]];
      }));
    }
  }
  return out;
}

const allTriangles = (mesh) => MATERIAL_SLOTS.flatMap((name) => trianglesOfSlot(mesh, name));

/** Divergence-theorem volume. Positive only when every face of a closed solid winds outward. */
function signedVolume(triangles) {
  let total = 0;
  for (const [a, b, c] of triangles) total += (a[0] * (b[1] * c[2] - b[2] * c[1])
    + a[1] * (b[2] * c[0] - b[0] * c[2])
    + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  return total;
}

const triangleArea = ([a, b, c]) => {
  const n = cross3(sub3(b, a), sub3(c, a));
  return Math.hypot(n[0], n[1], n[2]) / 2;
};

/** Raw footprint, read straight from the JSON — never through the planner. */
function rawRing(index) {
  const ring = BUILDINGS[index].poly.map(([x, z]) => [Number(x), Number(z)]);
  if (ring.length > 2 && Math.hypot(ring[0][0] - ring.at(-1)[0], ring[0][1] - ring.at(-1)[1]) < 1e-6) ring.pop();
  return ring;
}
function rawCentroid(index) {
  const ring = rawRing(index);
  return ring.reduce((acc, p) => [acc[0] + p[0] / ring.length, acc[1] + p[1] / ring.length], [0, 0]);
}
/** Furthest footprint vertex from the centroid, in metres. */
function rawRadius(index) {
  const [cx, cz] = rawCentroid(index);
  return Math.max(...rawRing(index).map(([x, z]) => Math.hypot(x - cx, z - cz)));
}
/** World-space horizontal distance from the footprint centroid. `world = (-x, -z, y)`. */
function worldPlanDistance(index, wx, wy) {
  const [cx, cz] = rawCentroid(index);
  return Math.hypot(wx - -cx, wy - -cz);
}

// --------------------------------------------------------------------------------------------- //
// THE ASSERTIONS. Every one is run again, unchanged, against every mutant.
// --------------------------------------------------------------------------------------------- //

/**
 * @returns {string[]} the ids of the assertions that FAILED. Empty means the implementation passed.
 * Each assertion is wrapped so that one failure does not hide the rest, which is what lets the
 * mutation harness report exactly which assertion caught which mutation.
 */
function runAssertions(planner) {
  const failures = [];
  const check = (id, body) => {
    try { body(); } catch (error) { failures.push(`${id}: ${error.message}`); }
  };

  const planDetail = planner.planDetail;
  const rows = planAll(planDetail);
  const plans = rows.map((row) => row.plan);

  // --- A1. Coverage: every small-box row gets a real plan, and nothing else does. ---------------
  check('A1-covers-archetype', () => {
    assert.equal(SMALL_BOX_INDICES.length, EXPECTED_SMALL_BOX_COUNT);
    for (const { index, plan } of rows) {
      assert.ok(plan, `building ${index} produced no plan`);
      assert.equal(plan.archetype, ARCHETYPE);
      assert.equal(plan.buildingIndex, index);
      assert.ok(plan.mesh, `building ${index} produced no mesh`);
    }
  });

  check('A1b-declines-other-archetypes', () => {
    const foreign = classification.assignments
      .map((record, index) => ({ record, index }))
      .filter(({ record }) => record.archetype !== ARCHETYPE);
    assert.equal(foreign.length, BUILDING_COUNT - EXPECTED_SMALL_BOX_COUNT);
    for (const { index } of foreign) {
      const context = { ...contextFor(index), classification: classification.assignments[index] };
      assert.equal(planDetail(BUILDINGS[index], context), null, `building ${index} was claimed by small-box`);
    }
  });

  // --- A2. The contract, executed. --------------------------------------------------------------
  check('A2-contract', () => {
    for (const plan of plans) validateDetailPlan(plan, { buildingCount: BUILDING_COUNT, archetype: ARCHETYPE });
  });

  // --- A3. Finite and non-degenerate. -----------------------------------------------------------
  check('A3-nondegenerate', () => {
    for (const { index, plan } of rows) {
      for (const value of plan.mesh.positions) assert.ok(Number.isFinite(value), `building ${index}: non-finite position`);
      const triangles = allTriangles(plan.mesh);
      assert.ok(triangles.length > 0, `building ${index}: empty mesh`);
      for (const triangle of triangles) {
        assert.ok(triangleArea(triangle) > 1e-4, `building ${index}: degenerate triangle, area ${triangleArea(triangle)}`);
      }
      for (const family of plan.instances) {
        for (const value of family.scales) assert.ok(Number.isFinite(value) && value > 1e-3, `building ${index}: bad scale ${value}`);
        for (const value of family.offsets) assert.ok(Number.isFinite(value), `building ${index}: bad offset`);
      }
    }
  });

  // --- A4. It sits ON the building. The detail's lowest point IS the eave plane, exactly. -------
  check('A4-sits-on-eave-plane', () => {
    for (const { index, plan, context } of rows) {
      const roofY = context.seat.baseY + classification.assignments[index].heightM;
      let lowest = Infinity, highest = -Infinity;
      for (let i = 2; i < plan.mesh.positions.length; i += 3) {
        lowest = Math.min(lowest, plan.mesh.positions[i]);
        highest = Math.max(highest, plan.mesh.positions[i]);
      }
      assert.ok(Math.abs(lowest - roofY) < 1e-3,
        `building ${index}: mesh starts at ${lowest.toFixed(3)}, eave plane is ${roofY.toFixed(3)} — it floats or it is buried`);
      const ceiling = roofY + shipped.SMALL_BOX_ROOF.maxRiseM + shipped.SMALL_BOX_ROOF.slabThicknessM + 0.01;
      assert.ok(highest <= ceiling, `building ${index}: mesh reaches ${highest.toFixed(3)}, above the roof ceiling ${ceiling.toFixed(3)}`);
    }
  });

  // --- A4b. And it stays over its own footprint. ------------------------------------------------
  check('A4b-stays-over-footprint', () => {
    const maxOverhang = Math.max(...shipped.SMALL_BOX_ROOF.eaveOverhangM, shipped.SMALL_BOX_ROOF.endOverhangM);
    for (const { index, plan } of rows) {
      const limit = rawRadius(index) + maxOverhang * Math.SQRT2 + 0.05;
      for (let i = 0; i < plan.mesh.positions.length; i += 3) {
        const distance = worldPlanDistance(index, plan.mesh.positions[i], plan.mesh.positions[i + 1]);
        assert.ok(distance <= limit,
          `building ${index}: a vertex is ${distance.toFixed(2)} m from the centroid, footprint reach is ${limit.toFixed(2)} m`);
      }
    }
  });

  // --- A5. The roof actually OVERHANGS, in absolute metres. -------------------------------------
  //
  // Measured off the emitted vertices, projected onto the ROUTER's own axes (`metrics.yawRad`), so
  // neither the axis nor the extent comes from the planner. An absolute minimum rather than a ratio:
  // a ratio is satisfiable by a 16 m building with a 5 cm eave, which is the case that has no eave
  // line at any zoom.
  check('A5-roof-overhangs', () => {
    for (const { index, plan } of rows) {
      const record = classification.assignments[index];
      if (record.roofForm === 'flat-parapet') continue;
      const { yawRad, centerX, centerZ, widthM, lengthM } = record.metrics;
      const ux = Math.cos(yawRad), uz = Math.sin(yawRad);
      const vx = -Math.sin(yawRad), vz = Math.cos(yawRad);
      let maxU = 0, maxV = 0;
      for (const triangle of trianglesOfSlot(plan.mesh, 'roof')) {
        for (const [wx, wy] of triangle) {
          const gx = -wx, gz = -wy;
          maxU = Math.max(maxU, Math.abs((gx - centerX) * ux + (gz - centerZ) * uz));
          maxV = Math.max(maxV, Math.abs((gx - centerX) * vx + (gz - centerZ) * vz));
        }
      }
      assert.ok(maxV - widthM / 2 >= 0.2,
        `building ${index}: eave overhang is ${(maxV - widthM / 2).toFixed(3)} m — under 0.2 m there is no eave line at any zoom`);
      assert.ok(maxU - lengthM / 2 >= 0.15,
        `building ${index}: gable-end overhang is ${(maxU - lengthM / 2).toFixed(3)} m`);
    }
  });

  // --- A6. Winding and closure, checked against an ANALYTIC volume, not against the code. -------
  check('A6-slab-volume', () => {
    for (const { index, plan } of rows) {
      const record = classification.assignments[index];
      if (record.roofForm === 'flat-parapet') continue;
      const overhang = shipped.SMALL_BOX_ROOF.eaveOverhangM[
        shipped.seedChannel(record.seed, 'eaveOverhang')];
      const halfSpan = record.metrics.widthM / 2 + overhang;
      const halfLength = record.metrics.lengthM / 2 + shipped.SMALL_BOX_ROOF.endOverhangM;
      const expected = shipped.SMALL_BOX_ROOF.slabThicknessM * 2 * halfSpan * 2 * halfLength;
      const measured = signedVolume(trianglesOfSlot(plan.mesh, 'roof'));
      assert.ok(Math.abs(measured - expected) <= expected * 0.005,
        `building ${index}: slab volume ${measured.toFixed(3)} m3, analytic ${expected.toFixed(3)} m3`);
    }
  });

  // --- A7. The attic band's faces point AWAY from the footprint centroid. -----------------------
  check('A7-band-faces-outward', () => {
    for (const { index, plan } of rows) {
      const record = classification.assignments[index];
      if (record.roofForm === 'flat-parapet') continue;
      const wallTriangles = trianglesOfSlot(plan.mesh, 'wall');
      assert.ok(wallTriangles.length >= 6,
        `building ${index}: ${wallTriangles.length} wall triangles — the attic band is missing and the roof floats off the wall head`);
      const [cx, cz] = rawCentroid(index);
      const centre = [-cx, -cz];
      for (const triangle of wallTriangles) {
        const n = cross3(sub3(triangle[1], triangle[0]), sub3(triangle[2], triangle[0]));
        const mid = [0, 1].map((k) => (triangle[0][k] + triangle[1][k] + triangle[2][k]) / 3);
        const outward = [mid[0] - centre[0], mid[1] - centre[1]];
        assert.ok(n[0] * outward[0] + n[1] * outward[1] > 0,
          `building ${index}: an attic-band face points inward`);
      }
    }
  });

  // --- A8. VARIATION — the deliverable. ---------------------------------------------------------
  check('A8-variation-across-twins', () => {
    // The fifteen twins: the near-identical 6.1-6.7 x 2.5-2.9 m sheds.
    const twins = SMALL_BOX_INDICES.filter((index) => classification.assignments[index].metrics.areaM2 < 20);
    assert.equal(twins.length, 15, `expected 15 twin sheds, found ${twins.length}`);
    const signatures = new Set(twins.map((index) => planner.variationSignature(
      classification.assignments[index], classification.assignments[index].metrics.areaM2)));
    assert.ok(signatures.size >= 10,
      `only ${signatures.size} distinct outlines across the 15 twin sheds — they will read as fifteen copies`);
    const all = new Set(SMALL_BOX_INDICES.map((index) => planner.variationSignature(
      classification.assignments[index], classification.assignments[index].metrics.areaM2)));
    assert.ok(all.size >= 20, `only ${all.size} distinct outlines across the 30 small-box buildings`);
  });

  check('A8b-variation-reaches-geometry', () => {
    // A signature that does not move a vertex is decoration, so this measures the EMITTED geometry.
    //
    // The first draft of this assertion measured the ridge apex and the flue's distance from the
    // centroid, and it was a metric that could not fail: those quantities are dominated by the
    // footprint, which varies between the twins anyway (2.50-2.92 m of width), so a planner with
    // its seed hardwired to a constant still scored 12 of them. Every quantity below is instead
    // FOOTPRINT-INDEPENDENT — it can only differ because the seed differs:
    //
    //   measured eave overhang (0.28 / 0.45 m)     seed channel `eaveOverhang`
    //   flue height            (1.05 / 1.4 / 1.75) seed channel `stackHeight`
    //   flue station, as a sign along the ridge    seed channel `stackStation`
    //   which side the lean-to falls to            seed channel `monoFallDirection`
    //
    // Measured 12 distinct across the 15 twins on the shipped module; a planner with one constant
    // flue height scores 9, which is what sets the bar at 10.
    const twins = SMALL_BOX_INDICES.filter((index) => classification.assignments[index].metrics.areaM2 < 20);
    const profiles = new Set();
    for (const index of twins) {
      const row = rows.find((candidate) => candidate.index === index);
      const record = classification.assignments[index];
      const { yawRad, centerX, centerZ, widthM } = record.metrics;
      const ux = Math.cos(yawRad), uz = Math.sin(yawRad);
      const vx = -Math.sin(yawRad), vz = Math.cos(yawRad);
      let maxV = 0, topY = -Infinity, topV = 0;
      for (const triangle of trianglesOfSlot(row.plan.mesh, 'roof')) {
        for (const [wx, wy, wz] of triangle) {
          const v = (-wx - centerX) * vx + (-wy - centerZ) * vz;
          maxV = Math.max(maxV, Math.abs(v));
          if (wz > topY) { topY = wz; topV = v; }
        }
      }
      const stack = row.plan.instances.find((family) => family.familyId === 'roof-stack');
      let stationSign = 0, flueHeight = 0;
      if (stack) {
        const u = (-stack.offsets[0] - centerX) * ux + (-stack.offsets[1] - centerZ) * uz;
        stationSign = Math.abs(u) < 0.05 ? 0 : Math.sign(u);
        flueHeight = stack.scales[2];
      }
      const fallSide = record.roofForm === 'mono-pitch' ? Math.sign(topV) : 0;
      profiles.add([
        (maxV - widthM / 2).toFixed(2), flueHeight.toFixed(2), stationSign, fallSide,
      ].join('|'));
    }
    assert.ok(profiles.size >= 10,
      `only ${profiles.size} seed-driven roof profiles across the 15 twin sheds — the variation never reaches a vertex`);
  });

  // --- A9. Determinism. -------------------------------------------------------------------------
  check('A9-deterministic', () => {
    for (const { index, plan } of rows) {
      const again = planDetail(BUILDINGS[index], contextFor(index));
      assert.deepEqual([...again.mesh.positions], [...plan.mesh.positions], `building ${index} is not reproducible`);
      assert.deepEqual(
        again.instances.map((family) => [...family.offsets]),
        plan.instances.map((family) => [...family.offsets]),
        `building ${index}'s instances are not reproducible`,
      );
    }
  });

  // --- A10. Roof plant is ON the roof; doors reach the GROUND. ----------------------------------
  check('A10-plant-on-roof', () => {
    for (const { index, plan } of rows) {
      const height = classification.assignments[index].heightM;
      const reach = rawRadius(index) + 0.6;
      for (const family of plan.instances) {
        if (family.familyId === 'door-module') continue;
        for (let i = 0; i < family.count; i++) {
          assert.ok(family.levelAboveBaseM[i] >= height - 0.1,
            `building ${index}: ${family.familyId} sits at ${family.levelAboveBaseM[i].toFixed(2)} m, under the ${height} m roof`);
          const distance = worldPlanDistance(index, family.offsets[i * 3], family.offsets[i * 3 + 1]);
          assert.ok(distance <= reach,
            `building ${index}: ${family.familyId} is ${distance.toFixed(2)} m out, off its own roof (reach ${reach.toFixed(2)} m)`);
        }
      }
    }
  });

  check('A10b-doors-reach-the-ground', () => {
    let reachedDown = 0;
    for (const { index, plan, context } of rows) {
      const doors = plan.instances.find((family) => family.familyId === 'door-module');
      if (!doors) continue;
      for (let i = 0; i < doors.count; i++) {
        const footY = doors.offsets[i * 3 + 2];
        const groundHere = groundYAt(-doors.offsets[i * 3], -doors.offsets[i * 3 + 1]);
        const floatM = footY - Math.max(groundHere, context.seat.baseY - shipped.SMALL_BOX_DOOR.maxGroundReachM);
        assert.ok(floatM <= 0.02,
          `building ${index}: a door foot floats ${floatM.toFixed(2)} m above the ground it stands on`);
        if (footY < context.seat.baseY - 0.02) reachedDown++;
      }
    }
    assert.ok(reachedDown >= 5,
      `only ${reachedDown} doors were extended down to the ground — on a 6% cross-fall the path is not running`);
  });

  // --- A11. Cost. The claim in the report is this number. ---------------------------------------
  check('A11-draw-call-delta', () => {
    const delta = planDrawCallDelta(plans);
    assert.equal(delta.worstPerBuilding, 0,
      `the small-box mesh uses ${delta.worstPerBuilding} slot(s) beyond wall/roof — that is one extra draw call per building, 30 in all`);
    assert.equal(delta.perBuildingGroups, 0);
    assert.equal(delta.instancedFamilies, 4);
    assert.equal(delta.total, 4);
    assert.ok(delta.withinBudget);
    assert.ok(delta.total <= DETAIL_DRAW_CALL_BUDGET.maxInstancedFamiliesMapWide);
  });

  check('A11b-triangle-cost', () => {
    let meshTriangles = 0, instanceTriangles = 0, instanceCount = 0;
    for (const { plan } of rows) {
      meshTriangles += plan.mesh.indices.length / 3;
      for (const family of plan.instances) {
        instanceCount += family.count;
        instanceTriangles += (family.prototype.indices.length / 3) * family.count;
      }
    }
    // Pinned. A change here is a real change in what ships; update it deliberately, with a reason.
    //   mesh:      14 ridged x 28 + 14 mono-pitch x 20 + 2 flat-parapet x 24 = 720
    //   instances: 20 stacks x 22 + 17 vents x 12 + 2 hatches x 12 + 35 doors x 12 = 1,088
    assert.equal(meshTriangles, 720, `mesh triangles moved to ${meshTriangles}`);
    assert.equal(instanceCount, 74, `instance count moved to ${instanceCount}`);
    assert.equal(instanceTriangles, 1088, `instance triangles moved to ${instanceTriangles}`);
    assert.ok(meshTriangles + instanceTriangles < 3000);
  });

  // --- A12. The rise cap is doing work, and only where it should. -------------------------------
  check('A12-rise-cap', () => {
    // The 16.5 x 16.1 m Military Checkpoint shed: the widest span in this archetype at 3.5 m tall.
    const wide = SMALL_BOX_INDICES.reduce((best, index) => (
      classification.assignments[index].metrics.widthM > classification.assignments[best].metrics.widthM ? index : best));
    const record = classification.assignments[wide];
    const rise = planner.roofRise(record.roofForm, record.metrics.widthM, record.heightM);
    assert.ok(rise.capped, `the widest small-box (${record.metrics.widthM.toFixed(1)} m span) is not rise-capped`);
    assert.ok(rise.effectivePitchDeg < 14,
      `the widest span came out at ${rise.effectivePitchDeg.toFixed(1)} deg — a wide span must read as a low-slope roof`);
    assert.ok(rise.riseM <= record.heightM * shipped.SMALL_BOX_ROOF.maxRiseHeightRatio + 1e-6);

    // ...and a narrow shed keeps its full geometric pitch.
    const narrow = SMALL_BOX_INDICES
      .filter((index) => classification.assignments[index].roofForm === 'ridged')
      .reduce((best, index) => (
        classification.assignments[index].metrics.widthM < classification.assignments[best].metrics.widthM ? index : best));
    const narrowRecord = classification.assignments[narrow];
    const narrowRise = planner.roofRise(narrowRecord.roofForm, narrowRecord.metrics.widthM, narrowRecord.heightM);
    assert.equal(narrowRise.capped, false, 'a 2.8 m shed should be on its geometric pitch, not on the cap');
    assert.ok(Math.abs(narrowRise.effectivePitchDeg - shipped.SMALL_BOX_ROOF.gablePitchDeg) < 0.01);
  });

  // --- A13. The roof form split matches the router; the planner never re-routes. -----------------
  check('A13-roof-forms', () => {
    const tally = {};
    for (const index of SMALL_BOX_INDICES) {
      const form = classification.assignments[index].roofForm;
      tally[form] = (tally[form] ?? 0) + 1;
    }
    assert.deepEqual(tally, EXPECTED_ROOF_SPLIT);
    for (const { index, plan } of rows) {
      const form = classification.assignments[index].roofForm;
      const hasRoofSurface = trianglesOfSlot(plan.mesh, 'roof').length > 0;
      assert.ok(hasRoofSurface, `building ${index} (${form}) emitted no roof surface`);
    }
  });

  // --- A14. Purity, by source inspection. -------------------------------------------------------
  check('A14-pure', () => {
    // Comments are stripped first: the module's own header EXPLAINS the look invariant in prose,
    // and a check that cannot tell prose from code would fail on the documentation of the rule it
    // is enforcing.
    const code = (planner.__source ?? '')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    assert.ok(!/Math\.random/.test(code), 'the planner reaches for Math.random');
    assert.ok(!/\blook\b/.test(code), 'the planner reads the look — geometry may not depend on it');
    assert.ok(!/new Date|Date\.now|require\(|from ['"]three['"]/.test(code), 'the planner is not pure');
  });

  // --- A15. Prototype parity: one family id must mean one geometry, map-wide. -------------------
  //
  // The renderer merges every planner's declaration of a family into ONE InstancedMesh, which can
  // carry only one geometry — so two planners shipping different prototypes under the same id is a
  // defect that renders silently. `src/building-detail/big-box.js` also declares `roof-vent` and
  // `roof-hatch`, as a CLOSED unit box over x,y in [-0.5, 0.5] and z in [0, 1]. That shape is
  // asserted here directly rather than by importing the sibling, because the sibling is being
  // written in the same session and a hard import would make this suite fail for someone else's
  // edit. A closed, outward-wound unit box has a signed volume of exactly 1.
  check('A15-unit-box-prototype-parity', () => {
    for (const familyId of ['roof-vent', 'roof-hatch']) {
      const prototype = planner.SMALL_BOX_PROTOTYPES[familyId];
      assert.ok(prototype, `no prototype for ${familyId}`);
      const triangles = [];
      for (let i = 0; i < prototype.indices.length; i += 3) {
        triangles.push([0, 1, 2].map((k) => {
          const v = prototype.indices[i + k] * 3;
          return [prototype.positions[v], prototype.positions[v + 1], prototype.positions[v + 2]];
        }));
      }
      const axis = (k) => [...prototype.positions].filter((_, i) => i % 3 === k);
      assert.deepEqual([Math.min(...axis(0)), Math.max(...axis(0))], [-0.5, 0.5], `${familyId}: x extent`);
      assert.deepEqual([Math.min(...axis(1)), Math.max(...axis(1))], [-0.5, 0.5], `${familyId}: y extent`);
      assert.deepEqual([Math.min(...axis(2)), Math.max(...axis(2))], [0, 1], `${familyId}: z extent`);
      assert.ok(Math.abs(signedVolume(triangles) - 1) < 1e-6,
        `${familyId}: prototype volume ${signedVolume(triangles).toFixed(4)} — it is inside-out or the wrong size, and big-box declares a closed unit box under the same family id`);
      // Volume alone CANNOT see a missing bottom: the face lies on z = 0, where the divergence
      // integrand r.n is identically zero, so dropping it leaves the volume at exactly 1. That is a
      // metric that cannot fail, so watertightness is checked directly instead — every directed
      // edge must be answered by exactly one edge running the other way.
      const edges = new Map();
      const key = (p) => p.map((value) => value.toFixed(4)).join(',');
      for (const [a, b, c] of triangles) {
        for (const [from, to] of [[a, b], [b, c], [c, a]]) {
          const id = `${key(from)}>${key(to)}`;
          edges.set(id, (edges.get(id) ?? 0) + 1);
        }
      }
      for (const id of edges.keys()) {
        const [from, to] = id.split('>');
        assert.equal(edges.get(`${to}>${from}`), 1,
          `${familyId}: edge ${id} has no opposing twin — the prototype is not watertight (a face is missing)`);
      }
    }
  });

  return failures;
}

// --------------------------------------------------------------------------------------------- //
// The shipped module must pass, obviously.
// --------------------------------------------------------------------------------------------- //

const SHIPPED_SOURCE = await readFile(MODULE_SRC, 'utf8');
const shippedPlanner = { ...shipped, __source: SHIPPED_SOURCE };

test('the shipped small-box planner passes every assertion', () => {
  const failures = runAssertions(shippedPlanner);
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
});

test('census of what this planner actually builds', () => {
  const rows = planAll(shipped.planDetail);
  const families = new Map();
  for (const { plan } of rows) {
    for (const family of plan.instances) {
      families.set(family.familyId, (families.get(family.familyId) ?? 0) + family.count);
    }
  }
  const lines = [...families.entries()].sort().map(([id, count]) => `  ${id.padEnd(14)} ${String(count).padStart(3)}`);
  console.log(`\nsmall-box: ${rows.length} buildings\n${lines.join('\n')}`);
  assert.equal(families.get('roof-stack'), 20);
  assert.equal(families.get('roof-vent'), 17);
  assert.equal(families.get('roof-hatch'), 2);
  assert.equal(families.get('door-module'), 35);
});

// --------------------------------------------------------------------------------------------- //
// THE MUTATION HARNESS. Every assertion above must be shown to discriminate.
// --------------------------------------------------------------------------------------------- //

/**
 * `expect` names the assertion whose job it is to catch the mutation. The harness fails when NO
 * assertion catches it (an assertion set with a hole), and it also fails when `find` no longer
 * appears in the source (a mutation that has quietly become a no-op against an edited module).
 */
const MUTATIONS = [
  {
    id: 'no-overhang',
    why: 'roof stops overhanging the wall — the eave line disappears and the attic band collapses',
    find: 'eaveOverhangM: Object.freeze([0.28, 0.45])',
    replace: 'eaveOverhangM: Object.freeze([0, 0])',
    expect: 'A5-roof-overhangs',
  },
  {
    id: 'inverted-winding',
    why: 'every face winds inward — the roof renders inside-out and culls away',
    find: 'const tri = outwardRef && dot(normal, outwardRef) < 0 ? [a, c, b] : [a, b, c];',
    replace: 'const tri = outwardRef && dot(normal, outwardRef) > 0 ? [a, c, b] : [a, b, c];',
    expect: 'A6-slab-volume',
  },
  {
    id: 'floating-roof',
    why: 'the roof is planned 1.5 m above the eave plane and hovers over the building',
    find: 'const roofY = baseY + heightM;',
    replace: 'const roofY = baseY + heightM + 1.5;',
    expect: 'A4-sits-on-eave-plane',
  },
  {
    id: 'constant-seed',
    why: 'every building takes the same variation channel — thirty identical sheds, reported as success',
    find: '  const raw = (num(seed) >>> channel.shift) & ((1 << channel.width) - 1);',
    replace: '  const raw = 0;',
    expect: 'A8-variation-across-twins',
  },
  {
    id: 'uncapped-rise',
    why: 'a 16 m span takes a 3.9 m ridge on a 3.5 m building — a circus tent',
    find: 'maxRiseHeightRatio: 0.45,',
    replace: 'maxRiseHeightRatio: 9,',
    expect: 'A12-rise-cap',
  },
  {
    id: 'stack-below-roof',
    why: 'the flue is planned 3 m lower and disappears inside the shed',
    find: 'const level = heightM + undersideAt(v) + slabT - 0.05;',
    replace: 'const level = heightM + undersideAt(v) + slabT - 3;',
    expect: 'A10-plant-on-roof',
  },
  {
    id: 'extra-material-slot',
    why: 'the slab moves to the trim slot: +1 draw call on every one of the 30 buildings',
    find: '  const roofSlot = MATERIAL_SLOT_INDEX.roof;',
    replace: '  const roofSlot = MATERIAL_SLOT_INDEX.trim;',
    expect: 'A11-draw-call-delta',
  },
  {
    id: 'fan-triangulated-gable',
    why: 'the regression that shipped in this module\'s first draft: a triangle fan across a CHEVRON '
      + 'section sweeps outside the polygon and lids the gable',
    find: `        mesh.addQuad(
          roofSlot,
          [ax, az, roofY + y0], [bx, bz, roofY + y1],
          [bx, bz, roofY + y1 + slabT], [ax, az, roofY + y0 + slabT],
          outward,
        );`,
    replace: `        mesh.addQuad(
          roofSlot,
          [ax, az, roofY + y0], [bx, bz, roofY + y1],
          [bx, bz, roofY + y1 + slabT], [at(halfLengthM * end, section[0][0])[0], at(halfLengthM * end, section[0][0])[1], roofY + section[0][1] + slabT],
          outward,
        );`,
    expect: 'A6-slab-volume',
  },
  {
    id: 'no-attic-band',
    why: 'the wall head is not carried up to the roof underside — daylight between wall and roof',
    find: '      mesh.addQuad(wall, [ax, az, roofY], [bx, bz, roofY], [bx, bz, topB], [ax, az, topA], outward);',
    replace: '      if (index < 0) mesh.addQuad(wall, [ax, az, roofY], [bx, bz, roofY], [bx, bz, topB], [ax, az, topA], outward);',
    expect: 'A7-band-faces-outward',
  },
  {
    id: 'door-ignores-ground',
    why: 'the door foot is pinned to the eave-plane base and floats on the downhill face',
    find: '        const footY = clamp(baseY - SMALL_BOX_DOOR.maxGroundReachM, Math.min(baseY, ground), baseY);',
    replace: '        const footY = baseY;',
    expect: 'A10b-doors-reach-the-ground',
  },
  {
    id: 'claims-every-archetype',
    why: 'the planner stops declining foreign buildings — the double-claim bug the router exists to prevent',
    find: "  if (!classification || classification.archetype !== ARCHETYPE) return null;",
    replace: "  if (!classification) return null;",
    expect: 'A1b-declines-other-archetypes',
  },
  {
    id: 'open-bottomed-vent',
    why: 'the vent prototype diverges from the closed unit box big-box declares under the same '
      + 'family id — two geometries, one InstancedMesh, one of them silently discarded',
    find: "  'roof-vent': prototypeFromFaces(boxFaces({ withBottom: true })),",
    replace: "  'roof-vent': prototypeFromFaces(boxFaces({ withBottom: false })),",
    expect: 'A15-unit-box-prototype-parity',
  },
  {
    id: 'constant-flue-height',
    why: 'the flue stops varying: A8 still passes because the SIGNATURE still reads the channel, '
      + 'which is exactly the gap A8b exists to close',
    find: '    const stackHeight = SMALL_BOX_PLANT.stackHeightsM[seedChannel(seed, \'stackHeight\')];',
    replace: '    const stackHeight = 1.4;',
    expect: 'A8b-variation-reaches-geometry',
  },
  {
    id: 'roof-off-centre',
    why: 'the roof is planned 3 m east of the building it belongs to',
    find: '  const centerX = num(metrics.centerX, num(metrics.centroidX));',
    replace: '  const centerX = num(metrics.centerX, num(metrics.centroidX)) + 3;',
    expect: 'A4b-stays-over-footprint',
  },
  {
    id: 'nondeterministic',
    why: 'variation comes from Math.random instead of the seed — the renderer stops being reproducible',
    find: '  const eaveOverhangM = SMALL_BOX_ROOF.eaveOverhangM[overhangIndex];',
    replace: '  const eaveOverhangM = SMALL_BOX_ROOF.eaveOverhangM[Math.floor(Math.random() * 2)];',
    expect: 'A9-deterministic',
  },
  {
    id: 'zero-slab-thickness',
    why: 'the roof becomes a zero-volume surface: no eave edge, no shadow, degenerate faces',
    find: 'slabThicknessM: 0.22,',
    replace: 'slabThicknessM: 0,',
    expect: 'A3-nondegenerate',
  },
];

/**
 * Every assertion this file makes, and the reason any of them is allowed to have no mutation of its
 * own. Coverage is asserted below, so an assertion added without a mutation fails the suite rather
 * than sitting unproven — that is the whole difference between this harness and a wish.
 */
const ASSERTION_IDS = [
  'A1-covers-archetype', 'A1b-declines-other-archetypes', 'A2-contract', 'A3-nondegenerate',
  'A4-sits-on-eave-plane', 'A4b-stays-over-footprint', 'A5-roof-overhangs', 'A6-slab-volume',
  'A7-band-faces-outward', 'A8-variation-across-twins', 'A8b-variation-reaches-geometry',
  'A9-deterministic', 'A10-plant-on-roof', 'A10b-doors-reach-the-ground', 'A11-draw-call-delta',
  'A11b-triangle-cost', 'A12-rise-cap', 'A13-roof-forms', 'A14-pure',
  'A15-unit-box-prototype-parity',
];
const EXEMPT_FROM_MUTATION = {
  'A1-covers-archetype': 'tripped transitively by every mutation that stops a plan being produced',
  'A2-contract': 'the contract validator is asserted by scripts/building-archetype.test.mjs, which '
    + 'owns it; here it is a guard, and every geometry mutation trips it or A3 first',
  'A11b-triangle-cost': 'a PIN, not a predicate: it fails on any change in what ships, which is the '
    + 'point of it, and ten of the mutations below trip it as well',
  'A13-roof-forms': 'restates the router\'s census, which building-archetype.test.mjs mutates in full',
  'A14-pure': 'a source-text check; the `nondeterministic` mutation trips it alongside A9',
};

test('every assertion is proved to discriminate', async (t) => {
  await t.test('mutation coverage has no silent holes', () => {
    const covered = new Set(MUTATIONS.map((mutation) => mutation.expect));
    for (const id of covered) assert.ok(ASSERTION_IDS.includes(id), `mutation expects unknown assertion "${id}"`);
    const uncovered = ASSERTION_IDS.filter((id) => !covered.has(id));
    for (const id of uncovered) {
      assert.ok(EXEMPT_FROM_MUTATION[id], `assertion "${id}" has no mutation and no stated reason to lack one`);
    }
    assert.deepEqual(uncovered.sort(), Object.keys(EXEMPT_FROM_MUTATION).sort());
  });

  const directory = await mkdtemp(join(tmpdir(), 'small-box-mutants-'));
  try {
    for (const mutation of MUTATIONS) {
      await t.test(`discriminates [${mutation.expect}] <- mutation "${mutation.id}": ${mutation.why}`, async () => {
        assert.ok(
          SHIPPED_SOURCE.includes(mutation.find),
          `mutation "${mutation.id}" no longer matches the shipped source — it has rotted into a no-op`,
        );
        const mutated = SHIPPED_SOURCE.replace(mutation.find, mutation.replace);
        assert.notEqual(mutated, SHIPPED_SOURCE);
        const file = join(directory, `${mutation.id}.mjs`);
        // The mutant lives beside the original so its relative imports still resolve.
        const local = join(new URL('../src/building-detail/', import.meta.url).pathname, `.mutant-${mutation.id}.mjs`);
        await writeFile(local, mutated, 'utf8');
        try {
          const mutant = await import(pathToFileURL(local).href);
          const failures = runAssertions({ ...mutant, __source: mutated });
          assert.ok(
            failures.length > 0,
            `mutation "${mutation.id}" was not caught by ANY assertion — a metric that cannot fail`,
          );
          assert.ok(
            failures.some((line) => line.startsWith(`${mutation.expect}:`)),
            `mutation "${mutation.id}" was caught, but not by ${mutation.expect}. Caught by:\n  ${failures.join('\n  ')}`,
          );
        } finally {
          await rm(local, { force: true });
        }
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
