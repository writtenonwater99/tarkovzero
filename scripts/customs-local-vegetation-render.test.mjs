import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCustomsLocalVegetationRenderPlan,
  customsVegetationProxyDimensions,
} from '../src/customs-local-vegetation-render.js';

const vegetation = {
  instances: [
    {
      flatIndex: 0,
      tileId: 'west',
      prototypeId: 'pine-1',
      prototypeName: 'pine01',
      classification: 'pine',
      worldPosition: { x: 12, y: 3, z: -7 },
      widthScale: 1.25,
      heightScale: 0.8,
      rotationRadians: 0.75,
      color: { r: 1, g: 0.8, b: 0.7, a: 1 },
    },
    {
      flatIndex: 1,
      tileId: 'west',
      prototypeId: 'brush-1',
      prototypeName: 'brush_dry01',
      classification: 'shrub',
      worldPosition: { x: 90, y: 8, z: 90 },
      widthScale: 1,
      heightScale: 1,
      rotationRadians: 0,
      color: null,
    },
  ],
};

test('preserves canonical placement and applies fixed 2x display relief about the manifest origin', () => {
  const plan = buildCustomsLocalVegetationRenderPlan(vegetation, {
    reliefOriginYM: 1,
    scope: { minX: 0, maxX: 20, minZ: -10, maxZ: 0 },
  });
  assert.equal(plan.sourceCount, 2);
  assert.equal(plan.renderedCount, 1);
  assert.equal(plan.culledCount, 1);
  assert.deepEqual(plan.counts, {
    pine: 1,
    deciduous: 0,
    shrub: 0,
    stump: 0,
    'ground-plant': 0,
  });
  const pine = plan.groups.pine[0];
  assert.deepEqual(pine.canonicalPosition, { x: 12, y: 3, z: -7 });
  assert.deepEqual(pine.presentationPosition, [-12, 7, 5]);
  assert.equal(pine.displayY, 5);
  assert.equal(pine.yawRadians, 0.75);
  assert.equal(pine.dimensions.height, 10.8 * 0.8);
  assert.equal(pine.dimensions.width, 10.8 * 0.44 * 1.25);
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(pine.canonicalPosition));
});

test('keeps proxy size separate from exact authored transforms', () => {
  const dimensions = customsVegetationProxyDimensions({
    prototypeName: 'filbert_small01',
    classification: 'shrub',
    widthScale: 2,
    heightScale: 0.5,
  });
  assert.equal(dimensions.height, 1.05 * 0.5);
  assert.equal(dimensions.width, 1.05 * 1.15 * 2);
  assert.equal(dimensions.trunkHeight, 0);
});

test('uses a deterministic dry-vegetation tint without changing placement', () => {
  const plan = buildCustomsLocalVegetationRenderPlan(vegetation);
  assert.equal(plan.renderedCount, 2);
  assert.deepEqual(plan.groups.shrub[0].tint, { r: 1, g: 0.84, b: 0.58 });
  assert.deepEqual(plan.groups.shrub[0].canonicalPosition, { x: 90, y: 8, z: 90 });
});

test('rejects unsupported classifications and non-finite canonical coordinates', () => {
  assert.throws(
    () => buildCustomsLocalVegetationRenderPlan({ instances: [{
      ...vegetation.instances[0], classification: 'mystery',
    }] }),
    /unsupported vegetation classification/,
  );
  assert.throws(
    () => buildCustomsLocalVegetationRenderPlan({ instances: [{
      ...vegetation.instances[0], worldPosition: { x: Infinity, y: 0, z: 0 },
    }] }),
    /worldPosition\.x must be finite/,
  );
});
