import {
  createCustomsLocalTerrainRuntime,
  validateCustomsLocalTerrainManifest,
} from './customs-local-terrain.js';

// Served only by the Vite dev middleware in `scripts/lib/local-game-derived-dev.mjs`,
// which reads the gitignored `.local-game-derived/` root outside `public/`. The
// `/@` prefix cannot collide with a `public/` asset, so a production build has
// no file and no route behind this URL.
export const CUSTOMS_LOCAL_TERRAIN_MANIFEST_PATH =
  '/@local-game-derived/customs/manifest.json';

/**
 * The PROMOTED terrain package: the same height and control surfaces, shipped.
 *
 * On 2026-09-02 the founder looked at production and said "this is far from what we worked on. not
 * even the floor ground correct" — production was drawing the public heightfield fitted from spawn
 * and loot points while the reviewed local build drew the exact tiles. He approved promoting the
 * terrain surfaces, and `scripts/promote-terrain-surfaces.mjs` copies them into
 * `public/assets/3d/customs/terrain/` under `asset-promotion-manifest.json`, the way
 * `public/assets/3d/customs/authored/fortress/` already ships.
 *
 * SO THIS PATH IS NOT GATED, AND THE GATE DID NOT MOVE. `canLoadLocalGameDerivedAssets()` is
 * unchanged — dev AND loopback — and still governs everything that is still local: the raw Unity
 * vegetation dumps, the authored vegetation packs, the bridge corrections, the scalar facts. What
 * changed is that the terrain surfaces are no longer among them. They are public assets now, and a
 * public asset does not ask a local-data gate for permission.
 *
 * The two entry points below are deliberately separate functions rather than one with a flag:
 * `loadCustomsLocalTerrainPackage()` keeps its loopback-origin refusal (boundary layer 2, see
 * `src/renderer-gate.js`) and requires `localOnly: true`; this one has no origin rule and requires
 * `localOnly: false`. Neither accepts the other's package.
 */
export const CUSTOMS_PROMOTED_TERRAIN_MANIFEST_PATH =
  '/assets/3d/customs/terrain/terrain-manifest.json';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const SAFE_RELATIVE_ASSET_PATH = /^[A-Za-z0-9._/-]+$/;

export class CustomsLocalTerrainPackageError extends Error {
  constructor(message, { code, cause, resource, status, url } = {}) {
    super(message);
    this.name = 'CustomsLocalTerrainPackageError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
    if (resource !== undefined) this.resource = resource;
    if (status !== undefined) this.status = status;
    if (url !== undefined) this.url = url;
  }
}

export class CustomsLocalTerrainUnavailableError extends CustomsLocalTerrainPackageError {
  constructor(message, details = {}) {
    super(message, {
      ...details,
      code: 'ERR_CUSTOMS_LOCAL_TERRAIN_UNAVAILABLE',
    });
    this.name = 'CustomsLocalTerrainUnavailableError';
  }
}

export class CustomsLocalTerrainInvalidError extends CustomsLocalTerrainPackageError {
  constructor(message, details = {}) {
    super(message, {
      ...details,
      code: 'ERR_CUSTOMS_LOCAL_TERRAIN_INVALID',
    });
    this.name = 'CustomsLocalTerrainInvalidError';
  }
}

function freezeTree(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeTree(child);
  }
  return value;
}

function locationUrl(locationValue) {
  let raw;
  if (typeof locationValue === 'string' || locationValue instanceof URL) {
    raw = String(locationValue);
  } else if (locationValue && typeof locationValue.href === 'string') {
    raw = locationValue.href;
  } else if (locationValue && typeof locationValue.origin === 'string') {
    raw = `${locationValue.origin}/`;
  }

  if (!raw) {
    throw new CustomsLocalTerrainUnavailableError(
      'Customs local terrain is available only from a browser loopback location.',
      { resource: 'location' },
    );
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (cause) {
    throw new CustomsLocalTerrainUnavailableError(
      'Customs local terrain requires a valid loopback page URL.',
      { cause, resource: 'location' },
    );
  }

  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || !LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())
    || parsed.username
    || parsed.password
  ) {
    throw new CustomsLocalTerrainUnavailableError(
      'Customs local terrain is disabled outside localhost, 127.0.0.1, or [::1].',
      { resource: 'location', url: parsed.origin },
    );
  }
  return parsed;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
  const error = new Error('The Customs local terrain request was aborted.');
  error.name = 'AbortError';
  throw error;
}

function rethrowAbort(error, signal) {
  if (error?.name === 'AbortError') throw error;
  if (signal?.aborted) throwIfAborted(signal);
}

function packageAssetUrl(packageBaseUrl, relativePath, resource) {
  if (
    typeof relativePath !== 'string'
    || relativePath.length === 0
    || relativePath.length > 512
    || !SAFE_RELATIVE_ASSET_PATH.test(relativePath)
    || relativePath.startsWith('/')
    || relativePath.includes('\\')
    || relativePath.includes('%')
    || relativePath.includes('?')
    || relativePath.includes('#')
    || relativePath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new CustomsLocalTerrainInvalidError(
      `${resource} is not a safe package-relative asset path.`,
      { resource },
    );
  }

  const resolved = new URL(relativePath, packageBaseUrl);
  if (
    resolved.origin !== packageBaseUrl.origin
    || !resolved.pathname.startsWith(packageBaseUrl.pathname)
    || resolved.search
    || resolved.hash
  ) {
    throw new CustomsLocalTerrainInvalidError(
      `${resource} resolves outside the local Customs terrain package.`,
      { resource },
    );
  }
  return resolved.href;
}

/**
 * `cache` is the one option that differs between the two packages, and it is not a detail.
 *
 * The LOCAL package is served by a dev middleware off files the founder is actively regenerating;
 * `no-store` is what stops a stale terrain surviving a re-extraction. The PROMOTED package is an
 * immutable, digest-pinned public asset — 10.7 MiB of it — and `no-store` there would forbid the
 * browser from caching it at all, re-downloading every surface on every navigation. That is a
 * first-paint cost paid on every visit for no safety: the promotion manifest already proves those
 * bytes, and a change to them is a new deploy.
 */
function requestOptions(signal, cache) {
  return {
    method: 'GET',
    mode: 'same-origin',
    credentials: 'same-origin',
    cache,
    redirect: 'error',
    signal,
  };
}

async function fetchLocalResource(fetchImplementation, url, resource, signal, cache = 'no-store') {
  throwIfAborted(signal);
  let response;
  try {
    response = await fetchImplementation(url, requestOptions(signal, cache));
  } catch (cause) {
    rethrowAbort(cause, signal);
    throw new CustomsLocalTerrainUnavailableError(
      `Could not load local Customs terrain ${resource}.`,
      { cause, resource, url },
    );
  }

  if (!response || typeof response.ok !== 'boolean') {
    throw new CustomsLocalTerrainInvalidError(
      `Local Customs terrain ${resource} returned an invalid fetch response.`,
      { resource, url },
    );
  }
  if (!response.ok) {
    throw new CustomsLocalTerrainUnavailableError(
      `Local Customs terrain ${resource} is unavailable (HTTP ${response.status}).`,
      { resource, status: response.status, url },
    );
  }
  return response;
}

/**
 * The page URL for a package that is NOT origin-restricted.
 *
 * The promoted surfaces are ordinary public assets, so the only thing that matters is that we have
 * a usable http(s) base to resolve against and that credentials cannot be smuggled into it.
 */
function publicPageUrl(locationValue) {
  let raw;
  if (typeof locationValue === 'string' || locationValue instanceof URL) {
    raw = String(locationValue);
  } else if (locationValue && typeof locationValue.href === 'string') {
    raw = locationValue.href;
  } else if (locationValue && typeof locationValue.origin === 'string') {
    raw = `${locationValue.origin}/`;
  }
  if (!raw) {
    throw new CustomsLocalTerrainUnavailableError(
      'Promoted Customs terrain requires a page URL to resolve against.',
      { resource: 'location' },
    );
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (cause) {
    throw new CustomsLocalTerrainUnavailableError(
      'Promoted Customs terrain requires a valid page URL.',
      { cause, resource: 'location' },
    );
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new CustomsLocalTerrainUnavailableError(
      'Promoted Customs terrain requires a plain http(s) page URL.',
      { resource: 'location', url: parsed.origin },
    );
  }
  return parsed;
}

async function readManifest(response, manifestUrl, signal, { expectLocalOnly = true } = {}) {
  if (typeof response.json !== 'function') {
    throw new CustomsLocalTerrainInvalidError(
      'Local Customs terrain manifest response cannot be decoded as JSON.',
      { resource: 'manifest', url: manifestUrl },
    );
  }
  let value;
  try {
    value = await response.json();
  } catch (cause) {
    rethrowAbort(cause, signal);
    throw new CustomsLocalTerrainInvalidError(
      'Local Customs terrain manifest is not valid JSON.',
      { cause, resource: 'manifest', url: manifestUrl },
    );
  }
  try {
    return validateCustomsLocalTerrainManifest(value, { expectLocalOnly });
  } catch (cause) {
    throw new CustomsLocalTerrainInvalidError(
      `Local Customs terrain manifest failed validation: ${cause.message}`,
      { cause, resource: 'manifest', url: manifestUrl },
    );
  }
}

function assetIndex(manifest, packageBaseUrl) {
  return freezeTree(manifest.tiles.map((tile) => ({
    tileId: tile.id,
    heightUrl: packageAssetUrl(packageBaseUrl, tile.heightFile, `height for tile ${tile.id}`),
    controlMaps: tile.controlMaps.map((controlMap) => ({
      id: controlMap.id,
      url: packageAssetUrl(
        packageBaseUrl,
        controlMap.file,
        `control map ${controlMap.id} for tile ${tile.id}`,
      ),
      channels: [...controlMap.channels],
    })),
    vegetation: tile.vegetation
      ? {
          url: packageAssetUrl(
            packageBaseUrl,
            tile.vegetation.file,
            `vegetation for tile ${tile.id}`,
          ),
          format: tile.vegetation.format,
          count: tile.vegetation.count,
          prototypes: tile.vegetation.prototypes,
        }
      : null,
  })));
}

async function readHeight(response, asset, signal) {
  if (typeof response.arrayBuffer !== 'function') {
    throw new CustomsLocalTerrainInvalidError(
      `Height for tile ${asset.tileId} cannot be decoded as bytes.`,
      { resource: `height:${asset.tileId}`, url: asset.heightUrl },
    );
  }
  try {
    return await response.arrayBuffer();
  } catch (cause) {
    rethrowAbort(cause, signal);
    throw new CustomsLocalTerrainUnavailableError(
      `Could not read local Customs terrain height for tile ${asset.tileId}.`,
      { cause, resource: `height:${asset.tileId}`, url: asset.heightUrl },
    );
  }
}

/**
 * The shared fetch/validate/hydrate core. It has no policy of its own: the caller has already
 * decided which page URLs are acceptable and which `localOnly` value this package must declare.
 *
 * `distribution` travels out on the result so a renderer can SAY which package it is drawing
 * rather than infer it. A frame that cannot name its own source is how the CUSTOMS TRUTH strip
 * came to claim 7,108 authored placements over a procedural forest (handoff §6).
 */
async function loadTerrainPackage({
  fetchImplementation,
  pageUrl,
  manifestPath,
  expectLocalOnly,
  distribution,
  allowVegetation,
  cache,
  signal,
}) {
  const manifestUrlObject = new URL(manifestPath, pageUrl);
  if (manifestUrlObject.origin !== pageUrl.origin) {
    throw new CustomsLocalTerrainUnavailableError(
      'Customs terrain manifest must remain on the current page origin.',
      { resource: 'manifest' },
    );
  }
  const manifestUrl = manifestUrlObject.href;
  const packageBaseUrl = new URL('./', manifestUrlObject);
  const manifestResponse = await fetchLocalResource(
    fetchImplementation,
    manifestUrl,
    'manifest',
    signal,
    cache,
  );
  const manifest = await readManifest(manifestResponse, manifestUrl, signal, { expectLocalOnly });
  // The promoted package ships. `terrain-NNN-vegetation.json` is a RAW CAPTURE and never leaves
  // `.local-game-derived/`, so a promoted manifest that references vegetation is either a stale
  // document or an attempt to route one — refuse it here rather than emit a URL for a file that
  // must not exist in `public/`.
  if (!allowVegetation) {
    const offender = manifest.tiles.find((tile) => tile.vegetation);
    if (offender) {
      throw new CustomsLocalTerrainInvalidError(
        `Promoted Customs terrain must not reference vegetation (tile ${offender.tileId ?? offender.id}); `
        + 'the Unity vegetation dump is a raw capture and is never promoted.',
        { resource: 'manifest', url: manifestUrl },
      );
    }
  }
  const assets = assetIndex(manifest, packageBaseUrl);

  const heightEntries = await Promise.all(assets.map(async (asset) => {
    const resource = `height:${asset.tileId}`;
    const response = await fetchLocalResource(
      fetchImplementation,
      asset.heightUrl,
      resource,
      signal,
      cache,
    );
    const bytes = await readHeight(response, asset, signal);
    const tile = manifest.tiles.find(({ id }) => id === asset.tileId);
    return [tile.heightFile, bytes];
  }));

  let runtime;
  try {
    runtime = createCustomsLocalTerrainRuntime(manifest, new Map(heightEntries));
  } catch (cause) {
    throw new CustomsLocalTerrainInvalidError(
      `Local Customs terrain height payload failed validation: ${cause.message}`,
      { cause, resource: 'height payloads' },
    );
  }

  return freezeTree({
    distribution,
    manifestUrl,
    manifest,
    runtime,
    assets,
  });
}

/**
 * Load and hydrate the ignored, local-only Customs terrain package.
 *
 * The entry point is intentionally fixed. Callers may inject browser primitives
 * for testing, but cannot supply another path, origin, or network fallback.
 *
 * UNCHANGED by the 2026-09-02 terrain promotion: this is still boundary layer 2 (see
 * `src/renderer-gate.js`). It still refuses any non-loopback page origin before it fetches, and it
 * still requires a package that declares itself local-only. The promoted surfaces have their own
 * entry point below and never travel through this one.
 */
export async function loadCustomsLocalTerrainPackage({
  fetch: fetchImplementation = globalThis.fetch,
  location: locationValue = globalThis.location,
  signal,
} = {}) {
  throwIfAborted(signal);
  const pageUrl = locationUrl(locationValue);
  if (typeof fetchImplementation !== 'function') {
    throw new CustomsLocalTerrainUnavailableError(
      'Customs local terrain requires the browser Fetch API.',
      { resource: 'fetch' },
    );
  }
  return loadTerrainPackage({
    fetchImplementation,
    pageUrl,
    manifestPath: CUSTOMS_LOCAL_TERRAIN_MANIFEST_PATH,
    expectLocalOnly: true,
    distribution: 'local-package',
    allowVegetation: true,
    cache: 'no-store',
    signal,
  });
}

/**
 * Load and hydrate the PROMOTED Customs terrain package from `public/assets/`.
 *
 * Identical bytes, identical schema, identical runtime — a different distribution. This is what
 * makes production draw the exact ground instead of the fitted public heightfield, and it needs no
 * gate because nothing it fetches is local: every file it names is admitted by
 * `asset-promotion-manifest.json` and re-proved by `npm run verify:build-boundary` after every
 * build, by digest, against the bytes actually in `dist/`.
 *
 * It refuses a package that declares `localOnly: true` and one that references vegetation, so the
 * local package cannot be served through this path by moving a file.
 */
export async function loadCustomsPromotedTerrainPackage({
  fetch: fetchImplementation = globalThis.fetch,
  location: locationValue = globalThis.location,
  signal,
} = {}) {
  throwIfAborted(signal);
  const pageUrl = publicPageUrl(locationValue);
  if (typeof fetchImplementation !== 'function') {
    throw new CustomsLocalTerrainUnavailableError(
      'Promoted Customs terrain requires the browser Fetch API.',
      { resource: 'fetch' },
    );
  }
  return loadTerrainPackage({
    fetchImplementation,
    pageUrl,
    manifestPath: CUSTOMS_PROMOTED_TERRAIN_MANIFEST_PATH,
    expectLocalOnly: false,
    distribution: 'promoted-public',
    allowVegetation: false,
    cache: 'default',
    signal,
  });
}
