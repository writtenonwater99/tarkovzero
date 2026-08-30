// TarkovZero relay: rooms keyed by pairing code. Publishers (companion app) push positions,
// subscribers (the website) receive them. Keeps the last position per room for late joiners.
//
//   ws  /pub/CODE      publisher socket ({type:'pos'|'map'})
//   ws  /sub/CODE      subscriber socket; gets 'hello', then the cached position and quest set
//   POST /pos/CODE     position without a socket
//   POST /quests/CODE  {active,done,failed,accountId,ts,since} -> broadcast as {type:'quests',…},
//                      cached per room exactly like the last position
import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 8787;
const CODE_RE = /^[A-Z0-9]{6}$/;
const norm = (c) => (c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const rooms = new Map(); // code -> { subs:Set<ws>, last:object|null, quests:object|null, pubs:number }
const room = (code) => rooms.get(code) ?? rooms.set(code, { subs: new Set(), last: null, quests: null, pubs: 0 }).get(code);

function publish(code, msg) {
  const r = room(code);
  const payload = JSON.stringify({ ...msg, code, t: Date.now() });
  if (msg.type === 'pos') r.last = payload;
  // the active-quest set is cached exactly like the last position, so a late joiner gets it too
  if (msg.type === 'quests') r.quests = payload;
  for (const ws of r.subs) if (ws.readyState === 1) ws.send(payload);
}
const idList = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && /^[0-9a-f]{12,32}$/i.test(s)).slice(0, 500) : []);

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.end();
  const m = req.url.match(/^\/pos\/([^/?]+)$/);
  if (req.method === 'POST' && m) { // HTTP alternative for simple publishers (e.g. PowerShell)
    const code = norm(m[1]);
    if (!CODE_RE.test(code)) { res.statusCode = 400; return res.end('bad code'); }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try { publish(code, { type: 'pos', ...JSON.parse(body) }); res.end('ok'); }
      catch { res.statusCode = 400; res.end('bad json'); }
    });
    return;
  }
  const q = req.url.match(/^\/quests\/([^/?]+)$/);
  if (req.method === 'POST' && q) { // companion -> relay: the player's active/done/failed quest ids
    const code = norm(q[1]);
    if (!CODE_RE.test(code)) { res.statusCode = 400; return res.end('bad code'); }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 200_000) req.destroy(); });
    req.on('end', () => {
      let b;
      try { b = JSON.parse(body); } catch { res.statusCode = 400; return res.end('bad json'); }
      publish(code, {
        type: 'quests',
        active: idList(b.active), done: idList(b.done), failed: idList(b.failed),
        accountId: b.accountId == null ? null : String(b.accountId).slice(0, 32),
        since: b.since == null ? null : String(b.since).slice(0, 32),
        ts: Number(b.ts) || Date.now(),
      });
      res.end('ok');
    });
    return;
  }
  if (req.url === '/health') return res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
  res.statusCode = 404; res.end();
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const role = url.pathname.startsWith('/pub') ? 'pub' : url.pathname.startsWith('/sub') ? 'sub' : null;
  const code = norm(url.pathname.split('/')[2]);
  if (!role || !CODE_RE.test(code)) return ws.close(4000, 'bad path; use /pub/CODE or /sub/CODE');
  const r = room(code);
  ws.isAlive = true; ws.on('pong', () => (ws.isAlive = true));
  if (role === 'sub') {
    r.subs.add(ws);
    ws.send(JSON.stringify({ type: 'hello', code, publishers: r.pubs }));
    if (r.last) ws.send(r.last);
    if (r.quests) ws.send(r.quests);
    ws.on('close', () => r.subs.delete(ws));
  } else {
    r.pubs++;
    publish(code, { type: 'status', publishers: r.pubs });
    ws.on('message', (data) => {
      try { const msg = JSON.parse(data); if (msg.type === 'pos' || msg.type === 'map') publish(code, msg); } catch {}
    });
    ws.on('close', () => { r.pubs--; publish(code, { type: 'status', publishers: r.pubs }); });
  }
});
setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); } }, 30_000);
server.listen(PORT, () => console.log(`relay listening on :${PORT}`));
