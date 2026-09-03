/**
 * `src/building-detail/garage.js` — assertions against the REAL twelve Customs garages, plus a
 * mutation harness that proves each assertion can fail.
 *
 * WHY THIS FILE HAS A MUTATION HARNESS
 *
 * `docs/CONTINUATION-HANDOFF-2026-09-02.md` §6 lists five occasions on which this project reported
 * success while something had silently fallen back, and a sixth was caught inside the archetype
 * router's own harness before it shipped. A geometry planner is the easiest place yet to add a
 * sixth: "the plan validates against the contract" is true of an empty plan, "930 triangles" is
 * true of 930 triangles in the wrong place, and "the roof is applied" was true of a bridge that was
 * under water. So every assertion below is applied to the real shipped source with one line changed
 * and required to go RED.
 *
 * TERRAIN. The sampler here is the PUBLIC heightfield shipped in `public/data/customs-3d.json`,
 * read directly and interpolated bilinearly at the renderer's default relief of 3. That is not a
 * re-implementation of `src/terrain.js` standing in for it — it is the same public grid, sampled so
 * that the door-face rule is exercised against Customs' real cross-slopes without importing
 * `src/terrain.js`, whose `@deck.gl/core` chain costs 3-4 minutes of drvfs I/O per run (handoff §7).
 * Six of the eight single-rank garages are decided by terrain under it and two by the seed
 * tie-break, so both paths are live on real data; the synthetic ramps in G13 then prove the terrain
 * branch actually responds to the ground rather than reporting that it did.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { classifyAll } from '../src/building-archetype.js';
import { seatBuilding } from '../src/buildings.js';
import { planDrawCallDelta, validateDetailPlan, MATERIAL_SLOT_INDEX } from '../src/building-detail/contract.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const GARAGE_SRC = join(ROOT, 'src/building-detail/garage.js');

const DATA = JSON.parse(readFileSync(join(ROOT, 'public/data/customs-3d.json'), 'utf8'));
const BUILDINGS = DATA.buildings;
const ROUTED = classifyAll(BUILDINGS);
const GARAGE_INDICES = ROUTED.byArchetype.garage;

/** The renderer's default relief. `H()` multiplies terrain by it; `seat` is already in these metres. */
const RELIEF = 3;

/** Bilinear sample of the shipped public heightfield, in displayed metres. */
function publicGroundYAt(x, z) {
  const t = DATA.terrain;
  const fx = (x - t.x0) / t.step, fz = (z - t.z0) / t.step;
  const i = Math.max(0, Math.min(t.cols - 2, Math.floor(fx)));
  const j = Math.max(0, Math.min(t.rows - 2, Math.floor(fz)));
  const tx = Math.max(0, Math.min(1, fx - i)), tz = Math.max(0, Math.min(1, fz - j));
  const at = (a, b) => t.heights[b * t.cols + a];
  const top = at(i, j) * (1 - tx) + at(i + 1, j) * tx;
  const bottom = at(i, j + 1) * (1 - tx) + at(i + 1, j + 1) * tx;
  return RELIEF * (top * (1 - tz) + bottom * tz);
}

const flatGroundYAt = () => 0;
/**
 * A plane that falls ACROSS one building's own long axis — the only direction in which the two
 * candidate door faces differ at all.
 *
 * A single map-wide ramp is not good enough here: the twelve garages point in six directions, and a
 * ramp along +x leaves the two long faces of a west-east rank (building 2, yaw 3.10 rad) at exactly
 * the same height, so the rule would fall through to the seed tie-break and the assertion would be
 * testing nothing. `sign` flips which way the hill falls.
 */
function crossRampGroundYAt(index, sign) {
  const yaw = ROUTED.assignments[index].metrics.yawRad;
  const vx = -Math.sin(yaw), vz = Math.cos(yaw);
  return (x, z) => sign * 0.5 * (x * vx + z * vz);
}

function planFor(mod, index, groundYAt = publicGroundYAt) {
  const building = BUILDINGS[index];
  const seat = seatBuilding(building, groundYAt);
  return mod.planDetail(building, {
    buildingIndex: index,
    classification: ROUTED.assignments[index],
    seat,
    groundYAt,
  });
}

const planCache = new Map();
function plansOf(mod, groundYAt = publicGroundYAt, key = 'public') {
  const cacheKey = `${key}:${mod.__mutantId ?? 'real'}`;
  if (!planCache.has(cacheKey)) {
    planCache.set(cacheKey, GARAGE_INDICES.map((index) => planFor(mod, index, groundYAt)));
  }
  return planCache.get(cacheKey);
}

// --------------------------------------------------------------------------------------------- //
// Geometry readers. These walk the emitted buffers — never the planner's own report of them.
// --------------------------------------------------------------------------------------------- //

/** World position of vertex `i`. */
const vertexAt = (mesh, i) => [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]];

/** Every triangle as three world points, with the material slot its group declares. */
function triangles(plan) {
  const out = [];
  for (const group of plan.mesh.groups) {
    for (let at = group.start; at < group.start + group.count; at += 3) {
      out.push({
        slot: group.materialSlot,
        a: vertexAt(plan.mesh, plan.mesh.indices[at]),
        b: vertexAt(plan.mesh, plan.mesh.indices[at + 1]),
        c: vertexAt(plan.mesh, plan.mesh.indices[at + 2]),
      });
    }
  }
  return out;
}

const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const norm = (u) => Math.hypot(u[0], u[1], u[2]);

const triangleArea = (t) => norm(cross(sub(t.b, t.a), sub(t.c, t.a))) / 2;
/** Divergence-theorem volume. Positive only when every face of every closed solid faces outward. */
const signedVolume = (list) => list.reduce((sum, t) => sum + dot(t.a, cross(t.b, t.c)) / 6, 0);

/** World point back into the plan's own (u, v, y) frame, so a claim can be checked where it was made. */
function toUVY(plan, [wx, wy, wz]) {
  const yaw = plan.garage.frame.yawRad;
  const ux = Math.cos(yaw), uz = Math.sin(yaw);
  const x = -wx, z = -wy;
  return [x * ux + z * uz, -x * uz + z * ux, wz];
}

/**
 * The volume the planner's own parameters SAY it built, computed from `plan.garage` alone.
 *
 * This is the independent half of G18: the geometry is measured by the divergence theorem and the
 * parameters are turned into a volume by hand, and the two have to agree. A flipped face, a missing
 * element or an extrusion that ran the wrong length breaks the agreement; a planner that merely
 * reports the right numbers does not survive it.
 */
function expectedSolidVolume(mod, plan) {
  const G = mod.GARAGE;
  let volume = 0;
  for (const unit of plan.garage.units) {
    const roof = unit.roof;
    const unitLength = unit.uHi - unit.uLo;
    const slabLength = unitLength + 2 * roof.overhangM;
    if (roof.form === 'ridged') {
      // Two parallelogram slabs, each `halfSpan + overhang` wide in v and `thickness` deep in y.
      volume += 2 * (roof.halfSpanM + roof.overhangM) * G.roofSlabThicknessM * slabLength;
      // Two gable wedges: half the span by the rise, extruded through the end-wall thickness.
      volume += 2 * (0.5 * roof.spanM * roof.riseM) * G.endWallThicknessM;
      // The ridge cap.
      volume += 2 * G.ridgeCapHalfWidthM * G.ridgeCapProudM * slabLength;
    } else {
      volume += (roof.spanM + 2 * roof.overhangM) * G.roofSlabThicknessM * slabLength;
      volume += 2 * (0.5 * roof.spanM * roof.riseM) * G.endWallThicknessM;
      // The upstand band closing the high face.
      volume += G.endWallThicknessM * roof.riseM * unitLength;
    }
  }
  return volume;
}

// --------------------------------------------------------------------------------------------- //
// The assertions. Each is a named object so the mutation harness can ask which ones rejected a
// mutant, exactly as scripts/building-archetype.test.mjs does.
// --------------------------------------------------------------------------------------------- //

const PINNED_TRIANGLES = {
  //          slabs endWalls ridgeCap upstand doors total
  0: [12, 16, 0, 12, 8, 48],
  1: [12, 16, 0, 12, 8, 48],
  2: [12, 16, 0, 12, 22, 62],
  3: [24, 16, 12, 0, 48, 100],
  4: [24, 16, 12, 0, 56, 108],
  5: [12, 16, 0, 12, 4, 44],
  6: [12, 16, 0, 12, 4, 44],
  7: [12, 16, 0, 12, 28, 68],
  8: [24, 16, 12, 0, 28, 80],
  9: [24, 16, 12, 0, 36, 88],
  10: [48, 32, 24, 0, 48, 152],
  11: [24, 16, 12, 0, 36, 88],
};
const PINNED_TRIANGLE_TOTAL = 930;

const ASSERTIONS = [
  {
    id: 'G1-plan-validates',
    run(mod) {
      const plans = plansOf(mod);
      assert.equal(plans.length, 12, 'the router sends twelve buildings to the garage planner');
      for (const plan of plans) {
        validateDetailPlan(plan, { buildingCount: BUILDINGS.length, archetype: 'garage' });
        assert.ok(plan.mesh, `building ${plan.buildingIndex}: a garage with no mesh is an undressed garage`);
        assert.ok(plan.mesh.indices.length >= 3, `building ${plan.buildingIndex}: empty index buffer`);
        assert.equal(plan.instances.length, 0, 'this planner declares no instanced families');
      }
    },
  },
  {
    id: 'G2-garages-only',
    run(mod) {
      // Every non-garage row must come back null: the router owns routing, and a planner that
      // quietly accepts anything handed to it becomes a second, competing router.
      for (const [index, record] of ROUTED.assignments.entries()) {
        if (record.archetype === 'garage') continue;
        assert.equal(planFor(mod, index), null, `building ${index} is ${record.archetype}, not a garage`);
      }
      const covered = new Set(plansOf(mod).map((plan) => plan.buildingIndex));
      assert.deepEqual([...covered].sort((a, b) => a - b), [...GARAGE_INDICES].sort((a, b) => a - b));
    },
  },
  {
    id: 'G3-non-degenerate',
    run(mod) {
      for (const plan of plansOf(mod)) {
        for (const [ordinal, triangle] of triangles(plan).entries()) {
          for (const point of [triangle.a, triangle.b, triangle.c]) {
            assert.ok(point.every(Number.isFinite), `building ${plan.buildingIndex} triangle ${ordinal}: non-finite vertex`);
          }
          assert.ok(
            triangleArea(triangle) > 1e-4,
            `building ${plan.buildingIndex} triangle ${ordinal}: area ${triangleArea(triangle)} m2 is degenerate`,
          );
        }
      }
    },
  },
  {
    id: 'G4-seated-on-the-building',
    run(mod) {
      for (const plan of plansOf(mod)) {
        const G = mod.GARAGE;
        const { baseY, wallHeadY, riseCapM, frame } = plan.garage;
        const maxOverhang = Math.max(...plan.garage.units.map((unit) => unit.roof.overhangM));
        const maxSlope = Math.max(...plan.garage.units.map((unit) => unit.roof.slope));
        const floor = wallHeadY - maxOverhang * maxSlope - 1e-6;
        const ceiling = wallHeadY + riseCapM + G.roofSlabThicknessM + G.ridgeCapProudM + 1e-6;
        // A hard 0.25 m, NOT `G.doorProudM`: measuring the doors against the planner's own idea of
        // how far proud they stand is a check that cannot fail when that number is wrong.
        const margin = maxOverhang + 0.25;
        for (let vertex = 0; vertex < plan.mesh.positions.length / 3; vertex++) {
          const [u, v, y] = toUVY(plan, vertexAt(plan.mesh, vertex));
          // Nothing may sink below the wall base and nothing may float above the envelope.
          assert.ok(y >= baseY - 1e-6, `building ${plan.buildingIndex}: vertex at y ${y} is below the wall base ${baseY}`);
          assert.ok(y <= ceiling, `building ${plan.buildingIndex}: vertex at y ${y} exceeds the envelope ceiling ${ceiling}`);
          // Roof geometry specifically must meet the wall head, not hover over it or hide in it.
          assert.ok(
            y >= floor || y <= wallHeadY,
            `building ${plan.buildingIndex}: vertex at y ${y} is neither on the building nor under its eave`,
          );
          // And nothing may drift off the footprint sideways.
          assert.ok(
            u >= frame.uMin - margin && u <= frame.uMax + margin && v >= frame.vMin - margin && v <= frame.vMax + margin,
            `building ${plan.buildingIndex}: vertex (${u.toFixed(2)}, ${v.toFixed(2)}) is off the footprint`,
          );
        }
        // The roof's lowest point is its eave, and the eave belongs to the wall head.
        const lowestRoof = Math.min(...triangles(plan)
          .filter((t) => t.slot === MATERIAL_SLOT_INDEX.roof)
          .flatMap((t) => [t.a[2], t.b[2], t.c[2]]));
        assert.ok(
          lowestRoof >= floor && lowestRoof <= wallHeadY + 1e-6,
          `building ${plan.buildingIndex}: roof bottom ${lowestRoof} is not seated on the wall head ${wallHeadY}`,
        );
      }
    },
  },
  {
    id: 'G5-deck-envelope',
    run(mod) {
      for (const plan of plansOf(mod)) {
        const cap = mod.ridgeRiseCap(ROUTED.assignments[plan.buildingIndex].heightM);
        assert.ok(Math.abs(cap - plan.garage.riseCapM) < 1e-9);
        for (const unit of plan.garage.units) {
          assert.ok(
            unit.roof.riseM <= cap + 1e-9,
            `building ${plan.buildingIndex}: rise ${unit.roof.riseM} m exceeds the deck.gl gable envelope ${cap} m`,
          );
          const peak = Math.max(...triangles(plan).flatMap((t) => [t.a[2], t.b[2], t.c[2]]));
          assert.ok(
            peak <= plan.garage.wallHeadY + cap + mod.GARAGE.roofSlabThicknessM + mod.GARAGE.ridgeCapProudM + 1e-6,
            `building ${plan.buildingIndex}: peak ${peak} stands above the accepted envelope`,
          );
        }
      }
    },
  },
  {
    id: 'G6-plausible-pitch',
    run(mod) {
      for (const plan of plansOf(mod)) {
        for (const unit of plan.garage.units) {
          assert.ok(
            unit.roof.pitchDeg >= 6 && unit.roof.pitchDeg <= 20,
            `building ${plan.buildingIndex}: achieved pitch ${unit.roof.pitchDeg.toFixed(2)} deg is not a roof anyone builds`,
          );
          assert.ok(unit.roof.riseM >= mod.GARAGE.minRiseM);
        }
      }
    },
  },
  {
    id: 'G7-lane-merge',
    run(mod) {
      const byIndex = new Map(plansOf(mod).map((plan) => [plan.buildingIndex, plan]));
      // The four Storage sheds are the measurement this threshold came from. Three are solid
      // rectangles with a 0.01-0.63 m jog and must stay ONE unit; shed 10's step is 4.29 m and must
      // become two.
      for (const index of [8, 9, 11]) {
        const plan = byIndex.get(index);
        assert.equal(plan.garage.laneCount, 2, `building ${index} is a back-to-back shed`);
        assert.equal(plan.garage.merged, true, `building ${index}: a sub-metre jog must not become a wing`);
        assert.equal(plan.garage.units.length, 1, `building ${index}: one mass, one ridge`);
        assert.ok(
          Math.max(...plan.garage.laneOffsets) < 1.5,
          `building ${index}: measured lane offsets ${plan.garage.laneOffsets} are no longer in the merged band`,
        );
      }
      const shed = byIndex.get(10);
      assert.equal(shed.garage.merged, false, 'building 10 has a real 4.29 m step and must not be merged away');
      assert.equal(shed.garage.units.length, 2, 'building 10: two lanes of different lengths, two ridges');
      assert.ok(Math.max(...shed.garage.laneOffsets) >= 1.5);
      // The eight single-depth ranks are never split.
      for (const plan of plansOf(mod)) {
        if (plan.garage.depthM < 10) {
          assert.equal(plan.garage.laneCount, 1, `building ${plan.buildingIndex}: a 6 m deep rank is one lane`);
        }
      }
    },
  },
  {
    id: 'G8-no-spine-wall',
    run(mod) {
      // The coherence judge's finding, made executable: on a merged back-to-back shed there is no
      // wall down the middle. Every vertex BELOW the wall head therefore belongs to an outer face —
      // the ridge and the gable apex sit above it and are allowed.
      for (const plan of plansOf(mod)) {
        if (!(plan.garage.laneCount === 2 && plan.garage.merged)) continue;
        const { vMin, vMax } = plan.garage.frame;
        const middle = (vMin + vMax) / 2;
        const halfDepth = (vMax - vMin) / 2;
        for (let vertex = 0; vertex < plan.mesh.positions.length / 3; vertex++) {
          const [, v, y] = toUVY(plan, vertexAt(plan.mesh, vertex));
          if (y >= plan.garage.wallHeadY - 1e-6) continue;
          assert.ok(
            Math.abs(v - middle) >= 0.4 * halfDepth,
            `building ${plan.buildingIndex}: geometry at v ${v.toFixed(2)}, ${y.toFixed(2)} m is a spine wall the footprint does not have`,
          );
        }
      }
    },
  },
  {
    id: 'G9-doors-on-the-wall',
    run(mod) {
      for (const plan of plansOf(mod)) {
        const doors = triangles(plan).filter((t) => t.slot === MATERIAL_SLOT_INDEX.dark);
        assert.ok(doors.length > 0, `building ${plan.buildingIndex}: a garage with no doors is a shed`);
        // A door is APPLIED to a wall face. The tolerance is a hard 0.25 m, deliberately not
        // `GARAGE.doorProudM`: comparing the doors against the planner's own idea of how far proud
        // they stand is a check that moves with the defect and can therefore never catch one.
        const faces = plan.garage.ranks.map((rank) => ({ v: rank.vFace, sign: rank.faceSign }));
        for (const triangle of doors) {
          for (const point of [triangle.a, triangle.b, triangle.c]) {
            const [u, v, y] = toUVY(plan, point);
            assert.ok(
              faces.some((face) => {
                const offset = (v - face.v) * face.sign;
                return offset >= 0 && offset <= 0.25;
              }),
              `building ${plan.buildingIndex}: a door vertex at v ${v.toFixed(3)} is not applied to any wall face (${faces.map((f) => f.v.toFixed(3))})`,
            );
            assert.ok(
              y >= plan.garage.baseY - 1e-6 && y <= plan.garage.wallHeadY + 1e-6,
              `building ${plan.buildingIndex}: a door reaches y ${y.toFixed(2)}, outside the wall [${plan.garage.baseY.toFixed(2)}, ${plan.garage.wallHeadY.toFixed(2)}]`,
            );
            assert.ok(
              u >= plan.garage.frame.uMin - 1e-6 && u <= plan.garage.frame.uMax + 1e-6,
              `building ${plan.buildingIndex}: a door at u ${u.toFixed(2)} runs off the end of its rank`,
            );
          }
        }
        // Each rank's declared door count is the count actually emitted (2 triangles per door).
        const declared = plan.garage.ranks.reduce((sum, rank) => sum + rank.doorCount, 0);
        assert.equal(doors.length, declared * 2, `building ${plan.buildingIndex}: emitted doors do not match the reported count`);
      }
    },
  },
  {
    id: 'G10-bay-rhythm',
    run(mod) {
      const G = mod.GARAGE;
      for (const plan of plansOf(mod)) {
        for (const rank of plan.garage.ranks) {
          assert.ok(
            rank.bayPitchM >= G.minBayPitchM - 1e-9 && rank.bayPitchM <= G.maxBayPitchM + 1e-9,
            `building ${plan.buildingIndex}: bay pitch ${rank.bayPitchM.toFixed(2)} m is not a garage rhythm`,
          );
          assert.ok(
            rank.doorWidthM >= G.minDoorWidthM - 1e-9,
            `building ${plan.buildingIndex}: door ${rank.doorWidthM.toFixed(2)} m wide is not a vehicle bay`,
          );
          assert.ok(rank.doorHeightM >= G.minDoorHeightM - 1e-9 && rank.doorHeightM <= G.maxDoorHeightM + 1e-9);
          assert.ok(
            rank.doorHeightM <= ROUTED.assignments[plan.buildingIndex].heightM - 0.5,
            `building ${plan.buildingIndex}: the door leaves no header under the wall head`,
          );
          assert.ok(rank.bays >= 1 && Number.isInteger(rank.bays));
        }
      }
    },
  },
  {
    id: 'G11-blank-bay-varies',
    run(mod) {
      const ranks = plansOf(mod).flatMap((plan) => plan.garage.ranks);
      const long = ranks.filter((rank) => rank.bays >= mod.GARAGE.blankBayMinBays);
      assert.ok(long.length >= 10, 'most garage ranks are long enough to carry a blank bay');
      for (const rank of long) {
        assert.ok(rank.blankBay >= 0 && rank.blankBay < rank.bays, 'a long rank carries exactly one blank bay');
      }
      for (const rank of ranks.filter((r) => r.bays < mod.GARAGE.blankBayMinBays)) {
        assert.equal(rank.blankBay, -1, 'a two-bay garage does not brick one of them up');
      }
      const distinct = new Set(long.map((rank) => rank.blankBay));
      assert.ok(
        distinct.size >= 4,
        `the blank bay lands in ${distinct.size} distinct positions across ${long.length} ranks — it is not varying`,
      );
    },
  },
  {
    id: 'G12-variation-is-real',
    run(mod) {
      const plans = plansOf(mod);
      const roofForms = new Set(plans.map((plan) => plan.garage.units[0].roof.form));
      assert.deepEqual([...roofForms].sort(), ['mono-pitch', 'ridged'], 'both roof forms are present');
      assert.deepEqual(
        [...new Set(plans.map((plan) => plan.garage.units.length))].sort(),
        [1, 2],
        'both a one-mass and a two-mass plan are present',
      );
      assert.deepEqual(
        [...new Set(plans.map((plan) => plan.garage.ranks.length))].sort(),
        [1, 2],
        'both single-rank and back-to-back garages are present',
      );
      const bayCounts = new Set(plans.flatMap((plan) => plan.garage.ranks.map((rank) => rank.bays)));
      assert.ok(bayCounts.size >= 6, `only ${bayCounts.size} distinct bay counts across twelve garages`);
      const triangleCounts = new Set(plans.map((plan) => plan.mesh.indices.length));
      assert.ok(triangleCounts.size >= 7, `only ${triangleCounts.size} distinct meshes across twelve garages`);
      // Two named real buildings that must not be treated the same way.
      const small = plans.find((plan) => plan.buildingIndex === 0);
      const long = plans.find((plan) => plan.buildingIndex === 3);
      assert.notEqual(small.garage.units[0].roof.form, long.garage.units[0].roof.form);
      assert.notEqual(small.garage.ranks[0].bays, long.garage.ranks[0].bays);
      assert.notEqual(small.mesh.indices.length, long.mesh.indices.length);
    },
  },
  {
    id: 'G13-door-face-follows-terrain',
    run(mod) {
      // The rule is "a rank cut into a slope opens downhill". Flip the hill; every single-rank
      // garage must turn round. Anything that reports a terrain decision without making one — the
      // handoff §6.4 shape — survives the first ramp and dies on the second.
      const singles = GARAGE_INDICES.filter((index) => {
        const plan = planFor(mod, index, flatGroundYAt);
        return plan && plan.garage.laneCount === 1;
      });
      assert.ok(singles.length === 8, `expected eight single-rank garages, got ${singles.length}`);
      let flipped = 0;
      for (const index of singles) {
        const rising = planFor(mod, index, crossRampGroundYAt(index, +1));
        const falling = planFor(mod, index, crossRampGroundYAt(index, -1));
        for (const plan of [rising, falling]) {
          assert.equal(plan.garage.units[0].faceReason, 'terrain:downhill', `building ${index}: a 1:2 cross-slope is not flat ground`);
        }
        const before = rising.garage.ranks[0].faceSign;
        const after = falling.garage.ranks[0].faceSign;
        assert.equal(before, -after, `building ${index}: the door face did not follow the hill (${before} then ${after})`);
        flipped += 1;
      }
      assert.equal(flipped, 8);
      // And on genuinely flat ground the seed decides, differently for different buildings.
      const flat = singles.map((index) => planFor(mod, index, flatGroundYAt));
      for (const plan of flat) assert.equal(plan.garage.units[0].faceReason, 'seed:flat-ground-tie');
      assert.equal(new Set(flat.map((plan) => plan.garage.ranks[0].faceSign)).size, 2, 'the seed tie-break is not a constant');
    },
  },
  {
    id: 'G14-deterministic',
    run(mod) {
      for (const index of GARAGE_INDICES) {
        const first = planFor(mod, index);
        const second = planFor(mod, index);
        assert.deepEqual([...first.mesh.positions], [...second.mesh.positions], `building ${index}: positions are not reproducible`);
        assert.deepEqual([...first.mesh.indices], [...second.mesh.indices], `building ${index}: indices are not reproducible`);
        assert.deepEqual(first.mesh.groups, second.mesh.groups);
      }
    },
  },
  {
    id: 'G15-draw-call-delta',
    run(mod) {
      const plans = plansOf(mod);
      const delta = planDrawCallDelta(plans);
      assert.equal(delta.worstPerBuilding, 1, 'a garage may add exactly one material slot beyond wall/roof');
      assert.equal(delta.instancedFamilies, 0, 'this planner declares no instanced families');
      assert.equal(delta.perBuildingGroups, 12, 'twelve garages, twelve extra groups');
      assert.equal(delta.total, 12);
      assert.ok(delta.framePct < 1, `${delta.framePct.toFixed(2)}% of the frame is over the claim`);
      assert.equal(delta.withinBudget, true);
      const slots = new Set(plans.flatMap((plan) => plan.mesh.groups.map((group) => group.materialSlot)));
      assert.deepEqual(
        [...slots].sort((a, b) => a - b),
        [MATERIAL_SLOT_INDEX.wall, MATERIAL_SLOT_INDEX.roof, MATERIAL_SLOT_INDEX.dark].sort((a, b) => a - b),
      );
    },
  },
  {
    id: 'G16-triangle-inventory',
    run(mod) {
      let total = 0;
      for (const plan of plansOf(mod)) {
        const t = plan.garage.triangles;
        const measured = plan.mesh.indices.length / 3;
        assert.equal(t.total, measured, `building ${plan.buildingIndex}: reported ${t.total} triangles, emitted ${measured}`);
        assert.deepEqual(
          [t.slabs, t.endWalls, t.ridgeCap, t.upstand, t.doors, t.total],
          PINNED_TRIANGLES[plan.buildingIndex],
          `building ${plan.buildingIndex}: the element inventory moved`,
        );
        total += measured;
      }
      assert.equal(total, PINNED_TRIANGLE_TOTAL, 'the archetype-wide triangle cost moved');
    },
  },
  {
    id: 'G17-outward-winding',
    run(mod) {
      // A closed solid wound outward has positive volume; one flipped face makes the sum wrong.
      // Doors are open quads and are excluded, which is why they get their own assertion (G9).
      for (const plan of plansOf(mod)) {
        const solid = triangles(plan).filter((t) => t.slot !== MATERIAL_SLOT_INDEX.dark);
        const measured = signedVolume(solid);
        const expected = expectedSolidVolume(mod, plan);
        assert.ok(expected > 0);
        assert.ok(
          Math.abs(measured - expected) <= 1e-4 * expected + 1e-6,
          `building ${plan.buildingIndex}: geometry encloses ${measured.toFixed(4)} m3, its own parameters say ${expected.toFixed(4)} m3`,
        );
      }
    },
  },
  {
    id: 'G18-pure-and-public',
    run(mod) {
      // A mutant carries its own text: scanning the file on disk would read the pristine source and
      // pass no matter what the module under test actually contains.
      const source = mod.__source ?? readFileSync(GARAGE_SRC, 'utf8');
      // Comments are stripped first: the module DOCUMENTS that Math.random is forbidden, and a scan
      // that trips over its own doc comment is a scan nobody can keep.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const banned of ['Math.random', '.local-game-derived', '.local-candidates', 'require(', 'document.', 'window.']) {
        assert.ok(!code.includes(banned), `src/building-detail/garage.js must not contain ${banned}`);
      }
      assert.ok(!/from ['"]three['"]/.test(code), 'a planner may not import THREE');
      // The look may not reach a planner: geometry is identical in both skins by construction.
      assert.throws(
        () => mod.planDetail(BUILDINGS[GARAGE_INDICES[0]], {
          buildingIndex: GARAGE_INDICES[0],
          classification: ROUTED.assignments[GARAGE_INDICES[0]],
          seat: seatBuilding(BUILDINGS[GARAGE_INDICES[0]], flatGroundYAt),
          groundYAt: flatGroundYAt,
          look: 'realistic',
        }),
        /forbidden/,
        'a context carrying `look` must be rejected',
      );
    },
  },
];

for (const assertion of ASSERTIONS) {
  test(`garage: ${assertion.id}`, async () => {
    const mod = await import(pathToFileURL(GARAGE_SRC).href);
    assertion.run(mod);
  });
}

// --------------------------------------------------------------------------------------------- //
// Part 2 — proof that each assertion discriminates.
// --------------------------------------------------------------------------------------------- //

const scratch = await mkdtemp(join(tmpdir(), 'tz-garage-mut-'));
test.after(() => rm(scratch, { recursive: true, force: true }));

const SOURCE = await readFile(GARAGE_SRC, 'utf8');

/**
 * Apply one mutation to the REAL shipped source and import the result.
 *
 * The mutant is written to a temp directory, so its two relative imports are rewritten to absolute
 * file URLs first — the point is to mutate this module, not to give it different dependencies.
 */
async function loadMutant(id, edits) {
  let mutated = SOURCE;
  for (const [find, replace] of edits) {
    assert.ok(
      mutated.includes(find),
      `MUTATION HARNESS ROTTED: "${id}" searches for a string that is no longer in src — ${JSON.stringify(find.slice(0, 90))}`,
    );
    mutated = mutated.replace(find, replace);
  }
  assert.notEqual(mutated, SOURCE, `mutation "${id}" changed nothing`);
  const mutantSource = mutated;
  mutated = mutated
    .replace("from './contract.js'", `from ${JSON.stringify(pathToFileURL(join(ROOT, 'src/building-detail/contract.js')).href)}`)
    .replace("from '../three-world.js'", `from ${JSON.stringify(pathToFileURL(join(ROOT, 'src/three-world.js')).href)}`);
  const file = join(scratch, `garage-${id}.mjs`);
  await writeFile(file, mutated, 'utf8');
  const mod = await import(pathToFileURL(file).href);
  return { ...mod, __mutantId: id, __source: mutantSource };
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
    id: 'merge-everything', expect: 'G7-lane-merge',
    doc: 'raise the merge threshold past shed 10 s real 4.29 m step, erasing the only articulated garage plan',
    edits: [['laneMergeM: 1.5,', 'laneMergeM: 6,']],
  },
  {
    id: 'merge-nothing', expect: 'G7-lane-merge',
    doc: 'drop the threshold under the sheds 0.63 m jogs, so a rounding artefact becomes three fake wings',
    edits: [['laneMergeM: 1.5,', 'laneMergeM: 0.2,']],
  },
  {
    id: 'spine-wall', expect: 'G8-no-spine-wall',
    doc: 'hang the first rank of a back-to-back shed on the middle of the plan — the spine the judge measured is not there',
    edits: [['{ faceSign: -1, vFace: decomposition.lanes[0].vLo }', '{ faceSign: -1, vFace: decomposition.lanes[0].vHi }']],
  },
  {
    id: 'uncapped-rise', expect: 'G5-deck-envelope',
    doc: 'drop the deck.gl envelope cap, so a 15.4 m shed grows a 1.92 m ridge on a 4 m building',
    edits: [['const riseM = Math.min(halfSpanM * Math.tan(GARAGE.ridgePitchDeg * DEG), capM);', 'const riseM = halfSpanM * Math.tan(GARAGE.ridgePitchDeg * DEG);']],
  },
  {
    id: 'alpine-pitch', expect: 'G6-plausible-pitch',
    doc: 'ask for a 40 degree gable; the cap holds the height but the achieved pitch is no longer a shed',
    edits: [['ridgePitchDeg: 14,', 'ridgePitchDeg: 40,']],
  },
  {
    id: 'flat-mono', expect: 'G6-plausible-pitch',
    doc: 'flatten the single-fall roofs to 2 degrees, which is a drainage fall, not a roof form',
    edits: [['monoPitchDeg: 7,', 'monoPitchDeg: 2,']],
  },
  {
    id: 'roof-on-the-ground', expect: 'G4-seated-on-the-building',
    doc: 'seat the roof on the wall BASE instead of the wall head — the bridge-under-water defect, for roofs',
    edits: [['const wallHeadY = baseY + heightM;', 'const wallHeadY = baseY;']],
  },
  {
    id: 'floating-doors', expect: 'G9-doors-on-the-wall',
    doc: 'stand the doors 3 m off the wall face; they still render, just not on the building',
    edits: [['doorProudM: 0.06,', 'doorProudM: 3,']],
  },
  {
    id: 'hangar-bays', expect: 'G10-bay-rhythm',
    doc: 'remove the bay-pitch walk and start from one bay, giving a single 104 m door',
    edits: [
      ['let bays = Math.max(1, Math.round(length / GARAGE.targetBayPitchM));', 'let bays = 1;'],
      ['while (length / bays > GARAGE.maxBayPitchM) bays += 1;', ''],
    ],
  },
  {
    id: 'blank-bay-constant', expect: 'G11-blank-bay-varies',
    doc: 'put every rank s blank bay in the same place, so twelve ranks read as one stamped asset',
    edits: [['? ((seed ^ (faceSign > 0 ? 0x9e3779b9 : 0)) >>> 0) % bays', '? 0']],
  },
  {
    id: 'no-blank-bays', expect: 'G11-blank-bay-varies',
    doc: 'raise the blank-bay threshold out of reach, so every rank is perfectly regular',
    edits: [['blankBayMinBays: 4,', 'blankBayMinBays: 99,']],
  },
  {
    id: 'terrain-ignored', expect: 'G13-door-face-follows-terrain',
    doc: 'never take the terrain branch; the door face becomes a seed flip that still reports a face',
    edits: [['if (Math.abs(deltaM) >= GARAGE.doorFaceTieM) {', 'if (false) {']],
  },
  {
    id: 'everything-is-flat', expect: 'G13-door-face-follows-terrain',
    doc: 'widen the flat-ground tie band to 900 m, which makes Customs flat',
    edits: [['doorFaceTieM: 0.15,', 'doorFaceTieM: 900,']],
  },
  {
    id: 'doors-take-the-wall-slot', expect: 'G15-draw-call-delta',
    doc: 'draw the doors in the wall colour: zero extra draw calls, and no doors anybody can see',
    edits: [['sink, frame, MATERIAL_SLOT_INDEX.dark,', 'sink, frame, MATERIAL_SLOT_INDEX.wall,']],
  },
  {
    id: 'no-end-walls', expect: 'G16-triangle-inventory',
    doc: 'collapse the gable and wedge end walls to zero thickness, opening both ends of every roof',
    edits: [['endWallThicknessM: 0.22,', 'endWallThicknessM: 0,']],
  },
  {
    id: 'zero-height-ridge-cap', expect: 'G3-non-degenerate',
    doc: 'give the ridge cap no height, so it ships as a fan of zero-area triangles',
    edits: [['ridgeCapProudM: 0.1,', 'ridgeCapProudM: 0,']],
  },
  {
    id: 'winding-unchecked', expect: 'G17-outward-winding',
    doc: 'trust the incoming vertex order instead of the outward reference — half the faces end up inside out',
    edits: [['const order = dot >= 0 ? ids : [...ids].reverse();', 'const order = ids;']],
  },
  {
    id: 'no-roof-at-all', expect: 'G1-plan-validates',
    doc: 'raise the minimum rise past every garage, so every plan comes back empty but still valid',
    edits: [['minRiseM: 0.12,', 'minRiseM: 9,']],
  },
  {
    id: 'accepts-any-archetype', expect: 'G2-garages-only',
    doc: 'drop the archetype guard, so the garage planner starts dressing warehouses and cooling towers',
    edits: [["if (!classification || classification.archetype !== 'garage') return null;", 'if (!classification) return null;']],
  },
  {
    id: 'one-roof-form', expect: 'G12-variation-is-real',
    doc: 'give every garage a ridge, discarding what the authored style says',
    edits: [['const roof = planUnitRoof(unit, classification.roofForm,', "const roof = planUnitRoof(unit, 'ridged',"]],
  },
  {
    id: 'seed-becomes-a-counter', expect: 'G14-deterministic',
    doc: 'take variation from a call counter instead of the footprint hash — reproducible run to run is gone',
    edits: [['const seed = classification.seed >>> 0;', 'const seed = ((globalThis.__tzGarageTick = (globalThis.__tzGarageTick | 0) + 1) * 2654435761) >>> 0;']],
  },
  {
    id: 'randomness-creeps-in', expect: 'G18-pure-and-public',
    doc: 'reach for Math.random, which is unavailable in the renderer and would make it irreproducible',
    edits: [['const DEG = Math.PI / 180;', 'const DEG = Math.PI / 180;\nconst jitter = () => Math.random();']],
  },
];

for (const mutation of MUTATIONS) {
  test(`discriminates [${mutation.expect}] <- mutation "${mutation.id}": ${mutation.doc}`, async () => {
    const mutant = await loadMutant(mutation.id, mutation.edits);
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

test('the unmutated module passes every assertion', async () => {
  const mod = await import(pathToFileURL(GARAGE_SRC).href);
  assert.deepEqual(caughtBy(mod), []);
});
