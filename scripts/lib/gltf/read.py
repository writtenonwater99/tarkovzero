"""GLB parsing, node transforms, and scene traversal — one definition each.

Extracted verbatim from the three factories and three validators that each
carried a private copy (``glb_json``, ``node_matrix``, ``multiply4`` /
``matrix_multiply``, ``sha256_file``, ``require``, ``close``, ``named``, and the
traversal core of ``geometry_stats``).

Where the copies differed only in error-message wording or in a default
tolerance, this module takes the value as an argument so no caller's behaviour
moves. Where they differed in what they actually compute — ``geometry_stats``
returns different keys per validator — this module supplies the shared
traversal (:func:`iter_mesh_primitives`) and each validator keeps its own
contract on top of it.

Pure standard library. Do not import ``bpy`` here.
"""

from __future__ import annotations

import hashlib
import json
import math
import struct
from pathlib import Path
from typing import Callable, Iterator, NamedTuple, Sequence

GLB_MAGIC = b"glTF"
GLB_VERSION = 2
GLB_JSON_CHUNK = 0x4E4F534A
GLB_BIN_CHUNK = 0x004E4942
GLB_HEADER_BYTES = 12
#: glTF primitive modes that describe triangles (TRIANGLES, STRIP, FAN).
TRIANGLE_MODES = (4, 5, 6)


def require(condition: bool, message: str) -> None:
    """Raise ``ValueError(message)`` unless ``condition`` holds."""
    if not condition:
        raise ValueError(message)


def sha256_file(path: Path) -> str:
    """Streaming SHA-256 of a file, 1 MiB at a time."""
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def close(actual: object, expected: float, tolerance: float) -> bool:
    """True when ``actual`` is finite and within ``tolerance`` of ``expected``.

    ``tolerance`` is required rather than defaulted: the copies this replaces
    defaulted to 1e-4 (fortress) and 1e-5 (crackhouse), and a shared default
    would silently loosen or tighten one of them.
    """
    try:
        return math.isfinite(float(actual)) and abs(float(actual) - expected) <= tolerance
    except (TypeError, ValueError):
        return False


def vector_close(actual: object, expected: Sequence[float], tolerance: float) -> bool:
    """Element-wise :func:`close` over a list of the same length."""
    return (
        isinstance(actual, list)
        and len(actual) == len(expected)
        and all(close(a, e, tolerance) for a, e in zip(actual, expected))
    )


def glb_json(path: Path, label: object | None = None) -> dict:
    """Parse the JSON chunk of a GLB, rejecting a malformed container.

    ``label`` is appended to every error message. The validators pinned the
    file path there and the in-factory copies pinned nothing; passing ``None``
    reproduces the bare messages.
    """
    suffix = f": {label}" if label is not None else ""
    blob = Path(path).read_bytes()
    require(len(blob) >= 20, f"truncated GLB{suffix}")
    magic, version, length = struct.unpack_from("<4sII", blob, 0)
    require((magic, version, length) == (GLB_MAGIC, GLB_VERSION, len(blob)),
            f"invalid GLB header{suffix}")
    offset, document = GLB_HEADER_BYTES, None
    while offset + 8 <= len(blob):
        chunk_length, chunk_type = struct.unpack_from("<II", blob, offset)
        offset += 8
        end = offset + chunk_length
        require(end <= len(blob), f"invalid GLB chunk{suffix}")
        if chunk_type == GLB_JSON_CHUNK:
            require(document is None, f"multiple GLB JSON chunks{suffix}")
            document = json.loads(blob[offset:end].decode("utf-8"))
        offset = end
    require(offset == len(blob) and isinstance(document, dict), f"missing GLB JSON{suffix}")
    return document


def identity4() -> list[list[float]]:
    """The 4×4 identity, row-major."""
    return [[float(row == column) for column in range(4)] for row in range(4)]


def matrix_multiply(
    left: Sequence[Sequence[float]], right: Sequence[Sequence[float]]
) -> list[list[float]]:
    """Row-major 4×4 product. ``multiply4`` in the crackhouse copies."""
    return [[sum(left[row][k] * right[k][column] for k in range(4)) for column in range(4)]
            for row in range(4)]


#: The crackhouse factory and validator spell :func:`matrix_multiply` this way.
multiply4 = matrix_multiply


def node_matrix(node: dict) -> list[list[float]]:
    """Row-major local matrix of a glTF node, from ``matrix`` or from TRS.

    A supplied ``matrix`` is column-major per the glTF spec and is transposed
    here. The copies this replaces disagreed only on whether a malformed
    ``matrix`` was rejected; this one always rejects, which is the strictest of
    the three and cannot change the result for a well-formed document.
    """
    if "matrix" in node:
        values = node["matrix"]
        require(isinstance(values, list) and len(values) == 16,
                "glTF node matrix must have 16 values")
        return [[float(values[column * 4 + row]) for column in range(4)] for row in range(4)]
    x, y, z, w = (float(value) for value in node.get("rotation", [0.0, 0.0, 0.0, 1.0]))
    sx, sy, sz = (float(value) for value in node.get("scale", [1.0, 1.0, 1.0]))
    tx, ty, tz = (float(value) for value in node.get("translation", [0.0, 0.0, 0.0]))
    rotation = (
        (1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)),
        (2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)),
        (2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)),
    )
    return [
        [rotation[0][0] * sx, rotation[0][1] * sy, rotation[0][2] * sz, tx],
        [rotation[1][0] * sx, rotation[1][1] * sy, rotation[1][2] * sz, ty],
        [rotation[2][0] * sx, rotation[2][1] * sy, rotation[2][2] * sz, tz],
        [0.0, 0.0, 0.0, 1.0],
    ]


def transform_point(
    world: Sequence[Sequence[float]], point: Sequence[float]
) -> list[float]:
    """Apply a row-major 4×4 to a 3-vector treated as a point (w = 1)."""
    source = (float(point[0]), float(point[1]), float(point[2]), 1.0)
    return [sum(world[row][column] * source[column] for column in range(4)) for row in range(3)]


def named(document: dict, name: str) -> dict:
    """The one node called ``name``; raises unless exactly one exists."""
    found = [node for node in document.get("nodes", []) if node.get("name") == name]
    require(len(found) == 1, f"expected one node named {name}")
    return found[0]


class MeshPrimitive(NamedTuple):
    """One glTF primitive, resolved against the node that instantiates it."""

    node_index: int
    node: dict
    mesh_index: int
    primitive: dict
    world: list[list[float]]


def iter_mesh_primitives(
    document: dict,
    select: Callable[[dict], bool] | None = None,
) -> Iterator[MeshPrimitive]:
    """Walk the default scene, yielding every primitive with its world matrix.

    This is the traversal that ``geometry_stats`` duplicated three times. The
    three copies computed *different* statistics from it — the fortress and
    crackhouse validators report ``triangles`` and ``boundsM``, the industrial
    one also reports ``vertices``/``drawCalls`` and rejects instanced meshes —
    so the shared piece is the walk, not the summary. Each validator keeps its
    own contract by consuming this.

    ``select`` filters on the *node*; children of a rejected node are still
    visited, matching the original behaviour.
    """
    nodes = document.get("nodes", [])
    scenes = document.get("scenes", [])
    scene_index = int(document.get("scene", 0))
    require(0 <= scene_index < len(scenes), "invalid default scene")

    def visit(index: int, parent: Sequence[Sequence[float]]) -> Iterator[MeshPrimitive]:
        node = nodes[index]
        world = matrix_multiply(parent, node_matrix(node))
        if "mesh" in node and (select is None or select(node)):
            mesh_index = int(node["mesh"])
            for primitive in document.get("meshes", [])[mesh_index].get("primitives", []):
                yield MeshPrimitive(index, node, mesh_index, primitive, world)
        for child in node.get("children", []):
            yield from visit(int(child), world)

    for root in scenes[scene_index].get("nodes", []):
        yield from visit(int(root), identity4())


def primitive_triangles(document: dict, primitive: dict, position_index: int) -> int:
    """Triangle count of one primitive, honouring TRIANGLES/STRIP/FAN."""
    accessors = document.get("accessors", [])
    mode = int(primitive.get("mode", 4))
    require(mode in TRIANGLE_MODES, f"unsupported primitive mode {mode}")
    index_accessor = primitive.get("indices")
    count = int(accessors[index_accessor]["count"] if isinstance(index_accessor, int)
                else accessors[position_index]["count"])
    return count // 3 if mode == 4 else max(0, count - 2)


def position_bounds(document: dict, position_index: int, *, require_finite: bool = False):
    """The POSITION accessor's declared ``min``/``max``, validated."""
    accessor = document.get("accessors", [])[position_index]
    low, high = accessor.get("min"), accessor.get("max")
    valid = isinstance(low, list) and isinstance(high, list) and len(low) == len(high) == 3
    if valid and require_finite:
        valid = all(math.isfinite(float(value)) for value in list(low) + list(high))
    require(valid, "invalid POSITION bounds")
    return low, high


def expand_bounds(
    minimum: list[float],
    maximum: list[float],
    world: Sequence[Sequence[float]],
    low: Sequence[float],
    high: Sequence[float],
) -> None:
    """Grow ``minimum``/``maximum`` in place by the 8 transformed AABB corners."""
    for px in (low[0], high[0]):
        for py in (low[1], high[1]):
            for pz in (low[2], high[2]):
                point = transform_point(world, (px, py, pz))
                for axis in range(3):
                    minimum[axis] = min(minimum[axis], point[axis])
                    maximum[axis] = max(maximum[axis], point[axis])
