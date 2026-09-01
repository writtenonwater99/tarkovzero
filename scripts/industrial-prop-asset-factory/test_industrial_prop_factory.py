#!/usr/bin/env python3
"""Blender-hosted geometry and authoring contract tests."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location("industrial_prop_factory", Path(__file__).with_name("industrial_prop_factory.py"))
factory = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(factory)


class FactoryContracts(unittest.TestCase):
    def test_each_family_has_centered_base_pivot_and_strict_lod_reduction(self) -> None:
        cases = (("shipping-container", "red"), ("diesel-shunter", "default"), ("tanker-wagon", "default"))
        for family, variant in cases:
            triangle_costs = []
            for lod in (0, 1, 2):
                root, stats = factory.build_asset(family, variant, lod, 106)
                triangle_costs.append(stats["triangles"])
                bounds = stats["boundsBlenderM"]
                self.assertAlmostEqual(bounds["min"][2], 0.0, places=4)
                self.assertLessEqual(abs(bounds["centerM"][0]), 0.12)
                self.assertLessEqual(abs(bounds["centerM"][1]), 0.12)
                self.assertEqual(root["tz_collision"], "none")
                self.assertEqual(root["tz_pivot_contract"], "base-center at (0,0,0)")
            self.assertGreater(triangle_costs[0], triangle_costs[1], family)
            self.assertGreater(triangle_costs[1], triangle_costs[2], family)

    def test_lod0_component_inventories_keep_recognition_features(self) -> None:
        required = {
            "shipping-container": {"corrugated-side", "cargo-door", "locking-bar", "corner-casting"},
            "diesel-shunter": {"cab-window", "engine-hood", "bogie-frame", "wheel", "coupler", "handrail", "vent"},
            "tanker-wagon": {"vessel", "tank-band", "bogie-frame", "wheel", "coupler", "hatch", "ladder"},
        }
        for family, variant in (("shipping-container", "red"), ("diesel-shunter", "default"), ("tanker-wagon", "default")):
            root, _ = factory.build_asset(family, variant, 0, 106)
            inventory = set(root["tz_component_inventory"].split(","))
            self.assertTrue(required[family] <= inventory, (family, sorted(required[family] - inventory)))

    def test_container_color_variants_are_distinct_but_share_material_contract(self) -> None:
        colors = []
        for variant in ("red", "green", "blue"):
            factory.reset_scene()
            materials = factory.material_set("shipping-container", variant, 2, 106)
            material = materials[f"paint-{variant}"]
            colors.append(tuple(round(channel, 4) for channel in material.diffuse_color[:3]))
            self.assertTrue(material["tz_original_procedural"])
            self.assertEqual(material["tz_orm_channels"], "R=occlusion,G=roughness,B=metallic")
        self.assertEqual(len(set(colors)), 3)

    def test_factory_refuses_existing_outputs_before_scene_work(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tz-industrial-no-clobber-") as directory:
            output = Path(directory) / "asset.glb"
            receipt = Path(directory) / "asset.json"
            output.write_bytes(b"occupied")
            with self.assertRaises(ValueError):
                factory.parse_args(["--asset", "diesel-shunter", "--variant", "default", "--lod", "0", "--output", str(output), "--receipt", str(receipt)])


if __name__ == "__main__":
    unittest.main(argv=[__file__])
