const ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MATRIX_EPSILON = 1e-15;
const COMPARISON_EPSILON = 1e-9;

export const CUSTOMS_TRUTH_GRAPH_SCHEMA_VERSION = 1;
export const IDENTITY_MATRIX = Object.freeze([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

const fail = (path, message) => {
  throw new Error(`customs truth graph ${path}: ${message}`);
};

const isPlainObject = (value) => Boolean(value)
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;

function objectAt(value, path) {
  if (!isPlainObject(value)) fail(path, 'must be a plain object');
  return value;
}

function exactKeys(value, allowed, path) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  if (unexpected.length) fail(path, `contains unsupported field(s): ${unexpected.join(', ')}`);
}

function requiredText(value, path) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    fail(path, 'must be a non-empty, already-trimmed string');
  }
  return value;
}

function stableId(value, path, prefix) {
  const id = requiredText(value, path);
  if (!ID_PATTERN.test(id)) fail(path, 'must be a lowercase stable ID with a namespace separator');
  if (prefix && !id.startsWith(prefix)) fail(path, `must start with ${prefix}`);
  return id;
}

function finiteNumber(value, path) {
  if (!Number.isFinite(value)) fail(path, 'must be a finite number');
  return Object.is(value, -0) ? 0 : value;
}

function finiteVector(value, length, path) {
  if (!Array.isArray(value) || value.length !== length) fail(path, `must contain exactly ${length} numbers`);
  return value.map((entry, index) => finiteNumber(entry, `${path}[${index}]`));
}

function integer(value, path, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(path, `must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function booleanTrue(value, path) {
  if (value !== true) fail(path, 'must be true; payload-bearing records are outside this graph');
  return true;
}

function cleanFloat(value) {
  if (Object.is(value, -0) || Math.abs(value) < MATRIX_EPSILON) return 0;
  return value;
}

function closeEnough(actual, expected) {
  return Math.abs(actual - expected) <= COMPARISON_EPSILON * Math.max(1, Math.abs(actual), Math.abs(expected));
}

function stringRefs(value, path, prefix) {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  const refs = value.map((entry, index) => stableId(entry, `${path}[${index}]`, prefix));
  if (new Set(refs).size !== refs.length) fail(path, 'must not contain duplicate IDs');
  return refs.sort();
}

function uniqueSortedRecords(value, idField, path, prefix) {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  const records = value.map((record, index) => {
    const object = objectAt(record, `${path}[${index}]`);
    stableId(object[idField], `${path}[${index}].${idField}`, prefix);
    return { object, inputPath: `${path}[${index}]` };
  });
  records.sort((a, b) => (a.object[idField] < b.object[idField] ? -1 : a.object[idField] > b.object[idField] ? 1 : 0));
  for (let index = 1; index < records.length; index += 1) {
    if (records[index - 1].object[idField] === records[index].object[idField]) {
      fail(path, `contains duplicate ${idField} ${records[index].object[idField]}`);
    }
  }
  return records;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

/**
 * Normalize an xyzw quaternion and choose one canonical sign. q and -q encode
 * the same rotation, so this removes a source of otherwise meaningless diffs.
 */
export function normalizeQuaternion(value, path = 'quaternion') {
  const quaternion = finiteVector(value, 4, path);
  const magnitude = Math.hypot(...quaternion);
  if (magnitude <= Number.EPSILON) fail(path, 'must have non-zero length');
  let normalized = quaternion.map((entry) => cleanFloat(entry / magnitude));
  const signProbe = [normalized[3], normalized[0], normalized[1], normalized[2]]
    .find((entry) => Math.abs(entry) >= MATRIX_EPSILON) ?? 0;
  if (signProbe < 0) normalized = normalized.map((entry) => cleanFloat(-entry));
  return normalized;
}

function normalizeLocalTransform(value, path) {
  const transform = objectAt(value, path);
  exactKeys(transform, ['translation', 'rotation', 'scale'], path);
  const translation = finiteVector(transform.translation, 3, `${path}.translation`);
  const rotation = normalizeQuaternion(transform.rotation, `${path}.rotation`);
  const scale = finiteVector(transform.scale, 3, `${path}.scale`);
  for (let index = 0; index < scale.length; index += 1) {
    if (scale[index] === 0) fail(`${path}.scale[${index}]`, 'must be non-zero');
  }
  return { translation, rotation, scale };
}

/** Compose a column-major affine matrix as translation * rotation * scale. */
export function composeTransformMatrix(value) {
  const transform = normalizeLocalTransform(value, 'transform');
  const [x, y, z, w] = transform.rotation;
  const [sx, sy, sz] = transform.scale;
  const [tx, ty, tz] = transform.translation;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ].map(cleanFloat);
}

/** Multiply two column-major 4x4 matrices, returning a * b. */
export function multiplyMatrices(a, b) {
  if (!Array.isArray(a) || a.length !== 16 || !a.every(Number.isFinite)) {
    fail('matrix a', 'must contain exactly 16 finite numbers');
  }
  if (!Array.isArray(b) || b.length !== 16 || !b.every(Number.isFinite)) {
    fail('matrix b', 'must contain exactly 16 finite numbers');
  }
  const output = new Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let total = 0;
      for (let inner = 0; inner < 4; inner += 1) total += a[(inner * 4) + row] * b[(column * 4) + inner];
      output[(column * 4) + row] = cleanFloat(total);
    }
  }
  return output;
}

export function transformPoint(matrix, point) {
  if (!Array.isArray(matrix) || matrix.length !== 16 || !matrix.every(Number.isFinite)) {
    fail('matrix', 'must contain exactly 16 finite numbers');
  }
  const [x, y, z] = finiteVector(point, 3, 'point');
  const homogeneousW = (matrix[3] * x) + (matrix[7] * y) + (matrix[11] * z) + matrix[15];
  if (Math.abs(homogeneousW) <= Number.EPSILON) fail('matrix', 'maps the point to an invalid homogeneous coordinate');
  return [
    ((matrix[0] * x) + (matrix[4] * y) + (matrix[8] * z) + matrix[12]) / homogeneousW,
    ((matrix[1] * x) + (matrix[5] * y) + (matrix[9] * z) + matrix[13]) / homogeneousW,
    ((matrix[2] * x) + (matrix[6] * y) + (matrix[10] * z) + matrix[14]) / homogeneousW,
  ].map(cleanFloat);
}

function normalizeCoordinates(value) {
  const path = 'coordinates';
  const coordinates = objectAt(value, path);
  exactKeys(coordinates, [
    'frameId', 'units', 'handedness', 'axes', 'quaternionOrder', 'matrixConvention',
  ], path);
  const frameId = stableId(coordinates.frameId, `${path}.frameId`, 'customs.');
  if (coordinates.units !== 'metre') fail(`${path}.units`, 'must be metre');
  if (!['left-handed', 'right-handed'].includes(coordinates.handedness)) {
    fail(`${path}.handedness`, 'must be left-handed or right-handed');
  }
  const axes = objectAt(coordinates.axes, `${path}.axes`);
  exactKeys(axes, ['x', 'y', 'z'], `${path}.axes`);
  const normalizedAxes = {
    x: requiredText(axes.x, `${path}.axes.x`),
    y: requiredText(axes.y, `${path}.axes.y`),
    z: requiredText(axes.z, `${path}.axes.z`),
  };
  if (new Set(Object.values(normalizedAxes)).size !== 3) fail(`${path}.axes`, 'must assign three distinct directions');
  if (coordinates.quaternionOrder !== 'xyzw') fail(`${path}.quaternionOrder`, 'must be xyzw');
  if (coordinates.matrixConvention !== 'column-major-parent-times-local') {
    fail(`${path}.matrixConvention`, 'must be column-major-parent-times-local');
  }
  return {
    frameId,
    units: 'metre',
    handedness: coordinates.handedness,
    axes: normalizedAxes,
    quaternionOrder: 'xyzw',
    matrixConvention: 'column-major-parent-times-local',
  };
}

function normalizeSources(value) {
  return uniqueSortedRecords(value, 'sourceId', 'sources', 'source.').map(({ object, inputPath }) => {
    exactKeys(object, ['sourceId', 'kind', 'capturedAt', 'digest', 'payloadExcluded'], inputPath);
    const capturedAt = requiredText(object.capturedAt, `${inputPath}.capturedAt`);
    if (!Number.isFinite(Date.parse(capturedAt)) || new Date(capturedAt).toISOString() !== capturedAt) {
      fail(`${inputPath}.capturedAt`, 'must be a canonical ISO-8601 timestamp');
    }
    if (!SHA256_PATTERN.test(object.digest)) fail(`${inputPath}.digest`, 'must be sha256: followed by 64 lowercase hex characters');
    return {
      sourceId: object.sourceId,
      kind: requiredText(object.kind, `${inputPath}.kind`),
      capturedAt,
      digest: object.digest,
      payloadExcluded: booleanTrue(object.payloadExcluded, `${inputPath}.payloadExcluded`),
    };
  });
}

function normalizeEvidence(value, sourceIds) {
  return uniqueSortedRecords(value, 'evidenceId', 'evidence', 'evidence.').map(({ object, inputPath }) => {
    exactKeys(object, ['evidenceId', 'sourceId', 'kind', 'featureId', 'confidence', 'position'], inputPath);
    const sourceId = stableId(object.sourceId, `${inputPath}.sourceId`, 'source.');
    if (!sourceIds.has(sourceId)) fail(`${inputPath}.sourceId`, `references missing source ${sourceId}`);
    const featureId = stableId(object.featureId, `${inputPath}.featureId`, 'customs.');
    const confidence = finiteNumber(object.confidence, `${inputPath}.confidence`);
    if (confidence < 0 || confidence > 1) fail(`${inputPath}.confidence`, 'must be from 0 through 1');
    return {
      evidenceId: object.evidenceId,
      sourceId,
      kind: requiredText(object.kind, `${inputPath}.kind`),
      featureId,
      confidence,
      position: finiteVector(object.position, 3, `${inputPath}.position`),
    };
  });
}

function normalizeAssets(value, sourceIds, evidenceIds) {
  return uniqueSortedRecords(value, 'assetId', 'assets', 'asset.').map(({ object, inputPath }) => {
    exactKeys(object, [
      'assetId', 'family', 'variant', 'revision', 'authoring', 'license',
      'sourceIds', 'evidenceIds', 'payloadExcluded',
    ], inputPath);
    const normalizedSourceIds = stringRefs(object.sourceIds, `${inputPath}.sourceIds`, 'source.');
    const normalizedEvidenceIds = stringRefs(object.evidenceIds, `${inputPath}.evidenceIds`, 'evidence.');
    for (const sourceId of normalizedSourceIds) {
      if (!sourceIds.has(sourceId)) fail(`${inputPath}.sourceIds`, `references missing source ${sourceId}`);
    }
    for (const evidenceId of normalizedEvidenceIds) {
      if (!evidenceIds.has(evidenceId)) fail(`${inputPath}.evidenceIds`, `references missing evidence ${evidenceId}`);
    }
    if (!['independent-original', 'licensed-third-party'].includes(object.authoring)) {
      fail(`${inputPath}.authoring`, 'must be independent-original or licensed-third-party');
    }
    return {
      assetId: object.assetId,
      family: requiredText(object.family, `${inputPath}.family`),
      variant: requiredText(object.variant, `${inputPath}.variant`),
      revision: integer(object.revision, `${inputPath}.revision`, 1),
      authoring: object.authoring,
      license: requiredText(object.license, `${inputPath}.license`),
      sourceIds: normalizedSourceIds,
      evidenceIds: normalizedEvidenceIds,
      payloadExcluded: booleanTrue(object.payloadExcluded, `${inputPath}.payloadExcluded`),
    };
  });
}

function normalizeSceneNodes(value, assetIds, evidenceIds) {
  const records = uniqueSortedRecords(value, 'nodeId', 'sceneNodes', 'customs.node.');
  const normalized = records.map(({ object, inputPath }) => {
    exactKeys(object, ['nodeId', 'featureId', 'parentId', 'assetId', 'evidenceIds', 'localTransform'], inputPath);
    const featureId = stableId(object.featureId, `${inputPath}.featureId`, 'customs.feature.');
    const parentId = object.parentId === null
      ? null : stableId(object.parentId, `${inputPath}.parentId`, 'customs.node.');
    const assetId = object.assetId === null
      ? null : stableId(object.assetId, `${inputPath}.assetId`, 'asset.');
    if (assetId !== null && !assetIds.has(assetId)) fail(`${inputPath}.assetId`, `references missing asset ${assetId}`);
    const normalizedEvidenceIds = stringRefs(object.evidenceIds, `${inputPath}.evidenceIds`, 'evidence.');
    for (const evidenceId of normalizedEvidenceIds) {
      if (!evidenceIds.has(evidenceId)) fail(`${inputPath}.evidenceIds`, `references missing evidence ${evidenceId}`);
    }
    const localTransform = normalizeLocalTransform(object.localTransform, `${inputPath}.localTransform`);
    return {
      nodeId: object.nodeId,
      featureId,
      parentId,
      assetId,
      evidenceIds: normalizedEvidenceIds,
      localTransform,
      localMatrix: composeTransformMatrix(localTransform),
    };
  });

  const featureIds = new Set();
  const nodeById = new Map(normalized.map((node) => [node.nodeId, node]));
  for (const node of normalized) {
    if (featureIds.has(node.featureId)) fail('sceneNodes', `contains duplicate featureId ${node.featureId}`);
    featureIds.add(node.featureId);
    if (node.parentId !== null && !nodeById.has(node.parentId)) {
      fail(`sceneNodes.${node.nodeId}.parentId`, `references missing parent ${node.parentId}`);
    }
  }

  const state = new Map();
  const stack = [];
  const worldMatrices = new Map();
  const visit = (node) => {
    if (state.get(node.nodeId) === 2) return worldMatrices.get(node.nodeId);
    if (state.get(node.nodeId) === 1) {
      const cycleStart = stack.indexOf(node.nodeId);
      const cycle = [...stack.slice(cycleStart), node.nodeId].join(' -> ');
      fail('sceneNodes', `contains a parent cycle: ${cycle}`);
    }
    state.set(node.nodeId, 1);
    stack.push(node.nodeId);
    const parentWorld = node.parentId === null ? IDENTITY_MATRIX : visit(nodeById.get(node.parentId));
    const world = multiplyMatrices(parentWorld, node.localMatrix);
    stack.pop();
    state.set(node.nodeId, 2);
    worldMatrices.set(node.nodeId, world);
    return world;
  };
  for (const node of normalized) visit(node);

  return normalized.map((node) => ({
    nodeId: node.nodeId,
    featureId: node.featureId,
    parentId: node.parentId,
    assetId: node.assetId,
    evidenceIds: node.evidenceIds,
    localTransform: node.localTransform,
    localMatrix: node.localMatrix,
    worldTransform: { matrix: worldMatrices.get(node.nodeId) },
  }));
}

function signedHeightToWorldY(tile, raw) {
  return cleanFloat(tile.terrainOriginYM + ((raw / tile.heightEncoding.divisor) * tile.heightScaleM));
}

/**
 * Convert an already decoded signed height sample into world-Y metres. This is
 * deliberately not a byte decoder: binary layout and bit reinterpretation stay
 * quarantined outside the metadata graph.
 */
export function rawSignedHeightToWorldY(tile, raw) {
  const object = objectAt(tile, 'terrain tile');
  const rawRange = objectAt(object.rawRange, 'terrain tile.rawRange');
  const rawMin = integer(rawRange.min, 'terrain tile.rawRange.min', -32768, 32767);
  const rawMax = integer(rawRange.max, 'terrain tile.rawRange.max', -32768, 32767);
  if (rawMin > rawMax) fail('terrain tile.rawRange', 'min must not exceed max');
  const sample = integer(raw, 'terrain raw sample', rawMin, rawMax);
  const heightEncoding = objectAt(object.heightEncoding, 'terrain tile.heightEncoding');
  exactKeys(heightEncoding, ['storage', 'interpretation', 'divisor', 'sampleOrder'], 'terrain tile.heightEncoding');
  if (heightEncoding.storage !== 'sint16') fail('terrain tile.heightEncoding.storage', 'must be sint16');
  if (heightEncoding.interpretation !== 'signed-linear') {
    fail('terrain tile.heightEncoding.interpretation', 'must be signed-linear');
  }
  if (heightEncoding.sampleOrder !== 'row-major-z-times-columns-plus-x') {
    fail('terrain tile.heightEncoding.sampleOrder', 'must be row-major-z-times-columns-plus-x');
  }
  const divisor = integer(heightEncoding.divisor, 'terrain tile.heightEncoding.divisor', 1, 65535);
  if (divisor !== 32767) fail('terrain tile.heightEncoding.divisor', 'must be 32767 for signed-linear Customs heights');
  const heightScaleM = finiteNumber(object.heightScaleM, 'terrain tile.heightScaleM');
  if (heightScaleM <= 0) fail('terrain tile.heightScaleM', 'must be greater than zero');
  const terrainOriginYM = finiteNumber(object.terrainOriginYM, 'terrain tile.terrainOriginYM');
  return signedHeightToWorldY({
    heightEncoding: {
      storage: 'sint16',
      interpretation: 'signed-linear',
      divisor,
      sampleOrder: 'row-major-z-times-columns-plus-x',
    },
    heightScaleM,
    terrainOriginYM,
  }, sample);
}

function normalizeTerrainTiles(value, sourceIds, evidenceIds) {
  return uniqueSortedRecords(value, 'tileId', 'terrainTiles', 'customs.terrain.').map(({ object, inputPath }) => {
    exactKeys(object, [
      'tileId', 'sourceId', 'evidenceIds', 'bounds', 'resolution', 'sampleSpacingM',
      'heightEncoding', 'rawRange', 'heightScaleM', 'terrainOriginYM',
      'worldElevationRangeM', 'payloadExcluded',
    ], inputPath);
    const sourceId = stableId(object.sourceId, `${inputPath}.sourceId`, 'source.');
    if (!sourceIds.has(sourceId)) fail(`${inputPath}.sourceId`, `references missing source ${sourceId}`);
    const normalizedEvidenceIds = stringRefs(object.evidenceIds, `${inputPath}.evidenceIds`, 'evidence.');
    for (const evidenceId of normalizedEvidenceIds) {
      if (!evidenceIds.has(evidenceId)) fail(`${inputPath}.evidenceIds`, `references missing evidence ${evidenceId}`);
    }

    const bounds = objectAt(object.bounds, `${inputPath}.bounds`);
    exactKeys(bounds, ['min', 'max'], `${inputPath}.bounds`);
    const min = finiteVector(bounds.min, 2, `${inputPath}.bounds.min`);
    const max = finiteVector(bounds.max, 2, `${inputPath}.bounds.max`);
    if (max[0] <= min[0] || max[1] <= min[1]) fail(`${inputPath}.bounds`, 'max must exceed min on X and Z');

    const resolution = objectAt(object.resolution, `${inputPath}.resolution`);
    exactKeys(resolution, ['columns', 'rows'], `${inputPath}.resolution`);
    const columns = integer(resolution.columns, `${inputPath}.resolution.columns`, 2);
    const rows = integer(resolution.rows, `${inputPath}.resolution.rows`, 2);

    const spacing = objectAt(object.sampleSpacingM, `${inputPath}.sampleSpacingM`);
    exactKeys(spacing, ['x', 'z'], `${inputPath}.sampleSpacingM`);
    const spacingX = finiteNumber(spacing.x, `${inputPath}.sampleSpacingM.x`);
    const spacingZ = finiteNumber(spacing.z, `${inputPath}.sampleSpacingM.z`);
    if (spacingX <= 0 || spacingZ <= 0) fail(`${inputPath}.sampleSpacingM`, 'x and z must be greater than zero');
    const expectedWidth = (columns - 1) * spacingX;
    const expectedDepth = (rows - 1) * spacingZ;
    if (!closeEnough(max[0] - min[0], expectedWidth) || !closeEnough(max[1] - min[1], expectedDepth)) {
      fail(`${inputPath}.sampleSpacingM`, 'does not match bounds and sample resolution');
    }

    const heightEncoding = objectAt(object.heightEncoding, `${inputPath}.heightEncoding`);
    exactKeys(heightEncoding, ['storage', 'interpretation', 'divisor', 'sampleOrder'], `${inputPath}.heightEncoding`);
    if (heightEncoding.storage !== 'sint16') fail(`${inputPath}.heightEncoding.storage`, 'must be sint16');
    if (heightEncoding.interpretation !== 'signed-linear') {
      fail(`${inputPath}.heightEncoding.interpretation`, 'must be signed-linear');
    }
    if (heightEncoding.sampleOrder !== 'row-major-z-times-columns-plus-x') {
      fail(`${inputPath}.heightEncoding.sampleOrder`, 'must be row-major-z-times-columns-plus-x');
    }
    const divisor = integer(heightEncoding.divisor, `${inputPath}.heightEncoding.divisor`, 1, 65535);
    if (divisor !== 32767) {
      fail(`${inputPath}.heightEncoding.divisor`, 'must be 32767 for signed-linear Customs heights');
    }
    const rawRange = objectAt(object.rawRange, `${inputPath}.rawRange`);
    exactKeys(rawRange, ['min', 'max'], `${inputPath}.rawRange`);
    const rawMin = integer(rawRange.min, `${inputPath}.rawRange.min`, -32768, 32767);
    const rawMax = integer(rawRange.max, `${inputPath}.rawRange.max`, -32768, 32767);
    if (rawMin > rawMax) fail(`${inputPath}.rawRange`, 'min must not exceed max');
    const heightScaleM = finiteNumber(object.heightScaleM, `${inputPath}.heightScaleM`);
    if (heightScaleM <= 0) fail(`${inputPath}.heightScaleM`, 'must be greater than zero');
    const terrainOriginYM = finiteNumber(object.terrainOriginYM, `${inputPath}.terrainOriginYM`);

    const declaredWorldRange = objectAt(object.worldElevationRangeM, `${inputPath}.worldElevationRangeM`);
    exactKeys(declaredWorldRange, ['min', 'max'], `${inputPath}.worldElevationRangeM`);
    const declaredMin = finiteNumber(declaredWorldRange.min, `${inputPath}.worldElevationRangeM.min`);
    const declaredMax = finiteNumber(declaredWorldRange.max, `${inputPath}.worldElevationRangeM.max`);
    const normalizedHeightEncoding = {
      storage: 'sint16',
      interpretation: 'signed-linear',
      divisor,
      sampleOrder: 'row-major-z-times-columns-plus-x',
    };
    const conversionMetadata = { heightEncoding: normalizedHeightEncoding, heightScaleM, terrainOriginYM };
    const worldMin = signedHeightToWorldY(conversionMetadata, rawMin);
    const worldMax = signedHeightToWorldY(conversionMetadata, rawMax);
    if (!closeEnough(declaredMin, worldMin) || !closeEnough(declaredMax, worldMax)) {
      fail(`${inputPath}.worldElevationRangeM`, `must equal the derived range ${worldMin} through ${worldMax}`);
    }

    return {
      tileId: object.tileId,
      sourceId,
      evidenceIds: normalizedEvidenceIds,
      bounds: { min, max },
      resolution: { columns, rows },
      sampleSpacingM: { x: spacingX, z: spacingZ },
      heightEncoding: normalizedHeightEncoding,
      rawRange: { min: rawMin, max: rawMax },
      heightScaleM,
      terrainOriginYM,
      worldElevationRangeM: { min: worldMin, max: worldMax },
      payloadExcluded: booleanTrue(object.payloadExcluded, `${inputPath}.payloadExcluded`),
    };
  });
}

/**
 * Validate and canonicalize a metadata-only Customs truth graph. The contract
 * deliberately permits identities, transforms, measurements, and evidence but
 * no meshes, textures, height arrays, file paths, URLs, byte buffers, or other
 * payload-bearing fields.
 */
export function normalizeCustomsTruthGraph(value) {
  const graph = objectAt(value, 'root');
  exactKeys(graph, [
    'schemaVersion', 'graphId', 'map', 'coordinates', 'sources', 'evidence',
    'assets', 'sceneNodes', 'terrainTiles',
  ], 'root');
  if (graph.schemaVersion !== CUSTOMS_TRUTH_GRAPH_SCHEMA_VERSION) {
    fail('schemaVersion', `must be ${CUSTOMS_TRUTH_GRAPH_SCHEMA_VERSION}`);
  }
  const graphId = stableId(graph.graphId, 'graphId', 'customs.truth.');
  if (graph.map !== 'customs') fail('map', 'must be customs');
  const coordinates = normalizeCoordinates(graph.coordinates);
  const sources = normalizeSources(graph.sources);
  const sourceIds = new Set(sources.map((source) => source.sourceId));
  const evidence = normalizeEvidence(graph.evidence, sourceIds);
  const evidenceIds = new Set(evidence.map((record) => record.evidenceId));
  const assets = normalizeAssets(graph.assets, sourceIds, evidenceIds);
  const assetIds = new Set(assets.map((asset) => asset.assetId));
  const sceneNodes = normalizeSceneNodes(graph.sceneNodes, assetIds, evidenceIds);
  const terrainTiles = normalizeTerrainTiles(graph.terrainTiles, sourceIds, evidenceIds);
  return {
    schemaVersion: CUSTOMS_TRUTH_GRAPH_SCHEMA_VERSION,
    graphId,
    map: 'customs',
    coordinates,
    sources,
    evidence,
    assets,
    sceneNodes,
    terrainTiles,
  };
}

export function canonicalCustomsTruthGraphJson(value) {
  return JSON.stringify(stableValue(normalizeCustomsTruthGraph(value)));
}
