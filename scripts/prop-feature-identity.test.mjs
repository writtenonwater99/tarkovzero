import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { applyPropFeatureManifest } from './lib/prop-feature-identity.mjs';

const manifest = JSON.parse(await readFile(new URL('../data/customs-prop-features.json', import.meta.url), 'utf8'));
const sourceProps = JSON.parse(await readFile(new URL('../data/customs-props.json', import.meta.url), 'utf8')).props;
const generatedProps = JSON.parse(await readFile(new URL('../public/data/customs-3d.json', import.meta.url), 'utf8')).props;

test('reviewed Customs rail-yard props have stable semantic IDs in generated data', () => {
  const expected = new Map(manifest.features.map((feature) => [feature.featureId, feature.match]));
  assert.equal(expected.size, 9);

  for (const [featureId, match] of expected) {
    const matches = generatedProps.filter((prop) => prop.featureId === featureId);
    assert.equal(matches.length, 1, `${featureId} must resolve exactly once`);
    assert.equal(matches[0].type, match.type);
    assert.ok(Math.hypot(matches[0].x - match.position[0], matches[0].z - match.position[1]) <= match.toleranceM);
  }
  assert.equal(new Set(generatedProps.flatMap((prop) => prop.featureId ? [prop.featureId] : [])).size,
    generatedProps.filter((prop) => prop.featureId).length, 'generated prop featureIds must be unique');
});

test('identity assignment mutates only featureId fields and preserves prop order', () => {
  const props = structuredClone(sourceProps);
  const before = structuredClone(props);
  const assignments = applyPropFeatureManifest({ map: 'customs', props, manifest });
  assert.equal(assignments.length, manifest.features.length);
  assert.equal(props.length, before.length);
  for (let index = 0; index < props.length; index++) {
    const { featureId: _actualFeatureId, ...actual } = props[index];
    const { featureId: _beforeFeatureId, ...expected } = before[index];
    assert.deepEqual(actual, expected, `source prop ${index} changed beyond featureId`);
  }
});

test('coordinate drift fails instead of silently retargeting an identity', () => {
  const props = structuredClone(sourceProps);
  const target = props.find((prop) => prop.type === 'railcar' && prop.x === 251.6 && prop.z === -184);
  target.x += 0.2;
  assert.throws(
    () => applyPropFeatureManifest({ map: 'customs', props, manifest }),
    /locomotive_west.*matched 0 props/,
  );
});

test('an ambiguous coordinate match fails instead of choosing by array index', () => {
  const props = structuredClone(sourceProps);
  props.unshift(structuredClone(props.find((prop) => prop.type === 'container' && prop.x === 233 && prop.z === -89)));
  assert.throws(
    () => applyPropFeatureManifest({ map: 'customs', props, manifest }),
    /red_container_stack.*matched 2 props/,
  );
});
