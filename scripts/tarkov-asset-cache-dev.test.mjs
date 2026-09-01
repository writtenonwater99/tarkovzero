import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TARKOV_ASSET_CACHE_ROUTE,
  createTarkovAssetCacheMiddleware,
  resolveTarkovAssetCacheRequest,
} from './lib/tarkov-asset-cache-dev.mjs';

function recorder() {
  const state = { statusCode: 200, headers: new Map(), body: null, nextCalls: 0 };
  return {
    state,
    res: {
      get statusCode() { return state.statusCode; },
      set statusCode(value) { state.statusCode = value; },
      setHeader(name, value) { state.headers.set(name.toLowerCase(), String(value)); },
      end(body) { state.body = body ?? null; },
    },
    next() { state.nextCalls += 1; },
  };
}

async function call(middleware, { method = 'GET', url } = {}) {
  const record = recorder();
  await middleware({ method, url }, record.res, record.next);
  return record.state;
}

test('normalizes only map PNG and SVG paths', () => {
  const png = resolveTarkovAssetCacheRequest({
    method: 'GET',
    url: `${TARKOV_ASSET_CACHE_ROUTE}maps/customs/main/1/2/3.png?t=1`,
  });
  assert.equal(png.ok, true);
  assert.deepEqual(png.segments, ['maps', 'customs', 'main', '1', '2', '3.png']);
  for (const url of [
    '/index.html',
    `${TARKOV_ASSET_CACHE_ROUTE}api/data.png`,
    `${TARKOV_ASSET_CACHE_ROUTE}maps/../secret.png`,
    `${TARKOV_ASSET_CACHE_ROUTE}maps/%2e%2e/secret.png`,
    `${TARKOV_ASSET_CACHE_ROUTE}maps/a%2fb.png`,
    `${TARKOV_ASSET_CACHE_ROUTE}maps/a.json`,
  ]) {
    const result = resolveTarkovAssetCacheRequest({ method: 'GET', url });
    assert.equal(result.ok, false, url);
  }
});

test('serves and caches one fixed-origin response', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tz-tile-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests = [];
  const middleware = createTarkovAssetCacheMiddleware({
    root,
    fetchImpl: async (url) => {
      requests.push(String(url));
      return new Response(Buffer.from([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '3' },
      });
    },
  });
  const url = `${TARKOV_ASSET_CACHE_ROUTE}maps/customs/main/1/2/3.png`;
  const first = await call(middleware, { url });
  assert.equal(first.statusCode, 200);
  assert.deepEqual([...first.body], [1, 2, 3]);
  assert.equal(first.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.deepEqual(requests, ['https://assets.tarkov.dev/maps/customs/main/1/2/3.png']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([...await readFile(join(root, 'maps', 'customs', 'main', '1', '2', '3.png'))], [1, 2, 3]);

  const second = await call(middleware, { method: 'HEAD', url });
  assert.equal(second.statusCode, 200);
  assert.equal(second.body, null);
  assert.equal(second.headers.get('content-length'), '3');
  assert.equal(requests.length, 1);
});

test('concurrent cache misses sharing new parent folders do not crash on mkdir races', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tz-tile-cache-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = createTarkovAssetCacheMiddleware({
    root,
    fetchImpl: async (url) => {
      // Keep all requests in flight long enough for their cache writers to contend on
      // maps/customs/main/5/14, which reproduces the browser's initial tile burst.
      await new Promise((resolve) => setImmediate(resolve));
      const byte = Number(new URL(url).pathname.match(/(\d+)\.png$/)?.[1] ?? 0);
      return new Response(Buffer.from([byte]), { status: 200 });
    },
  });
  const urls = Array.from({ length: 12 }, (_, index) => (
    `${TARKOV_ASSET_CACHE_ROUTE}maps/customs/main/5/14/${index}.png`
  ));
  const results = await Promise.all(urls.map((url) => call(middleware, { url })));
  assert.deepEqual(results.map(({ statusCode }) => statusCode), Array(12).fill(200));
  await new Promise((resolve) => setImmediate(resolve));
  for (let index = 0; index < urls.length; index += 1) {
    assert.deepEqual(
      [...await readFile(join(root, 'maps', 'customs', 'main', '5', '14', `${index}.png`))],
      [index],
    );
  }
});

test('does not read or write through a cache symlink', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'tz-tile-symlink-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'cache');
  const outside = join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, 'stolen.png'), Buffer.from([9]));
  await symlink(outside, join(root, 'maps'));
  let fetches = 0;
  const middleware = createTarkovAssetCacheMiddleware({
    root,
    fetchImpl: async () => {
      fetches += 1;
      return new Response(Buffer.from([4]), { status: 200 });
    },
  });
  const state = await call(middleware, { url: `${TARKOV_ASSET_CACHE_ROUTE}maps/stolen.png` });
  assert.equal(state.statusCode, 200);
  assert.deepEqual([...state.body], [4]);
  assert.equal(fetches, 1);
  assert.deepEqual([...await readFile(join(outside, 'stolen.png'))], [9]);
});

test('delegates outside routes and rejects mutation methods', async () => {
  const middleware = createTarkovAssetCacheMiddleware({
    fetchImpl: () => { throw new Error('must not fetch'); },
  });
  const outside = await call(middleware, { url: '/index.html' });
  assert.equal(outside.nextCalls, 1);
  const post = await call(middleware, {
    method: 'POST',
    url: `${TARKOV_ASSET_CACHE_ROUTE}maps/a.png`,
  });
  assert.equal(post.statusCode, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
});
