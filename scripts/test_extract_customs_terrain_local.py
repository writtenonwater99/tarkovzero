#!/usr/bin/env python3
"""Synthetic, no-game-file tests for the local Customs terrain extractor."""

from __future__ import annotations

import importlib.util
import io
import json
import math
import struct
import tempfile
import unittest
import zlib
from pathlib import Path
from types import SimpleNamespace


SCRIPT_PATH = Path(__file__).with_name("extract-customs-terrain-local.py")
SPEC = importlib.util.spec_from_file_location("extract_customs_terrain_local", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
extractor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(extractor)


def obj(**values):
    return SimpleNamespace(**values)


def vector3(x, y, z):
    return obj(x=x, y=y, z=z)


def quaternion(x=0.0, y=0.0, z=0.0, w=1.0):
    return obj(x=x, y=y, z=z, w=w)


class FakePointer:
    _next_path_id = 1000

    def __init__(self, target, *, type_name=""):
        self.target = target
        self.path_id = FakePointer._next_path_id
        FakePointer._next_path_id += 1
        self.type = obj(name=type_name) if type_name else None
        self.read_calls = 0

    def read(self):
        self.read_calls += 1
        if isinstance(self.target, BaseException):
            raise self.target
        return self.target


class NullPointer:
    path_id = 0

    def read(self):  # pragma: no cover - the extractor must short-circuit nulls.
        raise AssertionError("null pointer must not be read")


class FakeReader:
    def __init__(self, type_name, value, *, fail_if_read=False):
        self.type = obj(name=type_name)
        self.value = value
        self.fail_if_read = fail_if_read
        self.read_calls = 0
        self.parse_calls = 0

    def read(self):
        self.read_calls += 1
        if self.fail_if_read:
            raise AssertionError(f"{self.type.name} must never be read")
        return self.value

    def parse_as_dict(self):
        self.parse_calls += 1
        if self.fail_if_read:
            raise AssertionError(f"{self.type.name} must never be parsed")
        return self.value


class FakeImage:
    def __init__(self, width, height, rgba):
        self.width = width
        self.height = height
        self.size = (width, height)
        self.rgba = rgba

    def convert(self, mode):
        if mode != "RGBA":
            raise AssertionError("only RGBA conversion is allowed")
        return self

    def tobytes(self):
        return self.rgba


class FakeTexture:
    def __init__(self, name, width=2, height=2, seed=0):
        self.m_Name = name
        self.payload_marker = f"ORIGINAL-{name}-PBR-PAYLOAD".encode()
        self.image_calls = []
        pixels = []
        for index in range(width * height):
            pixels.extend(((seed + index) % 256, index, 255 - index, 255))
        self._image = FakeImage(width, height, bytes(pixels))

    def get_image(self, *, flip):
        self.image_calls.append(flip)
        if flip is not False:
            raise AssertionError("control extraction must request canonical unflipped rows")
        return self._image


class FakeUnityPy:
    __version__ = "synthetic-test"

    def __init__(self, catalog_environment, terrain_environment):
        self.catalog_environment = catalog_environment
        self.terrain_environment = terrain_environment
        self.load_calls = []

    def load(self, *paths):
        names = tuple(Path(path).name for path in paths)
        self.load_calls.append(names)
        if names == ("globalgamemanagers",):
            return self.catalog_environment
        if len(names) == 2 and names[0].startswith("level") and names[1].startswith(
            "sharedassets"
        ):
            return self.terrain_environment
        raise AssertionError(f"unexpected UnityPy load: {names}")


def make_transform(position, parent=None, rotation=None, scale=None):
    return obj(
        m_LocalPosition=vector3(*position),
        m_LocalRotation=rotation or quaternion(),
        m_LocalScale=scale or vector3(1, 1, 1),
        m_Father=FakePointer(parent, type_name="Transform") if parent else NullPointer(),
    )


def png_rgba_payload(payload):
    """Return (width, height, raw scanlines) for our filter-0 RGBA PNG."""
    assert payload.startswith(b"\x89PNG\r\n\x1a\n")
    offset = 8
    width = height = None
    compressed = bytearray()
    while offset < len(payload):
        length = struct.unpack(">I", payload[offset : offset + 4])[0]
        kind = payload[offset + 4 : offset + 8]
        data = payload[offset + 8 : offset + 8 + length]
        offset += 12 + length
        if kind == b"IHDR":
            width, height = struct.unpack(">II", data[:8])
        elif kind == b"IDAT":
            compressed.extend(data)
        elif kind == b"IEND":
            break
    assert width is not None and height is not None
    decoded = zlib.decompress(bytes(compressed))
    stride = width * 4
    rows = []
    cursor = 0
    for _ in range(height):
        assert decoded[cursor] == 0
        cursor += 1
        rows.append(decoded[cursor : cursor + stride])
        cursor += stride
    return width, height, b"".join(rows)


class TerrainFixture:
    scene_index = 42
    scene_path = "Assets/Scenes/Locations/Custom/custom_Terrain.unity"

    def __init__(self, source):
        self.source = source
        for name in (
            "globalgamemanagers",
            "globalgamemanagers.assets",
            f"level{self.scene_index}",
            f"sharedassets{self.scene_index}.assets",
            "level99",
            "sharedassets99.assets",
            "customs_preset.bundle",
            "EscapeFromTarkov.exe",
        ):
            (source / name).write_bytes(f"synthetic:{name}".encode())

        self.catalog_reader = FakeReader(
            "BuildSettings",
            {
                "scenes": [
                    "Assets/Scenes/Menu.unity",
                    "Assets/Scenes/Locations/Custom/custom_AI.unity",
                    *[
                        f"Assets/Scenes/Synthetic/scene-{index}.unity"
                        for index in range(2, self.scene_index)
                    ],
                    self.scene_path,
                    "Assets/Scenes/Locations/Woods/woods_Terrain.unity",
                ]
            },
        )
        self.catalog_unrelated = FakeReader("Texture2D", RuntimeError(), fail_if_read=True)

        self.root_transform = make_transform((100.0, 5.0, -30.0))
        self.control_textures = []
        self.pbr_pointers = []
        self.terrain_readers = []
        self.expected_origins = []
        raw_sets = (
            [-32768, 0, 16384, 32767],
            [0, 1, 2, 3],
        )
        for tile_index, (local_position, raw_heights) in enumerate(
            (((0.0, 2.0, 0.0), raw_sets[0]), ((10.0, 4.0, 0.0), raw_sets[1]))
        ):
            transform = make_transform(local_position, self.root_transform)
            game_object = obj(
                m_Name=f"Synthetic Terrain {tile_index}",
                m_Component=[FakePointer(transform, type_name="Transform")],
            )
            controls = [
                FakeTexture(f"control-{tile_index}-{control_index}", seed=control_index * 10)
                for control_index in range(3)
            ]
            self.control_textures.extend(controls)
            layers = []
            for layer_index in range(7):
                diffuse = FakePointer(FakeTexture(f"diffuse-{tile_index}-{layer_index}"))
                normal = FakePointer(FakeTexture(f"normal-{tile_index}-{layer_index}"))
                self.pbr_pointers.extend((diffuse, normal))
                layers.append(
                    obj(
                        m_Name=f"Surface {tile_index}-{layer_index}",
                        m_DiffuseTexture=diffuse,
                        m_NormalMapTexture=normal,
                        m_MeshPayload=b"ORIGINAL-MESH-PAYLOAD",
                    )
                )
            prototype_prefab = obj(m_Name="Scots Pine")
            tree_database = obj(
                m_TreePrototypes=[
                    obj(
                        m_Prefab=FakePointer(prototype_prefab),
                        m_BendFactor=0.25,
                        m_NavMeshLod=1,
                    )
                ],
                m_TreeInstances=[
                    obj(
                        # Unity 2022's generated TreeInstance uses index.
                        index=0,
                        position=vector3(0.25, 0.5, 0.75),
                        widthScale=1.2,
                        heightScale=0.9,
                        rotation=math.pi / 3,
                        color=obj(r=200, g=201, b=202, a=255),
                    )
                ],
            )
            terrain_data = obj(
                m_Name=f"Slice_{tile_index}",
                m_Heightmap=obj(
                    m_Resolution=2,
                    m_Scale=vector3(10.0, 20.0, 20.0),
                    m_Heights=raw_heights,
                ),
                m_Size=vector3(10.0, 20.0, 20.0),
                m_SplatDatabase=obj(
                    # Unity 2022's TerrainData SplatDatabase uses m_AlphaTextures.
                    m_AlphaTextures=[FakePointer(texture) for texture in controls],
                    m_TerrainLayers=[FakePointer(layer) for layer in layers],
                ),
                # Unity 2022 nests terrain tree/plant data in DetailDatabase.
                m_DetailDatabase=tree_database,
                m_OriginalDiffusePayload=b"DO-NOT-EXPORT-DIFFUSE",
                m_OriginalNormalPayload=b"DO-NOT-EXPORT-NORMAL",
            )
            terrain = obj(
                m_GameObject=FakePointer(game_object),
                m_TerrainData=FakePointer(terrain_data),
            )
            self.terrain_readers.append(FakeReader("Terrain", terrain))
            self.expected_origins.append(
                (
                    100.0 + local_position[0],
                    5.0 + local_position[1],
                    -30.0 + local_position[2],
                )
            )

        self.mesh_reader = FakeReader("Mesh", RuntimeError(), fail_if_read=True)
        self.material_reader = FakeReader("Material", RuntimeError(), fail_if_read=True)
        catalog_environment = obj(objects=[self.catalog_unrelated, self.catalog_reader])
        terrain_environment = obj(
            objects=[self.mesh_reader, self.terrain_readers[1], self.material_reader, self.terrain_readers[0]]
        )
        self.unitypy = FakeUnityPy(catalog_environment, terrain_environment)


class ExtractCustomsTerrainLocalTests(unittest.TestCase):
    def make_source(self, base):
        source = base / "synthetic-game-data"
        source.mkdir()
        return source

    def run_main(self, arguments, unitypy):
        stdout = io.StringIO()
        stderr = io.StringIO()
        code = extractor.main(
            arguments,
            unitypy_module=unitypy,
            stdout=stdout,
            stderr=stderr,
        )
        return code, stdout.getvalue(), stderr.getvalue()

    def test_exact_decoding_two_tile_world_placement_controls_and_trees(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = self.make_source(base)
            fixture = TerrainFixture(source)
            output = base / "local-terrain-package"
            code, _, stderr = self.run_main(
                [
                    "--source",
                    str(source),
                    "--output-dir",
                    str(output),
                    "--acknowledge-local-game-files",
                ],
                fixture.unitypy,
            )
            self.assertEqual(code, 0, stderr)

            manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["schemaVersion"], 1)
            self.assertEqual(manifest["map"], "customs")
            self.assertTrue(manifest["localOnly"])
            self.assertEqual(manifest["sourceFrame"], "eft-unity-world-metres-y-up")
            self.assertEqual(manifest["reliefOriginYM"], 0.0)
            self.assertEqual(
                set(manifest),
                {"schemaVersion", "map", "localOnly", "sourceFrame", "reliefOriginYM", "tiles"},
            )
            report = json.loads(
                (output / "extraction-report.json").read_text(encoding="utf-8")
            )
            self.assertEqual(report["source"]["terrainSceneIndex"], 42)
            self.assertEqual(
                report["source"]["loadedFiles"], ["level42", "sharedassets42.assets"]
            )
            self.assertEqual(
                [tile["name"] for tile in report["tiles"]], ["Slice_0", "Slice_1"]
            )
            self.assertNotEqual(
                report["tiles"][0]["heightSha256"], report["tiles"][1]["heightSha256"]
            )
            self.assertEqual(len(manifest["tiles"]), 2)

            # Tiles are deterministically sorted by world z/x, not reader order.
            first, second = manifest["tiles"]
            self.assertEqual(
                set(first),
                {
                    "id",
                    "origin",
                    "resolution",
                    "sampleSpacingM",
                    "heightEncoding",
                    "heightFile",
                    "controlMaps",
                    "layers",
                    "vegetation",
                },
            )
            self.assertEqual(
                set(first["heightEncoding"]),
                {"storage", "endianness", "scalarType", "sampleOrder", "values"},
            )
            self.assertEqual(first["origin"], {"x": 100.0, "y": 7.0, "z": -30.0})
            self.assertEqual(second["origin"], {"x": 110.0, "y": 9.0, "z": -30.0})
            self.assertEqual(first["resolution"], {"columns": 2, "rows": 2})
            self.assertEqual(first["sampleSpacingM"], {"x": 10.0, "z": 20.0})
            self.assertEqual(
                first["heightEncoding"]["sampleOrder"],
                "row-major-z-times-columns-plus-x",
            )
            self.assertEqual(
                first["heightEncoding"]["values"], "canonical-world-y-metres"
            )

            height_bytes = (output / first["heightFile"]).read_bytes()
            actual = struct.unpack("<4f", height_bytes)
            expected = tuple(
                7.0 + raw / 32767.0 * 20.0
                for raw in (-32768, 0, 16384, 32767)
            )
            for actual_value, expected_value in zip(actual, expected):
                self.assertAlmostEqual(actual_value, expected_value, places=5)

            self.assertEqual(len(first["controlMaps"]), 3)
            self.assertEqual(first["controlMaps"][0]["channels"], ["r", "g", "b", "a"])
            self.assertEqual(first["controlMaps"][0]["rowOrder"], "z-min-to-z-max")
            self.assertEqual(
                set(first["controlMaps"][0]),
                {"id", "file", "channels", "width", "height", "columnOrder", "rowOrder"},
            )
            self.assertEqual(
                set(first["vegetation"]), {"file", "format", "count", "prototypes"}
            )
            control_payload = (output / first["controlMaps"][0]["file"]).read_bytes()
            width, height, rgba = png_rgba_payload(control_payload)
            self.assertEqual((width, height), (2, 2))
            self.assertEqual(rgba, fixture.control_textures[0]._image.rgba)
            self.assertTrue(all(texture.image_calls == [False] for texture in fixture.control_textures))

            self.assertEqual(first["layers"][0]["controlMapId"], first["controlMaps"][0]["id"])
            self.assertEqual(first["layers"][4]["channel"], "r")
            self.assertEqual(first["layers"][4]["controlMapId"], first["controlMaps"][1]["id"])

            vegetation = json.loads(
                (output / first["vegetation"]["file"]).read_text(encoding="utf-8")
            )
            self.assertEqual(first["vegetation"]["count"], 1)
            self.assertEqual(vegetation["prototypes"][0]["name"], "Scots Pine")
            tree = vegetation["instances"][0]
            self.assertEqual(tree["prototypeId"], vegetation["prototypes"][0]["id"])
            self.assertEqual(tree["positionNormalized"], {"x": 0.25, "y": 0.5, "z": 0.75})
            self.assertEqual(tree["worldPosition"], {"x": 102.5, "y": 17.0, "z": -15.0})

    def test_acknowledgement_and_output_write_guards_run_before_unity_load(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = self.make_source(base)
            fixture = TerrainFixture(source)

            code, _, stderr = self.run_main(
                ["--source", "/not/a/real/source", "--output-dir", str(base / "out")],
                fixture.unitypy,
            )
            self.assertEqual(code, 2)
            self.assertIn("--acknowledge-local-game-files", stderr)
            self.assertEqual(fixture.unitypy.load_calls, [])

            code, _, stderr = self.run_main(
                [
                    "--source",
                    str(source),
                    "--output-dir",
                    str(source / "forbidden-output"),
                    "--acknowledge-local-game-files",
                ],
                fixture.unitypy,
            )
            self.assertEqual(code, 2)
            self.assertIn("outside", stderr)
            self.assertEqual(fixture.unitypy.load_calls, [])

            existing = base / "existing-output"
            existing.mkdir()
            sentinel = existing / "sentinel.txt"
            sentinel.write_text("untouched", encoding="utf-8")
            code, _, stderr = self.run_main(
                [
                    "--source",
                    str(source),
                    "--output-dir",
                    str(existing),
                    "--acknowledge-local-game-files",
                ],
                fixture.unitypy,
            )
            self.assertEqual(code, 2)
            self.assertIn("already exists", stderr)
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "untouched")
            self.assertEqual(fixture.unitypy.load_calls, [])

    def test_source_is_read_only_manifest_has_no_absolute_path_or_original_assets(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = self.make_source(base)
            fixture = TerrainFixture(source)
            before = {
                path.relative_to(source).as_posix(): path.read_bytes()
                for path in source.iterdir()
                if path.is_file()
            }
            output = base / "package"
            code, _, stderr = self.run_main(
                [
                    "--source",
                    str(source),
                    "--output-dir",
                    str(output),
                    "--acknowledge-local-game-files",
                ],
                fixture.unitypy,
            )
            self.assertEqual(code, 0, stderr)
            after = {
                path.relative_to(source).as_posix(): path.read_bytes()
                for path in source.iterdir()
                if path.is_file()
            }
            self.assertEqual(after, before)

            all_output = b"".join(
                path.read_bytes() for path in sorted(output.iterdir()) if path.is_file()
            )
            self.assertNotIn(str(source).encode(), all_output)
            for marker in (
                b"ORIGINAL-MESH-PAYLOAD",
                b"DO-NOT-EXPORT-DIFFUSE",
                b"DO-NOT-EXPORT-NORMAL",
                b"ORIGINAL-diffuse",
                b"ORIGINAL-normal",
            ):
                self.assertNotIn(marker, all_output)
            self.assertEqual(fixture.mesh_reader.read_calls, 0)
            self.assertEqual(fixture.material_reader.read_calls, 0)
            self.assertEqual(fixture.catalog_unrelated.parse_calls, 0)
            self.assertTrue(all(pointer.read_calls == 0 for pointer in fixture.pbr_pointers))
            allowed = {".json", ".f32le", ".png"}
            self.assertTrue(all(path.suffix in allowed for path in output.iterdir()))

    def test_buildsettings_index_is_not_hardcoded_and_unrelated_files_are_never_loaded(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = self.make_source(base)
            fixture = TerrainFixture(source)
            output = base / "package"
            code, _, stderr = self.run_main(
                [
                    "--source",
                    str(source),
                    "--output-dir",
                    str(output),
                    "--acknowledge-local-game-files",
                ],
                fixture.unitypy,
            )
            self.assertEqual(code, 0, stderr)
            self.assertEqual(
                fixture.unitypy.load_calls,
                [
                    ("globalgamemanagers",),
                    ("level42", "sharedassets42.assets"),
                ],
            )
            flattened = {name for call in fixture.unitypy.load_calls for name in call}
            self.assertNotIn("level99", flattened)
            self.assertNotIn("sharedassets99.assets", flattened)
            self.assertNotIn("customs_preset.bundle", flattened)
            self.assertNotIn("EscapeFromTarkov.exe", flattened)

    def test_rotated_or_scaled_terrain_fails_closed_without_output(self):
        cases = (
            (quaternion(0, math.sin(math.pi / 8), 0, math.cos(math.pi / 8)), vector3(1, 1, 1)),
            (quaternion(), vector3(2, 1, 1)),
        )
        for rotation, scale in cases:
            with self.subTest(rotation=rotation, scale=scale), tempfile.TemporaryDirectory() as temporary:
                base = Path(temporary)
                source = self.make_source(base)
                fixture = TerrainFixture(source)
                terrain = fixture.terrain_readers[0].value
                game_object = terrain.m_GameObject.target
                transform = game_object.m_Component[0].target
                transform.m_LocalRotation = rotation
                transform.m_LocalScale = scale
                output = base / "package"
                code, _, stderr = self.run_main(
                    [
                        "--source",
                        str(source),
                        "--output-dir",
                        str(output),
                        "--acknowledge-local-game-files",
                    ],
                    fixture.unitypy,
                )
                self.assertEqual(code, 2)
                self.assertIn("rotation, shear, or non-unit scale", stderr)
                self.assertFalse(output.exists())

    def test_signed_height_contract_accepts_bytes_and_rejects_unsigned_overflow(self):
        raw = (-32768, -1, 0, 32767)
        packed = struct.pack("<4h", *raw)
        self.assertEqual(extractor.decode_sint16_heights(packed, 4), list(raw))
        with self.assertRaises(extractor.TerrainExportError):
            extractor.decode_sint16_heights([0, 1, 2, 65535], 4)


if __name__ == "__main__":
    unittest.main()
