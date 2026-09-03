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
let URL = `${HEADFUL_URL}/?map=customs`;

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

/** Focus the omnibox, type a query, and (optionally) commit it with Enter. */
async function omni(page, text, { commit = true, settle = 260 } = {}) {
  await page.evaluate(`(() => { const f = document.getElementById('find'); f.value = ''; f.dispatchEvent(new Event('input')); f.focus(); })()`);
  await page.type(text);
  await sleep(settle);
  if (commit) { await page.key('Enter'); await sleep(settle); }
}

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
  URL = `${HEADFUL_URL}/?map=customs`;
  const server = await serve();
  console.log(`· serving dist on ${HEADFUL_URL} (pid ${server.pid})`);

  const page = await launch({
    width: 1400, height: 985,
    onConsole: (e) => { if (e.type === 'error' || e.type === 'exception') pageLog.push(`[${e.type}] ${e.text}`); },
  });

  const t0 = Date.now();
  try {
    /* -- 1 ------------------------------------------------- default view is the diorama -- */
    await step(page, "1. load default → 3D diorama, oblique camera, render assets armed", 'load-3d', async () => {
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

      /* (b) ------------------------------------- the same prose, now WITH the action -- */
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
      assert(b.buttons.length === 2 && /Switch to Woods/.test(b.buttons[0]),
        `buttons do not match the envelope's actions: ${JSON.stringify(b.buttons)}`);
      assert(b.figures === 2, `expected the envelope's two photos, got ${b.figures}`);
      assert(b.imgs.every((i) => i.lazy === 'lazy' && i.ref === 'no-referrer' && i.alt),
        `an image shipped without lazy/no-referrer/alt: ${JSON.stringify(b.imgs)}`);
      assert(/EFT Wiki/.test(b.credit), 'the wiki credit is missing from the photo strip');
      // Offering the switch is not taking it: the page must still be on Customs.
      assert(await page.evaluate('window.tz.map') === 'customs', 'a switchMap button performed itself');

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
      const geo = await page.evaluate(`(() => {
        const s = document.getElementById('stage').getBoundingClientRect();
        const p = document.getElementById('panel-ask').getBoundingClientRect();
        return {
          stage: { w: s.width, h: s.height },
          panel: { left: p.left - s.left, right: p.right - s.left, top: p.top - s.top, bottom: p.bottom - s.top, w: p.width, h: p.height },
          avoid: window.tz.avoidRect(), fit: window.tz.safeRect(),
        };
      })()`);
      assert(geo.panel.w > 200 && geo.panel.h > 120, `the panel has no box: ${JSON.stringify(geo.panel)}`);
      assert(geo.panel.left < geo.stage.w * 0.25 && geo.panel.top < geo.stage.h * 0.35,
        `the panel is not in the upper-left: ${JSON.stringify(geo.panel)} of ${JSON.stringify(geo.stage)}`);
      // avoidRect() owns everything reader-facing (label seating, the quest card, fly-to
      // recentring). If it does not start to the RIGHT of this panel, the map believes labels are
      // visible underneath the conversation.
      assert(geo.avoid.left >= geo.panel.right - 1,
        `avoidRect starts at ${geo.avoid.left} but the panel reaches ${geo.panel.right} — labels would be seated behind it`);
      // …and it is NOT an inset on the fit: panels float, they never shrink the map (QA H4).
      assert(geo.fit.left <= 1, `the assistant panel took ${geo.fit.left}px off the FIT rect`);

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

    /* -- 10 ------------------------------------------ the page threw nothing along the way -- */
    // The chain above drives the real app for a couple of minutes; every uncaught exception and
    // console error it produced is already in `pageLog`. It used to be collected and then only ever
    // printed when some *other* assertion had already failed — a page throwing on every frame could
    // walk the whole chain and report PASS. This is the assertion that arms it.
    await step(page, '10. no page console errors during the walkthrough', 'console-clean', async () => {
      // Deduped: one broken frame can log the same line hundreds of times.
      const seen = [...new Set(pageLog)];
      assert(seen.length === 0, `${pageLog.length} console error(s) during the run:\n    ${seen.slice(0, 8).join('\n    ')}`);
      return { errors: 0 };
    });

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
