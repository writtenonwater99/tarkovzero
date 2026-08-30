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
 * Where a ground point lands on screen — the camera the app ACTUALLY has.
 *
 * `projectedGroundExtent` above models the ground as an affine map: a turn by `rotationOrbit` and a
 * `sin(rotationX)` squash. deck's OrbitView is a PERSPECTIVE camera (`CAM.fovy`), so the near half
 * of the tilted rhombus projects further from the centre than the affine model says, and the error
 * grows with how much of the frame the map fills — i.e. it grows with the window, which is exactly
 * the shape of the defect the contain fit was supposed to end (QA H1). Fitting against the affine
 * model therefore under-frames on the near side: on Woods the map's own bounds corner sat 55 px off
 * the left edge at 1400x985 and 119 px off at 2560x1440, with real terrain on it.
 *
 * This is deck's own arithmetic, restated. OrbitViewport builds
 *   `viewMatrix = lookAt(eye=[0,-f,0], up=[0,0,1]) · Rx(rotationX) · Rz(rotationOrbit) · scale(2^zoom/H)`
 * with `f = fovyToAltitude(fovy) = 0.5 / tan(fovy/2)`, then a standard perspective divide. Carrying
 * a ground offset `(dx, dz)` (game metres, the world point is `[-x, -z, y]`) through it gives
 *
 *   px = k·a / (1 + ε·b)      py = −k·c / (1 + ε·b)      k = 2^zoom,  ε = k / (f · H)
 *
 * where `a`, `b`, `c` are the offset turned by the orbit and tilted, and `H` is the height of the
 * DECK CANVAS — not of whatever sub-rect we are framing into, because ε is about how close the eye
 * stands, and that is set by the canvas. `ε → 0` is the affine model, which is why the old one is
 * right at the centre of the frame and wrong at its corners.
 *
 * Verified against a real `OrbitViewport.project()` in scripts/camera-test.mjs — to within 1e-9 px.
 */
export function groundOffsetPx({ dx = 0, dz = 0, dy = 0, zoom = 0, rotationX = CAM.rotationX, rotationOrbit = CAM.rotationOrbit, fovy = CAM.fovy, containerHeight = 800 }) {
  const th = rad(Number(rotationOrbit) || 0), ph = rad(Number(rotationX) || 0);
  // world = [-x, -z, y]: the sign flip is irrelevant to a symmetric box, but this function is also
  // used to project one named corner, so it has to be the app's mapping and not a convenience.
  const wx = -dx, wy = -dz, wz = dy;
  const ux = wx * Math.cos(th) - wy * Math.sin(th);
  const uy = wx * Math.sin(th) + wy * Math.cos(th);
  const a = ux;
  const b = uy * Math.cos(ph) - wz * Math.sin(ph);
  const c = uy * Math.sin(ph) + wz * Math.cos(ph);
  const k = Math.pow(2, Number(zoom) || 0);
  const f = 0.5 / Math.tan(rad(fovy) / 2);
  const w = 1 + (k * b) / (f * Math.max(1, containerHeight));
  if (!(w > 0)) return null;   // behind the eye — there is no screen point
  return [(k * a) / w, -(k * c) / w];
}

/**
 * The largest scale at which every corner of a `width x depth` ground rect, centred on the camera
 * target, is still inside a `viewportWidth x viewportHeight` box — under the perspective camera.
 *
 * Monotone in scale (closing in can only push a corner further out, on both sides of the rhombus),
 * so a bisection between "nothing" and the affine answer — which is always an over-estimate — lands
 * on it. 60 halvings takes a 1e18 bracket to floating-point noise; the loop is ~2 µs.
 */
function containScale({ width, depth, viewportWidth, viewportHeight, rotationX, rotationOrbit, fovy, containerHeight }) {
  const hw = Math.abs(width) / 2, hd = Math.abs(depth) / 2;
  const corners = [[hw, hd], [hw, -hd], [-hw, hd], [-hw, -hd]];
  // How far past the box the worst corner sits, as a ratio. <= 1 is contained.
  const overflow = (scale) => {
    const zoom = Math.log2(scale);
    let worst = 0;
    for (const [dx, dz] of corners) {
      const p = groundOffsetPx({ dx, dz, zoom, rotationX, rotationOrbit, fovy, containerHeight });
      if (!p) return Infinity;
      worst = Math.max(worst, Math.abs(p[0]) / (viewportWidth / 2), Math.abs(p[1]) / (viewportHeight / 2));
    }
    return worst;
  };
  const { w, d } = projectedGroundExtent(width, depth, rotationX, rotationOrbit);
  if (!(w > 0) || !(d > 0)) return null;
  let hi = Math.min(viewportWidth / w, viewportHeight / d);   // the affine fit: never too small
  if (!(hi > 0) || !Number.isFinite(hi)) return null;
  if (overflow(hi) <= 1) return hi;                            // no perspective correction needed
  let lo = 0;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (overflow(mid) > 1) hi = mid; else lo = mid;
  }
  return lo > 0 ? lo : null;
}

/**
 * How far past `contain` a fit is allowed to go — the ceiling on cover, never the target.
 *
 * The fit used to BE cover: at an oblique tilt the map's footprint is a rhombus, so containing it
 * leaves black wedges in the corners, and cover fills the frame by cropping the two far ones. What
 * that ignores is that cover is `max(sx, sy)` — it grows with whichever axis the viewport has to
 * spare. On a 2:1 map like Customs the binding axis is the height, so a TALLER window zoomed the
 * camera IN and sliced the map off both sides (QA H1: 1.086 at 1400x985 -> 1.328 at 1920x1165, with
 * the top and bottom fifths of the frame empty fog). A window that grows must never show less map.
 *
 * So the fit contains the FIT BOX (`fitWidth x fitDepth` — the playable footprint plus the marker
 * furniture that hangs off its rim, see main.js) and cover may only lift it back toward the frame
 * while the fit box is SMALLER than the terrain box, and then by no more than this band.
 */
export const COVER_BAND = 1.75;

/**
 * The zoom that frames a ground rect in a `viewportWidth x viewportHeight` box.
 *
 * Two rects, because they answer different questions:
 *   `width x depth`         the terrain box — what cover would like to fill;
 *   `fitWidth x fitDepth`   the fit box — what MUST be inside the frame (defaults to the terrain box).
 *
 * The answer is the smallest of: cover of the terrain, `COVER_BAND` past its contain, and contain of
 * the fit box. With the footprints main.js ships today the fit box always holds the terrain box, so
 * the third term binds at every aspect and the fit is a contain fit — which is the H1 fix. The other
 * two stay live for a caller that frames a fit box tighter than the terrain (the wedges are void, so
 * cropping them is free); the band is what stops that turning into "stand on the map".
 *
 * The binding term — contain of the fit box — is solved against the PERSPECTIVE camera (see
 * `groundOffsetPx`), so "contained" means contained in the frame deck actually draws. The other two
 * are ceilings on a fit, not the fit, and stay on the cheap affine extent.
 *
 * `containerHeight` is the deck canvas' height; `viewportWidth/Height` is the box being framed
 * inside it (main.js frames the SAFE rect, which is smaller). They differ by the chrome, and the
 * perspective term needs the canvas — pass it, or the eye is assumed to stand where the smaller box
 * would put it.
 *
 * Returns null when the inputs cannot produce a finite answer, so callers can keep what they had.
 */
export function fitZoom({ width, depth, fitWidth = width, fitDepth = depth, viewportWidth, viewportHeight, containerHeight = viewportHeight, rotationX = CAM.rotationX, rotationOrbit = CAM.rotationOrbit, fovy = CAM.fovy, coverBand = COVER_BAND }) {
  const { w, d } = projectedGroundExtent(width, depth, rotationX, rotationOrbit);
  const fit = projectedGroundExtent(fitWidth, fitDepth, rotationX, rotationOrbit);
  if (!(w > 0) || !(d > 0) || !(fit.w > 0) || !(fit.d > 0) || !(viewportWidth > 0) || !(viewportHeight > 0)) return null;
  const sx = viewportWidth / w, sy = viewportHeight / d;
  const contain = Math.min(sx, sy), cover = Math.max(sx, sy);
  const containFit = containScale({
    width: fitWidth, depth: fitDepth, viewportWidth, viewportHeight,
    rotationX, rotationOrbit, fovy, containerHeight: containerHeight > 0 ? containerHeight : viewportHeight,
  });
  if (containFit == null) return null;
  const scale = Math.min(cover, contain * Math.max(1, coverBand), containFit);
  const zoom = Math.log2(scale);
  return Number.isFinite(zoom) ? zoom : null;
}

/**
 * How far below the FIT the camera is allowed to zoom out — the floor under every zoom.
 *
 * Below the floor the diorama is a small slab in the void with the terrain mesh's underside and
 * skirt on show, which is the one framing the renderer was never built for. But the floor is also
 * the thing a pasted permalink lands on, and 0.12 of a zoom level of headroom made it a wall: Woods'
 * `#1.4/-209/-280` came back as `#1.95` AND rewrote the sender's address bar (QA H4). 0.6 is the
 * band a permalink is honoured verbatim inside — a little air around the map, well short of the
 * zoom level where the underside appears — and only under it does the clamp fire.
 */
export const MIN_ZOOM_MARGIN = 0.6;
/**
 * The floor: the fit minus the margin. Same inputs as fitZoom(), so the two cannot drift apart —
 * whatever box the fit frames is the box the floor is measured from. Null on unusable input.
 */
export function minFitZoom({ margin = MIN_ZOOM_MARGIN, ...box }) {
  const fit = fitZoom(box);
  if (fit == null) return null;
  const zoom = fit - margin;
  return Number.isFinite(zoom) ? zoom : null;
}

/**
 * The fit box the FLOOR is measured from, registered by whoever computed the fit.
 *
 * main.js owns the framing: it knows the safe rect (the part of the stage nothing floats over) and
 * the marker furniture that hangs off the map's rim, and map3d.js — the only caller of clampCamera —
 * knows neither. When the two computed their own boxes the floor could sit ABOVE the fit, so a
 * permalink "clamped" to a camera CLOSER than the default framing. Registering the box makes the
 * floor exactly `fit - MIN_ZOOM_MARGIN` by construction. Pass null to go back to the caller's box.
 */
let FIT_BOX = null;
export function setFitBox(box) {
  const ok = box && box.width > 0 && box.depth > 0 && box.viewportWidth > 0 && box.viewportHeight > 0;
  FIT_BOX = ok ? {
    width: box.width, depth: box.depth, fitWidth: box.fitWidth, fitDepth: box.fitDepth,
    viewportWidth: box.viewportWidth, viewportHeight: box.viewportHeight,
    // The canvas the perspective term is measured against — see fitZoom(). Defaulted rather than
    // required, so a caller that does not know the canvas still registers a usable box.
    containerHeight: box.containerHeight > 0 ? box.containerHeight : box.viewportHeight,
  } : null;
}
export const getFitBox = () => (FIT_BOX ? { ...FIT_BOX } : null);

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

/**
 * THE clamp. Every camera move in the 3D view goes through this one function — the controller's
 * drags and wheel via `onViewStateChange`, and every programmatic move via the view's `setView`.
 *
 * It composes the module's two floors in the order they depend on each other:
 *
 *  1. the ZOOM floor (`minFitZoom`), which needs the tilt, because the projected footprint the map
 *     has to fit inside is a rhombus whose depth is `sin(tilt)`;
 *  2. the TILT floor (`groundFloorAngle`), which needs the zoom, because the eye distance it
 *     measures its clearance against is a function of it.
 *
 * Zoom first, then tilt: lifting the zoom SHORTENS the eye distance, so the tilt floor computed
 * after the lift is the one that actually holds. Doing it the other way round lets a below-floor
 * permalink pick its tilt floor at an eye distance the camera never ends up at.
 *
 * `extent` is the ground rect being framed (`{width, depth}` in game metres) — or, better, nothing
 * at all once main.js has registered the real fit box with setFitBox(), which is the same box the
 * default framing uses. Pass neither and the zoom floor is skipped and this is exactly `clampTilt`,
 * which is what a caller with no map loaded wants.
 */
export function clampCamera(viewState, {
  width, depth, viewportWidth, viewportHeight = 800, containerHeight = viewportHeight, ground = 0, clearance = 3,
} = {}) {
  const floor = minFitZoom({
    ...(FIT_BOX ?? { width, depth, viewportWidth, viewportHeight, containerHeight }),
    rotationX: viewState.rotationX ?? CAM.rotationX,
    rotationOrbit: viewState.rotationOrbit ?? CAM.rotationOrbit,
  });
  const zoom = viewState.zoom ?? 0;
  const lifted = floor != null && zoom < floor ? { ...viewState, zoom: floor } : viewState;
  return clampTilt(lifted, groundFloorAngle({
    zoom: lifted.zoom ?? 0,
    ground,
    targetZ: lifted.target?.[2] ?? 0,
    viewportHeight,
    clearance,
  }));
}
