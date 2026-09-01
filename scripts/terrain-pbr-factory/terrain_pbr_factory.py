#!/usr/bin/env python3
"""Deterministic, original-authored Customs terrain PBR texture factory.

This module intentionally uses only the Python standard library.  It never reads
game files, reference pixels, or the network.  The generated PNGs are seamless
source slices for the renderer's twelve-layer KTX2 texture-array contract.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from typing import Iterable, Sequence
import zlib


GENERATOR_NAME = "tarkovzero-customs-terrain-pbr-factory"
GENERATOR_VERSION = "2.1.0"
SCHEMA_VERSION = 1
LICENSE_SPDX = "CC0-1.0"
AUTHORED_ASSET_ROOT = "/assets/3d/customs/terrain-authored/"
MACRO_METRES_PER_REPEAT = 256.0
MACRO_STRENGTH = 0.16
MACRO_SEED = 0x7A45C1E9
MIN_SIZE = 32
MAX_SIZE = 1024
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
KTX2_SIGNATURE = b"\xabKTX 20\xbb\r\n\x1a\n"
MASK64 = (1 << 64) - 1
TAU = math.tau


class FactoryError(RuntimeError):
    """A stable, user-facing factory failure."""


@dataclass(frozen=True)
class LayerSpec:
    index: int
    semantic: str
    seed: int
    profile: str
    base_rgb: tuple[int, int, int]
    feature_rgb: tuple[int, int, int]
    accent_rgb: tuple[int, int, int]
    metres_per_repeat: float
    feature_reference_metres: float
    height_metres: float
    normal_strength: float
    roughness: float


@dataclass(frozen=True)
class MicroGritSpec:
    albedo_units: float
    height_metres: float
    roughness_delta: float


# This order is the renderer contract.  Seeds are explicit ABI: changing one is
# an authored asset revision, not a harmless refactor.
LAYERS: tuple[LayerSpec, ...] = (
    # V2 gives every layer six times the V1 world footprint.  The following
    # reference scale keeps semantic stamps at their original real-world size
    # and density instead of making every pebble or grass clump six times larger.
    LayerSpec(0, "grass", 0x31A9D671, "grass", (67, 74, 48), (80, 86, 55), (100, 92, 63), 14.4, 2.4, 0.045, 1.25, 0.86),
    LayerSpec(1, "ground", 0xA88F0B23, "ground", (82, 69, 52), (104, 87, 62), (55, 48, 40), 21.0, 3.5, 0.035, 1.00, 0.96),
    LayerSpec(2, "gravel-road-a", 0x7083E2D5, "road-a", (100, 96, 86), (122, 117, 103), (66, 64, 59), 27.0, 4.5, 0.050, 1.10, 0.80),
    LayerSpec(3, "forest-ground", 0xC6D2490F, "forest", (61, 54, 40), (82, 68, 46), (124, 83, 44), 19.2, 3.2, 0.055, 1.20, 0.93),
    LayerSpec(4, "stone-ground", 0x16E70CA9, "stone", (108, 106, 99), (127, 124, 113), (72, 72, 69), 24.0, 4.0, 0.085, 1.35, 0.72),
    LayerSpec(5, "rock-ground", 0xE5B18F4D, "rock", (79, 84, 84), (101, 106, 103), (51, 56, 58), 36.0, 6.0, 0.190, 1.65, 0.76),
    LayerSpec(6, "gravel-road-b", 0x4FC32A17, "road-b", (81, 73, 62), (104, 91, 74), (52, 47, 41), 25.2, 4.2, 0.060, 1.15, 0.83),
    LayerSpec(7, "gravel", 0x921DC8E3, "gravel", (102, 100, 94), (128, 124, 112), (68, 67, 64), 13.2, 2.2, 0.055, 1.30, 0.74),
    LayerSpec(8, "grassy-ground", 0x2B74F6C1, "grassy", (77, 81, 54), (91, 95, 61), (79, 69, 52), 16.8, 2.8, 0.060, 1.25, 0.86),
    LayerSpec(9, "sand", 0xDB056E39, "sand", (142, 132, 105), (166, 151, 116), (104, 92, 72), 18.0, 3.0, 0.040, 0.90, 0.94),
    LayerSpec(10, "pebbles-ground", 0x65C4A78B, "pebbles", (114, 110, 101), (138, 132, 117), (76, 75, 72), 15.0, 2.5, 0.075, 1.35, 0.72),
    LayerSpec(11, "soil-grass", 0xF03B591D, "soil-grass", (82, 73, 55), (84, 89, 55), (108, 96, 66), 18.0, 3.0, 0.055, 1.20, 0.92),
)

# The three target bands are physical, not UV-relative.  At 512 px, the 3 cm
# band is carried by albedo/roughness grain where resolvable; height-derived
# normals clamp to a two-texel Nyquist floor to avoid moving-camera sparkle.
MICRO_GRIT_WAVELENGTHS_METRES: tuple[float, ...] = (0.12, 0.07, 0.03)
MICRO_GRIT_BY_PROFILE: dict[str, MicroGritSpec] = {
    "grass": MicroGritSpec(1.8, 0.0007, 0.016),
    "ground": MicroGritSpec(4.2, 0.0055, 0.065),
    "road-a": MicroGritSpec(4.5, 0.0060, 0.065),
    "forest": MicroGritSpec(2.0, 0.0011, 0.022),
    "stone": MicroGritSpec(4.5, 0.0080, 0.070),
    "rock": MicroGritSpec(4.7, 0.0120, 0.075),
    "road-b": MicroGritSpec(4.5, 0.0065, 0.065),
    "gravel": MicroGritSpec(5.0, 0.0080, 0.080),
    "grassy": MicroGritSpec(1.8, 0.0010, 0.020),
    "sand": MicroGritSpec(1.5, 0.0010, 0.022),
    "pebbles": MicroGritSpec(5.0, 0.0090, 0.080),
    "soil-grass": MicroGritSpec(4.0, 0.0050, 0.060),
}

# Fractional chroma reduction plus a tiny blueward bias.  Living and earth
# families stay recognizably olive/umber; already-neutral stone receives only a
# token cool shift so this pass cannot collapse the map into a grey wash.
PALETTE_GRADE_BY_PROFILE: dict[str, tuple[float, float]] = {
    "grass": (0.080, 0.5),
    "ground": (0.100, 0.8),
    "road-a": (0.085, 0.7),
    "forest": (0.075, 0.5),
    "stone": (0.040, 0.3),
    "rock": (0.040, 0.3),
    "road-b": (0.100, 0.8),
    "gravel": (0.075, 0.5),
    "grassy": (0.080, 0.5),
    "sand": (0.075, 0.7),
    "pebbles": (0.060, 0.5),
    "soil-grass": (0.095, 0.7),
}

TERRAIN_LAYER_NAMES: tuple[str, ...] = (
    "microsplat_layer_Grass_summer_D_0",
    "microsplat_layer_Ground_summer_D_1",
    "microsplat_layer_Gravel_Road_A_summer_D_2",
    "microsplat_layer_Forest_Ground_summer_D_3",
    "microsplat_layer_Stone_Ground_summer_D_4",
    "microsplat_layer_Rock_Ground_summer_D_5",
    "microsplat_layer_Gravel_Road_B_summer_D_6",
    "microsplat_layer_Gravel_summer_D_7",
    "microsplat_layer_Grassy_Ground_summer_D_8",
    "microsplat_layer_Sand_summer_D_9",
    "microsplat_layer_Pebbles_Ground_summer_D_10",
    "microsplat_layer_Soil_Grass_summer_D_11",
)


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return low if value < low else high if value > high else value


def smoothstep(edge0: float, edge1: float, value: float) -> float:
    if edge0 == edge1:
        return 0.0 if value < edge0 else 1.0
    t = clamp((value - edge0) / (edge1 - edge0))
    return t * t * (3.0 - 2.0 * t)


def mix(a: float, b: float, amount: float) -> float:
    return a + (b - a) * clamp(amount)


def _splitmix64(value: int) -> int:
    value = (value + 0x9E3779B97F4A7C15) & MASK64
    value = ((value ^ (value >> 30)) * 0xBF58476D1CE4E5B9) & MASK64
    value = ((value ^ (value >> 27)) * 0x94D049BB133111EB) & MASK64
    return (value ^ (value >> 31)) & MASK64


def random01(seed: int, x: int, y: int, lane: int = 0) -> float:
    value = seed & MASK64
    value ^= ((x & 0xFFFFFFFF) * 0xD6E8FEB86659FD93) & MASK64
    value ^= ((y & 0xFFFFFFFF) * 0xA5A3564E27F8862B) & MASK64
    value ^= ((lane & 0xFFFFFFFF) * 0x9E3779B185EBCA87) & MASK64
    return ((_splitmix64(value) >> 11) & ((1 << 53) - 1)) / float(1 << 53)


class PeriodicNoise:
    """Small cached periodic value-noise lattices for one semantic layer."""

    def __init__(self, seed: int):
        self.seed = seed
        self._tables: dict[tuple[int, int], tuple[float, ...]] = {}

    def _table(self, cells: int, lane: int) -> tuple[float, ...]:
        key = (cells, lane)
        table = self._tables.get(key)
        if table is None:
            table = tuple(
                random01(self.seed ^ (lane * 0x45D9F3B), x, y, lane)
                for y in range(cells)
                for x in range(cells)
            )
            self._tables[key] = table
        return table

    def sample(self, u: float, v: float, cells: int, lane: int) -> float:
        table = self._table(cells, lane)
        xf = u * cells
        yf = v * cells
        x0_unwrapped = math.floor(xf)
        y0_unwrapped = math.floor(yf)
        tx = xf - x0_unwrapped
        ty = yf - y0_unwrapped
        sx = tx * tx * (3.0 - 2.0 * tx)
        sy = ty * ty * (3.0 - 2.0 * ty)
        x0 = x0_unwrapped % cells
        y0 = y0_unwrapped % cells
        x1 = (x0 + 1) % cells
        y1 = (y0 + 1) % cells
        a = table[y0 * cells + x0]
        b = table[y0 * cells + x1]
        c = table[y1 * cells + x0]
        d = table[y1 * cells + x1]
        return mix(mix(a, b, sx), mix(c, d, sx), sy)

    @staticmethod
    def _scaled_cells(base: int, density_scale: float, maximum: int) -> int:
        return max(1, min(maximum, round(base * density_scale)))

    def macro(self, u: float, v: float, density_scale: float, period: int) -> float:
        # Scale the lattice frequency with the enlarged physical footprint so
        # soil patches retain metre-scale dimensions.  Unlike V1, this makes a
        # 14--36 m tile contain genuinely new structure rather than one enlarged
        # 2--6 m motif.  The broadest octave remains comfortably below Nyquist.
        maximum = max(2, period // 6)
        return (
            self.sample(u, v, self._scaled_cells(2, density_scale, maximum), 1) * 0.50
            + self.sample(u, v, self._scaled_cells(4, density_scale, maximum), 2) * 0.31
            + self.sample(u, v, self._scaled_cells(8, density_scale, maximum), 3) * 0.19
        )

    def micro(self, u: float, v: float, density_scale: float, period: int) -> float:
        maximum = max(2, period)
        return (
            self.sample(u, v, self._scaled_cells(16, density_scale, maximum), 4) * 0.47
            + self.sample(u, v, self._scaled_cells(32, density_scale, maximum), 5) * 0.33
            + self.sample(u, v, self._scaled_cells(64, density_scale, maximum), 6) * 0.20
        )

    def grain(self, u: float, v: float, density_scale: float, period: int) -> float:
        # The first octave is capped below Nyquist and the second at one lattice
        # cell per unique pixel.  This preserves stochastic micro-detail without
        # inventing unresolved sub-pixel periodic patterns at 512 px.
        first = self._scaled_cells(128, density_scale, max(2, period // 2))
        second = self._scaled_cells(256, density_scale, max(2, period))
        return self.sample(u, v, first, 7) * 0.62 + self.sample(u, v, second, 8) * 0.38

    def micro_grit(
        self,
        u: float,
        v: float,
        spec: LayerSpec,
        period: int,
    ) -> tuple[float, float, float]:
        """Return decorrelated height, albedo, and roughness grit signals.

        Frequencies are derived from physical metres.  Every lattice is square
        and stochastic, and no axis-oriented analytic wave or repeated stamp is
        introduced.  The two-texel cap makes the normal contribution rounded;
        the existing one-pixel `grain` octave carries the finest albedo/ORM
        breakup where the physical footprint can actually resolve it.
        """

        maximum = max(2, period // 2)
        bands = []
        for lane, wavelength in enumerate(MICRO_GRIT_WAVELENGTHS_METRES, start=30):
            cells = max(2, min(maximum, round(spec.metres_per_repeat / wavelength)))
            bands.append((self.sample(u, v, cells, lane) - 0.5) * 2.0)
        long_band, medium_band, short_band = bands
        height = long_band * 0.58 + medium_band * 0.42
        albedo = long_band * 0.22 + medium_band * 0.43 + short_band * 0.35
        roughness = long_band * 0.20 - medium_band * 0.28 + short_band * 0.52
        return height, albedo, roughness


def _set_max(field: list[float], period: int, x: int, y: int, value: float) -> None:
    index = (y % period) * period + (x % period)
    if value > field[index]:
        field[index] = value


def _stamp_ellipse(
    field: list[float],
    period: int,
    cx: float,
    cy: float,
    rx: float,
    ry: float,
    angle: float,
    strength: float,
) -> None:
    radius = max(1, math.ceil(max(rx, ry)))
    cos_a = math.cos(angle)
    sin_a = math.sin(angle)
    center_x = int(math.floor(cx))
    center_y = int(math.floor(cy))
    inv_rx = 1.0 / max(rx, 0.55)
    inv_ry = 1.0 / max(ry, 0.55)
    for offset_y in range(-radius, radius + 1):
        for offset_x in range(-radius, radius + 1):
            px = center_x + offset_x + 0.5 - cx
            py = center_y + offset_y + 0.5 - cy
            local_x = (px * cos_a + py * sin_a) * inv_rx
            local_y = (-px * sin_a + py * cos_a) * inv_ry
            distance = math.sqrt(local_x * local_x + local_y * local_y)
            if distance < 1.0:
                mask = (1.0 - smoothstep(0.38, 1.0, distance)) * strength
                _set_max(field, period, center_x + offset_x, center_y + offset_y, mask)


def _stamp_grid(
    field: list[float],
    period: int,
    spec: LayerSpec,
    grid: int,
    lane: int,
    radius_x: tuple[float, float],
    radius_y: tuple[float, float],
    density: float = 1.0,
) -> None:
    density_scale = spec.metres_per_repeat / spec.feature_reference_metres
    # More grid cells fill the larger V2 tile, while normalized radii shrink by
    # the same factor.  Thus feature density and dimensions remain stable in
    # metres.  Small test textures cap the grid to avoid sub-pixel oversampling;
    # the production 512 px build does not hit this cap for any profile.
    grid = min(max(2, round(grid * density_scale)), max(2, period // 2))
    radius_x = (radius_x[0] / density_scale, radius_x[1] / density_scale)
    radius_y = (radius_y[0] / density_scale, radius_y[1] / density_scale)
    for cell_y in range(grid):
        for cell_x in range(grid):
            if random01(spec.seed, cell_x, cell_y, lane) > density:
                continue
            jitter_x = 0.12 + random01(spec.seed, cell_x, cell_y, lane + 1) * 0.76
            jitter_y = 0.12 + random01(spec.seed, cell_x, cell_y, lane + 2) * 0.76
            cx = (cell_x + jitter_x) / grid * period
            cy = (cell_y + jitter_y) / grid * period
            rx = period * mix(radius_x[0], radius_x[1], random01(spec.seed, cell_x, cell_y, lane + 3))
            ry = period * mix(radius_y[0], radius_y[1], random01(spec.seed, cell_x, cell_y, lane + 4))
            angle = TAU * random01(spec.seed, cell_x, cell_y, lane + 5)
            strength = 0.68 + random01(spec.seed, cell_x, cell_y, lane + 6) * 0.32
            _stamp_ellipse(field, period, cx, cy, rx, ry, angle, strength)


def _periodic_voronoi_boundaries(
    period: int,
    spec: LayerSpec,
    cells: int,
    lane: int,
    inner_width: float,
    outer_width: float,
) -> list[float]:
    """Return an irregular, exactly periodic cellular crack network."""

    points = {
        (cell_x, cell_y): (
            0.16 + random01(spec.seed, cell_x, cell_y, lane) * 0.68,
            0.16 + random01(spec.seed, cell_x, cell_y, lane + 1) * 0.68,
        )
        for cell_y in range(cells)
        for cell_x in range(cells)
    }
    result = [0.0] * (period * period)
    for y in range(period):
        grid_y = y / period * cells
        base_y = math.floor(grid_y)
        for x in range(period):
            grid_x = x / period * cells
            base_x = math.floor(grid_x)
            nearest = float("inf")
            second = float("inf")
            for offset_y in (-1, 0, 1):
                cell_y = base_y + offset_y
                for offset_x in (-1, 0, 1):
                    cell_x = base_x + offset_x
                    jitter_x, jitter_y = points[(cell_x % cells, cell_y % cells)]
                    dx = cell_x + jitter_x - grid_x
                    dy = cell_y + jitter_y - grid_y
                    distance_squared = dx * dx + dy * dy
                    if distance_squared < nearest:
                        second = nearest
                        nearest = distance_squared
                    elif distance_squared < second:
                        second = distance_squared
            edge_gap = second - nearest
            result[y * period + x] = 1.0 - smoothstep(inner_width, outer_width, edge_gap)
    return result


def build_feature_maps(spec: LayerSpec, period: int) -> tuple[list[float], list[float]]:
    primary = [0.0] * (period * period)
    accent = [0.0] * (period * period)
    profile = spec.profile
    if profile == "grass":
        _stamp_grid(primary, period, spec, 9, 100, (0.030, 0.055), (0.030, 0.060), 0.95)
        _stamp_grid(accent, period, spec, 29, 120, (0.004, 0.008), (0.014, 0.032), 0.72)
    elif profile == "ground":
        _stamp_grid(primary, period, spec, 15, 140, (0.009, 0.022), (0.009, 0.022), 0.62)
        _stamp_grid(accent, period, spec, 22, 160, (0.003, 0.009), (0.003, 0.012), 0.46)
    elif profile in {"road-a", "road-b"}:
        _stamp_grid(primary, period, spec, 25, 180, (0.004, 0.010), (0.004, 0.012), 0.78)
        _stamp_grid(accent, period, spec, 11, 200, (0.012, 0.030), (0.010, 0.025), 0.50)
        # Short, rotated tread/rut fragments read as road wear up close without
        # the two infinite analytic stripes that advertised every V1 repeat.
        _stamp_grid(accent, period, spec, 5, 210, (0.040, 0.115), (0.003, 0.009), 0.58)
    elif profile == "forest":
        _stamp_grid(primary, period, spec, 18, 220, (0.006, 0.015), (0.018, 0.035), 0.90)
        _stamp_grid(accent, period, spec, 27, 240, (0.002, 0.005), (0.014, 0.030), 0.62)
    elif profile == "stone":
        _stamp_grid(primary, period, spec, 10, 260, (0.026, 0.055), (0.022, 0.050), 0.92)
        _stamp_grid(accent, period, spec, 18, 280, (0.004, 0.011), (0.005, 0.015), 0.38)
    elif profile == "rock":
        _stamp_grid(primary, period, spec, 7, 300, (0.045, 0.085), (0.035, 0.075), 0.96)
        _stamp_grid(accent, period, spec, 15, 320, (0.004, 0.010), (0.020, 0.050), 0.58)
    elif profile == "gravel":
        _stamp_grid(primary, period, spec, 31, 340, (0.003, 0.009), (0.003, 0.010), 0.91)
        _stamp_grid(accent, period, spec, 16, 360, (0.009, 0.020), (0.008, 0.018), 0.63)
    elif profile == "grassy":
        _stamp_grid(primary, period, spec, 12, 380, (0.022, 0.048), (0.022, 0.050), 0.83)
        _stamp_grid(accent, period, spec, 21, 400, (0.004, 0.011), (0.005, 0.014), 0.57)
    elif profile == "sand":
        _stamp_grid(primary, period, spec, 10, 420, (0.006, 0.016), (0.006, 0.018), 0.34)
        _stamp_grid(accent, period, spec, 17, 440, (0.003, 0.008), (0.003, 0.009), 0.26)
    elif profile == "pebbles":
        _stamp_grid(primary, period, spec, 24, 460, (0.005, 0.013), (0.004, 0.012), 0.90)
        _stamp_grid(accent, period, spec, 13, 480, (0.012, 0.028), (0.010, 0.024), 0.64)
    elif profile == "soil-grass":
        _stamp_grid(primary, period, spec, 10, 500, (0.024, 0.052), (0.025, 0.055), 0.66)
        _stamp_grid(accent, period, spec, 25, 520, (0.003, 0.007), (0.012, 0.028), 0.48)
    else:  # pragma: no cover - the closed semantic table makes this unreachable.
        raise FactoryError(f"unsupported profile: {profile}")
    density_scale = spec.metres_per_repeat / spec.feature_reference_metres
    if profile == "ground":
        crack_cells = min(round(9 * density_scale), max(2, period // 3))
        cracks = _periodic_voronoi_boundaries(period, spec, crack_cells, 600, 0.012, 0.070)
        accent = [max(stamp, crack * 0.19) for stamp, crack in zip(accent, cracks)]
    elif profile == "stone":
        crack_cells = min(round(7 * density_scale), max(2, period // 3))
        cracks = _periodic_voronoi_boundaries(period, spec, crack_cells, 620, 0.016, 0.080)
        accent = [max(stamp, crack * 0.24) for stamp, crack in zip(accent, cracks)]
    elif profile == "rock":
        crack_cells = min(round(5 * density_scale), max(2, period // 3))
        cracks = _periodic_voronoi_boundaries(period, spec, crack_cells, 640, 0.020, 0.095)
        accent = [max(stamp, crack * 0.26) for stamp, crack in zip(accent, cracks)]
    return primary, accent


def semantic_signals(
    spec: LayerSpec,
    u: float,
    v: float,
    macro: float,
    micro: float,
    primary: float,
    accent: float,
) -> tuple[float, float, float, float, float]:
    """Return feature mix, accent mix, height metres, cavity hint, roughness delta."""

    centered_macro = macro - 0.5
    centered_micro = micro - 0.5
    height = spec.height_metres * (centered_macro * 0.46 + centered_micro * 0.34)
    cavity = 0.0
    rough_delta = centered_micro * 0.10
    feature_mix = primary
    accent_mix = accent

    if spec.profile == "grass":
        feature_mix = clamp(primary * 0.78 + smoothstep(0.48, 0.72, macro) * 0.35)
        height += spec.height_metres * (primary * 0.48 + accent * 0.70)
        rough_delta += accent * 0.035
    elif spec.profile == "ground":
        accent_mix = accent
        height -= spec.height_metres * (primary * 0.55 + accent * 0.32)
        cavity = max(primary * 0.32, accent * 0.42)
    elif spec.profile in {"road-a", "road-b"}:
        compacted = smoothstep(0.47, 0.68, macro * 0.42 + micro * 0.58)
        feature_mix = clamp(primary * 0.78 + accent * 0.24 + compacted * 0.08)
        accent_mix = clamp(accent * 0.80 + compacted * 0.10)
        height += spec.height_metres * (
            primary * 0.36 + accent * 0.10 - compacted * 0.10
        )
        cavity = clamp(accent * 0.27 + compacted * 0.05)
        rough_delta += accent * 0.022 - compacted * 0.018
    elif spec.profile == "forest":
        litter_tone = smoothstep(0.32, 0.72, micro)
        feature_mix = clamp(primary * 0.90 + smoothstep(0.54, 0.70, macro) * 0.20)
        accent_mix = clamp(accent * (0.72 + litter_tone * 0.22))
        height += spec.height_metres * (primary * 0.58 + accent * 0.31)
        cavity = clamp((1.0 - macro) * 0.10 + primary * 0.09)
    elif spec.profile == "stone":
        accent_mix = accent
        height += spec.height_metres * (primary * 0.72 - accent * 0.40)
        cavity = accent * 0.55
        rough_delta -= primary * 0.08
    elif spec.profile == "rock":
        mass = smoothstep(0.30, 0.72, macro * 0.68 + micro * 0.32)
        feature_mix = clamp(primary * (0.82 + mass * 0.15))
        accent_mix = accent
        height += spec.height_metres * (primary * (0.61 + mass * 0.16) - accent * 0.22)
        cavity = accent * 0.58
        rough_delta -= primary * 0.07
    elif spec.profile == "gravel":
        height += spec.height_metres * (primary * 0.62 + accent * 0.44)
        feature_mix = clamp(primary * 0.82 + accent * 0.28)
        accent_mix = accent
        rough_delta -= primary * 0.045
    elif spec.profile == "grassy":
        soil_patch = 1.0 - smoothstep(0.38, 0.62, macro)
        feature_mix = clamp(primary * 0.77 + (1.0 - soil_patch) * 0.20)
        accent_mix = clamp(accent * 0.75 + soil_patch * 0.22)
        height += spec.height_metres * (primary * 0.54 + accent * 0.28)
    elif spec.profile == "sand":
        soft_grain = smoothstep(0.30, 0.72, micro)
        feature_mix = clamp(soft_grain * 0.12 + primary * 0.40)
        accent_mix = accent
        height += spec.height_metres * ((micro - 0.5) * 0.26 + primary * 0.22)
        rough_delta += 0.026 - soft_grain * 0.014
    elif spec.profile == "pebbles":
        feature_mix = clamp(primary * 0.90 + accent * 0.20)
        accent_mix = accent
        height += spec.height_metres * (primary * 0.76 + accent * 0.53)
        rough_delta -= primary * 0.08
    elif spec.profile == "soil-grass":
        green_patch = smoothstep(0.54, 0.72, macro)
        feature_mix = clamp(primary * 0.82 + green_patch * 0.20)
        accent_mix = accent
        height += spec.height_metres * (primary * 0.56 + accent * 0.46)
        cavity = clamp((1.0 - green_patch) * 0.08)

    return feature_mix, accent_mix, height, cavity, rough_delta


def _cool_desaturate_rgb(spec: LayerSpec, values: Sequence[float]) -> tuple[float, float, float]:
    amount, cooling = PALETTE_GRADE_BY_PROFILE[spec.profile]
    luminance = values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722
    return (
        mix(values[0], luminance, amount) - cooling,
        mix(values[1], luminance, amount),
        mix(values[2], luminance, amount) + cooling,
    )


def _rgb_pixel(
    spec: LayerSpec,
    macro: float,
    micro: float,
    grain: float,
    feature_mix: float,
    accent_mix: float,
    grit: float,
) -> tuple[int, int, int]:
    # The 256 m macro texture owns broad color breakup.  Keeping per-layer
    # albedo modulation restrained prevents a repeated low-frequency square
    # from reading as a checkerboard in the live aerial view.
    brightness = (macro - 0.5) * 20.0 + (micro - 0.5) * 14.0 + (grain - 0.5) * 10.0
    brightness += grit * MICRO_GRIT_BY_PROFILE[spec.profile].albedo_units
    if spec.profile in {"forest", "rock"}:
        brightness -= 4.0
    accent_weight = {
        "grass": 0.36,
        "ground": 0.38,
        "road-a": 0.58,
        "road-b": 0.58,
        "forest": 0.48,
        "stone": 0.40,
        "rock": 0.43,
        "sand": 0.42,
    }.get(spec.profile, 0.62)
    values: list[float] = []
    for channel in range(3):
        color = mix(spec.base_rgb[channel], spec.feature_rgb[channel], feature_mix * 0.78)
        color = mix(color, spec.accent_rgb[channel], accent_mix * accent_weight)
        values.append(color + brightness)
    graded = _cool_desaturate_rgb(spec, values)
    return tuple(round(clamp(value, 0.0, 255.0)) for value in graded)


def _append_periodic_border(raw: bytearray, period: int, channels: int) -> bytes:
    size = period + 1
    output = bytearray(size * size * channels)
    target = 0
    for y in range(size):
        source_y = y % period
        row_start = source_y * period * channels
        for x in range(size):
            source_x = x % period
            source = row_start + source_x * channels
            output[target:target + channels] = raw[source:source + channels]
            target += channels
    return bytes(output)


def synthesize_layer(spec: LayerSpec, size: int) -> dict[str, tuple[bytes, int]]:
    period = size - 1
    primary, accent = build_feature_maps(spec, period)
    noise = PeriodicNoise(spec.seed)
    pixel_count = period * period
    heights = [0.0] * pixel_count
    macros = [0.0] * pixel_count
    micros = [0.0] * pixel_count
    feature_mix_values = [0.0] * pixel_count
    accent_mix_values = [0.0] * pixel_count
    cavities = [0.0] * pixel_count
    roughness_deltas = [0.0] * pixel_count
    albedo_raw = bytearray(pixel_count * 3)
    density_scale = spec.metres_per_repeat / spec.feature_reference_metres
    grit_spec = MICRO_GRIT_BY_PROFILE[spec.profile]

    for y in range(period):
        v = y / period
        for x in range(period):
            u = x / period
            index = y * period + x
            macro = noise.macro(u, v, density_scale, period)
            micro = noise.micro(u, v, density_scale, period)
            grain = noise.grain(u, v, density_scale, period)
            grit_height, grit_albedo, grit_roughness = noise.micro_grit(u, v, spec, period)
            feature_mix, accent_mix, height, cavity, rough_delta = semantic_signals(
                spec, u, v, macro, micro, primary[index], accent[index]
            )
            macros[index] = macro
            micros[index] = micro
            feature_mix_values[index] = feature_mix
            accent_mix_values[index] = accent_mix
            heights[index] = height + grit_height * grit_spec.height_metres
            cavities[index] = cavity
            roughness_deltas[index] = (
                rough_delta
                + (grain - 0.5) * 0.035
                + grit_roughness * grit_spec.roughness_delta
            )
            red, green, blue = _rgb_pixel(
                spec,
                macro,
                micro,
                grain,
                feature_mix,
                accent_mix,
                grit_albedo,
            )
            offset = index * 3
            albedo_raw[offset:offset + 3] = bytes((red, green, blue))

    normal_raw = bytearray(pixel_count * 3)
    orm_raw = bytearray(pixel_count * 4)
    pixel_spacing = spec.metres_per_repeat / period
    for y in range(period):
        above = ((y - 1) % period) * period
        below = ((y + 1) % period) * period
        row = y * period
        for x in range(period):
            index = row + x
            left = row + ((x - 1) % period)
            right = row + ((x + 1) % period)
            dx = (heights[right] - heights[left]) / (2.0 * pixel_spacing)
            dy = (heights[below + x] - heights[above + x]) / (2.0 * pixel_spacing)
            nx = -dx * spec.normal_strength
            ny = -dy * spec.normal_strength
            nz = 1.0
            inverse_length = 1.0 / math.sqrt(nx * nx + ny * ny + nz * nz)
            nx *= inverse_length
            ny *= inverse_length
            nz *= inverse_length
            normal_offset = index * 3
            normal_raw[normal_offset:normal_offset + 3] = bytes((
                round((nx * 0.5 + 0.5) * 255.0),
                round((ny * 0.5 + 0.5) * 255.0),
                round((nz * 0.5 + 0.5) * 255.0),
            ))

            neighbour_average = (
                heights[left] + heights[right] + heights[above + x] + heights[below + x]
            ) * 0.25
            concavity = max(0.0, neighbour_average - heights[index]) / max(spec.height_metres, 0.001)
            ao = clamp(
                0.955
                - concavity * 1.65
                - cavities[index] * 0.26
                + (macros[index] - 0.5) * 0.035,
                0.38,
                1.0,
            )
            roughness = clamp(
                spec.roughness
                + roughness_deltas[index]
                + (feature_mix_values[index] - 0.5) * 0.025
                - accent_mix_values[index] * 0.018,
                0.52,
                0.99,
            )
            orm_offset = index * 4
            orm_raw[orm_offset:orm_offset + 4] = bytes((
                round(ao * 255.0),
                round(roughness * 255.0),
                0,
                255,
            ))

    return {
        "albedo": (_append_periodic_border(albedo_raw, period, 3), 3),
        "normal": (_append_periodic_border(normal_raw, period, 3), 3),
        "orm": (_append_periodic_border(orm_raw, period, 4), 4),
    }


def synthesize_macro_albedo(size: int) -> bytes:
    """Create a neutral, 256 m-scale color-modulation tile.

    The macro map carries only slow drainage/vegetation/dust variation.  It is
    intentionally low chroma so it cannot repaint semantic control boundaries.
    """

    period = size - 1
    noise = PeriodicNoise(MACRO_SEED)
    raw = bytearray(period * period * 3)
    for y in range(period):
        v = y / period
        for x in range(period):
            u = x / period
            broad = noise.sample(u, v, 2, 700) * 0.56 + noise.sample(u, v, 4, 701) * 0.31 + noise.sample(u, v, 8, 702) * 0.13
            drainage = (
                noise.sample(u, v, 5, 703) * 0.62
                + noise.sample(u, v, 9, 704) * 0.38
            )
            dry = smoothstep(0.56, 0.78, broad * 0.74 + drainage * 0.26)
            damp = smoothstep(0.52, 0.78, (1.0 - broad) * 0.80 + (1.0 - drainage) * 0.20)
            neutral = (123.0, 122.0, 113.0)
            dry_color = (139.0, 131.0, 108.0)
            damp_color = (101.0, 111.0, 91.0)
            offset = (y * period + x) * 3
            for channel in range(3):
                color = mix(neutral[channel], dry_color[channel], dry * 0.58)
                color = mix(color, damp_color[channel], damp * 0.48)
                color += (broad - 0.5) * 20.0
                raw[offset + channel] = round(clamp(color, 0.0, 255.0))
    return _append_periodic_border(raw, period, 3)


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    body = kind + payload
    return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def encode_png(width: int, height: int, pixels: bytes, channels: int) -> bytes:
    if channels not in (3, 4):
        raise FactoryError("PNG encoder supports only RGB and RGBA")
    expected = width * height * channels
    if len(pixels) != expected:
        raise FactoryError(f"PNG pixel payload is {len(pixels)} bytes; expected {expected}")
    color_type = 2 if channels == 3 else 6
    scanlines = bytearray()
    stride = width * channels
    for y in range(height):
        scanlines.append(0)
        start = y * stride
        scanlines.extend(pixels[start:start + stride])
    header = struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0)
    return b"".join((
        PNG_SIGNATURE,
        _png_chunk(b"IHDR", header),
        _png_chunk(b"IDAT", zlib.compress(bytes(scanlines), level=9)),
        _png_chunk(b"IEND", b""),
    ))


def validate_size(size: int) -> int:
    if isinstance(size, bool) or not isinstance(size, int):
        raise FactoryError("--size must be an integer")
    if size < MIN_SIZE or size > MAX_SIZE:
        raise FactoryError(f"--size must be from {MIN_SIZE} through {MAX_SIZE}")
    if size & (size - 1):
        raise FactoryError("--size must be a power of two")
    return size


def validate_output_path(raw_output: str | os.PathLike[str]) -> Path:
    raw_text = os.fspath(raw_output)
    if not raw_text or "\x00" in raw_text:
        raise FactoryError("--output must be a non-empty filesystem path")
    raw_path = Path(raw_text).expanduser()
    if any(part == ".." for part in raw_path.parts):
        raise FactoryError("--output must not contain parent traversal")
    absolute = Path(os.path.abspath(raw_path))
    if absolute == Path(absolute.anchor):
        raise FactoryError("--output must not be a filesystem root")
    if absolute.name in {"", ".", ".."}:
        raise FactoryError("--output must name a dedicated artifact directory")

    current = Path(absolute.anchor)
    for part in absolute.parts[1:]:
        current = current / part
        try:
            mode = current.lstat().st_mode
        except FileNotFoundError:
            break
        if stat.S_ISLNK(mode):
            raise FactoryError(f"--output must not traverse symlinks: {current}")
    return absolute


def _artifact_name(spec: LayerSpec, role: str) -> str:
    return f"{spec.index:02d}-{spec.semantic}-{role}.png"


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _file_metadata(path: Path, width: int, height: int, channels: int) -> dict[str, object]:
    payload = path.read_bytes()
    return {
        "path": path.name,
        "sha256": _sha256(payload),
        "bytes": len(payload),
        "width": width,
        "height": height,
        "bitDepth": 8,
        "channels": channels,
    }


def _file_digest_metadata(path: Path) -> dict[str, object]:
    payload = path.read_bytes()
    return {"path": path.name, "sha256": _sha256(payload), "bytes": len(payload)}


def ktx2_array_commands() -> dict[str, list[str]]:
    common = [
        "$TOKTX", "--t2", "--threads", "1", "--genmipmap", "--filter", "lanczos4",
        "--layers", "12",
    ]
    inputs = {
        role: [_artifact_name(spec, role) for spec in LAYERS]
        for role in ("albedo", "normal", "orm")
    }
    return {
        "albedo": common + [
            "--assign_oetf", "srgb", "--assign_primaries", "srgb", "--target_type", "RGB",
            "--encode", "etc1s", "--clevel", "2", "--qlevel", "180", "--",
            "customs-terrain-albedo-array.ktx2", *inputs["albedo"],
        ],
        "normal": common + [
            "--assign_oetf", "linear", "--assign_primaries", "none", "--target_type", "RGB",
            "--encode", "uastc", "--uastc_quality", "2", "--uastc_rdo_l", "0.5",
            "--uastc_rdo_m", "--zcmp", "8", "--",
            "customs-terrain-normal-array.ktx2", *inputs["normal"],
        ],
        "orm": common + [
            "--assign_oetf", "linear", "--assign_primaries", "none", "--target_type", "RGBA",
            "--encode", "uastc", "--uastc_quality", "2", "--uastc_rdo_l", "1.0",
            "--uastc_rdo_m", "--zcmp", "8", "--",
            "customs-terrain-orm-array.ktx2", *inputs["orm"],
        ],
    }


def macro_ktx2_command() -> list[str]:
    return [
        "$TOKTX", "--t2", "--threads", "1", "--genmipmap", "--filter", "lanczos4",
        "--2d", "--assign_oetf", "srgb", "--assign_primaries", "srgb",
        "--target_type", "RGB", "--encode", "etc1s", "--clevel", "2", "--qlevel", "180", "--",
        "customs-terrain-macro-albedo.ktx2", "customs-terrain-macro-albedo.png",
    ]


def validate_toktx_path(raw_path: str | os.PathLike[str]) -> Path:
    raw_text = os.fspath(raw_path)
    if not raw_text or "\x00" in raw_text:
        raise FactoryError("--toktx must be a non-empty executable path")
    path = Path(raw_text).expanduser()
    if any(part == ".." for part in path.parts):
        raise FactoryError("--toktx must not contain parent traversal")
    absolute = Path(os.path.abspath(path))
    try:
        mode = absolute.lstat().st_mode
    except FileNotFoundError as error:
        raise FactoryError(f"--toktx does not exist: {absolute}") from error
    if stat.S_ISLNK(mode) or not stat.S_ISREG(mode) or not os.access(absolute, os.X_OK):
        raise FactoryError("--toktx must be a non-symlink executable regular file")
    return absolute


def _parse_ktx2_header(
    payload: bytes,
    role: str,
    size: int,
    *,
    expected_layers: int = len(LAYERS),
) -> dict[str, int]:
    if len(payload) < 48 or not payload.startswith(KTX2_SIGNATURE):
        raise FactoryError(f"toktx emitted an invalid KTX2 {role} array")
    (
        _vk_format,
        _type_size,
        width,
        height,
        depth,
        layers,
        faces,
        levels,
        _supercompression,
    ) = struct.unpack_from("<9I", payload, 12)
    expected_levels = int(math.log2(size)) + 1
    if (width, height, depth, layers, faces, levels) != (size, size, 0, expected_layers, 1, expected_levels):
        raise FactoryError(
            f"toktx emitted unexpected {role} KTX2 shape "
            f"{width}x{height}, depth={depth}, layers={layers}, faces={faces}, levels={levels}"
        )
    return {
        "width": width,
        "height": height,
        "layers": layers,
        "mipLevels": levels,
    }


def run_toktx(toktx: Path, staging: Path, size: int) -> tuple[str, list[dict[str, object]]]:
    environment = dict(os.environ)
    environment.pop("TOKTX_OPTIONS", None)
    environment.update({"LC_ALL": "C", "LANG": "C", "TZ": "UTC", "SOURCE_DATE_EPOCH": "0"})
    try:
        version_result = subprocess.run(
            [str(toktx), "--version"],
            cwd=staging,
            env=environment,
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise FactoryError(f"could not execute toktx: {error}") from error
    version = (version_result.stdout or version_result.stderr).strip()
    arrays: list[dict[str, object]] = []
    for role, template in ktx2_array_commands().items():
        command = [str(toktx), *template[1:]]
        try:
            subprocess.run(
                command,
                cwd=staging,
                env=environment,
                check=True,
                capture_output=True,
                text=True,
                timeout=900,
            )
        except subprocess.TimeoutExpired as error:
            raise FactoryError(f"toktx timed out while encoding {role}") from error
        except subprocess.CalledProcessError as error:
            diagnostic = (error.stderr or error.stdout or "toktx failed").strip().splitlines()
            safe_line = diagnostic[-1][:500] if diagnostic else "toktx failed"
            raise FactoryError(f"toktx failed for {role}: {safe_line}") from error
        output_name = f"customs-terrain-{role}-array.ktx2"
        output_path = staging / output_name
        payload = output_path.read_bytes()
        shape = _parse_ktx2_header(payload, role, size)
        arrays.append({
            "role": role,
            "path": output_name,
            "sha256": _sha256(payload),
            "bytes": len(payload),
            **shape,
        })
    macro_template = macro_ktx2_command()
    try:
        subprocess.run(
            [str(toktx), *macro_template[1:]],
            cwd=staging,
            env=environment,
            check=True,
            capture_output=True,
            text=True,
            timeout=900,
        )
    except subprocess.TimeoutExpired as error:
        raise FactoryError("toktx timed out while encoding macro-albedo") from error
    except subprocess.CalledProcessError as error:
        diagnostic = (error.stderr or error.stdout or "toktx failed").strip().splitlines()
        safe_line = diagnostic[-1][:500] if diagnostic else "toktx failed"
        raise FactoryError(f"toktx failed for macro-albedo: {safe_line}") from error
    macro_path = staging / "customs-terrain-macro-albedo.ktx2"
    macro_payload = macro_path.read_bytes()
    macro_shape = _parse_ktx2_header(macro_payload, "macro-albedo", size, expected_layers=0)
    arrays.append({
        "role": "macro-albedo",
        "path": macro_path.name,
        "sha256": _sha256(macro_payload),
        "bytes": len(macro_payload),
        "width": macro_shape["width"],
        "height": macro_shape["height"],
        "mipLevels": macro_shape["mipLevels"],
    })
    return version, arrays


def _json_payload(value: object) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=True) + "\n").encode("utf-8")


def authored_license_record() -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "artifactSet": "customs-terrain-pbr-12-layer-v2.1",
        "classification": "original-authored",
        "license": {
            "spdx": LICENSE_SPDX,
            "name": "Creative Commons CC0 1.0 Universal",
            "appliesTo": "generated texture pixels and KTX2 derivatives",
        },
        "thirdPartyAssets": [],
        "gameAssetPayloads": [],
    }


def authored_provenance_record(license_metadata: dict[str, object]) -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "artifactSet": "customs-terrain-pbr-12-layer-v2.1",
        "classification": "original-authored",
        "generator": {"name": GENERATOR_NAME, "version": GENERATOR_VERSION},
        "method": "Code-owned ash-olive palettes, metre-scaled periodic noise and semantic stamps, isotropic 3-12 cm micro-grit, and height-derived normals; no runtime height displacement.",
        "semanticOrder": [spec.semantic for spec in LAYERS],
        "sourceInputs": [],
        "gameFilesRead": False,
        "networkAccess": False,
        "thirdPartyPixels": False,
        "licenseReceipt": {
            "path": license_metadata["path"],
            "sha256": license_metadata["sha256"],
            "bytes": license_metadata["bytes"],
        },
    }


def _contract_receipts(
    provenance_metadata: dict[str, object],
    license_metadata: dict[str, object],
) -> dict[str, object]:
    return {
        "provenance": {
            "url": f"{AUTHORED_ASSET_ROOT}{provenance_metadata['path']}",
            "sha256": provenance_metadata["sha256"],
        },
        "originalLicense": {
            "url": f"{AUTHORED_ASSET_ROOT}{license_metadata['path']}",
            "sha256": license_metadata["sha256"],
        },
    }


def material_set_template(
    size: int,
    ktx_artifacts: Sequence[dict[str, object]],
    provenance_metadata: dict[str, object],
    license_metadata: dict[str, object],
) -> dict[str, object]:
    by_role = {artifact["role"]: artifact for artifact in ktx_artifacts}
    placeholder = "0" * 64
    mip_levels = int(math.log2(size)) + 1

    def receipts() -> dict[str, object]:
        # Build fresh objects because the JS validator deeply freezes its input.
        return _contract_receipts(provenance_metadata, license_metadata)

    arrays: list[dict[str, object]] = []
    for role in ("albedo", "normal", "orm"):
        artifact = by_role.get(role)
        descriptor: dict[str, object] = {
            "kind": "ktx2-array",
            "role": role,
            "url": f"{AUTHORED_ASSET_ROOT}customs-terrain-{role}-array.ktx2",
            "width": size,
            "height": size,
            "slices": len(LAYERS),
            "mipLevels": mip_levels,
            "colorSpace": "srgb" if role == "albedo" else "linear",
            "sha256": artifact["sha256"] if artifact else placeholder,
            "receipts": receipts(),
        }
        if role == "normal":
            descriptor["normalSpace"] = "tangent"
        if role == "orm":
            descriptor["channels"] = ["occlusion", "roughness", "metallic", "unused"]
        arrays.append(descriptor)

    macro_artifact = by_role.get("macro-albedo")
    return {
        "schemaVersion": 1,
        "map": "customs",
        "delivery": "original-authored",
        "layers": [
            {
                "index": spec.index,
                "semantic": spec.semantic,
                "terrainLayerName": TERRAIN_LAYER_NAMES[spec.index],
                "arrayIndex": spec.index,
                "metresPerRepeat": spec.metres_per_repeat,
                "normalStrength": spec.normal_strength,
                "ormStrength": 1.0,
            }
            for spec in LAYERS
        ],
        "arrays": arrays,
        "macro": {
            "kind": "ktx2-2d",
            "role": "macro-albedo",
            "url": f"{AUTHORED_ASSET_ROOT}customs-terrain-macro-albedo.ktx2",
            "width": size,
            "height": size,
            "mipLevels": mip_levels,
            "colorSpace": "srgb",
            "metresPerRepeat": MACRO_METRES_PER_REPEAT,
            "strength": MACRO_STRENGTH,
            "sha256": macro_artifact["sha256"] if macro_artifact else placeholder,
            "receipts": receipts(),
        },
    }


def _receipt(
    size: int,
    layer_records: Sequence[dict[str, object]],
    macro_metadata: dict[str, object],
    provenance_metadata: dict[str, object],
    license_metadata: dict[str, object],
    material_template_metadata: dict[str, object],
    toktx_path: Path | None,
    toktx_version: str | None,
    ktx_artifacts: Sequence[dict[str, object]],
) -> dict[str, object]:
    array_commands = ktx2_array_commands()
    return {
        "schemaVersion": SCHEMA_VERSION,
        "artifactSet": "customs-terrain-pbr-12-layer-v2.1",
        "generator": {
            "name": GENERATOR_NAME,
            "version": GENERATOR_VERSION,
            "runtime": "Python 3 standard library only",
            "determinism": "explicit seeds; periodic integer lattices; fixed PNG filter/compression; no timestamps",
        },
        "provenance": {
            "classification": "original-authored",
            "method": "Procedurally synthesized from code-owned palettes, periodic noise, semantic shape rules, and physically scaled isotropic micro-grit.",
            "sourceInputs": [],
            "gameFilesRead": False,
            "networkAccess": False,
            "thirdPartyPixels": False,
            "license": {
                "spdx": LICENSE_SPDX,
                "name": "Creative Commons CC0 1.0 Universal",
                "appliesTo": "generated texture pixels and KTX2 derivatives",
            },
        },
        "visualRevision": {
            "id": "v2.1-microdetail-live-qa",
            "repeatScaleMultiplierFromV1": 6.0,
            "goals": [
                "preserve the V2 anti-tiling and exact sixfold physical repeat",
                "restore tactile 3-12 cm source detail without changing control masks",
                "increase rounded normal energy and roughness breakup without sparkle",
                "cool living and earth palettes toward ash and olive without grey washout",
            ],
        },
        "dimensions": {
            "width": size,
            "height": size,
            "powerOfTwo": True,
            "periodicBorder": "last row and column exactly duplicate first row and column",
        },
        "semanticOrder": [spec.semantic for spec in LAYERS],
        "channelSemantics": {
            "albedo": {"channels": ["red", "green", "blue"], "colorSpace": "sRGB"},
            "normal": {"channels": ["tangent-x", "tangent-y", "tangent-z"], "colorSpace": "linear", "basis": "unit vector packed from [-1,1] to [0,1]"},
            "orm": {"channels": ["ambient-occlusion", "roughness", "metalness", "unused"], "colorSpace": "linear", "metalness": 0, "unused": 255},
        },
        "heightContract": {
            "runtimeDisplacement": False,
            "sourceHeightUse": "normal and ambient-occlusion synthesis only",
            "outputHeightTexture": False,
        },
        "microGritContract": {
            "orientation": "isotropic-periodic-value-noise",
            "targetWavelengthsMetres": list(MICRO_GRIT_WAVELENGTHS_METRES),
            "normalMinimumFootprintPixels": 2,
            "normalNyquistClamped": True,
            "controlOrSplatMaskModified": False,
            "runtimeSamplesAdded": 0,
        },
        "layers": list(layer_records),
        "macro": {
            "role": "macro-albedo",
            "seed": MACRO_SEED,
            "physicalTileScaleMetres": MACRO_METRES_PER_REPEAT,
            "strength": MACRO_STRENGTH,
            "artifact": macro_metadata,
        },
        "authoredReceipts": {
            "provenance": provenance_metadata,
            "originalLicense": license_metadata,
        },
        "materialSet": {
            "template": material_template_metadata,
            "contract": "src/customs-terrain-material-contract.js material-set v1",
            "structurallyCompatible": True,
            "contentHashesFinal": toktx_path is not None,
            "placeholderDigestWhenKtx2IsNotRequested": "0" * 64,
        },
        "ktx2": {
            "requested": toktx_path is not None,
            "tool": {"name": "toktx", "version": toktx_version} if toktx_version else None,
            "arrayOrder": [spec.semantic for spec in LAYERS],
            "commandTemplates": {"arrays": array_commands, "macro": macro_ktx2_command()},
            "arrays": [artifact for artifact in ktx_artifacts if artifact["role"] != "macro-albedo"],
            "macro": next((artifact for artifact in ktx_artifacts if artifact["role"] == "macro-albedo"), None),
        },
    }


def _write_bytes(path: Path, payload: bytes) -> None:
    with path.open("xb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())


def _expected_names(include_ktx2: bool) -> set[str]:
    names = {
        _artifact_name(spec, role)
        for spec in LAYERS
        for role in ("albedo", "normal", "orm")
    }
    names.update({
        "customs-terrain-macro-albedo.png",
        "provenance.json",
        "original-license.json",
        "material-set.template.json",
        "receipt.json",
    })
    if include_ktx2:
        names.update(f"customs-terrain-{role}-array.ktx2" for role in ("albedo", "normal", "orm"))
        names.add("customs-terrain-macro-albedo.ktx2")
    return names


def _validate_force_targets(target: Path, expected_names: Iterable[str]) -> None:
    if target.is_symlink() or not target.is_dir():
        raise FactoryError("--force output must be an existing non-symlink directory")
    for name in expected_names:
        path = target / name
        try:
            mode = path.lstat().st_mode
        except FileNotFoundError:
            continue
        if not stat.S_ISREG(mode):
            raise FactoryError(f"--force refuses to replace non-regular artifact: {path}")


def generate(
    output: str | os.PathLike[str],
    size: int,
    *,
    toktx: str | os.PathLike[str] | None = None,
    force: bool = False,
) -> dict[str, object]:
    size = validate_size(size)
    target = validate_output_path(output)
    toktx_path = validate_toktx_path(toktx) if toktx is not None else None
    expected_names = _expected_names(toktx_path is not None)
    target_exists = target.exists() or target.is_symlink()
    if target_exists and not force:
        raise FactoryError(f"output already exists; pass --force to replace factory-owned artifacts: {target}")
    if target_exists:
        _validate_force_targets(target, expected_names)

    target.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{target.name}.staging-", dir=target.parent))
    try:
        layer_records: list[dict[str, object]] = []
        for spec in LAYERS:
            synthesized = synthesize_layer(spec, size)
            grit_spec = MICRO_GRIT_BY_PROFILE[spec.profile]
            palette_desaturation, palette_cooling = PALETTE_GRADE_BY_PROFILE[spec.profile]
            artifacts: dict[str, dict[str, object]] = {}
            for role in ("albedo", "normal", "orm"):
                pixels, channels = synthesized[role]
                name = _artifact_name(spec, role)
                png = encode_png(size, size, pixels, channels)
                path = staging / name
                _write_bytes(path, png)
                artifacts[role] = _file_metadata(path, size, size, channels)
            layer_records.append({
                "index": spec.index,
                "semantic": spec.semantic,
                "seed": spec.seed,
                "featureProfile": spec.profile,
                "physicalTileScaleMetres": spec.metres_per_repeat,
                "featureReferenceScaleMetres": spec.feature_reference_metres,
                "repeatScaleMultiplierFromV1": round(
                    spec.metres_per_repeat / spec.feature_reference_metres,
                    6,
                ),
                "microGrit": {
                    "targetWavelengthsMetres": list(MICRO_GRIT_WAVELENGTHS_METRES),
                    "albedoAmplitudeSrgbUnits": grit_spec.albedo_units,
                    "heightAmplitudeMetres": grit_spec.height_metres,
                    "roughnessAmplitude": grit_spec.roughness_delta,
                },
                "paletteGrade": {
                    "desaturationFractionFromV2": palette_desaturation,
                    "coolingBlueBiasSrgbUnits": palette_cooling,
                },
                "heightAmplitudeMetres": spec.height_metres,
                "normalStrength": spec.normal_strength,
                "roughnessBase": spec.roughness,
                "artifacts": artifacts,
            })

        macro_path = staging / "customs-terrain-macro-albedo.png"
        macro_pixels = synthesize_macro_albedo(size)
        _write_bytes(macro_path, encode_png(size, size, macro_pixels, 3))
        macro_metadata = _file_metadata(macro_path, size, size, 3)

        license_path = staging / "original-license.json"
        _write_bytes(license_path, _json_payload(authored_license_record()))
        license_metadata = _file_digest_metadata(license_path)
        provenance_path = staging / "provenance.json"
        _write_bytes(provenance_path, _json_payload(authored_provenance_record(license_metadata)))
        provenance_metadata = _file_digest_metadata(provenance_path)

        toktx_version: str | None = None
        ktx_artifacts: list[dict[str, object]] = []
        if toktx_path is not None:
            toktx_version, ktx_artifacts = run_toktx(toktx_path, staging, size)

        template_path = staging / "material-set.template.json"
        template = material_set_template(
            size,
            ktx_artifacts,
            provenance_metadata,
            license_metadata,
        )
        _write_bytes(template_path, _json_payload(template))
        material_template_metadata = _file_digest_metadata(template_path)
        receipt = _receipt(
            size,
            layer_records,
            macro_metadata,
            provenance_metadata,
            license_metadata,
            material_template_metadata,
            toktx_path,
            toktx_version,
            ktx_artifacts,
        )
        receipt_payload = _json_payload(receipt)
        _write_bytes(staging / "receipt.json", receipt_payload)

        if target_exists:
            for name in sorted(expected_names - {"receipt.json"}):
                os.replace(staging / name, target / name)
            os.replace(staging / "receipt.json", target / "receipt.json")
            staging.rmdir()
        else:
            try:
                staging.rename(target)
            except FileExistsError as error:
                raise FactoryError(f"output appeared during generation; refusing to overwrite: {target}") from error
        return receipt
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate deterministic original-authored Customs terrain PBR source slices.",
    )
    parser.add_argument("--output", required=True, help="dedicated artifact directory")
    parser.add_argument("--size", required=True, type=int, help=f"power-of-two texture size ({MIN_SIZE}..{MAX_SIZE})")
    parser.add_argument("--toktx", help="optional absolute or relative path to the toktx executable")
    parser.add_argument("--force", action="store_true", help="replace only factory-owned regular files in an existing output directory")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        receipt = generate(args.output, args.size, toktx=args.toktx, force=args.force)
    except (FactoryError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    png_bytes = sum(
        artifact["bytes"]
        for layer in receipt["layers"]
        for artifact in layer["artifacts"].values()
    )
    array_bytes = sum(array["bytes"] for array in receipt["ktx2"]["arrays"])
    if receipt["ktx2"]["macro"] is not None:
        array_bytes += receipt["ktx2"]["macro"]["bytes"]
    print(
        f"generated {len(LAYERS)} terrain layers at {args.size}x{args.size}: "
        f"{png_bytes} PNG bytes, {array_bytes} KTX2 bytes -> {validate_output_path(args.output)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
