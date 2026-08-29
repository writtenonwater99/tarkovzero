import L from 'leaflet';

// Google-Maps-style ("roadmap") theme applied to tarkov.dev's class-based SVG geometry.
const THEME = `
  .land        { fill:#f1f3f4 }
  .trees       { fill:#d4dcd0 }
  .water       { fill:#9cc4f5 }
  .cement      { fill:#e6e6e6 }
  .rock        { fill:#dcdcdc }
  .building    { fill:#e0dcd5; stroke:#c9c4bb; stroke-width:.6 }
  .map_border  { fill:none; stroke:#bdbdbd; stroke-width:1.5 }
  .fence       { fill:none; stroke:#cfcfcf; stroke-width:.7 }
  .railroad    { fill:none; stroke:#9e9e9e; stroke-width:2; stroke-dasharray:4 3 }
  .powerline   { fill:none; stroke:#b0b0b0; stroke-width:1; stroke-dasharray:3 3 }
  .danger      { fill:#f28b82; fill-opacity:.35; stroke:#d93025; stroke-width:1 }
  /* roads: casing (drawn first) + fill */
  .casing .road_tarmac, .casing .road_gravel { stroke:#c8c8c8 }
  .road_tarmac { fill:none; stroke:#ffffff; stroke-linecap:round; stroke-linejoin:round }
  .road_gravel { fill:none; stroke:#f5efe0; stroke-linecap:round; stroke-linejoin:round }
  .casing .road_gravel { stroke:#d9d0bb }
  .road_large  { stroke-width:11 }  .casing .road_large  { stroke-width:14 }
  .road_medium { stroke-width:7 }   .casing .road_medium { stroke-width:9.5 }
  .road_small  { stroke-width:4 }   .casing .road_small  { stroke-width:6 }
  #High_Roads .road_tarmac { stroke:#fde293 } #High_Roads.casing .road_tarmac { stroke:#f5c664 }
  #Main_Roads .road_tarmac { stroke:#fff8e1 }
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
