import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import {
  CUSTOMS_TERRAIN_LAYER_COLORS,
  blendCustomsTerrainControlPixels,
  customsTerrainPaletteForLayers,
  decodeCustomsTerrainControlPng,
} from '../src/customs-terrain-surface.js';

const layers = [
  'Grass_summer', 'Ground_summer', 'Gravel_Road_A_summer', 'Forest_Ground_summer',
  'Stone_Ground_summer', 'Rock_Ground_summer', 'Gravel_Road_B_summer', 'Gravel_summer',
  'Grassy_Ground_summer', 'Sand_summer', 'Pebbles_Ground_summer', 'Soil_Grass_summer',
].map((name, index) => ({ name, index }));

const chunk = (type, payload) => {
  const output = Buffer.alloc(12 + payload.length);
  output.writeUInt32BE(payload.length, 0);
  output.write(type, 4, 4, 'ascii');
  payload.copy(output, 8);
  return output; // decoder intentionally relies on zlib/shape checks, not CRC.
};

const rgbaPng = (width, height, rgba) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const rows = [];
  for (let row = 0; row < height; row++) {
    rows.push(Buffer.from([0]), Buffer.from(rgba.slice(row * width * 4, (row + 1) * width * 4)));
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

test('losslessly decodes semantic RGBA even when alpha is zero', async () => {
  const rgba = Uint8Array.from([10, 20, 30, 0, 40, 50, 60, 128]);
  const decoded = await decodeCustomsTerrainControlPng(rgbaPng(2, 1, rgba));
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 1);
  assert.deepEqual([...decoded.rgba], [...rgba]);
});

test('maps the twelve EFT semantic names to the original restrained palette', () => {
  const palette = customsTerrainPaletteForLayers(layers);
  assert.deepEqual(palette[0], CUSTOMS_TERRAIN_LAYER_COLORS.grass);
  assert.deepEqual(palette[2], CUSTOMS_TERRAIN_LAYER_COLORS['gravel-road-a']);
  assert.deepEqual(palette[10], CUSTOMS_TERRAIN_LAYER_COLORS.pebbles);
  assert.deepEqual(palette[11], CUSTOMS_TERRAIN_LAYER_COLORS['soil-grass']);
});

test('uses exact control weights, normalizes them, and does not add random variance', () => {
  const controls = [new Uint8Array(8), new Uint8Array(8), new Uint8Array(8)];
  controls[0][0] = 255; // pixel 0: grass
  controls[0][5] = 128; // pixel 1: ground
  controls[2][7] = 128; // pixel 1: soil grass
  const palette = customsTerrainPaletteForLayers(layers);
  const result = blendCustomsTerrainControlPixels({ controls, width: 2, height: 1, palette });
  assert.deepEqual([...result.slice(0, 4)], [...palette[0], 255]);
  assert.equal(result[7], 255);
  for (let channel = 0; channel < 3; channel += 1) {
    const low = Math.min(palette[1][channel], palette[11][channel]);
    const high = Math.max(palette[1][channel], palette[11][channel]);
    assert.ok(result[4 + channel] >= low && result[4 + channel] <= high);
  }
});

test('falls back to neutral ground only when all twelve weights are zero', () => {
  const palette = customsTerrainPaletteForLayers(layers);
  const result = blendCustomsTerrainControlPixels({
    controls: [new Uint8Array(4), new Uint8Array(4), new Uint8Array(4)],
    width: 1,
    height: 1,
    palette,
  });
  assert.deepEqual([...result], [...palette[1], 255]);
});
