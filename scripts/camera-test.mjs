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
import { CAM, COVER_BAND, DEFAULT_ZOOM_OFFSET, MIN_ZOOM_MARGIN, zoomOffsetFor, projectedGroundExtent, fitZoom, minFitZoom, eyeDistance, groundFloorAngle, clampTilt, clampCamera } from '../src/camera.js';
import { MAPS } from '../src/mapdata.js';

// The founder's reference window, and the one scripts/e2e-walkthrough.mjs drives.
const STAGE = { viewportWidth: 1400, viewportHeight: 985 };
// MAPS[].bounds is tarkov.dev's [[x, z], [x, z]]; main.js's fit3dZoom() reads the same two spans off
// the Leaflet bounds (lng = x = width, lat = z = depth) and then grows the box by the safe-rect
// offset, so the app's own numbers sit a few hundredths above these.
const extentOf = (m) => {
  const [[x0, z0], [x1, z1]] = m.bounds;
  return { width: Math.abs(x1 - x0), depth: Math.abs(z1 - z0) };
};
const close = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);

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

test('fitZoom frames each shipped map at the default oblique camera', () => {
  // The numbers the fix claimed. A regression in projectedGroundExtent or COVER_BAND moves them.
  close(fitZoom({ ...extentOf(MAPS.woods), ...STAGE }), 0.0825, 5e-3, 'woods fit');
  close(fitZoom({ ...extentOf(MAPS.reserve), ...STAGE }), 1.3944, 5e-3, 'reserve fit');
  close(fitZoom({ ...extentOf(MAPS.customs), ...STAGE }), 1.0400, 5e-3, 'customs fit');
  // The pre-fix path — a 2D cover zoom minus a constant — is what these must NOT be.
  assert.ok(Math.abs(fitZoom({ ...extentOf(MAPS.woods), ...STAGE }) - 1.16) > 0.5, 'woods is back on the 2D cover zoom');
});

test('fitZoom covers the stage and stays inside the cover band', () => {
  for (const m of Object.values(MAPS)) {
    const { width, depth } = extentOf(m);
    const zoom = fitZoom({ width, depth, ...STAGE });
    const { w, d } = projectedGroundExtent(width, depth);
    const scale = Math.pow(2, zoom);
    const contain = Math.min(STAGE.viewportWidth / w, STAGE.viewportHeight / d);
    // Cover: at least one axis is filled edge to edge, and never more than COVER_BAND past contain.
    assert.ok(scale >= contain - 1e-9, `${m.key}: fit is tighter than contain`);
    assert.ok(scale <= contain * COVER_BAND + 1e-9, `${m.key}: fit is ${(scale / contain).toFixed(2)}x past contain`);
  }
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
// A low-zoom permalink (#1.4/-209/-280 on Woods) framed the diorama as a small slab in a grey void
// with the terrain mesh's underside on show. minFitZoom() is the floor that stops it.
test('minFitZoom is the contain zoom minus the margin, and it sits under every fit', () => {
  for (const m of Object.values(MAPS)) {
    const e = extentOf(m);
    const min = minFitZoom({ ...e, ...STAGE });
    const fit = fitZoom({ ...e, ...STAGE });
    assert.ok(Number.isFinite(min), `${m.key}: no min zoom`);
    // The floor is BELOW the fit — clamping must never push a fitted map closer than it was framed.
    assert.ok(min < fit, `${m.key}: min zoom ${min} is not under the cover fit ${fit}`);
    // and it is exactly contain - margin.
    const { w, d } = projectedGroundExtent(e.width, e.depth, CAM.rotationX, CAM.rotationOrbit);
    close(min, Math.log2(Math.min(STAGE.viewportWidth / w, STAGE.viewportHeight / d)) - MIN_ZOOM_MARGIN, 1e-12, `${m.key} contain`);
  }
  // Garbage in, null out — the caller keeps whatever limit it had.
  assert.equal(minFitZoom({ width: 0, depth: 0, ...STAGE }), null);
  assert.equal(minFitZoom({ width: 100, depth: 100, viewportWidth: 0, viewportHeight: 0 }), null);
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

test('the Woods #1.4 permalink comes out of clampCamera framing the whole map', () => {
  // The permalink zoom is a 2D zoom; the 3D one is zoom2d - zoomOffsetFor(woods).
  const woods = MAPS.woods;
  const zoom3d = 1.4 - zoomOffsetFor(woods);
  const stage = { ...extentOf(woods), ...STAGE };
  const floor = minFitZoom(stage);
  assert.ok(zoom3d < floor, `the QA permalink (${zoom3d.toFixed(3)}) is supposed to be under the floor (${floor.toFixed(3)})`);

  const out = clampCamera({ zoom: zoom3d, rotationX: CAM.rotationX, rotationOrbit: CAM.rotationOrbit, target: [-209, -280, 0] }, stage);
  assert.ok(out.zoom > zoom3d, `the permalink was not lifted: still at ${out.zoom}`);
  close(out.zoom, floor, 1e-12, 'the permalink lands on the floor');
  // The point of the floor: at what comes back, the map is no smaller than the frame minus the
  // margin, so there is no ring of void around the diorama for the underside to show through.
  const { w, d } = projectedGroundExtent(extentOf(woods).width, extentOf(woods).depth, CAM.rotationX, CAM.rotationOrbit);
  const scale = Math.pow(2, out.zoom);
  assert.ok(Math.max((w * scale) / STAGE.viewportWidth, (d * scale) / STAGE.viewportHeight) > 0.9,
    'the clamped framing still leaves the map floating inside the viewport');
});

test('clampCamera applies the tilt floor at the zoom it actually lands on', () => {
  // Order matters: lifting the zoom shortens the eye distance, which RAISES the tilt floor. A
  // clamp that tilts first would hand back a camera buried in the hill it just zoomed into.
  const e = extentOf(MAPS.customs);
  const stage = { ...e, ...STAGE, ground: 400, clearance: 3 };
  const floor = minFitZoom({ ...e, ...STAGE });
  const out = clampCamera({ zoom: floor - 3, rotationX: CAM.minRotationX, rotationOrbit: CAM.rotationOrbit }, stage);
  close(out.zoom, floor, 1e-12, 'zoom floor');
  close(out.rotationX, groundFloorAngle({ zoom: floor, ground: 400, viewportHeight: STAGE.viewportHeight }), 1e-12, 'tilt floor at the lifted zoom');
  assert.ok(out.rotationX > CAM.minRotationX, 'a 400 m hill under the target must lift the tilt');
});

test('the min zoom follows the tilt, because the projected footprint does', () => {
  const e = extentOf(MAPS.customs);
  // A steeper camera un-foreshortens the depth, so the map needs MORE room to fit and the floor
  // drops; a flat camera squashes the rhombus until the width is the only binding side.
  const flat = minFitZoom({ ...e, ...STAGE, rotationX: 12 });
  const steep = minFitZoom({ ...e, ...STAGE, rotationX: 80 });
  assert.ok(steep <= flat, `steep ${steep} should not sit above flat ${flat}`);
  // At the flat end the width binds, so the floor stops moving with the tilt entirely.
  const { w } = projectedGroundExtent(e.width, e.depth, 12, CAM.rotationOrbit);
  close(flat, Math.log2(STAGE.viewportWidth / w) - MIN_ZOOM_MARGIN, 1e-12, 'width-bound floor');
});
