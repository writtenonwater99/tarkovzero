/**
 * The FLOATING panel's geometry — `avoidInset()` and `clampPanelBox()` in src/shell.js.
 *
 * Founder, 2026-09-02: "keep the side active, able it to be moved around and pinned, and make it
 * bit taller to fit more convo. and ability to minimize. it can also start small."
 *
 * A panel that can be dragged anywhere breaks the one assumption `avoidRect()` was built on. It
 * used to inset the LEFT edge unconditionally, because the panel was nailed to the upper-left
 * corner. Drag it to the right of the map and that rule keeps handing the label seating pass, the
 * 3D quest card and every fly-to a rect that says the right-hand third of the screen is visible
 * while a conversation is sitting on it — a metric that cannot fail, which is exactly the failure
 * mode docs/CONTINUATION-HANDOFF-2026-09-02.md §6 is about.
 *
 * So the rule became a function of the panel's real box, and the function is pure and lives here.
 * Every assertion below is written so that reverting to "always inset the left edge" turns it red.
 *
 *   node --test scripts/shell-panel-test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { avoidInset, clampPanelBox, PANEL_BOX, PANEL_MIN, PANEL_HEAD } from '../src/shell.js';

/** The e2e window, and the rect avoidRect() has already taken the toolbar and chip band out of. */
const STAGE = { width: 1400, height: 985 };
const RECT = { left: 0, top: 68, right: 1340, bottom: 975 };

/** A panel box in stage coordinates, the way `boxOf()` hands it over. */
const box = (x, y, w, h) => ({ left: x, top: y, right: x + w, bottom: y + h });
const covers = (rect, b) =>
  !(b.right <= rect.left || b.left >= rect.right || b.bottom <= rect.top || b.top >= rect.bottom);
const area = (r) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);

/* ========================================================================== *
 *  1. The rect never contains the panel — wherever the panel is.
 * ========================================================================== */

test('a panel is subtracted from the reader’s rect from EVERY position it can be dragged to', () => {
  const w = PANEL_BOX.w, h = PANEL_BOX.h;
  const spots = [];
  for (let x = 8; x <= STAGE.width - w - 8; x += 61) {
    for (let y = 8; y <= STAGE.height - h - 8; y += 47) spots.push([x, y]);
  }
  assert.ok(spots.length > 100, `the sweep is too small to mean anything (${spots.length} positions)`);
  for (const [x, y] of spots) {
    const b = box(x, y, w, h);
    const out = avoidInset(RECT, b, STAGE);
    assert.equal(covers(out, b), false,
      `at [${x},${y}] the panel is still inside avoidRect ${JSON.stringify(out)} — labels would be seated behind it`);
  }
});

test('a minimised handle is subtracted too, and so is a panel resized to the minimum', () => {
  for (const [w, h] of [[PANEL_BOX.w, PANEL_HEAD], [PANEL_MIN.w, PANEL_MIN.h], [900, 700]]) {
    for (const [x, y] of [[8, 8], [8, 58], [STAGE.width - w - 8, 58], [420, 300], [8, STAGE.height - h - 8]]) {
      const b = box(x, y, w, h);
      assert.equal(covers(avoidInset(RECT, b, STAGE), b), false,
        `a ${w}x${h} panel at [${x},${y}] survived inside the rect`);
    }
  }
});

/* ========================================================================== *
 *  2. Which edge moves — and why it is not always the left one.
 * ========================================================================== */

test('the shipped default still insets the LEFT edge, exactly as the hard-coded rule did', () => {
  // The regression guard on the generalisation: the upper-left corner is where the founder drew
  // the panel and where it opens, so the common case must not have changed shape.
  const b = box(PANEL_BOX.x, PANEL_BOX.y, PANEL_BOX.w, PANEL_BOX.h);
  const out = avoidInset(RECT, b, STAGE);
  assert.equal(out.left, b.right + 10, `the default position no longer insets the left edge: ${JSON.stringify(out)}`);
  assert.equal(out.right, RECT.right);
  assert.equal(out.top, RECT.top);
  assert.equal(out.bottom, RECT.bottom);
});

test('dragged to the right half it insets the RIGHT edge — never the left', () => {
  const b = box(940, 120, 360, 430);
  const out = avoidInset(RECT, b, STAGE);
  assert.equal(out.right, b.left - 10, `expected a right inset, got ${JSON.stringify(out)}`);
  assert.equal(out.left, RECT.left,
    'the left edge moved for a panel on the RIGHT of the map — that is the hard-coded rule, still hard-coded');
});

test('dragged low it insets the BOTTOM edge, dragged high the TOP one', () => {
  const low = avoidInset(RECT, box(430, 520, 360, 430), STAGE);
  assert.equal(low.bottom, 520 - 10, `expected a bottom inset, got ${JSON.stringify(low)}`);
  const high = avoidInset(RECT, box(430, 60, 900, 200), STAGE);
  assert.equal(high.top, 260 + 10, `expected a top inset, got ${JSON.stringify(high)}`);
});

test('a minimised panel in the corner gives the width back and takes a strip instead', () => {
  // The point of the area half of the rule. Collapsed, the panel is 32 px tall: insetting 372 px
  // of width for it would cost the map a quarter of the window to hide a title bar.
  const full = avoidInset(RECT, box(12, 58, 360, 430), STAGE);
  const mini = avoidInset(RECT, box(12, 58, 360, PANEL_HEAD), STAGE);
  assert.equal(mini.left, RECT.left, `a collapsed panel still took the left column: ${JSON.stringify(mini)}`);
  assert.equal(mini.top, 58 + PANEL_HEAD + 10);
  assert.ok(area(mini) > area(full),
    `minimising made the reader's rect smaller (${area(mini)} vs ${area(full)})`);
});

test('a panel that does not overlap the rect costs nothing at all', () => {
  // It sits entirely inside the chip band the rect already excludes.
  assert.deepEqual(avoidInset(RECT, box(12, 0, 360, 40), STAGE), RECT);
});

test('the chosen edge is always the one that leaves the most map, among the two nearest sides', () => {
  // The property, restated independently of the implementation: for every position, the answer is
  // at least as large as the OTHER axis's candidate would have been.
  for (const [x, y, w, h] of [[12, 58, 360, 430], [12, 58, 360, 32], [940, 120, 360, 430],
    [430, 520, 360, 430], [430, 60, 900, 200], [500, 300, 360, 430]]) {
    const b = box(x, y, w, h);
    const out = avoidInset(RECT, b, STAGE);
    const nearLeft = b.left <= STAGE.width - b.right;
    const nearTop = b.top <= STAGE.height - b.bottom;
    const other = out.left !== RECT.left || out.right !== RECT.right
      ? (nearTop ? { ...RECT, top: b.bottom + 10 } : { ...RECT, bottom: b.top - 10 })
      : (nearLeft ? { ...RECT, left: b.right + 10 } : { ...RECT, right: b.left - 10 });
    assert.ok(area(out) >= area(other),
      `at [${x},${y},${w}x${h}] the inset kept ${area(out)} px² when the other axis kept ${area(other)}`);
  }
});

/* ========================================================================== *
 *  3. clampPanelBox: a remembered size must stay usable in a smaller window.
 * ========================================================================== */

test('a remembered box is pulled back on screen when the window shrinks under it', () => {
  const small = { width: 600, height: 420 };
  const out = clampPanelBox({ x: 1200, y: 900, w: 360, h: 430 }, small);
  assert.ok(out.x >= 8 && out.x + out.w <= small.width - 8 + 1e-9,
    `the panel is off the right edge: ${JSON.stringify(out)} in ${JSON.stringify(small)}`);
  assert.ok(out.y >= 8 && out.y + out.h <= small.height - 8 + 1e-9,
    `the panel is off the bottom edge: ${JSON.stringify(out)} in ${JSON.stringify(small)}`);
});

test('it never shrinks below a usable conversation, and never grows past the stage', () => {
  const tiny = clampPanelBox({ x: 0, y: 0, w: 40, h: 40 }, STAGE);
  assert.equal(tiny.w, PANEL_MIN.w);
  assert.equal(tiny.h, PANEL_MIN.h);
  const huge = clampPanelBox({ x: 0, y: 0, w: 9000, h: 9000 }, STAGE);
  assert.ok(huge.w <= STAGE.width && huge.h <= STAGE.height,
    `a dragged-open panel escaped the stage: ${JSON.stringify(huge)}`);
});

test('a MINIMISED panel may sit lower than an expanded one — it is only a title bar tall', () => {
  const y = STAGE.height - PANEL_HEAD - 8;
  assert.equal(clampPanelBox({ x: 12, y, w: 360, h: 430, min: true }, STAGE).y, y);
  // …and expanding it there pulls it back up, rather than leaving 430 px off the bottom.
  const open = clampPanelBox({ x: 12, y, w: 360, h: 430, min: false }, STAGE);
  assert.ok(open.y + open.h <= STAGE.height - 8, `expanding left the panel off-screen: ${JSON.stringify(open)}`);
});

test('garbage in the store degrades to the shipped default instead of NaN geometry', () => {
  for (const bad of [{}, { x: 'left', y: null, w: undefined, h: NaN }, { x: Infinity, y: -Infinity }]) {
    const out = clampPanelBox(bad, STAGE);
    for (const k of ['x', 'y', 'w', 'h']) assert.ok(Number.isFinite(out[k]), `${k} is ${out[k]} for ${JSON.stringify(bad)}`);
    assert.ok(out.w >= PANEL_MIN.w && out.h >= PANEL_MIN.h);
  }
});

test('the default box starts SMALL — under half the reference window in both axes', () => {
  // "it can also start small": the panel it replaced stretched the full height of its column.
  assert.ok(PANEL_BOX.w < STAGE.width * 0.3, `the default is ${PANEL_BOX.w}px wide`);
  assert.ok(PANEL_BOX.h < STAGE.height * 0.5, `the default is ${PANEL_BOX.h}px tall`);
  assert.ok(PANEL_BOX.h > PANEL_MIN.h, 'the default opens at the minimum — there is nothing to shrink to');
  assert.equal(PANEL_BOX.open, true, 'the panel carries the only text field in the app; it opens by default');
  assert.equal(PANEL_BOX.min, false);
});
