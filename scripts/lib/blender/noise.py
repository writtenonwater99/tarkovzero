"""The procedural-texture seed functions, with their divergence made explicit.

``hash01`` and ``smoothstep`` were copy-pasted into all three factories and the
copies do not agree. They seed every procedural texture, so unifying them would
change texture pixels — and therefore GLB bytes — in whichever factory lost.
That is a re-baseline decision for the founder (an admitted asset would need
re-admission), not something a refactor may decide.

So both behaviours live here as *named variants* and every caller states which
one it wants. There is no default: a new factory author has to choose, in the
open, rather than inherit whichever copy they pasted from.

Pure arithmetic, no ``bpy`` — importable under plain ``python3`` for tests.
"""

from __future__ import annotations

from math import floor as _floor

# --- hash01 variants ---------------------------------------------------------

#: ``fortress_factory.py`` and ``crackhouse_factory.py``.
#: Mixes with ``+`` and masks to 32 bits before the avalanche, so the whole
#: function stays inside one 32-bit word.
HASH01_MASKED_SUM = "masked-sum-v1"

#: ``industrial_prop_factory.py``.
#: Mixes with ``^`` and applies **no** mask, so the first ``value`` is an
#: unbounded Python int — up to ~63 bits for realistic inputs — and the first
#: ``value >>= 16`` therefore folds down bits that the masked variant has
#: already discarded. It is a different function, not a different spelling.
HASH01_XOR_UNMASKED = "xor-unmasked-v1"

HASH01_VARIANTS = (HASH01_MASKED_SUM, HASH01_XOR_UNMASKED)

_MIX_X = 0x1F123BB5
_MIX_Y = 0x5F356495
_MIX_SEED = 0x6C8E9CF5
_AVALANCHE_A = 0x7FEB352D
_AVALANCHE_B = 0x846CA68B
_U32 = 0xFFFFFFFF


def hash01(x: int, y: int, seed: int, *, variant: str) -> float:
    """Small deterministic integer hash in ``[0, 1]``.

    ``variant`` must be one of :data:`HASH01_VARIANTS`. It is keyword-only and
    has no default on purpose — see the module docstring.
    """
    if variant == HASH01_MASKED_SUM:
        value = (x * _MIX_X + y * _MIX_Y + seed * _MIX_SEED) & _U32
    elif variant == HASH01_XOR_UNMASKED:
        value = (x * _MIX_X) ^ (y * _MIX_Y) ^ (seed * _MIX_SEED)
    else:
        raise ValueError(f"unknown hash01 variant: {variant!r}; expected one of {HASH01_VARIANTS}")
    value ^= value >> 16
    value = (value * _AVALANCHE_A) & _U32
    value ^= value >> 15
    value = (value * _AVALANCHE_B) & _U32
    value ^= value >> 16
    return value / _U32


# --- smoothstep variants -----------------------------------------------------

#: ``fortress_factory.py`` and ``crackhouse_factory.py``. Evaluates the cubic on
#: whatever it is given; outside ``[0, 1]`` the result runs away from ``[0, 1]``.
SMOOTHSTEP_UNCLAMPED = "unclamped-v1"

#: ``industrial_prop_factory.py``. Clamps the input to ``[0, 1]`` first.
SMOOTHSTEP_CLAMPED = "clamped-v1"

SMOOTHSTEP_VARIANTS = (SMOOTHSTEP_UNCLAMPED, SMOOTHSTEP_CLAMPED)


def smoothstep(value: float, *, variant: str) -> float:
    """Hermite ``3t² − 2t³``. ``variant`` selects whether the input is clamped."""
    if variant == SMOOTHSTEP_CLAMPED:
        value = max(0.0, min(1.0, value))
    elif variant != SMOOTHSTEP_UNCLAMPED:
        raise ValueError(
            f"unknown smoothstep variant: {variant!r}; expected one of {SMOOTHSTEP_VARIANTS}")
    return value * value * (3.0 - 2.0 * value)


# --- tiling value noise ------------------------------------------------------
#
# The same idea shipped three times under three names, and all three differ:
#
#   fortress_factory.tile_value_noise   cell = cell SIZE in pixels; bilinear
#                                       closes with ``top + (bottom - top) * ty``
#   crackhouse_factory.tile_noise       cell = cell SIZE in pixels, guarded by
#                                       ``max(1, cell)``; bilinear closes with
#                                       ``top * (1 - ty) + bottom * ty``
#   industrial_prop_factory.periodic_noise
#                                       cells = cell COUNT; no ``max(2, ...)``
#                                       floor on the grid
#
# ``a + (b - a) * t`` and ``a * (1 - t) + b * t`` are algebraically equal and
# are **not** equal in IEEE-754 double, so the fortress and crackhouse forms
# genuinely produce different pixels. They are kept apart deliberately. The
# parameter's *meaning* changes between the pixel-cell and cell-count forms, so
# these stay three functions rather than one function with a mode flag.

def tile_noise_cell_pixels_lerp(
    x: int, y: int, size: int, cell: int, seed: int,
    *, hash_variant: str, smoothstep_variant: str,
) -> float:
    """``fortress_factory.tile_value_noise``, verbatim."""
    grid = max(2, size // cell)
    gx = x / cell
    gy = y / cell
    x0 = _floor(gx) % grid
    y0 = _floor(gy) % grid
    tx = smoothstep(gx - _floor(gx), variant=smoothstep_variant)
    ty = smoothstep(gy - _floor(gy), variant=smoothstep_variant)
    a = hash01(x0, y0, seed, variant=hash_variant)
    b = hash01((x0 + 1) % grid, y0, seed, variant=hash_variant)
    c = hash01(x0, (y0 + 1) % grid, seed, variant=hash_variant)
    d = hash01((x0 + 1) % grid, (y0 + 1) % grid, seed, variant=hash_variant)
    top = a + (b - a) * tx
    bottom = c + (d - c) * tx
    return top + (bottom - top) * ty


def tile_noise_cell_pixels_mix(
    x: int, y: int, size: int, cell: int, seed: int,
    *, hash_variant: str, smoothstep_variant: str,
) -> float:
    """``crackhouse_factory.tile_noise``, verbatim.

    Differs from :func:`tile_noise_cell_pixels_lerp` in the ``max(1, cell)``
    guard and in the closing interpolation, which is the ``mix`` form and so
    rounds differently.
    """
    grid = max(2, size // max(1, cell))
    gx, gy = x / cell, y / cell
    x0, y0 = _floor(gx) % grid, _floor(gy) % grid
    tx = smoothstep(gx - _floor(gx), variant=smoothstep_variant)
    ty = smoothstep(gy - _floor(gy), variant=smoothstep_variant)
    a = hash01(x0, y0, seed, variant=hash_variant)
    b = hash01((x0 + 1) % grid, y0, seed, variant=hash_variant)
    c = hash01(x0, (y0 + 1) % grid, seed, variant=hash_variant)
    d = hash01((x0 + 1) % grid, (y0 + 1) % grid, seed, variant=hash_variant)
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty


def tile_noise_cell_count_lerp(
    x: int, y: int, size: int, cells: int, seed: int,
    *, hash_variant: str, smoothstep_variant: str,
) -> float:
    """``industrial_prop_factory.periodic_noise``, verbatim.

    ``cells`` is a cell COUNT here, not a cell size in pixels.
    """
    scale = size / cells
    gx = x / scale
    gy = y / scale
    x0 = _floor(gx)
    y0 = _floor(gy)
    tx = smoothstep(gx - x0, variant=smoothstep_variant)
    ty = smoothstep(gy - y0, variant=smoothstep_variant)
    x1 = (x0 + 1) % cells
    y1 = (y0 + 1) % cells
    x0 %= cells
    y0 %= cells
    a = hash01(x0, y0, seed, variant=hash_variant)
    b = hash01(x1, y0, seed, variant=hash_variant)
    c = hash01(x0, y1, seed, variant=hash_variant)
    d = hash01(x1, y1, seed, variant=hash_variant)
    top = a + (b - a) * tx
    bottom = c + (d - c) * tx
    return top + (bottom - top) * ty


#: Which factory uses which combination today. Read this before authoring a new
#: one; pick deliberately rather than by whichever file you copied.
FACTORY_NOISE_PROFILES = {
    "fortress": {
        "hash01": HASH01_MASKED_SUM,
        "smoothstep": SMOOTHSTEP_UNCLAMPED,
        "tile_noise": "tile_noise_cell_pixels_lerp",
    },
    "crackhouse": {
        "hash01": HASH01_MASKED_SUM,
        "smoothstep": SMOOTHSTEP_UNCLAMPED,
        "tile_noise": "tile_noise_cell_pixels_mix",
    },
    "industrial": {
        "hash01": HASH01_XOR_UNMASKED,
        "smoothstep": SMOOTHSTEP_CLAMPED,
        "tile_noise": "tile_noise_cell_count_lerp",
    },
}
