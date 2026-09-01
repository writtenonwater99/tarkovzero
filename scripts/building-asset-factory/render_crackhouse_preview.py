#!/usr/bin/env python3
"""Render one Crackhouse GLB from fixed offline admission cameras."""

from __future__ import annotations

import argparse
import math
from pathlib import Path
import sys

import bpy
from mathutils import Vector


REFERENCE_MIN = Vector((-12.70, -8.70, -0.18))
REFERENCE_MAX = Vector((12.70, 8.70, 6.50))
REFERENCE_CENTRE = (REFERENCE_MIN + REFERENCE_MAX) * 0.5
REFERENCE_SIZE = REFERENCE_MAX - REFERENCE_MIN


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def script_args() -> list[str]:
    return sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else []


def parse_args() -> argparse.Namespace:
    parser=argparse.ArgumentParser()
    parser.add_argument("--glb",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True)
    parser.add_argument("--view",choices=("oblique","south","east"),default="oblique")
    args=parser.parse_args(script_args())
    args.glb=args.glb.expanduser().resolve();args.output=args.output.expanduser().resolve()
    require(args.glb.is_file() and args.glb.suffix.lower()==".glb","--glb must be an existing GLB")
    require(args.output.suffix.lower()==".png","--output must use .png")
    require(args.output.parent.is_dir(),"output directory must exist")
    require(not args.output.exists(),f"refusing to overwrite {args.output}")
    return args


def look_at(obj: bpy.types.Object,target: Vector) -> None:
    obj.rotation_euler=(target-obj.location).to_track_quat("-Z","Y").to_euler()


def bounds(objects: list[bpy.types.Object]) -> tuple[Vector,Vector]:
    minimum=Vector((math.inf,math.inf,math.inf));maximum=Vector((-math.inf,-math.inf,-math.inf))
    for obj in objects:
        if obj.type!="MESH":continue
        for corner in obj.bound_box:
            point=obj.matrix_world@Vector(corner)
            for axis in range(3):minimum[axis]=min(minimum[axis],point[axis]);maximum[axis]=max(maximum[axis],point[axis])
    require(all(math.isfinite(value) for value in (*minimum,*maximum)),"imported GLB has no bounded geometry")
    return minimum,maximum


def main() -> None:
    args=parse_args()
    bpy.ops.object.select_all(action="SELECT");bpy.ops.object.delete(use_global=False)
    before=set(bpy.context.scene.objects)
    result=bpy.ops.import_scene.gltf(filepath=str(args.glb),import_pack_images=True)
    require(result=={"FINISHED"},f"glTF import failed: {result}")
    imported=[obj for obj in bpy.context.scene.objects if obj not in before]
    minimum,maximum=bounds(imported)
    require(all(minimum[axis] >= REFERENCE_MIN[axis]-.005 for axis in range(3)),f"model exceeds fixed QA minimum envelope: {tuple(minimum)}")
    require(all(maximum[axis] <= REFERENCE_MAX[axis]+.005 for axis in range(3)),f"model exceeds fixed QA maximum envelope: {tuple(maximum)}")
    size=REFERENCE_SIZE;centre=REFERENCE_CENTRE
    scene=bpy.context.scene
    scene.render.engine="BLENDER_EEVEE_NEXT"
    scene.render.resolution_x=900;scene.render.resolution_y=600;scene.render.resolution_percentage=100
    scene.render.image_settings.file_format="PNG";scene.render.image_settings.color_mode="RGBA"
    scene.render.film_transparent=False;scene.render.filepath=str(args.output);scene.render.use_file_extension=True
    scene.view_settings.look="AgX - Medium High Contrast";scene.view_settings.exposure=1.0
    scene.world.use_nodes=True
    background=scene.world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value=(.075,.083,.074,1);background.inputs["Strength"].default_value=.95

    # This fixed plane can expose base-pivot drift between LODs. It is an asset-base
    # reference only and deliberately makes no terrain-contact claim.
    bpy.ops.mesh.primitive_plane_add(size=55,location=(centre.x,centre.y,REFERENCE_MIN.z-.004))
    ground=bpy.context.object;ground.name="QA_Ground"
    ground_mat=bpy.data.materials.new("QA_Ground_Material");ground_mat.diffuse_color=(.115,.12,.095,1);ground_mat.roughness=.96
    ground.data.materials.append(ground_mat)

    def area(name: str,location: tuple[float,float,float],energy: float,color: tuple[float,float,float],diameter: float) -> None:
        data=bpy.data.lights.new(name,"AREA");data.energy=energy;data.color=color;data.shape="DISK";data.size=diameter
        obj=bpy.data.objects.new(name,data);scene.collection.objects.link(obj);obj.location=location;look_at(obj,Vector((centre.x,centre.y,minimum.z+size.z*.42)))
    area("Overcast_Key",(centre.x-size.x*.42,centre.y-size.x*.65,maximum.z+size.x*.58),1750,(.90,.95,1.0),max(7,size.x*.72))
    area("Warm_Bounce",(centre.x+size.x*.65,centre.y-size.x*.05,maximum.z+size.x*.20),820,(1.0,.79,.60),max(5,size.x*.48))
    area("Cool_Rim",(centre.x-size.x*.55,centre.y+size.x*.55,maximum.z+size.x*.32),1050,(.65,.78,1.0),max(5,size.x*.42))

    camera_data=bpy.data.cameras.new("QA_Camera");camera=bpy.data.objects.new("QA_Camera",camera_data);scene.collection.objects.link(camera);scene.camera=camera
    camera_data.type="ORTHO"
    target=Vector((centre.x,centre.y,minimum.z+size.z*.43))
    if args.view=="south":
        camera.location=(0,-34,4.0)
        camera_data.ortho_scale=29.8
    elif args.view=="east":
        camera.location=(34,0,4.0)
        camera_data.ortho_scale=20.4
    else:
        camera.location=(24,-32,18)
        camera_data.ortho_scale=36.0
    look_at(camera,target)
    bpy.ops.render.render(write_still=True)
    require(args.output.is_file(),"renderer did not create output")


if __name__=="__main__":
    try:main()
    except Exception as error:
        print(f"Crackhouse preview failed: {error}",file=sys.stderr)
        raise
