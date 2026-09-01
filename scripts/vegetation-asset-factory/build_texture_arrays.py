#!/usr/bin/env python3
"""Collapse the authored vegetation pack's 199 materials into three texture arrays.

The pack ships 199 distinct materials that differ only in which small image they sample:
every one of them carries the identical slot combination (baseColor + metallicRoughness +
normal + occlusion, with metallicRoughness and occlusion sharing one ORM image), the identical
`doubleSided: true`, and no PBR factors at all. The only scalar that varies is `normalTexture.scale`,
and it varies by LOD, not by material.

That makes a texture array the exact right collapse: one `DataArrayTexture` per (LOD, slot),
one layer per material, and a per-vertex layer index chosen at runtime. Array layers wrap
independently on a `TEXTURE_2D_ARRAY` -- `wrapS`/`wrapT` apply inside a layer and the depth
coordinate is never wrapped -- so the 173/199 primitives whose UVs leave the unit square on
REPEAT samplers need no UV edit and no re-bake. That is the property an atlas cannot offer.

This script reads the pack and writes a NEW directory. It never writes into the pack, never
writes into `public/`, and never opens the game install.

Outputs (nine blobs plus an index and its receipt):

    veg-l{0,1,2}-basecolor.bin   RGBA8, sRGB-encoded colour with linear alpha
    veg-l{0,1,2}-orm.bin         RGBA8, linear, R=occlusion G=roughness B=metallic
    veg-l{0,1,2}-normal.bin      RGBA8, linear tangent normal with `normalScale` PRE-BAKED
    veg-layers.json              the layer index: every primitive -> exactly one layer
    veg-layers.receipt.json      sha256 receipt in the pack's own receipt style

Blob layout is LEVEL-MAJOR: level 0 for every layer, then level 1 for every layer, and so on.
That is the shape a GPU array upload wants -- one contiguous slab per mip level covering all
layers -- and it is what `texture.mipmaps[i].data` would have to be if three ever honours mips
on a `DataArrayTexture` (as of three 0.185.1 it does not; see the loader module for the read).

`normalScale` is pre-baked as `xy' = (xy - 0.5) * s + 0.5`, which is exact: three computes
`(2t - 1) * s` and `2((t - 0.5)s + 0.5) - 1 == (2t - 1)s`. Baking it removes the last per-material
scalar, so the runtime needs one material per LOD tier instead of 199.

Determinism: assets are walked in sorted `assetId` order, LOD ascending, material index ascending;
every filter runs in float64 and quantises once with round-half-to-even; the JSON is written with
sorted keys and no timestamp. Two runs over the same pack produce byte-identical output.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import struct
import sys

import numpy as np
from PIL import Image


HERE = Path(__file__).resolve().parent
REPOSITORY_ROOT = HERE.parent.parent
SAFE_ASSET_FILE = re.compile(r"^assets/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+-lod[0-2]\.glb$")
SHA256_PREFIXED = re.compile(r"^sha256:[0-9a-f]{64}$")

DOCUMENT_TYPE = "tarkovzero-customs-vegetation-texture-array-index"
RECEIPT_DOCUMENT_TYPE = "tarkovzero-customs-vegetation-texture-array-index-receipt"
SCHEMA_VERSION = 1
SLOTS = ("basecolor", "orm", "normal")
LODS = (0, 1, 2)
GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942
GL_REPEAT = 10497
EXPECTED_SLOT_COMBO = ("baseColorTexture", "metallicRoughnessTexture", "normalTexture", "occlusionTexture")
EXPECTED_ORM_CHANNELS = "R=occlusion,G=roughness,B=metallic"

# The pack is 31 families x 3 LODs; 85 LOD0 materials, 57 at LOD1 and 57 at LOD2.
EXPECTED_ASSETS = 31
EXPECTED_LOD_FILES = 93
EXPECTED_PRIMITIVES = 199

# A ceiling, not a promise: refuse to emit an array set larger than this so a regenerated pack
# that quietly grows its texture resolution fails here instead of on someone's GPU.
MAX_TOTAL_ARRAY_BYTES = 64 * 1024 * 1024


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_new(path: Path, payload: bytes) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())


def dump_json(document: dict) -> bytes:
    return (json.dumps(document, indent=2, sort_keys=True, ensure_ascii=True) + "\n").encode("utf-8")


def safe_pack_file(pack_root: Path, raw: str) -> Path:
    require(isinstance(raw, str) and SAFE_ASSET_FILE.match(raw) is not None, f"unsafe pack asset path {raw!r}")
    resolved = (pack_root / raw).resolve()
    require(resolved.is_relative_to(pack_root), f"pack asset path escapes the pack root: {raw}")
    require(resolved.is_file() and not resolved.is_symlink(), f"pack asset is not a regular file: {raw}")
    return resolved


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build DataArrayTexture blobs and a layer index from the authored vegetation pack.",
    )
    parser.add_argument("--pack-root", type=Path, required=True, help="the authored pack directory (read-only)")
    parser.add_argument("--output", type=Path, required=True, help="a NEW directory to write the array set into")
    parser.add_argument(
        "--mips",
        choices=("box", "none"),
        default="box",
        help="emit full offline mip chains (box, default) or level 0 only (none)",
    )
    args = parser.parse_args(argv)
    args.pack_root = args.pack_root.expanduser().resolve()
    args.output = args.output.expanduser().resolve()

    require(args.pack_root.is_dir() and not args.pack_root.is_symlink(), "--pack-root must be a regular directory")
    require((args.pack_root / "pack-index.json").is_file(), "--pack-root has no pack-index.json")
    require(not args.output.exists(), "--output is no-clobber; it must not already exist")
    require(args.output.parent.is_dir(), "--output parent directory does not exist")

    # Safety guards. These are the founder's localhost-only decision and the pack's read-only
    # status expressed as code; a blocking guard here is a finding, never an obstacle to route around.
    require(not args.output.is_relative_to(args.pack_root), "--output must not be written inside the pack")
    require(not args.pack_root.is_relative_to(args.output), "--pack-root must not sit inside --output")
    public_root = (REPOSITORY_ROOT / "public").resolve()
    require(
        not args.output.is_relative_to(public_root),
        "--output must not be inside public/: public/ is copied into dist/ and this pack is localhost-only",
    )
    return args


def parse_glb(path: Path) -> tuple[dict, bytes]:
    """Return (glTF JSON, BIN chunk bytes) for a binary glTF file."""
    payload = path.read_bytes()
    require(len(payload) >= 12, f"{path.name} is too short to be a GLB")
    magic, version, total = struct.unpack_from("<III", payload, 0)
    require(magic == GLB_MAGIC, f"{path.name} is not a GLB")
    require(version == 2, f"{path.name} is not glTF 2.0 binary")
    require(total == len(payload), f"{path.name} declares {total} bytes but is {len(payload)}")
    offset = 12
    chunks: dict[int, bytes] = {}
    while offset + 8 <= total:
        length, kind = struct.unpack_from("<II", payload, offset)
        offset += 8
        require(offset + length <= total, f"{path.name} has a chunk running past the file")
        if kind not in chunks:
            chunks[kind] = payload[offset : offset + length]
        offset += length
    require(CHUNK_JSON in chunks, f"{path.name} has no JSON chunk")
    require(CHUNK_BIN in chunks, f"{path.name} has no BIN chunk")
    return json.loads(chunks[CHUNK_JSON].decode("utf-8")), chunks[CHUNK_BIN]


def image_bytes(gltf: dict, binary: bytes, image_index: int, label: str) -> bytes:
    images = gltf.get("images")
    require(isinstance(images, list) and 0 <= image_index < len(images), f"{label} image index is out of range")
    image = images[image_index]
    require(image.get("mimeType") == "image/png", f"{label} image is not PNG")
    require("uri" not in image, f"{label} image carries an external URI")
    view_index = image.get("bufferView")
    views = gltf.get("bufferViews")
    require(isinstance(view_index, int) and isinstance(views, list) and 0 <= view_index < len(views), f"{label} bufferView is invalid")
    view = views[view_index]
    require(view.get("buffer", 0) == 0, f"{label} image does not live in the GLB buffer")
    start = int(view.get("byteOffset", 0))
    length = int(view["byteLength"])
    require(start >= 0 and start + length <= len(binary), f"{label} image runs past the BIN chunk")
    return binary[start : start + length]


def decode_rgba(payload: bytes, resolution: int, label: str) -> np.ndarray:
    with Image.open(io.BytesIO(payload)) as image:
        require(image.format == "PNG", f"{label} is not a PNG")
        require(image.mode == "RGBA", f"{label} is {image.mode}, expected RGBA")
        require(image.size == (resolution, resolution), f"{label} is {image.size}, expected {resolution}x{resolution}")
        return np.asarray(image, dtype=np.uint8).copy()


def texture_image_index(gltf: dict, texture_index: int, label: str) -> int:
    textures = gltf.get("textures")
    require(isinstance(textures, list) and 0 <= texture_index < len(textures), f"{label} texture index is out of range")
    texture = textures[texture_index]
    sampler_index = texture.get("sampler")
    samplers = gltf.get("samplers", [])
    require(isinstance(sampler_index, int) and 0 <= sampler_index < len(samplers), f"{label} has no sampler")
    sampler = samplers[sampler_index]
    for axis in ("wrapS", "wrapT"):
        wrap = sampler.get(axis, GL_REPEAT)
        require(wrap == GL_REPEAT, f"{label} sampler {axis} is {wrap}, not REPEAT; array layers only reproduce REPEAT")
    image_index = texture.get("source")
    require(isinstance(image_index, int), f"{label} texture has no image source")
    return image_index


def srgb_to_linear(channel: np.ndarray) -> np.ndarray:
    value = channel / 255.0
    return np.where(value <= 0.04045, value / 12.92, ((value + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(value: np.ndarray) -> np.ndarray:
    clamped = np.clip(value, 0.0, 1.0)
    return np.where(clamped <= 0.0031308, clamped * 12.92, 1.055 * clamped ** (1.0 / 2.4) - 0.055)


def quantize(value: np.ndarray) -> np.ndarray:
    """Round-half-to-even to uint8. Deterministic, and the same rule on every platform."""
    return np.clip(np.rint(np.clip(value, 0.0, 1.0) * 255.0), 0.0, 255.0).astype(np.uint8)


def box_reduce(plane: np.ndarray) -> np.ndarray:
    """One 2x2 box average of a float64 HxWxC plane."""
    height, width, channels = plane.shape
    require(height % 2 == 0 and width % 2 == 0, "mip reduction needs even dimensions")
    folded = plane.reshape(height // 2, 2, width // 2, 2, channels)
    return folded.mean(axis=(1, 3))


def build_mip_chain(level0: np.ndarray, slot: str, levels: int) -> list[np.ndarray]:
    """Return `levels` uint8 RGBA levels, filtered in the slot's own colour space.

    baseColor RGB is sRGB-encoded, so it is decoded to linear before averaging and re-encoded
    after -- a box filter applied to sRGB bytes darkens foliage measurably. Alpha is linear
    coverage and is averaged as-is. ORM and normal are linear data and are averaged as-is.
    """
    if slot == "basecolor":
        working = np.empty(level0.shape, dtype=np.float64)
        working[..., :3] = srgb_to_linear(level0[..., :3].astype(np.float64))
        working[..., 3] = level0[..., 3].astype(np.float64) / 255.0
    else:
        working = level0.astype(np.float64) / 255.0

    chain = [level0]
    current = working
    for _ in range(1, levels):
        current = box_reduce(current)
        if slot == "basecolor":
            encoded = np.empty(current.shape, dtype=np.float64)
            encoded[..., :3] = linear_to_srgb(current[..., :3])
            encoded[..., 3] = current[..., 3]
            chain.append(quantize(encoded))
        else:
            chain.append(quantize(current))
    return chain


def bake_normal_scale(normal: np.ndarray, scale: float) -> np.ndarray:
    """Fold `normalTexture.scale` into the normal map's XY.

    three computes `n.xy = (2t - 1) * s`. With `t' = (t - 0.5)s + 0.5` we get
    `2t' - 1 = (2t - 1)s` exactly, so the runtime material can keep `normalScale = 1`
    and no per-layer scalar has to survive the collapse.
    """
    baked = normal.astype(np.float64) / 255.0
    baked[..., :2] = (baked[..., :2] - 0.5) * scale + 0.5
    return quantize(baked)


def mip_levels_for(resolution: int, mode: str) -> int:
    if mode == "none":
        return 1
    levels = 1
    size = resolution
    while size > 1:
        require(size % 2 == 0, f"resolution {resolution} is not a power of two")
        size //= 2
        levels += 1
    return levels


def collect_layers(pack_root: Path, index: dict, mip_mode: str) -> tuple[dict, list[dict], list[dict], dict]:
    """Walk the pack deterministically and gather every material's three source images."""
    assets = index.get("authoredAssets")
    require(isinstance(assets, list) and len(assets) == EXPECTED_ASSETS, f"pack must hold {EXPECTED_ASSETS} authored assets")
    ordered = sorted(assets, key=lambda entry: entry["assetId"])
    require(len({entry["assetId"] for entry in ordered}) == EXPECTED_ASSETS, "duplicate assetId in the pack index")

    per_lod: dict[int, dict] = {
        lod: {"layers": [], "pixels": {slot: [] for slot in SLOTS}, "resolution": None, "normalScale": None}
        for lod in LODS
    }
    layer_records: list[dict] = []
    primitive_records: list[dict] = []
    alpha_cutoffs: dict[int, set[float]] = {lod: set() for lod in LODS}
    alpha_modes: dict[str, int] = {}
    lod_file_count = 0

    for asset in ordered:
        asset_id = asset["assetId"]
        prototype = asset["prototypeName"]
        family = asset["family"]
        lods = {entry["lod"]: entry for entry in asset["lods"]}
        require(set(lods) == set(LODS), f"{asset_id} does not carry exactly LOD 0/1/2")
        for lod in LODS:
            entry = lods[lod]
            path = safe_pack_file(pack_root, entry["file"])
            declared = entry.get("sha256")
            require(isinstance(declared, str) and SHA256_PREFIXED.match(declared) is not None, f"{entry['file']} has no declared sha256")
            actual = sha256_file(path)
            require(
                f"sha256:{actual}" == declared,
                f"{entry['file']} does not match its declared sha256; the pack changed under this build",
            )
            lod_file_count += 1

            gltf, binary = parse_glb(path)
            resolution = int(entry["textureResolution"])
            bucket = per_lod[lod]
            if bucket["resolution"] is None:
                bucket["resolution"] = resolution
            require(bucket["resolution"] == resolution, f"LOD{lod} mixes texture resolutions")

            materials = gltf.get("materials")
            require(isinstance(materials, list) and materials, f"{entry['file']} has no materials")
            names = [material.get("name") for material in materials]
            require(len(set(names)) == len(names) and all(names), f"{entry['file']} has non-unique material names")

            # A primitive resolves to a layer through its material, so the material must be the
            # unit of collapse and every primitive must name one.
            primitive_material: list[tuple[int, int, int]] = []
            for mesh_index, mesh in enumerate(gltf.get("meshes", [])):
                for primitive_index, primitive in enumerate(mesh.get("primitives", [])):
                    material_index = primitive.get("material")
                    require(isinstance(material_index, int), f"{entry['file']} has a primitive with no material")
                    require(0 <= material_index < len(materials), f"{entry['file']} primitive material index out of range")
                    primitive_material.append((mesh_index, primitive_index, material_index))
            require(primitive_material, f"{entry['file']} has no primitives")

            base_layer = len(bucket["layers"])
            for material_index, material in enumerate(materials):
                label = f"{entry['file']} material {material_index} ({names[material_index]})"
                require(material.get("doubleSided") is True, f"{label} is not doubleSided")
                pbr = material.get("pbrMetallicRoughness", {})
                combo = tuple(sorted(
                    [key for key in ("baseColorTexture", "metallicRoughnessTexture") if key in pbr]
                    + [key for key in ("normalTexture", "occlusionTexture", "emissiveTexture") if key in material]
                ))
                require(combo == EXPECTED_SLOT_COMBO, f"{label} slot combination is {combo}, not the pack's uniform combo")
                for factor in ("baseColorFactor", "metallicFactor", "roughnessFactor", "emissiveFactor"):
                    require(factor not in pbr and factor not in material, f"{label} carries a PBR factor; the collapse assumes none")
                extras = material.get("extras", {})
                require(extras.get("tz_orm_channels") == EXPECTED_ORM_CHANNELS, f"{label} does not declare the pack's ORM channel order")

                mode = material.get("alphaMode", "OPAQUE")
                require(mode in ("OPAQUE", "MASK"), f"{label} is {mode}; the Stage A pack contract admits OPAQUE and MASK only")
                alpha_modes[mode] = alpha_modes.get(mode, 0) + 1
                cutoff = None
                if mode == "MASK":
                    cutoff = round(float(material["alphaCutoff"]), 6)
                    alpha_cutoffs[lod].add(cutoff)

                # Round once, then bake with the value that is recorded. The GLB stores this as a
                # float32 (0.48 arrives as 0.4799999892711639), and baking with the raw double
                # while recording the rounded one puts a 1-LSB drift between the receipt and the
                # bytes it claims to describe.
                normal_slot = material["normalTexture"]
                scale = round(float(normal_slot.get("scale", 1.0)), 6)
                if bucket["normalScale"] is None:
                    bucket["normalScale"] = scale
                require(
                    scale == bucket["normalScale"],
                    f"{label} normalScale {scale} differs from LOD{lod}'s {bucket['normalScale']}; it cannot be baked once per LOD",
                )

                orm_texture = pbr["metallicRoughnessTexture"]["index"]
                require(
                    material["occlusionTexture"]["index"] == orm_texture,
                    f"{label} does not share one image between occlusion and metallicRoughness",
                )
                base_image = texture_image_index(gltf, pbr["baseColorTexture"]["index"], f"{label} baseColor")
                orm_image = texture_image_index(gltf, orm_texture, f"{label} ORM")
                normal_image = texture_image_index(gltf, normal_slot["index"], f"{label} normal")

                raw = {
                    "basecolor": image_bytes(gltf, binary, base_image, f"{label} baseColor"),
                    "orm": image_bytes(gltf, binary, orm_image, f"{label} ORM"),
                    "normal": image_bytes(gltf, binary, normal_image, f"{label} normal"),
                }
                pixels = {slot: decode_rgba(raw[slot], resolution, f"{label} {slot}") for slot in SLOTS}
                pixels["normal"] = bake_normal_scale(pixels["normal"], scale)

                layer = base_layer + material_index
                for slot in SLOTS:
                    bucket["pixels"][slot].append(pixels[slot])
                bucket["layers"].append(layer)

                layer_records.append({
                    "alphaCutoff": cutoff,
                    "alphaMode": mode,
                    "assetId": asset_id,
                    "family": family,
                    "layer": layer,
                    "lod": lod,
                    "materialFamily": extras.get("tz_material_family"),
                    "materialIndex": material_index,
                    "materialName": names[material_index],
                    "prototypeName": prototype,
                    "sourceImageSha256": {slot: f"sha256:{sha256_bytes(raw[slot])}" for slot in SLOTS},
                    "textureResolution": resolution,
                })

            for mesh_index, primitive_index, material_index in primitive_material:
                primitive_records.append({
                    "assetId": asset_id,
                    "layer": base_layer + material_index,
                    "lod": lod,
                    "materialIndex": material_index,
                    "materialName": names[material_index],
                    "meshIndex": mesh_index,
                    "primitiveIndex": primitive_index,
                })

    require(lod_file_count == EXPECTED_LOD_FILES, f"expected {EXPECTED_LOD_FILES} LOD files, walked {lod_file_count}")
    require(len(primitive_records) == EXPECTED_PRIMITIVES, f"expected {EXPECTED_PRIMITIVES} primitives, walked {len(primitive_records)}")
    for lod in LODS:
        require(per_lod[lod]["resolution"] is not None, f"LOD{lod} produced no layers")
        require(len(alpha_cutoffs[lod]) <= 1, f"LOD{lod} carries more than one alphaCutoff; one material per tier cannot serve it")

    summary = {
        "alphaModeCounts": dict(sorted(alpha_modes.items())),
        "alphaCutoffByLod": {str(lod): (sorted(alpha_cutoffs[lod])[0] if alpha_cutoffs[lod] else None) for lod in LODS},
        "mipMode": mip_mode,
    }
    return per_lod, layer_records, primitive_records, summary


def build_blobs(per_lod: dict, mip_mode: str) -> tuple[list[dict], dict[str, bytes]]:
    arrays: list[dict] = []
    blobs: dict[str, bytes] = {}
    for lod in LODS:
        bucket = per_lod[lod]
        resolution = bucket["resolution"]
        layer_count = len(bucket["layers"])
        levels = mip_levels_for(resolution, mip_mode)

        level_table: list[dict] = []
        slot_blobs: dict[str, dict] = {}
        for slot in SLOTS:
            chains = [build_mip_chain(level0, slot, levels) for level0 in bucket["pixels"][slot]]
            parts: list[bytes] = []
            table: list[dict] = []
            offset = 0
            for level in range(levels):
                size = resolution >> level
                slab = b"".join(chain[level].tobytes() for chain in chains)
                expected = layer_count * size * size * 4
                require(len(slab) == expected, f"LOD{lod} {slot} level {level} is {len(slab)} bytes, expected {expected}")
                parts.append(slab)
                table.append({"byteLength": expected, "byteOffset": offset, "height": size, "level": level, "width": size})
                offset += expected
            payload = b"".join(parts)
            name = f"veg-l{lod}-{slot}.bin"
            blobs[name] = payload
            slot_blobs[slot] = {"bytes": len(payload), "file": name, "sha256": f"sha256:{sha256_bytes(payload)}"}
            if not level_table:
                level_table = table
            else:
                require(level_table == table, f"LOD{lod} slots disagree on the level table")

        arrays.append({
            "blobs": slot_blobs,
            "depth": layer_count,
            "height": resolution,
            "layerBytes": resolution * resolution * 4,
            "levels": level_table,
            "lod": lod,
            "mipLevels": levels,
            "normalScaleBaked": bucket["normalScale"],
            "width": resolution,
        })
    return arrays, blobs


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    pack_index_path = args.pack_root / "pack-index.json"
    pack_index_bytes = pack_index_path.read_bytes()
    index = json.loads(pack_index_bytes.decode("utf-8"))
    require(index.get("schemaVersion") == 1, "pack index schema changed")
    require(index.get("map") == "customs", "pack index is not the Customs pack")

    per_lod, layer_records, primitive_records, summary = collect_layers(args.pack_root, index, args.mips)
    arrays, blobs = build_blobs(per_lod, args.mips)

    total_bytes = sum(len(payload) for payload in blobs.values())
    level0_bytes = sum(array["levels"][0]["byteLength"] * len(SLOTS) for array in arrays)
    require(
        total_bytes <= MAX_TOTAL_ARRAY_BYTES,
        f"array set is {total_bytes} bytes, over the {MAX_TOTAL_ARRAY_BYTES}-byte ceiling",
    )

    # Every primitive resolves to exactly one layer, and no layer is orphaned.
    layer_keys = {(record["lod"], record["layer"]) for record in layer_records}
    require(len(layer_keys) == len(layer_records), "two layer records claim the same (lod, layer) slot")
    used = {(record["lod"], record["layer"]) for record in primitive_records}
    require(used == layer_keys, "layer coverage is not exact: an orphaned layer or an unresolved primitive")
    for array in arrays:
        expected = {(array["lod"], layer) for layer in range(array["depth"])}
        require({key for key in layer_keys if key[0] == array["lod"]} == expected, f"LOD{array['lod']} layer indices are not 0..depth-1")

    document = {
        "arrays": arrays,
        "builder": "scripts/vegetation-asset-factory/build_texture_arrays.py",
        "builderSha256": f"sha256:{sha256_file(Path(__file__).resolve())}",
        "copyrightBoundary": {
            "collisionIncluded": False,
            "derivedFrom": "the repository's own authored vegetation pack, not the game install",
            "gameMeshesIncluded": False,
            "gameTexturesIncluded": False,
        },
        "counts": {
            "authoredAssets": EXPECTED_ASSETS,
            "layers": len(layer_records),
            "lodFiles": EXPECTED_LOD_FILES,
            "primitives": len(primitive_records),
        },
        "documentType": DOCUMENT_TYPE,
        "layerAttribute": {
            "itemSize": 1,
            "name": "vegLayer",
            "resolvedBy": ["assetId", "lod", "materialName"],
            "type": "float32",
        },
        "layers": layer_records,
        "layout": "level-major: level 0 for every layer, then level 1 for every layer",
        "map": "customs",
        "packIndexSha256": f"sha256:{sha256_bytes(pack_index_bytes)}",
        "packRoot": args.pack_root.name,
        "primitives": primitive_records,
        "schemaVersion": SCHEMA_VERSION,
        "slotColorSpace": {"basecolor": "srgb", "normal": "linear", "orm": "linear"},
        "slots": list(SLOTS),
        "status": "offline-localhost-only-not-live",
        "totalBytes": total_bytes,
        "uploadBytesLevel0": level0_bytes,
        **summary,
    }
    index_payload = dump_json(document)

    receipt = {
        "blobs": sorted(
            ({"bytes": len(payload), "file": name, "sha256": f"sha256:{sha256_bytes(payload)}"} for name, payload in blobs.items()),
            key=lambda entry: entry["file"],
        ),
        "builderSha256": document["builderSha256"],
        "counts": document["counts"],
        "documentType": RECEIPT_DOCUMENT_TYPE,
        "indexFile": "veg-layers.json",
        "packIndexSha256": document["packIndexSha256"],
        "schemaVersion": SCHEMA_VERSION,
        "sha256": f"sha256:{sha256_bytes(index_payload)}",
        "totalBytes": total_bytes,
        "uploadBytesLevel0": level0_bytes,
    }

    args.output.mkdir(mode=0o755)
    for name in sorted(blobs):
        write_new(args.output / name, blobs[name])
    write_new(args.output / "veg-layers.json", index_payload)
    write_new(args.output / "veg-layers.receipt.json", dump_json(receipt))

    report = {
        "arrays": [
            {
                "lod": array["lod"],
                "layers": array["depth"],
                "resolution": array["width"],
                "mipLevels": array["mipLevels"],
                "bytes": sum(array["blobs"][slot]["bytes"] for slot in SLOTS),
            }
            for array in arrays
        ],
        "layers": len(layer_records),
        "output": str(args.output),
        "primitives": len(primitive_records),
        "totalBytes": total_bytes,
        "uploadBytesLevel0": level0_bytes,
    }
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except ValueError as error:
        print(f"build_texture_arrays: {error}", file=sys.stderr)
        sys.exit(2)
