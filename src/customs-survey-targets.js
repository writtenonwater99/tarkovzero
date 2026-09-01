/**
 * Survey targets — the in-raid walk list for the Customs rail stock (localhost only).
 *
 * The roster is user-owned, game-derived truth living in the gitignored
 * `.local-game-derived/` root OUTSIDE `public/`. It is pulled in here by a dynamic import that
 * sits inside a statically-false `import.meta.env.DEV` branch in a production build, so Rollup
 * drops the branch and the bytes never reach `dist/` — and `npm run verify:build-boundary` hashes
 * every file under that root against the build output, so a leak fails the build loudly instead of
 * shipping quietly.
 *
 * On top of that: the loopback check from `customs-local-terrain-loader.js`, so even a dev bundle
 * served off a non-loopback host renders nothing. Every failure is silent by contract — a missing
 * roster is the normal case for everyone who is not the founder on this machine.
 */

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** One colour per rolling-stock family. Distinct hues, all readable on satellite and vector. */
export const SURVEY_FAMILY_COLORS = Object.freeze({
  'tank-wagon': '#ff9f1c',
  'closed-freight-wagon': '#2ec4b6',
  'hopper-wagon': '#e63946',
  'gondola-wagon': '#8367ff',
  locomotive: '#ffd60a',
  'sliding-door-boxcar': '#43aa8b',
});

export const SURVEY_FALLBACK_COLOR = '#c9d1d9';

export const surveyColor = (family) => SURVEY_FAMILY_COLORS[family] ?? SURVEY_FALLBACK_COLOR;

/** True only on a loopback page URL — the same rule the local terrain package uses. */
export function isLoopbackPage(locationValue = globalThis.location) {
  const raw = typeof locationValue === 'string' ? locationValue : locationValue?.href;
  if (!raw) return false;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  return ['http:', 'https:'].includes(parsed.protocol)
    && LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())
    && !parsed.username
    && !parsed.password;
}

/** Keep only rows that carry the fields the map actually draws. */
function normalize(value) {
  const targets = Array.isArray(value?.targets) ? value.targets : [];
  return targets
    .filter((t) => t && Number.isFinite(t.x) && Number.isFinite(t.z) && Number.isFinite(t.n))
    .map((t) => ({
      id: String(t.id ?? `rail-${t.n}`),
      n: Number(t.n),
      family: String(t.family ?? 'unknown'),
      sourceName: String(t.sourceName ?? ''),
      x: Number(t.x),
      y: Number.isFinite(t.y) ? Number(t.y) : null,
      z: Number(t.z),
      stop: Number.isFinite(t.stop) ? Number(t.stop) : null,
      stopName: String(t.stopName ?? ''),
      elevated: t.elevated === true,
      priority: String(t.priority ?? 'normal'),
      // Survey progress, recomputed from the geo-tagged screenshots after each raid.
      status: t.status === 'done' ? 'done' : 'remaining',
      shotCount: Number.isFinite(t.shotCount) ? Number(t.shotCount) : 0,
      closestM: Number.isFinite(t.closestM) ? Number(t.closestM) : null,
      shoot: String(t.shoot ?? ''),
    }))
    .sort((a, b) => a.n - b.n);
}

/**
 * Load the roster, or return `[]`. Never throws, never logs, never blocks the map.
 *
 * @param {string} mapKey the map being rendered; anything but `customs` returns `[]`.
 */
export async function loadSurveyTargets(mapKey) {
  if (mapKey !== 'customs') return [];
  if (!import.meta.env.DEV) return [];
  if (!isLoopbackPage()) return [];
  try {
    const mod = await import('../.local-game-derived/unity-facts/survey-targets.json');
    return normalize(mod?.default ?? mod);
  } catch {
    return [];
  }
}
