#!/usr/bin/env python3
"""Build the complete 15-GLB industrial proof and its QA artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


HERE = Path(__file__).resolve().parent
DEFAULT_BLENDER = Path.home() / ".local/share/tarkovzero-tools/blender-4.5.13/blender"
ASSETS = [
    *(('shipping-container', variant, lod) for variant in ('red', 'green', 'blue') for lod in (0, 1, 2)),
    *(('diesel-shunter', 'default', lod) for lod in (0, 1, 2)),
    *(('tanker-wagon', 'default', lod) for lod in (0, 1, 2)),
]
LANDMARK_MAPPING = {
    "customs.prop.industrial_rail_yard.locomotive_west": {"family": "diesel-shunter", "variant": "default"},
    "customs.prop.industrial_rail_yard.locomotive_east": {"family": "diesel-shunter", "variant": "default"},
    "customs.prop.industrial_rail_yard.tanker_1": {"family": "tanker-wagon", "variant": "default"},
    "customs.prop.industrial_rail_yard.tanker_2": {"family": "tanker-wagon", "variant": "default"},
    "customs.prop.industrial_rail_yard.tanker_3": {"family": "tanker-wagon", "variant": "default"},
    "customs.prop.industrial_rail_yard.tanker_4": {"family": "tanker-wagon", "variant": "default"},
    "customs.prop.industrial_rail_yard.red_container_stack": {"family": "shipping-container", "variant": "red"},
    "customs.prop.industrial_rail_yard.red_container_west": {"family": "shipping-container", "variant": "red"},
    "customs.prop.industrial_rail_yard.red_container_east": {"family": "shipping-container", "variant": "red"},
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--blender", type=Path, default=DEFAULT_BLENDER)
    parser.add_argument("--skip-qa", action="store_true")
    args = parser.parse_args()
    args.output_root = args.output_root.expanduser().resolve()
    args.blender = args.blender.expanduser().resolve()
    if args.output_root.exists():
        parser.error(f"refusing to reuse output root: {args.output_root}")
    if not args.blender.is_file():
        parser.error(f"Blender not found: {args.blender}")
    return args


def stem(family: str, variant: str, lod: int) -> str:
    middle = f"-{variant}" if variant != "default" else ""
    return f"{family}{middle}-lod{lod}"


def run(command: list[str], log: Path | None = None) -> None:
    completed = subprocess.run(command, check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if log is not None:
        log.write_text(completed.stdout, encoding="utf-8")
    if completed.returncode != 0:
        raise RuntimeError(f"command failed ({completed.returncode}): {' '.join(command)}\n{completed.stdout[-8000:]}")
    if log is None and completed.stdout:
        print(completed.stdout.rstrip())


def build_assets(args: argparse.Namespace, glb_dir: Path, logs_dir: Path) -> list[Path]:
    receipts: list[Path] = []
    for family, variant, lod in ASSETS:
        name = stem(family, variant, lod)
        output = glb_dir / f"{name}.glb"
        receipt = glb_dir / f"{name}.receipt.json"
        command = [
            str(args.blender), "--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1",
            "--python", str(HERE / "industrial_prop_factory.py"), "--",
            "--asset", family, "--variant", variant, "--lod", str(lod),
            "--output", str(output), "--receipt", str(receipt),
        ]
        run(command, logs_dir / f"{name}.log")
        receipts.append(receipt)
        print(f"built {name}")
    return receipts


def contact_sheet(args: argparse.Namespace, qa_dir: Path, title: str, output_name: str, items: list[tuple[str, Path]], view: str = "oblique") -> None:
    command = [sys.executable, str(HERE / "build_contact_sheet.py"), "--blender", str(args.blender), "--title", title, "--view", view, "--output", str(qa_dir / output_name)]
    for label, path in items:
        command.extend(("--item", f"{label}={path}"))
    run(command)


def main() -> None:
    args = parse_args()
    root = args.output_root
    glb_dir = root / "glb"
    qa_dir = root / "qa"
    logs_dir = root / "logs"
    for directory in (glb_dir, qa_dir, logs_dir):
        directory.mkdir(parents=True, exist_ok=False)
    receipts = build_assets(args, glb_dir, logs_dir)

    validate_command = [sys.executable, str(HERE / "validate_industrial_props.py"), "--output", str(qa_dir / "custom-validation.json")]
    for receipt in receipts:
        validate_command.extend(("--receipt", str(receipt)))
    run(validate_command, logs_dir / "custom-validation.log")

    khronos_command = ["node", str(HERE / "validate_khronos_outputs.mjs"), "--output", str(qa_dir / "khronos-validation.json")]
    for family, variant, lod in ASSETS:
        khronos_command.extend(("--glb", str(glb_dir / f"{stem(family, variant, lod)}.glb")))
    run(khronos_command, logs_dir / "khronos-validation.log")

    run([
        sys.executable, str(HERE / "verify_reproducibility.py"),
        "--proof-root", str(root), "--blender", str(args.blender),
        "--output", str(qa_dir / "reproducibility.json"),
    ], logs_dir / "reproducibility.log")

    if not args.skip_qa:
        contact_sheet(args, qa_dir, "Shipping container · red LOD continuity", "container-red-lod-continuity.png", [
            (f"LOD{lod}", glb_dir / f"shipping-container-red-lod{lod}.glb") for lod in (0, 1, 2)
        ])
        contact_sheet(args, qa_dir, "Shipping container · weathered tint-safe variants", "container-color-variants-lod0.png", [
            (variant.upper(), glb_dir / f"shipping-container-{variant}-lod0.glb") for variant in ("red", "green", "blue")
        ])
        contact_sheet(args, qa_dir, "Diesel shunter · LOD continuity", "diesel-shunter-lod-continuity.png", [
            (f"LOD{lod}", glb_dir / f"diesel-shunter-lod{lod}.glb") for lod in (0, 1, 2)
        ])
        contact_sheet(args, qa_dir, "Tanker wagon · LOD continuity", "tanker-wagon-lod-continuity.png", [
            (f"LOD{lod}", glb_dir / f"tanker-wagon-lod{lod}.glb") for lod in (0, 1, 2)
        ])
        contact_sheet(args, qa_dir, "Rail-stock silhouettes · side admission camera", "rail-stock-side-lod0.png", [
            ("DIESEL SHUNTER", glb_dir / "diesel-shunter-lod0.glb"),
            ("TANKER WAGON", glb_dir / "tanker-wagon-lod0.glb"),
        ], view="side")

    validation = json.loads((qa_dir / "custom-validation.json").read_text(encoding="utf-8"))
    index = {
        "schemaVersion": 1,
        "documentType": "tarkovzero-customs-industrial-prop-proof-index",
        "status": "offline-proof-only-not-live",
        "factorySha256": f"sha256:{sha256_file(HERE / 'industrial_prop_factory.py')}",
        "totals": validation["totals"],
        "landmarkMapping": LANDMARK_MAPPING,
        "records": validation["records"],
        "qa": sorted(path.name for path in qa_dir.glob("*")),
        "admissionBlockers": [
            "not placed or loaded by the runtime",
            "runtime ballast/contact-ground seating and contact shadow integration are not part of reusable prop GLBs",
            "not compared against first-party in-raid fixed-camera captures",
            "not measured on the target GPU",
            "no collision or tactical accuracy claim",
        ],
    }
    target = root / "proof-index.json"
    descriptor, temp_name = tempfile.mkstemp(prefix=".proof-index.", suffix=".json", dir=root)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(index, handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.link(temp_name, target)
    finally:
        Path(temp_name).unlink(missing_ok=True)
    print(json.dumps({"outputRoot": str(root), "totals": validation["totals"], "qa": index["qa"]}, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
