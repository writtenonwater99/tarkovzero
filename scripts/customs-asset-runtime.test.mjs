import assert from 'node:assert/strict';
import test from 'node:test';

import {
  emptyCustomsAssetManifest,
  normalizeCustomsAssetManifest,
} from '../src/customs-asset-manifest.js';
import {
  CUSTOMS_ASSET_HYSTERESIS,
  cellDistanceM,
  createCustomsAssetAttachmentLedger,
  createCustomsAssetRegistry,
  customsAssetPlanChanged,
  diffCustomsAssetPlan,
  planCustomsAssetFrame,
  resolveProceduralSuppression,
  customsAssetAxisMatrix,
  customsAssetLinearMatrix,
  customsAssetRotationMatrix,
  customsAssetWorldPosition,
  selectLodLevel,
} from '../src/customs-asset-runtime.js';

const hex = (seed) => `sha256:${String(seed).padStart(2, '0').repeat(32)}`;

const SOURCE = {
  id: 'authored',
  kind: 'authored',
  title: 'TarkovZero authored geometry',
  holder: 'TarkovZero',
  license: 'CC0-1.0',
  licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
  retrievedAt: '2026-08-30',
};

function lods(prefix, chain) {
  return chain.map(([bytes, triangles, maxDistanceM], level) => ({
    level,
    url: `${prefix}/lod${level}.glb`,
    sha256: hex(`${prefix.length}${level}`),
    bytes,
    triangles,
    maxDistanceM,
  }));
}

function assetOf(id, chain) {
  return {
    id,
    kind: 'prototype',
    name: id,
    sourceId: 'authored',
    gltf: { unit: 'metre', upAxis: '+y', forwardAxis: '+z', pivot: 'base-center' },
    bounds: { min: { x: -2, y: 0, z: -2 }, max: { x: 2, y: 4, z: 2 } },
    materialIds: [],
    masks: { floors: ['ground'], interior: false },
    proxies: {
      picking: { shape: 'box' },
      shadow: { mode: 'both' },
      collision: { shape: 'box' },
    },
    lods: lods(id, chain),
  };
}

/**
 * Two cells 200 m apart on the x axis, each with one instance. Cell A carries the instance that
 * replaces a procedural building; cell B's instance replaces nothing.
 */
function scene({
  chain = [[900_000, 90_000, 60], [200_000, 20_000, 150], [60_000, 5_000, 400]],
  shedBPositionX = 10,
} = {}) {
  const base = emptyCustomsAssetManifest({
    scope: { id: 'test-scope', center: { x: 0, z: 0 }, widthM: 1200, depthM: 1200 },
    budgets: {
      totalBytes: 32 * 1024 * 1024,
      totalTriangles: 4_000_000,
      perCellBytes: 8 * 1024 * 1024,
      perCellTriangles: 900_000,
      maxConcurrentLoads: 3,
      drawDistanceM: 300,
    },
  });
  return normalizeCustomsAssetManifest({
    ...base,
    evidence: { sources: [SOURCE], observations: [] },
    delivery: {
      baseUrl: 'assets/3d/customs/authored/',
      materials: [],
      assets: [assetOf('shed', chain), assetOf('tower', chain)],
      instances: [
        {
          id: 'shed-a',
          assetId: 'shed',
          cellId: 'cell-a',
          stableId: 'customs.authored.shed.a',
          featureId: 'customs.building.shed',
          transform: { position: { x: 0, y: 0, z: 0 }, rotation: { yawDeg: 0 } },
          floor: 'ground',
        },
        {
          id: 'shed-b',
          assetId: 'shed',
          cellId: 'cell-a',
          stableId: 'customs.authored.shed.b',
          featureId: 'customs.building.shed',
          transform: { position: { x: shedBPositionX, y: 0, z: 0 }, rotation: { yawDeg: 0 } },
          floor: 'ground',
        },
        {
          id: 'tower-a',
          assetId: 'tower',
          cellId: 'cell-b',
          stableId: 'customs.authored.tower.a',
          transform: { position: { x: 400, y: 0, z: 0 }, rotation: { yawDeg: 0 } },
          floor: 'ground',
        },
      ],
      cells: [
        {
          id: 'cell-a',
          center: { x: 0, z: 0 },
          widthM: 100,
          depthM: 100,
          minY: -50,
          maxY: 50,
          instanceIds: ['shed-a', 'shed-b'],
          loadPriority: 5,
        },
        {
          id: 'cell-b',
          center: { x: 400, z: 0 },
          widthM: 100,
          depthM: 100,
          minY: -50,
          maxY: 50,
          instanceIds: ['tower-a'],
        },
      ],
      replacements: [{
        id: 'retire-shed',
        target: { kind: 'building', featureId: 'customs.building.shed' },
        instanceIds: ['shed-a', 'shed-b'],
        policy: 'hide-mesh',
      }],
    },
  });
}

const registryOf = (...args) => createCustomsAssetRegistry(scene(...args));

// ---------------------------------------------------------------------------
// registry

test('an empty manifest yields an empty registry that reports the procedural fallback', () => {
  const registry = createCustomsAssetRegistry(normalizeCustomsAssetManifest(emptyCustomsAssetManifest()));
  assert.equal(registry.isEmpty, true);
  assert.equal(registry.cells.length, 0);
  const plan = planCustomsAssetFrame({ registry, camera: { x: 0, z: 0 } });
  assert.equal(plan.proceduralFallback, true);
  assert.deepEqual(plan.instances, []);
  assert.deepEqual(plan.requests, []);
  assert.deepEqual(resolveProceduralSuppression(registry, createCustomsAssetAttachmentLedger()).suppressedFeatureIds, []);
});

test('the registry indexes prototypes, cells and replacements', () => {
  const registry = registryOf();
  assert.equal(registry.isEmpty, false);
  assert.equal(registry.instancesByAsset.get('shed').length, 2);
  assert.equal(registry.instancesByCell.get('cell-a').length, 2);
  assert.equal(registry.replacementByFeatureId.get('customs.building.shed').id, 'retire-shed');
  assert.equal(registry.replacementByInstanceId.get('shed-b')[0].id, 'retire-shed');
  assert.deepEqual(registry.replacedFeatureIds, ['customs.building.shed']);
});

// ---------------------------------------------------------------------------
// distance and LOD

test('cellDistanceM is zero inside the footprint and planar outside it', () => {
  const [cellA] = registryOf().cells;
  assert.equal(cellDistanceM(cellA, 0, 0), 0);
  assert.equal(cellDistanceM(cellA, 50, 0), 0, 'the boundary counts as inside');
  assert.equal(cellDistanceM(cellA, 150, 0), 100);
  assert.equal(cellDistanceM(cellA, 0, -150), 100);
  assert.equal(Math.round(cellDistanceM(cellA, 150, 150)), 141);
});

test('selectLodLevel without history takes the plain nearest-covering level', () => {
  const chain = lods('shed', [[9, 9, 60], [8, 8, 150], [7, 7, 400]]);
  assert.equal(selectLodLevel(chain, 0), 0);
  assert.equal(selectLodLevel(chain, 60), 0, 'the boundary still belongs to the finer level');
  assert.equal(selectLodLevel(chain, 61), 1);
  assert.equal(selectLodLevel(chain, 150), 1);
  assert.equal(selectLodLevel(chain, 151), 2);
  assert.equal(selectLodLevel(chain, 100_000), 2, 'the coarsest level is the floor, not a cutoff');
});

test('LOD hysteresis requires an overshoot in both directions', () => {
  const chain = lods('shed', [[9, 9, 100], [8, 8, 200], [7, 7, 400]]);
  const h = CUSTOMS_ASSET_HYSTERESIS;
  // Sitting just past the 100 m boundary is not enough to drop detail while we are at LOD0.
  assert.equal(selectLodLevel(chain, 105, 0, h), 0);
  assert.equal(selectLodLevel(chain, 100 * (1 + h), 0, h), 0, 'exactly at the band edge holds');
  assert.equal(selectLodLevel(chain, 100 * (1 + h) + 0.001, 0, h), 1);
  // Coming back in, the same band protects the other direction.
  assert.equal(selectLodLevel(chain, 95, 1, h), 1);
  assert.equal(selectLodLevel(chain, 100 * (1 - h), 1, h), 0);
  assert.equal(selectLodLevel(chain, 100 * (1 - h) + 0.001, 1, h), 1);
});

test('a camera dithering across a boundary never changes LOD', () => {
  const chain = lods('shed', [[9, 9, 100], [8, 8, 200]]);
  let level = 0;
  // 3% either side of the boundary, forty times: the classic trackpad wobble.
  for (let i = 0; i < 40; i++) {
    level = selectLodLevel(chain, i % 2 === 0 ? 97 : 103, level, CUSTOMS_ASSET_HYSTERESIS);
    assert.equal(level, 0, `flipped on iteration ${i}`);
  }
});

test('a long jump walks LOD one confirmed step at a time and still lands correctly', () => {
  const chain = lods('shed', [[9, 9, 100], [8, 8, 200], [7, 7, 400]]);
  // Far outside every band: each boundary is overshot, so the walk reaches the coarsest level.
  assert.equal(selectLodLevel(chain, 5000, 0, CUSTOMS_ASSET_HYSTERESIS), 2);
  assert.equal(selectLodLevel(chain, 0, 2, CUSTOMS_ASSET_HYSTERESIS), 0);
  // Just past the second boundary but inside the third's band: stop at 1, not 2.
  assert.equal(selectLodLevel(chain, 210, 0, CUSTOMS_ASSET_HYSTERESIS), 1);
});

test('selectLodLevel clamps a stale previous level from a shortened chain', () => {
  const chain = lods('shed', [[9, 9, 100]]);
  assert.equal(selectLodLevel(chain, 50, 7), 0);
  assert.equal(selectLodLevel(chain, 50, -3), 0);
});

// ---------------------------------------------------------------------------
// planning

test('the plan selects near cells, sorts by distance and reports cost', () => {
  const registry = registryOf();
  const plan = planCustomsAssetFrame({ registry, camera: { x: 0, z: 0 } });
  assert.deepEqual(plan.visibleCellIds, ['cell-a'], 'cell-b is 350 m out, past the 300 m draw distance');
  assert.equal(plan.instances.length, 2);
  assert.equal(plan.cells[0].id, 'cell-a');
  assert.equal(plan.cells[0].distanceM, 0);
  // Both instances share one prototype at one LOD, so there is exactly one fetch.
  assert.equal(plan.requests.length, 1);
  assert.deepEqual(plan.requests[0].instanceIds, ['shed-a', 'shed-b']);
  assert.equal(plan.cost.bytes, 900_000);
  assert.equal(plan.cost.triangles, 180_000);
  assert.equal(plan.cost.withinBudget, true);
  assert.equal(plan.maxConcurrentLoads, 3);
});

test('the plan carries picking, shadow, floor and interior policy per instance', () => {
  const plan = planCustomsAssetFrame({ registry: registryOf(), camera: { x: 0, z: 0 } });
  const [first] = plan.instances;
  assert.equal(first.stableId, 'customs.authored.shed.a');
  assert.equal(first.floor, 'ground');
  assert.equal(first.interior, false);
  assert.equal(first.pickable, true);
  assert.deepEqual(first.picking, { shape: 'box', lodLevel: null, inflateM: 0 });
  assert.deepEqual(first.shadow, { mode: 'both', lodLevel: null });
  assert.deepEqual(first.collision, { shape: 'box' });
  assert.deepEqual(first.gltf, { unit: 'metre', upAxis: '+y', forwardAxis: '+z', pivot: 'base-center' });
  assert.equal(first.transform.position.x, 0);
});

test('the first plan applies the plain draw-distance rule before visibility hysteresis', () => {
  const plan = planCustomsAssetFrame({
    registry: registryOf(),
    // cell-b starts at x=350, so its footprint is exactly 300 m away.
    camera: { x: 50, z: 0 },
    drawDistanceM: 300,
  });
  const cellB = plan.cells.find((cell) => cell.id === 'cell-b');
  assert.equal(cellB.distanceM, 300);
  assert.equal(cellB.visible, true, 'the draw-distance boundary is visible on an initial plan');
});

test('LOD distance is measured to each instance pivot, not its cell footprint', () => {
  const registry = registryOf({
    chain: [[900_000, 90_000, 20], [200_000, 20_000, 100], [60_000, 5_000, 400]],
    shedBPositionX: 40,
  });
  const plan = planCustomsAssetFrame({ registry, camera: { x: 0, z: 0 } });
  const shedA = plan.instances.find((entry) => entry.instanceId === 'shed-a');
  const shedB = plan.instances.find((entry) => entry.instanceId === 'shed-b');

  assert.equal(plan.cells.find((cell) => cell.id === 'cell-a').distanceM, 0);
  assert.deepEqual(
    [shedA.distanceM, shedA.lodLevel, shedB.distanceM, shedB.lodLevel],
    [0, 0, 40, 1],
  );
  assert.deepEqual(
    plan.requests.map((request) => [request.url, request.distanceM, request.instanceIds]),
    [
      ['shed/lod0.glb', 0, ['shed-a']],
      ['shed/lod1.glb', 40, ['shed-b']],
    ],
  );
});

test('cell visibility has hysteresis too', () => {
  const registry = registryOf();
  const h = CUSTOMS_ASSET_HYSTERESIS;
  // cell-b spans x in [350, 450]. From x = 350 - d the distance to it is d.
  const at = (distance, previous) => planCustomsAssetFrame({
    registry,
    camera: { x: 350 - distance, z: 0 },
    previous,
    drawDistanceM: 300,
  });
  const outside = at(400, null);
  assert.ok(!outside.visibleCellIds.includes('cell-b'));
  // Inside the band and previously hidden: stays hidden.
  const band = at(300 * (1 + h) - 1, outside);
  assert.ok(!band.visibleCellIds.includes('cell-b'), 'must not appear while inside the band');
  const inside = at(200, band);
  assert.ok(inside.visibleCellIds.includes('cell-b'));
  // Back into the band from visible: stays visible.
  const bandAgain = at(300 * (1 + h) - 1, inside);
  assert.ok(bandAgain.visibleCellIds.includes('cell-b'), 'must not disappear while inside the band');
  const gone = at(400, bandAgain);
  assert.ok(!gone.visibleCellIds.includes('cell-b'));
});

test('maxCells keeps the nearest cells and drops the rest', () => {
  const registry = registryOf();
  const plan = planCustomsAssetFrame({
    registry,
    camera: { x: 200, z: 0 },
    drawDistanceM: 1000,
    maxCells: 1,
  });
  assert.deepEqual(plan.visibleCellIds, ['cell-a'], 'cell-a is 150 m out, cell-b 150 m — priority breaks the tie');
});

test('planning refuses a camera that is not a finite point', () => {
  const registry = registryOf();
  for (const camera of [undefined, {}, { x: 0 }, { x: Number.NaN, z: 0 }, { x: 0, z: Infinity }]) {
    assert.throws(() => planCustomsAssetFrame({ registry, camera }), /finite camera/);
  }
  assert.throws(() => planCustomsAssetFrame({ camera: { x: 0, z: 0 } }), /requires a registry/);
});

test('a plan reports each instance its ledger state', () => {
  const registry = registryOf();
  const ledger = createCustomsAssetAttachmentLedger();
  ledger.markAttached('shed-a');
  const plan = planCustomsAssetFrame({ registry, camera: { x: 0, z: 0 }, ledger });
  assert.equal(plan.instances.find((entry) => entry.instanceId === 'shed-a').state, 'attached');
  assert.equal(plan.instances.find((entry) => entry.instanceId === 'shed-b').state, 'idle');
  assert.equal(plan.ledgerRevision, ledger.revision);
});

test('customsAssetPlanChanged is false for an unchanged camera and true across an LOD switch', () => {
  const registry = registryOf();
  const a = planCustomsAssetFrame({ registry, camera: { x: 0, z: 0 } });
  const b = planCustomsAssetFrame({ registry, camera: { x: 1, z: 1 }, previous: a });
  assert.equal(customsAssetPlanChanged(a, b), false, 'a metre of pan is not a scene change');
  assert.equal(customsAssetPlanChanged(null, a), true);
  const far = planCustomsAssetFrame({ registry, camera: { x: 0, z: 200 }, previous: b });
  assert.equal(customsAssetPlanChanged(b, far), true, 'crossing an LOD boundary is a change');
  assert.equal(far.instances[0].lodLevel, 2);
});

test('diffCustomsAssetPlan separates entering, re-LODing and leaving instances', () => {
  const registry = registryOf();
  const near = planCustomsAssetFrame({ registry, camera: { x: 0, z: 0 } });
  assert.deepEqual(diffCustomsAssetPlan(null, near).enter.map((entry) => entry.instanceId), ['shed-a', 'shed-b']);

  const mid = planCustomsAssetFrame({ registry, camera: { x: 0, z: 200 }, previous: near });
  const relod = diffCustomsAssetPlan(near, mid);
  assert.deepEqual(relod.enter, []);
  assert.deepEqual(relod.relod.map((entry) => entry.instanceId), ['shed-a', 'shed-b']);
  assert.deepEqual(relod.leave, []);

  const away = planCustomsAssetFrame({ registry, camera: { x: 0, z: 5000 }, previous: mid });
  const left = diffCustomsAssetPlan(mid, away);
  assert.deepEqual(left.leave.map((entry) => entry.instanceId), ['shed-a', 'shed-b']);
  assert.deepEqual(away.visibleCellIds, []);
});

// ---------------------------------------------------------------------------
// the suppression gate — the point of the whole module

test('a procedural feature is retained until every replacing instance is attached', () => {
  const registry = registryOf();
  const ledger = createCustomsAssetAttachmentLedger();

  let state = resolveProceduralSuppression(registry, ledger);
  assert.deepEqual(state.suppressedFeatureIds, []);
  assert.deepEqual(state.retainedFeatureIds, ['customs.building.shed']);
  assert.match(state.reasons.get('customs.building.shed'), /not attached yet/);

  ledger.markLoading('shed-a');
  ledger.markLoading('shed-b');
  assert.deepEqual(resolveProceduralSuppression(registry, ledger).suppressedFeatureIds, []);

  // One of two attached is still not enough: the other half of the building is missing.
  ledger.markAttached('shed-a');
  state = resolveProceduralSuppression(registry, ledger);
  assert.deepEqual(state.suppressedFeatureIds, []);
  assert.deepEqual(state.retained[0].pending, ['shed-b']);

  ledger.markAttached('shed-b');
  state = resolveProceduralSuppression(registry, ledger);
  assert.deepEqual(state.suppressedFeatureIds, ['customs.building.shed']);
  assert.deepEqual(state.retainedFeatureIds, []);
  assert.equal(state.suppressed[0].policy, 'hide-mesh');
  assert.equal(state.suppressed[0].kind, 'building');
});

test('a failed asset keeps its proxy and says so', () => {
  const registry = registryOf();
  const ledger = createCustomsAssetAttachmentLedger();
  ledger.markAttached('shed-a');
  ledger.markFailed('shed-b', new Error('HTTP 404'));

  const state = resolveProceduralSuppression(registry, ledger);
  assert.deepEqual(state.suppressedFeatureIds, [], 'a half-loaded building must not hide the proxy');
  assert.deepEqual(state.retained[0].failed, ['shed-b']);
  assert.match(state.reasons.get('customs.building.shed'), /failed to load/);
  assert.equal(ledger.errorOf('shed-b'), 'HTTP 404');
  assert.deepEqual(ledger.failedIds(), ['shed-b']);
});

test('detaching an instance walks suppression back', () => {
  const registry = registryOf();
  const ledger = createCustomsAssetAttachmentLedger();
  ledger.markAttached('shed-a');
  ledger.markAttached('shed-b');
  assert.deepEqual(resolveProceduralSuppression(registry, ledger).suppressedFeatureIds, ['customs.building.shed']);

  ledger.markDetached('shed-b');
  assert.deepEqual(
    resolveProceduralSuppression(registry, ledger).suppressedFeatureIds,
    [],
    'unloading half the replacement must bring the procedural building back',
  );
});

test('resetting the ledger un-suppresses everything and bumps the revision', () => {
  const registry = registryOf();
  const ledger = createCustomsAssetAttachmentLedger();
  ledger.markAttached('shed-a');
  ledger.markAttached('shed-b');
  const before = ledger.revision;
  assert.equal(ledger.reset(), true);
  assert.ok(ledger.revision > before);
  assert.deepEqual(ledger.attachedIds(), []);
  assert.deepEqual(resolveProceduralSuppression(registry, ledger).suppressedFeatureIds, []);
  assert.equal(ledger.reset(), false, 'a second reset is a no-op and must not churn the revision');
});

test('the ledger only bumps its revision on a real state change', () => {
  const ledger = createCustomsAssetAttachmentLedger();
  assert.equal(ledger.stateOf('nobody'), 'idle');
  assert.equal(ledger.markAttached('shed-a'), true);
  const revision = ledger.revision;
  assert.equal(ledger.markAttached('shed-a'), false);
  assert.equal(ledger.revision, revision);
  // A transition that does change state still bumps it, so plan comparison sees the edge.
  assert.equal(ledger.markFailed('shed-a', new Error('gone')), true);
  assert.ok(ledger.revision > revision);
});

test('an unknown attachment state is rejected rather than stored', () => {
  const ledger = createCustomsAssetAttachmentLedger();
  const registry = registryOf();
  // The ledger's public surface only exposes the four legal transitions; reaching past them
  // must not be able to invent a fifth state that resolveProceduralSuppression mis-reads.
  assert.deepEqual(Object.keys(ledger).filter((key) => key.startsWith('mark')).sort(), [
    'markAttached', 'markDetached', 'markFailed', 'markLoading',
  ]);
  ledger.markLoading('shed-a');
  assert.equal(resolveProceduralSuppression(registry, ledger).retained.length, 1);
});

// ---------------------------------------------------------------------------
// canonical transform maths

const round = (values, digits = 9) => values.map((value) => Number(value.toFixed(digits)) + 0);

function determinant(m) {
  const rows = [m.slice(0, 3), m.slice(3, 6), m.slice(6, 9)];
  return rows[0][0] * (rows[1][1] * rows[2][2] - rows[1][2] * rows[2][1])
    - rows[0][1] * (rows[1][0] * rows[2][2] - rows[1][2] * rows[2][0])
    + rows[0][2] * (rows[1][0] * rows[2][1] - rows[1][1] * rows[2][0]);
}

function isOrthogonal(m, expectedDeterminant) {
  const rows = [m.slice(0, 3), m.slice(3, 6), m.slice(6, 9)];
  for (let i = 0; i < 3; i++) {
    const norm = Math.hypot(...rows[i]);
    assert.ok(Math.abs(norm - 1) < 1e-9, `row ${i} is not unit length (${norm})`);
    for (let j = i + 1; j < 3; j++) {
      const dot = rows[i].reduce((sum, value, k) => sum + value * rows[j][k], 0);
      assert.ok(Math.abs(dot) < 1e-9, `rows ${i} and ${j} are not orthogonal (${dot})`);
    }
  }
  const det = determinant(m);
  assert.ok(
    Math.abs(det - expectedDeterminant) < 1e-9,
    `determinant ${det} did not preserve the declared ${expectedDeterminant} handedness`,
  );
}

const GLTF_ZUP = { unit: 'metre', upAxis: '+z', forwardAxis: '+y', pivot: 'origin' };
const GLTF_YUP = { unit: 'metre', upAxis: '+y', forwardAxis: '+z', pivot: 'origin' };
const noRotation = { yawDeg: 0, pitchDeg: 0, rollDeg: 0 };

const apply3 = (flat, vector) => [0, 1, 2].map((row) => (
  flat[row * 3] * vector[0] + flat[row * 3 + 1] * vector[1] + flat[row * 3 + 2] * vector[2]
));

test('customsAssetAxisMatrix maps declared up to EFT +Y and forward to EFT +Z', () => {
  for (const gltf of [GLTF_ZUP, GLTF_YUP, { ...GLTF_YUP, upAxis: '-x', forwardAxis: '+z' }]) {
    const rows = customsAssetAxisMatrix(gltf);
    isOrthogonal(rows.flat(), 1);
    const apply = (m, v) => m.map((row) => row.reduce((sum, value, k) => sum + value * v[k], 0));
    const axis = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] };
    assert.deepEqual(round(apply(rows, axis[gltf.upAxis])), [0, 1, 0]);
    assert.deepEqual(round(apply(rows, axis[gltf.forwardAxis])), [0, 0, 1]);
  }
});

test('zero-yaw assets preserve the exact EFT handedness and face runtime -Y', () => {
  const yUp = customsAssetRotationMatrix(GLTF_YUP, noRotation);
  assert.deepEqual(round(yUp), [-1, 0, 0, 0, 0, -1, 0, 1, 0]);
  assert.deepEqual(round(apply3(yUp, [1, 0, 0])), [-1, 0, 0], 'EFT right must map to runtime -X');
  assert.deepEqual(round(apply3(yUp, [0, 1, 0])), [0, 0, 1], 'EFT up must map to runtime +Z');
  assert.deepEqual(round(apply3(yUp, [0, 0, 1])), [0, -1, 0], 'EFT forward must map to runtime -Y');
  isOrthogonal(yUp, -1);

  const zUp = customsAssetRotationMatrix(GLTF_ZUP, noRotation);
  assert.deepEqual(round(zUp), [1, 0, 0, 0, -1, 0, 0, 0, 1]);
  assert.deepEqual(round(apply3(zUp, [0, 1, 0])), [0, -1, 0]);
  assert.deepEqual(round(apply3(zUp, [0, 0, 1])), [0, 0, 1]);
  isOrthogonal(zUp, -1);
});

test('EFT +90 yaw turns source forward toward +X before the runtime frame mapping', () => {
  const yUp = customsAssetRotationMatrix(GLTF_YUP, { ...noRotation, yawDeg: 90 });
  assert.deepEqual(round(yUp), [0, 0, -1, 1, 0, 0, 0, 1, 0]);
  assert.deepEqual(round(apply3(yUp, [0, 0, 1])), [-1, 0, 0]);
  const zUp = customsAssetRotationMatrix(GLTF_ZUP, { ...noRotation, yawDeg: 90 });
  assert.deepEqual(round(zUp), [0, -1, 0, -1, 0, 0, 0, 0, 1]);
  assert.deepEqual(round(apply3(zUp, [0, 1, 0])), [-1, 0, 0]);
});

test('every rotation the schema permits preserves the one exact handedness flip', () => {
  for (const yawDeg of [-360, -137, 0, 45, 360]) {
    for (const pitchDeg of [-90, 0, 12]) {
      for (const rollDeg of [-45, 0, 90]) {
        for (const gltf of [GLTF_ZUP, GLTF_YUP]) {
          isOrthogonal(customsAssetRotationMatrix(gltf, { yawDeg, pitchDeg, rollDeg }), -1);
        }
      }
    }
  }
});

test('non-uniform positive scale is composed in asset-local axes before the EFT transform', () => {
  const localScale = { x: 2, y: 3, z: 5 };
  assert.deepEqual(
    round(customsAssetLinearMatrix(GLTF_YUP, noRotation, localScale)),
    [-2, 0, 0, 0, 0, -5, 0, 3, 0],
  );
  assert.deepEqual(
    round(customsAssetLinearMatrix(GLTF_ZUP, noRotation, localScale)),
    [2, 0, 0, 0, -3, 0, 0, 0, 5],
  );
  assert.ok(determinant(customsAssetLinearMatrix(GLTF_YUP, noRotation, localScale)) < 0);
});

test('customsAssetWorldPosition matches the renderer gameToWorld mapping', () => {
  assert.deepEqual(customsAssetWorldPosition({ x: 230, y: 4, z: -110 }), [-230, 110, 4]);
  assert.deepEqual(customsAssetWorldPosition({ x: 0, y: 0, z: 0 }), [-0, -0, 0]);
});

test('the authored floor-tag selector predicate is gone, but the manifest tag is not', async () => {
  // `customsAssetVisibleForFloor` existed only to map an instance's manifest `floor` tag onto the
  // renderer's all/0/1/2/3/U rail. The rail went out on 2026-09-02 (founder: "floor system fully
  // out the project") and the predicate went with it — asserted ABSENT, because a predicate left
  // behind unused is a hidden feature, not a removed one.
  const runtime = await import('../src/customs-asset-runtime.js');
  assert.equal(runtime.customsAssetVisibleForFloor, undefined);
  // The manifest SCHEMA keeps its floor tag: it is authoring metadata that says which storey a GLB
  // was authored for, it is validated against the asset's own `masks.floors`, and it is what a
  // future interior pass would key on. It is not a filter and nothing filters on it now.
  const manifest = await import('../src/customs-asset-manifest.js');
  assert.deepEqual(manifest.CUSTOMS_ASSET_ENUMS.floorTags,
    ['terrain', 'ground', 'floor-1', 'floor-2', 'floor-3', 'roof', 'underground']);
});
