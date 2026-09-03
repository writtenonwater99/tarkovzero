/**
 * The assistant PANEL — the upper-left dock conversation (src/assistant-panel.js).
 *
 * scripts/test-assistant.mjs covers what the server mints; scripts/assistant-handler-test.mjs
 * covers the transport. This file covers what a player actually sees, and it exists because the
 * three ways this feature can lie are all invisible from the other two suites:
 *
 *   1. a button built by reading the PROSE ("want to move to that map?") instead of the envelope's
 *      structured actions — it would look right in every screenshot and fire at data nobody checked;
 *   2. a STALE answer (echoed map ≠ the tab's map) whose actions still get replayed;
 *   3. an image that fails to load leaving a broken frame, or `imageIndexOk:false` — the index was
 *      unreadable, i.e. UNKNOWN — rendering as the much stronger claim "there are no photos".
 *
 * Every assertion below is written so that removing the thing it protects turns it red; the
 * discrimination runs are recorded in the session report.
 *
 *   node --test scripts/assistant-panel-test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { mountDocument } from './lib/fake-dom.mjs';
import {
  answerView, actionButtons, sourceView, mdLite, safeHttps, createAskPanel,
} from '../src/assistant-panel.js';
import { validateEnvelope, PROTOCOL_VERSION } from '../src/assistant-contract.js';

/* ---------------------------------------------------------------- fixtures -- */

const OBJ_A = '5ac2426c86f774138762edfe';   // 24 hex — OBJECTIVE_ID_RE
const OBJ_B = '5d25b6be86f77444001e1b89';
const HOST = 'https://static.wikia.nocookie.net/escapefromtarkov_gamepedia/images';

const envelope = (over = {}) => ({
  protocol: PROTOCOL_VERSION,
  map: 'customs',
  answer: 'The cargo sits behind the warehouse on the east side.',
  actions: [],
  images: [],
  imageIndexOk: true,
  quests: [],
  sources: [],
  ...over,
});

const image = (i = 0, over = {}) => ({
  id: `img${i + 1}`,
  url: `${HOST}/shot${i}.jpg`,
  caption: `Caption ${i}`,
  depicts: `What shot ${i} shows`,
  map: 'customs',
  questSlug: 'abandoned-cargo',
  questName: 'Abandoned Cargo',
  objectiveId: null,
  credit: 'EFT Wiki (CC BY-NC-SA)',
  ...over,
});

/** The prose the model writes when the subject is on another map. It is NEVER a button source. */
const PROSE_PROMISING_A_SWITCH =
  'Kill the Scavs at the sawmill.\n\nThis quest is on **Woods** — want to move to that map? '
  + 'Switch to Woods and I will mark the sawmill for you.';

const SWITCH_TO_WOODS = {
  type: 'switchMap', map: 'woods', label: 'Woods',
  slug: 'the-punisher-part-4', name: 'The Punisher - Part 4', objectiveId: OBJ_B,
};

/* ------------------------------------------------------------------- DOM ---- */

function mountPanel({ mapKey = 'customs', chips = [] } = {}) {
  const doc = mountDocument([
    ['section', 'panel-ask'],
    ['div', 'ask-log'],
    ['div', 'ask-chips'],
    ['form', 'ask-form'],
    ['input', 'ask-input'],
  ]);
  globalThis.document = doc;
  const open = new Set();
  const calls = [];
  const shell = {
    isOpen: (n) => open.has(n),
    setOpen: (n, on) => { calls.push(['setOpen', n, !!on]); if (on) open.add(n); else open.delete(n); },
  };
  const panel = createAskPanel({
    mapKey, shell, chips,
    act: (a) => calls.push(['act', a]),
    onAsk: (t) => calls.push(['onAsk', t]),
  });
  return { doc, panel, calls, shell, log: doc.getElementById('ask-log') };
}

const buttonsIn = (root) => root.querySelectorAll('.ask-act');
const labelsIn = (root) => buttonsIn(root).map((b) => b.textContent);

/* ========================================================================== *
 *  1. Buttons are built from `actions`. Never from the prose.
 * ========================================================================== */

test('prose that promises a map switch, with NO actions, produces zero buttons', () => {
  const view = answerView(envelope({ answer: PROSE_PROMISING_A_SWITCH, actions: [] }), { map: 'customs' });
  assert.equal(view.buttons.length, 0,
    `the prose says "want to move to that map?" and the envelope carries no actions — buttons: ${JSON.stringify(view.buttons.map((b) => b.label))}`);
  // …and the prose itself is still rendered in full: withholding the button is not censoring the answer.
  assert.match(view.answerHtml, /want to move to that map/);
});

test('the same prose WITH a switchMap action produces exactly one, labelled from the action', () => {
  const view = answerView(envelope({ answer: PROSE_PROMISING_A_SWITCH, actions: [SWITCH_TO_WOODS] }), { map: 'customs' });
  assert.equal(view.buttons.length, 1);
  assert.equal(view.buttons[0].kind, 'map');
  assert.equal(view.buttons[0].label, 'Switch to Woods');
  assert.equal(view.buttons[0].action, SWITCH_TO_WOODS);
  assert.match(view.buttons[0].title, /The Punisher - Part 4/);
});

test('an action the prose never mentions still gets its button — the two are unrelated', () => {
  const view = answerView(envelope({
    answer: 'Here it is.',
    actions: [{ type: 'selectQuest', slug: 'abandoned-cargo', name: 'Abandoned Cargo' }],
  }), { map: 'customs' });
  assert.deepEqual(view.buttons.map((b) => b.label), ['Show Abandoned Cargo']);
});

test('the DOM agrees: zero <button> under an answer whose prose begs for one', () => {
  const { panel, log } = mountPanel();
  panel.answer(envelope({ answer: PROSE_PROMISING_A_SWITCH, actions: [] }));
  assert.equal(buttonsIn(log).length, 0, `rendered: ${JSON.stringify(labelsIn(log))}`);
  panel.answer(envelope({ answer: PROSE_PROMISING_A_SWITCH, actions: [SWITCH_TO_WOODS] }));
  assert.deepEqual(labelsIn(log), ['Switch to Woods']);
});

test('a switchMap button never performs itself — it only calls back on a click', () => {
  const { panel, log, calls } = mountPanel();
  panel.answer(envelope({ answer: PROSE_PROMISING_A_SWITCH, actions: [SWITCH_TO_WOODS] }));
  assert.equal(calls.filter((c) => c[0] === 'act').length, 0, 'rendering an answer performed an action');
  buttonsIn(log)[0].onclick();
  assert.deepEqual(calls.filter((c) => c[0] === 'act').map((c) => c[1].type), ['switchMap']);
});

test('the omnibox’s Restore button is not an action button', () => {
  // It is a client affordance (put the camera and the selection back), so it must not wear the
  // class that means "this came out of the envelope" — otherwise the assertion above is one button
  // softer than it reads. e2e step 9 found exactly this.
  const { panel, log } = mountPanel();
  let restored = 0;
  panel.answer(envelope({ answer: PROSE_PROMISING_A_SWITCH, actions: [] }), { undo: () => { restored += 1; } });
  assert.equal(buttonsIn(log).length, 0, `Restore was counted as an action button: ${JSON.stringify(labelsIn(log))}`);
  const undo = log.querySelector('.ask-undo');
  assert.ok(undo, 'the Restore button was not rendered at all');
  undo.onclick();
  assert.equal(restored, 1);
  assert.equal(log.querySelectorAll('.ask-undo').length, 0, 'Restore stayed clickable after it ran');

  // …and only ever one on screen: it restores the view from before the LAST question.
  panel.answer(envelope(), { undo: () => {} });
  panel.answer(envelope(), { undo: () => {} });
  assert.equal(log.querySelectorAll('.ask-undo').length, 1, 'an older answer kept a Restore that no longer means anything');
});

test('the full vocabulary maps to buttons, and nothing outside it does', () => {
  const env = validateEnvelope(envelope({
    actions: [
      { type: 'selectQuest', slug: 'abandoned-cargo', name: 'Abandoned Cargo' },
      { type: 'flyTo', objectiveId: OBJ_A, slug: 'abandoned-cargo', map: 'customs' },
      SWITCH_TO_WOODS,
      { type: 'showImages', imageIds: ['img1'] },
    ],
    images: [image(0)],
  }), { map: 'customs' });
  const out = actionButtons(env, { map: 'customs' });
  assert.deepEqual(out.map((b) => b.kind), ['quest', 'fly', 'map', 'shots']);
  // `showImages` toggles the strip and is the only one that never reaches window.tz.
  assert.equal(out[3].toggles, 'images');
  // An invented type is dropped by the contract before it ever reaches a button.
  const bogus = validateEnvelope(envelope({ actions: [{ type: 'openBrowser', url: 'https://x.test' }] }), { map: 'customs' });
  assert.equal(actionButtons(bogus, { map: 'customs' }).length, 0);
});

test('showImages with no resolvable image gets no button', () => {
  // The contract drops a showImages whose ids are not in `images`; belt and braces on our side too.
  const env = { ...envelope(), actions: [{ type: 'showImages', imageIds: ['img4'] }], images: [] };
  assert.equal(actionButtons(env, { map: 'customs' }).length, 0);
});

/* ========================================================================== *
 *  2. A stale answer is read, never replayed.
 * ========================================================================== */

test('an envelope echoing another map is stale, and loses every action button', () => {
  const body = envelope({
    map: 'woods',
    answer: 'The sawmill is in the middle of the map.',
    actions: [
      { type: 'selectQuest', slug: 'the-punisher-part-4', name: 'The Punisher - Part 4' },
      { type: 'flyTo', objectiveId: OBJ_B, slug: 'the-punisher-part-4', map: 'woods' },
    ],
    images: [image(0)],
  });
  const view = answerView(body, { map: 'customs' });
  assert.equal(view.stale, true, 'validateEnvelope did not flag the map mismatch');
  assert.equal(view.buttons.length, 0, `stale answer offered: ${JSON.stringify(view.buttons.map((b) => b.label))}`);
  // The prose, the photos and the sources are still true wherever you are standing.
  assert.match(view.answerHtml, /sawmill/);
  assert.equal(view.images.length, 1);
  assert.match(view.staleNote, /Woods/);
  assert.match(view.staleNote, /Customs/);
});

test('assistant.js performs exactly the buttons the panel drew — so stale performs nothing', () => {
  // This is the seam: src/assistant.js calls perform(view.buttons.map(b => b.action)). If the panel
  // draws nothing, nothing is replayed. Assert the two lists are the same object graph.
  const body = envelope({ map: 'woods', actions: [{ type: 'selectQuest', slug: 'x-quest', name: 'X' }] });
  const stale = answerView(body, { map: 'customs' });
  assert.deepEqual(stale.buttons.map((b) => b.action), []);
  const fresh = answerView({ ...body, map: 'customs' }, { map: 'customs' });
  assert.deepEqual(fresh.buttons.map((b) => b.action.type), ['selectQuest']);
});

test('the DOM marks a stale answer and renders no buttons', () => {
  const { panel, log } = mountPanel({ mapKey: 'customs' });
  panel.answer(envelope({ map: 'woods', actions: [SWITCH_TO_WOODS] }));
  assert.equal(buttonsIn(log).length, 0);
  assert.equal(log.querySelectorAll('.ask-stale').length, 1);
});

test('switching map disables the buttons of answers already on screen', () => {
  const { panel, log } = mountPanel({ mapKey: 'customs' });
  panel.answer(envelope({ actions: [{ type: 'selectQuest', slug: 'abandoned-cargo', name: 'Abandoned Cargo' }] }));
  const [btn] = buttonsIn(log);
  assert.equal(btn.disabled, false);
  panel.setMap('woods');
  assert.equal(btn.disabled, true, 'a Customs answer kept a live button after the tab moved to Woods');
  assert.match(btn.getAttribute('title'), /Customs/);
  assert.equal(log.querySelectorAll('.ask-stale').length, 1);
  // Idempotent: a second call must not stack notes.
  panel.setMap('woods');
  assert.equal(log.querySelectorAll('.ask-stale').length, 1);
});

test('a click on a disabled button does nothing', () => {
  const { panel, log, calls } = mountPanel();
  panel.answer(envelope({ actions: [{ type: 'selectQuest', slug: 'abandoned-cargo', name: 'Abandoned Cargo' }] }));
  panel.setMap('woods');
  buttonsIn(log)[0].onclick();
  assert.equal(calls.filter((c) => c[0] === 'act').length, 0);
});

/* ========================================================================== *
 *  3. Photographs: a failed load leaves nothing, and UNKNOWN is not "none".
 * ========================================================================== */

test('images render lazily, without a referrer, from the envelope records', () => {
  const { panel, log } = mountPanel();
  panel.answer(envelope({ images: [image(0), image(1)], actions: [{ type: 'showImages', imageIds: ['img1', 'img2'] }] }));
  const imgs = log.querySelectorAll('img');
  assert.equal(imgs.length, 2);
  for (const im of imgs) {
    assert.equal(im.getAttribute('loading'), 'lazy');
    assert.equal(im.getAttribute('referrerpolicy'), 'no-referrer');
    assert.match(im.getAttribute('src'), /^https:\/\/static\.wikia\.nocookie\.net\//);
    assert.ok(im.getAttribute('alt'), 'an image with no alt text');
  }
  // The credit is a licence obligation, not decoration: it ships with the pictures.
  assert.equal(log.querySelectorAll('.ask-credit').length, 1);
  assert.match(log.querySelector('.ask-credit').textContent, /EFT Wiki/);
});

test('an image that fails to load leaves no frame behind', () => {
  const { panel, log } = mountPanel();
  panel.answer(envelope({ images: [image(0), image(1)] }));
  const [first] = log.querySelectorAll('figure');
  first.querySelector('img').onerror();
  assert.equal(log.querySelectorAll('figure').length, 1, 'the broken figure is still in the tree');
  assert.equal(log.querySelectorAll('img').length, 1);
  assert.equal(log.querySelectorAll('.ask-shots').length, 1, 'the surviving photo lost its strip');
});

test('when every image fails the strip becomes one honest line, not an empty box', () => {
  const { panel, log } = mountPanel();
  panel.answer(envelope({ images: [image(0), image(1)] }));
  for (const im of log.querySelectorAll('img')) im.onerror();
  assert.equal(log.querySelectorAll('figure').length, 0);
  assert.equal(log.querySelectorAll('img').length, 0);
  assert.equal(log.querySelectorAll('.ask-shots').length, 0, 'an empty picture strip is still on screen');
  const note = log.querySelector('.ask-shots-note');
  assert.ok(note, 'nothing said the screenshots failed');
  assert.match(note.textContent, /could not be loaded/i);
  // It failed to LOAD. It must not claim the photos do not exist.
  assert.doesNotMatch(note.textContent, /\bno (photos|images|screenshots)\b/i);
});

test('imageIndexOk:false is UNKNOWN — never "no images"', () => {
  const view = answerView(envelope({ imageIndexOk: false, images: [] }), { map: 'customs' });
  assert.equal(view.imagesUnknown, true);
  assert.ok(view.imagesNote, 'an unreadable index said nothing at all');
  assert.doesNotMatch(view.imagesNote, /\bno (photos|images|screenshots)\b/i);
  assert.doesNotMatch(view.imagesNote, /\bnone\b/i);
  assert.match(view.imagesNote, /could not be read|may be/i);

  const { panel, log } = mountPanel();
  panel.answer(envelope({ imageIndexOk: false, images: [] }));
  const note = log.querySelector('.ask-shots-note');
  assert.ok(note, 'the panel silently swallowed an unreadable image index');
  assert.doesNotMatch(note.textContent, /\bno (photos|images|screenshots)\b/i);
});

test('a healthy index with no photos says nothing at all', () => {
  // The difference that makes `imageIndexOk` worth carrying: "we looked, there are none" is silence.
  const view = answerView(envelope({ imageIndexOk: true, images: [] }), { map: 'customs' });
  assert.equal(view.imagesUnknown, false);
  assert.equal(view.imagesNote, '');
  const { panel, log } = mountPanel();
  panel.answer(envelope({ imageIndexOk: true, images: [] }));
  assert.equal(log.querySelectorAll('.ask-shots-note').length, 0);
  assert.equal(log.querySelectorAll('.ask-shots').length, 0);
});

test('the Photos button toggles the strip and never touches the map', () => {
  const { panel, log, calls } = mountPanel();
  panel.answer(envelope({ images: [image(0)], actions: [{ type: 'showImages', imageIds: ['img1'] }] }));
  const strip = log.querySelector('.ask-shots');
  const [btn] = buttonsIn(log);
  assert.equal(btn.textContent, 'Photo');
  assert.equal(strip.classList.contains('is-open'), false);
  btn.onclick();
  assert.equal(strip.classList.contains('is-open'), true);
  btn.onclick();
  assert.equal(strip.classList.contains('is-open'), false);
  assert.equal(calls.filter((c) => c[0] === 'act').length, 0, 'showImages reached the map');
});

/* ========================================================================== *
 *  4. The quests this site cannot draw — prose and photos, and it must not
 *     look like something failed.
 * ========================================================================== */

test('a quest on a map we do not ship gets no buttons and an honest source line', () => {
  const view = answerView(envelope({
    answer: 'That one is on Shoreline, at the resort.',
    actions: [],
    images: [image(0, { map: 'shoreline' })],
    sources: [{ slug: 'sanitary-standards', name: 'Sanitary Standards - Part 1', trader: 'Therapist',
      wikiLink: 'https://escapefromtarkov.fandom.com/wiki/Sanitary_Standards', maps: ['shoreline'], siteMaps: [] }],
  }), { map: 'customs' });
  assert.equal(view.buttons.length, 0);
  assert.equal(view.images.length, 1, 'the photo went missing with the buttons');
  assert.equal(view.sources.length, 1);
  assert.equal(view.sources[0].drawable, false);
  assert.match(view.sources[0].coverage, /Shoreline/);
  assert.match(view.sources[0].coverage, /does not draw/i);
});

test('a quest with no marked location anywhere says so, rather than nothing', () => {
  const s = sourceView({ slug: 'q', name: 'Q', trader: 'Prapor', maps: [], siteMaps: [] }, { map: 'customs' });
  assert.equal(s.drawable, false);
  assert.match(s.coverage, /no marked location/i);
});

test('a source on the current map reads as "marked on <this map>"', () => {
  const s = sourceView({ slug: 'q', name: 'Q', trader: 'Prapor', maps: ['customs', 'woods'], siteMaps: ['customs', 'woods'] }, { map: 'customs' });
  assert.equal(s.drawable, true);
  assert.equal(s.coverage, 'marked on Customs');
});

test('a source only on another SITE map names that map', () => {
  const s = sourceView({ slug: 'q', name: 'Q', maps: ['woods'], siteMaps: ['woods'] }, { map: 'customs' });
  assert.equal(s.coverage, 'marked on Woods');
});

test('the DOM renders sources with their wiki link, and only https ones', () => {
  const { panel, log } = mountPanel();
  panel.answer(envelope({
    sources: [
      { slug: 'a', name: 'A quest', trader: 'Prapor', wikiLink: 'https://escapefromtarkov.fandom.com/wiki/A', maps: ['customs'], siteMaps: ['customs'] },
      { slug: 'b', name: 'B quest', trader: 'Skier', wikiLink: 'javascript:alert(1)', maps: ['streets-of-tarkov'], siteMaps: [] },
    ],
  }));
  const rows = log.querySelectorAll('.ask-src');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].querySelector('a')?.getAttribute('href'), 'https://escapefromtarkov.fandom.com/wiki/A');
  assert.equal(rows[1].querySelector('a'), null, 'a javascript: wiki link became an anchor');
  assert.match(rows[1].textContent, /Streets of Tarkov/);
});

/* ========================================================================== *
 *  5. Odds and ends the panel must survive.
 * ========================================================================== */

test('a garbage body renders an empty answer instead of throwing', () => {
  for (const body of [null, undefined, 'not json', 42, { answer: { nope: true } }]) {
    const view = answerView(body, { map: 'customs' });
    assert.equal(view.buttons.length, 0);
    assert.equal(view.images.length, 0);
    assert.equal(view.sources.length, 0);
  }
  const { panel, log } = mountPanel();
  panel.answer(null);
  assert.equal(buttonsIn(log).length, 0);
});

test('an image row that is not on the allowed host never reaches an <img>', () => {
  const { panel, log } = mountPanel();
  panel.answer(envelope({
    images: [image(0, { url: 'https://evil.test/shot.jpg' }), image(1)],
    actions: [{ type: 'showImages', imageIds: ['img1', 'img2'] }],
  }));
  const srcs = log.querySelectorAll('img').map((i) => i.getAttribute('src'));
  assert.equal(srcs.length, 1);
  assert.match(srcs[0], /^https:\/\/static\.wikia\.nocookie\.net\//);
});

test('mdLite escapes the model’s prose and keeps only its own markup', () => {
  assert.match(mdLite('<script>alert(1)</script>'), /&lt;script&gt;/);
  assert.match(mdLite('**bold**'), /<strong>bold<\/strong>/);
  assert.match(mdLite('- one\n- two'), /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.equal(safeHttps('http://x.test'), null);
  assert.equal(safeHttps('https://x.test'), 'https://x.test');
});

test('the composer and the starter chips route back out through the omnibox', () => {
  const { panel, doc, calls } = mountPanel({ chips: ['Which quests are on this map?'] });
  panel.init();
  const chip = doc.getElementById('ask-chips').children[0];
  assert.equal(chip.textContent, 'Which quests are on this map?');
  chip.onclick();
  assert.deepEqual(calls.at(-1), ['onAsk', 'Which quests are on this map?']);
  doc.getElementById('ask-input').value = '  where is the cargo  ';
  doc.getElementById('ask-form').onsubmit({ preventDefault() {} });
  assert.deepEqual(calls.at(-1), ['onAsk', '  where is the cargo  ']);
  // An empty composer must not send a request.
  const before = calls.length;
  doc.getElementById('ask-input').value = '   ';
  doc.getElementById('ask-form').onsubmit({ preventDefault() {} });
  assert.equal(calls.length, before);
});

test('opening and closing goes through the shell, so the pin model is the panel system’s', () => {
  const { panel, calls, shell } = mountPanel();
  assert.equal(panel.isOpen(), false);
  panel.setOpen(true);
  assert.equal(shell.isOpen('ask'), true);
  assert.equal(panel.isOpen(), true);
  panel.setOpen(false);
  assert.equal(panel.isOpen(), false);
  assert.deepEqual(calls.filter((c) => c[0] === 'setOpen'), [['setOpen', 'ask', true], ['setOpen', 'ask', false]]);
});
