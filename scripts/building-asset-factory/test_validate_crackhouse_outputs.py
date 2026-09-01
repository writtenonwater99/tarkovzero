#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest


HERE=Path(__file__).resolve().parent
SPEC=importlib.util.spec_from_file_location("validate_crackhouse_outputs",HERE/"validate_crackhouse_outputs.py")
validator=importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(validator)


class ValidatorContracts(unittest.TestCase):
    def test_accessor_bounds_follow_parent_and_child_translation(self) -> None:
        document={"scene":0,"scenes":[{"nodes":[0]}],"nodes":[{"translation":[10,2,-3],"children":[1]},{"translation":[1,0,0],"mesh":0}],"meshes":[{"primitives":[{"attributes":{"POSITION":0},"indices":1}]}],"accessors":[{"count":8,"min":[-1,-2,-3],"max":[1,2,3]},{"count":36}]}
        stats=validator.geometry_stats(document)
        self.assertEqual(stats["triangles"],12)
        self.assertEqual(stats["boundsM"]["min"],[10.0,0.0,-6.0])
        self.assertEqual(stats["boundsM"]["max"],[12.0,4.0,0.0])

    def test_independent_transform_derivation(self) -> None:
        derived=validator.derived_transform()
        self.assertAlmostEqual(derived["pivot"][0],83.95,places=8)
        self.assertAlmostEqual(derived["pivot"][2],-156.175,places=8)
        self.assertAlmostEqual(derived["yaw"],-11.379260726349447,places=8)

    @unittest.skipUnless(os.environ.get("TZ_CRACKHOUSE_QA_RECEIPTS"),"set TZ_CRACKHOUSE_QA_RECEIPTS to three receipts")
    def test_receipt_mutations_are_rejected(self) -> None:
        sources=[Path(value).resolve() for value in os.environ["TZ_CRACKHOUSE_QA_RECEIPTS"].split(",")]
        with tempfile.TemporaryDirectory(prefix="tz-crackhouse-validator-mutations-") as raw:
            target=Path(raw);receipts=[]
            for source in sources:
                document=json.loads(source.read_text())
                shutil.copy2(source.parent/document["asset"]["outputFile"],target/document["asset"]["outputFile"])
                receipt=target/source.name;shutil.copy2(source,receipt);receipts.append(receipt)
            args=argparse.Namespace(receipts=receipts)
            validator.validate_set(args)
            baseline=json.loads(receipts[0].read_text())
            mutations=(
                lambda doc:doc["generated"].__setitem__("triangles",doc["generated"]["triangles"]+1),
                lambda doc:doc["generated"].__setitem__("openingVoids",doc["generated"]["openingVoids"]-1),
                lambda doc:doc["asset"]["boundsM"]["max"].__setitem__(1,doc["asset"]["boundsM"]["max"][1]+1),
                lambda doc:doc["claims"].__setitem__("tacticalCertified",True),
            )
            for mutation in mutations:
                document=json.loads(json.dumps(baseline));mutation(document)
                receipts[0].write_text(json.dumps(document),encoding="utf-8")
                with self.assertRaises(ValueError): validator.validate_set(args)
            receipts[0].write_text(json.dumps(baseline),encoding="utf-8")


if __name__=="__main__":
    unittest.main()
