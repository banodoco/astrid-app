"""Prepare the frame-parity closure through Runtime's bounded native test seam.

This helper is called only for the frame-parity fixture, before the daemon is
started.  It uses ordinary project/timeline/media creation, then the existing
closure validator and persister under the store mutex and transaction.  The
fixture is still adopted by the normal authenticated timeline.restore route
after startup; this helper does not create a head, history entry, command, or
capture reference.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path


def digest(value):
    from runtime_protocol.timeline_commit_validation import digest as native_digest

    return native_digest(value)


def media_digest(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def build_document(project_id: str, timeline_id: str, spec: dict, media: dict) -> dict:
    track = {"id": "S1", "kind": "visual", "label": "S1"}
    internal_tracks = [
        {"id": "V1", "kind": "visual", "label": "V1"},
        {"id": "A1", "kind": "audio", "label": "A1"},
    ]

    def asset(name: str, media_type: str, duration=None) -> dict:
        pin = media[name]
        value = {
            "media_id": pin["digest"],
            "content_sha256": pin["digest"],
            "type": media_type,
        }
        if duration is not None:
            value["duration"] = duration
        return value

    clips = [
        {"id": "parity-image", "track": "V1", "at": 0, "clipType": "media", "hold": 4, "asset": "still"},
        {"id": "parity-video", "track": "V1", "at": 4, "clipType": "media", "hold": 1.5, "asset": "video",
         "from": 0, "to": 1.5, "speed": 1},
        {"id": "parity-audio", "track": "A1", "at": 0.25, "clipType": "media", "asset": "audio",
         "from": 0.05, "to": 0.55, "speed": 1, "volume": 0.8,
         "effects": [{"fade_in": 0.1, "fade_out": 0.1}]},
    ]
    shot_id = spec["shot_id"]
    shot_revision_id = spec["shot_revision_id"]
    internal_revision_id = spec["internal_revision_id"]
    internal_payload = {
        "tracks": internal_tracks,
        "clips": clips,
        "effects": [],
        "audio": [],
        "layout": {},
        "assets": [],
        "registry": {"assets": {
            "still": asset("image", "image/png"),
            "video": asset("video", "video/webm", 1.5),
            "audio": asset("audio", "audio/wav", 1),
        }},
    }
    shot_payload = {
        "metadata": {"title": "Ordinary media"},
        "internal_timeline_revision_id": internal_revision_id,
        "items": [],
        "pools": [],
        "selected_variants": {},
        "provenance": {},
        "generation_inputs": {},
        "audio_bindings": [],
        "text_bindings": [],
    }
    parent_payload = {
        "slug": "main",
        "name": "Ordinary media frame parity",
        "config": {
            "output": {
                "resolution": f"{spec['width']}x{spec['height']}",
                "fps": spec["fps"],
                "file": "frame-parity.mp4",
            },
            "tracks": [track],
            "clips": [],
        },
        "registry": {"assets": {}},
        "clips": [],
        "occurrences": [{
            "occurrence_id": spec["occurrence_id"],
            "shot_id": shot_id,
            "shot_revision_id": shot_revision_id,
            "placement": {"start_ms": 0},
            "source_offset": 0,
            "duration_ms": 5500,
            "speed": 1,
            "track": "S1",
            "transform": {},
            "gain": 1,
            "muted": False,
            "provenance": {},
        }],
    }
    if spec.get("theme_canvas") is not None:
        parent_payload["config"]["theme_overrides"] = {
            "visual": {"canvas": spec["theme_canvas"]},
        }
    internal = {"timeline_id": timeline_id, "revision_id": internal_revision_id, "payload": internal_payload}
    shot = {"shot_id": shot_id, "revision_id": shot_revision_id,
            "internal_timeline_revision_id": internal_revision_id, "payload": shot_payload}
    parent = {"revision_id": spec["parent_revision_id"], "payload": parent_payload}
    for image in (parent, shot, internal):
        image["content_digest"] = digest(image["payload"])
    document = {
        "schema_version": 1,
        "project_id": project_id,
        "timeline_id": timeline_id,
        "parent_revision": parent,
        "shot_revisions": [shot],
        "internal_timeline_revisions": [internal],
        "dependency_manifest": {
            "shots": [{key: shot[key] for key in ("shot_id", "revision_id", "internal_timeline_revision_id", "content_digest")}],
            "internal_timelines": [{key: internal[key] for key in ("timeline_id", "revision_id", "content_digest")}],
            "media": sorted([{"media_id": value["digest"], "content_digest": value["digest"]} for value in media.values()],
                            key=lambda value: value["media_id"]),
            "documents": [],
        },
    }
    return document


def prepare(config: dict) -> dict:
    from runtime_protocol.service import RuntimeService
    from runtime_protocol.timeline_commit_store import TimelineCommitStore
    from runtime_protocol.timeline_commit_provider import load_timeline_commit_provider
    from runtime_protocol.timeline_commit_validation import validate_commit_value

    root = Path(config["realm_dir"])
    if not root.exists():
        raise ValueError("frame-parity native fixture requires the harness-created realm")
    service = RuntimeService(root)
    try:
        service.register_timeline_commit_provider(load_timeline_commit_provider("astrid"))
        project = service.create_project({"slug": config["project_slug"], "name": "Frame parity fixture"},
                                         idempotency_key="frame-parity-project")["id"]
        timeline = config["timeline_id"]
        service.create_timeline(project, timeline, name="Frame parity fixture", idempotency_key="frame-parity-timeline")
        media = {}
        for item in config["media"]:
            data = Path(item["path"]).read_bytes()
            actual = media_digest(data)
            if actual != item["digest"]:
                raise ValueError(f"{item['name']} digest changed before native ingest")
            service.ingest(project, data, media_type=item["media_type"], original_name=item["original_name"],
                           expected_digest=actual, idempotency_key=f"frame-parity-media-{item['name']}")
            media[item["name"]] = {"digest": actual}
        document = build_document(project, timeline, config, media)
        commits = TimelineCommitStore(service.store,
                                      validate_prepared=lambda value: validate_commit_value(value, "PreparedCommit"))
        before = commits.head(project, timeline)
        with service.store._mutex, service.store._transaction():
            validate_commit_value(document, "CanonicalDocument")
            commits._validate_closure(document)
            commits._persist_closure(document)
            if commits.revision_closure(project, timeline, document["parent_revision"]["revision_id"]) != document:
                raise AssertionError("native closure readback differs from prepared document")
            if commits.head(project, timeline) != before:
                raise AssertionError("native fixture setup changed the empty timeline head")
        return {"projectId": project, "timelineId": timeline, "head": before,
                "document": document,
                "media": [{"name": item["name"], "objectId": media[item["name"]]["digest"],
                           "digest": media[item["name"]]["digest"]} for item in config["media"]]}
    finally:
        service.close()


def main() -> None:
    config = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    print(json.dumps(prepare(config), separators=(",", ":")))


if __name__ == "__main__":
    main()
