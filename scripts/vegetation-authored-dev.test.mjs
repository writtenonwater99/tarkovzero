import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VEGETATION_AUTHORED_DIRNAME,
  VEGETATION_AUTHORED_ROOT,
  VEGETATION_AUTHORED_ROUTE,
  collectAuthorizedVegetationPaths,
  createVegetationAuthoredMiddleware,
  resolveVegetationAuthoredRequest,
  vegetationAuthoredDevPlugin,
} from './lib/vegetation-authored-dev.mjs';
import { hostHeaderHostname, isLoopbackAddress } from './lib/local-game-derived-dev.mjs';

const PACK_INDEX_VALUE = {
  schemaVersion: 1,
  documentType: 'customs-authored-vegetation-pack-index',
  authoredAssets: [
    {
      assetId: 'customs.vegetation.birch01',
      prototypeName: 'birch01',
      family: 'birch',
      lods: [
        { lod: 0, file: 'assets/birch01/birch01-lod0.glb', bytes: 8, sha256: `sha256:${'a'.repeat(64)}` },
        { lod: 1, file: 'assets/birch01/birch01-lod1.glb', bytes: 6, sha256: `sha256:${'b'.repeat(64)}` },
        { lod: 2, file: 'assets/birch01/birch01-lod2.glb', bytes: 4, sha256: `sha256:${'c'.repeat(64)}` },
      ],
    },
  ],
};
const PACK_INDEX = JSON.stringify(PACK_INDEX_VALUE);
const PACK_INDEX_RECEIPT = JSON.stringify({ catalogSha256: 'd'.repeat(64) });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tz-vegetation-authored-'));
  const packageRoot = join(root, VEGETATION_AUTHORED_DIRNAME);
  await mkdir(join(packageRoot, 'assets', 'birch01'), { recursive: true });
  await mkdir(join(packageRoot, 'qa', 'previews'), { recursive: true });
  await mkdir(join(packageRoot, 'validation'), { recursive: true });
  await mkdir(join(packageRoot, 'verification'), { recursive: true });
  await mkdir(join(packageRoot, 'logs'), { recursive: true });
  await writeFile(join(packageRoot, 'pack-index.json'), PACK_INDEX);
  await writeFile(join(packageRoot, 'pack-index.receipt.json'), PACK_INDEX_RECEIPT);
  await writeFile(join(packageRoot, 'assets', 'birch01', 'birch01-lod0.glb'), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  await writeFile(join(packageRoot, 'assets', 'birch01', 'birch01-lod1.glb'), Buffer.from([1, 2, 3, 4, 5, 6]));
  await writeFile(join(packageRoot, 'assets', 'birch01', 'birch01-lod2.glb'), Buffer.from([1, 2, 3, 4]));
  // Present on disk, at a plausible-looking path, but never listed in pack-index.json.
  await writeFile(join(packageRoot, 'assets', 'birch01', 'birch01-lod0.receipt.json'), '{"sha256":"unlisted"}');
  await writeFile(join(packageRoot, 'assets', 'birch01', 'unlisted-lod0.glb'), Buffer.from([9]));
  await writeFile(join(packageRoot, 'generation-manifest.json'), '{"generator":"factory"}');
  await writeFile(join(packageRoot, 'qa', 'previews', 'birch01.png'), Buffer.from([0]));
  await writeFile(join(packageRoot, 'validation', 'report.json'), '{"ok":true}');
  await writeFile(join(packageRoot, 'verification', 'repeats.json'), '{"ok":true}');
  await writeFile(join(packageRoot, 'logs', 'run.log'), 'log line');
  await writeFile(join(root, 'outside-secret.glb'), Buffer.from([0xee]));
  await symlink(join(root, 'outside-secret.glb'), join(packageRoot, 'assets', 'birch01', 'escape-lod0.glb'));
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

test('serves an allowed .glb and both pack-index files with correct headers', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = createVegetationAuthoredMiddleware(packageRoot);

  const glb = await call(middleware, request({
    url: `${VEGETATION_AUTHORED_ROUTE}assets/birch01/birch01-lod0.glb`,
  }));
  assert.equal(glb.statusCode, 200);
  assert.deepEqual([...glb.body], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(glb.headers.get('content-type'), 'model/gltf-binary');
  assert.equal(glb.headers.get('content-length'), '8');
  assert.equal(glb.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(glb.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(glb.headers.get('cross-origin-resource-policy'), 'same-origin');

  const index = await call(middleware, request({ url: `${VEGETATION_AUTHORED_ROUTE}pack-index.json` }));
  assert.equal(index.statusCode, 200);
  assert.equal(index.body.toString('utf8'), PACK_INDEX);
  assert.equal(index.headers.get('content-type'), 'application/json; charset=utf-8');
  // Unlike .glb, the catalog itself stays no-store: a future wiring pass may
  // deliberately re-fetch it after a pack regeneration.
  assert.equal(index.headers.get('cache-control'), 'no-store');

  const receipt = await call(middleware, request({ url: `${VEGETATION_AUTHORED_ROUTE}pack-index.receipt.json` }));
  assert.equal(receipt.statusCode, 200);
  assert.equal(receipt.body.toString('utf8'), PACK_INDEX_RECEIPT);
  assert.equal(receipt.headers.get('cache-control'), 'no-store');
});

test('serves only files authorized by pack-index.json\'s own authoredAssets[].lods[].file list', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = createVegetationAuthoredMiddleware(packageRoot);

  const lod1 = await call(middleware, request({
    url: `${VEGETATION_AUTHORED_ROUTE}assets/birch01/birch01-lod1.glb`,
  }));
  assert.equal(lod1.statusCode, 200);

  // Exists on disk at a plausible-looking path but is not listed in pack-index.json.
  const unlisted = await call(middleware, request({
    url: `${VEGETATION_AUTHORED_ROUTE}assets/birch01/unlisted-lod0.glb`,
  }));
  assert.equal(unlisted.statusCode, 404);

  const authorized = collectAuthorizedVegetationPaths(PACK_INDEX_VALUE);
  assert.deepEqual([...authorized].sort(), [
    'assets/birch01/birch01-lod0.glb',
    'assets/birch01/birch01-lod1.glb',
    'assets/birch01/birch01-lod2.glb',
    'pack-index.json',
    'pack-index.receipt.json',
  ]);
});

test('refuses the human/offline review files, even though their extension is allowed', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = createVegetationAuthoredMiddleware(packageRoot);
  for (const suffix of [
    'generation-manifest.json',
    'assets/birch01/birch01-lod0.receipt.json',
    'qa/previews/birch01.png',
    'validation/report.json',
    'verification/repeats.json',
    'logs/run.log',
  ]) {
    const state = await call(middleware, request({ url: `${VEGETATION_AUTHORED_ROUTE}${suffix}` }));
    assert.equal(state.statusCode, 404, suffix);
  }
});

test('an invalid pack-index.json fails closed for every request, including itself', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(packageRoot, 'pack-index.json'), '{not json');
  const middleware = createVegetationAuthoredMiddleware(packageRoot);
  for (const suffix of ['pack-index.json', 'pack-index.receipt.json', 'assets/birch01/birch01-lod0.glb']) {
    const state = await call(middleware, request({ url: `${VEGETATION_AUTHORED_ROUTE}${suffix}` }));
    assert.equal(state.statusCode, 404, suffix);
  }
});

test('HEAD returns headers without a body', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = await call(
    createVegetationAuthoredMiddleware(packageRoot),
    request({ method: 'HEAD', url: `${VEGETATION_AUTHORED_ROUTE}assets/birch01/birch01-lod0.glb` }),
  );
  assert.equal(state.statusCode, 200);
  assert.equal(state.body, null);
  assert.equal(state.headers.get('content-length'), '8');
});

test('rejects every method other than GET and HEAD with an Allow header', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = createVegetationAuthoredMiddleware(packageRoot);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'TRACE']) {
    const state = await call(middleware, request({
      method,
      url: `${VEGETATION_AUTHORED_ROUTE}pack-index.json`,
    }));
    assert.equal(state.statusCode, 405, method);
    assert.equal(state.headers.get('allow'), 'GET, HEAD');
    assert.equal(state.body, null);
  }
});

test('refuses traversal, encoded traversal, absolute paths, and NUL bytes', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = createVegetationAuthoredMiddleware(packageRoot);
  for (const suffix of [
    '../outside-secret.glb',
    'assets/../../outside-secret.glb',
    '%2e%2e/outside-secret.glb',
    '%2E%2E%2Foutside-secret.glb',
    'assets%2f..%2f..%2foutside-secret.glb',
    'pack-index.json%00.glb',
    '..%5Coutside-secret.glb',
  ]) {
    const state = await call(middleware, request({ url: `${VEGETATION_AUTHORED_ROUTE}${suffix}` }));
    assert.equal(state.statusCode, 400, suffix);
    assert.equal(state.body, null);
  }
});

test('refuses a malformed percent escape', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = await call(
    createVegetationAuthoredMiddleware(packageRoot),
    request({ url: `${VEGETATION_AUTHORED_ROUTE}%zz.glb` }),
  );
  assert.equal(state.statusCode, 400);
});

test('refuses to follow a symlink that escapes the package root', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  // Not in pack-index.json's authorized set either way, but this proves the
  // realpath-containment check independently of manifest authorization.
  const state = await call(
    createVegetationAuthoredMiddleware(packageRoot),
    request({ url: `${VEGETATION_AUTHORED_ROUTE}assets/birch01/escape-lod0.glb` }),
  );
  assert.equal(state.statusCode, 404);
  assert.equal(state.body, null);
});

test('never lists a directory and never serves an unlisted suffix', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = createVegetationAuthoredMiddleware(packageRoot);
  for (const suffix of ['', 'assets', 'assets/', 'assets/birch01/', 'logs/', 'pack-index']) {
    const state = await call(middleware, request({ url: `${VEGETATION_AUTHORED_ROUTE}${suffix}` }));
    assert.equal(state.statusCode, 404, JSON.stringify(suffix));
    assert.equal(state.body, null);
  }
});

test('requires a loopback client socket and a loopback Host header', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = createVegetationAuthoredMiddleware(packageRoot);
  const url = `${VEGETATION_AUTHORED_ROUTE}pack-index.json`;

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
  const middleware = createVegetationAuthoredMiddleware(packageRoot);
  for (const header of ['x-forwarded-for', 'x-forwarded-host', 'X-Forwarded-Proto']) {
    const state = await call(middleware, request({
      url: `${VEGETATION_AUTHORED_ROUTE}pack-index.json`,
      headers: { [header]: 'tarkovzero.example' },
    }));
    assert.equal(state.statusCode, 403, header);
  }
});

test('delegates every request outside the fixed route, including the other local route', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = createVegetationAuthoredMiddleware(packageRoot);
  for (const url of [
    '/',
    '/index.html',
    '/data/customs-3d.json',
    '/@vegetation-authored',
    '/@local-game-derived/customs/manifest.json',
    '/@fs/etc/passwd',
  ]) {
    const { state, res, next } = recorder();
    await middleware(request({ url }), res, next);
    assert.equal(state.nextCalls, 1, url);
    assert.equal(state.ended, false, url);
  }
});

test('ignores query strings and fragments when resolving the file', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = createVegetationAuthoredMiddleware(packageRoot);
  for (const url of [
    `${VEGETATION_AUTHORED_ROUTE}pack-index.json?t=1`,
    `${VEGETATION_AUTHORED_ROUTE}pack-index.json#top`,
  ]) {
    const state = await call(middleware, request({ url }));
    assert.equal(state.statusCode, 200, url);
  }
});

test('reports 404 when the package root does not exist', async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = await call(
    createVegetationAuthoredMiddleware(join(root, 'absent')),
    request({ url: `${VEGETATION_AUTHORED_ROUTE}pack-index.json` }),
  );
  assert.equal(state.statusCode, 404);
});

test('the default package root is anchored to the repository, not the process CWD', () => {
  assert.equal(
    VEGETATION_AUTHORED_ROOT,
    resolve(dirname(fileURLToPath(import.meta.url)), '..', '.local-candidates', VEGETATION_AUTHORED_DIRNAME),
  );
  assert.ok(VEGETATION_AUTHORED_ROOT.endsWith(sep + VEGETATION_AUTHORED_DIRNAME));
});

test('the plugin is serve-only and installs no build or preview hook', () => {
  const plugin = vegetationAuthoredDevPlugin({ root: '/tmp/tz-unused' });
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

test('request resolution reports "not our route" distinctly from a denial', () => {
  const outside = resolveVegetationAuthoredRequest({ method: 'GET', url: '/index.html' });
  assert.deepEqual(outside, { ok: false, status: null, reason: 'route-mismatch' });
  const denied = resolveVegetationAuthoredRequest({
    method: 'GET',
    url: `${VEGETATION_AUTHORED_ROUTE}pack-index.json`,
    headers: { host: 'evil.example' },
    remoteAddress: '127.0.0.1',
  });
  assert.equal(denied.status, 403);
});

test('reuses the shared loopback helpers verbatim from local-game-derived-dev.mjs', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(hostHeaderHostname('LOCALHOST:5173'), 'localhost');
});
