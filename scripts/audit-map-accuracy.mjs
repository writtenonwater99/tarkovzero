#!/usr/bin/env node
// Independent, held-out accuracy audit for the Customs map.
//
// This is intentionally not a terrain regression test. Training observations
// may establish evidence coverage, but only pre-declared held-out observations
// contribute horizontal, vertical, surface, and object-fidelity errors.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAP = 'customs';
const SCHEMA_VERSION = 1;
const PARTITIONS = new Set(['train', 'held-out']);
const SURFACES = new Set(['ground', 'road', 'bridge-deck', 'water', 'rock', 'floor', 'roof', 'underground', 'object']);
const ROLES = new Set([
  'ground-contact', 'road-centerline', 'bridge-deck', 'waterline', 'rock-contact',
  'floor-contact', 'roof-contact', 'underground-contact', 'object-center',
  'object-corner', 'door-threshold', 'orientation', 'dimension-endpoint',
]);
// Match the v3 terrain router: only ground and road may feed/sanity-check
// heightfield Y. Bridge decks and rocks are independent hard surfaces; sampling
// the terrain beneath them would recreate the exact category error this audit
// exists to catch.
const HEIGHTFIELD_SURFACES = new Set(['ground', 'road']);
const PRIORITY_COVERAGE_SURFACES = new Set(['ground', 'road', 'bridge-deck', 'rock']);
const OBJECT_ROLES = new Set(['object-center', 'object-corner', 'door-threshold', 'orientation', 'dimension-endpoint']);
const VERTICAL_ROLES = new Set([
  'ground-contact', 'road-centerline', 'bridge-deck', 'waterline', 'rock-contact',
  'floor-contact', 'roof-contact', 'underground-contact', 'door-threshold',
]);
const PINNED_SURFACES = new Set(['floor', 'roof', 'underground']);

export const CANONICAL_ACCURACY_GATES = Object.freeze({
  horizontal: Object.freeze({ medianM: 1.5, p95M: 3, maxM: 5, minimumHeldOut: 20 }),
  vertical: Object.freeze({ maeM: 0.5, p95M: 1.25, maxM: 3, minimumHeldOut: 30 }),
  coverage: Object.freeze({ traversableWithin25M: 0.8, priorityWithin10M: 0.95, minimumPriorityHeldOut: 10 }),
  surface: Object.freeze({ accuracy: 0.98, severeErrors: 0, minimumHeldOut: 30 }),
  bounds: Object.freeze({ unapprovedOutside: 0 }),
  objects: Object.freeze({ artifactStableIdRate: 1, centerP95M: 1, yawMaxDeg: 5, dimensionAbsM: 0.5, dimensionRelative: 0.1, minimumCenters: 10, minimumYaw: 3, minimumDimensions: 3 }),
  provenance: Object.freeze({ minimumHeldOutRoutes: 3, maximumGameBuilds: 1 }),
});

const finite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const round = (value, digits = 4) => Number.isFinite(value) ? +value.toFixed(digits) : null;
const pct = (value) => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'unmeasured';
const distance2d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const axisYawError = (a, b) => {
  const delta = Math.abs((((a - b) % 180) + 270) % 180 - 90);
  return Math.min(delta, 180 - delta);
};

export function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)];
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function pointOnSegment(point, a, b) {
  const length = (b.x - a.x) ** 2 + (b.z - a.z) ** 2;
  // Closed rings often repeat their first point. That creates a zero-length
  // final edge, which is only incident to that one coordinate—not every point
  // in the plane.
  if (length <= 1e-16) return Math.hypot(point.x - a.x, point.z - a.z) <= 1e-8;
  const cross = (point.z - a.z) * (b.x - a.x) - (point.x - a.x) * (b.z - a.z);
  if (Math.abs(cross) > 1e-8) return false;
  const dot = (point.x - a.x) * (b.x - a.x) + (point.z - a.z) * (b.z - a.z);
  return dot >= -1e-8 && dot <= length + 1e-8;
}

export function pointInPolygon(point, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = { x: Number(polygon[j][0]), z: Number(polygon[j][1]) };
    const b = { x: Number(polygon[i][0]), z: Number(polygon[i][1]) };
    if (pointOnSegment(point, a, b)) return true;
    const crosses = ((a.z > point.z) !== (b.z > point.z))
      && point.x < ((b.x - a.x) * (point.z - a.z)) / (b.z - a.z) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function pointInPolygonArea(point, outer, holes = []) {
  if (!pointInPolygon(point, outer)) return false;
  return !(Array.isArray(holes) ? holes : []).some((hole) => pointInPolygon(point, hole));
}

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x, dz = end.z - start.z;
  const length = dx * dx + dz * dz;
  if (length <= 1e-16) return Math.hypot(point.x - start.x, point.z - start.z);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.z - start.z) * dz) / length));
  return Math.hypot(point.x - (start.x + t * dx), point.z - (start.z + t * dz));
}

function distanceToPath(point, path) {
  if (!Array.isArray(path) || path.length < 2) return Infinity;
  let best = Infinity;
  for (let index = 1; index < path.length; index++) {
    best = Math.min(best, distanceToSegment(
      point,
      { x: Number(path[index - 1][0]), z: Number(path[index - 1][1]) },
      { x: Number(path[index][0]), z: Number(path[index][1]) },
    ));
  }
  return best;
}

function polygonCentroid(poly) {
  if (!Array.isArray(poly) || poly.length < 3) return null;
  let twiceArea = 0, x = 0, z = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const cross = Number(a[0]) * Number(b[1]) - Number(b[0]) * Number(a[1]);
    twiceArea += cross;
    x += (Number(a[0]) + Number(b[0])) * cross;
    z += (Number(a[1]) + Number(b[1])) * cross;
  }
  if (Math.abs(twiceArea) < 1e-9) {
    return { x: mean(poly.map((p) => Number(p[0]))), z: mean(poly.map((p) => Number(p[1]))) };
  }
  return { x: x / (3 * twiceArea), z: z / (3 * twiceArea) };
}

function polygonOrientedMetrics(poly, heightM) {
  if (!Array.isArray(poly) || poly.length < 3) return null;
  const points = poly.map(([x, z]) => ({ x: Number(x), z: Number(z) })).filter((point) => finite(point.x) && finite(point.z));
  if (points.length < 3) return null;
  let best = null;
  for (let index = 0; index < points.length; index++) {
    const a = points[index], b = points[(index + 1) % points.length];
    const dx = b.x - a.x, dz = b.z - a.z;
    if (dx * dx + dz * dz <= 1e-16) continue;
    const angle = Math.atan2(dz, dx), cos = Math.cos(angle), sin = Math.sin(angle);
    const u = points.map((point) => point.x * cos + point.z * sin);
    const v = points.map((point) => -point.x * sin + point.z * cos);
    const uSize = Math.max(...u) - Math.min(...u), vSize = Math.max(...v) - Math.min(...v);
    const candidate = { area: uSize * vSize, uSize, vSize, angle };
    if (!best || candidate.area < best.area - 1e-9) best = candidate;
  }
  if (!best) return null;
  const longAlongU = best.uSize >= best.vSize;
  const axisX = longAlongU ? Math.cos(best.angle) : -Math.sin(best.angle);
  const axisZ = longAlongU ? Math.sin(best.angle) : Math.cos(best.angle);
  const yaw = ((Math.atan2(axisX, axisZ) * 180) / Math.PI + 360) % 180;
  return {
    yaw,
    dimensions: {
      widthM: Math.min(best.uSize, best.vSize),
      lengthM: Math.max(best.uSize, best.vSize),
      heightM: finite(heightM) ? Number(heightM) : null,
    },
  };
}

export function sampleTerrain(terrain, x, z) {
  if (!terrain || !finite(terrain.x0) || !finite(terrain.z0) || !finite(terrain.step)
      || !Number.isInteger(terrain.cols) || !Number.isInteger(terrain.rows)
      || !Array.isArray(terrain.heights) || terrain.heights.length !== terrain.cols * terrain.rows) return null;
  const gx = (x - terrain.x0) / terrain.step, gz = (z - terrain.z0) / terrain.step;
  if (gx < 0 || gz < 0 || gx > terrain.cols - 1 || gz > terrain.rows - 1) return null;
  const x0 = Math.floor(gx), z0 = Math.floor(gz), x1 = Math.min(x0 + 1, terrain.cols - 1), z1 = Math.min(z0 + 1, terrain.rows - 1);
  const tx = gx - x0, tz = gz - z0;
  const at = (cx, cz) => Number(terrain.heights[cz * terrain.cols + cx]);
  const top = at(x0, z0) * (1 - tx) + at(x1, z0) * tx;
  const bottom = at(x0, z1) * (1 - tx) + at(x1, z1) * tx;
  return top * (1 - tz) + bottom * tz;
}

function referencePoint(observation) {
  const source = observation?.reference && typeof observation.reference === 'object' ? observation.reference : observation;
  return finite(source?.x) && finite(source?.y) && finite(source?.z)
    ? { x: Number(source.x), y: Number(source.y), z: Number(source.z), yaw: finite(source.yaw) ? Number(source.yaw) : null }
    : null;
}

function referenceSurfaceY(observation, reference) {
  if (observation.verticalReference === 'surface-contact') return reference.y;
  if (observation.verticalReference === 'player-origin' && finite(observation.surfaceOffsetM)) return reference.y - Number(observation.surfaceOffsetM);
  return null;
}

function featureIndex(model) {
  const errors = [], index = new Map(), buildingsBySource = new Map();
  for (const [buildingIndex, building] of (model?.buildings || []).entries()) {
    if (!building?.sourceKey) continue;
    if (buildingsBySource.has(building.sourceKey)) {
      errors.push(`model: duplicate emitted building sourceKey ${building.sourceKey}`);
      continue;
    }
    buildingsBySource.set(building.sourceKey, { building, buildingIndex });
  }
  const seenFeatures = new Set(), seenSources = new Set();
  const assignments = model?.features?.assignments;
  if (!Array.isArray(assignments)) return { index, errors: ['model: features.assignments must be an array'] };
  for (const [assignmentIndex, assignment] of assignments.entries()) {
    const label = `model: features.assignments[${assignmentIndex}]`;
    if (!assignment?.featureId || !assignment?.sourceKey) {
      errors.push(`${label} must contain featureId and sourceKey`);
      continue;
    }
    if (seenFeatures.has(assignment.featureId)) errors.push(`${label} duplicates featureId ${assignment.featureId}`);
    if (seenSources.has(assignment.sourceKey)) errors.push(`${label} duplicates sourceKey ${assignment.sourceKey}`);
    seenFeatures.add(assignment.featureId);
    seenSources.add(assignment.sourceKey);
    const emitted = buildingsBySource.get(assignment.sourceKey);
    if (!emitted || !Array.isArray(emitted.building?.poly) || emitted.building.poly.length < 3) {
      errors.push(`${label} is dangling; ${assignment.featureId} does not resolve to an emitted building`);
      continue;
    }
    if (assignment.emittedAs && assignment.emittedAs !== 'building') {
      errors.push(`${label} declares emittedAs=${assignment.emittedAs}, not building`);
      continue;
    }
    if (!index.has(assignment.featureId) && ![...index.values()].some((entry) => entry.assignment.sourceKey === assignment.sourceKey)) {
      index.set(assignment.featureId, { assignment, ...emitted });
    }
  }
  return { index, errors };
}

function resolveModelPoint(observation, reference, features) {
  const feature = features.get(observation.featureId);
  const poly = feature?.building?.poly;
  if (!poly) return null;
  const metrics = polygonOrientedMetrics(poly, feature.building.height);
  const common = { y: null, yaw: metrics?.yaw ?? null, dimensions: metrics?.dimensions ?? null, surfaceKind: 'object' };
  if (['object-center', 'orientation'].includes(observation.pointRole)) {
    const center = polygonCentroid(poly);
    return center ? { ...center, ...common, source: 'artifact-feature-centroid' } : null;
  }
  if (['object-corner', 'dimension-endpoint'].includes(observation.pointRole)) {
    const nearest = poly.map(([x, z]) => ({ x: Number(x), z: Number(z) })).sort((a, b) => distance2d(reference, a) - distance2d(reference, b))[0];
    return nearest ? { ...nearest, ...common, source: 'artifact-nearest-feature-corner' } : null;
  }
  // Door thresholds need an emitted doorway artifact, which Customs does not
  // yet provide. A building assignment alone must not manufacture one.
  return null;
}

function areaContains(point, value) {
  if (Array.isArray(value)) return pointInPolygon(point, value);
  return !!value && pointInPolygonArea(point, value.poly, value.holes);
}

function surfaceIndex(model, features) {
  const errors = [], index = new Map();
  const buildingsBySource = new Map((model?.buildings || [])
    .filter((building) => building?.sourceKey && Array.isArray(building?.poly) && building.poly.length >= 3)
    .map((building) => [building.sourceKey, building]));
  const canonicalName = (value) => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const rectangle = (box) => {
    const x1 = Math.min(Number(box.x1), Number(box.x2)), x2 = Math.max(Number(box.x1), Number(box.x2));
    const z1 = Math.min(Number(box.z1), Number(box.z2)), z2 = Math.max(Number(box.z1), Number(box.z2));
    return [x1, x2, z1, z2].every(Number.isFinite) ? [[x1, z1], [x2, z1], [x2, z2], [x1, z2]] : null;
  };
  for (const [surfacePosition, surface] of (model?.floorSurfaces || []).entries()) {
    const label = `model: floorSurfaces[${surfacePosition}]`;
    if (!/^customs\.surface\.[a-f0-9]{24}$/.test(String(surface?.stableId || ''))) {
      errors.push(`${label} must contain a stableId matching customs.surface.<24 hex>`);
      continue;
    }
    if (index.has(surface.stableId)) {
      errors.push(`${label} duplicates stableId ${surface.stableId}`);
      continue;
    }
    if (!PINNED_SURFACES.has(surface.classification) || !finite(surface.surfaceY)) {
      errors.push(`${label} must contain a floor/roof/underground classification and finite surfaceY`);
      continue;
    }
    if (surface.featureId) {
      const feature = features.get(surface.featureId);
      if (!feature || feature.assignment.sourceKey !== surface.buildingSourceKey) {
        errors.push(`${label} featureId ${surface.featureId} does not resolve to its emitted buildingSourceKey`);
        continue;
      }
    }
    const emittedBuilding = surface.buildingSourceKey ? buildingsBySource.get(surface.buildingSourceKey) : null;
    if (surface.buildingSourceKey && !emittedBuilding) {
      errors.push(`${label} buildingSourceKey ${surface.buildingSourceKey} does not resolve to an emitted building`);
      continue;
    }
    // Match the geometry the renderers actually expose. Named underground rows use the explicit
    // underground footprint; building-bound floor/roof rows use their emitted SVG polygon; legacy
    // extent rows use the matching committed floor rectangle. Cell-only evidence has no honest
    // footprint and intentionally remains unselectable for an independent capture.
    let binding = null, polygons = [];
    const surfaceName = canonicalName(surface.name);
    if (surface.classification === 'underground' && surfaceName) {
      polygons = (model?.underground || [])
        .filter((item) => canonicalName(item?.name) === surfaceName && Array.isArray(item?.poly) && item.poly.length >= 3)
        .map((item) => item.poly);
      if (polygons.length) binding = 'artifact-underground-footprint';
    }
    if (!polygons.length && emittedBuilding) {
      polygons = [emittedBuilding.poly];
      binding = 'artifact-building-source';
    }
    if (!polygons.length && String(surface.scope || '').startsWith('extent:')) {
      polygons = (model?.floorBoxes || [])
        .filter((box) => canonicalName(box?.layer) === canonicalName(surface.layer)
          && canonicalName(box?.name) === canonicalName(surface.name))
        .map(rectangle)
        .filter(Boolean);
      if (polygons.length) binding = 'artifact-floor-extent';
    }
    index.set(surface.stableId, { surface, polygons, binding });
  }
  return { index, errors };
}

function resolvePinnedSurface(observation, reference, surfaces) {
  if (!observation.surfaceId) return null;
  const entry = surfaces.get(observation.surfaceId);
  const surface = entry?.surface;
  if (!surface || !entry.polygons.some((poly) => pointInPolygon(reference, poly))) return null;
  if (surface.featureId && surface.featureId !== observation.featureId) return null;
  // surfaceId is model-addressing metadata, not a truth label. Classification,
  // floor and Y all come from that one emitted record. pointRole, surfaceKind,
  // floorIndex and held-out Y are deliberately absent from selection.
  return {
    surfaceKind: surface.classification,
    y: Number(surface.surfaceY),
    source: entry.binding,
    surfaceId: surface.stableId,
    floorIndex: surface.floorIndex,
  };
}

function resolveModelSurface(observation, reference, model, features, surfaces) {
  const pinned = resolvePinnedSurface(observation, reference, surfaces);
  if (pinned) return pinned;
  // A supplied stable selector is a model contract. Never silently fall back
  // to a label-shaped or x/z-only answer when it is dangling or mismatched.
  if (observation.surfaceId) return null;

  const featurePoint = resolveModelPoint(observation, reference, features);
  if (featurePoint || features.has(observation.featureId)) {
    return { surfaceKind: 'object', y: null, source: featurePoint?.source || 'artifact-feature' };
  }
  for (const bridge of model?.bridges || []) {
    if (distanceToPath(reference, bridge.path) <= Number(bridge.width || 0) / 2) {
      return { surfaceKind: 'bridge-deck', y: finite(bridge.surfaceY) ? Number(bridge.surfaceY) : null, source: 'artifact-bridge' };
    }
  }
  for (const water of model?.water || []) {
    if (pointInPolygonArea(reference, water.poly, water.holes)) {
      return { surfaceKind: 'water', y: finite(water.level) ? Number(water.level) : null, source: 'artifact-water' };
    }
  }
  for (const rock of model?.rocks || []) {
    if (!pointInPolygon(reference, rock.poly)) continue;
    const terrainY = sampleTerrain(model.terrain, reference.x, reference.z);
    return { surfaceKind: 'rock', y: finite(terrainY) && finite(rock.height) ? terrainY + Number(rock.height) : null, source: 'artifact-rock' };
  }

  const terrainY = sampleTerrain(model?.terrain, reference.x, reference.z);
  // A bare x/z inside a multi-level building or underground projection is
  // ambiguous. It remains unresolved unless stable feature + floor metadata
  // selected an emitted floorSurfaces record above.
  if ((model?.buildings || []).some((building) => pointInPolygon(reference, building.poly))) return null;
  if ((model?.underground || []).some((underground) => pointInPolygon(reference, underground.poly))) return null;
  for (const road of model?.roads || []) {
    if (distanceToPath(reference, road.path) <= Number(road.width || 0) / 2) {
      return { surfaceKind: 'road', y: terrainY, source: 'artifact-road' };
    }
  }
  if ((model?.land || []).some((land) => areaContains(reference, land))) {
    return { surfaceKind: 'ground', y: terrainY, source: 'artifact-land-heightfield' };
  }
  return null;
}

export function predictArtifactSurface(observation, model) {
  const reference = referencePoint(observation);
  if (!reference) return null;
  const featureContract = featureIndex(model);
  const surfaceContract = surfaceIndex(model, featureContract.index);
  if (featureContract.errors.length || surfaceContract.errors.length) return null;
  return resolveModelSurface(observation, reference, model, featureContract.index, surfaceContract.index);
}

function validateObservation(observation, label) {
  const errors = [];
  if (!observation || typeof observation !== 'object') return [`${label}: observation must be an object`];
  if (observation.schemaVersion !== SCHEMA_VERSION) errors.push(`${label}: schemaVersion must be ${SCHEMA_VERSION}`);
  if (observation.map !== MAP) errors.push(`${label}: map must be customs`);
  if (!/^customs\.[a-z0-9][a-z0-9._-]*$/.test(String(observation.featureId || ''))) errors.push(`${label}: invalid stable featureId`);
  if (!String(observation.tag || '').trim()) errors.push(`${label}: tag is required`);
  if (!ROLES.has(observation.pointRole)) errors.push(`${label}: invalid pointRole`);
  if (!SURFACES.has(observation.surfaceKind)) errors.push(`${label}: invalid surfaceKind`);
  if ((PINNED_SURFACES.has(observation.surfaceKind)
      || ['floor-contact', 'roof-contact', 'underground-contact'].includes(observation.pointRole))
      && !/^customs\.surface\.[a-f0-9]{24}$/.test(String(observation.surfaceId || ''))) {
    errors.push(`${label}: layered surface observations require surfaceId matching an emitted customs.surface.<24 hex> stableId`);
  }
  if (!PARTITIONS.has(observation.partition)) errors.push(`${label}: partition must be train or held-out`);
  if (!/^customs\.[a-z0-9][a-z0-9._-]*$/.test(String(observation.routeId || ''))) errors.push(`${label}: invalid routeId`);
  if (!String(observation.gameBuild || '').trim()) errors.push(`${label}: gameBuild is required`);
  if (!finite(observation.confidence) || Number(observation.confidence) < 0 || Number(observation.confidence) > 1) errors.push(`${label}: confidence must be between 0 and 1`);
  if (!String(observation.screenshotId || '').trim()) errors.push(`${label}: screenshotId is required`);
  if (!referencePoint(observation)) errors.push(`${label}: finite x, y, and z reference coordinates are required`);
  if (!['player-origin', 'surface-contact'].includes(observation.verticalReference)) errors.push(`${label}: invalid verticalReference`);
  if (!String(observation.source || '').trim()) errors.push(`${label}: independent capture source is required`);
  if (Object.hasOwn(observation, 'model')) errors.push(`${label}: observation.model is forbidden; predictions come only from the emitted model artifact`);
  if (observation.source === 'eft-screenshot-filename' && observation.verticalReference !== 'player-origin') {
    errors.push(`${label}: EFT screenshot filenames always record player-origin, never surface-contact`);
  }
  if (observation.verticalReference === 'surface-contact' && observation.source !== 'independent-surface-survey') {
    errors.push(`${label}: surface-contact requires the separate independent-surface-survey capture source`);
  }
  if (observation.verticalReference === 'player-origin' && observation.surfaceOffsetM !== null && observation.surfaceOffsetM !== undefined && !finite(observation.surfaceOffsetM)) errors.push(`${label}: surfaceOffsetM must be finite or null`);
  if (observation.boundsApproved && !String(observation.boundsReason || '').trim()) errors.push(`${label}: boundsApproved requires boundsReason`);
  return errors;
}

export function terrainAuditCells(model) {
  const terrain = model?.terrain;
  if (!terrain || !Array.isArray(model?.land)) return [];
  const cells = [];
  for (let row = 0; row < terrain.rows; row++) {
    for (let col = 0; col < terrain.cols; col++) {
      const point = { x: terrain.x0 + col * terrain.step, z: terrain.z0 + row * terrain.step };
      if (!model.land.some((land) => areaContains(point, land))) continue;
      if ((model.water || []).some((water) => pointInPolygonArea(point, water?.poly, water?.holes))) continue;
      cells.push(point);
    }
  }
  return cells;
}

function nearestDistance(point, evidence) {
  let best = Infinity;
  for (const other of evidence) best = Math.min(best, distance2d(point, other));
  return best;
}

function gate(pass, details = {}) {
  return { pass: !!pass, ...details };
}

export function auditAccuracy({ observations, model, modelArtifactSha256 = null }) {
  const errors = [];
  const artifactSha256 = modelArtifactSha256 || createHash('sha256').update(JSON.stringify(model)).digest('hex');
  if (model?.map !== MAP) errors.push('model: expected public/data/customs-3d.json with map=customs');
  const declaredHeightfieldBuckets = model?.terrain?.evidence?.heightfieldBuckets;
  if (declaredHeightfieldBuckets && JSON.stringify(declaredHeightfieldBuckets) !== JSON.stringify(['ground', 'road'])) {
    errors.push(`model: terrain evidence must declare heightfieldBuckets [ground, road], received ${JSON.stringify(declaredHeightfieldBuckets)}`);
  }
  const featureContract = featureIndex(model);
  errors.push(...featureContract.errors);
  const features = featureContract.index;
  const surfaceContract = surfaceIndex(model, features);
  errors.push(...surfaceContract.errors);
  const surfaces = surfaceContract.index;
  const seenScreenshots = new Set();
  for (let i = 0; i < observations.length; i++) {
    errors.push(...validateObservation(observations[i], `observation[${i}]`));
    const screenshot = observations[i]?.screenshotId;
    if (screenshot && seenScreenshots.has(screenshot)) errors.push(`observation[${i}]: duplicate screenshotId ${screenshot}`);
    if (screenshot) seenScreenshots.add(screenshot);
  }

  const routes = new Map();
  for (const observation of observations) {
    if (!observation?.routeId || !PARTITIONS.has(observation.partition)) continue;
    if (!routes.has(observation.routeId)) routes.set(observation.routeId, new Set());
    routes.get(observation.routeId).add(observation.partition);
  }
  const contaminatedRoutes = [...routes].filter(([, partitions]) => partitions.size > 1).map(([route]) => route);
  if (contaminatedRoutes.length) errors.push(`partition leakage: route(s) appear in train and held-out: ${contaminatedRoutes.join(', ')}`);

  const valid = observations.filter((observation, index) => validateObservation(observation, `observation[${index}]`).length === 0);
  const train = valid.filter((item) => item.partition === 'train' && Number(item.confidence) >= 0.5);
  const heldOut = valid.filter((item) => item.partition === 'held-out' && Number(item.confidence) >= 0.8);
  const excludedLowConfidence = valid.length - train.length - heldOut.length;
  const heldOutRoutes = new Set(heldOut.map((item) => item.routeId));
  const builds = new Set([...train, ...heldOut].map((item) => item.gameBuild));
  const comparisons = heldOut.map((observation) => {
    const reference = referencePoint(observation);
    const predicted = resolveModelPoint(observation, reference, features);
    const predictedSurface = resolveModelSurface(observation, reference, model, features, surfaces);
    const predictedY = finite(predictedSurface?.y) ? predictedSurface.y : null;
    const surfaceY = referenceSurfaceY(observation, reference);
    return {
      observation,
      reference,
      predicted,
      predictedSurface,
      horizontalError: predicted ? distance2d(reference, predicted) : null,
      verticalError: finite(surfaceY) && finite(predictedY) ? Math.abs(surfaceY - predictedY) : null,
      predictedY: finite(predictedY) ? predictedY : null,
      surfaceY,
    };
  });

  const horizontalAttempts = comparisons.filter((item) => OBJECT_ROLES.has(item.observation.pointRole));
  const horizontalResolved = horizontalAttempts.filter((item) => finite(item.horizontalError));
  const horizontal = horizontalResolved.map((item) => item.horizontalError);
  const horizontalStats = {
    count: horizontalAttempts.length,
    resolved: horizontalResolved.length,
    unresolved: horizontalAttempts.length - horizontalResolved.length,
    resolvedRate: horizontalAttempts.length ? round(horizontalResolved.length / horizontalAttempts.length) : null,
    medianM: round(percentile(horizontal, 0.5)),
    p95M: round(percentile(horizontal, 0.95)),
    maxM: round(horizontal.length ? Math.max(...horizontal) : null),
  };
  const verticalAttempts = comparisons.filter((item) => VERTICAL_ROLES.has(item.observation.pointRole) && finite(item.surfaceY));
  const verticalResolved = verticalAttempts.filter((item) => finite(item.verticalError));
  const vertical = verticalResolved.map((item) => item.verticalError);
  const verticalStats = {
    count: verticalAttempts.length,
    resolved: verticalResolved.length,
    unresolved: verticalAttempts.length - verticalResolved.length,
    resolvedRate: verticalAttempts.length ? round(verticalResolved.length / verticalAttempts.length) : null,
    maeM: round(mean(vertical)),
    p95M: round(percentile(vertical, 0.95)),
    maxM: round(vertical.length ? Math.max(...vertical) : null),
  };

  const trainCoverageEvidence = train.filter((item) => HEIGHTFIELD_SURFACES.has(item.surfaceKind)).map(referencePoint).filter(Boolean);
  const priorityCoverageEvidence = train.filter((item) => PRIORITY_COVERAGE_SURFACES.has(item.surfaceKind)).map(referencePoint).filter(Boolean);
  const cells = terrainAuditCells(model);
  const coveredCells = trainCoverageEvidence.length ? cells.filter((cell) => nearestDistance(cell, trainCoverageEvidence) <= 25).length : 0;
  const traversableWithin25M = cells.length ? coveredCells / cells.length : null;
  const priority = heldOut.filter((item) => item.priority).map(referencePoint).filter(Boolean);
  const priorityCovered = priorityCoverageEvidence.length ? priority.filter((point) => nearestDistance(point, priorityCoverageEvidence) <= 10).length : 0;
  const priorityWithin10M = priority.length ? priorityCovered / priority.length : null;
  const coverageStats = { terrainCells: cells.length, trainingEvidence: trainCoverageEvidence.length, priorityTrainingEvidence: priorityCoverageEvidence.length, within25M: coveredCells, traversableWithin25M: round(traversableWithin25M), priorityHeldOut: priority.length, priorityWithin10M: round(priorityWithin10M) };

  const surfaceAttempts = comparisons;
  const surfaceResolved = surfaceAttempts.filter((item) => item.predictedSurface?.surfaceKind);
  const surfaceCorrect = surfaceResolved.filter((item) => item.predictedSurface.surfaceKind === item.observation.surfaceKind).length;
  const severeSurfaceErrors = surfaceResolved.filter((item) => ['floor', 'water'].includes(item.observation.surfaceKind) && item.predictedSurface.surfaceKind === 'ground');
  const byObservedKind = Object.fromEntries([...SURFACES].sort().map((kind) => {
    const eligible = surfaceAttempts.filter((item) => item.observation.surfaceKind === kind);
    const resolved = eligible.filter((item) => item.predictedSurface?.surfaceKind);
    const correct = resolved.filter((item) => item.predictedSurface.surfaceKind === kind).length;
    return [kind, {
      count: eligible.length,
      resolved: resolved.length,
      unresolved: eligible.length - resolved.length,
      resolvedRate: eligible.length ? round(resolved.length / eligible.length) : null,
      correct,
      accuracy: eligible.length ? round(correct / eligible.length) : null,
    }];
  }));
  const surfaceStats = {
    count: surfaceAttempts.length,
    resolved: surfaceResolved.length,
    unresolved: surfaceAttempts.length - surfaceResolved.length,
    resolvedRate: surfaceAttempts.length ? round(surfaceResolved.length / surfaceAttempts.length) : null,
    correct: surfaceCorrect,
    accuracy: surfaceAttempts.length ? round(surfaceCorrect / surfaceAttempts.length) : null,
    severeErrors: severeSurfaceErrors.length,
    byObservedKind,
  };

  const limit = model?.limit;
  const boundsRows = [];
  for (const observation of valid) {
    const reference = referencePoint(observation);
    const predicted = resolveModelPoint(observation, reference, features);
    if (Array.isArray(limit) && !pointInPolygon(reference, limit)) boundsRows.push({ screenshotId: observation.screenshotId, kind: 'reference', approved: !!observation.boundsApproved, reason: observation.boundsReason || null });
    if (predicted && Array.isArray(limit) && !pointInPolygon(predicted, limit)) boundsRows.push({ screenshotId: observation.screenshotId, kind: 'model', approved: !!observation.boundsApproved, reason: observation.boundsReason || null });
  }
  const unapprovedOutside = boundsRows.filter((row) => !row.approved);
  const boundsStats = { outside: boundsRows.length, approved: boundsRows.length - unapprovedOutside.length, unapproved: unapprovedOutside.length, rows: boundsRows };

  const objectRows = comparisons.filter((item) => OBJECT_ROLES.has(item.observation.pointRole));
  const resolvedObjectRows = objectRows.filter((item) => item.predicted);
  const uniqueObjectFeatures = new Set(objectRows.map((item) => item.observation.featureId));
  const artifactFeatures = [...uniqueObjectFeatures].filter((id) => features.has(id));
  const centers = objectRows.filter((item) => item.observation.pointRole === 'object-center' && finite(item.horizontalError));
  const centerErrors = centers.map((item) => item.horizontalError);
  const yawRows = objectRows.filter((item) => item.observation.pointRole === 'orientation' && finite(item.reference.yaw) && finite(item.predicted?.yaw));
  const yawErrors = yawRows.map((item) => axisYawError(item.reference.yaw, item.predicted.yaw));
  const dimensionRows = [];
  for (const item of objectRows) {
    if (item.observation.pointRole !== 'dimension-endpoint') continue;
    const referenceDimensions = item.observation.referenceDimensions;
    const modelDimensions = item.predicted?.dimensions;
    if (!referenceDimensions || !modelDimensions) continue;
    for (const key of ['widthM', 'lengthM', 'heightM']) {
      if (!finite(referenceDimensions[key]) || !finite(modelDimensions[key]) || Number(referenceDimensions[key]) <= 0) continue;
      const absoluteM = Math.abs(Number(referenceDimensions[key]) - Number(modelDimensions[key]));
      dimensionRows.push({ screenshotId: item.observation.screenshotId, featureId: item.observation.featureId, dimension: key, absoluteM, relative: absoluteM / Number(referenceDimensions[key]) });
    }
  }
  const dimensionPassing = dimensionRows.filter((row) => row.absoluteM <= CANONICAL_ACCURACY_GATES.objects.dimensionAbsM || row.relative <= CANONICAL_ACCURACY_GATES.objects.dimensionRelative).length;
  const objectStats = {
    heldOutRecords: objectRows.length,
    resolvedRecords: resolvedObjectRows.length,
    unresolvedRecords: objectRows.length - resolvedObjectRows.length,
    resolvedRate: objectRows.length ? round(resolvedObjectRows.length / objectRows.length) : null,
    uniqueFeatures: uniqueObjectFeatures.size,
    artifactStableIds: artifactFeatures.length,
    artifactStableIdRate: uniqueObjectFeatures.size ? round(artifactFeatures.length / uniqueObjectFeatures.size) : null,
    centers: centers.length,
    centerP95M: round(percentile(centerErrors, 0.95)),
    yaw: yawRows.length,
    yawMaxDeg: round(yawErrors.length ? Math.max(...yawErrors) : null),
    dimensions: dimensionRows.length,
    dimensionPassing,
    dimensionFailures: dimensionRows.length - dimensionPassing,
  };

  const G = CANONICAL_ACCURACY_GATES;
  const gates = {
    independentEvidence: gate(train.length > 0 && heldOut.length > 0 && heldOutRoutes.size >= G.provenance.minimumHeldOutRoutes && builds.size <= G.provenance.maximumGameBuilds && !contaminatedRoutes.length, { train: train.length, heldOut: heldOut.length, heldOutRoutes: heldOutRoutes.size, gameBuilds: [...builds], contaminatedRoutes }),
    horizontal: gate(horizontalAttempts.length >= G.horizontal.minimumHeldOut && horizontalStats.unresolved === 0 && horizontalStats.medianM <= G.horizontal.medianM && horizontalStats.p95M <= G.horizontal.p95M && horizontalStats.maxM <= G.horizontal.maxM, horizontalStats),
    vertical: gate(verticalAttempts.length >= G.vertical.minimumHeldOut && verticalStats.unresolved === 0 && verticalStats.maeM <= G.vertical.maeM && verticalStats.p95M <= G.vertical.p95M && verticalStats.maxM <= G.vertical.maxM, verticalStats),
    coverage: gate(finite(traversableWithin25M) && traversableWithin25M >= G.coverage.traversableWithin25M && priority.length >= G.coverage.minimumPriorityHeldOut && finite(priorityWithin10M) && priorityWithin10M >= G.coverage.priorityWithin10M, coverageStats),
    surface: gate(surfaceAttempts.length >= G.surface.minimumHeldOut && surfaceStats.unresolved === 0 && surfaceStats.accuracy >= G.surface.accuracy && severeSurfaceErrors.length === G.surface.severeErrors, surfaceStats),
    bounds: gate(unapprovedOutside.length === G.bounds.unapprovedOutside, boundsStats),
    objects: gate(uniqueObjectFeatures.size > 0 && objectStats.unresolvedRecords === 0 && objectStats.artifactStableIdRate === G.objects.artifactStableIdRate && centers.length >= G.objects.minimumCenters && objectStats.centerP95M <= G.objects.centerP95M && yawRows.length >= G.objects.minimumYaw && objectStats.yawMaxDeg <= G.objects.yawMaxDeg && dimensionRows.length >= G.objects.minimumDimensions && objectStats.dimensionFailures === 0, objectStats),
  };

  const rowIdentity = (item) => ({ screenshotId: item.observation.screenshotId, featureId: item.observation.featureId, surfaceId: item.observation.surfaceId || null });
  const horizontalOutliers = horizontalAttempts.filter((item) => finite(item.horizontalError) && item.horizontalError > G.horizontal.maxM).map((item) => ({ ...rowIdentity(item), errorM: round(item.horizontalError) }));
  const verticalOutliers = verticalAttempts.filter((item) => finite(item.verticalError) && item.verticalError > G.vertical.maxM).map((item) => ({ ...rowIdentity(item), errorM: round(item.verticalError) }));
  const certified = errors.length === 0 && Object.values(gates).every((item) => item.pass);
  return {
    schemaVersion: SCHEMA_VERSION,
    audit: 'customs-independent-accuracy',
    map: MAP,
    modelArtifactSha256: artifactSha256,
    certified,
    truthPolicy: 'Only pre-declared held-out observations count as accuracy. Training observations count only toward evidence coverage. Predictions come only from the emitted model artifact identified by modelArtifactSha256.',
    evidence: { total: observations.length, valid: valid.length, train: train.length, heldOut: heldOut.length, heldOutRoutes: heldOutRoutes.size, excludedLowConfidence, gameBuilds: [...builds] },
    gates,
    outliers: {
      horizontal: horizontalOutliers,
      vertical: verticalOutliers,
      unresolvedHorizontal: horizontalAttempts.filter((item) => !finite(item.horizontalError)).map(rowIdentity),
      unresolvedVertical: verticalAttempts.filter((item) => !finite(item.verticalError)).map(rowIdentity),
      unresolvedSurface: surfaceAttempts.filter((item) => !item.predictedSurface?.surfaceKind).map(rowIdentity),
      bounds: unapprovedOutside,
    },
    errors,
  };
}

export function createBootstrapDocument() {
  return {
    schemaVersion: SCHEMA_VERSION,
    documentType: 'tarkovzero-independent-accuracy-evidence',
    map: MAP,
    status: 'bootstrap-no-measurements',
    coordinateFrame: 'eft-unity-world-metres-y-up',
    truthPolicy: [
      'Declare route partition before capture; a route may never appear in both train and held-out.',
      'Do not copy generated terrain or object positions into reference x/y/z.',
      'Observations may not contain model predictions; predictions come from the emitted, hashed artifact.',
      'Floor, roof, and underground observations predeclare an emitted, geometry-bound floorSurfaces stableId; held-out labels and Y never select a model layer.',
      'EFT screenshot records are always player-origin. Their Y is not surface elevation unless surfaceOffsetM is independently calibrated.',
      'Training residuals are diagnostics only; certification uses held-out observations.',
    ],
    canonicalGates: CANONICAL_ACCURACY_GATES,
    capturePlan: [],
    observations: [],
  };
}

function parseEvidenceText(raw, file) {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { observations: parsed, document: null };
    if (parsed && typeof parsed === 'object') {
      if (parsed.recordType === 'tarkovzero-survey-observation' || (parsed.partition && parsed.screenshotId)) {
        return { observations: [parsed], document: null };
      }
      return { observations: parsed.observations || parsed.points || [], document: parsed };
    }
    throw new Error('top-level JSON must be an object or array');
  } catch (jsonError) {
    const observations = [];
    for (const [index, line] of raw.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try { observations.push(JSON.parse(line)); }
      catch (error) { throw new Error(`${file}:${index + 1}: ${error.message}`); }
    }
    if (!observations.length) throw new Error(`${file}: ${jsonError.message}`);
    return { observations, document: null };
  }
}

export function readEvidenceFiles(files) {
  const observations = [], documents = [];
  for (const file of files) {
    const parsed = parseEvidenceText(fs.readFileSync(file, 'utf8'), file);
    observations.push(...parsed.observations);
    if (parsed.document) documents.push(parsed.document);
  }
  return { observations, documents };
}

export function formatReport(report) {
  const line = (name, value) => `${report.gates[name].pass ? 'PASS' : 'FAIL'}  ${value}`;
  const metric = (value, unit) => value === null || value === undefined ? 'unmeasured' : `${value}${unit}`;
  const h = report.gates.horizontal, v = report.gates.vertical, c = report.gates.coverage, s = report.gates.surface, b = report.gates.bounds, o = report.gates.objects;
  return [
    'Customs independent accuracy audit',
    `Evidence: ${report.evidence.train} train, ${report.evidence.heldOut} held-out, ${report.evidence.heldOutRoutes} held-out route(s), build(s): ${report.evidence.gameBuilds.join(', ') || 'none'}`,
    ...(report.evidence.heldOut ? [] : ['HARD FAIL: no held-out first-party survey exists; generated/in-sample residuals cannot certify accuracy.']),
    line('independentEvidence', `independent evidence (requires train + held-out, >=${CANONICAL_ACCURACY_GATES.provenance.minimumHeldOutRoutes} held-out routes, one game build; routes cannot cross partitions)`),
    line('horizontal', `held-out horizontal eligible=${h.count}, resolved=${h.resolved} (${pct(h.resolvedRate)}), median=${metric(h.medianM, 'm')}, p95=${metric(h.p95M, 'm')}, max=${metric(h.maxM, 'm')}`),
    line('vertical', `held-out vertical eligible=${v.count}, resolved=${v.resolved} (${pct(v.resolvedRate)}), MAE=${metric(v.maeM, 'm')}, p95=${metric(v.p95M, 'm')}, max=${metric(v.maxM, 'm')}`),
    line('coverage', `training evidence covers ${pct(c.traversableWithin25M)} of traversable cells within 25m; ${pct(c.priorityWithin10M)} of ${c.priorityHeldOut} priority held-out points within 10m`),
    line('surface', `held-out surface eligible=${s.count}, resolved=${s.resolved} (${pct(s.resolvedRate)}), accuracy=${pct(s.accuracy)}, severe floor/water→ground errors=${s.severeErrors}`),
    line('bounds', `outside playable limit=${b.outside}, unapproved=${b.unapproved}`),
    line('objects', `resolved=${o.resolvedRecords}/${o.heldOutRecords} (${pct(o.resolvedRate)}), stable artifact IDs=${pct(o.artifactStableIdRate)}, centers n=${o.centers} p95=${metric(o.centerP95M, 'm')}, yaw n=${o.yaw} max=${metric(o.yawMaxDeg, '°')}, dimensions n=${o.dimensions} failures=${o.dimensionFailures}`),
    report.errors.length ? `Schema/evidence errors:\n- ${report.errors.join('\n- ')}` : 'Schema/evidence errors: none',
    report.certified ? 'CERTIFIED: all independent Customs accuracy gates pass.' : 'NOT CERTIFIED: one or more independent gates failed. In-sample fit is not substituted.',
  ].join('\n');
}

function usage(message) {
  if (message) console.error(message);
  console.error(`usage:
  node scripts/audit-map-accuracy.mjs [--input <json-or-jsonl>]... [--model <customs-3d.json>] [--json]
  node scripts/audit-map-accuracy.mjs --bootstrap [--out <new-template.json>] [--json]

Default input: data/customs-audit-anchors.json
Default model: public/data/customs-3d.json

Exit 0 means every held-out gate passed (or bootstrap mode completed); exit 1 means not certified; exit 2 means bad input/configuration.`);
  process.exit(message ? 2 : 0);
}

function parseArgs(argv) {
  const result = { inputs: [], model: path.join(ROOT, 'public', 'data', 'customs-3d.json'), json: false, bootstrap: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [name, inline] = arg.split(/=(.*)/s, 2);
    if (name === '--input') result.inputs.push(path.resolve(inline ?? argv[++i] ?? usage('--input requires a file')));
    else if (name === '--model') result.model = path.resolve(inline ?? argv[++i] ?? usage('--model requires a file'));
    else if (name === '--out') result.out = path.resolve(inline ?? argv[++i] ?? usage('--out requires a file'));
    else if (name === '--json') result.json = true;
    else if (name === '--bootstrap') result.bootstrap = true;
    else if (name === '--help' || name === '-h') usage();
    else usage(`unknown option: ${arg}`);
  }
  if (!result.inputs.length) result.inputs.push(path.join(ROOT, 'data', 'customs-audit-anchors.json'));
  return result;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.bootstrap) {
      const document = createBootstrapDocument();
      if (options.out) fs.writeFileSync(options.out, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      if (options.json) console.log(JSON.stringify({ mode: 'bootstrap', certification: false, output: options.out, template: document }, null, 2));
      else console.log(`BOOTSTRAP ONLY: created/validated an empty Customs evidence template${options.out ? ` at ${options.out}` : ''}. No accuracy claim was made.`);
      process.exit(0);
    }
    const evidence = readEvidenceFiles(options.inputs);
    for (const document of evidence.documents) {
      if (document.schemaVersion !== SCHEMA_VERSION || document.map !== MAP) throw new Error('evidence document must be schemaVersion 1 and map customs');
      if (document.canonicalGates && JSON.stringify(document.canonicalGates) !== JSON.stringify(CANONICAL_ACCURACY_GATES)) {
        throw new Error('evidence document canonicalGates drifted from the executable contract');
      }
    }
    const modelBytes = fs.readFileSync(options.model);
    const model = JSON.parse(modelBytes.toString('utf8'));
    const report = auditAccuracy({
      observations: evidence.observations,
      model,
      modelArtifactSha256: createHash('sha256').update(modelBytes).digest('hex'),
    });
    console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report));
    process.exit(report.certified ? 0 : 1);
  } catch (error) {
    console.error(`accuracy audit configuration error: ${error.message}`);
    process.exit(2);
  }
}
