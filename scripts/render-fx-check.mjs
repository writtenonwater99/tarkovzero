/**
 * render-fx-check — the vector-is-free gate.
 *
 * Founder, 2026-08-30: "items like fog take performance without adding fidelity." Vector is the
 * default look, so it must be the pre-R1 renderer: no fog extension, no post grade, no triplanar
 * ground detail, no water-mesh shader, no R1 texture cargo. Realistic keeps all of it, and each
 * piece is switchable with `?fx=` so its cost can be read off the real GPU on its own.
 *
 * This boots the BUILT app headless (like scripts/e2e-walkthrough.mjs) because layer counts,
 * effect counts and frame times only exist once deck has a device — no pure-node test can see them.
 * It is not part of `npm test` for that reason.
 *
 *   npm run build && npm run check:fx [-- --port 4351]
 *
 * gpuFrameMs is null under SwiftShader — not measured, not free. cpuFrameMs is real.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { launch } from './lib/cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argPort = process.argv.indexOf('--port');
const PORT = argPort > -1 ? Number(process.argv[argPort + 1]) : 4351;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const notes = [];
const assert = (ok, msg) => { if (!ok) failures.push(msg); };

const server = spawn('npx', ['vite', 'preview', '--configLoader', 'runner', '--port', String(PORT), '--strictPort'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'],
});
const bail = (code) => { try { server.kill('SIGTERM'); } catch {} process.exit(code); };
process.on('SIGINT', () => bail(130));

let up = false;
for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) { up = true; break; } } catch {} await sleep(250); }
if (!up) { console.error(`vite preview never came up on ${PORT} — did you run npm run build?`); bail(1); }

/** Boot one framing and read renderStats() plus the FX row's visibility. */
async function measure({ map = 'customs', look, fx = null }) {
  const page = await launch({ width: 1400, height: 985 });
  const url = `http://127.0.0.1:${PORT}/?map=${map}&view=3d&look=${look}${fx ? `&fx=${fx}` : ''}`;
  try {
    await page.navigate(url);
    await page.waitFor('!!window.tz', { timeout: 45_000, label: 'window.tz' });
    await page.waitFor('!!document.querySelector("#map3d canvas")', { timeout: 60_000, label: 'deck canvas' });
    await page.waitFor('!!window.tz.renderStats()', { timeout: 60_000, label: 'renderStats' });
    await sleep(5000);
    // deck idles once static; drive real frames so cpuTimePerFrame is a measurement, not a leftover.
    await page.evaluate(`(async () => { const api = document.querySelector('#map3d').__tz3d; if (!api) return;
      const b = window.tz.camera.zoom, raf = () => new Promise((r) => requestAnimationFrame(r));
      for (let i = 0; i < 150; i++) { api.setView({ zoom: b + (i % 2 ? 1e-4 : -1e-4) }); await raf(); }
      api.setView({ zoom: b }); await raf(); })()`, { awaitPromise: true }).catch(() => {});
    await sleep(2000);
    return await page.evaluate(`(() => { const s = window.tz.renderStats(); return {
      map: s.map, look: s.look, layers: s.layers, models: s.models, effects: s.effects, postEffects: s.postEffects,
      fog: s.fx.fogArmed, grade: s.fx.gradeArmed, detail: s.fx.detailArmed, waterMesh: s.fx.waterMesh,
      cpuFrameMs: s.cpuFrameMs == null ? null : +s.cpuFrameMs.toFixed(2), gpuFrameMs: s.gpuFrameMs,
      assetsReady: s.assets.ready, lumaTextureBytes: s.textureBytes.lumaResident,
      fxRowHidden: document.querySelector('#fx-row')?.hidden ?? null }; })()`);
  } finally { await page.close().catch(() => {}); }
}

const rows = [];
for (const c of [
  { map: 'customs', look: 'vector' }, { map: 'customs', look: 'realistic' },
  { map: 'woods', look: 'vector' }, { map: 'woods', look: 'realistic' },
]) {
  const s = await measure(c);
  rows.push({ ...s, fxParam: 'all' });
  console.log(`· ${c.map}/${c.look}: ${s.layers} layers, ${s.effects} effects (${s.postEffects} post), cpu ${s.cpuFrameMs} ms`);
}

const vector = rows.filter((r) => r.look === 'vector');
const realistic = rows.filter((r) => r.look === 'realistic');

for (const v of vector) {
  assert(v.fog === false, `${v.map}: vector armed the fog extension`);
  assert(v.grade === false, `${v.map}: vector armed the post grade`);
  assert(v.detail === false, `${v.map}: vector armed the ground-detail extension`);
  assert(v.waterMesh === false, `${v.map}: vector armed the water-mesh shader`);
  assert(v.postEffects === 0, `${v.map}: vector holds ${v.postEffects} post effects, expected 0`);
  assert(v.effects === 1, `${v.map}: vector holds ${v.effects} effects, expected 1 (the scene light only)`);
  assert(v.assetsReady === false, `${v.map}: vector loaded the realistic-only R1 asset set`);
  assert(v.fxRowHidden === true, `${v.map}: the Effects row is showing under Vector, which has none`);
}
for (const r of realistic) {
  assert(r.fog && r.grade && r.detail, `${r.map}: realistic is missing an effect (fog ${r.fog}, grade ${r.grade}, detail ${r.detail})`);
  assert(r.fxRowHidden === false, `${r.map}: the Effects row is hidden under Real`);
}

/*
 * Look-flip invariance. The geometry is one buffer set behind both skins, so the LAYER COUNT is the
 * same on either side of the flip — what changes is the material each layer carries. (Before the
 * plinth split this was also the pre-R1 number; the `building-plinths` layer is a deliberate
 * addition, so the invariant is "identical across the flip", not "equal to a frozen constant".)
 */
for (const v of vector) {
  const r = realistic.find((x) => x.map === v.map);
  assert(r && v.layers === r.layers, `${v.map}: layer count differs across the flip (vector ${v.layers}, realistic ${r?.layers})`);
  assert(r && v.models === r.models, `${v.map}: model count differs across the flip (vector ${v.models}, realistic ${r?.models})`);
  if (r && v.cpuFrameMs != null && r.cpuFrameMs != null) {
    assert(v.cpuFrameMs <= r.cpuFrameMs, `${v.map}: vector cpu ${v.cpuFrameMs} ms is above realistic ${r.cpuFrameMs} ms`);
    notes.push(`${v.map}: vector ${v.cpuFrameMs} ms vs realistic ${r.cpuFrameMs} ms cpu/frame`);
  }
  if (r) notes.push(`${v.map}: vector ${(v.lumaTextureBytes / 1e6).toFixed(1)} MB resident texture vs realistic ${(r.lumaTextureBytes / 1e6).toFixed(1)} MB`);
}

/* Each realistic effect on its own, so the founder can price them individually. */
for (const fx of ['none', 'fog', 'grade', 'detail']) {
  const s = await measure({ map: 'customs', look: 'realistic', fx });
  rows.push({ ...s, fxParam: fx });
  console.log(`· customs/realistic ?fx=${fx}: fog ${s.fog}, grade ${s.grade}, detail ${s.detail}, cpu ${s.cpuFrameMs} ms`);
  assert(s.fog === (fx === 'fog'), `?fx=${fx}: fog armed ${s.fog}`);
  assert(s.grade === (fx === 'grade'), `?fx=${fx}: grade armed ${s.grade}`);
  assert(s.detail === (fx === 'detail'), `?fx=${fx}: detail armed ${s.detail}`);
}

console.table(rows.map((r) => ({ map: r.map, look: r.look, fx: r.fxParam, layers: r.layers, effects: r.effects,
  post: r.postEffects, fog: r.fog, grade: r.grade, detail: r.detail, cpuMs: r.cpuFrameMs, texMB: +(r.lumaTextureBytes / 1e6).toFixed(1) })));
for (const n of notes) console.log(`  ${n}`);

if (failures.length) { console.error(`\n✗ render FX check: ${failures.length} failure(s)`); for (const f of failures) console.error(`  - ${f}`); bail(1); }
console.log(`\n✓ render FX check: vector runs no R1 shader, realistic carries all three, and the flip is geometry-invariant`);
bail(0);
