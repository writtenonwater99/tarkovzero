/**
 * TarkovZero — AI quest assistant (Vercel Node serverless function).
 *
 * POST /api/assistant  { message, map, selectedQuests?, activeQuests?, history? }
 *   `map` is the map the player's tab is on. It is not decoration: it picks the retrieval bonus,
 *   it is stated to the model, every objective in the grounding block says whether it has markers
 *   there, and it is echoed back on the answer so a reply that arrives after the player has
 *   switched maps can be recognised as stale.
 *   `activeQuests` are tarkov.dev task ids the player's game reports as active (the companion
 *   reads them out of EFT's own logs). Optional in every sense: absent, empty or unknown ids
 *   change nothing except a line of context and a small ranking nudge.
 *
 * The response envelope — every field, every rule — is defined ONCE in src/assistant-contract.js,
 * which this file and the chat panel both import. Read that file before changing this one.
 *
 * How it works: retrieval over public/data/quests.json (fuzzy rank against name / trader /
 * objective text, current map preferred) -> a compact grounding block, including a numbered
 * catalogue of the screenshots those quests actually have -> DeepSeek chat completion in JSON
 * mode. Every action the model returns is re-derived from the retrieved quests, so a hallucinated
 * slug, objective id or map can never reach the client; and the model is never shown an image URL
 * (it picks catalogue ids), so it has nothing to fabricate one out of.
 *
 * The DeepSeek key is read from process.env.DEEPSEEK_API_KEY on the server only. It is never
 * logged and never included in a response.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROTOCOL_VERSION, SITE_MAPS, MAP_LABELS, OTHER_MAP_LABELS,
  MAX_IMAGES, MAX_QUESTS, mapLabel, isSiteMap, normalizeMapKey,
  isAllowedImageUrl, mintImageId, IMAGE_ID_RE, isValidImageRef, isValidAction,
} from '../src/assistant-contract.js';

const MODEL = 'deepseek-chat';
const ENDPOINT = 'https://api.deepseek.com/chat/completions';
const MAX_MESSAGE = 2048;          // bytes of user text we accept
const MAX_HISTORY = 8;             // turns kept from the client
const RATE_LIMIT = 20;             // requests…
const RATE_WINDOW = 60_000;        // …per minute per IP
const UPSTREAM_TIMEOUT = 12_000;
const CACHE_TTL = 10 * 60_000;
const TOP_K = 3;
const CATALOG_MAX = 8;             // screenshots offered to the model (it may pick MAX_IMAGES)

/* ------------------------------------------------------------------ data -- */

let questsPromise = null;
let imagesPromise = null;

/**
 * Read one of our public data files: bundled copy first (three candidate roots, because the
 * function's cwd differs between `vercel dev` and the deployed lambda), our own deployment URL
 * last. Returns null instead of throwing when `required` is false.
 */
async function loadPublicJson(req, name) {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const candidates = [
    join(process.cwd(), 'public', 'data', name),
    join(here, '..', 'public', 'data', name),
    join('/var/task', 'public', 'data', name),
  ];
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* try the next one */ }
  }
  // Fallback: read it back off our own deployment (these are public static assets).
  const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host;
  if (host) {
    const proto = /^(localhost|127\.)/.test(host) ? 'http' : 'https';
    try {
      const r = await fetch(`${proto}://${host}/data/${name}`);
      if (r.ok) {
        const parsed = await r.json();
        if (parsed && typeof parsed === 'object') return parsed;
      }
    } catch { /* fall through */ }
  }
  return null;
}

/** Load quests.json once per lambda instance. Fatal: without it there is no answer to give. */
function loadQuests(req) {
  if (questsPromise) return questsPromise;
  questsPromise = (async () => {
    const arr = await loadPublicJson(req, 'quests.json');
    if (!Array.isArray(arr) || !arr.length) throw new Error('quests.json unavailable');
    return index(arr);
  })().catch((e) => { questsPromise = null; throw e; });
  return questsPromise;
}

/**
 * The image allow-list: quest id -> the set of URLs the wiki scraper recorded for that quest
 * (public/data/quest-images.json, built by scripts/fetch-quest-images.mjs).
 *
 * quests.json already embeds these rows, so this is a SECOND, independent source for the same
 * fact, and an image is only ever offered when both agree. That is the whole point: if a future
 * build-quests run ever synthesised an image row, or a quests.json row were tampered with, the
 * URL would not be in this file and the reference would be dropped rather than rendered.
 *
 * Not fatal. When it cannot be read the catalogue is empty and `imageIndexOk` on the envelope
 * says so — an outage must not be indistinguishable from "this quest has no screenshots".
 */
function loadImageAllow(req) {
  if (imagesPromise) return imagesPromise;
  imagesPromise = (async () => {
    const obj = await loadPublicJson(req, 'quest-images.json');
    if (!obj || Array.isArray(obj)) return null;
    const allow = new Map();
    for (const [questId, rows] of Object.entries(obj)) {
      if (questId.startsWith('_') || !Array.isArray(rows)) continue;
      const urls = new Set();
      for (const row of rows) if (row && isAllowedImageUrl(row.url)) urls.add(row.url);
      if (urls.size) allow.set(questId, urls);
    }
    return allow.size ? allow : null;
  })()
    // a miss is not cached: a cold lambda that lost one fetch must not lose photos for its life
    .then((allow) => { if (!allow) imagesPromise = null; return allow; })
    .catch(() => { imagesPromise = null; return null; });
  return imagesPromise;
}

/** Precompute the per-quest search fields once (bigrams, token sets) - reused for every request. */
export function index(all) {
  return all.map((q) => {
    const name = norm(q.name);
    const objText = (q.objectives ?? []).map((o) => o.text ?? '').join(' ');
    const items = [...new Set((q.objectives ?? []).map((o) => o.item).filter(Boolean))];
    return {
      q,
      name,
      nameWords: name.split(' ').filter(Boolean),
      nameGrams: bigrams(name),
      trader: norm(q.trader),
      tokens: new Set(tokens(`${q.name} ${q.trader} ${objText} ${items.join(' ')}`)),
      nameTokens: new Set(tokens(q.name)),
      itemTokens: new Set(tokens(items.join(' '))),
    };
  });
}

/* -------------------------------------------------------------- ranking --- */

const STOP = new Set(('the a an and or of for to on in at it its is are was be do does how what where which who whom why '
  + 'when can could should would i me my mine you your we our us they them this that these those there here with without '
  + 'about into from by as if then than so just please help need want get got give show tell find look looking any all '
  + 'some no not quest quests task tasks tarkov eft map maps objective objectives complete completing done').split(' '));

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = (s) => norm(s).split(' ').filter((t) => t.length > 2 && !STOP.has(t));

function bigrams(s) {
  const t = s.replace(/ /g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}
function dice(a, b) {
  if (!a.size || !b.size) return 0;
  let hits = 0;
  for (const g of a) if (b.has(g)) hits++;
  return (2 * hits) / (a.size + b.size);
}

/**
 * Rank quests against the user's message.
 * Signals: exact/fuzzy quest-name match (dominant), trader name, item and objective-text tokens,
 * plus a bonus when the quest actually has objectives on the map the player is looking at.
 */
export function rank(entries, message, map, { limit = TOP_K, activeIds = null } = {}) {
  const activeSet = activeIds instanceof Set ? activeIds : new Set(Array.isArray(activeIds) ? activeIds : []);
  const msg = norm(message);
  const words = msg.split(' ').filter(Boolean).slice(0, 24);
  const msgTokens = new Set(tokens(message));
  const msgNums = new Set(msg.match(/\d+/g) ?? []);
  const mapKey = SITE_MAPS.includes(String(map)) ? String(map) : null;
  const scored = [];

  for (const e of entries) {
    let score = 0;
    // whole quest name appears verbatim in the message - the strongest possible signal
    if (e.name.length > 3 && msg.includes(e.name)) score += 40 + e.nameWords.length * 4;
    else {
      // fuzzy: best character-bigram overlap over sliding windows the size of the quest name
      const n = Math.max(1, e.nameWords.length);
      let best = 0;
      for (let i = 0; i < words.length; i++) {
        for (const len of new Set([n, n + 1, Math.max(1, n - 1)])) {
          if (i + len > words.length) continue;
          best = Math.max(best, dice(e.nameGrams, bigrams(words.slice(i, i + len).join(' '))));
        }
      }
      if (best > 0.55) score += 34 * best;
      else if (best > 0.4) score += 12 * best;
    }
    for (const t of e.nameTokens) if (msgTokens.has(t)) score += 6;
    // "punisher part 4" must beat "part 1": bigram similarity can't tell those apart
    if (msgNums.size) {
      const nums = e.name.match(/\d+/g) ?? [];
      for (const n of nums) if (msgNums.has(n)) score += 7;
      if (nums.length && !nums.some((n) => msgNums.has(n))) score -= 6;
    }
    if (e.trader && msg.includes(e.trader)) score += 9;
    for (const t of e.itemTokens) if (msgTokens.has(t)) score += 3;
    let obj = 0;
    for (const t of msgTokens) if (e.tokens.has(t)) obj += 1.2;
    score += Math.min(obj, 12);

    if (score <= 0) continue;
    // "How do I finish part 3" from a player whose game says they are ON part 3 should not land on
    // part 1. A nudge, not an override: a quest the message names outright still wins.
    if (activeSet.size && activeSet.has(e.q.id)) score += 5;
    if (mapKey) {
      if ((e.q.siteMaps ?? []).includes(mapKey)) score += 6;
      else if ((e.q.maps ?? []).includes(mapKey)) score += 2.5;
      else score -= 1.5;
    }
    if (score <= 0) continue;
    scored.push({ q: e.q, score });
  }

  scored.sort((a, b) => b.score - a.score || a.q.name.localeCompare(b.q.name));
  return scored.slice(0, limit);
}

/* ------------------------------------------------- the game's active set --- */
// Three tiny pure functions, exported so scripts/test-assistant.mjs can hold the whole
// active-quest feature to account: what the request body is allowed to contain, which of those ids
// the model is told about, and the fact that the answer cache is keyed on them.

/** Task ids the client sent, as a list this server will act on. Untrusted input. */
export const MAX_ACTIVE = 60;
export function normalizeActiveIds(list) {
  return (Array.isArray(list) ? list : [])
    .filter((s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s.trim()))
    .map((s) => s.trim())
    .slice(0, MAX_ACTIVE);
}

/**
 * The names behind those ids, for the prompt. Ids with no row in quests.json are dropped: the same
 * message shape carries trader chatter, and the model must never be told about a quest we cannot
 * name. Capped so the system prompt stays small.
 */
export function activeQuestNames(entries, activeIds, limit = 12) {
  const want = activeIds instanceof Set ? activeIds : new Set(normalizeActiveIds(activeIds));
  if (!want.size) return [];
  return entries.filter((e) => want.has(e.q.id)).map((e) => e.q.name).slice(0, limit);
}

/**
 * The answer-cache key. The active set rides in the prompt, so it rides in the key: the same
 * question asked before and after the player accepts a quest is not the same question.
 *
 * The fields are joined on U+0001 — an invisible byte in the source, and deliberately one that no
 * map key, message or task id can contain, so two different requests can never collide on it.
 */
export function cacheKeyFor({ map, message, history = [], activeIds = [] }) {
  return [
    map,
    String(message ?? '').toLowerCase(),
    history.map((h) => h.role + h.content.length).join('.'),
    [...activeIds].join('.'),
  ].join('');
}

/* ------------------------------------------------------------- images ----- */

const clip = (s, n) => (String(s ?? '').length > n ? String(s).slice(0, n - 1) + '…' : String(s ?? ''));
const IMAGE_CREDIT = 'EFT Wiki (Fandom), CC BY-NC-SA';

/**
 * The screenshots the retrieved quests actually have, minted as `img1`, `img2`, … — the ONLY
 * image handles that exist in this request. Two independent sources must agree on every row:
 * the embedded `images` array in quests.json AND the URL set in quest-images.json for the same
 * quest id (`allow`). No allow-list, no catalogue.
 *
 * The model is shown ids and captions and never a URL, so `showImages` can only ever *select*
 * from this list. Order is map-aware: shots taken on the map the player is looking at come first.
 */
export function imageCatalog(hits, allow, map, limit = CATALOG_MAX) {
  const refs = [];
  if (!(allow instanceof Map)) return { refs, byId: new Map(), available: false };
  const seen = new Set();
  const rows = [];
  for (const { q } of hits) {
    const urls = allow.get(q.id);
    if (!urls) continue;
    const push = (im, objective) => {
      if (!im || !isAllowedImageUrl(im.url) || !urls.has(im.url) || seen.has(im.url)) return;
      seen.add(im.url);
      const caption = typeof im.caption === 'string' ? clip(im.caption, 160) : '';
      rows.push({
        url: im.url,
        caption,
        depicts: caption || clip(objective?.text, 160) || q.name,
        map: typeof im.map === 'string' ? im.map : '',
        questSlug: q.slug,
        questName: q.name,
        objectiveId: objective ? objective.id : null,
        credit: IMAGE_CREDIT,
      });
    };
    for (const o of q.objectives ?? []) for (const im of o.images ?? []) push(im, o);
    for (const im of q.images ?? []) push(im, null);
  }
  // a shot of the map the player is on is the useful one; everything else keeps its order
  rows.sort((a, b) => (a.map === map ? 0 : 1) - (b.map === map ? 0 : 1));
  for (const row of rows.slice(0, limit)) refs.push({ id: mintImageId(refs.length), ...row });
  return { refs, byId: new Map(refs.map((r) => [r.id, r])), available: true };
}

/**
 * The image refs the answer carries. The model's `showImages.imageIds` are looked up in the mint
 * table and nothing else is read from its output — an id that was never minted resolves to
 * nothing, and a `url` field on a model action is ignored because no code path reads one.
 * A subject with no screenshot returns [], never a placeholder.
 */
export function buildImages(catalog, modelOut, slugs = []) {
  const byId = catalog?.byId instanceof Map ? catalog.byId : new Map();
  if (!byId.size) return [];
  const out = [];
  const take = (ref) => {
    if (!ref || out.includes(ref)) return;
    // belt and braces: the mint table is ours, but the shape gate is the contract's
    if (isValidImageRef(ref) && out.length < MAX_IMAGES) out.push(ref);
  };
  for (const a of modelOut?.actions ?? []) {
    if (!a || a.type !== 'showImages' || !Array.isArray(a.imageIds)) continue;
    for (const id of a.imageIds) if (typeof id === 'string' && IMAGE_ID_RE.test(id)) take(byId.get(id));
  }
  // The model asked for no photos but the answer is about a quest that has some: show the ones
  // belonging to the quests we are actually putting on the map, rather than none at all.
  if (!out.length && slugs.length) {
    for (const ref of catalog.refs) if (slugs.includes(ref.questSlug)) take(ref);
  }
  return out;
}

/* ---------------------------------------------------------- grounding ----- */

/** How a quest's maps read to the model, given the map the player is on. */
export function mapCoverage(q, map) {
  const site = (q.siteMaps ?? []).filter(isSiteMap);
  const here = site.includes(map);
  const elsewhere = site.filter((m) => m !== map);
  const offSite = [...new Set([...(q.maps ?? []), ...(q.objectives ?? []).flatMap((o) => (o.zones ?? []).map((z) => z.map))])]
    .filter((m) => !isSiteMap(m) && Object.prototype.hasOwnProperty.call(OTHER_MAP_LABELS, m));
  return { here, elsewhere, offSite };
}

/** Compact, token-cheap context for the model. Only facts that exist in quests.json. */
export function groundingFor(hits, map, catalog = null) {
  const cov = (q) => {
    const { here, elsewhere, offSite } = mapCoverage(q, map);
    const bits = [here ? `HAS MARKERS ON ${map}` : `NOTHING TO DRAW ON ${map}`];
    if (elsewhere.length) bits.push(`openable here instead: ${elsewhere.join(', ')}`);
    // "CANNOT OPEN", not "DOES NOT HAVE". Since 2026-09-02 this list carries Reserve and Woods,
    // which the site DOES have and will not open — telling the model we do not have them would put
    // a false sentence in front of a player who can see them greyed out in the picker.
    if (offSite.length) bits.push(`also on ${offSite.join(', ')} - MAPS TARKOVZERO CANNOT OPEN`);
    return bits.join(' | ');
  };
  const blocks = hits.map(({ q }, i) => {
    const lines = [];
    lines.push(`[${i + 1}] ${q.name} - trader ${q.trader}, min level ${q.minLevel ?? 0}`);
    lines.push(`    slug: ${q.slug} | maps: ${(q.maps ?? []).join(', ') || 'none'}`);
    lines.push(`    ${cov(q)}`);
    if (q.wikiLink) lines.push(`    wiki: ${q.wikiLink}`);
    for (const o of (q.objectives ?? []).slice(0, 12)) {
      const zones = (o.zones ?? []).filter((z) => z.map === map);
      const where = [...new Set((o.zones ?? []).map((z) => z.map))].join('/') || (o.maps ?? []).join('/') || 'anywhere';
      const bits = [
        `id ${o.id}`,
        o.type,
        `"${clip(o.text, 200)}"`,
        `on ${where}`,
        zones.length ? `${zones.length} marked location${zones.length > 1 ? 's' : ''} on ${map}` : `no markers on ${map}`,
      ];
      if (o.count > 1) bits.push(`count ${o.count}`);
      if (o.item) bits.push(`item ${o.item}`);
      if (o.optional) bits.push('OPTIONAL');
      lines.push(`    - ${bits.join(' | ')}`);
    }
    return lines.join('\n');
  });

  const refs = catalog?.refs ?? [];
  if (refs.length) {
    blocks.push(`PHOTOS (screenshots this site already has - reference them BY ID, never by URL):\n${
      refs.map((r) => `  ${r.id} | ${r.questName}${r.objectiveId ? ` | objective ${r.objectiveId}` : ''}${
        r.map ? ` | taken on ${r.map}` : ''} | "${clip(r.depicts, 120)}"`).join('\n')}`);
  } else {
    blocks.push('PHOTOS: none of these quests has a screenshot. Do not offer one.');
  }
  return blocks.join('\n');
}

/**
 * How the switchMap line reads, and whether it is offered at all.
 *
 * Derived from SITE_MAPS rather than written down, because SITE_MAPS is the availability list and
 * it can be one entry long — it is, since 2026-09-02. With one open map a cross-map handoff is
 * impossible: `crossMapFor()` can never return one and `isValidAction()` would reject it. Teaching
 * the model a verb the server will always refuse is how "want to move to that map?" prose ends up
 * beside no button, so the vocabulary shrinks with the availability list.
 */
const SWITCH_MAP_LINE = SITE_MAPS.length > 1
  ? `  {"type":"switchMap","map":"${SITE_MAPS.join('|')}"} the quest's objectives are on one of the other maps this site opens.
                                                     The site offers it as a button; the player decides, so word the answer as an offer
                                                     ("that one is on Woods - want to move there?"), not as something already done.\n`
  : '';

const SYSTEM = (map, selected, activeNames = []) => `You are the quest assistant built into TarkovZero, an interactive Escape from Tarkov map.

THE MAP THE PLAYER IS ON RIGHT NOW: ${map} (${mapLabel(map)}). Answer for THIS map first.
TarkovZero can open ${SITE_MAPS.length === 1 ? 'exactly one map' : `exactly ${SITE_MAPS.length} maps`}: ${SITE_MAPS.map((m) => `${m} (${MAP_LABELS[m]})`).join(', ')}.
Every other Tarkov map (${Object.values(OTHER_MAP_LABELS).join(', ')}) exists in the quest data but CANNOT be
opened here - for those you may describe and show photos, and you must say the site does not have that map yet.
Some of those are drawn but locked while the map is being rebuilt; either way they cannot be opened, so never
offer to take the player to one and never imply a button exists.${
  selected.length ? `\nAlready on their map: ${selected.join(', ')}.` : ''}${
  activeNames.length ? `\nTheir game reports these quests as ACTIVE right now: ${activeNames.join(', ')}. Prefer them when the question is vague ("what next?", "where do I go?"), but never claim a quest is active or finished beyond this list.` : ''}

Rules:
- Use ONLY the QUEST DATA block for anything factual: objectives, where they are, trader, level, items, photos.
- NEVER invent coordinates, zone names, objective ids, slugs, quest names or image URLs. If the data does not answer the question, say so in one line.
- If the quest the player is asking about is on a DIFFERENT map from ${map}, say which map it is on in the first sentence${
  SITE_MAPS.length > 1 ? ' and offer to move there' : ' and say TarkovZero cannot open that map yet'}. Do not pretend it is here.
- Be concise and practical, in English: 2-5 short sentences, or up to 5 bullets. Markdown-lite only (**bold**, \`code\`, "- " bullets). No headings, no tables.
- You never move the map yourself - you return actions and the site performs them.

Reply with ONE JSON object and nothing else:
{"answer": "...", "actions": [...], "quests": ["slug", ...]}

Allowed actions (use slugs and ids exactly as they appear in the data):
  {"type":"selectQuest","slug":"<slug>"}             put that quest's objectives on the map
  {"type":"flyTo","objectiveId":"<objective id>"}    centre the map on that objective - only if it has marked locations on ${map}
${SWITCH_MAP_LINE}  {"type":"showImages","imageIds":["img1", ...]}     show screenshots from the PHOTOS list. Ids only - the site owns the URLs.
                                                     Pick at most ${MAX_IMAGES}, only ones that actually help ("this is the building"). Omit the
                                                     action entirely when the PHOTOS list is empty or nothing there is relevant.
Put selectQuest before flyTo. At most ${MAX_QUESTS} quests. Use an empty actions array when the question is not about a specific quest.`;

/* ------------------------------------------------------------- guards ----- */

const buckets = new Map();
function rateLimited(ip) {
  const now = Date.now();
  if (buckets.size > 5000) for (const [k, v] of buckets) if (now - v.ts > RATE_WINDOW) buckets.delete(k);
  const b = buckets.get(ip);
  if (!b || now - b.ts >= RATE_WINDOW) { buckets.set(ip, { n: 1, ts: now }); return false; }
  b.n += 1;
  return b.n > RATE_LIMIT;
}

const cache = new Map();
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > CACHE_TTL) { cache.delete(key); return null; }
  return hit.payload;
}
function cacheSet(key, payload) {
  if (cache.size > 300) for (const [k, v] of [...cache]) if (Date.now() - v.t > CACHE_TTL) cache.delete(k);
  while (cache.size > 300) cache.delete(cache.keys().next().value);
  cache.set(key, { t: Date.now(), payload });
}

/* -------------------------------------------------------------- parsing --- */

/** Pull the JSON object out of a model reply; fall back to treating the whole thing as prose. */
export function parseReply(content) {
  const text = String(content ?? '').trim();
  if (!text) return { answer: '', actions: [], quests: [], parsed: false };
  const tryParse = (s) => { try { const v = JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } };
  const fenced = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let obj = tryParse(text) ?? tryParse(fenced);
  if (!obj) {
    const start = fenced.indexOf('{');
    const end = fenced.lastIndexOf('}');
    if (start >= 0 && end > start) obj = tryParse(fenced.slice(start, end + 1));
  }
  if (!obj || typeof obj.answer !== 'string') return { answer: text, actions: [], quests: [], parsed: false };
  return {
    answer: String(obj.answer),
    actions: Array.isArray(obj.actions) ? obj.actions.filter((a) => a && typeof a === 'object') : [],
    quests: Array.isArray(obj.quests) ? obj.quests.filter((s) => typeof s === 'string') : [],
    parsed: true,
  };
}

/** Does this objective have at least one marked location on `m`? */
const onMap = (o, m) => (o.zones ?? []).some((z) => z.map === m);

/**
 * The cross-map handoff, derived from quests.json - never from the model's word.
 *
 * Returns the switchMap action for a quest whose objectives are on one of the other two maps this
 * site can draw, carrying what to select AND what to fly to once there, so the switch lands the
 * player on the thing they asked about instead of on the map's default view. Returns null when
 * the quest has nothing on any *other* site map - including the common case of a quest that lives
 * on Shoreline or Streets, which this site cannot open at all.
 *
 * `wanted` is the map the model asked for; it is honoured only if the data agrees.
 */
export function crossMapFor(quest, map, wanted = null) {
  if (!quest) return null;
  const options = (quest.siteMaps ?? []).filter((m) => isSiteMap(m) && m !== map);
  if (!options.length) return null;
  const target = (isSiteMap(wanted) && wanted !== map && options.includes(wanted)) ? wanted : options[0];
  const landing = (quest.objectives ?? []).find((o) => onMap(o, target));
  return {
    type: 'switchMap',
    map: target,
    label: mapLabel(target),
    slug: quest.slug,
    name: quest.name,
    objectiveId: landing ? landing.id : null,
  };
}

/**
 * Re-derive the action list from the retrieved quests. The model can only *pick*; ids, slugs and
 * map names always come from quests.json, so nothing invented survives. Every action returned
 * here is additionally run through the contract's own shape gate, so a field this function
 * forgets to fill is dropped rather than shipped half-formed.
 */
export function buildActions(hits, modelOut, map) {
  const bySlug = new Map(hits.map(({ q }) => [q.slug, q]));
  const wanted = [];
  for (const s of modelOut.quests) if (bySlug.has(s) && !wanted.includes(s)) wanted.push(s);
  for (const a of modelOut.actions) {
    if (a.type === 'selectQuest' && bySlug.has(a.slug) && !wanted.includes(a.slug)) wanted.push(a.slug);
    if (a.type === 'flyTo' && typeof a.objectiveId === 'string') {
      const owner = hits.find(({ q }) => (q.objectives ?? []).some((o) => o.id === a.objectiveId));
      if (owner && !wanted.includes(owner.q.slug)) wanted.push(owner.q.slug);
    }
  }
  const slugs = wanted.slice(0, MAX_QUESTS);
  const actions = slugs.map((slug) => ({ type: 'selectQuest', slug, name: bySlug.get(slug).name }));
  if (slugs.length) {
    const lead = bySlug.get(slugs[0]);
    // honour the model's flyTo when it points at a real objective with a zone on THIS map
    const asked = modelOut.actions.find((a) => a.type === 'flyTo'
      && (lead.objectives ?? []).some((o) => o.id === a.objectiveId && onMap(o, map)));
    const target = asked ? { id: asked.objectiveId } : (lead.objectives ?? []).find((o) => onMap(o, map));
    if (target) actions.push({ type: 'flyTo', objectiveId: target.id, slug: lead.slug, map });
    else {
      const askedMap = modelOut.actions.find((a) => a.type === 'switchMap')?.map ?? null;
      const jump = crossMapFor(lead, map, askedMap);
      if (jump) actions.push(jump);
    }
  }
  // last gate: shape, in the contract's own words. Nothing malformed reaches the client.
  return { actions: actions.filter((a) => isValidAction(a, { map })), quests: slugs };
}

/* ------------------------------------------------------------- handler ---- */

function send(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return null; } }
  let raw = '', size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) return null;
    raw += chunk;
  }
  try { return JSON.parse(raw || '{}'); } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });

  // same-origin only: a browser always sends Origin on a cross-site POST
  const origin = req.headers.origin;
  if (origin) {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    let oh = 'invalid';
    try { oh = new URL(origin).host; } catch { /* keep 'invalid' */ }
    if (oh !== host) return send(res, 403, { error: 'cross-origin requests are not allowed' });
  }

  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (rateLimited(ip)) { res.setHeader('Retry-After', '60'); return send(res, 429, { error: 'Too many questions - try again in a minute.' }); }

  const body = await readBody(req);
  if (!body) return send(res, 400, { error: 'invalid JSON body' });

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return send(res, 400, { error: 'message is required' });
  if (Buffer.byteLength(message, 'utf8') > MAX_MESSAGE) return send(res, 400, { error: 'message too long (2 KB max)' });

  // The tab the player is on. It steers retrieval, the prompt and the actions, and it is echoed
  // on the answer so the client can spot a reply that outlived the map it was asked about.
  const map = normalizeMapKey(body.map);
  const selected = Array.isArray(body.selectedQuests) ? body.selectedQuests.filter((s) => typeof s === 'string').slice(0, 12) : [];
  // Optional grounding: task ids the player's own game reports as active. Untrusted input, so it is
  // only ever *matched* against quests.json — an id that resolves to nothing is silently dropped.
  const activeIds = normalizeActiveIds(body.activeQuests);
  const history = (Array.isArray(body.history) ? body.history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));

  // identical (message, map) inside 10 min is served from memory; the history fingerprint keeps
  // a follow-up question from picking up an earlier answer; cacheKeyFor() folds in the active set.
  const key = cacheKeyFor({ map, message, history, activeIds });   // (fields joined on '\u0001');
  const cached = cacheGet(key);
  if (cached) return send(res, 200, { ...cached, cached: true });

  let entries;
  try { entries = await loadQuests(req); }
  catch { return send(res, 502, { error: 'quest data unavailable' }); }

  const activeSet = new Set(activeIds);
  const activeNames = activeQuestNames(entries, activeSet);
  const hits = rank(entries, message, map, { activeIds: activeSet });
  // The second source behind every image reference. A miss here means no photos this turn, and
  // `imageIndexOk: false` on the envelope so that outage is not mistaken for "no photos exist".
  const allow = await loadImageAllow(req);
  const catalog = imageCatalog(hits, allow, map);
  const grounding = hits.length
    ? `CURRENT MAP: ${map}\nQUEST DATA (the only facts you may use):\n${groundingFor(hits, map, catalog)}`
    : `CURRENT MAP: ${map}\nQUEST DATA: no quest in the database matched this question.`;

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return send(res, 502, { error: 'assistant is not configured' });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT);
  let content = '';
  try {
    const upstream = await fetch(ENDPOINT, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3,
        max_tokens: 600,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM(map, selected, activeNames) },
          ...history,
          { role: 'user', content: `${grounding}\n\nPLAYER: ${message}` },
        ],
      }),
    });
    if (!upstream.ok) {
      // never echo the upstream body - it can carry request context we don't want to forward
      return send(res, 502, { error: `assistant upstream error (${upstream.status})` });
    }
    const data = await upstream.json();
    content = data?.choices?.[0]?.message?.content ?? '';
  } catch (e) {
    return send(res, 502, { error: e?.name === 'AbortError' ? 'the assistant timed out' : 'could not reach the assistant' });
  } finally {
    clearTimeout(timer);
  }

  const parsed = parseReply(content);
  const { actions, quests } = buildActions(hits, parsed, map);
  const images = buildImages(catalog, parsed, quests);
  if (images.length) actions.push({ type: 'showImages', imageIds: images.map((i) => i.id) });

  // src/assistant-contract.js is the contract; assemble it in that order and nothing else.
  const payload = {
    protocol: PROTOCOL_VERSION,
    map,
    answer: parsed.answer || 'I could not find anything about that in the quest data.',
    actions,
    images,
    imageIndexOk: catalog.available,
    quests,
    sources: hits.map(({ q }) => ({
      slug: q.slug,
      name: q.name,
      trader: q.trader,
      wikiLink: q.wikiLink ?? null,
      // honest per-quest coverage, so the UI never has to guess from prose which maps this is on
      maps: q.maps ?? [],
      siteMaps: (q.siteMaps ?? []).filter(isSiteMap),
    })),
  };
  cacheSet(key, payload);
  return send(res, 200, payload);
}
