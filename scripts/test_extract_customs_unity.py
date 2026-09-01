#!/usr/bin/env python3
"""Synthetic tests for the local Unity scalar inventory CLI."""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


SCRIPT_PATH = Path(__file__).with_name("extract-customs-unity.py")
SPEC = importlib.util.spec_from_file_location("extract_customs_unity", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
extractor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(extractor)


class FakeReader:
    def __init__(self, type_name, path_id, data, asset_name="synthetic.assets"):
        self.type = SimpleNamespace(name=type_name)
        self.path_id = path_id
        self.assets_file = SimpleNamespace(name=asset_name)
        self._data = data
        self.parse_calls = 0

    def parse_as_dict(self):
        self.parse_calls += 1
        if isinstance(self._data, BaseException):
            raise self._data
        return self._data


class FakeUnityPy:
    __version__ = "test-only"

    def __init__(self, environments=None, errors=None):
        self.environments = environments or {}
        self.errors = errors or {}
        self.load_calls = []

    def load(self, path):
        name = Path(path).name
        self.load_calls.append(name)
        if name in self.errors:
            raise self.errors[name]
        return SimpleNamespace(objects=list(self.environments.get(name, ())))


def pointer(path_id, file_id=0):
    return {"m_FileID": file_id, "m_PathID": path_id}


def vector3(x, y, z):
    return {"x": x, "y": y, "z": z}


def quaternion(x, y, z, w):
    return {"x": x, "y": y, "z": z, "w": w}


CUSTOMS_INDEX = 637


def build_settings_reader():
    scene_paths = [
        f"Assets/Scenes/Synthetic/Scene{index}.unity" for index in range(714)
    ]
    scene_paths[CUSTOMS_INDEX] = r"Assets\Scenes\Locations\Custom\CustomScene.unity"
    return FakeReader(
        "BuildSettings",
        1,
        {"scenes": scene_paths},
        asset_name="globalgamemanagers",
    )


def representative_environments():
    skipped_mesh = FakeReader("Mesh", 99, AssertionError("Mesh must never be parsed"))
    skipped_texture = FakeReader(
        "Texture2D", 100, AssertionError("Texture must never be parsed")
    )
    shared_asset = f"sharedassets{CUSTOMS_INDEX}.assets"
    level_name = f"level{CUSTOMS_INDEX}"
    shared_readers = [
        FakeReader(
            "GameObject",
            10,
            {"m_Name": "Root", "m_IsActive": 1, "m_Layer": 8},
            asset_name=shared_asset,
        ),
        FakeReader(
            "Transform",
            20,
            {
                "m_GameObject": pointer(10),
                "m_Father": pointer(0),
                "m_LocalPosition": vector3(100.125, 4.5, -25),
                "m_LocalRotation": quaternion(0, 0, 0, 1),
                "m_LocalScale": vector3(1, 1, 1),
            },
            asset_name=shared_asset,
        ),
        FakeReader(
            "GameObject",
            11,
            {"m_Name": "Terrain Tile", "m_IsActive": True, "m_Layer": 0},
            asset_name=shared_asset,
        ),
        FakeReader(
            "Transform",
            21,
            {
                "m_GameObject": pointer(11),
                "m_Father": pointer(20),
                "m_LocalPosition": vector3(2, 3, 4),
                "m_LocalRotation": quaternion(0, 0.70710678, 0, 0.70710678),
                "m_LocalScale": vector3(1, 1, 1),
            },
            asset_name=shared_asset,
        ),
        FakeReader(
            "TerrainData",
            30,
            {
                "m_Name": "Customs Terrain",
                "m_Heightmap": {
                    "m_Resolution": 2,
                    "m_Scale": vector3(2, 600, 2),
                    "m_Heights": [0, 10, 20, 30],
                },
                "m_Size": vector3(938, 600, 527),
            },
            asset_name=shared_asset,
        ),
        FakeReader(
            "Terrain",
            40,
            {"m_GameObject": pointer(11), "m_TerrainData": pointer(30)},
            asset_name=shared_asset,
        ),
        skipped_mesh,
        skipped_texture,
    ]
    return {
        "globalgamemanagers": [build_settings_reader()],
        level_name: [
            FakeReader(
                "SceneAsset",
                2,
                {"m_Name": "CustomScene"},
                asset_name=level_name,
            )
        ],
        shared_asset: shared_readers,
    }, (skipped_mesh, skipped_texture)


class ExtractCustomsUnityTests(unittest.TestCase):
    def make_source(self, base: Path, extra_names=()) -> Path:
        source = base / "synthetic-game-data"
        source.mkdir()
        names = (
            "globalgamemanagers",
            f"level{CUSTOMS_INDEX}",
            f"sharedassets{CUSTOMS_INDEX}.assets",
            *extra_names,
        )
        for name in names:
            (source / name).write_bytes(b"UnityFS\x00synthetic-only")
        return source

    def build_representative_inventory(self, source: Path):
        environments, skipped = representative_environments()
        fake = FakeUnityPy(environments)
        catalog_files = extractor.discover_catalog_files(source)
        catalog = extractor.load_build_settings_catalog(source, catalog_files, fake)
        scene_files = extractor.discover_customs_scene_files(
            source, catalog["sceneCatalog"]
        )
        inventory = extractor.build_inventory(source, catalog, scene_files, fake)
        return inventory, fake, skipped

    def run_main(self, arguments, unitypy=None):
        stdout = io.StringIO()
        stderr = io.StringIO()
        code = extractor.main(
            arguments,
            unitypy_module=unitypy,
            stdout=stdout,
            stderr=stderr,
        )
        return code, stdout.getvalue(), stderr.getvalue()

    def test_customs_scene_detection_uses_normalized_segment_not_a_hardcoded_index(self):
        self.assertTrue(
            extractor._is_customs_scene(
                r"Assets\Scenes\Locations\Custom\CustomScene.unity".replace("\\", "/")
            )
        )
        self.assertFalse(
            extractor._is_customs_scene(
                "Assets/Scenes/Locations/Customer/NotCustoms.unity"
            )
        )

        scene_paths = [f"Assets/Scenes/Synthetic/Scene{index}.unity" for index in range(714)]
        scene_paths[637] = r"Assets\Scenes\Locations\Custom\CustomScene.unity"
        _, catalog = extractor._parse_build_settings(
            {"scenes": scene_paths}, asset="globalgamemanagers", path_id=1
        )
        self.assertEqual(
            [entry["index"] for entry in catalog if entry["isCustomsCandidate"]],
            [637],
        )

    def test_inventory_contains_hierarchy_transforms_and_scalar_terrain_summary(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            inventory, fake, skipped_readers = self.build_representative_inventory(source)

        self.assertTrue(inventory["complete"])
        self.assertEqual(inventory["customsSceneIndices"], [CUSTOMS_INDEX])
        self.assertEqual(inventory["counts"]["customsSceneCandidates"], 1)
        self.assertEqual([reader.parse_calls for reader in skipped_readers], [0, 0])
        self.assertEqual(
            fake.load_calls,
            [
                "globalgamemanagers",
                f"level{CUSTOMS_INDEX}",
                f"sharedassets{CUSTOMS_INDEX}.assets",
            ],
        )
        child = next(
            item for item in inventory["gameObjects"] if item["name"] == "Terrain Tile"
        )
        self.assertEqual(child["sceneIndex"], CUSTOMS_INDEX)
        self.assertIn("/Locations/Custom/", child["scenePath"])
        self.assertEqual(child["sourceRole"], "sharedassets")
        self.assertEqual(child["hierarchyPath"], "Root/Terrain Tile")
        self.assertTrue(child["hierarchyComplete"])
        self.assertEqual(child["parentGameObjectPathId"], 10)
        self.assertEqual(child["transform"]["localPosition"], {"x": 2.0, "y": 3.0, "z": 4.0})

        terrain = inventory["terrainData"][0]
        self.assertEqual(terrain["sceneIndex"], CUSTOMS_INDEX)
        self.assertEqual(terrain["sourceRole"], "sharedassets")
        self.assertEqual(terrain["heightmapResolution"], {"width": 2, "height": 2})
        self.assertEqual(terrain["terrainSize"]["x"], 938.0)
        self.assertEqual(
            terrain["rawHeightSummary"],
            {
                "available": True,
                "storage": "numeric",
                "sampleCount": 4,
                "minimum": 0.0,
                "maximum": 30.0,
                "mean": 15.0,
                "integralValues": True,
            },
        )
        instance = inventory["terrainInstances"][0]
        self.assertEqual(instance["hierarchyPath"], "Root/Terrain Tile")
        self.assertEqual(instance["terrainDataId"], terrain["objectId"])

    def test_raw_arrays_and_mesh_or_texture_payloads_never_enter_json(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            inventory, _, _ = self.build_representative_inventory(source)
        payload = json.dumps(inventory, sort_keys=True)
        self.assertNotIn("m_Heights", payload)
        self.assertNotIn("[0, 10, 20, 30]", payload)
        self.assertNotIn('"Mesh"', payload)
        self.assertNotIn('"Texture2D"', payload)

    def test_byte_backed_heights_emit_only_count_and_digest(self):
        raw = b"\x00\x01\x02\x03"
        summary = extractor._summarize_raw_heights(raw)
        self.assertEqual(summary["byteCount"], 4)
        self.assertEqual(summary["sha256"], hashlib.sha256(raw).hexdigest())
        self.assertNotIn("values", summary)

    def test_acknowledgement_gate_runs_before_source_access(self):
        with tempfile.TemporaryDirectory() as temp_value:
            output = Path(temp_value) / "never-created.json"
            code, _, stderr = self.run_main(
                ["--source", "/definitely/not/a/game", "--output", str(output)]
            )
        self.assertEqual(code, 2)
        self.assertIn("--acknowledge-local-game-files", stderr)
        self.assertFalse(output.exists())

    def test_output_inside_source_is_refused_without_loading(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            output = source / "inventory.json"
            fake = FakeUnityPy()
            code, _, stderr = self.run_main(
                [
                    "--source",
                    str(source),
                    "--output",
                    str(output),
                    "--acknowledge-local-game-files",
                ],
                fake,
            )
            self.assertEqual(code, 2)
            self.assertIn("outside", stderr)
            self.assertEqual(fake.load_calls, [])
            self.assertFalse(output.exists())

    def test_dry_run_discovers_files_without_import_load_or_write(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            output = base / "inventory.json"
            fake = FakeUnityPy(errors={"globalgamemanagers": AssertionError("must not load")})
            code, stdout, stderr = self.run_main(
                [
                    "--source",
                    str(source),
                    "--output",
                    str(output),
                    "--acknowledge-local-game-files",
                    "--dry-run",
                ],
                fake,
            )
            plan = json.loads(stdout)
            self.assertEqual(code, 0, stderr)
            self.assertTrue(plan["dryRun"])
            self.assertFalse(plan["wouldWrite"])
            self.assertEqual(plan["selectionMode"], "catalog-first-customs-only")
            self.assertEqual(plan["catalogFiles"], ["globalgamemanagers"])
            self.assertEqual(fake.load_calls, [])
            self.assertFalse(output.exists())

    def test_missing_unitypy_has_clear_lazy_setup_error(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            output = base / "inventory.json"
            code, _, stderr = self.run_main(
                [
                    "--source",
                    str(source),
                    "--output",
                    str(output),
                    "--acknowledge-local-game-files",
                ]
            )
            self.assertEqual(code, 2)
            self.assertIn("pip install UnityPy", stderr)
            self.assertFalse(output.exists())

    def test_existing_output_requires_force_and_force_replaces_outside_source(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            output = base / "inventory.json"
            output.write_text("keep-me", encoding="utf-8")
            environments, _ = representative_environments()
            fake = FakeUnityPy(environments)

            code, _, stderr = self.run_main(
                [
                    "--source",
                    str(source),
                    "--output",
                    str(output),
                    "--acknowledge-local-game-files",
                ],
                fake,
            )
            self.assertEqual(code, 2)
            self.assertIn("--force", stderr)
            self.assertEqual(output.read_text(encoding="utf-8"), "keep-me")

            code, _, stderr = self.run_main(
                [
                    "--source",
                    str(source),
                    "--output",
                    str(output),
                    "--acknowledge-local-game-files",
                    "--force",
                ],
                fake,
            )
            self.assertEqual(code, 0, stderr)
            self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["schemaVersion"], 1)

    def test_partial_inventory_fails_closed_unless_explicitly_allowed(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            environments, _ = representative_environments()
            fake = FakeUnityPy(
                environments,
                {
                    f"sharedassets{CUSTOMS_INDEX}.assets": ValueError(
                        "synthetic parse failure"
                    )
                },
            )
            output = base / "inventory.json"
            common = [
                "--source",
                str(source),
                "--output",
                str(output),
                "--acknowledge-local-game-files",
            ]

            code, _, stderr = self.run_main(common, fake)
            self.assertEqual(code, 2)
            self.assertIn("inventory is incomplete", stderr)
            self.assertFalse(output.exists())

            code, _, stderr = self.run_main(common + ["--allow-partial"], fake)
            self.assertEqual(code, 0, stderr)
            inventory = json.loads(output.read_text(encoding="utf-8"))
            self.assertFalse(inventory["complete"])
            self.assertEqual(
                inventory["diagnostics"]["fileLoadFailures"],
                [
                    {
                        "errorType": "ValueError",
                        "file": f"sharedassets{CUSTOMS_INDEX}.assets",
                        "phase": "scene",
                        "sceneIndex": CUSTOMS_INDEX,
                    }
                ],
            )

    def test_default_never_loads_unrelated_bundles_or_other_scene_files(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            unrelated = (
                "a.bundle",
                "b.bundle",
                "level2",
                "sharedassets2.assets",
                "resources.assets",
                "terrain.resS",
                "game.exe",
            )
            source = self.make_source(base, extra_names=unrelated)
            environments, _ = representative_environments()
            fake = FakeUnityPy(
                environments,
                {name: AssertionError(f"must not load {name}") for name in unrelated},
            )
            output = base / "inventory.json"
            code, _, stderr = self.run_main(
                [
                    "--source",
                    str(source),
                    "--output",
                    str(output),
                    "--acknowledge-local-game-files",
                ],
                fake,
            )
            self.assertEqual(code, 0, stderr)
            self.assertEqual(
                fake.load_calls,
                [
                    "globalgamemanagers",
                    f"level{CUSTOMS_INDEX}",
                    f"sharedassets{CUSTOMS_INDEX}.assets",
                ],
            )
            self.assertTrue(output.exists())

    def test_catalog_at_source_root_avoids_recursive_walk(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            (source / "globalgamemanagers.assets").write_bytes(b"UnityFS\x00not-the-catalog")
            nested = source / "nested"
            nested.mkdir()
            (nested / "globalgamemanagers").write_bytes(b"UnityFS\x00decoy")
            self.assertEqual(
                extractor.discover_catalog_files(source),
                [(source / "globalgamemanagers").resolve()],
            )

    def test_output_symlink_is_refused(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            target = base / "target.json"
            target.write_text("untouched", encoding="utf-8")
            output = base / "output.json"
            try:
                output.symlink_to(target)
            except OSError:
                self.skipTest("symbolic links are unavailable")
            code, _, stderr = self.run_main(
                [
                    "--source",
                    str(source),
                    "--output",
                    str(output),
                    "--acknowledge-local-game-files",
                    "--force",
                ],
                FakeUnityPy({"globalgamemanagers": []}),
            )
            self.assertEqual(code, 2)
            self.assertIn("symbolic link", stderr)
            self.assertEqual(target.read_text(encoding="utf-8"), "untouched")

    def test_output_is_deterministic_and_contains_no_absolute_source_path(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            environments_one, _ = representative_environments()
            environments_two, _ = representative_environments()
            outputs = [base / "one.json", base / "two.json"]
            for output, environments in zip(
                outputs, (environments_one, environments_two)
            ):
                code, _, stderr = self.run_main(
                    [
                        "--source",
                        str(source),
                        "--output",
                        str(output),
                        "--acknowledge-local-game-files",
                    ],
                    FakeUnityPy(environments),
                )
                self.assertEqual(code, 0, stderr)
            first = outputs[0].read_text(encoding="utf-8")
            second = outputs[1].read_text(encoding="utf-8")
            self.assertEqual(first, second)
            self.assertNotIn(str(source), first)


if __name__ == "__main__":
    unittest.main()
