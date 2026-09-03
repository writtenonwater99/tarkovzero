#!/usr/bin/env node
/**
 * TarkovZero — automated founder walkthrough (UI-REWORK red team #2).
 *
 * Codex's finding #2 asked for a 5-user click-prototype falsification test. That was declined —
 * there are no test users — and the falsifier put in its place was a founder walkthrough of one
 * chain: *find an extract → select a quest → adjust a layer → inspect a photo card → step 6*.
 * A falsifier nobody runs is not a falsifier, so this script runs that chain on every build against
 * the real UI: a production `dist`, served by `vite preview`, driven in headless Chromium over CDP.
 *
 * It is deliberately NOT a unit test. Every assertion reads the live DOM or the live `window.tz`
 * state after a real key or mouse event; nothing is stubbed and no module is imported. If a step
 * cannot be asserted the run fails loudly with that step's name.
 *
 *   npm run e2e                      # build, serve, drive, screenshot
 *   npm run e2e -- --skip-build      # reuse the dist that is already there
 *   npm run e2e -- --port 4211       # anything ≥ 4210; the founder's preview owns 4190
 *   npm run e2e -- --out <dir>       # where the per-step PNGs land
 *
 * Screenshots: one per step, numbered, into --out (default $TZ_E2E_OUT or ./.e2e).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { launch } from './lib/cdp.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------------------------------------------------- args -- */
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };

const FIRST_PORT = Number(opt('port', process.env.TZ_E2E_PORT ?? 4210));
const OUT = resolve(opt('out', process.env.TZ_E2E_OUT ?? join(ROOT, '.e2e')));
const SKIP_BUILD = flag('skip-build');
// Step 14 builds and serves a SECOND, dev-mode bundle, because dev + loopback is the only place the
// build notices are drawn and a test that only ever checks they are absent cannot tell "hidden in
// release" from "deleted". It costs ~16 s of extra build; skippable for a fast loop, never by
// default — the arm exists precisely because the cheap half of the check passes without it.
const SKIP_DEV_ARM = flag('skip-dev-arm');

// The founder's own preview lives on 4190 and other lanes hold 4181–4187; this harness owns
// 4210–4399, takes the first free port in that band, and kills only the PID it started. The band
// runs past 4299 because parallel QA lanes are handed 43xx ports of their own.
const PORT_LO = 4210, PORT_HI = 4399;
if (FIRST_PORT < PORT_LO || FIRST_PORT > PORT_HI) {
  console.error(`✗ refusing port ${FIRST_PORT}: this harness owns ${PORT_LO}–${PORT_HI} (4190 and 4181–4187 belong to other sessions)`);
  process.exit(2);
}
const free = (port) => new Promise((res) => {
  const s = createServer();
  s.once('error', () => res(false));
  s.once('listening', () => s.close(() => res(true)));
  s.listen(port, '127.0.0.1');
});
async function pickPort() {
  for (let p = FIRST_PORT; p <= PORT_HI; p++) if (await free(p)) return p;
  throw new Error(`no free port in ${FIRST_PORT}–${PORT_HI}`);
}

let PORT = FIRST_PORT;
let HEADFUL_URL = `http://127.0.0.1:${PORT}`;
// A fresh Chromium profile means empty localStorage, which is the point: the walkthrough has to
// see the *default* first-visit state (3D, oblique, default filter set), not a remembered one.
//
// `renderer=deck` is explicit since 2026-09-02, when Customs' DEFAULT renderer became Three. Steps
// 1–10 are the deck.gl chain — the look/relief/effects controls, the R1 asset set, deck's label
// seating pass — none of which the Three path has, so pointing them at the new default would not
// have tested the flip, it would have deleted ten steps of coverage. `?renderer=deck` is a shipped
// product path (it is the escape hatch back to the renderer production ran on for months) and this
// is what keeps it walked on every build. Step 11 loads the bare default URL and asserts THAT.
let DECK_URL = `${HEADFUL_URL}/?map=customs&renderer=deck`;
let URL = DECK_URL;
/** The URL a visitor actually types. No `renderer` param at all — this is the flip under test. */
let DEFAULT_URL = `${HEADFUL_URL}/?map=customs`;

/* --------------------------------------------------------------------- report -- */
const steps = [];
const notes = [];
const pageLog = [];
let shotN = 0;
/** renderStats().timing from step 1 — the cold-load milestones QA D1 is measured with. */
let coldPaint = null;

const fmt = (ms) => `${(ms / 1000).toFixed(2)}s`;

class StepError extends Error {
  constructor(step, message) { super(message); this.step = step; }
}
function assert(cond, message) { if (!cond) throw new Error(message); }
const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= tol;
const inside = (p, r, tol = 0.5) => p && p[0] >= r.left - tol && p[0] <= r.right + tol && p[1] >= r.top - tol && p[1] <= r.bottom + tol;

/* --------------------------------------------------------------- preview server -- */
function build() {
  console.log('· building dist …');
  const r = spawnSync(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--configLoader', 'runner'], {
    cwd: ROOT, stdio: 'inherit',
  });
  if (r.status !== 0) { console.error('✗ build failed'); process.exit(1); }
}

async function serve() {
  const child = spawn(process.execPath, [
    join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview',
    '--configLoader', 'runner', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1',
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });

  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`vite preview exited (${child.exitCode}):\n${out}`);
    try {
      const res = await fetch(`${HEADFUL_URL}/`, { redirect: 'manual' });
      if (res.ok) return child;
    } catch {}
    await sleep(250);
  }
  child.kill('SIGKILL');
  throw new Error(`vite preview never answered on ${PORT}:\n${out}`);
}

/**
 * A DEV-MODE bundle on a loopback port this harness owns, for step 14 only.
 *
 * Step 12 asserts the build notices are gone from a release build. On its own that assertion cannot
 * tell "hidden in release" from "deleted everywhere", so this arm loads a page where they must be
 * ON and checks that they are — and that they say exactly what `renderStats().truth` says.
 *
 * WHY A SECOND BUILD RATHER THAN `vite dev`. The gate is `import.meta.env.DEV === true` plus a
 * loopback host, and `NODE_ENV=development vite build --mode development` compiles `DEV` to `true`
 * (verified: the emitted `dev:!0` against the release bundle's `dev:!1`) while still producing a
 * BUNDLE. A real `vite dev` server was tried first and is not usable here: the unbundled module
 * graph plus the local game-derived packs pegged headless Chromium's main thread for >10 minutes on
 * /mnt/c, which blocks CDP evaluation and hangs the step rather than failing it. This costs ~16 s of
 * build and loads like any other preview page.
 *
 * The founder's own dev server on 5173 is never touched — this builds into `.e2e/` (git- and
 * vercel-ignored), takes its own port from the harness band, and the caller kills only this PID.
 *
 * Note that on this page `canLoadLocalGameDerivedAssets()` is also true, so the renderer asks for
 * the local terrain and vegetation packages and does not get them from a preview server. That is
 * fine and is not what is under test: the assertion is that the strip on screen and the strip in
 * `renderStats()` are the same object, whatever they say.
 */
const DEV_DIST = join(ROOT, '.e2e/dev-dist');
async function serveDev() {
  console.log('· building a dev-mode bundle for the notice arm …');
  const b = spawnSync(process.execPath, [
    join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--configLoader', 'runner',
    '--mode', 'development', '--outDir', DEV_DIST, '--emptyOutDir',
  ], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'development' } });
  if (b.status !== 0) throw new Error('the dev-mode build failed');

  const port = await pickPort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [
    join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--configLoader', 'runner',
    '--outDir', DEV_DIST, '--port', String(port), '--strictPort', '--host', '127.0.0.1',
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (b2) => { out += b2; });
  child.stderr.on('data', (b2) => { out += b2; });
  for (let i = 0; i < 240; i++) {   // 240 × 250 ms = 60 s
    if (child.exitCode !== null) throw new Error(`the dev-mode preview exited (${child.exitCode}):\n${out}`);
    try {
      const res = await fetch(`${url}/`, { redirect: 'manual' });
      if (res.ok) { console.log(`· dev-mode bundle on ${url} (pid ${child.pid})`); return { child, url, port }; }
    } catch {}
    await sleep(250);
  }
  child.kill('SIGKILL');
  throw new Error(`the dev-mode preview never answered on ${port}:\n${out}`);
}

/* ------------------------------------------------------------------ page helpers -- */
/** Read one frame's centre-crop luminance by decoding the PNG *in the page* — no image deps. */
async function frameStats(page, png) {
  const b64 = png.toString('base64');
  const expr = `(async () => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + ${JSON.stringify(b64)};
    await img.decode();
    const W = 240, H = 160;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, img.width * 0.3, img.height * 0.3, img.width * 0.4, img.height * 0.4, 0, 0, W, H);
    const d = x.getImageData(0, 0, W, H).data;
    let sum = 0, max = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      sum += l; if (l > max) max = l;
    }
    return { mean: sum / (d.length / 4), max };
  })()`;
  return page.evaluate(expr, { awaitPromise: true });
}

async function shoot(page, slug) {
  shotN += 1;
  const file = join(OUT, `${String(shotN).padStart(2, '0')}-${slug}.png`);
  writeFileSync(file, await page.screenshot());
  return file;
}

/**
 * Focus the omnibox, type a query, and (optionally) commit it with Enter.
 *
 * The omnibox is the first element INSIDE the Ask panel since 2026-09-02 ("lets remove the bar
 * from the bottom" / "omni bar should be first"), so it has to be revealed before it can be typed
 * into — a focus call at a field in a hidden or collapsed panel silently sends every keystroke to
 * the document's own single-letter shortcuts instead.
 */
async function omni(page, text, { commit = true, settle = 260 } = {}) {
  const focused = await page.evaluate(`(() => {
    window.tz.panel.reveal('ask');
    const f = document.getElementById('find');
    f.value = ''; f.dispatchEvent(new Event('input')); f.focus();
    return document.activeElement === f;
  })()`);
  assert(focused, 'the omnibox would not take focus — the Ask panel is not open');
  await page.type(text);
  await sleep(settle);
  if (commit) { await page.key('Enter'); await sleep(settle); }
}

/** A real press-move-release with the mouse. Chromium turns these into the pointer events shell.js listens for. */
async function drag(page, from, to, { steps = 8, delay = 26 } = {}) {
  const at = (x, y, buttons) => ({ x: Math.round(x), y: Math.round(y), button: 'left', buttons, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at(from.x, from.y, 0) });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at(from.x, from.y, 1) });
  await sleep(delay);
  for (let i = 1; i <= steps; i++) {
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      ...at(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, 1),
    });
    await sleep(delay);
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at(to.x, to.y, 1) });
  await sleep(180);
}

/** The Ask panel's box + the two rects, in stage coordinates. */
const geometry = (page) => page.evaluate(`(() => {
  const s = document.getElementById('stage').getBoundingClientRect();
  const p = document.getElementById('panel-ask').getBoundingClientRect();
  return {
    stage: { w: s.width, h: s.height },
    panel: { left: p.left - s.left, right: p.right - s.left, top: p.top - s.top, bottom: p.bottom - s.top, w: p.width, h: p.height },
    avoid: window.tz.avoidRect(), fit: window.tz.safeRect(), box: window.tz.panel.box(),
  };
})()`);
/** True when the panel's own box is inside the rect the reader is promised. */
const rectCovers = (rect, p) =>
  !(p.right <= rect.left || p.left >= rect.right || p.bottom <= rect.top || p.top >= rect.bottom);

/** Take the keyboard out of any text field — the document-level shortcuts ignore keys while typing. */
const blur = (page) => page.evaluate(`(() => { document.activeElement?.blur?.(); return document.activeElement?.tagName ?? null; })()`);

/** Click the centre of an element chosen in the page, with a real mouse event. */
async function clickEl(page, selectorExpr) {
  const box = await page.evaluate(`(() => {
    const el = ${selectorExpr};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  })()`);
  assert(box && box.w > 0 && box.h > 0, `nothing clickable for ${selectorExpr}`);
  await page.click(box.x, box.y);
  return box;
}

/* ----------------------------------------------------------------------- runner -- */
async function step(page, name, slug, fn) {
  const t0 = Date.now();
  process.stdout.write(`· ${name} … `);
  try {
    const detail = await fn();
    const ms = Date.now() - t0;
    const shot = await shoot(page, slug);
    steps.push({ name, status: 'PASS', ms, shot, detail: detail ?? null });
    console.log(`PASS ${fmt(ms)}`);
    return detail;
  } catch (e) {
    const ms = Date.now() - t0;
    let shot = null;
    try { shot = await shoot(page, `FAIL-${slug}`); } catch {}
    steps.push({ name, status: 'FAIL', ms, shot, error: e.message });
    console.log(`FAIL ${fmt(ms)}`);
    throw new StepError(name, e.message);
  }
}

/* ======================================================================== main == */
async function main() {
  mkdirSync(OUT, { recursive: true });
  if (!SKIP_BUILD) build();
  assert(existsSync(join(ROOT, 'dist/index.html')), 'dist/index.html missing — run without --skip-build');

  PORT = await pickPort();
  HEADFUL_URL = `http://127.0.0.1:${PORT}`;
  DECK_URL = `${HEADFUL_URL}/?map=customs&renderer=deck`;
  DEFAULT_URL = `${HEADFUL_URL}/?map=customs`;
  URL = DECK_URL;
  const server = await serve();
  console.log(`· serving dist on ${HEADFUL_URL} (pid ${server.pid})`);

  const page = await launch({
    width: 1400, height: 985,
    onConsole: (e) => { if (e.type === 'error' || e.type === 'exception') pageLog.push(`[${e.type}] ${e.text}`); },
  });

  const t0 = Date.now();
  try {
    /* -- 1 ------------------------------------ deck.gl (?renderer=deck): view is the diorama -- */
    await step(page, "1. load ?renderer=deck → 3D diorama, oblique camera, render assets armed", 'load-3d', async () => {
      await page.navigate(URL);
      await page.waitFor('!!window.tz', { timeout: 30_000, label: 'window.tz' });
      await page.waitFor('window.tz.markers().total > 0', { timeout: 30_000, label: 'marker data' });
      await page.waitFor('!!document.querySelector("#map3d canvas")', { timeout: 40_000, label: 'the deck.gl canvas' });
      await sleep(4500);   // terrain mesh + icon atlas + first lit frame

      // A black first frame is a known swiftshader flake, not a defect — retry the load once.
      let stats = await frameStats(page, await page.screenshot());
      let retried = false;
      if (stats.mean < 4 && stats.max < 12) {
        retried = true;
        notes.push(`step 1: first 3D frame was black (mean ${stats.mean.toFixed(1)}) — reloaded once`);
        await page.navigate(URL);
        await page.waitFor('!!window.tz && !!document.querySelector("#map3d canvas")', { timeout: 40_000, label: 'reloaded canvas' });
        await sleep(6000);
        stats = await frameStats(page, await page.screenshot());
      }
      assert(!(stats.mean < 4 && stats.max < 12), `3D frame is black after a retry (mean ${stats.mean.toFixed(2)}, max ${stats.max.toFixed(2)})`);

      const view = await page.evaluate('window.tz.view');
      assert(view === '3d', `default view is "${view}", expected "3d"`);
      const cam = await page.evaluate('window.tz.camera');
      assert(cam.mode === '3d', `camera reports mode "${cam.mode}"`);
      assert(near(cam.rotationX, 32, 0.5), `camera rotationX is ${cam.rotationX}, expected ≈ 32`);
      const cell = await page.evaluate('document.querySelector("#view-toggle .seg-cell.on")?.dataset.view');
      assert(cell === '3d', `the 2D/3D control shows "${cell}" as active`);

      // The Stage 1 render assets are the branch's headline deliverable and nothing could see them:
      // armRenderAssets() catches every failure by design, and a `dist` with public/assets/3d
      // deleted walked this whole chain green with `ready:false`, no ground detail and no grade.
      // The frame stays up either way — this is the check that says whether the look shipped.
      //
      // Vector has been the default look since 2026-08-30, and vector deliberately loads NONE of
      // that asset set — it has no shader for it (map3d's `armAssetsOnce`). So the default is
      // asserted as vector, the look is flipped to Real (the flip is what fetches the assets), the
      // realistic look is gated on the far side of the flip, and the default is put back so the
      // persisted choice this step leaves behind is the one the app ships with.
      const defaultLook = await page.evaluate('window.tz.renderStyle()');
      assert(defaultLook === 'vector', `the default look is "${defaultLook}", expected "vector"`);
      const vectorStats = await page.evaluate('window.tz.renderStats()');
      assert(vectorStats.postEffects === 0 && vectorStats.fx.fogArmed === false,
        `vector is running R1 shaders: ${JSON.stringify(vectorStats.fx)}`);
      // QA H1: the landing frame's names must go through the screen-space seating pass. A pass
      // that bails hands every name back unseated and the frame prints them through each other —
      // which is exactly what shipped, because deck has no viewport when the first layer set is
      // built and a still map never rebuilt it.
      assert(vectorStats.labels?.bail === null && vectorStats.labels.seated > 0,
        `the label seating pass did not run on the landing frame: ${JSON.stringify(vectorStats.labels)}`);
      await page.evaluate(`window.tz.renderStyle('realistic')`);
      await page.waitFor('window.tz.renderStats()?.assets?.ready === true', { timeout: 25_000, label: 'the Stage 1 render assets' });
      const rs = await page.evaluate('window.tz.renderStats()');
      assert(rs.look === 'realistic', `the look did not flip to realistic (got "${rs.look}")`);
      assert(rs.groundDetail === true, 'the realistic terrain is drawing without its ground-detail material');
      assert(rs.post.enabled && rs.post.armed, `the grade pass is not armed (${JSON.stringify(rs.post)})`);
      assert(rs.post.fxaa === false, 'FXAA is back on in a full-screen pass — it eats every label');
      assert(rs.textureBytes.groundDetail > 0 && rs.textureBytes.gradeLut > 0,
        `no asset bytes uploaded: ${JSON.stringify(rs.textureBytes)}`);

      // QA D1: the cold load used to show place names with no marker badge under them for a long
      // window, which reads as broken rather than as loading.
      //
      // What is gated here is the ATLAS, because the atlas is what D1's fix moved. It is NOT
      // `badgeLagMs` (badges vs labels), which this gate used to assert at <= 250 ms: the labels
      // come from data already in the bundle and the badges wait on `/data/<map>.json` over the
      // network, so that number is a stopwatch on a fetch nothing in the branch touches — it failed
      // 1 run in 4 on an unmodified tree (5919 ms once, with the atlas ready at 596 ms), and a CDP
      // hold on the marker JSON alone reproduces the failure with the atlas untouched. It is still
      // reported below, as a measurement rather than a gate.
      //
      // `markerIconMisses` is the assertion the old gate could not make. Every extract badge on
      // Customs carries a letter, so its icon key is per-marker (`extract-scav:D`), and if the atlas
      // was cut before the marker fetch landed those keys are absent from `iconMapping` and the
      // IconLayer silently draws nothing for them — while `firstBadgeMs` still fires and reports
      // "lag 0 ms" on a frame with no badge pixel on it.
      coldPaint = rs.timing ?? null;
      assert(coldPaint && Number.isFinite(coldPaint.firstBadgeMs),
        `no cold-paint timing in renderStats(): ${JSON.stringify(coldPaint)}`);
      assert(rs.markerIconMisses === 0,
        `${rs.markerIconMisses} marker icon key(s) are missing from the atlas — those badges draw nothing (D1/atlas regression)`);
      assert(coldPaint.badgeAfterDataMs != null && coldPaint.badgeAfterDataMs <= 1500,
        `marker badges paint ${coldPaint.badgeAfterDataMs} ms after the marker data arrived (timing ${JSON.stringify(coldPaint)})`);
      notes.push(`cold paint: labels ${coldPaint.firstLabelMs} ms, marker data ${coldPaint.markersReadyMs} ms, `
        + `badges ${coldPaint.firstBadgeMs} ms (${coldPaint.badgeAfterDataMs} ms after the data, ${coldPaint.badgeLagMs} ms after the labels), `
        + `icon atlas ready ${coldPaint.atlasReadyMs} ms (${coldPaint.atlasWaitMs} ms of it after the terrain prep), `
        + `misses ${rs.markerIconMisses}, prep ${JSON.stringify(coldPaint.prepMs)}`);
      notes.push(`vector ${vectorStats.cpuFrameMs?.toFixed?.(2) ?? '?'} ms vs realistic ${rs.cpuFrameMs?.toFixed?.(2) ?? '?'} ms cpu/frame`);
      // Put the shipping default back: renderStyle() persists, and every step after this one shares
      // the profile.
      await page.evaluate(`window.tz.renderStyle('vector')`);
      await sleep(400);

      // The zoom FLOOR, driven through the app's own control rather than through camera.js.
      // camera.js's minFitZoom() shipped once with no call site: the unit tests were green and
      // '-' still walked the camera down to viewState.minZoom (-2), where the map is a slab in
      // the void with the terrain underside showing. Ten '-' presses is 5 zoom levels, far more
      // than any window can absorb, so an unclamped camera lands on -2 and a clamped one stops
      // at contain - MIN_ZOOM_MARGIN, which is above 0 on every shipped map at this window.
      for (let i = 0; i < 10; i++) { await page.key('-'); }
      await sleep(900);
      const floored = await page.evaluate('window.tz.camera.zoom');
      assert(floored > -1.5, `zooming out ran past the fit floor to ${floored} (the -2 hard stop, i.e. no floor)`);
      await page.key('f');   // back to the default framing for every step after this one
      await sleep(1200);
      const refit = await page.evaluate('window.tz.camera.zoom');
      assert(refit >= floored, `the fit key did not restore the framing (${floored} → ${refit})`);

      return { view, rotationX: cam.rotationX, rotationOrbit: cam.rotationOrbit, frameMean: Number(stats.mean.toFixed(1)), blackFrameRetry: retried,
        zoomFloor: Number(floored.toFixed(3)), zoomRefit: Number(refit.toFixed(3)),
        assets: { ready: rs.assets.ready, sourceBytes: rs.assets.sourceBytes, groundDetail: rs.textureBytes.groundDetail, gradeLut: rs.textureBytes.gradeLut } };
    });

    /* -- 2 ---------------------------------------------- omnibox lookup flies the camera -- */
    await step(page, "2. omnibox 'dorms' → results → Enter flies the map into the safe rect", 'omnibox-dorms', async () => {
      const before = await page.evaluate('window.tz.camera.target');
      await omni(page, 'dorms', { commit: false });
      await page.waitFor('!document.getElementById("find-results").hidden && document.querySelectorAll("#find-results .res").length > 0',
        { timeout: 6000, label: 'omnibox results for "dorms"' });
      const rows = await page.evaluate(`[...document.querySelectorAll('#find-results .res')].map((r) => ({ act: r.classList.contains('act'), kind: r.className, label: r.querySelector('.rn')?.textContent ?? '' }))`);
      const act = rows.find((r) => r.act);
      assert(act, `no row is highlighted; rows: ${rows.map((r) => r.label).join(' | ')}`);
      assert(/dorms/i.test(act.label), `the highlighted row is "${act.label}", expected a Dorms hit`);

      await page.key('Enter');
      await sleep(1400);

      const after = await page.evaluate('window.tz.camera.target');
      const moved = Math.hypot(after[0] - before[0], after[1] - before[1]);
      assert(moved > 1, `the camera did not move (target ${JSON.stringify(before)} → ${JSON.stringify(after)})`);

      // The flown-to point, projected back to the screen, has to land where nothing floats over it.
      const x = -after[0], z = -after[1];
      const proj = await page.evaluate(`window.tz.project(${x}, ${z})`);
      // The AVOID rect, not the fit rect: a fly-to owes the reader a point the dock is not over.
      // safeRect() is deliberately the full stage width now (QA H4) and would be a weaker test.
      const safe = await page.evaluate('window.tz.avoidRect()');
      const stage = await page.evaluate(`(() => { const r = document.getElementById('stage').getBoundingClientRect(); return { w: r.width, h: r.height }; })()`);
      assert(proj && Number.isFinite(proj[0]), 'the 3D view could not project the flown-to point');
      // Guard against a vacuous test: the avoid rect must actually be inset from the stage.
      assert(safe.right < stage.w - 1 || safe.bottom < stage.h - 1 || safe.top > 1,
        `avoidRect ${JSON.stringify(safe)} is the whole stage — containment would be vacuous`);
      assert(inside(proj, safe), `projected target [${proj.map((n) => n.toFixed(0))}] is outside the avoid rect ${JSON.stringify(safe)}`);
      return { picked: act.label, rows: rows.length, moved: Number(moved.toFixed(1)), projected: proj.map((n) => Math.round(n)), avoidRect: safe };
    });

    /* -- 3 ------------------------------------- '> quests' + panel search → auto-pinned -- */
    await step(page, "3. '> quests' opens the panel; 'Hot Wheels' selected in it auto-pins + draws objectives", 'quests-hot-wheels', async () => {
      await omni(page, '> quests');
      await page.waitFor('window.tz.panel.isOpen("quests")', { timeout: 6000, label: 'the Quests panel' });
      assert(await page.evaluate('!document.getElementById("panel-quests").hidden'), '#panel-quests is still hidden');

      // The panel's own scoped search — the omnibox result list is a supplement, not a replacement
      // (red team #4), so the founder chain exercises the in-panel field.
      await page.waitFor('!!document.getElementById("quest-find")', { timeout: 6000, label: '#quest-find' });
      await page.evaluate(`document.getElementById('quest-find').focus()`);
      await page.type('Hot Wheels');
      await page.waitFor('document.querySelectorAll("#quest-results .qres").length > 0', { timeout: 15_000, label: 'quest search results (quests.json is ~750 KB)' });
      const found = await page.evaluate(`[...document.querySelectorAll('#quest-results .qres')].map((r) => r.querySelector('.rn')?.textContent ?? '')`);
      const i = found.findIndex((n) => n.trim().toLowerCase() === 'hot wheels');
      assert(i >= 0, `"Hot Wheels" is not in the results: ${found.join(' | ')}`);
      await clickEl(page, `document.querySelectorAll('#quest-results .qres')[${i}]`);
      await sleep(900);

      const selected = await page.evaluate('window.tz.quests.selected()');
      assert(selected.includes('hot-wheels'), `selected quests are ${JSON.stringify(selected)}, expected to include "hot-wheels"`);
      const pinned = await page.evaluate('window.tz.panel.isPinned("quests")');
      assert(pinned === true, 'the Quests panel did not auto-pin when a quest was selected');
      assert(await page.evaluate('document.getElementById("panel-quests").classList.contains("is-pinned")'), '#panel-quests is missing the .is-pinned class');
      const pts = await page.evaluate('window.tz.quests.points()');
      assert(pts.length > 0, 'the objectives layer is empty after selecting the quest');
      return { selected, pinned, objectivePoints: pts.length, badges: pts.map((p) => p.badge) };
    });

    /* -- 4 --------------------------------------------- '> layers scav' moves the filter -- */
    await step(page, "4. '> layers scav' turns the scav rows on — checkbox and marker count follow", 'layers-scav', async () => {
      const read = () => page.evaluate(`(() => ({
        scavExtract: document.querySelector('#layers input[data-kind="extract-scav"]')?.checked ?? null,
        scavSpawn: document.querySelector('#layers input[data-kind="spawn-scav"]')?.checked ?? null,
        markers: window.tz.markers(),
      }))()`);
      let before = await read();
      assert(before.scavExtract !== null, 'the scav-extract filter row is not in #layers');
      if (before.scavExtract) {          // setup only, not the assertion
        await omni(page, '> hide scav');
        await sleep(500);
        before = await read();
        notes.push('step 4: scav layers were already on — turned off first so the command has something to change');
      }
      assert(before.scavExtract === false, 'could not get the scav-extract row into the off state');

      await omni(page, '> layers scav');
      await sleep(700);
      const after = await read();
      assert(after.scavExtract === true, 'the scav-extract checkbox is still unchecked after "> layers scav"');
      assert(after.markers.total > before.markers.total,
        `marker count did not grow (${before.markers.total} → ${after.markers.total})`);
      assert(await page.evaluate(`document.querySelector('#layers .row[data-kind="extract-scav"]').classList.contains('on')`),
        'the scav-extract row is checked but not painted on');
      return {
        checkbox: { before: before.scavExtract, after: after.scavExtract },
        spawnScav: { before: before.scavSpawn, after: after.scavSpawn },
        markerTotal: { before: before.markers.total, after: after.markers.total, delta: after.markers.total - before.markers.total },
      };
    });

    /* -- 5 -------------------------------------------- clicking a quest pin opens the card -- */
    await step(page, "5. click a quest pin → the photo card opens inside the safe rect", 'quest-card', async () => {
      const pts = await page.evaluate('window.tz.quests.points()');
      assert(pts.length, 'no quest points to click');
      const p = pts[0];
      // Bring the pin on screen first (tz.flyTo moves the camera and nothing else — flyToObjective
      // would open the card by itself, which would test nothing).
      await page.evaluate(`window.tz.flyTo(${p.pin.x}, ${p.pin.z})`);
      await sleep(1500);
      await page.evaluate('window.tz.quests.open(true)');
      await sleep(200);

      // The pin's icon is anchored at its bottom edge (30 px tall), so the glyph sits *above* the
      // projected point; aim up the badge, then walk a couple of fallbacks before giving up.
      const proj = await page.evaluate(`window.tz.project(${p.pin.x}, ${p.pin.z})`);
      assert(proj && Number.isFinite(proj[0]), 'the 3D view could not project the quest pin');
      let opened = false, hitAt = null;
      for (const dy of [-15, -8, -22, 0, -28]) {
        await page.click(proj[0], proj[1] + dy);
        await sleep(650);
        if (await page.evaluate('!document.getElementById("quest-card").hidden')) { opened = true; hitAt = [Math.round(proj[0]), Math.round(proj[1] + dy)]; break; }
      }
      assert(opened, `clicking the pin at [${proj.map((n) => Math.round(n))}] (±28 px vertically) never opened #quest-card — deck.gl picking did not hit the marker`);

      const card = await page.evaluate(`(() => {
        const c = document.getElementById('quest-card');
        const s = document.getElementById('stage').getBoundingClientRect();
        const r = c.getBoundingClientRect();
        return { left: r.left - s.left, top: r.top - s.top, right: r.right - s.left, bottom: r.bottom - s.top,
                 text: (c.querySelector('.qcard-t, b')?.textContent ?? '').trim(), imgs: c.querySelectorAll('img').length };
      })()`);
      const safe = await page.evaluate('window.tz.avoidRect()');
      assert(card.right - card.left > 40 && card.bottom - card.top > 40, `the card has no size: ${JSON.stringify(card)}`);
      for (const [corner, pt] of [['top-left', [card.left, card.top]], ['bottom-right', [card.right, card.bottom]]]) {
        assert(inside(pt, safe, 1), `the card's ${corner} corner [${pt.map((n) => Math.round(n))}] is outside the avoid rect ${JSON.stringify(safe)}`);
      }
      return { clickedAt: hitAt, badge: p.badge, card, avoidRect: safe };
    });

    /* -- 6 ------------------------------------------------- the floor selector is retired -- */
    // This step used to press ']' and watch the #floors active cell move. The whole selector went
    // out on 2026-09-02 (founder: "floor system fully out the project"), so the step now asserts it
    // is GONE from the running page — markup, keyboard, omnibox command and renderer API. A step
    // that was simply deleted would have left the walkthrough green if any of those came back.
    await step(page, '6. the floor selector is gone from the live page', 'floor-retired', async () => {
      await blur(page);
      const dom = await page.evaluate(`({
        rail: document.querySelectorAll('#floors, .tb-floors, [data-floor]').length,
        api: typeof window.tz.setFloor,
        shortcut: (document.getElementById('hint3d')?.textContent ?? '').includes('Step floors'),
      })`);
      assert(dom.rail === 0, `the floor rail is still in the DOM (${dom.rail} nodes)`);
      assert(dom.api === 'undefined', `window.tz.setFloor is still ${dom.api}`);
      assert(!dom.shortcut, 'the help sheet still advertises the floor shortcut');
      // ']' must be inert, not merely unbound to a rail that no longer exists: the camera may not
      // move and nothing may toast about a floor.
      const camBefore = await page.evaluate('window.tz.camera');
      await page.key(']');
      await sleep(400);
      const camAfter = await page.evaluate('window.tz.camera');
      assert(near(camAfter.zoom, camBefore.zoom, 1e-6), `']' moved the camera: ${camBefore.zoom} → ${camAfter.zoom}`);
      const toast = await page.evaluate(`(document.getElementById('toast')?.textContent ?? '').trim()`);
      assert(!/floor/i.test(toast), `']' still says something about floors: "${toast}"`);
      // …and the storey articulation the selector was NOT is still on screen.
      const bands = await page.evaluate('window.tz.renderStats()?.buildings?.detailTriangles ?? null');
      assert(bands === null || bands > 0, `the building detail lane stopped drawing (${bands})`);
      return { rail: dom.rail, keyInert: true, detailTriangles: bands };
    });

    /* -- 7 --------------------------------------------- Esc peels transient, keeps pinned -- */
    await step(page, '7. Esc chain — card, then the transient panel; the pinned workspace stays', 'esc-chain', async () => {
      // QA H4: a panel FLOATS over the map. Opening one may not move the camera and may not take a
      // column out of the box the fit frames into — the fit rect is the stage's full width, always.
      const camBefore = await page.evaluate('window.tz.camera');
      await omni(page, '> live');                       // a transient panel, alongside pinned Quests
      await blur(page);
      await sleep(400);
      const opened = await page.evaluate(`({ live: window.tz.panel.isOpen('live'), quests: window.tz.panel.isOpen('quests'), pinned: window.tz.panel.isPinned('quests'), card: !document.getElementById('quest-card').hidden })`);
      assert(opened.live, 'the Live panel did not open');
      assert(opened.quests && opened.pinned, 'the pinned Quests workspace was closed by opening a transient panel');

      const float = await page.evaluate(`(() => {
        const s = document.getElementById('stage').getBoundingClientRect();
        return { stage: [s.width, s.height], fit: window.tz.safeRect(), avoid: window.tz.avoidRect() };
      })()`);
      assert(float.fit.left <= 1 && float.fit.right >= float.stage[0] - 1,
        `with two panels open the fit rect is ${float.fit.left}..${float.fit.right} of ${float.stage[0]} px — a panel is shrinking the map`);
      assert(float.avoid.right < float.fit.right - 20,
        `avoidRect ${JSON.stringify(float.avoid)} does not step around the open dock — fly-to and the card would land behind it`);
      const camAfter = await page.evaluate('window.tz.camera');
      assert(near(camAfter.zoom, camBefore.zoom, 1e-6)
        && near(camAfter.target[0], camBefore.target[0], 0.01) && near(camAfter.target[1], camBefore.target[1], 0.01),
        `opening a panel moved the camera: ${JSON.stringify(camBefore)} → ${JSON.stringify(camAfter)}`);

      const peeled = [];
      if (opened.card) {                                 // Esc #1 — the card comes off first
        await page.key('Escape');
        await sleep(350);
        const s = await page.evaluate(`({ card: !document.getElementById('quest-card').hidden, live: window.tz.panel.isOpen('live'), quests: window.tz.panel.isOpen('quests') })`);
        assert(!s.card, 'Esc did not close the quest card');
        assert(s.live, 'Esc closed the transient panel before the card');
        peeled.push('quest card');
      }
      await page.key('Escape');                          // Esc #2 — the transient panel
      await sleep(400);
      const s2 = await page.evaluate(`({ live: window.tz.panel.isOpen('live'), quests: window.tz.panel.isOpen('quests'), pinned: window.tz.panel.isPinned('quests') })`);
      assert(!s2.live, 'Esc did not close the transient Live panel');
      assert(s2.quests && s2.pinned, 'Esc closed the pinned Quests workspace — pinned panels must survive');
      peeled.push('Live panel');

      await page.key('Escape');                          // Esc #3 — nothing left to peel
      await sleep(300);
      const s3 = await page.evaluate(`({ quests: window.tz.panel.isOpen('quests'), pinned: window.tz.panel.isPinned('quests') })`);
      assert(s3.quests && s3.pinned, 'a third Esc unpinned the workspace');
      const camEnd = await page.evaluate('window.tz.camera');
      assert(near(camEnd.zoom, camBefore.zoom, 1e-6),
        `closing the panels re-fitted the camera: ${camBefore.zoom} → ${camEnd.zoom}`);
      return { peeled, cardWasOpen: opened.card, questsStillPinned: s3.pinned, fitRect: float.fit, avoidRect: float.avoid };
    });

    /* -- 8 ---------------------------------------------------------- '3' round-trips 2D -- */
    await step(page, "8. '3' switches to 2D and back to 3D", 'view-roundtrip', async () => {
      await blur(page);
      const before = await page.evaluate('window.tz.camera');
      await page.key('3');
      await page.waitFor('window.tz.view === "2d"', { timeout: 8000, label: 'the 2D view' });
      await sleep(1200);
      assert(await page.evaluate(`document.querySelector('#view-toggle .seg-cell.on')?.dataset.view === '2d'`), 'the 2D/3D control still shows 3D');
      assert(await page.evaluate(`document.querySelectorAll('#map .leaflet-marker-icon').length > 0`), 'the 2D map drew no markers');
      const flat = await shoot(page, 'view-2d');

      await page.key('3');
      await page.waitFor('window.tz.view === "3d"', { timeout: 12_000, label: 'the 3D view' });
      await sleep(2500);
      const after = await page.evaluate('window.tz.camera');
      assert(after.mode === '3d', `back in "${after.mode}" instead of 3D`);
      // The round-trip has to come back to the same framing, not a re-fit (zoomOffset() is the
      // one function both directions use, so a regression here shows up as a scale jump).
      assert(near(after.zoom, before.zoom, 0.25), `zoom changed across the round-trip: ${before.zoom?.toFixed?.(2)} → ${after.zoom?.toFixed?.(2)}`);
      assert(near(after.target[0], before.target[0], 3) && near(after.target[1], before.target[1], 3),
        `centre moved across the round-trip: ${JSON.stringify(before.target)} → ${JSON.stringify(after.target)}`);
      const stats = await frameStats(page, await page.screenshot());
      assert(!(stats.mean < 4 && stats.max < 12), `the 3D view came back black (mean ${stats.mean.toFixed(2)})`);
      return { twoDShot: flat, zoom: { before: before.zoom, after: after.zoom }, frameMean: Number(stats.mean.toFixed(1)) };
    });

    /* -- 9 ----------------------------- the assistant panel: upper-left, and structural -- */
    // Founder, 2026-09-02: "move the AI chat to there" (a box drawn in the upper-left of the map),
    // "also shows a picture in the chat", "this quest is on woods, want to move to that map? option".
    //
    // The model boundary is STUBBED here — `window.fetch` returns a canned envelope for
    // /api/assistant only, so this step never needs a key, a network or DeepSeek. Everything after
    // that is the real client: the real omnibox route, the real contract validation, the real panel.
    await step(page, '9. `?` answers into the upper-left panel — buttons from actions, photos, stale is inert', 'assistant-panel', async () => {
      await blur(page);
      // One real Customs quest slug, so the stale half below has something it COULD have selected.
      const slug = await page.evaluate(`(async () => {
        const all = await window.tz.quests.all();
        const q = all.find((x) => (x.siteMaps ?? []).includes('customs') && (x.objectives ?? []).length);
        return q ? q.slug : null;
      })()`, { awaitPromise: true });
      assert(slug, 'no Customs quest in quests.json to build the stale envelope from');

      await page.evaluate(`(() => {
        const real = window.fetch.bind(window);
        window.__ask = { calls: 0, reply: null, sent: null };
        window.fetch = (url, init) => {
          if (String(url).includes('/api/assistant')) {
            window.__ask.calls += 1;
            try { window.__ask.sent = JSON.parse(init.body); } catch { window.__ask.sent = null; }
            return Promise.resolve({ ok: true, status: 200, json: async () => window.__ask.reply });
          }
          return real(url, init);
        };
        // The prose PROMISES a map switch in words. Whether a button appears is decided by the
        // envelope's actions and nothing else — that is what the first half of this step asserts.
        const prose = 'The sawmill is in the middle of the map.\\n\\nThis quest is on **Woods** — want to move to that map? Switch to Woods and I will mark it.';
        const shots = [0, 1].map((i) => ({
          id: 'img' + (i + 1),
          url: 'https://static.wikia.nocookie.net/tarkovzero-e2e-no-such-image/' + i + '.png',
          caption: 'Screenshot ' + (i + 1), depicts: 'The sawmill, shot ' + (i + 1), map: 'woods',
          questSlug: 'the-punisher-part-4', questName: 'The Punisher - Part 4', objectiveId: null,
          credit: 'EFT Wiki (CC BY-NC-SA)',
        }));
        window.__envelopes = {
          // (a) prose begs for a switch, envelope carries NO actions -> zero buttons
          proseOnly: { protocol: 2, map: 'customs', answer: prose, actions: [], images: [], imageIndexOk: true, quests: [], sources: [
            { slug: 'the-punisher-part-4', name: 'The Punisher - Part 4', trader: 'Prapor', wikiLink: null, maps: ['woods'], siteMaps: ['woods'] },
          ] },
          // (b) the same prose WITH the action -> exactly the buttons the actions describe
          withActions: { protocol: 2, map: 'customs', answer: prose, imageIndexOk: true, quests: [], images: shots,
            actions: [
              { type: 'switchMap', map: 'woods', label: 'Woods', slug: 'the-punisher-part-4', name: 'The Punisher - Part 4', objectiveId: null },
              { type: 'showImages', imageIds: ['img1', 'img2'] },
            ],
            sources: [{ slug: 'the-punisher-part-4', name: 'The Punisher - Part 4', trader: 'Prapor', wikiLink: null, maps: ['woods'], siteMaps: ['woods'] }] },
          // (c) an answer that outlived a map switch: echoes woods while the tab is on customs
          stale: { protocol: 2, map: 'woods', answer: 'Here it is on Woods.', imageIndexOk: true, quests: [], images: [], sources: [],
            actions: [{ type: 'selectQuest', slug: ${JSON.stringify(slug)}, name: 'A quest' }] },
        };
        return true;
      })()`);

      /* (a) --------------------------------------------- prose is not a button source -- */
      await page.evaluate('window.__ask.reply = window.__envelopes.proseOnly');
      await omni(page, '?where is the sawmill');
      await page.waitFor('!document.getElementById("panel-ask").hidden', { timeout: 8000, label: 'the assistant panel' });
      await page.waitFor('document.querySelectorAll("#ask-log .ask-msg").length >= 3', { timeout: 8000, label: 'the answer' });
      const a = await page.evaluate(`(() => {
        const log = document.getElementById('ask-log');
        const last = log.querySelector('.ask-msg:last-child');
        return {
          asked: [...log.querySelectorAll('.ask-user')].map((n) => n.textContent.trim()),
          buttons: [...last.querySelectorAll('.ask-act')].map((b) => b.textContent.trim()),
          prose: last.querySelector('.ask-prose')?.textContent ?? '',
          sources: [...last.querySelectorAll('.ask-src')].map((n) => n.textContent.replace(/\\s+/g, ' ').trim()),
        };
      })()`);
      assert(a.asked.includes('where is the sawmill'), `the question did not reach the panel: ${JSON.stringify(a.asked)}`);
      assert(/want to move to that map/.test(a.prose), 'the answer prose was not rendered');
      assert(a.buttons.length === 0, `the prose alone produced buttons: ${JSON.stringify(a.buttons)}`);
      // …and the panel still looks finished: the source line says where the quest actually is.
      assert(a.sources.length === 1 && /Woods/.test(a.sources[0]), `no honest source line: ${JSON.stringify(a.sources)}`);

      /* (b) ------------- the same prose, now WITH a switchMap action to a LOCKED map -- */
      // Woods was locked on 2026-09-02 ("put all the maps but lock them"). The envelope below is
      // exactly what the server used to send, so this is the regression that matters: a "Switch to
      // Woods" button on a page whose picker will not open Woods is a button that goes nowhere.
      // The photo button beside it is the control — the row still renders, it is only the map
      // action that the contract's availability gate removes.
      await page.evaluate('window.__ask.reply = window.__envelopes.withActions');
      await omni(page, '?and on which map is it');
      await page.waitFor('document.querySelectorAll("#ask-log .ask-msg").length >= 5', { timeout: 8000, label: 'the second answer' });
      const b = await page.evaluate(`(() => {
        const last = document.getElementById('ask-log').querySelector('.ask-msg:last-child');
        return {
          buttons: [...last.querySelectorAll('.ask-act')].map((x) => x.textContent.trim()),
          figures: last.querySelectorAll('figure.ask-shot').length,
          imgs: [...last.querySelectorAll('img')].map((i) => ({ lazy: i.getAttribute('loading'), ref: i.getAttribute('referrerpolicy'), alt: i.getAttribute('alt') })),
          credit: last.querySelector('.ask-credit')?.textContent ?? '',
        };
      })()`);
      assert(!b.buttons.some((x) => /Switch to/.test(x)),
        `a switch to a LOCKED map reached the live page: ${JSON.stringify(b.buttons)}`);
      assert(b.buttons.length === 1 && /Photos/.test(b.buttons[0]),
        `buttons do not match the envelope's surviving actions: ${JSON.stringify(b.buttons)}`);
      assert(b.figures === 2, `expected the envelope's two photos, got ${b.figures}`);
      assert(b.imgs.every((i) => i.lazy === 'lazy' && i.ref === 'no-referrer' && i.alt),
        `an image shipped without lazy/no-referrer/alt: ${JSON.stringify(b.imgs)}`);
      assert(/EFT Wiki/.test(b.credit), 'the wiki credit is missing from the photo strip');
      // Not offering the switch is not performing it either: the page must still be on Customs.
      assert(await page.evaluate('window.tz.map') === 'customs', 'a switchMap action performed itself');

      /* (b2) ------------------------------- a photo that fails to load leaves nothing -- */
      // The real onerror handler, fired without waiting on a network the harness does not have.
      await page.evaluate(`(() => { for (const i of document.querySelectorAll('#ask-log img')) i.onerror(); return true; })()`);
      const broken = await page.evaluate(`(() => {
        const log = document.getElementById('ask-log');
        return {
          figures: log.querySelectorAll('figure').length,
          imgs: log.querySelectorAll('img').length,
          strips: log.querySelectorAll('.ask-shots').length,
          note: log.querySelector('.ask-shots-note')?.textContent ?? '',
        };
      })()`);
      assert(broken.figures === 0 && broken.imgs === 0, `a broken image left ${broken.figures} frame(s) behind`);
      assert(broken.strips === 0, 'an empty picture strip is still on screen');
      assert(/could not be loaded/i.test(broken.note), `nothing said the screenshots failed: "${broken.note}"`);
      assert(!/\bno (photos|images|screenshots)\b/i.test(broken.note), `a failed LOAD was reported as "no photos": "${broken.note}"`);

      /* (c) ------------------------------------------- a stale answer is never replayed -- */
      const beforeSel = await page.evaluate('window.tz.quests.selected()');
      const beforeCam = await page.evaluate('window.tz.camera');
      await page.evaluate('window.__ask.reply = window.__envelopes.stale');
      await omni(page, '?what about woods');
      await page.waitFor('document.querySelectorAll("#ask-log .ask-msg").length >= 7', { timeout: 8000, label: 'the stale answer' });
      await sleep(600);
      const c = await page.evaluate(`(() => {
        const last = document.getElementById('ask-log').querySelector('.ask-msg:last-child');
        return {
          buttons: last.querySelectorAll('.ask-act').length,
          stale: last.querySelectorAll('.ask-stale').length,
          note: last.querySelector('.ask-stale')?.textContent ?? '',
          selected: window.tz.quests.selected(),
          map: window.tz.map,
        };
      })()`);
      const afterCam = await page.evaluate('window.tz.camera');
      assert(c.buttons === 0, `a stale answer offered ${c.buttons} button(s) to replay`);
      assert(c.stale === 1 && /Woods/.test(c.note) && /Customs/.test(c.note), `the stale answer does not name both maps: "${c.note}"`);
      assert(JSON.stringify(c.selected) === JSON.stringify(beforeSel),
        `a stale answer selected a quest: ${JSON.stringify(beforeSel)} → ${JSON.stringify(c.selected)}`);
      assert(near(afterCam.zoom, beforeCam.zoom, 1e-6) && near(afterCam.target[0], beforeCam.target[0], 0.01),
        `a stale answer moved the camera: ${JSON.stringify(beforeCam)} → ${JSON.stringify(afterCam)}`);

      /* (d) --------------------- it sits in the upper-left, OUTSIDE the reader's rect -- */
      const geo = await geometry(page);
      assert(geo.panel.w > 200 && geo.panel.h > 120, `the panel has no box: ${JSON.stringify(geo.panel)}`);
      assert(geo.panel.left < geo.stage.w * 0.25 && geo.panel.top < geo.stage.h * 0.35,
        `the panel is not in the upper-left: ${JSON.stringify(geo.panel)} of ${JSON.stringify(geo.stage)}`);
      // avoidRect() owns everything reader-facing (label seating, the quest card, fly-to
      // recentring). If it does not start to the RIGHT of this panel, the map believes labels are
      // visible underneath the conversation. Step 10 asserts the same thing after a DRAG, which is
      // where a rule that always insets the left edge stops being true.
      assert(geo.avoid.left >= geo.panel.right - 1,
        `avoidRect starts at ${geo.avoid.left} but the panel reaches ${geo.panel.right} — labels would be seated behind it`);
      // …and it is NOT an inset on the fit: panels float, they never shrink the map (QA H4).
      assert(geo.fit.left <= 1, `the assistant panel took ${geo.fit.left}px off the FIT rect`);
      // The bar is gone from the bottom of the screen, and the fit got the band back.
      const bottomBar = await page.evaluate(`(() => {
        const o = document.getElementById('omnibox');
        const s = document.getElementById('stage').getBoundingClientRect();
        const r = o.getBoundingClientRect();
        return { insidePanel: !!o.closest('#panel-ask'), bottom: r.bottom - s.top, stageH: s.height, fitBottom: window.tz.safeRect().bottom };
      })()`);
      assert(bottomBar.insidePanel, 'the omnibox is not inside the Ask panel — the bottom bar is back');
      assert(bottomBar.fitBottom >= bottomBar.stageH - 1,
        `the FIT rect still reserves ${(bottomBar.stageH - bottomBar.fitBottom).toFixed(0)}px at the bottom for a bar that is gone`);

      /* (e) --------------------------------- closing gives the left edge back; the button -- */
      await page.evaluate(`window.tz.panel.close('ask')`);
      await sleep(350);
      const closed = await page.evaluate(`({ hidden: document.getElementById('panel-ask').hidden, avoid: window.tz.avoidRect() })`);
      assert(closed.hidden, 'closing the assistant panel left it on screen');
      assert(closed.avoid.left < geo.avoid.left - 20,
        `closing the panel did not give the left edge back (${geo.avoid.left} → ${closed.avoid.left})`);
      await clickEl(page, `document.getElementById('tb-ask')`);
      await sleep(350);
      assert(await page.evaluate(`window.tz.panel.isOpen('ask')`), 'the toolbar button did not reopen the conversation');

      return {
        questionsAsked: await page.evaluate('window.__ask.calls'),
        proseOnlyButtons: a.buttons.length,
        withActionsButtons: b.buttons,
        brokenImageNote: broken.note,
        staleButtons: c.buttons,
        panel: geo.panel, avoidRect: geo.avoid, fitRect: geo.fit,
      };
    });

    /* -- 10 -------------------- the panel is furniture: drag, resize, minimise, remember -- */
    // Founder, 2026-09-02: "keep the side active, able it to be moved around and pinned, and make
    // it bit taller to fit more convo. and ability to minimize. it can also start small."
    //
    // The assertion that carries this step is NOT "the panel moved" — it is that `avoidRect()`
    // moved WITH it. A panel that can be dragged anywhere while the rect keeps insetting the left
    // edge is the failure mode of §6 exactly: the map reports a reader-visible box that has a
    // conversation sitting on it, and nothing fails.
    await step(page, '10. the Ask panel drags, resizes and minimises — and avoidRect follows it', 'panel-floating', async () => {
      await blur(page);
      await page.evaluate(`window.tz.panel.reveal('ask')`);
      await sleep(250);
      const start = await geometry(page);
      assert(start.box.min === false, 'the panel opened minimised');
      assert(start.avoid.left >= start.panel.right - 1, `the docked default no longer insets the left: ${JSON.stringify(start.avoid)}`);

      /* (a) ----------------------------------------------- drag it across the map -------- */
      const head = await page.evaluate(`(() => {
        const r = document.querySelector('#panel-ask .panel-hd').getBoundingClientRect();
        return { x: r.left + r.width * 0.42, y: r.top + r.height / 2 };
      })()`);
      const target = { x: start.stage.w * 0.72, y: 150 };
      await drag(page, head, target);
      const moved = await geometry(page);
      assert(moved.panel.left > start.stage.w * 0.5,
        `the drag did not move the panel: ${JSON.stringify(start.panel)} → ${JSON.stringify(moved.panel)}`);
      // THE TRAP. On the right of the map the reader's rect must inset its RIGHT edge; the left
      // edge it used to take unconditionally has to come back.
      assert(!rectCovers(moved.avoid, moved.panel),
        `avoidRect ${JSON.stringify(moved.avoid)} still contains the panel at ${JSON.stringify(moved.panel)} — labels seated behind it`);
      assert(moved.avoid.right <= moved.panel.left + 1,
        `avoidRect reaches ${moved.avoid.right} but the panel starts at ${moved.panel.left}`);
      assert(moved.avoid.left <= 1,
        `avoidRect is still insetting the LEFT edge (${moved.avoid.left}) for a panel on the RIGHT — the hard-coded rule survived`);
      assert(moved.fit.left <= 1 && moved.fit.right >= moved.stage.w - 1,
        `dragging the panel shrank the FIT rect: ${JSON.stringify(moved.fit)}`);

      /* (a2) ------------------ …and the label seating pass is reading the moved rect ----- */
      // renderStats().labels.rect IS textRect(avoidRect) — the box names are seated inside. A pass
      // that kept the old rect would print names underneath the panel while reporting them seated.
      // The layer set has to be REBUILT for the pass to run again, and only a real camera
      // interaction does that: map3d's `setView()` (which is what the +/- keys reach) writes deck's
      // viewState and returns, so a programmatic zoom leaves the seating pass reporting whatever
      // rect the last interactive frame recorded — measured at 958 with the panel sitting at 857,
      // which would have failed this assertion for the wrong reason. So: a short PAN over a part of
      // the map neither panel is on top of, asserted to have moved the camera. A pan is the right
      // nudge — it is the interaction the screen-space seating pass exists for, and it barely
      // changes which names are on screen, so `seated` below stays a real number.
      await blur(page);
      const panBefore = await page.evaluate('window.tz.camera.target');
      await drag(page, { x: start.stage.w * 0.30, y: start.stage.h * 0.62 },
        { x: start.stage.w * 0.30 + 34, y: start.stage.h * 0.62 + 22 });
      await sleep(700);
      const panAfter = await page.evaluate('window.tz.camera.target');
      assert(!near(panAfter[0], panBefore[0], 1e-6) || !near(panAfter[1], panBefore[1], 1e-6),
        `the camera never moved (${JSON.stringify(panBefore)} → ${JSON.stringify(panAfter)}) — the redraw this assertion reads did not happen`);
      // Poll for the pass to catch up, and carry the WHOLE picture into the failure message: the
      // panel, the rect it should have produced and the rect the seating pass actually used.
      let seat = null;
      for (let i = 0; i < 32; i++) {
        seat = await page.evaluate(`(() => {
          const s = document.getElementById('stage').getBoundingClientRect();
          const p = document.getElementById('panel-ask').getBoundingClientRect();
          return { panelLeft: p.left - s.left, avoid: window.tz.avoidRect(),
                   labels: window.tz.renderStats()?.labels ?? null, zoom: window.tz.camera.zoom };
        })()`);
        if (seat.labels?.rect && seat.labels.rect.right <= seat.panelLeft + 1) break;
        await sleep(280);
      }
      const labels = seat.labels;
      assert(labels && labels.bail === null, `the label pass did not run after the drag: ${JSON.stringify(seat)}`);
      assert(seat.avoid.right <= seat.panelLeft + 1, `avoidRect stopped following the panel: ${JSON.stringify(seat)}`);
      assert(labels.rect && labels.rect.right <= seat.panelLeft + 1,
        `the label seating rect runs under the panel: ${JSON.stringify(seat)}`);
      assert(labels.seated > 0, 'no names were seated at all, so the rect above proves nothing');

      /* (b) --------------------------------------------- resize by the corner grip ------- */
      const grip = await page.evaluate(`(() => {
        const r = document.querySelector('[data-grip=ask]').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      await drag(page, grip, { x: grip.x + 90, y: grip.y + 170 });
      const resized = await geometry(page);
      assert(resized.box.h >= moved.box.h + 120,
        `the grip did not make the panel taller (${moved.box.h} → ${resized.box.h})`);
      assert(resized.panel.h >= moved.panel.h + 120,
        `the box grew but the panel did not: ${moved.panel.h} → ${resized.panel.h}`);
      assert(resized.box.w >= moved.box.w + 60, `the grip did not widen it (${moved.box.w} → ${resized.box.w})`);

      /* (c) ----------------------------------- minimise: a title bar, not a closed panel -- */
      const minBox = await clickEl(page, `document.querySelector('[data-min=ask]')`);
      await sleep(300);
      const hit = await page.evaluate(`(() => {
        const b = document.querySelector('[data-min=ask]');
        const r = b.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { over: top ? (top.tagName + '.' + top.getAttribute('class') + '#' + (top.id || '')) : null,
                 isTheButton: !!top?.closest?.('[data-min=ask]'), pressed: b.getAttribute('aria-pressed'),
                 rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
      })()`);
      const mini = await page.evaluate(`(() => {
        const s = document.getElementById('stage').getBoundingClientRect();
        const p = document.getElementById('panel-ask').getBoundingClientRect();
        const log = document.getElementById('ask-log');
        const omniBox = document.getElementById('omnibox');
        return {
          open: window.tz.panel.isOpen('ask'), min: window.tz.panel.isMinimized('ask'),
          hidden: document.getElementById('panel-ask').hidden,
          h: p.height, logH: log.getClientRects().length ? log.getBoundingClientRect().height : 0,
          omniH: omniBox.getClientRects().length ? omniBox.getBoundingClientRect().height : 0,
          avoid: window.tz.avoidRect(), stageW: s.width,
        };
      })()`);
      assert(mini.open && !mini.hidden, 'minimising CLOSED the panel — they are different things');
      assert(mini.min === true,
        `the shell does not report the panel as minimised — clicked ${JSON.stringify(minBox)}, `
        + `hit test ${JSON.stringify(hit)}`);
      assert(mini.h <= 44, `a minimised panel is ${mini.h}px tall — that is not a title bar`);
      assert(mini.logH === 0 && mini.omniH === 0, `the collapsed panel still draws its body: ${JSON.stringify(mini)}`);
      assert(mini.avoid.right > resized.avoid.right + 40,
        `minimising did not give the map its column back (${resized.avoid.right} → ${mini.avoid.right})`);

      /* (d) ------------------- one keystroke from a usable input, minimised or not -------- */
      // The panel carries the app's ONLY text field. If Ctrl K cannot reach it from a collapsed
      // panel, search is now harder to get at than the bar this replaced.
      await blur(page);
      await page.key('k', { modifiers: 2 });
      await sleep(320);
      const revived = await page.evaluate(`({
        min: window.tz.panel.isMinimized('ask'),
        focused: document.activeElement?.id ?? null,
      })`);
      assert(revived.min === false, 'Ctrl K left the panel collapsed');
      assert(revived.focused === 'find', `Ctrl K put the keyboard on "${revived.focused}", not the omnibox`);
      await page.evaluate(`document.getElementById('find').blur()`);

      /* (e) --------------------------------------- …and it all survives a reload ---------- */
      const before = (await geometry(page)).box;
      await page.evaluate(`window.tz.panel.minimize('ask', true); window.tz.panel.setPinned('ask', true);`);
      await sleep(200);
      assert(await page.evaluate(`window.tz.panel.isPinned('ask')`), 'the Ask panel would not pin');
      await page.navigate(URL);
      await page.waitFor('!!window.tz', { timeout: 30_000, label: 'window.tz after the reload' });
      await page.waitFor('!!document.querySelector("#map3d canvas")', { timeout: 40_000, label: 'the canvas after the reload' });
      await sleep(2500);
      const after = await page.evaluate(`({
        box: window.tz.panel.box(), open: window.tz.panel.isOpen('ask'),
        pinned: window.tz.panel.isPinned('ask'),
        hidden: document.getElementById('panel-ask').hidden,
        stored: JSON.parse(localStorage.getItem('tz:askpanel') || 'null'),
      })`);
      assert(after.stored, 'nothing was written to tz:askpanel — the geometry is not persisted at all');
      assert(after.open && !after.hidden, 'the panel did not come back open after the reload');
      assert(after.pinned === true, 'the pin was forgotten across the reload');
      assert(after.box.min === true, 'the minimised state was forgotten across the reload');
      for (const k of ['x', 'y', 'w', 'h']) {
        assert(near(after.box[k], before[k], 1.5),
          `${k} was not remembered across the reload: ${before[k]} → ${after.box[k]}`);
      }
      // Leave it expanded so the remaining steps are photographed in a normal state.
      await page.evaluate(`window.tz.panel.minimize('ask', false)`);
      await sleep(250);
      return {
        start: start.box, dragged: moved.box, resized: resized.box, restored: after.box,
        avoid: { docked: start.avoid, dragged: moved.avoid, minimised: mini.avoid },
        labelRect: labels.rect,
      };
    });

    /* -- 11 ------------------------------------------ the page threw nothing along the way -- */
    // The chain above drives the real app for a couple of minutes; every uncaught exception and
    // console error it produced is already in `pageLog`. It used to be collected and then only ever
    // printed when some *other* assertion had already failed — a page throwing on every frame could
    // walk the whole chain and report PASS. This is the assertion that arms it.
    await step(page, '11. no page console errors during the walkthrough', 'console-clean', async () => {
      // Deduped: one broken frame can log the same line hundreds of times.
      const seen = [...new Set(pageLog)];
      assert(seen.length === 0, `${pageLog.length} console error(s) during the run:\n    ${seen.slice(0, 8).join('\n    ')}`);
      return { errors: 0 };
    });

    /* -- 12 -------------------------------------- the URL a visitor types is the Three map -- */
    // The flip itself (2026-09-02). Steps 1–11 drove `?renderer=deck`; this one drives the address
    // a visitor actually lands on, and asserts the two answers the gate keeps separate: the
    // renderer moved, the boundary did not. It runs LAST so that (a) the deck chain's console
    // check above is not measuring this page, and (b) the Three path's own console output is
    // reported as a delta against a run that was already clean.
    const deckErrorCount = pageLog.length;
    await step(page, '12. the bare Customs URL is Three, on public data, and says so', 'default-three', async () => {
      await page.navigate(DEFAULT_URL);
      await page.waitFor('!!window.tz', { timeout: 30_000, label: 'window.tz' });
      await page.waitFor('!!document.querySelector("#map3d canvas")', { timeout: 60_000, label: 'the three.js canvas' });
      await page.waitFor('!!window.tz.renderStats()', { timeout: 60_000, label: 'renderStats()' });
      await sleep(6000);   // terrain mesh, authored assets, first lit frame

      const search = await page.evaluate('location.search');
      assert(!/renderer=/.test(search), `step 12 asked for a renderer after all: "${search}"`);
      const renderer = await page.evaluate('window.tz.renderer');
      assert(renderer === 'three', `the bare Customs URL resolved to "${renderer}" — the default did not flip`);
      assert(await page.evaluate(`document.body.classList.contains('renderer-three')`),
        'the renderer-three body class is absent, so the Three-only chrome rules never applied');

      const rs = await page.evaluate('window.tz.renderStats()');
      assert(rs.renderer === 'three', `renderStats() reports renderer "${rs.renderer}"`);
      // THE BOUNDARY, on the running production bundle. `dist` is built with DEV absent, so this
      // page cannot reach local game-derived data no matter what host serves it — and it reports
      // that as a release build rather than as a failed fetch.
      assert(rs.gate.localEnhancements === false,
        `a release build claims local game-derived data is available: ${JSON.stringify(rs.gate)}`);
      assert(rs.gate.localEnhancementReason === 'release-build',
        `the gate reason is "${rs.gate.localEnhancementReason}", expected "release-build"`);
      assert(rs.gate.request === null, `the gate saw a renderer request: ${JSON.stringify(rs.gate.request)}`);
      assert(rs.gate.renderer === 'three' && rs.gate.mapKey === 'customs', JSON.stringify(rs.gate));
      // THE FOUNDER'S COMPLAINT, as a gate. 2026-09-02: "this is far from what we worked on. not
      // even the floor ground correct." Production was drawing the heightfield fitted from spawn
      // and loot points while the reviewed local build drew the exact Unity tiles. The terrain
      // surfaces are promoted now, so a release build MUST be on the exact ground — and it must be
      // reached through the PROMOTED public package, with the local gate still shut (asserted
      // immediately above). A silent fall back to the heightfield fails here.
      assert(rs.exactTerrain?.mode === 'promoted-public-exact',
        `production is not on the promoted exact terrain: ${JSON.stringify(rs.exactTerrain)}`);
      assert(rs.exactTerrain.distribution === 'promoted-public',
        `the exact terrain came from ${JSON.stringify(rs.exactTerrain.distribution)}, not the promoted package`);
      assert(rs.exactTerrain.source === '/assets/3d/customs/terrain/terrain-manifest.json',
        `the promoted terrain names the wrong source: ${rs.exactTerrain.source}`);
      assert(rs.exactTerrain.tiles === 2 && rs.exactTerrain.vertices > 0 && rs.exactTerrain.triangles > 0,
        `the promoted terrain compiled no geometry: ${JSON.stringify(rs.exactTerrain)}`);
      // THE SAME COMPLAINT, second half. Vegetation was promoted the same day, so a release build
      // must be on the PROMOTED placement table — 8,805 rows read out of public/, with the local
      // gate still shut (asserted above). `reviewed-fallback` here means the promoted package did
      // not load, which is now a defect rather than the shipped configuration.
      assert(rs.exactVegetation?.mode === 'exact-placement-original-procedural-assets',
        `a release build has no exact vegetation plan: ${JSON.stringify(rs.exactVegetation)}`);
      assert(rs.exactVegetation.distribution === 'promoted-public',
        `the vegetation plan came from ${JSON.stringify(rs.exactVegetation.distribution)}, not the promoted package`);
      assert(rs.exactVegetation.declaredInstances === 8805,
        `the promoted placement table declares ${rs.exactVegetation.declaredInstances} placements, not 8805`);
      assert(rs.exactVegetation.placementsVerified === true,
        'the promoted placement table shipped without its sha256 receipt being checked');
      // ...and the frame must not claim authored vegetation it has not mounted yet. On this run the
      // mount is still in flight, so the honest state is `mount-in-flight` with a real count — the
      // failure mode handoff §6 records is a strip reading "7,108 AUTHORED VEGETATION" over zero.
      const vegetationStrip = rs.vegetation?.strip ?? null;
      assert(vegetationStrip, `the vegetation strip is missing: ${JSON.stringify(rs.vegetation ?? null)}`);
      assert(vegetationStrip.authoredPlacements === 0 || vegetationStrip.state === 'authored'
        || vegetationStrip.state === 'authored-degraded',
        `the strip claims ${vegetationStrip.authoredPlacements} authored placements in state `
        + `${vegetationStrip.state}: ${JSON.stringify(vegetationStrip)}`);
      // The pre-promotion release notice is GONE. It described a procedural forest as the shipped
      // configuration; the pack ships now, so that sentence would be a lie about this frame.
      const staleNotice = (rs.vegetation?.warnings ?? []).find((line) => /is NOT promoted|Exact ground, procedural trees: that is the shipped configuration/.test(line));
      assert(!staleNotice, `the pre-promotion release notice survived: ${staleNotice}`);

      // THE BUILD NOTICES ARE OFF THE LIVE PAGE (founder, 2026-09-02: "also remove the notification
      // boxes in the middle about the build"), and the truth behind them is not.
      //
      // Both halves are asserted here, together, because either one alone is the failure this
      // project keeps having: a banner nobody hid, or a banner hidden by deleting the measurement.
      const banners = await page.evaluate(
        'JSON.stringify({strip: !!document.querySelector(".tz-three-proof-chip"),'
        + ' veg: !!document.querySelector(".tz-veg-chip"),'
        + ' hover: !!document.querySelector(".tz-three-hover")})',
      );
      const shown = JSON.parse(banners);
      assert(shown.strip === false, 'the CUSTOMS TRUTH strip is still drawn on the live page');
      assert(shown.veg === false, 'the vegetation notice is still drawn on the live page');
      assert(shown.hover === true, 'the hover label went with the build notices — it is not one');
      assert(rs.gate.diagnosticReadouts === false,
        `the gate says the readouts are shown on a release build: ${JSON.stringify(rs.gate)}`);
      // …and the state is intact and honest. `truth` is the SAME composed strip a dev box paints.
      assert(rs.truth && rs.truth.shown === false,
        `renderStats().truth is missing or claims to be on screen: ${JSON.stringify(rs.truth ?? null)}`);
      assert(rs.truth.title === 'CUSTOMS TRUTH',
        `production is not composing the exact-terrain strip: ${JSON.stringify(rs.truth)}`);
      assert(/EXACT TERRAIN — PROMOTED/.test(rs.truth.detail),
        `the hidden strip does not name the promoted ground: ${rs.truth.detail}`);
      assert(['exact', 'requested', 'pending'].includes(rs.truth.state),
        `the hidden strip reports a DEGRADED production frame: ${JSON.stringify(rs.truth)}`);
      // A degraded load is still DETECTABLE with the banner gone: this is the discriminator, and it
      // reads the published state, never the DOM. If the promoted terrain silently fell back, the
      // title would be CUSTOMS PUBLIC DATA and the state degraded — both visible right here.
      assert(rs.truth.segments.every((s) => typeof s === 'string' && s.length),
        `the hidden strip published an empty segment: ${JSON.stringify(rs.truth.segments)}`);
      notes.push(`build notices hidden in release; renderStats().truth = ${rs.truth.state} · ${rs.truth.title} · ${rs.truth.detail}`);
      notes.push(`promoted terrain live in production: ${rs.exactTerrain.tiles} tiles, `
        + `${rs.exactTerrain.vertices} vertices, ${rs.exactTerrain.triangles} triangles, `
        + `surface ${rs.exactTerrain.surface}, first frame ${rs.firstFrameMs} ms`);
      notes.push(`promoted vegetation live in production: ${rs.exactVegetation.declaredInstances} declared, `
        + `${rs.exactVegetation.renderedInstances} in scope, receipt verified `
        + `${rs.exactVegetation.placementsVerified}, mount ${rs.vegetation?.mount?.phase ?? 'not started'}`);
      // The scene is public data and is not empty: the heightfield, the trees and the buildings the
      // founder was missing are all on the frame. A gate that says "three" over a blank canvas
      // would satisfy every assertion above.
      const stats = await frameStats(page, await page.screenshot());
      assert(!(stats.mean < 4 && stats.max < 12), `the default Customs frame is black (mean ${stats.mean.toFixed(2)})`);
      assert(rs.drawCalls > 0 && rs.triangles > 0,
        `no geometry was submitted on the default frame: ${JSON.stringify({ drawCalls: rs.drawCalls, triangles: rs.triangles, source: rs.drawCallsSource })}`);
      assert(rs.buildings?.buildings > 0 && rs.buildings.triangles.total > 0,
        `the detailed buildings the flip exists to show are not on the frame: ${JSON.stringify(rs.buildings?.drawCalls ?? null)}`);
      assert(rs.bridges?.decks > 0, `no bridge decks on the default frame: ${JSON.stringify(rs.bridges)}`);

      // Perf is UNMEASURED here: gpuFrameMs is null under SwiftShader. The draw-call and triangle
      // totals are the numbers that ARE real, so they go on the record.
      notes.push(`default Customs (three): ${rs.drawCalls} draw calls, ${rs.triangles} triangles, `
        + `${rs.geometries} geometries, ${rs.textures} textures, backend ${rs.backend}, `
        + `first frame ${rs.firstFrameMs} ms, gpuFrameMs ${rs.gpuFrameMs ?? 'null (SwiftShader — not measured)'}`);
      const newErrors = [...new Set(pageLog.slice(deckErrorCount))];
      if (newErrors.length) notes.push(`step 12 console (three path, ${newErrors.length} distinct): ${newErrors.slice(0, 4).join(' | ')}`);

      return {
        renderer, gate: rs.gate, backend: rs.backend,
        drawCalls: rs.drawCalls, triangles: rs.triangles, drawCallsSource: rs.drawCallsSource,
        geometries: rs.geometries, textures: rs.textures,
        buildings: rs.buildings?.buildings ?? null, buildingDrawCalls: rs.buildings?.drawCalls?.after ?? null,
        buildingTriangles: rs.buildings?.triangles?.total ?? null, gpuFrameMs: rs.gpuFrameMs ?? null,
        frameMean: Number(stats.mean.toFixed(1)),
        newConsoleErrors: newErrors.length,
      };
    });

    /* -- 13 --------------------------------- the picker lists eleven and opens exactly one -- */
    //
    // Founder, 2026-09-02: "on the live page for now on the maps tab put all the maps but lock
    // them. even the woods/reserve. so rn customs is what avalible." Reserve and Woods still work;
    // locking them is deliberate. What must not happen is a row that looks clickable and is not.
    await step(page, '13. the map picker shows all eleven maps and opens only Customs', 'map-picker', async () => {
      await page.evaluate('document.querySelector("#map-switcher").click()');
      await page.waitFor('document.querySelectorAll("#map-menu .map-option").length > 0',
        { timeout: 5000, label: 'the map menu' });
      const rows = JSON.parse(await page.evaluate(`JSON.stringify([...document.querySelectorAll('#map-menu .map-option')].map((b) => ({
        key: b.dataset.map,
        locked: b.dataset.locked === '1',
        text: b.textContent.trim(),
        badge: b.querySelector('.map-soon')?.textContent ?? null,
        title: b.getAttribute('title'),
        ariaDisabled: b.getAttribute('aria-disabled'),
        checked: b.getAttribute('aria-checked'),
      })))`));
      assert(rows.length === 11, `the picker shows ${rows.length} maps, not eleven: ${rows.map((r) => r.key).join(',')}`);
      const open = rows.filter((r) => !r.locked);
      assert(open.length === 1 && open[0].key === 'customs',
        `expected Customs alone to be openable, got ${JSON.stringify(open.map((r) => r.key))}`);
      assert(open[0].checked === 'true', 'the open map is not the one marked current');
      for (const row of rows.filter((r) => r.locked)) {
        // Not a dead click: it SAYS it is locked, on screen and to a screen reader, before you
        // press it. A greyed row with no badge and no accessible name is the failure mode here.
        assert(row.badge && row.badge.trim().length, `${row.key} is locked with no visible badge`);
        assert(/not available yet/i.test(row.title ?? ''), `${row.key} has no honest tooltip: ${row.title}`);
        assert(row.ariaDisabled === 'true', `${row.key} is not marked disabled to assistive tech`);
      }
      assert(rows.some((r) => r.key === 'woods' && r.locked) && rows.some((r) => r.key === 'reserve' && r.locked),
        'Reserve and Woods are not locked — the founder asked for exactly this');

      // Clicking a locked row navigates NOWHERE and says why.
      const before = await page.evaluate('location.href');
      await page.evaluate(`document.querySelector('#toast').textContent = ''`);
      await page.evaluate(`document.querySelector('#map-menu .map-option[data-map=woods]').click()`);
      await sleep(400);
      assert(await page.evaluate('location.href') === before, 'a locked row navigated the page');
      const toast = await page.evaluate('document.querySelector("#toast")?.textContent ?? ""');
      assert(/not available yet/i.test(toast), `clicking a locked row said nothing useful: "${toast}"`);

      // `?map=woods` is a documented entry point. It still resolves — to Customs — and says so.
      await page.navigate(`${HEADFUL_URL}/?map=woods`);
      await page.waitFor('!!window.tz', { timeout: 30_000, label: 'window.tz on ?map=woods' });
      await sleep(1200);
      const landed = await page.evaluate('window.tz.map');
      assert(landed === 'customs', `?map=woods landed on "${landed}"`);
      const said = await page.evaluate('document.querySelector("#toast")?.textContent ?? ""');
      assert(/woods/i.test(said) && /not available yet/i.test(said),
        `?map=woods substituted Customs in silence: "${said}"`);
      // …and `> map woods` refuses by name rather than calling it a typo. The toast is cleared
      // first so the sentence read back is this command's, not the boot notice's.
      const answer = await page.evaluate(`(() => {
        document.querySelector('#toast').textContent = '';
        const box = document.querySelector('#find');
        box.value = '> map woods';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return document.querySelector('#toast')?.textContent ?? '';
      })()`);
      assert(/not available yet/i.test(answer) && !/no map called/i.test(answer),
        `\`> map woods\` answered "${answer}"`);
      assert(await page.evaluate('window.tz.map') === 'customs', '`> map woods` navigated away');
      return { rows: rows.length, open: open.map((r) => r.key), locked: rows.filter((r) => r.locked).map((r) => r.key) };
    });

    /* -- 14 ------------------------- the build notices ARE there on dev + loopback ---------- */
    //
    // The other half of step 12. Hiding a banner is easy to get right in the direction you test:
    // a rule that hid it everywhere would pass step 12 and silently take the instrument away from
    // the machine it exists for. So this arm starts a real `vite dev` on loopback and asserts the
    // strip is on screen and reads EXACTLY what `renderStats().truth` reports.
    if (!SKIP_DEV_ARM) {
      const dev = await serveDev();
      try {
        await step(page, '14. on dev + loopback the build notices are drawn, and match the stats', 'dev-notices', async () => {
          await page.navigate(`${dev.url}/?map=customs`);
          await page.waitFor('!!window.tz', { timeout: 90_000, label: 'window.tz on the dev-mode bundle' });
          await page.waitFor('!!window.tz.renderStats()', { timeout: 90_000, label: 'renderStats() on the dev-mode bundle' });
          await sleep(5000);
          const rs = await page.evaluate('window.tz.renderStats()');
          assert(rs.gate.diagnosticReadouts === true,
            `dev + loopback did not arm the readouts: ${JSON.stringify(rs.gate)}`);
          assert(rs.truth?.shown === true, `renderStats().truth says hidden on dev: ${JSON.stringify(rs.truth ?? null)}`);
          const strip = await page.evaluate(
            'JSON.stringify({present: !!document.querySelector(".tz-three-proof-chip"),'
            + ' title: document.querySelector(".tz-three-proof-chip b")?.textContent ?? null,'
            + ' detail: document.querySelector(".tz-three-proof-chip span")?.textContent ?? null,'
            + ' state: document.querySelector(".tz-three-proof-chip")?.dataset.state ?? null,'
            + ' veg: !!document.querySelector(".tz-veg-chip")})',
          );
          const dom = JSON.parse(strip);
          assert(dom.present, 'the CUSTOMS TRUTH strip is missing on dev — it was hidden everywhere');
          assert(dom.veg, 'the vegetation notice is missing on dev');
          // The claim that makes step 12 mean something: the banner is a RENDERING of the stats,
          // so "the stats are still true with the banner gone" is a statement about one value.
          assert(dom.title === rs.truth.title, `strip title "${dom.title}" vs stats "${rs.truth.title}"`);
          assert(dom.detail === rs.truth.detail, `strip detail "${dom.detail}" vs stats "${rs.truth.detail}"`);
          assert(dom.state === rs.truth.state, `strip state "${dom.state}" vs stats "${rs.truth.state}"`);
          notes.push(`dev arm: strip on screen, ${dom.state} · ${dom.title} · ${dom.detail}`);
          return { shown: true, title: dom.title, state: dom.state };
        });
      } finally {
        try { process.kill(dev.child.pid, 'SIGTERM'); } catch {}
        await sleep(400);
        try { process.kill(dev.child.pid, 0); process.kill(dev.child.pid, 'SIGKILL'); } catch {}
      }
    }

    console.log(`\n✓ walkthrough passed — ${steps.length} steps in ${fmt(Date.now() - t0)}`);
  } catch (e) {
    console.error(`\n✗ WALKTHROUGH FAILED at step: ${e.step ?? '(setup)'}\n  ${e.message}`);
    if (pageLog.length) console.error(`\n  page console:\n${pageLog.slice(-12).map((l) => '    ' + l).join('\n')}`);
    process.exitCode = 1;
  } finally {
    const total = Date.now() - t0;
    await page.close().catch(() => {});
    // Only ever the PID this script started — never a pkill.
    try { process.kill(server.pid, 'SIGTERM'); } catch {}
    await sleep(400);
    try { process.kill(server.pid, 0); process.kill(server.pid, 'SIGKILL'); } catch {}

    console.log('\n─ steps ───────────────────────────────────────────────────────────────────');
    for (const [i, s] of steps.entries()) {
      console.log(`${String(i + 1).padStart(2)}  ${s.status === 'PASS' ? '✓' : '✗'} ${fmt(s.ms).padStart(7)}  ${s.name}`);
      if (s.error) console.log(`        → ${s.error}`);
      if (s.shot) console.log(`        ${s.shot}`);
    }
    console.log(`    total ${fmt(total)} (${steps.filter((s) => s.status === 'PASS').length}/${steps.length} passed)`);
    for (const n of notes) console.log(`    note: ${n}`);
    writeFileSync(join(OUT, 'report.json'), JSON.stringify({
      url: URL, port: PORT, at: new Date().toISOString(), totalMs: total, coldPaint, steps, notes, pageLog,
    }, null, 2));
    console.log(`    report ${join(OUT, 'report.json')}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
