import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  auditAccuracy,
  createBootstrapDocument,
  percentile,
  pointInPolygon,
  pointInPolygonArea,
  predictArtifactSurface,
  readEvidenceFiles,
  sampleTerrain,
  terrainAuditCells,
} from './audit-map-accuracy.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function observation(index, overrides = {}) {
  return {
    schemaVersion: 1,
    recordType: 'tarkovzero-survey-observation',
    map: 'customs',
    featureId: 'customs.audit.ground',
    tag: `audit ${index}`,
    pointRole: 'ground-contact',
    surfaceKind: 'ground',
    partition: 'held-out',
    routeId: `customs.route.held_out_${index % 3}`,
    priority: true,
    gameBuild: 'EFT-test-build',
    confidence: 1,
    screenshotId: `capture-${index}.png`,
    capturedAt: '2026-08-31T20:00:00.000Z',
    source: 'eft-screenshot-filename',
    coordinateFrame: 'eft-unity-world-metres-y-up',
    verticalReference: 'player-origin',
    surfaceOffsetM: 0,
    x: 9,
    y: 0,
    z: 9,
    yaw: 0,
    ...overrides,
  };
}

function passingFixture() {
  // Model geometry is generated as an emitted-artifact fixture.
  const buildings = [], assignments = [];
  for (let index = 0; index < 10; index++) {
    const x = 1 + (index % 5) * 1.7, z = index < 5 ? 2 : 4;
    const sourceKey = `emitted-building-${index}`;
    const featureId = `customs.audit.object_${index}`;
    buildings.push({
      sourceKey,
      poly: [[x - 0.2, z - 0.3], [x + 0.2, z - 0.3], [x + 0.2, z + 0.3], [x - 0.2, z + 0.3]],
      height: 4,
    });
    assignments.push({ featureId, sourceKey, emittedAs: 'building' });
  }

  // Independent survey fixture: literal measurements with ordinary survey
  // error. These are not calculated from the model polygons above.
  const surveyedObjects = [
    ['customs.audit.object_0', 1.03, 1.98],
    ['customs.audit.object_1', 2.68, 2.03],
    ['customs.audit.object_2', 4.44, 2.01],
    ['customs.audit.object_3', 6.08, 1.97],
    ['customs.audit.object_4', 7.82, 2.02],
    ['customs.audit.object_5', 1.01, 4.03],
    ['customs.audit.object_6', 2.73, 3.98],
    ['customs.audit.object_7', 4.38, 4.02],
    ['customs.audit.object_8', 6.12, 4.01],
    ['customs.audit.object_9', 7.77, 3.97],
  ].map(([featureId, x, z]) => ({ featureId, x, z }));

  const train = observation(1000, {
    featureId: 'customs.audit.training_ground',
    tag: 'training evidence',
    partition: 'train',
    routeId: 'customs.route.training',
    priority: false,
    screenshotId: 'training.png',
    x: 5,
    z: 5,
  });
  const ground = Array.from({ length: 30 }, (_, index) => observation(index, {
    x: 8.8 + (index % 3) * 0.05,
    y: [-0.18, 0.06, 0.21, -0.09, 0.13][index % 5],
    z: 8.8 + (index % 4) * 0.04,
  }));
  const objectCenters = Array.from({ length: 30 }, (_, index) => {
    const center = surveyedObjects[index % surveyedObjects.length];
    return observation(100 + index, {
      featureId: center.featureId,
      tag: `independent center ${index}`,
      pointRole: 'object-center',
      surfaceKind: 'object',
      x: center.x,
      z: center.z,
    });
  });
  const orientations = surveyedObjects.slice(0, 3).map((center, index) => observation(200 + index, {
    featureId: center.featureId,
    tag: `independent orientation ${index}`,
    pointRole: 'orientation',
    surfaceKind: 'object',
    x: center.x,
    z: center.z,
    yaw: [1, -2, 2][index],
  }));
  const surveyedCorners = [
    ['customs.audit.object_0', 0.82, 1.69],
    ['customs.audit.object_1', 2.51, 1.72],
    ['customs.audit.object_2', 4.21, 1.68],
  ].map(([featureId, x, z]) => ({ featureId, x, z }));
  const dimensions = surveyedCorners.map((corner, index) => observation(300 + index, {
    featureId: corner.featureId,
    tag: `independent dimensions ${index}`,
    pointRole: 'dimension-endpoint',
    surfaceKind: 'object',
    x: corner.x,
    z: corner.z,
    referenceDimensions: { widthM: 0.41, lengthM: 0.59, heightM: 4.05 },
  }));
  return {
    observations: [train, ...ground, ...objectCenters, ...orientations, ...dimensions],
    model: {
      map: 'customs',
      terrain: { x0: 0, z0: 0, step: 1, cols: 11, rows: 11, heights: Array(121).fill(0) },
      land: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
      water: [],
      roads: [],
      bridges: [],
      rocks: [],
      underground: [],
      floorBoxes: [],
      limit: [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
      buildings,
      features: { assignments },
    },
  };
}

test('math helpers handle repeated closure points, polygon holes, and bilinear terrain', () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
  assert.equal(percentile([1, 2, 3, 100], 0.95), 100);
  const closedSquare = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  const hole = [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]];
  assert.equal(pointInPolygon({ x: 5, z: 5 }, closedSquare), true);
  assert.equal(pointInPolygon({ x: 0, z: 5 }, closedSquare), true);
  assert.equal(pointInPolygon({ x: 11, z: 5 }, closedSquare), false, 'zero-length closure edge must not contain every point');
  assert.equal(pointInPolygonArea({ x: 5, z: 5 }, closedSquare, [hole]), false, 'water holes must remain dry');
  assert.equal(pointInPolygonArea({ x: 2, z: 2 }, closedSquare, [hole]), true);
  const dryCells = terrainAuditCells({
    terrain: { x0: 0, z0: 0, step: 5, cols: 3, rows: 3, heights: Array(9).fill(0) },
    land: [closedSquare],
    water: [{ poly: closedSquare, holes: [hole] }],
  });
  assert.deepEqual(dryCells, [{ x: 5, z: 5 }], 'water-mask holes must survive in the traversable coverage grid');
  assert.equal(sampleTerrain({ x0: 0, z0: 0, step: 10, cols: 2, rows: 2, heights: [0, 10, 10, 20] }, 5, 5), 10);
});

test('the real Customs artifact produces a nonzero, bounded traversable coverage grid', () => {
  const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'customs-3d.json'), 'utf8'));
  const report = auditAccuracy({ observations: [], model });
  assert.equal(report.errors.length, 0, report.errors.join('\n'));
  assert.equal(report.gates.coverage.terrainCells, 12642, 'Customs land/water topology coverage grid drifted');
  assert(report.gates.coverage.terrainCells < model.terrain.cols * model.terrain.rows, 'coverage ignored the Customs boundary/water masks');
  assert.equal(report.certified, false);
});

test('every committed object target and pinned surface resolves to an emitted Customs artifact', () => {
  const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'customs-3d.json'), 'utf8'));
  const plan = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'customs-audit-anchors.json'), 'utf8')).capturePlan;
  const assignments = new Map(model.features.assignments.map((assignment) => [assignment.featureId, assignment]));
  const buildingSources = new Set(model.buildings.map((building) => building.sourceKey));
  const objectRoles = new Set(['object-center', 'object-corner', 'door-threshold', 'orientation', 'dimension-endpoint']);
  const objectCaptures = plan.filter((item) => objectRoles.has(item.pointRole));
  assert(objectCaptures.length > 0, 'capture plan must retain object-fidelity targets');
  for (const capture of objectCaptures) {
    const assignment = assignments.get(capture.featureId);
    assert(assignment, `${capture.id} has no emitted feature assignment`);
    assert(buildingSources.has(assignment.sourceKey), `${capture.id} assignment is not an emitted building`);
  }
  const surfaces = new Map(model.floorSurfaces.map((surface) => [surface.stableId, surface]));
  const surfaceCaptures = plan.filter((item) => item.surfaceId);
  assert(surfaceCaptures.length > 0, 'capture plan must retain pinned layered targets');
  for (const capture of surfaceCaptures) {
    const surface = surfaces.get(capture.surfaceId);
    assert(surface, `${capture.id} has no emitted floorSurface`);
    assert.equal(surface.featureId, capture.featureId, `${capture.id} surface resolves to a different feature`);
  }
});

test('layered prediction ignores observed Y and truth labels and uses one emitted stable surface', () => {
  const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'customs-3d.json'), 'utf8'));
  const base = observation(9000, {
    featureId: 'customs.dorms.two_story.main',
    surfaceId: 'customs.surface.3f03ef2c6b3b917900b5f2fe',
    pointRole: 'floor-contact',
    surfaceKind: 'floor',
    x: 230.95,
    y: 0.6,
    z: 149.82,
  });
  const prediction = predictArtifactSurface(base, model);
  const adversarial = predictArtifactSurface({
    ...base,
    y: 999,
    pointRole: 'roof-contact',
    surfaceKind: 'underground',
  }, model);
  assert.deepEqual(adversarial, prediction);
  assert.equal(prediction.surfaceKind, 'floor');
  assert.equal(prediction.y, 0.534);
  assert.equal(prediction.surfaceId, base.surfaceId);
});

test('building-source roofs and named underground surfaces are reachable without reviewed feature IDs', () => {
  const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'customs-3d.json'), 'utf8'));
  const center = (poly) => poly.reduce((sum, [x, z]) => ({
    x: sum.x + x / poly.length,
    z: sum.z + z / poly.length,
  }), { x: 0, z: 0 });

  const roofId = 'customs.surface.52bc8fc15e7b5f4eaebf92b7';
  const roof = model.floorSurfaces.find((surface) => surface.stableId === roofId);
  const roofBuilding = model.buildings.find((building) => building.sourceKey === roof.buildingSourceKey);
  const roofPrediction = predictArtifactSurface({
    ...observation(9003),
    featureId: 'customs.audit.dead_scav_warehouse_roof',
    surfaceId: roofId,
    pointRole: 'roof-contact',
    surfaceKind: 'roof',
    ...center(roofBuilding.poly),
  }, model);
  assert.deepEqual(roofPrediction, {
    surfaceKind: 'roof', y: 9.8484, source: 'artifact-building-source',
    surfaceId: roofId, floorIndex: 1,
  });

  const undergroundId = 'customs.surface.93c7975dbb9c918ee0aa8623';
  const underground = model.underground.find((item) => item.name === 'switch basement');
  const undergroundPrediction = predictArtifactSurface({
    ...observation(9004),
    featureId: 'customs.audit.switch_basement',
    surfaceId: undergroundId,
    pointRole: 'underground-contact',
    surfaceKind: 'underground',
    ...center(underground.poly),
  }, model);
  assert.deepEqual(undergroundPrediction, {
    surfaceKind: 'underground', y: -2.547, source: 'artifact-underground-footprint',
    surfaceId: undergroundId, floorIndex: 'U',
  });
});

test('unpinned prediction is invariant to held-out role and truth labels', () => {
  const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'customs-3d.json'), 'utf8'));
  const base = observation(9002, {
    featureId: 'customs.audit.dangling',
    pointRole: 'ground-contact',
    surfaceKind: 'ground',
    x: 0,
    y: 0,
    z: 0,
  });
  const prediction = predictArtifactSurface(base, model);
  const adversarial = predictArtifactSurface({
    ...base,
    pointRole: 'object-center',
    surfaceKind: 'object',
    y: 999,
  }, model);
  assert.deepEqual(adversarial, prediction);
  assert.equal(prediction.surfaceKind, 'ground');
});

test('a real emitted Dorms floor surface produces a held-out vertical prediction', () => {
  const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'customs-3d.json'), 'utf8'));
  const probe = observation(9001, {
    featureId: 'customs.dorms.two_story.main',
    surfaceId: 'customs.surface.3f03ef2c6b3b917900b5f2fe',
    pointRole: 'floor-contact',
    surfaceKind: 'floor',
    source: 'independent-surface-survey',
    verticalReference: 'surface-contact',
    surfaceOffsetM: null,
    x: 230.95,
    y: 0.6,
    z: 149.82,
  });
  const report = auditAccuracy({ observations: [probe], model });
  assert.equal(report.errors.length, 0, report.errors.join('\n'));
  assert.equal(report.gates.vertical.count, 1);
  assert.equal(report.gates.vertical.resolved, 1);
  assert.equal(report.gates.vertical.unresolved, 0);
  assert.equal(report.gates.surface.byObservedKind.floor.resolved, 1);
});

test('an empty bootstrap never certifies or substitutes in-sample residuals', () => {
  const document = createBootstrapDocument();
  const report = auditAccuracy({ observations: document.observations, model: passingFixture().model });
  assert.equal(report.certified, false);
  assert.equal(report.gates.independentEvidence.pass, false);
  assert.equal(report.gates.horizontal.pass, false);
  assert.equal(report.gates.vertical.pass, false);
  assert.match(report.truthPolicy, /held-out/);
});

test('a one-line companion JSONL file is read as one observation, not an empty document', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tarkovzero-audit-')), 'one.jsonl');
  fs.writeFileSync(file, `${JSON.stringify(observation(1))}\n`);
  const evidence = readEvidenceFiles([file]);
  assert.equal(evidence.observations.length, 1);
  assert.equal(evidence.documents.length, 0);
});

test('all gates pass using predictions derived only from emitted model artifacts', () => {
  const fixture = passingFixture();
  assert(fixture.observations.every((row) => !Object.hasOwn(row, 'model')));
  const report = auditAccuracy(fixture);
  assert.equal(report.errors.length, 0, report.errors.join('\n'));
  assert.equal(report.certified, true, JSON.stringify(report, null, 2));
  assert(report.gates.horizontal.count >= 30);
  assert.equal(report.gates.vertical.count, 30);
  assert(report.gates.surface.count >= 60);
  assert.equal(report.gates.objects.artifactStableIdRate, 1);
  assert.match(report.modelArtifactSha256, /^[a-f0-9]{64}$/);
});

test('unresolved held-out rows stay in denominators and prevent a partial-fit pass', () => {
  const fixture = passingFixture();
  fixture.observations = fixture.observations.filter((item) => !['orientation', 'dimension-endpoint'].includes(item.pointRole));
  fixture.observations.push(...Array.from({ length: 100 }, (_, index) => observation(10000 + index, {
    featureId: `customs.audit.missing_${index}`,
    tag: `unresolved object ${index}`,
    pointRole: 'object-center',
    surfaceKind: 'object',
    x: 10_000 + index,
    z: 10_000 + index,
  })));
  const report = auditAccuracy(fixture);
  assert.equal(report.gates.horizontal.count, 130);
  assert.equal(report.gates.horizontal.resolved, 30);
  assert.equal(report.gates.horizontal.unresolved, 100);
  assert.equal(report.gates.horizontal.pass, false);
  assert.equal(report.gates.surface.count, 160);
  assert.equal(report.gates.surface.unresolved, 100);
  assert.equal(report.gates.surface.pass, false);
  assert.equal(report.certified, false);
});

test('embedded predictions are rejected instead of letting held-out truth control the model', () => {
  const fixture = passingFixture();
  fixture.observations[1].model = { x: fixture.observations[1].x, y: fixture.observations[1].y, z: fixture.observations[1].z };
  const report = auditAccuracy(fixture);
  assert.equal(report.certified, false);
  assert.match(report.errors.join('\n'), /observation\.model is forbidden/);
});

test('route leakage and uncalibrated player-origin Y fail without discarding nonvertical evidence', () => {
  const fixture = passingFixture();
  fixture.observations[0].routeId = fixture.observations[1].routeId;
  for (let index = 1; index <= 10; index++) fixture.observations[index].surfaceOffsetM = null;
  const report = auditAccuracy(fixture);
  assert.equal(report.certified, false);
  assert.equal(report.gates.independentEvidence.pass, false);
  assert.match(report.errors.join('\n'), /partition leakage/);
  assert.equal(report.gates.vertical.count, 20);
  assert.equal(report.gates.vertical.pass, false);
  assert.equal(report.gates.horizontal.pass, true);
  assert.equal(report.gates.surface.pass, true);
});

test('EFT screenshot rows cannot claim surface-contact; the reserved capture source can', () => {
  const fixture = passingFixture();
  fixture.observations[1].verticalReference = 'surface-contact';
  let report = auditAccuracy(fixture);
  assert.match(report.errors.join('\n'), /always record player-origin/);

  fixture.observations[1].source = 'independent-surface-survey';
  report = auditAccuracy(fixture);
  assert(!report.errors.some((error) => error.includes('surface-contact')), report.errors.join('\n'));
});

test('bridge decks never borrow the terrain beneath them as predicted elevation', () => {
  const fixture = passingFixture();
  fixture.model.bridges.push({ path: [[0, 9], [1, 9]], width: 1, surfaceY: null });
  Object.assign(fixture.observations[1], { x: 0.5, z: 9, y: 2, pointRole: 'bridge-deck', surfaceKind: 'bridge-deck' });
  const report = auditAccuracy(fixture);
  assert.equal(report.gates.vertical.count, 30);
  assert.equal(report.gates.vertical.resolved, 29);
  assert.equal(report.gates.vertical.unresolved, 1);
  assert.equal(report.gates.vertical.pass, false);
});

test('the model contract rejects bad heightfield buckets and dangling/duplicate assignments', () => {
  const fixture = passingFixture();
  fixture.model.terrain.evidence = { schemaVersion: 3, heightfieldBuckets: ['ground', 'road', 'bridge-deck'] };
  fixture.model.features.assignments.push({ ...fixture.model.features.assignments[0] });
  fixture.model.features.assignments.push({ featureId: 'customs.audit.dangling', sourceKey: 'missing-building', emittedAs: 'building' });
  const report = auditAccuracy(fixture);
  assert.equal(report.certified, false);
  const errors = report.errors.join('\n');
  assert.match(errors, /heightfieldBuckets/);
  assert.match(errors, /duplicates featureId/);
  assert.match(errors, /duplicates sourceKey/);
  assert.match(errors, /dangling/);
});
