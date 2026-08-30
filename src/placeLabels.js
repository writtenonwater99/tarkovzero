import L from 'leaflet';

// Google-Maps-like place labels: text that scales with zoom, drawn in a pane above tiles/markers.
//
// The HUD floats over an edge-to-edge map, so a label whose ink lands under the right toolbar, the
// dock column, the top chips or the omnibox is not "behind glass" — it is a word the reader sees
// truncated ("BIG RED" reading as "BIG", QA D5). `safeRect` here is shell.js's AVOID rect — the
// part of the stage nothing floats over, dock included, which is not the rect a fit frames into
// (that one is full width; QA H4): after every move, and whenever the chrome itself moves, each label is
// measured and either nudged back inside the rect — a small slide only, so the word stays on its
// landmark — or hidden until the camera or the chrome gives it room again.
const NUDGE_MAX = 22;   // px a label may slide to escape the chrome before it is dropped instead
// QA D3: the slide stopped the moment the ink was inside the rect, which put "POWERLINE TOWER" and
// "SNIPER RIDGE" flush against x=0 — inside by the letter of it, and still reading as a word
// falling off the frame. The rect is inset by this before anything is measured against it, so a
// label always keeps a margin of air. Same number as the 3D pass (map3d.js LABEL_INSET).
const INSET = 12;
// QA D6: a quest pin landed centred on CRACKHOUSE and ate a letter. Pins are not moved — the label
// is lifted clear of one instead, by its own height plus this.
const LIFT_GAP = 4;

/**
 * @param {import('leaflet').Map} map
 * @param {Array<{position:number[],text:string,size?:number,rotation?:number|string}>} labels
 * @param {object} [opts]
 * @param {string} [opts.pane]
 * @param {()=>{left:number,top:number,right:number,bottom:number}} [opts.safeRect]
 *        stage area nothing floats over, in stage CSS px. Omit it and labels are never clipped.
 * @param {()=>Array<{left:number,top:number,right:number,bottom:number}>} [opts.obstacles]
 *        boxes in stage CSS px that own their pixels outright — the quest pins. A label that lands
 *        on one is lifted above it; if it cannot be lifted clear it is hidden, never overprinted.
 * @param {(label:object)=>boolean} [opts.hidden]
 *        a label this list should not draw right now, decided per clip rather than at construction:
 *        the marker data that settles it (which names an EXTRACT already owns) lands after the
 *        layer is built. Returning true hides the label without disturbing the rest of the pass.
 */
export function placeLabelsLayer(map, labels, { pane = 'labels', safeRect = null, obstacles = null, hidden = null } = {}) {
  if (!map.getPane(pane)) { map.createPane(pane); map.getPane(pane).style.zIndex = 450; map.getPane(pane).style.pointerEvents = 'none'; }
  const group = L.layerGroup();
  const markers = [];
  for (const l of labels) {
    const size = (l.size ?? 100) / 100;
    const rot = Number(l.rotation ?? 0);
    const icon = L.divIcon({
      className: 'place-label-wrap',
      html: `<div class="place-label" style="--s:${size};--r:${rot}deg">${l.text}</div>`,
      iconSize: [0, 0],
    });
    const m = L.marker([l.position[1], l.position[0]], { icon, pane, interactive: false, keyboard: false });
    markers.push(m);
    group.addLayer(m);
  }

  /** Reset → measure → write, in three passes: interleaving them thrashes layout on every frame. */
  function clip() {
    if (!safeRect) return;
    const els = [];
    for (let i = 0; i < markers.length; i++) {
      const el = markers[i].getElement()?.firstElementChild;
      if (!el) continue;
      el.style.removeProperty('--dx');
      el.style.removeProperty('--dy');
      el.style.removeProperty('visibility');
      if (hidden?.(labels[i])) { el.style.visibility = 'hidden'; continue; }
      els.push(el);
    }
    if (!els.length) return;
    const s = map.getContainer().getBoundingClientRect();
    const raw = safeRect();
    const r = { left: raw.left + INSET, top: raw.top + INSET, right: raw.right - INSET, bottom: raw.bottom - INSET };
    if (r.right - r.left < 60 || r.bottom - r.top < 60) return;
    let blocks = [];
    try { blocks = obstacles?.() ?? []; } catch { blocks = []; }
    const boxes = els.map((el) => el.getBoundingClientRect());
    for (let i = 0; i < els.length; i++) {
      const b = boxes[i];
      if (!b.width || !b.height) continue;
      const left = b.left - s.left, right = b.right - s.left;
      const top = b.top - s.top, bottom = b.bottom - s.top;
      const dx = right > r.right ? r.right - right : left < r.left ? r.left - left : 0;
      let dy = bottom > r.bottom ? r.bottom - bottom : top < r.top ? r.top - top : 0;
      // Too big to ever fit, or too far in to slide out: hidden beats half a word.
      if (b.width > r.right - r.left || b.height > r.bottom - r.top
        || Math.abs(dx) > NUDGE_MAX || Math.abs(dy) > NUDGE_MAX) { els[i].style.visibility = 'hidden'; continue; }
      // A pin on the word: lift the label its own height above the pin, then re-check the rect.
      // Up first, because the pin's own point is at its bottom — moving the name down would put it
      // under the marker's stem rather than clear of it.
      if (blocks.length) {
        const hits = (o) => left + dx < o.right && o.left < right + dx
          && top + dy < o.bottom && o.top < bottom + dy;
        let blocked = blocks.find(hits);
        for (let k = 0; blocked && k < 2; k++) {
          const lift = bottom + dy - blocked.top + LIFT_GAP;
          dy -= lift;
          blocked = blocks.find(hits);
        }
        if (blocked || top + dy < r.top || Math.abs(dy) > NUDGE_MAX + 30) { els[i].style.visibility = 'hidden'; continue; }
      }
      if (dx) els[i].style.setProperty('--dx', `${dx}px`);
      if (dy) els[i].style.setProperty('--dy', `${dy}px`);
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
