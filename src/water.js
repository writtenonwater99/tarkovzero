// Shared water geometry and heightfield conditioning.
//
// Water is authored in game [x,z] coordinates and stores unexaggerated world heights. The
// runtime applies relief to the resulting plane exactly once, alongside the terrain field.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (u) => u * u * (3 - 2 * u);

export const waterPoly = (water) => Array.isArray(water) ? water : water?.poly || [];
export const waterHoles = (water) => Array.isArray(water) ? [] : water?.holes || [];
export const waterRings = (water) => [waterPoly(water), ...waterHoles(water)].filter((ring) => ring.length >= 3);
export const allWaterRings = (waters) => (waters || []).flatMap(waterRings);

export function pointInRing([x, z], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInWater(point, water) {
  const poly = waterPoly(water);
  return poly.length >= 3 && pointInRing(point, poly) && !waterHoles(water).some((hole) => pointInRing(point, hole));
}

export function waterLevelAt(water, x, z) {
  const level = Number(water?.level);
  if (!Number.isFinite(level)) return null;
  const gradient = water?.gradient;
  if (!gradient || !Number.isFinite(gradient.slope)) return level;
  const axis = gradient.axis || [0, 0], origin = gradient.origin || [0, 0];
  return level + gradient.slope * ((x - origin[0]) * axis[0] + (z - origin[1]) * axis[1]);
}

export function waterSurfaceAt(waters, point) {
  let level = null;
  for (const water of waters || []) {
    if (!pointInWater(point, water)) continue;
    const candidate = waterLevelAt(water, point[0], point[1]);
    if (candidate != null && (level == null || candidate > level)) level = candidate;
  }
  return level;
}

function indexedRing(poly, binSize) {
  const rayBins = new Map(), edgeBins = new Map(), edges = [];
  const push = (map, key, edge) => { if (!map.has(key)) map.set(key, []); map.get(key).push(edge); };
  for (let i = 0; i < poly.length; i++) {
    const edge = [poly[i], poly[(i + 1) % poly.length]];
    edges.push(edge);
    const x1 = Math.floor(Math.min(edge[0][0], edge[1][0]) / binSize), x2 = Math.floor(Math.max(edge[0][0], edge[1][0]) / binSize);
    const z1 = Math.floor(Math.min(edge[0][1], edge[1][1]) / binSize), z2 = Math.floor(Math.max(edge[0][1], edge[1][1]) / binSize);
    for (let iz = z1; iz <= z2; iz++) {
      push(rayBins, iz, edge);
      for (let ix = x1; ix <= x2; ix++) push(edgeBins, `${ix},${iz}`, edge);
    }
  }
  return { poly, rayBins, edgeBins, binSize, edges };
}

function indexedContains([x, z], ring) {
  let inside = false;
  for (const [a, b] of ring.rayBins.get(Math.floor(z / ring.binSize)) || []) {
    if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function indexedDistance([x, z], ring) {
  const ix = Math.floor(x / ring.binSize), iz = Math.floor(z / ring.binSize), nearby = new Set();
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    for (const edge of ring.edgeBins.get(`${ix + dx},${iz + dz}`) || []) nearby.add(edge);
  }
  const edges = nearby.size ? nearby : ring.edges;
  let best = Infinity;
  for (const [a, b] of edges) {
    const ex = b[0] - a[0], ez = b[1] - a[1], l2 = ex * ex + ez * ez || 1;
    const t = clamp(((x - a[0]) * ex + (z - a[1]) * ez) / l2, 0, 1);
    best = Math.min(best, Math.hypot(x - a[0] - t * ex, z - a[1] - t * ez));
  }
  return best;
}

// Fast continuous cap for bicubic/bilinear samplers. The serialized grid is already carved, but
// cubic interpolation can overshoot between a high bank node and a submerged bed node. Z-binned
// ray tests and edge bins make this exact shoreline constraint cheap enough for every mesh normal.
export function makeWaterHeightCapper(waters, scale = 1) {
  if (!waters?.length) return (height) => height;
  const maxBank = Math.max(1, ...waters.map((water) => Number.isFinite(water.bank) ? water.bank : 5));
  const binSize = Math.max(8, maxBank + 1);
  const specs = waters.map((water) => {
    const outer = indexedRing(waterPoly(water), binSize), holes = waterHoles(water).map((ring) => indexedRing(ring, binSize));
    const xs = outer.poly.map((p) => p[0]), zs = outer.poly.map((p) => p[1]), bank = Number.isFinite(water.bank) ? water.bank : 5;
    return { water, outer, holes, bank, bounds: [Math.min(...xs) - bank, Math.min(...zs) - bank, Math.max(...xs) + bank, Math.max(...zs) + bank] };
  });
  return (height, x, z) => {
    let capped = height;
    for (const { water, outer, holes, bank, bounds } of specs) {
      if (x < bounds[0] || z < bounds[1] || x > bounds[2] || z > bounds[3]) continue;
      const level0 = waterLevelAt(water, x, z);
      if (level0 == null) continue;
      const level = level0 * scale, inOuter = indexedContains([x, z], outer);
      const hole = inOuter ? holes.find((ring) => indexedContains([x, z], ring)) : null;
      if (inOuter && !hole) {
        const depth = (Number.isFinite(water.depth) ? water.depth : 1.2) * scale;
        capped = Math.min(capped, level - depth);
        continue;
      }
      const distance = indexedDistance([x, z], hole || outer);
      if (distance >= bank) continue;
      const target = level + (height - level) * smoothstep(distance / bank);
      capped = Math.min(capped, target);
    }
    return capped;
  };
}

// Cap a fitted grid to the authored water basin. This never raises terrain: inside water the bed
// is level-depth; on land, a smooth 4-6 m shoulder lowers high banks toward the shoreline level.
// The function is shared by the builder and runtime so the runtime's compact conditioning pass
// cannot blur a bank back through the water plane.
export function carveWaterHeightfield(input, terrain, waters) {
  if (!waters?.length) return Float32Array.from(input);
  const { x0, z0, step, cols, rows } = terrain;
  const source = Float32Array.from(input), out = Float32Array.from(input), capWater = makeWaterHeightCapper(waters);

  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = x0 + c * step, z = z0 + r * step, k = r * cols + c;
    out[k] = capWater(source[k], x, z);
  }
  return out;
}
