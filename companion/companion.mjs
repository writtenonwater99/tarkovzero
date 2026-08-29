#!/usr/bin/env node
// TarkovZero Companion: watches the EFT Screenshots folder, parses the position/rotation that the game
// puts in each screenshot filename, and streams it to the relay under your pairing code.
//
//   node companion.mjs                 # first run creates companion.json with a random code
//   node companion.mjs --simulate      # no game needed: walks a fake player around Customs
//   options (also stored in companion.json): --dir <screenshots folder> --relay <wss url> --code <CODE>
//     --keep (don't delete screenshots) --auto <ms> (auto-press screenshot key) --map <name> (skip log detection)
//     --logs <EFT Logs folder> --verbose
// Runs with Windows node or WSL node (paths under /mnt/c are handled).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(here, 'companion.json');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]] : []).filter((x) => x.length));
const isWin = process.platform === 'win32';
const isWsl = !isWin && fs.existsSync('/mnt/c/Windows');
const verbose = !!args.verbose;

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
  relay: 'wss://tarkovzero-relay.fly.dev',
  dir: null,   // auto-detected when null
  logs: null,  // auto-detected when null
  map: null,   // fixed map name; null = detect from logs, fallback 'customs'
  deleteScreenshots: true,
  autoMs: 0,
  screenshotKey: null, // SendKeys string; null = read from EFT log, fallback {PRTSC}
};
let cfg = { ...defaults };
try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CONFIG, 'utf8')) }; } catch {}
if (args.dir) cfg.dir = args.dir;
if (args.logs) cfg.logs = args.logs;
if (args.map) cfg.map = String(args.map);
if (args.relay) cfg.relay = args.relay;
if (args.code) cfg.code = String(args.code);
if (args.keep) cfg.deleteScreenshots = false;
if (args.auto) cfg.autoMs = Number(args.auto);
if (!cfg.code || args.newcode) cfg.code = Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));

const dirCandidates = cfg.dir ? [toLocal(cfg.dir)] : screenshotDirCandidates();
let dir = dirCandidates.find((d) => fs.existsSync(d)) || dirCandidates[0];
const logsCandidates = cfg.logs ? [toLocal(cfg.logs)] : logsDirCandidates();
const logsDir = logsCandidates.find((d) => fs.existsSync(d)) || null;

console.log(`
  TarkovZero Companion
  ────────────────────
  Pairing code : ${cfg.code.slice(0, 3)}-${cfg.code.slice(3)}   (enter this on tarkovzero.com → Live position)
  Relay        : ${cfg.relay}
  Screenshots  : ${args.simulate ? '(simulation)' : dir}${!args.simulate && !fs.existsSync(dir) ? '  (not created yet — EFT makes it on the first screenshot)' : ''}
  EFT logs     : ${logsDir || '(not found — map detection off; use --logs or --map)'}
  Map          : ${cfg.map || 'auto (from logs, fallback customs)'}
  Delete PNGs  : ${cfg.deleteScreenshots}   Auto-screenshot: ${cfg.autoMs ? cfg.autoMs + ' ms' : 'off'}
`);

// ---- relay connection (auto-reconnect)
let ws, sent = 0;
function connect() {
  ws = new WebSocket(`${cfg.relay}/pub/${cfg.code}`);
  ws.on('open', () => console.log('connected to relay'));
  ws.on('close', () => { console.log('relay disconnected, retrying…'); setTimeout(connect, 2000); });
  ws.on('error', (e) => console.log('relay error:', e.message));
}
connect();
function send(msg) {
  if (ws?.readyState !== 1) { console.log('  (relay not connected, dropped)'); return false; }
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
  if (session !== lastSession) { lastSession = session; detectedKey = null; if (verbose) console.log('log session:', session); }
  // Map: the game names the raid location in push-notifications (groupMatchRaidSettings) and,
  // for some raid types, in output/backend; take the last "location": "<id>" we can find.
  let found = null;
  for (const f of files.filter((f) => /push-notifications|output|backend|application/.test(f))) {
    const text = tail(path.join(session, f));
    const ms = [...text.matchAll(/"location":\s*"([A-Za-z0-9_]+)"/g)];
    if (ms.length) found = ms[ms.length - 1][1];
  }
  if (found && normalizeMap(found) !== detectedMap) { detectedMap = normalizeMap(found); console.log(`map from logs: ${found} → ${detectedMap}`); }
  // Screenshot key: the application log dumps the key bindings once per session.
  if (!detectedKey) {
    for (const f of files.filter((f) => /application/.test(f))) {
      const m = /"keyName":"MakeScreenshot","variants":\[\{"keyCode":\["([A-Za-z0-9]+)"/.exec(fs.readFileSync(path.join(session, f), 'utf8'));
      if (m) { detectedKey = m[1]; if (verbose) console.log(`screenshot key from logs: ${m[1]} (SendKeys ${keyToSendKeys(m[1]) || '?'})`); }
    }
  }
}
const currentMap = () => cfg.map || detectedMap || 'customs';

if (args.simulate) {
  // Walk a loop around Customs (game coords) so the whole chain can be tested without the game.
  const route = [[-215, -119], [-150, -100], [-69, 9], [75, -9], [200, -13], [238, 53], [200, 150], [110, 85], [-66, 46], [-211, -219]];
  let i = 0, t = 0;
  setInterval(() => {
    const a = route[i], b = route[(i + 1) % route.length];
    const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
    const yaw = (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;
    const msg = { type: 'pos', x: +x.toFixed(1), y: 0, z: +z.toFixed(1), yaw: +yaw.toFixed(1), map: 'customs' };
    if (send(msg)) process.stdout.write(`\r  sent ${sent}: x ${msg.x} z ${msg.z} yaw ${msg.yaw}   `);
    t += 0.1; if (t >= 1) { t = 0; i = (i + 1) % route.length; }
  }, 700);
} else {
  if (logsDir) { pollLogs(); setInterval(pollLogs, 5000); }
  // Poll the folder instead of fs.watch: fs.watch does not fire on /mnt/c (WSL drvfs) and can miss
  // rapid writes on NTFS. 250 ms polling adds negligible delay and works everywhere.
  const seen = new Set();
  let announced = false, primed = false;
  function scan() {
    if (!fs.existsSync(dir)) {
      dir = dirCandidates.find((d) => fs.existsSync(d)) || dir;
      if (!fs.existsSync(dir)) { if (!announced) { announced = true; console.log(`waiting for ${dir} to appear (take one screenshot in game)…`); } return; }
      console.log(`screenshots folder appeared: ${dir}`);
    }
    let files; try { files = fs.readdirSync(dir); } catch (e) { console.log('cannot read folder:', e.message); return; }
    if (!primed) { primed = true; for (const f of files) seen.add(f); console.log(`watching ${dir} (${files.length} existing file(s) ignored)… Ctrl+C to quit`); return; }
    for (const file of files) {
      if (seen.has(file)) continue;
      seen.add(file);
      if (!/\.(png|jpg|jpeg)$/i.test(file)) continue;
      const full = path.join(dir, file);
      const now = Date.now();
      let age = null; try { age = Math.round(now - fs.statSync(full).mtimeMs); } catch {}
      const p = parseScreenshot(file);
      if (!p) { console.log(`\n  could not parse position from filename: ${file}`); continue; }
      const msg = { ...p, map: currentMap() };
      const ok = send(msg);
      console.log(`  ${ok ? 'sent' : 'DROP'} #${sent}  x ${msg.x}  y ${msg.y}  z ${msg.z}  yaw ${msg.yaw}  map ${msg.map}  (file→detect ${age ?? '?'} ms)${verbose ? '  ' + file : ''}`);
      if (cfg.deleteScreenshots) setTimeout(() => fs.rm(full, () => {}), 3000);
    }
  }
  scan(); setInterval(scan, 250);
  if (cfg.autoMs > 0) {
    const ps = isWin ? 'powershell' : 'powershell.exe';
    setInterval(() => {
      const key = cfg.screenshotKey || keyToSendKeys(detectedKey) || '{PRTSC}';
      spawn(ps, ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${key}')`], { stdio: 'ignore', windowsHide: true });
    }, cfg.autoMs);
    console.log(`auto-screenshot every ${cfg.autoMs} ms (sends the in-game screenshot key to the active window)`);
  }
}
