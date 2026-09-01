#!/usr/bin/env python3
"""Independent validator math and optional real-proof mutation tests."""

from __future__ import annotations

import importlib.util
import copy
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location("validate_industrial_props", Path(__file__).with_name("validate_industrial_props.py"))
validator = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(validator)


RECEIPTS_ENV = "TZ_INDUSTRIAL_QA_RECEIPTS"

if not os.environ.get(RECEIPTS_ENV):
    # This print runs unconditionally at import time -- regardless of unittest
    # verbosity, test filters (-k), or how this module is invoked -- so a plain
    # `npm test` / `python3 test_validate_industrial_props.py` cannot pass this
    # suite without someone seeing that real-output QA did not run.
    print(
        "\n"
        "==================== INDUSTRIAL PROP QA: REAL-OUTPUT CHECKS SKIPPED ====================\n"
        f"{RECEIPTS_ENV} is not set, so test_real_receipt_mutations_are_rejected did NOT run.\n"
        "NOT VERIFIED against real Blender-built GLBs this run:\n"
        "  - LOD monotonicity (triangle/byte cost strictly falling LOD0 > LOD1 > LOD2)\n"
        "  - PBR material completeness and shared-ORM-texture policy on real outputs\n"
        "  - forbidden-source-string scan (UnityFS/CAB-/StreamingAssets/EscapeFromTarkov/...) on real GLBs\n"
        "  - receipt <-> GLB byte size / sha256 / triangle / vertex / bounds cross-check\n"
        "  - factory script hash pin (industrial_prop_factory.py) against the receipts\n"
        "Only validator math against synthetic fixtures ran; that is not a substitute.\n"
        "To run the real checks: build a proof (README 'Build an offline proof'), then either\n"
        f"  export {RECEIPTS_ENV}=<15 comma-separated receipt paths>, or\n"
        "  npm run test:industrial-props:receipts -- <proof-root>\n"
        "==========================================================================================\n",
        file=sys.stderr,
    )


class ValidatorContracts(unittest.TestCase):
    @staticmethod
    def valid_policy_document(family: str = "shipping-container", variant: str = "red", lod: int = 0) -> dict:
        inventory = ",".join(sorted(validator.REQUIRED_COMPONENTS[family]))
        material = {
            "pbrMetallicRoughness": {
                "baseColorTexture": {"index": 0},
                "metallicRoughnessTexture": {"index": 1},
            },
            "normalTexture": {"index": 2},
            "occlusionTexture": {"index": 1},
        }
        return {
            "asset": {"copyright": "Original TarkovZero test authoring"},
            "scene": 0,
            "scenes": [{"nodes": [0]}],
            "nodes": [{
                "name": "TZ_Test_Root",
                "mesh": 0,
                "extras": {
                    "tz_asset_family": family,
                    "tz_variant": variant,
                    "tz_lod": lod,
                    "tz_units": "metres",
                    "tz_collision": "none",
                    "tz_original_authored": True,
                    "tz_component_inventory": inventory,
                },
            }],
            "meshes": [{"primitives": [
                {"attributes": {"POSITION": 0}, "indices": 1, "material": index}
                for index in range(3)
            ]}],
            "accessors": [
                {"count": 8, "min": [-1, 0, -1], "max": [1, 2, 1]},
                {"count": 3},
            ],
            "buffers": [{"byteLength": 4}],
            "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": 4}],
            "images": [{"bufferView": 0, "mimeType": "image/png"} for _ in range(3)],
            "textures": [{"source": index} for index in range(3)],
            "materials": [copy.deepcopy(material) for _ in range(3)],
        }

    def test_geometry_bounds_follow_parent_and_child_transforms(self) -> None:
        document = {
            "scene": 0,
            "scenes": [{"nodes": [0]}],
            "nodes": [{"translation": [10, 2, -3], "children": [1]}, {"translation": [1, 0, 0], "mesh": 0}],
            "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1}]}],
            "accessors": [{"count": 8, "min": [-1, -2, -3], "max": [1, 2, 3]}, {"count": 36}],
        }
        stats = validator.geometry_stats(document)
        self.assertEqual(stats["triangles"], 12)
        self.assertEqual(stats["bounds"]["min"], [10.0, 0.0, -6.0])
        self.assertEqual(stats["bounds"]["max"], [12.0, 4.0, 0.0])

    def test_static_policy_checks_run_without_external_proof(self) -> None:
        baseline = self.valid_policy_document()
        stats, materials = validator.validate_document_policy(baseline, "shipping-container", "red", 0, "synthetic")
        self.assertEqual(stats["drawCalls"], 3)
        self.assertEqual(len(materials), 3)
        mutations = {
            "external-image": lambda doc: doc["images"][0].__setitem__("uri", "payload.png"),
            "missing-normal": lambda doc: doc["materials"][0].pop("normalTexture"),
            "split-orm": lambda doc: doc["materials"][0]["occlusionTexture"].__setitem__("index", 2),
            "blend-material": lambda doc: doc["materials"][0].__setitem__("alphaMode", "BLEND"),
            "missing-component": lambda doc: doc["nodes"][0]["extras"].__setitem__("tz_component_inventory", "cargo-door"),
            "off-center": lambda doc: doc["nodes"][0].__setitem__("translation", [1, 0, 0]),
            "lights": lambda doc: doc.__setitem__("extensionsUsed", ["KHR_lights_punctual"]),
            "forbidden-source": lambda doc: doc["nodes"][0]["extras"].__setitem__("source", "UnityFS"),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                document = copy.deepcopy(baseline)
                mutate(document)
                with self.assertRaises(ValueError):
                    validator.validate_document_policy(document, "shipping-container", "red", 0, "synthetic")

    def test_lod_policy_rejects_missing_or_non_decreasing_costs(self) -> None:
        baseline = [
            {"family": "shipping-container", "variant": "red", "lod": lod, "triangles": triangles, "bytes": byte_count}
            for lod, triangles, byte_count in ((0, 30, 300), (1, 20, 200), (2, 10, 100))
        ]
        validator.validate_lod_progression(baseline)
        bad_triangles = copy.deepcopy(baseline)
        bad_triangles[1]["triangles"] = 30
        with self.assertRaises(ValueError):
            validator.validate_lod_progression(bad_triangles)
        bad_bytes = copy.deepcopy(baseline)
        bad_bytes[2]["bytes"] = 200
        with self.assertRaises(ValueError):
            validator.validate_lod_progression(bad_bytes)
        with self.assertRaises(ValueError):
            validator.validate_lod_progression(baseline[:2])

    @unittest.skipUnless(os.environ.get(RECEIPTS_ENV), f"set {RECEIPTS_ENV} to 15 comma-separated receipts (see the loud notice printed above)")
    def test_real_receipt_mutations_are_rejected(self) -> None:
        sources = [Path(value).resolve() for value in os.environ[RECEIPTS_ENV].split(",")]
        self.assertEqual(len(sources), len(validator.EXPECTED))
        with tempfile.TemporaryDirectory(prefix="tz-industrial-validator-mutation-") as directory:
            target_dir = Path(directory)
            targets = []
            for source in sources:
                document = json.loads(source.read_text(encoding="utf-8"))
                shutil.copy2(source.parent / document["output"]["file"], target_dir / document["output"]["file"])
                target = target_dir / source.name
                shutil.copy2(source, target)
                targets.append(target)
            validator.validate_set(targets)
            baseline = json.loads(targets[0].read_text(encoding="utf-8"))
            mutations = (
                lambda doc: doc["output"].__setitem__("triangles", doc["output"]["triangles"] + 1),
                lambda doc: doc["claims"].__setitem__("collision", True),
                lambda doc: doc["provenance"].__setitem__("gameTexturesCopied", True),
                lambda doc: doc["output"].__setitem__("sha256", "sha256:" + "0" * 64),
                lambda doc: doc["asset"]["axisPivotContract"].__setitem__("gltfFrame", "+Z up"),
            )
            for mutation in mutations:
                document = json.loads(json.dumps(baseline))
                mutation(document)
                targets[0].write_text(json.dumps(document), encoding="utf-8")
                with self.assertRaises(ValueError):
                    validator.validate_set(targets)
            targets[0].write_text(json.dumps(baseline), encoding="utf-8")


if __name__ == "__main__":
    unittest.main()
