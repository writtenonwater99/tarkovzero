#!/usr/bin/env python3
"""Verify the checked-in Crackhouse scalar selection against public Customs data."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import sys


SOURCE_KEY = "svg:Ground_Level/Buildings/Big_Buildings-2:element-197:subpath-0"
EXPECTED_STYLE = "gable"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def load_json(path: Path, *, max_bytes: int) -> dict:
    path = path.expanduser().resolve()
    require(path.is_file(), f"missing JSON: {path}")
    require(path.stat().st_size <= max_bytes, f"JSON exceeds {max_bytes} bytes: {path}")
    document = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(document, dict), f"JSON root must be an object: {path}")
    return document


def select_public_facts(source: dict) -> tuple[dict, list[dict]]:
    require(source.get("map") == "customs", "source map must be Customs")
    buildings = source.get("buildings")
    surfaces = source.get("floorSurfaces")
    require(isinstance(buildings, list) and isinstance(surfaces, list), "source collections missing")
    matches = [row for row in buildings if row.get("sourceKey") == SOURCE_KEY]
    require(len(matches) == 1, "expected exactly one public Crackhouse building row")
    building = matches[0]
    required_building = {
        "sourceKey", "poly", "height", "floors", "kind", "name", "place", "color", "style", "roof",
    }
    require(required_building <= set(building), "Crackhouse building row is incomplete")
    require(building["style"] == EXPECTED_STYLE and building["place"] == "Crackhouse", "building identity changed")
    poly = building["poly"]
    require(isinstance(poly, list) and len(poly) == 4, "Crackhouse footprint must have four vertices")
    require(all(isinstance(point, list) and len(point) == 2 and all(math.isfinite(float(v)) for v in point) for point in poly), "footprint contains a non-finite point")
    selected_building = {key: building[key] for key in (
        "sourceKey", "poly", "height", "floors", "kind", "name", "place", "color", "style", "roof",
    )}
    selected_surfaces = []
    for row in surfaces:
        if row.get("buildingSourceKey") != SOURCE_KEY or row.get("classification") != "floor":
            continue
        if row.get("floorIndex") not in (0, 1):
            continue
        selected_surfaces.append({
            "stableId": row.get("stableId"),
            "classification": row.get("classification"),
            "floorIndex": row.get("floorIndex"),
            "surfaceY": row.get("surfaceY"),
        })
    selected_surfaces.sort(key=lambda row: row["floorIndex"])
    require([row["floorIndex"] for row in selected_surfaces] == [0, 1], "exact ground and upper floor rows are required")
    require(all(math.isfinite(float(row["surfaceY"])) for row in selected_surfaces), "surface elevations must be finite")
    return selected_building, selected_surfaces


def verify(source_path: Path, facts_path: Path) -> dict:
    source = load_json(source_path, max_bytes=32 * 1024 * 1024)
    facts = load_json(facts_path, max_bytes=64 * 1024)
    building, surfaces = select_public_facts(source)
    require(facts.get("schemaVersion") == 1, "facts schema version changed")
    require(facts.get("documentType") == "tarkovzero-public-building-facts", "facts document type changed")
    require(facts.get("map") == "customs" and facts.get("assetId") == "crackhouse-shell", "facts identity changed")
    require(facts.get("building") == building, "checked-in building facts differ from public data")
    require(facts.get("floorSurfaces") == surfaces, "checked-in floor surfaces differ from public data")
    declared_hash = facts.get("source", {}).get("sha256")
    actual_hash = f"sha256:{sha256_file(source_path)}"
    require(declared_hash == actual_hash, "public data hash changed; review and refresh provenance")
    return {
        "status": "PASS",
        "source": str(source_path.resolve()),
        "sourceSha256": actual_hash,
        "facts": str(facts_path.resolve()),
        "buildingSourceKey": SOURCE_KEY,
        "floorSurfaceStableIds": [row["stableId"] for row in surfaces],
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", dest="source_path", type=Path, required=True)
    parser.add_argument("--facts", dest="facts_path", type=Path, required=True)
    return parser.parse_args(argv)


if __name__ == "__main__":
    try:
        print(json.dumps(verify(**vars(parse_args(sys.argv[1:]))), indent=2, sort_keys=True))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"Crackhouse fact verification failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
