#!/usr/bin/env python3
"""Dependency-free admission gate for one three-LOD vegetation prototype set."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import sys


HERE = Path(__file__).resolve().parent
CATALOG_PATH = HERE / "prototype_catalog.json"
GLB_MAGIC = b"glTF"
GLB_JSON_CHUNK = 0x4E4F534A
TEXTURE_SIZE_BY_LOD = (128, 64, 32)
PINE01_TEXTURE_SIZE_BY_LOD = (1024, 512, 256)
PINE_ATLAS_SHA256 = "sha256:0a20e3492e4ebb7b4325483623d9062678fab3a044479060e2993a25768ff140"
PINE_ALPHA_CUTOFF = 0.376
DECIDUOUS_TEXTURE_SIZE_BY_LOD = (256, 128, 64)
DECIDUOUS_GUTTER_BY_LOD = (4, 2, 1)
DECIDUOUS_ATLAS_SHA256 = "sha256:aec3cabf0fa91ca4b3da56084b83aa409f994171ab92424340315acb89e39721"
DECIDUOUS_ALPHA_CUTOFF = 0.376
DECIDUOUS_OVERDRAW_PROXY_MAX = (8.0, 7.0, 6.0)
DECIDUOUS_LOD_DENSITY_RETENTION_MIN = 0.55
FULL_PACK_PER_ASSET_BUDGETS = (
    {"bytes": 1048576, "triangles": 12000, "textureResolution": 128},
    {"bytes": 196608, "triangles": 1500, "textureResolution": 64},
    {"bytes": 65536, "triangles": 500, "textureResolution": 32},
)
SHA256_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
SAFE_BASENAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
FORBIDDEN_GLTF_MARKERS = (
    ".local-game-derived",
    "EscapeFromTarkov",
    "Escape from Tarkov",
    "UnityFS",
    "CAB-",
    "StreamingAssets",
    "/mnt/c/",
    "C:\\",
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def catalog() -> tuple[dict, dict[str, dict]]:
    document = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    require(document.get("schemaVersion") == 1, "prototype catalog schema changed")
    prototypes = document.get("prototypes")
    require(isinstance(prototypes, list) and len(prototypes) == 31, "prototype catalog must contain 31 entries")
    by_name = {entry.get("name"): entry for entry in prototypes if isinstance(entry, dict)}
    require(len(by_name) == 31 and None not in by_name, "prototype catalog names are invalid or duplicated")
    require(sum(entry.get("instances", 0) for entry in prototypes) == 8805, "prototype census total changed")
    return document, by_name


def parse_args(argv: list[str], names: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate GLB/receipt LOD0, LOD1, and LOD2 for one prototype.")
    parser.add_argument("--prototype", choices=sorted(names), required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("receipts", nargs=3, type=Path, metavar="RECEIPT")
    args = parser.parse_args(argv)
    if args.output is not None:
        args.output = args.output.expanduser().resolve()
        require(args.output.suffix.lower() == ".json" and not args.output.exists(), "--output must be a new JSON path")
    return args


def read_receipt(path: Path) -> dict:
    resolved = path.expanduser().resolve()
    require(resolved.is_file() and not resolved.is_symlink(), f"receipt is not a regular file: {resolved}")
    require(resolved.stat().st_size <= 256 * 1024, f"receipt exceeds 256 KiB: {resolved}")
    document = json.loads(resolved.read_text(encoding="utf-8"))
    require(isinstance(document, dict), f"receipt is not an object: {resolved}")
    document["_receiptPath"] = resolved
    return document


def glb_json(path: Path) -> dict:
    blob = path.read_bytes()
    require(len(blob) >= 20, f"GLB is truncated: {path}")
    magic, version, declared_length = struct.unpack_from("<4sII", blob, 0)
    require(magic == GLB_MAGIC, f"GLB magic mismatch: {path}")
    require(version == 2, f"GLB version is not 2: {path}")
    require(declared_length == len(blob), f"GLB declared length mismatch: {path}")
    offset = 12
    document = None
    while offset + 8 <= len(blob):
        chunk_length, chunk_type = struct.unpack_from("<II", blob, offset)
        offset += 8
        end = offset + chunk_length
        require(end <= len(blob), f"GLB chunk exceeds file length: {path}")
        if chunk_type == GLB_JSON_CHUNK:
            require(document is None, f"GLB contains more than one JSON chunk: {path}")
            document = json.loads(blob[offset:end].decode("utf-8"))
        offset = end
    require(offset == len(blob), f"GLB has trailing bytes outside its chunk table: {path}")
    require(isinstance(document, dict), f"GLB has no JSON document: {path}")
    return document


def triangle_count(document: dict) -> int:
    accessors = document.get("accessors", [])
    require(isinstance(accessors, list), "GLB accessors must be an array")
    total = 0
    primitives = 0
    for mesh_index, mesh in enumerate(document.get("meshes", [])):
        require(isinstance(mesh, dict), f"GLB mesh {mesh_index} is invalid")
        for primitive_index, primitive in enumerate(mesh.get("primitives", [])):
            require(primitive.get("mode", 4) == 4, f"mesh {mesh_index} primitive {primitive_index} is not triangles")
            accessor_index = primitive.get("indices")
            require(isinstance(accessor_index, int) and 0 <= accessor_index < len(accessors), "primitive indices accessor is invalid")
            count = accessors[accessor_index].get("count")
            require(isinstance(count, int) and count > 0 and count % 3 == 0, "triangle index count is invalid")
            total += count // 3
            primitives += 1
    require(total > 0 and primitives > 0, "GLB has no triangle primitives")
    return total


def exact_cli(receipt: dict, prototype: str, lod: int, output_name: str, proof_kind: str | None) -> None:
    generator = receipt.get("generator", {})
    argv = generator.get("argvAfterSeparator")
    require(isinstance(argv, list) and all(isinstance(value, str) for value in argv), f"LOD{lod} exact argv is missing")

    def one_value(flag: str) -> str:
        indexes = [index for index, value in enumerate(argv) if value == flag]
        require(len(indexes) == 1 and indexes[0] + 1 < len(argv), f"LOD{lod} argv must contain one {flag}")
        return argv[indexes[0] + 1]

    require(one_value("--prototype") == prototype, f"LOD{lod} argv prototype mismatch")
    require(one_value("--lod") == str(lod), f"LOD{lod} argv LOD mismatch")
    require(Path(one_value("--output")).name == output_name, f"LOD{lod} argv output mismatch")
    receipt_name = receipt["_receiptPath"].name
    require(Path(one_value("--receipt")).name == receipt_name, f"LOD{lod} argv receipt mismatch")
    seed_tokens = [index for index, value in enumerate(argv) if value == "--seed"]
    declared_seed = receipt.get("generated", {}).get("seed")
    require(isinstance(declared_seed, int) and declared_seed >= 0, f"LOD{lod} seed receipt is invalid")
    if seed_tokens:
        require(len(seed_tokens) == 1 and seed_tokens[0] + 1 < len(argv), f"LOD{lod} argv seed is malformed")
        require(int(argv[seed_tokens[0] + 1]) == declared_seed, f"LOD{lod} argv seed mismatch")
    else:
        require(declared_seed == 106, f"LOD{lod} omitted --seed but does not declare default seed 106")
    proof_flags = {
        "pine": "--pine-alpha-proof",
        "deciduous": "--deciduous-alpha-proof",
    }
    for kind, flag in proof_flags.items():
        count = argv.count(flag)
        require(count == (1 if proof_kind == kind else 0), f"LOD{lod} argv {flag} proof contract changed")


def inspect_glb(document: dict, prototype: str, lod: int, proof_kind: str | None = None) -> dict[str, int]:
    require(not document.get("cameras"), f"LOD{lod} exports a camera")
    require(not document.get("animations"), f"LOD{lod} exports animation")
    require(not document.get("skins"), f"LOD{lod} exports a skin")
    require("KHR_lights_punctual" not in document.get("extensions", {}), f"LOD{lod} exports a light")
    for kind in ("buffers", "images"):
        entries = document.get(kind, [])
        require(isinstance(entries, list), f"LOD{lod} {kind} must be an array")
        for index, entry in enumerate(entries):
            require(isinstance(entry, dict) and "uri" not in entry, f"LOD{lod} {kind}[{index}] is external")
    text = json.dumps(document, ensure_ascii=False, separators=(",", ":"))
    for marker in FORBIDDEN_GLTF_MARKERS:
        require(marker not in text, f"LOD{lod} GLB leaks forbidden marker {marker!r}")

    root_name = f"TZ_Vegetation_{prototype.lower()}_LOD{lod}_ROOT"
    roots = [node for node in document.get("nodes", []) if node.get("name") == root_name]
    require(len(roots) == 1, f"LOD{lod} must contain exactly one {root_name}")
    root = roots[0]
    extras = root.get("extras", {})
    require(extras.get("tz_pivot") == "base-center", f"LOD{lod} root pivot changed")
    require(extras.get("tz_unit") == "metre", f"LOD{lod} root unit changed")
    require(extras.get("tz_prototype") == prototype, f"LOD{lod} root prototype changed")
    require(extras.get("tz_original_authored") is True, f"LOD{lod} root authorship flag changed")
    translation = root.get("translation", [0, 0, 0])
    require(translation == [0, 0, 0], f"LOD{lod} root is translated away from its base-center pivot")

    materials = document.get("materials", [])
    images = document.get("images", [])
    require(materials, f"LOD{lod} has no PBR materials")
    for index, material in enumerate(materials):
        pbr = material.get("pbrMetallicRoughness", {})
        require("baseColorTexture" in pbr, f"LOD{lod} material {index} lacks base color texture")
        require("metallicRoughnessTexture" in pbr, f"LOD{lod} material {index} lacks ORM texture")
        require("normalTexture" in material, f"LOD{lod} material {index} lacks normal texture")
        require("occlusionTexture" in material, f"LOD{lod} material {index} lacks occlusion texture")
    if proof_kind == "pine":
        atlas_materials = [material for material in materials if "pine_scots_atlas" in material.get("name", "")]
        require(len(atlas_materials) == 1, f"LOD{lod} must contain one Scots-pine atlas material")
        atlas_material = atlas_materials[0]
        require(atlas_material.get("alphaMode") == "MASK", f"LOD{lod} pine atlas material is not alpha MASK")
        require(abs(float(atlas_material.get("alphaCutoff", -1)) - PINE_ALPHA_CUTOFF) <= 1e-6, f"LOD{lod} pine alpha cutoff changed")
        require(atlas_material.get("doubleSided") is True, f"LOD{lod} pine atlas material is not double-sided")
    elif proof_kind == "deciduous":
        atlas_materials = [
            material for material in materials if "deciduous_broadleaf_atlas" in material.get("name", "")
        ]
        require(len(atlas_materials) == 1, f"LOD{lod} must contain one deciduous atlas material")
        atlas_material = atlas_materials[0]
        require(atlas_material.get("alphaMode") == "MASK", f"LOD{lod} deciduous atlas material is not alpha MASK")
        require(
            abs(float(atlas_material.get("alphaCutoff", -1)) - DECIDUOUS_ALPHA_CUTOFF) <= 1e-6,
            f"LOD{lod} deciduous alpha cutoff changed",
        )
        require(atlas_material.get("doubleSided") is True, f"LOD{lod} deciduous atlas material is not double-sided")
        atlas_extras = atlas_material.get("extras", {})
        require(
            atlas_extras.get("tz_source_atlas_sha256") == DECIDUOUS_ATLAS_SHA256,
            f"LOD{lod} deciduous material source hash changed",
        )
        require(
            atlas_extras.get("tz_cell_isolation") == "independent-resample",
            f"LOD{lod} deciduous material cell isolation changed",
        )
        require(
            atlas_extras.get("tz_cell_gutter_pixels") == DECIDUOUS_GUTTER_BY_LOD[lod],
            f"LOD{lod} deciduous material gutter changed",
        )
        require(
            abs(float(extras.get("tz_fit_xy_scale", -1)) - 1.0) <= 1e-7
            and abs(float(extras.get("tz_fit_z_scale", -1)) - 1.0) <= 1e-7,
            f"LOD{lod} deciduous geometry required a global envelope transform",
        )
    require(len(images) >= len(materials) * 3, f"LOD{lod} does not embed base/normal/ORM images per material")
    return {
        "triangles": triangle_count(document),
        "nodes": len(document.get("nodes", [])),
        "meshes": len(document.get("meshes", [])),
        "materials": len(materials),
        "images": len(images),
    }


def validate_set(args: argparse.Namespace, catalog_document: dict, by_name: dict[str, dict]) -> dict:
    spec = by_name[args.prototype]
    receipts = [read_receipt(path) for path in args.receipts]
    receipts.sort(key=lambda document: document.get("asset", {}).get("lod", -1))
    require([receipt.get("asset", {}).get("lod") for receipt in receipts] == [0, 1, 2], "receipts must cover LOD0/1/2 exactly")

    costs = []
    script_hashes = set()
    catalog_hashes = set()
    blender_hashes = set()
    seeds = set()
    proof_flags = set()
    overdraw_ratios: list[float | None] = []
    continuity_ledgers: list[dict[str, list[float]] | None] = []
    details = []
    for lod, receipt in enumerate(receipts):
        require(receipt.get("schemaVersion") == 1, f"LOD{lod} receipt schema changed")
        asset = receipt.get("asset", {})
        proof = receipt.get("proof", {})
        pine_alpha_proof = proof.get("pineAlphaCard") is True
        deciduous_alpha_proof = proof.get("deciduousAlphaCard") is True
        require(not (pine_alpha_proof and deciduous_alpha_proof), f"LOD{lod} mixes alpha proof kinds")
        proof_kind = "pine" if pine_alpha_proof else "deciduous" if deciduous_alpha_proof else None
        declared_sources = receipt.get("sourceTextures", [])
        require(isinstance(declared_sources, list), f"LOD{lod} sourceTextures must be an array")
        require(bool(declared_sources) is (proof_kind is not None), f"LOD{lod} proof/source-texture receipt mismatch")
        proof_flags.add(proof_kind)
        require(not pine_alpha_proof or args.prototype == "pine01", f"LOD{lod} alpha proof is not pine01")
        require(not deciduous_alpha_proof or args.prototype == "tree02", f"LOD{lod} deciduous alpha proof is not tree02")
        require(asset.get("id") == f"customs.vegetation.{args.prototype.lower()}", f"LOD{lod} asset ID mismatch")
        require(asset.get("prototypeName") == args.prototype, f"LOD{lod} prototype mismatch")
        require(asset.get("family") == spec["family"], f"LOD{lod} family mismatch")
        require(asset.get("form") == spec["form"], f"LOD{lod} form mismatch")
        require(asset.get("variant") == spec["variant"], f"LOD{lod} variant mismatch")
        require(asset.get("dry") is spec["dry"], f"LOD{lod} dry flag mismatch")
        require(
            asset.get("gltf") == {"unit": "metre", "upAxis": "+y", "forwardAxis": "+z", "pivot": "base-center"},
            f"LOD{lod} glTF frame/pivot contract changed",
        )
        output_name = asset.get("outputFile")
        require(isinstance(output_name, str) and SAFE_BASENAME.fullmatch(output_name), f"LOD{lod} output filename is unsafe")
        require(output_name.lower().endswith(".glb"), f"LOD{lod} output is not GLB")
        output = receipt["_receiptPath"].parent / output_name
        require(output.is_file() and not output.is_symlink(), f"LOD{lod} output is missing or a symlink: {output}")
        actual_bytes = output.stat().st_size
        actual_hash = sha256_file(output)
        require(asset.get("bytes") == actual_bytes, f"LOD{lod} byte receipt mismatch")
        require(asset.get("sha256") == f"sha256:{actual_hash}", f"LOD{lod} SHA-256 receipt mismatch")

        generator = receipt.get("generator", {})
        for key, target in (
            ("scriptSha256", script_hashes),
            ("catalogSha256", catalog_hashes),
            ("blenderBinarySha256", blender_hashes),
        ):
            value = generator.get(key)
            require(isinstance(value, str) and SHA256_PATTERN.fullmatch(value), f"LOD{lod} {key} is invalid")
            target.add(value)
        require(
            generator.get("scriptSha256") == f"sha256:{sha256_file(HERE / 'vegetation_factory.py')}",
            f"LOD{lod} factory script hash is stale",
        )
        require(generator.get("catalogSha256") == f"sha256:{sha256_file(CATALOG_PATH)}", f"LOD{lod} catalog hash is stale")
        exact_cli(receipt, args.prototype, lod, output_name, proof_kind)

        generated = receipt.get("generated", {})
        expected_texture_resolution = (
            PINE01_TEXTURE_SIZE_BY_LOD[lod] if pine_alpha_proof else TEXTURE_SIZE_BY_LOD[lod]
        )
        if deciduous_alpha_proof:
            expected_texture_resolution = DECIDUOUS_TEXTURE_SIZE_BY_LOD[lod]
        require(generated.get("textureResolution") == expected_texture_resolution, f"LOD{lod} texture resolution changed")
        if deciduous_alpha_proof:
            atlas_area = generated.get("atlasSurfaceAreaM2")
            canopy_footprint = generated.get("nominalCanopyFootprintM2")
            overdraw_ratio = generated.get("alphaCardSurfaceAreaPerCanopyFootprint")
            require(
                all(
                    not isinstance(value, bool) and isinstance(value, (int, float)) and float(value) > 0
                    for value in (atlas_area, canopy_footprint, overdraw_ratio)
                ),
                f"LOD{lod} deciduous overdraw proxy is missing",
            )
            require(
                abs(float(atlas_area) / float(canopy_footprint) - float(overdraw_ratio)) <= 1e-4,
                f"LOD{lod} deciduous overdraw proxy does not reconcile",
            )
            require(
                float(overdraw_ratio) <= DECIDUOUS_OVERDRAW_PROXY_MAX[lod],
                f"LOD{lod} deciduous overdraw proxy exceeds the offline gate",
            )
            require(
                isinstance(generated.get("leafCards"), int) and generated["leafCards"] > 0,
                f"LOD{lod} deciduous card count is missing",
            )
            require(
                generated.get("continuityContract") == "keyed-nested-landmarks-v1",
                f"LOD{lod} deciduous continuity contract changed",
            )
            fit_scale = generated.get("canonicalFitScale")
            require(
                isinstance(fit_scale, dict)
                and abs(float(fit_scale.get("xy", -1)) - 1.0) <= 1e-7
                and abs(float(fit_scale.get("z", -1)) - 1.0) <= 1e-7,
                f"LOD{lod} deciduous receipt required a global envelope transform",
            )
            continuity_landmarks = generated.get("continuityLandmarks")
            require(
                isinstance(continuity_landmarks, dict) and continuity_landmarks,
                f"LOD{lod} deciduous continuity landmarks are missing",
            )
            for key, value in continuity_landmarks.items():
                require(
                    isinstance(key, str) and key and SAFE_BASENAME.fullmatch(key.replace(":", "-")),
                    f"LOD{lod} deciduous continuity landmark key is invalid",
                )
                require(
                    isinstance(value, list)
                    and len(value) == 3
                    and all(
                        not isinstance(component, bool)
                        and isinstance(component, (int, float))
                        and float("-inf") < float(component) < float("inf")
                        for component in value
                    ),
                    f"LOD{lod} deciduous continuity landmark {key!r} is invalid",
                )
            continuity_payload = json.dumps(
                continuity_landmarks, sort_keys=True, separators=(",", ":")
            ).encode("utf-8")
            require(
                generated.get("continuityLandmarksSha256")
                == f"sha256:{hashlib.sha256(continuity_payload).hexdigest()}",
                f"LOD{lod} deciduous continuity landmark hash changed",
            )
            require(
                "apex:near" in continuity_landmarks and "apex:end" in continuity_landmarks,
                f"LOD{lod} deciduous apex continuity landmarks are missing",
            )
            continuity_ledgers.append(continuity_landmarks)
            overdraw_ratios.append(float(overdraw_ratio))
        else:
            continuity_ledgers.append(None)
            overdraw_ratios.append(None)
        seed = generated.get("seed")
        require(isinstance(seed, int) and seed >= 0, f"LOD{lod} seed is invalid")
        seeds.add(seed)
        gltf_stats = inspect_glb(glb_json(output), args.prototype, lod, proof_kind)
        require(generated.get("triangles") == gltf_stats["triangles"], f"LOD{lod} authored triangle receipt mismatch")
        require(generated.get("exportedTriangles") == gltf_stats["triangles"], f"LOD{lod} exported triangle receipt mismatch")
        require(generated.get("materialCount") == gltf_stats["materials"], f"LOD{lod} material receipt mismatch")
        require(generated.get("embeddedImageCount") == gltf_stats["images"], f"LOD{lod} image receipt mismatch")
        bounds = asset.get("boundsM", {})
        minimum = bounds.get("min")
        maximum = bounds.get("max")
        require(
            isinstance(minimum, list) and isinstance(maximum, list) and len(minimum) == len(maximum) == 3,
            f"LOD{lod} bounds are invalid",
        )
        require(abs(float(minimum[1])) <= 1e-4, f"LOD{lod} base-center Y must be zero")
        require(abs(float(maximum[1]) - float(spec["nominalHeightM"])) <= 1e-3, f"LOD{lod} nominal height drifted")
        require(float(minimum[0]) <= 0 <= float(maximum[0]), f"LOD{lod} X bounds do not contain pivot")
        require(float(minimum[2]) <= 0 <= float(maximum[2]), f"LOD{lod} Z bounds do not contain pivot")

        boundary = receipt.get("copyrightBoundary", {})
        require(boundary.get("gameFilesReadByGenerator") is False, f"LOD{lod} game-file boundary changed")
        require(boundary.get("gameMeshesIncluded") is False, f"LOD{lod} game mesh boundary changed")
        require(boundary.get("gameTexturesIncluded") is False, f"LOD{lod} game texture boundary changed")
        require(boundary.get("externalTexturesIncluded") is False, f"LOD{lod} external texture boundary changed")
        if pine_alpha_proof:
            source_textures = receipt.get("sourceTextures")
            require(isinstance(source_textures, list) and len(source_textures) == 1, f"LOD{lod} pine atlas receipt is missing")
            atlas = source_textures[0]
            require(atlas.get("sha256") == PINE_ATLAS_SHA256, f"LOD{lod} pine atlas hash changed")
            require(atlas.get("origin") == "OpenAI-generated original for TarkovZero", f"LOD{lod} pine atlas origin changed")
            require(atlas.get("sourceGameTexture") is False, f"LOD{lod} pine atlas game-texture boundary changed")
            treatment = atlas.get("derivedTreatment", {})
            require(treatment.get("alphaMode") == "MASK", f"LOD{lod} pine alpha treatment changed")
            require(abs(float(treatment.get("alphaCutoff", -1)) - PINE_ALPHA_CUTOFF) <= 1e-6, f"LOD{lod} pine cutoff receipt changed")
            require(treatment.get("doubleSided") is True, f"LOD{lod} pine double-sided receipt changed")
            require(treatment.get("rgbDilationPixels", 0) >= 4, f"LOD{lod} pine edge dilation is insufficient")
            require(treatment.get("originalSourceFileModified") is False, f"LOD{lod} source atlas mutation boundary changed")
        elif deciduous_alpha_proof:
            source_textures = receipt.get("sourceTextures")
            require(
                isinstance(source_textures, list) and len(source_textures) == 1,
                f"LOD{lod} deciduous atlas receipt is missing",
            )
            atlas = source_textures[0]
            require(atlas.get("sha256") == DECIDUOUS_ATLAS_SHA256, f"LOD{lod} deciduous atlas hash changed")
            require(
                atlas.get("origin") == "OpenAI-generated original for TarkovZero",
                f"LOD{lod} deciduous atlas origin changed",
            )
            require(atlas.get("sourceGameTexture") is False, f"LOD{lod} deciduous atlas game-texture boundary changed")
            treatment = atlas.get("derivedTreatment", {})
            require(treatment.get("independentCellResample") is True, f"LOD{lod} deciduous cell isolation changed")
            require(
                treatment.get("cellGutterPixels") == DECIDUOUS_GUTTER_BY_LOD[lod],
                f"LOD{lod} deciduous mip gutter changed",
            )
            require(treatment.get("belowCutoffRgbDiscarded") is True, f"LOD{lod} deciduous fringe rejection changed")
            require(treatment.get("alphaMode") == "MASK", f"LOD{lod} deciduous alpha treatment changed")
            require(
                abs(float(treatment.get("alphaCutoff", -1)) - DECIDUOUS_ALPHA_CUTOFF) <= 1e-6,
                f"LOD{lod} deciduous cutoff receipt changed",
            )
            require(treatment.get("doubleSided") is True, f"LOD{lod} deciduous double-sided receipt changed")
            require(treatment.get("rgbDilationPixels", 0) >= 4, f"LOD{lod} deciduous edge dilation is insufficient")
            require(treatment.get("originalSourceFileModified") is False, f"LOD{lod} source atlas mutation boundary changed")
        costs.append((gltf_stats["triangles"], actual_bytes, expected_texture_resolution))
        detail = {"lod": lod, "bytes": actual_bytes, **gltf_stats}
        if deciduous_alpha_proof:
            detail.update({
                "leafCards": generated["leafCards"],
                "atlasSurfaceAreaM2": generated["atlasSurfaceAreaM2"],
                "nominalCanopyFootprintM2": generated["nominalCanopyFootprintM2"],
                "alphaCardSurfaceAreaPerCanopyFootprint": generated["alphaCardSurfaceAreaPerCanopyFootprint"],
                "overdrawProxyMaximum": DECIDUOUS_OVERDRAW_PROXY_MAX[lod],
            })
        details.append(detail)

    require(len(script_hashes) == 1, "LOD set was generated by different factory sources")
    require(len(catalog_hashes) == 1, "LOD set used different prototype catalogs")
    require(len(blender_hashes) == 1, "LOD set used different Blender binaries")
    require(len(seeds) == 1, "LOD set used different seeds")
    require(len(proof_flags) == 1, "LOD set mixes proof and standard assets")
    proof_kind = next(iter(proof_flags))
    for lod in (1, 2):
        previous = costs[lod - 1]
        current = costs[lod]
        require(current[0] < previous[0], f"LOD{lod} triangle cost does not strictly decrease")
        require(current[1] < previous[1], f"LOD{lod} byte cost does not strictly decrease")
        require(current[2] < previous[2], f"LOD{lod} texture cost does not strictly decrease")
    if proof_kind == "deciduous":
        ratios = [float(value) for value in overdraw_ratios if value is not None]
        require(len(ratios) == 3, "deciduous overdraw proxy LOD set is incomplete")
        for lod in (1, 2):
            require(ratios[lod] < ratios[lod - 1], f"LOD{lod} deciduous surface-load proxy does not decrease")
            require(
                ratios[lod] >= ratios[lod - 1] * DECIDUOUS_LOD_DENSITY_RETENTION_MIN,
                f"LOD{lod} deciduous crown density collapses across the LOD transition",
            )
        ledgers = [ledger for ledger in continuity_ledgers if ledger is not None]
        require(len(ledgers) == 3, "deciduous continuity ledger set is incomplete")
        require(len(ledgers[0]) > len(ledgers[1]) > len(ledgers[2]) >= 20, "deciduous continuity ledger cost does not strictly decrease")
        for lod in (1, 2):
            previous = ledgers[lod - 1]
            current = ledgers[lod]
            require(
                set(current).issubset(previous),
                f"LOD{lod} deciduous continuity ledger is not a nested subset",
            )
            for key, value in current.items():
                require(
                    value == previous[key],
                    f"LOD{lod} deciduous shared transform landmark {key!r} drifted",
                )

    budget_results = []
    for detail, cost in zip(details, costs):
        lod = detail["lod"]
        budget = FULL_PACK_PER_ASSET_BUDGETS[lod]
        checks = {
            "bytes": detail["bytes"] <= budget["bytes"],
            "triangles": detail["triangles"] <= budget["triangles"],
            "textureResolution": cost[2] <= budget["textureResolution"],
        }
        budget_results.append({"lod": lod, "budget": budget, "checks": checks, "pass": all(checks.values())})
    production_budget_pass = all(result["pass"] for result in budget_results)
    return {
        "prototype": args.prototype,
        "family": spec["family"],
        "censusInstances": spec["instances"],
        "customsInstances": catalog_document["instanceCount"],
        "seed": next(iter(seeds)),
        "scriptSha256": next(iter(script_hashes)),
        "catalogSha256": next(iter(catalog_hashes)),
        "blenderBinarySha256": next(iter(blender_hashes)),
        "lods": details,
        "fullPackPerAssetBudgets": budget_results,
        "admission": {
            "structuralValidation": "pass",
            "transformContinuityValidation": "pass" if proof_kind == "deciduous" else "not-applicable",
            "productionBudgetValidation": "pass" if production_budget_pass else "fail",
            "overdrawProxyValidation": "pass" if proof_kind == "deciduous" else "not-applicable",
            "livePromotion": False,
            "collision": False,
            "geometryApproximation": True,
        },
    }


def main() -> None:
    catalog_document, by_name = catalog()
    args = parse_args(sys.argv[1:], list(by_name))
    result = validate_set(args, catalog_document, by_name)
    payload = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.output is not None:
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
    except (OSError, ValueError, json.JSONDecodeError, struct.error) as error:
        print(f"vegetation output validation failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
