#!/usr/bin/env python3
"""Build a local-only, scalar terrain package from a user-owned EFT install.

The extractor is intentionally narrow.  It discovers the Customs terrain scene
from Unity BuildSettings, opens only that scene's ``levelN`` and
``sharedassetsN.assets`` as one UnityPy environment, and emits:

* canonical absolute-world-Y Float32LE height samples;
* the three terrain control/splat maps as canonical RGBA PNGs; and
* scalar-only terrain tree/plant prototype and instance facts.

It never starts a game executable, calls a Unity save/export API, writes beneath
``--source``, or emits original meshes, diffuse maps, normal maps, materials, or
other reusable game payloads.
"""

from __future__ import annotations

import argparse
import binascii
import hashlib
import io
import json
import math
import os
import shutil
import struct
import sys
import tempfile
import zlib
from collections.abc import Mapping, Sequence
from pathlib import Path, PurePosixPath
from typing import Any, Dict, Iterable, List, Optional, TextIO, Tuple


SCHEMA_VERSION = 1
MAP_ID = "customs"
SOURCE_FRAME = "eft-unity-world-metres-y-up"
CATALOG_NAMES = {"globalgamemanagers", "globalgamemanagers.assets"}
CONTROL_MAP_COUNT = 3
CONTROL_CHANNELS = ("r", "g", "b", "a")
TRANSFORM_TOLERANCE = 1e-5


class TerrainExportError(RuntimeError):
    """A concise, fail-closed terrain export error."""


def _value(container: Any, *names: str) -> Any:
    if container is None:
        return None
    for name in names:
        if isinstance(container, Mapping) and name in container:
            return container[name]
        if hasattr(container, name):
            return getattr(container, name)
    return None


def _text(value: Any, *, fallback: str = "", limit: int = 256) -> str:
    if value is None:
        return fallback
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    if not isinstance(value, str):
        value = str(value)
    value = "".join(character if character >= " " else " " for character in value)
    value = " ".join(value.split()).strip()
    return value[:limit] or fallback


def _number(value: Any, label: str) -> float:
    if isinstance(value, bool) or value is None:
        raise TerrainExportError(f"missing numeric {label}")
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError) as error:
        raise TerrainExportError(f"invalid numeric {label}") from error
    if not math.isfinite(result):
        raise TerrainExportError(f"non-finite numeric {label}")
    return result


def _optional_number(value: Any) -> Optional[float]:
    if isinstance(value, bool) or value is None:
        return None
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return result if math.isfinite(result) else None


def _integer(value: Any, label: str) -> int:
    if isinstance(value, bool) or value is None:
        raise TerrainExportError(f"missing integer {label}")
    try:
        result = int(value)
    except (TypeError, ValueError, OverflowError) as error:
        raise TerrainExportError(f"invalid integer {label}") from error
    return result


def _sequence(value: Any) -> List[Any]:
    if value is None:
        return []
    if isinstance(value, Mapping):
        nested = _value(value, "Array", "array", "data", "items")
        return _sequence(nested) if nested is not None else []
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return list(value)
    to_list = getattr(value, "tolist", None)
    if callable(to_list):
        return _sequence(to_list())
    return []


def _flatten_scalars(value: Any) -> Iterable[Any]:
    if isinstance(value, Mapping):
        nested = _value(value, "Array", "array", "data", "items")
        if nested is not None:
            yield from _flatten_scalars(nested)
        return
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        for item in value:
            yield from _flatten_scalars(item)
        return
    to_list = getattr(value, "tolist", None)
    if callable(to_list):
        yield from _flatten_scalars(to_list())
        return
    yield value


def _vector3(value: Any, label: str) -> Tuple[float, float, float]:
    return (
        _number(_value(value, "x"), f"{label}.x"),
        _number(_value(value, "y"), f"{label}.y"),
        _number(_value(value, "z"), f"{label}.z"),
    )


def _quaternion(value: Any, label: str) -> Tuple[float, float, float, float]:
    quaternion = (
        _number(_value(value, "x"), f"{label}.x"),
        _number(_value(value, "y"), f"{label}.y"),
        _number(_value(value, "z"), f"{label}.z"),
        _number(_value(value, "w"), f"{label}.w"),
    )
    magnitude = math.sqrt(sum(component * component for component in quaternion))
    if magnitude <= 1e-12:
        raise TerrainExportError(f"zero-length {label}")
    return tuple(component / magnitude for component in quaternion)  # type: ignore[return-value]


def _vector_fact(value: Tuple[float, float, float]) -> Dict[str, float]:
    return {"x": value[0], "y": value[1], "z": value[2]}


def _normalized_scene_path(value: Any) -> Optional[str]:
    if isinstance(value, Mapping) or not isinstance(value, (str, bytes)):
        value = _value(value, "path", "m_Path", "scene", "m_Scene")
    path = _text(value, limit=1024)
    if not path:
        return None
    path = path.replace("\\", "/")
    while "//" in path:
        path = path.replace("//", "/")
    while path.startswith("./"):
        path = path[2:]
    return path


def _path_is_inside(candidate: Path, root: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        pass
    candidate_text = str(candidate)
    root_text = str(root)
    if candidate_text.casefold().startswith("/mnt/") and root_text.casefold().startswith("/mnt/"):
        try:
            common = os.path.commonpath([candidate_text.casefold(), root_text.casefold()])
        except ValueError:
            return False
        return common == root_text.casefold()
    return False


def _validate_paths(source_value: str, output_value: str) -> Tuple[Path, Path]:
    source_candidate = Path(source_value).expanduser()
    try:
        source_root = source_candidate.resolve(strict=True)
    except OSError as error:
        raise TerrainExportError("game-data source does not exist") from error
    if not source_root.is_dir():
        raise TerrainExportError("game-data source must be a directory")

    output_candidate = Path(output_value).expanduser()
    if not output_candidate.is_absolute():
        output_candidate = Path.cwd() / output_candidate
    if output_candidate.is_symlink():
        raise TerrainExportError("output directory must not be a symbolic link")
    output_dir = output_candidate.resolve(strict=False)
    if _path_is_inside(output_dir, source_root):
        raise TerrainExportError("output directory must be outside the game-data source")
    if output_dir.exists():
        raise TerrainExportError("output directory already exists; choose a new local directory")
    try:
        output_parent = output_dir.parent.resolve(strict=True)
    except OSError as error:
        raise TerrainExportError("output parent directory must already exist") from error
    if not output_parent.is_dir():
        raise TerrainExportError("output parent must be a directory")
    if _path_is_inside(output_parent, source_root):
        raise TerrainExportError("output parent must be outside the game-data source")
    return source_root, output_dir


def discover_catalog(source_root: Path) -> Path:
    # A normal Unity player Data root can contain both files. BuildSettings lives
    # in the extensionless player catalog, while globalgamemanagers.assets is a
    # separate serialized asset file. Prefer the exact root-level catalog before
    # considering the recursive fallback used for a narrowly scoped parent root.
    for preferred_name in ("globalgamemanagers", "globalgamemanagers.assets"):
        direct = source_root / preferred_name
        if direct.is_symlink() or not direct.is_file():
            continue
        resolved = direct.resolve(strict=True)
        if _path_is_inside(resolved, source_root):
            return resolved

    matches: List[Path] = []
    for current_root, directory_names, file_names in os.walk(source_root, followlinks=False):
        current = Path(current_root)
        directory_names[:] = sorted(
            name for name in directory_names if not (current / name).is_symlink()
        )
        for name in sorted(file_names):
            if name.casefold() not in CATALOG_NAMES:
                continue
            path = current / name
            if path.is_symlink() or not path.is_file():
                continue
            resolved = path.resolve(strict=True)
            if _path_is_inside(resolved, source_root):
                matches.append(resolved)
    if not matches:
        raise TerrainExportError("no globalgamemanagers BuildSettings catalog was found")
    if len(matches) != 1:
        raise TerrainExportError(
            "expected exactly one globalgamemanagers catalog; narrow --source to one Unity Data root"
        )
    return matches[0]


def _reader_type_name(reader: Any) -> str:
    type_value = _value(reader, "type")
    return _text(_value(type_value, "name") or type_value, fallback="Unknown", limit=80)


def _read_reader(reader: Any, *, dictionary: bool = False) -> Any:
    if dictionary:
        parser = getattr(reader, "parse_as_dict", None)
        if callable(parser):
            return parser()
    reader_method = getattr(reader, "read", None)
    if callable(reader_method):
        return reader_method()
    parser = getattr(reader, "parse_as_dict", None)
    if callable(parser):
        return parser()
    raise TerrainExportError("UnityPy object reader has no supported read method")


def _load_environment(unitypy_module: Any, *paths: Path) -> Any:
    try:
        return unitypy_module.load(*(str(path) for path in paths))
    except Exception as error:
        raise TerrainExportError(
            f"UnityPy could not load the targeted serialized file set ({type(error).__name__})"
        ) from error


def discover_customs_terrain_scene(
    catalog_file: Path, unitypy_module: Any
) -> Tuple[int, str]:
    environment = _load_environment(unitypy_module, catalog_file)
    scene_paths: List[str] = []
    build_settings_count = 0
    for reader in getattr(environment, "objects", ()):  # Never parse unrelated catalog objects.
        if _reader_type_name(reader) != "BuildSettings":
            continue
        build_settings_count += 1
        data = _read_reader(reader, dictionary=True)
        scenes = _value(data, "scenes", "m_Scenes", "m_scenes")
        for entry in _sequence(scenes):
            path = _normalized_scene_path(entry)
            scene_paths.append(path or "")
    if build_settings_count == 0:
        raise TerrainExportError("globalgamemanagers did not yield BuildSettings")

    matches: List[Tuple[int, str]] = []
    for index, path in enumerate(scene_paths):
        if not path:
            continue
        folded = "/" + path.strip("/").casefold()
        stem = PurePosixPath(path).stem.casefold()
        if "/locations/custom/" in folded and stem == "custom_terrain":
            matches.append((index, path))
    if not matches:
        raise TerrainExportError(
            "BuildSettings contains no exact /Locations/Custom/.../custom_Terrain scene"
        )
    if len(matches) != 1:
        raise TerrainExportError("BuildSettings contains multiple Customs terrain scene candidates")
    return matches[0]


def resolve_scene_files(
    source_root: Path, catalog_file: Path, scene_index: int
) -> Tuple[Path, Path]:
    expected = (
        catalog_file.parent / f"level{scene_index}",
        catalog_file.parent / f"sharedassets{scene_index}.assets",
    )
    resolved: List[Path] = []
    for path in expected:
        if path.is_symlink():
            raise TerrainExportError(f"targeted scene file must not be a symlink: {path.name}")
        try:
            candidate = path.resolve(strict=True)
        except OSError as error:
            raise TerrainExportError(f"missing targeted terrain scene file: {path.name}") from error
        if not candidate.is_file() or not _path_is_inside(candidate, source_root):
            raise TerrainExportError(f"invalid targeted terrain scene file: {path.name}")
        resolved.append(candidate)
    return resolved[0], resolved[1]


def _pointer_path_id(pointer: Any) -> Optional[int]:
    value = _value(pointer, "path_id", "m_PathID", "pathId")
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return None


def _pointer_is_null(pointer: Any) -> bool:
    if pointer is None:
        return True
    path_id = _pointer_path_id(pointer)
    return path_id == 0 if path_id is not None else False


def _deref(pointer: Any, label: str) -> Any:
    if _pointer_is_null(pointer):
        return None
    read = getattr(pointer, "read", None)
    if callable(read):
        try:
            return read()
        except Exception as error:
            raise TerrainExportError(
                f"could not resolve {label} pointer ({type(error).__name__})"
            ) from error
    return pointer


def _identity_matrix() -> Tuple[Tuple[float, ...], ...]:
    return (
        (1.0, 0.0, 0.0, 0.0),
        (0.0, 1.0, 0.0, 0.0),
        (0.0, 0.0, 1.0, 0.0),
        (0.0, 0.0, 0.0, 1.0),
    )


def _matrix_multiply(
    left: Tuple[Tuple[float, ...], ...], right: Tuple[Tuple[float, ...], ...]
) -> Tuple[Tuple[float, ...], ...]:
    return tuple(
        tuple(sum(left[row][inner] * right[inner][column] for inner in range(4)) for column in range(4))
        for row in range(4)
    )


def _local_trs_matrix(transform: Any) -> Tuple[Tuple[float, ...], ...]:
    position = _vector3(_value(transform, "m_LocalPosition", "localPosition"), "localPosition")
    rotation = _quaternion(
        _value(transform, "m_LocalRotation", "localRotation"), "localRotation"
    )
    scale = _vector3(_value(transform, "m_LocalScale", "localScale"), "localScale")
    x, y, z, w = rotation
    xx, yy, zz = x * x, y * y, z * z
    xy, xz, yz = x * y, x * z, y * z
    wx, wy, wz = w * x, w * y, w * z
    rotation_matrix = (
        (1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy)),
        (2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx)),
        (2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)),
    )
    return (
        (
            rotation_matrix[0][0] * scale[0],
            rotation_matrix[0][1] * scale[1],
            rotation_matrix[0][2] * scale[2],
            position[0],
        ),
        (
            rotation_matrix[1][0] * scale[0],
            rotation_matrix[1][1] * scale[1],
            rotation_matrix[1][2] * scale[2],
            position[1],
        ),
        (
            rotation_matrix[2][0] * scale[0],
            rotation_matrix[2][1] * scale[1],
            rotation_matrix[2][2] * scale[2],
            position[2],
        ),
        (0.0, 0.0, 0.0, 1.0),
    )


def _world_matrix(transform: Any, active: Optional[set] = None) -> Tuple[Tuple[float, ...], ...]:
    active = set() if active is None else active
    identity = _pointer_path_id(transform)
    key = ("path", identity) if identity is not None else ("object", id(transform))
    if key in active:
        raise TerrainExportError("cycle detected in Terrain transform hierarchy")
    parent_pointer = _value(transform, "m_Father", "father", "parent")
    local = _local_trs_matrix(transform)
    if _pointer_is_null(parent_pointer):
        return local
    parent = _deref(parent_pointer, "parent Transform")
    if parent is None:
        return local
    return _matrix_multiply(_world_matrix(parent, active | {key}), local)


def _apply_matrix(
    matrix: Tuple[Tuple[float, ...], ...], point: Tuple[float, float, float]
) -> Tuple[float, float, float]:
    x, y, z = point
    return (
        matrix[0][0] * x + matrix[0][1] * y + matrix[0][2] * z + matrix[0][3],
        matrix[1][0] * x + matrix[1][1] * y + matrix[1][2] * z + matrix[1][3],
        matrix[2][0] * x + matrix[2][1] * y + matrix[2][2] * z + matrix[2][3],
    )


def _require_axis_aligned_unit_world_transform(
    matrix: Tuple[Tuple[float, ...], ...]
) -> None:
    for row in range(3):
        for column in range(3):
            expected = 1.0 if row == column else 0.0
            if abs(matrix[row][column] - expected) > TRANSFORM_TOLERANCE:
                raise TerrainExportError(
                    "Terrain world transform has rotation, shear, or non-unit scale; "
                    "refusing to violate the canonical world-Y decoding contract"
                )


def _component_pointer(value: Any) -> Any:
    nested = _value(value, "component", "m_Component")
    if nested is not None:
        return nested
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return value[-1] if value else None
    return value


def _looks_like_transform(value: Any) -> bool:
    return all(
        _value(value, field) is not None
        for field in ("m_LocalPosition", "m_LocalRotation", "m_LocalScale")
    )


def _terrain_transform(terrain: Any) -> Any:
    game_object = _deref(_value(terrain, "m_GameObject", "gameObject"), "Terrain GameObject")
    if game_object is None:
        raise TerrainExportError("Terrain has no GameObject")
    for component in _sequence(_value(game_object, "m_Component", "components")):
        pointer = _component_pointer(component)
        type_name = _text(_value(_value(pointer, "type"), "name"), limit=80)
        if type_name and type_name not in {"Transform", "RectTransform"}:
            continue
        candidate = _deref(pointer, "GameObject component")
        if _looks_like_transform(candidate):
            return candidate
    raise TerrainExportError("Terrain GameObject has no resolvable Transform")


def _heightmap_details(terrain_data: Any) -> Tuple[int, int, Tuple[float, float, float], Any]:
    heightmap = _value(terrain_data, "m_Heightmap", "heightmap")
    if heightmap is None:
        raise TerrainExportError("TerrainData has no heightmap")
    resolution = _value(heightmap, "m_Resolution", "resolution")
    columns_value = _value(heightmap, "m_Width", "width") or resolution
    rows_value = _value(heightmap, "m_Height", "height") or resolution
    columns = _integer(columns_value, "heightmap columns")
    rows = _integer(rows_value, "heightmap rows")
    if columns < 2 or rows < 2:
        raise TerrainExportError("heightmap resolution must be at least 2x2")
    scale = _vector3(_value(heightmap, "m_Scale", "scale"), "heightmap scale")
    if scale[0] <= 0 or scale[1] <= 0 or scale[2] <= 0:
        raise TerrainExportError("heightmap scale components must be positive")
    heights = _value(heightmap, "m_Heights", "heights")
    if heights is None:
        heights = _value(terrain_data, "m_Heights", "heights")
    if heights is None:
        raise TerrainExportError("TerrainData heightmap has no SInt16 samples")
    return columns, rows, scale, heights


def decode_sint16_heights(value: Any, expected_count: int) -> List[int]:
    """Decode Unity's signed little-endian SInt16 height array without reordering."""
    if isinstance(value, memoryview):
        value = value.tobytes()
    if isinstance(value, (bytes, bytearray)):
        payload = bytes(value)
        if len(payload) != expected_count * 2:
            raise TerrainExportError("SInt16 height byte count does not match resolution")
        values = list(struct.unpack(f"<{expected_count}h", payload))
    else:
        values = []
        for item in _flatten_scalars(value):
            if isinstance(item, bool):
                raise TerrainExportError("height sample is not SInt16")
            try:
                number = int(item)
            except (TypeError, ValueError, OverflowError) as error:
                raise TerrainExportError("height sample is not SInt16") from error
            if isinstance(item, float) and not item.is_integer():
                raise TerrainExportError("height sample is not integral SInt16")
            values.append(number)
        if len(values) != expected_count:
            raise TerrainExportError("SInt16 height sample count does not match resolution")
        if any(number < -32768 or number > 32767 for number in values):
            raise TerrainExportError("height sample falls outside signed SInt16 range")
    return values


def _world_height_bytes(
    raw_heights: Sequence[int], terrain_origin_y: float, height_scale_y: float
) -> Tuple[bytes, float, float]:
    values = [
        terrain_origin_y + (raw / 32767.0) * height_scale_y
        for raw in raw_heights
    ]
    payload = b"".join(struct.pack("<f", value) for value in values)
    return payload, min(values), max(values)


def _control_pointers(terrain_data: Any) -> List[Any]:
    database = _value(terrain_data, "m_SplatDatabase", "splatDatabase")
    for container in (database, terrain_data):
        pointers = _value(
            container,
            "m_AlphaTextures",
            "alphaTextures",
            "m_AlphamapTextures",
            "alphamapTextures",
        )
        if pointers is not None:
            result = _sequence(pointers)
            if len(result) != CONTROL_MAP_COUNT:
                raise TerrainExportError(
                    f"expected exactly {CONTROL_MAP_COUNT} RGBA terrain control maps; found {len(result)}"
                )
            return result
    raise TerrainExportError("TerrainData has no alphamap/control textures")


def _rgba_image_bytes(texture: Any) -> Tuple[int, int, bytes]:
    get_image = getattr(texture, "get_image", None)
    canonical_rows = False
    if callable(get_image):
        try:
            image = get_image(flip=False)
        except TypeError:
            image = get_image(False)
        canonical_rows = True
    else:
        image = _value(texture, "image")
    if image is None:
        raise TerrainExportError("control Texture2D could not be decoded as an image")
    convert = getattr(image, "convert", None)
    if callable(convert):
        image = convert("RGBA")
    width = _integer(_value(image, "width") or _value(image, "size")[0], "control width")
    height = _integer(_value(image, "height") or _value(image, "size")[1], "control height")
    to_bytes = getattr(image, "tobytes", None)
    if not callable(to_bytes):
        raise TerrainExportError("decoded control image has no byte representation")
    rgba = bytes(to_bytes())
    expected = width * height * 4
    if len(rgba) != expected:
        raise TerrainExportError("decoded control image is not RGBA8")
    # UnityPy's Texture2D.image convenience property uses display-oriented
    # (top-left) rows. Undo that flip so PNG scanline 0 is terrain z-min.  Its
    # explicit get_image(flip=False) path is already in canonical order.
    if not canonical_rows:
        stride = width * 4
        rgba = b"".join(
            rgba[row * stride : (row + 1) * stride]
            for row in range(height - 1, -1, -1)
        )
    return width, height, rgba


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    checksum = binascii.crc32(kind)
    checksum = binascii.crc32(payload, checksum) & 0xFFFFFFFF
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", checksum)


def encode_rgba_png(width: int, height: int, rgba: bytes) -> bytes:
    if width <= 0 or height <= 0 or len(rgba) != width * height * 4:
        raise TerrainExportError("invalid RGBA image dimensions")
    stride = width * 4
    scanlines = b"".join(
        b"\x00" + rgba[row * stride : (row + 1) * stride]
        for row in range(height)
    )
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + _png_chunk(b"IDAT", zlib.compress(scanlines, level=9))
        + _png_chunk(b"IEND", b"")
    )


def _layer_entries(terrain_data: Any) -> List[Dict[str, Any]]:
    database = _value(terrain_data, "m_SplatDatabase", "splatDatabase")
    candidates = None
    for container in (database, terrain_data):
        candidates = _value(
            container,
            "m_TerrainLayers",
            "terrainLayers",
            "m_SplatPrototypes",
            "splatPrototypes",
        )
        if candidates is not None:
            break
    layers = _sequence(candidates)
    if len(layers) > CONTROL_MAP_COUNT * 4:
        raise TerrainExportError("terrain layer count exceeds the three RGBA control maps")
    result: List[Dict[str, Any]] = []
    for index, candidate in enumerate(layers):
        layer = _deref(candidate, "TerrainLayer")
        name = _text(_value(layer, "m_Name", "name"), fallback="")
        if not name:
            # Older SplatPrototype records have no name. Reading only the source
            # texture's m_Name is allowed metadata; its image/payload is never read.
            texture_pointer = _value(layer, "texture", "m_Texture")
            if texture_pointer is not None:
                texture = _deref(texture_pointer, "SplatPrototype texture metadata")
                name = _text(_value(texture, "m_Name", "name"), fallback="")
        result.append(
            {
                "index": index,
                "name": name or f"layer-{index:02d}",
                "controlIndex": index // 4,
                "channel": CONTROL_CHANNELS[index % 4],
            }
        )
    return result


def _terrain_size(
    terrain_data: Any,
    columns: int,
    rows: int,
    height_scale: Tuple[float, float, float],
) -> Tuple[float, float, float]:
    value = _value(terrain_data, "m_Size", "size")
    if value is not None:
        return _vector3(value, "terrain size")
    return (
        height_scale[0] * (columns - 1),
        height_scale[1],
        height_scale[2] * (rows - 1),
    )


def _optional_color(value: Any) -> Optional[Dict[str, float]]:
    if value is None:
        return None
    result: Dict[str, float] = {}
    for canonical, aliases in (
        ("r", ("r", "x")),
        ("g", ("g", "y")),
        ("b", ("b", "z")),
        ("a", ("a", "w")),
    ):
        number = _optional_number(_value(value, *aliases))
        if number is not None:
            result[canonical] = number
    return result or None


def _tree_database(terrain_data: Any) -> Tuple[List[Any], List[Any]]:
    database = _value(terrain_data, "m_TreeDatabase", "treeDatabase")
    detail_database = _value(terrain_data, "m_DetailDatabase", "detailDatabase")
    for container in (database, detail_database, terrain_data):
        prototypes = _value(container, "m_TreePrototypes", "treePrototypes")
        instances = _value(container, "m_TreeInstances", "treeInstances")
        if prototypes is not None or instances is not None:
            return _sequence(prototypes), _sequence(instances)
    return [], []


def _prototype_name(prototype: Any, index: int) -> str:
    name = _text(_value(prototype, "m_Name", "name"), fallback="")
    if name:
        return name
    prefab_pointer = _value(prototype, "m_Prefab", "prefab")
    if prefab_pointer is not None:
        prefab = _deref(prefab_pointer, "tree/plant prototype prefab metadata")
        name = _text(_value(prefab, "m_Name", "name"), fallback="")
    return name or f"terrain-vegetation-{index:03d}"


def _vegetation_draft(
    terrain_data: Any,
    world_matrix: Tuple[Tuple[float, ...], ...],
    terrain_size: Tuple[float, float, float],
) -> Dict[str, Any]:
    prototypes, instances = _tree_database(terrain_data)
    prototype_facts: List[Dict[str, Any]] = []
    for index, prototype_value in enumerate(prototypes):
        prototype = _deref(prototype_value, "tree/plant prototype")
        fact: Dict[str, Any] = {
            "index": index,
            "name": _prototype_name(prototype, index),
            "kind": "terrain-tree-or-plant",
        }
        for output_key, source_names in (
            ("bendFactor", ("m_BendFactor", "bendFactor")),
            ("navMeshLod", ("m_NavMeshLod", "navMeshLod")),
        ):
            value = _optional_number(_value(prototype, *source_names))
            if value is not None:
                fact[output_key] = value
        prototype_facts.append(fact)

    instance_facts: List[Dict[str, Any]] = []
    for index, instance in enumerate(instances):
        prototype_index = _integer(
            _value(instance, "prototypeIndex", "m_PrototypeIndex", "index", "m_Index"),
            "tree/plant prototype index",
        )
        if prototype_index < 0 or prototype_index >= len(prototype_facts):
            raise TerrainExportError("tree/plant instance references an invalid prototype")
        normalized = _vector3(
            _value(instance, "position", "m_Position"), "tree/plant normalized position"
        )
        local = (
            normalized[0] * terrain_size[0],
            normalized[1] * terrain_size[1],
            normalized[2] * terrain_size[2],
        )
        world = _apply_matrix(world_matrix, local)
        fact = {
            "index": index,
            "prototypeIndex": prototype_index,
            "positionNormalized": _vector_fact(normalized),
            "worldPosition": _vector_fact(world),
        }
        for output_key, source_names in (
            ("widthScale", ("widthScale", "m_WidthScale")),
            ("heightScale", ("heightScale", "m_HeightScale")),
            ("rotationRadians", ("rotation", "m_Rotation")),
        ):
            value = _optional_number(_value(instance, *source_names))
            if value is not None:
                fact[output_key] = value
        color = _optional_color(_value(instance, "color", "m_Color"))
        lightmap_color = _optional_color(
            _value(instance, "lightmapColor", "m_LightmapColor")
        )
        if color is not None:
            fact["color"] = color
        if lightmap_color is not None:
            fact["lightmapColor"] = lightmap_color
        instance_facts.append(fact)
    return {"prototypes": prototype_facts, "instances": instance_facts}


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _json_bytes(value: Any) -> bytes:
    return (
        json.dumps(value, allow_nan=False, ensure_ascii=False, indent=2, sort_keys=True)
        + "\n"
    ).encode("utf-8")


def _terrain_drafts(environment: Any) -> List[Dict[str, Any]]:
    drafts: List[Dict[str, Any]] = []
    for reader in getattr(environment, "objects", ()):
        if _reader_type_name(reader) != "Terrain":
            continue
        terrain = _read_reader(reader)
        terrain_data = _deref(
            _value(terrain, "m_TerrainData", "terrainData"), "TerrainData"
        )
        if terrain_data is None:
            raise TerrainExportError("Terrain has no TerrainData")
        transform = _terrain_transform(terrain)
        world_matrix = _world_matrix(transform)
        _require_axis_aligned_unit_world_transform(world_matrix)
        origin = _apply_matrix(world_matrix, (0.0, 0.0, 0.0))
        columns, rows, scale, raw_value = _heightmap_details(terrain_data)
        raw_heights = decode_sint16_heights(raw_value, columns * rows)
        height_payload, minimum_y, maximum_y = _world_height_bytes(
            raw_heights, origin[1], scale[1]
        )
        terrain_size = _terrain_size(terrain_data, columns, rows, scale)

        controls: List[Dict[str, Any]] = []
        for control_index, pointer in enumerate(_control_pointers(terrain_data)):
            texture = _deref(pointer, "terrain control Texture2D")
            width, height, rgba = _rgba_image_bytes(texture)
            controls.append(
                {
                    "index": control_index,
                    "width": width,
                    "height": height,
                    "payload": encode_rgba_png(width, height, rgba),
                }
            )
        drafts.append(
            {
                "name": _text(
                    _value(terrain_data, "m_Name", "name"),
                    fallback=f"terrain-{len(drafts):03d}",
                ),
                "origin": origin,
                "columns": columns,
                "rows": rows,
                "scale": scale,
                "terrainSize": terrain_size,
                "heightPayload": height_payload,
                "minimumY": minimum_y,
                "maximumY": maximum_y,
                "controls": controls,
                "layers": _layer_entries(terrain_data),
                "vegetation": _vegetation_draft(terrain_data, world_matrix, terrain_size),
            }
        )
    if not drafts:
        raise TerrainExportError("targeted Customs terrain scene contains no Terrain objects")
    drafts.sort(
        key=lambda draft: (
            draft["origin"][2],
            draft["origin"][0],
            draft["origin"][1],
            draft["name"].casefold(),
        )
    )
    return drafts


def build_package(
    source_root: Path,
    catalog_file: Path,
    scene_index: int,
    scene_path: str,
    level_file: Path,
    shared_file: Path,
    unitypy_module: Any,
) -> Tuple[Dict[str, Any], Dict[str, bytes]]:
    # The one terrain payload load is deliberately a paired call. No other
    # levels, shared assets, bundles, executables, or StreamingAssets are loaded.
    environment = _load_environment(unitypy_module, level_file, shared_file)
    drafts = _terrain_drafts(environment)
    files: Dict[str, bytes] = {}
    tiles: List[Dict[str, Any]] = []
    report_tiles: List[Dict[str, Any]] = []
    for tile_index, draft in enumerate(drafts):
        tile_id = f"terrain-{tile_index:03d}"
        height_file = f"{tile_id}-height-world-y.f32le"
        height_payload = draft["heightPayload"]
        files[height_file] = height_payload

        control_maps: List[Dict[str, Any]] = []
        for control in draft["controls"]:
            control_id = f"{tile_id}-control-{control['index']}"
            file_name = f"{control_id}.png"
            payload = control["payload"]
            files[file_name] = payload
            control_maps.append(
                {
                    "id": control_id,
                    "file": file_name,
                    "channels": list(CONTROL_CHANNELS),
                    "width": control["width"],
                    "height": control["height"],
                    "columnOrder": "x-min-to-x-max",
                    "rowOrder": "z-min-to-z-max",
                }
            )

        prototypes: List[Dict[str, Any]] = []
        vegetation_payload = {
            "schemaVersion": SCHEMA_VERSION,
            "map": MAP_ID,
            "localOnly": True,
            "sourceFrame": SOURCE_FRAME,
            "tileId": tile_id,
            "prototypes": [],
            "instances": [],
        }
        for prototype in draft["vegetation"]["prototypes"]:
            prototype_id = f"{tile_id}-vegetation-{prototype['index']:03d}"
            full = dict(prototype)
            full["id"] = prototype_id
            vegetation_payload["prototypes"].append(full)
            prototypes.append({"id": prototype_id, "name": prototype["name"]})
        for instance in draft["vegetation"]["instances"]:
            full = dict(instance)
            prototype_index = full.pop("prototypeIndex")
            full["prototypeId"] = prototypes[prototype_index]["id"]
            vegetation_payload["instances"].append(full)
        vegetation_file = f"{tile_id}-vegetation.json"
        vegetation_bytes = _json_bytes(vegetation_payload)
        files[vegetation_file] = vegetation_bytes

        layers = []
        for layer in draft["layers"]:
            control_id = control_maps[layer["controlIndex"]]["id"]
            layers.append(
                {
                    "id": f"{tile_id}-layer-{layer['index']:02d}",
                    "name": layer["name"],
                    "index": layer["index"],
                    "controlMapId": control_id,
                    "channel": layer["channel"],
                }
            )

        origin = draft["origin"]
        tile = {
            "id": tile_id,
            "origin": _vector_fact(origin),
            "resolution": {"columns": draft["columns"], "rows": draft["rows"]},
            "sampleSpacingM": {"x": draft["scale"][0], "z": draft["scale"][2]},
            "heightEncoding": {
                "storage": "float32le",
                "endianness": "little",
                "scalarType": "float32",
                "sampleOrder": "row-major-z-times-columns-plus-x",
                "values": "canonical-world-y-metres",
            },
            "heightFile": height_file,
            "controlMaps": control_maps,
            "layers": layers,
            "vegetation": {
                "file": vegetation_file,
                "format": "json",
                "count": len(vegetation_payload["instances"]),
                "prototypes": prototypes,
            },
        }
        tiles.append(tile)
        report_tiles.append(
            {
                "id": tile_id,
                "name": draft["name"],
                "extentM": {
                    "x": draft["terrainSize"][0],
                    "z": draft["terrainSize"][2],
                },
                "heightByteLength": len(height_payload),
                "heightSampleCount": draft["columns"] * draft["rows"],
                "heightRangeYM": {
                    "min": draft["minimumY"],
                    "max": draft["maximumY"],
                },
                "heightSha256": _sha256(height_payload),
                "controlMaps": [
                    {
                        "id": control["id"],
                        "sha256": _sha256(files[control["file"]]),
                    }
                    for control in control_maps
                ],
                "vegetationSha256": _sha256(vegetation_bytes),
            }
        )

    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "map": MAP_ID,
        "localOnly": True,
        "sourceFrame": SOURCE_FRAME,
        # TarkovZero's established relief contract is game-world Y * 2. Unity's
        # world-zero plane is therefore the neutral plane; the Terrain component
        # origin is only an encoding offset and must not become a display pivot.
        "reliefOriginYM": 0.0,
        "tiles": tiles,
    }
    extraction_report = {
        "schemaVersion": SCHEMA_VERSION,
        "map": MAP_ID,
        "localOnly": True,
        "artifact": "customs-terrain-local-extraction-report",
        "generator": {
            "name": "tarkovzero-customs-terrain-local",
            "unityPyVersion": _text(
                getattr(unitypy_module, "__version__", "unknown"), fallback="unknown", limit=80
            ),
        },
        "source": {
            "rootName": _text(source_root.name, fallback="game-data"),
            "catalogFile": catalog_file.relative_to(source_root).as_posix(),
            "terrainSceneIndex": scene_index,
            "terrainScenePath": scene_path,
            "loadedFiles": [
                level_file.relative_to(source_root).as_posix(),
                shared_file.relative_to(source_root).as_posix(),
            ],
        },
        "heightSource": {
            "storage": "sint16",
            "sampleOrder": "row-major-z-times-columns-plus-x",
            "decode": "terrainWorldOriginY + raw / 32767 * heightScaleY",
        },
        "tiles": report_tiles,
    }
    files["extraction-report.json"] = _json_bytes(extraction_report)
    _validate_package(source_root, manifest, files)
    return manifest, files


def _safe_relative_path(value: str) -> PurePosixPath:
    path = PurePosixPath(value)
    if path.is_absolute() or not path.parts or any(part in {"", ".", ".."} for part in path.parts):
        raise TerrainExportError("package contains an unsafe relative output path")
    return path


def _validate_package(
    source_root: Path, manifest: Dict[str, Any], files: Dict[str, bytes]
) -> None:
    allowed_suffixes = {".f32le", ".png", ".json"}
    for name, payload in files.items():
        relative = _safe_relative_path(name)
        if relative.suffix.casefold() not in allowed_suffixes:
            raise TerrainExportError("package attempted to emit a forbidden payload type")
        if not isinstance(payload, bytes):
            raise TerrainExportError("package payload must be bytes")
    manifest_bytes = _json_bytes(manifest)
    source_text = str(source_root.resolve(strict=True)).casefold().encode("utf-8")
    if source_text in manifest_bytes.lower():
        raise TerrainExportError("manifest contains an absolute source path")
    for name, payload in files.items():
        if name.casefold().endswith(".json") and source_text in payload.lower():
            raise TerrainExportError("local JSON artifact contains an absolute source path")
    forbidden_keys = {
        "mesh",
        "meshfile",
        "diffusetexture",
        "normaltexture",
        "normalmap",
        "metallictexture",
        "materialpayload",
        "texturepayload",
    }

    def walk(value: Any) -> None:
        if isinstance(value, Mapping):
            for key, nested in value.items():
                if str(key).casefold() in forbidden_keys:
                    raise TerrainExportError("manifest contains a forbidden original-asset field")
                walk(nested)
        elif isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
            for nested in value:
                walk(nested)

    walk(manifest)


def _write_file(path: Path, payload: bytes) -> None:
    with path.open("xb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())


def write_package_atomic(
    output_dir: Path, manifest: Dict[str, Any], files: Dict[str, bytes]
) -> None:
    staging_value = tempfile.mkdtemp(
        prefix=f".{output_dir.name}.terrain-export-", dir=output_dir.parent
    )
    staging = Path(staging_value).resolve(strict=True)
    try:
        for name in sorted(files):
            relative = _safe_relative_path(name)
            target = staging.joinpath(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            if not _path_is_inside(target.resolve(strict=False), staging):
                raise TerrainExportError("output path escaped the staging directory")
            _write_file(target, files[name])
        _write_file(staging / "manifest.json", _json_bytes(manifest))
        if output_dir.exists():
            raise TerrainExportError("output directory appeared during export; refusing overwrite")
        staging.rename(output_dir)
        staging = Path()
    finally:
        if str(staging) not in {"", "."} and staging.exists():
            shutil.rmtree(staging)


def _import_unitypy() -> Any:
    try:
        import UnityPy  # type: ignore
    except ModuleNotFoundError as error:
        raise TerrainExportError(
            "UnityPy is not installed. Create an isolated environment outside the game-data "
            "directory and run `python -m pip install UnityPy`."
        ) from error
    return UnityPy


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Create a local-only exact Customs terrain package from read-only Unity files. "
            "No original diffuse/normal textures or meshes are exported."
        )
    )
    parser.add_argument("--source", required=True, help="Local Unity game-data root")
    parser.add_argument(
        "--output-dir",
        required=True,
        help="New output directory outside --source (must not already exist)",
    )
    parser.add_argument(
        "--acknowledge-local-game-files",
        action="store_true",
        help="Confirm intentional read-only inspection of local files you may access",
    )
    return parser


def main(
    argv: Optional[Sequence[str]] = None,
    *,
    unitypy_module: Any = None,
    stdout: Optional[TextIO] = None,
    stderr: Optional[TextIO] = None,
) -> int:
    stdout = sys.stdout if stdout is None else stdout
    stderr = sys.stderr if stderr is None else stderr
    args = _parser().parse_args(argv)
    if not args.acknowledge_local_game_files:
        print(
            "error: refuse to inspect local game files without --acknowledge-local-game-files",
            file=stderr,
        )
        return 2
    try:
        source_root, output_dir = _validate_paths(args.source, args.output_dir)
        catalog_file = discover_catalog(source_root)
        unitypy = unitypy_module if unitypy_module is not None else _import_unitypy()
        scene_index, scene_path = discover_customs_terrain_scene(catalog_file, unitypy)
        level_file, shared_file = resolve_scene_files(
            source_root, catalog_file, scene_index
        )
        manifest, files = build_package(
            source_root,
            catalog_file,
            scene_index,
            scene_path,
            level_file,
            shared_file,
            unitypy,
        )
        write_package_atomic(output_dir, manifest, files)
        print(
            f"wrote local-only Customs terrain package: {output_dir} "
            f"({len(manifest['tiles'])} tiles)",
            file=stdout,
        )
        return 0
    except TerrainExportError as error:
        print(f"error: {error}", file=stderr)
        return 2
    except OSError as error:
        print(f"error: filesystem operation failed ({type(error).__name__})", file=stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
