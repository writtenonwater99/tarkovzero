#!/usr/bin/env node
// TarkovZero Companion: watches the EFT Screenshots folder, parses the position/rotation that the game
// puts in each screenshot filename, and streams it to the relay under your pairing code.
// Also serves a small local UI (http://127.0.0.1:4173) for pairing code, settings and a live log.
//
//   node companion.mjs                 # first run creates companion.json with a random code
//   node companion.mjs --simulate      # no game needed: walks a fake player around Customs
//   options (also stored in companion.json): --dir <screenshots folder> --relay <wss url> --code <CODE>
//     --name <text> (shown on the map instead of the code) --keep (don't delete screenshots)
//     --auto <ms> (auto-press screenshot key) --map <name> (skip log detection)
//     --logs <EFT Logs folder> --elevation-log <file> (default elevation-<map>.jsonl) --verbose
//   UI options: --headless (no UI server) --port <n> (default 4173) --no-open (don't open the browser)
// Runs with Windows node or WSL node (paths under /mnt/c are handled).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(here, 'companion.json');
const UI_FILE = path.join(here, 'ui.html');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]] : []).filter((x) => x.length));
const isWin = process.platform === 'win32';
const isWsl = !isWin && fs.existsSync('/mnt/c/Windows');
const verbose = !!args.verbose;
let version = '0.0.0';
try { version = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version || version; } catch {}

// ---- Windows path helpers (work from native Windows node and from WSL)
function toLocal(winPath) { // "C:\Users\me" -> "/mnt/c/Users/me" under WSL, unchanged on Windows
  if (!winPath) return winPath;
  if (isWin) return winPath;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath.trim());
  return m ? path.posix.join('/mnt', m[1].toLowerCase(), m[2].replace(/\\/g, '/')) : winPath;
}
function winEnv(name) {
  try { return execFileSync(isWin ? 'cmd.exe' : 'cmd.exe', ['/c', `echo %${name}%`], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString().trim().replace(/\r/g, ''); } catch { return ''; }
}
function knownDocuments() { // honours OneDrive "Known Folder Move" redirection of Documents
  try { return execFileSync(isWin ? 'powershell' : 'powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('MyDocuments')"], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString().trim().replace(/\r/g, ''); } catch { return ''; }
}
const winHome = isWin ? os.homedir() : toLocal(winEnv('USERPROFILE')) || os.homedir();

function screenshotDirCandidates() {
  const docs = [knownDocuments(), path.join(winHome, 'Documents'), path.join(winHome, 'OneDrive', 'Documents')].filter(Boolean).map(toLocal);
  return [...new Set(docs)].map((d) => path.join(d, 'Escape from Tarkov', 'Screenshots'));
}
function logsDirCandidates() {
  const c = [];
  const local = toLocal(winEnv('LOCALAPPDATA')) || path.join(winHome, 'AppData', 'Local');
  c.push(path.join(local, 'Battlestate Games', 'EFT', 'Logs')); // BSG launcher install
  const steamRoots = [toLocal('C:\\Program Files (x86)\\Steam')];
  try { // extra Steam libraries
    const vdf = fs.readFileSync(path.join(steamRoots[0], 'steamapps', 'libraryfolders.vdf'), 'utf8');
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) steamRoots.push(toLocal(m[1].replace(/\\\\/g, '\\')));
  } catch {}
  for (const r of new Set(steamRoots)) c.push(path.join(r, 'steamapps', 'common', 'Escape from Tarkov', 'build', 'Logs')); // Steam install
  return c;
}

const defaults = {
  code: null,
  name: null, // shown on the map instead of the code; sent with every position
  relay: 'wss://tarkovzero-relay.fly.dev',
  dir: null,   // auto-detected when null
  logs: null,  // auto-detected when null
  map: null,   // fixed map name; null = detect from logs, fallback 'customs'
  deleteScreenshots: true,
  autoMs: 0,
  screenshotKey: null, // SendKeys string; null = read from EFT log, fallback {PRTSC}
};
function cleanName(v) {
  if (v === null || v === undefined || v === true) return null;
  const s = String(v).trim().slice(0, 24).trim();
  return s || null;
}
let cfg = { ...defaults };
try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CONFIG, 'utf8')) }; } catch {}
if (args.dir) cfg.dir = args.dir;
if (args.logs) cfg.logs = args.logs;
if (args.map) cfg.map = String(args.map);
if (args.relay) cfg.relay = args.relay;
if (args.code) cfg.code = String(args.code);
if (args.name !== undefined) cfg.name = cleanName(args.name);
if (args.keep) cfg.deleteScreenshots = false;
if (args.auto) cfg.autoMs = Number(args.auto);
cfg.name = cleanName(cfg.name);
function newCode() { return Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join(''); }
if (!cfg.code || args.newcode) cfg.code = newCode();
function saveConfig() { try { fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2)); } catch (e) { log('could not save companion.json: ' + e.message); } }
saveConfig();

// ---- log fan-out: stdout + UI ring buffer + SSE
const events = [];
const sseClients = new Set();
function pushEvent(text) {
  events.push(text);
  while (events.length > 100) events.shift();
  for (const res of sseClients) { try { res.write(`data: ${String(text).replace(/\r/g, '').split('\n').join('\ndata: ')}\n\n`); } catch {} }
}
function log(line) { console.log(line); pushEvent(String(line)); }
function logInline(line) { // terminal keeps it on one line, the UI gets a normal event
  process.stdout.write(`\r${line}   `);
  pushEvent(String(line).trim());
}
function stateChanged() { // hint to the UI that it should refetch /api/state
  for (const res of sseClients) { try { res.write('data: {"state":true}\n\n'); } catch {} }
}

// ---- screenshots folder + logs folder (re-targetable from the UI)
let dirCandidates = [], dir = null, logsCandidates = [], logsDir = null;
function resolveDirs() {
  dirCandidates = cfg.dir ? [toLocal(cfg.dir)] : screenshotDirCandidates();
  dir = dirCandidates.find((d) => fs.existsSync(d)) || dirCandidates[0];
  logsCandidates = cfg.logs ? [toLocal(cfg.logs)] : logsDirCandidates();
  logsDir = logsCandidates.find((d) => fs.existsSync(d)) || null;
}
resolveDirs();
const autoDir = () => (screenshotDirCandidates().find((d) => fs.existsSync(d)) || screenshotDirCandidates()[0] || null);

// ---- relay connection (auto-reconnect)
let ws = null, sent = 0, lastPos = null, reconnectTimer = null;
function connect() {
  const target = `${cfg.relay}/pub/${cfg.code}`;
  const mine = ws = new WebSocket(target);
  ws.on('open', () => { if (ws === mine) { log('connected to relay'); stateChanged(); } });
  ws.on('close', () => {
    if (ws !== mine) return; // superseded by a newer socket (code/relay change)
    log('relay disconnected, retrying…'); stateChanged();
    clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, 2000);
  });
  ws.on('error', (e) => { if (ws === mine) log('relay error: ' + e.message); });
}
function reconnect() {
  clearTimeout(reconnectTimer);
  const old = ws; ws = null;
  try { old?.removeAllListeners(); old?.close(); } catch {}
  connect();
}
connect();
function send(msg) {
  if (ws?.readyState !== 1) { log('  (relay not connected, dropped)'); return false; }
  ws.send(JSON.stringify(msg)); sent++;
  return true;
}

// ---- screenshot filename -> position
// Observed format (EFT 1.1.0.1 Steam build, 2026-08): see CLAUDE.md "Screenshot filename".
// "2026-08-28[21-14]_-136.1, 1.9, 92.3_0.0, -0.4, 0.0, 0.9_11.83 (0).png" => x,y,z then quaternion x,y,z,w
const RE = /_(-?[\d.]+), (-?[\d.]+), (-?[\d.]+)_(-?[\d.]+), (-?[\d.]+), (-?[\d.]+), (-?[\d.]+)_/;
export function quatToYaw(qx, qy, qz, qw) {
  // Unity (Y-up, left-handed): heading = angle of the rotated forward vector (0,0,1) in the XZ plane,
  // measured from +Z towards +X. forward = (2(xz+wy), 2(yz-wx), 1-2(x²+y²)).
  return (Math.atan2(2 * (qx * qz + qw * qy), 1 - 2 * (qx * qx + qy * qy)) * 180) / Math.PI;
}
export function parseScreenshot(name) {
  const m = RE.exec(name); if (!m) return null;
  const [x, y, z, qx, qy, qz, qw] = m.slice(1).map(Number);
  return { type: 'pos', x, y, z, yaw: +quatToYaw(qx, qy, qz, qw).toFixed(1) };
}

// ---- map + screenshot key from the EFT logs
const MAP_NAMES = { bigmap: 'customs', factory4_day: 'factory', factory4_night: 'factory', woods: 'woods', shoreline: 'shoreline', interchange: 'interchange', rezervbase: 'reserve', lighthouse: 'lighthouse', tarkovstreets: 'streets', laboratory: 'labs', sandbox: 'ground-zero', sandbox_high: 'ground-zero', labyrinth: 'labyrinth' };
export function normalizeMap(raw) { const k = String(raw || '').toLowerCase(); return MAP_NAMES[k] || k || null; }
const SENDKEYS = { SysReq: '{PRTSC}', Print: '{PRTSC}', Insert: '{INS}', Delete: '{DEL}', Home: '{HOME}', End: '{END}', PageUp: '{PGUP}', PageDown: '{PGDN}', Pause: '{BREAK}', ScrollLock: '{SCROLLLOCK}', Backspace: '{BS}', Tab: '{TAB}', Return: '{ENTER}', Escape: '{ESC}' };
export function keyToSendKeys(keyCode) {
  if (!keyCode) return null;
  if (SENDKEYS[keyCode]) return SENDKEYS[keyCode];
  if (/^F\d{1,2}$/.test(keyCode)) return `{${keyCode}}`;
  if (/^Alpha(\d)$/.test(keyCode)) return keyCode.slice(5);
  if (/^[A-Z]$/.test(keyCode)) return keyCode.toLowerCase();
  return null;
}
function newestLogSession() {
  if (!logsDir) return null;
  try {
    const dirs = fs.readdirSync(logsDir).filter((d) => d.startsWith('log_')).sort();
    return dirs.length ? path.join(logsDir, dirs[dirs.length - 1]) : null;
  } catch { return null; }
}
function tail(file, bytes = 256 * 1024) {
  try { const st = fs.statSync(file); const fd = fs.openSync(file, 'r'); const len = Math.min(bytes, st.size); const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd); return buf.toString('utf8'); } catch { return ''; }
}
let detectedMap = null, detectedKey = null, lastSession = null;
function pollLogs() {
  const session = newestLogSession(); if (!session) return;
  let files; try { files = fs.readdirSync(session); } catch { return; }
  if (session !== lastSession) { lastSession = session; detectedKey = null; if (verbose) log('log session: ' + session); stateChanged(); }
  // Map: every raid load (solo, practice, group) logs "scene preset path:maps/customs_preset.bundle
  // rcid:bigmap.scenespreset.asset" in application_*.log — that's authoritative. Fallback: the last
  // "location": "<id>" (groupMatchRaidSettings in push-notifications).
  let found = null;
  for (const f of files.filter((f) => /application/.test(f))) {
    const ms = [...tail(path.join(session, f)).matchAll(/rcid:([A-Za-z0-9_]+)\.scenespreset/g)];
    if (ms.length) found = ms[ms.length - 1][1];
  }
  if (!found) for (const f of files.filter((f) => /push-notifications/.test(f))) {
    const ms = [...tail(path.join(session, f)).matchAll(/"location":\s*"([A-Za-z0-9_]+)"/g)];
    if (ms.length) found = ms[ms.length - 1][1];
  }
  if (found && normalizeMap(found) !== detectedMap) { detectedMap = normalizeMap(found); log(`map from logs: ${found} → ${detectedMap}`); stateChanged(); }
  // Screenshot key: the application log dumps the key bindings once per session.
  if (!detectedKey) {
    for (const f of files.filter((f) => /application/.test(f))) {
      const m = /"keyName":"MakeScreenshot","variants":\[\{"keyCode":\["([A-Za-z0-9]+)"/.exec(fs.readFileSync(path.join(session, f), 'utf8'));
      if (m) { detectedKey = m[1]; if (verbose) log(`screenshot key from logs: ${m[1]} (SendKeys ${keyToSendKeys(m[1]) || '?'})`); stateChanged(); }
    }
  }
}
const currentMap = () => cfg.map || detectedMap || 'customs';
const currentKey = () => cfg.screenshotKey || keyToSendKeys(detectedKey) || '{PRTSC}';
const elevationArg = args['elevation-log'];
const elevationLogging = !['off', 'false', '0'].includes(String(elevationArg).toLowerCase());
const elevationFile = (map) => {
  if (!elevationLogging) return null;
  if (elevationArg && elevationArg !== true) return path.resolve(toLocal(String(elevationArg)));
  return path.join(here, `elevation-${String(map || 'customs').replace(/[^a-z0-9_-]/gi, '-').toLowerCase()}.jsonl`);
};
let elevationLogWarned = false;
function logElevation(msg, t = Date.now()) {
  const file = elevationFile(msg.map); if (!file) return;
  try { fs.appendFileSync(file, `${JSON.stringify({ map: msg.map, x: msg.x, y: msg.y, z: msg.z, t })}\n`); }
  catch (error) { if (!elevationLogWarned) { elevationLogWarned = true; log(`could not append elevation log ${file}: ${error.message}`); } }
}
function posMessage(p) { // every position carries the username when one is set
  const msg = { ...p, map: currentMap() };
  if (cfg.name) msg.name = cfg.name;
  return msg;
}
function rememberPos(msg) {
  lastPos = { x: msg.x, y: msg.y, z: msg.z, yaw: msg.yaw, map: msg.map, name: msg.name ?? null, t: Date.now() };
  stateChanged();
}

// ---- header
log(`
  TarkovZero Companion
  ────────────────────
  Pairing code : ${cfg.code.slice(0, 3)}-${cfg.code.slice(3)}   (enter this on tarkovzero.com → Live position)
  Username     : ${cfg.name || '(none — the code is shown on the map)'}
  Relay        : ${cfg.relay}
  Screenshots  : ${args.simulate ? '(simulation)' : dir}${!args.simulate && !fs.existsSync(dir) ? '  (not created yet — EFT makes it on the first screenshot)' : ''}
  EFT logs     : ${logsDir || '(not found — map detection off; use --logs or --map)'}
  Map          : ${cfg.map || 'auto (from logs, fallback customs)'}
  Delete PNGs  : ${cfg.deleteScreenshots}   Auto-screenshot: ${cfg.autoMs ? cfg.autoMs + ' ms' : 'off'}
  Elevation log: ${elevationLogging ? (elevationArg && elevationArg !== true ? elevationFile(currentMap()) : 'elevation-<map>.jsonl (next to companion.json)') : 'off'}
`);

// ---- local UI server (127.0.0.1 only)
function stateJson() {
  return {
    code: cfg.code,
    codePretty: `${cfg.code.slice(0, 3)}-${cfg.code.slice(3)}`,
    name: cfg.name || null,
    dir,
    dirExists: !!dir && fs.existsSync(dir),
    logsDir,
    logSession: lastSession ? path.basename(lastSession) : null,
    map: currentMap(),
    detectedMap,
    mapOverride: cfg.map || null,
    deleteScreenshots: !!cfg.deleteScreenshots,
    autoMs: Number(cfg.autoMs) || 0,
    screenshotKey: currentKey(),
    relayConnected: ws?.readyState === 1,
    relay: cfg.relay,
    sent,
    lastPos,
    events: events.slice(-100),
    version,
    simulate: !!args.simulate,
    autoDir: args.simulate ? null : autoDir(),
  };
}
function sendJson(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}
function applyConfig(body) {
  let retarget = false, relayChanged = false, autoChanged = false;
  if ('name' in body) cfg.name = cleanName(body.name);
  if ('dir' in body) {
    const v = body.dir === null || String(body.dir).trim() === '' ? null : String(body.dir).trim();
    if (v !== cfg.dir) { cfg.dir = v; retarget = true; }
  }
  if ('logs' in body) {
    const v = body.logs === null || String(body.logs).trim() === '' ? null : String(body.logs).trim();
    if (v !== cfg.logs) { cfg.logs = v; retarget = true; }
  }
  if ('map' in body) {
    const v = body.map === null || String(body.map).trim() === '' || String(body.map) === 'auto' ? null : String(body.map).trim();
    cfg.map = v;
  }
  if ('deleteScreenshots' in body) cfg.deleteScreenshots = !!body.deleteScreenshots;
  if ('autoMs' in body) {
    const v = Math.max(0, Math.round(Number(body.autoMs) || 0));
    if (v !== cfg.autoMs) { cfg.autoMs = v; autoChanged = true; }
  }
  if ('relay' in body && body.relay && String(body.relay).trim() !== cfg.relay) { cfg.relay = String(body.relay).trim(); relayChanged = true; }
  saveConfig();
  if (retarget) { resolveDirs(); retargetWatcher(); }
  if (autoChanged) restartAuto();
  if (relayChanged) { log('relay changed to ' + cfg.relay); reconnect(); }
  log('settings updated from the UI');
  stateChanged();
}
// The UI server is loopback-only, but any website open in the same browser can still POST to it
// (CSRF) or point a hostname at 127.0.0.1 (DNS rebinding). Three cheap defences, no CORS headers:
//   1. Host/Origin must be our own loopback origin.  2. POSTs must be application/json (blocks the
//   form enctype=text/plain trick).  3. /api/* needs the per-run token from the launch URL.
const uiToken = crypto.randomBytes(24).toString('hex');
let uiPort = null;
function originOk(req) {
  const hosts = [`127.0.0.1:${uiPort}`, `localhost:${uiPort}`];
  if (!hosts.includes(String(req.headers.host || ''))) return false;
  const origin = req.headers.origin;
  if (origin && !hosts.some((h) => origin === `http://${h}`)) return false;
  return true;
}
function tokenOk(req, url) {
  const given = req.headers['x-tz-token'] || url.searchParams.get('t') || '';
  const a = Buffer.from(String(given)), b = Buffer.from(uiToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  if (!originOk(req)) { res.writeHead(403, { 'content-type': 'text/plain' }); return res.end('forbidden'); }
  if (p.startsWith('/api/')) {
    if (req.method === 'POST' && !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
      return sendJson(res, { error: 'content-type must be application/json' }, 415);
    }
    if (!tokenOk(req, url)) return sendJson(res, { error: 'bad or missing token — open the UI from the URL the companion printed' }, 401);
  }
  if (p === '/' || p === '/index.html' || p === '/ui.html') {
    let html; try { html = fs.readFileSync(UI_FILE); } catch { res.writeHead(500, { 'content-type': 'text/plain' }); return res.end('ui.html missing'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': html.length });
    return res.end(html);
  }
  if (p === '/api/state' && req.method === 'GET') return sendJson(res, stateJson());
  if (p === '/api/config' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || typeof body !== 'object') return sendJson(res, { error: 'bad json' }, 400);
    applyConfig(body);
    return sendJson(res, stateJson());
  }
  if (p === '/api/newcode' && req.method === 'POST') {
    cfg.code = newCode(); saveConfig();
    log(`new pairing code: ${cfg.code.slice(0, 3)}-${cfg.code.slice(3)}`);
    reconnect(); stateChanged();
    return sendJson(res, stateJson());
  }
  if (p === '/api/quit' && req.method === 'POST') {
    sendJson(res, { ok: true });
    log('quit requested from the UI');
    setTimeout(() => process.exit(0), 200);
    return;
  }
  if (p === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 2000\n\n');
    for (const line of events.slice(-100)) res.write(`data: ${line.replace(/\r/g, '').split('\n').join('\ndata: ')}\n\n`);
    res.write('data: {"state":true}\n\n');
    sseClients.add(res);
    const ka = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
    req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}
function listenOn(server, port) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => { server.removeListener('listening', onOk); reject(e); };
    const onOk = () => { server.removeListener('error', onErr); resolve(port); };
    server.once('error', onErr); server.once('listening', onOk);
    server.listen(port, '127.0.0.1');
  });
}
function openBrowser(url) {
  try {
    if (isWin) spawn('cmd', ['/c', 'start', '""', url], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
    else if (isWsl) spawn('cmd.exe', ['/c', 'start', '""', url], { stdio: 'ignore', detached: true }).unref();
    else spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
  } catch (e) { log('could not open the browser: ' + e.message); }
}
if (!args.headless) {
  const first = Math.max(1, Math.round(Number(args.port) || 4173));
  const server = http.createServer((req, res) => { handle(req, res).catch((e) => { try { sendJson(res, { error: e.message }, 500); } catch {} }); });
  let bound = null;
  for (let i = 0; i <= 20; i++) {
    try { bound = await listenOn(server, first + i); break; } catch (e) { if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') { log('UI server error: ' + e.message); break; } }
  }
  if (bound) {
    uiPort = bound;
    const url = `http://127.0.0.1:${bound}/#t=${uiToken}`;
    // full URL (with the per-run token) to the terminal only; the UI's own log panel gets the bare address
    console.log(`  UI           : ${url}\n                 (the token is new every run — open the UI from this URL)\n`);
    pushEvent(`  UI           : http://127.0.0.1:${bound}`);
    if (!args['no-open']) openBrowser(url);
  } else log(`could not bind the UI server to ports ${first}–${first + 20} (running without the UI)`);
}

// ---- runtime loops
let autoTimer = null;
function restartAuto() {
  clearInterval(autoTimer); autoTimer = null;
  if (args.simulate || !(cfg.autoMs > 0)) { if (!args.simulate) log('auto-screenshot off'); return; }
  const ps = isWin ? 'powershell' : 'powershell.exe';
  autoTimer = setInterval(() => {
    const key = currentKey();
    spawn(ps, ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${key}')`], { stdio: 'ignore', windowsHide: true });
  }, cfg.autoMs);
  log(`auto-screenshot every ${cfg.autoMs} ms (sends the in-game screenshot key to the active window)`);
}

let seen = new Set(), announced = false, primed = false;
function retargetWatcher() {
  seen = new Set(); announced = false; primed = false;
  log('watching folder: ' + dir);
}
function scan() {
  if (!dir || !fs.existsSync(dir)) {
    dir = dirCandidates.find((d) => fs.existsSync(d)) || dir;
    if (!dir || !fs.existsSync(dir)) { if (!announced) { announced = true; log(`waiting for ${dir} to appear (take one screenshot in game)…`); } return; }
    log(`screenshots folder appeared: ${dir}`); stateChanged();
  }
  let files; try { files = fs.readdirSync(dir); } catch (e) { log('cannot read folder: ' + e.message); return; }
  if (!primed) { primed = true; for (const f of files) seen.add(f); log(`watching ${dir} (${files.length} existing file(s) ignored)… Ctrl+C to quit`); return; }
  for (const file of files) {
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(png|jpg|jpeg)$/i.test(file)) continue;
    const full = path.join(dir, file);
    const now = Date.now();
    let age = null; try { age = Math.round(now - fs.statSync(full).mtimeMs); } catch {}
    const p = parseScreenshot(file);
    if (!p) { log(`could not parse position from filename: ${file}`); continue; }
    const msg = posMessage(p);
    logElevation(msg, now);
    const ok = send(msg);
    log(`  ${ok ? 'sent' : 'DROP'} #${sent}  x ${msg.x}  y ${msg.y}  z ${msg.z}  yaw ${msg.yaw}  map ${msg.map}${msg.name ? '  name ' + msg.name : ''}  (file→detect ${age ?? '?'} ms)${verbose ? '  ' + file : ''}`);
    if (ok) rememberPos(msg);
    if (cfg.deleteScreenshots) setTimeout(() => fs.rm(full, () => {}), 3000);
  }
}

if (args.simulate) {
  // Walk a loop around Customs (game coords) so the whole chain can be tested without the game.
  const route = [[-215, -119], [-150, -100], [-69, 9], [75, -9], [200, -13], [238, 53], [200, 150], [110, 85], [-66, 46], [-211, -219]];
  let i = 0, t = 0;
  setInterval(() => {
    const a = route[i], b = route[(i + 1) % route.length];
    const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
    const yaw = (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;
    const msg = posMessage({ type: 'pos', x: +x.toFixed(1), y: 0, z: +z.toFixed(1), yaw: +yaw.toFixed(1) });
    msg.map = 'customs';
    if (send(msg)) { logInline(`  sent ${sent}: x ${msg.x} z ${msg.z} yaw ${msg.yaw}`); rememberPos(msg); }
    t += 0.1; if (t >= 1) { t = 0; i = (i + 1) % route.length; }
  }, 700);
} else {
  if (logsDir) { pollLogs(); setInterval(pollLogs, 5000); }
  // Poll the folder instead of fs.watch: fs.watch does not fire on /mnt/c (WSL drvfs) and can miss
  // rapid writes on NTFS. 250 ms polling adds negligible delay and works everywhere.
  scan(); setInterval(scan, 250);
  if (cfg.autoMs > 0) restartAuto();
}
