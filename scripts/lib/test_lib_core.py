#!/usr/bin/env python3
"""The shared core must reproduce, bit for bit, what each factory had before.

Every DIVERGED function that moved into ``lib`` is checked here against a
verbatim copy of the original body, taken from the three factories at the
commit this consolidation started from. If a variant ever drifts, or if someone
"tidies" two variants into one, these tests fail loudly and name the asset whose
texture bytes would move.

The copies below are reference oracles. They are supposed to be duplicated code
— that is the whole point — so do not refactor them to call the shared module.

Runs under plain ``python3``; nothing here imports ``bpy``.

    python3 -m unittest scripts/lib/test_lib_core.py -v
"""

from __future__ import annotations

import math
import struct
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lib.blender import noise
from lib.gltf import read


# --------------------------------------------------------------------------
# Verbatim originals. Do not touch except to correct a transcription error.
# --------------------------------------------------------------------------

def original_hash01_fortress_crackhouse(x: int, y: int, seed: int) -> float:
    value = (x * 0x1F123BB5 + y * 0x5F356495 + seed * 0x6C8E9CF5) & 0xFFFFFFFF
    value ^= value >> 16
    value = (value * 0x7FEB352D) & 0xFFFFFFFF
    value ^= value >> 15
    value = (value * 0x846CA68B) & 0xFFFFFFFF
    value ^= value >> 16
    return value / 0xFFFFFFFF


def original_hash01_industrial(x: int, y: int, seed: int) -> float:
    value = (x * 0x1F123BB5) ^ (y * 0x5F356495) ^ (seed * 0x6C8E9CF5)
    value ^= value >> 16
    value = (value * 0x7FEB352D) & 0xFFFFFFFF
    value ^= value >> 15
    value = (value * 0x846CA68B) & 0xFFFFFFFF
    value ^= value >> 16
    return value / 0xFFFFFFFF


def original_smoothstep_fortress_crackhouse(value: float) -> float:
    return value * value * (3.0 - 2.0 * value)


def original_smoothstep_industrial(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return value * value * (3.0 - 2.0 * value)


def original_tile_value_noise_fortress(x, y, size, cell, seed):
    grid = max(2, size // cell)
    gx = x / cell
    gy = y / cell
    x0 = math.floor(gx) % grid
    y0 = math.floor(gy) % grid
    tx = original_smoothstep_fortress_crackhouse(gx - math.floor(gx))
    ty = original_smoothstep_fortress_crackhouse(gy - math.floor(gy))
    a = original_hash01_fortress_crackhouse(x0, y0, seed)
    b = original_hash01_fortress_crackhouse((x0 + 1) % grid, y0, seed)
    c = original_hash01_fortress_crackhouse(x0, (y0 + 1) % grid, seed)
    d = original_hash01_fortress_crackhouse((x0 + 1) % grid, (y0 + 1) % grid, seed)
    top = a + (b - a) * tx
    bottom = c + (d - c) * tx
    return top + (bottom - top) * ty


def original_tile_noise_crackhouse(x, y, size, cell, seed):
    grid = max(2, size // max(1, cell))
    gx, gy = x / cell, y / cell
    x0, y0 = math.floor(gx) % grid, math.floor(gy) % grid
    tx = original_smoothstep_fortress_crackhouse(gx - math.floor(gx))
    ty = original_smoothstep_fortress_crackhouse(gy - math.floor(gy))
    a = original_hash01_fortress_crackhouse(x0, y0, seed)
    b = original_hash01_fortress_crackhouse((x0 + 1) % grid, y0, seed)
    c = original_hash01_fortress_crackhouse(x0, (y0 + 1) % grid, seed)
    d = original_hash01_fortress_crackhouse((x0 + 1) % grid, (y0 + 1) % grid, seed)
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty


def original_periodic_noise_industrial(x, y, size, cells, seed):
    scale = size / cells
    gx = x / scale
    gy = y / scale
    x0 = math.floor(gx)
    y0 = math.floor(gy)
    tx = original_smoothstep_industrial(gx - x0)
    ty = original_smoothstep_industrial(gy - y0)
    x1 = (x0 + 1) % cells
    y1 = (y0 + 1) % cells
    x0 %= cells
    y0 %= cells
    a = original_hash01_industrial(x0, y0, seed)
    b = original_hash01_industrial(x1, y0, seed)
    c = original_hash01_industrial(x0, y1, seed)
    d = original_hash01_industrial(x1, y1, seed)
    top = a + (b - a) * tx
    bottom = c + (d - c) * tx
    return top + (bottom - top) * ty


def bits(value: float) -> int:
    """Exact bit pattern, so 'equal' means equal and not 'close enough'."""
    return struct.unpack("<Q", struct.pack("<d", value))[0]


SAMPLE_COORDS = [(x, y) for x in range(0, 131, 7) for y in range(0, 131, 11)]
SAMPLE_SEEDS = (0, 1, 31, 97, 211, 401, 907, 65535, 1234567)


class Hash01Variants(unittest.TestCase):
    def test_masked_sum_matches_fortress_and_crackhouse(self):
        for x, y in SAMPLE_COORDS:
            for seed in SAMPLE_SEEDS:
                self.assertEqual(
                    bits(noise.hash01(x, y, seed, variant=noise.HASH01_MASKED_SUM)),
                    bits(original_hash01_fortress_crackhouse(x, y, seed)),
                    f"masked-sum hash01 drifted at ({x},{y},{seed})")

    def test_xor_unmasked_matches_industrial(self):
        for x, y in SAMPLE_COORDS:
            for seed in SAMPLE_SEEDS:
                self.assertEqual(
                    bits(noise.hash01(x, y, seed, variant=noise.HASH01_XOR_UNMASKED)),
                    bits(original_hash01_industrial(x, y, seed)),
                    f"xor-unmasked hash01 drifted at ({x},{y},{seed})")

    def test_the_two_variants_really_do_disagree(self):
        """If these ever agree, the divergence was resolved somewhere unrecorded."""
        disagreements = sum(
            noise.hash01(x, y, seed, variant=noise.HASH01_MASKED_SUM)
            != noise.hash01(x, y, seed, variant=noise.HASH01_XOR_UNMASKED)
            for x, y in SAMPLE_COORDS for seed in SAMPLE_SEEDS)
        self.assertGreater(disagreements, len(SAMPLE_COORDS),
                           "the two hash01 variants no longer differ — a re-baseline happened")

    def test_unknown_variant_is_rejected(self):
        with self.assertRaises(ValueError):
            noise.hash01(1, 2, 3, variant="whatever")

    def test_variant_is_keyword_only_and_has_no_default(self):
        with self.assertRaises(TypeError):
            noise.hash01(1, 2, 3)


class SmoothstepVariants(unittest.TestCase):
    VALUES = (-2.0, -0.25, 0.0, 0.1, 0.5, 0.9, 1.0, 1.25, 3.0)

    def test_unclamped_matches_fortress_and_crackhouse(self):
        for value in self.VALUES:
            self.assertEqual(
                bits(noise.smoothstep(value, variant=noise.SMOOTHSTEP_UNCLAMPED)),
                bits(original_smoothstep_fortress_crackhouse(value)))

    def test_clamped_matches_industrial(self):
        for value in self.VALUES:
            self.assertEqual(
                bits(noise.smoothstep(value, variant=noise.SMOOTHSTEP_CLAMPED)),
                bits(original_smoothstep_industrial(value)))

    def test_variants_differ_outside_the_unit_interval(self):
        self.assertNotEqual(noise.smoothstep(1.25, variant=noise.SMOOTHSTEP_UNCLAMPED),
                            noise.smoothstep(1.25, variant=noise.SMOOTHSTEP_CLAMPED))

    def test_unknown_variant_is_rejected(self):
        with self.assertRaises(ValueError):
            noise.smoothstep(0.5, variant="nope")


class TileNoiseVariants(unittest.TestCase):
    CASES = [(x, y, size, cell, seed)
             for size in (32, 64, 128)
             for cell in (2, 4, 8, 16)
             for seed in (0, 31, 503)
             for x, y in ((0, 0), (3, 17), (31, 5), (63, 63), (100, 27))]

    def test_cell_pixels_lerp_matches_fortress(self):
        for x, y, size, cell, seed in self.CASES:
            self.assertEqual(
                bits(noise.tile_noise_cell_pixels_lerp(
                    x, y, size, cell, seed,
                    hash_variant=noise.HASH01_MASKED_SUM,
                    smoothstep_variant=noise.SMOOTHSTEP_UNCLAMPED)),
                bits(original_tile_value_noise_fortress(x, y, size, cell, seed)),
                f"fortress tile noise drifted at {(x, y, size, cell, seed)}")

    def test_cell_pixels_mix_matches_crackhouse(self):
        for x, y, size, cell, seed in self.CASES:
            self.assertEqual(
                bits(noise.tile_noise_cell_pixels_mix(
                    x, y, size, cell, seed,
                    hash_variant=noise.HASH01_MASKED_SUM,
                    smoothstep_variant=noise.SMOOTHSTEP_UNCLAMPED)),
                bits(original_tile_noise_crackhouse(x, y, size, cell, seed)),
                f"crackhouse tile noise drifted at {(x, y, size, cell, seed)}")

    def test_cell_count_lerp_matches_industrial(self):
        for x, y, size, cells, seed in self.CASES:
            self.assertEqual(
                bits(noise.tile_noise_cell_count_lerp(
                    x, y, size, cells, seed,
                    hash_variant=noise.HASH01_XOR_UNMASKED,
                    smoothstep_variant=noise.SMOOTHSTEP_CLAMPED)),
                bits(original_periodic_noise_industrial(x, y, size, cells, seed)),
                f"industrial tile noise drifted at {(x, y, size, cells, seed)}")

    def test_lerp_and_mix_forms_are_not_interchangeable(self):
        """`a+(b-a)*t` vs `a*(1-t)+b*t`: algebraically equal, not equal in float."""
        differing = sum(
            bits(noise.tile_noise_cell_pixels_lerp(
                x, y, size, cell, seed,
                hash_variant=noise.HASH01_MASKED_SUM,
                smoothstep_variant=noise.SMOOTHSTEP_UNCLAMPED))
            != bits(noise.tile_noise_cell_pixels_mix(
                x, y, size, cell, seed,
                hash_variant=noise.HASH01_MASKED_SUM,
                smoothstep_variant=noise.SMOOTHSTEP_UNCLAMPED))
            for x, y, size, cell, seed in self.CASES)
        self.assertGreater(
            differing, 0,
            "the fortress and crackhouse noise forms now agree bit-for-bit; "
            "if that is intended it is a re-baseline, not a refactor")

    def test_profile_table_names_real_functions(self):
        for factory, profile in noise.FACTORY_NOISE_PROFILES.items():
            self.assertIn(profile["hash01"], noise.HASH01_VARIANTS, factory)
            self.assertIn(profile["smoothstep"], noise.SMOOTHSTEP_VARIANTS, factory)
            self.assertTrue(hasattr(noise, profile["tile_noise"]), factory)


class GltfReadHelpers(unittest.TestCase):
    def test_node_matrix_from_explicit_column_major_matrix(self):
        column_major = [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 5, 6, 7, 1]
        self.assertEqual(read.node_matrix({"matrix": column_major}), [
            [2.0, 0.0, 0.0, 5.0],
            [0.0, 3.0, 0.0, 6.0],
            [0.0, 0.0, 4.0, 7.0],
            [0.0, 0.0, 0.0, 1.0],
        ])

    def test_node_matrix_rejects_a_malformed_matrix(self):
        with self.assertRaises(ValueError):
            read.node_matrix({"matrix": [1, 2, 3]})

    def test_node_matrix_defaults_to_identity(self):
        self.assertEqual(read.node_matrix({}), read.identity4())

    def test_node_matrix_from_trs(self):
        got = read.node_matrix({"translation": [1, 2, 3], "scale": [2, 2, 2]})
        self.assertEqual([row[3] for row in got], [1.0, 2.0, 3.0, 1.0])
        self.assertEqual(got[0][0], 2.0)

    def test_matrix_multiply_is_row_major_and_aliased_as_multiply4(self):
        a = [[1, 2, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
        b = [[1, 0, 0, 3], [0, 1, 0, 4], [0, 0, 1, 0], [0, 0, 0, 1]]
        self.assertEqual(read.matrix_multiply(a, b)[0], [1, 2, 0, 11])
        self.assertIs(read.multiply4, read.matrix_multiply)

    def test_close_requires_an_explicit_tolerance(self):
        with self.assertRaises(TypeError):
            read.close(1.0, 1.0)

    def test_close_and_vector_close(self):
        self.assertTrue(read.close(1.00001, 1.0, 1e-4))
        self.assertFalse(read.close(1.00001, 1.0, 1e-6))
        self.assertFalse(read.close("nan", 1.0, 1e-4))
        self.assertFalse(read.close(None, 1.0, 1e-4))
        self.assertTrue(read.vector_close([1.0, 2.0], [1.0, 2.0], 1e-9))
        self.assertFalse(read.vector_close([1.0], [1.0, 2.0], 1e-9))
        self.assertFalse(read.vector_close("no", [1.0], 1e-9))

    def test_require_raises_value_error(self):
        read.require(True, "fine")
        with self.assertRaises(ValueError):
            read.require(False, "boom")

    def test_transform_point_applies_translation(self):
        world = read.node_matrix({"translation": [10, 0, 0]})
        self.assertEqual(read.transform_point(world, (1, 2, 3)), [11.0, 2.0, 3.0])

    def test_primitive_triangles_by_mode(self):
        document = {"accessors": [{"count": 12}, {"count": 9}]}
        self.assertEqual(read.primitive_triangles(document, {"indices": 0, "mode": 4}, 1), 4)
        self.assertEqual(read.primitive_triangles(document, {"indices": 0, "mode": 5}, 1), 10)
        self.assertEqual(read.primitive_triangles(document, {"mode": 4}, 1), 3)
        with self.assertRaises(ValueError):
            read.primitive_triangles(document, {"indices": 0, "mode": 0}, 1)

    def test_iter_mesh_primitives_composes_parent_transforms(self):
        document = {
            "scene": 0,
            "scenes": [{"nodes": [0]}],
            "nodes": [
                {"translation": [10, 0, 0], "children": [1]},
                {"translation": [0, 5, 0], "mesh": 0, "name": "child"},
            ],
            "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
            "accessors": [{"count": 3, "min": [0, 0, 0], "max": [1, 1, 1]}],
        }
        found = list(read.iter_mesh_primitives(document))
        self.assertEqual(len(found), 1)
        self.assertEqual([row[3] for row in found[0].world], [10.0, 5.0, 0.0, 1.0])

    def test_iter_mesh_primitives_select_still_descends_into_children(self):
        document = {
            "scene": 0,
            "scenes": [{"nodes": [0]}],
            "nodes": [
                {"name": "skip", "mesh": 0, "children": [1]},
                {"name": "keep", "mesh": 0},
            ],
            "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
            "accessors": [{"count": 3}],
        }
        kept = [row.node["name"]
                for row in read.iter_mesh_primitives(
                    document, select=lambda node: node.get("name") == "keep")]
        self.assertEqual(kept, ["keep"])

    def test_iter_mesh_primitives_rejects_a_bad_default_scene(self):
        with self.assertRaises(ValueError):
            list(read.iter_mesh_primitives({"scene": 4, "scenes": [{"nodes": []}]}))

    def test_expand_bounds_covers_all_eight_corners(self):
        minimum, maximum = [math.inf] * 3, [-math.inf] * 3
        read.expand_bounds(minimum, maximum, read.identity4(), (-1, -2, -3), (4, 5, 6))
        self.assertEqual(minimum, [-1.0, -2.0, -3.0])
        self.assertEqual(maximum, [4.0, 5.0, 6.0])

    def test_position_bounds_rejects_non_finite_when_asked(self):
        document = {"accessors": [{"min": [0, 0, 0], "max": [1, 1, float("inf")]}]}
        read.position_bounds(document, 0)
        with self.assertRaises(ValueError):
            read.position_bounds(document, 0, require_finite=True)

    def test_named_requires_exactly_one_match(self):
        document = {"nodes": [{"name": "a"}, {"name": "b"}, {"name": "b"}]}
        self.assertEqual(read.named(document, "a"), {"name": "a"})
        with self.assertRaises(ValueError):
            read.named(document, "b")
        with self.assertRaises(ValueError):
            read.named(document, "missing")


class GlbContainer(unittest.TestCase):
    @staticmethod
    def build(document_bytes: bytes, *, magic=b"glTF", version=2, declared=None,
              extra_json_chunk=False) -> bytes:
        padding = (-len(document_bytes)) % 4
        json_chunk = document_bytes + b" " * padding
        body = struct.pack("<II", len(json_chunk), read.GLB_JSON_CHUNK) + json_chunk
        if extra_json_chunk:
            body += struct.pack("<II", len(json_chunk), read.GLB_JSON_CHUNK) + json_chunk
        total = 12 + len(body)
        header = struct.pack("<4sII", magic, version, total if declared is None else declared)
        return header + body

    def write(self, blob: bytes) -> Path:
        import tempfile
        handle = tempfile.NamedTemporaryFile(suffix=".glb", delete=False)
        handle.write(blob)
        handle.close()
        self.addCleanup(lambda: Path(handle.name).unlink(missing_ok=True))
        return Path(handle.name)

    def test_reads_a_well_formed_glb(self):
        path = self.write(self.build(b'{"asset":{"version":"2.0"}}'))
        self.assertEqual(read.glb_json(path)["asset"]["version"], "2.0")

    def test_rejects_a_truncated_file(self):
        path = self.write(b"glTF" + b"\x00" * 8)
        with self.assertRaisesRegex(ValueError, "truncated GLB"):
            read.glb_json(path)

    def test_rejects_a_bad_magic(self):
        path = self.write(self.build(b"{}", magic=b"XXXX"))
        with self.assertRaisesRegex(ValueError, "invalid GLB header"):
            read.glb_json(path)

    def test_rejects_a_lying_length(self):
        path = self.write(self.build(b"{}", declared=999999))
        with self.assertRaisesRegex(ValueError, "invalid GLB header"):
            read.glb_json(path)

    def test_rejects_two_json_chunks(self):
        path = self.write(self.build(b"{}", extra_json_chunk=True))
        with self.assertRaisesRegex(ValueError, "multiple GLB JSON chunks"):
            read.glb_json(path)

    def test_label_is_appended_to_messages(self):
        path = self.write(b"glTF" + b"\x00" * 8)
        with self.assertRaisesRegex(ValueError, "sentinel-label"):
            read.glb_json(path, label="sentinel-label")

    def test_sha256_file_matches_hashlib(self):
        import hashlib
        payload = b"tarkovzero" * 1000
        path = self.write(payload)
        self.assertEqual(read.sha256_file(path), hashlib.sha256(payload).hexdigest())


if __name__ == "__main__":
    unittest.main()
