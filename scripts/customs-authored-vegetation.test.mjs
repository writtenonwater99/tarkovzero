import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import {
  CustomsAuthoredVegetationContractError,
  CUSTOMS_AUTHORED_VEGETATION_CELL_SIZE_M,
  createCustomsAuthoredVegetationRuntime,
  customsAuthoredVegetationInstanceMatrix,
  customsAuthoredVegetationWorldMatrix,
  normalizeCustomsAuthoredVegetationCatalog,
  partitionCustomsAuthoredVegetationCells,
  planCustomsAuthoredVegetationInstances,
  probeCustomsAuthoredVegetationBinding,
  resolveCustomsAuthoredVegetationBinding,
  resolveCustomsAuthoredVegetationScale,
  selectCustomsAuthoredVegetationLod,
} from '../src/customs-authored-vegetation.js';

const HASH = `sha256:${'a'.repeat(64)}`;

function asset(assetId, prototypeName) {
  const fileStem = assetId.split('.').at(-1);
  return {
    assetId,
    prototypeName,
    collision: 'none',
    geometryEvidence: 'original approximation for test',
    gltf: { unit: 'metre', upAxis: '+y', forwardAxis: '+z', pivot: 'base-center' },
    lods: [0, 1, 2].map((lod) => ({
      lod,
      file: `assets/${fileStem}/${fileStem}-lod${lod}.glb`,
      bytes: 100 + lod,
      sha256: HASH,
      triangles: 12 - lod * 3,
    })),
  };
}

function pack() {
  return {
    map: 'customs',
    status: 'offline-production-draft-not-live',
    runtimeContract: {
      collision: 'none',
      exactScalarPlacement: true,
      livePromotion: false,
      geometry: 'original approximation; not source-game topology',
    },
    counts: { authoredAssets: 2, tilePrototypeBindings: 2, placements: 99 },
    authoredAssets: [
      asset('customs.vegetation.pine01', 'pine01'),
      asset('customs.vegetation.tree02', 'tree02'),
    ],
    prototypeBindings: [
      {
        tileId: 'terrain-000', prototypeId: 'terrain-000-vegetation-001',
        prototypeName: 'pine01', assetId: 'customs.vegetation.pine01',
      },
      {
        tileId: 'terrain-000', prototypeId: 'terrain-000-vegetation-000',
        prototypeName: 'tree02', assetId: 'customs.vegetation.tree02',
      },
    ],
    // The runtime catalog must not copy or consume this offline audit mirror.
    placements: Array.from({ length: 99 }, (_, placementOrdinal) => ({ placementOrdinal })),
  };
}

function placement({
  flatIndex,
  prototypeName = 'pine01',
  prototypeId = 'terrain-000-vegetation-001',
  classification = 'pine',
  presentationPosition = [0, 0, 0],
  yawRadians = 0,
  widthScale = 1,
  heightScale = 1,
  exactScalars = false,
  tint = { r: 0.9, g: 0.8, b: 0.7 },
} = {}) {
  const base = classification === 'pine'
    ? { width: 10.8 * 0.44, height: 10.8 }
    : { width: 8.1 * 0.58, height: 8.1 };
  return {
    flatIndex,
    tileId: 'terrain-000',
    prototypeId,
    prototypeName,
    classification,
    presentationPosition,
    yawRadians,
    dimensions: { width: base.width * widthScale, height: base.height * heightScale },
    ...(exactScalars ? { widthScale, heightScale } : {}),
    tint,
  };
}

function renderPlan(placements) {
  const groups = { pine: [], deciduous: [], shrub: [], stump: [], 'ground-plant': [] };
  for (const entry of placements) groups[entry.classification].push(entry);
  return {
    sourceCount: placements.length,
    renderedCount: placements.length,
    culledCount: 0,
    counts: Object.fromEntries(Object.entries(groups).map(([key, values]) => [key, values.length])),
    groups,
  };
}

function triangleGeometry() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
  ], 3));
  geometry.setIndex([0, 1, 2]);
  geometry.computeVertexNormals();
  return geometry;
}

function fakeGlb({ primitiveCount = 1, childX = 0, alphaModes = [] } = {}) {
  const scene = new THREE.Group();
  const child = new THREE.Group();
  child.name = 'authored-child';
  child.position.set(childX, 3, 4);
  scene.add(child);
  for (let index = 0; index < primitiveCount; index += 1) {
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff });
    material.name = `test-${alphaModes[index] ?? 'OPAQUE'}-${index}`;
    if (alphaModes[index] === 'MASK') material.alphaTest = 0.5;
    if (alphaModes[index] === 'BLEND') material.transparent = true;
    if (alphaModes[index] === 'HASH') material.alphaHash = true;
    const mesh = new THREE.Mesh(triangleGeometry(), material);
    mesh.name = `primitive-${index}`;
    mesh.position.z = index;
    child.add(mesh);
  }
  return { scene };
}

function vectorFromOrigin(matrix, point) {
  const origin = new THREE.Vector3(0, 0, 0).applyMatrix4(matrix);
  return point.clone().applyMatrix4(matrix).sub(origin);
}

function closeVector(actual, expected, epsilon = 1e-9) {
  assert.ok(actual.distanceTo(expected) <= epsilon, `${actual.toArray()} != ${expected.toArray()}`);
}

test('converts GLB +Y-up into the reflected Z-up world and maps positive Unity yaw negatively', () => {
  const basePlacement = {
    presentationPosition: [10, 20, 30],
    yawRadians: 0,
    scale: { widthScale: 1, heightScale: 1 },
  };
  const matrix = customsAuthoredVegetationWorldMatrix(basePlacement);
  closeVector(vectorFromOrigin(matrix, new THREE.Vector3(1, 0, 0)), new THREE.Vector3(-1, 0, 0));
  closeVector(vectorFromOrigin(matrix, new THREE.Vector3(0, 1, 0)), new THREE.Vector3(0, 0, 1));
  closeVector(vectorFromOrigin(matrix, new THREE.Vector3(0, 0, 1)), new THREE.Vector3(0, -1, 0));
  closeVector(new THREE.Vector3(0, 0, 0).applyMatrix4(matrix), new THREE.Vector3(10, 20, 30));

  const turned = customsAuthoredVegetationWorldMatrix({
    ...basePlacement,
    yawRadians: Math.PI / 2,
  });
  closeVector(
    vectorFromOrigin(turned, new THREE.Vector3(0, 0, 1)),
    new THREE.Vector3(-1, 0, 0),
  );

  const instanceMatrix = customsAuthoredVegetationInstanceMatrix(basePlacement);
  assert.ok(instanceMatrix.determinant() > 0, 'InstancedMesh must never receive a reflected matrix');
  assert.ok(matrix.determinant() < 0, 'the mathematical source-to-world matrix includes one reflection');
});

test('normalizes exact bindings without retaining the duplicate offline placement list', () => {
  const catalog = normalizeCustomsAuthoredVegetationCatalog(pack());
  assert.equal(catalog.assets.length, 2);
  assert.equal(catalog.bindings.length, 2);
  assert.equal('placements' in catalog, false);
  assert.equal(catalog.currentFactoryCoverage.complete, false);
  const resolved = resolveCustomsAuthoredVegetationBinding(catalog, placement({ flatIndex: 0 }));
  assert.equal(resolved.asset.assetId, 'customs.vegetation.pine01');

  assert.throws(
    () => resolveCustomsAuthoredVegetationBinding(catalog, placement({
      flatIndex: 0,
      prototypeName: 'pine02',
    })),
    (error) => error.code === 'ERR_CUSTOMS_VEGETATION_PROTOTYPE_IDENTITY_MISMATCH',
  );
});

test('non-throwing binding probe preserves exact identity without weakening the resolver', () => {
  const catalog = normalizeCustomsAuthoredVegetationCatalog(pack());
  const exactPlacement = placement({ flatIndex: 0 });
  const exact = probeCustomsAuthoredVegetationBinding(catalog, exactPlacement);
  assert.ok(Object.isFrozen(exact));
  assert.equal(exact.binding.prototypeId, exactPlacement.prototypeId);
  assert.equal(exact.asset.assetId, 'customs.vegetation.pine01');
  assert.equal(exact.nameMatches, true);

  const mismatch = { ...exactPlacement, prototypeName: 'pine02' };
  const mismatchedProbe = probeCustomsAuthoredVegetationBinding(catalog, mismatch);
  assert.ok(Object.isFrozen(mismatchedProbe));
  assert.equal(mismatchedProbe.binding.prototypeName, 'pine01');
  assert.equal(mismatchedProbe.nameMatches, false);
  assert.throws(
    () => resolveCustomsAuthoredVegetationBinding(catalog, mismatch),
    (error) => error.code === 'ERR_CUSTOMS_VEGETATION_PROTOTYPE_IDENTITY_MISMATCH',
  );

  assert.equal(probeCustomsAuthoredVegetationBinding(catalog, {
    ...exactPlacement,
    prototypeId: 'terrain-000-vegetation-missing',
  }), null);
  assert.equal(probeCustomsAuthoredVegetationBinding(catalog, null), null);
});

test('propagates explicit scale and losslessly recovers scale from the existing plan dimensions', () => {
  const fromEnvelope = resolveCustomsAuthoredVegetationScale(placement({
    flatIndex: 0,
    widthScale: 1.25,
    heightScale: 0.8,
  }));
  assert.equal(fromEnvelope.widthScale, 1.25);
  assert.equal(fromEnvelope.heightScale, 0.8);
  assert.equal(fromEnvelope.source, 'exact-plan-envelope-ratio');

  const explicit = resolveCustomsAuthoredVegetationScale(placement({
    flatIndex: 0,
    widthScale: 1.25,
    heightScale: 0.8,
    exactScalars: true,
  }));
  assert.equal(explicit.widthScale, 1.25);
  assert.equal(explicit.heightScale, 0.8);
  assert.equal(explicit.source, 'exact-plan-scalars');

  const inconsistent = placement({ flatIndex: 0, exactScalars: true });
  inconsistent.widthScale = 2;
  assert.throws(
    () => resolveCustomsAuthoredVegetationScale(inconsistent),
    /disagrees with its exact proxy dimensions/,
  );
});

test('groups exact placements by authored prototype with deterministic counts', () => {
  const catalog = normalizeCustomsAuthoredVegetationCatalog(pack());
  const pineA = placement({ flatIndex: 4, widthScale: 1.2, heightScale: 0.7 });
  const pineB = placement({ flatIndex: 2, presentationPosition: [5, 6, 7] });
  const tree = placement({
    flatIndex: 3,
    prototypeName: 'tree02',
    prototypeId: 'terrain-000-vegetation-000',
    classification: 'deciduous',
  });
  const compiled = planCustomsAuthoredVegetationInstances(renderPlan([pineA, tree, pineB]), catalog);
  assert.equal(compiled.renderedCount, 3);
  assert.equal(compiled.assetGroups.length, 2);
  assert.deepEqual(compiled.placements.map((entry) => entry.flatIndex), [2, 3, 4]);
  assert.equal(compiled.assetGroups.find((entry) => entry.asset.prototypeName === 'pine01').placements.length, 2);
  assert.deepEqual(compiled.scaleSources, { 'exact-plan-envelope-ratio': 3 });
});

test('selects a cell LOD with explicit hysteresis at both transition seams', () => {
  assert.equal(selectCustomsAuthoredVegetationLod(50), 0);
  assert.equal(selectCustomsAuthoredVegetationLod(150), 1);
  assert.equal(selectCustomsAuthoredVegetationLod(400), 2);
  assert.equal(selectCustomsAuthoredVegetationLod(125, 0), 0);
  assert.equal(selectCustomsAuthoredVegetationLod(131, 0), 1);
  assert.equal(selectCustomsAuthoredVegetationLod(95, 1), 1);
  assert.equal(selectCustomsAuthoredVegetationLod(89, 1), 0);
  assert.equal(selectCustomsAuthoredVegetationLod(295, 2), 2);
  assert.equal(selectCustomsAuthoredVegetationLod(259, 2), 1);
});

test('partitions exact placements into deterministic 128 m cells with per-cell LOD and no duplicates', () => {
  const catalog = normalizeCustomsAuthoredVegetationCatalog(pack());
  const placements = [
    placement({ flatIndex: 0, presentationPosition: [10, 10, 0] }),
    placement({ flatIndex: 1, presentationPosition: [20, 20, 0] }),
    placement({
      flatIndex: 2,
      prototypeName: 'tree02',
      prototypeId: 'terrain-000-vegetation-000',
      classification: 'deciduous',
      presentationPosition: [30, 30, 0],
    }),
    placement({ flatIndex: 3, presentationPosition: [300, 0, 0] }),
    placement({ flatIndex: 4, presentationPosition: [700, 0, 0] }),
  ];
  const compiled = planCustomsAuthoredVegetationInstances(renderPlan(placements), catalog);
  const cells = partitionCustomsAuthoredVegetationCells(compiled, {
    cameraWorldPosition: [0, 0, 0],
  });
  assert.equal(cells.cellSizeM, 128);
  assert.equal(CUSTOMS_AUTHORED_VEGETATION_CELL_SIZE_M, 128);
  assert.equal(cells.spatialCellCount, 3);
  assert.equal(cells.prototypeCellCount, 4);
  assert.equal(cells.prototypeCellPlacementInstances, 5);
  assert.deepEqual(cells.lodCellCounts, { 0: 1, 1: 1, 2: 1 });
  assert.deepEqual(cells.cells.map((cell) => cell.cellId), ['0:0', '2:0', '5:0']);
  assert.deepEqual(cells.cells.map((cell) => cell.lod), [0, 1, 2]);
  assert.equal(cells.requiredAssetLods.length, 4, 'pine needs three LODs and tree needs near LOD0');
  assert.deepEqual(
    cells.cells.flatMap((cell) => cell.prototypeGroups.flatMap((group) => (
      group.placements.map((entry) => entry.flatIndex)
    ))).sort((a, b) => a - b),
    [0, 1, 2, 3, 4],
  );

  const keepNear = partitionCustomsAuthoredVegetationCells(compiled, {
    cameraWorldPosition: [131, 0, 0],
    previousCellLods: { '2:0': 0 },
  });
  assert.equal(keepNear.cellLods['2:0'], 0, 'LOD0 remains through the +20 m hysteresis band');
  const leaveNear = partitionCustomsAuthoredVegetationCells(compiled, {
    cameraWorldPosition: [125, 0, 0],
    previousCellLods: { '2:0': 0 },
  });
  assert.equal(leaveNear.cellLods['2:0'], 1, 'cell switches after leaving the hysteresis band');
});

test('loads once per prototype, preserves child transforms, and instances each primitive with tint', async () => {
  const catalog = normalizeCustomsAuthoredVegetationCatalog(pack());
  const placements = [
    placement({ flatIndex: 0, presentationPosition: [10, 20, 30], widthScale: 1.25, heightScale: 0.8 }),
    placement({ flatIndex: 1, presentationPosition: [40, 50, 60], tint: { r: 0.2, g: 0.3, b: 0.4 } }),
    placement({
      flatIndex: 2,
      prototypeName: 'tree02',
      prototypeId: 'terrain-000-vegetation-000',
      classification: 'deciduous',
      presentationPosition: [-1, -2, -3],
    }),
  ];
  const loads = [];
  const released = [];
  const runtime = await createCustomsAuthoredVegetationRuntime({
    plan: renderPlan(placements),
    catalog,
    requireCompleteCatalog: false,
    cameraWorldPosition: [0, 0, 200],
    concurrency: 2,
    loadGlb: async (url, { asset: loadedAsset, request, lod }) => {
      loads.push({ url, assetId: loadedAsset.assetId, request, lod });
      return fakeGlb({
        primitiveCount: loadedAsset.prototypeName === 'pine01' ? 2 : 1,
        childX: loadedAsset.prototypeName === 'pine01' ? 2 : 1,
      });
    },
    disposeLoadedGlb(value) { released.push(value); },
  });
  assert.equal(loads.length, 2);
  assert.ok(loads.every((entry) => entry.lod === 1 && entry.url.endsWith('-lod1.glb')));
  assert.ok(loads.every((entry) => entry.url.startsWith(
    'http://localhost/assets/3d/customs/authored/vegetation/assets/',
  )), 'the verified GLB loader must receive an absolute on-origin URL');
  assert.equal(runtime.group.children.length, 2, 'one InstancedMesh per prototype+cell');
  assert.equal(runtime.status.loadedAssets, 2);
  assert.equal(runtime.status.loadedAssetLods, 2);
  assert.equal(runtime.status.globalLod, false);
  assert.equal(runtime.status.cellLocalLod, true);
  assert.equal(runtime.status.spatialCells, 2);
  assert.equal(runtime.status.prototypeCells, 2);
  assert.equal(runtime.status.instancedMeshes, 2);
  assert.equal(runtime.status.frustumCullBatches, 2);
  assert.equal(runtime.status.primitiveGroups, 3);
  assert.equal(runtime.status.drawCalls, 3);
  assert.equal(runtime.status.uniquePlacementInstances, 3);
  assert.equal(runtime.status.primitiveInstances, 5);
  assert.equal(runtime.status.prototypeCellPlacementInstances, 3);
  assert.equal(runtime.status.shadowCastingPrimitiveGroups, 0, 'shadows are disabled by default');
  assert.ok(runtime.group.children.every((mesh) => mesh.castShadow === false));
  assert.ok(runtime.group.children.every((mesh) => mesh.frustumCulled === true));
  assert.equal(runtime.status.duplicateOfflinePlacementListConsumed, false);

  const pineMesh = runtime.group.children.find((mesh) => mesh.userData.prototypeName === 'pine01');
  assert.equal(pineMesh.count, 2);
  assert.equal(pineMesh.geometry.getAttribute('position').getX(0), -2, 'child X translation and reflection are baked');
  assert.deepEqual([...pineMesh.geometry.index.array].slice(0, 3), [0, 2, 1], 'reflected triangle winding is repaired');
  assert.equal(pineMesh.geometry.groups.length, 2, 'authored primitives merge into one prototype-cell mesh');
  assert.ok(Array.isArray(pineMesh.material) && pineMesh.material.length === 2);
  const matrix = new THREE.Matrix4();
  pineMesh.getMatrixAt(0, matrix);
  assert.ok(matrix.determinant() > 0);
  assert.ok(Math.abs(matrix.determinant() - (1.25 * 1.25 * 0.8)) < 1e-6);
  const color = new THREE.Color();
  pineMesh.getColorAt(1, color);
  assert.ok(Math.abs(color.r - 0.2) < 1e-6);
  assert.ok(Math.abs(color.g - 0.3) < 1e-6);
  assert.ok(Math.abs(color.b - 0.4) < 1e-6);

  const parent = new THREE.Group();
  parent.add(runtime.group);
  let disposedGeometries = 0;
  let disposedInstancedMeshes = 0;
  for (const mesh of runtime.group.children) {
    mesh.geometry.addEventListener('dispose', () => { disposedGeometries += 1; });
    mesh.addEventListener('dispose', () => { disposedInstancedMeshes += 1; });
  }
  runtime.dispose();
  runtime.dispose();
  assert.equal(runtime.active, false);
  assert.equal(runtime.status.disposed, true);
  assert.equal(runtime.group.parent, null);
  assert.equal(runtime.group.children.length, 0);
  assert.equal(released.length, 2, 'every loaded GLTF ownership token is released exactly once');
  assert.equal(disposedGeometries, 2, 'every merged prototype geometry is disposed exactly once');
  assert.equal(disposedInstancedMeshes, 2, 'every prototype-cell InstancedMesh releases its buffers once');
});

test('creates prototype-cell batches, chooses LOD per cell, and casts shadows only in near cells when opted in', async () => {
  const catalog = normalizeCustomsAuthoredVegetationCatalog(pack());
  const placements = [
    placement({ flatIndex: 0, presentationPosition: [10, 10, 0] }),
    placement({ flatIndex: 1, presentationPosition: [20, 20, 0] }),
    placement({
      flatIndex: 2,
      prototypeName: 'tree02',
      prototypeId: 'terrain-000-vegetation-000',
      classification: 'deciduous',
      presentationPosition: [30, 30, 0],
    }),
    placement({ flatIndex: 3, presentationPosition: [300, 0, 0] }),
    placement({ flatIndex: 4, presentationPosition: [700, 0, 0] }),
    placement({ flatIndex: 5, presentationPosition: [900, 0, 0] }),
  ];
  const loads = [];
  const runtime = await createCustomsAuthoredVegetationRuntime({
    plan: renderPlan(placements),
    catalog,
    requireCompleteCatalog: false,
    cameraWorldPosition: [0, 0, 0],
    shadowPolicy: { mode: 'near-lod', receive: true },
    async loadGlb(url, { asset: loadedAsset, lod }) {
      loads.push(`${loadedAsset.prototypeName}:lod${lod}:${url}`);
      return fakeGlb();
    },
    disposeLoadedGlb() {},
  });
  assert.equal(loads.length, 4, 'only unique asset+LOD combinations are loaded');
  assert.equal(runtime.group.children.length, 5, 'one primitive batch per prototype+cell');
  assert.equal(runtime.status.spatialCells, 4);
  assert.equal(runtime.status.prototypeCells, 5);
  assert.equal(runtime.status.uniquePlacementInstances, 6);
  assert.equal(runtime.status.prototypeCellPlacementInstances, 6);
  assert.equal(runtime.status.primitiveInstances, 6);
  assert.equal(runtime.group.children.reduce((sum, mesh) => sum + mesh.count, 0), 6);
  assert.equal(runtime.status.shadowCastingPrimitiveGroups, 2);
  assert.ok(runtime.group.children.filter((mesh) => mesh.userData.lod === 0).every((mesh) => mesh.castShadow));
  assert.ok(runtime.group.children.filter((mesh) => mesh.userData.lod > 0).every((mesh) => !mesh.castShadow));
  assert.equal(runtime.requiresReload([0, 0, 0]), false);
  assert.equal(runtime.requiresReload([800, 0, 0]), true);
  const uniqueGeometries = new Set(runtime.group.children.map((mesh) => mesh.geometry));
  let disposedGeometries = 0;
  for (const geometry of uniqueGeometries) {
    geometry.addEventListener('dispose', () => { disposedGeometries += 1; });
  }
  runtime.dispose();
  assert.equal(disposedGeometries, uniqueGeometries.size, 'shared asset+LOD geometry disposes once');
});

test('reports BLEND without rewriting, admits MASK, and rejects disallowed or unknown alpha modes', async () => {
  const catalog = normalizeCustomsAuthoredVegetationCatalog(pack());
  let blendMaterial;
  const blendRuntime = await createCustomsAuthoredVegetationRuntime({
    plan: renderPlan([placement({ flatIndex: 0 })]),
    catalog,
    requireCompleteCatalog: false,
    cameraWorldPosition: [0, 0, 0],
    async loadGlb() {
      const glb = fakeGlb({ alphaModes: ['BLEND'] });
      blendMaterial = glb.scene.getObjectByProperty('isMesh', true).material;
      return glb;
    },
    disposeLoadedGlb() {},
  });
  assert.equal(blendRuntime.status.alphaContract.primitiveMaterialModes.BLEND, 1);
  assert.equal(blendRuntime.status.alphaContract.blendMaterials.length, 1);
  assert.equal(blendRuntime.status.alphaContract.warnings.length, 1);
  assert.equal(blendRuntime.status.alphaContract.materialsRewritten, false);
  assert.equal(blendMaterial.transparent, true);
  assert.equal(blendMaterial.alphaTest, 0);
  blendRuntime.dispose();

  const maskRuntime = await createCustomsAuthoredVegetationRuntime({
    plan: renderPlan([placement({ flatIndex: 0 })]),
    catalog,
    requireCompleteCatalog: false,
    cameraWorldPosition: [0, 0, 0],
    alphaPolicy: { blend: 'reject' },
    async loadGlb() { return fakeGlb({ alphaModes: ['MASK'] }); },
    disposeLoadedGlb() {},
  });
  assert.equal(maskRuntime.status.alphaContract.primitiveMaterialModes.MASK, 1);
  assert.equal(maskRuntime.status.alphaContract.warnings.length, 0);
  maskRuntime.dispose();

  let rejectedReleased = 0;
  await assert.rejects(createCustomsAuthoredVegetationRuntime({
    plan: renderPlan([placement({ flatIndex: 0 })]),
    catalog,
    requireCompleteCatalog: false,
    cameraWorldPosition: [0, 0, 0],
    alphaPolicy: { blend: 'reject' },
    async loadGlb() { return fakeGlb({ alphaModes: ['BLEND'] }); },
    disposeLoadedGlb() { rejectedReleased += 1; },
  }), (error) => error.code === 'ERR_CUSTOMS_VEGETATION_BLEND_REJECTED');
  assert.equal(rejectedReleased, 1, 'rejected decoded GLTF ownership is released');

  await assert.rejects(createCustomsAuthoredVegetationRuntime({
    plan: renderPlan([placement({ flatIndex: 0 })]),
    catalog,
    requireCompleteCatalog: false,
    cameraWorldPosition: [0, 0, 0],
    async loadGlb() { return fakeGlb({ alphaModes: ['HASH'] }); },
    disposeLoadedGlb() {},
  }), /unsupported alphaHash/);
});

test('rejects cross-origin asset bases before verified loading starts', async () => {
  const catalog = normalizeCustomsAuthoredVegetationCatalog(pack());
  let loads = 0;
  await assert.rejects(createCustomsAuthoredVegetationRuntime({
    plan: renderPlan([placement({ flatIndex: 0 })]),
    catalog,
    requireCompleteCatalog: false,
    cameraWorldPosition: [0, 0, 0],
    pageUrl: 'http://localhost/map',
    baseUrl: 'https://assets.example.test/vegetation/',
    async loadGlb() { loads += 1; return fakeGlb(); },
  }), /on-origin/);
  assert.equal(loads, 0);
});

test('production creation fails closed on a partial authored catalog before loading', async () => {
  const catalog = normalizeCustomsAuthoredVegetationCatalog(pack());
  let loads = 0;
  await assert.rejects(
    createCustomsAuthoredVegetationRuntime({
      plan: renderPlan([placement({ flatIndex: 0 })]),
      catalog,
      cameraWorldPosition: [0, 0, 500],
      loadGlb: async () => { loads += 1; return fakeGlb(); },
    }),
    (error) => error instanceof CustomsAuthoredVegetationContractError
      && error.code === 'ERR_CUSTOMS_VEGETATION_INCOMPLETE_CATALOG',
  );
  assert.equal(loads, 0);
});

test('aborts atomically, releases already-loaded GLTFs, and never returns a partial group', async () => {
  const catalog = normalizeCustomsAuthoredVegetationCatalog(pack());
  const controller = new AbortController();
  const released = [];
  let startedSecond;
  const secondStarted = new Promise((resolve) => { startedSecond = resolve; });
  let calls = 0;
  const pending = createCustomsAuthoredVegetationRuntime({
    plan: renderPlan([
      placement({ flatIndex: 0 }),
      placement({
        flatIndex: 1,
        prototypeName: 'tree02',
        prototypeId: 'terrain-000-vegetation-000',
        classification: 'deciduous',
      }),
    ]),
    catalog,
    requireCompleteCatalog: false,
    cameraWorldPosition: [0, 0, 0],
    concurrency: 1,
    signal: controller.signal,
    async loadGlb(_url, { signal }) {
      calls += 1;
      if (calls === 1) return fakeGlb();
      startedSecond();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('loader observed abort');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
    disposeLoadedGlb(value) { released.push(value); },
  });
  await secondStarted;
  controller.abort(new Error('view teardown'));
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  assert.equal(released.length, 1, 'the completed first asset is released during atomic rollback');
});

test('rejects unsupported exact prototypes before starting any GLB request', async () => {
  const catalog = normalizeCustomsAuthoredVegetationCatalog(pack());
  let loads = 0;
  const unknown = placement({ flatIndex: 0, prototypeId: 'terrain-000-vegetation-999' });
  await assert.rejects(
    createCustomsAuthoredVegetationRuntime({
      plan: renderPlan([unknown]),
      catalog,
      requireCompleteCatalog: false,
      cameraWorldPosition: [0, 0, 500],
      loadGlb: async () => { loads += 1; return fakeGlb(); },
    }),
    (error) => error instanceof CustomsAuthoredVegetationContractError
      && error.code === 'ERR_CUSTOMS_VEGETATION_UNSUPPORTED_PROTOTYPE',
  );
  assert.equal(loads, 0);
});
