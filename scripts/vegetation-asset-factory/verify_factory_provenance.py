#!/usr/bin/env python3
"""Require a vegetation pack's declared generator to exist in git.

`.local-candidates/vegetation-full` was built by a factory revision that reached neither
the working tree nor any commit: its `generation-manifest.json` recorded
`sha256:03337cdb...c16f384` while the only factory blob git has ever held hashes
`sha256:ef3b4b8a...3da38c`.  Nothing noticed, because every existing gate compares the
manifest against whatever happens to be on disk.

This gate closes that hole from the other side.  It asserts that the manifest's
`generator.factorySha256` equals the SHA-256 of the factory *as committed at a git ref* —
so a pack can never again claim provenance from a revision nobody can check out.  A dirty
working tree is a failure here by design: the fix is to commit the factory and rebuild, or
rebuild from the committed revision.

Read-only: this script runs `git cat-file` and `git rev-parse` and never writes to git.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
FACTORY_PATH = HERE / "vegetation_factory.py"
FACTORY_REPO_PATH = "scripts/vegetation-asset-factory/vegetation_factory.py"
CATALOG_PATH = HERE / "prototype_catalog.json"
CATALOG_REPO_PATH = "scripts/vegetation-asset-factory/prototype_catalog.json"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def sha256_bytes(blob: bytes) -> str:
    return hashlib.sha256(blob).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git_blob(ref: str, repo_path: str) -> bytes:
    result = subprocess.run(
        ["git", "cat-file", "blob", f"{ref}:{repo_path}"],
        cwd=REPO,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    require(
        result.returncode == 0,
        f"git has no blob for {repo_path} at {ref}: {result.stderr.decode('utf-8', 'replace').strip()}",
    )
    return result.stdout


def git_commit(ref: str) -> str:
    result = subprocess.run(
        ["git", "rev-parse", ref],
        cwd=REPO,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    require(result.returncode == 0, f"git cannot resolve ref {ref}")
    return result.stdout.decode("utf-8").strip()


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Verify a pack manifest names a committed factory revision.")
    parser.add_argument("--pack-root", type=Path, required=True)
    parser.add_argument("--ref", default="HEAD", help="git ref the factory must be committed at (default HEAD)")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    args.pack_root = args.pack_root.expanduser().resolve()
    require(args.pack_root.is_dir() and not args.pack_root.is_symlink(), "--pack-root must be a directory")
    if args.output is not None:
        args.output = args.output.expanduser().resolve()
        require(args.output.suffix.lower() == ".json" and not args.output.exists(), "--output must be a new JSON path")
    return args


def main() -> None:
    args = parse_args(sys.argv[1:])
    manifest_path = args.pack_root / "generation-manifest.json"
    require(manifest_path.is_file() and not manifest_path.is_symlink(), "generation manifest is missing")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    generator = manifest.get("generator", {})
    declared_factory = generator.get("factorySha256")
    declared_catalog = generator.get("catalogSha256")
    require(isinstance(declared_factory, str), "generation manifest has no generator.factorySha256")
    require(isinstance(declared_catalog, str), "generation manifest has no generator.catalogSha256")

    worktree_factory = f"sha256:{sha256_file(FACTORY_PATH)}"
    worktree_catalog = f"sha256:{sha256_file(CATALOG_PATH)}"
    committed_factory = f"sha256:{sha256_bytes(git_blob(args.ref, FACTORY_REPO_PATH))}"
    committed_catalog = f"sha256:{sha256_bytes(git_blob(args.ref, CATALOG_REPO_PATH))}"
    commit = git_commit(args.ref)

    report = {
        "schemaVersion": 1,
        "documentType": "tarkovzero-customs-offline-vegetation-factory-provenance",
        "packRoot": str(args.pack_root),
        "ref": args.ref,
        "commit": commit,
        "factory": {
            "repoPath": FACTORY_REPO_PATH,
            "declaredInManifest": declared_factory,
            "worktree": worktree_factory,
            "committed": committed_factory,
        },
        "catalog": {
            "repoPath": CATALOG_REPO_PATH,
            "declaredInManifest": declared_catalog,
            "worktree": worktree_catalog,
            "committed": committed_catalog,
        },
    }
    checks = {
        "manifestMatchesWorktreeFactory": declared_factory == worktree_factory,
        "manifestMatchesCommittedFactory": declared_factory == committed_factory,
        "manifestMatchesWorktreeCatalog": declared_catalog == worktree_catalog,
        "manifestMatchesCommittedCatalog": declared_catalog == committed_catalog,
    }
    report["checks"] = checks
    report["status"] = "pass" if all(checks.values()) else "fail"

    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(report, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
    print(json.dumps(report, indent=2, sort_keys=True))

    require(
        checks["manifestMatchesWorktreeFactory"],
        f"manifest factory {declared_factory} does not match the working-tree factory {worktree_factory}",
    )
    require(
        checks["manifestMatchesCommittedFactory"],
        f"manifest factory {declared_factory} is not the factory committed at {args.ref} "
        f"({committed_factory}); a pack may not claim provenance from an uncommitted revision",
    )
    require(
        checks["manifestMatchesWorktreeCatalog"] and checks["manifestMatchesCommittedCatalog"],
        f"manifest catalog {declared_catalog} does not match worktree {worktree_catalog} "
        f"/ committed {committed_catalog}",
    )


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"vegetation factory provenance verification failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
