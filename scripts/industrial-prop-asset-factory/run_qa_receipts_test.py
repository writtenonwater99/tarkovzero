#!/usr/bin/env python3
"""Run the gated real-receipt QA test against a build_proof.py output root.

`test_validate_industrial_props.py`'s `test_real_receipt_mutations_are_rejected`
case is skipped by default because it needs 15 real, hash-pinned receipts from
an actual Blender proof build -- something a plain `npm test` cannot produce.
This script finds those receipts under a proof root, points
TZ_INDUSTRIAL_QA_RECEIPTS at them, and runs the test file so that case
actually executes instead of being (loudly) skipped.

Usage:
    python3 scripts/industrial-prop-asset-factory/run_qa_receipts_test.py <proof-root>
    npm run test:industrial-props:receipts -- <proof-root>

<proof-root> is the --output-root passed to build_proof.py: it must contain a
glb/ subdirectory holding the 15 *.receipt.json files (and their sibling
.glb files) the validator expects.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        print("usage: run_qa_receipts_test.py <proof-root-directory>", file=sys.stderr)
        return 2
    proof_root = Path(argv[0]).expanduser().resolve()
    glb_dir = proof_root / "glb"
    if not glb_dir.is_dir():
        print(
            f"error: {glb_dir} is not a directory -- pass the --output-root you gave build_proof.py, "
            "not the glb/ subdirectory itself",
            file=sys.stderr,
        )
        return 2
    receipts = sorted(glb_dir.glob("*.receipt.json"))
    if len(receipts) != 15:
        print(
            f"error: expected 15 receipt files under {glb_dir}, found {len(receipts)}. "
            "Is this a complete build_proof.py output root?",
            file=sys.stderr,
        )
        return 2
    env = dict(os.environ)
    env["TZ_INDUSTRIAL_QA_RECEIPTS"] = ",".join(str(path) for path in receipts)
    completed = subprocess.run(
        [sys.executable, str(HERE / "test_validate_industrial_props.py"), "-v"],
        env=env,
    )
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
