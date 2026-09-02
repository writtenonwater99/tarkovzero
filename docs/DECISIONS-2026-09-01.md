# Standing decisions — 2026-09-01

Three calls the founder made after each was presented with its cost. They are recorded here so a future
agent does not "helpfully" re-open them. Each names what would have to change for the decision to be worth
revisiting; absent that, the answer is settled.

---

## 1. The bounds reader is PARKED. Walls stand on provisional numbers.

`scripts/extract-customs-bounds.py` is committed, tested (86 tests, 38 self-test cases, 36 refusal reasons
with none untested) and **has never been run against a game install**. It is not going to be, for now.

Three rounds of adversarial review cleared its *mechanism* — an independently constructed length-preserving
byte rotation sailed past the end-offset checksum and was caught by the SubMesh union cross-check; the
selector opened only the authorized files against eleven planted decoys including two `.resS`; no error path
leaked a path; clobber, repo-write and install-write are all refused, the last even through a symlinked
parent — and repeatedly failed its *evidence*. The final review was NOT CLEAR on three grounds:

- `--pin-typetree-sha256` is required and exact, and nothing in the repo can compute one. The documented
  "stage 2 reports it when it refuses" is false, so a gated run could only ever exit 2 — and the only
  visible way forward would have been to weaken the pin check.
- `boundsWalk.physicalReads` counts logical reads: 216 bytes in 34 reads against a measured 73,849 bytes in
  20 syscalls, because the handle is an 8 KiB `BufferedReader` whose refills start at each array count and
  run into the payload. **"No payload byte was physically read" is false at the syscall level.** Nothing
  payload-bearing is parsed or emitted, and that narrower claim still holds.
- Zero-submesh and >64-submesh meshes are both legal Unity data that abort the entire run, and
  `--allow-partial` rescues neither — so a real Customs run would likely abort regardless.

**Consequence, accepted:** every wall, fence and gate dimension stays `provisional-unmeasured`. That is a
deliberate state, not a TODO. `WALL_CLASSES` remains the single dimension table and `resolveWallClasses` the
only seam, so measurements can still land later without touching geometry code.

**Revisit only if:** a measured height becomes load-bearing for something that ships, or a typetree hash
becomes obtainable without weakening the pin.

---

## 2. The Fortress LOD silhouette defect stays PINNED, not fixed.

`fortress-shell` grows **+15.67 mm at LOD1** and **+40.00 mm at LOD2** (worst escape 31.26 mm vs LOD0). An
LOD should never grow. It is not being fixed.

The reason is cost, not doubt: fortress-shell is an **admitted** asset whose three LOD digests are pinned in
`public/assets/3d/customs/scene-manifest.json` and whose GLBs ship. Fixing the defect means three new
digests, a corrected bounds block, and a fresh founder GPU review — and it lands on the one asset whose
LOD0/LOD1 are not byte-reproducible (see §3), making it a cut-once-review-once operation.

The validator pins the five escapes exactly and prints a KNOWN DEFECT banner. **The pin fails if the
geometry moves in either direction**, so the defect cannot be fixed as a side effect of an unrelated edit,
and it cannot silently worsen.

**Known cost already paid:** the manifest's declared `bounds.max.y` is LOD2's grown `18.230173`, not LOD0's
`18.198912`, so the picking and shadow proxies are sized to the defect rather than to the asset. Accepted.

The same defect existed in crackhouse and the tanker via two distinct mechanisms; both are **fixed**, and a
shared cross-LOD monotonicity gate now prevents new assets inheriting it.

**Revisit only if:** fortress is being re-admitted for another reason anyway, so the review cost is already
being paid.

---

## 3. Two admitted LODs cannot be rebuilt. Accepted.

`fortress-shell-lod0`, `fortress-shell-lod1` and `zb013-basement-lod0` produce a **different sha256 on every
build from unmodified code** — same machine, same byte count. Only `TEXCOORD_0` (≤9.54e-07, ~1 ULP) and
`TANGENT` (≤3.1e-03) drift; geometry, all embedded images and the entire JSON chunk are bit-exact. Confirmed
pre-existing by building twice from HEAD and twice from the working tree: they differ from *themselves* on
both code states.

`fortress-shell-lod2` **does** rebuild to its admitted digest `38819248cb3b…` exactly, as do crackhouse and
13 of 15 industrial props.

**What this costs:** "rebuild and confirm" is unavailable for two shipped LODs. The manifest still proves
the shipped bytes are the admitted bytes — the digest chain is intact and `verify:customs-authored-assets`
passes — but the reproducibility gate the admission contract implies is **not satisfied** for those two, and
saying otherwise would be false.

**Not accepted as unknown:** the drift is characterised (which fields, what magnitude, and that it is not
thread count and not `PYTHONHASHSEED`). What is unknown is the root cause inside the exporter.

**Revisit only if:** a fortress rebuild becomes necessary for another reason, or the drift widens beyond the
measured ceilings encoded in the regression oracle.

---

## What these three imply together

The industrial and wall lanes now have **no path to measured dimensions**, and the building lane's "accurate
silhouette" half has lost the source it was going to draw on. That is a real consequence of three reasonable
calls, and it should be faced rather than discovered later — see the open question at the end of
`docs/plans/BUILDING-MASSING.md`.

The photographic method remains available and is the only evidence source in this project that has ever been
independent of the Unity acquisition layer. It settled the industrial family question in three practice
raids.
