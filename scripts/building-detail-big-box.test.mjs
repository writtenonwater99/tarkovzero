/**
 * Tests for `src/building-detail/big-box.js` against the REAL thirteen big-box buildings in
 * `public/data/customs-3d.json` — no synthetic footprints, because the whole point of the module is
 * what it does to Warehouse 4's 67.6 m mass and Repair Shop's 0.54-fill plan.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS FILE IS SHAPED LIKE THIS
 *
 * Handoff §6 records five separate occasions on which this project reported success while something
 * had silently fallen back, and the rule that fell out of them is that **a metric that cannot fail
 * is worse than no metric**. So the assertions are not written as `assert` calls scattered through
 * `test()` blocks. They are a named CHECK SET run against a module namespace, which lets the second
 * half of this file re-run the identical set against DELIBERATELY BROKEN copies of the shipped
 * source and require that each break is caught by at least one named check.
 *
 * A mutation whose search string no longer matches the source is itself a failure, so the harness
 * cannot rot into a no-op the first time someone reformats the module.
 *
 * ---------------------------------------------------------------------------------------------
 * THE THREE CHECKS THE 2026-09-02 REWORK ADDED, AND WHY THEY ARE MEASURED, NOT DECLARED
 *
 * C7 measures ROOF-PLAN COVERAGE off the emitted `roof` triangles on a lattice, never off the
 * planner's own `decomposition.coverage`. A unit list that says a wing is covered while no geometry
 * covers it is exactly the metric that cannot fail; projecting the triangles the renderer will draw
 * is the only version of this check that can catch `pushDeck` doing nothing.
 *
 * C4 measures the DRAWN HEIGHT BAND against `aboveEaveBudgetFor(heightM)`, a pure function of the
 * data height that a reader can evaluate without the geometry. It covers instances too, because the
 * worst overshoot on the shipped planner was a flue riding a ridge, not a mesh vertex.
 *
 * C17 measures DETAIL PROPORTIONATE TO FOOTPRINT against `minDetailTrianglesFor(areaM2)`. The
 * shipped planner failed it on ten of the thirteen rows — Warehouse 4 owed 67 triangles and carried
 * 32, Streamer House owed 32 and carried 6 — which is the defect this rework exists to close.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { classifyAll } from '../src/building-archetype.js';
import { seatBuilding } from '../src/buildings.js';
import {
  validateDetailPlan,
  validatePlannerContext,
  planDrawCallDelta,
  MATERIAL_SLOT_INDEX,
  INSTANCED_FAMILIES,
} from '../src/building-detail/contract.js';
import * as shipped from '../src/building-detail/big-box.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_PATH = join(ROOT, 'src/building-detail/big-box.js');
const SOURCE = await readFile(MODULE_PATH, 'utf8');
const DATA = JSON.parse(await readFile(join(ROOT, 'public/data/customs-3d.json'), 'utf8'));
const BUILDINGS = DATA.buildings;
const CLASSIFIED = classifyAll(BUILDINGS);
const BIG_BOX_INDICES = CLASSIFIED.byArchetype['big-box'];

/**
 * A deterministic terrain with a real cross-slope, so the seat under every building is a genuine
 * `seatBuilding()` result rather than a flat zero. The module never samples the ground itself — a
 * roof does not touch it — but the seat it is handed must be a real one or "sits on the building"
 * is a check that cannot fail.
 */
const H = (x, z) => 12 + 0.045 * x - 0.031 * z + 3 * Math.sin(x / 40) * Math.cos(z / 35);

const seatFor = (building) => {
  const seat = seatBuilding(building, H);
  return {
    baseY: seat.base,
    contactY: seat.contact,
    loY: seat.lo,
    hiY: seat.hi,
    plinthBaseY: seat.plinthBase,
    plinthHeightM: seat.plinthHeight,
  };
};

const contextFor = (index) => ({
  buildingIndex: index,
  classification: CLASSIFIED.assignments[index],
  seat: seatFor(BUILDINGS[index]),
  groundYAt: H,
});

const byPlace = (place) => BIG_BOX_INDICES.find((index) => BUILDINGS[index].place === place);

// --------------------------------------------------------------------------------------------- //
// Geometry helpers used only by the checks.
// --------------------------------------------------------------------------------------------- //

/** World -> game. `gameToWorld(x, z, y) = [-x, -z, y]`, so this is its exact inverse. */
const worldToGameXZ = (wx, wy) => [-wx, -wy];

function triangleNormal(positions, ia, ib, ic) {
  const ax = positions[ia * 3], ay = positions[ia * 3 + 1], az = positions[ia * 3 + 2];
  const bx = positions[ib * 3], by = positions[ib * 3 + 1], bz = positions[ib * 3 + 2];
  const cx = positions[ic * 3], cy = positions[ic * 3 + 1], cz = positions[ic * 3 + 2];
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz);
  return {
    area: length / 2,
    n: length > 1e-12 ? [nx / length, ny / length, nz / length] : [0, 0, 0],
    centroid: [(ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3],
    corners: [[ax, ay, az], [bx, by, bz], [cx, cy, cz]],
  };
}

function pointInRing(ring, px, pz) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function distanceToRing(ring, px, pz) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % ring.length];
    const dx = bx - ax, dz = bz - az;
    const run = dx * dx + dz * dz;
    const t = run > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / run)) : 0;
    best = Math.min(best, Math.hypot(px - (ax + dx * t), pz - (az + dz * t)));
  }
  return best;
}

/** Fraction of a unit rectangle that lies inside the real footprint, on a fixed 64 x 64 lattice. */
function unitContainment(unit, ring) {
  const cos = Math.cos(unit.yawRad);
  const sin = Math.sin(unit.yawRad);
  const steps = 64;
  let hits = 0;
  for (let p = 0; p < steps; p++) {
    for (let q = 0; q < steps; q++) {
      const a = (-unit.lengthM / 2) + ((p + 0.5) / steps) * unit.lengthM;
      const b = (-unit.widthM / 2) + ((q + 0.5) / steps) * unit.widthM;
      const x = unit.centerX + a * cos - b * sin;
      const z = unit.centerZ + a * sin + b * cos;
      if (pointInRing(ring, x, z)) hits++;
    }
  }
  return hits / (steps * steps);
}

const groupsBySlot = (mesh) => {
  const out = new Map();
  for (const group of mesh?.groups ?? []) out.set(group.materialSlot, (out.get(group.materialSlot) ?? 0) + group.count);
  return out;
};

/** Every triangle in a plan's mesh, tagged with the slot its group declares. */
function* meshTriangles(mesh) {
  if (!mesh) return;
  for (const group of mesh.groups) {
    for (let offset = 0; offset < group.count; offset += 3) {
      const at = group.start + offset;
      yield {
        slot: group.materialSlot,
        ...triangleNormal(mesh.positions, mesh.indices[at], mesh.indices[at + 1], mesh.indices[at + 2]),
      };
    }
  }
}

/**
 * ROOF-PLAN COVERAGE, measured off the geometry.
 *
 * Every `roof`-slot triangle is projected to the ground plane and the footprint is sampled on a
 * fixed lattice; the answer is the fraction of the building's own plan that has a roof triangle
 * over it. This is deliberately NOT `plan.decomposition.coverage`: that number is an arithmetic on
 * a list of rectangles and stays at 100% whether or not anything was ever built on them, which is
 * the shape of every failure in handoff §6. The lattice step is ~0.5 m on the largest plan here and
 * 0.3 m on Streamer House, so the 1.80 m strip this check exists to find spans several cells.
 */
function roofPlanCoverage(mesh, ring, steps = 80) {
  const triangles = [];
  for (const group of mesh?.groups ?? []) {
    if (group.materialSlot !== MATERIAL_SLOT_INDEX.roof) continue;
    for (let offset = 0; offset < group.count; offset += 3) {
      const at = group.start + offset;
      const corners = [0, 1, 2].map((k) => {
        const vertex = mesh.indices[at + k];
        return worldToGameXZ(mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1]);
      });
      const xs = corners.map((c) => c[0]);
      const zs = corners.map((c) => c[1]);
      triangles.push({
        corners,
        x0: Math.min(...xs), x1: Math.max(...xs),
        z0: Math.min(...zs), z1: Math.max(...zs),
      });
    }
  }
  const inside = (triangle, px, pz) => {
    const [a, b, c] = triangle.corners;
    const d1 = (px - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (pz - b[1]);
    const d2 = (px - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (pz - c[1]);
    const d3 = (px - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (pz - a[1]);
    return !(((d1 < 0) || (d2 < 0) || (d3 < 0)) && ((d1 > 0) || (d2 > 0) || (d3 > 0)));
  };
  const xs = ring.map((point) => point[0]);
  const zs = ring.map((point) => point[1]);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [z0, z1] = [Math.min(...zs), Math.max(...zs)];
  let sampled = 0;
  let covered = 0;
  for (let p = 0; p < steps; p++) {
    for (let q = 0; q < steps; q++) {
      const x = x0 + ((p + 0.5) / steps) * (x1 - x0);
      const z = z0 + ((q + 0.5) / steps) * (z1 - z0);
      if (!pointInRing(ring, x, z)) continue;
      sampled += 1;
      for (const triangle of triangles) {
        if (x < triangle.x0 || x > triangle.x1 || z < triangle.z0 || z > triangle.z1) continue;
        if (inside(triangle, x, z)) { covered += 1; break; }
      }
    }
  }
  return sampled ? covered / sampled : 0;
}

/** The highest thing a plan draws — mesh AND instances, the same arithmetic `assemble.js` uses. */
function drawnTopY(plan) {
  let top = -Infinity;
  for (let index = 2; index < plan.mesh.positions.length; index += 3) {
    if (plan.mesh.positions[index] > top) top = plan.mesh.positions[index];
  }
  for (const family of plan.instances) {
    let prototypeTop = -Infinity;
    for (let index = 2; index < family.prototype.positions.length; index += 3) {
      if (family.prototype.positions[index] > prototypeTop) prototypeTop = family.prototype.positions[index];
    }
    for (let index = 0; index < family.count; index++) {
      const candidate = family.offsets[index * 3 + 2] + prototypeTop * family.scales[index * 3 + 2];
      if (candidate > top) top = candidate;
    }
  }
  return top;
}

// --------------------------------------------------------------------------------------------- //
// THE CHECK SET. Every entry returns a string on failure and null on success. The same set runs
// against the shipped module and against every mutant.
// --------------------------------------------------------------------------------------------- //

/**
 * Instances have to be legible at one metre per pixel, which is what the default 3D zoom gives.
 * The two numbers are the smallest a roof object may be and still be worth its instance: the widest
 * VERTICAL FACE it presents, and its height. They live here rather than in the module because they
 * are the reader's requirement, not the planner's parameter — a planner that chose them could move
 * them to fit whatever it happened to build.
 */
const INSTANCE_MIN_SILHOUETTE_M2 = 1.2;
const INSTANCE_MIN_HEIGHT_M = 0.9;
/** A roof that misses this much of its own plan leaves bare extruded lid where a pitch should be. */
const MIN_ROOF_PLAN_COVERAGE = 0.995;

/**
 * THE BOUNDS ARE RESTATED HERE, NOT READ OFF THE MODULE, and then the module is required to agree.
 *
 * A check that measures a mutant's geometry against that same mutant's own constant is a metric
 * that cannot fail: widening `maxRoofRiseFraction` to 5 widens the ceiling it is checked against by
 * the same factor, and the mutation passes. Measured, not hypothetical — three mutations went
 * uncaught for exactly this reason while this file was being written.
 *
 * So each bound is a literal here, the geometry is checked against the literal, and the module's
 * exported constant is checked against it too. Changing the requirement means changing both, which
 * is the point: the second edit is where a reader notices.
 */
const MAX_ABOVE_EAVE_FRACTION = 0.45;
/** eave oversail 0.45 + grid merge 0.75 + dock canopy 2.4 + 0.5 of slack */
const MAX_OUTSIDE_FOOTPRINT_M = 4.1;
/** dock canopy drop 5.5 + its 0.4 m slab; nothing else this planner builds goes below the eave */
const MAX_BELOW_EAVE_M = 5.9;
/** `minDetailTrianglesFor` restated: 6 triangles plus 3 per 100 m2 of footprint */
const MIN_DETAIL_TRIANGLE_BASE = 6;
const MIN_DETAIL_TRIANGLE_PER_M2 = 0.03;
const detailFloorFor = (areaM2) => MIN_DETAIL_TRIANGLE_BASE + MIN_DETAIL_TRIANGLE_PER_M2 * areaM2;

function planAll(mod) {
  return BIG_BOX_INDICES.map((index) => ({
    index,
    building: BUILDINGS[index],
    classification: CLASSIFIED.assignments[index],
    seat: seatFor(BUILDINGS[index]),
    plan: mod.planDetail(BUILDINGS[index], contextFor(index)),
  }));
}

const CHECKS = {
  /** The planner claims its own archetype and nothing else — the other half of the one-router rule. */
  'C1-claims-only-big-box': (mod) => {
    for (let index = 0; index < BUILDINGS.length; index++) {
      const plan = mod.planDetail(BUILDINGS[index], contextFor(index));
      const isBigBox = CLASSIFIED.assignments[index].archetype === 'big-box';
      if (isBigBox && plan === null) return `building ${index} is big-box but the planner returned null`;
      if (!isBigBox && plan !== null) return `building ${index} is ${CLASSIFIED.assignments[index].archetype} but the planner claimed it`;
    }
    if (BIG_BOX_INDICES.length !== 13) return `expected 13 big-box rows, router reports ${BIG_BOX_INDICES.length}`;
    return null;
  },

  /** The contract is executable; every plan must satisfy it, groups and instances included. */
  'C2-contract-valid': (mod) => {
    for (const row of planAll(mod)) {
      try {
        validateDetailPlan(row.plan, { buildingCount: BUILDINGS.length, archetype: 'big-box' });
      } catch (error) {
        return `building ${row.index}: ${error.message}`;
      }
      if (!row.plan.mesh) return `building ${row.index} (${row.building.place ?? 'unnamed'}) emitted no mesh at all`;
    }
    return null;
  },

  /** No NaN, no zero-area triangles: a degenerate triangle is a rendering artefact, not geometry. */
  'C3-finite-and-non-degenerate': (mod) => {
    for (const row of planAll(mod)) {
      for (const value of row.plan.mesh.positions) {
        if (!Number.isFinite(value)) return `building ${row.index}: non-finite position`;
      }
      for (const triangle of meshTriangles(row.plan.mesh)) {
        if (!(triangle.area > 1e-4)) return `building ${row.index}: degenerate triangle, area ${triangle.area}`;
      }
    }
    return null;
  },

  /**
   * THE DRAWN HEIGHT BAND — rule 4, and the whole reason this planner may add anything at all.
   *
   * `assemble.js` keeps a building's total drawn height inside its data height by scaling the plan
   * about the base, so every metre above the eave is a metre the WALLS lose: the shipped planner put
   * 6.20 m above Warehouse 7's 8.31 m eave and left it a 4.76 m wall. The ceiling is therefore
   * `aboveEaveBudgetFor(heightM)`, a pure function of the data height, and it covers INSTANCES too
   * — the worst offender was a flue riding a ridge, not a mesh vertex.
   *
   * The floor is the dock canopy's band, and the count of sub-eave vertices is tied to the number of
   * canopies the plan says it built (8 per prism), so neither a stray element below the eave nor a
   * mis-reported canopy count can pass.
   */
  'C4-drawn-height-band': (mod) => {
    const canopyFloorM = MAX_BELOW_EAVE_M;
    if (Math.abs(mod.aboveEaveBudgetFor(10) - MAX_ABOVE_EAVE_FRACTION * 10) > 1e-9) {
      return `aboveEaveBudgetFor(10) is ${mod.aboveEaveBudgetFor(10)}, this file requires ${MAX_ABOVE_EAVE_FRACTION * 10}`;
    }
    if (mod.BIG_BOX.canopyMaxDropM + mod.BIG_BOX.canopyThicknessM > MAX_BELOW_EAVE_M + 1e-9) {
      return `the canopy band is ${(mod.BIG_BOX.canopyMaxDropM + mod.BIG_BOX.canopyThicknessM).toFixed(2)} m, this file allows ${MAX_BELOW_EAVE_M} m`;
    }
    for (const row of planAll(mod)) {
      const roofY = row.seat.baseY + row.classification.heightM;
      const ceiling = roofY + MAX_ABOVE_EAVE_FRACTION * row.classification.heightM;
      const top = drawnTopY(row.plan);
      if (top > ceiling + 1e-3) {
        return `building ${row.index}: draws ${(top - roofY).toFixed(3)} m above the eave, budget ${(ceiling - roofY).toFixed(3)} m`;
      }
      let below = 0;
      const positions = row.plan.mesh.positions;
      for (let index = 2; index < positions.length; index += 3) {
        if (positions[index] < roofY - 1e-3) {
          below += 1;
          if (positions[index] < roofY - canopyFloorM - 1e-3) {
            return `building ${row.index}: vertex ${(roofY - positions[index]).toFixed(2)} m below the eave, canopy band is ${canopyFloorM.toFixed(2)} m`;
          }
        }
      }
      const expected = 8 * (row.plan.roofElements?.canopies ?? 0);
      if (below !== expected) {
        return `building ${row.index}: ${below} vertices below the eave but ${row.plan.roofElements?.canopies} canopy(ies) declared (expected ${expected})`;
      }
    }
    return null;
  },

  /** ...and over it, not beside it: no vertex further outside the footprint than the dock canopy. */
  'C5-inside-the-footprint': (mod) => {
    const slack = MAX_OUTSIDE_FOOTPRINT_M;
    const declared = mod.BIG_BOX.eaveOverhangM + mod.BIG_BOX.gridMergeToleranceM + mod.BIG_BOX.canopyProjectM + 0.5;
    if (declared > slack + 1e-9) {
      return `the module's own oversail + canopy budget is ${declared.toFixed(2)} m, this file allows ${slack} m`;
    }
    for (const row of planAll(mod)) {
      const ring = row.building.poly.map(([x, z]) => [Number(x), Number(z)]);
      const positions = row.plan.mesh.positions;
      for (let index = 0; index < positions.length; index += 3) {
        const [x, z] = worldToGameXZ(positions[index], positions[index + 1]);
        if (pointInRing(ring, x, z)) continue;
        const distance = distanceToRing(ring, x, z);
        if (distance > slack) {
          return `building ${row.index}: vertex ${distance.toFixed(2)} m outside the footprint (slack ${slack.toFixed(2)} m)`;
        }
      }
    }
    return null;
  },

  /** Decision 3: each unit is a real rectilinear piece OF THIS PLAN, not of its bounding box. */
  'C6-units-lie-inside-the-plan': (mod) => {
    for (const row of planAll(mod)) {
      const ring = row.building.poly.map(([x, z]) => [Number(x), Number(z)]);
      for (const unit of row.plan.decomposition.units) {
        const inside = unitContainment(unit, ring);
        if (inside < 0.95) {
          return `building ${row.index}: unit ${unit.lengthM.toFixed(1)}x${unit.widthM.toFixed(1)} m is only ${(inside * 100).toFixed(1)}% inside the footprint`;
        }
      }
    }
    return null;
  },

  /**
   * ...AND THE ROOF COVERS THE PLAN. Measured off the emitted `roof` triangles, not off the unit
   * list — see `roofPlanCoverage` above for why that distinction is the whole check.
   *
   * Ridged rows only: on a `flat-parapet` row the roof IS the mass lid the renderer already extrudes
   * at `roofY`, and this planner adds a rim around it rather than a surface over it. That row is
   * checked the other way instead — the rim must follow every edge of the real footprint, because a
   * parapet cut at a decomposition boundary would draw a wall across the middle of a roof.
   *
   * The number this replaces: Streamer House's 8-vertex plan got ONE ridge covering 97.7% of itself
   * and 1.80 m of bare extruded lid beside it, because a unit narrower than `minUnitWidthM` was
   * deleted from the decomposition instead of being roofed some other way.
   */
  'C7-roof-covers-the-plan': (mod) => {
    for (const row of planAll(mod)) {
      const ring = row.building.poly.map(([x, z]) => [Number(x), Number(z)]);
      if (row.classification.roofForm === 'ridged') {
        const coverage = roofPlanCoverage(row.plan.mesh, ring);
        if (!(coverage >= MIN_ROOF_PLAN_COVERAGE)) {
          return `building ${row.index} (${row.building.place ?? 'unnamed'}): roof covers ${(coverage * 100).toFixed(2)}% of its own plan, floor is ${(MIN_ROOF_PLAN_COVERAGE * 100).toFixed(1)}%`;
        }
      } else if (row.classification.roofForm === 'flat-parapet') {
        const segments = row.plan.roofElements?.parapetSegments ?? 0;
        if (segments !== ring.length) {
          return `building ${row.index}: ${segments} parapet segments for a ${ring.length}-edge footprint`;
        }
      }
    }
    return null;
  },

  /** Winding. A roof plane whose normal points down is a hole in the sky under backface culling. */
  'C8-roof-faces-up': (mod) => {
    for (const row of planAll(mod)) {
      for (const triangle of meshTriangles(row.plan.mesh)) {
        if (triangle.slot !== MATERIAL_SLOT_INDEX.roof) continue;
        if (!(triangle.n[2] > 0.2)) return `building ${row.index}: a roof triangle points ${triangle.n.map((v) => v.toFixed(2)).join(',')}`;
      }
    }
    return null;
  },

  /**
   * Wall faces are vertical AND face outward. The outward test is a flux sum rather than a
   * per-triangle rule so that it holds for parapet rims, gable ends, dormers, decks and dock
   * canopies alike: flipping the winding flips the sign of the whole sum, and a closed prism's
   * contribution to the sum is positive wherever the reference point is put.
   */
  'C9-walls-vertical-and-outward': (mod) => {
    for (const row of planAll(mod)) {
      const ring = row.building.poly.map(([x, z]) => [Number(x), Number(z)]);
      const cx = ring.reduce((sum, p) => sum + p[0] / ring.length, 0);
      const cz = ring.reduce((sum, p) => sum + p[1] / ring.length, 0);
      const [wcx, wcy] = [-cx, -cz];
      let flux = 0;
      for (const triangle of meshTriangles(row.plan.mesh)) {
        if (triangle.slot !== MATERIAL_SLOT_INDEX.wall) continue;
        if (Math.abs(triangle.n[2]) > 0.02) return `building ${row.index}: a wall triangle is not vertical (nz ${triangle.n[2].toFixed(3)})`;
        flux += triangle.area * (triangle.n[0] * (triangle.centroid[0] - wcx) + triangle.n[1] * (triangle.centroid[1] - wcy));
      }
      if (!(flux > 0)) return `building ${row.index}: wall normals point inward (flux ${flux.toFixed(1)})`;
    }
    return null;
  },

  /** The stated budget, computed by the contract's own accountant, not estimated. */
  'C10-draw-call-budget': (mod) => {
    const plans = planAll(mod).map((row) => row.plan);
    const delta = planDrawCallDelta(plans);
    if (delta.worstPerBuilding > 1) return `worstPerBuilding ${delta.worstPerBuilding} exceeds the 1-extra-slot budget`;
    if (!delta.withinBudget) return 'planDrawCallDelta reports the archetype is outside budget';
    // 4 = roof-vent, roof-hatch, roof-stack and door-module. Doors are instanced precisely so that
    // thirteen buildings' worth of them cost one mesh map-wide and no per-building group at all.
    if (delta.instancedFamilies !== 4) return `expected 4 instanced families, got ${delta.instancedFamilies}`;
    // 11 = 8 metal-roofed halls taking `glazing` for their lanterns and gable louvres + 3
    // flat-parapet blocks taking `trim` for the parapet coping and the plant screen. The two tiled
    // rows (Streamer House, Crackhouse) spend nothing beyond the wall/roof pair the building mesh
    // already pays for: a dormer is wall and roof, which is what a dormer is made of.
    if (delta.perBuildingGroups !== 11) return `expected 11 extra per-building slots, got ${delta.perBuildingGroups}`;
    return null;
  },

  /**
   * Instances are addressable by owner. `levelAboveBaseM` must be the instance's own height above
   * ITS OWNER'S base — an absolute world altitude would need re-deriving the first time relief
   * changed, and `fitPlanToHeight()` rescales about that base.
   */
  'C11-instances-addressable': (mod) => {
    for (const row of planAll(mod)) {
      for (const family of row.plan.instances) {
        const limit = INSTANCED_FAMILIES[family.familyId].maxPerBuilding;
        if (family.count > limit) return `building ${row.index}: ${family.familyId} count ${family.count} > ${limit}`;
        for (let index = 0; index < family.count; index++) {
          if (family.ownerIndex[index] !== row.index) return `building ${row.index}: ${family.familyId} owned by ${family.ownerIndex[index]}`;
          const worldZ = family.offsets[index * 3 + 2];
          const expected = row.seat.baseY + family.levelAboveBaseM[index];
          if (Math.abs(worldZ - expected) > 1e-3) {
            return `building ${row.index}: ${family.familyId}[${index}] sits at ${worldZ.toFixed(3)} but declares level ${family.levelAboveBaseM[index].toFixed(3)} above base ${row.seat.baseY.toFixed(3)}`;
          }
        }
      }
    }
    return null;
  },

  /**
   * VARIATION IS THE DELIVERABLE. Identical treatment on thirteen warehouses gives thirteen
   * identical detailed warehouses, which is the same failure the founder already reported in a
   * different costume. Each clause below names two REAL buildings that must not agree.
   */
  'C12-variation-between-real-buildings': (mod) => {
    const rows = planAll(mod);
    const baysOf = (row, unit) => mod.roofBays(unit, mod.tanPitchFor(row.classification));
    const signature = (row) => JSON.stringify([
      row.plan.decomposition.units.length,
      row.plan.decomposition.units.map((unit) => baysOf(row, unit).length),
      row.plan.decomposition.units.map((unit) => Number((baysOf(row, unit)[0]?.riseM ?? 0).toFixed(2))),
      row.plan.instances.map((family) => [family.familyId, family.count]),
      [...groupsBySlot(row.plan.mesh).keys()].sort(),
    ]);
    const distinct = new Set(rows.map(signature));
    if (distinct.size < 9) return `only ${distinct.size} distinct detail signatures across 13 buildings`;

    const at = (place) => rows.find((row) => row.building.place === place);
    const bays = (row) => baysOf(row, row.plan.decomposition.units[0]);
    const w3 = at('Warehouse 3');
    const w7 = at('Warehouse 7');
    if (bays(w3).length !== 2) return `Warehouse 3 (38.1 m span) should be 2 bays, got ${bays(w3).length}`;
    if (bays(w7).length !== 1) return `Warehouse 7 (24.1 m span) should be 1 bay, got ${bays(w7).length}`;
    if (!(Math.abs(bays(w3)[0].riseM - bays(w7)[0].riseM) > 0.5)) {
      return `Warehouse 3 and Warehouse 7 ridge rises are within 0.5 m (${bays(w3)[0].riseM.toFixed(2)} vs ${bays(w7)[0].riseM.toFixed(2)})`;
    }

    /**
     * THE LANTERN RUN SCALES WITH THE RIDGE IT SITS ON. One box on a 67.6 m ridge reads as a
     * thicker ridge; five read as a roof, and this is the clause that says so. Asserted on the pure
     * function AND on the geometry it produces, because either alone can be satisfied by a
     * constant.
     */
    const w4 = at('Warehouse 4');
    if (!(mod.monitorRuns(67.6).length > mod.monitorRuns(42.6).length)) {
      return `a 67.6 m bay carries ${mod.monitorRuns(67.6).length} lantern(s) and a 42.6 m bay ${mod.monitorRuns(42.6).length} — the run does not scale with the ridge`;
    }
    if (!(mod.monitorRuns(42.6).length > mod.monitorRuns(13.8).length)) {
      return `a 42.6 m bay carries ${mod.monitorRuns(42.6).length} lantern(s) and a 13.8 m bay ${mod.monitorRuns(13.8).length}`;
    }
    if (!(w4.plan.roofElements.monitors > w7.plan.roofElements.monitors)) {
      return `Warehouse 4 (67.6 x 30.1 m) carries ${w4.plan.roofElements.monitors} lantern(s) against Warehouse 7's ${w7.plan.roofElements.monitors}`;
    }

    const countOf = (row, familyId) => row.plan.instances.find((family) => family.familyId === familyId)?.count ?? 0;
    const oilRig = at('Oil Rig');
    const dorms2 = at('Dorms 2-Story');
    if (!(countOf(oilRig, 'roof-vent') > countOf(dorms2, 'roof-vent'))) {
      return `Oil Rig (1835 m2) should carry more roof plant than Dorms 2-Story (690 m2): ${countOf(oilRig, 'roof-vent')} vs ${countOf(dorms2, 'roof-vent')}`;
    }

    // The occupied gabled house must not be given an industrial roof monitor.
    const crackhouse = at('Crackhouse');
    if (groupsBySlot(crackhouse.plan.mesh).has(MATERIAL_SLOT_INDEX.glazing)) {
      return 'Crackhouse (tiled roof) was given a clerestory monitor';
    }
    if (!groupsBySlot(w3.plan.mesh).has(MATERIAL_SLOT_INDEX.glazing)) {
      return 'Warehouse 3 (metal roof, 54.6 m bays) was NOT given a monitor';
    }
    return null;
  },

  /**
   * Determinism: the renderer must be reproducible run to run. INSTANCES ARE CHECKED TOO — the
   * seed-driven jitter that positions roof plant lives only in the instance offsets, so a mesh-only
   * comparison would pass for a planner whose entire variation had gone random.
   */
  'C13-deterministic': (mod) => {
    for (const index of BIG_BOX_INDICES) {
      const a = mod.planDetail(BUILDINGS[index], contextFor(index));
      const b = mod.planDetail(BUILDINGS[index], contextFor(index));
      if (!a.mesh.positions.every((value, at) => value === b.mesh.positions[at])) return `building ${index}: positions differ between runs`;
      if (!a.mesh.indices.every((value, at) => value === b.mesh.indices[at])) return `building ${index}: indices differ between runs`;
      if (a.instances.length !== b.instances.length) return `building ${index}: instance family count differs between runs`;
      for (const [ordinal, family] of a.instances.entries()) {
        const other = b.instances[ordinal];
        if (family.familyId !== other.familyId || family.count !== other.count) {
          return `building ${index}: instance family ${ordinal} differs between runs`;
        }
        for (const key of ['offsets', 'yaws', 'scales', 'levelAboveBaseM']) {
          if (!family[key].every((value, at) => value === other[key][at])) {
            return `building ${index}: ${family.familyId}.${key} differs between runs`;
          }
        }
      }
    }
    return null;
  },

  /** Standing decision 4: heights are never changed. The planner may not mutate its input at all. */
  'C14-input-untouched': (mod) => {
    const before = JSON.stringify(BUILDINGS);
    planAll(mod);
    if (JSON.stringify(BUILDINGS) !== before) return 'the planner mutated the building rows';
    return null;
  },

  /**
   * THE GABLE END MUST CLOSE THE ROOF IT MEETS.
   *
   * This check exists because the mutation harness found the gap: shifting the gable apex off the
   * ridge left a triangular hole under one roof plane and a flap sticking through the other, and
   * NOTHING caught it — the geometry was still finite, still vertical, still inside the footprint,
   * still above the roof plane.
   *
   * It is now stated in two halves, because `wall` on a ridged plan is no longer gable ends alone —
   * dormers, roof decks and dock canopies are wall too:
   *
   *   a) COUNT. A triangle with two corners exactly on the eave plane, one strictly above it, and
   *      that apex horizontally midway between them, is a gable end and nothing else is: a prism's
   *      side triangle puts its high corner directly over a low one, never over the midpoint. There
   *      must be exactly two per ridged bay.
   *   b) COVER. No `wall` vertex above the eave may stand HIGHER than the roof over its own plan
   *      position. It is stated as a cover rather than as "coincides with a roof vertex" because
   *      the eave oversail puts the ridge line's endpoints 0.45 m outboard of the gable that closes
   *      it — the apex is on the ridge EDGE and is nobody's vertex — and because a dormer's sill is
   *      deliberately SUNK into the pitch it sits on. A gable apex moved off the ridge fails it at
   *      once: the roof over its new plan position has already fallen to the eave, so the apex is
   *      a flap sticking through the roof, which is exactly the defect. A corner over no roof
   *      triangle at all fails too — that is an eave with nothing on it.
   */
  'C15-gable-ends-close-the-roof': (mod) => {
    for (const row of planAll(mod)) {
      if (row.classification.roofForm !== 'ridged') continue;
      const roofY = row.seat.baseY + row.classification.heightM;
      const roofFaces = [];
      let gables = 0;
      for (const triangle of meshTriangles(row.plan.mesh)) {
        if (triangle.slot === MATERIAL_SLOT_INDEX.roof) roofFaces.push(triangle);
      }
      /** The highest roof surface over one plan position, or -Infinity where there is no roof. */
      const roofOver = (corner) => {
        let best = -Infinity;
        for (const face of roofFaces) {
          const [a, b, c] = face.corners;
          const cross = (p, q, r) => (r[0] - p[0]) * (q[1] - p[1]) - (q[0] - p[0]) * (r[1] - p[1]);
          const d1 = cross(b, a, corner);
          const d2 = cross(c, b, corner);
          const d3 = cross(a, c, corner);
          if ((d1 < -1e-6 || d2 < -1e-6 || d3 < -1e-6) && (d1 > 1e-6 || d2 > 1e-6 || d3 > 1e-6)) continue;
          if (Math.abs(face.n[2]) < 1e-6) continue;
          const z = a[2] - (face.n[0] * (corner[0] - a[0]) + face.n[1] * (corner[1] - a[1])) / face.n[2];
          if (z > best) best = z;
        }
        return best;
      };
      for (const triangle of meshTriangles(row.plan.mesh)) {
        if (triangle.slot !== MATERIAL_SLOT_INDEX.wall) continue;
        for (const corner of triangle.corners) {
          if (corner[2] <= roofY + 1e-3) continue;
          const cover = roofOver(corner);
          if (!Number.isFinite(cover)) {
            return `building ${row.index}: a wall corner at ${corner[2].toFixed(3)} m stands over no roof triangle at all`;
          }
          if (corner[2] > cover + 1e-3) {
            return `building ${row.index}: a wall corner at ${corner[2].toFixed(3)} m sticks ${(corner[2] - cover).toFixed(3)} m through the roof over it`;
          }
        }
        const eaves = triangle.corners.filter((corner) => Math.abs(corner[2] - roofY) < 1e-3);
        const apex = triangle.corners.filter((corner) => corner[2] - roofY > 1e-3);
        if (eaves.length !== 2 || apex.length !== 1) continue;
        const midX = (eaves[0][0] + eaves[1][0]) / 2;
        const midY = (eaves[0][1] + eaves[1][1]) / 2;
        if (Math.hypot(apex[0][0] - midX, apex[0][1] - midY) <= 1e-3) gables += 1;
      }
      const expected = 2 * (row.plan.roofElements?.ridgeBays ?? 0);
      if (gables !== expected) {
        return `building ${row.index}: ${gables} closed gable end(s) for ${row.plan.roofElements?.ridgeBays} ridged bay(s) (expected ${expected})`;
      }
    }
    return null;
  },

  /**
   * THE AUTHORED ROOF COLOUR IS USED, AND USED THE RIGHT WAY ROUND.
   *
   * `building.roof` is on 8 of these 13 rows and the renderer throws it away today. Here it splits
   * two real roof materials: the warehouses' cool [92,102,106] profiled metal and Streamer House's /
   * Crackhouse's warm [126,76,52] tile. Tile needs slope, metal does not, so the tiled rows must
   * come out steeper — they must get DORMERS rather than clerestory lanterns, and they must not be
   * given `glazing` at all, which is the only place a programme-driven rule produced a visibly wrong
   * roof (Streamer House is a house the router calls `industrial` on a 4.75 m storey ratio).
   */
  'C16-authored-roof-colour-drives-the-pitch': (mod) => {
    const rows = planAll(mod);
    const at = (place) => rows.find((row) => row.building.place === place);
    const pitchOf = (row) => {
      const unit = row.plan.decomposition.units[0];
      const bay = mod.roofBays(unit, mod.tanPitchFor(row.classification))[0];
      return bay ? bay.riseM / (bay.baySpanM / 2) : 0;
    };
    const crackhouse = at('Crackhouse');       // roof [126,76,52] — tile
    const streamer = at('Streamer House');     // roof [126,76,52] — tile
    const warehouse7 = at('Warehouse 7');      // roof [ 92,102,106] — metal
    for (const [name, row] of [['Crackhouse', crackhouse], ['Streamer House', streamer]]) {
      if (!(pitchOf(row) > pitchOf(warehouse7) + 0.1)) {
        return `${name} carries a tiled roof colour but pitches at ${pitchOf(row).toFixed(3)} against Warehouse 7's ${pitchOf(warehouse7).toFixed(3)}`;
      }
      if (!(row.plan.roofElements.dormers > 0)) return `${name} (tiled roof) got no dormers`;
      if (row.plan.roofElements.monitors > 0) return `${name} (tiled roof) was given ${row.plan.roofElements.monitors} factory clerestory lantern(s)`;
      if (groupsBySlot(row.plan.mesh).has(MATERIAL_SLOT_INDEX.glazing)) {
        return `${name} (tiled roof) took the industrial glazing slot`;
      }
    }
    if (!(warehouse7.plan.roofElements.monitors > 0)) return 'Warehouse 7 (metal roof, 24.1 m span) got no lantern';
    if (warehouse7.plan.roofElements.dormers > 0) return 'Warehouse 7 (metal shed) was given house dormers';
    if (!mod.hasTiledRoof(crackhouse.classification)) return 'Crackhouse roof [126,76,52] was not read as tile';
    if (mod.hasTiledRoof(warehouse7.classification)) return 'Warehouse 7 roof [92,102,106] was read as tile';
    if (mod.hasTiledRoof(at('Big Red').classification)) return 'Big Red has no authored roof colour and must default to metal';
    return null;
  },

  /**
   * DETAIL PROPORTIONATE TO FOOTPRINT — the defect this rework exists to close.
   *
   * Measured across the shipped system before it: four lattice-tower pylons on 195 m2 of footprint
   * (0.7% of the map's buildings) carried 3,960 detail triangles (44.9% of the budget), while the
   * thirteen big-box rows on 17,209 m2 (58.6%) carried 482 (5.5%) — 2,026 triangles per 100 m2
   * against 2.8. `minDetailTrianglesFor` is the floor that falls out of that, and the shipped
   * planner failed it on ten of thirteen rows.
   */
  'C17-detail-proportionate-to-footprint': (mod) => {
    if (Math.abs(mod.minDetailTrianglesFor(1000) - detailFloorFor(1000)) > 1e-9) {
      return `minDetailTrianglesFor(1000) is ${mod.minDetailTrianglesFor(1000)}, this file requires ${detailFloorFor(1000)}`;
    }
    for (const row of planAll(mod)) {
      const triangles = row.plan.mesh.indices.length / 3;
      const floor = detailFloorFor(row.classification.metrics.areaM2);
      if (triangles < floor) {
        return `building ${row.index} (${row.building.place ?? 'unnamed'}, ${row.classification.metrics.areaM2.toFixed(0)} m2): `
          + `${triangles} detail triangles against a floor of ${floor.toFixed(0)}`;
      }
    }
    return null;
  },

  /**
   * ROOF PLANT IS SIZED TO BE SEEN. One pixel is one metre at the default 3D zoom, so a 0.3 m roof
   * hatch is a third of a pixel — it costs an instance and returns nothing. Both bounds are the
   * reader's, declared in this file, and both are measured off the per-instance `scales` the
   * renderer will actually apply rather than off the constant the planner meant to use.
   */
  'C18-instances-are-legible': (mod) => {
    for (const row of planAll(mod)) {
      for (const family of row.plan.instances) {
        for (let index = 0; index < family.count; index++) {
          const [sx, sy, sz] = [family.scales[index * 3], family.scales[index * 3 + 1], family.scales[index * 3 + 2]];
          const silhouette = Math.max(sx, sy) * sz;
          if (sz < INSTANCE_MIN_HEIGHT_M) {
            return `building ${row.index}: ${family.familyId}[${index}] is ${sz.toFixed(2)} m tall, floor is ${INSTANCE_MIN_HEIGHT_M} m`;
          }
          if (silhouette < INSTANCE_MIN_SILHOUETTE_M2) {
            return `building ${row.index}: ${family.familyId}[${index}] presents ${silhouette.toFixed(2)} m2, floor is ${INSTANCE_MIN_SILHOUETTE_M2} m2`;
          }
        }
      }
    }
    return null;
  },

  /**
   * EVERY BIG BOX HAS A DOOR.
   *
   * The shipped planner declared none at all on thirteen warehouses, which is why the long walls
   * read as blank extrusions however much roof went on top of them. Doors are instances, so this
   * costs one shared mesh map-wide and no per-building group — there was never a budget reason for
   * their absence.
   */
  'C19-every-building-has-doors': (mod) => {
    for (const row of planAll(mod)) {
      const doors = row.plan.instances.find((family) => family.familyId === 'door-module')?.count ?? 0;
      if (doors < 1) return `building ${row.index} (${row.building.place ?? 'unnamed'}) declares no doors`;
    }
    return null;
  },
};

// --------------------------------------------------------------------------------------------- //
// 1. The shipped module passes every check.
// --------------------------------------------------------------------------------------------- //

test('the shipped planner passes every check against the real 13 big-box buildings', () => {
  const failures = Object.entries(CHECKS)
    .map(([name, check]) => [name, check(shipped)])
    .filter(([, detail]) => detail !== null);
  assert.deepEqual(failures, [], `checks failed:\n${failures.map(([name, detail]) => `  ${name}: ${detail}`).join('\n')}`);
});

test('purity — no THREE, no DOM, no clock, no randomness', () => {
  // Comments are stripped first, so the check reads the CODE. The doc comments in this module name
  // `Math.random` twice, to say it is unavailable and forbidden; a source-text grep would fail on
  // the prose and would then have to be weakened, which is how a real check turns into a dead one.
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(code.includes('export function planDetail'), 'comment stripping removed the code itself');
  for (const banned of ['Math.random', "from 'three'", 'document.', 'window.', 'Date.now', 'require(']) {
    assert.equal(code.includes(banned), false, `big-box.js must not contain ${banned}`);
  }
});

test('the look flip cannot reach the planner', () => {
  assert.throws(
    () => validatePlannerContext({ ...contextFor(BIG_BOX_INDICES[0]), look: 'realistic' }),
    /forbidden/,
    'a context carrying `look` must be rejected by the contract',
  );
});

/**
 * All three flat-parapet footprints ship counter-clockwise, so the reversal branch in the parapet
 * builder never fires on real data and C9 cannot exercise it. A ring's winding is not a documented
 * guarantee of the shipped JSON — it is an accident of the SVG trace — so the branch is proved here
 * against a deliberately reversed copy rather than left as untested defensive code.
 */
test('a clockwise-wound footprint still gets outward-facing parapet walls', () => {
  const index = byPlace('Dorms 2-Story');
  const reversed = { ...BUILDINGS[index], poly: BUILDINGS[index].poly.slice().reverse() };
  assert.equal(shipped.ringIsCounterClockwise(reversed.poly), false, 'the fixture must be clockwise');
  const plan = shipped.planDetail(reversed, contextFor(index));
  const ring = reversed.poly.map(([x, z]) => [Number(x), Number(z)]);
  const cx = -ring.reduce((sum, p) => sum + p[0] / ring.length, 0);
  const cy = -ring.reduce((sum, p) => sum + p[1] / ring.length, 0);
  let flux = 0;
  for (const triangle of meshTriangles(plan.mesh)) {
    if (triangle.slot !== MATERIAL_SLOT_INDEX.wall) continue;
    flux += triangle.area * (triangle.n[0] * (triangle.centroid[0] - cx) + triangle.n[1] * (triangle.centroid[1] - cy));
  }
  assert.ok(flux > 0, `clockwise footprint produced inward-facing parapet walls (flux ${flux.toFixed(1)})`);
});

test('cost — measured triangles and draw calls for the real archetype', () => {
  const rows = planAll(shipped);
  const triangles = rows.reduce((sum, row) => sum + row.plan.mesh.indices.length / 3, 0);
  const instances = rows.reduce((sum, row) => sum + row.plan.instances.reduce((n, family) => n + family.count, 0), 0);
  const area = rows.reduce((sum, row) => sum + row.classification.metrics.areaM2, 0);
  const delta = planDrawCallDelta(rows.map((row) => row.plan));
  const report = rows.map((row) => {
    const tri = row.plan.mesh.indices.length / 3;
    const element = row.plan.roofElements;
    return [
      (row.building.place ?? `#${row.index}`).padEnd(15),
      row.classification.roofForm.padEnd(12),
      `${row.classification.metrics.areaM2.toFixed(0)} m2`.padStart(8),
      `${tri.toString().padStart(4)} tri`,
      `(floor ${shipped.minDetailTrianglesFor(row.classification.metrics.areaM2).toFixed(0).padStart(3)})`,
      `${(tri / row.classification.metrics.areaM2 * 100).toFixed(1).padStart(5)}/100m2`,
      `${element.ridgeBays}b ${element.monitors}L ${element.louvres}v ${element.dormers}d `
        + `${element.decks}k ${element.parapetSegments}p ${element.canopies}c`,
      row.plan.instances.map((family) => `${family.familyId}x${family.count}`).join(' '),
    ].join('  ');
  }).join('\n');
  console.log(`\n${report}\n\ntotal ${triangles} mesh triangles over ${area.toFixed(0)} m2 `
    + `= ${(triangles / area * 100).toFixed(1)} tri/100 m2, ${instances} instances, `
    + `draw-call delta +${delta.total} (${delta.perBuildingGroups} per-building slots + ${delta.instancedFamilies} families) `
    + `= ${delta.framePct.toFixed(2)}% of a 1461-call frame\n`);
  assert.ok(triangles < 2400, `big-box detail is ${triangles} triangles; the archetype budget is 2400`);
  assert.equal(delta.worstPerBuilding, 1);
});

// --------------------------------------------------------------------------------------------- //
// 2. Every check is proved to DISCRIMINATE — the half that stops a metric that cannot fail.
// --------------------------------------------------------------------------------------------- //

const MUTATIONS = [
  {
    id: 'flat-ridge',
    doc: 'collapse the ridge rise so every roof is a crease',
    find: 'const riseM = (baySpan / 2) * tanPitch;',
    replace: 'const riseM = 0.001 * (baySpan / 2) * tanPitch;',
  },
  {
    id: 'one-bay-always',
    doc: 'ignore the span and give every unit a single bay — a 38 m clear span at 6 degrees',
    find: 'const count = Math.max(1, Math.ceil(span / BIG_BOX.maxGableSpanM));',
    replace: 'const count = 1;',
  },
  {
    id: 'one-ridge-per-plan',
    doc: 'stop decomposing: throw ONE unit across the whole oriented bounding box (decision 3 undone)',
    find: 'rectangles.push([us[column], us[lastColumn + 1], vs[row], vs[lastRow + 1]]);',
    replace: 'rectangles.push([us[0], us[us.length - 1], vs[0], vs[vs.length - 1]]);',
  },
  {
    id: 'float-the-roof',
    doc: 'seat the roof six metres above the building',
    find: 'const roofY = baseY + heightM;',
    replace: 'const roofY = baseY + heightM + 6;',
  },
  {
    id: 'flip-roof-winding',
    doc: 'wind the roof planes clockwise so they face the ground',
    find: '            mesh.vertex(p2[0], p2[1], toY),\n            mesh.vertex(p3[0], p3[1], toY),',
    replace: '            mesh.vertex(p3[0], p3[1], toY),\n            mesh.vertex(p2[0], p2[1], toY),',
  },
  {
    /**
     * The direct form of "drop the tiled-roof veto". Flipping the monitor gate alone is a NO-OP on
     * the shipped data and was removed for saying otherwise: rule 4's ceiling already squeezes a
     * lantern on Streamer House's 4.18 m ridge to 0.095 m, under `monitorMinRiseM`, so the veto
     * never gets to do the work there. Reading tile as metal is the mutation that really tests it —
     * both tiled rows lose their dormers, take the industrial pitch, and take a factory clerestory.
     */
    id: 'tile-read-as-metal',
    doc: 'read the authored tile colour as profiled metal — dormers off, factory clerestory on, '
      + 'a 14-degree pitch on a house',
    find: '  return num(colour[0]) - num(colour[2]) > BIG_BOX.tiledRoofRedBias;',
    replace: '  return false;',
  },
  {
    id: 'no-lanterns',
    doc: 'take the clerestory run away again — the state that left Warehouse 4 with 32 triangles',
    find: 'if (!tiled && deepEnough && longEnough) {',
    replace: 'if (false && !tiled && deepEnough && longEnough) {',
  },
  {
    id: 'one-lantern-per-bay',
    doc: 'stop scaling the lantern run with the ridge: one box on a 67.6 m roof, as before',
    find: '  const count = clamp(1, Math.floor(length / BIG_BOX.monitorPitchM), BIG_BOX.monitorMaxCount);',
    replace: '  const count = 1;',
  },
  {
    id: 'constant-plant',
    doc: 'give every flat roof the same plant count regardless of area — variation removed',
    find: 'const plantCount = clamp(2, Math.round(num(metrics.areaM2) / BIG_BOX.plantAreaPerUnitM2), BIG_BOX.plantMaxCount);',
    replace: 'const plantCount = 2;',
  },
  {
    id: 'extra-material-slot',
    doc: 'spend a second extra slot per building by drawing gable ends in `dark`',
    find: '          mesh.tri(\n            SLOT.wall,',
    replace: '          mesh.tri(\n            SLOT.dark,',
  },
  {
    id: 'parapet-inward',
    doc: 'offset every rim the wrong way so its faces point into the building',
    find: '    const nx = ez;\n    const nz = -ex;',
    replace: '    const nx = -ez;\n    const nz = ex;',
  },
  {
    id: 'no-units',
    doc: 'raise the minimum ridge-unit area so every unit falls back to a flat deck',
    find: '  minUnitAreaM2: 20,',
    replace: '  minUnitAreaM2: 20000,',
  },
  {
    id: 'drop-narrow-units',
    doc: 'restore the defect: delete a rectangle too narrow for a ridge instead of decking it, '
      + 'which is what left Streamer House 1.80 m of bare extruded lid',
    find: '  minSliverWidthM: 0.6,',
    replace: '  minSliverWidthM: 3,',
  },
  {
    id: 'deck-not-roofed',
    doc: 'keep the deck units in the decomposition but build nothing on them — the metric that '
      + 'cannot fail, if coverage were read off the unit list instead of off the triangles',
    find: '        pushDeck(unit);',
    replace: '        void unit;',
  },
  {
    id: 'instances-misowned',
    doc: 'attribute every instance to building 0, breaking the floor selector and asset suppression',
    find: '    ownerIndex[index] = buildingIndex;',
    replace: '    ownerIndex[index] = 0;',
  },
  {
    id: 'absolute-instance-level',
    doc: 'report an absolute world height as `levelAboveBaseM` — the classic un-comparable metric',
    find: '        levelAboveBaseM: heightM,\n      });\n    }\n\n    const area = num(metrics.areaM2);',
    replace: '        levelAboveBaseM: roofY,\n      });\n    }\n\n    const area = num(metrics.areaM2);',
  },
  {
    id: 'giant-overhang',
    doc: 'oversail the eaves nine metres past the walls',
    find: '  eaveOverhangM: 0.45,',
    replace: '  eaveOverhangM: 9,',
  },
  {
    id: 'gable-apex-off-ridge',
    doc: 'shift the gable apex off the ridge, leaving a hole under one roof plane and a flap through the other',
    find: '          const apex = localPoint(unit, a, bay.bMid);',
    replace: '          const apex = localPoint(unit, a, bay.bLo);',
  },
  {
    id: 'ignore-authored-roof-colour',
    doc: 'throw the authored `roof` colour away again and pitch every roof the same — the state the renderer is in today',
    find: "export const tanPitchFor = (classification) => (hasTiledRoof(classification) ? TAN_TILED_PITCH : TAN_INDUSTRIAL_PITCH);",
    replace: 'export const tanPitchFor = (classification) => TAN_INDUSTRIAL_PITCH;',
  },
  {
    id: 'sub-pixel-plant',
    doc: 'ship 0.3 m roof plant again — a third of a pixel at the view that matters',
    find: '  plantSizeM: Object.freeze([2.8, 2.2, 1.9]),',
    replace: '  plantSizeM: Object.freeze([2.8, 2.2, 0.3]),',
  },
  {
    id: 'unbounded-roof-rise',
    doc: 'lift rule 4\'s ceiling so the roof form eats the wall it stands on again',
    find: '  maxRoofRiseFraction: 0.45,',
    replace: '  maxRoofRiseFraction: 5,',
  },
  {
    id: 'canopy-underground',
    doc: 'widen the declared canopy band to forty metres — the CONSTANT moved, which is what the '
      + 'agreement clause is for',
    find: '  canopyMaxDropM: 5.5,',
    replace: '  canopyMaxDropM: 40,',
  },
  {
    /**
     * The other half: leave the declared band alone and move the GEOMETRY out of it. Without this
     * the sub-eave half of C4 would only ever be exercised by a constant, which is not the same
     * thing as being exercised at all.
     */
    id: 'canopy-below-its-own-band',
    doc: 'drop the dock canopy three metres past the band the module itself declares',
    find: '        const topY = roofY - dropM;',
    replace: '        const topY = roofY - dropM - 3;',
  },
  {
    id: 'no-doors',
    doc: 'declare no doors at all — the state the shipped planner was in on all thirteen rows',
    find: '    for (let index = 0; index < count; index++) {\n      const a = ((index + 0.5) / count - 0.5) * run;',
    replace: '    for (let index = 0; index < 0; index++) {\n      const a = ((index + 0.5) / count - 0.5) * run;',
  },
  {
    id: 'weaken-the-detail-floor',
    doc: 'move the proportionality floor instead of meeting it — the temptation this whole lane exists to resist',
    find: '  minDetailTrianglePerM2: 0.03,',
    replace: '  minDetailTrianglePerM2: 0.0001,',
  },
  {
    id: 'zero-depth-louvre',
    doc: 'collapse the gable louvre to no depth at all, shipping four zero-area triangles per panel',
    find: '  louvreDepthM: 0.24,',
    replace: '  louvreDepthM: 0,',
  },
  {
    id: 'variation-goes-random',
    doc: 'make the deterministic sub-seed depend on a call counter, so the same building plans '
      + 'differently on every run and the renderer stops being reproducible',
    find: 'function subSeed(seed, ordinal) {\n  let hash = (seed ^ 0x9e3779b9) >>> 0;',
    replace: 'function subSeed(seed, ordinal) {\n  let hash = (seed ^ 0x9e3779b9 ^ (globalThis.__tzMutantTick = (globalThis.__tzMutantTick ?? 0) + 1)) >>> 0;',
  },
  {
    id: 'claim-every-archetype',
    doc: 'plan detail for buildings this planner does not own — the double-claim bug the router exists to prevent',
    find: "if (!classification || classification.archetype !== 'big-box') return null;",
    replace: 'if (!classification) return null;',
  },
];

const scratch = await mkdtemp(join(tmpdir(), 'tz-bigbox-mut-'));
test.after(() => rm(scratch, { recursive: true, force: true }));

/**
 * Load a mutated copy of the shipped source. The two relative imports are rewritten to absolute
 * file URLs so the copy can live outside `src/`; BOTH rewrites are asserted, because a silently
 * unrewritten import would make every mutant fail to load and every mutation "caught" for the wrong
 * reason — which is the same class of defect this harness exists to find.
 */
async function loadMutant(mutation, ordinal) {
  assert.ok(SOURCE.includes(mutation.find), `mutation "${mutation.id}" no longer matches the source — the harness has rotted`);
  let mutated = SOURCE.replace(mutation.find, mutation.replace);
  assert.notEqual(mutated, SOURCE, `mutation "${mutation.id}" changed nothing`);
  for (const [specifier, target] of [
    ["'../three-world.js'", 'src/three-world.js'],
    ["'./contract.js'", 'src/building-detail/contract.js'],
  ]) {
    assert.ok(mutated.includes(`from ${specifier}`), `import ${specifier} not found — cannot relocate the mutant`);
    mutated = mutated.replace(`from ${specifier}`, `from ${JSON.stringify(pathToFileURL(join(ROOT, target)).href)}`);
  }
  const file = join(scratch, `big-box-${ordinal}.mjs`);
  await writeFile(file, mutated, 'utf8');
  return import(pathToFileURL(file).href);
}

for (const [ordinal, mutation] of MUTATIONS.entries()) {
  test(`discriminates <- mutation "${mutation.id}": ${mutation.doc}`, async () => {
    const mutant = await loadMutant(mutation, ordinal);
    const caught = [];
    for (const [name, check] of Object.entries(CHECKS)) {
      let detail = null;
      try {
        detail = check(mutant);
      } catch (error) {
        detail = `threw: ${error.message}`;
      }
      if (detail !== null) caught.push([name, detail]);
    }
    assert.ok(
      caught.length > 0,
      `mutation "${mutation.id}" was not caught by ANY check — a metric that cannot fail (handoff §6)`,
    );
    mutation.caughtBy = caught.map(([name]) => name);
    // The RED text itself, not just the check's name: a coverage list says a mutation was caught,
    // and only the message says what the check actually saw. It is printed so the discrimination
    // evidence is in the run rather than in somebody's notes.
    mutation.firstFailure = `${caught[0][0]}: ${caught[0][1]}`;
  });
}

test('every check is exercised by at least one mutation', () => {
  const covered = new Set(MUTATIONS.flatMap((mutation) => mutation.caughtBy ?? []));
  const uncovered = Object.keys(CHECKS).filter((name) => !covered.has(name));
  // C14 (input untouched) has no dedicated mutation: a mutation that made the planner write to its
  // input would be a rewrite rather than a one-line edit, and the check is cheap insurance against
  // standing decision 4 being violated by accident later. It is named here rather than hidden.
  assert.deepEqual(uncovered, ['C14-input-untouched'], `unexercised checks: ${uncovered.join(', ')}`);
  console.log('\nmutation coverage — the check that fired first, and what it saw:');
  for (const mutation of MUTATIONS) {
    console.log(`  ${mutation.id.padEnd(26)} ${mutation.firstFailure ?? '(not run)'}`);
    console.log(`  ${''.padEnd(26)} also caught by: ${(mutation.caughtBy ?? []).slice(1).join(', ') || '(nothing else)'}`);
  }
});
