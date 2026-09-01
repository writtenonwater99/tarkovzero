#!/usr/bin/env python3
"""Deterministic original-authored Customs Crackhouse shell factory.

Run with Blender 4.5 LTS. The generator consumes only the checked-in public
scalar fact selection beside this script. It never reads an EFT installation or
copies game meshes, textures, UVs, shaders, signs, decals, or baked lighting.

The authored shell uses a base-centre origin, Blender Z-up while authoring, and
exports as metre-scaled glTF with +Y up and +X forward. World placement is
receipt metadata only and remains owned by TarkovZero's scene manifest.
"""

from __future__ import annotations

import argparse
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


GENERATOR_NAME = "tarkovzero-crackhouse-building-factory"
GENERATOR_VERSION = "0.1.0"
SUPPORTED_BLENDER = (4, 5)
ASSET_ID = "crackhouse-shell"
LOD_LEVELS = (0, 1, 2)
TEXTURE_SIZE_BY_LOD = {0: 128, 1: 64, 2: 32}
SOURCE_KEY = "svg:Ground_Level/Buildings/Big_Buildings-2:element-197:subpath-0"
SOURCE_FOOTPRINT_EFT_XZ = (
    (94.3, -166.5),
    (89.5, -142.6),
    (73.6, -145.9),
    (78.4, -169.7),
)
SOURCE_HEIGHT_M = 6.5
SOURCE_FLOORS = 2
SOURCE_GROUND_WORLD_Y_M = 1.983
SOURCE_UPPER_WORLD_Y_M = 5.4932
UPPER_LOCAL_Z_M = SOURCE_UPPER_WORLD_Y_M - SOURCE_GROUND_WORLD_Y_M
EAVE_LOCAL_Z_M = 5.24
RIDGE_LOCAL_Z_M = SOURCE_HEIGHT_M
WALL_THICKNESS_M = 0.28
SLAB_THICKNESS_M = 0.20
ROOF_OVERHANG_M = 0.38
FRAME_REVEAL_INSET_M = 0.025

HYPOTHESIS_IDS = (
    "HYP-FACADE-OPENINGS-01",
    "HYP-INTERIOR-PARTITIONS-01",
    "HYP-STAIR-01",
    "HYP-GABLE-EAVE-01",
    "HYP-ROOF-TILE-LAYOUT-01",
    "HYP-FACADE-DAMAGE-01",
    "HYP-DOOR-LEAF-01",
    "HYP-FOUNDATION-CONTACT-01",
)

MATERIAL_SPECS = {
    "plaster": {"base": (0.43, 0.39, 0.32), "roughness": 0.91, "metallic": 0.0, "seed": 1009, "tileM": 2.4},
    "brick": {"base": (0.42, 0.205, 0.13), "roughness": 0.88, "metallic": 0.0, "seed": 2027, "tileM": 1.6},
    "timber": {"base": (0.26, 0.17, 0.105), "roughness": 0.82, "metallic": 0.0, "seed": 3019, "tileM": 1.8},
    "roof_tile": {"base": (0.39, 0.185, 0.105), "roughness": 0.86, "metallic": 0.0, "seed": 4001, "tileM": 1.4},
    "concrete": {"base": (0.40, 0.405, 0.375), "roughness": 0.89, "metallic": 0.0, "seed": 5011, "tileM": 2.6},
    "metal": {"base": (0.19, 0.205, 0.19), "roughness": 0.72, "metallic": 0.55, "seed": 6011, "tileM": 1.2},
    "interior": {"base": (0.105, 0.105, 0.09), "roughness": 0.94, "metallic": 0.0, "seed": 7013, "tileM": 2.2},
    "glass": {"base": (0.20, 0.29, 0.285), "roughness": 0.23, "metallic": 0.08, "seed": 8011, "tileM": 1.0, "alpha": 0.36},
    "plinth": {"base": (0.205, 0.19, 0.155), "roughness": 0.95, "metallic": 0.0, "seed": 9011, "tileM": 1.1},
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


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build one original-authored Crackhouse GLB LOD.")
    parser.add_argument("--lod", type=int, choices=LOD_LEVELS, required=True)
    parser.add_argument("--facts", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args(argv)
    args.facts = args.facts.expanduser().resolve()
    args.output = args.output.expanduser().resolve()
    args.receipt = args.receipt.expanduser().resolve()
    require(args.output.suffix.lower() == ".glb", "--output must use .glb")
    require(args.receipt.suffix.lower() == ".json", "--receipt must use .json")
    require(args.output.parent == args.receipt.parent, "GLB and receipt must share one output directory")
    require(args.output.parent.is_dir(), "output directory must already exist")
    require(not args.output.exists(), f"refusing to overwrite {args.output}")
    require(not args.receipt.exists(), f"refusing to overwrite {args.receipt}")
    return args


def blender_script_args() -> list[str]:
    require("--" in sys.argv, "factory arguments must follow Blender's -- separator")
    return sys.argv[sys.argv.index("--") + 1 :]


def validate_runtime() -> None:
    require(bpy.app.version[:2] == SUPPORTED_BLENDER, f"Blender 4.5 LTS required; found {bpy.app.version_string}")


def finite_number(value: object, label: str) -> float:
    require(not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(float(value)), f"{label} must be finite")
    return float(value)


def load_facts(path: Path) -> dict:
    require(path.is_file() and path.stat().st_size <= 64 * 1024, "facts must be a small JSON file")
    document = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(document, dict), "facts root must be an object")
    require(document.get("schemaVersion") == 1, "facts schema changed")
    require(document.get("documentType") == "tarkovzero-public-building-facts", "facts document type changed")
    require(document.get("map") == "customs" and document.get("assetId") == ASSET_ID, "facts identity changed")
    building = document.get("building")
    require(isinstance(building, dict), "building facts missing")
    require(building.get("sourceKey") == SOURCE_KEY, "building source key changed")
    require(building.get("place") == "Crackhouse" and building.get("style") == "gable", "Crackhouse identity changed")
    require(building.get("floors") == SOURCE_FLOORS and finite_number(building.get("height"), "height") == SOURCE_HEIGHT_M, "height/floors changed")
    poly = building.get("poly")
    require(poly == [list(point) for point in SOURCE_FOOTPRINT_EFT_XZ], "public footprint changed")
    surfaces = document.get("floorSurfaces")
    require(isinstance(surfaces, list) and len(surfaces) == 2, "two floor surfaces are required")
    surfaces = sorted(surfaces, key=lambda row: row.get("floorIndex", -1))
    require([row.get("floorIndex") for row in surfaces] == [0, 1], "floor indices changed")
    require(abs(finite_number(surfaces[0].get("surfaceY"), "ground surfaceY") - SOURCE_GROUND_WORLD_Y_M) < 1e-9, "ground elevation changed")
    require(abs(finite_number(surfaces[1].get("surfaceY"), "upper surfaceY") - SOURCE_UPPER_WORLD_Y_M) < 1e-9, "upper elevation changed")
    require(set(document.get("derivationContract", {})) == {"pivotXZ", "longAxis", "yawDeg", "lengthM", "widthM", "pivotY", "upperLocalY"}, "derivation contract changed")
    document["sha256"] = sha256_file(path)
    return document


def vector(a: Sequence[float], b: Sequence[float]) -> tuple[float, float]:
    return float(b[0]) - float(a[0]), float(b[1]) - float(a[1])


def magnitude(value: Sequence[float]) -> float:
    return math.hypot(float(value[0]), float(value[1]))


def normalized(value: Sequence[float]) -> tuple[float, float]:
    length = magnitude(value)
    require(length > 1e-9, "cannot normalize zero vector")
    return float(value[0]) / length, float(value[1]) / length


def derive_transform(poly: Sequence[Sequence[float]]) -> dict:
    require(len(poly) == 4, "canonical derivation requires a four-point footprint")
    pivot_x = sum(float(point[0]) for point in poly) / 4.0
    pivot_z = sum(float(point[1]) for point in poly) / 4.0
    long_a = normalized(vector(poly[0], poly[1]))
    long_b = normalized(vector(poly[3], poly[2]))
    long_axis = normalized((long_a[0] + long_b[0], long_a[1] + long_b[1]))
    width_axis = (-long_axis[1], long_axis[0])
    length_m = (magnitude(vector(poly[0], poly[1])) + magnitude(vector(poly[2], poly[3]))) * 0.5
    width_m = (magnitude(vector(poly[1], poly[2])) + magnitude(vector(poly[3], poly[0]))) * 0.5
    yaw_deg = math.degrees(math.atan2(long_axis[0], long_axis[1]))
    local_quad = []
    for point in poly:
        offset = (float(point[0]) - pivot_x, float(point[1]) - pivot_z)
        local_quad.append((
            offset[0] * long_axis[0] + offset[1] * long_axis[1],
            offset[0] * width_axis[0] + offset[1] * width_axis[1],
        ))
    return {
        "pivotEftM": (pivot_x, SOURCE_GROUND_WORLD_Y_M, pivot_z),
        "yawDeg": yaw_deg,
        "longAxisEftXZ": long_axis,
        "widthAxisEftXZ": width_axis,
        "lengthM": length_m,
        "widthM": width_m,
        "localFootprintQuadM": tuple(local_quad),
    }


CANONICAL = derive_transform(SOURCE_FOOTPRINT_EFT_XZ)


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (
        bpy.data.meshes, bpy.data.curves, bpy.data.materials, bpy.data.images,
        bpy.data.cameras, bpy.data.lights,
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
    scene.world.color = (0.035, 0.038, 0.035)
    scene["tz_no_fog"] = True
    scene["tz_no_baked_lighting"] = True
    scene["tz_original_authored"] = True


def create_collection(name: str) -> bpy.types.Collection:
    collection = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(collection)
    return collection


def create_empty(name: str, collection: bpy.types.Collection) -> bpy.types.Object:
    obj = bpy.data.objects.new(name, None)
    collection.objects.link(obj)
    obj.empty_display_type = "PLAIN_AXES"
    obj.empty_display_size = 0.4
    return obj


def hash01(x: int, y: int, seed: int) -> float:
    value = (x * 0x1F123BB5 + y * 0x5F356495 + seed * 0x6C8E9CF5) & 0xFFFFFFFF
    value ^= value >> 16
    value = (value * 0x7FEB352D) & 0xFFFFFFFF
    value ^= value >> 15
    value = (value * 0x846CA68B) & 0xFFFFFFFF
    value ^= value >> 16
    return value / 0xFFFFFFFF


def smoothstep(value: float) -> float:
    return value * value * (3.0 - 2.0 * value)


def tile_noise(x: int, y: int, size: int, cell: int, seed: int) -> float:
    grid = max(2, size // max(1, cell))
    gx, gy = x / cell, y / cell
    x0, y0 = math.floor(gx) % grid, math.floor(gy) % grid
    tx, ty = smoothstep(gx - math.floor(gx)), smoothstep(gy - math.floor(gy))
    a, b = hash01(x0, y0, seed), hash01((x0 + 1) % grid, y0, seed)
    c, d = hash01(x0, (y0 + 1) % grid, seed), hash01((x0 + 1) % grid, (y0 + 1) % grid, seed)
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty


def material_sample(kind: str, x: int, y: int, size: int) -> tuple[float, tuple[float, float, float], float, float, float, float]:
    spec = MATERIAL_SPECS[kind]
    seed = int(spec["seed"])
    broad = tile_noise(x, y, size, max(4, size // 6), seed)
    fine = tile_noise(x, y, size, max(2, size // 24), seed + 37)
    grain = hash01(x, y, seed + 101)
    height = 0.48 + (broad - 0.5) * 0.18 + (fine - 0.5) * 0.12 + (grain - 0.5) * 0.04
    base = list(spec["base"])
    roughness = float(spec["roughness"]) + (grain - 0.5) * 0.05
    metallic = float(spec["metallic"])
    occlusion = 0.94 + (broad - 0.5) * 0.08

    if kind == "brick":
        row_h = max(3, size // 12)
        brick_w = max(7, size // 4)
        row = y // row_h
        shifted = (x + (brick_w // 2 if row % 2 else 0)) % size
        mortar = shifted % brick_w < max(1, size // 128) or y % row_h < max(1, size // 128)
        if mortar:
            base = [0.31, 0.29, 0.255]
            height = 0.17 + grain * 0.035
            roughness = 0.94
            occlusion = 0.80
        else:
            variation = (hash01(shifted // brick_w, row, seed + 211) - 0.5) * 0.13
            base = [max(0.0, min(1.0, channel + variation)) for channel in base]
    elif kind == "plaster":
        drip = max(0.0, tile_noise(x // 2, y, size, max(2, size // 9), seed + 313) - 0.62)
        chip = hash01(x // max(1, size // 64), y // max(1, size // 64), seed + 419) > 0.965
        shade = (broad - 0.5) * 0.12 - drip * 0.32 - (0.10 if chip else 0.0)
        base = [max(0.0, min(1.0, channel + shade)) for channel in base]
        height -= 0.13 if chip else 0.0
        occlusion -= 0.10 if chip else 0.0
    elif kind == "timber":
        rings = 0.5 + 0.5 * math.sin((x / max(3, size / 10) + fine * 1.8) * math.tau)
        height = 0.41 + rings * 0.14 + (grain - 0.5) * 0.04
        shade = (rings - 0.5) * 0.11 + (broad - 0.5) * 0.08
        base = [max(0.0, min(1.0, channel + shade)) for channel in base]
    elif kind == "roof_tile":
        tile_w, tile_h = max(5, size // 8), max(4, size // 12)
        row = y // tile_h
        shifted = (x + (tile_w // 2 if row % 2 else 0)) % size
        seam = shifted % tile_w < max(1, size // 128) or y % tile_h < max(1, size // 128)
        moss = max(0.0, tile_noise(x, y, size, max(3, size // 7), seed + 503) - 0.73)
        if seam:
            height = 0.16
            base = [channel * 0.58 for channel in base]
            occlusion = 0.76
        else:
            height = 0.49 + 0.13 * math.cos((shifted % tile_w) / tile_w * math.pi)
            base = [max(0.0, min(1.0, base[0] - moss * 0.28)), max(0.0, min(1.0, base[1] + moss * 0.08)), max(0.0, min(1.0, base[2] - moss * 0.03))]
    elif kind == "metal":
        rust = max(0.0, tile_noise(x, y, size, max(3, size // 10), seed + 607) - 0.70)
        base = [max(0.0, min(1.0, base[0] + rust * 0.42)), max(0.0, min(1.0, base[1] + rust * 0.10)), max(0.0, min(1.0, base[2] + rust * 0.025))]
        roughness += rust * 0.58
        metallic = max(0.12, metallic - rust * 1.4)
        height += rust * 0.12
    elif kind == "concrete":
        pore = grain > 0.965
        if pore:
            height -= 0.22
            occlusion -= 0.15
        shade = (broad - 0.5) * 0.10 - (0.08 if pore else 0.0)
        base = [max(0.0, min(1.0, channel + shade)) for channel in base]
    elif kind == "glass":
        grime = max(0.0, tile_noise(x, y, size, max(3, size // 5), seed + 709) - 0.58)
        base = [max(0.0, min(1.0, channel - grime * 0.12)) for channel in base]
        height = 0.5 + (fine - 0.5) * 0.015
    elif kind == "plinth":
        damp = max(0.0, tile_noise(x, y, size, max(3, size // 5), seed + 811) - 0.43)
        grit = hash01(x // max(1, size // 48), y // max(1, size // 48), seed + 919)
        height = 0.38 + fine * 0.13 + (grit - 0.5) * 0.055
        base = [
            max(0.0, min(1.0, base[0] - damp * 0.11 + grit * 0.025)),
            max(0.0, min(1.0, base[1] - damp * 0.09 + grit * 0.018)),
            max(0.0, min(1.0, base[2] - damp * 0.07 + grit * 0.012)),
        ]
        roughness = 0.96
        occlusion = 0.84 + broad * 0.10
    else:
        shade = (broad - 0.5) * 0.08
        base = [max(0.0, min(1.0, channel + shade)) for channel in base]

    return (
        max(0.0, min(1.0, height)), tuple(base), max(0.0, min(1.0, occlusion)),
        max(0.0, min(1.0, roughness)), max(0.0, min(1.0, metallic)), float(spec.get("alpha", 1.0)),
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
    samples = [material_sample(kind, x, y, size) for y in range(size) for x in range(size)]
    heights = [sample[0] for sample in samples]
    base_pixels: list[float] = []
    orm_pixels: list[float] = []
    for _, color, occlusion, roughness, metallic, alpha in samples:
        base_pixels.extend((*color, alpha))
        orm_pixels.extend((occlusion, roughness, metallic, 1.0))
    normal_pixels: list[float] = []
    strength = {"plaster": 2.0, "brick": 3.5, "timber": 2.1, "roof_tile": 3.0, "concrete": 2.0, "metal": 1.25, "interior": 1.1, "glass": 0.2, "plinth": 2.6}[kind]
    for y in range(size):
        for x in range(size):
            left = heights[y * size + ((x - 1) % size)]
            right = heights[y * size + ((x + 1) % size)]
            down = heights[((y - 1) % size) * size + x]
            up = heights[((y + 1) % size) * size + x]
            normal = Vector((-(right - left) * strength, -(up - down) * strength, 1.0)).normalized()
            normal_pixels.extend((normal.x * 0.5 + 0.5, normal.y * 0.5 + 0.5, normal.z * 0.5 + 0.5, 1.0))
    prefix = f"TZ_Crackhouse_{kind}_L{lod}"
    base_image = create_image(f"{prefix}_BaseColor", size, base_pixels, "sRGB")
    normal_image = create_image(f"{prefix}_Normal", size, normal_pixels, "Non-Color")
    orm_image = create_image(f"{prefix}_ORM", size, orm_pixels, "Non-Color")
    material = bpy.data.materials.new(f"{prefix}_PBR")
    material.use_nodes = True
    material.diffuse_color = (*spec["base"], float(spec.get("alpha", 1.0)))
    material.metallic = float(spec["metallic"])
    material.roughness = float(spec["roughness"])
    material.use_backface_culling = False
    material["tz_family"] = kind
    material["tz_original_procedural"] = True
    material["tz_orm_channels"] = "R=occlusion,G=roughness,B=metallic"
    if kind == "glass":
        material.surface_render_method = "DITHERED"

    nodes, links = material.node_tree.nodes, material.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    output.location = (700, 0)
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (420, 0)
    bsdf.inputs["Base Color"].default_value = (*spec["base"], 1.0)
    bsdf.inputs["Metallic"].default_value = float(spec["metallic"])
    bsdf.inputs["Roughness"].default_value = float(spec["roughness"])
    bsdf.inputs["Alpha"].default_value = float(spec.get("alpha", 1.0))
    links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])
    base_node = nodes.new("ShaderNodeTexImage")
    base_node.image = base_image
    base_node.location = (-620, 180)
    base_node.extension = "REPEAT"
    links.new(base_node.outputs["Color"], bsdf.inputs["Base Color"])
    if kind == "glass":
        links.new(base_node.outputs["Alpha"], bsdf.inputs["Alpha"])
    normal_node = nodes.new("ShaderNodeTexImage")
    normal_node.image = normal_image
    normal_node.location = (-620, -80)
    normal_node.extension = "REPEAT"
    normal_map = nodes.new("ShaderNodeNormalMap")
    normal_map.location = (110, -160)
    normal_map.inputs["Strength"].default_value = 0.72 if lod == 0 else 0.55
    links.new(normal_node.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])
    orm_node = nodes.new("ShaderNodeTexImage")
    orm_node.image = orm_image
    orm_node.location = (-620, -380)
    orm_node.extension = "REPEAT"
    separate = nodes.new("ShaderNodeSeparateColor")
    separate.location = (-100, -360)
    links.new(orm_node.outputs["Color"], separate.inputs["Color"])
    links.new(separate.outputs["Green"], bsdf.inputs["Roughness"])
    links.new(separate.outputs["Blue"], bsdf.inputs["Metallic"])
    group_tree = bpy.data.node_groups.get("glTF Material Output")
    if group_tree is None:
        group_tree = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
        group_tree.interface.new_socket(name="Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
    gltf_output = nodes.new("ShaderNodeGroup")
    gltf_output.node_tree = group_tree
    gltf_output.location = (110, -470)
    links.new(separate.outputs["Red"], gltf_output.inputs["Occlusion"])
    return material


def material_set(lod: int) -> dict[str, bpy.types.Material]:
    return {kind: create_material(kind, lod) for kind in MATERIAL_SPECS}


def tag_object(obj: bpy.types.Object, lod: int, floor: str, family: str, hypothesis: str | None = None) -> None:
    obj["tz_asset_id"] = ASSET_ID
    obj["tz_lod"] = lod
    obj["tz_floor"] = floor
    obj["tz_material_family"] = family
    obj["tz_original_authored"] = True
    obj["tz_measured_geometry"] = hypothesis is None
    if hypothesis is not None:
        obj["tz_hypothesis_id"] = hypothesis


def apply_scale(obj: bpy.types.Object) -> None:
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.select_set(False)


def assign_metric_uv(mesh: bpy.types.Mesh, tile_m: float) -> None:
    require(tile_m > 0, "UV tile size must be positive")
    uv_layer = mesh.uv_layers.new(name="UVMap")
    for polygon in mesh.polygons:
        normal = tuple(abs(value) for value in polygon.normal)
        dominant = max(range(3), key=lambda axis: normal[axis])
        axes = ((1, 2), (0, 2), (0, 1))[dominant]
        for loop_index in polygon.loop_indices:
            co = mesh.vertices[mesh.loops[loop_index].vertex_index].co
            uv_layer.data[loop_index].uv = (co[axes[0]] / tile_m, co[axes[1]] / tile_m)


def create_box(
    name: str,
    dimensions: tuple[float, float, float],
    location: tuple[float, float, float],
    material: bpy.types.Material,
    collection: bpy.types.Collection,
    parent: bpy.types.Object,
    *,
    lod: int,
    floor: str,
    family: str,
    hypothesis: str | None = None,
    rotation: tuple[float, float, float] | None = None,
) -> bpy.types.Object:
    require(min(dimensions) > 0, f"{name}: dimensions must be positive")
    dx, dy, dz = dimensions
    x, y, z = dx * 0.5, dy * 0.5, dz * 0.5
    vertices = [
        (-x, -y, -z), (x, -y, -z), (x, y, -z), (-x, y, -z),
        (-x, -y, z), (x, -y, z), (x, y, z), (-x, y, z),
    ]
    faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (3, 7, 6, 2), (0, 4, 7, 3), (1, 2, 6, 5)]
    mesh = bpy.data.meshes.new(f"{name}_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(material)
    mesh.update()
    assign_metric_uv(mesh, float(MATERIAL_SPECS[family]["tileM"]))
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    obj.location = location
    if rotation is not None:
        obj.rotation_euler = rotation
    obj.parent = parent
    tag_object(obj, lod, floor, family, hypothesis)
    apply_scale(obj)
    return obj


def create_plan_prism(
    name: str,
    polygon_xy: Sequence[tuple[float, float]],
    bottom_z: float,
    top_z: float,
    material: bpy.types.Material,
    collection: bpy.types.Collection,
    parent: bpy.types.Object,
    *,
    lod: int,
    floor: str,
    family: str,
) -> bpy.types.Object:
    require(len(polygon_xy) >= 3 and top_z > bottom_z, f"{name}: invalid prism")
    count = len(polygon_xy)
    vertices = [(x, y, bottom_z) for x, y in polygon_xy] + [(x, y, top_z) for x, y in polygon_xy]
    faces: list[tuple[int, ...]] = []
    for index in range(1, count - 1):
        faces.append((0, index + 1, index))
        faces.append((count, count + index, count + index + 1))
    faces.extend((index, (index + 1) % count, (index + 1) % count + count, index + count) for index in range(count))
    mesh = bpy.data.meshes.new(f"{name}_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(material)
    mesh.update()
    assign_metric_uv(mesh, float(MATERIAL_SPECS[family]["tileM"]))
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    obj.parent = parent
    tag_object(obj, lod, floor, family)
    return obj


def create_triangle_plane(
    name: str,
    vertices: Sequence[tuple[float, float, float]],
    material: bpy.types.Material,
    collection: bpy.types.Collection,
    parent: bpy.types.Object,
    *,
    lod: int,
    floor: str,
    family: str,
    hypothesis: str,
) -> bpy.types.Object:
    mesh = bpy.data.meshes.new(f"{name}_Mesh")
    mesh.from_pydata(vertices, [], [(0, 1, 2)])
    mesh.materials.append(material)
    mesh.update()
    assign_metric_uv(mesh, float(MATERIAL_SPECS[family]["tileM"]))
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    obj.parent = parent
    tag_object(obj, lod, floor, family, hypothesis)
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
    lod: int,
    floor: str,
    family: str,
    hypothesis: str,
) -> bpy.types.Object:
    a, b = Vector(start), Vector(end)
    delta = b - a
    obj = create_box(name, (delta.length, thickness, thickness), tuple((a + b) * 0.5), material, collection, parent, lod=lod, floor=floor, family=family, hypothesis=hypothesis)
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Vector((1, 0, 0)).rotation_difference(delta.normalized())
    return obj


def create_cylinder(
    name: str,
    radius: float,
    depth: float,
    location: tuple[float, float, float],
    material: bpy.types.Material,
    collection: bpy.types.Collection,
    parent: bpy.types.Object,
    *,
    lod: int,
    floor: str,
    family: str,
    hypothesis: str,
    vertices: int,
    rotation: tuple[float, float, float] = (0, 0, 0),
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, end_fill_type="TRIFAN", location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.data.name = f"{name}_Mesh"
    for candidate in tuple(obj.users_collection):
        candidate.objects.unlink(obj)
    collection.objects.link(obj)
    obj.data.materials.append(material)
    obj.parent = parent
    assign_metric_uv(obj.data, float(MATERIAL_SPECS[family]["tileM"]))
    tag_object(obj, lod, floor, family, hypothesis)
    return obj


def opening(identifier: str, kind: str, centre: float, width: float, bottom: float, height: float) -> dict:
    return {"id": identifier, "kind": kind, "centre": centre, "width": width, "bottom": bottom, "height": height}


def all_openings() -> dict[str, list[dict]]:
    return {
        "south": [
            opening("S-D0", "door", -8.55, 1.50, 0.0, 2.45),
            *[opening(f"S-G{i}", "window", c, 1.55, 1.02, 1.34) for i, c in enumerate((-4.65, -0.25, 4.35))],
            *[opening(f"S-U{i}", "window", c, 1.48, 3.94, 1.17) for i, c in enumerate((-8.25, -4.15, 0.05, 4.35, 8.25))],
        ],
        "north": [
            opening("N-D0", "door", 8.30, 1.45, 0.0, 2.42),
            *[opening(f"N-G{i}", "window", c, 1.52, 1.04, 1.30) for i, c in enumerate((-8.1, -3.65, 0.75, 5.25))],
            *[opening(f"N-U{i}", "window", c, 1.46, 3.92, 1.20) for i, c in enumerate((-8.0, -3.6, 0.8, 5.2, 9.0))],
        ],
        "east": [
            opening("E-D0", "door", -3.65, 1.42, 0.0, 2.42),
            opening("E-G0", "window", 1.55, 1.45, 1.04, 1.28),
            *[opening(f"E-U{i}", "window", c, 1.34, 3.92, 1.15) for i, c in enumerate((-4.25, 0.0, 4.25))],
        ],
        "west": [
            opening("W-D0", "door", 3.70, 1.42, 0.0, 2.42),
            opening("W-G0", "window", -1.35, 1.45, 1.04, 1.28),
            *[opening(f"W-U{i}", "window", c, 1.34, 3.92, 1.15) for i, c in enumerate((-4.2, 0.0, 4.2))],
        ],
    }


LOD1_OMIT = {"S-U1", "S-U3", "N-G1", "N-U1", "N-U3", "E-U1", "W-U1"}
LOD2_KEEP = {"S-D0", "N-D0", "E-D0", "W-D0", "S-G1", "S-U2", "N-G2", "N-U2", "E-U1", "W-U1"}


def opening_layout(lod: int) -> dict[str, list[dict]]:
    source = all_openings()
    if lod == 0:
        return source
    if lod == 1:
        return {facade: [item for item in items if item["id"] not in LOD1_OMIT] for facade, items in source.items()}
    return {facade: [item for item in items if item["id"] in LOD2_KEEP] for facade, items in source.items()}


def vertical_complements(top: float, openings: Iterable[dict]) -> list[tuple[float, float]]:
    intervals = sorted((max(0.0, item["bottom"]), min(top, item["bottom"] + item["height"])) for item in openings)
    cursor = 0.0
    result = []
    for start, end in intervals:
        if start > cursor + 1e-6:
            result.append((cursor, start))
        cursor = max(cursor, end)
    if cursor < top - 1e-6:
        result.append((cursor, top))
    return result


def add_wall_cells(
    facade: str,
    items: Sequence[dict],
    materials: dict[str, bpy.types.Material],
    collection: bpy.types.Collection,
    parent: bpy.types.Object,
    lod: int,
) -> int:
    length, width = CANONICAL["lengthM"], CANONICAL["widthM"]
    span = length if facade in ("south", "north") else width
    bounds = {-span * 0.5, span * 0.5}
    for item in items:
        bounds.add(item["centre"] - item["width"] * 0.5)
        bounds.add(item["centre"] + item["width"] * 0.5)
    edges = sorted(bounds)
    cells = 0
    for index, (start, end) in enumerate(zip(edges, edges[1:])):
        centre = (start + end) * 0.5
        active = [item for item in items if item["centre"] - item["width"] * 0.5 < centre < item["centre"] + item["width"] * 0.5]
        vertical_bands: list[tuple[float, float]] = []
        for bottom, top in vertical_complements(EAVE_LOCAL_Z_M, active):
            if bottom < UPPER_LOCAL_Z_M < top:
                vertical_bands.extend(((bottom, UPPER_LOCAL_Z_M), (UPPER_LOCAL_Z_M, top)))
            else:
                vertical_bands.append((bottom, top))
        for vertical_index, (bottom, top) in enumerate(vertical_bands):
            if end - start < 0.025 or top - bottom < 0.025:
                continue
            if facade in ("south", "north"):
                plan_y = (-1 if facade == "south" else 1) * (width * 0.5 - WALL_THICKNESS_M * 0.5)
                dims = (end - start, WALL_THICKNESS_M, top - bottom)
                location = (centre, plan_y, (bottom + top) * 0.5)
            else:
                plan_x = (1 if facade == "east" else -1) * (length * 0.5 - WALL_THICKNESS_M * 0.5)
                dims = (WALL_THICKNESS_M, end - start, top - bottom)
                location = (plan_x, centre, (bottom + top) * 0.5)
            create_box(
                f"WallCell_{facade}_{index:02d}_{vertical_index:02d}", dims, location,
                materials["plaster"], collection, parent, lod=lod,
                floor="ground" if top <= UPPER_LOCAL_Z_M + 0.02 else "floor-1",
                family="plaster", hypothesis="HYP-FACADE-OPENINGS-01",
            )
            cells += 1
    return cells


def add_frame_and_void(
    facade: str,
    item: dict,
    materials: dict[str, bpy.types.Material],
    collection: bpy.types.Collection,
    parent: bpy.types.Object,
    lod: int,
) -> None:
    length, width = CANONICAL["lengthM"], CANONICAL["widthM"]
    u, w, bottom, height = item["centre"], item["width"], item["bottom"], item["height"]
    top = bottom + height
    frame_w = 0.12 if lod < 2 else 0.16
    depth = 0.11
    family = "timber" if item["kind"] == "window" else "metal"
    material = materials[family]
    outward = -1 if facade == "south" else 1 if facade == "north" else 1 if facade == "east" else -1
    if facade in ("south", "north"):
        plan_y = outward * (width * 0.5 - depth * 0.5 - FRAME_REVEAL_INSET_M)
        for suffix, x in (("L", u - w * 0.5 - frame_w * 0.5), ("R", u + w * 0.5 + frame_w * 0.5)):
            create_box(f"Frame_{item['id']}_{suffix}", (frame_w, depth, height + frame_w * 2), (x, plan_y, bottom + height * 0.5), material, collection, parent, lod=lod, floor="ground" if bottom < UPPER_LOCAL_Z_M else "floor-1", family=family, hypothesis="HYP-FACADE-OPENINGS-01")
        for suffix, z in (("B", bottom - frame_w * 0.5), ("T", top + frame_w * 0.5)):
            create_box(f"Frame_{item['id']}_{suffix}", (w + frame_w * 2, depth, frame_w), (u, plan_y, z), material, collection, parent, lod=lod, floor="ground" if bottom < UPPER_LOCAL_Z_M else "floor-1", family=family, hypothesis="HYP-FACADE-OPENINGS-01")
        if item["kind"] == "window" and lod == 0:
            create_box(f"Mullion_{item['id']}_V", (0.07, depth * 0.7, height), (u, plan_y + outward * 0.015, bottom + height * 0.5), materials["metal"], collection, parent, lod=lod, floor="ground" if bottom < UPPER_LOCAL_Z_M else "floor-1", family="metal", hypothesis="HYP-FACADE-OPENINGS-01")
            if hash01(len(item["id"]), ord(item["id"][0]), 911) > 0.42:
                create_triangle_plane(f"BrokenGlass_{item['id']}_A", ((u-w*.45, plan_y+outward*.03, bottom+.08), (u-w*.08, plan_y+outward*.03, bottom+.08), (u-w*.45, plan_y+outward*.03, bottom+height*.45)), materials["glass"], collection, parent, lod=lod, floor="ground" if bottom < UPPER_LOCAL_Z_M else "floor-1", family="glass", hypothesis="HYP-FACADE-OPENINGS-01")
                create_triangle_plane(f"BrokenGlass_{item['id']}_B", ((u+w*.12, plan_y+outward*.03, top-.07), (u+w*.45, plan_y+outward*.03, top-.07), (u+w*.45, plan_y+outward*.03, top-height*.38)), materials["glass"], collection, parent, lod=lod, floor="ground" if bottom < UPPER_LOCAL_Z_M else "floor-1", family="glass", hypothesis="HYP-FACADE-OPENINGS-01")
    else:
        plan_x = outward * (length * 0.5 - depth * 0.5 - FRAME_REVEAL_INSET_M)
        for suffix, y in (("L", u - w * 0.5 - frame_w * 0.5), ("R", u + w * 0.5 + frame_w * 0.5)):
            create_box(f"Frame_{item['id']}_{suffix}", (depth, frame_w, height + frame_w * 2), (plan_x, y, bottom + height * 0.5), material, collection, parent, lod=lod, floor="ground" if bottom < UPPER_LOCAL_Z_M else "floor-1", family=family, hypothesis="HYP-FACADE-OPENINGS-01")
        for suffix, z in (("B", bottom - frame_w * 0.5), ("T", top + frame_w * 0.5)):
            create_box(f"Frame_{item['id']}_{suffix}", (depth, w + frame_w * 2, frame_w), (plan_x, u, z), material, collection, parent, lod=lod, floor="ground" if bottom < UPPER_LOCAL_Z_M else "floor-1", family=family, hypothesis="HYP-FACADE-OPENINGS-01")
        if item["kind"] == "window" and lod == 0:
            create_box(f"Mullion_{item['id']}_V", (depth * .7, 0.07, height), (plan_x + outward * .015, u, bottom + height * .5), materials["metal"], collection, parent, lod=lod, floor="ground" if bottom < UPPER_LOCAL_Z_M else "floor-1", family="metal", hypothesis="HYP-FACADE-OPENINGS-01")

    void = create_empty(f"OpeningVoid_{item['id']}", collection)
    void.parent = parent
    if facade in ("south", "north"):
        void.location = (u, (-1 if facade == "south" else 1) * width * 0.5, bottom + height * 0.5)
    else:
        void.location = ((1 if facade == "east" else -1) * length * 0.5, u, bottom + height * 0.5)
    void["tz_kind"] = item["kind"]
    void["tz_facade"] = facade
    void["tz_width_m"] = w
    void["tz_height_m"] = height
    void["tz_bottom_m"] = bottom
    void["tz_real_void"] = True
    void["tz_hypothesis_id"] = "HYP-FACADE-OPENINGS-01"

    if item["kind"] == "door" and lod < 2:
        leaf_w, leaf_h = w * 0.82, height * 0.91
        if facade in ("south", "north"):
            y = (-1 if facade == "south" else 1) * (width * 0.5 - 0.18)
            create_box(f"DoorLeaf_{item['id']}", (leaf_w, 0.055, leaf_h), (u + leaf_w * .08, y, bottom + leaf_h * .5), materials["timber"], collection, parent, lod=lod, floor="ground", family="timber", hypothesis="HYP-DOOR-LEAF-01", rotation=(0, 0, math.radians(54 if facade == "south" else -47)))
        else:
            x = (1 if facade == "east" else -1) * (length * .5 - .18)
            create_box(f"DoorLeaf_{item['id']}", (0.055, leaf_w, leaf_h), (x, u + leaf_w * .08, bottom + leaf_h * .5), materials["timber"], collection, parent, lod=lod, floor="ground", family="timber", hypothesis="HYP-DOOR-LEAF-01", rotation=(0, 0, math.radians(-42 if facade == "east" else 48)))


def complement_horizontal(span: float, openings: Sequence[dict]) -> list[tuple[float, float]]:
    intervals = sorted(
        (max(-span*.5, item["centre"]-item["width"]*.5-.05), min(span*.5, item["centre"]+item["width"]*.5+.05))
        for item in openings if item["kind"] == "door" and item["bottom"] <= .02
    )
    result: list[tuple[float, float]] = []
    cursor = -span * .5
    for start, end in intervals:
        if start > cursor + .02:
            result.append((cursor, start))
        cursor = max(cursor, end)
    if cursor < span*.5 - .02:
        result.append((cursor, span*.5))
    return result


def add_contact_plinth(
    layout: dict[str, list[dict]],
    materials: dict[str, bpy.types.Material],
    collection: bpy.types.Collection,
    parent: bpy.types.Object,
    lod: int,
) -> int:
    """Add a thin, non-tactical damp masonry band without closing door voids."""
    length, width = CANONICAL["lengthM"], CANONICAL["widthM"]
    height, centre_z, depth = .38, .19, .055
    count = 0
    for facade, items in layout.items():
        span = length if facade in ("south", "north") else width
        for index, (start, end) in enumerate(complement_horizontal(span, items)):
            if facade in ("south", "north"):
                outward = -1 if facade == "south" else 1
                dims = (end-start, depth, height)
                location = ((start+end)*.5, outward*(width*.5+depth*.5+.006), centre_z)
            else:
                outward = 1 if facade == "east" else -1
                dims = (depth, end-start, height)
                location = (outward*(length*.5+depth*.5+.006), (start+end)*.5, centre_z)
            create_box(
                f"ContactPlinth_{facade}_{index:02d}", dims, location,
                materials["plinth"], collection, parent, lod=lod, floor="ground",
                family="plinth", hypothesis="HYP-FOUNDATION-CONTACT-01",
            )
            count += 1
    return count


def add_gables(materials: dict[str, bpy.types.Material], collection: bpy.types.Collection, parent: bpy.types.Object, lod: int) -> None:
    length, width = CANONICAL["lengthM"], CANONICAL["widthM"]
    half_t = WALL_THICKNESS_M * .5
    for side, label in ((-1, "W"), (1, "E")):
        x_outer = side * length * .5
        x_inner = x_outer - side * WALL_THICKNESS_M
        vertices = [
            (x_outer, -width*.5, EAVE_LOCAL_Z_M), (x_outer, width*.5, EAVE_LOCAL_Z_M), (x_outer, 0, RIDGE_LOCAL_Z_M),
            (x_inner, -width*.5, EAVE_LOCAL_Z_M), (x_inner, width*.5, EAVE_LOCAL_Z_M), (x_inner, 0, RIDGE_LOCAL_Z_M),
        ]
        faces = [(0, 1, 2), (5, 4, 3), (0, 3, 4, 1), (1, 4, 5, 2), (2, 5, 3, 0)]
        mesh = bpy.data.meshes.new(f"Gable_{label}_Mesh")
        mesh.from_pydata(vertices, [], faces)
        mesh.materials.append(materials["plaster"])
        mesh.update()
        assign_metric_uv(mesh, float(MATERIAL_SPECS["plaster"]["tileM"]))
        obj = bpy.data.objects.new(f"Gable_{label}", mesh)
        collection.objects.link(obj)
        obj.parent = parent
        tag_object(obj, lod, "roof", "plaster", "HYP-GABLE-EAVE-01")


def append_oriented_box(vertices: list[tuple[float, float, float]], faces: list[tuple[int, ...]], centre: Vector, axes: tuple[Vector, Vector, Vector], dimensions: tuple[float, float, float]) -> None:
    base = len(vertices)
    a, b, c = (axes[index] * (dimensions[index] * .5) for index in range(3))
    vertices.extend(tuple(centre + sx*a + sy*b + sz*c) for sx, sy, sz in ((-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),(-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)))
    faces.extend(tuple(base + index for index in face) for face in ((0,3,2,1),(4,5,6,7),(0,1,5,4),(3,7,6,2),(0,4,7,3),(1,2,6,5)))


def append_crowned_roof_tile(
    vertices: list[tuple[float, float, float]],
    faces: list[tuple[int, ...]],
    centre: Vector,
    along: Vector,
    slope: Vector,
    normal: Vector,
    width: float,
    height: float,
    crown: float,
) -> None:
    """Append a lightweight two-panel tile whose crown remains readable at LOD0."""
    base = len(vertices)
    for x_factor in (-0.5, 0.0, 0.5):
        for y_factor in (-0.5, 0.5):
            lift = crown if x_factor == 0.0 else 0.0
            point = centre + along * (width * x_factor) + slope * (height * y_factor) + normal * lift
            vertices.append(tuple(point))
    faces.extend(((base+0,base+2,base+3,base+1),(base+2,base+4,base+5,base+3)))


def add_roof(materials: dict[str, bpy.types.Material], collection: bpy.types.Collection, parent: bpy.types.Object, lod: int) -> int:
    length, width = CANONICAL["lengthM"], CANONICAL["widthM"]
    run = width * .5 + ROOF_OVERHANG_M
    rise = RIDGE_LOCAL_Z_M - EAVE_LOCAL_Z_M
    slope_length = math.hypot(run, rise)
    vertices: list[tuple[float, float, float]] = []
    faces: list[tuple[int, ...]] = []
    for side in (-1, 1):
        slope = Vector((0, side * run / slope_length, -rise / slope_length))
        normal = Vector((0, side * rise / slope_length, run / slope_length))
        centre = Vector((0, side * run * .5, (RIDGE_LOCAL_Z_M + EAVE_LOCAL_Z_M) * .5 - .105))
        append_oriented_box(vertices, faces, centre, (Vector((1,0,0)), slope, normal), (length + ROOF_OVERHANG_M*2, slope_length, .11))
    mesh = bpy.data.meshes.new("RoofBase_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(materials["roof_tile"])
    mesh.update()
    assign_metric_uv(mesh, float(MATERIAL_SPECS["roof_tile"]["tileM"]))
    roof = bpy.data.objects.new("RoofBase", mesh)
    collection.objects.link(roof)
    roof.parent = parent
    tag_object(roof, lod, "roof", "roof_tile", "HYP-ROOF-TILE-LAYOUT-01")

    rows, columns = ((12, 24) if lod == 0 else (6, 12) if lod == 1 else (0, 0))
    tile_count = rows * columns * 2
    if tile_count:
        tile_vertices: list[tuple[float, float, float]] = []
        tile_faces: list[tuple[int, ...]] = []
        tile_x = (length + ROOF_OVERHANG_M * 2) / columns
        tile_slope = slope_length / rows
        for side in (-1, 1):
            slope = Vector((0, side * run / slope_length, -rise / slope_length))
            normal = Vector((0, side * rise / slope_length, run / slope_length))
            for row in range(rows):
                t = (row + .5) / rows
                for column in range(columns):
                    x = -length*.5-ROOF_OVERHANG_M + (column+.5)*tile_x
                    centre = Vector((x, side*run*t, RIDGE_LOCAL_Z_M-rise*t-.095)) + normal * .020
                    wave = 1.0 + (hash01(column, row + (0 if side < 0 else 100), 1217) - .5) * .055
                    append_crowned_roof_tile(
                        tile_vertices, tile_faces, centre, Vector((1,0,0)), slope, normal,
                        tile_x*.95, tile_slope*1.08, .024*wave,
                    )
        tile_mesh = bpy.data.meshes.new("RoofTiles_Mesh")
        tile_mesh.from_pydata(tile_vertices, [], tile_faces)
        tile_mesh.materials.append(materials["roof_tile"])
        tile_mesh.update()
        assign_metric_uv(tile_mesh, float(MATERIAL_SPECS["roof_tile"]["tileM"]))
        tiles = bpy.data.objects.new("RoofTiles", tile_mesh)
        collection.objects.link(tiles)
        tiles.parent = parent
        tag_object(tiles, lod, "roof", "roof_tile", "HYP-ROOF-TILE-LAYOUT-01")

    create_cylinder("RoofRidgeCap", .145, length + ROOF_OVERHANG_M*2, (0, 0, RIDGE_LOCAL_Z_M-.15), materials["roof_tile"], collection, parent, lod=lod, floor="roof", family="roof_tile", hypothesis="HYP-ROOF-TILE-LAYOUT-01", vertices=12 if lod == 0 else 8, rotation=(0, math.pi*.5, 0))
    if lod < 2:
        for side, label in ((-1, "S"), (1, "N")):
            create_cylinder(f"Gutter_{label}", .09, length + .5, (0, side*(width*.5+ROOF_OVERHANG_M-.04), EAVE_LOCAL_Z_M-.03), materials["metal"], collection, parent, lod=lod, floor="roof", family="metal", hypothesis="HYP-GABLE-EAVE-01", vertices=10, rotation=(0, math.pi*.5, 0))
            if lod == 0:
                create_cylinder(f"Downpipe_{label}", .065, EAVE_LOCAL_Z_M-.25, (-length*.5+.55, side*(width*.5+.12), (EAVE_LOCAL_Z_M-.25)*.5), materials["metal"], collection, parent, lod=lod, floor="ground", family="metal", hypothesis="HYP-GABLE-EAVE-01", vertices=8)
    return tile_count


def add_upper_slab(materials: dict[str, bpy.types.Material], collection: bpy.types.Collection, parent: bpy.types.Object, lod: int) -> int:
    length, width = CANONICAL["lengthM"], CANONICAL["widthM"]
    # Seat the slab 20 mm into the inner wall face.  It remains continuous with
    # the wall but cannot become coplanar with the exterior facade plane.
    slab_half_length = length*.5 - WALL_THICKNESS_M + .02
    slab_half_width = width*.5 - WALL_THICKNESS_M + .02
    hole = (2.35, 7.45, -1.15, 1.15)
    rectangles = [
        (-slab_half_length, hole[0], -slab_half_width, slab_half_width),
        (hole[1], slab_half_length, -slab_half_width, slab_half_width),
        (hole[0], hole[1], -slab_half_width, hole[2]),
        (hole[0], hole[1], hole[3], slab_half_width),
    ]
    for index, (x0, x1, y0, y1) in enumerate(rectangles):
        create_box(f"UpperSlab_{index:02d}", (x1-x0, y1-y0, SLAB_THICKNESS_M), ((x0+x1)*.5, (y0+y1)*.5, UPPER_LOCAL_Z_M-SLAB_THICKNESS_M*.5), materials["concrete"], collection, parent, lod=lod, floor="floor-1", family="concrete")
    return len(rectangles)


def add_stairs(materials: dict[str, bpy.types.Material], collection: bpy.types.Collection, parent: bpy.types.Object, lod: int) -> int:
    start_x, end_x = 2.55, 7.2
    width = 1.35
    if lod == 2:
        length = end_x - start_x
        x0, x1, y0, y1, h = start_x, end_x, -width*.5, width*.5, UPPER_LOCAL_Z_M-.06
        vertices = [(x0,y0,0),(x0,y1,0),(x1,y0,0),(x1,y1,0),(x1,y0,h),(x1,y1,h)]
        faces = [(1,3,2,0),(3,5,4,2),(4,5,1,0),(2,4,0),(5,3,1)]
        mesh = bpy.data.meshes.new("StairRamp_Mesh")
        mesh.from_pydata(vertices, [], faces)
        mesh.materials.append(materials["timber"])
        mesh.update()
        assign_metric_uv(mesh, float(MATERIAL_SPECS["timber"]["tileM"]))
        obj = bpy.data.objects.new("StairRamp", mesh)
        collection.objects.link(obj)
        obj.parent = parent
        tag_object(obj, lod, "ground", "timber", "HYP-STAIR-01")
        return 1
    steps = 15 if lod == 0 else 8
    run = (end_x - start_x) / steps
    for index in range(steps):
        height = UPPER_LOCAL_Z_M * (index + 1) / steps
        create_box(f"StairStep_{index:02d}", (run*1.04, width, height), (start_x+(index+.5)*run, 0, height*.5), materials["timber"], collection, parent, lod=lod, floor="ground", family="timber", hypothesis="HYP-STAIR-01")
    if lod == 0:
        for side in (-1, 1):
            create_beam_between(f"StairRail_{side:+d}", (start_x, side*(width*.5+.06), .82), (end_x, side*(width*.5+.06), UPPER_LOCAL_Z_M+.78), .055, materials["metal"], collection, parent, lod=lod, floor="ground", family="metal", hypothesis="HYP-STAIR-01")
            for index in (0, 5, 10, 14):
                x = start_x + (index+.5)*run
                z = UPPER_LOCAL_Z_M*(index+1)/steps
                create_cylinder(f"StairBaluster_{side:+d}_{index:02d}", .027, .82, (x, side*(width*.5+.06), z+.41), materials["metal"], collection, parent, lod=lod, floor="ground", family="metal", hypothesis="HYP-STAIR-01", vertices=6)
    return steps


def add_interior(materials: dict[str, bpy.types.Material], collection: bpy.types.Collection, parent: bpy.types.Object, lod: int) -> int:
    if lod == 2:
        return 0
    pieces = [
        ("Partition_Ground_A", (4.6,.18,2.72), (-3.3,-1.5,1.36), "ground"),
        ("Partition_Ground_B", (3.8,.18,2.72), (4.2,2.8,1.36), "ground"),
        ("Partition_Upper_A", (.18,5.2,1.45), (-1.4,1.2,UPPER_LOCAL_Z_M+.725), "floor-1"),
        ("Partition_Upper_B", (5.2,.18,1.45), (-5.7,-2.4,UPPER_LOCAL_Z_M+.725), "floor-1"),
    ]
    for name, dims, location, floor in pieces[:(4 if lod == 0 else 2)]:
        create_box(name, dims, location, materials["interior"], collection, parent, lod=lod, floor=floor, family="interior", hypothesis="HYP-INTERIOR-PARTITIONS-01")
    return 4 if lod == 0 else 2


def add_damage_and_boards(materials: dict[str, bpy.types.Material], collection: bpy.types.Collection, parent: bpy.types.Object, lod: int) -> tuple[int, int]:
    if lod == 2:
        return 0, 0
    length, width = CANONICAL["lengthM"], CANONICAL["widthM"]
    patch_specs = [
        ("S", -6.1, -width*.5-.146, 2.75, 1.65, 1.05),
        ("S", 6.8, -width*.5-.146, 3.05, 1.25, 1.50),
        ("N", -1.9, width*.5+.146, 2.25, 2.15, 1.20),
        ("N", 8.0, width*.5+.146, 5.32, 1.35, .62),
    ]
    if lod == 0:
        patch_specs += [("S", 1.8, -width*.5-.147, 5.28, 1.05, .58), ("N", -8.5, width*.5+.147, 1.0, 1.05, .75)]
    for index, (label, cx, y, cz, w, h) in enumerate(patch_specs):
        jitter = (hash01(index, 1, 1321)-.5)*.18
        verts = ((cx-w*.5,y,cz-h*.42),(cx-w*.22,y,cz-h*.55+jitter),(cx+w*.48,y,cz-h*.32),(cx+w*.55,y,cz+h*.28),(cx+w*.08,y,cz+h*.55),(cx-w*.53,y,cz+h*.30))
        mesh = bpy.data.meshes.new(f"ExposedBrickPatch_{index:02d}_Mesh")
        mesh.from_pydata(verts, [], [(0,1,2),(0,2,3),(0,3,4),(0,4,5)])
        mesh.materials.append(materials["brick"])
        mesh.update()
        assign_metric_uv(mesh, float(MATERIAL_SPECS["brick"]["tileM"]))
        obj = bpy.data.objects.new(f"ExposedBrickPatch_{label}_{index:02d}", mesh)
        collection.objects.link(obj)
        obj.parent = parent
        tag_object(obj, lod, "ground" if cz < UPPER_LOCAL_Z_M else "floor-1", "brick", "HYP-FACADE-DAMAGE-01")
    boards = 0
    if lod == 0:
        for index, (x, z, angle) in enumerate(((-4.65,1.66,.32),(4.35,1.68,-.28),(-3.6,4.48,.38))):
            create_box(f"WindowBoard_{index:02d}", (1.72,.075,.18), (x,-width*.5-.23,z), materials["timber"], collection, parent, lod=lod, floor="ground" if z<UPPER_LOCAL_Z_M else "floor-1", family="timber", hypothesis="HYP-FACADE-DAMAGE-01", rotation=(0,angle,0))
            boards += 1
    return len(patch_specs), boards


def build_shell(lod: int, materials: dict[str, bpy.types.Material]) -> dict[str, int]:
    root_collection = create_collection(f"TZ_Crackhouse_LOD{lod}")
    root = create_empty(f"TZ_CrackhouseShell_LOD{lod}_ROOT", root_collection)
    root["tz_asset_id"] = ASSET_ID
    root["tz_lod"] = lod
    root["tz_original_authored"] = True
    root["tz_tactical_certified"] = False
    root["tz_collision_certified"] = False
    root["tz_collision"] = "none"
    root["tz_hypotheses_json"] = json.dumps(HYPOTHESIS_IDS, separators=(",", ":"))
    layout = opening_layout(lod)
    opening_count = sum(len(items) for items in layout.values())
    root["tz_opening_void_count"] = opening_count
    root["tz_measured_ground_local_y_m"] = 0.0
    root["tz_measured_upper_local_y_m"] = UPPER_LOCAL_Z_M
    root["tz_source_height_m"] = SOURCE_HEIGHT_M

    create_plan_prism("GroundSlab", CANONICAL["localFootprintQuadM"], -.18, .02, materials["concrete"], root_collection, root, lod=lod, floor="ground", family="concrete")
    upper_parts = add_upper_slab(materials, root_collection, root, lod)
    wall_cells = 0
    for facade, items in layout.items():
        wall_cells += add_wall_cells(facade, items, materials, root_collection, root, lod)
        for item in items:
            add_frame_and_void(facade, item, materials, root_collection, root, lod)
    foundation_bands = add_contact_plinth(layout, materials, root_collection, root, lod)
    add_gables(materials, root_collection, root, lod)
    roof_tiles = add_roof(materials, root_collection, root, lod)
    stair_steps = add_stairs(materials, root_collection, root, lod)
    interior_parts = add_interior(materials, root_collection, root, lod)
    damage_patches, boards = add_damage_and_boards(materials, root_collection, root, lod)
    return {
        "openingVoids": opening_count,
        "doors": sum(item["kind"] == "door" for items in layout.values() for item in items),
        "windows": sum(item["kind"] == "window" for items in layout.values() for item in items),
        "wallCells": wall_cells,
        "upperSlabParts": upper_parts,
        "stairSteps": stair_steps,
        "roofTiles": roof_tiles,
        "interiorPartitionPieces": interior_parts,
        "damagePatches": damage_patches,
        "windowBoards": boards,
        "foundationContactBands": foundation_bands,
    }


def evaluated_geometry_stats() -> dict[str, int]:
    depsgraph = bpy.context.evaluated_depsgraph_get()
    triangles = authoring_vertices = mesh_objects = 0
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH" or not obj.visible_get():
            continue
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        try:
            mesh.calc_loop_triangles()
            triangles += len(mesh.loop_triangles)
            authoring_vertices += len(mesh.vertices)
            mesh_objects += 1
        finally:
            evaluated.to_mesh_clear()
    return {"triangles": triangles, "authoringVertices": authoring_vertices, "meshObjects": mesh_objects}


def spatial_batch_band(obj: bpy.types.Object) -> str:
    """Classify an object by exported vertical occupancy, including honest cross-floor pieces."""
    tagged = str(obj.get("tz_floor", "ground"))
    if tagged == "roof":
        return "roof"
    z_values = [(obj.matrix_world @ Vector(corner)).z for corner in obj.bound_box]
    minimum, maximum = min(z_values), max(z_values)
    epsilon = 1e-5
    if minimum < UPPER_LOCAL_Z_M - epsilon and maximum > UPPER_LOCAL_Z_M + epsilon:
        return "cross-floor"
    if maximum <= UPPER_LOCAL_Z_M + epsilon:
        return "ground"
    return "floor-1"


def batch_meshes_for_export() -> dict[str, int]:
    """Join fragments by material and spatial band while retaining slabs and void empties."""
    total_before = sum(obj.type == "MESH" and obj.visible_get() for obj in bpy.context.scene.objects)
    candidates = [
        obj for obj in bpy.context.scene.objects
        if obj.type == "MESH" and obj.visible_get()
        and obj.name != "GroundSlab" and not obj.name.startswith("UpperSlab_")
    ]
    # Join uses the active object's local basis. Bake every authored rotation first so a
    # diagonal door leaf, handrail, or cylinder cannot rotate an entire material batch.
    for obj in sorted(candidates, key=lambda candidate: candidate.name):
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    groups: dict[tuple[str, str], list[bpy.types.Object]] = {}
    for obj in candidates:
        band = spatial_batch_band(obj)
        obj["tz_spatial_band"] = band
        key = (band, str(obj.get("tz_material_family", "unknown")))
        groups.setdefault(key, []).append(obj)
    joined = 0
    for (floor, family), objects in sorted(groups.items()):
        objects = sorted(objects, key=lambda obj: obj.name)
        if not objects:
            continue
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        active = objects[0]
        bpy.context.view_layer.objects.active = active
        if len(objects) > 1:
            result = bpy.ops.object.join()
            require(result == {"FINISHED"}, f"mesh batching failed for {floor}/{family}: {result}")
        active.name = f"Batch_{floor}_{family}"
        active.data.name = f"Batch_{floor}_{family}_Mesh"
        active["tz_floor"] = floor
        active["tz_spatial_band"] = floor
        active["tz_batch_count"] = len(objects)
        active["tz_hypothesis_summary"] = "receipt-authoredHypotheses"
        # Blender can preserve identically named source UV maps as UVMap.001 when
        # meshes are joined.  The materials consume only TEXCOORD_0, so retaining
        # those duplicate layers adds an unused glTF attribute and fails our
        # strict-zero Khronos gate.  Keep exactly the authored metric UV layer.
        require(len(active.data.uv_layers) >= 1, f"batch {floor}/{family} lost its authored UV layer")
        while len(active.data.uv_layers) > 1:
            active.data.uv_layers.remove(active.data.uv_layers[-1])
        active.data.uv_layers[0].name = "UVMap"
        joined += 1
    bpy.ops.object.select_all(action="DESELECT")
    after = sum(obj.type == "MESH" and obj.visible_get() for obj in bpy.context.scene.objects)
    return {"meshObjectsBeforeBatch": total_before, "meshObjectsAfterBatch": after, "batchGroups": joined}


def blender_bounds() -> dict[str, list[float]]:
    minimum = Vector((math.inf, math.inf, math.inf))
    maximum = Vector((-math.inf, -math.inf, -math.inf))
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH" or not obj.visible_get():
            continue
        for corner in obj.bound_box:
            point = obj.matrix_world @ Vector(corner)
            for axis in range(3):
                minimum[axis] = min(minimum[axis], point[axis])
                maximum[axis] = max(maximum[axis], point[axis])
    require(all(math.isfinite(value) for value in (*minimum, *maximum)), "scene has no bounded geometry")
    return {
        "min": [round(value, 6) for value in minimum],
        "max": [round(value, 6) for value in maximum],
        "sizeM": [round(maximum[i]-minimum[i], 6) for i in range(3)],
        "centerM": [round((maximum[i]+minimum[i])*.5, 6) for i in range(3)],
    }


def export_glb(output: Path) -> None:
    temporary = output.with_name(f".{output.stem}.exporting.glb")
    require(not temporary.exists(), f"refusing stale temporary export: {temporary}")
    result = bpy.ops.export_scene.gltf(
        filepath=str(temporary), check_existing=False, export_format="GLB",
        export_copyright="Original TarkovZero procedural authoring; no game payloads",
        export_yup=True, export_apply=True, export_texcoords=True, export_normals=True,
        export_tangents=True, export_materials="EXPORT", export_image_format="AUTO",
        export_cameras=False, export_lights=False, export_extras=True,
        export_animations=False, export_skins=False, export_morph=False,
        export_draco_mesh_compression_enable=False, export_unused_images=False,
        export_unused_textures=False, use_selection=False, use_visible=True,
        will_save_settings=False,
    )
    require(result == {"FINISHED"} and temporary.is_file(), f"glTF export failed: {result}")
    try:
        os.link(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)


def glb_json(path: Path) -> dict:
    blob = path.read_bytes()
    require(len(blob) >= 20, "truncated GLB")
    magic, version, length = struct.unpack_from("<4sII", blob, 0)
    require((magic, version, length) == (b"glTF", 2, len(blob)), "invalid GLB header")
    offset, document = 12, None
    while offset + 8 <= len(blob):
        chunk_length, chunk_type = struct.unpack_from("<II", blob, offset)
        offset += 8
        end = offset + chunk_length
        require(end <= len(blob), "invalid GLB chunk")
        if chunk_type == 0x4E4F534A:
            require(document is None, "multiple GLB JSON chunks")
            document = json.loads(blob[offset:end].decode("utf-8"))
        offset = end
    require(offset == len(blob) and isinstance(document, dict), "missing GLB JSON")
    return document


def node_matrix(node: dict) -> list[list[float]]:
    if "matrix" in node:
        values = node["matrix"]
        return [[float(values[c*4+r]) for c in range(4)] for r in range(4)]
    x,y,z,w = map(float,node.get("rotation",[0,0,0,1])); sx,sy,sz=map(float,node.get("scale",[1,1,1])); tx,ty,tz=map(float,node.get("translation",[0,0,0]))
    rotation=((1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)),(2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)),(2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)))
    return [[rotation[0][0]*sx,rotation[0][1]*sy,rotation[0][2]*sz,tx],[rotation[1][0]*sx,rotation[1][1]*sy,rotation[1][2]*sz,ty],[rotation[2][0]*sx,rotation[2][1]*sy,rotation[2][2]*sz,tz],[0,0,0,1]]


def multiply4(a: Sequence[Sequence[float]], b: Sequence[Sequence[float]]) -> list[list[float]]:
    return [[sum(a[r][k]*b[k][c] for k in range(4)) for c in range(4)] for r in range(4)]


def exported_stats(document: dict) -> dict:
    accessors, meshes, nodes = document.get("accessors",[]),document.get("meshes",[]),document.get("nodes",[])
    minimum, maximum = [math.inf]*3,[-math.inf]*3
    triangles = gltf_accessor_vertices = 0
    identity=[[float(r==c) for c in range(4)] for r in range(4)]
    def visit(index: int, parent: Sequence[Sequence[float]]) -> None:
        nonlocal triangles, gltf_accessor_vertices
        node=nodes[index]; world=multiply4(parent,node_matrix(node))
        if "mesh" in node:
            for primitive in meshes[node["mesh"]].get("primitives",[]):
                position=accessors[primitive["attributes"]["POSITION"]]
                gltf_accessor_vertices += int(position["count"])
                low,high=position["min"],position["max"]
                count=int(accessors[primitive.get("indices",primitive["attributes"]["POSITION"])]["count"])
                mode=int(primitive.get("mode",4)); triangles += count//3 if mode==4 else max(0,count-2)
                for px in (low[0],high[0]):
                    for py in (low[1],high[1]):
                        for pz in (low[2],high[2]):
                            source=(float(px),float(py),float(pz),1.0)
                            point=[sum(world[r][c]*source[c] for c in range(4)) for r in range(3)]
                            for axis in range(3):
                                minimum[axis]=min(minimum[axis],point[axis]);maximum[axis]=max(maximum[axis],point[axis])
        for child in node.get("children",[]): visit(int(child),world)
    scene_index=int(document.get("scene",0))
    for root in document.get("scenes",[{}])[scene_index].get("nodes",[]): visit(int(root),identity)
    require(all(math.isfinite(value) for value in minimum+maximum), "exported GLB has no geometry")
    return {"triangles":triangles,"gltfAccessorVertices":gltf_accessor_vertices,"materials":len(document.get("materials",[])),"images":len(document.get("images",[])),"nodes":len(nodes),"meshes":len(meshes),"boundsM":{"min":[round(v,6) for v in minimum],"max":[round(v,6) for v in maximum],"sizeM":[round(maximum[i]-minimum[i],6) for i in range(3)],"centerM":[round((maximum[i]+minimum[i])*.5,6) for i in range(3)]}}


def receipt_document(args: argparse.Namespace, facts: dict, authored: dict[str, int], geometry: dict[str, int], stats: dict) -> dict:
    script_path = Path(__file__).resolve()
    pivot = CANONICAL["pivotEftM"]
    return {
        "schemaVersion": 1,
        "generator": {
            "name": GENERATOR_NAME,
            "version": GENERATOR_VERSION,
            "scriptSha256": f"sha256:{sha256_file(script_path)}",
            "blenderVersion": bpy.app.version_string,
            "requiredInvocationFlags": ["--background", "--factory-startup", "--disable-autoexec", "--python-exit-code 1"],
        },
        "provenance": {
            "authorship": "independently-authored original procedural geometry and PBR textures",
            "publicFactsFile": args.facts.name,
            "publicFactsSha256": f"sha256:{facts['sha256']}",
            "publicSourceFile": facts["source"]["file"],
            "publicSourceSha256": facts["source"]["sha256"],
            "coarseVisualQa": "local Re3mr overview screenshots used only for density/silhouette expectations; no tracing or pixel sampling",
            "gameFilesReadByGenerator": False,
            "gameMeshesIncluded": False,
            "gameTexturesIncluded": False,
            "gameShadersIncluded": False,
            "bakedLightingIncluded": False,
            "fogIncluded": False,
        },
        "asset": {
            "id": ASSET_ID,
            "lod": args.lod,
            "outputFile": args.output.name,
            "bytes": args.output.stat().st_size,
            "sha256": f"sha256:{sha256_file(args.output)}",
            "gltf": {"unit": "metre", "upAxis": "+y", "forwardAxis": "+x", "pivot": "base-centre-origin"},
            "boundsM": stats["boundsM"],
            "floors": ["ground", "floor-1", "roof"],
        },
        "canonicalPlacement": {
            "recommendedEftPivotM": {"x": pivot[0], "y": pivot[1], "z": pivot[2]},
            "yawDeg": CANONICAL["yawDeg"],
            "derivation": facts["derivationContract"],
            "note": "placement metadata only; no EFT world transform is baked into the GLB",
        },
        "truthAnchors": {
            "buildingSourceKey": SOURCE_KEY,
            "place": "Crackhouse",
            "publicFootprintEftXZ": [list(point) for point in SOURCE_FOOTPRINT_EFT_XZ],
            "localFootprintQuadM": [list(point) for point in CANONICAL["localFootprintQuadM"]],
            "lengthM": CANONICAL["lengthM"],
            "widthM": CANONICAL["widthM"],
            "heightM": SOURCE_HEIGHT_M,
            "floors": SOURCE_FLOORS,
            "style": "gable",
            "groundWorldYM": SOURCE_GROUND_WORLD_Y_M,
            "upperWorldYM": SOURCE_UPPER_WORLD_Y_M,
            "upperLocalYM": UPPER_LOCAL_Z_M,
            "floorSurfaceStableIds": [row["stableId"] for row in facts["floorSurfaces"]],
        },
        "authoredHypotheses": {
            "ids": list(HYPOTHESIS_IDS),
            "facadeOpenings": "original-authored plausible composition; locations and dimensions are not surveyed",
            "interior": "visible spatial hypothesis only; not a navigation, cover, loot, quest, or tactical truth claim",
            "damageAndMaterials": "original deterministic authoring; not copied or measured per pixel/object",
        },
        "claims": {
            "originalAuthored": True,
            "collisionCertified": False,
            "tacticalCertified": False,
            "nearOneToOneCertified": False,
            "openingLayoutMeasured": False,
            "interiorMeasured": False,
        },
        "generated": {
            **authored,
            **geometry,
            "materialCount": stats["materials"],
            "embeddedImageCount": stats["images"],
            "gltfAccessorVertices": stats["gltfAccessorVertices"],
            "nodeCount": stats["nodes"],
            "meshCount": stats["meshes"],
            "textureResolution": TEXTURE_SIZE_BY_LOD[args.lod],
        },
        "limitations": [
            "Only the public footprint, 6.5 m height, two-floor classification, gable label, and two measured slab elevations are truth anchors.",
            "Facade openings are real geometric voids, but their count, placement, frames, glazing, doors, and damage are authored hypotheses.",
            "The interior slabs and stair communicate depth; partitions and stair placement are not tactically certified.",
            "No collision mesh is included. Runtime picking/collision must remain coarse or disabled until held-out in-raid survey validates openings and cover.",
            "The authored +X-forward to EFT +Z yaw convention must be cross-checked against the live renderer before placement admission.",
            "Fixed-camera visual review, Khronos validation, reproducibility, runtime performance, and held-out placement remain separate admission gates.",
        ],
    }


def write_json_no_clobber(path: Path, document: dict) -> None:
    payload = (json.dumps(document, indent=2, sort_keys=True, ensure_ascii=True) + "\n").encode("utf-8")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
    except Exception:
        path.unlink(missing_ok=True)
        raise


def main() -> None:
    args = parse_args(blender_script_args())
    validate_runtime()
    facts = load_facts(args.facts)
    reset_scene()
    materials = material_set(args.lod)
    authored = build_shell(args.lod, materials)
    authored.update(batch_meshes_for_export())
    geometry = evaluated_geometry_stats()
    bounds = blender_bounds()
    require(geometry["triangles"] > 0, "factory produced no geometry")
    require(bounds["max"][2] <= SOURCE_HEIGHT_M + 0.005, f"authored roof exceeds public height: {bounds}")
    require(abs(bounds["min"][2] + .18) <= .005, f"ground slab bottom drifted: {bounds}")
    export_glb(args.output)
    document = glb_json(args.output)
    stats = exported_stats(document)
    require(stats["triangles"] == geometry["triangles"], f"triangle count changed during export: {geometry} vs {stats}")
    write_json_no_clobber(args.receipt, receipt_document(args, facts, authored, geometry, stats))
    print(json.dumps({"asset": ASSET_ID, "lod": args.lod, "output": str(args.output), "bytes": args.output.stat().st_size, "triangles": geometry["triangles"], "authoringVertices": geometry["authoringVertices"], "gltfAccessorVertices": stats["gltfAccessorVertices"], "boundsM": stats["boundsM"]}, sort_keys=True))


if __name__ == "__main__":
    main()
