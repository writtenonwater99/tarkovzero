// Guarantees of the /@vegetation-arraytex/ dev route.
//
// Mirrors `vegetation-authored-dev.test.mjs` case for case, because the route mirrors that
// route's guarantees case for case: method, loopback socket AND loopback Host, X-Forwarded-*
// refusal, per-segment percent-decoding, traversal/NUL rejection, realpath containment,
// regular-files-only, no directory listing, an extension allowlist, and — the part an
// allowlist alone does not buy — authorization against `veg-layers.json`'s own declared blob
// table, so a `.bin` sitting in the directory that the index does not name stays unreachable.
//
// The last test is the one this whole suite exists for: the plugin must be REGISTERED. An
// unregistered `/@…` prefix does not 404; Vite answers the SPA fallback with HTTP 200 and
// index.html, which is why the 199 -> 3 material collapse silently never ran.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VEGETATION_ARRAYTEX_DIRNAME,
  VEGETATION_ARRAYTEX_ROOT,
  VEGETATION_ARRAYTEX_ROUTE,
  collectAuthorizedVegetationArrayPaths,
  createVegetationArraytexMiddleware,
  resolveVegetationArraytexRequest,
  vegetationArraytexDevPlugin,
} from './lib/vegetation-arraytex-dev.mjs';
import { hostHeaderHostname, isLoopbackAddress } from './lib/local-game-derived-dev.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SLOTS = ['basecolor', 'orm', 'normal'];
const BLOB_FILES = [0, 1, 2].flatMap((lod) => SLOTS.map((slot) => `veg-l${lod}-${slot}.bin`));

const INDEX_VALUE = {
  schemaVersion: 1,
  documentType: 'tarkovzero-customs-vegetation-texture-array-index',
  map: 'customs',
  arrays: [0, 1, 2].map((lod) => ({
    lod,
    blobs: Object.fromEntries(SLOTS.map((slot) => [slot, {
      file: `veg-l${lod}-${slot}.bin`,
      bytes: 4,
      sha256: `sha256:${String(lod).repeat(64)}`,
    }])),
  })),
};
const INDEX = JSON.stringify(INDEX_VALUE);
const INDEX_RECEIPT = JSON.stringify({ sha256: `sha256:${'d'.repeat(64)}` });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tz-vegetation-arraytex-'));
  const packageRoot = join(root, VEGETATION_ARRAYTEX_DIRNAME);
  await mkdir(join(packageRoot, 'logs'), { recursive: true });
  await writeFile(join(packageRoot, 'veg-layers.json'), INDEX);
  await writeFile(join(packageRoot, 'veg-layers.receipt.json'), INDEX_RECEIPT);
  for (const file of BLOB_FILES) {
    await writeFile(join(packageRoot, file), Buffer.from([1, 2, 3, 4]));
  }
  // Present on disk, correct extension, plausible name — but never named by veg-layers.json.
  await writeFile(join(packageRoot, 'veg-l3-basecolor.bin'), Buffer.from([9]));
  await writeFile(join(packageRoot, 'scratch.bin'), Buffer.from([9]));
  await writeFile(join(packageRoot, 'build-report.json'), '{"generator":"factory"}');
  await writeFile(join(packageRoot, 'logs', 'run.log'), 'log line');
  await writeFile(join(root, 'outside-secret.bin'), Buffer.from([0xee]));
  await symlink(join(root, 'outside-secret.bin'), join(packageRoot, 'veg-l0-basecolor-link.bin'));
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

test('serves every declared blob and both index files with correct headers', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = createVegetationArraytexMiddleware(packageRoot);

  for (const file of BLOB_FILES) {
    const blob = await call(middleware, request({ url: `${VEGETATION_ARRAYTEX_ROUTE}${file}` }));
    assert.equal(blob.statusCode, 200, file);
    assert.deepEqual([...blob.body], [1, 2, 3, 4], file);
    assert.equal(blob.headers.get('content-type'), 'application/octet-stream', file);
    assert.equal(blob.headers.get('content-length'), '4', file);
    // The blob's bytes are sha256-receipted in the index and the LOADER verifies that digest
    // before building a texture, which is what makes `immutable` a claim and not a hope.
    assert.equal(blob.headers.get('cache-control'), 'public, max-age=31536000, immutable', file);
    assert.equal(blob.headers.get('x-content-type-options'), 'nosniff', file);
    assert.equal(blob.headers.get('cross-origin-resource-policy'), 'same-origin', file);
  }

  const index = await call(middleware, request({ url: `${VEGETATION_ARRAYTEX_ROUTE}veg-layers.json` }));
  assert.equal(index.statusCode, 200);
  assert.equal(index.body.toString('utf8'), INDEX);
  // The content type is what the runtime uses to tell "the route served me the index" from
  // "no route exists and Vite handed me index.html with a 200".
  assert.equal(index.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(index.headers.get('cache-control'), 'no-store');

  const receipt = await call(middleware, request({ url: `${VEGETATION_ARRAYTEX_ROUTE}veg-layers.receipt.json` }));
  assert.equal(receipt.statusCode, 200);
  assert.equal(receipt.body.toString('utf8'), INDEX_RECEIPT);
  assert.equal(receipt.headers.get('cache-control'), 'no-store');
});

test("serves only files authorized by veg-layers.json's own arrays[].blobs[].file table", async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = createVegetationArraytexMiddleware(packageRoot);

  for (const file of ['veg-l3-basecolor.bin', 'scratch.bin', 'build-report.json', 'logs/run.log']) {
    const state = await call(middleware, request({ url: `${VEGETATION_ARRAYTEX_ROUTE}${file}` }));
    assert.equal(state.statusCode, 404, file);
  }

  const authorized = collectAuthorizedVegetationArrayPaths(INDEX_VALUE);
  assert.deepEqual([...authorized].sort(), [...BLOB_FILES, 'veg-layers.json', 'veg-layers.receipt.json'].sort());
});

test('a blob name the loader contract would refuse is never authorized, even from the index', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  // The index is the authorization document, so it is also the attack surface: a traversal-shaped
  // `file` value must be rejected by SAFE_BLOB_FILE before it can ever reach the filesystem.
  const hostile = structuredClone(INDEX_VALUE);
  hostile.arrays[0].blobs.basecolor.file = '../outside-secret.bin';
  hostile.arrays[1].blobs.orm.file = 'veg-l1-orm.bin.bak';
  const authorized = collectAuthorizedVegetationArrayPaths(hostile);
  assert.equal(authorized.has('../outside-secret.bin'), false);
  assert.equal(authorized.has('veg-l1-orm.bin.bak'), false);
  assert.equal(authorized.has('veg-l0-normal.bin'), true);

  await writeFile(join(packageRoot, 'veg-layers.json'), JSON.stringify(hostile));
  const middleware = createVegetationArraytexMiddleware(packageRoot);
  const escaped = await call(middleware, request({ url: `${VEGETATION_ARRAYTEX_ROUTE}../outside-secret.bin` }));
  assert.equal(escaped.statusCode, 400);
  const dropped = await call(middleware, request({ url: `${VEGETATION_ARRAYTEX_ROUTE}veg-l0-basecolor.bin` }));
  assert.equal(dropped.statusCode, 404, 'the entry the hostile index replaced is no longer authorized');
});

test('an invalid veg-layers.json fails closed for every request, including itself', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(packageRoot, 'veg-layers.json'), '{not json');
  const middleware = createVegetationArraytexMiddleware(packageRoot);
  for (const file of ['veg-layers.json', 'veg-layers.receipt.json', 'veg-l0-basecolor.bin']) {
    const state = await call(middleware, request({ url: `${VEGETATION_ARRAYTEX_ROUTE}${file}` }));
    assert.equal(state.statusCode, 404, file);
  }
});

test('HEAD returns headers without a body', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = await call(
    createVegetationArraytexMiddleware(packageRoot),
    request({ method: 'HEAD', url: `${VEGETATION_ARRAYTEX_ROUTE}veg-l0-basecolor.bin` }),
  );
  assert.equal(state.statusCode, 200);
  assert.equal(state.body, null);
  assert.equal(state.headers.get('content-length'), '4');
});

test('rejects every method other than GET and HEAD with an Allow header', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = createVegetationArraytexMiddleware(packageRoot);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'TRACE']) {
    const state = await call(middleware, request({
      method,
      url: `${VEGETATION_ARRAYTEX_ROUTE}veg-layers.json`,
    }));
    assert.equal(state.statusCode, 405, method);
    assert.equal(state.headers.get('allow'), 'GET, HEAD');
    assert.equal(state.body, null);
  }
});

test('refuses traversal, encoded traversal, encoded separators, and NUL bytes', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = createVegetationArraytexMiddleware(packageRoot);
  for (const suffix of [
    '../outside-secret.bin',
    'logs/../../outside-secret.bin',
    '%2e%2e/outside-secret.bin',
    '%2E%2E%2Foutside-secret.bin',
    'logs%2f..%2f..%2foutside-secret.bin',
    'veg-layers.json%00.bin',
    '..%5Coutside-secret.bin',
  ]) {
    const state = await call(middleware, request({ url: `${VEGETATION_ARRAYTEX_ROUTE}${suffix}` }));
    assert.equal(state.statusCode, 400, suffix);
    assert.equal(state.body, null);
  }
});

test('refuses a malformed percent escape', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = await call(
    createVegetationArraytexMiddleware(packageRoot),
    request({ url: `${VEGETATION_ARRAYTEX_ROUTE}%zz.bin` }),
  );
  assert.equal(state.statusCode, 400);
});

test('refuses to follow a symlink that escapes the package root', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  // Prove realpath containment independently of manifest authorization: point an AUTHORIZED
  // name at a file outside the root and confirm it is still refused.
  await rm(join(packageRoot, 'veg-l0-orm.bin'));
  await symlink(join(root, 'outside-secret.bin'), join(packageRoot, 'veg-l0-orm.bin'));
  const middleware = createVegetationArraytexMiddleware(packageRoot);
  const authorizedButEscaping = await call(middleware, request({
    url: `${VEGETATION_ARRAYTEX_ROUTE}veg-l0-orm.bin`,
  }));
  assert.equal(authorizedButEscaping.statusCode, 404);
  assert.equal(authorizedButEscaping.body, null);
  const unauthorizedLink = await call(middleware, request({
    url: `${VEGETATION_ARRAYTEX_ROUTE}veg-l0-basecolor-link.bin`,
  }));
  assert.equal(unauthorizedLink.statusCode, 404);
});

test('never lists a directory and never serves an unlisted suffix', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = createVegetationArraytexMiddleware(packageRoot);
  for (const suffix of ['', 'logs', 'logs/', 'veg-layers', 'veg-l0-basecolor', 'veg-l0-basecolor.bin/']) {
    const state = await call(middleware, request({ url: `${VEGETATION_ARRAYTEX_ROUTE}${suffix}` }));
    assert.equal(state.statusCode, 404, JSON.stringify(suffix));
    assert.equal(state.body, null);
  }
});

test('requires a loopback client socket and a loopback Host header', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = createVegetationArraytexMiddleware(packageRoot);
  const url = `${VEGETATION_ARRAYTEX_ROUTE}veg-layers.json`;

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
  const middleware = createVegetationArraytexMiddleware(packageRoot);
  for (const header of ['x-forwarded-for', 'x-forwarded-host', 'X-Forwarded-Proto']) {
    const state = await call(middleware, request({
      url: `${VEGETATION_ARRAYTEX_ROUTE}veg-layers.json`,
      headers: { [header]: 'tarkovzero.example' },
    }));
    assert.equal(state.statusCode, 403, header);
  }
});

test('delegates every request outside the fixed route, including the two sibling routes', async (t) => {
  const { root, packageRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = createVegetationArraytexMiddleware(packageRoot);
  for (const url of [
    '/',
    '/index.html',
    '/data/customs-3d.json',
    '/@vegetation-arraytex',
    '/@vegetation-authored/pack-index.json',
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
  const middleware = createVegetationArraytexMiddleware(packageRoot);
  for (const url of [
    `${VEGETATION_ARRAYTEX_ROUTE}veg-layers.json?t=1`,
    `${VEGETATION_ARRAYTEX_ROUTE}veg-layers.json#top`,
  ]) {
    const state = await call(middleware, request({ url }));
    assert.equal(state.statusCode, 200, url);
  }
});

test('reports 404 when the package root does not exist', async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = await call(
    createVegetationArraytexMiddleware(join(root, 'absent')),
    request({ url: `${VEGETATION_ARRAYTEX_ROUTE}veg-layers.json` }),
  );
  assert.equal(state.statusCode, 404);
});

test('the default package root is anchored to the repository, not the process CWD', () => {
  assert.equal(
    VEGETATION_ARRAYTEX_ROOT,
    resolve(HERE, '..', '.local-candidates', VEGETATION_ARRAYTEX_DIRNAME),
  );
  assert.ok(VEGETATION_ARRAYTEX_ROOT.endsWith(sep + VEGETATION_ARRAYTEX_DIRNAME));
});

test('the plugin is serve-only and installs no build or preview hook', () => {
  const plugin = vegetationArraytexDevPlugin({ root: '/tmp/tz-unused' });
  assert.equal(plugin.apply, 'serve');
  assert.equal(plugin.name, 'tarkovzero-vegetation-arraytex');
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
  const outside = resolveVegetationArraytexRequest({ method: 'GET', url: '/index.html' });
  assert.deepEqual(outside, { ok: false, status: null, reason: 'route-mismatch' });
  const denied = resolveVegetationArraytexRequest({
    method: 'GET',
    url: `${VEGETATION_ARRAYTEX_ROUTE}veg-layers.json`,
    headers: { host: 'evil.example' },
    remoteAddress: '127.0.0.1',
  });
  assert.equal(denied.status, 403);
});

test('reuses the shared loopback helpers verbatim from local-game-derived-dev.mjs', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(hostHeaderHostname('LOCALHOST:5173'), 'localhost');
});

// ── the regression this suite exists for ─────────────────────────────────────────────────────

test('vite.config.js registers the arraytex plugin, and the runtime agrees on the prefix', async () => {
  const config = await readFile(join(HERE, '..', 'vite.config.js'), 'utf8');
  assert.match(
    config,
    /vegetationArraytexDevPlugin\s*\(\s*\)/u,
    'the /@vegetation-arraytex/ route has no server: Vite answers the SPA fallback with HTTP 200'
    + ' and index.html, response.ok is true, and the texture arrays silently never load',
  );
  assert.match(config, /from '\.\/scripts\/lib\/vegetation-arraytex-dev\.mjs'/u);

  // The route constant is duplicated on purpose (the runtime must not import a Node-only dev
  // module), so pin the two halves to each other.
  const runtime = await readFile(join(HERE, '..', 'src', 'map3d-three.js'), 'utf8');
  assert.match(
    runtime,
    new RegExp(`CUSTOMS_VEGETATION_ARRAY_ROUTE\\s*=\\s*'${VEGETATION_ARRAYTEX_ROUTE}'`, 'u'),
    'the runtime fetch prefix drifted from the route the plugin serves',
  );
});
