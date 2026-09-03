/**
 * A DOM small enough to run src/assistant-panel.js and src/omnibox.js under `node --test`.
 *
 * Why not jsdom: this repo has two devDependencies and every suite runs on bare node. Why not a
 * pure view-model test alone: the assertions that matter here are about NODES — how many buttons an
 * answer built, whether a failed <img> left a frame behind — and a test that only checks the object
 * the renderer was handed cannot see the renderer drop it on the floor.
 *
 * It is deliberately not a browser. `innerHTML` is STORED, never parsed: nothing in this codebase
 * queries inside markup it built from a string, and pretending to parse would be the more
 * dangerous lie. Everything the two modules actually call is real: createElement, append, remove,
 * classList (toggle returns the new state), dataset, textContent (which clears children, as in a
 * browser), getAttribute/setAttribute, hidden/disabled, and a querySelector(All) that understands
 * `tag`, `.class`, `#id`, `[attr]` and `[attr=value]`.
 */

let uid = 0;

class FakeClassList {
  constructor(el) { this.el = el; }
  get _set() { return this.el._classes; }
  add(...cs) { for (const c of cs) if (c) this._set.add(c); }
  remove(...cs) { for (const c of cs) this._set.delete(c); }
  contains(c) { return this._set.has(c); }
  toggle(c, force) {
    const on = force === undefined ? !this._set.has(c) : !!force;
    if (on) this._set.add(c); else this._set.delete(c);
    return on;
  }
  get length() { return this._set.size; }
  toString() { return [...this._set].join(' '); }
}

export class FakeElement {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc ?? null;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = new Proxy({}, {
      get: (t, k) => t[k],
      set: (t, k, v) => { t[k] = String(v); this.attributes.set(`data-${String(k).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`, String(v)); return true; },
    });
    this._classes = new Set();
    this.classList = new FakeClassList(this);
    this._text = '';
    this._innerHTML = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.style = {};
    this._id = `n${(uid += 1)}`;
  }

  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes = new Set(String(v ?? '').split(/\s+/).filter(Boolean)); }

  get id() { return this.attributes.get('id') ?? ''; }
  set id(v) { this.attributes.set('id', String(v)); this.ownerDocument?._register(this); }

  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) { this._innerHTML = String(v ?? ''); this.children = []; }

  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }
  set textContent(v) { this._text = String(v ?? ''); this.children = []; this._innerHTML = ''; }

  setAttribute(k, v) {
    const key = String(k).toLowerCase();
    this.attributes.set(key, String(v));
    if (key === 'class') this.className = v;
    if (key === 'id') this.ownerDocument?._register(this);
  }
  getAttribute(k) { return this.attributes.has(String(k).toLowerCase()) ? this.attributes.get(String(k).toLowerCase()) : null; }
  hasAttribute(k) { return this.attributes.has(String(k).toLowerCase()); }
  removeAttribute(k) { this.attributes.delete(String(k).toLowerCase()); }

  append(...nodes) { for (const n of nodes) this.appendChild(n); }
  appendChild(n) {
    if (!n) return n;
    n.parentNode?.removeChild(n);
    n.parentNode = this;
    this.children.push(n);
    return n;
  }
  removeChild(n) {
    const i = this.children.indexOf(n);
    if (i >= 0) { this.children.splice(i, 1); n.parentNode = null; }
    return n;
  }
  remove() { this.parentNode?.removeChild(this); }
  replaceWith(n) {
    const p = this.parentNode;
    if (!p) return;
    const i = p.children.indexOf(this);
    p.children.splice(i, 1, n);
    n.parentNode = p;
    this.parentNode = null;
  }
  contains(n) {
    for (let x = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }

  /** Depth-first descendants, document order. */
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }

  querySelectorAll(sel) {
    const specs = String(sel).split(',').map((s) => parseSpec(s.trim())).filter(Boolean);
    return [...this.walk()].filter((n) => specs.some((sp) => matches(n, sp)));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }

  getClientRects() { return [{}]; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  focus() { this.ownerDocument && (this.ownerDocument.activeElement = this); }
  blur() { if (this.ownerDocument?.activeElement === this) this.ownerDocument.activeElement = null; }
  select() {}
  scrollIntoView() {}
  addEventListener(type, fn) { (this._listeners ??= {})[type] = [...(this._listeners?.[type] ?? []), fn]; }
  removeEventListener() {}
  dispatch(type, ev = {}) { for (const fn of this._listeners?.[type] ?? []) fn(ev); }
}

function parseSpec(sel) {
  if (!sel) return null;
  const m = /^([a-zA-Z][\w-]*)?((?:[#.][\w-]+|\[[^\]]+\])*)$/.exec(sel);
  if (!m) throw new Error(`fake-dom: unsupported selector "${sel}"`);
  const spec = { tag: m[1]?.toUpperCase() ?? null, id: null, classes: [], attrs: [] };
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

const matches = (n, spec) =>
  (!spec.tag || n.tagName === spec.tag) &&
  (!spec.id || n.id === spec.id) &&
  spec.classes.every((c) => n._classes.has(c)) &&
  spec.attrs.every(([k, v]) => n.attributes.has(k) && (v === null || n.attributes.get(k) === v));

export class FakeDocument {
  constructor() {
    this._byId = new Map();
    this.body = new FakeElement('body', this);
    this.documentElement = new FakeElement('html', this);
    this.activeElement = null;
    this._listeners = {};
  }
  createElement(tag) { return new FakeElement(tag, this); }
  _register(el) { if (el.id) this._byId.set(el.id, el); }
  getElementById(id) { return this._byId.get(id) ?? null; }
  querySelectorAll(sel) { return this.body.querySelectorAll(sel); }
  querySelector(sel) { return this.body.querySelector(sel); }
  addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); }
  removeEventListener() {}
  dispatch(type, ev = {}) { for (const fn of this._listeners[type] ?? []) fn(ev); }
}

/**
 * Build a document with the given ids mounted under <body>.
 * @param {Array<[tag:string, id:string, cls?:string]>} spec
 */
export function mountDocument(spec) {
  const doc = new FakeDocument();
  for (const [tag, id, cls] of spec) {
    const el = doc.createElement(tag);
    el.id = id;
    if (cls) el.className = cls;
    doc.body.append(el);
  }
  return doc;
}

/** Install a fake `document` (plus the globals these modules read) for the duration of `fn`. */
export function withDocument(doc, extras, fn) {
  const saved = {};
  const set = (k, v) => { saved[k] = { had: k in globalThis, was: globalThis[k] }; globalThis[k] = v; };
  set('document', doc);
  for (const [k, v] of Object.entries(extras ?? {})) set(k, v);
  try { return fn(); } finally {
    for (const [k, s] of Object.entries(saved)) { if (s.had) globalThis[k] = s.was; else delete globalThis[k]; }
  }
}
