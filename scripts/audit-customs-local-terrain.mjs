#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CUSTOMS_LOCAL_TERRAIN_DISPLAY_RELIEF_SCALE,
  CUSTOMS_LOCAL_TERRAIN_SCHEMA_VERSION,
  CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME,
  createCustomsLocalTerrainRuntime,
  customsTerrainCanonicalGridSample,
  sampleCustomsTerrainElevation,
  validateCustomsLocalTerrainManifest,
} from '../src/customs-local-terrain.js';
import { compileCustomsLocalTerrainMesh } from '../src/customs-local-terrain-mesh.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_PACKAGE_DIR = resolve(REPOSITORY_ROOT, '.local-game-derived/customs');
const DEFAULT_DATA_FILE = resolve(REPOSITORY_ROOT, 'public/data/customs-3d.json');
const FLOAT32_BYTES = 4;
const POSITION_COMPONENTS = 3;
const COORDINATE_EPSILON = 1e-8;

export const CUSTOMS_LOCAL_TERRAIN_AUDIT_EXPECTATIONS = Object.freeze({
  schemaVersion: 1,
  tileCount: 2,
  totalHeightBytes: 8_405_000,
  controlsPerTile: 3,
  layersPerTile: 12,
  vegetationTotal: 8_805,
  rawSeamMaxMismatchM: 0.30,
  renderedSeamMaxGapM: 1e-6,
  reliefOriginYM: 0,
  displayReliefScale: 2,
  reliefEquationMaxErrorM: 1e-6,
  spawnCoverageFraction: 1,
  residualMedianAbsoluteM: 0.5,
  residualP90AbsoluteM: 3,
  residualWithinToleranceM: 2.5,
  residualWithinToleranceFraction: 0.85,
});

class CustomsLocalTerrainAuditError extends Error {
  constructor(code, checkId, message) {
    super(message);
    this.name = 'CustomsLocalTerrainAuditError';
    this.code = code;
    this.checkId = checkId;
  }
}

function auditError(code, checkId, message) {
  throw new CustomsLocalTerrainAuditError(code, checkId, message);
}

function finite(value, context) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    auditError('ERR_CUSTOMS_LOCAL_TERRAIN_AUDIT_DATA', 'exact-spawn-schema', `${context} must be finite`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function closeEnough(left, right) {
  return Math.abs(left - right) <= COORDINATE_EPSILON
    * Math.max(1, Math.abs(left), Math.abs(right));
}

function check(id, label, passed, actual, expected) {
  return { id, label, pass: Boolean(passed), actual, expected };
}

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return null;
  const position = (sortedValues.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  const weight = position - lower;
  return sortedValues[lower] + ((sortedValues[upper] - sortedValues[lower]) * weight);
}

function boundsFor(tile) {
  return {
    minX: tile.origin.x,
    maxX: tile.origin.x + ((tile.resolution.columns - 1) * tile.sampleSpacingM.x),
    minZ: tile.origin.z,
    maxZ: tile.origin.z + ((tile.resolution.rows - 1) * tile.sampleSpacingM.z),
  };
}

function sharedSeams(manifest) {
  const seams = [];
  for (let firstIndex = 0; firstIndex < manifest.tiles.length; firstIndex += 1) {
    const first = manifest.tiles[firstIndex];
    const firstBounds = boundsFor(first);
    for (let secondIndex = firstIndex + 1; secondIndex < manifest.tiles.length; secondIndex += 1) {
      const second = manifest.tiles[secondIndex];
      const secondBounds = boundsFor(second);
      const overlapZMin = Math.max(firstBounds.minZ, secondBounds.minZ);
      const overlapZMax = Math.min(firstBounds.maxZ, secondBounds.maxZ);
      const overlapXMin = Math.max(firstBounds.minX, secondBounds.minX);
      const overlapXMax = Math.min(firstBounds.maxX, secondBounds.maxX);

      if (overlapZMax > overlapZMin && closeEnough(firstBounds.maxX, secondBounds.minX)) {
        seams.push({
          orientation: 'vertical',
          coordinate: firstBounds.maxX,
          overlapMin: overlapZMin,
          overlapMax: overlapZMax,
          negativeTile: first,
          positiveTile: second,
        });
      } else if (overlapZMax > overlapZMin && closeEnough(secondBounds.maxX, firstBounds.minX)) {
        seams.push({
          orientation: 'vertical',
          coordinate: secondBounds.maxX,
          overlapMin: overlapZMin,
          overlapMax: overlapZMax,
          negativeTile: second,
          positiveTile: first,
        });
      }

      if (overlapXMax > overlapXMin && closeEnough(firstBounds.maxZ, secondBounds.minZ)) {
        seams.push({
          orientation: 'horizontal',
          coordinate: firstBounds.maxZ,
          overlapMin: overlapXMin,
          overlapMax: overlapXMax,
          negativeTile: first,
          positiveTile: second,
        });
      } else if (overlapXMax > overlapXMin && closeEnough(secondBounds.maxZ, firstBounds.minZ)) {
        seams.push({
          orientation: 'horizontal',
          coordinate: secondBounds.maxZ,
          overlapMin: overlapXMin,
          overlapMax: overlapXMax,
          negativeTile: second,
          positiveTile: first,
        });
      }
    }
  }
  return seams;
}

function rawSeamStatistics(runtime, seams) {
  const perSeam = [];
  const allMismatches = [];
  for (const seam of seams) {
    const { negativeTile, positiveTile } = seam;
    const mismatches = [];
    if (seam.orientation === 'vertical') {
      const negativeColumn = negativeTile.resolution.columns - 1;
      for (let row = 0; row < negativeTile.resolution.rows; row += 1) {
        const coordinate = negativeTile.origin.z + (row * negativeTile.sampleSpacingM.z);
        if (coordinate < seam.overlapMin - COORDINATE_EPSILON
          || coordinate > seam.overlapMax + COORDINATE_EPSILON) continue;
        const positiveRowFloat = (coordinate - positiveTile.origin.z) / positiveTile.sampleSpacingM.z;
        const positiveRow = Math.round(positiveRowFloat);
        if (!closeEnough(positiveRowFloat, positiveRow)
          || positiveRow < 0 || positiveRow >= positiveTile.resolution.rows) continue;
        const left = customsTerrainCanonicalGridSample(runtime, negativeTile.id, negativeColumn, row);
        const right = customsTerrainCanonicalGridSample(runtime, positiveTile.id, 0, positiveRow);
        mismatches.push(Math.abs(left - right));
      }
    } else {
      const negativeRow = negativeTile.resolution.rows - 1;
      for (let column = 0; column < negativeTile.resolution.columns; column += 1) {
        const coordinate = negativeTile.origin.x + (column * negativeTile.sampleSpacingM.x);
        if (coordinate < seam.overlapMin - COORDINATE_EPSILON
          || coordinate > seam.overlapMax + COORDINATE_EPSILON) continue;
        const positiveColumnFloat = (coordinate - positiveTile.origin.x) / positiveTile.sampleSpacingM.x;
        const positiveColumn = Math.round(positiveColumnFloat);
        if (!closeEnough(positiveColumnFloat, positiveColumn)
          || positiveColumn < 0 || positiveColumn >= positiveTile.resolution.columns) continue;
        const near = customsTerrainCanonicalGridSample(runtime, negativeTile.id, column, negativeRow);
        const far = customsTerrainCanonicalGridSample(runtime, positiveTile.id, positiveColumn, 0);
        mismatches.push(Math.abs(near - far));
      }
    }
    allMismatches.push(...mismatches);
    perSeam.push({
      tiles: [negativeTile.id, positiveTile.id],
      orientation: seam.orientation,
      coordinate: seam.coordinate,
      comparisonCount: mismatches.length,
      maxMismatchM: mismatches.length ? Math.max(...mismatches) : null,
      meanMismatchM: mismatches.length
        ? mismatches.reduce((total, value) => total + value, 0) / mismatches.length
        : null,
    });
  }
  return {
    seamCount: seams.length,
    comparisonCount: allMismatches.length,
    maxMismatchM: allMismatches.length ? Math.max(...allMismatches) : null,
    meanMismatchM: allMismatches.length
      ? allMismatches.reduce((total, value) => total + value, 0) / allMismatches.length
      : null,
    seams: perSeam,
  };
}

function smallSeamScope(seam) {
  const crossSpacing = seam.orientation === 'vertical'
    ? Math.min(positiveSpacing(seam.negativeTile.sampleSpacingM.x), positiveSpacing(seam.positiveTile.sampleSpacingM.x))
    : Math.min(positiveSpacing(seam.negativeTile.sampleSpacingM.z), positiveSpacing(seam.positiveTile.sampleSpacingM.z));
  const alongSpacing = seam.orientation === 'vertical'
    ? Math.min(positiveSpacing(seam.negativeTile.sampleSpacingM.z), positiveSpacing(seam.positiveTile.sampleSpacingM.z))
    : Math.min(positiveSpacing(seam.negativeTile.sampleSpacingM.x), positiveSpacing(seam.positiveTile.sampleSpacingM.x));
  const overlapLength = seam.overlapMax - seam.overlapMin;
  const center = (seam.overlapMin + seam.overlapMax) / 2;
  const alongHalf = Math.min(alongSpacing * 1.25, overlapLength / 4);
  const crossHalf = crossSpacing * 0.25;
  if (!(alongHalf > 0) || !(crossHalf > 0)) {
    auditError('ERR_CUSTOMS_LOCAL_TERRAIN_AUDIT_SEAM', 'rendered-seam-gap', 'shared seam is too small to compile');
  }
  return seam.orientation === 'vertical'
    ? {
      sourceFrame: CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME,
      minX: seam.coordinate - crossHalf,
      maxX: seam.coordinate + crossHalf,
      minZ: center - alongHalf,
      maxZ: center + alongHalf,
    }
    : {
      sourceFrame: CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME,
      minX: center - alongHalf,
      maxX: center + alongHalf,
      minZ: seam.coordinate - crossHalf,
      maxZ: seam.coordinate + crossHalf,
    };
}

function positiveSpacing(value) {
  return Number.isFinite(value) && value > 0 ? value : Number.NaN;
}

function compiledSeamStatistics(runtime, seams, meshCompiler) {
  if (seams.length === 0) {
    return {
      scope: null,
      patchCount: 0,
      duplicatePairCount: 0,
      maxGapM: null,
      reliefEquationMaxErrorM: null,
      displayReliefScale: null,
      reliefOriginYM: runtime.manifest.reliefOriginYM,
    };
  }
  const seam = [...seams].sort(
    (left, right) => (right.overlapMax - right.overlapMin) - (left.overlapMax - left.overlapMin),
  )[0];
  const scope = smallSeamScope(seam);
  const mesh = meshCompiler(runtime, scope, { decimation: 1 });
  const verticesByHorizontalPosition = new Map();
  let reliefEquationMaxErrorM = 0;

  for (const patch of mesh.patches) {
    for (let vertex = 0; vertex < patch.vertexCount; vertex += 1) {
      const offset = vertex * POSITION_COMPONENTS;
      const presentationX = patch.positions[offset];
      const presentationY = patch.positions[offset + 1];
      const presentationZ = patch.positions[offset + 2];
      const expectedDisplay = Math.fround(patch.canonicalYM[vertex] * 2);
      reliefEquationMaxErrorM = Math.max(
        reliefEquationMaxErrorM,
        Math.abs(presentationZ - expectedDisplay),
      );
      const key = `${presentationX.toPrecision(12)}:${presentationY.toPrecision(12)}`;
      if (!verticesByHorizontalPosition.has(key)) verticesByHorizontalPosition.set(key, []);
      verticesByHorizontalPosition.get(key).push({
        tileId: patch.tileId,
        x: presentationX,
        y: presentationY,
        z: presentationZ,
      });
    }
  }

  const gaps = [];
  for (const vertices of verticesByHorizontalPosition.values()) {
    for (let first = 0; first < vertices.length; first += 1) {
      for (let second = first + 1; second < vertices.length; second += 1) {
        const left = vertices[first];
        const right = vertices[second];
        if (left.tileId === right.tileId) continue;
        gaps.push(Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z));
      }
    }
  }

  return {
    scope,
    patchCount: mesh.patches.length,
    duplicatePairCount: gaps.length,
    maxGapM: gaps.length ? Math.max(...gaps) : null,
    reliefEquationMaxErrorM,
    displayReliefScale: mesh.presentationCoordinates.displayReliefScale,
    reliefOriginYM: mesh.presentationCoordinates.reliefOriginYM,
  };
}

function exactSpawnPositions(data) {
  const spawns = data?.exact?.collections?.spawns;
  if (!Array.isArray(spawns) || spawns.length === 0) {
    auditError(
      'ERR_CUSTOMS_LOCAL_TERRAIN_AUDIT_DATA',
      'exact-spawn-schema',
      'customs-3d exact.collections.spawns must be a non-empty array',
    );
  }
  return spawns.map((spawn, index) => {
    const position = spawn?.raw?.position;
    return {
      sourceId: typeof spawn?.sourceId === 'string' ? spawn.sourceId : `spawns[${index}]`,
      x: finite(position?.x, `spawns[${index}].raw.position.x`),
      y: finite(position?.y, `spawns[${index}].raw.position.y`),
      z: finite(position?.z, `spawns[${index}].raw.position.z`),
    };
  });
}

function spawnStatistics(runtime, spawns, toleranceM) {
  const residuals = [];
  const uncovered = [];
  const elevated = [];
  for (const spawn of spawns) {
    try {
      const terrain = sampleCustomsTerrainElevation(runtime, {
        sourceFrame: CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME,
        x: spawn.x,
        z: spawn.z,
      });
      const observedMinusTerrainM = spawn.y - terrain.canonicalYM;
      const absoluteM = Math.abs(observedMinusTerrainM);
      residuals.push({ ...spawn, terrainYM: terrain.canonicalYM, observedMinusTerrainM, absoluteM });
      if (observedMinusTerrainM > toleranceM) elevated.push(spawn.sourceId);
    } catch (error) {
      uncovered.push({ sourceId: spawn.sourceId, x: spawn.x, z: spawn.z });
    }
  }
  const absolute = residuals.map(({ absoluteM }) => absoluteM).sort((left, right) => left - right);
  const withinCount = absolute.filter((value) => value <= toleranceM).length;
  return {
    totalCount: spawns.length,
    coveredCount: residuals.length,
    coverageFraction: residuals.length / spawns.length,
    uncoveredCount: uncovered.length,
    uncovered,
    residualCount: residuals.length,
    residualDefinition: 'abs(exact spawn worldY - sampled canonical terrain worldY)',
    medianAbsoluteM: percentile(absolute, 0.5),
    p90AbsoluteM: percentile(absolute, 0.9),
    withinToleranceM: toleranceM,
    withinToleranceCount: withinCount,
    withinToleranceFraction: absolute.length ? withinCount / absolute.length : 0,
    elevatedAcknowledgement: {
      definition: `exact spawn worldY exceeds canonical terrain by more than ${toleranceM}m`,
      count: elevated.length,
      sourceIds: elevated,
      includedInResidualMetrics: true,
    },
  };
}

async function readJson(path, checkId) {
  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    auditError(
      'ERR_CUSTOMS_LOCAL_TERRAIN_AUDIT_INPUT',
      checkId,
      `${checkId} could not be read as JSON: ${error.message}`,
    );
  }
  return value;
}

function failureReport(error) {
  return {
    audit: 'customs-local-terrain-accuracy',
    reportSchemaVersion: 1,
    pass: false,
    status: 'error',
    checks: [
      check(
        error?.checkId || 'audit-execution',
        'Audit completed without structural or input errors',
        false,
        error?.code || error?.name || 'Error',
        'valid local package and exact spawn fixture',
      ),
    ],
    error: {
      name: error?.name || 'Error',
      code: error?.code || 'ERR_CUSTOMS_LOCAL_TERRAIN_AUDIT',
      message: error?.message || String(error),
    },
  };
}

async function auditImplementation({
  packageDir,
  dataFile,
  expectations,
  meshCompiler,
}) {
  const manifestValue = await readJson(join(packageDir, 'manifest.json'), 'manifest-schema');
  let manifest;
  try {
    manifest = validateCustomsLocalTerrainManifest(manifestValue);
  } catch (error) {
    error.checkId = 'manifest-schema';
    throw error;
  }

  const controlsPerTile = manifest.tiles.map((tile) => ({ id: tile.id, count: tile.controlMaps.length }));
  const layersPerTile = manifest.tiles.map((tile) => ({ id: tile.id, count: tile.layers.length }));
  const vegetationTotal = manifest.tiles.reduce(
    (total, tile) => total + (tile.vegetation?.count || 0),
    0,
  );
  const heightFiles = new Map();
  const heightByteLengths = [];
  for (const tile of manifest.tiles) {
    let bytes;
    try {
      bytes = await readFile(join(packageDir, tile.heightFile));
    } catch (error) {
      auditError(
        'ERR_CUSTOMS_LOCAL_TERRAIN_AUDIT_INPUT',
        'height-byte-lengths',
        `could not read ${tile.heightFile}: ${error.message}`,
      );
    }
    heightFiles.set(tile.heightFile, bytes);
    heightByteLengths.push({
      id: tile.id,
      file: tile.heightFile,
      actualBytes: bytes.byteLength,
      expectedBytes: tile.resolution.columns * tile.resolution.rows * FLOAT32_BYTES,
    });
  }
  const totalHeightBytes = heightByteLengths.reduce((total, tile) => total + tile.actualBytes, 0);

  const checks = [
    check(
      'manifest-schema',
      'Manifest satisfies the strict Customs local-terrain schema',
      manifest.schemaVersion === expectations.schemaVersion
        && manifest.schemaVersion === CUSTOMS_LOCAL_TERRAIN_SCHEMA_VERSION,
      manifest.schemaVersion,
      expectations.schemaVersion,
    ),
    check(
      'tile-count',
      'Manifest declares the expected terrain tile count',
      manifest.tiles.length === expectations.tileCount,
      manifest.tiles.length,
      expectations.tileCount,
    ),
    check(
      'height-byte-lengths',
      'Every height buffer has exactly rows*columns*4 bytes',
      heightByteLengths.every((tile) => tile.actualBytes === tile.expectedBytes),
      heightByteLengths,
      'actualBytes === expectedBytes for every tile',
    ),
    check(
      'height-byte-total',
      'Total canonical height bytes match the certified Customs package',
      totalHeightBytes === expectations.totalHeightBytes,
      totalHeightBytes,
      expectations.totalHeightBytes,
    ),
    check(
      'control-map-counts',
      'Every tile declares exactly three RGBA control maps',
      controlsPerTile.every(({ count }) => count === expectations.controlsPerTile),
      controlsPerTile,
      expectations.controlsPerTile,
    ),
    check(
      'layer-counts',
      'Every tile consumes all twelve control-map channels',
      layersPerTile.every(({ count }) => count === expectations.layersPerTile),
      layersPerTile,
      expectations.layersPerTile,
    ),
    check(
      'vegetation-total',
      'Declared vegetation count matches the certified Customs package',
      vegetationTotal === expectations.vegetationTotal,
      vegetationTotal,
      expectations.vegetationTotal,
    ),
  ];

  if (!heightByteLengths.every((tile) => tile.actualBytes === tile.expectedBytes)) {
    return {
      audit: 'customs-local-terrain-accuracy',
      reportSchemaVersion: 1,
      pass: false,
      status: 'fail',
      thresholds: expectations,
      metrics: {
        manifest: { schemaVersion: manifest.schemaVersion, tileCount: manifest.tiles.length },
        heightBuffers: { totalBytes: totalHeightBytes, tiles: heightByteLengths },
        controlsPerTile,
        layersPerTile,
        declaredVegetationTotal: vegetationTotal,
      },
      checks,
    };
  }

  let runtime;
  try {
    runtime = createCustomsLocalTerrainRuntime(manifest, heightFiles);
  } catch (error) {
    error.checkId = error.checkId || 'height-decode';
    throw error;
  }
  const seams = sharedSeams(manifest);
  const rawSeams = rawSeamStatistics(runtime, seams);
  const renderedSeam = compiledSeamStatistics(runtime, seams, meshCompiler);
  const data = await readJson(dataFile, 'exact-spawn-schema');
  const spawns = exactSpawnPositions(data);
  const spawnMetrics = spawnStatistics(
    runtime,
    spawns,
    expectations.residualWithinToleranceM,
  );

  checks.push(
    check(
      'raw-seam-max',
      'Raw shared-edge sample mismatch remains within tolerance',
      rawSeams.comparisonCount > 0
        && rawSeams.maxMismatchM <= expectations.rawSeamMaxMismatchM,
      rawSeams.maxMismatchM,
      `<= ${expectations.rawSeamMaxMismatchM}m with at least one comparison`,
    ),
    check(
      'rendered-seam-gap',
      'Compiled duplicate seam vertices are visually coincident',
      renderedSeam.duplicatePairCount > 0
        && renderedSeam.maxGapM <= expectations.renderedSeamMaxGapM,
      {
        duplicatePairCount: renderedSeam.duplicatePairCount,
        maxGapM: renderedSeam.maxGapM,
      },
      `duplicatePairCount > 0 and maxGapM <= ${expectations.renderedSeamMaxGapM}`,
    ),
    check(
      'relief-origin',
      'Relief origin remains zero metres',
      renderedSeam.reliefOriginYM === expectations.reliefOriginYM,
      renderedSeam.reliefOriginYM,
      expectations.reliefOriginYM,
    ),
    check(
      'relief-scale',
      'Display relief remains fixed at exactly 2x',
      renderedSeam.displayReliefScale === expectations.displayReliefScale
        && CUSTOMS_LOCAL_TERRAIN_DISPLAY_RELIEF_SCALE === expectations.displayReliefScale,
      renderedSeam.displayReliefScale,
      expectations.displayReliefScale,
    ),
    check(
      'relief-equation',
      'Compiled display Y equals Float32(canonical Y * 2)',
      renderedSeam.reliefEquationMaxErrorM !== null
        && renderedSeam.reliefEquationMaxErrorM <= expectations.reliefEquationMaxErrorM,
      renderedSeam.reliefEquationMaxErrorM,
      `<= ${expectations.reliefEquationMaxErrorM}m`,
    ),
    check(
      'spawn-xz-coverage',
      'Every exact spawn X/Z lies on the local terrain runtime',
      spawnMetrics.coverageFraction === expectations.spawnCoverageFraction,
      {
        covered: spawnMetrics.coveredCount,
        total: spawnMetrics.totalCount,
        fraction: spawnMetrics.coverageFraction,
      },
      expectations.spawnCoverageFraction,
    ),
    check(
      'residual-median-absolute',
      'Median absolute spawn-to-terrain residual is certified',
      spawnMetrics.medianAbsoluteM !== null
        && spawnMetrics.medianAbsoluteM <= expectations.residualMedianAbsoluteM,
      spawnMetrics.medianAbsoluteM,
      `<= ${expectations.residualMedianAbsoluteM}m`,
    ),
    check(
      'residual-p90-absolute',
      'P90 absolute spawn-to-terrain residual is certified',
      spawnMetrics.p90AbsoluteM !== null
        && spawnMetrics.p90AbsoluteM <= expectations.residualP90AbsoluteM,
      spawnMetrics.p90AbsoluteM,
      `<= ${expectations.residualP90AbsoluteM}m`,
    ),
    check(
      'residual-within-tolerance',
      'Required share of spawn residuals is within 2.5 metres',
      spawnMetrics.withinToleranceFraction >= expectations.residualWithinToleranceFraction,
      spawnMetrics.withinToleranceFraction,
      `>= ${expectations.residualWithinToleranceFraction} within ${expectations.residualWithinToleranceM}m`,
    ),
  );

  const passed = checks.every((entry) => entry.pass);
  return {
    audit: 'customs-local-terrain-accuracy',
    reportSchemaVersion: 1,
    pass: passed,
    status: passed ? 'pass' : 'fail',
    thresholds: expectations,
    metrics: {
      manifest: {
        schemaVersion: manifest.schemaVersion,
        map: manifest.map,
        localOnly: manifest.localOnly,
        tileCount: manifest.tiles.length,
      },
      heightBuffers: { totalBytes: totalHeightBytes, tiles: heightByteLengths },
      controlsPerTile,
      layersPerTile,
      declaredVegetationTotal: vegetationTotal,
      rawSharedEdges: rawSeams,
      renderedSeam,
      relief: {
        originYM: renderedSeam.reliefOriginYM,
        displayScale: renderedSeam.displayReliefScale,
        equation: 'displayYM = canonicalYM * 2 because reliefOriginYM = 0',
        equationMaxErrorM: renderedSeam.reliefEquationMaxErrorM,
      },
      exactSpawns: spawnMetrics,
    },
    checks,
  };
}

export async function auditCustomsLocalTerrain(options = {}) {
  const packageDir = resolve(options.packageDir || DEFAULT_PACKAGE_DIR);
  const dataFile = resolve(options.dataFile || DEFAULT_DATA_FILE);
  const expectations = Object.freeze({
    ...CUSTOMS_LOCAL_TERRAIN_AUDIT_EXPECTATIONS,
    ...(options.expectations || {}),
  });
  const meshCompiler = options.meshCompiler || compileCustomsLocalTerrainMesh;
  try {
    return await auditImplementation({ packageDir, dataFile, expectations, meshCompiler });
  } catch (error) {
    return failureReport(error);
  }
}

function parseArguments(argv) {
  let packageDir = DEFAULT_PACKAGE_DIR;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      help = true;
      continue;
    }
    if (argument === '--package-dir') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        auditError('ERR_CUSTOMS_LOCAL_TERRAIN_AUDIT_ARGS', 'cli-arguments', '--package-dir requires a path');
      }
      packageDir = isAbsolute(value) ? value : resolve(process.cwd(), value);
      index += 1;
      continue;
    }
    auditError('ERR_CUSTOMS_LOCAL_TERRAIN_AUDIT_ARGS', 'cli-arguments', `unsupported argument: ${argument}`);
  }
  return { packageDir, help };
}

async function main() {
  let parsed;
  try {
    parsed = parseArguments(process.argv.slice(2));
  } catch (error) {
    const report = failureReport(error);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }
  if (parsed.help) {
    process.stdout.write(`${JSON.stringify({
      audit: 'customs-local-terrain-accuracy',
      usage: 'node scripts/audit-customs-local-terrain.mjs [--package-dir PATH]',
      defaultPackageDir: '.local-game-derived/customs',
      writesFiles: false,
    }, null, 2)}\n`);
    return;
  }
  const report = await auditCustomsLocalTerrain({ packageDir: parsed.packageDir });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.pass ? 0 : 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) await main();
