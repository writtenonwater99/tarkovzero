#!/usr/bin/env python3
"""Emit a read-only, scalar-only Unity scene and TerrainData inventory.

This utility deliberately does not export meshes, textures, serialized arrays, or
other reusable game content.  It never invokes a game executable and never writes
under the supplied game-data root.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Optional, TextIO, Tuple


SCHEMA_VERSION = 1
CUSTOMS_SCENE_SEGMENT = "/locations/custom/"
CATALOG_FILE_NAMES = {"globalgamemanagers", "globalgamemanagers.assets"}
ALLOWED_OBJECT_TYPES = {
    "BuildSettings",
    "GameObject",
    "RectTransform",
    "SceneAsset",
    "Terrain",
    "TerrainData",
    "Transform",
}


class InventoryError(RuntimeError):
    """A concise, user-actionable inventory failure."""


def _clean_text(value: Any, *, limit: int = 512) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    if not isinstance(value, str):
        value = str(value)
    value = "".join(character if character >= " " else " " for character in value)
    value = " ".join(value.split())
    return value[:limit]


def _value(container: Any, *names: str) -> Any:
    if container is None:
        return None
    for name in names:
        if isinstance(container, Mapping) and name in container:
            return container[name]
        if hasattr(container, name):
            return getattr(container, name)
    return None


def _integer(value: Any) -> Optional[int]:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return None


def _boolean(value: Any) -> Optional[bool]:
    if isinstance(value, bool):
        return value
    if isinstance(value, int) and value in (0, 1):
        return bool(value)
    return None


def _number(value: Any) -> Optional[float]:
    if isinstance(value, bool) or value is None:
        return None
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(result):
        return None
    result = round(result, 9)
    return 0.0 if result == 0 else result


def _drop_none(values: Dict[str, Any]) -> Dict[str, Any]:
    return {key: value for key, value in values.items() if value is not None}


def _vector_fact(value: Any, components: Sequence[str]) -> Optional[Dict[str, float]]:
    if value is None:
        return None
    result = {
        component: _number(_value(value, component))
        for component in components
    }
    result = _drop_none(result)
    return result or None


def _pointer_fact(value: Any) -> Optional[Dict[str, int]]:
    if value is None:
        return None
    if isinstance(value, int) and not isinstance(value, bool):
        return {"fileId": 0, "pathId": value}
    path_id = _integer(_value(value, "m_PathID", "path_id", "pathId"))
    if path_id is None:
        return None
    file_id = _integer(_value(value, "m_FileID", "file_id", "fileId"))
    return {"fileId": 0 if file_id is None else file_id, "pathId": path_id}


def _sequence(value: Any) -> Sequence[Any]:
    if value is None:
        return ()
    if isinstance(value, Mapping):
        nested = _value(value, "Array", "array", "data", "items")
        return _sequence(nested)
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return value
    return ()


def _normalized_scene_path(value: Any) -> Optional[str]:
    if isinstance(value, Mapping) or not isinstance(value, (str, bytes)):
        value = _value(value, "path", "m_Path", "scene", "m_Scene", "name", "m_Name")
    text = _clean_text(value, limit=1024)
    if not text:
        return None
    text = text.replace("\\", "/")
    text = re.sub(r"/+", "/", text)
    while text.startswith("./"):
        text = text[2:]
    return text


def _is_customs_scene(path: str) -> bool:
    probe = "/" + path.strip("/").casefold() + "/"
    return CUSTOMS_SCENE_SEGMENT in probe


def _path_is_inside(candidate: Path, root: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        pass

    # Windows-backed WSL paths are normally case-insensitive.  A conservative
    # folded comparison prevents spelling-case from bypassing the write guard.
    candidate_text = str(candidate)
    root_text = str(root)
    if candidate_text.casefold().startswith("/mnt/") and root_text.casefold().startswith("/mnt/"):
        try:
            common = os.path.commonpath([candidate_text.casefold(), root_text.casefold()])
        except ValueError:
            return False
        return common == root_text.casefold()
    return False


def _discover_exact_names(source_root: Path, names: Iterable[str]) -> List[Path]:
    allowed = {name.casefold() for name in names}
    matches: List[Path] = []
    for current_root, directory_names, file_names in os.walk(source_root, followlinks=False):
        current = Path(current_root)
        directory_names[:] = sorted(
            name
            for name in directory_names
            if not (current / name).is_symlink()
        )
        for file_name in sorted(file_names):
            if file_name.casefold() not in allowed:
                continue
            path = current / file_name
            if path.is_symlink() or not path.is_file():
                continue
            try:
                resolved = path.resolve(strict=True)
            except OSError:
                continue
            if not _path_is_inside(resolved, source_root):
                continue
            matches.append(resolved)
    matches.sort(key=lambda item: item.relative_to(source_root).as_posix().casefold())
    return matches


def discover_catalog_files(source_root: Path) -> List[Path]:
    """Find only BuildSettings catalog containers; never probe arbitrary files."""
    direct_matches: List[Path] = []
    for name in sorted(CATALOG_FILE_NAMES):
        candidate = source_root / name
        if candidate.is_symlink() or not candidate.is_file():
            continue
        try:
            resolved = candidate.resolve(strict=True)
        except OSError:
            continue
        if _path_is_inside(resolved, source_root):
            direct_matches.append(resolved)
    if direct_matches:
        preferred = [path for path in direct_matches if path.name.casefold() == "globalgamemanagers"]
        return preferred or direct_matches
    recursive_matches = _discover_exact_names(source_root, CATALOG_FILE_NAMES)
    preferred = [path for path in recursive_matches if path.name.casefold() == "globalgamemanagers"]
    return preferred or recursive_matches


def _customs_catalog_entries(scene_catalog: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    by_index: Dict[int, Dict[str, Any]] = {}
    for record in scene_catalog:
        if not record.get("isCustomsCandidate"):
            continue
        index = _integer(record.get("index"))
        path = _normalized_scene_path(record.get("path"))
        if index is None or path is None:
            continue
        previous = by_index.get(index)
        if previous is not None and previous["path"] != path:
            raise InventoryError(
                f"BuildSettings contains conflicting Customs paths for scene index {index}"
            )
        by_index[index] = {
            "index": index,
            "path": path,
            "isCustomsCandidate": True,
        }
    return [by_index[index] for index in sorted(by_index)]


def discover_customs_scene_files(
    source_root: Path,
    scene_catalog: Sequence[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Resolve the exact serialized-file family authorized by Customs catalog rows."""
    customs_entries = _customs_catalog_entries(scene_catalog)
    if not customs_entries:
        raise InventoryError(
            "BuildSettings has no scene path containing /Locations/Custom/"
        )

    expected: Dict[str, Dict[str, Any]] = {}
    for entry in customs_entries:
        index = entry["index"]
        for role, name in (
            ("level", f"level{index}"),
            ("sharedassets", f"sharedassets{index}.assets"),
        ):
            expected[name.casefold()] = {
                "sceneIndex": index,
                "scenePath": entry["path"],
                "role": role,
                "expectedName": name,
            }

    matches = _discover_exact_names(source_root, expected)
    matched_by_name: Dict[str, List[Path]] = {name: [] for name in expected}
    for path in matches:
        matched_by_name[path.name.casefold()].append(path)

    selected: List[Dict[str, Any]] = []
    for name, association in expected.items():
        paths = matched_by_name[name]
        if not paths:
            raise InventoryError(
                f"missing targeted Customs serialized file: {association['expectedName']}"
            )
        if len(paths) != 1:
            locations = ", ".join(
                path.relative_to(source_root).as_posix() for path in paths
            )
            raise InventoryError(
                f"ambiguous targeted Customs file {association['expectedName']}: {locations}"
            )
        path = paths[0]
        selected.append(
            {
                "path": path,
                "file": path.relative_to(source_root).as_posix(),
                "sceneIndex": association["sceneIndex"],
                "scenePath": association["scenePath"],
                "role": association["role"],
            }
        )
    selected.sort(
        key=lambda item: (
            item["sceneIndex"],
            0 if item["role"] == "level" else 1,
            item["file"].casefold(),
        )
    )
    return selected


def _validate_paths(
    source_value: str,
    output_value: str,
    *,
    force: bool,
) -> Tuple[Path, Path]:
    source_candidate = Path(source_value).expanduser()
    try:
        source_root = source_candidate.resolve(strict=True)
    except OSError as error:
        raise InventoryError(f"game-data source does not exist: {source_candidate}") from error
    if not source_root.is_dir():
        raise InventoryError(f"game-data source is not a directory: {source_candidate}")

    output_candidate = Path(output_value).expanduser()
    if not output_candidate.is_absolute():
        output_candidate = Path.cwd() / output_candidate
    if output_candidate.is_symlink():
        raise InventoryError("output path must not be a symbolic link")
    output_path = output_candidate.resolve(strict=False)
    if _path_is_inside(output_path, source_root):
        raise InventoryError("output must be outside the supplied game-data source")
    if not output_path.parent.exists() or not output_path.parent.is_dir():
        raise InventoryError("output parent directory must already exist")
    if output_path.exists():
        if output_path.is_dir():
            raise InventoryError("output path is a directory")
        if not force:
            raise InventoryError("output already exists; pass --force to replace it")
    return source_root, output_path


def _reader_path_id(reader: Any) -> Optional[int]:
    return _integer(_value(reader, "path_id", "m_PathID", "pathId"))


def _reader_type_name(reader: Any) -> str:
    type_value = _value(reader, "type")
    name = _value(type_value, "name") if type_value is not None else None
    return _clean_text(name or type_value, limit=80) or "Unknown"


def _asset_label(reader: Any, source_root: Path, candidate: Path) -> str:
    candidate_relative = candidate.relative_to(source_root).as_posix()
    asset_file = _value(reader, "assets_file", "assetsfile")
    raw_name = _value(asset_file, "path", "name", "file_name")
    if raw_name is None:
        return candidate_relative
    text = _clean_text(raw_name, limit=1024)
    if not text:
        return candidate_relative
    possible_path = Path(text)
    if possible_path.is_absolute():
        try:
            resolved = possible_path.resolve(strict=False)
            if _path_is_inside(resolved, source_root):
                text = resolved.relative_to(source_root).as_posix()
            else:
                text = possible_path.name
        except (OSError, ValueError):
            text = possible_path.name
    text = text.replace("\\", "/")
    if text == candidate_relative or text == candidate.name:
        return candidate_relative
    return f"{candidate_relative}::{text}"


def _object_id(asset: str, type_name: str, path_id: Optional[int]) -> str:
    suffix = "unknown" if path_id is None else str(path_id)
    return f"{asset}#{type_name}:{suffix}"


def _parse_build_settings(
    data: Any,
    *,
    asset: str,
    path_id: Optional[int],
) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    scenes_value = _value(data, "scenes", "m_Scenes", "m_scenes")
    scenes: List[Dict[str, Any]] = []
    for index, entry in enumerate(_sequence(scenes_value)):
        path = _normalized_scene_path(entry)
        if not path:
            continue
        scenes.append(
            {
                "index": index,
                "path": path,
                "isCustomsCandidate": _is_customs_scene(path),
            }
        )
    record = {
        "objectId": _object_id(asset, "BuildSettings", path_id),
        "asset": asset,
        "pathId": path_id,
        "sceneCount": len(scenes),
    }
    return _drop_none(record), scenes


def _parse_game_object(data: Any, *, asset: str, path_id: Optional[int]) -> Dict[str, Any]:
    name = _clean_text(_value(data, "m_Name", "name")) or ""
    return _drop_none(
        {
            "objectId": _object_id(asset, "GameObject", path_id),
            "asset": asset,
            "pathId": path_id,
            "name": name,
            "active": _boolean(_value(data, "m_IsActive", "isActive")),
            "layer": _integer(_value(data, "m_Layer", "layer")),
            "tag": _clean_text(_value(data, "m_TagString", "tag")),
        }
    )


def _parse_transform(
    data: Any,
    *,
    asset: str,
    path_id: Optional[int],
    type_name: str,
) -> Dict[str, Any]:
    transform = _drop_none(
        {
            "localPosition": _vector_fact(
                _value(data, "m_LocalPosition", "localPosition"), ("x", "y", "z")
            ),
            "localRotation": _vector_fact(
                _value(data, "m_LocalRotation", "localRotation"), ("x", "y", "z", "w")
            ),
            "localScale": _vector_fact(
                _value(data, "m_LocalScale", "localScale"), ("x", "y", "z")
            ),
        }
    )
    return _drop_none(
        {
            "objectId": _object_id(asset, type_name, path_id),
            "asset": asset,
            "pathId": path_id,
            "gameObject": _pointer_fact(_value(data, "m_GameObject", "gameObject")),
            "parentTransform": _pointer_fact(_value(data, "m_Father", "father", "parent")),
            "transform": transform or None,
        }
    )


def _find_height_values(heightmap: Any, terrain_data: Any) -> Any:
    for container in (heightmap, terrain_data):
        value = _value(
            container,
            "m_Heights",
            "heights",
            "m_HeightData",
            "heightData",
        )
        if value is not None:
            return value
    return None


def _iter_numeric_values(value: Any) -> Iterator[float]:
    if isinstance(value, bool) or value is None:
        return
    if isinstance(value, (int, float)):
        number = _number(value)
        if number is not None:
            yield number
        return
    if isinstance(value, Mapping):
        nested = _value(value, "Array", "array", "data", "items")
        if nested is not None:
            yield from _iter_numeric_values(nested)
        return
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        for item in value:
            yield from _iter_numeric_values(item)


def _summarize_raw_heights(value: Any) -> Dict[str, Any]:
    if value is None:
        return {"available": False}
    if isinstance(value, memoryview):
        value = value.tobytes()
    if isinstance(value, (bytes, bytearray)):
        raw = bytes(value)
        return {
            "available": True,
            "storage": "bytes",
            "byteCount": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(),
        }

    count = 0
    minimum: Optional[float] = None
    maximum: Optional[float] = None
    total = 0.0
    compensation = 0.0
    integral_values = True
    for number in _iter_numeric_values(value):
        count += 1
        minimum = number if minimum is None else min(minimum, number)
        maximum = number if maximum is None else max(maximum, number)
        integral_values = integral_values and number.is_integer()
        corrected = number - compensation
        updated = total + corrected
        compensation = (updated - total) - corrected
        total = updated

    if count == 0:
        return {"available": True, "storage": "numeric", "sampleCount": 0}
    return {
        "available": True,
        "storage": "numeric",
        "sampleCount": count,
        "minimum": minimum,
        "maximum": maximum,
        "mean": _number(total / count),
        "integralValues": integral_values,
    }


def _parse_terrain_data(data: Any, *, asset: str, path_id: Optional[int]) -> Dict[str, Any]:
    heightmap = _value(data, "m_Heightmap", "heightmap")
    scalar_resolution = _integer(
        _value(data, "m_HeightmapResolution", "heightmapResolution")
    )
    nested_resolution = _integer(_value(heightmap, "m_Resolution", "resolution"))
    width = _integer(_value(heightmap, "m_Width", "width"))
    height = _integer(_value(heightmap, "m_Height", "height"))
    if nested_resolution is not None:
        width = nested_resolution if width is None else width
        height = nested_resolution if height is None else height
    if scalar_resolution is not None:
        width = scalar_resolution if width is None else width
        height = scalar_resolution if height is None else height
    resolution = _drop_none({"width": width, "height": height})
    name = _clean_text(_value(data, "m_Name", "name")) or ""
    return _drop_none(
        {
            "objectId": _object_id(asset, "TerrainData", path_id),
            "asset": asset,
            "pathId": path_id,
            "name": name,
            "heightmapResolution": resolution or None,
            "heightmapScale": _vector_fact(
                _value(heightmap, "m_Scale", "scale"), ("x", "y", "z")
            ),
            "terrainSize": _vector_fact(
                _value(data, "m_Size", "size"), ("x", "y", "z")
            ),
            "rawHeightSummary": _summarize_raw_heights(
                _find_height_values(heightmap, data)
            ),
        }
    )


def _parse_terrain(data: Any, *, asset: str, path_id: Optional[int]) -> Dict[str, Any]:
    return _drop_none(
        {
            "objectId": _object_id(asset, "Terrain", path_id),
            "asset": asset,
            "pathId": path_id,
            "gameObject": _pointer_fact(_value(data, "m_GameObject", "gameObject")),
            "terrainData": _pointer_fact(_value(data, "m_TerrainData", "terrainData")),
        }
    )


def _parse_scene_asset(data: Any, *, asset: str, path_id: Optional[int]) -> Dict[str, Any]:
    return _drop_none(
        {
            "objectId": _object_id(asset, "SceneAsset", path_id),
            "asset": asset,
            "pathId": path_id,
            "name": _clean_text(_value(data, "m_Name", "name")) or "",
        }
    )


def _pointer_key(asset: str, pointer: Optional[Dict[str, int]]) -> Optional[Tuple[str, int]]:
    if not pointer or pointer.get("fileId") != 0 or pointer.get("pathId") in (None, 0):
        return None
    return asset, pointer["pathId"]


def _hierarchy_for_game_object(
    key: Tuple[str, int],
    game_objects: Dict[Tuple[str, int], Dict[str, Any]],
    transform_by_game_object: Dict[Tuple[str, int], Dict[str, Any]],
    transforms: Dict[Tuple[str, int], Dict[str, Any]],
    active: Optional[set] = None,
) -> Tuple[str, bool, Optional[int]]:
    active = set() if active is None else active
    game_object = game_objects.get(key)
    if game_object is None:
        return "", False, None
    name = game_object.get("name") or f"<unnamed:{key[1]}>"
    name = name.replace("/", "∕")
    transform = transform_by_game_object.get(key)
    if transform is None:
        return name, False, None
    parent_key = _pointer_key(key[0], transform.get("parentTransform"))
    if parent_key is None:
        parent_pointer = transform.get("parentTransform")
        complete = parent_pointer is None or parent_pointer.get("pathId") == 0
        return name, complete, None
    if parent_key in active:
        return name, False, None
    parent_transform = transforms.get(parent_key)
    if parent_transform is None:
        return name, False, None
    parent_game_key = _pointer_key(key[0], parent_transform.get("gameObject"))
    if parent_game_key is None:
        return name, False, None
    parent_path, complete, _ = _hierarchy_for_game_object(
        parent_game_key,
        game_objects,
        transform_by_game_object,
        transforms,
        active | {key},
    )
    path = f"{parent_path}/{name}" if parent_path else name
    return path, complete, parent_game_key[1]


def _finalize_game_objects(
    records: Iterable[Dict[str, Any]],
    transform_records: Iterable[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    game_objects = {
        (record["asset"], record["pathId"]): record
        for record in records
        if record.get("pathId") is not None
    }
    transforms = {
        (record["asset"], record["pathId"]): record
        for record in transform_records
        if record.get("pathId") is not None
    }
    transform_by_game_object: Dict[Tuple[str, int], Dict[str, Any]] = {}
    for record in transforms.values():
        game_key = _pointer_key(record["asset"], record.get("gameObject"))
        if game_key is not None:
            transform_by_game_object.setdefault(game_key, record)

    result: List[Dict[str, Any]] = []
    for key in sorted(game_objects, key=lambda item: (item[0].casefold(), item[1])):
        record = dict(game_objects[key])
        hierarchy_path, complete, parent_path_id = _hierarchy_for_game_object(
            key, game_objects, transform_by_game_object, transforms
        )
        record["hierarchyPath"] = hierarchy_path
        record["hierarchyComplete"] = complete
        transform = transform_by_game_object.get(key)
        if transform is not None:
            record["transformPathId"] = transform.get("pathId")
            if transform.get("transform"):
                record["transform"] = transform["transform"]
        if parent_path_id is not None:
            record["parentGameObjectPathId"] = parent_path_id
        result.append(_drop_none(record))
    return result


def _link_terrain_instances(
    terrain_instances: Iterable[Dict[str, Any]],
    game_objects: Iterable[Dict[str, Any]],
    terrain_data: Iterable[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    game_lookup = {
        (record["asset"], record["pathId"]): record
        for record in game_objects
        if record.get("pathId") is not None
    }
    terrain_lookup = {
        (record["asset"], record["pathId"]): record
        for record in terrain_data
        if record.get("pathId") is not None
    }
    result: List[Dict[str, Any]] = []
    for item in terrain_instances:
        record = dict(item)
        game_key = _pointer_key(record["asset"], record.get("gameObject"))
        terrain_key = _pointer_key(record["asset"], record.get("terrainData"))
        if game_key in game_lookup:
            record["gameObjectId"] = game_lookup[game_key]["objectId"]
            record["hierarchyPath"] = game_lookup[game_key].get("hierarchyPath")
        if terrain_key in terrain_lookup:
            record["terrainDataId"] = terrain_lookup[terrain_key]["objectId"]
        result.append(_drop_none(record))
    result.sort(key=lambda item: (item["asset"].casefold(), item.get("pathId", -1)))
    return result


def _unique_records(records: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    unique: Dict[str, Dict[str, Any]] = {}
    for record in records:
        unique.setdefault(record["objectId"], record)
    return list(unique.values())


def load_build_settings_catalog(
    source_root: Path,
    catalog_files: Sequence[Path],
    unitypy_module: Any,
) -> Dict[str, Any]:
    build_settings: List[Dict[str, Any]] = []
    scene_catalog: List[Dict[str, Any]] = []
    file_failures: List[Dict[str, Any]] = []
    parse_failures: List[Dict[str, Any]] = []
    loaded_files = 0
    skipped_objects = 0

    for candidate in catalog_files:
        relative_file = candidate.relative_to(source_root).as_posix()
        try:
            environment = unitypy_module.load(str(candidate))
        except Exception as error:
            file_failures.append(
                {"file": relative_file, "phase": "catalog", "errorType": type(error).__name__}
            )
            continue
        loaded_files += 1
        for reader in environment.objects:
            type_name = _reader_type_name(reader)
            if type_name != "BuildSettings":
                skipped_objects += 1
                continue
            path_id = _reader_path_id(reader)
            asset = _asset_label(reader, source_root, candidate)
            try:
                data = reader.parse_as_dict()
                record, scenes = _parse_build_settings(
                    data, asset=asset, path_id=path_id
                )
                record["sourceFile"] = relative_file
                build_settings.append(record)
                for scene in scenes:
                    scene["catalogObjectId"] = record["objectId"]
                    scene_catalog.append(scene)
            except Exception as error:
                parse_failures.append(
                    _drop_none(
                        {
                            "asset": asset,
                            "pathId": path_id,
                            "type": type_name,
                            "phase": "catalog",
                            "errorType": type(error).__name__,
                        }
                    )
                )

    scene_catalog_by_key: Dict[Tuple[int, str], Dict[str, Any]] = {}
    for record in scene_catalog:
        scene_catalog_by_key[(record["index"], record["path"])] = record
    scene_catalog = sorted(
        scene_catalog_by_key.values(),
        key=lambda item: (item["index"], item["path"].casefold()),
    )
    build_settings = _unique_records(build_settings)
    build_settings.sort(key=lambda item: (item["asset"].casefold(), item.get("pathId", -1)))
    file_failures.sort(key=lambda item: item["file"].casefold())
    parse_failures.sort(
        key=lambda item: (
            item["asset"].casefold(),
            item.get("type", ""),
            item.get("pathId", -1),
        )
    )
    return {
        "buildSettings": build_settings,
        "sceneCatalog": scene_catalog,
        "catalogFiles": [
            path.relative_to(source_root).as_posix() for path in catalog_files
        ],
        "loadedFileCount": loaded_files,
        "skippedNonCatalogObjects": skipped_objects,
        "fileLoadFailures": file_failures,
        "objectParseFailures": parse_failures,
        "complete": not file_failures and not parse_failures,
    }


def _with_scene_association(
    record: Dict[str, Any], selection: Dict[str, Any]
) -> Dict[str, Any]:
    record.update(
        {
            "sourceFile": selection["file"],
            "sourceRole": selection["role"],
            "sceneIndex": selection["sceneIndex"],
            "scenePath": selection["scenePath"],
        }
    )
    return record


def build_inventory(
    source_root: Path,
    catalog: Dict[str, Any],
    scene_files: Sequence[Dict[str, Any]],
    unitypy_module: Any,
) -> Dict[str, Any]:
    build_settings: List[Dict[str, Any]] = list(catalog["buildSettings"])
    scene_catalog: List[Dict[str, Any]] = list(catalog["sceneCatalog"])
    scene_assets: List[Dict[str, Any]] = []
    raw_game_objects: List[Dict[str, Any]] = []
    transforms: List[Dict[str, Any]] = []
    terrain_data: List[Dict[str, Any]] = []
    terrain_instances: List[Dict[str, Any]] = []
    file_failures: List[Dict[str, Any]] = list(catalog["fileLoadFailures"])
    parse_failures: List[Dict[str, Any]] = list(catalog["objectParseFailures"])
    loaded_scene_files = 0
    skipped_objects = catalog["skippedNonCatalogObjects"]

    for selection in scene_files:
        candidate = selection["path"]
        relative_file = selection["file"]
        try:
            environment = unitypy_module.load(str(candidate))
        except Exception as error:  # Unity formats fail in version-specific ways.
            file_failures.append(
                {
                    "file": relative_file,
                    "phase": "scene",
                    "sceneIndex": selection["sceneIndex"],
                    "errorType": type(error).__name__,
                }
            )
            continue
        loaded_scene_files += 1
        for reader in environment.objects:
            type_name = _reader_type_name(reader)
            if type_name not in ALLOWED_OBJECT_TYPES or type_name == "BuildSettings":
                skipped_objects += 1
                continue
            path_id = _reader_path_id(reader)
            asset = _asset_label(reader, source_root, candidate)
            try:
                data = reader.parse_as_dict()
                if type_name == "GameObject":
                    raw_game_objects.append(
                        _with_scene_association(
                            _parse_game_object(data, asset=asset, path_id=path_id),
                            selection,
                        )
                    )
                elif type_name in {"Transform", "RectTransform"}:
                    transforms.append(
                        _with_scene_association(
                            _parse_transform(
                                data,
                                asset=asset,
                                path_id=path_id,
                                type_name=type_name,
                            ),
                            selection,
                        )
                    )
                elif type_name == "TerrainData":
                    terrain_data.append(
                        _with_scene_association(
                            _parse_terrain_data(data, asset=asset, path_id=path_id),
                            selection,
                        )
                    )
                elif type_name == "Terrain":
                    terrain_instances.append(
                        _with_scene_association(
                            _parse_terrain(data, asset=asset, path_id=path_id),
                            selection,
                        )
                    )
                elif type_name == "SceneAsset":
                    scene_assets.append(
                        _with_scene_association(
                            _parse_scene_asset(data, asset=asset, path_id=path_id),
                            selection,
                        )
                    )
            except Exception as error:
                parse_failures.append(
                    _drop_none(
                        {
                            "asset": asset,
                            "pathId": path_id,
                            "type": type_name,
                            "phase": "scene",
                            "sceneIndex": selection["sceneIndex"],
                            "errorType": type(error).__name__,
                        }
                    )
                )

    customs_scene_indices = sorted(
        {record["index"] for record in scene_catalog if record["isCustomsCandidate"]}
    )
    build_settings = _unique_records(build_settings)
    scene_assets = _unique_records(scene_assets)
    terrain_data = _unique_records(terrain_data)
    terrain_instances = _unique_records(terrain_instances)
    game_objects = _finalize_game_objects(raw_game_objects, transforms)
    terrain_data.sort(key=lambda item: (item["asset"].casefold(), item.get("pathId", -1)))
    terrain_instances = _link_terrain_instances(
        terrain_instances, game_objects, terrain_data
    )
    build_settings.sort(key=lambda item: (item["asset"].casefold(), item.get("pathId", -1)))
    scene_assets.sort(key=lambda item: (item["asset"].casefold(), item.get("pathId", -1)))
    file_failures.sort(key=lambda item: item["file"].casefold())
    parse_failures.sort(
        key=lambda item: (
            item["asset"].casefold(),
            item.get("type", ""),
            item.get("pathId", -1),
        )
    )
    complete = not file_failures and not parse_failures

    scene_file_facts = [
        {
            "file": selection["file"],
            "role": selection["role"],
            "sceneIndex": selection["sceneIndex"],
            "scenePath": selection["scenePath"],
        }
        for selection in scene_files
    ]
    inventory = {
        "schemaVersion": SCHEMA_VERSION,
        "generator": {
            "name": "tarkovzero-unity-scalar-inventory",
            "unityPyVersion": _clean_text(
                getattr(unitypy_module, "__version__", "unknown"), limit=80
            ),
        },
        "source": {
            "rootName": _clean_text(source_root.name) or "game-data",
            "catalogFiles": list(catalog["catalogFiles"]),
            "catalogFileCount": len(catalog["catalogFiles"]),
            "sceneFiles": scene_file_facts,
            "sceneFileCount": len(scene_file_facts),
            "loadedCatalogFileCount": catalog["loadedFileCount"],
            "loadedSceneFileCount": loaded_scene_files,
            "loadedFileCount": catalog["loadedFileCount"] + loaded_scene_files,
        },
        "complete": complete,
        "counts": {
            "buildSettings": len(build_settings),
            "sceneCatalogEntries": len(scene_catalog),
            "customsSceneCandidates": sum(
                1 for record in scene_catalog if record["isCustomsCandidate"]
            ),
            "sceneAssets": len(scene_assets),
            "gameObjects": len(game_objects),
            "terrainData": len(terrain_data),
            "terrainInstances": len(terrain_instances),
            "skippedNonInventoryObjects": skipped_objects,
        },
        "buildSettings": build_settings,
        "sceneCatalog": scene_catalog,
        "customsSceneIndices": customs_scene_indices,
        "sceneFiles": scene_file_facts,
        "sceneAssets": scene_assets,
        "gameObjects": game_objects,
        "terrainData": terrain_data,
        "terrainInstances": terrain_instances,
        "diagnostics": {
            "fileLoadFailures": file_failures,
            "objectParseFailures": parse_failures,
        },
    }
    # Reject accidental non-JSON values and NaN/Infinity before any filesystem write.
    json.dumps(inventory, allow_nan=False, sort_keys=True)
    return inventory


def _import_unitypy() -> Any:
    try:
        import UnityPy  # type: ignore
    except ModuleNotFoundError as error:
        raise InventoryError(
            "UnityPy is not installed. Create an isolated Python environment outside "
            "the game-data directory, run `python -m pip install UnityPy`, and invoke "
            "this script with that environment's Python."
        ) from error
    return UnityPy


def _write_json_atomic(output_path: Path, inventory: Dict[str, Any]) -> None:
    payload = json.dumps(
        inventory,
        allow_nan=False,
        ensure_ascii=False,
        indent=2,
        sort_keys=True,
    ) + "\n"
    temporary_name: Optional[str] = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=output_path.parent,
            prefix=f".{output_path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temporary_name = handle.name
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, output_path)
        temporary_name = None
    finally:
        if temporary_name is not None:
            try:
                Path(temporary_name).unlink()
            except FileNotFoundError:
                pass


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Read Unity scene/TerrainData metadata and emit normalized scalar facts only. "
            "The game executable is never invoked."
        )
    )
    parser.add_argument("--source", required=True, help="User-supplied local game-data directory")
    parser.add_argument(
        "--output",
        required=True,
        help="Explicit JSON output path outside the game-data directory",
    )
    parser.add_argument(
        "--acknowledge-local-game-files",
        action="store_true",
        help="Confirm that you are intentionally inspecting local files you may access",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help=(
            "Validate paths and identify only globalgamemanagers; Customs level files "
            "remain deferred until BuildSettings is parsed in a real run"
        ),
    )
    parser.add_argument(
        "--allow-partial",
        action="store_true",
        help="Explicitly allow an output marked incomplete when a file/object cannot be parsed",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Replace an existing output file (never anything under --source)",
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
            "error: refuse to inspect local game files without "
            "--acknowledge-local-game-files",
            file=stderr,
        )
        return 2

    try:
        source_root, output_path = _validate_paths(
            args.source, args.output, force=args.force
        )
        catalog_files = discover_catalog_files(source_root)
        if not catalog_files:
            raise InventoryError(
                "no globalgamemanagers BuildSettings catalog was found under --source"
            )
        if len(catalog_files) != 1:
            locations = ", ".join(
                path.relative_to(source_root).as_posix() for path in catalog_files
            )
            raise InventoryError(
                "expected exactly one globalgamemanagers catalog; narrow --source "
                f"to one Unity Data root (found: {locations})"
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
                "deferredSceneSelection": (
                    "A real run parses BuildSettings, finds /Locations/Custom/ indices, "
                    "then opens only levelN and sharedassetsN.assets for those indices."
                ),
                "output": str(output_path),
            }
            print(json.dumps(plan, indent=2, sort_keys=True), file=stdout)
            return 0

        unitypy = unitypy_module if unitypy_module is not None else _import_unitypy()
        catalog = load_build_settings_catalog(source_root, catalog_files, unitypy)
        if catalog["loadedFileCount"] == 0:
            raise InventoryError("UnityPy could not load globalgamemanagers")
        if not catalog["buildSettings"]:
            raise InventoryError("globalgamemanagers did not yield a BuildSettings object")
        scene_files = discover_customs_scene_files(
            source_root, catalog["sceneCatalog"]
        )
        inventory = build_inventory(source_root, catalog, scene_files, unitypy)
        if inventory["source"]["loadedFileCount"] == 0:
            raise InventoryError("UnityPy could not load the targeted Customs files")
        if not inventory["complete"] and not args.allow_partial:
            diagnostics = inventory["diagnostics"]
            raise InventoryError(
                "inventory is incomplete "
                f"({len(diagnostics['fileLoadFailures'])} file failures, "
                f"{len(diagnostics['objectParseFailures'])} object failures); "
                "fix the parser/setup or pass --allow-partial explicitly"
            )
        _write_json_atomic(output_path, inventory)
        print(
            f"wrote scalar Unity inventory: {output_path} "
            f"({inventory['counts']['gameObjects']} objects, "
            f"{inventory['counts']['terrainData']} TerrainData records)",
            file=stdout,
        )
        return 0
    except InventoryError as error:
        print(f"error: {error}", file=stderr)
        return 2
    except OSError as error:
        print(f"error: filesystem operation failed: {type(error).__name__}", file=stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
