/**
 * TarkovZero — the assistant (client half).
 *
 * Sends the question plus the map context to /api/assistant (a Vercel function that does the
 * retrieval and talks to DeepSeek — the key never leaves the server), hands the reply to the panel
 * in the upper-left dock (`src/assistant-panel.js`), and *performs* the actions that came back
 * through `window.tz`: put a quest's objectives on the map, fly to the first one.
 *
 * Three rules this file keeps:
 *
 * 1. **The envelope is validated before anything is done with it.** `validateEnvelope()` in
 *    src/assistant-contract.js re-checks every shape claim client-side, so a UI bug or a stale
 *    deployment degrades to "prose with no buttons" instead of firing an action at data that is
 *    not there. Nothing here reads `data.actions` raw.
 * 2. **Nothing is performed for a stale answer.** The actions this file replays are exactly the
 *    ones the panel drew buttons for, and the panel draws none when the echoed map is not the
 *    tab's map — so an answer that outlived a map switch cannot move the camera.
 * 3. **A map switch is offered, never taken.** It reloads the page; only a click does that.
 *    The pending action + the last exchange ride across in sessionStorage so the panel can finish
 *    the job on the other side instead of looking broken.
 *
 * Chat history is kept in memory only.
 */
import { createAskPanel } from './assistant-panel.js';
import { emptyEnvelope, validateEnvelope } from './assistant-contract.js';

const HANDOFF = 'tz:askPending';
const MAX_TURNS = 8;
const CHIPS = [
  'How do I do Abandoned Cargo?',
  "What's on this map for Prapor?",
  'Which quests are on this map?',
];

/** The no-op assistant, for a document that does not carry the panel (tests, a trimmed build). */
const DEAD = {
  init() {}, setOpen() {}, isOpen: () => false, ask() {}, preview() {}, armUndo() {},
  switchMap: () => false, getHistory: () => [], focus() {}, setMap() {},
};

/**
 * @param {object} deps
 * @param {string} deps.mapKey                 the map this tab is on
 * @param {object} deps.tz                     window.tz
 * @param {object} deps.shell                  src/shell.js — owns the panel's open/close/pin
 * @param {(text:string)=>void} [deps.route]   send a user-initiated question through the omnibox,
 *                                             which is where the Restore snapshot is taken
 */
export function createAssistant({ mapKey, tz, shell, route }) {
  let history = [];       // [{role, content}] — memory only
  let busy = false;
  let inflight = null;
  let undo = null;        // armed by the omnibox for the next answer

  /** A starter chip or the composer is a question the player asked, so it takes the same road a
   *  typed question does: through the omnibox, which is the only place the camera + selection
   *  snapshot behind the Restore button is taken. Calling `ask` directly would fly the map with
   *  no way back. */
  const askFromUser = (text) => (route ? route(text) : ask(text));

  const panel = createAskPanel({
    mapKey, shell, chips: CHIPS,
    act: (action) => performOne(action),
    onAsk: (text) => askFromUser(text),
  });
  if (!panel) return DEAD;

  /* -------------------------------------------------------------- actions -- */

  /**
   * Run the answer's actions against the map. Takes the VALIDATED actions the panel drew buttons
   * from, so a stale envelope (zero buttons) performs nothing at all.
   * Returns the one-line confirmation.
   */
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
    // for it but never do it (red team #6): the panel offers a button and the player decides. It
    // is deliberately NOT mentioned here — the button beside this line already says "Switch to
    // Woods", and a note repeating it is the same fact twice in two voices.
    return notes.join(' · ');
  }

  /** One action, from a button click. `showImages` never reaches here — the panel owns the strip. */
  async function performOne(action) {
    if (!action || typeof action !== 'object') return;
    if (action.type === 'switchMap') { switchMap(action.map, action.objectiveId ?? null); return; }
    if (action.type === 'selectQuest') { await tz.quests.all(); tz.quests.select(action.slug); return; }
    if (action.type === 'flyTo') { await tz.quests.all(); tz.quests.flyTo(action.objectiveId); }
  }

  /** Perform the switch the answer asked for. Called from a button — never automatically. */
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
    panel.setOpen(true);
    panel.clearInput();
    panel.hideChips();
    panel.sayUser(message);
    history.push({ role: 'user', content: message });
    busy = true;
    panel.busy(true);
    const wait = panel.thinking();
    // The map this question was asked ON. The picker navigates, so a live map change kills the
    // document and this request with it; the echoed map is still checked on arrival, because a
    // cache, a replayed transcript or a future in-place switch can all put an answer in front of
    // the wrong map — and `validateEnvelope` is the only thing that would notice.
    const askedMap = mapKey;

    inflight?.abort();
    inflight = new AbortController();
    try {
      const r = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: inflight.signal,
        body: JSON.stringify({
          message,
          map: askedMap,
          selectedQuests: tz.quests.selected(),
          // What the GAME says the player is on (companion -> relay -> live.js -> quests.js), as
          // tarkov.dev task ids. Empty without a companion; the server treats it as optional, so an
          // older deployment simply ignores the field. See docs/plans/ACTIVE-QUESTS.md.
          // Called without `?.` on purpose: window.tz.quests.active() always exists, and optional
          // chaining would turn a rename into a permanently empty field — the feature dying quietly
          // with no error and nothing failing.
          activeQuests: tz.quests.active(),
          history: history.slice(0, -1).slice(-MAX_TURNS),
        }),
      });
      const data = await r.json().catch(() => null);
      wait.remove();
      if (!r.ok || !data) {
        history.pop();
        panel.sayError(data?.error || (r.status === 429 ? 'Too many questions — try again in a minute.' : `The assistant is unavailable (${r.status}).`));
        return;
      }
      const env = validateEnvelope(data, { map: mapKey });
      history.push({ role: 'assistant', content: env.answer });
      if (history.length > MAX_TURNS * 2) history = history.slice(-MAX_TURNS * 2);
      const drawn = panel.answer(data, { undo });
      undo = null;
      // The actions the panel drew buttons for — empty when the envelope is stale, so a reply that
      // outlived a map switch is read, never replayed.
      const note = await perform(drawn.view.buttons.map((b) => b.action));
      panel.saidDid(drawn.el, note);
    } catch (e) {
      wait.remove();
      history.pop();
      if (e?.name !== 'AbortError') {
        panel.sayError(import.meta.env?.DEV
          ? 'No answer — is `vercel dev` running on :3000? (npm run dev proxies /api/assistant to it.)'
          : 'The assistant could not be reached. Try again in a moment.');
      }
    } finally {
      busy = false;
      panel.busy(false);
      inflight = null;
    }
  }

  /* ---------------------------------------------------------------- panel -- */

  /** Show a question and the waiting state without calling the API (QA screenshots, ?q=?…). */
  function preview(text) {
    panel.setOpen(true);
    panel.hideChips();
    panel.sayUser(String(text ?? ''));
    panel.thinking();
  }

  function init() {
    panel.init();

    // ?ask=1 opens the panel; ?ask=<question> opens it and asks — a shareable "show me this" link.
    const param = new URLSearchParams(location.search).get('ask');
    if (param != null) panel.setOpen(true);
    if (param && param !== '1') setTimeout(() => ask(param.slice(0, 2000)), 300);

    // finish a map switch that the assistant asked for
    let pending = null;
    try { pending = JSON.parse(sessionStorage.getItem(HANDOFF) || 'null'); sessionStorage.removeItem(HANDOFF); } catch { /* ignore */ }
    if (pending && pending.map === mapKey) {
      panel.setOpen(true);
      for (const t of pending.turns ?? []) {
        history.push(t);
        // Replayed turns are prose only: whatever buttons the other map's answer had do not apply
        // here, and an empty envelope is the one shape that cannot smuggle one across.
        if (t.role === 'user') panel.sayUser(t.content);
        else panel.answer(emptyEnvelope(mapKey, t.content));
      }
      if ((pending.turns ?? []).length) panel.hideChips();
      // quests.js restores ?quest= just after its own load() resolves, so the marker we want may
      // not exist for another tick — retry briefly rather than racing it.
      tz.quests.all().then(async () => {
        let done = false;
        for (let i = 0; i < 12 && pending.objectiveId && !done; i++) {
          done = tz.quests.flyTo(pending.objectiveId);
          if (!done) await new Promise((r) => setTimeout(r, 120));
        }
        panel.sayNote(done
          ? `Switched to ${mapKey} — flew to the first objective.`
          : `Switched to ${mapKey}.`);
      });
    }
  }

  return {
    init, ask, preview, switchMap,
    setOpen: (on) => panel.setOpen(on),
    isOpen: () => panel.isOpen(),
    /** The omnibox arms the Restore button just before it sends a question. */
    armUndo: (fn) => { undo = typeof fn === 'function' ? fn : null; },
    /** The tab changed map: every answer already on screen is about a different one. */
    setMap: (k) => { mapKey = String(k ?? mapKey); panel.setMap(mapKey); },
    getHistory: () => history.slice(-10),
    focus: () => panel.focus(),
  };
}
