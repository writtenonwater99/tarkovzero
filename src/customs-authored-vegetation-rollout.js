/**
 * Pure rollout router for the independently-authored Customs vegetation pack.
 *
 * The exact local vegetation plan is the single source of placement truth. This module partitions
 * that one full plan into two complementary subplans — placements admitted as authored GLB assets
 * and everything else, which stays procedural — without loading anything, touching the scene
 * graph, consulting the camera, or wiring a renderer. It is a pure, synchronous function of its
 * inputs.
 *
 * Routing is fail-closed:
 *   - a placement is never silently duplicated (duplicate flatIndex) or dropped (lost);
 *   - an admitted asset the catalog does not know about is an error;
 *   - a placement whose exact binding resolves but whose prototype name disagrees is an error;
 *   - a placement whose name claims an admitted authored asset while its exact binding is absent
 *     is ambiguous and rejected.
 *
 * The two subplans share the exact flatIndex space disjointly, and the invariant
 * `authored.renderedCount + procedural.renderedCount === original.renderedCount` always holds.
 *
 * `requireCompleteCatalog` defaults to strict. Passing `false` is reserved for the future hybrid
 * call seam that combines a partial authored catalog with the procedural fallback.
 */

import {
  CustomsAuthoredVegetationContractError,
  joinCustomsAuthoredVegetationPrototypeName,
  normalizeCustomsAuthoredVegetationCatalog,
  probeCustomsAuthoredVegetationBinding,
} from './customs-authored-vegetation.js';

/**
 * Every classification the procedural renderer knows how to draw.
 *
 * A subplan is emitted with all five keys present even when a class routed entirely to the other
 * half, so the procedural builder can consume `procedural.groups.<class>` without a `?? []` at
 * every call site — and so "this class is empty" is a visible zero rather than a missing key.
 */
export const CUSTOMS_VEGETATION_CLASSIFICATIONS = Object.freeze([
  'pine',
  'deciduous',
  'shrub',
  'stump',
  'ground-plant',
]);

function fail(message, code = 'ERR_CUSTOMS_AUTHORED_VEGETATION_ROLLOUT', details = null) {
  throw new CustomsAuthoredVegetationContractError(message, code, details);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function text(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    fail(`${label} must be a non-empty exact string`);
  }
  return value;
}

function safeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative safe integer`);
  return value;
}

/** Validate and deterministically order the explicit admitted-asset allowlist. */
function normalizedAdmittedAssetIds(value, catalog) {
  if (!Array.isArray(value) || value.length === 0) fail('admittedAssetIds must be a non-empty array');
  const admitted = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const assetId = value[index];
    if (typeof assetId !== 'string' || assetId.length === 0 || assetId.trim() !== assetId) {
      fail(`admittedAssetIds[${index}] must be a non-empty exact string`);
    }
    const asset = catalog.assetsById[assetId];
    if (!asset) {
      fail(
        `admitted asset ${assetId} is unsupported by the catalog`,
        'ERR_CUSTOMS_VEGETATION_UNSUPPORTED_ADMITTED_ASSET',
        { assetId },
      );
    }
    if (!seen.has(assetId)) {
      seen.add(assetId);
      admitted.push(assetId);
    }
  }
  admitted.sort((a, b) => a.localeCompare(b));
  return Object.freeze(admitted);
}

/** Read the identity fields this router needs; placement bodies pass through untouched. */
function normalizeIdentity(placement, label) {
  const source = object(placement, label);
  return {
    flatIndex: safeInteger(source.flatIndex, `${label}.flatIndex`),
    tileId: text(source.tileId, `${label}.tileId`),
    prototypeId: text(source.prototypeId, `${label}.prototypeId`),
    prototypeName: text(source.prototypeName, `${label}.prototypeName`),
    classification: text(source.classification, `${label}.classification`),
    source,
  };
}

function buildSubplan(entries, originalPlan) {
  const groupsByClassification = new Map();
  const assetIds = new Set();
  const placements = [];
  let unsupportedPrototypeCount = 0;
  for (const entry of entries) {
    const { identity, assetId } = entry;
    const bucket = groupsByClassification.get(identity.classification);
    if (bucket) bucket.push(identity.source);
    else groupsByClassification.set(identity.classification, [identity.source]);
    if (assetId === null) unsupportedPrototypeCount += 1;
    else assetIds.add(assetId);
    placements.push(identity.source);
  }
  const classifications = [...new Set([
    ...CUSTOMS_VEGETATION_CLASSIFICATIONS,
    ...groupsByClassification.keys(),
  ])].sort((a, b) => a.localeCompare(b));
  const counts = Object.fromEntries(classifications.map((classification) => [
    classification,
    groupsByClassification.get(classification)?.length ?? 0,
  ]));
  const groups = Object.fromEntries(classifications.map((classification) => [
    classification,
    Object.freeze(groupsByClassification.get(classification) ?? []),
  ]));
  return Object.freeze({
    // Shaped exactly like `buildCustomsLocalVegetationRenderPlan`'s output so either half can be
    // handed straight to the procedural builder or to the authored adapter with no adaptation.
    // `sourceCount`/`culledCount` describe the SHARED source: this half's rendered placements plus
    // the other half's plus the plan's own out-of-scope culls always re-add to the source count.
    sourceCount: originalPlan.sourceCount,
    renderedCount: placements.length,
    culledCount: originalPlan.sourceCount - placements.length,
    counts: Object.freeze(counts),
    groups: Object.freeze(groups),
    placements: Object.freeze(placements),
    assetIds: Object.freeze([...assetIds].sort((a, b) => a.localeCompare(b))),
    unsupportedPrototypeCount,
  });
}

/**
 * The one invariant that makes the hybrid router real rather than decorative, asserted in code.
 *
 * Every placement the vegetation source declared ends up in exactly one of three places: drawn by
 * the authored pack, drawn procedurally, or culled outside the rendered scope by the plan itself.
 * No placement is duplicated across the two halves and none is silently dropped between them.
 */
export function assertCustomsAuthoredVegetationRouteTotals(route) {
  const authored = route?.authored?.renderedCount;
  const procedural = route?.procedural?.renderedCount;
  const rendered = route?.original?.renderedCount;
  const culled = route?.original?.culledCount;
  const source = route?.original?.sourceCount;
  if (![authored, procedural, rendered, culled, source].every(Number.isSafeInteger)) {
    fail('vegetation route totals are not fully populated integers');
  }
  if (authored + procedural !== rendered) {
    fail(
      `vegetation route lost placements: authored ${authored} + procedural ${procedural} != rendered ${rendered}`,
      'ERR_CUSTOMS_VEGETATION_ROUTE_TOTALS',
      { authored, procedural, rendered, culled, source },
    );
  }
  if (authored + procedural + culled !== source) {
    fail(
      `vegetation route lost placements: authored ${authored} + procedural ${procedural} + culled ${culled} != source ${source}`,
      'ERR_CUSTOMS_VEGETATION_ROUTE_TOTALS',
      { authored, procedural, rendered, culled, source },
    );
  }
  const flatIndices = new Set();
  for (const half of [route.authored, route.procedural]) {
    for (const placement of half.placements) {
      const flatIndex = placement?.flatIndex;
      if (!Number.isSafeInteger(flatIndex)) fail('a routed placement lost its flatIndex');
      if (flatIndices.has(flatIndex)) {
        fail(
          `vegetation route duplicated exact flat index ${flatIndex}`,
          'ERR_CUSTOMS_VEGETATION_ROUTE_TOTALS',
          { flatIndex },
        );
      }
      flatIndices.add(flatIndex);
    }
  }
  if (flatIndices.size !== rendered) fail('vegetation route flat-index coverage is incomplete');
  return Object.freeze({ authored, procedural, rendered, culled, source });
}

/**
 * Partition one full exact vegetation plan into authored and procedural complementary subplans.
 *
 * @param {object} options
 * @param {object} options.plan             Full exact plan: `{ groups, renderedCount?, counts?, sourceCount?, culledCount? }`.
 * @param {object} [options.packIndex]      Offline pack index used to normalize the catalog when `catalog` is absent.
 * @param {object} [options.catalog]        Pre-normalized catalog; takes precedence over `packIndex`.
 * @param {string[]} options.admittedAssetIds Explicit allowlist of catalog asset ids admitted as authored.
 * @param {boolean} [options.requireCompleteCatalog=true] Fail on a partial catalog unless explicitly relaxed.
 */
export function routeCustomsAuthoredVegetationRollout({
  plan,
  packIndex,
  catalog: suppliedCatalog = null,
  admittedAssetIds,
  requireCompleteCatalog = true,
} = {}) {
  const catalog = suppliedCatalog ?? normalizeCustomsAuthoredVegetationCatalog(packIndex);
  if (requireCompleteCatalog && !catalog.currentFactoryCoverage.complete) {
    fail(
      `authored vegetation catalog is incomplete: ${catalog.currentFactoryCoverage.assets}/${catalog.currentFactoryCoverage.expectedAssets} assets and ${catalog.currentFactoryCoverage.bindings}/${catalog.currentFactoryCoverage.expectedBindings} bindings`,
      'ERR_CUSTOMS_VEGETATION_INCOMPLETE_CATALOG',
      catalog.currentFactoryCoverage,
    );
  }
  const admitted = normalizedAdmittedAssetIds(admittedAssetIds, catalog);
  const admittedSet = new Set(admitted);

  const source = object(plan, 'plan');
  const groups = object(source.groups, 'plan.groups');
  const identities = [];
  for (const classification of Object.keys(groups).sort()) {
    const placements = groups[classification];
    if (!Array.isArray(placements)) fail(`plan.groups.${classification} must be an array`);
    for (let index = 0; index < placements.length; index += 1) {
      // A row that carries only `(tileId, prototypeId)` — the shape the offline pack's own
      // `placements[]` mirror uses — is joined to `prototypeBindings` to recover its exact
      // `prototypeName`. Without the join the probe correctly rejects every such row for a
      // missing field, and the router would read that as "nothing is admissible".
      const identity = normalizeIdentity(
        joinCustomsAuthoredVegetationPrototypeName(catalog, placements[index]),
        `plan.groups.${classification}[${index}]`,
      );
      if (identity.classification !== classification) {
        fail(`plan.groups.${classification} contains a ${identity.classification} placement`);
      }
      identities.push(identity);
    }
  }

  identities.sort((a, b) => a.flatIndex - b.flatIndex
    || a.tileId.localeCompare(b.tileId)
    || a.prototypeId.localeCompare(b.prototypeId));

  const seen = new Set();
  for (const identity of identities) {
    if (seen.has(identity.flatIndex)) fail(`duplicate exact vegetation flat index ${identity.flatIndex}`);
    seen.add(identity.flatIndex);
  }

  if (source.renderedCount !== undefined && source.renderedCount !== identities.length) {
    fail('plan.renderedCount does not match the plan groups');
  }

  const routed = new Map();
  for (const identity of identities) {
    const probe = probeCustomsAuthoredVegetationBinding(catalog, identity.source);
    let route = 'procedural';
    let assetId = null;
    if (probe) {
      if (!probe.nameMatches) {
        fail(
          `prototype identity mismatch for ${identity.tileId}/${identity.prototypeId}: expected ${probe.binding.prototypeName}, received ${identity.prototypeName}`,
          'ERR_CUSTOMS_VEGETATION_PROTOTYPE_IDENTITY_MISMATCH',
          {
            tileId: identity.tileId,
            prototypeId: identity.prototypeId,
            prototypeName: identity.prototypeName,
            expectedPrototypeName: probe.binding.prototypeName,
          },
        );
      }
      assetId = probe.asset.assetId;
      route = admittedSet.has(assetId) ? 'authored' : 'procedural';
    } else {
      const byName = catalog.assetsByName?.[identity.prototypeName];
      if (byName && admittedSet.has(byName.assetId)) {
        fail(
          `ambiguous vegetation routing for ${identity.tileId}/${identity.prototypeId}: prototype name ${identity.prototypeName} is an admitted authored asset but its exact binding is absent`,
          'ERR_CUSTOMS_VEGETATION_AMBIGUOUS_ROUTING',
          {
            tileId: identity.tileId,
            prototypeId: identity.prototypeId,
            prototypeName: identity.prototypeName,
            admittedAssetId: byName.assetId,
          },
        );
      }
    }
    routed.set(identity.flatIndex, { identity, route, assetId });
  }

  const authoredEntries = [];
  const proceduralEntries = [];
  for (const entry of routed.values()) {
    (entry.route === 'authored' ? authoredEntries : proceduralEntries).push(entry);
  }
  if (authoredEntries.length + proceduralEntries.length !== identities.length) {
    fail('vegetation rollout duplicated or lost exact placements');
  }

  const sourceCount = source.sourceCount === undefined
    ? identities.length
    : safeInteger(source.sourceCount, 'plan.sourceCount');
  const culledCount = source.culledCount === undefined
    ? 0
    : safeInteger(source.culledCount, 'plan.culledCount');
  if (sourceCount !== identities.length + culledCount) {
    fail('plan.sourceCount must equal rendered placements plus plan.culledCount');
  }

  const authored = buildSubplan(authoredEntries, { sourceCount });
  const procedural = buildSubplan(proceduralEntries, { sourceCount });
  if (authored.renderedCount + procedural.renderedCount !== identities.length) {
    fail('vegetation rollout authored plus procedural does not equal the original rendered count');
  }

  const route = Object.freeze({
    catalog,
    admittedAssetIds: admitted,
    original: Object.freeze({
      renderedCount: identities.length,
      sourceCount,
      culledCount,
    }),
    authored,
    procedural,
    routing: Object.freeze({
      authoredPlacementCount: authored.renderedCount,
      proceduralPlacementCount: procedural.renderedCount,
      originalPlacementCount: identities.length,
      culledPlacementCount: culledCount,
      sourcePlacementCount: sourceCount,
    }),
  });
  // Not only a test: a router that quietly lost or doubled a placement must fail here, at the
  // seam, rather than surface later as a thinner forest nobody can account for.
  assertCustomsAuthoredVegetationRouteTotals(route);
  return route;
}
