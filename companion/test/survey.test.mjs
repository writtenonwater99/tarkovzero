import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendSurveyObservation, buildSurveyObservation, createSurveySession } from '../survey.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

test('ordinary companion args never activate independent survey evidence', () => {
  assert.equal(createSurveySession({ args: { map: 'customs', verbose: true }, baseDir: path.join(ROOT, 'companion') }), null);
});

test('a planned capture emits the complete, auditable Customs schema', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tarkovzero-survey-'));
  const logPath = path.join(temp, 'observations.jsonl');
  const session = createSurveySession({
    args: {
      'survey-capture': 'dorms-east-ground-held-out',
      'game-build': 'EFT-test-build',
      confidence: '0.93',
      'surface-offset': '0.15',
      'survey-log': logPath,
    },
    baseDir: path.join(ROOT, 'companion'),
  });
  assert.equal(session.featureId, 'customs.dorms.ground.east_route');
  assert.equal(session.partition, 'held-out');
  assert.equal(session.routeId, 'customs.route.dorms.east_held_out');
  assert.equal(session.surfaceKind, 'ground');
  assert.equal(session.surfaceOffsetM, 0.15);

  const observation = buildSurveyObservation(
    session,
    { map: 'customs', x: 230.25, y: 1.4, z: 149.5, yaw: -15.2 },
    { screenshotId: '2026-08-31[12-00]_position.png', capturedAt: '2026-08-31T19:00:00.000Z' },
  );
  assert.deepEqual(
    Object.keys(observation).filter((key) => ['featureId', 'tag', 'pointRole', 'surfaceKind', 'partition', 'routeId', 'gameBuild', 'confidence', 'screenshotId'].includes(key)).sort(),
    ['confidence', 'featureId', 'gameBuild', 'partition', 'pointRole', 'routeId', 'screenshotId', 'surfaceKind', 'tag'],
  );
  assert.equal(observation.source, 'eft-screenshot-filename');
  assert.equal(observation.verticalReference, 'player-origin');
  assert.equal(observation.x, 230.25);
  assert.equal(observation.screenshotId, '2026-08-31[12-00]_position.png');

  appendSurveyObservation(session, observation);
  assert.deepEqual(JSON.parse(fs.readFileSync(logPath, 'utf8').trim()), observation);
});

test('a layered capture carries its emitted stable surface selector', () => {
  const session = createSurveySession({
    args: {
      'survey-capture': 'dorms-two-story-floor-0-held-out',
      'game-build': 'EFT-test-build',
      confidence: '0.95',
    },
    baseDir: path.join(ROOT, 'companion'),
  });
  assert.equal(session.pointRole, 'floor-contact');
  assert.equal(session.surfaceId, 'customs.surface.3f03ef2c6b3b917900b5f2fe');
  const observation = buildSurveyObservation(
    session,
    { map: 'customs', x: 230.95, y: 1.7, z: 149.82, yaw: 0 },
    { screenshotId: 'dorms-floor.png' },
  );
  assert.equal(observation.surfaceId, session.surfaceId);
  assert.equal(observation.verticalReference, 'player-origin');
});

test('survey mode rejects simulation, incomplete metadata, and non-Customs observations', () => {
  assert.throws(
    () => createSurveySession({ args: { 'survey-log': true }, baseDir: path.join(ROOT, 'companion'), simulate: true }),
    /simulated coordinates are never audit evidence/,
  );
  assert.throws(
    () => createSurveySession({ args: { 'survey-log': true, 'feature-id': 'customs.test' }, baseDir: path.join(ROOT, 'companion') }),
    /survey-tag is required/,
  );
  assert.throws(
    () => createSurveySession({
      args: {
        'survey-log': true,
        'feature-id': 'customs.test.floor',
        'survey-tag': 'test floor',
        'point-role': 'floor-contact',
        'surface-kind': 'floor',
        partition: 'held-out',
        'route-id': 'customs.route.test_floor',
        'game-build': 'test',
        confidence: '1',
      },
      baseDir: path.join(ROOT, 'companion'),
    }),
    /surface-id.*emitted/,
  );
  assert.throws(
    () => createSurveySession({
      args: {
        'survey-capture': 'dorms-east-ground-held-out',
        'game-build': 'test',
        confidence: '1',
        'vertical-reference': 'surface-contact',
      },
      baseDir: path.join(ROOT, 'companion'),
    }),
    /vertical-reference.*player-origin/,
  );
  const session = createSurveySession({
    args: {
      'survey-log': true,
      'feature-id': 'customs.test.ground',
      'survey-tag': 'test point',
      'point-role': 'ground-contact',
      'surface-kind': 'ground',
      partition: 'train',
      'route-id': 'customs.route.test_train',
      'game-build': 'test',
      confidence: '1',
    },
    baseDir: path.join(ROOT, 'companion'),
  });
  assert.throws(
    () => buildSurveyObservation(session, { map: 'reserve', x: 0, y: 0, z: 0, yaw: 0 }, { screenshotId: 'reserve.png' }),
    /Customs-only/,
  );
});
