#!/usr/bin/env python3
"""Rebuild all 15 GLBs in a fresh temp root and compare exact hashes."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile


HERE = Path(__file__).resolve().parent
DEFAULT_BLENDER = Path.home() / ".local/share/tarkovzero-tools/blender-4.5.13/blender"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--proof-root", type=Path, required=True)
    parser.add_argument("--blender", type=Path, default=DEFAULT_BLENDER)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.proof_root = args.proof_root.expanduser().resolve()
    args.blender = args.blender.expanduser().resolve()
    args.output = args.output.expanduser().resolve()
    if not (args.proof_root / "glb").is_dir() or not args.blender.is_file():
        parser.error("proof root or Blender is invalid")
    if args.output.suffix.lower() != ".json" or args.output.exists():
        parser.error("--output must be a new .json path")
    return args


def main() -> None:
    args = parse_args()
    primary = sorted((args.proof_root / "glb").glob("*.glb"))
    if len(primary) != 15:
        raise ValueError("primary proof must contain exactly 15 GLBs")
    records = []
    with tempfile.TemporaryDirectory(prefix="tarkovzero-industrial-repro-") as raw_temp:
        root = Path(raw_temp)
        for source in primary:
            parts = source.stem.rsplit("-lod", 1)
            lod = int(parts[1])
            identity = parts[0]
            if identity.startswith("shipping-container-"):
                family = "shipping-container"
                variant = identity.removeprefix("shipping-container-")
            else:
                family = identity
                variant = "default"
            output = root / source.name
            receipt = root / f"{source.stem}.receipt.json"
            command = [
                str(args.blender), "--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1",
                "--python", str(HERE / "industrial_prop_factory.py"), "--",
                "--asset", family, "--variant", variant, "--lod", str(lod),
                "--output", str(output), "--receipt", str(receipt),
            ]
            completed = subprocess.run(command, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
            if completed.returncode != 0:
                raise RuntimeError(f"reproducibility rebuild failed: {source.name}")
            first = sha256_file(source)
            second = sha256_file(output)
            if first != second or source.read_bytes() != output.read_bytes():
                raise ValueError(f"binary reproducibility failed: {source.name}")
            records.append({"file": source.name, "sha256": f"sha256:{first}", "bytes": source.stat().st_size, "match": True})
    document = {
        "schemaVersion": 1,
        "documentType": "tarkovzero-customs-industrial-prop-reproducibility",
        "status": "pass",
        "records": records,
        "totals": {"glbs": len(records), "bytes": sum(record["bytes"] for record in records)},
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(prefix=f".{args.output.stem}.", suffix=".json", dir=args.output.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(document, handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.link(temp_name, args.output)
    finally:
        Path(temp_name).unlink(missing_ok=True)
    print(json.dumps(document["totals"], indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
