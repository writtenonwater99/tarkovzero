/**
 * Walls, fences and gates.
 *
 * Four things are worth failing a build over, and each has its own suite below:
 *   1. draping — a barrier follows the real terrain instead of floating over it or sinking in;
 *   2. run/segment maths — a run's panels plus its openings equal the run, exactly;
 *   3. gate openings — an opening removes panel length and leaves closed mesh on both sides;
 *   4. the class table is the ONLY source of dimensions — a height cannot come from anywhere else.
 *
 * The terrain used in (1) is the real Customs heightfield out of `public/data/customs-3d.json`,
 * sampled through the same `makeTerrainSampler` the renderer uses, so a slope that would break
 * draping in the app breaks it here.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  CLASS_INVENTORY, GATE_INFERENCE, MEASURED, PARTIALLY_MEASURED, PROVISIONAL,
  PROVISIONAL_WALL_CLASSES, WALL_CLASSES,
  cleanPath, drapedPanelMeshData, expectedDimension, inferRoadCrossingGates, isWallPropRow,
  planDimensionLedger, planGate, planWallRun, planWallStructures, pointAtDistance,
  resolveWallClasses, runLengthM, slicePath, wallClassIdFor,
} from '../src/wall-runs.js';
import { drapedLinearSegmentMeshData, makeTerrainSampler } from '../src/three-world.js';

const customs3d = JSON.parse(await readFile(new URL('../public/data/customs-3d.json', import.meta.url), 'utf8'));
const customsProps = JSON.parse(await readFile(new URL('../data/customs-props.json', import.meta.url), 'utf8')).props;
const RELIEF = 2;
const H = makeTerrainSampler(customs3d.terrain, RELIEF);
const close = (actual, expected, epsilon, message) => assert.ok(
  Math.abs(actual - expected) <= epsilon,
  `${message ?? ''} ${actual} != ${expected} (±${epsilon})`.trim(),
);

// ------------------------------------------------------------------------------------------- //
// 1. Draping over real terrain
// ------------------------------------------------------------------------------------------- //

test('a chain-link panel seats both ends on the real Customs terrain, not on an average', () => {
  // A 60 m span of the west hill: the two ends differ by metres at relief 2, which is exactly the
  // case a box seated at the mean of its endpoints floats over at one end and buries at the other.
  const a = [-360, -140], b = [-320, -60];
  const spec = PROVISIONAL_WALL_CLASSES['chainlink-fence'];
  const groundA = H(...a), groundB = H(...b);
  assert.ok(Math.abs(groundA - groundB) > 1, `test span must actually be sloped (${groundA} vs ${groundB})`);

  const panel = drapedPanelMeshData(a, b, spec.heightM, 0, H, spec.meshUvScaleM);
  assert.ok(panel, 'panel built');
  const [bottomA, bottomB, topA, topB] = panel.corners;
  close(bottomA[2], groundA, 1e-9, 'panel start sits on the ground under its start');
  close(bottomB[2], groundB, 1e-9, 'panel end sits on the ground under its end');
  close(topA[2] - bottomA[2], spec.heightM, 1e-9, 'start stands the class height');
  close(topB[2] - bottomB[2], spec.heightM, 1e-9, 'end stands the class height');
});

test('every post of every real Customs run stands on the terrain under it', () => {
  const plan = planWallStructures({ fences: customs3d.fences, props: customs3d.props, roads: customs3d.roads });
  assert.ok(plan.stats.posts > 500, `expected a real post count, got ${plan.stats.posts}`);
  let checked = 0;
  for (const run of plan.runs) {
    for (const post of run.posts) {
      const ground = H(post.x, post.z);
      assert.ok(Number.isFinite(ground), 'terrain sample is finite under every post');
      // The renderer seats a post at H(x, z); the planner must therefore hand back a point the
      // sampler can answer for, i.e. an actual point ON the run and not an extrapolation past it.
      const nearest = Math.min(...run.path.map(([x, z]) => Math.hypot(x - post.x, z - post.z)));
      assert.ok(nearest <= run.spec.postSpacingM + 1e-6, 'post lies on its own run');
      checked += 1;
    }
  }
  assert.ok(checked > 500);
});

test('a solid wall prism drapes at every footprint corner', () => {
  const spec = PROVISIONAL_WALL_CLASSES['concrete-perimeter-wall'];
  const prism = drapedLinearSegmentMeshData([218, -158], [218, -92], spec.thicknessM, spec.heightM, 0, H);
  assert.ok(prism);
  assert.equal(prism.bases.length, 4);
  for (const [index, [x, z]] of prism.footprint.entries()) close(prism.bases[index], H(x, z), 1e-9, 'corner drapes');
});

// ------------------------------------------------------------------------------------------- //
// 2. Run and segment maths
// ------------------------------------------------------------------------------------------- //

test('run length, point-at-distance and slice agree with each other', () => {
  const path = [[0, 0], [10, 0], [10, 10], [10, 10], [0, 10]];
  close(runLengthM(path), 30, 1e-9, 'duplicate vertex adds nothing');
  assert.deepEqual(pointAtDistance(path, 0), [0, 0]);
  assert.deepEqual(pointAtDistance(path, 15), [10, 5]);
  assert.deepEqual(pointAtDistance(path, 30), [0, 10]);
  assert.deepEqual(pointAtDistance(path, 1e6), [0, 10], 'clamped past the end');
  const middle = slicePath(path, 5, 25);
  close(runLengthM(middle), 20, 1e-9, 'a slice is as long as it was asked to be');
  assert.deepEqual(middle[0], [5, 0], 'the cut point is inserted, not snapped to a vertex');
  assert.deepEqual(middle.at(-1), [5, 10]);
});

test('cleanPath drops repeats and non-finite points instead of emitting zero-length segments', () => {
  assert.deepEqual(cleanPath([[0, 0], [0, 0], [1, NaN], [3, 4], null, [3, 4]]), [[0, 0], [3, 4]]);
});

test('panels plus openings equal the run, on every real Customs run', () => {
  const plan = planWallStructures({ fences: customs3d.fences, props: customs3d.props, roads: customs3d.roads });
  assert.equal(plan.stats.runs, 81, '76 fence rows + 5 wall prop rows');
  for (const run of plan.runs) {
    close(run.panelLengthM + run.openingLengthM, run.lengthM, 1e-6, `${run.id} conserves length`);
    for (const panel of run.panels) {
      close(runLengthM(panel.path), panel.lengthM, 1e-6, `${run.id} panel path matches its declared span`);
    }
  }
  close(plan.stats.panelLengthM + plan.stats.openingLengthM, plan.stats.lengthM, 1e-6, 'map total conserves length');
});

test('post spacing never exceeds the class spacing, and both ends always carry a post', () => {
  const spec = PROVISIONAL_WALL_CLASSES['chainlink-fence'];
  const run = planWallRun({ path: [[0, 0], [11.3, 0]], classId: 'chainlink-fence' });
  const distances = run.posts.map((post) => post.distanceM);
  close(distances[0], 0, 1e-9);
  close(distances.at(-1), 11.3, 1e-9);
  assert.equal(run.posts[0].kind, 'end');
  assert.equal(run.posts.at(-1).kind, 'end');
  for (let index = 1; index < distances.length; index++) {
    assert.ok(distances[index] - distances[index - 1] <= spec.postSpacingM + 1e-9, 'spacing respected');
  }
});

test('a class with no posts gets no posts', () => {
  const run = planWallRun({ path: [[0, 0], [40, 0]], classId: 'concrete-perimeter-wall' });
  assert.equal(run.posts.length, 0);
  assert.equal(run.spec.postSpacingM, 0);
});

// ------------------------------------------------------------------------------------------- //
// 3. Gate openings
// ------------------------------------------------------------------------------------------- //

test('an opening removes exactly its own length and leaves a closed panel on each side', () => {
  const run = planWallRun({
    path: [[0, 0], [40, 0]],
    classId: 'chainlink-fence',
    openings: [{ fromM: 18, toM: 24, gateId: 'g1', provenance: 'declared' }],
  });
  close(run.lengthM, 40, 1e-9);
  close(run.openingLengthM, 6, 1e-9);
  close(run.panelLengthM, 34, 1e-9);
  close(run.panelLengthM + run.openingLengthM, run.lengthM, 1e-12, 'no length is lost at the opening');
  assert.equal(run.panels.length, 2);
  assert.deepEqual(run.panels[0].path.at(-1), [18, 0], 'the panel stops at the jamb');
  assert.deepEqual(run.panels[1].path[0], [24, 0], 'the next panel starts at the far jamb');
  assert.equal(run.panels[0].endKind, 'jamb');
  assert.equal(run.panels[1].startKind, 'jamb');
  assert.equal(run.posts.filter((post) => post.kind === 'jamb').length, 2, 'both jambs get a post');

  // The mesh on each side of the opening is closed: three-world's prism emits six faces including
  // both end caps, so a panel that stops at a gate does not leave the run hollow.
  for (const panel of run.panels) {
    const prism = drapedLinearSegmentMeshData(panel.path[0], panel.path.at(-1), run.spec.thicknessM, run.spec.heightM, 0, H);
    assert.equal(prism.indices.length, 36, '12 triangles = 6 closed quads, caps included');
    assert.equal(prism.positions.length / 3, 8);
  }
});

test('two overlapping openings cannot subtract the same metre twice', () => {
  const run = planWallRun({
    path: [[0, 0], [40, 0]],
    classId: 'chainlink-fence',
    openings: [{ fromM: 10, toM: 20 }, { fromM: 15, toM: 25 }],
  });
  close(run.openingLengthM, 15, 1e-9, 'merged to 10..25');
  close(run.panelLengthM + run.openingLengthM, run.lengthM, 1e-12);
  assert.equal(run.openings.length, 1);
});

test('an opening running to the end of a run leaves one panel and no orphan', () => {
  const run = planWallRun({ path: [[0, 0], [30, 0]], classId: 'chainlink-fence', openings: [{ fromM: 24, toM: 30 }] });
  assert.equal(run.panels.length, 1);
  close(run.panelLengthM, 24, 1e-9);
  close(run.panelLengthM + run.openingLengthM, run.lengthM, 1e-12);
});

test('a gate closes exactly when its leaves are not swung open', () => {
  const closedClasses = resolveWallClasses();
  const gate = planGate({ id: 'g', a: [0, 0], b: [8, 0], classId: 'chainlink-fence', classes: closedClasses });
  assert.equal(gate.leaves.length, 2);
  assert.equal(gate.jambs.length, 2);
  close(gate.spanM, 8, 1e-9);
  assert.deepEqual(gate.center, [4, 0]);
  // At the shipped 62 degrees the leaves swing to the same side, symmetrically about the axis.
  close(gate.leaves[0].b[1], gate.leaves[1].b[1], 1e-9, 'leaves swing symmetrically');
  assert.ok(gate.leaves[0].b[1] > 0.1, 'and they are actually open');
  const leafLength = (gate.spanM / 2) * gate.spec.gate.leafCoverage;
  for (const leaf of gate.leaves) close(Math.hypot(leaf.b[0] - leaf.a[0], leaf.b[1] - leaf.a[1]), leafLength, 1e-9, 'leaf length');

  // Force the leaves shut and they must meet in the middle: that is what proves the hinge maths.
  const shut = { ...WALL_CLASSES['chainlink-fence'], gate: { ...WALL_CLASSES['chainlink-fence'].gate, leafOpenDeg: 0, leafCoverage: 1 } };
  const shutGate = planGate({ a: [0, 0], b: [8, 0], classId: 'chainlink-fence', classes: { 'chainlink-fence': { ...closedClasses['chainlink-fence'], gate: shut.gate } } });
  close(shutGate.leaves[0].b[0], 4, 1e-9);
  close(shutGate.leaves[1].b[0], 4, 1e-9);
  close(shutGate.leaves[0].b[1], 0, 1e-9);
});

test('gate jambs stand taller than the run they interrupt', () => {
  const gate = planGate({ a: [0, 0], b: [8, 0], classId: 'chainlink-fence' });
  const spec = PROVISIONAL_WALL_CLASSES['chainlink-fence'];
  for (const jamb of gate.jambs) {
    close(jamb.heightM, spec.heightM + spec.gate.jambRiseM, 1e-9);
    close(jamb.widthM, spec.gate.jambWidthM, 1e-9);
  }
});

test('gate inference reports what it rejected and why, and rejects far more than it accepts', () => {
  const plan = planWallStructures({ fences: customs3d.fences, props: customs3d.props, roads: customs3d.roads });
  const { inference } = plan;
  assert.ok(inference, 'inference ran');
  assert.equal(inference.candidates, inference.gates.length + inference.rejected.length);
  assert.ok(inference.rejected.length > inference.gates.length * 3,
    'most gaps in the fence data are pen-lifts and corners, not gates');
  for (const gate of inference.gates) {
    assert.equal(gate.provenance, 'inferred:road-crossing');
    assert.ok(gate.spanM >= GATE_INFERENCE.minSpanM && gate.spanM <= GATE_INFERENCE.maxSpanM);
    assert.ok(gate.collinearity >= GATE_INFERENCE.minCollinearity);
    assert.ok(gate.onRoad);
  }
  for (const rejection of inference.rejected) assert.ok(rejection.reasons.length > 0, 'every rejection names a reason');
  // No gate may be claimed as measured or authored while it is derived from a road crossing.
  assert.deepEqual(plan.stats.gateProvenance, ['inferred:road-crossing']);
});

test('gate inference is deterministic and turns itself off on request', () => {
  const args = { fences: customs3d.fences, props: customs3d.props, roads: customs3d.roads };
  const first = planWallStructures(args).gates.map((gate) => gate.id);
  const second = planWallStructures(args).gates.map((gate) => gate.id);
  assert.deepEqual(first, second);
  assert.deepEqual([...first].sort(), first, 'gate order does not depend on iteration order');
  assert.equal(planWallStructures({ ...args, inferGates: false }).gates.length, 0);
});

test('an authored gate list is used verbatim and never quietly re-inferred', () => {
  const plan = planWallStructures({
    fences: customs3d.fences, props: customs3d.props, roads: customs3d.roads,
    gates: [{ id: 'authored-1', a: [0, 0], b: [6, 0], provenance: 'authored' }],
  });
  assert.equal(plan.gates.length, 1);
  assert.equal(plan.gates[0].id, 'authored-1');
  assert.equal(plan.gates[0].provenance, 'authored');
  assert.equal(plan.inference, null, 'no inference runs once a source declares gates');
});

// ------------------------------------------------------------------------------------------- //
// 4. The class table is the only source of dimensions
// ------------------------------------------------------------------------------------------- //

test('every dimension in a whole-map plan traces to the class table', () => {
  const classes = PROVISIONAL_WALL_CLASSES;
  const plan = planWallStructures({ fences: customs3d.fences, props: customs3d.props, roads: customs3d.roads, classes });
  const ledger = planDimensionLedger(plan);
  assert.ok(ledger.length > 2000, `expected a real ledger, got ${ledger.length} rows`);
  for (const row of ledger) {
    close(row.value, expectedDimension(classes, row.classId, row.field), 1e-12,
      `${row.owner} ${row.field} comes from the table`);
  }
});

test('an authored h/w on a wall prop row does not reach the geometry', () => {
  // data/customs-props.json carries h: 3.5 and w: 0.5 on the Fortress rows. Those are the numbers
  // the table was seeded FROM; a row that keeps its own copy is a second source, so the planner
  // must ignore them outright — proved here with a row whose numbers are absurd.
  const plan = planWallStructures({
    fences: [],
    props: [{ type: 'wall', name: 'liar', path: [[0, 0], [20, 0]], h: 99, w: 42 }],
    roads: [],
  });
  assert.equal(plan.runs.length, 1);
  assert.equal(plan.runs[0].spec.heightM, WALL_CLASSES['concrete-perimeter-wall'].heightM);
  assert.equal(plan.runs[0].spec.thicknessM, WALL_CLASSES['concrete-perimeter-wall'].thicknessM);
});

test('the shipped table is entirely provisional and says so', () => {
  for (const [classId, spec] of Object.entries(PROVISIONAL_WALL_CLASSES)) {
    assert.equal(spec.status, PROVISIONAL, `${classId} is unmeasured`);
    for (const key of ['heightM', 'thicknessM']) {
      assert.equal(spec.dimensions[key].status, PROVISIONAL);
      assert.equal(spec.dimensions[key].measuredAt, null);
      assert.match(spec.dimensions[key].source, /unmeasured|no thickness at all/);
    }
  }
});

test('a measured height drops in without touching any other number', () => {
  const measured = resolveWallClasses({
    'chainlink-fence': { heightM: 2.14, source: 'mesh-bounds run 2026-09-02, pathId 12345', measuredAt: '2026-09-02' },
  });
  const fence = measured['chainlink-fence'];
  assert.equal(fence.heightM, 2.14);
  assert.equal(fence.status, PARTIALLY_MEASURED);
  assert.equal(fence.dimensions.heightM.status, MEASURED);
  assert.equal(fence.dimensions.thicknessM.status, PROVISIONAL);
  // Derived numbers follow the measurement, which is the whole point of deriving them.
  assert.equal(fence.postHeightM, 2.14 + WALL_CLASSES['chainlink-fence'].postRiseM);
  assert.deepEqual([...fence.railOffsetsM], WALL_CLASSES['chainlink-fence'].railHeightFractions.map((f) => f * 2.14));
  assert.equal(measured['concrete-perimeter-wall'].status, PROVISIONAL, 'untouched class stays provisional');

  const both = resolveWallClasses({
    'chainlink-fence': { heightM: 2.14, thicknessM: 0.07, source: 's', measuredAt: '2026-09-02' },
  });
  assert.equal(both['chainlink-fence'].status, MEASURED);
});

test('a measurement without provenance, or with a nonsense value, is refused', () => {
  const cases = [
    [{ 'chainlink-fence': { heightM: 2 } }, /must name its source/],
    [{ 'chainlink-fence': { heightM: 2, source: 's' } }, /measuredAt/],
    [{ 'chainlink-fence': { heightM: 0, source: 's', measuredAt: 'd' } }, /finite positive/],
    [{ 'chainlink-fence': { heightM: NaN, source: 's', measuredAt: 'd' } }, /finite positive/],
    [{ 'chainlink-fence': { heightM: -3, source: 's', measuredAt: 'd' } }, /finite positive/],
    [{ 'jersey-barrier': { heightM: 1, source: 's', measuredAt: 'd' } }, /unknown wall class/],
  ];
  for (const [measurements, pattern] of cases) {
    assert.throws(() => resolveWallClasses(measurements), pattern);
  }
  assert.throws(() => resolveWallClasses([]), /keyed by class id/);
});

test('an unknown class fails loud rather than defaulting to something plausible', () => {
  assert.throws(() => wallClassIdFor({ wallClass: 'razor-wire' }, 'chainlink-fence'), /unknown wall class/);
  assert.throws(() => planWallRun({ path: [[0, 0], [1, 0]], classId: 'razor-wire' }), /unknown wall class/);
});

test('the pipeline can already express chain-link versus solid, even though every row is one today', () => {
  const solidFence = planWallStructures({
    fences: [{ path: [[0, 0], [20, 0]], wallClass: 'concrete-perimeter-wall' }], props: [], roads: [],
  });
  assert.equal(solidFence.runs[0].classId, 'concrete-perimeter-wall');
  assert.equal(solidFence.runs[0].spec.fill, 'solid');
  const defaulted = planWallStructures({ fences: [{ path: [[0, 0], [20, 0]] }], props: [], roads: [] });
  assert.equal(defaulted.runs[0].spec.fill, 'mesh');
});

// ------------------------------------------------------------------------------------------- //
// The enumeration itself: the table describes the data, not an imagined map
// ------------------------------------------------------------------------------------------- //

test('the class table enumerates exactly what the Customs data contains', () => {
  assert.deepEqual(Object.keys(WALL_CLASSES).sort(), ['chainlink-fence', 'concrete-perimeter-wall']);
  assert.equal(customs3d.fences.length, CLASS_INVENTORY['chainlink-fence'].customsRows);
  assert.equal(
    customsProps.filter((prop) => prop.type === 'wall').length,
    CLASS_INVENTORY['concrete-perimeter-wall'].customsRows,
  );
  assert.equal(customs3d.props.filter(isWallPropRow).length, 5);
  // Nothing else in the shipped data draws a path, so no row is silently dropped by the renderer.
  assert.equal(customs3d.props.filter((prop) => Array.isArray(prop.path) && prop.path.length >= 2).length, 5);
});

test('the source SVG carries no gate row, which is why gates are inferred at all', async () => {
  const { loadMapSvg } = await import('../scripts/lib/exact-map-primitives.mjs');
  const svg = await loadMapSvg('customs');
  const block = svg.slice(svg.indexOf('<g id="Fence"'), svg.indexOf('<g id="Buildings"', svg.indexOf('<g id="Fence"')));
  assert.ok(block.length > 0, 'found the Fence group');
  assert.doesNotMatch(block, /gate/i, 'no gate is named anywhere in the fence group');
  const paths = block.match(/<path\b[^>]*>/g) ?? [];
  assert.ok(paths.length > 20, `expected the real fence paths, got ${paths.length}`);
  for (const path of paths) {
    // Every attribute on every fence path, so a future source that starts carrying a class, a
    // width, or a gate marker makes this test fail and the inference gets retired.
    const attributes = [...path.matchAll(/\s([\w:-]+)=/g)].map((match) => match[1]);
    assert.deepEqual(attributes, ['d'], `fence path carries only geometry: ${path.slice(0, 60)}`);
  }
});
