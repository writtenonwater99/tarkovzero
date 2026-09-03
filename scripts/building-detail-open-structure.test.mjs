/**
 * The open-structure planner: canopies and unfinished frames.
 *
 * Asserted against the SIX REAL Customs rows `classifyAll()` routes to `open-structure`, taken from
 * `public/data/customs-3d.json` and seated on the shipped public heightfield at the default relief
 * of 3 — the same `seatBuilding()` the renderer runs, and the same `makeTerrainSampler()` shape that
 * feeds `H()`. Nothing here is re-implemented and nothing is synthetic except two deliberate
 * negative controls that are labelled as such.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS FILE HAS A MUTATION HARNESS
 *
 * Handoff section 6 records five occasions in one day on which this project reported success while
 * something had silently fallen back, one of them a metric that was identically zero by
 * construction. A sixth was caught in `scripts/building-archetype.test.mjs` before it shipped. So
 * every assertion below is proved to discriminate IN THE SAME RUN: part 2 takes the real module
 * source, applies one targeted mutation, imports the mutant and re-runs the whole assertion set
 * against it. A mutation nothing catches is a failure; a mutation whose search string no longer
 * matches the shipped source is also a failure, so the harness cannot rot into a no-op.
 *
 * ONE RULE LEARNED WHILE WRITING IT, worth stating because it nearly produced that sixth metric:
 * an assertion must never be expressed in terms of the constant it is checking. `O12` originally
 * compared the planned bay spacing against `OPEN_STRUCTURE.minReadableSpacingM`; mutating that
 * constant to 0.1 then let a 1.6 m spacing through and `O12` passed, because the module and the
 * test moved together. It now compares against the LITERAL one metre per pixel, which is a fact
 * about `distanceForZoom` and `fovy` in src/camera.js and not the module's opinion.
 *
 * Run: `node --test scripts/building-detail-open-structure.test.mjs`
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { classifyAll } from '../src/building-archetype.js';
import { seatBuilding } from '../src/buildings.js';
import { makeTerrainSampler } from '../src/three-world.js';
import { planDrawCallDelta, validateDetailPlan, validatePlannerContext } from '../src/building-detail/contract.js';
import * as openStructureModule from '../src/building-detail/open-structure.js';

const PLANNER_SRC = new URL('../src/building-detail/open-structure.js', import.meta.url);
const PLANNER_SOURCE = await readFile(PLANNER_SRC, 'utf8');

const customs3d = JSON.parse(await readFile(new URL('../public/data/customs-3d.json', import.meta.url), 'utf8'));
const BUILDINGS = customs3d.buildings;
const BUILDING_COUNT = 71;

/**
 * The default view's relief. `H()` in src/map3d-three.js multiplies terrain by it, and
 * `seatBuilding()` is measured in the displayed metres that come out — so a planner tested at
 * relief 1 would never see Skeleton's 9.4 m cross-slope, which is the case its column feet exist
 * for.
 */
const RELIEF = 3;
const H = makeTerrainSampler(customs3d.terrain, RELIEF);

/**
 * METRES PER PIXEL AT THE DEFAULT 3D VIEW. Derived in the build brief from `distanceForZoom` and
 * `fovy = 22` in src/camera.js: metres-per-pixel is 2^-zoom and the default 3D zoom is 0. This is a
 * property of the CAMERA, so it is written here as a literal and never read from the module under
 * test — see the header.
 */
const METRES_PER_PIXEL = 1.0;

const classified = classifyAll(BUILDINGS);
const OPEN_INDICES = classified.byArchetype['open-structure'];

/** The six rows, with the seat the renderer would give them. */
const ROWS = OPEN_INDICES.map((index) => {
  const building = BUILDINGS[index];
  const seated = seatBuilding(building, H);
  return {
    index,
    building,
    classification: classified.assignments[index],
    place: classified.assignments[index].place,
    seat: {
      baseY: seated.base,
      contactY: seated.contact,
      loY: seated.lo,
      hiY: seated.hi,
      plinthBaseY: seated.plinthBase,
      plinthHeightM: seated.plinthHeight,
    },
  };
});

/** Index -> place, so a failure message names a building instead of a number. */
const NAME = Object.fromEntries(ROWS.map((row) => [row.index, row.place]));

// --------------------------------------------------------------------------------------------- //
// Geometry measurement. Everything below reads the EMITTED TRIANGLES, never the profile, so that a
// design number and the mesh that implements it are two separate instruments.
// --------------------------------------------------------------------------------------------- //

function meshStats(mesh) {
  if (!mesh) return null;
  const { positions, indices } = mesh;
  const vertexCount = positions.length / 3;
  let volume = 0;
  let degenerate = 0;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let minArea = Infinity;
  for (let cursor = 0; cursor < indices.length; cursor += 3) {
    const a = indices[cursor] * 3, b = indices[cursor + 1] * 3, c = indices[cursor + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
    // Signed volume by the divergence theorem: positive iff every face winds OUTWARD.
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    if (area < 1e-6) degenerate++;
    minArea = Math.min(minArea, area);
  }
  for (let cursor = 2; cursor < positions.length; cursor += 3) {
    minZ = Math.min(minZ, positions[cursor]);
    maxZ = Math.max(maxZ, positions[cursor]);
  }
  return {
    vertexCount,
    triangles: indices.length / 3,
    volume,
    degenerate,
    minZ,
    maxZ,
    minArea,
    finite: positions.every(Number.isFinite),
    inRange: indices.every((index) => index < vertexCount),
  };
}

/** Run one module over the six real rows. Everything an assertion needs is on the returned rows. */
function planAll(mod) {
  return ROWS.map((row) => {
    const context = {
      buildingIndex: row.index,
      classification: row.classification,
      seat: row.seat,
      groundYAt: H,
    };
    validatePlannerContext(context);
    const plan = mod.planDetail(row.building, context);
    return { ...row, plan, stats: meshStats(plan.mesh) };
  });
}

const byPlace = (rows, place) => rows.find((row) => row.place === place);

// --------------------------------------------------------------------------------------------- //
// Part 1 — the assertions. Each is a closure over `{ mod, source }` so part 2 can re-run the whole
// set against a mutant of the shipped source.
// --------------------------------------------------------------------------------------------- //

const ASSERTIONS = [
  {
    id: 'O1-contract',
    doc: 'every plan satisfies the shared detail contract, groups included',
    run: ({ mod }) => {
      for (const row of planAll(mod)) {
        validateDetailPlan(row.plan, { buildingCount: BUILDING_COUNT, archetype: 'open-structure' });
        assert.ok(row.plan.mesh, `${NAME[row.index]}: planner returned no mesh`);
        assert.deepEqual(row.plan.instances, [], `${NAME[row.index]}: this archetype declares no instanced families`);
      }
    },
  },
  {
    id: 'O2-census',
    doc: 'six rows, three canopies and three frames, with Old Construction among the frames',
    run: ({ mod }) => {
      const rows = planAll(mod);
      assert.equal(rows.length, 6, 'the router routes exactly six buildings to open-structure');
      const families = rows.map((row) => row.plan.profile.family).sort();
      assert.deepEqual(families, ['canopy', 'canopy', 'canopy', 'frame', 'frame', 'frame']);
      assert.deepEqual(
        rows.filter((row) => row.plan.profile.family === 'frame').map((row) => row.place).sort(),
        ['Fortress', 'Old Construction', 'Skeleton'],
      );
      // THE FINDING. src/map3d-three.js:2481 opens a frame only when the place name is literally
      // 'skeleton', so Old Construction's identical `style: 'frame'` row is a solid box today.
      // It must come out of this planner as a frame, on the data, with no name compared.
      assert.equal(byPlace(rows, 'Old Construction').plan.profile.family, 'frame');
    },
  },
  {
    id: 'O3-geometry-sound',
    doc: 'finite, in-range, non-degenerate triangles',
    run: ({ mod }) => {
      for (const row of planAll(mod)) {
        const { stats } = row;
        assert.ok(stats.finite, `${NAME[row.index]}: a position is not finite`);
        assert.ok(stats.inRange, `${NAME[row.index]}: an index exceeds the vertex count`);
        assert.equal(stats.degenerate, 0, `${NAME[row.index]}: ${stats.degenerate} zero-area triangles`);
        assert.ok(stats.triangles > 0, `${NAME[row.index]}: nothing was built`);
      }
    },
  },
  {
    id: 'O4-outward-winding',
    doc: 'every solid winds outward, and the mesh volume matches the design volume',
    run: ({ mod }) => {
      for (const row of planAll(mod)) {
        const { plan, stats } = row;
        assert.ok(
          stats.volume > 0,
          `${NAME[row.index]}: signed volume ${stats.volume.toFixed(2)} m3 — at least one face winds inward,`
          + ' which renders the structure inside-out under THREE.FrontSide',
        );
        // Independent expectation from the DESIGN: decks are footprint x thickness, edge bands are
        // perimeter x width x drop, columns are w x d x h. A flipped face halves or reverses the
        // volume long before this 20% band is reached.
        const profile = plan.profile;
        const metrics = row.classification.metrics;
        const deckVolume = profile.levels * metrics.areaM2 * profile.slabThicknessM;
        const bandVolume = profile.levels * metrics.perimeterM * profile.edgeBandWidthM * profile.edgeBandDropM;
        const columnVolume = plan.columns.reduce(
          (sum, column) => sum + column.widthM * column.depthM * column.heightM, 0,
        );
        const expected = deckVolume + bandVolume + columnVolume;
        assert.ok(
          Math.abs(stats.volume - expected) / expected < 0.2,
          `${NAME[row.index]}: mesh volume ${stats.volume.toFixed(1)} m3 vs design ${expected.toFixed(1)} m3`,
        );
      }
    },
  },
  {
    id: 'O5-seated',
    doc: 'the structure stands exactly its data height and its columns are founded in the ground',
    run: ({ mod }) => {
      for (const row of planAll(mod)) {
        const { plan, stats, seat } = row;
        const roofY = seat.baseY + row.classification.heightM;
        // Heights are a standing decision (handoff section 4): nothing here may raise or lower one.
        assert.ok(
          Math.abs(stats.maxZ - roofY) < 1e-3,
          `${NAME[row.index]}: top at ${stats.maxZ.toFixed(4)} m, data height puts it at ${roofY.toFixed(4)} m`,
        );
        assert.ok(
          stats.minZ >= seat.baseY - plan.footDropLimitM - 1e-6,
          `${NAME[row.index]}: reaches ${(seat.baseY - stats.minZ).toFixed(2)} m below the seat,`
          + ` past the ${plan.footDropLimitM.toFixed(2)} m the dark skirt rule allows`,
        );
        assert.ok(plan.columns.length > 0, `${NAME[row.index]}: an open structure with no columns is a floating deck`);
        for (const column of plan.columns) {
          const groundY = H(column.x, column.z);
          const buried = column.bottomY <= groundY - mod.OPEN_STRUCTURE.columnFootEmbedM + 1e-6;
          const cappedOut = Math.abs(column.bottomY - (seat.baseY - plan.footDropLimitM)) < 1e-6;
          assert.ok(
            buried || cappedOut,
            `${NAME[row.index]}: a column foot at ${column.bottomY.toFixed(2)} m floats above its own`
            + ` ground at ${groundY.toFixed(2)} m`,
          );
          assert.ok(column.topY > column.bottomY, `${NAME[row.index]}: an inverted column`);
        }
      }
    },
  },
  {
    id: 'O6-open-silhouette',
    doc: 'the thing that made these read is preserved: the silhouette is mostly hole',
    run: ({ mod }) => {
      for (const row of planAll(mod)) {
        const { plan, stats } = row;
        const metrics = row.classification.metrics;
        assert.ok(
          plan.elevationSolidFraction <= mod.OPEN_STRUCTURE.maxElevationSolidFraction
          && plan.elevationSolidFraction >= mod.OPEN_STRUCTURE.minElevationSolidFraction,
          `${NAME[row.index]}: elevation solid fraction ${plan.elevationSolidFraction.toFixed(3)} is outside`
          + ' the open band — it has stopped being an open structure, or stopped being anything',
        );
        // LIVE CONTROL, measured on the mesh rather than restated from the design: what the
        // renderer draws for this row TODAY is an extrusion of the footprint through the full
        // height, so its bounding-box fill is exactly `metrics.fill`. The planned mesh must be at
        // least four times more open than that, on the geometry, not on the plan's own opinion.
        const boxM3 = metrics.lengthM * metrics.widthM * row.classification.heightM;
        const plannedFill = stats.volume / boxM3;
        const solidExtrusionFill = metrics.fill;
        assert.ok(
          plannedFill * 4 < solidExtrusionFill,
          `${NAME[row.index]}: planned mesh fills ${(plannedFill * 100).toFixed(1)}% of its bounding box`
          + ` against the solid extrusion's ${(solidExtrusionFill * 100).toFixed(1)}% — not open enough to read`,
        );
      }
    },
  },
  {
    id: 'O7-variation',
    doc: 'two real buildings of this archetype are treated differently, and it is the data doing it',
    run: ({ mod }) => {
      const rows = planAll(mod);
      const skeleton = byPlace(rows, 'Skeleton');
      const oldConstruction = byPlace(rows, 'Old Construction');
      // Both are `style: frame`, both 9.5 m, both floors 2. Only the footprint separates them
      // (1522 m2 at 60.7 x 25.1 against 502 m2 at 25.6 x 19.7), so the grid must separate too.
      assert.notEqual(
        skeleton.plan.profile.long.stations.length,
        oldConstruction.plan.profile.long.stations.length,
        'Skeleton and Old Construction are 60.7 m and 25.6 m long and got the same number of bays',
      );
      assert.notEqual(skeleton.plan.columns.length, oldConstruction.plan.columns.length);
      assert.notEqual(
        skeleton.plan.profile.columnWidthM.toFixed(3),
        oldConstruction.plan.profile.columnWidthM.toFixed(3),
      );
      // Fortress is the third frame and differs on the axis the other two share: its 9.05 m storey
      // ratio subdivides, theirs does not.
      assert.equal(byPlace(rows, 'Fortress').plan.profile.levels, 4);
      assert.equal(skeleton.plan.profile.levels, 2);

      const newGas = byPlace(rows, 'New Gas');
      const oldGas = byPlace(rows, 'Old Gas');
      assert.notEqual(newGas.plan.columns.length, oldGas.plan.columns.length);
      assert.notEqual(
        newGas.plan.profile.deckThicknessM.toFixed(3),
        oldGas.plan.profile.deckThicknessM.toFixed(3),
      );
      assert.notEqual(
        newGas.plan.profile.fasciaDropM.toFixed(3),
        oldGas.plan.profile.fasciaDropM.toFixed(3),
      );
      // The fall direction must actually vary. One bit of `classification.seed` came back 1 on all
      // three canopies, which is a variation axis that cannot vary; the terrain separates them.
      const falls = rows.filter((row) => row.plan.profile.family === 'canopy').map((row) => row.plan.fallSign);
      assert.equal(falls.length, 3);
      assert.ok(
        new Set(falls).size > 1,
        `all three canopies drain the same way (${falls.join(', ')}) — that is not variation`,
      );
      // And no two of the six share a profile.
      const fingerprints = rows.map((row) => JSON.stringify([
        row.plan.profile.family, row.plan.columns.length, row.plan.profile.levels,
        row.plan.profile.columnWidthM.toFixed(3), row.plan.profile.edgeBandDropM.toFixed(3),
      ]));
      assert.equal(new Set(fingerprints).size, 6, `two open structures got identical treatment: ${fingerprints}`);
    },
  },
  {
    id: 'O8-cost',
    doc: 'the triangle and draw-call cost is exactly what the report claims',
    run: ({ mod }) => {
      const rows = planAll(mod);
      const triangles = Object.fromEntries(rows.map((row) => [row.place, row.stats.triangles]));
      assert.deepEqual(triangles, {
        'New Gas': 224,
        Fortress: 608,
        'Old Construction': 280,
        Skeleton: 520,
        'Bus Station': 68,
        'Old Gas': 92,
      }, 'the per-building triangle cost moved; the reported number is now wrong');
      assert.equal(rows.reduce((sum, row) => sum + row.stats.triangles, 0), 1792);

      const delta = planDrawCallDelta(rows.map((row) => row.plan));
      assert.deepEqual(delta.perBuildingGroups, 6, 'one extra material slot per building, six buildings');
      assert.equal(delta.worstPerBuilding, 1);
      assert.equal(delta.instancedFamilies, 0, 'this archetype declares no instanced families');
      assert.equal(delta.total, 6);
      assert.ok(delta.withinBudget);
      assert.ok(delta.framePct < 0.5, `+${delta.framePct.toFixed(2)}% of a 1461-call frame`);
      // Every building must actually PAY for its trim band — a plan reporting zero extra slots
      // while still drawing the band would be a free lunch, which is the shape of a metric that
      // cannot fail.
      for (const row of rows) {
        assert.equal(row.plan.extraMaterialSlots, 1, `${NAME[row.index]}: expected exactly one non-free slot`);
      }
    },
  },
  {
    id: 'O9-mass-replace',
    doc: 'the plan tells the renderer to stop extruding these footprints',
    run: ({ mod }) => {
      for (const row of planAll(mod)) {
        assert.equal(
          row.plan.massDisposition, 'replace',
          `${NAME[row.index]}: columns inside a solid extrusion are invisible and a canopy IS its void`,
        );
      }
      // NEGATIVE CONTROL: handed something that is not its archetype, the planner must decline and
      // leave the mass alone rather than open up a warehouse.
      const bigBox = classified.byArchetype['big-box'][0];
      const declined = mod.planDetail(BUILDINGS[bigBox], {
        buildingIndex: bigBox,
        classification: classified.assignments[bigBox],
        seat: seatBuilding(BUILDINGS[bigBox], H),
        groundYAt: H,
      });
      assert.equal(declined.massDisposition, 'keep');
      assert.equal(declined.mesh, null);
    },
  },
  {
    id: 'O10-pure-and-deterministic',
    doc: 'same input, same bytes; and nothing non-deterministic is reachable in the source',
    run: ({ mod, source }) => {
      const first = planAll(mod);
      const second = planAll(mod);
      for (const [ordinal, row] of first.entries()) {
        assert.deepEqual(
          Array.from(row.plan.mesh.positions),
          Array.from(second[ordinal].plan.mesh.positions),
          `${NAME[row.index]}: two runs produced different geometry`,
        );
      }
      // COMMENTS ARE STRIPPED FIRST. The module's own header explains that `Math.random` is
      // forbidden, so a scan of the raw text matches the prose and fails on the shipped source —
      // an assertion that fires on the thing it is documenting is no assertion at all.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const banned of ['Math.random', 'Date.now', 'new Date', "from 'three'", 'document.', 'window.']) {
        assert.ok(
          !code.includes(banned),
          `the planner source reaches for ${banned}; a planner is pure and reproducible run to run`,
        );
      }
      // The look flip cannot move a vertex (CLAUDE.md). The planner never sees it and never names it.
      assert.ok(!/\blook\b/.test(code), 'the planner source mentions the look');
      assert.throws(
        () => validatePlannerContext({
          buildingIndex: 0, classification: ROWS[0].classification, seat: ROWS[0].seat, groundYAt: H, look: 'realistic',
        }),
        /forbidden/,
      );
    },
  },
  {
    id: 'O11-triangulation',
    doc: 'the deck of a non-rectilinear canopy is triangulated completely',
    run: ({ mod }) => {
      // New Gas is the one row here that is not a quad: a 14-gon at fill 0.824, `rectilinear` false.
      const newGas = ROWS.find((row) => row.place === 'New Gas');
      const ring = mod.normalisedRing(newGas.building.poly);
      assert.equal(ring.length, 14);
      const triangles = mod.earClipTriangles(ring);
      assert.equal(triangles.length, ring.length - 2, 'a simple polygon has exactly n-2 ears');
      const covered = triangles.reduce((sum, [a, b, c]) => sum + Math.abs(
        (ring[b][0] - ring[a][0]) * (ring[c][1] - ring[a][1])
        - (ring[b][1] - ring[a][1]) * (ring[c][0] - ring[a][0]),
      ) / 2, 0);
      const shoelace = Math.abs(mod.signedRingArea(ring));
      assert.ok(
        Math.abs(covered - shoelace) < 1e-6,
        `triangulation covers ${covered.toFixed(4)} m2 of a ${shoelace.toFixed(4)} m2 deck`,
      );
      // ...and the deck the planner actually emits has no hole in it either.
      const plan = planAll(mod).find((row) => row.place === 'New Gas').plan;
      assert.equal(plan.rejectedColumnStations, 1, 'the notch in New Gas rejects exactly one grid node');
    },
  },
  {
    id: 'O12-reads-at-one-metre-per-pixel',
    doc: 'member SPACING stays above the pixel and member SECTION stays below the wall',
    run: ({ mod }) => {
      for (const row of planAll(mod)) {
        const profile = row.plan.profile;
        for (const axis of ['long', 'across']) {
          const grid = profile[axis];
          if (grid.collapsed) continue; // one line carries the span; there is no spacing to read
          assert.ok(
            grid.spacingM >= 3 * METRES_PER_PIXEL,
            `${NAME[row.index]}: ${axis} bays are ${grid.spacingM.toFixed(2)} m apart — under three pixels`
            + ' at the default view, so the rhythm that makes this archetype read is a smudge',
          );
        }
        // Decision 4 in reverse: members must stay in the sub-pixel band the existing frame asset
        // uses (0.28-0.46 m). A member that grew into something the eye reads as SURFACE has turned
        // an open structure back into a box.
        for (const [label, value] of [
          ['column', profile.columnWidthM],
          ['slab', profile.slabThicknessM],
          ['edge band drop', profile.edgeBandDropM],
          ['edge band width', profile.edgeBandWidthM],
        ]) {
          assert.ok(
            value >= 0.18 && value <= 0.95,
            `${NAME[row.index]}: ${label} is ${value.toFixed(2)} m, outside the 0.18-0.95 m member band`,
          );
        }
        // A canopy must keep a clear height under it or it is a lid, not a canopy.
        if (profile.family === 'canopy') {
          assert.ok(
            profile.clearHeightM >= mod.OPEN_STRUCTURE.canopyMinClearM,
            `${NAME[row.index]}: only ${profile.clearHeightM.toFixed(2)} m of clear height under the deck`,
          );
        }
      }
    },
  },
];

for (const assertion of ASSERTIONS) {
  test(`${assertion.id}: ${assertion.doc}`, () => {
    assertion.run({ mod: openStructureModule, source: PLANNER_SOURCE });
  });
}

test('report: what the six real open structures cost', () => {
  const rows = planAll(openStructureModule);
  const lines = rows.map((row) => [
    row.place.padEnd(17),
    row.plan.profile.family.padEnd(7),
    `${row.stats.triangles}`.padStart(4) + ' tris',
    `${row.plan.columns.length}`.padStart(3) + ' cols',
    `${row.plan.profile.levels}`.padStart(2) + ' decks',
    `esf ${row.plan.elevationSolidFraction.toFixed(3)}`,
    `fill ${(row.stats.volume / (row.classification.metrics.lengthM * row.classification.metrics.widthM * row.classification.heightM)).toFixed(3)}`,
  ].join('  '));
  const delta = planDrawCallDelta(rows.map((row) => row.plan));
  console.log(`\n${lines.join('\n')}\n  TOTAL ${rows.reduce((sum, row) => sum + row.stats.triangles, 0)} triangles,`
    + ` +${delta.total} draw calls (${delta.framePct.toFixed(2)}% of a 1461-call frame)\n`);
  assert.ok(lines.length === 6);
});

// --------------------------------------------------------------------------------------------- //
// Part 2 — proof that each assertion discriminates.
// --------------------------------------------------------------------------------------------- //

const scratch = await mkdtemp(join(tmpdir(), 'tz-open-structure-mut-'));
test.after(() => rm(scratch, { recursive: true, force: true }));

const SRC_DIR = pathToFileURL(join(fileURLToPath(new URL('../src/building-detail/', import.meta.url)), '_')).href.slice(0, -1);

/**
 * Apply one mutation to the REAL module source and import the result.
 *
 * The mutant lands in a temp directory, so its relative imports are rewritten to absolute file URLs
 * first. That rewrite is done before the mutation is applied and is asserted to have happened, so a
 * mutant cannot silently import the unmutated original.
 */
async function loadMutant(id, find, replace) {
  assert.ok(
    PLANNER_SOURCE.includes(find),
    `MUTATION HARNESS ROTTED: "${id}" searches for a string that is no longer in src — ${JSON.stringify(find.slice(0, 90))}`,
  );
  const rebased = PLANNER_SOURCE
    .replace("from './contract.js'", `from '${SRC_DIR}contract.js'`)
    .replace("from '../three-world.js'", `from '${SRC_DIR}../three-world.js'`);
  assert.ok(!rebased.includes("from './contract.js'"), 'import rewrite failed; the mutant would load the original');
  const mutated = rebased.replace(find, replace);
  assert.notEqual(mutated, rebased, `mutation "${id}" changed nothing`);
  const file = join(scratch, `open-structure-${id}.mjs`);
  await writeFile(file, mutated, 'utf8');
  return { mod: await import(pathToFileURL(file).href), source: mutated };
}

/** Which assertions reject this module. An assertion that throws is an assertion that caught it. */
function caughtBy(context) {
  return ASSERTIONS.filter((assertion) => {
    try {
      assertion.run(context);
      return false;
    } catch {
      return true;
    }
  }).map((assertion) => assertion.id);
}

/** One row per assertion. `expect` names the assertion that MUST reject the mutant. */
const MUTATIONS = [
  {
    id: 'groups-non-contiguous', expect: 'O1-contract',
    doc: 'leave a three-index hole between material groups — geometry that would never be drawn',
    find: 'groups.push({ start: indices.length, count: bucket.indices.length, materialSlot: slot });',
    replace: 'groups.push({ start: indices.length + 3, count: bucket.indices.length, materialSlot: slot });',
  },
  {
    id: 'canopies-become-frames', expect: 'O2-census',
    doc: 'ignore the roof form, so a fuel canopy is planned as a stack of floor slabs',
    find: "const canopy = classification?.roofForm === 'mono-pitch';",
    replace: 'const canopy = false;',
  },
  {
    // The first attempt here collapsed a column's TOP onto its BOTTOM and was caught by nothing:
    // `prismPart` clamps the base to `minMemberM` below the top precisely so a zero-height solid
    // cannot be emitted. The clamp is the right design, so the mutation moved to the one axis it
    // does not defend.
    id: 'zero-depth-columns', expect: 'O3-geometry-sound',
    doc: 'collapse every frame column onto a line, emitting zero-area side faces and no cap at all',
    find: '    columnDepthM: columnWidthM,\n    fallDropM: 0,',
    replace: '    columnDepthM: 0,\n    fallDropM: 0,',
  },
  {
    id: 'winding-flipped', expect: 'O4-outward-winding',
    doc: 'reverse one side-face winding so the solids render inside-out under FrontSide',
    find: '    pushTriangle(part, bottomIds[index], bottomIds[next], topIds[next]);',
    replace: '    pushTriangle(part, bottomIds[next], bottomIds[index], topIds[next]);',
  },
  {
    id: 'columns-float', expect: 'O5-seated',
    doc: 'park every column foot on the seat plane instead of following the ground under it',
    find: '        Math.min(groundY - OPEN_STRUCTURE.columnFootEmbedM, baseY),',
    replace: '        Math.min(baseY, baseY),',
  },
  {
    id: 'height-raised', expect: 'O5-seated',
    doc: 'lift the structure two metres above its data height — heights are a standing decision',
    find: '  const topY = baseY + profile.heightM;',
    replace: '  const topY = baseY + profile.heightM + 2;',
  },
  {
    id: 'decks-become-walls', expect: 'O6-open-silhouette',
    doc: 'grow the slabs until the elevation is solid — an open structure that is no longer open',
    find: '    slabThicknessM: clamp(0.18, across.spacingM * 0.035, 0.4),',
    replace: '    slabThicknessM: clamp(0.18, across.spacingM * 3.5, 40),',
  },
  {
    id: 'one-grid-for-everyone', expect: 'O7-variation',
    doc: 'lay every frame out on a fixed 40 m grid, so 61 m and 26 m buildings get identical bays',
    find: '    long: bayStations(lengthM, insetM, OPEN_STRUCTURE.frameBayTargetM, OPEN_STRUCTURE.maxLinesPerAxis),',
    replace: '    long: bayStations(40, insetM, OPEN_STRUCTURE.frameBayTargetM, OPEN_STRUCTURE.maxLinesPerAxis),',
  },
  {
    id: 'fall-constant', expect: 'O7-variation',
    doc: 'drain every canopy the same way, the defect the seed bit would have shipped',
    find: '  const fallSign = endGround(1) <= endGround(-1) ? 1 : -1;',
    replace: '  const fallSign = 1;',
  },
  {
    id: 'trim-reported-free', expect: 'O8-cost',
    doc: 'report every group as the free wall slot while still drawing the trim band — a free lunch',
    find: 'groups.push({ start: indices.length, count: bucket.indices.length, materialSlot: slot });',
    replace: 'groups.push({ start: indices.length, count: bucket.indices.length, materialSlot: 0 });',
  },
  {
    id: 'mass-kept', expect: 'O9-mass-replace',
    doc: 'leave the solid extrusion in place, so the columns are drawn inside a block',
    find: "  plan.massDisposition = 'replace';",
    replace: "  plan.massDisposition = 'keep';",
  },
  {
    id: 'randomness-reachable', expect: 'O10-pure-and-deterministic',
    doc: 'reach for Math.random in a module the renderer must reproduce run to run',
    find: 'const clamp = (low, value, high) => Math.min(high, Math.max(low, value));',
    replace: 'const clamp = (low, value, high) => Math.min(high, Math.max(low, value));\nconst jitter = () => Math.random();',
  },
  {
    id: 'triangulator-drops-the-last-ear', expect: 'O11-triangulation',
    doc: 'stop emitting the final ear, leaving a hole in every deck',
    find: '  if (live.length === 3) triangles.push([live[0], live[1], live[2]]);',
    replace: '  if (false) triangles.push([live[0], live[1], live[2]]);',
  },
  {
    id: 'readable-spacing-off', expect: 'O12-reads-at-one-metre-per-pixel',
    doc: 'let an axis carry two column lines 1.6 m apart, which is one smudge at one metre per pixel',
    find: '  minReadableSpacingM: 3.0,',
    replace: '  minReadableSpacingM: 0.1,',
  },
  {
    // Raising only the coefficient is caught by nothing: the 0.7 m clamp holds it inside the member
    // band, which is what the clamp is for. The mutation therefore raises the CLAMP, which is the
    // only edit that can actually turn a column into a pier.
    id: 'columns-become-piers', expect: 'O12-reads-at-one-metre-per-pixel',
    doc: 'raise the column clamp to three metres, turning the open rhythm back into surface',
    find: '  const widthFor = (grid) => clamp(\n    0.3,\n'
      + '    0.055 * Math.sqrt(Math.max(1, grid.long.spacingM * grid.across.spacingM)) * Math.sqrt(levels / 2),\n'
      + '    0.7,\n  );',
    replace: '  const widthFor = (grid) => clamp(\n    3,\n'
      + '    0.055 * Math.sqrt(Math.max(1, grid.long.spacingM * grid.across.spacingM)) * Math.sqrt(levels / 2),\n'
      + '    3.5,\n  );',
  },
];

for (const mutation of MUTATIONS) {
  test(`discriminates [${mutation.expect}] <- mutation "${mutation.id}": ${mutation.doc}`, async () => {
    const context = await loadMutant(mutation.id, mutation.find, mutation.replace);
    const caught = caughtBy(context);
    assert.ok(caught.length > 0, `mutation "${mutation.id}" was not caught by ANY assertion — a metric that cannot fail`);
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

test('the unmutated planner passes every assertion', () => {
  assert.deepEqual(caughtBy({ mod: openStructureModule, source: PLANNER_SOURCE }), []);
});
