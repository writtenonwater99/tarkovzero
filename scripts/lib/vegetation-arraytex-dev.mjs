// Dev-only static route for the Customs vegetation TEXTURE ARRAY set.
//
// The blobs live in a gitignored repo-local directory OUTSIDE `public/`, so
// `vite build` cannot copy them into `dist/` and `vite preview` cannot serve
// them. This module is the single place that maps a fixed loopback URL prefix
// onto that directory, and it is installed only for the `serve` (dev) command.
//
// ── Why a THIRD plugin file, and not an extension of /@vegetation-authored/ ──
//
// The array set is a SIBLING of the authored pack on disk
// (`.local-candidates/vegetation-arraytex-v1/` next to
// `.local-candidates/vegetation-full-v2/`), not a child of it. Teaching the
// authored route to reach it therefore means re-rooting that route at
// `.local-candidates/` itself — which puts every other candidate package in
// that directory (`crackhouse-final4/`, `industrial-props-freeze/`,
// `pine-alpha-proof-final/`, `survey-2026-09-01/`, `reviews/`, `INDEX.json`,
// …) inside a route that today cannot address them at all. That is a strict
// widening of the authored route's reachable set, which is exactly what this
// change is not allowed to do, and it would be paid for by nothing: the two
// packages also disagree on their authorization document (`pack-index.json`'s
// `authoredAssets[*].lods[*].file` vs `veg-layers.json`'s
// `arrays[*].blobs[*].file`), their payload extension (`.glb` vs `.bin`), and
// their file-name contract (`SAFE_ASSET_FILE` vs `SAFE_BLOB_FILE`). Two roots,
// two documents, two allowlists — one generalized route would have to hold all
// six at once and pick between them by prefix, which is the same conditional
// this file expresses without any shared state to get wrong.
//
// So this is a close structural mirror of `vegetation-authored-dev.mjs` — the
// method, origin/host, header-hygiene, path-shape, symlink and entry-type
// checks are the same deny-by-default posture, and the pure loopback/decoding
// primitives are imported from `local-game-derived-dev.mjs` rather than
// reimplemented a third time — differing only in its root, its authorization
// document and its content-type map. See docs/plans/VEGETATION-SERVING.md §2
// ("Why a second plugin file, not a generalized one"); the same argument
// applies unchanged to the third.
//
// The blobs are derived from the authored pack, which is original authored work
// (a Blender export, geometry approximated from scalar prototype identity), not
// data extracted from a local Escape from Tarkov install. They stay under
// `.local-candidates/`, are never moved, copied, or written to by this module,
// and this route is `apply: 'serve'` only, so it is absent from both
// `vite build` and `vite preview` by construction.

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeSegment,
  hostHeaderHostname,
  isLoopbackAddress,
  resolveLocalGameDerivedFile,
} from './local-game-derived-dev.mjs';
import { SAFE_BLOB_FILE } from '../../src/customs-vegetation-texture-arrays.js';

/**
 * Repo-local, gitignored root that holds the current texture-array set. `-v1`
 * names the first build of the 199 -> 3 array collapse; a rebuild that changes
 * the layer layout gets a new directory rather than overwriting this one, so a
 * receipt already on disk never describes bytes that moved underneath it.
 */
export const VEGETATION_ARRAYTEX_DIRNAME = 'vegetation-arraytex-v1';

// Anchored to this file, not to `process.cwd()`, exactly like LOCAL_GAME_DERIVED_ROOT.
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Absolute default root: `<repo>/.local-candidates/vegetation-arraytex-v1`. */
export const VEGETATION_ARRAYTEX_ROOT =
  join(REPOSITORY_ROOT, '.local-candidates', VEGETATION_ARRAYTEX_DIRNAME);

/**
 * Fixed URL prefix, and the one string `src/map3d-three.js` must agree with
 * (`CUSTOMS_VEGETATION_ARRAY_ROUTE`). A distinct `/@…` prefix: it cannot
 * collide with a `public/` asset path, and it is visibly distinct from both
 * `/@local-game-derived/` and `/@vegetation-authored/` in any log or network
 * panel.
 */
export const VEGETATION_ARRAYTEX_ROUTE = '/@vegetation-arraytex/';

const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENTS = 32;
// veg-layers.json is measured at 184 KB (199 layer records + 199 primitive
// records); headroom, not a promise.
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const ALLOWED_METHODS = new Set(['GET', 'HEAD']);

/** The index document itself, and its own hash receipt. */
export const VEGETATION_ARRAYTEX_INDEX_SEGMENTS = Object.freeze(['veg-layers.json']);
const VEGETATION_ARRAYTEX_RECEIPT_SEGMENTS = Object.freeze(['veg-layers.receipt.json']);

// `.bin` is the only payload format the set ships (9 files: three LOD tiers x
// basecolor/orm/normal). `.json` is required for exactly two files —
// `veg-layers.json` (the index the runtime fetches first) and
// `veg-layers.receipt.json` (its own hash receipt) — never "any JSON": the
// manifest-driven authorization below, not this allowlist alone, is what keeps
// anything else a future build step drops in the directory unreachable even
// though its extension is allowed.
//
// No `.ktx2`, no `.png`: the arrays are raw RGBA8 level chains, and the loader
// (`createCustomsVegetationArrayTexture`) uploads level 0 into a
// `DataArrayTexture`. If a future pipeline ships a compressed set, add the
// extension here AND extend `collectAuthorizedVegetationArrayPaths()` to
// enumerate it from the index at the same time — never widen this map alone.
const CONTENT_TYPES = new Map([
  ['.bin', 'application/octet-stream'],
  ['.json', 'application/json; charset=utf-8'],
]);

function deny(status, reason, extra = {}) {
  return { ok: false, status, reason, ...extra };
}

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/**
 * Decide, from request metadata alone, whether a request may read the array set.
 *
 * Returns `{ ok: true, segments, contentType }` or `{ ok: false, status, reason }`.
 * `{ ok: false, status: null }` means "not our route" — the caller must delegate.
 */
export function resolveVegetationArraytexRequest({ method, url, headers = {}, remoteAddress } = {}) {
  const target = typeof url === 'string' ? url : '';
  const pathname = target.split('?')[0].split('#')[0];
  if (!pathname.startsWith(VEGETATION_ARRAYTEX_ROUTE)) {
    return { ok: false, status: null, reason: 'route-mismatch' };
  }
  if (!ALLOWED_METHODS.has(method)) {
    return deny(405, 'method-not-allowed', { allow: 'GET, HEAD' });
  }
  if (!isLoopbackAddress(remoteAddress)) {
    return deny(403, 'non-loopback-client');
  }
  for (const header of Object.keys(headers)) {
    // A forwarded request reached us through a proxy, so the socket address is
    // no longer proof that the client is local.
    if (header.toLowerCase().startsWith('x-forwarded-')) {
      return deny(403, 'forwarded-request');
    }
  }
  const hostname = hostHeaderHostname(headers.host);
  if (!hostname || !isLoopbackAddress(hostname)) {
    return deny(403, 'non-loopback-host');
  }
  if (pathname.length > MAX_PATH_LENGTH) {
    return deny(414, 'path-too-long');
  }

  const rawSegments = pathname.slice(VEGETATION_ARRAYTEX_ROUTE.length).split('/');
  if (rawSegments.length === 0 || rawSegments.length > MAX_SEGMENTS) {
    return deny(404, 'not-found');
  }
  const segments = [];
  for (const rawSegment of rawSegments) {
    // An empty segment is a trailing slash or `//`; report it as a plain miss so
    // a directory URL cannot be distinguished from an absent file.
    if (rawSegment.length === 0) return deny(404, 'not-found');
    const segment = decodeSegment(rawSegment);
    if (segment === null) return deny(400, 'unsafe-path');
    segments.push(segment);
  }

  const contentType = CONTENT_TYPES.get(extensionOf(segments[segments.length - 1]));
  // No directory listing and no unknown media types: both look like "absent".
  if (!contentType) return deny(404, 'not-found');
  return { ok: true, segments, contentType };
}

/**
 * Derive the complete browser-readable file set from `veg-layers.json`'s own
 * declared blob table.
 *
 * NOT a full schema validator — `validateCustomsVegetationTextureArrayIndex()`
 * in `src/customs-vegetation-texture-arrays.js` is that, and it runs in the
 * browser where a bad index must fail the LOAD, not the SERVE. This is
 * deliberately strict about the one thing that matters for a static-file route:
 * every `file` value must already match the loader's own `SAFE_BLOB_FILE`
 * contract, so it can never be tricked into authorizing a traversal-shaped
 * string, and the set is otherwise exactly the nine blobs the index names.
 *
 * The set is FLAT — the artifact directory has no subdirectories — so every
 * authorized entry is a single path segment, and any multi-segment request
 * misses by construction.
 */
export function collectAuthorizedVegetationArrayPaths(indexValue) {
  const authorized = new Set([
    VEGETATION_ARRAYTEX_INDEX_SEGMENTS.join('/'),
    VEGETATION_ARRAYTEX_RECEIPT_SEGMENTS.join('/'),
  ]);
  const arrays = Array.isArray(indexValue?.arrays) ? indexValue.arrays : [];
  for (const entry of arrays) {
    const blobs = entry?.blobs;
    if (!blobs || typeof blobs !== 'object') continue;
    for (const blob of Object.values(blobs)) {
      const file = blob?.file;
      if (typeof file === 'string' && SAFE_BLOB_FILE.test(file)) authorized.add(file);
    }
  }
  return authorized;
}

/**
 * One authorizer per middleware, re-deriving its allowlist from
 * `veg-layers.json` only when that file changes. Same shape, same reasoning and
 * the same guard posture as the sibling authored route's — see the long comment
 * on `createVegetationPathAuthorizer` in `vegetation-authored-dev.mjs`: the
 * DERIVATION is cached, never the decision, and the key is the index's own
 * resolved path, size and mtime, so a rebuilt index re-derives on the next
 * request.
 */
function createVegetationArrayPathAuthorizer(root) {
  let cached = null;
  return async function isAuthorizedVegetationArrayPath(segments) {
    const indexFile = await resolveLocalGameDerivedFile(root, VEGETATION_ARRAYTEX_INDEX_SEGMENTS);
    if (!indexFile || indexFile.size > MAX_INDEX_BYTES) return false;
    const wanted = segments.join('/');
    if (cached && cached.path === indexFile.path && cached.size === indexFile.size
      && cached.mtimeMs === indexFile.mtimeMs) {
      return cached.authorized.has(wanted);
    }
    try {
      const bytes = await readFile(indexFile.path);
      const index = JSON.parse(bytes.toString('utf8'));
      const authorized = collectAuthorizedVegetationArrayPaths(index);
      cached = {
        path: indexFile.path, size: indexFile.size, mtimeMs: indexFile.mtimeMs, authorized,
      };
      return authorized.has(wanted);
    } catch {
      // An unreadable or invalid index authorizes nothing, including itself.
      cached = null;
      return false;
    }
  };
}

function endWith(res, status, headers = {}) {
  res.statusCode = status;
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.end();
}

/**
 * `Cache-Control` per response kind, on the same reasoning as the authored
 * route's. A `.bin` blob is manifest-authorized against `veg-layers.json`'s own
 * declared `sha256` for that exact file — and the loader VERIFIES that digest
 * before building a texture — which is what makes `immutable` a correct claim
 * rather than a hopeful one. `veg-layers.json` / `veg-layers.receipt.json` keep
 * `no-store`: they are the documents a rebuild changes first, and they are
 * small enough that caching them buys nothing worth the staleness risk.
 *
 * Same dev-workflow trade-off as the sibling: a rebuilt blob at the same path
 * needs a hard reload (or DevTools "Disable cache") in an already-open session.
 * A rebuild that changes bytes should land in a new `-vN` directory anyway, at
 * which point the URL changes too.
 */
function cacheControlFor(segments) {
  const last = segments[segments.length - 1];
  return extensionOf(last) === '.bin'
    ? 'public, max-age=31536000, immutable'
    : 'no-store';
}

/** Build the connect-style middleware that serves `root` under the fixed route. */
export function createVegetationArraytexMiddleware(root) {
  const isAuthorizedVegetationArrayPath = createVegetationArrayPathAuthorizer(root);
  return async function vegetationArraytexMiddleware(req, res, next) {
    const decision = resolveVegetationArraytexRequest({
      method: req.method,
      url: req.url,
      headers: req.headers ?? {},
      remoteAddress: req.socket?.remoteAddress,
    });
    if (!decision.ok) {
      if (decision.status === null) return next();
      return endWith(res, decision.status, decision.allow ? { Allow: decision.allow } : {});
    }
    if (!(await isAuthorizedVegetationArrayPath(decision.segments))) return endWith(res, 404);

    const file = await resolveLocalGameDerivedFile(root, decision.segments);
    if (!file) return endWith(res, 404);

    let body;
    try {
      body = await readFile(file.path);
    } catch {
      return endWith(res, 404);
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', decision.contentType);
    res.setHeader('Content-Length', String(body.byteLength));
    res.setHeader('Cache-Control', cacheControlFor(decision.segments));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (req.method === 'HEAD') return res.end();
    return res.end(body);
  };
}

/**
 * Vite plugin. `apply: 'serve'` keeps the route out of `vite build` entirely,
 * and only `configureServer` is implemented, so `vite preview` (which serves
 * the production build) never gains the route either.
 */
export function vegetationArraytexDevPlugin({ root } = {}) {
  const packageRoot = root ?? VEGETATION_ARRAYTEX_ROOT;
  return {
    name: 'tarkovzero-vegetation-arraytex',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(createVegetationArraytexMiddleware(packageRoot));
    },
  };
}
