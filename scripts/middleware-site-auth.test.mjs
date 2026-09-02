// Tests the site-wide Basic Auth gate in ../middleware.js directly — no Vercel runtime needed.
// The module is imported fresh (via a cache-busting query string) inside each test so that
// mutating process.env.SITE_PASSWORD between tests can't be contaminated by import caching, and so
// a stray value left in the environment by the outer shell can't make a test pass for the wrong
// reason.

import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MIDDLEWARE_URL = 'file://' + resolve(SCRIPT_DIR, '..', 'middleware.js');

async function freshMiddleware() {
  const mod = await import(`${MIDDLEWARE_URL}?t=${Date.now()}-${Math.random()}`);
  return mod.default;
}

function basicHeader(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
}

function req(headers = {}) {
  return new Request('https://tarkovzero.example/assets/3d/customs/authored/fortress/fortress.glb', { headers });
}

const ORIGINAL = process.env.SITE_PASSWORD;
test.after(() => {
  if (ORIGINAL === undefined) delete process.env.SITE_PASSWORD;
  else process.env.SITE_PASSWORD = ORIGINAL;
});

test('config.matcher matches every path (no path is exempt by construction)', async () => {
  const mod = await import(`${MIDDLEWARE_URL}?t=${Date.now()}-${Math.random()}`);
  assert.equal(mod.config.runtime, 'nodejs');
  const matcher = new RegExp(`^${mod.config.matcher}$`);
  for (const p of ['/', '/index.html', '/assets/3d/customs/authored/fortress/fortress.glb', '/api/assistant', '/data/customs-3d.json']) {
    assert.ok(matcher.test(p), `matcher should cover ${p}`);
  }
});

test('fails CLOSED when SITE_PASSWORD is unset: denies even a request with no auth header at all', async () => {
  delete process.env.SITE_PASSWORD;
  const middleware = await freshMiddleware();
  const res = middleware(req());
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('www-authenticate'), null, 'a 503 misconfiguration must not look like a normal 401 challenge');
});

test('fails CLOSED when SITE_PASSWORD is unset: denies even a request carrying a correct-looking guess', async () => {
  delete process.env.SITE_PASSWORD;
  const middleware = await freshMiddleware();
  const res = middleware(req({ authorization: basicHeader('anyone', 'anything') }));
  assert.equal(res.status, 503, 'an unset credential must deny everyone, not just unauthenticated requests');
});

test('fails CLOSED when SITE_PASSWORD is the empty string', async () => {
  process.env.SITE_PASSWORD = '';
  const middleware = await freshMiddleware();
  const res = middleware(req());
  assert.equal(res.status, 503);
});

test('denies a request with no Authorization header, with a WWW-Authenticate challenge', async () => {
  process.env.SITE_PASSWORD = 'hunter2-correct-password';
  const middleware = await freshMiddleware();
  const res = middleware(req());
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') || '', /^Basic realm="tarkovzero"/);
});

test('denies a non-Basic Authorization scheme', async () => {
  process.env.SITE_PASSWORD = 'hunter2-correct-password';
  const middleware = await freshMiddleware();
  const res = middleware(req({ authorization: 'Bearer sometoken' }));
  assert.equal(res.status, 401);
});

test('denies the wrong password', async () => {
  process.env.SITE_PASSWORD = 'hunter2-correct-password';
  const middleware = await freshMiddleware();
  const res = middleware(req({ authorization: basicHeader('founder', 'wrong-guess') }));
  assert.equal(res.status, 401);
});

test('denies a garbage (non-base64) Authorization value instead of throwing', async () => {
  process.env.SITE_PASSWORD = 'hunter2-correct-password';
  const middleware = await freshMiddleware();
  const res = middleware(req({ authorization: 'Basic ###not-base64###' }));
  assert.equal(res.status, 401);
});

test('accepts the correct password regardless of the username supplied', async () => {
  process.env.SITE_PASSWORD = 'hunter2-correct-password';
  const middleware = await freshMiddleware();
  for (const user of ['founder', '', 'anything-at-all']) {
    const res = middleware(req({ authorization: basicHeader(user, 'hunter2-correct-password') }));
    assert.equal(res.status, 200, `username "${user}" should not affect the password check`);
    assert.equal(res.headers.get('x-middleware-next'), '1', 'a correct password must hand off to normal routing via next()');
  }
});

test('a colon inside the password itself is preserved (splits on the FIRST colon only)', async () => {
  process.env.SITE_PASSWORD = 'p@ss:with:colons';
  const middleware = await freshMiddleware();
  const res = middleware(req({ authorization: basicHeader('user', 'p@ss:with:colons') }));
  assert.equal(res.headers.get('x-middleware-next'), '1');
});

test('every denial response sets Cache-Control: no-store so a CDN/browser never caches a bypass', async () => {
  process.env.SITE_PASSWORD = 'hunter2-correct-password';
  const middleware = await freshMiddleware();
  const res401 = middleware(req());
  assert.equal(res401.headers.get('cache-control'), 'no-store');

  delete process.env.SITE_PASSWORD;
  const middleware2 = await freshMiddleware();
  const res503 = middleware2(req());
  assert.equal(res503.headers.get('cache-control'), 'no-store');
});
