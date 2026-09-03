/**
 * The building-detail data contract.
 *
 * Six per-archetype planners are being written in parallel by six agents. This file is the rigid
 * seam between them and the renderer: a planner is a PURE function of one building's classification
 * and its seat, returning mesh data and instanced-family declarations, and nothing else. If a
 * planner satisfies `validateDetailPlan` its output is interoperable with every other planner's by
 * construction, and the renderer needs no per-archetype special case.
 *
 * It is deliberately small. Everything here is either a frozen vocabulary, a shape check, or an
 * accounting function. There is no geometry in this file and there must never be any: the moment a
 * helper here starts building a roof, six planners start disagreeing about which one is canonical.
 *
 * ---------------------------------------------------------------------------------------------
 * UNITS AND FRAMES — get these wrong and everything downstream is silently 90 degrees out.
 *
 *   metres            every length, every offset, every extent. No exceptions, no other unit.
 *   radians           every angle.
 *   GAME coordinates  (x, z) on the ground plane, y up. This is what `classification.metrics`
 *                     reports and what `groundYAt(x, z)` takes.
 *   WORLD coordinates what `mesh.positions` must already be in. The Three renderer is Z-UP:
 *                     `gameToWorld(x, z, y) === [-x, -z, y]` (src/three-world.js), so world X is
 *                     -gameX, world Y is -gameZ and world Z is height. `yaws` therefore rotate
 *                     about world +Z, matching `mesh.rotation.z` in src/map3d-three.js.
 *   DISPLAYED metres  all heights. `H()` multiplies terrain by the view's relief factor, so a
 *                     ground sample and a building base are already relief-scaled while `height`
 *                     from the data is not. `context.seat` hands you both, already reconciled by
 *                     `seatBuilding()` in src/buildings.js. Never call a raw terrain sampler.
 *
 * ---------------------------------------------------------------------------------------------
 * THE INVARIANT A PLANNER CANNOT BREAK: geometry may not depend on the look.
 *
 * `CLAUDE.md` states the Real/Vector flip "cannot move a vertex", and `npm run check:fx` asserts
 * layer and model counts are identical on both sides. So `PLANNER_CONTEXT_KEYS` does not contain
 * `look`, and `validateDetailPlan` rejects a plan carrying one. Materials may differ between looks;
 * that is the renderer's business, reached through `materialSlot`, never the planner's.
 */

// --------------------------------------------------------------------------------------------- //
// 1. The planner signature
// --------------------------------------------------------------------------------------------- //

/**
 * Every per-archetype module exports exactly one function with this signature:
 *
 *     planDetail(building, context) -> BuildingDetailPlan | null
 *
 * `building` is the row from `public/data/customs-3d.json` (public fields only — see
 * `src/building-archetype.js`). `context` is an object with EXACTLY the keys in
 * `PLANNER_CONTEXT_KEYS` and no others. Returning `null` means "this archetype adds nothing to this
 * building", which is a legitimate answer and is counted as such; it is not an error.
 *
 * A planner is PURE: no THREE, no DOM, no fs, no clock, no `Math.random`. All variation comes from
 * `context.classification.seed` (a deterministic hash of the footprint centroid), so the renderer
 * is reproducible run to run.
 */
export const PLANNER_CONTEXT_KEYS = Object.freeze([
  /** Position in the `data.buildings` array. Becomes `ownerIndex` on every instance. */
  'buildingIndex',
  /** The frozen record from `classifyBuilding()`: archetype, roofForm, program, metrics, seed. */
  'classification',
  /**
   * From `seatBuilding()` in src/buildings.js, in displayed metres:
   * `{ baseY, contactY, loY, hiY, plinthBaseY, plinthHeightM }`. `roofY = baseY + height`.
   */
  'seat',
  /** `(x, z) -> displayed metres`. The same draped sampler the walls were seated on. */
  'groundYAt',
]);

/** The keys a planner may NOT be handed, with the reason. Asserted by `validateDetailPlan`. */
export const FORBIDDEN_CONTEXT_KEYS = Object.freeze({
  look: 'geometry must be identical in both looks — CLAUDE.md: the flip "cannot move a vertex"',
  relief: 'already folded into `seat` and `groundYAt`; a second application double-scales heights',
  random: 'variation is deterministic — use classification.seed',
});

// --------------------------------------------------------------------------------------------- //
// 2. Materials — a frozen slot list, because six planners must not invent six palettes
// --------------------------------------------------------------------------------------------- //

/**
 * A planner never names a colour or constructs a material. It names a SLOT, and the renderer builds
 * the material array in exactly this order, so `groups[i].materialSlot === 1` means "roof" in every
 * planner's output and in the renderer's array alike.
 *
 * `wall` and `roof` are the two the building mesh already carries today (`materialForBuilding()`,
 * src/map3d-three.js:1554) and they resolve per building from its authored `color` / `roof` fields.
 * The other four are map-wide and shared, which is what keeps the draw-call delta bounded.
 */
export const MATERIAL_SLOTS = Object.freeze([
  'wall',    // 0 — the building's own authored wall colour
  'roof',    // 1 — its authored `roof` colour where present, else a derived one
  'trim',    // 2 — parapet copings, eave bands, door frames: a shade off the wall
  'metal',   // 3 — roof plant, vents, monitors, ladders, gantries
  'glazing', // 4 — window bands, monitor glass
  'dark',    // 5 — unlit recesses and openings; the same near-black family as the plinth skirt
]);
export const MATERIAL_SLOT_INDEX = Object.freeze(
  Object.fromEntries(MATERIAL_SLOTS.map((name, index) => [name, index])),
);
/** The two slots the building mesh already pays for. Using only these costs ZERO extra draw calls. */
export const FREE_MATERIAL_SLOTS = Object.freeze(['wall', 'roof']);

// --------------------------------------------------------------------------------------------- //
// 3. Instanced families — one InstancedMesh per family, map-wide
// --------------------------------------------------------------------------------------------- //

/**
 * The small repeated objects. Every planner that wants one of these DECLARES instances of a shared
 * family rather than emitting the geometry into its building's mesh; the renderer merges the
 * declarations from all 71 buildings into ONE `THREE.InstancedMesh` per family, the way
 * `postInstancedMesh()` already does for fence posts (src/map3d-three.js:2299).
 *
 * The registry is frozen and closed. A planner that needs a family not listed here must have it
 * added here first — that review is the entire point, because an unbounded family list is an
 * unbounded draw-call budget.
 */
export const INSTANCED_FAMILIES = Object.freeze({
  'roof-vent': { materialSlot: 'metal', maxPerBuilding: 12 },
  'roof-stack': { materialSlot: 'metal', maxPerBuilding: 4 },
  'roof-hatch': { materialSlot: 'metal', maxPerBuilding: 3 },
  'downpipe': { materialSlot: 'metal', maxPerBuilding: 8 },
  'door-module': { materialSlot: 'dark', maxPerBuilding: 16 },
  'parapet-coping': { materialSlot: 'trim', maxPerBuilding: 24 },
});
export const INSTANCED_FAMILY_IDS = Object.freeze(Object.keys(INSTANCED_FAMILIES));

/**
 * One family declaration. All the per-instance arrays are parallel and typed, and the two that
 * matter most are the last two.
 *
 * `ownerIndex[i]` — which building the instance belongs to. It buys AUTHORED-ASSET SUPPRESSION,
 * which cannot be recovered afterwards from a merged buffer: when a building gets a real authored
 * GLB, its procedural node is retired by `featureId` (`suppressedProceduralFeatures`,
 * src/map3d-three.js), and every instance belonging to that building must go with it, in one pass
 * over `ownerIndex`, without rebuilding the family for the other 70 buildings.
 *
 * It used to buy a second thing — the floor selector hid an instance whose `levelAboveBaseM` stood
 * above the height the selector had cut its owner to, because an instance is a separate object and
 * does not ride the owner mesh's `scale.z`. The selector is gone (2026-09-02, founder: "floor
 * system fully out the project") and so is that test; `visibleInstanceIndices()` now filters on
 * ownership alone.
 *
 * `levelAboveBaseM[i]` — metres above THAT owner's `seat.baseY`, never an absolute world height.
 * It stays relative because it must survive `fitPlanToHeight()`'s rescale about `baseY` and a
 * change of relief without being re-derived; the planners and their tests assert it against the
 * instance's own world Z, which is what keeps a family's declared level honest.
 */
export const INSTANCE_ARRAYS = Object.freeze({
  offsets: { stride: 3, type: 'Float32Array', doc: 'world-space translation, metres' },
  yaws: { stride: 1, type: 'Float32Array', doc: 'rotation about world +Z, radians' },
  scales: { stride: 3, type: 'Float32Array', doc: 'per-axis scale of the unit prototype' },
  ownerIndex: { stride: 1, type: 'Int32Array', doc: 'index into data.buildings; never -1' },
  levelAboveBaseM: { stride: 1, type: 'Float32Array', doc: 'metres above the owner seat.baseY' },
});

// --------------------------------------------------------------------------------------------- //
// 4. The plan shape
// --------------------------------------------------------------------------------------------- //

/**
 * @typedef {object} DetailMeshData
 * @property {Float32Array} positions  3 per vertex, WORLD space, metres.
 * @property {Uint32Array}  indices    3 per triangle.
 * @property {Float32Array} [normals]  3 per vertex. Omit and the renderer computes them.
 * @property {Array<{start:number, count:number, materialSlot:number}>} groups
 *           Index-buffer ranges, in the `BufferGeometry.addGroup(start, count, materialIndex)`
 *           convention. They must be sorted, contiguous and cover every index exactly once — a gap
 *           is geometry that will never be drawn and is rejected rather than shipped.
 *
 * @typedef {object} InstancedFamilyDeclaration
 * @property {string} familyId  a key of INSTANCED_FAMILIES.
 * @property {number} count
 * @property {DetailMeshData} prototype  ONE unit-sized instance at the origin, +Z up, no groups.
 * @property {Float32Array} offsets
 * @property {Float32Array} yaws
 * @property {Float32Array} scales
 * @property {Int32Array}   ownerIndex
 * @property {Float32Array} levelAboveBaseM
 *
 * @typedef {object} BuildingDetailPlan
 * @property {number} buildingIndex
 * @property {string} archetype                        must equal classification.archetype
 * @property {DetailMeshData|null} mesh                merged into the owner building's mesh
 * @property {InstancedFamilyDeclaration[]} instances
 * @property {string[]} notes                          why the planner did what it did; free text
 */

/** An honest empty plan. A planner with nothing to add returns this, not `undefined`. */
export function emptyDetailPlan(buildingIndex, archetype) {
  return { buildingIndex, archetype, mesh: null, instances: [], notes: [] };
}

// --------------------------------------------------------------------------------------------- //
// 5. Validation — the contract is executable, not prose
// --------------------------------------------------------------------------------------------- //

export class DetailContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DetailContractError';
  }
}

const fail = (message) => { throw new DetailContractError(message); };

/** Reject a context that carries a forbidden key, before a planner can read one. */
export function validatePlannerContext(context) {
  if (!context || typeof context !== 'object') fail('planner context must be an object');
  for (const key of Object.keys(context)) {
    if (key in FORBIDDEN_CONTEXT_KEYS) fail(`context key "${key}" is forbidden: ${FORBIDDEN_CONTEXT_KEYS[key]}`);
    if (!PLANNER_CONTEXT_KEYS.includes(key)) fail(`context key "${key}" is not in PLANNER_CONTEXT_KEYS`);
  }
  for (const key of PLANNER_CONTEXT_KEYS) {
    if (!(key in context)) fail(`context is missing required key "${key}"`);
  }
  return context;
}

function validateMeshData(mesh, label) {
  if (!(mesh.positions instanceof Float32Array)) fail(`${label}: positions must be a Float32Array`);
  if (!(mesh.indices instanceof Uint32Array)) fail(`${label}: indices must be a Uint32Array`);
  if (mesh.positions.length % 3 !== 0) fail(`${label}: positions length ${mesh.positions.length} is not a multiple of 3`);
  if (mesh.indices.length % 3 !== 0) fail(`${label}: indices length ${mesh.indices.length} is not a multiple of 3`);
  const vertexCount = mesh.positions.length / 3;
  for (let index = 0; index < mesh.indices.length; index++) {
    if (mesh.indices[index] >= vertexCount) fail(`${label}: index ${mesh.indices[index]} exceeds ${vertexCount} vertices`);
  }
  for (let index = 0; index < mesh.positions.length; index++) {
    if (!Number.isFinite(mesh.positions[index])) fail(`${label}: position ${index} is not finite`);
  }
  if (mesh.normals !== undefined) {
    if (!(mesh.normals instanceof Float32Array)) fail(`${label}: normals must be a Float32Array`);
    if (mesh.normals.length !== mesh.positions.length) fail(`${label}: normals length must equal positions length`);
  }
  return vertexCount;
}

function validateGroups(mesh, label) {
  if (!Array.isArray(mesh.groups) || mesh.groups.length === 0) fail(`${label}: mesh must declare at least one material group`);
  let cursor = 0;
  for (const [ordinal, group] of mesh.groups.entries()) {
    if (!Number.isInteger(group.start) || !Number.isInteger(group.count)) fail(`${label}: group ${ordinal} start/count must be integers`);
    if (group.start !== cursor) fail(`${label}: group ${ordinal} starts at ${group.start}, expected ${cursor} — groups must be contiguous and sorted`);
    if (group.count <= 0 || group.count % 3 !== 0) fail(`${label}: group ${ordinal} count ${group.count} must be a positive multiple of 3`);
    if (!Number.isInteger(group.materialSlot) || group.materialSlot < 0 || group.materialSlot >= MATERIAL_SLOTS.length) {
      fail(`${label}: group ${ordinal} materialSlot ${group.materialSlot} is not a MATERIAL_SLOTS index`);
    }
    cursor += group.count;
  }
  if (cursor !== mesh.indices.length) fail(`${label}: groups cover ${cursor} indices, mesh has ${mesh.indices.length}`);
}

function validateInstances(family, label, buildingCount) {
  if (!INSTANCE_ARRAYS || !Object.prototype.hasOwnProperty.call(INSTANCED_FAMILIES, family.familyId)) {
    fail(`${label}: "${family.familyId}" is not a registered instanced family`);
  }
  const count = family.count;
  if (!Number.isInteger(count) || count <= 0) fail(`${label}: count ${count} must be a positive integer`);
  const limit = INSTANCED_FAMILIES[family.familyId].maxPerBuilding;
  if (count > limit) fail(`${label}: ${count} instances exceeds maxPerBuilding ${limit} for "${family.familyId}"`);
  if (!family.prototype) fail(`${label}: an instanced family must carry one unit prototype`);
  validateMeshData(family.prototype, `${label}.prototype`);
  if (family.prototype.groups !== undefined) fail(`${label}.prototype: an instance prototype is one material and must not declare groups`);
  for (const [name, spec] of Object.entries(INSTANCE_ARRAYS)) {
    const array = family[name];
    const expectedType = spec.type === 'Int32Array' ? Int32Array : Float32Array;
    if (!(array instanceof expectedType)) fail(`${label}: ${name} must be a ${spec.type}`);
    if (array.length !== count * spec.stride) fail(`${label}: ${name} length ${array.length}, expected ${count * spec.stride}`);
  }
  for (let index = 0; index < count; index++) {
    const owner = family.ownerIndex[index];
    if (!Number.isInteger(owner) || owner < 0 || owner >= buildingCount) {
      fail(`${label}: ownerIndex[${index}] = ${owner} is not a building index in [0, ${buildingCount})`);
    }
    if (!Number.isFinite(family.levelAboveBaseM[index])) fail(`${label}: levelAboveBaseM[${index}] is not finite`);
  }
}

/**
 * Check one planner's output against the contract. Throws `DetailContractError` with a message that
 * names the plan, the field and the number, so an agent reading a CI failure does not have to guess.
 */
export function validateDetailPlan(plan, { buildingCount, archetype } = {}) {
  if (plan === null) return null;
  if (!plan || typeof plan !== 'object') fail('a plan must be an object or null');
  const label = `plan[${plan.buildingIndex}]`;
  if (!Number.isInteger(plan.buildingIndex) || plan.buildingIndex < 0) fail(`${label}: buildingIndex must be a non-negative integer`);
  if (Number.isInteger(buildingCount) && plan.buildingIndex >= buildingCount) {
    fail(`${label}: buildingIndex is outside [0, ${buildingCount})`);
  }
  if (archetype && plan.archetype !== archetype) fail(`${label}: archetype "${plan.archetype}" does not match "${archetype}"`);
  if (!Array.isArray(plan.instances)) fail(`${label}: instances must be an array`);
  if (!Array.isArray(plan.notes)) fail(`${label}: notes must be an array`);
  if (plan.mesh) {
    validateMeshData(plan.mesh, `${label}.mesh`);
    validateGroups(plan.mesh, `${label}.mesh`);
  }
  for (const [ordinal, family] of plan.instances.entries()) {
    validateInstances(family, `${label}.instances[${ordinal}]`, Number.isInteger(buildingCount) ? buildingCount : Infinity);
    if (family.ownerIndex.some((owner) => owner !== plan.buildingIndex)) {
      fail(`${label}.instances[${ordinal}]: every instance in a per-building plan must be owned by that building`);
    }
  }
  return plan;
}

// --------------------------------------------------------------------------------------------- //
// 6. The draw-call budget — one arithmetic, applied to everyone
// --------------------------------------------------------------------------------------------- //

/**
 * Buildings cost ~273 draw calls inside a ~1,461-call frame today. Three.js issues one draw call per
 * material group, so a detail mesh that reuses `wall` and `roof` is free, and every additional slot
 * on a building is one more call. The budget below is the worst case that keeps the delta under
 * ~5% of the frame: 71 buildings x 1 extra slot + 6 families = 77 calls, 28% on top of the
 * buildings' own cost and 5.3% of the frame.
 *
 * A planner states its delta by calling `planDrawCallDelta` on its own output. It does not estimate.
 */
export const DETAIL_DRAW_CALL_BUDGET = Object.freeze({
  maxExtraSlotsPerBuilding: 1,
  maxInstancedFamiliesMapWide: INSTANCED_FAMILY_IDS.length,
  baselineBuildingDrawCalls: 273,
  baselineFrameDrawCalls: 1461,
});

/**
 * The draw-call delta for a set of plans covering the whole map.
 *
 * `perBuildingGroups` counts only slots BEYOND the wall/roof pair the building mesh already pays
 * for; `instancedFamilies` counts distinct families, once each, because one family is one
 * InstancedMesh no matter how many buildings contribute to it.
 */
export function planDrawCallDelta(plans) {
  const rows = (Array.isArray(plans) ? plans : []).filter(Boolean);
  const free = new Set(FREE_MATERIAL_SLOTS.map((name) => MATERIAL_SLOT_INDEX[name]));
  let perBuildingGroups = 0;
  let worstPerBuilding = 0;
  const families = new Set();
  for (const plan of rows) {
    const extra = new Set();
    for (const group of plan.mesh?.groups ?? []) {
      if (!free.has(group.materialSlot)) extra.add(group.materialSlot);
    }
    perBuildingGroups += extra.size;
    worstPerBuilding = Math.max(worstPerBuilding, extra.size);
    for (const family of plan.instances) families.add(family.familyId);
  }
  const total = perBuildingGroups + families.size;
  return {
    perBuildingGroups,
    worstPerBuilding,
    instancedFamilies: families.size,
    total,
    framePct: (total / DETAIL_DRAW_CALL_BUDGET.baselineFrameDrawCalls) * 100,
    withinBudget: worstPerBuilding <= DETAIL_DRAW_CALL_BUDGET.maxExtraSlotsPerBuilding
      && families.size <= DETAIL_DRAW_CALL_BUDGET.maxInstancedFamiliesMapWide,
  };
}
