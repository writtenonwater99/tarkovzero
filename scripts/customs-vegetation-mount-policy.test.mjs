// The three vegetation-mount decisions that were wrong in the running app, pinned as arithmetic.
//
// Each test here is written against the MEASURED failure it replaces, not against the new code:
//
//   * a mount whose partition was cut for the pre-load camera, then recorded the post-load camera
//     as the pose it had packed for — which told the epsilon gate the partition was current;
//   * a width-only viewport resize (700 -> 2400 px), which changes the projection while leaving the
//     camera position bit-identical, and left 2,522 of 7,108 placements frustum-rejected;
//   * a mount pinned at `pending` for minutes with nothing separating 'loading' from 'wedged'.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VEGETATION_MOUNT_ASSEMBLE_MS,
  VEGETATION_MOUNT_STALL_MS,
  VEGETATION_MOUNT_TOTAL_MS,
  VEGETATION_REPACK_EPSILON_M,
  decideVegetationRepack,
  evaluateVegetationMount,
  vegetationCameraSignature,
} from '../src/customs-vegetation-mount-policy.js';

/**
 * A perspective projection matrix in three's column-major layout, for `fovy` degrees at `aspect`.
 * Only the two terms a resize touches are populated exactly; the rest are constant across the
 * comparison and so cannot be what a passing test is reading.
 */
function projection(aspect, fovyDeg = 22, near = 0.25, far = 6000) {
  const f = 1 / Math.tan((fovyDeg * Math.PI) / 360);
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ];
}

test('a partition that has never been packed always repacks', () => {
  const decision = decideVegetationRepack({
    next: vegetationCameraSignature([0, 0, 100], projection(1.75)),
    last: null,
  });
  assert.equal(decision.repack, true);
  assert.equal(decision.reason, 'never-packed');
});

test('the mount-time repack is not suppressed by a camera that ended up where it started', () => {
  // The old mount recorded the post-load camera as the pose it had packed for. Reproduce exactly
  // that: identical signatures, which the gate reads as "nothing to do" — which is why the fix is
  // a FORCED repack at the swap, and why `last: null` above is the state that must hold until one
  // has run.
  const packed = vegetationCameraSignature([10, 20, 300], projection(1.75));
  const live = vegetationCameraSignature([10, 20, 300], projection(1.75));
  assert.equal(decideVegetationRepack({ next: live, last: packed }).repack, false);
  assert.equal(decideVegetationRepack({ next: live, last: null }).repack, true);
});

test('a width-only resize repacks even though the camera has not moved one metre', () => {
  // 700 -> 2400 px at a fixed height: `cameraPose()` derives distance from clientHeight and zoom
  // alone, so the position is bit-identical and only the projection changes.
  const position = [123.5, -400.25, 812.75];
  const before = vegetationCameraSignature(position, projection(700 / 985));
  const after = vegetationCameraSignature(position, projection(2400 / 985));
  const decision = decideVegetationRepack({ next: after, last: before });
  assert.equal(decision.repack, true);
  assert.equal(decision.reason, 'projection-changed');
  // The position gate on its own — the whole of the old test — sees nothing at all.
  assert.equal(Math.hypot(...position.map((v, i) => v - before.position[i])), 0);
});

test('a slow orbit below the epsilon does not repack, and one metre past it does', () => {
  const last = vegetationCameraSignature([0, 0, 500], projection(1.75));
  const nudge = decideVegetationRepack({
    next: vegetationCameraSignature([VEGETATION_REPACK_EPSILON_M - 0.5, 0, 500], projection(1.75)),
    last,
  });
  assert.equal(nudge.repack, false);
  assert.equal(nudge.reason, 'within-epsilon');
  const move = decideVegetationRepack({
    next: vegetationCameraSignature([VEGETATION_REPACK_EPSILON_M + 0.5, 0, 500], projection(1.75)),
    last,
  });
  assert.equal(move.repack, true);
  assert.equal(move.reason, 'camera-moved');
});

test('a fov change repacks: the frustum is read from the matrix, not from the position', () => {
  const position = [0, 0, 500];
  const decision = decideVegetationRepack({
    next: vegetationCameraSignature(position, projection(1.75, 60)),
    last: vegetationCameraSignature(position, projection(1.75, 22)),
  });
  assert.equal(decision.repack, true);
  assert.equal(decision.reason, 'projection-changed');
});

test('a mount making steady progress is loading, not expired', () => {
  const verdict = evaluateVegetationMount({
    startedMs: 0,
    nowMs: 62_000,
    lastProgressMs: 61_400,
    loaded: 71,
    expected: 93,
  });
  assert.equal(verdict.phase, 'loading');
  assert.equal(verdict.expired, false);
  assert.equal(verdict.reason, null);
  assert.equal(verdict.loaded, 71);
  assert.equal(verdict.expected, 93);
  assert.ok(Math.abs(verdict.fraction - 71 / 93) < 1e-9);
  assert.equal(verdict.elapsedMs, 62_000);
  assert.equal(verdict.sinceProgressMs, 600);
});

test('the measured 12-minute mount does not trip a deadline while files keep landing', () => {
  // 93 GLBs in 12.5 min at 4-way concurrency is a mean gap of ~8 s. Nothing in that is a stall.
  for (let loaded = 1; loaded <= 93; loaded += 1) {
    const nowMs = loaded * 8_100;
    const verdict = evaluateVegetationMount({
      startedMs: 0,
      nowMs,
      lastProgressMs: nowMs - 200,
      loaded,
      expected: 93,
    });
    assert.equal(verdict.expired, false, `expired at ${loaded}/93 (${nowMs} ms)`);
  }
});

test('a loader that stops mid-pack is reported as stalled, not as pending', () => {
  const verdict = evaluateVegetationMount({
    startedMs: 0,
    nowMs: 40_000 + VEGETATION_MOUNT_STALL_MS,
    lastProgressMs: 40_000,
    loaded: 40,
    expected: 93,
  });
  assert.equal(verdict.expired, true);
  assert.equal(verdict.reason, 'mount-load-stalled');
  assert.equal(verdict.phase, 'loading');
  assert.equal(verdict.loaded, 40);
});

test('a loader that never returns its FIRST file is caught by the same window', () => {
  const verdict = evaluateVegetationMount({
    startedMs: 0,
    nowMs: VEGETATION_MOUNT_STALL_MS,
    lastProgressMs: null,
    loaded: 0,
    expected: 93,
  });
  assert.equal(verdict.expired, true);
  assert.equal(verdict.reason, 'mount-load-stalled');
  assert.equal(verdict.fraction, 0);
});

test('with no progress yet, the stall clock runs from the MOUNT, not from the time origin', () => {
  // A live wedged-loader run reported `elapsedMs 5001` beside `sinceProgressMs 8816` and tripped an
  // 8 s stall deadline five seconds into the mount: `Number(null)` is 0, and 0 is finite, so the
  // absent `lastProgressMs` was read as "progress at time zero" — the page's time origin. On a page
  // that has been open a while, that fires the deadline the instant the mount begins.
  const startedMs = 3_800;
  const nowMs = startedMs + 5_000;
  const verdict = evaluateVegetationMount({ startedMs, nowMs, lastProgressMs: null, loaded: 0, expected: 93 });
  assert.equal(verdict.elapsedMs, 5_000);
  assert.equal(verdict.sinceProgressMs, 5_000, 'the two clocks must agree before the first GLB lands');
  assert.equal(verdict.expired, false);
});

test('an unknown expected count still gets a deadline, and withholds the fraction', () => {
  const pending = evaluateVegetationMount({ startedMs: 0, nowMs: 5_000, loaded: 0, expected: null });
  assert.equal(pending.expected, null);
  assert.equal(pending.fraction, null);
  assert.equal(pending.phase, 'loading');
  assert.equal(pending.expired, false);
  const stalled = evaluateVegetationMount({
    startedMs: 0,
    nowMs: VEGETATION_MOUNT_STALL_MS + 1,
    loaded: 0,
    expected: null,
  });
  assert.equal(stalled.expired, true);
  assert.equal(stalled.reason, 'mount-load-stalled');
});

test('assembly gets its own, longer, silent window', () => {
  const assembling = {
    startedMs: 0,
    lastProgressMs: 100_000,
    loaded: 93,
    expected: 93,
  };
  const working = evaluateVegetationMount({
    ...assembling,
    nowMs: 100_000 + VEGETATION_MOUNT_STALL_MS + 1,
  });
  // Past the LOAD stall window and still fine: merging and seating 93 packs emits no progress.
  assert.equal(working.phase, 'assembling');
  assert.equal(working.expired, false);
  assert.equal(working.fraction, 1);
  const wedged = evaluateVegetationMount({
    ...assembling,
    nowMs: 100_000 + VEGETATION_MOUNT_ASSEMBLE_MS,
  });
  assert.equal(wedged.expired, true);
  assert.equal(wedged.reason, 'mount-assembly-stalled');
});

test('a load that trickles forever without stalling still hits the total deadline', () => {
  const verdict = evaluateVegetationMount({
    startedMs: 0,
    nowMs: VEGETATION_MOUNT_TOTAL_MS,
    lastProgressMs: VEGETATION_MOUNT_TOTAL_MS - 1_000,
    loaded: 60,
    expected: 93,
  });
  assert.equal(verdict.expired, true);
  assert.equal(verdict.reason, 'mount-exceeded-total-deadline');
});

test('a settled mount never expires, whatever its clock says', () => {
  const verdict = evaluateVegetationMount({
    startedMs: 0,
    nowMs: VEGETATION_MOUNT_TOTAL_MS * 4,
    lastProgressMs: 1_000,
    loaded: 93,
    expected: 93,
    settled: true,
  });
  assert.equal(verdict.expired, false);
  assert.equal(verdict.reason, null);
  assert.equal(verdict.phase, 'settled');
});
