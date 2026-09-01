# Customs industrial prop factory

This isolated Blender 4.5 factory authors three recognizable, original rail-yard families for TarkovZero's Customs realism pass:

- a 40-foot ISO-style corrugated container in restrained weathered red, green, and blue variants;
- a compact diesel shunter with cab/window band, two bogies, eight wheels, couplers, hood vents, exhaust, catwalks, and handrails;
- a cylindrical tanker wagon with rounded vessel, underframe, two bogies, eight wheels, bands, hatch/walkway, ladder, rails, valves, and couplers.

Each family has real LOD0/1/2 geometry. Components are merged to one primitive per PBR material at export, keeping each GLB to 3–6 draw calls. Authoring uses Blender's `+X length / +Y width / +Z up` metre frame; GLB export uses glTF `+Y up`, so runtime space is `+X length / +Y height / +Z width`. The pivot is base-center `(0,0,0)`.

## Evidence and copyright boundary

The geometry and embedded base-color/normal/ORM textures are deterministic original procedural work. Allowed inputs are public engineering proportions, repository semantic feature IDs, and sanitized scalar dimensions. The factory does not read an EFT installation and does not copy EFT or Re3mr meshes, topology, UVs, textures, shaders, materials, or pixels. Outputs contain no external URI, camera, light, fog, animation, skin, collision, or tactical-accuracy claim.

## Build an offline proof

```bash
proof_root="$(mktemp -d /tmp/tarkovzero-industrial-props.XXXXXX)"
rmdir "$proof_root"
python3 scripts/industrial-prop-asset-factory/build_proof.py --output-root "$proof_root"
```

The build intentionally requires a nonexistent destination. It creates 15 GLBs, 15 hash-pinned receipts, custom and official Khronos reports, an exact-hash reproducibility rebuild, fixed-camera contact sheets, an exact landmark mapping, and logs. It never writes `public/`, the scene manifest, renderer files, or the game installation.

If a process is interrupted after a GLB is exclusively published but before its receipt is written, keep the partial root as diagnostics and rerun into a newly created root. The no-clobber contract deliberately provides no in-place recovery or overwrite mode.

The full proof already performs this check. To repeat only the disposable rebuild and exact SHA-256 comparison:

```bash
python3 scripts/industrial-prop-asset-factory/verify_reproducibility.py \
  --proof-root "$proof_root" \
  --output "$proof_root/qa/reproducibility.json"
```

## Tests

```bash
blender="$HOME/.local/share/tarkovzero-tools/blender-4.5.13/blender"
"$blender" --background --factory-startup --disable-autoexec --python-exit-code 1 \
  --python scripts/industrial-prop-asset-factory/test_industrial_prop_factory.py

python3 scripts/industrial-prop-asset-factory/test_validate_industrial_props.py
# also wired into `npm test` as test:industrial-props
```

`test_validate_industrial_props.py` has two tiers:

- **Static validator-logic tests** (geometry math, the mutation-rejection contract against a synthetic
  document, LOD-progression math) need no Blender and no real GLBs. These always run, and `npm test` runs
  them via `npm run test:industrial-props`.
- **`test_real_receipt_mutations_are_rejected`** needs 15 real, hash-pinned receipts from an actual proof
  build (LOD monotonicity, PBR completeness, and the forbidden-string scan checked against real Blender
  output, plus the receipt↔GLB byte/sha256/triangle/bounds cross-check and the factory-script hash pin).
  A plain `npm test` cannot produce those, so this case is **gated**, not silently faked: without
  `TZ_INDUSTRIAL_QA_RECEIPTS` set it prints a loud, explicit banner naming exactly what did not run, every
  time the file is imported — that banner is not conditional on `-v` or on which test you're running, so it
  cannot be missed in `npm test` output.

To run the full gated set against a real proof build:

```bash
npm run test:industrial-props:receipts -- "$proof_root"
# or directly:
python3 scripts/industrial-prop-asset-factory/run_qa_receipts_test.py "$proof_root"
```

`run_qa_receipts_test.py` discovers the 15 `*.receipt.json` files under `$proof_root/glb/`, points
`TZ_INDUSTRIAL_QA_RECEIPTS` at them, and runs the test file so the real-output case executes instead of
being skipped. It is intentionally **not** part of `npm test` — it needs an actual proof root as an
argument, which only exists after someone runs `build_proof.py` (see above), and receipts are hash-pinned
to the exact `industrial_prop_factory.py` that built them, so a stale proof root fails loudly (factory
source hash mismatch) rather than passing on drifted output.

## Stable landmark mapping

- `locomotive_west` and `locomotive_east` → `diesel-shunter/default`
- `tanker_1` through `tanker_4` → `tanker-wagon/default`
- `red_container_stack`, `red_container_west`, and `red_container_east` → `shipping-container/red`

This is a prototype-to-feature mapping only. Existing positions, yaw, stacking transforms, terrain seating, picking metadata, and LOD distance selection remain runtime responsibilities.

## Admission status

Outputs are offline-only and are not promoted automatically. Passing tests proves deterministic geometry, provenance, embedding, LOD reduction, and glTF conformance. Live admission still needs fixed-camera human review, placement integration, replacement/proxy verification, and target-GPU measurement; it does not establish source-game equivalence or tactical accuracy.
