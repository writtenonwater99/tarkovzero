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
 *       because Reserve and Woods have no Three data path, and since 2026-09-02 it is what a
 *       Customs visitor gets by DEFAULT — deck.gl stays one `?renderer=deck` away and remains the
 *       renderer for every other map (see `docs/LOCAL-THREE-POC.md` § "Reaching the renderer").
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

/** The `?renderer=` value that names Three explicitly. On a Three map it is also the default. */
export const THREE_RENDERER_REQUEST = 'three';

/**
 * The one `?renderer=` value that OPTS OUT to deck.gl. It is spelled `deck` because that is what
 * `docs/LOCAL-THREE-POC.md` has told readers to type since the renderer shipped, and because it
 * names the renderer you get rather than negating the one you do not ("renderer=off" would have to
 * mean something).
 *
 * It is the escape hatch from a NEW default onto the renderer that has served production for
 * months, so it is read leniently — see `normalizeRendererRequest`. Everything else, including a
 * misspelling and including absent, leaves the map on its own default renderer.
 */
export const DECK_RENDERER_REQUEST = 'deck';

/** The `?renderer=` values that mean anything. Anything else is a typo, and `main.js` says so. */
export const RENDERER_REQUESTS = Object.freeze([THREE_RENDERER_REQUEST, DECK_RENDERER_REQUEST]);

/**
 * `?renderer=` is typed by a human into an address bar, and one of its two values is now the only
 * way back to the renderer production ran on for months. `?renderer=DECK` silently handing back
 * Three would be the worst kind of surprise, so case and surrounding space are not part of the
 * value. An empty or absent parameter normalizes to `null` — "nothing was asked for" — which is
 * distinct from a value that was asked for and not recognised.
 */
export function normalizeRendererRequest(rendererRequest) {
  const value = String(rendererRequest ?? '').trim().toLowerCase();
  return value === '' ? null : value;
}

/** Whether `?renderer=` named a renderer this app has. A `false` here is a typo, never a choice. */
export function isKnownRendererRequest(rendererRequest) {
  const value = normalizeRendererRequest(rendererRequest);
  return value === null || RENDERER_REQUESTS.includes(value);
}

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
 * for the boundary. Customs, in any environment, unless the visitor opted out to deck.gl.
 *
 * The default flipped on 2026-09-02: the founder opened tarkovzero.com and said "is this what i am
 * supposed to see? cause the map we build is not this" — the detailed buildings, the bridge
 * structure and the cooling towers all live in the Three renderer, and the site was serving the
 * deck.gl geometry to everyone who did not know to type a query parameter.
 *
 * A map with no Three data path (Reserve, Woods) is still deck.gl no matter what was asked for.
 */
export function canRunThreeRenderer({ mapKey, rendererRequest } = {}) {
  return THREE_RENDERER_MAPS.includes(mapKey)
    && normalizeRendererRequest(rendererRequest) !== DECK_RENDERER_REQUEST;
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

/**
 * (c) May the page draw its DIAGNOSTIC READOUTS — the CUSTOMS TRUTH strip and the vegetation
 * notice that sit over the middle of the map?
 *
 * Founder, 2026-09-02: *"also remove the notification boxes in the middle about the build."* They
 * are instruments, not product: the orange box is what tells us the exact terrain silently failed
 * to load and the frame is back on the fitted heightfield. On the live page it is a sentence a
 * visitor cannot act on, sitting on top of the map they came for.
 *
 * So they are hidden in a RELEASE build and kept on dev + loopback — the two places a developer is
 * looking at them. What is NOT hidden is the STATE: `renderStats().truth` and
 * `diagnostics().truth` publish the same composed strip in every environment, from the same call
 * that paints it, so the e2e gate still asserts production is on the promoted exact ground and the
 * promoted vegetation, and a degraded load is still detectable in production. Deleting the readout
 * would have deleted the evidence with it; this only stops drawing it.
 *
 * Deliberately a SEPARATE predicate from `canLoadLocalGameDerivedAssets`, even though the two
 * currently answer the same question. One is a licensing boundary and the other is a presentation
 * choice; fusing them would mean any future change to either silently moves the other, which is the
 * mistake this module already exists to have fixed once.
 *
 * `dev === true` is an identity check, not a truthiness check: `import.meta.env.DEV` is absent in a
 * production bundle and `undefined` must never read as permission.
 */
export function canShowDiagnosticReadouts({ dev, hostname } = {}) {
  return dev === true && isLoopbackHostname(hostname);
}

/**
 * The three URL switches that are INSTRUMENTS: each one deliberately makes the frame something
 * other than the frame a visitor came for. The value is what it does, quoted into the refusal, so
 * a reader who meets the message months from now does not have to find this file to know why.
 */
export const SCENE_MUTATING_INSTRUMENTS = Object.freeze({
  profileAblate: 'hides caster geometry (?profileAblate=props|rocks set propGroup/rockGroup.visible = false) or re-times the shadow pass — the picture is deliberately NOT the shipped one',
  profileSelfTest: 'makes the frame deliberately worse to prove the instrument discriminates (busy:N burns main-thread milliseconds; nocull disables frustum culling on every world root)',
  shadowAudit: 'runs a second requestAnimationFrame loop that fingerprints every shadow caster on every tick — a visitor pays for it and cannot read it',
});

/** The flag names of (e), in the order a reader meets them in docs/PROFILING.md §4. */
export const SCENE_MUTATING_INSTRUMENT_FLAGS = Object.freeze(Object.keys(SCENE_MUTATING_INSTRUMENTS));

/**
 * (e) May a DEV INSTRUMENT CHANGE WHAT THE FRAME DRAWS?
 *
 * Founder, 2026-09-03, at the push to production: keep `?profile=1` public — his RTX 5080 is the
 * only real GPU in this project and a baseline of the live site can only be taken on the live site
 * — but `?profileAblate=`, `?profileSelfTest=` and `?shadowAudit=` "are instruments, never a
 * candidate optimisation, and they have no business on a public map".
 *
 * LOOPBACK ONLY, AND DELIBERATELY NOT `dev`. This is the one input that separates (e) from (b) and
 * (c), and it is not a convenience:
 *
 *   - `docs/PROFILING.md` §3a's "exact sequence to run" is four loads of
 *     `http://127.0.0.1:4173/?profile=1&profileAblate=…` — a RELEASE `vite preview`, because a dev
 *     bundle is a different bundle (and `src/roadmap.js:37` throws in one under `vite preview`).
 *   - every fidelity proof this repo owns (`.e2e/p1v-capture.mjs`, `.e2e/p1-shadow-capture.mjs`,
 *     `.e2e/p1-ablation-ab.mjs`) serves a `vite build` output on 127.0.0.1 and asks for
 *     `?shadowAudit=1` / `?profileAblate=shadow`.
 *
 * `dev === true && isLoopbackHostname(hostname)` — the shape (b) and (c) use — is FALSE in exactly
 * that configuration, so reusing it would not have gated the instruments, it would have deleted
 * them: no ablation could ever again be run on the only real GPU in the project, and the P1
 * pixel-identity harness would stop being able to arm its own audit. That is the same mistake
 * gating `?profile=1` behind (c) would have been, one layer down.
 *
 * What it therefore answers, and all it answers: is this page being served to the machine that is
 * developing it? `tarkovzero.com`, a Vercel preview URL and a LAN address are all `false`.
 *
 * A REFUSAL IS LOUD, NEVER A NO-OP. `src/map3d-three.js` pairs every `false` here with
 * `sceneMutatingInstrumentRefusal()` — a `console.error` at boot, a REFUSED line on the profiler
 * panel, a `refused` row in `renderStats()`, and a THROW from `tz.profile()` / `tz.profileAB()`
 * rather than a report. This project's documented failure mode (handoff §7, eight instances) is a
 * system reporting success while something silently fell back; an ablation that was asked for and
 * quietly not applied, in a report that still says "ABLATION RUN", would be the ninth.
 */
export function canRunSceneMutatingInstruments({ hostname } = {}) {
  return isLoopbackHostname(hostname);
}

/**
 * The sentence a refused instrument prints — one function so the console, the panel, the published
 * state and the thrown error cannot drift apart, and so the message always says three things: that
 * NOTHING was applied, what the flag would have done, and where it still runs.
 */
export function sceneMutatingInstrumentRefusal(flag, { hostname } = {}) {
  const host = normalizeHostname(hostname) || 'this host';
  const what = SCENE_MUTATING_INSTRUMENTS[flag] ?? 'changes what the frame draws';
  return `?${flag} is a DEV INSTRUMENT and is REFUSED on "${host}". NOTHING WAS APPLIED — no picture`
    + ` or number from this load is instrumented, and any that says otherwise is wrong. It ${what}.`
    + ' It runs on a loopback host only (http://127.0.0.1:4173/ — a release `vite preview` counts,'
    + ' and is where the real-GPU runs are taken).'
    + ' ?profile=1, ?profilePresets=, ?profileFrames=, tz.profile() and ?shadows=live are NOT gated'
    + ' and still work here.';
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
    throw new Error(`The Three renderer serves ${THREE_RENDERER_MAPS.join('/')} unless ?renderer=${DECK_RENDERER_REQUEST} opts out`);
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
    // (c) — whether the truth strip and the vegetation notice are DRAWN. Never whether their state
    // is computed or published: `renderStats().truth` carries it either way.
    diagnosticReadouts: canShowDiagnosticReadouts({ dev, hostname }),
    // (e) — whether an instrument may CHANGE what the frame draws. Published because a report or a
    // screenshot has to be able to say whether an ablation could even have applied on this host.
    sceneMutatingInstruments: canRunSceneMutatingInstruments({ hostname }),
    localEnhancementReason: localEnhancements
      ? 'dev-loopback'
      : dev === true
        ? 'non-loopback-host'
        : 'release-build',
  });
}
