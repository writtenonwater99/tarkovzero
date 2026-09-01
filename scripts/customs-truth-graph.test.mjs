import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalCustomsTruthGraphJson,
  composeTransformMatrix,
  normalizeCustomsTruthGraph,
  normalizeQuaternion,
  rawSignedHeightToWorldY,
  transformPoint,
} from './lib/customs-truth-graph.mjs';

const SOURCE_DIGEST = `sha256:${'ab'.repeat(32)}`;

function syntheticFixture() {
  return {
    schemaVersion: 1,
    graphId: 'customs.truth.synthetic-fixture',
    map: 'customs',
    coordinates: {
      frameId: 'customs.frame.synthetic-world',
      units: 'metre',
      handedness: 'right-handed',
      axes: { x: 'east', y: 'up', z: 'north' },
      quaternionOrder: 'xyzw',
      matrixConvention: 'column-major-parent-times-local',
    },
    sources: [{
      sourceId: 'source.synthetic-survey',
      kind: 'synthetic-survey',
      capturedAt: '2030-01-02T03:04:05.000Z',
      digest: SOURCE_DIGEST,
      payloadExcluded: true,
    }],
    evidence: [
      {
        evidenceId: 'evidence.synthetic.child',
        sourceId: 'source.synthetic-survey',
        kind: 'synthetic-control-point',
        featureId: 'customs.feature.synthetic-child',
        confidence: 0.9,
        position: [4, 22, 30],
      },
      {
        evidenceId: 'evidence.synthetic.root',
        sourceId: 'source.synthetic-survey',
        kind: 'synthetic-control-point',
        featureId: 'customs.feature.synthetic-root',
        confidence: 1,
        position: [10, 20, 30],
      },
    ],
    assets: [{
      assetId: 'asset.synthetic-cube',
      family: 'synthetic-cube',
      variant: 'blue-test-block',
      revision: 1,
      authoring: 'independent-original',
      license: 'synthetic-test-only',
      sourceIds: ['source.synthetic-survey'],
      evidenceIds: ['evidence.synthetic.child'],
      payloadExcluded: true,
    }],
    sceneNodes: [
      {
        nodeId: 'customs.node.synthetic-grandchild',
        featureId: 'customs.feature.synthetic-grandchild',
        parentId: 'customs.node.synthetic-child',
        assetId: 'asset.synthetic-cube',
        evidenceIds: [],
        localTransform: {
          translation: [0, 1, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      },
      {
        nodeId: 'customs.node.synthetic-root',
        featureId: 'customs.feature.synthetic-root',
        parentId: null,
        assetId: null,
        evidenceIds: ['evidence.synthetic.root'],
        localTransform: {
          translation: [10, 20, 30],
          rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
          scale: [2, 3, 4],
        },
      },
      {
        nodeId: 'customs.node.synthetic-child',
        featureId: 'customs.feature.synthetic-child',
        parentId: 'customs.node.synthetic-root',
        assetId: 'asset.synthetic-cube',
        evidenceIds: ['evidence.synthetic.child'],
        localTransform: {
          translation: [1, 0, 0],
          rotation: [0, 0, 0, 2],
          scale: [0.5, 2, 1],
        },
      },
    ],
    terrainTiles: [{
      tileId: 'customs.terrain.synthetic-tile',
      sourceId: 'source.synthetic-survey',
      evidenceIds: ['evidence.synthetic.root'],
      bounds: { min: [100, 200], max: [110, 220] },
      resolution: { columns: 3, rows: 5 },
      sampleSpacingM: { x: 5, z: 5 },
      heightEncoding: {
        storage: 'sint16',
        interpretation: 'signed-linear',
        divisor: 32767,
        sampleOrder: 'row-major-z-times-columns-plus-x',
      },
      rawRange: { min: -32767, max: 32767 },
      heightScaleM: 12.5,
      terrainOriginYM: 5,
      worldElevationRangeM: { min: -7.5, max: 17.5 },
      payloadExcluded: true,
    }],
  };
}

function assertVectorClose(actual, expected, epsilon = 1e-12) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < actual.length; index += 1) {
    assert.ok(
      Math.abs(actual[index] - expected[index]) <= epsilon,
      `component ${index}: expected ${expected[index]}, received ${actual[index]}`,
    );
  }
}

function determinant3(matrix) {
  const [a, d, g] = [matrix[0], matrix[1], matrix[2]];
  const [b, e, h] = [matrix[4], matrix[5], matrix[6]];
  const [c, f, i] = [matrix[8], matrix[9], matrix[10]];
  return (a * ((e * i) - (f * h)))
    - (b * ((d * i) - (f * g)))
    + (c * ((d * h) - (e * g)));
}

test('normalizes a versioned, metadata-only graph into stable record order', () => {
  const input = syntheticFixture();
  const normalized = normalizeCustomsTruthGraph(input);

  assert.equal(normalized.schemaVersion, 1);
  assert.equal(normalized.map, 'customs');
  assert.deepEqual(normalized.evidence.map(({ evidenceId }) => evidenceId), [
    'evidence.synthetic.child',
    'evidence.synthetic.root',
  ]);
  assert.deepEqual(normalized.sceneNodes.map(({ nodeId }) => nodeId), [
    'customs.node.synthetic-child',
    'customs.node.synthetic-grandchild',
    'customs.node.synthetic-root',
  ]);
  assert.deepEqual(Object.keys(normalized.assets[0]), [
    'assetId', 'family', 'variant', 'revision', 'authoring', 'license',
    'sourceIds', 'evidenceIds', 'payloadExcluded',
  ]);
  assert.equal(normalized.assets[0].payloadExcluded, true);

  const reordered = syntheticFixture();
  reordered.evidence.reverse();
  reordered.sceneNodes.reverse();
  assert.equal(canonicalCustomsTruthGraphJson(reordered), canonicalCustomsTruthGraphJson(input));
});

test('normalizes quaternion length and canonicalizes equivalent signs', () => {
  const positive = normalizeQuaternion([0, 0, 2, 2]);
  const negative = normalizeQuaternion([0, 0, -2, -2]);
  assertVectorClose(positive, [0, 0, Math.SQRT1_2, Math.SQRT1_2]);
  assert.deepEqual(negative, positive);
  assert.throws(() => normalizeQuaternion([0, 0, 0, 0]), /must have non-zero length/);
});

test('composes nested translation, rotation, and non-uniform scale as parent times local', () => {
  const graph = normalizeCustomsTruthGraph(syntheticFixture());
  const byId = new Map(graph.sceneNodes.map((node) => [node.nodeId, node]));

  assertVectorClose(
    transformPoint(byId.get('customs.node.synthetic-child').worldTransform.matrix, [0, 0, 0]),
    [10, 22, 30],
  );
  assertVectorClose(
    transformPoint(byId.get('customs.node.synthetic-grandchild').worldTransform.matrix, [0, 0, 0]),
    [4, 22, 30],
  );
  assertVectorClose(
    transformPoint(byId.get('customs.node.synthetic-grandchild').worldTransform.matrix, [2, 0, 0]),
    [4, 24, 30],
  );

  const standalone = composeTransformMatrix({
    translation: [3, 4, 5],
    rotation: [0, 0, 0, 8],
    scale: [2, 3, 4],
  });
  assertVectorClose(transformPoint(standalone, [1, 1, 1]), [5, 7, 9]);
});

test('preserves mirrored local scales and rejects only zero scale', () => {
  const fixture = syntheticFixture();
  const child = fixture.sceneNodes.find(({ nodeId }) => nodeId === 'customs.node.synthetic-child');
  child.localTransform.scale = [-0.5, 2, 1];
  const graph = normalizeCustomsTruthGraph(fixture);
  const mirrored = graph.sceneNodes.find(({ nodeId }) => nodeId === child.nodeId);

  assert.deepEqual(mirrored.localTransform.scale, [-0.5, 2, 1]);
  assert.equal(determinant3(mirrored.localMatrix), -1);
  assert.ok(Math.abs(determinant3(mirrored.worldTransform.matrix) - -24) <= 1e-12);
  assertVectorClose(transformPoint(mirrored.worldTransform.matrix, [2, 0, 0]), [10, 20, 30]);

  child.localTransform.scale = [0, 2, 1];
  assert.throws(() => normalizeCustomsTruthGraph(fixture), /scale\[0\].*must be non-zero/);
});

test('rejects missing parents and deterministic parent cycles', () => {
  const missing = syntheticFixture();
  missing.sceneNodes[0].parentId = 'customs.node.missing-parent';
  assert.throws(
    () => normalizeCustomsTruthGraph(missing),
    /references missing parent customs\.node\.missing-parent/,
  );

  const cyclic = syntheticFixture();
  cyclic.sceneNodes.find(({ nodeId }) => nodeId === 'customs.node.synthetic-root').parentId = 'customs.node.synthetic-grandchild';
  assert.throws(
    () => normalizeCustomsTruthGraph(cyclic),
    /contains a parent cycle: .*synthetic-child.*synthetic-root.*synthetic-grandchild.*synthetic-child/,
  );
});

test('validates terrain geometry and converts explicit signed samples to world-Y metres', () => {
  const normalized = normalizeCustomsTruthGraph(syntheticFixture());
  const tile = normalized.terrainTiles[0];
  assert.deepEqual(tile.worldElevationRangeM, { min: -7.5, max: 17.5 });
  assert.equal(rawSignedHeightToWorldY(tile, -32767), -7.5);
  assert.equal(rawSignedHeightToWorldY(tile, -1), 5 - (12.5 / 32767));
  assert.equal(rawSignedHeightToWorldY(tile, 0), 5);
  assert.equal(rawSignedHeightToWorldY(tile, 32767), 17.5);
  assert.throws(() => rawSignedHeightToWorldY(tile, -32768), /integer from -32767 through 32767/);

  const spacingDrift = syntheticFixture();
  spacingDrift.terrainTiles[0].sampleSpacingM.x = 4;
  assert.throws(() => normalizeCustomsTruthGraph(spacingDrift), /does not match bounds and sample resolution/);

  const rangeDrift = syntheticFixture();
  rangeDrift.terrainTiles[0].worldElevationRangeM.max = 17.4;
  assert.throws(() => normalizeCustomsTruthGraph(rangeDrift), /must equal the derived range -7\.5 through 17\.5/);

  const unsignedAssumption = syntheticFixture();
  unsignedAssumption.terrainTiles[0].heightEncoding.storage = 'uint16';
  assert.throws(() => normalizeCustomsTruthGraph(unsignedAssumption), /heightEncoding\.storage.*must be sint16/);

  const unsignedDivisor = syntheticFixture();
  unsignedDivisor.terrainTiles[0].heightEncoding.divisor = 65535;
  assert.throws(() => normalizeCustomsTruthGraph(unsignedDivisor), /heightEncoding\.divisor.*must be 32767/);

  const unknownInterpretation = syntheticFixture();
  unknownInterpretation.terrainTiles[0].heightEncoding.interpretation = 'bitcast-unsigned';
  assert.throws(() => normalizeCustomsTruthGraph(unknownInterpretation), /heightEncoding\.interpretation.*must be signed-linear/);

  const wrongOrder = syntheticFixture();
  wrongOrder.terrainTiles[0].heightEncoding.sampleOrder = 'column-major';
  assert.throws(() => normalizeCustomsTruthGraph(wrongOrder), /heightEncoding\.sampleOrder.*row-major-z-times-columns-plus-x/);
});

test('rejects payload-bearing fields and requires explicit payload exclusion', () => {
  const withPayload = syntheticFixture();
  withPayload.assets[0].mesh = 'forbidden-payload';
  assert.throws(() => normalizeCustomsTruthGraph(withPayload), /assets\[0\].*unsupported field\(s\): mesh/);

  const payloadNotExcluded = syntheticFixture();
  payloadNotExcluded.assets[0].payloadExcluded = false;
  assert.throws(() => normalizeCustomsTruthGraph(payloadNotExcluded), /payload-bearing records are outside this graph/);

  const terrainSamples = syntheticFixture();
  terrainSamples.terrainTiles[0].samples = new Uint16Array([100, 200]);
  assert.throws(() => normalizeCustomsTruthGraph(terrainSamples), /terrainTiles\[0\].*unsupported field\(s\): samples/);
});

test('rejects unstable or duplicate identities and broken evidence references', () => {
  const duplicate = syntheticFixture();
  duplicate.assets.push(structuredClone(duplicate.assets[0]));
  assert.throws(() => normalizeCustomsTruthGraph(duplicate), /duplicate assetId asset\.synthetic-cube/);

  const unstable = syntheticFixture();
  unstable.sceneNodes[0].featureId = 'Synthetic Grandchild';
  assert.throws(() => normalizeCustomsTruthGraph(unstable), /lowercase stable ID/);

  const missingEvidence = syntheticFixture();
  missingEvidence.assets[0].evidenceIds = ['evidence.synthetic.missing'];
  assert.throws(() => normalizeCustomsTruthGraph(missingEvidence), /references missing evidence evidence\.synthetic\.missing/);
});
