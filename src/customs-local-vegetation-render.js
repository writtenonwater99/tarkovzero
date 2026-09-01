import { customsTerrainDisplayY } from './customs-local-terrain.js';

const CLASSIFICATIONS = new Set([
  'pine',
  'deciduous',
  'shrub',
  'stump',
  'ground-plant',
]);

const finite = (value, label) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite`);
  return Object.is(number, -0) ? 0 : number;
};

const positive = (value, label) => {
  const number = finite(value, label);
  if (!(number > 0)) throw new TypeError(`${label} must be greater than zero`);
  return number;
};

function insideScope({ x, z }, scope) {
  if (!scope) return true;
  return x >= finite(scope.minX, 'scope.minX')
    && x <= finite(scope.maxX, 'scope.maxX')
    && z >= finite(scope.minZ, 'scope.minZ')
    && z <= finite(scope.maxZ, 'scope.maxZ');
}

function numberedVariant(name, fallback = 1) {
  const match = String(name).match(/(?:pine|tree|birch|stump)[_-]?(\d+)/iu);
  return match ? Math.max(1, Number(match[1])) : fallback;
}

/**
 * Original proxy dimensions for a validated vegetation instance.
 *
 * The position, yaw and Unity-authored scale stay exact. These dimensions are
 * deliberately labelled proxy geometry: they can be replaced by original GLB
 * families without changing the canonical placement contract.
 */
export function customsVegetationProxyDimensions(instance) {
  const classification = String(instance?.classification ?? '');
  if (!CLASSIFICATIONS.has(classification)) {
    throw new TypeError(`unsupported vegetation classification ${classification || '(empty)'}`);
  }
  const name = String(instance.prototypeName ?? '').toLowerCase();
  const widthScale = positive(instance.widthScale ?? 1, 'instance.widthScale');
  const heightScale = positive(instance.heightScale ?? 1, 'instance.heightScale');
  const variant = numberedVariant(name);

  if (classification === 'pine') {
    const baseHeight = [10.8, 9.6, 8.8, 7.9, 7.1][Math.min(4, variant - 1)];
    const height = baseHeight * heightScale;
    return Object.freeze({
      height,
      width: baseHeight * 0.44 * widthScale,
      trunkHeight: height * 0.27,
      trunkRadius: Math.max(0.09, baseHeight * 0.025 * widthScale),
    });
  }
  if (classification === 'deciduous') {
    const baseHeight = [9.2, 8.1, 7.2][Math.min(2, variant - 1)];
    const height = baseHeight * heightScale;
    return Object.freeze({
      height,
      width: baseHeight * 0.58 * widthScale,
      trunkHeight: height * 0.38,
      trunkRadius: Math.max(0.1, baseHeight * 0.03 * widthScale),
    });
  }
  if (classification === 'shrub') {
    const baseHeight = name.includes('big') ? 2.45 : name.includes('small') ? 1.05 : 1.65;
    return Object.freeze({
      height: baseHeight * heightScale,
      width: baseHeight * 1.15 * widthScale,
      trunkHeight: 0,
      trunkRadius: 0,
    });
  }
  if (classification === 'stump') {
    const baseHeight = 0.58 + Math.min(3, variant - 1) * 0.08;
    return Object.freeze({
      height: baseHeight * heightScale,
      width: 0.62 * widthScale,
      trunkHeight: baseHeight * heightScale,
      trunkRadius: 0.31 * widthScale,
    });
  }
  const baseHeight = name.includes('fern') ? 0.72 : name.includes('grass') ? 0.56 : 0.82;
  return Object.freeze({
    height: baseHeight * heightScale,
    width: baseHeight * 0.9 * widthScale,
    trunkHeight: 0,
    trunkRadius: 0,
  });
}

function normalizedTint(color, dry) {
  const channel = (key) => {
    const raw = Number(color?.[key]);
    if (!Number.isFinite(raw)) return 1;
    return Math.max(0, Math.min(1, raw > 1 ? raw / 255 : raw));
  };
  if (dry) return Object.freeze({ r: 1, g: 0.84, b: 0.58 });
  return Object.freeze({
    r: Math.max(0.78, channel('r')),
    g: Math.max(0.72, channel('g')),
    b: Math.max(0.72, channel('b')),
  });
}

/** Build a renderer-neutral, exact-placement plan for Three instancing. */
export function buildCustomsLocalVegetationRenderPlan(vegetation, {
  scope = null,
  reliefOriginYM = 0,
} = {}) {
  if (!Array.isArray(vegetation?.instances)) {
    throw new TypeError('vegetation.instances must be an array');
  }
  const groups = Object.fromEntries([...CLASSIFICATIONS].map((classification) => [classification, []]));
  for (const instance of vegetation.instances) {
    const classification = String(instance?.classification ?? '');
    if (!CLASSIFICATIONS.has(classification)) {
      throw new TypeError(`unsupported vegetation classification ${classification || '(empty)'}`);
    }
    const position = {
      x: finite(instance.worldPosition?.x, 'instance.worldPosition.x'),
      y: finite(instance.worldPosition?.y, 'instance.worldPosition.y'),
      z: finite(instance.worldPosition?.z, 'instance.worldPosition.z'),
    };
    if (!insideScope(position, scope)) continue;
    const displayY = customsTerrainDisplayY(position.y, reliefOriginYM);
    const name = String(instance.prototypeName ?? '');
    groups[classification].push(Object.freeze({
      flatIndex: instance.flatIndex,
      tileId: instance.tileId,
      prototypeId: instance.prototypeId,
      prototypeName: name,
      classification,
      canonicalPosition: Object.freeze(position),
      presentationPosition: Object.freeze([-position.x, -position.z, displayY]),
      displayY,
      yawRadians: finite(instance.rotationRadians ?? 0, 'instance.rotationRadians'),
      dimensions: customsVegetationProxyDimensions(instance),
      dry: /(?:dry|dead)/iu.test(name),
      tint: normalizedTint(instance.color, /(?:dry|dead)/iu.test(name)),
    }));
  }
  const counts = Object.freeze(Object.fromEntries(
    Object.entries(groups).map(([classification, instances]) => [classification, instances.length]),
  ));
  const renderedCount = Object.values(counts).reduce((sum, count) => sum + count, 0);
  for (const instances of Object.values(groups)) Object.freeze(instances);
  return Object.freeze({
    sourceCount: vegetation.instances.length,
    renderedCount,
    culledCount: vegetation.instances.length - renderedCount,
    reliefOriginYM: finite(reliefOriginYM, 'reliefOriginYM'),
    geometry: 'original-procedural-class-proxies',
    counts,
    groups: Object.freeze(groups),
  });
}
