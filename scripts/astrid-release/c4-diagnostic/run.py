#!/usr/bin/env python3
"""C4 observation on the recorded failing tuple, only on a hosted Mac.

Reuse the frozen harness's setup, assertions, cleanup and live-control methods.
This separate entry point authorizes only its own diagnostic workflow branch;
it never alters GITHUB_REF or edits the frozen harness/tool/product checkout.
"""
from __future__ import annotations

import argparse
import importlib.util
import os
from pathlib import Path
import subprocess
import sys

sys.dont_write_bytecode = True
DIAGNOSTIC_REPO = Path(__file__).resolve().parents[3]
HARNESS_SHA = "3c99c7aa7f9a0079b5075351f6271239714c4bc4"
TOOL_SHA = "d72ee39ded70346e5b22d952fba985c8a137b622"
EDITOR_SHA = "67428177b24989e230537ffe363aaa45b60bbd63"
EDITOR_TREE = "d6f207b49763782ac9dbf9e3021e629fdb3285f5"
AGENT_SHA = "ae929cdae7460c36cfbfd95599019a4c45f42e1c"
RUNTIME_SHA = "2537fed24385ec1c24f48a812e09af4bb63fb794"
DIAGNOSTIC_REF = "refs/heads/p61/c4-input-diagnostic"
BRANCH = "release/14/plan-61"


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def git_at(directory, *args):
    return subprocess.check_output(["git", "-C", str(directory), *args], text=True).strip()


def clean_checkout(directory, expected):
    require(git_at(directory, "rev-parse", "HEAD") == expected, "Unexpected checkout: " + str(directory))
    require(not git_at(directory, "status", "--porcelain", "--untracked-files=no"),
            "Tracked checkout bytes changed: " + str(directory))


def load_harness():
    require(sys.platform == "darwin", "This diagnostic runs on macOS only")
    require(os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted", "A GitHub-hosted runner is required")
    require(os.environ.get("GITHUB_REPOSITORY") == "banodoco/astrid-app", "Unexpected repository")
    require(os.environ.get("GITHUB_REF") == DIAGNOSTIC_REF, "Dispatch only on p61/c4-input-diagnostic")
    expected = os.environ["P61_DIAGNOSTIC_SHA"]
    require(len(expected) == 40 and all(c in "0123456789abcdef" for c in expected), "Invalid diagnostic SHA")
    require(os.environ.get("GITHUB_SHA") == expected, "Workflow head differs from the submitted diagnostic SHA")
    clean_checkout(DIAGNOSTIC_REPO, expected)
    require(git_at(DIAGNOSTIC_REPO, "rev-parse", "HEAD^") == EDITOR_SHA,
            "Diagnostic must be the single submitted observer commit on the failing editor source")
    harness = Path(os.environ["P61_HARNESS_CHECKOUT"]).resolve()
    tool = Path(os.environ["P61_TOOL_CHECKOUT"]).resolve()
    workspace = Path(os.environ["GITHUB_WORKSPACE"]).resolve()
    require(harness.is_relative_to(workspace) and tool.is_relative_to(workspace), "Checkout outside workflow workspace")
    clean_checkout(harness, HARNESS_SHA)
    clean_checkout(tool, TOOL_SHA)
    sys.path.insert(0, str(harness / "scripts/astrid-release"))
    spec = importlib.util.spec_from_file_location("p61_frozen_hosted_proof", harness / "scripts/astrid-release/hosted-proof.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, harness, tool


def diagnostic_proof(module, harness, tool):
    class DiagnosticProof(module.Proof):
        def __init__(self):
            # The source Proof constructor is tied to p61/rb-6. This new
            # constructor retains its platform/repository/path safeguards
            # above and below, bound to this exact authorized diagnostic ref.
            os.umask(0o077)
            self.repo = harness
            self.proof = Path(os.environ["P61_PROOF"]).resolve()
            require(self.proof.is_relative_to(Path(os.environ["RUNNER_TEMP"]).resolve()),
                    "Evidence must be inside RUNNER_TEMP")
            self.proof.mkdir(exist_ok=True)
            self.runner_home = Path.home().resolve()
            self.root = self.runner_home / "astrid-release" / BRANCH.replace("/", "-")
            self.tool_repo = tool
            self.tool = tool / "scripts/astrid-release/astrid-release"
            self.context_file = self.proof / "context.json"
            self.context = module.read_json(self.context_file) if self.context_file.exists() else {}
            self.secrets = []
            module.write_json(self.proof / "diagnostic-identity.json", {
                "kind": "bounded C4 diagnostic; not certification",
                "diagnostic_sha": os.environ["P61_DIAGNOSTIC_SHA"],
                "workflow_ref": os.environ["GITHUB_REF"],
                "workflow_sha": os.environ["GITHUB_SHA"],
                "harness_sha": HARNESS_SHA, "tool_sha": TOOL_SHA,
                "expected_editor_sha": EDITOR_SHA, "expected_editor_tree": EDITOR_TREE,
                "expected_agent_sha": AGENT_SHA, "expected_runtime_sha": RUNTIME_SHA,
                "original_failing_run": "44557257081",
            })

        def check_source_refs(self, label):
            candidates = ["release/14/plan-61", "release/14/main", "main"]
            selected = {}
            for name in ["app", "agent"]:
                result = self.run(label + " " + name + " source refs", [
                    "git", "ls-remote", "--heads", "https://github.com/banodoco/astrid-" + name + ".git",
                    *["refs/heads/" + ref for ref in candidates],
                ])
                refs = {line.split()[1]: line.split()[0] for line in result.stdout.splitlines() if line.strip()}
                selected[name] = next(((ref, refs["refs/heads/" + ref]) for ref in candidates
                                       if "refs/heads/" + ref in refs), None)
            self.note(label + " recorded-source guard", selected)
            require(selected["app"] == (BRANCH, EDITOR_SHA),
                    "Recorded C4 App tuple moved; separate plan-61 sync is not diagnostic input")
            require(selected["agent"] == ("release/14/main", AGENT_SHA),
                    "Recorded C4 Agent tuple moved; refusing a different installed comparison")

        def verify_installed_tuple(self, label):
            heads = (self.root / "state/heads.tsv").read_text().strip()
            require(heads == BRANCH + " " + EDITOR_SHA + " release/14/main " + AGENT_SHA,
                    "Installed heads.tsv differs from the recorded failing tuple")
            clean_checkout(self.root / "editor", EDITOR_SHA)
            require(git_at(self.root / "editor", "rev-parse", "HEAD^{tree}") == EDITOR_TREE,
                    "Installed editor tree differs from the recorded failing editor")
            manifest = module.read_json(self.root / "state/install-manifest.json")
            version_root, _ = self.installed()
            installed_manifest = module.read_json(version_root / "manifest.json")
            for actual in [manifest, installed_manifest]:
                require(actual["agent"]["sha"] == AGENT_SHA and actual["runtime"]["sha"] == RUNTIME_SHA,
                        "Installed Agent/Runtime differs from the recorded failing tuple")
            self.note(label + " exact installed diagnostic tuple", {
                "heads": heads, "editor_tree": EDITOR_TREE,
                "state_manifest_sha256": module.digest(self.root / "state/install-manifest.json"),
                "installed_manifest_sha256": module.digest(version_root / "manifest.json"),
            })

        def start(self, label, *, tool=None):
            self.check_source_refs(label)
            result = super().start(label, tool=tool)
            self.verify_installed_tuple(label)
            return result

        def browser(self, label, mode):
            # Original browser invocation/420-second outer budget; the new
            # entry contains the byte-identical assertion/action body plus
            # passive observers and its explicit diagnostic-branch guard.
            self.verify_installed_tuple(label)
            env = dict(os.environ)
            env["PLAYWRIGHT_BROWSERS_PATH"] = str(self.proof.with_name(self.proof.name + "-browsers"))
            if mode == "edit":
                self.observe_candidate("diagnostic-c4-before-browser")
            try:
                self.run(label, ["node", DIAGNOSTIC_REPO / "scripts/astrid-release/c4-diagnostic/browser.mjs",
                                str(self.root), str(self.proof), mode], env=env, timeout=420)
            finally:
                if mode == "edit":
                    self.observe_candidate("diagnostic-c4-after-browser")

        def observe_candidate(self, label):
            # Read-only snapshots bracket the browser process, never the input
            # actions. Reuse the frozen census collector without running C5's
            # update command or asserting C5 preservation. Retain missing facts
            # explicitly; an observer failure cannot replace C4's original exit.
            try:
                self.c5_snapshot(label)
            except Exception as error:
                self.note(label + " observation unavailable", type(error).__name__ + ": " + str(error))

    return DiagnosticProof()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=["bootstrap", "seed", "half-built", "fresh", "restart-edit",
                                         "diagnostics", "cleanup", "final"])
    args = parser.parse_args()
    module, harness, tool = load_harness()
    proof = diagnostic_proof(module, harness, tool)
    try:
        if args.phase in ["bootstrap", "half-built"]:
            proof.check_source_refs(args.phase)
        getattr(proof, args.phase.replace("-", "_"))()
    except Exception as error:
        proof.note(args.phase + " DIAGNOSTIC FAIL", type(error).__name__ + ": " + str(error))
        raise


if __name__ == "__main__":
    main()
