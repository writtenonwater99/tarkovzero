#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SPEC = importlib.util.spec_from_file_location("derive_crackhouse_facts", HERE / "derive_crackhouse_facts.py")
module = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(module)


class PublicFactContracts(unittest.TestCase):
    def test_cli_arguments_match_verify_signature(self) -> None:
        args = module.parse_args(["--source", "source.json", "--facts", "facts.json"])
        self.assertEqual(args.source_path, Path("source.json"))
        self.assertEqual(args.facts_path, Path("facts.json"))

    def test_checked_in_facts_match_public_customs_data(self) -> None:
        result = module.verify(REPO / "public/data/customs-3d.json", HERE / "crackhouse_facts.json")
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(len(result["floorSurfaceStableIds"]), 2)


if __name__ == "__main__":
    unittest.main()
