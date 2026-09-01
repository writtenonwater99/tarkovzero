/**
 * Small original landmark kit for the localhost Three renderer.
 *
 * Every prototype uses the canonical prop frame: +X is `l` (along heading), +Y is `w`
 * (across heading), +Z is up, and the origin is the centre of the ground footprint. Placement and
 * yaw stay outside this module so a future GLB can replace one prototype without moving its EFT
 * anchor. These are deliberately recognizable fallbacks, not substitutes for the authored GLBs.
 */
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clean = (value) => String(value ?? '').toLowerCase();
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

export function propDimensions(prop = {}) {
  const radius = Math.max(0.1, finite(prop.r, 1));
  return {
    width: Math.max(0.2, finite(prop.w, radius * 2)),
    length: Math.max(0.2, finite(prop.l, radius * 2)),
    height: Math.max(0.2, finite(prop.h, 2)),
  };
}

export function propAssetKind(prop = {}) {
  const name = clean(prop.name);
  if (prop.type === 'crane') return 'yard-crane';
  if (prop.type === 'vehicle' && /crane/.test(name)) return 'crane-truck';
  if (prop.type === 'vehicle' && /trailer/.test(name)) return 'road-trailer';
  if (prop.type === 'vehicle') return 'road-vehicle';
  if (prop.type === 'railcar' && /locomotive|\bengine\b/.test(name)) return 'locomotive';
  if ((prop.type === 'railcar' || prop.type === 'tanker') && /tank|tanker/.test(name)) return 'tanker-wagon';
  if (prop.type === 'railcar') return 'freight-wagon';
  if (prop.type === 'container' && /\btank\b/.test(name)) return 'storage-tank';
  if (prop.type === 'container') return 'shipping-container';
  if (prop.type === 'tank') return 'storage-tank';
  return 'generic-prop';
}

function roleMaterial(materialForRole, role, prop) {
  const supplied = materialForRole?.(role, prop);
  if (supplied) return supplied;
  const color = Array.isArray(prop.color)
    ? new THREE.Color(prop.color[0] / 255, prop.color[1] / 255, prop.color[2] / 255)
    : new THREE.Color(0x73766f);
  if (role === 'dark') color.multiplyScalar(0.32);
  if (role === 'metal') color.set(0x5c605d);
  if (role === 'glass') color.set(0x26383a);
  return new THREE.MeshStandardMaterial({
    color,
    roughness: role === 'glass' ? 0.3 : 0.78,
    metalness: role === 'metal' ? 0.62 : role === 'glass' ? 0.12 : 0.2,
  });
}

function boxGeometry([sx, sy, sz, x = 0, y = 0, z = 0]) {
  const geometry = new THREE.BoxGeometry(Math.max(0.015, sx), Math.max(0.015, sy), Math.max(0.015, sz));
  geometry.translate(x, y, z);
  return geometry;
}

function mergedBoxes(specs) {
  const parts = specs.map(boxGeometry);
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  return merged;
}

function addMesh(group, geometry, material, name, { castShadow = true } = {}) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

function wheelGeometry(radius, width) {
  // CylinderGeometry's native Y axis is the rail vehicle's transverse axle.
  return new THREE.CylinderGeometry(radius, radius, width, 12, 1, false);
}

function addWheelsets(group, { length, width, height }, material, count = 2) {
  const radius = clamp(Math.min(width * 0.16, height * 0.105), 0.22, 0.48);
  const axleWidth = width;
  const span = length * (count === 3 ? 0.27 : 0.31);
  for (let index = 0; index < count; index++) {
    const x = count === 1 ? 0 : -span + (span * 2 * index) / (count - 1);
    const geometry = wheelGeometry(radius, axleWidth);
    geometry.translate(x, 0, radius);
    addMesh(group, geometry, material, `wheelset:${index + 1}`);
  }
  return radius;
}

function addCouplers(group, { length, width }, material, z) {
  const couplerLength = Math.min(0.58, length * 0.08);
  const specs = [-1, 1].map((side) => [
    couplerLength,
    Math.min(0.42, width * 0.2),
    0.18,
    side * (length / 2 - couplerLength / 2),
    0,
    z,
  ]);
  addMesh(group, mergedBoxes(specs), material, 'couplers');
}

function shippingContainer(group, dimensions, materials) {
  const { length, width, height } = dimensions;
  addMesh(group, boxGeometry([length * 0.985, width * 0.97, height * 0.95, 0, 0, height * 0.5]), materials.body, 'container-shell');

  const ribDepth = Math.max(0.035, Math.min(0.075, width * 0.022));
  const ribWidth = Math.max(0.045, Math.min(0.11, length * 0.012));
  const frame = [];
  const ribCount = Math.max(4, Math.min(9, Math.round(length / 1.8)));
  for (let index = 1; index < ribCount; index++) {
    const x = -length / 2 + (length * index) / ribCount;
    for (const side of [-1, 1]) frame.push([
      ribWidth, ribDepth, height * 0.86, x, side * (width / 2 - ribDepth / 2), height * 0.51,
    ]);
    frame.push([ribWidth, width * 0.9, ribDepth, x, 0, height - ribDepth / 2]);
  }
  const post = Math.max(0.06, Math.min(0.13, width * 0.045));
  for (const x of [-length / 2, length / 2]) for (const y of [-width / 2, width / 2]) {
    frame.push([post, post, height, x - Math.sign(x) * post / 2, y - Math.sign(y) * post / 2, height / 2]);
  }
  // Door bars at both ends make the object read as a container even when seen end-on.
  for (const x of [-length / 2 + ribDepth / 2, length / 2 - ribDepth / 2]) {
    for (const y of [-width * 0.25, width * 0.25]) frame.push([ribDepth, post, height * 0.8, x, y, height * 0.49]);
    frame.push([ribDepth, width * 0.86, post, x, 0, height * 0.13]);
    frame.push([ribDepth, width * 0.86, post, x, 0, height * 0.87]);
  }
  addMesh(group, mergedBoxes(frame), materials.dark, 'container-ribs-and-doors');
}

function freightWagon(group, dimensions, materials) {
  const { length, width, height } = dimensions;
  const wheelRadius = addWheelsets(group, dimensions, materials.dark, length > 18 ? 3 : 2);
  const frameZ = wheelRadius * 1.65;
  addMesh(group, boxGeometry([length, width * 0.92, Math.max(0.18, height * 0.09), 0, 0, frameZ]), materials.metal, 'wagon-underframe');
  const bodyH = Math.max(height * 0.5, height - frameZ - height * 0.16);
  addMesh(group, boxGeometry([length * 0.94, width * 0.94, bodyH, 0, 0, frameZ + bodyH * 0.53]), materials.body, 'wagon-body');
  const braces = [];
  const braceCount = Math.max(3, Math.min(7, Math.round(length / 2.8)));
  for (let index = 1; index < braceCount; index++) {
    const x = -length * 0.47 + (length * 0.94 * index) / braceCount;
    for (const side of [-1, 1]) braces.push([0.08, 0.055, bodyH * 0.88, x, side * width * 0.48, frameZ + bodyH * 0.53]);
  }
  addMesh(group, mergedBoxes(braces), materials.dark, 'wagon-side-braces');
  addCouplers(group, dimensions, materials.dark, frameZ);
}

function locomotive(group, dimensions, materials) {
  const { length, width, height } = dimensions;
  const wheelRadius = addWheelsets(group, dimensions, materials.dark, 3);
  const frameZ = wheelRadius * 1.65;
  addMesh(group, boxGeometry([length, width * 0.95, height * 0.1, 0, 0, frameZ]), materials.metal, 'locomotive-frame');
  const hoodLength = length * 0.61;
  const hoodHeight = height * 0.46;
  addMesh(group, boxGeometry([hoodLength, width * 0.78, hoodHeight, -length * 0.12, 0, frameZ + hoodHeight * 0.58]), materials.body, 'locomotive-hood');
  const cabLength = length * 0.24;
  const cabHeight = Math.max(height * 0.58, height - frameZ - height * 0.08);
  const cabX = length * 0.29;
  addMesh(group, boxGeometry([cabLength, width * 0.9, cabHeight, cabX, 0, frameZ + cabHeight * 0.52]), materials.body, 'locomotive-cab');
  addMesh(group, boxGeometry([cabLength * 0.78, width * 0.92, height * 0.07, cabX, 0, frameZ + cabHeight + height * 0.02]), materials.dark, 'locomotive-roof');
  const windowZ = frameZ + cabHeight * 0.7;
  const windows = [
    [cabLength * 0.48, 0.035, cabHeight * 0.24, cabX, width * 0.46, windowZ],
    [cabLength * 0.48, 0.035, cabHeight * 0.24, cabX, -width * 0.46, windowZ],
    [0.035, width * 0.54, cabHeight * 0.24, cabX + cabLength * 0.51, 0, windowZ],
  ];
  addMesh(group, mergedBoxes(windows), materials.glass, 'locomotive-windows', { castShadow: false });
  addCouplers(group, dimensions, materials.dark, frameZ);
}

function tankerWagon(group, dimensions, materials, { wheels = true } = {}) {
  const { length, width, height } = dimensions;
  const wheelRadius = wheels ? addWheelsets(group, dimensions, materials.dark, 2) : 0;
  const frameZ = wheels ? wheelRadius * 1.65 : Math.max(0.08, height * 0.06);
  if (wheels) {
    addMesh(group, boxGeometry([length, width * 0.82, height * 0.08, 0, 0, frameZ]), materials.metal, 'tanker-frame');
    addCouplers(group, dimensions, materials.dark, frameZ);
  }
  const radius = Math.max(0.18, Math.min(width * 0.43, (height - frameZ) * 0.4));
  const cylinder = new THREE.CylinderGeometry(radius, radius, length * 0.9, 18, 2, false);
  cylinder.rotateZ(Math.PI / 2);
  cylinder.translate(0, 0, frameZ + radius);
  addMesh(group, cylinder, materials.body, wheels ? 'tanker-vessel' : 'storage-vessel');
  const bands = [];
  for (const x of [-length * 0.28, 0, length * 0.28]) {
    const ring = new THREE.TorusGeometry(radius * 1.01, Math.max(0.025, radius * 0.035), 6, 16);
    ring.rotateY(Math.PI / 2);
    ring.translate(x, 0, frameZ + radius);
    bands.push(ring);
  }
  const merged = mergeGeometries(bands, false);
  for (const band of bands) band.dispose();
  addMesh(group, merged, materials.dark, 'tanker-bands');
  const hatch = new THREE.CylinderGeometry(radius * 0.16, radius * 0.16, radius * 0.18, 10);
  hatch.rotateX(Math.PI / 2);
  hatch.translate(0, 0, frameZ + radius * 2.04);
  addMesh(group, hatch, materials.metal, 'tanker-hatch');
}

function roadTrailer(group, dimensions, materials) {
  const { length, width, height } = dimensions;
  const wheelRadius = addWheelsets(group, dimensions, materials.dark, 2);
  const frameZ = wheelRadius * 1.65;
  addMesh(group, boxGeometry([length * 0.96, width * 0.86, height * 0.07, 0, 0, frameZ]), materials.metal, 'trailer-frame');
  const bodyHeight = Math.max(height * 0.52, height - frameZ - height * 0.13);
  addMesh(group, boxGeometry([
    length * 0.84, width * 0.94, bodyHeight,
    -length * 0.035, 0, frameZ + bodyHeight * 0.53,
  ]), materials.body, 'trailer-cargo-body');
  const rearX = -length * 0.455;
  const door = [
    [0.045, width * 0.88, 0.07, rearX, 0, frameZ + bodyHeight * 0.18],
    [0.045, width * 0.88, 0.07, rearX, 0, frameZ + bodyHeight * 0.83],
    [0.045, 0.06, bodyHeight * 0.82, rearX, 0, frameZ + bodyHeight * 0.52],
  ];
  addMesh(group, mergedBoxes(door), materials.dark, 'trailer-rear-doors');
  const legs = [[0.045, width * 0.34, frameZ, length * 0.35, 0, frameZ / 2]];
  addMesh(group, mergedBoxes(legs), materials.dark, 'trailer-landing-gear');
}

function craneTruck(group, dimensions, materials) {
  const { length, width, height } = dimensions;
  const wheelRadius = addWheelsets(group, dimensions, materials.dark, 2);
  const frameZ = wheelRadius * 1.65;
  addMesh(group, boxGeometry([length * 0.94, width * 0.84, height * 0.08, 0, 0, frameZ]), materials.metal, 'truck-frame');
  const cabH = height * 0.52;
  addMesh(group, boxGeometry([length * 0.27, width * 0.92, cabH, length * 0.31, 0, frameZ + cabH * 0.53]), materials.body, 'truck-cab');
  addMesh(group, boxGeometry([0.035, width * 0.56, cabH * 0.26, length * 0.455, 0, frameZ + cabH * 0.69]), materials.glass, 'truck-windshield', { castShadow: false });
  addMesh(group, boxGeometry([length * 0.53, width * 0.9, height * 0.09, -length * 0.15, 0, frameZ + height * 0.1]), materials.body, 'truck-bed');
  const mastX = -length * 0.18;
  addMesh(group, boxGeometry([length * 0.08, width * 0.18, height * 0.48, mastX, 0, frameZ + height * 0.34]), materials.metal, 'truck-crane-mast');
  addMesh(group, boxGeometry([length * 0.48, width * 0.12, height * 0.11, -length * 0.05, 0, frameZ + height * 0.59]), materials.body, 'truck-crane-boom');
}

function yardCrane(group, dimensions, materials) {
  const { length, width, height } = dimensions;
  const mastX = -length * 0.35;
  addMesh(group, boxGeometry([length * 0.18, width * 0.92, height * 0.1, mastX, 0, height * 0.05]), materials.metal, 'crane-base');
  addMesh(group, boxGeometry([length * 0.055, width * 0.34, height * 0.68, mastX, 0, height * 0.39]), materials.body, 'crane-mast');
  const boomLength = length * 0.82;
  const boomX = length * 0.055;
  const chord = Math.max(0.06, height * 0.035);
  const boomZ = height * 0.74;
  addMesh(group, mergedBoxes([
    [boomLength, width * 0.12, chord, boomX, 0, boomZ - height * 0.09],
    [boomLength, width * 0.12, chord, boomX, 0, boomZ + height * 0.09],
  ]), materials.body, 'crane-boom-chords');
  const braces = [];
  for (let index = 0; index < 8; index++) {
    const x = boomX - boomLength / 2 + boomLength * (index + 0.5) / 8;
    braces.push([chord, width * 0.16, height * 0.2, x, 0, boomZ]);
  }
  addMesh(group, mergedBoxes(braces), materials.dark, 'crane-boom-lattice');
  addMesh(group, boxGeometry([length * 0.12, width * 0.72, height * 0.17, mastX - length * 0.04, 0, height * 0.62]), materials.body, 'crane-cab');
  addMesh(group, boxGeometry([chord, chord, height * 0.4, length * 0.44, 0, height * 0.49]), materials.dark, 'crane-hook-line');
  addMesh(group, boxGeometry([length * 0.035, width * 0.16, height * 0.07, length * 0.44, 0, height * 0.27]), materials.metal, 'crane-hook');
}

/** Build one local metric prototype. Position/yaw and interaction metadata belong to the caller. */
export function buildPropAsset(prop, materialForRole) {
  const kind = propAssetKind(prop);
  const dimensions = propDimensions(prop);
  const group = new THREE.Group();
  group.name = `prop-asset:${kind}`;
  group.userData.assetKind = kind;
  group.userData.dimensions = dimensions;
  const materials = Object.fromEntries(['body', 'dark', 'metal', 'glass'].map((role) => [
    role, roleMaterial(materialForRole, role, prop),
  ]));

  if (kind === 'shipping-container') shippingContainer(group, dimensions, materials);
  else if (kind === 'locomotive') locomotive(group, dimensions, materials);
  else if (kind === 'freight-wagon') freightWagon(group, dimensions, materials);
  else if (kind === 'tanker-wagon') tankerWagon(group, dimensions, materials);
  else if (kind === 'storage-tank') tankerWagon(group, dimensions, materials, { wheels: false });
  else if (kind === 'road-trailer') roadTrailer(group, dimensions, materials);
  else if (kind === 'crane-truck') craneTruck(group, dimensions, materials);
  else if (kind === 'yard-crane') yardCrane(group, dimensions, materials);
  else if (kind === 'road-vehicle') craneTruck(group, dimensions, materials);
  else addMesh(group, boxGeometry([dimensions.length, dimensions.width, dimensions.height, 0, 0, dimensions.height / 2]), materials.body, 'generic-prop');

  return group;
}

/** Original metric fallback for unfinished multi-storey concrete/steel landmarks. */
export function buildOpenFrameBuildingAsset({ length, width, height }, material) {
  const safeLength = Math.max(4, finite(length, 12));
  const safeWidth = Math.max(4, finite(width, 8));
  const safeHeight = Math.max(3, finite(height, 6));
  const frameMaterial = material ?? new THREE.MeshStandardMaterial({ color: 0x777972, roughness: 0.86, metalness: 0.08 });
  const group = new THREE.Group();
  group.name = 'open-frame-building';
  const post = clamp(Math.min(safeLength, safeWidth) * 0.035, 0.28, 0.46);
  const beam = clamp(post * 0.82, 0.22, 0.38);
  const xCount = clamp(Math.round(safeLength / 8) + 1, 5, 10);
  const xRows = Array.from({ length: xCount }, (_, index) => -safeLength / 2 + post / 2
    + (safeLength - post) * index / (xCount - 1));
  const yRows = safeWidth > 11
    ? [-safeWidth / 2 + post / 2, 0, safeWidth / 2 - post / 2]
    : [-safeWidth / 2 + post / 2, safeWidth / 2 - post / 2];
  const levelCount = clamp(Math.round(safeHeight / 3.15), 2, 4);
  const levels = Array.from({ length: levelCount }, (_, index) => safeHeight * (index + 1) / levelCount);
  const boxes = [];
  for (const x of xRows) for (const y of yRows) boxes.push([post, post, safeHeight, x, y, safeHeight / 2]);
  for (const z of levels) {
    const beamZ = Math.min(safeHeight - beam / 2, z - beam / 2);
    for (const y of yRows) boxes.push([safeLength, beam, beam, 0, y, beamZ]);
    for (const x of xRows) boxes.push([beam, safeWidth, beam, x, 0, beamZ]);
    if (z < safeHeight - 0.2) boxes.push([safeLength * 0.985, safeWidth * 0.985, 0.13, 0, 0, z - 0.13]);
  }
  const mesh = addMesh(group, mergedBoxes(boxes), frameMaterial, 'open-frame-structure');
  mesh.userData.assetKind = 'open-frame-building';
  return group;
}
