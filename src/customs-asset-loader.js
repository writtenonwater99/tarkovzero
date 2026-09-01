// Loading seam for authored Customs assets.
//
// This module owns the parts of streaming that are easy to get wrong and hard to see: how many
// requests are in flight, what happens to the ones queued behind an abort, and whether the
// three.js loader trio (GLTF + KTX2 transcoder + Meshopt decoder) is built once or per request.
// The KTX2 transcoder in particular spins up a worker pool and compiles a wasm module; building
// one per chunk — which the v1 code did, once per manifest load — is both slow and a leak if the
// view is torn down mid-flight.
//
// Everything here takes its actual loading function by injection. In the browser that is a real
// GLTFLoader; in the Node tests it is a function that resolves a token. That is the whole reason
// the concurrency, abort and dedupe behaviour is testable at all without a GPU.

import { resolveCustomsAssetUrl } from './customs-asset-manifest.js';

export class CustomsAssetLoadAbort extends Error {
  constructor(message = 'aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

export class CustomsAssetIntegrityError extends Error {
  constructor(message, code = 'ERR_CUSTOMS_ASSET_INTEGRITY') {
    super(message);
    this.name = 'CustomsAssetIntegrityError';
    this.code = code;
  }
}

function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new CustomsAssetLoadAbort();
}

async function browserSha256(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new CustomsAssetIntegrityError('Web Crypto SHA-256 is unavailable');
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

/**
 * Fetch one self-contained GLB, bind the declared byte count and SHA-256 to
 * the bytes actually parsed, then hand the verified ArrayBuffer to GLTFLoader.
 * A mismatch fails closed, so its procedural proxy remains visible.
 */
export async function loadVerifiedCustomsGlb({
  url,
  request,
  signal = null,
  fetchImpl = globalThis.fetch,
  digestImpl = browserSha256,
  parse,
  onTiming = null,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new CustomsAssetIntegrityError('fetch is unavailable');
  if (typeof parse !== 'function') throw new CustomsAssetIntegrityError('verified GLB loading requires parse()');
  if (!request || !Number.isSafeInteger(request.bytes) || request.bytes <= 0) {
    throw new CustomsAssetIntegrityError('asset request has no valid byte receipt');
  }
  if (typeof request.sha256 !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(request.sha256)) {
    throw new CustomsAssetIntegrityError('asset request has no valid SHA-256 receipt');
  }
  // One optional stopwatch, three phases. It exists because "the mount takes 71.5 s" is not a
  // diagnosis: fetch, SHA-256 and GLTF parse are three different fixes, and a prior pass in this
  // project was spent optimising the wrong one from a guess. `now()` falls back to Date so the
  // Node tests (which pass no `onTiming` anyway) never depend on `performance`.
  const now = () => (globalThis.performance ?? Date).now();
  const startedAt = onTiming ? now() : 0;
  const response = await fetchImpl(url, { signal, credentials: 'same-origin' });
  if (!response?.ok) {
    throw new CustomsAssetIntegrityError(`GLB HTTP ${response?.status ?? 'failure'}`, 'ERR_CUSTOMS_ASSET_HTTP');
  }
  const contentLengthHeader = response.headers?.get?.('content-length');
  const declaredLength = contentLengthHeader == null || contentLengthHeader === ''
    ? null
    : Number(contentLengthHeader);
  if (declaredLength !== null && Number.isFinite(declaredLength) && declaredLength !== request.bytes) {
    throw new CustomsAssetIntegrityError(
      `GLB content-length ${declaredLength} does not match manifest ${request.bytes}`,
    );
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== request.bytes) {
    throw new CustomsAssetIntegrityError(
      `GLB byte length ${bytes.byteLength} does not match manifest ${request.bytes}`,
    );
  }
  const fetchedAt = onTiming ? now() : 0;
  const digest = await digestImpl(bytes);
  if (`sha256:${digest}` !== request.sha256) {
    throw new CustomsAssetIntegrityError('GLB SHA-256 does not match manifest receipt');
  }
  const hashedAt = onTiming ? now() : 0;
  const value = await parse(bytes, new URL('.', url).href);
  if (onTiming) {
    onTiming({
      url,
      bytes: bytes.byteLength,
      fetchMs: fetchedAt - startedAt,
      hashMs: hashedAt - fetchedAt,
      parseMs: now() - hashedAt,
    });
  }
  return value;
}

/**
 * Long-lived loader host. `create` is called at most once, lazily, and only if something is
 * actually going to be fetched — an empty manifest must not pay for a wasm transcoder. `dispose`
 * runs exactly once and makes every later `acquire()` reject, so a load pass that outlives its
 * view cannot resurrect the pool.
 */
export function createCustomsAssetLoaderHost({ create, dispose = () => {} }) {
  if (typeof create !== 'function') throw new Error('loader host requires a create() function');
  let pending = null;
  let created = null;
  let disposed = false;
  return {
    get disposed() { return disposed; },
    get created() { return created !== null; },
    async acquire() {
      if (disposed) throw new CustomsAssetLoadAbort('loader host disposed');
      if (!pending) {
        pending = Promise.resolve().then(() => create()).then((value) => {
          created = value;
          // Disposal that lands while create() was in flight still has to be honoured.
          if (disposed) {
            try { dispose(value); } catch { /* teardown is best effort */ }
            throw new CustomsAssetLoadAbort('loader host disposed');
          }
          return value;
        });
      }
      return pending;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const value = created;
      created = null;
      pending = null;
      if (value !== null) {
        try { dispose(value); } catch { /* teardown is best effort */ }
      }
    },
  };
}

/**
 * Cache of decoded assets keyed by resolved URL, so a prototype placed forty times is fetched
 * once. In-flight promises are cached too — forty instances entering on the same frame must not
 * open forty sockets.
 */
export function createCustomsAssetCache() {
  const entries = new Map();
  return {
    get size() { return entries.size; },
    has(url) { return entries.has(url); },
    get(url) { return entries.get(url) ?? null; },
    set(url, promise) { entries.set(url, promise); return promise; },
    delete(url) { return entries.delete(url); },
    clear() { entries.clear(); },
  };
}

/**
 * Run one bounded-concurrency load pass over a plan's requests.
 *
 * Contract:
 *   * never more than `concurrency` calls to `load` outstanding;
 *   * an aborted signal stops the queue immediately — queued requests are reported as `aborted`
 *     rather than silently dropped, and in-flight rejections are not reported as load failures;
 *   * one failure does not cancel the pass. Every request gets an outcome, because a partially
 *     loaded scene is the normal case and the ledger needs to know exactly which instances are
 *     safe to suppress a proxy for;
 *   * `onLoaded` / `onFailed` run per request so the caller can attach as results arrive rather
 *     than waiting for the whole pass.
 */
export async function runCustomsAssetLoadPass({
  manifest,
  requests,
  baseHref,
  load,
  concurrency = 4,
  signal = null,
  cache = null,
  onLoaded = null,
  onFailed = null,
} = {}) {
  if (typeof load !== 'function') throw new Error('runCustomsAssetLoadPass requires a load() function');
  const limit = Math.max(1, Math.trunc(concurrency));
  const queue = [...(requests ?? [])];
  const loaded = [];
  const failed = [];
  const aborted = [];

  if (signal?.aborted) {
    return { loaded, failed, aborted: queue.slice(), abortedEarly: true };
  }

  let index = 0;
  let stopped = false;

  async function worker() {
    while (!stopped) {
      if (signal?.aborted) { stopped = true; break; }
      const current = index++;
      if (current >= queue.length) break;
      const request = queue[current];
      let resolvedUrl;
      try {
        resolvedUrl = resolveCustomsAssetUrl(manifest, request.url, baseHref);
      } catch (error) {
        failed.push({ request, error });
        onFailed?.(request, error);
        continue;
      }
      try {
        let promise = cache?.get(resolvedUrl) ?? null;
        if (!promise) {
          promise = Promise.resolve().then(() => load(resolvedUrl, { request, signal }));
          cache?.set(resolvedUrl, promise);
        }
        const value = await promise;
        if (signal?.aborted) { stopped = true; aborted.push(request); break; }
        loaded.push({ request, resolvedUrl, value });
        onLoaded?.(request, value, resolvedUrl);
      } catch (error) {
        // A failed fetch must not poison the cache: the next pass should be allowed to retry.
        cache?.delete(resolvedUrl);
        if (signal?.aborted) { stopped = true; aborted.push(request); break; }
        failed.push({ request, error });
        onFailed?.(request, error);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, () => worker()));

  // Anything the workers never reached because of an abort is an explicit outcome, not a silence.
  if (signal?.aborted) {
    const reported = new Set([...loaded, ...failed].map((entry) => entry.request));
    for (const entry of aborted) reported.add(entry);
    const remaining = queue.filter((request) => !reported.has(request));
    aborted.push(...remaining);
  }

  return { loaded, failed, aborted, abortedEarly: false };
}

/**
 * Drive a plan: mark every instance in `enter`/`relod` as loading, run the pass, and move each
 * instance to `attached` or `failed` in the ledger. `attach` is the renderer's hook and may
 * throw — an attach that throws is a failure, not a silent success, or the proxy would be
 * suppressed under geometry that never made it into the scene.
 */
export async function applyCustomsAssetPlan({
  plan,
  manifest,
  ledger,
  baseHref,
  load,
  attach,
  detach = null,
  diff = null,
  cache = null,
  signal = null,
  loaderHost = null,
}) {
  const entering = diff ? [...diff.enter, ...diff.relod] : plan.instances;
  const leaving = diff?.leave ?? [];
  for (const instance of leaving) {
    try { detach?.(instance); } finally { ledger.markDetached(instance.instanceId); }
  }
  if (entering.length === 0) return { loaded: [], failed: [], aborted: [], attached: 0, detached: leaving.length };

  const wanted = new Set(entering.map((instance) => instance.url));
  const requests = plan.requests.filter((request) => wanted.has(request.url));
  const byUrl = new Map();
  for (const instance of entering) {
    const bucket = byUrl.get(instance.url);
    if (bucket) bucket.push(instance);
    else byUrl.set(instance.url, [instance]);
  }
  for (const instance of entering) ledger.markLoading(instance.instanceId);

  if (loaderHost) {
    try {
      await loaderHost.acquire();
    } catch (error) {
      for (const instance of entering) ledger.markFailed(instance.instanceId, error);
      return { loaded: [], failed: [], aborted: requests, attached: 0, detached: leaving.length, error };
    }
  }

  let attached = 0;
  const result = await runCustomsAssetLoadPass({
    manifest,
    requests,
    baseHref,
    load,
    concurrency: plan.maxConcurrentLoads,
    signal,
    cache,
    onLoaded(request, value) {
      for (const instance of byUrl.get(request.url) ?? []) {
        try {
          attach(instance, value);
          ledger.markAttached(instance.instanceId);
          attached++;
        } catch (error) {
          ledger.markFailed(instance.instanceId, error);
        }
      }
    },
    onFailed(request, error) {
      for (const instance of byUrl.get(request.url) ?? []) {
        ledger.markFailed(instance.instanceId, error);
      }
    },
  });

  // Aborted requests are not failures — the view is going away, and marking them failed would
  // make a torn-down view look like a broken one in the status panel.
  for (const request of result.aborted) {
    for (const instance of byUrl.get(request.url) ?? []) ledger.markDetached(instance.instanceId);
  }

  return { ...result, attached, detached: leaving.length };
}

/**
 * Build the real three.js trio. Kept here, behind injection, so map3d-three.js does not grow a
 * second copy of the transcoder-path knowledge and the tests never import three.
 */
export function createThreeLoaderFactory({ renderer, transcoderPath = '/assets/3d/vendor/basis/' }) {
  return {
    async create() {
      const [{ GLTFLoader }, { KTX2Loader }, { MeshoptDecoder }] = await Promise.all([
        import('three/addons/loaders/GLTFLoader.js'),
        import('three/addons/loaders/KTX2Loader.js'),
        import('three/addons/libs/meshopt_decoder.module.js'),
      ]);
      const ktx2 = new KTX2Loader().setTranscoderPath(transcoderPath).detectSupport(renderer);
      const gltf = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
      return { gltf, ktx2 };
    },
    dispose(loaders) {
      loaders?.ktx2?.dispose?.();
    },
  };
}
