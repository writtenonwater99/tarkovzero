#!/usr/bin/env python3
"""Independent receipt, geometry, embedding, and LOD validator."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import stat
import struct
import sys
import tempfile
from typing import Sequence


HERE = Path(__file__).resolve().parent
FACTORY = HERE / "industrial_prop_factory.py"
EXPECTED = {
    ("shipping-container", variant, lod)
    for variant in ("red", "green", "blue")
    for lod in (0, 1, 2)
} | {
    (family, "default", lod)
    for family in ("diesel-shunter", "tanker-wagon")
    for lod in (0, 1, 2)
}
FORBIDDEN = ("UnityFS", "CAB-", "StreamingAssets", "EscapeFromTarkov", "Re3mr", "/mnt/c/", "C:\\")
REQUIRED_COMPONENTS = {
    "shipping-container": {"corrugated-side", "cargo-door", "locking-bar", "corner-casting", "container-frame"},
    "diesel-shunter": {"cab", "cab-window", "engine-hood", "bogie-frame", "wheel", "coupler", "handrail", "vent"},
    "tanker-wagon": {"vessel", "bogie-frame", "wheel", "coupler", "tank-band", "hatch", "ladder", "hatch-rail"},
}


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
    parser = argparse.ArgumentParser()
    parser.add_argument("--receipt", action="append", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    require(len(args.receipt) == len(EXPECTED), f"exactly {len(EXPECTED)} receipt paths are required")
    if args.output is not None:
        args.output = args.output.expanduser().resolve()
        require(args.output.suffix.lower() == ".json" and not args.output.exists(), "--output must be a new .json path")
    return args


def read_regular_json(path: Path) -> dict:
    path = path.expanduser().resolve()
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and not path.is_symlink() and info.st_size <= 256 * 1024, f"invalid receipt: {path}")
    document = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(document, dict), f"receipt must be an object: {path}")
    document["_path"] = path
    return document


def glb_json(path: Path) -> dict:
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and not path.is_symlink(), f"GLB must be a regular non-symlink: {path}")
    require(8 * 1024 <= info.st_size <= 8 * 1024 * 1024, f"GLB byte envelope failed: {path}")
    blob = path.read_bytes()
    magic, version, length = struct.unpack_from("<4sII", blob, 0)
    require((magic, version, length) == (b"glTF", 2, len(blob)), f"invalid GLB header: {path}")
    offset = 12
    document = None
    json_chunks = 0
    binary_chunks = 0
    while offset + 8 <= len(blob):
        chunk_length, chunk_type = struct.unpack_from("<II", blob, offset)
        offset += 8
        end = offset + chunk_length
        require(end <= len(blob), f"GLB chunk exceeds file: {path}")
        if chunk_type == 0x4E4F534A:
            json_chunks += 1
            document = json.loads(blob[offset:end].decode("utf-8"))
        elif chunk_type == 0x004E4942:
            binary_chunks += 1
        offset = end
    require(offset == len(blob) and json_chunks == 1 and binary_chunks == 1 and isinstance(document, dict), f"GLB chunks invalid: {path}")
    return document


def matrix_multiply(a: Sequence[Sequence[float]], b: Sequence[Sequence[float]]) -> list[list[float]]:
    return [[sum(a[row][inner] * b[inner][column] for inner in range(4)) for column in range(4)] for row in range(4)]


def node_matrix(node: dict) -> list[list[float]]:
    if "matrix" in node:
        values = node["matrix"]
        require(isinstance(values, list) and len(values) == 16, "node matrix invalid")
        return [[float(values[column * 4 + row]) for column in range(4)] for row in range(4)]
    x, y, z, w = map(float, node.get("rotation", [0, 0, 0, 1]))
    sx, sy, sz = map(float, node.get("scale", [1, 1, 1]))
    tx, ty, tz = map(float, node.get("translation", [0, 0, 0]))
    rotation = (
        (1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)),
        (2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)),
        (2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)),
    )
    return [
        [rotation[0][0] * sx, rotation[0][1] * sy, rotation[0][2] * sz, tx],
        [rotation[1][0] * sx, rotation[1][1] * sy, rotation[1][2] * sz, ty],
        [rotation[2][0] * sx, rotation[2][1] * sy, rotation[2][2] * sz, tz],
        [0.0, 0.0, 0.0, 1.0],
    ]


def geometry_stats(document: dict) -> dict:
    accessors = document.get("accessors", [])
    meshes = document.get("meshes", [])
    nodes = document.get("nodes", [])
    identity = [[float(row == column) for column in range(4)] for row in range(4)]
    minimum = [math.inf, math.inf, math.inf]
    maximum = [-math.inf, -math.inf, -math.inf]
    triangles = vertices = draw_calls = 0
    visited_meshes: set[int] = set()

    def visit(index: int, parent: Sequence[Sequence[float]]) -> None:
        nonlocal triangles, vertices, draw_calls
        node = nodes[index]
        world = matrix_multiply(parent, node_matrix(node))
        if "mesh" in node:
            mesh_index = int(node["mesh"])
            require(mesh_index not in visited_meshes, "instanced mesh is outside this proof contract")
            visited_meshes.add(mesh_index)
            for primitive in meshes[mesh_index].get("primitives", []):
                draw_calls += 1
                position_index = primitive.get("attributes", {}).get("POSITION")
                require(isinstance(position_index, int), "primitive lacks POSITION")
                position = accessors[position_index]
                vertices += int(position["count"])
                count = int(accessors[primitive["indices"]]["count"]) if "indices" in primitive else int(position["count"])
                mode = int(primitive.get("mode", 4))
                require(mode in (4, 5, 6), f"unsupported primitive mode: {mode}")
                triangles += count // 3 if mode == 4 else max(0, count - 2)
                low, high = position.get("min"), position.get("max")
                require(isinstance(low, list) and isinstance(high, list) and len(low) == len(high) == 3, "POSITION bounds absent")
                for px in (low[0], high[0]):
                    for py in (low[1], high[1]):
                        for pz in (low[2], high[2]):
                            vector = (float(px), float(py), float(pz), 1.0)
                            point = [sum(world[row][column] * vector[column] for column in range(4)) for row in range(3)]
                            for axis in range(3):
                                minimum[axis] = min(minimum[axis], point[axis])
                                maximum[axis] = max(maximum[axis], point[axis])
        for child in node.get("children", []):
            visit(int(child), world)

    scenes = document.get("scenes", [])
    scene_index = int(document.get("scene", 0))
    require(0 <= scene_index < len(scenes), "default scene invalid")
    for root in scenes[scene_index].get("nodes", []):
        visit(int(root), identity)
    require(draw_calls > 0 and all(math.isfinite(value) for value in minimum + maximum), "GLB has no bounded geometry")
    return {
        "triangles": triangles,
        "vertices": vertices,
        "drawCalls": draw_calls,
        "bounds": {
            "min": minimum,
            "max": maximum,
            "sizeM": [maximum[index] - minimum[index] for index in range(3)],
            "centerM": [(maximum[index] + minimum[index]) * 0.5 for index in range(3)],
        },
    }


def vector_close(actual: object, expected: object, tolerance: float = 0.002) -> bool:
    return (
        isinstance(actual, list)
        and isinstance(expected, list)
        and len(actual) == len(expected)
        and all(math.isfinite(float(a)) and abs(float(a) - float(b)) <= tolerance for a, b in zip(actual, expected))
    )


def root_extras(document: dict) -> dict:
    matches = [node.get("extras", {}) for node in document.get("nodes", []) if str(node.get("name", "")).startswith("TZ_") and str(node.get("name", "")).endswith("_Root")]
    require(len(matches) == 1 and isinstance(matches[0], dict), "exactly one tagged root required")
    return matches[0]


def validate_document_policy(document: dict, family: str, variant: str, lod: int, label: object = "GLB") -> tuple[dict, list[dict]]:
    """Validate payload policy independently of the receipt/file wrapper."""
    text = json.dumps(document, separators=(",", ":"))
    require(all(marker not in text for marker in FORBIDDEN), f"forbidden source marker in {label}")
    require(not document.get("cameras") and not document.get("animations") and not document.get("skins"), f"non-static payload in {label}")
    require("KHR_lights_punctual" not in document.get("extensions", {}) and "KHR_lights_punctual" not in document.get("extensionsUsed", []), f"light payload in {label}")
    require(all("uri" not in value for value in document.get("buffers", [])), f"external buffer in {label}")
    require(all("uri" not in value and isinstance(value.get("bufferView"), int) for value in document.get("images", [])), f"external image in {label}")
    materials = document.get("materials", [])
    require(3 <= len(materials) <= 6, f"material count outside contract: {label}")
    for index, material in enumerate(materials):
        pbr = material.get("pbrMetallicRoughness", {})
        require(material.get("alphaMode", "OPAQUE") == "OPAQUE", f"material {index} is not OPAQUE: {label}")
        require("baseColorTexture" in pbr and "metallicRoughnessTexture" in pbr and "normalTexture" in material and "occlusionTexture" in material, f"material {index} lacks complete PBR: {label}")
        require(pbr["metallicRoughnessTexture"].get("index") == material["occlusionTexture"].get("index"), f"material {index} does not share its embedded ORM texture: {label}")
    require("Original TarkovZero" in document.get("asset", {}).get("copyright", ""), f"copyright marker missing: {label}")
    extras = root_extras(document)
    require(extras.get("tz_asset_family") == family and extras.get("tz_variant") == variant and extras.get("tz_lod") == lod, f"root identity mismatch: {label}")
    require(extras.get("tz_units") == "metres" and extras.get("tz_collision") == "none" and extras.get("tz_original_authored") is True, f"root contract mismatch: {label}")
    inventory = set(str(extras.get("tz_component_inventory", "")).split(","))
    if lod == 0:
        require(REQUIRED_COMPONENTS[family] <= inventory, f"LOD0 semantic components missing for {family}: {sorted(REQUIRED_COMPONENTS[family] - inventory)}")
    stats = geometry_stats(document)
    require(stats["drawCalls"] == len(materials) <= 6, f"draw call/material collapse failed: {label}")
    require(abs(stats["bounds"]["min"][1]) <= 0.002, f"base-center pivot does not touch Y=0: {label}")
    require(abs(stats["bounds"]["centerM"][0]) <= 0.12 and abs(stats["bounds"]["centerM"][2]) <= 0.12, f"footprint is not centered: {label}")
    return stats, materials


def validate_one(receipt: dict) -> dict:
    path: Path = receipt["_path"]
    require(receipt.get("schemaVersion") == 1 and receipt.get("documentType") == "tarkovzero-customs-original-industrial-prop-receipt", f"receipt schema changed: {path}")
    require(receipt.get("status") == "offline-proof-only-not-live", f"receipt status changed: {path}")
    asset = receipt.get("asset", {})
    family, variant, lod = asset.get("family"), asset.get("variant"), asset.get("lod")
    key = (family, variant, lod)
    require(key in EXPECTED, f"unexpected asset identity: {key}")
    require(asset.get("axisPivotContract") == {
        "authorFrame": "+X length, +Y width, +Z up",
        "gltfFrame": "+X length, +Y up, +Z width",
        "units": "metres",
        "pivot": "base-center at (0,0,0)",
    }, f"axis/pivot receipt contract changed: {path}")
    output_data = receipt.get("output", {})
    filename = output_data.get("file")
    require(isinstance(filename, str) and Path(filename).name == filename, f"unsafe output filename: {path}")
    glb = path.parent / filename
    document = glb_json(glb)
    require(output_data.get("bytes") == glb.stat().st_size, f"byte receipt mismatch: {glb}")
    require(output_data.get("sha256") == f"sha256:{sha256_file(glb)}", f"hash receipt mismatch: {glb}")
    require(receipt.get("generator", {}).get("scriptSha256") == f"sha256:{sha256_file(FACTORY)}", f"factory source hash mismatch: {path}")
    provenance = receipt.get("provenance", {})
    claims = receipt.get("claims", {})
    require(provenance.get("eftInstallationRead") is False and provenance.get("gameMeshesCopied") is False and provenance.get("gameTexturesCopied") is False and provenance.get("gameShadersCopied") is False and provenance.get("externalNetworkUsed") is False, f"provenance boundary failed: {path}")
    require(claims.get("embeddedOnly") is True and claims.get("collision") is False and claims.get("cameras") is False and claims.get("lights") is False and claims.get("fog") is False and claims.get("tacticalAccuracy") is False, f"claims contract failed: {path}")
    stats, materials = validate_document_policy(document, family, variant, lod, glb)
    declared_bounds = output_data.get("boundsGltfM", {})
    require(all(vector_close(declared_bounds.get(field), stats["bounds"][field]) for field in ("min", "max", "sizeM", "centerM")), f"bounds receipt mismatch: {glb}")
    for field in ("triangles", "vertices", "drawCalls"):
        require(output_data.get(field) == stats[field], f"{field} receipt mismatch: {glb}")
    return {
        "family": family,
        "variant": variant,
        "lod": lod,
        "file": filename,
        "sha256": output_data["sha256"],
        "bytes": output_data["bytes"],
        "triangles": stats["triangles"],
        "vertices": stats["vertices"],
        "drawCalls": stats["drawCalls"],
        "materials": len(materials),
        "images": len(document.get("images", [])),
        "boundsGltfM": declared_bounds,
    }


def validate_set(receipt_paths: Sequence[Path]) -> dict:
    receipts = [read_regular_json(path) for path in receipt_paths]
    records = [validate_one(receipt) for receipt in receipts]
    keys = {(record["family"], record["variant"], record["lod"]) for record in records}
    require(keys == EXPECTED and len(records) == len(EXPECTED), "asset set is incomplete or duplicated")
    validate_lod_progression(records)
    records.sort(key=lambda value: (value["family"], value["variant"], value["lod"]))
    totals = {
        "glbs": len(records),
        "bytes": sum(record["bytes"] for record in records),
        "triangles": sum(record["triangles"] for record in records),
        "vertices": sum(record["vertices"] for record in records),
        "drawCalls": sum(record["drawCalls"] for record in records),
    }
    return {
        "schemaVersion": 1,
        "documentType": "tarkovzero-customs-industrial-prop-validation",
        "status": "pass-offline-only-not-live",
        "factorySha256": f"sha256:{sha256_file(FACTORY)}",
        "totals": totals,
        "records": records,
        "admission": {
            "livePromotion": False,
            "collision": False,
            "note": "Contract and geometry validity do not prove source-game equivalence, tactical accuracy, placement, or target-GPU performance.",
        },
    }


def validate_lod_progression(records: Sequence[dict]) -> None:
    for family, variant in sorted({(record["family"], record["variant"]) for record in records}):
        lods = sorted((record for record in records if record["family"] == family and record["variant"] == variant), key=lambda value: value["lod"])
        require([record["lod"] for record in lods] == [0, 1, 2], f"LOD sequence incomplete: {family}/{variant}")
        require(lods[0]["triangles"] > lods[1]["triangles"] > lods[2]["triangles"], f"triangle costs do not strictly fall: {family}/{variant}")
        require(lods[0]["bytes"] > lods[1]["bytes"] > lods[2]["bytes"], f"byte costs do not strictly fall: {family}/{variant}")


def write_exclusive(path: Path, document: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(prefix=f".{path.stem}.", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(document, handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.link(temp_name, path)
    finally:
        Path(temp_name).unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        arguments = parse_args(sys.argv[1:])
        report = validate_set(arguments.receipt)
        if arguments.output is not None:
            write_exclusive(arguments.output, report)
        print(json.dumps(report, indent=2, sort_keys=True))
    except (OSError, ValueError, json.JSONDecodeError, struct.error) as error:
        print(f"industrial prop validation failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
