// The vegetation draw-call budget gate.
//
// Runs against the REAL local vegetation package and the REAL authored pack, so it measures the
// shipped artifacts rather than a fixture, and skips cleanly (like the other `.local-*` suites)
// on a machine that does not have them. What it pins:
//
//   * the hybrid router is total — authored + procedural + culled === the declared source count,
//     with no flatIndex lost and none duplicated;
//   * the batch count has a STRUCTURAL ceiling of families x 3, not a layout-dependent one, and
//     that ceiling is 93 for the complete 31-family pack (the deleted 128 m cell grid measured
//     1,333 at its floor and 2,016 at its ceiling for exactly the same placements);
//   * every (family, LOD) key is unique, so no placement can be drawn twice.
//
// See docs/plans/VEGETATION-DRAWCALLS.md §4 and §7.1.

import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three/webgpu';
import { buildCustomsLocalVegetationRenderPlan } from '../src/customs-local-vegetation-render.js';
import { classifyCustomsVegetationPrototype } from '../src/customs-local-vegetation.js';
import {
  CUSTOMS_AUTHORED_VEGETATION_BUCKET_CEILING,
  normalizeCustomsAuthoredVegetationCatalog,
  partitionCustomsAuthoredVegetationByLod,
  planCustomsAuthoredVegetationInstances,
} from '../src/customs-authored-vegetation.js';
import {
  assertCustomsAuthoredVegetationRouteTotals,
  routeCustomsAuthoredVegetationRollout,
} from '../src/customs-authored-vegetation-rollout.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const DERIVED = join(REPO, '.local-game-derived', 'customs');
const PACK = join(REPO, '.local-candidates', 'vegetation-full-v2', 'pack-index.json');
const PRESENT = existsSync(join(DERIVED, 'manifest.json')) && existsSync(PACK);
const SKIP = PRESENT ? false : 'the local Customs package or the authored vegetation pack is not present';

const SOURCE_PLACEMENTS = 8805;
const FAMILIES = 31;

const json = (path) => JSON.parse(readFileSync(path, 'utf8'));

/**
 * Rebuild the exact render plan from the package on disk.
 *
 * Mirrors `loadCustomsLocalVegetation`'s instancing index — manifest tile order, `flatIndex` as
 * the running ordinal, prototype identity joined per tile — without standing up a loopback HTTP
 * server for a headless assertion. `classifyCustomsVegetationPrototype` is imported rather than
 * re-implemented so this cannot drift from the shipped classifier.
 */
function localRenderPlan() {
  const manifest = json(join(DERIVED, 'manifest.json'));
  const instances = [];
  for (const tile of manifest.tiles) {
    const payload = json(join(DERIVED, `${tile.id}-vegetation.json`));
    const prototypesById = new Map(payload.prototypes.map((entry) => [entry.id, entry]));
    for (const instance of [...payload.instances].sort((a, b) => a.index - b.index)) {
      const prototype = prototypesById.get(instance.prototypeId);
      assert.ok(prototype, `tile ${payload.tileId} instance references unknown prototype`);
      instances.push({
        flatIndex: instances.length,
        tileId: payload.tileId,
        prototypeId: instance.prototypeId,
        prototypeName: prototype.name,
        classification: classifyCustomsVegetationPrototype(prototype.name),
        worldPosition: instance.worldPosition,
        widthScale: instance.widthScale ?? 1,
        heightScale: instance.heightScale ?? 1,
        rotationRadians: instance.rotationRadians ?? 0,
        color: instance.color ?? null,
      });
    }
  }
  return buildCustomsLocalVegetationRenderPlan(
    { instances },
    { scope: null, reliefOriginYM: manifest.reliefOriginYM ?? 0 },
  );
}

function frustumFor(position, target, { fovy = 22, aspect = 1400 / 900 } = {}) {
  const camera = new THREE.PerspectiveCamera(fovy, aspect, 0.25, 6000);
  camera.up.set(0, 0, 1);
  camera.position.set(...position);
  camera.lookAt(new THREE.Vector3(...target));
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
}

test('the hybrid vegetation router is complementary, deterministic and total', { skip: SKIP }, () => {
  const plan = localRenderPlan();
  assert.equal(plan.sourceCount, SOURCE_PLACEMENTS);
  assert.equal(plan.renderedCount + plan.culledCount, plan.sourceCount);

  const catalog = normalizeCustomsAuthoredVegetationCatalog(json(PACK));
  assert.equal(catalog.currentFactoryCoverage.complete, true, 'the pack is the complete 31/58 set');

  const admitted = catalog.assets.map((entry) => entry.assetId);
  const route = routeCustomsAuthoredVegetationRollout({ plan, catalog, admittedAssetIds: admitted });
  const totals = assertCustomsAuthoredVegetationRouteTotals(route);
  assert.deepEqual(totals, {
    authored: SOURCE_PLACEMENTS,
    procedural: 0,
    rendered: SOURCE_PLACEMENTS,
    culled: 0,
    source: SOURCE_PLACEMENTS,
  }, 'all 31 families admitted leaves the procedural half empty');

  // Routing the same plan twice must produce the identical partition — no Map iteration order or
  // floating-point path can make a placement change sides between runs.
  const again = routeCustomsAuthoredVegetationRollout({ plan, catalog, admittedAssetIds: admitted });
  assert.deepEqual(
    again.authored.placements.map((entry) => entry.flatIndex),
    route.authored.placements.map((entry) => entry.flatIndex),
  );

  // A partial admission still has to be total: hold back the largest family and re-check.
  const partial = routeCustomsAuthoredVegetationRollout({
    plan,
    catalog,
    admittedAssetIds: admitted.filter((assetId) => assetId !== 'customs.vegetation.pine01'),
  });
  const partialTotals = assertCustomsAuthoredVegetationRouteTotals(partial);
  assert.ok(partialTotals.procedural > 0, 'the withheld family falls back to the procedural half');
  assert.equal(partialTotals.authored + partialTotals.procedural, SOURCE_PLACEMENTS);
  assert.equal(
    new Set([
      ...partial.authored.placements.map((entry) => entry.flatIndex),
      ...partial.procedural.placements.map((entry) => entry.flatIndex),
    ]).size,
    SOURCE_PLACEMENTS,
    'the two halves share the flatIndex space disjointly',
  );
  // The procedural half is emitted with every classification key present, so the procedural
  // builder never has to guess whether a missing key means zero.
  assert.deepEqual(
    Object.keys(partial.procedural.groups).sort(),
    ['deciduous', 'ground-plant', 'pine', 'shrub', 'stump'],
  );
});

test('every camera pose stays under the structural (family, LOD) batch ceiling', { skip: SKIP }, () => {
  const plan = localRenderPlan();
  const catalog = normalizeCustomsAuthoredVegetationCatalog(json(PACK));
  const route = routeCustomsAuthoredVegetationRollout({
    plan,
    catalog,
    admittedAssetIds: catalog.assets.map((entry) => entry.assetId),
  });
  const compiled = planCustomsAuthoredVegetationInstances(route.authored, catalog);
  assert.equal(compiled.renderedCount, SOURCE_PLACEMENTS);
  assert.equal(compiled.assetGroups.length, FAMILIES);

  const ceiling = compiled.assetGroups.length * 3;
  assert.equal(ceiling, CUSTOMS_AUTHORED_VEGETATION_BUCKET_CEILING);
  assert.equal(ceiling, 93);

  const xs = compiled.placements.map((entry) => entry.presentationPosition[0]);
  const ys = compiled.placements.map((entry) => entry.presentationPosition[1]);
  const zs = compiled.placements.map((entry) => entry.presentationPosition[2]);
  const minX = Math.min(...xs); const maxX = Math.max(...xs);
  const minY = Math.min(...ys); const maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2; const cy = (minY + maxY) / 2;
  const cz = (Math.min(...zs) + Math.max(...zs)) / 2;

  const poses = [
    ['A orbit default', [cx, cy - 1150, cz + 960], [cx, cy, cz]],
    ['B orbit mid', [cx, cy - 460, cz + 385], [cx, cy, cz]],
    ['C orbit close', [cx, cy - 192, cz + 160], [cx, cy, cz]],
    ['D player eye, open field', [cx, cy, cz + 1.7], [cx + 300, cy + 60, cz + 1.7]],
    ['E player eye, woods', [minX + 200, minY + 150, cz + 1.7], [minX + 500, minY + 250, cz + 1.7]],
    ['F top-down', [cx, cy, cz + 1900], [cx, cy, cz]],
    ['G corner, outward', [minX - 20, minY - 20, cz + 3], [minX - 320, minY - 320, cz + 3]],
  ];

  let previousLods = null;
  for (const [name, position, target] of poses) {
    const partition = partitionCustomsAuthoredVegetationByLod(compiled, {
      cameraWorldPosition: position,
      previousLods,
      frustum: frustumFor(position, target),
    });
    assert.ok(
      partition.bucketCount <= ceiling,
      `${name}: ${partition.bucketCount} batches exceeds the ${ceiling} structural ceiling`,
    );
    assert.equal(
      partition.visibleInstances + partition.frustumCulledInstances,
      SOURCE_PLACEMENTS,
      `${name}: a placement was lost or duplicated`,
    );
    const keys = partition.buckets.map((bucket) => bucket.key);
    assert.equal(new Set(keys).size, keys.length, `${name}: a (family, LOD) key appeared twice`);
    const seen = new Set();
    for (const bucket of partition.buckets) {
      for (const index of bucket.indices) {
        assert.equal(seen.has(index), false, `${name}: placement ${index} is in two batches`);
        seen.add(index);
      }
    }
    assert.equal(seen.size, partition.visibleInstances);
    assert.equal(partition.lods.length, SOURCE_PLACEMENTS);
    previousLods = partition.lods;
  }

  // The ceiling is structural: with no frustum at all, every family can be live at most once per
  // LOD tier, and the whole map at one distance band collapses to one batch per family.
  const admitAll = partitionCustomsAuthoredVegetationByLod(compiled, {
    cameraWorldPosition: [cx, cy - 1150, cz + 960],
    frustum: null,
  });
  assert.equal(admitAll.visibleInstances, SOURCE_PLACEMENTS);
  assert.equal(admitAll.frustumCulledInstances, 0);
  assert.ok(admitAll.bucketCount <= ceiling);
  assert.equal(admitAll.bucketCount, FAMILIES, 'the default orbit distance puts every family in one LOD band');
});
