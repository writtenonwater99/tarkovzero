/**
 * src/camera.js — the 3D framing maths, pinned.
 *
 * This module is pure exported arithmetic with no DOM and no GL, and it decides the founder-visible
 * thing: where the diorama sits when 3D opens, and whether a 3D→2D→3D round trip comes back to the
 * same camera. It shipped with no test at all, so the numbers in the commit message that fixed the
 * framing (Woods 1.160 → 0.085) were prose. They are assertions now.
 *
 *   node --test scripts/camera-test.mjs        # or: npm run test:camera
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { OrbitView } from '@deck.gl/core';
import { CAM, COVER_BAND, DEFAULT_ZOOM_OFFSET, MIN_ZOOM_MARGIN, zoomOffsetFor, projectedGroundExtent, groundOffsetPx, fitZoom, minFitZoom, eyeDistance, groundFloorAngle, clampTilt, clampCamera, setFitBox, getFitBox } from '../src/camera.js';
import { MAPS } from '../src/mapdata.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// The founder's reference window, and the one scripts/e2e-walkthrough.mjs drives.
const STAGE = { viewportWidth: 1400, viewportHeight: 985 };
// MAPS[].bounds is tarkov.dev's [[x, z], [x, z]]; main.js's fit3dZoom() reads the same two spans off
// the Leaflet bounds (lng = x = width, lat = z = depth) and then measures them against the SAFE rect,
// which is smaller than the stage, so the app's own numbers sit a little under these.
const extentOf = (m) => {
  const [[x0, z0], [x1, z1]] = m.bounds;
  return { width: Math.abs(x1 - x0), depth: Math.abs(z1 - z0) };
};
/**
 * The fit box main.js frames: the map bounds unioned with every extract/transit position grown by
 * the 40 m marker margin. This mirrors `updateFootprint()` — main.js imports Leaflet and cannot be
 * loaded here, so the rule is restated against the same shipped data the app reads.
 */
const MARKER_MARGIN = 40;
function footprintOf(m) {
  const [[x0, z0], [x1, z1]] = m.bounds;
  const b = { x0: Math.min(x0, x1), x1: Math.max(x0, x1), z0: Math.min(z0, z1), z1: Math.max(z0, z1) };
  const data = JSON.parse(readFileSync(join(ROOT, 'public', 'data', `${m.key}.json`), 'utf8'));
  for (const e of data.extracts ?? []) {
    const { x, z } = e.position ?? {};
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    b.x0 = Math.min(b.x0, x - MARKER_MARGIN); b.x1 = Math.max(b.x1, x + MARKER_MARGIN);
    b.z0 = Math.min(b.z0, z - MARKER_MARGIN); b.z1 = Math.max(b.z1, z + MARKER_MARGIN);
  }
  return { ...extentOf(m), fitWidth: b.x1 - b.x0, fitDepth: b.z1 - b.z0, box: b };
}
const close = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);

/* ---------------------------------------------------------- the real camera -- */
/**
 * The app's own camera, in Node. `OrbitViewport` is pure @math.gl arithmetic — no GL, no DOM — so
 * the projection the browser applies is importable here, and every containment claim below is made
 * against IT rather than against camera.js's own model.
 *
 * That distinction is the whole reason this block exists. The test this replaces computed the
 * on-screen footprint from `projectedGroundExtent()`, the same function `fitZoom()` chooses the zoom
 * with, and then asserted the fraction was 1.0 — true by algebra for any zoom fitZoom could return,
 * for any map, aspect or tilt. Sixteen green camera tests coexisted with a default Woods framing
 * that ran real terrain off the left edge of the window.
 *
 * `dy` is a height in world units: the ground plane is y = 0 and the app's world point for a game
 * coordinate is `[-x, -z, y]` (src/map3d.js's `P`).
 */
const CANVAS = { width: 1400, height: 985 };
function project({ dx, dz, dy = 0 }, { zoom, rotationX = CAM.rotationX, rotationOrbit = CAM.rotationOrbit, width, height }) {
  const view = new OrbitView({ orbitAxis: 'Z', fovy: CAM.fovy });
  const vp = view.makeViewport({ width, height, viewState: { target: [0, 0, 0], zoom, rotationX, rotationOrbit } });
  const p = vp.project([-dx, -dz, dy]);
  // offsets from the projection centre, plus deck's depth: > 1 is behind the far plane, which is
  // where a point the eye has closed past ends up.
  return { px: p[0] - width / 2, py: p[1] - height / 2, depth: p[2] };
}
/** The four corners of a `width x depth` ground box centred on the camera target. */
const cornersOf = (width, depth) => [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([sx, sz]) => ({ dx: (sx * width) / 2, dz: (sz * depth) / 2 }));
/**
 * How far the worst corner of the fit box sits past the box we asked to frame it in, measured
 * through deck. <= 1 is contained; 1.08 means 8% of a half-frame of map is off screen.
 */
function containment({ fitWidth, fitDepth, viewportWidth, viewportHeight, containerHeight = viewportHeight }, zoom, rotationX, rotationOrbit) {
  let worst = 0;
  for (const c of cornersOf(fitWidth, fitDepth)) {
    const { px, py, depth } = project(c, { zoom, rotationX, rotationOrbit, width: CANVAS.width, height: containerHeight });
    if (!(depth <= 1)) return Infinity;   // a corner the eye has closed past is not "contained"
    worst = Math.max(worst, Math.abs(px) / (viewportWidth / 2), Math.abs(py) / (viewportHeight / 2));
  }
  return worst;
}

test('zoomOffsetFor is the map CRS scale, not a constant tuned on Customs', () => {
  // zoom2d = zoom3d + offset must hold the metres-per-pixel identity in both views:
  //   2D: 1 / (|transform[0]| * 2^zoom2d)      3D: 1 / 2^zoom3d
  for (const m of Object.values(MAPS)) {
    close(zoomOffsetFor(m), -Math.log2(Math.abs(m.transform[0])), 1e-12, `${m.key} offset`);
    for (const zoom3d of [-2, 0, 1.086, 5]) {
      const mpp3d = 1 / Math.pow(2, zoom3d);
      const mpp2d = 1 / (Math.abs(m.transform[0]) * Math.pow(2, zoom3d + zoomOffsetFor(m)));
      close(mpp2d, mpp3d, 1e-9, `${m.key} m/px at zoom3d ${zoom3d}`);
    }
  }
  close(zoomOffsetFor(MAPS.customs), 2.0651, 1e-3, 'customs');
  close(zoomOffsetFor(MAPS.reserve), 1.3402, 1e-3, 'reserve');
  close(zoomOffsetFor(MAPS.woods), 2.4306, 1e-3, 'woods');
  // No transform (or a broken one) falls back to the historical constant instead of NaN.
  assert.equal(zoomOffsetFor(undefined), DEFAULT_ZOOM_OFFSET);
  assert.equal(zoomOffsetFor({ transform: [0] }), DEFAULT_ZOOM_OFFSET);
});

test('the mirrored 2D zoom of a 3D fit is reachable on every map', () => {
  // The clamp this guards: Woods' fit used to mirror to 1.41 against `minZoom: 2`, Leaflet kept 2,
  // and the next 2D→3D hand-over read that clamped number back as a 1.5x closer camera.
  for (const m of Object.values(MAPS)) {
    const zoom = fitZoom({ ...extentOf(m), ...STAGE });
    const mirrored = zoom + zoomOffsetFor(m);
    assert.ok(mirrored >= m.minZoom && mirrored <= m.maxZoom + 1,
      `${m.key}: fit ${zoom.toFixed(4)} mirrors to ${mirrored.toFixed(4)}, outside Leaflet's [${m.minZoom}, ${m.maxZoom + 1}]`);
  }
});

test('groundOffsetPx is deck OrbitViewport.project(), not an approximation of it', () => {
  // camera.js may not import deck.gl (main.js seeds the view state without it), so the projection
  // is restated there. This is the assertion that the restatement is exact — every framing claim
  // below rests on it.
  for (const zoom of [-2, -0.5, 0, 1.3, 3]) {
    for (const [rotationX, rotationOrbit] of [[32, -20], [9, 0], [50, 75], [89, -160]]) {
      for (const [dx, dz, dy] of [[0, 0, 0], [700, -900, 0], [-500, 300, 40], [120, 240, -30]]) {
        for (const height of [800, 985, 1440]) {
          const mine = groundOffsetPx({ dx, dz, dy, zoom, rotationX, rotationOrbit, containerHeight: height });
          const real = project({ dx, dz, dy }, { zoom, rotationX, rotationOrbit, width: CANVAS.width, height });
          const what = `zoom ${zoom} tilt ${rotationX} orbit ${rotationOrbit} at ${dx},${dz},${dy} in ${height}px`;
          if (mine === null) {   // the point is behind the eye; deck agrees by putting it past the far plane
            assert.ok(real.depth > 1, `${what}: null for a point deck projects in front (depth ${real.depth})`);
            continue;
          }
          close(mine[0], real.px, 1e-9, `${what}: px`);
          close(mine[1], real.py, 1e-9, `${what}: py`);
        }
      }
    }
  }
});

test('fitZoom frames each shipped map at the default oblique camera', () => {
  // The numbers the fix claimed. A regression in the projection or COVER_BAND moves them.
  close(fitZoom({ ...extentOf(MAPS.woods), ...STAGE }), -0.4940, 5e-3, 'woods fit');
  close(fitZoom({ ...extentOf(MAPS.reserve), ...STAGE }), 0.7881, 5e-3, 'reserve fit');
  close(fitZoom({ ...extentOf(MAPS.customs), ...STAGE }), 0.1920, 5e-3, 'customs fit');
  // The pre-fix path — a 2D cover zoom minus a constant — is what these must NOT be.
  assert.ok(Math.abs(fitZoom({ ...extentOf(MAPS.woods), ...STAGE }) - 1.16) > 0.5, 'woods is back on the 2D cover zoom');
});

test('fitZoom contains the whole footprint IN DECK, and never exceeds the cover band', () => {
  for (const m of Object.values(MAPS)) {
    const box = footprintOf(m);
    const zoom = fitZoom({ ...box, ...STAGE });
    const scale = Math.pow(2, zoom);
    // Contain, measured through the app's own camera: no corner of the fit box is off the frame
    // (QA H1/H5). Under the affine model this held by construction; under the perspective camera
    // the near corner used to hang 4–8% of a half-frame past the edge, which on Woods is real
    // terrain running off the left of the window.
    const seen = containment({ ...box, ...STAGE }, zoom, CAM.rotationX, CAM.rotationOrbit);
    assert.ok(seen <= 1 + 1e-9, `${m.key}: the worst footprint corner sits ${((seen - 1) * 100).toFixed(1)}% of a half-frame outside the window`);
    // and the frame is FILLED — a contain fit is the largest scale that fits, not merely a small
    // one. (A fit that just zoomed out would pass the line above and be useless.)
    assert.ok(seen > 0.999, `${m.key}: the fit leaves the map floating (worst corner at ${(seen * 100).toFixed(1)}% of the half-frame)`);
    // The band is still the ceiling: the fit may never sit more than COVER_BAND past the terrain's
    // own contain, whatever box it was handed.
    const terrain = projectedGroundExtent(box.width, box.depth);
    const containTerrain = Math.min(STAGE.viewportWidth / terrain.w, STAGE.viewportHeight / terrain.d);
    assert.ok(scale <= containTerrain * COVER_BAND + 1e-9, `${m.key}: fit is ${(scale / containTerrain).toFixed(2)}x past contain`);
  }
});

test('the perspective fit is TIGHTER than the affine one it replaced, and only near the edges', () => {
  // Guards the direction of the correction: the affine model under-frames, so the honest fit must
  // sit at or below it — and by a real amount on the maps the defect was filed against.
  for (const m of Object.values(MAPS)) {
    const box = { ...footprintOf(m), ...STAGE };
    const { w, d } = projectedGroundExtent(box.fitWidth, box.fitDepth);
    const affine = Math.log2(Math.min(STAGE.viewportWidth / w, STAGE.viewportHeight / d));
    const real = fitZoom(box);
    assert.ok(real <= affine + 1e-9, `${m.key}: the perspective fit (${real.toFixed(4)}) is looser than the affine one (${affine.toFixed(4)})`);
    // At the affine zoom the corner really is outside — i.e. the correction is not cosmetic.
    assert.ok(containment(box, affine, CAM.rotationX, CAM.rotationOrbit) > 1.01,
      `${m.key}: the affine fit already contained the map; this correction has no defect to fix`);
  }
});

test('the fit contains the map inside the SAFE RECT, not merely inside the canvas', () => {
  // The app frames the safe rect (the stage minus the top chip band and the omnibox band) inside a
  // TALLER canvas, and the perspective term belongs to the canvas — it is about how close the eye
  // stands, and that is set by the surface deck renders onto, not by the sub-rect we chose to fill.
  // The rect is the stage's FULL WIDTH: panels float over the map and are not a fit inset (QA H4).
  const SAFE = { viewportWidth: 1400, viewportHeight: 867, containerHeight: 985 };
  for (const m of Object.values(MAPS)) {
    const box = { ...footprintOf(m), ...SAFE };
    const zoom = fitZoom(box);
    const seen = containment(box, zoom, CAM.rotationX, CAM.rotationOrbit);
    assert.ok(seen <= 1 + 1e-9, `${m.key}: ${((seen - 1) * 100).toFixed(1)}% of a half-frame of map is outside the safe rect`);
    assert.ok(seen > 0.999, `${m.key}: the safe-rect fit leaves the map floating (${(seen * 100).toFixed(1)}%)`);
    // Getting it wrong in the safe direction still costs framing: assuming the canvas is only as
    // tall as the safe rect over-states how close the eye stands, so the fit comes back needlessly
    // wide. It must never come back TIGHTER than the honest one, which would be a crop.
    const naive = fitZoom({ ...box, containerHeight: SAFE.viewportHeight });
    assert.ok(naive <= zoom + 1e-9, `${m.key}: the safe-rect-as-canvas fit (${naive.toFixed(4)}) is closer in than the honest one (${zoom.toFixed(4)})`);
  }
});

/* ------------------------------------------------------------------ QA H1 -- */
// The default framing zoomed IN as the window grew and sliced the map off both sides: cover is
// `max(sx, sy)`, so it followed whichever axis the viewport had to spare (measured on Customs:
// 1.086 at 1400x985 -> 1.328 at 1920x1165, both edges clipped, top and bottom fifths empty fog).
// The invariant that forbids it: a window that gets wider can never show LESS of the map.
test('a wider window never shows less map', () => {
  const VIEWPORTS = [[1200, 800], [1400, 985], [1920, 1165], [2560, 1440]];
  for (const m of Object.values(MAPS)) {
    const box = footprintOf(m);
    let prevMetres = 0, prevW = 0;
    for (const [viewportWidth, viewportHeight] of VIEWPORTS) {
      const stage = { ...box, viewportWidth, viewportHeight };
      const zoom = fitZoom(stage);
      // Every corner inside the frame, measured through deck — at EVERY aspect, which is what the
      // cover fit this replaced could not do (Customs: 1.086 at 1400x985 -> 1.328 at 1920x1165,
      // both edges clipped, top and bottom fifths empty fog).
      const seen = containment(stage, zoom, CAM.rotationX, CAM.rotationOrbit);
      assert.ok(seen <= 1 + 1e-9,
        `${m.key} at ${viewportWidth}x${viewportHeight}: ${((seen - 1) * 100).toFixed(1)}% of a half-frame of map is off screen`);
      // "Never shows less map" with the whole map already on screen has to be about SIZE: the map
      // may not get smaller in metres-on-screen terms as the window grows.
      const metres = Math.pow(2, zoom);   // px per game metre at the target
      assert.ok(metres >= prevMetres - 1e-9,
        `${m.key}: ${viewportWidth}x${viewportHeight} draws the map at ${metres.toFixed(4)} px/m, down from ${prevMetres.toFixed(4)} at ${prevW}px wide`);
      prevMetres = metres; prevW = viewportWidth;
    }
  }
});

/* ------------------------------------------------------------------ QA H2 -- */
// The 2D first visit owes the player the whole map, and Leaflet clamps `setView` to its own
// `minZoom` without saying so. Woods' contain zoom is 1.69: against the old floor of 2 the fit
// silently did nothing and the first frame of the biggest shipped map had its north and south rims
// cut off. main.js's containZoom() is Leaflet arithmetic and cannot be imported here, so the rule
// is restated against the same shipped numbers: m/px = 1 / (|transform[0]| * 2^zoom2d).
test('every map can reach its own 2D contain fit — the Leaflet zoom floor is under it', () => {
  // The fit rect's inset from the stage at the reference window. The width inset is ZERO by
  // construction: only the chip band and the omnibox band are fit insets, and both span the stage.
  const CHROME = { w: 0, h: 118 };
  for (const [viewportWidth, viewportHeight] of [[1200, 800], [1400, 985], [1920, 1165]]) {
    for (const m of Object.values(MAPS)) {
      const box = footprintOf(m);
      const t = Math.abs(m.transform[0]);
      const zoom2d = Math.log2(Math.min((viewportWidth - CHROME.w) / (t * box.fitWidth), (viewportHeight - CHROME.h) / (t * box.fitDepth)));
      assert.ok(zoom2d >= m.minZoom,
        `${m.key} at ${viewportWidth}x${viewportHeight}: the contain fit is ${zoom2d.toFixed(3)}, under Leaflet's minZoom ${m.minZoom} — it will clamp and crop`);
      assert.ok(m.minNativeZoom >= m.minZoom,
        `${m.key}: minZoom ${m.minZoom} is under minNativeZoom ${m.minNativeZoom} with no upscaling range declared`);
    }
  }
});

/* ------------------------------------------------------------------ QA H5 -- */
test('the fit contains the extract furniture, not just the terrain', () => {
  // Woods' extracts sit ON the rim: framing the bounds alone cut "RAILWAY BRIDGE TO TARKOV" off the
  // right edge and two extract badges off the bottom. The footprint is what the fit has to hold.
  const woods = footprintOf(MAPS.woods);
  assert.ok(woods.fitWidth > woods.width && woods.fitDepth > woods.depth,
    `woods furniture is inside its bounds (${woods.fitWidth} x ${woods.fitDepth} vs ${woods.width} x ${woods.depth})`);
  const withFurniture = fitZoom({ ...woods, ...STAGE });
  const terrainOnly = fitZoom({ ...extentOf(MAPS.woods), ...STAGE });
  assert.ok(withFurniture < terrainOnly, 'the furniture did not pull the fit out at all');
  // Every extract, plus its 40 m of margin, is inside the frame at the fit — through deck.
  assert.ok(containment({ ...woods, ...STAGE }, withFurniture, CAM.rotationX, CAM.rotationOrbit) <= 1 + 1e-9,
    'the furniture is still clipped');
});

test('fitZoom returns null rather than a NaN camera on degenerate input', () => {
  assert.equal(fitZoom({ width: 0, depth: 0, ...STAGE }), null);
  assert.equal(fitZoom({ width: 100, depth: 100, viewportWidth: 0, viewportHeight: 985 }), null);
  assert.equal(fitZoom({ width: NaN, depth: NaN, ...STAGE }), null);
});

test('projectedGroundExtent turns and foreshortens the ground plane', () => {
  // Straight down (the tilt ceiling) and head-on: the footprint is its own box.
  const flat = projectedGroundExtent(1000, 400, CAM.maxRotationX, 0);
  close(flat.w, 1000, 1e-9, 'width at the tilt ceiling');
  close(flat.d, 400 * Math.sin((CAM.maxRotationX * Math.PI) / 180), 1e-9, 'depth at the tilt ceiling');
  // Dropping the camera squashes depth by sin(tilt) and leaves width alone.
  const oblique = projectedGroundExtent(1000, 400, 30, 0);
  close(oblique.w, 1000, 1e-9, 'width at tilt 30');
  close(oblique.d, 400 * Math.sin(Math.PI / 6), 1e-9, 'depth at tilt 30');
  // A square turned 45° presents its diagonal.
  const turned = projectedGroundExtent(100, 100, 90, 45);
  close(turned.w, 100 * Math.SQRT2, 1e-9, 'width at orbit 45');
  // A near-square map at the shipped defaults is WIDER projected than it is in plan — which is the
  // whole reason fitting it by its plan width put Woods' nose against the camera.
  const woods = projectedGroundExtent(1407, 1356, CAM.rotationX, CAM.rotationOrbit);
  assert.ok(woods.w > 1407, `projected width ${woods.w} should exceed the plan width`);
  assert.ok(woods.d < 1356, `projected depth ${woods.d} should be foreshortened`);
});

test('eyeDistance and the ground floor keep the eye above the map', () => {
  // Zooming out one step doubles the standoff.
  close(eyeDistance(1, 985) / eyeDistance(2, 985), 2, 1e-9, 'standoff per zoom step');
  // Flat ground under the target: no reason to lift the camera.
  assert.equal(groundFloorAngle({ zoom: 0, ground: 0, targetZ: 0, viewportHeight: 985 }), CAM.minRotationX);
  // A hill taller than the standoff pins the tilt at straight down rather than returning NaN.
  assert.equal(groundFloorAngle({ zoom: 6, ground: 5000, viewportHeight: 985 }), 90);
  // Between those, the floor is the angle whose sine is (clearance needed / standoff).
  const floor = groundFloorAngle({ zoom: 1, ground: 200, targetZ: 0, viewportHeight: 985, clearance: 3 });
  close(Math.sin((floor * Math.PI) / 180) * eyeDistance(1, 985), 203, 1e-6, 'floor clears the ground');
});

test('clampTilt never returns a camera under the horizon or past straight down', () => {
  assert.equal(clampTilt({ rotationX: -10 }).rotationX, CAM.minRotationX);
  assert.equal(clampTilt({ rotationX: 140 }).rotationX, CAM.maxRotationX);
  assert.equal(clampTilt({ rotationX: 40 }, 55).rotationX, 55);
  // Untouched states are returned by identity, so deck does not see a new object every frame.
  const v = { rotationX: 32, zoom: 1 };
  assert.equal(clampTilt(v), v);
});

/* ------------------------------------------------------------------ QA D2 -- */
// A low-zoom permalink framed the diorama as a small slab in a grey void with the terrain mesh's
// underside on show. minFitZoom() is the floor that stops it — a band under the fit, not a wall
// against it (QA H4).
test('minFitZoom is the fit minus the margin, on whatever box the fit framed', () => {
  for (const m of Object.values(MAPS)) {
    const box = footprintOf(m);
    const min = minFitZoom({ ...box, ...STAGE });
    const fit = fitZoom({ ...box, ...STAGE });
    assert.ok(Number.isFinite(min), `${m.key}: no min zoom`);
    // The floor is BELOW the fit — clamping must never push a fitted map closer than it was framed.
    assert.ok(min < fit, `${m.key}: min zoom ${min} is not under the fit ${fit}`);
    // and it is exactly the fit minus the margin, so the two can never drift apart.
    close(min, fit - MIN_ZOOM_MARGIN, 1e-12, `${m.key} floor`);
    // The margin is a band a permalink is honoured inside: 0.6 of a zoom level, not 0.12.
    assert.ok(MIN_ZOOM_MARGIN >= 0.6, `the permalink band shrank to ${MIN_ZOOM_MARGIN}`);
  }
  // Garbage in, null out — the caller keeps whatever limit it had.
  assert.equal(minFitZoom({ width: 0, depth: 0, ...STAGE }), null);
  assert.equal(minFitZoom({ width: 100, depth: 100, viewportWidth: 0, viewportHeight: 0 }), null);
});

/* ------------------------------------------------------------------ QA H4 -- */
// map3d.js owns the clamp but knows neither the safe rect nor the marker furniture, so it used to
// measure its own floor off the terrain ring in the full container. That floor could sit ABOVE the
// default framing, i.e. "clamping" a permalink to a camera CLOSER than the app's own fit. main.js
// registers the box it framed; the floor is then the fit minus the margin by construction.
test('the registered fit box is the box the floor is measured from', () => {
  const woods = footprintOf(MAPS.woods);
  const safe = { viewportWidth: 1400, viewportHeight: 867 };   // a stage minus the chip band and the omnibox
  try {
    setFitBox({ ...woods, ...safe });
    assert.deepEqual(getFitBox(), { width: woods.width, depth: woods.depth, fitWidth: woods.fitWidth, fitDepth: woods.fitDepth, ...safe, containerHeight: safe.viewportHeight });
    const fit = fitZoom({ ...woods, ...safe });
    // clampCamera is handed map3d's OWN box (the terrain ring in the full container) and must ignore
    // it in favour of the registered one.
    const out = clampCamera({ zoom: fit - 5, rotationX: CAM.rotationX, rotationOrbit: CAM.rotationOrbit },
      { ...extentOf(MAPS.woods), ...STAGE });
    close(out.zoom, fit - MIN_ZOOM_MARGIN, 1e-12, 'the floor follows the registered fit box');
    assert.ok(out.zoom < fit, 'the floor is above the fit it was registered from');
  } finally { setFitBox(null); }
  assert.equal(getFitBox(), null);
});

/*
 * The floor above is a pure function; these cases drive `clampCamera`, which is the function
 * src/map3d.js's `clampView` IS — every drag, wheel, key, permalink and programmatic move in the
 * 3D view is one call to it. The first version of this feature shipped `minFitZoom` with no call
 * site at all and a green suite, because the suite only ever exercised the arithmetic.
 */
test('clampCamera lifts a below-floor camera and leaves every other one alone', () => {
  const e = extentOf(MAPS.customs);
  const stage = { ...e, ...STAGE };
  const floor = minFitZoom(stage);

  // Under the floor: the zoom comes back AT the floor, and nothing else moves.
  const low = clampCamera({ zoom: floor - 2, rotationX: 32, rotationOrbit: -20, target: [10, 20, 0] }, stage);
  close(low.zoom, floor, 1e-12, 'a below-floor zoom is lifted to the floor');
  assert.equal(low.rotationX, 32);
  assert.equal(low.rotationOrbit, -20);
  assert.deepEqual(low.target, [10, 20, 0]);

  // At or above it: untouched, and returned by identity so deck does not see a new object a frame.
  const ok = { zoom: floor + 0.5, rotationX: 32, rotationOrbit: -20 };
  assert.equal(clampCamera(ok, stage), ok);
  assert.equal(clampCamera({ ...ok, zoom: floor }, stage).zoom, floor);

  // With no extent there is no floor to apply, and this is exactly clampTilt.
  const noExtent = { zoom: -8, rotationX: 32 };
  assert.equal(clampCamera(noExtent, { viewportHeight: 985 }), noExtent);
});

test('the Woods #1.4 permalink is honoured verbatim, and a far wilder one still lands on the floor', () => {
  // The permalink zoom is a 2D zoom; the 3D one is zoom2d - zoomOffsetFor(woods).
  const woods = MAPS.woods;
  const zoom3d = 1.4 - zoomOffsetFor(woods);
  const box = { ...footprintOf(woods), viewportWidth: 1400, viewportHeight: 867 };
  try {
    setFitBox(box);
    const fit = fitZoom(box), floor = minFitZoom(box);
    assert.ok(zoom3d < fit, 'the QA permalink is supposed to be wider than the default framing');
    assert.ok(zoom3d >= floor, `#1.4 (${zoom3d.toFixed(3)}) is under the floor (${floor.toFixed(3)}) — it will still be rewritten`);

    const view = { zoom: zoom3d, rotationX: CAM.rotationX, rotationOrbit: CAM.rotationOrbit, target: [-209, -280, 0] };
    const out = clampCamera(view, { ...extentOf(woods), ...STAGE });
    // Untouched, and returned by identity: nothing moved, so main.js writes no new hash and the
    // sender's address bar keeps the link they pasted.
    assert.equal(out, view, `the permalink was clamped to ${out.zoom}`);

    // A permalink genuinely out in the void still stops at the floor.
    const wild = clampCamera({ ...view, zoom: floor - 2 }, { ...extentOf(woods), ...STAGE });
    close(wild.zoom, floor, 1e-12, 'a wild permalink lands on the floor');
    // At the floor the map still all but fills the frame — no ring of void for the underside to
    // show through, which is what the floor is for. Measured through deck, like the fit.
    const seen = containment(box, wild.zoom, CAM.rotationX, CAM.rotationOrbit);
    assert.ok(seen > 0.6, `the clamped framing leaves the map floating in the viewport (worst corner at ${(seen * 100).toFixed(0)}% of the half-frame)`);
  } finally { setFitBox(null); }
});

test('clampCamera applies the tilt floor at the zoom it actually lands on', () => {
  // Order matters: lifting the zoom shortens the eye distance, which RAISES the tilt floor. A
  // clamp that tilts first would hand back a camera buried in the hill it just zoomed into.
  // (The hill has to be a big one now: the floor is a contain fit minus 0.6, so the eye stands
  // ~3.3 km off Customs there and a 400 m hill no longer reaches the 9° horizon floor.)
  const e = extentOf(MAPS.customs);
  const GROUND = 900;
  const stage = { ...e, ...STAGE, ground: GROUND, clearance: 3 };
  // The floor is measured at the camera's OWN tilt (the projected footprint is a function of it),
  // so the expected number is the floor at the tilt this view state carries, not at the default.
  const floor = minFitZoom({ ...e, ...STAGE, rotationX: CAM.minRotationX });
  const out = clampCamera({ zoom: floor - 3, rotationX: CAM.minRotationX, rotationOrbit: CAM.rotationOrbit }, stage);
  close(out.zoom, floor, 1e-12, 'zoom floor');
  close(out.rotationX, groundFloorAngle({ zoom: floor, ground: GROUND, viewportHeight: STAGE.viewportHeight }), 1e-12, 'tilt floor at the lifted zoom');
  assert.ok(out.rotationX > CAM.minRotationX, `a ${GROUND} m hill under the target must lift the tilt`);
});

test('the min zoom follows the tilt, because the projected footprint does', () => {
  const e = extentOf(MAPS.customs);
  // A steeper camera un-foreshortens the depth, so the map needs MORE room to fit and the floor
  // drops; a flat camera squashes the rhombus until the width is the only binding side.
  const flat = minFitZoom({ ...e, ...STAGE, rotationX: 12 });
  const steep = minFitZoom({ ...e, ...STAGE, rotationX: 80 });
  assert.ok(steep <= flat, `steep ${steep} should not sit above flat ${flat}`);
  // At the flat end the WIDTH binds, so the affine answer is `log2(viewportWidth / w) - margin`.
  // The real floor sits a little under it — the near corner of a flat rhombus is the closest thing
  // in the frame to the eye, so perspective magnifies it most — but not by a zoom level.
  const { w } = projectedGroundExtent(e.width, e.depth, 12, CAM.rotationOrbit);
  const affine = Math.log2(STAGE.viewportWidth / w) - MIN_ZOOM_MARGIN;
  assert.ok(flat <= affine + 1e-9, `the flat floor ${flat} is above the affine width-bound answer ${affine}`);
  assert.ok(flat > affine - 0.25, `the flat floor ${flat} is a long way under the affine width-bound answer ${affine}`);
});
