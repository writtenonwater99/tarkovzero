#!/usr/bin/env python3
"""Independent admission validator for one three-LOD Crackhouse output set."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import struct
import sys
from typing import Callable, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.gltf.read import (  # noqa: E402
    expand_bounds, glb_json, named, position_bounds, primitive_triangles,
    require, sha256_file,
)
from lib.gltf import read as _gltf  # noqa: E402
from lib.gltf.lod import assert_contained  # noqa: E402


ASSET_ID = "crackhouse-shell"
#: This validator's own comparison tolerance; see the note in
#: `scripts/asset-factory/validate_fortress_outputs.py`.
TOLERANCE = 1e-5
SOURCE_KEY = "svg:Ground_Level/Buildings/Big_Buildings-2:element-197:subpath-0"
SOURCE_FOOTPRINT = ((94.3,-166.5),(89.5,-142.6),(73.6,-145.9),(78.4,-169.7))
GROUND_WORLD_Y = 1.983
UPPER_WORLD_Y = 5.4932
UPPER_LOCAL_Y = UPPER_WORLD_Y - GROUND_WORLD_Y
SOURCE_HEIGHT = 6.5
EXPECTED_OPENINGS = {0: 29, 1: 22, 2: 10}
EXPECTED_DOORS = {0: 4, 1: 4, 2: 4}
EXPECTED_WINDOWS = {0: 25, 1: 18, 2: 6}
EXPECTED_ROOF_TILES = {0: 576, 1: 144, 2: 0}
EXPECTED_STAIR_STEPS = {0: 15, 1: 8, 2: 1}
EXPECTED_TEXTURE = {0: 128, 1: 64, 2: 32}
FORBIDDEN = (".local-game-derived", "UnityFS", "CAB-", "StreamingAssets", "/mnt/c/", "C:\\", "Escape from Tarkov")
#: BUILDING-MASSING.md §5.2. Exposed brick shows *through* missing plaster, so it
#: sits a few millimetres proud of the facade plane. It used to sit 146 mm
#: outboard of it — a hand's width in front of the wall it was showing through —
#: because every facade-attached family re-derived its own offset from
#: `+/- width*.5 +/- <literal>` and nothing asserted the result landed on the
#: surface. The factory now names the plane once; this is the check that makes
#: the naming binding. The width is re-derived here from the public footprint,
#: not read from the receipt, so the two derivations have to agree.
BRICK_PATCH_PROUD_M = 0.004
FACADE_DATUM_TOLERANCE_M = 0.005
#: The exposed-brick patches are the only user of the brick material, so the
#: brick batches ARE the damage family; LOD2 carries no damage at all.
BRICK_FAMILY_LODS = (0, 1)


def close(actual: object, expected: float, tolerance: float = TOLERANCE) -> bool:
    return _gltf.close(actual, expected, tolerance)


def vector_close(actual: object, expected: Sequence[float], tolerance: float = TOLERANCE) -> bool:
    return _gltf.vector_close(actual, expected, tolerance)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("receipts", type=Path, nargs=3)
    return parser.parse_args(argv)


def read_receipt(path: Path) -> dict:
    path = path.expanduser().resolve()
    require(path.is_file() and path.stat().st_size <= 256*1024, f"invalid receipt: {path}")
    document = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(document, dict), f"receipt root is not an object: {path}")
    document["_receiptPath"] = path
    return document


def geometry_stats(document: dict, select: Callable[[dict], bool] | None = None) -> dict:
    """Triangles and transformed scene bounds over the selected nodes.

    Traversal is `lib.gltf.read.iter_mesh_primitives`; the contract stays here.
    Unlike the fortress validator this one does not demand finite POSITION
    bounds — a deliberately looser check that is preserved, not unified.
    """
    minimum,maximum=[math.inf]*3,[-math.inf]*3
    triangles=selected=0
    seen_nodes=set()
    for entry in _gltf.iter_mesh_primitives(document, select):
        if entry.node_index not in seen_nodes:
            seen_nodes.add(entry.node_index); selected += 1
        position_index=entry.primitive.get("attributes",{}).get("POSITION")
        require(isinstance(position_index,int),f"{entry.node.get('name')} has no POSITION")
        low,high=position_bounds(document, position_index)
        triangles += primitive_triangles(document, entry.primitive, position_index)
        expand_bounds(minimum, maximum, entry.world, low, high)
    require(selected>0,"selected geometry absent")
    return {"triangles":triangles,"boundsM":{"min":minimum,"max":maximum,"sizeM":[maximum[i]-minimum[i] for i in range(3)],"centerM":[(maximum[i]+minimum[i])*.5 for i in range(3)]}}


def derived_transform() -> dict:
    pivot=(sum(p[0] for p in SOURCE_FOOTPRINT)/4,GROUND_WORLD_Y,sum(p[1] for p in SOURCE_FOOTPRINT)/4)
    def unit(v: tuple[float,float]) -> tuple[float,float]:
        m=math.hypot(*v);return v[0]/m,v[1]/m
    a=unit((SOURCE_FOOTPRINT[1][0]-SOURCE_FOOTPRINT[0][0],SOURCE_FOOTPRINT[1][1]-SOURCE_FOOTPRINT[0][1]))
    b=unit((SOURCE_FOOTPRINT[2][0]-SOURCE_FOOTPRINT[3][0],SOURCE_FOOTPRINT[2][1]-SOURCE_FOOTPRINT[3][1]))
    long=unit((a[0]+b[0],a[1]+b[1])); width=(-long[1],long[0])
    local=[]
    for point in SOURCE_FOOTPRINT:
        v=(point[0]-pivot[0],point[1]-pivot[2]);local.append((v[0]*long[0]+v[1]*long[1],v[0]*width[0]+v[1]*width[1]))
    length=(math.dist(SOURCE_FOOTPRINT[0],SOURCE_FOOTPRINT[1])+math.dist(SOURCE_FOOTPRINT[2],SOURCE_FOOTPRINT[3]))*.5
    span=(math.dist(SOURCE_FOOTPRINT[1],SOURCE_FOOTPRINT[2])+math.dist(SOURCE_FOOTPRINT[3],SOURCE_FOOTPRINT[0]))*.5
    return {"pivot":pivot,"yaw":math.degrees(math.atan2(long[0],long[1])),"length":length,"width":span,"local":local}


def validate_materials(document: dict, lod: int) -> None:
    materials=document.get("materials",[])
    require(materials,f"LOD{lod} exports no materials")
    blend=[]
    for index,material in enumerate(materials):
        pbr=material.get("pbrMetallicRoughness",{})
        require("baseColorTexture" in pbr and "metallicRoughnessTexture" in pbr,f"LOD{lod} material {index} lacks base/ORM")
        require("normalTexture" in material and "occlusionTexture" in material,f"LOD{lod} material {index} lacks normal/occlusion")
        if material.get("alphaMode","OPAQUE") != "OPAQUE": blend.append(material.get("name",""))
    require(len(blend)==(1 if lod==0 else 0),f"LOD{lod} unexpected transparent material set: {blend}")
    if blend:
        require("glass" in blend[0].lower(),f"LOD{lod} only glass may blend")


def brick_family_selector(node: dict) -> bool:
    return "brick" in str(node.get("name", ""))


def validate_surface_datums(document: dict, lod: int) -> None:
    """Exposed brick must lie on the facade plane it shows through (§5.2).

    Checked against the shipped geometry in the exported glTF frame, where
    `z = -local y`, so the south facade's exterior plaster face is at `+width/2`
    and the north facade's at `-width/2`. A patch that floats in front of the
    plaster reads as a decal stuck on the wall rather than as missing render,
    and there is no other check in this file that would notice.

    This is deliberately narrow — one family, one datum. The general contract
    (`facade_plane(f)`, `floor_plane(i)`, `roof_plane()` for every
    surface-attached family) belongs in the `massing.py` of §4.4 and is not
    invented here on a building that has no massing record yet.
    """
    if lod not in BRICK_FAMILY_LODS:
        require(
            not any(brick_family_selector(node) for node in document.get("nodes", [])),
            f"LOD{lod} carries exposed-brick damage, which only LOD0/LOD1 do",
        )
        return
    half_width = derived_transform()["width"] * 0.5
    expected = half_width + BRICK_PATCH_PROUD_M
    bounds = geometry_stats(document, brick_family_selector)["boundsM"]
    for side, actual, sign in (("max", bounds["max"][2], 1.0), ("min", bounds["min"][2], -1.0)):
        require(
            close(actual, sign * expected, FACADE_DATUM_TOLERANCE_M),
            f"LOD{lod} exposed brick is {abs(actual - sign * expected) * 1000:.1f} mm off its facade datum: "
            f"z.{side} is {actual:.6f}, the facade plane is {sign * half_width:.6f} and the declared "
            f"clearance is {BRICK_PATCH_PROUD_M * 1000:.0f} mm",
        )


def validate_one(receipt: dict, lod: int) -> dict:
    require(receipt.get("schemaVersion")==1,f"LOD{lod} receipt schema changed")
    asset=receipt.get("asset",{}); require(asset.get("id")==ASSET_ID and asset.get("lod")==lod,f"LOD{lod} asset identity changed")
    output_name=asset.get("outputFile");require(isinstance(output_name,str) and Path(output_name).name==output_name,f"LOD{lod} unsafe output name")
    output=receipt["_receiptPath"].parent/output_name;require(output.is_file(),f"LOD{lod} GLB missing")
    require(asset.get("bytes")==output.stat().st_size and asset.get("sha256")==f"sha256:{sha256_file(output)}",f"LOD{lod} file receipt mismatch")
    document=glb_json(output, label=output)
    require(not document.get("cameras") and not document.get("animations") and not document.get("skins"),f"LOD{lod} contains non-static payload")
    require("KHR_lights_punctual" not in document.get("extensions",{}),f"LOD{lod} contains lights")
    for kind in ("buffers","images"):
        require(all("uri" not in entry for entry in document.get(kind,[])),f"LOD{lod} contains external {kind}")
    text=json.dumps(document,separators=(",",":"));require(all(marker not in text for marker in FORBIDDEN),f"LOD{lod} leaks a forbidden source marker")
    validate_materials(document,lod)
    validate_surface_datums(document,lod)
    root=named(document,f"TZ_CrackhouseShell_LOD{lod}_ROOT")
    extras=root.get("extras",{})
    require(extras.get("tz_original_authored") is True,f"LOD{lod} original-authored flag missing")
    require(extras.get("tz_tactical_certified") is False and extras.get("tz_collision_certified") is False and extras.get("tz_collision")=="none",f"LOD{lod} certification boundary changed")
    require(extras.get("tz_opening_void_count")==EXPECTED_OPENINGS[lod],f"LOD{lod} root opening count changed")
    voids=[node for node in document.get("nodes",[]) if str(node.get("name","")).startswith("OpeningVoid_")]
    require(len(voids)==EXPECTED_OPENINGS[lod],f"LOD{lod} real opening void empties changed")
    require(all(node.get("extras",{}).get("tz_real_void") is True for node in voids),f"LOD{lod} void flag missing")
    generated=receipt.get("generated",{})
    for key,expected in (("openingVoids",EXPECTED_OPENINGS[lod]),("doors",EXPECTED_DOORS[lod]),("windows",EXPECTED_WINDOWS[lod]),("roofTiles",EXPECTED_ROOF_TILES[lod]),("stairSteps",EXPECTED_STAIR_STEPS[lod]),("textureResolution",EXPECTED_TEXTURE[lod])):
        require(generated.get(key)==expected,f"LOD{lod} generated.{key} changed")
    claims=receipt.get("claims",{})
    require(claims.get("originalAuthored") is True and all(claims.get(key) is False for key in ("collisionCertified","tacticalCertified","nearOneToOneCertified","openingLayoutMeasured","interiorMeasured")),f"LOD{lod} claim boundary changed")
    truth=receipt.get("truthAnchors",{}); derived=derived_transform(); placement=receipt.get("canonicalPlacement",{})
    require(truth.get("buildingSourceKey")==SOURCE_KEY and truth.get("publicFootprintEftXZ")==[list(p) for p in SOURCE_FOOTPRINT],f"LOD{lod} source footprint changed")
    require(close(truth.get("heightM"),SOURCE_HEIGHT) and truth.get("floors")==2 and truth.get("style")=="gable",f"LOD{lod} public height/floors/style changed")
    require(close(truth.get("groundWorldYM"),GROUND_WORLD_Y) and close(truth.get("upperWorldYM"),UPPER_WORLD_Y) and close(truth.get("upperLocalYM"),UPPER_LOCAL_Y),f"LOD{lod} floor elevations changed")
    require(vector_close(truth.get("localFootprintQuadM",[])[0],derived["local"][0]) and all(vector_close(a,b) for a,b in zip(truth.get("localFootprintQuadM",[]),derived["local"])),f"LOD{lod} local footprint derivation changed")
    pivot=placement.get("recommendedEftPivotM",{});require(all(close(pivot.get(axis),value) for axis,value in zip(("x","y","z"),derived["pivot"])) and close(placement.get("yawDeg"),derived["yaw"]),f"LOD{lod} canonical placement changed")
    stats=geometry_stats(document);declared=asset.get("boundsM",{})
    require(all(vector_close(declared.get(key),stats["boundsM"][key],.002) for key in ("min","max","sizeM","centerM")),f"LOD{lod} actual bounds differ from receipt")
    require(generated.get("triangles")==stats["triangles"],f"LOD{lod} actual triangles differ from receipt")
    require(close(stats["boundsM"]["min"][1],-.18,.002) and close(stats["boundsM"]["max"][1],SOURCE_HEIGHT,.002),f"LOD{lod} vertical shell bounds changed")
    ground=geometry_stats(document,lambda node:node.get("name")=="GroundSlab")["boundsM"]
    expected_x=(min(p[0] for p in derived["local"]),max(p[0] for p in derived["local"]))
    expected_z=(-max(p[1] for p in derived["local"]),-min(p[1] for p in derived["local"]))
    require(vector_close(ground["min"],[expected_x[0],-.18,expected_z[0]],.002) and vector_close(ground["max"],[expected_x[1],.02,expected_z[1]],.002),f"LOD{lod} exact ground prism changed")
    upper=geometry_stats(document,lambda node:str(node.get("name","")).startswith("UpperSlab_"))["boundsM"]
    require(close(upper["max"][1],UPPER_LOCAL_Y,.002),f"LOD{lod} upper slab top changed")
    require(len(document.get("meshes",[]))<=32,f"LOD{lod} mesh/draw-call budget exceeded")
    require(len(document.get("nodes",[]))<=96,f"LOD{lod} node budget exceeded")
    require(generated.get("meshObjectsAfterBatch")==len(document.get("meshes",[])),f"LOD{lod} batched mesh receipt changed")
    provenance=receipt.get("provenance",{})
    require(provenance.get("gameFilesReadByGenerator") is False and all(provenance.get(key) is False for key in ("gameMeshesIncluded","gameTexturesIncluded","gameShadersIncluded","bakedLightingIncluded","fogIncluded")),f"LOD{lod} provenance boundary changed")
    return {"lod":lod,"bytes":output.stat().st_size,"sha256":asset["sha256"],"triangles":stats["triangles"],"nodes":len(document.get("nodes",[])),"meshes":len(document.get("meshes",[])),"materials":len(document.get("materials",[])),"images":len(document.get("images",[])),"boundsM":stats["boundsM"],"scriptSha256":receipt.get("generator",{}).get("scriptSha256")}


def validate_set(args: argparse.Namespace) -> dict:
    receipts=sorted((read_receipt(path) for path in args.receipts),key=lambda row:row.get("asset",{}).get("lod",-1))
    require([row.get("asset",{}).get("lod") for row in receipts]==[0,1,2],"receipts must cover LOD0/1/2")
    details=[validate_one(receipt,lod) for lod,receipt in enumerate(receipts)]
    require(len({row["scriptSha256"] for row in details})==1 and details[0]["scriptSha256"].startswith("sha256:"),"factory source hashes differ")
    require(len({row["sha256"] for row in details})==3,"LOD GLB hashes must be distinct")
    for lod in (1,2):
        require(details[lod]["bytes"]<details[lod-1]["bytes"],f"LOD{lod} bytes do not fall")
        require(details[lod]["triangles"]<details[lod-1]["triangles"],f"LOD{lod} triangles do not fall")
    # Costs falling is not enough. Until this landed, nothing in this file
    # compared one LOD's bounds against another's, and the shipped candidate's
    # LOD1 was 26.34 mm wider than LOD0 with every check above green
    # (BUILDING-MASSING.md §5.1). No waiver: the Crackhouse is an offline
    # candidate, so there is nothing here to re-admit.
    silhouette=assert_contained({row["lod"]:row["boundsM"] for row in details},ASSET_ID)
    return {"status":"PASS","asset":ASSET_ID,"scriptSha256":details[0]["scriptSha256"],"lodSilhouette":silhouette,"lods":[{key:value for key,value in row.items() if key not in ("scriptSha256",)} for row in details]}


if __name__ == "__main__":
    try:
        print(json.dumps(validate_set(parse_args(sys.argv[1:])),indent=2,sort_keys=True))
    except (OSError,ValueError,json.JSONDecodeError,struct.error) as error:
        print(f"Crackhouse output validation failed: {error}",file=sys.stderr)
        raise SystemExit(1) from error
