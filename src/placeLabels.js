import L from 'leaflet';

// Google-Maps-like place labels: text that scales with zoom, drawn in a pane above tiles/markers.
export function placeLabelsLayer(map, labels, { pane = 'labels' } = {}) {
  if (!map.getPane(pane)) { map.createPane(pane); map.getPane(pane).style.zIndex = 450; map.getPane(pane).style.pointerEvents = 'none'; }
  const group = L.layerGroup();
  for (const l of labels) {
    const size = (l.size ?? 100) / 100;
    const rot = Number(l.rotation ?? 0);
    const icon = L.divIcon({
      className: 'place-label-wrap',
      html: `<div class="place-label" style="--s:${size};--r:${rot}deg">${l.text}</div>`,
      iconSize: [0, 0],
    });
    group.addLayer(L.marker([l.position[1], l.position[0]], { icon, pane, interactive: false, keyboard: false }));
  }
  // Scale labels with zoom via a CSS variable on the map container.
  const update = () => map.getContainer().style.setProperty('--label-zoom', map.getZoom());
  map.on('zoomend zoom', update); update();
  return group;
}
