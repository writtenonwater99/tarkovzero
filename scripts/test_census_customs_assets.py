#!/usr/bin/env python3
"""Synthetic tests for the Customs scalar asset census CLI.

Every fixture here is a fake in-memory Unity object.  The suite never needs, and
must never touch, real game files.
"""

from __future__ import annotations

import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


SCRIPT_PATH = Path(__file__).with_name("census-customs-assets.py")
SPEC = importlib.util.spec_from_file_location("census_customs_assets", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
census_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(census_module)

CUSTOMS_INDEX = 637
LEVEL_NAME = f"level{CUSTOMS_INDEX}"
SHARED_NAME = f"sharedassets{CUSTOMS_INDEX}.assets"


class FakeReader:
    """Stands in for a UnityPy object reader without any real serialized data."""

    def __init__(
        self,
        type_name,
        path_id,
        data,
        asset_name=SHARED_NAME,
        *,
        byte_size=1024,
        externals=(),
    ):
        self.type = SimpleNamespace(name=type_name)
        self.path_id = path_id
        self.byte_size = byte_size
        self.assets_file = SimpleNamespace(name=asset_name, externals=list(externals))
        self._data = data
        self.parse_calls = 0

    def parse_as_dict(self):
        self.parse_calls += 1
        if isinstance(self._data, BaseException):
            raise self._data
        return json.loads(json.dumps(self._data))


class FakeEnvironment:
    def __init__(self, objects):
        self.objects = list(objects)

    def find_file(self, *_args, **_kwargs):
        return "unsafe-find"

    def load_file(self, *_args, **_kwargs):
        return "unsafe-file"

    def load_files(self, *_args, **_kwargs):
        return "unsafe-files"

    def load_folder(self, *_args, **_kwargs):
        return "unsafe-folder"

    def load_assets(self, *_args, **_kwargs):
        return "unsafe-assets"


class FakeUnityPy:
    __version__ = "test-only"

    def __init__(self, environments=None, errors=None, on_load=None):
        self.environments = environments or {}
        self.errors = errors or {}
        self.on_load = on_load
        self.load_calls = []
        self.load_inputs = []
        self.stream_facts = []
        self.returned_environments = []

    def load(self, source):
        if isinstance(source, (str, Path)):
            raise AssertionError("UnityPy.load must receive the safe file-like wrapper")
        name = source.name
        self.load_calls.append(name)
        self.load_inputs.append(source)
        self.stream_facts.append(
            {"name": source.name, "path": getattr(source, "path", None)}
        )
        if self.on_load is not None:
            self.on_load(source, name)
        if name in self.errors:
            raise self.errors[name]
        environment = FakeEnvironment(self.environments.get(name, ()))
        self.returned_environments.append(environment)
        return environment

    def save(self, *args, **kwargs):  # pragma: no cover - guard only
        raise AssertionError("the census must never call a UnityPy save/export API")


def pointer(path_id, file_id=0):
    return {"m_FileID": file_id, "m_PathID": path_id}


def vector3(x, y, z):
    return {"x": x, "y": y, "z": z}


def quaternion(x, y, z, w):
    return {"x": x, "y": y, "z": z, "w": w}


def build_settings_reader():
    scene_paths = [f"Assets/Scenes/Synthetic/Scene{index}.unity" for index in range(714)]
    scene_paths[CUSTOMS_INDEX] = r"Assets\Scenes\Locations\Custom\CustomScene.unity"
    return FakeReader(
        "BuildSettings", 1, {"scenes": scene_paths}, asset_name="globalgamemanagers"
    )


def game_object(path_id, name, components=()):
    return FakeReader(
        "GameObject",
        path_id,
        {
            "m_Name": name,
            "m_IsActive": 1,
            "m_Layer": 8,
            "m_TagString": "Untagged",
            "m_Component": [{"component": pointer(item)} for item in components],
        },
    )


def transform(path_id, game_object_path_id, parent_path_id, position, rotation=None, scale=None):
    return FakeReader(
        "Transform",
        path_id,
        {
            "m_GameObject": pointer(game_object_path_id),
            "m_Father": pointer(parent_path_id),
            "m_LocalPosition": position,
            "m_LocalRotation": rotation or quaternion(0, 0, 0, 1),
            "m_LocalScale": scale or vector3(1, 1, 1),
        },
    )


def mesh_renderer(path_id, game_object_path_id, material_path_ids):
    return FakeReader(
        "MeshRenderer",
        path_id,
        {
            "m_GameObject": pointer(game_object_path_id),
            "m_Enabled": 1,
            "m_CastShadows": 1,
            "m_ReceiveShadows": 1,
            "m_Materials": [pointer(item) for item in material_path_ids],
        },
    )


def mesh_filter(path_id, game_object_path_id, mesh_path_id):
    return FakeReader(
        "MeshFilter",
        path_id,
        {"m_GameObject": pointer(game_object_path_id), "m_Mesh": pointer(mesh_path_id)},
    )


def mesh(path_id, name, vertex_count=128, submeshes=2):
    return FakeReader(
        "Mesh",
        path_id,
        {
            "m_Name": name,
            "m_VertexCount": vertex_count,
            "m_SubMeshes": [
                {"indexCount": 96, "firstByte": 0} for _ in range(submeshes)
            ],
            "m_LocalAABB": {
                "m_Center": vector3(0, 1.5, 0),
                "m_Extent": vector3(1.25, 1.5, 0.75),
            },
            # Payload fields that must be scrubbed before anything reads them.
            "m_VertexData": {"m_DataSize": [1, 2, 3, 4, 5, 6, 7, 8]},
            "m_IndexBuffer": [11, 12, 13, 14, 15, 16],
            "m_Normals": [[0, 1, 0]] * 4,
            "m_UV0": [[0, 0], [1, 1]],
            "m_Skin": [{"weight": 1.0}],
            "m_CompressedMesh": {"m_Vertices": [0.5, 0.5]},
            "m_StreamData": {"path": "archive:/CAB-secret/CAB-secret.resS"},
        },
    )


def material(path_id, name, texture_path_id):
    return FakeReader(
        "Material",
        path_id,
        {
            "m_Name": name,
            "m_Shader": pointer(9001),
            "m_ShaderKeywords": "_NORMALMAP _EMISSION",
            "m_SavedProperties": {
                "m_Floats": [
                    {"first": "_Glossiness", "second": 0.42},
                    {"first": "_Metallic", "second": 0.0},
                ],
                "m_Colors": [
                    {"first": "_Color", "second": {"r": 0.5, "g": 0.25, "b": 0.125, "a": 1.0}}
                ],
                "m_TexEnvs": [
                    {
                        "first": "_MainTex",
                        "second": {
                            "m_Texture": pointer(texture_path_id),
                            "m_Scale": {"x": 2.0, "y": 2.0},
                            "m_Offset": {"x": 0.0, "y": 0.0},
                        },
                    },
                    {
                        "first": "_BumpMap",
                        "second": {
                            "m_Texture": pointer(0),
                            "m_Scale": {"x": 1.0, "y": 1.0},
                            "m_Offset": {"x": 0.0, "y": 0.0},
                        },
                    },
                ],
            },
        },
    )


def texture(path_id, name, width=2048, height=2048):
    return FakeReader(
        "Texture2D",
        path_id,
        {
            "m_Name": name,
            "m_Width": width,
            "m_Height": height,
            "image data": [7] * 32,
            "m_StreamData": {"path": "archive:/CAB-secret/CAB-secret.resS", "size": 4096},
        },
    )


def lod_group(path_id, game_object_path_id, renderer_path_ids):
    return FakeReader(
        "LODGroup",
        path_id,
        {
            "m_GameObject": pointer(game_object_path_id),
            "m_Enabled": 1,
            "m_LODs": [
                {
                    "screenRelativeTransitionHeight": 0.5,
                    "fadeTransitionWidth": 0.0,
                    "renderers": [{"renderer": pointer(renderer_path_ids[0])}],
                },
                {
                    "screenRelativeTransitionHeight": 0.05,
                    "fadeTransitionWidth": 0.0,
                    "renderers": [{"renderer": pointer(renderer_path_ids[1])}],
                },
            ],
        },
    )


def light(path_id, game_object_path_id):
    return FakeReader(
        "Light",
        path_id,
        {
            "m_GameObject": pointer(game_object_path_id),
            "m_Enabled": 1,
            "m_Type": 2,
            "m_Color": {"r": 1.0, "g": 0.85, "b": 0.6, "a": 1.0},
            "m_Range": 12.5,
            "m_Intensity": 2.25,
            "m_Shadows": {"m_Type": 2},
        },
    )


def representative_environments():
    """A small Customs-shaped scene: one root, two repeated barrier placements."""
    forbidden = [
        FakeReader("AnimationClip", 900, AssertionError("AnimationClip must never be parsed")),
        FakeReader("MonoBehaviour", 901, AssertionError("MonoBehaviour must never be parsed")),
        FakeReader("Shader", 902, AssertionError("Shader must never be parsed")),
        FakeReader("AudioClip", 903, AssertionError("AudioClip must never be parsed")),
    ]
    readers = [
        game_object(10, "Customs", components=(20,)),
        transform(20, 10, 0, vector3(0, 0, 0)),
        game_object(11, "Barrier_Concrete", components=(21, 31, 41)),
        transform(21, 11, 20, vector3(10, 0, -5), quaternion(0, 0.70710678, 0, 0.70710678)),
        mesh_filter(31, 11, 60),
        mesh_renderer(41, 11, [70]),
        game_object(12, "Barrier_Concrete (1)", components=(22, 32, 42)),
        transform(22, 12, 20, vector3(14, 0, -5)),
        mesh_filter(32, 12, 60),
        mesh_renderer(42, 12, [70]),
        game_object(13, "Warehouse_Lamp", components=(23, 43, 50)),
        transform(23, 13, 21, vector3(0, 3, 0)),
        mesh_renderer(43, 13, [71, 70]),
        light(50, 13),
        mesh(60, "Barrier_Concrete_LOD0"),
        material(70, "Concrete_Barrier_Mat", 80),
        material(71, "Lamp_Glass_Mat", 81),
        texture(80, "concrete_barrier_albedo"),
        texture(81, "lamp_glass_albedo", width=512, height=512),
        lod_group(90, 11, [41, 42]),
        FakeReader(
            "PrefabInstance",
            95,
            {"m_Name": "Barrier_Concrete_Prefab", "m_SourcePrefab": pointer(1234, file_id=2)},
        ),
        *forbidden,
    ]
    environments = {
        "globalgamemanagers": [build_settings_reader()],
        LEVEL_NAME: [
            FakeReader("GameObject", 5, {"m_Name": "SceneRoot"}, asset_name=LEVEL_NAME)
        ],
        SHARED_NAME: readers,
    }
    return environments, forbidden


class CensusTests(unittest.TestCase):
    def make_source(self, base: Path, extra_names=()) -> Path:
        source = base / "synthetic-game-data"
        source.mkdir()
        for name in ("globalgamemanagers", LEVEL_NAME, SHARED_NAME, *extra_names):
            (source / name).write_bytes(b"UnityFS\x00synthetic-only")
        return source

    def build(self, source: Path, environments=None):
        environments = environments or representative_environments()[0]
        fake = FakeUnityPy(environments)
        catalog_files = census_module.discover_catalog_files(source)
        catalog = census_module.load_build_settings_catalog(source, catalog_files, fake)
        scene_files = census_module.discover_customs_scene_files(source, catalog["sceneCatalog"])
        return census_module.build_census(source, catalog, scene_files, fake), fake

    def run_main(self, arguments, unitypy=None):
        stdout = io.StringIO()
        stderr = io.StringIO()
        code = census_module.main(
            arguments, unitypy_module=unitypy, stdout=stdout, stderr=stderr
        )
        return code, stdout.getvalue(), stderr.getvalue()

    # -- census content -----------------------------------------------------

    def test_census_records_identity_hierarchy_and_world_transforms(self):
        with tempfile.TemporaryDirectory() as temp_value:
            source = self.make_source(Path(temp_value))
            census, fake = self.build(source)

        self.assertFalse(census["complete"])
        self.assertEqual(census["counts"]["skippedObjects"], 3)
        self.assertEqual(
            fake.load_calls, ["globalgamemanagers", LEVEL_NAME, SHARED_NAME]
        )
        barrier = next(
            item
            for item in census["gameObjects"]
            if item.get("name") == "Barrier_Concrete"
        )
        self.assertEqual(barrier["hierarchyPath"], "Customs/Barrier_Concrete")
        self.assertTrue(barrier["hierarchyComplete"])
        self.assertEqual(barrier["sceneIndex"], CUSTOMS_INDEX)
        self.assertIn("/Locations/Custom/", barrier["scenePath"])
        self.assertEqual(barrier["componentCount"], 3)
        self.assertEqual(barrier["world"]["position"], {"x": 10.0, "y": 0.0, "z": -5.0})
        self.assertTrue(barrier["world"]["worldExact"])

        lamp = next(
            item for item in census["gameObjects"] if item.get("name") == "Warehouse_Lamp"
        )
        # Child of a 90-degree-rotated parent: local (0,3,0) stays (10,3,-5).
        self.assertEqual(lamp["hierarchyPath"], "Customs/Barrier_Concrete/Warehouse_Lamp")
        self.assertAlmostEqual(lamp["world"]["position"]["x"], 10.0, places=5)
        self.assertAlmostEqual(lamp["world"]["position"]["y"], 3.0, places=5)
        self.assertAlmostEqual(lamp["world"]["position"]["z"], -5.0, places=5)

    def test_repeated_placements_share_a_normalized_family_name(self):
        with tempfile.TemporaryDirectory() as temp_value:
            source = self.make_source(Path(temp_value))
            census, _ = self.build(source)
        names = {
            item["name"]: item["normalizedName"]
            for item in census["gameObjects"]
            if item.get("name", "").startswith("Barrier")
        }
        self.assertEqual(
            names, {"Barrier_Concrete": "barrier_concrete", "Barrier_Concrete (1)": "barrier_concrete"}
        )
        hashes = {
            item["nameHash"]
            for item in census["gameObjects"]
            if item.get("name", "").startswith("Barrier")
        }
        self.assertEqual(len(hashes), 1)

    def test_payload_bearing_meshes_and_textures_are_ledgered_without_parsing(self):
        with tempfile.TemporaryDirectory() as temp_value:
            source = self.make_source(Path(temp_value))
            environments, _ = representative_environments()
            census, _ = self.build(source, environments)

        renderer = next(item for item in census["renderers"] if item["pathId"] == 41)
        self.assertEqual(renderer["materialSlotCount"], 1)
        self.assertNotIn("meshName", renderer)
        self.assertNotIn("vertexCount", renderer)
        self.assertNotIn("submeshCount", renderer)
        self.assertNotIn("localAabb", renderer)
        self.assertEqual(renderer["materialNames"], ["Concrete_Barrier_Mat"])
        self.assertEqual(renderer["hierarchyPath"], "Customs/Barrier_Concrete")
        self.assertEqual(census["meshes"], [])
        self.assertEqual(census["textures"], [])

        material_record = next(item for item in census["materials"] if item["pathId"] == 70)
        self.assertIn({"name": "_Glossiness", "value": 0.42}, material_record["scalarProperties"])
        self.assertEqual(
            material_record["colorProperties"],
            [{"name": "_Color", "r": 0.5, "g": 0.25, "b": 0.125, "a": 1.0}],
        )
        main_texture = next(
            item for item in material_record["textureProperties"] if item["name"] == "_MainTex"
        )
        self.assertNotIn("textureName", main_texture)
        payload_readers = [
            reader
            for readers in environments.values()
            for reader in readers
            if reader.type.name in ("Mesh", "Texture2D")
        ]
        self.assertEqual([reader.parse_calls for reader in payload_readers], [0, 0, 0])
        self.assertEqual(
            {item["reason"] for item in census["diagnostics"]["skippedObjects"]},
            {"payload-bearing-type-not-parsed"},
        )

    def test_lod_groups_and_lights_are_captured_with_thresholds(self):
        with tempfile.TemporaryDirectory() as temp_value:
            source = self.make_source(Path(temp_value))
            census, _ = self.build(source)

        group = census["lodGroups"][0]
        self.assertEqual(group["lodCount"], 2)
        self.assertEqual(group["hierarchyPath"], "Customs/Barrier_Concrete")
        self.assertEqual(
            [level["screenRelativeTransitionHeight"] for level in group["levels"]],
            [0.5, 0.05],
        )
        self.assertEqual(group["levels"][0]["rendererPathIds"], [41])

        light_record = census["lights"][0]
        self.assertEqual(light_record["lightType"], "Point")
        self.assertEqual(light_record["range"], 12.5)
        self.assertEqual(light_record["intensity"], 2.25)
        self.assertEqual(light_record["color"]["g"], 0.85)
        # Shadow type is outside the light facts the contract enumerates.
        self.assertNotIn("shadowType", light_record)
        self.assertEqual(light_record["hierarchyPath"], "Customs/Barrier_Concrete/Warehouse_Lamp")

    def test_scene_file_ledger_records_role_and_content_digest(self):
        with tempfile.TemporaryDirectory() as temp_value:
            source = self.make_source(Path(temp_value))
            census, _ = self.build(source)
        roles = {entry["role"]: entry for entry in census["source"]["sceneFiles"]}
        self.assertEqual(sorted(roles), ["level", "sharedassets"])
        for entry in roles.values():
            self.assertTrue(entry["digestComplete"])
            self.assertTrue(entry["bindingVerified"])
            self.assertEqual(len(entry["sha256"]), 64)
            self.assertEqual(len(entry["statIdentityHash"]), 64)
            self.assertEqual(entry["byteSize"], len(b"UnityFS\x00synthetic-only"))
            self.assertEqual(entry["sceneIndex"], CUSTOMS_INDEX)
        catalog_fact = census["source"]["catalogFileFacts"][0]
        self.assertEqual(catalog_fact["file"], "globalgamemanagers")
        self.assertEqual(catalog_fact["role"], "catalog")
        self.assertTrue(catalog_fact["digestComplete"])
        self.assertTrue(catalog_fact["bindingVerified"])
        self.assertEqual(len(catalog_fact["statIdentityHash"]), 64)

    # -- forbidden facts ----------------------------------------------------

    def test_payload_fields_are_scrubbed_and_never_reach_the_json(self):
        with tempfile.TemporaryDirectory() as temp_value:
            source = self.make_source(Path(temp_value))
            census, _ = self.build(source)
        payload = json.dumps(census, sort_keys=True)
        for needle in (
            "m_VertexData",
            "m_IndexBuffer",
            "m_Normals",
            "m_UV0",
            "m_Skin",
            "m_CompressedMesh",
            "m_StreamData",
            "m_ShaderKeywords",
            "image data",
            "_NORMALMAP",
            ".resS",
            "CAB-secret",
        ):
            self.assertNotIn(needle, payload, needle)
        self.assertGreater(census["diagnostics"]["droppedForbiddenFieldCount"], 0)

    def test_forbidden_object_types_are_never_parsed(self):
        with tempfile.TemporaryDirectory() as temp_value:
            source = self.make_source(Path(temp_value))
            environments, forbidden = representative_environments()
            self.build(source, environments)
        self.assertEqual([reader.parse_calls for reader in forbidden], [0, 0, 0, 0])

    def test_oversized_remaining_type_is_skipped_before_parse(self):
        with tempfile.TemporaryDirectory() as temp_value:
            source = self.make_source(Path(temp_value))
            environments, _ = representative_environments()
            oversized = next(
                reader
                for reader in environments[SHARED_NAME]
                if reader.type.name == "Material" and reader.path_id == 70
            )
            oversized.byte_size = census_module.MAX_PARSED_OBJECT_BYTES + 1
            census, _ = self.build(source, environments)
        self.assertEqual(oversized.parse_calls, 0)
        record = next(
            item
            for item in census["diagnostics"]["skippedObjects"]
            if item["pathId"] == 70
        )
        self.assertEqual(record["reason"], "serialized-object-too-large")
        self.assertEqual(
            record["serializedByteSize"], census_module.MAX_PARSED_OBJECT_BYTES + 1
        )
        self.assertFalse(census["complete"])

    def test_unknown_serialized_size_is_skipped_before_parse(self):
        with tempfile.TemporaryDirectory() as temp_value:
            source = self.make_source(Path(temp_value))
            environments, _ = representative_environments()
            unknown = next(
                reader
                for reader in environments[SHARED_NAME]
                if reader.type.name == "Light"
            )
            del unknown.byte_size
            census, _ = self.build(source, environments)
        self.assertEqual(unknown.parse_calls, 0)
        record = next(
            item
            for item in census["diagnostics"]["skippedObjects"]
            if item["pathId"] == unknown.path_id
        )
        self.assertEqual(record["reason"], "serialized-object-size-unavailable")

    def test_build_settings_size_gate_fails_before_catalog_parse(self):
        with tempfile.TemporaryDirectory() as temp_value:
            source = self.make_source(Path(temp_value))
            reader = build_settings_reader()
            del reader.byte_size
            fake = FakeUnityPy({"globalgamemanagers": [reader]})
            catalog = census_module.load_build_settings_catalog(
                source, census_module.discover_catalog_files(source), fake
            )
        self.assertEqual(reader.parse_calls, 0)
        self.assertFalse(catalog["complete"])
        self.assertEqual(catalog["buildSettings"], [])
        self.assertEqual(
            catalog["skippedObjects"][0]["reason"],
            "serialized-object-size-unavailable",
        )

    def test_absolute_build_settings_scene_path_is_rejected_without_disclosure(self):
        with tempfile.TemporaryDirectory() as temp_value:
            source = self.make_source(Path(temp_value))
            leaked = r"C:\Program Files\Battlestate Games\Locations\Custom\X.unity"
            reader = FakeReader(
                "BuildSettings",
                1,
                {"scenes": [leaked]},
                asset_name="globalgamemanagers",
            )
            catalog = census_module.load_build_settings_catalog(
                source,
                census_module.discover_catalog_files(source),
                FakeUnityPy({"globalgamemanagers": [reader]}),
            )
        payload = json.dumps(catalog)
        self.assertFalse(catalog["complete"])
        self.assertEqual(catalog["sceneCatalog"], [])
        self.assertNotIn("Program Files", payload)
        self.assertNotIn("Battlestate", payload)

    def test_unapproved_output_field_fails_closed(self):
        with self.assertRaises(census_module.CensusError) as raised:
            census_module.assert_bounded_payload({"meshes": [{"m_Vertices": [1, 2, 3]}]})
        self.assertIn("m_Vertices", str(raised.exception))

    def test_bulk_scalar_array_fails_closed(self):
        with self.assertRaises(census_module.CensusError) as raised:
            census_module.assert_bounded_payload(
                {"meshes": {"vertexCount": list(range(4096))}}
            )
        self.assertIn("exceeds the census bound", str(raised.exception))

    def test_binary_payload_fails_closed(self):
        with self.assertRaises(census_module.CensusError):
            census_module.assert_bounded_payload({"textures": b"\x00\x01"})

    # -- audit report -------------------------------------------------------

    def test_audit_report_ranks_repeated_families_without_payloads(self):
        with tempfile.TemporaryDirectory() as temp_value:
            source = self.make_source(Path(temp_value))
            census, _ = self.build(source)
        report = census_module.build_audit_report(census)

        self.assertEqual(report["rankedBy"], "instanceCount")
        self.assertEqual(report["totals"]["rendererCount"], 3)
        top = report["families"][0]
        self.assertEqual(top["normalizedName"], "barrier_concrete")
        self.assertEqual(top["instanceCount"], 2)
        self.assertEqual(top["materialSlotCount"], 1)
        self.assertNotIn("submeshCount", top)
        self.assertNotIn("boundsExtents", top)
        self.assertEqual(top["sceneIndices"], [CUSTOMS_INDEX])
        self.assertEqual(
            top["exampleHierarchyPaths"],
            ["Customs/Barrier_Concrete", "Customs/Barrier_Concrete (1)"],
        )
        self.assertEqual(report["totals"]["repeatedFamilyCount"], 1)
        self.assertEqual(report["totals"]["repeatedInstanceCount"], 2)
        self.assertEqual(report["coverage"]["renderersWithResolvedMesh"], 0)
        self.assertEqual(report["coverage"]["renderersWithoutResolvedMesh"], 3)
        self.assertNotIn("m_Vertices", json.dumps(report))

    def test_audit_report_family_key_is_stable_across_runs(self):
        with tempfile.TemporaryDirectory() as temp_value:
            source = self.make_source(Path(temp_value))
            first, _ = self.build(source, representative_environments()[0])
            second, _ = self.build(source, representative_environments()[0])
        self.assertEqual(
            json.dumps(census_module.build_audit_report(first), sort_keys=True),
            json.dumps(census_module.build_audit_report(second), sort_keys=True),
        )

    # -- CLI guards ---------------------------------------------------------

    def test_acknowledgement_gate_runs_before_source_access(self):
        with tempfile.TemporaryDirectory() as temp_value:
            output = Path(temp_value) / "never-created.json"
            code, _, stderr = self.run_main(
                ["--source", "/definitely/not/a/game", "--output", str(output)]
            )
        self.assertEqual(code, 2)
        self.assertIn("--acknowledge-local-game-files", stderr)
        self.assertFalse(output.exists())

    def test_dry_run_catalogs_without_importing_unitypy_or_writing(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            output = base / "census.json"
            report = base / "report.json"
            fake = FakeUnityPy(errors={"globalgamemanagers": AssertionError("must not load")})
            code, stdout, stderr = self.run_main(
                [
                    "--source",
                    str(source),
                    "--output",
                    str(output),
                    "--report",
                    str(report),
                    "--acknowledge-local-game-files",
                    "--dry-run",
                ],
                fake,
            )
            plan = json.loads(stdout)
            self.assertEqual(code, 0, stderr)
            self.assertTrue(plan["dryRun"])
            self.assertFalse(plan["wouldWrite"])
            self.assertEqual(plan["catalogFiles"], ["globalgamemanagers"])
            self.assertIn("Mesh", plan["censusObjectTypes"])
            self.assertEqual(fake.load_calls, [])
            self.assertFalse(output.exists())
            self.assertFalse(report.exists())

    def test_dry_run_does_not_import_unitypy_module(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            output = base / "census.json"
            imported = []
            original = census_module.selector._import_unitypy
            census_module.selector._import_unitypy = lambda: imported.append(True)
            try:
                code, _, stderr = self.run_main(
                    [
                        "--source",
                        str(source),
                        "--output",
                        str(output),
                        "--acknowledge-local-game-files",
                        "--dry-run",
                    ]
                )
            finally:
                census_module.selector._import_unitypy = original
            self.assertEqual(code, 0, stderr)
            self.assertEqual(imported, [])

    def test_output_inside_source_is_refused_without_loading(self):
        with tempfile.TemporaryDirectory() as temp_value:
            source = self.make_source(Path(temp_value))
            output = source / "census.json"
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

    def test_report_inside_source_is_refused(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            fake = FakeUnityPy(representative_environments()[0])
            code, _, stderr = self.run_main(
                [
                    "--source",
                    str(source),
                    "--output",
                    str(base / "census.json"),
                    "--report",
                    str(source / "report.json"),
                    "--acknowledge-local-game-files",
                ],
                fake,
            )
            self.assertEqual(code, 2)
            self.assertIn("outside", stderr)
            self.assertEqual(fake.load_calls, [])
            self.assertFalse((base / "census.json").exists())

    def test_missing_output_parent_directory_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            code, _, stderr = self.run_main(
                [
                    "--source",
                    str(source),
                    "--output",
                    str(base / "absent" / "census.json"),
                    "--acknowledge-local-game-files",
                ],
                FakeUnityPy(representative_environments()[0]),
            )
        self.assertEqual(code, 2)
        self.assertIn("parent directory", stderr)

    def test_existing_outputs_are_never_replaced(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            output = base / "census.json"
            report = base / "report.json"
            report.write_text("keep-me", encoding="utf-8")
            arguments = [
                "--source",
                str(source),
                "--output",
                str(output),
                "--report",
                str(report),
                "--acknowledge-local-game-files",
            ]
            code, _, stderr = self.run_main(
                arguments, FakeUnityPy(representative_environments()[0])
            )
            self.assertEqual(code, 2)
            self.assertIn("choose a new output path", stderr)
            self.assertEqual(report.read_text(encoding="utf-8"), "keep-me")
            self.assertFalse(output.exists())

            output = base / "fresh-census.json"
            report = base / "fresh-report.json"
            arguments[3] = str(output)
            arguments[5] = str(report)
            code, stdout, stderr = self.run_main(
                arguments + ["--allow-partial"],
                FakeUnityPy(representative_environments()[0]),
            )
            self.assertEqual(code, 0, stderr)
            self.assertEqual(
                json.loads(output.read_text(encoding="utf-8"))["schemaVersion"],
                census_module.CENSUS_SCHEMA_VERSION,
            )
            self.assertEqual(
                json.loads(report.read_text(encoding="utf-8"))["rankedBy"], "instanceCount"
            )
            self.assertIn("repeated families", stdout)

    def test_payload_skips_require_explicit_allow_partial(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            output = base / "census.json"
            arguments = [
                "--source",
                str(source),
                "--output",
                str(output),
                "--acknowledge-local-game-files",
            ]
            code, _, stderr = self.run_main(
                arguments, FakeUnityPy(representative_environments()[0])
            )
            self.assertEqual(code, 2)
            self.assertIn("3 safe skips", stderr)
            self.assertFalse(output.exists())

            code, _, stderr = self.run_main(
                arguments + ["--allow-partial"],
                FakeUnityPy(representative_environments()[0]),
            )
            self.assertEqual(code, 0, stderr)
            census = json.loads(output.read_text(encoding="utf-8"))
            self.assertFalse(census["complete"])
            self.assertEqual(census["counts"]["skippedObjects"], 3)

    def test_atomic_publication_loses_race_without_clobbering_or_partial_pair(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            output = base / "census.json"
            report = base / "report.json"
            original_link = census_module.os.link
            calls = []

            def racing_link(source, destination):
                calls.append(Path(destination))
                if len(calls) == 2:
                    Path(destination).write_text("race-winner", encoding="utf-8")
                return original_link(source, destination)

            census_module.os.link = racing_link
            try:
                with self.assertRaises(census_module.CensusError):
                    census_module._publish_json_noclobber(
                        [(output, {"complete": False}), (report, {"complete": False})]
                    )
            finally:
                census_module.os.link = original_link
            self.assertEqual(output.read_text(encoding="utf-8"), "race-winner")
            self.assertFalse(report.exists())
            self.assertEqual(list(base.glob(".*.tmp")), [])

    def test_force_option_is_not_available(self):
        self.assertNotIn("--force", census_module._parser().format_help())

    def test_partial_census_fails_closed_unless_explicitly_allowed(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            output = base / "census.json"
            arguments = [
                "--source",
                str(source),
                "--output",
                str(output),
                "--acknowledge-local-game-files",
            ]
            failing = FakeUnityPy(
                representative_environments()[0],
                {LEVEL_NAME: ValueError("synthetic load failure")},
            )
            code, _, stderr = self.run_main(arguments, failing)
            self.assertEqual(code, 2)
            self.assertIn("census is incomplete", stderr)
            self.assertFalse(output.exists())

            code, _, stderr = self.run_main(arguments + ["--allow-partial"], failing)
            self.assertEqual(code, 0, stderr)
            census = json.loads(output.read_text(encoding="utf-8"))
            self.assertFalse(census["complete"])
            self.assertEqual(
                census["diagnostics"]["fileLoadFailures"],
                [
                    {
                        "errorType": "ValueError",
                        "file": LEVEL_NAME,
                        "phase": "scene",
                        "sceneIndex": CUSTOMS_INDEX,
                    }
                ],
            )

    def test_only_the_two_stage_selection_is_ever_opened(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            unrelated = (
                "a.bundle",
                "level2",
                "sharedassets2.assets",
                "resources.assets",
                "terrain.resS",
                "resources.resource",
                "Assembly-CSharp.dll",
                "EscapeFromTarkov.exe",
                "globalgamemanagers.assets",
            )
            source = self.make_source(base, extra_names=unrelated)
            fake = FakeUnityPy(
                representative_environments()[0],
                {name: AssertionError(f"must not load {name}") for name in unrelated},
            )
            output = base / "census.json"
            code, _, stderr = self.run_main(
                [
                    "--source",
                    str(source),
                    "--output",
                    str(output),
                    "--acknowledge-local-game-files",
                    "--allow-partial",
                ],
                fake,
            )
            self.assertEqual(code, 0, stderr)
            self.assertEqual(
                fake.load_calls, ["globalgamemanagers", LEVEL_NAME, SHARED_NAME]
            )

    def test_unity_load_uses_safe_stream_and_disables_all_dependency_methods(self):
        with tempfile.TemporaryDirectory() as temp_value:
            source = self.make_source(Path(temp_value))
            census, fake = self.build(source)
            self.assertFalse(census["complete"])
            self.assertEqual(
                fake.stream_facts,
                [
                    {"name": "globalgamemanagers", "path": ""},
                    {"name": LEVEL_NAME, "path": ""},
                    {"name": SHARED_NAME, "path": ""},
                ],
            )
            for stream in fake.load_inputs:
                self.assertNotIn(temp_value, repr(stream))
                self.assertNotIn(str(source), repr(stream))
            for environment in fake.returned_environments:
                for method_name in census_module.DEPENDENCY_LOADING_METHODS:
                    with self.assertRaises(census_module.CensusError):
                        getattr(environment, method_name)("forbidden")

    def test_output_is_deterministic_and_leaks_no_absolute_source_path(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            pairs = [
                (base / "one.json", base / "one-report.json"),
                (base / "two.json", base / "two-report.json"),
            ]
            for output, report in pairs:
                code, _, stderr = self.run_main(
                    [
                        "--source",
                        str(source),
                        "--output",
                        str(output),
                        "--report",
                        str(report),
                        "--acknowledge-local-game-files",
                        "--allow-partial",
                    ],
                    FakeUnityPy(representative_environments()[0]),
                )
                self.assertEqual(code, 0, stderr)
            for first_path, second_path in zip(pairs[0], pairs[1]):
                first = first_path.read_text(encoding="utf-8")
                self.assertEqual(first, second_path.read_text(encoding="utf-8"))
                self.assertNotIn(str(source), first)
                self.assertNotIn(str(base), first)
                self.assertNotIn(temp_value, first)

    def test_report_path_must_differ_from_output(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            output = base / "census.json"
            code, _, stderr = self.run_main(
                [
                    "--source",
                    str(source),
                    "--output",
                    str(output),
                    "--report",
                    str(output),
                    "--acknowledge-local-game-files",
                ],
                FakeUnityPy(representative_environments()[0]),
            )
        self.assertEqual(code, 2)
        self.assertIn("must differ", stderr)

    # -- malformed hierarchies ---------------------------------------------

    def malformed_environments(self):
        readers = [
            game_object(10, "Root", components=(20,)),
            transform(20, 10, 0, vector3(0, 0, 0), scale=vector3(2, 1, 1)),
            game_object(11, "Child", components=(21,)),
            transform(21, 11, 20, vector3(1, 0, 0), quaternion(0, 0.7071067811865476, 0, 0.7071067811865476)),
            game_object(12, "Orphan", components=(22,)),
            transform(22, 12, 7777, vector3(5, 5, 5)),  # parent transform absent
            game_object(13, "CycleA", components=(23,)),
            transform(23, 13, 24, vector3(0, 0, 0)),
            game_object(14, "CycleB", components=(24,)),
            transform(24, 14, 23, vector3(0, 0, 0)),  # mutual parents
        ]
        return {
            "globalgamemanagers": [build_settings_reader()],
            LEVEL_NAME: [],
            SHARED_NAME: readers,
        }

    def test_cyclic_and_orphan_parents_fail_soft_without_recursing_forever(self):
        with tempfile.TemporaryDirectory() as temp_value:
            source = self.make_source(Path(temp_value))
            census, _ = self.build(source, self.malformed_environments())
        by_name = {item["name"]: item for item in census["gameObjects"]}
        for name in ("Orphan", "CycleA", "CycleB"):
            self.assertFalse(by_name[name]["hierarchyComplete"], name)
            self.assertNotIn("world", by_name[name], name)
        self.assertTrue(by_name["Root"]["hierarchyComplete"])
        self.assertTrue(by_name["Child"]["hierarchyComplete"])

    def test_world_transform_marks_non_uniform_scale_under_rotation_as_lossy(self):
        with tempfile.TemporaryDirectory() as temp_value:
            source = self.make_source(Path(temp_value))
            census, _ = self.build(source, self.malformed_environments())
        child = next(item for item in census["gameObjects"] if item["name"] == "Child")
        # Local (1,0,0) under a parent scaled (2,1,1) lands at (2,0,0).
        self.assertEqual(child["world"]["position"], {"x": 2.0, "y": 0.0, "z": 0.0})
        self.assertEqual(child["world"]["scale"], {"x": 2.0, "y": 1.0, "z": 1.0})
        self.assertFalse(child["world"]["worldExact"])

    def test_hierarchy_depth_is_capped_instead_of_exhausting_the_stack(self):
        depth = census_module.MAX_HIERARCHY_DEPTH + 40
        readers = [game_object(10, "Root", components=(1010,)), transform(1010, 10, 0, vector3(0, 0, 0))]
        for index in range(1, depth):
            readers.append(game_object(10 + index, f"Node{index}", components=(1010 + index,)))
            readers.append(
                transform(1010 + index, 10 + index, 1009 + index, vector3(0, 1, 0))
            )
        environments = {
            "globalgamemanagers": [build_settings_reader()],
            LEVEL_NAME: [],
            SHARED_NAME: readers,
        }
        with tempfile.TemporaryDirectory() as temp_value:
            source = self.make_source(Path(temp_value))
            census, _ = self.build(source, environments)
        deepest = next(
            item for item in census["gameObjects"] if item["name"] == f"Node{depth - 1}"
        )
        self.assertFalse(deepest["hierarchyComplete"])
        self.assertNotIn("world", deepest)
        shallow = next(item for item in census["gameObjects"] if item["name"] == "Node1")
        self.assertTrue(shallow["hierarchyComplete"])

    def test_dangling_internal_pointers_are_counted_not_invented(self):
        with tempfile.TemporaryDirectory() as temp_value:
            source = self.make_source(Path(temp_value))
            environments = self.malformed_environments()
            environments[SHARED_NAME] = environments[SHARED_NAME] + [
                mesh_renderer(41, 11, [70, 999]),  # 999 = material that does not exist
                material(70, "Mat", 12345),  # 12345 = texture that does not exist
            ]
            census, _ = self.build(source, environments)
        renderer = census["renderers"][0]
        self.assertEqual(renderer["materialSlotCount"], 2)
        # Slot-aligned: index 1 is the dangling slot, not a silently dropped one.
        self.assertEqual(renderer["materialNames"], ["Mat", None])
        self.assertIsNone(renderer["materialIds"][1])
        self.assertNotIn("meshId", renderer)
        # 2 material slots (one dangling) + the material's own _MainTex pointer.
        self.assertEqual(census["references"]["internalPointerCount"], 3)
        self.assertEqual(census["references"]["resolvedPointerCount"], 1)
        self.assertEqual(census["references"]["unresolvedInternalPointerCount"], 2)
        # _BumpMap points at fileId 3, outside the selection.
        self.assertEqual(census["references"]["externalPointerCount"], 0)
        dangling = next(
            item
            for item in census["materials"][0]["textureProperties"]
            if item["name"] == "_MainTex"
        )
        self.assertNotIn("textureName", dangling)
        self.assertNotIn("external", dangling)

    # -- cross-file references ----------------------------------------------

    def split_file_environments(self):
        """The realistic layout: scene graph in levelN, assets in sharedassetsN."""

        def in_level(reader):
            reader.assets_file = SimpleNamespace(
                name=LEVEL_NAME, externals=[{"path": SHARED_NAME}]
            )
            return reader

        level_readers = [
            in_level(game_object(10, "Root", components=(20,))),
            in_level(transform(20, 10, 0, vector3(0, 0, 0))),
            in_level(game_object(11, "Barrier_Concrete", components=(21, 31, 41))),
            in_level(transform(21, 11, 20, vector3(3, 0, 4))),
            # fileId 1 -> externals[0] -> sharedassets637.assets
            in_level(
                FakeReader(
                    "MeshFilter",
                    31,
                    {"m_GameObject": pointer(11), "m_Mesh": pointer(60, file_id=1)},
                )
            ),
            in_level(
                FakeReader(
                    "MeshRenderer",
                    41,
                    {
                        "m_GameObject": pointer(11),
                        "m_Enabled": 1,
                        "m_Materials": [pointer(70, file_id=1)],
                    },
                )
            ),
        ]
        shared_readers = [mesh(60, "Barrier_Concrete_LOD0"), material(70, "Mat", 80), texture(80, "albedo")]
        return {
            "globalgamemanagers": [build_settings_reader()],
            LEVEL_NAME: level_readers,
            SHARED_NAME: shared_readers,
        }

    def test_cross_file_pointers_resolve_through_the_external_reference_table(self):
        with tempfile.TemporaryDirectory() as temp_value:
            source = self.make_source(Path(temp_value))
            census, _ = self.build(source, self.split_file_environments())
        renderer = census["renderers"][0]
        # Material identity resolves across the exact external path. Mesh and
        # texture payload-bearing objects remain intentionally unparsed.
        self.assertNotIn("meshName", renderer)
        self.assertEqual(renderer["materialNames"], ["Mat"])
        self.assertEqual(census["references"]["resolvedPointerCount"], 1)
        self.assertEqual(census["references"]["unresolvedInternalPointerCount"], 2)
        report = census_module.build_audit_report(census)
        self.assertEqual(report["coverage"]["renderersWithResolvedMesh"], 0)
        self.assertEqual(report["coverage"]["renderersWithoutResolvedMesh"], 1)

    def test_resolver_never_matches_an_authorized_file_by_basename(self):
        failures = []
        resolve = census_module._make_resolver(
            {
                "maps/customs/level637": [
                    {
                        "normalizedPath": "maps/customs/sharedassets637.assets",
                        "identityHash": "a" * 64,
                    }
                ]
            },
            {
                "maps/other/sharedassets637.assets": (
                    "maps/other/sharedassets637.assets"
                )
            },
            failures,
        )
        key, kind = resolve(
            "maps/customs/level637", {"fileId": 1, "pathId": 60}
        )
        self.assertIsNone(key)
        self.assertEqual(kind, "external")
        self.assertEqual(failures[0]["reason"], "external-dependency-denied")

    def test_missing_external_table_is_incomplete_even_without_external_pointer(self):
        with tempfile.TemporaryDirectory() as temp_value:
            source = self.make_source(Path(temp_value))
            environments, _ = representative_environments()
            del environments[LEVEL_NAME][0].assets_file.externals
            census, _ = self.build(source, environments)
        self.assertFalse(census["complete"])
        self.assertIn(
            "external-table-missing",
            {
                item["reason"]
                for item in census["diagnostics"]["dependencyFailures"]
            },
        )

    def test_inconsistent_external_tables_fail_closed(self):
        with tempfile.TemporaryDirectory() as temp_value:
            source = self.make_source(Path(temp_value))
            environments, _ = representative_environments()
            environments[SHARED_NAME][0].assets_file.externals = [
                {"path": "resources.assets"}
            ]
            census, _ = self.build(source, environments)
        self.assertIn(
            "external-table-inconsistent",
            {
                item["reason"]
                for item in census["diagnostics"]["dependencyFailures"]
            },
        )

    def test_absolute_external_identity_is_hashed_not_disclosed(self):
        leaked = r"C:\Program Files (x86)\Battlestate Games\EFT\resources.assets"
        reader = game_object(10, "Root")
        reader.assets_file.externals = [{"path": leaked}]
        identities, error = census_module._external_identities(
            [reader], "maps/customs/level637"
        )
        self.assertIsNone(error)
        self.assertIsNone(identities[0]["normalizedPath"])
        failures = []
        resolve = census_module._make_resolver(
            {"maps/customs/level637": identities}, {}, failures
        )
        self.assertEqual(
            resolve("maps/customs/level637", {"fileId": 1, "pathId": 1}),
            (None, "external"),
        )
        payload = json.dumps(failures)
        self.assertNotIn("Program Files", payload)
        self.assertNotIn("Battlestate", payload)
        self.assertEqual(failures[0]["reason"], "invalid-external-identity")

    def test_pointer_to_an_unauthorized_file_stays_external_and_unopened(self):
        with tempfile.TemporaryDirectory() as temp_value:
            source = self.make_source(Path(temp_value))
            environments = self.split_file_environments()
            # fileId 2 -> externals[1] -> a file outside the Customs selection.
            for reader in environments[LEVEL_NAME]:
                reader.assets_file = SimpleNamespace(
                    name=LEVEL_NAME,
                    externals=[{"path": SHARED_NAME}, {"path": "resources.assets"}],
                )
                if reader.type.name == "MeshFilter":
                    reader._data["m_Mesh"] = pointer(60, file_id=2)
            census, fake = self.build(source, environments)
        renderer = census["renderers"][0]
        self.assertNotIn("meshName", renderer)
        self.assertEqual(census["references"]["externalPointerCount"], 1)
        self.assertEqual(
            census["diagnostics"]["dependencyFailures"][0]["reason"],
            "external-dependency-denied",
        )
        self.assertEqual(
            fake.load_calls, ["globalgamemanagers", LEVEL_NAME, SHARED_NAME]
        )

    def test_null_material_slot_is_not_counted_as_a_dangling_reference(self):
        with tempfile.TemporaryDirectory() as temp_value:
            source = self.make_source(Path(temp_value))
            environments = self.split_file_environments()
            for reader in environments[LEVEL_NAME]:
                if reader.type.name == "MeshRenderer":
                    reader._data["m_Materials"] = [pointer(70, file_id=1), pointer(0)]
            census, _ = self.build(source, environments)
        renderer = census["renderers"][0]
        self.assertEqual(renderer["materialSlotCount"], 2)
        self.assertEqual(renderer["materialNames"], ["Mat", None])
        # The empty slot is not a reference at all, so it is not "unresolved".
        # Mesh and texture objects are safe-skipped, so those two valid pointers
        # remain unresolved even though the null slot adds no third failure.
        self.assertEqual(census["references"]["unresolvedInternalPointerCount"], 2)

    def test_self_reported_absolute_container_path_never_reaches_the_output(self):
        with tempfile.TemporaryDirectory() as temp_value:
            source = self.make_source(Path(temp_value))
            environments = self.split_file_environments()
            leaked = r"C:\Program Files (x86)\Battlestate Games\EFT\EscapeFromTarkov_Data"
            for reader in environments[LEVEL_NAME]:
                reader.assets_file = SimpleNamespace(
                    name=LEVEL_NAME,
                    path=f"{leaked}\\{LEVEL_NAME}",
                    externals=[{"path": SHARED_NAME}],
                )
            census, _ = self.build(source, environments)
        payload = json.dumps(census)
        self.assertNotIn("Program Files", payload)
        self.assertNotIn("Battlestate", payload)
        self.assertNotIn("C:/", payload)
        self.assertEqual(census["renderers"][0]["asset"], LEVEL_NAME)

    # -- source binding and diagnostic sanitization ------------------------

    def test_scene_change_during_read_is_rejected_and_records_are_discarded(self):
        with tempfile.TemporaryDirectory() as temp_value:
            source = self.make_source(Path(temp_value))
            environments = representative_environments()[0]

            def mutate(_stream, name):
                if name == LEVEL_NAME:
                    (source / name).write_bytes(b"UnityFS\x00changed-during-read")

            fake = FakeUnityPy(environments, on_load=mutate)
            catalog_files = census_module.discover_catalog_files(source)
            catalog = census_module.load_build_settings_catalog(
                source, catalog_files, fake
            )
            scene_files = census_module.discover_customs_scene_files(
                source, catalog["sceneCatalog"]
            )
            census = census_module.build_census(
                source, catalog, scene_files, fake
            )
        level_fact = next(
            item
            for item in census["source"]["sceneFiles"]
            if item["role"] == "level"
        )
        self.assertFalse(level_fact["bindingVerified"])
        self.assertFalse(level_fact["digestComplete"])
        self.assertEqual(census["source"]["loadedSceneFileCount"], 1)
        self.assertNotIn(
            "SceneRoot", {item.get("name") for item in census["gameObjects"]}
        )
        self.assertIn(
            "source-changed-during-read",
            {item.get("reason") for item in census["diagnostics"]["fileLoadFailures"]},
        )

    def test_catalog_change_during_read_discards_catalog_and_blocks_selection(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)

            def mutate(_stream, name):
                if name == "globalgamemanagers":
                    (source / name).write_bytes(b"UnityFS\x00changed-catalog")

            fake = FakeUnityPy(representative_environments()[0], on_load=mutate)
            catalog = census_module.load_build_settings_catalog(
                source, census_module.discover_catalog_files(source), fake
            )
            self.assertFalse(catalog["complete"])
            self.assertEqual(catalog["loadedFileCount"], 0)
            self.assertEqual(catalog["buildSettings"], [])
            self.assertFalse(catalog["catalogFileFacts"][0]["bindingVerified"])

            output = base / "census.json"
            code, _, stderr = self.run_main(
                [
                    "--source",
                    str(source),
                    "--output",
                    str(output),
                    "--acknowledge-local-game-files",
                    "--allow-partial",
                ],
                FakeUnityPy(representative_environments()[0], on_load=mutate),
            )
            self.assertEqual(code, 2)
            self.assertFalse(output.exists())
            self.assertNotIn(str(source), stderr)

    def test_exception_messages_and_absolute_paths_never_enter_diagnostics(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            output = base / "census.json"
            leaked = r"C:\Program Files (x86)\Battlestate Games\EFT\secret"
            fake = FakeUnityPy(
                representative_environments()[0],
                errors={LEVEL_NAME: ValueError(leaked)},
            )
            code, _, stderr = self.run_main(
                [
                    "--source",
                    str(source),
                    "--output",
                    str(output),
                    "--acknowledge-local-game-files",
                    "--allow-partial",
                ],
                fake,
            )
            self.assertEqual(code, 0, stderr)
            payload = output.read_text(encoding="utf-8")
            self.assertNotIn("Program Files", payload)
            self.assertNotIn("Battlestate", payload)
            self.assertNotIn(leaked, payload)
            self.assertEqual(
                json.loads(payload)["diagnostics"]["fileLoadFailures"][0][
                    "errorType"
                ],
                "ValueError",
            )

    def test_static_batch_reports_participation_not_field_presence(self):
        self.assertIsNone(census_module._static_batch_fact(None))
        self.assertIsNone(census_module._static_batch_fact({"firstSubMesh": 0}))
        self.assertFalse(
            census_module._static_batch_fact({"firstSubMesh": 0, "subMeshCount": 0})
        )
        self.assertTrue(
            census_module._static_batch_fact({"firstSubMesh": 4, "subMeshCount": 2})
        )

    def test_normalized_name_folds_instance_suffixes_only(self):
        cases = {
            "Barrier_Concrete (1)": "barrier_concrete",
            "Barrier_Concrete (Clone)": "barrier_concrete",
            "Barrier_Concrete_12": "barrier_concrete",
            "Barrier_Concrete (1) (Clone)": "barrier_concrete",
            "LOD0": "lod0",
            "Wall2x4": "wall2x4",
        }
        for raw, expected in cases.items():
            self.assertEqual(census_module.normalized_name(raw), expected, raw)


if __name__ == "__main__":
    unittest.main()
