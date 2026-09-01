import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CUSTOMS_LOCAL_TERRAIN_MANIFEST_PATH,
  CustomsLocalTerrainInvalidError,
  CustomsLocalTerrainUnavailableError,
  loadCustomsLocalTerrainPackage,
} from '../src/customs-local-terrain-loader.js';
import { sampleCustomsTerrainElevation } from '../src/customs-local-terrain.js';

const LOCAL_ORIGIN = 'http://localhost:5173';
const MANIFEST_URL = `${LOCAL_ORIGIN}${CUSTOMS_LOCAL_TERRAIN_MANIFEST_PATH}`;

function controlMaps(prefix) {
  return [0, 1, 2].map((index) => ({
    id: `control-${index}`,
    file: `${prefix}/control-${index}.png`,
    channels: ['r', 'g', 'b', 'a'],
    width: 4,
    height: 4,
    columnOrder: 'x-min-to-x-max',
    rowOrder: 'z-min-to-z-max',
  }));
}

function tile(id, originX) {
  const prefix = `tiles/${id}`;
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
    heightFile: `${prefix}/height.f32le`,
    controlMaps: controlMaps(prefix),
    layers: [
      {
        id: 'grass',
        name: 'Grass',
        index: 0,
        controlMapId: 'control-0',
        channel: 'r',
      },
    ],
    vegetation: {
      file: `${prefix}/vegetation.json`,
      format: 'json',
      count: 1,
      prototypes: [{ id: 'pine', name: 'Pine' }],
    },
  };
}

function manifest() {
  return {
    schemaVersion: 1,
    map: 'customs',
    localOnly: true,
    sourceFrame: 'eft-unity-world-metres-y-up',
    reliefOriginYM: 0,
    tiles: [tile('west', 0), tile('east', 1)],
  };
}

function float32LE(values) {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes.buffer;
}

function response({ json, bytes, status = 200 }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (json === undefined) throw new Error('No JSON body');
      return structuredClone(json);
    },
    async arrayBuffer() {
      if (bytes === undefined) throw new Error('No byte body');
      return bytes;
    },
  };
}

function successfulFetch(manifestValue = manifest()) {
  const calls = [];
  const bodies = new Map([
    [MANIFEST_URL, response({ json: manifestValue })],
    [`${LOCAL_ORIGIN}/@local-game-derived/customs/tiles/west/height.f32le`, response({ bytes: float32LE([0, 1, 10, 11]) })],
    [`${LOCAL_ORIGIN}/@local-game-derived/customs/tiles/east/height.f32le`, response({ bytes: float32LE([1, 2, 11, 12]) })],
  ]);
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return bodies.get(url) ?? response({ status: 404 });
  };
  return { calls, fetch };
}

test('allows localhost, 127.0.0.1, and [::1] loopback page locations', async () => {
  for (const href of [
    'http://localhost:5173/map',
    'http://127.0.0.1:5173/map',
    'http://[::1]:5173/map',
  ]) {
    const localOrigin = new URL(href).origin;
    const localManifestUrl = `${localOrigin}${CUSTOMS_LOCAL_TERRAIN_MANIFEST_PATH}`;
    const value = manifest();
    const fetch = async (url) => {
      if (url === localManifestUrl) return response({ json: value });
      const isWest = url.endsWith('/tiles/west/height.f32le');
      return response({ bytes: float32LE(isWest ? [0, 1, 10, 11] : [1, 2, 11, 12]) });
    };
    const loaded = await loadCustomsLocalTerrainPackage({ fetch, location: href });
    assert.equal(loaded.manifestUrl, localManifestUrl);
  }
});

test('denies non-loopback pages before issuing any fetch', async () => {
  let callCount = 0;
  const fetch = async () => {
    callCount += 1;
    throw new Error('must not fetch');
  };
  await assert.rejects(
    loadCustomsLocalTerrainPackage({ fetch, location: 'https://tarkovzero.example/map' }),
    (error) => error instanceof CustomsLocalTerrainUnavailableError
      && error.code === 'ERR_CUSTOMS_LOCAL_TERRAIN_UNAVAILABLE'
      && /disabled outside/.test(error.message),
  );
  assert.equal(callCount, 0);
});

test('hydrates every height file and exposes, but does not fetch, control or vegetation URLs', async () => {
  const { calls, fetch } = successfulFetch();
  const loaded = await loadCustomsLocalTerrainPackage({
    fetch,
    location: `${LOCAL_ORIGIN}/map?renderer=three`,
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map(({ url }) => url).sort(),
    [
      MANIFEST_URL,
      `${LOCAL_ORIGIN}/@local-game-derived/customs/tiles/east/height.f32le`,
      `${LOCAL_ORIGIN}/@local-game-derived/customs/tiles/west/height.f32le`,
    ].sort(),
  );
  for (const { options } of calls) {
    assert.equal(options.mode, 'same-origin');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error');
  }
  assert.equal(
    loaded.assets[0].controlMaps[0].url,
    `${LOCAL_ORIGIN}/@local-game-derived/customs/tiles/west/control-0.png`,
  );
  assert.equal(
    loaded.assets[0].vegetation.url,
    `${LOCAL_ORIGIN}/@local-game-derived/customs/tiles/west/vegetation.json`,
  );
  assert.equal(Object.hasOwn(loaded.assets[0], 'pbr'), false);
  assert.equal(Object.hasOwn(loaded.assets[0], 'meshes'), false);
  assert.equal(
    sampleCustomsTerrainElevation(loaded.runtime, {
      sourceFrame: 'eft-unity-world-metres-y-up',
      x: 0.5,
      z: 0.5,
    }).canonicalYM,
    5.5,
  );
  assert.ok(Object.isFrozen(loaded));
  assert.ok(Object.isFrozen(loaded.assets[0].controlMaps));
});

test('reports a missing manifest or height as typed unavailable', async () => {
  for (const missing of ['manifest', 'height']) {
    const fetch = async (url) => {
      if (missing === 'manifest' || url.includes('/tiles/west/')) return response({ status: 404 });
      return response({ json: manifest() });
    };
    await assert.rejects(
      loadCustomsLocalTerrainPackage({ fetch, location: `${LOCAL_ORIGIN}/map` }),
      (error) => error instanceof CustomsLocalTerrainUnavailableError
        && error.status === 404
        && error.code === 'ERR_CUSTOMS_LOCAL_TERRAIN_UNAVAILABLE',
      missing,
    );
  }
});

test('passes the AbortSignal to fetch and preserves AbortError cancellation', async () => {
  const controller = new AbortController();
  let receivedSignal;
  const fetch = async (_url, options) => {
    receivedSignal = options.signal;
    controller.abort();
    options.signal.throwIfAborted();
  };

  await assert.rejects(
    loadCustomsLocalTerrainPackage({
      fetch,
      location: `${LOCAL_ORIGIN}/map`,
      signal: controller.signal,
    }),
    (error) => error?.name === 'AbortError',
  );
  assert.equal(receivedSignal, controller.signal);
});

test('rejects unsafe manifest asset paths as typed invalid without requesting them', async () => {
  const unsafe = manifest();
  unsafe.tiles[0].heightFile = '../escape.f32le';
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    return response({ json: unsafe });
  };

  await assert.rejects(
    loadCustomsLocalTerrainPackage({ fetch, location: `${LOCAL_ORIGIN}/map` }),
    (error) => error instanceof CustomsLocalTerrainInvalidError
      && error.code === 'ERR_CUSTOMS_LOCAL_TERRAIN_INVALID'
      && /safe relative local path|traversal/.test(error.message),
  );
  assert.deepEqual(calls, [MANIFEST_URL]);
});
