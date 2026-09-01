#!/usr/bin/env python3
"""Synthetic tests for the Customs industrial placement-root extractor.

Every fixture here is an in-memory fake Unity object.  The suite never needs,
and must never be pointable at, real game files: `FakeUnityPy.load` is the only
loader ever invoked, every discovered path lives under a
`tempfile.TemporaryDirectory()`, and `selector._import_unitypy` is never called.

The suite is in three parts:

* behaviour — counting, scope/frame, classification, falsifiability;
* safety — the guards the contract makes non-negotiable;
* mutation proofs — for each guard, a mutation that breaks it and the assertion
  that catches the mutation.  A guard no test can break is not verified.
"""

from __future__ import annotations

import importlib.util
import io
import json
import random
import re
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


# `ID_PATTERN` from `scripts/lib/customs-truth-graph.mjs`, so a rootId that the
# graph converter would reject is caught here rather than downstream.
TRUTH_GRAPH_ID_PATTERN = re.compile(r"^[a-z0-9]+(?:[._-][a-z0-9]+)+$")


SCRIPT_PATH = Path(__file__).with_name("extract-customs-industrial-roots.py")
SPEC = importlib.util.spec_from_file_location(
    "extract_customs_industrial_roots", SCRIPT_PATH
)
assert SPEC is not None and SPEC.loader is not None
roots_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(roots_module)

census = roots_module.census
RootsError = roots_module.RootsError

CUSTOMS_INDEX = 637
LEVEL_NAME = f"level{CUSTOMS_INDEX}"
SHARED_NAME = f"sharedassets{CUSTOMS_INDEX}.assets"

FORTRESS = (202.898880005, -127.68775177)
SCOPE = {
    "scopeId": "customs-industrial-rail-yard",
    "center": (230.0, -110.0),
    "widthM": 360.0,
    "depthM": 300.0,
    "fortress": FORTRESS,
}
TERRAIN_ENVELOPE = (-412.0, 738.0, -347.0, 278.0)
DEFAULT_PARAMETERS = {
    "maxPlacementSpanM": 26.0,
    "coincidentRootM": 1.5,
    "frameWitnessToleranceM": 12.0,
    "terrainMarginM": 50.0,
    "railOnTrackM": 4.0,
    "railOffTrackM": 12.0,
}


# --------------------------------------------------------------------------
# in-memory fakes
# --------------------------------------------------------------------------


class FakeReader:
    """Stands in for a UnityPy object reader without any real serialized data."""

    def __init__(self, type_name, path_id, data, asset_name=SHARED_NAME, *, byte_size=1024,
                 externals=()):
        self.type = SimpleNamespace(name=type_name)
        self.path_id = path_id
        self.byte_size = byte_size
        self.assets_file = SimpleNamespace(name=asset_name, externals=list(externals))
        self._data = data
        self.parse_calls = 0

    def parse_as_dict(self):
        self.parse_calls += 1
        if isinstance(self._data, BaseException):
            raise self._data
        return json.loads(json.dumps(self._data))


class FakeEnvironment:
    def __init__(self, objects):
        self.objects = list(objects)

    def find_file(self, *_args, **_kwargs):
        return "unsafe-find"

    def load_file(self, *_args, **_kwargs):
        return "unsafe-file"

    def load_files(self, *_args, **_kwargs):
        return "unsafe-files"

    def load_folder(self, *_args, **_kwargs):
        return "unsafe-folder"

    def load_assets(self, *_args, **_kwargs):
        return "unsafe-assets"


class FakeUnityPy:
    __version__ = "test-only"

    def __init__(self, environments=None, errors=None, on_load=None):
        self.environments = environments or {}
        self.errors = errors or {}
        self.on_load = on_load
        self.load_calls = []
        self.load_inputs = []
        self.stream_facts = []
        self.returned_environments = []

    def load(self, source):
        if isinstance(source, (str, Path)):
            raise AssertionError("UnityPy.load must receive the safe file-like wrapper")
        name = source.name
        self.load_calls.append(name)
        self.load_inputs.append(source)
        self.stream_facts.append({"name": name, "path": getattr(source, "path", None)})
        if self.on_load is not None:
            self.on_load(source, name)
        if name in self.errors:
            raise self.errors[name]
        environment = FakeEnvironment(self.environments.get(name, ()))
        self.returned_environments.append(environment)
        return environment

    def save(self, *args, **kwargs):  # pragma: no cover - guard only
        raise AssertionError("the extractor must never call a UnityPy save/export API")


def pointer(path_id, file_id=0):
    return {"m_FileID": file_id, "m_PathID": path_id}


def vector3(x, y, z):
    return {"x": x, "y": y, "z": z}


def quaternion(x, y, z, w):
    return {"x": x, "y": y, "z": z, "w": w}


def build_settings_reader():
    scene_paths = [f"Assets/Scenes/Synthetic/Scene{index}.unity" for index in range(714)]
    scene_paths[CUSTOMS_INDEX] = r"Assets\Scenes\Locations\Custom\CustomScene.unity"
    return FakeReader(
        "BuildSettings", 1, {"scenes": scene_paths}, asset_name="globalgamemanagers"
    )


def game_object_reader(path_id, name, components, asset, extra=None):
    data = {
        "m_Name": name,
        "m_IsActive": 1,
        "m_Layer": 8,
        "m_TagString": "Untagged",
        "m_Component": [{"component": pointer(item)} for item in components],
    }
    if extra:
        data.update(extra)
    return FakeReader("GameObject", path_id, data, asset)


def transform_reader(path_id, game_object_path_id, parent_path_id, position, asset,
                     rotation=None, scale=None):
    return FakeReader(
        "Transform",
        path_id,
        {
            "m_GameObject": pointer(game_object_path_id),
            "m_Father": pointer(parent_path_id),
            "m_LocalPosition": vector3(*position),
            "m_LocalRotation": rotation or quaternion(0, 0, 0, 1),
            "m_LocalScale": vector3(*(scale or (1, 1, 1))),
        },
        asset,
    )


def renderer_reader(path_id, game_object_path_id, material_path_ids, asset):
    return FakeReader(
        "MeshRenderer",
        path_id,
        {
            "m_GameObject": pointer(game_object_path_id),
            "m_Enabled": 1,
            "m_CastShadows": 1,
            "m_ReceiveShadows": 1,
            "m_Materials": [pointer(item) for item in material_path_ids],
        },
        asset,
    )


def material_reader(path_id, name, color, asset):
    saved = {"m_Floats": [{"first": "_Glossiness", "second": 0.4}]}
    if color is not None:
        saved["m_Colors"] = [
            {
                "first": "_Color",
                "second": {"r": color[0], "g": color[1], "b": color[2], "a": color[3]},
            }
        ]
    return FakeReader("Material", path_id, {"m_Name": name, "m_SavedProperties": saved}, asset)


def lod_group_reader(path_id, game_object_path_id, renderer_path_ids, asset):
    return FakeReader(
        "LODGroup",
        path_id,
        {
            "m_GameObject": pointer(game_object_path_id),
            "m_Enabled": 1,
            "m_LODs": [
                {
                    "screenRelativeTransitionHeight": 0.5 / (index + 1),
                    "fadeTransitionWidth": 0.0,
                    "renderers": [{"renderer": pointer(renderer_path_id)}],
                }
                for index, renderer_path_id in enumerate(renderer_path_ids)
            ],
        },
        asset,
    )


class Scene:
    """Composes fake GameObject/Transform/renderer/material/LOD readers."""

    def __init__(self, asset=SHARED_NAME):
        self.asset = asset
        self.readers = []
        self._next = 1000
        self.world = {}
        self.transform_id = {}
        self.renderer_id = {}
        self._materials = {}

    def _alloc(self):
        self._next += 1
        return self._next

    def material(self, name, color=None):
        if name in self._materials:
            return self._materials[name]
        path_id = self._alloc()
        self._materials[name] = path_id
        self.readers.append(material_reader(path_id, name, color, self.asset))
        return path_id

    def node(self, name, *, parent=None, pos=(0.0, 0.0, 0.0), renderer=False,
             materials=(), parent_transform=None, rotation=None, scale=None,
             extra=None):
        game_object = self._alloc()
        transform = self._alloc()
        if parent_transform is not None:
            parent_tr = parent_transform
            parent_pos = (0.0, 0.0, 0.0)
        elif parent is None:
            parent_tr = 0
            parent_pos = (0.0, 0.0, 0.0)
        else:
            parent_tr = self.transform_id[parent]
            parent_pos = self.world[parent]
        local = tuple(pos[index] - parent_pos[index] for index in range(3))
        components = [transform]
        renderer_path_id = None
        if renderer:
            renderer_path_id = self._alloc()
            components.append(renderer_path_id)
        self.readers.append(
            game_object_reader(game_object, name, components, self.asset, extra)
        )
        self.readers.append(
            transform_reader(
                transform, game_object, parent_tr, local, self.asset, rotation, scale
            )
        )
        if renderer:
            self.readers.append(
                renderer_reader(
                    renderer_path_id,
                    game_object,
                    [self.material(item) if isinstance(item, str) else item for item in materials],
                    self.asset,
                )
            )
        self.world[game_object] = pos
        self.transform_id[game_object] = transform
        self.renderer_id[game_object] = renderer_path_id
        return game_object

    def lod_group(self, owner, members):
        path_id = self._alloc()
        self.readers.append(
            lod_group_reader(
                path_id, owner, [self.renderer_id[item] for item in members], self.asset
            )
        )
        return path_id

    def environments(self, extra_shared=()):
        return {
            "globalgamemanagers": [build_settings_reader()],
            # A filler object so `levelN` also exposes an external table; without
            # one the run records a dependency failure and is never `complete`.
            LEVEL_NAME: [material_reader(9_000_001, "Filler_Mat", None, LEVEL_NAME)],
            SHARED_NAME: list(self.readers) + list(extra_shared),
        }


# --------------------------------------------------------------------------
# shared harness
# --------------------------------------------------------------------------


class RootsTestCase(unittest.TestCase):
    def make_source(self, base: Path, extra_names=()) -> Path:
        source = base / "synthetic-game-data"
        source.mkdir()
        for name in ("globalgamemanagers", LEVEL_NAME, SHARED_NAME, *extra_names):
            (source / name).write_bytes(b"UnityFS\x00synthetic-only")
        return source

    def collect(self, environments, source):
        fake = FakeUnityPy(environments)
        catalog_files = roots_module.discover_catalog_files(source)
        catalog = roots_module.load_build_settings_catalog(source, catalog_files, fake)
        scene_files = roots_module.discover_customs_scene_files(
            source, catalog["sceneCatalog"]
        )
        facts = roots_module.build_scene_facts(catalog, scene_files, fake)
        return catalog, scene_files, facts, fake

    def build(self, scene, *, terrain=None, anchors=None, scope=None,
              allow_partial=False, cross_check=True, parameters=None,
              environments=None, mutate_facts=None, source=None):
        """Build a roots document from a synthetic scene, publishing nothing."""
        environments = environments if environments is not None else scene.environments()

        def _build(source_path):
            catalog, scene_files, facts, fake = self.collect(environments, source_path)
            if mutate_facts is not None:
                mutate_facts(facts)
            document = roots_module.build_roots_document(
                source_path,
                catalog,
                scene_files,
                facts,
                unitypy_module=fake,
                scope=dict(scope or SCOPE),
                terrain=terrain
                if terrain is not None
                else {"envelope": TERRAIN_ENVELOPE, "railway": None},
                anchors=anchors,
                parameters={**DEFAULT_PARAMETERS, **(parameters or {})},
                allow_partial=allow_partial,
                cross_check=cross_check,
            )
            return document, facts, fake

        if source is not None:
            return _build(source)
        with tempfile.TemporaryDirectory() as temp_value:
            return _build(self.make_source(Path(temp_value)))

    def run_main(self, arguments, unitypy=None):
        stdout = io.StringIO()
        stderr = io.StringIO()
        code = roots_module.main(
            arguments, unitypy_module=unitypy, stdout=stdout, stderr=stderr
        )
        return code, stdout.getvalue(), stderr.getvalue()

    def classes(self, document):
        return {item["normalizedName"]: item["class"] for item in document["roots"]}


# --------------------------------------------------------------------------
# fixtures
# --------------------------------------------------------------------------


def one_wagon_with_lods():
    scene = Scene()
    root = scene.node("Vagon_01", pos=(230.0, 0.0, -110.0))
    members = [
        scene.node(f"LOD{index}", parent=root, pos=(230.0, 0.0, -110.0), renderer=True)
        for index in range(3)
    ]
    scene.lod_group(root, members)
    return scene


def five_wagons_under_one_group():
    scene = Scene()
    group = scene.node("RailYard_Wagons", pos=(200.0, 0.0, -120.0))
    for index in range(5):
        scene.node(
            f"Wagon_{index + 1}",
            parent=group,
            pos=(200.0 + 12.0 * index, 0.0, -120.0),
            renderer=True,
        )
    return scene


def five_same_named_wagons_under_a_parent():
    """Five placements whose names read as parts of their parent — R5 territory.

    Each child's normalized name (`wagons_front`, …) starts with the parent's and
    is strictly longer, which is what genuine sub-part naming looks like, so the
    distinct-name rule and the placement-branch rule both see nothing here and
    only the metre-denominated span guard can tell one 48 m parent from one
    placed object.

    The children were `Wagons_01..05` until 2026-09-01.  Those all normalize to
    `wagons` — the parent's own name — and an identical name is now read as
    another INSTANCE rather than a part (see `_is_part_of`), so that spelling no
    longer isolates R5: the branch rule holds them apart too, which is the
    correct answer for five numbered siblings and the wrong fixture for this
    test.  `test_five_numbered_siblings_survive_a_raised_span_guard` pins the
    numbered spelling.
    """
    scene = Scene()
    parent = scene.node("Wagons", pos=(200.0, 0.0, -120.0))
    for index, suffix in enumerate(("Front", "Second", "Middle", "Fourth", "Rear")):
        scene.node(
            f"Wagons_{suffix}",
            parent=parent,
            pos=(200.0 + 12.0 * index, 0.0, -120.0),
            renderer=True,
        )
    return scene


def five_numbered_wagons_under_a_same_named_parent():
    """`Wagons -> Wagons_01..05`: five numbered siblings, one family name.

    Every child folds to the parent's own normalized name, which is Unity's
    ordinary spelling for repeated placements and never how a sub-part is named.
    """
    scene = Scene()
    parent = scene.node("Wagons", pos=(200.0, 0.0, -120.0))
    for index in range(5):
        scene.node(
            f"Wagons_{index + 1:02d}",
            parent=parent,
            pos=(200.0 + 12.0 * index, 0.0, -120.0),
            renderer=True,
        )
    return scene


def two_placements_behind_part_named_children():
    """D1: two containers 7 m apart, each rendering through a child named `Mesh`.

    Both renderable descendants normalize to the part token `mesh`, so a count of
    distinct descendant names sees one family; the wrapper is `Containers`, whose
    conditional group rule needs renderable *children* and has none.  Only the
    placement-branch rule separates them.
    """
    scene = Scene()
    wrapper = scene.node("Containers", pos=(230.0, 0.0, -110.0))
    for index, offset in enumerate((0.0, 7.0)):
        crate = scene.node(
            f"Container_{index + 1:02d}", parent=wrapper,
            pos=(230.0 + offset, 0.0, -110.0),
        )
        scene.node("Mesh", parent=crate, pos=(230.0 + offset, 1.0, -110.0), renderer=True)
    return scene


def one_branch_two_families():
    """R4's distinct-name rule with only ONE placement branch under the wrapper.

    `Depot_A -> Stack -> {Vagon_1, Konteyner_1}` gives the wrapper a single
    non-part branch, so the branch rule cannot fire and the span is 6 m, so R5
    cannot either.  Deleting the distinct-name rule elects `Depot_A` as one root.
    """
    scene = Scene()
    wrapper = scene.node("Depot_A", pos=(220.0, 0.0, -110.0))
    stack = scene.node("Stack", parent=wrapper, pos=(220.0, 0.0, -110.0))
    scene.node("Vagon_1", parent=stack, pos=(220.0, 0.0, -110.0), renderer=True)
    scene.node("Konteyner_1", parent=stack, pos=(226.0, 0.0, -110.0), renderer=True)
    return scene


def renderable_group_named_yard():
    """A node that renders AND is named `Yard`: only GROUP_NAME_TOKENS rejects it."""
    scene = Scene()
    yard = scene.node("Yard", pos=(230.0, 0.0, -110.0), renderer=True)
    scene.node("Vagon_Yardside", parent=yard, pos=(233.0, 0.0, -110.0), renderer=True)
    return scene


def renderable_containers_with_two_named_children():
    """A node that renders AND is named `Containers`: the conditional rule's case."""
    scene = Scene()
    wrapper = scene.node("Containers", pos=(230.0, 0.0, -110.0), renderer=True)
    scene.node("Container_Left", parent=wrapper, pos=(228.0, 0.0, -110.0), renderer=True)
    scene.node("Container_Right", parent=wrapper, pos=(232.0, 0.0, -110.0), renderer=True)
    return scene


def broken_node_under_an_in_scope_root(depth=131):
    """A chain deeper than MAX_HIERARCHY_DEPTH under one elected, in-scope root.

    Nodes past the depth cap keep their parent pointer but lose `hierarchyComplete`,
    so they are ledgered as unrootable while their partial ancestor chain still
    reaches the elected root — exactly the `scopeIntegrity: "suspect"` condition.
    """
    scene = Scene()
    position = (230.0, 0.0, -110.0)
    cursor = scene.node("Vagon_Stack", pos=position, renderer=True)
    for index in range(1, depth):
        cursor = scene.node(
            f"Link{index}", parent=cursor, pos=position,
            renderer=index == depth - 1,
        )
    return scene


def containers_rendering_only_through_their_own_lods(count=2, levels=2):
    """Two 6 m containers authored the standard Unity way: a LODGroup per object.

    Each container's only renderable children are its own LOD levels, which R1
    already owns.  Counting those as "renderable children of differing names"
    tripped the conditional `container` rule, rejected both containers, and then
    elected nothing at all beneath them — two real objects counted as zero.
    """
    scene = Scene()
    for index in range(count):
        x = 230.0 + 6.0 * index
        crate = scene.node(f"Container_{index + 1:02d}", pos=(x, 0.0, -110.0))
        members = [
            scene.node(f"LOD{level}", parent=crate, pos=(x, 0.0, -110.0), renderer=True)
            for level in range(levels)
        ]
        scene.lod_group(crate, members)
    return scene


def a_group_whose_whole_descent_is_lod_interiors(name="Yard"):
    """A group-named node whose every renderable child is its own LOD level.

    The group rule fires on the name alone, and the descent it orders can elect
    nothing, so the object leaves the count.  That must be ledgered, not silent.
    """
    scene = Scene()
    group = scene.node(name, pos=(230.0, 0.0, -110.0))
    members = [
        scene.node(f"LOD{level}", parent=group, pos=(230.0, 0.0, -110.0), renderer=True)
        for level in range(2)
    ]
    scene.lod_group(group, members)
    return scene


def two_placements_under_a_wrapper_of_the_same_name(family="Container", part="Mesh"):
    """`Container -> {Container_01 -> Mesh, Container_02 -> Mesh}`, 7 m apart.

    Spec §8 test 37's fixture with the wrapper DE-PLURALISED, which is all it
    takes for the wrapper's normalized name to equal its children's: `container`
    over `container`.  The published `_is_part_of` read that as "these are my
    parts" and elected one root for two containers — the passing plural fixture
    only passed because `"container".startswith("containers")` is False.
    """
    scene = Scene()
    wrapper = scene.node(family, pos=(230.0, 0.0, -110.0))
    for index, offset in enumerate((0.0, 7.0)):
        crate = scene.node(
            f"{family}_{(index * 4) + 1:02d}", parent=wrapper,
            pos=(230.0 + offset, 0.0, -110.0),
        )
        scene.node(part, parent=crate, pos=(230.0 + offset, 1.0, -110.0), renderer=True)
    return scene


def a_stack_of_renderers(family="Container", count=3, pitch=2.6):
    """`Container_01 -> Container_02 -> Container_03`, each carrying a renderer.

    The stack sits on the `red_container_stack` anchor (233, -89) from
    `data/customs-prop-features.json` — the authoring pattern for the very
    objects this tool counts.  Both multi-placement rules are gated on
    `not renderable(n)`, so every node here was exempt and the stack elected one
    root at confidence 0.35.
    """
    scene = Scene()
    parent = None
    for index in range(count):
        parent = scene.node(
            f"{family}_{index + 1:02d}",
            parent=parent,
            pos=(233.0, pitch * index, -89.0),
            renderer=True,
        )
    return scene


def six_wagons_under_a_wrapper(wrapper_name):
    """Six identical `Vagon_NN` under one rejected wrapper, whose name varies."""
    scene = Scene()
    wrapper = scene.node(wrapper_name, pos=(180.0, 0.0, -120.0))
    for index in range(6):
        scene.node(
            f"Vagon_{index + 1:02d}",
            parent=wrapper,
            pos=(180.0 + 10.0 * index, 0.0, -120.0),
            renderer=True,
        )
    scene.node("Widget", pos=(FORTRESS[0], 0.0, FORTRESS[1]), renderer=True)
    return scene


def six_wagons_and_one_bystander(*, exact=False, material=None):
    """Six confident `Vagon_NN` plus ONE unrelated body-typed row.

    With a NaN scale component the bystander scores 0.150 — the unresolved band,
    which no verdict may be built on.  `exact=True` / a matching material lift it
    into a band that may, which is what separates "the band decided" from "the
    name decided".
    """
    scene = Scene()
    for index in range(6):
        scene.node(
            f"Vagon_{index + 1:02d}",
            pos=(180.0 + 10.0 * index, 0.0, -120.0),
            renderer=True,
        )
    if material:
        scene.material(material, None)
    scene.node(
        "Weird_Kryt_Debris_01",
        pos=(250.0, 0.0, -150.0),
        renderer=True,
        materials=(material,) if material else (),
        scale=None if exact else (float("nan"), 1.0, 1.0),
    )
    scene.node("Widget", pos=(FORTRESS[0], 0.0, FORTRESS[1]), renderer=True)
    return scene


CLUSTERED_RAIL = ((240.0, -100.0), (240.6, -100.3), (240.9, -100.0))
SEPARATE_RAIL = ((260.0, -100.0), (270.0, -100.0), (280.0, -100.0))
CLUSTER_CONTAINERS = ((300.0, -60.0), (306.0, -60.0), (312.0, -60.0))


def clustered_anchors():
    """Nine anchors, three of which sit within 0.9 m of each other."""
    anchors = []
    for index, (x, z) in enumerate(CLUSTERED_RAIL + SEPARATE_RAIL):
        anchors.append(
            {
                "featureId": f"customs.prop.industrial_rail_yard.railcar_{index + 1}",
                "type": "railcar",
                "x": x,
                "z": z,
            }
        )
    for index, (x, z) in enumerate(CLUSTER_CONTAINERS):
        anchors.append(
            {
                "featureId": f"customs.prop.industrial_rail_yard.container_{index + 1}",
                "type": "container",
                "x": x,
                "z": z,
            }
        )
    return anchors


def roots_for_clustered_anchors(rail_positions, *, broken=()):
    """One root per supplied position, plus three containers and the witness."""
    scene = Scene()
    for index, (x, z) in enumerate(rail_positions):
        scene.node(
            f"Vagon_{index + 1:02d}",
            pos=(x, 0.0, z),
            renderer=True,
            scale=(float("nan"), 1.0, 1.0) if index in broken else None,
        )
    for index, (x, z) in enumerate(CLUSTER_CONTAINERS):
        scene.node(f"Container_{index + 1:02d}", pos=(x, 0.0, z), renderer=True)
    scene.node("Widget", pos=(FORTRESS[0], 0.0, FORTRESS[1]), renderer=True)
    return scene


def deep_prefab_no_lodgroup():
    scene = Scene()
    root = scene.node("Vagon_02", pos=(240.0, 0.0, -100.0))
    body = scene.node("Body", parent=root, pos=(240.0, 0.0, -100.0))
    scene.node("Mesh", parent=body, pos=(240.0, 1.0, -100.0), renderer=True)
    scene.node("Collider", parent=body, pos=(240.0, 0.5, -100.0))
    return scene


def long_group_split():
    scene = Scene()
    group = scene.node("Cluster", pos=(150.0, 0.0, -150.0))
    scene.node("Vagon_1", parent=group, pos=(150.0, 0.0, -150.0), renderer=True)
    scene.node("Vagon_2", parent=group, pos=(230.0, 0.0, -150.0), renderer=True)
    return scene


def oversized_single_object():
    scene = Scene()
    root = scene.node("Railcar_Long", pos=(220.0, 0.0, -140.0))
    scene.node("Railcar_Long_A", parent=root, pos=(220.0, 0.0, -140.0), renderer=True)
    scene.node("Railcar_Long_B", parent=root, pos=(244.0, 0.0, -140.0), renderer=True)
    return scene


def incomplete_hierarchy():
    scene = Scene()
    # The parent transform id names a transform that does not exist.
    scene.node("Orphan_Wagon", pos=(230.0, 0.0, -110.0), renderer=True,
               parent_transform=777_777)
    return scene


def cyclic_parents():
    scene = Scene()
    first_go, first_tr = scene._alloc(), scene._alloc()
    second_go, second_tr = scene._alloc(), scene._alloc()
    first_renderer, second_renderer = scene._alloc(), scene._alloc()
    scene.readers.extend(
        [
            game_object_reader(first_go, "CycleA", [first_tr, first_renderer], scene.asset),
            transform_reader(first_tr, first_go, second_tr, (0, 0, 0), scene.asset),
            renderer_reader(first_renderer, first_go, [], scene.asset),
            game_object_reader(second_go, "CycleB", [second_tr, second_renderer], scene.asset),
            transform_reader(second_tr, second_go, first_tr, (0, 0, 0), scene.asset),
            renderer_reader(second_renderer, second_go, [], scene.asset),
        ]
    )
    return scene


def coincident_roots():
    scene = Scene()
    scene.node("Vagon_A", pos=(230.0, 0.0, -110.0), renderer=True)
    scene.node("Vagon_B", pos=(230.4, 0.0, -110.0), renderer=True)
    return scene


def name_frequency_trap():
    """24 distinct names / 175 name references arranged as 6 real placements."""
    part_names = [
        "LOD0", "LOD1", "LOD2", "Mesh", "Model", "Body", "Frame", "Base",
        "Chassis", "Bogie", "Wheels", "Wheel", "Collider", "Colliders",
        "Collision", "Shadow", "Probe", "Bounds", "Pivot", "Geo", "Geometry",
        "Renderer", "Detail",
    ]
    assert len(part_names) == 23
    scene = Scene()
    cursor = 0
    remaining = 169
    for index in range(6):
        root = scene.node(
            f"Vagon_{index + 1:02d}",
            pos=(180.0 + 15.0 * index, 0.0, -120.0),
            renderer=True,
        )
        share = 29 if index == 0 else 28
        for step in range(share):
            scene.node(
                part_names[cursor % len(part_names)],
                parent=root,
                pos=(180.0 + 15.0 * index + (step % 3), 0.0, -120.0 + (step % 2)),
                renderer=True,
            )
            cursor += 1
            remaining -= 1
    assert remaining == 0
    return scene


def lexicon_scene():
    """One root per class, each with a single renderer and a unique name."""
    scene = Scene()
    names = [
        "Teplovoz_01",
        "Vagon_Kryt",
        "Vagon_Cisterna",
        "Vagon_Hopper",
        "Vagon_Platforma",
        "Vagon_Poluvagon",
        "Vagon",
        "Container_6m",
        "Container_40ft",
        "Container",
        "Tank_Storage",
        "Widget",
    ]
    for index, name in enumerate(names):
        scene.node(name, pos=(120.0 + 8.0 * index, 0.0, -110.0), renderer=True)
    return scene


def ambiguous_body_type():
    scene = Scene()
    for index in range(6):
        scene.node(
            f"Vagon_{index + 1:02d}",
            pos=(180.0 + 10.0 * index, 0.0, -120.0),
            renderer=True,
        )
    return scene


def claim_scene(covered=3, tanks=2, hoppers=1, containers=2, container_color=(0.62, 0.10, 0.09, 1.0)):
    """Rail stock on the track, containers off it, plus a Fortress witness."""
    scene = Scene()
    scene.material("Red_Container_Mat", container_color)
    for index in range(covered):
        scene.node(f"Vagon_Kryt_{index + 1:02d}", pos=(150.0 + 6.0 * index, 0.0, -110.0),
                   renderer=True)
    for index in range(tanks):
        scene.node(f"Vagon_Cisterna_{index + 1:02d}", pos=(200.0 + 6.0 * index, 0.0, -110.0),
                   renderer=True)
    for index in range(hoppers):
        scene.node(f"Vagon_Hopper_{index + 1:02d}", pos=(240.0 + 6.0 * index, 0.0, -110.0),
                   renderer=True)
    for index in range(containers):
        scene.node(
            f"Container_6m_{index + 1:02d}",
            pos=(300.0 + 6.0 * index, 0.0, -60.0),
            renderer=True,
            materials=("Red_Container_Mat",),
        )
    scene.node("Widget", pos=(FORTRESS[0], 0.0, FORTRESS[1]), renderer=True)
    return scene


CLAIM_RAILWAY = [[(0.0, -110.0), (400.0, -110.0)]]


def nine_anchors():
    rail = [
        (251.6, -184.0), (262.1, -174.6), (267.1, -168.6),
        (271.9, -162.8), (276.5, -157.2), (263.9, -124.2),
    ]
    containers = [(233.0, -89.0), (200.3, -95.6), (254.6, -112.6)]
    anchors = []
    for index, (x, z) in enumerate(rail):
        anchors.append(
            {
                "featureId": f"customs.prop.industrial_rail_yard.railcar_{index + 1}",
                "type": "railcar",
                "x": x,
                "z": z,
            }
        )
    for index, (x, z) in enumerate(containers):
        anchors.append(
            {
                "featureId": f"customs.prop.industrial_rail_yard.container_{index + 1}",
                "type": "container",
                "x": x,
                "z": z,
            }
        )
    return anchors


# The six rail anchors, joined into one polyline: the nine-proxy fixture claims
# real rail cars stand on the nine anchors, and a rail car standing on a rail
# yard is on the rails.  D5's match is band-gated, and a rail root 14–74 m off
# every track takes the R− penalty and lands in `unresolved`, which is not an
# object anyone would build against.
NINE_PROXY_RAILWAY = [
    [
        (251.6, -184.0), (262.1, -174.6), (267.1, -168.6),
        (271.9, -162.8), (276.5, -157.2), (263.9, -124.2),
    ]
]


def nine_proxy_scene():
    scene = Scene()
    anchors = nine_anchors()
    for anchor in anchors:
        if anchor["type"] == "railcar":
            scene.node(
                f"Vagon_{anchor['featureId'][-1]}",
                pos=(anchor["x"], 0.0, anchor["z"]),
                renderer=True,
            )
        else:
            scene.node(
                f"Container_{anchor['featureId'][-1]}",
                pos=(anchor["x"], 0.0, anchor["z"]),
                renderer=True,
            )
    scene.node("Widget", pos=(FORTRESS[0], 0.0, FORTRESS[1]), renderer=True)
    return scene


FORBIDDEN_TYPE_READERS = lambda: [
    FakeReader("Mesh", 900_001, AssertionError("Mesh must never be parsed")),
    FakeReader("Texture2D", 900_002, AssertionError("Texture2D must never be parsed")),
    FakeReader("Shader", 900_003, AssertionError("Shader must never be parsed")),
    FakeReader("MonoBehaviour", 900_004, AssertionError("MonoBehaviour must never be parsed")),
    FakeReader("AnimationClip", 900_005, AssertionError("AnimationClip must never be parsed")),
    FakeReader("AudioClip", 900_006, AssertionError("AudioClip must never be parsed")),
]


# --------------------------------------------------------------------------
# §2 counting placed roots
# --------------------------------------------------------------------------


class CountingTests(RootsTestCase):
    def test_one_wagon_with_lods_is_one_root_not_four(self):
        document, _facts, _fake = self.build(one_wagon_with_lods())
        self.assertEqual(document["counts"]["electedRoots"], 1)
        self.assertEqual(document["roots"][0]["normalizedName"], "vagon")
        self.assertEqual(document["roots"][0]["lodCount"], 3)

    def test_five_wagons_under_one_group_elect_five_roots(self):
        document, _facts, _fake = self.build(five_wagons_under_one_group())
        self.assertEqual(document["counts"]["electedRoots"], 5)
        self.assertEqual(document["counts"]["spanRejectedCount"], 1)
        rejected = document["diagnostics"]["spanRejected"][0]
        self.assertAlmostEqual(rejected["spanM"], 48.0, places=3)
        self.assertEqual(rejected["childCount"], 5)
        self.assertNotIn(
            "railyard_wagons", {item["normalizedName"] for item in document["roots"]}
        )

    def test_two_placements_behind_part_named_children_are_two_roots(self):
        """D1: the yard is undercounted when a placement hides behind `Mesh`."""
        document, _facts, _fake = self.build(two_placements_behind_part_named_children())
        self.assertEqual(document["counts"]["electedRoots"], 2)
        names = [item["normalizedName"] for item in document["roots"]]
        self.assertEqual(names, ["container", "container"])
        self.assertNotIn("containers", names)
        positions = sorted(item["world"]["position"]["x"] for item in document["roots"])
        self.assertEqual(positions, [230.0, 237.0])

    def test_containers_rendering_only_through_their_own_lods_are_counted(self):
        """A1: a node's own LOD levels are never evidence that it is a group."""
        document, _facts, _fake = self.build(
            containers_rendering_only_through_their_own_lods(), cross_check=False
        )
        self.assertEqual(document["counts"]["electedRoots"], 2)
        self.assertEqual(
            [item["normalizedName"] for item in document["roots"]],
            ["container", "container"],
        )
        self.assertEqual(
            sorted(item["world"]["position"]["x"] for item in document["roots"]),
            [230.0, 236.0],
        )
        self.assertEqual(document["counts"]["unresolvedRejectionCount"], 0)
        self.assertFalse(document["counts"]["rootCountIsLowerBound"])

        # Variant: the singular/plural spellings that reach the conditional rule
        # from both sides, and three levels instead of two.
        variant = Scene()
        for name, x in (("Container", 230.0), ("Containers", 240.0)):
            crate = variant.node(name, pos=(x, 0.0, -110.0))
            members = [
                variant.node(f"LOD{level}", parent=crate, pos=(x, 0.0, -110.0),
                             renderer=True)
                for level in range(3)
            ]
            variant.lod_group(crate, members)
        document, _facts, _fake = self.build(variant, cross_check=False)
        self.assertEqual(document["counts"]["electedRoots"], 2)
        self.assertEqual(
            sorted(item["normalizedName"] for item in document["roots"]),
            ["container", "containers"],
        )

    def test_a_lod_level_is_never_evidence_of_grouping_or_of_a_branch(self):
        """A1: R1 owns a LOD level, so no other rule may read one as a placement."""
        # Counted as a distinct descendant family, the wrapper is rejected and
        # the placement root moves inwards off the outermost transform.
        wrapped = Scene()
        wrapper = wrapped.node("Depot_A", pos=(230.0, 0.0, -110.0))
        owner = wrapped.node("Vagon_01", parent=wrapper, pos=(230.0, 0.0, -110.0))
        members = [
            wrapped.node(name, parent=owner, pos=(230.0 + index, 0.0, -110.0),
                         renderer=True)
            for index, name in enumerate(("Alpha_Detail_Hi", "Beta_Detail_Lo"))
        ]
        wrapped.lod_group(owner, members)
        document, _facts, _fake = self.build(wrapped, cross_check=False)
        self.assertEqual(document["counts"]["electedRoots"], 1)
        self.assertEqual(document["roots"][0]["normalizedName"], "depot_a")
        self.assertEqual(document["roots"][0]["renderableDescendantCount"], 3)
        self.assertEqual(document["roots"][0]["lodCount"], 2)

        # Counted as placement branches, the LOD levels are split off the root
        # that owns them and the root under-reports its own geometry.
        bare = Scene()
        owner = bare.node("Vagon_01", pos=(230.0, 0.0, -110.0))
        members = [
            bare.node(name, parent=owner, pos=(230.0 + index, 0.0, -110.0), renderer=True)
            for index, name in enumerate(("Alpha_Detail_Hi", "Beta_Detail_Lo"))
        ]
        bare.lod_group(owner, members)
        document, _facts, _fake = self.build(bare, cross_check=False)
        self.assertEqual(document["counts"]["electedRoots"], 1)
        root = document["roots"][0]
        self.assertEqual(root["normalizedName"], "vagon")
        self.assertEqual(root["renderableDescendantCount"], 3)
        self.assertEqual(root["descendantCount"], 2)
        self.assertEqual(root["pivotSpanM"], 1.0)

    def test_a_rejection_that_elects_nothing_is_ledgered_never_silent(self):
        """A1: objects may leave the count, but never without a row saying so."""
        document, _facts, _fake = self.build(
            a_group_whose_whole_descent_is_lod_interiors(), cross_check=False
        )
        self.assertEqual(document["counts"]["electedRoots"], 0)
        self.assertEqual(document["counts"]["unresolvedRejectionCount"], 1)
        row = document["diagnostics"]["unresolvedRejections"][0]
        self.assertEqual(row["rule"], "R4-group-name")
        self.assertEqual(row["renderableDescendantCount"], 3)
        self.assertEqual(len(row["hierarchyPathHash"]), 64)
        self.assertNotIn("name", row)
        self.assertNotIn("Yard", json.dumps(document))
        # A count that lost objects is a floor, and a floor may render no verdict.
        self.assertTrue(document["counts"]["rootCountIsLowerBound"])
        self.assertEqual(document["claimVerdict"]["overall"], "inconclusive")

        # Variant: a different group token, and the rejection still cannot be
        # silent.  A rejection whose descent DOES elect something is not a row.
        variant, _facts, _fake = self.build(
            a_group_whose_whole_descent_is_lod_interiors("Zone"), cross_check=False
        )
        self.assertEqual(variant["counts"]["unresolvedRejectionCount"], 1)
        resolved, _facts, _fake = self.build(
            renderable_group_named_yard(), cross_check=False
        )
        self.assertEqual(resolved["counts"]["electedRoots"], 1)
        self.assertEqual(resolved["counts"]["unresolvedRejectionCount"], 0)

    def test_a_wrapper_named_like_its_children_still_yields_two_roots(self):
        """A2: an identical normalized name is an instance, never a part."""
        document, _facts, _fake = self.build(
            two_placements_under_a_wrapper_of_the_same_name(), cross_check=False
        )
        self.assertEqual(document["counts"]["electedRoots"], 2)
        self.assertEqual(
            [item["normalizedName"] for item in document["roots"]],
            ["container", "container"],
        )
        self.assertEqual(
            sorted(item["world"]["position"]["x"] for item in document["roots"]),
            [230.0, 237.0],
        )

        # Variant: a different family word, a different part name, and indices
        # that are neither 01 nor contiguous.
        variant, _facts, _fake = self.build(
            two_placements_under_a_wrapper_of_the_same_name(family="Vagon", part="Body"),
            cross_check=False,
        )
        self.assertEqual(variant["counts"]["electedRoots"], 2)
        self.assertEqual(
            {item["normalizedName"] for item in variant["roots"]}, {"vagon"}
        )

        # Control: a strictly longer child name is still a part, so spec §8
        # test 5's 24 m object stays ONE root at the default span.
        control, _facts, _fake = self.build(oversized_single_object())
        self.assertEqual(control["counts"]["electedRoots"], 1)

    def test_five_numbered_siblings_survive_a_raised_span_guard(self):
        """A2: `Wagons -> Wagons_01..05` are five placements, not one, at any span."""
        strict, _facts, _fake = self.build(
            five_numbered_wagons_under_a_same_named_parent()
        )
        self.assertEqual(strict["counts"]["electedRoots"], 5)
        loose, _facts, _fake = self.build(
            five_numbered_wagons_under_a_same_named_parent(),
            parameters={"maxPlacementSpanM": 1000.0},
        )
        self.assertEqual(loose["counts"]["electedRoots"], 5)
        self.assertEqual(loose["counts"]["spanRejectedCount"], 0)
        # The part-named spelling is the one R5 alone holds apart.
        part_named, _facts, _fake = self.build(
            five_same_named_wagons_under_a_parent(),
            parameters={"maxPlacementSpanM": 1000.0},
        )
        self.assertEqual(part_named["counts"]["electedRoots"], 1)

    def test_a_stack_of_renderers_is_one_root_per_object(self):
        """A3: a node that renders is no longer exempt from being read as many."""
        document, _facts, _fake = self.build(a_stack_of_renderers(), cross_check=False)
        self.assertEqual(document["counts"]["electedRoots"], 3)
        self.assertEqual(
            {item["normalizedName"] for item in document["roots"]}, {"container"}
        )
        for item in document["roots"]:
            # Each root owns its own geometry and nothing below it: a split root
            # that still aggregated the nested placements' renderers and pivots
            # would report the stack's span as its own.
            self.assertEqual(item["renderableDescendantCount"], 1, item["rootId"])
            self.assertEqual(item["pivotSpanM"], 0.0, item["rootId"])
            self.assertEqual(item["descendantCount"], 0, item["rootId"])

        # Variant: two deep, a different family word, a different pitch.
        variant, _facts, _fake = self.build(
            a_stack_of_renderers(family="Konteyner", count=2, pitch=1.4),
            cross_check=False,
        )
        self.assertEqual(variant["counts"]["electedRoots"], 2)

        # Control: a rendering node whose branches read as its parts, and a
        # single differently-named branch, both stay ONE placement.
        control = Scene()
        wagon = control.node("Vagon_02", pos=(230.0, 0.0, -110.0), renderer=True)
        body = control.node("Body", parent=wagon, pos=(230.0, 1.0, -110.0), renderer=True)
        control.node("Mesh", parent=body, pos=(230.0, 1.5, -110.0), renderer=True)
        control.node("Wheels_Front", parent=wagon, pos=(232.0, 0.0, -110.0), renderer=True)
        document, _facts, _fake = self.build(control, cross_check=False)
        self.assertEqual(document["counts"]["electedRoots"], 1)
        self.assertEqual(document["roots"][0]["renderableDescendantCount"], 4)

    def test_a_wrapper_over_two_families_is_rejected_by_name_variety(self):
        """R4's distinct-name rule, on a wrapper with only one branch."""
        document, _facts, _fake = self.build(one_branch_two_families(), cross_check=False)
        self.assertEqual(document["counts"]["electedRoots"], 2)
        self.assertEqual(
            sorted(item["normalizedName"] for item in document["roots"]),
            ["konteyner", "vagon"],
        )
        self.assertEqual(document["counts"]["spanRejectedCount"], 0)

    def test_a_node_named_yard_is_a_group_even_when_it_renders(self):
        """R4's GROUP_NAME_TOKENS branch — the only rule that can fire here."""
        document, _facts, _fake = self.build(renderable_group_named_yard())
        self.assertEqual(document["counts"]["electedRoots"], 1)
        self.assertEqual(document["roots"][0]["normalizedName"], "vagon_yardside")
        self.assertEqual(document["counts"]["spanRejectedCount"], 0)

    def test_a_node_named_containers_is_a_group_only_with_two_named_children(self):
        """R4's CONDITIONAL_GROUP_NAMES branch — the only rule that can fire here."""
        document, _facts, _fake = self.build(
            renderable_containers_with_two_named_children()
        )
        self.assertEqual(document["counts"]["electedRoots"], 2)
        self.assertEqual(
            sorted(item["normalizedName"] for item in document["roots"]),
            ["container_left", "container_right"],
        )

    def test_the_conditional_container_rule_needs_two_DISTINCT_child_names(self):
        """D5t: two renderable children of ONE name is one object, not a group.

        `Container -> {Mesh, Mesh}` is a single crate rendering through two
        meshes.  Dropping `len(names) >= 2` from the conditional rule rejects the
        crate and elects its two meshes as two placements.
        """
        scene = Scene()
        crate = scene.node("Container", pos=(230.0, 0.0, -110.0))
        scene.node("Mesh", parent=crate, pos=(230.0, 1.0, -110.0), renderer=True)
        scene.node("Mesh", parent=crate, pos=(231.0, 1.0, -110.0), renderer=True)
        document, _facts, _fake = self.build(scene, cross_check=False)
        self.assertEqual(document["counts"]["electedRoots"], 1)
        self.assertEqual(document["roots"][0]["normalizedName"], "container")
        self.assertEqual(document["roots"][0]["renderableDescendantCount"], 2)

        # Two DIFFERENT names under the same node is the group the rule is for.
        distinct = Scene()
        crate = distinct.node("Container", pos=(230.0, 0.0, -110.0), renderer=True)
        distinct.node("Crate_Left", parent=crate, pos=(229.0, 0.0, -110.0), renderer=True)
        distinct.node("Crate_Right", parent=crate, pos=(231.0, 0.0, -110.0), renderer=True)
        document, _facts, _fake = self.build(distinct, cross_check=False)
        self.assertEqual(document["counts"]["electedRoots"], 2)
        self.assertEqual(
            sorted(item["normalizedName"] for item in document["roots"]),
            ["crate_left", "crate_right"],
        )

    def test_deep_prefab_without_a_lodgroup_is_one_root(self):
        document, _facts, _fake = self.build(deep_prefab_no_lodgroup())
        self.assertEqual(document["counts"]["electedRoots"], 1)
        self.assertEqual(document["roots"][0]["normalizedName"], "vagon")
        self.assertEqual(document["roots"][0]["descendantCount"], 3)

    def test_long_group_is_span_rejected_and_its_children_elected(self):
        document, _facts, _fake = self.build(long_group_split())
        self.assertEqual(document["counts"]["electedRoots"], 2)
        self.assertEqual(document["counts"]["spanRejectedCount"], 1)
        self.assertAlmostEqual(
            document["diagnostics"]["spanRejected"][0]["spanM"], 80.0, places=3
        )

    def test_span_threshold_is_the_only_thing_that_moves_and_is_recorded(self):
        wide, _facts, _fake = self.build(oversized_single_object())
        narrow, _facts, _fake = self.build(
            oversized_single_object(), parameters={"maxPlacementSpanM": 20.0}
        )
        self.assertEqual(wide["counts"]["electedRoots"], 1)
        self.assertEqual(wide["counts"]["spanRejectedCount"], 0)
        self.assertEqual(narrow["counts"]["electedRoots"], 2)
        self.assertEqual(narrow["counts"]["spanRejectedCount"], 1)
        self.assertEqual(wide["parameters"]["maxPlacementSpanM"], 26.0)
        self.assertEqual(narrow["parameters"]["maxPlacementSpanM"], 20.0)

    def test_incomplete_hierarchy_elects_nothing_and_says_so(self):
        document, _facts, _fake = self.build(incomplete_hierarchy())
        self.assertEqual(document["counts"]["electedRoots"], 0)
        self.assertEqual(document["counts"]["unrootableNodeCount"], 1)
        self.assertTrue(document["counts"]["rootCountIsLowerBound"])
        self.assertFalse(document["complete"])
        row = document["diagnostics"]["unrootableNodes"][0]
        self.assertEqual(row["reason"], "hierarchy-incomplete")
        self.assertEqual(len(row["hierarchyPathHash"]), 64)
        self.assertNotIn("name", row)
        self.assertNotIn("Orphan_Wagon", json.dumps(document))
        # No elected root at all, so no in-scope root can be missing anything.
        self.assertEqual(document["scopeIntegrity"], "sound")

    def test_a_broken_node_under_an_in_scope_root_makes_the_scope_suspect(self):
        document, _facts, _fake = self.build(broken_node_under_an_in_scope_root())
        self.assertEqual(document["counts"]["electedRoots"], 1)
        root = document["roots"][0]
        self.assertEqual(root["normalizedName"], "vagon_stack")
        self.assertTrue(root["inScope"])
        self.assertGreater(document["counts"]["unrootableNodeCount"], 0)
        # The ancestor walk is the whole point: the broken nodes hang under an
        # elected, in-scope root, so the count for that scope cannot be trusted.
        self.assertEqual(document["scopeIntegrity"], "suspect")
        self.assertTrue(document["counts"]["rootCountIsLowerBound"])
        self.assertFalse(document["complete"])

    def test_a_broken_node_outside_every_in_scope_root_leaves_the_scope_sound(self):
        scene = broken_node_under_an_in_scope_root()
        # Same broken chain, but its elected root now stands outside the box, so
        # the walk must find nothing and the verdict must stay "sound".
        far, _facts, _fake = self.build(
            scene, scope={**SCOPE, "center": (-2000.0, -2000.0)}
        )
        self.assertGreater(far["counts"]["unrootableNodeCount"], 0)
        self.assertEqual(far["counts"]["rootsInScope"], 0)
        self.assertEqual(far["scopeIntegrity"], "sound")

    def test_incomplete_hierarchy_refuses_to_publish_without_allow_partial(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            output = base / "roots.json"
            code, _stdout, stderr = self.run_main(
                [
                    "--source", str(source),
                    "--output", str(output),
                    "--acknowledge-local-game-files",
                ],
                FakeUnityPy(incomplete_hierarchy().environments()),
            )
            self.assertEqual(code, 2)
            self.assertIn("incomplete", stderr)
            self.assertIn("1 unrootable nodes", stderr)
            self.assertFalse(output.exists())

    def test_cyclic_parents_are_ledgered_without_recursing_forever(self):
        document, _facts, _fake = self.build(cyclic_parents())
        self.assertEqual(document["counts"]["electedRoots"], 0)
        self.assertEqual(document["counts"]["unrootableNodeCount"], 2)
        self.assertEqual(
            {row["reason"] for row in document["diagnostics"]["unrootableNodes"]},
            {"hierarchy-unreachable"},
        )
        self.assertTrue(document["counts"]["rootCountIsLowerBound"])

    def test_coincident_roots_are_reported_and_never_merged(self):
        document, _facts, _fake = self.build(coincident_roots())
        self.assertEqual(document["counts"]["electedRoots"], 2)
        self.assertEqual(document["counts"]["coincidentRootGroupCount"], 1)
        group = document["diagnostics"]["coincidentRootGroups"][0]
        self.assertEqual(len(group["rootIds"]), 2)
        self.assertAlmostEqual(group["distanceM"], 0.4, places=3)

    def test_name_frequency_trap_counts_placements_not_names(self):
        document, facts, _fake = self.build(name_frequency_trap())
        names = [item.get("name", "") for item in facts["gameObjects"]]
        normalized = {item.get("normalizedName") for item in facts["gameObjects"]}
        self.assertEqual(len(names), 175)
        self.assertEqual(len(normalized), 24)
        self.assertEqual(document["counts"]["electedRoots"], 6)
        self.assertEqual(document["counts"]["gameObjectsParsed"], 175)
        self.assertEqual(document["counts"]["renderablesParsed"], 175)
        self.assertEqual(
            {item["normalizedName"] for item in document["roots"]}, {"vagon"}
        )

    def test_root_ids_are_stable_lowercase_hex_of_the_object_id(self):
        document, _facts, _fake = self.build(coincident_roots())
        for item in document["roots"]:
            self.assertTrue(item["rootId"].startswith("customs.root."))
            suffix = item["rootId"].split(".")[-1]
            self.assertEqual(len(suffix), 12)
            self.assertEqual(suffix, suffix.lower())
            int(suffix, 16)
            self.assertEqual(item["rootId"], roots_module._root_id(item["objectId"]))
            self.assertRegex(item["rootId"], TRUTH_GRAPH_ID_PATTERN)

    def test_roots_and_families_carry_the_contract_ordering(self):
        document, _facts, _fake = self.build(
            claim_scene(), terrain={"envelope": TERRAIN_ENVELOPE, "railway": CLAIM_RAILWAY}
        )
        root_keys = [
            (
                item["class"],
                item["world"]["position"]["x"],
                item["world"]["position"]["z"],
                item["objectId"],
            )
            for item in document["roots"]
        ]
        self.assertEqual(root_keys, sorted(root_keys))
        family_keys = [
            (-item["instanceCount"], item["normalizedName"]) for item in document["families"]
        ]
        self.assertEqual(family_keys, sorted(family_keys))

    def test_no_hierarchy_path_or_texture_name_ever_reaches_the_artifact(self):
        scene = Scene()
        scene.material("Concrete_Albedo_Mat", None)
        parent = scene.node("Secret_Authoring_Group", pos=(230.0, 0.0, -110.0))
        scene.node("Vagon_Kryt", parent=parent, pos=(230.0, 0.0, -110.0), renderer=True,
                   materials=("Concrete_Albedo_Mat",))
        document, facts, _fake = self.build(scene)
        payload = json.dumps(document, sort_keys=True)
        self.assertIn(
            "Secret_Authoring_Group",
            json.dumps(facts["gameObjects"]),
        )
        self.assertNotIn("Secret_Authoring_Group", payload)
        self.assertNotIn("hierarchyPath\"", payload)
        self.assertNotIn("textureProperties", payload)
        self.assertNotIn("textureName", payload)
        for item in document["roots"]:
            self.assertNotIn("hierarchyPath", item)
            self.assertNotIn("name", item)
            self.assertEqual(len(item["hierarchyPathHash"]), 64)


# --------------------------------------------------------------------------
# §3 scope and frame
# --------------------------------------------------------------------------


class ScopeAndFrameTests(RootsTestCase):
    def test_scope_boundary_is_inclusive_at_the_edge(self):
        scene = Scene()
        scene.node("Vagon_Edge_X", pos=(410.0, 0.0, -110.0), renderer=True)
        scene.node("Vagon_Edge_Z", pos=(230.0, 0.0, 40.0), renderer=True)
        scene.node("Vagon_Out_X", pos=(410.01, 0.0, -110.0), renderer=True)
        scene.node("Vagon_Out_Z", pos=(230.0, 0.0, 40.01), renderer=True)
        document, _facts, _fake = self.build(scene)
        by_hash = {
            item["nameHash"]: item["inScope"] for item in document["roots"]
        }
        self.assertEqual(document["counts"]["rootsInScope"], 2)
        self.assertEqual(sum(1 for value in by_hash.values() if value), 2)

    def test_frame_witness_present_confirms_the_source_frame(self):
        scene = Scene()
        scene.node("Vagon_Yard", pos=(230.0, 0.0, -110.0), renderer=True)
        scene.node("Widget", pos=(FORTRESS[0], 1.0, FORTRESS[1]), renderer=True)
        document, _facts, _fake = self.build(scene)
        frame = document["frameCheck"]
        self.assertEqual(frame["fortressWitness"], "confirmed")
        self.assertLess(frame["fortressWitnessDistanceM"], 0.001)
        self.assertIsNotNone(frame["fortressWitnessRootId"])
        self.assertEqual(frame["verdict"], "confirmed")
        self.assertTrue(document["frameVerified"])
        self.assertTrue(document["complete"])

    def test_frame_witness_absent_refuses_to_publish(self):
        scene = Scene()
        scene.node("Vagon_Far", pos=(400.0, 0.0, 30.0), renderer=True)
        document, _facts, _fake = self.build(scene)
        self.assertEqual(document["frameCheck"]["fortressWitness"], "failed")
        self.assertIsNone(document["frameCheck"]["fortressWitnessRootId"])
        self.assertEqual(document["frameCheck"]["verdict"], "unverified")
        self.assertFalse(document["frameVerified"])
        self.assertTrue(document["complete"])

        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            output = base / "roots.json"
            code, _stdout, stderr = self.run_main(
                [
                    "--source", str(source),
                    "--output", str(output),
                    "--acknowledge-local-game-files",
                ],
                FakeUnityPy(scene.environments()),
            )
        self.assertEqual(code, 2)
        self.assertIn("frame verification", stderr)
        self.assertFalse(output.exists())

    def test_mirrored_scene_is_contradicted_even_though_it_lands_on_the_map(self):
        scene = Scene()
        scene.node("Vagon_Yard", pos=(-230.0, 0.0, 110.0), renderer=True)
        scene.node("Widget", pos=(-FORTRESS[0], 1.0, -FORTRESS[1]), renderer=True)
        document, _facts, _fake = self.build(scene)
        frame = document["frameCheck"]
        # The mirrored reading is entirely inside the Customs terrain envelope,
        # so "the roots landed on the map" proves nothing.
        self.assertEqual(frame["outsideTerrainEnvelopeCount"], 0)
        self.assertEqual(frame["verdict"], "contradicted")
        self.assertFalse(document["frameVerified"])
        self.assertLess(
            frame["mirroredFrameWitnessDistanceM"], frame["sourceFrameWitnessDistanceM"]
        )
        self.assertEqual(frame["sourceFrameRootCount"], 0)
        self.assertEqual(frame["mirroredFrameRootCount"], 2)

        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            output = base / "roots.json"
            code, _stdout, stderr = self.run_main(
                [
                    "--source", str(source),
                    "--output", str(output),
                    "--acknowledge-local-game-files",
                ],
                FakeUnityPy(scene.environments()),
            )
        self.assertEqual(code, 2)
        self.assertIn("contradicted", stderr)
        self.assertFalse(output.exists())

    def test_roots_outside_the_terrain_envelope_are_counted_not_dropped(self):
        scene = Scene()
        scene.node("Vagon_Lost", pos=(5000.0, 0.0, -110.0), renderer=True)
        scene.node("Widget", pos=(FORTRESS[0], 0.0, FORTRESS[1]), renderer=True)
        document, _facts, _fake = self.build(scene)
        self.assertEqual(document["counts"]["electedRoots"], 2)
        self.assertEqual(document["frameCheck"]["outsideTerrainEnvelopeCount"], 1)
        self.assertAlmostEqual(
            document["frameCheck"]["outsideTerrainEnvelopeFraction"], 0.5, places=3
        )

    def test_no_cross_check_degrades_but_the_frame_witness_still_gates(self):
        scene = Scene()
        scene.node("Vagon_Yard", pos=(230.0, 0.0, -110.0), renderer=True)
        scene.node("Widget", pos=(FORTRESS[0], 0.0, FORTRESS[1]), renderer=True)
        document, _facts, _fake = self.build(
            scene,
            cross_check=False,
            terrain={"envelope": TERRAIN_ENVELOPE, "railway": CLAIM_RAILWAY},
            anchors=nine_anchors(),
        )
        self.assertEqual(document["frameCheck"]["terrainEnvelope"], "unavailable")
        self.assertIsNone(document["frameCheck"]["outsideTerrainEnvelopeCount"])
        self.assertEqual(document["classification"]["railAdjacency"], "unavailable")
        self.assertEqual(document["crossChecks"]["anchors"], "unavailable")
        self.assertEqual(document["crossChecks"]["anchorsVerdict"], "unavailable")
        self.assertEqual(document["frameCheck"]["fortressWitness"], "confirmed")
        self.assertTrue(document["frameVerified"])


# --------------------------------------------------------------------------
# §4 classification
# --------------------------------------------------------------------------


class ClassificationTests(RootsTestCase):
    def test_lexicon_hits_pin_the_exact_class_and_confidence(self):
        document, _facts, _fake = self.build(lexicon_scene(), cross_check=False)
        by_name = {item["normalizedName"]: item for item in document["roots"]}
        expected = {
            "teplovoz": roots_module.CLASS_RAIL_LOCOMOTIVE,
            "vagon_kryt": roots_module.CLASS_RAIL_COVERED,
            "vagon_cisterna": roots_module.CLASS_RAIL_TANK,
            "vagon_hopper": roots_module.CLASS_RAIL_HOPPER,
            "vagon_platforma": roots_module.CLASS_RAIL_FLAT,
            "vagon_poluvagon": roots_module.CLASS_RAIL_GONDOLA,
            "vagon": roots_module.CLASS_RAIL_UNSPECIFIED,
            "container_6m": roots_module.CLASS_CONTAINER_6M,
            "container_40ft": roots_module.CLASS_CONTAINER_12M,
            "container": roots_module.CLASS_CONTAINER_UNSPECIFIED,
            "tank_storage": roots_module.CLASS_TANK_STATIC,
            "widget": roots_module.CLASS_UNCLASSIFIED,
        }
        self.assertEqual({name: by_name[name]["class"] for name in expected}, expected)
        for name in expected:
            if name == "widget":
                self.assertEqual(by_name[name]["confidence"], 0.0, name)
                self.assertEqual(by_name[name]["band"], "unresolved", name)
                continue
            # N alone: exactly 0.35, never a range.
            self.assertEqual(by_name[name]["confidence"], 0.35, name)
            self.assertEqual(by_name[name]["band"], "unresolved", name)
            self.assertEqual(by_name[name]["confidenceChannels"]["N"], 0.35, name)
            self.assertIsNone(by_name[name]["confidenceChannels"]["R"], name)

    def test_worked_sanity_check_n_plus_m_is_exactly_0_55(self):
        # The root carries the renderer, so its own name is strong (N) evidence.
        scene = Scene()
        scene.material("Cisterna_Steel", None)
        scene.node(
            "Vagon_Cisterna_Yard", pos=(230.0, 0.0, -110.0), renderer=True,
            materials=("Cisterna_Steel",),
        )
        document, _facts, _fake = self.build(scene, cross_check=False)
        root = document["roots"][0]
        self.assertEqual(root["class"], roots_module.CLASS_RAIL_TANK)
        self.assertEqual(root["confidence"], 0.55)
        self.assertEqual(root["band"], "probable")
        self.assertEqual(
            {key: root["confidenceChannels"][key] for key in ("N", "P", "M", "L", "S", "F")},
            {"N": 0.35, "P": 0, "M": 0.20, "L": 0, "S": 0, "F": 0},
        )

    def test_a_renderer_less_wrapper_name_scores_weak_not_strong(self):
        """D2: an incidental wrapper name must not manufacture a confident identity.

        `Kryt_Vagony` renders nothing; the object that renders is `Vagon_02`
        wearing a `Cisterna_Metal` material.  The wrapper is still the placement
        root — descent past it would split `deep_prefab_no_lodgroup` in two — but
        its name is ancestor-strength evidence (P), so `kryt` cannot outvote the
        geometry's own material and land a confident `rail-wagon-covered`.
        """
        scene = Scene()
        scene.material("Cisterna_Metal", None)
        wrapper = scene.node("Kryt_Vagony", pos=(230.0, 0.0, -110.0))
        scene.node("Vagon_02", parent=wrapper, pos=(230.0, 0.0, -110.0), renderer=True,
                   materials=("Cisterna_Metal",))
        document, _facts, _fake = self.build(scene, cross_check=False)
        self.assertEqual(document["counts"]["electedRoots"], 1)
        root = document["roots"][0]
        self.assertEqual(root["normalizedName"], "kryt_vagony")
        self.assertEqual(root["class"], roots_module.CLASS_RAIL_COVERED)
        self.assertEqual(
            {key: root["confidenceChannels"][key] for key in ("N", "P", "M")},
            {"N": 0, "P": 0.20, "M": 0},
        )
        self.assertEqual(root["confidence"], 0.20)
        self.assertEqual(root["band"], "unresolved")
        # The material's own reading is level with the wrapper's name, and both
        # sit far below `established`: nothing here is confidently identified.
        self.assertEqual(
            root["competingClasses"],
            [{"class": roots_module.CLASS_RAIL_TANK, "score": 0.20}],
        )

        # The same tokens on a node that DOES render score at full N strength.
        renderable = Scene()
        renderable.material("Cisterna_Metal", None)
        renderable.node("Kryt_Vagony", pos=(230.0, 0.0, -110.0), renderer=True,
                        materials=("Cisterna_Metal",))
        strong, _facts, _fake = self.build(renderable, cross_check=False)
        self.assertEqual(strong["roots"][0]["class"], roots_module.CLASS_RAIL_COVERED)
        self.assertEqual(strong["roots"][0]["confidenceChannels"]["N"], 0.35)
        self.assertEqual(strong["roots"][0]["confidenceChannels"]["P"], 0)
        self.assertEqual(strong["roots"][0]["confidence"], 0.35)

    def test_worked_sanity_check_n_plus_p_plus_m_is_exactly_0_75(self):
        scene = Scene()
        scene.material("Cisterna_Steel", None)
        group = scene.node("Cisterna_Yard", pos=(150.0, 0.0, -110.0))
        scene.node("Vagon_Cisterna_Alpha", parent=group, pos=(150.0, 0.0, -110.0),
                   renderer=True, materials=("Cisterna_Steel",))
        scene.node("Vagon_Cisterna_Beta", parent=group, pos=(200.0, 0.0, -110.0),
                   renderer=True, materials=("Cisterna_Steel",))
        document, _facts, _fake = self.build(scene, cross_check=False)
        self.assertEqual(document["counts"]["electedRoots"], 2)
        for root in document["roots"]:
            self.assertEqual(root["class"], roots_module.CLASS_RAIL_TANK)
            self.assertEqual(root["confidence"], 0.75)
            self.assertEqual(root["band"], "established")
            self.assertEqual(
                {key: root["confidenceChannels"][key] for key in ("N", "P", "M", "F")},
                {"N": 0.35, "P": 0.20, "M": 0.20, "F": 0},
            )

    def test_worked_sanity_check_n_plus_m_plus_l_plus_s_is_exactly_0_75(self):
        scene = Scene()
        scene.material("Cisterna_Steel", None)
        root_go = scene.node("Vagon_Cisterna", pos=(230.0, 0.0, -110.0))
        members = [
            scene.node(f"LOD{index}", parent=root_go, pos=(230.0 + 2.0 * index, 0.0, -110.0),
                       renderer=True, materials=("Cisterna_Steel",))
            for index in range(2)
        ]
        scene.lod_group(root_go, members)
        document, _facts, _fake = self.build(scene, cross_check=False)
        root = document["roots"][0]
        self.assertEqual(root["class"], roots_module.CLASS_RAIL_TANK)
        self.assertEqual(root["lodCount"], 2)
        self.assertEqual(root["renderableDescendantCount"], 3)
        self.assertEqual(root["pivotSpanM"], 2.0)
        self.assertEqual(root["confidence"], 0.75)
        self.assertEqual(root["band"], "established")
        self.assertEqual(
            {key: root["confidenceChannels"][key] for key in ("N", "P", "M", "L", "S")},
            {"N": 0.35, "P": 0, "M": 0.20, "L": 0.10, "S": 0.10},
        )

    def test_ambiguous_body_type_is_reported_as_not_separable(self):
        document, _facts, _fake = self.build(ambiguous_body_type(), cross_check=False)
        self.assertEqual(document["counts"]["electedRoots"], 6)
        self.assertEqual(
            {item["class"] for item in document["roots"]},
            {roots_module.CLASS_RAIL_UNSPECIFIED},
        )
        for item in document["roots"]:
            self.assertLess(item["confidence"], 0.70)
            # N + F (six roots share the family name) = 0.40 exactly.
            self.assertEqual(item["confidence"], 0.40)
        separability = document["classification"]["separability"]["railBodyType"]
        self.assertEqual(separability["verdict"], "not-separable")
        self.assertEqual(separability["familiesObserved"], 1)
        self.assertEqual(document["claimVerdict"]["closedFreightWagons"], "unfounded")
        self.assertEqual(document["claimVerdict"]["hopperWagons"], "unfounded")
        # D3: `unfounded` is scoped to the two bodies that share one chassis.
        # A tank wagon has its own word, so its absence here is a real finding:
        # the claim of two is contradicted, not evidentially empty.
        self.assertEqual(document["claimVerdict"]["tankWagons"], "contradicted")

    def test_tank_on_rail_and_off_rail_split_by_adjacency_alone(self):
        scene = Scene()
        scene.node("Tank_01", pos=(200.0, 0.0, -109.0), renderer=True)
        scene.node("Tank_02", pos=(260.0, 0.0, -70.0), renderer=True)
        document, _facts, _fake = self.build(
            scene, terrain={"envelope": TERRAIN_ENVELOPE, "railway": CLAIM_RAILWAY}
        )
        by_distance = sorted(document["roots"], key=lambda item: item["railDistanceM"])
        self.assertAlmostEqual(by_distance[0]["railDistanceM"], 1.0, places=3)
        self.assertAlmostEqual(by_distance[1]["railDistanceM"], 40.0, places=3)
        self.assertEqual(by_distance[0]["class"], roots_module.CLASS_RAIL_TANK)
        self.assertEqual(by_distance[1]["class"], roots_module.CLASS_TANK_STATIC)
        self.assertEqual(
            document["classification"]["separability"]["tankWagonVsStaticTank"]["verdict"],
            "separable",
        )

    def test_container_without_a_length_token_is_not_size_separable(self):
        scene = Scene()
        scene.node("Konteyner_01", pos=(230.0, 0.0, -110.0), renderer=True)
        scene.node("Konteyner_02", pos=(240.0, 0.0, -110.0), renderer=True)
        document, _facts, _fake = self.build(scene, cross_check=False)
        self.assertEqual(
            {item["class"] for item in document["roots"]},
            {roots_module.CLASS_CONTAINER_UNSPECIFIED},
        )
        size = document["classification"]["separability"]["containerSize"]
        self.assertEqual(size["verdict"], "not-separable")
        self.assertEqual(size["reason"], "no length token in any name or material")
        self.assertEqual(document["claimVerdict"]["redContainers6m"], "unfounded")

    def test_color_evidence_only_survives_a_non_neutral_tint(self):
        red = Scene()
        red.material("Red_Mat", (0.62, 0.10, 0.09, 1.0))
        red.node("Container_6m_01", pos=(230.0, 0.0, -110.0), renderer=True,
                 materials=("Red_Mat",))
        document, _facts, _fake = self.build(red, cross_check=False)
        evidence = document["roots"][0]["colorEvidence"]
        self.assertEqual(evidence["property"], "_Color")
        self.assertEqual((evidence["r"], evidence["g"], evidence["b"]), (0.62, 0.1, 0.09))

        white = Scene()
        white.material("White_Mat", (1.0, 1.0, 1.0, 1.0))
        white.node("Container_6m_01", pos=(230.0, 0.0, -110.0), renderer=True,
                   materials=("White_Mat",))
        document, _facts, _fake = self.build(white, cross_check=False)
        self.assertEqual(document["roots"][0]["colorEvidence"], "none")

    def test_every_class_in_the_schema_is_assignable(self):
        """S3: a class with no token set can never be produced, so it may not exist.

        `unclassified` is the one exception: it is the residual the scorer falls
        back to, not a class anything is matched into.
        """
        for class_name in roots_module.CLASS_ORDER:
            if class_name == roots_module.CLASS_UNCLASSIFIED:
                continue
            self.assertTrue(
                roots_module.CLASS_TOKENS.get(class_name), class_name
            )
        self.assertEqual(set(roots_module.CLASS_TOKENS), set(roots_module.CLASS_ORDER))

    def test_a_competing_class_costs_exactly_0_25(self):
        """Channel A: two classes tie at 0.35 on N+P+M, so both are penalised."""
        scene = Scene()
        scene.node("Vagon_Cisterna_Kryt", pos=(230.0, 0.0, -110.0), renderer=True)
        document, _facts, _fake = self.build(scene, cross_check=False)
        root = document["roots"][0]
        self.assertEqual(root["class"], roots_module.CLASS_RAIL_COVERED)
        self.assertEqual(root["confidenceChannels"]["N"], 0.35)
        self.assertEqual(root["confidenceChannels"]["A"], -0.25)
        self.assertEqual(root["confidence"], 0.10)
        self.assertEqual(root["band"], "unresolved")
        self.assertEqual(
            root["competingClasses"],
            [{"class": roots_module.CLASS_RAIL_TANK, "score": 0.10}],
        )

    def test_a_rail_class_off_the_track_costs_exactly_0_20(self):
        """Channel R-: the same name on and off the rails, pinned both ways."""
        scene = Scene()
        scene.node("Vagon_Kryt_Near", pos=(200.0, 0.0, -109.0), renderer=True)
        scene.node("Vagon_Kryt_Far", pos=(200.0, 0.0, -70.0), renderer=True)
        document, _facts, _fake = self.build(
            scene, terrain={"envelope": TERRAIN_ENVELOPE, "railway": CLAIM_RAILWAY}
        )
        by_name = {item["normalizedName"]: item for item in document["roots"]}
        near = by_name["vagon_kryt_near"]
        far = by_name["vagon_kryt_far"]
        self.assertAlmostEqual(near["railDistanceM"], 1.0, places=3)
        self.assertAlmostEqual(far["railDistanceM"], 40.0, places=3)
        self.assertEqual(near["confidenceChannels"]["R"], 0.10)
        self.assertEqual(near["confidence"], 0.45)
        self.assertEqual(far["confidenceChannels"]["R"], -0.20)
        self.assertEqual(far["confidence"], 0.15)

    def test_an_inexact_world_transform_costs_exactly_0_20_and_is_ledgered(self):
        """Channel X + `positionExact: false` + `diagnostics.inexactRoots[]`."""
        scene = Scene()
        scene.node(
            "Vagon_Skewed", pos=(230.0, 0.0, -110.0), renderer=True,
            scale=(float("nan"), 1.0, 1.0),
        )
        document, _facts, _fake = self.build(scene, cross_check=False)
        root = document["roots"][0]
        self.assertFalse(root["positionExact"])
        self.assertEqual(root["confidenceChannels"]["X"], -0.20)
        self.assertEqual(root["confidenceChannels"]["N"], 0.35)
        self.assertEqual(root["confidence"], 0.15)
        self.assertEqual(len(document["diagnostics"]["inexactRoots"]), 1)
        inexact = document["diagnostics"]["inexactRoots"][0]
        self.assertEqual(inexact["objectId"], root["objectId"])
        self.assertEqual(inexact["reason"], "world-transform-inexact")
        # The position survives; only the claim of exactness is withdrawn.
        self.assertEqual(root["world"]["position"], {"x": 230.0, "y": 0.0, "z": -110.0})
        # A NaN never reaches the artifact — the payload guard would refuse it.
        self.assertNotIn("NaN", json.dumps(document))

    def test_an_exact_transform_takes_no_x_penalty(self):
        scene = Scene()
        scene.node("Vagon_Skewed", pos=(230.0, 0.0, -110.0), renderer=True)
        document, _facts, _fake = self.build(scene, cross_check=False)
        root = document["roots"][0]
        self.assertTrue(root["positionExact"])
        self.assertEqual(root["confidenceChannels"]["X"], 0)
        self.assertEqual(root["confidence"], 0.35)
        self.assertEqual(document["diagnostics"]["inexactRoots"], [])

    def test_band_and_family_counts_are_broken_out_per_scope(self):
        """T6: the four band/family counts are read, not merely emitted."""
        document, _facts, _fake = self.build(
            claim_scene(), terrain={"envelope": TERRAIN_ENVELOPE, "railway": CLAIM_RAILWAY}
        )
        counts = document["counts"]
        self.assertEqual(counts["rootsInScope"], 9)
        self.assertEqual(counts["establishedRootsInScope"], 2)
        self.assertEqual(counts["probableRootsInScope"], 6)
        self.assertEqual(counts["unresolvedRootsInScope"], 1)
        self.assertEqual(counts["otherIndustrialRootsInScope"], 0)
        self.assertEqual(
            counts["establishedRootsInScope"]
            + counts["probableRootsInScope"]
            + counts["unresolvedRootsInScope"],
            counts["rootsInScope"],
        )

        yard = Scene()
        yard.node("Tank_Storage_01", pos=(300.0, 0.0, -60.0), renderer=True)
        yard.node("Widget", pos=(FORTRESS[0], 0.0, FORTRESS[1]), renderer=True)
        tanks, _facts, _fake = self.build(
            yard, terrain={"envelope": TERRAIN_ENVELOPE, "railway": CLAIM_RAILWAY}
        )
        by_name = {item["normalizedName"]: item for item in tanks["roots"]}
        self.assertEqual(
            by_name["tank_storage"]["class"], roots_module.CLASS_TANK_STATIC
        )
        self.assertEqual(tanks["counts"]["otherIndustrialRootsInScope"], 1)

    def test_a_rejected_wrapper_name_cannot_decide_what_its_children_are(self):
        """B1: an ancestor may add weight to a reading; it may never select one.

        Six identical wagons under `Depot_Zone` and the same six under
        `Kryt_Zone` differ in nothing but a name we already rejected as not an
        object.  The published `_candidate_classes` let that name delete
        `rail-wagon-unspecified` from the candidate set, so the second run
        reported six `rail-wagon-covered`, flipped `railBodyType` to separable
        and rewrote `claimVerdict`.
        """
        neutral, _facts, _fake = self.build(
            six_wagons_under_a_wrapper("Depot_Zone"), cross_check=False
        )
        loaded, _facts, _fake = self.build(
            six_wagons_under_a_wrapper("Kryt_Zone"), cross_check=False
        )

        def reading(document):
            return [
                (item["normalizedName"], item["class"], item["confidence"])
                for item in document["roots"]
            ]

        self.assertEqual(reading(loaded), reading(neutral))
        self.assertEqual(
            {item["class"] for item in loaded["roots"] if item["normalizedName"] == "vagon"},
            {roots_module.CLASS_RAIL_UNSPECIFIED},
        )
        self.assertEqual(
            loaded["classification"]["separability"]["railBodyType"],
            neutral["classification"]["separability"]["railBodyType"],
        )
        self.assertEqual(loaded["claimVerdict"], neutral["claimVerdict"])

        # Variant: a tank word instead of a covered word, same outcome.
        tanked, _facts, _fake = self.build(
            six_wagons_under_a_wrapper("Cisterna_Zone"), cross_check=False
        )
        self.assertEqual(reading(tanked), reading(neutral))
        self.assertEqual(tanked["claimVerdict"], neutral["claimVerdict"])

        # Variant: §4.4 says a container's size needs a length token "in a name
        # or material name" — an ancestor's name is neither.
        def sized(wrapper_name):
            scene = Scene()
            wrapper = scene.node(wrapper_name, pos=(220.0, 0.0, -110.0))
            for index in range(2):
                scene.node(
                    f"Konteyner_{index + 1:02d}", parent=wrapper,
                    pos=(220.0 + 10.0 * index, 0.0, -110.0), renderer=True,
                )
            document, _facts, _fake = self.build(scene, cross_check=False)
            return document

        plain = sized("Depot_Zone")
        hinted = sized("Container_6m_Zone")
        for document in (plain, hinted):
            self.assertEqual(
                {item["class"] for item in document["roots"]},
                {roots_module.CLASS_CONTAINER_UNSPECIFIED},
            )
            self.assertEqual(
                document["classification"]["separability"]["containerSize"]["verdict"],
                "not-separable",
            )
            self.assertEqual(document["claimVerdict"]["redContainers6m"], "unfounded")

    def test_an_ancestor_name_cannot_set_the_rail_or_static_context(self):
        """B1: the same suppression, on the tank-wagon-vs-static-tank fork."""
        scene = Scene()
        wrapper = scene.node("Storage_Zone", pos=(200.0, 0.0, -109.0))
        for index in range(2):
            scene.node(
                f"Tank_{index + 1:02d}", parent=wrapper,
                pos=(200.0 + 10.0 * index, 0.0, -109.0), renderer=True,
            )
        document, _facts, _fake = self.build(
            scene, terrain={"envelope": TERRAIN_ENVELOPE, "railway": CLAIM_RAILWAY}
        )
        self.assertEqual(document["counts"]["electedRoots"], 2)
        # Both tanks stand 1 m from the rails.  `storage` lives only in a
        # wrapper we rejected, and a rejected wrapper may not move a tank off
        # the rails and into `industrial-tank-static`.
        for item in document["roots"]:
            self.assertAlmostEqual(item["railDistanceM"], 1.0, places=3)
            self.assertEqual(item["class"], roots_module.CLASS_RAIL_TANK, item["rootId"])
        self.assertEqual(document["counts"]["otherIndustrialRootsInScope"], 0)

    def test_a_sized_container_nobody_may_build_on_cannot_grant_a_size(self):
        """B2: `containerSize` is read over the same bands as its verdict."""
        scene = Scene()
        for index in range(2):
            scene.node(
                f"Konteyner_{index + 1:02d}",
                pos=(230.0 + 10.0 * index, 0.0, -110.0),
                renderer=True,
            )
        scene.node(
            "Container_6m_Debris_01", pos=(300.0, 0.0, -60.0), renderer=True,
            scale=(float("nan"), 1.0, 1.0),
        )
        document, _facts, _fake = self.build(scene, cross_check=False)
        debris = next(
            item for item in document["roots"]
            if item["normalizedName"] == "container_6m_debris"
        )
        self.assertEqual(debris["class"], roots_module.CLASS_CONTAINER_6M)
        self.assertEqual(debris["band"], "unresolved")
        self.assertEqual(
            document["classification"]["separability"]["containerSize"]["verdict"],
            "not-separable",
        )

    def test_one_unresolved_row_cannot_decide_what_is_separable(self):
        """B2: separability is read over the bands the verdicts are read over."""
        document, _facts, _fake = self.build(
            six_wagons_and_one_bystander(), cross_check=False
        )
        bystander = next(
            item for item in document["roots"]
            if item["normalizedName"] == "weird_kryt_debris"
        )
        self.assertEqual(bystander["class"], roots_module.CLASS_RAIL_COVERED)
        self.assertEqual(bystander["confidence"], 0.15)
        self.assertEqual(bystander["band"], "unresolved")
        separability = document["classification"]["separability"]["railBodyType"]
        self.assertEqual(separability["verdict"], "not-separable")
        self.assertEqual(separability["familiesObserved"], 1)
        self.assertEqual(document["claimVerdict"]["closedFreightWagons"], "unfounded")
        self.assertEqual(document["claimVerdict"]["hopperWagons"], "unfounded")
        self.assertEqual(document["claimVerdict"]["tankWagons"], "contradicted")

        # The gate is the BAND, not the name: lift the same bystander into
        # `probable` with a material of its own and the split becomes separable.
        confident, _facts, _fake = self.build(
            six_wagons_and_one_bystander(exact=True, material="Kryt_Steel"),
            cross_check=False,
        )
        lifted = next(
            item for item in confident["roots"]
            if item["normalizedName"] == "weird_kryt_debris"
        )
        self.assertEqual(lifted["band"], "probable")
        self.assertEqual(
            confident["classification"]["separability"]["railBodyType"]["verdict"],
            "separable",
        )

    def test_band_matched_counts_are_emitted_beside_the_all_band_counts(self):
        """B3: §5's D1 row must reach the same conclusion by hand as by machine."""
        document, _facts, _fake = self.build(
            six_wagons_and_one_bystander(), cross_check=False
        )
        counts = document["counts"]
        # The two counts genuinely differ here — the bystander is a rail root in
        # scope that no verdict may be built on.
        self.assertEqual(counts["railRootsInScope"], 7)
        self.assertEqual(counts["railRootsInScopeConfident"], 6)
        self.assertEqual(counts["confidentBands"], ["established", "probable"])
        # D1 applied by hand to the band-matched count agrees with the verdict.
        self.assertEqual(
            "supported"
            if counts["railRootsInScopeConfident"]
            == document["claimUnderTest"]["components"]["railStockTotal"]
            else "contradicted",
            document["claimVerdict"]["railStockTotal"],
        )
        self.assertEqual(
            counts["containerRootsInScopeConfident"],
            sum(
                1
                for item in document["roots"]
                if item["inScope"]
                and item["band"] in ("established", "probable")
                and item["class"] in roots_module.CONTAINER_CLASSES
            ),
        )
        self.assertEqual(document["claimVerdict"]["overall"], "partially-contradicted")

    def test_missing_rail_paths_omit_the_r_channel_instead_of_scoring_zero(self):
        scene = claim_scene()
        with_rails, _facts, _fake = self.build(
            scene, terrain={"envelope": TERRAIN_ENVELOPE, "railway": CLAIM_RAILWAY}
        )
        without, _facts, _fake = self.build(
            claim_scene(), terrain={"envelope": TERRAIN_ENVELOPE, "railway": None}
        )
        self.assertEqual(with_rails["classification"]["railAdjacency"], "available")
        self.assertEqual(without["classification"]["railAdjacency"], "unavailable")
        first = {item["rootId"]: item for item in with_rails["roots"]}
        second = {item["rootId"]: item for item in without["roots"]}
        self.assertEqual(set(first), set(second))
        for root_id, item in first.items():
            other = second[root_id]
            self.assertIsNone(other["confidenceChannels"]["R"], root_id)
            self.assertIsNone(other["railDistanceM"], root_id)
            delta = round(item["confidence"] - other["confidence"], 3)
            self.assertEqual(delta, item["confidenceChannels"]["R"], root_id)


# --------------------------------------------------------------------------
# §5 falsifiability
# --------------------------------------------------------------------------


class FalsifiabilityTests(RootsTestCase):
    def test_the_claim_is_pre_registered_verbatim(self):
        document, _facts, _fake = self.build(claim_scene())
        claim = document["claimUnderTest"]
        self.assertEqual(claim["source"], "docs/CONTINUATION-HANDOFF-2026-08-31.md")
        self.assertEqual(
            claim["statement"],
            "three closed freight wagons, two tank wagons, one hopper wagon, and "
            "two 6 m red containers",
        )
        self.assertEqual(
            claim["components"],
            {
                "closedFreightWagons": 3,
                "tankWagons": 2,
                "hopperWagons": 1,
                "redContainers6m": 2,
                "railStockTotal": 6,
                "containerTotal": 2,
            },
        )

    def test_matching_fixture_returns_supported(self):
        document, _facts, _fake = self.build(
            claim_scene(), terrain={"envelope": TERRAIN_ENVELOPE, "railway": CLAIM_RAILWAY}
        )
        self.assertTrue(document["complete"])
        self.assertTrue(document["frameVerified"])
        self.assertEqual(document["counts"]["railRootsInScope"], 6)
        self.assertEqual(document["counts"]["containerRootsInScope"], 2)
        for component in (
            "closedFreightWagons", "tankWagons", "hopperWagons",
            "redContainers6m", "railStockTotal", "containerTotal",
        ):
            self.assertEqual(document["claimVerdict"][component], "supported", component)
        self.assertEqual(document["claimVerdict"]["overall"], "supported")

    def test_nine_rail_roots_contradict_the_rail_stock_total(self):
        document, _facts, _fake = self.build(
            claim_scene(covered=5, tanks=3, hoppers=1),
            terrain={"envelope": TERRAIN_ENVELOPE, "railway": CLAIM_RAILWAY},
        )
        self.assertEqual(document["counts"]["railRootsInScope"], 9)
        self.assertEqual(document["claimVerdict"]["railStockTotal"], "contradicted")
        self.assertEqual(document["claimVerdict"]["overall"], "partially-contradicted")

    def test_nine_proxy_plan_can_win_against_the_new_claim(self):
        document, _facts, _fake = self.build(
            nine_proxy_scene(),
            terrain={"envelope": TERRAIN_ENVELOPE, "railway": NINE_PROXY_RAILWAY},
            anchors=nine_anchors(),
        )
        self.assertTrue(document["complete"])
        self.assertTrue(document["frameVerified"])
        # Nine real objects: every matched root is one a verdict may be built on.
        for item in document["roots"]:
            if item["normalizedName"] in ("vagon", "container"):
                self.assertIn(item["band"], ("established", "probable"), item["rootId"])
        self.assertEqual(document["claimVerdict"]["overall"], "nine-proxy-plan-supported")
        self.assertEqual(document["crossChecks"]["anchorsVerdict"], "anchors-supported")
        self.assertEqual(len(document["crossChecks"]["anchors"]), 9)
        for row in document["crossChecks"]["anchors"]:
            self.assertTrue(row["compatible"], row["featureId"])
            self.assertLess(row["distanceM"], 2.0)

    def test_nine_proxy_needs_nine_distinct_roots_not_nine_near_misses(self):
        """C1: the D5 match is one anchor to one root, or it counts fiction.

        Three of the nine anchors sit within 0.9 m of each other.  A many-to-one
        match let ONE root answer all three, so `nine-proxy-plan-supported` was
        reachable with four rail objects instead of six.
        """
        anchors = clustered_anchors()
        thin, _facts, _fake = self.build(
            roots_for_clustered_anchors(CLUSTERED_RAIL[:1] + SEPARATE_RAIL),
            anchors=anchors,
        )
        self.assertEqual(thin["counts"]["railRootsInScope"], 4)
        self.assertTrue(thin["complete"])
        self.assertTrue(thin["frameVerified"])
        self.assertNotEqual(thin["claimVerdict"]["overall"], "nine-proxy-plan-supported")
        # The anchor table itself stays many-to-one: it answers "what is nearest
        # to this anchor", which is a different and still-useful question.
        for row in thin["crossChecks"]["anchors"]:
            self.assertTrue(row["compatible"], row["featureId"])

        # Nine real objects, one per anchor, and the plan is supported again.
        full, _facts, _fake = self.build(
            roots_for_clustered_anchors(CLUSTERED_RAIL + SEPARATE_RAIL),
            anchors=anchors,
        )
        self.assertEqual(full["counts"]["railRootsInScope"], 6)
        self.assertEqual(full["claimVerdict"]["overall"], "nine-proxy-plan-supported")

        # Band gate: the same six roots with ONE of them unresolved is eight
        # objects, not nine, and eight does not carry the old plan.
        broken, _facts, _fake = self.build(
            roots_for_clustered_anchors(CLUSTERED_RAIL + SEPARATE_RAIL, broken=(0,)),
            anchors=anchors,
        )
        # Nothing else changed: the run is still complete and frame-verified, so
        # the band gate is the only thing that can withhold the verdict.
        self.assertTrue(broken["complete"])
        self.assertTrue(broken["frameVerified"])
        unresolved = [
            item for item in broken["roots"] if item["band"] == "unresolved"
            and item["class"] in roots_module.RAIL_CLASSES
        ]
        self.assertEqual(len(unresolved), 1)
        self.assertNotEqual(broken["claimVerdict"]["overall"], "nine-proxy-plan-supported")

    def test_one_mirrored_root_cannot_fail_a_correct_run(self):
        """C2: a density over a sample of one is not a measurement."""
        scene = claim_scene()
        # Nine in-scope roots at density 0.889, and one lexicon-hitting root
        # whose mirrored position lands in the mirrored box.
        scene.node("Vagon_Mirror", pos=(-230.0, 0.0, 110.0), renderer=True)
        document, _facts, _fake = self.build(
            scene, terrain={"envelope": TERRAIN_ENVELOPE, "railway": CLAIM_RAILWAY}
        )
        frame = document["frameCheck"]
        self.assertEqual(frame["sourceFrameRootCount"], 9)
        self.assertEqual(frame["mirroredFrameRootCount"], 1)
        self.assertEqual(frame["mirroredFrameIndustrialDensity"], 1.0)
        self.assertLess(
            frame["sourceFrameIndustrialDensity"],
            frame["mirroredFrameIndustrialDensity"],
        )
        self.assertEqual(frame["verdict"], "confirmed")
        self.assertTrue(document["frameVerified"])

        # Above the minimum sample the comparison must still be weighted by
        # count: three mirrored roots at 1.000 do not outweigh eight at 0.889.
        scene = claim_scene()
        for index in range(3):
            scene.node(
                f"Vagon_Mirror_{index + 1:02d}",
                pos=(-230.0 - 5.0 * index, 0.0, 110.0),
                renderer=True,
            )
        document, _facts, _fake = self.build(
            scene, terrain={"envelope": TERRAIN_ENVELOPE, "railway": CLAIM_RAILWAY}
        )
        frame = document["frameCheck"]
        self.assertEqual(frame["sourceFrameRootCount"], 9)
        self.assertEqual(frame["mirroredFrameRootCount"], 3)
        self.assertLess(
            frame["sourceFrameIndustrialDensity"],
            frame["mirroredFrameIndustrialDensity"],
        )
        self.assertEqual(frame["verdict"], "confirmed")
        self.assertTrue(document["frameVerified"])

    def test_the_density_half_alone_can_still_contradict_a_frame(self):
        """The mirror falsifier's density branch, with the witness half silent."""
        scene = Scene()
        scene.node("Widget", pos=(FORTRESS[0], 0.0, FORTRESS[1]), renderer=True)
        for index in range(4):
            scene.node(
                f"Widget_{index + 1:02d}",
                pos=(220.0 + 5.0 * index, 0.0, -100.0),
                renderer=True,
            )
        for index in range(4):
            scene.node(
                f"Vagon_Mirrored_{index + 1:02d}",
                pos=(-220.0 - 5.0 * index, 0.0, 100.0),
                renderer=True,
            )
        document, _facts, _fake = self.build(scene, cross_check=False)
        frame = document["frameCheck"]
        # The witness half is silent: the source frame holds the nearer witness.
        self.assertEqual(frame["fortressWitness"], "confirmed")
        self.assertLess(
            frame["sourceFrameWitnessDistanceM"],
            frame["mirroredFrameWitnessDistanceM"],
        )
        self.assertEqual(frame["sourceFrameRootCount"], 5)
        self.assertEqual(frame["mirroredFrameRootCount"], 4)
        self.assertEqual(frame["sourceFrameIndustrialDensity"], 0.0)
        self.assertEqual(frame["mirroredFrameIndustrialDensity"], 1.0)
        self.assertEqual(frame["verdict"], "contradicted")
        self.assertFalse(document["frameVerified"])

    def test_colourless_containers_make_the_whole_claim_unfounded(self):
        """D3's third disproof condition, and the `unfounded` overall it produces."""
        document, _facts, _fake = self.build(
            claim_scene(container_color=None),
            terrain={"envelope": TERRAIN_ENVELOPE, "railway": CLAIM_RAILWAY},
        )
        containers = [
            item for item in document["roots"]
            if item["class"] in roots_module.CONTAINER_CLASSES
        ]
        self.assertEqual(len(containers), 2)
        # Size IS separable here and the count IS two, so only the colour
        # condition can be doing the work.
        self.assertEqual(
            document["classification"]["separability"]["containerSize"]["verdict"],
            "separable",
        )
        self.assertEqual(document["counts"]["containerRootsInScopeConfident"], 2)
        for item in containers:
            self.assertEqual(item["colorEvidence"], "none")
        self.assertEqual(document["claimVerdict"]["redContainers6m"], "unfounded")
        # Every other component is supported, so nothing is contradicted and the
        # overall verdict is `unfounded` — "we cannot found this", not "it is
        # wrong".  A red container is not establishable from no tint at all.
        self.assertNotIn("contradicted", document["claimVerdict"].values())
        self.assertEqual(document["claimVerdict"]["overall"], "unfounded")

    def test_anchors_all_far_away_are_reported_as_contradicted(self):
        scene = Scene()
        scene.node("Vagon_Alone", pos=(60.0, 0.0, -250.0), renderer=True)
        scene.node("Widget", pos=(FORTRESS[0], 0.0, FORTRESS[1]), renderer=True)
        document, _facts, _fake = self.build(scene, anchors=nine_anchors())
        self.assertEqual(document["crossChecks"]["anchorsVerdict"], "anchors-contradicted")

    def test_incomplete_runs_may_never_render_a_verdict(self):
        document, _facts, _fake = self.build(
            claim_scene(),
            terrain={"envelope": TERRAIN_ENVELOPE, "railway": CLAIM_RAILWAY},
            allow_partial=True,
        )
        self.assertFalse(document["complete"])
        self.assertEqual(document["claimVerdict"]["railStockTotal"], "supported")
        self.assertEqual(document["claimVerdict"]["overall"], "inconclusive")

    def test_lower_bound_counts_also_force_inconclusive(self):
        scene = claim_scene()
        scene.node("Orphan_Wagon", pos=(230.0, 0.0, -110.0), renderer=True,
                   parent_transform=777_777)
        document, _facts, _fake = self.build(
            scene, terrain={"envelope": TERRAIN_ENVELOPE, "railway": CLAIM_RAILWAY},
            allow_partial=False,
        )
        self.assertTrue(document["counts"]["rootCountIsLowerBound"])
        self.assertEqual(document["claimVerdict"]["overall"], "inconclusive")


# --------------------------------------------------------------------------
# §1 safety
# --------------------------------------------------------------------------


class SafetyTests(RootsTestCase):
    def test_payload_bearing_types_are_never_selected_or_parsed(self):
        forbidden = FORBIDDEN_TYPE_READERS()
        scene = claim_scene()
        environments = scene.environments(extra_shared=forbidden)
        document, facts, _fake = self.build(scene, environments=environments)
        self.assertEqual([reader.parse_calls for reader in forbidden], [0] * 6)
        self.assertEqual(document["counts"]["skippedNonRootsObjects"], 6)
        self.assertEqual(document["counts"]["skippedObjects"], 0)
        self.assertEqual(document["diagnostics"]["skippedObjects"], [])
        # Unlike the census, a healthy run is complete without --allow-partial.
        self.assertTrue(document["complete"])

    def test_payload_fields_are_scrubbed_and_never_reach_the_json(self):
        leaked = r"C:\Program Files (x86)\Battlestate Games\EFT\secret"
        scene = Scene()
        scene.node(
            "Vagon_Yard",
            pos=(230.0, 0.0, -110.0),
            renderer=True,
            extra={
                "m_VertexData": {"m_DataSize": [1, 2, 3]},
                "m_StreamData": {"path": "archive:/CAB-secret/CAB-secret.resS"},
                "m_TagString": leaked,
            },
        )
        scene.node("Widget", pos=(FORTRESS[0], 0.0, FORTRESS[1]), renderer=True)
        document, _facts, _fake = self.build(scene)
        payload = json.dumps(document, sort_keys=True)
        self.assertGreater(document["diagnostics"]["droppedForbiddenFieldCount"], 0)
        for needle in ("m_VertexData", "m_StreamData", ".resS", "CAB-secret",
                       "Program Files", "Battlestate", leaked):
            self.assertNotIn(needle, payload, needle)

    def test_unapproved_output_field_fails_closed(self):
        with self.assertRaises(RootsError) as raised:
            roots_module.assert_bounded_payload({"roots": [{"m_Vertices": [1, 2, 3]}]})
        self.assertIn("m_Vertices", str(raised.exception))

    def test_bulk_scalar_array_and_binary_and_nan_fail_closed(self):
        with self.assertRaises(RootsError):
            roots_module.assert_bounded_payload({"counts": {"electedRoots": list(range(65))}})
        with self.assertRaises(RootsError) as raised:
            roots_module.assert_bounded_payload({"roots": b"\x00\x01"})
        # The refusal must name the reason: the unsupported-type catch-all would
        # also stop bytes, so a message that says only "unsupported value type"
        # means the binary branch is gone and nobody would notice.
        self.assertIn("binary payload", str(raised.exception))
        with self.assertRaises(RootsError):
            roots_module.assert_bounded_payload({"counts": {"electedRoots": float("nan")}})
        with self.assertRaises(RootsError):
            roots_module.assert_bounded_payload({"roots": {"name": "x" * 1025}})

    def test_the_payload_guard_gates_the_real_build_and_publish_path(self):
        """D1t: the walker must run on a REAL document, not only on unit inputs.

        Every synthetic fixture is allowlist-compliant by construction, so
        replacing `_finalize_artifact`'s body with `return payload` left the
        suite green: the guard was proven on hand-built dicts and never on the
        path that publishes.  Both refusals below are injected UPSTREAM of the
        walker and driven through `main()` — argument parsing, selection, build,
        publish — so nothing but the guard can stop them.
        """
        def run_with(patch_name, value):
            with tempfile.TemporaryDirectory() as temp_value:
                base = Path(temp_value)
                source = self.make_source(base)
                output = base / "roots.json"
                report = base / "report.json"
                original = getattr(roots_module, patch_name)
                setattr(roots_module, patch_name, value)
                try:
                    code, _stdout, stderr = self.run_main(
                        [
                            "--source", str(source),
                            "--output", str(output),
                            "--report", str(report),
                            "--acknowledge-local-game-files",
                            "--terrain", str(base / "absent.json"),
                            "--prop-features", str(base / "absent.json"),
                        ],
                        FakeUnityPy(claim_scene().environments()),
                    )
                finally:
                    setattr(roots_module, patch_name, original)
                return code, stderr, output.exists(), report.exists()

        # A string the guard's 1024-character bound refuses, produced by a real
        # root's own id function rather than hand-placed in the payload.
        code, stderr, wrote_output, wrote_report = run_with(
            "_root_id", lambda object_id: "customs.root." + ("a" * 1100)
        )
        self.assertEqual(code, 2)
        self.assertIn("1024 characters", stderr)
        self.assertFalse(wrote_output)
        self.assertFalse(wrote_report)

        # A field the allowlist does not cover, reaching the payload the way a
        # future edit would: an upstream constant grows a key nobody reviewed.
        # (Patching `ROOTS_ALLOWED_OUTPUT_KEYS` would prove nothing —
        # `assert_bounded_payload` captures it as a signature default, so the
        # walker keeps the frozenset it was defined with.)
        code, stderr, wrote_output, wrote_report = run_with(
            "CLAIM_COMPONENTS",
            {**roots_module.CLAIM_COMPONENTS, "m_Vertices": 3},
        )
        self.assertEqual(code, 2)
        self.assertIn("unapproved output field 'm_Vertices'", stderr)
        self.assertFalse(wrote_output)
        self.assertFalse(wrote_report)

        # The same run, unpatched, publishes both artifacts — so the refusals
        # above are the guard's doing and not a broken fixture.
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            output = base / "roots.json"
            report = base / "report.json"
            code, _stdout, stderr = self.run_main(
                [
                    "--source", str(source),
                    "--output", str(output),
                    "--report", str(report),
                    "--acknowledge-local-game-files",
                    "--terrain", str(base / "absent.json"),
                    "--prop-features", str(base / "absent.json"),
                ],
                FakeUnityPy(claim_scene().environments()),
            )
            self.assertEqual(code, 0, stderr)
            self.assertTrue(output.exists())
            self.assertTrue(report.exists())

    def test_the_two_payload_walkers_agree_on_an_adversarial_corpus(self):
        corpus = [
            {"complete": True},
            {"unknownField": 1},
            {"counts": b"\x00\x01"},
            {"counts": {"gameObjects": list(range(65))}},
            {"counts": {"gameObjects": list(range(64))}},
            {"counts": {"gameObjects": float("nan")}},
            {"counts": {"gameObjects": float("inf")}},
            {"counts": {"gameObjects": "x" * 1025}},
            {"counts": {"gameObjects": "x" * 1024}},
            {"counts": [1, 2, 3]},
            {1: "non-string-key"},
            {"counts": {"gameObjects": {"nested": set()}}},
            {"source": {"sceneFiles": [{"file": "a", "role": "level"}]}},
            {"diagnostics": {"skippedObjects": [{"asset": "a", "pathId": 1}]}},
            [1, 2, 3],
            "top-level-string",
            None,
        ]
        for index, item in enumerate(corpus):
            local_error = None
            census_error = None
            try:
                roots_module.assert_bounded_payload(
                    item, allowed=census.ALLOWED_OUTPUT_KEYS
                )
            except Exception as error:  # noqa: BLE001 - parity is the assertion
                local_error = type(error).__name__
            try:
                census.assert_bounded_payload(item)
            except Exception as error:  # noqa: BLE001
                census_error = type(error).__name__
            self.assertEqual(local_error, census_error, f"corpus[{index}] = {item!r}")

    def test_oversized_and_unsized_objects_are_skipped_before_parse(self):
        scene = claim_scene()
        environments = scene.environments()
        oversized = next(
            reader
            for reader in environments[SHARED_NAME]
            if reader.type.name == "MeshRenderer"
        )
        oversized.byte_size = roots_module.MAX_PARSED_OBJECT_BYTES + 1
        unsized = next(
            reader
            for reader in environments[SHARED_NAME]
            if reader.type.name == "Material"
        )
        del unsized.byte_size
        document, _facts, _fake = self.build(scene, environments=environments)
        self.assertEqual(oversized.parse_calls, 0)
        self.assertEqual(unsized.parse_calls, 0)
        reasons = {
            row["reason"] for row in document["diagnostics"]["skippedObjects"]
        }
        self.assertEqual(
            reasons, {"serialized-object-too-large", "serialized-object-size-unavailable"}
        )
        self.assertFalse(document["complete"])

    def test_dependency_loading_is_disabled_before_objects_are_touched(self):
        with tempfile.TemporaryDirectory() as temp_value:
            source = self.make_source(Path(temp_value))
            _catalog, _files, _facts, fake = self.collect(
                claim_scene().environments(), source
            )
            self.assertEqual(
                fake.load_calls, ["globalgamemanagers", LEVEL_NAME, SHARED_NAME]
            )
            self.assertEqual(
                fake.stream_facts,
                [
                    {"name": "globalgamemanagers", "path": ""},
                    {"name": LEVEL_NAME, "path": ""},
                    {"name": SHARED_NAME, "path": ""},
                ],
            )
            for stream in fake.load_inputs:
                self.assertNotIn(temp_value, repr(stream))
            for environment in fake.returned_environments:
                for method in census.DEPENDENCY_LOADING_METHODS:
                    with self.assertRaises(RootsError):
                        getattr(environment, method)("forbidden")

    def test_only_the_two_stage_selection_is_ever_opened(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            unrelated = (
                "a.bundle", "level2", "sharedassets2.assets", "resources.assets",
                "terrain.resS", "resources.resource", "Assembly-CSharp.dll",
                "EscapeFromTarkov.exe", "globalgamemanagers.assets",
            )
            source = self.make_source(base, extra_names=unrelated)
            fake = FakeUnityPy(
                claim_scene().environments(),
                {name: AssertionError(f"must not load {name}") for name in unrelated},
            )
            output = base / "roots.json"
            code, _stdout, stderr = self.run_main(
                [
                    "--source", str(source),
                    "--output", str(output),
                    "--acknowledge-local-game-files",
                    "--terrain", str(base / "absent-terrain.json"),
                    "--prop-features", str(base / "absent-features.json"),
                ],
                fake,
            )
            self.assertEqual(code, 0, stderr)
            self.assertEqual(
                fake.load_calls, ["globalgamemanagers", LEVEL_NAME, SHARED_NAME]
            )

    def test_two_catalogs_are_a_hard_error_that_names_neither_path(self):
        """§1.1: exactly one catalog, or the operator must narrow --source."""
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = base / "two-data-roots"
            # No catalog at the root, so discovery falls through to the bounded
            # recursive walk and finds both.
            for branch in ("alpha", "beta"):
                (source / branch).mkdir(parents=True)
                for name in ("globalgamemanagers", LEVEL_NAME, SHARED_NAME):
                    (source / branch / name).write_bytes(b"UnityFS\x00synthetic-only")
            self.assertEqual(len(roots_module.discover_catalog_files(source)), 2)

            output = base / "roots.json"
            fake = FakeUnityPy(claim_scene().environments())
            code, stdout, stderr = self.run_main(
                [
                    "--source", str(source),
                    "--output", str(output),
                    "--acknowledge-local-game-files",
                    "--dry-run",
                ],
                fake,
            )
            self.assertEqual(code, 2)
            self.assertIn("expected exactly one", stderr)
            self.assertEqual(stdout, "")
            self.assertFalse(output.exists())
            self.assertEqual(fake.load_calls, [])

    def test_acknowledgement_gate_runs_before_source_access(self):
        with tempfile.TemporaryDirectory() as temp_value:
            output = Path(temp_value) / "never-created.json"
            code, _stdout, stderr = self.run_main(
                ["--source", "/definitely/not/a/game", "--output", str(output)]
            )
        self.assertEqual(code, 2)
        self.assertIn("--acknowledge-local-game-files", stderr)
        self.assertFalse(output.exists())

    def test_dry_run_never_imports_unitypy_and_writes_nothing(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            output = base / "roots.json"
            report = base / "report.json"

            class PoisonedFinder:
                """Any real `import UnityPy` raises instead of resolving."""

                def find_spec(self, fullname, path=None, target=None):
                    if fullname == "UnityPy" or fullname.startswith("UnityPy."):
                        raise AssertionError("--dry-run must not import UnityPy")
                    return None

            def refuse():
                raise AssertionError("--dry-run must not import UnityPy")

            original_module = sys.modules.pop("UnityPy", None)
            original_import = roots_module.selector._import_unitypy
            imported = []
            roots_module.selector._import_unitypy = refuse
            finder = PoisonedFinder()
            sys.meta_path.insert(0, finder)
            try:
                code, stdout, stderr = self.run_main(
                    [
                        "--source", str(source),
                        "--output", str(output),
                        "--report", str(report),
                        "--acknowledge-local-game-files",
                        "--dry-run",
                    ]
                )
            finally:
                sys.meta_path.remove(finder)
                roots_module.selector._import_unitypy = original_import
                if original_module is not None:
                    sys.modules["UnityPy"] = original_module
            plan = json.loads(stdout)
            self.assertEqual(code, 0, stderr)
            self.assertEqual(imported, [])
            self.assertTrue(plan["dryRun"])
            self.assertFalse(plan["wouldWrite"])
            self.assertEqual(plan["catalogFiles"], ["globalgamemanagers"])
            self.assertNotIn("Mesh", plan["rootsObjectTypes"])
            self.assertEqual(plan["neverSelectedTypes"], ["Mesh", "Texture2D"])
            self.assertEqual(plan["frameId"], "eft-unity-world-metres-y-up")
            self.assertFalse(output.exists())
            self.assertFalse(report.exists())

    def test_path_guards_refuse_before_anything_is_written(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            fake = FakeUnityPy(claim_scene().environments())
            common = ["--source", str(source), "--acknowledge-local-game-files"]

            inside_repo = roots_module.REPO_ROOT / "never-created-roots.json"
            # `--dry-run` so that a mutation which deletes this guard still
            # cannot leave an artifact behind inside the repository.
            code, _stdout, stderr = self.run_main(
                common + ["--output", str(inside_repo), "--dry-run"], fake
            )
            self.assertEqual(code, 2)
            self.assertIn("outside this repository", stderr)
            self.assertFalse(inside_repo.exists())

            code, _stdout, stderr = self.run_main(
                common + ["--output", str(source / "roots.json")], fake
            )
            self.assertEqual(code, 2)
            self.assertIn("outside the supplied game-data source", stderr)

            code, _stdout, stderr = self.run_main(
                common + ["--output", str(base / "absent" / "roots.json")], fake
            )
            self.assertEqual(code, 2)
            self.assertIn("parent directory", stderr)

            output = base / "roots.json"
            code, _stdout, stderr = self.run_main(
                common + ["--output", str(output), "--report", str(output)], fake
            )
            self.assertEqual(code, 2)
            self.assertIn("must differ", stderr)

            target = base / "link-target.json"
            target.write_text("{}", encoding="utf-8")
            link = base / "roots-link.json"
            try:
                link.symlink_to(target)
            except (OSError, NotImplementedError):  # pragma: no cover - platform
                self.skipTest("symlinks are unavailable on this filesystem")
            code, _stdout, stderr = self.run_main(common + ["--output", str(link)], fake)
            self.assertEqual(code, 2)
            self.assertIn("symbolic link", stderr)
            self.assertEqual(target.read_text(encoding="utf-8"), "{}")
            self.assertEqual(fake.load_calls, [])

    def test_scope_overrides_are_parsed_and_pinned_into_the_artifact(self):
        self.assertEqual(roots_module._parse_center("230,-110"), (230.0, -110.0))
        self.assertEqual(roots_module._parse_size("360x300"), (360.0, 300.0))
        for value in ("230", "230,-110,4", "a,b"):
            with self.assertRaises(RootsError, msg=value):
                roots_module._parse_center(value)
        for value in ("360", "360x0", "wide x tall"):
            with self.assertRaises(RootsError, msg=value):
                roots_module._parse_size(value)

        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            output = base / "roots.json"
            code, _stdout, stderr = self.run_main(
                [
                    "--source", str(source),
                    "--output", str(output),
                    "--acknowledge-local-game-files",
                    "--allow-partial",
                    "--no-cross-check",
                    "--scope-center", "100,-50",
                    "--scope-size", "40x20",
                    "--max-placement-span-m", "12.5",
                    "--coincident-root-m", "0.25",
                    "--terrain-margin-m", "7",
                ],
                FakeUnityPy(claim_scene().environments()),
            )
            self.assertEqual(code, 0, stderr)
            document = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(
                document["parameters"],
                {
                    "scopeId": "customs-industrial-rail-yard",
                    "scopeCenter": {"x": 100.0, "z": -50.0},
                    "scopeWidthM": 40.0,
                    "scopeDepthM": 20.0,
                    "frameId": "eft-unity-world-metres-y-up",
                    "maxPlacementSpanM": 12.5,
                    "coincidentRootM": 0.25,
                    "frameWitnessToleranceM": 12.0,
                    "terrainMarginM": 7.0,
                    "railOnTrackM": 4.0,
                    "railOffTrackM": 12.0,
                    "mirrorMinSampleRoots": 3,
                },
            )
            self.assertEqual(document["counts"]["rootsInScope"], 0)

    def test_negative_numeric_options_are_refused(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            code, _stdout, stderr = self.run_main(
                [
                    "--source", str(source),
                    "--output", str(base / "roots.json"),
                    "--acknowledge-local-game-files",
                    "--max-placement-span-m", "-1",
                    "--dry-run",
                ]
            )
        self.assertEqual(code, 2)
        self.assertIn("finite and non-negative", stderr)

    def test_existing_destination_is_never_replaced_and_there_is_no_force(self):
        self.assertNotIn("--force", roots_module._parser().format_help())
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            output = base / "roots.json"
            report = base / "report.json"
            report.write_text("keep-me", encoding="utf-8")
            arguments = [
                "--source", str(source),
                "--output", str(output),
                "--report", str(report),
                "--acknowledge-local-game-files",
                "--terrain", str(base / "absent.json"),
                "--prop-features", str(base / "absent.json"),
            ]
            code, _stdout, stderr = self.run_main(
                arguments, FakeUnityPy(claim_scene().environments())
            )
            self.assertEqual(code, 2)
            self.assertIn("choose a new output path", stderr)
            self.assertEqual(report.read_text(encoding="utf-8"), "keep-me")
            self.assertFalse(output.exists())

            arguments[3] = str(base / "fresh-roots.json")
            arguments[5] = str(base / "fresh-report.json")
            code, stdout, stderr = self.run_main(
                arguments, FakeUnityPy(claim_scene().environments())
            )
            self.assertEqual(code, 0, stderr)
            document = json.loads((base / "fresh-roots.json").read_text(encoding="utf-8"))
            self.assertEqual(document["schemaVersion"], roots_module.ROOTS_SCHEMA_VERSION)
            roster = json.loads((base / "fresh-report.json").read_text(encoding="utf-8"))
            self.assertEqual(roster["rankedBy"], "inScopeCount")
            # The roster adds no fact the roots document does not already carry.
            self.assertEqual(roster["claimVerdict"], document["claimVerdict"])
            self.assertEqual(roster["families"], sorted(
                document["families"],
                key=lambda item: (-item["inScopeCount"], -item["instanceCount"],
                                  item["normalizedName"]),
            ))

    def test_a_destination_created_after_validation_is_still_never_replaced(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            output = base / "roots.json"
            original = roots_module.build_roots_document

            def racing_build(*args, **kwargs):
                document = original(*args, **kwargs)
                # The destination appears between path validation and os.link.
                output.write_text("race-winner", encoding="utf-8")
                return document

            roots_module.build_roots_document = racing_build
            try:
                code, _stdout, stderr = self.run_main(
                    [
                        "--source", str(source),
                        "--output", str(output),
                        "--acknowledge-local-game-files",
                        "--terrain", str(base / "absent.json"),
                        "--prop-features", str(base / "absent.json"),
                    ],
                    FakeUnityPy(claim_scene().environments()),
                )
            finally:
                roots_module.build_roots_document = original
            self.assertEqual(code, 2)
            self.assertIn("no existing file was replaced", stderr)
            self.assertEqual(output.read_text(encoding="utf-8"), "race-winner")
            self.assertEqual(list(base.glob(".*.tmp")), [])

    def test_publication_loses_a_race_without_clobbering_or_a_partial_pair(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            output = base / "roots.json"
            report = base / "report.json"
            original_link = census.os.link
            calls = []

            def racing_link(source, destination):
                calls.append(Path(destination))
                if len(calls) == 2:
                    Path(destination).write_text("race-winner", encoding="utf-8")
                return original_link(source, destination)

            census.os.link = racing_link
            try:
                with self.assertRaises(RootsError):
                    census._publish_json_noclobber(
                        [(output, {"complete": False}), (report, {"complete": False})]
                    )
            finally:
                census.os.link = original_link
            self.assertEqual(output.read_text(encoding="utf-8"), "race-winner")
            self.assertFalse(report.exists())
            self.assertEqual(list(base.glob(".*.tmp")), [])

    def test_output_is_deterministic_and_object_order_does_not_matter(self):
        terrain = {"envelope": TERRAIN_ENVELOPE, "railway": CLAIM_RAILWAY}
        with tempfile.TemporaryDirectory() as temp_value:
            # One source directory, so the stat-identity facts are shared and the
            # comparison isolates the extractor's own ordering.
            source = self.make_source(Path(temp_value))
            first, _facts, _fake = self.build(
                claim_scene(), terrain=terrain, source=source
            )
            second, _facts, _fake = self.build(
                claim_scene(), terrain=terrain, source=source
            )
            self.assertEqual(
                json.dumps(first, sort_keys=True), json.dumps(second, sort_keys=True)
            )

            shuffled_environments = claim_scene().environments()
            rng = random.Random(20260901)
            rng.shuffle(shuffled_environments[SHARED_NAME])
            shuffled, _facts, _fake = self.build(
                claim_scene(),
                environments=shuffled_environments,
                terrain=terrain,
                source=source,
            )
            self.assertEqual(
                json.dumps(first, sort_keys=True), json.dumps(shuffled, sort_keys=True)
            )

    def manifest_document(self):
        return {
            "frames": {
                "source": "eft-unity-world-metres-y-up",
                "runtime": "three-z-up-metres",
                "runtimeFromSource": "[-x, -z, y]",
            },
            "scope": {
                "id": "customs-industrial-rail-yard",
                "center": {"x": 230, "z": -110},
                "widthM": 360,
                "depthM": 300,
            },
            "evidence": {
                "observations": [
                    {
                        "featureId": "customs.building.fortress.main",
                        "positionM": {"x": FORTRESS[0], "y": 1.7, "z": FORTRESS[1]},
                    }
                ]
            },
        }

    def test_scene_manifest_frame_evidence_is_verified_not_assumed(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            path = base / "scene-manifest.json"
            path.write_text(json.dumps(self.manifest_document()), encoding="utf-8")
            scope = roots_module.load_scene_manifest(path)
            self.assertEqual(scope["center"], (230.0, -110.0))
            self.assertEqual(scope["widthM"], 360.0)
            self.assertEqual(scope["fortress"], FORTRESS)

            def broken(name, mutate):
                document = self.manifest_document()
                mutate(document)
                target = base / f"broken-{name}.json"
                target.write_text(json.dumps(document), encoding="utf-8")
                return target

            cases = (
                (
                    "runtime-from-source",
                    lambda item: item["frames"].update({"runtimeFromSource": "[x, z, y]"}),
                    "runtimeFromSource",
                ),
                (
                    "source-frame",
                    lambda item: item["frames"].update({"source": "three-z-up-metres"}),
                    "source frame",
                ),
                (
                    "no-witness",
                    lambda item: item["evidence"].update({"observations": []}),
                    "Fortress pivot",
                ),
                ("no-scope", lambda item: item.pop("scope"), "scope block"),
                (
                    "zero-scope",
                    lambda item: item["scope"].update({"widthM": 0}),
                    "usable box",
                ),
            )
            for name, mutate, needle in cases:
                with self.assertRaises(RootsError, msg=name) as raised:
                    roots_module.load_scene_manifest(broken(name, mutate))
                self.assertIn(needle, str(raised.exception), name)

            with self.assertRaises(RootsError):
                roots_module.load_scene_manifest(base / "absent-manifest.json")

    def test_the_repository_scene_manifest_still_satisfies_the_frame_contract(self):
        scope = roots_module.load_scene_manifest(
            roots_module.REPO_ROOT / "public/assets/3d/customs/scene-manifest.json"
        )
        self.assertEqual(scope["scopeId"], "customs-industrial-rail-yard")
        self.assertEqual(scope["center"], (230.0, -110.0))
        self.assertEqual((scope["widthM"], scope["depthM"]), (360.0, 300.0))
        self.assertEqual(scope["fortress"], FORTRESS)
        # The documented box, computed rather than restated.
        self.assertTrue(roots_module._in_scope(50.0, -260.0, scope))
        self.assertTrue(roots_module._in_scope(410.0, 40.0, scope))
        self.assertFalse(roots_module._in_scope(49.99, -110.0, scope))
        self.assertFalse(roots_module._in_scope(230.0, 40.01, scope))

    def test_error_messages_carry_no_path_and_no_exception_text(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            output = base / "roots.json"
            leaked = r"C:\Program Files (x86)\Battlestate Games\EFT\secret"
            fake = FakeUnityPy(
                claim_scene().environments(), errors={LEVEL_NAME: ValueError(leaked)}
            )
            code, _stdout, stderr = self.run_main(
                [
                    "--source", str(source),
                    "--output", str(output),
                    "--acknowledge-local-game-files",
                    "--allow-partial",
                ],
                fake,
            )
            self.assertEqual(code, 0, stderr)
            payload = output.read_text(encoding="utf-8")
            self.assertNotIn("Program Files", payload)
            self.assertNotIn("Battlestate", payload)
            self.assertNotIn(str(source), payload)
            self.assertNotIn(temp_value, payload)
            self.assertEqual(
                json.loads(payload)["diagnostics"]["fileLoadFailures"][0]["errorType"],
                "ValueError",
            )

    def test_a_filesystem_failure_leaks_neither_its_path_nor_its_message(self):
        """§9: a refusal prints a bounded message — no path, no exception text.

        The `except OSError` arm in `main()` is the one error path a real run
        reaches with an operating-system message attached, and an OSError's
        `str()` carries the filename it failed on.
        """
        leaked = r"C:\Program Files (x86)\Battlestate Games\EFT\roots.json"
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            output = base / "roots.json"
            original = census._publish_json_noclobber

            def refuse(_artifacts):
                raise PermissionError(13, "Permission denied", leaked)

            census._publish_json_noclobber = refuse
            try:
                code, _stdout, stderr = self.run_main(
                    [
                        "--source", str(source),
                        "--output", str(output),
                        "--acknowledge-local-game-files",
                        "--terrain", str(base / "absent.json"),
                        "--prop-features", str(base / "absent.json"),
                    ],
                    FakeUnityPy(claim_scene().environments()),
                )
            finally:
                census._publish_json_noclobber = original
            self.assertEqual(code, 2)
            self.assertIn("PermissionError", stderr)
            for needle in (leaked, "Program Files", "Battlestate", "Permission denied",
                           str(source), temp_value):
                self.assertNotIn(needle, stderr, needle)
            self.assertFalse(output.exists())


# --------------------------------------------------------------------------
# mutation proofs — each guard, broken on purpose
# --------------------------------------------------------------------------


class GuardMutationTests(RootsTestCase):
    """For every guard: show the mutation that breaks it and the test that bites."""

    def test_mutation_selecting_mesh_raises_at_the_never_parse_assertion(self):
        scene = claim_scene()
        forbidden = FORBIDDEN_TYPE_READERS()
        environments = scene.environments(extra_shared=forbidden)
        original = roots_module.ROOTS_OBJECT_TYPES
        roots_module.ROOTS_OBJECT_TYPES = original | {"Mesh"}
        try:
            with tempfile.TemporaryDirectory() as temp_value:
                source = self.make_source(Path(temp_value))
                with self.assertRaises(RootsError) as raised:
                    self.collect(environments, source)
            self.assertIn("payload-bearing", str(raised.exception))
        finally:
            roots_module.ROOTS_OBJECT_TYPES = original
        # The Mesh reader still never had its typetree materialized.
        self.assertEqual(forbidden[0].parse_calls, 0)

    def test_mutation_removing_the_never_parse_assertion_falls_back_to_the_census_gate(self):
        scene = claim_scene()
        forbidden = FORBIDDEN_TYPE_READERS()
        environments = scene.environments(extra_shared=forbidden)
        original_types = roots_module.ROOTS_OBJECT_TYPES
        original_gate = roots_module._roots_parse_gate
        roots_module.ROOTS_OBJECT_TYPES = original_types | {"Mesh"}
        roots_module._roots_parse_gate = census._parse_gate
        try:
            with tempfile.TemporaryDirectory() as temp_value:
                source = self.make_source(Path(temp_value))
                _catalog, _files, facts, _fake = self.collect(environments, source)
        finally:
            roots_module.ROOTS_OBJECT_TYPES = original_types
            roots_module._roots_parse_gate = original_gate
        self.assertEqual(forbidden[0].parse_calls, 0)
        self.assertEqual(
            {row["reason"] for row in facts["skippedObjects"]},
            {"payload-bearing-type-not-parsed"},
        )

    def test_mutation_disabling_the_payload_scrub_is_caught_by_the_drop_counter(self):
        leaked = "archive:/CAB-secret/CAB-secret.resS"
        scene = Scene()
        scene.node(
            "Vagon_Yard",
            pos=(230.0, 0.0, -110.0),
            renderer=True,
            extra={"m_StreamData": {"path": leaked}},
        )
        document, _facts, _fake = self.build(scene)
        self.assertGreater(document["diagnostics"]["droppedForbiddenFieldCount"], 0)

        original = census._forbidden_fields_for
        census._forbidden_fields_for = lambda _type_name: frozenset()
        try:
            mutated, _facts, _fake = self.build(scene)
        finally:
            census._forbidden_fields_for = original
        self.assertEqual(mutated["diagnostics"]["droppedForbiddenFieldCount"], 0)

    def test_mutation_widening_the_output_allowlist_stops_the_refusal(self):
        payload = {"roots": [{"m_Vertices": [1, 2, 3]}]}
        with self.assertRaises(RootsError):
            roots_module.assert_bounded_payload(payload)
        widened = roots_module.ROOTS_ALLOWED_OUTPUT_KEYS | {"m_Vertices"}
        roots_module.assert_bounded_payload(payload, allowed=widened)

    def test_mutation_raising_the_parse_cap_lets_an_oversized_object_through(self):
        scene = claim_scene()
        environments = scene.environments()
        oversized = next(
            reader
            for reader in environments[SHARED_NAME]
            if reader.type.name == "MeshRenderer"
        )
        oversized.byte_size = census.MAX_PARSED_OBJECT_BYTES + 1
        document, _facts, _fake = self.build(scene, environments=environments)
        self.assertEqual(oversized.parse_calls, 0)
        self.assertFalse(document["complete"])

        environments = scene.environments()
        oversized = next(
            reader
            for reader in environments[SHARED_NAME]
            if reader.type.name == "MeshRenderer"
        )
        oversized.byte_size = census.MAX_PARSED_OBJECT_BYTES + 1
        original = census.MAX_PARSED_OBJECT_BYTES
        census.MAX_PARSED_OBJECT_BYTES = original * 1000
        try:
            self.build(scene, environments=environments)
        finally:
            census.MAX_PARSED_OBJECT_BYTES = original
        self.assertEqual(oversized.parse_calls, 1)

    def test_mutation_skipping_the_dependency_blockers_leaves_the_loaders_live(self):
        original = census._disable_dependency_loading
        census._disable_dependency_loading = lambda _environment: None
        try:
            with tempfile.TemporaryDirectory() as temp_value:
                source = self.make_source(Path(temp_value))
                _catalog, _files, _facts, fake = self.collect(
                    claim_scene().environments(), source
                )
            for environment in fake.returned_environments:
                self.assertEqual(environment.find_file("x"), "unsafe-find")
        finally:
            census._disable_dependency_loading = original

    def test_mutation_moving_the_repo_root_stops_the_repository_refusal(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            inside_repo = roots_module.REPO_ROOT / "never-created-roots.json"
            manifest = (
                roots_module.REPO_ROOT / "public/assets/3d/customs/scene-manifest.json"
            )
            arguments = [
                "--source", str(source),
                "--output", str(inside_repo),
                "--acknowledge-local-game-files",
                "--scene-manifest", str(manifest),
                "--no-cross-check",
                "--dry-run",
            ]
            code, _stdout, stderr = self.run_main(arguments)
            self.assertEqual(code, 2)
            self.assertIn("outside this repository", stderr)

            original = roots_module.REPO_ROOT
            roots_module.REPO_ROOT = base / "not-the-repo"
            (base / "not-the-repo").mkdir()
            try:
                code, _stdout, stderr = self.run_main(arguments)
            finally:
                roots_module.REPO_ROOT = original
            self.assertEqual(code, 0, stderr)
            self.assertFalse(inside_repo.exists())

    def test_mutation_a_clobbering_writer_destroys_what_no_clobber_protects(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            destination = base / "roots.json"
            destination.write_text("keep-me", encoding="utf-8")
            with self.assertRaises(RootsError):
                census._publish_json_noclobber([(destination, {"complete": False})])
            self.assertEqual(destination.read_text(encoding="utf-8"), "keep-me")

            # The mutation a reviewer must reject: a plain overwrite.
            with open(destination, "w", encoding="utf-8") as handle:
                handle.write(json.dumps({"complete": False}))
            self.assertNotEqual(destination.read_text(encoding="utf-8"), "keep-me")

    def test_mutation_loosening_the_witness_tolerance_passes_a_failed_frame(self):
        scene = Scene()
        scene.node("Vagon_Far", pos=(400.0, 0.0, 30.0), renderer=True)
        strict, _facts, _fake = self.build(scene)
        self.assertEqual(strict["frameCheck"]["fortressWitness"], "failed")
        self.assertFalse(strict["frameVerified"])

        loose, _facts, _fake = self.build(
            scene, parameters={"frameWitnessToleranceM": 100_000.0}
        )
        self.assertEqual(loose["frameCheck"]["fortressWitness"], "confirmed")
        self.assertTrue(loose["frameVerified"])

    def test_mutation_dropping_the_mirror_test_would_accept_a_reversed_frame(self):
        scene = Scene()
        scene.node("Vagon_Yard", pos=(-230.0, 0.0, 110.0), renderer=True)
        scene.node("Widget", pos=(-FORTRESS[0], 1.0, -FORTRESS[1]), renderer=True)
        document, _facts, _fake = self.build(scene)
        frame = document["frameCheck"]
        # A weaker check — "did the roots land on the map?" — passes here.
        self.assertEqual(frame["outsideTerrainEnvelopeCount"], 0)
        # The mirror comparison is the only thing that rejects it.
        self.assertEqual(frame["verdict"], "contradicted")
        self.assertGreater(
            frame["sourceFrameWitnessDistanceM"], frame["mirroredFrameWitnessDistanceM"]
        )

    def test_mutation_raising_the_span_guard_collapses_five_wagons_into_one(self):
        # `Wagons_01..05` all read as parts of their parent `Wagons`, so neither
        # multi-family rule can see them: R5 is the only thing holding this apart.
        strict, _facts, _fake = self.build(five_same_named_wagons_under_a_parent())
        self.assertEqual(strict["counts"]["electedRoots"], 5)
        self.assertEqual(strict["counts"]["spanRejectedCount"], 1)
        loose, _facts, _fake = self.build(
            five_same_named_wagons_under_a_parent(),
            parameters={"maxPlacementSpanM": 1000.0},
        )
        self.assertEqual(loose["counts"]["electedRoots"], 1)
        self.assertEqual(loose["counts"]["spanRejectedCount"], 0)

    def test_mutation_marking_a_broken_hierarchy_complete_elects_a_phantom_root(self):
        scene = incomplete_hierarchy()
        strict, _facts, _fake = self.build(scene)
        self.assertEqual(strict["counts"]["electedRoots"], 0)
        self.assertFalse(strict["complete"])

        def mark_complete(facts):
            for record in facts["gameObjects"]:
                record["hierarchyComplete"] = True
                record.setdefault(
                    "world",
                    {
                        "position": {"x": 230.0, "y": 0.0, "z": -110.0},
                        "rotation": {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0},
                        "scale": {"x": 1.0, "y": 1.0, "z": 1.0},
                        "worldExact": True,
                    },
                )

        mutated, _facts, _fake = self.build(scene, mutate_facts=mark_complete)
        self.assertEqual(mutated["counts"]["electedRoots"], 1)
        self.assertEqual(mutated["counts"]["unrootableNodeCount"], 0)

    def test_mutation_dropping_allow_partial_flips_complete_back_to_true(self):
        healthy, _facts, _fake = self.build(claim_scene())
        self.assertTrue(healthy["complete"])
        partial, _facts, _fake = self.build(claim_scene(), allow_partial=True)
        self.assertFalse(partial["complete"])
        self.assertEqual(partial["claimVerdict"]["overall"], "inconclusive")

    def test_mutation_supplying_the_acknowledgement_passes_the_first_gate(self):
        with tempfile.TemporaryDirectory() as temp_value:
            base = Path(temp_value)
            source = self.make_source(base)
            arguments = [
                "--source", str(source),
                "--output", str(base / "roots.json"),
                "--dry-run",
            ]
            code, _stdout, stderr = self.run_main(arguments)
            self.assertEqual(code, 2)
            self.assertIn("--acknowledge-local-game-files", stderr)
            code, _stdout, stderr = self.run_main(
                arguments + ["--acknowledge-local-game-files"]
            )
            self.assertEqual(code, 0, stderr)


if __name__ == "__main__":
    unittest.main()
