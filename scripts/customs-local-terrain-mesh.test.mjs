import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME,
  createCustomsLocalTerrainRuntime,
} from '../src/customs-local-terrain.js';
import {
  CUSTOMS_TERRAIN_PRESENTATION_FRAME,
  compileCustomsLocalTerrainMesh,
} from '../src/customs-local-terrain-mesh.js';

const FRAME = CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME;

function controlMaps(prefix) {
  return [0, 1, 2].map((index) => ({
    id: `${prefix}-control-${index}`,
    file: `${prefix}/control-${index}.png`,
    channels: ['r', 'g', 'b', 'a'],
    width: 4,
    height: 4,
    columnOrder: 'x-min-to-x-max',
    rowOrder: 'z-min-to-z-max',
  }));
}

function layers(prefix) {
  return [0, 1, 2, 3, 4].map((index) => ({
    id: `${prefix}-layer-${index}`,
    name: `Synthetic layer ${index}`,
    index,
    controlMapId: `${prefix}-control-${Math.floor(index / 4)}`,
    channel: ['r', 'g', 'b', 'a'][index % 4],
  }));
}

function tile(id, originX) {
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
    heightFile: `${id}/height.f32le`,
    controlMaps: controlMaps(id),
    layers: layers(id),
  };
}

function manifest() {
  return {
    schemaVersion: 1,
    map: 'customs',
    localOnly: true,
    sourceFrame: FRAME,
    reliefOriginYM: 5,
    tiles: [tile('west', 0), tile('east', 2)],
  };
}

function float32LE(values) {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

function runtime() {
  return createCustomsLocalTerrainRuntime(manifest(), new Map([
    // West's private x=2 edge is deliberately wrong and must never crack the mesh.
    ['west/height.f32le', float32LE([0, 1, 100, 10, 11, 110, 20, 21, 120])],
    ['east/height.f32le', float32LE([2, 3, 4, 12, 13, 14, 22, 23, 24])],
  ]));
}

function scope(minX = 0, maxX = 4, minZ = 0, maxZ = 2) {
  return { sourceFrame: FRAME, minX, maxX, minZ, maxZ };
}

function vertexPosition(patch, vertex) {
  return [...patch.positions.slice(vertex * 3, (vertex * 3) + 3)];
}

function signedAreaXY(positions, a, b, c) {
  const ax = positions[a * 3];
  const ay = positions[(a * 3) + 1];
  const bx = positions[b * 3];
  const by = positions[(b * 3) + 1];
  const cx = positions[c * 3];
  const cy = positions[(c * 3) + 1];
  return ((bx - ax) * (cy - ay)) - ((by - ay) * (cx - ax));
}

test('compiles typed renderer-neutral geometry with explicit coordinate metadata', () => {
  const mesh = compileCustomsLocalTerrainMesh(runtime(), scope());
  assert.equal(mesh.presentationCoordinates.frame, CUSTOMS_TERRAIN_PRESENTATION_FRAME);
  assert.deepEqual(mesh.presentationCoordinates.axes, {
    x: '-game-x',
    y: '-game-z',
    z: 'display-world-y',
  });
  assert.equal(mesh.presentationCoordinates.displayReliefScale, 2);
  assert.equal(mesh.canonicalCoordinates.frame, FRAME);
  assert.equal(mesh.patches.length, 2);
  for (const patch of mesh.patches) {
    assert.ok(patch.positions instanceof Float32Array);
    assert.ok(patch.controlUvs instanceof Float32Array);
    assert.ok(patch.indices instanceof Uint32Array);
    assert.ok(patch.canonicalYM instanceof Float64Array);
    assert.equal(patch.positions.length, patch.vertexCount * 3);
    assert.equal(patch.controlUvs.length, patch.vertexCount * 2);
    assert.equal(patch.indices.length, patch.triangleCount * 3);
  }
});

test('re-samples both sides of a mismatched raw seam through the deterministic runtime owner', () => {
  const mesh = compileCustomsLocalTerrainMesh(runtime(), scope());
  const west = mesh.patches.find(({ tileId }) => tileId === 'west');
  const east = mesh.patches.find(({ tileId }) => tileId === 'east');
  for (let row = 0; row < west.vertexRows; row += 1) {
    const westVertex = (row * west.vertexColumns) + (west.vertexColumns - 1);
    const eastVertex = row * east.vertexColumns;
    assert.equal(west.canonicalYM[westVertex], east.canonicalYM[eastVertex]);
    assert.equal(
      west.positions[(westVertex * 3) + 2],
      east.positions[(eastVertex * 3) + 2],
    );
    assert.notEqual(west.canonicalYM[westVertex], [100, 110, 120][row]);
  }
  assert.deepEqual([...west.canonicalYM].filter((_, index) => index % 3 === 2), [2, 12, 22]);
  assert.equal(mesh.boundaryHeightOwnership, 'runtime-half-open-point-sampler');
});

test('emits a consistent positive-Z winding in presentation coordinates', () => {
  const mesh = compileCustomsLocalTerrainMesh(runtime(), scope());
  for (const patch of mesh.patches) {
    for (let offset = 0; offset < patch.indices.length; offset += 3) {
      const area = signedAreaXY(
        patch.positions,
        patch.indices[offset],
        patch.indices[offset + 1],
        patch.indices[offset + 2],
      );
      assert.ok(area > 0, `expected positive presentation XY area, received ${area}`);
    }
  }
  assert.equal(mesh.winding, 'counter-clockwise-from-presentation-plus-z');
});

test('honors crop and decimation while retaining the final source edges', () => {
  const mesh = compileCustomsLocalTerrainMesh(
    runtime(),
    scope(0.25, 3.75, 0.25, 1.75),
    { decimation: { x: 2, z: 2 } },
  );
  assert.deepEqual(mesh.decimation, { x: 2, z: 2 });
  assert.equal(mesh.patches.length, 2);
  for (const patch of mesh.patches) {
    assert.deepEqual(patch.columnIndices, [0, 2]);
    assert.deepEqual(patch.rowIndices, [0, 2]);
    assert.equal(patch.vertexCount, 4);
    assert.equal(patch.triangleCount, 2);
  }
  assert.equal(mesh.vertexCount, 8);
  assert.equal(mesh.triangleCount, 4);
});

test('keeps canonical Y separate from the fixed-2x presentation Z and emits tile-local UVs', () => {
  const mesh = compileCustomsLocalTerrainMesh(runtime(), scope());
  const west = mesh.patches.find(({ tileId }) => tileId === 'west');
  const center = 4;
  assert.equal(west.canonicalYM[center], 11);
  assert.deepEqual(vertexPosition(west, center), [-1, -1, 17]);
  assert.deepEqual([...west.controlUvs.slice(center * 2, (center * 2) + 2)], [0.5, 0.5]);

  const westSeam = 2;
  const eastSeam = 0;
  assert.equal(west.controlUvs[westSeam * 2], 1);
  assert.equal(mesh.patches.find(({ tileId }) => tileId === 'east').controlUvs[eastSeam * 2], 0);
});

test('fails when Float32 presentation quantization makes geometry degenerate', () => {
  const large = manifest();
  large.tiles = [tile('large', 100_000_000)];
  const largeRuntime = createCustomsLocalTerrainRuntime(large, {
    'large/height.f32le': float32LE([0, 1, 2, 10, 11, 12, 20, 21, 22]),
  });
  assert.throws(
    () => compileCustomsLocalTerrainMesh(
      largeRuntime,
      scope(100_000_000, 100_000_002, 0, 2),
    ),
    /degenerate or has inconsistent winding/,
  );
});

test('propagates uncovered-scope and non-finite display failures closed', () => {
  const gapped = manifest();
  gapped.tiles[1].origin.x = 2.5;
  const gappedRuntime = createCustomsLocalTerrainRuntime(gapped, new Map([
    ['west/height.f32le', float32LE([0, 1, 2, 10, 11, 12, 20, 21, 22])],
    ['east/height.f32le', float32LE([2, 3, 4, 12, 13, 14, 22, 23, 24])],
  ]));
  assert.throws(
    () => compileCustomsLocalTerrainMesh(gappedRuntime, scope(0, 4.5, 0, 2)),
    /scope.*gap near game coordinate/,
  );

  const overflow = manifest();
  overflow.reliefOriginYM = -Number.MAX_VALUE;
  const overflowRuntime = createCustomsLocalTerrainRuntime(overflow, new Map([
    ['west/height.f32le', float32LE([0, 1, 2, 10, 11, 12, 20, 21, 22])],
    ['east/height.f32le', float32LE([2, 3, 4, 12, 13, 14, 22, 23, 24])],
  ]));
  assert.throws(
    () => compileCustomsLocalTerrainMesh(overflowRuntime, scope()),
    /displayYM.*overflowed/,
  );
});
