import assert from 'node:assert/strict';
import test from 'node:test';
import { gameToTerrainTextureUv, terrainTextureMapping } from '../src/terrain.js';

const close = (actual, expected, epsilon = 1e-12) => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
};

test('terrain bake mapping preserves the padded game bounds and canvas aspect', () => {
  const mapping = terrainTextureMapping([[10, 20], [110, 20], [110, 70], [10, 70]]);

  assert.deepEqual(mapping.bounds, {
    x0: 2, z0: 12, x1: 118, z1: 78, width: 116, depth: 66,
  });
  assert.deepEqual(mapping.textureSize, [2048, 1165]);
  close(mapping.metersPerTexel[0], 116 / 2048);
  close(mapping.metersPerTexel[1], 66 / 1165);
  assert.deepEqual(mapping.uvOrigin, [2, 12]);
  assert.deepEqual(mapping.uvAxes, ['+gameX', '+gameZ']);
  assert.equal(mapping.canvasYAxis, '+gameZ');
  assert.equal(mapping.threeCanvasTextureFlipY, false);
  assert.ok(Object.isFrozen(mapping) && Object.isFrozen(mapping.bounds));
});

test('game points map exactly to the baked terrain UV contract', () => {
  const mapping = terrainTextureMapping([[10, 20], [110, 20], [110, 70], [10, 70]]);

  assert.deepEqual(gameToTerrainTextureUv(2, 12, mapping), [0, 0]);
  assert.deepEqual(gameToTerrainTextureUv(118, 78, mapping), [1, 1]);
  assert.deepEqual(gameToTerrainTextureUv(60, 45, mapping), [0.5, 0.5]);
  assert.deepEqual(gameToTerrainTextureUv(-999, 999, mapping), [0, 1], 'mesh UVs clamp at the bake edge');
});

test('terrain texture mapping rejects missing or non-finite coordinates', () => {
  assert.throws(() => terrainTextureMapping([]), /limit ring/);
  assert.throws(() => terrainTextureMapping([[0, 0], [1, 0], [NaN, 1]]), /finite/);
  const mapping = terrainTextureMapping([[0, 0], [1, 0], [1, 1]]);
  assert.throws(() => gameToTerrainTextureUv('nope', 0, mapping), /finite/);
});
