import L from 'leaflet';

// Google-Maps-like place labels: text that scales with zoom, drawn in a pane above tiles/markers.
//
// The HUD floats over an edge-to-edge map, so a label whose ink lands under the right toolbar, the
// dock column, the top chips or the omnibox is not "behind glass" — it is a word the reader sees
// truncated ("BIG RED" reading as "BIG", QA D5). `safeRect` is the same rect fit()/fly() pad
// against (src/shell.js): after every move, and whenever the chrome itself moves, each label is
// measured and either nudged back inside the rect — a small slide only, so the word stays on its
// landmark — or hidden until the camera or the chrome gives it room again.
const NUDGE_MAX = 22;   // px a label may slide to escape the chrome before it is dropped instead

/**
 * @param {import('leaflet').Map} map
 * @param {Array<{position:number[],text:string,size?:number,rotation?:number|string}>} labels
 * @param {object} [opts]
 * @param {string} [opts.pane]
 * @param {()=>{left:number,top:number,right:number,bottom:number}} [opts.safeRect]
 *        stage area nothing floats over, in stage CSS px. Omit it and labels are never clipped.
 */
export function placeLabelsLayer(map, labels, { pane = 'labels', safeRect = null } = {}) {
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
    for (const m of markers) {
      const el = m.getElement()?.firstElementChild;
      if (!el) continue;
      el.style.removeProperty('--dx');
      el.style.removeProperty('--dy');
      el.style.removeProperty('visibility');
      els.push(el);
    }
    if (!els.length) return;
    const s = map.getContainer().getBoundingClientRect();
    const r = safeRect();
    const boxes = els.map((el) => el.getBoundingClientRect());
    for (let i = 0; i < els.length; i++) {
      const b = boxes[i];
      if (!b.width || !b.height) continue;
      const left = b.left - s.left, right = b.right - s.left;
      const top = b.top - s.top, bottom = b.bottom - s.top;
      const dx = right > r.right ? r.right - right : left < r.left ? r.left - left : 0;
      const dy = bottom > r.bottom ? r.bottom - bottom : top < r.top ? r.top - top : 0;
      // Too big to ever fit, or too far in to slide out: hidden beats half a word.
      if (b.width > r.right - r.left || b.height > r.bottom - r.top
        || Math.abs(dx) > NUDGE_MAX || Math.abs(dy) > NUDGE_MAX) { els[i].style.visibility = 'hidden'; continue; }
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
