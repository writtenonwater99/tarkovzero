/**
 * The assistant function's TRANSPORT half: the same-origin check, the rate limiter, what actually
 * reaches DeepSeek, and the envelope that comes back — end to end through the default export.
 *
 * scripts/test-assistant.mjs covers the pure functions; this file covers the parts that only exist
 * once a request is in flight. No network: `globalThis.fetch` is replaced, so the model boundary is
 * a stub and no key is ever needed or used.
 *
 *   node --test scripts/assistant-handler-test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.env.DEEPSEEK_API_KEY = 'test-key-never-real';

const handler = (await import('../api/assistant.js')).default;
const { isValidAction, isValidImageRef, PROTOCOL_VERSION, SITE_MAPS } = await import('../src/assistant-contract.js');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const quests = JSON.parse(readFileSync(join(root, 'public/data/quests.json'), 'utf8'));
const imageFile = JSON.parse(readFileSync(join(root, 'public/data/quest-images.json'), 'utf8'));
const hasImages = new Set(Object.keys(imageFile).filter((k) => !k.startsWith('_')));

const WOODS_ONLY = quests.find((q) => (q.siteMaps ?? []).length === 1 && q.siteMaps[0] === 'woods' && hasImages.has(q.id));
const NO_IMAGES = quests.find((q) => !hasImages.has(q.id) && !(q.images ?? []).length
  && !(q.objectives ?? []).some((o) => (o.images ?? []).length) && (q.siteMaps ?? []).includes('customs'));
const WITH_IMAGES = quests.find((q) => hasImages.has(q.id) && (q.images ?? []).length >= 2);

/* ------------------------------------------------------------------ harness */

const HOST = 'tarkovzero.test';
let upstream = null;      // the last body posted to DeepSeek
let upstreamCalls = 0;

/**
 * Replace the model boundary. `reply` is the JSON the model "returns"; `status` fakes an outage.
 * Anything that is not the DeepSeek endpoint (our own /data/*.json fallback) 404s, so a test can
 * never accidentally depend on the network.
 */
function stubModel(reply, { status = 200 } = {}) {
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('api.deepseek.com')) return { ok: false, status: 404, json: async () => ({}) };
    upstreamCalls += 1;
    upstream = JSON.parse(init.body);
    upstream.__auth = init.headers.Authorization;
    if (status !== 200) return { ok: false, status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] }) };
  };
}

let ipSeq = 0;
/** One request. `ip` defaults to a fresh address so the rate limiter never leaks between tests. */
async function call({
  method = 'POST', origin = `https://${HOST}`, host = HOST, ip = `10.0.0.${(ipSeq += 1)}`, body = {},
} = {}) {
  const headers = { host, 'x-forwarded-for': ip };
  if (origin) headers.origin = origin;
  // `body: null` means "nothing Vercel could parse": the handler then reads the raw stream, so the
  // fake request has to be async-iterable exactly like the real one.
  const req = { method, headers, socket: { remoteAddress: ip } };
  if (body === null) req[Symbol.asyncIterator] = async function* () { yield 'not json at all'; };
  else req.body = body;
  const out = { code: 0, headers: {}, raw: '' };
  const res = {
    set statusCode(v) { out.code = v; },
    get statusCode() { return out.code; },
    setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; },
    end: (s) => { out.raw = s ?? ''; },
  };
  await handler(req, res);
  try { out.body = out.raw ? JSON.parse(out.raw) : null; } catch { out.body = null; }
  return out;
}

/** A question that reliably retrieves one quest, with a per-test suffix so the answer cache misses.
 *  Two letters: `tokens()` drops anything <= 2 chars, so the suffix cannot move the ranking. */
const ask = (quest, tag) => `how do I do ${quest.name} ${tag}`;

const SILENT = { answer: 'ok', actions: [], quests: [] };

/* -------------------------------------------------------------------- guards */

test('non-POST methods are refused', async () => {
  stubModel(SILENT);
  assert.equal((await call({ method: 'GET' })).code, 405);
  assert.equal((await call({ method: 'OPTIONS' })).code, 204);
});

test('a cross-origin POST is refused and never reaches the model', async () => {
  stubModel(SILENT);
  const before = upstreamCalls;
  const r = await call({ origin: 'https://evil.example', body: { message: 'hello', map: 'customs' } });
  assert.equal(r.code, 403);
  assert.match(r.body.error, /cross-origin/);
  assert.equal(upstreamCalls, before, 'the DeepSeek key must not be spent on a cross-site request');
});

test('a same-origin POST is allowed, and so is one with no Origin at all', async () => {
  stubModel(SILENT);
  assert.equal((await call({ body: { message: ask(NO_IMAGES, 'aa'), map: 'customs' } })).code, 200);
  assert.equal((await call({ origin: null, body: { message: ask(NO_IMAGES, 'ab'), map: 'customs' } })).code, 200);
  // a malformed Origin header is not a host match either
  assert.equal((await call({ origin: 'not a url', body: { message: 'x', map: 'customs' } })).code, 403);
});

test('the rate limiter still stops at 20 requests a minute per IP', async () => {
  stubModel(SILENT);
  const ip = '10.9.9.9';
  for (let i = 0; i < 20; i++) {
    const r = await call({ ip, body: { message: ask(NO_IMAGES, 'ac'), map: 'customs' } });
    assert.equal(r.code, 200, `request ${i + 1} should pass`);
  }
  const over = await call({ ip, body: { message: ask(NO_IMAGES, 'ac'), map: 'customs' } });
  assert.equal(over.code, 429);
  assert.equal(over.headers['retry-after'], '60');
  // a different IP is unaffected
  assert.equal((await call({ body: { message: ask(NO_IMAGES, 'ad'), map: 'customs' } })).code, 200);
});

test('input limits still hold', async () => {
  stubModel(SILENT);
  assert.equal((await call({ body: { map: 'customs' } })).code, 400);
  assert.equal((await call({ body: { message: '   ', map: 'customs' } })).code, 400);
  assert.equal((await call({ body: { message: 'x'.repeat(2049), map: 'customs' } })).code, 400);
  assert.equal((await call({ body: null })).code, 400);
});

test('an upstream failure is a 502 that leaks nothing', async () => {
  stubModel(SILENT, { status: 500 });
  const r = await call({ body: { message: ask(NO_IMAGES, 'ae'), map: 'customs' } });
  assert.equal(r.code, 502);
  assert.ok(!r.raw.includes('test-key-never-real'), 'the key never appears in a response body');
  assert.equal(r.body.actions, undefined, 'an error is not an envelope');
});

/* ------------------------------------------------------------- map awareness */

test('the map the tab is on reaches the prompt and is echoed on the answer', async () => {
  stubModel(SILENT);
  const r = await call({ body: { message: ask(WOODS_ONLY, 'af'), map: 'woods' } });
  assert.equal(r.code, 200);
  assert.equal(r.body.map, 'woods', 'the envelope echoes the map it answered for');
  assert.equal(r.body.protocol, PROTOCOL_VERSION);

  const system = upstream.messages.find((m) => m.role === 'system').content;
  const user = upstream.messages.at(-1).content;
  assert.match(system, /THE MAP THE PLAYER IS ON RIGHT NOW: woods/);
  assert.match(user, /^CURRENT MAP: woods/m);
  assert.match(system, /TarkovZero can draw exactly three maps/);
  for (const m of SITE_MAPS) assert.ok(system.includes(m), `the prompt names ${m}`);
  // the settings the panel depends on are unchanged
  assert.equal(upstream.max_tokens, 600);
  assert.deepEqual(upstream.response_format, { type: 'json_object' });
  assert.equal(upstream.__auth, 'Bearer test-key-never-real');
});

test('an unknown map key falls back to customs everywhere, not just in the prompt', async () => {
  stubModel(SILENT);
  const r = await call({ body: { message: ask(NO_IMAGES, 'ag'), map: '../../etc/passwd' } });
  assert.equal(r.body.map, 'customs');
  assert.match(upstream.messages.find((m) => m.role === 'system').content, /RIGHT NOW: customs/);
});

test('a question about another map produces a switch-map action naming that map', async () => {
  stubModel({ answer: `That one is on Woods.`, actions: [], quests: [WOODS_ONLY.slug] });
  const r = await call({ body: { message: ask(WOODS_ONLY, 'ah'), map: 'customs' } });
  assert.equal(r.body.map, 'customs');
  const jump = r.body.actions.find((a) => a.type === 'switchMap');
  assert.ok(jump, `expected a switchMap in ${JSON.stringify(r.body.actions)}`);
  assert.equal(jump.map, 'woods');
  assert.equal(jump.label, 'Woods');
  assert.equal(jump.slug, WOODS_ONLY.slug);
  // it lands the player on the thing they asked about, on the TARGET map
  const landing = WOODS_ONLY.objectives.find((o) => o.id === jump.objectiveId);
  assert.ok(landing, 'the handoff names a real objective');
  assert.ok((landing.zones ?? []).some((z) => z.map === 'woods'), 'marked on woods, the map we are going to');
  assert.ok(!r.body.actions.some((a) => a.type === 'flyTo'), 'and no flyTo on the map we are leaving');
});

test('an action naming a map, quest or objective that does not exist is dropped server-side', async () => {
  stubModel({
    answer: 'x',
    actions: [
      { type: 'selectQuest', slug: 'quest-that-does-not-exist' },
      { type: 'flyTo', objectiveId: 'ffffffffffffffffffffffff' },
      { type: 'switchMap', map: 'shoreline' },
      { type: 'teleport', map: 'woods' },
    ],
    quests: ['also-not-real'],
  });
  const r = await call({ body: { message: 'zzzqqxx nonsense', map: 'customs' } });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.actions, []);
  assert.deepEqual(r.body.quests, []);
  assert.equal(r.raw.includes('shoreline'), false);
});

/* -------------------------------------------------------------------- images */

test('image references are real records, and a forged URL never survives', async () => {
  stubModel({
    answer: 'Here it is.',
    actions: [
      { type: 'selectQuest', slug: WITH_IMAGES.slug },
      { type: 'showImages', imageIds: ['img1', 'img99'], url: 'https://evil.example/fake.png' },
    ],
    quests: [WITH_IMAGES.slug],
  });
  const r = await call({ body: { message: ask(WITH_IMAGES, 'ai'), map: 'customs' } });
  assert.equal(r.body.imageIndexOk, true);
  assert.ok(r.body.images.length >= 1, 'the quest has screenshots, so the answer carries some');
  assert.equal(r.raw.includes('evil.example'), false, 'a model-supplied URL is never echoed');
  const ids = r.body.images.map((i) => i.id);
  for (const ref of r.body.images) {
    assert.ok(isValidImageRef(ref), `ref fails the contract: ${JSON.stringify(ref)}`);
    const quest = quests.find((q) => q.slug === ref.questSlug);
    const known = (imageFile[quest.id] ?? []).map((im) => im.url);
    assert.ok(known.includes(ref.url), 'every ref resolves to a real entry in quest-images.json');
    assert.ok(ref.depicts.length > 0, 'and says what it depicts');
  }
  assert.ok(!ids.includes('img99'), 'an id that was never minted is not in the envelope');
  const show = r.body.actions.find((a) => a.type === 'showImages');
  assert.deepEqual(show.imageIds, ids, 'the action and the refs agree');
  for (const a of r.body.actions) {
    assert.ok(isValidAction(a, { map: r.body.map, imageIds: ids }), `action fails the contract: ${JSON.stringify(a)}`);
  }
});

test('a subject with no screenshot yields zero refs, not a placeholder', async () => {
  stubModel({
    answer: 'x',
    actions: [{ type: 'selectQuest', slug: NO_IMAGES.slug }, { type: 'showImages', imageIds: ['img1', 'img2'] }],
    quests: [NO_IMAGES.slug],
  });
  const r = await call({ body: { message: ask(NO_IMAGES, 'aj'), map: 'customs' } });
  assert.equal(r.body.quests[0], NO_IMAGES.slug, 'the right quest was retrieved');
  assert.deepEqual(r.body.images, [], `expected no images for ${NO_IMAGES.slug}`);
  assert.ok(!r.body.actions.some((a) => a.type === 'showImages'), 'and no showImages action to render');
  assert.equal(r.body.imageIndexOk, true, 'the index was readable — the emptiness is real, not an outage');
});

/* ------------------------------------------------------------------ envelope */

test('every 200 is a complete envelope', async () => {
  stubModel({ answer: 'x', actions: [], quests: [WITH_IMAGES.slug] });
  const r = await call({ body: { message: ask(WITH_IMAGES, 'ak'), map: 'customs' } });
  for (const k of ['protocol', 'map', 'answer', 'actions', 'images', 'imageIndexOk', 'quests', 'sources']) {
    assert.ok(k in r.body, `missing envelope field: ${k}`);
  }
  assert.ok(r.body.sources.every((s) => Array.isArray(s.maps) && Array.isArray(s.siteMaps)),
    'sources carry their own map coverage so the UI never guesses from prose');
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('an identical question inside the cache window is served from memory', async () => {
  stubModel({ answer: 'cached please', actions: [], quests: [] });
  const body = { message: ask(NO_IMAGES, 'al'), map: 'customs' };
  const first = await call({ body });
  const before = upstreamCalls;
  const second = await call({ body });
  assert.equal(second.body.cached, true);
  assert.equal(upstreamCalls, before, 'the second answer cost no model call');
  assert.equal(second.body.map, first.body.map);
  // …but the same words on another map are a different question
  const other = await call({ body: { ...body, map: 'woods' } });
  assert.equal(other.body.cached, undefined);
  assert.equal(other.body.map, 'woods');
});
