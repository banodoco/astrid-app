#!/usr/bin/env python3
"""Verify actual Vitest testcase elements, the runner summary and incremental records."""
from __future__ import annotations

import argparse
from collections import Counter
import json
import os
from pathlib import Path
import re
import sys
from xml.etree import ElementTree as ET

ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def xml_outcome(case: ET.Element) -> str:
    if case.find("failure") is not None or case.find("error") is not None:
        return "failed"
    return "skipped" if case.find("skipped") is not None else "passed"


def check_result(xml_file: Path, log_file: Path | None = None, stream_file: Path | None = None) -> dict:
    log_file = log_file or xml_file.with_suffix(".log")
    stream_file = stream_file or Path(str(xml_file) + ".jsonl")
    problems: list[str] = []
    cases: list[ET.Element] = []
    try:
        root = ET.parse(xml_file).getroot()
        cases = list(root.iter("testcase"))
        if not cases:
            problems.append("zero actual testcase elements")
        for suite in root.iter():
            if suite.tag not in ("testsuite", "testsuites"):
                continue
            descendants = list(suite.iter("testcase"))
            actual = {"tests": len(descendants), "failures": sum(c.find("failure") is not None for c in descendants),
                      "errors": sum(c.find("error") is not None for c in descendants),
                      "skipped": sum(c.find("skipped") is not None for c in descendants)}
            for field, count in actual.items():
                claim = suite.get(field)
                if claim is None and field != "tests":
                    continue
                try:
                    declared = int(claim) if claim is not None else -1
                except ValueError:
                    declared = -1
                if declared != count:
                    problems.append(f"{suite.tag} {suite.get('name', '')}: header {field}={claim}, actual {count}")
    except (OSError, ET.ParseError) as error:
        problems.append(f"missing or invalid XML: {error}")

    try:
        log = ANSI.sub("", log_file.read_text(encoding="utf-8"))
        summaries = re.findall(r"^\s*Tests\s+[^\n]*\((\d+)\)\s*$", log, re.MULTILINE)
        if not summaries:
            problems.append("runner log has no final Tests summary")
        elif int(summaries[-1]) != len(cases):
            problems.append(f"runner summary={summaries[-1]}, actual testcase elements={len(cases)}")
    except OSError as error:
        problems.append(f"missing runner log: {error}")

    records: list[dict] = []
    try:
        for line_number, line in enumerate(stream_file.read_text(encoding="utf-8").splitlines(), 1):
            try:
                record = json.loads(line)
                if not isinstance(record, dict):
                    raise ValueError("record is not an object")
                records.append(record)
            except (ValueError, TypeError) as error:
                problems.append(f"partial or invalid stream record at line {line_number}: {error}")
                break  # Retain the complete prefix for diagnosis; never certify it.
    except OSError as error:
        problems.append(f"missing incremental results: {error}")
    starts = [r for r in records if r.get("event") == "start"]
    ends = [r for r in records if r.get("event") == "end"]
    collected = [test for r in records if r.get("event") == "collected" for test in r.get("tests", [])]
    finished = [r for r in records if r.get("event") == "result"]
    if len(starts) != 1 or not records or records[0].get("event") != "start":
        problems.append("incremental results have no unique run start")
    elif Counter(starts[0].get("modules", [])) != Counter(r.get("file") for r in records if r.get("event") == "collected"):
        problems.append("selected/collected module mismatch")
    if len(ends) != 1 or not records or records[-1].get("event") != "end":
        problems.append(f"incomplete run: {len(finished)} finished result(s) retained, no final end record")
    elif ends[0].get("pending") != 0 or ends[0].get("tests") != len(finished):
        problems.append(f"stream end disagrees with {len(finished)} finished results or reports pending tests")
    for label, items in [("collected", collected), ("finished", finished)]:
        ids = [item.get("id") for item in items]
        if any(not isinstance(value, str) or not value for value in ids) or len(set(ids)) != len(ids):
            problems.append(f"{label} stream contains missing or duplicate test IDs")
    if Counter(item.get("id") for item in collected) != Counter(item.get("id") for item in finished):
        problems.append(f"collected/finished ID mismatch: {len(collected)} collected, {len(finished)} finished")
    if any(item.get("state") not in ("passed", "failed", "skipped") for item in finished):
        problems.append("stream contains unfinished or unknown outcomes")
    recorded = Counter((r.get("file"), r.get("name"), r.get("state")) for r in finished)
    reported = Counter((c.get("classname"), c.get("name"), xml_outcome(c)) for c in cases)
    if recorded != reported:
        problems.append("incremental results and XML differ by test identity/outcome")
    if len(finished) != len(cases):
        problems.append(f"finished results={len(finished)}, actual testcase elements={len(cases)}")
    return {"file": xml_file.name, "tests": len(cases), "finished": len(finished),
            "failures": sum(xml_outcome(c) == "failed" for c in cases),
            "skipped": sum(xml_outcome(c) == "skipped" for c in cases), "problems": problems}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--expected", nargs="+", default=["vitest-app.xml", "vitest-sdk-boundary.xml"])
    args = parser.parse_args()
    results = [check_result(args.directory / name) for name in args.expected]
    lines = []
    for result in results:
        lines.append(f"{result['file']}: actual tests={result['tests']} finished={result['finished']} failures={result['failures']} skipped={result['skipped']}")
        lines.extend(f"FAIL {result['file']}: {problem}" for problem in result["problems"])
    failed = any(r["problems"] for r in results)
    lines.append(f"Vitest result integrity: {'FAIL' if failed else 'PASS'}")
    print("\n".join(lines))
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as summary:
            summary.write("\n".join(lines) + "\n")
    return int(failed)


if __name__ == "__main__":
    sys.exit(main())
