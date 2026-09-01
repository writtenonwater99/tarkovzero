import fs from 'node:fs';
import path from 'node:path';

export const SURVEY_SCHEMA_VERSION = 1;
export const SURVEY_MAP = 'customs';
export const SURVEY_PARTITIONS = Object.freeze(['train', 'held-out']);
export const SURVEY_SURFACE_KINDS = Object.freeze([
  'ground',
  'road',
  'bridge-deck',
  'water',
  'rock',
  'floor',
  'roof',
  'underground',
  'object',
]);
export const SURVEY_POINT_ROLES = Object.freeze([
  'ground-contact',
  'road-centerline',
  'bridge-deck',
  'waterline',
  'rock-contact',
  'floor-contact',
  'roof-contact',
  'underground-contact',
  'object-center',
  'object-corner',
  'door-threshold',
  'orientation',
  'dimension-endpoint',
]);
// EFT screenshot filenames expose the player transform. Surface-contact truth
// belongs to a separate capture source/schema and can never be selected here.
export const SURVEY_VERTICAL_REFERENCES = Object.freeze(['player-origin']);
const PINNED_SURFACE_KINDS = new Set(['floor', 'roof', 'underground']);
const PINNED_SURFACE_ROLES = new Set(['floor-contact', 'roof-contact', 'underground-contact']);
const SURFACE_ID = /^customs\.surface\.[a-f0-9]{24}$/;

const clean = (value) => value === undefined || value === null || value === true ? '' : String(value).trim();
const finite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));

function assertChoice(label, value, choices) {
  if (!choices.includes(value)) throw new Error(`${label} must be one of: ${choices.join(', ')}`);
}

function readCapturePlan(file, captureId) {
  let document;
  try { document = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`could not read survey plan ${file}: ${error.message}`); }
  if (document?.schemaVersion !== SURVEY_SCHEMA_VERSION || document?.map !== SURVEY_MAP || !Array.isArray(document.capturePlan)) {
    throw new Error(`survey plan ${file} must be a schema v${SURVEY_SCHEMA_VERSION} ${SURVEY_MAP} capture plan`);
  }
  const found = document.capturePlan.find((entry) => entry?.id === captureId);
  if (!found) throw new Error(`survey capture ${captureId} was not found in ${file}`);
  return found;
}

/**
 * Parse the opt-in survey CLI. Normal position/elevation logging never becomes
 * independent audit evidence by accident: survey mode only activates when a
 * survey flag or --survey-capture is supplied, and all evidence metadata is
 * validated before the companion starts watching screenshots.
 */
export function createSurveySession({ args, baseDir, resolvePath = path.resolve, simulate = false }) {
  const surveyKeys = [
    'survey-log', 'survey-plan', 'survey-capture', 'feature-id', 'survey-tag',
    'point-role', 'surface-kind', 'surface-id', 'partition', 'route-id', 'game-build',
    'confidence', 'vertical-reference', 'surface-offset', 'priority',
  ];
  const active = surveyKeys.some((key) => args[key] !== undefined);
  if (!active) return null;
  if (simulate) throw new Error('survey mode cannot run with --simulate; simulated coordinates are never audit evidence');

  const planPath = resolvePath(clean(args['survey-plan']) || path.join(baseDir, '..', 'data', 'customs-audit-anchors.json'));
  const captureId = clean(args['survey-capture']);
  const planned = captureId ? readCapturePlan(planPath, captureId) : {};
  const take = (argName, planName = argName) => clean(args[argName]) || clean(planned[planName]);

  const featureId = take('feature-id', 'featureId');
  const tag = take('survey-tag', 'tag');
  const pointRole = take('point-role', 'pointRole');
  const surfaceKind = take('surface-kind', 'surfaceKind');
  const surfaceId = take('surface-id', 'surfaceId');
  const partition = take('partition', 'partition');
  const routeId = take('route-id', 'routeId');
  const gameBuild = take('game-build', 'gameBuild');
  const verticalReference = take('vertical-reference', 'verticalReference') || 'player-origin';
  const confidenceRaw = args.confidence ?? planned.confidence;
  const priorityRaw = args.priority ?? planned.priority;
  const surfaceOffsetRaw = args['surface-offset'] ?? planned.surfaceOffsetM;

  if (!/^customs\.[a-z0-9][a-z0-9._-]*$/.test(featureId)) {
    throw new Error('--feature-id must be a stable lowercase id beginning with customs.');
  }
  if (!tag || tag.length > 120) throw new Error('--survey-tag is required and must be at most 120 characters');
  assertChoice('--point-role', pointRole, SURVEY_POINT_ROLES);
  assertChoice('--surface-kind', surfaceKind, SURVEY_SURFACE_KINDS);
  if ((PINNED_SURFACE_KINDS.has(surfaceKind) || PINNED_SURFACE_ROLES.has(pointRole)) && !SURFACE_ID.test(surfaceId)) {
    throw new Error('--surface-id must match the emitted customs.surface.<24 hex> stableId for a layered surface capture');
  }
  if (surfaceId && !SURFACE_ID.test(surfaceId)) throw new Error('--surface-id must match customs.surface.<24 hex>');
  assertChoice('--partition', partition, SURVEY_PARTITIONS);
  if (!/^customs\.[a-z0-9][a-z0-9._-]*$/.test(routeId)) {
    throw new Error('--route-id must be a stable lowercase id beginning with customs.');
  }
  if (!gameBuild || gameBuild.length > 80) throw new Error('--game-build is required and must be at most 80 characters');
  if (!finite(confidenceRaw) || Number(confidenceRaw) < 0 || Number(confidenceRaw) > 1) {
    throw new Error('--confidence is required and must be between 0 and 1');
  }
  assertChoice('--vertical-reference', verticalReference, SURVEY_VERTICAL_REFERENCES);
  const surfaceOffsetM = clean(surfaceOffsetRaw) === '' ? null : Number(surfaceOffsetRaw);
  if (surfaceOffsetM !== null && !Number.isFinite(surfaceOffsetM)) throw new Error('--surface-offset must be a finite number of metres');
  if (verticalReference === 'player-origin' && surfaceOffsetM === null) {
    // This is allowed so horizontal/classification evidence can still be captured,
    // but the accuracy harness will not pretend the raw player origin is ground Y.
  }

  const requestedLog = args['survey-log'];
  const logPath = resolvePath(
    requestedLog && requestedLog !== true
      ? clean(requestedLog)
      : path.join(baseDir, 'survey-customs.jsonl'),
  );
  return Object.freeze({
    schemaVersion: SURVEY_SCHEMA_VERSION,
    map: SURVEY_MAP,
    captureId: captureId || null,
    featureId,
    tag,
    pointRole,
    surfaceKind,
    surfaceId: surfaceId || null,
    partition,
    routeId,
    gameBuild,
    confidence: Number(confidenceRaw),
    priority: priorityRaw === true || /^(1|true|yes)$/i.test(clean(priorityRaw)),
    verticalReference,
    surfaceOffsetM,
    logPath,
    planPath: captureId ? planPath : null,
  });
}

export function buildSurveyObservation(session, position, { screenshotId, capturedAt = new Date().toISOString() }) {
  if (!session) throw new Error('survey session is not active');
  if (session.verticalReference !== 'player-origin') throw new Error('EFT screenshot survey records must use player-origin');
  if ((PINNED_SURFACE_KINDS.has(session.surfaceKind) || PINNED_SURFACE_ROLES.has(session.pointRole))
      && !SURFACE_ID.test(String(session.surfaceId || ''))) {
    throw new Error('layered EFT screenshot survey records require an emitted surfaceId');
  }
  if (String(position?.map || '').toLowerCase() !== SURVEY_MAP) {
    throw new Error(`survey evidence is Customs-only; companion reported map ${position?.map || '(unknown)'}`);
  }
  const coordinates = ['x', 'y', 'z', 'yaw'];
  if (!coordinates.every((key) => finite(position?.[key]))) throw new Error('survey position must contain finite x, y, z, and yaw');
  const screenshot = path.basename(clean(screenshotId));
  if (!screenshot) throw new Error('survey observation requires the EFT screenshot filename as screenshotId');
  if (Number.isNaN(Date.parse(capturedAt))) throw new Error('survey observation requires an ISO capturedAt timestamp');
  return {
    schemaVersion: SURVEY_SCHEMA_VERSION,
    recordType: 'tarkovzero-survey-observation',
    map: SURVEY_MAP,
    featureId: session.featureId,
    tag: session.tag,
    pointRole: session.pointRole,
    surfaceKind: session.surfaceKind,
    surfaceId: session.surfaceId,
    partition: session.partition,
    routeId: session.routeId,
    priority: session.priority,
    gameBuild: session.gameBuild,
    confidence: session.confidence,
    screenshotId: screenshot,
    capturedAt,
    source: 'eft-screenshot-filename',
    coordinateFrame: 'eft-unity-world-metres-y-up',
    verticalReference: 'player-origin',
    surfaceOffsetM: session.surfaceOffsetM,
    x: Number(position.x),
    y: Number(position.y),
    z: Number(position.z),
    yaw: Number(position.yaw),
  };
}

export function appendSurveyObservation(session, observation) {
  fs.mkdirSync(path.dirname(session.logPath), { recursive: true });
  fs.appendFileSync(session.logPath, `${JSON.stringify(observation)}\n`, { encoding: 'utf8', mode: 0o600 });
}
