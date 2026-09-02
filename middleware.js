// Site-wide HTTP Basic Auth gate — Vercel Routing Middleware.
//
// Vercel invokes this on EVERY request to the deployment before any routing decision is made
// (static file, /api/assistant, anything) — see the `matcher` below, which is deliberately set to
// match everything rather than relying on the "no matcher = every route" default, so the intent is
// explicit in the file itself. A password that only guards index.html while /assets/*.glb stays
// open is not a password; this file is what makes that untrue.
//
// FAILS CLOSED. The one credential this checks — SITE_PASSWORD — must be set as an environment
// variable in the Vercel project (see docs/PASSWORD-PROTECTION.md for the exact steps). If it is
// missing or empty, every request is denied with 503 rather than served openly: there is no
// "if not configured, skip the check" branch anywhere below. That silent-no-op shape is exactly
// the bug class this project hit repeatedly while building the game-data boundary — this gate does
// not repeat it.
//
// Local dev is unaffected by construction, not by a bypass branch: `npm run dev` (Vite's own dev
// server) and `vite preview` never talk to Vercel's routing layer, so this file is simply never
// loaded or executed for either of them. It only runs on an actual Vercel deployment (or under
// `vercel dev`, which this project does not use). There is nothing here that could accidentally
// "leak" into production, because there is no environment-conditional logic to leak — the same
// code path runs everywhere this file executes.
//
// Runtime is pinned to `nodejs` (not the `edge` default) so this can use Node's `crypto` module for
// a constant-time credential comparison, and so it matches the runtime the site's other server code
// (api/assistant.js) already uses.

import { next } from '@vercel/functions';
import { createHash, timingSafeEqual } from 'node:crypto';

export const config = {
  runtime: 'nodejs',
  // Match literally every path on the deployment. Do not narrow this without a stated reason —
  // narrowing it is exactly how a path (an asset directory, a future route) ends up unprotected.
  matcher: '/(.*)',
};

const REALM = 'tarkovzero';

// Hash both sides to a fixed-length digest before comparing: crypto.timingSafeEqual throws on
// unequal-length buffers, and comparing raw variable-length passwords directly would leak the
// expected password's length through that throw/no-throw behaviour. Hashing first also means an
// attacker learns nothing about the length of the real password from timing.
function credentialsMatch(candidate, expected) {
  const a = createHash('sha256').update(candidate, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

function deny(status, message) {
  const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' };
  if (status === 401) headers['WWW-Authenticate'] = `Basic realm="${REALM}", charset="UTF-8"`;
  return new Response(message, { status, headers });
}

export default function middleware(request) {
  const expected = process.env.SITE_PASSWORD;

  // Fail closed: no configured credential means no access, full stop. This must be the first
  // check, ahead of even parsing the request's own Authorization header, so there is no code path
  // that reaches "let the request through" without a credential having been checked against
  // something real.
  if (!expected) return deny(503, 'Site access is not configured.');

  const header = request.headers.get('authorization') || '';
  const spaceIndex = header.indexOf(' ');
  const scheme = spaceIndex === -1 ? header : header.slice(0, spaceIndex);
  const encoded = spaceIndex === -1 ? '' : header.slice(spaceIndex + 1);
  if (scheme !== 'Basic' || !encoded) return deny(401, 'Authentication required.');

  let decoded;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return deny(401, 'Authentication required.');
  }

  // HTTP Basic Auth carries "user:pass"; only the password half is a real credential here, so the
  // username is accepted as anything (the operator can tell people to type any username, e.g. the
  // site name) and only the text after the first colon is checked. A colon in the password itself
  // stays intact because we split on the FIRST colon only.
  const colonIndex = decoded.indexOf(':');
  const password = colonIndex === -1 ? decoded : decoded.slice(colonIndex + 1);

  if (!credentialsMatch(password, expected)) return deny(401, 'Invalid credentials.');

  return next();
}
