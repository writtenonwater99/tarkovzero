import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CUSTOMS_LOCAL_VEGETATION_CLASSES,
  classifyCustomsVegetationPrototype,
  loadCustomsLocalVegetation,
} from '../src/customs-local-vegetation.js';
import {
  CustomsLocalTerrainInvalidError,
  CustomsLocalTerrainUnavailableError,
} from '../src/customs-local-terrain-loader.js';
import { validateCustomsLocalTerrainManifest } from '../src/customs-local-terrain.js';

const ORIGIN = 'http://localhost:5173';
const SOURCE_FRAME = 'eft-unity-world-metres-y-up';

function controlMaps(prefix) {
  return [0, 1, 2].map((index) => ({
    id: `${prefix}-control-${index}`,
    file: `${prefix}/control-${index}.png`,
    channels: ['r', 'g', 'b', 'a'],
    width: 2,
    height: 2,
    columnOrder: 'x-min-to-x-max',
    rowOrder: 'z-min-to-z-max',
  }));
}

function manifestTile(id, originX, prototypeName) {
  const prototypeId = `${id}-vegetation-000`;
  return {
    id,
    origin: { x: originX, y: 0, z: 0 },
    resolution: { columns: 2, rows: 2 },
    sampleSpacingM: { x: 1, z: 1 },
    heightEncoding: {
      storage: 'float32le',
      endianness: 'little',
      scalarType: 'float32',
      sampleOrder: 'row-major-z-times-columns-plus-x',
      values: 'canonical-world-y-metres',
    },
    heightFile: `${id}/height.f32le`,
    controlMaps: controlMaps(id),
    layers: [{
      id: `${id}-layer`,
      name: 'Grass',
      index: 0,
      controlMapId: `${id}-control-0`,
      channel: 'r',
    }],
    vegetation: {
      file: `${id}/${id}-vegetation.json`,
      format: 'json',
      count: 1,
      prototypes: [{ id: prototypeId, name: prototypeName }],
    },
  };
}

function localPackage() {
  const manifest = validateCustomsLocalTerrainManifest({
    schemaVersion: 1,
    map: 'customs',
    localOnly: true,
    sourceFrame: SOURCE_FRAME,
    reliefOriginYM: 0,
    tiles: [
      manifestTile('west', 0, 'Scots Pine 03'),
      manifestTile('east', 1, 'Silver Birch'),
    ],
  });
  return {
    manifestUrl: `${ORIGIN}/@local-game-derived/customs/manifest.json`,
    manifest,
    assets: manifest.tiles.map((tile) => ({
      tileId: tile.id,
      heightUrl: `${ORIGIN}/@local-game-derived/customs/${tile.heightFile}`,
      controlMaps: [],
      vegetation: {
        url: `${ORIGIN}/@local-game-derived/customs/${tile.vegetation.file}`,
        format: 'json',
        count: tile.vegetation.count,
        prototypes: tile.vegetation.prototypes,
      },
    })),
  };
}

function payload(tileId, prototypeName, overrides = {}) {
  const prototypeId = `${tileId}-vegetation-000`;
  return {
    schemaVersion: 1,
    map: 'customs',
    localOnly: true,
    sourceFrame: SOURCE_FRAME,
    tileId,
    prototypes: [{
      index: 0,
      name: prototypeName,
      kind: 'terrain-tree-or-plant',
      bendFactor: 0.25,
      navMeshLod: 1,
      id: prototypeId,
    }],
    instances: [{
      index: 0,
      prototypeId,
      positionNormalized: { x: 0.25, y: 0.5, z: 0.75 },
      worldPosition: { x: tileId === 'west' ? -20 : 20, y: 3.5, z: -15 },
      widthScale: 1.2,
      heightScale: 0.9,
      rotationRadians: Math.PI / 3,
      color: { r: 200, g: 201, b: 202, a: 255 },
      lightmapColor: { r: 0.8, g: 0.9, b: 1, a: 1 },
    }],
    ...overrides,
  };
}

function response({ body, status = 200 }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return structuredClone(body);
    },
  };
}

function successfulFetch(overrides = new Map()) {
  const calls = [];
  const westUrl = `${ORIGIN}/@local-game-derived/customs/west/west-vegetation.json`;
  const eastUrl = `${ORIGIN}/@local-game-derived/customs/east/east-vegetation.json`;
  const bodies = new Map([
    [westUrl, payload('west', 'Scots Pine 03')],
    [eastUrl, payload('east', 'Silver Birch')],
    ...overrides,
  ]);
  return {
    calls,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return bodies.has(url)
        ? response({ body: bodies.get(url) })
        : response({ status: 404 });
    },
  };
}

test('classifies prototype names deterministically into the five instancing classes', () => {
  assert.deepEqual(CUSTOMS_LOCAL_VEGETATION_CLASSES, [
    'pine', 'deciduous', 'shrub', 'stump', 'ground-plant',
  ]);
  assert.equal(classifyCustomsVegetationPrototype('pine05'), 'pine');
  assert.equal(classifyCustomsVegetationPrototype('Silver Birch'), 'deciduous');
  assert.equal(classifyCustomsVegetationPrototype('filbert brush'), 'shrub');
  assert.equal(classifyCustomsVegetationPrototype('old_tree_stump'), 'stump');
  assert.equal(classifyCustomsVegetationPrototype('grass_dry3'), 'ground-plant');
  assert.equal(classifyCustomsVegetationPrototype('unknown prototype'), 'ground-plant');
});

test('fetches every declared JSON and builds a frozen canonical flat/group instancing index', async () => {
  const { calls, fetch } = successfulFetch();
  const loaded = await loadCustomsLocalVegetation(localPackage(), { fetch });

  assert.equal(calls.length, 2);
  for (const { options } of calls) {
    assert.equal(options.mode, 'same-origin');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error');
  }
  assert.equal(loaded.count, 2);
  assert.equal(loaded.instances.length, 2);
  assert.deepEqual(loaded.instances[0].worldPosition, { x: -20, y: 3.5, z: -15 });
  assert.deepEqual(loaded.instances[0].positionNormalized, { x: 0.25, y: 0.5, z: 0.75 });
  assert.equal(loaded.instances[0].classification, 'pine');
  assert.equal(loaded.instances[1].classification, 'deciduous');
  assert.equal(loaded.instances[0].groupIndex, 0);
  assert.deepEqual(loaded.groups[0].instanceIndexes, [0]);
  assert.deepEqual(loaded.tiles[1].instanceIndexes, [1]);
  assert.equal(loaded.sourceFrame, SOURCE_FRAME);
  assert.ok(Object.isFrozen(loaded));
  assert.ok(Object.isFrozen(loaded.instances[0].worldPosition));
  assert.ok(Object.isFrozen(loaded.groups[0].instanceIndexes));
});

test('normalizes omitted optional instance transforms without changing canonical positions', async () => {
  const west = payload('west', 'Scots Pine 03');
  delete west.instances[0].widthScale;
  delete west.instances[0].heightScale;
  delete west.instances[0].rotationRadians;
  delete west.instances[0].color;
  delete west.instances[0].lightmapColor;
  const { fetch } = successfulFetch(new Map([
    [`${ORIGIN}/@local-game-derived/customs/west/west-vegetation.json`, west],
  ]));
  const loaded = await loadCustomsLocalVegetation(localPackage(), { fetch });
  assert.equal(loaded.instances[0].widthScale, 1);
  assert.equal(loaded.instances[0].heightScale, 1);
  assert.equal(loaded.instances[0].rotationRadians, 0);
  assert.equal(loaded.instances[0].color, null);
  assert.deepEqual(loaded.instances[0].worldPosition, { x: -20, y: 3.5, z: -15 });
});

test('preserves a finite partial Unity color channel set without inventing values', async () => {
  const west = payload('west', 'Scots Pine 03');
  west.instances[0].color = { r: 0.25, g: 0.5, b: 0.75 };
  const { fetch } = successfulFetch(new Map([[
    `${ORIGIN}/@local-game-derived/customs/west/west-vegetation.json`,
    west,
  ]]));
  const loaded = await loadCustomsLocalVegetation(localPackage(), { fetch });
  assert.deepEqual(loaded.instances[0].color, { r: 0.25, g: 0.5, b: 0.75 });
  assert.equal(Object.hasOwn(loaded.instances[0].color, 'a'), false);
});

test('rejects root drift, prototype mismatch, unknown IDs, count drift, and duplicate indexes atomically', async () => {
  const westUrl = `${ORIGIN}/@local-game-derived/customs/west/west-vegetation.json`;
  const cases = [
    ['root drift', () => ({ ...payload('west', 'Scots Pine 03'), unsupported: true }), /unsupported field/],
    ['wrong map', () => ({ ...payload('west', 'Scots Pine 03'), map: 'woods' }), /map must be customs/],
    ['prototype name', () => {
      const value = payload('west', 'Wrong Pine');
      return value;
    }, /name does not match/],
    ['unknown prototype', () => {
      const value = payload('west', 'Scots Pine 03');
      value.instances[0].prototypeId = 'not-declared';
      return value;
    }, /unknown prototype/],
    ['count drift', () => ({ ...payload('west', 'Scots Pine 03'), instances: [] }), /count does not match/],
    ['duplicate indexes', () => {
      const value = payload('west', 'Scots Pine 03');
      value.instances.push(structuredClone(value.instances[0]));
      return value;
    }, /count does not match|duplicates index/],
  ];
  for (const [label, makeWest, expected] of cases) {
    const packageValue = localPackage();
    const value = makeWest();
    if (label === 'duplicate indexes') {
      // Rebuild through plain data because the validated manifest is frozen.
      const plainManifest = structuredClone(packageValue.manifest);
      plainManifest.tiles[0].vegetation.count = 2;
      packageValue.manifest = plainManifest;
      packageValue.assets[0].vegetation.count = 2;
    }
    const { fetch } = successfulFetch(new Map([[westUrl, value]]));
    await assert.rejects(
      loadCustomsLocalVegetation(packageValue, { fetch }),
      (error) => error instanceof CustomsLocalTerrainInvalidError
        && error.code === 'ERR_CUSTOMS_LOCAL_TERRAIN_INVALID'
        && expected.test(error.message),
      label,
    );
  }
});

test('rejects non-finite positions/colors/rotation, out-of-range normalized coordinates, and non-positive scale', async () => {
  const westUrl = `${ORIGIN}/@local-game-derived/customs/west/west-vegetation.json`;
  const cases = [
    ['world position', (instance) => { instance.worldPosition.y = Number.NaN; }, /worldPosition\.y.*finite/],
    ['normalized position', (instance) => { instance.positionNormalized.x = 1.01; }, /inclusive range/],
    ['width scale', (instance) => { instance.widthScale = 0; }, /widthScale.*greater than zero/],
    ['height scale', (instance) => { instance.heightScale = Infinity; }, /heightScale.*finite/],
    ['rotation', (instance) => { instance.rotationRadians = Number.NaN; }, /rotationRadians.*finite/],
    ['color', (instance) => { instance.color.r = Number.NaN; }, /color\.r.*finite/],
  ];
  for (const [label, mutate, expected] of cases) {
    const west = payload('west', 'Scots Pine 03');
    mutate(west.instances[0]);
    const { fetch } = successfulFetch(new Map([[westUrl, west]]));
    await assert.rejects(
      loadCustomsLocalVegetation(localPackage(), { fetch }),
      (error) => error instanceof CustomsLocalTerrainInvalidError && expected.test(error.message),
      label,
    );
  }
});

test('rejects an unsafe or cross-origin vegetation URL before fetching anything', async () => {
  for (const unsafeUrl of [
    'https://example.test/vegetation.json',
    `${ORIGIN}/@local-game-derived/escape.json`,
    `${ORIGIN}/@local-game-derived/customs/west/west-vegetation.json?remote=1`,
  ]) {
    const packageValue = localPackage();
    packageValue.assets[0].vegetation.url = unsafeUrl;
    let callCount = 0;
    await assert.rejects(
      loadCustomsLocalVegetation(packageValue, {
        fetch: async () => {
          callCount += 1;
          throw new Error('must not fetch');
        },
      }),
      (error) => error instanceof CustomsLocalTerrainInvalidError
        && /same-origin package URL/.test(error.message),
    );
    assert.equal(callCount, 0);
  }
});

test('reports HTTP failures as unavailable and preserves AbortError', async () => {
  await assert.rejects(
    loadCustomsLocalVegetation(localPackage(), {
      fetch: async () => response({ status: 404 }),
    }),
    (error) => error instanceof CustomsLocalTerrainUnavailableError
      && error.status === 404
      && error.code === 'ERR_CUSTOMS_LOCAL_TERRAIN_UNAVAILABLE',
  );

  const controller = new AbortController();
  let receivedSignal;
  await assert.rejects(
    loadCustomsLocalVegetation(localPackage(), {
      signal: controller.signal,
      fetch: async (_url, options) => {
        receivedSignal = options.signal;
        controller.abort();
        options.signal.throwIfAborted();
      },
    }),
    (error) => error?.name === 'AbortError',
  );
  assert.equal(receivedSignal, controller.signal);
});
