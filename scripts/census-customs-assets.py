#!/usr/bin/env python3
"""Emit a bounded, scalar-only Customs asset census for independent reconstruction.

The census records *what exists and where* (identity, hierarchy, transforms,
renderer/material/LOD/light scalars, and a safe payload-object skip ledger) so
that a Customs scene can be rebuilt from original artwork.  It deliberately
never emits reusable asset payloads:
no vertices/indices/UVs/normals/tangents/skin data, no texture pixels, no
shaders or bytecode, no animation payloads, no raw serialized arrays, and no
absolute installation paths.

The tool never starts an executable, never calls a UnityPy save/export API, and
opens only the two-stage authorized selection: `globalgamemanagers` first, then
exclusively the `levelN` / `sharedassetsN.assets` files whose scene index the
BuildSettings catalog reports under `/Locations/Custom/`.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import io
import json
import math
import os
import posixpath
import re
import stat
import sys
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence as Seq, TextIO, Tuple


CENSUS_SCHEMA_VERSION = 2
REPORT_SCHEMA_VERSION = 1
GENERATOR_NAME = "tarkovzero-customs-asset-census"
DIGEST_CHUNK_BYTES = 1 << 20
MAX_MATERIAL_PROPERTIES = 64
MAX_EXAMPLE_PATHS = 3
MAX_SCALAR_LIST = 64
# Real Unity hierarchies are shallow; the cap keeps a malformed or hostile parent
# chain from exhausting the interpreter stack instead of failing closed.
MAX_HIERARCHY_DEPTH = 128
# Emitted hierarchy paths are truncated to stay under the payload guard's string
# bound; `hierarchyPathHash` is always computed over the untruncated path.
MAX_HIERARCHY_PATH = 1000
# `parse_as_dict()` materializes a complete typetree.  Four MiB is deliberately
# conservative for the scalar-bearing component types this release accepts.
# Anything larger (or whose serialized size cannot be established before the
# parse) is ledgered and requires an explicit partial-output acknowledgement.
MAX_PARSED_OBJECT_BYTES = 4 * 1024 * 1024
NEVER_PARSE_TYPES = frozenset(("Mesh", "Texture2D"))
DEPENDENCY_LOADING_METHODS = (
    "find_file",
    "load_file",
    "load_files",
    "load_folder",
    "load_assets",
)


def _load_selector_module() -> Any:
    """Reuse the audited two-stage selector instead of re-implementing it."""
    script = Path(__file__).with_name("extract-customs-unity.py")
    spec = importlib.util.spec_from_file_location("extract_customs_unity", script)
    if spec is None or spec.loader is None:  # pragma: no cover - packaging failure
        raise RuntimeError("cannot load the Customs selector module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


selector = _load_selector_module()

CensusError = selector.InventoryError

_clean_text = selector._clean_text
_value = selector._value
_integer = selector._integer
_boolean = selector._boolean
_number = selector._number
_drop_none = selector._drop_none
_vector_fact = selector._vector_fact
_pointer_fact = selector._pointer_fact
_sequence = selector._sequence
_pointer_key = selector._pointer_key
_reader_path_id = selector._reader_path_id
_reader_type_name = selector._reader_type_name
_object_id = selector._object_id
_unique_records = selector._unique_records
discover_catalog_files = selector.discover_catalog_files
discover_customs_scene_files = selector.discover_customs_scene_files


CENSUS_OBJECT_TYPES = {
    "GameObject",
    "Transform",
    "RectTransform",
    "MeshFilter",
    "MeshRenderer",
    "SkinnedMeshRenderer",
    "Mesh",
    "Material",
    "Texture2D",
    "LODGroup",
    "Light",
    "PrefabInstance",
}
RENDERER_TYPES = {"MeshRenderer", "SkinnedMeshRenderer"}
TRANSFORM_TYPES = {"Transform", "RectTransform"}

# Fields that carry reusable payloads.  They are stripped from every parsed
# object before any downstream code can read them, so a future edit cannot
# accidentally promote one into the emitted JSON.
FORBIDDEN_FIELD_NAMES = frozenset(
    name.casefold()
    for name in (
        "m_VertexData",
        "m_IndexBuffer",
        "m_Vertices",
        "m_Indices",
        "m_Triangles",
        "m_UV",
        "m_UV0",
        "m_UV1",
        "m_UV2",
        "m_UV3",
        "m_Normals",
        "m_Tangents",
        "m_Colors",
        "m_Skin",
        "m_BoneWeights",
        "m_BindPose",
        "m_BindPoses",
        "m_Shapes",
        "m_ShapeVertices",
        "m_BlendShapeData",
        "m_CompressedMesh",
        "m_StreamData",
        "m_MeshCompression",
        "m_BakedConvexCollisionMesh",
        "m_BakedTriangleCollisionMesh",
        "image data",
        "image_data",
        "m_ImageData",
        "m_PlatformBlob",
        "m_Script",
        "m_Shader",
        "m_ShaderKeywords",
        "m_SavedProperties_Blob",
        "m_ClipData",
        "m_Curve",
        "m_Curves",
        "m_ClipBindingConstant",
        "m_Clips",
        "m_AnimationClips",
        "m_MuscleClip",
        "m_MuscleClipSize",
        "m_KeyframeData",
    )
)

# Every key the census and audit report are allowed to emit.  Enforced before
# any write, so an unreviewed field cannot leak into an artifact.
ALLOWED_OUTPUT_KEYS = frozenset(
    (
        # envelope
        "schemaVersion",
        "generator",
        "name",
        "unityPyVersion",
        "selectionMode",
        "source",
        "rootName",
        "catalogFiles",
        "catalogFileFacts",
        "catalogFileCount",
        "sceneFiles",
        "sceneFileCount",
        "loadedCatalogFileCount",
        "loadedSceneFileCount",
        "loadedFileCount",
        "complete",
        "counts",
        "diagnostics",
        # scene-file ledger
        "file",
        "role",
        "sceneIndex",
        "scenePath",
        "sceneIndices",
        "byteSize",
        "sha256",
        "digestComplete",
        "bindingVerified",
        "statIdentityHash",
        # shared object identity
        "objectId",
        "asset",
        "pathId",
        "type",
        "sourceFile",
        "sourceRole",
        "normalizedName",
        "nameHash",
        "hierarchyPath",
        "hierarchyPathHash",
        "hierarchyComplete",
        "parentGameObjectPathId",
        "transformPathId",
        "active",
        "layer",
        "tag",
        "componentCount",
        "componentTypes",
        "componentPathIds",
        # transforms
        "transform",
        "localPosition",
        "localRotation",
        "localScale",
        "world",
        "position",
        "rotation",
        "scale",
        "offset",
        "worldComplete",
        "worldExact",
        "x",
        "y",
        "z",
        "w",
        # pointers
        "fileId",
        "gameObject",
        "gameObjectId",
        "gameObjectPathId",
        "external",
        # renderers
        "renderers",
        "enabled",
        "castShadows",
        "receiveShadows",
        "materialSlotCount",
        "materials",
        "materialIds",
        "materialNames",
        "mesh",
        "meshId",
        "meshName",
        "staticBatch",
        "motionVectors",
        # meshes
        "meshes",
        "submeshCount",
        "vertexCount",
        "localAabb",
        "center",
        "extents",
        # materials
        "materialCount",
        "scalarProperties",
        "colorProperties",
        "textureProperties",
        "value",
        "r",
        "g",
        "b",
        "a",
        "texture",
        "textureId",
        "textureName",
        "textureWidth",
        "textureHeight",
        "propertiesTruncated",
        # textures
        "textures",
        "width",
        "height",
        # LOD groups
        "lodGroups",
        "lodCount",
        "levels",
        "level",
        "screenRelativeTransitionHeight",
        "fadeTransitionWidth",
        "rendererCount",
        "rendererPathIds",
        # lights
        "lights",
        "lightType",
        "color",
        "range",
        "intensity",
        # prefabs
        "prefabInstances",
        "prefabName",
        "prefabSource",
        # references ledger
        "references",
        "internalPointerCount",
        "externalPointerCount",
        "unresolvedInternalPointerCount",
        "resolvedPointerCount",
        "note",
        # diagnostics
        "fileLoadFailures",
        "objectParseFailures",
        "skippedObjects",
        "dependencyFailures",
        "errorType",
        "phase",
        "reason",
        "serializedByteSize",
        "externalIdentityHash",
        "droppedForbiddenFieldCount",
        "skippedNonCensusObjects",
        "gameObjects",
        "buildSettings",
        "sceneCatalogEntries",
        "customsSceneCandidates",
        # audit report
        "censusSchemaVersion",
        "sourceRootName",
        "families",
        "familyKey",
        "instanceCount",
        "sceneSpread",
        "exampleHierarchyPaths",
        "exampleCount",
        "boundsExtents",
        "totals",
        "familyCount",
        "repeatedFamilyCount",
        "repeatedInstanceCount",
        "singletonFamilyCount",
        "rankedBy",
        "topFamilies",
        "coverage",
        "renderersWithResolvedMesh",
        "renderersWithoutResolvedMesh",
    )
)

_CLONE_SUFFIX = re.compile(r"\s*\((?:clone|\d+)\)\s*$", re.IGNORECASE)
_TRAILING_INDEX = re.compile(r"[ _\-.]\d+$")
_LIGHT_TYPES = {0: "Spot", 1: "Directional", 2: "Point", 3: "Rectangle", 4: "Disc"}


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def normalized_name(value: Any) -> str:
    """Fold instance suffixes so repeated placements share one family name."""
    text = _clean_text(value, limit=256) or ""
    previous: Optional[str] = None
    while previous != text:
        previous = text
        text = _CLONE_SUFFIX.sub("", text).strip()
    text = _TRAILING_INDEX.sub("", text).strip(" _-.")
    return text.casefold()


# `m_Colors` is per-vertex color data on a Mesh but the (allowed) scalar color
# property bag on a Material, so the scrub is type-aware rather than global.
MATERIAL_FORBIDDEN_FIELD_NAMES = FORBIDDEN_FIELD_NAMES - {"m_colors"}


def _forbidden_fields_for(type_name: str) -> frozenset:
    if type_name == "Material":
        return MATERIAL_FORBIDDEN_FIELD_NAMES
    return FORBIDDEN_FIELD_NAMES


def _scrub_payload_fields(
    data: Any, counter: List[int], forbidden: frozenset, depth: int = 0
) -> Any:
    """Drop reusable payload fields as early as possible after parsing."""
    if depth > 12:
        return data
    if isinstance(data, Mapping):
        cleaned: Dict[Any, Any] = {}
        for key, item in data.items():
            if isinstance(key, str) and key.casefold() in forbidden:
                counter[0] += 1
                continue
            cleaned[key] = _scrub_payload_fields(item, counter, forbidden, depth + 1)
        return cleaned
    if isinstance(data, Sequence) and not isinstance(data, (str, bytes, bytearray)):
        return [_scrub_payload_fields(item, counter, forbidden, depth + 1) for item in data]
    return data


def _quaternion(value: Any) -> Optional[Tuple[float, float, float, float]]:
    """None (never a silent identity) when any component failed to parse."""
    fact = _vector_fact(value, ("x", "y", "z", "w"))
    if not fact or len(fact) != 4:
        return None
    return (fact["x"], fact["y"], fact["z"], fact["w"])


def _vector3(value: Any) -> Optional[Tuple[float, float, float]]:
    """None (never a silent zero/one) when any component failed to parse."""
    fact = _vector_fact(value, ("x", "y", "z"))
    if not fact or len(fact) != 3:
        return None
    return (fact["x"], fact["y"], fact["z"])


_MISSING = object()


def _safe_error_type(error: BaseException) -> str:
    """Return a bounded identifier, never an exception message or path."""
    name = type(error).__name__
    cleaned = re.sub(r"[^A-Za-z0-9_]", "_", name)[:80]
    return cleaned or "Error"


def _present_value(container: Any, *names: str) -> Tuple[bool, Any]:
    """Distinguish an explicitly empty Unity field from a missing field."""
    if isinstance(container, Mapping):
        folded = {
            str(key).casefold(): value
            for key, value in container.items()
            if isinstance(key, str)
        }
        for name in names:
            if name in container:
                return True, container[name]
            if name.casefold() in folded:
                return True, folded[name.casefold()]
        return False, None
    for name in names:
        try:
            value = getattr(container, name, _MISSING)
        except Exception:
            continue
        if value is not _MISSING:
            return True, value
    return False, None


def _reader_serialized_byte_size(reader: Any) -> Optional[int]:
    """Read UnityPy's pre-parse serialized size without touching object data."""
    present, value = _present_value(
        reader, "byte_size", "byteSize", "data_size", "dataSize"
    )
    if not present:
        return None
    size = _integer(value)
    if size is None or size <= 0:
        return None
    return size


def _skipped_object(
    *,
    asset: str,
    type_name: str,
    path_id: Optional[int],
    phase: str,
    reason: str,
    serialized_byte_size: Optional[int] = None,
    selection: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    """Safe, name-free identity for an object intentionally not materialized."""
    record = {
        "objectId": _object_id(asset, type_name, path_id),
        "asset": asset,
        "pathId": path_id,
        "type": type_name,
        "phase": phase,
        "reason": reason,
        "serializedByteSize": serialized_byte_size,
    }
    if selection is not None:
        record.update(
            {
                "sourceFile": selection.get("file"),
                "sourceRole": selection.get("role"),
                "sceneIndex": selection.get("sceneIndex"),
            }
        )
    return _drop_none(record)


def _parse_gate(
    reader: Any,
    *,
    asset: str,
    type_name: str,
    path_id: Optional[int],
    phase: str,
    selection: Optional[Mapping[str, Any]] = None,
) -> Tuple[bool, Optional[Dict[str, Any]]]:
    size = _reader_serialized_byte_size(reader)
    if type_name in NEVER_PARSE_TYPES:
        return False, _skipped_object(
            asset=asset,
            type_name=type_name,
            path_id=path_id,
            phase=phase,
            reason="payload-bearing-type-not-parsed",
            serialized_byte_size=size,
            selection=selection,
        )
    if size is None:
        return False, _skipped_object(
            asset=asset,
            type_name=type_name,
            path_id=path_id,
            phase=phase,
            reason="serialized-object-size-unavailable",
            selection=selection,
        )
    if size > MAX_PARSED_OBJECT_BYTES:
        return False, _skipped_object(
            asset=asset,
            type_name=type_name,
            path_id=path_id,
            phase=phase,
            reason="serialized-object-too-large",
            serialized_byte_size=size,
            selection=selection,
        )
    return True, None


def _normalized_file_identity(value: Any) -> Optional[str]:
    text = _clean_text(value, limit=1024)
    if not text:
        return None
    text = text.replace("\\", "/")
    if text.startswith("/") or re.match(r"^[A-Za-z]:", text) or ":/" in text:
        return None
    normalized = posixpath.normpath(text)
    if normalized in ("", ".", "..") or normalized.startswith("../"):
        return None
    return normalized.casefold()


def _external_identities(
    readers: Sequence[Any], own_file: str
) -> Tuple[Optional[List[Dict[str, Any]]], Optional[str]]:
    """Return ordered, owner-relative external identities; never global basenames."""
    assets_files: List[Any] = []
    seen_assets_files: set[int] = set()
    for reader in readers:
        present, candidate = _present_value(reader, "assets_file", "assetsfile")
        if present and candidate is not None:
            identity = id(candidate)
            if identity not in seen_assets_files:
                seen_assets_files.add(identity)
                assets_files.append(candidate)
    if not assets_files:
        return None, "external-table-container-missing"

    owner_parent = posixpath.dirname(own_file.replace("\\", "/"))
    discovered_tables: List[List[Dict[str, Any]]] = []
    for assets_file in assets_files:
        present, raw_entries = _present_value(
            assets_file, "externals", "m_Externals"
        )
        if not present:
            return None, "external-table-missing"
        identities: List[Dict[str, Any]] = []
        for entry in _sequence(raw_entries):
            raw = _value(entry, "path", "name", "file_name")
            if raw is None and isinstance(entry, str):
                raw = entry
            raw_text = _clean_text(raw, limit=1024)
            normalized = None
            if raw_text:
                joined = posixpath.join(owner_parent, raw_text.replace("\\", "/"))
                normalized = _normalized_file_identity(joined)
            identity_material = {
                "normalizedPath": normalized,
                "guid": _clean_text(_value(entry, "guid", "GUID"), limit=128),
                "type": _integer(_value(entry, "type", "fileType")),
            }
            identities.append(
                {
                    "normalizedPath": normalized,
                    "identityHash": _sha256_text(
                        json.dumps(identity_material, allow_nan=False, sort_keys=True)
                    ),
                }
            )
        discovered_tables.append(identities)
    first = discovered_tables[0]
    if any(table != first for table in discovered_tables[1:]):
        return None, "external-table-inconsistent"
    return first, None


def _make_resolver(
    externals: Mapping[str, List[Dict[str, Any]]],
    file_by_identity: Mapping[str, str],
    dependency_failures: List[Dict[str, Any]],
):
    """Map a Unity {fileId, pathId} onto an authorized file without widening scope.

    Returns ``(key, kind)`` where kind is ``null`` (an empty slot, not a
    reference at all), ``internal`` (same authorized file), ``authorized`` (a
    sibling already inside the Customs selection, reached through the external-
    reference table) or ``external`` (outside the selection, never opened).

    Without this, nothing resolves on real data: Unity keeps the scene graph in
    `levelN` and the Mesh/Material/Texture2D objects in `sharedassetsN.assets`,
    so every renderer pointer carries a non-zero fileId.
    """

    def resolve(own_file: str, pointer: Any) -> Tuple[Optional[Tuple[str, int]], str]:
        if not isinstance(pointer, Mapping):
            return None, "null"
        path_id = _integer(pointer.get("pathId"))
        if path_id is None or path_id == 0:
            return None, "null"
        file_id = _integer(pointer.get("fileId")) or 0
        if file_id == 0:
            return (own_file, path_id), "internal"
        identities = externals.get(own_file)
        if identities is None:
            dependency_failures.append(
                {
                    "file": own_file,
                    "phase": "dependency",
                    "reason": "external-table-unavailable",
                    "fileId": file_id,
                    "pathId": path_id,
                }
            )
            return None, "external"
        if not (1 <= file_id <= len(identities)):
            dependency_failures.append(
                {
                    "file": own_file,
                    "phase": "dependency",
                    "reason": "external-index-out-of-range",
                    "fileId": file_id,
                    "pathId": path_id,
                }
            )
            return None, "external"
        identity = identities[file_id - 1]
        normalized = identity.get("normalizedPath")
        if normalized is None:
            dependency_failures.append(
                {
                    "file": own_file,
                    "phase": "dependency",
                    "reason": "invalid-external-identity",
                    "fileId": file_id,
                    "pathId": path_id,
                    "externalIdentityHash": identity.get("identityHash"),
                }
            )
            return None, "external"
        target = file_by_identity.get(normalized)
        if target is not None:
            return (target, path_id), "authorized"
        dependency_failures.append(
            {
                "file": own_file,
                "phase": "dependency",
                "reason": "external-dependency-denied",
                "fileId": file_id,
                "pathId": path_id,
                "externalIdentityHash": identity.get("identityHash"),
            }
        )
        return None, "external"

    return resolve


def _record_sort_key(item: Mapping[str, Any]) -> Tuple[str, int]:
    """`pathId` is explicitly nullable, so it must never reach a tuple compare."""
    path_id = item.get("pathId")
    return (
        str(item.get("asset", "")).casefold(),
        path_id if isinstance(path_id, int) and not isinstance(path_id, bool) else -1,
    )


def _sorted_records(records: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return sorted(records, key=_record_sort_key)


def _bounded_hierarchy_path(path: str) -> str:
    """Keep the most specific tail; the hash always covers the full path."""
    if len(path) <= MAX_HIERARCHY_PATH:
        return path
    return "…/" + path[-(MAX_HIERARCHY_PATH - 2):]


def _quaternion_multiply(left, right):
    lx, ly, lz, lw = left
    rx, ry, rz, rw = right
    return (
        lw * rx + lx * rw + ly * rz - lz * ry,
        lw * ry - lx * rz + ly * rw + lz * rx,
        lw * rz + lx * ry - ly * rx + lz * rw,
        lw * rw - lx * rx - ly * ry - lz * rz,
    )


def _quaternion_rotate(quaternion, vector):
    qx, qy, qz, qw = quaternion
    vx, vy, vz = vector
    tx = 2.0 * (qy * vz - qz * vy)
    ty = 2.0 * (qz * vx - qx * vz)
    tz = 2.0 * (qx * vy - qy * vx)
    return (
        vx + qw * tx + (qy * tz - qz * ty),
        vy + qw * ty + (qz * tx - qx * tz),
        vz + qw * tz + (qx * ty - qy * tx),
    )


def _is_uniform(scale: Tuple[float, float, float]) -> bool:
    """Relative comparison: (1e-7, 5e-7, 9e-7) is not a uniform scale."""
    magnitude = max(abs(component) for component in scale)
    if magnitude == 0.0:
        return True
    tolerance = 1e-6 * magnitude
    return (
        abs(scale[0] - scale[1]) <= tolerance and abs(scale[1] - scale[2]) <= tolerance
    )


# --------------------------------------------------------------------------
# object parsers
# --------------------------------------------------------------------------


def _identity(asset: str, type_name: str, path_id: Optional[int], name: Any) -> Dict[str, Any]:
    text = _clean_text(name) or ""
    normalized = normalized_name(text)
    return {
        "objectId": _object_id(asset, type_name, path_id),
        "asset": asset,
        "pathId": path_id,
        "type": type_name,
        "name": text,
        "normalizedName": normalized,
        "nameHash": _sha256_text(normalized),
    }


def _parse_game_object(data: Any, *, asset: str, path_id: Optional[int]) -> Dict[str, Any]:
    components = _sequence(_value(data, "m_Component", "components"))
    component_pointers: List[Dict[str, int]] = []
    for entry in components:
        pointer = _pointer_fact(
            _value(entry, "component", "second") if isinstance(entry, Mapping) else entry
        )
        if pointer is None:
            pointer = _pointer_fact(entry)
        if pointer is not None:
            component_pointers.append(pointer)
    record = _identity(asset, "GameObject", path_id, _value(data, "m_Name", "name"))
    record.update(
        _drop_none(
            {
                "active": _boolean(_value(data, "m_IsActive", "isActive")),
                "layer": _integer(_value(data, "m_Layer", "layer")),
                "tag": _clean_text(_value(data, "m_TagString", "tag")),
                "componentCount": len(components),
                "componentPathIds": sorted(
                    pointer["pathId"]
                    for pointer in component_pointers
                    if pointer.get("fileId") == 0
                )[:MAX_SCALAR_LIST]
                or None,
            }
        )
    )
    return record


def _parse_transform(
    data: Any, *, asset: str, path_id: Optional[int], type_name: str
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
            "type": type_name,
            "gameObject": _pointer_fact(_value(data, "m_GameObject", "gameObject")),
            "parentGameObjectPathId": None,
            "transform": transform or None,
            # kept out of the emitted JSON; used only to walk the hierarchy
            "_parent": _pointer_fact(_value(data, "m_Father", "father", "parent")),
        }
    )


def _parse_renderer(
    data: Any, *, asset: str, path_id: Optional[int], type_name: str
) -> Dict[str, Any]:
    materials = [
        pointer
        for pointer in (
            _pointer_fact(item)
            for item in _sequence(_value(data, "m_Materials", "materials"))
        )
        if pointer is not None
    ]
    record = _identity(asset, type_name, path_id, _value(data, "m_Name", "name"))
    record.update(
        _drop_none(
            {
                "gameObject": _pointer_fact(_value(data, "m_GameObject", "gameObject")),
                "enabled": _boolean(_value(data, "m_Enabled", "enabled")),
                "castShadows": _integer(_value(data, "m_CastShadows", "castShadows")),
                "receiveShadows": _integer(
                    _value(data, "m_ReceiveShadows", "receiveShadows")
                ),
                "motionVectors": _integer(
                    _value(data, "m_MotionVectors", "motionVectors")
                ),
                "staticBatch": _static_batch_fact(
                    _value(data, "m_StaticBatchInfo", "staticBatchInfo")
                ),
                "materialSlotCount": len(materials),
                "_materialSlots": materials or None,
                "mesh": _pointer_fact(_value(data, "m_Mesh", "mesh")),
            }
        )
    )
    return record


def _static_batch_fact(value: Any) -> Optional[bool]:
    """True only when the renderer actually participates in a static batch."""
    if value is None:
        return None
    count = _integer(_value(value, "subMeshCount", "m_SubMeshCount"))
    if count is None:
        return None
    return count > 0


def _parse_mesh_filter(data: Any, *, asset: str, path_id: Optional[int]) -> Dict[str, Any]:
    return _drop_none(
        {
            "objectId": _object_id(asset, "MeshFilter", path_id),
            "asset": asset,
            "pathId": path_id,
            "gameObject": _pointer_fact(_value(data, "m_GameObject", "gameObject")),
            "mesh": _pointer_fact(_value(data, "m_Mesh", "mesh")),
        }
    )


def _material_properties(data: Any) -> Dict[str, Any]:
    saved = _value(data, "m_SavedProperties", "savedProperties")
    scalars: List[Dict[str, Any]] = []
    colors: List[Dict[str, Any]] = []
    textures: List[Dict[str, Any]] = []
    truncated = False

    def _property_pairs(container: Any) -> List[Tuple[str, Any]]:
        pairs: List[Tuple[str, Any]] = []
        entries = _sequence(container)
        if entries:
            for entry in entries:
                key = _value(entry, "first", "name", "key")
                if isinstance(key, Mapping):
                    key = _value(key, "name", "Name")
                name = _clean_text(key, limit=64)
                if name:
                    pairs.append((name, _value(entry, "second", "value")))
            return pairs
        if isinstance(container, Mapping):
            for key, item in container.items():
                name = _clean_text(key, limit=64)
                if name:
                    pairs.append((name, item))
        return pairs

    for name, value in sorted(
        _property_pairs(_value(saved, "m_Floats", "floats")), key=lambda item: item[0]
    ):
        number = _number(value)
        if number is not None:
            scalars.append({"name": name, "value": number})
    for name, value in sorted(
        _property_pairs(_value(saved, "m_Ints", "ints")), key=lambda item: item[0]
    ):
        integer = _integer(value)
        if integer is not None:
            scalars.append({"name": name, "value": integer})
    for name, value in sorted(
        _property_pairs(_value(saved, "m_Colors", "colors")), key=lambda item: item[0]
    ):
        components = _vector_fact(value, ("r", "g", "b", "a"))
        if components:
            colors.append({"name": name, **components})
    for name, value in sorted(
        _property_pairs(_value(saved, "m_TexEnvs", "texEnvs")), key=lambda item: item[0]
    ):
        pointer = _pointer_fact(_value(value, "m_Texture", "texture"))
        entry = _drop_none(
            {
                "name": name,
                "texture": pointer,
                "scale": _vector_fact(_value(value, "m_Scale", "scale"), ("x", "y")),
                "offset": _vector_fact(_value(value, "m_Offset", "offset"), ("x", "y")),
            }
        )
        if len(entry) > 1:
            textures.append(entry)

    for bucket in (scalars, colors, textures):
        if len(bucket) > MAX_MATERIAL_PROPERTIES:
            truncated = True
            del bucket[MAX_MATERIAL_PROPERTIES:]
    return {
        "scalarProperties": scalars or None,
        "colorProperties": colors or None,
        "textureProperties": textures or None,
        "propertiesTruncated": truncated or None,
    }


def _parse_material(data: Any, *, asset: str, path_id: Optional[int]) -> Dict[str, Any]:
    record = _identity(asset, "Material", path_id, _value(data, "m_Name", "name"))
    record.update(_drop_none(_material_properties(data)))
    return record


def _parse_lod_group(data: Any, *, asset: str, path_id: Optional[int]) -> Dict[str, Any]:
    levels: List[Dict[str, Any]] = []
    for index, lod in enumerate(_sequence(_value(data, "m_LODs", "lods"))):
        renderers = _sequence(_value(lod, "renderers", "m_Renderers"))
        renderer_path_ids: List[int] = []
        for entry in renderers:
            pointer = _pointer_fact(_value(entry, "renderer", "m_Renderer")) or _pointer_fact(
                entry
            )
            if pointer is not None and pointer.get("fileId") == 0:
                renderer_path_ids.append(pointer["pathId"])
        levels.append(
            _drop_none(
                {
                    "level": index,
                    "screenRelativeTransitionHeight": _number(
                        _value(
                            lod,
                            "screenRelativeTransitionHeight",
                            "m_ScreenRelativeTransitionHeight",
                        )
                    ),
                    "fadeTransitionWidth": _number(
                        _value(lod, "fadeTransitionWidth", "m_FadeTransitionWidth")
                    ),
                    "rendererCount": len(renderers),
                    "rendererPathIds": sorted(renderer_path_ids)[:MAX_SCALAR_LIST] or None,
                }
            )
        )
    return _drop_none(
        {
            "objectId": _object_id(asset, "LODGroup", path_id),
            "asset": asset,
            "pathId": path_id,
            "gameObject": _pointer_fact(_value(data, "m_GameObject", "gameObject")),
            "enabled": _boolean(_value(data, "m_Enabled", "enabled")),
            "lodCount": len(levels),
            "levels": levels or None,
        }
    )


def _parse_light(data: Any, *, asset: str, path_id: Optional[int]) -> Dict[str, Any]:
    type_value = _integer(_value(data, "m_Type", "type"))
    return _drop_none(
        {
            "objectId": _object_id(asset, "Light", path_id),
            "asset": asset,
            "pathId": path_id,
            "gameObject": _pointer_fact(_value(data, "m_GameObject", "gameObject")),
            "enabled": _boolean(_value(data, "m_Enabled", "enabled")),
            "lightType": _LIGHT_TYPES.get(type_value) if type_value is not None else None,
            "color": _vector_fact(_value(data, "m_Color", "color"), ("r", "g", "b", "a")),
            "range": _number(_value(data, "m_Range", "range")),
            "intensity": _number(_value(data, "m_Intensity", "intensity")),
        }
    )


def _parse_prefab_instance(data: Any, *, asset: str, path_id: Optional[int]) -> Dict[str, Any]:
    source = _value(data, "m_SourcePrefab", "sourcePrefab", "m_ParentPrefab")
    name = _clean_text(_value(data, "m_Name", "name")) or ""
    normalized = normalized_name(name)
    return _drop_none(
        {
            "objectId": _object_id(asset, "PrefabInstance", path_id),
            "asset": asset,
            "pathId": path_id,
            "prefabName": name or None,
            "normalizedName": normalized or None,
            "nameHash": _sha256_text(normalized) if normalized else None,
            "prefabSource": _pointer_fact(source),
        }
    )


# --------------------------------------------------------------------------
# linking
# --------------------------------------------------------------------------


def _hierarchy(
    key: Tuple[str, int],
    game_objects: Dict[Tuple[str, int], Dict[str, Any]],
    transform_by_game_object: Dict[Tuple[str, int], Dict[str, Any]],
    transforms: Dict[Tuple[str, int], Dict[str, Any]],
    active: Optional[frozenset] = None,
) -> Tuple[str, bool, Optional[int], List[Dict[str, Any]]]:
    """Return (path, complete, parentPathId, ancestor transform chain root-first)."""
    active = frozenset() if active is None else active
    game_object = game_objects.get(key)
    if game_object is None:
        return "", False, None, []
    name = (game_object.get("name") or f"<unnamed:{key[1]}>").replace("/", "∕")
    transform = transform_by_game_object.get(key)
    if transform is None:
        return name, False, None, []
    parent_key = _pointer_key(key[0], transform.get("_parent"))
    if parent_key is None:
        pointer = transform.get("_parent")
        complete = pointer is None or pointer.get("pathId") == 0
        return name, complete, None, [transform]
    parent_transform = transforms.get(parent_key)
    if parent_transform is None:
        return name, False, None, [transform]
    parent_game_key = _pointer_key(key[0], parent_transform.get("gameObject"))
    if parent_game_key is None:
        return name, False, None, [transform]
    # A malformed file can point transforms at each other.  The guard must test
    # the game-object key we are about to recurse into, not the transform key.
    if parent_game_key in active or len(active) >= MAX_HIERARCHY_DEPTH:
        return name, False, None, [transform]
    parent_path, complete, _, chain = _hierarchy(
        parent_game_key,
        game_objects,
        transform_by_game_object,
        transforms,
        active | {key},
    )
    path = f"{parent_path}/{name}" if parent_path else name
    return path, complete, parent_game_key[1], chain + [transform]


def _world_transform(chain: Seq[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    position = (0.0, 0.0, 0.0)
    rotation = (0.0, 0.0, 0.0, 1.0)
    scale = (1.0, 1.0, 1.0)
    exact = True
    for record in chain:
        transform = record.get("transform") or {}
        parsed_position = _vector3(transform.get("localPosition"))
        parsed_rotation = _quaternion(transform.get("localRotation"))
        parsed_scale = _vector3(transform.get("localScale"))
        if parsed_position is None or parsed_rotation is None or parsed_scale is None:
            # A component failed to parse (NaN/Inf/missing).  Substituting an
            # identity here would silently teleport the object to its parent, so
            # the composed transform is reported as inexact instead.
            exact = False
        local_position = parsed_position or (0.0, 0.0, 0.0)
        local_rotation = parsed_rotation or (0.0, 0.0, 0.0, 1.0)
        local_scale = parsed_scale or (1.0, 1.0, 1.0)
        scaled = (
            local_position[0] * scale[0],
            local_position[1] * scale[1],
            local_position[2] * scale[2],
        )
        rotated = _quaternion_rotate(rotation, scaled)
        position = (
            position[0] + rotated[0],
            position[1] + rotated[1],
            position[2] + rotated[2],
        )
        if not _is_uniform(scale) and any(abs(component) > 1e-6 for component in local_rotation[:3]):
            # Unity's own lossyScale is an approximation in this case too.
            exact = False
        rotation = _quaternion_multiply(rotation, local_rotation)
        scale = (scale[0] * local_scale[0], scale[1] * local_scale[1], scale[2] * local_scale[2])
    return _drop_none(
        {
            "position": _drop_none(
                {
                    "x": _number(position[0]),
                    "y": _number(position[1]),
                    "z": _number(position[2]),
                }
            )
            or None,
            "rotation": _drop_none(
                {
                    "x": _number(rotation[0]),
                    "y": _number(rotation[1]),
                    "z": _number(rotation[2]),
                    "w": _number(rotation[3]),
                }
            )
            or None,
            "scale": _drop_none(
                {"x": _number(scale[0]), "y": _number(scale[1]), "z": _number(scale[2])}
            )
            or None,
            "worldExact": exact,
        }
    ) or None


def _finalize_game_objects(
    raw_game_objects: Iterable[Dict[str, Any]],
    raw_transforms: Iterable[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], Dict[Tuple[str, int], Dict[str, Any]]]:
    game_objects = {
        (record["asset"], record["pathId"]): record
        for record in raw_game_objects
        if record.get("pathId") is not None
    }
    transforms = {
        (record["asset"], record["pathId"]): record
        for record in raw_transforms
        if record.get("pathId") is not None
    }
    transform_by_game_object: Dict[Tuple[str, int], Dict[str, Any]] = {}
    for record in transforms.values():
        game_key = _pointer_key(record["asset"], record.get("gameObject"))
        if game_key is not None:
            transform_by_game_object.setdefault(game_key, record)

    finalized: List[Dict[str, Any]] = []
    lookup: Dict[Tuple[str, int], Dict[str, Any]] = {}
    for key in sorted(game_objects, key=lambda item: (item[0].casefold(), item[1])):
        record = dict(game_objects[key])
        path, complete, parent_path_id, chain = _hierarchy(
            key, game_objects, transform_by_game_object, transforms
        )
        record["hierarchyPath"] = _bounded_hierarchy_path(path)
        record["hierarchyPathHash"] = _sha256_text(path.casefold())
        record["hierarchyComplete"] = complete
        transform = transform_by_game_object.get(key)
        if transform is not None:
            record["transformPathId"] = transform.get("pathId")
            if transform.get("transform"):
                record["transform"] = transform["transform"]
        if parent_path_id is not None:
            record["parentGameObjectPathId"] = parent_path_id
        world = _world_transform(chain) if complete else None
        if world is not None:
            world["worldComplete"] = True
            record["world"] = world
        record = _drop_none(record)
        finalized.append(record)
        lookup[key] = record
    return finalized, lookup


def _named_lookup(records: Iterable[Dict[str, Any]]) -> Dict[Tuple[str, int], Dict[str, Any]]:
    return {
        (record["asset"], record["pathId"]): record
        for record in records
        if record.get("pathId") is not None
    }


def _link_renderers(
    renderers: List[Dict[str, Any]],
    mesh_filters: Iterable[Dict[str, Any]],
    meshes: Iterable[Dict[str, Any]],
    materials: Iterable[Dict[str, Any]],
    game_objects: Dict[Tuple[str, int], Dict[str, Any]],
    resolve,
) -> Tuple[List[Dict[str, Any]], Dict[str, int]]:
    mesh_lookup = _named_lookup(meshes)
    material_lookup = _named_lookup(materials)
    filter_by_game_object: Dict[Tuple[str, int], Dict[str, Any]] = {}
    for record in mesh_filters:
        game_key = _pointer_key(record["asset"], record.get("gameObject"))
        if game_key is not None:
            filter_by_game_object.setdefault(game_key, record)

    counts = {"internal": 0, "external": 0, "resolved": 0}

    def _count(kind: str, hit: bool) -> None:
        if kind == "null":
            return
        if kind == "external":
            counts["external"] += 1
            return
        counts["internal"] += 1
        if hit:
            counts["resolved"] += 1

    linked: List[Dict[str, Any]] = []
    for item in renderers:
        record = dict(item)
        own = record["asset"]
        game_key = _pointer_key(own, record.get("gameObject"))
        game_object = game_objects.get(game_key) if game_key else None
        if game_object is not None:
            record["gameObjectId"] = game_object["objectId"]
            record["gameObjectPathId"] = game_object["pathId"]
            record["hierarchyPath"] = game_object.get("hierarchyPath")
            record["hierarchyPathHash"] = game_object.get("hierarchyPathHash")
            if not record.get("name"):
                record["name"] = game_object.get("name") or ""
                record["normalizedName"] = game_object.get("normalizedName") or ""
                record["nameHash"] = _sha256_text(record["normalizedName"])

        mesh_pointer = record.get("mesh")
        mesh_key, mesh_kind = resolve(own, mesh_pointer)
        if mesh_kind == "null" and game_key is not None:
            # A SkinnedMeshRenderer with an empty m_Mesh must not suppress the
            # MeshFilter that actually carries the mesh.
            mesh_filter = filter_by_game_object.get(game_key)
            if mesh_filter is not None:
                mesh_pointer = mesh_filter.get("mesh")
                mesh_key, mesh_kind = resolve(mesh_filter["asset"], mesh_pointer)
                if mesh_pointer is not None:
                    record["mesh"] = mesh_pointer
        mesh = mesh_lookup.get(mesh_key) if mesh_key else None
        _count(mesh_kind, mesh is not None)
        if mesh is not None:
            record["meshId"] = mesh["objectId"]
            record["meshName"] = mesh.get("name")
            for field in ("submeshCount", "vertexCount", "localAabb"):
                if mesh.get(field) is not None:
                    record[field] = mesh[field]

        # Slot-aligned: index i of every list is always material slot i.
        slots = record.pop("_materialSlots", record.get("materials") or [])
        record["materialSlotCount"] = len(slots)
        material_ids: List[Optional[str]] = []
        material_names: List[Optional[str]] = []
        for slot in slots:
            key, kind = resolve(own, slot)
            material = material_lookup.get(key) if key else None
            _count(kind, material is not None)
            material_ids.append(material["objectId"] if material is not None else None)
            material_names.append(material.get("name") if material is not None else None)
        if slots:
            record["materials"] = list(slots)[:MAX_SCALAR_LIST]
            record["materialIds"] = material_ids[:MAX_SCALAR_LIST]
            record["materialNames"] = material_names[:MAX_SCALAR_LIST]
        linked.append(_drop_none(record))

    linked.sort(key=_record_sort_key)
    return linked, {
        "internalPointerCount": counts["internal"],
        "externalPointerCount": counts["external"],
        "resolvedPointerCount": counts["resolved"],
        "unresolvedInternalPointerCount": counts["internal"] - counts["resolved"],
    }


def _link_materials(
    materials: List[Dict[str, Any]], textures: Iterable[Dict[str, Any]], resolve
) -> Tuple[List[Dict[str, Any]], Dict[str, int]]:
    texture_lookup = _named_lookup(textures)
    counts = {"internal": 0, "external": 0, "resolved": 0}
    linked: List[Dict[str, Any]] = []
    for item in materials:
        record = dict(item)
        properties = []
        for entry in record.get("textureProperties") or ():
            resolved = dict(entry)
            pointer = entry.get("texture")
            key, kind = resolve(record["asset"], pointer)
            texture = texture_lookup.get(key) if key else None
            if kind == "external":
                counts["external"] += 1
            elif kind != "null":
                counts["internal"] += 1
                if texture is not None:
                    counts["resolved"] += 1
            if texture is not None:
                resolved["textureId"] = texture["objectId"]
                if texture.get("name"):
                    resolved["textureName"] = texture["name"]
                if texture.get("width") is not None:
                    resolved["textureWidth"] = texture["width"]
                if texture.get("height") is not None:
                    resolved["textureHeight"] = texture["height"]
            elif kind == "external":
                resolved["external"] = True
            properties.append(_drop_none(resolved))
        if properties:
            record["textureProperties"] = properties
        linked.append(record)
    linked.sort(key=_record_sort_key)
    return linked, counts


def _attach_game_object(
    records: List[Dict[str, Any]], game_objects: Dict[Tuple[str, int], Dict[str, Any]]
) -> List[Dict[str, Any]]:
    attached: List[Dict[str, Any]] = []
    for item in records:
        record = dict(item)
        key = _pointer_key(record["asset"], record.get("gameObject"))
        game_object = game_objects.get(key) if key else None
        if game_object is not None:
            record["gameObjectId"] = game_object["objectId"]
            record["gameObjectPathId"] = game_object["pathId"]
            record["hierarchyPath"] = game_object.get("hierarchyPath")
            record["hierarchyPathHash"] = game_object.get("hierarchyPathHash")
            if not record.get("name"):
                record["name"] = game_object.get("name") or ""
                record["normalizedName"] = game_object.get("normalizedName") or ""
        attached.append(_drop_none(record))
    attached.sort(key=_record_sort_key)
    return attached


# --------------------------------------------------------------------------
# guards
# --------------------------------------------------------------------------


def assert_bounded_payload(payload: Any, *, path: str = "$") -> None:
    """Fail closed if an artifact carries an unreviewed key or an array payload."""
    if isinstance(payload, (bytes, bytearray, memoryview)):
        raise CensusError(f"binary payload is never emitted (at {path})")
    if isinstance(payload, Mapping):
        for key, value in payload.items():
            if not isinstance(key, str):
                raise CensusError(f"non-string key at {path}")
            if key not in ALLOWED_OUTPUT_KEYS:
                raise CensusError(f"unapproved output field '{key}' at {path}")
            assert_bounded_payload(value, path=f"{path}.{key}")
        return
    if isinstance(payload, (list, tuple)):
        scalar_items = sum(
            1 for item in payload if isinstance(item, (int, float, str, bool))
        )
        if scalar_items > MAX_SCALAR_LIST:
            raise CensusError(
                f"scalar array of {scalar_items} entries exceeds the census bound at {path}"
            )
        for index, item in enumerate(payload):
            assert_bounded_payload(item, path=f"{path}[{index}]")
        return
    if isinstance(payload, str):
        if len(payload) > 1024:
            raise CensusError(f"string longer than 1024 characters at {path}")
        return
    if isinstance(payload, bool) or payload is None:
        return
    if isinstance(payload, (int, float)):
        if isinstance(payload, float) and not math.isfinite(payload):
            raise CensusError(f"non-finite number at {path}")
        return
    raise CensusError(f"unsupported value type {type(payload).__name__} at {path}")


def _finalize_artifact(payload: Dict[str, Any]) -> Dict[str, Any]:
    assert_bounded_payload(payload)
    json.dumps(payload, allow_nan=False, sort_keys=True)
    return payload


# --------------------------------------------------------------------------
# census
# --------------------------------------------------------------------------


def _stat_identity(value: os.stat_result) -> Tuple[int, int, int, int, int, int]:
    return (
        int(value.st_dev),
        int(value.st_ino),
        int(value.st_mode),
        int(value.st_size),
        int(value.st_mtime_ns),
        int(value.st_ctime_ns),
    )


class _SafeUnityStream(io.BufferedIOBase):
    """Seekable local stream whose Unity-visible identity contains no host path."""

    def __init__(self, path: Path, visible_name: str):
        descriptor: Optional[int] = None
        try:
            flags = (
                os.O_RDONLY
                | getattr(os, "O_BINARY", 0)
                | getattr(os, "O_NOFOLLOW", 0)
            )
            descriptor = os.open(path, flags)
            self._stream = os.fdopen(descriptor, "rb")
            descriptor = None
        finally:
            if descriptor is not None:
                os.close(descriptor)
        self.name = visible_name
        self.path = ""

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def fileno(self) -> int:
        return self._stream.fileno()

    def tell(self) -> int:
        return self._stream.tell()

    def seek(self, offset: int, whence: int = os.SEEK_SET) -> int:
        return self._stream.seek(offset, whence)

    def read(self, size: int = -1) -> bytes:
        return self._stream.read(size)

    def readinto(self, buffer: Any) -> int:
        return self._stream.readinto(buffer)

    def readline(self, size: int = -1) -> bytes:
        return self._stream.readline(size)

    def close(self) -> None:
        if self.closed:
            return
        try:
            super().close()
        finally:
            self._stream.close()

    def __repr__(self) -> str:
        return f"<_SafeUnityStream name={self.name!r}>"


def _safe_visible_name(relative_file: str) -> str:
    name = relative_file.replace("\\", "/").rsplit("/", 1)[-1]
    if not name or name in (".", "..") or not re.fullmatch(r"[A-Za-z0-9._-]+", name):
        return "unity-data"
    return name


def _deny_dependency_loading(*_args: Any, **_kwargs: Any) -> Any:
    raise CensusError("Unity dependency loading is disabled for the bounded census")


def _disable_dependency_loading(environment: Any) -> None:
    """Replace every UnityPy dependency loader before object enumeration/parsing."""
    for method_name in DEPENDENCY_LOADING_METHODS:
        if not hasattr(environment, method_name):
            continue
        try:
            setattr(environment, method_name, _deny_dependency_loading)
        except Exception as error:
            raise CensusError("could not disable Unity dependency loading") from error
        if getattr(environment, method_name, None) is not _deny_dependency_loading:
            raise CensusError("could not verify Unity dependency loading was disabled")


def _open_bound_unity_stream(
    path: Path,
    relative_file: str,
    before_token: Optional[Tuple[Any, ...]],
) -> _SafeUnityStream:
    if before_token is None:
        raise CensusError("source binding is unavailable before Unity load")
    stream = _SafeUnityStream(path, _safe_visible_name(relative_file))
    try:
        identity = _stat_identity(os.fstat(stream.fileno()))
        if identity != before_token[2]:
            raise CensusError("source identity changed before Unity load")
        return stream
    except Exception:
        stream.close()
        raise


def _capture_file_binding(path: Path) -> Tuple[Dict[str, Any], Optional[Tuple[Any, ...]]]:
    """Hash one regular file through a no-follow fd and prove it stayed stable."""
    digest = hashlib.sha256()
    size = 0
    descriptor: Optional[int] = None
    try:
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        path_before = os.stat(path, follow_symlinks=False)
        fd_before = os.fstat(descriptor)
        if not stat.S_ISREG(fd_before.st_mode) or stat.S_ISLNK(path_before.st_mode):
            return {"digestComplete": False, "bindingVerified": False}, None
        if _stat_identity(path_before) != _stat_identity(fd_before):
            return {"digestComplete": False, "bindingVerified": False}, None
        while True:
            chunk = os.read(descriptor, DIGEST_CHUNK_BYTES)
            if not chunk:
                break
            size += len(chunk)
            digest.update(chunk)
        fd_after = os.fstat(descriptor)
        path_after = os.stat(path, follow_symlinks=False)
        identity = _stat_identity(fd_before)
        stable = (
            identity == _stat_identity(fd_after)
            and identity == _stat_identity(path_after)
            and size == fd_after.st_size
        )
        if not stable:
            return {"digestComplete": False, "bindingVerified": False}, None
        sha256 = digest.hexdigest()
        identity_hash = _sha256_text(json.dumps(identity, separators=(",", ":")))
        token = (size, sha256, identity)
        return (
            {
                "byteSize": size,
                "sha256": sha256,
                "digestComplete": True,
                "bindingVerified": True,
                "statIdentityHash": identity_hash,
            },
            token,
        )
    except OSError:
        return {"digestComplete": False, "bindingVerified": False}, None
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _verified_file_fact(
    *,
    file: str,
    role: str,
    before: Tuple[Dict[str, Any], Optional[Tuple[Any, ...]]],
    after: Tuple[Dict[str, Any], Optional[Tuple[Any, ...]]],
    selection: Optional[Mapping[str, Any]] = None,
) -> Tuple[Dict[str, Any], bool]:
    before_fact, before_token = before
    after_fact, after_token = after
    verified = before_token is not None and before_token == after_token
    common = before_fact if verified else {
        "digestComplete": False,
        "bindingVerified": False,
    }
    fact: Dict[str, Any] = {"file": file, "role": role, **common}
    if selection is not None:
        fact.update(
            {
                "sceneIndex": selection.get("sceneIndex"),
                "scenePath": selection.get("scenePath"),
            }
        )
    return _drop_none(fact), verified


def _safe_unity_scene_path(value: Any) -> Optional[str]:
    """Accept project-relative Unity scene paths, never host filesystem paths."""
    path = selector._normalized_scene_path(value)
    if not path:
        return None
    if (
        path.startswith("/")
        or re.match(r"^[A-Za-z]:", path)
        or ":/" in path
        or any(part == ".." for part in path.split("/"))
        or not path.casefold().startswith("assets/")
    ):
        return None
    return path


def load_build_settings_catalog(
    source_root: Path,
    catalog_files: Sequence[Path],
    unitypy_module: Any,
) -> Dict[str, Any]:
    """Load only size-gated BuildSettings, bound to before/after file facts."""
    build_settings: List[Dict[str, Any]] = []
    scene_catalog: List[Dict[str, Any]] = []
    file_failures: List[Dict[str, Any]] = []
    parse_failures: List[Dict[str, Any]] = []
    skipped_objects: List[Dict[str, Any]] = []
    catalog_file_facts: List[Dict[str, Any]] = []
    loaded_files = 0
    skipped_non_catalog = 0

    for candidate in catalog_files:
        relative_file = candidate.relative_to(source_root).as_posix()
        before = _capture_file_binding(candidate)
        if before[1] is None:
            file_failures.append(
                {
                    "file": relative_file,
                    "phase": "catalog-binding",
                    "reason": "source-binding-before-failed",
                }
            )
            fact, _ = _verified_file_fact(
                file=relative_file,
                role="catalog",
                before=before,
                after=before,
            )
            catalog_file_facts.append(fact)
            continue
        stream: Optional[_SafeUnityStream] = None
        try:
            stream = _open_bound_unity_stream(
                candidate, relative_file, before[1]
            )
            environment = unitypy_module.load(stream)
            _disable_dependency_loading(environment)
        except Exception as error:
            if stream is not None:
                stream.close()
            file_failures.append(
                {
                    "file": relative_file,
                    "phase": "catalog",
                    "errorType": _safe_error_type(error),
                }
            )
            after = _capture_file_binding(candidate)
            fact, _ = _verified_file_fact(
                file=relative_file,
                role="catalog",
                before=before,
                after=after,
            )
            catalog_file_facts.append(fact)
            continue

        local_settings: List[Dict[str, Any]] = []
        local_scenes: List[Dict[str, Any]] = []
        for reader in environment.objects:
            type_name = _reader_type_name(reader)
            if type_name != "BuildSettings":
                skipped_non_catalog += 1
                continue
            path_id = _reader_path_id(reader)
            allowed, skipped = _parse_gate(
                reader,
                asset=relative_file,
                type_name=type_name,
                path_id=path_id,
                phase="catalog",
            )
            if not allowed:
                assert skipped is not None
                skipped_objects.append(skipped)
                continue
            try:
                data = reader.parse_as_dict()
                record, scenes = selector._parse_build_settings(
                    data, asset=relative_file, path_id=path_id
                )
                for scene in scenes:
                    safe_path = _safe_unity_scene_path(scene.get("path"))
                    if safe_path is None:
                        raise CensusError("BuildSettings contains an unsafe scene path")
                    scene["path"] = safe_path
                record["sourceFile"] = relative_file
                local_settings.append(record)
                for scene in scenes:
                    scene["catalogObjectId"] = record["objectId"]
                    local_scenes.append(scene)
                del data
            except Exception as error:
                parse_failures.append(
                    _drop_none(
                        {
                            "asset": relative_file,
                            "pathId": path_id,
                            "type": type_name,
                            "phase": "catalog",
                            "errorType": _safe_error_type(error),
                        }
                    )
                )

        stream.close()
        after = _capture_file_binding(candidate)
        fact, verified = _verified_file_fact(
            file=relative_file,
            role="catalog",
            before=before,
            after=after,
        )
        catalog_file_facts.append(fact)
        if not verified:
            file_failures.append(
                {
                    "file": relative_file,
                    "phase": "catalog-binding",
                    "reason": "source-changed-during-read",
                }
            )
            continue
        loaded_files += 1
        build_settings.extend(local_settings)
        scene_catalog.extend(local_scenes)

    scene_catalog_by_key: Dict[Tuple[int, str], Dict[str, Any]] = {}
    for record in scene_catalog:
        scene_catalog_by_key[(record["index"], record["path"])] = record
    scene_catalog = sorted(
        scene_catalog_by_key.values(),
        key=lambda item: (item["index"], item["path"].casefold()),
    )
    build_settings = _unique_records(build_settings)
    build_settings.sort(key=_record_sort_key)
    file_failures.sort(
        key=lambda item: (item["file"].casefold(), item.get("phase", ""))
    )
    parse_failures.sort(
        key=lambda item: (
            item["asset"].casefold(),
            item.get("type", ""),
            item.get("pathId", -1),
        )
    )
    skipped_objects.sort(
        key=lambda item: (
            item["asset"].casefold(),
            item.get("type", ""),
            item.get("pathId", -1),
        )
    )
    complete = (
        not file_failures
        and not parse_failures
        and not skipped_objects
        and all(
            fact.get("digestComplete") and fact.get("bindingVerified")
            for fact in catalog_file_facts
        )
    )
    return {
        "buildSettings": build_settings,
        "sceneCatalog": scene_catalog,
        "catalogFiles": [
            path.relative_to(source_root).as_posix() for path in catalog_files
        ],
        "catalogFileFacts": catalog_file_facts,
        "loadedFileCount": loaded_files,
        "skippedNonCatalogObjects": skipped_non_catalog,
        "fileLoadFailures": file_failures,
        "objectParseFailures": parse_failures,
        "skippedObjects": skipped_objects,
        "complete": complete,
    }


def _with_scene_association(record: Dict[str, Any], selection: Dict[str, Any]) -> Dict[str, Any]:
    record.update(
        {
            "sourceFile": selection["file"],
            "sourceRole": selection["role"],
            "sceneIndex": selection["sceneIndex"],
            "scenePath": selection["scenePath"],
        }
    )
    return record


def build_census(
    source_root: Path,
    catalog: Dict[str, Any],
    scene_files: Seq[Dict[str, Any]],
    unitypy_module: Any,
) -> Dict[str, Any]:
    raw_game_objects: List[Dict[str, Any]] = []
    raw_transforms: List[Dict[str, Any]] = []
    mesh_filters: List[Dict[str, Any]] = []
    renderers: List[Dict[str, Any]] = []
    meshes: List[Dict[str, Any]] = []
    materials: List[Dict[str, Any]] = []
    textures: List[Dict[str, Any]] = []
    lod_groups: List[Dict[str, Any]] = []
    lights: List[Dict[str, Any]] = []
    prefab_instances: List[Dict[str, Any]] = []
    file_failures: List[Dict[str, Any]] = list(catalog["fileLoadFailures"])
    parse_failures: List[Dict[str, Any]] = list(catalog["objectParseFailures"])
    skipped_objects: List[Dict[str, Any]] = list(catalog.get("skippedObjects") or ())
    dependency_failures: List[Dict[str, Any]] = []
    dropped = [0]
    skipped = 0  # scene objects only; the catalog phase reports its own
    loaded_scene_files = 0
    scene_file_facts: List[Dict[str, Any]] = []

    before_bindings = {
        selection["file"]: _capture_file_binding(selection["path"])
        for selection in scene_files
    }
    externals: Dict[str, List[Dict[str, Any]]] = {}
    file_by_identity: Dict[str, str] = {}
    for selection in scene_files:
        identity = _normalized_file_identity(selection["file"])
        if identity is None or identity in file_by_identity:
            raise CensusError("selected scene files do not have unique normalized identities")
        file_by_identity[identity] = selection["file"]
    resolve = _make_resolver(externals, file_by_identity, dependency_failures)

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
        stream: Optional[_SafeUnityStream] = None
        try:
            stream = _open_bound_unity_stream(
                candidate, selection["file"], before[1]
            )
            environment = unitypy_module.load(stream)
            _disable_dependency_loading(environment)
        except Exception as error:  # Unity formats fail in version-specific ways.
            if stream is not None:
                stream.close()
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
        readers = list(environment.objects)
        external_identities, external_error = _external_identities(
            readers, selection["file"]
        )
        if external_identities is None:
            dependency_failures.append(
                {
                    "file": selection["file"],
                    "phase": "dependency",
                    "reason": external_error or "external-table-unavailable",
                }
            )
        else:
            externals[selection["file"]] = external_identities

        local_game_objects: List[Dict[str, Any]] = []
        local_transforms: List[Dict[str, Any]] = []
        local_mesh_filters: List[Dict[str, Any]] = []
        local_renderers: List[Dict[str, Any]] = []
        local_materials: List[Dict[str, Any]] = []
        local_lod_groups: List[Dict[str, Any]] = []
        local_lights: List[Dict[str, Any]] = []
        local_prefab_instances: List[Dict[str, Any]] = []
        for reader in readers:
            type_name = _reader_type_name(reader)
            if type_name not in CENSUS_OBJECT_TYPES:
                skipped += 1
                continue
            path_id = _reader_path_id(reader)
            asset = selection["file"]
            allowed, skipped_record = _parse_gate(
                reader,
                asset=asset,
                type_name=type_name,
                path_id=path_id,
                phase="scene",
                selection=selection,
            )
            if not allowed:
                assert skipped_record is not None
                skipped_objects.append(skipped_record)
                continue
            try:
                data = _scrub_payload_fields(
                    reader.parse_as_dict(), dropped, _forbidden_fields_for(type_name)
                )
                if type_name == "GameObject":
                    local_game_objects.append(
                        _with_scene_association(
                            _parse_game_object(data, asset=asset, path_id=path_id), selection
                        )
                    )
                elif type_name in TRANSFORM_TYPES:
                    local_transforms.append(
                        _parse_transform(
                            data, asset=asset, path_id=path_id, type_name=type_name
                        )
                    )
                elif type_name == "MeshFilter":
                    local_mesh_filters.append(
                        _parse_mesh_filter(data, asset=asset, path_id=path_id)
                    )
                elif type_name in RENDERER_TYPES:
                    local_renderers.append(
                        _with_scene_association(
                            _parse_renderer(
                                data, asset=asset, path_id=path_id, type_name=type_name
                            ),
                            selection,
                        )
                    )
                elif type_name == "Material":
                    local_materials.append(
                        _with_scene_association(
                            _parse_material(data, asset=asset, path_id=path_id), selection
                        )
                    )
                elif type_name == "LODGroup":
                    local_lod_groups.append(
                        _with_scene_association(
                            _parse_lod_group(data, asset=asset, path_id=path_id), selection
                        )
                    )
                elif type_name == "Light":
                    local_lights.append(
                        _with_scene_association(
                            _parse_light(data, asset=asset, path_id=path_id), selection
                        )
                    )
                elif type_name == "PrefabInstance":
                    local_prefab_instances.append(
                        _with_scene_association(
                            _parse_prefab_instance(data, asset=asset, path_id=path_id),
                            selection,
                        )
                    )
                del data
            except Exception as error:
                parse_failures.append(
                    _drop_none(
                        {
                            "asset": asset,
                            "pathId": path_id,
                            "type": type_name,
                            "phase": "scene",
                            "sceneIndex": selection["sceneIndex"],
                            "errorType": _safe_error_type(error),
                        }
                    )
                )

        stream.close()
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
            externals.pop(selection["file"], None)
            continue
        loaded_scene_files += 1
        raw_game_objects.extend(local_game_objects)
        raw_transforms.extend(local_transforms)
        mesh_filters.extend(local_mesh_filters)
        renderers.extend(local_renderers)
        materials.extend(local_materials)
        lod_groups.extend(local_lod_groups)
        lights.extend(local_lights)
        prefab_instances.extend(local_prefab_instances)

    game_objects, game_object_lookup = _finalize_game_objects(
        _unique_records(raw_game_objects), _unique_records(raw_transforms)
    )
    meshes = sorted(
        _unique_records(meshes),
        key=_record_sort_key,
    )
    textures = sorted(
        _unique_records(textures),
        key=_record_sort_key,
    )
    materials, material_counts = _link_materials(
        _unique_records(materials), textures, resolve
    )
    renderers, reference_counts = _link_renderers(
        _unique_records(renderers),
        _unique_records(mesh_filters),
        meshes,
        materials,
        game_object_lookup,
        resolve,
    )
    reference_counts["internalPointerCount"] += material_counts["internal"]
    reference_counts["externalPointerCount"] += material_counts["external"]
    reference_counts["resolvedPointerCount"] += material_counts["resolved"]
    reference_counts["unresolvedInternalPointerCount"] += (
        material_counts["internal"] - material_counts["resolved"]
    )
    lod_groups = _attach_game_object(_unique_records(lod_groups), game_object_lookup)
    lights = _attach_game_object(_unique_records(lights), game_object_lookup)
    prefab_instances = sorted(
        _unique_records(prefab_instances),
        key=_record_sort_key,
    )

    file_failures.sort(key=lambda item: (item["file"].casefold(), item.get("phase", "")))
    parse_failures.sort(
        key=lambda item: (item["asset"].casefold(), item.get("type", ""), item.get("pathId", -1))
    )
    skipped_objects.sort(
        key=lambda item: (
            item["asset"].casefold(),
            item.get("type", ""),
            item.get("pathId", -1),
            item.get("reason", ""),
        )
    )
    dependency_by_key: Dict[Tuple[Any, ...], Dict[str, Any]] = {}
    for item in dependency_failures:
        key = (
            item.get("file"),
            item.get("reason"),
            item.get("fileId"),
            item.get("pathId"),
            item.get("externalIdentityHash"),
        )
        dependency_by_key.setdefault(key, item)
    dependency_failures = sorted(
        dependency_by_key.values(),
        key=lambda item: (
            item.get("file", "").casefold(),
            item.get("reason", ""),
            item.get("fileId", -1),
            item.get("pathId", -1),
        ),
    )
    scene_file_facts.sort(
        key=lambda item: (
            item.get("sceneIndex", -1),
            0 if item.get("role") == "level" else 1,
            item.get("file", "").casefold(),
        )
    )
    complete = (
        bool(catalog.get("complete"))
        and not file_failures
        and not parse_failures
        and not skipped_objects
        and not dependency_failures
        and all(
            entry.get("digestComplete") and entry.get("bindingVerified")
            for entry in scene_file_facts
        )
    )

    census = {
        "schemaVersion": CENSUS_SCHEMA_VERSION,
        "generator": {
            "name": GENERATOR_NAME,
            "unityPyVersion": _clean_text(
                getattr(unitypy_module, "__version__", "unknown"), limit=80
            ),
            "selectionMode": "catalog-first-customs-only",
        },
        "source": {
            "rootName": _clean_text(source_root.name) or "game-data",
            "catalogFiles": list(catalog["catalogFiles"]),
            "catalogFileFacts": list(catalog.get("catalogFileFacts") or ()),
            "catalogFileCount": len(catalog["catalogFiles"]),
            "sceneFiles": scene_file_facts,
            "sceneFileCount": len(scene_file_facts),
            "loadedCatalogFileCount": catalog["loadedFileCount"],
            "loadedSceneFileCount": loaded_scene_files,
            "loadedFileCount": catalog["loadedFileCount"] + loaded_scene_files,
        },
        "sceneIndices": sorted({selection["sceneIndex"] for selection in scene_files})[
            :MAX_SCALAR_LIST
        ],
        "complete": complete,
        "counts": {
            "buildSettings": len(catalog["buildSettings"]),
            "sceneCatalogEntries": len(catalog["sceneCatalog"]),
            "customsSceneCandidates": sum(
                1 for record in catalog["sceneCatalog"] if record["isCustomsCandidate"]
            ),
            "gameObjects": len(game_objects),
            "renderers": len(renderers),
            "meshes": len(meshes),
            "materials": len(materials),
            "textures": len(textures),
            "lodGroups": len(lod_groups),
            "lights": len(lights),
            "prefabInstances": len(prefab_instances),
            "skippedNonCensusObjects": skipped,
            "skippedObjects": len(skipped_objects),
        },
        "gameObjects": game_objects,
        "renderers": renderers,
        "meshes": meshes,
        "materials": materials,
        "textures": textures,
        "lodGroups": lod_groups,
        "lights": lights,
        "prefabInstances": prefab_instances,
        "references": {
            **reference_counts,
            "note": (
                "Covers renderer mesh/material and material texture pointers. A "
                "non-zero fileId is resolved only through an exact normalized, "
                "owner-relative external identity that names another authorized "
                "Customs file. Every denied or malformed dependency is ledgered "
                "and makes the artifact incomplete."
            ),
        },
        "diagnostics": {
            "fileLoadFailures": file_failures,
            "objectParseFailures": parse_failures,
            "skippedObjects": skipped_objects,
            "dependencyFailures": dependency_failures,
            "droppedForbiddenFieldCount": dropped[0],
        },
    }
    return _finalize_artifact(census)


# --------------------------------------------------------------------------
# audit report
# --------------------------------------------------------------------------


def _rounded_extents(local_aabb: Optional[Mapping[str, Any]]) -> Optional[Dict[str, float]]:
    if not local_aabb:
        return None
    extents = local_aabb.get("extents")
    if not extents:
        return None
    rounded = {
        axis: _number(round(float(value), 3))
        for axis, value in extents.items()
        if isinstance(value, (int, float)) and not isinstance(value, bool)
    }
    return _drop_none(rounded) or None


def build_audit_report(census: Mapping[str, Any], *, max_examples: int = MAX_EXAMPLE_PATHS) -> Dict[str, Any]:
    """Rank repeated asset families by normalized name, bounds and material slots."""
    families: Dict[str, Dict[str, Any]] = {}
    with_mesh = 0
    without_mesh = 0

    for renderer in census.get("renderers", ()):
        name = renderer.get("normalizedName") or renderer.get("meshName") or ""
        normalized = normalized_name(name)
        extents = _rounded_extents(renderer.get("localAabb"))
        slots = _integer(renderer.get("materialSlotCount")) or 0
        submeshes = _integer(renderer.get("submeshCount"))
        vertices = _integer(renderer.get("vertexCount"))
        if renderer.get("meshId") is not None:
            with_mesh += 1
        else:
            without_mesh += 1
        signature = {
            "normalizedName": normalized,
            "materialSlotCount": slots,
            "submeshCount": submeshes,
            "vertexCount": vertices,
            "boundsExtents": extents,
        }
        key = _sha256_text(json.dumps(signature, sort_keys=True))
        family = families.get(key)
        if family is None:
            family = {
                "familyKey": key,
                "normalizedName": normalized,
                "materialSlotCount": slots,
                "instanceCount": 0,
                "sceneIndices": set(),
                "exampleHierarchyPaths": [],
            }
            if submeshes is not None:
                family["submeshCount"] = submeshes
            if vertices is not None:
                family["vertexCount"] = vertices
            if extents is not None:
                family["boundsExtents"] = extents
            families[key] = family
        family["instanceCount"] += 1
        scene_index = _integer(renderer.get("sceneIndex"))
        if scene_index is not None:
            family["sceneIndices"].add(scene_index)
        path = renderer.get("hierarchyPath")
        if path and len(family["exampleHierarchyPaths"]) < max_examples:
            if path not in family["exampleHierarchyPaths"]:
                family["exampleHierarchyPaths"].append(path)

    ranked: List[Dict[str, Any]] = []
    for family in families.values():
        record = dict(family)
        scene_indices = sorted(record.pop("sceneIndices"))
        record["sceneIndices"] = scene_indices[:MAX_SCALAR_LIST]
        record["sceneSpread"] = len(scene_indices)
        record["exampleCount"] = len(record["exampleHierarchyPaths"])
        ranked.append(_drop_none(record))
    ranked.sort(
        key=lambda item: (
            -item["instanceCount"],
            item["normalizedName"],
            item["familyKey"],
        )
    )

    repeated = [family for family in ranked if family["instanceCount"] > 1]
    report = {
        "schemaVersion": REPORT_SCHEMA_VERSION,
        "generator": {"name": f"{GENERATOR_NAME}-audit", "selectionMode": "census-derived"},
        "censusSchemaVersion": _integer(census.get("schemaVersion")),
        "sourceRootName": _clean_text(
            _value(census.get("source"), "rootName") or "game-data"
        ),
        "sceneIndices": list(census.get("sceneIndices") or ())[:MAX_SCALAR_LIST],
        "complete": bool(census.get("complete")),
        "rankedBy": "instanceCount",
        "totals": {
            "rendererCount": _integer(_value(census.get("counts"), "renderers")) or 0,
            "familyCount": len(ranked),
            "repeatedFamilyCount": len(repeated),
            "repeatedInstanceCount": sum(family["instanceCount"] for family in repeated),
            "singletonFamilyCount": len(ranked) - len(repeated),
        },
        "coverage": {
            "renderersWithResolvedMesh": with_mesh,
            "renderersWithoutResolvedMesh": without_mesh,
            "note": (
                "This safe release never parses Mesh objects, so every mesh pointer "
                "remains unresolved. Missing MeshFilters, dangling pointers, and "
                "denied external dependencies are additional causes."
            ),
        },
        "families": ranked,
        "topFamilies": [family["familyKey"] for family in ranked[:MAX_SCALAR_LIST]],
    }
    return _finalize_artifact(report)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def _validate_paths_noclobber(
    source_value: str, output_value: str
) -> Tuple[Path, Path]:
    try:
        source_root = Path(source_value).expanduser().resolve(strict=True)
    except OSError as error:
        raise CensusError("game-data source does not exist") from error
    if not source_root.is_dir():
        raise CensusError("game-data source is not a directory")

    output_candidate = Path(output_value).expanduser()
    if not output_candidate.is_absolute():
        output_candidate = Path.cwd() / output_candidate
    if output_candidate.is_symlink():
        raise CensusError("output path must not be a symbolic link")
    output_path = output_candidate.resolve(strict=False)
    if selector._path_is_inside(output_path, source_root):
        raise CensusError("output must be outside the supplied game-data source")
    if not output_path.parent.exists() or not output_path.parent.is_dir():
        raise CensusError("output parent directory must already exist")
    if output_path.exists():
        if output_path.is_dir():
            raise CensusError("output path is a directory")
        raise CensusError("output already exists; choose a new output path")
    return source_root, output_path


def _json_payload(value: Mapping[str, Any]) -> str:
    return json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=False,
        indent=2,
        sort_keys=True,
    ) + "\n"


def _publish_json_noclobber(
    artifacts: Sequence[Tuple[Path, Mapping[str, Any]]]
) -> None:
    """Publish fully-written files by hard link; never replace an existing name."""
    staged: List[Tuple[Path, Path]] = []
    published: List[Tuple[Path, Path]] = []
    try:
        for destination, value in artifacts:
            temporary_name: Optional[str] = None
            with tempfile.NamedTemporaryFile(
                "w",
                encoding="utf-8",
                dir=destination.parent,
                prefix=f".{destination.name}.",
                suffix=".tmp",
                delete=False,
            ) as handle:
                temporary_name = handle.name
                handle.write(_json_payload(value))
                handle.flush()
                os.fsync(handle.fileno())
            staged.append((Path(temporary_name), destination))

        # The census is the commit marker, so an optional report is linked first.
        ordered = staged[1:] + staged[:1] if len(staged) > 1 else staged
        for temporary, destination in ordered:
            try:
                os.link(temporary, destination)
            except FileExistsError as error:
                raise CensusError(
                    "output appeared during publication; no existing file was replaced"
                ) from error
            published.append((temporary, destination))

        directories = {destination.parent for _, destination in published}
        for directory in directories:
            try:
                descriptor = os.open(
                    directory,
                    os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
                )
            except OSError:
                continue
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    except Exception:
        for temporary, destination in reversed(published):
            try:
                if os.path.samestat(os.stat(temporary), os.stat(destination)):
                    destination.unlink()
            except OSError:
                pass
        raise
    finally:
        for temporary, _ in staged:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Emit a bounded scalar Customs asset census (identity, transforms, "
            "renderer/material/LOD/light facts, and a safe payload-object skip ledger). "
            "No payloads are exported and no executable is ever started."
        )
    )
    parser.add_argument("--source", required=True, help="User-supplied local game-data directory")
    parser.add_argument(
        "--output", required=True, help="Census JSON path outside the game-data directory"
    )
    parser.add_argument(
        "--report",
        help="Optional audit report JSON path outside the game-data directory",
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
            "Catalog mode: validate paths and identify only globalgamemanagers without "
            "importing UnityPy, loading scene files, or writing anything"
        ),
    )
    parser.add_argument(
        "--allow-partial",
        action="store_true",
        help=(
            "Explicitly allow an incomplete output, including the mandatory "
            "Mesh/Texture2D skip ledger"
        ),
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
    if not args.acknowledge_local_game_files:
        print(
            "error: refuse to inspect local game files without "
            "--acknowledge-local-game-files",
            file=stderr,
        )
        return 2

    try:
        source_root, output_path = _validate_paths_noclobber(args.source, args.output)
        report_path: Optional[Path] = None
        if args.report:
            _, report_path = _validate_paths_noclobber(args.source, args.report)
            if report_path == output_path:
                raise CensusError("--report must differ from --output")

        catalog_files = discover_catalog_files(source_root)
        if not catalog_files:
            raise CensusError(
                "no globalgamemanagers BuildSettings catalog was found under --source"
            )
        if len(catalog_files) != 1:
            locations = ", ".join(
                path.relative_to(source_root).as_posix() for path in catalog_files
            )
            raise CensusError(
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
                "censusObjectTypes": sorted(CENSUS_OBJECT_TYPES),
                "deferredSceneSelection": (
                    "A real run parses BuildSettings, finds /Locations/Custom/ indices, "
                    "then opens only levelN and sharedassetsN.assets for those indices."
                ),
                "outputName": output_path.name,
                "reportName": report_path.name if report_path else None,
            }
            print(json.dumps(plan, indent=2, sort_keys=True), file=stdout)
            return 0

        unitypy = unitypy_module if unitypy_module is not None else selector._import_unitypy()
        catalog = load_build_settings_catalog(source_root, catalog_files, unitypy)
        if catalog["loadedFileCount"] == 0:
            raise CensusError("UnityPy could not load globalgamemanagers")
        if not catalog["complete"]:
            raise CensusError(
                "BuildSettings catalog verification was incomplete; no scene selection was trusted"
            )
        if not catalog["buildSettings"]:
            raise CensusError("globalgamemanagers did not yield a BuildSettings object")
        scene_files = discover_customs_scene_files(source_root, catalog["sceneCatalog"])
        census = build_census(source_root, catalog, scene_files, unitypy)
        if census["source"]["loadedSceneFileCount"] == 0:
            raise CensusError("UnityPy could not load the targeted Customs files")
        if not census["complete"] and not args.allow_partial:
            diagnostics = census["diagnostics"]
            raise CensusError(
                "census is incomplete "
                f"({len(diagnostics['fileLoadFailures'])} file failures, "
                f"{len(diagnostics['objectParseFailures'])} object failures, "
                f"{len(diagnostics['skippedObjects'])} safe skips, "
                f"{len(diagnostics['dependencyFailures'])} dependency denials); "
                "fix the parser/setup or pass --allow-partial explicitly"
            )
        report = build_audit_report(census) if report_path else None
        artifacts: List[Tuple[Path, Mapping[str, Any]]] = [(output_path, census)]
        if report is not None and report_path is not None:
            artifacts.append((report_path, report))
        _publish_json_noclobber(artifacts)
        counts = census["counts"]
        print(
            f"wrote Customs asset census: {output_path.name} "
            f"({counts['gameObjects']} objects, {counts['renderers']} renderers, "
            f"{counts['meshes']} meshes, {counts['materials']} materials)",
            file=stdout,
        )
        if report is not None and report_path is not None:
            print(
                f"wrote Customs asset audit report: {report_path.name} "
                f"({report['totals']['repeatedFamilyCount']} repeated families)",
                file=stdout,
            )
        return 0
    except CensusError as error:
        print(f"error: {error}", file=stderr)
        return 2
    except OSError as error:
        print(f"error: filesystem operation failed: {type(error).__name__}", file=stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
