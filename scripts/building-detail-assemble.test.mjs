/**
 * The building-detail WIRING, asserted against all 71 real Customs buildings.
 *
 * Run: `node --test scripts/building-detail-assemble.test.mjs`
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THIS SUITE IS FOR
 *
 * Six per-archetype planners already have their own suites and are green. Nothing in any of them
 * can catch the failures that live in the SEAM: a building nobody plans, a plan planned twice, a
 * roof seated on the data height while the mass is drawn at a measured one, detail merged into a
 * mesh without subtracting the mesh's own origin, eleven instanced prototypes merged into six
 * meshes with five shapes thrown away, an outline run over the detail until it reads as hatching,
 * or a skirt that `src/buildings.js` has computed since 2026-08-30 and that nothing draws.
 *
 * Every one of those reports success while being wrong on screen. Handoff §6: a metric that cannot
 * fail is worse than no metric. So Part 3 mutates the shipped source of `assemble.js` and of
 * `map3d-three.js`, re-runs the whole assertion set against the mutant, and FAILS if a mutation is
 * not caught — and fails if a mutation's search string has gone, so the harness cannot rot into a
 * no-op.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY IT DOES NOT IMPORT THE RENDERER
 *
 * `src/map3d-three.js` pulls in `src/terrain.js`, which pulls in `@deck.gl/core`, which imports in
 * 197 s from `/mnt/c` (handoff §7). Renderer wiring is therefore asserted against its SOURCE TEXT —
 * the same technique `scripts/three-renderer-test.mjs` already uses for the bridge lane — while
 * everything a GPU is not needed for is asserted against the real functions and the real data.
 * `three/webgpu` itself is cheap (0.36 s) and IS imported, because the outline trap is a fact about
 * `THREE.EdgesGeometry` and can only be measured by running it.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import * as THREE from 'three/webgpu';

import { classifyAll } from '../src/building-archetype.js';
import { MATERIAL_SLOTS, MATERIAL_SLOT_INDEX, PLANNER_CONTEXT_KEYS } from '../src/building-detail/contract.js';
import * as assembleModule from '../src/building-detail/assemble.js';
import { placeBuildings } from '../src/buildings.js';
import { createFloorSurfaceResolver } from '../src/surfaces.js';
import { makeTerrainSampler } from '../src/three-world.js';

const ASSEMBLE_URL = new URL('../src/building-detail/assemble.js', import.meta.url);
const RENDERER_URL = new URL('../src/map3d-three.js', import.meta.url);
const ASSEMBLE_SOURCE = await readFile(ASSEMBLE_URL, 'utf8');
const RENDERER_SOURCE = await readFile(RENDERER_URL, 'utf8');
const customs3d = JSON.parse(await readFile(new URL('../public/data/customs-3d.json', import.meta.url), 'utf8'));

/**
 * `THREE_FIXED_RELIEF` in src/map3d-three.js. Not a detail: relief is what turns real cross-slope
 * into displayed cross-slope, and therefore what makes the skirt and the per-foot seating visible
 * rather than academic.
 */
const RELIEF = 2;
const groundYAt = makeTerrainSampler(customs3d.terrain, RELIEF);
const BUILDING_COUNT = customs3d.buildings.length;
const ROUTED = classifyAll(customs3d.buildings);
/**
 * The two `cylinder` rows that replace their mass, restated here as literals rather than asked of
 * the planner — the point of the assertions below is to pin WHICH buildings draw no extruded block,
 * so reading the answer out of the module under test would make them vacuous.
 *
 * Rows 14 and 19 are `kind: "cooling_tower"`, `height: 30`, and their `poly` is a four-vertex
 * RECTANGLE (13.86 x 10.00 m and 23.91 x 16.19 m). With the mass left in place the renderer
 * extruded those rectangles 30 m and the two tallest non-pylon objects on Customs were boxes. The
 * cylinder planner now draws them itself, as elliptic hyperboloid shells inscribed in their own
 * OBBs. Row 13 — the one cooling tower whose footprint really is a 16-gon — keeps its extrusion and
 * its additive detail, and is deliberately NOT in this list.
 */
const REPLACED_COOLING_TOWERS = [14, 19];

/** Exactly what `addBuildings()` does before it touches THREE. */
function seatedRows() {
  return placeBuildings(
    customs3d.buildings.map((building) => ({ ...building, poly: building.poly.map((point) => [...point]) })),
    groundYAt,
  );
}
function profileFactory() {
  const resolver = createFloorSurfaceResolver(customs3d.floorSurfaces, RELIEF);
  return (building) => resolver.buildingProfile(building, {
    fallbackBase: building.base,
    fallbackHeight: building.height,
  });
}

/** One routed + planned world, from the module under test (real or mutant). */
function planWith(mod) {
  return mod.planBuildingDetail(seatedRows(), { groundYAt, profileFor: profileFactory() });
}

/**
 * Is one building's skirt on screen, or is it facing the wrong way?
 *
 * A triangle COUNT cannot answer that — 30 of 67 skirts were back-face culled while every count in
 * this suite was green, which is exactly why the check is a raycast and not arithmetic. `Raycaster`
 * is three's own side-aware intersector: with a `FrontSide` material (which `materials.plinth` is,
 * three's default), a back face reports NO hit.
 *
 * Two things this probe has to get right, both learned by getting them wrong first:
 *
 *  - THE NEAREST HIT MUST BE THIS WALL. "Any hit at all" passes on a wrongly-wound skirt: the near
 *    wall's face is culled, the ray sails through the building and hits the FAR wall from its
 *    inside, which IS a front face. Measured: "any hit" reported 67/67 visible on the broken
 *    winding. Requiring the hit at the wall the ray was aimed at reports 37 visible / 30 invisible.
 *  - "OUTSIDE" IS A POINT-IN-POLYGON TEST, not a step away from the centroid. Eight Customs
 *    footprints are concave enough that the centroid ray leaves the building through the wrong wall.
 */
function skirtFacing(mod, rows) {
  const all = mod.plinthMeshData(rows);
  const byIndex = new Map(rows.map((row) => [row.index, row]));
  const ray = new THREE.Raycaster();
  const visible = [];
  const invisible = [];
  for (const index of all.drawn) {
    const one = mod.plinthMeshData(rows, new Set(all.drawn.filter((other) => other !== index)));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(one.positions, 3));
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.FrontSide }));
    mesh.updateMatrixWorld(true);
    const row = byIndex.get(index);
    // The ring in the plane the triangles live in: world x = -gameX, world y = -gameZ.
    const ring = row.building.poly.map(([x, z]) => [-x, -z]);
    const inside = (px, py) => {
      let odd = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) odd = !odd;
      }
      return odd;
    };
    const height = row.plinth.baseY + row.plinth.heightM * 0.5;
    let hitEdges = 0;
    for (let edge = 0; edge < ring.length; edge++) {
      const [x1, y1] = ring[edge];
      const [x2, y2] = ring[(edge + 1) % ring.length];
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const length = Math.hypot(dx, dy) || 1;
      let nx = dy / length;
      let ny = -dx / length;
      if (inside(mx + nx * 1.2, my + ny * 1.2)) { nx = -nx; ny = -ny; }
      ray.set(new THREE.Vector3(mx + nx * 3, my + ny * 3, height), new THREE.Vector3(-nx, -ny, 0));
      const hits = ray.intersectObject(mesh, false);
      // 3 m out, and the skirt is pushed PLINTH_EXPAND_M outward, so its wall is ~2.75 m away.
      if (hits.length > 0 && hits[0].distance < 3.5) hitEdges += 1;
    }
    geometry.dispose();
    (hitEdges === ring.length ? visible : invisible).push({ index, hitEdges, edges: ring.length });
  }
  return { skirt: all, visible, invisible };
}

/** The extrusion the renderer builds, expressed as the mass the assembler is handed. */
function massFor(building, heightM) {
  const shape = new THREE.Shape();
  building.poly.forEach(([x, z], index) => {
    if (index === 0) shape.moveTo(-x, -z); else shape.lineTo(-x, -z);
  });
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: heightM, bevelEnabled: true, bevelSegments: 1, bevelSize: 0.08, bevelThickness: 0.08, curveSegments: 2,
  });
  return {
    geometry,
    mass: {
      positions: geometry.attributes.position.array,
      normals: geometry.attributes.normal?.array ?? null,
      groups: geometry.groups.map((group) => ({
        start: group.start,
        count: group.count,
        materialSlot: group.materialIndex === 0 ? MATERIAL_SLOT_INDEX.roof : MATERIAL_SLOT_INDEX.wall,
      })),
    },
  };
}

const digestOf = (values) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < values.length; index++) {
    const text = `${Math.round(values[index] * 100000)},`;
    for (let position = 0; position < text.length; position++) {
      hash ^= text.charCodeAt(position);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return (hash >>> 0).toString(16);
};

// --------------------------------------------------------------------------------------------- //
// Part 1. The assertions. Each one is re-run against every mutant in Part 3.
// --------------------------------------------------------------------------------------------- //

const ASSERTIONS = [
  {
    id: 'B1-one-plan-per-building',
    doc: 'the partition is keyed on what a PLANNER stamped, so a mis-stamped plan cannot be counted',
    run: ({ mod }) => {
      const result = planWith(mod);
      assert.equal(result.count, BUILDING_COUNT, 'the assembler lost or invented a building');
      assert.equal(result.rows.length, BUILDING_COUNT);
      assert.equal(result.plans.length, BUILDING_COUNT);
      const sum = Object.values(result.byArchetype).reduce((total, value) => total + value, 0);
      assert.equal(sum, BUILDING_COUNT, `archetype counts sum to ${sum}, not ${BUILDING_COUNT}`);
      assert.equal(result.byArchetype.unstyled, 0, 'the loud unrouted bucket must be empty for Customs');
      // The census the assembler reports IS the router's, so the shipped-height classification and
      // the drawn-height planning cannot drift apart without this failing.
      for (const archetype of Object.keys(result.byArchetype)) {
        assert.equal(
          result.byArchetype[archetype],
          ROUTED.byArchetype[archetype].length,
          `archetype "${archetype}" disagrees with classifyAll`,
        );
      }
      /**
       * THE PART THAT WAS VACUOUS, AND HOW IT IS NOT ANY MORE.
       *
       * `count === 71`, `rows.length === 71`, `plans.length === 71` and the archetype sum were all
       * derived from the `forEach` index and were unreachable for every possible input: an agent
       * deleted the stamp guard and made small-box stamp `buildingIndex: 38` on all of its plans,
       * and every one of those numbers still read 71. The partition is only real if the DISTINCT
       * STAMPS the planners emitted are themselves a permutation of [0, 71) — so that is what is
       * asserted, from the plans rather than from the loop.
       */
      const stamps = result.plans.map((plan) => plan.buildingIndex);
      assert.equal(new Set(stamps).size, BUILDING_COUNT,
        `the 71 plans carry only ${new Set(stamps).size} distinct buildingIndex stamps`);
      assert.deepEqual([...stamps].sort((a, b) => a - b), [...Array(BUILDING_COUNT).keys()],
        'the planners\' own stamps are not a permutation of the building indices');
      // ...and the row a plan is filed under is the slot the PLAN named, not the slot the loop was on.
      for (const [slot, row] of result.rows.entries()) {
        assert.equal(row.index, slot, `row ${slot} is filed under index ${row.index}`);
        assert.equal(row.plan.buildingIndex, row.index, `row ${row.index} holds a plan stamped ${row.plan.buildingIndex}`);
        assert.equal(row.plan.archetype, row.classification.archetype);
        assert.equal(row.classification.archetype, ROUTED.assignments[row.index].archetype,
          `row ${row.index} was planned as a different archetype than the router assigned it`);
      }
    },
  },
  {
    id: 'B2-contract-satisfied',
    doc: 'every plan validates, groups are contiguous and cover every index, instances are owned',
    run: ({ mod }) => {
      const result = planWith(mod);
      for (const row of result.rows) {
        const mesh = row.plan.mesh;
        if (mesh) {
          let cursor = 0;
          for (const group of mesh.groups) {
            assert.equal(group.start, cursor, `building ${row.index}: non-contiguous material group`);
            assert.ok(group.count > 0 && group.count % 3 === 0);
            cursor += group.count;
          }
          assert.equal(cursor, mesh.indices.length, `building ${row.index}: groups do not cover the index buffer`);
          for (let index = 0; index < mesh.positions.length; index++) {
            assert.ok(Number.isFinite(mesh.positions[index]), `building ${row.index}: non-finite position`);
          }
        }
        for (const family of row.plan.instances) {
          for (let index = 0; index < family.count; index++) {
            assert.equal(family.ownerIndex[index], row.index, 'an instance escaped its owner');
          }
        }
      }
      // Something has to be there, or every check above is vacuous.
      const withMesh = result.rows.filter((row) => row.plan.mesh).length;
      assert.ok(withMesh >= 60, `only ${withMesh} of 71 buildings got any detail geometry at all`);
      assert.ok(result.stats.detailTriangles > 5000, `only ${result.stats.detailTriangles} detail triangles`);
    },
  },
  {
    id: 'B3-detail-rides-the-drawn-mass',
    doc: 'the roof plane a planner is given is the roof plane the renderer extrudes to',
    run: ({ mod }) => {
      const result = planWith(mod);
      let worst = 0;
      let measuredRows = 0;
      for (const row of result.rows) {
        const gap = Math.abs((row.seat.baseY + row.classification.heightM) - row.profile.roofY);
        worst = Math.max(worst, gap);
        // Rows whose MEASURED roof differs from the shipped height are the ones that can fail:
        // Warehouse 7, Warehouse 4 and Repair Shop are 1.06-1.98 m short of their data height.
        if (Math.abs(row.profile.height - (row.building.height ?? 0)) > 0.5) measuredRows += 1;
      }
      assert.ok(measuredRows >= 3, `only ${measuredRows} rows have a measured height that differs — the check is vacuous`);
      assert.ok(worst < 1e-6, `a roof is planned ${worst.toFixed(3)} m off the mass it sits on`);
      assert.equal(result.byArchetype.unstyled, 0);
    },
  },
  {
    id: 'B4-groups-are-one-per-slot',
    doc: 'a building costs one draw call per distinct material slot, never one per planner group',
    run: ({ mod }) => {
      const result = planWith(mod);
      let worstGroups = 0;
      let detailGroupsBefore = 0;
      for (const row of result.rows) {
        detailGroupsBefore += row.plan.mesh?.groups.length ?? 0;
        const { geometry, mass } = row.replacesMass
          ? { geometry: null, mass: null }
          : massFor(row.building, row.massHeightM);
        const built = mod.assembleBuildingGeometry({ mass, detail: row.plan.mesh, originZ: row.seat.baseY });
        geometry?.dispose();
        const slots = built.groups.map((group) => group.materialSlot);
        assert.deepEqual([...slots].sort((a, b) => a - b), slots, `building ${row.index}: groups are not slot-sorted`);
        assert.equal(new Set(slots).size, slots.length, `building ${row.index}: a slot got two groups — two draw calls`);
        let cursor = 0;
        for (const group of built.groups) {
          assert.equal(group.start, cursor, `building ${row.index}: assembled groups are not contiguous`);
          cursor += group.count;
        }
        assert.equal(cursor, built.vertices, `building ${row.index}: assembled groups leave vertices undrawn`);
        worstGroups = Math.max(worstGroups, built.groups.length);
      }
      assert.ok(detailGroupsBefore > 100, 'the planners emit too few groups for this check to mean anything');
      assert.ok(worstGroups <= 3, `a building was assembled with ${worstGroups} groups; the budget is wall + roof + one`);
      assert.ok(
        result.stats.worstExtraSlotsPerBuilding <= 1,
        `a building uses ${result.stats.worstExtraSlotsPerBuilding} slots beyond wall/roof`,
      );
    },
  },
  {
    id: 'B5-detail-lands-in-the-mesh-local-frame',
    doc: 'detail is translated by the mesh origin, so a roof is at its own height and not at twice it',
    run: ({ mod }) => {
      const result = planWith(mod);
      let checked = 0;
      for (const row of result.rows) {
        if (!row.plan.mesh) continue;
        const built = mod.assembleBuildingGeometry({ mass: null, detail: row.plan.mesh, originZ: row.seat.baseY });
        // Every planner works in ABSOLUTE displayed metres; the mesh is drawn at z = baseY. So the
        // local z of the highest detail vertex plus baseY must equal the absolute one.
        let localMax = -Infinity;
        for (let index = 2; index < built.positions.length; index += 3) localMax = Math.max(localMax, built.positions[index]);
        let absoluteMax = -Infinity;
        for (let index = 2; index < row.plan.mesh.positions.length; index += 3) {
          absoluteMax = Math.max(absoluteMax, row.plan.mesh.positions[index]);
        }
        assert.ok(
          Math.abs((localMax + row.seat.baseY) - absoluteMax) < 1e-3,
          `building ${row.index}: detail is ${(localMax + row.seat.baseY - absoluteMax).toFixed(2)} m out of frame`,
        );
        // And it must actually be off the ground, or the translation is trivially right.
        checked += Math.abs(row.seat.baseY) > 1 ? 1 : 0;
      }
      assert.ok(checked > 40, `only ${checked} buildings sit at a non-trivial base — the check is vacuous`);
    },
  },
  {
    id: 'B6-deterministic-and-look-blind',
    doc: 'two runs produce byte-identical geometry, and no planner is ever handed the look',
    run: ({ mod }) => {
      assert.ok(!PLANNER_CONTEXT_KEYS.includes('look'), 'the planner context must not carry the look');
      assert.ok(!/\blook\b/.test(ASSEMBLE_SOURCE.split('\n').filter((line) => !line.trim().startsWith('*')).join('\n')),
        'assemble.js reads the look somewhere outside a comment — geometry may not depend on it');
      const first = planWith(mod);
      const second = planWith(mod);
      const digest = (result) => result.rows.map((row) => (row.plan.mesh ? digestOf(row.plan.mesh.positions) : 'x')).join('|');
      assert.equal(digest(first), digest(second), 'the same data produced different geometry on a second run');
      const instances = (result) => result.families.map((family) => `${family.familyId}:${digestOf(family.offsets)}`).join('|');
      assert.equal(instances(first), instances(second), 'instance placement is not reproducible run to run');
    },
  },
  {
    id: 'B7-instanced-prototypes-are-not-silently-merged',
    doc: 'one InstancedMesh per (family, prototype) — merging on the family id alone loses shapes',
    run: ({ mod }) => {
      const result = planWith(mod);
      assert.ok(result.families.length > 0, 'no instanced families were merged at all');
      for (const family of result.families) {
        const digest = mod.prototypeDigest(family.prototype);
        assert.equal(digest, family.prototypeDigest, 'a merged family carries a prototype it was not keyed on');
        assert.ok(family.count > 0);
        assert.equal(family.offsets.length, family.count * 3);
        assert.equal(family.ownerIndex.length, family.count);
        assert.equal(family.levelAboveBaseM.length, family.count);
        for (let index = 0; index < family.count; index++) {
          const owner = family.ownerIndex[index];
          assert.ok(owner >= 0 && owner < BUILDING_COUNT, `family ${family.familyId}: ownerIndex ${owner} is not a building`);
          assert.ok(Number.isFinite(family.levelAboveBaseM[index]));
        }
      }
      // The measured finding this key exists for: three families ship more than one prototype, so
      // keying on the family id alone WOULD throw geometry away. If that ever stops being true the
      // extra key is free — but the assertion must not pass vacuously while it is true.
      const diverging = Object.entries(result.stats.prototypesPerFamily).filter(([, count]) => count > 1);
      assert.ok(
        diverging.length >= 3,
        `only ${diverging.length} families ship more than one prototype (${JSON.stringify(result.stats.prototypesPerFamily)})`,
      );
      assert.ok(
        result.families.length > result.stats.instancedFamilies,
        'the merge collapsed to one mesh per family id, discarding the divergent prototypes',
      );
    },
  },
  {
    id: 'B8-instances-follow-suppression-and-nothing-else',
    doc: 'an instance is a separate object: a retired owner takes its instances, and nothing else drops one',
    run: ({ mod }) => {
      const result = planWith(mod);
      const count = (options) => result.families.reduce(
        (sum, family) => sum + mod.visibleInstanceIndices(family, options).length,
        0,
      );
      // Instances stand ABOVE their owner's EAVE (a flue, a coping, a stack riding the ridge), and
      // those are exactly the ones the retired floor selector's level test could reach. Measured
      // against `massHeightM`, the plane the mass is extruded to; against `profile.height` this
      // would be vacuous, because the height fit put every instance UNDER the data height.
      const eaves = new Map(result.rows.map((row) => [row.index, row.massHeightM]));
      const above = result.families.reduce((sum, family) => sum + [...family.levelAboveBaseM]
        .filter((level, index) => level > eaves.get(family.ownerIndex[index]) + 0.4).length, 0);
      assert.ok(above > 40, `only ${above} instances stand above their eave — this check is vacuous`);
      const all = count();
      assert.equal(all, result.stats.instances, 'with nothing retired, every instance must draw');

      // The floor test is GONE, not merely unused. Hand the function the old selector options at
      // their most aggressive — an owner cut to zero out of a kilometre — and every instance must
      // still come back. Deleting the old floor cases and stopping there would have left a suite
      // that went green again the moment someone re-added the parameter.
      assert.equal(
        count({ visibleHeightFor: () => 0, fullHeightFor: () => 1e6, clearanceM: 0 }),
        all,
        'a height option still cuts instances — the floor test is back',
      );

      // Suppression: retire the owner of the busiest family and every one of its instances must go.
      const busiest = [...result.families].sort((a, b) => b.count - a.count)[0];
      const victim = busiest.ownerIndex[0];
      const kept = mod.visibleInstanceIndices(busiest, { suppressed: new Set([victim]) });
      assert.ok(kept.length < busiest.count, 'retiring an owner removed none of its instances');
      assert.ok(kept.every((index) => busiest.ownerIndex[index] !== victim), 'a retired owner kept instances');
    },
  },
  {
    id: 'B9-plinths-are-drawn',
    doc: 'the skirt src/buildings.js has computed since 2026-08-30, and that nothing drew, is geometry',
    run: ({ mod }) => {
      const result = planWith(mod);
      const skirt = mod.plinthMeshData(result.rows);
      assert.ok(skirt.buildings >= 60, `only ${skirt.buildings} of 71 buildings got a skirt`);
      assert.ok(skirt.triangles > 0, 'the skirt has no geometry');
      assert.equal(skirt.positions.length, skirt.triangles * 9);
      for (let index = 0; index < skirt.positions.length; index++) {
        assert.ok(Number.isFinite(skirt.positions[index]), 'a skirt vertex is not finite');
      }
      // A skirt must reach DOWN from the wall base, laps 0.12 m up behind it, and must never be
      // taller than the cap — that cap is what stops it becoming apparent storeys again.
      for (const row of result.rows) {
        if (row.suppressPlinth) continue;
        assert.ok(row.plinth.heightM > 0, `building ${row.index}: no skirt height`);
        assert.ok(
          row.plinth.baseY <= row.seat.baseY + 1e-9,
          `building ${row.index}: the skirt starts above the wall base`,
        );
        assert.ok(
          Math.abs((row.plinth.baseY + row.plinth.heightM) - (row.seat.baseY + 0.12)) < 1e-6
            || row.plinth.baseY + row.plinth.heightM >= row.seat.baseY,
          `building ${row.index}: the skirt top does not lap behind the wall base`,
        );
        assert.ok(
          row.plinth.heightM <= Math.max(1.5, row.classification.heightM * 0.6) + 0.13,
          `building ${row.index}: skirt ${row.plinth.heightM.toFixed(2)} m exceeds its cap`,
        );
      }
      // A lattice pylon stands on four footings; a near-black skirt around it would be wrong. So
      // would one under a replaced cooling tower: the skirt is built from the AUTHORED polygon, so
      // on rows 14 and 19 it would draw the rectangle's corners on the ground — up to 3.8 m of dark
      // quad sticking out past a round shell, which is the box, at ankle height. Those two found
      // their own foot instead, `footEmbedM` under the lowest ground beneath the shell.
      const suppressed = result.rows.filter((row) => row.suppressPlinth).map((row) => row.index);
      assert.deepEqual(
        suppressed,
        [...REPLACED_COOLING_TOWERS, ...ROUTED.byArchetype['lattice-tower']].sort((a, b) => a - b),
        'exactly the pylons and the replaced cooling towers opt out of the skirt',
      );
      const without = mod.plinthMeshData(result.rows, new Set([result.rows.find((row) => !row.suppressPlinth).index]));
      assert.equal(without.buildings, skirt.buildings - 1, 'excluding a building did not remove its skirt');
    },
  },
  {
    id: 'B10-draw-call-budget',
    doc: 'the whole lane costs a stated, bounded number of extra draw calls',
    run: ({ mod }) => {
      const result = planWith(mod);
      const stats = result.stats;
      assert.equal(stats.buildings, BUILDING_COUNT);
      // Before: two material groups + one outline per building, and one group with no outline for
      // the single row that took the `place === 'skeleton'` open-frame literal.
      assert.equal(stats.before, 70 * 3 + 1, `the pre-lane baseline is ${stats.before}, not 211`);
      assert.ok(stats.after > stats.before, 'the lane claims to cost nothing at all');
      assert.ok(
        stats.delta <= 73,
        `+${stats.delta} draw calls exceeds the 5% of a 1,461-call frame this lane is allowed`,
      );
      assert.ok(stats.instancedMeshes <= 16, `${stats.instancedMeshes} instanced meshes is past the budget`);
      assert.ok(stats.outlines <= BUILDING_COUNT, 'more outlines than buildings — an outline per part');
    },
  },
  {
    id: 'B11-outline-is-shell-only',
    doc: 'EdgesGeometry over the shell, never over the merged geometry — the measured hatching trap',
    run: ({ mod }) => {
      const result = planWith(mod);
      let shellTotal = 0;
      let fullTotal = 0;
      let worstRatio = 0;
      let worstShell = 0;
      let outlined = 0;
      for (const row of result.rows) {
        if (row.replacesMass) continue;
        const { geometry, mass } = massFor(row.building, row.massHeightM);
        const shellEdges = new THREE.EdgesGeometry(geometry, 28);
        const shell = shellEdges.attributes.position.count / 2;
        const assembled = mod.assembleBuildingGeometry({ mass, detail: row.plan.mesh, originZ: row.seat.baseY });
        /**
         * THE MASS IS IN THE BUFFER, EXACTLY ONCE — as an identity, not as a margin.
         *
         * The assembler concatenates the mass's own vertices with three per detail triangle and
         * emits nothing else, so this equality is exact and every one of its terms is measured
         * outside the module: `mass.positions` comes from three's `ExtrudeGeometry` here in the
         * test, and `plan.mesh.indices` from the planner.
         *
         * It replaces a 1.4% margin. The `shell-swallowed-into-the-detail` mutation used to be
         * caught only by `fullTotal > shellTotal * 2` — 4,381 merged segments against a 4,320
         * threshold — and two buildings leaving this loop (rows 14 and 19 now draw their own mass)
         * was enough to tip it back over and let a dropped shell through unnoticed. An assertion
         * that survives on 61 segments is an assertion about the census, not about the defect.
         */
        assert.equal(
          assembled.vertices,
          (mass.positions.length / 3) + row.plan.mesh.indices.length,
          `building ${row.index}: the assembled buffer is not the mass plus the detail — the shell was dropped or doubled`,
        );
        const merged = new THREE.BufferGeometry();
        merged.setAttribute('position', new THREE.BufferAttribute(assembled.positions, 3));
        const mergedEdges = new THREE.EdgesGeometry(merged, 28);
        const full = mergedEdges.attributes.position.count / 2;
        geometry.dispose(); shellEdges.dispose(); merged.dispose(); mergedEdges.dispose();
        shellTotal += shell;
        fullTotal += full;
        worstShell = Math.max(worstShell, shell);
        worstRatio = Math.max(worstRatio, full / Math.max(1, shell));
        outlined += 1;
      }
      // Exactly one outline per building that still has a shell to outline. `replacesMass` rows get
      // none, which is what the pre-lane renderer already did for its one open frame.
      assert.equal(outlined, result.stats.outlines, 'the outline count disagrees with the reported one');
      assert.equal(outlined, BUILDING_COUNT - result.stats.replacedMasses);
      // The trap, MEASURED rather than asserted from theory: running the outline over the merged
      // geometry instead of the shell adds 3,336 segments across the map (2,216 -> 5,552) and up to
      // 6.9x on one building — line work at the ridge and rib scale, which at the default view
      // where one pixel is one metre is hatching.
      assert.ok(
        fullTotal > shellTotal * 2,
        `the outline trap is not reproducible (${shellTotal} shell vs ${fullTotal} merged segments)`,
      );
      assert.ok(worstRatio > 4, `the worst building only multiplies its outline by ${worstRatio.toFixed(1)}x`);
      assert.ok(worstShell < 200, `a shell outline is already ${worstShell} segments before any detail`);
    },
  },
  {
    id: 'B12-open-masses-are-replaced',
    doc: 'canopies, frames, pylons and the two rectangular cooling towers draw no extruded block, keyed on the router and not a place name',
    run: ({ mod }) => {
      const result = planWith(mod);
      const replaced = result.rows.filter((row) => row.replacesMass).map((row) => row.index).sort((a, b) => a - b);
      const expected = [
        ...ROUTED.byArchetype['open-structure'],
        ...ROUTED.byArchetype['lattice-tower'],
        ...REPLACED_COOLING_TOWERS,
      ].sort((a, b) => a - b);
      assert.deepEqual(replaced, expected, 'exactly the open structures, the pylons and the two rectangular cooling towers replace their mass');
      assert.equal(replaced.length, 12);
      // ...and it is keyed on the FOOTPRINT, not on `kind`: all three of Customs' cooling towers
      // are `kind: "cooling_tower"` at `height: 30`, and the one whose poly is a real 16-gon keeps
      // its extrusion. A rule that read `kind` would have replaced that one too.
      for (const index of REPLACED_COOLING_TOWERS) {
        assert.equal(customs3d.buildings[index].poly.length, 4, `row ${index} is no longer the rectangle this rule is about`);
      }
      assert.equal(result.rows[13].replacesMass, false,
        'row 13 is a 16-gon cooling tower and must keep the mass the renderer already draws correctly');
      // Two planners spell the flag differently and the wiring must honour BOTH; a wiring that read
      // only one would leave six fuel canopies and unfinished frames as solid blocks.
      const spellings = new Set(result.rows.filter((row) => row.replacesMass)
        .map((row) => (row.plan.replacesMass === true ? 'replacesMass' : 'massDisposition')));
      assert.deepEqual([...spellings].sort(), ['massDisposition', 'replacesMass']);
      for (const row of result.rows.filter((candidate) => candidate.replacesMass)) {
        assert.ok(row.plan.mesh, `building ${row.index} replaces its mass but planned no geometry to put there`);
      }
    },
  },
  {
    id: 'B13-heights-are-never-changed',
    doc: 'standing decision 4: nothing in this lane writes a building height',
    run: ({ mod }) => {
      const rows = seatedRows();
      const before = rows.map((building) => building.height);
      const result = mod.planBuildingDetail(rows, { groundYAt, profileFor: profileFactory() });
      assert.deepEqual(rows.map((building) => building.height), before, 'the assembler mutated a building height');
      for (const [index, row] of result.rows.entries()) {
        assert.equal(row.building.height, customs3d.buildings[index].height, 'a shipped height changed');
        // The DRAWN height is the profile's, and it is the only one the planner may scale to.
        assert.equal(row.drawnBuilding.height, row.profile.height);
        assert.equal(row.classification.heightM, row.profile.height);
      }
    },
  },
  {
    id: 'B14-nothing-draws-above-its-data-height',
    doc: 'standing decision 4: the highest thing a building draws lands ON its height, never above it',
    run: ({ mod }) => {
      const result = planWith(mod);
      const tolerance = mod.DRAWN_HEIGHT_TOLERANCE_M;
      assert.ok(tolerance > 0 && tolerance <= 1e-3, `the stated tolerance is ${tolerance} m, which is not float noise`);

      /**
       * Measured INDEPENDENTLY of the fit — from the plan's own buffers, the instance matrices the
       * renderer will compose, and the extrusion depth the renderer will use — so that reading
       * `row.drawnTopAboveBaseM` back is never what makes this pass.
       */
      const worst = [];
      for (const row of result.rows) {
        let top = row.replacesMass ? -Infinity : row.seat.baseY + row.massHeightM;
        if (row.plan.mesh) {
          for (let index = 2; index < row.plan.mesh.positions.length; index += 3) {
            top = Math.max(top, row.plan.mesh.positions[index]);
          }
        }
        for (const family of row.plan.instances) {
          let prototypeTop = -Infinity;
          for (let index = 2; index < family.prototype.positions.length; index += 3) {
            prototypeTop = Math.max(prototypeTop, family.prototype.positions[index]);
          }
          for (let index = 0; index < family.count; index++) {
            top = Math.max(top, family.offsets[index * 3 + 2] + prototypeTop * family.scales[index * 3 + 2]);
          }
        }
        worst.push({ index: row.index, over: top - (row.seat.baseY + row.profile.height) });
      }
      worst.sort((a, b) => b.over - a.over);
      assert.equal(worst.length, BUILDING_COUNT, 'the check did not see all 71 rows');
      assert.ok(
        worst[0].over <= tolerance,
        `building ${worst[0].index} draws ${worst[0].over.toFixed(2)} m above its data height `
        + `(${worst.filter((row) => row.over > tolerance).length} of ${BUILDING_COUNT} do)`,
      );
      // ...and the whole thing is not passing because nothing is built up there. 61 of the 71 rows
      // overshot before the fit; every one of them must still be REACHING its height, not squatting
      // under it, or "fit to height" would be satisfied by deleting every roof.
      const reaching = worst.filter((row) => row.over > -0.05).length;
      assert.ok(reaching >= 55, `only ${reaching} of ${BUILDING_COUNT} buildings reach their own height`);
      assert.ok(result.stats.heightFits >= 55, `only ${result.stats.heightFits} rows needed the fit — measured 65`);
      assert.ok(result.stats.worstFitScaleZ < 0.7, `the worst fit only scales by ${result.stats.worstFitScaleZ}`);
      // The mass follows the fit, or the eave and the roof it carries come apart.
      for (const row of result.rows) {
        assert.ok(row.fitScaleZ > 0 && row.fitScaleZ <= 1, `building ${row.index}: fit scale ${row.fitScaleZ}`);
        assert.ok(
          Math.abs(row.massHeightM - row.profile.height * row.fitScaleZ) < 1e-9,
          `building ${row.index}: the extruded mass does not follow the fit`,
        );
        assert.ok(row.massHeightM <= row.profile.height + tolerance, `building ${row.index}: the mass alone is too tall`);
      }
    },
  },
  {
    id: 'B15-every-skirt-faces-outward',
    doc: 'the skirt is FRONT-face visible from outside — the 30 back-face-culled skirts, by raycast',
    run: ({ mod }) => {
      const result = planWith(mod);
      const { skirt, visible, invisible } = skirtFacing(mod, result.rows);
      assert.equal(
        invisible.length,
        0,
        `${invisible.length} of ${skirt.buildings} skirts are back-face culled: `
        + invisible.map((row) => `${row.index} (${row.hitEdges}/${row.edges} walls)`).join(', '),
      );
      assert.equal(visible.length, skirt.buildings, 'the probe did not see every drawn skirt');
      // Non-vacuity: the probe must be looking at real skirts on both windings of footprint, or a
      // map that happened to be all-CCW would make this green while the bug was still in the code.
      assert.ok(skirt.buildings >= 60, `only ${skirt.buildings} skirts were built at all`);
      assert.ok(
        skirt.reversedRings >= 25,
        `only ${skirt.reversedRings} footprints wind clockwise — measured 30 of 67, and if that is `
        + 'ever 0 this assertion can no longer tell a winding fix from no fix at all',
      );
      assert.ok(
        skirt.reversedRings < skirt.buildings,
        'every ring needed reversing, which means the sign test itself is inverted',
      );
      // ...and the fix must be the winding, NOT `side: DoubleSide` smuggled into the material.
      assert.doesNotMatch(RENDERER_SOURCE, /plinth: new THREE\.MeshBasicMaterial\(\{[^}]*side:/,
        'the plinth material declares a side — the skirt must be fixed by its winding, not by drawing both faces');
    },
  },
  {
    id: 'B16-render-stats-are-derived-at-read-time',
    doc: 'the reported skirt count tracks a suppression instead of freezing at the mount value',
    run: ({ mod }) => {
      const result = planWith(mod);
      const base = { ...result.stats, groups: 180, outlinesBuilt: 61, massTriangles: 40000, detailTriangles: result.stats.detailTriangles };

      const full = mod.plinthMeshData(result.rows);
      // Retire one building the way an authored GLB does. Fortress is the real case: its skirt is
      // 8 triangles and it is the building the shipped Customs manifest actually replaces.
      const victim = result.rows.find((row) => /fortress/i.test(String(row.building.place ?? ''))) ?? result.rows.find((row) => !row.suppressPlinth);
      const cut = mod.plinthMeshData(result.rows, new Set([victim.index]));
      assert.equal(cut.buildings, full.buildings - 1, 'excluding a building did not remove its skirt');

      const before = mod.buildingRenderStatsNow(base, { plinths: full, instancedMeshes: 11, instancesDrawn: 195, skirtDrawCalls: 1 });
      const after = mod.buildingRenderStatsNow(base, { plinths: cut, instancedMeshes: 11, instancesDrawn: 187, skirtDrawCalls: 1 });
      assert.equal(before.plinths.buildings, full.buildings);
      assert.equal(before.triangles.plinth, full.triangles);
      assert.equal(
        after.plinths.buildings,
        full.buildings - 1,
        `the derived stats still report ${after.plinths.buildings} skirts after one was suppressed`,
      );
      assert.equal(after.triangles.plinth, cut.triangles, 'the reported skirt triangles did not follow the suppression');
      assert.ok(after.triangles.total < before.triangles.total, 'the triangle total ignored the suppressed skirt');
      assert.equal(after.instancesDrawn, 187, 'the instance count is not read from the live meshes');
      // The whole skirt going away must cost the frame its draw call, too.
      const gone = mod.buildingRenderStatsNow(base, { plinths: { buildings: 0, triangles: 0 }, instancedMeshes: 11, instancesDrawn: 0, skirtDrawCalls: 0 });
      assert.equal(gone.drawCalls.after, before.drawCalls.after - 1, 'losing the skirt mesh did not lose its draw call');
      assert.equal(gone.drawCalls.delta, gone.drawCalls.after - base.before);
      // A derivation that ignores what it is handed is the defect wearing a different hat.
      assert.notDeepEqual(before.plinths, after.plinths, 'the derivation does not read its live argument at all');
    },
  },
];

const RENDERER_ASSERTIONS = [
  {
    id: 'R1-renderer-routes-through-the-assembler',
    doc: 'addBuildings plans through the one router and merges the result into the building mesh',
    run: ({ renderer }) => {
      assert.match(renderer, /buildingDetail = planBuildingDetail\(seatedBuildings, \{/);
      assert.match(renderer, /const assembled = assembleBuildingGeometry\(\{ mass, detail: plan\.mesh, originZ: profile\.baseY \}\);/);
      assert.match(renderer, /for \(const group of assembled\.groups\) geometry\.addGroup\(group\.start, group\.count, group\.materialSlot\);/);
      assert.match(renderer, /new THREE\.Mesh\(geometry, buildingSlotMaterials\(building\)\)/);
    },
  },
  {
    id: 'R2-renderer-keeps-what-already-worked',
    doc: 'building userData, full-height walls, the hover label and the floor slabs all survive',
    run: ({ renderer }) => {
      assert.match(renderer, /kind: 'building', label: mesh\.name, stableId,/);
      assert.match(renderer, /mesh\.position\.z = profile\.baseY;/);
      // The floor selector's `mesh.scale.z = Math.max(0.04, shown / height)` used to live here.
      // At "ALL" — the only state the founder ever reviewed — `shown === profile.height === height`,
      // so it evaluated to exactly 1 on all 71 Customs buildings (measured). It went out on
      // 2026-09-02 with the rest of the selector, and NOTHING may scale a building mesh again: a
      // surviving `scale.z` would be a silent height lie against the seating contract in
      // src/buildings.js, which is the whole point of that module.
      assert.doesNotMatch(renderer, /mesh\.scale\.z/, 'a building mesh must never be scaled again');
      assert.doesNotMatch(renderer, /visibleBuildingHeight/, 'the selector wall height must stay gone');
      assert.match(renderer, /kind: 'floor-surface', label: slab\.name, floorIndex: row2\.floorIndex,/);
      assert.match(renderer, /surfaceProfile: profile,/);
    },
  },
  {
    id: 'R3-renderer-outlines-the-shell-not-the-detail',
    doc: 'EdgesGeometry runs on the extrusion, before the detail is merged, once per building',
    run: ({ renderer }) => {
      assert.match(renderer, /outline = new THREE\.LineSegments\(new THREE\.EdgesGeometry\(extrusion, 28\), materials\.outline\);/);
      assert.doesNotMatch(renderer, /EdgesGeometry\(geometry, 28\), materials\.outline\);\n\s*outline\.renderOrder/);
      assert.doesNotMatch(renderer, /outlineFor\(mesh, materials\.outline\);\n\s*\}\n\s*mesh\.name/);
      assert.match(renderer, /if \(outline\) mesh\.add\(outline\);/);
    },
  },
  {
    id: 'R4-renderer-wires-the-plinths',
    doc: 'the skirt is built, unlit, near-black, and rebuilt when the authored ledger changes',
    run: ({ renderer }) => {
      assert.match(renderer, /plinthMesh = new THREE\.Mesh\(geometry, materials\.plinth\);/);
      assert.match(renderer, /plinth: new THREE\.MeshBasicMaterial\(\{ color: rgb\(plinthColor\('realistic'\)\) \}\)/);
      assert.match(renderer, /plinthMeshData\(buildingDetail\?\.rows \?\? \[\], suppressedBuildingIndices\(\)\)/);
      assert.match(renderer, /rebuildPlinths\(\);/);
      assert.match(renderer, /plinthMesh\.castShadow = false;/);
    },
  },
  {
    id: 'R5-renderer-refreshes-instances-on-suppression',
    doc: 'instances do not ride the owner mesh visible flag, so suppression is re-applied to them',
    run: ({ renderer }) => {
      assert.match(renderer, /refreshDetailInstances\(\);\n\s*syncPlinthSuppression\(\);/);
      assert.match(renderer, /const visible = visibleInstanceIndices\(entry\.family, \{ suppressed \}\);/);
      assert.match(renderer, /entry\.mesh\.count = visible\.length;/);
      assert.match(renderer, /entry\.mesh\.instanceMatrix\.needsUpdate = true;/);
      assert.match(renderer, /if \(entry\.kind !== 'building'\) continue;/, 'only a retired BUILDING may retire its instances');
    },
  },
  {
    id: 'R6-the-place-name-open-frame-literal-is-gone',
    doc: 'Skeleton is open because the ROUTER says so, not because of a string compare',
    run: ({ renderer }) => {
      assert.doesNotMatch(renderer, /safeText\(building\.place\)\.toLowerCase\(\) === 'skeleton'/);
      assert.doesNotMatch(renderer, /buildOpenFrameBuildingAsset/);
      assert.match(renderer, /if \(!row\.replacesMass\) \{/);
    },
  },
  {
    id: 'R7-the-authored-roof-colour-is-read',
    doc: '18 rows carry an authored `roof` colour that this renderer used to throw away',
    run: ({ renderer }) => {
      assert.match(renderer, /const authoredRoof = roof && Array\.isArray\(building\.roof\) \? building\.roof : null;/);
      assert.match(renderer, /const base = authoredRoof \?\? building\.color \?\?/);
      assert.match(renderer, /if \(roof && !authoredRoof\) color\.multiplyScalar/);
      // and the material key must separate two rows that share a place but not a roof colour
      assert.match(renderer, /\$\{authoredRoof \? authoredRoof\.join\(','\) : ''\}/);
    },
  },
  {
    id: 'R8-renderer-derives-the-cost-at-read-time',
    doc: 'renderStats reads the LIVE skirt and instance counts; a snapshot froze 67/756 forever',
    run: ({ renderer }) => {
      // Both readers — `renderStats()` and `diagnostics()` — must call the derivation, not read a
      // stored object. A snapshot in either one is the defect.
      const derived = renderer.match(/buildings: buildingStatsNow\(\),/g) ?? [];
      assert.equal(derived.length, 2, `${derived.length} of the 2 stat readers derive the buildings at read time`);
      assert.doesNotMatch(renderer, /buildings: buildingRenderStats\b/,
        'a stat reader hands out the stored mount-time snapshot');
      assert.match(renderer, /function buildingStatsNow\(\) \{\n\s*return buildingRenderStatsNow\(buildingRenderStats, \{/);
      // ...and it must be reading the mutable variables, not the values they held at mount.
      assert.match(renderer, /plinths: plinthRenderStats,/);
      assert.match(renderer, /instancedMeshes: detailInstanceMeshes\.length,/);
      assert.match(renderer, /instancesDrawn: detailInstanceMeshes\.reduce\(\(sum, entry\) => sum \+ entry\.mesh\.count, 0\),/);
      assert.match(renderer, /skirtDrawCalls: plinthMesh \? 1 : 0,/);
      // The mount-time object may hold ONLY what cannot change afterwards.
      const mount = renderer.match(/buildingRenderStats = \{[\s\S]*?\n {4}\};/);
      assert.ok(mount, 'the build-time stats object is gone');
      assert.doesNotMatch(mount[0], /plinths:|drawCalls:|triangles:/,
        'the mount-time snapshot captured a number that changes after the mount');
    },
  },
  {
    id: 'R9-the-mass-is-extruded-to-the-fitted-height',
    doc: 'standing decision 4: the extrusion depth is the fitted eave, and the data height is untouched',
    run: ({ renderer }) => {
      assert.match(renderer, /depth: row\.massHeightM,/,
        'the extrusion is not built to the height the assembler fitted the plan into');
      assert.doesNotMatch(renderer, /\n\s*depth: height,/,
        'the extrusion still runs to the full data height, which puts every ridge back above it');
      // The data height itself must survive untouched — it is what the hover label and standing
      // decision 4 both read.
      assert.match(renderer, /realHeight: height,/);
      assert.match(renderer, /const height = profile\.height;/);
    },
  },
];

// --------------------------------------------------------------------------------------------- //
// Part 2. Run them, and report the numbers a reader needs.
// --------------------------------------------------------------------------------------------- //

for (const assertion of ASSERTIONS) {
  test(`[${assertion.id}] ${assertion.doc}`, () => assertion.run({ mod: assembleModule }));
}
for (const assertion of RENDERER_ASSERTIONS) {
  test(`[${assertion.id}] ${assertion.doc}`, () => assertion.run({ renderer: RENDERER_SOURCE }));
}

test('the shipped cost, printed', () => {
  const result = planWith(assembleModule);
  const skirt = assembleModule.plinthMeshData(result.rows);
  const lines = [
    `buildings ${result.count}  ${JSON.stringify(result.byArchetype)}`,
    `roof forms ${JSON.stringify(result.roofCensus)}  programs ${JSON.stringify(result.programCensus)}`,
    `detail triangles ${result.stats.detailTriangles}  instanced ${result.stats.instanceTriangles} `
      + `(${result.stats.instances} instances in ${result.stats.instancedMeshes} meshes)  skirt ${skirt.triangles}`,
    `draw calls  before ${result.stats.before}  after ${result.stats.after}  `
      + `delta +${result.stats.delta} (${(result.stats.delta / 1461 * 100).toFixed(2)}% of a 1461-call frame)`,
    `slots used ${JSON.stringify(result.stats.slotUse)}  worst extra per building ${result.stats.worstExtraSlotsPerBuilding}`,
    `prototypes per family ${JSON.stringify(result.stats.prototypesPerFamily)}`,
    `height fit  ${result.stats.heightFits}/${result.count} rows scaled  worst k ${result.stats.worstFitScaleZ.toFixed(3)}  `
      + `worst overshoot ${result.stats.worstOvershootM.toExponential(2)} m (tolerance ${assembleModule.DRAWN_HEIGHT_TOLERANCE_M} m)`,
    `skirt  ${skirt.buildings} buildings, ${skirt.reversedRings} clockwise footprints rewound to face outward`,
  ];
  console.log(lines.join('\n'));
  assert.ok(result.stats.delta > 0);
});

// --------------------------------------------------------------------------------------------- //
// Part 3. The mutation harness. An assertion nobody has proved can fail is not an assertion.
// --------------------------------------------------------------------------------------------- //

const scratch = await mkdtemp(join(tmpdir(), 'tz-assemble-'));
test.after(() => rm(scratch, { recursive: true, force: true }));

/** Rewrite the module's relative imports so a copy in /tmp resolves the same graph. */
function portable(source) {
  return source.replace(/from '(\.\.?\/[^']+)'/g, (whole, specifier) => `from '${new URL(specifier, ASSEMBLE_URL).href}'`);
}

async function loadMutant(id, find, replace) {
  assert.ok(
    ASSEMBLE_SOURCE.includes(find),
    `MUTATION HARNESS ROTTED: "${id}" searches for a string that is no longer in assemble.js — ${JSON.stringify(find.slice(0, 90))}`,
  );
  const mutated = ASSEMBLE_SOURCE.replace(find, replace);
  assert.notEqual(mutated, ASSEMBLE_SOURCE, `mutation "${id}" changed nothing`);
  const file = join(scratch, `assemble-${id}.mjs`);
  await writeFile(file, portable(mutated), 'utf8');
  return await import(pathToFileURL(file).href);
}

function caughtBy(mod) {
  return ASSERTIONS.filter((assertion) => {
    try {
      assertion.run({ mod });
      return false;
    } catch {
      return true;
    }
  }).map((assertion) => assertion.id);
}

function caughtByRenderer(renderer) {
  return RENDERER_ASSERTIONS.filter((assertion) => {
    try {
      assertion.run({ renderer });
      return false;
    } catch {
      return true;
    }
  }).map((assertion) => assertion.id);
}

const MUTATIONS = [
  {
    id: 'a-building-nobody-plans', expect: 'B1-one-plan-per-building',
    doc: 'let a routed building through without a plan — the silently undressed box this lane exists to kill',
    find: '    planned[stamped] = plan;\n',
    replace: '    planned[stamped] = plan;\n    if (index === 3) return;\n',
  },
  {
    id: 'a-planner-stamps-the-wrong-building', expect: 'B1-one-plan-per-building',
    doc: 'THE PROVEN-VACUOUS ONE: drop the stamp guard and have small-box stamp buildingIndex 38 on '
      + 'every plan. Before the repair all four count guards still read 71 and the suite stayed green.',
    find: '    if (plan.buildingIndex !== index) {\n'
      + '      fail(`building ${index} got a plan stamped buildingIndex ${plan.buildingIndex}`);\n'
      + '    }',
    replace: "    if (classification.archetype === 'small-box') plan.buildingIndex = 38;",
  },
  {
    id: 'groups-short-of-the-buffer', expect: 'B2-contract-satisfied',
    doc: 'stop validating plans, so a planner may leave indices outside every material group',
    find: '    validateDetailPlan(plan, { buildingCount: rows.length, archetype: classification.archetype });',
    replace: '    if (plan.mesh) plan.mesh.groups = plan.mesh.groups.map((g, i) => (i === 0 ? { ...g, count: Math.max(3, g.count - 3) } : g));',
  },
  {
    id: 'roof-planned-on-the-data-height', expect: 'B3-detail-rides-the-drawn-mass',
    doc: 'scale the detail to the shipped height instead of the drawn one: three roofs float 1.06-1.98 m up',
    find: '    const drawnHeightM = num(profile.height, num(building?.height));',
    replace: '    const drawnHeightM = num(building?.height, num(profile.height));',
  },
  {
    id: 'groups-in-planner-order', expect: 'B4-groups-are-one-per-slot',
    doc: 'emit the detail groups as the planner ordered them: one draw call per group, not per slot',
    find: '  for (const [slot, bucket] of bySlot.entries()) {\n    const vertices = bucket.positions.length / 3;\n    if (!vertices) continue;',
    replace: '  for (const [slot, bucket] of [...bySlot.entries()].flatMap((entry) => [entry, [entry[0], { positions: [], normals: [] }]])) {\n    const vertices = bucket.positions.length / 3;\n    if (!vertices) { if (slot === MATERIAL_SLOT_INDEX.wall) groups.push({ start: cursor, count: 0, materialSlot: slot }); continue; }',
  },
  {
    id: 'detail-not-brought-into-frame', expect: 'B5-detail-lands-in-the-mesh-local-frame',
    doc: 'forget the mesh origin: every roof is drawn at base + base + height, high in the sky',
    find: '        detail.positions[corner * 3 + 2] - originZ,',
    replace: '        detail.positions[corner * 3 + 2],',
  },
  {
    id: 'variation-from-a-clock', expect: 'B6-deterministic-and-look-blind',
    doc: 'jitter the seat by the wall clock — the renderer stops being reproducible run to run',
    find: '  const baseY = num(profile?.baseY, num(seat?.base));',
    replace: '  const baseY = num(profile?.baseY, num(seat?.base)) + (Date.now() % 7) * 1e-4;',
  },
  {
    id: 'one-mesh-per-family-id', expect: 'B7-instanced-prototypes-are-not-silently-merged',
    doc: 'key the merge on the family id alone: five of eleven prototypes are silently discarded',
    find: '      const key = `${family.familyId}#${digest}`;',
    replace: '      const key = `${family.familyId}`;',
  },
  {
    id: 'the-floor-level-test-comes-back', expect: 'B8-instances-follow-suppression-and-nothing-else',
    doc: 'restore the retired floor selector\'s level cut: instances start vanishing by height again',
    find: 'export function visibleInstanceIndices(family, { suppressed = new Set() } = {}) {',
    replace: 'export function visibleInstanceIndices(family, { suppressed = new Set(), visibleHeightFor = null, clearanceM = 0.4 } = {}) {\n  if (typeof visibleHeightFor === \'function\') {\n    const out = [];\n    for (let i = 0; i < family.count; i++) {\n      if (suppressed.has(family.ownerIndex[i])) continue;\n      if (!(family.levelAboveBaseM[i] <= visibleHeightFor(family.ownerIndex[i]) + clearanceM)) continue;\n      out.push(i);\n    }\n    return out;\n  }',
  },
  {
    id: 'suppression-stops-working', expect: 'B8-instances-follow-suppression-and-nothing-else',
    doc: 'ignore the retired-owner set: roof plant hovers over the Fortress GLB forever',
    find: '    if (suppressed.has(family.ownerIndex[index])) continue;',
    replace: '    void suppressed;',
  },
  {
    id: 'no-skirt-at-all', expect: 'B9-plinths-are-drawn',
    doc: 'the pre-lane state: plinthBase/plinthHeight are computed and nothing draws them',
    find: '    if (!(heightM > 0.02)) continue;',
    replace: '      if (heightM >= 0) continue;',
  },
  {
    id: 'cost-understated', expect: 'B10-draw-call-budget',
    doc: 'bill the lane against a pre-lane baseline it never had, hiding what it really costs',
    find: '    before += legacyOpenFrame ? LEGACY_OPEN_FRAME_DRAW_CALLS : 3;',
    replace: '    before += legacyOpenFrame ? LEGACY_OPEN_FRAME_DRAW_CALLS : 30;',
  },
  {
    id: 'shell-swallowed-into-the-detail', expect: 'B11-outline-is-shell-only',
    doc: 'drop the mass from the assembled buffer: the outline would then have only detail to run over',
    find: '  if (mass) {\n    const groups = mass.groups?.length',
    replace: '  if (false && mass) {\n    const groups = mass.groups?.length',
  },
  {
    id: 'the-block-stays-under-the-canopy', expect: 'B12-open-masses-are-replaced',
    doc: 'read only one of the two spellings: six canopies and frames keep their solid extruded block',
    find: "    const replacesMass = plan.replacesMass === true || plan.massDisposition === 'replace';",
    replace: '    const replacesMass = plan.replacesMass === true;',
  },
  {
    id: 'a-height-is-rewritten', expect: 'B13-heights-are-never-changed',
    doc: 'write the drawn height back onto the shipped row — standing decision 4, violated silently',
    find: '    const drawnBuilding = { ...building, height: drawnHeightM };',
    replace: '    building.height = drawnHeightM;\n    const drawnBuilding = { ...building, height: drawnHeightM };',
  },
  {
    id: 'no-height-fit', expect: 'B14-nothing-draws-above-its-data-height',
    doc: 'the state this lane shipped in: ridges, monitors and stacks stacked ON TOP of a full-height '
      + 'box, and 61 of 71 buildings drew above the height the founder signed off',
    find: '    const fitScaleZ = heightFitScale(plan, seatView.baseY, drawnHeightM, { replacesMass });',
    replace: '    const fitScaleZ = 1;',
  },
  {
    id: 'fit-forgets-the-instances', expect: 'B14-nothing-draws-above-its-data-height',
    doc: 'fit the mesh only: Warehouse 17\'s flue still rides 1.70 m above the ridge it was fitted to',
    find: '  for (const family of plan?.instances ?? []) {',
    replace: '  for (const family of []) {',
  },
  {
    id: 'skirt-winding-ignored', expect: 'B15-every-skirt-faces-outward',
    doc: 'emit every skirt quad with one winding: the 34 clockwise footprints face inward and vanish',
    find: '      if (ccw) positions.push(...a0, ...b0, ...b1, ...a0, ...b1, ...a1);\n'
      + '      else positions.push(...a0, ...b1, ...b0, ...a0, ...a1, ...b1);',
    replace: '      positions.push(...a0, ...b0, ...b1, ...a0, ...b1, ...a1);',
  },
  {
    id: 'stats-ignore-what-they-are-handed', expect: 'B16-render-stats-are-derived-at-read-time',
    doc: 'derive the stats from the build-time object and drop the live reading — the frozen 67/756',
    find: '  const plinths = live.plinths ?? { buildings: 0, triangles: 0 };',
    replace: '  const plinths = base.plinths ?? { buildings: 67, triangles: 756 };',
  },
];

const RENDERER_MUTATIONS = [
  {
    id: 'renderer-skips-the-assembler', expect: 'R1-renderer-routes-through-the-assembler',
    doc: 'go back to extruding a bare box and never merging the plan',
    find: '      const assembled = assembleBuildingGeometry({ mass, detail: plan.mesh, originZ: profile.baseY });',
    replace: '      const assembled = assembleBuildingGeometry({ mass, detail: null, originZ: profile.baseY });',
  },
  {
    id: 'floor-squash-returns', expect: 'R2-renderer-keeps-what-already-worked',
    doc: 'put the retired floor squash back: a building silently stops standing its measured height',
    find: '      mesh.castShadow = mesh.receiveShadow = true;\n      if (outline) mesh.add(outline);',
    replace: '      mesh.castShadow = mesh.receiveShadow = true;\n      mesh.scale.z = 0.5;\n      if (outline) mesh.add(outline);',
  },
  {
    id: 'outline-over-the-detail', expect: 'R3-renderer-outlines-the-shell-not-the-detail',
    doc: 'run EdgesGeometry over the merged geometry: thousands of segments, read as hatching',
    find: '        outline = new THREE.LineSegments(new THREE.EdgesGeometry(extrusion, 28), materials.outline);',
    replace: '        outline = null;',
  },
  {
    id: 'skirt-never-built', expect: 'R4-renderer-wires-the-plinths',
    doc: 'the pre-lane state: nothing in this renderer mentions a plinth',
    find: '    plinthMesh = new THREE.Mesh(geometry, materials.plinth);',
    replace: '    plinthMesh = null; void geometry;',
  },
  {
    id: 'instances-never-refreshed', expect: 'R5-renderer-refreshes-instances-on-suppression',
    doc: 'stop re-applying suppression to the instanced meshes — roof plant over the Fortress GLB',
    find: '    refreshDetailInstances();\n    syncPlinthSuppression();',
    replace: '    void 0;',
  },
  {
    id: 'place-name-literal-restored', expect: 'R6-the-place-name-open-frame-literal-is-gone',
    doc: 'put the string compare back, so exactly one building on the map is open and five are not',
    find: '      if (!row.replacesMass) {',
    replace: "      if (!(safeText(building.place).toLowerCase() === 'skeleton')) {",
  },
  {
    id: 'authored-roof-colour-thrown-away', expect: 'R7-the-authored-roof-colour-is-read',
    doc: 'go back to a roof that is the wall colour times a constant, on all 71 buildings',
    find: '    const authoredRoof = roof && Array.isArray(building.roof) ? building.roof : null;',
    replace: '    const authoredRoof = null;',
  },
  {
    id: 'cost-frozen-at-the-mount', expect: 'R8-renderer-derives-the-cost-at-read-time',
    doc: 'hand renderStats the object built inside addBuildings(): 67 skirts / 756 triangles forever, '
      + 'while the frame draws 66 / 748 the moment an authored GLB retires a building',
    find: '      buildings: buildingStatsNow(),\n      provisional: true,',
    replace: '      buildings: buildingRenderStats,\n      provisional: true,',
  },
  {
    id: 'mass-extruded-to-the-data-height', expect: 'R9-the-mass-is-extruded-to-the-fitted-height',
    doc: 'extrude to the data height and let the assembler\'s fit fall on the floor: the roof detaches '
      + 'from the eave AND the ridge goes back above the height the founder signed off',
    find: '          depth: row.massHeightM,',
    replace: '          depth: height,',
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

for (const mutation of RENDERER_MUTATIONS) {
  test(`discriminates [${mutation.expect}] <- renderer mutation "${mutation.id}": ${mutation.doc}`, () => {
    assert.ok(
      RENDERER_SOURCE.includes(mutation.find),
      `MUTATION HARNESS ROTTED: "${mutation.id}" searches for a string that is no longer in map3d-three.js`,
    );
    const mutated = RENDERER_SOURCE.replace(mutation.find, mutation.replace);
    assert.notEqual(mutated, RENDERER_SOURCE);
    const caught = caughtByRenderer(mutated);
    assert.ok(caught.length > 0, `renderer mutation "${mutation.id}" was not caught by ANY assertion`);
    assert.ok(
      caught.includes(mutation.expect),
      `renderer mutation "${mutation.id}" was not caught by ${mutation.expect} (caught by: ${caught.join(', ') || 'nothing'})`,
    );
  });
}

test('every assertion is covered by at least one mutation', () => {
  const covered = new Set(MUTATIONS.map((mutation) => mutation.expect));
  const uncovered = ASSERTIONS.map((assertion) => assertion.id).filter((id) => !covered.has(id));
  assert.deepEqual(uncovered, [], `assertions nobody has proved can fail: ${uncovered.join(', ')}`);
  const rendererCovered = new Set(RENDERER_MUTATIONS.map((mutation) => mutation.expect));
  const rendererUncovered = RENDERER_ASSERTIONS.map((assertion) => assertion.id).filter((id) => !rendererCovered.has(id));
  assert.deepEqual(rendererUncovered, [], `renderer assertions nobody has proved can fail: ${rendererUncovered.join(', ')}`);
});

test('the unmutated module and the shipped renderer pass every assertion', () => {
  assert.deepEqual(caughtBy(assembleModule), []);
  assert.deepEqual(caughtByRenderer(RENDERER_SOURCE), []);
});
