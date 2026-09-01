#!/usr/bin/env python3
"""Deterministic original-authored industrial props for TarkovZero Customs.

Run only with Blender 4.5 in background/factory mode.  This module authors
recognizable, metre-scale rail-yard props from public engineering proportions
and the repository's stable semantic feature IDs.  It never reads an EFT
installation and never copies game meshes, topology, UVs, textures, shaders,
materials, or pixels.

Each invocation writes one GLB and one hash-pinned receipt.  Final publication
uses exclusive hard-link creation, so an existing output is never replaced.
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
import tempfile
from typing import Iterable, Sequence

import bpy
from mathutils import Vector


GENERATOR_NAME = "tarkovzero-customs-industrial-prop-factory"
GENERATOR_VERSION = "1.0.0"
GLB_MAGIC = b"glTF"
GLB_JSON_CHUNK = 0x4E4F534A

ASSET_SPECS = {
    "shipping-container": {
        "dimensionsM": (12.192, 2.438, 2.591),
        "description": "original 40-foot ISO-style corrugated shipping container",
        "variants": ("red", "green", "blue"),
    },
    "diesel-shunter": {
        "dimensionsM": (12.8, 3.1, 4.35),
        "description": "original compact industrial diesel shunter",
        "variants": ("default",),
    },
    "tanker-wagon": {
        "dimensionsM": (13.9, 3.12, 4.28),
        "description": "original cylindrical industrial tanker wagon",
        "variants": ("default",),
    },
}

CONTAINER_COLORS = {
    "red": (0.38, 0.042, 0.028),
    "green": (0.055, 0.215, 0.09),
    "blue": (0.026, 0.155, 0.30),
}

MATERIAL_SPECS = {
    "paint-red": {"base": CONTAINER_COLORS["red"], "roughness": 0.63, "metallic": 0.32, "rust": 0.68, "scratches": 0.72},
    "paint-green": {"base": CONTAINER_COLORS["green"], "roughness": 0.62, "metallic": 0.32, "rust": 0.58, "scratches": 0.64},
    "paint-blue": {"base": CONTAINER_COLORS["blue"], "roughness": 0.60, "metallic": 0.33, "rust": 0.54, "scratches": 0.66},
    "shunter-paint": {"base": (0.145, 0.175, 0.09), "roughness": 0.57, "metallic": 0.38, "rust": 0.44, "scratches": 0.66},
    "tank-shell": {"base": (0.19, 0.205, 0.20), "roughness": 0.68, "metallic": 0.42, "rust": 0.64, "scratches": 0.56},
    "structural-steel": {"base": (0.115, 0.12, 0.115), "roughness": 0.74, "metallic": 0.62, "rust": 0.72, "scratches": 0.46},
    "galvanized": {"base": (0.39, 0.41, 0.39), "roughness": 0.57, "metallic": 0.72, "rust": 0.36, "scratches": 0.54},
    "rubber-dark": {"base": (0.025, 0.027, 0.026), "roughness": 0.93, "metallic": 0.02, "rust": 0.0, "scratches": 0.18},
    "glass-dark": {"base": (0.025, 0.075, 0.088), "roughness": 0.24, "metallic": 0.16, "rust": 0.0, "scratches": 0.16},
    "warning-paint": {"base": (0.52, 0.34, 0.035), "roughness": 0.68, "metallic": 0.18, "rust": 0.35, "scratches": 0.62},
    "hose-dark": {"base": (0.035, 0.038, 0.037), "roughness": 0.86, "metallic": 0.08, "rust": 0.0, "scratches": 0.12},
}

TEXTURE_SIZE_BY_LOD = {0: 128, 1: 64, 2: 32}


def script_args() -> list[str]:
    try:
        index = sys.argv.index("--")
    except ValueError:
        return []
    return sys.argv[index + 1 :]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def hash01(x: int, y: int, seed: int) -> float:
    value = (x * 0x1F123BB5) ^ (y * 0x5F356495) ^ (seed * 0x6C8E9CF5)
    value ^= value >> 16
    value = (value * 0x7FEB352D) & 0xFFFFFFFF
    value ^= value >> 15
    value = (value * 0x846CA68B) & 0xFFFFFFFF
    value ^= value >> 16
    return value / 0xFFFFFFFF


def smoothstep(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return value * value * (3.0 - 2.0 * value)


def periodic_noise(x: int, y: int, size: int, cells: int, seed: int) -> float:
    scale = size / cells
    gx = x / scale
    gy = y / scale
    x0 = math.floor(gx)
    y0 = math.floor(gy)
    tx = smoothstep(gx - x0)
    ty = smoothstep(gy - y0)
    x1 = (x0 + 1) % cells
    y1 = (y0 + 1) % cells
    x0 %= cells
    y0 %= cells
    a = hash01(x0, y0, seed)
    b = hash01(x1, y0, seed)
    c = hash01(x0, y1, seed)
    d = hash01(x1, y1, seed)
    top = a + (b - a) * tx
    bottom = c + (d - c) * tx
    return top + (bottom - top) * ty


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Author one original industrial prop GLB LOD.")
    parser.add_argument("--asset", choices=tuple(ASSET_SPECS), required=True)
    parser.add_argument("--lod", type=int, choices=(0, 1, 2), required=True)
    parser.add_argument("--variant", default="default")
    parser.add_argument("--seed", type=int, default=106)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args(argv)
    require(args.variant in ASSET_SPECS[args.asset]["variants"], f"invalid variant for {args.asset}: {args.variant}")
    require(0 <= args.seed <= 2**31 - 1, "--seed must be between 0 and 2147483647")
    args.output = args.output.expanduser().resolve()
    args.receipt = args.receipt.expanduser().resolve()
    require(args.output.suffix.lower() == ".glb", "--output must use .glb")
    require(args.receipt.suffix.lower() == ".json", "--receipt must use .json")
    require(args.output != args.receipt, "output and receipt must differ")
    require(not args.output.exists(), f"refusing to overwrite existing output: {args.output}")
    require(not args.receipt.exists(), f"refusing to overwrite existing receipt: {args.receipt}")
    return args


def validate_blender() -> None:
    require(tuple(bpy.app.version[:2]) == (4, 5), f"Blender 4.5 required; found {bpy.app.version_string}")
    require(bpy.app.background, "factory must run in Blender background mode")


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in list(bpy.data.collections):
        if collection.name != "Collection":
            bpy.data.collections.remove(collection)
    for blocks in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.curves):
        for block in list(blocks):
            blocks.remove(block)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.unit_settings.length_unit = "METERS"
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.world.color = (0.045, 0.048, 0.045)


def create_image(name: str, size: int, pixels: list[float], colorspace: str) -> bpy.types.Image:
    image = bpy.data.images.new(name, width=size, height=size, alpha=True, float_buffer=False)
    image.file_format = "PNG"
    image.colorspace_settings.name = colorspace
    image.pixels.foreach_set(pixels)
    image.pack()
    image["tz_original_procedural"] = True
    image["tz_generator"] = GENERATOR_NAME
    return image


def surface_sample(kind: str, x: int, y: int, size: int, seed: int) -> tuple[float, tuple[float, float, float], float, float, float]:
    spec = MATERIAL_SPECS[kind]
    broad = periodic_noise(x, y, size, 5, seed + 31)
    medium = periodic_noise(x, y, size, 13, seed + 101)
    grit = hash01(x, y, seed + 251)
    scratches = float(spec["scratches"])
    rust_amount = float(spec["rust"])
    scratch_line = hash01(x // max(1, size // 24), y, seed + 359)
    scratch = max(0.0, scratch_line - (0.988 - scratches * 0.02)) * (7.0 + scratches * 4.0)
    oxidation_field = periodic_noise(x, y, size, 11, seed + 479)
    rust_threshold = 0.70 - rust_amount * 0.025
    oxidation = smoothstep(max(0.0, (oxidation_field - rust_threshold) / max(0.01, 1.0 - rust_threshold))) * rust_amount
    edge_streak = smoothstep(max(0.0, (periodic_noise(x, y, size, 5, seed + 613) - 0.68) / 0.32)) * rust_amount
    dirt = max(0.0, 0.51 - broad) * 0.18
    base = spec["base"]

    if kind == "rubber-dark" or kind == "hose-dark":
        pock = max(0.0, grit - 0.94) * 0.7
        color = tuple(max(0.0, min(1.0, channel + (medium - 0.5) * 0.025 - pock)) for channel in base)
        height = 0.49 + (medium - 0.5) * 0.08 - pock * 0.18
        roughness = float(spec["roughness"]) + (grit - 0.5) * 0.025
        metallic = float(spec["metallic"])
        occlusion = 0.94 - pock * 0.18
    elif kind == "glass-dark":
        streak = max(0.0, periodic_noise(x, y, size, 9, seed + 809) - 0.7) * 0.11
        color = tuple(max(0.0, min(1.0, channel + (broad - 0.5) * 0.02 - streak)) for channel in base)
        height = 0.5 + (medium - 0.5) * 0.015
        roughness = float(spec["roughness"]) + streak
        metallic = float(spec["metallic"])
        occlusion = 0.98
    else:
        # Broad, restrained oxidation islands read as weathering rather than
        # high-frequency orange confetti. Fine scratches remain a separate cue.
        rust = oxidation * (0.34 + edge_streak * 0.26)
        exposed = max(0.0, scratch - 0.10)
        color = (
            base[0] + (medium - 0.5) * 0.045 - dirt + rust * 0.46 + exposed * 0.12,
            base[1] + (medium - 0.5) * 0.041 - dirt * 1.05 + rust * 0.13 + exposed * 0.13,
            base[2] + (medium - 0.5) * 0.038 - dirt * 1.08 + rust * 0.028 + exposed * 0.13,
        )
        color = tuple(max(0.0, min(1.0, value)) for value in color)
        height = 0.50 + (medium - 0.5) * 0.060 + (grit - 0.5) * 0.018 + rust * 0.10 - exposed * 0.035
        roughness = float(spec["roughness"]) + dirt * 0.45 + rust * 0.48 - exposed * 0.07
        metallic = float(spec["metallic"]) - rust * 1.20 + exposed * 0.08
        occlusion = 0.96 - dirt * 0.32 - rust * 0.14
    return (
        max(0.0, min(1.0, height)),
        color,
        max(0.0, min(1.0, occlusion)),
        max(0.0, min(1.0, roughness)),
        max(0.0, min(1.0, metallic)),
    )


def create_material(kind: str, lod: int, seed: int) -> bpy.types.Material:
    spec = MATERIAL_SPECS[kind]
    size = TEXTURE_SIZE_BY_LOD[lod]
    samples = [surface_sample(kind, x, y, size, seed) for y in range(size) for x in range(size)]
    heights = [sample[0] for sample in samples]
    base_pixels: list[float] = []
    orm_pixels: list[float] = []
    normal_pixels: list[float] = []
    for _, color, occlusion, roughness, metallic in samples:
        base_pixels.extend((*color, 1.0))
        orm_pixels.extend((occlusion, roughness, metallic, 1.0))
    normal_strength = 2.2 if lod == 0 else 1.6 if lod == 1 else 1.15
    for y in range(size):
        for x in range(size):
            left = heights[y * size + ((x - 1) % size)]
            right = heights[y * size + ((x + 1) % size)]
            down = heights[((y - 1) % size) * size + x]
            up = heights[((y + 1) % size) * size + x]
            normal = Vector((-(right - left) * normal_strength, -(up - down) * normal_strength, 1.0)).normalized()
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
    base_node.image = base_image
    base_node.interpolation = "Linear"
    base_node.extension = "REPEAT"
    base_node.location = (-620, 190)
    links.new(base_node.outputs["Color"], bsdf.inputs["Base Color"])
    normal_node = nodes.new("ShaderNodeTexImage")
    normal_node.image = normal_image
    normal_node.interpolation = "Linear"
    normal_node.extension = "REPEAT"
    normal_node.location = (-620, -90)
    normal_map = nodes.new("ShaderNodeNormalMap")
    normal_map.location = (120, -130)
    normal_map.inputs["Strength"].default_value = 0.75 if lod == 0 else 0.58
    links.new(normal_node.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])
    orm_node = nodes.new("ShaderNodeTexImage")
    orm_node.image = orm_image
    orm_node.interpolation = "Linear"
    orm_node.extension = "REPEAT"
    orm_node.location = (-620, -390)
    separate = nodes.new("ShaderNodeSeparateColor")
    separate.location = (-110, -370)
    links.new(orm_node.outputs["Color"], separate.inputs["Color"])
    links.new(separate.outputs["Green"], bsdf.inputs["Roughness"])
    links.new(separate.outputs["Blue"], bsdf.inputs["Metallic"])
    group_tree = bpy.data.node_groups.get("glTF Material Output")
    if group_tree is None:
        group_tree = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
        group_tree.interface.new_socket(name="Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
    gltf_output = nodes.new("ShaderNodeGroup")
    gltf_output.node_tree = group_tree
    gltf_output.location = (120, -480)
    links.new(separate.outputs["Red"], gltf_output.inputs["Occlusion"])
    return material


def material_set(asset: str, variant: str, lod: int, seed: int) -> dict[str, bpy.types.Material]:
    if asset == "shipping-container":
        families = (f"paint-{variant}", "structural-steel", "galvanized")
    elif asset == "diesel-shunter":
        families = ("shunter-paint", "structural-steel", "galvanized", "rubber-dark", "glass-dark", "warning-paint")
    else:
        families = ("tank-shell", "structural-steel", "galvanized", "rubber-dark", "warning-paint")
        if lod == 0:
            families += ("hose-dark",)
    return {family: create_material(family, lod, seed + index * 997) for index, family in enumerate(families)}


def assign_metric_planar_uv(mesh: bpy.types.Mesh, tile_m: float = 1.25) -> None:
    mesh.update()
    uv_layer = mesh.uv_layers.get("UVMap") or mesh.uv_layers.new(name="UVMap")
    for polygon in mesh.polygons:
        normal = tuple(abs(value) for value in polygon.normal)
        dominant = max(range(3), key=lambda axis: normal[axis])
        axes = ((1, 2), (0, 2), (0, 1))[dominant]
        for loop_index in polygon.loop_indices:
            vertex = mesh.vertices[mesh.loops[loop_index].vertex_index].co
            uv_layer.data[loop_index].uv = (vertex[axes[0]] / tile_m, vertex[axes[1]] / tile_m)


def tag_object(obj: bpy.types.Object, root: bpy.types.Object, family: str, component: str, lod: int) -> None:
    obj.parent = root
    obj["tz_original_authored"] = True
    obj["tz_material_family"] = family
    obj["tz_component"] = component
    obj["tz_lod"] = lod


def create_box(
    name: str,
    size: tuple[float, float, float],
    center: tuple[float, float, float],
    material: bpy.types.Material,
    root: bpy.types.Object,
    family: str,
    component: str,
    lod: int,
    *,
    bevel: float = 0.0,
    segments: int = 1,
) -> bpy.types.Object:
    sx, sy, sz = size
    cx, cy, cz = center
    require(min(size) > 0.0, f"{name}: box size must be positive")
    vertices = [
        (cx + dx * sx * 0.5, cy + dy * sy * 0.5, cz + dz * sz * 0.5)
        for dx, dy, dz in ((-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1), (-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1))
    ]
    faces = ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7))
    mesh = bpy.data.meshes.new(f"{name}_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(material)
    mesh.update()
    assign_metric_planar_uv(mesh)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    tag_object(obj, root, family, component, lod)
    if bevel > 0.0:
        modifier = obj.modifiers.new("EdgeSoftening", "BEVEL")
        modifier.width = min(bevel, min(size) * 0.22)
        modifier.segments = segments
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.modifier_apply(modifier=modifier.name)
        obj.select_set(False)
        assign_metric_planar_uv(obj.data)
    return obj


def create_cylinder(
    name: str,
    radius: float,
    depth: float,
    center: tuple[float, float, float],
    material: bpy.types.Material,
    root: bpy.types.Object,
    family: str,
    component: str,
    lod: int,
    *,
    axis: str = "Z",
    vertices: int = 16,
) -> bpy.types.Object:
    rotation = {"X": (0.0, math.pi / 2, 0.0), "Y": (math.pi / 2, 0.0, 0.0), "Z": (0.0, 0.0, 0.0)}[axis]
    bpy.ops.mesh.primitive_cylinder_add(vertices=max(6, vertices), radius=radius, depth=depth, end_fill_type="NGON", location=center, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    obj.data.name = f"{name}_Mesh"
    obj.data.materials.append(material)
    assign_metric_planar_uv(obj.data)
    tag_object(obj, root, family, component, lod)
    return obj


def create_torus(
    name: str,
    major_radius: float,
    minor_radius: float,
    center: tuple[float, float, float],
    material: bpy.types.Material,
    root: bpy.types.Object,
    family: str,
    component: str,
    lod: int,
    *,
    major_segments: int,
    minor_segments: int,
    axis: str = "X",
) -> bpy.types.Object:
    rotation = (0.0, math.pi / 2, 0.0) if axis == "X" else (math.pi / 2, 0.0, 0.0) if axis == "Y" else (0.0, 0.0, 0.0)
    bpy.ops.mesh.primitive_torus_add(
        major_radius=major_radius,
        minor_radius=minor_radius,
        major_segments=major_segments,
        minor_segments=minor_segments,
        location=center,
        rotation=rotation,
    )
    obj = bpy.context.object
    obj.name = name
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    obj.data.name = f"{name}_Mesh"
    obj.data.materials.append(material)
    assign_metric_planar_uv(obj.data)
    tag_object(obj, root, family, component, lod)
    return obj


def create_tube_between(
    name: str,
    start: Sequence[float],
    end: Sequence[float],
    radius: float,
    material: bpy.types.Material,
    root: bpy.types.Object,
    family: str,
    component: str,
    lod: int,
    *,
    vertices: int = 8,
) -> bpy.types.Object:
    a = Vector(start)
    b = Vector(end)
    delta = b - a
    require(delta.length > 1e-5, f"{name}: tube endpoints coincide")
    midpoint = (a + b) * 0.5
    bpy.ops.mesh.primitive_cylinder_add(vertices=max(6, vertices), radius=radius, depth=delta.length, location=midpoint)
    obj = bpy.context.object
    obj.name = name
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Vector((0.0, 0.0, 1.0)).rotation_difference(delta.normalized())
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    obj.rotation_mode = "XYZ"
    obj.data.name = f"{name}_Mesh"
    obj.data.materials.append(material)
    assign_metric_planar_uv(obj.data)
    tag_object(obj, root, family, component, lod)
    return obj


def create_corrugated_side(
    name: str,
    length: float,
    height: float,
    y: float,
    outward: float,
    bottom: float,
    material: bpy.types.Material,
    root: bpy.types.Object,
    family: str,
    component: str,
    lod: int,
    waves: int,
) -> bpy.types.Object:
    phase_count = waves * 4 + 1
    vertices: list[tuple[float, float, float]] = []
    for index in range(phase_count):
        fraction = index / (phase_count - 1)
        x = -length * 0.5 + length * fraction
        phase = index % 4
        depth = (0.0, 0.036, 0.066, 0.036)[phase]
        py = y + outward * depth
        vertices.extend(((x, py, bottom), (x, py, bottom + height)))
    faces: list[tuple[int, int, int, int]] = []
    for index in range(phase_count - 1):
        a = index * 2
        face = (a, a + 2, a + 3, a + 1) if outward > 0 else (a + 1, a + 3, a + 2, a)
        faces.append(face)
    mesh = bpy.data.meshes.new(f"{name}_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(material)
    mesh.update()
    assign_metric_planar_uv(mesh, 1.05)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    tag_object(obj, root, family, component, lod)
    return obj


def create_lathed_tank(
    name: str,
    center_z: float,
    half_length: float,
    radius: float,
    material: bpy.types.Material,
    root: bpy.types.Object,
    lod: int,
    segments: int,
    profile_steps: int,
) -> bpy.types.Object:
    # One welded vessel with rounded end caps, revolved around +X.
    profiles: list[tuple[float, float]] = [(-half_length, 0.0)]
    cap_depth = radius * 0.43
    for index in range(1, profile_steps + 1):
        t = index / profile_steps
        profiles.append((-half_length + cap_depth * t, radius * math.sin(t * math.pi * 0.5)))
    profiles.append((half_length - cap_depth, radius))
    for index in range(profile_steps - 1, 0, -1):
        t = index / profile_steps
        profiles.append((half_length - cap_depth * t, radius * math.sin(t * math.pi * 0.5)))
    profiles.append((half_length, 0.0))
    vertices: list[tuple[float, float, float]] = []
    ring_indices: list[list[int]] = []
    for x, ring_radius in profiles:
        if ring_radius <= 1e-6:
            ring_indices.append([len(vertices)])
            vertices.append((x, 0.0, center_z))
        else:
            ring = []
            for segment in range(segments):
                angle = math.tau * segment / segments
                ring.append(len(vertices))
                vertices.append((x, math.cos(angle) * ring_radius, center_z + math.sin(angle) * ring_radius))
            ring_indices.append(ring)
    faces: list[tuple[int, ...]] = []
    for left, right in zip(ring_indices, ring_indices[1:]):
        if len(left) == 1:
            for segment in range(segments):
                faces.append((left[0], right[(segment + 1) % segments], right[segment]))
        elif len(right) == 1:
            for segment in range(segments):
                faces.append((left[segment], left[(segment + 1) % segments], right[0]))
        else:
            for segment in range(segments):
                next_segment = (segment + 1) % segments
                faces.append((left[segment], left[next_segment], right[next_segment], right[segment]))
    mesh = bpy.data.meshes.new(f"{name}_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(material)
    mesh.update()
    # Dominant-face metric projection has a few unobtrusive chart seams, but
    # direct render comparison showed it avoids the severe polar stretching
    # that a cylindrical normal-map unwrap introduces on domed end caps.
    assign_metric_planar_uv(mesh, 1.7)
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    tag_object(obj, root, "tank-shell", "vessel", lod)
    return obj


def add_coupler(root: bpy.types.Object, x: float, z: float, direction: float, mats: dict[str, bpy.types.Material], lod: int, prefix: str) -> None:
    steel = mats["structural-steel"]
    create_box(f"{prefix}_DraftGear", (0.48, 0.42, 0.30), (x - direction * 0.12, 0.0, z), steel, root, "structural-steel", "coupler", lod, bevel=0.025)
    create_tube_between(f"{prefix}_CouplerNeck", (x, 0.0, z), (x + direction * 0.46, 0.0, z), 0.105, steel, root, "structural-steel", "coupler", lod, vertices=10 if lod == 0 else 8)
    create_box(f"{prefix}_CouplerHead", (0.28, 0.46, 0.35), (x + direction * 0.53, 0.0, z), steel, root, "structural-steel", "coupler", lod, bevel=0.055 if lod == 0 else 0.025, segments=2 if lod == 0 else 1)


def add_bogie(
    root: bpy.types.Object,
    center_x: float,
    width: float,
    mats: dict[str, bpy.types.Material],
    lod: int,
    prefix: str,
    axle_spacing: float = 1.55,
) -> None:
    dark = mats["structural-steel"]
    wheel_mat = mats["rubber-dark"]
    wheel_radius = 0.46
    wheel_width = 0.19
    frame_z = 0.72
    create_box(f"{prefix}_BogieFrame", (axle_spacing + 0.82, width * 0.76, 0.28), (center_x, 0.0, frame_z), dark, root, "structural-steel", "bogie-frame", lod, bevel=0.06 if lod == 0 else 0.025)
    axle_positions = (center_x - axle_spacing * 0.5, center_x + axle_spacing * 0.5)
    wheel_vertices = (20, 14, 10)[lod]
    for axle_index, x in enumerate(axle_positions):
        if lod <= 1:
            create_cylinder(f"{prefix}_Axle_{axle_index}", 0.075, width * 0.78, (x, 0.0, wheel_radius), dark, root, "structural-steel", "axle", lod, axis="Y", vertices=8)
        for side in (-1, 1):
            y = side * width * 0.37
            create_cylinder(f"{prefix}_Wheel_{axle_index}_{side:+d}", wheel_radius, wheel_width, (x, y, wheel_radius), wheel_mat, root, "rubber-dark", "wheel", lod, axis="Y", vertices=wheel_vertices)
            if lod == 0:
                create_cylinder(f"{prefix}_WheelHub_{axle_index}_{side:+d}", wheel_radius * 0.30, wheel_width * 1.08, (x, y, wheel_radius), dark, root, "structural-steel", "wheel-hub", lod, axis="Y", vertices=14)
    if lod == 0:
        for x in (center_x - axle_spacing * 0.27, center_x + axle_spacing * 0.27):
            for side in (-1, 1):
                create_cylinder(f"{prefix}_Spring_{x:+.2f}_{side:+d}", 0.12, 0.38, (x, side * width * 0.34, 0.88), dark, root, "structural-steel", "suspension", lod, axis="Z", vertices=10)


def build_shipping_container(root: bpy.types.Object, mats: dict[str, bpy.types.Material], lod: int, variant: str) -> None:
    length, width, height = ASSET_SPECS["shipping-container"]["dimensionsM"]
    paint_family = f"paint-{variant}"
    paint = mats[paint_family]
    steel = mats["structural-steel"]
    galvanized = mats["galvanized"]
    rail = 0.105
    panel_bottom = 0.12
    panel_height = height - 0.24
    bevel = 0.018 if lod == 0 else 0.008 if lod == 1 else 0.0

    create_box("ContainerFloor", (length - 0.14, width - 0.14, 0.11), (0.0, 0.0, 0.075), steel, root, "structural-steel", "floor-frame", lod, bevel=bevel)
    create_box("ContainerRoof", (length - 0.12, width - 0.12, 0.085), (0.0, 0.0, height - 0.075), paint, root, paint_family, "roof", lod, bevel=bevel)
    if lod < 2:
        waves = 38 if lod == 0 else 19
        for side in (-1.0, 1.0):
            create_corrugated_side(f"CorrugatedSide_{side:+.0f}", length - 0.24, panel_height, side * (width * 0.5 - 0.07), side, panel_bottom, paint, root, paint_family, "corrugated-side", lod, waves)
    else:
        for side in (-1, 1):
            create_box(f"FarSide_{side:+d}", (length - 0.24, 0.06, panel_height), (0.0, side * (width * 0.5 - 0.04), height * 0.5), paint, root, paint_family, "corrugated-side-silhouette", lod)
    # Back end and two-leaf cargo doors at +X.
    create_box("ContainerBackEnd", (0.055, width - 0.22, height - 0.24), (-length * 0.5 + 0.07, 0.0, height * 0.5), paint, root, paint_family, "rear-end", lod)
    door_x = length * 0.5 - 0.055
    for side in (-1, 1):
        create_box(f"DoorLeaf_{side:+d}", (0.065, width * 0.435, height - 0.29), (door_x, side * width * 0.225, height * 0.5), paint, root, paint_family, "cargo-door", lod, bevel=bevel)

    # ISO frame rails, corner posts, and eight readable castings.
    for y in (-width * 0.5 + rail * 0.5, width * 0.5 - rail * 0.5):
        for z in (rail * 0.5, height - rail * 0.5):
            create_box(f"LongRail_{y:+.2f}_{z:.2f}", (length, rail, rail), (0.0, y, z), steel, root, "structural-steel", "container-frame", lod, bevel=0.015 if lod == 0 else 0.0)
    for x in (-length * 0.5 + rail * 0.5, length * 0.5 - rail * 0.5):
        for y in (-width * 0.5 + rail * 0.5, width * 0.5 - rail * 0.5):
            create_box(f"CornerPost_{x:+.2f}_{y:+.2f}", (rail, rail, height), (x, y, height * 0.5), steel, root, "structural-steel", "container-frame", lod, bevel=0.012 if lod == 0 else 0.0)
            for z in (0.10, height - 0.10):
                create_box(f"CornerCasting_{x:+.2f}_{y:+.2f}_{z:.2f}", (0.20, 0.18, 0.18), (x, y, z), galvanized, root, "galvanized", "corner-casting", lod, bevel=0.035 if lod == 0 else 0.015)
    # Door headers/sills, center seam, locking bars, handles and hinges.
    create_box("DoorHeader", (0.09, width - 0.17, 0.095), (door_x + 0.025, 0.0, height - 0.16), steel, root, "structural-steel", "door-frame", lod)
    create_box("DoorSill", (0.09, width - 0.17, 0.095), (door_x + 0.025, 0.0, 0.16), steel, root, "structural-steel", "door-frame", lod)
    create_box("DoorCenterSeam", (0.085, 0.055, height - 0.30), (door_x + 0.04, 0.0, height * 0.5), steel, root, "structural-steel", "door-frame", lod)
    lock_bars = (-0.68, -0.23, 0.23, 0.68) if lod == 0 else (-0.52, 0.52)
    for index, y in enumerate(lock_bars):
        create_cylinder(f"DoorLockBar_{index}", 0.027 if lod == 0 else 0.032, height * 0.76, (door_x + 0.08, y, height * 0.51), galvanized, root, "galvanized", "locking-bar", lod, axis="Z", vertices=10 if lod == 0 else 8)
        if lod <= 1:
            create_tube_between(f"DoorHandle_{index}", (door_x + 0.085, y, height * 0.30), (door_x + 0.085, y + 0.17 * (-1 if y > 0 else 1), height * 0.30), 0.025, galvanized, root, "galvanized", "door-handle", lod, vertices=8)
    if lod == 0:
        for side in (-1, 1):
            for hinge_index, z in enumerate((0.40, 1.08, 1.78, 2.30)):
                create_cylinder(f"DoorHinge_{side:+d}_{hinge_index}", 0.038, 0.16, (door_x + 0.08, side * width * 0.43, z), galvanized, root, "galvanized", "door-hinge", lod, axis="Z", vertices=10)
        # Sparse roof bows prevent a plain-box read from elevated views.
        for index in range(1, 16):
            x = -length * 0.5 + length * index / 16
            create_box(f"RoofBow_{index:02d}", (0.055, width - 0.15, 0.026), (x, 0.0, height - 0.017), steel, root, "structural-steel", "roof-rib", lod)


def build_diesel_shunter(root: bpy.types.Object, mats: dict[str, bpy.types.Material], lod: int) -> None:
    length, width, height = ASSET_SPECS["diesel-shunter"]["dimensionsM"]
    paint = mats["shunter-paint"]
    steel = mats["structural-steel"]
    galvanized = mats["galvanized"]
    glass = mats["glass-dark"]
    warning = mats["warning-paint"]
    bevel = 0.08 if lod == 0 else 0.04 if lod == 1 else 0.015
    add_bogie(root, -3.45, width, mats, lod, "West")
    add_bogie(root, 3.45, width, mats, lod, "East")
    frame_z = 1.02
    create_box("ShunterUnderframe", (length - 0.50, width * 0.85, 0.38), (0.0, 0.0, frame_z), steel, root, "structural-steel", "underframe", lod, bevel=bevel)
    create_box("ShunterSideSill", (length - 0.32, width, 0.17), (0.0, 0.0, 1.25), warning, root, "warning-paint", "side-sill", lod, bevel=0.025)
    # Long hood and nose remain clearly lower than the cab.
    create_box("EngineHoodLower", (7.35, 2.20, 1.34), (-1.50, 0.0, 2.05), paint, root, "shunter-paint", "engine-hood", lod, bevel=bevel, segments=2 if lod == 0 else 1)
    create_box("EngineHoodTop", (6.85, 1.98, 0.44), (-1.58, 0.0, 2.90), paint, root, "shunter-paint", "engine-hood", lod, bevel=bevel, segments=2 if lod == 0 else 1)
    create_box("ShortNose", (1.20, 2.38, 1.45), (-5.55, 0.0, 2.10), paint, root, "shunter-paint", "nose", lod, bevel=bevel)
    # Cab is built as opaque lower shell plus window band/pillars, not a solid box.
    cab_x = 3.65
    cab_l = 2.65
    create_box("CabLower", (cab_l, 2.72, 1.08), (cab_x, 0.0, 1.90), paint, root, "shunter-paint", "cab", lod, bevel=bevel)
    create_box("CabUpperCore", (cab_l * 0.91, 2.54, 0.74), (cab_x, 0.0, 3.22), paint, root, "shunter-paint", "cab", lod, bevel=bevel)
    create_box("CabRoof", (cab_l + 0.24, 2.94, 0.18), (cab_x, 0.0, height - 0.12), steel, root, "structural-steel", "cab-roof", lod, bevel=0.11 if lod == 0 else 0.045, segments=2 if lod == 0 else 1)
    window_z = 3.52
    window_h = 0.68
    for side in (-1, 1):
        create_box(f"CabSideWindow_{side:+d}", (1.54, 0.035, window_h), (cab_x, side * 1.287, window_z), glass, root, "glass-dark", "cab-window", lod, bevel=0.025)
    create_box("CabFrontWindow", (0.035, 1.68, window_h), (cab_x - cab_l * 0.456, 0.0, window_z), glass, root, "glass-dark", "cab-window", lod, bevel=0.025)
    create_box("CabRearWindow", (0.035, 1.68, window_h), (cab_x + cab_l * 0.456, 0.0, window_z), glass, root, "glass-dark", "cab-window", lod, bevel=0.025)
    # Side catwalks and railings make the shunter silhouette legible.
    for side in (-1, 1):
        y = side * (width * 0.5 - 0.12)
        create_box(f"Catwalk_{side:+d}", (9.40, 0.35, 0.12), (-1.05, y, 1.42), galvanized, root, "galvanized", "catwalk", lod)
        if lod <= 1:
            post_count = 9 if lod == 0 else 5
            for index in range(post_count):
                x = -5.55 + index * (8.95 / max(1, post_count - 1))
                create_tube_between(f"HandrailPost_{side:+d}_{index:02d}", (x, y + side * 0.06, 1.49), (x, y + side * 0.06, 2.23), 0.028 if lod == 0 else 0.035, galvanized, root, "galvanized", "handrail", lod, vertices=8)
            create_tube_between(f"HandrailTop_{side:+d}", (-5.55, y + side * 0.06, 2.23), (3.40, y + side * 0.06, 2.23), 0.030 if lod == 0 else 0.038, galvanized, root, "galvanized", "handrail", lod, vertices=8)
    # Radiator and hood ventilation are geometric at LOD0/1.
    vent_count = 16 if lod == 0 else 8 if lod == 1 else 0
    if vent_count:
        for side in (-1, 1):
            for index in range(vent_count):
                x = -3.90 + index * (4.80 / max(1, vent_count - 1))
                create_box(f"HoodVent_{side:+d}_{index:02d}", (0.075, 0.035, 0.58), (x, side * 1.115, 2.38), steel, root, "structural-steel", "vent", lod)
        for index in range(9 if lod == 0 else 5):
            z = 1.72 + index * 0.14
            create_box(f"NoseGrille_{index:02d}", (0.04, 1.68, 0.055), (-6.16, 0.0, z), steel, root, "structural-steel", "radiator-grille", lod)
    else:
        create_box("FarNoseGrille", (0.04, 1.64, 0.63), (-6.16, 0.0, 2.12), steel, root, "structural-steel", "radiator-grille", lod)
    create_cylinder("ExhaustStack", 0.14, 0.78, (-0.60, 0.0, 3.54), steel, root, "structural-steel", "exhaust", lod, axis="Z", vertices=(16, 12, 8)[lod])
    create_cylinder("ExhaustCap", 0.20, 0.07, (-0.60, 0.0, 3.94), galvanized, root, "galvanized", "exhaust", lod, axis="Z", vertices=(16, 12, 8)[lod])
    if lod == 0:
        # Cab steps, door outlines, lamps, horn and underbody reservoirs.
        for side in (-1, 1):
            for step_index, z in enumerate((0.58, 0.88, 1.17)):
                create_box(f"CabStep_{side:+d}_{step_index}", (0.52, 0.24, 0.07), (4.75, side * 1.45, z), galvanized, root, "galvanized", "cab-step", lod)
            create_box(f"CabDoor_{side:+d}", (0.92, 0.03, 1.86), (4.03, side * 1.376, 2.45), paint, root, "shunter-paint", "cab-door", lod, bevel=0.018)
        for x, direction in ((-6.15, -1), (6.08, 1)):
            for y in (-0.52, 0.52):
                create_cylinder(f"Lamp_{x:+.0f}_{y:+.1f}", 0.105, 0.07, (x, y, 2.58), warning, root, "warning-paint", "headlamp", lod, axis="X", vertices=16)
        create_tube_between("AirHorn", (3.15, 0.0, 4.28), (2.72, 0.0, 4.28), 0.055, galvanized, root, "galvanized", "horn", lod, vertices=10)
        for y in (-0.52, 0.52):
            create_cylinder(f"AirReservoir_{y:+.2f}", 0.18, 2.40, (0.15, y, 0.72), steel, root, "structural-steel", "air-reservoir", lod, axis="X", vertices=14)
    add_coupler(root, -length * 0.5 + 0.18, 0.90, -1.0, mats, lod, "West")
    add_coupler(root, length * 0.5 - 0.18, 0.90, 1.0, mats, lod, "East")


def build_tanker_wagon(root: bpy.types.Object, mats: dict[str, bpy.types.Material], lod: int) -> None:
    length, width, height = ASSET_SPECS["tanker-wagon"]["dimensionsM"]
    tank = mats["tank-shell"]
    steel = mats["structural-steel"]
    galvanized = mats["galvanized"]
    warning = mats["warning-paint"]
    hose = mats.get("hose-dark")
    add_bogie(root, -4.15, width, mats, lod, "West", axle_spacing=1.48)
    add_bogie(root, 4.15, width, mats, lod, "East", axle_spacing=1.48)
    create_box("TankerUnderframe", (length - 0.48, width * 0.80, 0.34), (0.0, 0.0, 1.00), steel, root, "structural-steel", "underframe", lod, bevel=0.055 if lod == 0 else 0.02)
    create_box("TankerDeck", (11.55, width * 0.90, 0.14), (0.0, 0.0, 1.27), galvanized, root, "galvanized", "deck", lod)
    tank_center_z = 2.66
    tank_radius = 1.40
    create_lathed_tank("TankerVessel", tank_center_z, 5.72, tank_radius, tank, root, lod, segments=(32, 20, 12)[lod], profile_steps=(5, 3, 2)[lod])
    band_count = 5 if lod == 0 else 3 if lod == 1 else 2
    for index in range(band_count):
        x = -4.35 + index * (8.70 / max(1, band_count - 1))
        create_torus(f"TankBand_{index:02d}", tank_radius + 0.012, 0.045 if lod == 0 else 0.06, (x, 0.0, tank_center_z), steel, root, "structural-steel", "tank-band", lod, major_segments=(32, 20, 12)[lod], minor_segments=(8, 6, 4)[lod], axis="X")
    # Cradles seat the vessel visibly on the chassis.
    for x in (-3.85, 3.85):
        create_box(f"TankCradle_{x:+.2f}", (0.34, 2.38, 0.55), (x, 0.0, 1.55), steel, root, "structural-steel", "tank-cradle", lod, bevel=0.06 if lod == 0 else 0.02)
    create_cylinder("TopHatchNeck", 0.30, 0.22, (0.0, 0.0, 4.02), steel, root, "structural-steel", "hatch", lod, axis="Z", vertices=(20, 14, 10)[lod])
    create_cylinder("TopHatchLid", 0.39, 0.11, (0.0, 0.0, 4.18), warning, root, "warning-paint", "hatch", lod, axis="Z", vertices=(20, 14, 10)[lod])
    create_box("TopWalkway", (2.65 if lod == 0 else 1.55, 0.62, 0.08), (0.0, 0.0, 4.08), galvanized, root, "galvanized", "top-walkway", lod)
    if lod <= 1:
        # Side ladder: two vertical stiles with horizontal rungs.
        ladder_y = -1.425
        for x in (-0.30, 0.30):
            create_tube_between(f"LadderStile_{x:+.2f}", (x, ladder_y, 1.24), (x, ladder_y, 4.03), 0.028 if lod == 0 else 0.038, galvanized, root, "galvanized", "ladder", lod, vertices=8)
        rung_count = 10 if lod == 0 else 6
        for index in range(rung_count):
            z = 1.37 + index * (2.48 / max(1, rung_count - 1))
            create_tube_between(f"LadderRung_{index:02d}", (-0.30, ladder_y, z), (0.30, ladder_y, z), 0.025 if lod == 0 else 0.035, galvanized, root, "galvanized", "ladder", lod, vertices=8)
        # Hatch guard rails and tank-top grab loops.
        for side in (-1, 1):
            y = side * 0.36
            create_tube_between(f"HatchRailPost_{side:+d}", (-0.84, y, 4.10), (-0.84, y, 4.65), 0.027, galvanized, root, "galvanized", "hatch-rail", lod, vertices=8)
            create_tube_between(f"HatchRailTop_{side:+d}", (-0.84, y, 4.65), (0.84, y, 4.65), 0.027, galvanized, root, "galvanized", "hatch-rail", lod, vertices=8)
            create_tube_between(f"HatchRailPostB_{side:+d}", (0.84, y, 4.10), (0.84, y, 4.65), 0.027, galvanized, root, "galvanized", "hatch-rail", lod, vertices=8)
    if lod == 0:
        # Discharge valve, hose, end ladders and brake wheel.
        require(hose is not None, "LOD0 tanker requires the hose material")
        create_cylinder("DischargeValve", 0.18, 0.42, (0.0, 0.0, 1.18), steel, root, "structural-steel", "valve", lod, axis="Z", vertices=16)
        create_tube_between("DischargePipe", (0.0, 0.0, 1.12), (0.0, -1.24, 1.12), 0.07, hose, root, "hose-dark", "pipe", lod, vertices=10)
        create_torus("BrakeWheel", 0.29, 0.025, (5.80, 1.22, 1.82), warning, root, "warning-paint", "brake-wheel", lod, major_segments=20, minor_segments=6, axis="Y")
        for angle_index in range(6):
            angle = math.tau * angle_index / 6
            create_tube_between(f"BrakeWheelSpoke_{angle_index}", (5.80, 1.22, 1.82), (5.80 + math.cos(angle) * 0.26, 1.22, 1.82 + math.sin(angle) * 0.26), 0.018, warning, root, "warning-paint", "brake-wheel", lod, vertices=6)
    add_coupler(root, -length * 0.5 + 0.20, 0.89, -1.0, mats, lod, "West")
    add_coupler(root, length * 0.5 - 0.20, 0.89, 1.0, mats, lod, "East")


def merge_by_material(root: bpy.types.Object, lod: int) -> None:
    """Collapse authored components to one primitive per material for runtime use.

    The root keeps a semantic component inventory so the proof remains auditable;
    the exported geometry avoids turning each bolt/rail/rib into a draw call.
    """
    mesh_objects = [obj for obj in root.children_recursive if obj.type == "MESH"]
    component_inventory = sorted({str(obj.get("tz_component", "unknown")) for obj in mesh_objects})
    root["tz_component_inventory"] = ",".join(component_inventory)
    # Tangent-bearing normal maps require triangle/quad source polygons. Apply
    # deterministic triangulation before material merging so cylindrical NGON
    # caps cannot force implementation-dependent runtime tangent generation.
    for obj in mesh_objects:
        modifier = obj.modifiers.new("ExportTriangulation", "TRIANGULATE")
        modifier.quad_method = "FIXED"
        modifier.ngon_method = "BEAUTY"
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.modifier_apply(modifier=modifier.name)
        obj.select_set(False)
    groups: dict[str, list[bpy.types.Object]] = {}
    for obj in mesh_objects:
        require(len(obj.data.materials) == 1 and obj.data.materials[0] is not None, f"{obj.name}: exactly one material required")
        groups.setdefault(obj.data.materials[0].name, []).append(obj)
    for material_name, objects in sorted(groups.items()):
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        active = objects[0]
        bpy.context.view_layer.objects.active = active
        if len(objects) > 1:
            bpy.ops.object.join()
        active.name = f"Merged_{material_name}"
        active.data.name = f"Merged_{material_name}_Mesh"
        active["tz_component"] = "merged-render-geometry"
        active["tz_lod"] = lod
        active["tz_original_authored"] = True
        for polygon in active.data.polygons:
            polygon.material_index = 0
        while len(active.data.materials) > 1:
            active.data.materials.pop(index=len(active.data.materials) - 1)
    bpy.ops.object.select_all(action="DESELECT")


def build_asset(asset: str, variant: str, lod: int, seed: int) -> tuple[bpy.types.Object, dict]:
    reset_scene()
    root = bpy.data.objects.new(f"TZ_{asset}_Root", None)
    bpy.context.scene.collection.objects.link(root)
    root["tz_asset_id"] = f"customs.authored.{asset}"
    root["tz_asset_family"] = asset
    root["tz_variant"] = variant
    root["tz_lod"] = lod
    root["tz_units"] = "metres"
    root["tz_author_frame"] = "+X length, +Y width, +Z up"
    root["tz_export_frame"] = "glTF +Y up, +X length, +Z width"
    root["tz_pivot_contract"] = "base-center at (0,0,0)"
    root["tz_collision"] = "none"
    root["tz_tactical_accuracy_claim"] = "none"
    root["tz_original_authored"] = True
    root["tz_game_payloads"] = "none"
    mats = material_set(asset, variant, lod, seed)
    if asset == "shipping-container":
        build_shipping_container(root, mats, lod, variant)
    elif asset == "diesel-shunter":
        build_diesel_shunter(root, mats, lod)
    else:
        build_tanker_wagon(root, mats, lod)
    merge_by_material(root, lod)
    scene_objects = list(root.children_recursive)
    mesh_objects = [obj for obj in scene_objects if obj.type == "MESH"]
    require(mesh_objects, "asset contains no mesh objects")
    triangles = sum(sum(max(0, len(poly.vertices) - 2) for poly in obj.data.polygons) for obj in mesh_objects)
    vertices = sum(len(obj.data.vertices) for obj in mesh_objects)
    bounds = geometry_bounds(mesh_objects)
    require(abs(bounds["min"][2]) <= 1e-4, f"asset pivot must touch z=0, got {bounds['min'][2]}")
    center_x = (bounds["min"][0] + bounds["max"][0]) * 0.5
    center_y = (bounds["min"][1] + bounds["max"][1]) * 0.5
    require(abs(center_x) <= 0.12 and abs(center_y) <= 0.12, f"asset footprint must remain centered, got {(center_x, center_y)}")
    stats = {"meshObjects": len(mesh_objects), "vertices": vertices, "triangles": triangles, "boundsBlenderM": rounded_bounds(bounds)}
    return root, stats


def geometry_bounds(mesh_objects: Iterable[bpy.types.Object]) -> dict[str, list[float]]:
    minimum = [math.inf, math.inf, math.inf]
    maximum = [-math.inf, -math.inf, -math.inf]
    for obj in mesh_objects:
        for vertex in obj.data.vertices:
            point = obj.matrix_world @ vertex.co
            for axis in range(3):
                minimum[axis] = min(minimum[axis], point[axis])
                maximum[axis] = max(maximum[axis], point[axis])
    require(all(math.isfinite(value) for value in minimum + maximum), "asset geometry has no finite bounds")
    return {"min": minimum, "max": maximum}


def rounded_bounds(bounds: dict[str, list[float]]) -> dict[str, list[float]]:
    minimum = [round(value, 6) for value in bounds["min"]]
    maximum = [round(value, 6) for value in bounds["max"]]
    return {
        "min": minimum,
        "max": maximum,
        "sizeM": [round(maximum[index] - minimum[index], 6) for index in range(3)],
        "centerM": [round((maximum[index] + minimum[index]) * 0.5, 6) for index in range(3)],
    }


def glb_json(path: Path) -> dict:
    blob = path.read_bytes()
    require(len(blob) >= 20, "exported GLB is truncated")
    magic, version, declared_length = struct.unpack_from("<4sII", blob, 0)
    require(magic == GLB_MAGIC and version == 2 and declared_length == len(blob), "invalid GLB header")
    offset = 12
    document = None
    while offset + 8 <= len(blob):
        length, kind = struct.unpack_from("<II", blob, offset)
        offset += 8
        end = offset + length
        require(end <= len(blob), "GLB chunk exceeds file")
        if kind == GLB_JSON_CHUNK:
            require(document is None, "duplicate GLB JSON chunk")
            document = json.loads(blob[offset:end].decode("utf-8"))
        offset = end
    require(offset == len(blob) and isinstance(document, dict), "invalid GLB chunk layout")
    return document


def exported_stats(document: dict) -> dict:
    accessors = document.get("accessors", [])
    triangles = 0
    vertices = 0
    draw_calls = 0
    minimum = [math.inf, math.inf, math.inf]
    maximum = [-math.inf, -math.inf, -math.inf]
    for mesh in document.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            draw_calls += 1
            position_index = primitive.get("attributes", {}).get("POSITION")
            require(isinstance(position_index, int), "primitive lacks POSITION accessor")
            position = accessors[position_index]
            vertices += int(position["count"])
            mode = int(primitive.get("mode", 4))
            count = int(accessors[primitive["indices"]]["count"]) if "indices" in primitive else int(position["count"])
            triangles += count // 3 if mode == 4 else max(0, count - 2) if mode in (5, 6) else 0
            low = position.get("min")
            high = position.get("max")
            require(isinstance(low, list) and isinstance(high, list) and len(low) == len(high) == 3, "POSITION bounds missing")
            for axis in range(3):
                minimum[axis] = min(minimum[axis], float(low[axis]))
                maximum[axis] = max(maximum[axis], float(high[axis]))
    require(draw_calls > 0, "exported GLB has no draw calls")
    return {
        "triangles": triangles,
        "vertices": vertices,
        "drawCalls": draw_calls,
        "materials": len(document.get("materials", [])),
        "textures": len(document.get("textures", [])),
        "images": len(document.get("images", [])),
        "boundsGltfM": rounded_bounds({"min": minimum, "max": maximum}),
    }


def export_glb_exclusive(output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{output.stem}.", suffix=".exporting.glb", dir=output.parent)
    os.close(descriptor)
    os.unlink(temporary_name)
    temporary = Path(temporary_name)
    try:
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
        require(result == {"FINISHED"} and temporary.is_file(), f"glTF export failed: {result}")
        os.link(temporary, output)
    finally:
        if temporary.exists():
            temporary.unlink()


def receipt_document(args: argparse.Namespace, source_stats: dict, glb_stats: dict) -> dict:
    script_path = Path(__file__).resolve()
    return {
        "schemaVersion": 1,
        "documentType": "tarkovzero-customs-original-industrial-prop-receipt",
        "status": "offline-proof-only-not-live",
        "asset": {
            "id": f"customs.authored.{args.asset}.{args.variant}",
            "family": args.asset,
            "variant": args.variant,
            "lod": args.lod,
            "description": ASSET_SPECS[args.asset]["description"],
            "nominalDimensionsAuthorM": list(ASSET_SPECS[args.asset]["dimensionsM"]),
            "axisPivotContract": {
                "authorFrame": "+X length, +Y width, +Z up",
                "gltfFrame": "+X length, +Y up, +Z width",
                "units": "metres",
                "pivot": "base-center at (0,0,0)",
            },
        },
        "generator": {
            "name": GENERATOR_NAME,
            "version": GENERATOR_VERSION,
            "scriptSha256": f"sha256:{sha256_file(script_path)}",
            "blenderVersion": bpy.app.version_string,
            "seed": args.seed,
            "requiredInvocationFlags": ["--background", "--factory-startup", "--disable-autoexec", "--python-exit-code 1"],
        },
        "output": {
            "file": args.output.name,
            "bytes": args.output.stat().st_size,
            "sha256": f"sha256:{sha256_file(args.output)}",
            **glb_stats,
            "sourceScene": source_stats,
        },
        "provenance": {
            "authoring": "original procedural Blender geometry and hash-noise PBR textures",
            "allowedInputs": ["public engineering proportions", "repository semantic feature IDs", "sanitized scalar dimensions"],
            "eftInstallationRead": False,
            "gameMeshesCopied": False,
            "gameTexturesCopied": False,
            "gameShadersCopied": False,
            "externalNetworkUsed": False,
            "copyrightBoundary": "No EFT or Re3mr creative payload entered this output.",
        },
        "claims": {
            "embeddedOnly": True,
            "cameras": False,
            "lights": False,
            "fog": False,
            "animations": False,
            "skins": False,
            "collision": False,
            "tacticalAccuracy": False,
            "sourceGameEquivalence": False,
            "visualPurpose": "recognizable original-authored industrial callout prototype",
        },
        "admission": {
            "livePromotion": False,
            "requires": ["fixed-camera visual review", "runtime placement integration", "target-GPU performance measurement"],
        },
    }


def main(argv: Sequence[str] | None = None) -> None:
    args = parse_args(script_args() if argv is None else argv)
    validate_blender()
    _, source_stats = build_asset(args.asset, args.variant, args.lod, args.seed)
    export_glb_exclusive(args.output)
    document = glb_json(args.output)
    stats = exported_stats(document)
    receipt = receipt_document(args, source_stats, stats)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    with args.receipt.open("x", encoding="utf-8") as handle:
        json.dump(receipt, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print(json.dumps({"output": str(args.output), "receipt": str(args.receipt), "stats": stats}, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"industrial prop factory failed: {error}", file=sys.stderr)
        raise
