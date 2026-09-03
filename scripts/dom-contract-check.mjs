#!/usr/bin/env node
/**
 * DOM contract check (Codex red team finding #7).
 *
 * The panels are chrome; the ids and data-attributes inside them are an API that src/main.js,
 * src/quests.js, src/live.js and src/assistant.js bind to by hand. Moving a block from the old rail
 * into a panel must not quietly drop one — a missing id is a silent no-op at runtime, not an error.
 * So the contract is written down here and asserted against index.html on every `npm run check:dom`.
 *
 * Zero dependencies: a small tag-stream parser builds a tree, and a small matcher understands the
 * subset of CSS we need (tag, #id, .class, [attr], [attr=value], descendant and CHILD `>`
 * combinators). The child combinator earns its place in the RETIRED table: "the omnibox is not a
 * bar hanging off #stage any more" is a claim about PARENTAGE, and a descendant selector cannot
 * make it — #panel-ask is itself inside #stage, so `#stage #omnibox` matches the new home too.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Every selector the JS depends on, grouped by the module that binds it. */
export const CONTRACT = {
  'shell / stage': [
    '#app', '#stage', '#map', '#map3d', '#toast', '#quest-card',
    '#toolbar', '#dock', '#dock-left',
    '#panel-layers', '#panel-quests', '#panel-view', '#panel-live', '#panel-ask',
    // Two dock columns since 2026-09-02: the four lookups hang off the right toolbar in #dock, the
    // assistant is #panel-ask in #dock-left (upper-left of the map). shell.js drives both from one
    // PANELS list, so every panel owes this contract a button, a toolbar item and a close control.
    '[data-panel-btn=layers]', '[data-panel-btn=quests]', '[data-panel-btn=view]', '[data-panel-btn=live]', '[data-panel-btn=ask]',
    '.tb-item[data-tb=layers]', '.tb-item[data-tb=quests]', '.tb-item[data-tb=view]', '.tb-item[data-tb=live]', '.tb-item[data-tb=ask]',
    '[data-pin=layers]', '[data-pin=quests]', '[data-pin=ask]',
    '[data-close=layers]', '[data-close=quests]', '[data-close=view]', '[data-close=live]', '[data-close=ask]',
    // The Ask panel floats: shell.js drags it by `.panel-hd`, resizes it by `[data-grip]` and
    // collapses it with `[data-min]`. Lose the grip and the panel can never be made taller again;
    // lose the minimise button and "minimised" is only reachable by double-click.
    '#panel-ask .panel-hd', '[data-min=ask]', '[data-grip=ask]',
  ],
  'map chip + status (main.js)': [
    '.head-id', '#map-switcher', '.map-title-text', '#map-menu',
    '#status', '#status .status-text', '#status .dot', '#status-pop',
  ],
  'view toggle (main.js)': [
    '#view-toggle', '#view-toggle .seg-cell[data-view=2d]', '#view-toggle .seg-cell[data-view=3d]',
  ],
  'layers panel (main.js)': ['#layers', '#all-on', '#all-off'],
  'quests panel (quests.js)': [
    '#quest-block', '#quest-toggle', '#quests', '#quest-sum',
    '#quest-find', '#quest-results', '#quest-vis', '#quest-vis-ico', '#quest-vis-n', '#quest-selected',
  ],
  // "My quests" — the game's own quest log, above the search (docs/plans/ACTIVE-QUESTS.md).
  'my quests (quests.js + live.js)': [
    '#quest-mine', '#quest-mine-n', '#quest-auto', '#quest-mine-since', '#quest-mine-list',
    '#quest-mine-other', '#quest-mine-other-n', '#quest-mine-other-list',
    '#quest-mine-done', '#quest-mine-done-n', '#quest-mine-done-list',
  ],
  'view panel (main.js)': [
    '#base-toggle', '#base-toggle .seg-cell[data-base=satellite]', '#base-toggle .seg-cell[data-base=map]',
    '#look-toggle', '#look-toggle .seg-cell[data-look=realistic]', '#look-toggle .seg-cell[data-look=vector]',
    '#relief-toggle', '#relief-toggle .seg-cell[data-relief=1]', '#relief-toggle .seg-cell[data-relief=2]',
    '#relief-toggle .seg-cell[data-relief=3]',
    '#trees-toggle', '#trees-toggle .seg-cell[data-trees=1]', '#trees-toggle .seg-cell[data-trees=0]',
    '#rocks-toggle', '#rocks-toggle .seg-cell[data-rocks=1]', '#rocks-toggle .seg-cell[data-rocks=0]',
    '#label-density', '#label-density .seg-cell[data-density=auto]', '#label-density .seg-cell[data-density=off]',
    '#label-density .seg-cell[data-density=key]', '#label-density .seg-cell[data-density=all]',
    '#help-btn', '#hint3d',
  ],
  // #tb-live is the toolbar's GPS indicator. It is dereferenced with no null guard on the BOOT path
  // (main.js updateLiveToolbar -> tbLive.dataset), before window.tz exists, so losing it is not the
  // silent no-op this contract usually guards — it is a blank page. The [data-panel-btn=live] entry
  // above matches the same element by a different attribute and would not have caught an id rename.
  'live panel (main.js + live.js)': [
    '#live-block', '#live', '#live-toggle', '#live-sum', '#live-dot', '#tb-live',
    '.tb-item[data-tb=live] .tb-tip',
  ],
  // The assistant panel (2026-09-02): #ask-log / #ask-chips came back out of the omnibox card into
  // #panel-ask. src/assistant-panel.js binds each by id; a missing one is a silent no-op.
  'assistant panel (assistant-panel.js)': [
    '#panel-ask', '#tb-ask', '#ask-log', '#ask-chips',
    '.tb-item[data-tb=ask] .tb-tip',
  ],
  // The omnibox (2026-09-02, founder: "lets remove the bar from the bottom" then "omni bar should
  // be first"). These selectors are DESCENDANTS of #panel-ask on purpose: an element lives in one
  // place, so asserting the omnibox is inside the panel is the same assertion as "there is no
  // persistent bar at the bottom of the screen" — and unlike a `hidden` attribute it cannot be
  // satisfied by a second copy. `[data-focus]` is what shell.js moves the keyboard to when the
  // panel is revealed; without it focus lands on the header's pin button.
  'omnibox, inside the Ask panel (omnibox.js)': [
    '#panel-ask #omnibox', '#panel-ask #find', '#panel-ask #find-kbd', '#panel-ask #find-results',
    '#panel-ask #find[data-focus]',
  ],
  // `#hud-north svg` is the compass needle: main.js binds it at module scope and writes its --rot on
  // every updateHud(), un-guarded, so the inner element is as load-bearing as the button around it.
  'hud (main.js)': [
    '#hud-zin', '#hud-zout', '#hud-north', '#hud-north svg', '#hud-fit',
    '#coords', '#scale', '#scale .scale-cap', '#scale .scale-line i',
  ],
};

/**
 * Selectors that must NOT exist — a retired feature's own markup.
 *
 * A deletion checked only by removing rows from CONTRACT is not checked at all: the suite would
 * stay green if the markup came back, or if it had never left and only its CSS had been dropped
 * (`display:none` on a control the keyboard can still reach is exactly the "hidden, not gone"
 * failure this file is here to catch). So the floor selector is asserted ABSENT, cell by cell.
 */
export const RETIRED = {
  // Removed 2026-09-02, founder: "remove the floor filter not needed, these maps are for viewing
  // from above and its too much work to make the floors have usability.. so floor system fully out
  // the project". The marker-level vocabulary (UNDERGROUND badge, dashed extract outline) is a
  // different feature and stays — it lives in src/icons.js, not in this markup.
  'floor selector (retired 2026-09-02)': [
    '#floors', '.tb-floors', '.tb-floors-cap', '.seg-v', '[data-floor]',
    '#floors .seg-cell[data-floor=all]', '#floors .seg-cell[data-floor=U]',
  ],
  // Retired 2026-09-02, founder: "move the AI chat to there" (a box in the upper-left of the map).
  // The assistant card that floated over the omnibox is gone — not hidden — so there is exactly ONE
  // conversation and one place answers live. Its old shell inside #panel-ask (a permanently hidden
  // #ask-block / #ask-toggle) went with it: that panel is a real panel again.
  'omnibox assistant card (retired 2026-09-02)': [
    '#ask-card', '.askcard', '#ask-history', '#ask-card-x', '#ask-acts',
    '#ask-block', '#ask-toggle', '#ask', '.ask-head', '.block-ask',
  ],
  // Retired 2026-09-02, founder: "lets remove the bar from the bottom", then (over a mock-up)
  // "omni bar should be first". The omnibox is now the first element INSIDE #panel-ask, and the
  // panel's own composer went with the bar: one input, one router. Two entry points to the same
  // field is the parallel system this removal exists to prevent — and a send button that did not
  // go through `route()` would have asked the model "> 3d".
  //
  // `#panel-ask #omnibox` in the contract above is the positive half of this pair. This half is
  // what catches a bar being ADDED BACK beside it: #app > #stage > #omnibox is the old bar's
  // parentage, and a second copy of any of these ids would break both binders at once.
  'persistent omnibox bar + panel composer (retired 2026-09-02)': [
    '#app > #stage > #omnibox', '.find-ask',
    '#ask-form', '#ask-input', '#ask-send',
  ],
};

/* ------------------------------------------------------------------ parser -- */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const TAG_RE = /<(\/)?([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/)?>/g;
const ATTR_RE = /([\w:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseAttrs(raw) {
  const out = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(raw))) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}

/** Parse HTML into a tree of {tag, attrs, classes, children}. Good enough for our own markup. */
export function parse(html) {
  const src = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<!doctype[^>]*>/gi, '');
  const rootNode = { tag: '#root', attrs: {}, classes: new Set(), children: [] };
  const stack = [rootNode];
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(src))) {
    const [, closing, tagRaw, attrRaw, selfClose] = m;
    const tag = tagRaw.toLowerCase();
    if (closing) {
      const i = stack.findLastIndex((n) => n.tag === tag);
      if (i > 0) stack.length = i;
      continue;
    }
    const attrs = parseAttrs(attrRaw ?? '');
    const node = { tag, attrs, classes: new Set((attrs.class ?? '').split(/\s+/).filter(Boolean)), children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClose && !VOID.has(tag)) stack.push(node);
  }
  return rootNode;
}

/* ----------------------------------------------------------------- matcher -- */
const PART_RE = /^([a-zA-Z][\w-]*)?((?:[#.][\w-]+|\[[^\]]+\])*)$/;

function parsePart(part) {
  const m = PART_RE.exec(part);
  if (!m) throw new Error(`unsupported selector part: ${part}`);
  const spec = { tag: m[1]?.toLowerCase() ?? null, id: null, classes: [], attrs: [] };
  for (const bit of (m[2] ?? '').match(/[#.][\w-]+|\[[^\]]+\]/g) ?? []) {
    if (bit[0] === '#') spec.id = bit.slice(1);
    else if (bit[0] === '.') spec.classes.push(bit.slice(1));
    else {
      const inner = bit.slice(1, -1);
      const eq = inner.indexOf('=');
      if (eq < 0) spec.attrs.push([inner.trim().toLowerCase(), null]);
      else spec.attrs.push([inner.slice(0, eq).trim().toLowerCase(), inner.slice(eq + 1).trim().replace(/^["']|["']$/g, '')]);
    }
  }
  return spec;
}

const matches = (node, spec) =>
  (!spec.tag || node.tag === spec.tag) &&
  (!spec.id || node.attrs.id === spec.id) &&
  spec.classes.every((c) => node.classes.has(c)) &&
  spec.attrs.every(([k, v]) => k in node.attrs && (v === null || node.attrs[k] === v));

/** querySelectorAll for the subset above (descendant and `>` child combinators). */
export function queryAll(tree, selector) {
  const tokens = selector.trim().split(/\s+/).filter(Boolean);
  let level = [tree];
  let child = false;                       // the next spec must match a DIRECT child
  for (const token of tokens) {
    if (token === '>') { child = true; continue; }
    const spec = parsePart(token);
    const next = [];
    if (child) {
      for (const n of level) for (const c of n.children) if (matches(c, spec)) next.push(c);
    } else {
      const walk = (n) => { for (const c of n.children) { if (matches(c, spec)) next.push(c); walk(c); } };
      for (const n of level) walk(n);
    }
    child = false;
    level = next;
    if (!level.length) return [];
  }
  return level;
}

/* -------------------------------------------------------------------- run --- */
function main() {
  const file = join(root, 'index.html');
  const tree = parse(readFileSync(file, 'utf8'));
  const missing = [];
  let checked = 0;
  for (const [group, selectors] of Object.entries(CONTRACT)) {
    for (const sel of selectors) {
      checked += 1;
      if (!queryAll(tree, sel).length) missing.push(`${group}: ${sel}`);
    }
  }
  const resurrected = [];
  let retiredChecked = 0;
  for (const [group, selectors] of Object.entries(RETIRED)) {
    for (const sel of selectors) {
      retiredChecked += 1;
      const found = queryAll(tree, sel).length;
      if (found) resurrected.push(`${group}: ${sel} (${found} node${found > 1 ? 's' : ''})`);
    }
  }
  if (missing.length || resurrected.length) {
    if (missing.length) {
      console.error(`✗ index.html is missing ${missing.length} of ${checked} contract selectors:`);
      for (const m of missing) console.error(`   ${m}`);
    }
    if (resurrected.length) {
      console.error(`✗ index.html still carries ${resurrected.length} of ${retiredChecked} RETIRED selectors:`);
      for (const m of resurrected) console.error(`   ${m}`);
    }
    process.exit(1);
  }
  console.log(`✓ DOM contract: ${checked} selectors present in index.html, ${retiredChecked} retired selectors absent`);
}

main();
