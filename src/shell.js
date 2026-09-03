/**
 * TarkovZero — shell (floating HUD).
 *
 * The map is edge-to-edge; every control floats over it. This module owns the right icon toolbar,
 * TWO dock columns of panels, and the pin model that decides what stays open:
 *
 *   - **workspace** panels (Layers, Quests, Ask) can be pinned. A pinned panel stays open while you
 *     use anything else; two pinned panels stack vertically in one dock column and scroll
 *     internally. A manual pin always wins over the automatic one.
 *   - **transient** panels (View, Live) are lookups: only one is open at a time *per column* and it
 *     opens alongside the pinned workspaces. Esc closes the transient first and unpins nothing.
 *
 * **Two columns, one pin model** (2026-09-02, founder: "move the AI chat to there" — a box drawn in
 * the upper-left of the map). `#dock` hangs off the right toolbar; `#dock-left` sits in the
 * upper-left corner and holds the Ask panel. The eviction rule ("one transient at a time") is
 * per-column, because a lookup on the right has no business closing the conversation on the left;
 * everything else — pinning, painting, `seen`, Esc — is the same code for both.
 *
 * **One FLOATING panel** (2026-09-02, founder: "keep the side active, able it to be moved around
 * and pinned, and make it bit taller to fit more convo. and ability to minimize. it can also start
 * small."). The Ask panel can be dragged anywhere, resized, and minimised to its own header. It is
 * still a `PANELS` entry with a `COLUMN`, a toolbar button, a pin and a close — dragging changes
 * only WHERE it is, so there is exactly one pin model and one eviction rule, not two. What moves is
 * `#dock-left` itself (it holds that one panel), which keeps `avoidRect()` measuring the same node
 * it always did. Geometry lives in `tz:askpanel` next to every other preference.
 *
 * The one thing position genuinely coupled to the shell was `avoidRect()`, which used to inset the
 * LEFT edge because the panel was nailed there. It now subtracts the panel's real box — see
 * `avoidInset()`, which is pure and unit-tested in scripts/shell-panel-test.mjs.
 *
 * Every panel's DOM is mounted statically in index.html and only hidden/shown — nothing here builds
 * markup, so the ids the rest of the app binds to exist from the first frame (see
 * scripts/dom-contract-check.mjs).
 */

const KEY = 'shell';
const BOX_KEY = 'askpanel';
export const PANELS = ['layers', 'quests', 'view', 'live', 'ask'];
const WORKSPACE = new Set(['layers', 'quests', 'ask']);
/** Which dock column a panel hangs in. Eviction is per-column; the pin model is not. */
export const COLUMN = Object.freeze({ layers: 'right', quests: 'right', view: 'right', live: 'right', ask: 'left' });
const columnOf = (name) => COLUMN[name] ?? 'right';
/** The panel the founder can drag. One entry, but the code below never hard-codes the name. */
const MOVABLE = 'ask';

/* ---------------------------------------------------------------- geometry -- */
/** The gap every inset leaves between the map's usable box and a piece of chrome. */
const GAP = 10;
/** Below these the panel stops being a conversation and starts being a bug. */
export const PANEL_MIN = Object.freeze({ w: 280, h: 220 });
/** Collapsed height: `.panel-hd` alone. Kept in step with `--panel-head` in style.css. */
export const PANEL_HEAD = 32;
const PANEL_EDGE = 8;
/**
 * Where the panel opens on a first visit: the upper-left corner the founder drew, at a size that
 * "starts small" and still shows a few exchanges. It is smaller than the full-height column this
 * replaced — growing it is a drag of the corner grip, and the size is remembered.
 */
export const PANEL_BOX = Object.freeze({ x: 12, y: 58, w: 360, h: 430, min: false, open: true });

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clampN = (v, lo, hi) => (hi < lo ? lo : Math.min(Math.max(v, lo), hi));
const areaOf = (r) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);

/**
 * Keep a floating panel on screen and above the minimum usable size. Pure: `stage` is
 * `{width, height}` in CSS px. A window that shrinks below the stored size shrinks the panel with
 * it rather than parking half of it off-screen — that is what keeps small viewports usable.
 */
export function clampPanelBox(box = {}, stage = {}) {
  const sw = Math.max(1, num(stage.width, 0));
  const sh = Math.max(1, num(stage.height, 0));
  const min = !!box.min;
  const w = Math.round(clampN(num(box.w, PANEL_BOX.w), PANEL_MIN.w, Math.max(PANEL_MIN.w, sw - 2 * PANEL_EDGE)));
  const h = Math.round(clampN(num(box.h, PANEL_BOX.h), PANEL_MIN.h, Math.max(PANEL_MIN.h, sh - 2 * PANEL_EDGE)));
  // A minimised panel is only its header tall, so it may sit much lower before it falls off.
  const visible = min ? PANEL_HEAD : h;
  const x = Math.round(clampN(num(box.x, PANEL_BOX.x), PANEL_EDGE, Math.max(PANEL_EDGE, sw - w - PANEL_EDGE)));
  const y = Math.round(clampN(num(box.y, PANEL_BOX.y), PANEL_EDGE, Math.max(PANEL_EDGE, sh - visible - PANEL_EDGE)));
  return { x, y, w, h, min, open: box.open !== false };
}

/**
 * Subtract a floating panel from the reader's rect (`avoidRect`) by pushing ONE edge in.
 *
 * A rectangle cannot express "everything except a box in the middle", so exactly one edge moves.
 * Which one is decided in two steps, and both halves matter:
 *
 *   - the SIDE on each axis is the one the panel is nearer to (a panel hugging the left never
 *     insets from the right), so the answer does not flip while you drag along an edge;
 *   - the AXIS is whichever of those two candidates leaves the most map, so a wide, short panel
 *     (a minimised handle) costs a shallow band off the top instead of a third of the width.
 *
 * At the shipped default — the panel in the upper-left corner — this reduces to exactly the
 * hard-coded left inset it replaced. Dragged to the right it insets the right edge, dragged to the
 * bottom the bottom edge, and MINIMISED in the corner it gives the width back and takes a strip.
 * A panel that does not overlap the rect at all costs nothing.
 */
export function avoidInset(rect, box, stage = {}) {
  if (!rect || !box) return rect;
  if (box.right <= rect.left || box.left >= rect.right || box.bottom <= rect.top || box.top >= rect.bottom) return rect;
  const sw = Math.max(1, num(stage.width, 0));
  const sh = Math.max(1, num(stage.height, 0));
  const nearLeft = box.left <= sw - box.right;
  const nearTop = box.top <= sh - box.bottom;
  const hor = nearLeft
    ? { ...rect, left: Math.max(rect.left, box.right + GAP) }
    : { ...rect, right: Math.min(rect.right, box.left - GAP) };
  const ver = nearTop
    ? { ...rect, top: Math.max(rect.top, box.bottom + GAP) }
    : { ...rect, bottom: Math.min(rect.bottom, box.top - GAP) };
  return areaOf(hor) >= areaOf(ver) ? hor : ver;
}

/**
 * @param {object} deps
 * @param {{get(k,d):any,set(k,v):void}} deps.store  localStorage wrapper from main.js
 * @param {()=>void} [deps.onLayout]  called after anything moves (dock opened/closed/pinned)
 */
export function createShell({ store, onLayout } = {}) {
  const stage = document.getElementById('stage');
  const docks = { right: document.getElementById('dock'), left: document.getElementById('dock-left') };
  const dock = docks.right;
  const el = {};            // name -> { panel, btn, item, pin }
  for (const name of PANELS) {
    el[name] = {
      panel: document.getElementById(`panel-${name}`),
      btn: document.querySelector(`[data-panel-btn="${name}"]`),
      item: document.querySelector(`.tb-item[data-tb="${name}"]`),
      pin: document.querySelector(`[data-pin="${name}"]`),
      min: document.querySelector(`[data-min="${name}"]`),
      grip: document.querySelector(`[data-grip="${name}"]`),
    };
  }

  const saved = store?.get(KEY, null) ?? {};
  const manual = new Set((saved.pinned ?? []).filter((n) => WORKSPACE.has(n)));
  const seen = new Set((saved.seen ?? []).filter((n) => PANELS.includes(n)));
  const pinned = new Set(manual);      // manual ∪ (auto − unpinned)
  const auto = new Set();

  /* --------------------------------------------------------- floating box -- */
  const stageSize = () => {
    const r = stage?.getBoundingClientRect?.();
    return { width: r?.width ?? 0, height: r?.height ?? 0 };
  };
  let box = clampPanelBox(store?.get(BOX_KEY, null) ?? PANEL_BOX, stageSize());
  const saveBox = () => store?.set(BOX_KEY, box);
  /**
   * Write the box onto `#dock-left`. The COLUMN moves, not the panel inside it: `avoidRect()` and
   * every CSS rule that says `#dock-left > .panel` then keep working untouched.
   */
  function applyBox() {
    const col = docks.left;
    if (!col?.style) return;
    box = clampPanelBox(box, stageSize());
    col.style.left = `${box.x}px`;
    col.style.top = `${box.y}px`;
    col.style.width = `${box.w}px`;
    col.style.height = box.min ? 'auto' : `${box.h}px`;
    col.style.bottom = 'auto';
    col.classList.toggle('is-min', box.min);
    el[MOVABLE]?.panel?.classList?.toggle('is-min', box.min);
    el[MOVABLE]?.min?.setAttribute('aria-pressed', String(box.min));
    if (el[MOVABLE]?.min) el[MOVABLE].min.title = box.min ? 'Expand this panel' : 'Minimise to the title bar';
  }
  // Panels the user unpinned BY HAND while something was auto-pinning them. "A manual pin always
  // wins over the automatic one" cuts both ways: without this, unpinning Quests while a quest is
  // selected is a no-op, because setAutoPin put it back the instant the click let go. Cleared when
  // the automatic reason goes away, so the next selection is free to pin it again.
  const unpinned = new Set();
  const open = new Set(pinned);        // invariant: pinned ⊆ open, at most one open non-pinned
  // The Ask panel carries the only text field in the app (the omnibox moved into its header on
  // 2026-09-02), so it opens on a first visit and stays open until the reader closes it. That
  // choice is remembered in the panel's own box record, NOT in `seen`: marking it seen here would
  // stand the whole toolbar's first-run captions down before the reader had touched anything.
  if (box.open && el[MOVABLE]?.panel) open.add(MOVABLE);

  const save = () => store?.set(KEY, { pinned: [...manual], seen: [...seen] });
  const isOpen = (name) => open.has(name);
  const isPinned = (name) => pinned.has(name);
  /**
   * The one unpinned panel in a column, if any. Scoped to a column so opening View on the right
   * cannot close the conversation on the left — they are not competing for the same strip of screen.
   */
  const transientOpen = (col = null) =>
    [...open].find((n) => !pinned.has(n) && (col === null || columnOf(n) === col)) ?? null;
  const openIn = (col) => [...open].some((n) => columnOf(n) === col);

  /* ------------------------------------------------------------------ paint -- */
  function paint() {
    // The standing first-run labels are ONE group, not four independent ones. Per-panel `seen`
    // meant that opening Live once left LAYERS / QUESTS / VIEW captioned and the fourth button a
    // bare icon — the same toolbar reading two different ways depending on which panel you had
    // touched (QA D12, reproduced at 1920×1165 after a Live screenshot in the same profile).
    // They all stand until the toolbar has been used at all, then they all stand down together.
    const introOver = PANELS.some((n) => seen.has(n));
    for (const name of PANELS) {
      const e = el[name];
      if (!e.panel) continue;
      const on = open.has(name);
      e.panel.hidden = !on;
      e.panel.classList.toggle('is-pinned', pinned.has(name));
      e.btn?.classList.toggle('on', on);
      e.btn?.setAttribute('aria-expanded', String(on));
      e.item?.classList.toggle('unseen', !introOver);
      if (e.pin) {
        // One meaning for all three: the button is lit iff the panel is pinned, whoever pinned it,
        // and pressing a lit one unpins. Reading `manual` for the state and `pinned` for the light
        // is how the control used to end up looking pinned, staying pinned and changing only its
        // tooltip while an auto-pin held it.
        const on = pinned.has(name);
        e.pin.setAttribute('aria-pressed', String(on));
        e.pin.classList.toggle('on', on);
        e.pin.title = on ? 'Unpin this panel' : 'Keep this panel open';
      }
    }
    for (const [col, node] of Object.entries(docks)) node?.classList.toggle('has-open', openIn(col));
    document.body.classList.toggle('dock-open', open.size > 0);
    // The first-run toolbar captions stand down when a panel is over them. Only the RIGHT column
    // is over them — the Ask panel floats on the other side of the map and now opens by default,
    // so reading `dock-open` here would have deleted the captions for every first-time visitor.
    document.body.classList.toggle('dock-open-right', openIn('right'));
    applyBox();
    onLayout?.();
  }

  /* ------------------------------------------------------------- open/close -- */
  function setOpen(name, on, { focus = false } = {}) {
    if (!PANELS.includes(name) || !el[name].panel) return;
    if (on) {
      if (!pinned.has(name)) {
        const t = transientOpen(columnOf(name));
        if (t && t !== name) open.delete(t);
      }
      open.add(name);
      if (!seen.has(name)) { seen.add(name); save(); }
    } else {
      open.delete(name);
      unpinned.delete(name);   // closing it outright resets the pin argument entirely
      if (pinned.has(name)) { pinned.delete(name); manual.delete(name); auto.delete(name); save(); }
    }
    if (name === MOVABLE && box.open !== !!on) { box.open = !!on; saveBox(); }
    paint();
    if (on && focus) {
      // `[data-focus]` first: the header's pin/minimise/close buttons come before the body in
      // document order, so the generic query used to hand the keyboard to the pin button.
      const f = el[name].panel.querySelector('[data-focus]') ?? el[name].panel.querySelector('input,button,[tabindex]');
      f?.focus?.();
    }
  }

  /**
   * Open the panel AND uncollapse it — what a keyboard shortcut or the toolbar button owes the
   * reader now that the omnibox lives inside this panel. "Minimised" must never be more than one
   * keystroke away from a usable input.
   */
  function reveal(name, { focus = false } = {}) {
    if (name === MOVABLE && box.min) { box.min = false; saveBox(); }
    setOpen(name, true, { focus });
  }

  /** Collapse to the title bar (or expand again). Distinct from closing: the panel stays open. */
  function setMinimized(name, on) {
    if (name !== MOVABLE) return;
    box.min = !!on;
    saveBox();
    applyBox();
    onLayout?.();
  }

  function setPinned(name, on) {
    if (!WORKSPACE.has(name)) return;
    if (on) { manual.add(name); unpinned.delete(name); pinned.add(name); open.add(name); }
    else {
      manual.delete(name);
      // Unpin means unpin, even while `auto` still holds the panel — see `unpinned` above.
      if (auto.has(name)) unpinned.add(name);
      pinned.delete(name);
      if (open.has(name) && !pinned.has(name)) {          // it is now its column's one transient slot
        for (const t of [...open]) if (t !== name && !pinned.has(t) && columnOf(t) === columnOf(name)) open.delete(t);
      }
    }
    save();
    paint();
  }

  /** Quests auto-pins itself while a quest is selected — unless the user pinned it by hand. */
  function setAutoPin(name, on) {
    if (!WORKSPACE.has(name)) return;
    if (on) {
      auto.add(name);
      if (!pinned.has(name) && !unpinned.has(name)) {
        pinned.add(name);
        open.add(name);
      }
    } else {
      auto.delete(name);
      unpinned.delete(name);
      if (!manual.has(name)) pinned.delete(name);
      if (open.has(name) && !pinned.has(name)) {
        for (const t of [...open]) if (t !== name && !pinned.has(t) && columnOf(t) === columnOf(name)) open.delete(t);
      }
    }
    paint();
  }

  /**
   * Esc: close the transient panel first; pinned workspaces stay. Returns true if it closed one.
   * The right column peels before the left: the toolbar's lookups are what a player just opened,
   * the conversation on the left is the thing they were reading. One Esc, one panel.
   */
  function closeTransient() {
    const t = transientOpen('right') ?? transientOpen('left');
    if (!t) return false;
    setOpen(t, false);
    return true;
  }

  /** Toolbar dot: Live goes green while a position streams, Quests lights while quests are picked. */
  function setIndicator(name, on) { el[name]?.btn?.classList.toggle('armed', !!on); }

  /* -------------------------------------------------------------- safe rect -- */
  /*
   * TWO rects, because the two questions they answer are not the same one (QA H4).
   *
   *   safeRect()  — the box a FIT frames the map into. Panels FLOAT over the map: opening one may
   *                 not shrink the map, and it may not move the camera. So this rect is the full
   *                 stage WIDTH minus only the chrome that spans it — the chip band along the top.
   *                 The dock and the toolbar are NOT insets here. They used to be, and a 360 px
   *                 panel that is 285 px tall then cost the map a 439 px column for the whole
   *                 985 px height: the contain fit letterboxes a 2:1 raster inside the near-square
   *                 remainder, so the width the panel took was paid a second time in height
   *                 (measured: 67 % of the window with no panel, 35 % with the quests panel open).
   *
   *                 The omnibox band used to be the second inset. It is gone (2026-09-02, founder:
   *                 "lets remove the bar from the bottom"): the omnibox moved INTO the Ask panel,
   *                 and a panel is not a fit inset. The map keeps ~70 px of window it used to
   *                 reserve for a bar that is no longer there.
   *   avoidRect() — the part of the stage nothing floats over. Fly-to targets, the 3D quest card
   *                 and the label seating pass all want the box the reader can actually see, so
   *                 that one keeps the toolbar, dock, floating-panel and telemetry insets.
   *
   * Both are CSS px in the stage's own coordinate space, and neither ever moves the camera by
   * itself: nothing here calls back into a fit (see `onLayout`, which only repaints the HUD).
   */
  const boxOf = (node, s) => {
    if (!node || node.hidden || !node.getClientRects().length) return null;
    const r = node.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { left: r.left - s.left, top: r.top - s.top, right: r.right - s.left, bottom: r.bottom - s.top };
  };
  /** Never hand back an inverted or silly-small rect — callers divide by its size. */
  const sane = (rect, s) => {
    if (rect.right - rect.left < 120) rect.right = Math.min(s.width, rect.left + 120);
    if (rect.bottom - rect.top < 120) rect.bottom = Math.min(s.height, rect.top + 120);
    return rect;
  };
  function safeRect() {
    const s = stage.getBoundingClientRect();
    const rect = { left: 0, top: 0, right: s.width, bottom: s.height };
    for (const sel of ['.chipbar-tl', '.chipbar-tr']) {
      const b = boxOf(document.querySelector(sel), s);
      if (b) rect.top = Math.max(rect.top, b.bottom + GAP);
    }
    return sane(rect, s);
  }
  function avoidRect() {
    const s = stage.getBoundingClientRect();
    let rect = safeRect();
    // The toolbar's own box includes the hover/first-run labels, which come and go; the buttons are
    // the part that is always there, so they set the inset.
    for (const btn of document.querySelectorAll('#toolbar .tb-btn')) {
      const b = boxOf(btn, s);
      if (b) rect.right = Math.min(rect.right, b.left - GAP);
    }
    if (openIn('right')) { const b = boxOf(docks.right, s); if (b) rect.right = Math.min(rect.right, b.left - GAP); }
    // The bottom telemetry chips (coords, scale bar, attribution). They used to be covered for free
    // by the omnibox band; with the bar gone this is what keeps a place label or a marker badge off
    // the scale bar.
    for (const sel of ['.hud-bl', '.hud-br']) {
      const b = boxOf(document.querySelector(sel), s);
      if (b) rect.bottom = Math.min(rect.bottom, b.top - GAP);
    }
    // The floating Ask panel. It can be ANYWHERE, so the inset follows it instead of always taking
    // the left edge: without this a panel dragged to the right of the map would have place labels,
    // the quest card and every fly-to target seated *behind* it while the map still believed they
    // were visible (QA H4's whole point, generalised).
    if (openIn('left')) {
      const b = boxOf(docks.left, s);
      if (b) rect = avoidInset(rect, b, { width: s.width, height: s.height });
    }
    return sane(rect, s);
  }

  /* ------------------------------------------------------------------ wire -- */
  for (const name of PANELS) {
    const e = el[name];
    e.btn?.addEventListener('click', () => {
      if (open.has(name)) setOpen(name, false);
      // The toolbar button REVEALS: opening a panel that is collapsed to its title bar and calling
      // that "open" would hand the reader a header and no omnibox.
      else reveal(name, { focus: true });
    });
    e.pin?.addEventListener('click', () => setPinned(name, !pinned.has(name)));
    e.min?.addEventListener('click', () => setMinimized(name, !box.min));
  }
  for (const b of document.querySelectorAll('[data-close]')) {
    b.addEventListener('click', () => setOpen(b.dataset.close, false));
  }

  /* ------------------------------------------------------- drag and resize -- */
  /*
   * Pointer events, not mouse: one code path covers mouse, pen and touch, and setPointerCapture
   * means a fast drag that leaves the header still tracks. Nothing is written to the store until
   * the gesture ends, so a drag costs one localStorage write, not sixty.
   */
  function gesture(node, onMove, { cursor = '' } = {}) {
    if (!node?.addEventListener) return;
    let from = null;
    node.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      if (e.target?.closest?.('button, a, input, select, textarea')) return;
      from = { x: e.clientX, y: e.clientY, box: { ...box } };
      // A synthetic pointerdown (a test harness) carries no live pointer id and capture throws.
      // The drag itself does not need capture — it only makes a fast one stop skipping.
      try { node.setPointerCapture?.(e.pointerId); } catch { /* not a real pointer */ }
      document.body.classList.add('is-dragging');
      if (cursor) document.body.style.cursor = cursor;
      e.preventDefault();
    });
    node.addEventListener('pointermove', (e) => {
      if (!from) return;
      onMove(e.clientX - from.x, e.clientY - from.y, from.box);
      applyBox();
      onLayout?.();
    });
    const end = () => {
      if (!from) return;
      from = null;
      document.body.classList.remove('is-dragging');
      document.body.style.cursor = '';
      applyBox();
      saveBox();
      onLayout?.();
    };
    node.addEventListener('pointerup', end);
    node.addEventListener('pointercancel', end);
  }
  const head = el[MOVABLE]?.panel?.querySelector?.('.panel-hd');
  gesture(head, (dx, dy, start) => { box.x = start.x + dx; box.y = start.y + dy; }, { cursor: 'grabbing' });
  gesture(el[MOVABLE]?.grip, (dx, dy, start) => {
    if (box.min) return;
    box.w = start.w + dx;
    box.h = start.h + dy;
  }, { cursor: 'nwse-resize' });
  // Double-clicking the title bar is the other half of the minimise affordance every window has.
  head?.addEventListener?.('dblclick', (e) => {
    if (e.target?.closest?.('button')) return;
    setMinimized(MOVABLE, !box.min);
  });

  window.addEventListener('resize', () => { applyBox(); saveBox(); onLayout?.(); });

  applyBox();
  paint();
  // ?panel=layers,quests — a QA/permalink hook; the named panels open on load.
  const q = new URLSearchParams(location.search).get('panel');
  if (q) for (const n of q.split(',').map((s) => s.trim())) if (PANELS.includes(n)) setOpen(n, true);

  return {
    open: (name, opts) => setOpen(name, true, opts),
    close: (name) => setOpen(name, false),
    setOpen: (name, on, opts) => setOpen(name, on, opts),
    toggle: (name) => setOpen(name, !open.has(name)),
    /** Open + uncollapse. What Ctrl+K, `/`, `A` and the toolbar button use. */
    reveal,
    isOpen, isPinned,
    setPinned, setAutoPin,
    setMinimized,
    isMinimized: (name) => (name === MOVABLE ? !!box.min : false),
    /** QA hook: the floating panel's remembered geometry. */
    panelBox: () => ({ ...box }),
    closeTransient,
    setIndicator,
    safeRect, avoidRect,
    anyOpen: () => open.size > 0,
  };
}
