#!/usr/bin/env python3
"""Plan 61's real installed-stack proof, exclusively on an ephemeral hosted Mac.

The Runtime and installer are real. Fixture-only refusals are labelled separately.
No credentials, environment-file contents, or database bytes enter the artifacts.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import sqlite3
import struct
import subprocess
import sys
import time
import urllib.request
import uuid
import zlib

BRANCH = "release/14/plan-61"
BASE = "0bce7312f2fc8030b50286ed75b38d0232100820"
PROJECT = "p61-live-proof"
PROJECT_NAME = "P61 live proof"
TIMELINE = "61616161-6161-4161-8161-616161616161"
TIMELINE_NAME = "Long-lived timeline"
EDIT_NAME = "P61 copied-realm edit"
KNOWN_START_ERROR = "accepted commit inputs changed during verification"


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def read_json(path):
    return json.loads(Path(path).read_text())


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def db_facts(realm):
    database = (Path(realm) / "realm.sqlite3").resolve()
    with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        result = {
            "schema": dict(connection.execute("SELECT format_id,version FROM runtime_schema WHERE id=1").fetchone()),
            "heads": [dict(row) for row in connection.execute(
                "SELECT project_id,timeline_id,revision_id,publication_id FROM parent_composition_heads ORDER BY project_id,timeline_id")],
            "timeline_commit_history_count": connection.execute("SELECT count(*) FROM timeline_commit_history").fetchone()[0],
            "runtime": dict(connection.execute(
                "SELECT runtime_epoch,boot_id,previous_boot_id,started_at FROM runtime_lifecycle WHERE id=1").fetchone()),
        }
        connection.rollback()
    return result


class Proof:
    def __init__(self):
        require(sys.platform == "darwin", "This proof runs on macOS only")
        require(os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted", "A GitHub-hosted runner is required")
        require(os.environ.get("GITHUB_REPOSITORY") == "banodoco/astrid-app", "Unexpected repository")
        require(os.environ.get("GITHUB_REF") == "refs/heads/p61/rb-6", "Dispatch only on p61/rb-6")
        os.umask(0o077)
        self.repo = Path(__file__).resolve().parents[2]
        self.proof = Path(os.environ["P61_PROOF"]).resolve()
        require(self.proof.is_relative_to(Path(os.environ["RUNNER_TEMP"]).resolve()), "Evidence must be inside RUNNER_TEMP")
        self.proof.mkdir(exist_ok=True)
        self.runner_home = Path.home().resolve()
        self.root = self.runner_home / "astrid-release" / BRANCH.replace("/", "-")
        self.tool_repo = Path(os.environ.get("P61_TOOL_CHECKOUT", str(self.repo))).resolve()
        self.tool = self.tool_repo / "scripts/astrid-release/astrid-release"
        self.context_file = self.proof / "context.json"
        self.context = read_json(self.context_file) if self.context_file.exists() else {}
        self.secrets = []

    def save(self):
        write_json(self.context_file, self.context)

    def clean(self, value):
        text = str(value)
        for secret in self.secrets:
            text = text.replace(secret, "[REDACTED]")
        text = re.sub(r"(?i)(Bearer\s+)[^\s\"']+", r"\1[REDACTED]", text)
        return re.sub(r'("(?:token|access_token|api_key)"\s*:\s*")[^"]*(")', r'\1[REDACTED]\2', text)

    def note(self, label, value):
        text = value if isinstance(value, str) else json.dumps(value, indent=2, sort_keys=True)
        text = self.clean(text)
        print(f"\n## {label}\n{text}", flush=True)
        with (self.proof / "run-record.md").open("a") as stream:
            stream.write(f"\n## {label}\n\n```text\n{text}\n```\n")

    def run(self, label, command, *, env=None, cwd=None, expected=0, timeout=1800):
        command = [str(part) for part in command]
        self.note(label + " command", shlex.join(command))
        started = time.monotonic()
        try:
            result = subprocess.run(command, cwd=cwd or self.repo, env=env,
                                    text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    timeout=timeout)
        except subprocess.TimeoutExpired as error:
            output = error.stdout or ""
            if isinstance(output, bytes):
                output = output.decode(errors="replace")
            self.note(label + " partial output before timeout", output)
            self.note(label + " timeout", {"seconds": timeout})
            (self.proof / (re.sub(r"[^a-zA-Z0-9._-]", "-", label) + ".log")).write_text(self.clean(output))
            raise
        self.note(label + " output", result.stdout)
        self.note(label + " result", {"exit": result.returncode, "seconds": round(time.monotonic() - started, 3)})
        (self.proof / (re.sub(r"[^a-zA-Z0-9._-]", "-", label) + ".log")).write_text(self.clean(result.stdout))
        if expected == "nonzero":
            require(result.returncode != 0, label + " unexpectedly succeeded")
        elif expected is not None:
            require(result.returncode == expected, f"{label}: exit {result.returncode}, expected {expected}")
        return result

    def disk(self, label):
        self.run(label, ["df", "-Pk", self.runner_home, os.environ["RUNNER_TEMP"]])
        self.note(label + " cuts", "No runner toolchain or proof item has been removed to fit the run.")

    def live(self):
        selection = read_json(self.runner_home / ".local/share/astrid-install.json")
        program = Path(selection["program_root"])
        data = Path(selection["data_root"])
        catalog = read_json(data / "runtime/catalog.json")
        realm_id = catalog["selected_realm_id"]
        entry = next(item for item in catalog["realms"] if item["realm_id"] == realm_id)
        return program, data, Path(entry["data_root"]), realm_id

    def installed(self, root=None):
        root = root or self.root
        version = (root / "program/current").read_text().strip()
        require(bool(re.fullmatch(r"[A-Za-z0-9._-]+", version)), "Invalid installed version")
        version_root = root / "program/versions" / version
        return version_root, version_root / "py/bin/python"

    def isolated_env(self, root=None):
        root = root or self.root
        ignored = ("ASTRID_", "VITE_", "WORKSPACE_", "XDG_", "PYTHON")
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(ignored) and key not in {"VIRTUAL_ENV", "PORT", "HOME", "TMPDIR"}}
        env.update({"HOME": str(root / "home"), "TMPDIR": str(root / "tmp") + "/",
                    "XDG_DATA_HOME": str(root / "home/.local/share"),
                    "XDG_STATE_HOME": str(root / "home/.local/state"),
                    "XDG_CACHE_HOME": str(root / "home/.cache"),
                    "XDG_CONFIG_HOME": str(root / "home/.config")})
        return env

    def processes(self, root=None):
        root = root or self.root
        rows = subprocess.check_output(["ps", "-axo", "pid=,lstart=,command="], text=True)
        return [line.strip() for line in rows.splitlines() if str(root) + "/" in line and str(os.getpid()) != line.split()[0]]

    def stop(self, label):
        self.run(label, ["bash", self.tool, "stop", BRANCH])
        remaining = self.processes()
        self.note(label + " process census", remaining)
        require(not remaining, "A stack process remains after stop: " + repr(remaining))

    def token(self, data):
        discovery = read_json(Path(data) / "runtime/discovery.json")
        token = read_json(discovery["credential_file"])["token"]
        self.secrets.append(token)
        return discovery["endpoint"].rstrip("/"), token

    def get(self, data, route):
        endpoint, token = self.token(data)
        request = urllib.request.Request(endpoint + route, headers={"Authorization": "Bearer " + token})
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)

    def timeline(self, data):
        return self.get(data, f'/v1/projects/{self.context["project_id"]}/timelines/{TIMELINE}')

    def control(self, label):
        program, data, realm, realm_id = self.live()
        version = (program / "current").read_text().strip()
        stable = sorted(path for path in (realm / "cas").rglob("*") if path.is_file())
        stable += [self.runner_home / ".astrid/astrid.env",
                   self.runner_home / ".local/share/astrid-install.json", program / "install.json",
                   self.runner_home / "Library/LaunchAgents/haus.astrid.runtime.plist",
                   program / "versions" / version / "manifest.json",
                   program / "versions" / version / "version.json", program / "current"]
        missing = [str(path) for path in stable if not path.exists()]
        hashes = {str(path): digest(path) for path in stable if path.is_file()}
        self.run(label + " shasum", ["shasum", "-a", "256", *[path for path in stable if path.is_file()]])
        discovery = read_json(data / "runtime/discovery.json")
        process = subprocess.check_output(["ps", "-p", str(discovery["pid"]), "-o", "pid=,lstart=,command="], text=True).strip()
        job = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/haus.astrid.runtime"], text=True, capture_output=True)
        require(job.returncode == 0, "The live login service is not loaded: " + job.stderr)
        job_state = [line.strip() for line in job.stdout.splitlines()
                     if re.match(r"^\t(?:state|pid|runs|last exit code) =", line)]
        require(any("state = running" in line for line in job_state), "Live launchd job is not running")
        facts = db_facts(realm)
        result = {"realm_id": realm_id, "hashes": hashes, "absent_paths": missing,
                  "process": process, "launchd_state": job_state, "database": facts}
        write_json(self.proof / f"{label}.json", result)
        self.note(label + " read-only database/process facts", result)
        return result

    def bootstrap(self):
        require(not (self.runner_home / ".local/share/astrid-install.json").exists(), "Runner already has an install; refusing to replace it")
        require(not self.root.exists(), "Runner already has the release root; refusing to replace it")
        self.disk("initial-disk")
        self.run("candidate identity", ["git", "rev-parse", "HEAD"])
        self.run("tool identity", ["git", "-C", self.tool_repo, "rev-parse", "HEAD"])
        manifest = read_json(self.repo / "public/install-manifest.json")
        require(manifest["release"] == 13, "Control manifest must name Release 13")
        require(manifest["agent"]["sha"] == "9814193a73f606719e81883a8be197d27dd361d4", "Live Agent pin changed")
        require(manifest["runtime"]["sha"] == "6855dfa8df65cf8ae4c002b57134d6505493c17c", "Live Runtime pin changed")
        frozen = self.proof / "release13-manifest.json"
        shutil.copyfile(self.repo / "public/install-manifest.json", frozen)
        self.note("frozen Release 13 manifest", {"sha256": digest(frozen), "pins": manifest})
        config = self.runner_home / ".astrid/astrid.env"
        require(not config.exists(), "Unexpected pre-existing live environment file")
        config.parent.mkdir(parents=True, exist_ok=True)
        config.write_text("# Empty configuration for the Plan 61 hosted live control.\n")
        # R13 predates --no-browser; use its real supported options. It may open its public welcome URL.
        self.run("install-release13-live", ["sh", self.repo / "public/install", "--manifest", frozen,
                 "--yes", "--autostart", "on", "--command", "off", "--skills", "off", "--skill-copies", "off"], timeout=2400)
        program, data, realm, realm_id = self.live()
        installed_manifest = program / "versions" / (program / "current").read_text().strip() / "manifest.json"
        require(read_json(installed_manifest) == manifest, "Live installed manifest differs from the frozen control")
        self.context.update({"live_program": str(program), "live_data": str(data), "live_realm": str(realm), "live_realm_id": realm_id,
                             "project_id": PROJECT, "timeline_id": TIMELINE, "starts": []})
        self.save()
        self.disk("after-live-install-disk")

    def seed(self):
        program, data, _, _ = self.live()
        launcher = program / "run-astrid"
        image = self.proof / "p61-colour-card.png"
        width, height = 640, 360
        rows = b"".join(b"\x00" + b"".join(bytes((x * 255 // width, y * 255 // height, 96)) for x in range(width)) for y in range(height))
        def chunk(kind, value):
            return struct.pack(">I", len(value)) + kind + value + struct.pack(">I", zlib.crc32(kind + value) & 0xFFFFFFFF)
        image.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))
        # Keep the original still-image clip and add real moving H.264 media.
        # The preview's decoded-frame marker is emitted by ReadinessVideo; a
        # still image alone cannot exercise that video-decoder acceptance gate.
        selected = (program / "current").read_text().strip()
        version = read_json(program / "versions" / selected / "version.json")
        tools = version["env"]
        ffmpeg = Path(tools["ASTRID_FFMPEG_EXECUTABLE"])
        ffprobe = Path(tools["ASTRID_FFPROBE_EXECUTABLE"])
        require(ffmpeg.is_file() and ffprobe.is_file(), "The live install has no recorded media-tool pair")
        self.note("seed video tool identity", {
            "ffmpeg": str(ffmpeg), "ffmpeg_sha256": digest(ffmpeg),
            "ffprobe": str(ffprobe), "ffprobe_sha256": digest(ffprobe),
            "source": tools["ASTRID_INSTALL_FFMPEG_SOURCE"],
            "ffmpeg_version": tools["ASTRID_INSTALL_FFMPEG_VERSION"],
            "ffprobe_version": tools["ASTRID_INSTALL_FFPROBE_VERSION"],
        })
        video = self.proof / "p61-motion-card.mp4"
        self.run("generate real motion fixture", [ffmpeg, "-nostdin", "-hide_banner", "-y", "-f", "lavfi",
                 "-i", "testsrc2=size=640x360:rate=30", "-frames:v", "300", "-an", "-c:v", "libx264",
                 "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", video])
        probe = self.run("validate real motion fixture", [ffprobe, "-v", "error", "-select_streams", "v:0",
                         "-show_entries", "stream=codec_name,width,height,nb_frames,avg_frame_rate,duration",
                         "-of", "json", video])
        stream = json.loads(probe.stdout)["streams"][0]
        require(stream["codec_name"] == "h264" and stream["width"] == 640 and stream["height"] == 360,
                "Motion fixture has the wrong codec or dimensions")
        require(stream["nb_frames"] == "300" and stream["avg_frame_rate"] == "30/1"
                and abs(float(stream["duration"]) - 10) < 0.01, "Motion fixture is not ten seconds at 30 fps")
        self.context["seed_video"] = {"sha256": digest(video), "stream": stream}
        self.save()
        commands = [
            ("seed-project", ["projects", "create", PROJECT, "--name", PROJECT_NAME, "--idempotency-key", "p61-project-create", "--json"]),
            ("seed-timeline", ["timelines", "create", TIMELINE, "--project", PROJECT, "--name", TIMELINE_NAME, "--canvas", "640x360", "--fps", "30", "--idempotency-key", "p61-timeline-create", "--json"]),
            ("seed-first-clip", ["timelines", "edit", TIMELINE, "--project", PROJECT, "--add-layer", "media", "--layer-asset", str(image), "--on", "0", "--for", "10", "--track", "V1", "--id", "p61-clip", "--idempotency-key", "p61-first-clip", "--json"]),
            ("seed-video-clip", ["timelines", "edit", TIMELINE, "--project", PROJECT, "--add-layer", "media", "--layer-asset", str(video), "--on", "0", "--for", "10", "--track", "V2", "--id", "p61-video", "--idempotency-key", "p61-first-video", "--json"]),
        ]
        for label, args in commands:
            result = self.run(label, [launcher, *args])
            envelope = json.loads(result.stdout)
            require(envelope.get("ok") is True, label + " returned a failing product envelope")
            if label == "seed-project":
                project = envelope["data"].get("project", envelope["data"])
                project_id = project.get("project_id") or project.get("id")
                require(isinstance(project_id, str) and project_id, "Project create returned no canonical ID")
                self.context["project_id"] = project_id
                self.save()
        publications = []
        for index, position in enumerate(["0.25", "0.5", "0"], 1):
            self.run(f"seed-history-{index}", [launcher, "timelines", "edit", TIMELINE, "--project", PROJECT,
                     "--clip", "parent/clip:p61-clip", "--on", position, "--idempotency-key", f"p61-history-{index}", "--json"])
            publications.append(self.timeline(data)["head_publication_id"])
        require(len(set(publications)) == 3, "Seed edits did not create distinct durable publications")
        self.context["seed_head"] = self.timeline(data)
        self.context["seed_facts"] = db_facts(self.live()[2])
        require(self.context["seed_facts"]["timeline_commit_history_count"] >= 4, "Live timeline has insufficient durable history")
        self.save()
        self.note("live long-lived timeline seed", {"head": self.context["seed_head"], "publications": publications, "facts": self.context["seed_facts"]})
        self.control("live-before")

    def keep_and_remove(self, label):
        require(self.root == self.runner_home / "astrid-release/release-14-plan-61", "Unexpected cleanup destination")
        self.stop(label + " stop")
        # Keep full data outside the upload directory: it contains credentials and databases.
        kept = self.proof.with_name(self.proof.name + "-kept-data")
        kept.mkdir(exist_ok=True)
        backup = kept / label
        if (self.root / "data").exists():
            self.run(label + " keep data", ["cp", "-c", "-R", self.root / "data", backup])
            original = self.root / "data/runtime/realms"
            for database in original.glob("*/realm.sqlite3"):
                copied = backup / "runtime/realms" / database.parent.name / database.name
                require(digest(database) == digest(copied), "Kept database differs before root removal")
        self.note(label + " remove owned root", str(self.root))
        shutil.rmtree(self.root)
        require(not self.root.exists(), "Owned root remains after removal")

    def half_built(self):
        require(not self.root.exists(), "Half-built control needs a fresh root")
        for directory in ["state", "logs", "home", "tmp"]:
            (self.root / directory).mkdir(parents=True, exist_ok=True)
        # Build a real installer-owned empty realm, then prove the tool's straggler stop.
        agent_ref = self.run("half-built Agent resolution", ["git", "ls-remote", "--heads", "https://github.com/banodoco/astrid-agent.git", "refs/heads/release/14/main"]).stdout.split()[0]
        manifest = self.proof / "half-built-manifest.json"
        self.run("half-built derive manifest", ["node", self.tool_repo / "scripts/installer/pin.mjs", agent_ref,
                 "--in", self.repo / "public/install-manifest.json", "--out", manifest])
        env = self.isolated_env()
        env["ASTRID_RUNTIME_DOOR_PORT"] = "17501"
        self.run("half-built real installer", ["sh", self.repo / "public/install", "--root", self.root / "program",
                 "--data-root", self.root / "data", "--manifest", manifest, "--yes", "--autostart", "off",
                 "--command", "off", "--skills", "off", "--skill-copies", "off", "--no-browser"], env=env, timeout=2400)
        discovery = read_json(self.root / "data/runtime/discovery.json")
        self.note("half-built installer Runtime", {"pid": discovery["pid"], "processes": self.processes()})
        require(self.processes(), "Installer did not leave a real Runtime to test")
        require(not (self.root / "state/realm-id").exists(), "Half-built install unexpectedly has a copied-realm marker")
        catalog = read_json(self.root / "data/runtime/catalog.json")
        empty_realm = next(item for item in catalog["realms"] if item["realm_id"] == catalog["selected_realm_id"])
        empty_facts = db_facts(empty_realm["data_root"])
        require(not empty_facts["heads"], "Half-built installer realm is not empty")
        self.note("half-built empty-realm facts", empty_facts)
        self.stop("completion-01-half-built-stop")
        self.keep_and_remove("half-built")
        self.control("live-after-half-built")

    def start(self, label, *, tool=None):
        self.disk(label + " disk")
        self.context["active_start"] = label
        self.save()
        old_tails = sorted((self.root / "logs").glob("start-attempt-*.log"))
        if old_tails:
            previous = self.proof / (label + "-previous-tails")
            previous.mkdir(exist_ok=True)
            for path in old_tails:
                (previous / path.name).write_text(self.clean(path.read_text(errors="replace")))
                path.unlink()
        observer = self.repo / "scripts/astrid-release/observe-attach.bash"
        attach_log = self.proof / (label + "-attach.json")
        env = {**os.environ, "BASH_ENV": str(observer), "P61_ATTACH_LOG": str(attach_log)}
        self.note(label + " attach observer", {"path": str(observer), "sha256": digest(observer), "purpose": "retain the actual successful attach JSON; no command/output/result replacement"})
        result = self.run(label, ["bash", tool or self.tool, BRANCH], env=env, timeout=3000, expected=None)
        self.collect_stack(label + "-logs")
        require(result.returncode == 0, f"{label}: real release tool failed with exit {result.returncode}")
        if attach_log.exists():
            attach = read_json(attach_log)
            require(attach["status"] == "configured_attach", "Observed attach JSON has the wrong status")
            self.note(label + " actual workspace attach output", attach)
        require("READY: release " + BRANCH in result.stdout, "Release tool did not report READY")
        require("To launch this, do:" in result.stdout, "Release tool omitted its launch line")
        realm_id = (self.root / "state/realm-id").read_text().strip()
        inspect = read_json(self.root / "state/workspace-inspect.json")
        require(inspect["realm_id"] == self.context["live_realm_id"] == realm_id, "workspace inspect selected the wrong copied realm")
        start_record = {"label": label, "heads": (self.root / "state/heads.tsv").read_text().strip(),
                        "realm_id": realm_id, "inspect": inspect,
                        "retry_files": sorted(p.name for p in (self.root / "logs").glob("start-attempt-*.log"))}
        self.context["starts"].append(start_record)
        self.save()
        self.note(label + " accepted copied realm", start_record)
        return result

    def copy_facts(self, label):
        realm_id = (self.root / "state/realm-id").read_text().strip()
        facts = db_facts(self.root / "data/runtime/realms" / realm_id)
        write_json(self.proof / (label + ".json"), facts)
        self.note(label + " mode=ro facts", facts)
        return facts

    def browser(self, label, mode):
        env = dict(os.environ)
        env["PLAYWRIGHT_BROWSERS_PATH"] = str(self.proof.with_name(self.proof.name + "-browsers"))
        args = ["node", self.repo / "scripts/astrid-release/hosted-browser.mjs", str(self.root), str(self.proof), mode]
        self.run(label, args, env=env, timeout=420)

    def fresh(self):
        require(not self.root.exists(), "Fresh first run must start without a release root")
        result = self.start("completion-02-fresh-first-run")
        require(read_json(self.proof / "completion-02-fresh-first-run-attach.json")["status"] == "configured_attach", "Fresh attach never reported configured_attach")
        head = self.timeline(self.root / "data")
        require(head["head_publication_id"] == self.context["seed_head"]["head_publication_id"], "Copied timeline does not have the live seed publication")
        self.context["copied_seed_head"] = head
        self.save()
        env = dict(os.environ)
        env["PLAYWRIGHT_BROWSERS_PATH"] = str(self.proof.with_name(self.proof.name + "-browsers"))
        self.run("install Playwright browser", [self.root / "editor/node_modules/.bin/playwright", "install", "chromium"], env=env)
        self.browser("completion-03-existing-timeline-playback", "play")

    def restart_edit(self):
        self.stop("completion-04-stop-before-count")
        before = self.copy_facts("copy-before-edit")
        self.context["count_before_edit"] = before["timeline_commit_history_count"]
        self.save()
        self.start("completion-04-start-before-edit")
        self.browser("completion-04-editor-edit", "edit")
        self.stop("completion-04-stop-after-edit")
        edited = self.copy_facts("copy-after-edit-before-restart")
        require(edited["timeline_commit_history_count"] == before["timeline_commit_history_count"] + 1, "One UI edit did not add exactly one history row")
        self.context["edited_heads"] = edited["heads"]
        self.save()
        self.start("completion-04-restart-edited-copy")
        self.browser("completion-04-edit-survived-restart", "verify-edit")
        after = self.copy_facts("copy-after-edit-after-restart")
        require(after["timeline_commit_history_count"] == before["timeline_commit_history_count"] + 1, "Restart changed history count")
        require(after["heads"] == edited["heads"], "Restart changed the edited head/publication")

    def updates(self):
        before_processes = self.processes()
        before_installer = {p.name: (p.stat().st_size, digest(p)) for p in (self.root / "logs").glob("install*.log")}
        before_heads = (self.root / "state/heads.tsv").read_text()
        result = self.run("completion-05-unchanged-update", ["bash", self.tool, "update", BRANCH], expected=None)
        if result.returncode:
            require("manifest changed" in result.stdout and "Nothing was changed" in result.stdout, "Unexpected update failure")
            self.note("completion-06-moved-pin-update", "Real branch movement observed; refusal and rebuild instructions above.")
            require(all(text in result.stdout for text in ["1) astrid-release stop", "2) keep the data: cp -c -R", "3) delete"]), "Missing rebuild steps")
            raise AssertionError("Real branches moved; moved-pin refusal exercised, unchanged-update proof needs a stable interval")
        require("unchanged" in result.stdout and "Nothing changed. The stack was left as it is." in result.stdout, "Unchanged update did not preserve running stack")
        require(self.processes() == before_processes, "Unchanged update restarted a process")
        require((self.root / "state/heads.tsv").read_text() == before_heads, "Unchanged update rewrote heads")
        require({p.name: (p.stat().st_size, digest(p)) for p in (self.root / "logs").glob("install*.log")} == before_installer, "Unchanged update invoked the installer")
        self.note("completion-06-moved-pin-update", "Not exercised in the real run: resolved branch heads did not move. Both Agent/Runtime refusal injections remain executed in release.test.mjs on this hosted Mac.")
        tracked = self.root / "editor/README.md"
        original = tracked.read_bytes()
        tracked.write_bytes(original + b"\nPlan 61 dirty-editor refusal probe.\n")
        try:
            dirty = digest(tracked)
            dirty_before = self.processes()
            refused = self.run("completion-07-tracked-editor-change", ["bash", self.tool, "update", BRANCH], expected="nonzero")
            require("has changes; not overwriting" in refused.stdout, "Dirty editor was not refused by name")
            require(digest(tracked) == dirty and self.processes() == dirty_before, "Refusal changed tracked bytes or running processes")
        finally:
            tracked.write_bytes(original)

    def negatives(self):
        typo = "release/14/p61-mistyped-" + uuid.uuid4().hex
        typo_root = self.runner_home / "astrid-release" / typo.replace("/", "-")
        refused = self.run("negative-mistyped-branch", ["bash", self.tool, typo], expected="nonzero")
        require("typo?" in refused.stdout and not typo_root.exists(), "Mistyped branch touched a release root")
        shim = self.proof / "non-mac-probe"
        shim.mkdir(exist_ok=True)
        (shim / "uname").write_text("#!/bin/sh\necho Linux\n")
        (shim / "uname").chmod(0o700)
        env = dict(os.environ)
        env["PATH"] = str(shim) + os.pathsep + env["PATH"]
        refused = self.run("negative-non-Mac-platform-probe", ["bash", self.tool, BRANCH], env=env, expected="nonzero")
        require("macOS only" in refused.stdout, "Non-Mac platform was not refused by name")
        self.note("negative platform scope", "Only uname is doubled on the hosted Mac; this is the actual entry point's non-Mac refusal, not a Linux stack run.")
        self.stop("completion-09-stop-before-negative-attach")
        version, python = self.installed()
        realm_id = self.context["live_realm_id"]
        realm = self.root / "data/runtime/realms" / realm_id
        before = db_facts(realm)
        refused = self.run("negative-real-wrong-realm-id", [python, "-I", "-m", "astrid_runtime", "workspace", "attach",
                           "--data-root", self.proof / "wrong-id-data", "--realm-root", realm,
                           "--realm-id", "99999999-9999-4999-8999-999999999999", "--source-manifest", version / "profile.json", "--json"],
                           env=self.isolated_env(), expected="nonzero")
        require("workspace identity mismatch" in refused.stdout, "Wrong realm identity was not refused by name")
        require(db_facts(realm) == before, "Wrong-ID attach changed the copied realm")
        require(not (self.proof / "wrong-id-data/runtime/catalog.json").exists(), "Wrong-ID attach published a catalog")
        # Alter only a disposable APFS clone, outside the uploaded evidence directory.
        schema_root = self.proof.with_name(self.proof.name + "-schema-negative")
        schema_root.mkdir()
        schema_realm = schema_root / realm_id
        self.run("negative-schema-clone", ["cp", "-c", "-R", realm, schema_realm])
        with sqlite3.connect(schema_realm / "realm.sqlite3") as connection:
            connection.execute("UPDATE runtime_schema SET version=999999 WHERE id=1")
        schema_before = db_facts(schema_realm)
        schema_hash = digest(schema_realm / "realm.sqlite3")
        # Exercise the same installed-Python caller used by astrid-release. It
        # retains Runtime's refusal and appends the real read-only doctor report.
        refused = self.run("negative-real-schema-refusal", [python, "-X", "utf8", "-I",
                           self.tool.with_name("workspace-attach.py"), "workspace", "attach",
                           "--data-root", schema_root / "selection", "--realm-root", schema_realm,
                           "--realm-id", realm_id, "--source-manifest", version / "profile.json", "--json"],
                           env=self.isolated_env(), expected=1)
        self.note("negative-real-schema-before-and-after", {
            "rejected_before": schema_before, "rejected_after": db_facts(schema_realm),
            "database_sha256_before": schema_hash, "database_sha256_after": digest(schema_realm / "realm.sqlite3"),
            "catalog_published": (schema_root / "selection/runtime/catalog.json").exists(),
            "normal_copy_before": before, "normal_copy_after": db_facts(realm),
        })
        require(db_facts(schema_realm) == schema_before, "Schema attach migrated the rejected copy")
        require(digest(schema_realm / "realm.sqlite3") == schema_hash, "Schema attach changed rejected database bytes")
        require(not (schema_root / "selection/runtime/catalog.json").exists(), "Schema refusal published a catalog")
        require(db_facts(realm) == before, "Schema probe changed the normal copied realm")
        require("schema" in refused.stdout.lower(), "Schema refusal did not identify its cause")
        diagnostic = next(json.loads(line.removeprefix("astrid-release: Runtime doctor: "))
                          for line in refused.stdout.splitlines()
                          if line.startswith("astrid-release: Runtime doctor: "))
        require(diagnostic["realm_root"] == str(schema_realm), "Doctor did not inspect the rejected realm")
        schema_report = diagnostic["report"]["checks"]["schema"]
        require("schema" in diagnostic["report"]["issues"] and schema_report["ok"] is False,
                "Doctor did not report the schema refusal")
        require(schema_report["actual_version"] == 999999 and schema_report["expected_version"] == before["schema"]["version"],
                "Doctor did not report the actual and expected schema versions")
        self.note("negative-real-schema-no-migration", {"schema": schema_before["schema"], "database_sha256_before_and_after": schema_hash})
        self.note("negative unreadable source", "The separate named native fixture reaches the actual mode=ro failure with a valid, stopped destination and retains its unchanged catalog.")

    def collect_stack(self, label):
        for data in [self.root / "data", Path(self.context.get("live_data", "/nonexistent-p61-live"))]:
            try:
                self.token(data)
            except (OSError, ValueError, KeyError):
                pass
        target = self.proof / label
        target.mkdir(exist_ok=True)
        for directory in [self.root / "logs", self.root / "home/Library/Logs/Astrid Runtime"]:
            if not directory.exists():
                continue
            for path in directory.iterdir():
                if path.is_file() and path.suffix in {".log", ".txt"}:
                    name = ("release-" if directory.name == "logs" else "runtime-") + path.name
                    (target / name).write_text(self.clean(path.read_text(errors="replace")))
        for name in ["workspace-inspect.json", "ports", "heads.tsv", "realm-id", "install-manifest.json"]:
            source = self.root / "state" / name
            if source.exists():
                shutil.copyfile(source, target / name)
        attempts = sorted((target).glob("release-start-attempt-*.log"))
        self.note(label + " first-start retry observation", {
            "failed_attempts": len(attempts), "guard_message_seen": any(KNOWN_START_ERROR in p.read_text() for p in attempts),
            "tails": [str(p.relative_to(self.proof)) for p in attempts],
            "cause": "Not inferred from message alone; no trace-based cause claim."})

    def fresh_repeats(self):
        # Two more entirely fresh program/data roots, with real tool installs and real copies.
        for ordinal in [2, 3]:
            self.collect_stack(f"fresh-{ordinal - 1}-logs")
            self.keep_and_remove(f"fresh-{ordinal - 1}")
            self.disk(f"before-fresh-{ordinal}-disk")
            require(shutil.disk_usage(self.runner_home).free >= 5 * 1024 ** 3, "Fresh-clone prerequisite: less than 5 GiB free")
            if ordinal == 3:
                fresh_checkout = self.proof.with_name(self.proof.name + "-fresh-tool-checkout")
                self.run("completion-11-fresh-clone", ["git", "clone", "--depth", "1", "--single-branch", "--branch", BRANCH,
                         "https://github.com/banodoco/astrid-app.git", fresh_checkout])
                sha = self.run("completion-11-fresh-clone-identity", ["git", "-C", fresh_checkout, "rev-parse", "HEAD"]).stdout.strip()
                self.note("completion-11-integration boundary", "Fresh clone at " + sha + "; RB-7 landing is the Lead's later task. This proves the current plan-branch entry point, not an unperformed landing.")
                tool = fresh_checkout / "scripts/astrid-release/astrid-release"
            else:
                tool = self.tool
            result = self.start(f"fresh-first-start-{ordinal}", tool=tool)
            require(read_json(self.proof / f"fresh-first-start-{ordinal}-attach.json")["status"] == "configured_attach", "Fresh repeat did not perform real attach")
            require(self.timeline(self.root / "data")["head_publication_id"] == self.context["seed_head"]["head_publication_id"], "Fresh repeat did not copy the unchanged live head")
            self.browser(f"fresh-first-start-{ordinal}-playback", "play")
            self.stop(f"fresh-first-start-{ordinal}-stop")
            self.collect_stack(f"fresh-{ordinal}-logs")
            self.control(f"live-after-fresh-{ordinal}")

    def final(self):
        if not (self.proof / "live-before.json").exists():
            self.note("live-after comparison", "NO-RESULT: live-before was not reached; no complete-run live preservation claim")
            self.disk("final-disk")
            return
        after = self.control("live-after")
        before = read_json(self.proof / "live-before.json")
        require(after == before, "LIVE CONTROL CHANGED: inspect exact before/after facts")
        self.note("completion-10-live-unchanged", "PASS: every CAS/config/install/plist/manifest hash, PID/start time, launchd state, head publication, history count and runtime epoch matches.")
        self.collect_stack("final-stack-logs")
        self.disk("final-disk")

    def diagnostics(self):
        self.collect_stack("failure-stack-logs")
        live_logs = self.runner_home / "Library/Logs/Astrid Runtime"
        for name in ["install.log", "runtime-service.log", "runtime.log"]:
            path = live_logs / name
            if path.exists():
                # Retain tails, never the credential/configuration files alongside them.
                (self.proof / ("live-" + name)).write_text(self.clean("\n".join(path.read_text(errors="replace").splitlines()[-300:])))
        self.disk("diagnostic-disk")

    def cleanup(self):
        if self.root.exists():
            self.stop("final-owned-stack-stop")
        else:
            self.note("final-owned-stack-stop", "Release root was not created; no owned stack to stop.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=["bootstrap", "seed", "half-built", "fresh", "restart-edit", "updates", "negatives", "fresh-repeats", "final", "diagnostics", "cleanup"])
    args = parser.parse_args()
    proof = Proof()
    try:
        getattr(proof, args.phase.replace("-", "_"))()
    except Exception as error:
        proof.note(args.phase + " FAIL", f"{type(error).__name__}: {error}")
        raise


if __name__ == "__main__":
    main()
