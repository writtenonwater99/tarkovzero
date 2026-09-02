"""Per-LOD grids of overlapping parts that do not change the silhouette.

THE BUG THIS EXISTS TO PREVENT
------------------------------
`docs/plans/BUILDING-MASSING.md` §5.1. Authored detail whose *count* falls with
the LOD, sized as a fixed *fraction* of the cell it occupies, grows the asset
every time the count halves.

The Crackhouse roof is the worked example. `add_roof()` laid ``rows x columns``
tiles on cell **centres** spanning the full slope::

    t = (row + 0.5) / rows                  # centre, as a fraction of the slope
    tile length = (slope_length / rows) * 1.08

The outermost course therefore reached ``slope_length + 0.04 * slope_length /
rows`` — an overhang that DOUBLES every time ``rows`` halves. At 12 rows it
tucked behind the gutter; at 6 rows it became the silhouette, and LOD1 came out
26.34 mm wider than LOD0.

Nothing about that is specific to roof tiles. Every archetype in §4.2 has such a
grid: shed cladding ribs, block window bands, canopy purlins, tower staves,
stair treads. Twelve buildings authored on the centre-based pattern would
reproduce it twelve times, which is why the fix is a shared function rather than
an edit to one roof.

THE FIX
-------
Lay the parts by **edges**, not centres, and clamp the overlap at the two ends
of the band. :func:`overlapping_band` returns cells that tile ``[start, start +
span]`` exactly: interior cells are grown symmetrically by ``overlap`` of a cell
length so courses lap, and the outermost cells are clamped so the union of the
parts spans exactly the band, whatever ``count`` is. The absolute silhouette
then stops being a function of the LOD's part count — which is the property that
was missing.

`lib.blender` normally means "imports bpy". This module does not: it is pure
arithmetic, like `lib.blender.noise`, so it is unit-testable under plain
``python3``. It lives here because it is an *authoring* helper — the validators
measure the result with `lib.gltf.lod` instead.
"""

from __future__ import annotations


def overlapping_band(index: int, count: int, span: float, overlap: float, start: float = 0.0) -> tuple[float, float]:
    """Centre and length of one part in a ``count``-part band of overlapping parts.

    The band's parts collectively cover ``[start, start + span]`` and never
    exceed it. Each part is grown by ``overlap`` of a nominal cell length —
    half at each end — and that growth is clipped at the band's two edges.

    Returns ``(centre, length)`` in the same units as ``span``.

    >>> overlapping_band(0, 4, 4.0, 0.08)          # first cell: outer edge clamped
    (0.52, 1.04)
    >>> overlapping_band(1, 4, 4.0, 0.08)          # interior cell: laps both ways
    (1.5, 1.08)
    >>> overlapping_band(3, 4, 4.0, 0.08)[0] + overlapping_band(3, 4, 4.0, 0.08)[1] / 2
    4.0
    """
    if not isinstance(count, int) or count < 1:
        raise ValueError("a band needs at least one part")
    if not isinstance(index, int) or not 0 <= index < count:
        raise ValueError(f"part index {index} is outside a band of {count}")
    if not span > 0.0:
        raise ValueError("a band needs a positive span")
    if overlap < 0.0:
        raise ValueError("overlap must not be negative")
    if overlap > 2.0:
        # Beyond this a single part would swallow its neighbours whole and the
        # "count" would stop meaning anything; refuse rather than silently
        # producing one giant plate.
        raise ValueError("overlap above 2.0 cell lengths is not a course layout")

    cell = span / count
    half = overlap * 0.5 * cell
    low = max(0.0, index * cell - half)
    high = min(span, (index + 1) * cell + half)
    return start + (low + high) * 0.5, high - low


def band_fraction(index: int, count: int, overlap: float) -> tuple[float, float]:
    """:func:`overlapping_band` on the unit interval — ``(centre_t, length_t)``.

    Convenient where the band is parameterised by a fraction of a slope or a run
    rather than by metres.
    """
    return overlapping_band(index, count, 1.0, overlap)


def outer_anchored_center(outer: float, thickness: float) -> float:
    """Centre-line offset for a member whose OUTER face must not move.

    The second half of the same defect class, and the one the fortress girders
    and the tanker's tank bands both have: a member that gets *thicker* at a
    coarser LOD, positioned by its centre-line, pushes its outer face outward by
    half the thickness increase. Anchor the outer face instead and the envelope
    stops depending on the LOD.

    ``thickness`` is the full extent from the centre-line outward — a tube's
    radius, or half a box's depth.

    >>> round(outer_anchored_center(1.457, 0.045), 6)
    1.412
    >>> round(outer_anchored_center(1.457, 0.06), 6)
    1.397
    """
    if thickness < 0.0:
        raise ValueError("thickness must not be negative")
    if thickness > outer:
        raise ValueError("a member thicker than its own outer radius has no centre-line")
    return outer - thickness
