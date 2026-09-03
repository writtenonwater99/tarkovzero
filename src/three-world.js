/**
 * Pure coordinate, terrain and camera helpers for the localhost Three.js proof.
 *
 * TarkovZero's canonical coordinates stay in EFT metres: x/east, y/up, z/north.
 * Both deck.gl and the Three.js proof render them as [-x, -z, y], with Z up.
 * Keeping this module free of Three.js and the DOM makes that contract testable.
 */

export const THREE_POC_SCOPE = Object.freeze({
  id: 'customs-industrial-rail-yard',
  label: 'Customs · industrial rail-yard golden cell',
  center: Object.freeze({ x: 230, z: -110 }),
  widthM: 360,
  depthM: 300,
});

export const RAILWAY_TRACK_PROFILE = Object.freeze({
  trackBedLiftM: 0.18,
  railBaseOffsetM: 0.1,
  railHeightM: 0.14,
  sleeperHeightM: 0.1,
  sleeperCenterLiftM: 0.025,
  vehicleWheelBottomLiftM: 0.42,
});

export const gameToWorld = (x, z, y = 0) => [-Number(x), -Number(z), Number(y)];
export const worldToGame = (wx, wy, wz = 0) => ({ x: -Number(wx), z: -Number(wy), y: Number(wz) });

/**
 * Preserve an object's canonical height above its local ground while terrain alone
 * receives visual relief. This keeps floor slabs, players and quest points from being
 * stretched vertically when the terrain is displayed at 2x.
 */
export function terrainRelativeDisplayY({ canonicalY, canonicalGroundY, displayGroundY }) {
  const ground = Number(displayGroundY);
  if (!Number.isFinite(ground)) throw new TypeError('displayGroundY must be finite');
  if (canonicalY == null) return ground;
  const objectY = Number(canonicalY), canonicalGround = Number(canonicalGroundY);
  if (!Number.isFinite(objectY)) return ground;
  if (!Number.isFinite(canonicalGround)) throw new TypeError('canonicalGroundY must be finite');
  return ground + (objectY - canonicalGround);
}

/**
 * Canonical placement for a point prop whose local +X axis is its `l` dimension.
 *
 * The game-to-world transform negates both horizontal axes (a 180-degree rotation), so the
 * unoriented long axis retains the positive authored yaw. Negating yaw mirrors every non-cardinal
 * prop and was the reason the old rail stock crossed its own tracks.
 */
export function pointPropPose(prop, groundY = 0) {
  const x = Number(prop?.x), z = Number(prop?.z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const dz = Number.isFinite(Number(prop?.dz)) ? Number(prop.dz) : 0;
  const yawDeg = Number.isFinite(Number(prop?.rot)) ? Number(prop.rot) : 0;
  return {
    position: gameToWorld(x, z, Number(groundY) + dz),
    rotationZ: yawDeg * Math.PI / 180,
    yawDeg,
  };
}

/**
 * Build a vertical-sided wall/prism whose four bottom corners follow the terrain.
 *
 * A box seated at the mean of two endpoint heights both floats and sinks on a slope. This mesh
 * keeps the source path exact in plan, samples the ground at every footprint corner, and raises
 * each corresponding top corner by the declared real-world height.
 */
export function drapedLinearSegmentMeshData(a, b, width, height, verticalOffset = 0, surfaceYFor = () => 0) {
  const ax = Number(a?.[0]), az = Number(a?.[1]), bx = Number(b?.[0]), bz = Number(b?.[1]);
  const safeWidth = Math.max(0.01, Number(width) || 0);
  const safeHeight = Math.max(0.01, Number(height) || 0);
  const offsetY = Number.isFinite(Number(verticalOffset)) ? Number(verticalOffset) : 0;
  if (![ax, az, bx, bz].every(Number.isFinite)) return null;
  const dx = bx - ax, dz = bz - az, length = Math.hypot(dx, dz);
  if (!(length > 1e-4)) return null;
  const px = -dz / length * safeWidth / 2;
  const pz = dx / length * safeWidth / 2;
  const footprint = [
    [ax + px, az + pz], [ax - px, az - pz],
    [bx + px, bz + pz], [bx - px, bz - pz],
  ];
  const positions = [];
  const bases = footprint.map(([x, z]) => {
    const sampled = Number(surfaceYFor(x, z));
    return Number.isFinite(sampled) ? sampled + offsetY : offsetY;
  });
  for (let level = 0; level < 2; level++) {
    footprint.forEach(([x, z], index) => {
      positions.push(...gameToWorld(x, z, bases[index] + (level ? safeHeight : 0)));
    });
  }
  return {
    positions: new Float32Array(positions),
    indices: new Uint16Array([
      0, 2, 1, 1, 2, 3, // ground-facing bottom
      4, 5, 6, 5, 7, 6, // upward-facing top
      0, 4, 2, 4, 6, 2, // left side
      1, 3, 5, 5, 3, 7, // right side
      0, 1, 4, 1, 5, 4, // start cap
      2, 6, 3, 6, 7, 3, // end cap
    ]),
    footprint,
    bases,
    length,
  };
}

/** Average four texels into one. A coverage mask is a fraction, so a plain box filter is correct. */
export function halveCoverageLevel(values, width) {
  const half = width >> 1;
  if (!(half >= 1) || values.length !== width * width) {
    throw new TypeError('halveCoverageLevel needs a square level of even width');
  }
  const out = new Float32Array(half * half);
  for (let row = 0; row < half; row++) {
    for (let column = 0; column < half; column++) {
      out[row * half + column] = (
        Number(values[(row * 2) * width + column * 2])
        + Number(values[(row * 2) * width + column * 2 + 1])
        + Number(values[(row * 2 + 1) * width + column * 2])
        + Number(values[(row * 2 + 1) * width + column * 2 + 1])
      ) / 4;
    }
  }
  return out;
}

/**
 * Rescale one level so the same FRACTION of its texels still passes `alphaTest`.
 *
 * A box filter conserves a mask's MEAN; an alpha TEST reads its COVERAGE, and those are not the
 * same number. Halving a thin line spreads it across neighbours that each land under the threshold,
 * so the fraction that survives falls level after level until the surface is gone entirely. Scaling
 * a level until the surviving fraction is back where level 0 put it is Castano's alpha-tested
 * antialiasing, and it is the difference between a fence that thins with distance and one that
 * vanishes at it.
 *
 * Coverage is monotonic in the scale, so a bisection finds it. `Math.min(1, …)` is applied to the
 * stored value too, so the level stays a coverage field rather than an unbounded multiple of one.
 */
export function rescaleLevelToCoverage(values, targetCoverage, alphaTest) {
  const coverage = (scale) => {
    let passing = 0;
    for (const value of values) if (Math.min(1, value * scale) >= alphaTest) passing++;
    return passing / values.length;
  };
  if (!values.some((value) => value > 0)) return values;
  let low = 0, high = 1024;
  for (let step = 0; step < 32; step++) {
    const mid = (low + high) / 2;
    if (coverage(mid) < targetCoverage) low = mid; else high = mid;
  }
  for (let index = 0; index < values.length; index++) values[index] = Math.min(1, values[index] * high);
  return values;
}

/**
 * The whole mip chain of an alpha-TEST mask, every level carrying level 0's coverage.
 *
 * `alpha` is a square coverage field in 0..1. Each returned level is `{ data, width, height }` with
 * the coverage written into all four bytes — three reads `alphaMap.g`, and a grey level is
 * inspectable as an image. The last levels (2x2, 1x1) can only be 0 or 1 covered, so the search
 * lands on 1 and the surface resolves into a solid haze: a chain-link fence a kilometre away is a
 * grey line, not a hole, and that is the correct end state for this chain.
 */
export function alphaCoverageMipChain(alpha, width, alphaTest) {
  if (!(width >= 1) || (width & (width - 1)) !== 0) throw new TypeError('mip chain needs a power-of-two width');
  if (alpha.length !== width * width) throw new TypeError('mip chain needs a square level 0');
  const toRgba = (values, size) => {
    const data = new Uint8Array(size * size * 4);
    for (let index = 0; index < values.length; index++) {
      const byte = Math.round(Math.min(1, Math.max(0, Number(values[index]) || 0)) * 255);
      data[index * 4] = data[index * 4 + 1] = data[index * 4 + 2] = data[index * 4 + 3] = byte;
    }
    return { data, width: size, height: size };
  };
  let level = Float32Array.from(alpha, (value) => Math.min(1, Math.max(0, Number(value) || 0)));
  // Bisect against the smallest byte that still clears the test, not against the test itself: a
  // level solved to exactly `alphaTest` rounds to byte 107, and 107/255 is 0.4196 — under 0.42.
  // Every texel the search saves would then be quantised straight back out of the mask.
  const threshold = Math.ceil(alphaTest * 255) / 255;
  const target = level.reduce((total, value) => total + (value >= threshold ? 1 : 0), 0) / level.length;
  const mipmaps = [];
  for (let size = width; size >= 1; size >>= 1) {
    mipmaps.push(toRgba(level, size));
    if (size === 1) break;
    level = rescaleLevelToCoverage(halveCoverageLevel(level, size), target, threshold);
  }
  return { mipmaps, targetCoverage: target };
}

/**
 * One continuous draped prism along a whole path, welded at every bend.
 *
 * `drapedLinearSegmentMeshData` above builds ONE segment, offsetting both its ends by that
 * segment's own perpendicular. Chain those and the outside of every corner is a wedge of nothing:
 * the two rectangles are parallel to different lines and never meet. This takes the already-mitered
 * two sides of the run (`miteredEdges` in wall-runs.js — kept there so both modules stay pure and
 * neither imports the other) and emits a single closed prism whose corner vertices are SHARED, so
 * there is no gap to leave.
 *
 * The face winding is vertex-for-vertex the single-segment builder's, so a straight two-point run
 * comes out with exactly the geometry and normals it had before.
 */
export function drapedPrismStripMeshData(edges, height, verticalOffset = 0, surfaceYFor = () => 0) {
  const ring = (Array.isArray(edges) ? edges : []).filter((edge) => [
    edge?.left?.[0], edge?.left?.[1], edge?.right?.[0], edge?.right?.[1],
  ].every((value) => Number.isFinite(Number(value))));
  if (ring.length < 2) return null;
  const safeHeight = Math.max(0.01, Number(height) || 0);
  const offsetY = Number.isFinite(Number(verticalOffset)) ? Number(verticalOffset) : 0;
  const footprint = [];
  for (const edge of ring) footprint.push([Number(edge.left[0]), Number(edge.left[1])], [Number(edge.right[0]), Number(edge.right[1])]);
  const bases = footprint.map(([x, z]) => {
    const sampled = Number(surfaceYFor(x, z));
    return Number.isFinite(sampled) ? sampled + offsetY : offsetY;
  });
  const positions = [];
  for (let level = 0; level < 2; level++) {
    footprint.forEach(([x, z], index) => {
      positions.push(...gameToWorld(x, z, bases[index] + (level ? safeHeight : 0)));
    });
  }
  const top = footprint.length;
  const indices = [];
  let length = 0;
  for (let index = 1; index < ring.length; index++) {
    const b0 = 2 * (index - 1), b1 = b0 + 1, b2 = 2 * index, b3 = b2 + 1;
    const t0 = top + b0, t1 = top + b1, t2 = top + b2, t3 = top + b3;
    indices.push(
      b0, b2, b1, b1, b2, b3, // ground-facing bottom
      t0, t1, t2, t1, t3, t2, // upward-facing top
      b0, t0, b2, t0, t2, b2, // left side
      b1, b3, t1, t1, b3, t3, // right side
    );
    if (index === 1) indices.push(b0, b1, t0, b1, t1, t0);            // start cap
    if (index === ring.length - 1) indices.push(b2, t2, b3, t2, t3, b3); // end cap
    const centre = (edge) => [(Number(edge.left[0]) + Number(edge.right[0])) / 2, (Number(edge.left[1]) + Number(edge.right[1])) / 2];
    const [cx0, cz0] = centre(ring[index - 1]), [cx1, cz1] = centre(ring[index]);
    length += Math.hypot(cx1 - cx0, cz1 - cz0);
  }
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    footprint,
    bases,
    length,
  };
}

/** Build the close-range steel rails and sleeper placement plan for reviewed track centre-lines. */
export function railwayTrackMeshData(railways, surfaceYFor, scope = THREE_POC_SCOPE, options = {}) {
  const gaugeM = Number(options.gaugeM) || 1.52;
  const railWidthM = Number(options.railWidthM) || 0.085;
  const railHeightM = Number(options.railHeightM) || RAILWAY_TRACK_PROFILE.railHeightM;
  const railBaseOffsetM = Number(options.railBaseOffsetM) || RAILWAY_TRACK_PROFILE.railBaseOffsetM;
  const sleeperSpacingM = Number(options.sleeperSpacingM) || 0.72;
  const sleeperLengthM = Number(options.sleeperLengthM) || 2.5;
  const sleeperWidthM = Number(options.sleeperWidthM) || 0.22;
  const sleeperHeightM = Number(options.sleeperHeightM) || RAILWAY_TRACK_PROFILE.sleeperHeightM;
  const marginM = Number(options.marginM) || 8;
  const positions = [], indices = [], sleepers = [];
  let railSegmentCount = 0;
  const inside = (x, z) => Math.abs(x - scope.center.x) <= scope.widthM / 2 + marginM
    && Math.abs(z - scope.center.z) <= scope.depthM / 2 + marginM;
  const appendRail = (mesh) => {
    const vertexOffset = positions.length / 3;
    positions.push(...mesh.positions);
    for (const index of mesh.indices) indices.push(index + vertexOffset);
    railSegmentCount++;
  };

  for (const railway of Array.isArray(railways) ? railways : []) {
    const path = Array.isArray(railway?.path) ? railway.path : [];
    for (let index = 1; index < path.length; index++) {
      const ax = Number(path[index - 1]?.[0]), az = Number(path[index - 1]?.[1]);
      const bx = Number(path[index]?.[0]), bz = Number(path[index]?.[1]);
      if (![ax, az, bx, bz].every(Number.isFinite)) continue;
      const dx = bx - ax, dz = bz - az, length = Math.hypot(dx, dz);
      if (!(length > 0.1) || !inside((ax + bx) / 2, (az + bz) / 2)) continue;
      const px = -dz / length * gaugeM / 2, pz = dx / length * gaugeM / 2;
      for (const side of [-1, 1]) {
        const rail = drapedLinearSegmentMeshData(
          [ax + px * side, az + pz * side],
          [bx + px * side, bz + pz * side],
          railWidthM,
          railHeightM,
          railBaseOffsetM,
          surfaceYFor,
        );
        if (rail) appendRail(rail);
      }
      const sleeperCount = Math.max(1, Math.round(length / sleeperSpacingM));
      for (let sleeper = 0; sleeper < sleeperCount; sleeper++) {
        const t = (sleeper + 0.5) / sleeperCount;
        const x = ax + dx * t, z = az + dz * t;
        sleepers.push({
          x, z,
          y: Number(surfaceYFor(x, z)) || 0,
          yaw: Math.atan2(dz, dx),
        });
      }
    }
  }
  return {
    railPositions: new Float32Array(positions),
    railIndices: new Uint32Array(indices),
    railSegmentCount,
    sleepers,
    sleeperSize: [sleeperWidthM, sleeperLengthM, sleeperHeightM],
    profile: Object.freeze({
      railBaseOffsetM,
      railHeightM,
      railTopOffsetFromSurfaceM: railBaseOffsetM + railHeightM,
      sleeperHeightM,
      sleeperCenterLiftM: RAILWAY_TRACK_PROFILE.sleeperCenterLiftM,
      sleeperTopOffsetFromSurfaceM:
        RAILWAY_TRACK_PROFILE.sleeperCenterLiftM + sleeperHeightM,
    }),
  };
}

/** Find the first labelled ancestor, rejecting hits hidden anywhere in their hierarchy. */
export function visibleInteractionData(object) {
  let current = object, interaction = null;
  while (current) {
    if (current.visible === false) return null;
    if (!interaction && current.userData?.label) interaction = current.userData;
    current = current.parent;
  }
  return interaction;
}

/**
 * One-way lifecycle gate for resources whose loaders cannot be cancelled after decoding starts.
 * A late resource is disposed instead of being attached to an already-disposed scene.
 */
export function createAsyncAttachGuard(disposeResource = () => {}) {
  let disposed = false;
  return {
    get active() { return !disposed; },
    attach(resource, attachResource) {
      if (disposed) {
        disposeResource(resource);
        return false;
      }
      attachResource(resource);
      return true;
    },
    dispose() { disposed = true; },
  };
}

/** Dispose every texture map owned by an authored material, then the material itself. */
export function disposeMaterialResources(material, state = {}) {
  const textures = state.textures ?? (state.textures = new Set());
  const materials = state.materials ?? (state.materials = new Set());
  if (Array.isArray(material)) {
    for (const entry of material) disposeMaterialResources(entry, state);
    return state;
  }
  if (!material || materials.has(material)) return state;
  materials.add(material);
  const disposeTexture = (value) => {
    if (!value?.isTexture || textures.has(value)) return;
    textures.add(value);
    value.dispose?.();
  };
  for (const value of Object.values(material)) {
    disposeTexture(value);
    if (Array.isArray(value)) for (const entry of value) disposeTexture(entry);
  }
  for (const uniform of Object.values(material.uniforms ?? {})) {
    disposeTexture(uniform?.value);
    if (Array.isArray(uniform?.value)) for (const entry of uniform.value) disposeTexture(entry);
  }
  material.dispose?.();
  return state;
}

export function inRing([x, z], ring) {
  if (!Array.isArray(ring) || ring.length < 3) return true;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export const UNDERSTORY_TUFT_BUDGET = Object.freeze({
  densityPerSquareM: 0.65,
  maxInstances: 12_000,
  footprintRadiusM: 0.4,
  nearMaxDistanceM: 110,
  mediumMaxDistanceM: 340,
  hysteresisM: 16,
});

/** Unit tuft geometry in the renderer's Z-up world; instances provide metric width/height. */
export function grassTuftMeshData(blades = 3, taperedQuad = true) {
  const safeBlades = Math.max(1, Math.floor(Number(blades) || 1));
  const positions = [], uvs = [], indices = [];
  for (let blade = 0; blade < safeBlades; blade++) {
    const angle = blade * Math.PI / safeBlades;
    const rightX = Math.cos(angle) * 0.5, rightY = Math.sin(angle) * 0.5;
    const leanX = -Math.sin(angle) * 0.09, leanY = Math.cos(angle) * 0.09;
    const start = positions.length / 3;
    if (taperedQuad) {
      positions.push(-rightX, -rightY, 0, rightX, rightY, 0,
        leanX - rightX * 0.09, leanY - rightY * 0.09, 1,
        leanX + rightX * 0.09, leanY + rightY * 0.09, 1);
      uvs.push(0, 0, 1, 0, 0.45, 1, 0.55, 1);
      indices.push(start, start + 1, start + 2, start + 1, start + 3, start + 2);
    } else {
      positions.push(-rightX, -rightY, 0, rightX, rightY, 0, leanX, leanY, 1);
      uvs.push(0, 0, 1, 0, 0.5, 1);
      indices.push(start, start + 1, start + 2);
    }
  }
  return { positions, uvs, indices };
}

const mixUint32 = (value) => {
  let mixed = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a2d97);
  return (mixed ^ (mixed >>> 15)) >>> 0;
};

const hashUnit = (seed, a, b, c) => mixUint32(
  (seed >>> 0)
  ^ Math.imul(a | 0, 0x9e3779b1)
  ^ Math.imul(b | 0, 0x85ebca77)
  ^ Math.imul(c | 0, 0xc2b2ae3d),
) / 0x100000000;

const boundaryDistanceSq = (x, z, ring) => {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, az] = ring[j], [bx, bz] = ring[i];
    const dx = bx - ax, dz = bz - az;
    const denominator = dx * dx + dz * dz;
    const t = denominator > 0
      ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / denominator))
      : 0;
    const edgeX = ax + t * dx, edgeZ = az + t * dz;
    best = Math.min(best, (x - edgeX) ** 2 + (z - edgeZ) ** 2);
  }
  return best;
};

/**
 * Build deterministic grass-tuft placements from reviewed understory rings.
 *
 * A globally aligned jittered grid avoids clumps and frame-to-frame changes. Every centre is
 * inside its source ring and at least one tuft footprint from its boundary, so blade geometry does
 * not leak into unreviewed terrain. If the density would exceed the hard cap, one representative
 * per covered ring is retained before the remaining slots are filled by deterministic priority.
 */
export function buildUnderstoryTuftPlan(rings, options = {}) {
  const densityPerSquareM = Math.max(0.01, Number(options.densityPerSquareM)
    || UNDERSTORY_TUFT_BUDGET.densityPerSquareM);
  const maxInstances = Math.max(0, Math.floor(Number.isFinite(Number(options.maxInstances))
    ? Number(options.maxInstances)
    : UNDERSTORY_TUFT_BUDGET.maxInstances));
  const footprintRadiusM = Math.max(0, Number.isFinite(Number(options.footprintRadiusM))
    ? Number(options.footprintRadiusM)
    : UNDERSTORY_TUFT_BUDGET.footprintRadiusM);
  const seed = Number.isFinite(Number(options.seed)) ? Math.floor(Number(options.seed)) : 106;
  const spacingM = Math.sqrt(1 / densityPerSquareM);
  const candidates = [];

  for (const [ringIndex, ring] of (Array.isArray(rings) ? rings : []).entries()) {
    if (!Array.isArray(ring) || ring.length < 3 || ring.some((point) => !Array.isArray(point)
      || !Number.isFinite(Number(point[0])) || !Number.isFinite(Number(point[1])))) continue;
    const xs = ring.map((point) => Number(point[0]));
    const zs = ring.map((point) => Number(point[1]));
    const minGridX = Math.floor(Math.min(...xs) / spacingM);
    const maxGridX = Math.ceil(Math.max(...xs) / spacingM);
    const minGridZ = Math.floor(Math.min(...zs) / spacingM);
    const maxGridZ = Math.ceil(Math.max(...zs) / spacingM);
    for (let gridX = minGridX; gridX <= maxGridX; gridX++) {
      for (let gridZ = minGridZ; gridZ <= maxGridZ; gridZ++) {
        const x = (gridX + 0.5 + (hashUnit(seed, ringIndex, gridX, gridZ) - 0.5) * 0.62) * spacingM;
        const z = (gridZ + 0.5 + (hashUnit(seed + 601, ringIndex, gridZ, gridX) - 0.5) * 0.62) * spacingM;
        if (!inRing([x, z], ring)
          || boundaryDistanceSq(x, z, ring) < footprintRadiusM * footprintRadiusM) continue;
        candidates.push({
          ringIndex,
          x,
          z,
          yaw: hashUnit(seed + 1_207, ringIndex, gridX, gridZ) * Math.PI * 2,
          widthM: 0.16 + hashUnit(seed + 1_809, ringIndex, gridZ, gridX) * 0.14,
          heightM: 0.28 + hashUnit(seed + 2_411, ringIndex, gridX, gridZ) * 0.27,
          shade: hashUnit(seed + 3_013, ringIndex, gridZ, gridX),
          priority: hashUnit(seed + 3_617, ringIndex, gridX, gridZ),
        });
      }
    }
  }

  let placements = candidates;
  if (candidates.length > maxInstances) {
    const representatives = new Map();
    for (const candidate of candidates) {
      const current = representatives.get(candidate.ringIndex);
      if (!current || candidate.priority < current.priority) representatives.set(candidate.ringIndex, candidate);
    }
    const first = [...representatives.values()].sort((a, b) => a.priority - b.priority).slice(0, maxInstances);
    const retained = new Set(first);
    const remainder = candidates.filter((candidate) => !retained.has(candidate))
      .sort((a, b) => a.priority - b.priority);
    placements = [...first, ...remainder.slice(0, Math.max(0, maxInstances - first.length))];
  }
  placements = placements.sort((a, b) => a.ringIndex - b.ringIndex || a.x - b.x || a.z - b.z);

  return {
    placements,
    candidateCount: candidates.length,
    coveredRings: new Set(placements.map((placement) => placement.ringIndex)).size,
    densityPerSquareM,
    maxInstances,
    footprintRadiusM,
    spacingM,
  };
}

export function centroid(poly = []) {
  if (!poly.length) return [0, 0];
  return poly.reduce((sum, point) => [sum[0] + point[0] / poly.length, sum[1] + point[1] / poly.length], [0, 0]);
}

export function makeTerrainSampler(terrain, relief = 1) {
  const factor = [1, 2, 3].includes(Number(relief)) ? Number(relief) : 1;
  if (!terrain || !Number.isFinite(terrain.x0) || !Number.isFinite(terrain.z0)
    || !Number.isFinite(terrain.step) || !(terrain.cols > 1) || !(terrain.rows > 1)
    || !Array.isArray(terrain.heights)) return () => 0;
  const { x0, z0, step, cols, rows, heights } = terrain;
  return (x, z) => {
    const fx = Math.min(Math.max((Number(x) - x0) / step, 0), cols - 1.001);
    const fz = Math.min(Math.max((Number(z) - z0) / step, 0), rows - 1.001);
    const c = Math.floor(fx), r = Math.floor(fz);
    const tx = fx - c, tz = fz - r;
    const h00 = Number(heights[r * cols + c]) || 0;
    const h10 = Number(heights[r * cols + c + 1]) || 0;
    const h01 = Number(heights[(r + 1) * cols + c]) || 0;
    const h11 = Number(heights[(r + 1) * cols + c + 1]) || 0;
    return ((h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz) * factor;
  };
}

export function cameraPose(viewState, viewportHeight, fovy = 22) {
  const target = Array.isArray(viewState?.target) ? viewState.target.map(Number) : [0, 0, 0];
  const zoom = Number.isFinite(Number(viewState?.zoom)) ? Number(viewState.zoom) : 0;
  const rotationX = Number.isFinite(Number(viewState?.rotationX)) ? Number(viewState.rotationX) : 32;
  const rotationOrbit = Number.isFinite(Number(viewState?.rotationOrbit)) ? Number(viewState.rotationOrbit) : -20;
  const scale = Math.pow(2, zoom);
  const distance = (Math.max(1, Number(viewportHeight) || 1) / 2) / (scale * Math.tan((fovy * Math.PI) / 360));
  const elevation = (rotationX * Math.PI) / 180;
  const orbit = (rotationOrbit * Math.PI) / 180;
  const horizontal = distance * Math.cos(elevation);
  return {
    target,
    position: [
      target[0] + horizontal * Math.sin(orbit),
      target[1] - horizontal * Math.cos(orbit),
      target[2] + distance * Math.sin(elevation),
    ],
    distance,
  };
}

export function viewStateFromPose(position, target, viewportHeight, fovy = 22, previous = {}) {
  const dx = position[0] - target[0];
  const dy = position[1] - target[1];
  const dz = position[2] - target[2];
  const distance = Math.max(1e-6, Math.hypot(dx, dy, dz));
  const scale = (Math.max(1, Number(viewportHeight) || 1) / 2) / (distance * Math.tan((fovy * Math.PI) / 360));
  return {
    ...previous,
    target: [...target],
    zoom: Math.log2(scale),
    rotationX: Math.asin(Math.max(-1, Math.min(1, dz / distance))) * 180 / Math.PI,
    rotationOrbit: Math.atan2(dx, -dy) * 180 / Math.PI,
  };
}

const vectorDistance = (left = [], right = []) => Math.hypot(
  Number(left[0]) - Number(right[0]),
  Number(left[1]) - Number(right[1]),
  Number(left[2]) - Number(right[2]),
);

/**
 * Convert an OrbitControls pose into app state, clamp it, and derive the one
 * camera pose that may be published. When `corrected` is true the controller
 * must write `pose` back before notifying the app; otherwise the HUD/permalink
 * would describe a camera the canvas is not actually using.
 */
export function reconcileOrbitView({
  position, target, previous = {}, viewportHeight, fovy = 22,
  clamp = (view) => view, epsilon = 1e-7,
}) {
  const observed = viewStateFromPose(position, target, viewportHeight, fovy, previous);
  const view = clamp(observed);
  const pose = cameraPose(view, viewportHeight, fovy);
  return {
    view,
    pose,
    corrected: vectorDistance(position, pose.position) > epsilon
      || vectorDistance(target, pose.target) > epsilon,
  };
}

export function terrainMeshData(terrain, limit, relief = 1, surfaceUvFor = null) {
  if (!terrain || !(terrain.cols > 1) || !(terrain.rows > 1)) {
    return {
      positions: new Float32Array(), uvs: new Float32Array(), detailUvs: new Float32Array(),
      indices: new Uint32Array(),
    };
  }
  const { x0, z0, step, cols, rows, heights } = terrain;
  const factor = [1, 2, 3].includes(Number(relief)) ? Number(relief) : 1;
  const positions = new Float32Array(cols * rows * 3);
  const uvs = new Float32Array(cols * rows * 2);
  const detailUvs = new Float32Array(cols * rows * 2);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const x = x0 + c * step, z = z0 + r * step;
      positions[i * 3] = -x;
      positions[i * 3 + 1] = -z;
      positions[i * 3 + 2] = (Number(heights[i]) || 0) * factor;
      const surfaceUv = typeof surfaceUvFor === 'function' ? surfaceUvFor(x, z) : [x / 32, z / 32];
      uvs[i * 2] = Number(surfaceUv?.[0]) || 0;
      uvs[i * 2 + 1] = Number(surfaceUv?.[1]) || 0;
      detailUvs[i * 2] = x / 32;
      detailUvs[i * 2 + 1] = z / 32;
    }
  }
  const indices = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const cx = x0 + (c + 0.5) * step, cz = z0 + (r + 0.5) * step;
      if (!inRing([cx, cz], limit)) continue;
      const a = r * cols + c, b = a + 1, d = (r + 1) * cols + c, e = d + 1;
      // gameToWorld negates both horizontal axes, so a→b→d is counter-clockwise from above and
      // emits an upward normal. The old a→d→b order made every terrain triangle a back face.
      indices.push(a, b, d, b, e, d);
    }
  }
  return { positions, uvs, detailUvs, indices: new Uint32Array(indices) };
}

export function withinScope(point, scope = THREE_POC_SCOPE) {
  const x = Array.isArray(point) ? point[0] : point?.x;
  const z = Array.isArray(point) ? point[1] : point?.z;
  return Math.abs(Number(x) - scope.center.x) <= scope.widthM / 2
    && Math.abs(Number(z) - scope.center.z) <= scope.depthM / 2;
}

const THREE_FX_KEYS = ['fog', 'grade', 'detail'];

/** Parse the same `all` / `none` / comma-list callback value used by the deck renderer. */
export function parseThreeFx(raw) {
  if (raw == null || raw === '') return Object.fromEntries(THREE_FX_KEYS.map((key) => [key, true]));
  if (typeof raw === 'object') {
    return Object.fromEntries(THREE_FX_KEYS.map((key) => [key, raw[key] !== false]));
  }
  const enabled = new Set(String(raw).toLowerCase().split(',').map((value) => value.trim()).filter(Boolean));
  if (enabled.has('all')) return Object.fromEntries(THREE_FX_KEYS.map((key) => [key, true]));
  return Object.fromEntries(THREE_FX_KEYS.map((key) => [key, enabled.has(key)]));
}

export function updateThreeFx(current, patch) {
  return {
    ...current,
    ...Object.fromEntries(THREE_FX_KEYS.filter((key) => key in (patch || {})).map((key) => [key, Boolean(patch[key])])),
  };
}

export function markerOverlaySpec(marker) {
  const x = Number(marker?.position?.x), z = Number(marker?.position?.z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const markerKind = String(marker?.kind ?? 'marker');
  const isExtract = markerKind.startsWith('extract');
  const fallback = markerKind.replace(/[-_]+/g, ' ').trim() || 'marker';
  return {
    x, z,
    y: Number.isFinite(Number(marker?.position?.y)) ? Number(marker.position.y) : null,
    kind: isExtract ? 'extract' : 'marker',
    markerKind,
    label: String(marker?.name ?? fallback),
    title: String(marker?.name ?? fallback),
    level: marker?.level ?? 'surface',
  };
}

export function questZoneSpec(zone) {
  if (!Array.isArray(zone?.outline) || zone.outline.length < 3) return null;
  const outline = zone.outline.map((point) => [Number(point?.[0]), Number(point?.[1])]);
  if (outline.some((point) => !point.every(Number.isFinite))) return null;
  return { id: zone.id ?? null, level: zone.level ?? 'surface', outline };
}

const finiteRect = (rect, width, height) => {
  const left = Math.max(0, Number(rect?.left) || 0);
  const top = Math.max(0, Number(rect?.top) || 0);
  const right = Math.min(width, Number.isFinite(Number(rect?.right)) ? Number(rect.right) : width);
  const bottom = Math.min(height, Number.isFinite(Number(rect?.bottom)) ? Number(rect.bottom) : height);
  return right > left && bottom > top ? { left, top, right, bottom } : { left: 0, top: 0, right: width, bottom: height };
};

/** Seat a bottom-centred DOM marker completely inside the current safe rect. */
export function seatOverlayAnchor({ x, y, elementWidth = 0, elementHeight = 0, safeRect, containerWidth, containerHeight, padding = 4 }) {
  const width = Math.max(1, Number(containerWidth) || 1), height = Math.max(1, Number(containerHeight) || 1);
  if (![x, y].every(Number.isFinite)) return null;
  const rect = finiteRect(safeRect, width, height);
  const half = Math.max(0, Number(elementWidth) || 0) / 2;
  const tall = Math.max(0, Number(elementHeight) || 0);
  const minX = Math.min(rect.right, rect.left + padding + half);
  const maxX = Math.max(minX, rect.right - padding - half);
  const minY = Math.min(rect.bottom, rect.top + padding + tall);
  const maxY = Math.max(minY, rect.bottom - padding);
  return [Math.max(minX, Math.min(maxX, x)), Math.max(minY, Math.min(maxY, y))];
}
