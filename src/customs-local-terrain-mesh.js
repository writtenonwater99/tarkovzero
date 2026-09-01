// Renderer-neutral typed geometry compiled from the local Customs terrain runtime.
// No Three or DOM dependency belongs here; presentation coordinates are plain arrays.

import {
  CUSTOMS_LOCAL_TERRAIN_DISPLAY_RELIEF_SCALE,
  CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME,
  planCustomsTerrainMesh,
  sampleCustomsTerrainElevation,
} from './customs-local-terrain.js';

export const CUSTOMS_TERRAIN_PRESENTATION_FRAME = 'tarkovzero-three-negx-negz-z-up';

const MAX_UINT32_INDEX = 0xffffffff;
const CONTROL_COLUMN_ORDER = 'x-min-to-x-max';
const CONTROL_ROW_ORDER = 'z-min-to-z-max';

export class CustomsLocalTerrainMeshError extends Error {
  constructor(code, path, message) {
    super(`${path}: ${message}`);
    this.name = 'CustomsLocalTerrainMeshError';
    this.code = code;
    this.path = path;
  }
}

function fail(code, path, message) {
  throw new CustomsLocalTerrainMeshError(code, path, message);
}

function finiteNumber(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('ERR_CUSTOMS_TERRAIN_MESH_NON_FINITE', path, 'must be finite');
  }
  return Object.is(value, -0) ? 0 : value;
}

function finiteFloat32(value, path) {
  const number = finiteNumber(value, path);
  const float = Math.fround(number);
  if (!Number.isFinite(float)) {
    fail('ERR_CUSTOMS_TERRAIN_MESH_NON_FINITE', path, 'cannot be represented as Float32');
  }
  return Object.is(float, -0) ? 0 : float;
}

function safeTypedArrayLength(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('ERR_CUSTOMS_TERRAIN_MESH_SIZE', path, 'must be a non-negative safe integer');
  }
  return value;
}

function tileForPatch(runtime, patch, path) {
  const tiles = runtime?.manifest?.tiles;
  if (!Array.isArray(tiles)) {
    fail('ERR_CUSTOMS_TERRAIN_MESH_RUNTIME', 'runtime', 'must be a hydrated Customs terrain runtime');
  }
  const tile = tiles.find(({ id }) => id === patch.tileId);
  if (!tile) fail('ERR_CUSTOMS_TERRAIN_MESH_RUNTIME', path, `references missing tile ${patch.tileId}`);
  return tile;
}

function signedPresentationAreaXY(positions, first, second, third) {
  const ax = positions[first * 3];
  const ay = positions[(first * 3) + 1];
  const bx = positions[second * 3];
  const by = positions[(second * 3) + 1];
  const cx = positions[third * 3];
  const cy = positions[(third * 3) + 1];
  return ((bx - ax) * (cy - ay)) - ((by - ay) * (cx - ax));
}

function writeTriangle(indices, offset, positions, a, b, c, path) {
  const area = signedPresentationAreaXY(positions, a, b, c);
  if (!Number.isFinite(area) || !(area > 0)) {
    fail(
      'ERR_CUSTOMS_TERRAIN_MESH_DEGENERATE',
      path,
      `triangle (${a}, ${b}, ${c}) is degenerate or has inconsistent winding`,
    );
  }
  indices[offset] = a;
  indices[offset + 1] = b;
  indices[offset + 2] = c;
}

function compilePatch(runtime, patch, patchIndex) {
  const path = `patches[${patchIndex}]`;
  const tile = tileForPatch(runtime, patch, path);
  const vertexColumns = patch.columnIndices.length;
  const vertexRows = patch.rowIndices.length;
  if (vertexColumns < 2 || vertexRows < 2) {
    fail('ERR_CUSTOMS_TERRAIN_MESH_DEGENERATE', path, 'must have at least two rows and columns');
  }
  const vertexCount = safeTypedArrayLength(vertexColumns * vertexRows, `${path}.vertexCount`);
  if (vertexCount > MAX_UINT32_INDEX) {
    fail('ERR_CUSTOMS_TERRAIN_MESH_SIZE', `${path}.vertexCount`, 'exceeds Uint32 indexing');
  }
  const triangleCount = safeTypedArrayLength(
    (vertexColumns - 1) * (vertexRows - 1) * 2,
    `${path}.triangleCount`,
  );
  const positions = new Float32Array(safeTypedArrayLength(vertexCount * 3, `${path}.positions`));
  const controlUvs = new Float32Array(safeTypedArrayLength(vertexCount * 2, `${path}.controlUvs`));
  // Keep accuracy values in Float64. Presentation positions alone are intentionally
  // insufficient for audits because their Z contains the fixed 2x visual transform.
  const canonicalYM = new Float64Array(vertexCount);
  const indices = new Uint32Array(safeTypedArrayLength(triangleCount * 3, `${path}.indices`));

  const extentX = (tile.resolution.columns - 1) * tile.sampleSpacingM.x;
  const extentZ = (tile.resolution.rows - 1) * tile.sampleSpacingM.z;
  if (!Number.isFinite(extentX) || !Number.isFinite(extentZ) || !(extentX > 0) || !(extentZ > 0)) {
    fail('ERR_CUSTOMS_TERRAIN_MESH_DEGENERATE', path, 'tile control extent must be positive and finite');
  }

  let vertex = 0;
  for (const row of patch.rowIndices) {
    const gameZ = tile.origin.z + (row * tile.sampleSpacingM.z);
    for (const column of patch.columnIndices) {
      const gameX = tile.origin.x + (column * tile.sampleSpacingM.x);
      const pointPath = `${path}.vertices[${vertex}]`;

      // This must remain a runtime point sample, including at patch boundaries.
      // At a shared seam the runtime's half-open owner supplies the same canonical
      // height to both patches even when their private raw edge samples disagree.
      const elevation = sampleCustomsTerrainElevation(runtime, {
        sourceFrame: CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME,
        x: finiteNumber(gameX, `${pointPath}.gameX`),
        z: finiteNumber(gameZ, `${pointPath}.gameZ`),
      });
      canonicalYM[vertex] = finiteNumber(elevation.canonicalYM, `${pointPath}.canonicalYM`);

      const positionOffset = vertex * 3;
      positions[positionOffset] = finiteFloat32(-gameX, `${pointPath}.presentationX`);
      positions[positionOffset + 1] = finiteFloat32(-gameZ, `${pointPath}.presentationY`);
      positions[positionOffset + 2] = finiteFloat32(
        elevation.displayYM,
        `${pointPath}.presentationZ`,
      );

      const uvOffset = vertex * 2;
      controlUvs[uvOffset] = finiteFloat32(
        (gameX - tile.origin.x) / extentX,
        `${pointPath}.controlU`,
      );
      controlUvs[uvOffset + 1] = finiteFloat32(
        (gameZ - tile.origin.z) / extentZ,
        `${pointPath}.controlV`,
      );
      if (
        controlUvs[uvOffset] < 0 || controlUvs[uvOffset] > 1
        || controlUvs[uvOffset + 1] < 0 || controlUvs[uvOffset + 1] > 1
      ) {
        fail('ERR_CUSTOMS_TERRAIN_MESH_DEGENERATE', `${pointPath}.controlUv`, 'lies outside [0, 1]');
      }
      vertex += 1;
    }
  }

  let triangleOffset = 0;
  for (let row = 0; row < vertexRows - 1; row += 1) {
    for (let column = 0; column < vertexColumns - 1; column += 1) {
      const nearLeft = (row * vertexColumns) + column;
      const nearRight = nearLeft + 1;
      const farLeft = ((row + 1) * vertexColumns) + column;
      const farRight = farLeft + 1;
      writeTriangle(indices, triangleOffset, positions, nearLeft, nearRight, farLeft, `${path}.indices`);
      triangleOffset += 3;
      writeTriangle(indices, triangleOffset, positions, nearRight, farRight, farLeft, `${path}.indices`);
      triangleOffset += 3;
    }
  }
  if (triangleOffset !== indices.length) {
    fail('ERR_CUSTOMS_TERRAIN_MESH_SIZE', `${path}.indices`, 'triangle writer length drifted from plan');
  }

  return Object.freeze({
    tileId: patch.tileId,
    cropBounds: patch.cropBounds,
    sampledBounds: patch.sampledBounds,
    sampleWindow: patch.sampleWindow,
    columnIndices: patch.columnIndices,
    rowIndices: patch.rowIndices,
    vertexColumns,
    vertexRows,
    vertexCount,
    triangleCount,
    positions,
    controlUvs,
    indices,
    canonicalYM,
    canonicalGrid: Object.freeze({
      sourceFrame: CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME,
      vertexOrder: 'row-major-z-then-x',
      tileOriginM: tile.origin,
      sampleSpacingM: tile.sampleSpacingM,
      columnIndices: patch.columnIndices,
      rowIndices: patch.rowIndices,
    }),
  });
}

/**
 * Compile one crop into typed, per-tile terrain geometry.
 *
 * `positions` use TarkovZero's Three presentation convention:
 * `(game x, canonical y, game z) -> (-x, -z, fixed-2x display y)`.
 * `canonicalYM` always remains unexaggerated and is the accuracy surface.
 */
export function compileCustomsLocalTerrainMesh(runtime, scope, options) {
  const plan = planCustomsTerrainMesh(runtime, scope, options);
  const patches = plan.patches.map((patch, index) => compilePatch(runtime, patch, index));
  const vertexCount = patches.reduce((total, patch) => total + patch.vertexCount, 0);
  const triangleCount = patches.reduce((total, patch) => total + patch.triangleCount, 0);
  if (vertexCount !== plan.vertexCount || triangleCount !== plan.triangleCount) {
    fail('ERR_CUSTOMS_TERRAIN_MESH_SIZE', 'mesh', 'compiled counts drifted from the mesh plan');
  }
  return Object.freeze({
    map: plan.map,
    sourceFrame: CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME,
    scope: plan.scope,
    decimation: plan.decimation,
    canonicalCoordinates: Object.freeze({
      frame: CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME,
      units: 'metres',
      axes: Object.freeze({ x: '+game-x', y: 'world-up', z: '+game-z' }),
      elevationField: 'patches[].canonicalYM',
    }),
    presentationCoordinates: Object.freeze({
      frame: CUSTOMS_TERRAIN_PRESENTATION_FRAME,
      units: 'metres',
      axes: Object.freeze({ x: '-game-x', y: '-game-z', z: 'display-world-y' }),
      transform: '(game x, canonical y, game z) -> (-x, -z, display y)',
      displayReliefScale: CUSTOMS_LOCAL_TERRAIN_DISPLAY_RELIEF_SCALE,
      reliefOriginYM: runtime.manifest.reliefOriginYM,
    }),
    controlUv: Object.freeze({
      components: Object.freeze(['u', 'v']),
      columnOrder: CONTROL_COLUMN_ORDER,
      rowOrder: CONTROL_ROW_ORDER,
      range: Object.freeze([0, 1]),
    }),
    winding: 'counter-clockwise-from-presentation-plus-z',
    boundaryHeightOwnership: 'runtime-half-open-point-sampler',
    patches: Object.freeze(patches),
    vertexCount,
    triangleCount,
  });
}
