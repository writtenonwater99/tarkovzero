// Instanced low-poly trees for the 3D map. Geometry is canonical metres; accessors add the
// deterministic per-tree scale/rotation and place each root on the shared terrain H(x,z).
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { Geometry } from '@luma.gl/engine';
import { paletteFor, resolveLook, foliageMaterialFor, trunkMaterialFor } from './atmosphere.js';

const FAR_ZOOM = -0.55;
// Vector lifts every crown toward a bright sage so the canopy reads as one map symbol; realistic
// leaves the authored/species tone alone (the plan wants muted species tints, not a wash).
const LIFT = { vector: [158, 174, 137, 0.18], realistic: [120, 128, 106, 0.06] };
const toward = (c, [tr, tg, tb, k]) => c.map((v, i) => (i < 3 ? Math.round(v + ([tr, tg, tb][i] - v) * k) : v));

const hash = (a, b) => {
  const n = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return n - Math.floor(n);
};

function geometry(positions, normals, indices) {
  return new Geometry({
    topology: 'triangle-list',
    attributes: {
      POSITION: { value: new Float32Array(positions), size: 3 },
      NORMAL: { value: new Float32Array(normals), size: 3 },
    },
    indices: { value: new Uint16Array(indices), size: 1 },
  });
}

function cylinderMesh(sides = 9) {
  const p = [], n = [], idx = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2, x = Math.cos(a) * 0.2, y = Math.sin(a) * 0.2;
    p.push(x, y, 0, x, y, 2.5);
    n.push(Math.cos(a), Math.sin(a), 0, Math.cos(a), Math.sin(a), 0);
  }
  for (let i = 0; i < sides; i++) {
    const a = i * 2, b = ((i + 1) % sides) * 2;
    idx.push(a, b, b + 1, a, b + 1, a + 1);
  }
  // A small top cap remains visible between broadleaf branches at close zoom.
  const centre = p.length / 3;
  p.push(0, 0, 2.5); n.push(0, 0, 1);
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    p.push(Math.cos(a) * 0.2, Math.sin(a) * 0.2, 2.5); n.push(0, 0, 1);
    idx.push(centre, centre + 1 + i, centre + 1 + ((i + 1) % sides));
  }
  return geometry(p, n, idx);
}

function facetedMesh(triangles) {
  const p = [], n = [], idx = [];
  for (const [a, b, c] of triangles) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1; nx /= L; ny /= L; nz /= L;
    const base = p.length / 3;
    p.push(...a, ...b, ...c); n.push(nx, ny, nz, nx, ny, nz, nx, ny, nz); idx.push(base, base + 1, base + 2);
  }
  return geometry(p, n, idx);
}

function coniferMesh(sides = 9) {
  const tris = [];
  const cone = (radius, baseZ, tipZ, turn) => {
    const tip = [0, 0, tipZ], centre = [0, 0, baseZ];
    for (let i = 0; i < sides; i++) {
      const a = turn + (i / sides) * Math.PI * 2, b = turn + ((i + 1) / sides) * Math.PI * 2;
      const pa = [Math.cos(a) * radius, Math.sin(a) * radius, baseZ];
      const pb = [Math.cos(b) * radius, Math.sin(b) * radius, baseZ];
      tris.push([pa, pb, tip], [centre, pb, pa]);
    }
  };
  cone(2.35, 1.05, 7.7, 0);
  cone(1.72, 4.35, 10, Math.PI / sides);
  return facetedMesh(tris);
}

function broadleafMesh(sides = 9, bands = 5) {
  const tris = [], point = (i, j) => {
    const lat = -Math.PI / 2 + (i / bands) * Math.PI;
    const lon = (j / sides) * Math.PI * 2;
    return [2.6 * Math.cos(lat) * Math.cos(lon), 2.6 * Math.cos(lat) * Math.sin(lon), 4.8 + 2.8 * Math.sin(lat)];
  };
  for (let i = 0; i < bands; i++) for (let j = 0; j < sides; j++) {
    const next = (j + 1) % sides, a = point(i, j), b = point(i, next), c = point(i + 1, next), d = point(i + 1, j);
    if (i > 0) tris.push([a, b, c]);
    if (i < bands - 1) tris.push([a, c, d]);
  }
  return facetedMesh(tris);
}

const TRUNK_MESH = cylinderMesh();
const CONIFER_MESH = coniferMesh();
const BROADLEAF_MESH = broadleafMesh();

export function prepareTrees(source, mapKey) {
  const coniferChance = mapKey === 'woods' ? 0.64 : mapKey === 'reserve' ? 0.42 : 0.5;
  const all = (source || []).filter((t) => Number.isFinite(t.x) && Number.isFinite(t.z)).map((t, i) => {
    const type = t.type === 'conifer' || t.type === 'broadleaf' ? t.type : (hash(t.x + 17, t.z - 31) < coniferChance ? 'conifer' : 'broadleaf');
    // The tone is a deterministic INDEX, not a colour: the look resolves it at layer time, so
    // flipping the skin never touches a tree's identity, position, scale or rotation.
    const tone = Math.floor(hash(t.x - 53, t.z + 89) * 3) % 3;
    return {
      ...t,
      type,
      tone,
      sourceColor: t.color ?? null,
      rotation: t.rotation ?? hash(t.x + 101, t.z - 73) * 360,
      aspect: t.aspect ?? 0.84 + hash(t.x - 11, t.z + 37) * 0.3,
      trunkRadius: t.trunkRadius ?? 0.15 + hash(t.x + 7, t.z + 13) * 0.1,
      trunkHeight: t.trunkHeight ?? 2 + hash(t.x - 19, t.z - 23),
      lodKeep: t.lodKeep ?? hash(t.x + i * 0.17, t.z - i * 0.11) >= 0.5,
    };
  });
  return { all, far: all.filter((t) => t.lodKeep) };
}

export function treeLayers({ treeSet, H, zoom, relief, look, fogExtension }) {
  const mode = resolveLook(look);
  const C = paletteFor(mode);
  const lift = LIFT[mode];
  // Foliage tone: the authored per-tree colour when the data has one, otherwise the look's own
  // three-stop canopy set indexed by the tree's frozen hash. Same instance, different material.
  const tone = (d) => (d.sourceColor ? toward(d.sourceColor, lift) : C.treeTones[d.tone % C.treeTones.length]);
  // LOD is intentionally a function of camera zoom only. Relief changes placement, never density.
  const source = zoom < FAR_ZOOM ? treeSet.far : treeSet.all;
  const conifers = source.filter((t) => t.type === 'conifer');
  const broadleaf = source.filter((t) => t.type === 'broadleaf');
  const common = {
    shadowEnabled: false,
    pickable: false,
    coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
    getPosition: (d) => [-d.x, -d.z, H(d.x, d.z)],
    getOrientation: (d) => [0, d.rotation, 0],
    updateTriggers: { getPosition: relief, getColor: mode },
    extensions: fogExtension ? [fogExtension] : [],
  };
  // Realistic overcast: a lower base ambient and more directional response than vector, so a canopy
  // has a lit side; atmosphere.js's EXPOSURE puts the overall value back where the palette says.
  const foliageMaterial = mode === 'realistic'
    ? foliageMaterialFor('realistic')
    : { ambient: 0.72, diffuse: 0.58, shininess: 1, specularColor: [8, 10, 7] };
  return [
    new SimpleMeshLayer({
      ...common, id: 'tree-trunks', data: source, mesh: TRUNK_MESH, getColor: C.trunk,
      getScale: (d) => [d.trunkRadius / 0.2, d.trunkRadius / 0.2, d.trunkHeight / 2.5],
      material: mode === 'realistic' ? trunkMaterialFor('realistic') : { ambient: 0.48, diffuse: 0.72, shininess: 0 },
    }),
    // Retain the historical `trees` id on the dominant canopy layer for integrations/tests.
    new SimpleMeshLayer({
      ...common, id: 'trees', data: conifers, mesh: CONIFER_MESH, getColor: tone,
      getScale: (d) => [(d.radius / 2.35) * d.aspect, (d.radius / 2.35) / d.aspect, d.height / 10],
      material: foliageMaterial,
    }),
    new SimpleMeshLayer({
      ...common, id: 'trees-broadleaf', data: broadleaf, mesh: BROADLEAF_MESH, getColor: tone,
      getScale: (d) => [(d.radius / 2.6) * d.aspect, (d.radius / 2.6) / d.aspect, d.height / 7.6],
      material: foliageMaterial,
    }),
  ];
}
