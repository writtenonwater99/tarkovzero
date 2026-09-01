#!/usr/bin/env python3
"""Blender-hosted geometry contract tests for fortress_factory."""
from __future__ import annotations

import importlib.util
import math
from pathlib import Path
import unittest

import bpy


SPEC = importlib.util.spec_from_file_location("fortress_factory", Path(__file__).with_name("fortress_factory.py"))
factory = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(factory)


class GeometryContracts(unittest.TestCase):
    def setUp(self) -> None:
        factory.reset_scene()
        self.collection = bpy.context.scene.collection
        self.parent = factory.create_empty("Root", self.collection)
        self.material = bpy.data.materials.new("Concrete")

    def test_ramp_wedge_has_positive_signed_volume(self) -> None:
        obj = factory.create_ramp_wedge(
            "Ramp", (3.6, 4.8, 0.85), (0, 0, 0), self.material,
            self.collection, self.parent, asset_id="fortress-shell", lod=0,
            floor="ground", rise_positive_x=True,
        )
        obj.data.calc_loop_triangles()
        volume = 0.0
        for triangle in obj.data.loop_triangles:
            a, b, c = (obj.data.vertices[index].co for index in triangle.vertices)
            volume += a.dot(b.cross(c)) / 6.0
        self.assertGreater(volume, 0.0)
        self.assertAlmostEqual(volume, 3.6 * 4.8 * 0.85 / 2.0, places=5)

    def test_box_uv_edges_use_declared_metres_per_tile(self) -> None:
        tile = float(factory.MATERIAL_SPECS["concrete"]["tile_m"])
        obj = factory.create_box(
            "Box", (2.5, 5.0, 7.5), (0, 0, 0), self.material,
            self.collection, self.parent, asset_id="fortress-shell", lod=2,
            floor="ground", family="concrete",
        )
        uv = obj.data.uv_layers["UVMap"]
        for polygon in obj.data.polygons:
            loops = list(polygon.loop_indices)
            for index, loop_index in enumerate(loops):
                next_loop = loops[(index + 1) % len(loops)]
                a = obj.data.vertices[obj.data.loops[loop_index].vertex_index].co
                b = obj.data.vertices[obj.data.loops[next_loop].vertex_index].co
                uv_length = (uv.data[next_loop].uv - uv.data[loop_index].uv).length
                self.assertAlmostEqual(uv_length, (b - a).length / tile, places=5)

    def test_exact_footprint_prism_bounds(self) -> None:
        obj = factory.create_prism(
            "GroundSlab", factory.FOOTPRINT_LOCAL_QUAD_M, .30, -.15,
            self.material, self.collection, self.parent,
            asset_id="fortress-shell", lod=2, floor="ground", family="concrete",
        )
        xs = [vertex.co.x for vertex in obj.data.vertices]
        ys = [vertex.co.y for vertex in obj.data.vertices]
        zs = [vertex.co.z for vertex in obj.data.vertices]
        self.assertAlmostEqual(min(xs), min(p[0] for p in factory.FOOTPRINT_LOCAL_QUAD_M), places=5)
        self.assertAlmostEqual(max(xs), max(p[0] for p in factory.FOOTPRINT_LOCAL_QUAD_M), places=5)
        self.assertAlmostEqual(min(ys), min(p[1] for p in factory.FOOTPRINT_LOCAL_QUAD_M), places=5)
        self.assertAlmostEqual(max(ys), max(p[1] for p in factory.FOOTPRINT_LOCAL_QUAD_M), places=5)
        self.assertAlmostEqual(max(zs), 0.0)
        self.assertAlmostEqual(min(zs), -.30)

    def test_roof_weathering_is_deterministic_and_not_a_checker(self) -> None:
        cells = [
            (column, row)
            for column, rows in enumerate(factory.ROOF_PANEL_ROWS_BY_COLUMN)
            for row in rows
        ]
        first = {(column, row): factory.roof_material_family(column, row) for column, row in cells}
        second = {(column, row): factory.roof_material_family(column, row) for column, row in reversed(cells)}
        self.assertEqual(first, second)
        self.assertEqual(set(first.values()), set(factory.ROOF_MATERIAL_FAMILIES))
        adjacent_same = sum(
            first.get((column + dx, row + dy)) == family
            for (column, row), family in first.items()
            for dx, dy in ((1, 0), (0, 1))
            if (column + dx, row + dy) in first
        )
        self.assertGreater(adjacent_same, 0, "a checker has no same-family edge neighbors")
        parity_matches = sum(
            (family == "roof_galvanized") == ((column + row) % 2 == 0)
            for (column, row), family in first.items()
        )
        self.assertLess(parity_matches, len(first) * 0.75)

    def test_weathered_roof_families_keep_a_shared_midtone(self) -> None:
        bases = [factory.MATERIAL_SPECS[name]["base"] for name in factory.ROOF_MATERIAL_FAMILIES]
        for channel in range(3):
            values = [base[channel] for base in bases]
            self.assertLessEqual(max(values) - min(values), 0.050001)
            self.assertGreaterEqual(min(values), 0.50)
        self.assertGreaterEqual(min(factory.MATERIAL_SPECS["steel"]["base"]), 0.40)


if __name__ == "__main__":
    unittest.main(argv=[__file__])
