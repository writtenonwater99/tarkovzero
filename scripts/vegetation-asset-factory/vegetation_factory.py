#!/usr/bin/env python3
"""Deterministic original vegetation authoring for TarkovZero Customs.

Run with Blender 4.5 LTS in background/factory mode.  The only project input is
the sibling privacy-safe prototype catalog: prototype names, family mappings,
aggregate counts, and the nominal envelopes already used by TarkovZero's
procedural fallback.  This generator never reads an EFT installation and never
copies meshes, topology, UVs, materials, shaders, or pixels from the game.

Each invocation emits exactly one prototype at one LOD plus a hash-pinned JSON
receipt.  Final paths are published with hard-link/O_EXCL semantics; an existing
output or receipt is an error and is never overwritten.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import random
import re
import struct
import sys
import tempfile
from typing import Iterable, Sequence

import bmesh
import bpy
from mathutils import Vector


GENERATOR_NAME = "tarkovzero-customs-vegetation-factory"
GENERATOR_VERSION = "1.1.0"
CATALOG_PATH = Path(__file__).with_name("prototype_catalog.json")
PINE_ATLAS_PATH = Path(__file__).with_name("source-textures") / "pine-scots-branch-sprays-openai-v1.png"
PINE_ATLAS_PROVENANCE_PATH = PINE_ATLAS_PATH.with_suffix(".provenance.json")
PINE_ATLAS_SHA256 = "0a20e3492e4ebb7b4325483623d9062678fab3a044479060e2993a25768ff140"
PINE_ATLAS_SOURCE_SIZE = (1254, 1254)
PINE_ATLAS_TEXTURE_BY_LOD = {0: 1024, 1: 512, 2: 256}
PINE_ALPHA_CUTOFF = 0.376
# Per-cell anchor/tip coordinates in source-image convention (origin top-left).
# They align each photographed twig base to the authored branch endpoint.
PINE_ATLAS_CELLS = (
    ((0.50, 0.96), (0.50, 0.06)),
    ((0.03, 0.91), (0.86, 0.12)),
    ((0.50, 0.97), (0.46, 0.05)),
    ((0.03, 0.91), (0.84, 0.11)),
    ((0.52, 0.97), (0.30, 0.06)),
    ((0.50, 0.98), (0.55, 0.06)),
    ((0.56, 0.98), (0.36, 0.06)),
    ((0.03, 0.91), (0.84, 0.12)),
    ((0.03, 0.92), (0.84, 0.09)),
    ((0.50, 0.98), (0.37, 0.08)),
    ((0.52, 0.98), (0.45, 0.07)),
    ((0.03, 0.92), (0.82, 0.09)),
)
DECIDUOUS_ATLAS_PATH = Path(__file__).with_name("source-textures") / "deciduous-broadleaf-branch-sprays-openai-v1.png"
DECIDUOUS_ATLAS_PROVENANCE_PATH = DECIDUOUS_ATLAS_PATH.with_suffix(".provenance.json")
DECIDUOUS_ATLAS_SHA256 = "aec3cabf0fa91ca4b3da56084b83aa409f994171ab92424340315acb89e39721"
DECIDUOUS_ATLAS_SOURCE_SIZE = (1254, 1254)
DECIDUOUS_ATLAS_TEXTURE_BY_LOD = {0: 256, 1: 128, 2: 64}
DECIDUOUS_ATLAS_GUTTER_BY_LOD = {0: 4, 1: 2, 2: 1}
DECIDUOUS_ALPHA_CUTOFF = 0.376
DECIDUOUS_PROOF_CELL_CHOICES = (0, 2, 4, 6, 7, 9, 11)
# Per-cell thick-twig anchor and representative crown-tip coordinates in the
# immutable source's top-left image convention. The varied orientations are
# intentional: the authored branch axis, not the atlas grid, drives each card.
DECIDUOUS_ATLAS_CELLS = (
    ((0.18, 0.04), (0.78, 0.87)),
    ((0.96, 0.94), (0.18, 0.08)),
    ((0.12, 0.03), (0.86, 0.88)),
    ((0.39, 0.97), (0.65, 0.08)),
    ((0.30, 0.97), (0.46, 0.07)),
    ((0.13, 0.03), (0.83, 0.86)),
    ((0.79, 0.97), (0.37, 0.07)),
    ((0.27, 0.03), (0.91, 0.91)),
    ((0.10, 0.96), (0.72, 0.08)),
    ((0.20, 0.03), (0.80, 0.94)),
    ((0.69, 0.97), (0.52, 0.07)),
    ((0.20, 0.97), (0.60, 0.07)),
)
TEXTURE_SIZE_BY_LOD = {0: 128, 1: 64, 2: 32}
FAMILIES = (
    "birch",
    "deciduous-broadleaf",
    "pine",
    "filbert-shrub",
    "stump",
    "ground-plant",
)
SAFE_PROTOTYPE = re.compile(r"^[A-Za-z0-9_]+$")
GLB_MAGIC = b"glTF"
GLB_JSON_CHUNK = 0x4E4F534A


MATERIAL_SPECS = {
    "bark-birch": {"base": (0.70, 0.68, 0.58), "roughness": 0.88, "metallic": 0.0},
    "bark-broadleaf": {"base": (0.20, 0.135, 0.075), "roughness": 0.92, "metallic": 0.0},
    "bark-pine": {"base": (0.25, 0.12, 0.055), "roughness": 0.91, "metallic": 0.0},
    "twig": {"base": (0.22, 0.16, 0.085), "roughness": 0.89, "metallic": 0.0},
    "leaf-birch": {"base": (0.34, 0.48, 0.12), "roughness": 0.78, "metallic": 0.0},
    "leaf-broadleaf": {"base": (0.22, 0.39, 0.085), "roughness": 0.79, "metallic": 0.0},
    "needle-pine": {"base": (0.105, 0.255, 0.075), "roughness": 0.82, "metallic": 0.0},
    "leaf-shrub": {"base": (0.24, 0.43, 0.10), "roughness": 0.80, "metallic": 0.0},
    "leaf-dry": {"base": (0.41, 0.30, 0.105), "roughness": 0.91, "metallic": 0.0},
    "cut-wood": {"base": (0.49, 0.31, 0.13), "roughness": 0.84, "metallic": 0.0},
    "moss": {"base": (0.16, 0.245, 0.06), "roughness": 0.94, "metallic": 0.0},
    "ground-green": {"base": (0.25, 0.43, 0.09), "roughness": 0.82, "metallic": 0.0},
    "ground-dry": {"base": (0.46, 0.34, 0.105), "roughness": 0.92, "metallic": 0.0},
}
for _card_source in ("leaf-birch", "leaf-broadleaf", "needle-pine", "leaf-shrub", "leaf-dry"):
    MATERIAL_SPECS[f"{_card_source}-card"] = dict(MATERIAL_SPECS[_card_source])


def script_args() -> list[str]:
    """Return only arguments after Blender's `--` separator."""
    try:
        index = sys.argv.index("--")
    except ValueError:
        return []
    return sys.argv[index + 1 :]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stable_seed(seed: int, prototype: str) -> int:
    payload = f"{GENERATOR_NAME}:{seed}:{prototype}".encode("utf-8")
    return int.from_bytes(hashlib.sha256(payload).digest()[:8], "big")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def load_catalog() -> tuple[dict, dict[str, dict]]:
    raw = CATALOG_PATH.read_bytes()
    require(len(raw) <= 128 * 1024, "prototype catalog unexpectedly exceeds 128 KiB")
    document = json.loads(raw.decode("utf-8"))
    require(isinstance(document, dict), "prototype catalog must be an object")
    require(
        set(document) == {
            "schemaVersion", "map", "source", "sourceFrame", "instanceCount", "families", "prototypes",
        },
        "prototype catalog top-level schema changed",
    )
    require(document["schemaVersion"] == 1, "prototype catalog schemaVersion must be 1")
    require(document["map"] == "customs", "prototype catalog map must be customs")
    require(document["sourceFrame"] == "eft-unity-world-metres-y-up", "catalog frame changed")
    require(isinstance(document["families"], dict), "catalog families must be an object")
    require(set(document["families"]) == set(FAMILIES), "catalog family set changed")
    require(isinstance(document["prototypes"], list), "catalog prototypes must be an array")

    by_name: dict[str, dict] = {}
    family_counts = {family: 0 for family in FAMILIES}
    for index, value in enumerate(document["prototypes"]):
        require(isinstance(value, dict), f"catalog prototype {index} must be an object")
        require(
            set(value) == {
                "name", "family", "form", "variant", "dry", "instances", "nominalHeightM", "nominalWidthM",
            },
            f"catalog prototype {index} schema changed",
        )
        name = value["name"]
        require(isinstance(name, str) and SAFE_PROTOTYPE.fullmatch(name), f"unsafe prototype name at {index}")
        require(name not in by_name, f"duplicate catalog prototype {name}")
        require(value["family"] in FAMILIES, f"unknown family for {name}")
        require(isinstance(value["form"], str) and value["form"], f"invalid form for {name}")
        require(isinstance(value["variant"], int) and value["variant"] > 0, f"invalid variant for {name}")
        require(isinstance(value["dry"], bool), f"invalid dry flag for {name}")
        require(isinstance(value["instances"], int) and value["instances"] > 0, f"invalid count for {name}")
        for field in ("nominalHeightM", "nominalWidthM"):
            number = value[field]
            require(
                not isinstance(number, bool) and isinstance(number, (int, float)) and math.isfinite(number) and number > 0,
                f"invalid {field} for {name}",
            )
        family_counts[value["family"]] += value["instances"]
        by_name[name] = value

    require(len(by_name) == 31, "catalog must contain the reviewed 31 prototype names")
    require(sum(entry["instances"] for entry in by_name.values()) == 8805, "catalog instance ledger changed")
    require(document["instanceCount"] == 8805, "catalog declared instance count changed")
    require(family_counts == document["families"], "catalog family counts do not reconcile")
    document["sha256"] = sha256_file(CATALOG_PATH)
    return document, by_name


def parse_args(argv: Sequence[str], prototype_names: Iterable[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Author one original Customs vegetation prototype LOD.")
    parser.add_argument("--prototype", choices=sorted(prototype_names), required=True)
    parser.add_argument("--lod", type=int, choices=(0, 1, 2), required=True)
    parser.add_argument("--seed", type=int, default=106)
    parser.add_argument("--pine-alpha-proof", action="store_true")
    parser.add_argument("--deciduous-alpha-proof", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args(argv)
    require(0 <= args.seed <= 2**31 - 1, "--seed must be between 0 and 2147483647")
    require(not args.pine_alpha_proof or args.prototype == "pine01", "--pine-alpha-proof is restricted to pine01")
    require(
        not args.deciduous_alpha_proof or args.prototype == "tree02",
        "--deciduous-alpha-proof is restricted to tree02",
    )
    require(
        not (args.pine_alpha_proof and args.deciduous_alpha_proof),
        "alpha proof flags are mutually exclusive",
    )
    output = args.output.expanduser().resolve()
    receipt = args.receipt.expanduser().resolve()
    require(output.suffix.lower() == ".glb", "--output must use the .glb extension")
    require(receipt.suffix.lower() == ".json", "--receipt must use the .json extension")
    require(output != receipt, "--output and --receipt must differ")
    require(not output.exists(), f"refusing to overwrite existing output: {output}")
    require(not receipt.exists(), f"refusing to overwrite existing receipt: {receipt}")
    args.output = output
    args.receipt = receipt
    return args


def validate_blender() -> None:
    require(tuple(bpy.app.version[:2]) == (4, 5), f"Blender 4.5 is required, found {bpy.app.version_string}")
    require(bpy.app.background, "vegetation authoring must run in Blender background mode")


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in list(bpy.data.collections):
        if collection.name != "Collection":
            bpy.data.collections.remove(collection)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.curves):
        for item in list(block):
            block.remove(item)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.unit_settings.length_unit = "METERS"
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.world.color = (0.05, 0.05, 0.05)


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def hash_noise(seed: int, x: int, y: int, salt: int) -> float:
    value = (seed ^ (x * 0x9E3779B1) ^ (y * 0x85EBCA77) ^ (salt * 0xC2B2AE3D)) & 0xFFFFFFFF
    value ^= value >> 16
    value = (value * 0x7FEB352D) & 0xFFFFFFFF
    value ^= value >> 15
    value = (value * 0x846CA68B) & 0xFFFFFFFF
    value ^= value >> 16
    return value / 0xFFFFFFFF


def material_sample(
    kind: str,
    x: int,
    y: int,
    size: int,
    seed: int,
) -> tuple[float, tuple[float, float, float], float, float, float, float]:
    spec = MATERIAL_SPECS[kind]
    surface_kind = kind.removesuffix("-card")
    u = x / size
    v = y / size
    grain = hash_noise(seed, x, y, 1)
    broad = math.sin(math.tau * (u * 2.0 + v * 1.0)) * 0.035
    height = 0.5 + broad + (grain - 0.5) * 0.10
    tint = (hash_noise(seed, x // 4, y // 4, 2) - 0.5) * 0.11
    occlusion = 0.92
    roughness = float(spec["roughness"])
    metallic = float(spec["metallic"])

    if surface_kind == "bark-birch":
        horizontal = abs(math.sin(math.tau * (v * 11.0 + u * 0.8)))
        dark_mark = horizontal < 0.11 and hash_noise(seed, x // 3, y // 2, 7) > 0.52
        ridge = math.sin(math.tau * (u * 7.0 + v * 0.35))
        height += ridge * 0.075 - (0.18 if dark_mark else 0.0)
        base = (0.73, 0.71, 0.62) if not dark_mark else (0.12, 0.105, 0.075)
        color = tuple(clamp01(channel + tint * 0.55) for channel in base)
        occlusion -= 0.20 if dark_mark else 0.0
    elif surface_kind.startswith("bark-") or surface_kind == "twig":
        ridges = abs(math.sin(math.tau * (u * (8.0 if surface_kind == "bark-pine" else 11.0) + v * 0.3)))
        fissure = ridges < 0.12 and grain > 0.34
        height += (ridges - 0.5) * 0.22 - (0.16 if fissure else 0.0)
        base = spec["base"]
        color = tuple(clamp01(channel + tint - (0.07 if fissure else 0.0)) for channel in base)
        occlusion -= 0.24 if fissure else 0.0
    elif surface_kind == "cut-wood":
        dx = u - 0.5
        dy = v - 0.5
        radius = math.hypot(dx, dy)
        ring = 0.5 + 0.5 * math.sin(radius * 115.0 + hash_noise(seed, x // 8, y // 8, 8) * 2.0)
        crack = abs(math.sin(math.atan2(dy, dx) * 7.0 + radius * 4.0)) < 0.035 and radius > 0.17
        height += (ring - 0.5) * 0.10 - (0.25 if crack else 0.0)
        color = tuple(clamp01(channel + (ring - 0.5) * 0.10 + tint * 0.35) for channel in spec["base"])
        occlusion -= 0.30 if crack else 0.0
    elif surface_kind in {"needle-pine", "leaf-birch", "leaf-broadleaf", "leaf-shrub", "leaf-dry", "ground-green", "ground-dry", "moss"}:
        vein = abs(u - 0.5) < (0.025 if surface_kind != "needle-pine" else 0.012)
        cell = math.sin(math.tau * u * 5.0) * math.sin(math.tau * v * 7.0)
        height += cell * 0.08 + (0.07 if vein else 0.0)
        color = tuple(clamp01(channel + tint + cell * 0.025 + (0.045 if vein else 0.0)) for channel in spec["base"])
        occlusion -= max(0.0, -cell) * 0.08
    else:
        color = tuple(clamp01(channel + tint) for channel in spec["base"])

    alpha = 1.0
    if kind.endswith("-card"):
        nx = abs((u - 0.5) / 0.5)
        ny = abs((v - 0.5) / 0.5)
        if surface_kind == "needle-pine":
            half_width = 0.20 * max(0.0, 1.0 - ny**1.6) ** 0.42
        else:
            serration = 0.88 + 0.10 * math.sin(v * math.tau * 7.0)
            half_width = max(0.0, 1.0 - ny**1.55) ** 0.58 * serration
        alpha = 1.0 if ny <= 0.985 and nx <= half_width else 0.0
        if alpha == 0.0:
            color = (0.0, 0.0, 0.0)
    return (
        clamp01(height),
        color,
        clamp01(occlusion),
        clamp01(roughness + (grain - 0.5) * 0.06),
        metallic,
        alpha,
    )


def create_image(name: str, size: int, pixels: Sequence[float], colorspace: str) -> bpy.types.Image:
    image = bpy.data.images.new(name, width=size, height=size, alpha=True, float_buffer=False)
    image.file_format = "PNG"
    image.colorspace_settings.name = colorspace
    image.pixels.foreach_set(pixels)
    image.pack()
    image["tz_original_authored"] = True
    image["tz_generator"] = GENERATOR_NAME
    return image


def create_material(kind: str, lod: int, seed: int) -> bpy.types.Material:
    spec = MATERIAL_SPECS[kind]
    size = TEXTURE_SIZE_BY_LOD[lod]
    samples = [material_sample(kind, x, y, size, seed) for y in range(size) for x in range(size)]
    heights = [sample[0] for sample in samples]
    base_pixels: list[float] = []
    orm_pixels: list[float] = []
    for _, color, occlusion, roughness, metallic, alpha in samples:
        base_pixels.extend((*color, alpha))
        orm_pixels.extend((occlusion, roughness, metallic, 1.0))

    normal_pixels: list[float] = []
    strength = 2.1 if kind.startswith("bark-") else (1.35 if kind == "cut-wood" else 0.72)
    for y in range(size):
        for x in range(size):
            left = heights[y * size + ((x - 1) % size)]
            right = heights[y * size + ((x + 1) % size)]
            down = heights[((y - 1) % size) * size + x]
            up = heights[((y + 1) % size) * size + x]
            normal = Vector((-(right - left) * strength, -(up - down) * strength, 1.0)).normalized()
            normal_pixels.extend((normal.x * 0.5 + 0.5, normal.y * 0.5 + 0.5, normal.z * 0.5 + 0.5, 1.0))

    slug = kind.replace("-", "_")
    prefix = f"TZ_VEG_{slug}_L{lod}"
    base_image = create_image(f"{prefix}_BaseColor", size, base_pixels, "sRGB")
    normal_image = create_image(f"{prefix}_Normal", size, normal_pixels, "Non-Color")
    orm_image = create_image(f"{prefix}_ORM", size, orm_pixels, "Non-Color")

    material = bpy.data.materials.new(f"TZ_VEG_{slug}_PBR_L{lod}")
    material.use_nodes = True
    material.use_backface_culling = False
    material.diffuse_color = (*spec["base"], 1.0)
    material.metallic = float(spec["metallic"])
    material.roughness = float(spec["roughness"])
    material["tz_material_family"] = kind
    material["tz_original_authored"] = True
    material["tz_texture_resolution"] = size
    material["tz_orm_channels"] = "R=occlusion,G=roughness,B=metallic"
    alpha_card = kind.endswith("-card")
    material["tz_alpha_card"] = alpha_card
    if alpha_card:
        material.surface_render_method = "DITHERED"
        material.alpha_threshold = 0.45

    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    output.location = (720, 0)
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (420, 0)
    bsdf.inputs["Base Color"].default_value = (*spec["base"], 1.0)
    bsdf.inputs["Metallic"].default_value = float(spec["metallic"])
    bsdf.inputs["Roughness"].default_value = float(spec["roughness"])
    links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])

    base_node = nodes.new("ShaderNodeTexImage")
    base_node.name = f"{prefix}_BaseColorNode"
    base_node.label = "Original deterministic base color"
    base_node.image = base_image
    base_node.interpolation = "Linear"
    base_node.extension = "REPEAT"
    base_node.location = (-620, 180)
    links.new(base_node.outputs["Color"], bsdf.inputs["Base Color"])
    if alpha_card:
        links.new(base_node.outputs["Alpha"], bsdf.inputs["Alpha"])

    normal_node = nodes.new("ShaderNodeTexImage")
    normal_node.name = f"{prefix}_NormalNode"
    normal_node.label = "Original deterministic tangent normal"
    normal_node.image = normal_image
    normal_node.interpolation = "Linear"
    normal_node.extension = "REPEAT"
    normal_node.location = (-620, -80)
    normal_map = nodes.new("ShaderNodeNormalMap")
    normal_map.location = (110, -150)
    normal_map.inputs["Strength"].default_value = 0.78 if lod == 0 else (0.62 if lod == 1 else 0.48)
    links.new(normal_node.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])

    orm_node = nodes.new("ShaderNodeTexImage")
    orm_node.name = f"{prefix}_ORMNode"
    orm_node.label = "Original deterministic ORM"
    orm_node.image = orm_image
    orm_node.interpolation = "Linear"
    orm_node.extension = "REPEAT"
    orm_node.location = (-620, -370)
    separate = nodes.new("ShaderNodeSeparateColor")
    separate.location = (-90, -370)
    links.new(orm_node.outputs["Color"], separate.inputs["Color"])
    links.new(separate.outputs["Green"], bsdf.inputs["Roughness"])
    links.new(separate.outputs["Blue"], bsdf.inputs["Metallic"])

    group_tree = bpy.data.node_groups.get("glTF Material Output")
    if group_tree is None:
        group_tree = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
        group_tree.interface.new_socket(name="Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
    gltf_output = nodes.new("ShaderNodeGroup")
    gltf_output.node_tree = group_tree
    gltf_output.label = "glTF occlusion channel"
    gltf_output.location = (120, -480)
    links.new(separate.outputs["Red"], gltf_output.inputs["Occlusion"])
    return material


def texture_resolution(
    spec: dict,
    lod: int,
    pine_alpha_proof: bool,
    deciduous_alpha_proof: bool = False,
) -> int:
    if pine_alpha_proof and spec["name"] == "pine01":
        return PINE_ATLAS_TEXTURE_BY_LOD[lod]
    if deciduous_alpha_proof and spec["name"] == "tree02":
        return DECIDUOUS_ATLAS_TEXTURE_BY_LOD[lod]
    return TEXTURE_SIZE_BY_LOD[lod]


def load_processed_pine_atlas(size: int) -> tuple[Sequence[float], Sequence[float], Sequence[float]]:
    """Load, resize, RGB-dilate, and derive tangent-normal/ORM pixels in memory."""
    import numpy as np

    require(PINE_ATLAS_PATH.is_file() and not PINE_ATLAS_PATH.is_symlink(), "pinned pine atlas is unavailable")
    require(PINE_ATLAS_PROVENANCE_PATH.is_file(), "pinned pine atlas provenance is unavailable")
    require(sha256_file(PINE_ATLAS_PATH) == PINE_ATLAS_SHA256, "pinned pine atlas hash changed")
    provenance = json.loads(PINE_ATLAS_PROVENANCE_PATH.read_text(encoding="utf-8"))
    require(provenance.get("sha256") == f"sha256:{PINE_ATLAS_SHA256}", "pine atlas provenance hash changed")
    require(provenance.get("origin", {}).get("sourceGameTexture") is False, "pine atlas source boundary changed")

    source = bpy.data.images.load(str(PINE_ATLAS_PATH), check_existing=False)
    try:
        require(tuple(source.size) == PINE_ATLAS_SOURCE_SIZE, "pinned pine atlas dimensions changed")
        source.colorspace_settings.name = "sRGB"
        source.alpha_mode = "CHANNEL_PACKED"
        source.scale(size, size)
        flat = np.empty(size * size * 4, dtype=np.float32)
        source.pixels.foreach_get(flat)
    finally:
        bpy.data.images.remove(source)
    rgba = flat.reshape((size, size, 4)).copy()
    alpha = rgba[:, :, 3].copy()
    rgb = rgba[:, :, :3].copy()

    # The immutable source has black zero-alpha RGB. Grow credible edge color
    # beneath transparency so bilinear/mip sampling cannot create a black halo.
    filled = alpha >= (16.0 / 255.0)
    for _ in range(8):
        sums = np.zeros_like(rgb)
        counts = np.zeros((size, size), dtype=np.float32)
        sums[1:, :, :] += rgb[:-1, :, :] * filled[:-1, :, None]
        counts[1:, :] += filled[:-1, :]
        sums[:-1, :, :] += rgb[1:, :, :] * filled[1:, :, None]
        counts[:-1, :] += filled[1:, :]
        sums[:, 1:, :] += rgb[:, :-1, :] * filled[:, :-1, None]
        counts[:, 1:] += filled[:, :-1]
        sums[:, :-1, :] += rgb[:, 1:, :] * filled[:, 1:, None]
        counts[:, :-1] += filled[:, 1:]
        grow = (~filled) & (counts > 0)
        if not bool(grow.any()):
            break
        rgb[grow] = sums[grow] / counts[grow, None]
        filled[grow] = True
    # Muted late-summer factor; alpha remains the original resampled coverage.
    rgb *= np.array((0.88, 0.94, 0.82), dtype=np.float32)
    np.clip(rgb, 0.0, 1.0, out=rgb)
    rgba[:, :, :3] = rgb

    luminance = rgb[:, :, 0] * 0.2126 + rgb[:, :, 1] * 0.7152 + rgb[:, :, 2] * 0.0722
    height = luminance * 0.38 + alpha * 0.62
    dx = np.zeros_like(height)
    dy = np.zeros_like(height)
    dx[:, 1:-1] = (height[:, 2:] - height[:, :-2]) * 0.42
    dy[1:-1, :] = (height[2:, :] - height[:-2, :]) * 0.42
    normal = np.stack((-dx, -dy, np.ones_like(height)), axis=2)
    normal /= np.linalg.norm(normal, axis=2, keepdims=True)
    normal_rgba = np.empty_like(rgba)
    normal_rgba[:, :, :3] = normal * 0.5 + 0.5
    normal_rgba[:, :, 3] = 1.0

    orm = np.empty_like(rgba)
    orm[:, :, 0] = 0.90 + alpha * 0.08
    orm[:, :, 1] = np.clip(0.76 + (1.0 - luminance) * 0.12, 0.76, 0.90)
    orm[:, :, 2] = 0.0
    orm[:, :, 3] = 1.0
    return rgba.ravel(), normal_rgba.ravel(), orm.ravel()


def create_pine_atlas_material(lod: int) -> bpy.types.Material:
    size = PINE_ATLAS_TEXTURE_BY_LOD[lod]
    base_pixels, normal_pixels, orm_pixels = load_processed_pine_atlas(size)
    prefix = f"TZ_VEG_pine_scots_atlas_L{lod}"
    base_image = create_image(f"{prefix}_BaseColor", size, base_pixels, "sRGB")
    normal_image = create_image(f"{prefix}_Normal", size, normal_pixels, "Non-Color")
    orm_image = create_image(f"{prefix}_ORM", size, orm_pixels, "Non-Color")

    material = bpy.data.materials.new(f"TZ_VEG_pine_scots_atlas_PBR_L{lod}")
    material.use_nodes = True
    material.use_backface_culling = False
    material.surface_render_method = "DITHERED"
    material.alpha_threshold = PINE_ALPHA_CUTOFF
    material.diffuse_color = (0.22, 0.30, 0.12, 1.0)
    material.metallic = 0.0
    material.roughness = 0.82
    material["tz_material_family"] = "needle-pine-atlas"
    material["tz_original_authored"] = True
    material["tz_openai_generated_original_source"] = True
    material["tz_source_game_texture"] = False
    material["tz_source_atlas_sha256"] = f"sha256:{PINE_ATLAS_SHA256}"
    material["tz_texture_resolution"] = size
    material["tz_orm_channels"] = "R=occlusion,G=roughness,B=metallic"
    material["tz_alpha_card"] = True
    material["tz_alpha_cutoff"] = PINE_ALPHA_CUTOFF
    material["tz_edge_dilation_pixels"] = 8

    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    output.location = (760, 0)
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (450, 0)
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Roughness"].default_value = 0.82
    links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])

    base_node = nodes.new("ShaderNodeTexImage")
    base_node.image = base_image
    base_node.interpolation = "Linear"
    base_node.extension = "CLIP"
    base_node.location = (-650, 190)
    links.new(base_node.outputs["Color"], bsdf.inputs["Base Color"])
    clip = nodes.new("ShaderNodeMath")
    clip.operation = "GREATER_THAN"
    clip.inputs[1].default_value = PINE_ALPHA_CUTOFF
    clip.location = (160, 170)
    links.new(base_node.outputs["Alpha"], clip.inputs[0])
    links.new(clip.outputs[0], bsdf.inputs["Alpha"])

    normal_node = nodes.new("ShaderNodeTexImage")
    normal_node.image = normal_image
    normal_node.interpolation = "Linear"
    normal_node.extension = "CLIP"
    normal_node.location = (-650, -70)
    normal_map = nodes.new("ShaderNodeNormalMap")
    normal_map.inputs["Strength"].default_value = (0.72, 0.58, 0.42)[lod]
    normal_map.location = (150, -115)
    links.new(normal_node.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])

    orm_node = nodes.new("ShaderNodeTexImage")
    orm_node.image = orm_image
    orm_node.interpolation = "Linear"
    orm_node.extension = "CLIP"
    orm_node.location = (-650, -350)
    separate = nodes.new("ShaderNodeSeparateColor")
    separate.location = (-100, -350)
    links.new(orm_node.outputs["Color"], separate.inputs["Color"])
    links.new(separate.outputs["Green"], bsdf.inputs["Roughness"])
    links.new(separate.outputs["Blue"], bsdf.inputs["Metallic"])
    group_tree = bpy.data.node_groups.get("glTF Material Output")
    if group_tree is None:
        group_tree = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
        group_tree.interface.new_socket(name="Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
    gltf_output = nodes.new("ShaderNodeGroup")
    gltf_output.node_tree = group_tree
    gltf_output.location = (145, -455)
    links.new(separate.outputs["Red"], gltf_output.inputs["Occlusion"])
    return material


def resize_rgba_bilinear(source, height: int, width: int):
    """Deterministic NumPy bilinear resize used inside Blender's pinned runtime."""
    import numpy as np

    source_height, source_width, channels = source.shape
    require(channels == 4 and source_height > 1 and source_width > 1, "RGBA resize source is invalid")
    require(height > 0 and width > 0, "RGBA resize target is invalid")
    xs = np.linspace(0.0, source_width - 1.0, width, dtype=np.float32)
    ys = np.linspace(0.0, source_height - 1.0, height, dtype=np.float32)
    x0 = np.floor(xs).astype(np.int32)
    y0 = np.floor(ys).astype(np.int32)
    x1 = np.minimum(x0 + 1, source_width - 1)
    y1 = np.minimum(y0 + 1, source_height - 1)
    wx = (xs - x0)[None, :, None]
    wy = (ys - y0)[:, None, None]
    lower = source[y0[:, None], x0[None, :]] * (1.0 - wx) + source[y0[:, None], x1[None, :]] * wx
    upper = source[y1[:, None], x0[None, :]] * (1.0 - wx) + source[y1[:, None], x1[None, :]] * wx
    return lower * (1.0 - wy) + upper * wy


def load_processed_deciduous_atlas(lod: int) -> tuple[Sequence[float], Sequence[float], Sequence[float]]:
    """Independently repack cells, reject fringe, dilate edges, and derive PBR maps."""
    import numpy as np

    size = DECIDUOUS_ATLAS_TEXTURE_BY_LOD[lod]
    gutter = DECIDUOUS_ATLAS_GUTTER_BY_LOD[lod]
    require(DECIDUOUS_ATLAS_PATH.is_file() and not DECIDUOUS_ATLAS_PATH.is_symlink(), "pinned deciduous atlas is unavailable")
    require(DECIDUOUS_ATLAS_PROVENANCE_PATH.is_file(), "pinned deciduous atlas provenance is unavailable")
    require(sha256_file(DECIDUOUS_ATLAS_PATH) == DECIDUOUS_ATLAS_SHA256, "pinned deciduous atlas hash changed")
    provenance = json.loads(DECIDUOUS_ATLAS_PROVENANCE_PATH.read_text(encoding="utf-8"))
    require(
        provenance.get("sha256") == f"sha256:{DECIDUOUS_ATLAS_SHA256}",
        "deciduous atlas provenance hash changed",
    )
    require(
        provenance.get("origin", {}).get("sourceGameTexture") is False,
        "deciduous atlas source boundary changed",
    )

    source_image = bpy.data.images.load(str(DECIDUOUS_ATLAS_PATH), check_existing=False)
    try:
        require(tuple(source_image.size) == DECIDUOUS_ATLAS_SOURCE_SIZE, "pinned deciduous atlas dimensions changed")
        source_image.colorspace_settings.name = "sRGB"
        source_image.alpha_mode = "CHANNEL_PACKED"
        source_flat = np.empty(source_image.size[0] * source_image.size[1] * 4, dtype=np.float32)
        source_image.pixels.foreach_get(source_flat)
    finally:
        bpy.data.images.remove(source_image)
    source_rgba = source_flat.reshape((DECIDUOUS_ATLAS_SOURCE_SIZE[1], DECIDUOUS_ATLAS_SOURCE_SIZE[0], 4))
    derived = np.zeros((size, size, 4), dtype=np.float32)
    source_x = [round(column * DECIDUOUS_ATLAS_SOURCE_SIZE[0] / 4) for column in range(5)]
    source_y = [round(row * DECIDUOUS_ATLAS_SOURCE_SIZE[1] / 3) for row in range(4)]
    target_x = [round(column * size / 4) for column in range(5)]
    target_y = [round(row * size / 3) for row in range(4)]
    cutoff = DECIDUOUS_ALPHA_CUTOFF

    for row in range(3):
        for column in range(4):
            source_cell = source_rgba[
                source_y[row] : source_y[row + 1],
                source_x[column] : source_x[column + 1],
                :,
            ]
            cell_height = target_y[row + 1] - target_y[row]
            cell_width = target_x[column + 1] - target_x[column]
            cell_gutter = min(gutter, max(1, (cell_height - 4) // 4), max(1, (cell_width - 4) // 4))
            content_height = cell_height - cell_gutter * 2
            content_width = cell_width - cell_gutter * 2
            resized = resize_rgba_bilinear(source_cell, content_height, content_width)
            target_cell = np.zeros((cell_height, cell_width, 4), dtype=np.float32)
            target_cell[
                cell_gutter : cell_gutter + content_height,
                cell_gutter : cell_gutter + content_width,
                :,
            ] = resized
            alpha = target_cell[:, :, 3]
            rgb = target_cell[:, :, :3]
            # Generated saturated edge specks all fall below the proof cutoff.
            # Remove their RGB before growing only accepted foliage color.
            credible = alpha >= cutoff
            rgb[~credible] = 0.0
            filled = credible.copy()
            for _ in range(4):
                sums = np.zeros_like(rgb)
                counts = np.zeros((cell_height, cell_width), dtype=np.float32)
                sums[1:, :, :] += rgb[:-1, :, :] * filled[:-1, :, None]
                counts[1:, :] += filled[:-1, :]
                sums[:-1, :, :] += rgb[1:, :, :] * filled[1:, :, None]
                counts[:-1, :] += filled[1:, :]
                sums[:, 1:, :] += rgb[:, :-1, :] * filled[:, :-1, None]
                counts[:, 1:] += filled[:, :-1]
                sums[:, :-1, :] += rgb[:, 1:, :] * filled[:, 1:, None]
                counts[:, :-1] += filled[:, 1:]
                grow = (~filled) & (counts > 0)
                if not bool(grow.any()):
                    break
                rgb[grow] = sums[grow] / counts[grow, None]
                filled[grow] = True
            luminance = rgb[:, :, 0] * 0.2126 + rgb[:, :, 1] * 0.7152 + rgb[:, :, 2] * 0.0722
            rgb[:] = rgb * 0.88 + luminance[:, :, None] * 0.12
            rgb *= np.array((0.90, 0.93, 0.82), dtype=np.float32)
            np.clip(rgb, 0.0, 1.0, out=rgb)
            derived[
                target_y[row] : target_y[row + 1],
                target_x[column] : target_x[column + 1],
                :,
            ] = target_cell

    alpha = derived[:, :, 3]
    rgb = derived[:, :, :3]
    luminance = rgb[:, :, 0] * 0.2126 + rgb[:, :, 1] * 0.7152 + rgb[:, :, 2] * 0.0722
    height = (luminance * 0.46 + alpha * 0.54) * alpha
    dx = np.zeros_like(height)
    dy = np.zeros_like(height)
    dx[:, 1:-1] = (height[:, 2:] - height[:, :-2]) * 0.34
    dy[1:-1, :] = (height[2:, :] - height[:-2, :]) * 0.34
    normal = np.stack((-dx, -dy, np.ones_like(height)), axis=2)
    normal /= np.linalg.norm(normal, axis=2, keepdims=True)
    normal_rgba = np.empty_like(derived)
    normal_rgba[:, :, :3] = normal * 0.5 + 0.5
    normal_rgba[:, :, 3] = 1.0

    orm = np.empty_like(derived)
    orm[:, :, 0] = 0.91 + alpha * 0.07
    orm[:, :, 1] = np.clip(0.78 + (1.0 - luminance) * 0.12, 0.78, 0.92)
    orm[:, :, 2] = 0.0
    orm[:, :, 3] = 1.0
    return derived.ravel(), normal_rgba.ravel(), orm.ravel()


def create_deciduous_atlas_material(lod: int) -> bpy.types.Material:
    size = DECIDUOUS_ATLAS_TEXTURE_BY_LOD[lod]
    base_pixels, normal_pixels, orm_pixels = load_processed_deciduous_atlas(lod)
    prefix = f"TZ_VEG_deciduous_broadleaf_atlas_L{lod}"
    base_image = create_image(f"{prefix}_BaseColor", size, base_pixels, "sRGB")
    normal_image = create_image(f"{prefix}_Normal", size, normal_pixels, "Non-Color")
    orm_image = create_image(f"{prefix}_ORM", size, orm_pixels, "Non-Color")

    material = bpy.data.materials.new(f"TZ_VEG_deciduous_broadleaf_atlas_PBR_L{lod}")
    material.use_nodes = True
    material.use_backface_culling = False
    material.surface_render_method = "DITHERED"
    material.alpha_threshold = DECIDUOUS_ALPHA_CUTOFF
    material.diffuse_color = (0.24, 0.34, 0.11, 1.0)
    material.metallic = 0.0
    material.roughness = 0.84
    material["tz_material_family"] = "leaf-deciduous-broadleaf-atlas"
    material["tz_original_authored"] = True
    material["tz_openai_generated_original_source"] = True
    material["tz_source_game_texture"] = False
    material["tz_source_atlas_sha256"] = f"sha256:{DECIDUOUS_ATLAS_SHA256}"
    material["tz_texture_resolution"] = size
    material["tz_orm_channels"] = "R=occlusion,G=roughness,B=metallic"
    material["tz_alpha_card"] = True
    material["tz_alpha_cutoff"] = DECIDUOUS_ALPHA_CUTOFF
    material["tz_edge_dilation_pixels"] = 4
    material["tz_cell_gutter_pixels"] = DECIDUOUS_ATLAS_GUTTER_BY_LOD[lod]
    material["tz_cell_isolation"] = "independent-resample"

    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    output.location = (760, 0)
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (450, 0)
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Roughness"].default_value = 0.84
    links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])

    base_node = nodes.new("ShaderNodeTexImage")
    base_node.image = base_image
    base_node.interpolation = "Linear"
    base_node.extension = "CLIP"
    base_node.location = (-650, 190)
    links.new(base_node.outputs["Color"], bsdf.inputs["Base Color"])
    clip = nodes.new("ShaderNodeMath")
    clip.operation = "GREATER_THAN"
    clip.inputs[1].default_value = DECIDUOUS_ALPHA_CUTOFF
    clip.location = (160, 170)
    links.new(base_node.outputs["Alpha"], clip.inputs[0])
    links.new(clip.outputs[0], bsdf.inputs["Alpha"])

    normal_node = nodes.new("ShaderNodeTexImage")
    normal_node.image = normal_image
    normal_node.interpolation = "Linear"
    normal_node.extension = "CLIP"
    normal_node.location = (-650, -70)
    normal_map = nodes.new("ShaderNodeNormalMap")
    normal_map.inputs["Strength"].default_value = (0.58, 0.42, 0.28)[lod]
    normal_map.location = (150, -115)
    links.new(normal_node.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])

    orm_node = nodes.new("ShaderNodeTexImage")
    orm_node.image = orm_image
    orm_node.interpolation = "Linear"
    orm_node.extension = "CLIP"
    orm_node.location = (-650, -350)
    separate = nodes.new("ShaderNodeSeparateColor")
    separate.location = (-100, -350)
    links.new(orm_node.outputs["Color"], separate.inputs["Color"])
    links.new(separate.outputs["Green"], bsdf.inputs["Roughness"])
    links.new(separate.outputs["Blue"], bsdf.inputs["Metallic"])
    group_tree = bpy.data.node_groups.get("glTF Material Output")
    if group_tree is None:
        group_tree = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
        group_tree.interface.new_socket(name="Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
    gltf_output = nodes.new("ShaderNodeGroup")
    gltf_output.node_tree = group_tree
    gltf_output.location = (145, -455)
    links.new(separate.outputs["Red"], gltf_output.inputs["Occlusion"])
    return material


def material_kinds(spec: dict, lod: int) -> tuple[str, ...]:
    family = spec["family"]
    if family == "birch":
        return ("bark-birch", "leaf-birch", "leaf-birch-card")
    if family == "deciduous-broadleaf":
        return ("bark-broadleaf", "leaf-broadleaf", "leaf-broadleaf-card")
    if family == "pine":
        return ("bark-pine", "needle-pine", "needle-pine-card")
    if family == "filbert-shrub":
        leaf = "leaf-dry" if spec["dry"] else "leaf-shrub"
        return ("twig", leaf, f"{leaf}-card")
    if family == "stump":
        return ("bark-broadleaf", "cut-wood") + (("moss",) if lod == 0 else ())
    return (("ground-dry",) if spec["dry"] else ("ground-green", "twig"))


def assign_uv(mesh: bpy.types.Mesh, scale: float = 0.32) -> None:
    uv_layer = mesh.uv_layers.new(name="UVMap")
    for polygon in mesh.polygons:
        for loop_index in polygon.loop_indices:
            vertex = mesh.vertices[mesh.loops[loop_index].vertex_index].co
            uv_layer.data[loop_index].uv = (
                vertex.x * scale + vertex.z * scale * 0.19,
                vertex.z * scale + vertex.y * scale * 0.13,
            )


class Builder:
    def __init__(self, spec: dict, lod: int, seed: int, materials: dict[str, bpy.types.Material]):
        self.spec = spec
        self.lod = lod
        self.seed = seed
        self.rng = random.Random(stable_seed(seed, spec["name"]))
        self.materials = materials
        self.collection = bpy.data.collections.new("TZ_VegetationGeometry")
        bpy.context.scene.collection.children.link(self.collection)
        slug = spec["name"].lower()
        self.root_name = f"TZ_Vegetation_{slug}_LOD{lod}_ROOT"
        self.root = bpy.data.objects.new(self.root_name, None)
        self.collection.objects.link(self.root)
        self.root.empty_display_type = "PLAIN_AXES"
        self.root.empty_display_size = 0.2
        self.root["tz_asset_id"] = f"customs.vegetation.{slug}"
        self.root["tz_prototype"] = spec["name"]
        self.root["tz_family"] = spec["family"]
        self.root["tz_form"] = spec["form"]
        self.root["tz_lod"] = lod
        self.root["tz_unit"] = "metre"
        self.root["tz_up_axis"] = "+y"
        self.root["tz_pivot"] = "base-center"
        self.root["tz_seed"] = seed
        self.root["tz_original_authored"] = True
        self.counters = {
            "branchSegments": 0,
            "trunkSegments": 0,
            "foliageClusters": 0,
            "leafCards": 0,
            "rootFlares": 0,
            "plantBlades": 0,
        }

    def jitter(self, amount: float) -> float:
        return self.rng.uniform(-amount, amount)

    def add_mesh(
        self,
        name: str,
        vertices: Sequence[Sequence[float]],
        faces: Sequence[Sequence[int]],
        material_kind: str,
        *,
        uv_scale: float = 0.32,
    ) -> bpy.types.Object:
        require(vertices and faces, f"{name} must have geometry")
        mesh = bpy.data.meshes.new(f"{name}_Mesh")
        mesh.from_pydata(vertices, [], faces)
        mesh.materials.append(self.materials[material_kind])
        mesh.update(calc_edges=True)
        assign_uv(mesh, uv_scale)
        for polygon in mesh.polygons:
            polygon.use_smooth = len(polygon.vertices) <= 4
        obj = bpy.data.objects.new(name, mesh)
        self.collection.objects.link(obj)
        obj.parent = self.root
        obj["tz_component"] = name.split("_", 1)[0]
        obj["tz_material_family"] = material_kind
        obj["tz_original_authored"] = True
        return obj

    @staticmethod
    def basis(axis: Vector) -> tuple[Vector, Vector, Vector]:
        direction = axis.normalized()
        helper = Vector((0.0, 0.0, 1.0)) if abs(direction.z) < 0.91 else Vector((0.0, 1.0, 0.0))
        side = direction.cross(helper).normalized()
        other = direction.cross(side).normalized()
        return direction, side, other

    def add_frustum(
        self,
        name: str,
        start: Sequence[float],
        end: Sequence[float],
        radius_start: float,
        radius_end: float,
        sides: int,
        material_kind: str,
        *,
        component: str,
    ) -> bpy.types.Object:
        start_v = Vector(start)
        end_v = Vector(end)
        require((end_v - start_v).length > 1e-4, f"{name} has zero length")
        direction, side, other = self.basis(end_v - start_v)
        del direction
        vertices = []
        for center, radius in ((start_v, radius_start), (end_v, radius_end)):
            for index in range(sides):
                angle = math.tau * index / sides
                point = center + side * (math.cos(angle) * radius) + other * (math.sin(angle) * radius)
                vertices.append(tuple(point))
        faces = []
        for index in range(sides):
            nxt = (index + 1) % sides
            faces.append((index, nxt, sides + nxt, sides + index))
        faces.append(tuple(reversed(range(sides))))
        faces.append(tuple(range(sides, sides * 2)))
        obj = self.add_mesh(name, vertices, faces, material_kind, uv_scale=0.48)
        self.counters[component] += 1
        return obj

    def add_polyline(
        self,
        name: str,
        points: Sequence[Sequence[float]],
        radius_start: float,
        radius_end: float,
        sides: int,
        material_kind: str,
        *,
        component: str,
    ) -> None:
        require(len(points) >= 2, f"{name} needs at least two points")
        for index, (start, end) in enumerate(zip(points, points[1:])):
            fraction0 = index / (len(points) - 1)
            fraction1 = (index + 1) / (len(points) - 1)
            r0 = radius_start + (radius_end - radius_start) * fraction0
            r1 = radius_start + (radius_end - radius_start) * fraction1
            self.add_frustum(
                f"{name}_{index:02d}", start, end, r0, r1, sides, material_kind, component=component,
            )

    def add_cone(
        self,
        name: str,
        base: Sequence[float],
        tip: Sequence[float],
        radius: float,
        sides: int,
        material_kind: str,
    ) -> None:
        base_v = Vector(base)
        tip_v = Vector(tip)
        _, side, other = self.basis(tip_v - base_v)
        vertices = []
        for index in range(sides):
            angle = math.tau * index / sides
            vertices.append(tuple(base_v + side * (math.cos(angle) * radius) + other * (math.sin(angle) * radius)))
        vertices.append(tuple(tip_v))
        faces = [tuple(reversed(range(sides)))]
        faces.extend((index, (index + 1) % sides, sides) for index in range(sides))
        self.add_mesh(name, vertices, faces, material_kind, uv_scale=0.41)
        self.counters["foliageClusters"] += 1

    def add_ellipsoid(
        self,
        name: str,
        center: Sequence[float],
        radii: Sequence[float],
        segments: int,
        rings: int,
        material_kind: str,
        *,
        axis: Sequence[float] = (0.0, 0.0, 1.0),
    ) -> None:
        center_v = Vector(center)
        main, side, other = self.basis(Vector(axis))
        rx, ry, rz = radii
        vertices = [tuple(center_v - main * rz)]
        for ring in range(1, rings + 1):
            theta = math.pi * ring / (rings + 1)
            ring_radius = math.sin(theta)
            for segment in range(segments):
                phi = math.tau * segment / segments
                variation = 1.0 + self.jitter(0.055 if self.lod == 0 else 0.025)
                point = (
                    center_v
                    + side * (math.cos(phi) * rx * ring_radius * variation)
                    + other * (math.sin(phi) * ry * ring_radius * variation)
                    + main * (math.cos(theta) * rz)
                )
                vertices.append(tuple(point))
        top = len(vertices)
        vertices.append(tuple(center_v + main * rz))
        faces = []
        for segment in range(segments):
            faces.append((0, 1 + (segment + 1) % segments, 1 + segment))
        for ring in range(rings - 1):
            start = 1 + ring * segments
            next_start = start + segments
            for segment in range(segments):
                nxt = (segment + 1) % segments
                faces.append((start + segment, start + nxt, next_start + nxt, next_start + segment))
        last = 1 + (rings - 1) * segments
        for segment in range(segments):
            faces.append((last + segment, last + (segment + 1) % segments, top))
        self.add_mesh(name, vertices, faces, material_kind, uv_scale=0.38)
        self.counters["foliageClusters"] += 1

    def add_leaf(
        self,
        name: str,
        center: Sequence[float],
        direction: Sequence[float],
        length: float,
        width: float,
        material_kind: str,
    ) -> None:
        center_v = Vector(center)
        main, side, normal = self.basis(Vector(direction))
        base = center_v - main * (length * 0.5)
        tip = center_v + main * (length * 0.5)
        left = center_v + side * (width * 0.5)
        right = center_v - side * (width * 0.5)
        ridge = center_v + normal * (width * 0.12)
        vertices = [tuple(base), tuple(left), tuple(tip), tuple(right), tuple(ridge)]
        faces = [(0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4)]
        obj = self.add_mesh(name, vertices, faces, material_kind, uv_scale=1.25)
        leaf_uv = ((0.5, 0.0), (0.0, 0.5), (0.5, 1.0), (1.0, 0.5), (0.5, 0.5))
        uv_layer = obj.data.uv_layers.active
        for polygon in obj.data.polygons:
            for loop_index in polygon.loop_indices:
                vertex_index = obj.data.loops[loop_index].vertex_index
                uv_layer.data[loop_index].uv = leaf_uv[vertex_index]
        self.counters["leafCards"] += 1

    def add_atlas_spray(
        self,
        name: str,
        attachment: Sequence[float],
        direction: Sequence[float],
        width: float,
        height: float,
        cell: int,
        roll: float,
    ) -> None:
        """Attach one atlas cutout by its twig base to a real branch endpoint."""
        require(0 <= cell < len(PINE_ATLAS_CELLS), f"invalid pine atlas cell {cell}")
        axis = Vector(direction)
        require(axis.length > 1e-5, f"{name} has zero spray direction")
        axis.normalize()
        _, side, other = self.basis(axis)
        across = side * math.cos(roll) + other * math.sin(roll)
        (anchor_x, anchor_y_top), (tip_x, tip_y_top) = PINE_ATLAS_CELLS[cell]
        anchor_y = 1.0 - anchor_y_top
        tip_y = 1.0 - tip_y_top
        delta_u = (tip_x - anchor_x) * width
        delta_v = (tip_y - anchor_y) * height
        delta_length = math.hypot(delta_u, delta_v)
        require(delta_length > 1e-5, f"{name} has invalid source anchor metadata")
        u_alignment = delta_u / delta_length
        v_alignment = delta_v / delta_length
        basis_u = axis * u_alignment - across * v_alignment
        basis_v = axis * v_alignment + across * u_alignment
        attachment_v = Vector(attachment)
        local_corners = ((0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0))
        nominal_half_width = float(self.spec["nominalWidthM"]) * 0.498
        nominal_height = float(self.spec["nominalHeightM"])
        vertices = []
        for u, v in local_corners:
            point = (
                attachment_v
                + basis_u * ((u - anchor_x) * width)
                + basis_v * ((v - anchor_y) * height)
            )
            # Keep every LOD in one canonical metre envelope. This prevents
            # per-LOD fit scaling from moving shared branch/card landmarks.
            point.x = max(-nominal_half_width, min(nominal_half_width, point.x))
            point.y = max(-nominal_half_width, min(nominal_half_width, point.y))
            point.z = max(0.0, min(nominal_height * 0.996, point.z))
            vertices.append(tuple(point))
        obj = self.add_mesh(name, vertices, [(0, 1, 2, 3)], "needle-pine-atlas", uv_scale=1.0)
        row, column = divmod(cell, 4)
        pixel_inset = 2.5 / PINE_ATLAS_TEXTURE_BY_LOD[self.lod]
        u0 = column / 4.0 + pixel_inset
        u1 = (column + 1) / 4.0 - pixel_inset
        v0 = 1.0 - (row + 1) / 3.0 + pixel_inset
        v1 = 1.0 - row / 3.0 - pixel_inset
        atlas_uv = ((u0, v0), (u1, v0), (u1, v1), (u0, v1))
        uv_layer = obj.data.uv_layers.active
        for polygon in obj.data.polygons:
            for loop_index in polygon.loop_indices:
                vertex_index = obj.data.loops[loop_index].vertex_index
                uv_layer.data[loop_index].uv = atlas_uv[vertex_index]
        obj["tz_atlas_cell"] = cell
        obj["tz_attachment"] = "branch-endpoint"
        self.counters["leafCards"] += 1

    def add_deciduous_atlas_spray(
        self,
        name: str,
        attachment: Sequence[float],
        direction: Sequence[float],
        width: float,
        height: float,
        cell: int,
        roll: float,
    ) -> None:
        """Attach one independently-guttered broadleaf spray to an authored twig."""
        require(0 <= cell < len(DECIDUOUS_ATLAS_CELLS), f"invalid deciduous atlas cell {cell}")
        axis = Vector(direction)
        require(axis.length > 1e-5, f"{name} has zero spray direction")
        axis.normalize()
        _, side, other = self.basis(axis)
        across = side * math.cos(roll) + other * math.sin(roll)
        (anchor_x, anchor_y_top), (tip_x, tip_y_top) = DECIDUOUS_ATLAS_CELLS[cell]
        anchor_y = 1.0 - anchor_y_top
        tip_y = 1.0 - tip_y_top
        delta_u = (tip_x - anchor_x) * width
        delta_v = (tip_y - anchor_y) * height
        delta_length = math.hypot(delta_u, delta_v)
        require(delta_length > 1e-5, f"{name} has invalid deciduous anchor metadata")
        u_alignment = delta_u / delta_length
        v_alignment = delta_v / delta_length
        basis_u = axis * u_alignment - across * v_alignment
        basis_v = axis * v_alignment + across * u_alignment
        attachment_v = Vector(attachment)
        local_corners = ((0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0))
        nominal_half_width = float(self.spec["nominalWidthM"]) * 0.498
        nominal_height = float(self.spec["nominalHeightM"])
        vertices = []
        for u, v in local_corners:
            point = (
                attachment_v
                + basis_u * ((u - anchor_x) * width)
                + basis_v * ((v - anchor_y) * height)
            )
            # A shared LOD landmark must never be moved by the later envelope
            # fit. Keep card planes inside the canonical metre envelope while
            # leaving the exact branch/twig attachment unchanged.
            point.x = max(-nominal_half_width, min(nominal_half_width, point.x))
            point.y = max(-nominal_half_width, min(nominal_half_width, point.y))
            point.z = max(0.0, min(nominal_height * 0.996, point.z))
            vertices.append(tuple(point))
        obj = self.add_mesh(
            name,
            vertices,
            [(0, 1, 2, 3)],
            "leaf-deciduous-broadleaf-atlas",
            uv_scale=1.0,
        )
        row, column = divmod(cell, 4)
        size = DECIDUOUS_ATLAS_TEXTURE_BY_LOD[self.lod]
        cell_guard = DECIDUOUS_ATLAS_GUTTER_BY_LOD[self.lod] + 0.5
        pixel_inset = cell_guard / size
        u0 = column / 4.0 + pixel_inset
        u1 = (column + 1) / 4.0 - pixel_inset
        v0 = 1.0 - (row + 1) / 3.0 + pixel_inset
        v1 = 1.0 - row / 3.0 - pixel_inset
        require(u1 > u0 and v1 > v0, f"{name} derived atlas gutter collapses UV cell")
        atlas_uv = ((u0, v0), (u1, v0), (u1, v1), (u0, v1))
        uv_layer = obj.data.uv_layers.active
        for polygon in obj.data.polygons:
            for loop_index in polygon.loop_indices:
                vertex_index = obj.data.loops[loop_index].vertex_index
                uv_layer.data[loop_index].uv = atlas_uv[vertex_index]
        obj["tz_atlas_cell"] = cell
        obj["tz_attachment"] = "branch-or-twig-endpoint"
        obj["tz_independent_cell_gutter_pixels"] = DECIDUOUS_ATLAS_GUTTER_BY_LOD[self.lod]
        self.counters["leafCards"] += 1

    def add_layered_leaf_cluster(
        self,
        name: str,
        center: Sequence[float],
        radii: Sequence[float],
        material_kind: str,
        *,
        card_material_kind: str | None = None,
        card_count: int = 4,
    ) -> None:
        """Build an irregular near crown, not a single geometric canopy blob."""
        center_v = Vector(center)
        rx, ry, rz = radii
        if self.lod == 0:
            # Two offset cores avoid the capsule/box read of one coarse sphere.
            self.add_ellipsoid(
                f"{name}_CoreA", center_v, (rx * 0.78, ry * 0.78, rz * 0.78),
                10, 4, material_kind,
            )
            offset_angle = self.rng.random() * math.tau
            offset = Vector((math.cos(offset_angle) * rx * 0.31, math.sin(offset_angle) * ry * 0.31, self.jitter(rz * 0.18)))
            self.add_ellipsoid(
                f"{name}_CoreB", center_v + offset, (rx * 0.58, ry * 0.62, rz * 0.57),
                8, 3, material_kind,
            )
            for card in range(card_count):
                azimuth = math.tau * card / max(1, card_count) + self.jitter(0.34)
                elevation = self.jitter(0.42)
                outward = Vector((math.cos(azimuth), math.sin(azimuth), elevation)).normalized()
                position = center_v + Vector((outward.x * rx * 0.78, outward.y * ry * 0.78, outward.z * rz * 0.72))
                leaf_length = min(0.32, max(0.11, (rx + ry) * 0.22))
                self.add_leaf(
                    f"{name}_Leaf_{card:02d}", position, outward + Vector((0.0, 0.0, 0.18)),
                    leaf_length, leaf_length * 0.52, card_material_kind or material_kind,
                )
        elif self.lod == 1:
            self.add_ellipsoid(name, center_v, (rx, ry, rz), 7, 3, material_kind)
        else:
            self.add_ellipsoid(name, center_v, (rx, ry, rz), 6, 2, material_kind)

    def add_blade(
        self,
        name: str,
        angle: float,
        length: float,
        width: float,
        height: float,
        segments: int,
        material_kind: str,
        *,
        radial_offset: float = 0.0,
    ) -> None:
        direction = Vector((math.cos(angle), math.sin(angle), 0.0))
        side = Vector((-math.sin(angle), math.cos(angle), 0.0))
        vertices = []
        for index in range(segments + 1):
            t = index / segments
            outward = radial_offset + length * (0.36 * t + 0.64 * t * t)
            z = height * math.sin(t * math.pi * 0.54)
            half_width = width * (1.0 - 0.82 * t) * 0.5
            center = direction * outward + Vector((0.0, 0.0, z))
            fold = Vector((0.0, 0.0, width * 0.08 * math.sin(math.pi * t)))
            vertices.extend((tuple(center - side * half_width), tuple(center + fold), tuple(center + side * half_width)))
        faces = []
        for index in range(segments):
            row = index * 3
            nxt = row + 3
            faces.extend(((row, nxt, nxt + 1, row + 1), (row + 1, nxt + 1, nxt + 2, row + 2)))
        self.add_mesh(name, vertices, faces, material_kind, uv_scale=1.4)
        self.counters["plantBlades"] += 1


def pine_alpha_geometry(builder: Builder) -> None:
    """High-fidelity pine01 proof: real skeleton plus layered atlas sprays."""
    spec = builder.spec
    height = float(spec["nominalHeightM"])
    width = float(spec["nominalWidthM"])
    lod = builder.lod
    trunk_radius = max(0.12, height * 0.026)
    bend = width * 0.018
    trunk_points = (
        [
            (0.0, 0.0, 0.0),
            (builder.jitter(bend), builder.jitter(bend), height * 0.31),
            (builder.jitter(bend), builder.jitter(bend), height * 0.61),
            (builder.jitter(bend * 0.55), builder.jitter(bend * 0.55), height * 0.84),
            (0.0, 0.0, height),
        ]
        if lod == 0
        else [
            (0.0, 0.0, 0.0),
            (builder.jitter(bend), builder.jitter(bend), height * 0.48),
            (builder.jitter(bend * 0.6), builder.jitter(bend * 0.6), height * 0.82),
            (0.0, 0.0, height),
        ]
        if lod == 1
        else [(0.0, 0.0, 0.0), (0.0, 0.0, height)]
    )
    builder.add_polyline(
        "Trunk", trunk_points, trunk_radius, trunk_radius * 0.13,
        (10, 7, 5)[lod], "bark-pine", component="trunkSegments",
    )

    if lod == 2:
        # Honest far silhouette: a visible trunk and sparse layered
        # source-atlas sprays. No cone tiers or fake solid foliage volume.
        for level in range(7):
            fraction = 0.24 + level * 0.105
            reach = width * 0.49 * (1.0 - level * 0.105)
            for radial in range(4):
                angle = level * 1.17 + radial * math.tau / 4
                attachment = Vector((
                    math.cos(angle) * reach * 0.10,
                    math.sin(angle) * reach * 0.10,
                    height * fraction,
                ))
                direction = Vector((
                    math.cos(angle) * 0.80,
                    math.sin(angle) * 0.80,
                    0.34 + level * 0.06,
                )).normalized()
                builder.add_atlas_spray(
                    f"FarSpray_{level:02d}_{radial:02d}", attachment, direction,
                    width * (0.34 - level * 0.020), height * 0.18,
                    (level * 4 + radial * 5) % 12, radial * 0.91 + level * 0.43,
                )
                builder.add_atlas_spray(
                    f"FarSprayLayer_{level:02d}_{radial:02d}", attachment - direction * (height * 0.025),
                    (direction + Vector((0.0, 0.0, 0.07))).normalized(),
                    width * (0.25 - level * 0.013), height * 0.145,
                    (level * 4 + radial * 5 + 5) % 12, radial * 0.91 + level * 0.43 + 1.08,
                )
        return

    level_count = 9 if lod == 0 else 8
    radial_count = 5
    branch_sides = 7 if lod == 0 else 5
    for level in range(level_count):
        fraction = 0.22 + level * (0.63 / max(1, level_count - 1))
        z = height * (fraction + builder.jitter(0.010))
        taper = 1.0 - (fraction - 0.20) * 0.91
        crown_radius = width * 0.50 * taper * (0.94 + builder.jitter(0.07))
        stagger = level * 1.47 + spec["variant"] * 0.31
        for radial in range(radial_count):
            angle = stagger + math.tau * radial / radial_count + builder.jitter(0.12)
            branch_length = crown_radius * (0.88 + builder.jitter(0.10))
            start = Vector((0.0, 0.0, z))
            horizontal = Vector((math.cos(angle), math.sin(angle), 0.0))
            elbow = start + horizontal * (branch_length * 0.36) + Vector((0.0, 0.0, -height * (0.010 + 0.004 * (1.0 - fraction))))
            outer = start + horizontal * (branch_length * 0.73) + Vector((0.0, 0.0, -height * 0.006))
            end = start + horizontal * branch_length + Vector((0.0, 0.0, height * (0.012 + 0.034 * fraction)))
            branch_radius = trunk_radius * (0.19 + 0.11 * (1.0 - fraction))
            builder.add_polyline(
                f"PrimaryBranch_{level:02d}_{radial:02d}", [start, elbow, outer, end],
                branch_radius, branch_radius * 0.11, branch_sides,
                "bark-pine", component="branchSegments",
            )

            spray_sites: list[tuple[Vector, Vector, float]] = []
            terminal_axis = (end - outer).normalized() + Vector((0.0, 0.0, 0.12 + fraction * 0.12))
            spray_sites.append((end, terminal_axis.normalized(), 1.08))
            if lod == 0:
                for twig_index, sign in enumerate((-1.0, 1.0)):
                    attach_t = 0.48 + twig_index * 0.22
                    attach = elbow.lerp(end, attach_t)
                    side_angle = angle + sign * (0.62 + builder.jitter(0.10))
                    twig_length = branch_length * (0.24 - twig_index * 0.025)
                    twig_end = attach + Vector((
                        math.cos(side_angle) * twig_length,
                        math.sin(side_angle) * twig_length,
                        height * (0.035 + builder.jitter(0.012)),
                    ))
                    builder.add_polyline(
                        f"SecondaryTwig_{level:02d}_{radial:02d}_{twig_index}", [attach, twig_end],
                        branch_radius * 0.30, branch_radius * 0.065, 5,
                        "bark-pine", component="branchSegments",
                    )
                    spray_sites.append((twig_end, (twig_end - attach).normalized(), 0.82))
                for primary_index, attach_t in enumerate((0.30, 0.62)):
                    attach = elbow.lerp(end, attach_t)
                    primary_axis = (end - elbow).normalized() + Vector((
                        builder.jitter(0.10), builder.jitter(0.10), 0.16 + primary_index * 0.04,
                    ))
                    spray_sites.append((attach, primary_axis.normalized(), 0.68 + primary_index * 0.06))
            else:
                for mid_index, attach_t in enumerate((0.40, 0.70)):
                    mid_attach = elbow.lerp(end, attach_t)
                    mid_axis = horizontal + Vector((0.0, 0.0, 0.18 + mid_index * 0.05))
                    spray_sites.append((mid_attach, mid_axis.normalized(), 0.78 - mid_index * 0.06))

            for site_index, (attachment, spray_axis, scale) in enumerate(spray_sites):
                card_height = height * (0.142 if lod == 0 else 0.160) * scale
                card_width = card_height * (0.70 + builder.jitter(0.05))
                cell = (level * radial_count * 3 + radial * 3 + site_index + spec["variant"]) % 12
                roll = builder.rng.random() * math.tau
                builder.add_atlas_spray(
                    f"BranchSpray_{level:02d}_{radial:02d}_{site_index:02d}",
                    attachment, spray_axis, card_width, card_height, cell, roll,
                )
                if lod <= 1:
                    # Offset companion card adds needle depth without a crossed
                    # billboard star or a closed geometric foliage blob.
                    companion_axis = (spray_axis + Vector((builder.jitter(0.11), builder.jitter(0.11), 0.08))).normalized()
                    builder.add_atlas_spray(
                        f"BranchSprayLayer_{level:02d}_{radial:02d}",
                        attachment - spray_axis * (card_height * 0.08), companion_axis,
                        card_width * 0.76, card_height * 0.82, (cell + 5) % 12,
                        roll + 1.05 + builder.jitter(0.18),
                    )

    # Break the open-spire read near the leader with short, upward twigs and
    # layered sprays. These are still branch-attached, never floating blobs.
    leader_levels = 3
    leader_radials = 4
    for leader_level in range(leader_levels):
        z = height * (0.79 + leader_level * (0.075 if lod == 0 else 0.10))
        reach = width * (0.18 - leader_level * 0.035)
        for radial in range(leader_radials):
            angle = leader_level * 1.13 + radial * math.tau / leader_radials + builder.jitter(0.14)
            start = Vector((0.0, 0.0, z))
            end = start + Vector((
                math.cos(angle) * reach,
                math.sin(angle) * reach,
                height * (0.070 + leader_level * 0.010),
            ))
            builder.add_polyline(
                f"LeaderTwig_{leader_level:02d}_{radial:02d}", [start, end],
                trunk_radius * 0.13, trunk_radius * 0.035, 5,
                "bark-pine", component="branchSegments",
            )
            card_height = height * (0.135 if lod == 0 else 0.16)
            cell = (8 + leader_level * leader_radials + radial) % 12
            roll = builder.rng.random() * math.tau
            builder.add_atlas_spray(
                f"LeaderSpray_{leader_level:02d}_{radial:02d}", end, (end - start).normalized(),
                card_height * 0.72, card_height, cell, roll,
            )
            if lod <= 1:
                builder.add_atlas_spray(
                    f"LeaderSprayLayer_{leader_level:02d}_{radial:02d}", end,
                    ((end - start).normalized() + Vector((0.0, 0.0, 0.08))).normalized(),
                    card_height * 0.55, card_height * 0.82, (cell + 4) % 12, roll + 1.03,
                )


def pine_geometry(builder: Builder) -> None:
    spec = builder.spec
    height = float(spec["nominalHeightM"])
    width = float(spec["nominalWidthM"])
    lod = builder.lod
    trunk_sides = (10, 7, 5)[lod]
    trunk_radius = max(0.12, height * 0.026)
    bend = width * 0.018
    trunk_points = [
        (0.0, 0.0, 0.0),
        (builder.jitter(bend), builder.jitter(bend), height * 0.38),
        (builder.jitter(bend), builder.jitter(bend), height * 0.72),
        (0.0, 0.0, height),
    ] if lod < 2 else [(0.0, 0.0, 0.0), (0.0, 0.0, height)]
    builder.add_polyline("Trunk", trunk_points, trunk_radius, trunk_radius * 0.16, trunk_sides, "bark-pine", component="trunkSegments")

    if lod == 2:
        for index, (z0, z1, radius) in enumerate((
            (height * 0.25, height * 0.68, width * 0.52),
            (height * 0.48, height * 0.84, width * 0.38),
            (height * 0.67, height * 0.99, width * 0.23),
        )):
            builder.add_cone(f"NeedleTier_{index:02d}", (0.0, 0.0, z0), (0.0, 0.0, z1), radius, 6, "needle-pine")
        return

    level_count = 8 if lod == 0 else 5
    radial_count = 5 if lod == 0 else 4
    branch_sides = 7 if lod == 0 else 5
    for level in range(level_count):
        fraction = 0.22 + level * (0.60 / max(1, level_count - 1))
        z = height * fraction
        crown_radius = width * 0.50 * (1.0 - (fraction - 0.20) * 0.92)
        crown_radius *= 0.94 + builder.jitter(0.07)
        stagger = level * 1.71 + builder.spec["variant"] * 0.27
        for radial in range(radial_count):
            angle = stagger + math.tau * radial / radial_count + builder.jitter(0.11)
            length = crown_radius * (0.82 + builder.jitter(0.12))
            start = Vector((0.0, 0.0, z))
            mid = Vector((math.cos(angle) * length * 0.58, math.sin(angle) * length * 0.58, z - height * 0.018))
            end = Vector((math.cos(angle) * length, math.sin(angle) * length, z + height * (0.012 + builder.jitter(0.014))))
            points = [start, mid, end] if lod == 0 else [start, end]
            radius = trunk_radius * (0.28 + 0.16 * (1.0 - fraction))
            builder.add_polyline(
                f"Branch_{level:02d}_{radial:02d}", points, radius, radius * 0.22, branch_sides,
                "bark-pine", component="branchSegments",
            )
            cluster_count = 3 if lod == 0 else 1
            for cluster in range(cluster_count):
                t0 = 0.38 + cluster * (0.52 / max(1, cluster_count - 1))
                base = start.lerp(end, min(0.88, t0)) + Vector((0.0, 0.0, -height * 0.015))
                tip = start.lerp(end, min(1.0, t0 + 0.26)) + Vector((0.0, 0.0, height * 0.045))
                if lod == 0:
                    tuft_axis = tip - base
                    tuft_center = (base + tip) * 0.5
                    builder.add_ellipsoid(
                        f"NeedleSpray_{level:02d}_{radial:02d}_{cluster:02d}", tuft_center,
                        (width * 0.060, width * 0.048, max(width * 0.075, tuft_axis.length * 0.58)),
                        8, 3, "needle-pine", axis=tuft_axis,
                    )
                    for needle_card in range(2):
                        card_axis = tuft_axis.normalized() + Vector((
                            builder.jitter(0.18), builder.jitter(0.18), builder.jitter(0.12),
                        ))
                        builder.add_leaf(
                            f"NeedleCard_{level:02d}_{radial:02d}_{cluster:02d}_{needle_card}",
                            tuft_center + Vector((
                                builder.jitter(width * 0.025),
                                builder.jitter(width * 0.025),
                                builder.jitter(width * 0.018),
                            )),
                            card_axis,
                            min(0.58, max(0.24, tuft_axis.length * 0.92)),
                            width * 0.12,
                            "needle-pine-card",
                        )
                else:
                    builder.add_cone(
                        f"NeedleSpray_{level:02d}_{radial:02d}_{cluster:02d}", base, tip,
                        width * 0.12, 5, "needle-pine",
                    )


def deciduous_alpha_geometry(builder: Builder) -> None:
    """Round-crown tree02 proof with keyed, nested LOD layout continuity."""
    spec = builder.spec
    height = float(spec["nominalHeightM"])
    width = float(spec["nominalWidthM"])
    lod = builder.lod
    trunk_radius = max(0.13, height * 0.034)
    bend = width * 0.022

    def rng_for(label: str) -> random.Random:
        return random.Random(stable_seed(builder.seed, f"{spec['name']}:deciduous-alpha:{label}"))

    def jitter(source: random.Random, amount: float) -> float:
        return source.uniform(-amount, amount)

    def rounded_vector(value: Vector) -> list[float]:
        return [round(float(component), 6) for component in value]

    continuity: dict[str, list[float]] = {}

    def mark(key: str, value: Vector) -> None:
        continuity[key] = rounded_vector(value)

    trunk_rng = rng_for("trunk")
    full_trunk = [
        Vector((0.0, 0.0, 0.0)),
        Vector((0.0, 0.0, height * 0.20)),
        Vector((jitter(trunk_rng, bend), jitter(trunk_rng, bend * 0.80), height * 0.39)),
        Vector((jitter(trunk_rng, bend * 0.80), jitter(trunk_rng, bend), height * 0.52)),
        Vector((jitter(trunk_rng, bend * 0.42), jitter(trunk_rng, bend * 0.42), height * 0.64)),
    ]
    trunk_indices = ((0, 1, 2, 3, 4), (0, 1, 2, 4), (0, 1, 4))[lod]
    trunk_points = [full_trunk[index] for index in trunk_indices]
    for index in trunk_indices:
        mark(f"trunk:{index}", full_trunk[index])
    builder.add_polyline(
        "Trunk", trunk_points, trunk_radius, trunk_radius * 0.20,
        (10, 7, 5)[lod], "bark-broadleaf", component="trunkSegments",
    )

    if lod == 0:
        for root_index, base_angle in enumerate((0.18, 1.72, 3.58, 5.24)):
            root_rng = rng_for(f"root:{root_index}")
            angle = base_angle + jitter(root_rng, 0.16)
            direction = Vector((math.cos(angle), math.sin(angle), 0.0))
            side = Vector((-direction.y, direction.x, 0.0))
            inner = direction * trunk_radius * 0.46
            outer = direction * trunk_radius * (2.25 + root_rng.random() * 0.48)
            inner_half = trunk_radius * 0.48
            outer_half = trunk_radius * 0.22
            vertices = [
                tuple(inner - side * inner_half),
                tuple(inner + side * inner_half),
                tuple(inner + side * inner_half * 0.72 + Vector((0.0, 0.0, trunk_radius * 1.45))),
                tuple(inner - side * inner_half * 0.72 + Vector((0.0, 0.0, trunk_radius * 1.45))),
                tuple(outer - side * outer_half),
                tuple(outer + side * outer_half),
                tuple(outer + side * outer_half * 0.58 + Vector((0.0, 0.0, trunk_radius * 0.16))),
                tuple(outer - side * outer_half * 0.58 + Vector((0.0, 0.0, trunk_radius * 0.16))),
            ]
            faces = (
                (0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1),
                (3, 2, 6, 7), (1, 5, 6, 2), (0, 3, 7, 4),
            )
            builder.add_mesh(f"RootFlare_{root_index:02d}", vertices, faces, "bark-broadleaf", uv_scale=0.54)
            builder.counters["rootFlares"] += 1

    def trunk_center(z_fraction: float) -> Vector:
        target_z = height * z_fraction
        for start, end in zip(full_trunk, full_trunk[1:]):
            if target_z <= end.z:
                span = max(1e-6, end.z - start.z)
                return start.lerp(end, (target_z - start.z) / span)
        return full_trunk[-1].copy()

    spray_sites: list[tuple[str, Vector, Vector, float, int, bool]] = []
    golden_angle = math.pi * (3.0 - math.sqrt(5.0))
    scaffold_azimuths = (0.12, 0.46, 1.31, 1.79, 2.16, 3.02, 3.34, 3.76, 4.55, 5.04, 5.49, 5.91)
    scaffold_bend_signs = (1, -1, 1, 1, -1, -1, 1, -1, -1, 1, -1, 1)
    scaffold_indices = (
        tuple(range(12)),
        (0, 2, 3, 5, 6, 8, 9, 11),
        (0, 2, 3, 5, 6, 8, 9, 11),
    )[lod]
    branch_sides = (7, 5, 4)[lod]
    scaffold_parents = (None, 0, None, 2, 2, None, 5, 5, None, 8, 8, 8)
    scaffold_records: dict[int, dict[str, object]] = {}
    for index in range(12):
        branch_rng = rng_for(f"scaffold:{index}")
        angle = scaffold_azimuths[index] + jitter(branch_rng, 0.18)
        parent_index = scaffold_parents[index]
        if parent_index is None:
            start_fraction = 0.27 + branch_rng.random() * 0.18 + jitter(branch_rng, 0.012)
            start = trunk_center(start_fraction)
            reach = width * (0.27 + branch_rng.random() * 0.12)
            crown_fraction = 0.54 + branch_rng.random() * 0.24 + jitter(branch_rng, 0.018)
            end_z = min(height * 0.79, height * crown_fraction)
        else:
            parent = scaffold_records[parent_index]
            parent_elbow = parent["elbow"]
            parent_shoulder = parent["shoulder"]
            require(
                isinstance(parent_elbow, Vector) and isinstance(parent_shoulder, Vector),
                "scaffold parent record is invalid",
            )
            start = parent_elbow.lerp(parent_shoulder, 0.54 + branch_rng.random() * 0.30)
            start_fraction = start.z / height
            reach = width * (0.15 + branch_rng.random() * 0.095)
            target_z = height * (0.62 + branch_rng.random() * 0.25 + jitter(branch_rng, 0.014))
            end_z = min(height * 0.91, max(target_z, start.z + height * (0.075 + branch_rng.random() * 0.075)))
        if index in (0, 8):
            reach *= 1.06 if index == 0 else 1.04
        direction = Vector((math.cos(angle), math.sin(angle), 0.0))
        bend_angle = scaffold_bend_signs[index] * (0.22 + branch_rng.random() * 0.34)
        curve_angle = angle + bend_angle * 0.64
        tip_angle = angle + bend_angle
        curve = Vector((math.cos(curve_angle), math.sin(curve_angle), 0.0))
        tip_direction = Vector((math.cos(tip_angle), math.sin(tip_angle), 0.0))
        elbow = start + direction * (reach * 0.36) + Vector((0.0, 0.0, (end_z - start.z) * 0.36))
        shoulder = start + curve * (reach * 0.72) + Vector((0.0, 0.0, (end_z - start.z) * 0.70))
        end = start + tip_direction * reach + Vector((0.0, 0.0, end_z - start.z))
        scaffold_records[index] = {
            "rng": branch_rng,
            "angle": angle,
            "startFraction": start_fraction,
            "start": start,
            "reach": reach,
            "elbow": elbow,
            "shoulder": shoulder,
            "end": end,
            "parent": parent_index,
        }

    for index in scaffold_indices:
        record = scaffold_records[index]
        branch_rng = record["rng"]
        angle = record["angle"]
        start_fraction = record["startFraction"]
        start = record["start"]
        reach = record["reach"]
        elbow = record["elbow"]
        shoulder = record["shoulder"]
        end = record["end"]
        require(
            isinstance(branch_rng, random.Random)
            and all(isinstance(value, (int, float)) for value in (angle, start_fraction, reach))
            and all(isinstance(value, Vector) for value in (start, elbow, shoulder, end)),
            "scaffold record is invalid",
        )
        mark(f"scaffold:{index}:start", start)
        mark(f"scaffold:{index}:shoulder", shoulder)
        mark(f"scaffold:{index}:end", end)
        branch_points = [start, elbow, shoulder, end] if lod == 0 else [start, shoulder, end] if lod == 1 else [start, end]
        branch_radius = trunk_radius * (
            (0.27 + 0.055 * (1.0 - start_fraction))
            if record["parent"] is None
            else (0.15 + 0.025 * (1.0 - start_fraction))
        )
        builder.add_polyline(
            f"Scaffold_{index:02d}", branch_points, branch_radius, branch_radius * 0.10,
            branch_sides, "bark-broadleaf", component="branchSegments",
        )
        terminal_axis = (
            (end - shoulder).normalized()
            + Vector((0.0, 0.0, 0.12 + branch_rng.random() * 0.12))
        ).normalized()
        spray_sites.append((f"scaffold:{index}:terminal", end, terminal_axis, 1.08 + jitter(branch_rng, 0.08), 2, False))
        shoulder_axis = (
            (end - elbow).normalized()
            + Vector((jitter(branch_rng, 0.12), jitter(branch_rng, 0.12), 0.16 + branch_rng.random() * 0.09))
        ).normalized()
        spray_sites.append((f"scaffold:{index}:shoulder", shoulder, shoulder_axis, 0.72 + jitter(branch_rng, 0.05), 2, False))

        inner_sign = -1.0 if index % 2 else 1.0
        inner_angle = angle + inner_sign * (0.72 + branch_rng.random() * 0.46)
        inner_axis = Vector((
            math.cos(inner_angle), math.sin(inner_angle), 0.34 + branch_rng.random() * 0.26,
        )).normalized()
        inner_end = elbow + inner_axis * width * (0.10 + branch_rng.random() * 0.055)
        mark(f"scaffold:{index}:inner", inner_end)
        builder.add_polyline(
            f"InteriorTwig_{index:02d}", [elbow, inner_end], branch_radius * 0.20,
            branch_radius * 0.035, (5, 4, 4)[lod], "bark-broadleaf", component="branchSegments",
        )
        spray_sites.append((f"scaffold:{index}:inner", inner_end, inner_axis, 0.62 + jitter(branch_rng, 0.045), 2, False))

        secondary_indices = ((0, 1), (0,), ())[lod]
        for secondary in secondary_indices:
            secondary_rng = rng_for(f"scaffold:{index}:secondary:{secondary}")
            attach_t = 0.47 + secondary * 0.23 + jitter(secondary_rng, 0.035)
            attach = elbow.lerp(end, attach_t)
            sign = -1.0 if (index + secondary) % 2 else 1.0
            fork_angle = angle + sign * (0.58 + secondary_rng.random() * 0.38)
            fork_length = reach * (0.31 - secondary * 0.045 + jitter(secondary_rng, 0.025))
            fork_axis = Vector((
                math.cos(fork_angle), math.sin(fork_angle), 0.24 + secondary_rng.random() * 0.22,
            )).normalized()
            fork_end = attach + fork_axis * fork_length
            fork_end.z = min(height * 0.91, fork_end.z)
            mark(f"scaffold:{index}:secondary:{secondary}", fork_end)
            secondary_mid = attach.lerp(fork_end, 0.54) + Vector((0.0, 0.0, height * jitter(secondary_rng, 0.012)))
            builder.add_polyline(
                f"Secondary_{index:02d}_{secondary:02d}",
                [attach, secondary_mid, fork_end] if lod == 0 else [attach, fork_end],
                branch_radius * 0.31, branch_radius * 0.045, (5, 4, 4)[lod],
                "bark-broadleaf", component="branchSegments",
            )
            spray_sites.append((
                f"scaffold:{index}:secondary:{secondary}", fork_end, fork_axis,
                0.84 + jitter(secondary_rng, 0.07), 2, False,
            ))

    core_indices = (
        tuple(range(9)),
        (0, 1, 3, 4, 6, 8),
        (0, 6),
    )[lod]
    for core_index in core_indices:
        core_rng = rng_for(f"core:{core_index}")
        start_fraction = 0.43 + 0.040 * (core_index % 4) + jitter(core_rng, 0.012)
        start = trunk_center(start_fraction)
        angle = core_rng.random() * math.tau + core_index * golden_angle * 0.37
        reach = width * (0.075 + core_rng.random() * 0.105)
        end = Vector((
            start.x + math.cos(angle) * reach,
            start.y + math.sin(angle) * reach,
            height * (0.60 + core_rng.random() * 0.19),
        ))
        curve_angle = angle + jitter(core_rng, 0.75)
        mid = start.lerp(end, 0.55) + Vector((
            math.cos(curve_angle) * reach * 0.16,
            math.sin(curve_angle) * reach * 0.16,
            height * jitter(core_rng, 0.012),
        ))
        mark(f"core:{core_index}:end", end)
        builder.add_polyline(
            f"CoreTwig_{core_index:02d}", [start, mid, end] if lod < 2 else [start, end],
            trunk_radius * (0.17 + core_rng.random() * 0.055), trunk_radius * 0.035,
            (5, 4, 4)[lod], "bark-broadleaf", component="branchSegments",
        )
        spray_sites.append((
            f"core:{core_index}", end, (end - mid).normalized(),
            0.73 + jitter(core_rng, 0.06), 2, False,
        ))
        cap_angle = angle + 0.51 + jitter(core_rng, 0.34)
        cap_axis = Vector((math.cos(cap_angle), math.sin(cap_angle), 0.055)).normalized()
        cap_end = end + cap_axis * width * (0.045 + core_rng.random() * 0.025)
        mark(f"core:{core_index}:cap", cap_end)
        builder.add_polyline(
            f"CoreCapTwig_{core_index:02d}", [end, cap_end], trunk_radius * 0.075,
            trunk_radius * 0.020, 4, "bark-broadleaf", component="branchSegments",
        )
        spray_sites.append((
            f"core:{core_index}:cap", cap_end, cap_axis,
            0.78 + jitter(core_rng, 0.045), 2, True,
        ))

    leader_indices = ((0, 1, 2, 3), (0, 1, 2), (0, 1, 2))[lod]
    for leader in leader_indices:
        leader_rng = rng_for(f"leader:{leader}")
        angle = 0.82 + leader * golden_angle + jitter(leader_rng, 0.35)
        start = trunk_center(0.51 + 0.035 * (leader % 3))
        reach = width * (0.18 + leader_rng.random() * 0.12)
        end = Vector((
            start.x + math.cos(angle) * reach,
            start.y + math.sin(angle) * reach,
            min(height * 0.91, height * (0.82 + 0.040 * (leader % 3) + jitter(leader_rng, 0.012))),
        ))
        mid = start.lerp(end, 0.55) + Vector((
            math.cos(angle + 0.65) * reach * 0.09,
            math.sin(angle + 0.65) * reach * 0.09,
            0.0,
        ))
        mark(f"leader:{leader}:end", end)
        builder.add_polyline(
            f"Leader_{leader:02d}", [start, mid, end] if lod < 2 else [start, end],
            trunk_radius * (0.23 if leader < 2 else 0.18), trunk_radius * 0.04,
            (6, 5, 4)[lod], "bark-broadleaf", component="branchSegments",
        )
        spray_sites.append((f"leader:{leader}", end, (end - mid).normalized(), 0.92, 2, False))

    apex_rng = rng_for("apex")
    apex_angle = 1.13 + jitter(apex_rng, 0.23)
    apex_xy = Vector((math.cos(apex_angle) * width * 0.065, math.sin(apex_angle) * width * 0.065, 0.0))
    apex_start = trunk_center(0.56)
    apex_curve = Vector((apex_xy.x * 0.62, apex_xy.y * 0.62, height * 0.77))
    apex_near = Vector((apex_xy.x, apex_xy.y, height * 0.90))
    apex_end = Vector((apex_xy.x, apex_xy.y, height))
    mark("apex:near", apex_near)
    mark("apex:end", apex_end)
    apex_points = [apex_start, apex_curve, apex_near, apex_end] if lod == 0 else [apex_start, apex_near, apex_end]
    builder.add_polyline(
        "ApexLeader", apex_points, trunk_radius * 0.16, trunk_radius * 0.018,
        (6, 5, 4)[lod], "bark-broadleaf", component="branchSegments",
    )
    apex_side_axis = Vector((math.cos(apex_angle + 1.02), math.sin(apex_angle + 1.02), 0.08)).normalized()
    apex_spray_end = apex_near + apex_side_axis * width * 0.075
    mark("apex:spray", apex_spray_end)
    builder.add_polyline(
        "ApexSprayTwig", [apex_near, apex_spray_end], trunk_radius * 0.07,
        trunk_radius * 0.018, 4, "bark-broadleaf", component="branchSegments",
    )
    spray_sites.append(("apex:spray", apex_spray_end, apex_side_axis, 0.79, 2, True))

    # Physical card area is bounded per LOD by the offline surface-load gate;
    # lower LODs retain occupied crown shape through nested sites, not giant
    # replacement planes that inflate overdraw.
    base_card_height = height * (0.163, 0.201, 0.229)[lod]
    for site_index, (site_key, attachment, axis, scale, layers, top_facing) in enumerate(spray_sites):
        shape_rng = rng_for(f"card:{site_key}:shape")
        card_height = base_card_height * scale
        card_width = card_height * (0.80 + jitter(shape_rng, 0.055))
        base_roll = jitter(shape_rng, 0.10) if top_facing else shape_rng.random() * math.tau
        for layer in range(layers):
            layer_rng = rng_for(f"card:{site_key}:layer:{layer}")
            if layer == 0:
                layer_axis = axis
                layer_attachment = attachment
            else:
                perturbation = Vector((
                    jitter(layer_rng, 0.19), jitter(layer_rng, 0.19), 0.06 + layer_rng.random() * 0.12,
                ))
                layer_axis = (axis + perturbation).normalized()
                _, layer_side, _ = builder.basis(axis)
                layer_attachment = (
                    attachment
                    - axis * (card_height * (0.045 + layer * 0.018))
                    + layer_side * jitter(layer_rng, card_width * 0.075)
                )
            builder.add_deciduous_atlas_spray(
                f"CrownSpray_{site_index:03d}_{layer:02d}", layer_attachment, layer_axis,
                card_width * (1.0 - layer * 0.10), card_height * (1.0 - layer * 0.085),
                DECIDUOUS_PROOF_CELL_CHOICES[
                    layer_rng.randrange(len(DECIDUOUS_PROOF_CELL_CHOICES))
                ],
                base_roll + layer * (0.83 + jitter(layer_rng, 0.16)),
            )

    builder.continuity_landmarks = dict(sorted(continuity.items()))
    continuity_payload = json.dumps(builder.continuity_landmarks, sort_keys=True, separators=(",", ":")).encode("utf-8")
    builder.root["tz_continuity_contract"] = "keyed-nested-landmarks-v1"
    builder.root["tz_continuity_landmarks_sha256"] = f"sha256:{hashlib.sha256(continuity_payload).hexdigest()}"


def deciduous_geometry(builder: Builder, *, birch: bool) -> None:
    spec = builder.spec
    height = float(spec["nominalHeightM"])
    width = float(spec["nominalWidthM"])
    lod = builder.lod
    bark = "bark-birch" if birch else "bark-broadleaf"
    leaf = "leaf-birch" if birch else "leaf-broadleaf"
    trunk_radius = height * (0.022 if birch else 0.031)
    bend = width * (0.032 if birch else 0.021)
    trunk_top = height * (0.78 if birch else 0.68)
    trunk_points = [
        (0.0, 0.0, 0.0),
        (builder.jitter(bend), builder.jitter(bend), height * 0.34),
        (builder.jitter(bend), builder.jitter(bend), height * 0.58),
        (builder.jitter(bend * 0.55), builder.jitter(bend * 0.55), trunk_top),
    ] if lod < 2 else [(0.0, 0.0, 0.0), (builder.jitter(bend), 0.0, trunk_top)]
    builder.add_polyline(
        "Trunk", trunk_points, trunk_radius, trunk_radius * 0.28,
        (10, 7, 5)[lod], bark, component="trunkSegments",
    )

    scaffold_count = (6 if birch else 5, 3, 2)[lod]
    endpoints: list[Vector] = []
    for index in range(scaffold_count):
        angle = math.tau * index / scaffold_count + spec["variant"] * 0.41 + builder.jitter(0.25)
        start_z = height * ((0.42 if birch else 0.34) + 0.055 * (index % 3))
        reach = width * ((0.38 if birch else 0.44) + builder.jitter(0.06))
        rise = height * ((0.25 if birch else 0.30) + builder.jitter(0.055))
        start = Vector((0.0, 0.0, start_z))
        elbow = Vector((math.cos(angle) * reach * 0.48, math.sin(angle) * reach * 0.48, start_z + rise * 0.54))
        end = Vector((math.cos(angle) * reach, math.sin(angle) * reach, min(height * 0.90, start_z + rise)))
        points = [start, elbow, end] if lod == 0 else [start, end]
        builder.add_polyline(
            f"Scaffold_{index:02d}", points, trunk_radius * 0.55, trunk_radius * 0.14,
            (7, 5, 4)[lod], bark, component="branchSegments",
        )
        endpoints.append(end)
        if lod == 0:
            for secondary in (-1, 1):
                side_angle = angle + secondary * (0.52 + builder.jitter(0.12))
                sec_end = end + Vector((
                    math.cos(side_angle) * width * 0.18,
                    math.sin(side_angle) * width * 0.18,
                    height * (0.075 + builder.jitter(0.025)),
                ))
                sec_end.z = min(sec_end.z, height * 0.89)
                builder.add_polyline(
                    f"Twig_{index:02d}_{secondary:+d}", [elbow, sec_end],
                    trunk_radius * 0.21, trunk_radius * 0.055, 5, bark, component="branchSegments",
                )
                endpoints.append(sec_end)

    cluster_count = (24 if birch else 28, 10 if birch else 12, 4)[lod]
    for index in range(cluster_count):
        angle = math.tau * (index / cluster_count) + builder.jitter(0.36)
        if index % (5 if birch else 4) == 0:
            # Fill the crown interior so the scaffold does not read as a broom.
            radial = width * (0.06 + builder.rng.random() * (0.17 if birch else 0.22))
            center = Vector((
                math.cos(angle) * radial,
                math.sin(angle) * radial,
                height * ((0.69 if birch else 0.66) + builder.rng.random() * 0.19),
            ))
        else:
            anchor = endpoints[index % len(endpoints)]
            radial = width * (0.05 + builder.rng.random() * (0.13 if birch else 0.16))
            center = anchor + Vector((
                math.cos(angle) * radial,
                math.sin(angle) * radial,
                height * builder.jitter(0.045),
            ))
        rz = height * ((0.052 if birch else 0.064) * (1.0 + builder.jitter(0.16)))
        center.z = max(height * 0.52, min(height - rz - 0.015, center.z))
        rx = width * ((0.105 if birch else 0.125) * (1.0 + builder.jitter(0.18)))
        ry = rx * (0.72 + builder.rng.random() * 0.34)
        builder.add_layered_leaf_cluster(
            f"LeafCluster_{index:02d}", center, (rx, ry, rz),
            leaf, card_material_kind=f"{leaf}-card", card_count=5 if birch else 6,
        )


def shrub_geometry(builder: Builder) -> None:
    spec = builder.spec
    height = float(spec["nominalHeightM"])
    width = float(spec["nominalWidthM"])
    lod = builder.lod
    dry = bool(spec["dry"])
    leaf = "leaf-dry" if dry else "leaf-shrub"
    stem_count = (10, 6, 3)[lod]
    stem_ends: list[Vector] = []
    for index in range(stem_count):
        angle = math.tau * index / stem_count + spec["variant"] * 0.31 + builder.jitter(0.24)
        radial = width * (0.26 + builder.rng.random() * 0.20)
        end_z = height * (0.70 + builder.rng.random() * 0.26)
        start = Vector((0.0, 0.0, 0.035))
        elbow = Vector((math.cos(angle) * radial * 0.48, math.sin(angle) * radial * 0.48, end_z * 0.53))
        end = Vector((math.cos(angle) * radial, math.sin(angle) * radial, end_z))
        points = [start, elbow, end] if lod < 2 else [start, end]
        base_radius = max(0.014, height * (0.012 if dry else 0.016))
        builder.add_polyline(
            f"Stem_{index:02d}", points, base_radius, base_radius * 0.28,
            (6, 5, 4)[lod], "twig", component="branchSegments",
        )
        stem_ends.append(end)
        if lod == 0:
            fork_angle = angle + (-1 if index % 2 else 1) * (0.42 + builder.jitter(0.15))
            fork_end = elbow + Vector((
                math.cos(fork_angle) * width * 0.20,
                math.sin(fork_angle) * width * 0.20,
                height * (0.23 + builder.jitter(0.04)),
            ))
            builder.add_polyline(
                f"StemFork_{index:02d}", [elbow, fork_end], base_radius * 0.58, base_radius * 0.18,
                5, "twig", component="branchSegments",
            )
            stem_ends.append(fork_end)

    cluster_target = (20, 9, 3)[lod]
    if dry:
        cluster_target = max(1, int(cluster_target * (0.42 if spec["form"] == "dry-brush" else 0.60)))
    for index in range(cluster_target):
        end = stem_ends[index % len(stem_ends)]
        center = end + Vector((builder.jitter(width * 0.08), builder.jitter(width * 0.08), builder.jitter(height * 0.055)))
        rz = height * (0.11 if dry else 0.14)
        center.z = min(height - rz * 0.92, max(rz, center.z))
        rx = width * (0.105 if dry else 0.135) * (1.0 + builder.jitter(0.18))
        builder.add_layered_leaf_cluster(
            f"ShrubCluster_{index:02d}", center, (rx, rx * 0.78, rz),
            leaf, card_material_kind=f"{leaf}-card", card_count=2 if dry else 4,
        )


def root_flare(builder: Builder, name: str, angle: float, radius: float, length: float, height: float) -> None:
    direction = Vector((math.cos(angle), math.sin(angle), 0.0))
    side = Vector((-math.sin(angle), math.cos(angle), 0.0))
    start = direction * radius * 0.50
    end = direction * length
    vertices = [
        tuple(start - side * radius * 0.34),
        tuple(start + side * radius * 0.34),
        tuple(start - side * radius * 0.22 + Vector((0.0, 0.0, height))),
        tuple(start + side * radius * 0.22 + Vector((0.0, 0.0, height))),
        tuple(end - side * radius * 0.08),
        tuple(end + side * radius * 0.08),
        tuple(end + Vector((0.0, 0.0, height * 0.08))),
    ]
    faces = [(0, 1, 3, 2), (0, 4, 5, 1), (2, 3, 6), (0, 2, 6, 4), (1, 5, 6, 3), (4, 6, 5)]
    builder.add_mesh(name, vertices, faces, "bark-broadleaf", uv_scale=0.62)
    builder.counters["rootFlares"] += 1


def stump_geometry(builder: Builder) -> None:
    spec = builder.spec
    height = float(spec["nominalHeightM"])
    width = float(spec["nominalWidthM"])
    lod = builder.lod
    sides = (14, 9, 6)[lod]
    radius = width * 0.50
    rng = builder.rng
    bottom = []
    upper = []
    for index in range(sides):
        angle = math.tau * index / sides
        r0 = radius * (0.96 + rng.uniform(-0.065, 0.065))
        r1 = radius * (0.78 + rng.uniform(-0.055, 0.055))
        bottom.append((math.cos(angle) * r0, math.sin(angle) * r0, 0.0))
        jagged = height * (0.91 + (rng.uniform(-0.045, 0.055) if lod == 0 else 0.0))
        upper.append((math.cos(angle) * r1, math.sin(angle) * r1, jagged))
    vertices = bottom + upper
    faces = []
    for index in range(sides):
        nxt = (index + 1) % sides
        faces.append((index, nxt, sides + nxt, sides + index))
    faces.append(tuple(reversed(range(sides))))
    builder.add_mesh("StumpBark", vertices, faces, "bark-broadleaf", uv_scale=0.78)
    top_center = len(upper)
    top_vertices = [(0.0, 0.0, sum(v[2] for v in upper) / sides)] + upper
    top_faces = [(0, 1 + index, 1 + ((index + 1) % sides)) for index in range(sides)]
    builder.add_mesh("CutFace", top_vertices, top_faces, "cut-wood", uv_scale=1.15)

    flare_count = (6, 3, 0)[lod]
    for index in range(flare_count):
        root_flare(
            builder, f"RootFlare_{index:02d}",
            math.tau * index / max(1, flare_count) + spec["variant"] * 0.23,
            radius, radius * (1.55 + builder.jitter(0.18)), height * 0.32,
        )
    if lod == 0 and spec["variant"] >= 3:
        start = (radius * 0.12, -radius * 0.05, height * 0.70)
        end = (radius * 0.62, radius * 0.10, height * 1.0)
        builder.add_frustum("BrokenSnag", start, end, radius * 0.17, radius * 0.055, 6, "bark-broadleaf", component="branchSegments")
    if lod == 0:
        for index in range(3):
            angle = math.tau * index / 3 + 0.4
            center = (math.cos(angle) * radius * 0.72, math.sin(angle) * radius * 0.72, height * 0.18)
            builder.add_ellipsoid(f"MossPatch_{index}", center, (radius * 0.18, radius * 0.10, height * 0.07), 6, 1, "moss")


def grass_geometry(builder: Builder, material: str) -> None:
    height = float(builder.spec["nominalHeightM"])
    width = float(builder.spec["nominalWidthM"])
    count = (20, 10, 4)[builder.lod]
    segments = (4, 2, 1)[builder.lod]
    for index in range(count):
        angle = math.tau * index / count + builder.spec["variant"] * 0.19 + builder.jitter(0.18)
        blade_height = height * (0.62 + builder.rng.random() * 0.38)
        builder.add_blade(
            f"GrassBlade_{index:02d}", angle,
            width * (0.24 + builder.rng.random() * 0.20),
            width * (0.035 + builder.rng.random() * 0.025),
            blade_height, segments, material,
            radial_offset=width * builder.rng.random() * 0.12,
        )


def fern_geometry(builder: Builder, material: str) -> None:
    height = float(builder.spec["nominalHeightM"])
    width = float(builder.spec["nominalWidthM"])
    fronds = (9, 5, 3)[builder.lod]
    blade_segments = (4, 2, 1)[builder.lod]
    leaflet_pairs = (6, 3, 0)[builder.lod]
    for index in range(fronds):
        angle = math.tau * index / fronds + builder.spec["variant"] * 0.28 + builder.jitter(0.16)
        frond_length = width * (0.50 + builder.rng.random() * 0.36)
        frond_height = height * (0.72 + builder.rng.random() * 0.28)
        builder.add_blade(
            f"FernRachis_{index:02d}", angle, frond_length, width * 0.055,
            frond_height, blade_segments, material,
        )
        direction = Vector((math.cos(angle), math.sin(angle), 0.0))
        side = Vector((-math.sin(angle), math.cos(angle), 0.0))
        for pair in range(leaflet_pairs):
            t = 0.20 + pair * (0.66 / max(1, leaflet_pairs - 1))
            center = direction * (frond_length * t) + Vector((0.0, 0.0, frond_height * math.sin(t * math.pi * 0.54)))
            leaflet_length = width * 0.20 * (1.0 - 0.48 * t)
            for sign in (-1, 1):
                leaf_dir = (direction * 0.28 + side * sign + Vector((0.0, 0.0, 0.12))).normalized()
                builder.add_leaf(
                    f"FernLeaflet_{index:02d}_{pair:02d}_{sign:+d}", center,
                    leaf_dir, leaflet_length, leaflet_length * 0.34, material,
                )


def rosette_geometry(builder: Builder, material: str) -> None:
    height = float(builder.spec["nominalHeightM"])
    width = float(builder.spec["nominalWidthM"])
    leaves = (13, 7, 4)[builder.lod]
    segments = (4, 2, 1)[builder.lod]
    for index in range(leaves):
        angle = math.tau * index / leaves + builder.spec["variant"] * 0.37 + builder.jitter(0.13)
        builder.add_blade(
            f"RosetteLeaf_{index:02d}", angle,
            width * (0.46 + builder.rng.random() * 0.22),
            width * (0.14 + builder.rng.random() * 0.06),
            height * (0.62 + builder.rng.random() * 0.38),
            segments, material,
        )
    if builder.lod == 0:
        builder.add_frustum(
            "RosetteStem", (0.0, 0.0, 0.02), (0.0, 0.0, height * 0.83),
            width * 0.025, width * 0.012, 6, "twig", component="branchSegments",
        )
        builder.add_ellipsoid("RosetteSeedHead", (0.0, 0.0, height * 0.90), (width * 0.052, width * 0.052, height * 0.075), 10, 4, material)


def ground_plant_geometry(builder: Builder) -> None:
    material = "ground-dry" if builder.spec["dry"] else "ground-green"
    form = builder.spec["form"]
    if form == "dry-grass":
        grass_geometry(builder, material)
    elif form == "fern":
        fern_geometry(builder, material)
    elif form == "broadleaf-rosette":
        rosette_geometry(builder, material)
    else:
        raise ValueError(f"unsupported ground-plant form {form}")


def geometry_bounds(root: bpy.types.Object) -> dict[str, list[float]]:
    minimum = [math.inf, math.inf, math.inf]
    maximum = [-math.inf, -math.inf, -math.inf]
    found = False
    for obj in root.children_recursive:
        if obj.type != "MESH":
            continue
        found = True
        matrix = obj.matrix_world
        for vertex in obj.data.vertices:
            point = matrix @ vertex.co
            for axis in range(3):
                minimum[axis] = min(minimum[axis], point[axis])
                maximum[axis] = max(maximum[axis], point[axis])
    require(found, "asset has no mesh geometry")
    return {"min": minimum, "max": maximum}


def fit_nominal_envelope(root: bpy.types.Object, width: float, height: float) -> dict[str, float]:
    bounds = geometry_bounds(root)
    min_z = bounds["min"][2]
    if abs(min_z) > 1e-9:
        for obj in root.children_recursive:
            if obj.type == "MESH":
                for vertex in obj.data.vertices:
                    vertex.co.z -= min_z
    bounds = geometry_bounds(root)
    radial_extent = max(
        abs(bounds["min"][0]), abs(bounds["max"][0]),
        abs(bounds["min"][1]), abs(bounds["max"][1]),
    )
    xy_scale = min(1.0, (width * 0.5) / radial_extent) if radial_extent > 0 else 1.0
    z_extent = bounds["max"][2]
    require(z_extent > 0, "asset height is zero")
    z_scale = height / z_extent
    for obj in root.children_recursive:
        if obj.type != "MESH":
            continue
        for vertex in obj.data.vertices:
            vertex.co.x *= xy_scale
            vertex.co.y *= xy_scale
            vertex.co.z *= z_scale
        obj.data.update()
    root["tz_fit_xy_scale"] = xy_scale
    root["tz_fit_z_scale"] = z_scale
    return {"xy": xy_scale, "z": z_scale}


def batch_by_material(builder: Builder) -> None:
    groups: dict[str, list[bpy.types.Object]] = {}
    for obj in list(builder.root.children_recursive):
        if obj.type != "MESH":
            continue
        require(len(obj.data.materials) == 1, f"{obj.name} must use one material before batching")
        groups.setdefault(obj.data.materials[0].name, []).append(obj)
    for index, material_name in enumerate(sorted(groups)):
        objects = groups[material_name]
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        if len(objects) > 1:
            bpy.ops.object.join()
        joined = objects[0]
        joined.name = f"TZ_{builder.spec['family'].replace('-', '_')}_Batch_{index:02d}_LOD{builder.lod}"
        joined.parent = builder.root
        joined["tz_batched_material"] = material_name
        joined["tz_original_authored"] = True
        bpy.ops.object.select_all(action="DESELECT")


def build_asset(
    spec: dict,
    lod: int,
    seed: int,
    *,
    pine_alpha_proof: bool = False,
    deciduous_alpha_proof: bool = False,
) -> tuple[Builder, dict[str, int | float], dict[str, list[float]]]:
    reset_scene()
    material_seed = stable_seed(seed, spec["name"]) & 0x7FFFFFFF
    if pine_alpha_proof and spec["name"] == "pine01":
        materials = {
            "bark-pine": create_material("bark-pine", lod, material_seed),
            "needle-pine-atlas": create_pine_atlas_material(lod),
        }
    elif deciduous_alpha_proof and spec["name"] == "tree02":
        materials = {
            "bark-broadleaf": create_material("bark-broadleaf", lod, material_seed),
            "leaf-deciduous-broadleaf-atlas": create_deciduous_atlas_material(lod),
        }
    else:
        materials = {
            kind: create_material(kind, lod, material_seed + index * 977)
            for index, kind in enumerate(material_kinds(spec, lod))
        }
    builder = Builder(spec, lod, seed, materials)
    if pine_alpha_proof and spec["name"] == "pine01":
        pine_alpha_geometry(builder)
    elif deciduous_alpha_proof and spec["name"] == "tree02":
        deciduous_alpha_geometry(builder)
    elif spec["family"] == "pine":
        pine_geometry(builder)
    elif spec["family"] == "birch":
        deciduous_geometry(builder, birch=True)
    elif spec["family"] == "deciduous-broadleaf":
        deciduous_geometry(builder, birch=False)
    elif spec["family"] == "filbert-shrub":
        shrub_geometry(builder)
    elif spec["family"] == "stump":
        stump_geometry(builder)
    elif spec["family"] == "ground-plant":
        ground_plant_geometry(builder)
    else:
        raise ValueError(f"unsupported vegetation family {spec['family']}")
    builder.root["tz_pine_alpha_proof"] = bool(pine_alpha_proof)
    builder.root["tz_deciduous_alpha_proof"] = bool(deciduous_alpha_proof)

    builder.fit_scale = fit_nominal_envelope(
        builder.root,
        float(spec["nominalWidthM"]),
        float(spec["nominalHeightM"]),
    )
    batch_by_material(builder)
    for obj in builder.root.children_recursive:
        if obj.type == "MESH":
            require(obj.data.uv_layers.active is not None, f"{obj.name} has no active UV set")
            editable = bmesh.new()
            editable.from_mesh(obj.data)
            bmesh.ops.triangulate(editable, faces=list(editable.faces))
            editable.to_mesh(obj.data)
            editable.free()
            obj.data.update(calc_edges=True)
            obj.data.calc_tangents(uvmap=obj.data.uv_layers.active.name)
    bounds = geometry_bounds(builder.root)
    require(abs(bounds["min"][2]) <= 1e-5, "base-center geometry must touch z=0")
    require(abs(bounds["max"][2] - float(spec["nominalHeightM"])) <= 1e-4, "asset height drifted")

    vertices = 0
    triangles = 0
    mesh_objects = 0
    atlas_surface_area = 0.0
    for obj in builder.root.children_recursive:
        if obj.type != "MESH":
            continue
        mesh_objects += 1
        vertices += len(obj.data.vertices)
        triangles += sum(max(0, len(polygon.vertices) - 2) for polygon in obj.data.polygons)
        if any("atlas" in material.name.lower() for material in obj.data.materials):
            atlas_surface_area += sum(polygon.area for polygon in obj.data.polygons)
    require(vertices > 0 and triangles > 0 and mesh_objects > 0, "asset geometry stats are empty")
    canopy_footprint = math.pi * (float(spec["nominalWidthM"]) * 0.5) ** 2
    stats = {
        "vertices": vertices,
        "triangles": triangles,
        "meshObjects": mesh_objects,
        **builder.counters,
        "atlasSurfaceAreaM2": round(atlas_surface_area, 6),
        "nominalCanopyFootprintM2": round(canopy_footprint, 6),
        "alphaCardSurfaceAreaPerCanopyFootprint": round(atlas_surface_area / canopy_footprint, 6),
    }
    return builder, stats, bounds


def rounded_bounds(bounds: dict[str, list[float]]) -> dict[str, list[float]]:
    minimum = [round(value, 6) for value in bounds["min"]]
    maximum = [round(value, 6) for value in bounds["max"]]
    return {
        "min": minimum,
        "max": maximum,
        "sizeM": [round(maximum[index] - minimum[index], 6) for index in range(3)],
        "centerM": [round((maximum[index] + minimum[index]) * 0.5, 6) for index in range(3)],
    }


def gltf_bounds_from_blender(bounds: dict[str, list[float]]) -> dict[str, list[float]]:
    # Blender glTF Y-up conversion: (x, y, z) -> (x, z, -y).
    corners = []
    for x in (bounds["min"][0], bounds["max"][0]):
        for y in (bounds["min"][1], bounds["max"][1]):
            for z in (bounds["min"][2], bounds["max"][2]):
                corners.append((x, z, -y))
    minimum = [min(point[axis] for point in corners) for axis in range(3)]
    maximum = [max(point[axis] for point in corners) for axis in range(3)]
    return rounded_bounds({"min": minimum, "max": maximum})


def export_glb(path: Path) -> None:
    result = bpy.ops.export_scene.gltf(
        filepath=str(path),
        check_existing=False,
        export_format="GLB",
        export_copyright="Original TarkovZero vegetation authoring; no game payloads",
        export_yup=True,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_tangents=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_cameras=False,
        export_lights=False,
        export_extras=True,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_draco_mesh_compression_enable=False,
        export_unused_images=False,
        export_unused_textures=False,
        use_selection=False,
        use_visible=True,
        will_save_settings=False,
    )
    require(result == {"FINISHED"} and path.is_file(), f"glTF export failed: {result}")


def glb_json(path: Path) -> dict:
    blob = path.read_bytes()
    require(len(blob) >= 20, "exported GLB is truncated")
    magic, version, declared_length = struct.unpack_from("<4sII", blob, 0)
    require(magic == GLB_MAGIC and version == 2 and declared_length == len(blob), "exported GLB header is invalid")
    offset = 12
    document = None
    while offset + 8 <= len(blob):
        length, kind = struct.unpack_from("<II", blob, offset)
        offset += 8
        end = offset + length
        require(end <= len(blob), "exported GLB chunk exceeds file")
        if kind == GLB_JSON_CHUNK:
            require(document is None, "exported GLB contains duplicate JSON chunks")
            document = json.loads(blob[offset:end].decode("utf-8"))
        offset = end
    require(offset == len(blob) and isinstance(document, dict), "exported GLB has invalid chunks")
    return document


def inspect_export(path: Path, expected_root: str) -> dict[str, int]:
    document = glb_json(path)
    require(not document.get("cameras"), "vegetation GLB unexpectedly contains a camera")
    require(not document.get("animations"), "vegetation GLB unexpectedly contains animation")
    require(not document.get("skins"), "vegetation GLB unexpectedly contains a skin")
    require("KHR_lights_punctual" not in document.get("extensions", {}), "vegetation GLB contains a light")
    for kind in ("buffers", "images"):
        for index, entry in enumerate(document.get(kind, [])):
            require("uri" not in entry, f"GLB {kind}[{index}] is external")
    names = [node.get("name", "") for node in document.get("nodes", [])]
    require(names.count(expected_root) == 1, "GLB must contain exactly one authored root")
    roots = [node for node in document.get("nodes", []) if node.get("name") == expected_root]
    require(roots[0].get("extras", {}).get("tz_pivot") == "base-center", "GLB root pivot receipt changed")
    require(document.get("materials"), "GLB has no PBR materials")
    for index, material in enumerate(document["materials"]):
        pbr = material.get("pbrMetallicRoughness", {})
        require("baseColorTexture" in pbr, f"GLB material {index} lacks base-color texture")
        require("metallicRoughnessTexture" in pbr, f"GLB material {index} lacks ORM texture")
        require("normalTexture" in material, f"GLB material {index} lacks normal texture")
        require("occlusionTexture" in material, f"GLB material {index} lacks occlusion texture")
    triangles = 0
    primitive_count = 0
    accessors = document.get("accessors", [])
    for mesh in document.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            require(primitive.get("mode", 4) == 4, "GLB contains non-triangle primitive")
            require("indices" in primitive, "GLB primitive must be indexed")
            count = accessors[primitive["indices"]]["count"]
            require(count % 3 == 0, "GLB triangle index count is not divisible by three")
            triangles += count // 3
            primitive_count += 1
    require(triangles > 0 and primitive_count > 0, "GLB contains no triangles")
    return {
        "triangles": triangles,
        "nodes": len(document.get("nodes", [])),
        "meshes": len(document.get("meshes", [])),
        "primitives": primitive_count,
        "materials": len(document.get("materials", [])),
        "images": len(document.get("images", [])),
    }


def make_temp_path(parent: Path, stem: str, suffix: str) -> Path:
    parent.mkdir(parents=True, exist_ok=True)
    descriptor, raw = tempfile.mkstemp(prefix=f".{stem}.", suffix=suffix, dir=parent)
    os.close(descriptor)
    path = Path(raw)
    path.unlink()
    return path


def write_temp_receipt(path: Path, document: dict) -> None:
    payload = json.dumps(document, indent=2, sort_keys=True, ensure_ascii=True) + "\n"
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        path.unlink(missing_ok=True)
        raise


def publish_pair_no_clobber(output_temp: Path, output: Path, receipt_temp: Path, receipt: Path) -> None:
    require(not output.exists(), f"refusing to overwrite existing output: {output}")
    require(not receipt.exists(), f"refusing to overwrite existing receipt: {receipt}")
    output_linked = False
    try:
        os.link(output_temp, output)
        output_linked = True
        os.link(receipt_temp, receipt)
    except Exception:
        if output_linked:
            try:
                if output.exists() and os.path.samefile(output, output_temp):
                    output.unlink()
            except OSError:
                pass
        raise


def source_texture_records(
    spec: dict,
    lod: int,
    pine_alpha_proof: bool,
    deciduous_alpha_proof: bool = False,
) -> list[dict]:
    if pine_alpha_proof and spec["name"] == "pine01":
        return [{
            "assetId": "source.vegetation.pine-scots-branch-sprays.openai.v1",
            "projectFile": "scripts/vegetation-asset-factory/source-textures/pine-scots-branch-sprays-openai-v1.png",
            "provenanceFile": "scripts/vegetation-asset-factory/source-textures/pine-scots-branch-sprays-openai-v1.provenance.json",
            "sha256": f"sha256:{PINE_ATLAS_SHA256}",
            "sourceDimensions": list(PINE_ATLAS_SOURCE_SIZE),
            "derivedEmbeddedResolution": PINE_ATLAS_TEXTURE_BY_LOD[lod],
            "derivedTreatment": {
                "rgbDilationPixels": 8,
                "alphaMode": "MASK",
                "alphaCutoff": PINE_ALPHA_CUTOFF,
                "doubleSided": True,
                "atlasUvGuardPixels": 2.5,
                "originalSourceFileModified": False,
            },
            "origin": "OpenAI-generated original for TarkovZero",
            "sourceGameTexture": False,
            "sourceGameEquivalenceClaim": False,
        }]
    if deciduous_alpha_proof and spec["name"] == "tree02":
        return [{
            "assetId": "source.vegetation.deciduous-broadleaf-branch-sprays.openai.v1",
            "projectFile": "scripts/vegetation-asset-factory/source-textures/deciduous-broadleaf-branch-sprays-openai-v1.png",
            "provenanceFile": "scripts/vegetation-asset-factory/source-textures/deciduous-broadleaf-branch-sprays-openai-v1.provenance.json",
            "sha256": f"sha256:{DECIDUOUS_ATLAS_SHA256}",
            "sourceDimensions": list(DECIDUOUS_ATLAS_SOURCE_SIZE),
            "derivedEmbeddedResolution": DECIDUOUS_ATLAS_TEXTURE_BY_LOD[lod],
            "derivedTreatment": {
                "independentCellResample": True,
                "cellGutterPixels": DECIDUOUS_ATLAS_GUTTER_BY_LOD[lod],
                "credibleAlphaThreshold": DECIDUOUS_ALPHA_CUTOFF,
                "belowCutoffRgbDiscarded": True,
                "rgbDilationPixels": 4,
                "alphaMode": "MASK",
                "alphaCutoff": DECIDUOUS_ALPHA_CUTOFF,
                "doubleSided": True,
                "atlasUvGuardPixels": DECIDUOUS_ATLAS_GUTTER_BY_LOD[lod] + 0.5,
                "originalSourceFileModified": False,
            },
            "origin": "OpenAI-generated original for TarkovZero",
            "sourceGameTexture": False,
            "sourceGameEquivalenceClaim": False,
        }]
    return []


def asset_limitations(
    spec: dict,
    pine_alpha_proof: bool,
    deciduous_alpha_proof: bool = False,
) -> list[str]:
    common = [
        "Prototype identity, placement, yaw, widthScale, heightScale, and tint are scalar truth; branch topology, foliage arrangement, bark pixels, and PBR response are original authored approximations.",
        "Nominal envelopes intentionally match TarkovZero's current fallback sizing and are not claimed as measured source-mesh bounds.",
        "These assets contain no wind animation, seasonal morph, collision hull, or certified runtime LOD thresholds; runtime integration and target-hardware budgets remain separate gates.",
        "Recognizable family silhouette is an authoring baseline, not a botanical or 1:1 source-asset equivalence claim.",
    ]
    if pine_alpha_proof and spec["name"] == "pine01":
        common.append(
            "Pine foliage uses an OpenAI-generated original alpha atlas with derived RGB edge dilation; internal-cell mip bleed and alpha-cut minification remain visual admission checks."
        )
    elif deciduous_alpha_proof and spec["name"] == "tree02":
        common.append(
            "Deciduous foliage uses an OpenAI-generated original alpha atlas with per-cell resampling, bounded mip gutters, below-cutoff fringe rejection, and RGB edge dilation; runtime mip, wind, and alpha-shadow behavior remain admission checks."
        )
    else:
        common.append("Procedural foliage is a provisional geometry treatment pending family-specific alpha-card proofs.")
    return common


def receipt_document(
    args: argparse.Namespace,
    raw_args: Sequence[str],
    catalog: dict,
    spec: dict,
    builder: Builder,
    geometry: dict[str, int | float],
    bounds: dict[str, list[float]],
    output_temp: Path,
    export_stats: dict[str, int],
) -> dict:
    script_path = Path(__file__).resolve()
    binary = Path(bpy.app.binary_path).resolve()
    return {
        "schemaVersion": 1,
        "generator": {
            "name": GENERATOR_NAME,
            "version": GENERATOR_VERSION,
            "scriptFile": "scripts/vegetation-asset-factory/vegetation_factory.py",
            "scriptSha256": f"sha256:{sha256_file(script_path)}",
            "catalogFile": CATALOG_PATH.name,
            "catalogSha256": f"sha256:{catalog['sha256']}",
            "blenderVersion": bpy.app.version_string,
            "blenderBinarySha256": f"sha256:{sha256_file(binary)}",
            "requiredInvocationFlags": [
                "--background", "--factory-startup", "--disable-autoexec", "--python-exit-code 1",
            ],
            "argvAfterSeparator": list(raw_args),
        },
        "copyrightBoundary": {
            "authorship": (
                "independently-authored deterministic procedural geometry plus an OpenAI-generated original project-bound foliage atlas"
                if (args.pine_alpha_proof and spec["name"] == "pine01")
                or (args.deciduous_alpha_proof and spec["name"] == "tree02")
                else "independently-authored deterministic procedural geometry and PBR textures"
            ),
            "input": (
                "privacy-safe prototype facts and one hash-pinned OpenAI-generated original foliage atlas"
                if (args.pine_alpha_proof and spec["name"] == "pine01")
                or (args.deciduous_alpha_proof and spec["name"] == "tree02")
                else "privacy-safe prototype names, family mapping, aggregate counts, and fallback envelopes"
            ),
            "gameFilesReadByGenerator": False,
            "gameMeshesIncluded": False,
            "gameTexturesIncluded": False,
            "gameShadersIncluded": False,
            "externalTexturesIncluded": False,
            "bakedLightingIncluded": False,
            "fogIncluded": False,
        },
        "sourceTextures": source_texture_records(
            spec,
            args.lod,
            args.pine_alpha_proof,
            args.deciduous_alpha_proof,
        ),
        "proof": {
            "pineAlphaCard": bool(args.pine_alpha_proof),
            "deciduousAlphaCard": bool(args.deciduous_alpha_proof),
            "offlineOnly": True,
            "livePromotion": False,
        },
        "asset": {
            "id": f"customs.vegetation.{spec['name'].lower()}",
            "prototypeName": spec["name"],
            "family": spec["family"],
            "form": spec["form"],
            "variant": spec["variant"],
            "dry": spec["dry"],
            "lod": args.lod,
            "outputFile": args.output.name,
            "bytes": output_temp.stat().st_size,
            "sha256": f"sha256:{sha256_file(output_temp)}",
            "gltf": {"unit": "metre", "upAxis": "+y", "forwardAxis": "+z", "pivot": "base-center"},
            "boundsM": gltf_bounds_from_blender(bounds),
        },
        "census": {
            "prototypeInstances": spec["instances"],
            "familyInstances": catalog["families"][spec["family"]],
            "customsInstances": catalog["instanceCount"],
            "prototypeCount": len(catalog["prototypes"]),
        },
        "placementContract": {
            "geometryScale": "1x canonical metres",
            "positionBaked": False,
            "rotationBaked": False,
            "instanceScaleBaked": False,
            "runtime": "TarkovZero applies the exact local position, yaw, widthScale, heightScale, tint, and fixed display relief",
        },
        "generated": {
            **geometry,
            "exportedTriangles": export_stats["triangles"],
            "exportedNodes": export_stats["nodes"],
            "exportedMeshes": export_stats["meshes"],
            "exportedPrimitives": export_stats["primitives"],
            "materialCount": export_stats["materials"],
            "embeddedImageCount": export_stats["images"],
            "textureResolution": texture_resolution(
                spec,
                args.lod,
                args.pine_alpha_proof,
                args.deciduous_alpha_proof,
            ),
            "seed": args.seed,
            "stablePrototypeSeed": stable_seed(args.seed, spec["name"]),
            "blenderBoundsM": rounded_bounds(bounds),
            "rootNode": builder.root_name,
            **(
                {
                    "continuityContract": builder.root.get("tz_continuity_contract"),
                    "continuityLandmarks": getattr(builder, "continuity_landmarks", {}),
                    "continuityLandmarksSha256": builder.root.get("tz_continuity_landmarks_sha256"),
                    "canonicalFitScale": {
                        key: round(float(value), 9)
                        for key, value in getattr(builder, "fit_scale", {}).items()
                    },
                }
                if args.deciduous_alpha_proof and spec["name"] == "tree02"
                else {}
            ),
        },
        "reproducibility": {
            "deterministic": True,
            "noClobber": True,
            "atomicFinalPublication": "hard-link create-if-absent for GLB and receipt; rollback GLB if receipt publication loses a race",
            "sameSeedSamePrototypeSameLod": "expected byte-identical with the pinned Blender binary and factory/catalog hashes",
        },
        "limitations": asset_limitations(
            spec,
            args.pine_alpha_proof,
            args.deciduous_alpha_proof,
        ),
    }


def main() -> None:
    raw_args = script_args()
    catalog, by_name = load_catalog()
    args = parse_args(raw_args, by_name)
    validate_blender()
    builder, geometry, bounds = build_asset(
        by_name[args.prototype],
        args.lod,
        args.seed,
        pine_alpha_proof=args.pine_alpha_proof,
        deciduous_alpha_proof=args.deciduous_alpha_proof,
    )

    output_temp = make_temp_path(args.output.parent, args.output.stem, ".partial.glb")
    receipt_temp = make_temp_path(args.receipt.parent, args.receipt.stem, ".partial.json")
    try:
        export_glb(output_temp)
        export_stats = inspect_export(output_temp, builder.root_name)
        require(
            export_stats["triangles"] == geometry["triangles"],
            f"exported triangle count {export_stats['triangles']} differs from authored {geometry['triangles']}",
        )
        document = receipt_document(
            args, raw_args, catalog, by_name[args.prototype], builder, geometry, bounds, output_temp, export_stats,
        )
        write_temp_receipt(receipt_temp, document)
        publish_pair_no_clobber(output_temp, args.output, receipt_temp, args.receipt)
        print(json.dumps({
            "prototype": args.prototype,
            "family": by_name[args.prototype]["family"],
            "lod": args.lod,
            "output": str(args.output),
            "receipt": str(args.receipt),
            "triangles": export_stats["triangles"],
            "bytes": args.output.stat().st_size,
            "sha256": f"sha256:{sha256_file(args.output)}",
        }, indent=2, sort_keys=True))
    finally:
        output_temp.unlink(missing_ok=True)
        receipt_temp.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, json.JSONDecodeError, struct.error) as error:
        print(f"vegetation factory failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
