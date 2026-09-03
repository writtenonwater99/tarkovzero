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
 * upper-left corner and holds the assistant. The eviction rule ("one transient at a time") is
 * per-column, because a lookup on the right has no business closing the conversation on the left;
 * everything else — pinning, painting, `seen`, Esc — is the same code for both.
 *
 * Every panel's DOM is mounted statically in index.html and only hidden/shown — nothing here builds
 * markup, so the ids the rest of the app binds to exist from the first frame (see
 * scripts/dom-contract-check.mjs).
 */

const KEY = 'shell';
export const PANELS = ['layers', 'quests', 'view', 'live', 'ask'];
const WORKSPACE = new Set(['layers', 'quests', 'ask']);
/** Which dock column a panel hangs in. Eviction is per-column; the pin model is not. */
export const COLUMN = Object.freeze({ layers: 'right', quests: 'right', view: 'right', live: 'right', ask: 'left' });
const columnOf = (name) => COLUMN[name] ?? 'right';

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
    };
  }

  const saved = store?.get(KEY, null) ?? {};
  const manual = new Set((saved.pinned ?? []).filter((n) => WORKSPACE.has(n)));
  const seen = new Set((saved.seen ?? []).filter((n) => PANELS.includes(n)));
  const pinned = new Set(manual);      // manual ∪ (auto − unpinned)
  const auto = new Set();
  // Panels the user unpinned BY HAND while something was auto-pinning them. "A manual pin always
  // wins over the automatic one" cuts both ways: without this, unpinning Quests while a quest is
  // selected is a no-op, because setAutoPin put it back the instant the click let go. Cleared when
  // the automatic reason goes away, so the next selection is free to pin it again.
  const unpinned = new Set();
  const open = new Set(pinned);        // invariant: pinned ⊆ open, at most one open non-pinned

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
    paint();
    if (on && focus) {
      const f = el[name].panel.querySelector('input,button,[tabindex]');
      f?.focus?.();
    }
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
   *                 stage WIDTH minus only the chrome that spans it — the chip band along the top
   *                 and the omnibox along the bottom. The dock and the toolbar are NOT insets
   *                 here. They used to be, and a 360 px panel that is 285 px tall then cost the
   *                 map a 439 px column for the whole 985 px height: the contain fit letterboxes
   *                 a 2:1 raster inside the near-square remainder, so the width the panel took was
   *                 paid a second time in height (measured: 67 % of the window with no panel,
   *                 35 % with the quests panel open).
   *   avoidRect() — the part of the stage nothing floats over. Fly-to targets, the 3D quest card
   *                 and the label seating pass all want the box the reader can actually see, so
   *                 that one keeps the toolbar and dock insets.
   *
   * Both are CSS px in the stage's own coordinate space, and neither ever moves the camera by
   * itself: nothing here calls back into a fit (see `onLayout`, which only repaints the HUD).
   */
  const GAP = 10;
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
    const omni = boxOf(document.getElementById('omnibox'), s);
    if (omni) rect.bottom = Math.min(rect.bottom, omni.top - GAP);
    return sane(rect, s);
  }
  function avoidRect() {
    const s = stage.getBoundingClientRect();
    const rect = safeRect();
    // The toolbar's own box includes the hover/first-run labels, which come and go; the buttons are
    // the part that is always there, so they set the inset.
    for (const btn of document.querySelectorAll('#toolbar .tb-btn')) {
      const b = boxOf(btn, s);
      if (b) rect.right = Math.min(rect.right, b.left - GAP);
    }
    if (openIn('right')) { const b = boxOf(docks.right, s); if (b) rect.right = Math.min(rect.right, b.left - GAP); }
    // The left column is the assistant. It floats over the upper-left of the map exactly as the
    // right dock floats over the right, so it owes the reader the same inset: without this line a
    // place label, a quest card or a fly-to target lands *behind* the conversation and the map
    // still believes it is visible (QA H4's whole point, mirrored).
    if (openIn('left')) { const b = boxOf(docks.left, s); if (b) rect.left = Math.max(rect.left, b.right + GAP); }
    return sane(rect, s);
  }

  /* ------------------------------------------------------------------ wire -- */
  for (const name of PANELS) {
    const e = el[name];
    e.btn?.addEventListener('click', () => setOpen(name, !open.has(name), { focus: true }));
    e.pin?.addEventListener('click', () => setPinned(name, !pinned.has(name)));
  }
  for (const b of document.querySelectorAll('[data-close]')) {
    b.addEventListener('click', () => setOpen(b.dataset.close, false));
  }
  window.addEventListener('resize', () => onLayout?.());

  paint();
  // ?panel=layers,quests — a QA/permalink hook; the named panels open on load.
  const q = new URLSearchParams(location.search).get('panel');
  if (q) for (const n of q.split(',').map((s) => s.trim())) if (PANELS.includes(n)) setOpen(n, true);

  return {
    open: (name, opts) => setOpen(name, true, opts),
    close: (name) => setOpen(name, false),
    setOpen: (name, on, opts) => setOpen(name, on, opts),
    toggle: (name) => setOpen(name, !open.has(name)),
    isOpen, isPinned,
    setPinned, setAutoPin,
    closeTransient,
    setIndicator,
    safeRect, avoidRect,
    anyOpen: () => open.size > 0,
  };
}
