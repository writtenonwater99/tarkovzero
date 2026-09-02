#!/usr/bin/env python3
"""Synthetic tests for the Customs mesh-bounds reader.

Every fixture here is written by this suite into a temporary directory, or is a
fake in-memory Unity object.  The suite never needs, and must never be pointed
at, real game files.

The three claims that matter, and how each is PROVED rather than asserted:

* **No payload byte is physically read.**  The fixture writer independently
  returns (a) the byte ranges that constitute payload array contents and (b) the
  byte ranges the reader is permitted to read.  The tests intersect the reader's
  recorded absolute read offsets against (a) — zero hits — and require every read
  to be contained in (b).  Post-parse scrubbing would fail both by definition.
* **The guards are load-bearing.**  Every guard is mutated (patched away or its
  bound relaxed) and a test shows the mutation produces a wrong or unrefused
  result.  A guard nobody can break is a guard nobody has tested.
* **A schema error aborts the run.**  `build_bounds` is driven end to end with a
  fake UnityPy whose second Mesh diverges, and the assertion is that nothing is
  written at all — not that the bad object is skipped.
"""

import contextlib
import importlib.util
import io
import json
import math
import os
import re
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


SCRIPT_PATH = Path(__file__).with_name("extract-customs-bounds.py")
SPEC = importlib.util.spec_from_file_location("extract_customs_bounds", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
bounds = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = bounds
SPEC.loader.exec_module(bounds)

census = bounds.census

UNITY_VERSION = "2019.4.39f1"
CUSTOMS_INDEX = 637
LEVEL_NAME = f"level{CUSTOMS_INDEX}"
SHARED_NAME = f"sharedassets{CUSTOMS_INDEX}.assets"

TRUE_CENTER = (0.0, 2.10, 0.0)
TRUE_EXTENT = (7.05, 2.15, 1.52)


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


@contextlib.contextmanager
def mutate(target, name, value):
    """Replace one guard or bound, then always put it back."""
    original = getattr(target, name)
    setattr(target, name, value)
    try:
        yield
    finally:
        setattr(target, name, original)


def small_counts(path):
    """Cap the giant arrays so a mutation test can afford to walk them."""
    return min(bounds.default_count_for(path), 4096)


def flatten(node, level=0, out=None):
    """Node tree -> UnityPy's flat (level, type, name, meta_flag) node list."""
    out = [] if out is None else out
    out.append(
        SimpleNamespace(
            level=level,
            type=node.type,
            name=node.name,
            meta_flag=bounds.ALIGN_FLAG if node.align else 0,
        )
    )
    for child in node.children:
        flatten(child, level + 1, out)
    return out


def read_fixture(fixture, tree, **kwargs):
    return bounds.read_mesh_local_aabb(
        fixture.path,
        path_id=kwargs.pop("path_id", -8834771233310976271),
        object_offset=fixture.object_offset,
        byte_size=kwargs.pop("byte_size", fixture.byte_size),
        typetree=tree,
        **kwargs,
    )


def refusal_of(fn):
    try:
        fn()
    except bounds.BoundsRefusal as error:
        return error.reason
    return None


# --------------------------------------------------------------------------
# fake UnityPy surface
# --------------------------------------------------------------------------


class FakeMeshReader:
    def __init__(
        self,
        path_id,
        byte_start,
        byte_size,
        tree,
        asset_name=SHARED_NAME,
        unity_version=UNITY_VERSION,
        nodes=None,
        expose_offset=True,
    ):
        self.type = SimpleNamespace(name="Mesh")
        self.path_id = path_id
        self.byte_size = byte_size
        if expose_offset:
            self.byte_start = byte_start
        self.serialized_type = SimpleNamespace(
            nodes=flatten(tree) if nodes is None else nodes
        )
        self.assets_file = SimpleNamespace(
            name=asset_name, unity_version=unity_version, externals=[]
        )
        self.parse_calls = 0

    def parse_as_dict(self):  # pragma: no cover - must never run
        self.parse_calls += 1
        raise AssertionError("the bounds reader must never materialize a Mesh typetree")

    read_typetree = parse_as_dict
    read = parse_as_dict
    save = parse_as_dict


class FakeReader:
    """A non-Mesh reader, e.g. BuildSettings in globalgamemanagers."""

    def __init__(self, type_name, path_id, data, asset_name, byte_size=1024):
        self.type = SimpleNamespace(name=type_name)
        self.path_id = path_id
        self.byte_size = byte_size
        self.assets_file = SimpleNamespace(name=asset_name, externals=[])
        self._data = data
        self.parse_calls = 0

    def parse_as_dict(self):
        self.parse_calls += 1
        return json.loads(json.dumps(self._data))


def build_settings_reader():
    scene_paths = [f"Assets/Scenes/Synthetic/Scene{i}.unity" for i in range(714)]
    scene_paths[CUSTOMS_INDEX] = r"Assets\Scenes\Locations\Custom\CustomScene.unity"
    return FakeReader(
        "BuildSettings", 1, {"scenes": scene_paths}, asset_name="globalgamemanagers"
    )


class FakeEnvironment:
    def __init__(self, objects):
        self.objects = list(objects)

    def find_file(self, *_a, **_k):  # pragma: no cover - blocker target
        return "unsafe"

    load_file = find_file
    load_files = find_file
    load_folder = find_file
    load_assets = find_file


class FakeUnityPy:
    def __init__(self, environments):
        self.environments = environments
        self.load_calls = []

    def load(self, source):
        if isinstance(source, (str, Path)):
            raise AssertionError("UnityPy.load must receive the safe file-like wrapper")
        self.load_calls.append(source.name)
        return FakeEnvironment(self.environments.get(source.name, ()))

    def save(self, *_a, **_k):  # pragma: no cover - guard only
        raise AssertionError("the reader must never call a UnityPy save/export API")


# ==========================================================================
# A. the reader on the nominal fixture
# ==========================================================================


class ReaderCoreTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.tree = bounds.mesh_schema()
        self.fixture = bounds.write_fixture(
            str(self.tmp / "nominal.bin"), self.tree
        )

    def tearDown(self):
        self._tmp.cleanup()

    def test_emits_only_center_and_extents_and_the_values_are_exact(self):
        record, _log = read_fixture(self.fixture, self.tree)
        self.assertEqual(set(record.local_aabb()), {"center", "extents"})
        self.assertEqual(set(record.local_aabb()["center"]), {"x", "y", "z"})
        self.assertEqual(
            tuple(round(v, 6) for v in record.center), tuple(round(v, 6) for v in TRUE_CENTER)
        )
        self.assertEqual(
            tuple(round(v, 6) for v in record.extents), tuple(round(v, 6) for v in TRUE_EXTENT)
        )
        self.assertEqual(record.submesh_count, 3)

    def test_the_object_carries_large_variable_sections_on_both_sides_of_the_aabb(self):
        """A reader that walks payload is caught whichever side it walks."""
        # Locate the AABB read, then confirm payload ranges exist before AND
        # after it. Without both, a payload-walking reader could pass by luck.
        _record, log = read_fixture(self.fixture, self.tree)
        aabb_offsets = [
            offset for offset, _length, kind in log.reads if kind == "aabb"
        ]
        self.assertEqual(len(aabb_offsets), 1)
        aabb_at = aabb_offsets[0]
        before = [r for r in self.fixture.payload_ranges if r[1] <= aabb_at]
        after = [r for r in self.fixture.payload_ranges if r[0] >= aabb_at]
        self.assertTrue(before, "no payload array precedes the AABB")
        self.assertTrue(after, "no payload array follows the AABB")
        self.assertGreater(sum(e - s for s, e in before), 4 * 1024 * 1024)
        self.assertGreater(sum(e - s for s, e in after), 3 * 1024 * 1024)
        self.assertGreater(self.fixture.byte_size, 8 * 1024 * 1024)

    def test_zero_payload_bytes_are_physically_read(self):
        record, log = read_fixture(self.fixture, self.tree)
        # (1) measured against ranges the fixture writer emitted independently
        self.assertEqual(log.intersects(self.fixture.payload_ranges), [])
        # (2) every read is contained in a range the fixture declared readable
        self.assertEqual(
            bounds.reads_outside_allowed_set(log, self.fixture.allowed_read_ranges), []
        )
        # (3) the accounting the ARTIFACT reports agrees — reads intersected
        #     against the ranges the walk itself advanced past
        self.assertEqual(record.stepped_over_bytes_read, 0)
        self.assertGreater(record.payload_bytes_stepped_over, 8 * 1024 * 1024)
        self.assertEqual(sorted(log.widths), [4, 24])
        self.assertLess(log.total_bytes, 1024)
        self.assertLessEqual(log.max_single_read, 24)

    def test_the_walks_stepped_ranges_cover_the_object_it_did_not_read(self):
        """The two accountings must add up to the whole object, or one is lying.

        If the walk could advance a byte that is neither read nor recorded as
        stepped over, `steppedOverBytesRead` would have a blind spot to hide in.
        The SubMesh block is the one region both stepped over and read back into,
        at exactly 24 bytes per SubMesh, so it is subtracted once.
        """
        record, log = read_fixture(self.fixture, self.tree)
        self.assertEqual(
            record.bytes_stepped_over
            + log.total_bytes
            - bounds.AABB_BYTES * record.submesh_count,
            self.fixture.byte_size,
        )

    def test_a_walk_that_advances_unaccounted_bytes_is_refused(self):
        """The mutation: a skip that moves the cursor without recording it."""
        original_skip = bounds._Ctx.skip

        def silent_skip(self_ctx, count, payload=False):
            if count == 4:                 # one scalar field, silently swallowed
                self_ctx.pos += count
                return
            original_skip(self_ctx, count, payload)

        with mutate(bounds._Ctx, "skip", silent_skip):
            self.assertEqual(
                refusal_of(lambda: read_fixture(self.fixture, self.tree)),
                "walk-accounting-incomplete",
            )

    def test_the_giant_arrays_are_stepped_over_not_read(self):
        _record, log = read_fixture(self.fixture, self.tree)
        stepped = self.fixture.byte_size - log.total_bytes
        self.assertGreater(stepped, 8 * 1024 * 1024)
        self.assertLess(log.total_bytes / self.fixture.byte_size, 0.0001)
        # One seek per read, never a seek per skipped field.
        self.assertEqual(log.seeks, len(log.reads))

    def test_a_bigger_payload_costs_the_reader_nothing(self):
        """Skipping is pointer arithmetic: reads do not scale with array size."""
        small = bounds.write_fixture(
            str(self.tmp / "small.bin"), self.tree, count_for=small_counts
        )
        _r1, big_log = read_fixture(self.fixture, self.tree)
        _r2, small_log = read_fixture(small, self.tree)
        self.assertGreater(self.fixture.byte_size, 40 * small.byte_size)
        self.assertEqual(big_log.total_bytes, small_log.total_bytes)
        self.assertEqual(len(big_log.reads), len(small_log.reads))

    def test_a_mesh_reader_is_never_asked_to_materialize_a_typetree(self):
        reader = FakeMeshReader(7, self.fixture.object_offset, self.fixture.byte_size, self.tree)
        tree, provenance = bounds.reader_typetree(reader)
        self.assertEqual(provenance, "file-embedded")
        self.assertEqual(bounds.typetree_sha256(tree), bounds.typetree_sha256(self.tree))
        self.assertEqual(reader.parse_calls, 0)
        self.assertNotIn("UnityPy", sys.modules)


# ==========================================================================
# B. the load-bearing finding: a length-preserving layout shift
# ==========================================================================


class LengthPreservingShiftTests(unittest.TestCase):
    """Spike §4. The checksum is blind here; only the cross-check is not."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.reader_tree = bounds.mesh_schema()
        self.file_tree = bounds.mesh_schema(usage_flags_before_aabb=True)
        self.shifted = bounds.write_fixture(
            str(self.tmp / "shifted.bin"), self.file_tree, count_for=small_counts
        )
        self.straight = bounds.write_fixture(
            str(self.tmp / "straight.bin"), self.reader_tree, count_for=small_counts
        )

    def tearDown(self):
        self._tmp.cleanup()

    def test_the_shift_really_does_preserve_object_length(self):
        self.assertEqual(self.shifted.byte_size, self.straight.byte_size)

    def test_the_checksum_alone_emits_wrong_but_plausible_bounds(self):
        record, _log = read_fixture(self.shifted, self.reader_tree, cross_check=False)
        self.assertNotEqual(
            tuple(round(v, 4) for v in record.extents),
            tuple(round(v, 4) for v in TRUE_EXTENT),
        )
        # Wrong, and every cheap sanity gate passes it.
        for value in (*record.center, *record.extents):
            self.assertTrue(math.isfinite(value))
        self.assertTrue(all(v >= 0.0 for v in record.extents))
        self.assertLess(max(record.extents), bounds.MAX_ABS_EXTENT_METRES)
        self.assertEqual(
            tuple(round(v, 4) for v in record.extents), (0.0, 7.05, 2.15)
        )

    def test_the_submesh_cross_check_catches_what_the_checksum_misses(self):
        self.assertEqual(
            refusal_of(lambda: read_fixture(self.shifted, self.reader_tree)),
            "submesh-bounds-disagree",
        )

    def test_mutation_removing_the_cross_check_lets_the_wrong_answer_through(self):
        with mutate(bounds, "assert_submesh_agreement", lambda *_a, **_k: None):
            record, _log = read_fixture(self.shifted, self.reader_tree)
        self.assertEqual(tuple(round(v, 4) for v in record.extents), (0.0, 7.05, 2.15))

    def test_the_neighbouring_field_ships_the_realistic_value(self):
        """m_MeshUsageFlags == 0 in real meshes; a noise filler would flatter us.

        Spike §4: with random bytes there the magnitude gate fired and the
        cross-check looked unnecessary. Plausibility gates must never be tuned
        against a fixture whose filler is noise.
        """
        with open(self.straight.path, "rb") as handle:
            body = handle.read()
        self.assertIn(struct.pack("<6f", *TRUE_CENTER, *TRUE_EXTENT) + b"\x00\x00\x00\x00", body)


# ==========================================================================
# C. mutation proofs — one per guard
# ==========================================================================


class GuardMutationTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.tree = bounds.mesh_schema()
        self.good = bounds.write_fixture(
            str(self.tmp / "good.bin"), self.tree, count_for=small_counts
        )

    def tearDown(self):
        self._tmp.cleanup()

    def fixture(self, name, tree=None, **kwargs):
        kwargs.setdefault("count_for", small_counts)
        return bounds.write_fixture(
            str(self.tmp / name), tree or self.tree, **kwargs
        )

    # -- GUARD 1: the read budget, inside the stream wrapper ----------------

    def test_guard_read_budget_stops_a_reader_that_walks_the_payload(self):
        def greedy(self_ctx, count, payload=False):
            remaining = count
            while remaining >= 24:
                self_ctx.stream.read_at(self_ctx.pos, 24, "submesh-aabb")
                self_ctx.pos += 24
                remaining -= 24
            self_ctx.pos += remaining

        with mutate(bounds._Ctx, "skip", greedy):
            self.assertEqual(
                refusal_of(lambda: read_fixture(self.good, self.tree)),
                "read-budget-exceeded",
            )

    def test_mutation_raising_the_budget_lets_the_walking_reader_read_payload(self):
        """With the budget gone, the same reader materializes payload bytes."""
        captured = {}

        def greedy(self_ctx, count, payload=False):
            remaining = count
            while remaining >= 24:
                self_ctx.stream.read_at(self_ctx.pos, 24, "submesh-aabb")
                self_ctx.pos += 24
                remaining -= 24
            self_ctx.pos += remaining

        # This greedy reader replaces `skip` outright, so it advances the cursor
        # without recording a stepped range; the walk-accounting invariant is
        # neutralized alongside the cross-check to isolate the BUDGET, which is
        # what this test is about.
        with mutate(bounds, "MAX_TOTAL_READ_BYTES", 1 << 30), mutate(
            bounds._Ctx, "skip", greedy
        ), mutate(bounds, "assert_submesh_agreement", lambda *_a, **_k: None), mutate(
            bounds, "assert_walk_accounts_for_every_byte", lambda *_a, **_k: None
        ):
            try:
                _record, log = read_fixture(self.good, self.tree)
            except bounds.BoundsRefusal as error:  # pragma: no cover - diagnostic
                self.fail(f"expected a payload read, got {error.reason}")
            captured["hits"] = log.intersects(self.good.payload_ranges)
        self.assertTrue(
            captured["hits"], "the budget, not authorial discipline, is the backstop"
        )

    def test_guard_single_read_cap_refuses_before_touching_the_file(self):
        log = bounds.ReadLog()
        with open(self.good.path, "rb") as handle:
            stream = bounds.InstrumentedStream(handle, log)
            self.assertEqual(
                refusal_of(lambda: stream.read_at(self.good.object_offset, 4096, "count")),
                "read-budget-exceeded",
            )
            self.assertEqual(log.reads, [])
            with mutate(bounds, "MAX_SINGLE_READ_BYTES", 8192), mutate(
                bounds, "ALLOWED_READ_WIDTHS", frozenset((4, 24, 4096))
            ):
                stream.read_at(self.good.object_offset, 4096, "count")
            self.assertEqual(len(log.reads), 1)

    def test_guard_read_width_allowlist(self):
        log = bounds.ReadLog()
        with open(self.good.path, "rb") as handle:
            stream = bounds.InstrumentedStream(handle, log)
            self.assertEqual(
                refusal_of(lambda: stream.read_at(self.good.object_offset, 32, "count")),
                "unexpected-read-width",
            )
            with mutate(bounds, "ALLOWED_READ_WIDTHS", frozenset((4, 24, 32))):
                stream.read_at(self.good.object_offset, 32, "count")
            self.assertEqual(log.widths, [32])

    def test_guard_read_kind_allowlist(self):
        log = bounds.ReadLog()
        with open(self.good.path, "rb") as handle:
            stream = bounds.InstrumentedStream(handle, log)
            self.assertEqual(
                refusal_of(
                    lambda: stream.read_at(self.good.object_offset, 24, "vertex-buffer")
                ),
                "unexpected-read-kind",
            )
            self.assertEqual(log.reads, [])

    # -- GUARD 2: the end-offset checksum -----------------------------------

    def test_guard_end_offset_checksum_catches_a_length_changing_divergence(self):
        trailing = self.fixture(
            "trailing.bin", bounds.mesh_schema(extra_field_at_end=True)
        )
        self.assertEqual(
            refusal_of(lambda: read_fixture(trailing, self.tree)),
            "end-offset-divergence",
        )
        with mutate(bounds, "assert_end_offset", lambda *_a, **_k: None):
            record, _log = read_fixture(trailing, self.tree)
        self.assertIsNotNone(record, "the mutation must let the divergence through")

    # -- GUARD 3: the SubMesh union cross-check ------------------------------

    def test_guard_cross_check_catches_a_disagreeing_union(self):
        disagree = self.fixture("disagree.bin", submesh_bounds_disagree=True)
        self.assertEqual(
            refusal_of(lambda: read_fixture(disagree, self.tree)),
            "submesh-bounds-disagree",
        )
        with mutate(bounds, "assert_submesh_agreement", lambda *_a, **_k: None):
            record, _log = read_fixture(disagree, self.tree)
        self.assertEqual(
            tuple(round(v, 4) for v in record.extents), tuple(round(v, 4) for v in TRUE_EXTENT)
        )

    def test_guard_cross_check_is_mandatory_when_no_submeshes_were_seen(self):
        ctx = SimpleNamespace(submesh_min=None, submesh_max=None)
        self.assertEqual(
            refusal_of(
                lambda: bounds.assert_submesh_agreement(ctx, TRUE_CENTER, TRUE_EXTENT)
            ),
            "no-submesh-crosscheck",
        )

    def test_guard_submesh_count_bound_names_the_reader_limit_it_hit(self):
        """A reader limit is not a schema error, and must not report as one.

        Both of these used to raise `submesh-count-implausible`, which is not in
        SKIP_REASONS, so the run aborted telling the operator the pinned schema
        was wrong for the whole file.  Unity ships zero-SubMesh meshes (empty,
        collider-only, procedurally cleared) and the schema is correct in both
        cases: the reader simply cannot cross-check them.  The abort stays; the
        diagnosis changes.
        """
        with mutate(bounds, "MAX_SUBMESH_CROSSCHECK", 2):
            over = refusal_of(lambda: read_fixture(self.good, self.tree))
        self.assertEqual(over, "submesh-count-over-crosscheck-limit")

        zero_submesh = self.fixture(
            "zero-submesh.bin",
            count_for=lambda path: 0 if path == "m_SubMeshes/Array" else small_counts(path),
        )
        zero = refusal_of(lambda: read_fixture(zero_submesh, self.tree))
        self.assertEqual(zero, "zero-submesh-mesh")

        for reason in (over, zero):
            with self.subTest(reason):
                refusal = bounds.BoundsRefusal(reason)
                self.assertEqual(refusal.refusal_class, bounds.REFUSAL_CLASS_READER_LIMIT)
                # still an abort — only the diagnosis moved
                self.assertTrue(refusal.aborts_run)
                self.assertNotIn(reason, bounds.SKIP_REASONS)

        # the reason code that used to cover all of this no longer exists
        self.assertNotIn(
            "submesh-count-implausible", SCRIPT_PATH.read_text(encoding="utf-8")
        )

    def test_every_refusal_reason_raised_in_the_file_is_classified(self):
        """An unclassified reason means nobody decided what the abort means."""
        source = SCRIPT_PATH.read_text(encoding="utf-8")
        raised = set(re.findall(r'BoundsRefusal\(\s*"([a-z0-9-]+)"', source))
        self.assertGreater(len(raised), 30, raised)
        self.assertEqual(raised - set(bounds.REFUSAL_CLASSES), set())
        # and every class the table uses has an operator-facing meaning
        self.assertEqual(
            set(bounds.REFUSAL_CLASSES.values()) - set(bounds.REFUSAL_CLASS_MEANINGS),
            set(),
        )
        # the acquisition class and the skip list are the same set, by design:
        # only a per-object acquisition fact is a ledgered skip
        acquisition = {
            reason
            for reason, klass in bounds.REFUSAL_CLASSES.items()
            if klass == bounds.REFUSAL_CLASS_ACQUISITION
        }
        self.assertEqual(acquisition, set(bounds.SKIP_REASONS))

    def test_a_reader_limit_abort_says_it_is_not_a_schema_error(self):
        """The message an operator reads must name the class it belongs to."""
        schema = bounds.REFUSAL_CLASS_MEANINGS[bounds.REFUSAL_CLASS_SCHEMA]
        limit = bounds.REFUSAL_CLASS_MEANINGS[bounds.REFUSAL_CLASS_READER_LIMIT]
        unverifiable = bounds.REFUSAL_CLASS_MEANINGS[bounds.REFUSAL_CLASS_UNVERIFIABLE]
        self.assertIn("pinned schema does not describe this file", schema)
        self.assertIn("NOT", limit)
        self.assertIn("authored by hand", unverifiable)
        self.assertEqual(
            bounds.refusal_class("submesh-bounds-disagree"),
            bounds.REFUSAL_CLASS_UNVERIFIABLE,
        )
        self.assertEqual(
            bounds.refusal_class("end-offset-divergence"), bounds.REFUSAL_CLASS_SCHEMA
        )
        # an unknown reason fails toward the loudest diagnosis
        self.assertEqual(
            bounds.refusal_class("something-nobody-classified"),
            bounds.REFUSAL_CLASS_SCHEMA,
        )

    # -- the AABB itself -----------------------------------------------------

    def test_guard_aabb_found_exactly_once(self):
        duplicate = bounds.n(
            "Mesh",
            "Base",
            *self.tree.children,
            bounds._aabb("m_LocalAABB"),
        )
        fixture = self.fixture("duplicate.bin", duplicate)
        self.assertEqual(
            refusal_of(lambda: read_fixture(fixture, duplicate)),
            "aabb-not-found-exactly-once",
        )
        with mutate(bounds, "assert_aabb_found", lambda *_a, **_k: None):
            record, _log = read_fixture(fixture, duplicate)
        self.assertIsNotNone(record)

    def test_guard_finite_and_plausible_bounds(self):
        nan = self.fixture("nan.bin", aabb_extent=(float("nan"), 1.0, 1.0))
        self.assertEqual(refusal_of(lambda: read_fixture(nan, self.tree)), "non-finite-bounds")
        with mutate(bounds, "assert_finite_bounds", lambda *_a, **_k: None), mutate(
            bounds, "assert_submesh_agreement", lambda *_a, **_k: None
        ):
            record, _log = read_fixture(nan, self.tree)
        self.assertTrue(math.isnan(record.extents[0]))

        huge = self.fixture("huge.bin", aabb_extent=(1.0e9, 1.0, 1.0))
        self.assertEqual(
            refusal_of(lambda: read_fixture(huge, self.tree)),
            "implausible-bounds-magnitude",
        )
        # The SubMesh union is read BEFORE the AABB, so a negative extent is
        # caught there first; the mesh-level guard is the backstop behind it.
        negative = self.fixture("negative.bin", aabb_extent=(-1.0, 1.0, 1.0))
        self.assertEqual(
            refusal_of(lambda: read_fixture(negative, self.tree)),
            "negative-submesh-extent",
        )
        self.assertEqual(
            refusal_of(
                lambda: bounds.assert_finite_bounds(TRUE_CENTER, (-1.0, 1.0, 1.0))
            ),
            "negative-extents",
        )

    def test_guard_fixed_width_struct_may_not_hide_the_aabb(self):
        nested_tree = bounds.mesh_schema(nest_aabb_in_fixed_struct=True)
        nested = self.fixture("nested.bin", nested_tree)
        record, _log = read_fixture(nested, nested_tree)
        self.assertEqual(
            tuple(round(v, 4) for v in record.extents), tuple(round(v, 4) for v in TRUE_EXTENT)
        )
        with mutate(bounds, "_subtree_has_targets", lambda *_a, **_k: False):
            self.assertEqual(
                refusal_of(lambda: read_fixture(nested, nested_tree)),
                "aabb-not-found-exactly-once",
            )

    # -- counts, lengths, overruns ------------------------------------------

    def test_guard_negative_count_names_the_right_reason(self):
        negative = self.fixture(
            "negative-count.bin",
            hostile_count_path="m_Shapes/channels/Array",
            hostile_count_value=-5,
        )
        self.assertEqual(refusal_of(lambda: read_fixture(negative, self.tree)), "negative-count")
        # Without it, a negative count on a VARIABLE-element array iterates zero
        # times and the walk silently drifts. It still fails closed downstream —
        # but on an incidental guard with a misleading reason code, and the
        # refusal ledger is the artifact's evidence, so the name matters.
        with mutate(bounds, "check_count", lambda value, *, reason: value):
            drifted = refusal_of(lambda: read_fixture(negative, self.tree))
        self.assertIsNotNone(drifted)
        self.assertNotEqual(drifted, "negative-count")
        self.assertTrue(bounds.BoundsRefusal(drifted).aborts_run)

    def test_guard_hostile_array_count_overruns_the_object(self):
        hostile = self.fixture(
            "hostile.bin",
            hostile_count_path="m_IndexBuffer/Array",
            hostile_count_value=2_000_000_000,
        )
        self.assertEqual(
            refusal_of(lambda: read_fixture(hostile, self.tree)), "field-overruns-object"
        )

    def test_guard_variable_element_budget(self):
        with mutate(bounds, "MAX_VARIABLE_ELEMENTS", 2):
            self.assertEqual(
                refusal_of(lambda: read_fixture(self.good, self.tree)),
                "variable-element-budget-exceeded",
            )

    def test_guard_declared_size_shorter_or_longer_than_the_object(self):
        self.assertEqual(
            refusal_of(
                lambda: read_fixture(self.good, self.tree, byte_size=self.good.byte_size - 64)
            ),
            "field-overruns-object",
        )
        self.assertEqual(
            refusal_of(
                lambda: read_fixture(self.good, self.tree, byte_size=self.good.byte_size + 10 ** 9)
            ),
            "object-outside-file",
        )
        self.assertEqual(
            refusal_of(lambda: read_fixture(self.good, self.tree, byte_size=0)),
            "invalid-object-size",
        )

    def test_guard_alignment_base_divergence_refuses_rather_than_guessing(self):
        misaligned = bounds.write_fixture(
            str(self.tmp / "align.bin"),
            self.tree,
            object_offset=4098,
            align_base=0,
            count_for=small_counts,
        )
        self.assertIsNotNone(refusal_of(lambda: read_fixture(misaligned, self.tree)))
        # ...and reading it with the matching base succeeds, so the refusal is
        # about the BASE and not about the fixture being broken.
        record, _log = bounds.read_mesh_local_aabb(
            misaligned.path,
            path_id=1,
            object_offset=misaligned.object_offset,
            byte_size=misaligned.byte_size,
            typetree=self.tree,
            align_base=0,
        )
        self.assertEqual(
            tuple(round(v, 4) for v in record.extents), tuple(round(v, 4) for v in TRUE_EXTENT)
        )

    def test_guard_unknown_leaf_type(self):
        unknown_tree = bounds.mesh_schema(unknown_leaf_type=True)
        unknown = self.fixture("unknown.bin", unknown_tree)
        self.assertEqual(
            refusal_of(lambda: read_fixture(unknown, unknown_tree)), "unknown-leaf-type"
        )

    def test_guard_typetree_depth(self):
        with mutate(bounds, "MAX_NODE_DEPTH", 1):
            self.assertEqual(
                refusal_of(lambda: read_fixture(self.good, self.tree)), "typetree-too-deep"
            )

    # -- reads inside the object, and the payload accounting ----------------

    def test_guard_reads_inside_object(self):
        ctx = SimpleNamespace(start=100, end=200)
        clean = bounds.ReadLog()
        clean.reads.append((104, 24, "aabb"))
        bounds.assert_reads_inside_object(clean, ctx)
        stray = bounds.ReadLog()
        stray.reads.append((196, 24, "aabb"))
        self.assertEqual(
            refusal_of(lambda: bounds.assert_reads_inside_object(stray, ctx)),
            "read-outside-object",
        )

    def test_the_old_tag_based_payload_metric_is_gone(self):
        """`payloadBytesRead` summed reads whose kind was not allowed.

        `InstrumentedStream.read_at` raises `unexpected-read-kind` BEFORE
        appending to the log, so no read that reached the log could ever
        contribute and the metric was identically zero by construction.  This
        pins the removal: neither the property, the guard, nor the output key
        may come back, because the number was quoted as proof.
        """
        self.assertFalse(hasattr(bounds.ReadLog(), "payload_bytes"))
        self.assertFalse(hasattr(bounds, "assert_no_payload_read"))
        self.assertNotIn("payloadBytesRead", bounds.BOUNDS_ENVELOPE_EXTRA_KEYS)
        log = bounds.ReadLog()
        with self.assertRaises(bounds.BoundsRefusal) as caught:
            with open(self.good.path, "rb") as handle:
                bounds.InstrumentedStream(handle, log).read_at(0, 24, "vertex-buffer")
        self.assertEqual(caught.exception.reason, "unexpected-read-kind")
        self.assertEqual(log.reads, [], "the refused read never reached the log")

    def test_guard_stepped_over_accounting_measures_a_real_intersection(self):
        """The replacement metric is falsifiable, at the unit level.

        Two independent declarations: read offsets from `InstrumentedStream`,
        stepped ranges from the walk's own `skip`.  Planting one read inside a
        stepped range moves the number, so zero is a measurement.
        """
        record, log = read_fixture(self.good, self.tree)
        self.assertEqual(record.stepped_over_bytes_read, 0)

        ctx = SimpleNamespace(
            stepped=[(1000, 2000, True), (3000, 4000, False)], crosscheck=[]
        )
        clean = bounds.ReadLog()
        clean.reads.append((2000, 24, "aabb"))          # abuts, does not overlap
        self.assertEqual(bounds.stepped_over_bytes_read(clean, ctx), 0)
        bounds.assert_no_stepped_over_read(clean, ctx)

        dirty = bounds.ReadLog()
        dirty.reads.append((1990, 24, "aabb"))          # 10 bytes inside payload
        dirty.reads.append((3500, 4, "count"))          # 4 bytes inside a scalar skip
        self.assertEqual(bounds.stepped_over_bytes_read(dirty, ctx), 14)
        self.assertEqual(
            bounds.stepped_over_bytes_read(dirty, ctx, payload_only=True), 10
        )
        self.assertEqual(
            refusal_of(lambda: bounds.assert_no_stepped_over_read(dirty, ctx)),
            "stepped-over-bytes-read",
        )

        # The SubMesh block is the one region the walk steps over and re-reads;
        # exempting it must not exempt anything else.
        exempt = SimpleNamespace(
            stepped=[(1000, 2000, False)], crosscheck=[(1000, 1100)]
        )
        inside = bounds.ReadLog()
        inside.reads.append((1040, 24, "submesh-aabb"))
        self.assertEqual(bounds.stepped_over_bytes_read(inside, exempt), 0)
        straddle = bounds.ReadLog()
        straddle.reads.append((1090, 24, "submesh-aabb"))
        self.assertEqual(bounds.stepped_over_bytes_read(straddle, exempt), 14)

    def test_mutation_a_reader_that_reads_what_it_recorded_as_skipped_is_caught(self):
        """The discriminating mutation for the NEW metric.

        The greedy reader in the budget tests replaces `skip` outright, so it
        records no stepped ranges and only the budget can stop it.  This one
        keeps the real bookkeeping and reads the range afterwards — exactly the
        case the old tag-based metric could not see, and the new one refuses.
        """
        original_skip = bounds._Ctx.skip

        def skip_then_read(self_ctx, count, payload=False):
            start = self_ctx.pos
            original_skip(self_ctx, count, payload)
            offset = start
            while offset + 24 <= self_ctx.pos:
                self_ctx.stream.read_at(offset, 24, "submesh-aabb")
                offset += 24

        with mutate(bounds, "MAX_TOTAL_READ_BYTES", 1 << 30), mutate(
            bounds._Ctx, "skip", skip_then_read
        ), mutate(bounds, "assert_submesh_agreement", lambda *_a, **_k: None):
            self.assertEqual(
                refusal_of(lambda: read_fixture(self.good, self.tree)),
                "stepped-over-bytes-read",
            )
            # and with the guard mutated away, the same reader emits a record
            with mutate(bounds, "assert_no_stepped_over_read", lambda *_a, **_k: None):
                record, log = read_fixture(self.good, self.tree)
            self.assertGreater(record.stepped_over_bytes_read, 0)
            self.assertTrue(log.intersects(self.good.payload_ranges))

    # -- the .resS deferral --------------------------------------------------

    def test_guard_external_stream_reference_is_refused(self):
        external = self.fixture("external.bin", stream_path="archive:/CAB-1/CAB-1.resS")
        self.assertEqual(
            refusal_of(lambda: read_fixture(external, self.tree)),
            "external-stream-reference",
        )
        with mutate(bounds, "assert_no_external_stream", lambda *_a, **_k: None):
            record, log = read_fixture(external, self.tree)
        self.assertIsNotNone(record)
        # Even with the refusal mutated away, the path BYTES were never read.
        self.assertEqual(
            bounds.reads_outside_allowed_set(log, external.allowed_read_ranges), []
        )

    def test_a_resS_skip_can_never_absorb_a_schema_error(self):
        """The deferral is the point: a structural guard outranks a benign skip."""
        both = self.fixture(
            "external-diverged.bin",
            bounds.mesh_schema(extra_field_at_end=True),
            stream_path="archive:/CAB-1/CAB-1.resS",
        )
        reason = refusal_of(lambda: read_fixture(both, self.tree))
        self.assertEqual(reason, "end-offset-divergence")
        self.assertTrue(bounds.BoundsRefusal(reason).aborts_run)

    def test_skip_reasons_cannot_mask_a_schema_error(self):
        """Every skip reason is raised pre-walk or post-all-guards.

        `external-stream-reference` is the only skip reason produced by the walk,
        and it is deferred until after the checksum and the cross-check.  If a
        future edit moves a walk-time refusal into SKIP_REASONS this fails.
        """
        pre_walk = {
            "serialized-object-size-unavailable",
            "object-offset-unavailable",
            "typetree-unavailable",
            "object-outside-file",
            "invalid-object-size",
        }
        self.assertEqual(bounds.SKIP_REASONS - pre_walk, {"external-stream-reference"})
        source = SCRIPT_PATH.read_text(encoding="utf-8")
        deferred_at = source.index("def assert_no_external_stream")
        checksum_at = source.index("def assert_end_offset")
        crosscheck_at = source.index("def assert_submesh_agreement")
        self.assertLess(checksum_at, deferred_at)
        self.assertLess(crosscheck_at, deferred_at)
        call_order = source.index("assert_no_external_stream(ctx)")
        self.assertLess(source.index("assert_end_offset(ctx, byte_size)"), call_order)
        self.assertLess(source.index("assert_submesh_agreement(ctx, centre"), call_order)

    # -- the remaining refusal reasons, each reached by its own fixture ------

    def test_guard_a_non_finite_submesh_aabb_is_refused_while_reading_it(self):
        """A non-finite SubMesh AABB is caught where it is read, by name.

        The mutation below shows what this guard is and is NOT worth.  It is NOT
        the difference between safe and unsafe: with the finiteness check removed
        the run still refuses, because `min`/`max` DROP a NaN and the resulting
        partial union disagrees with `m_LocalAABB`.  What it buys is the right
        REASON CODE — and that is load-bearing, because a structural refusal
        tells the operator the pinned schema is wrong for the whole file (spike
        §5), while corrupt float data in one object is a different diagnosis
        entirely.  A guard that only sharpens a reason code is still worth
        testing; claiming it prevents a wrong answer would be false.
        """
        for label, corrupt in (("nan", float("nan")), ("inf", float("inf"))):
            poisoned = self.fixture(
                f"submesh-nonfinite-{label}.bin",
                submesh_aabb_override=((corrupt, 0.0, 0.0), (1.0, 1.0, 1.0)),
            )
            self.assertEqual(
                refusal_of(lambda: read_fixture(poisoned, self.tree)),
                "non-finite-submesh-bounds",
            )

        degraded = self.fixture(
            "submesh-nan-degraded.bin",
            submesh_aabb_override=((float("nan"), 0.0, 0.0), (1.0, 1.0, 1.0)),
        )
        original = bounds._read_submesh_union

        def unchecked(node, ctx, count):
            with mutate(math, "isfinite", lambda _value: True):
                return original(node, ctx, count)

        with mutate(bounds, "_read_submesh_union", unchecked):
            reason = refusal_of(lambda: read_fixture(degraded, self.tree))
        # Still refused — but now blamed on the schema instead of the data.
        self.assertEqual(reason, "submesh-bounds-disagree")
        self.assertTrue(bounds.BoundsRefusal(reason).aborts_run)

    def test_guard_a_malformed_string_node_is_a_schema_divergence(self):
        """A `string` without its `Array` child is a schema error, not a guess."""
        broken = bounds.mesh_schema()
        name = next(c for c in broken.children if c.name == "m_Name")
        name.children = []
        self.assertEqual(
            refusal_of(lambda: read_fixture(self.good, broken)),
            "schema-divergence",
        )
        empty_array = bounds.mesh_schema()
        buffer = next(c for c in empty_array.children if c.name == "m_IndexBuffer")
        buffer.children[0].children = [buffer.children[0].children[0]]
        self.assertEqual(
            refusal_of(lambda: read_fixture(self.good, empty_array)),
            "schema-divergence",
        )

    def test_guard_a_short_read_is_refused_rather_than_zero_filled(self):
        """A handle that returns less than asked must never be padded."""

        class TruncatingHandle:
            def __init__(self, path):
                self._handle = open(path, "rb")
                self.calls = 0

            def seek(self, offset, whence=0):
                return self._handle.seek(offset, whence)

            def read(self, length):
                self.calls += 1
                data = self._handle.read(length)
                return data[: length - 1] if self.calls > 2 else data

            def close(self):
                self._handle.close()

        handle = TruncatingHandle(self.good.path)
        try:
            self.assertEqual(
                refusal_of(
                    lambda: bounds.read_mesh_local_aabb_from_handle(
                        handle,
                        path_id=1,
                        object_offset=self.good.object_offset,
                        byte_size=self.good.byte_size,
                        file_bytes=self.good.total_file_bytes,
                        typetree=self.tree,
                    )
                ),
                "short-read",
            )
        finally:
            handle.close()

    def test_guard_a_negative_skip_is_refused_not_rewound(self):
        """The cursor only ever moves forward; a backward skip is a schema error."""
        log = bounds.ReadLog()
        with open(self.good.path, "rb") as raw:
            ctx = bounds._Ctx(
                stream=bounds.InstrumentedStream(raw, log),
                pos=self.good.object_offset,
                start=self.good.object_offset,
                end=self.good.object_offset + self.good.byte_size,
                align_base=self.good.object_offset,
            )
            self.assertEqual(refusal_of(lambda: ctx.skip(-1)), "negative-skip")
            self.assertEqual(ctx.pos, self.good.object_offset)
        self.assertEqual(log.reads, [])


# ==========================================================================
# D. pins, typetree model, and shape assertions
# ==========================================================================


class TypetreeTests(unittest.TestCase):
    def test_pins_are_required_and_exact(self):
        good = dict(
            unity_version=UNITY_VERSION,
            pinned_unity_version=UNITY_VERSION,
            typetree_hash="a" * 64,
            pinned_typetree_sha256="a" * 64,
        )
        bounds.assert_pins(**good)
        self.assertEqual(
            refusal_of(lambda: bounds.assert_pins(**{**good, "unity_version": "2022.3.9f1"})),
            "unpinned-unity-version",
        )
        self.assertEqual(
            refusal_of(lambda: bounds.assert_pins(**{**good, "unity_version": None})),
            "unpinned-unity-version",
        )
        self.assertEqual(
            refusal_of(lambda: bounds.assert_pins(**{**good, "typetree_hash": "b" * 64})),
            "unpinned-typetree",
        )
        self.assertEqual(
            refusal_of(lambda: bounds.assert_pins(**good, little_endian=False)),
            "unsupported-endianness",
        )

    def test_typetree_hash_is_stable_and_discriminating(self):
        first = bounds.typetree_sha256(bounds.mesh_schema())
        self.assertEqual(first, bounds.typetree_sha256(bounds.mesh_schema()))
        for kwargs in (
            {"extra_field_at_end": True},
            {"extra_field_before_aabb": True},
            {"usage_flags_before_aabb": True},
            {"drop_aabb": True},
        ):
            self.assertNotEqual(first, bounds.typetree_sha256(bounds.mesh_schema(**kwargs)), kwargs)

    def test_flat_node_list_round_trips_through_the_node_model(self):
        tree = bounds.mesh_schema()
        rebuilt = bounds.nodes_from_flat(flatten(tree))
        self.assertEqual(bounds.typetree_sha256(rebuilt), bounds.typetree_sha256(tree))

    def test_align_flag_survives_the_round_trip(self):
        tree = bounds.mesh_schema()
        rebuilt = bounds.nodes_from_flat(flatten(tree))
        aligned = [node.name for node in bounds._iter_nodes(rebuilt) if node.align]
        self.assertIn("Array", aligned)
        self.assertTrue(aligned)

    def test_malformed_flat_node_lists_fail_closed(self):
        node = lambda level, type_, name, flag=0: SimpleNamespace(
            level=level, type=type_, name=name, meta_flag=flag
        )
        cases = {
            "empty": [],
            "root-not-zero": [node(1, "Mesh", "Base")],
            "level-jump": [node(0, "Mesh", "Base"), node(2, "int", "x")],
            "missing-field": [SimpleNamespace(level=0, type="Mesh", name="Base")],
            "unusable": [node(0, "Mesh", "Base"), node(1, "", "x")],
        }
        for label, flat in cases.items():
            with self.subTest(label):
                self.assertIn(
                    refusal_of(lambda: bounds.nodes_from_flat(flat)),
                    {"typetree-unavailable", "typetree-node-malformed"},
                )
        with mutate(bounds, "MAX_TYPETREE_NODES", 1):
            self.assertEqual(
                refusal_of(lambda: bounds.nodes_from_flat(flatten(bounds.mesh_schema()))),
                "typetree-too-large",
            )

    def test_typetree_shape_is_asserted_before_any_byte_is_read(self):
        bounds.assert_typetree_shape(bounds.mesh_schema())
        self.assertEqual(
            refusal_of(lambda: bounds.assert_typetree_shape(bounds.mesh_schema(drop_aabb=True))),
            "aabb-not-found-exactly-once",
        )
        self.assertEqual(
            refusal_of(
                lambda: bounds.assert_typetree_shape(bounds.mesh_schema(drop_submeshes=True))
            ),
            "no-submesh-crosscheck",
        )
        self.assertEqual(
            refusal_of(lambda: bounds.assert_typetree_shape(bounds.n("Texture2D", "Base"))),
            "wrong-object-type",
        )
        # A build with no m_StreamData.path has no .resS defence at all.
        without_stream = bounds.n(
            "Mesh",
            "Base",
            *[c for c in bounds.mesh_schema().children if c.name != "m_StreamData"],
        )
        self.assertEqual(
            refusal_of(lambda: bounds.assert_typetree_shape(without_stream)),
            "typetree-missing-required-node",
        )

    def test_typetree_provenance_is_reported_not_assumed(self):
        tree = bounds.mesh_schema()
        embedded = FakeMeshReader(1, 0, 10, tree)
        self.assertEqual(bounds.reader_typetree(embedded)[1], "file-embedded")

        class Generated:
            type = SimpleNamespace(name="Mesh")
            serialized_type = SimpleNamespace(nodes=[])

            def get_typetree_nodes(self):
                return flatten(tree)

        self.assertEqual(bounds.reader_typetree(Generated())[1], "library-generated")
        self.assertEqual(
            refusal_of(lambda: bounds.reader_typetree(SimpleNamespace())),
            "typetree-unavailable",
        )


# ==========================================================================
# E. the self-test the operator's run must print
# ==========================================================================


class SelfTestTests(unittest.TestCase):
    def test_self_test_is_green_and_covers_the_named_cases(self):
        result = bounds.run_self_test()
        failed = [case for case in result["results"] if not case["passed"]]
        self.assertEqual(failed, [], failed)
        self.assertTrue(result["passed"])
        names = {case["name"] for case in result["results"]}
        for required in (
            "f/checksum-alone-is-blind",
            "f/crosscheck-catches-shift",
            "g/detector-fires-on-payload-read",
            "g/read-budget-stops-a-walking-reader",
            "b/no-payload-bytes-read",
            "b/every-read-in-allowed-set",
            "d/end-offset-checksum",
            "d/submesh-bounds-disagree",
            "d/schema-error-outranks-a-resS-skip",
        ):
            self.assertIn(required, names)

    def test_self_test_result_is_deterministic_across_hash_seeds(self):
        """The fixture filler must not depend on PYTHONHASHSEED (spike §3)."""
        program = (
            "import importlib.util,json,sys;"
            f"s=importlib.util.spec_from_file_location('b',{str(SCRIPT_PATH)!r});"
            "m=importlib.util.module_from_spec(s);sys.modules['b']=m;"
            "s.loader.exec_module(m);"
            "print(json.dumps([[c['name'],c['passed'],c['detail']] "
            "for c in m.run_self_test()['results']]))"
        )
        outputs = []
        for seed in ("1", "2"):
            environment = dict(os.environ, PYTHONHASHSEED=seed)
            completed = subprocess.run(
                [sys.executable, "-c", program],
                capture_output=True,
                text=True,
                env=environment,
                check=True,
            )
            outputs.append(completed.stdout.strip())
        self.assertEqual(outputs[0], outputs[1])
        self.assertNotIn("false", outputs[0])


# ==========================================================================
# F. the output contract
# ==========================================================================


class OutputContractTests(unittest.TestCase):
    def test_record_keys_are_already_in_the_census_allowlist(self):
        """The contract's claim: bounds records need NO allowlist widening."""
        self.assertTrue(
            bounds.BOUNDS_RECORD_KEYS <= census.ALLOWED_OUTPUT_KEYS,
            bounds.BOUNDS_RECORD_KEYS - census.ALLOWED_OUTPUT_KEYS,
        )
        self.assertIn("center", census.ALLOWED_OUTPUT_KEYS)
        self.assertNotIn("centre", census.ALLOWED_OUTPUT_KEYS)

    def test_a_bounds_record_emits_only_reviewed_keys(self):
        record = bounds.BoundsRecord(
            path_id=7, center=TRUE_CENTER, extents=TRUE_EXTENT, submesh_count=3
        )
        emitted = bounds._bounds_record(
            record,
            selection={"file": SHARED_NAME, "role": "sharedassets", "sceneIndex": CUSTOMS_INDEX},
        )
        bounds.assert_bounded_payload(emitted)
        keys = set()

        def walk(value):
            if isinstance(value, dict):
                for key, item in value.items():
                    keys.add(key)
                    walk(item)

        walk(emitted)
        self.assertTrue(keys <= bounds.BOUNDS_ALLOWED_OUTPUT_KEYS, keys)
        self.assertEqual(emitted["localAabb"]["center"]["y"], 2.10)
        self.assertNotIn("name", emitted)
        self.assertNotIn("meshName", emitted)

    def test_the_record_contract_is_exactly_what_the_doc_states(self):
        """The emitted key set is pinned, so widening it is a visible change."""
        record = bounds.BoundsRecord(
            path_id=7, center=TRUE_CENTER, extents=TRUE_EXTENT, submesh_count=3
        )
        emitted = bounds._bounds_record(
            record,
            selection={"file": SHARED_NAME, "role": "sharedassets", "sceneIndex": CUSTOMS_INDEX},
        )
        self.assertEqual(
            set(emitted),
            {
                "objectId",
                "asset",
                "sourceRole",
                "sceneIndex",
                "pathId",
                "type",
                "submeshCount",
                "localAabb",
            },
        )
        # `sourceFile` duplicated `asset` on every record; the per-record
        # instrumentation block was six keys per mesh of aggregate or constant.
        self.assertNotIn("sourceFile", emitted)
        self.assertNotIn("instrumentation", emitted)
        self.assertNotIn("sourceFile", bounds.BOUNDS_RECORD_KEYS)

    def test_the_envelope_allowlist_carries_no_key_the_envelope_cannot_emit(self):
        """Every extra key must be reachable, or the allowlist is stale.

        `results` and `detail` sat in the allowlist for a self-test block
        `main()` never actually writes; `payloadBytesRead`, `totalMeshBytes` and
        `bytesReadRatio` are gone with the metrics they named.
        """
        source = SCRIPT_PATH.read_text(encoding="utf-8")
        emitted_somewhere = set(re.findall(r'"([A-Za-z][A-Za-z0-9]*)":', source))
        unreachable = bounds.BOUNDS_ENVELOPE_EXTRA_KEYS - emitted_somewhere
        self.assertEqual(unreachable, set(), unreachable)
        for gone in (
            "payloadBytesRead",
            "totalMeshBytes",
            "bytesReadRatio",
            "results",
            "detail",
        ):
            self.assertNotIn(gone, bounds.BOUNDS_ENVELOPE_EXTRA_KEYS, gone)

    def test_the_payload_guard_refuses_an_unreviewed_key_or_a_blob(self):
        for payload in (
            {"meshes": [{"pathId": 1, "vertices": [1, 2, 3]}]},
            {"meshes": b"\x00\x01"},
            {"meshes": [{"pathId": 1, "note": "x" * 2000}]},
            {"meshes": [{"pathId": list(range(200))}]},
        ):
            with self.subTest(str(payload)[:40]):
                with self.assertRaises(bounds.BoundsError):
                    bounds.assert_bounded_payload(payload)


# ==========================================================================
# G. end to end through a fake UnityPy, including the ABORT rule
# ==========================================================================


class RunTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.source = self.tmp / "synthetic-game-data"
        self.source.mkdir()
        self.out = self.tmp / "out"
        self.out.mkdir()
        self.tree = bounds.mesh_schema()
        self.pin = bounds.typetree_sha256(self.tree)
        (self.source / "globalgamemanagers").write_bytes(b"UnityFS\x00synthetic-only")
        (self.source / LEVEL_NAME).write_bytes(b"UnityFS\x00synthetic-only")
        self.fixture = bounds.write_fixture(
            str(self.source / SHARED_NAME), self.tree, count_for=small_counts
        )

    def tearDown(self):
        self._tmp.cleanup()

    def mesh_readers(self, *readers):
        return {
            "globalgamemanagers": [build_settings_reader()],
            LEVEL_NAME: [],
            SHARED_NAME: list(readers),
        }

    def good_reader(self, path_id=101, **kwargs):
        return FakeMeshReader(
            path_id,
            self.fixture.object_offset,
            self.fixture.byte_size,
            self.tree,
            **kwargs,
        )

    def run_main(self, arguments, unitypy=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        code = bounds.main(arguments, unitypy_module=unitypy, stdout=stdout, stderr=stderr)
        return code, stdout.getvalue(), stderr.getvalue()

    def base_args(self, output="bounds.json", extra=()):
        return [
            "--source",
            str(self.source),
            "--output",
            str(self.out / output),
            "--acknowledge-local-game-files",
            "--pin-unity-version",
            UNITY_VERSION,
            "--pin-typetree-sha256",
            self.pin,
            *extra,
        ]

    # -- the happy path ------------------------------------------------------

    def test_a_clean_run_emits_measured_bounds_and_its_own_instrumentation(self):
        fake = FakeUnityPy(self.mesh_readers(self.good_reader()))
        code, out, err = self.run_main(self.base_args(), fake)
        self.assertEqual(code, 0, err)
        payload = json.loads((self.out / "bounds.json").read_text(encoding="utf-8"))
        self.assertTrue(payload["complete"])
        self.assertEqual(payload["counts"], {
            "meshCandidateCount": 1,
            "meshesRead": 1,
            "meshesRefused": 0,
        })
        mesh = payload["meshes"][0]
        self.assertEqual(mesh["pathId"], 101)
        self.assertEqual(mesh["type"], "Mesh")
        self.assertEqual(mesh["asset"], SHARED_NAME)
        self.assertAlmostEqual(mesh["localAabb"]["extents"]["x"], 7.05, places=5)
        self.assertAlmostEqual(mesh["localAabb"]["center"]["y"], 2.10, places=5)

        walk = payload["instrumentation"]["boundsWalk"]
        self.assertEqual(walk["readWidths"], [4, 24])
        self.assertLessEqual(walk["maxSingleRead"], 24)
        self.assertEqual(walk["steppedOverBytesRead"], 0)
        submesh_reads = bounds.AABB_BYTES * sum(
            item["submeshCount"] for item in payload["meshes"]
        )
        self.assertEqual(
            walk["bytesSteppedOver"] + walk["bytesRead"] - submesh_reads,
            walk["meshBytesDeclared"],
        )
        # This fixture's arrays are capped so the suite stays fast, so the ratio
        # is dominated by the fixed ~216 bytes of counts. On the self-test's full
        # 12.8 MiB object the same reader measures 0.0016%; the contract's "a
        # ratio in the percent range means the run is void" bar is what this pins.
        self.assertLess(walk["walkBytesPerMeshByte"], 0.01)
        self.assertEqual(payload["pins"], {
            "unityVersion": UNITY_VERSION,
            "typetreeSha256": self.pin,
            "typetreeProvenance": ["file-embedded"],
            "alignBase": "object",
        })
        self.assertIn("steppedOverBytesRead=0", out)
        self.assertIn("no payload was PARSED or EMITTED", out)
        # every touched file carries a before/after SHA-256 + stat identity
        for fact in payload["source"]["sceneFiles"]:
            self.assertTrue(fact["bindingVerified"], fact)
            self.assertEqual(len(fact["sha256"]), 64)
        self.assertEqual(fake.load_calls, ["globalgamemanagers", LEVEL_NAME, SHARED_NAME])

    def test_the_report_states_the_bytes_the_process_actually_read(self):
        """F2. The artifact used to report 216 bytes for a run that read 26.8 MB.

        `_capture_file_binding` streams every selected file through SHA-256 twice
        — that is how file identity is proven, and nothing payload-bearing is
        parsed or emitted by it — but the artifact reported only the bounds
        walk's own reads and the operator read that as "the run barely touched
        the game files".  The tally below is taken by wrapping the census helper
        from OUTSIDE the reader, so it is independent of what the reader claims.
        """
        # a full-size fixture, so the walk's reads and the file's size are orders
        # of magnitude apart, exactly as on a real run
        big = bounds.write_fixture(str(self.source / SHARED_NAME), self.tree)
        fake = FakeUnityPy(
            self.mesh_readers(
                FakeMeshReader(101, big.object_offset, big.byte_size, self.tree)
            )
        )
        tally = {"bytes": 0, "passes": 0}
        original = census._capture_file_binding

        def counting(path):
            result = original(path)
            tally["passes"] += 1
            tally["bytes"] += int(result[0].get("byteSize") or 0)
            return result

        with mutate(census, "_capture_file_binding", counting), mutate(
            bounds, "_capture_file_binding", counting
        ):
            code, out, err = self.run_main(self.base_args(), fake)
        self.assertEqual(code, 0, err)
        payload = json.loads((self.out / "bounds.json").read_text(encoding="utf-8"))
        walk = payload["instrumentation"]["boundsWalk"]
        proc = payload["instrumentation"]["process"]

        # the hash volume is reported, and it is the number the outside tally saw
        self.assertEqual(proc["identityHashBytes"], tally["bytes"])
        self.assertEqual(proc["identityHashPasses"], tally["passes"])
        self.assertTrue(proc["digestComplete"])
        self.assertGreater(proc["identityHashBytes"], 20 * 1024 * 1024)

        # the process total is the honest one: hashes + loader + walk
        self.assertEqual(
            proc["bytesRead"],
            proc["identityHashBytes"] + proc["unityLoaderBytes"] + walk["bytesRead"],
        )
        self.assertGreater(proc["bytesRead"], 1000 * walk["bytesRead"])

        # and the terminal says both numbers, in that order
        self.assertIn(f"process read {proc['bytesRead']} bytes", out)
        self.assertIn(f"bounds walk read {walk['bytesRead']} bytes", out)
        self.assertIn("NOT a claim: that little was read", out)
        self.assertNotIn("payloadBytesRead", out)

    def test_the_counting_stream_counts_every_read_path(self):
        """The process figure is only honest if no read path bypasses the counter."""
        target = self.source / LEVEL_NAME
        size = target.stat().st_size
        stream = bounds._CountingStream(target, "level")
        try:
            self.assertEqual(len(stream.read()), size)
            self.assertEqual(stream.bytes_read, size)
            stream.seek(0)
            buffer = bytearray(4)
            stream.readinto(buffer)
            self.assertEqual(stream.bytes_read, size + 4)
            stream.seek(0)
            stream.readline()
            self.assertGreater(stream.bytes_read, size + 4)
            # the inherited fast paths refuse rather than reading uncounted
            stream.seek(0)
            with self.assertRaises(io.UnsupportedOperation):
                stream.read1(4)
            with self.assertRaises(io.UnsupportedOperation):
                stream.readinto1(bytearray(4))
        finally:
            stream.close()

    def test_the_counted_opener_refuses_a_changed_identity(self):
        """It duplicates census's check, so it must fail the same way."""
        target = self.source / LEVEL_NAME
        binding = census._capture_file_binding(target)
        self.assertIsNotNone(binding[1])
        stream = bounds._open_counted_unity_stream(target, LEVEL_NAME, binding[1])
        self.assertEqual(stream.bytes_read, 0)
        stream.close()
        with self.assertRaises(census.CensusError):
            bounds._open_counted_unity_stream(target, LEVEL_NAME, None)
        wrong = (binding[1][0], binding[1][1], ("not", "this", "file"))
        with self.assertRaises(census.CensusError):
            bounds._open_counted_unity_stream(target, LEVEL_NAME, wrong)

    def test_a_read_around_the_instrumentation_is_caught_by_the_handle_tally(self):
        """Two tallies of the same reads, so neither can be the only witness."""
        original = bounds.read_mesh_local_aabb_from_handle

        def sneaky(handle, **kwargs):
            result = original(handle, **kwargs)
            handle.seek(0)
            handle.read(4096)          # a read the ReadLog never hears about
            return result

        with mutate(bounds, "read_mesh_local_aabb_from_handle", sneaky):
            code, _out, err = self.run_main(
                self.base_args(), FakeUnityPy(self.mesh_readers(self.good_reader()))
            )
        self.assertEqual(code, 2)
        self.assertIn("bounds handle moved", err)
        self.assertIn("Nothing was written", err)
        self.assertFalse((self.out / "bounds.json").exists())

    def test_the_artifact_never_carries_a_name_a_path_or_a_stream_reference(self):
        fake = FakeUnityPy(self.mesh_readers(self.good_reader()))
        code, _out, err = self.run_main(self.base_args(), fake)
        self.assertEqual(code, 0, err)
        text = (self.out / "bounds.json").read_text(encoding="utf-8")
        for forbidden in (
            "vagon_shutted_closed_lod0",
            ".resS",
            "Program Files",
            "Battlestate",
            str(self.source),
            "synthetic-game-data/",
        ):
            self.assertNotIn(forbidden, text, forbidden)

    # -- the abort rule ------------------------------------------------------

    def test_a_structural_divergence_aborts_the_whole_run(self):
        """Spike §5: the schema is per-version, so one divergence voids the file."""
        diverged = FakeMeshReader(
            202,
            self.fixture.object_offset,
            self.fixture.byte_size - 4,   # the walk cannot land on the declared end
            self.tree,
        )
        fake = FakeUnityPy(self.mesh_readers(self.good_reader(), diverged))
        code, _out, err = self.run_main(self.base_args(), fake)
        self.assertEqual(code, 2)
        self.assertIn("aborting the run", err)
        self.assertIn("Nothing was written", err)
        self.assertFalse((self.out / "bounds.json").exists())

    def test_the_typetree_divergence_check_is_a_real_second_layer(self):
        """`typetree-divergence` sits BEHIND the pin, so the pin must be removed
        to reach it.  That is what makes it defence in depth rather than dead
        code: with `assert_pins` mutated away, a second differently-shaped
        typetree in the same file still aborts the run instead of being read
        under a schema that does not describe it.
        """
        other = bounds.mesh_schema(extra_field_at_end=True)
        self.assertNotEqual(bounds.typetree_sha256(other), self.pin)
        odd = FakeMeshReader(
            303, self.fixture.object_offset, self.fixture.byte_size, other
        )
        fake = FakeUnityPy(self.mesh_readers(self.good_reader(), odd))
        with mutate(bounds, "assert_pins", lambda **_kwargs: None):
            code, _out, err = self.run_main(self.base_args(), fake)
        self.assertEqual(code, 2)
        self.assertIn("typetree-divergence", err)
        self.assertFalse((self.out / "bounds.json").exists())

    def test_the_abort_beats_allow_partial(self):
        diverged = FakeMeshReader(
            202, self.fixture.object_offset, self.fixture.byte_size - 4, self.tree
        )
        fake = FakeUnityPy(self.mesh_readers(self.good_reader(), diverged))
        code, _out, err = self.run_main(
            self.base_args(extra=("--allow-partial",)), fake
        )
        self.assertEqual(code, 2)
        self.assertIn("aborting the run", err)
        self.assertFalse((self.out / "bounds.json").exists())

    def test_a_second_typetree_in_the_same_file_aborts(self):
        other_tree = bounds.mesh_schema(extra_field_at_end=True)
        odd = FakeMeshReader(
            303, self.fixture.object_offset, self.fixture.byte_size, other_tree
        )
        fake = FakeUnityPy(self.mesh_readers(self.good_reader(), odd))
        code, _out, err = self.run_main(self.base_args(), fake)
        self.assertEqual(code, 2)
        # The pin catches it before the divergence check even needs to.
        self.assertIn("aborting the run", err)
        self.assertFalse((self.out / "bounds.json").exists())

    def test_an_unpinned_unity_version_aborts(self):
        fake = FakeUnityPy(self.mesh_readers(self.good_reader(unity_version="2022.3.9f1")))
        code, _out, err = self.run_main(self.base_args(), fake)
        self.assertEqual(code, 2)
        self.assertIn("unpinned-unity-version", err)
        self.assertFalse((self.out / "bounds.json").exists())

    def test_a_wrong_typetree_pin_aborts(self):
        fake = FakeUnityPy(self.mesh_readers(self.good_reader()))
        arguments = self.base_args()
        arguments[arguments.index("--pin-typetree-sha256") + 1] = "b" * 64
        code, _out, err = self.run_main(arguments, fake)
        self.assertEqual(code, 2)
        self.assertIn("unpinned-typetree", err)
        self.assertFalse((self.out / "bounds.json").exists())

    # -- ledgered skips ------------------------------------------------------

    def test_a_resS_mesh_is_a_ledgered_skip_that_requires_allow_partial(self):
        external = bounds.write_fixture(
            str(self.source / SHARED_NAME),
            self.tree,
            count_for=small_counts,
            stream_path="archive:/CAB-1/CAB-1.resS",
        )
        readers = self.mesh_readers(
            FakeMeshReader(404, external.object_offset, external.byte_size, self.tree)
        )
        code, _out, err = self.run_main(self.base_args(), FakeUnityPy(readers))
        self.assertEqual(code, 2)
        self.assertIn("refused 1 object", err)
        self.assertFalse((self.out / "bounds.json").exists())

        code, _out, err = self.run_main(
            self.base_args(extra=("--allow-partial",)), FakeUnityPy(readers)
        )
        self.assertEqual(code, 0, err)
        payload = json.loads((self.out / "bounds.json").read_text(encoding="utf-8"))
        self.assertFalse(payload["complete"])
        self.assertEqual(payload["meshes"], [])
        self.assertEqual(
            payload["diagnostics"]["refusalCounts"],
            [
                {
                    "reason": "external-stream-reference",
                    "count": 1,
                    "refusalClass": bounds.REFUSAL_CLASS_ACQUISITION,
                }
            ],
        )
        self.assertNotIn(".resS", json.dumps(payload))

    def test_a_mesh_without_a_declared_size_is_skipped_not_guessed(self):
        sizeless = self.good_reader(505)
        sizeless.byte_size = 0
        fake = FakeUnityPy(self.mesh_readers(sizeless))
        code, _out, err = self.run_main(
            self.base_args(extra=("--allow-partial",)), fake
        )
        self.assertEqual(code, 0, err)
        payload = json.loads((self.out / "bounds.json").read_text(encoding="utf-8"))
        self.assertEqual(
            payload["diagnostics"]["refusalCounts"],
            [
                {
                    "reason": "serialized-object-size-unavailable",
                    "count": 1,
                    "refusalClass": bounds.REFUSAL_CLASS_ACQUISITION,
                }
            ],
        )

    def test_a_mesh_without_an_offset_is_skipped_not_guessed(self):
        fake = FakeUnityPy(self.mesh_readers(self.good_reader(606, expose_offset=False)))
        code, _out, err = self.run_main(
            self.base_args(extra=("--allow-partial",)), fake
        )
        self.assertEqual(code, 0, err)
        payload = json.loads((self.out / "bounds.json").read_text(encoding="utf-8"))
        self.assertEqual(
            payload["diagnostics"]["refusalCounts"],
            [
                {
                    "reason": "object-offset-unavailable",
                    "count": 1,
                    "refusalClass": bounds.REFUSAL_CLASS_ACQUISITION,
                }
            ],
        )

    # -- selector reuse, dependency blockers, boundaries --------------------

    def test_only_the_authorized_two_stage_selection_is_ever_opened(self):
        (self.source / "resources.assets").write_bytes(b"UnityFS\x00other")
        (self.source / "level999").write_bytes(b"UnityFS\x00other-map")
        fake = FakeUnityPy(self.mesh_readers(self.good_reader()))
        code, _out, err = self.run_main(self.base_args(), fake)
        self.assertEqual(code, 0, err)
        self.assertEqual(fake.load_calls, ["globalgamemanagers", LEVEL_NAME, SHARED_NAME])

    def test_unity_dependency_loading_is_disabled_before_enumeration(self):
        seen = {}
        original = census._disable_dependency_loading

        def spy(environment):
            original(environment)
            seen[id(environment)] = environment.find_file

        with mutate(census, "_disable_dependency_loading", spy):
            fake = FakeUnityPy(self.mesh_readers(self.good_reader()))
            code, _out, err = self.run_main(self.base_args(), fake)
        self.assertEqual(code, 0, err)
        self.assertTrue(seen)
        for blocker in seen.values():
            with self.assertRaises(census.CensusError):
                blocker("anything")

    def test_dry_run_validates_without_importing_unitypy_or_writing(self):
        exploding = FakeUnityPy({})

        def boom(*_a, **_k):  # pragma: no cover - must not run
            raise AssertionError("dry-run must not load anything")

        exploding.load = boom
        code, out, err = self.run_main(
            self.base_args(extra=("--dry-run",)), exploding
        )
        self.assertEqual(code, 0, err)
        plan = json.loads(out)
        self.assertTrue(plan["dryRun"])
        self.assertFalse(plan["wouldWrite"])
        self.assertEqual(plan["catalogFiles"], ["globalgamemanagers"])
        self.assertEqual(plan["pins"]["typetreeSha256"], self.pin)
        self.assertFalse((self.out / "bounds.json").exists())
        self.assertNotIn("UnityPy", sys.modules)

    def test_dry_run_with_self_test_reports_the_suite(self):
        code, out, err = self.run_main(
            self.base_args(extra=("--dry-run", "--self-test")), FakeUnityPy({})
        )
        self.assertEqual(code, 0, err)
        self.assertIn("self-test:", out)
        # The self-test lines print braces of their own; the plan is the JSON
        # document that starts on a line of its own.
        plan = json.loads(out[out.index("\n{\n") + 1:])
        self.assertTrue(plan["selfTest"]["passed"])
        self.assertGreater(plan["selfTest"]["cases"], 20)

    def test_a_failing_self_test_stops_the_run_before_anything_is_read(self):
        with mutate(
            bounds, "run_self_test", lambda: {"cases": 1, "failures": 1, "passed": False,
                                              "results": [{"name": "x", "passed": False,
                                                           "detail": "forced"}]}
        ):
            code, _out, err = self.run_main(
                self.base_args(extra=("--self-test",)), FakeUnityPy(self.mesh_readers())
            )
        self.assertEqual(code, 2)
        self.assertIn("self-test failed", err)
        self.assertFalse((self.out / "bounds.json").exists())

    def test_the_run_refuses_without_the_acknowledgement_or_the_pins(self):
        fake = FakeUnityPy(self.mesh_readers(self.good_reader()))
        arguments = [a for a in self.base_args() if a != "--acknowledge-local-game-files"]
        code, _out, err = self.run_main(arguments, fake)
        self.assertEqual(code, 2)
        self.assertIn("--acknowledge-local-game-files", err)

        for flag in ("--pin-unity-version", "--pin-typetree-sha256"):
            arguments = self.base_args()
            index = arguments.index(flag)
            del arguments[index:index + 2]
            code, _out, err = self.run_main(arguments, fake)
            self.assertEqual(code, 2)
            self.assertIn(flag, err)

        arguments = self.base_args()
        arguments[arguments.index("--pin-typetree-sha256") + 1] = "not-a-hash"
        code, _out, err = self.run_main(arguments, fake)
        self.assertEqual(code, 2)
        self.assertIn("64 hex characters", err)

    def test_output_must_sit_outside_this_repository(self):
        """The second half of the publication rule, matching the sibling extractors.

        The census guard only keeps the artifact out of the GAME tree. Without
        this one, a run could write game-derived bounds into the repo — where it
        could be committed, or swept into `dist/` by a build.
        """
        fake = FakeUnityPy(self.mesh_readers(self.good_reader()))
        inside = self.base_args()
        inside[inside.index("--output") + 1] = str(
            bounds.REPO_ROOT / "scripts" / "should-never-be-written.json"
        )
        code, _out, err = self.run_main(inside, fake)
        self.assertEqual(code, 2)
        self.assertIn("outside this repository", err)
        self.assertFalse((bounds.REPO_ROOT / "scripts" / "should-never-be-written.json").exists())

        # The mutation: with the repo rule removed, the census guard alone lets
        # the write through — so this guard, not the census one, is what stops it.
        with mutate(bounds, "_validate_bounds_paths", census._validate_paths_noclobber):
            code, _out, err = self.run_main(inside, FakeUnityPy(
                self.mesh_readers(self.good_reader())
            ))
        target = bounds.REPO_ROOT / "scripts" / "should-never-be-written.json"
        try:
            self.assertEqual(code, 0, err)
            self.assertTrue(target.exists())
        finally:
            if target.exists():
                target.unlink()

    def test_output_must_sit_outside_the_game_installation(self):
        """F3. `--source` names a Unity data root, not the install around it.

        The census guard only excludes the directory passed as `--source`, so
        `--source <install>/EscapeFromTarkov_Data --output <install>/x.json`
        exited 0 and wrote a game-derived artifact into the game tree.
        """
        install = self.tmp / "Escape from Tarkov"
        install.mkdir()
        (install / "EscapeFromTarkov.exe").write_bytes(b"MZ")
        data = install / "EscapeFromTarkov_Data"
        data.mkdir()
        (data / "globalgamemanagers").write_bytes(b"UnityFS\x00synthetic-only")
        (data / LEVEL_NAME).write_bytes(b"UnityFS\x00synthetic-only")
        fixture = bounds.write_fixture(
            str(data / SHARED_NAME), self.tree, count_for=small_counts
        )
        readers = self.mesh_readers(
            FakeMeshReader(101, fixture.object_offset, fixture.byte_size, self.tree)
        )

        def run(output):
            return self.run_main(
                [
                    "--source", str(data),
                    "--output", str(output),
                    "--acknowledge-local-game-files",
                    "--pin-unity-version", UNITY_VERSION,
                    "--pin-typetree-sha256", self.pin,
                ],
                FakeUnityPy(readers),
            )

        # the reviewer's exact command: beside the data root, inside the install
        target = install / "customs-bounds.json"
        code, _out, err = run(target)
        self.assertEqual(code, 2)
        self.assertIn("outside the game installation", err)
        self.assertFalse(target.exists())

        # and deeper inside it, under a name the deterministic rule alone misses
        nested = install / "BattlEye"
        nested.mkdir()
        code, _out, err = run(nested / "customs-bounds.json")
        self.assertEqual(code, 2)
        self.assertIn("outside the game installation", err)
        self.assertFalse((nested / "customs-bounds.json").exists())

        # the mutation: with only the census + repo rules, the write goes through
        with mutate(bounds, "_assert_output_outside_game_install", lambda *_a: None):
            code, _out, err = run(target)
        self.assertEqual(code, 0, err)
        self.assertTrue(target.exists())
        target.unlink()

        # a path outside the install still works, so the guard is not a blanket
        code, _out, err = run(self.out / "outside.json")
        self.assertEqual(code, 0, err)
        self.assertTrue((self.out / "outside.json").exists())

    def test_the_install_detector_knows_a_game_tree_from_an_ordinary_directory(self):
        plain = self.tmp / "ordinary"
        plain.mkdir()
        self.assertFalse(bounds._looks_like_game_install(plain))

        by_name = self.tmp / "steamapps"
        by_name.mkdir()
        self.assertTrue(bounds._looks_like_game_install(by_name))

        by_marker = self.tmp / "some-game"
        by_marker.mkdir()
        (by_marker / "UnityPlayer.dll").write_bytes(b"MZ")
        self.assertTrue(bounds._looks_like_game_install(by_marker))

        # a generic Unity player: `<name>_Data/globalgamemanagers`, no known name
        generic = self.tmp / "another-game"
        (generic / "Whatever_Data").mkdir(parents=True)
        (generic / "Whatever_Data" / "globalgamemanagers").write_bytes(b"UnityFS")
        self.assertTrue(bounds._looks_like_game_install(generic))

        # a `_Data` directory with no catalog inside is not an install
        decoy = self.tmp / "not-a-game"
        (decoy / "Notes_Data").mkdir(parents=True)
        self.assertFalse(bounds._looks_like_game_install(decoy))

    def test_output_must_sit_outside_the_game_tree_and_never_clobber(self):
        fake = FakeUnityPy(self.mesh_readers(self.good_reader()))
        inside = self.base_args()
        inside[inside.index("--output") + 1] = str(self.source / "bounds.json")
        code, _out, err = self.run_main(inside, fake)
        self.assertEqual(code, 2)
        self.assertIn("outside the supplied game-data source", err)

        missing = self.base_args()
        missing[missing.index("--output") + 1] = str(self.out / "absent" / "b.json")
        code, _out, err = self.run_main(missing, fake)
        self.assertEqual(code, 2)
        self.assertIn("parent directory must already exist", err)

        code, _out, err = self.run_main(self.base_args(), FakeUnityPy(
            self.mesh_readers(self.good_reader())
        ))
        self.assertEqual(code, 0, err)
        first = (self.out / "bounds.json").read_bytes()
        code, _out, err = self.run_main(self.base_args(), FakeUnityPy(
            self.mesh_readers(self.good_reader())
        ))
        self.assertEqual(code, 2)
        self.assertIn("output already exists", err)
        self.assertEqual((self.out / "bounds.json").read_bytes(), first)

    def test_publication_leaves_no_temporary_file_behind(self):
        fake = FakeUnityPy(self.mesh_readers(self.good_reader()))
        code, _out, err = self.run_main(self.base_args(), fake)
        self.assertEqual(code, 0, err)
        self.assertEqual(
            sorted(p.name for p in self.out.iterdir()), ["bounds.json"]
        )

    def test_a_file_that_changes_during_the_read_is_never_published(self):
        reader = self.good_reader()
        original = census._capture_file_binding
        state = {"calls": 0}

        def flaky(path):
            """Let the BEFORE binding succeed and fail the AFTER binding."""
            if path.name != SHARED_NAME:
                return original(path)
            state["calls"] += 1
            if state["calls"] > 1:
                return {"digestComplete": False, "bindingVerified": False}, None
            return original(path)

        with mutate(census, "_capture_file_binding", flaky), mutate(
            bounds, "_capture_file_binding", flaky
        ):
            code, _out, err = self.run_main(
                self.base_args(), FakeUnityPy(self.mesh_readers(reader))
            )
        self.assertEqual(code, 2)
        self.assertIn("changed during the read", err)
        self.assertFalse((self.out / "bounds.json").exists())


if __name__ == "__main__":
    unittest.main()
