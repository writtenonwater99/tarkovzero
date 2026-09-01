#!/usr/bin/env python3
"""Generate all 31 x 3 Customs vegetation GLBs into a fresh offline pack."""

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
CATALOG_PATH = HERE / "prototype_catalog.json"
FACTORY_PATH = HERE / "vegetation_factory.py"
SEED_NAMESPACE = "tarkovzero-customs-vegetation-pack-v1"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def prototype_seed(name: str) -> int:
    digest = hashlib.sha256(f"{SEED_NAMESPACE}\0{name}".encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") & 0x7FFFFFFF


def write_new_json(path: Path, document: dict) -> None:
    payload = json.dumps(document, indent=2, sort_keys=True, ensure_ascii=True) + "\n"
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())


def write_new_text(path: Path, payload: str) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate the complete offline Customs vegetation draft pack.")
    parser.add_argument("--blender", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--jobs", type=int, default=4)
    args = parser.parse_args(argv)
    args.blender = args.blender.expanduser().resolve()
    args.output_root = args.output_root.expanduser().resolve()
    require(args.blender.is_file() and not args.blender.is_symlink(), "--blender must be a regular file")
    require(1 <= args.jobs <= 8, "--jobs must be between 1 and 8")
    if args.output_root.exists():
        require(args.output_root.is_dir() and not args.output_root.is_symlink(), "--output-root must be a directory")
        require(not any(args.output_root.iterdir()), "--output-root must be fresh and empty")
    else:
        args.output_root.mkdir(parents=True)
    return args


def load_catalog() -> dict:
    document = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    prototypes = document.get("prototypes")
    require(document.get("schemaVersion") == 1, "catalog schema changed")
    require(isinstance(prototypes, list) and len(prototypes) == 31, "catalog must contain 31 prototypes")
    require(sum(entry.get("instances", 0) for entry in prototypes) == 8805, "catalog instance total changed")
    require(len({entry.get("name") for entry in prototypes}) == 31, "catalog prototype names are duplicated")
    return document


def run_build(
    blender: Path,
    output_root: Path,
    prototype: dict,
    lod: int,
) -> dict:
    name = prototype["name"]
    slug = name.lower()
    seed = prototype_seed(name)
    asset_dir = output_root / "assets" / slug
    log_dir = output_root / "logs" / "generation"
    asset_dir.mkdir(parents=True, exist_ok=True)
    log_dir.mkdir(parents=True, exist_ok=True)
    glb = asset_dir / f"{slug}-lod{lod}.glb"
    receipt = asset_dir / f"{slug}-lod{lod}.receipt.json"
    log = log_dir / f"{slug}-lod{lod}.log"
    command = [
        str(blender),
        "--background",
        "--factory-startup",
        "--disable-autoexec",
        "--python-exit-code", "1",
        "--python", str(FACTORY_PATH),
        "--",
        "--prototype", name,
        "--lod", str(lod),
        "--seed", str(seed),
        "--output", str(glb),
        "--receipt", str(receipt),
    ]
    result = subprocess.run(
        command,
        cwd=REPO,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    write_new_text(log, result.stdout)
    if result.returncode != 0:
        raise RuntimeError(f"{name} LOD{lod} failed with {result.returncode}:\n{result.stdout[-5000:]}")
    require(glb.is_file() and receipt.is_file(), f"{name} LOD{lod} did not publish both outputs")
    receipt_document = json.loads(receipt.read_text(encoding="utf-8"))
    return {
        "prototype": name,
        "family": prototype["family"],
        "form": prototype["form"],
        "lod": lod,
        "seed": seed,
        "assetId": f"customs.vegetation.{slug}",
        "glb": glb.relative_to(output_root).as_posix(),
        "receipt": receipt.relative_to(output_root).as_posix(),
        "bytes": glb.stat().st_size,
        "sha256": f"sha256:{sha256_file(glb)}",
        "triangles": receipt_document["generated"]["triangles"],
        "textureResolution": receipt_document["generated"]["textureResolution"],
    }


def main() -> None:
    args = parse_args(sys.argv[1:])
    catalog = load_catalog()
    tasks = [
        (prototype, lod)
        for prototype in catalog["prototypes"]
        for lod in (0, 1, 2)
    ]
    records = []
    with ThreadPoolExecutor(max_workers=args.jobs, thread_name_prefix="vegetation-pack") as executor:
        futures = {
            executor.submit(run_build, args.blender, args.output_root, prototype, lod): (prototype["name"], lod)
            for prototype, lod in tasks
        }
        for future in as_completed(futures):
            name, lod = futures[future]
            try:
                record = future.result()
            except Exception as error:
                for pending in futures:
                    pending.cancel()
                raise RuntimeError(f"full-pack generation stopped at {name} LOD{lod}: {error}") from error
            records.append(record)
            print(f"generated {name} LOD{lod}: {record['triangles']} triangles, {record['bytes']} bytes", flush=True)

    records.sort(key=lambda value: (value["prototype"].lower(), value["lod"]))
    require(len(records) == 93, "full pack must contain 93 generation records")
    manifest = {
        "schemaVersion": 1,
        "documentType": "tarkovzero-customs-original-vegetation-generation-manifest",
        "map": "customs",
        "status": "offline-production-draft-not-live",
        "seedNamespace": SEED_NAMESPACE,
        "generator": {
            "factory": "scripts/vegetation-asset-factory/vegetation_factory.py",
            "factorySha256": f"sha256:{sha256_file(FACTORY_PATH)}",
            "catalog": CATALOG_PATH.name,
            "catalogSha256": f"sha256:{sha256_file(CATALOG_PATH)}",
            "blenderVersionSource": "recorded in each per-LOD receipt",
        },
        "counts": {
            "prototypes": 31,
            "lodsPerPrototype": 3,
            "glbs": 93,
            "exactLocalPlacements": 8805,
        },
        "records": records,
        "admission": {
            "live": False,
            "collision": False,
            "geometryTruth": "original approximation informed by scalar prototype identity and fallback envelope",
            "requiredBeforePromotion": [
                "custom receipt and budget validation",
                "Khronos validation for every GLB",
                "fixed-camera visual review",
                "runtime instancing/LOD/performance validation",
            ],
        },
    }
    write_new_json(args.output_root / "generation-manifest.json", manifest)
    print(json.dumps({
        "outputRoot": str(args.output_root),
        "records": len(records),
        "bytes": sum(record["bytes"] for record in records),
        "triangles": sum(record["triangles"] for record in records),
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(f"full vegetation pack generation failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
