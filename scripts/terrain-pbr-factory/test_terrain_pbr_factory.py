from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import struct
import sys
import tempfile
import unittest
import zlib


FACTORY_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(FACTORY_DIR))

import terrain_pbr_factory as factory  # noqa: E402


def decode_png(path: Path) -> tuple[int, int, int, bytes]:
    payload = path.read_bytes()
    if not payload.startswith(factory.PNG_SIGNATURE):
        raise AssertionError(f"bad PNG signature: {path}")
    position = len(factory.PNG_SIGNATURE)
    width = height = color_type = None
    compressed = bytearray()
    saw_iend = False
    while position < len(payload):
        if position + 12 > len(payload):
            raise AssertionError(f"truncated PNG chunk: {path}")
        length = struct.unpack_from(">I", payload, position)[0]
        kind = payload[position + 4:position + 8]
        data_start = position + 8
        data_end = data_start + length
        crc_end = data_end + 4
        if crc_end > len(payload):
            raise AssertionError(f"truncated PNG payload: {path}")
        data = payload[data_start:data_end]
        expected_crc = struct.unpack_from(">I", payload, data_end)[0]
        actual_crc = zlib.crc32(kind + data) & 0xFFFFFFFF
        if expected_crc != actual_crc:
            raise AssertionError(f"bad PNG CRC: {path}")
        if kind == b"IHDR":
            width, height, bit_depth, color_type, compression, filtering, interlace = struct.unpack(">IIBBBBB", data)
            if (bit_depth, compression, filtering, interlace) != (8, 0, 0, 0):
                raise AssertionError(f"unsupported PNG header: {path}")
        elif kind == b"IDAT":
            compressed.extend(data)
        elif kind == b"IEND":
            saw_iend = True
            if crc_end != len(payload):
                raise AssertionError(f"bytes after PNG IEND: {path}")
        position = crc_end
    if not saw_iend or width is None or height is None:
        raise AssertionError(f"incomplete PNG: {path}")
    channels = {2: 3, 6: 4}.get(color_type)
    if channels is None:
        raise AssertionError(f"unexpected PNG color type {color_type}: {path}")
    scanlines = zlib.decompress(bytes(compressed))
    stride = width * channels
    if len(scanlines) != (stride + 1) * height:
        raise AssertionError(f"unexpected PNG scanline length: {path}")
    pixels = bytearray(width * height * channels)
    for y in range(height):
        start = y * (stride + 1)
        if scanlines[start] != 0:
            raise AssertionError(f"factory PNG uses nonzero filter: {path}")
        pixels[y * stride:(y + 1) * stride] = scanlines[start + 1:start + 1 + stride]
    return width, height, channels, bytes(pixels)


def assert_seamless(test: unittest.TestCase, width: int, height: int, channels: int, pixels: bytes) -> None:
    stride = width * channels
    test.assertEqual(pixels[:stride], pixels[(height - 1) * stride:height * stride])
    for y in range(height):
        row = y * stride
        test.assertEqual(pixels[row:row + channels], pixels[row + (width - 1) * channels:row + width * channels])


def mean_rgb(pixels: bytes, channels: int = 3) -> tuple[float, float, float]:
    count = len(pixels) / channels
    return tuple(sum(pixels[channel::channels]) / count for channel in range(3))


def luminance_period(width: int, height: int, channels: int, pixels: bytes) -> tuple[int, list[float]]:
    if width != height:
        raise AssertionError("quality metric expects a square periodic texture")
    period = width - 1
    values = []
    for y in range(period):
        for x in range(period):
            offset = (y * width + x) * channels
            values.append(
                pixels[offset] * 0.2126
                + pixels[offset + 1] * 0.7152
                + pixels[offset + 2] * 0.0722
            )
    return period, values


def shifted_correlation(values: list[float], period: int, shift: int) -> float:
    shifted = [
        values[y * period + (x + shift) % period]
        for y in range(period)
        for x in range(period)
    ]
    mean_a = sum(values) / len(values)
    mean_b = sum(shifted) / len(shifted)
    numerator = sum((a - mean_a) * (b - mean_b) for a, b in zip(values, shifted))
    denominator = math.sqrt(
        sum((value - mean_a) ** 2 for value in values)
        * sum((value - mean_b) ** 2 for value in shifted)
    )
    return numerator / denominator if denominator else 1.0


def gradient_anisotropy(values: list[float], period: int) -> float:
    gradient_x = 0.0
    gradient_y = 0.0
    for y in range(period):
        for x in range(period):
            value = values[y * period + x]
            gradient_x += abs(values[y * period + (x + 1) % period] - value)
            gradient_y += abs(values[((y + 1) % period) * period + x] - value)
    total = gradient_x + gradient_y
    return abs(gradient_x - gradient_y) / total if total else 1.0


def high_frequency_gradient_energy(
    width: int,
    height: int,
    channels: int,
    pixels: bytes,
    role: str,
) -> float:
    if width != height:
        raise AssertionError("quality metric expects a square periodic texture")
    period = width - 1
    components = 2 if role == "normal" else 1
    values: list[tuple[float, ...]] = []
    for y in range(period):
        for x in range(period):
            offset = (y * width + x) * channels
            if role == "albedo":
                values.append((
                    pixels[offset] * 0.2126
                    + pixels[offset + 1] * 0.7152
                    + pixels[offset + 2] * 0.0722,
                ))
            elif role == "normal":
                values.append((float(pixels[offset]), float(pixels[offset + 1])))
            elif role == "orm":
                values.append((float(pixels[offset + 1]),))
            else:
                raise AssertionError(f"unsupported quality role {role}")
    total = 0.0
    for y in range(period):
        for x in range(period):
            index = y * period + x
            neighbours = (
                values[y * period + (x - 1) % period],
                values[y * period + (x + 1) % period],
                values[((y - 1) % period) * period + x],
                values[((y + 1) % period) * period + x],
            )
            residual = [
                values[index][component]
                - sum(value[component] for value in neighbours) / len(neighbours)
                for component in range(components)
            ]
            total += math.sqrt(sum(value * value for value in residual))
    return total / (period * period)


class TerrainPbrFactoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temp_root = Path(tempfile.mkdtemp(prefix="tarkovzero-terrain-factory-tests-"))
        cls.output_a = cls.temp_root / "a"
        cls.output_b = cls.temp_root / "b"
        cls.receipt_a = factory.generate(cls.output_a, 32)
        cls.receipt_b = factory.generate(cls.output_b, 32)

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.temp_root, ignore_errors=True)

    def test_exact_semantic_order_and_unique_explicit_seeds(self) -> None:
        self.assertEqual(
            [spec.semantic for spec in factory.LAYERS],
            [
                "grass", "ground", "gravel-road-a", "forest-ground",
                "stone-ground", "rock-ground", "gravel-road-b", "gravel",
                "grassy-ground", "sand", "pebbles-ground", "soil-grass",
            ],
        )
        self.assertEqual([spec.index for spec in factory.LAYERS], list(range(12)))
        self.assertEqual(len({spec.seed for spec in factory.LAYERS}), 12)
        self.assertEqual(len(factory.TERRAIN_LAYER_NAMES), 12)

    def test_v21_preserves_every_v2_repeat_without_height_displacement(self) -> None:
        self.assertEqual(factory.GENERATOR_VERSION, "2.1.0")
        self.assertEqual(self.receipt_a["artifactSet"], "customs-terrain-pbr-12-layer-v2.1")
        self.assertEqual(self.receipt_a["visualRevision"]["repeatScaleMultiplierFromV1"], 6.0)
        self.assertEqual(
            self.receipt_a["heightContract"],
            {
                "runtimeDisplacement": False,
                "sourceHeightUse": "normal and ambient-occlusion synthesis only",
                "outputHeightTexture": False,
            },
        )
        for spec, layer in zip(factory.LAYERS, self.receipt_a["layers"]):
            self.assertAlmostEqual(spec.metres_per_repeat / spec.feature_reference_metres, 6.0)
            self.assertEqual(layer["physicalTileScaleMetres"], spec.metres_per_repeat)
            self.assertEqual(layer["featureReferenceScaleMetres"], spec.feature_reference_metres)
            self.assertEqual(layer["repeatScaleMultiplierFromV1"], 6.0)
        self.assertGreaterEqual(min(spec.metres_per_repeat for spec in factory.LAYERS), 13.2)
        self.assertLessEqual(max(spec.metres_per_repeat for spec in factory.LAYERS), 36.0)

    def test_v21_micro_grit_is_physical_isotropic_and_channel_bounded(self) -> None:
        contract = self.receipt_a["microGritContract"]
        self.assertEqual(contract["orientation"], "isotropic-periodic-value-noise")
        self.assertEqual(contract["targetWavelengthsMetres"], [0.12, 0.07, 0.03])
        self.assertEqual(contract["normalMinimumFootprintPixels"], 2)
        self.assertTrue(contract["normalNyquistClamped"])
        self.assertFalse(contract["controlOrSplatMaskModified"])
        self.assertEqual(contract["runtimeSamplesAdded"], 0)
        self.assertEqual(
            set(factory.MICRO_GRIT_BY_PROFILE),
            {spec.profile for spec in factory.LAYERS},
        )
        by_semantic = {layer["semantic"]: layer for layer in self.receipt_a["layers"]}
        for spec in factory.LAYERS:
            grit = by_semantic[spec.semantic]["microGrit"]
            expected = factory.MICRO_GRIT_BY_PROFILE[spec.profile]
            self.assertEqual(grit["targetWavelengthsMetres"], [0.12, 0.07, 0.03])
            self.assertEqual(grit["albedoAmplitudeSrgbUnits"], expected.albedo_units)
            self.assertEqual(grit["heightAmplitudeMetres"], expected.height_metres)
            self.assertEqual(grit["roughnessAmplitude"], expected.roughness_delta)
            self.assertLessEqual(expected.albedo_units, 5.0)
        self.assertGreater(
            factory.MICRO_GRIT_BY_PROFILE["gravel"].height_metres,
            factory.MICRO_GRIT_BY_PROFILE["grass"].height_metres * 8,
        )
        self.assertGreater(
            factory.MICRO_GRIT_BY_PROFILE["pebbles"].roughness_delta,
            factory.MICRO_GRIT_BY_PROFILE["sand"].roughness_delta * 3,
        )

    def test_output_is_byte_deterministic_across_directories(self) -> None:
        names_a = sorted(path.name for path in self.output_a.iterdir())
        names_b = sorted(path.name for path in self.output_b.iterdir())
        self.assertEqual(names_a, names_b)
        for name in names_a:
            self.assertEqual(
                (self.output_a / name).read_bytes(),
                (self.output_b / name).read_bytes(),
                name,
            )

    def test_pngs_are_valid_rgb_or_rgba_with_exact_receipt_metadata(self) -> None:
        self.assertEqual(len(list(self.output_a.glob("*.png"))), 37)
        for layer in self.receipt_a["layers"]:
            for role, metadata in layer["artifacts"].items():
                path = self.output_a / metadata["path"]
                width, height, channels, pixels = decode_png(path)
                self.assertEqual((width, height), (32, 32))
                self.assertEqual(channels, 4 if role == "orm" else 3)
                self.assertEqual(len(pixels), width * height * channels)
                payload = path.read_bytes()
                self.assertEqual(metadata["bytes"], len(payload))
                self.assertEqual(metadata["sha256"], hashlib.sha256(payload).hexdigest())
        macro = self.receipt_a["macro"]["artifact"]
        macro_payload = (self.output_a / macro["path"]).read_bytes()
        self.assertEqual(macro["sha256"], hashlib.sha256(macro_payload).hexdigest())
        self.assertEqual(macro["bytes"], len(macro_payload))

    def test_every_source_texture_has_an_exact_periodic_border(self) -> None:
        for path in sorted(self.output_a.glob("*.png")):
            width, height, channels, pixels = decode_png(path)
            assert_seamless(self, width, height, channels, pixels)

    def test_normals_are_height_derived_unit_vectors_and_orm_is_canonical(self) -> None:
        normal_hashes = set()
        orm_hashes = set()
        for spec in factory.LAYERS:
            normal_path = self.output_a / factory._artifact_name(spec, "normal")
            width, height, channels, normals = decode_png(normal_path)
            self.assertEqual(channels, 3)
            normal_hashes.add(hashlib.sha256(normals).hexdigest())
            vector_errors = []
            red_values = set()
            green_values = set()
            blue_values = []
            for offset in range(0, len(normals), 3):
                x = normals[offset] / 255.0 * 2.0 - 1.0
                y = normals[offset + 1] / 255.0 * 2.0 - 1.0
                z = normals[offset + 2] / 255.0 * 2.0 - 1.0
                vector_errors.append(abs(math.sqrt(x * x + y * y + z * z) - 1.0))
                red_values.add(normals[offset])
                green_values.add(normals[offset + 1])
                blue_values.append(normals[offset + 2])
            self.assertLess(sum(vector_errors) / len(vector_errors), 0.008)
            self.assertGreater(len(red_values), 2)
            self.assertGreater(len(green_values), 2)
            self.assertGreater(sum(blue_values) / len(blue_values), 220)

            orm_path = self.output_a / factory._artifact_name(spec, "orm")
            _, _, channels, orm = decode_png(orm_path)
            self.assertEqual(channels, 4)
            orm_hashes.add(hashlib.sha256(orm).hexdigest())
            self.assertEqual(set(orm[2::4]), {0}, spec.semantic)
            self.assertEqual(set(orm[3::4]), {255}, spec.semantic)
            self.assertGreater(len(set(orm[0::4])), 3, spec.semantic)
            self.assertGreater(len(set(orm[1::4])), 3, spec.semantic)
        self.assertEqual(len(normal_hashes), 12)
        self.assertEqual(len(orm_hashes), 12)

    def test_families_have_distinct_color_and_relief_fingerprints(self) -> None:
        albedo_hashes = set()
        mean_colors = []
        for spec in factory.LAYERS:
            path = self.output_a / factory._artifact_name(spec, "albedo")
            _, _, _, pixels = decode_png(path)
            albedo_hashes.add(hashlib.sha256(pixels).hexdigest())
            means = tuple(round(sum(pixels[channel::3]) / (len(pixels) / 3), 1) for channel in range(3))
            mean_colors.append(means)
        self.assertEqual(len(albedo_hashes), 12)
        self.assertEqual(len(set(mean_colors)), 12)
        # Critical readable contrasts: living grass, dark forest floor, pale sand, and blue-grey rock.
        grass, forest, rock, sand = mean_colors[0], mean_colors[3], mean_colors[5], mean_colors[9]
        self.assertGreater(grass[1] - grass[0], 4)
        self.assertLess(sum(forest), sum(grass))
        self.assertGreater(sand[0] - rock[0], 45)
        self.assertGreater(sand[0] - sand[2], 25)

    def test_living_ground_palette_is_muted_olive_instead_of_lime(self) -> None:
        for index in (0, 8, 11):
            spec = factory.LAYERS[index]
            _, _, channels, pixels = decode_png(
                self.output_a / factory._artifact_name(spec, "albedo")
            )
            red, green, blue = mean_rgb(pixels, channels)
            saturation = (max(red, green, blue) - min(red, green, blue)) / max(red, green, blue)
            self.assertLess(saturation, 0.38, spec.semantic)
            self.assertGreater(red, blue, spec.semantic)
        grass = mean_rgb(decode_png(self.output_a / "00-grass-albedo.png")[3])
        self.assertGreater(grass[1], grass[0])
        self.assertLess(grass[1] - grass[0], 14)

    def test_dirt_grass_and_gravel_have_separated_roughness_responses(self) -> None:
        means = {}
        for index in (0, 1, 7, 10):
            spec = factory.LAYERS[index]
            width, height, channels, pixels = decode_png(
                self.output_a / factory._artifact_name(spec, "orm")
            )
            self.assertEqual(channels, 4)
            means[spec.semantic] = sum(pixels[1::4]) / (width * height * 255.0)
        self.assertGreater(means["ground"] - means["grass"], 0.075)
        self.assertGreater(means["grass"] - means["gravel"], 0.10)
        self.assertLess(means["pebbles-ground"], means["gravel"])

    def test_old_repeat_distance_and_axis_directions_do_not_reveal_a_motif(self) -> None:
        for spec in factory.LAYERS:
            width, height, channels, pixels = decode_png(
                self.output_a / factory._artifact_name(spec, "albedo")
            )
            period, values = luminance_period(width, height, channels, pixels)
            # V1 repeated exactly after this physical distance.  In V2 it lands
            # one sixth into a larger independently populated tile and must not
            # correlate into a visible echo.
            old_repeat_shift = max(1, round(period / 6))
            self.assertLess(
                abs(shifted_correlation(values, period, old_repeat_shift)),
                0.35,
                spec.semantic,
            )
            self.assertLess(gradient_anisotropy(values, period), 0.08, spec.semantic)

    def test_macro_is_seamless_nonflat_and_declares_256m_scale(self) -> None:
        width, height, channels, pixels = decode_png(self.output_a / "customs-terrain-macro-albedo.png")
        self.assertEqual((width, height, channels), (32, 32, 3))
        assert_seamless(self, width, height, channels, pixels)
        self.assertGreater(len(set(pixels[0::3])), 20)
        self.assertEqual(self.receipt_a["macro"]["physicalTileScaleMetres"], 256.0)
        self.assertAlmostEqual(self.receipt_a["macro"]["strength"], 0.16)

    def test_material_template_matches_closed_contract_shape_and_receipts(self) -> None:
        template_path = self.output_a / "material-set.template.json"
        template = json.loads(template_path.read_text(encoding="utf-8"))
        self.assertEqual(set(template), {"schemaVersion", "map", "delivery", "layers", "arrays", "macro"})
        self.assertEqual((template["schemaVersion"], template["map"], template["delivery"]), (1, "customs", "original-authored"))
        self.assertEqual([layer["semantic"] for layer in template["layers"]], [spec.semantic for spec in factory.LAYERS])
        self.assertEqual([array["role"] for array in template["arrays"]], ["albedo", "normal", "orm"])
        self.assertEqual(template["arrays"][1]["normalSpace"], "tangent")
        self.assertEqual(template["arrays"][2]["channels"], ["occlusion", "roughness", "metallic", "unused"])
        self.assertEqual(template["macro"]["metresPerRepeat"], 256.0)
        self.assertEqual(template["macro"]["role"], "macro-albedo")
        provenance = self.receipt_a["authoredReceipts"]["provenance"]
        license_receipt = self.receipt_a["authoredReceipts"]["originalLicense"]
        for descriptor in [*template["arrays"], template["macro"]]:
            self.assertEqual(descriptor["receipts"]["provenance"]["sha256"], provenance["sha256"])
            self.assertEqual(descriptor["receipts"]["originalLicense"]["sha256"], license_receipt["sha256"])
            self.assertTrue(descriptor["url"].startswith(factory.AUTHORED_ASSET_ROOT))
            self.assertEqual(descriptor["sha256"], "0" * 64)
        template_payload = template_path.read_bytes()
        self.assertEqual(self.receipt_a["materialSet"]["template"]["sha256"], hashlib.sha256(template_payload).hexdigest())
        self.assertFalse(self.receipt_a["materialSet"]["contentHashesFinal"])

    def test_provenance_and_license_are_explicit_original_authored_cc0(self) -> None:
        provenance = json.loads((self.output_a / "provenance.json").read_text(encoding="utf-8"))
        license_record = json.loads((self.output_a / "original-license.json").read_text(encoding="utf-8"))
        self.assertEqual(provenance["classification"], "original-authored")
        self.assertEqual(provenance["sourceInputs"], [])
        self.assertFalse(provenance["gameFilesRead"])
        self.assertFalse(provenance["networkAccess"])
        self.assertFalse(provenance["thirdPartyPixels"])
        self.assertEqual(license_record["license"]["spdx"], "CC0-1.0")
        self.assertEqual(license_record["thirdPartyAssets"], [])
        self.assertEqual(license_record["gameAssetPayloads"], [])

    def test_size_and_path_guards_fail_closed(self) -> None:
        for invalid in (0, 16, 31, 33, 1536, 2048, True, 64.0):
            with self.assertRaises(factory.FactoryError, msg=invalid):
                factory.validate_size(invalid)
        for valid in (32, 64, 128, 256, 512, 1024):
            self.assertEqual(factory.validate_size(valid), valid)
        with self.assertRaises(factory.FactoryError):
            factory.validate_output_path("/")
        with self.assertRaises(factory.FactoryError):
            factory.validate_output_path(self.temp_root / "safe" / ".." / "escape")

        real = self.temp_root / "real-parent"
        real.mkdir()
        symlink = self.temp_root / "symlink-parent"
        try:
            symlink.symlink_to(real, target_is_directory=True)
        except OSError:
            return
        with self.assertRaises(factory.FactoryError):
            factory.validate_output_path(symlink / "output")

    def test_no_overwrite_without_force_and_safe_force_preserves_unowned_files(self) -> None:
        output = self.temp_root / "overwrite"
        first = factory.generate(output, 32)
        sentinel = output / "user-note.txt"
        sentinel.write_text("preserve me", encoding="utf-8")
        with self.assertRaises(factory.FactoryError):
            factory.generate(output, 32)
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "preserve me")
        second = factory.generate(output, 32, force=True)
        self.assertEqual(first, second)
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "preserve me")

        owned = output / "00-grass-albedo.png"
        owned.unlink()
        owned.mkdir()
        with self.assertRaises(factory.FactoryError):
            factory.generate(output, 32, force=True)

    def test_ktx2_header_gate_and_stable_build_commands(self) -> None:
        header = factory.KTX2_SIGNATURE + struct.pack(
            "<9I", 0, 1, 32, 32, 0, 12, 1, 6, 1
        )
        parsed = factory._parse_ktx2_header(header, "albedo", 32)
        self.assertEqual(parsed, {"width": 32, "height": 32, "layers": 12, "mipLevels": 6})
        macro_header = factory.KTX2_SIGNATURE + struct.pack(
            "<9I", 0, 1, 32, 32, 0, 0, 1, 6, 1
        )
        parsed_macro = factory._parse_ktx2_header(macro_header, "macro-albedo", 32, expected_layers=0)
        self.assertEqual(parsed_macro["layers"], 0)
        with self.assertRaises(factory.FactoryError):
            factory._parse_ktx2_header(header, "albedo", 64)

        commands = factory.ktx2_array_commands()
        self.assertEqual(list(commands), ["albedo", "normal", "orm"])
        for role, command in commands.items():
            self.assertEqual(command[0], "$TOKTX")
            self.assertIn("--genmipmap", command)
            self.assertIn("--layers", command)
            self.assertEqual(command[command.index("--layers") + 1], "12")
            self.assertEqual(len([entry for entry in command if entry.endswith(f"-{role}.png")]), 12)
        macro = factory.macro_ktx2_command()
        self.assertIn("--2d", macro)
        self.assertNotIn("--layers", macro)
        self.assertEqual(macro[-1], "customs-terrain-macro-albedo.png")

    def test_production_v21_quality_gates_against_v1_and_v2_when_configured(self) -> None:
        raw_v1 = os.environ.get("TARKOVZERO_TERRAIN_V1_QA")
        raw_v2 = os.environ.get("TARKOVZERO_TERRAIN_V2_QA")
        raw_v21 = os.environ.get("TARKOVZERO_TERRAIN_V21_QA")
        if not (raw_v1 and raw_v2 and raw_v21):
            self.skipTest("set all three TARKOVZERO_TERRAIN_V*_QA paths for production quality gates")
        roots = {"v1": Path(raw_v1), "v2": Path(raw_v2), "v21": Path(raw_v21)}
        for label, root in roots.items():
            self.assertTrue(root.is_dir(), f"{label} quality root does not exist: {root}")

        strong_profiles = {
            "ground", "road-a", "stone", "rock", "road-b", "gravel", "pebbles", "soil-grass",
        }
        energy_ratios = {
            "strong": {"albedo": 1.005, "normal": 1.002, "orm": 1.20},
            "restrained": {"albedo": 1.0, "normal": 1.0, "orm": 1.02},
        }
        mean_colors: list[tuple[float, float, float]] = []
        palette_rows = []
        roughness_means = {}
        for spec in factory.LAYERS:
            tier = "strong" if spec.profile in strong_profiles else "restrained"
            for role in ("albedo", "normal", "orm"):
                energies = {}
                for revision, root in roots.items():
                    width, height, channels, pixels = decode_png(
                        root / factory._artifact_name(spec, role)
                    )
                    energies[revision] = high_frequency_gradient_energy(
                        width, height, channels, pixels, role
                    )
                self.assertGreater(
                    energies["v21"],
                    energies["v1"] * 1.02,
                    f"{spec.semantic} {role} did not exceed V1 high-frequency energy",
                )
                self.assertGreater(
                    energies["v21"],
                    energies["v2"],
                    f"{spec.semantic} {role} did not increase over V2",
                )
                self.assertGreaterEqual(
                    energies["v21"],
                    energies["v2"] * energy_ratios[tier][role],
                    f"{spec.semantic} {role} did not improve over V2",
                )

            v2_width, v2_height, v2_channels, v2_pixels = decode_png(
                roots["v2"] / factory._artifact_name(spec, "albedo")
            )
            width, height, channels, pixels = decode_png(
                roots["v21"] / factory._artifact_name(spec, "albedo")
            )
            period, luminance = luminance_period(width, height, channels, pixels)
            v2_period, v2_luminance = luminance_period(
                v2_width, v2_height, v2_channels, v2_pixels
            )
            self.assertEqual(v2_period, period)
            self.assertLess(
                abs(shifted_correlation(luminance, period, max(1, round(period / 6)))),
                0.12,
                spec.semantic,
            )
            self.assertLess(
                gradient_anisotropy(luminance, period),
                max(0.03, gradient_anisotropy(v2_luminance, v2_period) + 0.01),
                spec.semantic,
            )
            v2_rgb = mean_rgb(v2_pixels, v2_channels)
            v21_rgb = mean_rgb(pixels, channels)
            mean_colors.append(tuple(round(value, 1) for value in v21_rgb))
            if spec.profile not in {"stone", "rock"}:
                v2_saturation = (max(v2_rgb) - min(v2_rgb)) / max(v2_rgb)
                v21_saturation = (max(v21_rgb) - min(v21_rgb)) / max(v21_rgb)
                palette_rows.append((v2_saturation, v21_saturation))

            orm_width, orm_height, orm_channels, orm_pixels = decode_png(
                roots["v21"] / factory._artifact_name(spec, "orm")
            )
            roughness_means[spec.semantic] = sum(orm_pixels[1::4]) / (
                orm_width * orm_height * 255.0
            )

        v2_saturation = sum(row[0] for row in palette_rows) / len(palette_rows)
        v21_saturation = sum(row[1] for row in palette_rows) / len(palette_rows)
        saturation_reduction = 1.0 - v21_saturation / v2_saturation
        self.assertGreaterEqual(saturation_reduction, 0.09)
        self.assertLessEqual(saturation_reduction, 0.16)
        self.assertGreater(v21_saturation, 0.16, "palette collapsed into a grey wash")
        self.assertEqual(len(set(mean_colors)), len(factory.LAYERS))
        self.assertGreater(roughness_means["ground"] - roughness_means["grass"], 0.07)
        self.assertGreater(roughness_means["grass"] - roughness_means["gravel"], 0.09)

    def test_real_toktx_arrays_are_deterministic_and_finalize_template_hashes_when_configured(self) -> None:
        raw_toktx = os.environ.get("TARKOVZERO_TEST_TOKTX")
        if not raw_toktx:
            self.skipTest("set TARKOVZERO_TEST_TOKTX to exercise the optional real encoder")
        output_c = self.temp_root / "ktx-c"
        output_d = self.temp_root / "ktx-d"
        receipt_c = factory.generate(output_c, 32, toktx=raw_toktx)
        receipt_d = factory.generate(output_d, 32, toktx=raw_toktx)
        self.assertEqual(receipt_c, receipt_d)
        self.assertEqual([artifact["role"] for artifact in receipt_c["ktx2"]["arrays"]], ["albedo", "normal", "orm"])
        self.assertEqual(receipt_c["ktx2"]["macro"]["role"], "macro-albedo")
        self.assertTrue(receipt_c["materialSet"]["contentHashesFinal"])
        template = json.loads((output_c / "material-set.template.json").read_text(encoding="utf-8"))
        for descriptor in [*template["arrays"], template["macro"]]:
            path = output_c / Path(descriptor["url"]).name
            self.assertTrue(path.read_bytes().startswith(factory.KTX2_SIGNATURE))
            self.assertEqual(descriptor["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())
            self.assertEqual(path.read_bytes(), (output_d / path.name).read_bytes())


if __name__ == "__main__":
    unittest.main()
