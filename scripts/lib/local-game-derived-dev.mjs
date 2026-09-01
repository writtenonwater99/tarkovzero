// Dev-only static route for user-owned, game-derived Customs truth.
//
// The package lives in a gitignored repo-local directory OUTSIDE `public/`, so
// `vite build` cannot copy it into `dist/` and `vite preview` cannot serve it.
// This module is the single place that maps the fixed loopback URL prefix onto
// that directory, and it is installed only for the `serve` (dev) command.
//
// Everything here is intentionally deny-by-default: method, remote address,
// Host header, percent-decoding, path shape, file extension, symlink escape and
// entry type are each checked before a single byte is read.

import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCustomsLocalTerrainManifest } from '../../src/customs-local-terrain.js';

/** Repo-local, gitignored root that holds the extracted package. */
export const LOCAL_GAME_DERIVED_DIRNAME = '.local-game-derived';

// Anchored to this file, not to `process.cwd()`, so the root is the same
// directory however the dev server was launched.
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Absolute default package root: `<repo>/.local-game-derived`. */
export const LOCAL_GAME_DERIVED_ROOT = join(REPOSITORY_ROOT, LOCAL_GAME_DERIVED_DIRNAME);

/** Fixed URL prefix. `/@…` can never collide with a `public/` asset path. */
export const LOCAL_GAME_DERIVED_ROUTE = '/@local-game-derived/';

const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENTS = 32;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const ALLOWED_METHODS = new Set(['GET', 'HEAD']);
const CUSTOMS_MANIFEST_SEGMENTS = Object.freeze(['customs', 'manifest.json']);

// Only the suffixes `scripts/extract-customs-terrain-local.py` is allowed to
// write. Anything else the user drops into the directory stays unreachable.
const CONTENT_TYPES = new Map([
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.f32le', 'application/octet-stream'],
]);

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '0:0:0:0:0:0:0:1']);

function deny(status, reason, extra = {}) {
  return { ok: false, status, reason, ...extra };
}

/** Normalize a socket address to a bare hostname (drops the IPv4-mapped v6 prefix). */
export function normalizeAddress(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  let address = value.trim().toLowerCase();
  if (address.startsWith('[') && address.includes(']')) {
    address = address.slice(1, address.indexOf(']'));
  }
  if (address.startsWith('::ffff:')) address = address.slice('::ffff:'.length);
  return address.length > 0 ? address : null;
}

export function isLoopbackAddress(value) {
  const address = normalizeAddress(value);
  if (!address) return false;
  if (LOOPBACK_HOSTNAMES.has(address)) return true;
  return /^127\.(?:\d{1,3})\.(?:\d{1,3})\.(?:\d{1,3})$/.test(address)
    && address.split('.').slice(1).every((octet) => Number(octet) <= 255);
}

/** Extract the hostname from a `Host` header, tolerating `[::1]:5173` forms. */
export function hostHeaderHostname(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) return null;
  const host = value.trim();
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    if (close < 0) return null;
    const rest = host.slice(close + 1);
    if (rest !== '' && !/^:\d{1,5}$/.test(rest)) return null;
    return host.slice(1, close).toLowerCase();
  }
  const parts = host.split(':');
  if (parts.length > 2) return null;
  if (parts.length === 2 && !/^\d{1,5}$/.test(parts[1])) return null;
  return parts[0].toLowerCase();
}

function decodeSegment(rawSegment) {
  let decoded;
  try {
    decoded = decodeURIComponent(rawSegment);
  } catch {
    return null;
  }
  if (
    decoded.length === 0
    || decoded === '.'
    || decoded === '..'
    || decoded.includes('/')
    || decoded.includes('\\')
    || decoded.includes('\0')
    || decoded.startsWith(' ')
    || decoded.endsWith(' ')
  ) {
    return null;
  }
  return decoded;
}

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/**
 * Decide, from request metadata alone, whether a request may read the package.
 *
 * Returns `{ ok: true, segments, contentType }` or `{ ok: false, status, reason }`.
 * `{ ok: false, status: null }` means "not our route" — the caller must delegate.
 */
export function resolveLocalGameDerivedRequest({ method, url, headers = {}, remoteAddress } = {}) {
  const target = typeof url === 'string' ? url : '';
  const pathname = target.split('?')[0].split('#')[0];
  if (!pathname.startsWith(LOCAL_GAME_DERIVED_ROUTE)) {
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

  const rawSegments = pathname.slice(LOCAL_GAME_DERIVED_ROUTE.length).split('/');
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
 * Resolve a validated relative path inside `root`, refusing symlink escapes.
 *
 * Returns the real absolute path of a regular file, or null.
 */
export async function resolveLocalGameDerivedFile(root, segments) {
  let realRoot;
  try {
    realRoot = await realpath(root);
  } catch {
    return null;
  }
  let realTarget;
  try {
    realTarget = await realpath(join(realRoot, ...segments));
  } catch {
    return null;
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) return null;
  let entry;
  try {
    entry = await stat(realTarget);
  } catch {
    return null;
  }
  return entry.isFile() ? { path: realTarget, size: entry.size } : null;
}

/**
 * Derive the complete browser-readable file set from the same strict manifest
 * contract used by the renderer. A matching suffix alone never grants access.
 */
export function collectAuthorizedCustomsPaths(manifestValue) {
  const manifest = validateCustomsLocalTerrainManifest(manifestValue);
  const authorized = new Set([CUSTOMS_MANIFEST_SEGMENTS.join('/')]);
  for (const tile of manifest.tiles) {
    authorized.add(`customs/${tile.heightFile}`);
    for (const control of tile.controlMaps) authorized.add(`customs/${control.file}`);
    if (tile.vegetation) authorized.add(`customs/${tile.vegetation.file}`);
  }
  return authorized;
}

async function isAuthorizedCustomsPath(root, segments) {
  if (segments[0] !== 'customs') return false;
  const manifestFile = await resolveLocalGameDerivedFile(root, CUSTOMS_MANIFEST_SEGMENTS);
  if (!manifestFile || manifestFile.size > MAX_MANIFEST_BYTES) return false;
  try {
    const bytes = await readFile(manifestFile.path);
    const manifest = JSON.parse(bytes.toString('utf8'));
    return collectAuthorizedCustomsPaths(manifest).has(segments.join('/'));
  } catch {
    // An unreadable or invalid manifest authorizes nothing, including itself.
    return false;
  }
}

function endWith(res, status, headers = {}) {
  res.statusCode = status;
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.end();
}

/** Build the connect-style middleware that serves `root` under the fixed route. */
export function createLocalGameDerivedMiddleware(root) {
  return async function localGameDerivedMiddleware(req, res, next) {
    const decision = resolveLocalGameDerivedRequest({
      method: req.method,
      url: req.url,
      headers: req.headers ?? {},
      remoteAddress: req.socket?.remoteAddress,
    });
    if (!decision.ok) {
      if (decision.status === null) return next();
      return endWith(res, decision.status, decision.allow ? { Allow: decision.allow } : {});
    }
    if (!(await isAuthorizedCustomsPath(root, decision.segments))) return endWith(res, 404);

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
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (req.method === 'HEAD') return res.end();
    return res.end(body);
  };
}

/**
 * Vite plugin. `apply: 'serve'` keeps the route out of `vite build` entirely,
 * and only `configureServer` is implemented, so `vite preview` (which serves the
 * production build) never gains the route either.
 */
export function localGameDerivedDevPlugin({ root } = {}) {
  const packageRoot = root ?? LOCAL_GAME_DERIVED_ROOT;
  return {
    name: 'tarkovzero-local-game-derived',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(createLocalGameDerivedMiddleware(packageRoot));
    },
  };
}
