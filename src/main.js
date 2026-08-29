import L from 'leaflet';
import { MAPS, selectMap } from './mapdata.js';
import { getCRS, pos, toLatLngBounds } from './crs.js';
import { loadMapData } from './api.js';
import { roadmapLayer } from './roadmap.js';
import { placeLabelsLayer } from './placeLabels.js';
import { LABELS } from './labels.js';
import { KINDS, iconHtml, extractLetter } from './icons.js';
import { createLive, esc } from './live.js';
import { createQuests } from './quests.js';
import { createAssistant } from './assistant.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const store = {
  get(k, d) { try { const v = localStorage.getItem('tz:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tz:' + k, JSON.stringify(v)); } catch {} },
};
const num = (n, p = 1) => n.toFixed(p).replace('-', '−');
function is3d() { return document.body.classList.contains('view-3d'); }
// Declared up here: rail helpers below run during module init and poke at both.
let view3d = null;
let assistant = null;   // the Ask panel; created once window.tz exists (bottom of this file)
let v3 = { target: [0, 0, 0], zoom: 0, rotationX: 50, rotationOrbit: 0, minZoom: -3, maxZoom: 8 };

const requestedMap = new URLSearchParams(location.search).get('map');
const mapData = selectMap(requestedMap);
const mapLabels = LABELS[mapData.key] ?? [];
const RAID = mapData.raid;
document.title = `TarkovZero — ${mapData.name}`;
$('.map-title-text').textContent = mapData.name;
const mapSwitcher = $('#map-switcher');
const mapMenu = $('#map-menu');
mapSwitcher.value = mapData.key;
mapMenu.innerHTML = Object.values(MAPS).map((m) => `<button type="button" class="map-option" role="menuitemradio" aria-checked="${m.key === mapData.key}" data-map="${m.key}"><span class="map-check" aria-hidden="true">✓</span><span>${m.name}</span></button>`).join('');
const mapOptions = $$('.map-option', mapMenu);
const goMap = (key) => {
  const url = new URL(location.href);
  url.searchParams.set('map', key);
  url.hash = '';
  location.assign(url);
};
function setMapMenu(open, focus = false) {
  mapMenu.hidden = !open;
  mapSwitcher.setAttribute('aria-expanded', String(open));
  if (open && focus) (mapOptions.find((b) => b.dataset.map === mapData.key) ?? mapOptions[0])?.focus();
}
mapSwitcher.onclick = (e) => { e.stopPropagation(); setMapMenu(mapMenu.hidden); };
mapSwitcher.onkeydown = (e) => {
  if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); setMapMenu(true, true); }
};
mapOptions.forEach((b) => { b.onclick = () => goMap(b.dataset.map); });
mapMenu.onkeydown = (e) => {
  const i = mapOptions.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const d = e.key === 'ArrowDown' ? 1 : -1;
    mapOptions[(i + d + mapOptions.length) % mapOptions.length]?.focus(); e.preventDefault();
  } else if (e.key === 'Home' || e.key === 'End') {
    mapOptions[e.key === 'Home' ? 0 : mapOptions.length - 1]?.focus(); e.preventDefault();
  } else if (e.key === 'Escape') {
    setMapMenu(false); mapSwitcher.focus(); e.preventDefault(); e.stopPropagation();
  } else if (e.key === 'Tab') setMapMenu(false);
};
document.addEventListener('click', (e) => { if (!e.target.closest('.head-id')) setMapMenu(false); });
const map = L.map('map', {
  crs: getCRS(mapData),
  minZoom: mapData.minZoom,
  maxZoom: mapData.maxZoom + 1,
  zoomSnap: 0,        // allow fractional zoom so the map can fit the window exactly
  zoomDelta: 0.5,
  wheelPxPerZoomLevel: 120,
  maxBounds: toLatLngBounds(mapData.bounds).pad(0.5),
  attributionControl: false,
  zoomControl: false, // replaced by the HUD stack
});
const bounds = toLatLngBounds(mapData.bounds);

// Base layer: satellite tiles.
const tiles = L.tileLayer(mapData.tilePath, {
  tileSize: mapData.tileSize,
  maxNativeZoom: mapData.maxZoom,
  keepBuffer: 4,          // keep more off-screen tiles so panning/zooming doesn't blank
  updateWhenZooming: false,
}).addTo(map);
// Retry tiles that fail to load (transient CDN errors otherwise stay blank).
tiles.on('tileerror', (e) => {
  const tries = (e.tile._retries = (e.tile._retries ?? 0) + 1);
  if (tries <= 3) setTimeout(() => { e.tile.src = e.tile.src.split('?')[0] + '?r=' + tries; }, 500 * tries);
});

// Base layer 2: vector map built from the same geometry. Chosen from the rail, not a Leaflet control.
const roadmap = roadmapLayer(mapData.svgPath, mapData.svgLayer, toLatLngBounds(mapData.svgBounds ?? mapData.bounds));
const baseSeg = $('#base-toggle');
function setBase(kind, persist = true) {
  const isMap = kind === 'map';
  if (isMap) { if (map.hasLayer(tiles)) map.removeLayer(tiles); if (!map.hasLayer(roadmap)) roadmap.addTo(map); }
  else { if (map.hasLayer(roadmap)) map.removeLayer(roadmap); if (!map.hasLayer(tiles)) tiles.addTo(map); }
  map.getContainer().classList.toggle('base-roadmap', isMap);
  $$('.seg-cell', baseSeg).forEach((b) => b.classList.toggle('on', b.dataset.base === (isMap ? 'map' : 'satellite')));
  if (persist) localStorage.setItem('base', isMap ? 'map' : 'satellite');
}
setBase(new URLSearchParams(location.search).get('base') ?? localStorage.getItem('base') ?? 'satellite', false);
$$('.seg-cell', baseSeg).forEach((b) => (b.onclick = () => setBase(b.dataset.base)));

// Nature is independent of the base/view choice: it hides the vector SVG fills in 2D
// and the existing deck.gl geometry layers in 3D. Query values override saved state on load.
const queryFlag = (name, fallback) => {
  const raw = new URLSearchParams(location.search).get(name);
  if (raw == null) return fallback;
  return !['0', 'false', 'off'].includes(raw.toLowerCase());
};
let treesShown = queryFlag('trees', store.get('trees', true));
let rocksShown = queryFlag('rocks', store.get('rocks', true));
function setNature(kind, on, persist = true) {
  if (kind === 'trees') treesShown = on;
  else rocksShown = on;
  document.body.classList.toggle(`${kind}-off`, !on);
  $$(`#${kind}-toggle .seg-cell`).forEach((b) => {
    const active = b.dataset[kind] === (on ? '1' : '0');
    b.classList.toggle('on', active);
    b.setAttribute('aria-pressed', String(active));
  });
  if (persist) store.set(kind, on);
  view3d?.setNature({ trees: treesShown, rocks: rocksShown });
}
for (const kind of ['trees', 'rocks']) {
  $$(`#${kind}-toggle .seg-cell`).forEach((b) => (b.onclick = () => setNature(kind, b.dataset[kind] === '1')));
}
setNature('trees', treesShown, false);
setNature('rocks', rocksShown, false);

// Terrain relief is a 3D-only display preference. Query values override (without rewriting) the
// persisted choice, matching the Trees/Rocks behavior above.
const reliefChoices = new Set([1, 2, 3]);
const reliefQuery = Number(new URLSearchParams(location.search).get('relief'));
let relief = reliefChoices.has(reliefQuery) ? reliefQuery : Number(store.get('relief', 3));
if (!reliefChoices.has(relief)) relief = 3;
function setRelief(next, persist = true) {
  next = Number(next);
  if (!reliefChoices.has(next)) next = 3;
  relief = next;
  $$('#relief-toggle .seg-cell').forEach((b) => {
    const active = Number(b.dataset.relief) === relief;
    b.classList.toggle('on', active);
    b.setAttribute('aria-pressed', String(active));
  });
  if (persist) store.set('relief', relief);
  view3d?.setRelief(relief);
}
$$('#relief-toggle .seg-cell').forEach((b) => (b.onclick = () => setRelief(b.dataset.relief)));
setRelief(relief, false);

// View permalink: #zoom/x/z (game coords); otherwise fit the whole map to the window.
const fit = () => map.fitBounds(bounds, { padding: [0, 0], animate: false });
const hash = location.hash.slice(1).split('/').map(Number);
const starts3d = new URLSearchParams(location.search).get('view') === '3d' || localStorage.getItem('view') === '3d';
let initial3dHash = starts3d && hash.length === 3 && hash.every(Number.isFinite)
  ? { target: [-hash[1], -hash[2], 0], zoom: hash[0] - 2.06 }
  : null;
let autoFit = true; // refit on window resize only until the user navigates (or arrived via a permalink)
if (hash.length === 3 && hash.every(Number.isFinite)) { map.setView([hash[2], hash[1]], hash[0], { animate: false }); autoFit = false; }
else fit();
// Remember what "fit" means while the 2D map is measurable — #map is display:none in 3D.
let fitState = { center: map.getCenter(), zoom: map.getZoom() };
const rememberFit = () => { if (!is3d()) fitState = { center: bounds.getCenter(), zoom: map.getBoundsZoom(bounds, false) }; };
rememberFit();
window.addEventListener('resize', () => { if (autoFit) fit(); rememberFit(); updateHud(); });
for (const ev of ['mousedown', 'wheel', 'touchstart']) map.getContainer().addEventListener(ev, () => { autoFit = false; }, { passive: true });
map.on('zoomstart', (e) => { if (e.originalEvent) autoFit = false; });
map.on('moveend', () => {
  if (is3d()) history.replaceState(null, '', `#${((v3.zoom ?? 0) + 2.06).toFixed(2)}/${(-v3.target[0]).toFixed(1)}/${(-v3.target[1]).toFixed(1)}`);
  else { const c = map.getCenter(); history.replaceState(null, '', `#${map.getZoom().toFixed(2)}/${c.lng.toFixed(1)}/${c.lat.toFixed(1)}`); }
});
map.on('move zoom', updateHud);

/* ---------------------------------------------------------------- HUD ---- */
const coordsEl = $('#coords');
const scaleCap = $('#scale .scale-cap');
const scaleBar = $('#scale .scale-line i');
const compass = $('#hud-north svg');
const showCoords = (x, z) => { coordsEl.innerHTML = `X <b>${num(x)}</b>&nbsp;&nbsp; Z <b>${num(z)}</b>`; };
const idleCoords = () => { coordsEl.textContent = '—'; };
map.on('mousemove', (e) => showCoords(e.latlng.lng, e.latlng.lat));
map.on('mouseout', idleCoords);

const SNAP = [10, 25, 50, 100, 200, 500, 1000, 2000];
function metresPerPixel() {
  if (is3d()) return 1 / Math.pow(2, v3.zoom ?? 0);
  return 1 / (Math.abs(mapData.transform[0]) * Math.pow(2, map.getZoom()));
}
function updateHud() {
  const mpp = metresPerPixel();
  if (!Number.isFinite(mpp) || mpp <= 0) return;
  let m = SNAP[0];
  for (const s of SNAP) if (s / mpp <= 120) m = s;
  scaleCap.textContent = m >= 1000 ? `${m / 1000} km` : `${m} m`;
  const w = Math.round(m / mpp) + 'px';
  scaleBar.style.width = w; scaleBar.parentElement.style.width = w;
  compass.style.setProperty('--rot', `${-(v3.rotationOrbit ?? 0)}deg`);
}

/* ------------------------------------------------------------ markers ---- */
const icons = {};
const safeLevel = (level) => ['surface', 'underground', 'rooftop', 'upper'].includes(level) ? level : 'surface';
const levelSuffix = (level) => safeLevel(level) === 'surface' ? '' : ` · ${safeLevel(level).toUpperCase()}`;
const CONTAINER_KIND = {
  container_stash: 'stash',
  container_weapon: 'loot-weapon',
  container_crate: 'loot-crate', container_greencrate: 'loot-crate', container_duffle: 'loot-crate', container_jacket: 'loot-crate', container_supply: 'loot-crate',
  container_safe: 'loot-cash', container_cash: 'loot-cash', container_pc: 'loot-cash', container_drawer: 'loot-cash',
  container_medcase: 'loot-med', container_medical: 'loot-med', container_ammo: 'loot-med', container_grenade: 'loot-med', container_tool: 'loot-med',
  loot_key: 'loot-key', container_dead: 'loot-dead', loot_loose: 'loot-loose', loot_spt: 'loot-loose',
};
const CONTAINER_TYPE = {
  container_stash: 'Hidden stash', container_weapon: 'Weapon box', container_crate: 'Supply crate', container_greencrate: 'Wooden crate',
  container_duffle: 'Bag', container_jacket: 'Jacket', container_supply: 'Supply container', container_safe: 'Safe', container_cash: 'Cash register',
  container_pc: 'PC', container_drawer: 'Drawer', container_tool: 'Tool container', container_medcase: 'Medcase', container_medical: 'Medical bag',
  container_ammo: 'Ammo box', container_grenade: 'Grenade box', container_dead: 'Dead body', loot_key: 'Key spawn', loot_loose: 'Marked loose loot', loot_spt: 'SPT loose-loot point',
};
const iconFor = (kind, letter = null, level = 'surface') => {
  const key = `${kind}:${letter ?? ''}:${safeLevel(level)}`;
  return (icons[key] ??= L.divIcon({ className: '', html: iconHtml(kind, kind.startsWith('extract') ? 26 : 22, letter, safeLevel(level)), iconSize: [24, 24], iconAnchor: [12, 12], popupAnchor: [0, -12] }));
};
function marker(p, kind, html, name = null, level = 'surface') {
  const m = L.marker(pos(p), { icon: iconFor(kind, kind.startsWith('extract') ? extractLetter(name) : null, level) }).bindPopup(html);
  // Extracts carry their full name on hover — the badge letter alone is a riddle.
  if (kind.startsWith('extract') && name) m.bindTooltip(esc(name + levelSuffix(level)), { direction: 'top', offset: [0, -13], className: `extract-name ${kind} level-${safeLevel(level)}`, opacity: 1 });
  return m;
}

/** Classify raw map data into marker points: [{kind, position, html}] — shared by the 2D and 3D views. */
export function classify(d) {
  const out = [];
  const add = (kind, position, html, name = null, level = 'surface') => out.push({ kind, position, html, name, level: safeLevel(level) });
  for (const e of d.extracts) {
    const f = ['pmc', 'scav', 'transit'].includes(e.faction) ? e.faction : 'shared';
    const level = safeLevel(e.level);
    add('extract-' + f, e.position, `<b>${e.name}${levelSuffix(level)}</b>Extract · ${f} · ${level}${e.note ? `<br><i>${e.note}</i>` : ''}`, e.name, level);
  }
  for (const s of d.spawns) {
    const isBoss = s.categories.includes('boss');
    const isPmc = s.sides.includes('pmc') || s.sides.includes('all');
    const info = `${s.zoneName ?? ''}<br>sides: ${s.sides.join(', ')}<br>cat: ${s.categories.join(', ')}`;
    if (isBoss) add('spawn-boss', s.position, `<b>Boss spawn</b>${info}`);
    else if (isPmc && s.categories.includes('player')) add('spawn-pmc', s.position, `<b>PMC spawn</b>${info}`);
    else if (s.categories.includes('sniper')) add('spawn-sniper', s.position, `<b>Sniper scav spawn</b>${info}`);
    else if (s.categories.includes('scav')) add('spawn-scav', s.position, `<b>Scav spawn</b>${info}`);
  }
  for (const h of d.hazards) add('hazard', h.position, `<b>${h.name}</b>`);
  for (const w of d.stationaryWeapons) add('weapon', w.position, `<b>${w.stationaryWeapon.name}</b>`);
  for (const sw of d.switches ?? []) { const level = safeLevel(sw.level); add('switch', sw.position, `<b>${sw.name}${levelSuffix(level)}</b>Switch · ${level}`, sw.name, level); }
  for (const l of d.locks) { const level = safeLevel(l.level); add('lock', l.position, `<b>${l.key?.name ?? 'Lock'}${levelSuffix(level)}</b>${l.lockType} · ${level}`, l.key?.name, level); }
  for (const c of d.containers ?? []) {
    const kind = CONTAINER_KIND[c.type];
    if (!kind) continue;
    const level = safeLevel(c.level), name = c.name || CONTAINER_TYPE[c.type] || 'Loot container';
    const note = c.note ? `<br><i>${esc(c.note).replace(/\n/g, '<br>')}</i>` : '';
    add(kind, c.position, `<b>${esc(name)}${levelSuffix(level)}</b>${esc(CONTAINER_TYPE[c.type] || c.type)} · ${level}${note}`, name, level);
  }
  return out;
}

let markerPoints = [];
const layerOf = new Map();  // kind -> L.layerGroup
const countOf = new Map();  // kind -> n

/* ------------------------------------------------------------- labels ---- */
// Two panes so major/minor place names can be styled apart in 2D, and the same
// split feeds the 3D TextLayer through src.labels().
const SURFACE_LABELS = mapLabels.filter((l) => l.floor !== 'U');
const MAJOR = SURFACE_LABELS.filter((l) => (l.size ?? 100) >= 100);
const MINOR = SURFACE_LABELS.filter((l) => (l.size ?? 100) < 100);
const labelLayers = { major: placeLabelsLayer(map, MAJOR), minor: placeLabelsLayer(map, MINOR, { pane: 'labelsMinor' }) };
let density = store.get('density', 'all');
let labelsShown = store.get('labels', true);
function labelSet() {
  if (!labelsShown || density === 'off') return [];
  return density === 'key' ? mapLabels.filter((l) => (l.size ?? 100) >= 100) : mapLabels;
}
function applyLabels() {
  const wantMajor = labelsShown && density !== 'off';
  const wantMinor = labelsShown && density === 'all';
  wantMajor ? labelLayers.major.addTo(map) : map.removeLayer(labelLayers.major);
  wantMinor ? labelLayers.minor.addTo(map) : map.removeLayer(labelLayers.minor);
  $$('#label-density .seg-cell').forEach((b) => b.classList.toggle('on', b.dataset.density === density));
  view3d?.refresh();
}
$$('#label-density .seg-cell').forEach((b) => (b.onclick = () => { density = b.dataset.density; store.set('density', density); applyLabels(); }));

/* ------------------------------------------------------- filter rows ----- */
const GROUPS = [
  { id: 'extracts', title: 'Extracts', cat: 'extract', kinds: ['extract-pmc', 'extract-scav', 'extract-shared', 'extract-transit'] },
  { id: 'contacts', title: 'Contacts', cat: 'contact', kinds: ['spawn-pmc', 'spawn-scav', 'spawn-sniper', 'spawn-boss'] },
  { id: 'objects', title: 'Objects', cat: 'object', always: true, kinds: ['stash', 'loot-weapon', 'loot-crate', 'loot-cash', 'loot-med', 'loot-key', 'loot-dead', 'loot-loose', 'weapon', 'switch', 'lock', 'hazard'] },
];
const MARKER_KINDS = GROUPS.flatMap((g) => g.kinds).filter((k) => KINDS[k]);
const CAT_OF = Object.fromEntries(GROUPS.flatMap((g) => g.kinds.map((k) => [k, g.cat])));
const defaultOn = ['extract-pmc', 'spawn-pmc', 'stash'];
let onKinds = new Set(store.get('kinds', defaultOn));
const layersEl = $('#layers');

function rowEl({ kind, cat, label, count, on, icon }) {
  const el = document.createElement('label');
  el.className = 'row' + (on ? ' on' : '');
  el.dataset.cat = cat; el.dataset.kind = kind ?? '';
  el.innerHTML = `<input type="checkbox" class="vh" data-kind="${kind ?? ''}"${on ? ' checked' : ''}>` +
    `<span class="row-ico">${icon}</span><span class="row-lab">${label}</span><span class="row-n mono">${count ?? ''}</span>`;
  return el;
}

function setKind(kind, on, { refresh = true } = {}) {
  const layer = layerOf.get(kind);
  if (layer) on ? layer.addTo(map) : map.removeLayer(layer);
  on ? onKinds.add(kind) : onKinds.delete(kind);
  const row = layersEl.querySelector(`.row[data-kind="${kind}"]`);
  if (row) { row.classList.toggle('on', on); row.querySelector('input').checked = on; }
  if (refresh) { store.set('kinds', [...onKinds]); syncGroupCounts(); view3d?.refresh(); }
}
function setLabels(on) {
  labelsShown = on; store.set('labels', on);
  const row = layersEl.querySelector('.row[data-kind=""]');
  if (row) { row.classList.toggle('on', on); row.querySelector('input').checked = on; }
  applyLabels();
}
function syncGroupCounts() {
  for (const g of GROUPS) {
    const btn = layersEl.querySelector(`#gc-${g.id}`);
    if (!btn) continue;
    const kinds = g.always ? g.kinds : g.kinds.filter((k) => layerOf.has(k));
    const n = kinds.filter((k) => onKinds.has(k)).length;
    btn.textContent = `${n}/${kinds.length || g.kinds.length}`;
    btn.classList.toggle('full', kinds.length > 0 && n === kinds.length);
  }
  const badge = $('#sheet-badge');
  if (badge) badge.textContent = `${onKinds.size} filters`;
}

// Structure first (place-names row + three groups with skeletons); real rows land when the API answers.
function buildFilterUI() {
  layersEl.innerHTML = '';
  const pin = rowEl({ kind: null, cat: 'label', label: 'Place names', count: mapLabels.length, on: labelsShown, icon: labelIcon() });
  pin.classList.add('pin-row');
  layersEl.appendChild(pin);
  pin.querySelector('input').onchange = (e) => setLabels(e.target.checked);
  for (const g of GROUPS) {
    const d = document.createElement('details');
    d.id = 'grp-' + g.id;
    d.open = store.get('grp:' + g.id, g.id === 'extracts');
    d.innerHTML = `<summary><svg class="chev" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.5 6.5 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>` +
      `<span>${g.title}</span><button type="button" class="gcount" id="gc-${g.id}">0/${g.kinds.length}</button></summary><div class="rows"></div>`;
    d.ontoggle = () => store.set('grp:' + g.id, d.open);
    const gc = d.querySelector('.gcount');
    gc.onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      const kinds = g.always ? g.kinds : g.kinds.filter((k) => layerOf.has(k));
      const allOn = kinds.length && kinds.every((k) => onKinds.has(k));
      for (const k of kinds) setKind(k, !allOn, { refresh: false });
      store.set('kinds', [...onKinds]); syncGroupCounts(); view3d?.refresh();
    };
    const rows = d.querySelector('.rows');
    for (let i = 0; i < g.kinds.length; i++) rows.insertAdjacentHTML('beforeend', '<div class="skel"></div>');
    layersEl.appendChild(d);
  }
  syncGroupCounts();
}
const labelIcon = () => `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#E6E3D7" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h11M4 17h7"/></svg>`;

function fillRows() {
  for (const g of GROUPS) {
    const rows = $(`#grp-${g.id} .rows`);
    if (!rows) continue;
    rows.innerHTML = '';
    for (const kind of g.kinds) {
      if (!g.always && !layerOf.has(kind)) continue;
      const on = onKinds.has(kind);
      const el = rowEl({ kind, cat: g.cat, label: KINDS[kind].label, count: countOf.get(kind) ?? 0, on, icon: iconHtml(kind, 17) });
      el.querySelector('input').onchange = (e) => setKind(kind, e.target.checked);
      el.addEventListener('click', (e) => {   // shift-click solos inside the group
        if (!e.shiftKey) return;
        e.preventDefault();
        for (const k of (g.always ? g.kinds : g.kinds.filter((k) => layerOf.has(k)))) setKind(k, k === kind, { refresh: false });
        store.set('kinds', [...onKinds]); syncGroupCounts(); view3d?.refresh();
      });
      rows.appendChild(el);
    }
  }
  syncGroupCounts();
}
buildFilterUI();
applyLabels();

// All / None with a 3s undo.
let undoState = null, undoTimer = 0;
const toastEl = $('#toast');
function toast(msg, undo) {
  toastEl.hidden = false;
  toastEl.innerHTML = `<span>${msg}</span>`;
  const b = document.createElement('button'); b.textContent = 'Undo'; b.onclick = () => { undo(); hideToast(); };
  toastEl.appendChild(b);
  clearTimeout(undoTimer); undoTimer = setTimeout(hideToast, 3000);
}
const hideToast = () => { toastEl.hidden = true; clearTimeout(undoTimer); };
function setAll(on) {
  undoState = [...onKinds];
  for (const k of MARKER_KINDS) if (layerOf.has(k)) setKind(k, on, { refresh: false });
  store.set('kinds', [...onKinds]); syncGroupCounts(); view3d?.refresh();
  toast(on ? 'All filters on' : 'All filters off', () => {
    const prev = new Set(undoState);
    for (const k of MARKER_KINDS) if (layerOf.has(k)) setKind(k, prev.has(k), { refresh: false });
    store.set('kinds', [...onKinds]); syncGroupCounts(); view3d?.refresh();
  });
}
$('#all-on').onclick = () => setAll(true);
$('#all-off').onclick = () => setAll(false);

/* ------------------------------------------------------------- status ---- */
const statusEl = $('#status'), statusPop = $('#status-pop');
const statusText = $('.status-text', statusEl), statusDot = $('.dot', statusEl);
function setStatus(state, text, popHtml) {
  statusDot.dataset.state = state;
  statusText.textContent = text;
  if (popHtml != null) statusPop.innerHTML = popHtml;
}
statusEl.onclick = () => togglePop(statusPop, statusEl);

/* -------------------------------------------------------- data loading --- */
const CACHE_KEY = `tarkovzero:${mapData.key}`;
function renderMarkers(data, source) {
  markerPoints = classify(data);
  layerOf.clear(); countOf.clear();
  for (const m of markerPoints) {
    if (!KINDS[m.kind]) continue;
    if (!layerOf.has(m.kind)) layerOf.set(m.kind, L.layerGroup());
    layerOf.get(m.kind).addLayer(marker(m.position, m.kind, m.html, m.name, m.level));
    countOf.set(m.kind, (countOf.get(m.kind) ?? 0) + 1);
  }
  fillRows();
  for (const [kind, layer] of layerOf) if (onKinds.has(kind)) layer.addTo(map);
  view3d?.refresh();
  buildSearchIndex();

  const bosses = [...(data.bosses ?? [])].sort((a, b) => b.spawnChance - a.spawnChance);
  const top = bosses[0];
  const meta = `${RAID.minutes} MIN · ${RAID.pmc} PMC${top ? ` · ${top.name.toUpperCase()} ${Math.round(top.spawnChance * 100)}%` : ''}`;
  const list = bosses.map((b) => `<div><b>${esc(b.name)}</b> <span class="num">${Math.round(b.spawnChance * 100)}%</span></div>`).join('');
  setStatus(source === 'live' ? 'live' : 'cached',
    meta,
    `<div class="pop-title">Raid</div><div>${RAID.minutes} min · ${RAID.pmc} PMC · ${markerPoints.length} markers</div>` +
    `<div class="pop-title" style="margin-top:8px">Bosses</div>${list || '<div>none listed</div>'}` +
    `<div class="pop-title" style="margin-top:8px">Source</div><div>${esc(source)}</div>`);
}
async function loadMarkers(attempt = 0) {
  try {
    const { data, source } = await loadMapData(mapData.key);
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch {}
    renderMarkers(data, source);
  } catch (e) {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached && attempt === 0) return renderMarkers(JSON.parse(cached), 'browser cache');
    setStatus('error', `tarkov.dev unavailable — retry ${attempt + 1}`, `<div class="pop-title">Markers</div><div>The tarkov.dev API did not answer. Retrying every 60 s.</div>`);
    setTimeout(() => loadMarkers(attempt + 1), 60_000);
  }
}
loadMarkers();

/* --------------------------------------------------------------- find ---- */
const findEl = $('#find'), resEl = $('#find-results');
let index = [], results = [], active = 0;
function buildSearchIndex() {
  index = [];
  for (const m of markerPoints) {
    if (!m.kind.startsWith('extract') || !m.name) continue;
    if (index.some((i) => i.kind === 'extract' && i.label === m.name)) continue;
    index.push({ kind: 'extract', label: m.name, sub: `${m.kind.replace('extract-', '')} · ${safeLevel(m.level)}`, level: safeLevel(m.level), x: m.position.x, z: m.position.z, badge: extractLetter(m.name) ?? '', mk: m.kind });
  }
  for (const m of markerPoints) {
    if (m.kind !== 'stash' || !m.name) continue;
    index.push({ kind: 'marker', label: m.name, sub: `stash · ${safeLevel(m.level)}`, x: m.position.x, z: m.position.z, mk: m.kind });
  }
  for (const l of mapLabels) index.push({ kind: 'place', label: l.text, sub: 'place', x: l.position[0], z: l.position[1] });
  for (const k of MARKER_KINDS) if (KINDS[k]) index.push({ kind: 'layer', label: KINDS[k].label, sub: 'filter', mk: k });
}
buildSearchIndex();
function renderResults() {
  if (!results.length) { resEl.hidden = !findEl.value; resEl.innerHTML = '<div class="res-empty">No match</div>'; return; }
  resEl.hidden = false;
  resEl.innerHTML = results.map((r, i) => {
    const chip = r.kind === 'layer' || r.kind === 'marker' ? iconHtml(r.mk, 17)
      : r.kind === 'extract' ? `<span class="badge">${esc(r.badge || '·')}</span>`
      : `<span class="badge">${esc((r.label[0] || '·').toUpperCase())}</span>`;
    return `<div class="res${i === active ? ' act' : ''}" data-i="${i}" role="option">${chip}<span class="rn">${esc(r.label)}</span><span class="rk">${esc(r.sub)}</span></div>`;
  }).join('');
  $$('.res', resEl).forEach((el) => (el.onclick = () => choose(Number(el.dataset.i))));
}
function search(q) {
  const s = q.trim().toLowerCase();
  if (!s) { results = []; resEl.hidden = true; return; }
  results = index
    .map((r) => ({ r, i: r.label.toLowerCase().indexOf(s) }))
    .filter((o) => o.i >= 0)
    .sort((a, b) => a.i - b.i || a.r.label.length - b.r.label.length)
    .slice(0, 8).map((o) => o.r);
  active = 0;
  renderResults();
}
function choose(i) {
  const r = results[i]; if (!r) return;
  if (r.kind === 'layer') setKind(r.mk, true);
  else {
    if (r.kind === 'marker') setKind(r.mk, true);
    flyTo(r.x, r.z);
  }
  findEl.blur(); resEl.hidden = true; findEl.value = ''; results = [];
}
findEl.oninput = () => search(findEl.value);
findEl.onkeydown = (e) => {
  if (e.key === 'ArrowDown') { active = Math.min(active + 1, results.length - 1); renderResults(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); renderResults(); e.preventDefault(); }
  else if (e.key === 'Enter') { choose(active); e.preventDefault(); }
  else if (e.key === 'Escape') { findEl.value = ''; results = []; resEl.hidden = true; findEl.blur(); }
};
if (!/Mac|iPhone|iPad/.test(navigator.platform)) $('#find-kbd').textContent = 'Ctrl K';

function flyTo(x, z) {
  const z2 = Math.max(map.getZoom(), 4.4);
  if (is3d()) set3d({ target: [-x, -z, 0], zoom: z2 - 2.06 });
  else map.setView([z, x], z2, { animate: true });
  ping(x, z);
  if (document.body.classList.contains('sheet-half') || document.body.classList.contains('sheet-full')) sheet('peek');
}
function ping(x, z) {
  const m = L.marker([z, x], { icon: L.divIcon({ className: 'ping', iconSize: [0, 0] }), interactive: false, keyboard: false }).addTo(map);
  setTimeout(() => m.remove(), 3400);
}

/* -------------------------------------------------------- quest layer ---- */
// Quest objectives are their own layer group: fed by public/data/quests.json, drawn as numbered
// hexagon pins + translucent zone polygons in 2D (Leaflet) and 3D (deck), hidden until the player
// picks a quest. See src/quests.js.
const quests = createQuests({
  map,
  mapKey: mapData.key,
  store,
  flyTo,
  is3d,
  refresh3d: () => view3d?.refresh(),
  project3d: (x, z) => view3d?.project?.(x, z) ?? null,
});
quests.layer.addTo(map);
quests.init();

/* --------------------------------------------------------- live panel ---- */
const liveEl = $('#live'), liveToggle = $('#live-toggle'), liveSum = $('#live-sum');
let liveOpen = store.get('liveOpen', false), liveCollapseTimer = 0;
function setLiveOpen(o) {
  liveOpen = o; store.set('liveOpen', o);
  liveEl.hidden = !o; liveToggle.setAttribute('aria-expanded', String(o));
}
liveToggle.onclick = () => setLiveOpen(!liveOpen);
const ui = { render() {
  const ps = [...live.players.values()];
  liveSum.textContent = ps.length ? `${ps[0].code} · ${ps.length} player${ps.length > 1 ? 's' : ''}` : 'Not connected';
  liveToggle.classList.toggle('armed', ps.length > 0);
  if (ps.length && !liveOpen) setLiveOpen(true);
  if (!ps.length && liveOpen) { clearTimeout(liveCollapseTimer); liveCollapseTimer = setTimeout(() => { if (!live.players.size) setLiveOpen(false); }, 8000); }
  liveEl.innerHTML =
    ps.map((p) => `<div class="player"><span class="pcol" style="background:${esc(p.color)}"></span>` +
      `<b title="double-click to rename" data-rn="${esc(p.code)}">${esc(p.name)}</b>` +
      `<span class="code">${p.name !== p.code ? esc(p.code) : ''}</span>` +
      `<span class="st">${esc(p.status)}</span>` +
      `<button class="rm" data-rm="${esc(p.code)}" aria-label="Remove">✕</button></div>`).join('') +
    `<input type="text" id="live-code" maxlength="7" placeholder="pairing code, e.g. K7P3QX" aria-label="Pairing code">` +
    `<button class="btn-primary" id="live-add">${ps.length ? 'Add another' : 'Connect'}</button>` +
    `<div class="err" id="live-err"></div>` +
    `<div class="opts">` +
      `<label class="sw"><input type="checkbox" id="live-follow" ${live.opts.follow ? 'checked' : ''}><span class="track"></span>follow</label>` +
      `<label class="sw"><input type="checkbox" id="live-trail" ${live.opts.trail ? 'checked' : ''}><span class="track"></span>trail</label>` +
      `<button class="ghost" id="live-clear">clear trail</button>` +
    `</div>`;
  const input = $('#live-code', liveEl);
  const tryAdd = () => { try { live.add(input.value); input.value = ''; ui.render(); } catch (e) { $('#live-err', liveEl).textContent = e.message; } };
  $('#live-add', liveEl).onclick = tryAdd;
  input.onkeydown = (e) => { if (e.key === 'Enter') tryAdd(); };
  $$('[data-rm]', liveEl).forEach((b) => (b.onclick = () => live.remove(b.dataset.rm)));
  $$('[data-rn]', liveEl).forEach((b) => (b.ondblclick = () => { const n = prompt('Name for this player (empty = use companion name / code)', b.textContent); if (n !== null) live.rename(b.dataset.rn, n); }));
  $('#live-follow', liveEl).onchange = (e) => (live.opts.follow = e.target.checked);
  $('#live-trail', liveEl).onchange = (e) => (live.opts.trail = e.target.checked);
  $('#live-clear', liveEl).onclick = () => live.clearTrails();
} };
const live = createLive(map, mapData, ui);
setLiveOpen(liveOpen);
ui.render();
live.restore();
for (const c of (new URLSearchParams(location.search).get('live') || '').split(',').filter(Boolean)) { try { live.add(c); } catch {} }
ui.render();

/* ----------------------------------------------------------- 3D view ----- */
const visibleKinds = () => new Set([...$$('#layers input[data-kind]')].filter((i) => i.checked && i.dataset.kind).map((i) => i.dataset.kind));
function set3d(patch) {
  v3 = { ...v3, ...patch };
  if (view3d) {
    try { view3d.setView({ target: v3.target, zoom: v3.zoom }); } catch {}
    try { view3d.deck?.setProps({ viewState: { ...v3 } }); } catch {}
  }
  map.setView([-v3.target[1], -v3.target[0]], v3.zoom + 2.06, { animate: false });
  updateHud();
}
const viewBtns = $$('#view-toggle .seg-cell');
async function setView(mode) {
  localStorage.setItem('view', mode);
  document.body.classList.toggle('view-3d', mode === '3d');
  viewBtns.forEach((b) => { const on = b.dataset.view === mode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  if (mode === '3d') {
    if (!view3d) {
      const { createView3d } = await import('./map3d.js');
      view3d = await createView3d($('#map3d'), mapData, {
        relief,
        markers: () => markerPoints.filter((m) => visibleKinds().has(m.kind)),
        labels: labelSet,
        players: () => [...live.players.values()],
        quests: () => quests.deckData(),
        onQuestClick: (obj) => quests.onDeckClick(obj),
        onViewChange: (v) => {
          v3 = { ...v3, ...v };
          map.setView([-v3.target[1], -v3.target[0]], v3.zoom + 2.06, { animate: false });
          updateHud();
        },
      });
      view3d.setFloor(floor === 'all' || floor === 'U' ? floor : Number(floor));
      view3d.setNature({ trees: treesShown, rocks: rocksShown });
      try { view3d.deck?.setProps({ onHover: (i) => { const c = i?.coordinate; Array.isArray(c) ? showCoords(-c[0], -c[1]) : idleCoords(); } }); } catch {}
    }
    if (initial3dHash) { const direct = initial3dHash; initial3dHash = null; set3d(direct); }
    else { const c = map.getCenter(); set3d({ target: [-c.lng, -c.lat, 0], zoom: map.getZoom() - 2.06 }); }
    view3d.refresh();
  } else {
    // #map was display:none while 3D drove it — remeasure before Leaflet draws again.
    map.invalidateSize({ animate: false });
  }
  // The quest card is a Leaflet popup in 2D and a floating HTML card in 3D — neither survives the
  // switch, so close it rather than leave a card pinned to nothing.
  quests.closeCard();
  map.closePopup();
  idleCoords();
  updateHud();
}
viewBtns.forEach((b) => (b.onclick = () => setView(b.dataset.view)));

// Floors
const allowedFloors = new Set(mapData.floors.map(String));
$$('#floors .seg-cell').forEach((b) => { b.hidden = !allowedFloors.has(b.dataset.floor); });
let floor = String(new URLSearchParams(location.search).get('floor') ?? store.get('floor', 'all'));
if (!allowedFloors.has(floor)) floor = 'all';
const floorBtns = $$('#floors .seg-cell:not([hidden])');
function setFloor(f) {
  floor = f; store.set('floor', f);
  floorBtns.forEach((b) => b.classList.toggle('on', b.dataset.floor === String(f)));
  view3d?.setFloor(f === 'all' || f === 'U' ? f : Number(f));
}
floorBtns.forEach((b) => (b.onclick = () => setFloor(b.dataset.floor)));
setFloor(floor);
const stepFloor = (d) => { const i = floorBtns.findIndex((b) => b.classList.contains('on')); setFloor(floorBtns[Math.max(0, Math.min(floorBtns.length - 1, i + d))].dataset.floor); };

const origRender = ui.render; ui.render = () => { origRender(); view3d?.refresh(); };

/* ------------------------------------------------------- HUD controls ---- */
function zoomBy(d) {
  if (is3d()) set3d({ zoom: Math.max(-2, Math.min(8, (v3.zoom ?? 0) + d)) });
  else map.setZoom(map.getZoom() + d, { animate: true });
}
$('#hud-zin').onclick = () => zoomBy(0.5);
$('#hud-zout').onclick = () => zoomBy(-0.5);
$('#hud-fit').onclick = () => {
  if (is3d()) set3d({ target: [-fitState.center.lng, -fitState.center.lat, 0], zoom: fitState.zoom - 2.06 });
  else { autoFit = true; fit(); }
};
$('#hud-north').onclick = () => {
  const t0 = performance.now(), o0 = v3.rotationOrbit ?? 0, x0 = v3.rotationX ?? 50;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 400), e = 1 - Math.pow(1 - k, 3);
    set3d({ rotationOrbit: o0 * (1 - e), rotationX: x0 + (62 - x0) * e });
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
};

/* ---------------------------------------------------------- popovers ----- */
function togglePop(pop, trigger) {
  const open = pop.hidden;
  closePops();
  pop.hidden = !open;
  trigger?.setAttribute('aria-expanded', String(open));
}
function closePops() {
  for (const p of $$('.pop')) p.hidden = true;
  setMapMenu(false);
  statusEl.setAttribute('aria-expanded', 'false');
  $('#help-btn').setAttribute('aria-expanded', 'false');
}
$('#help-btn').onclick = (e) => { e.stopPropagation(); togglePop($('#hint3d'), $('#help-btn')); };
document.addEventListener('click', (e) => { if (!e.target.closest('.pop') && !e.target.closest('#status') && !e.target.closest('#help-btn')) closePops(); });

/* -------------------------------------------------------- mobile sheet --- */
const DETENTS = ['peek', 'half', 'full'];
const mobile = () => window.matchMedia('(max-width:760px)').matches;
function sheet(d) {
  document.body.classList.remove('sheet-peek', 'sheet-half', 'sheet-full');
  document.body.classList.add('sheet-' + d);
  document.body.dataset.sheet = d;
  setTimeout(() => { map.invalidateSize(); updateHud(); }, 240);
}
if (mobile()) sheet('half');
$('#sheet-grab').onclick = () => sheet(DETENTS[(DETENTS.indexOf(document.body.dataset.sheet || 'half') + 1) % 3]);
$('#stage').addEventListener('pointerdown', () => { if (mobile() && document.body.dataset.sheet !== 'peek') sheet('peek'); });
window.addEventListener('resize', () => { if (!mobile()) document.body.classList.remove('sheet-peek', 'sheet-half', 'sheet-full'); else if (!document.body.dataset.sheet) sheet('half'); });

/* ------------------------------------------------------------ keyboard --- */
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
  if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); findEl.focus(); findEl.select(); return; }
  if (e.key === 'Escape') { closePops(); map.closePopup(); quests.closeCard(); if (mobile()) sheet('peek'); return; }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); findEl.focus(); return; }
  if (e.key === '3') { setView(is3d() ? '2d' : '3d'); return; }
  if (e.key === 'q' || e.key === 'Q') { quests.setOpen(true); $('#quest-find')?.focus(); return; }
  if (e.key === 'a' || e.key === 'A') { assistant?.focus(); return; }
  if (e.key === 'l' || e.key === 'L') { setLabels(!labelsShown); return; }
  if (e.key === 'f' || e.key === 'F') { $('#hud-fit').click(); return; }
  if (e.key === 'n' || e.key === 'N') { if (is3d()) $('#hud-north').click(); return; }
  if (e.key === '[') { if (is3d()) stepFloor(-1); return; }
  if (e.key === ']') { if (is3d()) stepFloor(1); return; }
  if (e.key === '+' || e.key === '=') { zoomBy(0.5); return; }
  if (e.key === '-') { zoomBy(-0.5); return; }
  if (/^[1-6]$/.test(e.key)) {
    const rows = $$('#layers .row[data-kind]:not([data-kind=""])');
    const row = rows[Number(e.key) - 1];
    if (row) { const k = row.dataset.kind; setKind(k, !onKinds.has(k)); }
  }
});

/* ------------------------------------------------------------ tz API ----- */
// Small stable surface so an assistant (or the console) can drive the map:
//   tz.quests.select('the-punisher-part-1'); tz.quests.flyTo('<objectiveId>'); tz.quests.markObjective(id)
window.tz = {
  map: mapData.key,
  get view() { return is3d() ? '3d' : '2d'; },
  setView,
  flyTo,
  quests: {
    /** Select a quest by slug (adds it to the map). Returns false if the slug is unknown. */
    select: (slug) => quests.select(slug),
    deselect: (slug) => quests.deselect(slug),
    toggle: (slug) => quests.toggle(slug),
    /** Tick/untick an objective. `value` omitted flips it. Returns the new state. */
    markObjective: (objectiveId, value) => quests.markObjective(objectiveId, value),
    /** Centre the map on an objective and open its card. */
    flyTo: (objectiveId) => quests.flyToObjective(objectiveId),
    /** Everything currently on the map: [{id, questSlug, objectiveId, badge, position, level}] */
    points: () => quests.points().map((p) => ({ id: p.id, questSlug: p.questSlug, objectiveId: p.objectiveId, badge: p.badge, text: p.objective.text, position: p.position, level: p.level })),
    selected: () => quests.selectedSlugs(),
    /** The full quest list (loads it if it has not been fetched yet). */
    all: async () => (await quests.load()),
    setVisible: (on) => quests.setVisible(on),
    open: (on = true) => quests.setOpen(on),
  },
};

/* ------------------------------------------------------- ask (AI) panel -- */
// Grounded quest Q&A: src/assistant.js posts to /api/assistant and replays the actions it gets
// back through window.tz (select a quest, fly to an objective, switch map). See api/assistant.js.
assistant = createAssistant({
  mapKey: mapData.key,
  tz: window.tz,
  store,
  onOpen: (reveal) => { if (mobile() && (reveal || document.body.dataset.sheet === 'peek')) sheet('full'); },
});
assistant.init();

updateHud();
if (starts3d) setView('3d');

// ?debug=roads — draw the 3D road/track network over the 2D map to check it against the satellite
if (new URLSearchParams(location.search).get('debug') === 'roads') {
  fetch(`/data/${mapData.key}-3d.json`).then((r) => r.json()).then((d) => {
    const col = { highway: '#ffdd00', main: '#ff3030', small: '#ff30ff', track: '#ff8c00', dirt: '#b06000' };
    for (const r of d.roads) L.polyline(r.path.map(([x, z]) => [z, x]), { color: col[r.kind] || '#fff', weight: r.kind === 'track' || r.kind === 'dirt' ? 2 : 3, opacity: 0.9, dashArray: r.kind === 'track' || r.kind === 'dirt' ? '6 4' : null }).addTo(map).bindTooltip(r.kind);
    for (const b of d.bridges) L.polyline(b.path.map(([x, z]) => [z, x]), { color: '#00e5ff', weight: 5, opacity: 0.9 }).addTo(map);
    L.polyline([...d.limit, d.limit[0]].map(([x, z]) => [z, x]), { color: '#ff0000', weight: 2, dashArray: '8 6' }).addTo(map);
  });
}
