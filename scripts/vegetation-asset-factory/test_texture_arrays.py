#!/usr/bin/env python3
"""Tests for the vegetation texture-array builder.

Pixel-level assertions live here because this is where the source images are easiest to reach.
The runtime-side contract (index validation, the `vegLayer` attribute, the loader) is asserted in
`scripts/customs-vegetation-arrays.test.mjs`.

Skips cleanly when `.local-candidates/vegetation-full-v2` is absent, like the repo's other
local-package suites: the pack is git-ignored rescue evidence, not a checked-in fixture.
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_texture_arrays as factory  # noqa: E402


REPOSITORY_ROOT = Path(__file__).resolve().parent.parent.parent
PACK_ROOT = REPOSITORY_ROOT / ".local-candidates" / "vegetation-full-v2"

# The measured shape of this pack. Pinned so a regenerated pack that changes it fails loudly here
# rather than silently producing a differently-sized array set.
EXPECTED_ARRAYS = {
    0: {"layers": 85, "resolution": 128, "mipLevels": 8, "normalScale": 0.78},
    1: {"layers": 57, "resolution": 64, "mipLevels": 7, "normalScale": 0.62},
    2: {"layers": 57, "resolution": 32, "mipLevels": 6, "normalScale": 0.48},
}
EXPECTED_TOTAL_BYTES = 26_950_884
EXPECTED_LEVEL0_BYTES = 20_213_760
EXPECTED_PRIMITIVES = 199
EXPECTED_LAYERS = 199
BLOB_FILES = tuple(
    f"veg-l{lod}-{slot}.bin" for lod in factory.LODS for slot in factory.SLOTS
)


def build_into(output: Path, extra: list[str] | None = None) -> dict:
    argv = ["--pack-root", str(PACK_ROOT), "--output", str(output)] + (extra or [])
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        code = factory.main(argv)
    assert code == 0
    return json.loads(buffer.getvalue())


@unittest.skipUnless(PACK_ROOT.is_dir(), "authored vegetation pack is not present locally")
class TextureArrayBuilderTest(unittest.TestCase):
    temporary: tempfile.TemporaryDirectory
    first: Path
    index: dict

    @classmethod
    def setUpClass(cls) -> None:
        cls.temporary = tempfile.TemporaryDirectory(prefix="veg-arraytex-test-")
        root = Path(cls.temporary.name)
        cls.first = root / "run-a"
        cls.report = build_into(cls.first)
        cls.index = json.loads((cls.first / "veg-layers.json").read_text(encoding="utf-8"))

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temporary.cleanup()

    # ── determinism ───────────────────────────────────────────────────────────────────────────

    def test_two_runs_are_byte_identical(self):
        second = Path(self.temporary.name) / "run-b"
        build_into(second)
        produced = sorted(path.name for path in self.first.iterdir())
        self.assertEqual(produced, sorted(path.name for path in second.iterdir()))
        self.assertEqual(len(produced), len(BLOB_FILES) + 2)
        for name in produced:
            self.assertEqual(
                (self.first / name).read_bytes(),
                (second / name).read_bytes(),
                f"{name} is not byte-reproducible",
            )

    def test_receipt_hashes_match_the_written_bytes(self):
        receipt = json.loads((self.first / "veg-layers.receipt.json").read_text(encoding="utf-8"))
        self.assertEqual(receipt["documentType"], factory.RECEIPT_DOCUMENT_TYPE)
        self.assertEqual({entry["file"] for entry in receipt["blobs"]}, set(BLOB_FILES))
        for entry in receipt["blobs"]:
            payload = (self.first / entry["file"]).read_bytes()
            self.assertEqual(len(payload), entry["bytes"])
            self.assertEqual(f"sha256:{hashlib.sha256(payload).hexdigest()}", entry["sha256"])
        index_bytes = (self.first / "veg-layers.json").read_bytes()
        self.assertEqual(f"sha256:{hashlib.sha256(index_bytes).hexdigest()}", receipt["sha256"])

    # ── layer coverage ────────────────────────────────────────────────────────────────────────

    def test_every_primitive_resolves_to_exactly_one_layer(self):
        layers = self.index["layers"]
        primitives = self.index["primitives"]
        self.assertEqual(len(layers), EXPECTED_LAYERS)
        self.assertEqual(len(primitives), EXPECTED_PRIMITIVES)
        slots = {(record["lod"], record["layer"]) for record in layers}
        self.assertEqual(len(slots), len(layers), "two layer records share a slot")
        keys = {(record["assetId"], record["lod"], record["materialName"]) for record in layers}
        self.assertEqual(len(keys), len(layers), "(assetId, lod, materialName) is not a unique key")
        by_key = {(r["assetId"], r["lod"], r["materialName"]): r["layer"] for r in layers}
        for primitive in primitives:
            key = (primitive["assetId"], primitive["lod"], primitive["materialName"])
            self.assertIn(key, by_key, f"{key} resolves to no layer")
            self.assertEqual(by_key[key], primitive["layer"])

    def test_no_layer_is_orphaned(self):
        used = {(record["lod"], record["layer"]) for record in self.index["primitives"]}
        for array in self.index["arrays"]:
            expected = {(array["lod"], layer) for layer in range(array["depth"])}
            self.assertEqual(
                {slot for slot in used if slot[0] == array["lod"]},
                expected,
                f"LOD{array['lod']} layer indices are not exactly 0..{array['depth'] - 1}",
            )

    # ── dimensions, mip counts, byte budget ───────────────────────────────────────────────────

    def test_array_dimensions_and_mip_counts(self):
        arrays = {array["lod"]: array for array in self.index["arrays"]}
        self.assertEqual(set(arrays), set(EXPECTED_ARRAYS))
        for lod, expected in EXPECTED_ARRAYS.items():
            array = arrays[lod]
            self.assertEqual(array["depth"], expected["layers"])
            self.assertEqual(array["width"], expected["resolution"])
            self.assertEqual(array["height"], expected["resolution"])
            self.assertEqual(array["mipLevels"], expected["mipLevels"])
            self.assertEqual(array["normalScaleBaked"], expected["normalScale"])

    def test_blob_lengths_are_layers_times_res_squared_times_four_per_level(self):
        for array in self.index["arrays"]:
            running = 0
            for level, entry in enumerate(array["levels"]):
                size = array["width"] >> level
                self.assertEqual(entry["width"], size)
                self.assertEqual(entry["height"], size)
                self.assertEqual(entry["byteOffset"], running)
                self.assertEqual(entry["byteLength"], array["depth"] * size * size * 4)
                running += entry["byteLength"]
            for slot in factory.SLOTS:
                blob = array["blobs"][slot]
                self.assertEqual(blob["bytes"], running)
                self.assertEqual((self.first / blob["file"]).stat().st_size, running)

    def test_total_byte_budget(self):
        total = sum(
            array["blobs"][slot]["bytes"] for array in self.index["arrays"] for slot in factory.SLOTS
        )
        self.assertEqual(total, EXPECTED_TOTAL_BYTES)
        self.assertEqual(self.index["totalBytes"], EXPECTED_TOTAL_BYTES)
        self.assertEqual(self.index["uploadBytesLevel0"], EXPECTED_LEVEL0_BYTES)
        self.assertLessEqual(total, 27 * 1000 * 1000, "the array set outgrew the planned ~27 MB")
        self.assertLess(total, factory.MAX_TOTAL_ARRAY_BYTES)

    def test_mips_none_emits_level_zero_only(self):
        flat = Path(self.temporary.name) / "run-flat"
        report = build_into(flat, ["--mips", "none"])
        self.assertEqual(report["totalBytes"], EXPECTED_LEVEL0_BYTES)
        index = json.loads((flat / "veg-layers.json").read_text(encoding="utf-8"))
        for array in index["arrays"]:
            self.assertEqual(array["mipLevels"], 1)
        # Level 0 must be identical either way: the mip flag adds levels, it never changes level 0.
        for name in BLOB_FILES:
            lod = int(name[5])
            array = next(entry for entry in self.index["arrays"] if entry["lod"] == lod)
            level0 = array["levels"][0]["byteLength"]
            self.assertEqual(
                (self.first / name).read_bytes()[:level0],
                (flat / name).read_bytes(),
                f"{name} level 0 changed with --mips none",
            )

    # ── pixel fidelity ────────────────────────────────────────────────────────────────────────

    def _layer_pixels(self, lod: int, slot: str, layer: int) -> np.ndarray:
        array = next(entry for entry in self.index["arrays"] if entry["lod"] == lod)
        size = array["width"]
        stride = size * size * 4
        payload = (self.first / array["blobs"][slot]["file"]).read_bytes()
        start = array["levels"][0]["byteOffset"] + layer * stride
        return np.frombuffer(payload[start : start + stride], dtype=np.uint8).reshape(size, size, 4)

    def _source_images(self, asset_file: str, material_index: int) -> dict[str, np.ndarray]:
        gltf, binary = factory.parse_glb(PACK_ROOT / asset_file)
        material = gltf["materials"][material_index]
        pbr = material["pbrMetallicRoughness"]
        indices = {
            "basecolor": factory.texture_image_index(gltf, pbr["baseColorTexture"]["index"], "basecolor"),
            "orm": factory.texture_image_index(gltf, pbr["metallicRoughnessTexture"]["index"], "orm"),
            "normal": factory.texture_image_index(gltf, material["normalTexture"]["index"], "normal"),
        }
        out = {}
        for slot, image_index in indices.items():
            payload = factory.image_bytes(gltf, binary, image_index, slot)
            with Image.open(io.BytesIO(payload)) as image:
                out[slot] = np.asarray(image, dtype=np.uint8).copy()
        return out

    def test_basecolor_and_orm_layers_are_the_source_texels_verbatim(self):
        record = self.index["layers"][0]
        asset = next(
            entry for entry in json.loads((PACK_ROOT / "pack-index.json").read_text())["authoredAssets"]
            if entry["assetId"] == record["assetId"]
        )
        asset_file = next(lod["file"] for lod in asset["lods"] if lod["lod"] == record["lod"])
        source = self._source_images(asset_file, record["materialIndex"])
        for slot in ("basecolor", "orm"):
            np.testing.assert_array_equal(
                self._layer_pixels(record["lod"], slot, record["layer"]),
                source[slot],
                f"{slot} layer {record['layer']} is not the source texels",
            )

    def test_normal_scale_round_trips_within_one_255th(self):
        """Invert `xy' = (xy - 0.5)s + 0.5` on real texels and recover the declared scale."""
        pack = json.loads((PACK_ROOT / "pack-index.json").read_text())["authoredAssets"]
        by_id = {entry["assetId"]: entry for entry in pack}
        checked = 0
        for lod, expected in EXPECTED_ARRAYS.items():
            record = next(entry for entry in self.index["layers"] if entry["lod"] == lod)
            asset_file = next(
                item["file"] for item in by_id[record["assetId"]]["lods"] if item["lod"] == lod
            )
            source = self._source_images(asset_file, record["materialIndex"])["normal"]
            baked = self._layer_pixels(lod, "normal", record["layer"])

            # Exactness: the blob must equal a fresh bake of the source, texel for texel.
            np.testing.assert_array_equal(baked, factory.bake_normal_scale(source, expected["normalScale"]))
            # Z and alpha are untouched by the bake.
            np.testing.assert_array_equal(baked[..., 2:], source[..., 2:])

            deviation = source[..., :2].astype(np.float64) / 255.0 - 0.5
            strong = np.abs(deviation) >= 0.2
            self.assertTrue(strong.any(), f"LOD{lod} normal sample has no texel far enough from 0.5 to invert")
            recovered = (baked[..., :2].astype(np.float64) / 255.0 - 0.5)[strong] / deviation[strong]
            self.assertLess(
                abs(float(np.median(recovered)) - expected["normalScale"]),
                1.0 / 255.0,
                f"LOD{lod} baked normalScale does not invert to {expected['normalScale']}",
            )
            checked += 1
        self.assertEqual(checked, len(EXPECTED_ARRAYS))

    def test_basecolor_mips_are_filtered_in_linear_light(self):
        """A box filter over sRGB BYTES darkens foliage; the builder must decode first."""
        level0 = np.zeros((2, 2, 4), dtype=np.uint8)
        level0[..., 3] = 255
        level0[0, 0, :3] = 0
        level0[0, 1, :3] = 255
        level0[1, 0, :3] = 0
        level0[1, 1, :3] = 255
        chain = factory.build_mip_chain(level0, "basecolor", 2)
        naive = 128  # what averaging the sRGB bytes would give
        self.assertEqual(int(chain[1][0, 0, 0]), 188)
        self.assertGreater(int(chain[1][0, 0, 0]), naive)
        # ORM is linear data and must NOT be gamma-corrected.
        linear = factory.build_mip_chain(level0, "orm", 2)
        self.assertEqual(int(linear[1][0, 0, 0]), naive)

    # ── safety guards ─────────────────────────────────────────────────────────────────────────

    def test_refuses_to_write_inside_the_pack(self):
        with self.assertRaises(ValueError) as caught:
            factory.parse_args(["--pack-root", str(PACK_ROOT), "--output", str(PACK_ROOT / "runtime")])
        self.assertIn("inside the pack", str(caught.exception))

    def test_refuses_to_write_into_public(self):
        with self.assertRaises(ValueError) as caught:
            factory.parse_args([
                "--pack-root", str(PACK_ROOT),
                "--output", str(REPOSITORY_ROOT / "public" / "veg-arraytex"),
            ])
        self.assertIn("public/", str(caught.exception))

    def test_output_is_no_clobber(self):
        with self.assertRaises(ValueError) as caught:
            factory.parse_args(["--pack-root", str(PACK_ROOT), "--output", str(self.first)])
        self.assertIn("no-clobber", str(caught.exception))


class PureHelperTest(unittest.TestCase):
    """Helpers that need no pack, so this class runs even on a machine without the local packages."""

    def test_mip_level_counts(self):
        self.assertEqual(factory.mip_levels_for(128, "box"), 8)
        self.assertEqual(factory.mip_levels_for(64, "box"), 7)
        self.assertEqual(factory.mip_levels_for(32, "box"), 6)
        self.assertEqual(factory.mip_levels_for(128, "none"), 1)

    def test_normal_bake_is_exact_for_the_identity_scale(self):
        source = np.arange(256, dtype=np.uint8).reshape(8, 8, 4)
        np.testing.assert_array_equal(factory.bake_normal_scale(source, 1.0), source)

    def test_box_reduce_averages_in_float(self):
        plane = np.array([[[0.0], [1.0]], [[1.0], [0.0]]], dtype=np.float64)
        np.testing.assert_allclose(factory.box_reduce(plane), [[[0.5]]])

    def test_glb_parser_rejects_a_truncated_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "broken.glb"
            path.write_bytes(struct.pack("<III", factory.GLB_MAGIC, 2, 4096))
            with self.assertRaises(ValueError):
                factory.parse_glb(path)


if __name__ == "__main__":
    unittest.main()
