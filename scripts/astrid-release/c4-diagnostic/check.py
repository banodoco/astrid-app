#!/usr/bin/env python3
"""Static provenance checks only: never starts an editor, Runtime or browser."""
import argparse
import ast
import hashlib
from pathlib import Path
import re
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("--harness", type=Path, required=True)
args = parser.parse_args()
directory = Path(__file__).resolve().parent
harness = args.harness.resolve()
expected_harness = "3c99c7aa7f9a0079b5075351f6271239714c4bc4"
actual_harness = subprocess.check_output(["git", "-C", str(harness), "rev-parse", "HEAD"], text=True).strip()
assert actual_harness == expected_harness, "Wrong frozen harness checkout"
assert not subprocess.check_output(["git", "-C", str(harness), "status", "--porcelain", "--untracked-files=no"], text=True).strip()
original = (harness / "scripts/astrid-release/hosted-browser.mjs").read_text()
assert hashlib.sha256(original.encode()).hexdigest() == "870757db8bc32537b1cecbf51a3254c158fe8e05cae68891800100b4c0496180"
observed = (directory / "browser.mjs").read_text()
blocks = re.findall(r"// P61 C4 OBSERVER BEGIN\n.*?// P61 C4 OBSERVER END\n", observed, re.S)
assert len(blocks) == 9, "Unexpected observer block inventory"
restored = re.sub(r"// P61 C4 OBSERVER BEGIN\n.*?// P61 C4 OBSERVER END\n", "", observed, flags=re.S)
restored = restored.replace("refs/heads/p61/c4-input-diagnostic", "refs/heads/p61/rb-6")
assert restored == original, "Original browser actions/assertions/timing changed"
for name in ["browser.mjs", "observer.mjs"]:
    subprocess.run(["node", "--check", str(directory / name)], check=True)
ast.parse((directory / "run.py").read_text())
repo = directory.parents[2]
workflow_path = ".github/workflows/p61-c4-readiness.yml"
workflow = (repo / workflow_path).read_text()
original_workflow = subprocess.check_output([
    "git", "-C", str(repo), "show", "67428177b24989e230537ffe363aaa45b60bbd63:" + workflow_path,
], text=True)
for block in ["INPUT", "JOB"]:
    pattern = r"  # P61 C4 DIAGNOSTIC " + block + r" BEGIN\n.*?  # P61 C4 DIAGNOSTIC " + block + r" END\n"
    assert len(re.findall(pattern, workflow, re.S)) == 1, "Unexpected diagnostic workflow block inventory"
    workflow = re.sub(pattern, "", workflow, flags=re.S)
assert workflow == original_workflow, "Existing C4 readiness workflow changed outside the diagnostic additions"
print("Static source check PASS: frozen harness identity; original browser and readiness workflow restored byte-for-byte; syntax.")
