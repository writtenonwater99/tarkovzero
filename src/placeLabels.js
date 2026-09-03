import L from 'leaflet';
import { TIER_RANK, styleFor, tierOf } from './label-tier.js';
// The leader's markup and the custom properties style.css reads. Shared with the Three renderer's
// HTML overlay so the two DOM passes cannot spell one tier two ways — see src/label-chrome.js.
import { labelMarkup } from './label-chrome.js';

/*
 * Google-Maps-like place labels, on a LEADER LINE (founder-approved, 2026-09-02).
 *
 *     anchor ring at the real position  ->  hairline stem rising  ->  cap tick  ->  the name
 *
 * WHY THE LEADER, AND WHY COLLISION LIVES ON IT
 * ---------------------------------------------
 * Two things change. The name stops sitting in the terrain it names — it is lifted clear of the
 * roof/road/tree it used to be printed across, and the ring says exactly which point it belongs
 * to. And the STEM becomes where a collision is resolved: lengthen a stem to dodge a neighbour and
 * the anchor never leaves the building. The old pass could only slide the whole word off its
 * subject or hide it, and it did both.
 *
 * So the ladder here is, in order: keep the anchor, change the stem; if the stem cannot resolve it,
 * slide the name a little (the leader elbows out to follow); only then hide. Hiding is still the
 * last resort it always was — a word the reader cannot finish is worse than a name that is gone —
 * but it is now the FOURTH thing tried, not the second.
 *
 * EVERY STYLE NUMBER COMES FROM src/label-tier.js
 * ----------------------------------------------
 * Size, weight, tracking, case, ink, halo and stem length are the tier's, resolved by `styleFor()`
 * and written onto the element as custom properties. `tierOf()` and `styleFor()` THROW on a row
 * with no valid tier, and nothing here catches that: a label that lost its tier must fail where
 * the bad value is, not silently inherit a default and be believed (handoff §6).
 *
 * `zone` has `stemPx: 0` BY DEFINITION — an area has no single point to stand a stem on — so it
 * gets no ring, no stem and no cap, and its name is centred on the anchor, which is the
 * cartographic convention for a region and exactly what these rows looked like before.
 *
 * THE CHROME
 * ----------
 * The HUD floats over an edge-to-edge map, so a label whose ink lands under the right toolbar, the
 * dock column, the top chips or the omnibox is not "behind glass" — it is a word the reader sees
 * truncated ("BIG RED" reading as "BIG", QA D5). `safeRect` here is shell.js's AVOID rect — the
 * part of the stage nothing floats over, dock included, which is not the rect a fit frames into
 * (that one is full width; QA H4).
 */
const NUDGE_MAX = 22;   // px a NAME may slide sideways to escape the chrome before it is dropped
// QA D3: the slide stopped the moment the ink was inside the rect, which put "POWERLINE TOWER" and
// "SNIPER RIDGE" flush against x=0 — inside by the letter of it, and still reading as a word
// falling off the frame. The rect is inset by this before anything is measured against it, so a
// label always keeps a margin of air. Same number as the 3D pass (map3d.js LABEL_INSET).
const INSET = 12;
/** px a stem grows per rung when something is in the way, and how many rungs it may climb. */
const STEM_STEP = 9;
const STEM_RUNGS = 4;
/** Half-width of the cap tick, and the gap between it and the name. Mirrors style.css. */
const CAP_HALF = 5;

/**
 * @param {import('leaflet').Map} map
 * @param {Array<{position:number[],text:string,tier:string,rotation?:number|string}>} labels
 *        every row MUST carry a valid `tier` — see src/label-tier.js.
 * @param {object} [opts]
 * @param {string} [opts.pane]
 * @param {()=>{left:number,top:number,right:number,bottom:number}} [opts.safeRect]
 *        stage area nothing floats over, in stage CSS px. Omit it and labels are never clipped.
 * @param {()=>Array<{left:number,top:number,right:number,bottom:number}>} [opts.obstacles]
 *        boxes in stage CSS px that own their pixels outright — the quest pins. A label that lands
 *        on one grows its stem past it; if it cannot, it is hidden, never overprinted.
 * @param {(label:object)=>boolean} [opts.hidden]
 *        a label this list should not draw right now, decided per clip rather than at construction:
 *        the marker data that settles it (which names an EXTRACT already owns) lands after the
 *        layer is built. Returning true hides the label without disturbing the rest of the pass.
 * @param {(label:object)=>boolean} [opts.tierVisible]
 *        THE THINNING GATE. Answers "does this label's tier draw at the current scale", and it is
 *        the caller's — main.js reads the metres-per-pixel ladder in src/label-tier.js once, for
 *        all three renderers, so there is exactly one implementation of the ladder in the app.
 */
export function placeLabelsLayer(map, labels, { pane = 'labels', safeRect = null, obstacles = null, hidden = null, tierVisible = null } = {}) {
  if (!map.getPane(pane)) { map.createPane(pane); map.getPane(pane).style.zIndex = 450; map.getPane(pane).style.pointerEvents = 'none'; }
  const group = L.layerGroup();
  const markers = [];
  const rows = [];
  for (const l of labels) {
    const tier = tierOf(l);            // THROWS on a row with no valid tier — deliberately
    const s = styleFor(tier);
    const rot = Number(l.rotation ?? 0);
    const stemmed = s.stemPx > 0;
    const icon = L.divIcon({
      className: 'place-label-wrap',
      html: labelMarkup(tier, l.text, { '--rot': `${rot}deg` }),
      iconSize: [0, 0],
    });
    const m = L.marker([l.position[1], l.position[0]], { icon, pane, interactive: false, keyboard: false });
    markers.push(m);
    // Rank first, then longest name first inside a rank: the landmark that needs the room asks
    // for it before the shed does, and a long word asks before a short one it would swallow.
    rows.push({ label: l, tier, style: s, stemmed, rank: TIER_RANK[tier], len: String(l.text).length });
    group.addLayer(m);
  }
  const order = rows.map((_, i) => i).sort((a, b) => rows[a].rank - rows[b].rank || rows[b].len - rows[a].len);

  const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

  /** Reset → measure → write, in three passes: interleaving them thrashes layout on every frame. */
  function clip() {
    if (!safeRect) return;
    const live = [];
    for (let i = 0; i < markers.length; i++) {
      const root = markers[i].getElement()?.firstElementChild;
      if (!root) continue;
      root.style.removeProperty('--dx');
      root.style.removeProperty('--dy');
      root.style.removeProperty('--cap-x');
      root.style.removeProperty('--cap-w');
      root.style.setProperty('--stem', `${rows[i].style.stemPx}px`);
      root.style.removeProperty('visibility');
      if (hidden?.(rows[i].label) || (tierVisible && !tierVisible(rows[i].label))) { root.style.visibility = 'hidden'; continue; }
      live.push(i);
    }
    if (!live.length) return;
    const s = map.getContainer().getBoundingClientRect();
    const raw = safeRect();
    const r = { left: raw.left + INSET, top: raw.top + INSET, right: raw.right - INSET, bottom: raw.bottom - INSET };
    if (r.right - r.left < 60 || r.bottom - r.top < 60) return;
    let blocks = [];
    try { blocks = obstacles?.() ?? []; } catch { blocks = []; }

    // MEASURE. One read pass over every visible name, in stage coordinates.
    const seen = new Set(live);
    const box = new Map();
    for (const i of live) {
      const root = markers[i].getElement().firstElementChild;
      const b = root.querySelector('.pl-name').getBoundingClientRect();
      if (!b.width || !b.height) { seen.delete(i); continue; }
      box.set(i, { left: b.left - s.left, top: b.top - s.top, right: b.right - s.left, bottom: b.bottom - s.top });
    }

    // WRITE. Everything already seated occupies its box, so a later name walks around it.
    const taken = [...blocks];
    for (const i of order) {
      if (!seen.has(i)) continue;
      const el = markers[i].getElement().firstElementChild;
      const b = box.get(i);
      const w = b.right - b.left, h = b.bottom - b.top;
      if (w > r.right - r.left || h > r.bottom - r.top) { el.style.visibility = 'hidden'; continue; }
      // The horizontal slide is decided once — the stem cannot fix a word hanging off the side.
      const dx = b.right > r.right ? r.right - b.right : b.left < r.left ? r.left - b.left : 0;
      if (Math.abs(dx) > NUDGE_MAX) { el.style.visibility = 'hidden'; continue; }
      /*
       * The vertical ladder IS the stem. A stemmed label may grow its leader (which lifts the word)
       * or shorten it down to zero (which lowers the word back onto its anchor); either way the
       * ring stays exactly where the place is. `zone` has no stem, so it keeps the plain slide.
       */
      const stem0 = rows[i].style.stemPx;
      const rungs = rows[i].stemmed
        ? [0, ...Array.from({ length: STEM_RUNGS }, (_, k) => (k + 1) * STEM_STEP),
          ...Array.from({ length: STEM_RUNGS }, (_, k) => -(k + 1) * STEM_STEP)].filter((d) => stem0 + d >= 0)
        : [0, -STEM_STEP, STEM_STEP, -2 * STEM_STEP, 2 * STEM_STEP];
      let placed = null;
      for (const d of rungs) {
        // a longer stem raises the name, i.e. moves it UP the screen: dy = -d
        const dy = rows[i].stemmed ? -d : d;
        const c = { left: b.left + dx, top: b.top + dy, right: b.right + dx, bottom: b.bottom + dy };
        if (c.top < r.top || c.bottom > r.bottom || c.left < r.left || c.right > r.right) continue;
        if (taken.some((o) => hit(c, o))) continue;
        placed = { d, dy, c };
        break;
      }
      if (!placed) { el.style.visibility = 'hidden'; continue; }
      taken.push(placed.c);
      if (dx) el.style.setProperty('--dx', `${dx}px`);
      if (rows[i].stemmed) {
        if (placed.d) el.style.setProperty('--stem', `${stem0 + placed.d}px`);
        // The cap tick becomes an elbow when the name slid: it must still reach under the word it
        // belongs to, or the leader points at nothing.
        const capLeft = Math.min(-CAP_HALF, dx - CAP_HALF), capRight = Math.max(CAP_HALF, dx + CAP_HALF);
        if (dx) { el.style.setProperty('--cap-x', `${capLeft}px`); el.style.setProperty('--cap-w', `${capRight - capLeft}px`); }
      } else if (placed.dy) {
        el.style.setProperty('--dy', `${placed.dy}px`);
      }
    }
  }
  // One clip per frame however many events land in it (a zoom fires `zoom` + `move` together).
  let pending = 0;
  const reclip = () => {
    if (pending) return;
    pending = requestAnimationFrame(() => { pending = 0; clip(); });
  };

  // Scale labels with zoom via a CSS variable on the map container.
  const update = () => { map.getContainer().style.setProperty('--label-zoom', map.getZoom()); reclip(); };
  map.on('zoomend zoom move moveend viewreset', update); update();
  group.reclip = reclip;
  return group;
}
