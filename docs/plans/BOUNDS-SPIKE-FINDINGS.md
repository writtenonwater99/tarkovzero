# Mesh local-bounds feasibility spike — findings

**Date:** 2026-09-01 · **Status:** spike complete, disposable code, nothing added to `src/` or the npm
test chain · **Question:** can `Mesh.m_LocalAABB` (centre + extent, six floats) be read without
materialising the vertex/index/compressed/stream arrays `docs/CUSTOMS-TRUTH-PIPELINE.md` refuses?

---

## 1. Verdict

**FEASIBLE — mechanically. Conditional on two guards, and it changes nothing about authority.**

A typetree-driven streaming reader can extract `{pathId, center, extents}` from a serialized Mesh while
physically reading **216 bytes out of a 12.8 MiB object (0.0016%)**, touching **zero payload bytes**,
allocating **≤24 bytes in any single read**, and never calling `parse_as_dict()`. All four pass criteria
(a)–(d) are met on synthetic fixtures, plus two negative controls proving the instrumentation is not
vacuous.

The conditions are not optional:

1. **An end-offset checksum** — the walk must traverse the *whole* object and land exactly on its
   declared last byte. Without it a shifted layout yields a plausible-looking wrong AABB.
2. **A submesh redundancy cross-check** — `m_LocalAABB` must agree with the union of the per-`SubMesh`
   `localAABB`s stored far earlier in the same object. This is the **only** guard that survives a
   length-preserving layout shift, and the spike demonstrates a concrete case where the checksum alone
   emits wrong-but-plausible numbers (§4).

What this does **not** change: bounds identify an asset **resource**, not a placed visible object, and
the reader shares the same acquisition layer as everything else. Bounds buy **precision, not
independence**. The output stays a conservative candidate roster pending geo-tagged in-game photographs.

---

## 2. What was tested, and what was not

**Tested.** A disposable reader against synthetic serialized-Mesh fixtures built by a separate writer
from the same typetree. Fixtures carry large variable-length sections **both before and after** the
AABB — `m_Shapes` (variable-length elements, each holding a string), `m_IndexBuffer` (2 MiB),
`m_VertexData.m_DataSize` (4 MiB), ten `PackedBitVector.m_Data` blobs in `m_CompressedMesh` (256 KiB
each), then after the AABB `m_BakedConvexCollisionMesh` (512 KiB) and `m_BakedTriangleCollisionMesh`
(3 MiB). Total object 12.8 MiB, of which 12.8 MiB is registered as payload ranges.

**Not tested, and deliberately so.** No real Mesh, no real game file, no byte of the EFT install. That
run is gated and belongs to the operator (§7). UnityPy is not installed in this environment and was
never imported — asserted at runtime, not assumed.

**Not claimed.** That the synthetic schema is EFT's actual Mesh layout. The fixture reproduces the
*shape* of the problem (big variable sections around a small scalar, alignment, nested structs,
variable-length elements). Whether the pinned schema matches the shipped files is exactly the risk
in §5, and it is the operator run's job to answer it.

---

## 3. Evidence

`python3 spike.py` — 26 cases, 0 failures.

### (a) Emits only `{pathId, centre, extents}`

```
[PASS] a/output-shape: keys=['centre', 'extents', 'pathId']
[PASS] a/values-correct: centre=(0.0, 2.1, 0.0) extents=(7.05, 2.15, 1.52)
```

### (b) Zero `parse_as_dict()`, zero payload bytes, bounded allocation

```
[PASS] b/no-parse-as-dict: parse_as_dict calls=0, UnityPy imported=False
[PASS] b/no-payload-bytes-read: 34 physical reads / 216 bytes; payload-range intersections=0
[PASS] b/allocation-bounded: tracemalloc peak=46396 bytes, largest single read=24 bytes
```

(The tracemalloc peak is ~46 KB across runs — that is the harness's own bookkeeping, not mesh data;
the load-bearing number is the 24-byte largest single read.)

The proof is about **physical reads**, not post-parse scrubbing. Every read is recorded with its
absolute file offset; the fixture writer independently returns the byte ranges that constitute payload
array *contents* (never their 4-byte counts); the assertion is that the two sets do not intersect. The
216 bytes are 30 four-byte array/string counts, one 24-byte `m_LocalAABB`, and three 24-byte
`SubMesh.localAABB` reads for the cross-check.

### (c) Seeks across variable-length fields without deserializing them

```
[PASS] c/seek-not-walk: 12.8 MiB of the object stepped over without a read (0.001609% read)
[PASS] c/only-counts-and-aabb: read widths=[4, 24] (30 four-byte counts + one 24-byte AABB)
```

Skipping is pointer arithmetic on a logical cursor — no `seek()`, no `read()`, no allocation, whatever
the array's size. A `seek()` is issued only immediately before one of the 34 reads.

### (d) Fails closed — 14 cases

| Case | Refusal reason |
| --- | --- |
| Unity version not on the pin list | `unpinned-unity-version` |
| Typetree hash not on the pin list | `unpinned-typetree` |
| File layout newer than the reader's schema | *varies* — `negative-length` / `field-overruns-object` |
| File layout older than the reader's schema | *varies* — `negative-count` |
| Alignment measured from a different base | *varies* — `negative-count` / `submesh-count-implausible` |
| `m_StreamData.path` non-empty (`.resS` reference) | `external-stream-reference` |
| Hostile array count (2×10⁹) | `field-overruns-object` |
| Declared byte size shorter than the object | `field-overruns-object` |
| NaN in `m_LocalAABB` | `non-finite-bounds` |
| Length-changing divergence, AABB offset still correct | `end-offset-divergence` |
| Leaf type the reader has never seen | `unknown-leaf-type` |
| Typetree with no `m_LocalAABB` | `aabb-not-found-exactly-once` |
| Submesh union disagrees with `m_LocalAABB` | `submesh-bounds-disagree` |
| Object declared past end of file | `object-outside-file` |

The `.resS` case never reads the path bytes — it reads the 4-byte length, sees non-zero, and refuses.
The pipeline's rule that stream paths are never emitted is preserved by construction.

**Three rows say *varies*, and that is itself a finding.** Those cases refuse on **every** run (verified
across `PYTHONHASHSEED=1,2,3`), but on an *incidental* guard — the shifted walk reads a filler byte
pattern as an array count, gets a negative or absurd number, and dies there — rather than on a
structural one. Which incidental guard trips depends on the filler bytes. So these fixtures show the
reader fails closed; they do **not** show that the checksum or cross-check would have caught those
particular shifts, because the walk never reaches them. Only §4's case reaches the structural guards,
and it is the one that matters.

### Negative controls — the instrumentation has teeth

```
[PASS] g/detector-fires-on-payload-read: deliberate 32-byte payload read reported 1 intersection(s)
[PASS] g/read-budget-stops-a-walking-reader: refused: read-budget-exceeded
```

Control B replaces the skip primitive with one that reads instead of stepping. The reader does not
produce a slow correct answer — it **refuses**, because a hard read budget (4 KiB total, 64 bytes per
read) is enforced inside the stream wrapper. A vertex buffer does not fit in that budget, by
construction. That budget, not the author's discipline, is what makes payload materialisation
unreachable even under a schema surprise.

### Discrimination — does this actually kill the barrel-scored-as-wagon failure?

```
[PASS] e/size-classes-separate: longest axis (m): {'barrel-sized': 0.9, '6m-container': 6.1, 'closed-wagon': 14.1}
```

Yes, on the physics. A 0.9 m object and a 14.1 m object are not confusable by any threshold, and
"6 m container" becomes a measurement (6.1 m) rather than a name token. This is the spike's actual
payoff — subject to §6.

---

## 4. The load-bearing finding

**The end-offset checksum is blind to a length-preserving layout shift, and that blindness produces
wrong-but-plausible bounds.**

Fixture: a Unity variant where `m_MeshUsageFlags` (4 bytes) sits *before* `m_LocalAABB` instead of
after. Object length is identical, so the walk lands exactly on the declared end and the checksum is
satisfied. The reader reads the AABB four bytes early:

```
[PASS] f/checksum-alone-is-blind: end-offset checksum did NOT fire — reader emitted
       extents=(0.0, 7.05, 2.15) (truth 7.05/2.15/1.52).
[PASS] f/crosscheck-catches-shift: refused: submesh-bounds-disagree
```

The emitted extents are finite, non-negative, of plausible magnitude, and **wrong**. Every cheap
sanity gate passes them. The only thing that catches it is the redundant copy of the same fact
elsewhere in the object: Unity's `m_LocalAABB` is the union of the per-`SubMesh` `localAABB`s, which
live near the *start* of the object, before every payload array. Read them (bounded: refuse if the
submesh count is <1 or >64), union them, and require agreement within 2 cm + 2%.

Two consequences for a production reader:

- The cross-check is **mandatory**, not a nicety. A reader with the checksum alone is not safe; it is
  lucky, and this spike shows the case where the luck runs out.
- A mesh whose `m_LocalAABB` was set manually and legitimately differs from the submesh union will be
  **refused**. That is the conservative direction, but it means the refusal ledger is a **coverage
  gap**, never evidence that no such mesh exists.

Note also that the neighbouring field's *value* decides whether cheap gates catch a shift: with random
bytes there, the magnitude gate fired; with the realistic value (`m_MeshUsageFlags == 0`, which is what
real meshes ship) it did not. Do not tune plausibility gates against a fixture whose filler is noise.

---

## 5. Version and layout risk register

The reader depends on these assumptions. Each row names what detects a violation and what does not.

| # | Assumption | Detected by | Residual |
| --- | --- | --- | --- |
| 1 | Little-endian, typetree-driven serialized layout | explicit refusal on non-LE | none |
| 2 | Field **order** of `Mesh` for the exact Unity version | end-offset checksum (length-changing) + submesh cross-check (length-preserving) | a shift that preserves length **and** the AABB↔submesh relationship |
| 3 | Align = 4 bytes, base = **object start** | checksum / count sanity (demonstrated: refuses, does not guess) | none observed; the fixture cannot settle which base UnityPy actually uses — the operator run does |
| 4 | Typetree **provenance** | pinned SHA-256 of the node tree | see below |
| 5 | `SubMesh.localAABB` exists (Unity 2017.3+) | `no-submesh-crosscheck` refusal | a build without it has **no** length-preserving-shift defence and must not be read |
| 6 | Declared serialized byte size is trustworthy | `object-outside-file`, `field-overruns-object` | a size that is wrong but self-consistent |

**Row 4 deserves the paragraph.** Unity player builds frequently ship serialized files with typetrees
stripped. If EFT's files do, the schema does not come from the file — it comes from UnityPy's
version-keyed generated typetree database. That is a **third-party schema** and it must be pinned by
hash and reviewed before use, exactly like the Unity version. It is also, mildly, the same provenance
problem the red team named: the library that selects the files would also supply the schema for reading
them. The mitigation is that schema ≠ identity — the *numbers* still come from the file's own bytes,
and the submesh cross-check validates the schema against the file's own internal redundancy rather than
against the library's say-so. Say this out loud in the run's evidence; do not let it pass silently.

**Operational rule that follows from row 2.** The schema is per-version, not per-object. One
`end-offset-divergence` or `submesh-bounds-disagree` means the pin is wrong for the whole file, not that
one mesh is odd. The run must **abort**, not skip the object and carry on — a per-object skip would
quietly turn a systematic schema error into a partial roster that looks fine.

---

## 6. What bounds buy, and what they do not

**Buy.**

- Kills the barrel-scored-as-wagon failure outright (0.9 m vs 14.1 m).
- Turns "6 m container" from a name token into a measurement.
- Makes part-vs-placement a physical-size question rather than a lexical one.
- Cheap: bounds are per *mesh resource*, and Customs reuses meshes heavily, so the number of distinct
  Mesh path ids to read is far smaller than the renderer count. Each read is ~216 bytes.

**Do not buy.**

- **Independence.** Same acquisition layer, same selector, same library. Agreement between a
  bounds-informed roster and the second source is still not validation.
- **Placement.** An AABB is a property of the mesh asset. It does not prove a matching GameObject is a
  placed, active, visible wagon rather than a child, collider, LOD node, or inactive placeholder. The
  red team's caution stands unchanged.
- **A world-space footprint, directly.** `m_LocalAABB` is local and pre-transform. A world size needs
  the composed world scale the census already emits, and a *rotated non-uniform* scale makes the
  transformed AABB an over-estimate. Any derived world extent must be labelled derived and carry
  `worldExact` alongside it.
- **A subtree's real size.** Unioning children's transformed AABBs gives a candidate root's extent, but
  that union includes LOD1/LOD2 siblings and collision proxies unless they are excluded first — which
  is a lexical judgement again, i.e. the thing bounds were supposed to escape.

Bottom line for the roster: bounds are a **filter that removes false positives**, not a promoter that
creates confirmed wagons. Nothing about the pending photographic confirmation changes.

---

## 7. The gated operator run (do not run it from an agent session)

The spike proves the mechanism. A production reader is a **separate, separately audited script** — it
does not exist yet, and none of the spike code should be promoted into the repo as-is.

When that script exists, the gated run is:

```bash
# stage 1 — no file opened, no UnityPy import: validates paths and the pins
python scripts/read-mesh-bounds.py \
  --source /path/to/local/game-data \
  --output /path/outside/game-and-repo/customs-mesh-bounds.json \
  --acknowledge-local-game-files \
  --pin-unity-version <version string read from globalgamemanagers> \
  --pin-typetree-sha256 <hash of the reviewed Mesh node tree> \
  --self-test \
  --dry-run

# stage 2 — the real read, same pins, same command minus --dry-run
```

**Evidence the run must produce, or it does not count:**

1. `--self-test` results printed **in the same process at the same commit**: all synthetic cases green,
   including the length-preserving-shift case and both negative controls. A reader whose guards are not
   exercised in the same run has not demonstrated them.
2. The Unity version string as read from the catalog, and an explicit equality assertion against the
   pin. Not "looks like 2019.4" — the exact string.
3. The typetree source (file-embedded vs library-generated) and its SHA-256, matching the pin.
4. Per object: `pathId`, `localAabb.center`, `localAabb.extents`, `submeshCount`.
5. **Both** read tallies — `instrumentation.process.bytesRead` and
   `instrumentation.boundsWalk.bytesRead`. The walk's `walkBytesPerMeshByte` should be < 0.01%; a ratio
   in the percent range means the reader is walking something and the run is void. The process figure
   will be **tens of megabytes** and that is correct and expected — see §10.2. A run reporting only the
   small number is not evidence, it is a misreading waiting to happen.
6. `instrumentation.boundsWalk.steppedOverBytesRead: 0`, which is a measured intersection and can be
   non-zero — see §10.1. `payloadBytesRead` no longer exists; if you see it, you are reading an old
   artifact whose zero meant nothing.
7. A refusal ledger with reason-code counts **and each row's `refusalClass`**. Every class except
   `acquisition` aborts the run (§5, §10.3); the class tells you whether to re-pin the schema
   (`schema-wrong`), look at one unusual object (`reader-limit`), or decide by hand which of the two you
   have (`unverifiable`).
8. The census's existing before/after SHA-256 + stat-identity binding on every file touched.

**Output contract.** Superseded — see §10.4. The spike's `{pathId, localAabb}` is narrower than what the
production reader emits, and the difference was found by review, not declared.

---

## 8. Recommendation

Build the production reader **only if** the roster's current lexical ceiling is actually the binding
constraint on the next decision. It is roughly a day of careful work plus a separate review pass, and
its whole value is removing size-impossible candidates. It does not move the roster one step closer to
being *the truth about the rail yard*; only the survey raid does that.

If it is built, three things are non-negotiable: the read budget in the stream wrapper, the end-offset
checksum, and the submesh cross-check. Ship it with the refusal ledger visible in the artifact, and
keep the roster's language unchanged — a measured 14.1 m object is a **better candidate**, not a
confirmed wagon.

---

## 9. Spike code

Disposable, outside the repo, in this session's scratchpad:
`/tmp/claude-1000/-mnt-c-Users-zeque/d7c4ca26-9174-49d1-8f58-e610bc4829b8/scratchpad/bounds-spike/`
(`schema.py`, `fixture.py`, `reader.py`, `spike.py`, `run.txt`). It is not in the repo, not in
`package.json`, and is expected to vanish with the session. Everything needed to rebuild it is in this
document; nothing downstream should import it.

---

## 10. What the production reader actually claims (2026-09-01 review pass)

`scripts/extract-customs-bounds.py` was reviewed against its own evidence before being cleared to run.
Four of its claims did not survive. This section is the corrected contract; where it disagrees with
§1–§8 above, this section wins — those sections are a record of the spike, not of the shipped reader.

### 10.1 `payloadBytesRead` was a metric that could not fail

`InstrumentedStream.read_at` raises `unexpected-read-kind` **before** appending a read to the log, and
`ReadLog.payload_bytes` summed exactly those reads whose kind was not allowed. No read that reached the
log could contribute, so the number was identically zero however the reader behaved — and the artifact
offered it as proof. A diverged walk was demonstrated placing a physical 4-byte read inside a
compressed-mesh payload range while the reader reported `payloadBytesRead=0`.

It is **deleted**, and the ground-truth intersection that used to run only under `--self-test` now has a
counterpart that runs on every real read:

* `_Ctx.skip` records every byte range the walk advances past, tagged as array/string content or not.
* `stepped_over_bytes_read()` intersects those ranges against the read offsets `InstrumentedStream`
  recorded, and `assert_no_stepped_over_read` refuses on any overlap.
* `assert_walk_accounts_for_every_byte` requires `bytes_taken + bytes_stepped_over` to equal the
  distance the cursor travelled, so there is no unrecorded byte for a read to hide on.
* The two inputs are declared by different mechanisms, so the number is falsifiable: a reader that
  keeps the bookkeeping and reads the ranges anyway drives it non-zero and is refused
  (`test_mutation_a_reader_that_reads_what_it_recorded_as_skipped_is_caught`).

**What it proves:** the walk did not read the bytes it stepped over. **What it does not prove:** that
the walk's idea of where payload lives is correct — under a wrong schema the reads and the skips move
together. Guards 2 and 3 are what establish that, and they run first, so a diverged walk aborts and
never reaches an emitted record. The ground-truth form, against payload ranges declared by an
independent fixture writer, still runs in `--self-test`.

### 10.2 The process reads every byte; the report said otherwise

`_capture_file_binding` streams each selected file end to end through SHA-256, before and after, in both
the catalog phase and the bounds phase, and UnityPy reads the header and object table to enumerate
objects at all. A run that printed `216 bytes read ... 0.001609%, payloadBytesRead=0` had physically
pulled **26,865,928 bytes** off the game files: a **124,379x** understatement inside the operator's own
evidence.

Nothing about the reads changed — hashing is how file identity is proven and nothing payload-bearing is
parsed or emitted by it. What changed is the reporting:

| Field | Means |
| --- | --- |
| `instrumentation.process.bytesRead` | every byte this run pulled off the selected files |
| `…process.identityHashBytes` / `identityHashPasses` / `digestComplete` | the whole-file SHA-256 identity passes, and whether every pass reported its size |
| `…process.unityLoaderBytes` | what UnityPy pulled through the counted stream |
| `instrumentation.boundsWalk.bytesRead` | the AABB walk alone |
| `…boundsWalk.meshBytesDeclared` / `walkBytesPerMeshByte` | what it walked over, and the ratio (was `totalMeshBytes` / `bytesReadRatio`) |

The claim these support is **"no payload was PARSED or EMITTED"**, never "almost nothing was read". The
terminal summary prints the process figure first, then the walk's, then that sentence. The census
helpers that do the reading are metered by wrapping them for the duration of a phase (`_ProcessMeter.
meter_census`) rather than forking them, so no second copy of the file-binding rules exists. Two
independent tallies of the walk's own reads — the read log and the counting handle — are compared per
object, so a read issued around the instrumentation aborts the run instead of vanishing.

### 10.3 An abort now says which kind of abort it is

A zero-SubMesh Mesh is legal Unity data (empty, collider-only, procedurally cleared). It refused as
`submesh-count-implausible`, which is not in `SKIP_REASONS`, so the run aborted telling the operator the
pinned schema was wrong for the entire file — when the schema was correct and one object was unusual.

The decision is unchanged: everything outside `SKIP_REASONS` still aborts, and none of these were
demoted into it. The **diagnosis** is now classified (`REFUSAL_CLASSES`):

| Class | Means | Examples |
| --- | --- | --- |
| `schema-wrong` | the pin does not describe this file; re-pin before reading anything | `end-offset-divergence`, `schema-divergence`, `field-overruns-object` |
| `reader-limit` | legal data this reader cannot police; the pin is not implicated | `zero-submesh-mesh`, `submesh-count-over-crosscheck-limit`, `read-budget-exceeded` |
| `unverifiable` | schema error **or** a hand-authored `m_LocalAABB`; this reader cannot tell which | `submesh-bounds-disagree` |
| `pin-mismatch` | declared provenance is not the pinned one | `unpinned-typetree` |
| `acquisition` | a per-object fact; the only class that skips instead of aborting | `external-stream-reference` |

`submesh-count-implausible` is gone, split into `zero-submesh-mesh` and
`submesh-count-over-crosscheck-limit`. Every refusal row in the artifact carries its `refusalClass`, the
abort message states the class and what it means, and a test scans the source so no reason code can be
added without being classified.

### 10.4 The real output contract

Wider than §7 claimed. Each key is justified; two were dropped as duplicates.

**Per record** — `objectId` (census-compatible join key), `asset` (which authorized file), `sourceRole`
(level vs sharedassets), `sceneIndex` (the Customs index that authorized the open), `pathId` (identity
in the file), `type` (always `Mesh`; keeps a quoted row self-describing), `submeshCount` (guard 3's
fan-out on this object — a 1-SubMesh cross-check is far weaker than a 12-SubMesh one, so it is the
reader's own confidence about the row), `localAabb` (the measurement).

**Dropped:** `sourceFile`, which was set to the same string as `asset` on every record, and the
per-record `instrumentation` block — six keys per mesh that were constant, aggregated in the envelope
anyway, or zero-by-refusal.

**Envelope** — the pin block, the self-test summary, the two instrumentation blocks of §10.2, the
refusal ledger with classes, the counts, and the caveat. `results` and `detail` were removed from the
allowlist (they named a self-test block `main()` never writes), along with `payloadBytesRead`,
`totalMeshBytes` and `bytesReadRatio`.

The allowlist is **wider than before, not narrower**: honest read accounting costs keys. The
justification for each is in `BOUNDS_ENVELOPE_EXTRA_KEYS`'s comment block, and
`test_the_envelope_allowlist_carries_no_key_the_envelope_cannot_emit` fails if a key in the allowlist is
not reachable in the emitter.

### 10.5 The output may not land inside the game install

`--source <install>/EscapeFromTarkov_Data --output <install>/customs-bounds.json` exited 0 and wrote a
3,000-byte JSON file into the game tree: the census guard excludes only the directory named by
`--source`, and the install is its parent. `_assert_output_outside_game_install` adds two rules — a
Unity `*_Data` source means the install root is its parent and the output must be outside it, and every
ancestor of the output is checked for install markers (`EscapeFromTarkov.exe`, `UnityPlayer.dll`,
`steamapps`, a `*_Data` directory containing `globalgamemanagers`, and the obvious names). The error
message names no path.
