import L from 'leaflet';

// Bright paper-map theme applied to tarkov.dev's class-based SVG geometry. Sage land, mineral
// greys, and warm structures keep it cohesive with 3D without resembling a Google basemap.
const THEME = `
  .land        { fill:#e1ead8 }
  .trees       { fill:#bfd2b7 }
  .water       { fill:#8fcbd5 }
  .cement      { fill:#ddd9cf }
  .rock        { fill:#cec9bb }
  .building    { fill:#ddcfbb; stroke:#bcae9a; stroke-width:.6 }
  .map_border  { fill:none; stroke:#a8aa9e; stroke-width:1.5 }
  .fence       { fill:none; stroke:#bab9aa; stroke-width:.7 }
  .railroad    { fill:none; stroke:#88887e; stroke-width:2; stroke-dasharray:4 3 }
  .powerline   { fill:none; stroke:#999b90; stroke-width:1; stroke-dasharray:3 3 }
  .danger      { fill:#dc8375; fill-opacity:.32; stroke:#b94d42; stroke-width:1 }
  /* roads: casing (drawn first) + fill */
  .casing .road_tarmac, .casing .road_gravel { stroke:#b9b6aa }
  .road_tarmac { fill:none; stroke:#eeece4; stroke-linecap:round; stroke-linejoin:round }
  .road_gravel { fill:none; stroke:#e6d8bb; stroke-linecap:round; stroke-linejoin:round }
  .casing .road_gravel { stroke:#c7b894 }
  .road_large  { stroke-width:11 }  .casing .road_large  { stroke-width:14 }
  .road_medium { stroke-width:7 }   .casing .road_medium { stroke-width:9.5 }
  .road_small  { stroke-width:4 }   .casing .road_small  { stroke-width:6 }
  #High_Roads .road_tarmac { stroke:#ead7a1 } #High_Roads.casing .road_tarmac { stroke:#c9ad69 }
  #Main_Roads .road_tarmac { stroke:#f0e9d5 }
  .hidden      { display:none }
`;

/** Returns a Leaflet layer rendering the ground-level SVG in roadmap style. */
export function roadmapLayer(svgUrl, groundLayerId, bounds) {
  const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  fetch(svgUrl).then((r) => r.text()).then((txt) => {
    svgEl.innerHTML = txt;
    const root = svgEl.children[0];
    svgEl.setAttribute('viewBox', root.getAttribute('viewBox'));
    root.querySelector('style').textContent = THEME;
    // Ground level only (v1: no interiors).
    for (const g of root.children) {
      if (g.nodeName === 'g' && g.id && g.id !== groundLayerId) g.classList.add('hidden'); // includes First_Floor (keep-with-group)
    }
    // Road casings: duplicate each road group underneath itself with a wider, darker stroke.
    const ground = root.querySelector(`#${groundLayerId}`);
    for (const id of ['Dirt_Roads', 'Roads', 'Main_Roads', 'High_Roads']) {
      const g = ground.querySelector(`#${id}`);
      if (!g) continue;
      const casing = g.cloneNode(true);
      casing.classList.add('casing');
      casing.removeAttribute('id'); casing.id = id; // keep id for per-road color rules
      g.parentNode.insertBefore(casing, g);
    }
  });
  return L.svgOverlay(svgEl, bounds, { className: 'roadmap' });
}
