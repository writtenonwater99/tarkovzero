"""Shared Python library for the TarkovZero offline asset factories.

Two subpackages, split by what they are allowed to import:

- ``lib.gltf``    pure standard library. Usable by validators, tests, and CI.
                  Must never ``import bpy``.
- ``lib.blender`` Blender-hosted authoring helpers. Imports ``bpy``/``mathutils``
                  and only runs inside Blender.

Factories and validators reach this package through ``lib.bootstrap``; see that
module for why a plain relative import is not available to a Blender
``--python`` script.
"""
