const FEATURE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/;

/**
 * Attach reviewed semantic IDs to hand-authored props without depending on their
 * array position. Matching is intentionally strict: a source edit that removes,
 * moves, or duplicates an anchor must stop the build instead of retargeting a
 * callout silently.
 */
export function applyPropFeatureManifest({ map, props, manifest }) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.map !== map || !Array.isArray(manifest.features)) {
    throw new Error(`${map}: invalid prop feature manifest`);
  }
  if (!Array.isArray(props)) throw new Error(`${map}: prop feature source is not an array`);

  const featureIds = new Set();
  const assignedIndexes = new Set();
  const assignments = [];

  for (const definition of manifest.features) {
    const featureId = definition?.featureId;
    const type = definition?.match?.type;
    const position = definition?.match?.position;
    const toleranceM = definition?.match?.toleranceM;

    if (typeof featureId !== 'string' || !FEATURE_ID.test(featureId) || !featureId.startsWith(`${map}.prop.`)) {
      throw new Error(`${map}: invalid prop featureId ${String(featureId)}`);
    }
    if (featureIds.has(featureId)) throw new Error(`${map}: duplicate prop featureId ${featureId}`);
    featureIds.add(featureId);
    if (typeof type !== 'string' || !type || !Array.isArray(position) || position.length !== 2 || !position.every(Number.isFinite)) {
      throw new Error(`${map}: ${featureId} requires a type and finite [x,z] position`);
    }
    if (!Number.isFinite(toleranceM) || toleranceM <= 0 || toleranceM > 1) {
      throw new Error(`${map}: ${featureId} toleranceM must be >0 and <=1 metre`);
    }

    const candidates = props.map((prop, index) => ({
      prop,
      index,
      distanceM: Number.isFinite(prop?.x) && Number.isFinite(prop?.z)
        ? Math.hypot(prop.x - position[0], prop.z - position[1])
        : Infinity,
    })).filter(({ prop, distanceM }) => prop?.type === type && distanceM <= toleranceM);

    if (candidates.length !== 1) {
      throw new Error(`${map}: ${featureId} ${type} @ ${position.join(',')} matched ${candidates.length} props within ${toleranceM} m`);
    }

    const [{ prop, index, distanceM }] = candidates;
    if (assignedIndexes.has(index)) throw new Error(`${map}: prop at source index ${index} matched more than one feature`);
    if (prop.featureId && prop.featureId !== featureId) {
      throw new Error(`${map}: prop at source index ${index} already has featureId ${prop.featureId}`);
    }
    assignedIndexes.add(index);
    prop.featureId = featureId;
    assignments.push({ featureId, sourceIndex: index, type, position: [prop.x, prop.z], distanceM });
  }

  return assignments;
}
