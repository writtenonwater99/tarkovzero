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
import { CAM, COVER_BAND, DEFAULT_ZOOM_OFFSET, zoomOffsetFor, projectedGroundExtent, fitZoom, eyeDistance, groundFloorAngle, clampTilt } from '../src/camera.js';
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
