/**
 * TarkovZero — THE map availability source. One list; every consumer reads it.
 *
 * Two questions used to be answered by two hand-typed lists that nothing forced to agree:
 *
 *   * `MAPS` in `src/mapdata.js` — which maps the picker offered and `?map=` could reach;
 *   * `SITE_MAPS` in `src/assistant-contract.js` — which maps the assistant was allowed to
 *     offer a `switchMap` button to.
 *
 * They happened to hold the same three keys, so nothing caught the class of bug that appears the
 * moment they diverge: the assistant offering "Switch to Woods" beside a picker that will not open
 * Woods. That is a button that goes nowhere — the exact failure `docs/CONTINUATION-HANDOFF-
 * 2026-09-02.md` §6 is about. So availability is defined ONCE, here, and both halves derive from
 * it. There is no second list to update.
 *
 * ---------------------------------------------------------------------------------------------
 * AVAILABILITY IS NOT THE SAME QUESTION AS "DO WE HAVE THE DATA"
 * ---------------------------------------------------------------------------------------------
 * `MAPPED_MAP_KEYS` names the maps this repo ships render data for — tiles, labels, `<map>-3d.json`,
 * quest zones. It still holds three: customs, reserve, woods. Nothing about Reserve and Woods was
 * deleted; `MAPS` still carries their configs, `LABELS` still carries their place names, their
 * quests still have zones and every one of their tests still runs.
 *
 * `AVAILABLE_MAP_KEYS` names the maps a VISITOR may open. It holds one.
 *
 * Founder, 2026-09-02: *"on the live page for now on the maps tab put all the maps but lock them.
 * even the woods/reserve. so rn customs is what avalible."* Reserve and Woods work today, and that
 * is precisely the problem he is solving: beside a finished Customs they would draw as the older
 * map, and he would rather show them as coming than ship the comparison. Locking working navigation
 * is a deliberate product choice, not a defect and not a TODO.
 *
 * TO UNLOCK A MAP: add its key to `AVAILABLE_MAP_KEYS`. The picker, `?map=`, the omnibox's
 * `> map` command, the raid-switch toast and the assistant's `switchMap` handoff all follow from
 * that one edit — and a map with no entry in `MAPPED_MAP_KEYS` will not resolve to a config, which
 * is why `assertAvailabilityIsBuildable()` exists.
 *
 * Pure data + pure functions. No DOM, no `node:` imports, no `import.meta.env` — the same file runs
 * inside a Vercel serverless function, inside the Vite bundle, and inside a bare `node --test`.
 */

/**
 * The eleven Escape from Tarkov maps this project names, keyed exactly as `quests.json` keys them
 * (that file is where these strings have to match something). Customs first because it is the one
 * that opens; the rest are alphabetical, which is the order the picker shows them in.
 *
 * `icebreaker` appears on 20 quests in quests.json and is deliberately NOT here: it is not one of
 * the eleven, it has never had a label, and adding it to the picker would advertise a twelfth map.
 * That is a pre-existing gap in the assistant's off-site vocabulary, unchanged by this file.
 */
export const EFT_MAPS = Object.freeze([
  Object.freeze({ key: 'customs', name: 'Customs' }),
  Object.freeze({ key: 'factory', name: 'Factory' }),
  Object.freeze({ key: 'ground-zero', name: 'Ground Zero' }),
  Object.freeze({ key: 'interchange', name: 'Interchange' }),
  Object.freeze({ key: 'lighthouse', name: 'Lighthouse' }),
  Object.freeze({ key: 'reserve', name: 'Reserve' }),
  Object.freeze({ key: 'shoreline', name: 'Shoreline' }),
  Object.freeze({ key: 'streets-of-tarkov', name: 'Streets of Tarkov' }),
  Object.freeze({ key: 'the-lab', name: 'The Lab' }),
  Object.freeze({ key: 'the-labyrinth', name: 'The Labyrinth' }),
  Object.freeze({ key: 'woods', name: 'Woods' }),
]);

/** Every map key the picker lists, in picker order. */
export const EFT_MAP_KEYS = Object.freeze(EFT_MAPS.map((m) => m.key));

/** Display names for all eleven. */
export const MAP_NAMES = Object.freeze(Object.fromEntries(EFT_MAPS.map((m) => [m.key, m.name])));

/**
 * THE availability list. The maps a visitor may open.
 *
 * Everything else in this module is derived from it, so this array is the single edit that
 * unlocks or locks a map across the whole app.
 */
export const AVAILABLE_MAP_KEYS = Object.freeze(['customs']);

/**
 * The maps this repo ships render data for. NOT an availability statement — Reserve and Woods are
 * in here and are locked. It exists so `assertAvailabilityIsBuildable()` can refuse an availability
 * list naming a map that has no config to load, and so `scripts/build-quests.mjs` stops carrying a
 * fourth hand-typed copy of the same three keys.
 */
export const MAPPED_MAP_KEYS = Object.freeze(['customs', 'reserve', 'woods']);

/** Everything the picker shows but will not open. Derived — never typed out. */
export const LOCKED_MAP_KEYS = Object.freeze(EFT_MAP_KEYS.filter((k) => !AVAILABLE_MAP_KEYS.includes(k)));

/**
 * Every predicate below is an EXACT match against the canonical key. Normalising is the caller's
 * job, through `normalizeMapRequestKey()` — deliberately, because the two callers want different
 * things from a sloppy value: a URL or a typed command should forgive `Woods `, while the assistant
 * wire contract must NOT quietly accept `CUSTOMS` and then echo it back un-normalised into an
 * envelope whose `map` no longer string-compares against the tab it came from.
 */
const canonical = (k) => String(k);

/** Fold a human-supplied value (`?map=`, `> map <arg>`) onto a canonical key. */
export const normalizeMapRequestKey = (k) => String(k ?? '').trim().toLowerCase();

/** One of the eleven? */
export const isEftMap = (k) => EFT_MAP_KEYS.includes(canonical(k));
/** May a visitor open it? This is the ONE predicate navigation and `switchMap` are allowed to ask. */
export const isAvailableMap = (k) => AVAILABLE_MAP_KEYS.includes(canonical(k));
/** One of the eleven, but not open. */
export const isLockedMap = (k) => LOCKED_MAP_KEYS.includes(canonical(k));
/** Do we ship render data for it? Independent of whether it opens. */
export const isMappedMap = (k) => MAPPED_MAP_KEYS.includes(canonical(k));
/** Display name, or the key back when we have never heard of it. */
export const mapName = (k) => MAP_NAMES[canonical(k)] ?? String(k ?? '');

/** `'available' | 'locked' | 'unknown'` — the three answers, so a caller cannot invent a fourth. */
export function mapAvailability(k) {
  if (isAvailableMap(k)) return 'available';
  if (isLockedMap(k)) return 'locked';
  return 'unknown';
}

/**
 * What a locked entry says. Short, and true of every locked map at once: eight of them have never
 * been built, and Reserve and Woods are built but withheld. "Soon" is the only word that is honest
 * about both, and it is the founder's own framing ("show them as coming").
 *
 * `LOCKED_NOTE` is what a reader hears — a tooltip and the accessible name — because a two-letter
 * badge on its own is decoration, not an explanation.
 */
export const LOCKED_BADGE = 'SOON';
export const LOCKED_NOTE = 'not available yet';

/**
 * Fail loudly if the availability list ever names a map with no render data, which would give the
 * picker an entry that opens onto nothing. Called at module load by `src/mapdata.js`, where the
 * configs actually live, so an impossible availability list cannot boot the app.
 */
export function assertAvailabilityIsBuildable(mappedKeys = MAPPED_MAP_KEYS) {
  const orphans = AVAILABLE_MAP_KEYS.filter((k) => !mappedKeys.includes(k));
  if (orphans.length) {
    throw new Error(`map availability names ${orphans.join(', ')}, which this build has no map data for`);
  }
  const unknown = AVAILABLE_MAP_KEYS.filter((k) => !EFT_MAP_KEYS.includes(k));
  if (unknown.length) throw new Error(`map availability names ${unknown.join(', ')}, which is not an EFT map`);
  return true;
}
