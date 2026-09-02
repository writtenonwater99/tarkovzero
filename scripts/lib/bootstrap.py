"""Make ``lib.*`` importable from a script Blender launched with ``--python``.

Blender runs a ``--python`` script with ``__name__ == "__main__"`` and does not
put the script's own tree on ``sys.path``, so a factory cannot simply write
``from lib.gltf.read import glb_json``. Every factory and validator therefore
opens with::

    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from lib.bootstrap import ensure_library_path
    ensure_library_path(__file__)

``parents[2]`` is ``<repo>/scripts`` for a file at
``<repo>/scripts/<factory-dir>/<factory>.py``.

This module is deliberately dependency-free and side-effect-free on import.
"""

from __future__ import annotations

import sys
from pathlib import Path

SCRIPTS_ROOT = Path(__file__).resolve().parents[1]


def ensure_library_path(caller: str | Path | None = None) -> Path:
    """Put ``<repo>/scripts`` on ``sys.path`` exactly once and return it.

    ``caller`` is accepted for readability at the call site and to allow a
    future consistency check; the answer is derived from this module's own
    location so it cannot drift with the caller's depth.
    """
    root = str(SCRIPTS_ROOT)
    if root not in sys.path:
        sys.path.insert(0, root)
    return SCRIPTS_ROOT


def library_module_paths() -> list[Path]:
    """Every ``.py`` file in this package, sorted, for provenance hashing.

    A factory receipt pins the factory script's own SHA-256. Code that moved
    into this package is no longer covered by that pin, so a caller that wants
    a complete provenance digest hashes these files alongside its own source.
    See ``docs/plans/BUILDING-MASSING.md`` and the consolidation report for the
    open decision about whether receipts should carry that digest.
    """
    return sorted(SCRIPTS_ROOT.joinpath("lib").rglob("*.py"))
