#!/usr/bin/env python3
"""Independent receipt, geometry, embedding, and LOD validator."""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import stat
import struct
import sys
import tempfile
from typing import Sequence

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.gltf.read import (  # noqa: E402
    expand_bounds, position_bounds, primitive_triangles, require, sha256_file,
)
from lib.gltf import read as _gltf  # noqa: E402
from lib.gltf.lod import assert_contained  # noqa: E402


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
    """Deliberately NOT `lib.gltf.read.glb_json`.

    This proof adds three guards the shared reader does not have and must not
    lose: the file must be a regular non-symlink, it must sit inside an 8 KiB –
    8 MiB byte envelope, and it must carry exactly one JSON chunk **and exactly
    one BIN chunk**. Folding this into the shared reader would either weaken
    this contract or impose it on the other two factories, so it stays here.
    """
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


def geometry_stats(document: dict) -> dict:
    accessors = document.get("accessors", [])
    meshes = document.get("meshes", [])
    nodes = document.get("nodes", [])
    minimum = [math.inf, math.inf, math.inf]
    maximum = [-math.inf, -math.inf, -math.inf]
    triangles = vertices = draw_calls = 0
    visited_meshes: set[int] = set()

    # Traversal is `lib.gltf.read.iter_mesh_primitives`. Everything below is
    # this proof's own contract and stays here: the no-instancing rule, the
    # vertex and draw-call tallies, and the `bounds` key (the other two
    # validators report `boundsM`).
    visited_nodes: set[int] = set()
    for entry in _gltf.iter_mesh_primitives(document):
        if entry.node_index not in visited_nodes:
            # Once per node, not once per primitive: a mesh reached from two
            # different nodes is instancing; a mesh with two primitives is not.
            require(entry.mesh_index not in visited_meshes,
                    "instanced mesh is outside this proof contract")
            visited_meshes.add(entry.mesh_index)
            visited_nodes.add(entry.node_index)
        draw_calls += 1
        position_index = entry.primitive.get("attributes", {}).get("POSITION")
        require(isinstance(position_index, int), "primitive lacks POSITION")
        vertices += int(accessors[position_index]["count"])
        triangles += primitive_triangles(document, entry.primitive, position_index)
        low, high = position_bounds(document, position_index)
        expand_bounds(minimum, maximum, entry.world, low, high)
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
        # A cheaper LOD is not automatically a smaller one. `tanker-wagon` passed
        # every check above while its LOD1 stood 15 mm proud of LOD0 on both
        # sides of Z: the tank bands used a fatter tube at coarser LODs and were
        # positioned by their centre-line instead of their outer face
        # (BUILDING-MASSING.md §5.1). No waiver here — these props are
        # offline-proof-only, so nothing is admitted that a fix would re-cut.
        assert_contained(
            {record["lod"]: record["boundsGltfM"] for record in lods},
            f"{family}/{variant}",
        )


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
