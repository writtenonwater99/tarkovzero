#!/usr/bin/env python3
"""Cross-LOD silhouette containment for authored building GLBs.

WHY THIS EXISTS
---------------
`validate_crackhouse_outputs.py` asserts that bytes and triangles strictly fall across
LOD0/1/2, and that each LOD's declared bounds match its own actual bounds. It never
compares one LOD's bounds against another's. That gap is not theoretical: the shipped
Crackhouse candidate's LOD1 is **26.3 mm wider in Z than LOD0**, and the whole existing
gate passes it.

The rule a decimation chain must obey is stronger than "cheaper":

    bounds(LOD n) must be contained in bounds(LOD n-1), on every axis.

A coarser level may lose material. It may never gain silhouette. A level that grows will
poke through the level it replaces at the switch distance, and it will not fit inside a
picking proxy, a shadow proxy, or a manifest bounds record derived from LOD0.

THE FAILURE CLASS THIS CATCHES
------------------------------
Authored detail whose *count* changes per LOD, sized by a fixed *fraction* of the cell it
sits in. The Crackhouse roof lays `rows x columns` tiles on cell centres spanning the full
slope and gives each tile `1.08 x` the cell length so courses overlap. The half of that
overlap belonging to the outermost course escapes the roof plane, by

    0.04 / rows  x  slope_run  metres

which DOUBLES every time the row count halves. LOD0 (12 rows) tucks the tiles behind the
gutter; LOD1 (6 rows) pushes them past it. Nothing about that is specific to roof tiles:
any per-LOD grid of overlapping parts has it.

This module is pure stdlib and never imports bpy. It reads only the glTF JSON chunk and
the POSITION accessors' declared `min`/`max`, which glTF requires on POSITION, so it does
not decode a single vertex.

USAGE
-----
    python3 scripts/building-asset-factory/lod_silhouette.py \
      --glb 0=/path/crackhouse-shell-lod0.glb \
      --glb 1=/path/crackhouse-shell-lod1.glb \
      --glb 2=/path/crackhouse-shell-lod2.glb \
      --output /path/qa/lod-silhouette.json

Exits non-zero when a level grows. `--report-only` measures without gating, for recording
a known defect on a candidate that is not being admitted yet.

WHAT IT DOES NOT ESTABLISH
--------------------------
Containment of an axis-aligned box is a necessary condition, not a sufficient one. A level
can stay inside the parent box and still change the silhouette from a given camera. This
is a cheap invariant that catches a real class of bug; it is not a visual gate, and it says
nothing about whether either level resembles anything in the game.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path
from typing import Callable, Iterable, Sequence

GLB_MAGIC = b"glTF"
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942
AXES = ("x", "y", "z")
MAX_GLB_BYTES = 64 * 1024 * 1024


class SilhouetteError(RuntimeError):
    """A refusal. Every guard in this module raises this rather than guessing."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SilhouetteError(message)


def read_glb_json(path: Path) -> dict:
    """Return the glTF JSON chunk of a self-contained GLB.

    Refuses external resources rather than resolving them: the asset contract for this
    lane is embedded-only, and a reader that quietly followed a `uri` would measure a
    different file than the one that ships.
    """
    require(path.is_file(), f"{path.name}: not a file")
    size = path.stat().st_size
    require(0 < size <= MAX_GLB_BYTES, f"{path.name}: implausible GLB size {size}")
    data = path.read_bytes()
    require(len(data) >= 20 and data[:4] == GLB_MAGIC, f"{path.name}: not a GLB container")
    version, declared_length = struct.unpack_from("<II", data, 4)
    require(version == 2, f"{path.name}: unsupported GLB version {version}")
    require(declared_length == len(data), f"{path.name}: header length {declared_length} != file size {len(data)}")

    document: dict | None = None
    offset = 12
    while offset + 8 <= len(data):
        chunk_length, chunk_type = struct.unpack_from("<II", data, offset)
        body = offset + 8
        require(body + chunk_length <= len(data), f"{path.name}: chunk overruns the file")
        if chunk_type == JSON_CHUNK:
            require(document is None, f"{path.name}: more than one JSON chunk")
            document = json.loads(data[body:body + chunk_length].decode("utf-8"))
        elif chunk_type != BIN_CHUNK:
            raise SilhouetteError(f"{path.name}: unknown GLB chunk type 0x{chunk_type:08X}")
        offset = body + chunk_length + ((4 - chunk_length % 4) % 4)
    require(isinstance(document, dict), f"{path.name}: no glTF JSON chunk")
    for kind in ("buffers", "images"):
        require(
            all("uri" not in entry for entry in document.get(kind, [])),
            f"{path.name}: contains an external {kind[:-1]} reference",
        )
    return document


def identity() -> list[list[float]]:
    return [[1.0 if row == column else 0.0 for column in range(4)] for row in range(4)]


def matmul(left: Sequence[Sequence[float]], right: Sequence[Sequence[float]]) -> list[list[float]]:
    return [[sum(left[row][k] * right[k][column] for k in range(4)) for column in range(4)] for row in range(4)]


def node_local_matrix(node: dict) -> list[list[float]]:
    """glTF node TRS or an explicit column-major `matrix`, as a row-major 4x4."""
    if "matrix" in node:
        m = node["matrix"]
        require(isinstance(m, list) and len(m) == 16, "node matrix must have 16 numbers")
        return [[float(m[column * 4 + row]) for column in range(4)] for row in range(4)]
    tx, ty, tz = (float(v) for v in node.get("translation", (0.0, 0.0, 0.0)))
    qx, qy, qz, qw = (float(v) for v in node.get("rotation", (0.0, 0.0, 0.0, 1.0)))
    sx, sy, sz = (float(v) for v in node.get("scale", (1.0, 1.0, 1.0)))
    rotation = (
        (1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)),
        (2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)),
        (2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)),
    )
    scale = (sx, sy, sz)
    translation = (tx, ty, tz)
    return [
        [rotation[row][column] * scale[column] for column in range(3)] + [translation[row]]
        for row in range(3)
    ] + [[0.0, 0.0, 0.0, 1.0]]


def scene_bounds(document: dict, select: Callable[[dict], bool] | None = None) -> dict:
    """World-space AABB of the default scene, from POSITION accessor min/max only.

    Every one of the eight corners of a primitive's declared box is transformed, so a
    rotated node contributes the box its rotation actually sweeps rather than a rotated
    pair of extreme points.
    """
    nodes = document.get("nodes", [])
    scenes = document.get("scenes", [])
    require(bool(scenes), "document declares no scenes")
    scene = scenes[document.get("scene", 0)]
    minimum = [float("inf")] * 3
    maximum = [float("-inf")] * 3
    counted = 0

    def visit(index: int, parent: Sequence[Sequence[float]], depth: int) -> None:
        nonlocal counted
        require(depth < 64, "node hierarchy deeper than 64 levels")
        require(0 <= index < len(nodes), f"node index {index} out of range")
        node = nodes[index]
        world = matmul(parent, node_local_matrix(node))
        if "mesh" in node and (select is None or select(node)):
            mesh = document["meshes"][node["mesh"]]
            for primitive in mesh.get("primitives", []):
                position = primitive.get("attributes", {}).get("POSITION")
                require(position is not None, "primitive has no POSITION attribute")
                accessor = document["accessors"][position]
                low, high = accessor.get("min"), accessor.get("max")
                require(
                    isinstance(low, list) and isinstance(high, list) and len(low) == len(high) == 3,
                    "POSITION accessor is missing its declared min/max",
                )
                for cx in (float(low[0]), float(high[0])):
                    for cy in (float(low[1]), float(high[1])):
                        for cz in (float(low[2]), float(high[2])):
                            point = (cx, cy, cz, 1.0)
                            for axis in range(3):
                                value = sum(world[axis][k] * point[k] for k in range(4))
                                minimum[axis] = min(minimum[axis], value)
                                maximum[axis] = max(maximum[axis], value)
                counted += 1
        for child in node.get("children", []):
            visit(child, world, depth + 1)

    for root in scene.get("nodes", []):
        visit(root, identity(), 0)
    require(counted > 0, "scene contains no mesh primitives")
    return {
        "min": minimum,
        "max": maximum,
        "sizeM": [maximum[i] - minimum[i] for i in range(3)],
        "centerM": [(maximum[i] + minimum[i]) * 0.5 for i in range(3)],
        "primitives": counted,
    }


def containment(finer: dict, coarser: dict, tolerance_mm: float = 0.0) -> dict:
    """How far `coarser` escapes `finer`, per axis and per side, in millimetres.

    Positive numbers are growth. Zero means the coarser level is inside, which is the
    only acceptable answer.
    """
    require(tolerance_mm >= 0.0, "tolerance must not be negative")
    escapes = []
    worst = 0.0
    for axis in range(3):
        low = (finer["min"][axis] - coarser["min"][axis]) * 1000.0
        high = (coarser["max"][axis] - finer["max"][axis]) * 1000.0
        for side, value in (("min", low), ("max", high)):
            growth = max(0.0, value)
            if growth > worst:
                worst = growth
            if growth > tolerance_mm:
                escapes.append({"axis": AXES[axis], "side": side, "growthMm": round(growth, 4)})
    return {
        "contained": not escapes,
        "worstGrowthMm": round(worst, 4),
        "escapes": escapes,
        "widthDeltaMm": [round((coarser["sizeM"][axis] - finer["sizeM"][axis]) * 1000.0, 4) for axis in range(3)],
    }


def evaluate(paths_by_lod: dict[int, Path], tolerance_mm: float = 0.0) -> dict:
    """Measure a whole LOD chain. Consecutive containment is the rule; LOD0 is reported too."""
    levels = sorted(paths_by_lod)
    require(len(levels) >= 2, "a chain needs at least two LODs")
    require(levels == list(range(levels[0], levels[0] + len(levels))), "LOD levels must be consecutive")
    require(levels[0] == 0, "a chain must start at LOD0")

    bounds = {}
    for lod in levels:
        document = read_glb_json(paths_by_lod[lod])
        bounds[lod] = scene_bounds(document)

    comparisons = []
    for lod in levels[1:]:
        step = containment(bounds[lod - 1], bounds[lod], tolerance_mm)
        against_zero = containment(bounds[0], bounds[lod], tolerance_mm)
        comparisons.append({
            "lod": lod,
            "againstLod": lod - 1,
            "file": paths_by_lod[lod].name,
            "step": step,
            "againstLod0": {k: v for k, v in against_zero.items() if k != "widthDeltaMm"},
        })
    failing = [row for row in comparisons if not row["step"]["contained"] or not row["againstLod0"]["contained"]]
    return {
        "schemaVersion": 1,
        "documentType": "tarkovzero-building-lod-silhouette",
        "rule": "bounds(LOD n) must be contained in bounds(LOD n-1) and in bounds(LOD 0) on every axis",
        "toleranceMm": tolerance_mm,
        "status": "PASS" if not failing else "FAIL",
        "levels": [
            {
                "lod": lod,
                "file": paths_by_lod[lod].name,
                "min": [round(v, 6) for v in bounds[lod]["min"]],
                "max": [round(v, 6) for v in bounds[lod]["max"]],
                "sizeM": [round(v, 6) for v in bounds[lod]["sizeM"]],
                "primitives": bounds[lod]["primitives"],
            }
            for lod in levels
        ],
        "comparisons": comparisons,
        "note": (
            "An axis-aligned containment check is necessary, not sufficient. Passing it does not "
            "mean the coarser level looks like the finer one from any camera."
        ),
    }


def parse_glb_arguments(values: Iterable[str]) -> dict[int, Path]:
    paths: dict[int, Path] = {}
    for value in values:
        require("=" in value, f"--glb expects LOD=path, got {value!r}")
        level, _, raw = value.partition("=")
        require(level.strip().isdigit(), f"--glb LOD must be a non-negative integer, got {level!r}")
        lod = int(level.strip())
        require(lod not in paths, f"LOD{lod} supplied twice")
        paths[lod] = Path(raw.strip()).expanduser()
    return paths


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--glb", action="append", required=True, metavar="LOD=PATH")
    parser.add_argument("--output", type=Path, default=None, help="write the JSON report here (no clobber)")
    parser.add_argument("--tolerance-mm", type=float, default=0.0)
    parser.add_argument("--report-only", action="store_true", help="measure without gating")
    args = parser.parse_args(list(argv) if argv is not None else None)

    try:
        report = evaluate(parse_glb_arguments(args.glb), args.tolerance_mm)
    except SilhouetteError as error:
        print(f"REFUSED: {error}", file=sys.stderr)
        return 2

    for level in report["levels"]:
        print(f"LOD{level['lod']} {level['file']}  size {['%.6f' % v for v in level['sizeM']]}")
    for row in report["comparisons"]:
        step = row["step"]
        verdict = "contained" if step["contained"] else "GREW"
        print(f"LOD{row['lod']} vs LOD{row['againstLod']}: {verdict}, worst {step['worstGrowthMm']:.4f} mm")
        for escape in step["escapes"]:
            print(f"    +{escape['growthMm']:.4f} mm on {escape['axis']}.{escape['side']}")
    print(f"status {report['status']}")

    if args.output is not None:
        require_no_clobber = args.output
        if require_no_clobber.exists():
            print(f"REFUSED: {require_no_clobber} already exists", file=sys.stderr)
            return 2
        require_no_clobber.parent.mkdir(parents=True, exist_ok=True)
        require_no_clobber.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    if report["status"] == "FAIL" and not args.report_only:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
