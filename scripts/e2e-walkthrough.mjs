#!/usr/bin/env node
/**
 * TarkovZero — automated founder walkthrough (UI-REWORK red team #2).
 *
 * Codex's finding #2 asked for a 5-user click-prototype falsification test. That was declined —
 * there are no test users — and the falsifier put in its place was a founder walkthrough of one
 * chain: *find an extract → select a quest → adjust a layer → inspect a photo card → switch floor*.
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
// 4210–4299, takes the first free port in that band, and kills only the PID it started.
if (FIRST_PORT < 4210 || FIRST_PORT > 4299) {
  console.error(`✗ refusing port ${FIRST_PORT}: this harness owns 4210–4299 (4190 and 4181–4187 belong to other sessions)`);
  process.exit(2);
}
const free = (port) => new Promise((res) => {
  const s = createServer();
  s.once('error', () => res(false));
  s.once('listening', () => s.close(() => res(true)));
  s.listen(port, '127.0.0.1');
});
async function pickPort() {
  for (let p = FIRST_PORT; p <= 4299; p++) if (await free(p)) return p;
  throw new Error('no free port in 4210–4299');
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
      await page.waitFor('window.tz.renderStats()?.assets?.ready === true', { timeout: 25_000, label: 'the Stage 1 render assets' });
      const rs = await page.evaluate('window.tz.renderStats()');
      assert(rs.look === 'realistic', `the default look is "${rs.look}", expected "realistic"`);
      assert(rs.groundDetail === true, 'the realistic terrain is drawing without its ground-detail material');
      assert(rs.post.enabled && rs.post.armed, `the grade pass is not armed (${JSON.stringify(rs.post)})`);
      assert(rs.post.fxaa === false, 'FXAA is back on in a full-screen pass — it eats every label');
      assert(rs.textureBytes.groundDetail > 0 && rs.textureBytes.gradeLut > 0,
        `no asset bytes uploaded: ${JSON.stringify(rs.textureBytes)}`);
      return { view, rotationX: cam.rotationX, rotationOrbit: cam.rotationOrbit, frameMean: Number(stats.mean.toFixed(1)), blackFrameRetry: retried,
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
      const safe = await page.evaluate('window.tz.safeRect()');
      const stage = await page.evaluate(`(() => { const r = document.getElementById('stage').getBoundingClientRect(); return { w: r.width, h: r.height }; })()`);
      assert(proj && Number.isFinite(proj[0]), 'the 3D view could not project the flown-to point');
      // Guard against a vacuous test: the safe rect must actually be inset from the stage.
      assert(safe.right < stage.w - 1 || safe.bottom < stage.h - 1 || safe.top > 1,
        `safeRect ${JSON.stringify(safe)} is the whole stage — containment would be vacuous`);
      assert(inside(proj, safe), `projected target [${proj.map((n) => n.toFixed(0))}] is outside the safe rect ${JSON.stringify(safe)}`);
      return { picked: act.label, rows: rows.length, moved: Number(moved.toFixed(1)), projected: proj.map((n) => Math.round(n)), safeRect: safe };
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
      const safe = await page.evaluate('window.tz.safeRect()');
      assert(card.right - card.left > 40 && card.bottom - card.top > 40, `the card has no size: ${JSON.stringify(card)}`);
      for (const [corner, pt] of [['top-left', [card.left, card.top]], ['bottom-right', [card.right, card.bottom]]]) {
        assert(inside(pt, safe, 1), `the card's ${corner} corner [${pt.map((n) => Math.round(n))}] is outside the safe rect ${JSON.stringify(safe)}`);
      }
      return { clickedAt: hitAt, badge: p.badge, card, safeRect: safe };
    });

    /* -- 6 ------------------------------------------------------------ ']' steps a floor -- */
    await step(page, "6. ']' switches floor — #floors active cell moves", 'floor-step', async () => {
      await blur(page);
      const before = await page.evaluate(`document.querySelector('#floors .seg-cell.on')?.dataset.floor ?? null`);
      assert(before !== null, 'no active cell in #floors');
      await page.key(']');
      await sleep(700);
      const after = await page.evaluate(`document.querySelector('#floors .seg-cell.on')?.dataset.floor ?? null`);
      assert(after !== before, `the active floor cell did not move (still "${before}")`);
      const onCount = await page.evaluate(`document.querySelectorAll('#floors .seg-cell.on').length`);
      assert(onCount === 1, `${onCount} floor cells are active at once`);
      return { before, after };
    });

    /* -- 7 --------------------------------------------- Esc peels transient, keeps pinned -- */
    await step(page, '7. Esc chain — card, then the transient panel; the pinned workspace stays', 'esc-chain', async () => {
      await omni(page, '> live');                       // a transient panel, alongside pinned Quests
      await blur(page);
      await sleep(400);
      const opened = await page.evaluate(`({ live: window.tz.panel.isOpen('live'), quests: window.tz.panel.isOpen('quests'), pinned: window.tz.panel.isPinned('quests'), card: !document.getElementById('quest-card').hidden })`);
      assert(opened.live, 'the Live panel did not open');
      assert(opened.quests && opened.pinned, 'the pinned Quests workspace was closed by opening a transient panel');

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
      return { peeled, cardWasOpen: opened.card, questsStillPinned: s3.pinned };
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

    /* -- 9 ------------------------------------------- the page threw nothing along the way -- */
    // The chain above drives the real app for a couple of minutes; every uncaught exception and
    // console error it produced is already in `pageLog`. It used to be collected and then only ever
    // printed when some *other* assertion had already failed — a page throwing on every frame could
    // walk the whole chain and report PASS. This is the assertion that arms it.
    await step(page, '9. no page console errors during the walkthrough', 'console-clean', async () => {
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
      url: URL, port: PORT, at: new Date().toISOString(), totalMs: total, steps, notes, pageLog,
    }, null, 2));
    console.log(`    report ${join(OUT, 'report.json')}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
