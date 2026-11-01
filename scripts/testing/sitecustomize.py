"""Opt-in App harness bootstrap for the Runtime's real P2 phase observer.

Python imports this module before ``python -m runtime_protocol.cli``.  The
normal Runtime command therefore remains the process entrypoint; this module
only installs the explicitly requested test observer and flushes it at exit.
"""
from __future__ import annotations

import atexit
import importlib.util
import math
import os
import sys
from pathlib import Path


_capture = None


def _watchdog_options() -> dict[str, float]:
    value = os.environ.get("ASTRID_P2_COMMIT_PHASE_CAPTURE_WATCHDOG_SECONDS", "").strip()
    if not value:
        return {}
    try:
        seconds = float(value)
    except ValueError as exc:
        raise ValueError("P2 Runtime watchdog seconds must be finite and positive") from exc
    if not math.isfinite(seconds) or seconds <= 0:
        raise ValueError("P2 Runtime watchdog seconds must be finite and positive")
    return {"watchdog_seconds": seconds}


def _is_runtime_cli_start() -> bool:
    """Select the normal Runtime CLI daemon from Python's ``-m`` argv seam.

    ``sitecustomize`` runs before ``runpy`` has installed the module name, so
    Python exposes ``['-m', 'start', ...]`` here for
    ``python -m runtime_protocol.cli start ...``.  The actual Runtime server
    worker is then a ThreadingHTTPServer thread in this daemon process; the
    qualified helper carries its trace hook to that thread.
    """
    return len(sys.argv) >= 2 and sys.argv[0] == "-m" and sys.argv[1] == "start"


def _start_capture() -> None:
    global _capture
    helper_name = os.environ.get("ASTRID_P2_COMMIT_PHASE_CAPTURE_HELPER", "")
    sink_name = os.environ.get("ASTRID_P2_COMMIT_PHASE_CAPTURE_SINK", "")
    helper = Path(helper_name)
    if not helper.is_file() or helper.name != "p2_commit_phase_capture.py":
        raise SystemExit("P2 Runtime phase helper is unavailable at the selected Runtime source")
    if not sink_name:
        raise SystemExit("P2 Runtime phase sink is not configured")
    spec = importlib.util.spec_from_file_location("_astrid_p2_commit_phase_capture", helper)
    if spec is None or spec.loader is None:
        raise SystemExit("P2 Runtime phase helper could not be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    _capture = module.P2CommitPhaseCapture(Path(sink_name), enabled=True, **_watchdog_options())
    _capture.start()
    atexit.register(_capture.stop)
    # Do not propagate the opt-in into any child worker the Runtime may start;
    # this observer belongs to the daemon process that owns its lifecycle.
    for key in (
        "ASTRID_P2_COMMIT_PHASE_CAPTURE",
        "ASTRID_P2_COMMIT_PHASE_CAPTURE_SINK",
        "ASTRID_P2_COMMIT_PHASE_CAPTURE_HELPER",
        "ASTRID_P2_COMMIT_PHASE_CAPTURE_WATCHDOG_SECONDS",
    ):
        os.environ.pop(key, None)


if os.environ.get("ASTRID_P2_COMMIT_PHASE_CAPTURE") == "1" and _is_runtime_cli_start():
    try:
        _start_capture()
    except BaseException:
        # ``site`` normally swallows sitecustomize failures.  An explicitly
        # requested qualification must fail closed instead of silently losing
        # its observer.
        os._exit(78)
