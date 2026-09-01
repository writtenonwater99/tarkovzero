/**
 * Localhost-only Three.js renderer proof for Customs.
 *
 * This deliberately consumes the same canonical JSON and callback surface as map3d.js. It proves
 * that TarkovZero can replace only its 3D presentation layer without rewriting live tracking,
 * quests, filters, floors, coordinates, camera hand-off, or the 2D map. Current procedural meshes
 * remain visibly labelled provisional; audited GLB/KTX2 chunks can replace them through the scene
 * manifest without moving their stable EFT-space anchors.
 */
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CAM, clampCamera } from './camera.js';
import { placeBuildings } from './buildings.js';
import {
  CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME,
  sampleCustomsTerrainElevation,
} from './customs-local-terrain.js';
import { loadCustomsLocalTerrainPackage } from './customs-local-terrain-loader.js';
import { compileCustomsLocalTerrainMesh } from './customs-local-terrain-mesh.js';
import { loadCustomsLocalVegetation } from './customs-local-vegetation.js';
import { buildCustomsLocalVegetationRenderPlan } from './customs-local-vegetation-render.js';
import {
  customsTerrainSurfaceCanvas,
  decodeCustomsTerrainControlPng,
} from './customs-terrain-surface.js';
import { buildCustomsTerrainControlAtlases } from './customs-terrain-control-atlas.js';
import { createCustomsTerrainPbrRuntime } from './customs-terrain-pbr-runtime.js';
import { normalizeCustomsAssetManifest } from './customs-asset-manifest.js';
import {
  applyCustomsAssetPlan,
  createCustomsAssetCache,
  createCustomsAssetLoaderHost,
  createThreeLoaderFactory,
  loadVerifiedCustomsGlb,
} from './customs-asset-loader.js';
import {
  createCustomsAssetAttachmentLedger,
  createCustomsAssetRegistry,
  customsAssetLinearMatrix,
  customsAssetVisibleForFloor,
  diffCustomsAssetPlan,
  planCustomsAssetFrame,
  resolveProceduralSuppression,
} from './customs-asset-runtime.js';
import { assertLocalThree } from './local-renderer-gate.js';
import { createFloorSurfaceResolver, measuredSurfaceY, visibleBuildingHeight } from './surfaces.js';
import { buildTerrain, gameToTerrainTextureUv } from './terrain.js';
import { buildOpenFrameBuildingAsset, buildPropAsset } from './three-prop-assets.js';
import {
  RAILWAY_TRACK_PROFILE, THREE_POC_SCOPE, UNDERSTORY_TUFT_BUDGET, buildUnderstoryTuftPlan, cameraPose, centroid,
  createAsyncAttachGuard, disposeMaterialResources, drapedLinearSegmentMeshData, gameToWorld,
  grassTuftMeshData, inRing, makeTerrainSampler,
  markerOverlaySpec, parseThreeFx, pointPropPose, questZoneSpec, reconcileOrbitView, seatOverlayAnchor,
  railwayTrackMeshData, terrainMeshData, updateThreeFx, visibleForFloor, withinScope,
  terrainRelativeDisplayY, visibleInteractionData,
} from './three-world.js';

const POC_MANIFEST = '/assets/3d/customs/scene-manifest.json';
const MATERIAL_URLS = {
  albedo: '/assets/3d/materials/ground106-albedo-512.png',
  normal: '/assets/3d/materials/ground106-normal-512.png',
  orm: '/assets/3d/materials/ground106-orm-512.png',
};
const THREE_FIXED_RELIEF = 2;
const CUSTOMS_EXACT_TERRAIN_DECIMATION = 1;
const VALID_LOOK = new Set(['realistic', 'vector']);
const TACTICAL_PROP_CALLOUTS = Object.freeze([
  Object.freeze({ featureId: 'customs.prop.industrial_rail_yard.red_container_stack', label: 'RED CONTAINER' }),
  Object.freeze({ featureId: 'customs.prop.industrial_rail_yard.locomotive_west', label: 'TRAIN' }),
]);
const rgb = (value, fallback = [128, 128, 128]) => {
  const c = Array.isArray(value) ? value : fallback;
  return new THREE.Color().setRGB(
    (c[0] || 0) / 255,
    (c[1] || 0) / 255,
    (c[2] || 0) / 255,
    THREE.SRGBColorSpace,
  );
};
const safeText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

export function customsExactTerrainSurfaceStatus({
  hasExactTerrain,
  pbrAvailable,
  paletteAvailable,
  look = 'realistic',
  detail = true,
} = {}) {
  if (!hasExactTerrain) return Object.freeze({ available: 'legacy-fallback', active: 'legacy-fallback' });
  const available = pbrAvailable
    ? 'exact-control-mask-12-layer-original-pbr'
    : paletteAvailable ? 'exact-control-mask-original-palette' : 'neutral-fallback';
  const active = look !== 'realistic'
    ? 'vector-flat'
    : detail === false ? 'detail-off-flat' : available;
  return Object.freeze({ available, active });
}

function disposeTree(root, { materials = false } = {}) {
  const disposed = { textures: new Set(), materials: new Set() };
  root.traverse?.((node) => {
    node.geometry?.dispose?.();
    if (materials) disposeMaterialResources(node.material, disposed);
  });
  root.clear();
}

function shapeFromRing(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const shape = new THREE.Shape();
  ring.forEach(([x, z], index) => {
    const [wx, wy] = gameToWorld(x, z);
    if (index === 0) shape.moveTo(wx, wy); else shape.lineTo(wx, wy);
  });
  shape.closePath();
  return shape;
}

function dominantFootprintFrame(poly) {
  if (!Array.isArray(poly) || poly.length < 3) return null;
  let edge = null;
  for (let index = 0; index < poly.length; index++) {
    const a = poly[index], b = poly[(index + 1) % poly.length];
    const dx = b[0] - a[0], dz = b[1] - a[1], length = Math.hypot(dx, dz);
    if (!edge || length > edge.length) edge = { dx, dz, length };
  }
  if (!edge || !(edge.length > 0.1)) return null;
  let twiceArea = 0;
  for (let index = 0; index < poly.length; index++) {
    const a = poly[index], b = poly[(index + 1) % poly.length];
    twiceArea += a[0] * b[1] - b[0] * a[1];
  }
  return {
    center: centroid(poly),
    length: edge.length,
    width: Math.max(1, Math.abs(twiceArea) / 2 / edge.length),
    yaw: Math.atan2(edge.dz, edge.dx),
  };
}

function ribbonGeometry(path, width, H, lift = 0.05) {
  const points = (path || []).filter((p, i, all) => Array.isArray(p) && p.length >= 2
    && (i === 0 || Math.hypot(p[0] - all[i - 1][0], p[1] - all[i - 1][1]) > 1e-4));
  if (points.length < 2) return null;
  const positions = [], uvs = [], indices = [];
  let distance = 0;
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)], next = points[Math.min(points.length - 1, i + 1)];
    const dx = next[0] - prev[0], dz = next[1] - prev[1], len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len, nz = dx / len;
    if (i) distance += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    for (const side of [-1, 1]) {
      const x = points[i][0] + nx * width * side / 2;
      const z = points[i][1] + nz * width * side / 2;
      positions.push(...gameToWorld(x, z, H(x, z) + lift));
      uvs.push(distance / 12, side < 0 ? 0 : 1);
    }
    if (i) {
      const a = (i - 1) * 2, b = a + 1, c = i * 2, d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function lineGeometry(path, H, lift = 0.2) {
  const points = (path || []).filter((p) => Array.isArray(p) && p.length >= 2)
    .map(([x, z]) => new THREE.Vector3(...gameToWorld(x, z, H(x, z) + lift)));
  return points.length >= 2 ? new THREE.BufferGeometry().setFromPoints(points) : null;
}

function outlineFor(mesh, material) {
  const edges = new THREE.EdgesGeometry(mesh.geometry, 28);
  const line = new THREE.LineSegments(edges, material);
  line.renderOrder = 2;
  mesh.add(line);
}

async function loadTexture(url, { color = false } = {}) {
  try {
    const texture = await new THREE.TextureLoader().loadAsync(url);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 4;
    if (color) texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  } catch (error) {
    console.warn(`[three-poc] texture unavailable: ${url}`, error);
    return null;
  }
}

function canvasGroundTexture(canvas, mapping) {
  if (!canvas) return null;
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'customs-semantic-ground-atlas';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 8;
  texture.flipY = mapping?.threeCanvasTextureFlipY !== false;
  texture.needsUpdate = true;
  return texture;
}

function exactTerrainScope(limit, manifest) {
  const points = Array.isArray(limit) ? limit.filter((point) => Array.isArray(point)
    && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]))) : [];
  if (points.length < 3) throw new Error('Customs playable limit is unavailable');
  const tiles = manifest?.tiles ?? [];
  const coverage = {
    minX: Math.min(...tiles.map((tile) => tile.origin.x)),
    maxX: Math.max(...tiles.map((tile) => tile.origin.x
      + (tile.resolution.columns - 1) * tile.sampleSpacingM.x)),
    minZ: Math.min(...tiles.map((tile) => tile.origin.z)),
    maxZ: Math.max(...tiles.map((tile) => tile.origin.z
      + (tile.resolution.rows - 1) * tile.sampleSpacingM.z)),
  };
  const xs = points.map((point) => Number(point[0]));
  const zs = points.map((point) => Number(point[1]));
  return {
    sourceFrame: CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME,
    minX: Math.max(coverage.minX, Math.min(...xs)),
    maxX: Math.min(coverage.maxX, Math.max(...xs)),
    minZ: Math.max(coverage.minZ, Math.min(...zs)),
    maxZ: Math.min(coverage.maxZ, Math.max(...zs)),
  };
}

function exactTerrainSampler(localPackage, fallback, elevationField = 'displayYM') {
  if (!localPackage?.runtime) return fallback;
  const bounds = localPackage.manifest.tiles.map((tile) => ({
    minX: tile.origin.x,
    maxX: tile.origin.x + (tile.resolution.columns - 1) * tile.sampleSpacingM.x,
    minZ: tile.origin.z,
    maxZ: tile.origin.z + (tile.resolution.rows - 1) * tile.sampleSpacingM.z,
  }));
  return (xValue, zValue) => {
    const x = Number(xValue), z = Number(zValue);
    if (!Number.isFinite(x) || !Number.isFinite(z)
      || !bounds.some((box) => x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ)) {
      return fallback(x, z);
    }
    return sampleCustomsTerrainElevation(localPackage.runtime, {
      sourceFrame: CUSTOMS_LOCAL_TERRAIN_SOURCE_FRAME,
      x,
      z,
    })[elevationField];
  };
}

async function loadLocalControlPixels(url, signal) {
  const response = await fetch(url, {
    method: 'GET', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store',
    redirect: 'error', signal,
  });
  if (!response.ok) throw new Error(`control map HTTP ${response.status}`);
  return decodeCustomsTerrainControlPng(await response.arrayBuffer());
}

async function loadExactTerrainSurfaceAssets(localPackage, signal) {
  if (!localPackage) return { createFallbackCanvases: null, controlAtlasSet: null };
  const tiles = await Promise.all(localPackage.assets.map(async (asset) => {
    const tile = localPackage.manifest.tiles.find((candidate) => candidate.id === asset.tileId);
    if (!tile) throw new Error(`missing exact terrain tile ${asset.tileId}`);
    const controls = await Promise.all(asset.controlMaps.map(async (control, slot) => ({
      id: control.id,
      slot,
      ...await loadLocalControlPixels(control.url, signal),
    })));
    const maxX = tile.origin.x + (tile.resolution.columns - 1) * tile.sampleSpacingM.x;
    const maxZ = tile.origin.z + (tile.resolution.rows - 1) * tile.sampleSpacingM.z;
    return {
      id: asset.tileId,
      origin: { x: tile.origin.x, z: tile.origin.z },
      bounds: { minX: tile.origin.x, maxX, minZ: tile.origin.z, maxZ },
      controls,
      layers: tile.layers,
    };
  }));
  return {
    controlAtlasSet: buildCustomsTerrainControlAtlases({
      tiles: tiles.map(({ layers: _layers, ...tile }) => tile),
    }),
    createFallbackCanvases: () => new Map(tiles.map((tile) => [
      tile.id,
      customsTerrainSurfaceCanvas(tile.controls, tile.layers),
    ])),
  };
}

function exactSurfaceTexture(canvas, tileId) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = `customs-exact-surface:${tileId}`;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 8;
  // PNG/canvas row zero is z-min and control UV-v zero is z-min. Do not apply
  // Three's usual display-image flip; this is a geospatial raster, not a photo.
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

function detailUvsForExactPatch(patch) {
  const detailUvs = new Float32Array(patch.vertexCount * 2);
  for (let index = 0; index < patch.vertexCount; index++) {
    detailUvs[index * 2] = -patch.positions[index * 3] / 32;
    detailUvs[index * 2 + 1] = -patch.positions[index * 3 + 1] / 32;
  }
  return detailUvs;
}

function smoothExactTerrainSeamNormals(meshes) {
  const byPosition = new Map();
  for (const mesh of meshes) {
    const positions = mesh.geometry.getAttribute('position');
    const normals = mesh.geometry.getAttribute('normal');
    for (let index = 0; index < positions.count; index++) {
      const key = `${positions.getX(index).toFixed(5)}|${positions.getY(index).toFixed(5)}|${positions.getZ(index).toFixed(5)}`;
      if (!byPosition.has(key)) byPosition.set(key, []);
      byPosition.get(key).push({ normals, index });
    }
  }
  for (const matches of byPosition.values()) {
    if (matches.length < 2) continue;
    const normal = new THREE.Vector3();
    for (const match of matches) {
      normal.x += match.normals.getX(match.index);
      normal.y += match.normals.getY(match.index);
      normal.z += match.normals.getZ(match.index);
    }
    normal.normalize();
    for (const match of matches) match.normals.setXYZ(match.index, normal.x, normal.y, normal.z);
  }
  for (const mesh of meshes) mesh.geometry.getAttribute('normal').needsUpdate = true;
}

function makeGroundcoverTextures(size = 128) {
  const texelCount = size * size;
  const height = new Float32Array(texelCount);
  const albedo = new Uint8Array(texelCount * 4);
  const normal = new Uint8Array(texelCount * 4);
  const hash2 = (x, y) => {
    let value = Math.imul(x + 17, 0x45d9f3b) ^ Math.imul(y + 31, 0x119de1f3);
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    return ((value ^ (value >>> 16)) >>> 0) / 0x100000000;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x, u = x / size, v = y / size;
      const macro = Math.sin(u * Math.PI * 4 + 0.6) * 0.5
        + Math.sin(v * Math.PI * 6 - 1.1) * 0.3
        + Math.sin((u + v) * Math.PI * 8) * 0.2;
      const grain = hash2(x, y) - 0.5;
      const straw = hash2(x + 211, y - 97) > 0.965 ? 1 : 0;
      height[i] = macro * 0.38 + grain * 0.62;
      albedo[i * 4] = Math.round(92 + macro * 12 + grain * 15 + straw * 42);
      albedo[i * 4 + 1] = Math.round(136 + macro * 18 + grain * 18 + straw * 15);
      albedo[i * 4 + 2] = Math.round(56 + macro * 8 + grain * 10 + straw * 10);
      albedo[i * 4 + 3] = 255;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sample = (sx, sy) => height[((sy + size) % size) * size + ((sx + size) % size)];
      const dx = (sample(x + 1, y) - sample(x - 1, y)) * 1.15;
      const dy = (sample(x, y + 1) - sample(x, y - 1)) * 1.15;
      const invLength = 1 / Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      normal[i] = Math.round((-dx * invLength * 0.5 + 0.5) * 255);
      normal[i + 1] = Math.round((-dy * invLength * 0.5 + 0.5) * 255);
      normal[i + 2] = Math.round((invLength * 0.5 + 0.5) * 255);
      normal[i + 3] = 255;
    }
  }
  const configure = (texture, { color = false } = {}) => {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = 4;
    if (color) texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  };
  return {
    albedo: configure(new THREE.DataTexture(albedo, size, size, THREE.RGBAFormat), { color: true }),
    normal: configure(new THREE.DataTexture(normal, size, size, THREE.RGBAFormat)),
  };
}

function grassTuftGeometry(blades, taperedQuad) {
  const { positions, uvs, indices } = grassTuftMeshData(blades, taperedQuad);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function exactVegetationInstancedMesh({
  geometry,
  material,
  placements,
  name,
  component,
  castShadow = false,
  transform,
}) {
  if (!placements.length) return null;
  const mesh = new THREE.InstancedMesh(geometry, material, placements.length);
  mesh.name = name;
  mesh.userData = {
    kind: 'exact-local-vegetation',
    component,
    source: 'terrain-tree-instance-scalars',
    placementAccuracy: 'canonical-game-authored',
    geometryAccuracy: 'original-procedural-class-proxy',
    instances: placements.length,
  };
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  placements.forEach((placement, index) => {
    dummy.position.set(...placement.presentationPosition);
    // `presentationPosition` is the reflected [-x, -z, y] world, so a positive Unity yaw about
    // +Y becomes a negative rotation about world +Z. Match the authored `Rz(-yaw)` convention and
    // the legacy tree/player fallbacks; a positive sign here mirrored every non-cardinal asset.
    dummy.rotation.set(0, 0, -placement.yawRadians);
    dummy.scale.set(1, 1, 1);
    transform(dummy, placement);
    dummy.updateMatrix();
    mesh.setMatrixAt(index, dummy.matrix);
    tint.setRGB(placement.tint.r, placement.tint.g, placement.tint.b);
    mesh.setColorAt(index, tint);
  });
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  mesh.computeBoundingSphere();
  return mesh;
}

/** Seat one authored instance in the runtime frame, then tag it for picking and floors. */
export function seatAuthoredInstance(scene, instance, { displayYFor }) {
  // A cached unique glTF scene can leave and re-enter the stream. Picking proxies are runtime
  // furniture, not authored nodes, so remove the previous seating's proxy before adding the
  // current one. Otherwise every re-entry would add another invisible geometry and the old
  // proxy's disabled raycast method would survive into the new seating.
  const stalePickingProxies = [];
  scene.traverse?.((node) => {
    if (node.userData?.kind === 'authored-picking-proxy') stalePickingProxies.push(node);
  });
  for (const proxy of stalePickingProxies) {
    proxy.removeFromParent?.();
    proxy.geometry?.dispose?.();
    if (Array.isArray(proxy.material)) proxy.material.forEach((material) => material?.dispose?.());
    else proxy.material?.dispose?.();
  }

  const { position } = instance.transform;
  const displayY = typeof displayYFor === 'function'
    ? displayYFor(position.x, position.z, position.y)
    : position.y;
  const [worldX, worldY, worldZ] = gameToWorld(position.x, position.z, displayY);
  // The exact EFT -> runtime change of basis has determinant -1. Preserve that reflection in
  // the complete affine matrix; a quaternion or setRotationFromMatrix would silently lose it
  // and place zero-yaw assets facing backward.
  const linear = customsAssetLinearMatrix(
    instance.gltf,
    instance.transform.rotation,
    instance.transform.scale,
  );
  scene.matrix.set(
    linear[0], linear[1], linear[2], worldX,
    linear[3], linear[4], linear[5], worldY,
    linear[6], linear[7], linear[8], worldZ,
    0, 0, 0, 1,
  );
  scene.matrixAutoUpdate = false;
  scene.matrixWorldNeedsUpdate = true;

  const castsAtThisLod = instance.shadow.lodLevel == null
    || instance.shadow.lodLevel === instance.lodLevel;
  const castShadow = castsAtThisLod
    && (instance.shadow.mode === 'cast' || instance.shadow.mode === 'both');
  const receiveShadow = instance.shadow.mode === 'receive' || instance.shadow.mode === 'both';
  scene.userData = {
    ...scene.userData,
    kind: 'authored-asset',
    label: safeText(instance.label ?? instance.stableId),
    stableId: instance.stableId,
    instanceId: instance.instanceId,
    featureId: instance.featureId,
    floor: instance.floor,
    interior: instance.interior,
    assetId: instance.assetId,
    lodLevel: instance.lodLevel,
    source: 'authored-manifest-v2',
  };
  scene.traverse((node) => {
    if (!node.isMesh) return;
    node.castShadow = castShadow;
    node.receiveShadow = receiveShadow;
    node.userData.stableId ||= instance.stableId;
    node.userData.floor ??= instance.floor;
    // A 120k-triangle mesh must not silently become the raycast target. Only assets that
    // declared `picking.shape: 'lod-mesh'` stay in the picking set; the rest are marked out of
    // it and the coarse proxy shape is the staged follow-up.
    node.userData.authoredOriginalRaycast ??= node.raycast;
    node.userData.pickable = instance.pickable
      && instance.picking.shape === 'lod-mesh'
      && instance.picking.lodLevel === instance.lodLevel;
    node.raycast = node.userData.pickable ? node.userData.authoredOriginalRaycast : () => {};
  });

  if (instance.pickable && (instance.picking.shape === 'box' || instance.picking.shape === 'sphere')) {
    const { centerM, sizeM } = instance.bounds;
    const inflate = instance.picking.inflateM;
    const geometry = instance.picking.shape === 'box'
      ? new THREE.BoxGeometry(sizeM.x + inflate * 2, sizeM.y + inflate * 2, sizeM.z + inflate * 2)
      : new THREE.SphereGeometry(Math.hypot(sizeM.x, sizeM.y, sizeM.z) / 2 + inflate, 12, 8);
    // `material.visible=false` keeps this out of the render pass while Three's Raycaster still
    // intersects it. `Object3D.visible=false` would also remove it from picking.
    const material = new THREE.MeshBasicMaterial({ visible: false, toneMapped: false });
    const proxy = new THREE.Mesh(geometry, material);
    proxy.name = `${instance.stableId}:picking-${instance.picking.shape}`;
    proxy.position.set(centerM.x, centerM.y, centerM.z);
    proxy.userData = {
      kind: 'authored-picking-proxy',
      label: safeText(instance.label ?? instance.stableId),
      stableId: instance.stableId,
      featureId: instance.featureId,
      pickable: true,
      collisionShape: instance.collision.shape,
    };
    scene.add(proxy);
  }
  return scene;
}

/** Convert the real Z-up runtime focus back to canonical EFT map coordinates. */
export function authoredCameraFromWorldTarget(target) {
  const worldX = Number(Array.isArray(target) ? target[0] : target?.x);
  const worldY = Number(Array.isArray(target) ? target[1] : target?.y);
  if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) {
    throw new Error('authored streaming requires a finite runtime camera target');
  }
  return { x: -worldX, z: -worldY };
}

/** Every failed ledger entry is status-visible exactly once, including host and attach errors. */
export function customsAssetLedgerFailureMessages(ledger) {
  return [...new Set(
    ledger.failedIds().sort().map((instanceId) => (
      `${instanceId}: ${ledger.errorOf(instanceId) ?? 'unknown error'}`
    )),
  )];
}

function clearAuthoredPickingProxies(node) {
  const proxies = [];
  node?.traverse?.((child) => {
    if (child.userData?.kind === 'authored-picking-proxy') proxies.push(child);
  });
  for (const proxy of proxies) {
    proxy.removeFromParent?.();
    proxy.geometry?.dispose?.();
    if (Array.isArray(proxy.material)) proxy.material.forEach((material) => material?.dispose?.());
    else proxy.material?.dispose?.();
  }
}

/**
 * Long-lived, camera-driven authored asset streamer.
 *
 * `update()` is intentionally cheap to call from every real camera change. While a pass is in
 * flight, new targets overwrite one pending slot; the drain performs the latest target next,
 * never overlaps loader passes, and preserves the previous plan so cell and LOD hysteresis work.
 * The loader host and decoded cache are injected view-lifetime resources and are not disposed
 * here. `dispose()` only aborts this controller; the owning view tears those shared resources
 * down exactly once.
 */
export function createAuthoredAssetStreamer({
  root,
  status,
  guard,
  signal = null,
  displayYFor,
  syncSuppression,
  loaderHost = null,
  cache = null,
  baseHref = globalThis.location?.href ?? 'http://localhost/',
  manifestInput = null,
  manifestUrl = POC_MANIFEST,
  fetchImpl = globalThis.fetch,
  loadAsset = null,
  instanceVisible = () => true,
  onChanged = () => {},
} = {}) {
  if (!root?.add || !root?.remove) throw new Error('authored streamer requires a scene root');
  if (!status || typeof status !== 'object') throw new Error('authored streamer requires status');
  if (!guard?.attach) throw new Error('authored streamer requires an attachment guard');

  const streamAbort = new AbortController();
  const controllerErrors = new Set();
  let manifest = null;
  let registry = null;
  let ledger = null;
  let currentPlan = null;
  let pendingCamera = null;
  let drainPromise = null;
  let disposed = false;
  let initializationError = null;

  const abortFromOwner = () => streamAbort.abort(signal?.reason);
  if (signal?.aborted) abortFromOwner();
  else signal?.addEventListener?.('abort', abortFromOwner, { once: true });

  function resetManifestStatus() {
    status.manifest = {
      version: manifest.schemaVersion,
      proceduralFallback: manifest.proceduralFallback,
      declared: manifest.totals.instances,
      cells: manifest.totals.cells,
      replacements: manifest.totals.replacements,
      loaded: 0,
      visibleCells: [],
      camera: null,
      suppressed: [],
      retained: [],
      errors: [],
    };
  }

  function fatalStatus(error) {
    if (disposed || error?.name === 'AbortError') return;
    const message = `${error?.code ? `${error.code} ` : ''}${error?.message ?? error}`;
    status.manifest = {
      version: null, proceduralFallback: true, declared: 0, cells: 0, replacements: 0,
      loaded: 0, visibleCells: [], camera: null, suppressed: [], retained: [],
      errors: [message],
    };
    onChanged();
  }

  function authoredNodeFor(instance) {
    return root.children.find((child) => (
      child.userData?.instanceId === instance.instanceId
      || child.userData?.stableId === instance.stableId
    ));
  }

  function detachInstance(instance) {
    // GLTF geometry and materials are cache-owned and may be shared by prototype clones. Only
    // runtime-created picking proxies are disposed here; the authored node is simply detached.
    const node = authoredNodeFor(instance);
    if (!node) return false;
    clearAuthoredPickingProxies(node);
    root.remove(node);
    onChanged();
    return true;
  }

  function publishState() {
    if (!registry || !ledger || disposed || !guard.active) return;
    const resolved = resolveProceduralSuppression(registry, ledger);
    let synchronized = { applied: [], retained: [] };
    try {
      synchronized = syncSuppression?.(resolved.suppressed) ?? synchronized;
    } catch (error) {
      controllerErrors.add(`suppression sync: ${error?.message ?? error}`);
      synchronized = {
        applied: [],
        retained: resolved.suppressed.map((entry) => ({
          featureId: entry.featureId,
          reason: `attached, but procedural suppression failed for ${entry.kind}`,
        })),
      };
    }
    const applied = new Set((synchronized.applied ?? []).map((entry) => (
      typeof entry === 'string' ? entry : entry.featureId
    )));
    const retained = [
      ...resolved.retained.map((entry) => ({ featureId: entry.featureId, reason: entry.reason })),
      ...(synchronized.retained ?? []),
      ...resolved.suppressed
        .filter((entry) => !applied.has(entry.featureId)
          && !(synchronized.retained ?? []).some((row) => row.featureId === entry.featureId))
        .map((entry) => ({
          featureId: entry.featureId,
          reason: `attached, but this renderer cannot retire a procedural ${entry.kind}`,
        })),
    ];
    const retainedKeys = new Set();
    status.manifest.loaded = ledger.attachedIds().length;
    status.manifest.visibleCells = [...(currentPlan?.visibleCellIds ?? [])];
    status.manifest.camera = currentPlan ? { ...currentPlan.camera } : null;
    status.manifest.suppressed = [...applied];
    status.manifest.retained = retained.filter((entry) => {
      const key = `${entry.featureId}|${entry.reason}`;
      if (retainedKeys.has(key)) return false;
      retainedKeys.add(key);
      return true;
    });
    status.manifest.errors = [...new Set([
      ...customsAssetLedgerFailureMessages(ledger),
      ...controllerErrors,
    ])];
    onChanged();
  }

  async function initialize() {
    try {
      if (manifestInput) manifest = normalizeCustomsAssetManifest(manifestInput);
      else {
        if (typeof fetchImpl !== 'function') throw new Error('manifest fetch is unavailable');
        const response = await fetchImpl(manifestUrl, {
          method: 'GET', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store',
          redirect: 'error', signal: streamAbort.signal,
        });
        if (!response.ok) throw new Error(`manifest HTTP ${response.status}`);
        manifest = normalizeCustomsAssetManifest(await response.json());
      }
      if (disposed || !guard.active || streamAbort.signal.aborted) return;
      registry = createCustomsAssetRegistry(manifest);
      ledger = createCustomsAssetAttachmentLedger();
      resetManifestStatus();
      publishState();
    } catch (error) {
      initializationError = error;
      fatalStatus(error);
    }
  }

  const ready = initialize();

  async function defaultLoadAsset(url, { request, signal: requestSignal }) {
    if (!loaderHost) throw new Error('authored loader host is unavailable');
    const { gltf } = await loaderHost.acquire();
    return loadVerifiedCustomsGlb({
      url,
      request,
      signal: requestSignal,
      parse: (bytes, gltfBaseUrl) => gltf.parseAsync(bytes, gltfBaseUrl),
    });
  }

  async function runPass(camera) {
    const nextPlan = planCustomsAssetFrame({
      registry,
      camera,
      previous: currentPlan,
      ledger,
    });
    const diff = diffCustomsAssetPlan(currentPlan, nextPlan);
    const entering = [...diff.enter, ...diff.relod];

    // A stale authored LOD must not overlap the replacement load. Restore the procedural proxy
    // before the first await, detach leaves/re-LODs, then let the ledger gate re-suppress only
    // after the replacement really attaches.
    for (const instance of [...diff.leave, ...diff.relod]) {
      detachInstance(instance);
      ledger.markDetached(instance.instanceId);
    }
    for (const instance of entering) ledger.markLoading(instance.instanceId);
    currentPlan = nextPlan;
    publishState();

    if (entering.length === 0 && diff.leave.length === 0) return;
    try {
      await applyCustomsAssetPlan({
        plan: nextPlan,
        manifest,
        ledger,
        loaderHost,
        cache,
        baseHref,
        signal: streamAbort.signal,
        // Leaves were detached synchronously above so fallback restoration is never delayed by
        // a loader await. `applyCustomsAssetPlan` still owns the entering/relod load lifecycle.
        diff: { enter: diff.enter, relod: diff.relod, leave: [] },
        load: loadAsset ?? defaultLoadAsset,
        attach(instance, gltf) {
          if (!gltf?.scene) throw new Error('decoded GLB has no scene');
          // Prototypes are placed more than once from one cached glTF, so each placement needs
          // its own node; geometry and materials remain cache-owned and shared.
          const node = registry.assetsById.get(instance.assetId).kind === 'prototype'
            ? gltf.scene.clone(true)
            : gltf.scene;
          detachInstance(instance);
          const seated = seatAuthoredInstance(node, instance, { displayYFor });
          seated.visible = instanceVisible(instance);
          try {
            const attached = guard.attach(seated, (resource) => root.add(resource));
            if (!attached) throw new Error('view torn down before attach');
          } catch (error) {
            // An attachment hook may fail after mutating the graph. Roll that partial mutation
            // back before the ledger marks failure, so restoring the proxy cannot leave an
            // untracked authored double in the same place.
            if (seated.parent === root) root.remove(seated);
            clearAuthoredPickingProxies(seated);
            throw error;
          }
          onChanged();
        },
        detach: detachInstance,
      });
    } catch (error) {
      for (const instance of entering) {
        if (ledger.stateOf(instance.instanceId) === 'loading') {
          ledger.markFailed(instance.instanceId, error);
        }
      }
      if (entering.length === 0) controllerErrors.add(error?.message ?? String(error));
    } finally {
      if (!disposed && guard.active) publishState();
    }
  }

  async function drain(resolveIdle) {
    try {
      await ready;
      if (initializationError || !registry) return;
      while (!disposed && guard.active && !streamAbort.signal.aborted && pendingCamera) {
        const camera = pendingCamera;
        pendingCamera = null;
        await runPass(camera);
      }
    } catch (error) {
      if (disposed || error?.name === 'AbortError') return;
      controllerErrors.add(`stream pass: ${error?.message ?? error}`);
      if (registry && ledger) publishState();
      else fatalStatus(error);
    } finally {
      // Clear the shared idle promise in the same async continuation that observed an empty
      // pending slot. There is no promise-reaction gap where update() could enqueue work yet
      // receive a promise that settles before that work runs.
      drainPromise = null;
      resolveIdle();
      if (!disposed && pendingCamera) update(pendingCamera);
    }
  }

  function update(camera) {
    if (disposed || streamAbort.signal.aborted) return Promise.resolve(false);
    const x = Number(camera?.x), z = Number(camera?.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      return Promise.reject(new Error('authored streamer update requires finite camera {x, z}'));
    }
    pendingCamera = { x, z };
    if (!drainPromise) {
      let resolveIdle;
      drainPromise = new Promise((resolve) => { resolveIdle = resolve; });
      void drain(resolveIdle);
    }
    return drainPromise;
  }

  return {
    get manifest() { return manifest; },
    get registry() { return registry; },
    get ledger() { return ledger; },
    get currentPlan() { return currentPlan; },
    get active() { return !disposed && !streamAbort.signal.aborted; },
    ready,
    update,
    dispose() {
      if (disposed) return;
      disposed = true;
      pendingCamera = null;
      signal?.removeEventListener?.('abort', abortFromOwner);
      streamAbort.abort();
      try { syncSuppression?.([]); } catch { /* view teardown remains best effort */ }
    },
  };
}

export async function createView3d(container, mapData, src) {
  assertLocalThree({
    dev: import.meta.env?.DEV === true,
    hostname: location.hostname,
    mapKey: mapData.key,
    rendererRequest: new URLSearchParams(location.search).get('renderer'),
  });
  const bootAt = performance.now();
  const localTerrainAbort = new AbortController();
  const localTerrainRequest = loadCustomsLocalTerrainPackage({ signal: localTerrainAbort.signal })
    .then((value) => ({ value, error: null }))
    .catch((error) => ({ value: null, error }));
  const response = await fetch('/data/customs-3d.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Customs 3D data HTTP ${response.status}`);
  const data = await response.json();
  const localTerrainOutcome = await localTerrainRequest;
  let exactTerrainPackage = localTerrainOutcome.value;
  let exactTerrainMesh = null;
  let exactTerrainError = localTerrainOutcome.error;
  if (exactTerrainPackage) {
    try {
      exactTerrainMesh = compileCustomsLocalTerrainMesh(
        exactTerrainPackage.runtime,
        exactTerrainScope(data.limit, exactTerrainPackage.manifest),
        { decimation: CUSTOMS_EXACT_TERRAIN_DECIMATION },
      );
    } catch (error) {
      exactTerrainError = error;
      exactTerrainPackage = null;
      exactTerrainMesh = null;
    }
  }
  let exactVegetation = null;
  let exactVegetationPlan = null;
  let exactVegetationError = null;
  if (exactTerrainPackage && exactTerrainMesh) {
    try {
      exactVegetation = await loadCustomsLocalVegetation(exactTerrainPackage, {
        signal: localTerrainAbort.signal,
      });
      exactVegetationPlan = buildCustomsLocalVegetationRenderPlan(exactVegetation, {
        scope: exactTerrainMesh.scope,
        reliefOriginYM: exactTerrainPackage.manifest.reliefOriginYM,
      });
    } catch (error) {
      exactVegetationError = error;
      console.warn('[three-poc] exact local Customs vegetation unavailable; retaining reviewed fallback vegetation', error);
    }
  }
  if (exactTerrainError) {
    console.info('[three-poc] exact local Customs terrain unavailable; using complete legacy terrain', exactTerrainError);
  }

  container.replaceChildren();
  container.classList.add('three-poc');
  const forceWebGL = new URLSearchParams(location.search).get('threeBackend') === 'webgl2';
  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.93;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
  try { renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; } catch {}
  await renderer.init();
  renderer.domElement.className = 'tz-three-canvas';
  renderer.domElement.setAttribute('aria-label', 'Three.js Customs renderer proof');
  container.append(renderer.domElement);

  const overlay = document.createElement('div');
  overlay.className = 'tz-three-overlay';
  const proofChip = document.createElement('div');
  proofChip.className = 'tz-three-proof-chip';
  proofChip.innerHTML = exactTerrainMesh
    ? `<b>CUSTOMS TRUTH</b><span>EXACT LOCAL TERRAIN · 12-LAYER SURFACE MASKS${exactVegetationPlan ? ` · ${exactVegetationPlan.renderedCount.toLocaleString()} AUTHORED VEGETATION` : ''} · FIXED RELIEF 2×</span>`
    : '<b>THREE POC</b><span>LEGACY TERRAIN FALLBACK · LOCALHOST · FIXED RELIEF 2×</span>';
  overlay.append(proofChip);
  const hoverChip = document.createElement('div');
  hoverChip.className = 'tz-three-hover';
  hoverChip.hidden = true;
  overlay.append(hoverChip);
  container.append(overlay);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CAM.fovy, 1, 0.25, 6000);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.screenSpacePanning = true;
  controls.zoomToCursor = true;
  controls.minPolarAngle = (90 - CAM.maxRotationX) * Math.PI / 180;
  controls.maxPolarAngle = (90 - CAM.minRotationX) * Math.PI / 180;

  const hemi = new THREE.HemisphereLight(0xcbd7d8, 0x727469, 2.05);
  const ambient = new THREE.AmbientLight(0x8a958d, 0.24);
  scene.add(hemi, ambient);
  const sun = new THREE.DirectionalLight(0xffedd0, 2.65);
  sun.position.set(-240, 340, 430);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -260;
  sun.shadow.camera.right = sun.shadow.camera.top = 260;
  sun.shadow.camera.near = 20;
  sun.shadow.camera.far = 1100;
  sun.shadow.bias = -0.00012;
  sun.shadow.normalBias = 0.025;
  sun.shadow.radius = 2.2;
  sun.target.position.set(...gameToWorld(THREE_POC_SCOPE.center.x, THREE_POC_SCOPE.center.z, 0));
  scene.add(sun, sun.target);

  const worldRoot = new THREE.Group();
  worldRoot.name = exactTerrainMesh ? 'customs-exact-local-world' : 'customs-procedural-fallback';
  const authoredRoot = new THREE.Group();
  authoredRoot.name = 'customs-authored-chunks';
  const dynamicRoot = new THREE.Group();
  dynamicRoot.name = 'customs-live-and-quests';
  scene.add(worldRoot, authoredRoot, dynamicRoot);
  const authoredAbort = new AbortController();
  const authoredGuard = createAsyncAttachGuard((lateScene) => disposeTree(lateScene, { materials: true }));
  const authoredLoaderHost = createCustomsAssetLoaderHost(createThreeLoaderFactory({ renderer }));
  const authoredAssetCache = createCustomsAssetCache();

  let groundBake = null, groundTextureMapping = null, groundCanvas = null;
  if (!exactTerrainMesh) {
    try {
      groundBake = buildTerrain(data, THREE_FIXED_RELIEF, { look: 'realistic' });
      groundTextureMapping = groundBake.groundTextureMapping;
      groundCanvas = groundBake.groundTexture('realistic');
    } catch (error) {
      groundBake = null;
      groundTextureMapping = null;
      groundCanvas = null;
      console.warn('[three-poc] semantic ground atlas unavailable; retaining the tileable fallback', error);
    }
  }
  let exactSurfaceCanvases = new Map(), exactSurfaceCanvasFactory = null;
  let exactControlAtlasSet = null, exactSurfaceError = null;
  if (exactTerrainMesh) {
    try {
      const exactSurfaceAssets = await loadExactTerrainSurfaceAssets(
        exactTerrainPackage,
        localTerrainAbort.signal,
      );
      exactSurfaceCanvasFactory = exactSurfaceAssets.createFallbackCanvases;
      exactControlAtlasSet = exactSurfaceAssets.controlAtlasSet;
    } catch (error) {
      exactSurfaceError = error;
      exactSurfaceCanvasFactory = null;
      exactControlAtlasSet = null;
      console.warn('[three-poc] exact control surfaces unavailable; retaining exact geometry with a neutral material', error);
    }
  }
  let exactTerrainPbrRuntime = null, exactTerrainPbrError = null;
  let exactTerrainMaterials = new Map();
  if (exactControlAtlasSet) {
    let candidateRuntime = null;
    try {
      candidateRuntime = await createCustomsTerrainPbrRuntime({
        controlAtlasSet: exactControlAtlasSet,
        renderer,
        signal: localTerrainAbort.signal,
      });
      if (localTerrainAbort.signal.aborted) {
        candidateRuntime.dispose();
        candidateRuntime = null;
        const abortError = new Error('terrain PBR initialization was aborted');
        abortError.name = 'AbortError';
        throw abortError;
      }
      const candidateMaterials = new Map(exactTerrainMesh.patches.map((patch) => [
        patch.tileId,
        candidateRuntime.createTileMaterial(patch.tileId),
      ]));
      exactTerrainPbrRuntime = candidateRuntime;
      exactTerrainMaterials = candidateMaterials;
      exactSurfaceCanvasFactory = null;
      const proofDetail = proofChip.querySelector('span');
      if (proofDetail) {
        proofDetail.textContent = `EXACT LOCAL TERRAIN · 12-LAYER AUTHORED PBR${exactVegetationPlan ? ` · ${exactVegetationPlan.renderedCount.toLocaleString()} AUTHORED VEGETATION` : ''} · FIXED RELIEF 2×`;
      }
    } catch (error) {
      candidateRuntime?.dispose?.();
      exactTerrainPbrError = error;
      console.warn('[three-poc] authored 12-layer terrain PBR unavailable; retaining exact-mask fallback', error);
    }
  }
  if (!exactTerrainPbrRuntime && exactSurfaceCanvasFactory) {
    try {
      exactSurfaceCanvases = exactSurfaceCanvasFactory();
    } catch (error) {
      exactSurfaceError ??= error;
      exactSurfaceCanvases = new Map();
      console.warn('[three-poc] exact-mask fallback could not be created; retaining neutral terrain', error);
    } finally {
      exactSurfaceCanvasFactory = null;
    }
  }
  const groundcoverTextures = makeGroundcoverTextures();
  const needsLegacyTerrainTextures = !exactTerrainMesh || !exactTerrainPbrRuntime;
  const textures = {
    groundAtlas: canvasGroundTexture(groundCanvas, groundTextureMapping),
    albedo: !needsLegacyTerrainTextures || groundCanvas
      ? null
      : await loadTexture(MATERIAL_URLS.albedo, { color: true }),
    normal: needsLegacyTerrainTextures ? await loadTexture(MATERIAL_URLS.normal) : null,
    orm: needsLegacyTerrainTextures ? await loadTexture(MATERIAL_URLS.orm) : null,
    grassAlbedo: groundcoverTextures.albedo,
    grassNormal: groundcoverTextures.normal,
  };
  // UV0 is the one-shot semantic atlas; UV1 remains world-repeat detail for normal/ORM.
  if (textures.normal) textures.normal.channel = 1;
  if (textures.orm) textures.orm.channel = 1;
  const exactSurfaceTextures = new Map([...exactSurfaceCanvases].map(([tileId, canvas]) => [
    tileId,
    exactSurfaceTexture(canvas, tileId),
  ]));
  if (!exactTerrainPbrRuntime) exactTerrainMaterials = new Map([...exactSurfaceTextures].map(([tileId, map]) => [
      tileId,
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map,
        normalMap: textures.normal,
        aoMap: textures.orm,
        roughnessMap: textures.orm,
        metalnessMap: textures.orm,
        normalScale: new THREE.Vector2(0.72, 0.72),
        aoMapIntensity: 0.72,
        roughness: 0.98,
        metalness: 0,
      }),
    ]));
  const materials = {
    terrain: new THREE.MeshStandardMaterial({
      color: textures.groundAtlas ? 0xffffff : 0x9ea783,
      map: textures.groundAtlas ?? textures.albedo, normalMap: textures.normal,
      aoMap: textures.orm, roughnessMap: textures.orm, metalnessMap: textures.orm,
      normalScale: new THREE.Vector2(0.72, 0.72), aoMapIntensity: 0.72,
      roughness: 0.98, metalness: 0,
    }),
    terrainFlat: new THREE.MeshStandardMaterial({
      color: textures.groundAtlas ? 0xffffff : 0x8f9578,
      map: textures.groundAtlas ?? null,
      roughness: 1, metalness: 0,
    }),
    terrainExactFlat: new THREE.MeshStandardMaterial({ color: 0x6f735f, roughness: 1, metalness: 0 }),
    terrainVector: new THREE.MeshStandardMaterial({ color: 0x617061, roughness: 1, metalness: 0 }),
    grass: new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0x14220d, emissiveIntensity: 0.13,
      map: textures.grassAlbedo, normalMap: textures.grassNormal,
      normalScale: new THREE.Vector2(0.62, 0.62),
      roughness: 1, metalness: 0, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }),
    grassFlat: new THREE.MeshStandardMaterial({ color: 0x6f9148, roughness: 1, metalness: 0, side: THREE.DoubleSide }),
    grassVector: new THREE.MeshStandardMaterial({ color: 0x668a55, roughness: 1, metalness: 0, side: THREE.DoubleSide }),
    grassBlade: new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.94, metalness: 0, side: THREE.DoubleSide,
      emissive: 0x0b1607, emissiveIntensity: 0.1,
    }),
    grassBladeVector: new THREE.MeshStandardMaterial({ color: 0x78985c, roughness: 1, metalness: 0, side: THREE.DoubleSide }),
    road: new THREE.MeshStandardMaterial({ color: 0x575b55, roughness: 0.96, metalness: 0.01 }),
    dirt: new THREE.MeshStandardMaterial({ color: 0x756d5b, roughness: 1, metalness: 0 }),
    water: new THREE.MeshPhysicalMaterial({ color: 0x4f7474, roughness: 0.2, metalness: 0.06, transmission: 0.08, transparent: true, opacity: 0.86, side: THREE.DoubleSide }),
    fence: new THREE.LineBasicMaterial({ color: 0x8a8d85, transparent: true, opacity: 0.8 }),
    rail: new THREE.LineBasicMaterial({ color: 0x686762, transparent: true, opacity: 0.9 }),
    railSteel: new THREE.MeshStandardMaterial({ color: 0x5d615f, roughness: 0.44, metalness: 0.72 }),
    sleeper: new THREE.MeshStandardMaterial({ color: 0x554638, roughness: 0.96, metalness: 0.03 }),
    ballast: new THREE.MeshStandardMaterial({ color: 0x77756d, roughness: 1, metalness: 0 }),
    rock: new THREE.MeshStandardMaterial({ color: 0x75766c, roughness: 0.93, metalness: 0.01 }),
    trunk: new THREE.MeshStandardMaterial({ color: 0x514332, roughness: 1 }),
    foliage: new THREE.MeshStandardMaterial({ color: 0x5c7653, roughness: 0.98, side: THREE.DoubleSide }),
    pineFoliage: new THREE.MeshStandardMaterial({ color: 0x3e6248, roughness: 1, side: THREE.DoubleSide }),
    deciduousFoliage: new THREE.MeshStandardMaterial({ color: 0x58784e, roughness: 1, side: THREE.DoubleSide }),
    shrubFoliage: new THREE.MeshStandardMaterial({ color: 0x64764d, roughness: 1, side: THREE.DoubleSide }),
    groundPlant: new THREE.MeshStandardMaterial({ color: 0x708552, roughness: 1, side: THREE.DoubleSide }),
    quest: new THREE.MeshStandardMaterial({ color: 0xe7b64b, emissive: 0x4e2d00, emissiveIntensity: 0.45, roughness: 0.48 }),
    questZone: new THREE.MeshBasicMaterial({ color: 0xe7b64b, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }),
    questZoneLine: new THREE.LineBasicMaterial({ color: 0xf3cf7b, transparent: true, opacity: 0.92 }),
    player: new THREE.MeshStandardMaterial({ color: 0x38d6c8, emissive: 0x083f3a, emissiveIntensity: 0.75, roughness: 0.4 }),
    underground: new THREE.MeshStandardMaterial({ color: 0x9b7041, transparent: true, opacity: 0.58, roughness: 1, side: THREE.DoubleSide }),
    floorSurface: new THREE.MeshStandardMaterial({ color: 0x9a978d, transparent: true, opacity: 0.88, roughness: 1, side: THREE.DoubleSide }),
    outline: new THREE.LineBasicMaterial({ color: 0x232b27, transparent: true, opacity: 0.42 }),
  };
  const buildingMaterials = new Map();
  const propMaterials = new Map();
  const materialForBuilding = (building, roof = false) => {
    const place = safeText(building.place ?? building.name);
    const key = `${place || building.kind}:${roof ? 'roof' : 'wall'}`;
    if (buildingMaterials.has(key)) return buildingMaterials.get(key);
    const base = building.color ?? (place.includes('Dorms') ? [176, 151, 132] : [145, 145, 136]);
    const color = rgb(base);
    if (roof) color.multiplyScalar(place.includes('Dorms') ? 0.7 : 0.82);
    const material = new THREE.MeshStandardMaterial({ color, roughness: roof ? 0.84 : 0.78, metalness: building.kind?.includes('industrial') ? 0.12 : 0.02 });
    buildingMaterials.set(key, material);
    return material;
  };
  const materialForProp = (prop, role = 'body') => {
    const color = Array.isArray(prop.color) ? prop.color : [105, 109, 105];
    const metallic = ['container', 'railcar', 'vehicle', 'tanker', 'tank'].includes(prop.type);
    const key = `${prop.type ?? 'prop'}:${color.join(',')}:${metallic}:${role}`;
    const tone = rgb(color);
    if (role === 'dark') tone.multiplyScalar(0.29);
    else if (role === 'metal') tone.set(0x5c615e);
    else if (role === 'glass') tone.set(0x263b3d);
    if (!propMaterials.has(key)) propMaterials.set(key, new THREE.MeshStandardMaterial({
      color: tone,
      roughness: role === 'glass' ? 0.28 : role === 'metal' ? 0.62 : 0.78,
      metalness: role === 'metal' ? 0.68 : role === 'glass' ? 0.14 : metallic ? 0.24 : 0.05,
    }));
    return propMaterials.get(key);
  };

  // Deliberately independent of query/localStorage/callback input: this proof has one visual target.
  let relief = THREE_FIXED_RELIEF;
  let look = VALID_LOOK.has(src.look) ? src.look : 'realistic';
  let floor = 'all';
  let nature = { trees: true, rocks: true };
  let fx = { ...parseThreeFx(src.fx), fog: false };
  let H = exactTerrainSampler(exactTerrainPackage, makeTerrainSampler(data.terrain, relief));
  let HCanonical = exactTerrainSampler(
    exactTerrainPackage,
    makeTerrainSampler(data.terrain, 1),
    'canonicalYM',
  );
  const displayCanonicalObjectY = (
    canonicalY,
    canonicalGroundX,
    canonicalGroundZ,
    displayGroundX = canonicalGroundX,
    displayGroundZ = canonicalGroundZ,
  ) => terrainRelativeDisplayY({
    canonicalY,
    canonicalGroundY: HCanonical(canonicalGroundX, canonicalGroundZ),
    displayGroundY: H(displayGroundX, displayGroundZ),
  });
  let floorResolver = createFloorSurfaceResolver(data.floorSurfaces, relief);
  let seatedBuildings = [];
  let surfaceRenderStats = { floors: 0, roofs: 0, underground: 0, stableIds: [] };
  let treeGroup = null, rockGroup = null, propGroup = null, understoryGroup = null, understoryTuftGroup = null;
  let undergroundGroup = null, buildingGroup = null, understoryLod = 'overview';
  let understoryRenderStats = {
    polygons: 0, vertices: 0, candidateTufts: 0, tuftInstances: 0, coveredRings: 0,
    maxInstances: UNDERSTORY_TUFT_BUDGET.maxInstances, lod: understoryLod,
  };
  let overlayItems = [];
  let railwayRenderStats = { railSegments: 0, ballastSegments: 0, sleepers: 0, triangles: 0 };
  let renderRequested = true, settleFrames = 0;
  const exactTerrainSurfaceStatus = () => customsExactTerrainSurfaceStatus({
    hasExactTerrain: Boolean(exactTerrainMesh),
    pbrAvailable: Boolean(exactTerrainPbrRuntime),
    paletteAvailable: exactTerrainMaterials.size === exactTerrainPackage?.manifest?.tiles?.length,
    look,
    detail: fx.detail,
  });
  const invalidateRender = (frames = 0) => {
    renderRequested = true;
    settleFrames = Math.max(settleFrames, Math.max(0, Number(frames) || 0));
  };
  const status = {
    backend: renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl2',
    scope: THREE_POC_SCOPE.id,
    manifest: null,
    groundAtlas: groundTextureMapping ? {
      textureSize: [...groundTextureMapping.textureSize],
      bounds: { ...groundTextureMapping.bounds },
      source: 'shared-realistic-terrain-bake',
    } : null,
    exactTerrain: exactTerrainMesh ? {
      mode: 'local-exact',
      schemaVersion: exactTerrainPackage.manifest.schemaVersion,
      tiles: exactTerrainPackage.manifest.tiles.length,
      heightBytes: exactTerrainPackage.manifest.tiles.reduce(
        (sum, tile) => sum + tile.resolution.columns * tile.resolution.rows * 4,
        0,
      ),
      vegetationInstances: exactTerrainPackage.manifest.tiles.reduce(
        (sum, tile) => sum + (tile.vegetation?.count ?? 0),
        0,
      ),
      vertices: exactTerrainMesh.vertexCount,
      triangles: exactTerrainMesh.triangleCount,
      decimation: CUSTOMS_EXACT_TERRAIN_DECIMATION,
      renderedSeamGapM: 0,
      boundaryHeightOwnership: exactTerrainMesh.boundaryHeightOwnership,
      surfaceAvailable: exactTerrainSurfaceStatus().available,
      surface: exactTerrainSurfaceStatus().active,
      surfaceError: exactSurfaceError ? String(exactSurfaceError?.message ?? exactSurfaceError) : null,
      pbrError: exactTerrainPbrError ? String(exactTerrainPbrError?.message ?? exactTerrainPbrError) : null,
    } : {
      mode: 'legacy-fallback',
      reason: exactTerrainError?.code ?? exactTerrainError?.name ?? 'missing-local-package',
    },
    exactVegetation: exactVegetationPlan ? {
      mode: 'exact-placement-original-procedural-assets',
      declaredInstances: exactVegetationPlan.sourceCount,
      renderedInstances: exactVegetationPlan.renderedCount,
      culledOutsidePlayableBounds: exactVegetationPlan.culledCount,
      classes: { ...exactVegetationPlan.counts },
      sourceFrame: exactVegetation.sourceFrame,
      geometry: exactVegetationPlan.geometry,
    } : {
      mode: 'reviewed-fallback',
      reason: exactVegetationError?.code ?? exactVegetationError?.name
        ?? (exactTerrainMesh ? 'missing-local-vegetation' : 'exact-terrain-unavailable'),
    },
    firstFrameMs: null,
    dataBytes: Number(response.headers.get('content-length')) || null,
  };

  function addTerrain() {
    if (exactTerrainMesh) {
      const group = new THREE.Group();
      group.name = 'terrain';
      group.userData = {
        kind: 'exact-local-terrain',
        sourceFrame: exactTerrainMesh.sourceFrame,
        relief: THREE_FIXED_RELIEF,
      };
      const seamMeshes = [];
      for (const patch of exactTerrainMesh.patches) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(patch.positions, 3));
        geometry.setAttribute('uv', new THREE.BufferAttribute(patch.controlUvs, 2));
        geometry.setAttribute('uv1', new THREE.BufferAttribute(detailUvsForExactPatch(patch), 2));
        geometry.setIndex(new THREE.BufferAttribute(patch.indices, 1));
        geometry.computeVertexNormals();
        const material = look === 'realistic'
          ? (fx.detail ? exactTerrainMaterials.get(patch.tileId) : materials.terrainExactFlat)
          : materials.terrainVector;
        const mesh = new THREE.Mesh(geometry, material ?? materials.terrainExactFlat);
        mesh.name = `terrain:${patch.tileId}`;
        mesh.userData = {
          kind: 'exact-local-terrain-tile',
          tileId: patch.tileId,
          canonicalElevationField: 'exactTerrainMesh.patches[].canonicalYM',
        };
        mesh.receiveShadow = true;
        group.add(mesh);
        seamMeshes.push(mesh);
      }
      smoothExactTerrainSeamNormals(seamMeshes);
      worldRoot.add(group);
      return;
    }
    const meshData = terrainMeshData(
      data.terrain,
      data.limit,
      relief,
      textures.groundAtlas ? (x, z) => gameToTerrainTextureUv(x, z, groundTextureMapping) : null,
    );
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(meshData.positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(meshData.uvs, 2));
    geometry.setAttribute('uv1', new THREE.BufferAttribute(meshData.detailUvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(meshData.indices, 1));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, look === 'realistic' ? materials.terrain : materials.terrainVector);
    mesh.name = 'terrain';
    mesh.receiveShadow = true;
    worldRoot.add(mesh);
  }

  function addUnderstory() {
    if (exactVegetationPlan) {
      // The exact terrain controls already describe grass/forest/soil coverage and the
      // canonical vegetation package supplies discrete plants. The old blanket polygons
      // would paint over those authored boundaries and duplicate thousands of placements.
      understoryGroup = null;
      understoryTuftGroup = null;
      understoryRenderStats = {
        mode: 'exact-control-masks-and-authored-vegetation',
        polygons: 0,
        vertices: 0,
        candidateTufts: exactVegetationPlan.counts['ground-plant'],
        tuftInstances: exactVegetationPlan.counts['ground-plant'],
        coveredRings: 0,
        maxInstances: exactVegetationPlan.counts['ground-plant'],
        activeDrawCalls: exactVegetationPlan.counts['ground-plant'] ? 1 : 0,
        activeTriangles: exactVegetationPlan.counts['ground-plant'] * 4,
        lod: 'canonical-placements',
      };
      return;
    }
    understoryGroup = new THREE.Group();
    understoryGroup.name = 'reviewed-understory-carpet';
    for (const [index, ring] of (data.understory || []).entries()) {
      const shape = shapeFromRing(ring);
      if (!shape) continue;
      const geometry = new THREE.ShapeGeometry(shape, 12);
      const positions = geometry.getAttribute('position');
      const uvs = geometry.getAttribute('uv');
      for (let i = 0; i < positions.count; i++) {
        const gameX = -positions.getX(i), gameZ = -positions.getY(i);
        positions.setZ(i, H(gameX, gameZ) + 0.065);
        // World-metre UVs keep the source ground detail at a believable scale instead of stretching
        // one copy across a several-hundred-vertex vegetation polygon.
        uvs?.setXY(i, gameX / 7, gameZ / 7);
      }
      positions.needsUpdate = true;
      if (uvs) uvs.needsUpdate = true;
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, look === 'realistic' ? materials.grass : materials.grassVector);
      mesh.name = `understory:${index}`;
      mesh.userData = { kind: 'understory', evidence: 'customs-3d.understory' };
      mesh.receiveShadow = true;
      mesh.renderOrder = 1;
      understoryGroup.add(mesh);
    }
    worldRoot.add(understoryGroup);

    const tuftPlan = buildUnderstoryTuftPlan(data.understory);
    const nearGeometry = grassTuftGeometry(3, true);
    const mediumGeometry = grassTuftGeometry(2, false);
    const near = new THREE.InstancedMesh(
      nearGeometry,
      look === 'realistic' ? materials.grassBlade : materials.grassBladeVector,
      tuftPlan.placements.length,
    );
    const medium = new THREE.InstancedMesh(
      mediumGeometry,
      look === 'realistic' ? materials.grassBlade : materials.grassBladeVector,
      tuftPlan.placements.length,
    );
    near.name = 'understory-tufts-near';
    medium.name = 'understory-tufts-medium';
    near.userData = { kind: 'understory-tufts', lod: 'near', trianglesPerInstance: 6 };
    medium.userData = { kind: 'understory-tufts', lod: 'medium', trianglesPerInstance: 2 };
    const dummy = new THREE.Object3D();
    const bladeColor = new THREE.Color();
    for (const [index, placement] of tuftPlan.placements.entries()) {
      dummy.position.set(...gameToWorld(placement.x, placement.z, H(placement.x, placement.z) + 0.035));
      dummy.rotation.set(0, 0, placement.yaw);
      dummy.scale.set(placement.widthM, placement.widthM, placement.heightM);
      dummy.updateMatrix();
      near.setMatrixAt(index, dummy.matrix);
      medium.setMatrixAt(index, dummy.matrix);
      bladeColor.setHSL(0.235 + placement.shade * 0.055, 0.34 + placement.shade * 0.16, 0.34 + placement.shade * 0.12);
      near.setColorAt(index, bladeColor);
      medium.setColorAt(index, bladeColor);
    }
    near.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    medium.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    near.instanceMatrix.needsUpdate = medium.instanceMatrix.needsUpdate = true;
    if (near.instanceColor) near.instanceColor.needsUpdate = true;
    if (medium.instanceColor) medium.instanceColor.needsUpdate = true;
    near.computeBoundingSphere();
    medium.computeBoundingSphere();
    // Thousands of distant blades casting into the one full-map shadow map is all cost, no signal.
    near.castShadow = medium.castShadow = false;
    near.receiveShadow = medium.receiveShadow = true;
    understoryTuftGroup = new THREE.Group();
    understoryTuftGroup.name = 'reviewed-understory-tufts';
    understoryTuftGroup.add(near, medium);
    worldRoot.add(understoryTuftGroup);
    understoryRenderStats = {
      polygons: data.understory?.length ?? 0,
      vertices: (data.understory || []).reduce((total, ring) => total + ring.length, 0),
      candidateTufts: tuftPlan.candidateCount,
      tuftInstances: tuftPlan.placements.length,
      coveredRings: tuftPlan.coveredRings,
      maxInstances: tuftPlan.maxInstances,
      densityPerSquareM: tuftPlan.densityPerSquareM,
      footprintRadiusM: tuftPlan.footprintRadiusM,
      nearTriangles: tuftPlan.placements.length * 6,
      mediumTriangles: tuftPlan.placements.length * 2,
      activeDrawCalls: 0,
      activeTriangles: 0,
      lod: understoryLod,
    };
  }

  function addWater() {
    for (const water of data.water || []) {
      const shape = shapeFromRing(water.poly);
      if (!shape) continue;
      for (const hole of water.holes || []) {
        const h = shapeFromRing(hole);
        if (h) shape.holes.push(h);
      }
      const geometry = new THREE.ShapeGeometry(shape, 12);
      const mesh = new THREE.Mesh(geometry, materials.water);
      mesh.position.z = (Number(water.level) || 0) * relief + 0.08;
      mesh.name = `water:${water.kind ?? 'surface'}`;
      mesh.receiveShadow = true;
      worldRoot.add(mesh);
    }
  }

  function addRoadsAndLines() {
    // The exact control masks already carry road, gravel, forest and soil boundaries.
    // Legacy ribbons remain an all-or-nothing package fallback; drawing both creates
    // doubled shoulders and reintroduces the approximate geometry we just replaced.
    if (!exactTerrainMesh) {
      for (const road of data.roads || []) {
        const geometry = ribbonGeometry(road.path, Number(road.width) || (road.kind === 'major' ? 9 : 4), H, 0.08);
        if (!geometry) continue;
        const mesh = new THREE.Mesh(geometry, road.kind === 'dirt' || road.kind === 'track' ? materials.dirt : materials.road);
        mesh.name = `road:${road.name ?? road.kind ?? 'road'}`;
        mesh.userData.semanticGroundOverlay = true;
        mesh.receiveShadow = true;
        worldRoot.add(mesh);
      }
      for (const pavement of data.pavement || []) {
        const shape = shapeFromRing(pavement.poly ?? pavement);
        if (!shape) continue;
        const geometry = new THREE.ShapeGeometry(shape);
        const mesh = new THREE.Mesh(geometry, materials.road);
        mesh.userData.semanticGroundOverlay = true;
        const c = centroid(pavement.poly ?? pavement);
        mesh.position.z = H(c[0], c[1]) + 0.07;
        mesh.receiveShadow = true;
        worldRoot.add(mesh);
      }
    }
    for (const bridge of data.bridges || []) {
      const lift = Math.max(0.1, Number(bridge.height) || 0.7);
      const surfaceY = measuredSurfaceY(bridge, relief);
      const geometry = ribbonGeometry(
        bridge.path,
        Number(bridge.width) || 5,
        surfaceY == null ? H : () => surfaceY,
        surfaceY == null ? lift : 0.08,
      );
      if (!geometry) continue;
      const mesh = new THREE.Mesh(geometry, materials.road);
      mesh.name = `bridge:${bridge.name ?? 'bridge'}`;
      mesh.userData = { surfaceY, evidence: bridge.evidence ?? null };
      mesh.castShadow = mesh.receiveShadow = true;
      worldRoot.add(mesh);
    }
    for (const fence of data.fences || []) {
      const geometry = lineGeometry(fence.path, H, 1.9);
      if (geometry) worldRoot.add(new THREE.Line(geometry, materials.fence));
    }
    const railSurfaceY = exactTerrainMesh
      ? (x, z) => H(x, z) + RAILWAY_TRACK_PROFILE.trackBedLiftM
      : H;
    let ballastSegments = 0;
    if (exactTerrainMesh) {
      for (const rail of data.railway || []) {
        for (const [width, lift] of [[3.6, 0.035], [2.9, 0.15]]) {
          const geometry = ribbonGeometry(rail.path, width, H, lift);
          if (!geometry) continue;
          const ballast = new THREE.Mesh(geometry, materials.ballast);
          ballast.name = `rail-ballast:${rail.name ?? ballastSegments}`;
          ballast.receiveShadow = true;
          worldRoot.add(ballast);
          ballastSegments++;
        }
      }
    }
    for (const rail of data.railway || []) {
      const geometry = lineGeometry(rail.path, railSurfaceY, 0.14);
      if (geometry) {
        const line = new THREE.Line(geometry, materials.rail);
        line.userData.semanticGroundOverlay = true;
        worldRoot.add(line);
      }
    }
    const track = railwayTrackMeshData(data.railway, railSurfaceY, THREE_POC_SCOPE);
    if (track.railIndices.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(track.railPositions, 3));
      geometry.setIndex(new THREE.BufferAttribute(track.railIndices, 1));
      geometry.computeVertexNormals();
      const rails = new THREE.Mesh(geometry, materials.railSteel);
      rails.name = 'physical-rails';
      rails.castShadow = rails.receiveShadow = true;
      worldRoot.add(rails);
    }
    if (track.sleepers.length) {
      const sleepers = new THREE.InstancedMesh(
        new THREE.BoxGeometry(...track.sleeperSize),
        materials.sleeper,
        track.sleepers.length,
      );
      sleepers.name = 'physical-sleepers';
      const dummy = new THREE.Object3D();
      track.sleepers.forEach((sleeper, index) => {
        dummy.position.set(...gameToWorld(
          sleeper.x,
          sleeper.z,
          sleeper.y + track.sleeperSize[2] / 2 + track.profile.sleeperCenterLiftM,
        ));
        dummy.rotation.set(0, 0, sleeper.yaw);
        dummy.updateMatrix();
        sleepers.setMatrixAt(index, dummy.matrix);
      });
      sleepers.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      sleepers.instanceMatrix.needsUpdate = true;
      sleepers.castShadow = false;
      sleepers.receiveShadow = true;
      sleepers.computeBoundingSphere();
      worldRoot.add(sleepers);
    }
    railwayRenderStats = {
      railSegments: track.railSegmentCount,
      ballastSegments,
      sleepers: track.sleepers.length,
      triangles: track.railIndices.length / 3 + track.sleepers.length * 12,
    };
  }

  function addBuildings() {
    buildingGroup = new THREE.Group();
    buildingGroup.name = 'buildings';
    seatedBuildings = placeBuildings((data.buildings || []).map((building) => ({ ...building, poly: building.poly.map((p) => [...p]) })), H);
    for (const building of seatedBuildings) {
      const shape = shapeFromRing(building.poly);
      if (!shape) continue;
      const profile = floorResolver.buildingProfile(building, {
        fallbackBase: building.base,
        fallbackHeight: building.height,
      });
      building._surfaceProfile = profile;
      const height = profile.height;
      const openFrame = safeText(building.place).toLowerCase() === 'skeleton' && height >= 8;
      let mesh;
      if (openFrame) {
        const frame = dominantFootprintFrame(building.poly);
        if (!frame) continue;
        mesh = buildOpenFrameBuildingAsset(
          { length: frame.length, width: frame.width, height },
          materialForBuilding(building, false),
        );
        mesh.position.set(...gameToWorld(frame.center[0], frame.center[1], profile.baseY));
        mesh.rotation.z = frame.yaw;
        mesh.traverse((node) => {
          if (!node.isMesh) return;
          node.castShadow = node.receiveShadow = true;
        });
      } else {
        const geometry = new THREE.ExtrudeGeometry(shape, {
          depth: height,
          bevelEnabled: true,
          bevelSegments: 1,
          bevelSize: 0.08,
          bevelThickness: 0.08,
          curveSegments: 2,
        });
        mesh = new THREE.Mesh(geometry, [materialForBuilding(building, true), materialForBuilding(building, false)]);
        mesh.position.z = profile.baseY;
        mesh.castShadow = mesh.receiveShadow = true;
        outlineFor(mesh, materials.outline);
      }
      mesh.name = safeText(building.place ?? building.name ?? building.kind) || 'building';
      mesh.userData = {
        kind: 'building', label: mesh.name, stableId: building.featureId ?? building.sourceKey ?? null,
        floors: profile.floorCount, realHeight: height, surfaceProfile: profile,
        surfaceStableIds: profile.rows.map((row) => row.stableId).filter(Boolean),
        provisional: !building.featureId,
      };
      buildingGroup.add(mesh);

      for (const row of profile.floorRows) {
        const surfaceY = profile.floorYs[row.floorIndex];
        const floorShape = shapeFromRing(building.poly);
        if (!floorShape || surfaceY == null) continue;
        const slab = new THREE.Mesh(new THREE.ShapeGeometry(floorShape), materials.floorSurface);
        slab.position.z = surfaceY + 0.025;
        slab.name = `${mesh.name}:floor:${row.floorIndex}`;
        slab.receiveShadow = true;
        slab.userData = {
          kind: 'floor-surface', label: slab.name, floorIndex: row.floorIndex,
          surfaceY, stableId: row.stableId ?? null,
        };
        buildingGroup.add(slab);
        surfaceRenderStats.floors++;
        if (row.stableId) surfaceRenderStats.stableIds.push(row.stableId);
      }
      if (profile.measuredRoof) {
        surfaceRenderStats.roofs++;
        if (profile.roofRow?.stableId) surfaceRenderStats.stableIds.push(profile.roofRow.stableId);
      }
    }
    worldRoot.add(buildingGroup);
  }

  function propInteractionLabel(prop, assetKind) {
    const stableId = safeText(prop.featureId);
    if (stableId.includes('red_container')) return stableId.endsWith('stack') ? 'Red container stack' : 'Red container';
    if (assetKind === 'locomotive') return 'Train · locomotive';
    if (assetKind === 'tanker-wagon' && prop.type === 'railcar') return 'Train · tanker wagon';
    return safeText(prop.name ?? prop.type) || 'prop';
  }

  function addProps() {
    propGroup = new THREE.Group();
    propGroup.name = 'props';
    for (const prop of data.props || []) {
      const root = new THREE.Group();
      let assetKind = prop.type ?? 'prop';
      if (Array.isArray(prop.path) && prop.path.length >= 2) {
        const h = Math.max(0.2, Number(prop.h) || 2.5);
        const width = Math.max(0.08, Number(prop.w) || 0.4);
        const dz = Number(prop.dz) || 0;
        for (let index = 1; index < prop.path.length; index++) {
          const [ax, az] = prop.path[index - 1], [bx, bz] = prop.path[index];
          if (![ax, az, bx, bz].every(Number.isFinite)) continue;
          const segment = drapedLinearSegmentMeshData([ax, az], [bx, bz], width, h, dz, H);
          if (!segment) continue;
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute('position', new THREE.BufferAttribute(segment.positions, 3));
          geometry.setIndex(new THREE.BufferAttribute(segment.indices, 1));
          geometry.computeVertexNormals();
          const mesh = new THREE.Mesh(geometry, materialForProp(prop));
          mesh.castShadow = mesh.receiveShadow = true;
          mesh.name = `segment:${index}`;
          root.add(mesh);
        }
        assetKind = 'linear-wall';
      } else if (Array.isArray(prop.poly) && prop.poly.length >= 3) {
        const shape = shapeFromRing(prop.poly);
        if (!shape) continue;
        const h = Math.max(0.2, Number(prop.h) || 1);
        const geometry = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
        const mesh = new THREE.Mesh(geometry, materialForProp(prop));
        const c = centroid(prop.poly);
        mesh.position.z = H(c[0], c[1]) + (Number(prop.dz) || 0);
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.name = 'footprint-prop';
        root.add(mesh);
        assetKind = 'footprint-prop';
      } else {
        const onRail = prop.type === 'railcar' || prop.type === 'tanker';
        const pose = pointPropPose(
          prop,
          H(prop.x, prop.z)
            + (exactTerrainMesh && onRail ? RAILWAY_TRACK_PROFILE.vehicleWheelBottomLiftM : 0),
        );
        if (!pose) continue;
        const asset = buildPropAsset(prop, (role) => materialForProp(prop, role));
        root.add(asset);
        root.position.set(...pose.position);
        root.rotation.z = pose.rotationZ;
        assetKind = asset.userData.assetKind;
      }
      if (!root.children.length) continue;
      root.name = safeText(prop.name ?? prop.type) || 'prop';
      root.userData = {
        kind: 'prop', assetKind, label: propInteractionLabel(prop, assetKind),
        stableId: prop.featureId ?? null, provisional: !prop.featureId,
      };
      propGroup.add(root);
    }
    worldRoot.add(propGroup);
  }

  function addTreesAndRocks() {
    treeGroup = new THREE.Group();
    treeGroup.name = exactVegetationPlan ? 'exact-local-vegetation' : 'trees';
    if (exactVegetationPlan) {
      treeGroup.userData = {
        kind: 'exact-local-vegetation',
        declaredInstances: exactVegetationPlan.sourceCount,
        renderedInstances: exactVegetationPlan.renderedCount,
        classes: { ...exactVegetationPlan.counts },
        placementAccuracy: 'canonical-game-authored',
        geometryAccuracy: 'original-procedural-class-proxies',
      };
      const add = (spec) => {
        const mesh = exactVegetationInstancedMesh(spec);
        if (mesh) treeGroup.add(mesh);
      };
      const pine = exactVegetationPlan.groups.pine;
      const deciduous = exactVegetationPlan.groups.deciduous;
      const shrubs = exactVegetationPlan.groups.shrub;
      const stumps = exactVegetationPlan.groups.stump;
      const groundPlants = exactVegetationPlan.groups['ground-plant'];

      const pineTrunkGeometry = new THREE.CylinderGeometry(1, 1, 1, 7);
      pineTrunkGeometry.rotateX(Math.PI / 2);
      add({
        geometry: pineTrunkGeometry, material: materials.trunk, placements: pine,
        name: 'exact-pine-trunks', component: 'pine-trunk', castShadow: true,
        transform: (dummy, placement) => {
          const { trunkHeight, trunkRadius } = placement.dimensions;
          dummy.position.z += trunkHeight / 2;
          dummy.scale.set(trunkRadius, trunkRadius, trunkHeight);
        },
      });
      for (const [layer, radiusFactor, heightFactor, centerFactor] of [
        ['lower', 0.5, 0.74, 0.51],
        ['upper', 0.34, 0.54, 0.76],
      ]) {
        const crownGeometry = new THREE.ConeGeometry(1, 1, 8);
        crownGeometry.rotateX(Math.PI / 2);
        add({
          geometry: crownGeometry, material: materials.pineFoliage, placements: pine,
          name: `exact-pine-crowns-${layer}`, component: `pine-crown-${layer}`,
          castShadow: layer === 'lower',
          transform: (dummy, placement) => {
            const { height, width, trunkHeight } = placement.dimensions;
            const crownHeight = Math.max(0.2, height - trunkHeight);
            dummy.position.z += trunkHeight + crownHeight * centerFactor;
            dummy.scale.set(width * radiusFactor, width * radiusFactor, crownHeight * heightFactor);
          },
        });
      }

      const deciduousTrunkGeometry = new THREE.CylinderGeometry(1, 0.82, 1, 7);
      deciduousTrunkGeometry.rotateX(Math.PI / 2);
      add({
        geometry: deciduousTrunkGeometry, material: materials.trunk, placements: deciduous,
        name: 'exact-deciduous-trunks', component: 'deciduous-trunk', castShadow: true,
        transform: (dummy, placement) => {
          const { trunkHeight, trunkRadius } = placement.dimensions;
          dummy.position.z += trunkHeight / 2;
          dummy.scale.set(trunkRadius, trunkRadius, trunkHeight);
        },
      });
      add({
        geometry: new THREE.DodecahedronGeometry(1, 0),
        material: materials.deciduousFoliage,
        placements: deciduous,
        name: 'exact-deciduous-crowns', component: 'deciduous-crown', castShadow: true,
        transform: (dummy, placement) => {
          const { height, width, trunkHeight } = placement.dimensions;
          const crownHeight = Math.max(0.2, height - trunkHeight);
          dummy.position.z += trunkHeight + crownHeight * 0.48;
          dummy.scale.set(width * 0.5, width * 0.44, crownHeight * 0.54);
        },
      });
      add({
        geometry: new THREE.DodecahedronGeometry(1, 0),
        material: materials.shrubFoliage,
        placements: shrubs,
        name: 'exact-shrubs', component: 'shrub',
        transform: (dummy, placement) => {
          const { height, width } = placement.dimensions;
          dummy.position.z += height * 0.43;
          dummy.scale.set(width * 0.5, width * 0.43, height * 0.52);
        },
      });
      const stumpGeometry = new THREE.CylinderGeometry(1, 0.84, 1, 7);
      stumpGeometry.rotateX(Math.PI / 2);
      add({
        geometry: stumpGeometry, material: materials.trunk, placements: stumps,
        name: 'exact-stumps', component: 'stump', castShadow: true,
        transform: (dummy, placement) => {
          const { height, trunkRadius } = placement.dimensions;
          dummy.position.z += height / 2;
          dummy.scale.set(trunkRadius, trunkRadius, height);
        },
      });
      add({
        geometry: grassTuftGeometry(2, true),
        material: materials.groundPlant,
        placements: groundPlants,
        name: 'exact-ground-plants', component: 'ground-plant',
        transform: (dummy, placement) => {
          const { height, width } = placement.dimensions;
          dummy.position.z += 0.025;
          dummy.scale.set(width, width, height);
        },
      });
    } else {
      const trees = data.trees || [];
      const trunkGeometry = new THREE.CylinderGeometry(1, 1, 1, 6);
      const crownGeometry = new THREE.ConeGeometry(1, 1, 7);
      trunkGeometry.rotateX(Math.PI / 2);
      crownGeometry.rotateX(Math.PI / 2);
      const trunks = new THREE.InstancedMesh(trunkGeometry, materials.trunk, trees.length);
      const crowns = new THREE.InstancedMesh(crownGeometry, materials.foliage, trees.length);
      const dummy = new THREE.Object3D();
      trees.forEach((tree, i) => {
        const h = Math.max(3, Number(tree.height) || 8), r = Math.max(0.8, Number(tree.radius) || 1.8);
        const base = H(tree.x, tree.z), trunkH = Math.max(1.4, Number(tree.trunkHeight) || h * 0.25);
        dummy.position.set(...gameToWorld(tree.x, tree.z, base + trunkH / 2));
        dummy.scale.set(Math.max(0.1, Number(tree.trunkRadius) || 0.2), Math.max(0.1, Number(tree.trunkRadius) || 0.2), trunkH);
        dummy.rotation.z = -(Number(tree.rotation) || 0) * Math.PI / 180;
        dummy.updateMatrix(); trunks.setMatrixAt(i, dummy.matrix);
        dummy.position.set(...gameToWorld(tree.x, tree.z, base + trunkH + (h - trunkH) / 2));
        dummy.scale.set(r, r, h - trunkH);
        dummy.updateMatrix(); crowns.setMatrixAt(i, dummy.matrix);
      });
      trunks.instanceMatrix.needsUpdate = crowns.instanceMatrix.needsUpdate = true;
      trunks.castShadow = crowns.castShadow = true;
      trunks.receiveShadow = crowns.receiveShadow = true;
      treeGroup.add(trunks, crowns);
    }
    worldRoot.add(treeGroup);

    rockGroup = new THREE.Group();
    rockGroup.name = 'rocks';
    for (const rock of data.rocks || []) {
      const shape = shapeFromRing(rock.poly);
      if (!shape) continue;
      const geometry = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.2, Number(rock.height) || 1), bevelEnabled: true, bevelSize: 0.12, bevelThickness: 0.08, bevelSegments: 1 });
      const mesh = new THREE.Mesh(geometry, materials.rock);
      const c = centroid(rock.poly);
      mesh.position.z = H(c[0], c[1]) + 0.02;
      mesh.castShadow = mesh.receiveShadow = true;
      rockGroup.add(mesh);
    }
    worldRoot.add(rockGroup);
  }

  function addUnderground() {
    undergroundGroup = new THREE.Group();
    undergroundGroup.name = 'underground';
    const renderedStableIds = new Set();
    const addSurface = ({ poly, name, profile }) => {
      const shape = shapeFromRing(poly);
      if (!shape) return;
      const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), materials.underground);
      mesh.position.z = profile.surfaceY + 0.025;
      mesh.name = safeText(name) || 'underground';
      mesh.userData = {
        kind: 'underground', label: mesh.name, surfaceY: profile.surfaceY,
        stableId: profile.stableId ?? null, measured: profile.measured,
      };
      outlineFor(mesh, materials.outline);
      undergroundGroup.add(mesh);
      surfaceRenderStats.underground++;
      if (profile.stableId) {
        renderedStableIds.add(profile.stableId);
        surfaceRenderStats.stableIds.push(profile.stableId);
      }
    };
    for (const item of data.underground || []) {
      const c = centroid(item.poly);
      const depth = Number(item.depth) || 3;
      const groundY = H(c[0], c[1]);
      const profile = floorResolver.undergroundProfile(item, {
        fallbackY: groundY - depth,
        fallbackReferenceY: groundY / relief - depth,
      });
      addSurface({ poly: item.poly, name: item.name, profile });
    }
    for (const surface of floorResolver.measuredBuildingUndergroundSlabs(seatedBuildings)) {
      if (surface.stableId && renderedStableIds.has(surface.stableId)) continue;
      addSurface({
        poly: surface.building.poly,
        name: `${surface.building.place ?? surface.building.name ?? 'Building'} basement`,
        profile: { surfaceY: surface.surfaceY, stableId: surface.stableId, measured: true },
      });
    }
    undergroundGroup.visible = floor === 'U';
    worldRoot.add(undergroundGroup);
  }

  function applyFloorVisibility() {
    if (!buildingGroup || !undergroundGroup) return;
    buildingGroup.visible = floor !== 'U';
    if (propGroup) propGroup.visible = floor !== 'U';
    undergroundGroup.visible = floor === 'U';
    for (const mesh of buildingGroup.children) {
      if (mesh.userData.kind === 'floor-surface') {
        mesh.visible = floor === 'all' || mesh.userData.floorIndex <= Number(floor);
        continue;
      }
      if (mesh.userData.kind !== 'building') continue;
      mesh.visible = true;
      const height = mesh.userData.realHeight || 1;
      const shown = visibleBuildingHeight(mesh.userData.surfaceProfile, floor);
      mesh.scale.z = Math.max(0.04, shown / height);
    }
    for (const node of propGroup?.children ?? []) node.visible = true;
    for (const node of undergroundGroup.children) node.visible = true;
    for (const node of authoredRoot.children) {
      node.visible = customsAssetVisibleForFloor(node.userData?.floor, floor);
    }
  }

  // Procedural features retired by the *current* attachment ledger, keyed by feature ID. The
  // synchronized map is replaceable: when a cell leaves, an LOD fails, or a replacement starts
  // reloading, its procedural node is restored before the next asynchronous loader wait.
  const suppressedProceduralFeatures = new Map();
  const suppressedProceduralNodes = new Map();

  function proceduralFeatureNodes(featureId, kind) {
    const nodes = [];
    const acceptedKinds = kind === 'surface'
      ? new Set(['floor-surface', 'underground'])
      : new Set([kind]);
    for (const group of [buildingGroup, propGroup, undergroundGroup]) {
      group?.traverse?.((node) => {
        if (node === group || node.userData?.stableId !== featureId) return;
        if (!acceptedKinds.has(node.userData?.kind)) return;
        nodes.push(node);
      });
    }
    return nodes;
  }

  function restoreProceduralSuppression() {
    for (const records of suppressedProceduralNodes.values()) {
      for (const { node, visible } of records) {
        node.visible = visible;
        delete node.userData.authoredSuppressionPolicy;
      }
    }
    suppressedProceduralNodes.clear();
  }

  function applyProceduralSuppression() {
    // Restore the last baseline before capturing this floor's baseline. This makes a floor
    // change while suppressed reversible instead of preserving a stale hidden state forever.
    restoreProceduralSuppression();
    for (const [featureId, entry] of suppressedProceduralFeatures) {
      const records = [];
      for (const node of proceduralFeatureNodes(featureId, entry.kind)) {
        records.push({ node, visible: node.visible });
        // `visibleInteractionData` walks ancestors for `visible === false`, so hiding the node
        // takes it out of picking too. A hidden-but-still-pickable variant, which is what
        // `hide-mesh` versus `hide-mesh-and-picking` would distinguish, is staged.
        node.visible = false;
        node.userData.authoredSuppressionPolicy = entry.policy;
      }
      if (records.length) suppressedProceduralNodes.set(featureId, records);
    }
    invalidateRender();
  }

  function applyFloor() {
    restoreProceduralSuppression();
    applyFloorVisibility();
    applyProceduralSuppression();
    invalidateRender();
  }

  /** Synchronize, rather than append to, the set justified by the attachment ledger. */
  function syncProceduralSuppression(entries = []) {
    restoreProceduralSuppression();
    suppressedProceduralFeatures.clear();
    const applied = [];
    const retained = [];
    for (const { featureId, policy, kind } of entries) {
      // Trees, rocks and understory are drawn as InstancedMesh; removing one instance means
      // rebuilding the buffer, which is the next pass. Buildings, props and their floor surfaces
      // are individual nodes and can be retired now.
      if (kind !== 'building' && kind !== 'prop' && kind !== 'surface') {
        retained.push({
          featureId,
          reason: `attached, but this renderer cannot retire a procedural ${kind}`,
        });
        continue;
      }
      if (proceduralFeatureNodes(featureId, kind).length === 0) {
        retained.push({
          featureId,
          reason: `attached, but no matching procedural ${kind} node exists`,
        });
        continue;
      }
      suppressedProceduralFeatures.set(featureId, { policy, kind });
      applied.push(featureId);
    }
    applyFloorVisibility();
    applyProceduralSuppression();
    return { applied, retained };
  }

  function applyNature() {
    if (treeGroup) treeGroup.visible = nature.trees !== false;
    if (understoryGroup) understoryGroup.visible = nature.trees !== false;
    if (understoryTuftGroup) understoryTuftGroup.visible = nature.trees !== false && fx.detail !== false;
    if (rockGroup) rockGroup.visible = nature.rocks !== false;
    invalidateRender();
  }

  function updateUnderstoryLod() {
    if (!understoryTuftGroup) return;
    if (nature.trees === false) understoryLod = 'hidden';
    else if (fx.detail === false) understoryLod = 'carpet-only';
    else {
      const distance = camera.position.distanceTo(controls.target);
      const { nearMaxDistanceM, mediumMaxDistanceM, hysteresisM } = UNDERSTORY_TUFT_BUDGET;
      if (understoryLod === 'near' && distance <= nearMaxDistanceM + hysteresisM) understoryLod = 'near';
      else if (understoryLod === 'medium' && distance < nearMaxDistanceM - hysteresisM) understoryLod = 'near';
      else if (understoryLod === 'medium' && distance <= mediumMaxDistanceM + hysteresisM) understoryLod = 'medium';
      else if (understoryLod === 'overview' && distance > mediumMaxDistanceM - hysteresisM) understoryLod = 'overview';
      else if (distance <= nearMaxDistanceM) understoryLod = 'near';
      else if (distance <= mediumMaxDistanceM) understoryLod = 'medium';
      else understoryLod = 'overview';
    }
    understoryTuftGroup.visible = nature.trees !== false && fx.detail !== false;
    for (const mesh of understoryTuftGroup.children) {
      mesh.visible = understoryTuftGroup.visible && mesh.userData.lod === understoryLod;
    }
    understoryRenderStats.lod = understoryLod;
    understoryRenderStats.activeDrawCalls = ['near', 'medium'].includes(understoryLod) ? 1 : 0;
    understoryRenderStats.activeTriangles = understoryLod === 'near'
      ? understoryRenderStats.nearTriangles
      : understoryLod === 'medium' ? understoryRenderStats.mediumTriangles : 0;
  }

  function rebuildWorld() {
    disposeTree(worldRoot);
    H = exactTerrainSampler(exactTerrainPackage, makeTerrainSampler(data.terrain, relief));
    HCanonical = exactTerrainSampler(
      exactTerrainPackage,
      makeTerrainSampler(data.terrain, 1),
      'canonicalYM',
    );
    floorResolver = createFloorSurfaceResolver(data.floorSurfaces, relief);
    surfaceRenderStats = { floors: 0, roofs: 0, underground: 0, stableIds: [] };
    addTerrain();
    addUnderstory();
    addWater();
    addRoadsAndLines();
    addBuildings();
    addProps();
    addTreesAndRocks();
    addUnderground();
    applyFloor();
    applyNature();
    // `applyFloor` also re-applies the synchronized suppression map after rebuilding every
    // procedural group, so a world refresh cannot resurrect an authored replacement's proxy.
    updateUnderstoryLod();
    invalidateRender();
  }

  function applyLook() {
    const real = look === 'realistic';
    scene.background = new THREE.Color(real ? 0x353d36 : 0x0a100e);
    scene.fog = null;
    hemi.intensity = real ? 2.05 : 1.2;
    ambient.intensity = real ? 0.24 : 0.08;
    sun.intensity = real ? 2.65 : 2;
    renderer.toneMapping = real && fx.grade ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
    renderer.toneMappingExposure = real && fx.grade ? 0.93 : 1;
    const terrain = worldRoot.getObjectByName('terrain');
    terrain?.traverse?.((node) => {
      if (!node.isMesh) return;
      if (node.userData?.kind === 'exact-local-terrain-tile') {
        node.material = real
          ? (fx.detail ? (exactTerrainMaterials.get(node.userData.tileId) ?? materials.terrainExactFlat) : materials.terrainExactFlat)
          : materials.terrainVector;
      } else {
        node.material = real
          ? (fx.detail ? materials.terrain : materials.terrainFlat)
          : materials.terrainVector;
      }
    });
    // The shared realistic atlas already contains evidence-aligned pavement, road shoulders,
    // rails and sleepers. The legacy flat ribbons masked that authored detail at close zoom; keep
    // them only as the vector-look fallback or if atlas generation failed.
    const showFlatSurfaceNetwork = !real || !textures.groundAtlas;
    worldRoot.traverse((node) => {
      if (node.userData?.semanticGroundOverlay) node.visible = showFlatSurfaceNetwork;
    });
    if (understoryGroup) for (const mesh of understoryGroup.children) {
      mesh.material = real ? (fx.detail ? materials.grass : materials.grassFlat) : materials.grassVector;
    }
    if (understoryTuftGroup) for (const mesh of understoryTuftGroup.children) {
      mesh.material = real ? materials.grassBlade : materials.grassBladeVector;
    }
    if (status.exactTerrain?.mode === 'local-exact') {
      status.exactTerrain.surface = exactTerrainSurfaceStatus().active;
    }
    applyNature();
    updateUnderstoryLod();
    invalidateRender();
  }

  function makeOverlayItem({ label, x, z, y = null, kind = 'place', markerKind = null, onClick = null, title = '' }) {
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(z))) return;
    const element = document.createElement(onClick ? 'button' : 'div');
    if (onClick) element.type = 'button';
    element.className = `tz-three-marker tz-three-marker-${kind}`;
    element.textContent = safeText(label);
    element.title = safeText(title || label);
    if (markerKind) element.dataset.markerKind = markerKind;
    if (onClick) element.addEventListener('click', (event) => { event.stopPropagation(); onClick(); });
    overlay.append(element);
    overlayItems.push({ element, x: Number(x), z: Number(z), y: Number.isFinite(Number(y)) ? Number(y) : null, kind });
  }

  function clearOverlays() {
    for (const item of overlayItems) item.element.remove();
    overlayItems = [];
  }

  function refreshDynamic() {
    clearOverlays();
    disposeTree(dynamicRoot);
    if (floor !== 'U') for (const callout of TACTICAL_PROP_CALLOUTS) {
      const prop = (data.props || []).find((candidate) => candidate.featureId === callout.featureId);
      if (!prop || !Number.isFinite(Number(prop.x)) || !Number.isFinite(Number(prop.z))
        || !withinScope(prop)) continue;
      makeOverlayItem({
        label: callout.label,
        x: prop.x,
        z: prop.z,
        y: H(prop.x, prop.z) + Math.max(0.2, Number(prop.h) || 2) + 0.7,
        kind: 'landmark',
        title: propInteractionLabel(prop, prop.type),
      });
    }
    for (const label of src.labels?.() || []) {
      const [x, z] = label.position || [];
      if (withinScope([x, z]) && visibleForFloor(label.floor ?? 'surface', floor)) {
        makeOverlayItem({ label: label.text ?? label.name, x, z, kind: 'place' });
      }
    }
    for (const marker of src.markers?.() || []) {
      const spec = markerOverlaySpec(marker);
      if (!spec || !withinScope([spec.x, spec.z]) || !visibleForFloor(spec.level, floor)) continue;
      makeOverlayItem({
        ...spec,
        y: spec.y == null
          ? null
          : displayCanonicalObjectY(spec.y, spec.x, spec.z) + 0.8,
      });
    }
    const questData = src.quests?.() || {};
    for (const sourceZone of questData.zones || []) {
      const zone = questZoneSpec(sourceZone);
      if (!zone || !visibleForFloor(zone.level, floor) || !zone.outline.some((point) => withinScope(point))) continue;
      const shape = shapeFromRing(zone.outline);
      if (!shape) continue;
      const geometry = new THREE.ShapeGeometry(shape);
      const mesh = new THREE.Mesh(geometry, materials.questZone);
      mesh.position.z = zone.outline.reduce((sum, [x, z]) => sum + H(x, z) / zone.outline.length, 0) + 0.28;
      mesh.renderOrder = 3;
      mesh.userData = { kind: 'quest-zone', label: 'Quest objective zone', stableId: zone.id };
      dynamicRoot.add(mesh);
      const line = lineGeometry([...zone.outline, zone.outline[0]], H, 0.36);
      if (line) {
        const outline = new THREE.Line(line, materials.questZoneLine);
        outline.renderOrder = 4;
        dynamicRoot.add(outline);
      }
    }
    for (const point of questData.points || []) {
      const pos = point.pin ?? point.position;
      if (!pos || !withinScope(pos) || !visibleForFloor(point.level ?? 'surface', floor)) continue;
      const canonicalPosition = point.position ?? pos;
      const y = displayCanonicalObjectY(
        canonicalPosition.y,
        canonicalPosition.x,
        canonicalPosition.z,
        pos.x,
        pos.z,
      ) + 0.9;
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.85, 14, 10), materials.quest);
      mesh.position.set(...gameToWorld(pos.x, pos.z, y));
      mesh.userData = { kind: 'quest', label: safeText(point.name ?? point.title ?? `Objective ${point.badge ?? ''}`), stableId: point.id ?? null };
      dynamicRoot.add(mesh);
      makeOverlayItem({
        label: point.badge ? `Q${point.badge}` : 'QUEST', x: pos.x, z: pos.z, y,
        kind: 'quest', title: mesh.userData.label, onClick: () => src.onQuestClick?.(point),
      });
    }
    for (const player of src.players?.() || []) {
      if (!player.last) continue;
      const last = player.last;
      const canonicalY = last.y == null ? null : Number(last.y);
      const y = displayCanonicalObjectY(canonicalY, last.x, last.z) + 1.2;
      const mesh = new THREE.Mesh(new THREE.ConeGeometry(1.15, 3.4, 7), materials.player);
      mesh.rotation.x = Math.PI / 2;
      mesh.rotation.z = -(Number(last.yaw ?? last.heading) || 0) * Math.PI / 180;
      mesh.position.set(...gameToWorld(last.x, last.z, y));
      mesh.userData = { kind: 'player', label: safeText(player.name ?? player.code ?? 'LIVE') };
      dynamicRoot.add(mesh);
      makeOverlayItem({ label: mesh.userData.label || 'LIVE', x: last.x, z: last.z, y: y + 2.4, kind: 'player' });
    }
    invalidateRender();
  }

  function updateOverlayPositions() {
    const width = Math.max(1, container.clientWidth), height = Math.max(1, container.clientHeight);
    let safe = null;
    try { safe = src.safeRect?.() ?? null; } catch {}
    for (const item of overlayItems) {
      const v = new THREE.Vector3(...gameToWorld(item.x, item.z, item.y ?? H(item.x, item.z) + 1.2)).project(camera);
      const visible = v.z > -1 && v.z < 1 && v.x > -1.15 && v.x < 1.15 && v.y > -1.15 && v.y < 1.15;
      item.element.hidden = !visible;
      if (!visible) continue;
      const seated = seatOverlayAnchor({
        x: (v.x + 1) * width / 2,
        y: (-v.y + 1) * height / 2,
        elementWidth: item.element.offsetWidth,
        elementHeight: item.element.offsetHeight,
        safeRect: safe,
        containerWidth: width,
        containerHeight: height,
      });
      if (!seated) { item.element.hidden = true; continue; }
      item.element.style.transform = `translate3d(${seated[0].toFixed(1)}px,${seated[1].toFixed(1)}px,0) translate(-50%,-100%)`;
    }
  }

  rebuildWorld();
  applyLook();
  refreshDynamic();
  const authoredStreamer = createAuthoredAssetStreamer({
    root: authoredRoot, status, guard: authoredGuard, signal: authoredAbort.signal,
    displayYFor: (x, z, canonicalY) => displayCanonicalObjectY(canonicalY, x, z),
    syncSuppression: syncProceduralSuppression,
    loaderHost: authoredLoaderHost,
    cache: authoredAssetCache,
    instanceVisible: (instance) => customsAssetVisibleForFloor(instance.floor, floor),
    onChanged: () => invalidateRender(1),
  });
  const updateAuthoredAssetsForTarget = () => {
    // OrbitControls' target is the real focus used by the user, in runtime [-x,-z,y]. The
    // streamer's planner consumes canonical EFT x/z, so never substitute the fixed proof scope.
    void authoredStreamer.update(authoredCameraFromWorldTarget(controls.target));
  };

  const groundExtent = (() => {
    const xs = data.limit.map((p) => p[0]), zs = data.limit.map((p) => p[1]);
    return { width: Math.max(...xs) - Math.min(...xs), depth: Math.max(...zs) - Math.min(...zs) };
  })();
  let viewState = { target: [0, 0, 0], zoom: 0, rotationX: CAM.rotationX, rotationOrbit: CAM.rotationOrbit, minZoom: -2, maxZoom: 5 };
  const clampView = (next) => clampCamera(next, {
    ...groundExtent,
    viewportWidth: container.clientWidth || 1200,
    viewportHeight: container.clientHeight || 800,
    ground: (() => { try { return H(-(next.target?.[0] ?? 0), -(next.target?.[1] ?? 0)); } catch { return 0; } })(),
  });
  let suppressControlEvent = false;
  function distanceForZoom(zoom) {
    return (Math.max(1, container.clientHeight) / 2) / (Math.pow(2, zoom) * Math.tan((CAM.fovy * Math.PI) / 360));
  }
  function writeControlledPose(pose) {
    // OrbitControls emits `change` from update(). Keep that echo out of the user-input path while
    // writing the authoritative, clamped pose back to the real camera.
    suppressControlEvent = true;
    try {
      controls.target.fromArray(pose.target);
      camera.position.fromArray(pose.position);
      camera.up.set(0, 0, 1);
      camera.lookAt(controls.target);
      controls.update();
    } finally {
      suppressControlEvent = false;
    }
  }
  function applyView(next, notify = false) {
    viewState = clampView({ ...viewState, ...next });
    const pose = cameraPose(viewState, container.clientHeight || 800, CAM.fovy);
    controls.minDistance = distanceForZoom(viewState.maxZoom ?? 5);
    controls.maxDistance = distanceForZoom(viewState.minZoom ?? -2);
    writeControlledPose(pose);
    updateAuthoredAssetsForTarget();
    invalidateRender();
    if (notify) src.onViewChange?.({ ...viewState });
    return { ...viewState };
  }
  let controlNotify = 0;
  controls.addEventListener('change', () => {
    if (suppressControlEvent) return;
    const reconciled = reconcileOrbitView({
      position: camera.position.toArray(),
      target: controls.target.toArray(),
      previous: viewState,
      viewportHeight: container.clientHeight || 800,
      fovy: CAM.fovy,
      clamp: clampView,
    });
    viewState = reconciled.view;
    // A clamp is not merely bookkeeping. Reapply it synchronously, before queuing the permalink /
    // HUD / hidden-2D notification, so all four surfaces describe the camera on the canvas.
    if (reconciled.corrected) writeControlledPose(reconciled.pose);
    updateAuthoredAssetsForTarget();
    invalidateRender();
    if (!controlNotify) controlNotify = requestAnimationFrame(() => {
      controlNotify = 0;
      src.onViewChange?.({ ...viewState });
    });
  });
  applyView(viewState);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  renderer.domElement.addEventListener('pointermove', (event) => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const interaction = raycaster.intersectObjects([buildingGroup, propGroup, authoredRoot, dynamicRoot].filter(Boolean), true)
      .map((hit) => ({ hit, user: visibleInteractionData(hit.object) }))
      .find((candidate) => candidate.user);
    const user = interaction?.user;
    hoverChip.hidden = !user?.label;
    renderer.domElement.style.cursor = user?.label ? 'help' : '';
    if (user?.label) {
      hoverChip.textContent = `${user.label}${user.stableId ? ` · ${user.stableId}` : ''}${user.provisional ? ' · provisional' : ''}`;
      hoverChip.style.left = `${event.clientX - rect.left + 14}px`;
      hoverChip.style.top = `${event.clientY - rect.top + 14}px`;
    }
  });
  renderer.domElement.addEventListener('pointerleave', () => {
    hoverChip.hidden = true;
    renderer.domElement.style.cursor = '';
  });

  let frames = 0, fps = null, fpsWindowAt = performance.now(), stopped = false;
  function animate() {
    if (stopped) return;
    requestAnimationFrame(animate);
    // Keep the expensive full-resolution scene alive for instant 2D↔3D handoff, but do not
    // continue submitting ~2.9M triangles while the 2D map owns the viewport.
    if (document.hidden || !document.body.classList.contains('view-3d')) {
      frames = 0;
      fps = 0;
      fpsWindowAt = performance.now();
      return;
    }
    if (!renderRequested && settleFrames <= 0) return;
    renderRequested = false;
    controls.update();
    updateUnderstoryLod();
    updateOverlayPositions();
    renderer.render(scene, camera);
    if (settleFrames > 0) {
      settleFrames--;
      renderRequested = true;
    }
    frames++;
    const now = performance.now();
    if (status.firstFrameMs == null) status.firstFrameMs = Math.round(now - bootAt);
    if (now - fpsWindowAt >= 1000) {
      fps = Math.round(frames * 1000 / (now - fpsWindowAt));
      frames = 0; fpsWindowAt = now;
    }
  }
  animate();

  const resize = new ResizeObserver(() => {
    const width = Math.max(1, container.clientWidth), height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    applyView(viewState);
    invalidateRender();
  });
  resize.observe(container);

  const api = {
    renderer: 'three',
    backend: status.backend,
    refresh: refreshDynamic,
    setFloor: (next) => {
      floor = next;
      applyFloor();
      refreshDynamic();
    },
    setNature: (next) => { nature = { ...nature, ...next }; applyNature(); updateUnderstoryLod(); },
    setRelief: () => relief,
    setLook: (next) => { look = VALID_LOOK.has(next) ? next : 'realistic'; applyLook(); return look; },
    getLook: () => look,
    setFx: (next) => { fx = { ...updateThreeFx(fx, next), fog: false }; applyLook(); return { ...fx }; },
    getFx: () => ({ ...fx }),
    focusExtract: (name) => {
      for (const item of overlayItems) item.element.classList.toggle('focused', item.kind === 'extract' && item.element.textContent === name);
    },
    setView: (patch = {}) => applyView(patch),
    project: (x, z, dy = 0.7) => {
      const v = new THREE.Vector3(...gameToWorld(x, z, H(x, z) + dy)).project(camera);
      if (!(v.z > -1 && v.z < 1)) return null;
      return [(v.x + 1) * container.clientWidth / 2, (-v.y + 1) * container.clientHeight / 2];
    },
    renderStats: () => ({
      map: 'customs', renderer: 'three', backend: status.backend, scope: status.scope, look, relief, fx: { ...fx }, fps,
      drawCalls: renderer.info?.render?.calls ?? null, triangles: renderer.info?.render?.triangles ?? null,
      geometries: renderer.info?.memory?.geometries ?? null, textures: renderer.info?.memory?.textures ?? null,
      firstFrameMs: status.firstFrameMs, dataBytes: status.dataBytes, authored: status.manifest,
      groundAtlas: status.groundAtlas, exactTerrain: status.exactTerrain,
      exactVegetation: status.exactVegetation,
      floorSurfaces: { ...surfaceRenderStats, stableIds: [...new Set(surfaceRenderStats.stableIds)] },
      groundcover: { ...understoryRenderStats },
      railway: { ...railwayRenderStats },
      provisional: true,
    }),
    diagnostics: () => ({
      scope: THREE_POC_SCOPE, backend: status.backend, authored: status.manifest,
      groundAtlas: status.groundAtlas, exactTerrain: status.exactTerrain,
      exactVegetation: status.exactVegetation,
      sources: { buildings: data.buildings?.length ?? 0, props: data.props?.length ?? 0, trees: data.trees?.length ?? 0, exactVegetation: exactVegetationPlan?.renderedCount ?? 0, understory: data.understory?.length ?? 0, rocks: data.rocks?.length ?? 0, water: data.water?.length ?? 0, floorSurfaces: data.floorSurfaces?.length ?? 0 },
      floorSurfaces: { ...surfaceRenderStats, stableIds: [...new Set(surfaceRenderStats.stableIds)] },
      groundcover: { ...understoryRenderStats },
      railway: { ...railwayRenderStats },
    }),
    dispose: () => {
      stopped = true;
      localTerrainAbort.abort();
      authoredStreamer.dispose();
      authoredAbort.abort();
      authoredGuard.dispose();
      authoredLoaderHost.dispose();
      authoredAssetCache.clear();
      if (controlNotify) cancelAnimationFrame(controlNotify);
      resize.disconnect(); controls.dispose(); renderer.dispose();
      disposeTree(worldRoot); disposeTree(authoredRoot, { materials: true }); disposeTree(dynamicRoot);
      for (const material of [...Object.values(materials), ...buildingMaterials.values(), ...propMaterials.values()]) material?.dispose?.();
      if (exactTerrainPbrRuntime) exactTerrainPbrRuntime.dispose();
      else for (const material of exactTerrainMaterials.values()) material?.dispose?.();
      for (const texture of exactSurfaceTextures.values()) texture?.dispose?.();
      for (const texture of Object.values(textures)) texture?.dispose?.();
      if (container.__tz3d === api) delete container.__tz3d;
      container.replaceChildren();
    },
  };
  Object.defineProperty(container, '__tz3d', { value: api, configurable: true });
  return api;
}
