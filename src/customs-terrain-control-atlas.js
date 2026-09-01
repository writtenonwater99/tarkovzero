// Pure, renderer-neutral stitching for the three exact Customs RGBA control maps.
//
// Tile placement is derived only from canonical EFT-space origins/bounds. Array
// order is never spatial authority. The returned metadata is deeply frozen;
// Uint8Array atlas payloads remain caller-owned upload buffers because ECMAScript
// cannot freeze the indexed elements of a non-empty typed array.

export const CUSTOMS_TERRAIN_CONTROL_ATLAS_VERSION = 1;
export const CUSTOMS_TERRAIN_CONTROL_ATLAS_COUNT = 3;
export const CUSTOMS_TERRAIN_CONTROL_ATLAS_FORMAT = 'rgba8-unorm';

const MAX_TILE_DIMENSION = 4096;
const MAX_ATLAS_DIMENSION = 8192;
const MAX_ATLAS_PIXELS = 16_777_216;
const CHANNELS_PER_PIXEL = 4;
const COORDINATE_EPSILON = 1e-9;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const CUSTOMS_TERRAIN_CONTROL_ATLAS_LIMITS = Object.freeze({
  maxTileDimension: MAX_TILE_DIMENSION,
  maxAtlasDimension: MAX_ATLAS_DIMENSION,
  maxAtlasPixels: MAX_ATLAS_PIXELS,
});

export class CustomsTerrainControlAtlasError extends Error {
  constructor(code, path, message) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'CustomsTerrainControlAtlasError';
    this.code = code;
    this.path = path;
  }
}

function fail(code, path, message) {
  throw new CustomsTerrainControlAtlasError(code, path, message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function objectAt(value, path) {
  if (!isPlainObject(value)) fail('ERR_CONTROL_ATLAS_SCHEMA', path, 'must be an object');
  return value;
}

function exactKeys(value, required, optional, path) {
  const object = objectAt(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) {
      fail('ERR_CONTROL_ATLAS_SCHEMA', path, `is missing required field ${key}`);
    }
  }
  const unexpected = Object.keys(object).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    fail('ERR_CONTROL_ATLAS_SCHEMA', path, `contains unsupported field(s): ${unexpected.join(', ')}`);
  }
  return object;
}

function stableId(value, path) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail('ERR_CONTROL_ATLAS_SCHEMA', path, 'must be a portable stable ID');
  }
  return value;
}

function finiteNumber(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('ERR_CONTROL_ATLAS_NON_FINITE', path, 'must be a finite number');
  }
  return Object.is(value, -0) ? 0 : value;
}

function safeInteger(value, path, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(
      'ERR_CONTROL_ATLAS_SIZE',
      path,
      `must be a safe integer from ${minimum} through ${maximum}`,
    );
  }
  return value;
}

function closeEnough(a, b) {
  return Math.abs(a - b) <= COORDINATE_EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
}

function deepFreezeMetadata(value) {
  if (!value || typeof value !== 'object' || ArrayBuffer.isView(value) || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreezeMetadata(child);
  return value;
}

function normalizeBounds(value, path) {
  const bounds = exactKeys(value, ['minX', 'maxX', 'minZ', 'maxZ'], [], path);
  const normalized = {
    minX: finiteNumber(bounds.minX, `${path}.minX`),
    maxX: finiteNumber(bounds.maxX, `${path}.maxX`),
    minZ: finiteNumber(bounds.minZ, `${path}.minZ`),
    maxZ: finiteNumber(bounds.maxZ, `${path}.maxZ`),
  };
  if (!(normalized.maxX > normalized.minX)) {
    fail('ERR_CONTROL_ATLAS_LAYOUT', path, 'maxX must be greater than minX');
  }
  if (!(normalized.maxZ > normalized.minZ)) {
    fail('ERR_CONTROL_ATLAS_LAYOUT', path, 'maxZ must be greater than minZ');
  }
  return normalized;
}

function normalizeOrigin(value, bounds, path) {
  const origin = exactKeys(value, ['x', 'z'], ['y'], path);
  const normalized = {
    x: finiteNumber(origin.x, `${path}.x`),
    z: finiteNumber(origin.z, `${path}.z`),
  };
  if (Object.prototype.hasOwnProperty.call(origin, 'y')) finiteNumber(origin.y, `${path}.y`);
  if (!closeEnough(normalized.x, bounds.minX) || !closeEnough(normalized.z, bounds.minZ)) {
    fail(
      'ERR_CONTROL_ATLAS_LAYOUT',
      path,
      'must equal the canonical minX/minZ bounds (control columns/rows increase toward +X/+Z)',
    );
  }
  return normalized;
}

function rgbaBytes(value, expectedLength, path) {
  if (!(value instanceof Uint8Array) && !(value instanceof Uint8ClampedArray)) {
    fail('ERR_CONTROL_ATLAS_BYTES', path, 'must be a Uint8Array or Uint8ClampedArray');
  }
  if (value.byteLength !== expectedLength) {
    fail(
      'ERR_CONTROL_ATLAS_BYTES',
      path,
      `must contain exactly ${expectedLength} RGBA8 bytes; received ${value.byteLength}`,
    );
  }
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function normalizeControls(value, tilePath) {
  const path = `${tilePath}.controls`;
  if (!Array.isArray(value) || value.length !== CUSTOMS_TERRAIN_CONTROL_ATLAS_COUNT) {
    fail('ERR_CONTROL_ATLAS_SCHEMA', path, 'must contain exactly three decoded RGBA controls');
  }
  const slots = new Set();
  const ids = new Set();
  const controls = value.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const control = exactKeys(entry, ['id', 'slot', 'width', 'height', 'rgba'], [], entryPath);
    const id = stableId(control.id, `${entryPath}.id`);
    if (ids.has(id)) fail('ERR_CONTROL_ATLAS_DUPLICATE', `${entryPath}.id`, `duplicates ${id}`);
    ids.add(id);
    const slot = safeInteger(
      control.slot,
      `${entryPath}.slot`,
      0,
      CUSTOMS_TERRAIN_CONTROL_ATLAS_COUNT - 1,
    );
    if (slots.has(slot)) fail('ERR_CONTROL_ATLAS_DUPLICATE', `${entryPath}.slot`, `duplicates slot ${slot}`);
    slots.add(slot);
    const width = safeInteger(control.width, `${entryPath}.width`, 1, MAX_TILE_DIMENSION);
    const height = safeInteger(control.height, `${entryPath}.height`, 1, MAX_TILE_DIMENSION);
    const pixelCount = width * height;
    if (!Number.isSafeInteger(pixelCount) || pixelCount > MAX_ATLAS_PIXELS) {
      fail('ERR_CONTROL_ATLAS_SIZE', entryPath, 'control pixel count exceeds the safe limit');
    }
    const byteLength = pixelCount * CHANNELS_PER_PIXEL;
    if (!Number.isSafeInteger(byteLength)) {
      fail('ERR_CONTROL_ATLAS_SIZE', entryPath, 'control byte length exceeds the safe integer range');
    }
    return {
      id,
      slot,
      width,
      height,
      rgba: rgbaBytes(control.rgba, byteLength, `${entryPath}.rgba`),
    };
  });
  for (let slot = 0; slot < CUSTOMS_TERRAIN_CONTROL_ATLAS_COUNT; slot += 1) {
    if (!slots.has(slot)) fail('ERR_CONTROL_ATLAS_SCHEMA', path, `is missing control slot ${slot}`);
  }
  controls.sort((a, b) => a.slot - b.slot);
  const [{ width, height }] = controls;
  for (let slot = 1; slot < controls.length; slot += 1) {
    if (controls[slot].width !== width || controls[slot].height !== height) {
      fail('ERR_CONTROL_ATLAS_DIMENSIONS', path, 'all three controls must have equal dimensions');
    }
  }
  return controls;
}

function normalizeTile(value, index) {
  const path = `tiles[${index}]`;
  const tile = exactKeys(value, ['id', 'origin', 'bounds', 'controls'], [], path);
  const bounds = normalizeBounds(tile.bounds, `${path}.bounds`);
  return {
    id: stableId(tile.id, `${path}.id`),
    origin: normalizeOrigin(tile.origin, bounds, `${path}.origin`),
    bounds,
    controls: normalizeControls(tile.controls, path),
    inputIndex: index,
  };
}

function canonicalAxisEdges(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const groups = [];
  for (const value of sorted) {
    const group = groups[groups.length - 1];
    if (!group || !closeEnough(group[group.length - 1], value)) groups.push([value]);
    else group.push(value);
  }
  // Averaging close endpoints gives both neighbours one shared canonical value.
  // Sum offsets from the first value so very large finite coordinates cannot
  // overflow merely because two matching endpoints were added together.
  return groups.map((group) => {
    const anchor = group[0];
    const edge = anchor + (group.reduce((sum, value) => sum + (value - anchor), 0) / group.length);
    if (!Number.isFinite(edge)) {
      fail('ERR_CONTROL_ATLAS_NON_FINITE', 'tiles', 'derived canonical grid edge must remain finite');
    }
    return edge;
  });
}

function axisIndex(edges, value, path) {
  const index = edges.findIndex((edge) => closeEnough(edge, value));
  if (index < 0) fail('ERR_CONTROL_ATLAS_LAYOUT', path, 'does not align to a canonical grid edge');
  return index;
}

function overlapExtent(aMin, aMax, bMin, bMax) {
  return Math.min(aMax, bMax) - Math.max(aMin, bMin);
}

function assertNoPositiveAreaOverlap(tiles) {
  for (let left = 0; left < tiles.length; left += 1) {
    for (let right = left + 1; right < tiles.length; right += 1) {
      const a = tiles[left];
      const b = tiles[right];
      const overlapX = overlapExtent(a.bounds.minX, a.bounds.maxX, b.bounds.minX, b.bounds.maxX);
      const overlapZ = overlapExtent(a.bounds.minZ, a.bounds.maxZ, b.bounds.minZ, b.bounds.maxZ);
      const toleranceX = COORDINATE_EPSILON * Math.max(1, Math.abs(a.bounds.maxX), Math.abs(b.bounds.maxX));
      const toleranceZ = COORDINATE_EPSILON * Math.max(1, Math.abs(a.bounds.maxZ), Math.abs(b.bounds.maxZ));
      if (overlapX > toleranceX && overlapZ > toleranceZ) {
        fail(
          'ERR_CONTROL_ATLAS_OVERLAP',
          'tiles',
          `${a.id} and ${b.id} have positive-area overlap in canonical EFT space`,
        );
      }
    }
  }
}

function deriveGrid(tiles) {
  assertNoPositiveAreaOverlap(tiles);
  const xEdges = canonicalAxisEdges(tiles.flatMap(({ bounds }) => [bounds.minX, bounds.maxX]));
  const zEdges = canonicalAxisEdges(tiles.flatMap(({ bounds }) => [bounds.minZ, bounds.maxZ]));
  const columns = xEdges.length - 1;
  const rows = zEdges.length - 1;
  if (columns < 1 || rows < 1) {
    fail('ERR_CONTROL_ATLAS_LAYOUT', 'tiles', 'must span at least one positive-area grid cell');
  }
  const cells = new Map();
  const placed = tiles.map((tile) => {
    const minColumn = axisIndex(xEdges, tile.bounds.minX, `tile ${tile.id}.bounds.minX`);
    const maxColumn = axisIndex(xEdges, tile.bounds.maxX, `tile ${tile.id}.bounds.maxX`);
    const minRow = axisIndex(zEdges, tile.bounds.minZ, `tile ${tile.id}.bounds.minZ`);
    const maxRow = axisIndex(zEdges, tile.bounds.maxZ, `tile ${tile.id}.bounds.maxZ`);
    if (maxColumn !== minColumn + 1 || maxRow !== minRow + 1) {
      fail(
        'ERR_CONTROL_ATLAS_LAYOUT',
        `tile ${tile.id}`,
        'must occupy exactly one cell in the rectangular canonical grid',
      );
    }
    const key = `${minColumn}:${minRow}`;
    if (cells.has(key)) {
      fail(
        'ERR_CONTROL_ATLAS_OVERLAP',
        `tile ${tile.id}`,
        `occupies the same canonical cell as ${cells.get(key).id}`,
      );
    }
    const result = {
      ...tile,
      column: minColumn,
      row: minRow,
      bounds: {
        minX: xEdges[minColumn],
        maxX: xEdges[maxColumn],
        minZ: zEdges[minRow],
        maxZ: zEdges[maxRow],
      },
    };
    cells.set(key, result);
    return result;
  });
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (!cells.has(`${column}:${row}`)) {
        fail(
          'ERR_CONTROL_ATLAS_GAP',
          'tiles',
          `missing canonical grid cell at column ${column}, row ${row}`,
        );
      }
    }
  }
  return { columns, rows, xEdges, zEdges, placed };
}

function assertUniformControlDimensions(tiles) {
  const width = tiles[0].controls[0].width;
  const height = tiles[0].controls[0].height;
  for (const tile of tiles) {
    for (const control of tile.controls) {
      if (control.width !== width || control.height !== height) {
        fail(
          'ERR_CONTROL_ATLAS_DIMENSIONS',
          `tile ${tile.id}.controls`,
          `must use the shared ${width}x${height} control dimensions`,
        );
      }
    }
  }
  return { width, height };
}

function copyControlIntoAtlas(atlas, atlasWidth, tileWidth, tileHeight, column, row, source) {
  const sourceRowBytes = tileWidth * CHANNELS_PER_PIXEL;
  const targetXBytes = column * sourceRowBytes;
  const targetY = row * tileHeight;
  for (let sourceY = 0; sourceY < tileHeight; sourceY += 1) {
    const sourceStart = sourceY * sourceRowBytes;
    const targetStart = ((targetY + sourceY) * atlasWidth * CHANNELS_PER_PIXEL) + targetXBytes;
    atlas.set(source.subarray(sourceStart, sourceStart + sourceRowBytes), targetStart);
  }
}

/**
 * Stitch decoded control bytes into three canonical global RGBA8 atlases.
 *
 * Input tile shape:
 * `{ id, origin: {x,z}, bounds: {minX,maxX,minZ,maxZ}, controls: [
 *    {id, slot: 0|1|2, width, height, rgba: Uint8Array}
 * ] }`.
 *
 * `origin` must be the lower (+X/+Z ordered) corner of `bounds`. Tiles must
 * completely fill a rectangular grid, but may arrive in any array order.
 */
export function buildCustomsTerrainControlAtlases(value) {
  const root = exactKeys(value, ['tiles'], [], 'input');
  if (!Array.isArray(root.tiles) || root.tiles.length === 0) {
    fail('ERR_CONTROL_ATLAS_SCHEMA', 'input.tiles', 'must be a non-empty array');
  }
  if (root.tiles.length > MAX_ATLAS_PIXELS) {
    fail('ERR_CONTROL_ATLAS_SIZE', 'input.tiles', 'contains an unsafe number of tiles');
  }
  const tiles = root.tiles.map(normalizeTile);
  const tileIds = new Set();
  const controlIds = new Set();
  for (const tile of tiles) {
    if (tileIds.has(tile.id)) fail('ERR_CONTROL_ATLAS_DUPLICATE', `tile ${tile.id}`, 'duplicates tile ID');
    tileIds.add(tile.id);
    for (const control of tile.controls) {
      if (controlIds.has(control.id)) {
        fail('ERR_CONTROL_ATLAS_DUPLICATE', `tile ${tile.id}.controls`, `duplicates control ID ${control.id}`);
      }
      controlIds.add(control.id);
    }
  }
  const { width: tileWidth, height: tileHeight } = assertUniformControlDimensions(tiles);
  const grid = deriveGrid(tiles);
  const width = tileWidth * grid.columns;
  const height = tileHeight * grid.rows;
  const pixelCount = width * height;
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width > MAX_ATLAS_DIMENSION
    || height > MAX_ATLAS_DIMENSION
    || !Number.isSafeInteger(pixelCount)
    || pixelCount > MAX_ATLAS_PIXELS
  ) {
    fail(
      'ERR_CONTROL_ATLAS_SIZE',
      'input.tiles',
      `derived ${width}x${height} atlas exceeds the safe ${MAX_ATLAS_DIMENSION}px/${MAX_ATLAS_PIXELS}px limits`,
    );
  }
  const atlasByteLength = pixelCount * CHANNELS_PER_PIXEL;
  if (!Number.isSafeInteger(atlasByteLength)) {
    fail('ERR_CONTROL_ATLAS_SIZE', 'input.tiles', 'derived atlas byte length is unsafe');
  }
  const payloads = Array.from(
    { length: CUSTOMS_TERRAIN_CONTROL_ATLAS_COUNT },
    () => new Uint8Array(atlasByteLength),
  );
  for (const tile of grid.placed) {
    for (const control of tile.controls) {
      copyControlIntoAtlas(
        payloads[control.slot],
        width,
        tileWidth,
        tileHeight,
        tile.column,
        tile.row,
        control.rgba,
      );
    }
  }
  const canonicalTiles = [...grid.placed]
    .sort((a, b) => a.row - b.row || a.column - b.column || a.id.localeCompare(b.id))
    .map((tile) => ({
      id: tile.id,
      grid: { column: tile.column, row: tile.row },
      bounds: { ...tile.bounds },
      pixelRect: {
        x: tile.column * tileWidth,
        y: tile.row * tileHeight,
        width: tileWidth,
        height: tileHeight,
      },
      uv: {
        scale: { u: tileWidth / width, v: tileHeight / height },
        offset: {
          u: (tile.column * tileWidth) / width,
          v: (tile.row * tileHeight) / height,
        },
      },
      controls: tile.controls.map(({ id, slot }) => ({ id, slot })),
    }));
  const result = {
    schemaVersion: CUSTOMS_TERRAIN_CONTROL_ATLAS_VERSION,
    format: CUSTOMS_TERRAIN_CONTROL_ATLAS_FORMAT,
    width,
    height,
    tileWidth,
    tileHeight,
    grid: {
      columns: grid.columns,
      rows: grid.rows,
      xEdges: [...grid.xEdges],
      zEdges: [...grid.zEdges],
    },
    bounds: {
      minX: grid.xEdges[0],
      maxX: grid.xEdges[grid.xEdges.length - 1],
      minZ: grid.zEdges[0],
      maxZ: grid.zEdges[grid.zEdges.length - 1],
    },
    atlases: payloads.map((bytes, slot) => ({
      slot,
      width,
      height,
      format: CUSTOMS_TERRAIN_CONTROL_ATLAS_FORMAT,
      bytes,
    })),
    tiles: canonicalTiles,
  };
  return deepFreezeMetadata(result);
}
