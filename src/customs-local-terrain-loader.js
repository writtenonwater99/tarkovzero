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

function requestOptions(signal) {
  return {
    method: 'GET',
    mode: 'same-origin',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal,
  };
}

async function fetchLocalResource(fetchImplementation, url, resource, signal) {
  throwIfAborted(signal);
  let response;
  try {
    response = await fetchImplementation(url, requestOptions(signal));
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

async function readManifest(response, manifestUrl, signal) {
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
    return validateCustomsLocalTerrainManifest(value);
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
 * Load and hydrate the ignored, local-only Customs terrain package.
 *
 * The entry point is intentionally fixed. Callers may inject browser primitives
 * for testing, but cannot supply another path, origin, or network fallback.
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

  const manifestUrlObject = new URL(CUSTOMS_LOCAL_TERRAIN_MANIFEST_PATH, pageUrl);
  if (manifestUrlObject.origin !== pageUrl.origin) {
    throw new CustomsLocalTerrainUnavailableError(
      'Customs local terrain manifest must remain on the current loopback origin.',
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
  );
  const manifest = await readManifest(manifestResponse, manifestUrl, signal);
  const assets = assetIndex(manifest, packageBaseUrl);

  const heightEntries = await Promise.all(assets.map(async (asset) => {
    const resource = `height:${asset.tileId}`;
    const response = await fetchLocalResource(
      fetchImplementation,
      asset.heightUrl,
      resource,
      signal,
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
    manifestUrl,
    manifest,
    runtime,
    assets,
  });
}
