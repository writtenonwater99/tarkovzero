/**
 * The building archetype router, and the detail contract six parallel planners must satisfy.
 *
 * Asserted against the REAL `public/data/customs-3d.json` — all 71 buildings, public fields only.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS FILE HAS A MUTATION HARNESS
 *
 * Handoff §6 records five separate occasions in one day on which this project reported success
 * while something had silently fallen back — including `payloadBytesRead`, a metric that summed a
 * set no logged read could ever enter and was therefore identically zero BY CONSTRUCTION. The rule
 * that fell out: an assertion that cannot fail is worse than no assertion.
 *
 * So every assertion below is proved to discriminate, in the same run. The second half of this file
 * takes the REAL module source, applies one targeted mutation, writes the mutant to a temp file,
 * imports it, and re-runs the whole assertion set against it — and fails if the assertion that is
 * supposed to catch that mutation does not. The mutations are applied to the shipped source text,
 * not to a re-implementation, and a mutation whose search string no longer matches is itself a
 * failure, so the harness cannot rot into a no-op either.
 *
 * Run: `node --test scripts/building-archetype.test.mjs`
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import * as archetypeModule from '../src/building-archetype.js';
import * as contractModule from '../src/building-detail/contract.js';

const ARCHETYPE_SRC = new URL('../src/building-archetype.js', import.meta.url);
const CONTRACT_SRC = new URL('../src/building-detail/contract.js', import.meta.url);

const customs3d = JSON.parse(await readFile(new URL('../public/data/customs-3d.json', import.meta.url), 'utf8'));
const BUILDINGS = customs3d.buildings;
const EXPECTED_BUILDING_COUNT = 71;

// --------------------------------------------------------------------------------------------- //
// The assertion set. Each entry runs against a module namespace, so the same set can be re-run
// against a deliberately broken copy of the module below.
// --------------------------------------------------------------------------------------------- //

const round = (value) => Math.round(value);

/**
 * The census, pinned. Not decoration: it is the golden record later agents build against, and a
 * silent re-route of one building — exactly the failure the six competing specs produced — moves a
 * number here and nowhere else.
 */
const EXPECTED_CENSUS = Object.freeze({
  'big-box': { count: 13, areaM2: 17209 },
  'small-box': { count: 30, areaM2: 1306 },
  garage: { count: 12, areaM2: 4463 },
  cylinder: { count: 6, areaM2: 1778 },
  'open-structure': { count: 6, areaM2: 4412 },
  'lattice-tower': { count: 4, areaM2: 195 },
  unstyled: { count: 0, areaM2: 0 },
});
const EXPECTED_ROOF_CENSUS = Object.freeze({ ridged: 30, 'flat-parapet': 5, 'mono-pitch': 23, none: 13 });
const EXPECTED_PROGRAM_CENSUS = Object.freeze({ occupied: 6, industrial: 9, utility: 40, unresolved: 0, none: 16 });

const ARCHETYPE_ASSERTIONS = [
  {
    id: 'A1-total-and-single',
    doc: 'every building is classified exactly once, with an archetype from the frozen list',
    run(mod) {
      const result = mod.classifyAll(BUILDINGS);
      assert.equal(BUILDINGS.length, EXPECTED_BUILDING_COUNT, 'the shipped Customs data must still hold 71 buildings');
      assert.equal(result.assignments.length, EXPECTED_BUILDING_COUNT);
      for (const [index, record] of result.assignments.entries()) {
        assert.ok(mod.ARCHETYPES.includes(record.archetype), `building ${index}: "${record.archetype}" is not an archetype`);
      }
    },
  },
  {
    id: 'A2-partition',
    doc: 'the archetype buckets partition the index set: no building claimed twice, none unclaimed',
    run(mod) {
      const result = mod.classifyAll(BUILDINGS);
      const seen = new Map();
      for (const key of mod.ARCHETYPES) {
        for (const index of result.byArchetype[key]) {
          assert.ok(!seen.has(index), `building ${index} claimed by both "${seen.get(index)}" and "${key}"`);
          seen.set(index, key);
        }
      }
      assert.equal(seen.size, EXPECTED_BUILDING_COUNT, 'every building must be claimed exactly once');
      const summed = mod.ARCHETYPES.reduce((sum, key) => sum + result.byArchetype[key].length, 0);
      assert.equal(summed, EXPECTED_BUILDING_COUNT, 'the archetype counts must sum to 71');
      assert.equal(result.census.reduce((sum, row) => sum + row.count, 0), EXPECTED_BUILDING_COUNT);
    },
  },
  {
    id: 'A3-census-area',
    doc: 'the census area sums to the real total footprint area, to the metre',
    run(mod) {
      const result = mod.classifyAll(BUILDINGS);
      const independent = BUILDINGS.reduce((sum, building) => sum + mod.footprintMetrics(building.poly).areaM2, 0);
      assert.ok(Math.abs(result.totals.areaM2 - independent) < 1e-6, `${result.totals.areaM2} != ${independent}`);
      assert.equal(round(result.totals.areaM2), 29364);
      const censusArea = result.census.reduce((sum, row) => sum + row.areaM2, 0);
      assert.ok(Math.abs(censusArea - independent) < 1e-6, `census area ${censusArea} != ${independent}`);
    },
  },
  {
    id: 'A4-unstyled-empty',
    doc: '"unstyled" is empty for Customs, AND it is a channel that can actually report a row',
    run(mod) {
      const result = mod.classifyAll(BUILDINGS);
      assert.deepEqual(result.unstyled, [], `unstyled must be empty, got ${JSON.stringify(result.unstyled)}`);
      assert.equal(result.byArchetype.unstyled.length, 0);
      assert.equal(result.assignments.filter((record) => record.unrouted).length, 0);
      // "Empty on the real data" is exactly the shape of a metric that cannot fail — handoff §6.4,
      // `payloadBytesRead`, identically zero by construction and quotable as proof of safety. So the
      // channel is exercised: a row neither axis recognises MUST come back reported, by name.
      const probe = mod.classifyAll([
        ...BUILDINGS,
        { poly: [[0, 0], [8, 0], [8, 6], [0, 6]], height: 4, floors: 1, kind: 'zeppelin_mast', style: 'ogee', name: null },
      ]);
      assert.deepEqual(probe.unstyled, [BUILDINGS.length], 'an unrecognised row must be REPORTED in unstyled');
      assert.equal(probe.byArchetype.unstyled.length, 1);
      assert.equal(probe.assignments[BUILDINGS.length].archetype, 'unstyled');
      assert.equal(probe.assignments[BUILDINGS.length].unrouted, true);
      assert.equal(probe.assignments[BUILDINGS.length].routedBy, 'unrouted');
    },
  },
  {
    id: 'A5-lattice-towers',
    doc: 'the four powerline_towers rows land in lattice-tower, and nothing else does',
    run(mod) {
      const result = mod.classifyAll(BUILDINGS);
      const expected = BUILDINGS.reduce((acc, b, i) => (b.kind === 'powerline_towers' ? [...acc, i] : acc), []);
      assert.equal(expected.length, 4, 'Customs must still carry four powerline towers');
      assert.deepEqual(result.byArchetype['lattice-tower'], expected);
      for (const index of expected) {
        assert.equal(result.assignments[index].archetype, 'lattice-tower');
        // They are 22 m tall and drawn as solid boxes today. The router must never dress one as a shed.
        assert.equal(result.assignments[index].heightM, 22);
        assert.equal(result.assignments[index].roofForm, 'none');
      }
    },
  },
  {
    id: 'A6-orphan-unnamed-box',
    doc: 'the unnamed 138 m2 big_buildings box (h 9, no roof colour) is claimed, not unstyled',
    run(mod) {
      const result = mod.classifyAll(BUILDINGS);
      const orphans = BUILDINGS.reduce(
        (acc, b, i) => (b.kind === 'big_buildings' && b.style === 'box' && !b.place && !b.name ? [...acc, i] : acc),
        [],
      );
      assert.equal(orphans.length, 1, `expected exactly one unnamed big_buildings box, found ${orphans.length}`);
      const [index] = orphans;
      const record = result.assignments[index];
      assert.equal(round(record.metrics.areaM2), 138, 'this is the 138 m2 orphan from the design round');
      assert.equal(record.heightM, 9);
      assert.equal(BUILDINGS[index].roof, undefined, 'the orphan carries no authored roof colour');
      assert.notEqual(record.archetype, 'unstyled', 'the orphan must land somewhere real');
      assert.equal(record.archetype, 'big-box');
      assert.equal(record.program, 'industrial', 'one storey of 9 m clear height is a hall, not a dwelling');
    },
  },
  {
    id: 'A7-orphan-dorms-stair-core',
    doc: 'the Dorms 3-Story stair core (52 m2, h 9.5, 3 floors) is claimed, not unstyled',
    run(mod) {
      const result = mod.classifyAll(BUILDINGS);
      const cores = BUILDINGS.reduce(
        (acc, b, i) => (b.place === 'Dorms 3-Story' && b.kind === 'small_buildings' ? [...acc, i] : acc),
        [],
      );
      assert.equal(cores.length, 1, `expected exactly one Dorms 3-Story stair core, found ${cores.length}`);
      const [index] = cores;
      const record = result.assignments[index];
      assert.equal(round(record.metrics.areaM2), 52);
      assert.equal(record.heightM, 9.5);
      assert.equal(record.floors, 3);
      assert.notEqual(record.archetype, 'unstyled', 'the stair core must land somewhere real');
      assert.equal(record.archetype, 'small-box');
      // It is three real storeys, so it gets the block treatment its parent gets, not a shed roof.
      assert.equal(record.program, 'occupied');
      assert.equal(record.roofForm, 'flat-parapet');
    },
  },
  {
    id: 'A8-authored-gable-wins',
    doc: 'every authored gable style that is not a drawn circle gets a ridge',
    run(mod) {
      const result = mod.classifyAll(BUILDINGS);
      let ridged = 0;
      for (const [index, record] of result.assignments.entries()) {
        if (BUILDINGS[index].style !== 'gable') continue;
        if (record.archetype === 'cylinder') continue; // row 16: a 16-gon labelled gable
        assert.equal(record.roofForm, 'ridged', `building ${index} is style gable but roofForm "${record.roofForm}"`);
        ridged += 1;
      }
      assert.equal(ridged, 17, 'Customs carries 18 gable rows, one of which is a drawn circle');
      for (const record of result.assignments) {
        assert.ok(mod.ROOF_FORMS.includes(record.roofForm), `"${record.roofForm}" is not a roof form`);
      }
    },
  },
  {
    id: 'A9-occupied-boxes-are-flat',
    doc: 'an occupied block whose style names no roof gets a parapet, never a ridge',
    run(mod) {
      const result = mod.classifyAll(BUILDINGS);
      const flat = result.assignments.filter(
        (record, index) => record.program === 'occupied' && BUILDINGS[index].style === 'box',
      );
      assert.equal(flat.length, 5, 'Dorms 2-Story, Dorms 3-Story, its stair core, Oil Rig, scav checkpoint');
      for (const record of flat) {
        assert.equal(record.roofForm, 'flat-parapet', `${record.place ?? record.name} got "${record.roofForm}"`);
      }
    },
  },
  {
    id: 'A10-storey-ratio-gap',
    doc: 'the measured storey-ratio gap holds, so no building lands in the "unresolved" program',
    run(mod) {
      const result = mod.classifyAll(BUILDINGS);
      assert.deepEqual(result.unresolvedProgram, [], 'no building may sit in the measured gap');
      assert.equal(result.programCensus.unresolved, 0);
      // ...and the gap this depends on is a property of the DATA, checked independently here so a
      // future data rebuild that closes it cannot pass silently.
      const multi = BUILDINGS.filter((b) => (b.floors ?? 1) >= 2).map((b) => b.height / b.floors);
      assert.equal(multi.length, 13);
      const below = multi.filter((ratio) => ratio <= 3.75);
      const above = multi.filter((ratio) => ratio >= 4.75);
      assert.equal(below.length + above.length, multi.length, 'the (3.75, 4.75) band must stay empty');
      assert.equal(below.length, 6);
      assert.equal(above.length, 7);
    },
  },
  {
    id: 'A11-determinism',
    doc: 'classification is reproducible run to run and independent of array order',
    run(mod) {
      const first = mod.classifyAll(BUILDINGS);
      const second = mod.classifyAll(BUILDINGS);
      const fingerprint = (result) => result.assignments.map(
        (record) => `${record.archetype}|${record.roofForm}|${record.program}|${record.seed}`,
      );
      assert.deepEqual(fingerprint(second), fingerprint(first), 'two runs must agree');
      // A deterministic shuffle: reverse. A seed taken from an index instead of the footprint moves.
      const reversed = [...BUILDINGS].reverse();
      const shuffled = mod.classifyAll(reversed);
      assert.deepEqual(fingerprint(shuffled), [...fingerprint(first)].reverse(), 'order must not matter');
    },
  },
  {
    id: 'A12-round-footprints',
    doc: 'the round-footprint rule fires on exactly the four 16-gons, and cylinder holds six rows',
    run(mod) {
      const result = mod.classifyAll(BUILDINGS);
      const round16 = BUILDINGS.reduce((acc, b, i) => (b.poly.length === 16 ? [...acc, i] : acc), []);
      assert.equal(round16.length, 4, 'Customs carries four 16-vertex footprints');
      const detected = result.assignments.reduce((acc, record, i) => (record.metrics.round ? [...acc, i] : acc), []);
      assert.deepEqual(detected, round16, 'roundness must catch the 16-gons and nothing else');
      const expectedCylinders = BUILDINGS.reduce(
        (acc, b, i) => (b.kind === 'tank' || b.kind === 'cooling_tower' ? [...acc, i] : acc),
        [],
      );
      assert.equal(expectedCylinders.length, 6);
      assert.deepEqual(result.byArchetype.cylinder, expectedCylinders);
      // The row the two axes disagree about: kind tank, style gable, a 16-gon. Geometry wins.
      const conflicted = expectedCylinders.filter((i) => BUILDINGS[i].style === 'gable');
      assert.equal(conflicted.length, 1, 'the kind/style conflict row must still exist in the data');
      assert.equal(result.assignments[conflicted[0]].archetype, 'cylinder');
    },
  },
  {
    id: 'A13-golden-census',
    doc: 'the archetype, roof and program censuses match the pinned table exactly',
    run(mod) {
      const result = mod.classifyAll(BUILDINGS);
      const actual = Object.fromEntries(result.census.map((row) => [row.archetype, { count: row.count, areaM2: round(row.areaM2) }]));
      assert.deepEqual(actual, EXPECTED_CENSUS);
      assert.deepEqual(result.roofCensus, EXPECTED_ROOF_CENSUS);
      assert.deepEqual(result.programCensus, EXPECTED_PROGRAM_CENSUS);
    },
  },
  {
    id: 'A14-heights-untouched',
    doc: 'the router never alters a building height (handoff §4, standing decision 4)',
    run(mod) {
      const result = mod.classifyAll(BUILDINGS);
      for (const [index, record] of result.assignments.entries()) {
        assert.equal(record.heightM, BUILDINGS[index].height, `building ${index} height was changed`);
      }
      assert.equal(round(result.assignments.reduce((sum, r) => sum + r.heightM, 0) * 100), round(
        BUILDINGS.reduce((sum, b) => sum + b.height, 0) * 100,
      ));
    },
  },
];

// --------------------------------------------------------------------------------------------- //
// The contract's own assertions.
// --------------------------------------------------------------------------------------------- //

/** A minimal, valid plan. Everything the contract tests below is a perturbation of this. */
function samplePlan(mod, { slots = ['wall'], familyId = null } = {}) {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
  const indices = new Uint32Array(slots.flatMap((_, ordinal) => (ordinal === 0 ? [0, 1, 2] : [1, 3, 2])));
  const groups = slots.map((name, ordinal) => ({
    start: ordinal * 3, count: 3, materialSlot: mod.MATERIAL_SLOT_INDEX[name],
  }));
  const plan = {
    buildingIndex: 3,
    archetype: 'big-box',
    mesh: { positions, indices, groups },
    instances: [],
    notes: [],
  };
  if (familyId) {
    plan.instances.push({
      familyId,
      count: 2,
      prototype: { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) },
      offsets: new Float32Array(6),
      yaws: new Float32Array(2),
      scales: new Float32Array([1, 1, 1, 1, 1, 1]),
      ownerIndex: Int32Array.from([3, 3]),
      levelAboveBaseM: new Float32Array([2, 4]),
    });
  }
  return plan;
}

const CONTRACT_ASSERTIONS = [
  {
    id: 'C1-no-look-in-context',
    doc: 'a planner is never handed the look — geometry must be identical in both looks',
    run(mod) {
      for (const forbidden of ['look', 'relief', 'random']) {
        assert.ok(!mod.PLANNER_CONTEXT_KEYS.includes(forbidden), `"${forbidden}" must not be a planner context key`);
        assert.ok(forbidden in mod.FORBIDDEN_CONTEXT_KEYS, `"${forbidden}" must be listed as forbidden, with a reason`);
      }
      assert.throws(
        () => mod.validatePlannerContext({ buildingIndex: 0, classification: {}, seat: {}, groundYAt: () => 0, look: 'realistic' }),
        /look/,
      );
      assert.doesNotThrow(
        () => mod.validatePlannerContext({ buildingIndex: 0, classification: {}, seat: {}, groundYAt: () => 0 }),
      );
    },
  },
  {
    id: 'C2-material-slots',
    doc: 'the material slot list is unique, frozen and consistent with its index map',
    run(mod) {
      assert.equal(new Set(mod.MATERIAL_SLOTS).size, mod.MATERIAL_SLOTS.length, 'slot names must be unique');
      assert.ok(Object.isFrozen(mod.MATERIAL_SLOTS));
      mod.MATERIAL_SLOTS.forEach((name, index) => assert.equal(mod.MATERIAL_SLOT_INDEX[name], index));
      assert.deepEqual([...mod.FREE_MATERIAL_SLOTS], ['wall', 'roof']);
      for (const [familyId, spec] of Object.entries(mod.INSTANCED_FAMILIES)) {
        assert.ok(mod.MATERIAL_SLOTS.includes(spec.materialSlot), `family "${familyId}" names an unknown slot`);
      }
    },
  },
  {
    id: 'C3-mesh-shape',
    doc: 'a malformed mesh is rejected: group gaps, stray indices, wrong array types',
    run(mod) {
      assert.doesNotThrow(() => mod.validateDetailPlan(samplePlan(mod), { buildingCount: 71, archetype: 'big-box' }));
      const gapped = samplePlan(mod, { slots: ['wall', 'metal'] });
      gapped.mesh.groups[1].start = 4; // one index never covered by any group
      assert.throws(() => mod.validateDetailPlan(gapped, { buildingCount: 71 }), /contiguous|cover/);
      const stray = samplePlan(mod);
      stray.mesh.indices = new Uint32Array([0, 1, 99]);
      stray.mesh.groups = [{ start: 0, count: 3, materialSlot: 0 }];
      assert.throws(() => mod.validateDetailPlan(stray, { buildingCount: 71 }), /exceeds/);
      const untyped = samplePlan(mod);
      untyped.mesh.positions = [0, 0, 0];
      assert.throws(() => mod.validateDetailPlan(untyped, { buildingCount: 71 }), /Float32Array/);
    },
  },
  {
    id: 'C4-instance-ownership',
    doc: 'an instance must name a real owner building, and only its own',
    run(mod) {
      const good = samplePlan(mod, { familyId: 'roof-vent' });
      assert.doesNotThrow(() => mod.validateDetailPlan(good, { buildingCount: 71 }));
      const foreign = samplePlan(mod, { familyId: 'roof-vent' });
      foreign.instances[0].ownerIndex = Int32Array.from([3, 4]);
      assert.throws(() => mod.validateDetailPlan(foreign, { buildingCount: 71 }), /owned by that building/);
      const outOfRange = samplePlan(mod, { familyId: 'roof-vent' });
      outOfRange.instances[0].ownerIndex = Int32Array.from([3, 900]);
      assert.throws(() => mod.validateDetailPlan(outOfRange, { buildingCount: 71 }), /building index/);
      const unregistered = samplePlan(mod, { familyId: 'roof-vent' });
      unregistered.instances[0].familyId = 'gargoyle';
      assert.throws(() => mod.validateDetailPlan(unregistered, { buildingCount: 71 }), /registered instanced family/);
      const shortArray = samplePlan(mod, { familyId: 'roof-vent' });
      shortArray.instances[0].levelAboveBaseM = new Float32Array([2]);
      assert.throws(() => mod.validateDetailPlan(shortArray, { buildingCount: 71 }), /levelAboveBaseM length/);
    },
  },
  {
    id: 'C5-draw-call-accounting',
    doc: 'wall and roof are free; every other slot costs one call per building, a family costs one map-wide',
    run(mod) {
      const free = mod.planDrawCallDelta([samplePlan(mod, { slots: ['wall', 'roof'] })]);
      assert.equal(free.total, 0, 'reusing the building\'s own two materials must cost nothing');
      const oneExtra = mod.planDrawCallDelta([
        samplePlan(mod, { slots: ['wall', 'metal'] }),
        samplePlan(mod, { slots: ['roof', 'metal'] }),
      ]);
      assert.equal(oneExtra.perBuildingGroups, 2);
      assert.equal(oneExtra.worstPerBuilding, 1);
      assert.equal(oneExtra.total, 2);
      assert.ok(oneExtra.withinBudget);
      const families = mod.planDrawCallDelta([
        samplePlan(mod, { familyId: 'roof-vent' }),
        samplePlan(mod, { familyId: 'roof-vent' }),
        samplePlan(mod, { familyId: 'downpipe' }),
      ]);
      assert.equal(families.instancedFamilies, 2, 'one InstancedMesh per family, however many buildings use it');
      assert.equal(families.total, 2);
      const overBudget = mod.planDrawCallDelta([samplePlan(mod, { slots: ['wall', 'metal', 'glazing'] })]);
      assert.equal(overBudget.worstPerBuilding, 2);
      assert.equal(overBudget.withinBudget, false, 'two extra slots on one building is over budget');
    },
  },
];

// --------------------------------------------------------------------------------------------- //
// Part 1 — the assertions, against the real modules.
// --------------------------------------------------------------------------------------------- //

for (const assertion of ARCHETYPE_ASSERTIONS) {
  test(`router ${assertion.id}: ${assertion.doc}`, () => assertion.run(archetypeModule));
}
for (const assertion of CONTRACT_ASSERTIONS) {
  test(`contract ${assertion.id}: ${assertion.doc}`, () => assertion.run(contractModule));
}

test('router: the census renders as a table later agents can read', () => {
  const table = archetypeModule.formatCensus(archetypeModule.classifyAll(BUILDINGS));
  assert.match(table, /big-box\s+13\s+17209/);
  assert.match(table, /TOTAL\s+71\s+29364/);
});

// --------------------------------------------------------------------------------------------- //
// Part 2 — proof that each assertion discriminates.
// --------------------------------------------------------------------------------------------- //

const scratch = await mkdtemp(join(tmpdir(), 'tz-archetype-mut-'));
test.after(() => rm(scratch, { recursive: true, force: true }));

const SOURCES = {
  router: await readFile(ARCHETYPE_SRC, 'utf8'),
  contract: await readFile(CONTRACT_SRC, 'utf8'),
};

/** Apply one mutation to the real source text and import the result as a module. */
async function loadMutant(target, id, find, replace) {
  const source = SOURCES[target];
  assert.ok(
    source.includes(find),
    `MUTATION HARNESS ROTTED: "${id}" searches for a string that is no longer in src — ${JSON.stringify(find.slice(0, 90))}`,
  );
  const mutated = source.replace(find, replace);
  assert.notEqual(mutated, source, `mutation "${id}" changed nothing`);
  const file = join(scratch, `${target}-${id}.mjs`);
  await writeFile(file, mutated, 'utf8');
  return import(pathToFileURL(file).href);
}

/** Which assertions reject this module. An assertion that throws is an assertion that caught it. */
function caughtBy(assertions, mod) {
  return assertions.filter((assertion) => {
    try {
      assertion.run(mod);
      return false;
    } catch {
      return true;
    }
  }).map((assertion) => assertion.id);
}

/**
 * One row per assertion above. `expect` names the assertion that MUST reject the mutant; the run
 * also requires that at least one assertion does, so a mutation nothing notices is a test failure.
 */
const MUTATIONS = [
  {
    target: 'router', id: 'lattice-becomes-shed', expect: 'A5-lattice-towers',
    doc: 'route the powerline towers to small-box, as five of the six original specs effectively did',
    find: "if (kind === 'powerline_towers') return { archetype: 'lattice-tower', reason: 'kind:powerline_towers' };",
    replace: "if (kind === 'powerline_towers') return { archetype: 'small-box', reason: 'kind:powerline_towers' };",
  },
  {
    target: 'router', id: 'big-buildings-unrouted', expect: 'A6-orphan-unnamed-box',
    doc: 'drop the big_buildings branch, so the unnamed 138 m2 orphan falls through',
    find: "if (kind === 'big_buildings') return { archetype: 'big-box', reason: 'kind:big_buildings' };",
    replace: "if (false && kind === 'big_buildings') return { archetype: 'big-box', reason: 'kind:big_buildings' };",
  },
  {
    target: 'router', id: 'small-buildings-unstyled', expect: 'A7-orphan-dorms-stair-core',
    doc: 'send the small buildings to unstyled, so the Dorms stair core is silently undressed',
    find: "if (kind === 'small_buildings') return { archetype: 'small-box', reason: 'kind:small_buildings' };",
    replace: "if (kind === 'small_buildings') return { archetype: 'unstyled', reason: 'kind:small_buildings' };",
  },
  {
    target: 'router', id: 'double-claim', expect: 'A2-partition',
    doc: 'claim every building twice — the exact bug the six competing specs produced 15 times',
    find: '    byArchetype[record.archetype].push(index);',
    replace: '    byArchetype[record.archetype].push(index);\n    if (record.archetype !== \'unstyled\') byArchetype.unstyled.push(index);',
  },
  {
    target: 'router', id: 'census-area-drift', expect: 'A3-census-area',
    doc: 'let the census area drift 0.1% from the footprint total',
    find: 'const areaM2 = indices.reduce((sum, index) => sum + assignments[index].metrics.areaM2, 0);',
    replace: 'const areaM2 = indices.reduce((sum, index) => sum + assignments[index].metrics.areaM2 * 0.999, 0);',
  },
  {
    target: 'router', id: 'unstyled-hidden', expect: 'A4-unstyled-empty',
    doc: 'report unstyled as empty whatever landed in it — a metric that cannot fail',
    find: '    unstyled: byArchetype.unstyled.slice(),',
    replace: '    unstyled: [],',
  },
  {
    target: 'router', id: 'gable-loses-its-ridge', expect: 'A8-authored-gable-wins',
    doc: 'overrule the 18 authored gable rows with a flat roof',
    find: "if (style === 'gable') return { roofForm: 'ridged', reason: 'style:gable' };",
    replace: "if (style === 'gable') return { roofForm: 'flat-parapet', reason: 'style:gable' };",
  },
  {
    target: 'router', id: 'dorms-get-a-ridge', expect: 'A9-occupied-boxes-are-flat',
    doc: 'put a pitched roof on the Dorms blocks and the Oil Rig',
    find: "if (program === 'occupied') return { roofForm: 'flat-parapet', reason: 'program:occupied' };",
    replace: "if (program === 'occupied') return { roofForm: 'ridged', reason: 'program:occupied' };",
  },
  {
    target: 'router', id: 'storey-band-widened', expect: 'A10-storey-ratio-gap',
    doc: 'move the occupied bound below the measured population, opening the unresolved band',
    find: '  occupiedMaxStoreyM: 4.0,',
    replace: '  occupiedMaxStoreyM: 3.0,',
  },
  {
    target: 'router', id: 'seed-from-a-counter', expect: 'A11-determinism',
    doc: 'seed from a call counter instead of the footprint, so two runs disagree',
    find: '  let hash = 0x811c9dc5;',
    replace: '  let hash = (globalThis.__tzMutantSeedCounter = ((globalThis.__tzMutantSeedCounter ?? 0) + 1)) >>> 0;',
  },
  {
    target: 'router', id: 'roundness-too-loose', expect: 'A12-round-footprints',
    doc: 'loosen the aspect bound until the New Gas canopy reads as a circle',
    find: '  roundMaxAspect: 1.15,',
    replace: '  roundMaxAspect: 3.0,',
  },
  {
    target: 'router', id: 'obb-axes-swapped', expect: 'A13-golden-census',
    doc: 'swap the OBB long and short axes, killing the narrow-span lean-to rule',
    find: '    widthM: Math.min(best.spanU, best.spanV),',
    replace: '    widthM: Math.max(best.spanU, best.spanV),',
  },
  {
    target: 'router', id: 'height-inflated', expect: 'A14-heights-untouched',
    doc: 'inflate every height by 10% — the standing decision says heights are never changed',
    find: '  const heightM = num(building?.height);',
    replace: '  const heightM = num(building?.height) * 1.1;',
  },
  {
    target: 'contract', id: 'look-allowed', expect: 'C1-no-look-in-context',
    doc: 'let a planner read the look, so geometry could differ between the two skins',
    find: "export const PLANNER_CONTEXT_KEYS = Object.freeze([\n",
    replace: "export const PLANNER_CONTEXT_KEYS = Object.freeze([\n  'look',\n",
  },
  {
    target: 'contract', id: 'duplicate-slot', expect: 'C2-material-slots',
    doc: 'duplicate a material slot name, so two planners can mean different things by one index',
    find: "  'glazing', // 4",
    replace: "  'wall', // 4",
  },
  {
    target: 'contract', id: 'group-gaps-allowed', expect: 'C3-mesh-shape',
    doc: 'stop checking that material groups are contiguous — a gap is geometry never drawn',
    find: '    if (group.start !== cursor) fail(',
    replace: '    if (false) fail(',
  },
  {
    target: 'contract', id: 'foreign-owner-allowed', expect: 'C4-instance-ownership',
    doc: 'let a plan claim instances on a building it does not own',
    find: '    if (family.ownerIndex.some((owner) => owner !== plan.buildingIndex)) {',
    replace: '    if ([].some((owner) => owner !== plan.buildingIndex)) {',
  },
  {
    target: 'contract', id: 'metal-declared-free', expect: 'C5-draw-call-accounting',
    doc: 'declare the metal slot free, hiding 71 draw calls from the budget',
    find: "export const FREE_MATERIAL_SLOTS = Object.freeze(['wall', 'roof']);",
    replace: "export const FREE_MATERIAL_SLOTS = Object.freeze(['wall', 'roof', 'metal']);",
  },
];

for (const mutation of MUTATIONS) {
  test(`discriminates [${mutation.expect}] <- mutation "${mutation.id}": ${mutation.doc}`, async () => {
    const mutant = await loadMutant(mutation.target, mutation.id, mutation.find, mutation.replace);
    const assertions = mutation.target === 'router' ? ARCHETYPE_ASSERTIONS : CONTRACT_ASSERTIONS;
    const caught = caughtBy(assertions, mutant);
    assert.ok(caught.length > 0, `mutation "${mutation.id}" was not caught by ANY assertion`);
    assert.ok(
      caught.includes(mutation.expect),
      `mutation "${mutation.id}" was not caught by ${mutation.expect} (caught by: ${caught.join(', ') || 'nothing'})`,
    );
  });
}

test('every assertion is covered by at least one mutation', () => {
  const covered = new Set(MUTATIONS.map((mutation) => mutation.expect));
  const all = [...ARCHETYPE_ASSERTIONS, ...CONTRACT_ASSERTIONS].map((assertion) => assertion.id);
  const uncovered = all.filter((id) => !covered.has(id));
  // A1 is covered transitively: every router mutation that breaks totality trips it too. Anything
  // else uncovered is an assertion nobody has proved can fail.
  assert.deepEqual(uncovered, ['A1-total-and-single']);
});

test('the unmutated modules pass every assertion', () => {
  assert.deepEqual(caughtBy(ARCHETYPE_ASSERTIONS, archetypeModule), []);
  assert.deepEqual(caughtBy(CONTRACT_ASSERTIONS, contractModule), []);
});
