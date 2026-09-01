#!/usr/bin/env python3
"""Byte-for-byte reproducibility gate for two independently generated LOD sets."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys


FILES = tuple(f"crackhouse-shell-lod{lod}.{suffix}" for lod in (0,1,2) for suffix in ("glb","receipt.json"))


def require(condition: bool, message: str) -> None:
    if not condition: raise ValueError(message)


def sha256_file(path: Path) -> str:
    digest=hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda:handle.read(1024*1024),b""):digest.update(chunk)
    return digest.hexdigest()


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser=argparse.ArgumentParser();parser.add_argument("--reference",type=Path,required=True);parser.add_argument("--candidate",type=Path,required=True);parser.add_argument("--output",type=Path,required=True)
    args=parser.parse_args(argv);args.reference=args.reference.expanduser().resolve();args.candidate=args.candidate.expanduser().resolve();args.output=args.output.expanduser().resolve()
    require(args.reference.is_dir() and args.candidate.is_dir() and args.reference!=args.candidate,"two distinct output directories are required")
    require(args.output.suffix.lower()==".json" and args.output.parent.is_dir() and not args.output.exists(),"--output must be a new JSON in an existing directory")
    return args


def verify(args: argparse.Namespace) -> dict:
    records=[]
    for name in FILES:
        left=args.reference/name;right=args.candidate/name
        require(left.is_file() and right.is_file(),f"missing reproducibility file {name}")
        left_hash,right_hash=sha256_file(left),sha256_file(right)
        require(left.stat().st_size==right.stat().st_size,f"byte size differs for {name}")
        require(left_hash==right_hash,f"SHA-256 differs for {name}")
        records.append({"file":name,"bytes":left.stat().st_size,"sha256":f"sha256:{left_hash}"})
    document={"schemaVersion":1,"documentType":"tarkovzero-crackhouse-byte-reproducibility","status":"PASS","setsCompared":2,"filesCompared":len(records),"records":records,"note":"Byte identity proves deterministic factory output on this pinned Blender build; it does not prove visual or tactical accuracy."}
    payload=(json.dumps(document,indent=2,sort_keys=True)+"\n").encode("utf-8")
    descriptor=os.open(args.output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o644)
    with os.fdopen(descriptor,"wb") as handle:handle.write(payload)
    return document


if __name__=="__main__":
    try:print(json.dumps(verify(parse_args(sys.argv[1:])),indent=2,sort_keys=True))
    except (OSError,ValueError) as error:
        print(f"Crackhouse reproducibility failed: {error}",file=sys.stderr);raise SystemExit(1) from error
