#!/usr/bin/env python3
"""Validate actual GLB geometry and receipts for one three-LOD Fortress set."""
from __future__ import annotations

import argparse, hashlib, json, math, re, struct, sys
from pathlib import Path
from typing import Callable, Sequence

ASSETS = ("fortress-shell", "zb013-basement")
SHELL_PIVOT = (202.898880005, 1.729503632, -127.68775177)
SHELL_YAW = -10.342808
SHELL_ROOT_Y = 2.447 - SHELL_PIVOT[1]
SHELL_UPPER_LOCAL_Y = 8.183 - 2.447
SHELL_QUAD = ((-30.960060241, -12.561473777), (30.317091682, -12.458264449), (30.309401501, 12.648307217), (-30.967750422, 12.545097890))
BASEMENT_PIVOT = (206.0, -1.7874, -147.5)
FORBIDDEN = (".local-game-derived", "Construction_factory", "UnityFS", "CAB-", "StreamingAssets", "/mnt/c/", "C:\\")


def require(condition: bool, message: str) -> None:
    if not condition: raise ValueError(message)


def close(actual: object, expected: float, tolerance: float = 1e-4) -> bool:
    try: return math.isfinite(float(actual)) and abs(float(actual) - expected) <= tolerance
    except (TypeError, ValueError): return False


def vector_close(actual: object, expected: Sequence[float], tolerance: float = 1e-4) -> bool:
    return isinstance(actual, list) and len(actual) == len(expected) and all(close(a, e, tolerance) for a, e in zip(actual, expected))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""): digest.update(chunk)
    return digest.hexdigest()


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--asset", choices=ASSETS, required=True)
    parser.add_argument("receipts", type=Path, nargs=3)
    return parser.parse_args(argv)


def read_receipt(path: Path) -> dict:
    path = path.expanduser().resolve()
    require(path.is_file() and path.stat().st_size <= 256 * 1024, f"invalid receipt: {path}")
    document = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(document, dict), f"receipt is not an object: {path}")
    document["_receiptPath"] = path
    return document


def glb_json(path: Path) -> dict:
    blob = path.read_bytes()
    require(len(blob) >= 20, f"truncated GLB: {path}")
    magic, version, length = struct.unpack_from("<4sII", blob, 0)
    require((magic, version, length) == (b"glTF", 2, len(blob)), f"invalid GLB header: {path}")
    offset, document = 12, None
    while offset + 8 <= len(blob):
        chunk_length, chunk_type = struct.unpack_from("<II", blob, offset); offset += 8
        end = offset + chunk_length; require(end <= len(blob), f"invalid GLB chunk: {path}")
        if chunk_type == 0x4E4F534A:
            require(document is None, f"multiple GLB JSON chunks: {path}")
            document = json.loads(blob[offset:end].decode("utf-8"))
        offset = end
    require(offset == len(blob) and isinstance(document, dict), f"invalid GLB chunks: {path}")
    return document


def matrix_multiply(a: Sequence[Sequence[float]], b: Sequence[Sequence[float]]) -> list[list[float]]:
    return [[sum(a[r][k] * b[k][c] for k in range(4)) for c in range(4)] for r in range(4)]


def node_matrix(node: dict) -> list[list[float]]:
    if "matrix" in node:
        values = node["matrix"]; require(isinstance(values, list) and len(values) == 16, "invalid node matrix")
        return [[float(values[c * 4 + r]) for c in range(4)] for r in range(4)]
    x, y, z, w = map(float, node.get("rotation", [0, 0, 0, 1])); sx, sy, sz = map(float, node.get("scale", [1, 1, 1])); tx, ty, tz = map(float, node.get("translation", [0, 0, 0]))
    rotation = ((1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)), (2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)), (2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)))
    return [[rotation[0][0]*sx, rotation[0][1]*sy, rotation[0][2]*sz, tx], [rotation[1][0]*sx, rotation[1][1]*sy, rotation[1][2]*sz, ty], [rotation[2][0]*sx, rotation[2][1]*sy, rotation[2][2]*sz, tz], [0, 0, 0, 1]]


def geometry_stats(document: dict, select: Callable[[dict], bool] | None = None) -> dict:
    accessors, meshes, nodes = document.get("accessors", []), document.get("meshes", []), document.get("nodes", [])
    identity = [[float(r == c) for c in range(4)] for r in range(4)]
    low_all, high_all, triangles, selected = [math.inf]*3, [-math.inf]*3, 0, 0
    def visit(index: int, parent: Sequence[Sequence[float]]) -> None:
        nonlocal triangles, selected
        node = nodes[index]; world = matrix_multiply(parent, node_matrix(node))
        if (select is None or select(node)) and "mesh" in node:
            selected += 1
            for primitive in meshes[node["mesh"]].get("primitives", []):
                position_index = primitive.get("attributes", {}).get("POSITION")
                require(isinstance(position_index, int), f"{node.get('name')} lacks POSITION")
                accessor = accessors[position_index]; low, high = accessor.get("min"), accessor.get("max")
                require(isinstance(low, list) and isinstance(high, list) and len(low) == len(high) == 3 and all(math.isfinite(float(v)) for v in low+high), "invalid POSITION bounds")
                count = int(accessors[primitive.get("indices", position_index)]["count"]); mode = int(primitive.get("mode", 4))
                require(mode in (4, 5, 6), f"unsupported primitive mode {mode}")
                triangles += count//3 if mode == 4 else max(0, count-2)
                for px in (low[0], high[0]):
                    for py in (low[1], high[1]):
                        for pz in (low[2], high[2]):
                            vector = (float(px), float(py), float(pz), 1.0)
                            point = [sum(world[r][c]*vector[c] for c in range(4)) for r in range(3)]
                            for axis in range(3): low_all[axis] = min(low_all[axis], point[axis]); high_all[axis] = max(high_all[axis], point[axis])
        for child in node.get("children", []): visit(int(child), world)
    scenes = document.get("scenes", []); scene = int(document.get("scene", 0)); require(0 <= scene < len(scenes), "invalid default scene")
    for root in scenes[scene].get("nodes", []): visit(int(root), identity)
    require(selected > 0, "selected geometry absent")
    return {"triangles": triangles, "boundsM": {"min": low_all, "max": high_all, "sizeM": [high_all[i]-low_all[i] for i in range(3)], "centerM": [(high_all[i]+low_all[i])/2 for i in range(3)]}}


def named(document: dict, name: str) -> dict:
    found = [node for node in document.get("nodes", []) if node.get("name") == name]
    require(len(found) == 1, f"expected one node named {name}"); return found[0]


def validate_spatial(document: dict, receipt: dict, asset: str, lod: int) -> None:
    root_name = f"TZ_FortressShell_LOD{lod}_ROOT" if asset == "fortress-shell" else f"TZ_ZB013Basement_LOD{lod}_ROOT"
    root, placement, truth = named(document, root_name), receipt.get("canonicalPlacement", {}), receipt.get("truthAnchors", {})
    extras = root.get("extras", {})
    require(extras.get("tz_tactical_certified") is False and extras.get("tz_collision_certified") is False, f"LOD{lod} hypothesis certification flags changed")
    if asset == "fortress-shell":
        pivot, yaw = SHELL_PIVOT, SHELL_YAW
        require(vector_close(root.get("translation", [0,0,0]), [0, SHELL_ROOT_Y, 0]), f"LOD{lod} shell root changed")
        require(truth.get("footprintLocalQuadM") == [list(p) for p in SHELL_QUAD], f"LOD{lod} footprint quad changed")
        ground = geometry_stats(document, lambda node: node.get("name") == "GroundSlab")["boundsM"]
        require(vector_close(ground["min"], [min(p[0] for p in SHELL_QUAD), SHELL_ROOT_Y-.30, -max(p[1] for p in SHELL_QUAD)], .002), f"LOD{lod} ground minimum changed")
        require(vector_close(ground["max"], [max(p[0] for p in SHELL_QUAD), SHELL_ROOT_Y, -min(p[1] for p in SHELL_QUAD)], .002), f"LOD{lod} ground maximum changed")
        upper = geometry_stats(document, lambda node: str(node.get("name", "")).startswith("UpperSlab_"))["boundsM"]
        require(close(upper["max"][1], SHELL_ROOT_Y+SHELL_UPPER_LOCAL_Y, .002), f"LOD{lod} upper playable top changed")
        if lod == 0:
            names = [str(n.get("name", "")) for n in document.get("nodes", [])]
            require(sum(n.startswith("RoofPanel_") for n in names) == 60, "LOD0 roof panel count changed")
            require(sum(bool(re.fullmatch(r"RoofGirder_\d{2}", n)) for n in names) == 11, "LOD0 girder count changed")
            for key, value in (("tz_truth_roof_panel_count",60), ("tz_truth_girder_count",11), ("tz_truth_metal_support_count",22)): require(extras.get(key) == value, f"LOD0 {key} changed")
    else:
        pivot, yaw = BASEMENT_PIVOT, 90.0
        require(vector_close(root.get("translation", [0,0,0]), [0,0,0]), f"LOD{lod} basement root changed")
        floor = geometry_stats(document, lambda node: node.get("name") == "BasementFloor")["boundsM"]
        require(vector_close(floor["sizeM"], [26,.28,21], .002) and close(floor["max"][1], 0, .002), f"LOD{lod} basement floor contract changed")
    declared = placement.get("recommendedEftPivotM", {})
    require(all(close(declared.get(axis), value) for axis, value in zip(("x","y","z"), pivot)) and close(placement.get("yawDeg"), yaw), f"LOD{lod} placement contract changed")


def validate_glb(path: Path, document: dict, receipt: dict, asset: str, lod: int) -> dict:
    require(not document.get("cameras") and not document.get("animations") and not document.get("skins"), f"LOD{lod} contains non-static payload")
    require("KHR_lights_punctual" not in document.get("extensions", {}), f"LOD{lod} exports lights")
    for kind in ("buffers", "images"):
        require(all("uri" not in entry for entry in document.get(kind, [])), f"LOD{lod} has external {kind}")
    text = json.dumps(document, separators=(",",":")); require(all(marker not in text for marker in FORBIDDEN), f"LOD{lod} leaks forbidden source marker")
    materials = document.get("materials", []); require(materials, f"LOD{lod} has no materials")
    for index, material in enumerate(materials):
        pbr = material.get("pbrMetallicRoughness", {})
        require("baseColorTexture" in pbr and "metallicRoughnessTexture" in pbr and "normalTexture" in material and "occlusionTexture" in material, f"LOD{lod} material[{index}] lacks complete PBR")
    stats, generated = geometry_stats(document), receipt.get("generated", {})
    declared_bounds = receipt.get("asset", {}).get("boundsM", {})
    require(all(vector_close(declared_bounds.get(key), stats["boundsM"][key], .002) for key in ("min","max","sizeM","centerM")), f"LOD{lod} actual bounds differ from receipt")
    require(generated.get("triangles") == stats["triangles"], f"LOD{lod} actual triangles differ from receipt")
    require(generated.get("materialCount") == len(materials) and generated.get("embeddedImageCount") == len(document.get("images", [])), f"LOD{lod} material/image receipt mismatch")
    validate_spatial(document, receipt, asset, lod)
    mesh_count = len(document.get("meshes", [])); require(mesh_count <= (150 if asset == "fortress-shell" else 50), f"LOD{lod} exceeds mesh budget")
    return {"triangles": stats["triangles"], "nodes": len(document.get("nodes", [])), "meshes": mesh_count, "materials": len(materials), "images": len(document.get("images", [])), "boundsM": stats["boundsM"]}


def validate_set(args: argparse.Namespace) -> dict:
    receipts = sorted((read_receipt(path) for path in args.receipts), key=lambda r: r.get("asset",{}).get("lod",-1))
    require([r.get("asset",{}).get("lod") for r in receipts] == [0,1,2], "receipts must cover LOD0/1/2")
    hashes, costs, details = set(), [], []
    for lod, receipt in enumerate(receipts):
        asset = receipt.get("asset", {}); require(receipt.get("schemaVersion") == 1 and asset.get("id") == args.asset, f"LOD{lod} identity mismatch")
        output_name = asset.get("outputFile"); require(isinstance(output_name,str) and Path(output_name).name == output_name, f"LOD{lod} unsafe output name")
        output = receipt["_receiptPath"].parent/output_name; require(output.is_file(), f"LOD{lod} output absent")
        actual_bytes = output.stat().st_size; require(asset.get("bytes") == actual_bytes and asset.get("sha256") == f"sha256:{sha256_file(output)}", f"LOD{lod} file receipt mismatch")
        texture = receipt.get("generated",{}).get("textureResolution"); require(isinstance(texture,int) and texture > 0, f"LOD{lod} texture resolution invalid")
        script_hash = receipt.get("generator",{}).get("scriptSha256"); require(isinstance(script_hash,str) and script_hash.startswith("sha256:"), f"LOD{lod} factory hash absent"); hashes.add(script_hash)
        stats = validate_glb(output, glb_json(output), receipt, args.asset, lod); costs.append((stats["triangles"],actual_bytes,texture)); details.append({"lod":lod,"bytes":actual_bytes,**stats})
    require(len(hashes) == 1, "factory source hashes differ")
    for lod in (1,2):
        require(all(costs[lod][axis] < costs[lod-1][axis] for axis in range(3)), f"LOD{lod} costs do not strictly fall")
    return {"asset":args.asset,"scriptSha256":next(iter(hashes)),"lods":details}


if __name__ == "__main__":
    try: print(json.dumps(validate_set(parse_args(sys.argv[1:])), indent=2, sort_keys=True))
    except (OSError, ValueError, json.JSONDecodeError, struct.error) as error:
        print(f"fortress output validation failed: {error}", file=sys.stderr); raise SystemExit(1) from error
