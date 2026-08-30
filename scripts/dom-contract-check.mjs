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
 * subset of CSS we need (tag, #id, .class, [attr], [attr=value], descendant combinators).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Every selector the JS depends on, grouped by the module that binds it. */
export const CONTRACT = {
  'shell / stage': [
    '#app', '#stage', '#map', '#map3d', '#toast', '#quest-card',
    '#toolbar', '#dock',
    '#panel-layers', '#panel-quests', '#panel-view', '#panel-live', '#panel-ask',
    '[data-panel-btn=layers]', '[data-panel-btn=quests]', '[data-panel-btn=view]',
    '[data-panel-btn=live]', '[data-panel-btn=ask]',
    '.tb-item[data-tb=layers]', '.tb-item[data-tb=quests]', '.tb-item[data-tb=view]',
    '.tb-item[data-tb=live]', '.tb-item[data-tb=ask]',
    '[data-pin=layers]', '[data-pin=quests]',
    '[data-close=layers]', '[data-close=quests]', '[data-close=view]', '[data-close=live]', '[data-close=ask]',
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
  'view panel (main.js)': [
    '#base-toggle', '#base-toggle .seg-cell[data-base=satellite]', '#base-toggle .seg-cell[data-base=map]',
    '#relief-toggle', '#relief-toggle .seg-cell[data-relief=1]', '#relief-toggle .seg-cell[data-relief=3]',
    '#trees-toggle', '#trees-toggle .seg-cell[data-trees=1]', '#trees-toggle .seg-cell[data-trees=0]',
    '#rocks-toggle', '#rocks-toggle .seg-cell[data-rocks=1]', '#rocks-toggle .seg-cell[data-rocks=0]',
    '#label-density', '#label-density .seg-cell[data-density=off]',
    '#label-density .seg-cell[data-density=key]', '#label-density .seg-cell[data-density=all]',
    '#help-btn', '#hint3d',
  ],
  'floors (main.js — toolbar stack in 3D)': [
    '#floors', '#floors .seg-cell[data-floor=all]', '#floors .seg-cell[data-floor=0]',
    '#floors .seg-cell[data-floor=U]',
  ],
  'live panel (main.js + live.js)': ['#live-block', '#live', '#live-toggle', '#live-sum', '#live-dot'],
  'ask panel (assistant.js)': ['#ask-block', '#ask-toggle', '#ask', '#ask-log', '#ask-chips', '#ask-form', '#ask-input'],
  'omnibox (main.js)': ['#omnibox', '#find', '#find-kbd', '#find-results'],
  'hud (main.js)': [
    '#hud-zin', '#hud-zout', '#hud-north', '#hud-fit',
    '#coords', '#scale', '#scale .scale-cap', '#scale .scale-line i',
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

/** querySelectorAll for the subset above (descendant combinators only). */
export function queryAll(tree, selector) {
  const parts = selector.trim().split(/\s+/).map(parsePart);
  let level = [tree];
  for (const spec of parts) {
    const next = [];
    const walk = (n) => { for (const c of n.children) { if (matches(c, spec)) next.push(c); walk(c); } };
    for (const n of level) walk(n);
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
  if (missing.length) {
    console.error(`✗ index.html is missing ${missing.length} of ${checked} contract selectors:`);
    for (const m of missing) console.error(`   ${m}`);
    process.exit(1);
  }
  console.log(`✓ DOM contract: ${checked} selectors present in index.html`);
}

main();
