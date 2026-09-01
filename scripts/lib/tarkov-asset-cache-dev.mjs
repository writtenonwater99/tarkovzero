// Safe localhost cache for public tarkov.dev map tiles and SVGs.
//
// Requests are normalized before they touch either the filesystem or the
// fixed upstream. Cache reads/writes refuse symlinks, traversal, directories,
// unknown media, oversized responses, and non-GET methods.

import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TARKOV_ASSET_CACHE_ROOT = resolve(REPOSITORY_ROOT, '.cache', 'tarkov-assets');
export const TARKOV_ASSET_CACHE_ROUTE = '/tiles/';
const UPSTREAM_ORIGIN = 'https://assets.tarkov.dev';
const MAX_PATH_LENGTH = 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const CONTENT_TYPES = new Map([
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
]);

function deny(status, reason, extra = {}) {
  return { ok: false, status, reason, ...extra };
}

function decodeSegment(raw) {
  let value;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (
    value.length === 0
    || value === '.'
    || value === '..'
    || value.includes('/')
    || value.includes('\\')
    || value.includes('\0')
    || value.startsWith(' ')
    || value.endsWith(' ')
  ) return null;
  return value;
}

export function resolveTarkovAssetCacheRequest({ method, url } = {}) {
  const target = typeof url === 'string' ? url : '';
  const pathname = target.split('?')[0].split('#')[0];
  if (!pathname.startsWith(TARKOV_ASSET_CACHE_ROUTE)) {
    return { ok: false, status: null, reason: 'route-mismatch' };
  }
  if (method !== 'GET' && method !== 'HEAD') {
    return deny(405, 'method-not-allowed', { allow: 'GET, HEAD' });
  }
  if (pathname.length > MAX_PATH_LENGTH) return deny(414, 'path-too-long');
  const rawSegments = pathname.slice(TARKOV_ASSET_CACHE_ROUTE.length).split('/');
  if (rawSegments.length < 2 || rawSegments.length > 32) return deny(404, 'not-found');
  const segments = [];
  for (const raw of rawSegments) {
    const value = decodeSegment(raw);
    if (value === null) return deny(400, 'unsafe-path');
    segments.push(value);
  }
  if (segments[0] !== 'maps') return deny(404, 'not-found');
  const contentType = CONTENT_TYPES.get(extname(segments.at(-1)).toLowerCase());
  if (!contentType) return deny(404, 'not-found');
  return { ok: true, segments, contentType };
}

function contained(root, target) {
  return target === root || target.startsWith(root + sep);
}

async function existingCacheFile(root, segments) {
  let realRoot;
  try {
    realRoot = await realpath(root);
  } catch {
    return null;
  }
  let target;
  try {
    target = await realpath(join(realRoot, ...segments));
    const entry = await lstat(target);
    if (!contained(realRoot, target) || !entry.isFile() || entry.isSymbolicLink()) return null;
  } catch {
    return null;
  }
  return target;
}

async function writableCacheFile(root, segments) {
  await mkdir(root, { recursive: true });
  const realRoot = await realpath(root);
  let parent = realRoot;
  for (const segment of segments.slice(0, -1)) {
    const candidate = join(parent, segment);
    try {
      const entry = await lstat(candidate);
      if (!entry.isDirectory() || entry.isSymbolicLink()) return null;
    } catch (error) {
      if (error?.code !== 'ENOENT') return null;
      // Parallel browser tile requests often share several new parent folders. Both
      // requests can observe ENOENT before either mkdir completes; EEXIST is therefore
      // an expected race, not a reason to terminate the Vite process. Re-inspect the
      // winner below so a concurrently inserted file or symlink still fails closed.
      try {
        await mkdir(candidate);
      } catch (mkdirError) {
        if (mkdirError?.code !== 'EEXIST') return null;
      }
      let created;
      try {
        created = await lstat(candidate);
      } catch {
        return null;
      }
      if (!created.isDirectory() || created.isSymbolicLink()) return null;
    }
    parent = await realpath(candidate);
    if (!contained(realRoot, parent)) return null;
  }
  const target = join(parent, segments.at(-1));
  try {
    const entry = await lstat(target);
    if (!entry.isFile() || entry.isSymbolicLink()) return null;
  } catch (error) {
    if (error?.code !== 'ENOENT') return null;
  }
  return target;
}

function finish(res, status, headers = {}, body = null, head = false) {
  res.statusCode = status;
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (body) res.setHeader('Content-Length', String(body.byteLength));
  res.end(head ? undefined : body ?? undefined);
}

export function createTarkovAssetCacheMiddleware({
  root = TARKOV_ASSET_CACHE_ROOT,
  fetchImpl = globalThis.fetch,
} = {}) {
  return async function tarkovAssetCacheMiddleware(req, res, next) {
    const decision = resolveTarkovAssetCacheRequest({ method: req.method, url: req.url });
    if (!decision.ok) {
      if (decision.status === null) return next();
      return finish(res, decision.status, decision.allow ? { Allow: decision.allow } : {});
    }

    const cached = await existingCacheFile(root, decision.segments);
    if (cached) {
      const bytes = await readFile(cached);
      return finish(res, 200, {
        'Content-Type': decision.contentType,
        'Cache-Control': 'max-age=604800',
      }, bytes, req.method === 'HEAD');
    }

    const upstream = new URL(
      `/${decision.segments.map((segment) => encodeURIComponent(segment)).join('/')}`,
      UPSTREAM_ORIGIN,
    );
    let response;
    try {
      response = await fetchImpl(upstream, { redirect: 'error' });
    } catch {
      return finish(res, 502, { 'Cache-Control': 'no-store' });
    }
    if (!response.ok) return finish(res, response.status, { 'Cache-Control': 'no-store' });
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      return finish(res, 413, { 'Cache-Control': 'no-store' });
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) return finish(res, 413, { 'Cache-Control': 'no-store' });

    const target = await writableCacheFile(root, decision.segments);
    if (target) writeFile(target, bytes).catch(() => {});
    return finish(res, 200, {
      'Content-Type': decision.contentType,
      'Cache-Control': 'max-age=604800',
    }, bytes, req.method === 'HEAD');
  };
}

export function tarkovAssetCacheDevPlugin(options = {}) {
  return {
    name: 'tarkov-asset-cache',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(createTarkovAssetCacheMiddleware(options));
    },
  };
}
