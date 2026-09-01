import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAPABILITY_STATEMENT,
  DEFAULT_EXCLUSIONS,
  DEFAULT_MAX_PARENT_DEPTH,
  FactsStore,
  HANDOFF_CLAIM,
  PROVENANCE_STATEMENT,
  RAIL_BODY_FAMILIES,
  RAIL_YARD_SCOPE,
  SCENE_MANIFEST_PATH,
  analyseColourDecidability,
  assertManifestAgreement,
  bodyTokenFromName,
  classifyBodyToken,
  contractFromManifest,
  createGameObjectScanner,
  crossCheckAgainstTracedProps,
  declaredContract,
  dedupePlacedRoots,
  detectPositionDuplicates,
  evaluateHandoffClaim,
  formatReport,
  groupByHierarchyParent,
  hasTechnicalSuffix,
  hierarchyRootOf,
  identityMatrix,
  isCandidateName,
  isRailBodyFamily,
  isWithinScopeRuntimeXY,
  isWithinScopeXZ,
  loadSceneManifestContract,
  localMatrixFromTransform,
  matrixTranslation,
  multiply4x4,
  resolveWorkingFrame,
  resolveWorldTransform,
  runSecondSource,
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

test('the candidate pre-filter admits rolling stock, locomotives, bogies and shipping containers', () => {
  assert.equal(isCandidateName('Vagon_gondola_small_green'), true);
  assert.equal(isCandidateName('container_12m_Blue_close'), true);
  assert.equal(isCandidateName('container_6m (12)'), true);
  assert.equal(isCandidateName('scontainer_bag_sport'), false);
  assert.equal(isCandidateName('Container_garbage_01'), false);
});

/** S2: the pre-repair filter was /^(?:vagon_|container_(?:6m|12m))/i and could not see a locomotive. */
test('the pre-filter admits locomotives and their decorations', () => {
  assert.equal(isCandidateName('Locomotive'), true);
  assert.equal(isCandidateName('Locomotive (1)'), true);
  assert.equal(isCandidateName('Locomotive_LOD0'), true);
  assert.equal(isCandidateName('Locomotive_BALLISTIC_glass'), true);
  assert.equal(classifyBodyToken(bodyTokenFromName('Locomotive_LOD1')).family, 'locomotive');
  assert.equal(classifyBodyToken(bodyTokenFromName('Locomotive (1)')).role, 'body');
  assert.equal(isRailBodyFamily('locomotive'), true);
  assert.ok(RAIL_BODY_FAMILIES.has('locomotive'));
});

/** S2: bogies are admitted as PARTS so an orphan bogie becomes a visible lexicon gap. */
test('Train_wheels is admitted as a bogie part, never as a body', () => {
  assert.equal(isCandidateName('Train_wheels'), true);
  assert.equal(isCandidateName('Train_wheels_BALLISTIC_Metalthick'), true);
  const bogie = classifyBodyToken(bodyTokenFromName('Train_wheels_LOD0'));
  assert.equal(bogie.family, 'bogie');
  assert.equal(bogie.role, 'part');
  assert.equal(isRailBodyFamily('bogie'), false);
  // 'training_bench_set_4' must not be swept in by the train_wheels token.
  assert.equal(isCandidateName('training_bench_set_4'), false);
});

/**
 * Unity's authoring convention gives an organisational empty a trailing ' Group'.
 * The pre-repair filter admitted 'vagon_01_indoor Group' and classified each of
 * the three in the dump as a wagon body.
 */
test('authored group nodes are rejected, not classified as wagons', () => {
  assert.equal(isCandidateName('vagon_01_indoor Group'), false);
  assert.equal(isCandidateName('vagon_02_indoor Group'), false);
  assert.equal(isCandidateName('platforma_stuff Group'), false);
  assert.equal(classifyBodyToken('vagon_01_indoor group'), null);
});

/**
 * S3: TECHNICAL_SUFFIX was anchored on _COLLIDER only, so this dump's OTHER
 * collider convention (_col — railway_rail_final_col, garage_01_col, …) was
 * invisible and a stacked '…_LOD0_col' reduced to a body token.
 */
test('the _col collider convention is stripped, including when stacked after an LOD', () => {
  assert.equal(bodyTokenFromName('Vagon_tank_01_col'), 'vagon_tank_01');
  assert.equal(bodyTokenFromName('Vagon_tank_01_LOD0_col'), 'vagon_tank_01');
  assert.equal(bodyTokenFromName('Vagon_tank_COL'), 'vagon_tank');
  assert.equal(hasTechnicalSuffix('Vagon_tank_01_col'), true);
  // The stacked-suffix loop must still reduce the shapes the dump really has.
  assert.equal(bodyTokenFromName('reciever_1_LOD0_SHADOW_LOD0'), 'reciever_1');
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
  assert.equal(classifyBodyToken(bodyTokenFromName('Vagon_movable_door_slide_02')).part, 'door-leaf');
  // Singular 'Vagon_movable_door…' is the boxcar's own mesh/collider naming.
  assert.equal(classifyBodyToken(bodyTokenFromName('Vagon_movable_door_LOD0')).role, 'part');
  assert.equal(classifyBodyToken(bodyTokenFromName('Vagon_movable_door_COLLIDER')).role, 'part');
});

/**
 * S4: the previous classifier hard-coded every vagon_movable_* token as a
 * non-body 'part' and a test locked the mistake in. In the real dump
 * Vagon_movable_doors_grey owns TWO Train_wheels bogie sets (each with its own
 * LOD / SHADOW / COLLIDER / BALLISTIC children) plus a body mesh
 * (Vagon_movable_door_LOD0). It is a placed wagon.
 */
test('Vagon_movable_doors_<colour> is a placed sliding-door boxcar, not a door part', () => {
  const boxcar = classifyBodyToken(bodyTokenFromName('Vagon_movable_doors_grey'));
  assert.equal(boxcar.role, 'body');
  assert.equal(boxcar.family, 'sliding-door-boxcar');
  assert.equal(boxcar.colour, 'grey');
  assert.equal(isRailBodyFamily('sliding-door-boxcar'), true);
  // It is NOT folded into the handoff claim's 'closed freight wagon' family:
  // Vagon_shutted_closed is a different authored asset and must stay separate.
  assert.notEqual(boxcar.family, 'closed-freight-wagon');
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
    row('vagon_movable_door_slide_02', 6, 6, { family: 'wagon-movable-door-assembly', role: 'part' }),
    row('train_wheels', 6.5, 6.5, { family: 'bogie', role: 'part' }),
  ];
  const tank = evaluateHandoffClaim(rows, HANDOFF_CLAIM).items.find((i) => i.item === 'tank-wagon');
  assert.equal(tank.observed, 2);
  assert.equal(tank.status, 'supports');
});

test('the verdict names the body families the handoff claim never listed', () => {
  const rows = [
    row('vagon_tank', 4, 4, { family: 'tank-wagon' }),
    row('vagon_gondola_small', 5, 5, { family: 'gondola-wagon' }),
    row('vagon_gondola_large', 6, 6, { family: 'gondola-wagon' }),
    row('locomotive', 7, 7, { family: 'locomotive' }),
    row('vagon_movable_doors_grey', 8, 8, { family: 'sliding-door-boxcar' }),
    row('train_wheels', 9, 9, { family: 'bogie', role: 'part' }),
  ];
  const unlisted = evaluateHandoffClaim(rows, HANDOFF_CLAIM).familiesTheClaimNeverListed;
  assert.deepEqual(unlisted, [
    { family: 'gondola-wagon', observed: 2 },
    { family: 'locomotive', observed: 1 },
    { family: 'sliding-door-boxcar', observed: 1 },
  ]);
});

/* ------------------------------------------------------------------ *
 * S1 — position duplicates and named exclusions
 * ------------------------------------------------------------------ */

test('co-located roots with DIFFERENT names are reported as a position duplicate', () => {
  const clusters = detectPositionDuplicates([
    row('container_6m_red_close', 230, -110, {
      family: 'container-6m', colour: 'red', name: 'container_6m_Red_close',
      hierarchyPath: 'SBG_Custom_Expansion/OO/PROPS/container_6m_Red_close',
    }),
    row('container_6m', 230, -110, {
      family: 'container-6m', colour: null, name: 'container_6m (42)',
      hierarchyPath: 'NewYear_Event/GARLANDS/XMAS_WIRE_big/+container_6m+/container_6m (42)',
    }),
    row('vagon_tank', 300, -50, { family: 'tank-wagon' }),
  ], { toleranceM: 0.5 });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].count, 2);
  assert.equal(clusters[0].spreadM, 0);
  assert.deepEqual(clusters[0].hierarchyRoots, ['NewYear_Event', 'SBG_Custom_Expansion']);
});

test('a position-duplicate cluster respects the tolerance and reports its spread', () => {
  const near = detectPositionDuplicates(
    [row('a', 0, 0), row('b', 0.3, 0)],
    { toleranceM: 0.5 },
  );
  assert.equal(near.length, 1);
  closeTo(near[0].spreadM, 0.3, 1e-9);
  assert.equal(detectPositionDuplicates([row('a', 0, 0), row('b', 0.7, 0)], { toleranceM: 0.5 }).length, 0);
});

test('a lone root is never reported as a duplicate', () => {
  assert.deepEqual(detectPositionDuplicates([row('vagon_tank', 1, 1)], { toleranceM: 0.5 }), []);
});

test('the dedupe groups by true distance, not by quantization bins', () => {
  // 0.24 m apart but straddling the 0.5 m bin edge at 0.25: a quantizing dedupe
  // puts these in different bins and reports two objects where there is one.
  const merged = dedupePlacedRoots(
    [row('vagon_tank', 0.24, 0, { sceneIndex: 5 }), row('vagon_tank', 0.26, 0, { sceneIndex: 19 })],
    { toleranceM: 0.5 },
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].duplicateCount, 1);
});

test('dedupe is order independent', () => {
  const a = row('vagon_tank', 230, -110, { sceneIndex: 5 });
  const b = row('vagon_tank', 230.2, -110.1, { sceneIndex: 19 });
  const forward = dedupePlacedRoots([a, b], { toleranceM: 0.5 });
  const backward = dedupePlacedRoots([b, a], { toleranceM: 0.5 });
  assert.deepEqual(forward.map((r) => r.scenes), backward.map((r) => r.scenes));
  assert.deepEqual(forward.map((r) => r.world), backward.map((r) => r.world));
});

test('the default exclusion set names NewYear_Event, its reason and its falsifier', () => {
  assert.equal(DEFAULT_EXCLUSIONS.length, 1);
  const [rule] = DEFAULT_EXCLUSIONS;
  assert.equal(rule.hierarchyRoot, 'NewYear_Event');
  assert.ok(rule.reason.length > 40, 'an exclusion must carry a stated reason');
  assert.ok(rule.falsifier.length > 40, 'an exclusion must carry a falsifier');
});

/* ------------------------------------------------------------------ *
 * S5 — the scene manifest is READ, and drift is a stop
 * ------------------------------------------------------------------ */

const MANIFEST_FIXTURE = Object.freeze({
  frames: {
    source: 'eft-unity-world-metres-y-up',
    runtime: 'three-z-up-metres',
    runtimeFromSource: '[-x, -z, y]',
  },
  scope: {
    id: 'customs-industrial-rail-yard',
    center: { x: 230, z: -110 },
    widthM: 360,
    depthM: 300,
  },
});

test('contractFromManifest lifts only the frame and scope contract', () => {
  const contract = contractFromManifest({ ...MANIFEST_FIXTURE, budgets: { totalBytes: 1 } });
  assert.deepEqual(contract, declaredContract());
});

test('a manifest missing frames or scope is a shape error, never a default', () => {
  assert.throws(() => contractFromManifest(null), (e) => e.code === 'ERR_SECOND_SOURCE_MANIFEST_SHAPE');
  assert.throws(() => contractFromManifest({ scope: MANIFEST_FIXTURE.scope }), (e) => e.code === 'ERR_SECOND_SOURCE_MANIFEST_SHAPE');
  assert.throws(() => contractFromManifest({ frames: MANIFEST_FIXTURE.frames }), (e) => e.code === 'ERR_SECOND_SOURCE_MANIFEST_SHAPE');
  assert.throws(
    () => contractFromManifest({ frames: MANIFEST_FIXTURE.frames, scope: { id: 'x' } }),
    (e) => e.code === 'ERR_SECOND_SOURCE_MANIFEST_SHAPE',
  );
});

test('agreement is asserted field by field and every drift is listed', () => {
  assert.equal(assertManifestAgreement(contractFromManifest(MANIFEST_FIXTURE)).agrees, true);
  const drifted = {
    frames: { ...MANIFEST_FIXTURE.frames, runtimeFromSource: '[x, z, y]' },
    scope: { ...MANIFEST_FIXTURE.scope, widthM: 400, center: { x: 231, z: -110 } },
  };
  assert.throws(
    () => assertManifestAgreement(contractFromManifest(drifted)),
    (error) => {
      assert.equal(error.code, 'ERR_SECOND_SOURCE_MANIFEST_DRIFT');
      assert.match(error.message, /frames\.runtimeFromSource/);
      assert.match(error.message, /scope\.center\.x/);
      assert.match(error.message, /scope\.widthM/);
      return true;
    },
  );
});

test('an unreadable manifest path is a hard failure, not a fallback to the literals', async () => {
  await assert.rejects(
    () => loadSceneManifestContract('/nonexistent/scene-manifest.json'),
    (e) => e.code === 'ERR_SECOND_SOURCE_MANIFEST_UNREADABLE',
  );
});

/** The guard that matters: the SHIPPED manifest, not a fixture. */
test('the repository scene manifest agrees with this script frame and scope literals', async () => {
  const contract = await loadSceneManifestContract(SCENE_MANIFEST_PATH);
  assert.deepEqual(contract, declaredContract());
  assert.equal(assertManifestAgreement(contract).checked, 8);
});

/* ------------------------------------------------------------------ *
 * FactsStore — the parent-pointer store, including its growth path
 * ------------------------------------------------------------------ */

function record(asset, pathId, parent, name, position, options = {}) {
  return {
    asset,
    pathId,
    parentGameObjectPathId: parent,
    name,
    active: options.active ?? true,
    hierarchyPath: options.hierarchyPath ?? name,
    sceneIndex: options.sceneIndex ?? 5,
    scenePath: options.scenePath ?? `scenes/${asset}.unity`,
    transform: transform({ position, rotation: options.rotation, scale: options.scale }),
  };
}

test('FactsStore round-trips a record through lookup', () => {
  const store = new FactsStore();
  store.add(record('level10', 7, 3, 'Vagon_tank', { x: 1, y: 2, z: 3 }));
  const node = store.lookup('level10:7');
  assert.equal(node.parentKey, 'level10:3');
  assert.equal(node.active, true);
  assert.deepEqual(node.transform.localPosition, { x: 1, y: 2, z: 3 });
  assert.deepEqual(node.transform.localRotation, { x: 0, y: 0, z: 0, w: 1 });
  assert.deepEqual(node.transform.localScale, { x: 1, y: 1, z: 1 });
});

test('FactsStore treats a zero or missing parent pointer as no parent', () => {
  const store = new FactsStore();
  store.add(record('level10', 1, 0, 'root', { x: 0, y: 0, z: 0 }));
  store.add({ asset: 'level10', pathId: 2, name: 'orphan', transform: undefined });
  assert.equal(store.lookup('level10:1').parentKey, null);
  assert.equal(store.lookup('level10:2').parentKey, null);
  assert.deepEqual(store.lookup('level10:2').transform.localScale, { x: 1, y: 1, z: 1 });
});

test('FactsStore keeps every record correct across its growth boundary', () => {
  const store = new FactsStore();
  const total = 5000; // > the 1024 initial capacity, so #grow runs several times
  for (let i = 1; i <= total; i += 1) {
    store.add(record('level10', i, i === 1 ? 0 : i - 1, `n${i}`, { x: i, y: 0, z: -i }));
  }
  assert.equal(store.size, total);
  for (const probe of [1, 1023, 1024, 1025, 2048, 4096, total]) {
    const node = store.lookup(`level10:${probe}`);
    assert.deepEqual(node.transform.localPosition, { x: probe, y: 0, z: -probe }, `record ${probe} moved`);
    assert.equal(node.parentKey, probe === 1 ? null : `level10:${probe - 1}`);
  }
});

test('FactsStore keys are scoped per asset, so two scenes may reuse a pathId', () => {
  const store = new FactsStore();
  store.add(record('level10', 5, 0, 'a', { x: 1, y: 0, z: 0 }));
  store.add(record('level174', 5, 0, 'b', { x: 2, y: 0, z: 0 }));
  assert.equal(store.lookup('level10:5').transform.localPosition.x, 1);
  assert.equal(store.lookup('level174:5').transform.localPosition.x, 2);
  assert.equal(store.lookup('level999:5'), null);
  assert.equal(store.lookup('nocolon'), null);
});

test('FactsStore records the declared active flag', () => {
  const store = new FactsStore();
  store.add(record('level10', 1, 0, 'on', { x: 0, y: 0, z: 0 }));
  store.add(record('level10', 2, 0, 'off', { x: 0, y: 0, z: 0 }, { active: false }));
  assert.equal(store.lookup('level10:1').active, true);
  assert.equal(store.lookup('level10:2').active, false);
});

/* ------------------------------------------------------------------ *
 * S7 — the assembled pipeline, on synthetic fixtures only
 * ------------------------------------------------------------------ */

/** Builds a dump document in the shape the real one has, then streams it in chunks. */
function factsDocument(records, { chunkSize = 64 } = {}) {
  const text = JSON.stringify({
    complete: true,
    counts: { gameObjects: records.length },
    gameObjects: records,
    diagnostics: { fileLoadFailures: [] },
  });
  return function createFactsStream() {
    return (async function* stream() {
      for (let i = 0; i < text.length; i += chunkSize) yield text.slice(i, i + chunkSize);
    }());
  };
}

/**
 * One synthetic rail yard, hand-built so every expected number is derivable by
 * reading this function. Nothing here comes from the game or from the dump.
 *
 * In scope (box is x [50,410], z [-260,40]):
 *   1 Vagon_tank            (with LOD + COLLIDER children)
 *   1 Locomotive            (with LOD children)          <- invisible before S2
 *   1 Vagon_movable_doors_grey (2 bogies + body mesh)    <- a 'part' before S4
 *   1 container_6m_Red_close
 *   1 NewYear_Event garland container_6m ON the red one  <- counted before S1
 *   1 inactive container_6m_Blue_close
 *   1 'vagon_01_indoor Group' authored group node        <- a wagon before this repair
 * Out of scope:
 *   1 container_12m_Green_close at x=-400
 */
function railYardFixture() {
  const rows = [];
  const P = 'SBG_Synthetic/OO/PROPS';

  rows.push(record('lvl', 1, 0, 'PROPS_ROOT', { x: 0, y: 0, z: 0 }, { hierarchyPath: P }));

  // Tank wagon at (200, 1, -100) with technical children.
  rows.push(record('lvl', 10, 1, 'Vagon_tank', { x: 200, y: 1, z: -100 }, { hierarchyPath: `${P}/Vagon_tank` }));
  rows.push(record('lvl', 11, 10, 'Vagon_tank_LOD0', { x: 0, y: 0, z: 0 }, { hierarchyPath: `${P}/Vagon_tank/Vagon_tank_LOD0` }));
  rows.push(record('lvl', 12, 10, 'Vagon_tank_COLLIDER', { x: 0, y: 0, z: 0 }, { hierarchyPath: `${P}/Vagon_tank/Vagon_tank_COLLIDER` }));
  rows.push(record('lvl', 13, 10, 'Train_wheels', { x: -3, y: -1, z: 0 }, { hierarchyPath: `${P}/Vagon_tank/Train_wheels` }));

  // Locomotive at (240, 1, -90).
  rows.push(record('lvl', 20, 1, 'Locomotive', { x: 240, y: 1, z: -90 }, { hierarchyPath: `${P}/Locomotive` }));
  rows.push(record('lvl', 21, 20, 'Locomotive_LOD1', { x: 0, y: 0, z: 0 }, { hierarchyPath: `${P}/Locomotive/Locomotive_LOD1` }));
  rows.push(record('lvl', 22, 20, 'Locomotive_BALLISTIC_glass', { x: 0, y: 0, z: 0 }, { hierarchyPath: `${P}/Locomotive/Locomotive_BALLISTIC_glass` }));

  // Sliding-door boxcar at (260, 1, -80): two bogies plus its own body mesh.
  rows.push(record('lvl', 30, 1, 'Vagon_movable_doors_grey', { x: 260, y: 1, z: -80 }, { hierarchyPath: `${P}/Vagon_movable_doors_grey` }));
  rows.push(record('lvl', 31, 30, 'Vagon_movable_door_LOD0', { x: 0, y: 0, z: 0 }, { hierarchyPath: `${P}/Vagon_movable_doors_grey/Vagon_movable_door_LOD0` }));
  rows.push(record('lvl', 32, 30, 'Train_wheels', { x: -4, y: -1, z: 0 }, { hierarchyPath: `${P}/Vagon_movable_doors_grey/Train_wheels` }));
  rows.push(record('lvl', 33, 30, 'Train_wheels', { x: 4, y: -1, z: 0 }, { hierarchyPath: `${P}/Vagon_movable_doors_grey/Train_wheels` }));
  rows.push(record('lvl', 34, 30, 'Vagon_movable_door_slide_01', { x: 0, y: 0, z: 1 }, { hierarchyPath: `${P}/Vagon_movable_doors_grey/Vagon_movable_door_slide_01` }));

  // Red 6 m container at (300, 1, -60), and a garland anchor placed exactly on it.
  rows.push(record('lvl', 40, 1, 'container_6m_Red_close', { x: 300, y: 1, z: -60 }, { hierarchyPath: `${P}/container_6m_Red_close` }));
  rows.push(record('lvl', 50, 0, 'GARLANDS', { x: 300, y: 1, z: -60 }, { hierarchyPath: 'NewYear_Event/GARLANDS' }));
  rows.push(record('lvl', 51, 50, 'container_6m (42)', { x: 0, y: 0, z: 0 }, { hierarchyPath: 'NewYear_Event/GARLANDS/container_6m (42)', sceneIndex: 8 }));

  // An inactive blue container in scope.
  rows.push(record('lvl', 60, 1, 'container_6m_Blue_close', { x: 310, y: 1, z: -55 }, { active: false, hierarchyPath: `${P}/container_6m_Blue_close` }));

  // An authored group node whose name starts with 'vagon_'.
  rows.push(record('lvl', 70, 1, 'vagon_01_indoor Group', { x: 320, y: 1, z: -50 }, { hierarchyPath: `${P}/vagon_01_indoor Group` }));

  // Out of scope.
  rows.push(record('lvl', 80, 1, 'container_12m_Green_close', { x: -400, y: 1, z: -50 }, { hierarchyPath: `${P}/container_12m_Green_close` }));

  return rows;
}

function runFixture(records, options = {}) {
  return runSecondSource({
    createFactsStream: factsDocument(records),
    sceneManifest: MANIFEST_FIXTURE,
    tracedProps: [],
    ...options,
  });
}

test('the assembled pipeline streams, composes, reduces and scopes a synthetic yard', async () => {
  const result = await runFixture(railYardFixture());

  assert.equal(result.outputKind, 'conservative-candidate-roster');
  assert.equal(result.totals.gameObjectsStreamed, railYardFixture().length);
  assert.equal(result.totals.placedRootsUnresolved, 0);

  // The three technical/bogie/door children collapse into their owners.
  assert.equal(result.totals.nestedUnderAnotherMatch, 9);

  // In scope: tank, locomotive, boxcar, red container, garland anchor, inactive blue.
  // The garland goes to the named exclusion; the inactive blue goes to the active filter.
  // What survives: Vagon_tank, Locomotive, Vagon_movable_doors_grey, container_6m_Red_close.
  assert.equal(result.totals.rootsInScopeBeforeExclusions, 6);
  assert.equal(result.totals.rootsExcluded, 1);
  assert.equal(result.totals.rootsInScope, 5);
  assert.equal(result.totals.rootsInScopeActive, 4);
  assert.equal(result.totals.rootsInScopeAfterDedupe, 4);
  assert.equal(result.totals.railBodiesInScope, 3);

  assert.deepEqual(result.summaryInScope.byFamily.sort(), [
    ['container-6m', 1],
    ['locomotive', 1],
    ['sliding-door-boxcar', 1],
    ['tank-wagon', 1],
  ]);

  // Composition walked the parent chain: the boxcar sits where its parent put it.
  const boxcar = result.rows.find((r) => r.family === 'sliding-door-boxcar');
  positionCloseTo(boxcar.world, { x: 260, y: 1, z: -80 }, 1e-9);
  assert.deepEqual(boxcar.runtime, sourceToRuntime(boxcar.world));
});

test('S1 the garland anchor is detected as a position duplicate and excluded by name', async () => {
  const result = await runFixture(railYardFixture());

  assert.equal(result.totals.positionDuplicateClustersBeforeExclusions, 1);
  assert.equal(result.totals.positionDuplicateClustersRemaining, 0);

  const [cluster] = result.positionDuplicates.beforeExclusions;
  assert.equal(cluster.count, 2);
  assert.deepEqual(cluster.hierarchyRoots, ['NewYear_Event', 'SBG_Synthetic']);

  const [exclusion] = result.exclusions;
  assert.equal(exclusion.hierarchyRoot, 'NewYear_Event');
  assert.equal(exclusion.excludedInScopeRoots, 1);
  assert.ok(exclusion.reason.length > 0, 'the exclusion is reported, never silent');

  // With the garland present, the colour question becomes undecidable again.
  const included = await runFixture(railYardFixture(), { includeHierarchyRoots: ['NewYear_Event'] });
  assert.equal(included.exclusions.length, 0);
  assert.equal(included.totals.rootsExcluded, 0);
  assert.equal(included.totals.rootsInScope, 6);
  assert.equal(included.totals.rootsInScopeActive, 5);
  assert.equal(included.colourDecidability.withoutColourToken, 1);
  assert.equal(
    included.verdict.items.find((i) => i.item === 'container-6m-red').status,
    'cannot-address',
  );
  assert.equal(included.totals.positionDuplicateClustersRemaining, 1);
});

test('S2 the locomotive reaches the roster and counts as rail rolling stock', async () => {
  const result = await runFixture(railYardFixture());
  const loco = result.rows.find((r) => r.family === 'locomotive');
  assert.ok(loco, 'the locomotive must appear in the in-scope roster');
  positionCloseTo(loco.world, { x: 240, y: 1, z: -90 }, 1e-9);
  assert.ok(result.consists.some((c) => c.families.some(([family]) => family === 'locomotive')));
  assert.ok(result.verdict.familiesTheClaimNeverListed.some((r) => r.family === 'locomotive'));
});

test('S4 the sliding-door boxcar is one root, not one root plus its bogies', async () => {
  const result = await runFixture(railYardFixture());
  const boxcars = result.rows.filter((r) => r.family === 'sliding-door-boxcar');
  assert.equal(boxcars.length, 1);
  assert.equal(boxcars[0].role, 'body');
  // Both bogies and the body mesh were absorbed; no bogie survived as a root.
  assert.equal(result.totals.orphanBogieRoots, 0);
  assert.equal(result.rows.some((r) => r.family === 'bogie'), false);
});

test('the lexicon self-check reports a bogie with no rail-body ancestor', async () => {
  const records = railYardFixture();
  records.push(record('lvl', 90, 1, 'Train_wheels', { x: 250, y: 1, z: -70 }, {
    hierarchyPath: 'SBG_Synthetic/OO/PROPS/Unknown_thing/Train_wheels',
  }));
  const result = await runFixture(records);
  assert.equal(result.totals.orphanBogieRoots, 1);
  assert.equal(result.orphanBogieRoots[0].name, 'Train_wheels');
});

test('an unrecognised vagon_ head is surfaced, never silently binned as a known family', async () => {
  const records = railYardFixture();
  records.push(record('lvl', 91, 1, 'Vagon_refrigerator_white', { x: 255, y: 1, z: -95 }, {
    hierarchyPath: 'SBG_Synthetic/OO/PROPS/Vagon_refrigerator_white',
  }));
  const result = await runFixture(records);
  assert.equal(result.totals.unrecognisedRollingStockRoots, 1);
  assert.equal(result.unrecognisedRollingStock[0].family, 'rolling-stock-unrecognised:refrigerator');
  assert.equal(isRailBodyFamily('rolling-stock-unrecognised:refrigerator'), true);
});

test('the authored group node never becomes a wagon body', async () => {
  const result = await runFixture(railYardFixture());
  assert.equal(result.rows.some((r) => /indoor group/i.test(r.token)), false);
  assert.equal(result.summaryAllRoots.byToken.some(([token]) => /indoor group/i.test(token)), false);
});

test('an inactive root is scoped but dropped before the roster', async () => {
  const result = await runFixture(railYardFixture());
  assert.equal(result.totals.rootsInScope, 5);
  assert.equal(result.totals.rootsInScopeActive, 4);
  assert.equal(result.rows.some((r) => r.name === 'container_6m_Blue_close'), false);
});

test('the frame decision reports its sample and separates rail rolling stock', async () => {
  const result = await runFixture(railYardFixture());
  assert.equal(result.frame.chosen, 'source');
  assert.equal(result.frame.measuredOver, 'every resolved root of any family');
  assert.equal(result.frame.resolvedRootsConsidered, result.totals.placedRootsResolved);
  // S6: sourceHits counts EVERY resolved root in the box — bodies, parts, the
  // inactive container and the garland anchor alike — and the rail-only tally is
  // strictly smaller. The pre-repair report called this number "rail bodies".
  assert.equal(result.frame.sourceHits, 6);
  assert.equal(result.frame.railBodySourceHits, 3);
  assert.equal(result.frame.runtimeHits, 0);
});

test('the pipeline refuses to run when the manifest disagrees with the literals', async () => {
  await assert.rejects(
    () => runFixture(railYardFixture(), {
      sceneManifest: {
        frames: MANIFEST_FIXTURE.frames,
        scope: { ...MANIFEST_FIXTURE.scope, widthM: 999 },
      },
    }),
    (e) => e.code === 'ERR_SECOND_SOURCE_MANIFEST_DRIFT',
  );
});

test('a truncated dump stops the run instead of yielding a short roster', async () => {
  const text = JSON.stringify({ gameObjects: railYardFixture() }).slice(0, -40);
  await assert.rejects(
    () => runSecondSource({
      createFactsStream: () => (async function* () { yield text; }()),
      sceneManifest: MANIFEST_FIXTURE,
      tracedProps: [],
    }),
    (e) => e.code === 'ERR_SECOND_SOURCE_TRUNCATED',
  );
});

test('the pipeline result is chunk-size independent', async () => {
  const records = railYardFixture();
  const reference = await runFixture(records);
  for (const chunkSize of [1, 7, 512, 1 << 20]) {
    const result = await runSecondSource({
      createFactsStream: factsDocument(records, { chunkSize }),
      sceneManifest: MANIFEST_FIXTURE,
      tracedProps: [],
    });
    assert.deepEqual(result.totals, reference.totals, `chunk size ${chunkSize} disagreed`);
    assert.deepEqual(result.summaryInScope, reference.summaryInScope, `chunk size ${chunkSize} disagreed`);
  }
});

/* ------------------------------------------------------------------ *
 * The honesty requirement
 * ------------------------------------------------------------------ */

test('the provenance statement names the shared acquisition layer and the roster framing', () => {
  const text = PROVENANCE_STATEMENT.join('\n');
  assert.match(text, /NOT AN INDEPENDENT SOURCE/);
  assert.match(text, /extract-customs-unity\.py/);
  assert.match(text, /NOT independent validation/);
  assert.match(text, /CONSERVATIVE CANDIDATE ROSTER/);
  assert.match(text, /geo-tagged in-game photographs/);
});

test('the capability statement refuses to claim it can validate the primary extractor', () => {
  const cannot = CAPABILITY_STATEMENT.cannot.join('\n');
  assert.match(cannot, /Validate the primary extractor/);
  assert.match(cannot, /Settle any count/);
});

test('the report prints the provenance statement BEFORE any number', async () => {
  const result = await runFixture(railYardFixture());
  const report = formatReport(result);

  const provenanceAt = report.indexOf('NOT AN INDEPENDENT SOURCE');
  const totalsAt = report.indexOf('TOTALS');
  const rosterAt = report.indexOf('IN-SCOPE ROOTS BY NAME TOKEN');
  assert.ok(provenanceAt >= 0, 'the report must carry the provenance statement');
  assert.ok(provenanceAt < totalsAt, 'provenance must precede the totals');
  assert.ok(provenanceAt < rosterAt, 'provenance must precede the roster');

  assert.match(report, /CONSERVATIVE CANDIDATE ROSTER/);
  assert.match(report, /Agreement is not validation/);
  assert.match(report, /EXCLUSIONS APPLIED \(nothing is filtered silently\)/);
  assert.match(report, /POSITION DUPLICATES/);
  // S6: the frame line no longer calls an all-family count "rail bodies".
  assert.match(report, /resolved roots, ANY family, inside box as SOURCE x\/z/);
  assert.equal(/rail bodies inside box/.test(report), false);
});

test('the report states what each exclusion removed and why', async () => {
  const report = formatReport(await runFixture(railYardFixture()));
  assert.match(report, /hierarchy root "NewYear_Event" — 1 in-scope root\(s\) removed/);
  assert.match(report, /why {6}: Seasonal garland-anchor subtree/);
  assert.match(report, /falsifier:/);
});
