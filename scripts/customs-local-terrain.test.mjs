import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CUSTOMS_LOCAL_TERRAIN_DISPLAY_RELIEF_SCALE,
  CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME,
  createCustomsLocalTerrainRuntime,
  customsTerrainCanonicalGridSample,
  customsTerrainDisplayY,
  customsTerrainSemanticControlUv,
  decodeCustomsTerrainFloat32LE,
  lookupCustomsTerrainTile,
  planCustomsTerrainMesh,
  sampleCustomsTerrainElevation,
  validateCustomsLocalTerrainManifest,
} from '../src/customs-local-terrain.js';

const FRAME = CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME;

function controlMaps(prefix) {
  return [0, 1, 2].map((index) => ({
    id: `control-${index}`,
    file: `${prefix}/control-${index}.png`,
    channels: ['r', 'g', 'b', 'a'],
    width: 4,
    height: 3,
    columnOrder: 'x-min-to-x-max',
    rowOrder: 'z-min-to-z-max',
  }));
}

function layers() {
  return [
    { id: 'grass', name: 'Synthetic grass', index: 0, controlMapId: 'control-0', channel: 'r' },
    { id: 'soil', name: 'Synthetic soil', index: 1, controlMapId: 'control-0', channel: 'g' },
    { id: 'gravel', name: 'Synthetic gravel', index: 2, controlMapId: 'control-0', channel: 'b' },
    { id: 'asphalt', name: 'Synthetic asphalt', index: 3, controlMapId: 'control-0', channel: 'a' },
    { id: 'mud', name: 'Synthetic mud', index: 4, controlMapId: 'control-1', channel: 'r' },
  ];
}

function tile(id, originX, prefix) {
  return {
    id,
    origin: { x: originX, y: 5, z: 0 },
    resolution: { columns: 3, rows: 3 },
    sampleSpacingM: { x: 1, z: 1 },
    heightEncoding: {
      storage: 'float32le',
      endianness: 'little',
      scalarType: 'float32',
      sampleOrder: 'row-major-z-times-columns-plus-x',
      values: 'canonical-world-y-metres',
    },
    heightFile: `${prefix}/height.f32le`,
    controlMaps: controlMaps(prefix),
    layers: layers(),
  };
}

function syntheticManifest() {
  const west = tile('west', 0, 'synthetic/west');
  west.vegetation = {
    file: 'synthetic/west/vegetation.json',
    format: 'json',
    count: 2,
    prototypes: [
      { id: 'tree-a', name: 'Synthetic tree A' },
      { id: 'tree-b', name: 'Synthetic tree B' },
    ],
  };
  return {
    schemaVersion: 1,
    map: 'customs',
    localOnly: true,
    sourceFrame: FRAME,
    reliefOriginYM: 5,
    tiles: [west, tile('east', 2, 'synthetic/east')],
  };
}

function clone(value) {
  return structuredClone(value);
}

function float32LE(values) {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

function heightFiles() {
  // Synthetic plane h(x,z) = x + 10z, including an identical shared seam at x=2.
  return new Map([
    ['synthetic/west/height.f32le', float32LE([0, 1, 2, 10, 11, 12, 20, 21, 22])],
    ['synthetic/east/height.f32le', float32LE([2, 3, 4, 12, 13, 14, 22, 23, 24])],
  ]);
}

function point(x, z) {
  return { sourceFrame: FRAME, x, z };
}

test('strictly validates and freezes the local-only Customs manifest v1', () => {
  const normalized = validateCustomsLocalTerrainManifest(syntheticManifest());
  assert.equal(normalized.map, 'customs');
  assert.equal(normalized.localOnly, true);
  assert.equal(normalized.tiles.length, 2);
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.tiles[0].controlMaps[0]));

  const remote = syntheticManifest();
  remote.localOnly = false;
  assert.throws(() => validateCustomsLocalTerrainManifest(remote), /localOnly.*must be true/);

  const wrongFrame = syntheticManifest();
  wrongFrame.sourceFrame = 'leaflet-pixels';
  assert.throws(() => validateCustomsLocalTerrainManifest(wrongFrame), /sourceFrame.*eft-unity-world-metres-y-up/);

  const nonFinite = syntheticManifest();
  nonFinite.tiles[0].origin.x = Number.NaN;
  assert.throws(() => validateCustomsLocalTerrainManifest(nonFinite), /origin\.x.*finite/);

  for (const unsafe of ['../height.bin', '/height.bin', 'https://example.test/height.bin', 'C:\\height.bin', 'x/%2e%2e/y']) {
    const manifest = syntheticManifest();
    manifest.tiles[0].heightFile = unsafe;
    assert.throws(
      () => validateCustomsLocalTerrainManifest(manifest),
      /heightFile.*safe relative local path|heightFile.*traversal/,
      unsafe,
    );
  }
});

test('rejects positive-area overlaps and fails lookup or mesh planning on a legitimate gap', () => {
  const gap = syntheticManifest();
  gap.tiles[1].origin.x = 2.25;
  const validatedGap = validateCustomsLocalTerrainManifest(gap);
  assert.equal(validatedGap.tiles.length, 2);
  assert.throws(() => lookupCustomsTerrainTile(validatedGap, point(2.1, 1)), /outside terrain coverage/);
  assert.throws(
    () => planCustomsTerrainMesh(
      validatedGap,
      { sourceFrame: FRAME, minX: 1, maxX: 3, minZ: 0.25, maxZ: 1.75 },
    ),
    /scope.*gap near game coordinate/,
  );

  const overlap = syntheticManifest();
  overlap.tiles[1].origin.x = 1.75;
  assert.throws(() => validateCustomsLocalTerrainManifest(overlap), /overlaps near game coordinate/);
});

test('decodes Float32LE exactly and rejects wrong lengths or non-finite samples', () => {
  assert.deepEqual([...decodeCustomsTerrainFloat32LE(float32LE([1.25, -2.5]), 2)], [1.25, -2.5]);
  assert.throws(
    () => decodeCustomsTerrainFloat32LE(float32LE([1.25]), 2),
    /exactly 8 bytes.*received 4/,
  );
  assert.throws(
    () => decodeCustomsTerrainFloat32LE(float32LE([Number.NaN]), 1),
    /height samples\[0\].*finite/,
  );
});

test('looks up half-open tiles and bilinearly samples canonical and fixed-2x display Y separately', () => {
  const runtime = createCustomsLocalTerrainRuntime(syntheticManifest(), heightFiles());
  assert.equal(lookupCustomsTerrainTile(runtime, point(1.99, 1)).id, 'west');
  assert.equal(lookupCustomsTerrainTile(runtime, point(2, 1)).id, 'east');
  assert.equal(customsTerrainCanonicalGridSample(runtime, 'west', 2, 1), 12);

  const sample = sampleCustomsTerrainElevation(runtime, point(0.5, 1.5));
  assert.equal(sample.canonicalYM, 15.5);
  assert.equal(sample.displayYM, 26);
  assert.equal(sample.reliefOriginYM, 5);
  assert.equal(sample.displayReliefScale, 2);
  assert.equal(CUSTOMS_LOCAL_TERRAIN_DISPLAY_RELIEF_SCALE, 2);
  assert.equal(customsTerrainDisplayY(15.5, 5), 26);

  const seam = sampleCustomsTerrainElevation(runtime, point(2, 0.5));
  assert.equal(seam.tileId, 'east');
  assert.equal(seam.canonicalYM, 7);
  assert.throws(
    () => sampleCustomsTerrainElevation(runtime, { sourceFrame: 'map-pixels', x: 1, z: 1 }),
    /sourceFrame.*eft-unity-world-metres-y-up/,
  );
  assert.throws(() => lookupCustomsTerrainTile(runtime, point(5, 1)), /outside terrain coverage/);
});

test('maps semantic controls with +X columns and +Z PNG rows without a hidden flip', () => {
  const manifest = validateCustomsLocalTerrainManifest(syntheticManifest());
  const uv = customsTerrainSemanticControlUv(manifest, point(1, 0.5), 'mud');
  assert.equal(uv.tileId, 'west');
  assert.equal(uv.controlMapId, 'control-1');
  assert.equal(uv.channel, 'r');
  assert.equal(uv.u, 0.5);
  assert.equal(uv.v, 0.25);
  assert.equal(uv.pixelX, 1.5);
  assert.equal(uv.pixelY, 0.5);
  assert.equal(uv.rowOrder, 'z-min-to-z-max');
});

test('plans a cropped, decimated mesh while preserving surrounding source samples', () => {
  const plan = planCustomsTerrainMesh(
    syntheticManifest(),
    { sourceFrame: FRAME, minX: 0.25, maxX: 3.75, minZ: 0.25, maxZ: 1.75 },
    { decimation: { x: 2, z: 2 } },
  );
  assert.equal(plan.patches.length, 2);
  assert.deepEqual(plan.decimation, { x: 2, z: 2 });
  assert.deepEqual(plan.patches[0].sampleWindow, {
    columnStart: 0,
    columnEnd: 2,
    rowStart: 0,
    rowEnd: 2,
  });
  assert.deepEqual(plan.patches[0].columnIndices, [0, 2]);
  assert.deepEqual(plan.patches[0].rowIndices, [0, 2]);
  assert.equal(plan.patches[0].vertexCount, 4);
  assert.equal(plan.patches[0].triangleCount, 2);
  assert.equal(plan.vertexCount, 8);
  assert.equal(plan.triangleCount, 4);
  assert.deepEqual(plan.relief, {
    canonicalValuesPreserved: true,
    displayScale: 2,
    originYM: 5,
  });

  assert.throws(
    () => planCustomsTerrainMesh(
      syntheticManifest(),
      { sourceFrame: FRAME, minX: -1, maxX: 1, minZ: 0, maxZ: 1 },
    ),
    /scope.*outside terrain coverage/,
  );
});
