"""Box geometry, metric UV projection, and the frozen glTF export settings.

Two more divergences live here, neither of them recorded in
``docs/plans/BUILDING-MASSING.md`` §4.1 before this pass:

**Box face winding.** ``create_box`` shipped two different face tables. The
fortress and crackhouse copies agree; the industrial copy walks the side faces
as a ring. Both wind outward and both are correct geometry, but they emit
different vertex and index order, so the exported bytes differ. Named variants,
no default.

**UV layer policy.** The projection loop is character-identical in all three,
but fortress and crackhouse always create a fresh ``UVMap`` while industrial
reuses an existing one — which it must, because its ``create_box`` re-projects
after applying a bevel modifier. Flags, not a winner.

Requires Blender.
"""

from __future__ import annotations

from pathlib import Path
from typing import Sequence

import bpy

# --- box face winding variants ----------------------------------------------

#: ``fortress_factory.create_box`` and ``crackhouse_factory.create_box``.
BOX_FACES_FORTRESS_CRACKHOUSE = (
    (0, 3, 2, 1),
    (4, 5, 6, 7),
    (0, 1, 5, 4),
    (3, 7, 6, 2),
    (0, 4, 7, 3),
    (1, 2, 6, 5),
)

#: ``industrial_prop_factory.create_box``. Same box, side faces walked as a
#: ring, so loop order — and therefore the exported index buffer — differs.
BOX_FACES_INDUSTRIAL = (
    (0, 3, 2, 1),
    (4, 5, 6, 7),
    (0, 1, 5, 4),
    (1, 2, 6, 5),
    (2, 3, 7, 6),
    (3, 0, 4, 7),
)

BOX_FACE_VARIANTS = {
    "fortress-crackhouse-v1": BOX_FACES_FORTRESS_CRACKHOUSE,
    "industrial-v1": BOX_FACES_INDUSTRIAL,
}

#: Corner signs, in the order both variants index them.
BOX_CORNER_SIGNS = (
    (-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1),
    (-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1),
)


def box_vertices(
    size: Sequence[float], center: Sequence[float] = (0.0, 0.0, 0.0)
) -> list[tuple[float, float, float]]:
    """The 8 corners of an axis-aligned box, in :data:`BOX_CORNER_SIGNS` order."""
    sx, sy, sz = size
    cx, cy, cz = center
    return [
        (cx + dx * sx * 0.5, cy + dy * sy * 0.5, cz + dz * sz * 0.5)
        for dx, dy, dz in BOX_CORNER_SIGNS
    ]


def box_faces(variant: str) -> tuple[tuple[int, int, int, int], ...]:
    """The face table for a named winding variant. No default: choose openly."""
    try:
        return BOX_FACE_VARIANTS[variant]
    except KeyError:
        raise ValueError(
            f"unknown box face variant: {variant!r}; "
            f"expected one of {tuple(BOX_FACE_VARIANTS)}"
        ) from None


def build_box_mesh(
    name: str,
    size: Sequence[float],
    material: "bpy.types.Material",
    *,
    face_variant: str,
    center: Sequence[float] = (0.0, 0.0, 0.0),
) -> "bpy.types.Mesh":
    """A named box mesh with one material slot. Caller assigns UVs."""
    mesh = bpy.data.meshes.new(f"{name}_Mesh")
    mesh.from_pydata(box_vertices(size, center), [], list(box_faces(face_variant)))
    mesh.materials.append(material)
    mesh.update()
    return mesh


# --- metric planar UV --------------------------------------------------------

def apply_scale_transform(obj: "bpy.types.Object") -> None:
    """Bake an object's scale into its mesh, leaving location and rotation.

    Shipped as ``apply_identity`` in the fortress factory and ``apply_scale`` in
    the crackhouse one — identical bodies under two names, which is why the
    name-matched duplication scan missed it.
    """
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.select_set(False)


def assign_metric_planar_uv(
    mesh: "bpy.types.Mesh",
    tile_m: float,
    *,
    reuse_existing: bool = False,
    update_first: bool = False,
) -> None:
    """Project each polygon on its dominant plane at one consistent metre scale.

    ``reuse_existing`` takes an existing ``UVMap`` instead of adding another
    layer; the industrial factory needs it because it re-projects after applying
    a bevel modifier, and a second call that added a layer would leave a stray
    UV set in the export. ``update_first`` recomputes polygon normals before
    projecting, which the industrial copy did and the other two did not.

    The projection loop itself is identical to all three copies it replaces.
    """
    if tile_m <= 0.0:
        raise ValueError("UV tile size must be positive")
    if update_first:
        mesh.update()
    if reuse_existing:
        uv_layer = mesh.uv_layers.get("UVMap") or mesh.uv_layers.new(name="UVMap")
    else:
        uv_layer = mesh.uv_layers.new(name="UVMap")
    for polygon in mesh.polygons:
        normal = tuple(abs(value) for value in polygon.normal)
        dominant = max(range(3), key=lambda axis: normal[axis])
        axes = ((1, 2), (0, 2), (0, 1))[dominant]
        for loop_index in polygon.loop_indices:
            vertex = mesh.vertices[mesh.loops[loop_index].vertex_index].co
            uv_layer.data[loop_index].uv = (vertex[axes[0]] / tile_m, vertex[axes[1]] / tile_m)


# --- the frozen export settings ---------------------------------------------

#: Every keyword ``bpy.ops.export_scene.gltf`` is called with. All three
#: factories passed this exact block; it is the contract that keeps twelve
#: buildings comparable, so it lives in one place. A change here changes every
#: asset's bytes and is a re-admission event, not an edit.
GLTF_EXPORT_SETTINGS = {
    "check_existing": False,
    "export_format": "GLB",
    "export_copyright": "Original TarkovZero procedural authoring; no game payloads",
    "export_yup": True,
    "export_apply": True,
    "export_texcoords": True,
    "export_normals": True,
    "export_tangents": True,
    "export_materials": "EXPORT",
    "export_image_format": "AUTO",
    "export_cameras": False,
    "export_lights": False,
    "export_extras": True,
    "export_animations": False,
    "export_skins": False,
    "export_morph": False,
    "export_draco_mesh_compression_enable": False,
    "export_unused_images": False,
    "export_unused_textures": False,
    "use_selection": False,
    "use_visible": True,
    "will_save_settings": False,
}


def export_gltf_binary(destination: Path) -> set:
    """Run the glTF exporter into ``destination`` with the frozen settings.

    Publication policy stays with the caller and is deliberately NOT shared:
    the fortress factory replaces its output, the crackhouse and industrial
    factories refuse to clobber one. Those are different promises about the
    same file and merging them would quietly relax one of them.
    """
    return bpy.ops.export_scene.gltf(filepath=str(destination), **GLTF_EXPORT_SETTINGS)


def scene_metric_defaults(scene: "bpy.types.Scene") -> None:
    """The metre/EEVEE scene setup shared by all three ``reset_scene`` copies.

    World colour and the ``tz_*`` scene stamps differ per factory and stay with
    the caller.
    """
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.length_unit = "METERS"
    scene.unit_settings.scale_length = 1.0
    scene.render.engine = "BLENDER_EEVEE_NEXT"
