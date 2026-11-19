"""Exercise completion with the actual Node runner, then replay damaged events."""
from __future__ import annotations
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("ceiling_adapters", HERE / "ceiling_adapters.py")
adapters = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapters)


class NodeCompletionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.root = Path(os.environ.get("CEILING_NODE_PROOF", cls.temporary.name)).resolve()
        cls.root.mkdir(parents=True, exist_ok=True)
        cls.node = shutil.which("node")
        if cls.node is None:
            raise RuntimeError("Node is required for native completion proof")
        cls.version = subprocess.check_output([cls.node, "--version"], text=True).strip()
        (cls.root / "node-version.txt").write_text(cls.version + "\n")
        (cls.root / "fixture.test.mjs").write_text("""import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
test('passes', () => assert.equal(1, 1));
test('conditional failure', () => assert.equal(process.env.NATIVE_FAILURE, '0'));
describe('suite identity', () => { test('nested identity', () => assert.equal(2, 2)); });
test('skip identity', { skip: 'fixture-only skip' }, () => {});
test('todo identity', { todo: 'fixture-only todo' }, () => {});
""")
        observer = (HERE / "ceiling_node.mjs").as_uri()
        (cls.root / "reporter.mjs").write_text("""import { appendFileSync } from 'node:fs';
import { observeNodeEvents } from %s;
export default async function* reporter(source) {
  async function* record() {
    for await (const event of source) {
      appendFileSync(process.env.NATIVE_EVENTS, JSON.stringify(event, (_key, value) =>
        value instanceof Error ? Object.fromEntries(Object.getOwnPropertyNames(value).map(key => [key, value[key]])) : value) + '\\n');
      yield event;
    }
  }
  for await (const event of observeNodeEvents(record())) { /* Leave native outcomes alone. */ }
}
""" % json.dumps(observer))
        (cls.root / "replay.mjs").write_text("""import { readFileSync } from 'node:fs';
import { observeNodeEvents } from %s;
async function* source() { for (const event of JSON.parse(readFileSync(process.argv[2], 'utf8'))) yield event; }
for await (const event of observeNodeEvents(source())) { /* Replay only recorded events. */ }
""" % json.dumps(observer))
        cls.runs = {}
        for name, failing in (("passing", "0"), ("failing", "1")):
            directory = cls.root / name
            directory.mkdir()
            env = {**os.environ, "CEILING_STEP_DIR": str(directory), "NATIVE_FAILURE": failing,
                   "NATIVE_EVENTS": str(directory / "events.jsonl")}
            env.pop("CEILING_REPORTER_ACTIVE", None)
            command = [cls.node, "--test", "--test-reporter=spec", "--test-reporter-destination=stdout",
                       "--test-reporter=./reporter.mjs", "--test-reporter-destination=stdout", "fixture.test.mjs"]
            result = subprocess.run(command, cwd=cls.root, env=env, capture_output=True, text=True, timeout=30)
            (directory / "command.log").write_text(result.stdout + result.stderr)
            (directory / "command.json").write_text(json.dumps({"command": command, "raw_exit": result.returncode}) + "\n")
            cls.runs[name] = (directory, result.returncode)

    def suite(self, name):
        directory, raw_exit = self.runs[name]
        paths = list(directory.glob("node-*.jsonl"))
        self.assertEqual(len(paths), 1)
        suite = adapters.native_stream(paths[0], "Node/native", "native")
        self.assertEqual(suite["raw_exit"], raw_exit)
        adapters.core.verify_suite(suite, "Node/native")
        return suite

    def events(self):
        return [json.loads(line) for line in (self.runs["passing"][0] / "events.jsonl").read_text().splitlines()]

    def replay(self, name, events):
        directory = self.root / name
        directory.mkdir()
        source = directory / "events.json"
        source.write_text(json.dumps(events) + "\n")
        env = {**os.environ, "CEILING_STEP_DIR": str(directory)}
        env.pop("CEILING_REPORTER_ACTIVE", None)
        result = subprocess.run([self.node, "replay.mjs", str(source)], cwd=self.root, env=env,
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        return next(directory.glob("node-*.jsonl"))

    def verdict(self, suite):
        core, repository, head = adapters.core, "fixture/node-completion", "a" * 40
        check = {"workflow": "Node", "workflow_file": "fixture.yml", "job": "native", "kind": "tests"}
        checks = {"version": 1, "repository": repository, "merge": [check], "release": [check]}
        ledger = {"schema": 1, "repository": repository, "authority": "executed fixture only", "entries": [], "retired": []}
        tests = []
        for row in suite["tests"]:
            identity = {key: row.get(key) for key in ("lane", "native_id", "parameter", "subtest")}
            if row["outcome"] == "skipped":
                identity["allowed_omission"] = {"outcome": "skipped", "diagnostic": row["diagnostic"], "source": "fixture.test.mjs"}
            tests.append(identity)
        inventory = {"schema": 1, "repository": repository, "tests": tests, "reconciliation": [],
                     "tiers": {"merge": ["Node/native"], "release": ["Node/native"]}}
        policy = (checks, ledger, inventory)
        report = {"schema": 1, "repository": repository, "head": head, "tuple": {repository: head}, "tier": "merge", "complete": True,
                  "jobs": [{"workflow": "Node", "job": "native", "status": "completed", "conclusion": "failure" if suite["raw_exit"] else "success",
                            "head": head, "tuple": {repository: head}, "run_id": "local-native", "job_id": "local-native-job", "attempt": 1,
                            "unexplained_failed_steps": [], "suites": [suite]}]}
        return core.evaluate(policy, copy.deepcopy(policy), report, repository=repository, head=head, tier="merge", expected_tuple={repository: head})

    def test_actual_native_completion_preserves_all_identities_and_counts(self):
        suite = self.suite("passing")
        self.assertEqual(self.runs["passing"][1], 0)
        self.assertEqual(suite["summary_count"], 5)
        self.assertEqual([row["outcome"] for row in suite["tests"]].count("passed"), 3)
        self.assertEqual([row["outcome"] for row in suite["tests"]].count("skipped"), 2)
        self.assertTrue(any("nested identity" in row["native_id"] for row in suite["tests"]))
        self.assertEqual(self.verdict(suite)["verdict"], "PASS")

    def test_actual_native_failure_keeps_nonzero_exit_and_failing_verdict(self):
        suite = self.suite("failing")
        self.assertEqual(self.runs["failing"][1], 1)
        failures = [row for row in suite["tests"] if row["outcome"] == "failed"]
        self.assertEqual(len(failures), 1)
        self.assertIn("conditional failure", failures[0]["native_id"])
        self.assertIn("ERR_TEST_FAILURE: Expected values to be strictly equal", failures[0]["diagnostic"])
        verdict = self.verdict(suite)
        self.assertEqual(verdict["verdict"], "FAIL", verdict)
        self.assertTrue(any("new red" in error for error in verdict["errors"]), verdict)

    def test_stream_end_without_terminal_signal_is_incomplete(self):
        events = [event for event in self.events() if not (
            not event["data"].get("file") and (event["type"] == "test:summary" or
            event["type"] == "test:diagnostic" and event["data"].get("message", "").startswith("duration_ms ")))]
        path = self.replay("missing-terminal", events)
        with self.assertRaisesRegex(adapters.core.InvalidEvidence, "missing start/finish"):
            adapters.native_stream(path, "Node/native", "native")

    def test_native_count_mismatch_is_rejected(self):
        events = self.events()
        for event in events:
            data = event["data"]
            if data.get("file"):
                continue
            if event["type"] == "test:summary":
                data["counts"]["tests"] += 1
            elif event["type"] == "test:diagnostic" and data.get("message", "").startswith("tests "):
                data["message"] = "tests 6"
        path = self.replay("count-mismatch", events)
        with self.assertRaises(adapters.core.InvalidEvidence):
            adapters.native_stream(path, "Node/native", "native")

    def test_truncated_recorder_output_is_rejected(self):
        directory, _ = self.runs["passing"]
        source = next(directory.glob("node-*.jsonl"))
        path = self.root / "truncated.jsonl"
        path.write_bytes(source.read_bytes()[:-1])
        with self.assertRaisesRegex(adapters.core.InvalidEvidence, "truncated stream"):
            adapters.native_stream(path, "Node/native", "native")


if __name__ == "__main__":
    unittest.main()
