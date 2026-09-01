#!/usr/bin/env python3
"""Render one GLB from the factory's fixed admission camera."""

from __future__ import annotations

import argparse
import math
from pathlib import Path
import sys

import bpy
from mathutils import Vector


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def script_args() -> list[str]:
    try:
        return sys.argv[sys.argv.index("--") + 1 :]
    except ValueError:
        return []


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--glb", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--view", choices=("oblique", "side"), default="oblique")
    args = parser.parse_args(script_args())
    args.glb = args.glb.expanduser().resolve()
    args.output = args.output.expanduser().resolve()
    require(args.glb.is_file() and args.glb.suffix.lower() == ".glb", "--glb must exist")
    require(args.output.suffix.lower() == ".png", "--output must use .png")
    require(not args.output.exists(), f"refusing to overwrite {args.output}")
    return args


def look_at(obj: bpy.types.Object, target: Vector) -> None:
    obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()


def imported_bounds(objects: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    minimum = Vector((math.inf, math.inf, math.inf))
    maximum = Vector((-math.inf, -math.inf, -math.inf))
    for obj in objects:
        if obj.type != "MESH":
            continue
        for corner in obj.bound_box:
            point = obj.matrix_world @ Vector(corner)
            for axis in range(3):
                minimum[axis] = min(minimum[axis], point[axis])
                maximum[axis] = max(maximum[axis], point[axis])
    require(all(math.isfinite(value) for value in (*minimum, *maximum)), "imported GLB has no bounded geometry")
    return minimum, maximum


def main() -> None:
    args = parse_args()
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    before = set(bpy.context.scene.objects)
    result = bpy.ops.import_scene.gltf(filepath=str(args.glb), import_pack_images=True)
    require(result == {"FINISHED"}, f"glTF import failed: {result}")
    imported = [obj for obj in bpy.context.scene.objects if obj not in before]
    minimum, maximum = imported_bounds(imported)
    size = maximum - minimum
    center = (minimum + maximum) * 0.5

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = 768
    scene.render.resolution_y = 512
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = False
    scene.render.filepath = str(args.output)
    scene.render.use_file_extension = True
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = 0.55
    scene.render.resolution_percentage = 100
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = (0.045, 0.052, 0.048, 1.0)
    background.inputs["Strength"].default_value = 0.68

    # Matte ground and a restrained three-light overcast/yard setup.
    bpy.ops.mesh.primitive_plane_add(size=max(40.0, size.x * 3.0), location=(center.x, center.y, minimum.z - 0.012))
    ground = bpy.context.object
    ground.name = "QA_Ground"
    ground_mat = bpy.data.materials.new("QA_Ground_Material")
    ground_mat.diffuse_color = (0.10, 0.115, 0.10, 1.0)
    ground_mat.roughness = 0.94
    ground.data.materials.append(ground_mat)

    def add_area(name: str, location: tuple[float, float, float], energy: float, color: tuple[float, float, float], scale: float) -> None:
        data = bpy.data.lights.new(name, "AREA")
        data.energy = energy
        data.color = color
        data.shape = "DISK"
        data.size = scale
        obj = bpy.data.objects.new(name, data)
        scene.collection.objects.link(obj)
        obj.location = location
        look_at(obj, center)

    add_area("Key_Overcast", (center.x - size.x * 0.35, center.y - size.x * 0.55, maximum.z + size.x * 0.62), 1150.0, (0.90, 0.95, 1.0), max(6.0, size.x * 0.72))
    add_area("Warm_Fill", (center.x + size.x * 0.65, center.y + size.x * 0.30, maximum.z + size.x * 0.25), 700.0, (1.0, 0.78, 0.58), max(4.0, size.x * 0.48))
    add_area("Rim", (center.x - size.x * 0.75, center.y + size.x * 0.36, maximum.z + size.x * 0.18), 920.0, (0.62, 0.76, 1.0), max(4.0, size.x * 0.40))

    camera_data = bpy.data.cameras.new("QA_Camera")
    camera = bpy.data.objects.new("QA_Camera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    if args.view == "side":
        camera.location = (center.x, minimum.y - max(10.0, size.x * 0.95), center.z + size.z * 0.34)
        camera_data.ortho_scale = max(size.z * 1.68, size.x * 0.76)
    else:
        camera.location = (maximum.x + size.x * 0.47, minimum.y - size.x * 0.72, maximum.z + size.x * 0.44)
        camera_data.ortho_scale = max(size.z * 1.82, size.x * 0.66)
    camera_data.type = "ORTHO"
    camera_data.lens = 52.0
    look_at(camera, Vector((center.x, center.y, minimum.z + size.z * 0.44)))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.render.render(write_still=True)
    require(args.output.is_file(), "renderer did not create output")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"industrial preview render failed: {error}", file=sys.stderr)
        raise
