#!/usr/bin/env python3
"""Compose labelled, hash-receipted fixed-camera vegetation QA sheets."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

from PIL import Image, ImageDraw, ImageFont, __version__ as PILLOW_VERSION


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def font(size: int, *, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
        Path("/usr/share/fonts/TTF/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/TTF/DejaVuSans.ttf"),
    ]
    for candidate in candidates:
        if candidate.is_file():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default()


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build one fixed-camera LOD contact sheet.")
    parser.add_argument("--title", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--row", nargs=4, action="append", metavar=("LABEL", "LOD0", "LOD1", "LOD2"), required=True)
    parser.add_argument("--column-labels", nargs=3, default=("LOD0", "LOD1", "LOD2"), metavar=("COLUMN0", "COLUMN1", "COLUMN2"))
    parser.add_argument("--cell-size", type=int, default=320)
    args = parser.parse_args(argv)
    args.output = args.output.expanduser().resolve()
    args.receipt = args.receipt.expanduser().resolve()
    require(256 <= args.cell_size <= 1024, "--cell-size must be 256..1024")
    require(args.output.suffix.lower() == ".png", "contact sheet output must be PNG")
    require(args.receipt.suffix.lower() == ".json", "contact sheet receipt must be JSON")
    require(args.output != args.receipt and not args.output.exists() and not args.receipt.exists(), "contact sheet outputs are no-clobber")
    require(1 <= len(args.row) <= 16, "contact sheet must contain 1..16 rows")
    normalized = []
    for label, *images in args.row:
        paths = [Path(value).expanduser().resolve() for value in images]
        require(label.strip() == label and label, "row label must be non-empty and trimmed")
        require(all(path.is_file() and not path.is_symlink() and path.suffix.lower() == ".png" for path in paths), f"row {label} contains an invalid PNG")
        normalized.append((label, paths))
    args.row = normalized
    args.output.parent.mkdir(parents=True, exist_ok=True)
    require(args.receipt.parent == args.output.parent, "contact sheet receipt must be beside the PNG")
    return args


def main() -> None:
    args = parse_args(sys.argv[1:])
    cell = args.cell_size
    label_width = 250
    header_height = 88
    footer_height = 70
    width = label_width + cell * 3
    height = header_height + cell * len(args.row) + footer_height
    sheet = Image.new("RGB", (width, height), (20, 24, 27))
    draw = ImageDraw.Draw(sheet)
    title_font = font(25, bold=True)
    header_font = font(19, bold=True)
    label_font = font(18, bold=True)
    small_font = font(14)
    draw.text((20, 16), args.title, fill=(235, 239, 231), font=title_font)
    draw.text((20, 53), "Fixed camera per prototype", fill=(160, 172, 161), font=small_font)
    for lod in range(3):
        x = label_width + lod * cell + cell // 2
        label = args.column_labels[lod]
        box = draw.textbbox((0, 0), label, font=header_font)
        draw.text((x - (box[2] - box[0]) // 2, 50), label, fill=(224, 229, 218), font=header_font)

    input_receipts = []
    for row_index, (label, paths) in enumerate(args.row):
        y = header_height + row_index * cell
        fill = (26, 31, 34) if row_index % 2 == 0 else (30, 35, 38)
        draw.rectangle((0, y, width, y + cell), fill=fill)
        label_lines = label.split(" | ", 1)
        draw.text((18, y + 24), label_lines[0], fill=(238, 241, 231), font=label_font)
        if len(label_lines) > 1:
            draw.text((18, y + 54), label_lines[1], fill=(155, 170, 155), font=small_font)
        for lod, image_path in enumerate(paths):
            with Image.open(image_path) as source:
                require(source.format == "PNG", f"input is not PNG: {image_path.name}")
                frame = source.convert("RGB").resize((cell, cell), Image.Resampling.LANCZOS)
            sheet.paste(frame, (label_width + lod * cell, y))
            input_receipts.append({
                "row": row_index,
                "lod": lod,
                "file": image_path.name,
                "bytes": image_path.stat().st_size,
                "sha256": f"sha256:{sha256_file(image_path)}",
            })

    footer_y = header_height + cell * len(args.row)
    draw.rectangle((0, footer_y, width, height), fill=(14, 17, 19))
    draw.text(
        (18, footer_y + 15),
        "OFFLINE DRAFT — original geometry approximation; no collision; not live; not a source-game asset equivalence claim",
        fill=(218, 174, 112),
        font=small_font,
    )
    draw.text((18, footer_y + 40), "Inspect silhouette, branch/leaf read, material breakup, and LOD continuity.", fill=(155, 165, 157), font=small_font)

    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            sheet.save(handle, format="PNG", optimize=False)
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        args.output.unlink(missing_ok=True)
        raise
    receipt = {
        "schemaVersion": 1,
        "documentType": "tarkovzero-customs-offline-vegetation-contact-sheet-receipt",
        "title": args.title,
        "outputFile": args.output.name,
        "bytes": args.output.stat().st_size,
        "sha256": f"sha256:{sha256_file(args.output)}",
        "dimensions": {"width": width, "height": height, "cell": cell},
        "rows": len(args.row),
        "columns": 3,
        "columnLabels": list(args.column_labels),
        "pillowVersion": PILLOW_VERSION,
        "builderSha256": f"sha256:{sha256_file(Path(__file__).resolve())}",
        "inputs": input_receipts,
        "admission": {"live": False, "collision": False, "geometryApproximation": True},
    }
    payload = (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode("utf-8")
    try:
        descriptor = os.open(args.receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        args.output.unlink(missing_ok=True)
        raise
    print(json.dumps({"output": str(args.output), "receipt": str(args.receipt), "sha256": receipt["sha256"]}, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"vegetation contact sheet failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
