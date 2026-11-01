"""Export/check offline App move parity from Agent a610cd3's permanent opaque fixture.

Use exact read-only source archives and the existing dependency environment:
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=<Agent a610cd3 archive> \
ASTRID_RUNTIME_CHECKOUT=<Runtime 9f9b25c archive> /home/user/work/venv-agent/bin/python \
src/tools/video-editor/commands/fixtures/authoring_bundle_move_opaque.py

--seed initially calls opaque_film itself (temporary local SQLite/files, no server).
--update retains those native original documents and refreshes only Agent outputs.
Ordinary checks need only the Agent archive; no Runtime service/acceptance is run.
"""
import copy
import hashlib
import inspect
import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

import pytest

from astrid.core.timeline.authoring_bundle import _remap_known_item_references
from astrid.sdk.timeline.capture import capture_move
from astrid.sdk.timeline.commands import execute
from astrid.sdk.timeline.commit import _digest, bundle_from_document
from tests.editing_conformance.test_commit_runtime_opaque_items import (
    assert_preserved,
    opaque_film,
)
from tests.timeline.test_authoring_bundle import (
    test_materialization_remaps_only_item_codec_and_declared_source_links,
)

AGENT = "a610cd304ba22fe89d132e00bc9bbe2561032aae"
# Byte-identical helper on 875a9aff and the integrated a610cd3 source.
assert hashlib.sha256(inspect.getsource(_remap_known_item_references).encode()).hexdigest() == (
    "966606b4c199a2a53e72fc647fcabf1279eef12d70eb46eaf1873edef991976f"
)
path = Path(__file__).with_name("authoringBundleMoveOpaque.json")
mode = sys.argv[1:]
assert mode in ([], ["--seed"], ["--update"])
codecs = ("item_id", "id", "both")

if mode == ["--seed"]:
    assert not path.exists(), "seeding must never replace retained native inputs"
    originals = []
    for codec in codecs:
        with tempfile.TemporaryDirectory(prefix="app-opaque-film-") as directory:
            with pytest.MonkeyPatch.context() as monkeypatch:
                fixture = opaque_film.__wrapped__(
                    SimpleNamespace(param=codec), Path(directory), monkeypatch
                )
                edit, _ = next(fixture)
                try:
                    originals.append({"name": codec, "document": edit.document()})
                finally:
                    fixture.close()
else:
    saved = json.loads(path.read_text())
    assert saved["agent_source"] == AGENT
    originals = [{"name": case["name"], "document": case["document"]}
                 for case in saved["cases"][:3]]
assert [case["name"] for case in originals] == list(codecs)
for case in originals:
    assert_preserved(case["document"], materialized=False)

# Exercise the permanent direct codec/descriptor boundary tests unchanged too.
for codec in (*codecs, "opaque-id"):
    for location in ("metadata", "root"):
        test_materialization_remaps_only_item_codec_and_declared_source_links(codec, location)

sources = copy.deepcopy(originals)
for original in originals:
    source = copy.deepcopy(original["document"])
    shot = next(row for row in source["shot_revisions"] if row["revision_id"] == "opaque-shot")
    for item in shot["payload"]["items"]:
        descriptor = item.pop("metadata")
        item.update(source_item_id=descriptor["source_item_id"], source_item=descriptor["source_item"])
    sources.append({"name": original["name"] + "-root", "document": source})
for location in ("null", "array", "secondary-id", "metadata-shadow"):
    source = copy.deepcopy(originals[0]["document"])
    shot = next(row for row in source["shot_revisions"] if row["revision_id"] == "opaque-shot")
    for item in shot["payload"]["items"]:
        if location in ("null", "array"):
            descriptor = item["metadata"]
            item.update(source_item_id=descriptor["source_item_id"], source_item=descriptor["source_item"])
            item["metadata"] = None if location == "null" else [copy.deepcopy(descriptor["data"]), None]
        elif location == "secondary-id":
            item["id"] = "opaque-identity"
        else:
            # Object metadata is authoritative; these root values stay literal.
            item.update(source_item_id="item-2", source_item="item-1")
    sources.append({"name": "item_id-" + location, "document": source})

cases = []
for source in sources:
    document = source["document"]
    if source["name"] not in codecs:
        for shot in document["shot_revisions"]:
            shot["content_digest"] = _digest(shot["payload"])
        for pin in document["dependency_manifest"]["shots"]:
            pin["content_digest"] = next(row["content_digest"] for row in document["shot_revisions"]
                                         if row["revision_id"] == pin["revision_id"])
    before = copy.deepcopy(document)
    bundle = bundle_from_document(document)
    select, on = "occurrence:occurrence-1/clip:clip-1", 0.5
    capture_command = capture_move(bundle, select, 0)
    command = capture_move(bundle, select, on)
    plan = execute(bundle, [command])
    assert document == before and bundle == bundle_from_document(before)
    cases.append({**source, "bundle": bundle, "select": select, "on": on,
                  "capture_command": capture_command, "command": command,
                  "record": plan.records[0], "after_bundle": plan.bundle})

encoded = json.dumps({"agent_source": AGENT, "cases": cases},
                     ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n"
if mode:
    path.write_text(encoded)
else:
    assert path.read_text() == encoded, "native opaque move goldens changed"
print(f"{len(cases)} exact native documents/bundles/commands/records/results; 8 permanent codec cases passed")
