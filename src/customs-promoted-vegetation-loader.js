/**
 * Load the PROMOTED Customs vegetation package — the ungated half of the loader pair.
 *
 * The terrain pair is the pattern (`src/customs-local-terrain-loader.js`): two entry points, not
 * one with a flag.
 *
 *   * `loadCustomsLocalVegetation()` in `src/customs-local-vegetation.js` is UNCHANGED. It still
 *     requires the fixed loopback manifest URL, still requires every tile payload to declare
 *     `localOnly: true`, and still reads the raw Unity dumps through the dev-only Vite route.
 *   * this one has NO origin rule, requires a document that declares `localOnly: false` and
 *     `distribution: "promoted-public"`, and reads a placement table that exists only in `public/`.
 *
 * Neither accepts the other's package: the local loader refuses this manifest's URL and its
 * `localOnly: false`; this loader refuses a document that calls itself local-only, and refuses any
 * document that so much as NAMES `terrain-NNN-vegetation.json` (see
 * `assertCustomsPromotedVegetationHasNoCaptureReference`).
 *
 * `canLoadLocalGameDerivedAssets()` DID NOT MOVE. It is still dev + loopback and still governs the
 * raw Unity dumps, the local terrain package, the bridge corrections and the scalar facts. What
 * changed is that the authored vegetation stopped being one of the things it governs — the bytes
 * this loader fetches are ordinary public assets under `asset-promotion-manifest.json`, re-proved
 * by digest against `dist/` by `npm run verify:build-boundary` after every build.
 */

import { classifyCustomsVegetationPrototype } from './customs-local-vegetation.js';
import {
  CUSTOMS_PROMOTED_VEGETATION_ARRAY_BASE_URL,
  CUSTOMS_PROMOTED_VEGETATION_BASE_URL,
  CUSTOMS_PROMOTED_VEGETATION_MANIFEST_PATH,
  CustomsPromotedVegetationError,
  decodeCustomsPromotedVegetationPlacements,
  validateCustomsPromotedVegetationManifest,
} from './customs-promoted-vegetation.js';

export {
  CUSTOMS_PROMOTED_VEGETATION_ARRAY_BASE_URL,
  CUSTOMS_PROMOTED_VEGETATION_BASE_URL,
  CUSTOMS_PROMOTED_VEGETATION_MANIFEST_PATH,
  CustomsPromotedVegetationError,
};

function fail(message, options) {
  throw new CustomsPromotedVegetationError(message, options);
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
  const error = new Error('The promoted Customs vegetation request was aborted.');
  error.name = 'AbortError';
  throw error;
}

function rethrowAbort(error, signal) {
  if (error?.name === 'AbortError') throw error;
  if (signal?.aborted) throwIfAborted(signal);
}

/**
 * The page URL for a package that is NOT origin-restricted.
 *
 * Byte-for-byte the same rule the promoted TERRAIN loader applies: a usable http(s) base, and no
 * credentials smuggled into it. There is no loopback set here, and that is the point.
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
    fail('Promoted Customs vegetation requires a page URL to resolve against.', {
      code: 'ERR_CUSTOMS_PROMOTED_VEGETATION_UNAVAILABLE',
      resource: 'location',
    });
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (cause) {
    fail('Promoted Customs vegetation requires a valid page URL.', {
      code: 'ERR_CUSTOMS_PROMOTED_VEGETATION_UNAVAILABLE',
      resource: 'location',
      cause,
    });
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    fail('Promoted Customs vegetation requires a plain http(s) page URL.', {
      code: 'ERR_CUSTOMS_PROMOTED_VEGETATION_UNAVAILABLE',
      resource: 'location',
    });
  }
  return parsed;
}

/**
 * `cache: 'default'`, not `'no-store'` — the same reasoning the promoted terrain loader records.
 *
 * These are immutable, digest-pinned public assets. `no-store` would forbid the browser from
 * caching the manifest and the placement table at all and re-download them on every navigation, for
 * no safety: the promotion manifest already proves the bytes and a change to them is a new deploy.
 */
function requestOptions(signal) {
  return {
    method: 'GET',
    mode: 'same-origin',
    credentials: 'same-origin',
    cache: 'default',
    redirect: 'error',
    signal,
  };
}

async function fetchPromoted(fetchImplementation, url, resource, signal) {
  throwIfAborted(signal);
  let response;
  try {
    response = await fetchImplementation(url, requestOptions(signal));
  } catch (cause) {
    rethrowAbort(cause, signal);
    fail(`Could not load promoted Customs vegetation ${resource}.`, {
      code: 'ERR_CUSTOMS_PROMOTED_VEGETATION_UNAVAILABLE',
      resource,
      cause,
    });
  }
  if (!response || typeof response.ok !== 'boolean') {
    fail(`Promoted Customs vegetation ${resource} returned an invalid fetch response.`, { resource });
  }
  if (!response.ok) {
    fail(`Promoted Customs vegetation ${resource} is unavailable (HTTP ${response.status}).`, {
      code: 'ERR_CUSTOMS_PROMOTED_VEGETATION_UNAVAILABLE',
      resource,
    });
  }
  return response;
}

async function sha256Hex(bytes, cryptoImplementation) {
  const subtle = cryptoImplementation?.subtle;
  if (!subtle?.digest) return null;
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

/**
 * Fetch, verify and hydrate the promoted vegetation package.
 *
 * The result is deliberately shaped so that `buildCustomsLocalVegetationRenderPlan()` — the SAME
 * plan builder the localhost path uses, with the same scope and the same `reliefOriginYM` — can be
 * handed `result.vegetation` unchanged. Two code paths producing two plans that merely agree is the
 * kind of arrangement that drifts; one plan builder fed by two loaders cannot.
 *
 * @returns {Promise<{distribution: 'promoted-public', manifestUrl: string, manifest: object,
 *   catalogSource: object, vegetation: object, baseUrl: string, arrayIndexUrl: string,
 *   placements: {count: number, bytes: number, sha256: string, verified: boolean}}>}
 */
export async function loadCustomsPromotedVegetationPackage({
  fetch: fetchImplementation = globalThis.fetch,
  location: locationValue = globalThis.location,
  crypto: cryptoImplementation = globalThis.crypto,
  signal,
} = {}) {
  throwIfAborted(signal);
  const pageUrl = publicPageUrl(locationValue);
  if (typeof fetchImplementation !== 'function') {
    fail('Promoted Customs vegetation requires the browser Fetch API.', {
      code: 'ERR_CUSTOMS_PROMOTED_VEGETATION_UNAVAILABLE',
      resource: 'fetch',
    });
  }

  const manifestUrlObject = new URL(CUSTOMS_PROMOTED_VEGETATION_MANIFEST_PATH, pageUrl);
  if (manifestUrlObject.origin !== pageUrl.origin) {
    fail('The promoted Customs vegetation manifest must stay on the current page origin.', {
      resource: 'manifest',
    });
  }
  const manifestUrl = manifestUrlObject.href;
  const packageBaseUrl = new URL('./', manifestUrlObject);

  const manifestResponse = await fetchPromoted(fetchImplementation, manifestUrl, 'manifest', signal);
  if (typeof manifestResponse.json !== 'function') {
    fail('The promoted Customs vegetation manifest cannot be decoded as JSON.', { resource: 'manifest' });
  }
  let manifestValue;
  try {
    manifestValue = await manifestResponse.json();
  } catch (cause) {
    rethrowAbort(cause, signal);
    fail('The promoted Customs vegetation manifest is not valid JSON.', { resource: 'manifest', cause });
  }
  const validated = validateCustomsPromotedVegetationManifest(manifestValue);

  // Resolved from the manifest's own URL, and re-checked to stay inside the package: a `file` value
  // is data, and data never gets to leave the directory it was found in.
  const placementsUrlObject = new URL(validated.placements.file, packageBaseUrl);
  if (
    placementsUrlObject.origin !== packageBaseUrl.origin
    || !placementsUrlObject.pathname.startsWith(packageBaseUrl.pathname)
    || placementsUrlObject.search
    || placementsUrlObject.hash
  ) {
    fail('The promoted Customs vegetation placement table resolves outside the package.', {
      resource: 'placements',
    });
  }
  const arrayIndexUrlObject = new URL(validated.arrays.indexFile, packageBaseUrl);
  if (
    arrayIndexUrlObject.origin !== packageBaseUrl.origin
    || !arrayIndexUrlObject.pathname.startsWith(packageBaseUrl.pathname)
  ) {
    fail('The promoted Customs vegetation array index resolves outside the package.', { resource: 'arrays' });
  }

  const placementsResponse = await fetchPromoted(
    fetchImplementation,
    placementsUrlObject.href,
    'placements',
    signal,
  );
  if (typeof placementsResponse.arrayBuffer !== 'function') {
    fail('The promoted Customs vegetation placement table cannot be decoded as bytes.', {
      resource: 'placements',
    });
  }
  let buffer;
  try {
    buffer = await placementsResponse.arrayBuffer();
  } catch (cause) {
    rethrowAbort(cause, signal);
    fail('Could not read the promoted Customs vegetation placement table.', {
      code: 'ERR_CUSTOMS_PROMOTED_VEGETATION_UNAVAILABLE',
      resource: 'placements',
      cause,
    });
  }
  if (buffer.byteLength !== validated.placements.bytes) {
    fail(
      `The promoted Customs vegetation placement table is ${buffer.byteLength} bytes; the manifest `
      + `declares ${validated.placements.bytes}.`,
      { code: 'ERR_CUSTOMS_PROMOTED_VEGETATION_PLACEMENTS', resource: 'placements' },
    );
  }
  // The integrity check is REPORTED, never assumed. `crypto.subtle` is absent on an insecure
  // non-loopback origin, and a check that silently does not run is the failure mode this project
  // keeps hitting — so `verified` travels out with the result and a MISMATCH is fatal.
  const digest = await sha256Hex(buffer, cryptoImplementation);
  if (digest !== null && `sha256:${digest}` !== validated.placements.sha256) {
    fail('The promoted Customs vegetation placement table does not match its sha256 receipt.', {
      code: 'ERR_CUSTOMS_PROMOTED_VEGETATION_INTEGRITY',
      resource: 'placements',
    });
  }

  const vegetation = decodeCustomsPromotedVegetationPlacements(buffer, {
    bindings: validated.bindings,
    classify: classifyCustomsVegetationPrototype,
    expected: validated.placements.count,
  });

  return Object.freeze({
    distribution: 'promoted-public',
    manifestUrl,
    manifest: validated.manifest,
    // The same field names `pack-index.json` uses, so `normalizeCustomsAuthoredVegetationCatalog()`
    // consumes it directly and applies the identical 31-family / 58-binding strictness.
    catalogSource: validated.manifest,
    vegetation,
    baseUrl: new URL('./', manifestUrlObject).pathname,
    arrayIndexUrl: arrayIndexUrlObject.href,
    arrayBaseUrl: new URL('./', arrayIndexUrlObject).pathname,
    placements: Object.freeze({
      count: validated.placements.count,
      bytes: validated.placements.bytes,
      sha256: validated.placements.sha256,
      verified: digest !== null,
    }),
  });
}
