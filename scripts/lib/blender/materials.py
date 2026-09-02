"""Image packing and the height-field → tangent-normal kernel.

``create_image`` was byte-identical in all three factories except for the
generator name it stamped, which is now a parameter. The normal-map derivation
inside ``create_material`` was also character-identical in all three, differing
only in where the strength scalar came from; it is :func:`height_field_normals`
here.

The rest of ``create_material`` — which material families exist, their sampler,
the node graph's layout and labels, whether base colour carries an alpha
channel — is a per-factory contract and stays in the factory. Merging those
would produce a union of nine crackhouse families, seven fortress families and
the industrial set behind a flag, which is the fake abstraction this
consolidation exists to avoid.

Requires Blender.
"""

from __future__ import annotations

from typing import Sequence

import bpy
from mathutils import Vector


def create_image(
    name: str,
    size: int,
    pixels: Sequence[float],
    colorspace: str,
    *,
    generator: str,
) -> "bpy.types.Image":
    """Pack a square RGBA float buffer as an embedded PNG datablock.

    ``generator`` is stamped as ``tz_generator``; each factory passes its own
    ``GENERATOR_NAME``, which is the only thing that differed between the three
    copies this replaces.
    """
    image = bpy.data.images.new(name, width=size, height=size, alpha=True, float_buffer=False)
    image.file_format = "PNG"
    image.colorspace_settings.name = colorspace
    image.pixels.foreach_set(pixels)
    image.pack()
    image["tz_original_procedural"] = True
    image["tz_generator"] = generator
    return image


def height_field_normals(heights: Sequence[float], size: int, strength: float) -> list[float]:
    """Central-difference tangent-space normals from a wrapping height field.

    Returns a flat RGBA float list, ``size * size * 4`` long, ready for
    :func:`create_image` with the ``Non-Color`` colourspace. The neighbour
    lookups wrap, which is what keeps the tile seamless.

    Identical in all three factories; only ``strength`` differed, and it is now
    the caller's to supply (a per-family table in fortress and crackhouse, a
    per-LOD scalar in industrial).
    """
    pixels: list[float] = []
    for y in range(size):
        for x in range(size):
            left = heights[y * size + ((x - 1) % size)]
            right = heights[y * size + ((x + 1) % size)]
            down = heights[((y - 1) % size) * size + x]
            up = heights[((y + 1) % size) * size + x]
            normal = Vector((-(right - left) * strength, -(up - down) * strength, 1.0)).normalized()
            pixels.extend((normal.x * 0.5 + 0.5, normal.y * 0.5 + 0.5, normal.z * 0.5 + 0.5, 1.0))
    return pixels


def gltf_occlusion_group() -> "bpy.types.NodeTree":
    """Fetch or create the ``glTF Material Output`` group node tree.

    Blender's glTF exporter recognises this named group and writes whatever is
    linked to its ``Occlusion`` socket as the material's ``occlusionTexture``,
    reusing the same embedded ORM image. The name is load-bearing: rename it and
    every asset silently loses its occlusion channel.
    """
    tree = bpy.data.node_groups.get("glTF Material Output")
    if tree is None:
        tree = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
        tree.interface.new_socket(name="Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
    return tree
