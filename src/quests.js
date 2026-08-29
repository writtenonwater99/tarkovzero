// Quest layer: search quests, select them, draw their objective zones on the 2D and 3D maps.
//
// Data: public/data/quests.json (scripts/build-quests.mjs) — tarkov.dev task objectives with
// game-coordinate zones, English text from the SPT locale, wiki screenshots from
// public/data/quest-images.json.
//
// Every point is a game coordinate, exactly like the rest of the site: Leaflet takes [z, x],
// deck takes [-x, -z, y]. This module never converts — it hands raw {x, y, z} to both views.
import L from 'leaflet';
import { iconHtml } from './icons.js';

// One hue per selected quest so two quests on screen at once stay readable. Deliberately not the
// extract greens/oranges: a quest pin must never be mistaken for a way out.
export const QUEST_COLORS = ['#D8A32B', '#4FB8E8', '#E2607A', '#7FD46A', '#B98BE8', '#E8894B'];
const rgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const levelTag = (level) => (level === 'underground' ? '<span class="qtag qtag-u">UNDERGROUND</span>' : level === 'upper' ? '<span class="qtag">UPPER FLOOR</span>' : '');

/**
 * @param {object} deps
 * @param {L.Map} deps.map              the Leaflet map
 * @param {string} deps.mapKey          'customs' | 'reserve' | 'woods'
 * @param {object} deps.store           { get(k,d), set(k,v) } localStorage wrapper from main.js
 * @param {(x:number,z:number)=>void} deps.flyTo
 * @param {()=>boolean} deps.is3d
 * @param {()=>void} deps.refresh3d     re-render the deck layers
 * @param {(x:number,z:number,y:number)=>number[]|null} deps.project3d  game coords -> screen px
 */
export function createQuests({ map, mapKey, store, flyTo, is3d, refresh3d, project3d }) {
  let all = [];                       // every quest in the file
  let loaded = false, loading = null;
  let selected = [];                  // slugs, in selection order (colour = index)
  let done = new Set(store.get('questDone', []));
  let visible = store.get('questsVisible', true) !== false; // the "Quest objectives" filter row
  const layer = L.layerGroup();
  const markerOf = new Map();         // pointId -> L.Marker (for flyTo / popup)
  let card = null;                    // { objectiveId, questSlug, pointId, img }
  let cardRaf = 0;

  const el = {
    block: document.getElementById('quest-block'),
    toggle: document.getElementById('quest-toggle'),
    body: document.getElementById('quests'),
    sum: document.getElementById('quest-sum'),
    find: document.getElementById('quest-find'),
    results: document.getElementById('quest-results'),
    list: document.getElementById('quest-selected'),
    card: document.getElementById('quest-card'),
    vis: document.getElementById('quest-vis'),
    visIco: document.getElementById('quest-vis-ico'),
    visN: document.getElementById('quest-vis-n'),
  };
  el.visIco.innerHTML = iconHtml('quest-objective', 17);

  /* ------------------------------------------------------------------ data -- */
  async function load() {
    if (loaded) return all;
    if (loading) return loading;
    loading = fetch('/data/quests.json')
      .then((r) => { if (!r.ok) throw new Error(`quests.json ${r.status}`); return r.json(); })
      .then((d) => { all = Array.isArray(d) ? d : []; loaded = true; return all; })
      .catch((e) => { console.warn('quest data unavailable', e); all = []; loaded = true; return all; })
      .finally(() => { loading = null; });
    return loading;
  }
  const bySlug = (slug) => all.find((q) => q.slug === slug) ?? null;
  const colorOf = (slug) => QUEST_COLORS[Math.max(0, selected.indexOf(slug)) % QUEST_COLORS.length];

  /**
   * Flat, numbered list of drawable points for one quest on the current map.
   * Badges run 1..N across the whole quest, so "mark 3 tankers" (one objective, three zones)
   * reads as 1, 2, 3 — which is what a player looking at the map actually needs.
   */
  function pointsOf(q) {
    if (!q) return [];
    const out = [];
    let n = 0;
    for (const o of q.objectives ?? []) {
      const zones = (o.zones ?? []).filter((z) => z.map === mapKey);
      for (const z of zones) {
        n += 1;
        out.push({
          id: `${q.slug}:${o.id}:${n}`,
          quest: q, questSlug: q.slug, questName: q.name,
          objective: o, objectiveId: o.id,
          badge: String(n), index: n,
          zone: z, position: z.position, pin: { x: z.position.x, z: z.position.z }, level: z.level ?? 'surface',
          outline: z.outline ?? null,
          color: colorOf(q.slug),
        });
      }
    }
    // Quests routinely put two objectives in the same room ("stash A in ZB-016", "stash B in
    // ZB-016") and the pins land exactly on top of each other. Fan coincident pins out by a couple
    // of metres for DRAWING only — `position` stays exact for Fly to and the card.
    const groups = new Map();
    for (const p of out) {
      const k = `${p.position.x.toFixed(1)}|${p.position.z.toFixed(1)}`;
      groups.set(k, [...(groups.get(k) ?? []), p]);
    }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      g.forEach((p, i) => {
        const a = (i / g.length) * Math.PI * 2 - Math.PI / 2;
        p.pin = { x: p.position.x + Math.cos(a) * 2.6, z: p.position.z + Math.sin(a) * 2.6 };
      });
    }
    return out;
  }
  const selectedQuests = () => selected.map(bySlug).filter(Boolean);
  const points = () => (visible ? selectedQuests().flatMap(pointsOf) : []);
  const pointById = (id) => points().find((p) => p.id === id) ?? null;
  const objectiveCount = (q) => (q.objectives ?? []).filter((o) => (o.zones ?? []).some((z) => z.map === mapKey)).length;

  /* -------------------------------------------------------------- the card -- */
  // One HTML builder for both views: the Leaflet popup and the floating 3D card show exactly the
  // same thing, so a screenshot the player recognises in 2D is the same screenshot in 3D.
  function cardHtml(p, imgIndex = 0) {
    const o = p.objective, q = p.quest;
    // Objective-specific shots when the wiki caption identified one; otherwise the quest's own
    // gallery, which is still the right recognition aid for "which building is this?".
    const images = (o.images?.length ? o.images : q.images) ?? [];
    const i = images.length ? ((imgIndex % images.length) + images.length) % images.length : 0;
    const im = images[i];
    const tags = [
      o.optional ? '<span class="qtag">OPTIONAL</span>' : '',
      o.count > 1 ? `<span class="qtag">×${o.count}</span>` : '',
      levelTag(p.level),
    ].join('');
    const shot = im
      ? `<figure class="qshot">` +
          `<img src="${esc(im.url)}" alt="${esc(im.caption || o.text)}" loading="lazy" referrerpolicy="no-referrer">` +
          (images.length > 1
            ? `<button type="button" class="qnav qprev" data-qimg="${i - 1}" aria-label="Previous screenshot">‹</button>` +
              `<button type="button" class="qnav qnext" data-qimg="${i + 1}" aria-label="Next screenshot">›</button>` +
              `<span class="qcount mono">${i + 1}/${images.length}</span>`
            : '') +
          (im.caption ? `<figcaption>${esc(im.caption)}</figcaption>` : '') +
        `</figure>`
      : '';
    return `<div class="qcard-in" data-point="${esc(p.id)}">` +
      `<div class="qcard-head"><span class="qdot" style="background:${esc(p.color)}"></span>` +
        `<b>${esc(q.name)}</b><span class="qmeta">${esc(q.trader ?? '')}${q.minLevel ? ` · Lv ${q.minLevel}` : ''}</span></div>` +
      `<div class="qcard-obj"><span class="qnum" style="background:${esc(p.color)}">${esc(p.badge)}</span>` +
        `<span class="qtext">${esc(o.text)}</span></div>` +
      (tags ? `<div class="qtags">${tags}</div>` : '') +
      shot +
      `<div class="qcard-foot">` +
        `<label class="qcheck"><input type="checkbox" data-qdone="${esc(o.id)}"${done.has(o.id) ? ' checked' : ''}><span>Done</span></label>` +
        `<button type="button" class="ghost" data-qfly="${esc(p.id)}">Fly to</button>` +
        (q.wikiLink ? `<a class="ghost" href="${esc(q.wikiLink)}" target="_blank" rel="noopener">Wiki</a>` : '') +
      `</div>` +
      (im ? `<div class="qcredit">Screenshot · <a href="${esc(q.wikiLink ?? 'https://escapefromtarkov.fandom.com')}" target="_blank" rel="noopener">EFT Wiki</a></div>` : '') +
    `</div>`;
  }

  function wireCard(root, p) {
    for (const b of root.querySelectorAll('[data-qimg]')) {
      b.onclick = (e) => {
        e.stopPropagation();
        const next = Number(b.dataset.qimg);
        if (card) card.img = next;
        root.innerHTML = cardHtml(p, next);
        wireCard(root, p);
      };
    }
    const chk = root.querySelector('[data-qdone]');
    if (chk) chk.onchange = () => markObjective(chk.dataset.qdone, chk.checked);
    const fly = root.querySelector('[data-qfly]');
    if (fly) fly.onclick = () => flyToPoint(p.id);
  }

  // 3D has no popups: an absolutely-positioned card in #stage tracks the projected point.
  function openCard3d(p) {
    card = { pointId: p.id, img: 0 };
    el.card.hidden = false;
    el.card.innerHTML = `<button type="button" class="qcard-x" aria-label="Close">✕</button>` + cardHtml(p, 0);
    el.card.querySelector('.qcard-x').onclick = closeCard;
    wireCard(el.card, p);
    positionCard();
  }
  function positionCard() {
    cancelAnimationFrame(cardRaf);
    if (el.card.hidden || !card) return;
    const p = pointById(card.pointId);
    if (!p) return closeCard();
    const q = project3d?.(p.pin.x, p.pin.z);
    if (q && Number.isFinite(q[0])) {
      const stage = el.card.parentElement.getBoundingClientRect();
      const w = el.card.offsetWidth || 300, h = el.card.offsetHeight || 200;
      const left = Math.min(Math.max(8, q[0] - w / 2), Math.max(8, stage.width - w - 8));
      const top = Math.min(Math.max(8, q[1] - h - 26), Math.max(8, stage.height - h - 8));
      el.card.style.left = `${left}px`; el.card.style.top = `${top}px`;
      el.card.classList.remove('qcard-fixed');
    } else {
      el.card.classList.add('qcard-fixed'); // off-screen point: park the card in a corner
    }
    cardRaf = requestAnimationFrame(positionCard);
  }
  function closeCard() {
    cancelAnimationFrame(cardRaf);
    card = null;
    el.card.hidden = true;
    el.card.innerHTML = '';
  }
  function openCardFor(pointId) {
    const p = pointById(pointId);
    if (!p) return false;
    if (is3d()) openCard3d(p);
    else {
      const m = markerOf.get(pointId);
      if (m) m.openPopup();
    }
    return true;
  }

  /* ------------------------------------------------------------- 2D layer --- */
  function questIcon(p) {
    return L.divIcon({
      className: '',
      // gold hexagon + numbered badge, with the quest's colour on the ring behind it — the same
      // split the 3D layer uses, so a pin looks like itself in both views
      html: `<div class="qpin${done.has(p.objectiveId) ? ' qdone' : ''}" style="--qc:${p.color}">${iconHtml('quest-objective', 24, p.badge, p.level)}</div>`,
      iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -17],
    });
  }
  function draw2d() {
    layer.clearLayers();
    markerOf.clear();
    if (!visible) return;
    for (const p of points()) {
      if (p.outline && p.outline.length >= 3) {
        L.polygon(p.outline.map(([x, z]) => [z, x]), {
          color: p.color, weight: 1.5, opacity: 0.9, fillColor: p.color, fillOpacity: 0.18,
          dashArray: p.level === 'underground' ? '5 4' : null, interactive: false, className: 'qzone',
        }).addTo(layer);
      }
      const m = L.marker([p.pin.z, p.pin.x], { icon: questIcon(p), riseOnHover: true, zIndexOffset: 500 })
        .bindPopup('', { className: 'qpopup', maxWidth: 320, minWidth: 240, autoPanPadding: [24, 24] })
        .bindTooltip(`${esc(p.badge)}. ${esc(p.objective.text)}`, { direction: 'top', offset: [0, -15], className: 'qtip', opacity: 1 });
      m.on('popupopen', (e) => {
        card = { pointId: p.id, img: 0 };
        const root = e.popup.getElement().querySelector('.leaflet-popup-content');
        root.innerHTML = cardHtml(p, 0);
        wireCard(root, p);
      });
      m.on('popupclose', () => { card = null; });
      m.addTo(layer);
      markerOf.set(p.id, m);
    }
  }

  /* --------------------------------------------------------- 3D data feed --- */
  // Consumed by src/map3d.js. Colours are pre-converted to RGB arrays so deck accessors stay cheap.
  const deckData = () => {
    const pts = points();
    return {
      points: pts.map((p) => ({
        id: p.id, questSlug: p.questSlug, objectiveId: p.objectiveId,
        position: p.position, pin: p.pin, level: p.level, badge: p.badge,
        color: rgb(p.color),
        html: `<b>${esc(p.questName)}</b>${esc(p.badge)}. ${esc(p.objective.text)}`,
        done: done.has(p.objectiveId),
      })),
      zones: pts.filter((p) => p.outline && p.outline.length >= 3).map((p) => ({
        id: p.id, outline: p.outline, color: rgb(p.color), level: p.level,
      })),
    };
  };

  /* -------------------------------------------------------------- the rail -- */
  function renderSummary() {
    const n = selected.length;
    const withZones = selectedQuests().filter((q) => objectiveCount(q) > 0).length;
    el.sum.textContent = !loaded ? 'Loading…'
      : n === 0 ? `${all.filter((q) => q.siteMaps?.includes(mapKey)).length} on this map`
      : `${n} selected · ${withZones} mapped`;
    el.toggle.classList.toggle('armed', n > 0);
    // "Quest objectives" is its own toggle group, and it only exists once there is something to
    // toggle — an empty filter row is just noise.
    el.vis.hidden = n === 0;
    el.vis.classList.toggle('on', visible);
    el.vis.querySelector('input').checked = visible;
    el.visN.textContent = String(points().length);
  }

  function renderList() {
    if (!selected.length) {
      el.list.innerHTML = `<div class="qempty">No quest selected. Search above — quests with map objectives show a <span class="qpip"></span> pip.</div>`;
      return;
    }
    el.list.innerHTML = selectedQuests().map((q) => {
      const color = colorOf(q.slug);
      const pts = pointsOf(q);
      const objs = (q.objectives ?? []).map((o) => {
        const mine = pts.filter((p) => p.objectiveId === o.id);
        const nums = mine.length ? (mine.length > 1 ? `${mine[0].badge}–${mine[mine.length - 1].badge}` : mine[0].badge) : '';
        const off = (o.maps ?? []).length && !(o.maps ?? []).includes(mapKey);
        return `<label class="qobj${done.has(o.id) ? ' done' : ''}${mine.length ? '' : ' qoff'}" data-obj="${esc(o.id)}">` +
          `<input type="checkbox" class="vh" data-qdone="${esc(o.id)}"${done.has(o.id) ? ' checked' : ''}>` +
          `<span class="qbox" aria-hidden="true"></span>` +
          (nums ? `<span class="qnum" style="background:${esc(color)}">${esc(nums)}</span>` : `<span class="qnum qnum-off">${off ? '—' : '·'}</span>`) +
          `<span class="qtext">${esc(o.text)}${o.optional ? ' <i>(optional)</i>' : ''}</span>` +
          (mine.length ? `<button type="button" class="qfly" data-qfly="${esc(mine[0].id)}" title="Fly to" aria-label="Fly to objective">➤</button>` : '') +
        `</label>`;
      }).join('');
      return `<div class="qsel-q" style="--qc:${esc(color)}">` +
        `<div class="qsel-head"><span class="qdot" style="background:${esc(color)}"></span>` +
          `<b>${esc(q.name)}</b>` +
          `<span class="qmeta">${esc(q.trader ?? '')}${q.minLevel ? ` · Lv ${q.minLevel}` : ''}</span>` +
          `<button type="button" class="qx" data-qremove="${esc(q.slug)}" aria-label="Remove quest">✕</button></div>` +
        `<div class="qobjs">${objs}</div></div>`;
    }).join('');

    for (const b of el.list.querySelectorAll('[data-qremove]')) b.onclick = () => deselect(b.dataset.qremove);
    for (const b of el.list.querySelectorAll('.qfly')) b.onclick = (e) => { e.preventDefault(); flyToPoint(b.dataset.qfly); };
    for (const c of el.list.querySelectorAll('input[data-qdone]')) c.onchange = () => markObjective(c.dataset.qdone, c.checked);
  }

  let results = [], active = 0;
  function renderResults() {
    if (!el.find.value.trim()) { el.results.hidden = true; return; }
    el.results.hidden = false;
    if (!results.length) { el.results.innerHTML = '<div class="res-empty">No quest matches</div>'; return; }
    el.results.innerHTML = results.map((q, i) => {
      const mapped = q.siteMaps?.includes(mapKey);
      const on = selected.includes(q.slug);
      return `<div class="res qres${i === active ? ' act' : ''}${on ? ' on' : ''}" data-i="${i}" role="option" aria-selected="${on}">` +
        `<span class="qpip${mapped ? ' lit' : ''}" title="${mapped ? 'has objectives on this map' : 'no objectives on this map'}"></span>` +
        `<span class="rn">${esc(q.name)}</span>` +
        `<span class="rk">${esc(q.trader ?? '')}${q.minLevel ? ` · ${q.minLevel}` : ''}${q.zoneMaps?.length ? ` · ${esc(q.zoneMaps.slice(0, 2).join(','))}` : ''}</span></div>`;
    }).join('');
    for (const r of el.results.querySelectorAll('.qres')) r.onclick = () => choose(Number(r.dataset.i));
  }
  function search(raw) {
    const s = raw.trim().toLowerCase();
    if (!s) { results = []; el.results.hidden = true; return; }
    const score = (q) => {
      const n = q.name.toLowerCase().indexOf(s);
      const t = (q.trader ?? '').toLowerCase().indexOf(s);
      if (n < 0 && t < 0) return null;
      // this map's quests first, then the earliest name match
      return (q.siteMaps?.includes(mapKey) ? 0 : 1000) + (n >= 0 ? n : 500 + t);
    };
    results = all.map((q) => ({ q, s: score(q) })).filter((o) => o.s != null)
      .sort((a, b) => a.s - b.s || a.q.name.length - b.q.name.length).slice(0, 10).map((o) => o.q);
    active = 0;
    renderResults();
  }
  function choose(i) {
    const q = results[i];
    if (!q) return;
    toggle(q.slug);
    el.find.value = ''; results = []; el.results.hidden = true;
  }

  /* ------------------------------------------------------------- mutations -- */
  function sync({ redraw = true } = {}) {
    store.set('quests', selected);
    store.set('questDone', [...done]);
    const url = new URL(location.href);
    url.searchParams.delete('quest');
    // Written by hand rather than via searchParams so the slug list keeps literal commas — a
    // permalink someone pastes into chat should be readable. URLSearchParams still parses it back.
    const rest = url.searchParams.toString();
    const query = [rest, selected.length ? `quest=${selected.join(',')}` : ''].filter(Boolean).join('&');
    history.replaceState(null, '', url.pathname + (query ? `?${query}` : '') + url.hash);
    if (redraw) { draw2d(); refresh3d?.(); }
    renderSummary(); renderList();
  }
  function setOpen(open) {
    el.body.hidden = !open;
    el.toggle.setAttribute('aria-expanded', String(open));
    store.set('questsOpen', open);
    if (open) load().then(() => { renderSummary(); renderList(); });
  }
  function select(slug, { open = true } = {}) {
    const q = bySlug(slug);
    if (!q || selected.includes(slug)) return !!q;
    selected = [...selected, slug];
    if (open) setOpen(true);
    sync();
    return true;
  }
  function deselect(slug) {
    if (!selected.includes(slug)) return false;
    selected = selected.filter((s) => s !== slug);
    if (card && !pointById(card.pointId)) closeCard();
    sync();
    return true;
  }
  const toggle = (slug) => (selected.includes(slug) ? deselect(slug) : select(slug));
  function markObjective(objectiveId, value) {
    const next = value === undefined ? !done.has(objectiveId) : !!value;
    next ? done.add(objectiveId) : done.delete(objectiveId);
    sync({ redraw: true });
    // keep an open card's checkbox in step without rebuilding it
    for (const c of document.querySelectorAll(`input[data-qdone="${CSS.escape(objectiveId)}"]`)) c.checked = next;
    return next;
  }
  function flyToPoint(pointId) {
    const p = pointById(pointId);
    if (!p) return false;
    flyTo(p.position.x, p.position.z);
    setTimeout(() => openCardFor(pointId), is3d() ? 60 : 420);
    return true;
  }
  function flyToObjective(objectiveId) {
    const p = points().find((x) => x.objectiveId === objectiveId);
    return p ? flyToPoint(p.id) : false;
  }
  function setVisible(on) {
    visible = !!on;
    store.set('questsVisible', visible);
    if (!visible) closeCard();
    draw2d(); refresh3d?.();
    renderSummary();
  }

  /* ------------------------------------------------------------------ init -- */
  el.toggle.onclick = () => setOpen(el.body.hidden);
  el.vis.querySelector('input').onchange = (e) => setVisible(e.target.checked);
  el.find.oninput = () => search(el.find.value);
  el.find.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(active + 1, results.length - 1); renderResults(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); renderResults(); e.preventDefault(); }
    else if (e.key === 'Enter') { choose(active); e.preventDefault(); }
    else if (e.key === 'Escape') { el.find.value = ''; results = []; el.results.hidden = true; el.find.blur(); }
  };
  map.on('popupclose', (e) => { if (e.popup?.options?.className === 'qpopup') card = null; });

  async function init() {
    const urlQuests = (new URLSearchParams(location.search).get('quest') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const saved = urlQuests.length ? urlQuests : (store.get('quests', []) || []);
    const wantOpen = store.get('questsOpen', false) || urlQuests.length > 0;
    setOpen(wantOpen);
    // The list is ~500 KB; nothing above the fold needs it, so it loads out of band and the panel
    // fills in when it lands.
    await load();
    selected = saved.filter((s) => bySlug(s));
    sync();
    if (urlQuests.length) setOpen(true);
  }

  return {
    layer, load, init, setOpen,
    points, deckData, colorOf,
    select, deselect, toggle, markObjective, flyToObjective, flyToPoint,
    openCardFor, closeCard, positionCard, setVisible,
    draw2d,
    count: () => points().length,
    isSelected: (slug) => selected.includes(slug),
    selectedSlugs: () => [...selected],
    quests: () => all,
    onDeckClick: (obj) => { if (obj?.id) openCardFor(obj.id); },
  };
}
