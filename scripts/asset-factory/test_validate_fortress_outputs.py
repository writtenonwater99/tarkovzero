#!/usr/bin/env python3
"""Independent validator math and real-output mutation tests."""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("validate_fortress_outputs", Path(__file__).with_name("validate_fortress_outputs.py"))
validator = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(validator)


class ValidatorContracts(unittest.TestCase):
    def test_accessor_bounds_are_transformed_through_node_hierarchy(self) -> None:
        document = {
            "scene": 0,
            "scenes": [{"nodes": [0]}],
            "nodes": [{"translation": [10, 2, -3], "children": [1]}, {"translation": [1, 0, 0], "mesh": 0}],
            "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1}]}],
            "accessors": [{"count": 8, "min": [-1, -2, -3], "max": [1, 2, 3]}, {"count": 36}],
        }
        stats = validator.geometry_stats(document)
        self.assertEqual(stats["triangles"], 12)
        self.assertEqual(stats["boundsM"]["min"], [10.0, 0.0, -6.0])
        self.assertEqual(stats["boundsM"]["max"], [12.0, 4.0, 0.0])

    @unittest.skipUnless(os.environ.get("TZ_FORTRESS_QA_RECEIPTS"), "set TZ_FORTRESS_QA_RECEIPTS to three comma-separated receipts")
    def test_receipt_mutations_are_rejected(self) -> None:
        source_receipts = [Path(value).resolve() for value in os.environ["TZ_FORTRESS_QA_RECEIPTS"].split(",")]
        asset_id = json.loads(source_receipts[0].read_text())["asset"]["id"]
        with tempfile.TemporaryDirectory(prefix="tz-fortress-validator-mutations-") as directory:
            target_dir = Path(directory)
            targets = []
            for source in source_receipts:
                receipt = json.loads(source.read_text())
                shutil.copy2(source.parent / receipt["asset"]["outputFile"], target_dir / receipt["asset"]["outputFile"])
                target = target_dir / source.name
                shutil.copy2(source, target)
                targets.append(target)
            args = argparse.Namespace(asset=asset_id, receipts=targets)
            validator.validate_set(args)
            baseline = json.loads(targets[0].read_text())
            mutations = (
                lambda doc: doc["generated"].__setitem__("triangles", doc["generated"]["triangles"] + 1),
                lambda doc: doc["generated"].__setitem__("materialCount", doc["generated"]["materialCount"] + 1),
                lambda doc: doc["generated"].__setitem__("embeddedImageCount", doc["generated"]["embeddedImageCount"] + 1),
                lambda doc: doc["asset"]["boundsM"]["min"].__setitem__(0, doc["asset"]["boundsM"]["min"][0] + 1),
            )
            for mutation in mutations:
                document = json.loads(json.dumps(baseline))
                mutation(document)
                targets[0].write_text(json.dumps(document), encoding="utf-8")
                with self.assertRaises(ValueError):
                    validator.validate_set(args)
            targets[0].write_text(json.dumps(baseline), encoding="utf-8")


if __name__ == "__main__":
    unittest.main()
