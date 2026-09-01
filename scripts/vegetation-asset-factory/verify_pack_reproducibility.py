#!/usr/bin/env python3
"""Sample byte determinism and no-clobber behavior in a complete offline pack."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
FACTORY = HERE / "vegetation_factory.py"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Verify deterministic sample rebuilds and no-clobber failure.")
    parser.add_argument("--pack-root", type=Path, required=True)
    parser.add_argument("--blender", type=Path, required=True)
    parser.add_argument("--sample", action="append", default=[], help="PROTOTYPE:LOD")
    parser.add_argument("--all", action="store_true", help="verify every record in the generation manifest")
    parser.add_argument("--jobs", type=int, default=1)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    args.pack_root = args.pack_root.expanduser().resolve()
    args.blender = args.blender.expanduser().resolve()
    args.output = args.output.expanduser().resolve()
    require(args.pack_root.is_dir() and args.blender.is_file(), "pack root or Blender is unavailable")
    require(not args.output.exists() and args.output.suffix.lower() == ".json", "output must be a new JSON path")
    require(1 <= args.jobs <= 8, "--jobs must be between 1 and 8")
    require(bool(args.sample) != bool(args.all), "pass either --sample entries or --all, not both")
    normalized = []
    for value in args.sample:
        parts = value.rsplit(":", 1)
        require(len(parts) == 2 and parts[0] and parts[1] in {"0", "1", "2"}, f"invalid sample {value!r}")
        normalized.append((parts[0], int(parts[1])))
    require(len(set(normalized)) == len(normalized), "reproducibility samples are duplicated")
    args.sample = normalized
    return args


def command(blender: Path, prototype: str, lod: int, seed: int, output: Path, receipt: Path) -> list[str]:
    return [
        str(blender), "--background", "--factory-startup", "--disable-autoexec",
        "--python-exit-code", "1", "--python", str(FACTORY), "--",
        "--prototype", prototype, "--lod", str(lod), "--seed", str(seed),
        "--output", str(output), "--receipt", str(receipt),
    ]


def verify_one(
    blender: Path,
    pack_root: Path,
    repeat_root: Path,
    record: dict,
) -> dict:
    prototype = record["prototype"]
    lod = record["lod"]
    original = (pack_root / record["glb"]).resolve()
    original_receipt = (pack_root / record["receipt"]).resolve()
    require(original.is_file() and original_receipt.is_file(), f"sample original is missing for {prototype}:LOD{lod}")
    slug = prototype.lower()
    repeat = repeat_root / f"{slug}-lod{lod}-repeat.glb"
    repeat_receipt = repeat_root / f"{slug}-lod{lod}-repeat.receipt.json"
    require(not repeat.exists() and not repeat_receipt.exists(), f"repeat paths already exist for {prototype}:LOD{lod}")
    invocation = command(blender, prototype, lod, record["seed"], repeat, repeat_receipt)
    rebuilt = subprocess.run(invocation, cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, check=False)
    require(rebuilt.returncode == 0, f"repeat build failed for {prototype}:LOD{lod}: {rebuilt.stdout[-3000:]}")
    original_hash = sha256_file(original)
    repeat_hash = sha256_file(repeat)
    require(original_hash == repeat_hash, f"byte determinism failed for {prototype}:LOD{lod}")

    before_size = original.stat().st_size
    no_clobber = subprocess.run(
        command(blender, prototype, lod, record["seed"], original, original_receipt),
        cwd=REPO,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )
    require(no_clobber.returncode != 0, f"no-clobber invocation unexpectedly succeeded for {prototype}:LOD{lod}")
    require(
        original.stat().st_size == before_size and sha256_file(original) == original_hash,
        f"no-clobber attempt mutated {prototype}:LOD{lod}",
    )
    return {
        "prototype": prototype,
        "lod": lod,
        "seed": record["seed"],
        "original": record["glb"],
        "repeat": repeat.relative_to(pack_root).as_posix(),
        "sha256": f"sha256:{original_hash}",
        "byteIdentical": True,
        "noClobberExit": no_clobber.returncode,
        "originalUnchanged": True,
    }


def main() -> None:
    args = parse_args(sys.argv[1:])
    manifest = json.loads((args.pack_root / "generation-manifest.json").read_text(encoding="utf-8"))
    records = {(record["prototype"], record["lod"]): record for record in manifest["records"]}
    if args.all:
        selected = [records[key] for key in sorted(records, key=lambda key: (key[0].lower(), key[1]))]
    else:
        selected = []
        for prototype, lod in args.sample:
            record = records.get((prototype, lod))
            require(record is not None, f"sample {prototype}:LOD{lod} is absent from generation manifest")
            selected.append(record)
    require(selected, "no reproducibility samples were selected")
    repeat_root = args.pack_root / "verification" / "repeats"
    repeat_root.mkdir(parents=True, exist_ok=True)
    results = []
    if args.jobs == 1:
        for record in selected:
            results.append(verify_one(args.blender, args.pack_root, repeat_root, record))
            print(f"verified {record['prototype']} LOD{record['lod']}", flush=True)
    else:
        with ThreadPoolExecutor(max_workers=args.jobs, thread_name_prefix="veg-repro") as executor:
            futures = {
                executor.submit(verify_one, args.blender, args.pack_root, repeat_root, record): record
                for record in selected
            }
            for future in as_completed(futures):
                record = futures[future]
                results.append(future.result())
                print(f"verified {record['prototype']} LOD{record['lod']}", flush=True)
    results.sort(key=lambda value: (value["prototype"].lower(), value["lod"]))

    report = {
        "schemaVersion": 1,
        "documentType": "tarkovzero-customs-offline-vegetation-reproducibility-validation",
        "status": "pass",
        "coverage": {
            "verified": len(results),
            "packRecords": len(records),
            "mode": "all" if args.all else "sample",
        },
        "samples": results,
        "admission": {"live": False, "collision": False, "geometryApproximation": True},
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(report, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    print(json.dumps({
        "output": str(args.output),
        "coverage": report["coverage"],
        "byteIdentical": sum(1 for value in results if value["byteIdentical"]),
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"vegetation reproducibility validation failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
