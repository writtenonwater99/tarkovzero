/**
 * Pure policy for the authored-vegetation mount and its per-instance repack.
 *
 * Three decisions live here rather than inline in `map3d-three.js`, because each one was wrong in a
 * way that could only be seen by running the app for minutes at a time:
 *
 *   1. WHEN THE PARTITION IS STALE. The mount computed its LOD/frustum partition against the camera
 *      as it stood when the load STARTED, then recorded the post-load camera as the pose it had
 *      packed for. A measured 60-85 s mount at the default pose (and minutes after a camera move)
 *      makes "the camera moved during the load" the normal case, so the epsilon gate then suppressed
 *      the very repack that would have corrected it.
 *   2. WHAT COUNTS AS A CAMERA CHANGE. The gate compared POSITION only. An orbit camera's distance
 *      is derived from viewport HEIGHT and zoom, so widening the window 700 -> 2400 px moves the
 *      camera not at all while changing the projection completely: 2,522 of 7,108 placements stayed
 *      frustum-rejected against a frustum that no longer existed. The projection is part of the
 *      question, not a detail of it.
 *   3. WHEN A PENDING MOUNT IS ACTUALLY WEDGED. Without a deadline, `reason: 'pending'` covers both
 *      "93 GLBs are still decoding" and "this will never finish", forever, silently.
 *
 * Everything here is a pure function of numbers: no THREE objects, no clock, no scene.
 */

/** Straight-line camera motion below this cannot move a placement across a LOD seam. */
export const VEGETATION_REPACK_EPSILON_M = 4;

/**
 * Mount deadlines, in ms.
 *
 * `STALL` is the gap between two GLB completions, not the whole load: 93 files at 4-way concurrency
 * finished in 60-85 s on a warm /mnt/c route and in >12 min while competing with the authored-asset
 * streamer, which is a mean gap of ~0.9 s and ~7.7 s respectively. 90 s is an order of magnitude
 * past the slow case and still reports a wedged loader in under two minutes.
 *
 * `ASSEMBLE` covers the window after the last GLB lands, during which merging, seating and the
 * initial partition emit no progress at all. `TOTAL` is the backstop for a load that keeps trickling
 * forever without ever stalling long enough to trip `STALL`.
 */
export const VEGETATION_MOUNT_STALL_MS = 90_000;
export const VEGETATION_MOUNT_ASSEMBLE_MS = 180_000;
export const VEGETATION_MOUNT_TOTAL_MS = 25 * 60_000;

/**
 * A finite number, or the fallback.
 *
 * `Number(null)` and `Number('')` are both 0, which is a perfectly finite number and a completely
 * wrong answer here: `lastProgressMs: null` means "no GLB has landed yet", and coercing it to 0
 * measured the stall window from the page's time origin instead of from the start of the mount —
 * a live run reported `elapsedMs 5001` beside `sinceProgressMs 8816` and tripped an 8 s stall
 * deadline five seconds in. Absent is absent.
 */
const finite = (value, fallback) => {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

/**
 * Snapshot the camera state the partition depends on.
 *
 * `projection` is the raw projection matrix, copied: aspect, fov, near and far all reach the frustum
 * through it and nothing else does, so comparing it is exactly "could the visible set have changed
 * without the camera moving".
 */
export function vegetationCameraSignature(position, projectionElements) {
  return Object.freeze({
    position: Object.freeze([Number(position?.[0]), Number(position?.[1]), Number(position?.[2])]),
    projection: Object.freeze(Array.from(projectionElements ?? [], Number)),
  });
}

function projectionDiffers(previous, next) {
  const left = previous ?? [];
  const right = next ?? [];
  if (left.length !== right.length) return true;
  for (let index = 0; index < left.length; index += 1) {
    if (!Object.is(left[index], right[index])) return true;
  }
  return false;
}

/**
 * Decide whether the authored vegetation must be re-partitioned for `next`.
 *
 * @param {object} options
 * @param {object} options.next      Signature of the live camera, from `vegetationCameraSignature`.
 * @param {object|null} options.last Signature the current partition was built for, or null.
 * @param {number} [options.epsilonMeters]
 * @returns {{repack: boolean, reason: string, movedMeters: number|null}}
 */
export function decideVegetationRepack({ next, last = null, epsilonMeters = VEGETATION_REPACK_EPSILON_M } = {}) {
  if (!next) return { repack: false, reason: 'no-camera', movedMeters: null };
  if (!last) return { repack: true, reason: 'never-packed', movedMeters: null };
  // The projection is checked FIRST and without an epsilon: a viewport resize changes it by an
  // amount that has no metre-scale equivalent, so there is nothing to compare against a threshold.
  if (projectionDiffers(last.projection, next.projection)) {
    return { repack: true, reason: 'projection-changed', movedMeters: null };
  }
  const movedMeters = Math.hypot(
    next.position[0] - last.position[0],
    next.position[1] - last.position[1],
    next.position[2] - last.position[2],
  );
  if (!Number.isFinite(movedMeters)) return { repack: true, reason: 'camera-unreadable', movedMeters: null };
  if (movedMeters >= finite(epsilonMeters, VEGETATION_REPACK_EPSILON_M)) {
    return { repack: true, reason: 'camera-moved', movedMeters };
  }
  return { repack: false, reason: 'within-epsilon', movedMeters };
}

/**
 * Describe a mount in flight, and say whether it has missed a deadline.
 *
 * `phase` is derived, not asserted: a mount that has loaded every GLB it expects is assembling even
 * if nobody told this function so. `expected` may be null (the count is only known once the router
 * has run) — the stall and total deadlines still apply, only the fraction is withheld.
 *
 * @returns {{phase: string, loaded: number, expected: number|null, fraction: number|null,
 *   elapsedMs: number, sinceProgressMs: number, expired: boolean, reason: string|null,
 *   deadlines: {stallMs: number, assembleMs: number, totalMs: number}}}
 */
export function evaluateVegetationMount({
  nowMs,
  startedMs,
  lastProgressMs = null,
  loaded = 0,
  expected = null,
  settled = false,
  stallMs = VEGETATION_MOUNT_STALL_MS,
  assembleMs = VEGETATION_MOUNT_ASSEMBLE_MS,
  totalMs = VEGETATION_MOUNT_TOTAL_MS,
} = {}) {
  const now = finite(nowMs, 0);
  const started = finite(startedMs, now);
  const loadedCount = Math.max(0, Math.trunc(finite(loaded, 0)));
  const expectedCount = Number.isFinite(Number(expected)) && Number(expected) > 0
    ? Math.trunc(Number(expected))
    : null;
  const deadlines = Object.freeze({
    stallMs: finite(stallMs, VEGETATION_MOUNT_STALL_MS),
    assembleMs: finite(assembleMs, VEGETATION_MOUNT_ASSEMBLE_MS),
    totalMs: finite(totalMs, VEGETATION_MOUNT_TOTAL_MS),
  });
  const elapsedMs = Math.max(0, now - started);
  // Before the first GLB completes, "since progress" is measured from the start of the mount, so a
  // loader that never returns its FIRST file is caught by the same window as one that dies at 92.
  const sinceProgressMs = Math.max(0, now - finite(lastProgressMs, started));
  const phase = settled
    ? 'settled'
    : (expectedCount !== null && loadedCount >= expectedCount ? 'assembling' : 'loading');
  const fraction = expectedCount === null ? null : Math.min(1, loadedCount / expectedCount);
  const base = {
    phase,
    loaded: loadedCount,
    expected: expectedCount,
    fraction,
    elapsedMs,
    sinceProgressMs,
    deadlines,
  };
  if (settled) return { ...base, expired: false, reason: null };
  if (elapsedMs >= deadlines.totalMs) {
    return { ...base, expired: true, reason: 'mount-exceeded-total-deadline' };
  }
  const window = phase === 'assembling' ? deadlines.assembleMs : deadlines.stallMs;
  if (sinceProgressMs >= window) {
    return {
      ...base,
      expired: true,
      reason: phase === 'assembling' ? 'mount-assembly-stalled' : 'mount-load-stalled',
    };
  }
  return { ...base, expired: false, reason: null };
}
