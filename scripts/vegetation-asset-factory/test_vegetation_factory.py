#!/usr/bin/env python3
"""Stdlib tests for the Customs vegetation asset factory and receipt gate."""

from __future__ import annotations

import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import types
import unittest


HERE = Path(__file__).resolve().parent
FACTORY = HERE / "vegetation_factory.py"
VALIDATOR = HERE / "validate_vegetation_outputs.py"
CATALOG = HERE / "prototype_catalog.json"
DEFAULT_BLENDER = Path("/home/Zequence106/.local/share/tarkovzero-tools/blender-4.5.13/blender")
FULL_PACK_BUILDER = HERE / "build_full_pack.py"
PACK_INDEX_BUILDER = HERE / "build_pack_index.py"
FULL_PACK_VALIDATOR = HERE / "validate_full_pack.py"
CONTACT_SHEET_BUILDER = HERE / "build_contact_sheet.py"
PREVIEW_RENDERER = HERE / "render_preview.py"
FIXED_CAMERA_CONTINUITY_VALIDATOR = HERE / "validate_fixed_camera_continuity.py"
REPRODUCIBILITY_VALIDATOR = HERE / "verify_pack_reproducibility.py"
PROTOTYPE_REPRODUCIBILITY_VALIDATOR = HERE / "verify_prototype_reproducibility.py"
SOURCE_ATLAS_VALIDATOR = HERE / "validate_source_atlas.py"
EMBEDDED_ATLAS_VALIDATOR = HERE / "validate_embedded_alpha_atlas.py"
PINE_ATLAS = HERE / "source-textures" / "pine-scots-branch-sprays-openai-v1.png"
PINE_ATLAS_PROVENANCE = PINE_ATLAS.with_suffix(".provenance.json")
DECIDUOUS_ATLAS = HERE / "source-textures" / "deciduous-broadleaf-branch-sprays-openai-v1.png"
DECIDUOUS_ATLAS_PROVENANCE = DECIDUOUS_ATLAS.with_suffix(".provenance.json")


def load_validator() -> types.ModuleType:
    spec = importlib.util.spec_from_file_location("vegetation_output_validator", VALIDATOR)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gate = load_validator()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def glb_bytes(document: dict, bin_payload: bytes = b"\x89PNG\r\n\x1a\n\0\0\0\0") -> bytes:
    json_blob = json.dumps(document, sort_keys=True, separators=(",", ":")).encode("utf-8")
    json_blob += b" " * ((4 - len(json_blob) % 4) % 4)
    bin_payload += b"\0" * ((4 - len(bin_payload) % 4) % 4)
    total = 12 + 8 + len(json_blob) + 8 + len(bin_payload)
    return (
        struct.pack("<4sII", b"glTF", 2, total)
        + struct.pack("<II", len(json_blob), 0x4E4F534A)
        + json_blob
        + struct.pack("<II", len(bin_payload), 0x004E4942)
        + bin_payload
    )


def synthetic_gltf(prototype: str, lod: int, triangles: int, padding: int) -> dict:
    return {
        "asset": {"version": "2.0", "generator": "unit-test"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{
            "name": f"TZ_Vegetation_{prototype.lower()}_LOD{lod}_ROOT",
            "mesh": 0,
            "extras": {
                "tz_pivot": "base-center",
                "tz_unit": "metre",
                "tz_prototype": prototype,
                "tz_original_authored": True,
            },
        }],
        "buffers": [{"byteLength": 12}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": 4},
            {"buffer": 0, "byteOffset": 4, "byteLength": 4},
            {"buffer": 0, "byteOffset": 8, "byteLength": 4},
        ],
        "images": [
            {"bufferView": 0, "mimeType": "image/png"},
            {"bufferView": 1, "mimeType": "image/png"},
            {"bufferView": 2, "mimeType": "image/png"},
        ],
        "textures": [{"source": 0}, {"source": 1}, {"source": 2}],
        "materials": [{
            "pbrMetallicRoughness": {
                "baseColorTexture": {"index": 0},
                "metallicRoughnessTexture": {"index": 2},
            },
            "normalTexture": {"index": 1},
            "occlusionTexture": {"index": 2},
        }],
        "accessors": [{"count": triangles * 3}],
        "meshes": [{"primitives": [{"indices": 0, "material": 0, "mode": 4}]}],
        "extras": {"padding": "x" * padding},
    }


def write_synthetic_set(root: Path, prototype: str = "pine02", costs=((900, 4000), (400, 1800), (120, 200))) -> list[Path]:
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    spec = next(entry for entry in catalog["prototypes"] if entry["name"] == prototype)
    paths = []
    fake_sha = "sha256:" + "1" * 64
    catalog_sha = "sha256:" + sha256(CATALOG)
    for lod, (triangles, padding) in enumerate(costs):
        output = root / f"{prototype.lower()}-lod{lod}.glb"
        receipt = root / f"{prototype.lower()}-lod{lod}.receipt.json"
        output.write_bytes(glb_bytes(synthetic_gltf(prototype, lod, triangles, padding)))
        document = {
            "schemaVersion": 1,
            "generator": {
                "scriptSha256": "sha256:" + sha256(FACTORY),
                "catalogSha256": catalog_sha,
                "blenderBinarySha256": fake_sha,
                "argvAfterSeparator": [
                    "--prototype", prototype,
                    "--lod", str(lod),
                    "--output", str(output),
                    "--receipt", str(receipt),
                ],
            },
            "copyrightBoundary": {
                "gameFilesReadByGenerator": False,
                "gameMeshesIncluded": False,
                "gameTexturesIncluded": False,
                "externalTexturesIncluded": False,
            },
            "asset": {
                "id": f"customs.vegetation.{prototype.lower()}",
                "prototypeName": prototype,
                "family": spec["family"],
                "form": spec["form"],
                "variant": spec["variant"],
                "dry": spec["dry"],
                "lod": lod,
                "outputFile": output.name,
                "bytes": output.stat().st_size,
                "sha256": "sha256:" + sha256(output),
                "gltf": {"unit": "metre", "upAxis": "+y", "forwardAxis": "+z", "pivot": "base-center"},
                "boundsM": {
                    "min": [-float(spec["nominalWidthM"]) / 2, 0.0, -float(spec["nominalWidthM"]) / 2],
                    "max": [float(spec["nominalWidthM"]) / 2, float(spec["nominalHeightM"]), float(spec["nominalWidthM"]) / 2],
                },
            },
            "generated": {
                "triangles": triangles,
                "exportedTriangles": triangles,
                "materialCount": 1,
                "embeddedImageCount": 3,
                "textureResolution": (128, 64, 32)[lod],
                "seed": 106,
                "alphaModeCounts": {"OPAQUE": 1, "MASK": 0, "BLEND": 0},
                "proceduralAlphaCards": [],
            },
        }
        receipt.write_text(json.dumps(document), encoding="utf-8")
        paths.append(receipt)
    return paths


class CatalogTests(unittest.TestCase):
    def test_catalog_is_the_exact_local_scalar_name_ledger(self) -> None:
        document = json.loads(CATALOG.read_text(encoding="utf-8"))
        names = {entry["name"] for entry in document["prototypes"]}
        self.assertEqual(len(names), 31)
        self.assertEqual(sum(entry["instances"] for entry in document["prototypes"]), 8805)
        self.assertEqual(document["families"], {
            "birch": 35,
            "deciduous-broadleaf": 479,
            "filbert-shrub": 2747,
            "ground-plant": 2391,
            "pine": 3051,
            "stump": 102,
        })
        self.assertEqual(
            names,
            {
                "birch01", "birch02", "birch03", "brush_dry01", "brush_dry02",
                "fern01", "fern02", "filbert_01", "filbert_big01", "filbert_big02",
                "filbert_big03", "filbert_dry01", "filbert_dry03", "filbert_small01",
                "filbert_small02", "filbert_small03", "grass_dry3", "pine01", "pine02",
                "pine03", "pine04", "pine05", "plant_wolf01", "plant_wolf02",
                "Stump01_update", "Stump02_update", "Stump03_update", "Stump04_update",
                "tree01", "tree02", "tree03",
            },
        )

    def test_every_required_visual_family_has_three_lod_authorship_code(self) -> None:
        source = FACTORY.read_text(encoding="utf-8")
        ast.parse(source)
        for family in (
            "pine_geometry", "deciduous_geometry", "shrub_geometry", "stump_geometry",
            "ground_plant_geometry",
        ):
            self.assertIn(f"def {family}", source)
        self.assertIn("TEXTURE_SIZE_BY_LOD = {0: 128, 1: 64, 2: 32}", source)
        self.assertIn("base-center", source)
        self.assertIn("stable_seed", source)

    def test_factory_has_no_clobber_and_embedded_only_export_guards(self) -> None:
        source = FACTORY.read_text(encoding="utf-8")
        self.assertIn("os.link(output_temp, output)", source)
        self.assertIn("os.O_EXCL", source)
        self.assertIn("export_format=\"GLB\"", source)
        self.assertIn('require("uri" not in entry', source)
        self.assertNotIn("Battlestate Games", source)
        self.assertNotIn("EscapeFromTarkov_Data", source)

    def test_complete_pack_tools_parse_and_use_unique_stable_prototype_seeds(self) -> None:
        for path in (
            FULL_PACK_BUILDER,
            PACK_INDEX_BUILDER,
            FULL_PACK_VALIDATOR,
            CONTACT_SHEET_BUILDER,
            REPRODUCIBILITY_VALIDATOR,
            PROTOTYPE_REPRODUCIBILITY_VALIDATOR,
            SOURCE_ATLAS_VALIDATOR,
            EMBEDDED_ATLAS_VALIDATOR,
            PREVIEW_RENDERER,
            FIXED_CAMERA_CONTINUITY_VALIDATOR,
        ):
            ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        spec = importlib.util.spec_from_file_location("vegetation_full_pack_builder", FULL_PACK_BUILDER)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
        first = [module.prototype_seed(entry["name"]) for entry in catalog["prototypes"]]
        second = [module.prototype_seed(entry["name"]) for entry in catalog["prototypes"]]
        self.assertEqual(first, second)
        self.assertEqual(len(set(first)), 31)
        self.assertTrue(all(0 <= seed <= 2**31 - 1 for seed in first))

    def test_pine_source_atlas_is_hash_pinned_openai_original_not_game_texture(self) -> None:
        provenance = json.loads(PINE_ATLAS_PROVENANCE.read_text(encoding="utf-8"))
        self.assertEqual(provenance["sha256"], "sha256:" + sha256(PINE_ATLAS))
        self.assertEqual(provenance["bytes"], PINE_ATLAS.stat().st_size)
        self.assertEqual(provenance["origin"]["provider"], "OpenAI")
        self.assertFalse(provenance["origin"]["sourceGameTexture"])
        self.assertIn("twelve distinct, isolated Scots pine branch sprays", provenance["promptVerbatim"])
        self.assertIn("no opaque matte or color fringe", provenance["promptVerbatim"])
        header = PINE_ATLAS.read_bytes()[:24]
        self.assertEqual(header[:8], b"\x89PNG\r\n\x1a\n")
        self.assertEqual(struct.unpack(">II", header[16:24]), (1254, 1254))

    def test_pine_alpha_proof_is_explicit_and_full_pack_stays_standard(self) -> None:
        factory_source = FACTORY.read_text(encoding="utf-8")
        full_pack_source = FULL_PACK_BUILDER.read_text(encoding="utf-8")
        self.assertIn('parser.add_argument("--pine-alpha-proof", action="store_true")', factory_source)
        self.assertIn('if pine_alpha_proof and spec["name"] == "pine01"', factory_source)
        self.assertNotIn("--pine-alpha-proof", full_pack_source)

    def test_deciduous_source_atlas_is_hash_pinned_openai_original_not_game_texture(self) -> None:
        provenance = json.loads(DECIDUOUS_ATLAS_PROVENANCE.read_text(encoding="utf-8"))
        self.assertEqual(provenance["sha256"], "sha256:" + sha256(DECIDUOUS_ATLAS))
        self.assertEqual(provenance["bytes"], DECIDUOUS_ATLAS.stat().st_size)
        self.assertEqual(provenance["origin"]["provider"], "OpenAI")
        self.assertFalse(provenance["origin"]["sourceGameTexture"])
        self.assertIn(
            "twelve distinct, isolated cold-temperate deciduous branch sprays",
            provenance["promptVerbatim"],
        )
        self.assertIn("repeated radial star patterns", provenance["promptVerbatim"])
        header = DECIDUOUS_ATLAS.read_bytes()[:24]
        self.assertEqual(header[:8], b"\x89PNG\r\n\x1a\n")
        self.assertEqual(struct.unpack(">II", header[16:24]), (1254, 1254))

    def test_deciduous_alpha_proof_is_tree02_only_and_full_pack_stays_standard(self) -> None:
        factory_source = FACTORY.read_text(encoding="utf-8")
        full_pack_source = FULL_PACK_BUILDER.read_text(encoding="utf-8")
        self.assertIn('parser.add_argument("--deciduous-alpha-proof", action="store_true")', factory_source)
        self.assertIn('deciduous_alpha_proof and spec["name"] == "tree02"', factory_source)
        self.assertIn("independentCellResample", factory_source)
        self.assertIn("keyed-nested-landmarks-v1", factory_source)
        self.assertIn("DECIDUOUS_PROOF_CELL_CHOICES", factory_source)
        self.assertNotIn("--deciduous-alpha-proof", full_pack_source)

    def test_deciduous_continuity_gate_uses_transparent_fixed_camera_masks(self) -> None:
        renderer_source = PREVIEW_RENDERER.read_text(encoding="utf-8")
        continuity_source = FIXED_CAMERA_CONTINUITY_VALIDATOR.read_text(encoding="utf-8")
        self.assertIn('"--transparent-silhouette"', renderer_source)
        self.assertIn("scene.render.film_transparent = args.transparent_silhouette", renderer_source)
        self.assertIn("minimumDilatedIou", continuity_source)
        self.assertIn("minimumAreaRetention", continuity_source)
        self.assertIn("--output must be a new path", continuity_source)

    def test_deciduous_source_gate_reports_seams_and_rejects_surviving_chroma_fringe(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            report = Path(raw) / "deciduous-source-report.json"
            subprocess.run([
                sys.executable,
                str(SOURCE_ATLAS_VALIDATOR),
                "--atlas",
                str(DECIDUOUS_ATLAS),
                "--provenance",
                str(DECIDUOUS_ATLAS_PROVENANCE),
                "--output",
                str(report),
            ], check=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            document = json.loads(report.read_text(encoding="utf-8"))
        self.assertEqual(document["status"], "pass-with-derived-cell-isolation-required")
        self.assertGreater(document["alpha"]["internalGridAtLeast96Pixels"], 0)
        self.assertGreater(document["alpha"]["saturatedChromaFringeBelowCutoffPixels"], 0)
        self.assertEqual(document["alpha"]["saturatedChromaFringeAtOrAboveCutoffPixels"], 0)


class ValidatorTests(unittest.TestCase):
    def test_accepts_a_complete_strictly_decreasing_embedded_set(self) -> None:
        document, by_name = gate.catalog()
        with tempfile.TemporaryDirectory() as raw:
            receipts = write_synthetic_set(Path(raw))
            args = types.SimpleNamespace(prototype="pine02", receipts=receipts)
            result = gate.validate_set(args, document, by_name)
        self.assertEqual(result["prototype"], "pine02")
        self.assertEqual([lod["triangles"] for lod in result["lods"]], [900, 400, 120])

    def test_rejects_non_decreasing_triangle_cost(self) -> None:
        document, by_name = gate.catalog()
        with tempfile.TemporaryDirectory() as raw:
            receipts = write_synthetic_set(Path(raw), costs=((900, 4000), (900, 1800), (120, 200)))
            args = types.SimpleNamespace(prototype="pine02", receipts=receipts)
            with self.assertRaisesRegex(ValueError, "triangle cost does not strictly decrease"):
                gate.validate_set(args, document, by_name)

    def test_rejects_external_image_uri_even_with_valid_hash_receipt(self) -> None:
        document, by_name = gate.catalog()
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            receipts = write_synthetic_set(root)
            target_receipt = receipts[0]
            receipt = json.loads(target_receipt.read_text(encoding="utf-8"))
            output = root / receipt["asset"]["outputFile"]
            gltf = synthetic_gltf("pine02", 0, 900, 4000)
            gltf["images"][0] = {"uri": "outside.png"}
            output.write_bytes(glb_bytes(gltf))
            receipt["asset"]["bytes"] = output.stat().st_size
            receipt["asset"]["sha256"] = "sha256:" + sha256(output)
            target_receipt.write_text(json.dumps(receipt), encoding="utf-8")
            args = types.SimpleNamespace(prototype="pine02", receipts=receipts)
            with self.assertRaisesRegex(ValueError, "is external"):
                gate.validate_set(args, document, by_name)


@unittest.skipUnless(os.environ.get("TARKOVZERO_RUN_BLENDER_VEGETATION_TEST") == "1", "opt-in Blender integration")
class BlenderIntegrationTests(unittest.TestCase):
    def test_grass_dry_three_lod_round_trip(self) -> None:
        blender = Path(os.environ.get("TARKOVZERO_BLENDER", str(DEFAULT_BLENDER)))
        self.assertTrue(blender.is_file(), f"Blender not found: {blender}")
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            receipts = []
            for lod in range(3):
                output = root / f"grass-dry3-lod{lod}.glb"
                receipt = root / f"grass-dry3-lod{lod}.receipt.json"
                subprocess.run([
                    str(blender), "--background", "--factory-startup", "--disable-autoexec",
                    "--python-exit-code", "1", "--python", str(FACTORY), "--",
                    "--prototype", "grass_dry3", "--lod", str(lod),
                    "--output", str(output), "--receipt", str(receipt),
                ], check=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
                receipts.append(receipt)
            subprocess.run([
                sys.executable, str(VALIDATOR), "--prototype", "grass_dry3",
                *(str(path) for path in receipts),
            ], check=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
