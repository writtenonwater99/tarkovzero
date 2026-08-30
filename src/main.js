import L from 'leaflet';
import { MAPS, selectMap } from './mapdata.js';
import { getCRS, pos, toLatLngBounds } from './crs.js';
import { loadMapData } from './api.js';
import { roadmapLayer } from './roadmap.js';
import { placeLabelsLayer } from './placeLabels.js';
import { LABELS } from './labels.js';
import { KINDS, iconHtml, extractLetter, extractReq, dotHtml, clusterHtml, EXTRACT_SUB } from './icons.js';
// One LOD rule for both views: tiers cut on metres per pixel, with hysteresis. See src/lod.js.
import { updateTier, currentTier, cellFor, clusterPoints } from './lod.js';
import { createLive, esc } from './live.js';
import { createQuests } from './quests.js';
import { createAssistant } from './assistant.js';
import { createShell } from './shell.js';
import { createOmnibox } from './omnibox.js';
// zOff() is the 2D↔3D zoom relation. It is this MAP's CRS scale and nothing else, so the two views
// always report the same metres per pixel — see the note in camera.js.
import { CAM, zoomOffsetFor, fitZoom, setFitBox } from './camera.js';

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
let assistant = null;   // the AI card; created once window.tz exists (bottom of this file)
let omni = null;        // the omnibox controller; created last — it drives everything above
// The zoom limits mirror src/map3d.js's own — deck applies its copy, so a wider pair here would
// only ever be a lie about what a zoom key can reach.
let v3 = { target: [0, 0, 0], zoom: 0, rotationX: CAM.rotationX, rotationOrbit: CAM.rotationOrbit, minZoom: -2, maxZoom: 5 };

/* ------------------------------------------------------------------ shell -- */
// Floating HUD: right icon toolbar, docked panels, pin model, safe-viewport rect. Everything the
// panels contain is mounted statically in index.html — the shell only shows and hides it.
let booted = false;   // the map exists and the HUD can be measured
const shell = createShell({ store, onLayout: () => { if (booted) updateHud(); } });
const stageEl = $('#stage');
/** The rect nothing floats over, in stage CSS px. */
const safeRect = () => shell.safeRect();
/** How far the safe rect's centre sits from the stage centre, in px. */
function safeOffset() {
  const s = stageEl.getBoundingClientRect();
  const r = safeRect();
  return L.point((r.left + r.right) / 2 - s.width / 2, (r.top + r.bottom) / 2 - s.height / 2);
}

const requestedMap = new URLSearchParams(location.search).get('map');
const mapData = selectMap(requestedMap);
/** zoom2d = zoom3d + zOff(), for THIS map. Both directions and the permalink go through it. */
const zOff = () => zoomOffsetFor(mapData);
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

/* ------------------------------------------------------------------- look ----- */
// The render style (docs/plans/RENDER-REALISM.md Stage 1): `realistic` is the default, `vector` is
// the old map-board skin over exactly the same geometry. Like Relief/Trees/Rocks, `?look=` overrides
// the persisted choice for one visit without rewriting it.
const looks = new Set(['realistic', 'vector']);
const lookQuery = new URLSearchParams(location.search).get('look');
let look = looks.has(lookQuery) ? lookQuery : String(store.get('look', 'realistic'));
if (!looks.has(look)) look = 'realistic';
function setLook(next, persist = true) {
  next = looks.has(next) ? next : 'realistic';
  look = next;
  $$('#look-toggle .seg-cell').forEach((b) => {
    const active = b.dataset.look === look;
    b.classList.toggle('on', active);
    b.setAttribute('aria-pressed', String(active));
  });
  if (persist) store.set('look', look);
  view3d?.setLook(look);
  return look;
}
$$('#look-toggle .seg-cell').forEach((b) => (b.onclick = () => setLook(b.dataset.look)));
setLook(look, false);

/* ------------------------------------------------------------- footprint -- */
/**
 * THE box every fit frames — in both views, at every aspect.
 *
 * The map's own bounds are not the whole of what a player has to see: the extract and transit
 * badges sit ON the rim, and they carry a letter, a name and (in 3D) a hover line that hang off the
 * marker's own position. Framing the terrain and forgetting the furniture is QA H5 — Woods opened
 * with "RAILWAY BRIDGE TO TARKOV" cut by the right edge and two extract badges cut by the bottom.
 * So the footprint is the union of the map bounds with every extract/transit position grown by
 * MARKER_MARGIN metres, and the fit contains THAT.
 *
 * The margin is a distance, not a pixel count, because it has to mean the same thing before the
 * zoom it will be measured at is known; 40 m is ~44 px at the Customs default framing, which clears
 * the badge and most of its name.
 */
const MARKER_MARGIN = 40;
const FURNITURE_KINDS = ['extract-pmc', 'extract-scav', 'extract-shared', 'extract-transit'];
let footprint = {
  x0: Math.min(bounds.getWest(), bounds.getEast()), x1: Math.max(bounds.getWest(), bounds.getEast()),
  z0: Math.min(bounds.getSouth(), bounds.getNorth()), z1: Math.max(bounds.getSouth(), bounds.getNorth()),
};
/** Recompute the footprint from the markers that have loaded. Returns true when it actually moved. */
function updateFootprint() {
  const next = {
    x0: Math.min(bounds.getWest(), bounds.getEast()), x1: Math.max(bounds.getWest(), bounds.getEast()),
    z0: Math.min(bounds.getSouth(), bounds.getNorth()), z1: Math.max(bounds.getSouth(), bounds.getNorth()),
  };
  for (const m of markerPoints) {
    if (!FURNITURE_KINDS.includes(m.kind)) continue;
    const { x, z } = m.position ?? {};
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    next.x0 = Math.min(next.x0, x - MARKER_MARGIN); next.x1 = Math.max(next.x1, x + MARKER_MARGIN);
    next.z0 = Math.min(next.z0, z - MARKER_MARGIN); next.z1 = Math.max(next.z1, z + MARKER_MARGIN);
  }
  const moved = ['x0', 'x1', 'z0', 'z1'].some((k) => Math.abs(next[k] - footprint[k]) > 0.5);
  footprint = next;
  if (moved) syncFitBox();
  return moved;
}
const footprintBounds = () => L.latLngBounds([footprint.z0, footprint.x0], [footprint.z1, footprint.x1]);
const footprintCentre = () => ({ x: (footprint.x0 + footprint.x1) / 2, z: (footprint.z0 + footprint.z1) / 2 });

/**
 * Fit = **contain the footprint in the safe rect**, not cover the window.
 *
 * Cover (`max(sx, sy)`) fills the frame by cropping the long axis, which reads well only while the
 * viewport's aspect is near the map's. It is not: on a 2:1 map a taller window made cover pick a
 * TIGHTER camera and slice the map off both sides (QA H1). Contain says the opposite and says it at
 * every aspect — a window that grows can only ever show the same map bigger, never less of it.
 * The safe rect (the part of the stage nothing floats over) is the box, so the corners under the
 * chips, the toolbar and the omnibox are chrome, not the bit of the map you needed.
 *
 * Cover is still one keystroke away and unchanged: F / #hud-fit ask for it explicitly, and that is
 * the only thing that switches `fitMode` (QA H2 — a first visit owes the player the whole map).
 * Only an explicit fit (F, #hud-fit, `> fit`, first load, window resize, markers arriving) moves the
 * camera; opening, closing or pinning a panel never does.
 */
function coverZoom() {
  const off = safeOffset();
  const grow = L.point(-2 * Math.abs(off.x), -2 * Math.abs(off.y));
  const z = map.getBoundsZoom(bounds, true, grow);
  return Number.isFinite(z) ? z : map.getZoom();
}
function containZoom() {
  const off = safeOffset();
  // Positive padding SHRINKS the box Leaflet fits into, by the same recentring offset the negative
  // padding above grows it — the map is centred on the safe rect, so this is that rect.
  const shrink = L.point(2 * Math.abs(off.x), 2 * Math.abs(off.y));
  const z = map.getBoundsZoom(footprintBounds(), false, shrink);
  return Number.isFinite(z) ? z : map.getZoom();
}
let fitMode = 'contain';
function fit(mode = fitMode) {
  fitMode = mode === 'cover' ? 'cover' : 'contain';
  const cover = fitMode === 'cover';
  const z = cover ? coverZoom() : containZoom();
  const b = cover ? bounds : footprintBounds();
  const centre = map.unproject(map.project(b.getCenter(), z).subtract(safeOffset()), z);
  map.setView(centre, z, { animate: false });
}

/**
 * The 3D fit, computed in 3D — not borrowed from the 2D one.
 *
 * The old path was `coverZoom() - zOff(tilt)`, which fits a map by its *unrotated* pixel box and
 * then subtracts a constant tuned on Customs. Two things break: the constant secretly carries
 * Customs' CRS scale (2.06 = -log2(0.239)), so every other map lands at the wrong scale; and a 2D
 * cover on a near-square map is decided by its width, while the 3D frame is decided by the depth of
 * the rhombus the tilt makes of it. Woods (1407 x 1356 m) therefore opened ~2.1x too close, with a
 * wider window making it worse. So the fit asks for the projected footprint at the tilt we are
 * actually going to use, and CONTAINS it in the safe rect (see fit() above) — the map's middle in
 * the middle of the rect nothing floats over, and every edge of it on screen at every aspect.
 */
function fit3dBox(rotationX = CAM.rotationX, rotationOrbit = CAM.rotationOrbit) {
  const r = safeRect();
  return {
    width: Math.abs(bounds.getEast() - bounds.getWest()),
    depth: Math.abs(bounds.getNorth() - bounds.getSouth()),
    fitWidth: footprint.x1 - footprint.x0,
    fitDepth: footprint.z1 - footprint.z0,
    viewportWidth: Math.max(1, r.right - r.left),
    viewportHeight: Math.max(1, r.bottom - r.top),
    rotationX, rotationOrbit,
  };
}
function fit3dZoom(rotationX = CAM.rotationX, rotationOrbit = CAM.rotationOrbit) {
  return fitZoom(fit3dBox(rotationX, rotationOrbit));
}
/**
 * Hand camera.js the box the fit frames, so the zoom FLOOR every drag, wheel and permalink is
 * clamped against is exactly this fit minus MIN_ZOOM_MARGIN. map3d.js owns the clamp but knows
 * neither the safe rect nor the marker furniture; without this the floor could sit above the fit.
 */
function syncFitBox() { setFitBox(fit3dBox()); }
syncFitBox();
/** Restore the default 3D framing: contain the footprint at the oblique default, on the safe rect. */
function fit3d() {
  syncFitBox();
  const zoom = fit3dZoom(CAM.rotationX, CAM.rotationOrbit);
  if (zoom == null) return;
  const c = footprintCentre();
  set3d({ target: target3dFor(c.x, c.z, zoom, CAM.rotationX, CAM.rotationOrbit), zoom, rotationX: CAM.rotationX, rotationOrbit: CAM.rotationOrbit });
}

// View permalink: #zoom/x/z (game coords); otherwise fit the whole map to the window.
const hash = location.hash.slice(1).split('/').map(Number);
// 3D is the site's default view (founder, 2026-08-29): with no ?view= and nothing remembered we
// open the diorama. 2D stays one click — or `3` — away, and both choices persist.
const viewParam = new URLSearchParams(location.search).get('view');
const savedView = localStorage.getItem('view');
const starts3d = viewParam ? viewParam !== '2d' : savedView ? savedView === '3d' : true;
const arrivedByHash = hash.length === 3 && hash.every(Number.isFinite);
let initial3dHash = starts3d && arrivedByHash
  ? { target: [-hash[1], -hash[2], 0], zoom: hash[0] - zOff() }
  : null;
let autoFit = true; // refit on window resize only until the user navigates (or arrived via a permalink)
let framed3d = false; // the 3D camera has been framed once; later 2D->3D switches hand the view over
if (arrivedByHash) { map.setView([hash[2], hash[1]], hash[0], { animate: false }); autoFit = false; }
else fit();
// Remember what "fit" means while the 2D map is measurable — #map is display:none in 3D.
let fitState = { center: map.getCenter(), zoom: map.getZoom() };
const rememberFit = () => {
  if (is3d()) return;
  fitState = { center: bounds.getCenter(), zoom: coverZoom() };
};
rememberFit();
// A resize changes the frame the fit was computed for, in both views: 2D refits in whichever mode it
// is in and 3D refits its projected one (the 3D fit depends on the viewport aspect, so a wider window
// used to leave the diorama framed for the old one). The fit box the zoom floor is measured from
// moves with the window whether or not anything is refitted.
window.addEventListener('resize', () => { syncFitBox(); if (autoFit) { fit(); if (is3d()) fit3d(); } rememberFit(); updateHud(); });
for (const ev of ['mousedown', 'wheel', 'touchstart']) map.getContainer().addEventListener(ev, () => { autoFit = false; }, { passive: true });
map.on('zoomstart', (e) => { if (e.originalEvent) autoFit = false; });
/**
 * The address bar follows the camera — but a permalink OWNS it until the camera leaves it.
 *
 * Every move writes `#zoom/x/z`, and on a permalinked load the first move IS the permalink being
 * applied, so the URL was rewritten before the visitor had touched anything: `#1.4/-209/-280` on
 * Woods came back as `#1.95/-209.0/-280.0` (QA H4), i.e. the sender's own link silently changed
 * under them to a camera they never asked for. So while the camera still stands where the hash put
 * it, nothing is written; the first move that lands somewhere else — including a clamp — arms the
 * writer for good, because from then on the URL has to tell the truth about where the camera is.
 */
let hashArmed = !arrivedByHash;
const onHash = (zoom2d, x, z) => {
  if (!hashArmed) {
    if (Math.abs(zoom2d - hash[0]) < 0.005 && Math.abs(x - hash[1]) < 0.05 && Math.abs(z - hash[2]) < 0.05) return;
    hashArmed = true;
  }
  history.replaceState(null, '', `#${zoom2d.toFixed(2)}/${x.toFixed(1)}/${z.toFixed(1)}`);
};
map.on('moveend', () => {
  if (is3d()) onHash((v3.zoom ?? 0) + zOff(), -v3.target[0], -v3.target[1]);
  else { const c = map.getCenter(); onHash(map.getZoom(), c.lng, c.lat); }
});
map.on('move zoom', updateHud);
// The marker tier and the cluster grid follow the zoom, not the pan — so they settle once, at the
// end of a zoom, instead of on every animation frame.
map.on('zoomend', () => applyLod());

/* ---------------------------------------------------------------- HUD ---- */
const coordsEl = $('#coords');
const scaleCap = $('#scale .scale-cap');
const scaleBar = $('#scale .scale-line i');
const compass = $('#hud-north svg');
const showCoords = (x, z) => { coordsEl.innerHTML = `X <b>${num(x)}</b>&nbsp;&nbsp; Z <b>${num(z)}</b>`; };
const idleCoords = () => { coordsEl.textContent = '—'; };
// While a primary live player is streaming/stale, #coords is their read-out, not the cursor — the
// live section below flips this on/off through updateTelemetry().
let liveTelemetryActive = false;
map.on('mousemove', (e) => { if (!liveTelemetryActive) showCoords(e.latlng.lng, e.latlng.lat); });
map.on('mouseout', () => { if (!liveTelemetryActive) idleCoords(); });

/** Set once the 2D place-label layers exist; re-clips them against the safe rect. */
let labelClip = null;
const SNAP = [10, 25, 50, 100, 200, 500, 1000, 2000];
function metresPerPixel() {
  if (is3d()) return 1 / Math.pow(2, v3.zoom ?? 0);
  return 1 / (Math.abs(mapData.transform[0]) * Math.pow(2, map.getZoom()));
}
function updateHud() {
  const mpp = metresPerPixel();
  if (!Number.isFinite(mpp) || mpp <= 0) return;
  updateTier(mpp);   // keep window.tz.lod live during a zoom; the redraw happens on zoomend
  let m = SNAP[0];
  for (const s of SNAP) if (s / mpp <= 120) m = s;
  scaleCap.textContent = m >= 1000 ? `${m / 1000} km` : `${m} m`;
  const w = Math.round(m / mpp) + 'px';
  scaleBar.style.width = w; scaleBar.parentElement.style.width = w;
  compass.style.setProperty('--rot', `${-(v3.rotationOrbit ?? 0)}deg`);
  labelClip?.();
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
const iconFor = (kind, letter = null, level = 'surface', req = null) => {
  const key = `${kind}:${letter ?? ''}:${safeLevel(level)}:${req ?? ''}`;
  return (icons[key] ??= L.divIcon({ className: '', html: iconHtml(kind, kind.startsWith('extract') ? 26 : 22, letter, safeLevel(level), null, req), iconSize: [24, 24], iconAnchor: [12, 12], popupAnchor: [0, -12] }));
};
const dotIcons = {};
const dotIcon = (kind) => (dotIcons[kind] ??= L.divIcon({ className: '', html: dotHtml(kind, 6), iconSize: [6, 6], iconAnchor: [3, 3], popupAnchor: [0, -4] }));
/** The requirement line for an extract, or '' — the same text the 3D chip shows on hover. */
const reqText = (name) => EXTRACT_SUB[(name || '').trim()] ?? '';

/**
 * One marker point, drawn at the tier the camera is currently in.
 *
 *   dot   6 px desaturated dot in the category colour; still clickable, still has its popup
 *   icon  the badge, no hover label
 *   full  badge + a hover label
 *
 * Extracts and transits ignore the tier entirely (red team #12): they are the thing the map is
 * for, and a 6 px dot where your way out is would be a worse map, not a cleaner one.
 */
function marker(p, kind, html, name = null, level = 'surface', tier = 'full') {
  const isExtract = kind.startsWith('extract');
  const t = isExtract ? 'full' : tier;
  if (t === 'dot') return L.marker(pos(p), { icon: dotIcon(kind) }).bindPopup(html);
  const req = isExtract ? extractReq(name) : null;
  const m = L.marker(pos(p), { icon: iconFor(kind, isExtract ? extractLetter(name) : null, level, req) }).bindPopup(html);
  // Extracts carry their full name on hover — the badge letter alone is a riddle — and now the
  // requirement rides with it instead of being printed under every badge at every zoom.
  if (isExtract && name) {
    const sub = reqText(name);
    m.bindTooltip(esc(name + levelSuffix(level)) + (sub ? `<i>${esc(sub)}</i>` : ''), { direction: 'top', offset: [0, -13], className: `extract-name ${kind} level-${safeLevel(level)}`, opacity: 1 });
  } else if (t === 'full' && name) {
    m.bindTooltip(esc(name + levelSuffix(level)), { direction: 'top', offset: [0, -12], className: 'mk-name', opacity: 1 });
  }
  return m;
}
/** A grid cluster: one mark plus its count, and a click that zooms in far enough to split it. */
function clusterMarker(kind, c, tier) {
  const m = L.marker([c.z, c.x], {
    icon: L.divIcon({ className: '', html: clusterHtml(kind, c.count, tier), iconSize: [26, 26], iconAnchor: [13, 13] }),
    riseOnHover: true,
  });
  m.bindTooltip(`${c.count} ${esc(KINDS[kind].label.toLowerCase())}`, { direction: 'top', offset: [0, -14], className: 'mk-name', opacity: 1 });
  m.on('click', () => { autoFit = false; map.setView([c.z, c.x], Math.min(map.getMaxZoom(), map.getZoom() + 1), { animate: true }); });
  return m;
}

/** Classify raw map data into marker points: [{kind, position, html}] — shared by the 2D and 3D views. */
export function classify(d) {
  const out = [];
  const add = (kind, position, html, name = null, level = 'surface') => out.push({ kind, position, html, name, level: safeLevel(level) });
  for (const e of d.extracts) {
    const f = ['pmc', 'scav', 'transit'].includes(e.faction) ? e.faction : 'shared';
    const level = safeLevel(e.level);
    // The requirement is a badge corner glyph and a hover line now, so the popup is where the
    // words live: "REQ: GREEN FLARE" above the wiki note, not a second label on the map.
    const req = EXTRACT_SUB[(e.name || '').trim()];
    add('extract-' + f, e.position, `<b>${e.name}${levelSuffix(level)}</b>Extract · ${f} · ${level}${req ? `<br><b class="mk-req">${esc(req)}</b>` : ''}${e.note ? `<br><i>${e.note}</i>` : ''}`, e.name, level);
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
const pointsOf = new Map(); // kind -> points[] (the layer is rebuilt from these on every tier change)

/* ---------------------------------------------------------------- LOD ---- */
// Which kinds ignore the zoom tier, and which ones collapse into counted clusters. Extracts and
// transits are exempt by decision (red team #12); live players and selected-quest objectives are
// exempt by construction — they are drawn by live.js and quests.js, which never ask about a tier.
const clustered = (kind) => kind.startsWith('spawn-');
let lodState = { tier: null, cell: 0 };
// Things outside this module that also draw at a tier and have to be told when it moves. Filled in
// after the modules that own them exist (quests.js is created further down), so applyLod can fire
// during the first data load without reaching into a binding that is still in its temporal dead zone.
const tierHooks = [];

/** Refill one kind's layer group at the current tier. Cheap: ~200 points on Customs. */
function fillMarkerLayer(kind) {
  const layer = layerOf.get(kind);
  if (!layer) return;
  layer.clearLayers();
  const pts = pointsOf.get(kind) ?? [];
  const t = kind.startsWith('extract') ? 'full' : lodState.tier ?? 'full';
  if (t !== 'full' && clustered(kind)) {
    for (const c of clusterPoints(pts, lodState.cell)) {
      if (c.count === 1) layer.addLayer(marker(c.points[0].position, kind, c.points[0].html, c.points[0].name, c.points[0].level, t));
      else layer.addLayer(clusterMarker(kind, c, t));
    }
    return;
  }
  for (const p of pts) layer.addLayer(marker(p.position, kind, p.html, p.name, p.level, t));
}
const rebuildMarkerLayers = () => { for (const kind of layerOf.keys()) fillMarkerLayer(kind); };

/**
 * Fold the current metres-per-pixel into the shared tier and redraw whatever depends on it.
 *
 * Called on zoomend rather than on every zoom frame: the tier only changes at a boundary, the
 * cluster grid is in world units (panning cannot move it), and rebuilding mid-animation would
 * throw away work Leaflet is about to re-render anyway.
 */
function applyLod(force = false) {
  const mpp = metresPerPixel();
  if (!Number.isFinite(mpp) || mpp <= 0) return;
  const t = updateTier(mpp);
  const cell = cellFor(mpp);
  const tierChanged = t !== lodState.tier;
  // Reclustering on a small zoom change inside one tier keeps the counts honest without redrawing
  // on every wheel notch.
  if (!force && !tierChanged && Math.abs(cell - lodState.cell) < lodState.cell * 0.15) return;
  lodState = { tier: t, cell };
  if (!is3d()) rebuildMarkerLayers();
  if (tierChanged) { applyLabels(); for (const f of tierHooks) f(t); }
}

/* ------------------------------------------------------------- labels ---- */
// Two panes so major/minor place names can be styled apart in 2D, and the same
// split feeds the 3D TextLayer through src.labels().
const SURFACE_LABELS = mapLabels.filter((l) => l.floor !== 'U');
const MAJOR = SURFACE_LABELS.filter((l) => (l.size ?? 100) >= 100);
const MINOR = SURFACE_LABELS.filter((l) => (l.size ?? 100) < 100);
const labelLayers = {
  major: placeLabelsLayer(map, MAJOR, { safeRect }),
  minor: placeLabelsLayer(map, MINOR, { pane: 'labelsMinor', safeRect }),
};
// The chrome can move without the map moving at all (a dock panel opens), so the label clip has to
// be re-run from the layout hook too — see updateHud().
labelClip = () => { labelLayers.major.reclip(); labelLayers.minor.reclip(); };
// Density "Auto" is the default (step 4): Key at fit zoom — where the map should read as extracts
// and place names — and All from one tier in, where there is room for the minor names. Off/Key/All
// stay as explicit overrides, and an explicit choice always wins.
let density = store.get('density', 'auto');
let labelsShown = store.get('labels', true);
const effectiveDensity = () => (density !== 'auto' ? density : currentTier() === 'dot' ? 'key' : 'all');
function labelSet() {
  const d = effectiveDensity();
  if (!labelsShown || d === 'off') return [];
  return d === 'key' ? mapLabels.filter((l) => (l.size ?? 100) >= 100) : mapLabels;
}
function applyLabels() {
  const d = effectiveDensity();
  const wantMajor = labelsShown && d !== 'off';
  const wantMinor = labelsShown && d === 'all';
  wantMajor ? labelLayers.major.addTo(map) : map.removeLayer(labelLayers.major);
  wantMinor ? labelLayers.minor.addTo(map) : map.removeLayer(labelLayers.minor);
  // Adding a layer to a Leaflet map raises no map-level event, so nothing else re-runs the safe-rect
  // clip: the labels Key→All brings in were drawn with no clip pass at all and stayed truncated
  // under the toolbar/dock/omnibox until the user happened to pan (measured on Customs: 13 labels
  // with 3 hidden → 32 labels with 3 hidden, the 19 new minors never measured). This is that pass.
  labelClip?.();
  $$('#label-density .seg-cell').forEach((b) => {
    b.classList.toggle('on', b.dataset.density === density);
    // Auto shows which way it is currently leaning, so the control is never a black box.
    b.classList.toggle('auto-on', density === 'auto' && b.dataset.density === d);
  });
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
/** `action` is either the old bare undo callback, or `{label, run, sticky}` for a non-undo action
 *  (e.g. the raid-map-switch toast's "Switch" button) — never performed until the button is clicked. */
function toast(msg, action) {
  toastEl.hidden = false;
  toastEl.textContent = '';
  const s = document.createElement('span'); s.textContent = msg; toastEl.appendChild(s);
  const act = typeof action === 'function' ? { label: 'Undo', run: action } : action;
  if (act) {
    const b = document.createElement('button'); b.textContent = act.label ?? 'Undo'; b.onclick = () => { act.run(); hideToast(); };
    toastEl.appendChild(b);
  }
  clearTimeout(undoTimer); undoTimer = setTimeout(hideToast, act?.sticky ? 8000 : 3000);
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
/**
 * The raid read-out, as icon+value chunks rather than one sentence.
 *
 * Gemini's read (2026-08-29): "40 MIN · 10-12 PMC · PARTISAN 30%" is a monolithic string that has
 * to be *read*; a HUD read-out has to be *glanced at*. Each fact now gets its own glyph, its own
 * number in the mono face, and a hairline divider — so the eye snaps to "how long" or "how many"
 * without parsing the middle dots. Inline SVG, never emoji: an emoji would be a third typeface,
 * colour-managed by the OS, at a size where its detail is mud.
 */
const STATUS_GLYPH = {
  time: '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.4V12l3.1 2.1"/>',
  pmc: '<circle cx="12" cy="7.8" r="3.4"/><path d="M5.4 19.6c0-3.6 2.9-6.2 6.6-6.2s6.6 2.6 6.6 6.2"/>',
  boss: '<path d="M12 3.4a7.1 7.1 0 0 0-7.1 7.1c0 2.4 1.2 4.2 2.9 5.3v3h8.4v-3c1.7-1.1 2.9-2.9 2.9-5.3A7.1 7.1 0 0 0 12 3.4Z"/><circle cx="9.5" cy="11" r="1.4"/><circle cx="14.5" cy="11" r="1.4"/>',
};
const statusChunk = ({ glyph, value, unit }) =>
  `<span class="st-chunk"><svg class="st-ico" viewBox="0 0 24 24" aria-hidden="true">${STATUS_GLYPH[glyph] ?? ''}</svg>` +
  `<span class="st-val mono">${esc(value)}</span>${unit ? `<span class="st-unit">${esc(unit)}</span>` : ''}</span>`;
/** `text` is a plain string (loading / error) or a chunk list built by renderMarkers(). */
function setStatus(state, text, popHtml) {
  statusDot.dataset.state = state;
  if (Array.isArray(text)) {
    statusText.innerHTML = text.map(statusChunk).join('<i class="st-div" aria-hidden="true"></i>');
    statusEl.title = text.map((c) => [c.value, c.unit].filter(Boolean).join(' ')).join(' · ');
  } else {
    statusText.textContent = text;
    statusEl.title = text;
  }
  if (popHtml != null) statusPop.innerHTML = popHtml;
}
statusEl.onclick = () => togglePop(statusPop, statusEl);

/* -------------------------------------------------------- data loading --- */
const CACHE_KEY = `tarkovzero:${mapData.key}`;
function renderMarkers(data, source) {
  markerPoints = classify(data);
  layerOf.clear(); countOf.clear(); pointsOf.clear();
  for (const m of markerPoints) {
    if (!KINDS[m.kind]) continue;
    if (!layerOf.has(m.kind)) { layerOf.set(m.kind, L.layerGroup()); pointsOf.set(m.kind, []); }
    pointsOf.get(m.kind).push(m);
    countOf.set(m.kind, (countOf.get(m.kind) ?? 0) + 1);
  }
  applyLod(true);   // fills every layer group at the tier the camera is already in
  // The extracts are part of the box every fit frames (see updateFootprint), and they arrive after
  // the first fit did. Re-fit only while the camera is still the one WE put there — a visitor who
  // has already panned, or arrived on a permalink, keeps their view.
  if (updateFootprint() && autoFit) { fit(); if (is3d()) fit3d(); }
  fillRows();
  for (const [kind, layer] of layerOf) if (onKinds.has(kind)) layer.addTo(map);
  view3d?.refresh();
  buildSearchIndex();

  const bosses = [...(data.bosses ?? [])].sort((a, b) => b.spawnChance - a.spawnChance);
  const top = bosses[0];
  // Three chunks: how long the raid is, how many PMCs, and the likeliest boss with its odds. The
  // boss keeps its name as the chunk's unit — "30%" alone would be a number with no subject.
  const meta = [
    { glyph: 'time', value: RAID.minutes, unit: 'min' },
    { glyph: 'pmc', value: RAID.pmc, unit: 'pmc' },
    ...(top ? [{ glyph: 'boss', value: `${Math.round(top.spawnChance * 100)}%`, unit: top.name }] : []),
  ];
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

/* ------------------------------------------------------- search index ---- */
// What the omnibox looks things up in: everything on this map that has a name and a position,
// plus the layer rows so "scav" can also mean "the scav spawn filter". Quests are added on the
// omnibox side (they load out of band). See src/omnibox.js.
let index = [];
function buildSearchIndex() {
  index = [];
  const seen = new Set();
  for (const m of markerPoints) {
    if (!m.kind.startsWith('extract') || !m.name || seen.has('e:' + m.name)) continue;
    seen.add('e:' + m.name);
    index.push({ kind: 'extract', label: m.name, sub: `${m.kind.replace('extract-', '')} · ${safeLevel(m.level)}`, level: safeLevel(m.level), x: m.position.x, z: m.position.z, badge: extractLetter(m.name) ?? '', mk: m.kind });
  }
  for (const m of markerPoints) {
    if (!['stash', 'switch'].includes(m.kind) || !m.name) continue;
    index.push({ kind: 'marker', label: m.name, sub: `${m.kind} · ${safeLevel(m.level)}`, x: m.position.x, z: m.position.z, mk: m.kind });
  }
  // Locks and their keys: "ZB-1011" is how a player asks for a door, not "lock".
  for (const m of markerPoints) {
    if (m.kind !== 'lock' || !m.name || seen.has('l:' + m.name)) continue;
    seen.add('l:' + m.name);
    index.push({ kind: 'lock', label: m.name, sub: `key · ${safeLevel(m.level)}`, x: m.position.x, z: m.position.z, mk: m.kind });
  }
  for (const l of mapLabels) index.push({ kind: 'place', label: l.text, sub: 'place', x: l.position[0], z: l.position[1] });
  for (const k of MARKER_KINDS) if (KINDS[k]) index.push({ kind: 'layer', label: KINDS[k].label, sub: 'layer', mk: k });
  omni?.refresh();
}
buildSearchIndex();

/** `> show scav` / `> hide loot` — every layer whose group, kind or label matches. */
function matchLayers(query) {
  const s = query.trim().toLowerCase();
  if (!s) return [];
  const hit = new Set();
  for (const g of GROUPS) if (g.id.startsWith(s) || g.title.toLowerCase().includes(s)) for (const k of g.kinds) hit.add(k);
  for (const k of MARKER_KINDS) if (k.includes(s) || KINDS[k].label.toLowerCase().includes(s)) hit.add(k);
  return [...hit].filter((k) => layerOf.has(k));
}

/**
 * The 3D orbit target that lands the game point (x, z) in the middle of the SAFE rect.
 *
 * The 2D branch of a fly just subtracts safeOffset() in screen px, because Leaflet's screen is the
 * ground plane. In 3D the ground is rotated by the orbit and foreshortened by the tilt, so the same
 * pixel offset is a different world offset. deck's OrbitView puts one common-space unit on one
 * screen pixel at the target, with the ground turned through `rotationOrbit` and squashed by
 * sin(rotationX), which inverts to:
 *
 *   A = px_right / 2^zoom                    B = -px_down / (2^zoom · sin(tilt))
 *   world = ( A·cosθ + B·sinθ , −A·sinθ + B·cosθ )        θ = rotationOrbit
 *
 * (The mapping is exact at the target's own depth and drifts slightly across a perspective frame;
 * over a half-dock offset that is a few pixels, against the ~215 px of not doing it at all.)
 */
function target3dFor(x, z, zoom, rotationX = v3.rotationX, rotationOrbit = v3.rotationOrbit) {
  const off = safeOffset();
  const scale = Math.pow(2, Number(zoom) || 0);
  const tilt = Math.min(CAM.maxRotationX, Math.max(CAM.minRotationX, Number(rotationX) || CAM.rotationX));
  const sin = Math.sin((tilt * Math.PI) / 180);
  if (!Number.isFinite(scale) || scale <= 0 || !(sin > 0)) return [-x, -z, 0];
  const th = ((Number(rotationOrbit) || 0) * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th);
  const A = off.x / scale, B = -off.y / (scale * sin);
  return [-x - (A * c + B * s), -z - (-A * s + B * c), 0];
}

/**
 * How close a fly-to lands, as METRES PER PIXEL rather than a Leaflet zoom.
 *
 * You asked for a thing by name; the map owes you the thing with its badge AND its name, which is
 * src/lod.js's `full` tier — m/px ≤ 0.165. The old constant was a 2D zoom of 4.4, which is 0.196 m/px
 * on Customs (`icon`: a badge, no label) and something different on every other map, because a
 * Leaflet zoom carries the map's CRS scale. In metres per pixel it means the same thing on every map
 * and in both views. A fly never zooms OUT: if you are already closer, you stay there.
 */
const FLY_MPP = 0.14;
function flyTo(x, z) {
  const z2 = Math.max(map.getZoom(), -Math.log2(Math.abs(mapData.transform[0]) * FLY_MPP));
  // Land the target in the middle of the *safe* rect, not the middle of the window: with a panel
  // docked on the right, the geometric centre is behind it. Both views owe the player that.
  if (is3d()) {
    const zoom = z2 - zOff();
    set3d({ target: target3dFor(x, z, zoom), zoom });
  } else {
    const centre = map.unproject(map.project([z, x], z2).subtract(safeOffset()), z2);
    map.setView(centre, z2, { animate: true });
  }
  ping(x, z);
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
  panel: { setOpen: (on) => shell.setOpen('quests', on), isOpen: () => shell.isOpen('quests') },
  // A selected quest is a working session, not a lookup: the panel pins itself while one is on the
  // map and lets go when the last is dropped — unless the user pinned it by hand.
  onSelection: (n) => { shell.setAutoPin('quests', n > 0); shell.setIndicator('quests', n > 0); },
  safeRect,
});
quests.layer.addTo(map);
quests.init();
// Quest pins shrink and drop their numbers below the `full` tier (step 4 polish). The 3D layer
// re-reads the tier on its own every frame; the Leaflet markers are built once per draw, so they
// have to be rebuilt when the camera crosses a boundary.
tierHooks.push(() => { if (!is3d()) quests.draw2d(); });

/* --------------------------------------------------------- live panel ---- */
// State model (red team #11): disconnected -> connecting -> streaming -> stale -> connecting again on
// reconnect. src/live.js owns the machine (`live.state()`, `live.summary()`, `live.primary()`); this
// section is the view — toolbar GPS indicator, the panel list, the telemetry chip, and the raid-map
// mismatch toast (never auto-switches, per red team #6).
const liveEl = $('#live'), liveToggle = $('#live-toggle'), liveSum = $('#live-sum');
const tbLive = $('#tb-live'), tbLiveTip = $('.tb-item[data-tb="live"] .tb-tip');
let liveCollapseTimer = 0;
function setLiveOpen(o) {
  store.set('liveOpen', o);
  shell.setOpen('live', o);
  liveToggle.setAttribute('aria-expanded', String(o));
}
liveToggle.onclick = () => setLiveOpen(!shell.isOpen('live'));

const LIVE_STATE_LABEL = { disconnected: 'Not connected', connecting: 'Connecting…', streaming: 'Streaming', stale: 'Stale' };
function ageSuffix(ms) {
  if (ms == null) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
}
/** Per-row status text: a map mismatch always wins (it explains why the dot isn't green here). */
function rowStatus(s) {
  if (s.map && s.map !== mapData.key) return `on ${MAPS[s.map]?.name ?? s.map}`;
  if (s.state === 'connecting') return 'connecting…';
  const age = ageSuffix(s.ageMs);
  return `${s.state}${age ? ' · ' + age : ''}`;
}
function updateLiveToolbar(st) {
  tbLive.dataset.liveState = st.state;
  const age = st.state === 'streaming' || st.state === 'stale' ? ` — updated ${ageSuffix(st.ageMs)}` : '';
  const label = `Live position — ${LIVE_STATE_LABEL[st.state]}${age}`;
  tbLive.setAttribute('aria-label', label);
  if (tbLiveTip) tbLiveTip.textContent = st.state === 'disconnected' ? 'Live' : `${LIVE_STATE_LABEL[st.state]}${age}`;
}
/** #coords becomes the primary player's read-out while streaming/stale; cursor coords own it otherwise. */
function updateTelemetry(st) {
  const p = (st.state === 'streaming' || st.state === 'stale') ? live.primary() : null;
  if (p?.last) {
    const hdg = Math.round(((p.last.yaw ?? 0) % 360 + 360) % 360);
    const mapName = MAPS[p.map]?.name ?? mapData.name;
    const age = ageSuffix(p.ageMs) || 'just now';
    coordsEl.innerHTML = `X <b>${num(p.last.x)}</b>&nbsp;&nbsp; Z <b>${num(p.last.z)}</b> · HDG <b>${hdg}°</b> · ${esc(mapName)} · ` +
      `<span class="tele-age${p.state === 'stale' ? ' stale' : ''}">${esc(age)}</span>`;
    liveTelemetryActive = true;
    return;
  }
  if (liveTelemetryActive) { liveTelemetryActive = false; idleCoords(); }
}
/** Raid detection (red team #6 spirit): tell, never switch. One toast per distinct mismatched map. */
let raidToastFor = null;
function checkRaidSwitch() {
  const p = live.primary();
  if (!p || !p.map || p.map === mapData.key) { raidToastFor = null; return; }
  if (raidToastFor === p.map) return;
  raidToastFor = p.map;
  const target = MAPS[p.map];
  if (target) toast(`Companion is on ${target.name} — switch?`, { label: 'Switch', run: () => goMap(target.key), sticky: true });
  else toast(`Companion is on ${p.map} — not on TarkovZero yet`);
}
function playerRowHtml(s, primaryCode) {
  return `<div class="player p-${s.state}" data-row="${esc(s.code)}">` +
    `<span class="pcol" style="background:${esc(s.color)}"></span>` +
    `<label class="prad" title="Follow this player"><input type="radio" name="live-primary" data-primary="${esc(s.code)}"${s.code === primaryCode ? ' checked' : ''}><span class="prad-mark"></span></label>` +
    `<b title="double-click to rename" data-rn="${esc(s.code)}">${esc(s.name)}</b>` +
    `<span class="code">${s.name !== s.code ? esc(s.code) : ''}</span>` +
    `<span class="st" data-status="${esc(s.code)}">${esc(rowStatus(s))}</span>` +
    `<button class="rm" data-rm="${esc(s.code)}" aria-label="Remove">✕</button></div>`;
}
/** The 1 Hz path from live.js's ticker: text/class updates only. It must never touch the add-code /
 *  add-name inputs or rebuild rows — a full innerHTML replace every second would blow away whatever
 *  the player is mid-typing (and their focus) the moment a tick lands between keystrokes. */
function tickLivePanel() {
  const list = live.summary();
  const st = live.state();
  liveSum.textContent = list.length ? `${LIVE_STATE_LABEL[st.state]} · ${list.length} player${list.length > 1 ? 's' : ''}` : LIVE_STATE_LABEL.disconnected;
  liveToggle.dataset.liveState = st.state;
  for (const s of list) {
    const row = liveEl.querySelector(`[data-row="${s.code}"]`);
    if (!row) continue; // a structural change is coming through ui.render(); this tick just skips it
    row.className = `player p-${s.state}`;
    const stEl = row.querySelector('[data-status]');
    if (stEl) stEl.textContent = rowStatus(s);
    // The companion's name can arrive after the row was first drawn (it rides a position message,
    // which is tick-only) — keep the visible name/code in sync here too, not just the map tooltip.
    const nameEl = row.querySelector('b[data-rn]');
    if (nameEl && nameEl.textContent !== s.name) nameEl.textContent = s.name;
    const codeEl = row.querySelector('.code');
    if (codeEl) codeEl.textContent = s.name !== s.code ? s.code : '';
  }
  updateLiveToolbar(st);
  updateTelemetry(st);
  checkRaidSwitch();
  // Every position — matched map or not — flows through this cheap path (see live.js onPos), so the
  // 3D live-player arrow/trail has to refresh here, not only on the rarer structural rebuild.
  view3d?.refresh();
}
/** Full rebuild — only for structural events (add/remove/rename/(re)connect/first position). */
function renderLivePanel() {
  const list = live.summary();
  const primaryCode = live.primary()?.code ?? null;
  if (list.length && !shell.isOpen('live')) setLiveOpen(true);
  if (!list.length && shell.isOpen('live')) { clearTimeout(liveCollapseTimer); liveCollapseTimer = setTimeout(() => { if (!live.players.size) setLiveOpen(false); }, 8000); }

  liveEl.innerHTML =
    list.map((s) => playerRowHtml(s, primaryCode)).join('') +
    `<div class="live-add-row">` +
      // "pairing code, e.g. K7P3QX" was clipped to "PAIRING CODE, E." at the dock width — a
      // placeholder cut mid-example teaches nothing (QA D9). The short form fits; the full
      // sentence lives in the title tooltip and the aria-label.
      `<input type="text" id="live-code" maxlength="7" placeholder="code e.g. K7P3QX" title="Pairing code, e.g. K7P3QX" aria-label="Pairing code">` +
      `<input type="text" id="live-name" maxlength="24" placeholder="name (optional)" aria-label="Your name">` +
    `</div>` +
    `<button class="btn-primary" id="live-add">${list.length ? 'Add another' : 'Connect'}</button>` +
    `<div class="err" id="live-err"></div>` +
    `<div class="opts">` +
      `<label class="sw"><input type="checkbox" id="live-follow" ${live.opts.follow ? 'checked' : ''}><span class="track"></span>follow</label>` +
      `<label class="sw"><input type="checkbox" id="live-trail" ${live.opts.trail ? 'checked' : ''}><span class="track"></span>trail</label>` +
      `<button class="ghost" id="live-clear">clear trail</button>` +
    `</div>` +
    `<p class="live-hint">No code yet? Run the companion on the game PC — ` +
      `<a href="https://github.com/writtenonwater99/tarkovzero/blob/main/companion/README.md" target="_blank" rel="noopener">companion/README.md</a>.</p>`;
  const codeInput = $('#live-code', liveEl), nameInput = $('#live-name', liveEl);
  const tryAdd = () => {
    try { live.add(codeInput.value, nameInput.value, { override: !!nameInput.value.trim() }); codeInput.value = ''; nameInput.value = ''; renderLivePanel(); }
    catch (e) { $('#live-err', liveEl).textContent = e.message; }
  };
  $('#live-add', liveEl).onclick = tryAdd;
  codeInput.onkeydown = (e) => { if (e.key === 'Enter') tryAdd(); };
  nameInput.onkeydown = (e) => { if (e.key === 'Enter') tryAdd(); };
  $$('[data-rm]', liveEl).forEach((b) => (b.onclick = () => live.remove(b.dataset.rm)));
  $$('[data-rn]', liveEl).forEach((b) => (b.ondblclick = () => { const n = prompt('Name for this player (empty = use companion name / code)', b.textContent); if (n !== null) live.rename(b.dataset.rn, n); }));
  $$('[data-primary]', liveEl).forEach((r) => (r.onchange = () => live.setPrimary(r.dataset.primary)));
  $('#live-follow', liveEl).onchange = (e) => (live.opts.follow = e.target.checked);
  $('#live-trail', liveEl).onchange = (e) => (live.opts.trail = e.target.checked);
  $('#live-clear', liveEl).onclick = () => live.clearTrails();

  tickLivePanel();
}
// ui.render is the full rebuild — only for structural events (add/remove/rename/connect status).
// ui.tick is everything position-driven: live.js's onPos calls it directly on every incoming position
// (matched map or not — that can be several times a second) and its own 1 Hz ticker calls it too, so
// age text keeps advancing between positions. Both paths end inside tickLivePanel(), which is also
// where the 3D live-player refresh lives — but tick never touches the add-code/add-name inputs or
// rebuilds a row, so a position arriving mid-keystroke can't steal focus or the field's value.
const ui = { render: renderLivePanel, tick: tickLivePanel };
// onQuests: the companion also streams the player's quest log ({t:'quests'}); the Quests panel owns
// what to do with it (list it, auto-select what belongs on this map). See docs/plans/ACTIVE-QUESTS.md.
const live = createLive(map, mapData, ui, {
  onFollow: (x, z) => { if (is3d()) set3d({ target: [-x, -z, 0] }); },
  onQuests: (set) => quests.setQuestSet(set),
});
renderLivePanel();
live.restore();
for (const c of (new URLSearchParams(location.search).get('live') || '').split(',').filter(Boolean)) { try { live.add(c); } catch {} }
renderLivePanel();

/* ----------------------------------------------------------- 3D view ----- */
const visibleKinds = () => new Set([...$$('#layers input[data-kind]')].filter((i) => i.checked && i.dataset.kind).map((i) => i.dataset.kind));
function set3d(patch) {
  v3 = { ...v3, ...patch };
  // Programmatic flies obey the same floor as a right-drag: the eye stays above the ground plane —
  // and *only* map3d.js knows how high the terrain under the orbit target is, so it owns the clamp
  // and its answer is authoritative. v3 is re-seeded from what it actually applied; pushing a second
  // viewState at deck here would throw the ground clamp away and leave the two states disagreeing.
  if (view3d) {
    try { v3 = { ...v3, ...view3d.setView(v3) }; } catch {}
  } else {
    // Before deck exists there is no terrain to clear — the flat horizon floor is all there is.
    v3.rotationX = Math.min(CAM.maxRotationX, Math.max(CAM.minRotationX, v3.rotationX ?? CAM.rotationX));
  }
  mirror2d();
  updateHud();
}
/**
 * Push the 3D camera onto the hidden 2D map, and remember what actually landed there.
 *
 * Leaflet clamps to its own [minZoom, maxZoom], so the zoom we ask for is not always the zoom it
 * keeps: on Woods the 3D fit mirrors to 2.52 but a fully zoomed-out 3D view mirrors to 0.43 against
 * a `minZoom` of 2. Reading that clamped number back on the next 2D→3D switch is what used to move
 * the camera for free. `mirror` is the receipt: while the 2D zoom is still exactly the one this
 * function left there, the hand-over restores the 3D zoom instead of re-deriving it.
 */
let mirror = null;
function mirror2d() {
  map.setView([-v3.target[1], -v3.target[0]], (v3.zoom ?? 0) + zOff(), { animate: false });
  mirror = { zoom2d: map.getZoom(), zoom3d: v3.zoom ?? 0 };
}
/** The 3D zoom a 2D→3D switch should land on, undoing any clamp the mirror suffered. */
function handoffZoom() {
  const z2 = map.getZoom();
  return mirror && Math.abs(z2 - mirror.zoom2d) < 1e-9 ? mirror.zoom3d : z2 - zOff();
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
        look,
        markers: () => markerPoints.filter((m) => visibleKinds().has(m.kind)),
        labels: labelSet,
        players: () => [...live.players.values()],
        quests: () => quests.deckData(),
        onQuestClick: (obj) => quests.onDeckClick(obj),
        onViewChange: (v) => {
          v3 = { ...v3, ...v };
          mirror2d();
          updateHud();
        },
      });
      view3d.setFloor(floor === 'all' || floor === 'U' ? floor : Number(floor));
      view3d.setNature({ trees: treesShown, rocks: rocksShown });
      try { view3d.deck?.setProps({ onHover: (i) => { const c = i?.coordinate; Array.isArray(c) ? showCoords(-c[0], -c[1]) : idleCoords(); } }); } catch {}
    }
    if (initial3dHash) { const direct = initial3dHash; initial3dHash = null; set3d(direct); }
    // The FIRST time 3D opens without a permalink it is a fit, not a hand-off: the frame is computed
    // in 3D (fit3d), which fits the map's *projected* footprint at the tilt we are about to use —
    // a 2D cover zoom fits by width and frames a near-square map like Woods against the camera.
    // The gate is the permalink, NOT `autoFit`: `autoFit` is cleared by any 2D pan or wheel, so
    // gating on it meant one pan in 2D silently bought back the pre-fix framing (QA: Woods opened
    // at 1.160 instead of 0.085). Every later 2D→3D switch picks the 2D view up where it was left,
    // so a 3D → 2D → 3D round trip still lands on the same camera.
    else if (!framed3d && !arrivedByHash) fit3d();
    else { const c = map.getCenter(); set3d({ target: [-c.lng, -c.lat, 0], zoom: handoffZoom() }); }
    framed3d = true;
    view3d.refresh();
  } else {
    // #map was display:none while 3D drove it — remeasure before Leaflet draws again.
    map.invalidateSize({ animate: false });
    // 3D moved the shared LOD tier while it was on screen; rebuild the Leaflet layers to match.
    applyLod(true);
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

// (view3d refresh lives inside tickLivePanel() now — both ui.render and ui.tick end up there, see above.)

/* ------------------------------------------------------- HUD controls ---- */
function zoomBy(d) {
  if (is3d()) set3d({ zoom: Math.max(v3.minZoom ?? -2, Math.min(v3.maxZoom ?? 5, (v3.zoom ?? 0) + d)) });
  else map.setZoom(map.getZoom() + d, { animate: true });
}
$('#hud-zin').onclick = () => zoomBy(0.5);
$('#hud-zout').onclick = () => zoomBy(-0.5);
$('#hud-fit').onclick = () => {
  // Fit in 3D restores the default framing: the contain zoom, the oblique tilt and the diorama's
  // near corner, centred on the safe rect. In 2D it is the one place cover lives (QA H2): asking
  // for the fit by hand is asking to fill the window, and it sticks until the next explicit fit.
  if (is3d()) fit3d();
  else { autoFit = true; fit('cover'); }
};
$('#hud-north').onclick = () => {
  const t0 = performance.now(), o0 = v3.rotationOrbit ?? 0, x0 = v3.rotationX ?? CAM.rotationX;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 400), e = 1 - Math.pow(1 - k, 3);
    set3d({ rotationOrbit: o0 + (CAM.rotationOrbit - o0) * e, rotationX: x0 + (CAM.rotationX - x0) * e });
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
};

/* ---------------------------------------------------------- popovers ----- */
function togglePop(pop, trigger) {
  const open = pop.hidden;
  closePops();
  pop.hidden = !open;
  if (open) placePop(pop, trigger);
  trigger?.setAttribute('aria-expanded', String(open));
}
/**
 * Put a popover on screen and keep it there.
 *
 * A `fixed` popover (the Controls list) is placed by hand: it hangs off a button inside a panel,
 * and .panel/.panel-body clip their content, so it has to escape the panel box entirely. It goes
 * under the button, right-aligned with it, flips above if it will not fit below, and is squared up
 * with the window edges either way. An `absolute` one (the status chip's) is already where it
 * belongs and only needs the same last nudge.
 */
function placePop(pop, trigger) {
  pop.style.transform = '';
  const M = 10;                                   // margin from the window edge
  const vw = window.innerWidth, vh = window.innerHeight;
  if (getComputedStyle(pop).position === 'fixed') {
    if (!trigger) return;
    const t = trigger.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let top = t.bottom + 8;
    if (top + h > vh - M) top = t.top - 8 - h;    // no room below: flip above the button
    top = Math.min(Math.max(M, top), Math.max(M, vh - M - h));
    const left = Math.min(Math.max(M, t.right - w), Math.max(M, vw - M - w));
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
    return;
  }
  const r = pop.getBoundingClientRect();
  if (!r.height) return;
  let dy = 0;
  if (r.bottom > vh - M) dy = vh - M - r.bottom;
  if (r.top + dy < M) dy = M - r.top;
  if (dy) pop.style.transform = `translateY(${Math.round(dy)}px)`;
}
function closePops() {
  for (const p of $$('.pop')) p.hidden = true;
  setMapMenu(false);
  statusEl.setAttribute('aria-expanded', 'false');
  $('#help-btn').setAttribute('aria-expanded', 'false');
}
$('#help-btn').onclick = (e) => { e.stopPropagation(); togglePop($('#hint3d'), $('#help-btn')); };
document.addEventListener('click', (e) => { if (!e.target.closest('.pop') && !e.target.closest('#status') && !e.target.closest('#help-btn')) closePops(); });

/* ------------------------------------------------------------ keyboard --- */
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
  if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); omni?.focus(); return; }
  if (e.key === 'Escape') {
    // Peel one layer at a time: popovers and cards, then the omnibox, then the transient panel.
    // Pinned workspaces stay. (Esc inside the omnibox never reaches here — it stops propagation.)
    const hadPop = $$('.pop').some((p) => !p.hidden) || !mapMenu.hidden;
    const hadCard = !$('#quest-card').hidden || !!$('.leaflet-popup');
    closePops(); map.closePopup(); quests.closeCard();
    if (hadPop || hadCard) return;
    if (omni?.escape()) return;
    shell.closeTransient();
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); omni?.focus(); return; }
  if (e.key === '3') { setView(is3d() ? '2d' : '3d'); return; }
  if (e.key === 'q' || e.key === 'Q') { quests.setOpen(true); $('#quest-find')?.focus(); return; }
  if (e.key === 'a' || e.key === 'A') { e.preventDefault(); omni?.focusAsk(); return; }
  if (e.key === 'l' || e.key === 'L') { setLabels(!labelsShown); return; }
  if (e.key === 'f' || e.key === 'F') { $('#hud-fit').click(); return; }
  if (e.key === 'n' || e.key === 'N') { if (is3d()) $('#hud-north').click(); return; }
  if (e.key === '[') { if (is3d()) stepFloor(-1); return; }
  if (e.key === ']') { if (is3d()) stepFloor(1); return; }
  if (e.key === '+' || e.key === '=') { zoomBy(0.5); return; }
  if (e.key === '-') { zoomBy(-0.5); return; }
  // Bare 1–6 used to toggle whatever the first six filter rows happened to be — a shortcut whose
  // meaning changed with the data, and `3` collided with the 2D/3D toggle. Dropped (red team #9);
  // layer commands come back through the omnibox in step 2.
});

/* ------------------------------------------------------------ tz API ----- */
// Small stable surface so an assistant (or the console) can drive the map:
//   tz.quests.select('the-punisher-part-1'); tz.quests.flyTo('<objectiveId>'); tz.quests.markObjective(id)
window.tz = {
  map: mapData.key,
  get view() { return is3d() ? '3d' : '2d'; },
  setView,
  flyTo,
  /**
   * The 3D render style (docs/plans/RENDER-REALISM.md): 'realistic' | 'vector'.
   * Called with no argument it reports the current one; with one it flips and persists it.
   * The flip is material-only — geometry, feature ids, picking, floors and the camera do not move.
   */
  renderStyle: (mode) => (mode === undefined ? look : setLook(mode)),
  /** QA hook: draw count, GPU/CPU frame time and texture bytes for the live 3D frame. */
  renderStats: () => view3d?.renderStats?.() ?? null,
  /** The part of the stage nothing floats over — {left, top, right, bottom} in stage CSS px. */
  safeRect,
  /** QA hook: which marker tier is on screen and the metres-per-pixel it was decided from. */
  get lod() { return { tier: currentTier(), mpp: metresPerPixel() }; },
  /**
   * QA hook: the live camera. 3D reports the OrbitView state the walkthrough asserts the oblique
   * default against (`rotationX` ≈ CAM.rotationX); 2D reports Leaflet's centre and zoom.
   */
  get camera() {
    if (is3d()) return { mode: '3d', target: [...v3.target], zoom: v3.zoom, rotationX: v3.rotationX, rotationOrbit: v3.rotationOrbit };
    const c = map.getCenter();
    return { mode: '2d', center: { x: c.lng, z: c.lat }, zoom: map.getZoom() };
  },
  /** QA hook: game coords -> stage CSS px in the 3D view (null in 2D or before deck is up). */
  project: (x, z) => view3d?.project?.(x, z) ?? null,
  /** QA hook: how many markers the current filter set puts on the map, and the per-kind totals. */
  markers: () => ({
    kinds: [...onKinds].filter((k) => layerOf.has(k)).sort(),
    total: [...onKinds].reduce((n, k) => n + (countOf.get(k) ?? 0), 0),
    byKind: Object.fromEntries([...countOf].sort()),
  }),
  panel: { open: (n) => shell.open(n), close: (n) => shell.close(n), isOpen: (n) => shell.isOpen(n), isPinned: (n) => shell.isPinned(n) },
  live: {
    /** {state:'disconnected'|'connecting'|'streaming'|'stale', lastAt, ageMs, players:[{code,name,map,lastAt}]} */
    state: () => live.state(),
    /** The quest log the companion reported: {active, done, failed, accountId, ts, since, codes}. */
    quests: () => live.quests(),
  },
  quests: {
    /** Select a quest by slug (adds it to the map). Returns false if the slug is unknown. */
    select: (slug) => quests.select(slug),
    deselect: (slug) => quests.deselect(slug),
    toggle: (slug) => quests.toggle(slug),
    /** Tick/untick an objective. `value` omitted flips it. Returns the new state. */
    markObjective: (objectiveId, value) => quests.markObjective(objectiveId, value),
    /** Centre the map on an objective and open its card. */
    flyTo: (objectiveId) => quests.flyToObjective(objectiveId),
    /**
     * Everything currently on the map: [{id, questSlug, objectiveId, badge, position, pin, level}].
     * `position` is the exact objective coordinate; `pin` is where the marker is actually drawn
     * (coincident pins are fanned apart), which is what a click has to aim at.
     */
    points: () => quests.points().map((p) => ({ id: p.id, questSlug: p.questSlug, objectiveId: p.objectiveId, badge: p.badge, text: p.objective.text, position: p.position, pin: { x: p.pin.x, z: p.pin.z }, level: p.level })),
    selected: () => quests.selectedSlugs(),
    /** The full quest list (loads it if it has not been fetched yet). */
    all: async () => (await quests.load()),
    setVisible: (on) => quests.setVisible(on),
    open: (on = true) => quests.setOpen(on),
    /**
     * The task ids the GAME says are active (companion -> relay -> live.js), already intersected
     * with nothing — raw ids, in the order they were started. src/assistant.js sends them to
     * /api/assistant as grounding: "these are the quests this player is actually on".
     */
    active: () => quests.activeIds(),
    /** Everything the quest log said: {active, done, failed, since, ts}. */
    log: () => quests.questSet(),
    /** Open the Quests panel with "My quests" in view (the omnibox's `> my quests`). */
    mine: () => quests.revealMine(),
  },
};

/* --------------------------------------------------------- ask (AI) ------ */
// Grounded quest Q&A: src/assistant.js posts to /api/assistant and replays the actions it gets
// back through window.tz (select a quest, fly to an objective). It answers into the omnibox card;
// a map switch is offered as a chip and never performed on its own. See api/assistant.js.
assistant = createAssistant({
  mapKey: mapData.key,
  tz: window.tz,
  store,
  // The card IS the omnibox's card: it can only be shown by something that exists, which is why
  // init() is called below the omnibox and not here. `ask` routes the card's own starter chips back
  // through the omnibox, so a chip-initiated answer captures the undo the Restore chip needs.
  panel: {
    setOpen: (on) => omni?.setCardOpen(on),
    isOpen: () => !!omni?.isCardOpen(),
    ask: (text) => omni?.ask(text),
  },
  onAnswer: (x) => omni?.onAnswer(x),
});

/* --------------------------------------------------------- omnibox ------- */
// One field for three jobs: lookup (no prefix), commands (`>`), the assistant (`?`). It owns the
// bottom-centre strip and the card above it; everything it can do to the map goes through the
// handles below, so the routing module never touches Leaflet or deck directly.
omni = createOmnibox({
  mapKey: mapData.key,
  index: () => index,
  quests,
  assistant,
  flyTo,
  toast: (m) => toast(m),
  onLayout: () => { if (booted) updateHud(); },
  camera: {
    get: () => (is3d() ? { mode: '3d', v3: { ...v3 } } : { mode: '2d', center: map.getCenter(), zoom: map.getZoom() }),
    set: (s) => {
      if (!s) return;
      if (s.mode === '3d') { if (!is3d()) setView('3d'); set3d(s.v3); }
      else { if (is3d()) setView('2d'); map.setView(s.center, s.zoom, { animate: true }); }
    },
  },
  actions: {
    setView,
    fit: () => $('#hud-fit').click(),
    north: () => $('#hud-north').click(),
    setKind: (kind, on) => setKind(kind, on),
    setLayers: (query, on) => {
      const s = query.trim().toLowerCase();
      if ('labels'.startsWith(s) || 'places'.startsWith(s) || 'names'.startsWith(s)) { setLabels(on); return 1; }
      if ('quests'.startsWith(s) || 'objectives'.startsWith(s)) { quests.setVisible(on); return 1; }
      const kinds = matchLayers(query);
      for (const k of kinds) setKind(k, on, { refresh: false });
      if (kinds.length) { store.set('kinds', [...onKinds]); syncGroupCounts(); view3d?.refresh(); }
      return kinds.length;
    },
    setFloor: (f) => { if (!allowedFloors.has(String(f))) return false; setFloor(String(f)); return true; },
    setRelief: (n) => setRelief(n),
    setNature: (kind, on) => setNature(kind, on),
    setLabels: (d) => { density = d; store.set('density', density); if (d !== 'off' && !labelsShown) setLabels(true); else applyLabels(); },
    panel: (name, on) => shell.setOpen(name, on),
    pin: (name, on) => shell.setPinned(name, on),
    myQuests: () => quests.revealMine(),
    clearTrails: () => live.clearTrails(),
    help: () => { shell.open('view'); closePops(); togglePop($('#hint3d'), $('#help-btn')); },
    goMap,
    mapKeys: () => Object.keys(MAPS),
  },
});

// Only now: everything init() does — ?ask=1, and replaying the transcript after an assistant map
// switch — is written into the omnibox's card, and setOpen() on a card that does not exist yet is a
// silent no-op that leaves the content in a permanently hidden element.
assistant.init();

booted = true;
updateHud();
setView(starts3d ? '3d' : '2d');
omni.applyQaQuery();

// ?debug=roads — draw the 3D road/track network over the 2D map to check it against the satellite
if (new URLSearchParams(location.search).get('debug') === 'roads') {
  fetch(`/data/${mapData.key}-3d.json`).then((r) => r.json()).then((d) => {
    const col = { highway: '#ffdd00', main: '#ff3030', small: '#ff30ff', track: '#ff8c00', dirt: '#b06000' };
    for (const r of d.roads) L.polyline(r.path.map(([x, z]) => [z, x]), { color: col[r.kind] || '#fff', weight: r.kind === 'track' || r.kind === 'dirt' ? 2 : 3, opacity: 0.9, dashArray: r.kind === 'track' || r.kind === 'dirt' ? '6 4' : null }).addTo(map).bindTooltip(r.kind);
    for (const b of d.bridges) L.polyline(b.path.map(([x, z]) => [z, x]), { color: '#00e5ff', weight: 5, opacity: 0.9 }).addTo(map);
    L.polyline([...d.limit, d.limit[0]].map(([x, z]) => [z, x]), { color: '#ff0000', weight: 2, dashArray: '8 6' }).addTo(map);
  });
}
