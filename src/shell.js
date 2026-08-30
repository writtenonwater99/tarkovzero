/**
 * TarkovZero — shell (floating HUD).
 *
 * The map is edge-to-edge; every control floats over it. This module owns the right icon toolbar,
 * the dock column of panels to its left, and the pin model that decides what stays open:
 *
 *   - **workspace** panels (Layers, Quests) can be pinned. A pinned panel stays open while you use
 *     anything else; two pinned panels stack vertically in the one dock column and scroll
 *     internally. A manual pin always wins over the automatic one.
 *   - **transient** panels (View, Live, Ask) are lookups: only one is open at a time and it opens
 *     *alongside* the pinned workspaces. Esc closes the transient first and unpins nothing.
 *
 * Every panel's DOM is mounted statically in index.html and only hidden/shown — nothing here builds
 * markup, so the ids the rest of the app binds to exist from the first frame (see
 * scripts/dom-contract-check.mjs).
 */

const KEY = 'shell';
// 'ask' is deliberately absent: the assistant is the omnibox card, not a dock panel (step 2).
// #panel-ask stays in the DOM, permanently hidden, because assistant.js binds ids inside it.
export const PANELS = ['layers', 'quests', 'view', 'live'];
const WORKSPACE = new Set(['layers', 'quests']);

/**
 * @param {object} deps
 * @param {{get(k,d):any,set(k,v):void}} deps.store  localStorage wrapper from main.js
 * @param {()=>void} [deps.onLayout]  called after anything moves (dock opened/closed/pinned)
 */
export function createShell({ store, onLayout } = {}) {
  const stage = document.getElementById('stage');
  const dock = document.getElementById('dock');
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
  const transientOpen = () => [...open].find((n) => !pinned.has(n)) ?? null;

  /* ------------------------------------------------------------------ paint -- */
  function paint() {
    for (const name of PANELS) {
      const e = el[name];
      if (!e.panel) continue;
      const on = open.has(name);
      e.panel.hidden = !on;
      e.panel.classList.toggle('is-pinned', pinned.has(name));
      e.btn?.classList.toggle('on', on);
      e.btn?.setAttribute('aria-expanded', String(on));
      e.item?.classList.toggle('unseen', !seen.has(name));
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
    dock.classList.toggle('has-open', open.size > 0);
    document.body.classList.toggle('dock-open', open.size > 0);
    onLayout?.();
  }

  /* ------------------------------------------------------------- open/close -- */
  function setOpen(name, on, { focus = false } = {}) {
    if (!PANELS.includes(name) || !el[name].panel) return;
    if (on) {
      if (!pinned.has(name)) {
        const t = transientOpen();
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
      if (open.has(name) && !pinned.has(name)) {          // it is now the one transient slot
        for (const t of [...open]) if (t !== name && !pinned.has(t)) open.delete(t);
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
        for (const t of [...open]) if (t !== name && !pinned.has(t)) open.delete(t);
      }
    }
    paint();
  }

  /** Esc: close the transient panel first; pinned workspaces stay. Returns true if it closed one. */
  function closeTransient() {
    const t = transientOpen();
    if (!t) return false;
    setOpen(t, false);
    return true;
  }

  /** Toolbar dot: Live goes green while a position streams, Quests lights while quests are picked. */
  function setIndicator(name, on) { el[name]?.btn?.classList.toggle('armed', !!on); }

  /* -------------------------------------------------------------- safe rect -- */
  // The part of the stage nothing floats over: used for 2D fit/fly padding and for parking the 3D
  // quest card. All values are CSS px in the stage's own coordinate space.
  const GAP = 10;
  function safeRect() {
    const s = stage.getBoundingClientRect();
    const rect = { left: 0, top: 0, right: s.width, bottom: s.height };
    const box = (node) => {
      if (!node || node.hidden || !node.getClientRects().length) return null;
      const r = node.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { left: r.left - s.left, top: r.top - s.top, right: r.right - s.left, bottom: r.bottom - s.top };
    };
    for (const sel of ['.chipbar-tl', '.chipbar-tr']) {
      const b = box(document.querySelector(sel));
      if (b) rect.top = Math.max(rect.top, b.bottom + GAP);
    }
    // The toolbar's own box includes the hover/first-run labels, which come and go; the buttons are
    // the part that is always there, so they set the inset.
    for (const btn of document.querySelectorAll('#toolbar .tb-btn')) {
      const b = box(btn);
      if (b) rect.right = Math.min(rect.right, b.left - GAP);
    }
    if (open.size) { const b = box(dock); if (b) rect.right = Math.min(rect.right, b.left - GAP); }
    const omni = box(document.getElementById('omnibox'));
    if (omni) rect.bottom = Math.min(rect.bottom, omni.top - GAP);

    // Never hand back an inverted or silly-small rect — callers divide by its size.
    if (rect.right - rect.left < 120) rect.right = Math.min(s.width, rect.left + 120);
    if (rect.bottom - rect.top < 120) rect.bottom = Math.min(s.height, rect.top + 120);
    return rect;
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
    safeRect,
    anyOpen: () => open.size > 0,
  };
}
