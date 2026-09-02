#!/usr/bin/env python3
"""Tests for the cross-LOD silhouette containment gate.

Every fixture is a real GLB container written by this file, so the reader is exercised
against the bytes it will meet in production rather than against a dict. No Blender, no
network, no game files.

The last test is the one that matters: pointed at the real Crackhouse candidate through
`TZ_CRACKHOUSE_QA_GLBS`, it asserts the gate REFUSES it. A gate that has never rejected
the artefact it was written for is a gate nobody has tested.
"""

from __future__ import annotations

import json
import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lod_silhouette import (  # noqa: E402
    SilhouetteError,
    containment,
    evaluate,
    main,
    node_local_matrix,
    parse_glb_arguments,
    read_glb_json,
    scene_bounds,
)


def pad(payload: bytes, filler: bytes) -> bytes:
    return payload + filler * ((4 - len(payload) % 4) % 4)


def write_glb(path: Path, document: dict, binary: bytes = b"\x00\x00\x00\x00") -> Path:
    json_chunk = pad(json.dumps(document, separators=(",", ":")).encode("utf-8"), b" ")
    bin_chunk = pad(binary, b"\x00")
    body = (
        struct.pack("<II", len(json_chunk), 0x4E4F534A) + json_chunk
        + struct.pack("<II", len(bin_chunk), 0x004E4942) + bin_chunk
    )
    path.write_bytes(b"glTF" + struct.pack("<II", 2, 12 + len(body)) + body)
    return path


def box_document(half: tuple[float, float, float], *, node_extra: dict | None = None) -> dict:
    """One mesh whose POSITION accessor declares a box of the given half-extents."""
    node = {"mesh": 0, "name": "Box"}
    node.update(node_extra or {})
    return {
        "asset": {"version": "2.0"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [node],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
        "accessors": [{
            "bufferView": 0, "componentType": 5126, "count": 8, "type": "VEC3",
            "min": [-half[0], -half[1], -half[2]],
            "max": [half[0], half[1], half[2]],
        }],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": 4}],
        "buffers": [{"byteLength": 4}],
    }


class ReaderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def test_reads_a_well_formed_glb(self) -> None:
        path = write_glb(self.dir / "a.glb", box_document((1.0, 2.0, 3.0)))
        document = read_glb_json(path)
        bounds = scene_bounds(document)
        self.assertEqual(bounds["sizeM"], [2.0, 4.0, 6.0])
        self.assertEqual(bounds["primitives"], 1)

    def test_node_translation_moves_the_bounds(self) -> None:
        path = write_glb(self.dir / "t.glb", box_document((1.0, 1.0, 1.0), node_extra={"translation": [10.0, 0.0, 0.0]}))
        bounds = scene_bounds(read_glb_json(path))
        self.assertEqual(bounds["min"][0], 9.0)
        self.assertEqual(bounds["max"][0], 11.0)

    def test_rotated_node_sweeps_the_whole_box(self) -> None:
        # 90 degrees about Y swaps the X and Z extents of a 1 x 1 x 4 box.
        rotation = [0.0, 0.7071067811865476, 0.0, 0.7071067811865476]
        path = write_glb(self.dir / "r.glb", box_document((0.5, 0.5, 2.0), node_extra={"rotation": rotation}))
        bounds = scene_bounds(read_glb_json(path))
        self.assertAlmostEqual(bounds["sizeM"][0], 4.0, places=9)
        self.assertAlmostEqual(bounds["sizeM"][2], 1.0, places=9)

    def test_explicit_matrix_is_column_major(self) -> None:
        column_major = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1]
        matrix = node_local_matrix({"matrix": column_major})
        self.assertEqual([matrix[row][3] for row in range(3)], [5.0, 6.0, 7.0])

    def test_refuses_external_buffer(self) -> None:
        document = box_document((1.0, 1.0, 1.0))
        document["buffers"][0]["uri"] = "external.bin"
        path = write_glb(self.dir / "x.glb", document)
        with self.assertRaisesRegex(SilhouetteError, "external buffer"):
            read_glb_json(path)

    def test_refuses_missing_accessor_bounds(self) -> None:
        document = box_document((1.0, 1.0, 1.0))
        del document["accessors"][0]["max"]
        path = write_glb(self.dir / "n.glb", document)
        with self.assertRaisesRegex(SilhouetteError, "declared min/max"):
            scene_bounds(read_glb_json(path))

    def test_refuses_a_truncated_container(self) -> None:
        path = write_glb(self.dir / "c.glb", box_document((1.0, 1.0, 1.0)))
        path.write_bytes(path.read_bytes()[:-8])
        with self.assertRaisesRegex(SilhouetteError, "header length"):
            read_glb_json(path)

    def test_refuses_a_non_glb(self) -> None:
        path = self.dir / "not.glb"
        path.write_bytes(b"this is not a glb at all, not even close")
        with self.assertRaisesRegex(SilhouetteError, "not a GLB container"):
            read_glb_json(path)


class ContainmentTests(unittest.TestCase):
    def bounds(self, half: tuple[float, float, float]) -> dict:
        return {
            "min": [-half[0], -half[1], -half[2]],
            "max": [half[0], half[1], half[2]],
            "sizeM": [2 * half[0], 2 * half[1], 2 * half[2]],
        }

    def test_shrinking_is_contained(self) -> None:
        result = containment(self.bounds((1.0, 1.0, 1.0)), self.bounds((0.9, 0.9, 0.9)))
        self.assertTrue(result["contained"])
        self.assertEqual(result["worstGrowthMm"], 0.0)

    def test_growth_is_reported_per_axis_and_side(self) -> None:
        result = containment(self.bounds((1.0, 1.0, 1.0)), self.bounds((1.0, 1.0, 1.02)))
        self.assertFalse(result["contained"])
        self.assertAlmostEqual(result["worstGrowthMm"], 20.0, places=6)
        self.assertEqual(
            sorted((row["axis"], row["side"]) for row in result["escapes"]),
            [("z", "max"), ("z", "min")],
        )
        self.assertAlmostEqual(result["widthDeltaMm"][2], 40.0, places=6)

    def test_a_shifted_box_of_equal_size_still_escapes(self) -> None:
        # Same width, moved 5 mm: the width delta is zero and the box is still outside.
        finer = self.bounds((1.0, 1.0, 1.0))
        coarser = {"min": [-0.995, -1.0, -1.0], "max": [1.005, 1.0, 1.0], "sizeM": [2.0, 2.0, 2.0]}
        result = containment(finer, coarser)
        self.assertFalse(result["contained"])
        self.assertEqual(result["widthDeltaMm"][0], 0.0)
        self.assertAlmostEqual(result["worstGrowthMm"], 5.0, places=6)

    def test_tolerance_admits_but_still_measures(self) -> None:
        result = containment(self.bounds((1.0, 1.0, 1.0)), self.bounds((1.0, 1.0, 1.001)), tolerance_mm=2.0)
        self.assertTrue(result["contained"])
        self.assertAlmostEqual(result["worstGrowthMm"], 1.0, places=6)


class ChainTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def chain(self, halves: list[tuple[float, float, float]]) -> dict[int, Path]:
        return {
            lod: write_glb(self.dir / f"lod{lod}.glb", box_document(half))
            for lod, half in enumerate(halves)
        }

    def test_a_shrinking_chain_passes(self) -> None:
        report = evaluate(self.chain([(2.0, 2.0, 2.0), (1.9, 1.9, 1.9), (1.8, 1.8, 1.8)]))
        self.assertEqual(report["status"], "PASS")
        self.assertEqual(len(report["comparisons"]), 2)

    def test_a_growing_middle_level_fails(self) -> None:
        report = evaluate(self.chain([(2.0, 2.0, 2.0), (2.0, 2.0, 2.02), (1.8, 1.8, 1.8)]))
        self.assertEqual(report["status"], "FAIL")
        failing = [row for row in report["comparisons"] if not row["step"]["contained"]]
        self.assertEqual([row["lod"] for row in failing], [1])
        self.assertAlmostEqual(failing[0]["step"]["worstGrowthMm"], 20.0, places=6)

    def test_lod2_inside_lod1_but_outside_lod0_is_still_a_failure(self) -> None:
        # LOD1 grew; LOD2 shrank relative to LOD1 but is still outside LOD0. Consecutive
        # containment alone would call LOD2 fine, which is why LOD0 is checked as well.
        report = evaluate(self.chain([(2.0, 2.0, 2.0), (2.0, 2.0, 2.05), (2.0, 2.0, 2.01)]))
        self.assertEqual(report["status"], "FAIL")
        lod2 = next(row for row in report["comparisons"] if row["lod"] == 2)
        self.assertTrue(lod2["step"]["contained"])
        self.assertFalse(lod2["againstLod0"]["contained"])

    def test_chain_must_start_at_lod0_and_be_consecutive(self) -> None:
        paths = self.chain([(2.0, 2.0, 2.0), (1.9, 1.9, 1.9)])
        with self.assertRaisesRegex(SilhouetteError, "start at LOD0"):
            evaluate({1: paths[0], 2: paths[1]})
        with self.assertRaisesRegex(SilhouetteError, "consecutive"):
            evaluate({0: paths[0], 2: paths[1]})
        with self.assertRaisesRegex(SilhouetteError, "at least two"):
            evaluate({0: paths[0]})

    def test_argument_parsing_refuses_junk(self) -> None:
        with self.assertRaisesRegex(SilhouetteError, "LOD=path"):
            parse_glb_arguments(["/tmp/a.glb"])
        with self.assertRaisesRegex(SilhouetteError, "non-negative integer"):
            parse_glb_arguments(["x=/tmp/a.glb"])
        with self.assertRaisesRegex(SilhouetteError, "supplied twice"):
            parse_glb_arguments(["0=/tmp/a.glb", "0=/tmp/b.glb"])

    def test_cli_exit_codes_and_report_only(self) -> None:
        paths = self.chain([(2.0, 2.0, 2.0), (2.0, 2.0, 2.02)])
        argv = [f"--glb=0={paths[0]}", f"--glb=1={paths[1]}"]
        self.assertEqual(main(argv), 1)
        self.assertEqual(main(argv + ["--report-only"]), 0)
        out = self.dir / "qa" / "report.json"
        self.assertEqual(main(argv + ["--report-only", f"--output={out}"]), 0)
        self.assertEqual(json.loads(out.read_text())["status"], "FAIL")
        # No-clobber, like every other receipt in this lane.
        self.assertEqual(main(argv + ["--report-only", f"--output={out}"]), 2)


class RealCandidateTests(unittest.TestCase):
    """Runs only when TZ_CRACKHOUSE_QA_GLBS names the three built LODs, comma-separated."""

    def test_the_shipped_crackhouse_candidate_is_refused(self) -> None:
        raw = os.environ.get("TZ_CRACKHOUSE_QA_GLBS", "").strip()
        if not raw:
            self.skipTest("TZ_CRACKHOUSE_QA_GLBS not set")
        paths = {lod: Path(value.strip()) for lod, value in enumerate(raw.split(","))}
        self.assertEqual(sorted(paths), [0, 1, 2], "expected exactly three LOD paths")
        report = evaluate(paths)
        self.assertEqual(report["status"], "FAIL", "the known LOD1 roof-tile growth must be caught")
        lod1 = next(row for row in report["comparisons"] if row["lod"] == 1)
        self.assertFalse(lod1["step"]["contained"])
        # The defect is on Z, both sides, at roughly 13 mm per side.
        self.assertEqual(sorted(row["axis"] for row in lod1["step"]["escapes"]), ["z", "z"])
        self.assertGreater(lod1["step"]["worstGrowthMm"], 5.0)
        self.assertLess(lod1["step"]["worstGrowthMm"], 40.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
