import assert from 'node:assert/strict';
import test from 'node:test';

import {
  emptyCustomsAssetManifest,
  normalizeCustomsAssetManifest,
} from '../src/customs-asset-manifest.js';
import {
  applyCustomsAssetPlan,
  createCustomsAssetCache,
  createCustomsAssetLoaderHost,
  loadVerifiedCustomsGlb,
  runCustomsAssetLoadPass,
} from '../src/customs-asset-loader.js';
import {
  createCustomsAssetAttachmentLedger,
  createCustomsAssetRegistry,
  diffCustomsAssetPlan,
  planCustomsAssetFrame,
  resolveProceduralSuppression,
} from '../src/customs-asset-runtime.js';

const BASE = 'https://tarkovzero.example/index.html';
const hex = (seed) => `sha256:${String(seed).padStart(2, '0').repeat(32)}`;

const SOURCE = {
  id: 'authored',
  kind: 'authored',
  title: 'TarkovZero authored geometry',
  holder: 'TarkovZero',
  license: 'CC0-1.0',
  licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
  retrievedAt: '2026-08-30',
};

function assetOf(id) {
  return {
    id,
    kind: 'prototype',
    name: id,
    sourceId: 'authored',
    gltf: { unit: 'metre', upAxis: '+y', forwardAxis: '+z', pivot: 'base-center' },
    bounds: { min: { x: -2, y: 0, z: -2 }, max: { x: 2, y: 4, z: 2 } },
    materialIds: [],
    masks: { floors: ['ground'], interior: false },
    proxies: { picking: { shape: 'box' }, shadow: { mode: 'both' }, collision: { shape: 'box' } },
    lods: [{ level: 0, url: `${id}/lod0.glb`, sha256: hex(id.length), bytes: 1000, triangles: 500, maxDistanceM: 500 }],
  };
}

/** `count` distinct prototypes, one instance each, all in one cell. */
function scene(count, { concurrency = 2 } = {}) {
  const ids = Array.from({ length: count }, (_, index) => `asset-${index}`);
  const base = emptyCustomsAssetManifest({
    scope: { id: 'test-scope', center: { x: 0, z: 0 }, widthM: 400, depthM: 400 },
    budgets: {
      totalBytes: 1024 * 1024,
      totalTriangles: 1_000_000,
      perCellBytes: 1024 * 1024,
      perCellTriangles: 1_000_000,
      maxConcurrentLoads: concurrency,
      drawDistanceM: 300,
    },
  });
  return normalizeCustomsAssetManifest({
    ...base,
    evidence: { sources: [SOURCE], observations: [] },
    delivery: {
      baseUrl: 'assets/3d/customs/authored/',
      materials: [],
      assets: ids.map(assetOf),
      instances: ids.map((id, index) => ({
        id: `${id}-a`,
        assetId: id,
        cellId: 'cell-a',
        stableId: `customs.authored.${id.replace('-', '.')}`,
        featureId: index === 0 ? 'customs.building.shed' : undefined,
        transform: { position: { x: index, y: 0, z: 0 }, rotation: { yawDeg: 0 } },
        floor: 'ground',
      })),
      cells: [{
        id: 'cell-a',
        center: { x: 0, z: 0 },
        widthM: 200,
        depthM: 200,
        minY: -50,
        maxY: 50,
        instanceIds: ids.map((id) => `${id}-a`),
      }],
      replacements: [{
        id: 'retire-shed',
        target: { kind: 'building', featureId: 'customs.building.shed' },
        instanceIds: ['asset-0-a'],
        policy: 'hide-mesh',
      }],
    },
  });
}

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

// ---------------------------------------------------------------------------
// loader host

test('the loader host builds its loaders once, lazily, and disposes them once', async () => {
  let created = 0;
  let disposed = 0;
  const host = createCustomsAssetLoaderHost({
    create() { created++; return { id: created }; },
    dispose() { disposed++; },
  });
  assert.equal(created, 0, 'an empty manifest must not pay for a wasm transcoder');
  assert.equal(host.created, false);

  const [a, b] = await Promise.all([host.acquire(), host.acquire()]);
  assert.equal(created, 1, 'concurrent acquires share one build');
  assert.equal(a, b);
  assert.equal(host.created, true);

  host.dispose();
  host.dispose();
  assert.equal(disposed, 1, 'double disposal must not double-free the KTX2 worker pool');
  assert.equal(host.disposed, true);
  await assert.rejects(host.acquire(), { name: 'AbortError' });
});

test('disposing while the loaders are still building still tears them down', async () => {
  let disposed = 0;
  const gate = deferred();
  const host = createCustomsAssetLoaderHost({
    create: () => gate.promise,
    dispose() { disposed++; },
  });
  const acquired = host.acquire();
  host.dispose();
  gate.resolve({ ktx2: true });
  await assert.rejects(acquired, { name: 'AbortError' });
  assert.equal(disposed, 1, 'the loaders that arrived after teardown must not leak');
});

test('verified GLB loading binds byte length and SHA-256 before parsing', async () => {
  const body = Uint8Array.from([1, 2, 3, 4]);
  const expected = 'ab'.repeat(32);
  const parsed = await loadVerifiedCustomsGlb({
    url: 'https://tarkovzero.example/assets/model.glb',
    request: { bytes: 4, sha256: `sha256:${expected}` },
    fetchImpl: async (_url, options) => {
      assert.equal(options.credentials, 'same-origin');
      return new Response(body, { status: 200, headers: { 'content-length': '4' } });
    },
    digestImpl: async (bytes) => {
      assert.deepEqual([...new Uint8Array(bytes)], [...body]);
      return expected;
    },
    parse: async (bytes, baseUrl) => ({ bytes: bytes.byteLength, baseUrl }),
  });
  assert.deepEqual(parsed, {
    bytes: 4,
    baseUrl: 'https://tarkovzero.example/assets/',
  });
});

test('verified GLB loading rejects HTTP, length, and digest mismatches without parsing', async () => {
  const request = { bytes: 4, sha256: `sha256:${'ab'.repeat(32)}` };
  let parses = 0;
  const parse = () => { parses++; return {}; };
  await assert.rejects(loadVerifiedCustomsGlb({
    url: 'https://tarkovzero.example/missing.glb', request, parse,
    fetchImpl: async () => new Response(null, { status: 404 }),
  }), (error) => error.code === 'ERR_CUSTOMS_ASSET_HTTP');
  await assert.rejects(loadVerifiedCustomsGlb({
    url: 'https://tarkovzero.example/short.glb', request, parse,
    fetchImpl: async () => new Response(Uint8Array.from([1, 2, 3])),
    digestImpl: async () => 'ab'.repeat(32),
  }), /byte length/);
  await assert.rejects(loadVerifiedCustomsGlb({
    url: 'https://tarkovzero.example/wrong.glb', request, parse,
    fetchImpl: async () => new Response(Uint8Array.from([1, 2, 3, 4])),
    digestImpl: async () => 'cd'.repeat(32),
  }), /SHA-256/);
  assert.equal(parses, 0);
});

// ---------------------------------------------------------------------------
// load pass

test('the load pass never exceeds its concurrency limit', async () => {
  const manifest = scene(8);
  const plan = planCustomsAssetFrame({ registry: createCustomsAssetRegistry(manifest), camera: { x: 0, z: 0 } });
  let inFlight = 0;
  let peak = 0;
  const result = await runCustomsAssetLoadPass({
    manifest,
    requests: plan.requests,
    baseHref: BASE,
    concurrency: 3,
    async load(url) {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return url;
    },
  });
  assert.equal(result.loaded.length, 8);
  assert.equal(result.failed.length, 0);
  assert.equal(peak, 3, `peak concurrency was ${peak}`);
});

test('the load pass resolves every URL under the delivery root', async () => {
  const manifest = scene(2);
  const plan = planCustomsAssetFrame({ registry: createCustomsAssetRegistry(manifest), camera: { x: 0, z: 0 } });
  const seen = [];
  await runCustomsAssetLoadPass({
    manifest,
    requests: plan.requests,
    baseHref: BASE,
    load(url) { seen.push(url); return url; },
  });
  assert.deepEqual(seen.sort(), [
    'https://tarkovzero.example/assets/3d/customs/authored/asset-0/lod0.glb',
    'https://tarkovzero.example/assets/3d/customs/authored/asset-1/lod0.glb',
  ]);
});

test('a request that cannot be safely resolved fails without being fetched', async () => {
  const manifest = scene(1);
  let fetched = 0;
  const result = await runCustomsAssetLoadPass({
    manifest,
    requests: [{ url: '../../../secrets.glb', assetId: 'x', bytes: 1, distanceM: 0, instanceIds: ['x'] }],
    baseHref: BASE,
    load() { fetched++; return 'never'; },
  });
  assert.equal(fetched, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].error.code, 'ERR_ASSET_MANIFEST_UNSAFE_URL');
});

test('one failure does not cancel the pass', async () => {
  const manifest = scene(4);
  const plan = planCustomsAssetFrame({ registry: createCustomsAssetRegistry(manifest), camera: { x: 0, z: 0 } });
  const result = await runCustomsAssetLoadPass({
    manifest,
    requests: plan.requests,
    baseHref: BASE,
    concurrency: 2,
    load(url) {
      if (url.includes('asset-1')) throw new Error('HTTP 404');
      return url;
    },
  });
  assert.equal(result.loaded.length, 3);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error.message, /404/);
});

test('an already-aborted signal loads nothing and reports every request as aborted', async () => {
  const manifest = scene(3);
  const plan = planCustomsAssetFrame({ registry: createCustomsAssetRegistry(manifest), camera: { x: 0, z: 0 } });
  const controller = new AbortController();
  controller.abort();
  let fetched = 0;
  const result = await runCustomsAssetLoadPass({
    manifest,
    requests: plan.requests,
    baseHref: BASE,
    signal: controller.signal,
    load() { fetched++; return 'x'; },
  });
  assert.equal(fetched, 0);
  assert.equal(result.abortedEarly, true);
  assert.equal(result.aborted.length, 3);
  assert.equal(result.loaded.length, 0);
});

test('aborting mid-pass stops the queue and reports the remainder as aborted, not failed', async () => {
  const manifest = scene(6);
  const plan = planCustomsAssetFrame({ registry: createCustomsAssetRegistry(manifest), camera: { x: 0, z: 0 } });
  const controller = new AbortController();
  let started = 0;
  const result = await runCustomsAssetLoadPass({
    manifest,
    requests: plan.requests,
    baseHref: BASE,
    concurrency: 1,
    signal: controller.signal,
    async load(url) {
      started++;
      if (started === 2) controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 1));
      return url;
    },
  });
  assert.ok(started < 6, `the queue must stop early, but ${started} requests started`);
  assert.equal(result.failed.length, 0, 'teardown is not a load failure');
  assert.equal(result.loaded.length + result.aborted.length, 6, 'every request gets exactly one outcome');
  assert.ok(result.aborted.length > 0);
});

test('the cache fetches a shared prototype once and does not cache a failure', async () => {
  const manifest = scene(1);
  const cache = createCustomsAssetCache();
  const request = { url: 'asset-0/lod0.glb', assetId: 'asset-0', bytes: 1, distanceM: 0, instanceIds: ['asset-0-a'] };
  let calls = 0;
  const run = (load) => runCustomsAssetLoadPass({ manifest, requests: [request], baseHref: BASE, cache, load });

  await run(() => { calls++; throw new Error('boom'); });
  assert.equal(cache.size, 0, 'a failed fetch must be retryable');

  await run(() => { calls++; return 'gltf'; });
  const second = await run(() => { calls++; return 'gltf'; });
  assert.equal(calls, 2, 'the successful fetch is reused');
  assert.equal(second.loaded[0].value, 'gltf');
});

// ---------------------------------------------------------------------------
// plan application and the suppression gate end to end

test('applying a plan attaches instances and only then suppresses the procedural feature', async () => {
  const manifest = scene(2);
  const registry = createCustomsAssetRegistry(manifest);
  const ledger = createCustomsAssetAttachmentLedger();
  const plan = planCustomsAssetFrame({ registry, camera: { x: 0, z: 0 }, ledger });
  const attached = [];

  assert.deepEqual(
    resolveProceduralSuppression(registry, ledger).retainedFeatureIds,
    ['customs.building.shed'],
    'nothing is attached yet, so the proxy stands',
  );

  const result = await applyCustomsAssetPlan({
    plan,
    manifest,
    ledger,
    baseHref: BASE,
    diff: diffCustomsAssetPlan(null, plan),
    load: (url) => ({ url }),
    attach: (instance, value) => attached.push([instance.instanceId, value.url]),
  });

  assert.equal(result.attached, 2);
  assert.equal(attached.length, 2);
  assert.equal(ledger.stateOf('asset-0-a'), 'attached');
  assert.deepEqual(
    resolveProceduralSuppression(registry, ledger).suppressedFeatureIds,
    ['customs.building.shed'],
  );
});

test('an attach hook that throws is a failure, so the proxy survives', async () => {
  const manifest = scene(1);
  const registry = createCustomsAssetRegistry(manifest);
  const ledger = createCustomsAssetAttachmentLedger();
  const plan = planCustomsAssetFrame({ registry, camera: { x: 0, z: 0 }, ledger });

  const result = await applyCustomsAssetPlan({
    plan,
    manifest,
    ledger,
    baseHref: BASE,
    diff: diffCustomsAssetPlan(null, plan),
    load: () => ({}),
    attach() { throw new Error('scene graph rejected the node'); },
  });

  assert.equal(result.attached, 0);
  assert.equal(ledger.stateOf('asset-0-a'), 'failed');
  assert.match(ledger.errorOf('asset-0-a'), /scene graph/);
  assert.deepEqual(resolveProceduralSuppression(registry, ledger).suppressedFeatureIds, []);
});

test('a download failure leaves the procedural feature in place', async () => {
  const manifest = scene(1);
  const registry = createCustomsAssetRegistry(manifest);
  const ledger = createCustomsAssetAttachmentLedger();
  const plan = planCustomsAssetFrame({ registry, camera: { x: 0, z: 0 }, ledger });

  await applyCustomsAssetPlan({
    plan,
    manifest,
    ledger,
    baseHref: BASE,
    diff: diffCustomsAssetPlan(null, plan),
    load() { throw new Error('HTTP 500'); },
    attach() { throw new Error('must not be called'); },
  });

  assert.equal(ledger.stateOf('asset-0-a'), 'failed');
  const state = resolveProceduralSuppression(registry, ledger);
  assert.deepEqual(state.suppressedFeatureIds, []);
  assert.match(state.reasons.get('customs.building.shed'), /failed to load/);
});

test('leaving instances are detached and un-suppress their feature', async () => {
  const manifest = scene(1);
  const registry = createCustomsAssetRegistry(manifest);
  const ledger = createCustomsAssetAttachmentLedger();
  const near = planCustomsAssetFrame({ registry, camera: { x: 0, z: 0 }, ledger });
  await applyCustomsAssetPlan({
    plan: near,
    manifest,
    ledger,
    baseHref: BASE,
    diff: diffCustomsAssetPlan(null, near),
    load: () => ({}),
    attach: () => {},
  });
  assert.deepEqual(resolveProceduralSuppression(registry, ledger).suppressedFeatureIds, ['customs.building.shed']);

  const away = planCustomsAssetFrame({ registry, camera: { x: 0, z: 5000 }, previous: near, ledger });
  const detached = [];
  const result = await applyCustomsAssetPlan({
    plan: away,
    manifest,
    ledger,
    baseHref: BASE,
    diff: diffCustomsAssetPlan(near, away),
    load: () => ({}),
    attach: () => {},
    detach: (instance) => detached.push(instance.instanceId),
  });
  assert.deepEqual(detached, ['asset-0-a']);
  assert.equal(result.detached, 1);
  assert.deepEqual(resolveProceduralSuppression(registry, ledger).suppressedFeatureIds, []);
});

test('a loader host that cannot build fails every instance rather than attaching blind', async () => {
  const manifest = scene(2);
  const registry = createCustomsAssetRegistry(manifest);
  const ledger = createCustomsAssetAttachmentLedger();
  const plan = planCustomsAssetFrame({ registry, camera: { x: 0, z: 0 }, ledger });
  const host = createCustomsAssetLoaderHost({ create() { throw new Error('no WebGL2'); } });

  const result = await applyCustomsAssetPlan({
    plan,
    manifest,
    ledger,
    baseHref: BASE,
    diff: diffCustomsAssetPlan(null, plan),
    loaderHost: host,
    load() { throw new Error('must not be called'); },
    attach() { throw new Error('must not be called'); },
  });

  assert.equal(result.attached, 0);
  assert.match(result.error.message, /no WebGL2/);
  assert.equal(ledger.stateOf('asset-0-a'), 'failed');
  assert.deepEqual(resolveProceduralSuppression(registry, ledger).suppressedFeatureIds, []);
});

test('an empty plan does nothing and never touches the loader host', async () => {
  const manifest = normalizeCustomsAssetManifest(emptyCustomsAssetManifest());
  const registry = createCustomsAssetRegistry(manifest);
  const ledger = createCustomsAssetAttachmentLedger();
  const plan = planCustomsAssetFrame({ registry, camera: { x: 0, z: 0 }, ledger });
  let created = 0;
  const host = createCustomsAssetLoaderHost({ create() { created++; return {}; } });

  const result = await applyCustomsAssetPlan({
    plan,
    manifest,
    ledger,
    baseHref: BASE,
    diff: diffCustomsAssetPlan(null, plan),
    loaderHost: host,
    load() { throw new Error('must not be called'); },
    attach() { throw new Error('must not be called'); },
  });

  assert.deepEqual(result, { loaded: [], failed: [], aborted: [], attached: 0, detached: 0 });
  assert.equal(created, 0);
});

test('a re-LOD re-attaches the instance at the new level', async () => {
  const manifest = scene(1);
  const registry = createCustomsAssetRegistry(manifest);
  const ledger = createCustomsAssetAttachmentLedger();
  const plan = planCustomsAssetFrame({ registry, camera: { x: 0, z: 0 }, ledger });
  const cache = createCustomsAssetCache();
  let loads = 0;
  const attachments = [];

  for (const pass of [0, 1]) {
    await applyCustomsAssetPlan({
      plan,
      manifest,
      ledger,
      baseHref: BASE,
      cache,
      // Pass 1 simulates the instance re-entering the plan at the same URL.
      diff: { enter: pass === 0 ? plan.instances : [], relod: pass === 0 ? [] : plan.instances, leave: [] },
      load() { loads++; return { url: 'x' }; },
      attach: (instance) => attachments.push(instance.instanceId),
    });
  }

  assert.equal(loads, 1, 'the cache spares the network on a re-LOD to a level already held');
  assert.equal(attachments.length, 2);
  assert.equal(ledger.stateOf('asset-0-a'), 'attached');
});
