/**
 * A readable per-frame draw-call number, on a renderer that clears the counter behind your back.
 *
 * `WebGPURenderer` starts its own internal `Animation` loop at construction, and that loop calls
 * `info.reset()` on EVERY `requestAnimationFrame` tick whether or not anything was rendered
 * (three 0.185.1, `Animation.start()`). This app renders on demand — `animate()` returns early
 * unless something invalidated the frame — so on an idle tick `renderer.info.render.drawCalls` and
 * `.triangles` read 0 while the scene on screen is unchanged and fully drawn. Measured: 0 draw
 * calls and 0 triangles at three of seven camera poses, at the same moment the vegetation runtime
 * reported 31-49 live buckets and thousands of visible instances.
 *
 * Sampling it in the right place fixes it. `Renderer.render()` throws unless the backend is already
 * initialized, and `_renderScene()` increments `info.render.frameCalls` and every draw synchronously,
 * so the instant `renderer.render()` returns, `info.render` describes the frame that was just
 * submitted. This module latches that sample and labels its age.
 *
 * A frame that genuinely drew nothing stays distinguishable: `frameCalls >= 1` proves a render ran,
 * so a latched `drawCalls: 0` means "this frame drew nothing" and is kept as such, while a tick on
 * which no render ran latches nothing at all and leaves the previous frame's numbers standing under
 * their own age.
 */

/** The empty latch: no frame has been rendered yet, and no number is claimed. */
export const EMPTY_RENDER_FRAME_LATCH = Object.freeze({
  drawCalls: null,
  triangles: null,
  renderCalls: null,
  frameCalls: null,
  atMs: null,
  frames: 0,
});

const integer = (value) => (Number.isFinite(Number(value)) ? Math.round(Number(value)) : null);

/** Read `renderer.info` into a plain, frozen sample. Call it IMMEDIATELY after `render()`. */
export function sampleRenderFrame(info, nowMs) {
  const render = info?.render ?? null;
  return Object.freeze({
    drawCalls: integer(render?.drawCalls),
    triangles: integer(render?.triangles),
    renderCalls: integer(render?.calls),
    frameCalls: integer(render?.frameCalls),
    atMs: Number.isFinite(Number(nowMs)) ? Number(nowMs) : null,
  });
}

/**
 * Fold one sample into the latch.
 *
 * A sample whose `frameCalls` is not at least 1 is discarded: the counter was reset by the
 * renderer's own animation tick and no render of ours contributed to it, so it is not evidence of
 * anything and must never overwrite a real frame.
 */
export function latchRenderFrame(previous, sample) {
  const latch = previous ?? EMPTY_RENDER_FRAME_LATCH;
  if (!sample || !Number.isFinite(Number(sample.frameCalls)) || Number(sample.frameCalls) < 1) {
    return latch;
  }
  return Object.freeze({
    drawCalls: sample.drawCalls,
    triangles: sample.triangles,
    renderCalls: sample.renderCalls,
    frameCalls: sample.frameCalls,
    atMs: sample.atMs,
    frames: latch.frames + 1,
  });
}

/**
 * The reported shape: the latched frame, how old it is, and the live counter beside it.
 *
 * `drawCalls` is the last frame this app actually submitted — never a guess and never a maximum.
 * `source` says which frame that was, `ageMs` says how long ago, and `liveDrawCalls` keeps the raw
 * `renderer.info` value visible so the reset behaviour above stays checkable rather than hidden.
 */
export function describeRenderFrame(latch, live, nowMs) {
  const held = latch ?? EMPTY_RENDER_FRAME_LATCH;
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : null;
  return {
    drawCalls: held.drawCalls,
    triangles: held.triangles,
    renderCalls: held.renderCalls ?? integer(live?.render?.calls),
    drawCallsSource: held.atMs === null ? 'no-frame-rendered-yet' : 'last-rendered-frame',
    drawCallsAgeMs: held.atMs === null || now === null ? null : Math.max(0, Math.round(now - held.atMs)),
    renderedFrames: held.frames,
    // The counter as three leaves it: reset every animation tick, so 0 on any idle frame. Kept
    // deliberately, because a reader who compares the two learns the reason the headline number is
    // latched at all.
    liveDrawCalls: integer(live?.render?.drawCalls),
    liveTriangles: integer(live?.render?.triangles),
  };
}
