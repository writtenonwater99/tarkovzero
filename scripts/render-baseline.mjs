#!/usr/bin/env node
/**
 * Render baseline — the measurement half of RENDER-REALISM.md Stage 1.
 *
 * The plan's estimates ("+1–2 main/post draws, +6–10 MiB VRAM, +0.4–1.1 ms GPU") are explicitly
 * planning numbers, and Stage 1 owes the project real ones: *"There is no browser in this task.
 * GPU milliseconds, draw calls, and VRAM below are planning deltas, not measurements. The first
 * implementation stage must establish the real baseline with deck/luma stats."*
 *
 * So this walks BOTH looks across ALL THREE maps at the plan's fixed camera bookmarks, reads
 * `window.tz.renderStats()` at each, and writes one JSON. It is the file later stages diff against.
 *
 *   npm run render-baseline                     # build, serve, drive, write .render/baseline.json
 *   node scripts/render-baseline.mjs --skip-build
 *   node scripts/render-baseline.mjs --port 4250          # anything in 4240-4299
 *   node scripts/render-baseline.mjs --out <file> --shots <dir>
 *   node scripts/render-baseline.mjs --look realistic --map customs
 *
 * Ports: the founder's preview owns 4190 and other lanes own 4181-4187 / 4210-4231, so this
 * harness takes 4240-4299 and kills only the PID it started.
 *
 * What the numbers mean, and what they do NOT mean:
 *   - `drawLayers` / `layers` / `models` are exact. They are deck's own counters.
 *   - `textureBytes` is exact for what this renderer uploads (baked ground, Ground106 set, grade
 *     LUT, icon atlases) and `lumaResident` is luma's live total.
 *   - `gpuFrameMs` is null under SwiftShader: software rasterisation exposes no timer query, so
 *     there is nothing to read. A null here means NOT MEASURED, never "free". `cpuFrameMs` is real
 *     but is software-rasteriser CPU time and is not a proxy for GPU cost on a real adapter.
 * The GPU column has to be filled in on real hardware before any stage claims a GPU budget.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { launch } from './lib/cdp.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------------ args -- */
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };

const FIRST_PORT = Number(opt('port', process.env.TZ_BASELINE_PORT ?? 4240));
const OUT = resolve(opt('out', join(ROOT, '.render', 'baseline.json')));
const SHOTS = opt('shots', null) ? resolve(opt('shots')) : null;
const ONLY_LOOK = opt('look', null);
const ONLY_MAP = opt('map', null);
const SKIP_BUILD = flag('skip-build');
const SETTLE = Number(opt('settle', 11000));

if (FIRST_PORT < 4240 || FIRST_PORT > 4299) {
  console.error(`✗ refusing port ${FIRST_PORT}: this harness owns 4240–4299 (4190, 4181–4187 and 4210–4231 belong to other sessions)`);
  process.exit(2);
}

/* ------------------------------------------------------------------- bookmarks -- */
/**
 * The plan's minimum suite, as `#zoom/x/z` permalinks in GAME coordinates. `null` means "the app's
 * own default framing for this map", which is the wide shot every acceptance note starts from.
 *
 * Every close bookmark is a real landmark centroid read once out of `public/data/<map>-3d.json`
 * and then FROZEN here — the plan requires exact, unchanging cameras, so these must never be
 * recomputed from data at run time.
 *
 * Customs is a LADDER — wide, mid, close — and the close rung is the one the whole suite exists for.
 * It used to be `#3.2/203/-128`, "Fortress, close", against a default framing of `#3.15`: a 3.4%
 * scale difference, i.e. four wide shots and nothing to judge a material by (QA H3). The rungs are
 * now well over a zoom level apart each, and the close rung is `#5` on the Fortress — 0.13 m/px
 * against the default framing's ~0.9, where brick, corrugation and window reveals are what the
 * frame is made of. Every row records `honoured`, which is the app's own receipt: the camera clamp
 * rewrites the hash when it moves a permalink, so a bookmark that no longer means what it says
 * fails loudly here instead of quietly measuring some other camera.
 */
const BOOKMARKS = [
  { id: 'customs-wide', map: 'customs', hash: null, note: 'default 3D framing (wide)' },
  { id: 'customs-mid', map: 'customs', hash: '3.6/231/150', note: 'Dorms 2-Story (mid)' },
  { id: 'customs-close', map: 'customs', hash: '5/203/-128', note: 'Fortress (close)' },
  { id: 'reserve-wide-courtyard', map: 'reserve', hash: null, note: 'default 3D framing' },
  { id: 'reserve-courtyard', map: 'reserve', hash: '2.6/-17/17', note: 'White King courtyard' },
  { id: 'woods-wide', map: 'woods', hash: null, note: 'default 3D framing' },
  { id: 'woods-forest-edge', map: 'woods', hash: '2.4/286/-514', note: 'USEC camp forest edge' },
  { id: 'woods-mountain-lake', map: 'woods', hash: '1.6/-105/-360', note: 'Sniper Mountain + lakes' },
];
const LOOKS = ['realistic', 'vector'];

/* -------------------------------------------------------------- preview server -- */
function build() {
  console.log('· building dist …');
  const r = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) { console.error('✗ build failed'); process.exit(1); }
}
const free = (port) => new Promise((res) => {
  const s = createServer();
  s.once('error', () => res(false));
  s.once('listening', () => s.close(() => res(true)));
  s.listen(port, '127.0.0.1');
});
async function pickPort() {
  for (let p = FIRST_PORT; p <= 4299; p++) if (await free(p)) return p;
  throw new Error('no free port in 4240–4299');
}

let server = null;
async function serve(port) {
  server = spawn('npx', ['vite', 'preview', '--configLoader', 'runner', '--port', String(port), '--strictPort'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'], detached: false,
  });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return; } catch {}
    await sleep(250);
  }
  throw new Error('vite preview never came up');
}
const stopServer = () => { try { server?.kill('SIGTERM'); } catch {} };

/* ------------------------------------------------------------------------ run -- */
if (!SKIP_BUILD) build();
if (!existsSync(join(ROOT, 'dist', 'index.html'))) { console.error('✗ no dist/ — run without --skip-build'); process.exit(1); }
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
mkdirSync(dirname(OUT), { recursive: true });

const PORT = await pickPort();
await serve(PORT);
const BASE = `http://127.0.0.1:${PORT}`;
console.log(`· preview on ${BASE}`);

const rows = [];
const failures = [];
const page = await launch({ width: 1400, height: 985 });
try {
  for (const look of LOOKS) {
    if (ONLY_LOOK && look !== ONLY_LOOK) continue;
    for (const bm of BOOKMARKS) {
      if (ONLY_MAP && bm.map !== ONLY_MAP) continue;
      // `view=3d` and `look=` are always explicit: BOTH persist in localStorage, so a run that
      // relied on the remembered value would silently measure whatever the previous row left behind.
      const url = `${BASE}/?map=${bm.map}&view=3d&look=${look}${bm.hash ? `#${bm.hash}` : ''}`;
      const t0 = Date.now();
      try {
        await page.navigate(url);
        await page.waitFor('!!window.tz', { timeout: 40_000, label: 'window.tz' });
        await page.waitFor('!!document.querySelector("#map3d canvas")', { timeout: 60_000, label: 'the deck.gl canvas' });
        await page.waitFor('!!window.tz.renderStats()', { timeout: 60_000, label: 'renderStats' });
        await sleep(SETTLE);
        // deck refreshes its metric snapshot every 60 RENDERED frames and stops rendering entirely
        // when the scene is static, so a fresh, settled page reports zeros for draw count and frame
        // time. Drive a bounded run of real frames first, through the same clamped camera entry
        // point the app uses — a zoom nudge of 1e-4 is invisible and lands back on the bookmark
        // exactly, but it is a genuine view-state change, which a redraw flag is not.
        await page.evaluate(`(async () => {
          const api = document.querySelector('#map3d').__tz3d;
          const base = window.tz.camera.zoom;
          const raf = () => new Promise((r) => requestAnimationFrame(r));
          for (let i = 0; i < 90; i++) { api.setView({ zoom: base + (i % 2 ? 1e-4 : -1e-4) }); await raf(); }
          api.setView({ zoom: base });
          await raf();
        })()`, { awaitPromise: true });
        await sleep(900);
        const stats = await page.evaluate('window.tz.renderStats()');
        const camera = await page.evaluate('window.tz.camera');
        const landed = String(await page.evaluate('location.hash')).slice(1);
        const reported = await page.evaluate('window.tz.renderStyle()');
        if (reported !== look) throw new Error(`look did not apply: asked ${look}, page reports ${reported}`);
        // The camera clamp rewrites the hash only when it MOVES the permalink, so this is the app
        // telling us whether the bookmark still frames what its coordinates say.
        const asked = bm.hash ? bm.hash.split('/').map(Number) : null;
        const got = landed ? landed.split('/').map(Number) : null;
        const honoured = !asked || !!(got && got.length === 3 && Math.abs(got[0] - asked[0]) < 0.01
          && Math.abs(got[1] - asked[1]) < 0.1 && Math.abs(got[2] - asked[2]) < 0.1);
        if (!honoured) console.warn(`  ! ${bm.id}: asked #${bm.hash}, camera settled at #${landed}`);
        if (SHOTS) writeFileSync(join(SHOTS, `${bm.id}-${look}.png`), await page.screenshot());
        rows.push({ bookmark: bm.id, note: bm.note, hash: bm.hash, landed, honoured, look, camera, stats, ms: Date.now() - t0 });
        console.log(`✓ ${bm.id.padEnd(24)} ${look.padEnd(9)} layers ${String(stats.layers).padStart(3)} · draw ${String(stats.drawLayers ?? '—').padStart(3)} · models ${String(stats.models).padStart(4)} · gpu ${stats.gpuFrameMs ?? '—'} · cpu ${stats.cpuFrameMs == null ? '—' : stats.cpuFrameMs.toFixed(1)} ms`);
      } catch (e) {
        failures.push({ bookmark: bm.id, look, error: String(e.message ?? e) });
        console.error(`✗ ${bm.id} ${look}: ${e.message ?? e}`);
      }
    }
  }
} finally {
  await page.close().catch(() => {});
  stopServer();
}

const report = {
  note: 'RENDER-REALISM.md Stage 1 measured baseline. gpuFrameMs is null under SwiftShader — not measured, not free.',
  plan: 'docs/plans/RENDER-REALISM.md',
  renderer: 'deck.gl 9.3.11 / luma.gl 9.3.6',
  capture: { width: 1400, height: 985, devicePixelRatio: 1, adapter: 'chromium headless, ANGLE SwiftShader', settleMs: SETTLE },
  bookmarks: BOOKMARKS,
  rows,
  failures,
};
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n· ${rows.length} rows -> ${OUT}${failures.length ? ` (${failures.length} failed)` : ''}`);
process.exit(failures.length ? 1 : 0);
