#!/usr/bin/env python3
"""Validate one immutable OpenAI-original foliage atlas and report edge risks."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

from PIL import Image


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
    parser = argparse.ArgumentParser(description="Validate one immutable RGBA foliage atlas.")
    parser.add_argument("--atlas", type=Path, required=True)
    parser.add_argument("--provenance", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    args.atlas = args.atlas.expanduser().resolve()
    args.provenance = args.provenance.expanduser().resolve()
    args.output = args.output.expanduser().resolve()
    require(args.atlas.is_file() and not args.atlas.is_symlink(), "atlas must be a regular file")
    require(args.provenance.is_file() and not args.provenance.is_symlink(), "provenance must be a regular file")
    require(args.output.suffix.lower() == ".json" and not args.output.exists(), "output must be a new JSON path")
    return args


def border_count(alpha: Image.Image, threshold: int) -> dict[str, int]:
    width, height = alpha.size
    return {
        "top": sum(alpha.getpixel((x, 0)) >= threshold for x in range(width)),
        "bottom": sum(alpha.getpixel((x, height - 1)) >= threshold for x in range(width)),
        "left": sum(alpha.getpixel((0, y)) >= threshold for y in range(height)),
        "right": sum(alpha.getpixel((width - 1, y)) >= threshold for y in range(height)),
    }


def internal_grid_count(alpha: Image.Image, columns: int, rows: int, threshold: int, half_width: int = 2) -> dict[str, list[dict[str, int]]]:
    """Count meaningful alpha near source-cell seams without rejecting the immutable source."""
    width, height = alpha.size
    vertical = []
    for column in range(1, columns):
        x = round(column * width / columns)
        count = sum(
            alpha.getpixel((sample_x, y)) >= threshold
            for sample_x in range(max(0, x - half_width), min(width, x + half_width))
            for y in range(height)
        )
        vertical.append({"x": x, "pixels": count})
    horizontal = []
    for row in range(1, rows):
        y = round(row * height / rows)
        count = sum(
            alpha.getpixel((x, sample_y)) >= threshold
            for sample_y in range(max(0, y - half_width), min(height, y + half_width))
            for x in range(width)
        )
        horizontal.append({"y": y, "pixels": count})
    return {"vertical": vertical, "horizontal": horizontal}


def main() -> None:
    args = parse_args(sys.argv[1:])
    provenance = json.loads(args.provenance.read_text(encoding="utf-8"))
    require(provenance.get("schemaVersion") == 1, "provenance schema changed")
    require(provenance.get("origin", {}).get("provider") == "OpenAI", "provider provenance changed")
    require(provenance.get("origin", {}).get("sourceGameTexture") is False, "source-game boundary changed")
    prompt = provenance.get("promptVerbatim", "")
    require(
        isinstance(prompt, str)
        and prompt.startswith("Use case: photorealistic-natural\n")
        and "transparent PNG atlas" in prompt
        and "true transparent alpha" in prompt,
        "verbatim prompt is missing",
    )
    actual_hash = sha256_file(args.atlas)
    require(provenance.get("sha256") == f"sha256:{actual_hash}", "atlas SHA-256 does not match provenance")
    require(provenance.get("bytes") == args.atlas.stat().st_size, "atlas byte count does not match provenance")

    with Image.open(args.atlas) as source:
        require(source.format == "PNG" and source.mode == "RGBA", "atlas must be RGBA PNG")
        require(list(source.size) == [provenance["png"]["width"], provenance["png"]["height"]], "atlas dimensions changed")
        image = source.copy()
    alpha = image.getchannel("A")
    histogram = alpha.histogram()
    total = image.width * image.height
    nonzero = total - histogram[0]
    require(histogram[0] > total * 0.25, "atlas lacks meaningful transparent separation")
    require(nonzero > total * 0.25, "atlas contains too little foliage coverage")
    require(sum(histogram[96:]) > total * 0.20, "atlas lacks enough alpha above the proof cutoff")

    rgba = list(image.getdata())
    transparent = [(red, green, blue) for red, green, blue, value in rgba if value == 0]
    transparent_nonblack = sum((red | green | blue) != 0 for red, green, blue in transparent)
    zero_rgb_ratio = 1.0 - transparent_nonblack / max(1, len(transparent))
    meaningful_border = border_count(alpha, 16)
    require(not any(meaningful_border.values()), "meaningful alpha is clipped by the outer atlas border")

    grid = provenance["png"]["grid"]
    columns = grid["columns"]
    rows = grid["rows"]
    require(columns == 4 and rows == 3 and grid.get("cells") == 12, "foliage atlas grid contract changed")
    cell_reports = []
    for row in range(rows):
        for column in range(columns):
            left = round(column * image.width / columns)
            right = round((column + 1) * image.width / columns)
            top = round(row * image.height / rows)
            bottom = round((row + 1) * image.height / rows)
            cell_alpha = alpha.crop((left, top, right, bottom))
            cell_histogram = cell_alpha.histogram()
            core = sum(cell_histogram[96:])
            require(core >= 10000, f"atlas cell {row},{column} lacks a distinct alpha-cut foliage spray")
            cell_reports.append({
                "row": row,
                "column": column,
                "boundsPx": [left, top, right, bottom],
                "nonzeroAlphaPixels": sum(cell_histogram[1:]),
                "alphaAtLeast96Pixels": core,
            })

    internal_grid = internal_grid_count(alpha, columns, rows, 96)
    internal_grid_pixels = sum(item["pixels"] for axis in internal_grid.values() for item in axis)
    # Generated-image fringes may contain saturated colors at very low alpha.
    # They are reportable, but no such pixel may survive the intended alpha cut.
    chroma_fringe_below_cutoff = 0
    chroma_fringe_at_cutoff = 0
    for red, green, blue, value in rgba:
        neon_green = green >= 220 and green > red * 2.3 and green > blue * 2.3
        hot_red = red >= 210 and red > green * 1.9 and red > blue * 1.9
        hot_blue = blue >= 210 and blue > red * 1.9 and blue > green * 1.9
        if neon_green or hot_red or hot_blue:
            if value >= 96:
                chroma_fringe_at_cutoff += 1
            elif value > 0:
                chroma_fringe_below_cutoff += 1
    require(chroma_fringe_at_cutoff == 0, "saturated fringe pixels survive the proof alpha cutoff")

    report = {
        "schemaVersion": 1,
        "documentType": "tarkovzero-original-foliage-source-atlas-validation",
        "status": "pass-with-derived-cell-isolation-required",
        "atlas": {
            "file": args.atlas.name,
            "bytes": args.atlas.stat().st_size,
            "sha256": f"sha256:{actual_hash}",
            "width": image.width,
            "height": image.height,
            "mode": image.mode,
        },
        "alpha": {
            "transparentPixels": histogram[0],
            "fullyOpaquePixels": histogram[255],
            "partialAlphaPixels": sum(histogram[1:255]),
            "alphaAtLeast96Pixels": sum(histogram[96:]),
            "outerBorderAtLeast16": meaningful_border,
            "internalGridAtLeast96FourPixelBand": internal_grid,
            "internalGridAtLeast96Pixels": internal_grid_pixels,
            "transparentRgbBlackRatio": round(zero_rgb_ratio, 8),
            "saturatedChromaFringeBelowCutoffPixels": chroma_fringe_below_cutoff,
            "saturatedChromaFringeAtOrAboveCutoffPixels": chroma_fringe_at_cutoff,
        },
        "cells": cell_reports,
        "qualityDecision": {
            "usable": True,
            "directUnprocessedUse": False,
            "reason": (
                "The twelve silhouettes and outer meaningful-alpha border pass, but transparent RGB is black, "
                "coverage alpha is mostly partial, and source-cell seams may contain accepted alpha."
            ),
            "requiredDerivedTreatment": [
                "repack and resample every cell independently into a bounded internal gutter",
                "discard below-cutoff RGB fringe before dilating credible accepted foliage RGB",
                "use alpha MASK with cutoff at least 0.35",
                "use double-sided cards and atlas-cell UV guards",
                "visually inspect minification and internal-cell bleed before promotion",
            ],
        },
        "copyrightBoundary": {
            "openAiGeneratedOriginal": True,
            "sourceGameTexture": False,
            "sourceGameEquivalenceClaim": False,
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(report, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"source atlas validation failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
