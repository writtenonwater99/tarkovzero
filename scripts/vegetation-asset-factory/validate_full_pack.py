#!/usr/bin/env python3
"""Custom integrity, mapping, and budget gate for the complete offline pack."""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import types


HERE = Path(__file__).resolve().parent
CATALOG_PATH = HERE / "prototype_catalog.json"
FACTORY_PATH = HERE / "vegetation_factory.py"
SET_VALIDATOR_PATH = HERE / "validate_vegetation_outputs.py"
PER_ASSET_BUDGET = {
    0: {"bytes": 1024 * 1024, "triangles": 12_000, "textureResolution": 128},
    1: {"bytes": 192 * 1024, "triangles": 1_500, "textureResolution": 64},
    2: {"bytes": 64 * 1024, "triangles": 500, "textureResolution": 32},
}
AGGREGATE_BUDGET = {
    0: {"bytes": 20 * 1024 * 1024, "triangles": 150_000},
    1: {"bytes": 4 * 1024 * 1024, "triangles": 30_000},
    2: {"bytes": 1536 * 1024, "triangles": 8_000},
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_new_json(path: Path, document: dict) -> None:
    payload = json.dumps(document, indent=2, sort_keys=True, ensure_ascii=True) + "\n"
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())


def load_set_validator():
    spec = importlib.util.spec_from_file_location("vegetation_set_validator", SET_VALIDATOR_PATH)
    require(spec is not None and spec.loader is not None, "could not load set validator")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate all 31 three-LOD authored vegetation assets and pack mappings.")
    parser.add_argument("--pack-root", type=Path, required=True)
    parser.add_argument("--pack-index", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    args.pack_root = args.pack_root.expanduser().resolve()
    args.pack_index = args.pack_index.expanduser().resolve()
    args.output = args.output.expanduser().resolve()
    require(args.pack_root.is_dir() and not args.pack_root.is_symlink(), "pack root must be a regular directory")
    require(args.pack_index.is_file() and not args.pack_index.is_symlink(), "pack index must be a regular file")
    require(args.pack_index.parent == args.pack_root, "pack index must sit at pack root")
    require(args.output.suffix.lower() == ".json" and not args.output.exists(), "validation output must be a new JSON file")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    return args


def validate_pack_index(pack_root: Path, pack_index_path: Path, catalog_by_name: dict[str, dict]) -> dict:
    index = json.loads(pack_index_path.read_text(encoding="utf-8"))
    require(index.get("schemaVersion") == 1 and index.get("map") == "customs", "pack index schema changed")
    require(index.get("status") == "offline-production-draft-not-live", "pack index live status changed")
    counts = index.get("counts", {})
    require(counts == {
        "authoredAssets": 31,
        "lodFiles": 93,
        "tilePrototypeBindings": 58,
        "placements": 8805,
    }, "pack index counts changed")
    contract = index.get("runtimeContract", {})
    require(contract.get("collision") == "none", "pack index unexpectedly claims collision")
    require(contract.get("livePromotion") is False, "pack index unexpectedly claims live promotion")
    require("approximation" in str(contract.get("geometry", "")), "geometry approximation disclaimer is missing")

    assets = index.get("authoredAssets")
    bindings = index.get("prototypeBindings")
    placements = index.get("placements")
    require(isinstance(assets, list) and len(assets) == 31, "pack index asset ledger changed")
    require(isinstance(bindings, list) and len(bindings) == 58, "pack index binding ledger changed")
    require(isinstance(placements, list) and len(placements) == 8805, "pack index placement ledger changed")
    asset_ids = {asset.get("assetId") for asset in assets}
    require(len(asset_ids) == 31 and None not in asset_ids, "pack index asset IDs are invalid")
    require({asset.get("prototypeName") for asset in assets} == set(catalog_by_name), "pack index prototype coverage changed")
    for asset in assets:
        require(asset.get("collision") == "none", f"{asset.get('assetId')} unexpectedly claims collision")
        require("approximation" in str(asset.get("geometryEvidence", "")), f"{asset.get('assetId')} lacks approximation disclaimer")
        lods = asset.get("lods")
        require(isinstance(lods, list) and [lod.get("lod") for lod in lods] == [0, 1, 2], f"{asset.get('assetId')} LOD ledger changed")
        for lod in lods:
            file_path = (pack_root / lod["file"]).resolve()
            require(file_path.is_relative_to(pack_root) and file_path.is_file(), f"indexed GLB is missing: {lod.get('file')}")
            require(file_path.stat().st_size == lod.get("bytes"), f"indexed byte count changed: {lod.get('file')}")
            require(f"sha256:{sha256_file(file_path)}" == lod.get("sha256"), f"indexed hash changed: {lod.get('file')}")
    binding_keys = {(binding.get("tileId"), binding.get("prototypeId")) for binding in bindings}
    require(len(binding_keys) == 58, "pack index duplicates tile prototype bindings")
    require(all(binding.get("assetId") in asset_ids for binding in bindings), "binding references unknown asset")
    ordinals = [placement.get("placementOrdinal") for placement in placements]
    require(ordinals == list(range(8805)), "placement ordinals are not exact and contiguous")
    require(all(placement.get("assetId") in asset_ids for placement in placements), "placement references unknown asset")
    require(all((placement.get("tileId"), placement.get("prototypeId")) in binding_keys for placement in placements), "placement lacks prototype binding")

    receipt_path = pack_root / "pack-index.receipt.json"
    require(receipt_path.is_file() and not receipt_path.is_symlink(), "pack index receipt is missing")
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    require(receipt.get("indexFile") == pack_index_path.name, "pack index receipt filename changed")
    require(receipt.get("bytes") == pack_index_path.stat().st_size, "pack index receipt bytes changed")
    require(receipt.get("sha256") == f"sha256:{sha256_file(pack_index_path)}", "pack index receipt hash changed")
    boundary = receipt.get("copyrightBoundary", {})
    require(boundary.get("geometryApproximation") is True, "index receipt approximation disclaimer changed")
    require(boundary.get("collisionIncluded") is False, "index receipt collision disclaimer changed")
    require(boundary.get("coordinatesCopiedIntoIndex") is False, "index unexpectedly copies coordinates")
    return index


def validate_generation_manifest(pack_root: Path) -> dict:
    """The manifest's generator hash must name the factory that is on disk right now.

    A pack whose manifest points at a factory revision nobody can produce is not
    reproducible, and the drift is silent: it appears when the factory is edited after the
    pack is built.  Committed-revision provenance is the separate, stronger gate in
    verify_factory_provenance.py.
    """
    manifest_path = pack_root / "generation-manifest.json"
    require(manifest_path.is_file() and not manifest_path.is_symlink(), "generation manifest is missing")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    generator = manifest.get("generator", {})
    declared = generator.get("factorySha256")
    actual = f"sha256:{sha256_file(FACTORY_PATH)}"
    require(
        declared == actual,
        f"generation manifest claims factory {declared} but the on-disk "
        f"scripts/vegetation-asset-factory/vegetation_factory.py hashes {actual}",
    )
    declared_catalog = generator.get("catalogSha256")
    actual_catalog = f"sha256:{sha256_file(CATALOG_PATH)}"
    require(
        declared_catalog == actual_catalog,
        f"generation manifest claims catalog {declared_catalog} but the on-disk catalog hashes {actual_catalog}",
    )
    require(len(manifest.get("records", [])) == 93, "generation manifest must carry 93 records")
    return {"factorySha256": actual, "catalogSha256": actual_catalog}


def main() -> None:
    args = parse_args(sys.argv[1:])
    set_validator = load_set_validator()
    catalog, catalog_by_name = set_validator.catalog()
    generator_provenance = validate_generation_manifest(args.pack_root)
    pack_index = validate_pack_index(args.pack_root, args.pack_index, catalog_by_name)
    expected_glbs = sorted((args.pack_root / "assets").glob("*/*.glb"))
    expected_receipts = sorted((args.pack_root / "assets").glob("*/*.receipt.json"))
    require(len(expected_glbs) == 93 and len(expected_receipts) == 93, "pack filesystem must contain exactly 93 GLBs and receipts")

    aggregate = {lod: {"bytes": 0, "triangles": 0, "assets": 0} for lod in (0, 1, 2)}
    alpha_census = {lod: {"OPAQUE": 0, "MASK": 0, "BLEND": 0} for lod in (0, 1, 2)}
    card_census: list[dict] = []
    families: dict[str, dict[int, dict[str, int]]] = {}
    assets = []
    for name in sorted(catalog_by_name, key=str.lower):
        slug = name.lower()
        asset_dir = args.pack_root / "assets" / slug
        receipts = [asset_dir / f"{slug}-lod{lod}.receipt.json" for lod in (0, 1, 2)]
        result = set_validator.validate_set(
            types.SimpleNamespace(prototype=name, receipts=receipts),
            catalog,
            catalog_by_name,
        )
        family = catalog_by_name[name]["family"]
        family_stats = families.setdefault(family, {lod: {"bytes": 0, "triangles": 0, "assets": 0} for lod in (0, 1, 2)})
        asset_lods = []
        for detail in result["lods"]:
            lod = detail["lod"]
            texture_resolution = PER_ASSET_BUDGET[lod]["textureResolution"]
            receipt = json.loads(receipts[lod].read_text(encoding="utf-8"))
            require(receipt["generated"]["textureResolution"] == texture_resolution, f"{name} LOD{lod} texture budget changed")
            require(detail["bytes"] <= PER_ASSET_BUDGET[lod]["bytes"], f"{name} LOD{lod} exceeds per-asset byte budget")
            require(detail["triangles"] <= PER_ASSET_BUDGET[lod]["triangles"], f"{name} LOD{lod} exceeds per-asset triangle budget")
            aggregate[lod]["bytes"] += detail["bytes"]
            aggregate[lod]["triangles"] += detail["triangles"]
            aggregate[lod]["assets"] += 1
            for mode, count in detail["alphaModeCounts"].items():
                alpha_census[lod][mode] += count
            for audit in detail["cardMaterials"]:
                card_census.append({"prototype": name, "lod": lod, **audit})
            family_stats[lod]["bytes"] += detail["bytes"]
            family_stats[lod]["triangles"] += detail["triangles"]
            family_stats[lod]["assets"] += 1
            asset_lods.append({
                "lod": lod,
                "bytes": detail["bytes"],
                "triangles": detail["triangles"],
                "textureResolution": texture_resolution,
                "perAssetBudget": PER_ASSET_BUDGET[lod],
            })
        assets.append({"prototype": name, "family": family, "seed": result["seed"], "lods": asset_lods})

    # Pack-wide alpha invariant: the whole pack is OPAQUE + MASK, never BLEND.
    blend_total = sum(alpha_census[lod]["BLEND"] for lod in (0, 1, 2))
    require(blend_total == 0, f"pack still contains {blend_total} BLEND material(s)")
    require(card_census, "pack contains no alpha-cut card material to validate")

    for lod in (0, 1, 2):
        require(aggregate[lod]["assets"] == 31, f"LOD{lod} aggregate asset count changed")
        require(aggregate[lod]["bytes"] <= AGGREGATE_BUDGET[lod]["bytes"], f"LOD{lod} aggregate byte budget exceeded")
        require(aggregate[lod]["triangles"] <= AGGREGATE_BUDGET[lod]["triangles"], f"LOD{lod} aggregate triangle budget exceeded")

    placement_counts = Counter(placement["assetId"] for placement in pack_index["placements"])
    expected_counts = {
        f"customs.vegetation.{name.lower()}": spec["instances"]
        for name, spec in catalog_by_name.items()
    }
    require(dict(placement_counts) == expected_counts, "pack placement counts do not match the exact catalog ledger")
    report = {
        "schemaVersion": 1,
        "documentType": "tarkovzero-customs-offline-vegetation-custom-validation",
        "status": "pass-offline-only-not-live",
        "counts": {
            "prototypes": 31,
            "lodFiles": 93,
            "receipts": 93,
            "placements": 8805,
            "prototypeBindings": 58,
        },
        "budgets": {
            "perAsset": PER_ASSET_BUDGET,
            "aggregate": AGGREGATE_BUDGET,
            "actual": aggregate,
        },
        "generatorProvenance": generator_provenance,
        "alpha": {
            "materialsByLodAndMode": alpha_census,
            "blendMaterials": blend_total,
            "cardMaterials": card_census,
        },
        "families": families,
        "assets": assets,
        "packIndex": {
            "file": args.pack_index.name,
            "bytes": args.pack_index.stat().st_size,
            "sha256": f"sha256:{sha256_file(args.pack_index)}",
        },
        "admission": {
            "customValidation": "pass",
            "khronosValidation": "separate required report",
            "livePromotion": False,
            "collision": False,
            "geometryApproximation": True,
            "note": "exact scalar placement bindings do not make original branch, leaf, bark, or bounds approximations source-game geometry",
        },
    }
    write_new_json(args.output, report)
    print(json.dumps({
        "output": str(args.output),
        "packIndexSha256": report["packIndex"]["sha256"],
        "aggregate": aggregate,
        "alphaMaterialsByLod": alpha_census,
        "blendMaterials": blend_total,
        "cardMaterialCount": len(card_census),
        "totalBytes": sum(value["bytes"] for value in aggregate.values()),
        "totalTriangles": sum(value["triangles"] for value in aggregate.values()),
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"full vegetation pack validation failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
