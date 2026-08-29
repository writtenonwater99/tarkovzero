#!/usr/bin/env node
// TarkovZero Companion: watches the EFT Screenshots folder, parses the position/rotation that the game
// puts in each screenshot filename, and streams it to the relay under your pairing code.
//
//   node companion.mjs                 # first run creates companion.json with a random code
//   node companion.mjs --simulate      # no game needed: walks a fake player around Customs
//   options (also stored in companion.json): --dir <screenshots folder> --relay <wss url> --code <CODE>
//                                            --keep (don't delete screenshots) --auto <ms> (auto-press screenshot key)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CONFIG = path.join(here, 'companion.json');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]] : []).filter((x) => x.length));

const defaults = {
  code: null,
  relay: 'wss://tarkovzero-relay.fly.dev',
  dir: path.join(os.homedir(), 'Documents', 'Escape from Tarkov', 'Screenshots'),
  deleteScreenshots: true,
  autoMs: 0,
  screenshotKey: '{PRTSC}',
};
let cfg = { ...defaults };
try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CONFIG, 'utf8')) }; } catch {}
if (args.dir) cfg.dir = args.dir;
if (args.relay) cfg.relay = args.relay;
if (args.code) cfg.code = String(args.code);
if (args.keep) cfg.deleteScreenshots = false;
if (args.auto) cfg.autoMs = Number(args.auto);
if (!cfg.code || args.newcode) cfg.code = Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));

console.log(`
  TarkovZero Companion
  ────────────────────
  Pairing code : ${cfg.code.slice(0, 3)}-${cfg.code.slice(3)}   (enter this on tarkovzero.com → Live position)
  Relay        : ${cfg.relay}
  Screenshots  : ${args.simulate ? '(simulation)' : cfg.dir}
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
function send(msg) { if (ws?.readyState === 1) { ws.send(JSON.stringify(msg)); sent++; process.stdout.write(`\r  sent ${sent}: x ${msg.x} z ${msg.z} yaw ${msg.yaw}   `); } }

// ---- screenshot filename -> position
// e.g. "2026-08-28[21-14]_-136.1, 1.9, 92.3_0.0, -0.4, 0.0, 0.9_11.83 (0).png"  => x,y,z then quaternion x,y,z,w
const RE = /_(-?[\d.]+), (-?[\d.]+), (-?[\d.]+)_(-?[\d.]+), (-?[\d.]+), (-?[\d.]+), (-?[\d.]+)_/;
export function parseScreenshot(name) {
  const m = RE.exec(name); if (!m) return null;
  const [x, y, z, qx, qy, qz, qw] = m.slice(1).map(Number);
  const yaw = (Math.atan2(2 * (qw * qy + qx * qz), 1 - 2 * (qy * qy + qz * qz)) * 180) / Math.PI; // Unity Y-up yaw
  return { type: 'pos', x, y, z, yaw: +yaw.toFixed(1) };
}

if (args.simulate) {
  // Walk a loop around Customs (game coords) so the whole chain can be tested without the game.
  const route = [[-215, -119], [-150, -100], [-69, 9], [75, -9], [200, -13], [238, 53], [200, 150], [110, 85], [-66, 46], [-211, -219]];
  let i = 0, t = 0;
  setInterval(() => {
    const a = route[i], b = route[(i + 1) % route.length];
    const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
    const yaw = (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;
    send({ type: 'pos', x: +x.toFixed(1), y: 0, z: +z.toFixed(1), yaw: +yaw.toFixed(1), map: 'customs' });
    t += 0.1; if (t >= 1) { t = 0; i = (i + 1) % route.length; }
  }, 700);
} else {
  if (!fs.existsSync(cfg.dir)) { console.error(`Screenshots folder not found: ${cfg.dir}\nSet it with --dir "C:\\path\\to\\Screenshots"`); process.exit(1); }
  const seen = new Set();
  fs.watch(cfg.dir, (_, file) => {
    if (!file || !file.endsWith('.png') || seen.has(file)) return;
    const p = parseScreenshot(file); if (!p) return;
    seen.add(file);
    send({ ...p, map: 'customs' });
    if (cfg.deleteScreenshots) setTimeout(() => fs.rm(path.join(cfg.dir, file), () => {}), 3000);
  });
  console.log('watching for screenshots… (Ctrl+C to quit)');
  if (cfg.autoMs > 0 && process.platform === 'win32') {
    console.log(`auto-screenshot every ${cfg.autoMs} ms (sends ${cfg.screenshotKey} to the active window)`);
    setInterval(() => spawn('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${cfg.screenshotKey}')`], { stdio: 'ignore' }), cfg.autoMs);
  }
}
