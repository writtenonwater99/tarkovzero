const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function normalizeHostname(hostname = '') {
  const value = String(hostname).trim().toLowerCase();
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

export function isLoopbackHostname(hostname) {
  return LOOPBACK_HOSTS.has(normalizeHostname(hostname));
}

export function canUseLocalThree({ dev, hostname, mapKey, rendererRequest }) {
  return dev === true
    && isLoopbackHostname(hostname)
    && mapKey === 'customs'
    && rendererRequest === 'three';
}

export function localRendererMode(options) {
  return canUseLocalThree(options) ? 'three' : 'deck';
}

export function assertLocalThree(options) {
  if (!canUseLocalThree(options)) {
    throw new Error('Three.js proof requires Vite DEV, a loopback hostname, Customs, and ?renderer=three');
  }
}
