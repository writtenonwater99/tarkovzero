#!/usr/bin/env python3
"""Validate actual GLB geometry and receipts for one three-LOD Fortress set."""
from __future__ import annotations

import argparse, json, math, re, struct, sys
from pathlib import Path
from typing import Callable, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.gltf.read import (  # noqa: E402
    expand_bounds, glb_json, named, position_bounds, primitive_triangles,
    require, sha256_file,
)
from lib.gltf import read as _gltf  # noqa: E402
from lib.gltf.lod import assert_contained  # noqa: E402

ASSETS = ("fortress-shell", "zb013-basement")

# --- Cross-LOD silhouette (BUILDING-MASSING.md §5.1) -------------------------
# A coarser LOD may lose material; it may never gain silhouette. `zb013-basement`
# obeys that. `fortress-shell` does NOT, and it is the one asset in this repo
# that is admitted: its three LOD digests are pinned in
# `public/assets/3d/customs/scene-manifest.json`, so correcting the geometry
# re-cuts an asset the founder has already reviewed on a GPU.
#
# What is wrong, measured off the shipped GLBs:
#   LOD1  +15.6681 mm on y.max  — the girder chords go from 0.20 m to 0.28 m
#                                 thick at coarser LODs and are centred on the
#                                 truss profile, so half the extra sticks up
#                                 through the ridge (fortress_factory.py:1356).
#   LOD2  +40.0000 mm on x.max  — the coarse roof panels shrink by 0.08 m at
#                                 LOD1 and by nothing at LOD2 (:1294).
#   LOD2  +15.5926 mm on y.max  — the same girder chord, one step thicker again.
# Net effect: LOD2's box is 31.2607 mm taller than LOD0's, and
# `scene-manifest.json` already absorbed it — the asset's declared
# `bounds.max.y` is LOD2's 18.230173, not LOD0's 18.198912, so the picking and
# shadow proxies are sized to the defect.
#
# The table below is a TRIPWIRE, not a mute button. Every entry must still be
# produced, at exactly this value, and any growth not listed here fails. So the
# gate goes red the moment the geometry moves — including when it is fixed,
# which is the point: fixing it is a founder decision with a stated cost (three
# new digests, a manifest update, and a fresh GPU review), and it must not
# happen as a side effect of an unrelated edit.
FORTRESS_SHELL_KNOWN_GROWTH_MM = {
    (1, "step", "y", "max"): 15.6681,
    (1, "againstLod0", "y", "max"): 15.6681,
    (2, "step", "x", "max"): 40.0,
    (2, "step", "y", "max"): 15.5926,
    (2, "againstLod0", "y", "max"): 31.2607,
}
FORTRESS_SHELL_KNOWN_GROWTH_NOTE = (
    "fortress-shell is ADMITTED: its LOD digests are pinned in scene-manifest.json. "
    "Changing this geometry un-admits a reviewed asset and costs new digests, a manifest "
    "update, and a fresh GPU review. That is the founder's call — see BUILDING-MASSING.md §5.1."
)
KNOWN_LOD_GROWTH_MM = {"fortress-shell": FORTRESS_SHELL_KNOWN_GROWTH_MM, "zb013-basement": {}}
#: This validator's own comparison tolerance. The crackhouse validator uses 1e-5
#: and the industrial one 0.002; the shared helpers take it explicitly so a
#: single default cannot silently loosen or tighten one of the three.
TOLERANCE = 1e-4
SHELL_PIVOT = (202.898880005, 1.729503632, -127.68775177)
SHELL_YAW = -10.342808
SHELL_ROOT_Y = 2.447 - SHELL_PIVOT[1]
SHELL_UPPER_LOCAL_Y = 8.183 - 2.447
SHELL_QUAD = ((-30.960060241, -12.561473777), (30.317091682, -12.458264449), (30.309401501, 12.648307217), (-30.967750422, 12.545097890))
BASEMENT_PIVOT = (206.0, -1.7874, -147.5)
FORBIDDEN = (".local-game-derived", "Construction_factory", "UnityFS", "CAB-", "StreamingAssets", "/mnt/c/", "C:\\")


def close(actual: object, expected: float, tolerance: float = TOLERANCE) -> bool:
    return _gltf.close(actual, expected, tolerance)


def vector_close(actual: object, expected: Sequence[float], tolerance: float = TOLERANCE) -> bool:
    return _gltf.vector_close(actual, expected, tolerance)


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


def geometry_stats(document: dict, select: Callable[[dict], bool] | None = None) -> dict:
    """Triangles and transformed scene bounds over the selected nodes.

    The traversal is `lib.gltf.read.iter_mesh_primitives`; this validator's own
    contract — which nodes count, which statistics are reported, and that a
    POSITION bound must be finite — stays here.
    """
    low_all, high_all, triangles, selected = [math.inf]*3, [-math.inf]*3, 0, 0
    seen_nodes = set()
    for entry in _gltf.iter_mesh_primitives(document, select):
        if entry.node_index not in seen_nodes:
            seen_nodes.add(entry.node_index); selected += 1
        position_index = entry.primitive.get("attributes", {}).get("POSITION")
        require(isinstance(position_index, int), f"{entry.node.get('name')} lacks POSITION")
        low, high = position_bounds(document, position_index, require_finite=True)
        triangles += primitive_triangles(document, entry.primitive, position_index)
        expand_bounds(low_all, high_all, entry.world, low, high)
    require(selected > 0, "selected geometry absent")
    return {"triangles": triangles, "boundsM": {"min": low_all, "max": high_all, "sizeM": [high_all[i]-low_all[i] for i in range(3)], "centerM": [(high_all[i]+low_all[i])/2 for i in range(3)]}}


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
        stats = validate_glb(output, glb_json(output, label=output), receipt, args.asset, lod); costs.append((stats["triangles"],actual_bytes,texture)); details.append({"lod":lod,"bytes":actual_bytes,**stats})
    require(len(hashes) == 1, "factory source hashes differ")
    for lod in (1,2):
        require(all(costs[lod][axis] < costs[lod-1][axis] for axis in range(3)), f"LOD{lod} costs do not strictly fall")
    silhouette = assert_contained(
        {row["lod"]: row["boundsM"] for row in details},
        args.asset,
        known_growth=KNOWN_LOD_GROWTH_MM[args.asset],
        known_growth_note=FORTRESS_SHELL_KNOWN_GROWTH_NOTE if args.asset == "fortress-shell" else "",
    )
    if silhouette["status"] != "PASS":
        print(f"KNOWN DEFECT, PINNED: {args.asset} {silhouette['status']} — {silhouette['knownGrowthNote']}", file=sys.stderr)
    return {"asset":args.asset,"scriptSha256":next(iter(hashes)),"lodSilhouette":silhouette,"lods":details}


if __name__ == "__main__":
    try: print(json.dumps(validate_set(parse_args(sys.argv[1:])), indent=2, sort_keys=True))
    except (OSError, ValueError, json.JSONDecodeError, struct.error) as error:
        print(f"fortress output validation failed: {error}", file=sys.stderr); raise SystemExit(1) from error
