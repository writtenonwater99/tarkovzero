import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import {
  CustomsAuthoredVegetationContractError,
  CUSTOMS_AUTHORED_VEGETATION_BUCKET_CEILING,
  createCustomsAuthoredVegetationRuntime,
  customsAuthoredVegetationBucketKey,
  customsAuthoredVegetationInstanceMatrix,
  customsAuthoredVegetationWorldMatrix,
  joinCustomsAuthoredVegetationPrototypeName,
  normalizeCustomsAuthoredVegetationCatalog,
  partitionCustomsAuthoredVegetationByLod,
  planCustomsAuthoredVegetationInstances,
  probeCustomsAuthoredVegetationBinding,
  resolveCustomsAuthoredVegetationBinding,
  resolveCustomsAuthoredVegetationPrototypeName,
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

function fakeGlb({ primitiveCount = 1, childX = 0, alphaModes = [], textureSize = null } = {}) {
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
    // A decoded GLTF's texture: a real THREE.Texture (so `.isTexture`/`.dispose()` behave exactly
    // like the runtime's production case), backed by a plain `{width,height}` image stand-in
    // (undecoded pixel data is irrelevant here — only the declared dimensions are read).
    if (textureSize) material.map = new THREE.Texture({ width: textureSize, height: textureSize });
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

function lodPartitionFixture() {
  const catalog = normalizeCustomsAuthoredVegetationCatalog(pack());
  // Every placement's bounding sphere centre is its base plus half its authored height, so these
  // z values are chosen to keep the LOD bands unambiguous while the camera sits on the z = 0 plane.
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
    placement({ flatIndex: 3, presentationPosition: [200, 0, 0] }),
    placement({ flatIndex: 4, presentationPosition: [700, 0, 0] }),
  ];
  return { catalog, placements };
}

test('batches per (family, LOD) with per-instance LOD, and never duplicates or loses a placement', () => {
  const { catalog, placements } = lodPartitionFixture();
  const compiled = planCustomsAuthoredVegetationInstances(renderPlan(placements), catalog);
  const partition = partitionCustomsAuthoredVegetationByLod(compiled, {
    cameraWorldPosition: [0, 0, 0],
  });

  // Three near pines/trees at LOD0, one pine at 200 m -> LOD1, one at 700 m -> LOD2.
  assert.deepEqual(partition.buckets.map((bucket) => bucket.key), [
    customsAuthoredVegetationBucketKey('customs.vegetation.pine01', 0),
    customsAuthoredVegetationBucketKey('customs.vegetation.pine01', 1),
    customsAuthoredVegetationBucketKey('customs.vegetation.pine01', 2),
    customsAuthoredVegetationBucketKey('customs.vegetation.tree02', 0),
  ]);
  assert.equal(partition.bucketCount, 4);
  assert.equal(new Set(partition.buckets.map((bucket) => bucket.key)).size, 4, 'each (family, LOD) key is unique');
  assert.equal(partition.visibleInstances, 5);
  assert.equal(partition.frustumCulledInstances, 0);
  assert.equal(partition.frustumCullingApplied, false);
  assert.deepEqual(partition.lodInstanceCounts, { 0: 3, 1: 1, 2: 1 });
  assert.deepEqual(
    partition.buckets.flatMap((bucket) => bucket.indices.map((index) => compiled.placements[index].flatIndex)).sort((a, b) => a - b),
    [0, 1, 2, 3, 4],
  );
  // The structural ceiling is a count of (family, LOD) pairs and cannot depend on the map layout.
  assert.ok(partition.bucketCount <= compiled.assetGroups.length * 3);
  assert.equal(CUSTOMS_AUTHORED_VEGETATION_BUCKET_CEILING, 93);

  // Hysteresis is now per instance, keyed by the placement's ordinal in the compiled plan.
  const nearIndex = compiled.placements.findIndex((entry) => entry.flatIndex === 3);
  const keepNear = partitionCustomsAuthoredVegetationByLod(compiled, {
    cameraWorldPosition: [75, 0, 0],
    previousLods: partition.lods,
  });
  assert.equal(partition.lods[nearIndex], 1);
  assert.equal(keepNear.lods[nearIndex], 1, 'LOD1 is retained inside the -20 m hysteresis band at 125 m');
  const leaveNear = partitionCustomsAuthoredVegetationByLod(compiled, {
    cameraWorldPosition: [111, 0, 0],
    previousLods: partition.lods,
  });
  assert.equal(leaveNear.lods[nearIndex], 0, 'the instance drops to LOD0 once it clears the band');
});

test('rejects each placement against the frustum individually and keeps the LOD state coherent', () => {
  const { catalog, placements } = lodPartitionFixture();
  const compiled = planCustomsAuthoredVegetationInstances(renderPlan(placements), catalog);
  // A half-space that admits only x <= 100: the two far pines fall outside it.
  const frustum = {
    intersectsSphere: (sphere) => sphere.center.x - sphere.radius <= 100,
  };
  const partition = partitionCustomsAuthoredVegetationByLod(compiled, {
    cameraWorldPosition: [0, 0, 0],
    frustum,
  });
  assert.equal(partition.frustumCullingApplied, true);
  assert.equal(partition.visibleInstances, 3);
  assert.equal(partition.frustumCulledInstances, 2);
  assert.equal(partition.visibleInstances + partition.frustumCulledInstances, compiled.renderedCount);
  assert.equal(partition.bucketCount, 2, 'the emptied (family, LOD) buckets simply do not exist');
  // LOD is still selected for the rejected placements, so hysteresis survives a swing out of view.
  assert.deepEqual(partition.lodInstanceCounts, { 0: 3, 1: 1, 2: 1 });
  assert.equal(partition.lods.length, compiled.renderedCount);

  assert.throws(
    () => partitionCustomsAuthoredVegetationByLod(compiled, {
      cameraWorldPosition: [0, 0, 0],
      frustum: {},
    }),
    /intersectsSphere/,
  );
  assert.throws(
    () => partitionCustomsAuthoredVegetationByLod(compiled, {
      cameraWorldPosition: [0, 0, 0],
      previousLods: new Int8Array(2),
    }),
    /one entry per compiled placement/,
  );
});

test('recovers prototypeName by joining bare placement rows to their prototype bindings', () => {
  const catalog = normalizeCustomsAuthoredVegetationCatalog(pack());
  // The offline pack's own `placements[]` rows carry no `prototypeName`; the probe correctly
  // rejects them, and the join is what makes them resolvable.
  const bare = {
    assetId: 'customs.vegetation.tree02',
    instanceIndex: 0,
    placementOrdinal: 0,
    prototypeId: 'terrain-000-vegetation-000',
    tileId: 'terrain-000',
  };
  assert.equal(probeCustomsAuthoredVegetationBinding(catalog, bare), null);
  assert.equal(resolveCustomsAuthoredVegetationPrototypeName(catalog, bare), 'tree02');
  const joined = joinCustomsAuthoredVegetationPrototypeName(catalog, bare);
  assert.equal(joined.prototypeName, 'tree02');
  assert.equal(probeCustomsAuthoredVegetationBinding(catalog, joined).asset.assetId, 'customs.vegetation.tree02');

  // An unbound pair stays unbound; nothing is invented.
  assert.equal(resolveCustomsAuthoredVegetationPrototypeName(catalog, {
    tileId: 'terrain-000', prototypeId: 'terrain-000-vegetation-999',
  }), null);
  assert.equal(resolveCustomsAuthoredVegetationPrototypeName(catalog, { tileId: 'terrain-000' }), null);
  // A declared name is never overwritten — a disagreement has to stay visible to the resolver.
  const declared = { ...bare, prototypeName: 'pine01' };
  assert.equal(joinCustomsAuthoredVegetationPrototypeName(catalog, declared).prototypeName, 'pine01');
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
  // Every family at every LOD is resident from the first build, which is what retires the
  // reload-on-LOD-change path entirely.
  assert.equal(loads.length, 6, 'two families x three LODs, loaded once each');
  assert.deepEqual([...new Set(loads.map((entry) => entry.lod))].sort(), [0, 1, 2]);
  assert.ok(loads.every((entry) => entry.url.startsWith(
    'http://localhost/assets/3d/customs/authored/vegetation/assets/',
  )), 'the verified GLB loader must receive an absolute on-origin URL');
  assert.equal(runtime.group.children.length, 6, 'one InstancedMesh per (family, LOD)');
  assert.equal(runtime.status.loadedAssets, 2);
  assert.equal(runtime.status.loadedAssetLods, 6);
  assert.equal(runtime.status.bucketCeiling, 6);
  assert.equal(runtime.status.globalLod, false);
  assert.equal(runtime.status.cellLocalLod, false);
  assert.equal(runtime.status.perInstanceLod, true);
  assert.equal(runtime.status.spatialCellGrid, null, 'the 128 m cell grid is gone');
  assert.equal(runtime.status.materialMode, 'authored-per-primitive');
  assert.equal(runtime.status.instancedMeshes, 6);
  // Live counts: all three placements land in the medium band at this camera, so exactly two
  // buckets carry instances and the other four are empty and hidden.
  assert.equal(runtime.status.buckets, 2);
  assert.equal(runtime.status.frustumCullBatches, 2);
  assert.equal(runtime.status.drawCalls, 3, 'pine merges two primitive materials, tree one');
  assert.equal(runtime.status.visibleInstances, 3);
  assert.equal(runtime.status.frustumCulledInstances, 0);
  assert.equal(runtime.status.uniquePlacementInstances, 3);
  // Each bucket is sized to its family's full placement count: pine01 x 2, tree02 x 1, x3 LODs.
  assert.equal(runtime.status.instanceBufferBytes, 3 * (2 * 64 + 2 * 12) + 3 * (1 * 64 + 1 * 12));
  assert.ok(runtime.group.children.every((mesh) => mesh.castShadow === false), 'shadows are disabled by default');
  assert.ok(runtime.group.children.every((mesh) => mesh.frustumCulled === false), 'culling is per instance, not per object');
  assert.equal(runtime.group.children.filter((mesh) => mesh.visible).length, 2);
  assert.equal(runtime.status.duplicateOfflinePlacementListConsumed, false);

  const pineMesh = runtime.group.children.find((mesh) => (
    mesh.userData.prototypeName === 'pine01' && mesh.userData.lod === 1
  ));
  assert.equal(pineMesh.count, 2);
  assert.equal(pineMesh.userData.capacity, 2);
  assert.equal(pineMesh.geometry.getAttribute('position').getX(0), -2, 'child X translation and reflection are baked');
  assert.deepEqual([...pineMesh.geometry.index.array].slice(0, 3), [0, 2, 1], 'reflected triangle winding is repaired');
  assert.equal(pineMesh.geometry.groups.length, 2, 'authored primitives merge into one (family, LOD) mesh');
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

  // A LOD change is a repack, not a reload: no further GLB request, and the instance matrix is
  // copied rather than recomposed, so it is bit-identical in its new bucket.
  const before = new THREE.Matrix4();
  pineMesh.getMatrixAt(0, before);
  const moved = runtime.update({ cameraWorldPosition: [10, 20, 34] });
  assert.equal(loads.length, 6, 'a LOD change refetches nothing');
  const pineNear = runtime.group.children.find((mesh) => (
    mesh.userData.prototypeName === 'pine01' && mesh.userData.lod === 0
  ));
  assert.equal(pineNear.count, 2, 'both pines crossed into LOD0');
  assert.equal(pineMesh.count, 0, 'the emptied medium bucket is repacked to zero');
  assert.equal(pineMesh.visible, false);
  const after = new THREE.Matrix4();
  pineNear.getMatrixAt(0, after);
  assert.deepEqual([...after.elements], [...before.elements], 'the matrix is copied, never recomposed');
  assert.equal(moved.visibleInstances, 3);
  assert.equal(moved.buckets, 2);

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
  assert.equal(released.length, 6, 'every loaded GLTF ownership token is released exactly once');
  assert.equal(disposedGeometries, 6, 'every merged (family, LOD) geometry is disposed exactly once');
  assert.equal(disposedInstancedMeshes, 6, 'every bucket InstancedMesh releases its buffers once');
});

test('the per-primitive fallback path keeps its decoded textures resident and reports them honestly', async () => {
  const catalog = normalizeCustomsAuthoredVegetationCatalog(pack());
  // Pine only, so exactly one family (three LODs) loads — a small, exact fixture to reason about.
  const placements = [placement({ flatIndex: 0, presentationPosition: [10, 20, 30] })];
  const textureSize = 32;
  const textureBytes = textureSize * textureSize * 4;
  const released = [];
  const runtime = await createCustomsAuthoredVegetationRuntime({
    plan: renderPlan(placements),
    catalog,
    requireCompleteCatalog: false,
    cameraWorldPosition: [0, 0, 200],
    // No `textureArrays`: this is the per-primitive fallback route (materialMode
    // 'authored-per-primitive'), the one that must NOT release `loadedEntry.value` early because
    // its own decoded materials are the merged batch's `material` array, referenced directly.
    loadGlb: async () => fakeGlb({ textureSize }),
    disposeLoadedGlb(value) { released.push(value); },
  });
  assert.equal(runtime.status.materialMode, 'authored-per-primitive');
  assert.equal(runtime.status.decodedGlbReleasedAfterMerge, false);
  assert.equal(released.length, 0, 'the fallback path releases nothing while the runtime is active');

  // One 32x32 RGBA8 texture retained per loaded LOD (three LODs, one primitive each), plus each
  // LOD's own small decoded geometry — the memory a stale `residentBytes` used to go silent about
  // entirely. Only the texture floor is asserted exactly; geometry byte layout is three.js's own
  // internal business, not this fix's contract.
  assert.ok(
    runtime.status.retainedDecodedGlbBytes >= textureBytes * 3,
    `expected at least ${textureBytes * 3} retained bytes (3 decoded textures), got ${runtime.status.retainedDecodedGlbBytes}`,
  );
  assert.equal(
    runtime.status.residentBytes,
    runtime.status.instanceBufferBytes + runtime.status.geometryBytes
      + runtime.status.textureUploadBytes + runtime.status.retainedDecodedGlbBytes,
    'residentBytes must be the sum of every component it claims to report, retained bytes included',
  );

  runtime.dispose();
  assert.equal(released.length, 3, 'disposing the runtime releases every retained decoded GLTF exactly once');
});

test('keeps every family+LOD resident, chooses LOD per instance, and casts shadows only at LOD0 when opted in', async () => {
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
  assert.equal(loads.length, 6, 'every family at every LOD is loaded exactly once');
  assert.equal(new Set(loads).size, 6, 'no asset+LOD pair is fetched twice');
  assert.equal(runtime.group.children.length, 6, 'one bucket per (family, LOD)');
  assert.equal(runtime.status.uniquePlacementInstances, 6);
  assert.equal(runtime.status.visibleInstances, 6);
  assert.equal(runtime.status.frustumCulledInstances, 0);
  // Every placement is drawn exactly once across the live prefixes — the invariant the old
  // per-cell accounting protected, now protected per bucket.
  assert.equal(runtime.group.children.reduce((sum, mesh) => sum + mesh.count, 0), 6);
  assert.ok(runtime.group.children.filter((mesh) => mesh.userData.lod === 0).every((mesh) => mesh.castShadow));
  assert.ok(runtime.group.children.filter((mesh) => mesh.userData.lod > 0).every((mesh) => !mesh.castShadow));
  assert.equal(runtime.status.buckets, 3, 'near pines, far pines, and the near tree');
  assert.deepEqual(runtime.status.lodVisibleCounts, { 0: 3, 1: 0, 2: 3 });

  // A camera move only ever repacks; the resident geometry set never changes.
  const far = runtime.update({ cameraWorldPosition: [1200, 0, 0] });
  assert.equal(loads.length, 6);
  assert.equal(far.visibleInstances, 6);
  assert.equal(runtime.group.children.reduce((sum, mesh) => sum + mesh.count, 0), 6);
  assert.equal(runtime.status.perInstanceLod, true);
  assert.equal(runtime.status.spatialCellGrid, null);
  assert.equal(typeof runtime.requiresReload, 'undefined', 'the reload path is gone');

  const uniqueGeometries = new Set(runtime.group.children.map((mesh) => mesh.geometry));
  let disposedGeometries = 0;
  for (const geometry of uniqueGeometries) {
    geometry.addEventListener('dispose', () => { disposedGeometries += 1; });
  }
  runtime.dispose();
  assert.equal(disposedGeometries, uniqueGeometries.size, 'each (family, LOD) geometry disposes once');
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
  // One primitive per GLB x three resident LODs.
  assert.equal(blendRuntime.status.alphaContract.primitiveMaterialModes.BLEND, 3);
  assert.equal(blendRuntime.status.alphaContract.blendMaterials.length, 3);
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
  assert.equal(maskRuntime.status.alphaContract.primitiveMaterialModes.MASK, 3);
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
  assert.equal(rejectedReleased, 3, 'every decoded GLTF ownership token is released on rejection');

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
