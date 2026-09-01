#!/usr/bin/env python3
"""Render one Crackhouse GLB from a fixed, model-independent QA camera rig.

Every camera, light, and ground-plane number here is derived from the frozen
REFERENCE envelope alone. Nothing in the rig may read the imported GLB. The
sheet exists to compare LODs under one camera and one light rig, and a rig that
follows each model's own bounds is three cameras wearing one label: the
comparison it invites is not the comparison it performs.

The frame is derived, never hand-tuned. `ortho_scale` is computed from the
projected envelope so a camera can no longer silently crop the subject, and
`test_crackhouse_qa_rig.py` fails if any envelope corner leaves the picture.
"""

from __future__ import annotations

import argparse
import math
from pathlib import Path
import sys

import bpy
from mathutils import Vector


# Frozen QA envelope, a little larger than the authored shell so ordinary
# authoring does not move the camera. A model outside it fails loudly instead.
REFERENCE_MIN = (-12.70, -8.70, -0.18)
REFERENCE_MAX = (12.70, 8.70, 6.50)
REFERENCE_CENTRE = tuple((REFERENCE_MIN[i] + REFERENCE_MAX[i]) * .5 for i in range(3))
REFERENCE_SIZE = tuple(REFERENCE_MAX[i] - REFERENCE_MIN[i] for i in range(3))
REFERENCE_HALF = tuple(value * .5 for value in REFERENCE_SIZE)
ENVELOPE_TOLERANCE_M = .005

RESOLUTION = (900, 600)
# The frame is this much wider than the projected envelope on its limiting axis,
# so the whole silhouette sits inside the picture with visible air around it.
FRAME_MARGIN = 1.16

# Fixed eyes. Every view aims at the envelope centre, so the projected envelope
# is centred by construction and its margin is symmetric on both edges.
VIEW_EYES = {
    "south": (0., -34., 6.6),
    "east": (34., 0., 6.6),
    "oblique": (25., -31., 19.),
}

QA_GROUND_SIZE_M = 55.
# 4 mm under the frozen envelope floor, not under the model's own floor: a shell
# whose base drifts downward now cuts this plane instead of hovering over it by
# a constant. It is an asset-base datum and makes no terrain-contact claim.
QA_GROUND_Z = REFERENCE_MIN[2] - .004
LIGHT_AIM = (REFERENCE_CENTRE[0], REFERENCE_CENTRE[1], REFERENCE_MIN[2] + REFERENCE_SIZE[2] * .42)
LIGHT_RIG = (
    ("Overcast_Key", (REFERENCE_CENTRE[0]-REFERENCE_SIZE[0]*.42, REFERENCE_CENTRE[1]-REFERENCE_SIZE[0]*.65, REFERENCE_MAX[2]+REFERENCE_SIZE[0]*.58), 1750, (.90, .95, 1.0), max(7, REFERENCE_SIZE[0]*.72)),
    ("Warm_Bounce", (REFERENCE_CENTRE[0]+REFERENCE_SIZE[0]*.65, REFERENCE_CENTRE[1]-REFERENCE_SIZE[0]*.05, REFERENCE_MAX[2]+REFERENCE_SIZE[0]*.20), 820, (1.0, .79, .60), max(5, REFERENCE_SIZE[0]*.48)),
    ("Cool_Rim", (REFERENCE_CENTRE[0]-REFERENCE_SIZE[0]*.55, REFERENCE_CENTRE[1]+REFERENCE_SIZE[0]*.55, REFERENCE_MAX[2]+REFERENCE_SIZE[0]*.32), 1050, (.65, .78, 1.0), max(5, REFERENCE_SIZE[0]*.42)),
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def script_args() -> list[str]:
    return sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else []


def parse_args() -> argparse.Namespace:
    parser=argparse.ArgumentParser()
    parser.add_argument("--glb",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True)
    parser.add_argument("--view",choices=tuple(VIEW_EYES),default="oblique")
    args=parser.parse_args(script_args())
    args.glb=args.glb.expanduser().resolve();args.output=args.output.expanduser().resolve()
    require(args.glb.is_file() and args.glb.suffix.lower()==".glb","--glb must be an existing GLB")
    require(args.output.suffix.lower()==".png","--output must use .png")
    require(args.output.parent.is_dir(),"output directory must exist")
    require(not args.output.exists(),f"refusing to overwrite {args.output}")
    return args


def subtract(a: tuple[float,float,float],b: tuple[float,float,float]) -> tuple[float,float,float]:
    return tuple(a[i]-b[i] for i in range(3))


def dot(a: tuple[float,float,float],b: tuple[float,float,float]) -> float:
    return sum(a[i]*b[i] for i in range(3))


def normalized(value: tuple[float,float,float]) -> tuple[float,float,float]:
    length=math.sqrt(dot(value,value));require(length > 1e-9,"cannot normalize a zero-length vector")
    return tuple(component/length for component in value)


def cross(a: tuple[float,float,float],b: tuple[float,float,float]) -> tuple[float,float,float]:
    return (a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0])


def view_basis(view: str) -> tuple[tuple[float,float,float],tuple[float,float,float],tuple[float,float,float]]:
    """Right/up/forward of Blender's to_track_quat('-Z','Y') camera aimed at the envelope centre."""
    forward=normalized(subtract(REFERENCE_CENTRE,VIEW_EYES[view]))
    world_up=(0.,0.,1.)
    lean=dot(world_up,forward)
    up=normalized(tuple(world_up[i]-forward[i]*lean for i in range(3)))
    return cross(forward,up),up,forward


def projected_half_extents(view: str) -> tuple[float,float]:
    """Half width/height of the reference envelope as this view projects it, in metres."""
    right,up,_=view_basis(view)
    return (sum(abs(right[i])*REFERENCE_HALF[i] for i in range(3)),
            sum(abs(up[i])*REFERENCE_HALF[i] for i in range(3)))


def ortho_scale(view: str) -> float:
    """Frame width in metres. Blender spans ortho_scale across the horizontal sensor fit."""
    half_width,half_height=projected_half_extents(view)
    aspect=RESOLUTION[0]/RESOLUTION[1]
    return 2.*max(half_width,half_height*aspect)*FRAME_MARGIN


def frame_fill(view: str) -> tuple[float,float]:
    """Fraction of the frame the envelope occupies. Both below 1.0 means nothing is cropped."""
    half_width,half_height=projected_half_extents(view)
    width=ortho_scale(view)
    return 2.*half_width/width,2.*half_height*RESOLUTION[0]/(width*RESOLUTION[1])


def camera_rig(view: str) -> dict:
    """The complete fixed rig for one view. A function of frozen constants only."""
    return {
        "eyeM": VIEW_EYES[view],
        "targetM": REFERENCE_CENTRE,
        "orthoScale": ortho_scale(view),
        "sensorFit": "HORIZONTAL",
        "resolution": RESOLUTION,
        "groundPlaneZM": QA_GROUND_Z,
        "lightAimM": LIGHT_AIM,
    }


def look_at(obj: bpy.types.Object,target: tuple[float,float,float]) -> None:
    obj.rotation_euler=(Vector(target)-obj.location).to_track_quat("-Z","Y").to_euler()


def bounds(objects: list[bpy.types.Object]) -> tuple[Vector,Vector]:
    minimum=Vector((math.inf,math.inf,math.inf));maximum=Vector((-math.inf,-math.inf,-math.inf))
    for obj in objects:
        if obj.type!="MESH":continue
        for corner in obj.bound_box:
            point=obj.matrix_world@Vector(corner)
            for axis in range(3):minimum[axis]=min(minimum[axis],point[axis]);maximum[axis]=max(maximum[axis],point[axis])
    require(all(math.isfinite(value) for value in (*minimum,*maximum)),"imported GLB has no bounded geometry")
    return minimum,maximum


def require_inside_envelope(minimum: Vector,maximum: Vector) -> None:
    require(all(minimum[axis] >= REFERENCE_MIN[axis]-ENVELOPE_TOLERANCE_M for axis in range(3)),f"model exceeds fixed QA minimum envelope: {tuple(minimum)}")
    require(all(maximum[axis] <= REFERENCE_MAX[axis]+ENVELOPE_TOLERANCE_M for axis in range(3)),f"model exceeds fixed QA maximum envelope: {tuple(maximum)}")


def configure_render(scene: bpy.types.Scene,output: Path) -> None:
    scene.render.engine="BLENDER_EEVEE_NEXT"
    scene.render.resolution_x=RESOLUTION[0];scene.render.resolution_y=RESOLUTION[1];scene.render.resolution_percentage=100
    scene.render.image_settings.file_format="PNG";scene.render.image_settings.color_mode="RGBA"
    scene.render.film_transparent=False;scene.render.filepath=str(output);scene.render.use_file_extension=True
    scene.view_settings.look="AgX - Medium High Contrast";scene.view_settings.exposure=1.0
    scene.world.use_nodes=True
    background=scene.world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value=(.075,.083,.074,1);background.inputs["Strength"].default_value=.95


def apply_fixed_rig(scene: bpy.types.Scene,view: str) -> bpy.types.Object:
    """Build ground plane, lights, and camera from frozen numbers. Reads no imported geometry."""
    bpy.ops.mesh.primitive_plane_add(size=QA_GROUND_SIZE_M,location=(REFERENCE_CENTRE[0],REFERENCE_CENTRE[1],QA_GROUND_Z))
    ground=bpy.context.object;ground.name="QA_Ground"
    ground_mat=bpy.data.materials.new("QA_Ground_Material");ground_mat.diffuse_color=(.115,.12,.095,1);ground_mat.roughness=.96
    ground.data.materials.append(ground_mat)

    for name,location,energy,color,diameter in LIGHT_RIG:
        data=bpy.data.lights.new(name,"AREA");data.energy=energy;data.color=color;data.shape="DISK";data.size=diameter
        obj=bpy.data.objects.new(name,data);scene.collection.objects.link(obj);obj.location=location;look_at(obj,LIGHT_AIM)

    camera_data=bpy.data.cameras.new("QA_Camera");camera=bpy.data.objects.new("QA_Camera",camera_data)
    scene.collection.objects.link(camera);scene.camera=camera
    camera_data.type="ORTHO"
    # AUTO would hand the ortho span to whichever resolution axis is larger; pin it
    # so the derived frame width cannot change meaning when the resolution changes.
    camera_data.sensor_fit="HORIZONTAL"
    camera_data.ortho_scale=ortho_scale(view)
    camera.location=VIEW_EYES[view]
    look_at(camera,REFERENCE_CENTRE)
    return camera


def main() -> None:
    args=parse_args()
    bpy.ops.object.select_all(action="SELECT");bpy.ops.object.delete(use_global=False)
    before=set(bpy.context.scene.objects)
    result=bpy.ops.import_scene.gltf(filepath=str(args.glb),import_pack_images=True)
    require(result=={"FINISHED"},f"glTF import failed: {result}")
    imported=[obj for obj in bpy.context.scene.objects if obj not in before]
    require_inside_envelope(*bounds(imported))
    scene=bpy.context.scene
    configure_render(scene,args.output)
    apply_fixed_rig(scene,args.view)
    bpy.ops.render.render(write_still=True)
    require(args.output.is_file(),"renderer did not create output")


if __name__=="__main__":
    try:main()
    except Exception as error:
        print(f"Crackhouse preview failed: {error}",file=sys.stderr)
        raise
