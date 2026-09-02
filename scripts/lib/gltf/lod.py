"""Cross-LOD silhouette containment — the shared invariant, one definition.

WHY THIS IS IN THE SHARED CORE
------------------------------
`docs/plans/BUILDING-MASSING.md` §5.1 reported a 26.34 mm LOD1 growth on the
Crackhouse and called it systemic. Measuring every LOD chain the three factories
produce confirmed it in all three:

    fortress-shell   LOD1 +15.6681 mm y.max, LOD2 +40.0000 mm x.max   (ADMITTED)
    crackhouse-shell LOD1 +13.1826 mm z.max / +13.1551 mm z.min
    tanker-wagon     LOD1 +15.0000 mm z.max and z.min

Three factories, three unrelated authoring mistakes, one missing invariant. The
invariant therefore belongs here, next to the reader, rather than in one
factory's QA directory — §4.4 of the plan puts it at `scripts/lib/gltf/lod.py`
for exactly this reason.

THE RULE
--------
    bounds(LOD n) must be contained in bounds(LOD n-1) AND in bounds(LOD 0),
    on every axis, on both sides.

Both comparisons are needed. A level that shrinks relative to a grown parent is
still outside LOD0, and consecutive containment alone would pass it.

A coarser level may lose material. It may never gain silhouette: a level that
grows pokes through the level it replaces at the switch distance, and it does not
fit inside a picking proxy, a shadow proxy, or a manifest bounds record derived
from LOD0. (`public/assets/3d/customs/scene-manifest.json` shows what happens
when nobody checks — the fortress asset's declared `bounds.max.y` is LOD2's
grown 18.230173, not LOD0's 18.198912, so the proxy box silently absorbed the
defect.)

WHAT IT DOES NOT ESTABLISH
--------------------------
Axis-aligned containment is necessary, not sufficient. A level can stay inside
the parent box and still change the silhouette from a given camera. This is a
cheap invariant that catches a real class of bug; it is not a visual gate.

Pure standard library, and it never imports ``bpy``: the validators must run
under plain ``python3`` in CI with no Blender on the machine. It works from
bounds *records*, not from files, so a validator that has already walked the
scene feeds in what it measured instead of parsing every GLB a second time.
"""

from __future__ import annotations

from typing import Mapping, Sequence

AXES = ("x", "y", "z")


class LodContainmentError(ValueError):
    """A refusal from this module.

    Deliberately a ``ValueError``: the three validators already funnel
    ``ValueError`` into their non-zero exit path, so the gate joins their
    existing failure channel rather than inventing a second one.
    """


def require(condition: bool, message: str) -> None:
    if not condition:
        raise LodContainmentError(message)


def bounds_record(minimum: Sequence[float], maximum: Sequence[float]) -> dict:
    """A bounds dict in the shape this module and all three validators use."""
    low = [float(value) for value in minimum]
    high = [float(value) for value in maximum]
    require(len(low) == len(high) == 3, "bounds need three axes")
    return {
        "min": low,
        "max": high,
        "sizeM": [high[axis] - low[axis] for axis in range(3)],
        "centerM": [(high[axis] + low[axis]) * 0.5 for axis in range(3)],
    }


def _validated(bounds: Mapping) -> tuple[list[float], list[float], list[float]]:
    low, high = bounds.get("min"), bounds.get("max")
    require(
        isinstance(low, (list, tuple)) and isinstance(high, (list, tuple)) and len(low) == len(high) == 3,
        "a bounds record needs three-component min and max",
    )
    low = [float(value) for value in low]
    high = [float(value) for value in high]
    size = bounds.get("sizeM")
    if not (isinstance(size, (list, tuple)) and len(size) == 3):
        size = [high[axis] - low[axis] for axis in range(3)]
    return low, high, [float(value) for value in size]


def containment(finer: Mapping, coarser: Mapping, tolerance_mm: float = 0.0) -> dict:
    """How far ``coarser`` escapes ``finer``, per axis and per side, in millimetres.

    Positive numbers are growth. Zero means the coarser level is inside, which is
    the only acceptable answer.
    """
    require(tolerance_mm >= 0.0, "tolerance must not be negative")
    finer_min, finer_max, finer_size = _validated(finer)
    coarse_min, coarse_max, coarse_size = _validated(coarser)
    escapes = []
    worst = 0.0
    for axis in range(3):
        low = (finer_min[axis] - coarse_min[axis]) * 1000.0
        high = (coarse_max[axis] - finer_max[axis]) * 1000.0
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
        "widthDeltaMm": [round((coarse_size[axis] - finer_size[axis]) * 1000.0, 4) for axis in range(3)],
    }


def chain_report(
    bounds_by_lod: Mapping[int, Mapping],
    tolerance_mm: float = 0.0,
    files: Mapping[int, str] | None = None,
) -> dict:
    """Measure a whole LOD chain from bounds records that are already computed."""
    levels = sorted(bounds_by_lod)
    require(len(levels) >= 2, "a chain needs at least two LODs")
    require(levels == list(range(levels[0], levels[0] + len(levels))), "LOD levels must be consecutive")
    require(levels[0] == 0, "a chain must start at LOD0")

    comparisons = []
    for lod in levels[1:]:
        step = containment(bounds_by_lod[lod - 1], bounds_by_lod[lod], tolerance_mm)
        against_zero = containment(bounds_by_lod[0], bounds_by_lod[lod], tolerance_mm)
        row = {
            "lod": lod,
            "againstLod": lod - 1,
            "step": step,
            "againstLod0": {key: value for key, value in against_zero.items() if key != "widthDeltaMm"},
        }
        if files is not None and lod in files:
            row["file"] = files[lod]
        comparisons.append(row)

    level_rows = []
    for lod in levels:
        low, high, size = _validated(bounds_by_lod[lod])
        row = {
            "lod": lod,
            "min": [round(value, 6) for value in low],
            "max": [round(value, 6) for value in high],
            "sizeM": [round(value, 6) for value in size],
        }
        primitives = bounds_by_lod[lod].get("primitives")
        if primitives is not None:
            row["primitives"] = primitives
        if files is not None and lod in files:
            row["file"] = files[lod]
        level_rows.append(row)

    failing = [row for row in comparisons if not row["step"]["contained"] or not row["againstLod0"]["contained"]]
    return {
        "schemaVersion": 1,
        "documentType": "tarkovzero-building-lod-silhouette",
        "rule": "bounds(LOD n) must be contained in bounds(LOD n-1) and in bounds(LOD 0) on every axis",
        "toleranceMm": tolerance_mm,
        "status": "PASS" if not failing else "FAIL",
        "levels": level_rows,
        "comparisons": comparisons,
        "note": (
            "An axis-aligned containment check is necessary, not sufficient. Passing it does not "
            "mean the coarser level looks like the finer one from any camera."
        ),
    }


def escape_table(report: Mapping) -> dict[tuple[int, str, str, str], float]:
    """Every escape in a chain report, keyed ``(lod, comparison, axis, side)``.

    ``comparison`` is ``"step"`` or ``"againstLod0"``. This is the shape a pinned
    known-defect waiver is written in, so a waiver and a measurement compare as
    plain dictionaries.
    """
    table: dict[tuple[int, str, str, str], float] = {}
    for row in report["comparisons"]:
        for comparison in ("step", "againstLod0"):
            for escape in row[comparison]["escapes"]:
                table[(row["lod"], comparison, escape["axis"], escape["side"])] = escape["growthMm"]
    return table


def assert_contained(
    bounds_by_lod: Mapping[int, Mapping],
    label: str,
    tolerance_mm: float = 0.0,
    known_growth: Mapping[tuple[int, str, str, str], float] | None = None,
    known_growth_note: str = "",
) -> dict:
    """The gate. Raises unless every level is contained in its parent and in LOD0.

    ``known_growth`` pins an already-reviewed defect: a table of exact expected
    growths, in millimetres, keyed as :func:`escape_table` keys. It is a tripwire,
    not a mute button — every pinned entry must still be produced by the build,
    at the pinned value, and any growth that is *not* pinned still fails. So the
    moment the underlying geometry moves in either direction — fixed, or made
    worse — this raises.

    A waiver exists for exactly one reason today: `fortress-shell` is admitted,
    with its three LOD digests pinned in `scene-manifest.json`, so correcting its
    growth re-cuts an asset the founder has already reviewed on a GPU. That is
    his call, not a refactor's.
    """
    report = chain_report(bounds_by_lod, tolerance_mm)
    measured = escape_table(report)
    pinned = dict(known_growth or {})

    unexpected = sorted(key for key in measured if key not in pinned)
    require(
        not unexpected,
        f"{label}: LOD silhouette grew — "
        + "; ".join(
            f"LOD{lod} {comparison} {axis}.{side} +{measured[(lod, comparison, axis, side)]:.4f} mm"
            for lod, comparison, axis, side in unexpected
        )
        + ". A coarser LOD may lose material; it may never gain silhouette.",
    )

    moved = sorted(
        key for key in pinned if key not in measured or abs(measured[key] - pinned[key]) > 1e-3
    )
    require(
        not moved,
        f"{label}: a pinned known LOD growth no longer matches "
        + "; ".join(
            f"LOD{lod} {comparison} {axis}.{side} expected +{pinned[(lod, comparison, axis, side)]:.4f} mm, "
            f"measured {'absent' if (lod, comparison, axis, side) not in measured else '+%.4f mm' % measured[(lod, comparison, axis, side)]}"
            for lod, comparison, axis, side in moved
        )
        + (f". {known_growth_note}" if known_growth_note else "")
        + " Re-measure and re-pin deliberately; do not widen the waiver to make a build pass.",
    )

    if pinned:
        report["knownGrowthMm"] = {
            f"lod{lod}.{comparison}.{axis}.{side}": value
            for (lod, comparison, axis, side), value in sorted(pinned.items())
        }
        report["knownGrowthNote"] = known_growth_note
        report["status"] = "PASS-WITH-PINNED-KNOWN-DEFECT"
    return report
