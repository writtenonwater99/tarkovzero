/**
 * TarkovZero — the assistant wire contract. ONE definition, imported by both halves:
 *
 *   server  api/assistant.js          (Vercel Node function; mints and validates)
 *   client  src/assistant.js + the chat panel  (consumes and renders)
 *
 * Pure data + pure functions. No DOM, no `node:` imports, no `import.meta.env` — so the same file
 * runs inside a serverless function, inside the Vite bundle, and inside a bare `node --test`.
 *
 * ===========================================================================================
 * REQUEST  POST /api/assistant
 * ===========================================================================================
 *   {
 *     message:        string,                       // the player's question (<= 2 KB of UTF-8)
 *     map:            'customs'|'reserve'|'woods',  // THE TAB THE PLAYER IS ON. Required in
 *                                                   // practice: an unknown value falls back to
 *                                                   // 'customs', so send it, always.
 *     selectedQuests?: string[],                    // slugs already on the map (<= 12)
 *     activeQuests?:   string[],                    // tarkov.dev task ids the GAME reports active
 *     history?:        {role:'user'|'assistant', content:string}[]   // last 8 turns
 *   }
 *
 * ===========================================================================================
 * RESPONSE 200  — the envelope. This is the whole contract; there is nothing to parse out of
 * `answer`. Every field below is present on every 200, even when empty.
 * ===========================================================================================
 *   {
 *     protocol: 2,                    // PROTOCOL_VERSION. Bump = breaking change.
 *     map:      'customs',            // ECHO: the map this answer was computed for. If it differs
 *                                     // from the tab the UI is on (the player switched while the
 *                                     // request was in flight), the answer is stale — say so or
 *                                     // drop it, never replay its actions.
 *     answer:   string,               // prose, markdown-lite (**bold**, `code`, "- " bullets)
 *     actions:  Action[],             // ordered, already validated against real data (<= 5)
 *     images:   ImageRef[],           // real image records, never model text (<= 4)
 *     imageIndexOk: boolean,          // false = the screenshot index could not be read this turn,
 *                                     // so `images` being empty means "unknown", not "none exist".
 *                                     // It exists so an outage cannot masquerade as an answer.
 *     quests:   string[],             // slugs the answer is about, <= 3 (legacy convenience;
 *                                     // the same slugs appear as selectQuest actions)
 *     sources:  Source[],             // the retrieved quests, with their map coverage
 *     cached?:  true                  // served from the 10-minute answer cache
 *   }
 *
 * RESPONSE non-200: `{ error: string }`. No envelope fields. 429 also sets `Retry-After`.
 *
 * ===========================================================================================
 * ACTION VOCABULARY — closed set. A type not listed here never leaves the server.
 * ===========================================================================================
 *   {type:'selectQuest', slug, name}
 *       Put that quest's objectives on the current map.  window.tz.quests.select(slug)
 *
 *   {type:'flyTo', objectiveId, slug, map}
 *       Centre the current map on that objective. `map` always equals the envelope's `map`, and
 *       the objective is GUARANTEED to have at least one marked zone there, so
 *       window.tz.quests.flyTo(objectiveId) has something to land on. Always preceded by the
 *       selectQuest action for `slug`.
 *
 *   {type:'switchMap', map, label, slug, name, objectiveId}
 *       THE CROSS-MAP HANDOFF. The subject of the question lives on a different map that this
 *       site can actually draw. Render it as a button ("Switch to Woods"); never perform it
 *       automatically — it reloads the page. `map` is one of SITE_MAPS and never the current one.
 *       `label` is the human map name ('Woods'). `slug`/`name` are the quest to select on arrival.
 *       `objectiveId` is what to fly to once there — it is a marked objective on the TARGET map,
 *       or null when the quest has no marked location there (then just select the quest).
 *       Never emitted for a map this site does not render (Shoreline, Streets, …): those the
 *       answer can only describe.
 *
 *   {type:'showImages', imageIds}
 *       Show these screenshots with the answer. Every id resolves to an entry in `images`.
 *       If `images` is non-empty this action is present; if the subject has no screenshot in the
 *       app's data both are empty. There is no placeholder and no "image coming soon".
 *
 * ===========================================================================================
 * IMAGE REFS — the model never sees or writes a URL.
 * ===========================================================================================
 *   {
 *     id:          'img1',      // server-minted, IMAGE_ID_RE, stable inside ONE response only
 *     url:         string,      // https://static.wikia.nocookie.net/... (IMAGE_HOSTS)
 *     caption:     string,      // wiki caption, '' when the wiki had none
 *     depicts:     string,      // what the shot shows, always non-empty: the caption, else the
 *                               // objective line, else the quest name
 *     map:         string,      // the map the shot was taken on ('customs' … 'streets-of-tarkov',
 *                               // or '' when the wiki did not say). NOT necessarily a site map.
 *     questSlug:   string,
 *     questName:   string,
 *     objectiveId: string|null, // set when the shot is attached to one objective
 *     credit:      string       // attribution — RENDER IT (EFT Wiki, CC BY-NC-SA)
 *   }
 *
 * Rendering rules for the UI: `loading="lazy"` and `referrerpolicy="no-referrer"` (what
 * src/quests.js's card already does), `alt` from `depicts`, and the credit visible once per group.
 *
 * ===========================================================================================
 * SOURCES — the quests retrieval actually looked at, with honest map coverage.
 * ===========================================================================================
 *   { slug, name, trader, wikiLink: string|null,
 *     maps:     string[],   // every map the quest mentions, site map or not
 *     siteMaps: string[] }  // the subset this site can draw. Empty = describable only:
 *                           // there is nothing to select, fly to or switch to.
 *
 * ===========================================================================================
 * WHAT THE SERVER GUARANTEES (so the UI does not re-litigate it)
 * ===========================================================================================
 * - every `slug` names a quest in quests.json, every `objectiveId` an objective of that quest
 * - a `flyTo` objective HAS a marked zone on the envelope's `map`
 * - a `switchMap` target is a SITE_MAPS key, is not the current map, and the quest really has
 *   objectives there; its `objectiveId` (when non-null) is marked on the TARGET map
 * - every `images[]` row was found in BOTH quests.json and quest-images.json, under the same
 *   quest id, on the one allowed host. The model never sees a URL, so it cannot invent one.
 * - `validateEnvelope()` below re-checks all of the shape-level claims client-side; it also
 *   reports `stale: true` when the echoed map is not the map the UI is on.
 */

/** Bump when a field changes meaning or disappears. Additive fields do NOT bump it. */
export const PROTOCOL_VERSION = 2;

/** The maps this site can actually draw. quests.json covers all eleven EFT maps; we render three. */
export const SITE_MAPS = Object.freeze(['customs', 'reserve', 'woods']);

/** Display names, for prose and for the switch-map button. */
export const MAP_LABELS = Object.freeze({ customs: 'Customs', reserve: 'Reserve', woods: 'Woods' });

/**
 * Names for the maps quests.json knows but this site cannot draw. Used to tell the player
 * "that one is on Shoreline, which TarkovZero doesn't have yet" instead of offering a dead button.
 */
export const OTHER_MAP_LABELS = Object.freeze({
  factory: 'Factory',
  interchange: 'Interchange',
  shoreline: 'Shoreline',
  lighthouse: 'Lighthouse',
  'streets-of-tarkov': 'Streets of Tarkov',
  'ground-zero': 'Ground Zero',
  'the-lab': 'The Lab',
  'the-labyrinth': 'The Labyrinth',
});

export const ACTION_TYPES = Object.freeze(['selectQuest', 'flyTo', 'switchMap', 'showImages']);

/** Server-minted image handles. The model may only ever echo one of these back. */
export const IMAGE_ID_RE = /^img([1-9][0-9]?)$/;
export const mintImageId = (i) => `img${i + 1}`;

/** The only host the wiki gallery ever uses (verified over all 1,380 embedded rows). */
export const IMAGE_HOSTS = Object.freeze(['static.wikia.nocookie.net']);

/** Shapes that exist in quests.json: every slug, every objective id, on all 517 quests. */
export const SLUG_RE = /^[a-z0-9-]{1,80}$/;
export const OBJECTIVE_ID_RE = /^[0-9a-f]{24}$/;

export const MAX_ACTIONS = 5;
export const MAX_IMAGES = 4;
export const MAX_QUESTS = 3;

export const isSiteMap = (k) => SITE_MAPS.includes(String(k));
export const mapLabel = (k) => MAP_LABELS[String(k)] ?? OTHER_MAP_LABELS[String(k)] ?? String(k ?? '');
export const knownMap = (k) => isSiteMap(k) || Object.prototype.hasOwnProperty.call(OTHER_MAP_LABELS, String(k));

/** A map key we are willing to act on. Anything else becomes `fallback`. */
export const normalizeMapKey = (k, fallback = 'customs') => (isSiteMap(k) ? String(k) : fallback);

/** Is this a URL we are willing to put in an <img src>? https + the wiki CDN, nothing else. */
export function isAllowedImageUrl(url) {
  if (typeof url !== 'string' || url.length > 600) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === 'https:' && IMAGE_HOSTS.includes(u.host);
}

/** Shape check for one image ref — the same predicate the server mints against. */
export function isValidImageRef(ref) {
  return !!ref && typeof ref === 'object'
    && typeof ref.id === 'string' && IMAGE_ID_RE.test(ref.id)
    && isAllowedImageUrl(ref.url)
    && typeof ref.depicts === 'string' && ref.depicts.length > 0
    && typeof ref.questSlug === 'string' && SLUG_RE.test(ref.questSlug)
    && (ref.objectiveId === null || (typeof ref.objectiveId === 'string' && OBJECTIVE_ID_RE.test(ref.objectiveId)));
}

/**
 * Shape check for one action, in the context of the map the answer is for and the image ids the
 * envelope carries. Structural only — it cannot know whether a slug exists, which is why the
 * server validates against quests.json *before* this and the client re-checks shape after.
 *
 * `imageIds` omitted (null) means "no envelope to check against, shape only". Passing the array —
 * INCLUDING an empty one — makes membership mandatory, so a `showImages` on an envelope that
 * carries no images is invalid rather than vacuously fine.
 */
export function isValidAction(a, { map, imageIds = null } = {}) {
  if (!a || typeof a !== 'object' || !ACTION_TYPES.includes(a.type)) return false;
  switch (a.type) {
    case 'selectQuest':
      return typeof a.slug === 'string' && SLUG_RE.test(a.slug);
    case 'flyTo':
      return typeof a.objectiveId === 'string' && OBJECTIVE_ID_RE.test(a.objectiveId)
        && typeof a.slug === 'string' && SLUG_RE.test(a.slug)
        && (map === undefined || a.map === map);
    case 'switchMap':
      return isSiteMap(a.map) && a.map !== map
        && typeof a.slug === 'string' && SLUG_RE.test(a.slug)
        && (a.objectiveId === null || (typeof a.objectiveId === 'string' && OBJECTIVE_ID_RE.test(a.objectiveId)));
    case 'showImages':
      return Array.isArray(a.imageIds) && a.imageIds.length > 0
        && a.imageIds.every((id) => typeof id === 'string' && IMAGE_ID_RE.test(id)
          && (imageIds === null || imageIds.includes(id)));
    default:
      return false;
  }
}

/**
 * Defensive read of a 200 body, for the client. The server already validated everything against
 * quests.json; this is the second gate that means a UI bug or a stale/renamed deployment degrades
 * to "prose with no buttons" instead of firing an action at data that is not there.
 *
 * Returns a fully-shaped envelope, always — never throws, never returns null.
 */
export function validateEnvelope(body, { map } = {}) {
  const src = body && typeof body === 'object' ? body : {};
  const echoed = normalizeMapKey(src.map, isSiteMap(map) ? map : 'customs');
  const images = (Array.isArray(src.images) ? src.images : []).filter(isValidImageRef).slice(0, MAX_IMAGES);
  const imageIds = images.map((i) => i.id);
  const actions = (Array.isArray(src.actions) ? src.actions : [])
    .filter((a) => isValidAction(a, { map: echoed, imageIds }))
    .slice(0, MAX_ACTIONS);
  return {
    protocol: Number.isInteger(src.protocol) ? src.protocol : 0,
    map: echoed,
    stale: isSiteMap(map) ? echoed !== map : false,
    answer: typeof src.answer === 'string' ? src.answer : '',
    actions,
    images,
    imageIndexOk: src.imageIndexOk !== false,
    quests: (Array.isArray(src.quests) ? src.quests : []).filter((s) => typeof s === 'string' && SLUG_RE.test(s)).slice(0, MAX_QUESTS),
    sources: Array.isArray(src.sources) ? src.sources.filter((s) => s && typeof s === 'object') : [],
    cached: src.cached === true,
  };
}

/** The empty 200 body, so both halves agree on what "nothing to say" looks like. */
export const emptyEnvelope = (map, answer = '') => ({
  protocol: PROTOCOL_VERSION,
  map: normalizeMapKey(map),
  answer,
  actions: [],
  images: [],
  imageIndexOk: true,
  quests: [],
  sources: [],
});
