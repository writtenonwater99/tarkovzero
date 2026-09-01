#!/usr/bin/env python3
"""Validate fixed-camera alpha-silhouette continuity for a three-LOD proof."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

from PIL import Image, ImageFilter


ALPHA_THRESHOLD = 96
DILATION_KERNEL = 15
THRESHOLDS = {
    1: {
        "minimumAreaRetention": 0.48,
        "maximumAreaRetention": 1.08,
        "minimumWidthRetention": 0.76,
        "maximumWidthRetention": 1.12,
        "minimumHeightRetention": 0.97,
        "maximumHeightRetention": 1.03,
        "maximumCenterShiftFraction": 0.075,
        "minimumDilatedIou": 0.48,
    },
    2: {
        "minimumAreaRetention": 0.30,
        "maximumAreaRetention": 1.08,
        "minimumWidthRetention": 0.70,
        "maximumWidthRetention": 1.15,
        "minimumHeightRetention": 0.96,
        "maximumHeightRetention": 1.03,
        "maximumCenterShiftFraction": 0.10,
        "minimumDilatedIou": 0.34,
    },
}


CATALOG_PATH = Path(__file__).resolve().with_name("prototype_catalog.json")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def catalog_prototype_names() -> list[str]:
    """Any catalog prototype may be measured; the metric is not tree02-specific."""
    document = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    names = [entry["name"] for entry in document["prototypes"]]
    require(len(names) == 31 and len(set(names)) == 31, "prototype catalog names changed")
    return names


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate nested fixed-camera silhouettes for one tree02 LOD0/1/2 proof."
    )
    parser.add_argument("--prototype", choices=sorted(catalog_prototype_names()), required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("images", nargs=3, type=Path, metavar="PNG")
    args = parser.parse_args(argv)
    args.output = args.output.expanduser().resolve()
    require(args.output.suffix.lower() == ".json", "--output must be JSON")
    require(not args.output.exists(), "--output must be a new path")
    args.images = [path.expanduser().resolve() for path in args.images]
    require(len(set(args.images)) == 3, "silhouette paths must be unique")
    for lod, path in enumerate(args.images):
        require(f"lod{lod}" in path.stem.lower(), f"silhouette argument {lod} is not labelled LOD{lod}")
    return args


def load_mask(path: Path) -> tuple[Image.Image, dict]:
    require(path.is_file() and not path.is_symlink(), f"silhouette PNG is missing or a symlink: {path}")
    require(path.suffix.lower() == ".png", f"silhouette input is not PNG: {path}")
    with Image.open(path) as source:
        source.verify()
    with Image.open(path) as source:
        rgba = source.convert("RGBA")
        alpha = rgba.getchannel("A")
        mask = alpha.point(lambda value: 255 if value >= ALPHA_THRESHOLD else 0, mode="1")
        width, height = rgba.size
        require(width == height and 256 <= width <= 2048, f"silhouette dimensions are invalid: {path}")
        corner_alpha = [
            alpha.getpixel((0, 0)),
            alpha.getpixel((width - 1, 0)),
            alpha.getpixel((0, height - 1)),
            alpha.getpixel((width - 1, height - 1)),
        ]
        require(max(corner_alpha) == 0, f"silhouette background is not transparent: {path}")
        bbox = mask.getbbox()
        require(bbox is not None, f"silhouette has no accepted-alpha pixels: {path}")
        pixels = sum(1 for value in mask.getdata() if value)
        require(pixels >= width * height * 0.005, f"silhouette coverage is implausibly small: {path}")
        left, top, right, bottom = bbox
        metrics = {
            "file": path.name,
            "sha256": f"sha256:{sha256_file(path)}",
            "width": width,
            "height": height,
            "acceptedAlphaPixels": pixels,
            "acceptedAlphaFraction": round(pixels / (width * height), 6),
            "boundsPx": [left, top, right, bottom],
            "boundsSizePx": [right - left, bottom - top],
            "boundsCenterPx": [round((left + right) * 0.5, 3), round((top + bottom) * 0.5, 3)],
        }
        return mask, metrics


def intersection_union(first: Image.Image, second: Image.Image) -> tuple[int, int]:
    first_values = first.getdata()
    second_values = second.getdata()
    intersection = 0
    union = 0
    for left, right in zip(first_values, second_values):
        left_on = bool(left)
        right_on = bool(right)
        intersection += int(left_on and right_on)
        union += int(left_on or right_on)
    return intersection, union


def validate(args: argparse.Namespace) -> dict:
    loaded = [load_mask(path) for path in args.images]
    masks = [item[0] for item in loaded]
    lod_metrics = [item[1] for item in loaded]
    sizes = {mask.size for mask in masks}
    require(len(sizes) == 1, "fixed-camera silhouettes must have identical dimensions")

    base = lod_metrics[0]
    base_width, base_height = base["boundsSizePx"]
    base_center_x, base_center_y = base["boundsCenterPx"]
    transitions = []
    base_dilated = masks[0].filter(ImageFilter.MaxFilter(DILATION_KERNEL))
    for lod in (1, 2):
        current = lod_metrics[lod]
        current_width, current_height = current["boundsSizePx"]
        current_center_x, current_center_y = current["boundsCenterPx"]
        area_retention = current["acceptedAlphaPixels"] / base["acceptedAlphaPixels"]
        width_retention = current_width / base_width
        height_retention = current_height / base_height
        center_shift = (
            ((current_center_x - base_center_x) ** 2 + (current_center_y - base_center_y) ** 2) ** 0.5
            / max(base_width, base_height)
        )
        current_dilated = masks[lod].filter(ImageFilter.MaxFilter(DILATION_KERNEL))
        intersection, union = intersection_union(base_dilated, current_dilated)
        require(union > 0, f"LOD{lod} dilated silhouette union is empty")
        dilated_iou = intersection / union
        threshold = THRESHOLDS[lod]
        checks = {
            "areaRetention": threshold["minimumAreaRetention"] <= area_retention <= threshold["maximumAreaRetention"],
            "widthRetention": threshold["minimumWidthRetention"] <= width_retention <= threshold["maximumWidthRetention"],
            "heightRetention": threshold["minimumHeightRetention"] <= height_retention <= threshold["maximumHeightRetention"],
            "centerShift": center_shift <= threshold["maximumCenterShiftFraction"],
            "dilatedIou": dilated_iou >= threshold["minimumDilatedIou"],
        }
        require(all(checks.values()), f"LOD{lod} fixed-camera silhouette continuity failed: {checks}")
        transitions.append({
            "lod": lod,
            "relativeTo": 0,
            "areaRetention": round(area_retention, 6),
            "widthRetention": round(width_retention, 6),
            "heightRetention": round(height_retention, 6),
            "centerShiftFraction": round(center_shift, 6),
            "dilatedIou": round(dilated_iou, 6),
            "dilationRadiusPx": (DILATION_KERNEL - 1) // 2,
            "thresholds": threshold,
            "checks": checks,
            "pass": True,
        })
    return {
        "schemaVersion": 1,
        "prototype": args.prototype,
        "cameraContract": "render_preview.py standard view, identical nominal envelope and camera",
        "alphaThreshold": ALPHA_THRESHOLD,
        "lods": [{"lod": lod, **metrics} for lod, metrics in enumerate(lod_metrics)],
        "transitions": transitions,
        "admission": {
            "fixedCameraSilhouetteContinuity": "pass",
            "livePromotion": False,
            "scope": "offline alpha silhouette only",
        },
        "limitations": [
            "This gate measures one fixed camera and does not replace orbit, animation, wind, mip-transition, or in-map review.",
            "Mask dilation tolerates fine leaf-level changes; it gates the crown envelope and occupied silhouette, not pixel identity.",
        ],
    }


def main() -> None:
    args = parse_args(sys.argv[1:])
    result = validate(args)
    payload = json.dumps(result, indent=2, sort_keys=True) + "\n"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    print(payload, end="")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(f"fixed-camera vegetation continuity validation failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
