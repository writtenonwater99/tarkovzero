/**
 * The lattice-tower detail planner, asserted against the REAL four Customs powerline pylons.
 *
 * Run: `node --test scripts/building-detail-lattice-tower.test.mjs`
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS FILE HAS A MUTATION HARNESS
 *
 * Handoff §6 records five separate occasions in one day on which this project reported success
 * while something had silently fallen back, and `scripts/building-archetype.test.mjs` caught a
 * sixth before it shipped. The rule: an assertion that cannot fail is worse than no assertion.
 *
 * So Part 2 below takes the SHIPPED source text of `src/building-detail/lattice-tower.js`, applies
 * one targeted mutation, imports the result, and re-runs the whole assertion set against it. A
 * mutation nothing catches is a test failure, a mutation not caught by the assertion that is
 * supposed to catch it is a test failure, and a mutation whose search string is no longer in the
 * source is a test failure too — so the harness cannot rot into a no-op.
 *
 * ---------------------------------------------------------------------------------------------
 * THE ONE METRIC THAT MATTERS, AND WHY IT IS A RASTER AND NOT A TRIANGLE COUNT
 *
 * The defect is that four buildings are drawn as 22 m SOLID BOXES. A triangle count cannot tell a
 * lattice from a box — a finely tessellated box has plenty of triangles. What actually has to
 * change is COVERAGE: how much of the tower's own silhouette rectangle is filled in. `silhouette()`
 * below orthographically rasterises the plan's real position/index buffers from two perpendicular
 * horizontal directions and reports that fraction. A solid box returns 1.0 (asserted, on a
 * synthetic box, in the same assertion — so the metric is shown able to report "solid"), and the
 * four real towers must come in under 0.45.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { classifyAll, classifyBuilding } from '../src/building-archetype.js';
import { planDrawCallDelta, validateDetailPlan, validatePlannerContext, MATERIAL_SLOT_INDEX } from '../src/building-detail/contract.js';
import * as latticeModule from '../src/building-detail/lattice-tower.js';
import { seatBuilding } from '../src/buildings.js';
import { makeTerrainSampler } from '../src/three-world.js';

const LATTICE_SRC = new URL('../src/building-detail/lattice-tower.js', import.meta.url);
const CONTRACT_URL = new URL('../src/building-detail/contract.js', import.meta.url);
const LATTICE_SOURCE = await readFile(LATTICE_SRC, 'utf8');

const customs3d = JSON.parse(await readFile(new URL('../public/data/customs-3d.json', import.meta.url), 'utf8'));
const BUILDINGS = customs3d.buildings;
const BUILDING_COUNT = BUILDINGS.length;

/**
 * The renderer's own draped sampler, at the DEFAULT relief of 3. Relief 3 is not a detail: it is
 * what turns the 0.6 m of real cross-slope under tower 67 into 1.84 m of displayed cross-slope, and
 * therefore what makes per-leg seating visible rather than academic. `makeTerrainSampler` is the
 * function `src/map3d-three.js` uses, imported rather than re-implemented — and it is in
 * `three-world.js`, which has zero imports, so this suite does not pay drvfs's 197 s deck.gl tax.
 */
const RELIEF = 3;
const groundYAt = makeTerrainSampler(customs3d.terrain, RELIEF);

const ROUTED = classifyAll(BUILDINGS);
const TOWER_INDICES = ROUTED.byArchetype['lattice-tower'];

/** Build the contract-shaped context for one building. Exactly `PLANNER_CONTEXT_KEYS`, no more. */
function contextFor(index) {
  const seated = seatBuilding(BUILDINGS[index], groundYAt);
  return validatePlannerContext({
    buildingIndex: index,
    classification: ROUTED.assignments[index],
    seat: {
      baseY: seated.base,
      contactY: seated.contact,
      loY: seated.lo,
      hiY: seated.hi,
      plinthBaseY: seated.plinthBase,
      plinthHeightM: seated.plinthHeight,
    },
    groundYAt,
  });
}

const CONTEXTS = new Map(TOWER_INDICES.map((index) => [index, contextFor(index)]));

/** Plan all four towers with a given module namespace. Used for the real module and every mutant. */
const planAll = (mod) => TOWER_INDICES.map((index) => mod.planDetail(BUILDINGS[index], CONTEXTS.get(index)));

// --------------------------------------------------------------------------------------------- //
// Measurement helpers. These live in the TEST, never in the module: a planner that graded its own
// silhouette would be marking its own homework.
// --------------------------------------------------------------------------------------------- //

/** Every vertex of a mesh as [x, y, z] triples in world space. */
function vertices(mesh) {
  const out = [];
  for (let index = 0; index < mesh.positions.length; index += 3) {
    out.push([mesh.positions[index], mesh.positions[index + 1], mesh.positions[index + 2]]);
  }
  return out;
}

/**
 * Orthographic silhouette coverage, viewing horizontally along `direction` (a world-XY unit vector).
 *
 * The mesh's own bounding rectangle in that projection is the denominator, so the number answers
 * exactly one question: "of the box this object occupies on screen, how much is filled in?" A solid
 * prism answers ~1; an openwork tower answers a third of that. Triangles are rasterised with a
 * half-space test at cell centres — no anti-aliasing, because the question is coverage, not looks.
 */
function silhouette(mesh, direction, cells = 96) {
  const points = vertices(mesh).map(([x, y, z]) => [x * -direction[1] + y * direction[0], z]);
  if (!points.length) return { fill: 0, filled: 0, cells };
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const [u, v] of points) {
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  const stepU = (maxU - minU) / cells;
  const stepV = (maxV - minV) / cells;
  if (!(stepU > 0) || !(stepV > 0)) return { fill: 0, filled: 0, cells };
  const grid = new Uint8Array(cells * cells);
  for (let triangle = 0; triangle < mesh.indices.length; triangle += 3) {
    const [ax, ay] = points[mesh.indices[triangle]];
    const [bx, by] = points[mesh.indices[triangle + 1]];
    const [cx, cy] = points[mesh.indices[triangle + 2]];
    const au = (ax - minU) / stepU, av = (ay - minV) / stepV;
    const bu = (bx - minU) / stepU, bv = (by - minV) / stepV;
    const cu = (cx - minU) / stepU, cv = (cy - minV) / stepV;
    const det = (bu - au) * (cv - av) - (bv - av) * (cu - au);
    if (Math.abs(det) < 1e-12) continue;
    const uLo = Math.max(0, Math.floor(Math.min(au, bu, cu)));
    const uHi = Math.min(cells - 1, Math.ceil(Math.max(au, bu, cu)));
    const vLo = Math.max(0, Math.floor(Math.min(av, bv, cv)));
    const vHi = Math.min(cells - 1, Math.ceil(Math.max(av, bv, cv)));
    for (let row = vLo; row <= vHi; row++) {
      for (let column = uLo; column <= uHi; column++) {
        const qu = column + 0.5, qv = row + 0.5;
        const w0 = ((bu - au) * (qv - av) - (bv - av) * (qu - au)) / det;
        const w1 = ((qu - au) * (cv - av) - (qv - av) * (cu - au)) / det;
        if (w0 >= 0 && w1 >= 0 && w0 + w1 <= 1) grid[row * cells + column] = 1;
      }
    }
  }
  let filled = 0;
  for (const cell of grid) filled += cell;
  return { fill: filled / (cells * cells), filled, cells };
}

/** The worst (most solid) of the two perpendicular horizontal views. */
const worstFill = (mesh) => Math.max(silhouette(mesh, [1, 0]).fill, silhouette(mesh, [0, 1]).fill);

/** A closed 7 x 7 x 22 m box, as mesh data — the control that proves `silhouette` can report solid. */
function solidBoxMesh(halfX = 3.5, halfY = 3.5, height = 22) {
  const corners = [
    [-halfX, -halfY, 0], [halfX, -halfY, 0], [halfX, halfY, 0], [-halfX, halfY, 0],
    [-halfX, -halfY, height], [halfX, -halfY, height], [halfX, halfY, height], [-halfX, halfY, height],
  ];
  const quads = [[0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], [3, 2, 1, 0], [4, 5, 6, 7]];
  const positions = [], indices = [];
  for (const quad of quads) {
    const base = positions.length / 3;
    for (const corner of quad) positions.push(...corners[corner]);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** Footprint-frame coordinates of a world point: metres along the OBB long axis and its normal. */
function footprintFrame(classification, worldPoint) {
  const { yawRad, centerX, centerZ } = classification.metrics;
  const gameX = -worldPoint[0], gameZ = -worldPoint[1];
  const dx = gameX - centerX, dz = gameZ - centerZ;
  return [
    dx * Math.cos(yawRad) + dz * Math.sin(yawRad),
    -dx * Math.sin(yawRad) + dz * Math.cos(yawRad),
  ];
}

const clamp = (low, value, high) => Math.min(high, Math.max(low, value));

// --------------------------------------------------------------------------------------------- //
// Golden numbers. Pinned, because a silent change of shape moves one of these and nothing else.
// --------------------------------------------------------------------------------------------- //

/** Per tower, in `TOWER_INDICES` order (67, 68, 69, 70). */
const EXPECTED_TOWERS = Object.freeze([
  { index: 67, place: 'Military Checkpoint', armCount: 3, bodyPanels: 3, shaftPanels: 2, members: 94, triangles: 1128 },
  { index: 68, place: 'Powerline Tower', armCount: 3, bodyPanels: 2, shaftPanels: 2, members: 82, triangles: 984 },
  { index: 69, place: null, armCount: 3, bodyPanels: 2, shaftPanels: 2, members: 82, triangles: 984 },
  { index: 70, place: 'Trailer Park', armCount: 2, bodyPanels: 2, shaftPanels: 2, members: 72, triangles: 864 },
]);
const EXPECTED_TOTAL_TRIANGLES = 3960;
/** One extra material group per tower, in the `metal` slot. No instanced family exists for a pylon. */
const EXPECTED_DRAW_CALL_DELTA = 4;
/** Measured worst-view coverage on the real towers is 0.257-0.340; a solid box is 1.0. */
const MAX_SILHOUETTE_FILL = 0.45;
const MIN_SILHOUETTE_FILL = 0.12;
/** Arms overhang the authored footprint; nothing else may. Measured worst overhang is 1.24x. */
const MAX_LONG_AXIS_OVERHANG = 1.45;
const MAX_SHORT_AXIS_OVERHANG = 1.10;

// --------------------------------------------------------------------------------------------- //
// The assertion set. Each entry runs against `{ mod, source }`, so the same set can be re-run
// against a deliberately broken copy of the module below — including the source-text assertions.
// --------------------------------------------------------------------------------------------- //

const ASSERTIONS = [
  {
    id: 'L1-owns-exactly-the-four-pylons',
    doc: 'plans all four routed towers and refuses every other building',
    run: ({ mod }) => {
      assert.deepEqual(TOWER_INDICES, [67, 68, 69, 70], 'the router no longer yields the four pylons');
      const plans = planAll(mod);
      assert.equal(plans.length, 4);
      for (const [ordinal, plan] of plans.entries()) {
        assert.ok(plan, `tower ${TOWER_INDICES[ordinal]}: planner returned no plan`);
        assert.equal(plan.archetype, 'lattice-tower');
        assert.equal(plan.buildingIndex, TOWER_INDICES[ordinal]);
        assert.ok(plan.mesh, `tower ${TOWER_INDICES[ordinal]}: plan carries no mesh`);
        assert.ok(plan.mesh.indices.length > 0, 'a plan with an empty index buffer is not a tower');
      }
      // A planner that dressed a shed as a pylon would be a silent re-route past the one router.
      const shed = BUILDINGS.findIndex((_, index) => ROUTED.assignments[index].archetype === 'small-box');
      assert.equal(
        mod.planDetail(BUILDINGS[shed], { ...CONTEXTS.get(67), buildingIndex: shed, classification: ROUTED.assignments[shed] }),
        null,
      );
    },
  },
  {
    id: 'L2-satisfies-the-detail-contract',
    doc: 'every plan validates, with exactly one contiguous group in the metal slot',
    run: ({ mod }) => {
      for (const plan of planAll(mod)) {
        validateDetailPlan(plan, { buildingCount: BUILDING_COUNT, archetype: 'lattice-tower' });
        assert.deepEqual(plan.instances, [], 'no INSTANCED_FAMILIES entry describes a pylon');
        assert.equal(plan.mesh.groups.length, 1, 'a pylon is one material: galvanised steel');
        assert.equal(plan.mesh.groups[0].materialSlot, MATERIAL_SLOT_INDEX.metal);
        assert.equal(plan.mesh.groups[0].start, 0);
        assert.equal(plan.mesh.groups[0].count, plan.mesh.indices.length);
      }
    },
  },
  {
    id: 'L3-finite-and-non-degenerate',
    doc: 'no NaN, no sliver triangles, every member emitted — and the skip counter can fire',
    run: ({ mod }) => {
      for (const [ordinal, plan] of planAll(mod).entries()) {
        const expected = EXPECTED_TOWERS[ordinal];
        const points = vertices(plan.mesh);
        for (const point of points) {
          for (const value of point) assert.ok(Number.isFinite(value), `tower ${expected.index}: non-finite position`);
        }
        assert.equal(plan.mesh.positions.length / 3, plan.stats.vertexCount);
        assert.equal(plan.mesh.indices.length / 3, plan.stats.triangleCount);
        assert.equal(plan.stats.memberCount, expected.members, `tower ${expected.index}: member count`);
        assert.equal(plan.stats.triangleCount, expected.triangles, `tower ${expected.index}: triangle count`);
        assert.equal(plan.stats.degenerateMembersSkipped, 0, `tower ${expected.index}: a real member was dropped`);
        assert.equal(plan.stats.groundSamplesFallenBack, 0, `tower ${expected.index}: a leg lost its ground sample`);
        let tiny = 0;
        for (let triangle = 0; triangle < plan.mesh.indices.length; triangle += 3) {
          const a = points[plan.mesh.indices[triangle]];
          const b = points[plan.mesh.indices[triangle + 1]];
          const c = points[plan.mesh.indices[triangle + 2]];
          const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
          const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
          const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
          if (!(area > 1e-5)) tiny += 1;
        }
        assert.equal(tiny, 0, `tower ${expected.index}: ${tiny} degenerate triangles`);
      }
      // The counters above read 0 on real data, which is exactly the shape of a metric that cannot
      // fail. So drive them: on a 0.4 m square footprint the upper belts are ~3 cm of steel and
      // MUST come back reported as skipped rather than shipped as slivers.
      const stunted = {
        ...BUILDINGS[TOWER_INDICES[0]],
        poly: [[0, 0], [0.4, 0], [0.4, 0.4], [0, 0.4]],
      };
      const stuntedPlan = mod.planDetail(stunted, {
        ...CONTEXTS.get(TOWER_INDICES[0]),
        classification: classifyBuilding(stunted),
      });
      assert.ok(stuntedPlan.stats.degenerateMembersSkipped > 0, 'a 3 cm member was accepted as steel');
      assert.ok(
        stuntedPlan.notes.some((note) => note.startsWith('DEGRADED:') && note.includes('degenerate')),
        'members were dropped and the plan said nothing about it',
      );
      // ...and a footprint with no oriented bounding box must produce an honest empty plan.
      const flat = { ...BUILDINGS[TOWER_INDICES[0]], poly: [[0, 0], [0, 0], [0, 0], [0, 0]] };
      const flatPlan = mod.planDetail(flat, {
        ...CONTEXTS.get(TOWER_INDICES[0]),
        classification: classifyBuilding(flat),
      });
      assert.equal(flatPlan.mesh, null);
      assert.ok(flatPlan.notes.some((note) => note.startsWith('DEGENERATE FOOTPRINT')));
    },
  },
  {
    id: 'L4-height-is-exactly-the-data-height',
    doc: 'the topmost steel sits at seat.baseY + building.height, and nothing rises above it',
    run: ({ mod }) => {
      for (const [ordinal, plan] of planAll(mod).entries()) {
        const { index } = EXPECTED_TOWERS[ordinal];
        const target = CONTEXTS.get(index).seat.baseY + BUILDINGS[index].height;
        let top = -Infinity;
        for (let cursor = 2; cursor < plan.mesh.positions.length; cursor += 3) {
          if (plan.mesh.positions[cursor] > top) top = plan.mesh.positions[cursor];
        }
        assert.ok(
          Math.abs(top - target) < 1e-3,
          `tower ${index}: topmost steel is ${top.toFixed(4)} m, the data says ${target.toFixed(4)} m`,
        );
      }
    },
  },
  {
    id: 'L5-each-leg-stands-on-its-own-ground',
    doc: 'the four feet follow the draped terrain individually, not one seat plane',
    run: ({ mod }) => {
      const embed = mod.LATTICE_TOWER.footEmbedM;
      for (const [ordinal, plan] of planAll(mod).entries()) {
        const { index } = EXPECTED_TOWERS[ordinal];
        const context = CONTEXTS.get(index);
        const built = mod.latticeTowerPlan(context.classification, context.seat, groundYAt);
        assert.equal(built.feet.length, 4);
        const points = vertices(plan.mesh);
        const footYs = [];
        for (const foot of built.feet) {
          // The foot's Y must be THIS corner's ground, clamped into the seat's measured range.
          const sampled = groundYAt(-foot[0], -foot[1]);
          const expected = clamp(context.seat.loY, sampled, context.seat.hiY) - embed;
          assert.ok(
            Math.abs(foot[2] - expected) < 1e-6,
            `tower ${index}: foot at ${foot[2].toFixed(3)} m, its own ground says ${expected.toFixed(3)} m`,
          );
          // ...and there must be real steel AT that point, not just a plan that reports one. The
          // bound is the leg's own section: a foot cap's corners sit at most halfWidth*sqrt(2) from
          // the node. (A "lowest vertex near the foot" test would be wrong here — on an uphill leg
          // the base-plane bracing ring legitimately sits below the foot.)
          let nearest = Infinity;
          for (const point of points) {
            const distance = Math.hypot(point[0] - foot[0], point[1] - foot[1], point[2] - foot[2]);
            if (distance < nearest) nearest = distance;
          }
          assert.ok(
            nearest <= mod.LATTICE_TOWER.legHalfWidthM * Math.SQRT2 + 1e-3,
            `tower ${index}: nearest steel is ${nearest.toFixed(3)} m from the planned foot`,
          );
          footYs.push(foot[2]);
          // A leg foot never leaves the authored footprint — only arms may overhang.
          const [u1, u2] = footprintFrame(context.classification, foot);
          assert.ok(Math.abs(u1) <= context.classification.metrics.lengthM / 2 + 1e-6);
          assert.ok(Math.abs(u2) <= context.classification.metrics.widthM / 2 + 1e-6);
        }
        // Nothing dives below the deepest foot by more than a leg's own section.
        let lowest = Infinity;
        for (const point of points) if (point[2] < lowest) lowest = point[2];
        assert.ok(
          lowest >= Math.min(...footYs) - mod.LATTICE_TOWER.legHalfWidthM * Math.SQRT2 - 1e-3,
          `tower ${index}: steel at ${lowest.toFixed(3)} m, below the deepest foot ${Math.min(...footYs).toFixed(3)} m`,
        );
        if (index === 67) {
          // Measured: the draped ground under tower 67's corners spans 2.65-4.49 m at relief 3.
          // Seat everything on one plane and this collapses to 0.
          const spread = Math.max(...footYs) - Math.min(...footYs);
          assert.ok(spread > 1.0, `tower 67: leg feet span only ${spread.toFixed(3)} m of a 1.84 m cross-slope`);
        }
      }
    },
  },
  {
    id: 'L6-silhouette-is-open-not-a-box',
    doc: 'coverage of the tower\'s own silhouette rectangle stays under 45%, where a solid box is 100%',
    run: ({ mod }) => {
      // The control first: if the rasteriser cannot report "solid" then nothing below means anything.
      const box = worstFill(solidBoxMesh());
      assert.ok(box > 0.97, `the silhouette metric cannot report a solid box (got ${box.toFixed(3)})`);
      for (const [ordinal, plan] of planAll(mod).entries()) {
        const { index } = EXPECTED_TOWERS[ordinal];
        const fill = worstFill(plan.mesh);
        assert.ok(
          fill < MAX_SILHOUETTE_FILL,
          `tower ${index}: silhouette is ${(fill * 100).toFixed(1)}% solid — still reads as a box`,
        );
        assert.ok(
          fill > MIN_SILHOUETTE_FILL,
          `tower ${index}: silhouette is only ${(fill * 100).toFixed(1)}% solid — a wireframe, not steel`,
        );
      }
    },
  },
  {
    id: 'L7-stays-on-its-own-plot',
    doc: 'arms may overhang the footprint by half a half-width; nothing may sprawl',
    run: ({ mod }) => {
      for (const [ordinal, plan] of planAll(mod).entries()) {
        const { index } = EXPECTED_TOWERS[ordinal];
        const { classification } = CONTEXTS.get(index);
        const halfLong = classification.metrics.lengthM / 2;
        const halfShort = classification.metrics.widthM / 2;
        let worstLong = 0, worstShort = 0;
        for (const point of vertices(plan.mesh)) {
          const [u1, u2] = footprintFrame(classification, point);
          worstLong = Math.max(worstLong, Math.abs(u1) / halfLong);
          worstShort = Math.max(worstShort, Math.abs(u2) / halfShort);
        }
        assert.ok(
          worstLong <= MAX_LONG_AXIS_OVERHANG,
          `tower ${index}: reaches ${worstLong.toFixed(2)}x its footprint along the arm axis`,
        );
        assert.ok(
          worstShort <= MAX_SHORT_AXIS_OVERHANG,
          `tower ${index}: reaches ${worstShort.toFixed(2)}x its footprint across the arm axis`,
        );
      }
    },
  },
  {
    id: 'L8-four-towers-are-four-objects',
    doc: 'variation is real: orientation, arm count, bracing pitch and shaft proportions all differ',
    run: ({ mod }) => {
      const plans = planAll(mod);
      const profiles = plans.map((plan) => plan.profile);
      const distinct = (values) => new Set(values.map((value) => Number(value).toFixed(6))).size;
      assert.equal(distinct(profiles.map((p) => p.yawRad)), 4, 'the four towers no longer face four ways');
      assert.ok(distinct(profiles.map((p) => p.waistFrac)) === 4, 'every tower got the same waist height');
      assert.ok(distinct(profiles.map((p) => p.waistRatio)) === 4, 'every tower got the same shaft width');
      assert.ok(distinct(profiles.map((p) => p.armReachRatio)) === 4, 'every tower got the same arm reach');
      assert.ok(distinct(profiles.map((p) => p.armCount)) >= 2, 'every tower got the same number of arms');
      assert.ok(distinct(profiles.map((p) => p.bodyPanels)) >= 2, 'every tower got the same bracing pitch');
      assert.ok(new Set(profiles.map((p) => p.catHead)).size >= 2, 'every tower is the same head type');
      // Variation the eye can see, not just parameters: the meshes are actually different sizes.
      assert.ok(
        distinct(plans.map((plan) => plan.stats.triangleCount)) >= 2,
        'four identical towers were planned',
      );
      for (const [ordinal, plan] of plans.entries()) {
        const expected = EXPECTED_TOWERS[ordinal];
        assert.equal(plan.profile.armCount, expected.armCount, `tower ${expected.index}: arm count`);
        assert.equal(plan.profile.bodyPanels, expected.bodyPanels, `tower ${expected.index}: body panels`);
        assert.equal(plan.profile.shaftPanels, expected.shaftPanels, `tower ${expected.index}: shaft panels`);
      }
    },
  },
  {
    id: 'L9-deterministic',
    doc: 'the same building planned twice, in either order, gives byte-identical buffers',
    run: ({ mod }) => {
      const first = planAll(mod);
      const reversed = [...TOWER_INDICES].reverse().map((index) => mod.planDetail(BUILDINGS[index], CONTEXTS.get(index)));
      reversed.reverse();
      for (const [ordinal, plan] of first.entries()) {
        assert.deepEqual(Array.from(plan.mesh.positions), Array.from(reversed[ordinal].mesh.positions));
        assert.deepEqual(Array.from(plan.mesh.indices), Array.from(reversed[ordinal].mesh.indices));
      }
    },
  },
  {
    id: 'L10-draw-call-cost-is-what-is-claimed',
    doc: '+4 calls map-wide, no instanced family, and the contract\'s accountant agrees',
    run: ({ mod }) => {
      const plans = planAll(mod);
      const mine = mod.latticeTowerDrawCallDelta(plans);
      const theirs = planDrawCallDelta(plans);
      assert.equal(mine.drawCallDelta, EXPECTED_DRAW_CALL_DELTA);
      assert.equal(mine.instancedFamilies, 0);
      assert.deepEqual(mine.distinctSlots, [MATERIAL_SLOT_INDEX.metal]);
      assert.equal(theirs.total, EXPECTED_DRAW_CALL_DELTA, 'the contract disagrees with this module about cost');
      assert.equal(theirs.instancedFamilies, 0);
      assert.equal(theirs.worstPerBuilding, 1, 'a tower must never need more than one extra slot');
      assert.ok(theirs.withinBudget);
      assert.equal(mine.triangles, EXPECTED_TOTAL_TRIANGLES);
    },
  },
  {
    id: 'L11-tells-the-renderer-to-drop-the-box',
    doc: 'every plan carries replacesMass and suppressPlinth',
    run: ({ mod }) => {
      for (const [ordinal, plan] of planAll(mod).entries()) {
        const { index } = EXPECTED_TOWERS[ordinal];
        assert.equal(plan.replacesMass, true, `tower ${index}: the 22 m box would still be drawn`);
        assert.equal(plan.suppressPlinth, true, `tower ${index}: the skirt would still be drawn`);
        assert.ok(plan.notes.some((note) => note.startsWith('replacesMass:')));
        assert.ok(plan.notes.some((note) => note.startsWith('suppressPlinth:')));
      }
    },
  },
  {
    id: 'L12-a-wrong-seat-is-loud',
    doc: 'a src/buildings.js-shaped seat throws instead of seating four towers at world zero',
    run: ({ mod }) => {
      const context = CONTEXTS.get(TOWER_INDICES[0]);
      const legacy = { base: context.seat.baseY, lo: context.seat.loY, hi: context.seat.hiY };
      assert.throws(
        () => mod.planDetail(BUILDINGS[TOWER_INDICES[0]], { ...context, seat: legacy }),
        /seat\.baseY must be finite/,
      );
    },
  },
  {
    id: 'L13-pure-and-look-blind',
    doc: 'no randomness, no clock, no THREE, no look — geometry cannot depend on the skin',
    run: ({ source }) => {
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const forbidden of ['Math.random', 'Date.now', 'new Date', 'require(', "from 'three'", 'document.', 'window.']) {
        assert.ok(!code.includes(forbidden), `the planner reaches for "${forbidden}"`);
      }
      assert.ok(!/\blook\b/.test(code), 'the planner mentions the look — geometry may not depend on it');
      const imports = code.match(/^import .*$/gm) ?? [];
      assert.deepEqual(
        imports.map((line) => line.trim()),
        ["import { MATERIAL_SLOT_INDEX, emptyDetailPlan } from './contract.js';"],
        'the planner grew an import; it must stay pure and node-testable',
      );
    },
  },
];

// --------------------------------------------------------------------------------------------- //
// Part 1 — the assertions, against the real module.
// --------------------------------------------------------------------------------------------- //

const REAL = { mod: latticeModule, source: LATTICE_SOURCE };

for (const assertion of ASSERTIONS) {
  test(`lattice ${assertion.id}: ${assertion.doc}`, () => assertion.run(REAL));
}

test('lattice: the four planned towers, for the record', () => {
  const rows = planAll(latticeModule).map((plan, ordinal) => {
    const { index, place } = EXPECTED_TOWERS[ordinal];
    const fill = worstFill(plan.mesh);
    return `${index} ${String(place ?? '(unnamed)').padEnd(20)} arms=${plan.profile.armCount} `
      + `panels=${plan.profile.bodyPanels}+${plan.profile.shaftPanels} `
      + `yaw=${(plan.profile.yawRad * 180 / Math.PI).toFixed(1).padStart(6)} deg `
      + `tris=${String(plan.stats.triangleCount).padStart(4)} silhouette=${(fill * 100).toFixed(1)}%`;
  });
  console.log(rows.join('\n'));
  assert.equal(rows.length, 4);
});

// --------------------------------------------------------------------------------------------- //
// Part 2 — proof that each assertion discriminates.
// --------------------------------------------------------------------------------------------- //

const scratch = await mkdtemp(join(tmpdir(), 'tz-lattice-mut-'));
test.after(() => rm(scratch, { recursive: true, force: true }));

/**
 * Apply one mutation to the real source text and import the result.
 *
 * The relative `./contract.js` import is rewritten to an absolute URL because the mutant lives in a
 * temp directory. That rewrite is asserted too: if the import line ever changes shape, this harness
 * fails loudly rather than silently importing an un-mutated module.
 */
async function loadMutant(id, find, replace) {
  assert.ok(
    LATTICE_SOURCE.includes(find),
    `MUTATION HARNESS ROTTED: "${id}" searches for a string that is no longer in src — ${JSON.stringify(find.slice(0, 90))}`,
  );
  const mutated = LATTICE_SOURCE.replace(find, replace);
  assert.notEqual(mutated, LATTICE_SOURCE, `mutation "${id}" changed nothing`);
  const relative = "from './contract.js';";
  assert.ok(mutated.includes(relative), 'MUTATION HARNESS ROTTED: the contract import moved');
  const portable = mutated.replace(relative, `from '${CONTRACT_URL.href}';`);
  const file = join(scratch, `lattice-${id}.mjs`);
  await writeFile(file, portable, 'utf8');
  return { mod: await import(pathToFileURL(file).href), source: mutated };
}

/** Which assertions reject this module. An assertion that throws is an assertion that caught it. */
function caughtBy(target) {
  return ASSERTIONS.filter((assertion) => {
    try {
      assertion.run(target);
      return false;
    } catch {
      return true;
    }
  }).map((assertion) => assertion.id);
}

const MUTATIONS = [
  {
    id: 'nothing-is-a-pylon', expect: 'L1-owns-exactly-the-four-pylons',
    doc: 'invert the ownership test, so the four towers keep their 22 m boxes and nothing is planned',
    find: "  if (classification?.archetype !== 'lattice-tower') return null;",
    replace: "  if (classification?.archetype === 'lattice-tower') return null;",
  },
  {
    id: 'group-short-by-one-triangle', expect: 'L2-satisfies-the-detail-contract',
    doc: 'leave three indices outside every material group — geometry that would never be drawn',
    find: '      groups: [{ start: 0, count: indices.length, materialSlot: LATTICE_MATERIAL_SLOT }],',
    replace: '      groups: [{ start: 0, count: Math.max(3, indices.length - 3), materialSlot: LATTICE_MATERIAL_SLOT }],',
  },
  {
    id: 'skipped-members-unreported', expect: 'L3-finite-and-non-degenerate',
    doc: 'drop members silently instead of counting them — a metric that could never fire',
    find: '    if (!pushMember(sink, a, b, halfWidth, reference)) stats.degenerateMembersSkipped += 1;',
    replace: '    pushMember(sink, a, b, halfWidth, reference);',
  },
  {
    id: 'peak-overshoots-the-height', expect: 'L4-height-is-exactly-the-data-height',
    doc: 'stop solving for the section rise, so the steel stands 8 cm above the data height',
    find: '  for (let pass = 0; pass < 3; pass++) {',
    replace: '  for (let pass = 0; pass < 0; pass++) {',
  },
  {
    id: 'one-flat-seat-plane', expect: 'L5-each-leg-stands-on-its-own-ground',
    doc: 'seat all four feet on the centroid plane, the exact stilt defect the 08-30 seating work killed',
    find: '      const clamped = clamp(loY, raw, hiY);',
    replace: '      const clamped = baseY;',
  },
  {
    id: 'members-thick-enough-to-be-a-box', expect: 'L6-silhouette-is-open-not-a-box',
    doc: 'draw 2 m legs, closing the sky between them — the box again, wearing a lattice as texture',
    find: '  legHalfWidthM: 0.17,',
    replace: '  legHalfWidthM: 1.02,',
  },
  {
    id: 'arms-reach-off-the-plot', expect: 'L7-stays-on-its-own-plot',
    doc: 'let the cross-arms grow to four times the footprint',
    find: '  armReachRatioSpan: 0.30,',
    replace: '  armReachRatioSpan: 3.00,',
  },
  {
    id: 'one-tower-four-times', expect: 'L8-four-towers-are-four-objects',
    doc: 'drop the seed from the sub-seed mixer, so all four towers get identical proportions',
    find: '  let hash = (num(seed) ^ Math.imul(salt + 1, 0x9e3779b9)) >>> 0;',
    replace: '  let hash = Math.imul(salt + 1, 0x9e3779b9) >>> 0;',
  },
  {
    id: 'variation-from-a-call-counter', expect: 'L9-deterministic',
    doc: 'advance the salt on every read, so a second render disagrees with the first',
    find: 'const unitOf = (seed, salt) => subSeed(seed, salt) / 0x100000000;',
    replace: 'let __tzCalls = 0;\nconst unitOf = (seed, salt) => subSeed(seed, salt + (__tzCalls++)) / 0x100000000;',
  },
  {
    id: 'steel-billed-as-wall', expect: 'L10-draw-call-cost-is-what-is-claimed',
    doc: 'move the tower into the free wall slot, hiding the four calls this archetype really costs',
    find: 'export const LATTICE_MATERIAL_SLOT = MATERIAL_SLOT_INDEX.metal;',
    replace: 'export const LATTICE_MATERIAL_SLOT = MATERIAL_SLOT_INDEX.wall;',
  },
  {
    id: 'box-kept-under-the-lattice', expect: 'L11-tells-the-renderer-to-drop-the-box',
    doc: 'stop telling the renderer to retire the extruded mass — the lattice would sit inside a solid box',
    find: '  plan.replacesMass = LATTICE_TOWER_FLAGS.replacesMass;',
    replace: '  plan.replacesMass = false;',
  },
  {
    id: 'wrong-seat-swallowed', expect: 'L12-a-wrong-seat-is-loud',
    doc: 'accept any seat shape, seating four towers at world zero while still reporting a plan',
    find: '  if (!seat || !Number.isFinite(Number(seat.baseY))) {',
    replace: '  if (false) {',
  },
  {
    id: 'randomised-head-type', expect: 'L13-pure-and-look-blind',
    doc: 'pick the head type at random — irreproducible between runs and between viewers',
    find: '  const catHead = pickOf(seed, 6, 2) === 1;',
    replace: '  const catHead = Math.random() < 0.5;',
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
  assert.deepEqual(caughtBy(REAL), []);
});
