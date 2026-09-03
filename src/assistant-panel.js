/**
 * TarkovZero — the Ask panel's conversation (`#panel-ask`).
 *
 * Founder, 2026-09-02, over a screenshot with a box drawn in the upper-left of the map:
 *   "move the AI chat to there … when u ask a question like how it shows on the map also shows a
 *    picture in the chat. the AI should know what Map the tab is on so if a player asks about a
 *    question for a different map ai can help and say this quest is on woods, want to move to that
 *    map? option"
 * …then, the same day: "lets remove the bar from the bottom" and "omni bar should be first".
 *
 * So a conversation lives here: the question, the prose answer, the wiki's photographs, the
 * buttons the answer earns, and the quests it was read out of. The panel it lives in FLOATS —
 * shell.js drags, resizes and minimises it — and the omnibox sits above this log as the one place
 * anything is typed. This file owns the log and nothing else: no input, no geometry.
 *
 * ============================================================================================
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE
 * ============================================================================================
 * **Buttons come from `envelope.actions`. Nothing in here ever reads `envelope.answer`.**
 * The prose can say "this quest is on Woods, want to move to that map?" all it likes; if the
 * server did not put a `switchMap` action in the envelope, no button appears — because a button
 * built from prose is a button aimed at data nobody checked. `answerView()` is pure and takes the
 * RAW response body, running it through the contract's `validateEnvelope()` itself, so the panel
 * structurally cannot render a shape the contract did not admit.
 *
 * `validateEnvelope()` also reports `stale: true` when the echoed map is not the map this tab is
 * on. A stale answer keeps its prose, its photos and its sources — those are true wherever you
 * stand — and loses **every** action button, because `flyTo`/`selectQuest`/`switchMap` are only
 * meaningful against the map they were computed for.
 *
 * Coverage reality (docs + CLAUDE.md): quests.json covers eleven maps, this site draws three.
 * 110 quests have zones only on maps we do not ship and 339 have none at all. Those answers are
 * prose + photos + sources and NO buttons — which is a complete answer, not a failure, so the
 * sources block says where the quest actually is instead of the panel looking broken.
 */
import {
  validateEnvelope, mapLabel, isSiteMap, MAX_ACTIONS,
} from './assistant-contract.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

/** A wiki link we are willing to put in an href. https only; anything else becomes nothing. */
export function safeHttps(url) {
  if (typeof url !== 'string' || !url || url.length > 600) return null;
  try { return new URL(url).protocol === 'https:' ? url : null; } catch { return null; }
}

/* ========================================================================== *
 *  Pure view model — everything below `createAskPanel` is DOM; everything
 *  above it is a function of the envelope and the tab's map, and nothing else.
 * ========================================================================== */

/**
 * The buttons one envelope earns. STRUCTURAL: a `.map()` over `actions`, in the order the server
 * ranked them. `answer` is not a parameter of this function and never will be.
 *
 * @param {object} env  an envelope already through `validateEnvelope`
 * @param {{map:string}} ctx  the map the TAB is on
 */
export function actionButtons(env, { map } = {}) {
  const images = Array.isArray(env?.images) ? env.images : [];
  const out = [];
  for (const a of Array.isArray(env?.actions) ? env.actions : []) {
    switch (a.type) {
      case 'selectQuest':
        out.push({
          kind: 'quest', type: a.type, action: a,
          label: `Show ${a.name || a.slug}`,
          title: `Put its objectives on ${mapLabel(map)}`,
        });
        break;
      case 'flyTo':
        out.push({
          kind: 'fly', type: a.type, action: a,
          label: 'Fly to it',
          title: `Centre ${mapLabel(map)} on that objective`,
        });
        break;
      case 'switchMap': {
        // The founder's headline case. It reloads the page, so it is offered and never taken:
        // the label names the destination and the title says what lands when you get there.
        const to = a.label || mapLabel(a.map);
        out.push({
          kind: 'map', type: a.type, action: a,
          label: `Switch to ${to}`,
          title: a.objectiveId
            ? `${a.name || a.slug} is on ${to} — loads ${to} and flies straight to it`
            : `${a.name || a.slug} is on ${to} — loads ${to} and selects the quest`,
        });
        break;
      }
      case 'showImages': {
        const ids = Array.isArray(a.imageIds) ? a.imageIds : [];
        const n = ids.filter((id) => images.some((im) => im.id === id)).length;
        if (n) {
          out.push({
            kind: 'shots', type: a.type, action: a, toggles: 'images',
            label: n > 1 ? `Photos (${n})` : 'Photo',
            title: 'Show the screenshots full width',
          });
        }
        break;
      }
      default: break;
    }
  }
  return out.slice(0, MAX_ACTIONS);
}

/**
 * One retrieved quest, with honest map coverage. `drawable:false` is the "prose and photos only"
 * case: there is nothing to select, fly to or switch to, and saying WHERE it is instead is the
 * difference between a complete answer and a panel that looks like it failed.
 */
export function sourceView(s, { map } = {}) {
  if (!s || typeof s !== 'object') return null;
  const name = (typeof s.name === 'string' && s.name) || (typeof s.slug === 'string' && s.slug) || '';
  if (!name) return null;
  const maps = (Array.isArray(s.maps) ? s.maps : []).filter((m) => typeof m === 'string' && m);
  const siteMaps = (Array.isArray(s.siteMaps) ? s.siteMaps : []).filter(isSiteMap);
  const elsewhere = maps.filter((m) => !isSiteMap(m));
  let coverage;
  if (siteMaps.includes(map)) coverage = `marked on ${mapLabel(map)}`;
  else if (siteMaps.length) coverage = `marked on ${siteMaps.map(mapLabel).join(', ')}`;
  // "cannot open yet", not "does not draw yet": since 2026-09-02 this branch carries Reserve and
  // Woods, which TarkovZero DOES draw and will not open. The reader can see them in the picker.
  else if (elsewhere.length) coverage = `${elsewhere.map(mapLabel).join(', ')} — TarkovZero cannot open that map yet`;
  else coverage = 'no marked location in our data';
  return {
    name,
    trader: typeof s.trader === 'string' ? s.trader : '',
    wikiLink: safeHttps(s.wikiLink),
    coverage,
    drawable: siteMaps.length > 0,
  };
}

/**
 * Everything the panel draws for ONE answer, derived from the raw response body plus the map the
 * tab is on. Never throws; an unparseable body renders as an empty answer with no buttons.
 */
export function answerView(body, { map } = {}) {
  const env = validateEnvelope(body, { map });
  const here = isSiteMap(map) ? String(map) : env.map;
  const images = env.images.map((im) => ({
    id: im.id,
    url: im.url,
    // `depicts` is guaranteed non-empty by the contract; the fallbacks are belt and braces.
    alt: im.depicts || im.caption || im.questName || 'Quest screenshot',
    caption: typeof im.caption === 'string' ? im.caption : '',
    credit: (typeof im.credit === 'string' && im.credit) || 'EFT Wiki (CC BY-NC-SA)',
    questName: typeof im.questName === 'string' ? im.questName : '',
    map: typeof im.map === 'string' ? im.map : '',
  }));
  return {
    map: env.map,
    echoedMap: env.echoedMap ?? env.map,
    stale: env.stale,
    cached: env.cached,
    answerHtml: mdLite(env.answer),
    // `echoedMap` is the map the body SAID it was for, before the contract normalised it — the only
    // value that can name a locked map here, and therefore the only one that reads correctly.
    staleNote: env.stale
      ? `Worked out for ${mapLabel(env.echoedMap ?? env.map)} — this tab is on ${mapLabel(here)} now. Ask again for a ${mapLabel(here)} answer.`
      : '',
    // Stale ⇒ no buttons. The prose and the photos survive; the actions do not, because every one
    // of them names an objective, a quest selection or a map that only holds for `env.map`.
    buttons: env.stale ? [] : actionButtons(env, { map: here }),
    images,
    // imageIndexOk:false means the screenshot index could not be READ — that is UNKNOWN. It must
    // never render as "no photos exist", which is a different and much stronger claim.
    imagesUnknown: env.imageIndexOk === false,
    imagesNote: env.imageIndexOk === false
      ? 'The screenshot index could not be read this turn, so there may be photos for this.'
      : '',
    credit: images.length ? images[0].credit : '',
    sources: env.sources.map((s) => sourceView(s, { map: here })).filter(Boolean),
  };
}

/* ========================================================================== *
 *  DOM
 * ========================================================================== */

const IMAGES_FAILED = 'Screenshots could not be loaded.';

/**
 * @param {object} deps
 * @param {string} deps.mapKey                    the map this tab is on
 * @param {object} deps.shell                     src/shell.js — owns open/close/pin for 'ask'
 * @param {(action:object)=>void} [deps.act]      perform ONE action (a click, never automatic)
 * @param {(text:string)=>void} [deps.onAsk]      the composer's submit — routed through the omnibox
 * @param {string[]} [deps.chips]                 starter questions
 */
export function createAskPanel({ mapKey, shell, act, onAsk, chips = [] } = {}) {
  const el = {
    panel: document.getElementById('panel-ask'),
    log: document.getElementById('ask-log'),
    chips: document.getElementById('ask-chips'),
  };
  if (!el.panel || !el.log) return null;

  let here = String(mapKey ?? '');

  const node = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const scroll = () => { el.log.scrollTop = el.log.scrollHeight; };

  /* ------------------------------------------------------------- bubbles -- */
  function bubble(role, cls = '') {
    const div = node('div', `ask-msg ask-${role}${cls ? ` ${cls}` : ''}`);
    el.log.append(div);
    scroll();
    return div;
  }
  function sayUser(text) {
    const b = bubble('user');
    b.append(node('p', '', String(text ?? '')));
    scroll();
    return b;
  }
  function sayNote(text, cls = 'ask-note') {
    const b = bubble('bot', cls);
    b.append(node('p', '', String(text ?? '')));
    scroll();
    return b;
  }
  const sayError = (text) => sayNote(text, 'ask-err');
  function thinking() {
    const b = bubble('bot', 'ask-wait');
    const dots = node('span', 'ask-dots');
    for (let i = 0; i < 3; i++) dots.append(node('i'));
    b.append(dots);
    scroll();
    return b;
  }

  /* -------------------------------------------------------------- photos -- */
  /**
   * The wiki's screenshots. A failed load is removed whole — a broken <img> leaves a 0-height
   * frame with a torn-page glyph and the alt text, which reads as a bug — and when the last one
   * goes the strip becomes one honest line instead of a hole.
   */
  function shotStrip(view) {
    if (!view.images.length) {
      return view.imagesUnknown ? node('div', 'ask-shots-note', view.imagesNote) : null;
    }
    const wrap = node('div', 'ask-shots');
    let alive = view.images.length;
    for (const im of view.images) {
      const fig = document.createElement('figure');
      fig.className = 'ask-shot';
      const img = document.createElement('img');
      img.setAttribute('loading', 'lazy');
      img.setAttribute('referrerpolicy', 'no-referrer');
      img.setAttribute('alt', im.alt);
      img.setAttribute('src', im.url);
      img.onerror = () => {
        fig.remove();
        alive -= 1;
        if (alive <= 0) {
          // textContent clears the strip's children, credit line included.
          wrap.className = 'ask-shots-note';
          wrap.textContent = IMAGES_FAILED;
        }
      };
      fig.append(img);
      if (im.caption) fig.append(node('figcaption', '', im.caption));
      wrap.append(fig);
    }
    wrap.append(node('div', 'ask-credit', view.credit));
    return wrap;
  }

  /* ------------------------------------------------------------- actions -- */
  function actionRow(view, strip, undo) {
    if (!view.buttons.length && !undo) return null;
    const row = node('div', 'ask-acts');
    for (const b of view.buttons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `ask-act ask-act-${b.kind}`;
      btn.textContent = b.label;
      btn.setAttribute('title', b.title);
      btn.dataset.action = b.type;
      btn.onclick = () => {
        if (btn.disabled) return;
        if (b.toggles === 'images') {
          const on = strip?.classList?.toggle('is-open') ?? false;
          btn.classList.toggle('on', on);
          return;
        }
        act?.(b.action);
      };
      row.append(btn);
    }
    if (undo) {
      // NOT an `.ask-act`. That class means "built from an envelope action" and the tests count it;
      // Restore is a client affordance the omnibox armed (put the camera and the selection back),
      // and letting it wear the same class would have made the "buttons come from actions, never
      // from the prose" assertion softer by exactly one button. (Caught by e2e step 9.)
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ask-undo';
      btn.textContent = 'Restore view';
      btn.setAttribute('title', 'Put the camera and the quest selection back the way they were');
      btn.onclick = () => { undo(); btn.remove(); };
      row.append(btn);
    }
    return row;
  }

  /* ------------------------------------------------------------- sources -- */
  function sourceBlock(view) {
    if (!view.sources.length) return null;
    const wrap = node('div', 'ask-srcs');
    wrap.append(node('div', 'ask-srcs-cap', view.sources.length > 1 ? 'From these quests' : 'From this quest'));
    for (const s of view.sources) {
      const row = node('div', `ask-src${s.drawable ? '' : ' is-elsewhere'}`);
      if (s.wikiLink) {
        const a = document.createElement('a');
        a.className = 'ask-src-name';
        a.setAttribute('href', s.wikiLink);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener');
        a.textContent = s.name;
        row.append(a);
      } else {
        row.append(node('span', 'ask-src-name', s.name));
      }
      if (s.trader) row.append(node('span', 'ask-src-trader', s.trader));
      row.append(node('span', 'ask-src-where', s.coverage));
      wrap.append(row);
    }
    return wrap;
  }

  /* -------------------------------------------------------------- answer -- */
  /**
   * Render one answer. `body` is the RAW 200 body — the view model validates it.
   * @returns {{view:object, el:HTMLElement}}
   */
  function answer(body, { undo = null, did = '' } = {}) {
    const view = answerView(body, { map: here });
    // One Restore at a time: it puts the camera and the selection back to just before the LAST
    // question, so leaving one on every older answer offers an undo that no longer means anything.
    for (const old of el.log.querySelectorAll('.ask-undo')) old.remove();
    const box = bubble('bot', view.stale ? 'is-stale' : '');
    // The map the answer was FOR, not the normalised one — so a later `setMap()` can still name it.
    box.dataset.map = view.echoedMap;

    const prose = node('div', 'ask-prose');
    prose.innerHTML = view.answerHtml;
    box.append(prose);

    if (view.stale) box.append(node('div', 'ask-stale', view.staleNote));

    const strip = shotStrip(view);
    if (strip) box.append(strip);

    const acts = actionRow(view, strip, undo);
    if (acts) box.append(acts);

    const srcs = sourceBlock(view);
    if (srcs) box.append(srcs);

    if (did) box.append(node('div', 'ask-did', did));
    scroll();
    return { view, el: box };
  }

  /** Append the "here is what that did" line to an answer already on screen. */
  function saidDid(box, text) {
    if (!box || !text) return;
    box.append(node('div', 'ask-did', text));
    scroll();
  }

  /**
   * The tab changed map. Every answer already on screen was computed for a different one, so its
   * buttons are pointed at objectives that are not on this map — disable them and say why.
   *
   * (Today the map picker navigates, so this runs on the transcript replayed across that reload;
   * it is written to be correct for an in-place change too, because the day one lands the failure
   * would be silent — a "Fly to it" that quietly flies nowhere.)
   */
  function setMap(next) {
    here = String(next ?? '');
    for (const msg of el.log.querySelectorAll('.ask-msg')) {
      const was = msg.dataset?.map;
      if (!was || was === here || msg.classList.contains('is-stale')) continue;
      msg.classList.add('is-stale');
      for (const b of msg.querySelectorAll('.ask-act')) {
        b.disabled = true;
        b.setAttribute('aria-disabled', 'true');
        b.setAttribute('title', `Worked out for ${mapLabel(was)}`);
      }
      msg.append(node('div', 'ask-stale', `Worked out for ${mapLabel(was)} — this tab is on ${mapLabel(here)} now.`));
    }
  }

  /* --------------------------------------------------------------- shell -- */
  const isOpen = () => !!shell?.isOpen?.('ask');
  function setOpen(on, { focus = false } = {}) {
    // `reveal` also uncollapses a minimised panel and moves the keyboard to `[data-focus]` — the
    // omnibox at the top of this panel, which is the app's ONE text field.
    if (on && focus && shell?.reveal) shell.reveal('ask', { focus: true });
    else shell?.setOpen?.('ask', !!on);
    if (on) scroll();
  }

  function renderChips() {
    if (!el.chips) return;
    el.chips.textContent = '';
    for (const c of chips) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ask-chip';
      b.textContent = c;
      b.onclick = () => onAsk?.(c);
      el.chips.append(b);
    }
  }
  const hideChips = () => { if (el.chips) el.chips.hidden = true; };

  /**
   * The panel has NO input of its own. The omnibox in its header is the one text field in the app
   * (2026-09-02) — a second composer down here would be two entry points to the same router, and
   * the one that did not go through `route()` would answer `> 3d` to the model. The starter chips
   * are the only thing that starts a question from inside the panel, and they go out through the
   * same door a typed one does (`onAsk` → the omnibox).
   */
  function init() {
    renderChips();
  }

  return {
    init, setOpen, isOpen, setMap,
    answer, saidDid, sayUser, sayNote, sayError, thinking, hideChips,
    focus: () => { setOpen(true, { focus: true }); },
    busy: (on) => { el.panel?.classList?.toggle('is-busy', !!on); },
    /** QA hook: the panel element, for the walkthrough's rect assertions. */
    node: () => el.panel,
  };
}
