#!/usr/bin/env python3
"""Deterministic, independently authored Customs Fortress asset factory.

Run this file with Blender, not system Python.  The factory consumes only the
sanitized scalar anchors recorded below.  It never reads the EFT installation,
game meshes, topology, UVs, materials, textures, or texture pixels.

Example:

    blender --background --factory-startup --disable-autoexec --python-exit-code 1 \
      --python scripts/asset-factory/fortress_factory.py -- \
      --asset fortress-shell --lod 0 --output /tmp/fortress-lod0.glb \
      --receipt /tmp/fortress-lod0.receipt.json

The exported glTF is metre-scaled, +Y-up/+X-forward, with the measured
Construction_factory root as its origin. World placement and yaw deliberately
remain outside the mesh; the runtime manifest owns those transforms.
"""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import math
import os
from pathlib import Path
import struct
import sys
from typing import Iterable, Sequence

import bpy
from mathutils import Vector


GENERATOR_NAME = "tarkovzero-fortress-factory"
GENERATOR_VERSION = "0.1.0"
SUPPORTED_BLENDER = (4, 5)
ASSET_IDS = ("fortress-shell", "zb013-basement")
LOD_LEVELS = (0, 1, 2)
STRUCTURE_SCALAR_SHA256 = "8a59c61be57feac54e6307dad12851699ed9c88bdc30a078f37c233f796c6cd7"
STRUCTURE_SCALAR_COUNTS = {
    "roof": 60,
    "girder": 11,
    "metal-support": 22,
    "beam": 40,
    "metal-beam": 4,
    "pillar": 36,
    "column": 20,
    "brick-wall": 28,
    "concrete-wall": 17,
    "cement-board": 75,
    "glass": 15,
    "stairs": 2,
    "ramp": 4,
}

# Sanitized scalar truth anchors.  These are measurements and hierarchy facts,
# not copied creative payloads.  Local geometry is independently authored from
# generic real-world industrial construction practice.
EFT_ROOT_CENTER_M = (202.898880005, 1.729503632, -127.68775177)
EFT_YAW_DEG = -10.342808
GROUND_WORLD_Y_M = 2.447
UPPER_WORLD_Y_M = 8.183
BASEMENT_WORLD_Y_M = -1.7874
ROOF_TRUSS_WORLD_Y_M = (17.7, 19.8)
FOOTPRINT_LOCAL_QUAD_M = (
    (-30.960060241, -12.561473777),
    (30.317091682, -12.458264449),
    (30.309401501, 12.648307217),
    (-30.967750422, 12.545097890),
)
FOOTPRINT_M = (61.27723884118801, 25.106572844575993)
BASEMENT_EFT_PIVOT_M = (206.0, -1.7874, -147.5)
BASEMENT_YAW_DEG = 90.0
BASEMENT_FOOTPRINT_M = (26.0, 21.0)
LONGITUDINAL_GIRDERS = 11

# Exact root-local roof/support facts from the scalar census.  X and Y are the
# Construction_factory local plan axes; Z is local up.  Ten panel columns sit
# between the eleven girder stations.  Sixty panels occupy a deliberately
# incomplete subset of the ten-by-eight possible gabled positions.
ROOF_GIRDER_X_M = tuple(-29.995 + index * ((29.881 + 29.995) / 10.0) for index in range(11))
ROOF_SUPPORT_Y_M = (-11.908, 12.051)
ROOF_ROW_Y_M = (-10.363, -7.523, -4.539, -1.506, 1.558, 4.590, 7.567, 10.428)
ROOF_ROW_ROOT_LOCAL_Z_M = (15.998, 17.09, 17.78, 18.064, 18.064, 17.78, 17.09, 15.998)
ROOF_PANEL_ROWS_BY_COLUMN = (
    (0, 3, 7),
    (0, 2, 5, 7),
    (0, 1, 3, 6, 7),
    (0, 1, 2, 5, 6, 7),
    (0, 1, 3, 4, 6, 7),
    tuple(range(8)),
    tuple(range(8)),
    (0, 1, 6, 7),
    tuple(range(8)),
    tuple(range(8)),
)
assert sum(len(rows) for rows in ROOF_PANEL_ROWS_BY_COLUMN) == 60

GROUND_LOCAL_Z_M = GROUND_WORLD_Y_M - EFT_ROOT_CENTER_M[1]
UPPER_LOCAL_Z_M = UPPER_WORLD_Y_M - GROUND_WORLD_Y_M
BASEMENT_LOCAL_Z_M = BASEMENT_WORLD_Y_M - EFT_ROOT_CENTER_M[1]
BASEMENT_BELOW_GROUND_M = GROUND_WORLD_Y_M - BASEMENT_WORLD_Y_M
EAVE_LOCAL_Z_M = ROOF_TRUSS_WORLD_Y_M[0] - GROUND_WORLD_Y_M
RIDGE_LOCAL_Z_M = ROOF_TRUSS_WORLD_Y_M[1] - GROUND_WORLD_Y_M

TEXTURE_SIZE_BY_LOD = {0: 256, 1: 128, 2: 64}
BEVEL_SEGMENTS_BY_LOD = {0: 2, 1: 1, 2: 0}

MATERIAL_SPECS = {
    "concrete": {
        "base": (0.59, 0.595, 0.56),
        "roughness": 0.86,
        "metallic": 0.0,
        "seed": 104729,
        "tile_m": 2.5,
    },
    "brick": {
        "base": (0.47, 0.30, 0.22),
        "roughness": 0.82,
        "metallic": 0.0,
        "seed": 130363,
        "tile_m": 1.8,
    },
    "cement_board": {
        "base": (0.62, 0.61, 0.565),
        "roughness": 0.74,
        "metallic": 0.0,
        "seed": 155921,
        "tile_m": 3.2,
    },
    "steel": {
        "base": (0.42, 0.43, 0.405),
        "roughness": 0.69,
        "metallic": 0.30,
        "seed": 196613,
        "tile_m": 1.4,
    },
    "roof_galvanized": {
        "base": (0.56, 0.56, 0.535),
        "roughness": 0.72,
        "metallic": 0.50,
        "seed": 224737,
        "tile_m": 7.5,
    },
    "roof_offwhite": {
        "base": (0.58, 0.575, 0.55),
        "roughness": 0.79,
        "metallic": 0.20,
        "seed": 263167,
        "tile_m": 7.5,
    },
    "roof_oxidized": {
        "base": (0.55, 0.535, 0.50),
        "roughness": 0.82,
        "metallic": 0.39,
        "seed": 304807,
        "tile_m": 7.5,
    },
}

ROOF_MATERIAL_FAMILIES = ("roof_galvanized", "roof_offwhite", "roof_oxidized")


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build an original metric Fortress shell or ZB-013 basement GLB.",
    )
    parser.add_argument("--asset", choices=ASSET_IDS, default="fortress-shell")
    parser.add_argument("--lod", type=int, choices=LOD_LEVELS, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--receipt",
        type=Path,
        default=None,
        help="Optional deterministic JSON authoring receipt written after export.",
    )
    parser.add_argument(
        "--structure-scalars",
        type=Path,
        default=None,
        help="Optional hash-pinned scalar-only Fortress recipe; never a Unity/game payload.",
    )
    return parser.parse_args(argv)


def blender_script_args() -> list[str]:
    if "--" not in sys.argv:
        raise SystemExit("factory arguments must follow Blender's `--` separator")
    return sys.argv[sys.argv.index("--") + 1 :]


def validate_runtime() -> None:
    if bpy.app.version[:2] != SUPPORTED_BLENDER:
        raise RuntimeError(
            f"Blender {SUPPORTED_BLENDER[0]}.{SUPPORTED_BLENDER[1]} LTS required; "
            f"found {bpy.app.version_string}"
        )


def load_structure_scalars(path: Path) -> dict:
    """Load the one allowlisted scalar recipe and reject every broader shape.

    This is deliberately not a general extractor or game-file reader.  The exact
    content hash, document schema, counts, scalar ranges, and exclusion receipt
    all have to match before any anchor reaches authoring code.
    """
    resolved = path.expanduser().resolve()
    if not resolved.is_file():
        raise ValueError(f"--structure-scalars is not a file: {resolved}")
    if resolved.stat().st_size > 256 * 1024:
        raise ValueError("--structure-scalars exceeds the 256 KiB scalar-only cap")
    payload = resolved.read_bytes()
    actual_hash = hashlib.sha256(payload).hexdigest()
    if actual_hash != STRUCTURE_SCALAR_SHA256:
        raise ValueError(
            "--structure-scalars hash mismatch; refusing an unreviewed local-derived document"
        )
    document = json.loads(payload.decode("utf-8"))
    required_top = {
        "schemaVersion", "documentType", "map", "featureId", "sourceFrame",
        "root", "counts", "objects", "excludes", "sourceReceipt",
    }
    if not isinstance(document, dict) or set(document) != required_top:
        raise ValueError("--structure-scalars has an unexpected top-level schema")
    expected_identity = {
        "schemaVersion": 1,
        "documentType": "tarkovzero-local-read-only-derived-structure-scalars",
        "map": "customs",
        "featureId": "customs.building.fortress.main",
        "sourceFrame": "Construction_factory-local-metres-z-up",
    }
    for key, expected in expected_identity.items():
        if document.get(key) != expected:
            raise ValueError(f"--structure-scalars {key} is not the reviewed Fortress value")
    if document.get("counts") != STRUCTURE_SCALAR_COUNTS:
        raise ValueError("--structure-scalars category counts changed")
    excluded = set(document.get("excludes", []))
    required_exclusions = {
        "mesh payloads", "texture payloads", "materials", "shaders", "audio", "game executables",
    }
    if excluded != required_exclusions:
        raise ValueError("--structure-scalars payload-exclusion receipt changed")
    if not isinstance(document.get("objects"), list) or len(document["objects"]) != 334:
        raise ValueError("--structure-scalars must contain exactly 334 scalar objects")

    def scalar_vector(value: object, keys: set[str], label: str, limit: float) -> dict[str, float]:
        if not isinstance(value, dict) or set(value) != keys:
            raise ValueError(f"--structure-scalars {label} has an unexpected vector shape")
        result = {}
        for key in keys:
            number = value[key]
            if isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(number):
                raise ValueError(f"--structure-scalars {label}.{key} is not finite")
            if abs(float(number)) > limit:
                raise ValueError(f"--structure-scalars {label}.{key} exceeds its scalar bound")
            result[key] = float(number)
        return result

    root = document.get("root")
    if not isinstance(root, dict) or set(root) != {"position", "rotation", "scale"}:
        raise ValueError("--structure-scalars root shape changed")
    root_position = scalar_vector(root["position"], {"x", "y", "z"}, "root.position", 4000.0)
    for axis, expected in zip(("x", "y", "z"), EFT_ROOT_CENTER_M):
        if abs(root_position[axis] - expected) > 1e-6:
            raise ValueError("--structure-scalars root position changed")
    scalar_vector(root["rotation"], {"w", "x", "y", "z"}, "root.rotation", 1.0)
    root_scale = scalar_vector(root["scale"], {"x", "y", "z"}, "root.scale", 4.0)
    if any(abs(root_scale[axis] - 1.0) > 1e-6 for axis in ("x", "y", "z")):
        raise ValueError("--structure-scalars root scale changed")

    normalized_objects = []
    for index, entry in enumerate(document["objects"]):
        if not isinstance(entry, dict) or set(entry) != {"name", "category", "position", "rotation", "scale"}:
            raise ValueError(f"--structure-scalars objects[{index}] shape changed")
        name = entry["name"]
        category = entry["category"]
        if not isinstance(name, str) or not name.startswith("Construction_") or len(name) > 160:
            raise ValueError(f"--structure-scalars objects[{index}].name is not allowlisted")
        if category not in STRUCTURE_SCALAR_COUNTS:
            raise ValueError(f"--structure-scalars objects[{index}].category is unknown")
        position = scalar_vector(entry["position"], {"x", "y", "z"}, f"objects[{index}].position", 100.0)
        rotation = scalar_vector(entry["rotation"], {"w", "x", "y", "z"}, f"objects[{index}].rotation", 1.0)
        scale = scalar_vector(entry["scale"], {"x", "y", "z"}, f"objects[{index}].scale", 16.0)
        if any(abs(scale[axis]) < 1e-6 for axis in ("x", "y", "z")):
            raise ValueError(f"--structure-scalars objects[{index}].scale contains zero")
        normalized_objects.append({
            "name": name,
            "category": category,
            "position": position,
            "rotation": rotation,
            "scale": scale,
        })
    if Counter(entry["category"] for entry in normalized_objects) != Counter(STRUCTURE_SCALAR_COUNTS):
        raise ValueError("--structure-scalars object/category ledger changed")
    document["objects"] = normalized_objects
    document["sha256"] = actual_hash
    return document


def scalar_category(document: dict | None, category: str) -> list[dict]:
    if document is None:
        return []
    return sorted(
        (entry for entry in document["objects"] if entry["category"] == category),
        key=lambda entry: (
            entry["position"]["x"], entry["position"]["y"], entry["position"]["z"], entry["name"],
        ),
    )


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (
        bpy.data.meshes,
        bpy.data.curves,
        bpy.data.materials,
        bpy.data.images,
        bpy.data.cameras,
        bpy.data.lights,
    ):
        for datablock in list(datablocks):
            datablocks.remove(datablock)
    for collection in list(bpy.data.collections):
        bpy.data.collections.remove(collection)

    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.length_unit = "METERS"
    scene.unit_settings.scale_length = 1.0
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.world.color = (0.05, 0.05, 0.05)
    scene["tz_no_baked_lighting"] = True
    scene["tz_no_fog"] = True
    scene["tz_original_authored"] = True


def link_collection(name: str, parent: bpy.types.Collection | None = None) -> bpy.types.Collection:
    collection = bpy.data.collections.new(name)
    if parent is None:
        bpy.context.scene.collection.children.link(collection)
    else:
        parent.children.link(collection)
    return collection


def create_empty(
    name: str,
    collection: bpy.types.Collection,
    *,
    parent: bpy.types.Object | None = None,
) -> bpy.types.Object:
    obj = bpy.data.objects.new(name, None)
    collection.objects.link(obj)
    obj.empty_display_type = "PLAIN_AXES"
    obj.empty_display_size = 0.75
    obj.parent = parent
    return obj


def hash01(x: int, y: int, seed: int) -> float:
    """Small deterministic integer hash; stable across Python/Blender runs."""
    value = (x * 0x1F123BB5 + y * 0x5F356495 + seed * 0x6C8E9CF5) & 0xFFFFFFFF
    value ^= value >> 16
    value = (value * 0x7FEB352D) & 0xFFFFFFFF
    value ^= value >> 15
    value = (value * 0x846CA68B) & 0xFFFFFFFF
    value ^= value >> 16
    return value / 0xFFFFFFFF


def smoothstep(value: float) -> float:
    return value * value * (3.0 - 2.0 * value)


def tile_value_noise(x: int, y: int, size: int, cell: int, seed: int) -> float:
    grid = max(2, size // cell)
    gx = x / cell
    gy = y / cell
    x0 = math.floor(gx) % grid
    y0 = math.floor(gy) % grid
    tx = smoothstep(gx - math.floor(gx))
    ty = smoothstep(gy - math.floor(gy))
    a = hash01(x0, y0, seed)
    b = hash01((x0 + 1) % grid, y0, seed)
    c = hash01(x0, (y0 + 1) % grid, seed)
    d = hash01((x0 + 1) % grid, (y0 + 1) % grid, seed)
    top = a + (b - a) * tx
    bottom = c + (d - c) * tx
    return top + (bottom - top) * ty


def surface_sample(kind: str, x: int, y: int, size: int, spec: dict) -> tuple[float, tuple[float, float, float], float, float, float]:
    seed = int(spec["seed"])
    broad = tile_value_noise(x, y, size, max(4, size // 8), seed)
    medium = tile_value_noise(x, y, size, max(2, size // 32), seed + 31)
    grain = hash01(x, y, seed + 97)
    height = 0.55 * broad + 0.32 * medium + 0.13 * grain
    tint = (height - 0.5) * 0.15
    roughness = float(spec["roughness"]) + (grain - 0.5) * 0.07
    metallic = float(spec["metallic"])
    occlusion = 0.9 + (broad - 0.5) * 0.12

    if kind.startswith("roof_"):
        # Original corrugated-sheet study: long ribs, broad grime and sparse
        # oxidation are deterministic but are not claimed as measured panels.
        rib_period = max(4, size // 32)
        rib = 0.5 + 0.5 * math.cos((x % rib_period) / rib_period * math.tau)
        macro = tile_value_noise(x, y, size, max(4, size // 4), seed + 701)
        stain = tile_value_noise(x, y, size, max(3, size // 12), seed + 809)
        speck = hash01(x // max(1, size // 96), y // max(1, size // 96), seed + 907)
        # Families stay close in base value. Their distinction comes mostly from
        # sparse local corrosion frequency, not a dark whole-panel classification.
        variant_rust = {"roof_galvanized": 0.25, "roof_offwhite": 0.18, "roof_oxidized": 0.55}[kind]
        rust = max(0.0, stain - (0.75 - variant_rust * 0.11)) * (1.35 + variant_rust)
        grime = max(0.0, 0.57 - macro) * 0.14
        height = 0.43 + rib * 0.14 + (stain - 0.5) * 0.045 + rust * 0.08
        base = spec["base"]
        color = (
            base[0] - grime + rust * 0.13 + (speck - 0.5) * 0.022,
            base[1] - grime * 1.03 + rust * 0.045 + (speck - 0.5) * 0.016,
            base[2] - grime * 1.07 + rust * 0.014 + (speck - 0.5) * 0.011,
        )
        color = tuple(max(0.0, min(1.0, channel)) for channel in color)
        roughness = float(spec["roughness"]) + grime * 0.48 + rust * 0.26 + (grain - 0.5) * 0.04
        metallic = float(spec["metallic"]) - grime * 0.20 - rust * 0.52
        occlusion = 0.95 - grime * 0.25 - rust * 0.10
    elif kind == "brick":
        brick_h = max(4, size // 16)
        brick_w = max(8, size // 4)
        row = y // brick_h
        shifted_x = (x + (brick_w // 2 if row % 2 else 0)) % size
        mortar_x = shifted_x % brick_w
        mortar_y = y % brick_h
        mortar = mortar_x < max(1, size // 128) or mortar_y < max(1, size // 128)
        if mortar:
            height = 0.13 + 0.05 * grain
            color = (0.34 + tint * 0.25, 0.33 + tint * 0.25, 0.30 + tint * 0.2)
            roughness = 0.92
            occlusion = 0.76
        else:
            brick_variation = (hash01((shifted_x // brick_w), row, seed + 211) - 0.5) * 0.16
            base = spec["base"]
            color = tuple(max(0.0, min(1.0, channel + tint + brick_variation)) for channel in base)
    elif kind == "cement_board":
        seam = x % max(8, size // 2) < max(1, size // 128) or y % max(8, size // 2) < max(1, size // 128)
        if seam:
            height *= 0.35
            tint -= 0.09
            occlusion = 0.79
        base = spec["base"]
        color = tuple(max(0.0, min(1.0, channel + tint * 0.55)) for channel in base)
    elif kind == "steel":
        scratch = hash01(x // max(1, size // 64), y, seed + 401)
        rust = max(0.0, tile_value_noise(x, y, size, max(3, size // 16), seed + 503) - 0.69)
        height = 0.47 + (grain - 0.5) * 0.09 + rust * 0.2
        base = spec["base"]
        color = (
            max(0.0, min(1.0, base[0] + tint * 0.35 + rust * 0.65)),
            max(0.0, min(1.0, base[1] + tint * 0.30 + rust * 0.19)),
            max(0.0, min(1.0, base[2] + tint * 0.25 + rust * 0.06)),
        )
        roughness += rust * 0.7 - scratch * 0.035
        metallic = max(0.35, metallic - rust * 1.7)
    else:
        pore = grain > 0.965
        if pore:
            height -= 0.28
            tint -= 0.12
            occlusion -= 0.18
        base = spec["base"]
        color = tuple(max(0.0, min(1.0, channel + tint)) for channel in base)

    return (
        max(0.0, min(1.0, height)),
        color,
        max(0.0, min(1.0, occlusion)),
        max(0.0, min(1.0, roughness)),
        max(0.0, min(1.0, metallic)),
    )


def create_image(name: str, size: int, pixels: list[float], colorspace: str) -> bpy.types.Image:
    image = bpy.data.images.new(name, width=size, height=size, alpha=True, float_buffer=False)
    image.file_format = "PNG"
    image.colorspace_settings.name = colorspace
    image.pixels.foreach_set(pixels)
    image.pack()
    image["tz_original_procedural"] = True
    image["tz_generator"] = GENERATOR_NAME
    return image


def create_material(kind: str, lod: int) -> bpy.types.Material:
    spec = MATERIAL_SPECS[kind]
    size = TEXTURE_SIZE_BY_LOD[lod]
    if kind.startswith("roof_"):
        size = max(32, size // 2)
    samples = [surface_sample(kind, x, y, size, spec) for y in range(size) for x in range(size)]

    base_pixels: list[float] = []
    orm_pixels: list[float] = []
    heights = [sample[0] for sample in samples]
    for _, color, occlusion, roughness, metallic in samples:
        base_pixels.extend((*color, 1.0))
        orm_pixels.extend((occlusion, roughness, metallic, 1.0))

    normal_pixels: list[float] = []
    strength = {
        "concrete": 1.8,
        "brick": 3.4,
        "cement_board": 1.5,
        "steel": 1.1,
        "roof_galvanized": 1.35,
        "roof_offwhite": 1.25,
        "roof_oxidized": 1.45,
    }[kind]
    for y in range(size):
        for x in range(size):
            left = heights[y * size + ((x - 1) % size)]
            right = heights[y * size + ((x + 1) % size)]
            down = heights[((y - 1) % size) * size + x]
            up = heights[((y + 1) % size) * size + x]
            normal = Vector((-(right - left) * strength, -(up - down) * strength, 1.0)).normalized()
            normal_pixels.extend((normal.x * 0.5 + 0.5, normal.y * 0.5 + 0.5, normal.z * 0.5 + 0.5, 1.0))

    prefix = f"TZ_{kind}_L{lod}"
    base_image = create_image(f"{prefix}_BaseColor", size, base_pixels, "sRGB")
    normal_image = create_image(f"{prefix}_Normal", size, normal_pixels, "Non-Color")
    orm_image = create_image(f"{prefix}_ORM", size, orm_pixels, "Non-Color")

    material = bpy.data.materials.new(f"TZ_{kind}_PBR_L{lod}")
    material.use_nodes = True
    material.diffuse_color = (*spec["base"], 1.0)
    material.metallic = float(spec["metallic"])
    material.roughness = float(spec["roughness"])
    material["tz_family"] = kind
    material["tz_original_procedural"] = True
    material["tz_variation_status"] = "original-authored-not-measured" if kind.startswith("roof_") else "family-authored"
    material["tz_texture_resolution"] = size
    material["tz_orm_channels"] = "R=occlusion,G=roughness,B=metallic"

    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()

    output = nodes.new("ShaderNodeOutputMaterial")
    output.location = (720, 0)
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (430, 0)
    bsdf.inputs["Base Color"].default_value = (*spec["base"], 1.0)
    bsdf.inputs["Metallic"].default_value = float(spec["metallic"])
    bsdf.inputs["Roughness"].default_value = float(spec["roughness"])
    links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])

    base_node = nodes.new("ShaderNodeTexImage")
    base_node.name = f"{prefix}_BaseColorNode"
    base_node.label = "Original procedural base color"
    base_node.image = base_image
    base_node.interpolation = "Linear"
    base_node.extension = "REPEAT"
    base_node.location = (-650, 180)
    links.new(base_node.outputs["Color"], bsdf.inputs["Base Color"])

    normal_node = nodes.new("ShaderNodeTexImage")
    normal_node.name = f"{prefix}_NormalNode"
    normal_node.label = "Original procedural tangent normal"
    normal_node.image = normal_image
    normal_node.interpolation = "Linear"
    normal_node.extension = "REPEAT"
    normal_node.location = (-650, -110)
    normal_map = nodes.new("ShaderNodeNormalMap")
    normal_map.location = (120, -160)
    normal_map.inputs["Strength"].default_value = 0.72 if lod == 0 else 0.55
    links.new(normal_node.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])

    orm_node = nodes.new("ShaderNodeTexImage")
    orm_node.name = f"{prefix}_ORMNode"
    orm_node.label = "Original procedural ORM"
    orm_node.image = orm_image
    orm_node.interpolation = "Linear"
    orm_node.extension = "REPEAT"
    orm_node.location = (-650, -410)
    separate = nodes.new("ShaderNodeSeparateColor")
    separate.location = (-110, -390)
    links.new(orm_node.outputs["Color"], separate.inputs["Color"])
    links.new(separate.outputs["Green"], bsdf.inputs["Roughness"])
    links.new(separate.outputs["Blue"], bsdf.inputs["Metallic"])

    # Blender's glTF exporter recognizes this named group and writes the R channel
    # as an occlusionTexture while reusing the same embedded ORM image.
    group_tree = bpy.data.node_groups.get("glTF Material Output")
    if group_tree is None:
        group_tree = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
        group_tree.interface.new_socket(name="Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
    gltf_output = nodes.new("ShaderNodeGroup")
    gltf_output.node_tree = group_tree
    gltf_output.label = "glTF occlusion channel"
    gltf_output.location = (120, -500)
    links.new(separate.outputs["Red"], gltf_output.inputs["Occlusion"])
    return material


def material_set(lod: int, *, include_roof_variants: bool = False) -> dict[str, bpy.types.Material]:
    families = [kind for kind in MATERIAL_SPECS if include_roof_variants or not kind.startswith("roof_")]
    return {kind: create_material(kind, lod) for kind in families}


def roof_material_family(column: int, row: int) -> str:
    """Deterministic, non-periodic authored weathering family for one roof cell."""
    value = hash01(column, row, 352879)
    if value < 0.54:
        return "roof_galvanized"
    if value < 0.82:
        return "roof_offwhite"
    return "roof_oxidized"


def offset_uv_phase(obj: bpy.types.Object, u: float, v: float) -> None:
    uv_layer = obj.data.uv_layers.get("UVMap")
    if uv_layer is None:
        raise ValueError(f"{obj.name}: UVMap is required before phase offset")
    for loop in uv_layer.data:
        loop.uv.x += u
        loop.uv.y += v


def apply_identity(obj: bpy.types.Object) -> None:
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.select_set(False)


def tag_object(obj: bpy.types.Object, asset_id: str, lod: int, floor: str, family: str) -> None:
    obj["tz_asset_id"] = asset_id
    obj["tz_lod"] = lod
    obj["tz_floor"] = floor
    obj["tz_material_family"] = family
    obj["tz_original_authored"] = True


def assign_metric_planar_uv(mesh: bpy.types.Mesh, tile_m: float) -> None:
    """Project each polygon on its dominant plane at one consistent metre scale."""
    if tile_m <= 0.0:
        raise ValueError("UV tile size must be positive")
    uv_layer = mesh.uv_layers.new(name="UVMap")
    for polygon in mesh.polygons:
        normal = tuple(abs(value) for value in polygon.normal)
        dominant = max(range(3), key=lambda axis: normal[axis])
        axes = ((1, 2), (0, 2), (0, 1))[dominant]
        for loop_index in polygon.loop_indices:
            vertex = mesh.vertices[mesh.loops[loop_index].vertex_index].co
            uv_layer.data[loop_index].uv = (vertex[axes[0]] / tile_m, vertex[axes[1]] / tile_m)


def create_prism(
    name: str,
    polygon_xy: Sequence[tuple[float, float]],
    thickness: float,
    center_z: float,
    material: bpy.types.Material,
    collection: bpy.types.Collection,
    parent: bpy.types.Object,
    *,
    asset_id: str,
    lod: int,
    floor: str,
    family: str,
) -> bpy.types.Object:
    """Create a convex vertical prism; input plan vertices must be CCW."""
    cleaned: list[tuple[float, float]] = []
    for point in polygon_xy:
        if not cleaned or math.hypot(point[0] - cleaned[-1][0], point[1] - cleaned[-1][1]) > 1e-7:
            cleaned.append(point)
    if len(cleaned) > 1 and math.hypot(cleaned[0][0] - cleaned[-1][0], cleaned[0][1] - cleaned[-1][1]) <= 1e-7:
        cleaned.pop()
    changed = True
    while changed and len(cleaned) >= 3:
        changed = False
        for index in range(len(cleaned)):
            previous = cleaned[index - 1]
            current = cleaned[index]
            following = cleaned[(index + 1) % len(cleaned)]
            cross = (current[0] - previous[0]) * (following[1] - current[1]) - (current[1] - previous[1]) * (following[0] - current[0])
            if abs(cross) <= 1e-8:
                cleaned.pop(index)
                changed = True
                break
    polygon_xy = cleaned
    if len(polygon_xy) < 3 or thickness <= 0.0:
        raise ValueError(f"{name}: prism needs a polygon and positive thickness")
    bottom = center_z - thickness * 0.5
    top = center_z + thickness * 0.5
    count = len(polygon_xy)
    vertices = [(x, y, bottom) for x, y in polygon_xy] + [(x, y, top) for x, y in polygon_xy]
    faces = []
    for index in range(1, count - 1):
        faces.append((0, index + 1, index))
        faces.append((count, count + index, count + index + 1))
    faces.extend((index, (index + 1) % count, (index + 1) % count + count, index + count) for index in range(count))
    mesh = bpy.data.meshes.new(f"{name}_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(material)
    mesh.update()
    assign_metric_planar_uv(mesh, float(MATERIAL_SPECS[family]["tile_m"]))
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    obj.parent = parent
    tag_object(obj, asset_id, lod, floor, family)
    return obj


def clip_polygon_to_rect(
    polygon: Sequence[tuple[float, float]],
    bounds: tuple[float, float, float, float],
) -> list[tuple[float, float]]:
    """Sutherland-Hodgman clip of a convex plan polygon to an axis-aligned cell."""
    min_x, max_x, min_y, max_y = bounds
    result = list(polygon)
    clips = (
        (lambda p: p[0] >= min_x, lambda a, b: (min_x, a[1] + (b[1] - a[1]) * (min_x - a[0]) / (b[0] - a[0]))),
        (lambda p: p[0] <= max_x, lambda a, b: (max_x, a[1] + (b[1] - a[1]) * (max_x - a[0]) / (b[0] - a[0]))),
        (lambda p: p[1] >= min_y, lambda a, b: (a[0] + (b[0] - a[0]) * (min_y - a[1]) / (b[1] - a[1]), min_y)),
        (lambda p: p[1] <= max_y, lambda a, b: (a[0] + (b[0] - a[0]) * (max_y - a[1]) / (b[1] - a[1]), max_y)),
    )
    for inside, intersect in clips:
        source = result
        result = []
        if not source:
            break
        previous = source[-1]
        previous_inside = inside(previous)
        for current in source:
            current_inside = inside(current)
            if current_inside != previous_inside:
                result.append(intersect(previous, current))
            if current_inside:
                result.append(current)
            previous, previous_inside = current, current_inside
    return result


def create_box(
    name: str,
    dimensions: tuple[float, float, float],
    location: tuple[float, float, float],
    material: bpy.types.Material,
    collection: bpy.types.Collection,
    parent: bpy.types.Object,
    *,
    asset_id: str,
    lod: int,
    floor: str,
    family: str,
    bevel: float = 0.0,
    rotation: tuple[float, float, float] | None = None,
) -> bpy.types.Object:
    dx, dy, dz = dimensions
    if min(dx, dy, dz) <= 0:
        raise ValueError(f"{name}: box dimensions must be positive")
    x = dx * 0.5
    y = dy * 0.5
    z = dz * 0.5
    vertices = [
        (-x, -y, -z), (x, -y, -z), (x, y, -z), (-x, y, -z),
        (-x, -y, z), (x, -y, z), (x, y, z), (-x, y, z),
    ]
    faces = [
        (0, 3, 2, 1),
        (4, 5, 6, 7),
        (0, 1, 5, 4),
        (3, 7, 6, 2),
        (0, 4, 7, 3),
        (1, 2, 6, 5),
    ]
    mesh = bpy.data.meshes.new(f"{name}_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(material)
    mesh.update()
    assign_metric_planar_uv(mesh, float(MATERIAL_SPECS[family]["tile_m"]))

    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    obj.location = location
    if rotation is not None:
        obj.rotation_euler = rotation
    obj.parent = parent
    tag_object(obj, asset_id, lod, floor, family)
    apply_identity(obj)

    if bevel > 0.0 and BEVEL_SEGMENTS_BY_LOD[lod] > 0:
        modifier = obj.modifiers.new("TZ_EdgeSoftening", "BEVEL")
        modifier.width = min(bevel, min(dimensions) * 0.2)
        modifier.segments = BEVEL_SEGMENTS_BY_LOD[lod]
        modifier.affect = "EDGES"
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.modifier_apply(modifier=modifier.name)
        obj.select_set(False)
    for polygon in obj.data.polygons:
        polygon.use_smooth = False
    return obj


def create_ramp_wedge(
    name: str,
    dimensions: tuple[float, float, float],
    location: tuple[float, float, float],
    material: bpy.types.Material,
    collection: bpy.types.Collection,
    parent: bpy.types.Object,
    *,
    asset_id: str,
    lod: int,
    floor: str,
    rise_positive_x: bool,
) -> bpy.types.Object:
    length, width, height = dimensions
    x0, x1 = -length * 0.5, length * 0.5
    if not rise_positive_x:
        x0, x1 = x1, x0
    y0, y1 = -width * 0.5, width * 0.5
    vertices = [
        (x0, y0, 0.0), (x0, y1, 0.0),
        (x1, y0, 0.0), (x1, y1, 0.0),
        (x1, y0, height), (x1, y1, height),
    ]
    faces = [(1, 3, 2, 0), (3, 5, 4, 2), (4, 5, 1, 0), (2, 4, 0), (5, 3, 1)]
    mesh = bpy.data.meshes.new(f"{name}_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(material)
    mesh.update()
    assign_metric_planar_uv(mesh, float(MATERIAL_SPECS["concrete"]["tile_m"]))
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    obj.location = location
    obj.parent = parent
    tag_object(obj, asset_id, lod, floor, "concrete")
    return obj


def create_beam_between(
    name: str,
    start: tuple[float, float, float],
    end: tuple[float, float, float],
    thickness: float,
    material: bpy.types.Material,
    collection: bpy.types.Collection,
    parent: bpy.types.Object,
    *,
    asset_id: str,
    lod: int,
    floor: str,
    family: str = "steel",
) -> bpy.types.Object:
    start_v = Vector(start)
    end_v = Vector(end)
    delta = end_v - start_v
    length = delta.length
    obj = create_box(
        name,
        (length, thickness, thickness),
        tuple((start_v + end_v) * 0.5),
        material,
        collection,
        parent,
        asset_id=asset_id,
        lod=lod,
        floor=floor,
        family=family,
        bevel=min(0.025, thickness * 0.12),
    )
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Vector((1.0, 0.0, 0.0)).rotation_difference(delta.normalized())
    return obj


def add_segmented_slab(
    name: str,
    z: float,
    thickness: float,
    holes: Sequence[tuple[float, float, float, float]],
    material: bpy.types.Material,
    collection: bpy.types.Collection,
    parent: bpy.types.Object,
    *,
    asset_id: str,
    lod: int,
    floor: str,
) -> None:
    footprint_x = [point[0] for point in FOOTPRINT_LOCAL_QUAD_M]
    footprint_y = [point[1] for point in FOOTPRINT_LOCAL_QUAD_M]
    x_edges = {min(footprint_x), max(footprint_x)}
    y_edges = {min(footprint_y), max(footprint_y)}
    for min_x, max_x, min_y, max_y in holes:
        x_edges.update((min_x, max_x))
        y_edges.update((min_y, max_y))
    xs = sorted(x_edges)
    ys = sorted(y_edges)
    part = 0
    for x0, x1 in zip(xs, xs[1:]):
        for y0, y1 in zip(ys, ys[1:]):
            cx = (x0 + x1) * 0.5
            cy = (y0 + y1) * 0.5
            if any(hx0 < cx < hx1 and hy0 < cy < hy1 for hx0, hx1, hy0, hy1 in holes):
                continue
            clipped = clip_polygon_to_rect(FOOTPRINT_LOCAL_QUAD_M, (x0, x1, y0, y1))
            if len(clipped) < 3:
                continue
            create_prism(
                f"{name}_{part:02d}",
                clipped,
                thickness,
                z,
                material,
                collection,
                parent,
                asset_id=asset_id,
                lod=lod,
                floor=floor,
                family="concrete",
            )
            part += 1


def complement_intervals(extent: tuple[float, float], openings: Iterable[tuple[float, float]]) -> list[tuple[float, float]]:
    minimum, maximum = extent
    cursor = minimum
    result: list[tuple[float, float]] = []
    for start, end in sorted(openings):
        start = max(minimum, start)
        end = min(maximum, end)
        if start > cursor:
            result.append((cursor, start))
        cursor = max(cursor, end)
    if cursor < maximum:
        result.append((cursor, maximum))
    return [(start, end) for start, end in result if end - start > 0.05]


def inclusive_grid_indices(last: int, stride: int) -> list[int]:
    """Return deterministic coarse grid indices while always retaining both ends."""
    return sorted(set(range(0, last + 1, stride)) | {0, last})


def add_long_facade(
    side: int,
    mats: dict[str, bpy.types.Material],
    collections: dict[str, bpy.types.Collection],
    parents: dict[str, bpy.types.Object],
    lod: int,
) -> None:
    asset_id = "fortress-shell"
    length, width = FOOTPRINT_M
    y = side * (width * 0.5 - 0.12)
    depth = 0.24
    gates = [(-22.4, -16.0), (-4.0, 4.0), (16.0, 22.4)] if side > 0 else [(-20.5, -13.8), (12.8, 20.5)]
    infill = complement_intervals((-length * 0.5, length * 0.5), gates)
    for index, (start, end) in enumerate(infill):
        family = "brick" if index % 2 == 0 else "cement_board"
        create_box(
            f"GroundFacade_{'N' if side > 0 else 'S'}_{index:02d}",
            (end - start, depth, 4.95),
            ((start + end) * 0.5, y, 2.475),
            mats[family],
            collections["ground"],
            parents["ground"],
            asset_id=asset_id,
            lod=lod,
            floor="ground",
            family=family,
            bevel=0.04 if lod == 0 else 0.0,
        )
    for index, (start, end) in enumerate(gates):
        create_box(
            f"GateHeader_{'N' if side > 0 else 'S'}_{index:02d}",
            (end - start, depth, 0.56),
            ((start + end) * 0.5, y, 5.18),
            mats["concrete"],
            collections["structure"],
            parents["structure"],
            asset_id=asset_id,
            lod=lod,
            floor="ground",
            family="concrete",
            bevel=0.035 if lod == 0 else 0.0,
        )

    # An open upper facade: parapet, window piers, and a head beam preserve
    # silhouette and sightlines without inventing a sealed warehouse wall.
    create_box(
        f"UpperParapet_{'N' if side > 0 else 'S'}",
        (length, depth, 1.05),
        (0.0, y, UPPER_LOCAL_Z_M + 0.7),
        mats["brick"],
        collections["floor-1"],
        parents["floor-1"],
        asset_id=asset_id,
        lod=lod,
        floor="floor-1",
        family="brick",
        bevel=0.025 if lod == 0 else 0.0,
    )
    pier_stride = 1 if lod == 0 else (2 if lod == 1 else 4)
    for grid in inclusive_grid_indices(LONGITUDINAL_GIRDERS - 1, pier_stride):
        x = ROOF_GIRDER_X_M[grid]
        create_box(
            f"UpperPier_{'N' if side > 0 else 'S'}_{grid:02d}",
            (0.44 if lod < 2 else 0.7, depth + 0.06, EAVE_LOCAL_Z_M - UPPER_LOCAL_Z_M - 1.4),
            (x, y, (EAVE_LOCAL_Z_M + UPPER_LOCAL_Z_M + 1.4) * 0.5),
            mats["concrete"],
            collections["structure"],
            parents["structure"],
            asset_id=asset_id,
            lod=lod,
            floor="floor-1",
            family="concrete",
            bevel=0.025 if lod == 0 else 0.0,
        )
    create_box(
        f"UpperHead_{'N' if side > 0 else 'S'}",
        (length, depth + 0.04, 0.55),
        (0.0, y, EAVE_LOCAL_Z_M - 0.275),
        mats["concrete"],
        collections["structure"],
        parents["structure"],
        asset_id=asset_id,
        lod=lod,
        floor="floor-1",
        family="concrete",
        bevel=0.03 if lod == 0 else 0.0,
    )
    if lod == 0:
        # Sparse cement-board closures create recognizable alternation while most
        # bays remain open.  North/south patterns are mirrored for a centered pivot.
        panels = (2, 8) if side > 0 else (2, 8)
        for grid in panels:
            x = (ROOF_GIRDER_X_M[grid] + ROOF_GIRDER_X_M[grid + 1]) * 0.5
            bay = ROOF_GIRDER_X_M[grid + 1] - ROOF_GIRDER_X_M[grid]
            create_box(
                f"CementClosure_{'N' if side > 0 else 'S'}_{grid:02d}",
                (bay - 0.52, 0.11, 2.7),
                (x, y - side * 0.13, UPPER_LOCAL_Z_M + 3.4),
                mats["cement_board"],
                collections["floor-1"],
                parents["floor-1"],
                asset_id=asset_id,
                lod=lod,
                floor="floor-1",
                family="cement_board",
                bevel=0.018,
            )


def add_end_facade(
    side: int,
    mats: dict[str, bpy.types.Material],
    collections: dict[str, bpy.types.Collection],
    parents: dict[str, bpy.types.Object],
    lod: int,
) -> None:
    asset_id = "fortress-shell"
    length, width = FOOTPRINT_M
    x = side * (length * 0.5 - 0.14)
    depth = 0.28
    gate_width = 8.4
    side_width = (width - gate_width) * 0.5
    for sign in (-1, 1):
        y = sign * (gate_width * 0.5 + side_width * 0.5)
        create_box(
            f"EndGroundInfill_{'E' if side > 0 else 'W'}_{sign:+d}",
            (depth, side_width, 5.0),
            (x, y, 2.5),
            mats["brick"],
            collections["ground"],
            parents["ground"],
            asset_id=asset_id,
            lod=lod,
            floor="ground",
            family="brick",
            bevel=0.04 if lod == 0 else 0.0,
        )
    create_box(
        f"EndGateHeader_{'E' if side > 0 else 'W'}",
        (depth + 0.08, gate_width, 0.65),
        (x, 0.0, 5.18),
        mats["concrete"],
        collections["structure"],
        parents["structure"],
        asset_id=asset_id,
        lod=lod,
        floor="ground",
        family="concrete",
        bevel=0.035 if lod == 0 else 0.0,
    )
    create_box(
        f"EndUpperParapet_{'E' if side > 0 else 'W'}",
        (depth, width, 1.05),
        (x, 0.0, UPPER_LOCAL_Z_M + 0.7),
        mats["cement_board"],
        collections["floor-1"],
        parents["floor-1"],
        asset_id=asset_id,
        lod=lod,
        floor="floor-1",
        family="cement_board",
        bevel=0.03 if lod == 0 else 0.0,
    )
    window_count = 4 if lod == 0 else (2 if lod == 1 else 1)
    for index in range(window_count + 1):
        y = -width * 0.5 + index * width / window_count
        create_box(
            f"EndUpperPier_{'E' if side > 0 else 'W'}_{index:02d}",
            (depth + 0.06, 0.5, EAVE_LOCAL_Z_M - UPPER_LOCAL_Z_M - 1.4),
            (x, y, (EAVE_LOCAL_Z_M + UPPER_LOCAL_Z_M + 1.4) * 0.5),
            mats["concrete"],
            collections["structure"],
            parents["structure"],
            asset_id=asset_id,
            lod=lod,
            floor="floor-1",
            family="concrete",
            bevel=0.025 if lod == 0 else 0.0,
        )


def add_stair(
    name: str,
    center: tuple[float, float],
    direction: int,
    mats: dict[str, bpy.types.Material],
    collection: bpy.types.Collection,
    parent: bpy.types.Object,
    lod: int,
) -> None:
    asset_id = "fortress-shell"
    run = 8.2
    width = 1.8
    steps = {0: 24, 1: 8, 2: 1}[lod]
    cx, cy = center
    if lod == 2:
        create_ramp_wedge(
            f"{name}_FarRamp",
            (run, width, UPPER_LOCAL_Z_M - 0.35),
            (cx, cy, 0.35),
            mats["concrete"],
            collection,
            parent,
            asset_id=asset_id,
            lod=lod,
            floor="floor-1",
            rise_positive_x=direction > 0,
        )
        return
    tread_depth = run / steps
    for index in range(steps):
        along = -run * 0.5 + (index + 0.5) * tread_depth
        x = cx + direction * along
        # create_box locations are centers; keep the tread top on the rise datum.
        z = (index + 1) * UPPER_LOCAL_Z_M / steps - 0.08
        create_box(
            f"{name}_Tread_{index:02d}",
            (tread_depth + 0.025, width, 0.16),
            (x, cy, z),
            mats["concrete"],
            collection,
            parent,
            asset_id=asset_id,
            lod=lod,
            floor="floor-1",
            family="concrete",
            bevel=0.018 if lod == 0 else 0.0,
        )
    for side in (-1, 1):
        create_beam_between(
            f"{name}_Stringer_{side:+d}",
            (cx - direction * run * 0.5, cy + side * width * 0.48, 0.3),
            (cx + direction * run * 0.5, cy + side * width * 0.48, UPPER_LOCAL_Z_M - 0.2),
            0.16,
            mats["steel"],
            collection,
            parent,
            asset_id=asset_id,
            lod=lod,
            floor="floor-1",
        )
    if lod == 0:
        for side in (-1, 1):
            for index in range(0, steps + 1, 3):
                along = -run * 0.5 + index * tread_depth
                x = cx + direction * along
                z = max(0.35, index * UPPER_LOCAL_Z_M / steps)
                create_box(
                    f"{name}_RailPost_{side:+d}_{index:02d}",
                    (0.055, 0.055, 1.02),
                    (x, cy + side * width * 0.5, z + 0.51),
                    mats["steel"],
                    collection,
                    parent,
                    asset_id=asset_id,
                    lod=lod,
                    floor="floor-1",
                    family="steel",
                    bevel=0.01,
                )


def add_roof_and_trusses(
    mats: dict[str, bpy.types.Material],
    collections: dict[str, bpy.types.Collection],
    parents: dict[str, bpy.types.Object],
    lod: int,
    structure_scalars: dict | None,
) -> None:
    asset_id = "fortress-shell"
    length, _ = FOOTPRINT_M

    if lod == 0:
        # Exact scalar rhythm: ten X spans, eight possible gabled rows, and 60
        # present panels.  The 20 absent cells are intentional roof openings.
        row_boundaries = [ROOF_SUPPORT_Y_M[0]]
        row_boundaries.extend(
            (left + right) * 0.5 for left, right in zip(ROOF_ROW_Y_M, ROOF_ROW_Y_M[1:])
        )
        row_boundaries.append(ROOF_SUPPORT_Y_M[1])
        row_z = tuple(value - GROUND_LOCAL_Z_M for value in ROOF_ROW_ROOT_LOCAL_Z_M)
        roof_specs: list[tuple[int, int, int, float, float, float]] = []
        scalar_roofs = scalar_category(structure_scalars, "roof")
        if scalar_roofs:
            column_centers = [
                (left + right) * 0.5
                for left, right in zip(ROOF_GIRDER_X_M, ROOF_GIRDER_X_M[1:])
            ]
            for index, anchor in enumerate(scalar_roofs):
                position = anchor["position"]
                column = min(range(len(column_centers)), key=lambda value: abs(column_centers[value] - position["x"]))
                row = min(range(len(ROOF_ROW_Y_M)), key=lambda value: abs(ROOF_ROW_Y_M[value] - position["y"]))
                roof_specs.append((index, column, row, position["x"], position["y"], position["z"] - GROUND_LOCAL_Z_M))
            scalar_cells = {(column, row) for _, column, row, _, _, _ in roof_specs}
            if (
                len(roof_specs) != 60
                or len(scalar_cells) != 60
                or any(not (0 <= column < 10 and 0 <= row < 8) for column, row in scalar_cells)
            ):
                raise ValueError(
                    "scalar roof anchors do not map bijectively onto 60 unique cells in the 10x8 roof grid"
                )
        else:
            index = 0
            for column, rows in enumerate(ROOF_PANEL_ROWS_BY_COLUMN):
                x = (ROOF_GIRDER_X_M[column] + ROOF_GIRDER_X_M[column + 1]) * 0.5
                for row in rows:
                    roof_specs.append((index, column, row, x, ROOF_ROW_Y_M[row], row_z[row]))
                    index += 1

        for index, column, row, x, y, z in roof_specs:
            x0 = ROOF_GIRDER_X_M[column]
            x1 = ROOF_GIRDER_X_M[column + 1]
            panel_length = x1 - x0
            if row == 0:
                dz_dy = (row_z[1] - row_z[0]) / (ROOF_ROW_Y_M[1] - ROOF_ROW_Y_M[0])
            elif row == len(ROOF_ROW_Y_M) - 1:
                dz_dy = (row_z[-1] - row_z[-2]) / (ROOF_ROW_Y_M[-1] - ROOF_ROW_Y_M[-2])
            else:
                dz_dy = (row_z[row + 1] - row_z[row - 1]) / (ROOF_ROW_Y_M[row + 1] - ROOF_ROW_Y_M[row - 1])
            angle = math.atan(dz_dy)
            planar_width = row_boundaries[row + 1] - row_boundaries[row]
            slope_width = planar_width / max(0.1, math.cos(angle))
            family = roof_material_family(column, row)
            panel = create_box(
                f"RoofPanel_{index:02d}_C{column:02d}_R{row:02d}",
                (panel_length - 0.10, slope_width - 0.045, 0.13),
                (x, y, z),
                mats[family],
                collections["roof"],
                parents["roof"],
                asset_id=asset_id,
                lod=lod,
                floor="roof",
                family=family,
                bevel=0.012,
                rotation=(angle, 0.0, 0.0),
            )
            panel["tz_scalar_anchor"] = bool(scalar_roofs)
            panel["tz_material_variation_status"] = "original-authored-not-measured"
            panel["tz_weathering_family"] = family
            offset_uv_phase(
                panel,
                hash01(column, row, 373379) * 0.83,
                hash01(column, row, 389171) * 0.79,
            )
    else:
        # Coarser LODs retain the long checker/gable read with materially fewer
        # panels.  LOD1 keeps four deliberate holes; LOD2 keeps only two slopes.
        x_segments = 5 if lod == 1 else 1
        y_edges = (
            (ROOF_SUPPORT_Y_M[0], -6.0, 0.04, 6.0, ROOF_SUPPORT_Y_M[1])
            if lod == 1
            else (ROOF_SUPPORT_Y_M[0], 0.04, ROOF_SUPPORT_Y_M[1])
        )
        ridge = RIDGE_LOCAL_Z_M
        z_edges = (
            (EAVE_LOCAL_Z_M, 16.35, ridge, 16.35, EAVE_LOCAL_Z_M)
            if lod == 1
            else (EAVE_LOCAL_Z_M, ridge, EAVE_LOCAL_Z_M)
        )
        omissions = {(0, 1), (1, 2), (3, 1), (4, 2)} if lod == 1 else set()
        for column in range(x_segments):
            x0 = -length * 0.5 + column * length / x_segments
            x1 = -length * 0.5 + (column + 1) * length / x_segments
            for row, ((y0, y1), (z0, z1)) in enumerate(zip(zip(y_edges, y_edges[1:]), zip(z_edges, z_edges[1:]))):
                if (column, row) in omissions:
                    continue
                angle = math.atan2(z1 - z0, y1 - y0)
                family = roof_material_family(column, row)
                panel = create_box(
                    f"RoofPanel_C{column:02d}_R{row:02d}",
                    (x1 - x0 - (0.08 if lod == 1 else 0.0), math.hypot(y1 - y0, z1 - z0), 0.18),
                    ((x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5),
                    mats[family],
                    collections["roof"],
                    parents["roof"],
                    asset_id=asset_id,
                    lod=lod,
                    floor="roof",
                    family=family,
                    rotation=(angle, 0.0, 0.0),
                )
                panel["tz_material_variation_status"] = "original-authored-not-measured"
                panel["tz_weathering_family"] = family
                offset_uv_phase(
                    panel,
                    hash01(column, row, 373379) * 0.83,
                    hash01(column, row, 389171) * 0.79,
                )

    full_profile = [(ROOF_SUPPORT_Y_M[0], EAVE_LOCAL_Z_M)]
    full_profile.extend(
        (y, z - GROUND_LOCAL_Z_M)
        for y, z in zip(ROOF_ROW_Y_M, ROOF_ROW_ROOT_LOCAL_Z_M)
    )
    full_profile.append((ROOF_SUPPORT_Y_M[1], EAVE_LOCAL_Z_M))
    if lod == 0:
        scalar_girders = scalar_category(structure_scalars, "girder")
        girder_positions = (
            [(index, entry["position"]["x"]) for index, entry in enumerate(scalar_girders)]
            if scalar_girders
            else list(enumerate(ROOF_GIRDER_X_M))
        )
        chord_profile = full_profile
    elif lod == 1:
        girder_positions = [(index, ROOF_GIRDER_X_M[index]) for index in inclusive_grid_indices(LONGITUDINAL_GIRDERS - 1, 2)]
        chord_profile = [full_profile[index] for index in (0, 2, 4, 5, 7, 9)]
    else:
        girder_positions = [(0, ROOF_GIRDER_X_M[0]), (LONGITUDINAL_GIRDERS - 1, ROOF_GIRDER_X_M[-1])]
        chord_profile = [full_profile[0], (0.04, RIDGE_LOCAL_Z_M), full_profile[-1]]

    for grid, x in girder_positions:
        girder = create_empty(f"RoofGirder_{grid:02d}", collections["roof"], parent=parents["roof"])
        girder["tz_asset_id"] = asset_id
        girder["tz_lod"] = lod
        girder["tz_floor"] = "roof"
        girder["tz_scalar_census_member"] = lod == 0
        create_beam_between(
            f"RoofGirder_{grid:02d}_Tie",
            (x, ROOF_SUPPORT_Y_M[0], EAVE_LOCAL_Z_M),
            (x, ROOF_SUPPORT_Y_M[1], EAVE_LOCAL_Z_M),
            0.18 if lod == 0 else 0.25,
            mats["steel"],
            collections["roof"],
            girder,
            asset_id=asset_id,
            lod=lod,
            floor="roof",
        )
        for member, ((y0, z0), (y1, z1)) in enumerate(zip(chord_profile, chord_profile[1:])):
            create_beam_between(
                f"RoofGirder_{grid:02d}_Chord_{member:02d}",
                (x, y0, z0), (x, y1, z1),
                0.20 if lod == 0 else 0.28,
                mats["steel"], collections["roof"], girder,
                asset_id=asset_id, lod=lod, floor="roof",
            )
        if lod < 2:
            web_rows = (2, 4, 5, 7) if lod == 0 else (3, 6)
            for index, profile_index in enumerate(web_rows):
                y, roof_z = full_profile[profile_index]
                target_index = min(len(full_profile) - 2, profile_index + (1 if index % 2 == 0 else -1))
                target_y, target_z = full_profile[target_index]
                create_beam_between(
                    f"RoofGirder_{grid:02d}_Web_{index}",
                    (x, y, EAVE_LOCAL_Z_M),
                    (x, target_y, target_z),
                    0.12 if lod == 0 else 0.18,
                    mats["steel"],
                    collections["roof"],
                    girder,
                    asset_id=asset_id,
                    lod=lod,
                    floor="roof",
                )


def add_floor_edge_rails(
    mats: dict[str, bpy.types.Material],
    collection: bpy.types.Collection,
    parent: bpy.types.Object,
    lod: int,
) -> None:
    if lod != 0:
        return
    asset_id = "fortress-shell"
    length, width = FOOTPRINT_M
    z0 = UPPER_LOCAL_Z_M
    rail_z = z0 + 1.1
    # Long rails are split at the two stair openings.
    long_segments = [(-length * 0.5, -21.5), (-12.5, 12.5), (21.5, length * 0.5)]
    for side in (-1, 1):
        y = side * (width * 0.5 - 0.65)
        for index, (x0, x1) in enumerate(long_segments):
            create_beam_between(
                f"UpperRail_{'N' if side > 0 else 'S'}_{index}",
                (x0, y, rail_z), (x1, y, rail_z), 0.065,
                mats["steel"], collection, parent,
                asset_id=asset_id, lod=lod, floor="floor-1",
            )
        for post, x in enumerate(ROOF_GIRDER_X_M):
            create_box(
                f"UpperRailPost_{'N' if side > 0 else 'S'}_{post:02d}",
                (0.065, 0.065, 1.1), (x, y, z0 + 0.55),
                mats["steel"], collection, parent,
                asset_id=asset_id, lod=lod, floor="floor-1", family="steel", bevel=0.01,
            )


def add_scalar_guided_modules(
    structure_scalars: dict,
    mats: dict[str, bpy.types.Material],
    collections: dict[str, bpy.types.Collection],
    parents: dict[str, bpy.types.Object],
    *,
    domain: str,
    lod: int,
) -> int:
    """Seat original generic modules on reviewed scalar origins.

    The recipe has transforms but intentionally no source bounds/topology.  These
    dimensions are therefore ours: conservative industrial modules that expose
    the correct center/layout rhythm without pretending the missing extents were
    measured.  Original source names and quaternions are not exported.
    """
    if domain not in {"shell", "basement"}:
        raise ValueError(f"unknown scalar module domain {domain}")
    category_contract = {
        "beam": ("concrete", (5.65, 0.28, 0.36)),
        "metal-beam": ("steel", (5.65, 0.24, 0.28)),
        "pillar": ("concrete", (0.48, 0.48, 3.15)),
        "column": ("concrete", (0.46, 0.46, 2.8)),
        "brick-wall": ("brick", (5.55, 0.24, 2.45)),
        "concrete-wall": ("concrete", (5.55, 0.30, 2.65)),
        "cement-board": ("cement_board", (5.65, 0.12, 2.35)),
    }
    base_z = GROUND_LOCAL_Z_M if domain == "shell" else BASEMENT_LOCAL_Z_M
    created = 0
    for category, (family, default_dimensions) in category_contract.items():
        for anchor in scalar_category(structure_scalars, category):
            position = anchor["position"]
            if all(abs(position[axis]) < 1e-9 for axis in ("x", "y", "z")):
                continue
            if domain == "shell" and position["z"] < 0.0:
                continue
            if domain == "basement" and position["z"] >= 0.0:
                continue

            x, y = position["x"], position["y"]
            dx, dy, dz = default_dimensions
            # Boundary anchors tell us the panel's authored plan orientation.
            # Interior quaternions are deliberately not copied; a conservative
            # nearest-boundary rule keeps this factory independent of source mesh axes.
            if category in {"beam", "metal-beam", "brick-wall", "concrete-wall", "cement-board"}:
                if abs(x) > 24.0:
                    dx, dy = dy, max(3.2, min(5.65, FOOTPRINT_M[1] / 4.0))
                elif abs(y) <= 9.0 and abs(x) <= 24.0:
                    dx, dy = dy, max(3.2, min(5.65, FOOTPRINT_M[1] / 4.0))
            # A center near the surveyed envelope edge must not turn a generic
            # authored extent into a 5 m footprint error.
            max_x = FOOTPRINT_M[0] * 0.5 + 0.35
            max_y = FOOTPRINT_M[1] * 0.5 + 0.35
            dx = min(dx, max(0.12, 2.0 * (max_x - abs(x))))
            dy = min(dy, max(0.10, 2.0 * (max_y - abs(y))))
            local_center_z = position["z"] - base_z
            if domain == "shell":
                # Extents are authored hypotheses, so never use one to invent an
                # unevidenced below-ground room volume beneath an above-ground anchor.
                dz = min(dz, 2.0 * local_center_z)
                if dz < 0.12:
                    continue
            floor = "underground" if domain == "basement" else (
                "floor-1" if position["z"] >= UPPER_WORLD_Y_M - EFT_ROOT_CENTER_M[1] - 0.75 else "ground"
            )
            collection_key = "underground" if domain == "basement" else floor
            module = create_box(
                f"ScalarModule_{category.replace('-', '_')}_{created:03d}",
                (dx, dy, dz),
                (x, y, local_center_z),
                mats[family],
                collections[collection_key],
                parents[collection_key],
                asset_id="zb013-basement" if domain == "basement" else "fortress-shell",
                lod=lod,
                floor=floor,
                family=family,
                bevel=(0.035 if family in {"concrete", "brick"} else 0.018) if lod < 2 else 0.0,
            )
            module["tz_scalar_category"] = category
            module["tz_scalar_anchor_index"] = created
            module["tz_dimensions_status"] = "original-authored-hypothesis"
            created += 1
    return created


def build_fortress_shell(
    lod: int,
    mats: dict[str, bpy.types.Material],
    structure_scalars: dict | None,
) -> bpy.types.Object:
    asset_id = "fortress-shell"
    root_collection = link_collection(f"TZ_FortressShell_LOD{lod}")
    labels = {
        "ground": "FLOOR_ground",
        "floor-1": "FLOOR_floor-1",
        "roof": "FLOOR_roof",
        "structure": "STRUCTURE_shared",
    }
    collections = {key: link_collection(value, root_collection) for key, value in labels.items()}
    root = create_empty(f"TZ_FortressShell_LOD{lod}_ROOT", root_collection)
    root.location.z = GROUND_LOCAL_Z_M
    root["tz_asset_id"] = asset_id
    root["tz_pivot"] = "origin"
    root["tz_units"] = "metre"
    root["tz_gltf_up"] = "+y"
    root["tz_gltf_forward"] = "+x"
    root["tz_canonical_eft_yaw_deg"] = EFT_YAW_DEG
    root["tz_tactical_certified"] = False
    root["tz_collision_certified"] = False
    root["tz_footprint_local_quad_json"] = json.dumps(FOOTPRINT_LOCAL_QUAD_M)
    root["tz_ground_surface_local_y"] = 0.0
    root["tz_upper_surface_local_y"] = UPPER_LOCAL_Z_M
    root["tz_roof_material_variation_status"] = "original-authored-not-measured"
    root["tz_truth_roof_panel_count"] = 60
    root["tz_truth_girder_count"] = 11
    root["tz_truth_metal_support_count"] = 22
    root["tz_truth_stair_count"] = 2
    root["tz_truth_ramp_count"] = 4
    root["tz_structure_scalars_sha256"] = (
        f"sha256:{structure_scalars['sha256']}" if structure_scalars is not None else "built-in-reviewed-anchors"
    )
    parents = {key: create_empty(labels[key], collections[key], parent=root) for key in labels}
    for floor, parent in parents.items():
        parent["tz_floor"] = floor if floor != "structure" else "shared"

    create_prism(
        "GroundSlab",
        FOOTPRINT_LOCAL_QUAD_M,
        0.30,
        -0.15,
        mats["concrete"], collections["ground"], parents["ground"],
        asset_id=asset_id, lod=lod, floor="ground", family="concrete",
    )
    stair_holes = [(-14.8, -6.0, -8.2, -3.9), (17.8, 26.8, 4.0, 8.2)]
    if lod == 2:
        stair_holes = []
    add_segmented_slab(
        "UpperSlab", UPPER_LOCAL_Z_M - 0.19, 0.38, stair_holes,
        mats["concrete"], collections["floor-1"], parents["floor-1"],
        asset_id=asset_id, lod=lod, floor="floor-1",
    )

    column_stride = 1 if lod < 2 else 3
    scalar_supports = scalar_category(structure_scalars, "metal-support") if lod == 0 else []
    if scalar_supports:
        support_positions = [
            (index, entry["position"]["x"], entry["position"]["y"])
            for index, entry in enumerate(scalar_supports)
        ]
    else:
        support_positions = []
        for grid in inclusive_grid_indices(LONGITUDINAL_GIRDERS - 1, column_stride):
            for y in ROOF_SUPPORT_Y_M:
                support_positions.append((len(support_positions), ROOF_GIRDER_X_M[grid], y))
    for support_index, x, y in support_positions:
        side_label = "N" if y > 0 else "S"
        create_box(
            f"RoofSupport_{support_index:02d}_{side_label}",
            (0.34 if lod < 2 else 0.58, 0.34 if lod < 2 else 0.58, EAVE_LOCAL_Z_M),
            (x, y, EAVE_LOCAL_Z_M * 0.5),
            mats["steel"], collections["structure"], parents["structure"],
            asset_id=asset_id, lod=lod, floor="ground", family="steel", bevel=0.035 if lod == 0 else 0.0,
        )
    if structure_scalars is not None:
        root["tz_scalar_guided_module_count"] = add_scalar_guided_modules(
            structure_scalars,
            mats,
            collections,
            parents,
            domain="shell",
            lod=lod,
        )
    else:
        for grid in (2, 5, 8):
            if lod != 0:
                continue
            x = ROOF_GIRDER_X_M[grid]
            for y in (-3.8, 3.8):
                create_box(
                    f"InteriorColumn_{grid:02d}_{y:+.1f}",
                    (0.52, 0.52, EAVE_LOCAL_Z_M), (x, y, EAVE_LOCAL_Z_M * 0.5),
                    mats["concrete"], collections["structure"], parents["structure"],
                    asset_id=asset_id, lod=lod, floor="ground", family="concrete", bevel=0.05,
                )

        for side in (-1, 1):
            add_long_facade(side, mats, collections, parents, lod)
            add_end_facade(side, mats, collections, parents, lod)

    add_stair("WestStair", (-10.344, -5.953), 1, mats, collections["floor-1"], parents["floor-1"], lod)
    add_stair("EastStair", (22.348, 6.046), -1, mats, collections["floor-1"], parents["floor-1"], lod)

    # Four scalar-seated exterior loading ramps remain in every LOD because they
    # materially affect the walkable silhouette.
    scalar_ramps = scalar_category(structure_scalars, "ramp")
    ramp_centers = (
        [(entry["position"]["x"], entry["position"]["y"]) for entry in scalar_ramps]
        if scalar_ramps
        else [(-9.007, 14.887), (14.998, 14.887), (14.998, -14.764), (-3.006, -14.764)]
    )
    for index, (x, y) in enumerate(ramp_centers):
        ramp = create_ramp_wedge(
            f"LoadingRamp_{index + 1}", (3.6, 4.8, 0.85), (x, y, 0.0),
            mats["concrete"], collections["ground"], parents["ground"],
            asset_id=asset_id, lod=lod, floor="ground", rise_positive_x=(index % 2 == 0),
        )
        ramp.rotation_euler.z = math.radians(90.0)

    add_roof_and_trusses(mats, collections, parents, lod, structure_scalars)
    add_floor_edge_rails(mats, collections["floor-1"], parents["floor-1"], lod)
    return root


def add_basement_corridor_shell(
    mats: dict[str, bpy.types.Material],
    collection: bpy.types.Collection,
    parent: bpy.types.Object,
    lod: int,
    *,
    include_hypothesis_interior: bool,
) -> None:
    asset_id = "zb013-basement"
    length, width = BASEMENT_FOOTPRINT_M
    clear_height = 3.65
    slab = 0.28
    wall = 0.30 if lod < 2 else 0.42
    create_box(
        "BasementFloor", (length, width, slab), (0.0, 0.0, -slab * 0.5),
        mats["concrete"], collection, parent,
        asset_id=asset_id, lod=lod, floor="underground", family="concrete", bevel=0.035 if lod == 0 else 0.0,
    )
    create_box(
        "BasementCeiling", (length, width, slab), (0.0, 0.0, clear_height + slab * 0.5),
        mats["concrete"], collection, parent,
        asset_id=asset_id, lod=lod, floor="underground", family="concrete", bevel=0.025 if lod == 0 else 0.0,
    )
    for side in (-1, 1):
        create_box(
            f"BasementLongWall_{'N' if side > 0 else 'S'}", (length, wall, clear_height),
            (0.0, side * (width * 0.5 - wall * 0.5), clear_height * 0.5),
            mats["concrete"], collection, parent,
            asset_id=asset_id, lod=lod, floor="underground", family="concrete", bevel=0.025 if lod == 0 else 0.0,
        )
    # End walls preserve two broad access openings instead of sealing the asset.
    for end in (-1, 1):
        for side in (-1, 1):
            segment_width = (width - 3.2) * 0.5
            y = side * (3.2 * 0.5 + segment_width * 0.5)
            create_box(
                f"BasementEndWall_{'E' if end > 0 else 'W'}_{side:+d}",
                (wall, segment_width, clear_height),
                (end * (length * 0.5 - wall * 0.5), y, clear_height * 0.5),
                mats["concrete"], collection, parent,
                asset_id=asset_id, lod=lod, floor="underground", family="concrete", bevel=0.025 if lod == 0 else 0.0,
            )
        create_box(
            f"BasementDoorHeader_{'E' if end > 0 else 'W'}",
            (wall + 0.04, 3.2, 0.62),
            (end * (length * 0.5 - wall * 0.5), 0.0, clear_height - 0.31),
            mats["concrete"], collection, parent,
            asset_id=asset_id, lod=lod, floor="underground", family="concrete",
        )

    if lod < 2 and include_hypothesis_interior:
        # Symmetric service-room partitions retain a clear central navigation lane.
        room_x = 7.4
        for x in (-room_x, room_x):
            for side in (-1, 1):
                y0 = side * 4.2
                create_box(
                    f"ServicePartition_{x:+.1f}_{side:+d}", (wall, 4.2, clear_height - 0.18),
                    (x, y0, (clear_height - 0.18) * 0.5),
                    mats["brick"], collection, parent,
                    asset_id=asset_id, lod=lod, floor="underground", family="brick", bevel=0.018 if lod == 0 else 0.0,
                )
        # Four square support piers, mirrored around the pivot.
        for x in (-4.1, 4.1):
            for y in (-3.25, 3.25):
                create_box(
                    f"BasementPier_{x:+.1f}_{y:+.2f}", (0.5, 0.5, clear_height), (x, y, clear_height * 0.5),
                    mats["concrete"], collection, parent,
                    asset_id=asset_id, lod=lod, floor="underground", family="concrete", bevel=0.045 if lod == 0 else 0.0,
                )

    if lod == 0:
        # Original generic utility detail: conduits and an unbranded power cabinet.
        for side in (-1, 1):
            create_beam_between(
                f"UtilityConduit_{'N' if side > 0 else 'S'}",
                (-11.6, side * 10.05, 2.95), (11.6, side * 10.05, 2.95), 0.09,
                mats["steel"], collection, parent,
                asset_id=asset_id, lod=lod, floor="underground",
            )
        for x in (-10.5, 10.5):
            create_box(
                f"PowerCabinet_{x:+.1f}", (0.55, 1.1, 1.55), (x, -9.75, 0.9),
                mats["steel"], collection, parent,
                asset_id=asset_id, lod=lod, floor="underground", family="steel", bevel=0.045,
            )


def build_basement(
    lod: int,
    mats: dict[str, bpy.types.Material],
    structure_scalars: dict | None,
) -> bpy.types.Object:
    asset_id = "zb013-basement"
    root_collection = link_collection(f"TZ_ZB013Basement_LOD{lod}")
    underground = link_collection("FLOOR_underground", root_collection)
    root = create_empty(f"TZ_ZB013Basement_LOD{lod}_ROOT", root_collection)
    root.location.z = 0.0
    root["tz_asset_id"] = asset_id
    root["tz_pivot"] = "origin"
    root["tz_units"] = "metre"
    root["tz_gltf_up"] = "+y"
    root["tz_gltf_forward"] = "+x"
    root["tz_canonical_eft_yaw_deg"] = BASEMENT_YAW_DEG
    root["tz_tactical_certified"] = False
    root["tz_collision_certified"] = False
    root["tz_ground_surface_local_y"] = 0.0
    root["tz_authorship_status"] = "original-authored-hypothesis"
    root["tz_structure_scalars_sha256"] = (
        f"sha256:{structure_scalars['sha256']}" if structure_scalars is not None else "built-in-reviewed-anchors"
    )
    floor_parent = create_empty("FLOOR_underground", underground, parent=root)
    floor_parent["tz_floor"] = "underground"
    add_basement_corridor_shell(
        mats,
        underground,
        floor_parent,
        lod,
        include_hypothesis_interior=True,
    )
    return root


def evaluated_geometry_stats() -> dict[str, int]:
    depsgraph = bpy.context.evaluated_depsgraph_get()
    vertices = 0
    triangles = 0
    mesh_objects = 0
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        mesh_objects += 1
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        mesh.calc_loop_triangles()
        vertices += len(mesh.vertices)
        triangles += len(mesh.loop_triangles)
        evaluated.to_mesh_clear()
    return {"meshObjects": mesh_objects, "vertices": vertices, "triangles": triangles}


def batch_meshes_for_export() -> dict[str, int]:
    """Join non-roof-panel meshes by collection, floor, and material.

    Roof panels remain distinct so their measured 60-cell presence ledger stays
    inspectable. The remaining static shell geometry gains no runtime value from
    hundreds of one-box draw calls.
    """
    groups: dict[tuple[str, str, str, str], list[bpy.types.Object]] = {}
    preserved = 0
    preserved_roof = 0
    preserved_contract = 0
    for obj in list(bpy.context.scene.objects):
        if obj.type != "MESH":
            continue
        if obj.name.startswith("RoofPanel_") or obj.name == "GroundSlab" or obj.name == "BasementFloor" or obj.name.startswith("UpperSlab_"):
            preserved += 1
            if obj.name.startswith("RoofPanel_"):
                preserved_roof += 1
            else:
                preserved_contract += 1
            continue
        collection_name = sorted(collection.name for collection in obj.users_collection)[0]
        floor = str(obj.get("tz_floor", "shared"))
        family = str(obj.get("tz_material_family", "unknown"))
        parent_name = obj.parent.name if obj.parent is not None else "scene"
        groups.setdefault((collection_name, floor, family, parent_name), []).append(obj)

    source_meshes = sum(len(objects) for objects in groups.values()) + preserved
    for (collection_name, floor, family, parent_name), objects in sorted(groups.items()):
        objects.sort(key=lambda obj: obj.name)
        scalar_categories = Counter(
            str(obj["tz_scalar_category"])
            for obj in objects
            if "tz_scalar_category" in obj
        )
        # Bake each local transform while its original parent is still intact.
        # Joining rotated active objects directly can otherwise introduce a small
        # parent-space drift even when Blender reports a successful join.
        for obj in objects:
            bpy.ops.object.select_all(action="DESELECT")
            obj.select_set(True)
            bpy.context.view_layer.objects.active = obj
            result = bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
            if result != {"FINISHED"}:
                raise RuntimeError(f"transform bake failed before batching {obj.name}: {result}")
            obj.select_set(False)
        bpy.ops.object.select_all(action="DESELECT")
        active = objects[0]
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = active
        if len(objects) > 1:
            result = bpy.ops.object.join()
            if result != {"FINISHED"}:
                raise RuntimeError(
                    f"mesh batching failed for {collection_name}/{floor}/{family}/{parent_name}: {result}"
                )
        safe_collection = "".join(character if character.isalnum() else "_" for character in collection_name)
        safe_floor = "".join(character if character.isalnum() else "_" for character in floor)
        safe_parent = "".join(character if character.isalnum() else "_" for character in parent_name)
        active.name = f"BATCH_{safe_collection}_{safe_floor}_{family}_{safe_parent}"
        active.data.name = f"{active.name}_Mesh"
        active["tz_floor"] = floor
        active["tz_material_family"] = family
        active["tz_batch_members"] = len(objects)
        if scalar_categories:
            active["tz_scalar_category_counts"] = json.dumps(dict(sorted(scalar_categories.items())))
            active["tz_dimensions_status"] = "original-authored-hypothesis"
        active.select_set(False)
    bpy.context.view_layer.objects.active = None
    return {
        "sourceMeshObjects": source_meshes,
        "preservedRoofPanelMeshes": preserved_roof,
        "preservedContractMeshes": preserved_contract,
        "staticBatches": len(groups),
    }


def blender_bounds() -> dict[str, list[float]]:
    depsgraph = bpy.context.evaluated_depsgraph_get()
    minimum = Vector((math.inf, math.inf, math.inf))
    maximum = Vector((-math.inf, -math.inf, -math.inf))
    found = False
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        evaluated = obj.evaluated_get(depsgraph)
        for corner in evaluated.bound_box:
            point = evaluated.matrix_world @ Vector(corner)
            for axis in range(3):
                minimum[axis] = min(minimum[axis], point[axis])
                maximum[axis] = max(maximum[axis], point[axis])
            found = True
    if not found:
        raise RuntimeError("asset has no mesh bounds")
    return {
        "min": [round(value, 6) for value in minimum],
        "max": [round(value, 6) for value in maximum],
        "size": [round(maximum[i] - minimum[i], 6) for i in range(3)],
        "center": [round((maximum[i] + minimum[i]) * 0.5, 6) for i in range(3)],
    }


def gltf_bounds_from_blender(bounds: dict[str, list[float]]) -> dict[str, list[float]]:
    # Blender exporter conversion: (x, y, z) -> glTF (x, z, -y).
    corners = []
    for x in (bounds["min"][0], bounds["max"][0]):
        for y in (bounds["min"][1], bounds["max"][1]):
            for z in (bounds["min"][2], bounds["max"][2]):
                corners.append((x, z, -y))
    minimum = [min(point[axis] for point in corners) for axis in range(3)]
    maximum = [max(point[axis] for point in corners) for axis in range(3)]
    return {
        "min": [round(value, 6) for value in minimum],
        "max": [round(value, 6) for value in maximum],
        "sizeM": [round(maximum[i] - minimum[i], 6) for i in range(3)],
        "centerM": [round((maximum[i] + minimum[i]) * 0.5, 6) for i in range(3)],
    }


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def matrix_multiply(left: Sequence[Sequence[float]], right: Sequence[Sequence[float]]) -> list[list[float]]:
    return [[sum(left[row][k] * right[k][column] for k in range(4)) for column in range(4)] for row in range(4)]


def node_matrix(node: dict) -> list[list[float]]:
    if "matrix" in node:
        values = node["matrix"]
        if not isinstance(values, list) or len(values) != 16:
            raise ValueError("glTF node matrix must have 16 values")
        return [[float(values[column * 4 + row]) for column in range(4)] for row in range(4)]
    x, y, z, w = (float(value) for value in node.get("rotation", [0.0, 0.0, 0.0, 1.0]))
    sx, sy, sz = (float(value) for value in node.get("scale", [1.0, 1.0, 1.0]))
    tx, ty, tz = (float(value) for value in node.get("translation", [0.0, 0.0, 0.0]))
    rotation = [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ]
    return [
        [rotation[0][0] * sx, rotation[0][1] * sy, rotation[0][2] * sz, tx],
        [rotation[1][0] * sx, rotation[1][1] * sy, rotation[1][2] * sz, ty],
        [rotation[2][0] * sx, rotation[2][1] * sy, rotation[2][2] * sz, tz],
        [0.0, 0.0, 0.0, 1.0],
    ]


def exported_glb_stats(path: Path) -> dict:
    blob = path.read_bytes()
    if len(blob) < 20 or blob[:4] != b"glTF":
        raise ValueError(f"exported GLB is invalid: {path}")
    _, version, declared_length = struct.unpack_from("<4sII", blob, 0)
    if version != 2 or declared_length != len(blob):
        raise ValueError(f"exported GLB header is invalid: {path}")
    chunk_length, chunk_type = struct.unpack_from("<II", blob, 12)
    if chunk_type != 0x4E4F534A:
        raise ValueError(f"exported GLB JSON chunk is absent: {path}")
    document = json.loads(blob[20:20 + chunk_length].decode("utf-8"))
    accessors = document.get("accessors", [])
    meshes = document.get("meshes", [])
    nodes = document.get("nodes", [])
    triangles = 0
    minimum = [math.inf, math.inf, math.inf]
    maximum = [-math.inf, -math.inf, -math.inf]
    identity = [[1.0 if row == column else 0.0 for column in range(4)] for row in range(4)]

    def transform_point(matrix: Sequence[Sequence[float]], point: tuple[float, float, float]) -> tuple[float, float, float]:
        return tuple(sum(matrix[row][column] * (*point, 1.0)[column] for column in range(4)) for row in range(3))

    def visit(index: int, parent_matrix: Sequence[Sequence[float]]) -> None:
        nonlocal triangles
        node = nodes[index]
        world = matrix_multiply(parent_matrix, node_matrix(node))
        if "mesh" in node:
            for primitive in meshes[node["mesh"]].get("primitives", []):
                count_accessor = primitive.get("indices", primitive.get("attributes", {}).get("POSITION"))
                count = int(accessors[count_accessor]["count"])
                mode = int(primitive.get("mode", 4))
                triangles += count // 3 if mode == 4 else max(0, count - 2) if mode in (5, 6) else 0
                position = accessors[primitive.get("attributes", {}).get("POSITION")]
                low, high = position.get("min"), position.get("max")
                if not (isinstance(low, list) and isinstance(high, list) and len(low) == len(high) == 3):
                    raise ValueError("exported POSITION accessor lacks finite bounds")
                for px in (float(low[0]), float(high[0])):
                    for py in (float(low[1]), float(high[1])):
                        for pz in (float(low[2]), float(high[2])):
                            transformed = transform_point(world, (px, py, pz))
                            for axis in range(3):
                                minimum[axis] = min(minimum[axis], transformed[axis])
                                maximum[axis] = max(maximum[axis], transformed[axis])
        for child in node.get("children", []):
            visit(int(child), world)

    scene_index = int(document.get("scene", 0))
    for root_node in document.get("scenes", [{}])[scene_index].get("nodes", []):
        visit(int(root_node), identity)
    if not all(math.isfinite(value) for value in minimum + maximum):
        raise ValueError("exported GLB contains no bounded POSITION geometry")
    return {
        "triangles": triangles,
        "materials": len(document.get("materials", [])),
        "images": len(document.get("images", [])),
        "boundsM": {
            "min": [round(value, 6) for value in minimum],
            "max": [round(value, 6) for value in maximum],
            "sizeM": [round(maximum[axis] - minimum[axis], 6) for axis in range(3)],
            "centerM": [round((maximum[axis] + minimum[axis]) * 0.5, 6) for axis in range(3)],
        },
    }


def export_glb(output: Path) -> None:
    output = output.expanduser().resolve()
    if output.suffix.lower() != ".glb":
        raise ValueError("--output must use the .glb extension")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.stem}.exporting.glb")
    if temporary.exists():
        temporary.unlink()
    result = bpy.ops.export_scene.gltf(
        filepath=str(temporary),
        check_existing=False,
        export_format="GLB",
        export_copyright="Original TarkovZero procedural authoring; no game payloads",
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
    if result != {"FINISHED"} or not temporary.is_file():
        raise RuntimeError(f"glTF export failed: {result}")
    os.replace(temporary, output)


def receipt_document(
    args: argparse.Namespace,
    geometry: dict[str, int],
    bounds: dict[str, list[float]],
    structure_scalars: dict | None,
    glb_stats: dict,
) -> dict:
    output = args.output.expanduser().resolve()
    script_path = Path(__file__).resolve()
    shell = args.asset == "fortress-shell"
    floor_tags = ["ground", "floor-1", "roof"] if shell else ["underground"]
    pivot = EFT_ROOT_CENTER_M if shell else BASEMENT_EFT_PIVOT_M
    yaw = EFT_YAW_DEG if shell else BASEMENT_YAW_DEG
    footprint = FOOTPRINT_M if shell else BASEMENT_FOOTPRINT_M
    return {
        "schemaVersion": 1,
        "generator": {
            "name": GENERATOR_NAME,
            "version": GENERATOR_VERSION,
            "scriptSha256": f"sha256:{sha256_file(script_path)}",
            "blenderVersion": bpy.app.version_string,
            "requiredInvocationFlags": [
                "--background", "--factory-startup", "--disable-autoexec", "--python-exit-code 1",
            ],
        },
        "copyrightBoundary": {
            "authorship": "independently-authored original procedural geometry and textures",
            "input": "sanitized scalar dimensions, elevations, yaw, hierarchy counts, and material-family labels",
            "gameFilesReadByGenerator": False,
            "gameMeshesIncluded": False,
            "gameTexturesIncluded": False,
            "gameShadersIncluded": False,
            "bakedLightingIncluded": False,
            "fogIncluded": False,
        },
        "asset": {
            "id": args.asset,
            "lod": args.lod,
            "outputFile": output.name,
            "bytes": output.stat().st_size,
            "sha256": f"sha256:{sha256_file(output)}",
            "gltf": {"unit": "metre", "upAxis": "+y", "forwardAxis": "+x", "pivot": "origin"},
            "boundsM": glb_stats["boundsM"],
            "floors": floor_tags,
        },
        "canonicalPlacement": {
            "eftRootCenterM": {"x": EFT_ROOT_CENTER_M[0], "y": EFT_ROOT_CENTER_M[1], "z": EFT_ROOT_CENTER_M[2]},
            "recommendedEftPivotM": {"x": pivot[0], "y": pivot[1], "z": pivot[2]},
            "yawDeg": yaw,
            "note": "placement is receipt metadata only; no world transform is baked into the GLB",
        },
        "truthAnchors": {
            "footprintM": {"length": footprint[0], "width": footprint[1]},
            "footprintLocalQuadM": [list(point) for point in FOOTPRINT_LOCAL_QUAD_M] if shell else None,
            "longitudinalGirders": LONGITUDINAL_GIRDERS,
            "nominalGirderSpacingM": round((ROOF_GIRDER_X_M[-1] - ROOF_GIRDER_X_M[0]) / 10.0, 6),
            "roofPanelsPresent": 60,
            "roofGridCapacity": 80,
            "metalRoofSupports": 22,
            "playableWorldYM": {
                "ground": GROUND_WORLD_Y_M,
                "upper": UPPER_WORLD_Y_M,
                "basement": BASEMENT_WORLD_Y_M,
            },
            "roofTrussWorldYRangeM": list(ROOF_TRUSS_WORLD_Y_M),
            "localFromRootM": {
                "ground": GROUND_LOCAL_Z_M if shell else None,
                "upper": UPPER_WORLD_Y_M - EFT_ROOT_CENTER_M[1] if shell else None,
                "basement": 0.0 if not shell else BASEMENT_LOCAL_Z_M,
                "roofPanelMinimum": min(ROOF_ROW_ROOT_LOCAL_Z_M),
                "roofPanelMaximum": max(ROOF_ROW_ROOT_LOCAL_Z_M),
            },
            "stairs": 2,
            "ramps": 4,
            "materialFamilies": sorted(MATERIAL_SPECS),
        },
        "generated": {
            **geometry,
            "objectCount": len(bpy.context.scene.objects),
            "materialCount": glb_stats["materials"],
            "embeddedImageCount": glb_stats["images"],
            "textureResolution": TEXTURE_SIZE_BY_LOD[args.lod],
            "roofTextureResolution": max(32, TEXTURE_SIZE_BY_LOD[args.lod] // 2) if shell else None,
            "blenderBoundsM": bounds,
            "structureScalars": (
                {
                    "inputFile": args.structure_scalars.expanduser().resolve().name,
                    "sha256": f"sha256:{structure_scalars['sha256']}",
                    "objectCount": len(structure_scalars["objects"]),
                    "usage": (
                        "exact scalar origins for roof/girders/supports/ramps and nonzero above-root opaque structural modules; original authored dimensions/materials"
                        if shell
                        else "validated shared Construction_factory root pose only; ZB-013 room geometry remains an authored hypothesis"
                    ),
                }
                if structure_scalars is not None
                else {"usage": "built-in reviewed core anchors"}
            ),
        },
        "limitations": [
            "Only supplied scalar anchors are measurement-backed; facade damage, exact opening widths, and basement room layout remain independently authored hypotheses.",
            "Roof panel positions are scalar-backed; galvanized/off-white/oxidized material variation and weathering are original-authored, deterministic, and not measured per panel.",
            "No source-game topology, UVs, pixels, shaders, decals, signs, brands, or baked lighting are present.",
            "The GLB is an authoring baseline and must pass fixed-camera silhouette, opening/cover, held-out placement, and runtime performance gates before a near-1:1 claim.",
        ],
    }


def write_receipt(path: Path, document: dict) -> None:
    path = path.expanduser().resolve()
    if path.suffix.lower() != ".json":
        raise ValueError("--receipt must use the .json extension")
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(document, indent=2, sort_keys=True, ensure_ascii=True) + "\n"
    path.write_text(payload, encoding="utf-8", newline="\n")


def main() -> None:
    args = parse_args(blender_script_args())
    validate_runtime()
    structure_scalars = (
        load_structure_scalars(args.structure_scalars)
        if args.structure_scalars is not None
        else None
    )
    reset_scene()
    materials = material_set(args.lod, include_roof_variants=args.asset == "fortress-shell")
    if args.asset == "fortress-shell":
        build_fortress_shell(args.lod, materials, structure_scalars)
    else:
        build_basement(args.lod, materials, structure_scalars)

    bounds_before_batch = blender_bounds()
    batching = batch_meshes_for_export()
    bounds_after_batch = blender_bounds()
    maximum_batch_bound_drift = 0.0
    for bound in ("min", "max"):
        for axis in range(3):
            drift = abs(bounds_before_batch[bound][axis] - bounds_after_batch[bound][axis])
            maximum_batch_bound_drift = max(maximum_batch_bound_drift, drift)
            if drift > 0.01:
                raise RuntimeError(
                    f"mesh batching moved the {bound}[{axis}] bound: "
                    f"{bounds_before_batch[bound][axis]} -> {bounds_after_batch[bound][axis]}"
                )
    batching["maximumBatchBoundDriftM"] = round(maximum_batch_bound_drift, 6)
    geometry = {**evaluated_geometry_stats(), **batching}
    bounds = bounds_after_batch
    if geometry["triangles"] <= 0:
        raise RuntimeError("factory produced an empty asset")
    if bounds["min"][2] < -20.0 or bounds["max"][2] > 30.0:
        raise RuntimeError(f"scalar-guided vertical bounds are implausible: {bounds}")

    export_glb(args.output)
    glb_stats = exported_glb_stats(args.output.expanduser().resolve())
    if glb_stats["triangles"] != geometry["triangles"]:
        raise RuntimeError(
            f"exported triangle total changed: Blender={geometry['triangles']} GLB={glb_stats['triangles']}"
        )
    if args.receipt is not None:
        write_receipt(args.receipt, receipt_document(args, geometry, bounds, structure_scalars, glb_stats))

    print(
        json.dumps(
            {
                "asset": args.asset,
                "lod": args.lod,
                "output": str(args.output.expanduser().resolve()),
                "triangles": geometry["triangles"],
                "vertices": geometry["vertices"],
                "bytes": args.output.expanduser().resolve().stat().st_size,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
