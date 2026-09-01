import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOCAL_GAME_DERIVED_DIRNAME,
  LOCAL_GAME_DERIVED_ROOT,
  LOCAL_GAME_DERIVED_ROUTE,
  collectAuthorizedCustomsPaths,
  createLocalGameDerivedMiddleware,
  hostHeaderHostname,
  isLoopbackAddress,
  localGameDerivedDevPlugin,
  resolveLocalGameDerivedRequest,
} from './lib/local-game-derived-dev.mjs';

const MANIFEST_VALUE = {
  schemaVersion: 1,
  map: 'customs',
  localOnly: true,
  sourceFrame: 'eft-unity-world-metres-y-up',
  reliefOriginYM: 0,
  tiles: [{
    id: 'west',
    origin: { x: 0, y: 0, z: 0 },
    resolution: { columns: 2, rows: 2 },
    sampleSpacingM: { x: 1, z: 1 },
    heightEncoding: {
      storage: 'float32le',
      endianness: 'little',
      scalarType: 'float32',
      sampleOrder: 'row-major-z-times-columns-plus-x',
      values: 'canonical-world-y-metres',
    },
    heightFile: 'tiles/west/height.f32le',
    controlMaps: [0, 1, 2].map((index) => ({
      id: `west-control-${index}`,
      file: `tiles/west/control-${index}.png`,
      channels: ['r', 'g', 'b', 'a'],
      width: 1,
      height: 1,
      columnOrder: 'x-min-to-x-max',
      rowOrder: 'z-min-to-z-max',
    })),
    layers: [{
      id: 'west-layer-0',
      name: 'ground',
      index: 0,
      controlMapId: 'west-control-0',
      channel: 'r',
    }],
    vegetation: {
      file: 'escape.json',
      format: 'json',
      count: 0,
      prototypes: [],
    },
  }],
};
const MANIFEST = JSON.stringify(MANIFEST_VALUE);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tz-local-derived-'));
  const packageRoot = join(root, LOCAL_GAME_DERIVED_DIRNAME);
  await mkdir(join(packageRoot, 'customs', 'tiles', 'west'), { recursive: true });
  await writeFile(join(packageRoot, 'customs', 'manifest.json'), MANIFEST);
  await writeFile(join(packageRoot, 'customs', 'tiles', 'west', 'height.f32le'), Buffer.from([1, 2, 3, 4]));
  for (const index of [0, 1, 2]) {
    await writeFile(join(packageRoot, 'customs', 'tiles', 'west', `control-${index}.png`), Buffer.from([index]));
  }
  await writeFile(join(packageRoot, 'customs', 'unlisted.json'), '{"not":"authorized"}');
  await writeFile(join(packageRoot, 'customs', 'notes.txt'), 'not a package suffix');
  await writeFile(join(root, 'outside-secret.json'), '{"secret":true}');
  await symlink(join(root, 'outside-secret.json'), join(packageRoot, 'customs', 'escape.json'));
  return { root, packageRoot };
}

function request({ method = 'GET', url, headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  return {
    method,
    url,
    headers: { host: 'localhost:5173', ...headers },
    socket: { remoteAddress },
  };
}

function recorder() {
  const state = { statusCode: 200, headers: new Map(), body: null, ended: false, nextCalls: 0 };
  const res = {
    get statusCode() { return state.statusCode; },
    set statusCode(value) { state.statusCode = value; },
    setHeader(name, value) { state.headers.set(name.toLowerCase(), String(value)); },
    end(body) { state.ended = true; state.body = body ?? null; },
  };
  return { state, res, next: () => { state.nextCalls += 1; } };
}

async function call(middleware, requestValue) {
  const { state, res, next } = recorder();
  await middleware(requestValue, res, next);
  return state;
}

test('serves an allowed package file with no-store, nosniff, type, and length', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = createLocalGameDerivedMiddleware(packageRoot);

  const json = await call(middleware, request({ url: `${LOCAL_GAME_DERIVED_ROUTE}customs/manifest.json` }));
  assert.equal(json.statusCode, 200);
  assert.equal(json.body.toString('utf8'), MANIFEST);
  assert.equal(json.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(json.headers.get('content-length'), String(Buffer.byteLength(MANIFEST)));
  assert.equal(json.headers.get('cache-control'), 'no-store');
  assert.equal(json.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(json.headers.get('cross-origin-resource-policy'), 'same-origin');

  const bytes = await call(middleware, request({
    url: `${LOCAL_GAME_DERIVED_ROUTE}customs/tiles/west/height.f32le`,
  }));
  assert.equal(bytes.statusCode, 200);
  assert.equal(bytes.headers.get('content-type'), 'application/octet-stream');
  assert.deepEqual([...bytes.body], [1, 2, 3, 4]);
});

test('serves only files authorized by the validated Customs manifest', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = createLocalGameDerivedMiddleware(packageRoot);

  const control = await call(middleware, request({
    url: `${LOCAL_GAME_DERIVED_ROUTE}customs/tiles/west/control-2.png`,
  }));
  assert.equal(control.statusCode, 200);

  for (const suffix of ['customs/unlisted.json', 'customs/tiles/west/unlisted.f32le']) {
    const state = await call(middleware, request({ url: `${LOCAL_GAME_DERIVED_ROUTE}${suffix}` }));
    assert.equal(state.statusCode, 404, suffix);
  }

  const authorized = collectAuthorizedCustomsPaths(MANIFEST_VALUE);
  assert.deepEqual([...authorized].sort(), [
    'customs/escape.json',
    'customs/manifest.json',
    'customs/tiles/west/control-0.png',
    'customs/tiles/west/control-1.png',
    'customs/tiles/west/control-2.png',
    'customs/tiles/west/height.f32le',
  ]);
});

test('an invalid manifest fails closed for every package file', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(packageRoot, 'customs', 'manifest.json'), '{"schemaVersion":1}');
  const middleware = createLocalGameDerivedMiddleware(packageRoot);
  for (const suffix of ['customs/manifest.json', 'customs/tiles/west/height.f32le']) {
    const state = await call(middleware, request({ url: `${LOCAL_GAME_DERIVED_ROUTE}${suffix}` }));
    assert.equal(state.statusCode, 404, suffix);
  }
});

test('HEAD returns headers without a body', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = await call(
    createLocalGameDerivedMiddleware(packageRoot),
    request({ method: 'HEAD', url: `${LOCAL_GAME_DERIVED_ROUTE}customs/manifest.json` }),
  );
  assert.equal(state.statusCode, 200);
  assert.equal(state.body, null);
  assert.equal(state.headers.get('content-length'), String(Buffer.byteLength(MANIFEST)));
});

test('rejects every method other than GET and HEAD with an Allow header', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = createLocalGameDerivedMiddleware(packageRoot);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'TRACE']) {
    const state = await call(middleware, request({
      method,
      url: `${LOCAL_GAME_DERIVED_ROUTE}customs/manifest.json`,
    }));
    assert.equal(state.statusCode, 405, method);
    assert.equal(state.headers.get('allow'), 'GET, HEAD');
    assert.equal(state.body, null);
  }
});

test('refuses traversal, encoded traversal, absolute paths, and NUL bytes', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = createLocalGameDerivedMiddleware(packageRoot);
  for (const suffix of [
    '../outside-secret.json',
    'customs/../../outside-secret.json',
    '%2e%2e/outside-secret.json',
    '%2E%2E%2Foutside-secret.json',
    'customs%2f..%2f..%2foutside-secret.json',
    'customs/manifest.json%00.png',
    '..%5Coutside-secret.json',
  ]) {
    const state = await call(middleware, request({ url: `${LOCAL_GAME_DERIVED_ROUTE}${suffix}` }));
    assert.equal(state.statusCode, 400, suffix);
    assert.equal(state.body, null);
  }
});

test('refuses a malformed percent escape', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = await call(
    createLocalGameDerivedMiddleware(packageRoot),
    request({ url: `${LOCAL_GAME_DERIVED_ROUTE}customs/%zz.json` }),
  );
  assert.equal(state.statusCode, 400);
});

test('refuses to follow a symlink that escapes the package root', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = await call(
    createLocalGameDerivedMiddleware(packageRoot),
    request({ url: `${LOCAL_GAME_DERIVED_ROUTE}customs/escape.json` }),
  );
  assert.equal(state.statusCode, 404);
  assert.equal(state.body, null);
});

test('never lists a directory and never serves an unlisted suffix', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = createLocalGameDerivedMiddleware(packageRoot);
  for (const suffix of ['', 'customs', 'customs/', 'customs/tiles/', 'customs/notes.txt', 'customs/manifest']) {
    const state = await call(middleware, request({ url: `${LOCAL_GAME_DERIVED_ROUTE}${suffix}` }));
    assert.equal(state.statusCode, 404, JSON.stringify(suffix));
    assert.equal(state.body, null);
  }
});

test('requires a loopback client socket and a loopback Host header', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = createLocalGameDerivedMiddleware(packageRoot);
  const url = `${LOCAL_GAME_DERIVED_ROUTE}customs/manifest.json`;

  for (const remoteAddress of ['192.168.1.20', '10.0.0.5', '::2', '2001:db8::1', null, '']) {
    const state = await call(middleware, request({ url, remoteAddress }));
    assert.equal(state.statusCode, 403, String(remoteAddress));
  }
  const socketless = await call(middleware, { method: 'GET', url, headers: { host: 'localhost:5173' } });
  assert.equal(socketless.statusCode, 403);
  for (const host of ['tarkovzero.example', 'tarkovzero.example:5173', '192.168.1.20:5173', '']) {
    const state = await call(middleware, request({ url, headers: { host } }));
    assert.equal(state.statusCode, 403, host);
  }
  for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.4.5.6']) {
    const state = await call(middleware, request({ url, remoteAddress }));
    assert.equal(state.statusCode, 200, remoteAddress);
  }
  for (const host of ['localhost:5173', '127.0.0.1:5173', '[::1]:5173', 'localhost']) {
    const state = await call(middleware, request({ url, headers: { host } }));
    assert.equal(state.statusCode, 200, host);
  }
});

test('refuses a proxied request even from a loopback socket', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = createLocalGameDerivedMiddleware(packageRoot);
  for (const header of ['x-forwarded-for', 'x-forwarded-host', 'X-Forwarded-Proto']) {
    const state = await call(middleware, request({
      url: `${LOCAL_GAME_DERIVED_ROUTE}customs/manifest.json`,
      headers: { [header]: 'tarkovzero.example' },
    }));
    assert.equal(state.statusCode, 403, header);
  }
});

test('delegates every request outside the fixed route', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = createLocalGameDerivedMiddleware(packageRoot);
  for (const url of ['/', '/index.html', '/data/customs-3d.json', '/@local-game-derived', '/@fs/etc/passwd']) {
    const { state, res, next } = recorder();
    await middleware(request({ url }), res, next);
    assert.equal(state.nextCalls, 1, url);
    assert.equal(state.ended, false, url);
  }
});

test('ignores query strings and fragments when resolving the file', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = createLocalGameDerivedMiddleware(packageRoot);
  for (const url of [
    `${LOCAL_GAME_DERIVED_ROUTE}customs/manifest.json?t=1`,
    `${LOCAL_GAME_DERIVED_ROUTE}customs/manifest.json#top`,
  ]) {
    const state = await call(middleware, request({ url }));
    assert.equal(state.statusCode, 200, url);
  }
});

test('reports 404 when the package root does not exist', async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = await call(
    createLocalGameDerivedMiddleware(join(root, 'absent')),
    request({ url: `${LOCAL_GAME_DERIVED_ROUTE}customs/manifest.json` }),
  );
  assert.equal(state.statusCode, 404);
});

test('the default package root is anchored to the repository, not the process CWD', () => {
  assert.equal(LOCAL_GAME_DERIVED_ROOT, resolve(dirname(fileURLToPath(import.meta.url)), '..', LOCAL_GAME_DERIVED_DIRNAME));
  assert.ok(LOCAL_GAME_DERIVED_ROOT.endsWith(sep + LOCAL_GAME_DERIVED_DIRNAME));
});

test('the plugin is serve-only and installs no build or preview hook', () => {
  const plugin = localGameDerivedDevPlugin({ root: '/tmp/tz-unused' });
  assert.equal(plugin.apply, 'serve');
  assert.equal(typeof plugin.configureServer, 'function');
  for (const hook of [
    'configurePreviewServer',
    'buildStart',
    'generateBundle',
    'writeBundle',
    'closeBundle',
    'transformIndexHtml',
    'load',
    'resolveId',
    'transform',
  ]) {
    assert.equal(plugin[hook], undefined, hook);
  }
});

test('address and host helpers classify loopback conservatively', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('0:0:0:0:0:0:0:1'), true);
  assert.equal(isLoopbackAddress('127.999.0.1'), false);
  assert.equal(isLoopbackAddress('128.0.0.1'), false);
  assert.equal(isLoopbackAddress('localhost.evil.example'), false);

  assert.equal(hostHeaderHostname('[::1]:5173'), '::1');
  assert.equal(hostHeaderHostname('LOCALHOST:5173'), 'localhost');
  assert.equal(hostHeaderHostname('a:b:c'), null);
  assert.equal(hostHeaderHostname('[::1'), null);
});

test('request resolution reports "not our route" distinctly from a denial', () => {
  const outside = resolveLocalGameDerivedRequest({ method: 'GET', url: '/index.html' });
  assert.deepEqual(outside, { ok: false, status: null, reason: 'route-mismatch' });
  const denied = resolveLocalGameDerivedRequest({
    method: 'GET',
    url: `${LOCAL_GAME_DERIVED_ROUTE}customs/manifest.json`,
    headers: { host: 'evil.example' },
    remoteAddress: '127.0.0.1',
  });
  assert.equal(denied.status, 403);
});
