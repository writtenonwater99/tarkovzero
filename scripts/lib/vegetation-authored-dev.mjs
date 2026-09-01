// Dev-only static route for the independently-authored Customs vegetation pack.
//
// The pack lives in a gitignored repo-local directory OUTSIDE `public/`, so
// `vite build` cannot copy it into `dist/` and `vite preview` cannot serve it.
// This module is the single place that maps a fixed loopback URL prefix onto
// that directory, and it is installed only for the `serve` (dev) command.
//
// This is a close structural mirror of `local-game-derived-dev.mjs` (method,
// origin/host, path-shape, symlink and header-hygiene checks are the same
// deny-by-default posture, and the pure loopback/decoding primitives are
// imported from that file rather than reimplemented) but authorizes paths
// against a different document: `pack-index.json`'s own
// `authoredAssets[*].lods[*].file` list, not the Customs terrain manifest.
// The two authorization stories are kept in separate files on purpose — see
// docs/plans/VEGETATION-SERVING.md §2 ("Why a second plugin file, not a
// generalized one").
//
// The pack itself is original authored work (a Blender export, geometry
// approximated from scalar prototype identity — see its own
// pack-index.receipt.json `copyrightBoundary`), not data extracted from a
// local Escape from Tarkov install; conflating it with `.local-game-derived/`
// would blur a distinction the build-boundary apparatus exists to prove. It
// stays under `.local-candidates/`, is never moved, copied, or written to by
// this module, and this route is `apply: 'serve'` only, so it is absent from
// both `vite build` and `vite preview` by construction.

import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeSegment,
  hostHeaderHostname,
  isLoopbackAddress,
  resolveLocalGameDerivedFile,
} from './local-game-derived-dev.mjs';
import { SAFE_ASSET_FILE } from '../../src/customs-authored-vegetation.js';

/**
 * Repo-local, gitignored root that holds the current authored vegetation
 * pack. `-v2` names the Stage A rebuild (alphaMode fix + RGB dilation +
 * provenance gate, docs/plans/VEGETATION-ALPHA.md) that superseded the
 * original `vegetation-full/` pack; both currently sit on disk, but only
 * `vegetation-full-v2/` is complete (31/31 families) and adapter-accepted.
 */
export const VEGETATION_AUTHORED_DIRNAME = 'vegetation-full-v2';

// Anchored to this file, not to `process.cwd()`, exactly like LOCAL_GAME_DERIVED_ROOT.
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Absolute default pack root: `<repo>/.local-candidates/vegetation-full-v2`. */
export const VEGETATION_AUTHORED_ROOT =
  join(REPOSITORY_ROOT, '.local-candidates', VEGETATION_AUTHORED_DIRNAME);

/**
 * Fixed URL prefix. A distinct `/@…` prefix: cannot collide with a `public/`
 * asset path, and is visibly distinct from `/@local-game-derived/` in any log
 * or network panel.
 */
export const VEGETATION_AUTHORED_ROUTE = '/@vegetation-authored/';

const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENTS = 32;
// pack-index.json is measured at 1.85 MB; headroom, not a promise.
const MAX_PACK_INDEX_BYTES = 4 * 1024 * 1024;
const ALLOWED_METHODS = new Set(['GET', 'HEAD']);

const PACK_INDEX_SEGMENTS = Object.freeze(['pack-index.json']);
const PACK_INDEX_RECEIPT_SEGMENTS = Object.freeze(['pack-index.receipt.json']);

// `.glb` is the only payload format the pack ships (93 files: `find
// .local-candidates/vegetation-full-v2/assets -type f | sed -E 's/.*\.//' |
// sort | uniq -c` -> `93 glb, 93 json`). `.json` is required for exactly two
// files — `pack-index.json` (the catalog a future wiring pass fetches at
// runtime) and `pack-index.receipt.json` (its own hash receipt) — never "any
// JSON": the manifest-driven authorization below, not this allowlist alone,
// is what keeps `generation-manifest.json`, the per-asset `*.receipt.json`
// sidecars, and everything under `logs/`, `qa/`, `validation/`,
// `verification/` unreachable even though their extension is allowed.
//
// No `.ktx2`, no bare `.png`: every texture in the pack is baked into its GLB
// by the Blender exporter (same `find | uniq -c` above — zero `.png`, zero
// `.ktx2`, zero `.bin` anywhere under `assets/`). If a future pipeline ever
// ships unbaked textures alongside the GLBs, add the extension here AND
// extend `collectAuthorizedVegetationPaths()` to enumerate them from the
// manifest at the same time — never widen this map alone.
const CONTENT_TYPES = new Map([
  ['.glb', 'model/gltf-binary'],
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
 * Decide, from request metadata alone, whether a request may read the pack.
 *
 * Returns `{ ok: true, segments, contentType }` or `{ ok: false, status, reason }`.
 * `{ ok: false, status: null }` means "not our route" — the caller must delegate.
 */
export function resolveVegetationAuthoredRequest({ method, url, headers = {}, remoteAddress } = {}) {
  const target = typeof url === 'string' ? url : '';
  const pathname = target.split('?')[0].split('#')[0];
  if (!pathname.startsWith(VEGETATION_AUTHORED_ROUTE)) {
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

  const rawSegments = pathname.slice(VEGETATION_AUTHORED_ROUTE.length).split('/');
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
 * Derive the complete browser-readable file set from `pack-index.json`'s own
 * declared asset catalog. NOT a full schema validator (none exists yet for
 * this document shape, unlike `validateCustomsLocalTerrainManifest` for the
 * terrain manifest) — deliberately strict about the one thing that matters
 * for a static-file route: every `file` value must already match the
 * adapter's own `SAFE_ASSET_FILE` contract, so this can never be tricked into
 * authorizing a traversal-shaped string.
 */
export function collectAuthorizedVegetationPaths(packIndexValue) {
  const authorized = new Set([
    PACK_INDEX_SEGMENTS.join('/'),
    PACK_INDEX_RECEIPT_SEGMENTS.join('/'),
  ]);
  const assets = Array.isArray(packIndexValue?.authoredAssets) ? packIndexValue.authoredAssets : [];
  for (const asset of assets) {
    const lods = Array.isArray(asset?.lods) ? asset.lods : [];
    for (const lodEntry of lods) {
      const file = lodEntry?.file;
      if (typeof file === 'string' && SAFE_ASSET_FILE.test(file)) authorized.add(file);
    }
  }
  return authorized;
}

async function isAuthorizedVegetationPath(root, segments) {
  const indexFile = await resolveLocalGameDerivedFile(root, PACK_INDEX_SEGMENTS);
  if (!indexFile || indexFile.size > MAX_PACK_INDEX_BYTES) return false;
  try {
    const bytes = await readFile(indexFile.path);
    const packIndex = JSON.parse(bytes.toString('utf8'));
    return collectAuthorizedVegetationPaths(packIndex).has(segments.join('/'));
  } catch {
    // An unreadable or invalid index authorizes nothing, including itself.
    return false;
  }
}

function endWith(res, status, headers = {}) {
  res.statusCode = status;
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.end();
}

/**
 * `Cache-Control` per response kind. `.glb` responses get long-lived,
 * immutable caching — the route is manifest-authorized against
 * `pack-index.json`'s own declared `sha256` per file, which is what makes
 * `immutable` a correct claim rather than a hopeful one, and the adapter can
 * legitimately re-request the same `assetId` x `lod` pair as the camera
 * crosses a cell boundary within one session (see VEGETATION-SERVING.md §4).
 * `pack-index.json` / `pack-index.receipt.json` keep `no-store`: they are the
 * one thing a future wiring pass is likely to re-fetch deliberately after a
 * pack regeneration, and they are small enough that caching them buys
 * nothing worth the staleness risk.
 *
 * Known dev-workflow trade-off: because the addressing lives in this
 * side-channel manifest instead of the URL itself, a GLB regenerated with
 * different bytes at the same path needs a hard-reload (or DevTools
 * "Disable cache") to be picked up in an already-open dev session.
 */
function cacheControlFor(segments) {
  const last = segments[segments.length - 1];
  return extensionOf(last) === '.glb'
    ? 'public, max-age=31536000, immutable'
    : 'no-store';
}

/** Build the connect-style middleware that serves `root` under the fixed route. */
export function createVegetationAuthoredMiddleware(root) {
  return async function vegetationAuthoredMiddleware(req, res, next) {
    const decision = resolveVegetationAuthoredRequest({
      method: req.method,
      url: req.url,
      headers: req.headers ?? {},
      remoteAddress: req.socket?.remoteAddress,
    });
    if (!decision.ok) {
      if (decision.status === null) return next();
      return endWith(res, decision.status, decision.allow ? { Allow: decision.allow } : {});
    }
    if (!(await isAuthorizedVegetationPath(root, decision.segments))) return endWith(res, 404);

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
export function vegetationAuthoredDevPlugin({ root } = {}) {
  const packageRoot = root ?? VEGETATION_AUTHORED_ROOT;
  return {
    name: 'tarkovzero-vegetation-authored',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(createVegetationAuthoredMiddleware(packageRoot));
    },
  };
}
