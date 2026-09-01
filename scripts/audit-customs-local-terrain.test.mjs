import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  CUSTOMS_LOCAL_TERRAIN_AUDIT_EXPECTATIONS,
  auditCustomsLocalTerrain,
} from './audit-customs-local-terrain.mjs';
import { compileCustomsLocalTerrainMesh } from '../src/customs-local-terrain-mesh.js';

const SOURCE_FRAME = 'eft-unity-world-metres-y-up';
const HEIGHT_ENCODING = {
  storage: 'float32le',
  endianness: 'little',
  scalarType: 'float32',
  sampleOrder: 'row-major-z-times-columns-plus-x',
  values: 'canonical-world-y-metres',
};
const CHANNELS = ['r', 'g', 'b', 'a'];

function controls(tileId, count = 3) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${tileId}-control-${index}`,
    file: `${tileId}-control-${index}.png`,
    channels: CHANNELS,
    width: 2,
    height: 2,
    columnOrder: 'x-min-to-x-max',
    rowOrder: 'z-min-to-z-max',
  }));
}

function layers(tileId, count = 12) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${tileId}-layer-${String(index).padStart(2, '0')}`,
    name: `Synthetic layer ${index}`,
    index,
    controlMapId: `${tileId}-control-${Math.floor(index / 4)}`,
    channel: CHANNELS[index % 4],
  }));
}

function tile(id, x, vegetationCount, options = {}) {
  return {
    id,
    origin: { x, y: 0, z: 0 },
    resolution: { columns: 3, rows: 3 },
    sampleSpacingM: { x: 1, z: 1 },
    heightEncoding: HEIGHT_ENCODING,
    heightFile: `${id}-height.f32le`,
    controlMaps: controls(id, options.controlCount ?? 3),
    layers: layers(id, options.layerCount ?? 12),
    vegetation: {
      file: `${id}-vegetation.json`,
      format: 'json',
      count: vegetationCount,
      prototypes: vegetationCount > 0 ? [{ id: `${id}-tree`, name: 'Synthetic tree' }] : [],
    },
  };
}

function float32Bytes(values) {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}

function surfaceY(x, z) {
  return x + z;
}

function syntheticSpawns(offsets = [4, ...Array(19).fill(0)]) {
  return offsets.map((offset, index) => {
    const x = 0.25 + ((index % 8) * 0.5);
    const z = 0.25 + ((Math.floor(index / 8) % 3) * 0.5);
    return {
      sourceId: `synthetic-spawn-${index}`,
      raw: {
        position: { x, y: surfaceY(x, z) + offset, z },
      },
    };
  });
}

async function makeFixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tarkovzero-local-terrain-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageDir = join(root, 'package');
  await mkdir(packageDir);

  const firstTile = tile('tile-a', 0, options.firstVegetation ?? 2, {
    controlCount: options.controlCount,
    layerCount: options.layerCount,
  });
  const secondTile = tile('tile-b', 2, options.secondVegetation ?? 3, {
    controlCount: options.controlCount,
    layerCount: options.layerCount,
  });
  const manifest = {
    schemaVersion: options.schemaVersion ?? 1,
    map: 'customs',
    localOnly: true,
    sourceFrame: SOURCE_FRAME,
    reliefOriginYM: options.reliefOriginYM ?? 0,
    tiles: options.tileCount === 1 ? [firstTile] : [firstTile, secondTile],
  };

  const mismatch = options.rawSeamMismatchM ?? 0;
  const firstHeights = [
    0, 1, 2 + mismatch,
    1, 2, 3 + mismatch,
    2, 3, 4 + mismatch,
  ];
  const secondHeights = [
    2, 3, 4,
    3, 4, 5,
    4, 5, 6,
  ];
  await writeFile(join(packageDir, 'manifest.json'), JSON.stringify(manifest));
  const firstBytes = float32Bytes(firstHeights);
  await writeFile(
    join(packageDir, firstTile.heightFile),
    options.truncateFirstHeight ? firstBytes.subarray(0, firstBytes.length - 4) : firstBytes,
  );
  if (manifest.tiles.length > 1) {
    await writeFile(join(packageDir, secondTile.heightFile), float32Bytes(secondHeights));
  }

  const spawns = syntheticSpawns(options.residualOffsets);
  if (options.uncoveredSpawn) {
    spawns.push({
      sourceId: 'synthetic-uncovered',
      raw: { position: { x: 99, y: 0, z: 99 } },
    });
  }
  const dataFile = join(root, 'customs-3d.json');
  await writeFile(dataFile, JSON.stringify({ exact: { collections: { spawns } } }));
  const expectations = {
    ...CUSTOMS_LOCAL_TERRAIN_AUDIT_EXPECTATIONS,
    totalHeightBytes: options.tileCount === 1 ? 36 : 72,
    vegetationTotal: 5,
  };
  return { root, packageDir, dataFile, expectations };
}

function failed(report, id) {
  return report.checks.find((entry) => entry.id === id && !entry.pass);
}

test('synthetic two-tile package passes every local terrain accuracy gate', async (t) => {
  const fixture = await makeFixture(t);
  const before = (await readdir(fixture.packageDir)).sort();
  const report = await auditCustomsLocalTerrain(fixture);
  const after = (await readdir(fixture.packageDir)).sort();

  assert.equal(report.pass, true);
  assert.equal(report.status, 'pass');
  assert.ok(report.checks.every((entry) => entry.pass));
  assert.deepEqual(after, before, 'audit must not write into the package');
  assert.equal(report.metrics.rawSharedEdges.comparisonCount, 3);
  assert.equal(report.metrics.rawSharedEdges.maxMismatchM, 0);
  assert.ok(report.metrics.renderedSeam.duplicatePairCount > 0);
  assert.equal(report.metrics.renderedSeam.maxGapM, 0);
  assert.equal(report.metrics.relief.equationMaxErrorM, 0);
  assert.equal(report.metrics.exactSpawns.coverageFraction, 1);
  assert.equal(report.metrics.exactSpawns.elevatedAcknowledgement.count, 1);
  assert.equal(report.metrics.exactSpawns.elevatedAcknowledgement.includedInResidualMetrics, true);
});

test('invalid manifest schema fails closed', async (t) => {
  const fixture = await makeFixture(t, { schemaVersion: 2 });
  const report = await auditCustomsLocalTerrain(fixture);
  assert.equal(report.pass, false);
  assert.ok(failed(report, 'manifest-schema'));
});

test('unexpected tile count fails', async (t) => {
  const fixture = await makeFixture(t, { tileCount: 1 });
  fixture.expectations.tileCount = 2;
  const report = await auditCustomsLocalTerrain(fixture);
  assert.ok(failed(report, 'tile-count'));
});

test('truncated height bytes fail before runtime hydration', async (t) => {
  const fixture = await makeFixture(t, { truncateFirstHeight: true });
  const report = await auditCustomsLocalTerrain(fixture);
  assert.ok(failed(report, 'height-byte-lengths'));
  assert.equal(report.metrics.rawSharedEdges, undefined);
});

test('wrong control-map count fails the strict manifest contract', async (t) => {
  const fixture = await makeFixture(t, { controlCount: 2, layerCount: 8 });
  const report = await auditCustomsLocalTerrain(fixture);
  assert.ok(failed(report, 'manifest-schema'));
});

test('fewer than twelve declared layers fails the layer gate', async (t) => {
  const fixture = await makeFixture(t, { layerCount: 11 });
  const report = await auditCustomsLocalTerrain(fixture);
  assert.ok(failed(report, 'layer-counts'));
});

test('wrong declared vegetation total fails', async (t) => {
  const fixture = await makeFixture(t, { secondVegetation: 4 });
  const report = await auditCustomsLocalTerrain(fixture);
  assert.ok(failed(report, 'vegetation-total'));
});

test('raw shared-edge disagreement above 0.30m fails', async (t) => {
  const fixture = await makeFixture(t, { rawSeamMismatchM: 0.31 });
  const report = await auditCustomsLocalTerrain(fixture);
  assert.ok(failed(report, 'raw-seam-max'));
  assert.ok(report.metrics.rawSharedEdges.meanMismatchM > 0.30);
});

test('compiled duplicate seam displacement above one micrometre fails', async (t) => {
  const fixture = await makeFixture(t);
  const meshCompiler = (runtime, scope, options) => {
    const mesh = compileCustomsLocalTerrainMesh(runtime, scope, options);
    const shifted = mesh.patches[1];
    for (let vertex = 0; vertex < shifted.vertexCount; vertex += 1) {
      shifted.positions[(vertex * 3) + 2] += 0.01;
    }
    return mesh;
  };
  const report = await auditCustomsLocalTerrain({ ...fixture, meshCompiler });
  assert.ok(failed(report, 'rendered-seam-gap'));
});

test('non-zero relief origin fails the canonical-times-two display contract', async (t) => {
  const fixture = await makeFixture(t, { reliefOriginYM: 1 });
  const report = await auditCustomsLocalTerrain(fixture);
  assert.ok(failed(report, 'relief-origin'));
  assert.ok(failed(report, 'relief-equation'));
});

test('an uncovered exact spawn fails 100% X/Z coverage', async (t) => {
  const fixture = await makeFixture(t, { uncoveredSpawn: true });
  const report = await auditCustomsLocalTerrain(fixture);
  assert.ok(failed(report, 'spawn-xz-coverage'));
  assert.equal(report.metrics.exactSpawns.uncoveredCount, 1);
});

test('median absolute residual above 0.5m fails independently', async (t) => {
  const fixture = await makeFixture(t, {
    residualOffsets: [...Array(11).fill(1), ...Array(9).fill(0)],
  });
  const report = await auditCustomsLocalTerrain(fixture);
  assert.ok(failed(report, 'residual-median-absolute'));
  assert.equal(failed(report, 'residual-p90-absolute'), undefined);
  assert.equal(failed(report, 'residual-within-tolerance'), undefined);
});

test('P90 absolute residual above 3m fails while 85% remain within tolerance', async (t) => {
  const fixture = await makeFixture(t, {
    residualOffsets: [...Array(3).fill(4), ...Array(17).fill(0)],
  });
  const report = await auditCustomsLocalTerrain(fixture);
  assert.ok(failed(report, 'residual-p90-absolute'));
  assert.equal(report.metrics.exactSpawns.withinToleranceFraction, 0.85);
  assert.equal(failed(report, 'residual-within-tolerance'), undefined);
});

test('fewer than 85% of residuals within 2.5m fails independently of P90', async (t) => {
  const fixture = await makeFixture(t, {
    residualOffsets: [...Array(4).fill(2.6), ...Array(16).fill(0)],
  });
  const report = await auditCustomsLocalTerrain(fixture);
  assert.ok(failed(report, 'residual-within-tolerance'));
  assert.ok(report.metrics.exactSpawns.p90AbsoluteM <= 3);
  assert.equal(failed(report, 'residual-p90-absolute'), undefined);
});
