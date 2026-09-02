/**
 * Two questions that used to be one, and the reason they had to be split.
 *
 * The old gate exported a single predicate, `canUseLocalThree({ dev, hostname, mapKey,
 * rendererRequest })`, which answered "dev AND loopback AND customs AND ?renderer=three". That
 * conjunction conflated two decisions with completely different reasons for existing:
 *
 *   (a) MAY THE THREE RENDERER RUN AT ALL?  A product decision. The Three renderer draws the
 *       public heightfield from `public/data/customs-3d.json`, the public tree positions, the
 *       authored walls/gates/fences from that same public file, the terrain PBR materials and
 *       Fortress under `public/assets/`. Every byte of that ships today. Nothing about it is
 *       local, so nothing about it needs `dev` or a loopback hostname. It is Customs-only
 *       because Reserve and Woods have no Three data path, and it is opt-in because deck.gl
 *       remains the default renderer (see `docs/LOCAL-THREE-POC.md` § "Reaching the renderer").
 *
 *   (b) MAY IT LOAD LOCAL GAME-DERIVED ENHANCEMENTS?  A boundary decision, and the one that is
 *       actually non-negotiable. The exact terrain package under `.local-game-derived/` and the
 *       authored vegetation packs under `.local-candidates/` are derived from the founder's own
 *       Escape from Tarkov install under a local-use approval that explicitly "does not authorize
 *       shipping, copying, tracing, or redistributing" them. Uploading them anywhere is
 *       distribution regardless of who can log in. So (b) stays exactly what (a) used to be:
 *       Vite DEV **and** a loopback hostname, and nothing else.
 *
 * Fusing them meant the only way to ship (a) was to relax (b). Splitting them means (a) can ship
 * while (b) does not move at all.
 *
 * THIS MODULE IS NOT THE BOUNDARY. It is the first of four independent layers, and the weakest:
 *
 *   1. this gate — `canLoadLocalGameDerivedAssets()`, so the app does not even ask;
 *   2. `src/customs-local-terrain-loader.js` — refuses any non-loopback page origin before it
 *      fetches, with its own `LOOPBACK_HOSTNAMES` set that does not import from here;
 *   3. `scripts/lib/local-game-derived-dev.mjs` — an `apply: 'serve'` Vite plugin, so the route
 *      exists during `npm run dev` and in no other command. `vite build` never installs it and
 *      `vite preview` never gains it: in a production build there is no server behind the URL;
 *   4. `scripts/verify-build-boundary.mjs` — runs after every `vite build` and proves by path,
 *      content and SHA-256 that nothing local reached `dist/`.
 *
 * Weakening any one of those to make something ship is never the fix. Layer 1 exists so the
 * production renderer does not fire a pointless request and can *say* why it has no local data;
 * layers 2-4 are what make the boundary hold if layer 1 is ever wrong.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** Maps whose 3D presentation the Three renderer is built for. Reserve and Woods stay on deck.gl. */
export const THREE_RENDERER_MAPS = Object.freeze(['customs']);

/** The one `?renderer=` value that selects Three. Anything else, including absent, means deck.gl. */
export const THREE_RENDERER_REQUEST = 'three';

export function normalizeHostname(hostname = '') {
  const value = String(hostname).trim().toLowerCase();
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

export function isLoopbackHostname(hostname) {
  return LOOPBACK_HOSTS.has(normalizeHostname(hostname));
}

/**
 * (a) May the Three renderer run at all?
 *
 * Deliberately takes NO environment: no `dev`, no `hostname`. A question that cannot see the
 * environment cannot accidentally start depending on it, and a future reader cannot mistake this
 * for the boundary. Customs, on an explicit request, in any environment.
 */
export function canRunThreeRenderer({ mapKey, rendererRequest } = {}) {
  return THREE_RENDERER_MAPS.includes(mapKey) && rendererRequest === THREE_RENDERER_REQUEST;
}

/**
 * (b) May the renderer load local game-derived enhancements — the exact terrain package, its
 * control/PBR surfaces, and the authored vegetation placements built from it?
 *
 * Vite DEV **and** a loopback hostname. Unchanged from the original gate's environment half, and
 * deliberately independent of (a): it is a property of where the page is running, not of which
 * renderer or map was asked for, so the answer is the same whoever asks it.
 *
 * `dev === true` is an identity check, not a truthiness check: `import.meta.env.DEV` is absent in
 * a production bundle and `undefined` must never read as permission.
 */
export function canLoadLocalGameDerivedAssets({ dev, hostname } = {}) {
  return dev === true && isLoopbackHostname(hostname);
}

/** `'three'` or `'deck'` for question (a). The renderer selector `src/main.js` calls. */
export function resolveRendererMode(options) {
  return canRunThreeRenderer(options) ? 'three' : 'deck';
}

/**
 * Hard-fail question (a) at the renderer's own entry point, so `createView3d()` cannot be reached
 * by any path that did not go through `resolveRendererMode()`.
 */
export function assertThreeRenderer(options) {
  if (!canRunThreeRenderer(options)) {
    throw new Error(`The Three renderer serves ${THREE_RENDERER_MAPS.join('/')} on an explicit ?renderer=${THREE_RENDERER_REQUEST} request`);
  }
}

/**
 * Both answers plus the reason for the second, as one plain object a `renderStats()` reader (or a
 * test) can assert against without re-deriving either predicate.
 *
 * `localEnhancementReason` names WHY local data is or is not reachable, so a production frame can
 * state "release build" rather than presenting an unfetched package as a failure.
 */
export function describeRendererGate({ dev, hostname, mapKey, rendererRequest } = {}) {
  const renderer = resolveRendererMode({ mapKey, rendererRequest });
  const localEnhancements = canLoadLocalGameDerivedAssets({ dev, hostname });
  return Object.freeze({
    renderer,
    request: rendererRequest ?? null,
    mapKey: mapKey ?? null,
    localEnhancements,
    localEnhancementReason: localEnhancements
      ? 'dev-loopback'
      : dev === true
        ? 'non-loopback-host'
        : 'release-build',
  });
}
