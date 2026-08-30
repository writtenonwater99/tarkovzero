/**
 * TarkovZero — omnibox (bottom-centre): one text field, three deterministic modes.
 *
 * Routing is by PREFIX, never by a classifier guessing what you meant (Codex red team #5):
 *
 *   (no prefix)  local lookup — places, extracts, transits, locks/keys, spawn groups, quests.
 *                Enter acts on the highlighted row (the first result, or an exact name match).
 *                The last row is always an unselected "Ask AI: …" — arrow down to it to send the
 *                text to the assistant. Free text NEVER routes to the AI on its own.
 *   `>`          commands: `> layers scav`, `> 3d`, `> floor 2`, `> fit`… Command names are
 *                matched by prefix and then by subsequence (`> lyr`, `> flr 2`), and the row
 *                echoes the argument so you can see what will run before you press Enter.
 *   `?`          the assistant, explicitly.
 *
 * `route()` is pure and has no DOM in it — scripts/omnibox-routing-test.mjs runs it directly.
 */
import { iconHtml } from './icons.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const PREFIX = { command: '>', ask: '?' };

/** The command vocabulary. `arg` is documentation for the row, not a parser. */
export const COMMANDS = [
  { name: 'layers', arg: 'group or layer', hint: 'show a layer group', aliases: ['filters'] },
  { name: 'show', arg: 'layer', hint: 'turn a layer on' },
  { name: 'hide', arg: 'layer', hint: 'turn a layer off' },
  { name: '3d', hint: 'switch to the 3D view' },
  { name: '2d', hint: 'switch to the 2D view' },
  { name: 'map', arg: 'customs | reserve | woods', hint: 'load another map' },
  { name: 'floor', arg: 'all · 0–4 · U', hint: 'pick a floor (3D)' },
  { name: 'relief', arg: '1 | 2 | 3', hint: 'terrain exaggeration (3D)' },
  { name: 'trees', arg: 'on | off', hint: 'tree cover' },
  { name: 'rocks', arg: 'on | off', hint: 'rocks' },
  { name: 'labels', arg: 'off | key | all', hint: 'place-name density' },
  { name: 'fit', hint: 'fit the whole map' },
  { name: 'north', hint: 'reset the compass (3D)' },
  { name: 'live', hint: 'open the Live panel' },
  { name: 'quests', hint: 'open the Quests panel' },
  // Two words, like `clear trails`, so `> quests` keeps meaning the panel and `> my` means the log.
  { name: 'my quests', hint: 'the quests the game says you are on', aliases: ['active quests'] },
  { name: 'pin', arg: 'quests | layers', hint: 'keep a panel open' },
  { name: 'clear trails', hint: 'wipe the live trails' },
  { name: 'help', hint: 'controls and shortcuts' },
];

/**
 * Run one `>` command against a set of action handles. Returns the toast line.
 *
 * Module-level and exported on purpose: the switch below is the wire between a highlighted row and
 * something happening, and it used to be a closure nothing could reach. scripts/omnibox-routing-test
 * calls it with stub actions, and asserts that every name in COMMANDS has a case here — a command
 * added to the vocabulary but not to the switch renders a selectable row and then does nothing.
 *
 * @param {{name:string}} cmd     the matched command
 * @param {string} rawArg         everything typed after the command name
 * @param {object} actions        the handles main.js supplies (see createOmnibox's `actions`)
 */
export function runCommand(cmd, rawArg, actions = {}) {
  const a = actions;
  const arg = String(rawArg ?? '').trim();
  const q = arg.toLowerCase();
  const onOff = (dflt) => (['off', '0', 'no', 'hide'].includes(q) ? false : ['on', '1', 'yes', 'show'].includes(q) ? true : dflt);
  switch (cmd?.name) {
    case '3d': a.setView?.('3d'); return '3D view';
    case '2d': a.setView?.('2d'); return '2D view';
    case 'fit': a.fit?.(); return 'Fitted the map';
    case 'north': a.north?.(); return 'Compass reset';
    case 'live': a.panel?.('live', true); return 'Live panel';
    case 'quests': a.panel?.('quests', true); return 'Quests panel';
    case 'my quests': a.myQuests?.(); return 'My quests';
    case 'help': a.help?.(); return 'Controls';
    case 'clear trails': a.clearTrails?.(); return 'Trails cleared';
    case 'pin': { const n = q.startsWith('l') ? 'layers' : 'quests'; a.pin?.(n, true); return `Pinned ${n}`; }
    case 'map': {
      // A bare `> map` must never navigate: k.startsWith('') is true for every key, so without this
      // guard the first map in the registry won a match nobody typed — and a map switch is a full
      // page reload that drops the camera, the selection, the transcript and the live sockets.
      // `> m` ranks `map` above `my quests`, so this is one keystroke away from being an accident.
      const keys = a.mapKeys?.() ?? [];
      if (!q) return `Which map? ${keys.join(', ')}`;
      const key = keys.find((k) => k.startsWith(q) || q.startsWith(k));
      if (!key) return `No map called “${arg}”`;
      a.goMap?.(key); return `Loading ${key}…`;
    }
    case 'floor': {
      const f = q === 'u' ? 'U' : q === 'all' || !q ? 'all' : String(Number(q));
      if (!a.setFloor?.(f)) return `No floor “${arg}”`;
      return `Floor ${f}`;
    }
    case 'relief': { const n = Number(q) || 3; a.setRelief?.(n); return `Relief ${n}×`; }
    case 'trees': case 'rocks': { const on = onOff(false); a.setNature?.(cmd.name, on); return `${cmd.name} ${on ? 'on' : 'off'}`; }
    case 'labels': {
      const d = ['off', 'key', 'all'].find((x) => x.startsWith(q)) ?? 'all';
      a.setLabels?.(d); return `Labels: ${d}`;
    }
    case 'layers': case 'show': case 'hide': {
      if (!arg) { a.panel?.('layers', true); return 'Layers panel'; }
      const n = a.setLayers?.(arg, cmd.name !== 'hide') ?? 0;
      return n ? `${cmd.name === 'hide' ? 'Hid' : 'Showed'} ${n} layer${n > 1 ? 's' : ''} matching “${arg}”` : `No layer matches “${arg}”`;
    }
    default: return '';
  }
}

/** Every command name `runCommand` actually handles — the test asserts this covers COMMANDS. */
export const HANDLED = [
  '3d', '2d', 'fit', 'north', 'live', 'quests', 'my quests', 'help', 'clear trails',
  'pin', 'map', 'floor', 'relief', 'trees', 'rocks', 'labels', 'layers', 'show', 'hide',
];

/** Is `needle` a subsequence of `hay`? ("flr" -> "floor") */
export function subsequence(needle, hay) {
  if (!needle) return false;
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i += 1;
    if (i === needle.length) return true;
  }
  return false;
}

/**
 * Score one command against typed text. Lower is better; null = no match.
 * 0 = the whole name was typed, 1 = a prefix of the first word, 2 = a subsequence of it.
 */
export function matchCommand(cmd, text) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  const first = (words[0] ?? '').toLowerCase();
  let best = null;
  const keep = (m) => { if (!best || m.score < best.score) best = m; };
  for (const name of [cmd.name, ...(cmd.aliases ?? [])]) {
    const parts = name.split(' ');
    const head = words.slice(0, parts.length).join(' ').toLowerCase();
    const tail = (n) => words.slice(n).join(' ');
    if (head === name) keep({ cmd, name, score: 0, arg: tail(parts.length) });
    else if (first && name.startsWith(first)) keep({ cmd, name, score: 1 + (name.length - first.length) / 100, arg: tail(1) });
    else if (first && subsequence(first, name)) keep({ cmd, name, score: 2 + (name.length - first.length) / 100, arg: tail(1) });
  }
  return best;
}

/** Every command matching `text`, best first. Empty text lists the whole vocabulary. */
export function matchCommands(text, commands = COMMANDS) {
  const q = String(text ?? '').trim();
  if (!q) return commands.map((cmd) => ({ cmd, name: cmd.name, score: 0, arg: '' }));
  return commands.map((c) => matchCommand(c, q)).filter(Boolean)
    .sort((a, b) => a.score - b.score || a.name.length - b.name.length)
    .slice(0, 7);
}

/**
 * Turn what was typed into rows plus the row Enter would act on.
 *
 * @param {string} raw          the raw input value
 * @param {object} ctx
 * @param {(q:string)=>object[]} [ctx.lookup]  local index search (no-prefix mode)
 * @param {object[]} [ctx.commands]
 * @returns {{mode:'idle'|'lookup'|'command'|'ai', query:string, rows:object[], index:number}}
 *          `index` is -1 when nothing is highlighted — Enter then does nothing. The "Ask AI" row
 *          is selectable but is never the default: routing to the model is always a deliberate act.
 */
export function route(raw, ctx = {}) {
  const text = String(raw ?? '').replace(/^\s+/, '');
  if (!text) return { mode: 'idle', query: '', rows: [], index: -1 };

  if (text[0] === PREFIX.command) {
    const query = text.slice(1).trim();
    const rows = matchCommands(query, ctx.commands ?? COMMANDS).map((m) => ({
      type: 'command', selectable: true, cmd: m.cmd, arg: m.arg,
      label: m.cmd.name, sub: m.arg || m.cmd.arg || '', hint: m.cmd.hint,
    }));
    if (!rows.length) rows.push({ type: 'empty', selectable: false, label: `No command matches “${query}”` });
    return { mode: 'command', query, rows, index: query && rows[0].selectable ? 0 : -1 };
  }

  if (text[0] === PREFIX.ask) {
    const query = text.slice(1).trim();
    return {
      mode: 'ai', query,
      rows: [{ type: 'ask', selectable: !!query, text: query, label: query || 'Ask the assistant…' }],
      index: query ? 0 : -1,
    };
  }

  const query = text.trim();
  const hits = (ctx.lookup?.(query) ?? []).slice(0, ctx.limit ?? 8);
  const rows = hits.map((item) => ({ type: 'result', selectable: true, item, label: item.label, sub: item.sub }));
  rows.push({ type: 'ask', selectable: true, text: query, label: query });
  const exact = rows.findIndex((r) => r.type === 'result' && r.label.toLowerCase() === query.toLowerCase());
  return { mode: 'lookup', query, rows, index: exact >= 0 ? exact : (hits.length ? 0 : -1) };
}

/* ========================================================================== *
 *  Controller
 * ========================================================================== */

const HINTS = [
  'Find a place, a quest — or ask anything…',
  'Try “dorms”, “ZB-1011” or “Gunsmith”',
  'Type > for commands · ? to ask the AI',
];
const KIND_RANK = { extract: 0, place: 1, marker: 2, lock: 2, quest: 3, layer: 4 };

/**
 * @param {object} deps
 * @param {()=>object[]} deps.index          the marker/place index built by main.js
 * @param {object} deps.quests               the quests controller (src/quests.js)
 * @param {string} deps.mapKey
 * @param {(x:number,z:number)=>void} deps.flyTo
 * @param {object} deps.actions              command implementations (see runCommand)
 * @param {object} deps.assistant            src/assistant.js — { ask, preview, getHistory, switchMap }
 * @param {{get():any,set(s:any):void}} deps.camera  snapshot/restore for the Restore chip
 * @param {()=>void} [deps.onLayout]         the results list and the card change the safe rect
 * @param {(msg:string)=>void} [deps.toast]
 */
export function createOmnibox(deps = {}) {
  const el = {
    box: document.getElementById('omnibox'),
    input: document.getElementById('find'),
    results: document.getElementById('find-results'),
    kbd: document.getElementById('find-kbd'),
    card: document.getElementById('ask-card'),
    log: document.getElementById('ask-log'),
    acts: document.getElementById('ask-acts'),
    history: document.getElementById('ask-history'),
    close: document.getElementById('ask-card-x'),
  };
  if (!el.input) return { focus() {}, refresh() {}, escape: () => false, isOpen: () => false };

  let state = route('');
  let hintAt = 0, hintTimer = 0;
  let undo = null;                      // camera + quest selection from before the last answer
  let openedForText = null;             // input value at the moment the card opened — see render()

  /* ------------------------------------------------------------- lookup --- */
  function questIndex() {
    const all = deps.quests?.quests?.() ?? [];
    return all.map((q) => ({
      kind: 'quest', label: q.name, slug: q.slug, trader: q.trader ?? '',
      sub: `${q.trader ?? 'quest'}${q.siteMaps?.includes(deps.mapKey) ? ' · here' : ''}`,
      here: !!q.siteMaps?.includes(deps.mapKey),
    }));
  }
  function lookup(q) {
    const s = q.toLowerCase();
    const pool = [...(deps.index?.() ?? []), ...questIndex()];
    return pool
      .map((r) => {
        const i = r.label.toLowerCase().indexOf(s);
        const t = (r.trader ?? '').toLowerCase().indexOf(s);
        if (i < 0 && t < 0) return null;
        const base = i >= 0 ? i : 60 + t;
        return { r, score: base * 10 + (KIND_RANK[r.kind] ?? 5) - (r.here ? 2 : 0) + r.label.length / 200 };
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score)
      .slice(0, 8)
      .map((o) => o.r);
  }

  /* ------------------------------------------------------------ rendering -- */
  function chipFor(row) {
    if (row.type === 'command') return `<span class="res-cmd mono">&gt;</span>`;
    if (row.type === 'ask') return `<span class="res-ai" aria-hidden="true">AI</span>`;
    const r = row.item ?? {};
    if (r.kind === 'quest') return `<span class="res-q">${iconHtml('quest-objective', 17)}</span>`;
    if (r.kind === 'layer' || r.kind === 'marker' || r.kind === 'lock') return iconHtml(r.mk, 17);
    if (r.kind === 'extract') return `<span class="badge">${esc(r.badge || '·')}</span>`;
    return `<span class="badge">${esc((r.label?.[0] || '·').toUpperCase())}</span>`;
  }
  function rowHtml(row, i) {
    const on = i === state.index;
    if (row.type === 'empty') return `<div class="res-empty">${esc(row.label)}</div>`;
    if (row.type === 'ask') {
      return `<div class="res res-ask${on ? ' act' : ''}" data-i="${i}" role="option" aria-selected="${on}">` +
        `${chipFor(row)}<span class="rn">Ask AI: <em>${esc(row.label)}</em></span>` +
        `<span class="rk">${row.text ? 'enter' : 'type a question'}</span></div>`;
    }
    if (row.type === 'command') {
      return `<div class="res res-command${on ? ' act' : ''}" data-i="${i}" role="option" aria-selected="${on}">` +
        `${chipFor(row)}<span class="rn mono">${esc(row.label)}` +
        (row.sub ? `<em class="res-arg">${esc(row.sub)}</em>` : '') +
        `</span><span class="rk">${esc(row.hint ?? '')}</span></div>`;
    }
    return `<div class="res res-${esc(row.item?.kind ?? 'hit')}${on ? ' act' : ''}" data-i="${i}" role="option" aria-selected="${on}">` +
      `${chipFor(row)}<span class="rn">${esc(row.label)}</span><span class="rk">${esc(row.sub ?? '')}</span></div>`;
  }
  function render() {
    // The card, once open, answers the query it was opened for — the row list beneath it (the
    // "Ask AI: …" row, or leftover lookup hits) is redundant until the input text actually changes.
    const staleBehindCard = isCardOpen() && el.input.value === openedForText;
    const show = state.rows.length > 0 && !staleBehindCard;
    el.results.hidden = !show;
    el.results.innerHTML = show ? state.rows.map(rowHtml).join('') : '';
    el.box.classList.toggle('has-results', show);
    for (const node of el.results.querySelectorAll('[data-i]')) {
      // mousedown fires before blur — act on it so a click never races the input losing focus
      node.addEventListener('mousedown', (e) => { e.preventDefault(); act(Number(node.dataset.i)); });
    }
    deps.onLayout?.();
  }
  function update() {
    state = route(el.input.value, { lookup });
    render();
  }
  function move(d) {
    const sel = state.rows.map((r, i) => (r.selectable ? i : -1)).filter((i) => i >= 0);
    if (!sel.length) return;
    const at = sel.indexOf(state.index);
    state.index = at < 0 ? (d > 0 ? sel[0] : sel[sel.length - 1]) : sel[Math.max(0, Math.min(sel.length - 1, at + d))];
    render();
    el.results.querySelector('.act')?.scrollIntoView({ block: 'nearest' });
  }

  /* -------------------------------------------------------------- acting -- */
  function clear({ blur = false } = {}) {
    el.input.value = '';
    state = route('');
    render();
    if (blur) el.input.blur();
  }
  function act(i) {
    const row = state.rows[i];
    if (!row?.selectable) return;
    if (row.type === 'ask') { clear(); return void sendToAssistant(row.text); }
    if (row.type === 'command') {
      const note = runCommand(row.cmd, row.arg, deps.actions ?? {});
      clear();
      if (note) deps.toast?.(note);
      return;
    }
    const r = row.item;
    clear();
    if (r.kind === 'quest') {
      deps.quests?.select?.(r.slug);
      const p = (deps.quests?.points?.() ?? []).find((x) => x.questSlug === r.slug);
      if (p) deps.quests.flyToPoint(p.id);
      return;
    }
    if (r.kind === 'layer') { deps.actions?.setKind?.(r.mk, true); return; }
    if (r.mk) deps.actions?.setKind?.(r.mk, true);
    deps.flyTo?.(r.x, r.z);
  }

  /* ----------------------------------------------------------- assistant -- */
  function setCardOpen(on) {
    el.card.hidden = !on;
    if (!on) { el.card.classList.remove('show-history'); openedForText = null; }
    else openedForText = el.input.value;
    render();
  }
  const isCardOpen = () => !el.card.hidden;

  function sendToAssistant(text) {
    if (!text) return;
    undo = { camera: deps.camera?.get?.() ?? null, quests: deps.quests?.selectedSlugs?.() ?? [] };
    el.acts.innerHTML = '';
    setCardOpen(true);
    el.box.classList.add('busy');
    Promise.resolve(deps.assistant?.ask?.(text)).finally(() => el.box.classList.remove('busy'));
  }

  /** Chips for what the answer did — and the one thing it is not allowed to do on its own. */
  function renderActions({ actions = [] } = {}) {
    const chips = [];
    const quest = actions.find((x) => x.type === 'selectQuest' && x.slug);
    const fly = actions.find((x) => x.type === 'flyTo' && x.objectiveId);
    const jump = actions.find((x) => x.type === 'switchMap' && x.map && x.map !== deps.mapKey);
    if (quest) chips.push({ k: 'quest', label: 'Select quest', run: () => { deps.quests?.select?.(quest.slug); deps.actions?.panel?.('quests', true); } });
    if (fly) chips.push({ k: 'fly', label: 'Fly to', run: () => deps.quests?.flyToObjective?.(fly.objectiveId) });
    // A map switch reloads the page and drops everything on screen: it only ever happens on a click.
    if (jump) chips.push({ k: 'map', label: `Switch map → ${jump.map}`, run: () => deps.assistant?.switchMap?.(jump.map, fly?.objectiveId ?? null) });
    if (undo) chips.push({ k: 'undo', label: 'Restore', run: restore });
    el.acts.innerHTML = chips.map((c, i) => `<button type="button" class="ask-act ask-act-${c.k}" data-act="${i}">${esc(c.label)}</button>`).join('');
    for (const b of el.acts.querySelectorAll('[data-act]')) b.onclick = () => chips[Number(b.dataset.act)].run();
  }
  /** Undo the answer: put the camera back and drop the quests the answer added. Never dims anything. */
  function restore() {
    if (!undo) return;
    const now = deps.quests?.selectedSlugs?.() ?? [];
    for (const slug of now) if (!undo.quests.includes(slug)) deps.quests?.deselect?.(slug);
    if (undo.camera) deps.camera?.set?.(undo.camera);
    el.acts.innerHTML = '';
    undo = null;
  }

  /* ---------------------------------------------------------------- wire -- */
  el.input.setAttribute('aria-label', 'Search, command or question');
  el.input.placeholder = HINTS[0];
  el.input.oninput = update;
  el.input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { move(1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { move(-1); e.preventDefault(); }
    else if (e.key === 'Enter') { act(state.index); e.preventDefault(); }
    else if (e.key === 'Escape') {
      // Esc clears first, and only lets go of the field once there is nothing left to clear.
      e.stopPropagation();
      if (el.input.value) clear();
      else el.input.blur();
    }
  };
  el.input.onfocus = () => { clearInterval(hintTimer); update(); };
  el.input.onblur = () => cycleHints();
  document.addEventListener('mousedown', (e) => {
    if (!el.box.contains(e.target) && state.rows.length) clear();
  });
  el.close?.addEventListener('click', () => setCardOpen(false));
  el.history?.addEventListener('click', () => {
    const on = el.card.classList.toggle('show-history');
    el.history.setAttribute('aria-pressed', String(on));
    el.log.scrollTop = el.log.scrollHeight;
  });
  if (!/Mac|iPhone|iPad/.test(navigator.platform ?? '')) el.kbd.textContent = 'Ctrl K';

  function cycleHints() {
    clearInterval(hintTimer);
    hintTimer = setInterval(() => {
      if (el.input.value || document.activeElement === el.input) return;
      hintAt = (hintAt + 1) % HINTS.length;
      el.input.placeholder = HINTS[hintAt];
    }, 6000);
  }
  cycleHints();

  /* ------------------------------------------------------------------ QA -- */
  // ?q=<text> prefills the box and opens the list without typing — headless screenshots cannot type.
  // A `?`-prefixed value renders the card in its pending state; it never calls the API.
  function applyQaQuery() {
    const q = new URLSearchParams(location.search).get('q');
    if (q == null) return;
    el.input.value = q;
    update();
    if (state.mode === 'ai' && state.query) {
      setCardOpen(true);
      deps.assistant?.preview?.(state.query);
    }
    setTimeout(() => el.input.focus(), 0);
  }

  return {
    focus: () => { el.input.focus(); el.input.select(); update(); },
    /** `A` — the assistant, one keystroke away, with the prefix already typed. */
    focusAsk: () => { if (!el.input.value.startsWith('?')) el.input.value = '?'; el.input.focus(); update(); },
    refresh: () => { if (state.rows.length) update(); },
    /** Esc from the document: peel the omnibox first. Returns true when it consumed the key. */
    escape: () => {
      if (state.rows.length) { clear({ blur: true }); return true; }
      if (isCardOpen()) { setCardOpen(false); return true; }
      return false;
    },
    setCardOpen, isCardOpen,
    onAnswer: renderActions,
    ask: sendToAssistant,
    applyQaQuery,
    route: (text) => route(text, { lookup }),
  };
}
