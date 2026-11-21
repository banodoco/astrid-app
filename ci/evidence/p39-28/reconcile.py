"""Replay retained native evidence and propose only independently witnessed PASS rows.

This is an offline evidence generator, not a CI evaluator or migration policy.
The evaluator/collector/adapters are exported unchanged from BASE. Download and
extract the two official verdict archives to INPUTS/original and INPUTS/sync;
retain original.zip, sync.zip and jobs-RUN.json alongside those directories.
"""
from __future__ import annotations

import argparse
import copy
from collections import Counter
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile

BASE = "da6e7cc8f8ed33b22e4710b161ba2d4995bd0ea1"
SEAL = "0700e981be5dfbfc229784b8ade69869f62716dd"
REPO = "banodoco/astrid-app"
POLICY = ("ci/required-checks.json", "ci/failure-ceiling.json", "ci/test-inventory.json.gz")
CODE = ("scripts/ci/failure_ceiling.py", "scripts/ci/ceiling_adapters.py", "scripts/ci/ceiling_hosted.py")
ARCHIVES = {
    "original": "5cdc949cb7bd6b6027183f22588ecbf05d40a7d059e9d2c27be932d97a261e45",
    "sync": "fb99edbc9e7270fae18e4bd29a7bab48015aa552fd280d24b56d7ad0c986f4f1",
}


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def load(path):
    raw = path.read_bytes()
    return json.loads(gzip.decompress(raw) if path.suffix == ".gz" else raw)


def save(path, value):
    raw = (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(gzip.compress(raw, mtime=0) if path.suffix == ".gz" else raw)


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args])


def imported(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def projection(row):
    result = {key: row.get(key) for key in ("lane", "native_id", "parameter", "subtest")}
    if "source" in row:
        result["source"] = row["source"]
    return result


def policy_files(root, policy):
    for path, data in zip(POLICY, policy):
        save(root / path, data)


def flattened(gate, report):
    return gate.index_unique([row for job in report["jobs"] for suite in job["suites"]
                              for row in suite["tests"]], gate.identity, "report rows")


def drop(gate, report, key):
    result = copy.deepcopy(report)
    for job in result["jobs"]:
        for suite in job["suites"]:
            found = [row for row in suite["tests"] if gate.identity(row) == key]
            if found:
                assert len(found) == 1 and found[0]["outcome"] == "passed"
                suite["tests"] = [row for row in suite["tests"] if gate.identity(row) != key]
                suite["collected"].remove(found[0]["native_id"])
                suite["summary_count"] -= 1
                gate.verify_suite(suite, suite["lane"])
                return result
    raise AssertionError("control identity absent")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--write-inventory", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[3]
    output = args.output.resolve()
    inputs = args.inputs.resolve()
    with tempfile.TemporaryDirectory(prefix="p39-28-replay-") as tmp:
        temp = Path(tmp)
        trusted_root = temp / "trusted"
        protected = {}
        for path in POLICY + CODE:
            raw = git(root, "show", f"{BASE}:{path}")
            assert raw == git(root, "show", f"{SEAL}:{path}")
            if path != "ci/test-inventory.json.gz":
                assert raw == (root / path).read_bytes()
            target = trusted_root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
            protected[path] = sha(raw)
        gate = imported(trusted_root / CODE[0], "p39_28_trusted_gate")
        hosted = imported(trusted_root / CODE[2], "p39_28_trusted_hosted")
        trusted = gate.load_policy(trusted_root, REPO)
        sealed = gate.index_unique(trusted[2]["tests"], gate.identity, "sealed rows")
        reports, maps, sources, jobs_receipts = {}, {}, {}, {}
        for label, expected_archive in ARCHIVES.items():
            archive = inputs / f"{label}.zip"
            assert sha(archive.read_bytes()) == expected_archive
            directory = inputs / label
            report = load(directory / "observed.json")
            assert report == load(output / f"{label}-observed.json.gz")
            assert load(directory / "verdict.json") == load(output / f"{label}-verdict.json.gz")
            run = load(next(directory.glob("run-*.json")))
            assert run["status"] == "completed" and run["conclusion"] in ("success", "failure")
            assert run["head_sha"] == report["head"]
            raw_jobs_path = inputs / f"jobs-{run['id']}.json"
            raw_jobs = load(raw_jobs_path)["jobs"]
            jobs_receipts[label] = {"run": run["id"], "response_sha256": sha(raw_jobs_path.read_bytes()),
                                    "jobs": raw_jobs}
            for commit, tree in load(directory / "execution-trees.json").items():
                assert git(root, "rev-parse", commit + "^{tree}").decode().strip() == tree
            archives = sorted(directory.glob("artifact-*"))
            for item in archives:
                provenance = load(item / "provenance.json")
                assert provenance["digest"] == "sha256:" + sha((item / "artifact.zip").read_bytes())
            suites, lane_receipts = [], {}
            for spec in trusted[0]["merge"]:
                raw = next(job for job in raw_jobs if job["name"] == spec["job"])
                normalized = hosted.normalized_job(spec, raw, run, [p / "files" for p in archives],
                    REPO, report["head"], root, report["tuple"])
                expected = next(job for job in report["jobs"] if job["job"] == spec["job"])
                assert normalized == expected, (label, spec["job"], "native normalization changed")
                suites.append(normalized)
                for suite in normalized["suites"]:
                    gate.verify_suite(suite, suite["lane"])
                    candidates = []
                    for item in archives:
                        step = item / "files" / suite["name"]
                        if not step.exists():
                            continue
                        command = load(step / "command.json")
                        if command["job"] == spec["job_id"]:
                            candidates.append((item, step, command))
                    assert len(candidates) == 1
                    item, step, command = candidates[0]
                    streams = list(step.glob("*.jsonl"))
                    assert len(streams) == 1
                    stream = streams[0]
                    events = [json.loads(line) for line in stream.read_text().splitlines()]
                    native = {event["native_id"]: {"line": line, "event": event}
                              for line, event in enumerate(events, 1) if event.get("event") == "result"}
                    assert len(native) == len(suite["tests"])
                    provenance = load(item / "provenance.json")
                    lane_receipts[suite["lane"]] = {
                        "head": report["head"], "run_id": run["id"], "job_id": raw["id"],
                        "attempt": normalized["attempt"], "artifact_id": provenance["id"],
                        "artifact_sha256": provenance["digest"], "step": suite["name"],
                        "command": command, "command_json_sha256": sha((step / "command.json").read_bytes()),
                        "stream": str(stream.relative_to(item / "files")), "stream_sha256": sha(stream.read_bytes()),
                        "count": suite["summary_count"], "raw_exit": suite["raw_exit"],
                        "outcomes": dict(Counter(row["outcome"] for row in suite["tests"])),
                        "native": native,
                    }
            assert suites == report["jobs"]
            reports[label], maps[label], sources[label] = report, flattened(gate, report), lane_receipts
        assert maps["original"].keys() == maps["sync"].keys()
        unseeded = {key: row for key, row in maps["original"].items() if key not in sealed}
        additions = {key: projection(row) for key, row in unseeded.items() if row["outcome"] == "passed"}
        assert len(unseeded) == 850 and len(additions) == 824
        assert all(maps["original"][key] == maps["sync"][key] for key in additions)
        for key, row in unseeded.items():
            assert row["outcome"] in ("passed", "skipped")
            assert row == maps["sync"][key]
        candidate = copy.deepcopy(trusted)
        candidate[2]["tests"].extend(additions[key] for key in sorted(additions))
        assert candidate[2]["tests"][:len(sealed)] == trusted[2]["tests"]
        assert {k: v for k, v in candidate[2].items() if k != "tests"} == {
            k: v for k, v in trusted[2].items() if k != "tests"}
        candidate_root = temp / "candidate"
        policy_files(candidate_root, candidate)
        if args.write_inventory:
            (root / "ci/test-inventory.json.gz").write_bytes((candidate_root / "ci/test-inventory.json.gz").read_bytes())
        else:
            assert load(root / "ci/test-inventory.json.gz") == candidate[2]
        rows = []
        blob_cache = {}
        for key in sorted(additions):
            item = {"row": additions[key], "receipts": {}}
            source_file = additions[key].get("source", {}).get("file")
            if source_file is None:
                source_file = json.loads(key[1])[0]
            for label in reports:
                info = sources[label][key[0]]
                actual = maps[label][key]
                native = info["native"][key[1]]
                assert native["event"]["outcome"] == "passed" and native["event"]["finished"] is True
                assert native["event"].get("parameter") == actual["parameter"]
                assert native["event"].get("source") == actual.get("source")
                commit = info["command"]["head"]
                cache_key = (commit, source_file)
                if cache_key not in blob_cache:
                    blob_cache[cache_key] = {
                        "git_blob": git(root, "rev-parse", commit + ":" + source_file).decode().strip(),
                        "sha256": sha(git(root, "show", commit + ":" + source_file)),
                    }
                item["receipts"][label] = {
                    "lane": key[0], "native_record_line": native["line"], "outcome": actual["outcome"],
                    "stage": actual["stage"], "diagnostic": actual["diagnostic"],
                    "source_file": source_file, "execution_head": commit, **blob_cache[cache_key],
                }
            rows.append(item)
        native_receipts = {label: {lane: {k: v for k, v in info.items() if k != "native"}
                                  for lane, info in values.items()} for label, values in sources.items()}
        save(output / "passing-additions.json.gz", {"schema": 1, "base": BASE,
             "scope": "824 PASS additions only; no historical identity or skip dispositions", "rows": rows,
             "native_receipts": native_receipts})
        save(output / "job-metadata.json.gz", jobs_receipts)
        replays, unreached = {}, {}

        def cli(label, policy_root, report, trust_root=trusted_root):
            report_file, tuple_file = temp / (label + "-observed.json"), temp / (label + "-tuple.json")
            save(report_file, report)
            save(tuple_file, report["tuple"])
            verdict_path = temp / (label + "-verdict.json")
            command = [sys.executable, "-I", str(trust_root / CODE[0]), "--candidate", str(policy_root),
                       "--report", str(report_file), "--repository", REPO, "--head", report["head"],
                       "--tier", "merge", "--tuple", str(tuple_file), "--output", str(verdict_path)]
            process = subprocess.run(command, capture_output=True, text=True, check=False)
            assert process.returncode in (0, 1, 2), process.stderr
            verdict = load(verdict_path)
            assert json.loads(process.stdout) == verdict
            save(output / (label + ".json.gz"), verdict)
            replays[label] = {"process_exit": process.returncode, "verdict": verdict["verdict"],
                              "errors": len(verdict["errors"]), "unknown": verdict["unknown"],
                              "last_error": verdict["errors"][-1] if verdict["errors"] else None,
                              "lost_ids": [x for x in verdict["errors"] if x.startswith("lost ID:")],
                              "command": [part.replace(str(temp), "<replay>") for part in command],
                              "stderr": process.stderr}
            return verdict

        for label, report in reports.items():
            before = cli(label + "-before", trusted_root, report)
            official = load(output / (label + "-verdict.json.gz"))
            assert {k: v for k, v in before.items() if k != "errors"} == {
                k: v for k, v in official.items() if k != "errors"}
            assert Counter(before["errors"]) == Counter(official["errors"])
            after = cli(label + "-candidate", candidate_root, report)
            assert len(before["errors"]) == 855 and len(after["errors"]) == 31
            assert before["errors"][-1] == after["errors"][-1]
            assert len(replays[label + "-candidate"]["lost_ids"]) == 4
            ordered = list(maps[label].values())
            mismatches = [(index, row) for index, row in enumerate(ordered)
                          if "source" in sealed.get(gate.identity(row), {})
                          and row.get("source") != sealed[gate.identity(row)]["source"]]
            assert len(mismatches) == 15 and mismatches[0][1]["native_id"] == "2003482884_0_73"
            first = mismatches[0][0]
            unreached[label] = {
                "first_binding_identity": projection(mismatches[0][1]), "zero_based_index": first,
                "outcomes_before_refusal": dict(Counter(row["outcome"] for row in ordered[:first])),
                "outcomes_after_refusal": dict(Counter(row["outcome"] for row in ordered[first + 1:])),
                "later_binding_mismatches": [projection(row) for _, row in mismatches[1:]],
                "unreached_checks": ["Remaining per-ID source checks", "Later failure/retirement and skip-allowance checks",
                                      "Final removed-entry execution/pass validation", "Historical reconciliation loop"],
            }

        controls = {}
        report = reports["sync"]
        for lane in sorted({key[0] for key in additions}):
            key = next(key for key in sorted(additions) if key[0] == lane)
            modified = drop(gate, report, key)
            label = "admission-loss-" + lane.replace("/", "-")
            verdict = cli(label, candidate_root, modified)
            assert any("new inventory ID lacks a passing receipt" in error for error in verdict["errors"])
            controls[label] = {"kind": "synthetic input only", "identity": list(key),
                               "expected": "missing proposed PASS refused", "detected": True}

        # Examine future loss checking without changing any production policy.
        prospective = temp / "prospective-trusted"
        policy_files(prospective, candidate)
        for path in CODE:
            target = prospective / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((trusted_root / path).read_bytes())
        for lane in sorted({key[0] for key in additions}):
            key = next(key for key in sorted(additions) if key[0] == lane)
            label = "prospective-loss-" + lane.replace("/", "-")
            verdict = cli(label, candidate_root, drop(gate, report, key), prospective)
            expected_error = "lost ID: " + gate.key_text(key)
            detected = expected_error in verdict["errors"]
            assert detected == (lane in trusted[2]["tiers"]["merge"])
            controls[label] = {"kind": "synthetic prospective base, not a qualifying run",
                               "identity": list(key), "per_id_loss_detected": detected,
                               "interpretation": "Only App is in the sealed merge loss-check lanes; all verdicts still FAIL."}
        skipped = next(key for key, row in unseeded.items() if row["outcome"] == "skipped")
        invalid = copy.deepcopy(candidate)
        invalid[2]["tests"].append(projection(unseeded[skipped]))
        invalid_root = temp / "unapproved-skip"
        policy_files(invalid_root, invalid)
        for label, report in reports.items():
            result = cli(label + "-skip-addition-refused", invalid_root, report)
            assert any("new inventory ID lacks a passing receipt" in error for error in result["errors"])
        controls["skip_addition"] = {"kind": "synthetic input only", "identity": list(skipped),
                                      "detected_on_both_observations": True}

        changes = []
        for key, old in maps["original"].items():
            new = maps["sync"][key]
            if old != new:
                changes.append({"identity": list(key), "original": old, "sync": new})
        assert Counter((x["original"]["outcome"], x["sync"]["outcome"]) for x in changes) == {
            ("failed", "passed"): 10, ("passed", "passed"): 1}
        save(output / "observed-differences.json.gz", changes)
        summary = {
            "schema": 1, "base": BASE, "seal": SEAL, "protected_sha256": protected,
            "candidate_inventory_sha256": sha((candidate_root / "ci/test-inventory.json.gz").read_bytes()),
            "seed_rows": len(sealed), "candidate_rows": len(candidate[2]["tests"]),
            "passing_additions": len(additions), "additions_by_lane": dict(Counter(k[0] for k in additions)),
            "held_skips": 26, "all_native_suites_reproduced_from_unchanged_collector": True,
            "full_added_rows_identical_across_original_and_sync": True,
            "all_protected_rows_and_inventory_metadata_unchanged": True,
            "jobs": native_receipts,
            "required_commands": {spec["job"]: [c.get("lane") for c in spec["commands"] if c["kind"] == "tests"]
                                  for spec in trusted[0]["merge"]},
            "per_id_loss_lanes": trusted[2]["tiers"], "reconciliation": trusted[2]["reconciliation"],
            "replays": replays, "controls": controls, "first_refusal_and_unreached": unreached,
            "limits": ["Replays preserve original observation heads and tuples; they are not executions at the packet head.",
                       "First source-binding exception prevents remaining bindings, later outcomes, skip allowances and final reconciliation checks from completing.",
                       "Four Node lanes are required commands but absent from both per-ID loss tier lists; preserve and submit for trusted policy disposition.",
                       "The 26 Linux skip identities cannot be admitted using Darwin lane PASS receipts.",
                       "Four missing identities, all fifteen source-binding differences and all original failure records remain protected."]}
        save(output / "reconciliation.json", summary)
        print(json.dumps({k: summary[k] for k in ("seed_rows", "candidate_rows", "passing_additions", "additions_by_lane", "held_skips", "candidate_inventory_sha256")}, indent=2))
        print("All four actual-observation CLI replays are FAIL/raw1: 855 before, 31 with the candidate additions.")


if __name__ == "__main__":
    main()
