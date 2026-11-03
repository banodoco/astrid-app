"""Test-process barrier around the real provider's real acceptance call.

No replacement App, Runtime, provider, evaluation or acceptance implementation.
The selected SDK flight pauses after admission/provider preparation so the real
hosted App can acknowledge a lease before serialized acceptance resumes.
"""
import json
import os
import sys
import time
from pathlib import Path

if len(sys.argv) >= 2 and sys.argv[:2] == ["-m", "start"]:
    directory_name = os.environ.pop("ASTRID_T4_ACCEPTANCE_BARRIER", None)
    if directory_name:
        from runtime_protocol.timeline_commit_port import RequestCommitPort

        directory = Path(directory_name)
        original = RequestCommitPort.accept

        def accept(port, candidate):
            armed = directory / "arm.json"
            context = port._provider_context()
            if armed.is_file() and json.loads(armed.read_text())["key"] == context["idempotency_key"]:
                armed.unlink()
                (directory / "ready.json").write_text(json.dumps({
                    "key": context["idempotency_key"],
                    "base_revision_id": context["request"]["base_revision_id"],
                    "base_publication_id": context["request"]["base_publication_id"],
                }))
                deadline = time.monotonic() + 90
                while not (directory / "release").is_file():
                    if time.monotonic() >= deadline:
                        raise TimeoutError("T4 acceptance barrier was not released")
                    time.sleep(0.01)
            return original(port, candidate)

        RequestCommitPort.accept = accept
