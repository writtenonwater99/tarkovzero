/**
 * The sun's shadow depth map, rendered ONLY when something that casts into it changed.
 *
 * ── Why this file exists ────────────────────────────────────────────────────────────────────────
 *
 * `sun.castShadow = true` plus three's default `LightShadow.autoUpdate = true` means
 * `ShadowNode.updateBefore()` re-renders the 2048² depth map on EVERY frame
 * (three 0.185.1, `src/nodes/lighting/ShadowNode.js:855` — `shadow.needsUpdate || shadow.autoUpdate`).
 * That is a second full traversal and submission of every caster in the scene. Measured on the
 * founder's RTX 5080, A/B/A/B inside one page load, vegetation mounted, all 1,304 overlay layers:
 *
 *   founder-a     CPU frame 16.00 → 9.85 ms (−38%),  render phase 12.45 → 6.50 ms (−48%)
 *   ground-close  CPU frame 22.45 → 15.60 ms (−31%), render phase 10.80 → 4.10 ms (−62%)
 *   both          draw calls −482, and `renderInfo.frameCalls` 3 → 2 — the nested shadow render
 *
 * `ground-close` at 22.45 ms was the only measured configuration missing the 16.67 ms 60 Hz budget.
 * Frozen, it is 15.60 ms.
 *
 * WHAT THOSE NUMBERS DESCRIBE, precisely: a PARKED CAMERA. `runPreset()` applies a pose, sleeps
 * 500 ms and then samples, so no camera event fires inside the measurement window. That mattered
 * more than it sounds, because until 2026-09-03 the freeze was being lifted on every camera event:
 * the authored streamer's `publishState()` runs on every pass, before its own empty-diff early
 * return, and it drove `applyProceduralSuppression()` -> `invalidate('procedural-suppression')`
 * unconditionally. Since this app renders ON DEMAND, frame time only exists while the camera is
 * moving — so the optimisation was defeated in the one regime where it is worth having, and the A/B
 * could not see it. `syncProceduralSuppression()` is now gated on the resolved set actually changing
 * (the same dirty-key shape `syncPlinthSuppression` already used), which is what makes the numbers
 * above describe a drag as well as a parked camera. Measured before that gate: six `tz.flyTo` calls
 * produced +14 invalidations, nine of them `procedural-suppression` over an unchanged set.
 *
 * ── Why this is not a one-line change ───────────────────────────────────────────────────────────
 *
 * Freezing is only free while the caster set is unchanged. The founder ran the in-app frame-hash
 * check four times and got `identical` **true, false, true, false**. The cause, confirmed: the crude
 * `?profileAblate=shadow` probe freezes the depth map once and early, and the authored-vegetation
 * swap lands 60-85 s later. Procedural tree proxies DO cast (`castShadow: true` on the pine/deciduous
 * trunk and crown batches); authored vegetation deliberately does NOT
 * (`CUSTOMS_AUTHORED_VEGETATION_SHADOW_POLICY.mode === 'disabled'`). So a map frozen pre-swap keeps
 * the shadows of trees that no longer exist. In the failing run `vegetation.mountElapsedMs` was
 * 9,190 ms — the freeze was already in force when the forest changed under it.
 *
 * The boolean is trivial. **The invalidation list is the deliverable**, and a missed entry is a
 * silent stale-shadow bug — exactly the handoff-§7 failure ("a system reports success while
 * something has silently fallen back") that no count can detect. So:
 *
 *  - `SHADOW_INVALIDATION_REASONS` is a CLOSED enum. `invalidate('typo')` throws. A reason that is
 *    not on the list cannot be invented at a call site and silently do nothing.
 *  - `createShadowCasterAudit()` is the loud version of the silent bug: it fingerprints the caster
 *    set and reports a change that nobody invalidated for. It is armed by `?shadowAudit=1` IN EVERY
 *    ENVIRONMENT, production included — the same deliberate trade `?profile=1` makes (evening
 *    handoff §5.5), because both places a real reading can be taken answer `false` to
 *    `canShowDiagnosticReadouts()`. It is off unless asked for, it runs in its own rAF loop and
 *    never touches the shipped frame, and the cost of arming it is a whole-scene traverse per tick.
 *    Saying "dev-only" here while the code gates on a URL parameter would be the same
 *    statement-versus-behaviour drift this file is written against.
 *  - `?shadows=live` restores three's per-frame behaviour, which is both the escape hatch and the
 *    control arm of the pixel-identity proof.
 */

/**
 * Every point at which the caster set, or the light, can change after the first render.
 *
 * Derived from `src/map3d-three.js`, not from a guess. Each entry names the function that owns the
 * mutation; the file:line audit is in `docs/PROFILING.md` §3c.
 */
export const SHADOW_INVALIDATION_REASONS = Object.freeze([
  /** The first world build, and any later `rebuildWorld()` — every procedural caster is replaced. */
  'world-build',
  /** `applyProceduralSuppression()` — authored replacements hide/show building and prop nodes, and
   *  rewrite the building-detail instance buffers. */
  'procedural-suppression',
  /** `applyNature()` — `treeGroup.visible` and `rockGroup.visible` are both caster groups. */
  'nature-visibility',
  /** `applyLook()` — `sun.intensity` and the terrain/understory material swap. */
  'look',
  /** `rebuildProceduralVegetation()` — the procedural tree proxies are disposed and rebuilt. */
  'procedural-vegetation',
  /** The authored-vegetation swap completing. THE ONE THAT WAS BROKEN. */
  'authored-vegetation-mount',
  /** An authored-vegetation repack. Inert while the pack's shadow policy is `disabled`; declared so
   *  a future `near-lod` policy cannot ship a per-camera caster change with no invalidation. */
  'authored-vegetation-repack',
  /** One authored GLB attached to, or detached from, the streaming root. */
  'authored-asset-attach',
  'authored-asset-detach',
  /** Anything that moves the sun, its target, or the shadow camera. RESERVED: nothing invokes it
   *  today, and `scripts/three-renderer-test.mjs` enumerates it in an explicit reserved allowlist so
   *  that "declared but never called" costs a line in a test rather than being a silent coverage
   *  claim. The day something moves the sun, delete it from that allowlist. */
  'sun',
  /**
   * The GPU context or device was lost and restored.
   *
   * THE ONE STALE PATH NO FINGERPRINT CAN SEE. On a WebGL2 context loss or a WebGPU device loss the
   * backend reallocates every texture — the depth map included — EMPTY. With `autoUpdate = true`
   * three re-renders it on the very next frame and nobody notices; frozen, nothing ever re-bakes it
   * and the scene renders with a dead shadow map for the rest of the session. The caster set has not
   * changed, so `shadowCasterFingerprint` is stable and the audit reports `clean` forever. This is a
   * failure mode the freeze INTRODUCES, so it is the freeze's job to close it.
   */
  'renderer-context-restored',
  /**
   * `createRenderProfiler()`'s `?profileAblate=props|rocks`, which sets `propGroup.visible` /
   * `rockGroup.visible` false for the length of a run.
   *
   * Those are caster groups. Under a frozen map an un-declared ablation draws prop shadows on ground
   * with no props — the literal stale-shadow signature, manufactured by the instrument built to
   * measure the freeze, and reachable in production (`?profile=1` is deliberately not behind
   * `canShowDiagnosticReadouts()`). It gets its own reason rather than borrowing
   * `nature-visibility`, so `byReason` still says WHO moved the casters.
   */
  'profiler-ablation',
]);

const REASONS = new Set(SHADOW_INVALIDATION_REASONS);

const truthy = new Set(['1', 'true', 'yes', 'on']);
const falsy = new Set(['0', 'false', 'no', 'off']);

/**
 * `?shadows=live` and `?shadowAudit=1`, parsed the way `parseProfileRequest` parses its own.
 *
 * Both default OFF, and an unrecognised value is reported rather than silently taken as the default
 * — a `?shadows=liv` that quietly froze the map would be the same class of quiet failure this file
 * is about.
 *
 * A PRESENT-BUT-EMPTY value is handled per parameter rather than by one blanket rule, because the
 * two parameters are different shapes. `?shadowAudit` typed bare is a human switching an instrument
 * on: reading it as `false` (which `''` in the falsy set used to do) silently DISARMED the one thing
 * built to catch a dropped invalidation and left `{ armed: false }` as the only trace — the same
 * class of quiet failure one level up. `?shadows` typed bare names no mode, so it is reported as
 * unknown rather than guessed in either direction.
 */
export function parseShadowRequest(search) {
  const params = new URLSearchParams(String(search ?? ''));
  const read = (name, { on = null, off = null, bare = null } = {}) => {
    if (!params.has(name)) return { value: false, unknown: null };
    const raw = String(params.get(name)).trim().toLowerCase();
    if (raw === '') {
      if (bare === true) return { value: true, unknown: null };
      return { value: false, unknown: `${name}= (present with no value)` };
    }
    if (on && raw === on) return { value: true, unknown: null };
    if (off && raw === off) return { value: false, unknown: null };
    if (truthy.has(raw)) return { value: true, unknown: null };
    if (falsy.has(raw)) return { value: false, unknown: null };
    return { value: false, unknown: `${name}=${raw}` };
  };
  const live = read('shadows', { on: 'live', off: 'frozen' });
  const audit = read('shadowAudit', { bare: true });
  return Object.freeze({
    live: live.value,
    audit: audit.value,
    unknown: Object.freeze([live.unknown, audit.unknown].filter(Boolean)),
  });
}

/**
 * Own one `THREE.LightShadow`'s update policy.
 *
 * Constructing this is what turns the optimisation on: `shadow.autoUpdate` goes false and one
 * `needsUpdate` is armed for the first bake. Nothing else in the renderer writes either flag on the
 * shipped path — the profiler's ablation is the one other writer, and it lives inside
 * `createRenderProfiler()`, which only exists when `?profile=` armed the run. That writer now goes
 * through `setLive()` and `settle()` rather than poking `sun.shadow.*`, because writing
 * `needsUpdate = false` at a call site can CANCEL a bake the app committed to — and the cancellation
 * is self-certifying: the audit sees `sequence` has moved, re-baselines, and files the
 * post-mutation fingerprint as `baked`.
 *
 * @param {object} options.shadow    a `THREE.LightShadow` (anything with `autoUpdate`/`needsUpdate`)
 * @param {boolean} options.live     true = keep three's per-frame behaviour (`?shadows=live`)
 * @param {function} options.now     clock, for the diagnostic timestamps
 */
export function createShadowController({ shadow, live = false, now = () => 0 } = {}) {
  if (!shadow || typeof shadow !== 'object') {
    throw new Error('createShadowController requires a LightShadow');
  }
  const frozen = live !== true;
  shadow.autoUpdate = !frozen;
  // The first bake. With `autoUpdate` false and nothing arming this, the depth map would never be
  // rendered at all and every shadow in the scene would be missing — a failure loud enough to be
  // caught, but the reason it cannot happen is this line.
  shadow.needsUpdate = true;
  const byReason = new Map(SHADOW_INVALIDATION_REASONS.map((reason) => [reason, 0]));
  let requested = 0;
  let last = null;

  const invalidate = (reason) => {
    if (!REASONS.has(reason)) {
      // Closed enum. A typo here would otherwise be a no-op that ships a stale shadow.
      throw new Error(`unknown shadow invalidation reason: ${String(reason)}`);
    }
    shadow.needsUpdate = true;
    requested += 1;
    byReason.set(reason, byReason.get(reason) + 1);
    last = Object.freeze({ reason, atMs: Math.round(now()) });
    return true;
  };

  /**
   * Lower `needsUpdate` — but ONLY if nothing declared an invalidation since `atSequence`.
   *
   * The profiler's shadow ablation has to arm a bake, let one frame consume it, and then clear the
   * flag. Writing `shadow.needsUpdate = false` directly to do that DISCARDS any invalidation that
   * landed inside the awaited frame, and the discard is invisible: `createShadowCasterAudit` sees
   * `controller.sequence` has moved, re-baselines, and records the post-mutation fingerprint as
   * `baked` — so the instrument built to catch a dropped invalidation certifies the one the
   * instrument itself dropped. The window is exactly the one that matters (the authored-vegetation
   * swap lands 60-85 s in; a profiler run is longer than that), so the operation refuses instead.
   *
   * @returns {boolean} true if the flag was lowered; false if a bake is still owed and was kept.
   */
  const settle = (atSequence) => {
    if (requested !== atSequence) return false;
    shadow.needsUpdate = false;
    return true;
  };

  return Object.freeze({
    invalidate,
    settle,
    /**
     * Put three's per-frame behaviour back, or take it away, through the one owner of the flag.
     *
     * The profiler needs this; nothing on the shipped path does. It exists so that `controller.live`
     * can never report a state the controller did not choose, which is what a raw
     * `sun.shadow.autoUpdate = ...` at a call site produces.
     */
    setLive(next) { shadow.autoUpdate = next === true; return shadow.autoUpdate; },
    /** True while a bake is owed — i.e. three has not yet consumed the flag. */
    get pending() { return shadow.needsUpdate === true; },
    /**
     * How many invalidations have been declared, ever.
     *
     * The audit compares this rather than watching `pending`, and that is not a detail: an
     * invalidate-then-bake can complete inside a single frame, so a sampler watching `pending`
     * misses the window entirely and reports a DECLARED change as a defect. It did, on the first
     * headless run of this change — the Fortress attach invalidated correctly and the audit called
     * it stale. A counter cannot be missed by a slow sampler; a flag can.
     */
    get sequence() { return requested; },
    /** True when this build is running three's stock per-frame shadow (`?shadows=live`). */
    get live() { return shadow.autoUpdate === true; },
    stats() {
      return {
        mode: shadow.autoUpdate === true ? 'live-every-frame' : 'frozen-until-invalidated',
        autoUpdate: shadow.autoUpdate === true,
        pending: shadow.needsUpdate === true,
        invalidations: requested,
        byReason: Object.fromEntries([...byReason].filter(([, count]) => count > 0)),
        last,
        /*
         * WHAT THIS OBJECT DOES NOT KNOW, said out loud rather than left for a reader to assume.
         *
         * Every number above counts what this module was ASKED to do. Nothing here observes that
         * three actually rendered a depth map: that would need a per-frame sample of
         * `shadow.needsUpdate`, and `animate()` is pinned by `scripts/render-profiler.test.mjs` to
         * know nothing about shadows, deliberately — the shipped frame is the thing being measured.
         * So `invalidations: 14` with a depth map that never rendered would read exactly like a
         * healthy session, which is the handoff-§7 shape ("a count cannot detect presence"). It is
         * stated instead of being papered over; `?shadowAudit=1` is what actually looks at the scene.
         */
        bakesObserved: null,
        bakesObservedNote: 'nothing samples shadow.needsUpdate per frame on the shipped path, so this'
          + ' module counts DECLARED invalidations only and cannot confirm a depth map was ever'
          + ' rendered. Arm ?shadowAudit=1 for a reading that looks at the scene.',
      };
    },
  });
}

/**
 * A fingerprint of everything the depth map is a function of.
 *
 * WHAT IT COVERS: every object reachable from `root` whose `castShadow` is true and whose whole
 * ancestor chain is visible — its world matrix, its geometry identity, its `InstancedMesh` draw
 * count and instance-matrix version, and the alpha-relevant fields of its material(s), because the
 * depth pass honours `alphaTest`/`alphaMap`. Plus the light: its world position, its target, and the
 * shadow camera's frustum.
 *
 * WHAT IT DOES NOT COVER, stated: matrices are quantised to 1/1024 of a unit, so a sub-millimetre
 * move is invisible to it; a material edited in place without a version bump (e.g. `alphaMap.image`
 * swapped for one of identical dimensions) is invisible to it; and it reads `matrixWorld`, which is
 * only current for the frame three last rendered. It is a change DETECTOR for a dev session, never a
 * proof of equality.
 *
 * AND ONE IT CANNOT COVER BY CONSTRUCTION: a GPU context/device loss reallocates the depth texture
 * empty without touching a single caster, so this returns an identical hash over a shadow map that
 * no longer exists. That is why `'renderer-context-restored'` is an enum reason and a listener
 * rather than something the audit is expected to notice.
 */
export function shadowCasterFingerprint(root, { light = null } = {}) {
  let hash = 0x811c9dc5;
  let casters = 0;
  // A count cannot say WHAT changed — handoff §7's recurring shape — so the census is kept beside
  // it, keyed by `userData.kind`. A defect then reads "8 more `authored-asset` meshes" rather than
  // "delta 8", which is the difference between a report you can act on and one you cannot.
  const tally = new Map();
  const mix = (value) => {
    hash ^= (value | 0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  const mixNumber = (value) => mix(Math.round((Number.isFinite(value) ? value : 0) * 1024));
  const mixMaterial = (material) => {
    if (!material) return mix(-1);
    mix(material.id ?? -1);
    mix(material.visible === false ? 0 : 1);
    mix(material.transparent ? 1 : 0);
    mixNumber(material.alphaTest ?? 0);
    mixNumber(material.opacity ?? 1);
    mix(material.alphaMap ? ((material.alphaMap.version | 0) + 1) : 0);
    return undefined;
  };
  const walk = (node, inheritedVisible) => {
    if (!node) return;
    const visible = inheritedVisible && node.visible !== false;
    if (visible && node.castShadow === true) {
      casters += 1;
      const kind = node.userData?.kind ?? node.name ?? 'unnamed';
      tally.set(kind, (tally.get(kind) ?? 0) + 1);
      mix(node.id ?? -1);
      mix(node.count ?? -1);
      mix(node.instanceMatrix?.version ?? -1);
      mix(node.geometry?.id ?? -1);
      // `Object3D.layers` is a depth-map input: three tests it against the shadow camera's own mask
      // when it collects casters. The app uses no layer scheme today, but a floor/interior filter or
      // a picking-layer scheme is a natural next feature for a map with floors, and implemented that
      // way it would change the caster set with an identical fingerprint and a permanently `clean`
      // audit. One mix now is cheaper than that bug later.
      mix(node.layers?.mask ?? -1);
      const elements = node.matrixWorld?.elements ?? node.matrix?.elements ?? null;
      if (elements) for (let i = 0; i < 16; i += 1) mixNumber(elements[i]);
      else mix(-2);
      const material = node.material;
      if (Array.isArray(material)) for (const one of material) mixMaterial(one);
      else mixMaterial(material);
    }
    for (const child of node.children ?? []) walk(child, visible);
  };
  walk(root, root?.visible !== false);

  if (light) {
    mix(light.castShadow === true ? 1 : 0);
    mix(light.visible === false ? 0 : 1);
    for (const vector of [light.position, light.target?.position]) {
      if (!vector) { mix(-3); continue; }
      mixNumber(vector.x); mixNumber(vector.y); mixNumber(vector.z);
    }
    const camera = light.shadow?.camera;
    if (camera) {
      for (const key of ['left', 'right', 'top', 'bottom', 'near', 'far', 'zoom']) mixNumber(camera[key]);
      mix(camera.layers?.mask ?? -1);
    } else mix(-4);
    const size = light.shadow?.mapSize;
    if (size) { mixNumber(size.width); mixNumber(size.height); } else mix(-5);
  }
  return Object.freeze({
    hash: hash >>> 0,
    casters,
    tally: Object.freeze(Object.fromEntries([...tally].sort((a, b) => b[1] - a[1]))),
  });
}

/** Which kinds gained or lost casters between two fingerprints. Empty when only a matrix moved. */
export function shadowCasterTallyDelta(baked, observed) {
  const out = {};
  for (const key of new Set([...Object.keys(baked?.tally ?? {}), ...Object.keys(observed?.tally ?? {})])) {
    const delta = (observed?.tally?.[key] ?? 0) - (baked?.tally?.[key] ?? 0);
    if (delta !== 0) out[key] = delta;
  }
  return out;
}

/**
 * The loud version of a dropped invalidation.
 *
 * Every tick it asks one question: *has the caster set changed since the frame that baked the depth
 * map, without anybody asking for a new bake?* If the answer is yes, the frame on screen is showing
 * a shadow of a scene that no longer exists, and that is reported — with the reason of the last
 * invalidation, so the missing one can be placed in the sequence.
 *
 * It is armed by `?shadowAudit=1` only, and it never runs on the shipped frame path: the caller owns
 * a `requestAnimationFrame` loop of its own, so `animate()` and `renderOneFrame()` are untouched.
 *
 * ORDERING, and why it does not false-positive. It compares `controller.sequence`, NOT
 * `controller.pending`: an invalidate-then-bake can complete inside one frame, and a sampler
 * watching the flag misses that window and calls a properly declared change a defect. (It did,
 * exactly once, on the first headless run of this change — the Fortress attach.) Any tick where the
 * sequence has moved since the baseline re-baselines instead of reporting.
 *
 * WHAT IT CANNOT SEE, stated. It is a sampler, not a proof:
 *  - rAF is tied to frame production, and under SwiftShader this scene renders at ~0.3 fps, so a
 *    mutation that is followed by ANY unrelated invalidation before the next tick is masked;
 *  - a mutation and its reversal between two ticks are invisible;
 *  - the fingerprint's own blind spots (quantised matrices, in-place material edits) are inherited.
 * A silent tick is therefore evidence, never a guarantee. The unit tests are what pin the
 * invalidation list; this is what catches the one nobody thought to write a test for.
 */
export function createShadowCasterAudit({ controller, fingerprint, onDefect = null } = {}) {
  if (!controller || typeof fingerprint !== 'function') {
    throw new Error('createShadowCasterAudit requires a controller and a fingerprint function');
  }
  let baseline = null;
  let baselineSequence = -1;
  let checks = 0;
  let skipped = 0;
  const defects = [];
  const seen = new Set();

  const observe = () => {
    if (controller.live) {
      skipped += 1;
      return { state: 'live', note: 'three is re-rendering the depth map every frame; there is nothing to go stale' };
    }
    if (controller.pending) {
      // A bake is owed, so the frame on screen is legitimately about to change. Nothing to compare.
      skipped += 1;
      return { state: 'pending' };
    }
    const current = fingerprint();
    checks += 1;
    if (baseline === null || controller.sequence !== baselineSequence) {
      baseline = current;
      baselineSequence = controller.sequence;
      return { state: 'baked', casters: current.casters, hash: current.hash };
    }
    if (current.hash === baseline.hash) return { state: 'clean', casters: current.casters };
    const key = `${baseline.hash}->${current.hash}`;
    const defect = Object.freeze({
      baked: { hash: baseline.hash, casters: baseline.casters },
      observed: { hash: current.hash, casters: current.casters },
      casterDelta: current.casters - baseline.casters,
      // Named, not counted. `{}` here with a non-zero hash change means a caster MOVED or changed
      // material rather than entering or leaving, which is a different bug with a different fix.
      byKind: shadowCasterTallyDelta(baseline, current),
      lastInvalidation: controller.stats().last,
      repeats: 1,
    });
    if (!seen.has(key)) {
      seen.add(key);
      defects.push(defect);
      onDefect?.(defect);
    }
    return { state: 'stale', ...defect };
  };

  return Object.freeze({
    observe,
    stats() {
      /*
       * A VERDICT, NOT FOUR COUNTERS.
       *
       * `{ armed: true, checks: 0, defects: 0 }` reads as "clean" and means "this has compared
       * nothing" — handoff §7 exactly. So the counters ship beside a sentence that can only say
       * "clean" when something was actually compared.
       */
      const verdict = checks === 0
        ? 'NOTHING WAS COMPARED — the audit is armed but has not completed a single check (no frame'
          + ' has been rendered with a settled depth map yet). This is not a pass.'
        : (defects.length > 0
          ? `${defects.length} distinct stale-shadow defect(s): the caster set changed with no invalidation behind it`
          : (checks === skipped
            ? 'no comparison was possible — every tick was skipped (live mode, or a bake always owed)'
            : `clean over ${checks} comparison(s): every caster change so far had an invalidation behind it`));
      return {
        armed: true,
        checks,
        skipped,
        baselineSequence,
        baseline: baseline ? { hash: baseline.hash, casters: baseline.casters } : null,
        defects: defects.length,
        verdict,
        // The whole point of the audit: what the frame's shadow was baked for versus what it draws.
        firstDefect: defects[0] ?? null,
      };
    },
  });
}
