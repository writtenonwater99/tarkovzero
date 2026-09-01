#!/usr/bin/env python3
"""Blender-hosted geometry contracts for the Crackhouse factory."""

from __future__ import annotations

import importlib.util
import math
from pathlib import Path
import unittest

import bpy


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("crackhouse_factory", HERE / "crackhouse_factory.py")
factory = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(factory)


def dummy_materials() -> dict[str, bpy.types.Material]:
    return {kind: bpy.data.materials.new(f"Test_{kind}") for kind in factory.MATERIAL_SPECS}


class GeometryContracts(unittest.TestCase):
    def setUp(self) -> None:
        factory.reset_scene()

    def test_public_transform_derivation_is_stable(self) -> None:
        canonical = factory.derive_transform(factory.SOURCE_FOOTPRINT_EFT_XZ)
        self.assertAlmostEqual(canonical["pivotEftM"][0], 83.95, places=8)
        self.assertAlmostEqual(canonical["pivotEftM"][1], 1.983, places=8)
        self.assertAlmostEqual(canonical["pivotEftM"][2], -156.175, places=8)
        self.assertAlmostEqual(canonical["yawDeg"], -11.379260726349447, places=8)
        self.assertAlmostEqual(canonical["lengthM"], 24.3282263496601, places=8)
        self.assertAlmostEqual(canonical["widthM"], 16.228829278137322, places=8)
        self.assertAlmostEqual(factory.UPPER_LOCAL_Z_M, 3.5102, places=8)

    def test_local_quad_round_trips_to_public_footprint(self) -> None:
        canonical = factory.CANONICAL
        pivot_x, _, pivot_z = canonical["pivotEftM"]
        long_axis = canonical["longAxisEftXZ"]
        width_axis = canonical["widthAxisEftXZ"]
        reconstructed = []
        for local_x, local_y in canonical["localFootprintQuadM"]:
            reconstructed.append((
                pivot_x + local_x * long_axis[0] + local_y * width_axis[0],
                pivot_z + local_x * long_axis[1] + local_y * width_axis[1],
            ))
        for actual, expected in zip(reconstructed, factory.SOURCE_FOOTPRINT_EFT_XZ):
            self.assertAlmostEqual(actual[0], expected[0], places=8)
            self.assertAlmostEqual(actual[1], expected[1], places=8)

    def test_lod_opening_catalog_is_deterministic_and_reduces(self) -> None:
        counts = [sum(len(items) for items in factory.opening_layout(lod).values()) for lod in factory.LOD_LEVELS]
        self.assertEqual(counts, sorted(counts, reverse=True))
        self.assertGreater(counts[0], counts[1])
        self.assertGreater(counts[1], counts[2])
        for lod in factory.LOD_LEVELS:
            doors = [item for items in factory.opening_layout(lod).values() for item in items if item["kind"] == "door"]
            self.assertEqual(len(doors), 4)

    def test_wall_cells_do_not_fill_declared_opening_rectangles(self) -> None:
        collection = bpy.context.scene.collection
        parent = factory.create_empty("Root", collection)
        plaster = bpy.data.materials.new("Plaster")
        items = factory.opening_layout(0)["south"]
        factory.add_wall_cells("south", items, {"plaster": plaster}, collection, parent, 0)
        cells = [obj for obj in bpy.context.scene.objects if obj.name.startswith("WallCell_south_")]
        self.assertGreater(len(cells), 0)
        for item in items:
            opening_x = (item["centre"] - item["width"]*.5, item["centre"] + item["width"]*.5)
            opening_z = (item["bottom"], item["bottom"] + item["height"])
            for cell in cells:
                xs = [cell.location.x + vertex.co.x for vertex in cell.data.vertices]
                zs = [cell.location.z + vertex.co.z for vertex in cell.data.vertices]
                overlap_x = min(max(xs), opening_x[1]) - max(min(xs), opening_x[0])
                overlap_z = min(max(zs), opening_z[1]) - max(min(zs), opening_z[0])
                self.assertFalse(overlap_x > 1e-6 and overlap_z > 1e-6, f"{cell.name} fills {item['id']}")

    def test_full_lod0_has_real_void_empties_and_honest_root_flags(self) -> None:
        factory.reset_scene()
        authored = factory.build_shell(0, dummy_materials())
        roots = [obj for obj in bpy.context.scene.objects if obj.name == "TZ_CrackhouseShell_LOD0_ROOT"]
        self.assertEqual(len(roots), 1)
        root = roots[0]
        self.assertFalse(root["tz_tactical_certified"])
        self.assertFalse(root["tz_collision_certified"])
        voids = [obj for obj in bpy.context.scene.objects if obj.name.startswith("OpeningVoid_")]
        self.assertEqual(len(voids), authored["openingVoids"])
        self.assertTrue(all(obj["tz_real_void"] for obj in voids))
        before = factory.blender_bounds()
        factory.batch_meshes_for_export()
        after = factory.blender_bounds()
        mesh_objects = [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and obj.visible_get()]
        self.assertTrue(mesh_objects)
        self.assertTrue(all(len(obj.data.uv_layers) == 1 for obj in mesh_objects))
        self.assertTrue(all(obj.data.uv_layers[0].name == "UVMap" for obj in mesh_objects))
        for key in ("min", "max"):
            for axis in range(3):
                self.assertAlmostEqual(before[key][axis], after[key][axis], places=4)
        self.assertLessEqual(after["max"][2], factory.SOURCE_HEIGHT_M + .005)
        self.assertAlmostEqual(after["min"][2], -.18, places=4)


if __name__ == "__main__":
    unittest.main(argv=[__file__])
