#!/usr/bin/env python3
"""Independent admission validator for one three-LOD Crackhouse output set."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import struct
import sys
from typing import Callable, Sequence


ASSET_ID = "crackhouse-shell"
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


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def close(actual: object, expected: float, tolerance: float = 1e-5) -> bool:
    try:
        return math.isfinite(float(actual)) and abs(float(actual)-expected) <= tolerance
    except (TypeError, ValueError):
        return False


def vector_close(actual: object, expected: Sequence[float], tolerance: float = 1e-5) -> bool:
    return isinstance(actual, list) and len(actual) == len(expected) and all(close(a,e,tolerance) for a,e in zip(actual,expected))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024*1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


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


def glb_json(path: Path) -> dict:
    blob = path.read_bytes()
    require(len(blob) >= 20, f"truncated GLB: {path}")
    magic, version, length = struct.unpack_from("<4sII", blob, 0)
    require((magic,version,length)==(b"glTF",2,len(blob)), f"invalid GLB header: {path}")
    offset, document = 12, None
    while offset + 8 <= len(blob):
        chunk_length, chunk_type = struct.unpack_from("<II",blob,offset); offset += 8
        end=offset+chunk_length; require(end<=len(blob), f"invalid GLB chunk: {path}")
        if chunk_type == 0x4E4F534A:
            require(document is None, f"multiple GLB JSON chunks: {path}")
            document=json.loads(blob[offset:end].decode("utf-8"))
        offset=end
    require(offset==len(blob) and isinstance(document,dict), f"missing GLB JSON: {path}")
    return document


def multiply4(a: Sequence[Sequence[float]], b: Sequence[Sequence[float]]) -> list[list[float]]:
    return [[sum(a[r][k]*b[k][c] for k in range(4)) for c in range(4)] for r in range(4)]


def node_matrix(node: dict) -> list[list[float]]:
    if "matrix" in node:
        values=node["matrix"]
        require(isinstance(values,list) and len(values)==16,"invalid node matrix")
        return [[float(values[c*4+r]) for c in range(4)] for r in range(4)]
    x,y,z,w=map(float,node.get("rotation",[0,0,0,1])); sx,sy,sz=map(float,node.get("scale",[1,1,1])); tx,ty,tz=map(float,node.get("translation",[0,0,0]))
    rotation=((1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)),(2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)),(2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)))
    return [[rotation[0][0]*sx,rotation[0][1]*sy,rotation[0][2]*sz,tx],[rotation[1][0]*sx,rotation[1][1]*sy,rotation[1][2]*sz,ty],[rotation[2][0]*sx,rotation[2][1]*sy,rotation[2][2]*sz,tz],[0,0,0,1]]


def geometry_stats(document: dict, select: Callable[[dict], bool] | None = None) -> dict:
    accessors,meshes,nodes=document.get("accessors",[]),document.get("meshes",[]),document.get("nodes",[])
    identity=[[float(r==c) for c in range(4)] for r in range(4)]
    minimum,maximum=[math.inf]*3,[-math.inf]*3
    triangles=selected=0
    def visit(index: int, parent: Sequence[Sequence[float]]) -> None:
        nonlocal triangles,selected
        node=nodes[index]; world=multiply4(parent,node_matrix(node))
        if (select is None or select(node)) and "mesh" in node:
            selected += 1
            for primitive in meshes[node["mesh"]].get("primitives",[]):
                position_index=primitive.get("attributes",{}).get("POSITION")
                require(isinstance(position_index,int),f"{node.get('name')} has no POSITION")
                accessor=accessors[position_index]; low,high=accessor.get("min"),accessor.get("max")
                require(isinstance(low,list) and isinstance(high,list) and len(low)==len(high)==3,"invalid POSITION bounds")
                index_accessor=primitive.get("indices")
                count=int(accessors[index_accessor]["count"] if isinstance(index_accessor,int) else accessor["count"])
                mode=int(primitive.get("mode",4)); require(mode in (4,5,6),f"unsupported primitive mode {mode}")
                triangles += count//3 if mode==4 else max(0,count-2)
                for px in (low[0],high[0]):
                    for py in (low[1],high[1]):
                        for pz in (low[2],high[2]):
                            source=(float(px),float(py),float(pz),1.0)
                            point=[sum(world[r][c]*source[c] for c in range(4)) for r in range(3)]
                            for axis in range(3):
                                minimum[axis]=min(minimum[axis],point[axis]);maximum[axis]=max(maximum[axis],point[axis])
        for child in node.get("children",[]): visit(int(child),world)
    scene_index=int(document.get("scene",0)); scenes=document.get("scenes",[])
    require(0<=scene_index<len(scenes),"invalid default scene")
    for root in scenes[scene_index].get("nodes",[]): visit(int(root),identity)
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


def named(document: dict, name: str) -> dict:
    found=[node for node in document.get("nodes",[]) if node.get("name")==name]
    require(len(found)==1,f"expected one node named {name}")
    return found[0]


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


def validate_one(receipt: dict, lod: int) -> dict:
    require(receipt.get("schemaVersion")==1,f"LOD{lod} receipt schema changed")
    asset=receipt.get("asset",{}); require(asset.get("id")==ASSET_ID and asset.get("lod")==lod,f"LOD{lod} asset identity changed")
    output_name=asset.get("outputFile");require(isinstance(output_name,str) and Path(output_name).name==output_name,f"LOD{lod} unsafe output name")
    output=receipt["_receiptPath"].parent/output_name;require(output.is_file(),f"LOD{lod} GLB missing")
    require(asset.get("bytes")==output.stat().st_size and asset.get("sha256")==f"sha256:{sha256_file(output)}",f"LOD{lod} file receipt mismatch")
    document=glb_json(output)
    require(not document.get("cameras") and not document.get("animations") and not document.get("skins"),f"LOD{lod} contains non-static payload")
    require("KHR_lights_punctual" not in document.get("extensions",{}),f"LOD{lod} contains lights")
    for kind in ("buffers","images"):
        require(all("uri" not in entry for entry in document.get(kind,[])),f"LOD{lod} contains external {kind}")
    text=json.dumps(document,separators=(",",":"));require(all(marker not in text for marker in FORBIDDEN),f"LOD{lod} leaks a forbidden source marker")
    validate_materials(document,lod)
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
    return {"status":"PASS","asset":ASSET_ID,"scriptSha256":details[0]["scriptSha256"],"lods":[{key:value for key,value in row.items() if key not in ("scriptSha256",)} for row in details]}


if __name__ == "__main__":
    try:
        print(json.dumps(validate_set(parse_args(sys.argv[1:])),indent=2,sort_keys=True))
    except (OSError,ValueError,json.JSONDecodeError,struct.error) as error:
        print(f"Crackhouse output validation failed: {error}",file=sys.stderr)
        raise SystemExit(1) from error
