/**
 * TarkovZero — AI quest assistant (Vercel Node serverless function).
 *
 * POST /api/assistant  { message, map, selectedQuests?, history? }
 *   -> { answer, actions:[{type,...}], quests:[slug], sources:[...] }
 *
 * How it works: retrieval over public/data/quests.json (fuzzy rank against name / trader /
 * objective text, current map preferred) -> a compact grounding block -> DeepSeek chat
 * completion in JSON mode. Every action the model returns is re-validated against the
 * retrieved quests, so a hallucinated slug, objective id or map can never reach the client.
 *
 * The DeepSeek key is read from process.env.DEEPSEEK_API_KEY on the server only. It is never
 * logged and never included in a response.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL = 'deepseek-chat';
const ENDPOINT = 'https://api.deepseek.com/chat/completions';
const SITE_MAPS = ['customs', 'reserve', 'woods'];
const MAX_MESSAGE = 2048;          // bytes of user text we accept
const MAX_HISTORY = 8;             // turns kept from the client
const RATE_LIMIT = 20;             // requests…
const RATE_WINDOW = 60_000;        // …per minute per IP
const UPSTREAM_TIMEOUT = 12_000;
const CACHE_TTL = 10 * 60_000;
const TOP_K = 3;

/* ------------------------------------------------------------------ data -- */

let questsPromise = null;

/** Load quests.json once per lambda instance: bundled file first, deployment URL as fallback. */
function loadQuests(req) {
  if (questsPromise) return questsPromise;
  questsPromise = (async () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const candidates = [
      join(process.cwd(), 'public', 'data', 'quests.json'),
      join(here, '..', 'public', 'data', 'quests.json'),
      join('/var/task', 'public', 'data', 'quests.json'),
    ];
    for (const file of candidates) {
      try {
        const raw = await readFile(file, 'utf8');
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length) return index(arr);
      } catch { /* try the next one */ }
    }
    // Fallback: read it back off our own deployment (the file is a public static asset).
    const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host;
    if (host) {
      const proto = /^(localhost|127\.)/.test(host) ? 'http' : 'https';
      const r = await fetch(`${proto}://${host}/data/quests.json`);
      if (r.ok) {
        const arr = await r.json();
        if (Array.isArray(arr) && arr.length) return index(arr);
      }
    }
    throw new Error('quests.json unavailable');
  })().catch((e) => { questsPromise = null; throw e; });
  return questsPromise;
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
export function rank(entries, message, map, { limit = TOP_K } = {}) {
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

/* ---------------------------------------------------------- grounding ----- */

const clip = (s, n) => (String(s ?? '').length > n ? String(s).slice(0, n - 1) + '…' : String(s ?? ''));

/** Compact, token-cheap context for the model. Only facts that exist in quests.json. */
export function groundingFor(hits, map) {
  return hits.map(({ q }, i) => {
    const lines = [];
    const site = (q.siteMaps ?? []).join(', ') || 'none';
    lines.push(`[${i + 1}] ${q.name} - trader ${q.trader}, min level ${q.minLevel ?? 0}`);
    lines.push(`    slug: ${q.slug} | maps: ${(q.maps ?? []).join(', ') || 'none'} | drawable on this site: ${site}`);
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
      for (const im of (o.images ?? []).slice(0, 2)) if (im.caption) lines.push(`      photo: ${clip(im.caption, 100)}`);
    }
    return lines.join('\n');
  }).join('\n');
}

const SYSTEM = (map, selected) => `You are the quest assistant built into TarkovZero, an interactive Escape from Tarkov map (Customs, Reserve, Woods).
The player is looking at the ${map} map right now.${selected.length ? ` Already on their map: ${selected.join(', ')}.` : ''}

Rules:
- Use ONLY the QUEST DATA block for anything factual: objectives, where they are, trader, level, items, photos.
- NEVER invent coordinates, zone names, objective ids, slugs or quest names. If the data does not answer the question, say so in one line.
- Be concise and practical, in English: 2-5 short sentences, or up to 5 bullets. Markdown-lite only (**bold**, \`code\`, "- " bullets). No headings, no tables.
- You never move the map yourself - you return actions and the site performs them.

Reply with ONE JSON object and nothing else:
{"answer": "...", "actions": [...], "quests": ["slug", ...]}

Allowed actions (use slugs and ids exactly as they appear in the data):
  {"type":"selectQuest","slug":"<slug>"}             put that quest's objectives on the map
  {"type":"flyTo","objectiveId":"<objective id>"}    centre the map on that objective - only if it has marked locations on ${map}
  {"type":"switchMap","map":"customs|reserve|woods"} only when the quest's objectives are on a different one of those three maps.
                                                     The site switches immediately, so word the answer as if the player is already on the way there.
Put selectQuest before flyTo. At most 3 quests. Use an empty actions array when the question is not about a specific quest.`;

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

/**
 * Re-derive the action list from the retrieved quests. The model can only *pick*; ids, slugs and
 * map names always come from quests.json, so nothing invented survives.
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
  const slugs = wanted.slice(0, 3);
  const actions = slugs.map((slug) => ({ type: 'selectQuest', slug }));
  if (!slugs.length) return { actions, quests: slugs };

  const lead = bySlug.get(slugs[0]);
  const here = (o) => (o.zones ?? []).some((z) => z.map === map);
  // honour the model's flyTo when it points at a real objective with a zone on this map
  const asked = modelOut.actions.find((a) => a.type === 'flyTo'
    && (lead.objectives ?? []).some((o) => o.id === a.objectiveId && here(o)));
  const target = asked ? { id: asked.objectiveId } : (lead.objectives ?? []).find(here);
  if (target) actions.push({ type: 'flyTo', objectiveId: target.id });
  else {
    const other = (lead.siteMaps ?? []).find((m) => m !== map && SITE_MAPS.includes(m));
    if (other) actions.push({ type: 'switchMap', map: other });
  }
  return { actions, quests: slugs };
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

  const map = SITE_MAPS.includes(String(body.map)) ? String(body.map) : 'customs';
  const selected = Array.isArray(body.selectedQuests) ? body.selectedQuests.filter((s) => typeof s === 'string').slice(0, 12) : [];
  const history = (Array.isArray(body.history) ? body.history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));

  // identical (message, map) inside 10 min is served from memory; the history fingerprint keeps
  // a follow-up question from picking up an earlier answer.
  const key = [map, message.toLowerCase(), history.map((h) => h.role + h.content.length).join('.')].join('\u0001');
  const cached = cacheGet(key);
  if (cached) return send(res, 200, { ...cached, cached: true });

  let entries;
  try { entries = await loadQuests(req); }
  catch { return send(res, 502, { error: 'quest data unavailable' }); }

  const hits = rank(entries, message, map);
  const grounding = hits.length
    ? `QUEST DATA (the only facts you may use):\n${groundingFor(hits, map)}`
    : 'QUEST DATA: no quest in the database matched this question.';

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
          { role: 'system', content: SYSTEM(map, selected) },
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
  const payload = {
    answer: parsed.answer || 'I could not find anything about that in the quest data.',
    actions,
    quests,
    sources: hits.map(({ q }) => ({ slug: q.slug, name: q.name, trader: q.trader, wikiLink: q.wikiLink ?? null })),
  };
  cacheSet(key, payload);
  return send(res, 200, payload);
}
