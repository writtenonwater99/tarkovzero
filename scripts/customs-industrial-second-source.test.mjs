import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_MAX_PARENT_DEPTH,
  HANDOFF_CLAIM,
  RAIL_YARD_SCOPE,
  analyseColourDecidability,
  bodyTokenFromName,
  classifyBodyToken,
  createGameObjectScanner,
  crossCheckAgainstTracedProps,
  dedupePlacedRoots,
  evaluateHandoffClaim,
  groupByHierarchyParent,
  hasTechnicalSuffix,
  hierarchyRootOf,
  identityMatrix,
  isCandidateName,
  isWithinScopeRuntimeXY,
  isWithinScopeXZ,
  localMatrixFromTransform,
  matrixTranslation,
  multiply4x4,
  resolveWorkingFrame,
  resolveWorldTransform,
  scopeBounds,
  selectPlacedRoots,
  sourceToRuntime,
  stripInstanceSuffix,
  summarizeCounts,
} from './customs-industrial-second-source.mjs';

const EPSILON = 1e-9;

function closeTo(actual, expected, epsilon = EPSILON) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

function positionCloseTo(actual, expected, epsilon = 1e-9) {
  closeTo(actual.x, expected.x, epsilon);
  closeTo(actual.y, expected.y, epsilon);
  closeTo(actual.z, expected.z, epsilon);
}

function transform({ position = {}, rotation = {}, scale = {} } = {}) {
  return {
    localPosition: { x: 0, y: 0, z: 0, ...position },
    localRotation: { x: 0, y: 0, z: 0, w: 1, ...rotation },
    localScale: { x: 1, y: 1, z: 1, ...scale },
  };
}

/** Quaternion for a rotation of `degrees` about +Y, matching Unity's convention. */
function yawQuaternion(degrees) {
  const half = (degrees * Math.PI) / 360;
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
}

function makeLookup(nodes) {
  return (key) => nodes.get(key) ?? null;
}

function node(parentKey, options = {}) {
  return { parentKey, active: options.active ?? true, transform: transform(options) };
}

function scanAll(document, chunkSize) {
  const scanner = createGameObjectScanner();
  const items = [];
  for (let i = 0; i < document.length; i += chunkSize) {
    items.push(...scanner.push(document.slice(i, i + chunkSize)));
  }
  scanner.end();
  return items;
}

/* ------------------------------------------------------------------ *
 * Streaming scanner
 * ------------------------------------------------------------------ */

test('scanner extracts each element of the named top-level array', () => {
  const document = JSON.stringify({
    complete: true,
    counts: { gameObjects: 2 },
    gameObjects: [{ name: 'a', pathId: 1 }, { name: 'b', pathId: 2 }],
    trailing: 'x',
  });
  const items = scanAll(document, document.length);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((raw) => JSON.parse(raw).name), ['a', 'b']);
});

test('scanner is not fooled by a scalar key of the same name that precedes the array', () => {
  const document = JSON.stringify({
    counts: { gameObjects: 481126 },
    gameObjects: [{ name: 'only' }],
  });
  const items = scanAll(document, 7);
  assert.equal(items.length, 1);
  assert.equal(JSON.parse(items[0]).name, 'only');
});

test('scanner ignores an array of the same name nested below the tracked depth', () => {
  const document = JSON.stringify({ diagnostics: { gameObjects: [{ name: 'decoy' }] } });
  const scanner = createGameObjectScanner();
  assert.deepEqual(scanner.push(document), []);
  assert.throws(() => scanner.end(), (error) => error.code === 'ERR_SECOND_SOURCE_ARRAY_MISSING');
});

test('scanner survives braces, brackets and escaped quotes inside string values', () => {
  const nasty = 'a{b}[c] "quoted" \\ end';
  const document = JSON.stringify({ gameObjects: [{ hierarchyPath: nasty }, { hierarchyPath: ']' }] });
  const items = scanAll(document, 3);
  assert.equal(items.length, 2);
  assert.equal(JSON.parse(items[0]).hierarchyPath, nasty);
  assert.equal(JSON.parse(items[1]).hierarchyPath, ']');
});

test('scanner yields identical results at every chunk boundary', () => {
  const document = JSON.stringify({
    counts: { gameObjects: 3 },
    gameObjects: [
      { name: 'Vagon_tank', transform: { localPosition: { x: 1, y: 2, z: 3 } } },
      { name: 'container_6m (2)', nested: { deep: [1, 2, { z: ']' }] } },
      { name: 'tail' },
    ],
  });
  const reference = scanAll(document, document.length).map((raw) => JSON.parse(raw));
  for (let chunkSize = 1; chunkSize <= 17; chunkSize += 1) {
    const parsed = scanAll(document, chunkSize).map((raw) => JSON.parse(raw));
    assert.deepEqual(parsed, reference, `chunk size ${chunkSize} disagreed`);
  }
});

test('scanner reports a truncated array rather than emitting a partial element', () => {
  const document = '{"gameObjects": [{"name": "a"}, {"name": "b"';
  const scanner = createGameObjectScanner();
  const items = scanner.push(document);
  assert.equal(items.length, 1);
  assert.throws(() => scanner.end(), (error) => error.code === 'ERR_SECOND_SOURCE_TRUNCATED');
});

test('scanner marks itself finished at the closing bracket and stops emitting', () => {
  const document = '{"gameObjects": [{"name": "a"}], "after": [{"name": "b"}]}';
  const scanner = createGameObjectScanner();
  const items = scanner.push(document);
  assert.equal(items.length, 1);
  assert.equal(scanner.finished, true);
  assert.deepEqual(scanner.push('{"name": "c"}'), []);
  assert.equal(scanner.count, 1);
});

/* ------------------------------------------------------------------ *
 * Matrix algebra
 * ------------------------------------------------------------------ */

test('identity transform composes to the identity matrix', () => {
  assert.deepEqual(localMatrixFromTransform(transform()), identityMatrix());
});

test('a missing transform block falls back to identity rather than NaN', () => {
  assert.deepEqual(localMatrixFromTransform(undefined), identityMatrix());
  assert.deepEqual(localMatrixFromTransform({ localRotation: { w: 1 } }), identityMatrix());
});

test('translation lands in the last column', () => {
  const matrix = localMatrixFromTransform(transform({ position: { x: 4, y: -5, z: 6 } }));
  assert.deepEqual(matrixTranslation(matrix), { x: 4, y: -5, z: 6 });
});

test('a 90 degree yaw maps +x onto -z', () => {
  const matrix = localMatrixFromTransform(transform({ rotation: yawQuaternion(90) }));
  closeTo(matrix[0], 0);
  closeTo(matrix[2], 1);
  closeTo(matrix[8], -1);
  closeTo(matrix[10], 0);
});

test('scale multiplies the rotation columns, not the translation', () => {
  const matrix = localMatrixFromTransform(
    transform({ position: { x: 7, y: 0, z: 0 }, scale: { x: 2, y: 3, z: 4 } }),
  );
  closeTo(matrix[0], 2);
  closeTo(matrix[5], 3);
  closeTo(matrix[10], 4);
  closeTo(matrix[3], 7);
});

test('multiply4x4 is row-major and order sensitive', () => {
  const translate = localMatrixFromTransform(transform({ position: { x: 1, y: 0, z: 0 } }));
  const yaw = localMatrixFromTransform(transform({ rotation: yawQuaternion(90) }));
  positionCloseTo(matrixTranslation(multiply4x4(yaw, translate)), { x: 0, y: 0, z: -1 }, 1e-9);
  positionCloseTo(matrixTranslation(multiply4x4(translate, yaw)), { x: 1, y: 0, z: 0 }, 1e-9);
  assert.deepEqual(multiply4x4(identityMatrix(), translate), translate);
});

/* ------------------------------------------------------------------ *
 * Parent-chain composition
 * ------------------------------------------------------------------ */

test('a root object composes to its own local position', () => {
  const nodes = new Map([['s:1', node(null, { position: { x: 230, y: 2, z: -110 } })]]);
  const result = resolveWorldTransform(makeLookup(nodes), 's:1');
  assert.equal(result.status, 'ok');
  assert.equal(result.depth, 1);
  positionCloseTo(result.position, { x: 230, y: 2, z: -110 });
});

test('a parent rotation is applied to the child offset', () => {
  const nodes = new Map([
    ['s:1', node(null, { position: { x: 100, y: 0, z: 0 }, rotation: yawQuaternion(90) })],
    ['s:2', node('s:1', { position: { x: 10, y: 0, z: 0 } })],
  ]);
  const result = resolveWorldTransform(makeLookup(nodes), 's:2');
  assert.equal(result.status, 'ok');
  assert.equal(result.depth, 2);
  positionCloseTo(result.position, { x: 100, y: 0, z: -10 }, 1e-9);
});

test('parent scale multiplies the child offset through a three level chain', () => {
  const nodes = new Map([
    ['s:1', node(null, { position: { x: 200, y: 0, z: -100 }, scale: { x: 2, y: 1, z: 2 } })],
    ['s:2', node('s:1', { position: { x: 5, y: 0, z: 5 } })],
    ['s:3', node('s:2', { position: { x: 1, y: 3, z: 0 } })],
  ]);
  const result = resolveWorldTransform(makeLookup(nodes), 's:3');
  assert.equal(result.status, 'ok');
  assert.equal(result.depth, 3);
  positionCloseTo(result.position, { x: 200 + 12, y: 3, z: -100 + 10 }, 1e-9);
});

test('a cycle in the parent pointers is reported, never followed', () => {
  const nodes = new Map([
    ['s:1', node('s:2')],
    ['s:2', node('s:1')],
  ]);
  const result = resolveWorldTransform(makeLookup(nodes), 's:1');
  assert.equal(result.status, 'cycle');
  assert.equal(result.position, null);
});

test('a self-referencing parent pointer is reported as a cycle', () => {
  const nodes = new Map([['s:1', node('s:1')]]);
  assert.equal(resolveWorldTransform(makeLookup(nodes), 's:1').status, 'cycle');
});

test('an unknown key is missing, an unknown ancestor is a broken chain', () => {
  const nodes = new Map([['s:2', node('s:404')]]);
  assert.equal(resolveWorldTransform(makeLookup(nodes), 's:1').status, 'missing');
  const broken = resolveWorldTransform(makeLookup(nodes), 's:2');
  assert.equal(broken.status, 'broken-chain');
  assert.equal(broken.position, null);
});

test('a chain longer than maxDepth is reported rather than silently truncated', () => {
  const nodes = new Map();
  const length = 12;
  for (let i = 0; i < length; i += 1) {
    nodes.set(`s:${i}`, node(i === length - 1 ? null : `s:${i + 1}`, { position: { x: 1 } }));
  }
  const lookup = makeLookup(nodes);
  assert.equal(resolveWorldTransform(lookup, 's:0', { maxDepth: 5 }).status, 'depth-exceeded');
  const ok = resolveWorldTransform(lookup, 's:0', { maxDepth: length });
  assert.equal(ok.status, 'ok');
  closeTo(ok.position.x, length);
});

test('the default depth limit is generous enough for a real hierarchy', () => {
  assert.ok(DEFAULT_MAX_PARENT_DEPTH >= 64);
});

test('an inactive ancestor makes the whole subtree inactive in hierarchy', () => {
  const nodes = new Map([
    ['s:1', node(null, { active: false })],
    ['s:2', node('s:1')],
  ]);
  const result = resolveWorldTransform(makeLookup(nodes), 's:2');
  assert.equal(result.status, 'ok');
  assert.equal(result.activeInHierarchy, false);
  assert.equal(resolveWorldTransform(makeLookup(new Map([['s:9', node(null)]])), 's:9').activeInHierarchy, true);
});

/* ------------------------------------------------------------------ *
 * Frame and scope
 * ------------------------------------------------------------------ */

test('sourceToRuntime applies runtimeFromSource [-x, -z, y]', () => {
  assert.deepEqual(sourceToRuntime({ x: 230, y: 3, z: -110 }), { x: -230, y: 110, z: 3 });
});

test('scope bounds are the box centre plus or minus half the extents', () => {
  assert.deepEqual(scopeBounds(RAIL_YARD_SCOPE), { minX: 50, maxX: 410, minZ: -260, maxZ: 40 });
});

test('scope containment uses the y-up ground plane and includes the edges', () => {
  assert.equal(isWithinScopeXZ({ x: 230, y: 999, z: -110 }, RAIL_YARD_SCOPE), true);
  assert.equal(isWithinScopeXZ({ x: 50, y: 0, z: -260 }, RAIL_YARD_SCOPE), true);
  assert.equal(isWithinScopeXZ({ x: 410, y: 0, z: 40 }, RAIL_YARD_SCOPE), true);
  assert.equal(isWithinScopeXZ({ x: 49.9, y: 0, z: -110 }, RAIL_YARD_SCOPE), false);
  assert.equal(isWithinScopeXZ({ x: 230, y: 0, z: 40.1 }, RAIL_YARD_SCOPE), false);
  assert.equal(isWithinScopeXZ({ x: -346, y: 5, z: -325 }, RAIL_YARD_SCOPE), false);
});

test('the runtime reading of the same box selects a disjoint region', () => {
  const inside = { x: 230, y: 1, z: -110 };
  assert.equal(isWithinScopeXZ(inside, RAIL_YARD_SCOPE), true);
  assert.equal(isWithinScopeRuntimeXY(sourceToRuntime(inside), RAIL_YARD_SCOPE), false);
});

test('resolveWorkingFrame picks the reading that actually contains the bodies', () => {
  const rows = [
    { world: { x: 230, y: 1, z: -110 }, runtime: sourceToRuntime({ x: 230, y: 1, z: -110 }) },
    { world: { x: 240, y: 1, z: -120 }, runtime: sourceToRuntime({ x: 240, y: 1, z: -120 }) },
  ];
  const frame = resolveWorkingFrame(rows, RAIL_YARD_SCOPE);
  assert.equal(frame.sourceHits, 2);
  assert.equal(frame.runtimeHits, 0);
  assert.equal(frame.chosen, 'source');
  assert.equal(frame.runtimeFromSource, '[-x, -z, y]');
});

/* ------------------------------------------------------------------ *
 * Name tokens
 * ------------------------------------------------------------------ */

test('the Unity duplicate marker is stripped', () => {
  assert.equal(stripInstanceSuffix('Vagon_hopper (2)'), 'Vagon_hopper');
  assert.equal(stripInstanceSuffix('container_6m (74)'), 'container_6m');
  assert.equal(stripInstanceSuffix('Vagon_tank'), 'Vagon_tank');
});

test('stacked renderer decorations are stripped down to the body token', () => {
  assert.equal(bodyTokenFromName('Vagon_tank_SHADOW_LOD1'), 'vagon_tank');
  assert.equal(bodyTokenFromName('Vagon_tank_BALLISTIC_metalthick'), 'vagon_tank');
  assert.equal(bodyTokenFromName('container_6m_close_COLLIDER'), 'container_6m_close');
  assert.equal(bodyTokenFromName('container_6m_Red_close'), 'container_6m_red_close');
  assert.equal(bodyTokenFromName('Vagon_hopper (7)'), 'vagon_hopper');
  assert.equal(hasTechnicalSuffix('Vagon_tank_LOD0'), true);
  assert.equal(hasTechnicalSuffix('Vagon_tank'), false);
});

test('the candidate pre-filter admits rolling stock and shipping containers only', () => {
  assert.equal(isCandidateName('Vagon_gondola_small_green'), true);
  assert.equal(isCandidateName('container_12m_Blue_close'), true);
  assert.equal(isCandidateName('container_6m (12)'), true);
  assert.equal(isCandidateName('scontainer_bag_sport'), false);
  assert.equal(isCandidateName('Container_garbage_01'), false);
  assert.equal(isCandidateName('Train_wheels'), false);
});

test('body tokens classify into explicit families', () => {
  const family = (name) => classifyBodyToken(bodyTokenFromName(name));
  assert.equal(family('Vagon_tank').family, 'tank-wagon');
  assert.equal(family('Vagon_tank_red').colour, 'red');
  assert.equal(family('Vagon_hopper (3)').family, 'hopper-wagon');
  assert.equal(family('Vagon_hopper_black').colour, 'black');
  assert.equal(family('Vagon_shutted_closed').family, 'closed-freight-wagon');
  assert.equal(family('Vagon_shutted_closed').closed, true);
  assert.equal(family('Vagon_gondola_large_black_02').family, 'gondola-wagon');
  assert.equal(family('Vagon_gondola_small_green').colour, 'green');
  assert.equal(family('container_6m_Red_close').family, 'container-6m');
  assert.equal(family('container_6m_Red_close').colour, 'red');
  assert.equal(family('container_6m_damage_DarkBlue_close').colour, 'darkblue');
  assert.equal(family('container_12m_Green_close').family, 'container-12m');
  assert.equal(family('scontainer_bag_sport'), null);
});

test('a colourless container name yields a null colour rather than a guess', () => {
  const parsed = classifyBodyToken(bodyTokenFromName('container_6m (12)'));
  assert.equal(parsed.family, 'container-6m');
  assert.equal(parsed.role, 'body');
  assert.equal(parsed.colour, null);
});

test('doors and sliding leaves are parts, never placed bodies', () => {
  assert.equal(classifyBodyToken(bodyTokenFromName('container_6m_door_01_L_LOD0')).role, 'part');
  assert.equal(classifyBodyToken(bodyTokenFromName('Vagon_movable_door_slide_02')).role, 'part');
  assert.equal(classifyBodyToken(bodyTokenFromName('Vagon_movable_doors_grey')).role, 'part');
});

/* ------------------------------------------------------------------ *
 * Root reduction and dedupe
 * ------------------------------------------------------------------ */

test('a match nested under another match is not a placed root', () => {
  const nodes = new Map([
    ['s:1', node(null)],
    ['s:2', node('s:1')],
    ['s:3', node('s:2')],
    ['s:9', node(null)],
  ]);
  const matches = [
    { key: 's:1', name: 'Vagon_tank' },
    { key: 's:3', name: 'Vagon_tank_LOD0' },
    { key: 's:9', name: 'container_6m' },
  ];
  const { roots, nested } = selectPlacedRoots(matches, makeLookup(nodes));
  assert.deepEqual(roots.map((row) => row.key).sort(), ['s:1', 's:9']);
  assert.equal(nested.length, 1);
  assert.equal(nested[0].ownerKey, 's:1');
});

test('root selection terminates on a cycle instead of hanging', () => {
  const nodes = new Map([
    ['s:1', node('s:2')],
    ['s:2', node('s:1')],
  ]);
  const { roots } = selectPlacedRoots([{ key: 's:1', name: 'Vagon_tank' }], makeLookup(nodes));
  assert.equal(roots.length, 1);
});

test('root selection treats an unknown ancestor as the end of the chain', () => {
  const nodes = new Map([['s:1', node('s:404')]]);
  const { roots, nested } = selectPlacedRoots([{ key: 's:1', name: 'Vagon_tank' }], makeLookup(nodes));
  assert.equal(roots.length, 1);
  assert.equal(nested.length, 0);
});

function row(token, x, z, options = {}) {
  return {
    token,
    family: options.family ?? 'tank-wagon',
    role: options.role ?? 'body',
    colour: options.colour ?? null,
    name: options.name ?? token,
    sceneIndex: options.sceneIndex ?? 5,
    hierarchyPath: options.hierarchyPath ?? `Scene/PROPS/${options.name ?? token}`,
    world: { x, y: options.y ?? 0, z },
  };
}

/* ------------------------------------------------------------------ *
 * Consist grouping and colour decidability
 * ------------------------------------------------------------------ */

test('hierarchyRootOf returns the scene root segment', () => {
  assert.equal(hierarchyRootOf('SBG_Custom_Expansion/OO/PROPS/Vagon_tank'), 'SBG_Custom_Expansion');
  assert.equal(hierarchyRootOf('NewYear_Event'), 'NewYear_Event');
  assert.equal(hierarchyRootOf(undefined), '');
});

test('rail bodies bucket by the authored group that owns them', () => {
  const groups = groupByHierarchyParent([
    row('vagon_tank', 1, 1, { family: 'tank-wagon', hierarchyPath: 'S/OO/PROPS/Big_group2/Vagon_tank' }),
    row('vagon_tank', 2, 2, { family: 'tank-wagon', hierarchyPath: 'S/OO/PROPS/Big_group2/Vagon_tank' }),
    row('vagon_shutted_closed', 3, 3, {
      family: 'closed-freight-wagon',
      hierarchyPath: 'S/OO/PROPS/Big_group2/Vagon_shutted_closed',
    }),
    row('vagon_gondola_small', 4, 4, {
      family: 'gondola-wagon',
      hierarchyPath: 'S/OO/PROPS/PART-1_Platform/Vagon_gondola_small',
    }),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].group, 'S/OO/PROPS/Big_group2');
  assert.equal(groups[0].count, 3);
  assert.deepEqual(groups[0].families, [['tank-wagon', 2], ['closed-freight-wagon', 1]]);
  assert.equal(groups[1].group, 'S/OO/PROPS/PART-1_Platform');
});

test('colour decidability attributes every colourless container to its group', () => {
  const analysis = analyseColourDecidability([
    row('container_6m_red_close', 1, 1, { family: 'container-6m', colour: 'red' }),
    row('container_6m', 2, 2, {
      family: 'container-6m',
      colour: null,
      sceneIndex: 8,
      hierarchyPath: 'NewYear_Event/GARLANDS/XMAS_WIRE_big/+container_6m+/container_6m (3)',
    }),
    row('container_6m', 3, 3, {
      family: 'container-6m',
      colour: null,
      sceneIndex: 8,
      hierarchyPath: 'NewYear_Event/GARLANDS/XMAS_WIRE_big/+container_6m+/container_6m (4)',
    }),
    row('vagon_tank', 4, 4, { family: 'tank-wagon' }),
  ]);
  assert.equal(analysis.containerRoots, 3);
  assert.equal(analysis.withColourToken, 1);
  assert.equal(analysis.withoutColourToken, 2);
  assert.deepEqual(analysis.colourlessByHierarchyRoot, [['NewYear_Event', 2]]);
  assert.deepEqual(analysis.colourlessByGroup, [['NewYear_Event/GARLANDS/XMAS_WIRE_big/+container_6m+', 2]]);
  assert.deepEqual(analysis.colourlessScenes, [8]);
});

/* ------------------------------------------------------------------ *
 * Frame cross-check
 * ------------------------------------------------------------------ */

test('cross-check matches composed positions to traced props with no transform', () => {
  const rows = [row('vagon_tank', 135.1, -11.1), row('vagon_tank', 136.0, -1.3)];
  const traced = [
    { name: 'Tank square tanker', x: 135.2, z: -11.1 },
    { name: 'Tank square tanker', x: 136.2, z: -1.3 },
  ];
  const check = crossCheckAgainstTracedProps(rows, traced, { toleranceM: 3 });
  assert.equal(check.matched, 2);
  assert.ok(check.maxResidualM < 0.5);
  assert.ok(check.pairs.every((pair) => pair.matched));
});

test('cross-check reports a miss rather than snapping to a far neighbour', () => {
  const rows = [row('vagon_tank', 0, 0)];
  const check = crossCheckAgainstTracedProps(rows, [{ name: 'Trailer', x: 200, z: 200 }], { toleranceM: 3 });
  assert.equal(check.matched, 0);
  assert.equal(check.medianResidualM, null);
  assert.equal(check.pairs[0].matched, false);
  assert.ok(check.pairs[0].distanceM > 100);
});

test('cross-check under the runtime reading of the same points fails, proving the frame', () => {
  const composed = [row('vagon_tank', 135.1, -11.1)];
  const traced = [{ name: 'Tank square tanker', x: 135.2, z: -11.1 }];
  const flipped = [{ ...composed[0], world: { x: -135.1, y: 0, z: -11.1 } }];
  assert.equal(crossCheckAgainstTracedProps(composed, traced, { toleranceM: 3 }).matched, 1);
  assert.equal(crossCheckAgainstTracedProps(flipped, traced, { toleranceM: 3 }).matched, 0);
});

test('co-located copies of the same body in different scenes collapse to one', () => {
  const merged = dedupePlacedRoots(
    [row('vagon_tank', 230, -110, { sceneIndex: 5 }), row('vagon_tank', 230.2, -110.1, { sceneIndex: 19 })],
    { toleranceM: 0.5 },
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].duplicateCount, 1);
  assert.deepEqual(merged[0].scenes, [5, 19]);
});

test('bodies further apart than the tolerance stay separate', () => {
  const merged = dedupePlacedRoots([row('vagon_tank', 230, -110), row('vagon_tank', 244, -110)], {
    toleranceM: 0.5,
  });
  assert.equal(merged.length, 2);
});

test('different body tokens at the same position are never merged', () => {
  const merged = dedupePlacedRoots([row('vagon_tank', 230, -110), row('vagon_hopper', 230, -110)], {
    toleranceM: 0.5,
  });
  assert.equal(merged.length, 2);
});

test('summarizeCounts reports both the token census and the family census', () => {
  const summary = summarizeCounts([
    row('vagon_tank', 1, 1),
    row('vagon_tank', 2, 2),
    row('vagon_hopper', 3, 3, { family: 'hopper-wagon' }),
  ]);
  assert.equal(summary.total, 3);
  assert.deepEqual(summary.byToken, [['vagon_tank', 2], ['vagon_hopper', 1]]);
  assert.deepEqual(summary.byFamily, [['tank-wagon', 2], ['hopper-wagon', 1]]);
});

/* ------------------------------------------------------------------ *
 * Verdict
 * ------------------------------------------------------------------ */

test('an exact match on every claimed count reads as supports', () => {
  const rows = [
    row('vagon_shutted_closed', 1, 1, { family: 'closed-freight-wagon' }),
    row('vagon_shutted_closed', 2, 2, { family: 'closed-freight-wagon' }),
    row('vagon_shutted_closed', 3, 3, { family: 'closed-freight-wagon' }),
    row('vagon_tank', 4, 4, { family: 'tank-wagon' }),
    row('vagon_tank', 5, 5, { family: 'tank-wagon' }),
    row('vagon_hopper', 6, 6, { family: 'hopper-wagon' }),
    row('container_6m_red_close', 7, 7, { family: 'container-6m', colour: 'red' }),
    row('container_6m_red_close', 8, 8, { family: 'container-6m', colour: 'red' }),
  ];
  const verdict = evaluateHandoffClaim(rows, HANDOFF_CLAIM);
  assert.equal(verdict.overall, 'supports');
  assert.ok(verdict.items.every((item) => item.status === 'supports'));
});

test('a differing count reads as contradicts and reports the observed number', () => {
  const rows = [
    row('vagon_tank', 4, 4, { family: 'tank-wagon' }),
    row('container_6m_red_close', 7, 7, { family: 'container-6m', colour: 'red' }),
    row('container_6m_red_close', 8, 8, { family: 'container-6m', colour: 'red' }),
  ];
  const verdict = evaluateHandoffClaim(rows, HANDOFF_CLAIM);
  assert.equal(verdict.overall, 'contradicts');
  const tank = verdict.items.find((item) => item.item === 'tank-wagon');
  assert.equal(tank.observed, 1);
  assert.equal(tank.status, 'contradicts');
});

test('a colourless container in scope makes the colour claim undecidable, not false', () => {
  const rows = [
    row('vagon_shutted_closed', 1, 1, { family: 'closed-freight-wagon' }),
    row('vagon_shutted_closed', 2, 2, { family: 'closed-freight-wagon' }),
    row('vagon_shutted_closed', 3, 3, { family: 'closed-freight-wagon' }),
    row('vagon_tank', 4, 4, { family: 'tank-wagon' }),
    row('vagon_tank', 5, 5, { family: 'tank-wagon' }),
    row('vagon_hopper', 6, 6, { family: 'hopper-wagon' }),
    row('container_6m_red_close', 7, 7, { family: 'container-6m', colour: 'red' }),
    row('container_6m_red_close', 8, 8, { family: 'container-6m', colour: 'red' }),
    row('container_6m', 9, 9, { family: 'container-6m', colour: null }),
  ];
  const verdict = evaluateHandoffClaim(rows, HANDOFF_CLAIM);
  const containers = verdict.items.find((item) => item.item === 'container-6m-red');
  assert.equal(containers.status, 'cannot-address');
  assert.equal(containers.decidable, false);
  assert.equal(containers.colourlessInScope, 1);
  assert.equal(verdict.overall, 'partly-supports-partly-undecidable');
});

test('parts are excluded from the body counts the verdict is built on', () => {
  const rows = [
    row('vagon_tank', 4, 4, { family: 'tank-wagon' }),
    row('vagon_tank', 5, 5, { family: 'tank-wagon' }),
    row('vagon_movable_doors_grey', 6, 6, { family: 'wagon-movable-door-assembly', role: 'part' }),
  ];
  const tank = evaluateHandoffClaim(rows, HANDOFF_CLAIM).items.find((i) => i.item === 'tank-wagon');
  assert.equal(tank.observed, 2);
  assert.equal(tank.status, 'supports');
});
