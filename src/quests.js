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
import { currentTier } from './lod.js';
// "My quests" is fed by the game itself (companion -> relay -> src/live.js). Everything that turns
// a set of task ids into rows, and decides what auto-select may add, is pure and lives next door.
import { activeRows, doneRows, autoSelectSlugs, sinceCaveat } from './active-quests.js';

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
 * @param {{setOpen(on:boolean):void, isOpen():boolean}} [deps.panel]  the shell's Quests panel
 * @param {(n:number)=>void} [deps.onSelection]  number of selected quests changed
 * @param {()=>{left:number,top:number,right:number,bottom:number}} [deps.safeRect]  stage area nothing floats over
 */
export function createQuests({ map, mapKey, store, flyTo, is3d, refresh3d, project3d, panel, onSelection, safeRect }) {
  let all = [];                       // every quest in the file
  let loaded = false, loading = null;
  let selected = [];                  // slugs, in selection order (colour = index)
  let done = new Set(store.get('questDone', []));
  let visible = store.get('questsVisible', true) !== false; // the "Quest objectives" filter row
  // The quest log the game reported, straight off the live socket. Empty until a companion (or
  // ?quests=) hands one over — the section stays out of the panel until then.
  let mine = { active: [], done: [], failed: [], since: null, ts: 0 };
  let autoOn = store.get('questsAuto', true) !== false;
  // Slugs auto-select has already put on the map once. Persisted per map, because a page load is
  // not a new decision: a quest the player deliberately took off the map used to come straight back
  // on the next load (and a map switch IS a load), appended at the end of `selected` — which also
  // reshuffled every selected quest's colour, since colourOf is the index in that list. Cleared for
  // a slug once the game stops reporting it as active, so re-accepting a quest re-adds it.
  const AUTO_KEY = 'questsAutoApplied';
  const autoApplied = new Set((store.get(AUTO_KEY, {}) ?? {})[mapKey] ?? []);
  const saveAutoApplied = () => store.set(AUTO_KEY, { ...(store.get(AUTO_KEY, {}) ?? {}), [mapKey]: [...autoApplied] });
  let mineForced = false;          // `> my quests` on an empty set: show the section and say why
  const layer = L.layerGroup();
  // Quest pins get their own pane, explicitly above the place-label panes (450) — a marker should
  // never be the thing a place name reads THROUGH. Leaflet's default markerPane (600) already sits
  // above them; this just makes that ordering an explicit, named fact instead of an implicit default.
  const QUEST_PANE = 'quests';
  if (!map.getPane(QUEST_PANE)) { map.createPane(QUEST_PANE); map.getPane(QUEST_PANE).style.zIndex = 620; }
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
    mine: document.getElementById('quest-mine'),
    mineN: document.getElementById('quest-mine-n'),
    mineSince: document.getElementById('quest-mine-since'),
    mineList: document.getElementById('quest-mine-list'),
    mineOther: document.getElementById('quest-mine-other'),
    mineOtherN: document.getElementById('quest-mine-other-n'),
    mineOtherList: document.getElementById('quest-mine-other-list'),
    mineDone: document.getElementById('quest-mine-done'),
    mineDoneN: document.getElementById('quest-mine-done-n'),
    mineDoneList: document.getElementById('quest-mine-done-list'),
    auto: document.getElementById('quest-auto'),
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
  // Photos for ONE point: the wiki gallery covers the whole quest ("Cargo 1 …", "Cargo 2 …", plus map
  // overviews), so pick the shots whose caption names this point's number; in-game shots first, map
  // overviews after. Fallback: the k-th non-overview shot for point k; last resort: everything.
  function imagesForPoint(p, all) {
    if (!all.length) return all;
    const n = Number(p.badge);
    const isMap = (im) => /marked on (the )?map|map overview|on the map|overview/i.test(im.caption || '');
    const numsOf = (im) => [...(im.caption || '').matchAll(/(?:^|\D)(\d{1,2})(?!\d)/g)].map((m) => Number(m[1]));
    if (Number.isFinite(n) && n > 0) {
      const mine = all.filter((im) => numsOf(im).includes(n));
      if (mine.length) return [...mine.filter((im) => !isMap(im)), ...mine.filter(isMap)];
      const nonMap = all.filter((im) => !isMap(im));
      const anyNumbered = all.some((im) => numsOf(im).length);
      if (!anyNumbered && nonMap.length >= n) return [nonMap[n - 1], ...all.filter((im) => im !== nonMap[n - 1])];
    }
    return [...all.filter((im) => !isMap(im)), ...all.filter(isMap)];
  }
  function cardHtml(p, imgIndex = 0) {
    const o = p.objective, q = p.quest;
    // Objective-specific shots when the wiki caption identified one; otherwise the quest's own
    // gallery, which is still the right recognition aid for "which building is this?".
    const images = imagesForPoint(p, (o.images?.length ? o.images : q.images) ?? []);
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
      // Keep the card inside the safe rect (chips / dock / omnibox insets) so it never lands under
      // an open panel; fall back to the whole stage when the shell has not answered.
      const stage = el.card.parentElement.getBoundingClientRect();
      const safe = safeRect?.() ?? { left: 8, top: 8, right: stage.width - 8, bottom: stage.height - 8 };
      const w = el.card.offsetWidth || 300, h = el.card.offsetHeight || 200;
      const left = Math.min(Math.max(safe.left, q[0] - w / 2), Math.max(safe.left, safe.right - w));
      const top = Math.min(Math.max(safe.top, q[1] - h - 26), Math.max(safe.top, safe.bottom - h));
      el.card.style.left = `${left}px`; el.card.style.top = `${top}px`;
      el.card.classList.remove('qcard-fixed');
    } else {
      // off-screen point: park the card in the safe rect's top-left corner
      const stage = el.card.parentElement.getBoundingClientRect();
      const safe = safeRect?.() ?? { left: 8, top: 8, right: stage.width - 8, bottom: stage.height - 8 };
      el.card.classList.add('qcard-fixed');
      el.card.style.left = `${safe.left}px`; el.card.style.top = `${safe.top}px`;
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
    // The pin rides the shared marker LOD (src/lod.js), like everything else on the map: below the
    // `full` tier it loses 30% of its size and shows the objective glyph instead of its number.
    // Gemini, 2026-08-29: at fit zoom the gold hexes were "disproportionate to the terrain" and
    // overlapped each other, and the numbers inside them were too small to read anyway. main.js
    // calls draw2d() again on every tier change, so this is re-evaluated when the camera crosses one.
    const small = currentTier() !== 'full';
    const box = small ? 24 : 34;
    return L.divIcon({
      className: '',
      // gold hexagon + numbered badge, with the quest's colour on the ring behind it — the same
      // split the 3D layer uses, so a pin looks like itself in both views
      html: `<div class="qpin${small ? ' qpin-sm' : ''}${done.has(p.objectiveId) ? ' qdone' : ''}" style="--qc:${p.color}">${iconHtml('quest-objective', small ? 17 : 24, small ? null : p.badge, p.level)}</div>`,
      iconSize: [box, box], iconAnchor: [box / 2, box / 2], popupAnchor: [0, -box / 2],
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
      const m = L.marker([p.pin.z, p.pin.x], { icon: questIcon(p), pane: QUEST_PANE, riseOnHover: true, zIndexOffset: 500 })
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

  /* ---------------------------------------------------------- my quests ---- */
  // The game's own answer to "what am I on right now". Rows for THIS map come first because that is
  // the only place their objectives can be drawn; everything else is folded away behind a count so
  // a 20-quest log does not bury the search field.
  function mineRowHtml(row, { struck = false } = {}) {
    const on = selected.includes(row.slug);
    const badges = struck || row.here ? ''
      : row.maps.slice(0, 3).map((m) => `<span class="qmap">${esc(m)}</span>`).join('');
    const label = struck ? 'Show this completed quest on the map' : on ? 'Take this quest off the map' : 'Put this quest on the map';
    return `<button type="button" class="qmine-row${on ? ' on' : ''}${struck ? ' struck' : ''}" ` +
        `data-mine="${esc(row.slug)}" aria-pressed="${on}" title="${esc(label)}"` +
        (on ? ` style="--qc:${esc(colorOf(row.slug))}"` : '') + '>' +
      `<span class="qmine-nm">${esc(row.name)}</span>` +
      (row.trader ? `<span class="qmine-tr">${esc(row.trader)}</span>` : '') +
      badges +
    `</button>`;
  }
  function renderMine() {
    if (!el.mine) return;
    const { here, elsewhere } = activeRows(all, mine.active, mapKey);
    const finished = doneRows(all, mine.done, mapKey);
    const any = here.length || elsewhere.length || finished.length;
    el.mine.hidden = !any && !mineForced;
    if (el.mine.hidden) return;

    el.mineN.textContent = String(here.length + elsewhere.length);
    el.mineList.innerHTML = here.length
      ? here.map((r) => mineRowHtml(r)).join('')
      : `<p class="qmine-empty">${any
          ? `Nothing active has objectives on ${esc(mapKey)}.`
          : 'No quest log yet — connect the companion in the Live panel and it fills in from the game.'}</p>`;

    el.mineOther.hidden = !elsewhere.length;
    el.mineOtherN.textContent = String(elsewhere.length);
    el.mineOtherList.innerHTML = elsewhere.map((r) => mineRowHtml(r)).join('');

    el.mineDone.hidden = !finished.length;
    el.mineDoneN.textContent = String(finished.length);
    el.mineDoneList.innerHTML = finished.map((r) => mineRowHtml(r, { struck: true })).join('');

    // EFT rotates its logs: the companion can only replay as far back as the oldest one it found.
    const caveat = sinceCaveat(mine.since);
    el.mineSince.hidden = !caveat;
    el.mineSince.textContent = caveat;

    el.auto.checked = autoOn;
    for (const b of el.mine.querySelectorAll('[data-mine]')) b.onclick = () => toggle(b.dataset.mine);
  }
  /** Add the active quests that belong on this map. Only ever adds — see autoSelectSlugs(). */
  function runAutoSelect() {
    const slugs = autoSelectSlugs({ all, activeIds: mine.active, mapKey, selected, applied: autoApplied, auto: autoOn });
    const fresh = slugs.filter((s) => bySlug(s) && !selected.includes(s));
    for (const s of slugs) autoApplied.add(s);
    // Forget a quest the game no longer calls active: the next time it appears is a new decision.
    // Only when there is a live set to judge against — an empty one means "no companion", not
    // "no quests", and must never wipe the record of what the player already took off the map.
    if (loaded && all.length && mine.active.length) {
      const live = new Set(activeRows(all, mine.active, mapKey).here.map((r) => r.slug));
      for (const s of [...autoApplied]) if (!live.has(s)) autoApplied.delete(s);
    }
    saveAutoApplied();
    if (!fresh.length) return 0;
    selected = [...selected, ...fresh];
    sync();                     // one redraw for the whole batch, not one per quest
    return fresh.length;
  }
  /** A new set from the relay (or ?quests=). Called by main.js through live.js's onQuests hook. */
  function setQuestSet(set) {
    mine = {
      active: set?.active ?? [], done: set?.done ?? [], failed: set?.failed ?? [],
      since: set?.since ?? null, ts: set?.ts ?? Date.now(),
    };
    load().then(() => { runAutoSelect(); renderMine(); });
  }
  function setAutoSelect(on) {
    autoOn = !!on;
    store.set('questsAuto', autoOn);
    if (el.auto) el.auto.checked = autoOn;
    // Turning it back on catches up with whatever the game has said since it was off.
    if (autoOn) load().then(() => { runAutoSelect(); renderMine(); });
    else renderMine();
  }
  /** `> my quests` / the omnibox: open the panel with the section in view, even when it is empty. */
  function revealMine() {
    mineForced = true;
    setOpen(true);
    load().then(() => {
      renderMine();
      el.mine?.scrollIntoView({ block: 'nearest' });
      el.mine?.classList.add('flash');
      setTimeout(() => el.mine?.classList.remove('flash'), 1400);
    });
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
    renderSummary(); renderList(); renderMine();
    onSelection?.(selected.length);
  }
  // The panel itself is the shell's — this only asks it to show/hide. #quests stays mounted so the
  // ids inside it exist whether the panel is on screen or not.
  const panelOpen = () => panel?.isOpen?.() ?? !el.body.hidden;
  function setOpen(open) {
    panel?.setOpen?.(!!open);
    el.toggle.setAttribute('aria-expanded', String(!!open));
    store.set('questsOpen', !!open);
    if (open) load().then(() => { renderSummary(); renderList(); renderMine(); });
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
  el.toggle.onclick = () => setOpen(!panelOpen());
  el.vis.querySelector('input').onchange = (e) => setVisible(e.target.checked);
  if (el.auto) { el.auto.checked = autoOn; el.auto.onchange = (e) => setAutoSelect(e.target.checked); }
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
    // Only ever *open* here: the shell owns whether a panel is on screen, and closing it from this
    // side would drop a pin the user set by hand and the shell just restored.
    const wantOpen = store.get('questsOpen', false) || urlQuests.length > 0;
    if (wantOpen) setOpen(true);
    else el.toggle.setAttribute('aria-expanded', String(panelOpen()));
    // The list is ~500 KB; nothing above the fold needs it, so it loads out of band and the panel
    // fills in when it lands.
    await load();
    selected = saved.filter((s) => bySlug(s));
    sync();
    // A quest set may have landed while quests.json was still in flight (the socket is faster than
    // a 750 KB fetch): apply it now that the list exists.
    runAutoSelect();
    renderMine();
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
    // --- the game's own quest log ---
    setQuestSet, setAutoSelect, revealMine,
    /** Task ids the game says are active — grounding for the assistant (window.tz.quests.active). */
    activeIds: () => [...mine.active],
    questSet: () => ({ ...mine, active: [...mine.active], done: [...mine.done], failed: [...mine.failed] }),
    autoSelectOn: () => autoOn,
    quests: () => all,
    onDeckClick: (obj) => { if (obj?.id) openCardFor(obj.id); },
  };
}
