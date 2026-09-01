#!/usr/bin/env python3
"""Verify all three LODs of one offline prototype proof byte-for-byte."""

from __future__ import annotations

import argparse
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
    parser = argparse.ArgumentParser(description="Verify one three-LOD proof deterministically.")
    parser.add_argument("--proof-root", type=Path, required=True)
    parser.add_argument("--blender", type=Path, required=True)
    parser.add_argument("--prototype", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    args.proof_root = args.proof_root.expanduser().resolve()
    args.blender = args.blender.expanduser().resolve()
    args.output = args.output.expanduser().resolve()
    require(args.proof_root.is_dir() and not args.proof_root.is_symlink(), "proof root must be a regular directory")
    require(args.blender.is_file() and not args.blender.is_symlink(), "Blender must be a regular file")
    require(args.prototype and args.prototype.replace("_", "").isalnum(), "prototype name is unsafe")
    require(args.output.suffix.lower() == ".json" and not args.output.exists(), "output must be a new JSON path")
    return args


def factory_command(
    blender: Path,
    prototype: str,
    lod: int,
    seed: int,
    glb: Path,
    receipt: Path,
    *,
    proof_flag: str | None,
) -> list[str]:
    command = [
        str(blender), "--background", "--factory-startup", "--disable-autoexec",
        "--python-exit-code", "1", "--python", str(FACTORY), "--",
        "--prototype", prototype, "--lod", str(lod), "--seed", str(seed),
        "--output", str(glb), "--receipt", str(receipt),
    ]
    if proof_flag is not None:
        require(proof_flag in {"--pine-alpha-proof", "--deciduous-alpha-proof"}, "unsupported proof flag")
        command.insert(command.index("--output"), proof_flag)
    return command


def main() -> None:
    args = parse_args(sys.argv[1:])
    slug = args.prototype.lower()
    original_root = args.proof_root / "assets" / slug
    repeat_root = args.proof_root / "verification" / "repeats"
    repeat_root.mkdir(parents=True, exist_ok=True)
    factory_hash = f"sha256:{sha256_file(FACTORY)}"
    records = []
    seeds = set()
    proof_flags = set()
    for lod in (0, 1, 2):
        original_receipt = original_root / f"{slug}-lod{lod}.receipt.json"
        require(original_receipt.is_file() and not original_receipt.is_symlink(), f"LOD{lod} receipt is missing")
        receipt_document = json.loads(original_receipt.read_text(encoding="utf-8"))
        require(receipt_document.get("generator", {}).get("scriptSha256") == factory_hash, f"LOD{lod} receipt factory hash is stale")
        require(receipt_document.get("asset", {}).get("prototypeName") == args.prototype, f"LOD{lod} prototype receipt changed")
        seed = receipt_document.get("generated", {}).get("seed")
        require(isinstance(seed, int) and seed >= 0, f"LOD{lod} seed is invalid")
        seeds.add(seed)
        proof = receipt_document.get("proof", {})
        pine_alpha_proof = proof.get("pineAlphaCard") is True
        deciduous_alpha_proof = proof.get("deciduousAlphaCard") is True
        require(not (pine_alpha_proof and deciduous_alpha_proof), f"LOD{lod} mixes proof kinds")
        proof_flag = (
            "--pine-alpha-proof"
            if pine_alpha_proof
            else "--deciduous-alpha-proof"
            if deciduous_alpha_proof
            else None
        )
        proof_flags.add(proof_flag)
        original = original_root / receipt_document["asset"]["outputFile"]
        require(original.is_file() and not original.is_symlink(), f"LOD{lod} original GLB is missing")
        original_hash = sha256_file(original)
        require(receipt_document["asset"]["sha256"] == f"sha256:{original_hash}", f"LOD{lod} original hash receipt changed")
        repeat = repeat_root / f"{slug}-lod{lod}-repeat.glb"
        repeat_receipt = repeat_root / f"{slug}-lod{lod}-repeat.receipt.json"
        require(not repeat.exists() and not repeat_receipt.exists(), f"LOD{lod} repeat paths already exist")
        command = factory_command(
            args.blender, args.prototype, lod, seed, repeat, repeat_receipt,
            proof_flag=proof_flag,
        )
        rebuilt = subprocess.run(command, cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, check=False)
        require(rebuilt.returncode == 0, f"LOD{lod} repeat build failed: {rebuilt.stdout[-3000:]}")
        repeat_hash = sha256_file(repeat)
        require(repeat_hash == original_hash, f"LOD{lod} repeat is not byte-identical")

        before = (original.stat().st_size, original_hash, sha256_file(original_receipt))
        refused = subprocess.run(
            factory_command(
                args.blender, args.prototype, lod, seed, original, original_receipt,
                proof_flag=proof_flag,
            ),
            cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, check=False,
        )
        require(refused.returncode != 0, f"LOD{lod} no-clobber invocation unexpectedly succeeded")
        after = (original.stat().st_size, sha256_file(original), sha256_file(original_receipt))
        require(after == before, f"LOD{lod} no-clobber invocation mutated an original")
        records.append({
            "lod": lod,
            "seed": seed,
            "original": original.relative_to(args.proof_root).as_posix(),
            "repeat": repeat.relative_to(args.proof_root).as_posix(),
            "sha256": f"sha256:{original_hash}",
            "byteIdentical": True,
            "noClobberExit": refused.returncode,
            "originalGlbAndReceiptUnchanged": True,
            "proofFlag": proof_flag,
        })
    require(len(seeds) == 1, "LOD seeds differ")
    require(len(proof_flags) == 1, "LOD set mixes proof and standard assets")
    report = {
        "schemaVersion": 1,
        "documentType": "tarkovzero-customs-offline-vegetation-prototype-reproducibility",
        "status": "pass-offline-only-not-live",
        "prototype": args.prototype,
        "factorySha256": factory_hash,
        "records": records,
        "admission": {"live": False, "collision": False, "geometryApproximation": True},
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(report, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    print(json.dumps({"output": str(args.output), "prototype": args.prototype, "records": records}, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"prototype reproducibility validation failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
