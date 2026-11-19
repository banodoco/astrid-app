#!/usr/bin/env python3
"""C5 identity invariants on representative macOS records, not a stack proof."""
from copy import deepcopy
import os
from pathlib import Path
import subprocess
import sys
import unittest

from hosted_processes import compare_censuses, parse_ps, service_census

ROOT = "/Users/runner/astrid-release/release-14-plan-61"
START = "Wed Nov 18 23:17:22 2026"
LATER = "Wed Nov 18 23:18:06 2026"
PACK = ROOT + "/program/versions/test/py/bin/python -X utf8 -m astrid.core.execution.generic_host --service --source-checkout " + ROOT + "/program/versions/test/agent --support-root " + ROOT + "/data/runtime"
CHAT = ROOT + "/program/versions/test/bun/bin/bun " + ROOT + "/program/versions/test/py/lib/astrid/chat/service.mjs"
MODEL = ROOT + "/program/versions/test/py/bin/astrid agent models --json"


def fixture():
    commands = [
        (100, 1, ROOT + "/program/versions/test/py/bin/python -c runtime-prelude"),
        (200, 1, "node " + ROOT + "/editor/scripts/dev-local-workspace.mjs --data-root " + ROOT + "/data"),
        (210, 200, "node scripts/runtime-discovery-proxy.mjs"),
        (220, 200, "npm run dev --host 127.0.0.1 --strictPort --logLevel warn"),
        (221, 220, "sh -c vite --config config/vite/vite.config.ts --host 127.0.0.1"),
        (222, 221, "node " + ROOT + "/editor/node_modules/.bin/vite --config config/vite/vite.config.ts"),
        (223, 222, ROOT + "/editor/node_modules/@esbuild/darwin-arm64/bin/esbuild --service=0.25.0 --ping"),
        (300, 100, PACK), (400, 100, CHAT), (401, 400, MODEL),
        (500, 1, "/Users/runner/.local/share/astrid/program/py/bin/python -c live-runtime"),
    ]
    text = "\n".join(f" {pid:5} {ppid:5} {START} {command}" for pid, ppid, command in commands)
    rows, unparsed = parse_ps(text)
    assert not unparsed
    return {
        "root": ROOT, "capture_errors": [], "processes": rows,
        "recorded_processes": f"runtime\t100\t{START}\neditor\t200\t{START}\n",
        "discovery": {"pid": 100, "runtime_instance_id": "candidate-instance"},
        "agent_host": {"pid": 300, "process_birth_id": "ps-lstart:" + START, "runtime_instance_id": "candidate-instance"},
        "agent_ready": {"pid": 300, "process_birth_id": "ps-lstart:" + START},
        "service_declarations": [{"name": "pack-host", "commands": [PACK]}, {"name": "chat", "commands": [CHAT]}],
        "launchd_entries": {"haus.astrid.runtime": {"pid": 500, "print_pid": 500, "state": "running"}},
        "candidate_launchd_plist": False,
        "database": {"runtime": {"runtime_epoch": 4, "boot_id": "candidate-boot", "previous_boot_id": "previous", "started_at": "2026-11-18T23:17:22Z"}},
    }


def observed(snapshot):
    result = deepcopy(snapshot)
    result["census"] = service_census(result)
    return result


def replacement(snapshot, old_pid, *, new_pid=None, start_time=None):
    new_pid = old_pid if new_pid is None else new_pid
    for row in snapshot["processes"]:
        if row["pid"] == old_pid:
            row["pid"] = new_pid
            row["start_time"] = start_time or row["start_time"]
        if row["ppid"] == old_pid:
            row["ppid"] = new_pid
    for key in ["discovery", "agent_host", "agent_ready"]:
        if snapshot[key]["pid"] == old_pid:
            snapshot[key]["pid"] = new_pid
    for job in snapshot["launchd_entries"].values():
        if job["pid"] == old_pid:
            job.update(pid=new_pid, print_pid=new_pid)
    for role in ["runtime", "editor"]:
        snapshot["recorded_processes"] = snapshot["recorded_processes"].replace(
            f"{role}\t{old_pid}\t{START}", f"{role}\t{new_pid}\t{start_time or START}")


class C5CensusTests(unittest.TestCase):
    def assert_accepted(self, before, after):
        result = compare_censuses(observed(before), observed(after))
        self.assertTrue(result["unchanged"], result)
        return result

    def assert_rejected(self, before, after):
        self.assert_accepted(before, deepcopy(before))
        result = compare_censuses(observed(before), observed(after))
        self.assertFalse(result["unchanged"], result)
        return result

    def test_native_macos_ps_format_retains_current_pid_and_start(self):
        self.assertEqual(sys.platform, "darwin", "Run the C5 probes on the hosted macOS lane")
        raw = subprocess.check_output(["ps", "-ww", "-p", str(os.getpid()), "-o", "pid=,ppid=,lstart=,command="],
                                      text=True, env={**os.environ, "LC_ALL": "C"})
        rows, unparsed = parse_ps(raw)
        self.assertEqual(unparsed, [])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["pid"], os.getpid())
        self.assertEqual(rows[0]["ppid"], os.getppid())
        self.assertRegex(rows[0]["start_time"], r"^\w{3} \w{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$")

    def test_child_model_command_exit_is_retained_as_an_observation(self):
        before, after = fixture(), fixture()
        after["processes"] = [row for row in after["processes"] if row["pid"] != 401]
        # This is the old whole-list predicate's false rejection, not a claim
        # that the missing run-3 lists prove which child changed in that run.
        self.assertNotEqual(before["processes"], after["processes"])
        result = self.assert_accepted(before, after)
        self.assertFalse(result["other_processes_compared"])
        self.assertEqual(result["other_process_observations"]["before"], [before["processes"][9]])
        self.assertEqual(result["other_process_observations"]["after"], [])

    def test_child_command_replacement_does_not_replace_chat_service(self):
        before, after = fixture(), fixture()
        replacement(after, 401, new_pid=402, start_time=LATER)
        result = self.assert_accepted(before, after)
        self.assertNotEqual(result["other_process_observations"]["before"], result["other_process_observations"]["after"])

    def test_process_enumeration_order_is_not_service_identity(self):
        before, after = fixture(), fixture()
        after["processes"].reverse()
        self.assert_accepted(before, after)

    def test_relative_editor_commands_and_persistent_wrappers_are_included(self):
        census = observed(fixture())["census"]
        self.assertEqual(census["errors"], [])
        self.assertEqual([row["pid"] for row in census["services"]["editor"]], [200, 210, 220, 221, 222, 223])

    def test_matching_chat_command_under_another_parent_does_not_satisfy_service(self):
        before, after = fixture(), fixture()
        next(row for row in after["processes"] if row["pid"] == 400)["ppid"] = 500
        self.assert_rejected(before, after)

    def test_duplicate_chat_service_is_rejected(self):
        before, after = fixture(), fixture()
        duplicate = deepcopy(next(row for row in after["processes"] if row["pid"] == 400))
        duplicate["pid"] = 450
        after["processes"].append(duplicate)
        self.assert_rejected(before, after)

    def test_agent_host_registration_must_match_ready_identity(self):
        before, after = fixture(), fixture()
        after["agent_ready"]["process_birth_id"] = "different-birth"
        self.assert_rejected(before, after)

    def test_candidate_boot_change_is_rejected_even_with_equal_pid_and_start(self):
        before, after = fixture(), fixture()
        after["database"]["runtime"]["boot_id"] = "new-boot"
        self.assert_rejected(before, after)

    def test_new_launchd_entry_is_rejected(self):
        before, after = fixture(), fixture()
        after["launchd_entries"]["haus.astrid.extra"] = {"pid": None, "print_pid": None}
        self.assert_rejected(before, after)

    def test_candidate_launchd_plist_is_rejected(self):
        before, after = fixture(), fixture()
        after["candidate_launchd_plist"] = True
        self.assert_rejected(before, after)

    def test_failed_capture_cannot_pass_as_an_equal_empty_result(self):
        before, after = fixture(), fixture()
        before["capture_errors"] = after["capture_errors"] = ["candidate database unavailable"]
        self.assertFalse(compare_censuses(observed(before), observed(after))["unchanged"])


def identity_probe(pid, change):
    def test(self):
        before, after = fixture(), fixture()
        if change == "pid":
            replacement(after, pid, new_pid=pid + 1000)
        elif change == "start":
            replacement(after, pid, start_time=LATER)
        else:
            after["processes"] = [row for row in after["processes"] if row["pid"] != pid]
        self.assert_rejected(before, after)
        if change == "missing":
            self.assertFalse(compare_censuses(observed(after), observed(deepcopy(after)))["unchanged"])
    return test


for role, pid in [("runtime", 100), ("editor", 200), ("agent_host", 300), ("chat", 400), ("launchd", 500)]:
    for change in ["pid", "start", "missing"]:
        setattr(C5CensusTests, f"test_{role}_{change}_is_rejected", identity_probe(pid, change))
for role, pid in [("editor_proxy", 210), ("editor_vite", 222), ("editor_esbuild", 223)]:
    setattr(C5CensusTests, f"test_{role}_replacement_is_rejected", identity_probe(pid, "pid"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
