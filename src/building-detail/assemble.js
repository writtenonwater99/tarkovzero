/**
 * Building detail assembly — the ONE place the six per-archetype planners meet the renderer.
 *
 * This module is PURE (no THREE, no DOM, no fs, no clock, no `Math.random`) for exactly the reason
 * `src/bridge-structure.js`, `src/buildings.js` and `src/building-archetype.js` are: everything that
 * can be wrong here can be wrong silently, and a test has to be able to assert against the very
 * functions the renderer runs rather than a re-implementation of them. `src/map3d-three.js` turns
 * what comes out of here into `THREE.BufferGeometry` and nothing else.
 *
 * ---------------------------------------------------------------------------------------------
 * THE FOUR THINGS THIS FILE EXISTS TO GET RIGHT
 *
 * 1. ONE ROUTER, ONE PLANNER, ONE PLAN PER BUILDING. `classifyAll()` already throws if the
 *    archetype assignment is not a partition of the input. This module carries that through to the
 *    plans: `planBuildingDetail()` asserts that every building produced exactly one plan, that the
 *    plan's archetype is the one the router assigned, and that the per-archetype plan counts sum to
 *    the building count. A building nothing plans is a thrown error, never a silently undressed box.
 *
 * 2. THE PLAN IS SCALED TO THE MASS THAT IS DRAWN, NOT TO THE ROW. The renderer extrudes
 *    `profile.height` above `profile.baseY`, and on Customs three rows (Warehouse 7, Warehouse 4,
 *    Repair Shop) carry a MEASURED roof 1.06-1.98 m below their data height. A planner handed the
 *    data height would put their roofs in mid-air with daylight under them. So the planner is handed
 *    the drawn height, in `classification.heightM` AND on the building row it reads — while the
 *    ARCHETYPE, ROOF FORM, PROGRAM and SEED stay computed from the shipped row, so the census this
 *    module reports is the same census `scripts/building-archetype.test.mjs` asserts. (Classifying
 *    on the measured height instead moves Warehouse 7 into `program: 'unresolved'`, the loud bucket
 *    that is asserted empty — measured, not assumed.)
 *
 * 3. ONE INSTANCED MESH PER (FAMILY, PROTOTYPE) — NOT PER FAMILY. The contract says "one
 *    InstancedMesh per family, map-wide". Measured against the shipped data that is not achievable
 *    without throwing geometry away: `roof-stack` arrives with THREE distinct prototypes,
 *    `roof-vent` with three and `roof-hatch` with two, because different planners size their own
 *    unit prototypes. Merging them into one mesh keeps one prototype and silently discards the
 *    others' shape — the exact failure `big-box`'s own A15 mutation test is written against. This
 *    module therefore keys the merge on (familyId, prototype digest), which costs 11 meshes instead
 *    of 6 and loses nothing. `mergeInstancedFamilies()` reports both numbers so the divergence is
 *    visible rather than absorbed.
 *
 * 4. GROUPS ARE DRAW CALLS. Three issues one call per material group, so a detail mesh that emits
 *    its groups in planner order would cost as many calls as it has groups. Every building's mass
 *    and detail are therefore re-sorted into ONE contiguous group per MATERIAL SLOT, in
 *    `MATERIAL_SLOTS` order, so a building costs exactly as many calls as it uses distinct slots.
 *
 * 5. A BUILDING MAY NOT GROW. Handoff §4.4 is a STANDING DECISION: the founder judged the building
 *    heights accurate by eye on 2026-09-01, and that judgement is what removed the last dependency
 *    on the parked bounds reader. Every planner nevertheless builds its roof form UPWARD from
 *    `seat.baseY + heightM` — a ridge, a monitor, a parapet coping, a flue — because that is the
 *    only plane it is handed. Measured before this was fixed: 61 of the 71 Customs buildings drew
 *    above their own data height, Warehouse 17 by 6.28 m (a stack riding a ridge on an 11.50 m
 *    building), Warehouse 7 by 6.20 m on 8.31 m, Streamer House by 4.18 m on 9.50 m. That is a
 *    55%-taller building than the one the founder signed off.
 *
 *    `fitPlanToHeight()` closes it with ONE transform and no planner change: the plan is scaled in
 *    z about `seat.baseY` by `heightM / drawnExtent`, and the mass is extruded to
 *    `heightM * fitScaleZ` instead of `heightM`, so the eave drops and the highest thing the
 *    building draws — ridge, coping or flue — lands exactly ON the data height. Nothing horizontal
 *    moves, every proportion between wall, roof and plant is preserved, and the transform is a pure
 *    function of the plan, so it is identical in both looks and reproducible run to run.
 *
 *    A uniform squash rather than a bare eave drop is deliberate and measured: dropping the eave by
 *    the full overshoot puts Warehouse 7's wall at 2.11 m under an 8.31 m ridge and small_buildings
 *    #52's at 0.39 m, and re-planning at the lowered height does not converge (the planners size
 *    their plant off the height they are given, so the residual oscillates -2.06 m / +1.62 m).
 *
 * ---------------------------------------------------------------------------------------------
 * FRAMES. Planner output is ABSOLUTE world space (`gameToWorld(x, z, y) === [-x, -z, y]`), which is
 * what `contract.js` mandates. The building mesh is drawn at `mesh.position.z = profile.baseY` with
 * its geometry in local space so that the floor selector's `mesh.scale.z` squashes from the base
 * rather than from sea level. `assembleBuildingGeometry()` therefore translates detail by
 * `-originZ` on the way in. Get this backwards and every roof on the map sits at twice its height.
 */
import {
  MATERIAL_SLOTS,
  MATERIAL_SLOT_INDEX,
  FREE_MATERIAL_SLOTS,
  INSTANCED_FAMILIES,
  DETAIL_DRAW_CALL_BUDGET,
  validateDetailPlan,
} from './contract.js';
import { classifyAll, ARCHETYPES } from '../building-archetype.js';
import { seatBuilding, skirtCap, PLINTH_EXPAND_M } from '../buildings.js';
import { gameToWorld } from '../three-world.js';

import { planDetail as planBigBox } from './big-box.js';
import { planDetail as planSmallBox } from './small-box.js';
import { planDetail as planGarage } from './garage.js';
import { planDetail as planCylinder } from './cylinder.js';
import { planDetail as planOpenStructure } from './open-structure.js';
import { planDetail as planLatticeTower } from './lattice-tower.js';

/** Exactly one planner per archetype. `unstyled` has none on purpose — see `planBuildingDetail`. */
export const DETAIL_PLANNERS = Object.freeze({
  'big-box': planBigBox,
  'small-box': planSmallBox,
  garage: planGarage,
  cylinder: planCylinder,
  'open-structure': planOpenStructure,
  'lattice-tower': planLatticeTower,
});

export class DetailAssemblyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DetailAssemblyError';
  }
}
const fail = (message) => { throw new DetailAssemblyError(message); };

const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

// --------------------------------------------------------------------------------------------- //
// 1. The seat handed to a planner
// --------------------------------------------------------------------------------------------- //

/**
 * `contract.js` documents the seat as `{ baseY, contactY, loY, hiY, plinthBaseY, plinthHeightM }`;
 * `seatBuilding()` in src/buildings.js returns `{ base, contact, lo, hi, plinthBase, plinthHeight }`.
 * Both spellings are real, three of the six planners read one and one reads either, so BOTH are
 * published. Nothing here invents a value: every field is one of the seat's own, and `baseY` is the
 * floor resolver's measured base where there is one, because that is the plane the mass is drawn on.
 */
export function plannerSeat(seat, profile) {
  const baseY = num(profile?.baseY, num(seat?.base));
  const view = {
    baseY,
    contactY: num(seat?.contact, baseY),
    loY: num(seat?.lo, baseY),
    hiY: num(seat?.hi, baseY),
    plinthBaseY: num(seat?.plinthBase, baseY),
    plinthHeightM: num(seat?.plinthHeight, 0),
  };
  return Object.freeze({
    ...view,
    base: view.baseY,
    contact: view.contactY,
    lo: view.loY,
    hi: view.hiY,
    plinthBase: view.plinthBaseY,
    plinthHeight: view.plinthHeightM,
  });
}

/**
 * The dark skirt, reconciled with a MEASURED base.
 *
 * `seatBuilding()` derives the skirt from the terrain-derived base. Where the floor resolver has a
 * surveyed floor-zero plane the renderer draws the walls from THAT instead, and the skirt has to
 * follow or it detaches from the building it belongs to. This is the same arithmetic
 * `src/map3d.js`'s `placeBuildings()` already applies on the deck path (its lines 953-958),
 * expressed once so both renderers cannot drift apart.
 */
export function reconcilePlinth(seat, profile, heightM) {
  const fallbackBase = num(seat?.plinthBase, num(seat?.base) - 0.35);
  const fallbackHeight = num(seat?.plinthHeight, 0.47);
  if (!profile?.measuredBase) return { baseY: fallbackBase, heightM: fallbackHeight };
  const baseY = num(profile.baseY);
  const maxDrop = skirtCap(heightM);
  const wantedBottom = Math.min(fallbackBase, baseY - 0.35);
  const bottom = Math.max(baseY - maxDrop, wantedBottom);
  return { baseY: bottom, heightM: Math.max(0.47, baseY - bottom + 0.12) };
}

// --------------------------------------------------------------------------------------------- //
// 1b. The height fit — standing decision 4, enforced on geometry rather than asked of six planners
// --------------------------------------------------------------------------------------------- //

/**
 * How far above the data height a building is allowed to draw, in metres: 0.1 mm.
 *
 * It is a float-noise tolerance and nothing else — the residual after the fit is 1.8e-6 m on the
 * worst row, a 30 m water tower, i.e. six significant figures of Float32. It is NOT a slack budget:
 * a tenth of a millimetre on a map read at one pixel per metre is 1e-4 of a pixel, so anything that
 * fails this check failed by something a person can see.
 */
export const DRAWN_HEIGHT_TOLERANCE_M = 1e-4;

/**
 * The highest z ANYTHING in a plan draws, in absolute displayed metres — mesh and instances alike.
 *
 * Instances are the half that is easy to forget and they are where the worst offender lives: the
 * mesh of Warehouse 17 stood 4.58 m above its roof plane, and the single `roof-stack` riding its
 * ridge stood 6.28 m above it. An instance's world top is `offset.z + prototypeTop * scale.z`,
 * because the renderer composes exactly that matrix (`addBuildingDetailInstances`).
 *
 * Returns `-Infinity` for a plan that draws nothing at all, which is a legitimate answer and must
 * not be confused with zero.
 */
export function planDrawnTopY(plan) {
  let top = -Infinity;
  const mesh = plan?.mesh;
  if (mesh) {
    for (let index = 2; index < mesh.positions.length; index += 3) {
      if (mesh.positions[index] > top) top = mesh.positions[index];
    }
  }
  for (const family of plan?.instances ?? []) {
    let prototypeTop = -Infinity;
    const positions = family.prototype?.positions ?? [];
    for (let index = 2; index < positions.length; index += 3) {
      if (positions[index] > prototypeTop) prototypeTop = positions[index];
    }
    if (!Number.isFinite(prototypeTop)) continue;
    for (let index = 0; index < family.count; index++) {
      const candidate = family.offsets[index * 3 + 2] + prototypeTop * family.scales[index * 3 + 2];
      if (candidate > top) top = candidate;
    }
  }
  return top;
}

/**
 * Scale one plan in z about `baseY` by `scaleZ`, returning a NEW plan. Nothing horizontal moves.
 *
 * The three things this has to get right:
 *
 *  - MESH NORMALS. A (1, 1, k) scale transforms a normal by its inverse transpose, (1, 1, 1/k), and
 *    the result has to be re-normalised. Scaling the positions and leaving the normals alone tilts
 *    every roof plane's lighting away from the roof it is lighting — and `small-box` is the one
 *    planner that ships its own normals, so it would be the only archetype that went wrong.
 *  - INSTANCES. `offset.z + protoZ * scale.z` is affine in `protoZ`, so scaling about `baseY` is
 *    exactly `offset.z -> baseY + (offset.z - baseY) * k` and `scale.z -> scale.z * k`. The
 *    prototype itself is shared across buildings and is never touched.
 *  - `levelAboveBaseM`. It is metres above the owner's `seat.baseY` — the instance's own vertical
 *    position, in the same frame as everything else here, so it scales with the rest.
 */
export function fitPlanToHeight(plan, baseY, scaleZ) {
  if (!(scaleZ < 1)) return plan;
  const mesh = plan.mesh
    ? (() => {
      const positions = Float32Array.from(plan.mesh.positions);
      for (let index = 2; index < positions.length; index += 3) {
        positions[index] = baseY + (positions[index] - baseY) * scaleZ;
      }
      let normals;
      if (plan.mesh.normals) {
        normals = Float32Array.from(plan.mesh.normals);
        for (let index = 0; index < normals.length; index += 3) {
          const nx = normals[index];
          const ny = normals[index + 1];
          const nz = normals[index + 2] / scaleZ;
          const length = Math.hypot(nx, ny, nz);
          if (length > 1e-12) {
            normals[index] = nx / length;
            normals[index + 1] = ny / length;
            normals[index + 2] = nz / length;
          }
        }
      }
      return { ...plan.mesh, positions, ...(normals ? { normals } : {}) };
    })()
    : plan.mesh;
  const instances = (plan.instances ?? []).map((family) => {
    const offsets = Float32Array.from(family.offsets);
    const scales = Float32Array.from(family.scales);
    const levelAboveBaseM = Float32Array.from(family.levelAboveBaseM);
    for (let index = 0; index < family.count; index++) {
      offsets[index * 3 + 2] = baseY + (offsets[index * 3 + 2] - baseY) * scaleZ;
      scales[index * 3 + 2] *= scaleZ;
      levelAboveBaseM[index] *= scaleZ;
    }
    return { ...family, offsets, scales, levelAboveBaseM };
  });
  return { ...plan, mesh, instances };
}

/**
 * The scale that puts a building's whole drawn extent inside its data height.
 *
 * `heightM` is the plane the mass is extruded to and the plane every planner builds from, so the
 * mass's own top is always exactly `heightM` above the base and can never force a scale on its own.
 * Only what a planner put ABOVE that plane can — which is the defect, stated as arithmetic.
 */
export function heightFitScale(plan, baseY, heightM, { replacesMass = false } = {}) {
  if (!(heightM > 0)) return 1;
  const planTop = planDrawnTopY(plan);
  const massTop = replacesMass ? -Infinity : baseY + heightM;
  const top = Math.max(planTop, massTop);
  if (!Number.isFinite(top)) return 1;
  const extent = top - baseY;
  if (!(extent > heightM + DRAWN_HEIGHT_TOLERANCE_M)) return 1;
  return heightM / extent;
}

// --------------------------------------------------------------------------------------------- //
// 2. The routing pass
// --------------------------------------------------------------------------------------------- //

/** A planner that returns `null` "adds nothing"; a planner that never ran is a defect. */
const NOT_RUN = Symbol('planner-not-run');

/**
 * Classify every building once, run exactly one planner on each, and check the result is a
 * partition of the input.
 *
 * @param {object[]} buildings   rows from `public/data/customs-3d.json`, already seated by
 *                               `placeBuildings()` (only `poly`/`height`/`floors`/... are read).
 * @param {object} options
 * @param {(x:number,z:number)=>number} options.groundYAt  draped ground, DISPLAYED metres.
 * @param {(building:object, index:number)=>object} options.profileFor
 *        the floor resolver's building profile: `{ baseY, height, measuredBase, floorCount, ... }`.
 */
export function planBuildingDetail(buildings, { groundYAt, profileFor } = {}) {
  if (typeof groundYAt !== 'function') fail('planBuildingDetail: groundYAt must be a function');
  if (typeof profileFor !== 'function') fail('planBuildingDetail: profileFor must be a function');
  const rows = Array.isArray(buildings) ? buildings : [];

  /**
   * The ROUTER's own partition, computed here and not per row.
   *
   * `classifyAll()` is the function that throws when the archetype assignment is not a partition of
   * the input — a building claimed twice, a building claimed by nothing, a census that does not sum.
   * Calling `classifyBuilding()` 71 times instead ran the classifier and skipped every one of those
   * checks, so the invariant this module's header claims to "carry through" was never exercised at
   * run time at all. It is now on the only path the renderer takes.
   */
  const routed = classifyAll(rows);

  const planned = new Array(rows.length).fill(NOT_RUN);
  const out = new Array(rows.length).fill(null);
  const byArchetype = Object.fromEntries(ARCHETYPES.map((key) => [key, 0]));
  const roofCensus = {};
  const programCensus = {};

  rows.forEach((building, index) => {
    const shipped = routed.assignments[index];
    const profile = profileFor(building, index) ?? {};
    const seat = seatBuilding(building, groundYAt);
    const drawnHeightM = num(profile.height, num(building?.height));
    // The mass that is DRAWN. Archetype / roofForm / program / seed stay the shipped row's — see
    // item 2 in the header. Only the height follows the mass.
    const classification = Object.freeze({ ...shipped, heightM: drawnHeightM });
    const drawnBuilding = { ...building, height: drawnHeightM };
    const seatView = plannerSeat(seat, profile);

    byArchetype[classification.archetype] += 1;
    roofCensus[classification.roofForm] = (roofCensus[classification.roofForm] ?? 0) + 1;
    programCensus[classification.program] = (programCensus[classification.program] ?? 0) + 1;

    const planner = DETAIL_PLANNERS[classification.archetype];
    if (!planner) {
      // `unstyled` is the router's loud bucket and is asserted empty for Customs. Reaching it here
      // means a NEW archetype was added without a planner, which must not render as a bare box.
      fail(`building ${index} routed to "${classification.archetype}", which has no planner`);
    }

    const plan = planner(drawnBuilding, {
      buildingIndex: index,
      classification,
      seat: seatView,
      groundYAt,
    });
    if (plan === null || plan === undefined) {
      fail(
        `building ${index} ("${classification.place ?? classification.name ?? classification.kind}") `
        + `was routed to "${classification.archetype}" but its planner declined it — `
        + 'exactly one planner owns exactly one archetype, so a decline here is a routing defect',
      );
    }
    validateDetailPlan(plan, { buildingCount: rows.length, archetype: classification.archetype });
    if (plan.buildingIndex !== index) {
      fail(`building ${index} got a plan stamped buildingIndex ${plan.buildingIndex}`);
    }
    /**
     * KEYED ON WHAT THE PLANNER STAMPED, NEVER ON THE LOOP COUNTER.
     *
     * This was the vacuous half. `planned[index]` and an `out.push()` are both functions of the
     * `forEach` index alone, so `missing`, `bucketed !== rows.length` and `out.length !== rows.length`
     * were unreachable for EVERY possible input — proven, by deleting the stamp check above and
     * making a planner stamp `buildingIndex: 38` on all 71 plans: every count still summed to 71.
     * Reading the slot out of the plan itself is what makes those three guards able to fire.
     */
    const stamped = plan.buildingIndex;
    if (!Number.isInteger(stamped) || stamped < 0 || stamped >= rows.length) {
      fail(`building ${index} got a plan stamped buildingIndex ${stamped}, which is not a row index`);
    }
    if (planned[stamped] !== NOT_RUN) {
      fail(`two plans claim buildingIndex ${stamped} — the second came from row ${index}`);
    }
    planned[stamped] = plan;

    const replacesMass = plan.replacesMass === true || plan.massDisposition === 'replace';
    // Standing decision 4: the highest thing this building draws lands ON its data height, never
    // above it. See item 5 in the header for why this is a scale and not an eave drop.
    const fitScaleZ = heightFitScale(plan, seatView.baseY, drawnHeightM, { replacesMass });
    const fitted = fitPlanToHeight(plan, seatView.baseY, fitScaleZ);
    const drawnTopY = Math.max(
      planDrawnTopY(fitted),
      replacesMass ? -Infinity : seatView.baseY + drawnHeightM * fitScaleZ,
    );

    out[stamped] = Object.freeze({
      index: stamped,
      building,
      drawnBuilding,
      classification,
      profile,
      seat: seatView,
      plan: fitted,
      /**
       * The depth the renderer extrudes. `drawnHeightM` is the plane the PLANNER was given; the
       * mass is drawn to the fitted one so the eave meets the roof the planner built for it.
       */
      massHeightM: drawnHeightM * fitScaleZ,
      fitScaleZ,
      /** Metres from `seat.baseY` to the highest thing this building draws, after the fit. */
      drawnTopAboveBaseM: Number.isFinite(drawnTopY) ? drawnTopY - seatView.baseY : 0,
      /** Two planners spell this differently; the renderer must honour both. */
      replacesMass,
      suppressPlinth: plan.suppressPlinth === true,
      plinth: reconcilePlinth(seat, profile, drawnHeightM),
      detailTriangles: fitted.mesh ? fitted.mesh.indices.length / 3 : 0,
    });
  });

  const missing = planned.reduce((acc, value, index) => (value === NOT_RUN ? [...acc, index] : acc), []);
  if (missing.length) fail(`${missing.length} building(s) were never planned: ${missing.join(', ')}`);
  const bucketed = ARCHETYPES.reduce((sum, key) => sum + byArchetype[key], 0);
  if (bucketed !== rows.length) {
    fail(`archetype plan counts sum to ${bucketed}, but ${rows.length} buildings were handed in`);
  }
  const orphaned = out.reduce((acc, value, index) => (value === null ? [...acc, index] : acc), []);
  if (orphaned.length) fail(`${orphaned.length} building(s) got no row: ${orphaned.join(', ')}`);
  if (out.length !== rows.length) fail(`${out.length} plans for ${rows.length} buildings`);
  // The router's partition and the planned census are the same partition, or one of them is lying.
  for (const archetype of ARCHETYPES) {
    if (byArchetype[archetype] !== routed.byArchetype[archetype].length) {
      fail(
        `archetype "${archetype}": ${byArchetype[archetype]} plans against `
        + `${routed.byArchetype[archetype].length} routed buildings`,
      );
    }
  }

  const families = mergeInstancedFamilies(out.map((row) => row.plan));
  return {
    count: rows.length,
    rows: out,
    plans: out.map((row) => row.plan),
    byArchetype,
    roofCensus,
    programCensus,
    families,
    stats: detailStats(out, families),
  };
}

// --------------------------------------------------------------------------------------------- //
// 3. Instanced families
// --------------------------------------------------------------------------------------------- //

/**
 * A stable digest of one unit prototype. Positions are quantised to 0.1 mm so float noise cannot
 * split a family, and the index list is included because two prototypes can share vertices and
 * differ in winding (an open-bottomed box versus a closed one — big-box's A15 mutation).
 */
export function prototypeDigest(prototype) {
  const positions = prototype?.positions ?? [];
  const indices = prototype?.indices ?? [];
  let hash = 0x811c9dc5;
  const push = (text) => {
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  };
  push(`p${positions.length}:`);
  for (let index = 0; index < positions.length; index++) push(`${Math.round(positions[index] * 10000)},`);
  push(`i${indices.length}:`);
  for (let index = 0; index < indices.length; index++) push(`${indices[index]},`);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Merge every plan's instance declarations into the meshes the renderer will actually build.
 *
 * Keyed on (familyId, prototype digest), NOT on familyId alone — see item 3 in the header. Each
 * returned row is one `THREE.InstancedMesh`: one geometry, one material slot, `count` instances,
 * and the parallel `ownerIndex` array the authored-asset suppression walk needs, alongside each
 * instance's own `levelAboveBaseM`.
 */
export function mergeInstancedFamilies(plans) {
  const buckets = new Map();
  for (const plan of (Array.isArray(plans) ? plans : []).filter(Boolean)) {
    for (const family of plan.instances ?? []) {
      const spec = INSTANCED_FAMILIES[family.familyId];
      if (!spec) fail(`plan[${plan.buildingIndex}] declares unregistered family "${family.familyId}"`);
      const digest = prototypeDigest(family.prototype);
      const key = `${family.familyId}#${digest}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          familyId: family.familyId,
          prototypeDigest: digest,
          materialSlot: MATERIAL_SLOT_INDEX[spec.materialSlot],
          materialSlotName: spec.materialSlot,
          prototype: family.prototype,
          count: 0,
          offsets: [], yaws: [], scales: [], ownerIndex: [], levelAboveBaseM: [],
          owners: new Set(),
        };
        buckets.set(key, bucket);
      }
      for (let index = 0; index < family.count; index++) {
        bucket.offsets.push(family.offsets[index * 3], family.offsets[index * 3 + 1], family.offsets[index * 3 + 2]);
        bucket.yaws.push(family.yaws[index]);
        bucket.scales.push(family.scales[index * 3], family.scales[index * 3 + 1], family.scales[index * 3 + 2]);
        bucket.ownerIndex.push(family.ownerIndex[index]);
        bucket.levelAboveBaseM.push(family.levelAboveBaseM[index]);
        bucket.owners.add(family.ownerIndex[index]);
      }
      bucket.count += family.count;
    }
  }
  const merged = [...buckets.values()]
    .sort((a, b) => (a.familyId < b.familyId ? -1 : a.familyId > b.familyId ? 1 : a.prototypeDigest.localeCompare(b.prototypeDigest)))
    .map((bucket) => ({
      familyId: bucket.familyId,
      prototypeDigest: bucket.prototypeDigest,
      materialSlot: bucket.materialSlot,
      materialSlotName: bucket.materialSlotName,
      prototype: bucket.prototype,
      count: bucket.count,
      offsets: Float32Array.from(bucket.offsets),
      yaws: Float32Array.from(bucket.yaws),
      scales: Float32Array.from(bucket.scales),
      ownerIndex: Int32Array.from(bucket.ownerIndex),
      levelAboveBaseM: Float32Array.from(bucket.levelAboveBaseM),
      owners: [...bucket.owners].sort((a, b) => a - b),
      prototypeTriangles: (bucket.prototype?.indices?.length ?? 0) / 3,
    }));
  const perFamily = new Map();
  for (const row of merged) perFamily.set(row.familyId, (perFamily.get(row.familyId) ?? 0) + 1);
  merged.familyIds = [...perFamily.keys()];
  /** Distinct prototypes per family. Anything above 1 is the divergence item 3 documents. */
  merged.prototypesPerFamily = Object.fromEntries(perFamily);
  return merged;
}

// --------------------------------------------------------------------------------------------- //
// 4. Geometry assembly — one contiguous group per material slot
// --------------------------------------------------------------------------------------------- //

function faceNormal(ax, ay, az, bx, by, bz, cx, cy, cz) {
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz);
  return length > 1e-12 ? [nx / length, ny / length, nz / length] : [0, 0, 1];
}

/**
 * Merge one building's mass and its detail plan into a single NON-INDEXED triangle soup whose
 * groups are one contiguous range per material slot, in `MATERIAL_SLOTS` order.
 *
 * Non-indexed because `THREE.ExtrudeGeometry` is non-indexed: converting it to an indexed buffer to
 * meet the detail's indexed convention would weld vertices across a bevel and round off every
 * corner on the map. Going the other way — expanding the detail's indices — costs a few thousand
 * duplicated vertices and cannot change a single pixel.
 *
 * @param {object} options
 * @param {?{positions:Float32Array, normals:?Float32Array, groups:Array}} options.mass
 *        the extruded shell in LOCAL space (z measured from the mesh origin), group `start`/`count`
 *        in VERTICES, which is three's own convention for a non-indexed geometry. `null` for a
 *        building whose planner replaces the mass.
 * @param {?object} options.detail  the plan's `mesh`, indexed, in ABSOLUTE world space.
 * @param {number} options.originZ  the mesh's world z, subtracted from the detail.
 */
export function assembleBuildingGeometry({ mass = null, detail = null, originZ = 0 } = {}) {
  const bySlot = MATERIAL_SLOTS.map(() => ({ positions: [], normals: [] }));

  if (mass) {
    const groups = mass.groups?.length
      ? mass.groups
      : [{ start: 0, count: mass.positions.length / 3, materialSlot: MATERIAL_SLOT_INDEX.wall }];
    for (const group of groups) {
      const bucket = bySlot[group.materialSlot];
      if (!bucket) fail(`mass group materialSlot ${group.materialSlot} is not a MATERIAL_SLOTS index`);
      for (let vertex = group.start; vertex < group.start + group.count; vertex++) {
        bucket.positions.push(mass.positions[vertex * 3], mass.positions[vertex * 3 + 1], mass.positions[vertex * 3 + 2]);
        if (mass.normals) {
          bucket.normals.push(mass.normals[vertex * 3], mass.normals[vertex * 3 + 1], mass.normals[vertex * 3 + 2]);
        } else {
          bucket.normals.push(Number.NaN, Number.NaN, Number.NaN);
        }
      }
    }
  }

  if (detail) {
    const slotOf = new Int32Array(detail.indices.length);
    for (const group of detail.groups) {
      for (let index = group.start; index < group.start + group.count; index++) slotOf[index] = group.materialSlot;
    }
    for (let triangle = 0; triangle < detail.indices.length; triangle += 3) {
      const bucket = bySlot[slotOf[triangle]];
      if (!bucket) fail(`detail group materialSlot ${slotOf[triangle]} is not a MATERIAL_SLOTS index`);
      const corners = [detail.indices[triangle], detail.indices[triangle + 1], detail.indices[triangle + 2]];
      const xyz = corners.map((corner) => [
        detail.positions[corner * 3],
        detail.positions[corner * 3 + 1],
        detail.positions[corner * 3 + 2] - originZ,
      ]);
      const flat = detail.normals ? null : faceNormal(...xyz[0], ...xyz[1], ...xyz[2]);
      for (const [ordinal, corner] of corners.entries()) {
        bucket.positions.push(xyz[ordinal][0], xyz[ordinal][1], xyz[ordinal][2]);
        if (detail.normals) {
          bucket.normals.push(detail.normals[corner * 3], detail.normals[corner * 3 + 1], detail.normals[corner * 3 + 2]);
        } else {
          bucket.normals.push(flat[0], flat[1], flat[2]);
        }
      }
    }
  }

  const positions = [];
  const normals = [];
  const groups = [];
  let cursor = 0;
  let needsComputedNormals = false;
  for (const [slot, bucket] of bySlot.entries()) {
    const vertices = bucket.positions.length / 3;
    if (!vertices) continue;
    // Appended one at a time on purpose: `push(...array)` puts every element on the argument stack
    // and a warehouse's extrusion is tens of thousands of floats.
    for (let index = 0; index < bucket.positions.length; index++) positions.push(bucket.positions[index]);
    for (let index = 0; index < bucket.normals.length; index++) {
      normals.push(bucket.normals[index]);
      if (!Number.isFinite(bucket.normals[index])) needsComputedNormals = true;
    }
    groups.push({ start: cursor, count: vertices, materialSlot: slot });
    cursor += vertices;
  }
  return {
    positions: Float32Array.from(positions),
    // A mass without normals (a stub, or a geometry three has not computed yet) makes the whole
    // buffer untrustworthy, so it is dropped and the renderer computes flat normals instead of
    // shipping NaNs into a lighting equation.
    normals: needsComputedNormals ? null : Float32Array.from(normals),
    groups,
    vertices: cursor,
    triangles: cursor / 3,
    slots: groups.map((group) => MATERIAL_SLOTS[group.materialSlot]),
  };
}

// --------------------------------------------------------------------------------------------- //
// 5. The plinth skirt (decision 5: it is already computed, and nothing draws it)
// --------------------------------------------------------------------------------------------- //

/** `expand()` from src/map3d.js, which is what the deck renderer's skirt already uses. */
function expandRing(poly, metres) {
  const centre = poly.reduce((acc, point) => [acc[0] + point[0] / poly.length, acc[1] + point[1] / poly.length], [0, 0]);
  return poly.map(([x, z]) => {
    const dx = x - centre[0], dz = z - centre[1];
    const length = Math.hypot(dx, dz) || 1;
    return [x + (dx / length) * metres, z + (dz / length) * metres];
  });
}

/**
 * Twice the signed area of a ring in the plane the triangles are emitted in.
 *
 * Positive is counter-clockwise. It is computed on the WORLD ring — the expanded one, after
 * `gameToWorld` — because that is the ring whose winding decides which way a face points, and
 * asking the game-space ring is one coordinate flip away from being a coin toss.
 */
export function ringSignedArea2(ring) {
  let sum = 0;
  for (let index = 0; index < ring.length; index++) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[(index + 1) % ring.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum;
}

/**
 * One merged skirt for the whole map.
 *
 * The skirt is the SIDES of a prism under each footprint: near-black, unlit, capped, and expanded by
 * `PLINTH_EXPAND_M` — never the 0.25 m lit foundation ledge `src/buildings.js` was written to
 * delete. No cap is emitted: its top laps 0.12 m up BEHIND the wall base, so a cap would be inside
 * the building.
 *
 * One mesh, one draw call, for all 71 — which is why `excluded` exists rather than per-building
 * nodes: the renderer rebuilds this buffer when the authored-asset ledger changes, and a suppressed
 * building's skirt leaves with it.
 *
 * @param {Array} rows      `planBuildingDetail().rows`
 * @param {Set<number>} excluded  building indices whose skirt must not be drawn
 */
export function plinthMeshData(rows, excluded = new Set()) {
  const positions = [];
  const drawn = [];
  let reversedRings = 0;
  for (const row of rows ?? []) {
    if (row.suppressPlinth) continue;
    if (excluded.has(row.index)) continue;
    const ring = Array.isArray(row.building?.poly) ? row.building.poly : [];
    if (ring.length < 3) continue;
    const heightM = num(row.plinth?.heightM);
    if (!(heightM > 0.02)) continue;
    const bottom = num(row.plinth?.baseY);
    const top = bottom + heightM;
    const outer = expandRing(ring, PLINTH_EXPAND_M);
    /**
     * WINDING, NOT COUNT, IS WHAT DECIDES WHETHER A SKIRT IS ON SCREEN.
     *
     * `(a0, b0, b1)` / `(a0, b1, a1)` has the normal `(dy, -dx)` — the edge turned clockwise —
     * which faces OUT of a counter-clockwise ring and INTO a clockwise one. 34 of the 71 Customs
     * footprints wind clockwise, `materials.plinth` declares no `side`, and three's default is
     * `FrontSide`: measured with three's own side-aware raycaster, 30 of 67 skirts were being
     * back-face culled, leaving the very gaps they exist to close open — Big Red 4.02 m, Water Pump
     * 3.64 m, Warehouse 4 1.90 m, Fortress 1.50 m and twenty more.
     *
     * The fix is the winding, at the source. `side: THREE.DoubleSide` would also have made them
     * visible and would have kept the defect: every skirt would then draw its INNER face too, the
     * building's own walls would be lit through it from inside, and the map would pay double the
     * fragments for a mesh that is never seen from within. Back-face culling stays on.
     */
    const ccw = ringSignedArea2(outer.map(([x, z]) => {
      const [wx, wy] = gameToWorld(x, z, 0);
      return [wx, wy];
    })) >= 0;
    if (!ccw) reversedRings += 1;
    for (let index = 0; index < outer.length; index++) {
      const [ax, az] = outer[index];
      const [bx, bz] = outer[(index + 1) % outer.length];
      const a0 = gameToWorld(ax, az, bottom);
      const b0 = gameToWorld(bx, bz, bottom);
      const a1 = gameToWorld(ax, az, top);
      const b1 = gameToWorld(bx, bz, top);
      if (ccw) positions.push(...a0, ...b0, ...b1, ...a0, ...b1, ...a1);
      else positions.push(...a0, ...b1, ...b0, ...a0, ...a1, ...b1);
    }
    drawn.push(row.index);
  }
  return {
    positions: Float32Array.from(positions),
    triangles: positions.length / 9,
    buildings: drawn.length,
    drawn,
    /** Footprints whose winding had to be reversed to face outward. Reporting, not a check. */
    reversedRings,
  };
}

// --------------------------------------------------------------------------------------------- //
// 6. Instance visibility — the authored-asset suppression walk
// --------------------------------------------------------------------------------------------- //

/**
 * Which instances of one merged family may be drawn.
 *
 * An instance is a separate object and does not ride its owner mesh's `visible = false`, so an
 * instance belonging to a building whose procedural node has been retired for an authored GLB has
 * to be dropped by owner here, or roof plant hovers over the Fortress forever.
 *
 * OWNERSHIP IS THE ONLY TEST. There used to be a second one — an instance whose `levelAboveBaseM`
 * stood above the floor selector's cut height was dropped as well — and it went out with the floor
 * selector itself (2026-09-02, founder: "floor system fully out the project"). Nothing else in the
 * renderer ever cut a building short, so every instance an unsuppressed owner declares is drawn:
 * measured, 199 of 199 on Customs, which is exactly what the selector already showed on "ALL".
 *
 * @param {object} family  a row from `mergeInstancedFamilies()`
 * @param {object} options
 * @param {Set<number>} options.suppressed  owners whose procedural node is retired
 * @returns {number[]} indices into the family's parallel arrays, in order
 */
export function visibleInstanceIndices(family, { suppressed = new Set() } = {}) {
  const out = [];
  for (let index = 0; index < family.count; index++) {
    if (suppressed.has(family.ownerIndex[index])) continue;
    out.push(index);
  }
  return out;
}

// --------------------------------------------------------------------------------------------- //
// 7. The cost, stated rather than estimated
// --------------------------------------------------------------------------------------------- //

/**
 * What the buildings cost BEFORE this lane and what they cost after, from the same rows.
 *
 * Before (the renderer as production has served it): every building was one `ExtrudeGeometry` with
 * TWO material groups plus one `EdgesGeometry` outline = 3 calls, except the single row that took
 * the `place === 'skeleton'` open-frame literal, which is one mesh with one group and no outline.
 * `LEGACY_OPEN_FRAME_DRAW_CALLS` is asserted against the real asset in the wiring test rather than
 * asserted here, because building it needs THREE and this module may not import it.
 *
 * After: one call per distinct material slot a building uses, plus one outline per building that
 * still has a mass to outline, plus one merged skirt for the whole map, plus one mesh per
 * (family, prototype).
 *
 * Floor slabs are unchanged by this lane and are counted in neither number.
 */
export const LEGACY_OPEN_FRAME_DRAW_CALLS = 1;

export function detailStats(rows, families) {
  let before = 0;
  let after = 0;
  let outlines = 0;
  let detailTriangles = 0;
  const slotUse = Object.fromEntries(MATERIAL_SLOTS.map((name) => [name, 0]));
  const free = new Set(FREE_MATERIAL_SLOTS.map((name) => MATERIAL_SLOT_INDEX[name]));
  let extraSlotsWorst = 0;

  for (const row of rows) {
    const legacyOpenFrame = String(row.building?.place ?? '').trim().toLowerCase() === 'skeleton'
      && num(row.profile?.height, num(row.building?.height)) >= 8;
    before += legacyOpenFrame ? LEGACY_OPEN_FRAME_DRAW_CALLS : 3;

    const used = new Set();
    if (!row.replacesMass) { used.add(MATERIAL_SLOT_INDEX.wall); used.add(MATERIAL_SLOT_INDEX.roof); }
    for (const group of row.plan.mesh?.groups ?? []) used.add(group.materialSlot);
    for (const slot of used) slotUse[MATERIAL_SLOTS[slot]] += 1;
    extraSlotsWorst = Math.max(extraSlotsWorst, [...used].filter((slot) => !free.has(slot)).length);
    after += used.size;
    if (!row.replacesMass) { after += 1; outlines += 1; }
    detailTriangles += row.detailTriangles;
  }

  const instancedMeshes = families.length;
  const instances = families.reduce((sum, family) => sum + family.count, 0);
  const instanceTriangles = families.reduce((sum, family) => sum + family.count * family.prototypeTriangles, 0);
  after += instancedMeshes + 1; // + the one merged skirt

  // The height fit, stated. `worstOvershootM` is what is left ABOVE the data height after fitting,
  // over every row: it is the number standing decision 4 is about, and it must be ~0.
  let fitted = 0;
  let worstFitScaleZ = 1;
  let worstOvershootM = -Infinity;
  for (const row of rows) {
    if (row.fitScaleZ < 1) fitted += 1;
    worstFitScaleZ = Math.min(worstFitScaleZ, row.fitScaleZ ?? 1);
    worstOvershootM = Math.max(
      worstOvershootM,
      (row.drawnTopAboveBaseM ?? 0) - num(row.profile?.height, num(row.building?.height)),
    );
  }

  return {
    buildings: rows.length,
    heightFits: fitted,
    worstFitScaleZ,
    worstOvershootM: Number.isFinite(worstOvershootM) ? worstOvershootM : 0,
    before,
    after,
    delta: after - before,
    outlines,
    instancedMeshes,
    instances,
    instancedFamilies: families.familyIds?.length ?? 0,
    prototypesPerFamily: families.prototypesPerFamily ?? {},
    slotUse,
    worstExtraSlotsPerBuilding: extraSlotsWorst,
    replacedMasses: rows.filter((row) => row.replacesMass).length,
    suppressedPlinths: rows.filter((row) => row.suppressPlinth).length,
    detailTriangles,
    instanceTriangles,
  };
}

/**
 * What the buildings cost RIGHT NOW, derived from live state at the moment it is read.
 *
 * `renderStats().buildings` used to be an object literal built once, inside `addBuildings()`. Every
 * number in it that can change afterwards was therefore frozen at mount: `rebuildPlinths()`
 * reassigns the skirt counts whenever an authored GLB retires a building, and the console kept
 * reporting 67 skirts / 756 triangles while the frame drew 66 / 748. Handoff §6: a metric that
 * cannot fail is worse than no metric, and a metric that cannot CHANGE is the same defect wearing a
 * different hat.
 *
 * This function takes the build-time constants that genuinely cannot change (the mass and detail
 * triangle counts, the group and outline counts, the pre-lane baseline) and the live readings, and
 * derives everything that depends on both. The renderer calls it inside the getter.
 *
 * @param {object} base  `planBuildingDetail().stats` plus the renderer's build-time counts
 * @param {object} live  `{ plinths: {buildings, triangles}, instancedMeshes, instancesDrawn, skirtDrawCalls }`
 */
export function buildingRenderStatsNow(base, live = {}) {
  if (!base) return null;
  const plinths = live.plinths ?? { buildings: 0, triangles: 0 };
  const instancedMeshes = num(live.instancedMeshes, 0);
  const skirtDrawCalls = num(live.skirtDrawCalls, 0);
  const after = num(base.groups) + num(base.outlinesBuilt) + instancedMeshes + skirtDrawCalls;
  return {
    ...base,
    drawCalls: {
      before: base.before,
      after,
      delta: after - base.before,
      framePct: ((after - base.before) / DETAIL_DRAW_CALL_BUDGET.baselineFrameDrawCalls) * 100,
    },
    triangles: {
      mass: num(base.massTriangles),
      detail: num(base.detailTriangles),
      instanced: num(base.instanceTriangles),
      plinth: num(plinths.triangles),
      total: num(base.massTriangles) + num(base.detailTriangles)
        + num(base.instanceTriangles) + num(plinths.triangles),
    },
    plinths: { ...plinths },
    instancedMeshesBuilt: instancedMeshes,
    instancesDrawn: num(live.instancesDrawn, 0),
  };
}
