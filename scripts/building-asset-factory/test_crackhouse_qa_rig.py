#!/usr/bin/env python3
"""Blender-hosted contracts for the fixed Crackhouse QA camera rig.

These are evidence gates, not geometry gates. A contact sheet is only worth a
reviewer's time if every panel was taken with the same camera, the same lights,
and the same ground datum, and if the whole silhouette is inside every frame.
"""

from __future__ import annotations

import importlib.util
import math
import os
from pathlib import Path
import unittest

import bpy


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("render_crackhouse_preview", HERE / "render_crackhouse_preview.py")
preview = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(preview)


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras, bpy.data.images):
        for block in list(collection):
            collection.remove(block)


def envelope_corners() -> list[tuple[float, float, float]]:
    return [
        (x, y, z)
        for x in (preview.REFERENCE_MIN[0], preview.REFERENCE_MAX[0])
        for y in (preview.REFERENCE_MIN[1], preview.REFERENCE_MAX[1])
        for z in (preview.REFERENCE_MIN[2], preview.REFERENCE_MAX[2])
    ]


def projected_corner_extremes(view: str) -> tuple[float, float]:
    """Largest |horizontal| and |vertical| screen offset of any envelope corner, in metres."""
    right, up, _ = preview.view_basis(view)
    horizontal = vertical = 0.0
    for corner in envelope_corners():
        offset = preview.subtract(corner, preview.REFERENCE_CENTRE)
        horizontal = max(horizontal, abs(preview.dot(offset, right)))
        vertical = max(vertical, abs(preview.dot(offset, up)))
    return horizontal, vertical


def rig_snapshot() -> list[tuple]:
    # Read the authored transform channels, not matrix_world: in a background
    # session nothing forces a depsgraph evaluation, so matrix_world can still be
    # the identity and would compare equal no matter where the rig was aimed.
    bpy.context.view_layer.update()
    rows: list[tuple] = []
    for obj in sorted(bpy.context.scene.objects, key=lambda candidate: candidate.name):
        if obj.type not in ("LIGHT", "CAMERA") and obj.name != "QA_Ground":
            continue
        rows.append((
            obj.name, obj.type,
            tuple(round(value, 9) for value in obj.location),
            tuple(round(value, 9) for value in obj.rotation_euler),
        ))
    camera = bpy.context.scene.camera
    rows.append(("camera-data", camera.data.type, camera.data.sensor_fit, round(camera.data.ortho_scale, 9)))
    return rows


class FixedFrameContracts(unittest.TestCase):
    def test_every_view_frames_the_whole_envelope_with_margin(self) -> None:
        for view in preview.VIEW_EYES:
            with self.subTest(view=view):
                width = preview.ortho_scale(view)
                height = width * preview.RESOLUTION[1] / preview.RESOLUTION[0]
                horizontal, vertical = projected_corner_extremes(view)
                self.assertLess(horizontal, width * .5, f"{view} crops the envelope horizontally")
                self.assertLess(vertical, height * .5, f"{view} crops the envelope vertically")
                # The limiting axis carries exactly the declared margin: enough air to
                # read the silhouette, and no silent over-padding that shrinks the subject.
                fill = max(horizontal / (width * .5), vertical / (height * .5))
                self.assertAlmostEqual(fill, 1. / preview.FRAME_MARGIN, places=9)

    def test_frame_fill_matches_the_projected_envelope(self) -> None:
        for view in preview.VIEW_EYES:
            with self.subTest(view=view):
                horizontal, vertical = projected_corner_extremes(view)
                half_width, half_height = preview.projected_half_extents(view)
                self.assertAlmostEqual(horizontal, half_width, places=9)
                self.assertAlmostEqual(vertical, half_height, places=9)
                fill_x, fill_y = preview.frame_fill(view)
                self.assertLessEqual(max(fill_x, fill_y), 1. / preview.FRAME_MARGIN + 1e-9)

    def test_view_basis_is_orthonormal_and_level(self) -> None:
        for view in preview.VIEW_EYES:
            with self.subTest(view=view):
                right, up, forward = preview.view_basis(view)
                for axis in (right, up, forward):
                    self.assertAlmostEqual(math.sqrt(preview.dot(axis, axis)), 1.0, places=9)
                for a, b in ((right, up), (right, forward), (up, forward)):
                    self.assertAlmostEqual(preview.dot(a, b), 0.0, places=9)
                # A QA elevation must not roll: the horizontal axis stays level.
                self.assertAlmostEqual(right[2], 0.0, places=9)
                self.assertGreater(up[2], 0.0)


class ModelIndependenceContracts(unittest.TestCase):
    def build_rig_over(self, cube_size: float, offset: tuple[float, float, float]) -> list[tuple]:
        reset_scene()
        bpy.ops.mesh.primitive_cube_add(size=cube_size, location=offset)
        scene = bpy.context.scene
        preview.apply_fixed_rig(scene, "oblique")
        return rig_snapshot()

    def test_rig_is_identical_over_two_different_models(self) -> None:
        # The two stand-ins differ on every bound, floor included, so a rig that reads
        # any of the model's own extents cannot produce the same snapshot twice.
        small = self.build_rig_over(1.0, (0., 0., .9))
        large = self.build_rig_over(12.0, (2., -3., 6.1))
        self.assertEqual(small, large, "the QA rig moved with the model it was pointed at")

    def test_ground_datum_sits_under_the_frozen_envelope_floor(self) -> None:
        self.build_rig_over(1.0, (0., 0., .9))
        ground = bpy.context.scene.objects["QA_Ground"]
        self.assertAlmostEqual(ground.location.z, preview.QA_GROUND_Z, places=9)
        self.assertLess(preview.QA_GROUND_Z, preview.REFERENCE_MIN[2])
        self.assertGreater(preview.QA_GROUND_Z, preview.REFERENCE_MIN[2] - .05)

    def test_camera_is_a_pinned_orthographic_frame(self) -> None:
        self.build_rig_over(1.0, (0., 0., .5))
        camera = bpy.context.scene.camera
        self.assertEqual(camera.data.type, "ORTHO")
        self.assertEqual(camera.data.sensor_fit, "HORIZONTAL")
        # Blender stores ortho_scale as float32, so compare at single precision.
        self.assertAlmostEqual(camera.data.ortho_scale, preview.ortho_scale("oblique"), places=5)
        self.assertEqual(tuple(camera.location), preview.VIEW_EYES["oblique"])


@unittest.skipUnless(os.environ.get("TZ_CRACKHOUSE_QA_GLBS"), "set TZ_CRACKHOUSE_QA_GLBS to a comma-separated GLB list")
class RealModelFraming(unittest.TestCase):
    def test_every_shipped_lod_fits_inside_every_fixed_frame(self) -> None:
        paths = [Path(entry).expanduser().resolve() for entry in os.environ["TZ_CRACKHOUSE_QA_GLBS"].split(",") if entry.strip()]
        self.assertTrue(paths)
        for path in paths:
            reset_scene()
            before = set(bpy.context.scene.objects)
            self.assertEqual(bpy.ops.import_scene.gltf(filepath=str(path)), {"FINISHED"})
            imported = [obj for obj in bpy.context.scene.objects if obj not in before]
            minimum, maximum = preview.bounds(imported)
            preview.require_inside_envelope(minimum, maximum)
            for view in preview.VIEW_EYES:
                right, up, _ = preview.view_basis(view)
                width = preview.ortho_scale(view)
                height = width * preview.RESOLUTION[1] / preview.RESOLUTION[0]
                for corner_x in (minimum[0], maximum[0]):
                    for corner_y in (minimum[1], maximum[1]):
                        for corner_z in (minimum[2], maximum[2]):
                            offset = preview.subtract((corner_x, corner_y, corner_z), preview.REFERENCE_CENTRE)
                            with self.subTest(model=path.name, view=view):
                                self.assertLess(abs(preview.dot(offset, right)), width * .5)
                                self.assertLess(abs(preview.dot(offset, up)), height * .5)


if __name__ == "__main__":
    unittest.main(argv=[__file__])
