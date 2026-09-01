#!/usr/bin/env python3
"""Blender-hosted geometry contracts for the Crackhouse factory."""

from __future__ import annotations

import importlib.util
import math
from pathlib import Path
import re
import unittest

import bpy
from mathutils import Vector


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("crackhouse_factory", HERE / "crackhouse_factory.py")
factory = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(factory)


def dummy_materials() -> dict[str, bpy.types.Material]:
    return {kind: bpy.data.materials.new(f"Test_{kind}") for kind in factory.MATERIAL_SPECS}


def exported_meshes() -> list[bpy.types.Object]:
    bpy.context.view_layer.update()
    return [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and obj.visible_get()]


def world_extent(obj: bpy.types.Object, axis: int) -> tuple[float, float]:
    values = [(obj.matrix_world @ Vector(corner))[axis] for corner in obj.bound_box]
    return min(values), max(values)


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

    def test_no_exported_mesh_carries_a_blender_auto_name(self) -> None:
        """A shipped datablock named Cylinder.003 is Blender's global collision counter
        leaking into the asset: an implicit dependency on creation order, and a name no
        consumer can key on."""
        factory.reset_scene()
        factory.build_shell(0, dummy_materials())
        factory.batch_meshes_for_export()
        meshes = exported_meshes()
        self.assertTrue(meshes)
        for obj in meshes:
            name = obj.data.name
            self.assertIsNone(re.search(r"\.\d{3}", name), f"{obj.name} ships auto-suffixed datablock {name!r}")
            # Every shipped datablock is named for the object that ships it, so a batch
            # cannot inherit the name of whichever fragment happened to sort first.
            self.assertEqual(name, f"{obj.name}_Mesh", f"{obj.name} ships mesh datablock {name!r}")

    def test_batch_names_describe_the_geometry_they_contain(self) -> None:
        """Batch names are the only floor slice a consumer gets. A cell tagged from its
        top edge alone puts full-height geometry in floor-1, so the name must be earned
        by measured vertical occupancy, not by the authoring tag."""
        factory.reset_scene()
        factory.build_shell(0, dummy_materials())
        factory.batch_meshes_for_export()
        upper, epsilon = factory.UPPER_LOCAL_Z_M, 1e-4
        seen = set()
        for obj in exported_meshes():
            if not obj.name.startswith("Batch_"):
                continue
            band = obj.name.split("_")[1]
            seen.add(band)
            low, high = world_extent(obj, 2)
            if band == "ground":
                self.assertLessEqual(high, upper + epsilon, f"{obj.name} reaches {high:.3f} m, above the upper floor")
            elif band == "floor-1":
                self.assertGreaterEqual(low, upper - epsilon, f"{obj.name} starts at {low:.3f} m, below the upper floor")
            elif band == "cross-floor":
                self.assertLess(low, upper - epsilon, f"{obj.name} does not reach below the upper floor")
                self.assertGreater(high, upper + epsilon, f"{obj.name} does not reach above the upper floor")
            else:
                self.assertEqual(band, "roof", f"{obj.name} uses an undeclared band")
        self.assertIn("cross-floor", seen, "LOD0 has cross-floor pieces; the batch names must admit it")

    def test_upper_slabs_stay_inboard_of_the_exterior_wall_face(self) -> None:
        """Slab edges flush with the plaster plane z-fight, and the strip they produce
        reads as a construction defect in every elevation render."""
        factory.reset_scene()
        factory.build_shell(0, dummy_materials())
        length, width = factory.CANONICAL["lengthM"], factory.CANONICAL["widthM"]
        clearance = factory.WALL_THICKNESS_M - .05
        slabs = [obj for obj in bpy.context.scene.objects if obj.name.startswith("UpperSlab_")]
        self.assertTrue(slabs)
        bpy.context.view_layer.update()
        for slab in slabs:
            for axis, span in ((0, length), (1, width)):
                low, high = world_extent(slab, axis)
                self.assertLessEqual(high, span * .5 - clearance, f"{slab.name} reaches the exterior face on axis {axis}")
                self.assertGreaterEqual(low, -(span * .5 - clearance), f"{slab.name} reaches the exterior face on axis {axis}")

    def test_window_furniture_sits_inside_the_wall_reveal(self) -> None:
        """A 0.28 m wall with frames bolted to its outside face has no reveal shadow and
        reads as pasted-on decals."""
        factory.reset_scene()
        factory.build_shell(0, dummy_materials())
        length, width = factory.CANONICAL["lengthM"], factory.CANONICAL["widthM"]
        reveal = factory.FRAME_REVEAL_INSET_M
        self.assertGreater(reveal, 0.)
        bpy.context.view_layer.update()
        checked = 0
        for obj in bpy.context.scene.objects:
            if not obj.name.startswith(("Frame_", "Mullion_", "BrokenGlass_")):
                continue
            facade = obj.name.split("_")[1][0]
            axis = 1 if facade in ("S", "N") else 0
            limit = (width if axis == 1 else length) * .5
            low, high = world_extent(obj, axis)
            self.assertLessEqual(max(abs(low), abs(high)), limit - reveal + 1e-6, f"{obj.name} stands proud of the facade plane")
            checked += 1
        self.assertGreater(checked, 100)


if __name__ == "__main__":
    unittest.main(argv=[__file__])
