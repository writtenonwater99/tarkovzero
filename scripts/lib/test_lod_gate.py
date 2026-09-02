#!/usr/bin/env python3
"""Tests for the shared cross-LOD silhouette gate and the authoring helpers.

Two halves, and both are written against numbers measured off real builds rather
than invented:

  * `lib.gltf.lod` — the invariant the validators call. Every "must fail" case
    uses the bounds of an actual defective GLB, so the test fails if the gate is
    removed AND fails if the gate is loosened past the real defect.
  * `lib.blender.lod_grid` — the authoring helpers that stop the defect being
    re-authored. `BandLayoutTests` pins the property that was missing: the union
    of a band's parts does not depend on how many parts there are.

Pure stdlib. No Blender, no network, no game files. Discovered by
`npm run test:factory-core`.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lib.blender.lod_grid import band_fraction, outer_anchored_center, overlapping_band  # noqa: E402
from lib.gltf.lod import (  # noqa: E402
    LodContainmentError, assert_contained, bounds_record, chain_report, containment, escape_table,
)


def box(low: tuple[float, float, float], high: tuple[float, float, float]) -> dict:
    return bounds_record(low, high)


# Measured off `.local-candidates/crackhouse-fixedrig/*.glb` on 2026-09-01 with
# `scripts/building-asset-factory/lod_silhouette.py`. LOD1 is 26.34 mm wider in Z
# than LOD0 — the defect BUILDING-MASSING.md §5.1 reported.
CRACKHOUSE_BEFORE = {
    0: box((-12.544113, -0.180000, -8.544414), (12.544113, 6.500000, 8.544415)),
    1: box((-12.544113, -0.180000, -8.557570), (12.544113, 6.500000, 8.557597)),
    2: box((-12.544113, -0.180000, -8.502484), (12.544113, 6.500000, 8.502484)),
}
# The same chain rebuilt after the fix in `crackhouse_factory.add_roof`: LOD1's
# Z size goes 17.115167 -> 17.088829, exactly LOD0's.
CRACKHOUSE_AFTER = {
    0: box((-12.544113, -0.180000, -8.544414), (12.544113, 6.500000, 8.544415)),
    1: box((-12.544113, -0.180000, -8.544414), (12.544113, 6.500000, 8.544415)),
    2: box((-12.544113, -0.180000, -8.502484), (12.544113, 6.500000, 8.502484)),
}
# Measured off `.local-candidates/industrial-props-freeze/glb/tanker-wagon-*.glb`.
# LOD1 stands 15 mm proud of LOD0 on both sides of Z.
TANKER_BEFORE = {
    0: box((-7.420000, 0.000000, -1.457000), (7.420000, 4.677000, 1.457000)),
    1: box((-7.420000, 0.000000, -1.472000), (7.420000, 4.677000, 1.472000)),
    2: box((-7.420000, 0.000000, -1.472000), (7.420000, 4.235000, 1.472000)),
}
# Measured off the shipped, ADMITTED `public/assets/3d/customs/authored/fortress`.
FORTRESS_SHIPPED = {
    0: box((-30.967751, 0.417496, -16.686657), (30.638618, 18.198912, 16.564327)),
    1: box((-30.967751, 0.417496, -16.686657), (30.598619, 18.214580, 16.564327)),
    2: box((-30.967751, 0.417496, -16.686657), (30.638618, 18.230173, 16.564327)),
}
FORTRESS_KNOWN = {
    (1, "step", "y", "max"): 15.6681,
    (1, "againstLod0", "y", "max"): 15.6681,
    (2, "step", "x", "max"): 40.0,
    (2, "step", "y", "max"): 15.5926,
    (2, "againstLod0", "y", "max"): 31.2607,
}


class RealDefectTests(unittest.TestCase):
    """The gate must reject the three chains that were actually shipped broken."""

    def test_crackhouse_lod1_roof_tile_growth_is_caught(self) -> None:
        with self.assertRaises(LodContainmentError) as raised:
            assert_contained(CRACKHOUSE_BEFORE, "crackhouse-shell")
        message = str(raised.exception)
        self.assertIn("crackhouse-shell", message)
        self.assertIn("z.max", message)
        # 26.34 mm of total width, i.e. ~13.17 mm per side.
        self.assertIn("13.1", message)

    def test_crackhouse_after_the_roof_fix_passes(self) -> None:
        report = assert_contained(CRACKHOUSE_AFTER, "crackhouse-shell")
        self.assertEqual(report["status"], "PASS")

    def test_tanker_wagon_tank_band_growth_is_caught(self) -> None:
        with self.assertRaises(LodContainmentError) as raised:
            assert_contained(TANKER_BEFORE, "tanker-wagon/default")
        message = str(raised.exception)
        self.assertIn("+15.0000 mm", message)
        # Both sides escape, which is what a centre-anchored fat member does.
        self.assertIn("z.min", message)
        self.assertIn("z.max", message)

    def test_fortress_growth_is_caught_when_it_is_not_pinned(self) -> None:
        with self.assertRaises(LodContainmentError):
            assert_contained(FORTRESS_SHIPPED, "fortress-shell")

    def test_the_fortress_waiver_admits_exactly_the_reviewed_defect(self) -> None:
        report = assert_contained(FORTRESS_SHIPPED, "fortress-shell", known_growth=FORTRESS_KNOWN)
        self.assertEqual(report["status"], "PASS-WITH-PINNED-KNOWN-DEFECT")
        self.assertEqual(len(report["knownGrowthMm"]), len(FORTRESS_KNOWN))

    def test_the_waiver_is_a_tripwire_not_a_mute_button(self) -> None:
        # Anything the waiver does not name still fails, even on the same axis.
        worse = dict(FORTRESS_SHIPPED)
        worse[1] = box((-30.967751, 0.417496, -16.700000), (30.598619, 18.214580, 16.564327))
        with self.assertRaisesRegex(LodContainmentError, "z.min"):
            assert_contained(worse, "fortress-shell", known_growth=FORTRESS_KNOWN)

    def test_the_waiver_fails_loudly_when_the_defect_is_fixed(self) -> None:
        # Fixing fortress is a founder decision with a stated cost. The waiver's
        # job is to make that decision visible, so a build that quietly stops
        # growing must not slip through as a silent pass.
        fixed = dict(FORTRESS_SHIPPED)
        fixed[1] = box((-30.967751, 0.417496, -16.686657), (30.598619, 18.198912, 16.564327))
        fixed[2] = box((-30.967751, 0.417496, -16.686657), (30.638618, 18.198912, 16.564327))
        with self.assertRaisesRegex(LodContainmentError, "no longer matches"):
            assert_contained(fixed, "fortress-shell", known_growth=FORTRESS_KNOWN)


class ContainmentTests(unittest.TestCase):
    def test_shrinking_is_contained(self) -> None:
        result = containment(box((-1, -1, -1), (1, 1, 1)), box((-0.9, -0.9, -0.9), (0.9, 0.9, 0.9)))
        self.assertTrue(result["contained"])
        self.assertEqual(result["worstGrowthMm"], 0.0)

    def test_equal_size_shifted_box_still_escapes(self) -> None:
        result = containment(box((-1, -1, -1), (1, 1, 1)), box((-0.995, -1, -1), (1.005, 1, 1)))
        self.assertFalse(result["contained"])
        self.assertEqual(result["widthDeltaMm"][0], 0.0)
        self.assertAlmostEqual(result["worstGrowthMm"], 5.0, places=6)

    def test_a_missing_size_is_derived_rather_than_refused(self) -> None:
        # Validator bounds records carry sizeM; hand-written ones may not.
        result = containment({"min": [-1, -1, -1], "max": [1, 1, 1]}, box((-1, -1, -1), (1, 1, 1)))
        self.assertTrue(result["contained"])

    def test_malformed_bounds_are_refused(self) -> None:
        with self.assertRaisesRegex(LodContainmentError, "three-component"):
            containment({"min": [0, 0], "max": [1, 1]}, box((-1, -1, -1), (1, 1, 1)))

    def test_negative_tolerance_is_refused(self) -> None:
        with self.assertRaisesRegex(LodContainmentError, "tolerance"):
            containment(box((-1, -1, -1), (1, 1, 1)), box((-1, -1, -1), (1, 1, 1)), tolerance_mm=-1.0)


class ChainShapeTests(unittest.TestCase):
    def test_chain_must_start_at_lod0_and_be_consecutive(self) -> None:
        level = box((-1, -1, -1), (1, 1, 1))
        with self.assertRaisesRegex(LodContainmentError, "start at LOD0"):
            chain_report({1: level, 2: level})
        with self.assertRaisesRegex(LodContainmentError, "consecutive"):
            chain_report({0: level, 2: level})
        with self.assertRaisesRegex(LodContainmentError, "at least two"):
            chain_report({0: level})

    def test_lod2_inside_lod1_but_outside_lod0_still_fails(self) -> None:
        report = chain_report({
            0: box((-2, -2, -2), (2, 2, 2)),
            1: box((-2, -2, -2.05), (2, 2, 2.05)),
            2: box((-2, -2, -2.01), (2, 2, 2.01)),
        })
        self.assertEqual(report["status"], "FAIL")
        lod2 = next(row for row in report["comparisons"] if row["lod"] == 2)
        self.assertTrue(lod2["step"]["contained"])
        self.assertFalse(lod2["againstLod0"]["contained"])

    def test_escape_table_keys_match_the_waiver_shape(self) -> None:
        table = escape_table(chain_report(TANKER_BEFORE))
        self.assertIn((1, "step", "z", "max"), table)
        self.assertAlmostEqual(table[(1, "step", "z", "max")], 15.0, places=4)


class BandLayoutTests(unittest.TestCase):
    """The property the roof was missing: the band's outline is count-independent."""

    def union(self, count: int, span: float, overlap: float, start: float = 0.0) -> tuple[float, float]:
        parts = [overlapping_band(index, count, span, overlap, start) for index in range(count)]
        return min(c - l / 2 for c, l in parts), max(c + l / 2 for c, l in parts)

    def test_the_union_is_the_band_whatever_the_part_count(self) -> None:
        for count in (1, 2, 3, 6, 12, 24, 37):
            low, high = self.union(count, 5.5, 0.08)
            self.assertAlmostEqual(low, 0.0, places=12, msg=f"count={count}")
            self.assertAlmostEqual(high, 5.5, places=12, msg=f"count={count}")

    def test_the_crackhouse_row_counts_agree_exactly(self) -> None:
        # 12 rows at LOD0 and 6 at LOD1 is the pair that produced the defect.
        self.assertEqual(self.union(12, 5.5, 0.08), self.union(6, 5.5, 0.08))

    def test_the_old_centre_based_layout_would_have_failed_this(self) -> None:
        # Reproduces the pre-fix formula so the test states what it is replacing:
        # centre at (row + .5)/rows, length 1.08 cells, no clamping.
        def old_union(count: int, span: float) -> tuple[float, float]:
            cell = span / count
            edges = [((index + 0.5) * cell - cell * 0.54, (index + 0.5) * cell + cell * 0.54) for index in range(count)]
            return min(e[0] for e in edges), max(e[1] for e in edges)

        overshoot_12 = old_union(12, 5.5)[1] - 5.5
        overshoot_6 = old_union(6, 5.5)[1] - 5.5
        self.assertGreater(overshoot_12, 0.0)
        self.assertAlmostEqual(overshoot_6, 2 * overshoot_12, places=12)

    def test_interior_parts_still_lap_and_end_parts_are_clipped(self) -> None:
        cell = 1.0
        self.assertAlmostEqual(overlapping_band(1, 4, 4.0, 0.08)[1], cell * 1.08, places=12)
        self.assertAlmostEqual(overlapping_band(0, 4, 4.0, 0.08)[1], cell * 1.04, places=12)
        self.assertAlmostEqual(overlapping_band(3, 4, 4.0, 0.08)[1], cell * 1.04, places=12)

    def test_zero_overlap_tiles_exactly(self) -> None:
        self.assertEqual(overlapping_band(2, 5, 5.0, 0.0), (2.5, 1.0))

    def test_band_fraction_is_the_unit_interval_case(self) -> None:
        self.assertEqual(band_fraction(1, 4, 0.08), overlapping_band(1, 4, 1.0, 0.08))

    def test_junk_arguments_are_refused(self) -> None:
        for bad in (
            lambda: overlapping_band(-1, 4, 1.0, 0.08),
            lambda: overlapping_band(4, 4, 1.0, 0.08),
            lambda: overlapping_band(0, 0, 1.0, 0.08),
            lambda: overlapping_band(0, 4, 0.0, 0.08),
            lambda: overlapping_band(0, 4, 1.0, -0.1),
            lambda: overlapping_band(0, 4, 1.0, 3.0),
        ):
            with self.assertRaises(ValueError):
                bad()


class OuterAnchorTests(unittest.TestCase):
    """The second mechanism: a member that gets thicker must not move outward."""

    def test_the_tanker_band_envelope_stops_depending_on_the_lod(self) -> None:
        outer = 1.457  # tank_radius 1.40 + 0.012 + LOD0's 0.045 tube
        for tube in (0.045, 0.06):
            self.assertAlmostEqual(outer_anchored_center(outer, tube) + tube, outer, places=12)

    def test_lod0_geometry_is_preserved_exactly(self) -> None:
        # The fix must not move LOD0, which is what kept 13 of the 15 industrial
        # GLBs byte-identical through this change.
        self.assertEqual(outer_anchored_center(1.40 + 0.057, 0.045), 1.40 + 0.012)

    def test_impossible_members_are_refused(self) -> None:
        with self.assertRaises(ValueError):
            outer_anchored_center(0.1, -0.01)
        with self.assertRaises(ValueError):
            outer_anchored_center(0.1, 0.2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
