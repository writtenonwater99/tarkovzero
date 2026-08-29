// 3D view: deck.gl OrbitView (orthographic, tilted) over the same game-coordinate data as the 2D map.
// deck cartesian = [-gameX, -gameZ, gameY] so on-screen orientation matches the 2D map at 0° orbit.
import { Deck, OrbitView, LightingEffect, AmbientLight, DirectionalLight, COORDINATE_SYSTEM } from '@deck.gl/core';
import { SolidPolygonLayer, PathLayer, IconLayer, TextLayer, LineLayer, PolygonLayer } from '@deck.gl/layers';
import { KINDS, iconDataUrl, arrowDataUrl } from './icons.js';
import { esc, COLORS } from './live.js';

const C = {
  land: [238, 240, 242], water: [156, 196, 245], pavement: [224, 224, 224], tree: [183, 217, 154], rock: [205, 205, 205],
  road: [255, 255, 255], highway: [253, 226, 147], dirt: [245, 239, 224], rail: [160, 160, 160], fence: [200, 200, 200],
  building: [222, 214, 203], buildingMulti: [206, 194, 178], tank: [200, 205, 212], tower: [180, 180, 180], underground: [40, 40, 40, 70],
  buildingHover: [96, 165, 250],
};
const P = ([x, z], y = 0) => [-x, -z, y];
const OVERLAY = { depthCompare: 'always', depthWriteEnabled: false }; // icons/labels always on top of geometry
const ring = (poly) => poly.map((p) => P(p));

export async function createView3d(container, mapData, src) {
  const data = await (await fetch('/data/customs-3d.json')).json();
  // Rasterise SVG icons into one canvas atlas (deck's icon loader is unreliable with SVG data URLs).
  async function buildAtlas(entries, cell) {
    const canvas = document.createElement('canvas'); canvas.width = cell * entries.length; canvas.height = cell;
    const ctx = canvas.getContext('2d'); const mapping = {};
    await Promise.all(entries.map(([name, url], i) => new Promise((res) => {
      const img = new Image(); img.onload = () => { ctx.drawImage(img, i * cell, 0, cell, cell); res(); }; img.onerror = res; img.src = url;
      mapping[name] = { x: i * cell, y: 0, width: cell, height: cell, anchorY: cell, mask: false };
    })));
    return { canvas, mapping };
  }
  const iconAtlas = await buildAtlas(Object.keys(KINDS).map((k) => [k, iconDataUrl(k, 64)]), 64);
  const arrowAtlas = await buildAtlas(COLORS.map((c) => [c, arrowDataUrl(c, 64)]), 64);
  for (const m of Object.values(arrowAtlas.mapping)) m.anchorY = 32;
  let viewState = { target: [0, 0, 0], zoom: 0, rotationX: 50, rotationOrbit: 0, minZoom: -2, maxZoom: 5 };
  let hover = null;

  const lighting = new LightingEffect({
    ambient: new AmbientLight({ color: [255, 255, 255], intensity: 0.85 }),
    sun: new DirectionalLight({ color: [255, 250, 240], intensity: 0.9, direction: [-0.6, -0.4, -1], _shadow: true }),
  });

  const staticLayers = () => [
    new SolidPolygonLayer({ id: 'land', data: data.land, getPolygon: ring, getFillColor: C.land, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new SolidPolygonLayer({ id: 'pavement', data: data.pavement, getPolygon: ring, getFillColor: C.pavement, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new SolidPolygonLayer({ id: 'water', data: data.water, getPolygon: ring, getFillColor: C.water, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new SolidPolygonLayer({ id: 'underground', data: data.underground, getPolygon: (d) => ring(d.poly), getFillColor: C.underground, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, pickable: true }),
    new PathLayer({ id: 'rail', data: data.railway, getPath: (d) => ring(d.path), getColor: C.rail, getWidth: 2, widthUnits: 'meters', widthMinPixels: 1, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new PathLayer({ id: 'roads', data: data.roads, getPath: (d) => ring(d.path), getColor: (d) => (d.kind === 'highway' ? C.highway : d.kind === 'dirt' ? C.dirt : C.road), getWidth: (d) => d.width, widthUnits: 'meters', widthMinPixels: 1.5, capRounded: true, jointRounded: true, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new PathLayer({ id: 'fences', data: data.fences, getPath: (d) => ring(d.path), getColor: C.fence, getWidth: 0.6, widthUnits: 'meters', widthMinPixels: 0.5, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    new SolidPolygonLayer({ id: 'rocks', data: data.rocks, getPolygon: ring, extruded: true, getElevation: 1.2, getFillColor: C.rock, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, material: { ambient: 0.75, diffuse: 0.45, shininess: 8 } }),
    new SolidPolygonLayer({ id: 'trees', data: data.trees, getPolygon: ring, extruded: true, getElevation: 3, getFillColor: C.tree, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, material: { ambient: 0.75, diffuse: 0.45, shininess: 4 } }),
  ];
  const buildingLayer = () => new SolidPolygonLayer({
    id: 'buildings', data: data.buildings, getPolygon: (d) => ring(d.poly), extruded: true, getElevation: (d) => d.height,
    getFillColor: (d, { index }) => (hover === index ? C.buildingHover : d.kind === 'tank' ? C.tank : d.kind === 'powerline_towers' ? C.tower : d.floors > 1 ? C.buildingMulti : C.building),
    updateTriggers: { getFillColor: hover }, pickable: true, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
    material: { ambient: 0.7, diffuse: 0.55, shininess: 12, specularColor: [30, 30, 30] },
    onHover: (i) => { if (i.index !== hover) { hover = i.index; render(); } },
  });
  const dynamicLayers = () => {
    const markers = src.markers();
    const players = src.players().filter((p) => p.last);
    return [
      new IconLayer({ id: 'markers', data: markers, getPosition: (d) => P([d.position.x, d.position.z], 0.5), iconAtlas: iconAtlas.canvas, iconMapping: iconAtlas.mapping, getIcon: (d) => d.kind, getSize: 14, sizeUnits: 'meters', sizeMinPixels: 14, sizeMaxPixels: 30, billboard: true, pickable: true, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
      new TextLayer({ id: 'labels', data: src.labels(), getPosition: (d) => P(d.position, 2), getText: (d) => d.text, getSize: (d) => 9 * ((d.size ?? 100) / 100), sizeUnits: 'meters', sizeMinPixels: 9, sizeMaxPixels: 22, getColor: [50, 55, 60], fontFamily: 'system-ui, sans-serif', fontWeight: 700, outlineWidth: 4, outlineColor: [255, 255, 255, 230], fontSettings: { sdf: true }, billboard: true, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
      new PathLayer({ id: 'trails', data: players.filter((p) => p.trail), getPath: (p) => p.trail.getLatLngs().map((ll) => P([ll.lng, ll.lat], 0.3)), getColor: (p) => hex(p.color, 200), getWidth: 1.2, widthUnits: 'meters', widthMinPixels: 2, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
      new LineLayer({ id: 'drop', data: players, getSourcePosition: (p) => P([p.last.x, p.last.z], 0), getTargetPosition: (p) => P([p.last.x, p.last.z], p.last.y ?? 0), getColor: (p) => hex(p.color, 160), getWidth: 2, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
      new IconLayer({ id: 'players', data: players, getPosition: (p) => P([p.last.x, p.last.z], (p.last.y ?? 0) + 0.2), iconAtlas: arrowAtlas.canvas, iconMapping: arrowAtlas.mapping, getIcon: (p) => p.color, getSize: 12, sizeUnits: 'meters', sizeMinPixels: 22, sizeMaxPixels: 44, billboard: false, getAngle: (p) => -((p.last.yaw ?? 0) + (mapData.coordinateRotation ?? 0)), pickable: true, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, updateTriggers: { getPosition: players.map((p) => p.last), getAngle: players.map((p) => p.last) } }),
      new TextLayer({ id: 'player-names', data: players, getPosition: (p) => P([p.last.x, p.last.z], (p.last.y ?? 0) + 0.2), getText: (p) => p.name, getPixelOffset: [22, 0], getTextAnchor: 'start', getSize: 13, getColor: [255, 255, 255], outlineWidth: 5, outlineColor: [0, 0, 0, 220], fontSettings: { sdf: true }, fontWeight: 700, billboard: true, parameters: OVERLAY, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN }),
    ];
  };
  const hex = (h, a = 255) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a];

  const deck = new Deck({
    parent: container, views: new OrbitView({ orbitAxis: 'Z', fovy: 22 }), controller: { inertia: 300 },
    initialViewState: viewState, effects: [lighting], getCursor: ({ isHovering }) => (isHovering ? 'pointer' : 'grab'),
    onViewStateChange: ({ viewState: v }) => { viewState = v; deck.setProps({ viewState: v }); src.onViewChange?.(v); },
    getTooltip: ({ object, layer }) => {
      if (!object) return null;
      if (layer.id === 'buildings') return { html: `<b>${esc(object.name ?? object.kind)}</b><br>${object.floors} floor${object.floors > 1 ? 's' : ''} · ${object.height} m`, className: 'deck-tooltip' };
      if (layer.id === 'underground') return { html: `<b>${esc(object.name)}</b><br>underground`, className: 'deck-tooltip' };
      if (layer.id === 'markers') return { html: object.html, className: 'deck-tooltip' };
      if (layer.id === 'players') return { html: `<b>${esc(object.name)}</b><br>x ${object.last.x} z ${object.last.z} y ${object.last.y ?? 0}`, className: 'deck-tooltip' };
      return null;
    },
  });
  const base = staticLayers();
  function render() { deck.setProps({ layers: [...base, buildingLayer(), ...dynamicLayers()] }); }
  render();
  return {
    refresh: render,
    setView: ({ target, zoom }) => { viewState = { ...viewState, target, zoom }; deck.setProps({ viewState }); },
    deck,
  };
}
