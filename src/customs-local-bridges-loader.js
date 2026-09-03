import {
  CUSTOMS_LOCAL_BRIDGES_SEGMENTS,
  validateCustomsLocalBridgesPackage,
} from './customs-local-bridges.js';

// Layer 2 of the boundary, for the bridge package — the same role
// `customs-local-terrain-loader.js` plays for the terrain package, and written the same way for
// the same reason: this file refuses a non-loopback page origin ITSELF, with its own hostname set
// and no import from `src/renderer-gate.js`. If layer 1 (the gate) is ever wrong, a release build
// still cannot ask for this package, because the check that stops it lives here too.
//
// The entry point is fixed. A caller may inject `fetch`/`location` for testing but cannot supply
// another path, another origin, or a network fallback.
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export const CUSTOMS_LOCAL_BRIDGES_PATH =
  `/@local-game-derived/${CUSTOMS_LOCAL_BRIDGES_SEGMENTS.join('/')}`;

export class CustomsLocalBridgesUnavailableError extends Error {
  constructor(message, { cause, status, url } = {}) {
    super(message);
    this.name = 'CustomsLocalBridgesUnavailableError';
    this.code = 'ERR_CUSTOMS_LOCAL_BRIDGES_UNAVAILABLE';
    if (cause !== undefined) this.cause = cause;
    if (status !== undefined) this.status = status;
    if (url !== undefined) this.url = url;
  }
}

function loopbackPageUrl(locationValue) {
  const raw = typeof locationValue === 'string' || locationValue instanceof URL
    ? String(locationValue)
    : locationValue?.href ?? null;
  let parsed = null;
  try {
    if (raw) parsed = new URL(raw);
  } catch {
    parsed = null;
  }
  if (
    !parsed
    || !['http:', 'https:'].includes(parsed.protocol)
    || !LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())
    || parsed.username
    || parsed.password
  ) {
    throw new CustomsLocalBridgesUnavailableError(
      'Local Customs bridges are disabled outside localhost, 127.0.0.1, or [::1].',
    );
  }
  return parsed;
}

/** Fetch, validate and freeze the local-only bridge package. Never falls back to the network. */
export async function loadCustomsLocalBridgesPackage({
  fetch: fetchImplementation = globalThis.fetch,
  location: locationValue = globalThis.location,
  signal,
} = {}) {
  const pageUrl = loopbackPageUrl(locationValue);
  if (typeof fetchImplementation !== 'function') {
    throw new CustomsLocalBridgesUnavailableError('Local Customs bridges require the browser Fetch API.');
  }
  const target = new URL(CUSTOMS_LOCAL_BRIDGES_PATH, pageUrl);
  if (target.origin !== pageUrl.origin) {
    throw new CustomsLocalBridgesUnavailableError('Local Customs bridges must stay on the loopback origin.');
  }
  const url = target.href;
  let response;
  try {
    response = await fetchImplementation(url, {
      method: 'GET',
      mode: 'same-origin',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal,
    });
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause;
    throw new CustomsLocalBridgesUnavailableError('Could not load the local Customs bridge package.', { cause, url });
  }
  // A dev route that does not exist answers 200 with `index.html` (Vite's SPA fallback), which is
  // exactly failure #1 in the handoff's list. `response.ok` is therefore NOT the check: the body
  // has to parse as JSON and satisfy the package contract, or there is no package.
  if (!response || response.ok !== true) {
    throw new CustomsLocalBridgesUnavailableError(
      `The local Customs bridge package is unavailable (HTTP ${response?.status ?? 'n/a'}).`,
      { status: response?.status, url },
    );
  }
  let value;
  try {
    value = await response.json();
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause;
    throw new CustomsLocalBridgesUnavailableError('The local Customs bridge package is not valid JSON.', { cause, url });
  }
  return validateCustomsLocalBridgesPackage(value);
}
