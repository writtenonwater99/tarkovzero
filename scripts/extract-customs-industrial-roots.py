#!/usr/bin/env python3
"""Measure which placed industrial objects stand inside the Customs rail-yard scope.

This is a measuring instrument, not a labeller.  It counts **placement roots**
(the outermost transform of one placed object), reports where they stand in the
source frame `eft-unity-world-metres-y-up`, classifies them from names and
material names only, and pre-registers the claim under test so a run can
*contradict* the claim rather than only confirm it.

Everything security-relevant is reused from `scripts/census-customs-assets.py`:
the audited two-stage selector, the safe Unity stream, the dependency-loading
blockers, the parse gate, the payload scrub, and the atomic no-clobber publish.
Re-implementing any of those here would be a second place to get them wrong.

Never emitted, under any flag: vertices, indices, triangles, UVs, normals,
tangents, skin/bind-pose data, blend shapes, texture pixels, `.resS` stream
paths, shaders, shader keywords, script/bytecode references, animation curves,
any raw serialized array or blob, and any absolute installation path.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import re
import sys
from collections import deque
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence as Seq, TextIO, Tuple


ROOTS_SCHEMA_VERSION = 1
REPORT_SCHEMA_VERSION = 1
GENERATOR_NAME = "tarkovzero-customs-industrial-roots"


def _load_census_module() -> Any:
    """Reuse the audited census (and, through it, the audited selector)."""
    script = Path(__file__).with_name("census-customs-assets.py")
    spec = importlib.util.spec_from_file_location("census_customs_assets", script)
    if spec is None or spec.loader is None:  # pragma: no cover - packaging failure
        raise RuntimeError("cannot load the Customs census module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


census = _load_census_module()
selector = census.selector

RootsError = census.CensusError

REPO_ROOT = Path(__file__).resolve().parents[1]

# Reused, never re-implemented.
discover_catalog_files = census.discover_catalog_files
discover_customs_scene_files = census.discover_customs_scene_files
load_build_settings_catalog = census.load_build_settings_catalog
normalized_name = census.normalized_name
MAX_PARSED_OBJECT_BYTES = census.MAX_PARSED_OBJECT_BYTES
NEVER_PARSE_TYPES = census.NEVER_PARSE_TYPES
MAX_SCALAR_LIST = census.MAX_SCALAR_LIST
MAX_HIERARCHY_DEPTH = census.MAX_HIERARCHY_DEPTH

_clean_text = selector._clean_text
_value = selector._value
_integer = selector._integer
_number = selector._number
_drop_none = selector._drop_none
_pointer_key = selector._pointer_key
_reader_path_id = selector._reader_path_id
_reader_type_name = selector._reader_type_name
_unique_records = selector._unique_records
_sha256_text = census._sha256_text
_safe_error_type = census._safe_error_type


# `Mesh` and `Texture2D` are deliberately absent: they are never selected, so a
# healthy run needs no skip ledger for them and is `complete: true`.
ROOTS_OBJECT_TYPES = {
    "GameObject",
    "Transform",
    "RectTransform",
    "MeshFilter",
    "MeshRenderer",
    "SkinnedMeshRenderer",
    "Material",
    "LODGroup",
}
RENDERER_TYPES = census.RENDERER_TYPES
TRANSFORM_TYPES = census.TRANSFORM_TYPES

FRAME_ID = "eft-unity-world-metres-y-up"
RUNTIME_FROM_SOURCE = "[-x, -z, y]"
SCOPE_ID = "customs-industrial-rail-yard"

DEFAULT_MAX_PLACEMENT_SPAN_M = 26.0
DEFAULT_COINCIDENT_ROOT_M = 1.5
DEFAULT_FRAME_WITNESS_TOLERANCE_M = 12.0
DEFAULT_TERRAIN_MARGIN_M = 50.0
RAIL_ON_TRACK_M = 4.0
RAIL_OFF_TRACK_M = 12.0
ANCHOR_COMPATIBLE_M = 25.0
NINE_PROXY_MATCH_M = 2.0
# The mirror falsifier's density half needs a sample before a ratio means
# anything; below this it is not evaluated at all (the witness half still is).
MIRROR_MIN_SAMPLE = 3
# The bands a verdict may be computed from.  Every count a reader would compare
# against a verdict is emitted for this set as well as for all bands.
CONFIDENT_BANDS = ("established", "probable")
COLOR_NEUTRAL_SPREAD = 0.05

CLAIM_SOURCE = "docs/CONTINUATION-HANDOFF-2026-08-31.md"
CLAIM_STATEMENT = (
    "three closed freight wagons, two tank wagons, one hopper wagon, and two 6 m "
    "red containers"
)
CLAIM_COMPONENTS = {
    "closedFreightWagons": 3,
    "tankWagons": 2,
    "hopperWagons": 1,
    "redContainers6m": 2,
    "railStockTotal": 6,
    "containerTotal": 2,
}


# --------------------------------------------------------------------------
# name vocabularies
# --------------------------------------------------------------------------

PART_NAME_TOKENS = frozenset(
    (
        "lod",
        "lod0",
        "lod1",
        "lod2",
        "lod3",
        "lods",
        "mesh",
        "meshes",
        "model",
        "body",
        "frame",
        "base",
        "chassis",
        "bogie",
        "bogey",
        "wheels",
        "wheel",
        "collider",
        "colliders",
        "collision",
        "col",
        "shadow",
        "shadowcaster",
        "lightprobe",
        "probe",
        "bounds",
        "pivot",
        "geo",
        "geometry",
        "render",
        "renderer",
        "group",
        "grp",
        "parts",
        "detail",
    )
)

# `container`/`containers` are conditional (see `_is_group`) and are therefore
# not members of this unconditional set.
GROUP_NAME_TOKENS = frozenset(
    (
        "root",
        "scene",
        "static",
        "statics",
        "props",
        "prop",
        "objects",
        "environment",
        "env",
        "yard",
        "railyard",
        "rail",
        "rails",
        "railway",
        "industrial",
        "zone",
        "area",
        "sector",
        "block",
        "decor",
        "level",
        "geometry_root",
    )
)
CONDITIONAL_GROUP_NAMES = frozenset(("container", "containers"))

RAIL_GENERIC_TOKENS = frozenset(
    ("wagon", "vagon", "wag", "railcar", "rail_car", "railwagon", "train", "poezd", "zhd", "rzd")
)
LOCOMOTIVE_TOKENS = frozenset(
    ("locomotive", "loco", "teplovoz", "elektrovoz", "shunter", "diesel")
)
COVERED_TOKENS = frozenset(
    ("covered", "closed", "box", "boxcar", "kryt", "kryty", "tovarn", "freight", "gruz", "gruzov")
)
TANK_TOKENS = frozenset(
    ("tank", "tanker", "cistern", "cisterna", "fuel", "toplivo", "neft", "oil", "gas")
)
HOPPER_TOKENS = frozenset(
    ("hopper", "hoper", "bunker", "dump", "ore", "coal", "ugol", "gravel", "ballast", "shcheben")
)
FLAT_TOKENS = frozenset(("flat", "platform", "platforma", "flatcar"))
GONDOLA_TOKENS = frozenset(("gondola", "poluvagon", "polu", "opentop"))
CONTAINER_TOKENS = frozenset(("container", "konteyner", "kontejner", "cont", "iso"))
LENGTH_HINT_6M = frozenset(("6m", "20ft", "20f"))
LENGTH_HINT_12M = frozenset(("12m", "40ft", "40f"))
STATIC_TANK_QUALIFIERS = frozenset(("static", "ground", "storage", "rezervuar", "bak", "silo"))

GENERIC_NAMES = frozenset(
    ("prop", "props", "object", "obj", "mesh", "model", "static", "group", "item", "thing", "new", "gameobject")
)

CLASS_RAIL_LOCOMOTIVE = "rail-locomotive"
CLASS_RAIL_COVERED = "rail-wagon-covered"
CLASS_RAIL_TANK = "rail-wagon-tank"
CLASS_RAIL_HOPPER = "rail-wagon-hopper"
CLASS_RAIL_FLAT = "rail-wagon-flat"
CLASS_RAIL_GONDOLA = "rail-wagon-gondola"
CLASS_RAIL_UNSPECIFIED = "rail-wagon-unspecified"
CLASS_CONTAINER_6M = "container-iso-6m"
CLASS_CONTAINER_12M = "container-iso-12m"
CLASS_CONTAINER_UNSPECIFIED = "container-unspecified"
CLASS_TANK_STATIC = "industrial-tank-static"
CLASS_UNCLASSIFIED = "unclassified"

# Deterministic tie-break order.
CLASS_ORDER = (
    CLASS_RAIL_LOCOMOTIVE,
    CLASS_RAIL_COVERED,
    CLASS_RAIL_TANK,
    CLASS_RAIL_HOPPER,
    CLASS_RAIL_FLAT,
    CLASS_RAIL_GONDOLA,
    CLASS_RAIL_UNSPECIFIED,
    CLASS_CONTAINER_6M,
    CLASS_CONTAINER_12M,
    CLASS_CONTAINER_UNSPECIFIED,
    CLASS_TANK_STATIC,
    CLASS_UNCLASSIFIED,
)
CLASS_RANK = {name: index for index, name in enumerate(CLASS_ORDER)}

SPECIFIC_RAIL_BODY_CLASSES = frozenset(
    (CLASS_RAIL_COVERED, CLASS_RAIL_TANK, CLASS_RAIL_HOPPER, CLASS_RAIL_FLAT, CLASS_RAIL_GONDOLA)
)
RAIL_CLASSES = SPECIFIC_RAIL_BODY_CLASSES | {CLASS_RAIL_LOCOMOTIVE, CLASS_RAIL_UNSPECIFIED}
CONTAINER_CLASSES = frozenset(
    (CLASS_CONTAINER_6M, CLASS_CONTAINER_12M, CLASS_CONTAINER_UNSPECIFIED)
)

CLASS_TOKENS = {
    CLASS_RAIL_LOCOMOTIVE: LOCOMOTIVE_TOKENS,
    CLASS_RAIL_COVERED: COVERED_TOKENS,
    CLASS_RAIL_TANK: TANK_TOKENS,
    CLASS_RAIL_HOPPER: HOPPER_TOKENS,
    CLASS_RAIL_FLAT: FLAT_TOKENS,
    CLASS_RAIL_GONDOLA: GONDOLA_TOKENS,
    CLASS_RAIL_UNSPECIFIED: RAIL_GENERIC_TOKENS,
    CLASS_CONTAINER_6M: CONTAINER_TOKENS,
    CLASS_CONTAINER_12M: CONTAINER_TOKENS,
    CLASS_CONTAINER_UNSPECIFIED: CONTAINER_TOKENS,
    CLASS_TANK_STATIC: TANK_TOKENS | STATIC_TANK_QUALIFIERS,
    CLASS_UNCLASSIFIED: frozenset(),
}

INDUSTRIAL_LEXICON = (
    RAIL_GENERIC_TOKENS
    | LOCOMOTIVE_TOKENS
    | COVERED_TOKENS
    | TANK_TOKENS
    | HOPPER_TOKENS
    | FLAT_TOKENS
    | GONDOLA_TOKENS
    | CONTAINER_TOKENS
)

# Pivot-span bands for the S channel (metres between *pivots*, not lengths).
CLASS_SPAN_BANDS = {
    CLASS_RAIL_LOCOMOTIVE: 20.0,
    CLASS_RAIL_COVERED: 16.0,
    CLASS_RAIL_TANK: 16.0,
    CLASS_RAIL_HOPPER: 16.0,
    CLASS_RAIL_FLAT: 16.0,
    CLASS_RAIL_GONDOLA: 16.0,
    CLASS_RAIL_UNSPECIFIED: 16.0,
    CLASS_CONTAINER_6M: 7.0,
    CLASS_CONTAINER_12M: 13.0,
    CLASS_TANK_STATIC: 16.0,
}

CHANNEL_WEIGHTS = {
    "N": 0.35,
    "P": 0.20,
    "M": 0.20,
    "L": 0.10,
    "S": 0.10,
    "F": 0.05,
    "R+": 0.10,
    "R-": -0.20,
    "A": -0.25,
    "X": -0.20,
    "G": -0.30,
}
CONFIDENCE_CEILING = 0.95
BAND_ESTABLISHED = 0.70
BAND_PROBABLE = 0.40


# Every key the roots document and the operator roster are allowed to emit.
ROOTS_ALLOWED_OUTPUT_KEYS = frozenset(
    (
        # envelope
        "schemaVersion",
        "generator",
        "name",
        "unityPyVersion",
        "selectionMode",
        "parameters",
        "source",
        "sceneIndices",
        "complete",
        "frameVerified",
        "scopeIntegrity",
        "frameCheck",
        "claimUnderTest",
        "claimVerdict",
        "classification",
        "counts",
        "roots",
        "families",
        "crossChecks",
        "diagnostics",
        # parameters
        "scopeId",
        "scopeCenter",
        "scopeWidthM",
        "scopeDepthM",
        "frameId",
        "maxPlacementSpanM",
        "coincidentRootM",
        "frameWitnessToleranceM",
        "terrainMarginM",
        "railOnTrackM",
        "railOffTrackM",
        "mirrorMinSampleRoots",
        # source ledger
        "rootName",
        "catalogFiles",
        "catalogFileFacts",
        "sceneFiles",
        "loadedCatalogFileCount",
        "loadedSceneFileCount",
        "loadedFileCount",
        "file",
        "role",
        "sceneIndex",
        "scenePath",
        "byteSize",
        "sha256",
        "digestComplete",
        "bindingVerified",
        "statIdentityHash",
        # frame check
        "fortressWitness",
        "fortressWitnessDistanceM",
        "fortressWitnessRootId",
        "sourceFrameRootCount",
        "mirroredFrameRootCount",
        "sourceFrameWitnessDistanceM",
        "mirroredFrameWitnessDistanceM",
        "sourceFrameIndustrialDensity",
        "mirroredFrameIndustrialDensity",
        "outsideTerrainEnvelopeCount",
        "outsideTerrainEnvelopeFraction",
        "terrainEnvelope",
        "verdict",
        # claim
        "statement",
        "components",
        "closedFreightWagons",
        "tankWagons",
        "hopperWagons",
        "redContainers6m",
        "railStockTotal",
        "containerTotal",
        "overall",
        # classification
        "separability",
        "railBodyType",
        "containerSize",
        "tankWagonVsStaticTank",
        "familiesObserved",
        "railAdjacency",
        "reason",
        # counts
        "gameObjectsParsed",
        "renderablesParsed",
        "electedRoots",
        "rootsInScope",
        "railRootsInScope",
        "containerRootsInScope",
        "railRootsInScopeConfident",
        "containerRootsInScopeConfident",
        "confidentBands",
        "otherIndustrialRootsInScope",
        "establishedRootsInScope",
        "probableRootsInScope",
        "unresolvedRootsInScope",
        "spanRejectedCount",
        "unrootableNodeCount",
        "unresolvedRejectionCount",
        "coincidentRootGroupCount",
        "rootCountIsLowerBound",
        "skippedNonRootsObjects",
        "skippedObjects",
        # roots
        "rootId",
        "objectId",
        "asset",
        "pathId",
        "sourceFile",
        "sourceRole",
        "normalizedName",
        "nameHash",
        "hierarchyPathHash",
        "hierarchyDepth",
        "world",
        "position",
        "rotation",
        "scale",
        "x",
        "y",
        "z",
        "w",
        "positionExact",
        "inScope",
        "railDistanceM",
        "descendantCount",
        "renderableDescendantCount",
        "pivotSpanM",
        "lodCount",
        "materialSlotCount",
        "materialNames",
        "colorEvidence",
        "property",
        "r",
        "g",
        "b",
        "a",
        "class",
        "confidence",
        "band",
        "confidenceChannels",
        "N",
        "P",
        "M",
        "L",
        "S",
        "F",
        "R",
        "A",
        "X",
        "G",
        "competingClasses",
        "score",
        # families
        "instanceCount",
        "inScopeCount",
        "meanConfidence",
        "exampleRootIds",
        # cross-checks
        "anchors",
        "featureId",
        "anchor",
        "nearestRootId",
        "nearestClass",
        "distanceM",
        "compatible",
        "anchorsVerdict",
        # diagnostics
        "fileLoadFailures",
        "objectParseFailures",
        "dependencyFailures",
        "droppedForbiddenFieldCount",
        "unrootableNodes",
        "unresolvedRejections",
        "rule",
        "inexactRoots",
        "spanRejected",
        "coincidentRootGroups",
        "prefabLinkage",
        "phase",
        "errorType",
        "type",
        "serializedByteSize",
        "externalIdentityHash",
        "fileId",
        "spanM",
        "childCount",
        "rootIds",
        # operator roster
        "rootsSchemaVersion",
        "sourceRootName",
        "rankedBy",
    )
)


# --------------------------------------------------------------------------
# guards
# --------------------------------------------------------------------------


def assert_bounded_payload(
    payload: Any,
    *,
    allowed: frozenset = ROOTS_ALLOWED_OUTPUT_KEYS,
    path: str = "$",
) -> None:
    """Fail closed on an unreviewed key, a payload array, or an unsafe value.

    Structurally identical to `census.assert_bounded_payload` with the allowlist
    lifted into a parameter, so the two copies can be proven to agree.
    """
    if isinstance(payload, (bytes, bytearray, memoryview)):
        raise RootsError(f"binary payload is never emitted (at {path})")
    if isinstance(payload, Mapping):
        for key, value in payload.items():
            if not isinstance(key, str):
                raise RootsError(f"non-string key at {path}")
            if key not in allowed:
                raise RootsError(f"unapproved output field '{key}' at {path}")
            assert_bounded_payload(value, allowed=allowed, path=f"{path}.{key}")
        return
    if isinstance(payload, (list, tuple)):
        scalar_items = sum(
            1 for item in payload if isinstance(item, (int, float, str, bool))
        )
        if scalar_items > MAX_SCALAR_LIST:
            raise RootsError(
                f"scalar array of {scalar_items} entries exceeds the census bound at {path}"
            )
        for index, item in enumerate(payload):
            assert_bounded_payload(item, allowed=allowed, path=f"{path}[{index}]")
        return
    if isinstance(payload, str):
        if len(payload) > 1024:
            raise RootsError(f"string longer than 1024 characters at {path}")
        return
    if isinstance(payload, bool) or payload is None:
        return
    if isinstance(payload, (int, float)):
        if isinstance(payload, float) and not math.isfinite(payload):
            raise RootsError(f"non-finite number at {path}")
        return
    raise RootsError(f"unsupported value type {type(payload).__name__} at {path}")


def _finalize_artifact(payload: Dict[str, Any]) -> Dict[str, Any]:
    assert_bounded_payload(payload)
    json.dumps(payload, allow_nan=False, sort_keys=True)
    return payload


def _roots_parse_gate(
    reader: Any,
    *,
    asset: str,
    type_name: str,
    path_id: Optional[int],
    phase: str,
    selection: Optional[Mapping[str, Any]] = None,
) -> Tuple[bool, Optional[Dict[str, Any]]]:
    """Belt-and-braces: a payload-bearing type must never reach the parse gate."""
    if type_name in NEVER_PARSE_TYPES:
        raise RootsError(
            "payload-bearing object type reached the roots parse gate; "
            "ROOTS_OBJECT_TYPES must never contain it"
        )
    return census._parse_gate(
        reader,
        asset=asset,
        type_name=type_name,
        path_id=path_id,
        phase=phase,
        selection=selection,
    )


# --------------------------------------------------------------------------
# repo-local cross-check inputs (read-only, scalars only, never game-derived)
# --------------------------------------------------------------------------


def _read_json(path: Path) -> Any:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def load_scene_manifest(path: Path) -> Dict[str, Any]:
    """Load the scope box, frame declaration and Fortress witness. Hard-fails."""
    try:
        document = _read_json(path)
    except (OSError, ValueError) as error:
        raise RootsError(
            "scene manifest is required for the frame witness and could not be read "
            f"({_safe_error_type(error)})"
        ) from error
    frames = document.get("frames") if isinstance(document, Mapping) else None
    if not isinstance(frames, Mapping):
        raise RootsError("scene manifest declares no frames block")
    source_frame = _clean_text(frames.get("source"), limit=80)
    if source_frame != FRAME_ID:
        raise RootsError(
            "scene manifest source frame does not match the extractor's frame contract"
        )
    runtime_from_source = _clean_text(frames.get("runtimeFromSource"), limit=80)
    if runtime_from_source != RUNTIME_FROM_SOURCE:
        raise RootsError(
            "scene manifest runtimeFromSource changed; the frame evidence this tool "
            "relies on is no longer valid"
        )
    scope = document.get("scope")
    if not isinstance(scope, Mapping):
        raise RootsError("scene manifest declares no scope block")
    center = scope.get("center")
    if not isinstance(center, Mapping):
        raise RootsError("scene manifest scope declares no center")
    center_x = _number(center.get("x"))
    center_z = _number(center.get("z"))
    width = _number(scope.get("widthM"))
    depth = _number(scope.get("depthM"))
    if None in (center_x, center_z, width, depth) or width <= 0 or depth <= 0:
        raise RootsError("scene manifest scope is not a usable box")

    witness: Optional[Tuple[float, float]] = None
    evidence = document.get("evidence")
    observations = evidence.get("observations") if isinstance(evidence, Mapping) else None
    for observation in observations or ():
        if not isinstance(observation, Mapping):
            continue
        feature = _clean_text(observation.get("featureId"), limit=200) or ""
        if not feature.casefold().startswith("customs.building.fortress"):
            continue
        position = observation.get("positionM")
        if not isinstance(position, Mapping):
            continue
        x = _number(position.get("x"))
        z = _number(position.get("z"))
        if x is None or z is None:
            continue
        witness = (x, z)
        break
    if witness is None:
        raise RootsError(
            "scene manifest carries no Fortress pivot observation; the frame witness "
            "is load-bearing and cannot be skipped"
        )
    return {
        "scopeId": _clean_text(scope.get("id"), limit=120) or SCOPE_ID,
        "center": (center_x, center_z),
        "widthM": width,
        "depthM": depth,
        "fortress": witness,
    }


def load_terrain_facts(path: Path) -> Dict[str, Any]:
    """Terrain envelope + rail polylines. Degrades instead of failing."""
    try:
        document = _read_json(path)
    except (OSError, ValueError):
        return {"envelope": None, "railway": None}
    terrain = document.get("terrain") if isinstance(document, Mapping) else None
    envelope = None
    if isinstance(terrain, Mapping):
        x0 = _number(terrain.get("x0"))
        z0 = _number(terrain.get("z0"))
        step = _number(terrain.get("step"))
        cols = _integer(terrain.get("cols"))
        rows = _integer(terrain.get("rows"))
        if None not in (x0, z0, step, cols, rows) and step > 0 and cols > 1 and rows > 1:
            envelope = (x0, x0 + step * (cols - 1), z0, z0 + step * (rows - 1))

    railway: Optional[List[List[Tuple[float, float]]]] = None
    raw_railway = document.get("railway") if isinstance(document, Mapping) else None
    if isinstance(raw_railway, Sequence) and not isinstance(raw_railway, (str, bytes)):
        collected: List[List[Tuple[float, float]]] = []
        for entry in raw_railway:
            raw_path = entry.get("path") if isinstance(entry, Mapping) else entry
            if not isinstance(raw_path, Sequence) or isinstance(raw_path, (str, bytes)):
                continue
            points: List[Tuple[float, float]] = []
            for point in raw_path:
                if not isinstance(point, Sequence) or isinstance(point, (str, bytes)):
                    continue
                if len(point) < 2:
                    continue
                x = _number(point[0])
                z = _number(point[1])
                if x is None or z is None:
                    continue
                points.append((x, z))
            if len(points) >= 2:
                collected.append(points)
        railway = collected or None
    return {"envelope": envelope, "railway": railway}


def load_prop_feature_anchors(path: Path) -> Optional[List[Dict[str, Any]]]:
    """The nine current anchors, for the contradiction table. Degrades."""
    try:
        document = _read_json(path)
    except (OSError, ValueError):
        return None
    features = document.get("features") if isinstance(document, Mapping) else None
    if not isinstance(features, Sequence):
        return None
    anchors: List[Dict[str, Any]] = []
    for feature in features:
        if not isinstance(feature, Mapping):
            continue
        feature_id = _clean_text(feature.get("featureId"), limit=200)
        match = feature.get("match")
        if not feature_id or not isinstance(match, Mapping):
            continue
        position = match.get("position")
        if not isinstance(position, Sequence) or len(position) < 2:
            continue
        x = _number(position[0])
        z = _number(position[1])
        if x is None or z is None:
            continue
        anchors.append(
            {
                "featureId": feature_id,
                "type": _clean_text(match.get("type"), limit=64) or "",
                "x": x,
                "z": z,
            }
        )
    anchors.sort(key=lambda item: item["featureId"])
    return anchors or None


# --------------------------------------------------------------------------
# scene facts (the same audited load path, restricted to the roots type set)
# --------------------------------------------------------------------------


def build_scene_facts(
    catalog: Mapping[str, Any],
    scene_files: Seq[Mapping[str, Any]],
    unitypy_module: Any,
) -> Dict[str, Any]:
    """Collect scalar GameObject/Transform/renderer/material/LOD facts."""
    raw_game_objects: List[Dict[str, Any]] = []
    raw_transforms: List[Dict[str, Any]] = []
    mesh_filters: List[Dict[str, Any]] = []
    renderers: List[Dict[str, Any]] = []
    materials: List[Dict[str, Any]] = []
    lod_groups: List[Dict[str, Any]] = []
    file_failures: List[Dict[str, Any]] = list(catalog["fileLoadFailures"])
    parse_failures: List[Dict[str, Any]] = list(catalog["objectParseFailures"])
    skipped_objects: List[Dict[str, Any]] = list(catalog.get("skippedObjects") or ())
    dependency_failures: List[Dict[str, Any]] = []
    dropped = [0]
    skipped_non_roots = 0
    loaded_scene_files = 0
    scene_file_facts: List[Dict[str, Any]] = []

    before_bindings = {
        selection["file"]: census._capture_file_binding(selection["path"])
        for selection in scene_files
    }
    externals: Dict[str, List[Dict[str, Any]]] = {}
    file_by_identity: Dict[str, str] = {}
    for selection in scene_files:
        identity = census._normalized_file_identity(selection["file"])
        if identity is None or identity in file_by_identity:
            raise RootsError("selected scene files do not have unique normalized identities")
        file_by_identity[identity] = selection["file"]
    resolve = census._make_resolver(externals, file_by_identity, dependency_failures)

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
            fact, _ = census._verified_file_fact(
                file=selection["file"],
                role=selection["role"],
                before=before,
                after=before,
                selection=selection,
            )
            scene_file_facts.append(fact)
            continue
        stream = None
        try:
            stream = census._open_bound_unity_stream(
                candidate, selection["file"], before[1]
            )
            environment = unitypy_module.load(stream)
            # Before `environment.objects` is ever touched.
            census._disable_dependency_loading(environment)
        except Exception as error:
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
            after = census._capture_file_binding(candidate)
            fact, verified = census._verified_file_fact(
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
        external_identities, external_error = census._external_identities(
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
        for reader in readers:
            type_name = _reader_type_name(reader)
            if type_name not in ROOTS_OBJECT_TYPES:
                skipped_non_roots += 1
                continue
            path_id = _reader_path_id(reader)
            asset = selection["file"]
            allowed, skipped_record = _roots_parse_gate(
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
                data = census._scrub_payload_fields(
                    reader.parse_as_dict(),
                    dropped,
                    census._forbidden_fields_for(type_name),
                )
                if type_name == "GameObject":
                    local_game_objects.append(
                        census._with_scene_association(
                            census._parse_game_object(data, asset=asset, path_id=path_id),
                            selection,
                        )
                    )
                elif type_name in TRANSFORM_TYPES:
                    local_transforms.append(
                        census._parse_transform(
                            data, asset=asset, path_id=path_id, type_name=type_name
                        )
                    )
                elif type_name == "MeshFilter":
                    local_mesh_filters.append(
                        census._parse_mesh_filter(data, asset=asset, path_id=path_id)
                    )
                elif type_name in RENDERER_TYPES:
                    local_renderers.append(
                        census._with_scene_association(
                            census._parse_renderer(
                                data, asset=asset, path_id=path_id, type_name=type_name
                            ),
                            selection,
                        )
                    )
                elif type_name == "Material":
                    local_materials.append(
                        census._with_scene_association(
                            census._parse_material(data, asset=asset, path_id=path_id),
                            selection,
                        )
                    )
                elif type_name == "LODGroup":
                    local_lod_groups.append(
                        census._with_scene_association(
                            census._parse_lod_group(data, asset=asset, path_id=path_id),
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
        after = census._capture_file_binding(candidate)
        fact, verified = census._verified_file_fact(
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

    game_objects, game_object_lookup = census._finalize_game_objects(
        _unique_records(raw_game_objects), _unique_records(raw_transforms)
    )
    materials, _material_counts = census._link_materials(
        _unique_records(materials), (), resolve
    )
    renderers, _reference_counts = census._link_renderers(
        _unique_records(renderers),
        _unique_records(mesh_filters),
        (),
        materials,
        game_object_lookup,
        resolve,
    )
    lod_groups = census._attach_game_object(
        _unique_records(lod_groups), game_object_lookup
    )

    file_failures.sort(key=lambda item: (item["file"].casefold(), item.get("phase", "")))
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
    return {
        "gameObjects": game_objects,
        "gameObjectLookup": game_object_lookup,
        "renderers": renderers,
        "materials": materials,
        "lodGroups": lod_groups,
        "sceneFileFacts": scene_file_facts,
        "loadedSceneFileCount": loaded_scene_files,
        "fileLoadFailures": file_failures,
        "objectParseFailures": parse_failures,
        "skippedObjects": skipped_objects,
        "dependencyFailures": dependency_failures,
        "droppedForbiddenFieldCount": dropped[0],
        "skippedNonRootsObjects": skipped_non_roots,
    }


# --------------------------------------------------------------------------
# forest, election, spans
# --------------------------------------------------------------------------


def _object_key(record: Mapping[str, Any]) -> Optional[Tuple[str, int]]:
    path_id = record.get("pathId")
    if not isinstance(path_id, int) or isinstance(path_id, bool):
        return None
    return (record["asset"], path_id)


def _tokenize(text: Optional[str]) -> List[str]:
    if not text:
        return []
    return [part for part in re.split(r"[^a-z0-9]+", text.casefold()) if part]


def _world_position(record: Mapping[str, Any]) -> Optional[Tuple[float, float, float]]:
    world = record.get("world")
    if not isinstance(world, Mapping):
        return None
    position = world.get("position")
    if not isinstance(position, Mapping):
        return None
    x = _number(position.get("x"))
    y = _number(position.get("y"))
    z = _number(position.get("z"))
    if x is None or y is None or z is None:
        return None
    return (x, y, z)


class Forest:
    """The GameObject parent/child forest plus the renderable/LOD marking."""

    def __init__(
        self,
        game_objects: Seq[Mapping[str, Any]],
        renderers: Seq[Mapping[str, Any]],
        lod_groups: Seq[Mapping[str, Any]],
    ) -> None:
        self.nodes: Dict[Tuple[str, int], Mapping[str, Any]] = {}
        for record in game_objects:
            key = _object_key(record)
            if key is not None:
                self.nodes[key] = record
        self.parent: Dict[Tuple[str, int], Optional[Tuple[str, int]]] = {}
        self.children: Dict[Tuple[str, int], List[Tuple[str, int]]] = {
            key: [] for key in self.nodes
        }
        for key, record in self.nodes.items():
            parent_path_id = record.get("parentGameObjectPathId")
            parent_key = None
            if isinstance(parent_path_id, int) and not isinstance(parent_path_id, bool):
                candidate = (key[0], parent_path_id)
                if candidate in self.nodes and candidate != key:
                    parent_key = candidate
            self.parent[key] = parent_key
            if parent_key is not None:
                self.children[parent_key].append(key)
        for bucket in self.children.values():
            bucket.sort()
        self.roots = sorted(key for key, value in self.parent.items() if value is None)

        self.renderers_by_key: Dict[Tuple[str, int], List[Mapping[str, Any]]] = {}
        self.renderer_by_path: Dict[Tuple[str, int], Mapping[str, Any]] = {}
        for record in renderers:
            renderer_key = _object_key(record)
            if renderer_key is not None:
                self.renderer_by_path[renderer_key] = record
            path_id = record.get("gameObjectPathId")
            if not isinstance(path_id, int) or isinstance(path_id, bool):
                continue
            owner = (record["asset"], path_id)
            if owner in self.nodes:
                self.renderers_by_key.setdefault(owner, []).append(record)

        self.lod_groups_by_key: Dict[Tuple[str, int], List[Mapping[str, Any]]] = {}
        for record in lod_groups:
            path_id = record.get("gameObjectPathId")
            if not isinstance(path_id, int) or isinstance(path_id, bool):
                continue
            owner = (record["asset"], path_id)
            if owner in self.nodes:
                self.lod_groups_by_key.setdefault(owner, []).append(record)

        self.renderable = set(self.renderers_by_key) | set(self.lod_groups_by_key)
        self.order = self._topological_order()
        self.has_renderable_descendant = self._mark_renderable_descendants()
        self.subtree_nodes = self._collect_subtrees()
        self.lod_interior = self._mark_lod_interiors()

    def _topological_order(self) -> List[Tuple[str, int]]:
        """Parents before children; bounded so a malformed chain cannot loop."""
        order: List[Tuple[str, int]] = []
        queue = deque(self.roots)
        seen = set(self.roots)
        while queue:
            key = queue.popleft()
            order.append(key)
            for child in self.children.get(key, ()):
                if child in seen:
                    continue
                seen.add(child)
                queue.append(child)
        # Any node not reached (a parent cycle) is appended so it is never lost.
        for key in sorted(self.nodes):
            if key not in seen:
                order.append(key)
        return order

    def _mark_renderable_descendants(self) -> Dict[Tuple[str, int], bool]:
        marked = {key: key in self.renderable for key in self.nodes}
        for key in reversed(self.order):
            if marked.get(key):
                parent = self.parent.get(key)
                if parent is not None:
                    marked[parent] = True
        return marked

    def _collect_subtrees(self) -> Dict[Tuple[str, int], List[Tuple[str, int]]]:
        """Subtree membership (self included), computed bottom-up once."""
        subtree: Dict[Tuple[str, int], List[Tuple[str, int]]] = {}
        for key in reversed(self.order):
            collected = [key]
            for child in self.children.get(key, ()):
                collected.extend(subtree.get(child, ()))
            subtree[key] = collected
        return subtree

    def _mark_lod_interiors(self) -> set:
        interior: set = set()
        for owner in sorted(self.lod_groups_by_key):
            for group in self.lod_groups_by_key[owner]:
                for level in group.get("levels") or ():
                    for renderer_path_id in level.get("rendererPathIds") or ():
                        renderer = self.renderer_by_path.get(
                            (group["asset"], renderer_path_id)
                        )
                        if renderer is None:
                            continue
                        game_object_path_id = renderer.get("gameObjectPathId")
                        if not isinstance(game_object_path_id, int):
                            continue
                        member = (group["asset"], game_object_path_id)
                        if member not in self.nodes:
                            continue
                        walked: List[Tuple[str, int]] = []
                        cursor: Optional[Tuple[str, int]] = member
                        depth = 0
                        while cursor is not None and cursor != owner:
                            walked.append(cursor)
                            cursor = self.parent.get(cursor)
                            depth += 1
                            if depth > MAX_HIERARCHY_DEPTH:
                                cursor = None
                                walked = []
                                break
                        if cursor == owner:
                            interior.update(walked)
        return interior

    def renderable_descendants(self, key: Tuple[str, int]) -> List[Tuple[str, int]]:
        return [item for item in self.subtree_nodes.get(key, ()) if item in self.renderable]

    def pivot_span(self, key: Tuple[str, int]) -> float:
        """Axis-aligned XZ span of the renderable descendants' world pivots.

        The grouping rules (R5) measure the WHOLE subtree: that is the question
        "how far apart is the geometry hanging under this node".  A root's
        emitted `pivotSpanM` measures only what the root owns — see
        `_pivot_span_of` and the split in `elect_roots`.
        """
        return _pivot_span_of(self, self.renderable_descendants(key))


def _pivot_span_of(forest: Forest, members: Seq[Tuple[str, int]]) -> float:
    """Axis-aligned XZ span of the world pivots of `members`."""
    xs: List[float] = []
    zs: List[float] = []
    for member in members:
        position = _world_position(forest.nodes[member])
        if position is None:
            continue
        xs.append(position[0])
        zs.append(position[2])
    if len(xs) < 2:
        return 0.0
    return max(max(xs) - min(xs), max(zs) - min(zs))


def _is_part_of(child_name: str, parent_name: str) -> bool:
    """True when `child_name` reads as a sub-part of the node named `parent_name`.

    The final clause is name-only and therefore *ancestor-blind*: `Mesh` reads as
    a part of whatever stands above it.  That is correct where the caller already
    knows the two names are parent and child (R4's exclusion below), and it is
    the reason a *count of distinct descendant names* cannot see two placements
    whose renderers both hang off a child literally named `Mesh` — hence the
    branch rule in `_is_group`.

    > **Decision 2026-09-01 — an identical name is an INSTANCE, never a part.**
    > The published predicate returned True when the two normalized names were
    > equal, and again when the child's name merely started with the parent's,
    > which is the same thing for an equal pair.  Because `normalized_name` folds
    > the trailing index, `Container -> {Container_01, Container_02}` — Unity's
    > ordinary way of authoring two placements under one wrapper — presented as
    > `container` under `container` and both children were swallowed as parts of
    > the wrapper, so two containers were reported as one.  Nothing is ever named
    > exactly what it is a part OF; a body is `Body`, not `Vagon`.  So equality is
    > now the *opposite* signal — same family name, different placement — and the
    > prefix clause fires only on a strictly longer name (`Railcar_Long_A` under
    > `Railcar_Long`), which is what genuine sub-part naming looks like.
    """
    if child_name == "" or child_name.isdigit():
        return True
    if parent_name and child_name != parent_name and child_name.startswith(parent_name):
        return True
    return child_name in PART_NAME_TOKENS


def _placement_branches(
    forest: Forest, key: Tuple[str, int], own_name: str
) -> List[Tuple[str, int]]:
    """Direct children that carry a renderer somewhere and are not parts of `key`.

    Each such child is one candidate *placement* underneath `key`, whatever its
    own descendants happen to be named.  Counting branches instead of descendant
    names is what separates `Containers -> {Container_01 -> Mesh,
    Container_02 -> Mesh}` (two placements) from `Vagon_02 -> Body -> Mesh`
    (one placement, a part-named branch).

    A child that R1 already marked a LOD interior is never a branch: it is a
    level of detail of the object above it, not a placement of its own.
    """
    branches: List[Tuple[str, int]] = []
    for child in forest.children.get(key, ()):
        if not forest.has_renderable_descendant.get(child):
            continue
        if child in forest.lod_interior:
            continue
        child_name = forest.nodes[child].get("normalizedName") or ""
        if _is_part_of(child_name, own_name):
            continue
        branches.append(child)
    return branches


def _is_group(
    forest: Forest, key: Tuple[str, int], span: float, max_span: float
) -> Optional[str]:
    """Return the rejection rule that makes this node a grouping node, or None.

    Order is by strength of evidence, and it is observable: only `R5-span`
    reaches `diagnostics.spanRejected[]`, and that ledger exists because R5 is
    the one rule whose threshold is a CLI parameter, so a node it rejects must
    stay traceable to `parameters.maxPlacementSpanM`.  The branch rule runs last
    because it is the most heuristic of the four (a single object authored as
    `Cab` + `Trailer` trips it), so a node a stronger rule already rejected is
    labelled by that stronger rule.

    > **Decision 2026-09-01 — a LOD level is never evidence of grouping.**
    > R1 already owns every node between a LODGroup and its levels, so such a
    > node can never be elected.  Counting one as a "renderable child" or as a
    > distinct descendant family therefore rejects a group whose descent can
    > elect nothing: `Container_01` with a LODGroup over `LOD0`/`LOD1` is two
    > renderable children with two distinct names, tripped the conditional
    > `container` rule, and both the container and its LOD children were dropped —
    > a real placement counted as zero.  Every collector below now skips
    > `forest.lod_interior`.
    """
    record = forest.nodes[key]
    own_name = record.get("normalizedName") or ""
    wrapper = key not in forest.renderable
    if wrapper:
        distinct = set()
        for member in forest.renderable_descendants(key):
            if member in forest.lod_interior:
                continue
            name = forest.nodes[member].get("normalizedName") or ""
            if not _is_part_of(name, own_name):
                distinct.add(name)
        if len(distinct) >= 2:
            return "R4-multi-family"
    if own_name in GROUP_NAME_TOKENS:
        return "R4-group-name"
    if own_name in CONDITIONAL_GROUP_NAMES:
        renderable_children = [
            child
            for child in forest.children.get(key, ())
            if child in forest.renderable and child not in forest.lod_interior
        ]
        names = {forest.nodes[child].get("normalizedName") or "" for child in renderable_children}
        if len(renderable_children) >= 2 and len(names) >= 2:
            return "R4-group-name"
    if span > max_span:
        return "R5-span"
    if wrapper and len(_placement_branches(forest, key, own_name)) >= 2:
        return "R4-multi-branch"
    return None


def _nested_placement_split(
    forest: Forest, key: Tuple[str, int], own_name: str
) -> List[Tuple[str, int]]:
    """Placements nested *inside* a node that carries geometry of its own.

    R4's two multi-placement rules are gated on `not renderable(n)`, because a
    node that renders cannot simply be rejected — rejecting it would throw its
    own geometry away.  That gate made a rendering node exempt from being read as
    more than one placement at all, so `Container_01 -> Container_02 ->
    Container_03`, three renderers stacked on the `red_container_stack` anchor
    the way Unity authors a stack, elected exactly one root.

    The resolution for a rendering node is a *split*, not a rejection: the node
    keeps its own geometry and is elected, and each nested placement beneath it
    is elected separately.  A branch counts as nested when it is not a part of
    the node by name (§`_is_part_of`) and either

    * it carries the node's own normalized name — same family, so another
      instance of the same thing, never a sub-part of it; or
    * there are ≥ 2 such branches, the same threshold R4-multi-branch uses on a
      wrapper.

    A single differently-named branch stays part of the node's placement, which
    is the conservative reading and matches what a wrapper with one branch does.
    """
    branches = _placement_branches(forest, key, own_name)
    if not branches:
        return []
    if len(branches) >= 2:
        return branches
    if any(
        (forest.nodes[child].get("normalizedName") or "") == own_name
        for child in branches
    ):
        return branches
    return []


def elect_roots(
    forest: Forest, *, max_span: float
) -> Tuple[
    List[Tuple[str, int]],
    List[Dict[str, Any]],
    List[Dict[str, Any]],
    List[Dict[str, Any]],
    Dict[Tuple[str, int], List[Tuple[str, int]]],
]:
    """Breadth-first outermost-survivor election (rules R1, R4, R5).

    Spec §2.3's rule R2 ("parent(n) is elected and isPartOf(n, parent(n))") is
    deliberately absent.  Election stops the descent, so a dequeued node's parent
    is never an elected node and R2 could not fire; and the only reading that
    *would* make it fire — "nearest examined ancestor", i.e. the group we
    descended through — is falsified by spec §8 test 5, where a 24 m object split
    by `--max-placement-span-m 20` must yield two roots even though both children
    are named `Railcar_Long_*` and so read as parts of their rejected parent.
    Part-name folding is achieved structurally instead: the outermost survivor is
    elected and its whole subtree is left alone.
    """
    elected: List[Tuple[str, int]] = []
    span_rejected: List[Dict[str, Any]] = []
    unrootable: List[Dict[str, Any]] = []
    rejected: List[Tuple[Tuple[str, int], str]] = []
    owned: Dict[Tuple[str, int], List[Tuple[str, int]]] = {}
    ledgered: set = set()
    visited: set = set()

    def _ledger(node_key: Tuple[str, int], reason: str) -> None:
        node = forest.nodes[node_key]
        ledgered.add(node_key)
        unrootable.append(
            {
                "objectId": node["objectId"],
                "asset": node["asset"],
                "pathId": node["pathId"],
                "hierarchyPathHash": node.get("hierarchyPathHash"),
                "reason": reason,
            }
        )

    queue = deque(forest.roots)
    while queue:
        key = queue.popleft()
        visited.add(key)
        record = forest.nodes[key]
        if not forest.has_renderable_descendant.get(key):
            continue
        if not record.get("hierarchyComplete"):
            # Fail closed per node: neither a root nor an interior.
            _ledger(key, "hierarchy-incomplete")
            continue
        if key in forest.lod_interior:  # R1
            continue
        span = forest.pivot_span(key)
        rule = _is_group(forest, key, span, max_span)
        if rule is not None:  # R4 / R5
            if rule == "R5-span":
                span_rejected.append(
                    {
                        "objectId": record["objectId"],
                        "asset": record["asset"],
                        "pathId": record["pathId"],
                        "spanM": round(span, 3),
                        "childCount": len(forest.children.get(key, ())),
                    }
                )
            rejected.append((key, rule))
            queue.extend(forest.children.get(key, ()))
            continue
        own_name = record.get("normalizedName") or ""
        split = (
            _nested_placement_split(forest, key, own_name)
            if key in forest.renderable
            else []
        )
        elected.append(key)
        if split:
            excluded: set = set()
            for branch in split:
                excluded.update(forest.subtree_nodes.get(branch, (branch,)))
            owned[key] = [
                member
                for member in forest.subtree_nodes.get(key, (key,))
                if member not in excluded
            ]
            queue.extend(split)

    # A parent cycle makes every node in the component unreachable from a forest
    # root, so the walk above never sees it.  Sweeping is what keeps a broken
    # hierarchy from silently vanishing from the count.
    for key in sorted(forest.nodes):
        if key in visited or key in ledgered:
            continue
        if not forest.has_renderable_descendant.get(key):
            continue
        if forest.nodes[key].get("hierarchyComplete"):
            continue
        _ledger(key, "hierarchy-unreachable")

    # A rejection is only sound if the descent it ordered actually elected
    # something.  A group whose every child is a LOD interior (R1 owns them) or
    # is otherwise unelectable takes its whole subtree out of the count, and the
    # published implementation wrote no row at all — the objects simply were not
    # there any more.  Walking up from each elected root marks every node whose
    # descent produced a placement; a rejected node outside that set is ledgered
    # and the artifact reports it.  Objects never disappear silently.
    resolved: set = set()
    for key in elected:
        cursor: Optional[Tuple[str, int]] = key
        while cursor is not None and cursor not in resolved:
            resolved.add(cursor)
            cursor = forest.parent.get(cursor)

    unresolved_rejections: List[Dict[str, Any]] = []
    for key, rule in rejected:
        if key in resolved:
            continue
        node = forest.nodes[key]
        unresolved_rejections.append(
            {
                "objectId": node["objectId"],
                "asset": node["asset"],
                "pathId": node["pathId"],
                "hierarchyPathHash": node.get("hierarchyPathHash"),
                "rule": rule,
                "renderableDescendantCount": len(forest.renderable_descendants(key)),
            }
        )

    elected.sort()
    span_rejected.sort(key=lambda item: (item["asset"].casefold(), item["pathId"]))
    unrootable.sort(key=lambda item: (item["asset"].casefold(), item["pathId"]))
    unresolved_rejections.sort(key=lambda item: (item["asset"].casefold(), item["pathId"]))
    return elected, span_rejected, unrootable, unresolved_rejections, owned


# --------------------------------------------------------------------------
# geometry helpers
# --------------------------------------------------------------------------


def _point_segment_distance(
    px: float, pz: float, ax: float, az: float, bx: float, bz: float
) -> float:
    dx = bx - ax
    dz = bz - az
    length = dx * dx + dz * dz
    if length <= 0.0:
        return math.hypot(px - ax, pz - az)
    t = ((px - ax) * dx + (pz - az) * dz) / length
    t = max(0.0, min(1.0, t))
    return math.hypot(px - (ax + t * dx), pz - (az + t * dz))


def _rail_distance(
    x: float, z: float, railway: Optional[Seq[Seq[Tuple[float, float]]]]
) -> Optional[float]:
    if not railway:
        return None
    best = math.inf
    for path in railway:
        for index in range(len(path) - 1):
            ax, az = path[index]
            bx, bz = path[index + 1]
            distance = _point_segment_distance(x, z, ax, az, bx, bz)
            if distance < best:
                best = distance
    return None if best is math.inf else round(best, 3)


def _in_scope(x: float, z: float, scope: Mapping[str, Any]) -> bool:
    center_x, center_z = scope["center"]
    return (
        abs(x - center_x) <= scope["widthM"] / 2.0
        and abs(z - center_z) <= scope["depthM"] / 2.0
    )


# --------------------------------------------------------------------------
# classification
# --------------------------------------------------------------------------


def _class_hit(class_name: str, token_lists: Seq[Seq[str]]) -> bool:
    tokens = CLASS_TOKENS.get(class_name) or frozenset()
    if not tokens:
        return False
    for token_list in token_lists:
        for token in token_list:
            if token in tokens:
                return True
    return False


def _adjacent_length_hint(token_lists: Seq[Seq[str]], hints: frozenset) -> bool:
    """A length token counts only when it sits beside a container token."""
    for token_list in token_lists:
        for index, token in enumerate(token_list):
            if token not in hints:
                continue
            if index > 0 and token_list[index - 1] in CONTAINER_TOKENS:
                return True
            if index + 1 < len(token_list) and token_list[index + 1] in CONTAINER_TOKENS:
                return True
    return False


def _evidence_tokens(evidence: Mapping[str, Any]) -> List[List[str]]:
    return (
        list(evidence["name"])
        + list(evidence["weakName"])
        + list(evidence["path"])
        + list(evidence["material"])
    )


def _base_score(class_name: str, evidence: Mapping[str, Any]) -> float:
    """The N + P + M sub-total that channel A compares classes on."""
    base = 0.0
    if _class_hit(class_name, evidence["name"]):
        base += CHANNEL_WEIGHTS["N"]
    if _class_hit(class_name, evidence["weakName"]) or _class_hit(
        class_name, evidence["path"]
    ):
        base += CHANNEL_WEIGHTS["P"]
    if _class_hit(class_name, evidence["material"]):
        base += CHANNEL_WEIGHTS["M"]
    return round(base, 3)


def _own_evidence_tokens(evidence: Mapping[str, Any]) -> List[List[str]]:
    """Everything except the ancestor path — the node's own name and materials.

    > **Decision 2026-09-01 — an ancestor may add weight, never delete or select.**
    > `evidence["path"]` carries the normalized names of the nodes we descended
    > THROUGH, every one of which a grouping rule already rejected as not an
    > object.  Those names still score at channel P (§4.3 says so), but the
    > published `_candidate_classes` also let a path-only hit *suppress* a class:
    > six roots named `Vagon_NN` under a wrapper called `Depot_Zone` came back
    > `rail-wagon-unspecified` with `railBodyType: not-separable`, and the same
    > six under `Kryt_Zone` came back `rail-wagon-covered` — the wrapper's name
    > deleted `rail-wagon-unspecified` from the candidate set and flipped both
    > the separability verdict and `claimVerdict`.  Suppression now reads only
    > the root's own name, its renderable subtree's names and its material names;
    > the ancestor keeps its +0.20 and nothing more.
    """
    return (
        list(evidence["name"]) + list(evidence["weakName"]) + list(evidence["material"])
    )


def _candidate_classes(
    evidence: Mapping[str, Any],
    *,
    rail_distance: Optional[float] = None,
    rail_available: bool = False,
    rail_on_track_m: float = RAIL_ON_TRACK_M,
    rail_off_track_m: float = RAIL_OFF_TRACK_M,
) -> List[str]:
    """Deterministic candidate set; the residual classes are suppressed."""
    everything = _evidence_tokens(evidence)
    own = _own_evidence_tokens(evidence)
    flat_tokens = {token for token_list in own for token in token_list}
    candidates: List[str] = []
    for class_name in CLASS_ORDER:
        if class_name == CLASS_UNCLASSIFIED:
            continue
        if _class_hit(class_name, everything):
            candidates.append(class_name)

    has_specific_rail = any(
        _class_hit(name, own)
        for name in SPECIFIC_RAIL_BODY_CLASSES | {CLASS_RAIL_LOCOMOTIVE}
    )
    if has_specific_rail and CLASS_RAIL_UNSPECIFIED in candidates:
        candidates.remove(CLASS_RAIL_UNSPECIFIED)

    if any(name in candidates for name in CONTAINER_CLASSES):
        # §4.4: a size is establishable "only when a length token is literally
        # present in a name or material name" — an ancestor's name is neither.
        if _adjacent_length_hint(own, LENGTH_HINT_6M):
            keep = CLASS_CONTAINER_6M
        elif _adjacent_length_hint(own, LENGTH_HINT_12M):
            keep = CLASS_CONTAINER_12M
        else:
            keep = CLASS_CONTAINER_UNSPECIFIED
        candidates = [
            name for name in candidates if name not in CONTAINER_CLASSES or name == keep
        ]

    rail_context = bool(flat_tokens & (RAIL_GENERIC_TOKENS | LOCOMOTIVE_TOKENS))
    static_context = bool(flat_tokens & STATIC_TANK_QUALIFIERS)
    if rail_context and CLASS_TANK_STATIC in candidates:
        candidates.remove(CLASS_TANK_STATIC)
    if static_context and not rail_context and CLASS_RAIL_TANK in candidates:
        candidates.remove(CLASS_RAIL_TANK)

    # §4.4: "Tank wagon vs static ground tank when the name says only `tank` —
    # resolved ONLY by the rail adjacency test."  When the object's own name
    # settles nothing and both readings survive, adjacency settles it, because a
    # lexical channel that could outrank adjacency here would hand the fork back
    # to whatever word happened to stand above the object: a wrapper named
    # `Storage_Zone` scored +0.20 for the static reading and moved a tank
    # standing one metre from the rails off them.  Between the two thresholds
    # nothing is dropped — that is the genuinely unresolved band.
    if (
        rail_available
        and rail_distance is not None
        and CLASS_RAIL_TANK in candidates
        and CLASS_TANK_STATIC in candidates
    ):
        if rail_distance <= rail_on_track_m:
            candidates.remove(CLASS_TANK_STATIC)
        elif rail_distance > rail_off_track_m:
            candidates.remove(CLASS_RAIL_TANK)
    return candidates


def _score_class(
    class_name: str,
    evidence: Mapping[str, Any],
    *,
    lod_count: int,
    renderable_descendants: int,
    pivot_span: float,
    shared_name: bool,
    rail_distance: Optional[float],
    rail_available: bool,
    world_exact: bool,
    generic_name: bool,
    competing_base: float,
    rail_on_track_m: float,
    rail_off_track_m: float,
) -> Tuple[float, Dict[str, Any]]:
    channels: Dict[str, Any] = {key: 0 for key in ("N", "P", "M", "L", "S", "F", "R", "A", "X", "G")}
    # N is reserved for a token carried by a node that actually holds a renderer
    # or a LODGroup.  A name on a renderer-less node — the root's own name when
    # it is a bare wrapper, or any ancestor segment — is weak evidence and scores
    # at P, so an incidental wrapper name cannot manufacture a confident identity
    # for geometry it does not own.
    if _class_hit(class_name, evidence["name"]):
        channels["N"] = CHANNEL_WEIGHTS["N"]
    if _class_hit(class_name, evidence["weakName"]) or _class_hit(
        class_name, evidence["path"]
    ):
        channels["P"] = CHANNEL_WEIGHTS["P"]
    if _class_hit(class_name, evidence["material"]):
        channels["M"] = CHANNEL_WEIGHTS["M"]
    if lod_count >= 2:
        channels["L"] = CHANNEL_WEIGHTS["L"]
    band = CLASS_SPAN_BANDS.get(class_name)
    if band is not None and renderable_descendants >= 2 and pivot_span <= band:
        channels["S"] = CHANNEL_WEIGHTS["S"]
    if shared_name:
        channels["F"] = CHANNEL_WEIGHTS["F"]
    if not rail_available or rail_distance is None:
        channels["R"] = None
    else:
        is_rail = class_name in RAIL_CLASSES
        if is_rail and rail_distance <= rail_on_track_m:
            channels["R"] = CHANNEL_WEIGHTS["R+"]
        elif not is_rail and rail_distance > rail_on_track_m:
            channels["R"] = CHANNEL_WEIGHTS["R+"]
        elif is_rail and rail_distance > rail_off_track_m:
            channels["R"] = CHANNEL_WEIGHTS["R-"]
        else:
            channels["R"] = 0
    if competing_base >= 0.35:
        channels["A"] = CHANNEL_WEIGHTS["A"]
    if not world_exact:
        channels["X"] = CHANNEL_WEIGHTS["X"]
    if generic_name:
        channels["G"] = CHANNEL_WEIGHTS["G"]

    total = sum(value for value in channels.values() if isinstance(value, (int, float)))
    confidence = round(max(0.0, min(CONFIDENCE_CEILING, total)), 3)
    return confidence, channels


def _band(confidence: float) -> str:
    if confidence >= BAND_ESTABLISHED:
        return "established"
    if confidence >= BAND_PROBABLE:
        return "probable"
    return "unresolved"


# --------------------------------------------------------------------------
# roots document
# --------------------------------------------------------------------------


def _root_id(object_id: str) -> str:
    return "customs.root." + _sha256_text(object_id)[:12]


def _rounded_vector(value: Any, components: Seq[str]) -> Optional[Dict[str, float]]:
    if not isinstance(value, Mapping):
        return None
    result: Dict[str, float] = {}
    for component in components:
        number = _number(value.get(component))
        if number is None:
            return None
        result[component] = round(number, 6)
    return result


def build_roots_document(
    source_root: Path,
    catalog: Mapping[str, Any],
    scene_files: Seq[Mapping[str, Any]],
    facts: Mapping[str, Any],
    *,
    unitypy_module: Any,
    scope: Mapping[str, Any],
    terrain: Mapping[str, Any],
    anchors: Optional[Seq[Mapping[str, Any]]],
    parameters: Mapping[str, Any],
    allow_partial: bool,
    cross_check: bool,
) -> Dict[str, Any]:
    max_span = parameters["maxPlacementSpanM"]
    forest = Forest(facts["gameObjects"], facts["renderers"], facts["lodGroups"])
    elected, span_rejected, unrootable, unresolved_rejections, owned = elect_roots(
        forest, max_span=max_span
    )

    railway = terrain.get("railway") if cross_check else None
    envelope = terrain.get("envelope") if cross_check else None
    rail_available = bool(railway)

    material_by_id = {
        record["objectId"]: record
        for record in facts["materials"]
        if record.get("objectId")
    }

    name_counts: Dict[str, int] = {}
    for key in elected:
        name = forest.nodes[key].get("normalizedName") or ""
        name_counts[name] = name_counts.get(name, 0) + 1

    prepared: List[Dict[str, Any]] = []
    for key in elected:
        record = forest.nodes[key]
        position = _world_position(record)
        if position is None:
            # An elected root always has a complete hierarchy, so this cannot be
            # reached; it is kept fail-closed rather than assumed.
            unrootable.append(
                {
                    "objectId": record["objectId"],
                    "asset": record["asset"],
                    "pathId": record["pathId"],
                    "hierarchyPathHash": record.get("hierarchyPathHash"),
                    "reason": "world-position-unavailable",
                }
            )
            continue
        # A split root owns everything under it EXCEPT the nested placements it
        # was split from; each of those is a root in its own right and its
        # geometry, materials and pivots belong to it, not to this row.
        subtree = owned.get(key) or forest.subtree_nodes.get(key, [key])
        renderable_members = [
            member for member in subtree if member in forest.renderable
        ]
        pivot_span = _pivot_span_of(forest, renderable_members)
        world = record.get("world") or {}
        world_exact = bool(world.get("worldExact"))

        material_names: List[str] = []
        material_ids: List[str] = []
        slot_count = 0
        for member in subtree:
            for renderer in forest.renderers_by_key.get(member, ()):
                slot_count += _integer(renderer.get("materialSlotCount")) or 0
                for name in renderer.get("materialNames") or ():
                    if isinstance(name, str) and name and name not in material_names:
                        material_names.append(name)
                for identity in renderer.get("materialIds") or ():
                    if isinstance(identity, str) and identity not in material_ids:
                        material_ids.append(identity)
        material_names.sort()
        material_ids.sort()

        lod_count = 0
        for member in subtree:
            for group in forest.lod_groups_by_key.get(member, ()):
                lod_count = max(lod_count, _integer(group.get("lodCount")) or 0)

        hierarchy_path = record.get("hierarchyPath") or ""
        segments = [segment for segment in hierarchy_path.split("/") if segment]
        # Strong name evidence = every node under this root that actually carries
        # a renderer or a LODGroup, the root itself included when it does.  A
        # root that renders nothing is a wrapper: its name still identifies the
        # placement, but only at ancestor strength (channel P).
        renderable_self = key in forest.renderable
        strong_names = [
            _tokenize(forest.nodes[member].get("normalizedName"))
            for member in renderable_members
        ]
        weak_names = (
            [] if renderable_self else [_tokenize(record.get("normalizedName"))]
        )
        evidence = {
            "name": strong_names,
            "weakName": weak_names,
            "path": [_tokenize(segment) for segment in segments[:-1]],
            "material": [_tokenize(name) for name in material_names],
        }

        color_evidence: Any = "none"
        for identity in material_ids:
            material = material_by_id.get(identity)
            if material is None:
                continue
            for entry in sorted(
                material.get("colorProperties") or (),
                key=lambda item: str(item.get("name", "")),
            ):
                name = str(entry.get("name") or "")
                if "color" not in name.casefold():
                    continue
                components = [
                    _number(entry.get(component)) for component in ("r", "g", "b")
                ]
                if any(component is None for component in components):
                    continue
                if max(components) - min(components) <= COLOR_NEUTRAL_SPREAD:
                    continue
                alpha = _number(entry.get("a"))
                color_evidence = {
                    "property": name[:64],
                    "r": round(components[0], 3),
                    "g": round(components[1], 3),
                    "b": round(components[2], 3),
                    "a": round(alpha, 3) if alpha is not None else 1.0,
                }
                break
            if color_evidence != "none":
                break

        prepared.append(
            {
                "key": key,
                "record": record,
                "position": position,
                "worldExact": world_exact,
                "subtreeCount": len(subtree) - 1,
                "renderableCount": len(renderable_members),
                "pivotSpan": pivot_span,
                "materialNames": material_names[:MAX_SCALAR_LIST],
                "materialSlotCount": slot_count,
                "lodCount": lod_count,
                "evidence": evidence,
                "colorEvidence": color_evidence,
                "hierarchyDepth": len(segments),
                "industrial": bool(
                    {
                        token
                        for group in evidence.values()
                        for token_list in group
                        for token in token_list
                    }
                    & INDUSTRIAL_LEXICON
                ),
            }
        )

    unrootable.sort(key=lambda item: (item["asset"].casefold(), item["pathId"]))

    # -- classification ----------------------------------------------------
    roots: List[Dict[str, Any]] = []
    for item in prepared:
        record = item["record"]
        x, y, z = item["position"]
        rail_distance = _rail_distance(x, z, railway)
        normalized = record.get("normalizedName") or ""
        generic = normalized == "" or normalized in GENERIC_NAMES
        candidates = _candidate_classes(
            item["evidence"],
            rail_distance=rail_distance,
            rail_available=rail_available,
            rail_on_track_m=parameters["railOnTrackM"],
            rail_off_track_m=parameters["railOffTrackM"],
        )

        base_scores: Dict[str, float] = {
            class_name: _base_score(class_name, item["evidence"])
            for class_name in candidates
        }

        scored: List[Tuple[float, int, str, Dict[str, Any]]] = []
        for class_name in candidates:
            competing_base = max(
                (value for other, value in base_scores.items() if other != class_name),
                default=0.0,
            )
            confidence, channels = _score_class(
                class_name,
                item["evidence"],
                lod_count=item["lodCount"],
                renderable_descendants=item["renderableCount"],
                pivot_span=item["pivotSpan"],
                shared_name=name_counts.get(normalized, 0) >= 2,
                rail_distance=rail_distance,
                rail_available=rail_available,
                world_exact=item["worldExact"],
                generic_name=generic,
                competing_base=competing_base,
                rail_on_track_m=parameters["railOnTrackM"],
                rail_off_track_m=parameters["railOffTrackM"],
            )
            scored.append((confidence, CLASS_RANK[class_name], class_name, channels))
        scored.sort(key=lambda entry: (-entry[0], entry[1]))

        if scored:
            confidence, _rank, class_name, channels = scored[0]
            competing = [
                {"class": entry[2], "score": entry[0]}
                for entry in scored[1:]
                if entry[0] > 0
            ][:4]
        else:
            class_name = CLASS_UNCLASSIFIED
            confidence, channels = _score_class(
                CLASS_UNCLASSIFIED,
                item["evidence"],
                lod_count=item["lodCount"],
                renderable_descendants=item["renderableCount"],
                pivot_span=item["pivotSpan"],
                shared_name=name_counts.get(normalized, 0) >= 2,
                rail_distance=rail_distance,
                rail_available=rail_available,
                world_exact=item["worldExact"],
                generic_name=generic,
                competing_base=0.0,
                rail_on_track_m=parameters["railOnTrackM"],
                rail_off_track_m=parameters["railOffTrackM"],
            )
            competing = []

        world = record.get("world") or {}
        roots.append(
            {
                "rootId": _root_id(record["objectId"]),
                "objectId": record["objectId"],
                "asset": record["asset"],
                "pathId": record["pathId"],
                "sourceFile": record.get("sourceFile"),
                "sourceRole": record.get("sourceRole"),
                "sceneIndex": record.get("sceneIndex"),
                "normalizedName": normalized,
                "nameHash": record.get("nameHash"),
                "hierarchyPathHash": record.get("hierarchyPathHash"),
                "hierarchyDepth": item["hierarchyDepth"],
                "world": {
                    "position": {
                        "x": round(x, 6),
                        "y": round(y, 6),
                        "z": round(z, 6),
                    },
                    "rotation": _rounded_vector(world.get("rotation"), ("x", "y", "z", "w"))
                    or {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0},
                    "scale": _rounded_vector(world.get("scale"), ("x", "y", "z"))
                    or {"x": 1.0, "y": 1.0, "z": 1.0},
                },
                "positionExact": item["worldExact"],
                "inScope": _in_scope(x, z, scope),
                "railDistanceM": rail_distance,
                "descendantCount": item["subtreeCount"],
                "renderableDescendantCount": item["renderableCount"],
                "pivotSpanM": round(item["pivotSpan"], 3),
                "lodCount": item["lodCount"],
                "materialSlotCount": item["materialSlotCount"],
                "materialNames": item["materialNames"],
                "colorEvidence": item["colorEvidence"],
                "class": class_name,
                "confidence": confidence,
                "band": _band(confidence),
                "confidenceChannels": channels,
                "competingClasses": competing,
                "_industrial": item["industrial"],
                "_mirrored": (-x, -z),
            }
        )

    roots.sort(
        key=lambda item: (
            item["class"],
            item["world"]["position"]["x"],
            item["world"]["position"]["z"],
            item["objectId"],
        )
    )

    inexact = sorted(
        (
            {
                "objectId": item["objectId"],
                "asset": item["asset"],
                "pathId": item["pathId"],
                "hierarchyPathHash": item["hierarchyPathHash"],
                "reason": "world-transform-inexact",
            }
            for item in roots
            if not item["positionExact"]
        ),
        key=lambda item: (item["asset"].casefold(), item["pathId"]),
    )

    # -- coincident roots (reported, never merged) -------------------------
    coincident_groups: List[Dict[str, Any]] = []
    parent_index = list(range(len(roots)))

    def _find(index: int) -> int:
        while parent_index[index] != index:
            parent_index[index] = parent_index[parent_index[index]]
            index = parent_index[index]
        return index

    threshold = parameters["coincidentRootM"]
    for i in range(len(roots)):
        for j in range(i + 1, len(roots)):
            first = roots[i]["world"]["position"]
            second = roots[j]["world"]["position"]
            if (
                math.hypot(first["x"] - second["x"], first["z"] - second["z"])
                <= threshold
            ):
                a, b = _find(i), _find(j)
                if a != b:
                    parent_index[max(a, b)] = min(a, b)
    buckets: Dict[int, List[int]] = {}
    for index in range(len(roots)):
        buckets.setdefault(_find(index), []).append(index)
    for members in buckets.values():
        if len(members) < 2:
            continue
        widest = 0.0
        for i in members:
            for j in members:
                first = roots[i]["world"]["position"]
                second = roots[j]["world"]["position"]
                widest = max(
                    widest,
                    math.hypot(first["x"] - second["x"], first["z"] - second["z"]),
                )
        coincident_groups.append(
            {
                "rootIds": sorted(roots[index]["rootId"] for index in members)[
                    :MAX_SCALAR_LIST
                ],
                "distanceM": round(widest, 3),
            }
        )
    coincident_groups.sort(key=lambda item: item["rootIds"][0])

    # -- frame checks ------------------------------------------------------
    fortress_x, fortress_z = scope["fortress"]
    witness_distance: Optional[float] = None
    witness_root_id: Optional[str] = None
    mirrored_witness: Optional[float] = None
    for item in roots:
        position = item["world"]["position"]
        distance = math.hypot(position["x"] - fortress_x, position["z"] - fortress_z)
        if witness_distance is None or distance < witness_distance:
            witness_distance = distance
            witness_root_id = item["rootId"]
        mirrored_x, mirrored_z = item["_mirrored"]
        mirrored_distance = math.hypot(mirrored_x - fortress_x, mirrored_z - fortress_z)
        if mirrored_witness is None or mirrored_distance < mirrored_witness:
            mirrored_witness = mirrored_distance

    tolerance = parameters["frameWitnessToleranceM"]
    witness_confirmed = witness_distance is not None and witness_distance <= tolerance

    source_in_scope = [item for item in roots if item["inScope"]]
    mirrored_in_scope = [
        item for item in roots if _in_scope(item["_mirrored"][0], item["_mirrored"][1], scope)
    ]

    def _density(members: Seq[Mapping[str, Any]]) -> float:
        if not members:
            return 0.0
        return round(
            sum(1 for item in members if item["_industrial"]) / len(members), 3
        )

    source_density = _density(source_in_scope)
    mirrored_density = _density(mirrored_in_scope)
    source_industrial = sum(1 for item in source_in_scope if item["_industrial"])
    mirrored_industrial = sum(1 for item in mirrored_in_scope if item["_industrial"])

    mirror_wins = False
    if witness_distance is not None and mirrored_witness is not None:
        mirror_wins = mirrored_witness < witness_distance
    # The density half compares two ratios, and a ratio over a sample of one is
    # not a measurement: ONE lexicon-hitting root in the mirrored box scores
    # 1.000 and used to outvote nine in-scope roots at 0.889, failing a correct
    # run on a single stray object.  Both boxes must hold at least
    # MIRROR_MIN_SAMPLE roots, and the mirrored reading must also win on the
    # absolute count of industrial roots, so the verdict is weighted by evidence
    # and not by an unweighted fraction.
    if (
        len(source_in_scope) >= MIRROR_MIN_SAMPLE
        and len(mirrored_in_scope) >= MIRROR_MIN_SAMPLE
        and mirrored_density > source_density
        and mirrored_industrial > source_industrial
    ):
        mirror_wins = True

    if mirror_wins:
        verdict = "contradicted"
    elif witness_confirmed:
        verdict = "confirmed"
    else:
        verdict = "unverified"

    outside_count: Optional[int] = None
    outside_fraction: Optional[float] = None
    if envelope is not None:
        margin = parameters["terrainMarginM"]
        min_x, max_x, min_z, max_z = envelope
        outside_count = sum(
            1
            for item in roots
            if not (
                min_x - margin <= item["world"]["position"]["x"] <= max_x + margin
                and min_z - margin <= item["world"]["position"]["z"] <= max_z + margin
            )
        )
        outside_fraction = round(outside_count / len(roots), 3) if roots else 0.0

    frame_check = {
        "fortressWitness": "confirmed" if witness_confirmed else "failed",
        "fortressWitnessDistanceM": round(witness_distance, 3)
        if witness_distance is not None
        else None,
        "fortressWitnessRootId": witness_root_id if witness_confirmed else None,
        "sourceFrameRootCount": len(source_in_scope),
        "mirroredFrameRootCount": len(mirrored_in_scope),
        "sourceFrameWitnessDistanceM": round(witness_distance, 3)
        if witness_distance is not None
        else None,
        "mirroredFrameWitnessDistanceM": round(mirrored_witness, 3)
        if mirrored_witness is not None
        else None,
        "sourceFrameIndustrialDensity": source_density,
        "mirroredFrameIndustrialDensity": mirrored_density,
        "terrainEnvelope": "available" if envelope is not None else "unavailable",
        "outsideTerrainEnvelopeCount": outside_count,
        "outsideTerrainEnvelopeFraction": outside_fraction,
        "verdict": verdict,
    }
    frame_verified = verdict == "confirmed"

    # -- scope integrity ---------------------------------------------------
    elected_in_scope_keys = {
        (item["asset"], item["pathId"]) for item in roots if item["inScope"]
    }
    scope_integrity = "sound"
    # Termination is by membership, not by a hop budget.  A `MAX_HIERARCHY_DEPTH`
    # bound here could never fire on the very case it is meant to catch: a node
    # that lost `hierarchyComplete` *to* the depth cap always stands more than
    # MAX_HIERARCHY_DEPTH hops below the top of its chain, so a capped walk
    # returned "sound" for every input and the verdict was decorative.  `cleared`
    # both breaks parent cycles and memoises chains already proven clean, so the
    # whole sweep stays linear in the node count.
    cleared: set = set()
    for entry in unrootable:
        cursor: Optional[Tuple[str, int]] = (entry["asset"], entry["pathId"])
        while cursor is not None and cursor not in cleared:
            if cursor in elected_in_scope_keys:
                scope_integrity = "suspect"
                break
            cleared.add(cursor)
            cursor = forest.parent.get(cursor)
        if scope_integrity == "suspect":
            break

    # -- counts ------------------------------------------------------------
    rail_in_scope = [item for item in source_in_scope if item["class"] in RAIL_CLASSES]
    container_in_scope = [
        item for item in source_in_scope if item["class"] in CONTAINER_CLASSES
    ]
    other_industrial_in_scope = [
        item for item in source_in_scope if item["class"].startswith("industrial-")
    ]

    computed_complete = (
        bool(catalog.get("complete"))
        and not facts["fileLoadFailures"]
        and not facts["objectParseFailures"]
        and not facts["skippedObjects"]
        and not facts["dependencyFailures"]
        and not unrootable
        and bool(facts["sceneFileFacts"])
        and all(
            entry.get("digestComplete") and entry.get("bindingVerified")
            for entry in facts["sceneFileFacts"]
        )
    )
    complete = computed_complete and not allow_partial
    # An unresolved rejection means placed objects left the count without ever
    # becoming a root, so the count is a floor, exactly as an unrootable node is.
    root_count_is_lower_bound = bool(unrootable) or bool(unresolved_rejections)

    # -- separability ------------------------------------------------------
    # Separability is read against the same band set the verdicts are computed
    # from.  Reading it over ALL bands let one junk row decide: six identical
    # `Vagon_NN` plus a single NaN-transform bystander at confidence 0.150
    # flipped `railBodyType` from not-separable to separable, and with it the
    # `closedFreightWagons` / `hopperWagons` verdicts.  A row nobody may build
    # against may not decide what is separable either.
    def _confident(members: Seq[Mapping[str, Any]]) -> List[Mapping[str, Any]]:
        return [item for item in members if item["band"] in CONFIDENT_BANDS]

    rail_confident = _confident(rail_in_scope)
    container_confident = _confident(container_in_scope)

    rail_families = {item["normalizedName"] for item in rail_confident}
    body_typed = [
        item for item in rail_confident if item["class"] in SPECIFIC_RAIL_BODY_CLASSES
    ]
    if body_typed:
        rail_body = {
            "verdict": "separable",
            "reason": "at least one established or probable rail root carries a "
            "body-type token in its name, hierarchy or material names",
            "familiesObserved": len(rail_families),
        }
    else:
        rail_body = {
            "verdict": "not-separable",
            "reason": "no body-type token in any established or probable rail root's "
            "name, hierarchy or material names; closed, hopper and gondola bodies "
            "share one chassis and this pipeline reads no mesh, bounds or height",
            "familiesObserved": len(rail_families),
        }
    sized_containers = [
        item
        for item in container_confident
        if item["class"] in (CLASS_CONTAINER_6M, CLASS_CONTAINER_12M)
    ]
    container_size = {
        "verdict": "separable" if sized_containers else "not-separable",
        "reason": "a length token sits beside a container token"
        if sized_containers
        else "no length token in any name or material",
    }
    tank_separability = {
        "verdict": "separable" if rail_available else "not-separable",
        "reason": "rail adjacency available"
        if rail_available
        else "rail polylines unavailable, so a bare tank name cannot be resolved",
    }
    classification = {
        "separability": {
            "railBodyType": rail_body,
            "containerSize": container_size,
            "tankWagonVsStaticTank": tank_separability,
        },
        "railAdjacency": "available" if rail_available else "unavailable",
    }

    # -- cross-checks ------------------------------------------------------
    def _compatible(class_name: str, anchor_type: str) -> bool:
        if anchor_type == "railcar":
            return class_name in RAIL_CLASSES
        if anchor_type == "container":
            return class_name in CONTAINER_CLASSES
        return False

    anchor_rows: Any = "unavailable"
    anchors_verdict = "unavailable"
    nine_proxy_rail = 0
    nine_proxy_container = 0
    if cross_check and anchors:
        rows: List[Dict[str, Any]] = []
        any_within = False
        for anchor in anchors:
            best: Optional[Tuple[float, Dict[str, Any]]] = None
            for item in roots:
                if not _compatible(item["class"], anchor["type"]):
                    continue
                position = item["world"]["position"]
                distance = math.hypot(
                    position["x"] - anchor["x"], position["z"] - anchor["z"]
                )
                if best is None or distance < best[0]:
                    best = (distance, item)
            row = {
                "featureId": anchor["featureId"],
                "anchor": {"x": round(anchor["x"], 3), "z": round(anchor["z"], 3)},
                "nearestRootId": best[1]["rootId"] if best else None,
                "nearestClass": best[1]["class"] if best else None,
                "distanceM": round(best[0], 3) if best else None,
                "compatible": bool(best is not None and best[0] <= ANCHOR_COMPATIBLE_M),
            }
            if row["compatible"]:
                any_within = True
            rows.append(row)
        rows.sort(key=lambda item: item["featureId"])
        anchor_rows = rows
        anchors_verdict = "anchors-supported" if any_within else "anchors-contradicted"

        # D5 asks whether NINE REAL OBJECTS stand on the nine anchors.  The
        # anchor table above is deliberately many-to-one (it answers "what is
        # nearest to this anchor"), but the D5 count must not be: three anchors
        # sitting within a metre of ONE root used to satisfy three of the nine,
        # so `nine-proxy-plan-supported` was reachable with far fewer objects
        # than it claims.  The pairing below is one anchor to one root, nearest
        # pair first, and only roots a verdict may be built on (established or
        # probable) are eligible — an unresolved row is not an object anyone
        # would build against.
        pairs: List[Tuple[float, str, str, str]] = []
        for anchor in anchors:
            for item in roots:
                if item["band"] not in CONFIDENT_BANDS:
                    continue
                if not _compatible(item["class"], anchor["type"]):
                    continue
                position = item["world"]["position"]
                distance = math.hypot(
                    position["x"] - anchor["x"], position["z"] - anchor["z"]
                )
                if distance <= NINE_PROXY_MATCH_M:
                    pairs.append(
                        (
                            round(distance, 6),
                            anchor["featureId"],
                            item["rootId"],
                            anchor["type"],
                        )
                    )
        pairs.sort()
        matched_anchors: set = set()
        matched_roots: set = set()
        for _distance, feature_id, root_id, anchor_type in pairs:
            if feature_id in matched_anchors or root_id in matched_roots:
                continue
            matched_anchors.add(feature_id)
            matched_roots.add(root_id)
            if anchor_type == "railcar":
                nine_proxy_rail += 1
            elif anchor_type == "container":
                nine_proxy_container += 1

    # -- claim verdict -----------------------------------------------------
    rail_body_separable = rail_body["verdict"] == "separable"

    def _count_class(members: Seq[Mapping[str, Any]], class_name: str) -> int:
        return sum(1 for item in members if item["class"] == class_name)

    verdicts: Dict[str, str] = {}
    verdicts["railStockTotal"] = (
        "supported"
        if len(rail_confident) == CLAIM_COMPONENTS["railStockTotal"]
        else "contradicted"
    )
    verdicts["containerTotal"] = (
        "supported"
        if len(container_confident) == CLAIM_COMPONENTS["containerTotal"]
        else "contradicted"
    )
    # Spec §5 D2 scopes `unfounded` to the two body types that share one chassis
    # and are therefore invisible to a name-and-material pipeline.  A tank wagon
    # is NOT one of them: `cisterna`/`tank` is its own word and its own material
    # vocabulary, so the tank count is evidence-bearing and gets a real verdict
    # even when the closed/hopper/gondola split is not separable.
    if not rail_body_separable:
        verdicts["closedFreightWagons"] = "unfounded"
        verdicts["hopperWagons"] = "unfounded"
    else:
        verdicts["closedFreightWagons"] = (
            "supported"
            if _count_class(rail_confident, CLASS_RAIL_COVERED)
            == CLAIM_COMPONENTS["closedFreightWagons"]
            else "contradicted"
        )
        verdicts["hopperWagons"] = (
            "supported"
            if _count_class(rail_confident, CLASS_RAIL_HOPPER)
            == CLAIM_COMPONENTS["hopperWagons"]
            else "contradicted"
        )
    verdicts["tankWagons"] = (
        "supported"
        if _count_class(rail_confident, CLASS_RAIL_TANK)
        == CLAIM_COMPONENTS["tankWagons"]
        else "contradicted"
    )
    if len(container_confident) != CLAIM_COMPONENTS["redContainers6m"]:
        verdicts["redContainers6m"] = "contradicted"
    elif container_size["verdict"] == "not-separable" or all(
        item["colorEvidence"] == "none" for item in container_confident
    ):
        verdicts["redContainers6m"] = "unfounded"
    else:
        verdicts["redContainers6m"] = "supported"

    values = list(verdicts.values())
    nine_proxy = (
        nine_proxy_rail == 6
        and nine_proxy_container == 3
        and anchor_rows != "unavailable"
    )
    if not complete or not frame_verified or root_count_is_lower_bound:
        overall = "inconclusive"
    elif nine_proxy:
        overall = "nine-proxy-plan-supported"
    elif all(value == "supported" for value in values):
        overall = "supported"
    elif all(value == "contradicted" for value in values):
        overall = "contradicted"
    elif "contradicted" not in values:
        overall = "unfounded"
    else:
        overall = "partially-contradicted"
    claim_verdict = dict(verdicts)
    claim_verdict["overall"] = overall

    # -- families ----------------------------------------------------------
    family_index: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for item in roots:
        key = (item["normalizedName"], item["class"])
        family = family_index.get(key)
        if family is None:
            family = {
                "normalizedName": item["normalizedName"],
                "class": item["class"],
                "instanceCount": 0,
                "inScopeCount": 0,
                "_confidences": [],
                "exampleRootIds": [],
            }
            family_index[key] = family
        family["instanceCount"] += 1
        if item["inScope"]:
            family["inScopeCount"] += 1
        family["_confidences"].append(item["confidence"])
        if len(family["exampleRootIds"]) < 3:
            family["exampleRootIds"].append(item["rootId"])
    families: List[Dict[str, Any]] = []
    for family in family_index.values():
        confidences = family.pop("_confidences")
        family["meanConfidence"] = round(sum(confidences) / len(confidences), 3)
        families.append(family)
    families.sort(
        key=lambda item: (-item["instanceCount"], item["normalizedName"], item["class"])
    )

    for item in roots:
        item.pop("_industrial", None)
        item.pop("_mirrored", None)

    document = {
        "schemaVersion": ROOTS_SCHEMA_VERSION,
        "generator": {
            "name": GENERATOR_NAME,
            "unityPyVersion": _clean_text(
                getattr(unitypy_module, "__version__", "unknown"), limit=80
            ),
            "selectionMode": "catalog-first-customs-only",
        },
        "parameters": {
            "scopeId": scope["scopeId"],
            "scopeCenter": {"x": scope["center"][0], "z": scope["center"][1]},
            "scopeWidthM": scope["widthM"],
            "scopeDepthM": scope["depthM"],
            "frameId": FRAME_ID,
            "maxPlacementSpanM": parameters["maxPlacementSpanM"],
            "coincidentRootM": parameters["coincidentRootM"],
            "frameWitnessToleranceM": parameters["frameWitnessToleranceM"],
            "terrainMarginM": parameters["terrainMarginM"],
            "railOnTrackM": parameters["railOnTrackM"],
            "railOffTrackM": parameters["railOffTrackM"],
            # A knob that can change the frame verdict, so it is pinned like the
            # rest: below this many roots in either box the mirror falsifier's
            # density half is not evaluated at all.
            "mirrorMinSampleRoots": MIRROR_MIN_SAMPLE,
        },
        "source": {
            "rootName": _clean_text(source_root.name) or "game-data",
            "catalogFiles": list(catalog["catalogFiles"]),
            "catalogFileFacts": list(catalog.get("catalogFileFacts") or ()),
            "sceneFiles": list(facts["sceneFileFacts"]),
            "loadedCatalogFileCount": catalog["loadedFileCount"],
            "loadedSceneFileCount": facts["loadedSceneFileCount"],
            "loadedFileCount": catalog["loadedFileCount"] + facts["loadedSceneFileCount"],
        },
        "sceneIndices": sorted({selection["sceneIndex"] for selection in scene_files})[
            :MAX_SCALAR_LIST
        ],
        "complete": complete,
        "frameVerified": frame_verified,
        "scopeIntegrity": scope_integrity,
        "frameCheck": frame_check,
        "claimUnderTest": {
            "source": CLAIM_SOURCE,
            "statement": CLAIM_STATEMENT,
            "components": dict(CLAIM_COMPONENTS),
        },
        "claimVerdict": claim_verdict,
        "classification": classification,
        "counts": {
            "gameObjectsParsed": len(facts["gameObjects"]),
            "renderablesParsed": len(facts["renderers"]),
            "electedRoots": len(roots),
            "rootsInScope": len(source_in_scope),
            "railRootsInScope": len(rail_in_scope),
            "containerRootsInScope": len(container_in_scope),
            # §5's D1/D3 rows are computed over `confidentBands` only, so the
            # all-band counts above cannot be applied to them by hand: an
            # operator who tried reached the OPPOSITE conclusion from the
            # artifact's own verdict.  The band-matched counts are emitted
            # beside them, and `confidentBands` names the set that was used.
            "railRootsInScopeConfident": len(rail_confident),
            "containerRootsInScopeConfident": len(container_confident),
            "confidentBands": list(CONFIDENT_BANDS),
            "otherIndustrialRootsInScope": len(other_industrial_in_scope),
            "establishedRootsInScope": sum(
                1 for item in source_in_scope if item["band"] == "established"
            ),
            "probableRootsInScope": sum(
                1 for item in source_in_scope if item["band"] == "probable"
            ),
            "unresolvedRootsInScope": sum(
                1 for item in source_in_scope if item["band"] == "unresolved"
            ),
            "spanRejectedCount": len(span_rejected),
            "unrootableNodeCount": len(unrootable),
            "unresolvedRejectionCount": len(unresolved_rejections),
            "coincidentRootGroupCount": len(coincident_groups),
            "rootCountIsLowerBound": root_count_is_lower_bound,
            "skippedNonRootsObjects": facts["skippedNonRootsObjects"],
            "skippedObjects": len(facts["skippedObjects"]),
        },
        "roots": roots,
        "families": families,
        "crossChecks": {"anchors": anchor_rows, "anchorsVerdict": anchors_verdict},
        "diagnostics": {
            "fileLoadFailures": list(facts["fileLoadFailures"]),
            "objectParseFailures": list(facts["objectParseFailures"]),
            "skippedObjects": list(facts["skippedObjects"]),
            "dependencyFailures": list(facts["dependencyFailures"]),
            "droppedForbiddenFieldCount": facts["droppedForbiddenFieldCount"],
            "unrootableNodes": unrootable,
            "unresolvedRejections": unresolved_rejections,
            "inexactRoots": inexact,
            "spanRejected": span_rejected,
            "coincidentRootGroups": coincident_groups,
            "prefabLinkage": "unavailable",
        },
    }
    return _finalize_artifact(document)


def build_operator_report(document: Mapping[str, Any]) -> Dict[str, Any]:
    """A projection of the roots document; it never adds a fact."""
    families = sorted(
        (dict(family) for family in document.get("families") or ()),
        key=lambda item: (-item["inScopeCount"], -item["instanceCount"], item["normalizedName"]),
    )
    counts = document.get("counts") or {}
    frame_check = document.get("frameCheck") or {}
    report = {
        "schemaVersion": REPORT_SCHEMA_VERSION,
        "generator": {
            "name": f"{GENERATOR_NAME}-report",
            "selectionMode": "roots-derived",
        },
        "rootsSchemaVersion": _integer(document.get("schemaVersion")),
        "sourceRootName": _clean_text(
            _value(document.get("source"), "rootName") or "game-data"
        ),
        "sceneIndices": list(document.get("sceneIndices") or ())[:MAX_SCALAR_LIST],
        "complete": bool(document.get("complete")),
        "frameVerified": bool(document.get("frameVerified")),
        "scopeIntegrity": document.get("scopeIntegrity"),
        "rankedBy": "inScopeCount",
        "families": families,
        "claimVerdict": dict(document.get("claimVerdict") or {}),
        "classification": json.loads(json.dumps(document.get("classification") or {})),
        "crossChecks": json.loads(json.dumps(document.get("crossChecks") or {})),
        "counts": {
            # The band-matched counts travel with the roster because the roster
            # is where an operator reads `claimVerdict`; the all-band counts and
            # the verdicts are computed over different sets and a roster that
            # showed only one of them invites the same hand-computed
            # contradiction the roots document was fixed for.
            "railRootsInScope": counts.get("railRootsInScope"),
            "containerRootsInScope": counts.get("containerRootsInScope"),
            "railRootsInScopeConfident": counts.get("railRootsInScopeConfident"),
            "containerRootsInScopeConfident": counts.get("containerRootsInScopeConfident"),
            "confidentBands": list(counts.get("confidentBands") or ()),
            "spanRejectedCount": counts.get("spanRejectedCount"),
            "unrootableNodeCount": counts.get("unrootableNodeCount"),
            "unresolvedRejectionCount": counts.get("unresolvedRejectionCount"),
            "coincidentRootGroupCount": counts.get("coincidentRootGroupCount"),
            "outsideTerrainEnvelopeCount": frame_check.get("outsideTerrainEnvelopeCount"),
        },
    }
    return _finalize_artifact(report)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def _validate_roots_paths(source_value: str, output_value: str) -> Tuple[Path, Path]:
    """Census path rules plus the pipeline's 'outside the repository' rule."""
    source_root, output_path = census._validate_paths_noclobber(source_value, output_value)
    if selector._path_is_inside(output_path, REPO_ROOT):
        raise RootsError("output must be outside this repository")
    return source_root, output_path


def _parse_center(value: str) -> Tuple[float, float]:
    parts = [part.strip() for part in value.split(",")]
    if len(parts) != 2:
        raise RootsError("--scope-center must be X,Z")
    try:
        return (float(parts[0]), float(parts[1]))
    except ValueError as error:
        raise RootsError("--scope-center must be two finite numbers") from error


def _parse_size(value: str) -> Tuple[float, float]:
    parts = [part.strip() for part in re.split(r"[xX]", value)]
    if len(parts) != 2:
        raise RootsError("--scope-size must be WxD")
    try:
        width, depth = float(parts[0]), float(parts[1])
    except ValueError as error:
        raise RootsError("--scope-size must be two finite numbers") from error
    if width <= 0 or depth <= 0:
        raise RootsError("--scope-size must be positive")
    return (width, depth)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Measure the placed industrial roots inside the Customs rail-yard scope. "
            "Scalars only: no payloads are exported and no executable is ever started."
        )
    )
    parser.add_argument("--source", required=True, help="User-supplied local game-data directory")
    parser.add_argument(
        "--output",
        required=True,
        help="Roots JSON path outside --source and outside this repository",
    )
    parser.add_argument(
        "--report", help="Optional operator roster JSON path; same rules, must differ"
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
        help="Explicitly allow an incomplete or frame-unverified output (marks complete:false)",
    )
    parser.add_argument("--scope-center", help="Scope centre as X,Z (default: scene manifest)")
    parser.add_argument("--scope-size", help="Scope size as WxD (default: scene manifest)")
    parser.add_argument(
        "--max-placement-span-m", type=float, default=DEFAULT_MAX_PLACEMENT_SPAN_M
    )
    parser.add_argument("--coincident-root-m", type=float, default=DEFAULT_COINCIDENT_ROOT_M)
    parser.add_argument(
        "--frame-witness-tolerance-m", type=float, default=DEFAULT_FRAME_WITNESS_TOLERANCE_M
    )
    parser.add_argument("--terrain-margin-m", type=float, default=DEFAULT_TERRAIN_MARGIN_M)
    parser.add_argument(
        "--scene-manifest",
        default=str(REPO_ROOT / "public/assets/3d/customs/scene-manifest.json"),
    )
    parser.add_argument("--terrain", default=str(REPO_ROOT / "public/data/customs-3d.json"))
    parser.add_argument(
        "--prop-features", default=str(REPO_ROOT / "data/customs-prop-features.json")
    )
    parser.add_argument(
        "--no-cross-check",
        action="store_true",
        help="Skip the degradable repo cross-checks; the frame witness still gates",
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
        for value in (
            args.max_placement_span_m,
            args.coincident_root_m,
            args.frame_witness_tolerance_m,
            args.terrain_margin_m,
        ):
            if not math.isfinite(value) or value < 0:
                raise RootsError("numeric options must be finite and non-negative")

        source_root, output_path = _validate_roots_paths(args.source, args.output)
        report_path: Optional[Path] = None
        if args.report:
            _, report_path = _validate_roots_paths(args.source, args.report)
            if report_path == output_path:
                raise RootsError("--report must differ from --output")

        scope = load_scene_manifest(Path(args.scene_manifest).expanduser())
        if args.scope_center:
            scope["center"] = _parse_center(args.scope_center)
        if args.scope_size:
            scope["widthM"], scope["depthM"] = _parse_size(args.scope_size)

        cross_check = not args.no_cross_check
        terrain = (
            load_terrain_facts(Path(args.terrain).expanduser())
            if cross_check
            else {"envelope": None, "railway": None}
        )
        anchors = (
            load_prop_feature_anchors(Path(args.prop_features).expanduser())
            if cross_check
            else None
        )

        parameters = {
            "maxPlacementSpanM": args.max_placement_span_m,
            "coincidentRootM": args.coincident_root_m,
            "frameWitnessToleranceM": args.frame_witness_tolerance_m,
            "terrainMarginM": args.terrain_margin_m,
            "railOnTrackM": RAIL_ON_TRACK_M,
            "railOffTrackM": RAIL_OFF_TRACK_M,
        }

        catalog_files = discover_catalog_files(source_root)
        if not catalog_files:
            raise RootsError(
                "no globalgamemanagers BuildSettings catalog was found under --source"
            )
        if len(catalog_files) != 1:
            locations = ", ".join(
                path.relative_to(source_root).as_posix() for path in catalog_files
            )
            raise RootsError(
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
                "rootsObjectTypes": sorted(ROOTS_OBJECT_TYPES),
                "neverSelectedTypes": sorted(NEVER_PARSE_TYPES),
                "frameId": FRAME_ID,
                "scopeId": scope["scopeId"],
                "scopeCenter": {"x": scope["center"][0], "z": scope["center"][1]},
                "scopeWidthM": scope["widthM"],
                "scopeDepthM": scope["depthM"],
                "maxPlacementSpanM": parameters["maxPlacementSpanM"],
                "crossCheck": cross_check,
                "railAdjacency": "available" if terrain.get("railway") else "unavailable",
                "terrainEnvelope": "available" if terrain.get("envelope") else "unavailable",
                "anchors": "available" if anchors else "unavailable",
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
            raise RootsError("UnityPy could not load globalgamemanagers")
        if not catalog["complete"]:
            raise RootsError(
                "BuildSettings catalog verification was incomplete; no scene selection was trusted"
            )
        if not catalog["buildSettings"]:
            raise RootsError("globalgamemanagers did not yield a BuildSettings object")
        scene_files = discover_customs_scene_files(source_root, catalog["sceneCatalog"])
        facts = build_scene_facts(catalog, scene_files, unitypy)
        if facts["loadedSceneFileCount"] == 0:
            raise RootsError("UnityPy could not load the targeted Customs files")
        document = build_roots_document(
            source_root,
            catalog,
            scene_files,
            facts,
            unitypy_module=unitypy,
            scope=scope,
            terrain=terrain,
            anchors=anchors,
            parameters=parameters,
            allow_partial=args.allow_partial,
            cross_check=cross_check,
        )
        if not args.allow_partial:
            if not document["complete"]:
                diagnostics = document["diagnostics"]
                raise RootsError(
                    "roots document is incomplete "
                    f"({len(diagnostics['fileLoadFailures'])} file failures, "
                    f"{len(diagnostics['objectParseFailures'])} object failures, "
                    f"{len(diagnostics['skippedObjects'])} safe skips, "
                    f"{len(diagnostics['dependencyFailures'])} dependency denials, "
                    f"{len(diagnostics['unrootableNodes'])} unrootable nodes); "
                    "fix the setup or pass --allow-partial explicitly"
                )
            if not document["frameVerified"]:
                raise RootsError(
                    "frame verification did not pass "
                    f"(fortressWitness={document['frameCheck']['fortressWitness']}, "
                    f"verdict={document['frameCheck']['verdict']}); "
                    "do not add --allow-partial to make this pass"
                )
        report = build_operator_report(document) if report_path else None
        artifacts: List[Tuple[Path, Mapping[str, Any]]] = [(output_path, document)]
        if report is not None and report_path is not None:
            artifacts.append((report_path, report))
        census._publish_json_noclobber(artifacts)
        counts = document["counts"]
        print(
            f"wrote Customs industrial roots: {output_path.name} "
            f"({counts['electedRoots']} elected roots, {counts['rootsInScope']} in scope, "
            f"claim verdict {document['claimVerdict']['overall']})",
            file=stdout,
        )
        if report is not None and report_path is not None:
            print(
                f"wrote Customs industrial roots report: {report_path.name} "
                f"({len(report['families'])} families)",
                file=stdout,
            )
        return 0
    except RootsError as error:
        print(f"error: {error}", file=stderr)
        return 2
    except OSError as error:
        print(f"error: filesystem operation failed: {type(error).__name__}", file=stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
