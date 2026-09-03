import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CUSTOMS_LOCAL_TERRAIN_MANIFEST_PATH,
  CUSTOMS_PROMOTED_TERRAIN_MANIFEST_PATH,
  CustomsLocalTerrainInvalidError,
  CustomsLocalTerrainUnavailableError,
  loadCustomsLocalTerrainPackage,
  loadCustomsPromotedTerrainPackage,
} from '../src/customs-local-terrain-loader.js';
import { sampleCustomsTerrainElevation } from '../src/customs-local-terrain.js';
import { canLoadLocalGameDerivedAssets } from '../src/renderer-gate.js';

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

// ── The PROMOTED terrain package (2026-09-02) ──────────────────────────────────────────────────
//
// The founder opened production and said "this is far from what we worked on. not even the floor
// ground correct": production was drawing the heightfield fitted from spawn and loot points while
// the reviewed local build drew the exact Unity tiles. He approved promoting the terrain height and
// control surfaces, so they now ship from `public/assets/3d/customs/terrain/` under
// `asset-promotion-manifest.json`.
//
// Two things have to hold at once, and these tests hold them apart:
//   * the promoted package loads from a PRODUCTION origin, with no gate;
//   * `canLoadLocalGameDerivedAssets()` is unchanged, and the LOCAL loader still refuses that same
//     origin — so nothing was relaxed to make this ship.

const PRODUCTION_ORIGIN = 'https://tarkovzero.com';
const PROMOTED_MANIFEST_URL = `${PRODUCTION_ORIGIN}${CUSTOMS_PROMOTED_TERRAIN_MANIFEST_PATH}`;

/** The promoted manifest: `localOnly: false`, and no tile references vegetation. */
function promotedManifest() {
  const value = manifest();
  value.localOnly = false;
  for (const entry of value.tiles) delete entry.vegetation;
  return value;
}

function promotedFetch(origin = PRODUCTION_ORIGIN, manifestValue = promotedManifest()) {
  const calls = [];
  const base = `${origin}/assets/3d/customs/terrain`;
  const bodies = new Map([
    [`${origin}${CUSTOMS_PROMOTED_TERRAIN_MANIFEST_PATH}`, () => response({ json: manifestValue })],
    [`${base}/tiles/west/height.f32le`, () => response({ bytes: float32LE([0, 1, 10, 11]) })],
    [`${base}/tiles/east/height.f32le`, () => response({ bytes: float32LE([1, 2, 11, 12]) })],
  ]);
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return (bodies.get(url) ?? (() => response({ status: 404 })))();
  };
  return { calls, fetch };
}

test('THE PROMOTION: the promoted terrain package loads from a PRODUCTION origin, ungated', async () => {
  const { calls, fetch } = promotedFetch();
  const loaded = await loadCustomsPromotedTerrainPackage({
    fetch, location: `${PRODUCTION_ORIGIN}/?map=customs`,
  });
  assert.equal(loaded.manifestUrl, PROMOTED_MANIFEST_URL);
  assert.equal(loaded.distribution, 'promoted-public');
  assert.equal(loaded.manifest.localOnly, false);
  assert.equal(loaded.manifest.tiles.length, 2);
  // The runtime is the same one the local package hydrates: the promoted bytes are the same bytes.
  assert.equal(
    sampleCustomsTerrainElevation(loaded.runtime, {
      sourceFrame: 'eft-unity-world-metres-y-up', x: 0.5, z: 0.5,
    }).canonicalYM,
    5.5,
    'the promoted package hydrates the same runtime and samples the same ground as the local one',
  );
  // Every URL it touched is a public asset path — none of them is the dev-only local route.
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.ok(call.url.startsWith(`${PRODUCTION_ORIGIN}/assets/3d/customs/terrain/`), call.url);
    assert.doesNotMatch(call.url, /@local-game-derived/);
    // An immutable, digest-pinned public asset may be HTTP-cached; the local route may not.
    assert.equal(call.options.cache, 'default');
  }
});

test('DISCRIMINATION: the LOCAL loader still refuses that exact production origin, and the gate is untouched', async () => {
  // Same origin, same page, same moment. The two loaders answer differently, which is the whole
  // point: promoting the terrain removed it from the local set, it did not widen the gate.
  let callCount = 0;
  await assert.rejects(
    loadCustomsLocalTerrainPackage({
      fetch: async () => { callCount += 1; throw new Error('must not fetch'); },
      location: `${PRODUCTION_ORIGIN}/?map=customs`,
    }),
    (error) => error instanceof CustomsLocalTerrainUnavailableError && /disabled outside/.test(error.message),
  );
  assert.equal(callCount, 0);
  // Layer 1, unchanged: production cannot load local game-derived data by any answer this returns.
  assert.equal(canLoadLocalGameDerivedAssets({ dev: false, hostname: 'tarkovzero.com' }), false);
  assert.equal(canLoadLocalGameDerivedAssets({ dev: true, hostname: 'tarkovzero.com' }), false);
  assert.equal(canLoadLocalGameDerivedAssets({ dev: true, hostname: 'localhost' }), true);
});

test('the promoted loader refuses a package that claims to be local-only', async () => {
  const stillLocal = promotedManifest();
  stillLocal.localOnly = true;
  const { fetch } = promotedFetch(PRODUCTION_ORIGIN, stillLocal);
  await assert.rejects(
    loadCustomsPromotedTerrainPackage({ fetch, location: `${PRODUCTION_ORIGIN}/` }),
    (error) => error instanceof CustomsLocalTerrainInvalidError && /localOnly.*must be false/.test(error.message),
  );
});

test('the LOCAL loader refuses a package that claims to be shippable', async () => {
  // The mirror of the test above. Neither loader accepts the other package, so a file moved
  // between the two roots fails loudly instead of being served through the wrong door.
  const shippable = manifest();
  shippable.localOnly = false;
  const { fetch } = successfulFetch(shippable);
  await assert.rejects(
    loadCustomsLocalTerrainPackage({ fetch, location: `${LOCAL_ORIGIN}/map` }),
    (error) => error instanceof CustomsLocalTerrainInvalidError && /localOnly.*must be true/.test(error.message),
  );
});

test('NO CAPTURE RIDES ALONG: a promoted manifest that references vegetation is refused', async () => {
  // `terrain-NNN-vegetation.json` is the raw Unity TerrainData dump — a RAW CAPTURE that no
  // promotion may name (scripts/lib/asset-promotion.mjs, CAPTURE_SUBTREES). If a promoted manifest
  // ever declares vegetation, the loader refuses rather than emitting a URL for a file that must
  // not exist under public/.
  const withVegetation = promotedManifest();
  withVegetation.tiles[0].vegetation = {
    file: 'tiles/west/vegetation.json', format: 'json', count: 1, prototypes: [{ id: 'pine', name: 'Pine' }],
  };
  const { calls, fetch } = promotedFetch(PRODUCTION_ORIGIN, withVegetation);
  await assert.rejects(
    loadCustomsPromotedTerrainPackage({ fetch, location: `${PRODUCTION_ORIGIN}/` }),
    (error) => error instanceof CustomsLocalTerrainInvalidError
      && /must not reference vegetation/.test(error.message)
      && /raw capture/.test(error.message),
  );
  // It refused after reading the manifest and before requesting a single payload.
  assert.deepEqual(calls.map((call) => call.url), [PROMOTED_MANIFEST_URL]);
});

test('the promoted loader still refuses a credentialled or non-http page URL', async () => {
  for (const href of ['https://user:pw@tarkovzero.com/', 'file:///tmp/index.html']) {
    await assert.rejects(
      loadCustomsPromotedTerrainPackage({ fetch: async () => { throw new Error('must not fetch'); }, location: href }),
      (error) => error instanceof CustomsLocalTerrainUnavailableError,
      href,
    );
  }
});
