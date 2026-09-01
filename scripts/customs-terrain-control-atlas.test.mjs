import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CUSTOMS_TERRAIN_CONTROL_ATLAS_FORMAT,
  buildCustomsTerrainControlAtlases,
} from '../src/customs-terrain-control-atlas.js';

function rgba(width, height, seed, alphas = []) {
  const bytes = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * 4;
    bytes[offset] = (seed + pixel) & 255;
    bytes[offset + 1] = (seed + 20 + pixel) & 255;
    bytes[offset + 2] = (seed + 40 + pixel) & 255;
    bytes[offset + 3] = alphas[pixel] ?? ((seed + 60 + pixel) & 255);
  }
  return bytes;
}

function controls(tileId, width = 2, height = 2) {
  // Deliberately not in slot order: the explicit slot is semantic authority.
  return [2, 0, 1].map((slot) => ({
    id: `${tileId}-control-${slot}`,
    slot,
    width,
    height,
    rgba: rgba(width, height, (slot * 70) + (tileId === 'west' ? 5 : 11),
      slot === 2 && tileId === 'west' ? [0, 17, 128, 255] : []),
  }));
}

function tile(id, minX, maxX, minZ = -359.121337890625, maxZ = 340.878662109375) {
  return {
    id,
    origin: { x: minX, z: minZ },
    bounds: { minX, maxX, minZ, maxZ },
    controls: controls(id),
  };
}

function currentEastWestTiles() {
  const seamX = 147.300048828125;
  return [
    tile('west', -552.699951171875, seamX),
    tile('east', seamX, 847.300048828125),
  ];
}

function pixel(bytes, width, x, y) {
  const offset = ((y * width) + x) * 4;
  return [...bytes.slice(offset, offset + 4)];
}

test('stitches current east/west controls by canonical bounds, independent of tile order', () => {
  const [west, east] = currentEastWestTiles();
  const reversed = buildCustomsTerrainControlAtlases({ tiles: [east, west] });
  const canonical = buildCustomsTerrainControlAtlases({ tiles: [west, east] });

  assert.equal(reversed.format, CUSTOMS_TERRAIN_CONTROL_ATLAS_FORMAT);
  assert.deepEqual(reversed.grid, canonical.grid);
  assert.deepEqual(reversed.tiles, canonical.tiles);
  assert.deepEqual(reversed.atlases, canonical.atlases);
  assert.equal(reversed.width, 4);
  assert.equal(reversed.height, 2);
  assert.deepEqual(reversed.tiles.map(({ id }) => id), ['west', 'east']);

  const westSlot0 = west.controls.find(({ slot }) => slot === 0).rgba;
  const eastSlot0 = east.controls.find(({ slot }) => slot === 0).rgba;
  assert.deepEqual(pixel(reversed.atlases[0].bytes, 4, 0, 0), [...westSlot0.slice(0, 4)]);
  assert.deepEqual(pixel(reversed.atlases[0].bytes, 4, 2, 0), [...eastSlot0.slice(0, 4)]);
  assert.deepEqual(pixel(reversed.atlases[0].bytes, 4, 1, 1), [...westSlot0.slice(12, 16)]);
  assert.deepEqual(pixel(reversed.atlases[0].bytes, 4, 3, 1), [...eastSlot0.slice(12, 16)]);
});

test('preserves every RGBA byte including zero and partial alpha', () => {
  const [west, east] = currentEastWestTiles();
  const result = buildCustomsTerrainControlAtlases({ tiles: [east, west] });
  const alpha = [];
  for (let y = 0; y < 2; y += 1) {
    for (let x = 0; x < 2; x += 1) alpha.push(pixel(result.atlases[2].bytes, 4, x, y)[3]);
  }
  assert.deepEqual(alpha, [0, 17, 128, 255]);
});

test('emits exact UV scale/offset and maps a shared canonical seam to one atlas coordinate', () => {
  const result = buildCustomsTerrainControlAtlases({ tiles: currentEastWestTiles().reverse() });
  const west = result.tiles.find(({ id }) => id === 'west');
  const east = result.tiles.find(({ id }) => id === 'east');

  assert.deepEqual(west.uv, { scale: { u: 0.5, v: 1 }, offset: { u: 0, v: 0 } });
  assert.deepEqual(east.uv, { scale: { u: 0.5, v: 1 }, offset: { u: 0.5, v: 0 } });
  assert.equal(west.bounds.maxX, east.bounds.minX);
  assert.equal(west.uv.offset.u + west.uv.scale.u, east.uv.offset.u);
  assert.equal(west.pixelRect.x + west.pixelRect.width, east.pixelRect.x);
});

test('derives a general rectangular grid from origins instead of input order', () => {
  const make = (id, column, row) => ({
    id,
    origin: { x: column * 10, z: row * 20 },
    bounds: {
      minX: column * 10,
      maxX: (column + 1) * 10,
      minZ: row * 20,
      maxZ: (row + 1) * 20,
    },
    controls: [0, 1, 2].map((slot) => ({
      id: `${id}-${slot}`,
      slot,
      width: 1,
      height: 1,
      rgba: Uint8Array.from([column, row, slot, 255]),
    })),
  });
  const result = buildCustomsTerrainControlAtlases({
    tiles: [make('ne', 1, 1), make('sw', 0, 0), make('se', 1, 0), make('nw', 0, 1)],
  });
  assert.deepEqual(result.tiles.map(({ id }) => id), ['sw', 'se', 'nw', 'ne']);
  assert.deepEqual(result.grid, { columns: 2, rows: 2, xEdges: [0, 10, 20], zEdges: [0, 20, 40] });
  assert.deepEqual(pixel(result.atlases[1].bytes, 2, 1, 1), [1, 1, 1, 255]);
});

test('freezes all atlas metadata without aliasing input bytes', () => {
  const tiles = currentEastWestTiles();
  const inputByte = tiles[0].controls[0].rgba[0];
  const result = buildCustomsTerrainControlAtlases({ tiles });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.grid));
  assert.ok(Object.isFrozen(result.tiles[0].uv.scale));
  assert.ok(Object.isFrozen(result.atlases[0]));
  tiles[0].controls[0].rgba.fill(255);
  const slot = tiles[0].controls[0].slot;
  assert.equal(result.atlases[slot].bytes[0], inputByte);
});

test('rejects canonical gaps, positive-area overlap, and non-cell-aligned layouts', () => {
  const gapWest = tile('west', 0, 1, 0, 1);
  const gapEast = tile('east', 2, 3, 0, 1);
  assert.throws(
    () => buildCustomsTerrainControlAtlases({ tiles: [gapWest, gapEast] }),
    /missing canonical grid cell/,
  );

  const overlapWest = tile('west', 0, 2, 0, 1);
  const overlapEast = tile('east', 1, 3, 0, 1);
  assert.throws(
    () => buildCustomsTerrainControlAtlases({ tiles: [overlapWest, overlapEast] }),
    /positive-area overlap/,
  );

  const fullHeight = tile('west', 0, 1, 0, 2);
  const lowerEast = tile('east', 1, 2, 0, 1);
  const upperEast = tile('upper-east', 1, 2, 1, 2);
  upperEast.controls = controls('upper-east');
  assert.throws(
    () => buildCustomsTerrainControlAtlases({ tiles: [fullHeight, lowerEast, upperEast] }),
    /must occupy exactly one cell/,
  );
});

test('rejects unequal dimensions within a tile or across tiles', () => {
  const [west, east] = currentEastWestTiles();
  west.controls[0].width = 1;
  west.controls[0].rgba = rgba(1, 2, 1);
  assert.throws(
    () => buildCustomsTerrainControlAtlases({ tiles: [west, east] }),
    /all three controls must have equal dimensions/,
  );

  const [west2, east2] = currentEastWestTiles();
  east2.controls = controls('east', 1, 2);
  assert.throws(
    () => buildCustomsTerrainControlAtlases({ tiles: [west2, east2] }),
    /shared 2x2 control dimensions/,
  );
});

test('rejects invalid RGBA bytes, duplicate IDs, bad origins, and unsafe sizes', () => {
  const [west, east] = currentEastWestTiles();
  west.controls[0].rgba = new Uint16Array(8);
  assert.throws(
    () => buildCustomsTerrainControlAtlases({ tiles: [west, east] }),
    /Uint8Array or Uint8ClampedArray/,
  );

  const wrongLength = currentEastWestTiles();
  wrongLength[0].controls[0].rgba = new Uint8Array(15);
  assert.throws(
    () => buildCustomsTerrainControlAtlases({ tiles: wrongLength }),
    /exactly 16 RGBA8 bytes; received 15/,
  );

  const duplicateTiles = currentEastWestTiles();
  duplicateTiles[1].id = 'west';
  assert.throws(
    () => buildCustomsTerrainControlAtlases({ tiles: duplicateTiles }),
    /duplicates tile ID/,
  );

  const duplicateControls = currentEastWestTiles();
  duplicateControls[1].controls[0].id = duplicateControls[0].controls[0].id;
  assert.throws(
    () => buildCustomsTerrainControlAtlases({ tiles: duplicateControls }),
    /duplicates control ID/,
  );

  const badOrigin = currentEastWestTiles();
  badOrigin[0].origin.x += 1;
  assert.throws(
    () => buildCustomsTerrainControlAtlases({ tiles: badOrigin }),
    /must equal the canonical minX\/minZ bounds/,
  );

  const tooLarge = tile('west', 0, 1, 0, 1);
  tooLarge.controls[0].width = 4097;
  tooLarge.controls[0].rgba = new Uint8Array(0);
  assert.throws(
    () => buildCustomsTerrainControlAtlases({ tiles: [tooLarge] }),
    /from 1 through 4096/,
  );

  const wideTiles = [0, 1, 2].map((column) => ({
    id: `wide-${column}`,
    origin: { x: column, z: 0 },
    bounds: { minX: column, maxX: column + 1, minZ: 0, maxZ: 1 },
    controls: [0, 1, 2].map((slot) => ({
      id: `wide-${column}-${slot}`,
      slot,
      width: 4096,
      height: 1,
      rgba: new Uint8Array(4096 * 4),
    })),
  }));
  assert.throws(
    () => buildCustomsTerrainControlAtlases({ tiles: wideTiles }),
    /derived 12288x1 atlas exceeds the safe/,
  );
});
