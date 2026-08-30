/**
 * TarkovZero — Ask panel (AI quest assistant, client half).
 *
 * Sends the question plus the map context to /api/assistant (a Vercel function that does the
 * retrieval and talks to DeepSeek — the key never leaves the server) and then *performs* the
 * actions that come back through the `window.tz` API: put a quest's objectives on the map, fly
 * to the first one, switch map when the quest lives elsewhere.
 *
 * Chat history is kept in memory only. The one exception is a map switch, which reloads the page:
 * the pending action + the last exchange ride across in sessionStorage so the panel can finish
 * the job on the other side instead of looking broken.
 */

const HANDOFF = 'tz:askPending';
const MAX_TURNS = 8;
const CHIPS = [
  'How do I do Abandoned Cargo?',
  "What's on this map for Prapor?",
  'Which quests are on this map?',
];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Markdown-lite: bold, inline code, links, "- " bullets, blank-line paragraphs. Nothing else. */
export function mdLite(src) {
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, (_, c) => `<strong>${c}</strong>`)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
  const out = [];
  let list = null;
  for (const raw of String(src ?? '').split('\n')) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (bullet) { (list ??= []).push(`<li>${inline(bullet[1])}</li>`); continue; }
    if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  return out.join('') || `<p>${inline(src)}</p>`;
}

/**
 * @param {object} deps
 * @param {{setOpen(on:boolean):void, isOpen():boolean}} deps.panel  the omnibox card
 * @param {(x:{answer:string,actions:object[],note:string})=>void} [deps.onAnswer]  render action chips
 */
export function createAssistant({ mapKey, tz, store, panel, onAnswer }) {
  const el = {
    block: document.getElementById('ask-block'),
    toggle: document.getElementById('ask-toggle'),
    body: document.getElementById('ask'),
    log: document.getElementById('ask-log'),
    chips: document.getElementById('ask-chips'),
    form: document.getElementById('ask-form'),
    input: document.getElementById('ask-input'),
  };
  if (!el.block) return { init() {}, setOpen() {}, ask() {}, preview() {}, switchMap: () => false, getHistory: () => [], focus() {} };

  let history = [];       // [{role, content}] — memory only
  let busy = false;
  let inflight = null;

  /* ------------------------------------------------------------ rendering -- */
  const scroll = () => { el.log.scrollTop = el.log.scrollHeight; };

  function bubble(role, html, cls = '') {
    const div = document.createElement('div');
    div.className = `ask-msg ask-${role}${cls ? ' ' + cls : ''}`;
    div.innerHTML = html;
    el.log.append(div);
    scroll();
    return div;
  }
  const sayUser = (text) => bubble('user', `<p>${esc(text)}</p>`);
  const sayError = (text) => bubble('bot', `<p>${esc(text)}</p>`, 'ask-err');

  function thinking() {
    const div = bubble('bot', '<span class="ask-dots"><i></i><i></i><i></i></span>', 'ask-wait');
    return div;
  }

  function renderChips() {
    el.chips.innerHTML = CHIPS.map((c) => `<button type="button" class="ask-chip">${esc(c)}</button>`).join('');
    for (const b of el.chips.querySelectorAll('.ask-chip')) b.onclick = () => ask(b.textContent);
  }

  /* -------------------------------------------------------------- actions -- */

  /** Run the server's actions against the map. Returns the one-line confirmation. */
  async function perform(actions) {
    if (!actions?.length) return '';
    await tz.quests.all();                       // make sure quests.json is loaded before select()
    const notes = [];
    let marked = 0;
    const slugs = [];

    for (const a of actions) {
      if (a.type === 'selectQuest' && typeof a.slug === 'string') {
        if (tz.quests.select(a.slug)) slugs.push(a.slug);
      }
    }
    if (slugs.length) {
      const pts = tz.quests.points().filter((p) => slugs.includes(p.questSlug));
      marked = pts.length;
      if (marked) notes.push(`Marked ${marked} objective${marked > 1 ? 's' : ''}`);
      else notes.push(`Added ${slugs.length} quest${slugs.length > 1 ? 's' : ''} (nothing to mark on ${mapKey})`);
    }

    const fly = actions.find((a) => a.type === 'flyTo' && typeof a.objectiveId === 'string');
    if (fly && marked) {
      const p = tz.quests.points().find((x) => x.objectiveId === fly.objectiveId);
      if (p && tz.quests.flyTo(fly.objectiveId)) notes.push(`flew to #${p.badge}`);
    }

    // A map switch reloads the page and throws away everything on screen, so the assistant may ask
    // for it but never do it (red team #6): the card offers a chip and the player decides.
    const jump = actions.find((a) => a.type === 'switchMap' && typeof a.map === 'string' && a.map !== mapKey);
    if (jump) notes.push(`this one is on ${jump.map}`);
    return notes.join(' · ');
  }

  /** Perform the switch the answer asked for. Called from the card's chip — never automatically. */
  function switchMap(map, objectiveId = null) {
    if (!map || map === mapKey) return false;
    // the quest slugs are already in ?quest= (quests.js writes them), so the reload keeps them
    try {
      sessionStorage.setItem(HANDOFF, JSON.stringify({ map, objectiveId, turns: history.slice(-2) }));
    } catch { /* private mode — the switch still works, just without the transcript */ }
    const url = new URL(location.href);
    url.searchParams.set('map', map);
    url.hash = '';
    location.assign(url);
    return true;
  }

  /* ----------------------------------------------------------------- ask --- */

  async function ask(text) {
    const message = String(text ?? '').trim();
    if (!message || busy) return;
    setOpen(true);
    el.input.value = '';
    el.chips.hidden = true;
    sayUser(message);
    history.push({ role: 'user', content: message });
    busy = true;
    el.form.classList.add('busy');
    const wait = thinking();

    inflight?.abort();
    inflight = new AbortController();
    try {
      const r = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: inflight.signal,
        body: JSON.stringify({
          message,
          map: mapKey,
          selectedQuests: tz.quests.selected(),
          // What the GAME says the player is on (companion -> relay -> live.js -> quests.js), as
          // tarkov.dev task ids. Empty without a companion; the server treats it as optional, so an
          // older deployment simply ignores the field. See docs/plans/ACTIVE-QUESTS.md.
          activeQuests: tz.quests.active?.() ?? [],
          history: history.slice(0, -1).slice(-MAX_TURNS),
        }),
      });
      const data = await r.json().catch(() => null);
      wait.remove();
      if (!r.ok || !data) {
        history.pop();
        sayError(data?.error || (r.status === 429 ? 'Too many questions — try again in a minute.' : `The assistant is unavailable (${r.status}).`));
        return;
      }
      history.push({ role: 'assistant', content: data.answer });
      if (history.length > MAX_TURNS * 2) history = history.slice(-MAX_TURNS * 2);
      const msg = bubble('bot', mdLite(data.answer));
      const actions = Array.isArray(data.actions) ? data.actions : [];
      const note = await perform(actions);
      if (note) msg.insertAdjacentHTML('beforeend', `<div class="ask-did">${esc(note)}</div>`);
      onAnswer?.({ answer: data.answer, actions, note });
      scroll();
    } catch (e) {
      wait.remove();
      history.pop();
      if (e?.name !== 'AbortError') {
        sayError(import.meta.env?.DEV
          ? 'No answer — is `vercel dev` running on :3000? (npm run dev proxies /api/assistant to it.)'
          : 'The assistant could not be reached. Try again in a moment.');
      }
    } finally {
      busy = false;
      el.form.classList.remove('busy');
      inflight = null;
    }
  }

  /* ---------------------------------------------------------------- panel -- */

  /** The Ask panel is one of the shell's transient panels; this only asks it to show/hide. */
  const panelOpen = () => panel?.isOpen?.() ?? !el.body.hidden;
  function setOpen(open) {
    panel?.setOpen?.(!!open);
    el.toggle.setAttribute('aria-expanded', String(!!open));
    store.set('askOpen', !!open);
    if (!open) return;
    scroll();
  }

  /** Show a question and the waiting state without calling the API (QA screenshots, ?q=?…). */
  function preview(text) {
    setOpen(true);
    el.chips.hidden = true;
    sayUser(String(text ?? ''));
    thinking();
  }

  function init() {
    renderChips();
    el.toggle.onclick = () => setOpen(!panelOpen());
    el.form.onsubmit = (e) => { e.preventDefault(); ask(el.input.value); };
    // ?ask=1 opens the card; ?ask=<question> opens it and asks — a shareable "show me this" link.
    // The card is an overlay over the map, so unlike the old panel it does not reopen on load.
    const param = new URLSearchParams(location.search).get('ask');
    if (param != null) setOpen(true);
    else el.toggle.setAttribute('aria-expanded', String(panelOpen()));
    if (param && param !== '1') setTimeout(() => ask(param.slice(0, 2000)), 300);

    // finish a map switch that the assistant asked for
    let pending = null;
    try { pending = JSON.parse(sessionStorage.getItem(HANDOFF) || 'null'); sessionStorage.removeItem(HANDOFF); } catch { /* ignore */ }
    if (pending && pending.map === mapKey) {
      setOpen(true);
      for (const t of pending.turns ?? []) {
        history.push(t);
        if (t.role === 'user') sayUser(t.content);
        else bubble('bot', mdLite(t.content));
      }
      el.chips.hidden = (pending.turns ?? []).length > 0;
      // quests.js restores ?quest= just after its own load() resolves, so the marker we want may
      // not exist for another tick — retry briefly rather than racing it.
      tz.quests.all().then(async () => {
        let done = false;
        for (let i = 0; i < 12 && pending.objectiveId && !done; i++) {
          done = tz.quests.flyTo(pending.objectiveId);
          if (!done) await new Promise((r) => setTimeout(r, 120));
        }
        bubble('bot', `<p>Switched to <strong>${esc(mapKey)}</strong>.</p>${done ? '<div class="ask-did">flew to the first objective</div>' : ''}`, 'ask-note');
      });
    }
  }

  return {
    init, setOpen, ask, preview, switchMap,
    getHistory: () => history.slice(-10),
    focus: () => { setOpen(true); el.input.focus(); },
  };
}
