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
 * The 2D↔3D zoom offset for ONE map: `zoom2d = zoom3d + zoomOffsetFor(mapData)`.
 *
 * Both views state a scale in metres per pixel, and that is the only thing the two zoom numbers
 * have to agree about:
 *
 *   2D (Leaflet + the tarkov.dev CRS):  m/px = 1 / (|transform[0]| · 2^zoom2d)
 *   3D (deck's OrbitView):              m/px = 1 / 2^zoom3d
 *
 * so the offset is `-log2(|transform[0]|)` and nothing else — 2.065 on Customs, 1.340 on Reserve,
 * 2.431 on Woods. The old constant 2.06 was Customs' scale with the map key filed off, which put
 * every other map's mirror at the wrong scale, and it carried a `sin(tilt)` term that traded ~0.74
 * of a zoom for the foreshortened ground plane. That term was there to frame the FIRST 3D open,
 * which fitZoom() below now does properly; all it did afterwards was make the HUD's own m/px jump
 * 1.67x on Customs the moment you toggled views, and push Woods' mirrored zoom under Leaflet's
 * `minZoom: 2`, where it clamped and corrupted the camera on the way back.
 *
 * Tilt is deliberately NOT an argument: a scale is a scale at any tilt.
 */
const rad = (d) => (d * Math.PI) / 180;
export const DEFAULT_ZOOM_OFFSET = 2.06;
export function zoomOffsetFor(mapData) {
  const scale = Math.abs(Number(mapData?.transform?.[0]));
  return Number.isFinite(scale) && scale > 0 ? -Math.log2(scale) : DEFAULT_ZOOM_OFFSET;
}

/**
 * How big a `width x depth` patch of ground is ON SCREEN, in px per world unit, at a given tilt and
 * orbit. The ground is turned through `rotationOrbit` and squashed by sin(rotationX) — the same
 * mapping main.js's target3dFor() inverts — so a corner at world offset (wx, wz) lands at
 *
 *   px_right = scale·( wx·cosθ − wz·sinθ )     px_down = −scale·sin(tilt)·( wx·sinθ + wz·cosθ )
 *
 * and the extremes over the four corners are the sums of the absolute terms. Fitting a map by its
 * width alone (what a 2D `getBoundsZoom` does) ignores both of those factors, which is why a
 * near-square map like Woods used to open with its nose against the camera.
 */
export function projectedGroundExtent(width, depth, rotationX = CAM.rotationX, rotationOrbit = CAM.rotationOrbit) {
  const tilt = Math.min(CAM.maxRotationX, Math.max(CAM.minRotationX, Number(rotationX) || CAM.rotationX));
  const sin = Math.sin(rad(tilt));
  const th = rad(Number(rotationOrbit) || 0), c = Math.abs(Math.cos(th)), s = Math.abs(Math.sin(th));
  const hw = Math.abs(width) / 2, hd = Math.abs(depth) / 2;
  return { w: 2 * (hw * c + hd * s), d: 2 * sin * (hw * s + hd * c) };
}

/**
 * How far past `contain` the fit is allowed to go.
 *
 * Fit is cover, not contain: at an oblique tilt the map's footprint is a rhombus, so containing it
 * leaves big black wedges in every corner. Cover fills the frame and crops the two far corners,
 * which are void anyway. The cap only exists so a pathological viewport aspect cannot turn "cover"
 * into "stand on the map": on the three shipped maps cover sits at 1.25x (Woods — the founder's
 * reference framing), 1.29x (Reserve) and 1.67x (Customs, a 2:1 map) past contain, all under it.
 */
export const COVER_BAND = 1.75;

/**
 * The zoom that frames a `width x depth` ground rect in a `viewportWidth x viewportHeight` box.
 * Returns null when the inputs cannot produce a finite answer, so callers can keep what they had.
 */
export function fitZoom({ width, depth, viewportWidth, viewportHeight, rotationX = CAM.rotationX, rotationOrbit = CAM.rotationOrbit, coverBand = COVER_BAND }) {
  const { w, d } = projectedGroundExtent(width, depth, rotationX, rotationOrbit);
  if (!(w > 0) || !(d > 0) || !(viewportWidth > 0) || !(viewportHeight > 0)) return null;
  const sx = viewportWidth / w, sy = viewportHeight / d;
  const contain = Math.min(sx, sy), cover = Math.max(sx, sy);
  const scale = Math.min(cover, contain * Math.max(1, coverBand));
  const zoom = Math.log2(scale);
  return Number.isFinite(zoom) ? zoom : null;
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
