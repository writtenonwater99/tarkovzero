#!/usr/bin/env python3
"""Validate derived gutter/fringe treatment inside bounded vegetation proof GLBs."""

from __future__ import annotations

import argparse
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import struct
import sys

from PIL import Image


GLB_MAGIC = b"glTF"
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942
EXPECTED_TEXTURE_SIZE = (256, 128, 64)
EXPECTED_GUTTER = (4, 2, 1)
EXPECTED_CUTOFF = 0.376
EXPECTED_SOURCE_SHA256 = "sha256:aec3cabf0fa91ca4b3da56084b83aa409f994171ab92424340315acb89e39721"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate embedded deciduous atlas gutters for LOD0/1/2.")
    parser.add_argument("--prototype", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("glbs", nargs=3, type=Path, metavar="GLB")
    args = parser.parse_args(argv)
    require(args.prototype == "tree02", "embedded deciduous proof gate is restricted to tree02")
    args.output = args.output.expanduser().resolve()
    args.glbs = [path.expanduser().resolve() for path in args.glbs]
    require(args.output.suffix.lower() == ".json" and not args.output.exists(), "output must be a new JSON path")
    require(len(set(args.glbs)) == 3, "GLB paths must be unique")
    require(
        all(path.is_file() and not path.is_symlink() and path.suffix.lower() == ".glb" for path in args.glbs),
        "every GLB must be an existing regular file",
    )
    return args


def glb_chunks(path: Path) -> tuple[dict, bytes]:
    payload = path.read_bytes()
    require(len(payload) >= 20, f"GLB is truncated: {path.name}")
    magic, version, declared = struct.unpack_from("<4sII", payload, 0)
    require(magic == GLB_MAGIC and version == 2 and declared == len(payload), f"invalid GLB header: {path.name}")
    offset = 12
    document = None
    binary = None
    while offset + 8 <= len(payload):
        length, kind = struct.unpack_from("<II", payload, offset)
        offset += 8
        end = offset + length
        require(end <= len(payload), f"GLB chunk exceeds file: {path.name}")
        if kind == JSON_CHUNK:
            require(document is None, f"duplicate JSON chunk: {path.name}")
            document = json.loads(payload[offset:end].decode("utf-8").rstrip(" \t\r\n\0"))
        elif kind == BIN_CHUNK:
            require(binary is None, f"duplicate BIN chunk: {path.name}")
            binary = payload[offset:end]
        offset = end
    require(offset == len(payload), f"GLB trailing data: {path.name}")
    require(isinstance(document, dict) and isinstance(binary, bytes), f"GLB chunks are incomplete: {path.name}")
    return document, binary


def embedded_image(document: dict, binary: bytes, image_index: int) -> bytes:
    images = document.get("images", [])
    views = document.get("bufferViews", [])
    require(0 <= image_index < len(images), "atlas image index is invalid")
    image = images[image_index]
    require("uri" not in image and image.get("mimeType") == "image/png", "atlas image must be embedded PNG")
    view_index = image.get("bufferView")
    require(isinstance(view_index, int) and 0 <= view_index < len(views), "atlas image bufferView is invalid")
    view = views[view_index]
    start = int(view.get("byteOffset", 0))
    end = start + int(view.get("byteLength", 0))
    require(0 <= start < end <= len(binary), "atlas image bytes exceed GLB BIN chunk")
    return binary[start:end]


def validate_one(path: Path) -> dict:
    document, binary = glb_chunks(path)
    roots = [
        node for node in document.get("nodes", [])
        if node.get("extras", {}).get("tz_prototype") == "tree02"
    ]
    require(len(roots) == 1, f"{path.name} has no unique tree02 root")
    lod = roots[0].get("extras", {}).get("tz_lod")
    require(lod in (0, 1, 2), f"{path.name} has invalid LOD metadata")
    materials = document.get("materials", [])
    atlas_materials = [material for material in materials if "deciduous_broadleaf_atlas" in material.get("name", "")]
    require(len(atlas_materials) == 1, f"LOD{lod} must contain one deciduous atlas material")
    material = atlas_materials[0]
    require(material.get("alphaMode") == "MASK", f"LOD{lod} atlas is not MASK")
    require(abs(float(material.get("alphaCutoff", -1)) - EXPECTED_CUTOFF) <= 1e-6, f"LOD{lod} cutoff changed")
    require(material.get("doubleSided") is True, f"LOD{lod} atlas is not double-sided")
    extras = material.get("extras", {})
    require(extras.get("tz_source_atlas_sha256") == EXPECTED_SOURCE_SHA256, f"LOD{lod} source hash changed")
    require(extras.get("tz_cell_isolation") == "independent-resample", f"LOD{lod} cell isolation changed")
    require(extras.get("tz_cell_gutter_pixels") == EXPECTED_GUTTER[lod], f"LOD{lod} gutter changed")
    texture_index = material.get("pbrMetallicRoughness", {}).get("baseColorTexture", {}).get("index")
    textures = document.get("textures", [])
    require(isinstance(texture_index, int) and 0 <= texture_index < len(textures), f"LOD{lod} base texture is invalid")
    image_index = textures[texture_index].get("source")
    require(isinstance(image_index, int), f"LOD{lod} base image is invalid")
    png = embedded_image(document, binary, image_index)
    with Image.open(BytesIO(png)) as source:
        require(source.format == "PNG", f"LOD{lod} derived atlas is not PNG")
        image = source.convert("RGBA")
    size = EXPECTED_TEXTURE_SIZE[lod]
    require(image.size == (size, size), f"LOD{lod} derived atlas dimensions changed")
    alpha = image.getchannel("A")
    accepted_threshold = round(EXPECTED_CUTOFF * 255)
    gutter = EXPECTED_GUTTER[lod]
    seams = []
    for column in range(1, 4):
        x = round(column * size / 4)
        values = [
            alpha.getpixel((sample_x, y))
            for sample_x in range(max(0, x - gutter), min(size, x + gutter))
            for y in range(size)
        ]
        seams.append({"axis": "vertical", "coordinate": x, "bandPixels": len(values), "maximumAlpha": max(values, default=0)})
    for row in range(1, 3):
        y = round(row * size / 3)
        values = [
            alpha.getpixel((x, sample_y))
            for sample_y in range(max(0, y - gutter), min(size, y + gutter))
            for x in range(size)
        ]
        seams.append({"axis": "horizontal", "coordinate": y, "bandPixels": len(values), "maximumAlpha": max(values, default=0)})
    require(all(seam["maximumAlpha"] == 0 for seam in seams), f"LOD{lod} derived atlas has alpha in a mip gutter")

    cell_coverage = []
    for row in range(3):
        for column in range(4):
            left = round(column * size / 4)
            right = round((column + 1) * size / 4)
            top = round(row * size / 3)
            bottom = round((row + 1) * size / 3)
            values = list(alpha.crop((left, top, right, bottom)).getdata())
            accepted = sum(value >= accepted_threshold for value in values)
            require(accepted >= max(4, size // 16), f"LOD{lod} cell {row},{column} lost accepted foliage")
            cell_coverage.append({"row": row, "column": column, "acceptedPixels": accepted})

    rgba = list(image.getdata())
    dilated_zero_alpha = sum(value == 0 and (red | green | blue) != 0 for red, green, blue, value in rgba)
    require(dilated_zero_alpha > 0, f"LOD{lod} derived atlas has no RGB edge dilation")
    surviving_chroma = 0
    for red, green, blue, value in rgba:
        if value < accepted_threshold:
            continue
        neon_green = green >= 220 and green > red * 2.3 and green > blue * 2.3
        hot_red = red >= 210 and red > green * 1.9 and red > blue * 1.9
        hot_blue = blue >= 210 and blue > red * 1.9 and blue > green * 1.9
        surviving_chroma += neon_green or hot_red or hot_blue
    require(surviving_chroma == 0, f"LOD{lod} saturated fringe survives alpha cutoff")
    return {
        "lod": lod,
        "file": str(path),
        "pngBytes": len(png),
        "pngSha256": f"sha256:{sha256_bytes(png)}",
        "resolution": size,
        "gutterPixels": gutter,
        "seams": seams,
        "cellCoverage": cell_coverage,
        "acceptedAlphaPixels": sum(value >= accepted_threshold for value in alpha.getdata()),
        "dilatedZeroAlphaRgbPixels": dilated_zero_alpha,
        "survivingSaturatedChromaPixels": surviving_chroma,
        "material": {
            "alphaMode": material["alphaMode"],
            "alphaCutoff": material["alphaCutoff"],
            "doubleSided": material["doubleSided"],
        },
    }


def main() -> None:
    args = parse_args(sys.argv[1:])
    records = sorted((validate_one(path) for path in args.glbs), key=lambda value: value["lod"])
    require([record["lod"] for record in records] == [0, 1, 2], "GLBs must cover LOD0/1/2 exactly")
    report = {
        "schemaVersion": 1,
        "documentType": "tarkovzero-customs-offline-derived-deciduous-atlas-validation",
        "status": "pass-offline-only-not-live",
        "prototype": args.prototype,
        "records": records,
        "admission": {
            "derivedCellIsolation": "pass",
            "alphaContract": "pass",
            "livePromotion": False,
            "runtimeMipBehavior": "untested",
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(report, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    print(json.dumps({"output": str(args.output), "status": report["status"], "records": records}, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, json.JSONDecodeError, struct.error) as error:
        print(f"embedded alpha-atlas validation failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
