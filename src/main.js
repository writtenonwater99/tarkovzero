import L from 'leaflet';
import { CUSTOMS } from './mapdata.js';
import { getCRS, pos, toLatLngBounds } from './crs.js';
import { loadMapData } from './api.js';
import { roadmapLayer } from './roadmap.js';
import { placeLabelsLayer } from './placeLabels.js';
import { CUSTOMS_LABELS } from './labels.js';
import { KINDS, iconHtml } from './icons.js';
import { createLive, esc } from './live.js';

const mapData = CUSTOMS;
const map = L.map('map', {
  crs: getCRS(mapData),
  minZoom: mapData.minZoom,
  maxZoom: mapData.maxZoom + 1,
  zoomSnap: 0,        // allow fractional zoom so the map can fit the window exactly
  zoomDelta: 0.5,
  wheelPxPerZoomLevel: 120,
  maxBounds: toLatLngBounds(mapData.bounds).pad(0.5),
  attributionControl: false,
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

// Base layer 2: Google-Maps-style vector map from the same geometry.
const roadmap = roadmapLayer(mapData.svgPath, mapData.svgLayer, bounds);
L.control.layers({ Satellite: tiles, Map: roadmap }, {}, { position: 'topright' }).addTo(map);
// ?base=map selects the vector map; the choice is remembered.
const base = new URLSearchParams(location.search).get('base') ?? localStorage.getItem('base');
if (base === 'map') { map.removeLayer(tiles); roadmap.addTo(map); }
const setBaseClass = (isMap) => map.getContainer().classList.toggle('base-roadmap', isMap);
setBaseClass(base === 'map');
map.on('baselayerchange', (e) => { const isMap = e.layer === roadmap; setBaseClass(isMap); localStorage.setItem('base', isMap ? 'map' : 'satellite'); });

// View permalink: #zoom/x/z (game coords); otherwise fit the whole map to the window.
const fit = () => map.fitBounds(bounds, { padding: [0, 0], animate: false });
const hash = location.hash.slice(1).split('/').map(Number);
let autoFit = true; // refit on window resize only until the user navigates (or arrived via a permalink)
if (hash.length === 3 && hash.every(Number.isFinite)) { map.setView([hash[2], hash[1]], hash[0], { animate: false }); autoFit = false; }
else fit();
window.addEventListener('resize', () => { if (autoFit) fit(); });
for (const ev of ['mousedown', 'wheel', 'touchstart']) map.getContainer().addEventListener(ev, () => { autoFit = false; }, { passive: true });
map.on('zoomstart', (e) => { if (e.originalEvent) autoFit = false; });
map.on('moveend', () => {
  const c = map.getCenter();
  history.replaceState(null, '', `#${map.getZoom().toFixed(2)}/${c.lng.toFixed(1)}/${c.lat.toFixed(1)}`);
});

// Live cursor coords in game space, handy for verifying alignment.
const coordsEl = document.getElementById('coords');
map.on('mousemove', (e) => {
  coordsEl.textContent = `x ${e.latlng.lng.toFixed(1)}  z ${e.latlng.lat.toFixed(1)}`;
});

const icons = {};
const iconFor = (kind) => (icons[kind] ??= L.divIcon({ className: '', html: iconHtml(kind), iconSize: [24, 24], iconAnchor: [12, 12], popupAnchor: [0, -12] }));
const marker = (p, kind, html) => L.marker(pos(p), { icon: iconFor(kind) }).bindPopup(html);

/** Classify raw map data into marker points: [{kind, position, html}] — shared by the 2D and 3D views. */
export function classify(d) {
  const out = [];
  const add = (kind, position, html) => out.push({ kind, position, html });
  for (const e of d.extracts) {
    const f = ['pmc', 'scav', 'transit'].includes(e.faction) ? e.faction : 'shared';
    add('extract-' + f, e.position, `<b>${e.name}</b><br>Extract · ${f}${e.note ? `<br><i>${e.note}</i>` : ''}`);
  }
  for (const s of d.spawns) {
    const isBoss = s.categories.includes('boss');
    const isPmc = s.sides.includes('pmc') || s.sides.includes('all');
    const info = `${s.zoneName ?? ''}<br>sides: ${s.sides.join(', ')}<br>cat: ${s.categories.join(', ')}`;
    if (isBoss) add('spawn-boss', s.position, `<b>Boss spawn</b><br>${info}`);
    else if (isPmc && s.categories.includes('player')) add('spawn-pmc', s.position, `<b>PMC spawn</b><br>${info}`);
    else if (s.categories.includes('sniper')) add('spawn-sniper', s.position, `<b>Sniper scav spawn</b><br>${info}`);
    else if (s.categories.includes('scav')) add('spawn-scav', s.position, `<b>Scav spawn</b><br>${info}`);
  }
  for (const h of d.hazards) add('hazard', h.position, `<b>${h.name}</b>`);
  for (const w of d.stationaryWeapons) add('weapon', w.position, `<b>${w.stationaryWeapon.name}</b>`);
  for (const sw of d.switches ?? []) add('switch', sw.position, `<b>${sw.name}</b>`);
  for (const l of d.locks) add('lock', l.position, `<b>${l.key?.name ?? 'Lock'}</b><br>${l.lockType}`);
  return out;
}
let markerPoints = [];
function buildLayers(d) {
  markerPoints = classify(d);
  const groups = {};
  for (const m of markerPoints) {
    (groups[m.kind] ??= { ...KINDS[m.kind], layer: L.layerGroup(), n: 0 });
    groups[m.kind].layer.addLayer(marker(m.position, m.kind, m.html)); groups[m.kind].n++;
  }
  return groups;
}

const layersEl = document.getElementById('layers');
const statusEl = document.getElementById('status');
const defaultOn = new Set(['extract-pmc', 'spawn-pmc']);

function addToggle(label, kind, layer, count, on) {
  if (on) layer.addTo(map);
  const el = document.createElement('label');
  el.innerHTML = `<input type="checkbox" data-kind="${kind ?? ''}" ${on ? 'checked' : ''}> ${kind ? iconHtml(kind, 18) : ''} ${label} ${count != null ? `<span class="count">${count}</span>` : ''}`;
  el.querySelector('input').onchange = (ev) => { ev.target.checked ? layer.addTo(map) : map.removeLayer(layer); view3d?.refresh(); };
  layersEl.appendChild(el);
}
const section = (title) => { const h = document.createElement('div'); h.className = 'group'; h.textContent = title; layersEl.appendChild(h); };

section('Labels');
addToggle('Place names', null, placeLabelsLayer(map, CUSTOMS_LABELS), CUSTOMS_LABELS.length, true);
section('Markers');
// Placeholder toggles until the tarkov.dev API answers; replaced by real ones in renderMarkers().
const MARKER_KINDS = Object.keys(KINDS);
const placeholders = document.createElement('div');
placeholders.className = 'pending';
placeholders.title = 'Waiting for tarkov.dev API';
for (const kind of MARKER_KINDS) placeholders.innerHTML += `<label><input type="checkbox" disabled> ${iconHtml(kind, 18)} ${KINDS[kind].label} <span class="count">…</span></label>`;
layersEl.appendChild(placeholders);

// Markers come from the tarkov.dev API; retry until it answers, and cache the last good response.
const CACHE_KEY = `tarkovzero:${mapData.key}`;
function renderMarkers(data, source) {
  const groups = buildLayers(data);
  placeholders.remove();
  view3d?.refresh();
  const bosses = data.bosses.map((b) => `${b.name} (${Math.round(b.spawnChance * 100)}%)`).join(', ');
  statusEl.innerHTML = `Data: ${source}${bosses ? `<br>Bosses: ${bosses}` : ''}`;
  for (const kind of MARKER_KINDS) {
    const g = groups[kind];
    if (g) addToggle(g.label, kind, g.layer, g.n, defaultOn.has(kind));
  }
}
async function loadMarkers(attempt = 0) {
  try {
    const { data, source } = await loadMapData(mapData.key);
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch {}
    renderMarkers(data, source);
  } catch (e) {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached && attempt === 0) return renderMarkers(JSON.parse(cached), 'browser cache');
    statusEl.textContent = `Markers: tarkov.dev API unavailable, retrying every 60s… (${attempt + 1})`;
    setTimeout(() => loadMarkers(attempt + 1), 60_000);
  }
}
loadMarkers();

// ---- Live positions (companion app -> relay -> here)
const liveEl = document.getElementById('live');
const ui = { render() {
  const ps = [...live.players.values()];
  liveEl.innerHTML = `<div class="group">Live position</div>
    ${ps.map((p) => `<div class="player"><span class="sw" style="background:${esc(p.color)}"></span><b title="double-click to rename" data-rn="${esc(p.code)}">${esc(p.name)}</b>${p.name !== p.code ? `<span class="code">${esc(p.code)}</span>` : ''}<span class="st">${esc(p.status)}</span><button class="small" data-rm="${esc(p.code)}">✕</button></div>`).join('')}
    <input type="text" id="live-code" maxlength="7" placeholder="pairing code, e.g. K7P3QX">
    <button id="live-add">${ps.length ? 'Add another' : 'Connect'}</button>
    <div class="err" id="live-err"></div>
    <div class="opts"><label><input type="checkbox" id="live-follow" ${live.opts.follow ? 'checked' : ''}> follow</label><label><input type="checkbox" id="live-trail" ${live.opts.trail ? 'checked' : ''}> trail</label><button class="small" id="live-clear">clear trail</button></div>`;
  const input = liveEl.querySelector('#live-code');
  const tryAdd = () => { try { live.add(input.value); input.value = ''; ui.render(); } catch (e) { liveEl.querySelector('#live-err').textContent = e.message; } };
  liveEl.querySelector('#live-add').onclick = tryAdd;
  input.onkeydown = (e) => { if (e.key === 'Enter') tryAdd(); };
  liveEl.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => live.remove(b.dataset.rm)));
  liveEl.querySelectorAll('[data-rn]').forEach((b) => (b.ondblclick = () => { const n = prompt('Name for this player (empty = use companion name / code)', b.textContent); if (n !== null) live.rename(b.dataset.rn, n); }));
  liveEl.querySelector('#live-follow').onchange = (e) => (live.opts.follow = e.target.checked);
  liveEl.querySelector('#live-trail').onchange = (e) => (live.opts.trail = e.target.checked);
  liveEl.querySelector('#live-clear').onclick = () => live.clearTrails();
} };
const live = createLive(map, mapData, ui);
ui.render();
live.restore();
for (const c of (new URLSearchParams(location.search).get('live') || '').split(',').filter(Boolean)) { try { live.add(c); } catch {} }
ui.render();

// ---- 3D view (deck.gl), lazy-loaded; shares marker/label/live data with the 2D map.
let view3d = null;
const visibleKinds = () => new Set([...document.querySelectorAll('#layers input[data-kind]:not([data-kind=""])')].filter((i) => i.checked).map((i) => i.dataset.kind));
const labelsOn = () => document.querySelector('#layers input[data-kind=""]')?.checked ?? true;
const btn3d = document.getElementById('view-toggle');
async function setView(mode) {
  localStorage.setItem('view', mode);
  btn3d.textContent = mode === '3d' ? '2D' : '3D';
  document.body.classList.toggle('view-3d', mode === '3d');
  if (mode === '3d') {
    if (!view3d) {
      const { createView3d } = await import('./map3d.js');
      view3d = await createView3d(document.getElementById('map3d'), mapData, {
        markers: () => markerPoints.filter((m) => visibleKinds().has(m.kind)),
        labels: () => (labelsOn() ? CUSTOMS_LABELS : []),
        players: () => [...live.players.values()],
        onViewChange: (v) => { /* keep 2D roughly in sync */ map.setView([-v.target[1], -v.target[0]], v.zoom + 2.06, { animate: false }); },
      });
    }
    const c = map.getCenter();
    view3d.setView({ target: [-c.lng, -c.lat, 0], zoom: map.getZoom() - 2.06 });
    view3d.refresh();
  }
}
btn3d.onclick = () => setView(document.body.classList.contains('view-3d') ? '2d' : '3d');
const origRender = ui.render; ui.render = () => { origRender(); view3d?.refresh(); };
if (new URLSearchParams(location.search).get('view') === '3d' || localStorage.getItem('view') === '3d') setView('3d');
