import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("vitest_results", Path(__file__).with_name("check-vitest-results.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class VitestResultsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.xml = self.root / "vitest-app.xml"
        self.stream = Path(str(self.xml) + ".jsonl")
        self.test = {"id": "one", "file": "src/a.test.ts", "name": "suite > case"}
        self.records = [
            {"event": "start", "modules": ["src/a.test.ts"]},
            {"event": "collected", "file": "src/a.test.ts", "tests": [self.test]},
            {"event": "result", **self.test, "state": "passed"},
            {"event": "end", "tests": 1, "pending": 0},
        ]
        self.xml.write_text('<testsuites tests="1" failures="0"><testsuite tests="1" failures="0"><testcase classname="src/a.test.ts" name="suite &gt; case"/></testsuite></testsuites>')
        self.xml.with_suffix(".log").write_text(" Tests  1 passed (1)\n")
        self.write_stream()

    def write_stream(self):
        self.stream.write_text("".join(json.dumps(record) + "\n" for record in self.records))

    def problems(self):
        return "\n".join(MODULE.check_result(self.xml)["problems"])

    def test_accepts_actual_cases_matching_summary_and_stream(self):
        self.assertEqual(self.problems(), "")

    def test_rejects_inflated_root_header(self):
        self.xml.write_text(self.xml.read_text().replace('tests="1"', 'tests="99"', 1))
        self.assertIn("header tests=99, actual 1", self.problems())

    def test_rejects_inflated_suite_header(self):
        self.xml.write_text(self.xml.read_text().replace('<testsuite tests="1"', '<testsuite tests="99"'))
        self.assertIn("header tests=99, actual 1", self.problems())

    def test_rejects_empty_xml_even_when_header_claims_tests(self):
        self.xml.write_text('<testsuite tests="99"/>')
        self.assertIn("zero actual testcase", self.problems())

    def test_rejects_empty_xml_with_zero_header(self):
        self.xml.write_text('<testsuite tests="0"/>')
        self.assertIn("zero actual testcase", self.problems())

    def test_rejects_summary_count_drift(self):
        self.xml.with_suffix(".log").write_text(" Tests  2 passed (2)\n")
        self.assertIn("runner summary=2, actual testcase elements=1", self.problems())

    def test_rejects_same_count_wrong_identity(self):
        self.records[2]["name"] = "a different test"
        self.write_stream()
        self.assertIn("differ by test identity/outcome", self.problems())

    def test_rejects_missing_and_duplicate_finished_ids(self):
        self.records.insert(3, self.records[2])
        self.write_stream()
        self.assertIn("duplicate test IDs", self.problems())

    def test_rejects_uncollected_selected_module(self):
        self.records[0]["modules"].append("src/missing.test.ts")
        self.write_stream()
        self.assertIn("selected/collected module mismatch", self.problems())

    def test_retains_partial_results_without_claiming_completion(self):
        self.records.pop()
        self.write_stream()
        self.assertIn("1 finished result(s) retained, no final end record", self.problems())

    def test_retains_complete_prefix_before_a_truncated_record(self):
        self.records.pop()
        self.write_stream()
        with self.stream.open("a") as stream:
            stream.write('{"event":')
        result = MODULE.check_result(self.xml)
        self.assertEqual(result["finished"], 1)
        self.assertIn("partial or invalid stream record", "\n".join(result["problems"]))

    def test_reports_missing_expected_file(self):
        self.xml.unlink()
        self.assertIn("missing or invalid XML", self.problems())

    def test_accepts_complete_evidence_from_a_failed_test(self):
        self.xml.write_text('<testsuites tests="1" failures="1"><testsuite tests="1" failures="1"><testcase classname="src/a.test.ts" name="suite &gt; case"><failure message="bug"/></testcase></testsuite></testsuites>')
        self.xml.with_suffix(".log").write_text(" Tests  1 failed (1)\n")
        self.records[2]["state"] = "failed"
        self.write_stream()
        self.assertEqual(self.problems(), "")

    def test_accepts_junit_control_character_encoding_without_changing_raw_identity(self):
        raw = 'suite > a\tb\nc\rd\r\ne\x00f\x7fg&"<>'
        self.test["name"] = raw
        self.records[2]["name"] = raw
        self.xml.write_text('<testsuite tests="1"><testcase classname="src/a.test.ts" name="suite &gt; a\tb\nc\rd\r\nefg&amp;&quot;&lt;&gt;"/></testsuite>')
        self.write_stream()
        self.assertEqual(self.problems(), "")
        self.assertEqual(json.loads(self.stream.read_text().splitlines()[2])["name"], raw)

    def test_rejects_raw_identity_change_even_if_junit_encoding_would_hide_it(self):
        self.test["name"] = "suite > ca\x00se"
        self.write_stream()
        self.assertIn("collected/finished raw identity mismatch", self.problems())

    def test_reads_jsonl_with_unicode_line_separators_inside_names(self):
        raw = "suite > case\u0085nel\u2028line\u2029paragraph"
        self.test["name"] = raw
        self.records[2]["name"] = raw
        self.xml.write_text(self.xml.read_text().replace('name="suite &gt; case"', 'name="suite &gt; case\u0085nel\u2028line\u2029paragraph"'))
        self.stream.write_text("".join(json.dumps(record, ensure_ascii=False) + "\n" for record in self.records))
        self.assertEqual(self.problems(), "")


if __name__ == "__main__":
    unittest.main()
