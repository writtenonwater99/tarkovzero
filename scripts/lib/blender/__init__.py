"""Blender-hosted authoring helpers shared by the asset factories.

Modules here import ``bpy``/``mathutils`` and only run inside Blender.
``lib.blender.noise`` is the exception: it is pure arithmetic and importable
under plain ``python3`` so its variants can be unit-tested without Blender.
"""
