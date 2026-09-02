#!/usr/bin/env python3
"""Emit measured `Mesh.m_LocalAABB` scalars for the authorized Customs selection.

This is the production reader promoted from the feasibility spike recorded in
`docs/plans/BOUNDS-SPIKE-FINDINGS.md`.  It answers exactly one question — *how
big is this mesh resource* — and emits at most
`{pathId, localAabb: {center, extents}}` plus source-file identity.

What it does NOT do, by construction:

* It never calls `parse_as_dict()`, `read_typetree()`, or any UnityPy save/export
  API on a `Mesh`.  The AABB is read by walking the pinned typetree with a
  LOGICAL cursor: skipping a field is pointer arithmetic, so the vertex, index,
  compressed-mesh and baked-collision arrays are stepped over without a seek, a
  read, or an allocation, whatever their size.
* It never physically reads a payload byte.  Every read is tagged with the field
  kind that justified it (`count`, `aabb`, `submesh-aabb`), is capped at
  `MAX_SINGLE_READ_BYTES`, must be one of `ALLOWED_READ_WIDTHS`, and the whole
  object shares one `MAX_TOTAL_READ_BYTES` budget enforced *inside* the stream
  wrapper.  A vertex buffer does not fit in that budget, by construction.
* It never opens a `.resS`: a non-empty `m_StreamData.path` is refused after
  reading the 4-byte length and before reading one byte of the path itself.
* It never emits a name, a stream path, an absolute installation path, or any
  serialized array.

Three guards are non-negotiable and all three are present (spike §8):

1. **The read budget**, inside the stream wrapper — the structural backstop that
   makes payload materialisation unreachable even under a schema surprise.
2. **The end-offset checksum** — the walk must traverse the whole object and land
   exactly on its declared last byte.
3. **The SubMesh union cross-check** — `m_LocalAABB` must agree with the union of
   the per-`SubMesh` `localAABB`s stored before every payload array.  This is the
   ONLY guard that survives a *length-preserving* layout shift, and the spike
   demonstrates a concrete case (a 4-byte `m_MeshUsageFlags` moved across the
   AABB) where the checksum alone emits finite, non-negative, plausible, WRONG
   extents.  A reader with the checksum alone is not safe; it is lucky.

**The schema is per-version, not per-object.**  One structural divergence means
the pin is wrong for the whole file, so the run ABORTS.  A per-object skip would
quietly turn a systematic schema error into a partial roster that looks fine.
Only genuinely per-object acquisition facts (a `.resS` reference, a missing
declared size) are ledgered skips.

**What a clean run establishes.**  That these mesh *resources* have these local
bounds.  Bounds identify an asset resource, not a placed visible object; they
are a filter that removes size-impossible candidates and a source of dimensions,
never a promoter that creates confirmed objects.  `m_LocalAABB` is local and
pre-transform: a world extent needs the census's composed world scale, is
derived, and over-estimates under a rotated non-uniform scale.
"""

# NOTE: deliberately no `from __future__ import annotations`.  It turns every
# annotation into a string, and `dataclasses` then resolves those strings through
# `sys.modules[cls.__module__]` — which is unset when this file is loaded through
# `importlib.util.module_from_spec` without registration, as the repo's Python
# test files do.  Real annotation objects keep the module loadable either way.

import argparse
import hashlib
import importlib.util
import json
import math
import os
import struct
import sys
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence as Seq, TextIO, Tuple


BOUNDS_SCHEMA_VERSION = 1
GENERATOR_NAME = "tarkovzero-customs-mesh-bounds"
REPO_ROOT = Path(__file__).resolve().parents[1]


def _load_census_module() -> Any:
    """Reuse the audited two-stage selector and write boundary, not a copy of it.

    The census module itself loads `extract-customs-unity.py`, so this single
    import carries the catalog-first Customs selector, the no-follow file
    binding, the path-safe Unity stream, the dependency-loading blockers, and the
    atomic no-clobber publication.  None of them import UnityPy at module load,
    so `--dry-run` stays UnityPy-free.
    """
    script = Path(__file__).with_name("census-customs-assets.py")
    spec = importlib.util.spec_from_file_location("census_customs_assets", script)
    if spec is None or spec.loader is None:  # pragma: no cover - packaging failure
        raise RuntimeError("cannot load the Customs census module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


census = _load_census_module()
selector = census.selector


class BoundsError(RuntimeError):
    """Operator-facing failure: bad paths, bad pins, or an aborted run."""


_clean_text = selector._clean_text
_integer = selector._integer
_drop_none = selector._drop_none
_object_id = selector._object_id
_present_value = census._present_value
_safe_error_type = census._safe_error_type
_capture_file_binding = census._capture_file_binding
_verified_file_fact = census._verified_file_fact
_stat_identity = census._stat_identity
_safe_visible_name = census._safe_visible_name
_publish_json_noclobber = census._publish_json_noclobber
discover_catalog_files = selector.discover_catalog_files
discover_customs_scene_files = selector.discover_customs_scene_files


# ==========================================================================
# 1. Bounds on the reader itself
# ==========================================================================

# A per-object read budget.  A real Mesh needs roughly 40 four-byte counts, one
# 24-byte AABB and a handful of 24-byte SubMesh AABBs — a few hundred bytes.
# 8 KiB leaves headroom for a pathological submesh/variable-element count and is
# still six orders of magnitude below a vertex buffer.
MAX_TOTAL_READ_BYTES = 8192
MAX_SINGLE_READ_BYTES = 64
# The reader has exactly three reasons to touch the file.  Any other read width
# means the walk is doing something the design does not describe.
ALLOWED_READ_WIDTHS = frozenset((4, 24))
ALLOWED_READ_KINDS = frozenset(("count", "aabb", "submesh-aabb"))
# Variable-length array ELEMENTS cannot be bulk-skipped; they must be iterated.
# Bound that before the read budget can be reached, so the refusal names the
# real cause instead of surfacing as a budget blowout.
MAX_VARIABLE_ELEMENTS = 512
MAX_NODE_DEPTH = 32
MAX_TYPETREE_NODES = 8192
# The SubMesh union cross-check is mandatory; its cost is bounded.
MAX_SUBMESH_CROSSCHECK = 64
CROSSCHECK_ABS_TOLERANCE = 0.02      # metres
CROSSCHECK_REL_TOLERANCE = 0.02      # 2% of the union span
# A plausibility gate on the emitted numbers.  Deliberately loose: spike §4 shows
# plausibility gates are filler-dependent and must never be tuned against noise
# fixtures, so this catches only nonsense, and the cross-check does the work.
MAX_ABS_EXTENT_METRES = 4096.0

ALIGN_FLAG = 0x4000
AABB_BYTES = 24

# Refusals that are genuinely per-object acquisition facts.  Everything else is
# treated as a systematic schema error and aborts the run (spike §5).
#
# Every member of this set is raised either BEFORE the walk starts (so it cannot
# be a mis-decode) or AFTER all three structural guards have passed (so the
# schema is known to be right).  `test_skip_reasons_cannot_mask_a_schema_error`
# pins that invariant.  In particular `external-stream-reference` is DEFERRED:
# under a wrong schema the four bytes at the stream-path offset are garbage and
# would otherwise refuse as a benign per-object `.resS` skip, letting a
# systematic schema error masquerade as a mass of harmless skips.
SKIP_REASONS = frozenset(
    (
        "external-stream-reference",
        "serialized-object-size-unavailable",
        "object-offset-unavailable",
        "typetree-unavailable",
        "object-outside-file",
        "invalid-object-size",
    )
)


class BoundsRefusal(Exception):
    """Fail-closed refusal carrying a bounded, name-free reason code."""

    def __init__(self, reason: str, detail: str = ""):
        super().__init__(reason if not detail else f"{reason}: {detail}")
        self.reason = reason
        self.detail = detail

    @property
    def aborts_run(self) -> bool:
        return self.reason not in SKIP_REASONS


# ==========================================================================
# 2. Typetree node model
# ==========================================================================


@dataclass
class Node:
    type: str
    name: str
    children: List["Node"] = field(default_factory=list)
    align: bool = False

    def signature(self) -> object:
        return [
            self.type,
            self.name,
            1 if self.align else 0,
            [child.signature() for child in self.children],
        ]


def n(type_: str, name: str, *children: Node, align: bool = False) -> Node:
    return Node(type=type_, name=name, children=list(children), align=align)


def typetree_sha256(root: Node) -> str:
    """Stable hash of the node tree: type, name, align flag, and shape."""
    return hashlib.sha256(
        json.dumps(root.signature(), separators=(",", ":")).encode("utf-8")
    ).hexdigest()


BASIC_SIZES = {
    "bool": 1,
    "char": 1,
    "SInt8": 1,
    "UInt8": 1,
    "short": 2,
    "SInt16": 2,
    "UInt16": 2,
    "unsigned short": 2,
    "int": 4,
    "SInt32": 4,
    "UInt32": 4,
    "unsigned int": 4,
    "float": 4,
    "Type*": 4,
    "SInt64": 8,
    "UInt64": 8,
    "long long": 8,
    "unsigned long long": 8,
    "FileSize": 8,
    "double": 8,
}

VARIABLE_TYPES = frozenset(("string", "Array", "vector", "TypelessData", "set", "map"))


def fixed_size(node: Node) -> Optional[int]:
    """Serialized width of a subtree, or None when it is position-dependent.

    An align flag makes the width depend on where the node starts, and an Array
    or string makes it depend on the data, so both return None.  A subtree may be
    bulk-skipped only when this is not None.
    """
    if node.align:
        return None
    if node.type in BASIC_SIZES:
        return BASIC_SIZES[node.type]
    if node.type in VARIABLE_TYPES:
        return None
    if not node.children:
        return None
    total = 0
    for child in node.children:
        size = fixed_size(child)
        if size is None:
            return None
        total += size
    return total


def _fixed_offset_of(node: Node, name: str) -> Optional[int]:
    """Byte offset of a named child inside a fixed-width struct, or None."""
    offset = 0
    for child in node.children:
        if child.name == name:
            return offset
        width = fixed_size(child)
        if width is None:
            return None
        offset += width
    return None


def nodes_from_flat(flat: Seq[Any]) -> Node:
    """Rebuild a node tree from UnityPy's flat (level, type, name, meta_flag) list.

    Fails closed on anything malformed: an empty list, a first node whose level is
    not zero, a level that jumps by more than one, or a node missing a field.
    """
    if not isinstance(flat, (list, tuple)) or not flat:
        raise BoundsRefusal("typetree-unavailable", "empty node list")
    if len(flat) > MAX_TYPETREE_NODES:
        raise BoundsRefusal("typetree-too-large", str(len(flat)))

    parsed: List[Tuple[int, Node]] = []
    for raw in flat:
        present_level, level_value = _present_value(raw, "level", "m_Level")
        present_type, type_value = _present_value(raw, "type", "m_Type")
        present_name, name_value = _present_value(raw, "name", "m_Name")
        present_flag, flag_value = _present_value(raw, "meta_flag", "m_MetaFlag")
        if not (present_level and present_type and present_name and present_flag):
            raise BoundsRefusal("typetree-node-malformed", "missing field")
        level = _integer(level_value)
        flag = _integer(flag_value)
        type_name = _clean_text(type_value, limit=120)
        field_name = _clean_text(name_value, limit=120)
        if level is None or level < 0 or flag is None or not type_name or not field_name:
            raise BoundsRefusal("typetree-node-malformed", "unusable field")
        parsed.append(
            (level, Node(type=type_name, name=field_name, align=bool(flag & ALIGN_FLAG)))
        )

    if parsed[0][0] != 0:
        raise BoundsRefusal("typetree-node-malformed", "root level is not zero")
    root = parsed[0][1]
    stack: List[Node] = [root]
    previous_level = 0
    for level, node in parsed[1:]:
        if level <= 0 or level > previous_level + 1:
            raise BoundsRefusal("typetree-node-malformed", f"level jump to {level}")
        del stack[level:]
        stack[level - 1].children.append(node)
        stack.append(node)
        previous_level = level
    return root


# ==========================================================================
# 3. Typetree shape assertions — run before a single byte is read
# ==========================================================================


def _iter_nodes(node: Node):
    yield node
    for child in node.children:
        yield from _iter_nodes(child)


def _is_local_aabb(node: Node) -> bool:
    return node.type == "AABB" and node.name == "m_LocalAABB"


def _is_submesh_array(node: Node) -> bool:
    return (
        node.type == "Array"
        and len(node.children) == 2
        and node.children[1].type == "SubMesh"
    )


def _is_stream_path(node: Node, parent: Optional[Node]) -> bool:
    return (
        node.type == "string"
        and node.name == "path"
        and parent is not None
        and parent.name == "m_StreamData"
    )


def assert_typetree_shape(root: Node) -> None:
    """Refuse a typetree whose shape the reader's guards cannot police.

    This runs on the pinned tree before any file access, so a build whose Mesh
    lacks `SubMesh.localAABB` (pre-2017.3) or lacks `m_StreamData.path` is
    refused up front rather than read without a defence.
    """
    if root.type != "Mesh":
        raise BoundsRefusal("wrong-object-type", root.type[:40])

    aabbs = [node for node in _iter_nodes(root) if _is_local_aabb(node)]
    if len(aabbs) != 1:
        raise BoundsRefusal("aabb-not-found-exactly-once", str(len(aabbs)))
    if fixed_size(aabbs[0]) != AABB_BYTES:
        raise BoundsRefusal("schema-divergence", "m_LocalAABB is not 24 fixed bytes")

    submesh_arrays = [node for node in _iter_nodes(root) if _is_submesh_array(node)]
    if len(submesh_arrays) != 1:
        raise BoundsRefusal("no-submesh-crosscheck", str(len(submesh_arrays)))
    element = submesh_arrays[0].children[1]
    width = fixed_size(element)
    offset = _fixed_offset_of(element, "localAABB")
    if width is None or offset is None:
        raise BoundsRefusal("schema-divergence", "SubMesh is not fixed-width")
    local = next((c for c in element.children if c.name == "localAABB"), None)
    if local is None or fixed_size(local) != AABB_BYTES:
        raise BoundsRefusal("no-submesh-crosscheck", "SubMesh.localAABB is not 24 bytes")

    stream_paths = [
        node
        for parent in _iter_nodes(root)
        for node in parent.children
        if _is_stream_path(node, parent)
    ]
    if len(stream_paths) != 1:
        raise BoundsRefusal(
            "typetree-missing-required-node", f"m_StreamData/path x{len(stream_paths)}"
        )


def _subtree_has_targets(node: Node, memo: Dict[int, bool]) -> bool:
    """True when a subtree contains anything the walk must not step over.

    A fixed-width struct may only be bulk-skipped when it provably contains no
    `m_LocalAABB`, no SubMesh array and no `m_StreamData.path`.  Without this the
    bulk-skip could hide the AABB (which fails closed on `aabb_hits`, but for the
    wrong reason) or hide a `.resS` reference.
    """
    key = id(node)
    cached = memo.get(key)
    if cached is not None:
        return cached
    result = _is_local_aabb(node) or _is_submesh_array(node)
    if not result:
        for child in node.children:
            if _is_stream_path(child, node) or _subtree_has_targets(child, memo):
                result = True
                break
    memo[key] = result
    return result


# ==========================================================================
# 4. Instrumented stream — the read budget lives HERE, not in the walk
# ==========================================================================


@dataclass
class ReadLog:
    reads: List[Tuple[int, int, str]] = field(default_factory=list)
    seeks: int = 0

    @property
    def total_bytes(self) -> int:
        return sum(length for _, length, _ in self.reads)

    @property
    def max_single_read(self) -> int:
        return max((length for _, length, _ in self.reads), default=0)

    @property
    def widths(self) -> List[int]:
        return sorted({length for _, length, _ in self.reads})

    @property
    def payload_bytes(self) -> int:
        """Bytes read that no allowed field kind justified.

        This is the reader's own claim.  The self-test verifies the claim against
        payload ranges emitted independently by the fixture writer, so a read
        mis-tagged as a `count` that actually lands inside array contents is
        caught there rather than trusted here.
        """
        return sum(
            length for _, length, kind in self.reads if kind not in ALLOWED_READ_KINDS
        )

    def reads_absolute(self) -> List[Tuple[int, int]]:
        return [(offset, offset + length) for offset, length, _ in self.reads]

    def intersects(self, ranges: Seq[Tuple[int, int]]) -> List[Tuple[int, int]]:
        hits: List[Tuple[int, int]] = []
        for start, end in self.reads_absolute():
            for low, high in ranges:
                if start < high and low < end:
                    hits.append((start, end))
                    break
        return hits


class InstrumentedStream:
    """Records every physical read and enforces the budget before issuing it."""

    def __init__(self, handle: Any, log: ReadLog):
        self._handle = handle
        self.log = log

    def read_at(self, offset: int, length: int, kind: str) -> bytes:
        if length > MAX_SINGLE_READ_BYTES:
            raise BoundsRefusal("read-budget-exceeded", f"single read of {length}")
        if self.log.total_bytes + length > MAX_TOTAL_READ_BYTES:
            raise BoundsRefusal(
                "read-budget-exceeded", f"total {self.log.total_bytes + length}"
            )
        if length not in ALLOWED_READ_WIDTHS:
            raise BoundsRefusal("unexpected-read-width", str(length))
        if kind not in ALLOWED_READ_KINDS:
            raise BoundsRefusal("unexpected-read-kind", str(kind)[:32])
        self._handle.seek(offset)
        self.log.seeks += 1
        data = self._handle.read(length)
        if len(data) != length:
            raise BoundsRefusal("short-read", f"{len(data)} of {length}")
        self.log.reads.append((offset, length, kind))
        return data


# ==========================================================================
# 5. The walk
# ==========================================================================


@dataclass
class _Ctx:
    stream: InstrumentedStream
    pos: int          # logical absolute cursor
    start: int        # object start
    end: int          # exclusive object end
    align_base: int
    memo: Dict[int, bool] = field(default_factory=dict)
    aabb: Optional[Tuple[Tuple[float, ...], Tuple[float, ...]]] = None
    aabb_hits: int = 0
    external_stream: bool = False
    variable_elements: int = 0
    submesh_min: Optional[List[float]] = None
    submesh_max: Optional[List[float]] = None
    submesh_count: int = 0

    def skip(self, count: int) -> None:
        """Advance without touching the file. This is the whole trick."""
        if count < 0:
            raise BoundsRefusal("negative-skip")
        target = self.pos + count
        if target > self.end:
            raise BoundsRefusal("field-overruns-object", f"{target} > {self.end}")
        self.pos = target

    def take(self, count: int, kind: str) -> bytes:
        if self.pos + count > self.end:
            raise BoundsRefusal("field-overruns-object")
        data = self.stream.read_at(self.pos, count, kind)
        self.pos += count
        return data

    def align(self) -> None:
        self.skip((-(self.pos - self.align_base)) % 4)


def _int32(data: bytes) -> int:
    return struct.unpack("<i", data)[0]


def check_count(value: int, *, reason: str) -> int:
    """Guard: a serialized count or length is never negative."""
    if value < 0:
        raise BoundsRefusal(reason, str(value))
    return value


def check_stream_path(ctx: "_Ctx", here: str, length: int) -> None:
    """Note a `.resS` reference. The path bytes are stepped over, never read.

    The refusal is DEFERRED to `assert_no_external_stream`, after all three
    structural guards.  Refusing here would let a wrong schema — under which the
    four bytes at this offset are garbage and non-zero with near-certainty —
    present itself as a benign per-object skip on every mesh in the file, which
    is exactly the partial-roster-that-looks-fine failure the abort rule exists
    to prevent.
    """
    if here.endswith("m_StreamData/path") and length > 0:
        ctx.external_stream = True


def _read_submesh_union(node: Node, ctx: _Ctx, count: int) -> None:
    element = node.children[1]
    width = fixed_size(element)
    offset = _fixed_offset_of(element, "localAABB")
    if width is None or offset is None:
        raise BoundsRefusal("schema-divergence", "SubMesh is not fixed-width")
    if count < 1 or count > MAX_SUBMESH_CROSSCHECK:
        raise BoundsRefusal("submesh-count-implausible", str(count))
    base = ctx.pos
    ctx.skip(width * count)
    low = [float("inf")] * 3
    high = [float("-inf")] * 3
    for index in range(count):
        raw = ctx.stream.read_at(base + index * width + offset, AABB_BYTES, "submesh-aabb")
        values = struct.unpack("<6f", raw)
        for axis in range(3):
            centre, extent = values[axis], values[3 + axis]
            if not (math.isfinite(centre) and math.isfinite(extent)):
                raise BoundsRefusal("non-finite-submesh-bounds")
            if extent < 0.0:
                raise BoundsRefusal("negative-submesh-extent")
            low[axis] = min(low[axis], centre - extent)
            high[axis] = max(high[axis], centre + extent)
    ctx.submesh_min, ctx.submesh_max, ctx.submesh_count = low, high, count


def _walk(node: Node, ctx: _Ctx, path: List[str], depth: int) -> None:
    if depth > MAX_NODE_DEPTH:
        raise BoundsRefusal("typetree-too-deep")

    here = "/".join(path + [node.name]) if node.name != "Base" else ""

    # ---- the one field we are here for -----------------------------------
    if _is_local_aabb(node):
        if fixed_size(node) != AABB_BYTES:
            raise BoundsRefusal("schema-divergence", "m_LocalAABB is not 24 bytes")
        values = struct.unpack("<6f", ctx.take(AABB_BYTES, "aabb"))
        ctx.aabb = (values[0:3], values[3:6])
        ctx.aabb_hits += 1
        if node.align:
            ctx.align()
        return

    # ---- string: read the length, never the bytes ------------------------
    if node.type == "string":
        if not node.children or node.children[0].type != "Array":
            raise BoundsRefusal("schema-divergence", "string without Array child")
        array = node.children[0]
        length = check_count(_int32(ctx.take(4, "count")), reason="negative-length")
        check_stream_path(ctx, here, length)
        ctx.skip(length)
        if array.align or node.align:
            ctx.align()
        return

    # ---- array: read the count, then step over the elements --------------
    if node.type == "Array":
        if len(node.children) != 2:
            raise BoundsRefusal("schema-divergence", "Array without size+element")
        count = check_count(_int32(ctx.take(4, "count")), reason="negative-count")
        element = node.children[1]

        if element.type == "SubMesh":
            _read_submesh_union(node, ctx, count)
            if node.align:
                ctx.align()
            return

        width = fixed_size(element)
        if width is not None:
            # Bulk skip: no read, no seek, no allocation, whatever the size.
            # `ctx.skip` is the bound — a hostile count overruns the object end
            # and refuses instead of walking anything.
            ctx.skip(width * count)
        else:
            ctx.variable_elements += count
            if ctx.variable_elements > MAX_VARIABLE_ELEMENTS:
                raise BoundsRefusal("variable-element-budget-exceeded")
            for index in range(count):
                _walk(element, ctx, path + [node.name, str(index)], depth + 1)
        if node.align:
            ctx.align()
        return

    # ---- scalars ---------------------------------------------------------
    if node.type in BASIC_SIZES:
        ctx.skip(BASIC_SIZES[node.type])
        if node.align:
            ctx.align()
        return

    # ---- structs ---------------------------------------------------------
    if not node.children:
        raise BoundsRefusal("unknown-leaf-type", node.type[:40])

    width = fixed_size(node)
    if (
        width is not None
        and node.name != "Base"
        and not _subtree_has_targets(node, ctx.memo)
    ):
        ctx.skip(width)
        return

    child_path = path if node.name == "Base" else path + [node.name]
    for child in node.children:
        _walk(child, ctx, child_path, depth + 1)
    if node.align:
        ctx.align()


# ==========================================================================
# 6. The three structural guards, each named so it can be mutation-tested
# ==========================================================================


def assert_end_offset(ctx: _Ctx, byte_size: int) -> None:
    """GUARD 2: the walk traversed the whole object and landed on its last byte.

    Catches every LENGTH-CHANGING schema divergence.  Blind to a length-preserving
    one — that is what guard 3 is for.
    """
    if ctx.pos != ctx.end:
        raise BoundsRefusal(
            "end-offset-divergence", f"{ctx.pos - ctx.start} of {byte_size}"
        )


def assert_aabb_found(ctx: _Ctx) -> None:
    if ctx.aabb_hits != 1 or ctx.aabb is None:
        raise BoundsRefusal("aabb-not-found-exactly-once", str(ctx.aabb_hits))


def assert_finite_bounds(
    centre: Seq[float], extents: Seq[float]
) -> None:
    for value in (*centre, *extents):
        if not math.isfinite(value):
            raise BoundsRefusal("non-finite-bounds")
        if abs(value) > MAX_ABS_EXTENT_METRES:
            raise BoundsRefusal("implausible-bounds-magnitude")
    if any(value < 0.0 for value in extents):
        raise BoundsRefusal("negative-extents")


def assert_submesh_agreement(
    ctx: _Ctx, centre: Seq[float], extents: Seq[float]
) -> None:
    """GUARD 3: `m_LocalAABB` equals the union of the per-SubMesh localAABBs.

    The only guard that survives a length-preserving layout shift.  Spike §4: a
    fixture moving `m_MeshUsageFlags` (4 bytes) across the AABB satisfied the
    end-offset checksum and emitted extents (0.0, 7.05, 2.15) against a truth of
    (7.05, 2.15, 1.52) — finite, non-negative, plausible, and wrong.

    A mesh whose `m_LocalAABB` was authored by hand and legitimately differs from
    the union is REFUSED.  That is the conservative direction, but it means the
    refusal ledger is a coverage gap, never evidence that no such mesh exists.
    """
    if ctx.submesh_min is None or ctx.submesh_max is None:
        raise BoundsRefusal("no-submesh-crosscheck")
    for axis in range(3):
        union_low = ctx.submesh_min[axis]
        union_high = ctx.submesh_max[axis]
        aabb_low = centre[axis] - extents[axis]
        aabb_high = centre[axis] + extents[axis]
        span = max(union_high - union_low, 1e-6)
        tolerance = CROSSCHECK_ABS_TOLERANCE + CROSSCHECK_REL_TOLERANCE * span
        if (
            abs(union_low - aabb_low) > tolerance
            or abs(union_high - aabb_high) > tolerance
        ):
            raise BoundsRefusal(
                "submesh-bounds-disagree",
                f"axis {axis}: union[{union_low:.3f},{union_high:.3f}] vs "
                f"aabb[{aabb_low:.3f},{aabb_high:.3f}]",
            )


def assert_no_external_stream(ctx: _Ctx) -> None:
    """A `.resS` reference is refused only once the schema is known to be right.

    The pipeline never opens a stream file and never emits its path; the path
    bytes were stepped over by pointer arithmetic and never read.
    """
    if ctx.external_stream:
        raise BoundsRefusal("external-stream-reference")


def assert_reads_inside_object(log: ReadLog, ctx: _Ctx) -> None:
    for offset, length, _kind in log.reads:
        if offset < ctx.start or offset + length > ctx.end:
            raise BoundsRefusal("read-outside-object")


def assert_no_payload_read(log: ReadLog) -> None:
    """Every physical read was justified by an allowed field kind."""
    if log.payload_bytes:
        raise BoundsRefusal("payload-bytes-read", str(log.payload_bytes))


# ==========================================================================
# 7. The reader
# ==========================================================================


@dataclass
class BoundsRecord:
    path_id: int
    center: Tuple[float, float, float]
    extents: Tuple[float, float, float]
    submesh_count: int

    def local_aabb(self) -> Dict[str, Any]:
        return {
            "center": {
                "x": self.center[0],
                "y": self.center[1],
                "z": self.center[2],
            },
            "extents": {
                "x": self.extents[0],
                "y": self.extents[1],
                "z": self.extents[2],
            },
        }


def read_mesh_local_aabb_from_handle(
    handle: Any,
    *,
    path_id: int,
    object_offset: int,
    byte_size: int,
    file_bytes: int,
    typetree: Node,
    align_base: Optional[int] = None,
    cross_check: bool = True,
) -> Tuple[BoundsRecord, ReadLog]:
    """Emit one `{pathId, center, extents}` from an open seekable handle, or refuse.

    The caller owns pin verification (`assert_pins`) and typetree shape
    verification (`assert_typetree_shape`); both are per-FILE facts and are
    checked once, not once per object.
    """
    if byte_size <= 0:
        raise BoundsRefusal("invalid-object-size", str(byte_size))
    if object_offset < 0 or object_offset + byte_size > file_bytes:
        raise BoundsRefusal("object-outside-file")

    log = ReadLog()
    ctx = _Ctx(
        stream=InstrumentedStream(handle, log),
        pos=object_offset,
        start=object_offset,
        end=object_offset + byte_size,
        align_base=object_offset if align_base is None else align_base,
    )
    _walk(typetree, ctx, [], 0)

    assert_end_offset(ctx, byte_size)                       # GUARD 2
    assert_aabb_found(ctx)
    assert (ctx.aabb is not None)
    centre, extents = ctx.aabb
    assert_finite_bounds(centre, extents)
    if cross_check:
        assert_submesh_agreement(ctx, centre, extents)      # GUARD 3
    assert_reads_inside_object(log, ctx)
    assert_no_payload_read(log)
    # Deferred on purpose: a `.resS` skip is only trustworthy once the three
    # structural guards above have confirmed the schema.
    assert_no_external_stream(ctx)

    return (
        BoundsRecord(
            path_id=path_id,
            center=(centre[0], centre[1], centre[2]),
            extents=(extents[0], extents[1], extents[2]),
            submesh_count=ctx.submesh_count,
        ),
        log,
    )


def read_mesh_local_aabb(
    file_path: str,
    *,
    path_id: int,
    object_offset: int,
    byte_size: int,
    typetree: Node,
    align_base: Optional[int] = None,
    cross_check: bool = True,
) -> Tuple[BoundsRecord, ReadLog]:
    """Path-taking convenience used by the self-test. Never used on a real run."""
    with open(file_path, "rb") as handle:
        handle.seek(0, os.SEEK_END)
        file_bytes = handle.tell()
        return read_mesh_local_aabb_from_handle(
            handle,
            path_id=path_id,
            object_offset=object_offset,
            byte_size=byte_size,
            file_bytes=file_bytes,
            typetree=typetree,
            align_base=align_base,
            cross_check=cross_check,
        )


def assert_pins(
    *,
    unity_version: Optional[str],
    pinned_unity_version: str,
    typetree_hash: str,
    pinned_typetree_sha256: str,
    little_endian: bool = True,
) -> None:
    """Layout provenance is pinned, not inferred. Both must match exactly.

    Spike §5 row 4: Unity player builds frequently strip typetrees, in which case
    the schema comes from UnityPy's version-keyed generated database — a
    third-party schema for a third-party-selected file.  Pinning its SHA-256 is
    what turns that into a reviewed input.  The mitigation for the provenance
    circularity is that schema is not identity: the numbers still come from the
    file's own bytes, and guard 3 validates the schema against the file's own
    internal redundancy rather than against the library's say-so.
    """
    if not little_endian:
        raise BoundsRefusal("unsupported-endianness")
    if not unity_version:
        raise BoundsRefusal("unpinned-unity-version", "version unavailable")
    if unity_version != pinned_unity_version:
        raise BoundsRefusal("unpinned-unity-version", unity_version[:40])
    if typetree_hash != pinned_typetree_sha256:
        raise BoundsRefusal("unpinned-typetree", typetree_hash[:16])


# ==========================================================================
# 8. Synthetic schema + fixture writer (self-test only, never a real file)
# ==========================================================================


def _vector(name: str, element: Node, *, align: bool = False) -> Node:
    return n("vector", name, n("Array", "Array", n("int", "size"), element, align=align))


def _string(name: str) -> Node:
    return n(
        "string",
        name,
        n("Array", "Array", n("int", "size"), n("char", "data"), align=True),
    )


def _vector3(name: str) -> Node:
    return n("Vector3f", name, n("float", "x"), n("float", "y"), n("float", "z"))


def _aabb(name: str) -> Node:
    return n("AABB", name, _vector3("m_Center"), _vector3("m_Extent"))


def _matrix4x4(name: str) -> Node:
    return n("Matrix4x4f", name, *[n("float", f"e{i:02d}") for i in range(16)])


def _packed_bit_vector(name: str) -> Node:
    return n(
        "PackedBitVector",
        name,
        n("UInt32", "m_NumItems"),
        n("float", "m_Range"),
        n("float", "m_Start"),
        _vector("m_Data", n("UInt8", "data"), align=True),
        n("UInt8", "m_BitSize", align=True),
    )


def _submesh(name: str = "data") -> Node:
    return n(
        "SubMesh",
        name,
        n("UInt32", "firstByte"),
        n("UInt32", "indexCount"),
        n("int", "topology"),
        n("UInt32", "baseVertex"),
        n("UInt32", "firstVertex"),
        n("UInt32", "vertexCount"),
        _aabb("localAABB"),
    )


def _blend_shape_data() -> Node:
    return n(
        "BlendShapeData",
        "m_Shapes",
        _vector(
            "vertices",
            n(
                "BlendShapeVertex",
                "data",
                _vector3("vertex"),
                _vector3("normal"),
                _vector3("tangent"),
                n("UInt32", "index"),
            ),
        ),
        _vector(
            "shapes",
            n(
                "MeshBlendShape",
                "data",
                n("UInt32", "firstVertex"),
                n("UInt32", "vertexCount"),
                n("bool", "hasNormals"),
                n("bool", "hasTangents", align=True),
            ),
        ),
        # variable-length ELEMENTS (each carries a string): a skipping reader
        # cannot compute their width and must iterate them.
        _vector(
            "channels",
            n(
                "MeshBlendShapeChannel",
                "data",
                _string("name"),
                n("UInt32", "nameHash"),
                n("int", "frameIndex"),
                n("int", "frameCount"),
            ),
        ),
        _vector("fullWeights", n("float", "data")),
    )


def _vertex_data() -> Node:
    return n(
        "VertexData",
        "m_VertexData",
        n("UInt32", "m_CurrentChannels"),
        n("UInt32", "m_VertexCount"),
        _vector(
            "m_Channels",
            n(
                "ChannelInfo",
                "data",
                n("UInt8", "stream"),
                n("UInt8", "offset"),
                n("UInt8", "format"),
                n("UInt8", "dimension"),
            ),
        ),
        _vector("m_DataSize", n("UInt8", "data"), align=True),
    )


def _compressed_mesh() -> Node:
    return n(
        "CompressedMesh",
        "m_CompressedMesh",
        *[
            _packed_bit_vector(name)
            for name in (
                "m_Vertices",
                "m_UV",
                "m_Normals",
                "m_Tangents",
                "m_Weights",
                "m_NormalSigns",
                "m_TangentSigns",
                "m_FloatColors",
                "m_BoneIndices",
                "m_Triangles",
            )
        ],
        n("UInt32", "m_UVInfo"),
    )


def _streaming_info() -> Node:
    return n(
        "StreamingInfo",
        "m_StreamData",
        n("UInt32", "offset"),
        n("UInt32", "size"),
        _string("path"),
    )


def mesh_schema(
    *,
    extra_field_before_aabb: bool = False,
    extra_field_at_end: bool = False,
    usage_flags_before_aabb: bool = False,
    unknown_leaf_type: bool = False,
    drop_aabb: bool = False,
    drop_submeshes: bool = False,
    nest_aabb_in_fixed_struct: bool = False,
) -> Node:
    """A Unity-2019-shaped Mesh used only by the self-test.

    `m_LocalAABB` deliberately sits AFTER every large payload array
    (`m_IndexBuffer`, `m_VertexData.m_DataSize`, ten `PackedBitVector`s) and
    BEFORE two more (the baked collision meshes), so a reader that walks payload
    instead of stepping over it is caught on either side.
    """
    children: List[Node] = [_string("m_Name")]
    if not drop_submeshes:
        children.append(_vector("m_SubMeshes", _submesh()))
    children.extend(
        [
            _blend_shape_data(),
            _vector("m_BindPose", _matrix4x4("data")),
            _vector("m_BoneNameHashes", n("UInt32", "data")),
            n("UInt32", "m_RootBoneNameHash"),
            _vector(
                "m_BonesAABB",
                n("MinMaxAABB", "data", _vector3("m_Min"), _vector3("m_Max")),
            ),
            n(
                "VariableBoneCountWeights",
                "m_VariableBoneCountWeights",
                _vector("m_Data", n("UInt32", "data")),
            ),
            n("UInt8", "m_MeshCompression"),
            n("bool", "m_IsReadable"),
            n("bool", "m_KeepVertices"),
            n("bool", "m_KeepIndices", align=True),
            n("int", "m_IndexFormat"),
            _vector("m_IndexBuffer", n("UInt8", "data"), align=True),
            _vertex_data(),
            _compressed_mesh(),
        ]
    )
    if extra_field_before_aabb:
        children.append(n("int", "m_UnknownFutureField"))
    if unknown_leaf_type:
        children.append(n("SomeFutureLeafType", "m_FutureLeaf"))
    # The DANGEROUS divergence: a 4-byte field moved ACROSS the AABB, so the
    # object's total length is unchanged and the end-offset checksum is blind.
    if usage_flags_before_aabb:
        children.append(n("int", "m_MeshUsageFlags"))
    if not drop_aabb:
        if nest_aabb_in_fixed_struct:
            # A fixed-width wrapper around the AABB. Bulk-skipping it would hide
            # the AABB, so `_subtree_has_targets` must refuse to bulk-skip here.
            children.append(
                n("MeshBoundsWrapper", "m_BoundsWrapper", n("int", "pad"), _aabb("m_LocalAABB"))
            )
        else:
            children.append(_aabb("m_LocalAABB"))
    if not usage_flags_before_aabb:
        children.append(n("int", "m_MeshUsageFlags"))
    children.extend(
        [
            _vector("m_BakedConvexCollisionMesh", n("UInt8", "data"), align=True),
            _vector("m_BakedTriangleCollisionMesh", n("UInt8", "data"), align=True),
            n("float", "m_MeshMetrics[0]"),
            n("float", "m_MeshMetrics[1]"),
            _streaming_info(),
        ]
    )
    if extra_field_at_end:
        children.append(n("int", "m_UnknownTrailingField"))
    return n("Mesh", "Base", *children)


# Any array whose element bytes reach this size is registered as payload for the
# read-intersection proof.  SubMesh arrays are deliberately excluded: their
# element bytes are scalar submesh metadata, and the cross-check reads 24 bytes
# from inside each one on purpose.  The proof is therefore two-sided — the
# fixture says "these ranges are payload", and the ALLOWED-READ-SET assertion
# says "every read landed on a count, the AABB, or a submesh AABB".
PAYLOAD_RANGE_MIN_BYTES = 64


@dataclass
class Fixture:
    path: str
    object_offset: int
    byte_size: int
    payload_ranges: List[Tuple[int, int]]
    allowed_read_ranges: List[Tuple[int, int]]
    aabb: Tuple[Tuple[float, float, float], Tuple[float, float, float]]
    total_file_bytes: int
    payload_bytes: int


class _FixtureWriter:
    def __init__(self, base: int, align_base: int):
        self.buf = bytearray()
        self.base = base
        self.align_base = align_base
        self.payload_ranges: List[Tuple[int, int]] = []
        self.allowed_read_ranges: List[Tuple[int, int]] = []

    @property
    def abs_pos(self) -> int:
        return self.base + len(self.buf)

    def raw(self, data: bytes) -> None:
        self.buf += data

    def readable_field(self, data: bytes) -> None:
        """A field the reader is allowed to physically read (count/AABB)."""
        start = self.abs_pos
        self.buf += data
        self.allowed_read_ranges.append((start, start + len(data)))

    def payload(self, data: bytes) -> None:
        start = self.abs_pos
        self.buf += data
        if len(data) >= PAYLOAD_RANGE_MIN_BYTES:
            self.payload_ranges.append((start, start + len(data)))

    def align(self) -> None:
        pad = (-(self.abs_pos - self.align_base)) % 4
        if pad:
            self.buf += b"\x00" * pad


def _filler(path: str, size: int) -> bytes:
    seed = (sum(path.encode("utf-8")) % 251) + 1
    return bytes(((seed * (i + 7)) % 256) for i in range(size))


BIG_COUNTS = {
    "m_IndexBuffer/Array": 2 * 1024 * 1024,
    "m_VertexData/m_DataSize/Array": 4 * 1024 * 1024,
    "m_BakedTriangleCollisionMesh/Array": 3 * 1024 * 1024,
    "m_BakedConvexCollisionMesh/Array": 512 * 1024,
    "m_Shapes/vertices/Array": 20_000,
    "m_BindPose/Array": 400,
    "m_BoneNameHashes/Array": 400,
    "m_BonesAABB/Array": 400,
}


def default_count_for(path: str) -> int:
    if path in BIG_COUNTS:
        return BIG_COUNTS[path]
    if path.startswith("m_CompressedMesh/") and path.endswith("m_Data/Array"):
        return 256 * 1024
    if path == "m_SubMeshes/Array":
        return 3
    if path in ("m_Shapes/shapes/Array", "m_Shapes/fullWeights/Array"):
        return 4
    if path == "m_Shapes/channels/Array":
        return 4          # variable-length ELEMENTS, each holding a string
    if path == "m_VertexData/m_Channels/Array":
        return 8
    if path == "m_VariableBoneCountWeights/m_Data/Array":
        return 64
    return 0


def write_fixture(
    file_path: str,
    root: Node,
    *,
    object_offset: int = 4096,
    align_base: Optional[int] = None,
    count_for=default_count_for,
    aabb_center: Tuple[float, float, float] = (0.0, 2.10, 0.0),
    aabb_extent: Tuple[float, float, float] = (7.05, 2.15, 1.52),
    stream_path: str = "",
    trailing_bytes: int = 8192,
    hostile_count_path: Optional[str] = None,
    hostile_count_value: int = 0,
    submesh_bounds_disagree: bool = False,
    submesh_aabb_override: Optional[
        Tuple[Tuple[float, float, float], Tuple[float, float, float]]
    ] = None,
) -> Fixture:
    """Write one synthetic serialized-Mesh object inside a larger container file.

    Returns, INDEPENDENTLY of the reader, the byte ranges that constitute payload
    array contents and the byte ranges the reader is permitted to read.  The
    self-test asserts the reader's physical reads intersect the first set zero
    times and lie entirely inside the second.
    """
    writer = _FixtureWriter(
        base=object_offset,
        align_base=object_offset if align_base is None else align_base,
    )

    sub_count = max(1, count_for("m_SubMeshes/Array"))
    safe_center = tuple(v if math.isfinite(v) else 0.0 for v in aabb_center)
    safe_extent = tuple(v if math.isfinite(v) else 1.0 for v in aabb_extent)
    slices: List[Tuple[Tuple[float, float, float], Tuple[float, float, float]]] = []
    for index in range(sub_count):
        low = safe_center[0] - safe_extent[0] + 2 * safe_extent[0] * index / sub_count
        high = safe_center[0] - safe_extent[0] + 2 * safe_extent[0] * (index + 1) / sub_count
        slices.append(
            (
                ((low + high) / 2.0, safe_center[1], safe_center[2]),
                ((high - low) / 2.0, safe_extent[1], safe_extent[2]),
            )
        )
    if submesh_bounds_disagree:
        slices = [(c, (e[0] * 0.25, e[1] * 0.25, e[2] * 0.25)) for c, e in slices]
    if submesh_aabb_override is not None:
        # Corrupt only the FIRST SubMesh, so the union is poisoned by a single
        # element and the reader must catch it while reading, not afterwards.
        slices[0] = submesh_aabb_override
    sub_cursor = [0]

    def emit(node: Node, path: List[str]) -> None:
        here = "/".join(path + [node.name]) if node.name != "Base" else ""
        kids = node.children

        if node.type == "string":
            array = kids[0]
            data = b""
            if here.endswith("m_StreamData/path"):
                data = stream_path.encode("utf-8")
            elif here.endswith("m_Name"):
                data = b"vagon_shutted_closed_lod0"
            writer.readable_field(struct.pack("<i", len(data)))
            writer.raw(data)
            if array.align or node.align:
                writer.align()
            return

        if node.type == "Array":
            count = count_for(here)
            if hostile_count_path is not None and here == hostile_count_path:
                writer.readable_field(struct.pack("<i", hostile_count_value))
            else:
                writer.readable_field(struct.pack("<i", count))
            element = kids[1]
            fixed = None if element.type == "SubMesh" else fixed_size(element)
            if fixed is not None:
                writer.payload(_filler(here, fixed * count))
            else:
                for index in range(count):
                    emit(element, path + [node.name, str(index)])
            if node.align:
                writer.align()
            return

        if node.type in BASIC_SIZES:
            if here.endswith("m_MeshUsageFlags"):
                # Real meshes ship 0 here, and it matters: a zeroed neighbour
                # makes a 4-byte layout shift decode into PLAUSIBLE bounds, which
                # is exactly the case the cross-check must catch on its own.
                writer.raw(struct.pack("<i", 0))
            else:
                writer.raw(_filler(here, BASIC_SIZES[node.type]))
            if node.align:
                writer.align()
            return

        if not kids:
            # A leaf type the READER does not know, which the writer must still
            # be able to lay down — that is the point of that fixture.
            writer.raw(_filler(here, 4))
            if node.align:
                writer.align()
            return

        if node.type == "AABB" and node.name == "m_LocalAABB":
            writer.readable_field(struct.pack("<6f", *aabb_center, *aabb_extent))
            if node.align:
                writer.align()
            return

        if node.type == "AABB" and node.name == "localAABB":
            centre, extent = slices[min(sub_cursor[0], len(slices) - 1)]
            sub_cursor[0] += 1
            writer.readable_field(struct.pack("<6f", *centre, *extent))
            if node.align:
                writer.align()
            return

        for child in kids:
            emit(child, path if node.name == "Base" else path + [node.name])
        if node.align:
            writer.align()

    emit(root, [])
    body = bytes(writer.buf)
    header = bytes(((i * 37) % 256) for i in range(object_offset))
    trailer = bytes(((i * 91) % 256) for i in range(trailing_bytes))
    with open(file_path, "wb") as handle:
        handle.write(header)
        handle.write(body)
        handle.write(trailer)
    return Fixture(
        path=file_path,
        object_offset=object_offset,
        byte_size=len(body),
        payload_ranges=writer.payload_ranges,
        allowed_read_ranges=writer.allowed_read_ranges,
        aabb=(aabb_center, aabb_extent),
        total_file_bytes=object_offset + len(body) + trailing_bytes,
        payload_bytes=sum(end - start for start, end in writer.payload_ranges),
    )


def reads_outside_allowed_set(
    log: ReadLog, allowed: Seq[Tuple[int, int]]
) -> List[Tuple[int, int]]:
    """Reads not fully contained in a range the fixture declared readable."""
    stray: List[Tuple[int, int]] = []
    for start, end in log.reads_absolute():
        if not any(low <= start and end <= high for low, high in allowed):
            stray.append((start, end))
    return stray


# ==========================================================================
# 9. --self-test: the guards are exercised in the same process, same commit
# ==========================================================================


class _TypetreeTripwire:
    """Stands in for a UnityPy ObjectReader. Any materialisation is recorded."""

    calls = 0

    def parse_as_dict(self, *_args, **_kwargs):  # pragma: no cover - must not run
        type(self).calls += 1
        raise AssertionError("parse_as_dict() was called")

    read_typetree = parse_as_dict
    read = parse_as_dict
    save = parse_as_dict


def _refusal_reason(fn) -> Optional[str]:
    try:
        fn()
    except BoundsRefusal as error:
        return error.reason
    return None


def run_self_test() -> Dict[str, Any]:
    """Run every synthetic case and return a structured, bounded result."""
    cases: List[Dict[str, Any]] = []

    def record(name: str, ok: bool, detail: str) -> None:
        cases.append({"name": name, "passed": bool(ok), "detail": detail[:400]})

    def expect(name: str, fn, expected: Optional[str]) -> None:
        reason = _refusal_reason(fn)
        if reason is None:
            record(name, False, "NO REFUSAL — a value was emitted")
        elif expected is not None and reason != expected:
            record(name, False, f"refused with {reason!r}, expected {expected!r}")
        else:
            record(name, True, f"refused: {reason}")

    _TypetreeTripwire.calls = 0
    tripwire = _TypetreeTripwire()

    with tempfile.TemporaryDirectory(prefix="customs-bounds-selftest-") as tmp:
        tree = mesh_schema()
        assert_typetree_shape(tree)

        # ---- nominal: shape, values, instrumentation ----------------------
        good = write_fixture(os.path.join(tmp, "nominal.bin"), tree)
        record_out, log = read_mesh_local_aabb(
            good.path,
            path_id=-8834771233310976271,
            object_offset=good.object_offset,
            byte_size=good.byte_size,
            typetree=tree,
        )
        record(
            "a/values-correct",
            tuple(round(v, 4) for v in record_out.center) == (0.0, 2.10, 0.0)
            and tuple(round(v, 4) for v in record_out.extents) == (7.05, 2.15, 1.52),
            f"center={tuple(round(v, 3) for v in record_out.center)} "
            f"extents={tuple(round(v, 3) for v in record_out.extents)}",
        )
        record(
            "a/output-shape",
            set(record_out.local_aabb()) == {"center", "extents"},
            f"keys={sorted(record_out.local_aabb())}",
        )

        hits = log.intersects(good.payload_ranges)
        record(
            "b/no-payload-bytes-read",
            not hits and log.payload_bytes == 0,
            f"{len(log.reads)} physical reads / {log.total_bytes} bytes; "
            f"payload-range intersections={len(hits)}; "
            f"reader-tagged payload bytes={log.payload_bytes}",
        )
        stray = reads_outside_allowed_set(log, good.allowed_read_ranges)
        record(
            "b/every-read-in-allowed-set",
            not stray,
            f"{len(log.reads)} reads, {len(stray)} outside the fixture's "
            "declared count/AABB/submesh-AABB ranges",
        )
        record(
            "b/no-parse-as-dict",
            _TypetreeTripwire.calls == 0 and "UnityPy" not in sys.modules,
            f"parse_as_dict calls={_TypetreeTripwire.calls}, "
            f"UnityPy imported={'UnityPy' in sys.modules}",
        )
        record(
            "c/seek-not-walk",
            log.total_bytes < MAX_TOTAL_READ_BYTES
            and (good.byte_size - log.total_bytes) > 8 * 1024 * 1024,
            f"{(good.byte_size - log.total_bytes) / 1048576:.1f} MiB of the object "
            f"stepped over without a read "
            f"({100.0 * log.total_bytes / good.byte_size:.6f}% read)",
        )
        record(
            "c/only-counts-and-aabb",
            set(log.widths) <= set(ALLOWED_READ_WIDTHS),
            f"read widths={log.widths}",
        )

        # ---- the load-bearing case: a LENGTH-PRESERVING layout shift ------
        shifted = write_fixture(
            os.path.join(tmp, "length-preserving.bin"),
            mesh_schema(usage_flags_before_aabb=True),
        )
        try:
            blind, _ = read_mesh_local_aabb(
                shifted.path,
                path_id=1,
                object_offset=shifted.object_offset,
                byte_size=shifted.byte_size,
                typetree=tree,
                cross_check=False,
            )
            record(
                "f/checksum-alone-is-blind",
                True,
                "end-offset checksum did NOT fire — reader emitted extents="
                f"{tuple(round(v, 3) for v in blind.extents)} (truth 7.05/2.15/1.52). "
                "Finite, non-negative, plausible, and wrong.",
            )
        except BoundsRefusal as error:
            record(
                "f/checksum-alone-is-blind",
                True,
                f"checksum happened to fire here ({error.reason}); not relied upon",
            )
        expect(
            "f/crosscheck-catches-shift",
            lambda: read_mesh_local_aabb(
                shifted.path,
                path_id=1,
                object_offset=shifted.object_offset,
                byte_size=shifted.byte_size,
                typetree=tree,
                cross_check=True,
            ),
            "submesh-bounds-disagree",
        )

        # ---- negative controls: the instrumentation has teeth --------------
        control_log = ReadLog()
        with open(good.path, "rb") as handle:
            stream = InstrumentedStream(handle, control_log)
            start, _end = good.payload_ranges[0]
            stream.read_at(start + 8, 24, "aabb")
        record(
            "g/detector-fires-on-payload-read",
            len(control_log.intersects(good.payload_ranges)) == 1,
            "a deliberate 24-byte read inside payload was reported as "
            f"{len(control_log.intersects(good.payload_ranges))} intersection(s)",
        )

        original_skip = _Ctx.skip

        def greedy_skip(self, count: int) -> None:
            """A reader that MATERIALIZES what it should step over.

            Every read it issues is 24 bytes wide and tagged `submesh-aabb`, both
            of which the reader allows, so nothing but the BUDGET can stop it.
            The remainder is advanced logically so the width guard never fires
            and the control cannot pass for the wrong reason.
            """
            remaining = count
            while remaining >= 24:
                self.stream.read_at(self.pos, 24, "submesh-aabb")
                self.pos += 24
                remaining -= 24
            self.pos += remaining

        _Ctx.skip = greedy_skip  # type: ignore[assignment]
        try:
            expect(
                "g/read-budget-stops-a-walking-reader",
                lambda: read_mesh_local_aabb(
                    good.path,
                    path_id=1,
                    object_offset=good.object_offset,
                    byte_size=good.byte_size,
                    typetree=tree,
                ),
                "read-budget-exceeded",
            )
        finally:
            _Ctx.skip = original_skip  # type: ignore[assignment]

        # The single-read cap is the other half of the budget: one oversized read
        # is refused before it reaches the file, whatever the running total.
        oversized_log = ReadLog()
        with open(good.path, "rb") as handle:
            oversized = InstrumentedStream(handle, oversized_log)
            expect(
                "g/single-read-cap-refuses-a-bulk-read",
                lambda: oversized.read_at(good.object_offset, 4096, "count"),
                "read-budget-exceeded",
            )
        record(
            "g/refused-bulk-read-was-never-issued",
            not oversized_log.reads,
            f"{len(oversized_log.reads)} reads recorded after the refusal",
        )

        # ---- fail-closed ledger -------------------------------------------
        expect(
            "d/unpinned-unity-version",
            lambda: assert_pins(
                unity_version="2022.3.9f1",
                pinned_unity_version="2019.4.39f1",
                typetree_hash="x",
                pinned_typetree_sha256="x",
            ),
            "unpinned-unity-version",
        )
        expect(
            "d/unpinned-typetree",
            lambda: assert_pins(
                unity_version="2019.4.39f1",
                pinned_unity_version="2019.4.39f1",
                typetree_hash="a" * 64,
                pinned_typetree_sha256="b" * 64,
            ),
            "unpinned-typetree",
        )
        expect(
            "d/unsupported-endianness",
            lambda: assert_pins(
                unity_version="2019.4.39f1",
                pinned_unity_version="2019.4.39f1",
                typetree_hash="a",
                pinned_typetree_sha256="a",
                little_endian=False,
            ),
            "unsupported-endianness",
        )

        diverged_tree = mesh_schema(extra_field_before_aabb=True)
        diverged = write_fixture(os.path.join(tmp, "diverged.bin"), diverged_tree)
        expect(
            "d/schema-divergence-newer-layout",
            lambda: read_mesh_local_aabb(
                diverged.path,
                path_id=1,
                object_offset=diverged.object_offset,
                byte_size=diverged.byte_size,
                typetree=tree,
            ),
            None,
        )
        expect(
            "d/schema-divergence-older-layout",
            lambda: read_mesh_local_aabb(
                good.path,
                path_id=1,
                object_offset=good.object_offset,
                byte_size=good.byte_size,
                typetree=diverged_tree,
            ),
            None,
        )

        misaligned = write_fixture(
            os.path.join(tmp, "align-base.bin"), tree, object_offset=4098, align_base=0
        )
        expect(
            "d/alignment-base-divergence",
            lambda: read_mesh_local_aabb(
                misaligned.path,
                path_id=1,
                object_offset=misaligned.object_offset,
                byte_size=misaligned.byte_size,
                typetree=tree,
            ),
            None,
        )

        external = write_fixture(
            os.path.join(tmp, "external.bin"),
            tree,
            stream_path="archive:/CAB-0000/CAB-0000.resS",
        )
        expect(
            "d/external-stream-reference",
            lambda: read_mesh_local_aabb(
                external.path,
                path_id=1,
                object_offset=external.object_offset,
                byte_size=external.byte_size,
                typetree=tree,
            ),
            "external-stream-reference",
        )
        record(
            "d/external-stream-path-bytes-never-read",
            True,
            "the 4-byte length is read, the path bytes are stepped over; the "
            "reader's allowed read kinds make a path read structurally "
            "impossible (proved by b/every-read-in-allowed-set)",
        )

        # A `.resS` skip must never be able to absorb a schema error. Same
        # external path, plus a LENGTH-CHANGING divergence: the structural guard
        # has to win, so the run aborts instead of logging a benign skip.
        external_diverged = write_fixture(
            os.path.join(tmp, "external-diverged.bin"),
            mesh_schema(extra_field_at_end=True),
            stream_path="archive:/CAB-0000/CAB-0000.resS",
        )
        expect(
            "d/schema-error-outranks-a-resS-skip",
            lambda: read_mesh_local_aabb(
                external_diverged.path,
                path_id=1,
                object_offset=external_diverged.object_offset,
                byte_size=external_diverged.byte_size,
                typetree=tree,
            ),
            "end-offset-divergence",
        )

        hostile = write_fixture(
            os.path.join(tmp, "hostile.bin"),
            tree,
            hostile_count_path="m_IndexBuffer/Array",
            hostile_count_value=2_000_000_000,
        )
        expect(
            "d/hostile-array-count",
            lambda: read_mesh_local_aabb(
                hostile.path,
                path_id=1,
                object_offset=hostile.object_offset,
                byte_size=hostile.byte_size,
                typetree=tree,
            ),
            "field-overruns-object",
        )
        expect(
            "d/truncated-declared-size",
            lambda: read_mesh_local_aabb(
                good.path,
                path_id=1,
                object_offset=good.object_offset,
                byte_size=good.byte_size - 64,
                typetree=tree,
            ),
            None,
        )
        expect(
            "d/object-outside-file",
            lambda: read_mesh_local_aabb(
                good.path,
                path_id=1,
                object_offset=good.object_offset,
                byte_size=good.byte_size + 10 ** 9,
                typetree=tree,
            ),
            "object-outside-file",
        )

        nan = write_fixture(
            os.path.join(tmp, "nan.bin"), tree, aabb_extent=(float("nan"), 1.0, 1.0)
        )
        expect(
            "d/non-finite-bounds",
            lambda: read_mesh_local_aabb(
                nan.path,
                path_id=1,
                object_offset=nan.object_offset,
                byte_size=nan.byte_size,
                typetree=tree,
            ),
            "non-finite-bounds",
        )

        trailing_tree = mesh_schema(extra_field_at_end=True)
        trailing = write_fixture(os.path.join(tmp, "trailing.bin"), trailing_tree)
        expect(
            "d/end-offset-checksum",
            lambda: read_mesh_local_aabb(
                trailing.path,
                path_id=1,
                object_offset=trailing.object_offset,
                byte_size=trailing.byte_size,
                typetree=tree,
            ),
            "end-offset-divergence",
        )

        unknown_tree = mesh_schema(unknown_leaf_type=True)
        unknown = write_fixture(os.path.join(tmp, "unknown.bin"), unknown_tree)
        expect(
            "d/unknown-leaf-type",
            lambda: read_mesh_local_aabb(
                unknown.path,
                path_id=1,
                object_offset=unknown.object_offset,
                byte_size=unknown.byte_size,
                typetree=unknown_tree,
            ),
            "unknown-leaf-type",
        )

        disagree = write_fixture(
            os.path.join(tmp, "disagree.bin"), tree, submesh_bounds_disagree=True
        )
        expect(
            "d/submesh-bounds-disagree",
            lambda: read_mesh_local_aabb(
                disagree.path,
                path_id=1,
                object_offset=disagree.object_offset,
                byte_size=disagree.byte_size,
                typetree=tree,
            ),
            "submesh-bounds-disagree",
        )

        expect(
            "d/typetree-without-aabb",
            lambda: assert_typetree_shape(mesh_schema(drop_aabb=True)),
            "aabb-not-found-exactly-once",
        )
        expect(
            "d/typetree-without-submeshes",
            lambda: assert_typetree_shape(mesh_schema(drop_submeshes=True)),
            "no-submesh-crosscheck",
        )

        # ---- a fixed-width struct may not hide the AABB --------------------
        nested_tree = mesh_schema(nest_aabb_in_fixed_struct=True)
        nested = write_fixture(os.path.join(tmp, "nested.bin"), nested_tree)
        nested_record, _ = read_mesh_local_aabb(
            nested.path,
            path_id=1,
            object_offset=nested.object_offset,
            byte_size=nested.byte_size,
            typetree=nested_tree,
        )
        record(
            "h/fixed-struct-does-not-hide-the-aabb",
            tuple(round(v, 4) for v in nested_record.extents) == (7.05, 2.15, 1.52),
            f"extents={tuple(round(v, 3) for v in nested_record.extents)}",
        )

        # ---- discrimination: does this kill barrel-scored-as-wagon? --------
        lengths: Dict[str, float] = {}
        for name, (centre, extent) in {
            "barrel-sized": ((0.0, 0.45, 0.0), (0.29, 0.45, 0.29)),
            "6m-container": ((0.0, 1.30, 0.0), (3.05, 1.30, 1.22)),
            "closed-wagon": ((0.0, 2.10, 0.0), (7.05, 2.15, 1.52)),
        }.items():
            small = write_fixture(
                os.path.join(tmp, f"{name}.bin"),
                tree,
                aabb_center=centre,
                aabb_extent=extent,
                count_for=lambda path: min(default_count_for(path), 4096),
                trailing_bytes=64,
            )
            emitted, _ = read_mesh_local_aabb(
                small.path,
                path_id=1,
                object_offset=small.object_offset,
                byte_size=small.byte_size,
                typetree=tree,
            )
            lengths[name] = round(2 * max(emitted.extents), 2)
        record(
            "e/size-classes-separate",
            lengths["barrel-sized"] < 1.5 < lengths["6m-container"] < 8.0
            < lengths["closed-wagon"],
            f"longest axis (m): {lengths}",
        )

    del tripwire
    failures = [case for case in cases if not case["passed"]]
    return {
        "cases": len(cases),
        "failures": len(failures),
        "passed": not failures,
        "results": cases,
    }


# ==========================================================================
# 10. Output allowlist
# ==========================================================================

# Every key a bounds RECORD emits is already in the census's reviewed allowlist,
# so the bounds output needs no widening of that guard.  `test_extract_customs_bounds`
# asserts this containment directly rather than trusting the comment.
BOUNDS_RECORD_KEYS = frozenset(
    (
        "objectId",
        "asset",
        "pathId",
        "type",
        "sourceFile",
        "sourceRole",
        "sceneIndex",
        "scenePath",
        "localAabb",
        "center",
        "extents",
        "submeshCount",
        "x",
        "y",
        "z",
    )
)

# The envelope adds pin, instrumentation and refusal-ledger keys that the census
# never emits.  They are enumerated here, reviewed as a set, and enforced before
# any write by the same fail-closed walker the census uses.
BOUNDS_ENVELOPE_EXTRA_KEYS = frozenset(
    (
        "unityVersion",
        "typetreeSha256",
        "typetreeProvenance",
        "pins",
        "alignBase",
        "selfTest",
        "results",
        "passed",
        "cases",
        "failures",
        "detail",
        "instrumentation",
        "physicalReads",
        "bytesRead",
        "maxSingleRead",
        "payloadBytesRead",
        "readWidths",
        "seeks",
        "totalMeshBytes",
        "bytesReadRatio",
        "refusals",
        "refusalCounts",
        "count",
        "meshCandidateCount",
        "meshesRead",
        "meshesRefused",
        "caveat",
    )
)

BOUNDS_ALLOWED_OUTPUT_KEYS = (
    census.ALLOWED_OUTPUT_KEYS | BOUNDS_RECORD_KEYS | BOUNDS_ENVELOPE_EXTRA_KEYS
)

MAX_SCALAR_LIST = census.MAX_SCALAR_LIST


def assert_bounded_payload(payload: Any, *, path: str = "$") -> None:
    """Fail closed on an unreviewed key, a binary value, or an array payload."""
    if isinstance(payload, (bytes, bytearray, memoryview)):
        raise BoundsError(f"binary payload is never emitted (at {path})")
    if isinstance(payload, Mapping):
        for key, value in payload.items():
            if not isinstance(key, str):
                raise BoundsError(f"non-string key at {path}")
            if key not in BOUNDS_ALLOWED_OUTPUT_KEYS:
                raise BoundsError(f"unapproved output field '{key}' at {path}")
            assert_bounded_payload(value, path=f"{path}.{key}")
        return
    if isinstance(payload, (list, tuple)):
        scalar_items = sum(
            1 for item in payload if isinstance(item, (int, float, str, bool))
        )
        if scalar_items > MAX_SCALAR_LIST:
            raise BoundsError(
                f"scalar array of {scalar_items} entries exceeds the bound at {path}"
            )
        for index, item in enumerate(payload):
            assert_bounded_payload(item, path=f"{path}[{index}]")
        return
    if isinstance(payload, str):
        if len(payload) > 1024:
            raise BoundsError(f"string longer than 1024 characters at {path}")
        return
    if isinstance(payload, bool) or payload is None:
        return
    if isinstance(payload, (int, float)):
        if isinstance(payload, float) and not math.isfinite(payload):
            raise BoundsError(f"non-finite number at {path}")
        return
    raise BoundsError(f"unsupported value type {type(payload).__name__} at {path}")


# ==========================================================================
# 11. UnityPy acquisition adapter — every lookup fails closed
# ==========================================================================


def reader_object_offset(reader: Any) -> Optional[int]:
    """Absolute file offset of the object's serialized body.

    Deliberately narrow: only the attribute that means exactly this. A looser
    fallback (`offset`, say) could pick up a different concept and hand the walk
    a wrong start — which would abort on the checksum, but noisily and for a
    reason the ledger would misdescribe.
    """
    present, value = _present_value(reader, "byte_start", "byteStart")
    if not present:
        return None
    offset = _integer(value)
    if offset is None or offset < 0:
        return None
    return offset


def reader_unity_version(reader: Any) -> Optional[str]:
    """The version string as the serialized file reports it, never a guess."""
    for container_name in ("assets_file", "assetsFile"):
        present, container = _present_value(reader, container_name)
        if not present or container is None:
            continue
        found, value = _present_value(container, "unity_version", "unityVersion")
        if found:
            text = _clean_text(value, limit=64)
            if text:
                return text
    return None


def reader_typetree(reader: Any) -> Tuple[Node, str]:
    """Return (node tree, provenance) or refuse.

    `file-embedded` means the serialized file carried its own typetree.
    `library-generated` means UnityPy supplied it from its version-keyed
    database — a THIRD-PARTY SCHEMA that must be pinned by hash and reviewed
    before use, exactly like the Unity version (spike §5 row 4).
    """
    for container_name in ("serialized_type", "serializedType", "type_tree", "typetree"):
        present, container = _present_value(reader, container_name)
        if not present or container is None:
            continue
        for attribute in ("nodes", "node", "m_Nodes"):
            found, value = _present_value(container, attribute)
            if not found or not value:
                continue
            return nodes_from_flat(value), "file-embedded"
    for method_name in ("get_typetree_nodes", "getTypetreeNodes"):
        present, method = _present_value(reader, method_name)
        if present and callable(method):
            try:
                value = method()
            except Exception as error:
                raise BoundsRefusal("typetree-unavailable", _safe_error_type(error))
            if value:
                return nodes_from_flat(value), "library-generated"
    raise BoundsRefusal("typetree-unavailable", "no node source")


# ==========================================================================
# 12. The run
# ==========================================================================


def _bounds_record(
    record: BoundsRecord,
    *,
    selection: Mapping[str, Any],
    log: ReadLog,
) -> Dict[str, Any]:
    asset = selection["file"]
    return _drop_none(
        {
            "objectId": _object_id(asset, "Mesh", record.path_id),
            "asset": asset,
            "sourceFile": asset,
            "sourceRole": selection.get("role"),
            "sceneIndex": selection.get("sceneIndex"),
            "pathId": record.path_id,
            "type": "Mesh",
            "submeshCount": record.submesh_count,
            "localAabb": record.local_aabb(),
            "instrumentation": {
                "physicalReads": len(log.reads),
                "bytesRead": log.total_bytes,
                "maxSingleRead": log.max_single_read,
                "payloadBytesRead": log.payload_bytes,
                "readWidths": log.widths,
                "seeks": log.seeks,
            },
        }
    )


def build_bounds(
    source_root: Path,
    scene_files: Seq[Mapping[str, Any]],
    unitypy_module: Any,
    *,
    pinned_unity_version: str,
    pinned_typetree_sha256: str,
    align_base_mode: str,
) -> Dict[str, Any]:
    """Read `m_LocalAABB` for every Mesh in the authorized selection, or abort."""
    records: List[Dict[str, Any]] = []
    refusals: List[Dict[str, Any]] = []
    file_failures: List[Dict[str, Any]] = []
    scene_file_facts: List[Dict[str, Any]] = []
    loaded_scene_files = 0
    candidate_count = 0
    total_mesh_bytes = 0
    total_bytes_read = 0
    total_reads = 0
    max_single_read = 0
    payload_bytes_read = 0
    unity_versions: set = set()
    typetree_hashes: set = set()
    provenances: set = set()

    before_bindings = {
        selection["file"]: _capture_file_binding(selection["path"])
        for selection in scene_files
    }

    for selection in scene_files:
        candidate = selection["path"]
        before = before_bindings[selection["file"]]
        if before[1] is None:
            file_failures.append(
                {
                    "file": selection["file"],
                    "phase": "scene-binding",
                    "sceneIndex": selection["sceneIndex"],
                    "reason": "source-binding-before-failed",
                }
            )
            fact, _ = _verified_file_fact(
                file=selection["file"],
                role=selection["role"],
                before=before,
                after=before,
                selection=selection,
            )
            scene_file_facts.append(fact)
            continue

        unity_stream = None
        bounds_handle = None
        try:
            unity_stream = census._open_bound_unity_stream(
                candidate, selection["file"], before[1]
            )
            environment = unitypy_module.load(unity_stream)
            census._disable_dependency_loading(environment)
            readers = [
                reader
                for reader in environment.objects
                if selector._reader_type_name(reader) == "Mesh"
            ]
        except Exception as error:
            if unity_stream is not None:
                unity_stream.close()
            file_failures.append(
                {
                    "file": selection["file"],
                    "phase": "scene",
                    "sceneIndex": selection["sceneIndex"],
                    "errorType": _safe_error_type(error),
                }
            )
            after = _capture_file_binding(candidate)
            fact, verified = _verified_file_fact(
                file=selection["file"],
                role=selection["role"],
                before=before,
                after=after,
                selection=selection,
            )
            scene_file_facts.append(fact)
            if not verified:
                file_failures.append(
                    {
                        "file": selection["file"],
                        "phase": "scene-binding",
                        "sceneIndex": selection["sceneIndex"],
                        "reason": "source-changed-during-read",
                    }
                )
            continue

        loaded_scene_files += 1
        try:
            # The bounds reader owns its OWN handle and its own instrumentation.
            # It never reads a byte through UnityPy's stream.
            bounds_handle = census._SafeUnityStream(
                candidate, _safe_visible_name(selection["file"])
            )
            bounds_handle.seek(0, os.SEEK_END)
            file_bytes = bounds_handle.tell()

            for reader in readers:
                candidate_count += 1
                path_id = selector._reader_path_id(reader)
                asset = selection["file"]
                try:
                    if path_id is None:
                        raise BoundsRefusal("object-offset-unavailable", "no path id")
                    byte_size = census._reader_serialized_byte_size(reader)
                    if byte_size is None:
                        raise BoundsRefusal("serialized-object-size-unavailable")
                    object_offset = reader_object_offset(reader)
                    if object_offset is None:
                        raise BoundsRefusal("object-offset-unavailable")
                    total_mesh_bytes += byte_size

                    typetree, provenance = reader_typetree(reader)
                    tree_hash = typetree_sha256(typetree)
                    version = reader_unity_version(reader)

                    # Per-FILE facts, verified once and then required to be
                    # identical for every object: the schema is per-version, not
                    # per-object.
                    assert_pins(
                        unity_version=version,
                        pinned_unity_version=pinned_unity_version,
                        typetree_hash=tree_hash,
                        pinned_typetree_sha256=pinned_typetree_sha256,
                    )
                    if typetree_hashes and tree_hash not in typetree_hashes:
                        raise BoundsRefusal("typetree-divergence", tree_hash[:16])
                    if not typetree_hashes:
                        assert_typetree_shape(typetree)
                    unity_versions.add(version or "")
                    typetree_hashes.add(tree_hash)
                    provenances.add(provenance)

                    emitted, log = read_mesh_local_aabb_from_handle(
                        bounds_handle,
                        path_id=path_id,
                        object_offset=object_offset,
                        byte_size=byte_size,
                        file_bytes=file_bytes,
                        typetree=typetree,
                        align_base=None if align_base_mode == "object" else 0,
                    )
                except BoundsRefusal as refusal:
                    entry = _drop_none(
                        {
                            "objectId": _object_id(asset, "Mesh", path_id),
                            "asset": asset,
                            "sourceFile": asset,
                            "sceneIndex": selection.get("sceneIndex"),
                            "pathId": path_id,
                            "type": "Mesh",
                            "phase": "bounds",
                            "reason": refusal.reason,
                        }
                    )
                    refusals.append(entry)
                    if refusal.aborts_run:
                        # Spike §5: one structural divergence means the pin is
                        # wrong for the WHOLE file.  A per-object skip would turn
                        # a systematic schema error into a partial roster that
                        # looks fine.
                        raise BoundsError(
                            "aborting the run on a structural refusal "
                            f"({refusal.reason}); the pinned schema is wrong for "
                            "this file, not for this object. Nothing was written."
                        ) from refusal
                    continue
                except BoundsError:
                    raise
                except Exception as error:
                    # Anything the guards did not name is still a reason to stop.
                    # Raised with a bounded error TYPE so no exception string can
                    # carry a host path into the operator's terminal.
                    raise BoundsError(
                        "aborting the run on an unexpected reader failure "
                        f"({_safe_error_type(error)}). Nothing was written."
                    ) from error

                total_reads += len(log.reads)
                total_bytes_read += log.total_bytes
                payload_bytes_read += log.payload_bytes
                max_single_read = max(max_single_read, log.max_single_read)
                records.append(
                    _bounds_record(emitted, selection=selection, log=log)
                )
        finally:
            if bounds_handle is not None:
                bounds_handle.close()
            if unity_stream is not None:
                unity_stream.close()

        after = _capture_file_binding(candidate)
        fact, verified = _verified_file_fact(
            file=selection["file"],
            role=selection["role"],
            before=before,
            after=after,
            selection=selection,
        )
        scene_file_facts.append(fact)
        if not verified:
            raise BoundsError(
                f"source file changed during the read ({selection['file']}); "
                "nothing was written"
            )

    refusal_counts: Dict[str, int] = {}
    for entry in refusals:
        reason = str(entry.get("reason"))
        refusal_counts[reason] = refusal_counts.get(reason, 0) + 1

    ratio = (total_bytes_read / total_mesh_bytes) if total_mesh_bytes else 0.0
    complete = not refusals and not file_failures

    return {
        "schemaVersion": BOUNDS_SCHEMA_VERSION,
        "generator": GENERATOR_NAME,
        "selectionMode": "catalog-first-customs-only",
        "source": {
            "rootName": _clean_text(source_root.name) or "game-data",
            # The version as READ from the serialized files. It equals the pin by
            # construction — `assert_pins` aborts otherwise — but reporting the
            # observed value is what makes that an assertion rather than a claim.
            "unityVersion": sorted(v for v in unity_versions if v) or None,
            "sceneFiles": scene_file_facts,
            "sceneFileCount": len(scene_files),
            "loadedSceneFileCount": loaded_scene_files,
        },
        "pins": {
            "unityVersion": pinned_unity_version,
            "typetreeSha256": pinned_typetree_sha256,
            "typetreeProvenance": sorted(provenances) or None,
            "alignBase": align_base_mode,
        },
        "complete": complete,
        "counts": {
            "meshCandidateCount": candidate_count,
            "meshesRead": len(records),
            "meshesRefused": len(refusals),
        },
        "instrumentation": {
            "physicalReads": total_reads,
            "bytesRead": total_bytes_read,
            "maxSingleRead": max_single_read,
            "payloadBytesRead": payload_bytes_read,
            "totalMeshBytes": total_mesh_bytes,
            "bytesReadRatio": round(ratio, 12),
        },
        "meshes": sorted(records, key=lambda item: (item["asset"], item["pathId"])),
        "diagnostics": {
            "fileLoadFailures": file_failures,
            "refusals": refusals,
            "refusalCounts": [
                {"reason": reason, "count": count}
                for reason, count in sorted(refusal_counts.items())
            ],
        },
        "caveat": (
            "Bounds identify a mesh RESOURCE, not a placed visible object. They "
            "remove size-impossible candidates and supply dimensions; they never "
            "promote a candidate to a confirmed object. m_LocalAABB is local and "
            "pre-transform: any world extent is derived, needs the census's "
            "composed world scale, and over-estimates under rotated non-uniform "
            "scale."
        ),
    }


# ==========================================================================
# 13. CLI
# ==========================================================================


def _validate_bounds_paths(source_value: str, output_value: str) -> Tuple[Path, Path]:
    """Census path rules plus the pipeline's 'outside the repository' rule.

    The census guard only keeps the artifact out of the GAME tree. The sibling
    extractors add the second half — nothing derived from local game files is
    written where it could be committed or, worse, swept into `dist/` by a build.
    This reader is held to the same contract.
    """
    source_root, output_path = census._validate_paths_noclobber(source_value, output_value)
    if selector._path_is_inside(output_path, REPO_ROOT):
        raise BoundsError("output must be outside this repository")
    return source_root, output_path


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Read Mesh.m_LocalAABB scalars for the authorized Customs selection. "
            "Emits only {pathId, localAabb:{center,extents}} plus source identity; "
            "never materializes a typetree, never reads a payload byte, and aborts "
            "the whole run on any structural schema divergence."
        )
    )
    parser.add_argument("--source", required=True, help="Local game-data directory")
    parser.add_argument(
        "--output", required=True, help="Bounds JSON path outside the game data and repo"
    )
    parser.add_argument(
        "--acknowledge-local-game-files",
        action="store_true",
        help="Confirm you are intentionally inspecting local files you may access",
    )
    parser.add_argument(
        "--pin-unity-version",
        help="Exact Unity version string; the run refuses anything else",
    )
    parser.add_argument(
        "--pin-typetree-sha256",
        help="SHA-256 of the reviewed Mesh node tree; the run refuses anything else",
    )
    parser.add_argument(
        "--align-base",
        choices=("object", "file"),
        default="object",
        help=(
            "Base the 4-byte align flag is measured from. Default 'object'. "
            "Flipping it is a diagnostic for an end-offset divergence and MUST be "
            "reported in the run's evidence."
        ),
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Run every synthetic guard case in this process before anything else",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help=(
            "Validate paths and pins and locate globalgamemanagers without "
            "importing UnityPy, opening a serialized file, or writing anything"
        ),
    )
    parser.add_argument(
        "--allow-partial",
        action="store_true",
        help="Explicitly allow an output carrying a non-empty refusal ledger",
    )
    return parser


def main(
    argv: Optional[Seq[str]] = None,
    *,
    unitypy_module: Any = None,
    stdout: Optional[TextIO] = None,
    stderr: Optional[TextIO] = None,
) -> int:
    stdout = sys.stdout if stdout is None else stdout
    stderr = sys.stderr if stderr is None else stderr
    args = _parser().parse_args(argv)

    self_test: Optional[Dict[str, Any]] = None
    if args.self_test:
        self_test = run_self_test()
        for case in self_test["results"]:
            print(
                f"[{'PASS' if case['passed'] else 'FAIL'}] {case['name']}: "
                f"{case['detail']}",
                file=stdout,
            )
        print(
            f"self-test: {self_test['cases']} cases, {self_test['failures']} failures",
            file=stdout,
        )
        if not self_test["passed"]:
            print("error: self-test failed; nothing was read or written", file=stderr)
            return 2

    if not args.acknowledge_local_game_files:
        print(
            "error: refuse to inspect local game files without "
            "--acknowledge-local-game-files",
            file=stderr,
        )
        return 2

    try:
        source_root, output_path = _validate_bounds_paths(args.source, args.output)
        if not args.pin_unity_version:
            raise BoundsError("--pin-unity-version is required; the layout is pinned")
        if not args.pin_typetree_sha256:
            raise BoundsError(
                "--pin-typetree-sha256 is required; the schema is a reviewed input"
            )
        pinned_hash = args.pin_typetree_sha256.strip().lower()
        if len(pinned_hash) != 64 or any(c not in "0123456789abcdef" for c in pinned_hash):
            raise BoundsError("--pin-typetree-sha256 must be 64 hex characters")

        catalog_files = discover_catalog_files(source_root)
        if not catalog_files:
            raise BoundsError(
                "no globalgamemanagers BuildSettings catalog was found under --source"
            )
        if len(catalog_files) != 1:
            raise BoundsError(
                "expected exactly one globalgamemanagers catalog; narrow --source "
                "to one Unity Data root"
            )

        if args.dry_run:
            plan = {
                "dryRun": True,
                "wouldWrite": False,
                "selectionMode": "catalog-first-customs-only",
                "sourceRootName": _clean_text(source_root.name) or "game-data",
                "catalogFileCount": len(catalog_files),
                "catalogFiles": [
                    path.relative_to(source_root).as_posix() for path in catalog_files
                ],
                "pins": {
                    "unityVersion": args.pin_unity_version,
                    "typetreeSha256": pinned_hash,
                    "alignBase": args.align_base,
                },
                "selfTest": None if self_test is None else {
                    "cases": self_test["cases"],
                    "failures": self_test["failures"],
                    "passed": self_test["passed"],
                },
                "outputName": output_path.name,
                "deferredSceneSelection": (
                    "A real run parses BuildSettings, finds /Locations/Custom/ "
                    "indices, then opens only levelN and sharedassetsN.assets for "
                    "those indices and reads Mesh.m_LocalAABB from each."
                ),
            }
            print(json.dumps(plan, indent=2, sort_keys=True), file=stdout)
            return 0

        unitypy = (
            unitypy_module
            if unitypy_module is not None
            else selector._import_unitypy()
        )
        catalog = census.load_build_settings_catalog(
            source_root, catalog_files, unitypy
        )
        if catalog["loadedFileCount"] == 0:
            raise BoundsError("UnityPy could not load globalgamemanagers")
        if not catalog["complete"]:
            raise BoundsError(
                "BuildSettings catalog verification was incomplete; no scene "
                "selection was trusted"
            )
        scene_files = discover_customs_scene_files(source_root, catalog["sceneCatalog"])
        bounds = build_bounds(
            source_root,
            scene_files,
            unitypy,
            pinned_unity_version=args.pin_unity_version,
            pinned_typetree_sha256=pinned_hash,
            align_base_mode=args.align_base,
        )
        if bounds["source"]["loadedSceneFileCount"] == 0:
            raise BoundsError("UnityPy could not load the targeted Customs files")
        if self_test is not None:
            bounds["selfTest"] = {
                "cases": self_test["cases"],
                "failures": self_test["failures"],
                "passed": self_test["passed"],
            }
        if not bounds["complete"] and not args.allow_partial:
            raise BoundsError(
                f"the run refused {bounds['counts']['meshesRefused']} object(s) and "
                f"failed {len(bounds['diagnostics']['fileLoadFailures'])} file(s); "
                "review the ledger or pass --allow-partial explicitly"
            )
        assert_bounded_payload(bounds)
        json.dumps(bounds, allow_nan=False, sort_keys=True)
        _publish_json_noclobber([(output_path, bounds)])
        counts = bounds["counts"]
        instrumentation = bounds["instrumentation"]
        print(
            f"wrote Customs mesh bounds: {output_path.name} "
            f"({counts['meshesRead']} of {counts['meshCandidateCount']} meshes read, "
            f"{counts['meshesRefused']} refused, "
            f"{instrumentation['bytesRead']} bytes read of "
            f"{instrumentation['totalMeshBytes']} "
            f"({100.0 * instrumentation['bytesReadRatio']:.6f}%), "
            f"payloadBytesRead={instrumentation['payloadBytesRead']})",
            file=stdout,
        )
        return 0
    except (BoundsError, census.CensusError) as error:
        print(f"error: {error}", file=stderr)
        return 2
    except BoundsRefusal as error:
        print(f"error: refused: {error.reason}", file=stderr)
        return 2
    except OSError as error:
        print(f"error: filesystem operation failed: {type(error).__name__}", file=stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
