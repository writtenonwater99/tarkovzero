"""Pure-stdlib glTF/GLB reading shared by the factories and their validators.

Nothing in this subpackage may ``import bpy``: the validators must stay runnable
under plain ``python3`` in CI, with no Blender on the machine.
"""
