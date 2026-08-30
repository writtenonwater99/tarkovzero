/**
 * 3D camera framing (founder, 2026-08-29).
 *
 * Two rules, and both are about the same thing — the map has to read as a place you stand in:
 *
 *  1. The default is **oblique**, not top-down. A 50–62° tilt is a floor plan with shadows; at 32°
 *     with the orbit swung 20° off-axis the buildings have sides and the terrain has relief.
 *  2. The eye **never goes under the map**. Right-drag tilt is clamped to `minRotationX` above the
 *     ground plane, and when the camera is close enough that the horizon plane would still put the
 *     eye inside a hill, the floor rises to clear the terrain under the orbit target.
 *
 * Kept in its own module so main.js can seed the view state without importing deck.gl.
 */
export const CAM = {
  rotationX: 32,        // degrees above the ground plane at load / fit / N
  rotationOrbit: -20,   // a touch off-axis, so the diorama has a near corner
  minRotationX: 9,      // hard floor: at or below the horizon you are looking up from underground
  maxRotationX: 89,     // 90 is straight down and degenerate for OrbitView
  fovy: 22,
};

/**
 * The 2D↔3D zoom offset, as a function of tilt.
 *
 * The ground plane foreshortens as the camera drops — at 32° it covers ~60% of the screen height
 * it covered at 62° — so a fixed offset would frame the oblique view as a small island in a lot of
 * void. Folding sin(tilt) into the mapping keeps the map covering the viewport at any angle, and
 * keeps 2D→3D→2D round-trips at the same scale because both directions use this one function.
 * 62° was the old fixed tilt, so it still returns the historical 2.06.
 */
const rad = (d) => (d * Math.PI) / 180;
export function zoomOffset(rotationX = CAM.rotationX) {
  const tilt = Math.min(CAM.maxRotationX, Math.max(CAM.minRotationX, Number(rotationX) || CAM.rotationX));
  return 2.06 - Math.log2(Math.sin(rad(62)) / Math.sin(rad(tilt)));
}

/** deck's OrbitView eye distance in world units for a zoom and a viewport height in px. */
export function eyeDistance(zoom, viewportHeight, fovy = CAM.fovy) {
  const scale = Math.pow(2, Number(zoom) || 0);
  const t = Math.tan((fovy / 2) * Math.PI / 180);
  const d = (viewportHeight / 2) / (scale * t);
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/**
 * The lowest tilt that still keeps the eye `clearance` metres above the ground under the target.
 * `ground` and the target's own height are world units (already relief-scaled).
 */
export function groundFloorAngle({ zoom, ground = 0, targetZ = 0, viewportHeight = 800, clearance = 3 }) {
  const need = ground - targetZ + clearance;
  if (!(need > 0)) return CAM.minRotationX;
  const d = eyeDistance(zoom, viewportHeight);
  if (!d) return CAM.minRotationX;
  const angle = (Math.asin(Math.min(1, need / d)) * 180) / Math.PI;
  return Math.max(CAM.minRotationX, angle);
}

/** Clamp one view state's tilt. Everything else is passed through untouched. */
export function clampTilt(viewState, floor = CAM.minRotationX) {
  const min = Math.min(CAM.maxRotationX, Math.max(CAM.minRotationX, floor));
  const rotationX = Math.min(CAM.maxRotationX, Math.max(min, viewState.rotationX ?? CAM.rotationX));
  return rotationX === viewState.rotationX ? viewState : { ...viewState, rotationX };
}
