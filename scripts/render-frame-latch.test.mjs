// The draw-call number the founder reads, pinned against the renderer that clears it behind him.
//
// The failure this replaces was measured live: `renderStats().drawCalls` read 0 — with triangles 0
// beside it — at three of seven camera poses, while the vegetation runtime simultaneously reported
// 31-49 live buckets and thousands of visible instances. The cause is in three 0.185.1's
// `Animation.start()`: `if (this.info.autoReset === true) this.info.reset();` runs on EVERY
// requestAnimationFrame tick, and this app renders on demand, so most ticks reset a counter nothing
// then writes to.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EMPTY_RENDER_FRAME_LATCH,
  describeRenderFrame,
  latchRenderFrame,
  sampleRenderFrame,
} from '../src/render-frame-latch.js';

/** A stand-in for `renderer.info` with three's own field names and reset semantics. */
function fakeInfo() {
  const info = {
    render: { calls: 0, frameCalls: 0, drawCalls: 0, triangles: 0, points: 0, lines: 0 },
    /** Exactly what the renderer's animation loop does on every tick. */
    reset() {
      info.render.frameCalls = 0;
      info.render.drawCalls = 0;
      info.render.triangles = 0;
    },
    /** Exactly what one `render()` of `drawCalls` draw calls does. */
    submit(drawCalls, triangles) {
      info.render.calls += 1;
      info.render.frameCalls += 1;
      info.render.drawCalls += drawCalls;
      info.render.triangles += triangles;
    },
  };
  return info;
}

test('reading info on an idle tick reports 0 — the defect, reproduced', () => {
  const info = fakeInfo();
  info.reset();
  info.submit(31, 480_000);
  assert.equal(info.render.drawCalls, 31);
  info.reset();                       // the next animation tick, on which nothing rendered
  assert.equal(info.render.drawCalls, 0);
  assert.equal(info.render.triangles, 0);
});

test('the latch holds the last frame actually submitted across idle ticks', () => {
  const info = fakeInfo();
  let latch = EMPTY_RENDER_FRAME_LATCH;
  info.reset();
  info.submit(31, 480_000);
  latch = latchRenderFrame(latch, sampleRenderFrame(info, 1_000));
  assert.equal(latch.drawCalls, 31);

  for (let tick = 1; tick <= 5; tick += 1) {
    info.reset();
    latch = latchRenderFrame(latch, sampleRenderFrame(info, 1_000 + tick * 16));
  }
  assert.equal(latch.drawCalls, 31, 'five idle ticks must not overwrite the last real frame');
  assert.equal(latch.triangles, 480_000);
  assert.equal(latch.frames, 1);

  const reported = describeRenderFrame(latch, info, 1_500);
  assert.equal(reported.drawCalls, 31);
  assert.equal(reported.drawCallsSource, 'last-rendered-frame');
  assert.equal(reported.drawCallsAgeMs, 500);
  // The raw counter is still 0 — kept visible on purpose, so the two numbers can be compared.
  assert.equal(reported.liveDrawCalls, 0);
});

test('a frame that genuinely drew nothing stays 0 and is not confused with an idle tick', () => {
  const info = fakeInfo();
  let latch = EMPTY_RENDER_FRAME_LATCH;
  info.reset();
  info.submit(57, 900_000);
  latch = latchRenderFrame(latch, sampleRenderFrame(info, 100));
  assert.equal(latch.drawCalls, 57);

  // A real render of an empty scene: frameCalls is 1, drawCalls is 0. That IS the frame's number.
  info.reset();
  info.submit(0, 0);
  latch = latchRenderFrame(latch, sampleRenderFrame(info, 200));
  assert.equal(latch.drawCalls, 0);
  assert.equal(latch.frames, 2);
  assert.equal(describeRenderFrame(latch, info, 200).drawCallsSource, 'last-rendered-frame');
});

test('before the first frame nothing is claimed at all', () => {
  const info = fakeInfo();
  const reported = describeRenderFrame(EMPTY_RENDER_FRAME_LATCH, info, 42);
  assert.equal(reported.drawCalls, null);
  assert.equal(reported.triangles, null);
  assert.equal(reported.drawCallsSource, 'no-frame-rendered-yet');
  assert.equal(reported.drawCallsAgeMs, null);
  assert.equal(reported.renderedFrames, 0);
});

test('the latch is immutable and never mutates what it was handed', () => {
  const info = fakeInfo();
  info.submit(12, 1_000);
  const first = latchRenderFrame(EMPTY_RENDER_FRAME_LATCH, sampleRenderFrame(info, 10));
  info.reset();
  info.submit(13, 2_000);
  const second = latchRenderFrame(first, sampleRenderFrame(info, 20));
  assert.equal(first.drawCalls, 12);
  assert.equal(second.drawCalls, 13);
  assert.equal(Object.isFrozen(second), true);
  assert.notEqual(first, second);
});
