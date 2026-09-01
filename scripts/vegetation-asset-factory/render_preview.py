#!/usr/bin/env python3
"""Render a neutral QA preview of one generated vegetation GLB with Blender."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import sys

import bpy
from mathutils import Vector


CATALOG_PATH = Path(__file__).with_name("prototype_catalog.json")


def after_separator() -> list[str]:
    try:
        return sys.argv[sys.argv.index("--") + 1 :]
    except ValueError:
        return []


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Render a studio QA frame for one vegetation GLB.")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--prototype", required=True)
    parser.add_argument("--size", type=int, default=640)
    parser.add_argument("--view", choices=("standard", "close", "side", "top"), default="standard")
    parser.add_argument(
        "--transparent-silhouette",
        action="store_true",
        help="render the fixed camera without the QA ground so alpha is an exact object silhouette mask",
    )
    args = parser.parse_args(after_separator())
    args.input = args.input.expanduser().resolve()
    args.output = args.output.expanduser().resolve()
    if not args.input.is_file() or args.input.suffix.lower() != ".glb":
        parser.error("--input must be an existing GLB")
    if args.output.suffix.lower() != ".png" or args.output.exists():
        parser.error("--output must be a new PNG path")
    if not 256 <= args.size <= 2048:
        parser.error("--size must be 256..2048")
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    prototypes = {entry["name"]: entry for entry in catalog["prototypes"]}
    if args.prototype not in prototypes:
        parser.error("--prototype is not in the reviewed 31-name catalog")
    args.prototype_spec = prototypes[args.prototype]
    return args


def scene_bounds() -> tuple[Vector, Vector]:
    minimum = Vector((math.inf, math.inf, math.inf))
    maximum = Vector((-math.inf, -math.inf, -math.inf))
    found = False
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        found = True
        for corner in obj.bound_box:
            point = obj.matrix_world @ Vector(corner)
            minimum.x = min(minimum.x, point.x)
            minimum.y = min(minimum.y, point.y)
            minimum.z = min(minimum.z, point.z)
            maximum.x = max(maximum.x, point.x)
            maximum.y = max(maximum.y, point.y)
            maximum.z = max(maximum.z, point.z)
    if not found:
        raise ValueError("GLB has no mesh geometry")
    return minimum, maximum


def look_at(obj: bpy.types.Object, target: Vector) -> None:
    obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()


def material(name: str, color: tuple[float, float, float], roughness: float) -> bpy.types.Material:
    result = bpy.data.materials.new(name)
    result.diffuse_color = (*color, 1.0)
    result.use_nodes = True
    bsdf = result.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    return result


def add_area(name: str, location: tuple[float, float, float], energy: float, size: float, target: Vector) -> None:
    data = bpy.data.lights.new(name, "AREA")
    data.energy = energy
    data.shape = "DISK"
    data.size = size
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = location
    look_at(obj, target)


def main() -> None:
    args = parse_args()
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(args.input))
    bpy.context.view_layer.update()
    minimum, maximum = scene_bounds()
    height = float(args.prototype_spec["nominalHeightM"])
    diameter = float(args.prototype_spec["nominalWidthM"])
    actual_height = maximum.z - minimum.z
    if abs(actual_height - height) > 0.002:
        raise ValueError(f"asset height {actual_height:.6f} does not match camera contract {height:.6f}")
    center = Vector((0.0, 0.0, minimum.z + height * 0.5))

    if not args.transparent_silhouette:
        plane_size = max(diameter * 3.5, height * 1.6, 4.0)
        bpy.ops.mesh.primitive_plane_add(size=plane_size, location=(center.x, center.y, minimum.z - 0.004))
        ground = bpy.context.object
        ground.name = "QA_Ground"
        ground.data.materials.append(material("QA_Ground_Material", (0.115, 0.14, 0.075), 0.93))

    target = Vector((center.x, center.y, minimum.z + height * 0.48))
    distance = max(height * 1.12, diameter * 2.35)
    camera_data = bpy.data.cameras.new("QA_Camera")
    camera = bpy.data.objects.new("QA_Camera", camera_data)
    bpy.context.scene.collection.objects.link(camera)
    if args.view == "standard":
        camera.location = Vector((center.x + distance * 0.78, center.y - distance, minimum.z + height * 0.61))
        # Keep the full nominal envelope inside the square QA frame. The old
        # 66 mm framing clipped both apex and base on tree02, which made any
        # fixed-camera silhouette metric falsely report perfect height.
        camera_data.lens = 50
    elif args.view == "side":
        camera.location = Vector((center.x - distance, center.y - distance * 0.32, minimum.z + height * 0.59))
        camera_data.lens = 66
    elif args.view == "close":
        target = Vector((center.x, center.y, minimum.z + height * 0.58))
        close_distance = max(diameter * 1.42, height * 0.48)
        camera.location = Vector((center.x + close_distance * 0.48, center.y - close_distance, minimum.z + height * 0.61))
        camera_data.lens = 72
    else:
        target = Vector((center.x, center.y, minimum.z + height * 0.53))
        camera.location = Vector((center.x, center.y, minimum.z + height + max(diameter * 1.6, 4.0)))
        camera_data.lens = 58
    camera_data.sensor_width = 36
    look_at(camera, target)
    bpy.context.scene.camera = camera

    add_area(
        "QA_Key", (center.x - distance * 0.55, center.y - distance * 0.45, minimum.z + height * 1.35),
        620.0, max(3.0, diameter * 1.4), target,
    )
    add_area(
        "QA_Fill", (center.x + distance * 0.7, center.y + distance * 0.25, minimum.z + height * 0.78),
        360.0, max(2.0, diameter), target,
    )
    sun_data = bpy.data.lights.new("QA_Sun", "SUN")
    sun_data.energy = 1.7
    sun_data.angle = math.radians(18)
    sun = bpy.data.objects.new("QA_Sun", sun_data)
    bpy.context.scene.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(28), math.radians(-22), math.radians(135))

    world = bpy.context.scene.world or bpy.data.worlds.new("QA_World")
    bpy.context.scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = (0.09, 0.105, 0.115, 1.0)
    background.inputs["Strength"].default_value = 0.55

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = args.size
    scene.render.resolution_y = args.size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = args.transparent_silhouette
    scene.render.filepath = str(args.output)
    scene.render.image_settings.color_depth = "8"
    scene.view_settings.look = "AgX - Medium High Contrast"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.render.render(write_still=True)
    if not args.output.is_file():
        raise RuntimeError("preview render did not create the PNG")
    print(json.dumps({
        "output": str(args.output),
        "prototype": args.prototype,
        "view": args.view,
        "transparentSilhouette": args.transparent_silhouette,
        "cameraContract": {
            "nominalHeightM": height,
            "nominalWidthM": diameter,
            "lensMm": camera_data.lens,
            "target": list(target),
            "location": list(camera.location),
        },
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError) as error:
        print(f"vegetation preview failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
