/**
 * building-height-test — the foundation gate.
 *
 * Founder report, 2026-08-30, real GPU, vector look: "buildings have like a foundation that makes
 * it look like a 10 story building when it's 3". The cause was seating: walls were placed on the
 * HIGHEST ground under the footprint and the resulting stilt gap was filled with a lit,
 * wall-coloured, outward-expanded box. Both numbers are multiplied by the view's relief factor, so
 * at relief 3 Dorms 3-Story carried 19.3 m of apparent building under a 9.5 m roof.
 *
 * This test asserts the invariant that prevents it coming back: the WALL MATERIAL standing above
 * the draped ground at the roof's contact point equals the data height, at relief 1 AND relief 3.
 * It runs the renderer's own functions — `src/buildings.js` is what src/map3d.js seats with, and
 * `buildTerrain()` from src/terrain.js is the same sampler the mesh and every draped feature use.
 *
 *   npm run test:buildings
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTerrain } from '../src/terrain.js';
import {
  seatBuilding, visibleWallHeight, floorLevels, plinthColor, skirtCap,
  STOREY_M, WALL_LIFT, PLINTH_EXPAND_M,
} from '../src/buildings.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOLERANCE_M = 0.5;
const RELIEFS = [1, 3];
/** The audited Customs landmarks. Names as they appear in public/data/customs-3d.json. */
const LANDMARKS = ['Dorms 2-Story', 'Dorms 3-Story', 'Big Red', 'Warehouse 4', 'Fortress'];

const data = JSON.parse(readFileSync(join(ROOT, 'public/data/customs-3d.json'), 'utf8'));
data.terrain.limit = data.limit;

/** One sampler per relief, built exactly as map3d's rebuildGround() builds it. */
const samplers = new Map(RELIEFS.map((r) => [r, buildTerrain(data, r, { look: 'vector' }).H]));

/** The biggest footprint carrying each landmark name — the one the eye reads on screen. */
const area = (poly) => Math.abs(poly.reduce((s, p, i) => { const q = poly[(i + 1) % poly.length]; return s + (p[0] * q[1] - q[0] * p[1]); }, 0) / 2);
const landmark = (place) => data.buildings.filter((b) => b.place === place).sort((a, b) => area(b.poly) - area(a.poly))[0];

test('every audited landmark exists in the shipped data', () => {
  for (const place of LANDMARKS) {
    const b = landmark(place);
    assert.ok(b, `${place} is missing from public/data/customs-3d.json`);
    assert.ok(b.height > 0, `${place} has no height`);
  }
});

for (const relief of RELIEFS) {
  const H = samplers.get(relief);

  test(`relief ${relief}x — visible wall height equals the data height`, () => {
    for (const place of LANDMARKS) {
      const b = landmark(place);
      const visible = visibleWallHeight(b, H);
      assert.ok(
        Math.abs(visible - b.height) <= TOLERANCE_M,
        `${place} @ ${relief}x: visible wall ${visible.toFixed(2)} m vs data height ${b.height} m `
        + `(delta ${(visible - b.height).toFixed(2)} m, tolerance ${TOLERANCE_M} m)`,
      );
    }
  });

  test(`relief ${relief}x — the wall is seated ON its contact ground, not stilted above it`, () => {
    for (const place of LANDMARKS) {
      const b = landmark(place);
      const { base, contact, hi } = seatBuilding(b, H);
      // The old rule was `base = max(ground) + 0.06`. On any sloped footprint that is strictly
      // higher than the contact pad, and at 3x it is metres higher — this is the assertion that
      // fails if anyone puts it back.
      assert.ok(base - contact <= WALL_LIFT + 1e-6,
        `${place} @ ${relief}x: wall base stands ${(base - contact).toFixed(2)} m above its contact ground`);
      assert.ok(base >= contact - 1e-6, `${place} @ ${relief}x: wall base sank below its contact ground`);
      assert.ok(hi >= contact - 1e-6, `${place} @ ${relief}x: ground stats are inconsistent`);
    }
  });

  test(`relief ${relief}x — the skirt is capped and never becomes storeys`, () => {
    for (const place of LANDMARKS) {
      const b = landmark(place);
      const { base, plinthBase, plinthHeight } = seatBuilding(b, H);
      const drop = base - plinthBase;
      assert.ok(drop <= skirtCap(b.height) + 1e-6,
        `${place} @ ${relief}x: skirt drops ${drop.toFixed(2)} m, cap is ${skirtCap(b.height).toFixed(2)} m`);
      assert.ok(plinthHeight > drop, `${place} @ ${relief}x: skirt does not lap behind the wall base`);
      // Whatever the slope does, the skirt may not out-grow the building it stands under.
      assert.ok(drop < b.height, `${place} @ ${relief}x: skirt (${drop.toFixed(2)} m) is taller than the building`);
    }
  });

  test(`relief ${relief}x — storey lines come from the real height`, () => {
    for (const place of LANDMARKS) {
      const b = landmark(place);
      for (const z of floorLevels(b)) {
        assert.ok(z < b.height, `${place} @ ${relief}x: storey line at ${z} m on a ${b.height} m building`);
        assert.ok(z % STOREY_M < 1e-6 || Math.abs((z % STOREY_M) - STOREY_M) < 1e-6,
          `${place}: storey line ${z} is not a multiple of ${STOREY_M}`);
      }
      // Bands are a function of floors and height only — never of the extruded span, which on a
      // slope is larger than either.
      const { base, plinthBase } = seatBuilding(b, H);
      const extrudedSpan = base + b.height - plinthBase;
      const top = floorLevels(b).at(-1) ?? 0;
      assert.ok(top < extrudedSpan, `${place}: storey lines are riding the extruded span`);
      assert.deepEqual(floorLevels(b), floorLevels({ ...b, plinthBase, base }),
        `${place}: floorLevels() read something other than height/floors`);
    }
  });
}

test('the skirt is a near-black, non-wall material in both looks', () => {
  for (const look of ['vector', 'realistic']) {
    const c = plinthColor(look);
    assert.equal(c.length, 4, `${look}: plinth colour must be RGBA`);
    assert.ok(Math.max(c[0], c[1], c[2]) <= 40,
      `${look}: plinth colour ${c.join(',')} is not near-black — it will read as another storey of wall`);
    assert.equal(c[3], 255, `${look}: plinth must be opaque or the terrain shows through the building`);
  }
  // The old plinth was expanded a quarter of a metre past the wall: a foundation ledge.
  assert.ok(PLINTH_EXPAND_M <= 0.1, 'the skirt is expanded far enough to read as a foundation ledge');
});

test('report — seating for every audited landmark', () => {
  const rows = [];
  for (const relief of RELIEFS) {
    const H = samplers.get(relief);
    for (const place of LANDMARKS) {
      const b = landmark(place);
      const s = seatBuilding(b, H);
      rows.push({
        relief: `${relief}x`, place, dataH: b.height,
        visibleWall: +visibleWallHeight(b, H).toFixed(2),
        skirt: +(s.base - s.plinthBase).toFixed(2),
        groundDrop: +(s.hi - s.lo).toFixed(2),
      });
    }
  }
  console.table(rows);
  assert.ok(rows.length === RELIEFS.length * LANDMARKS.length);
});
