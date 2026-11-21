"""Release caller for Runtime attach, retaining a bounded doctor report on refusal.

The installed interpreter runs both commands. Doctor inspects a temporary
snapshot; this caller never opens, migrates or repairs the candidate database.
"""
from __future__ import annotations

import json
import subprocess
import sys


def main(arguments):
    command = [sys.executable, "-X", "utf8", "-I", "-m", "astrid_runtime", *arguments]
    result = subprocess.run(command, check=False)
    if result.returncode == 0 or arguments[:2] != ["workspace", "attach"]:
        return result.returncode
    try:
        realm_root = arguments[arguments.index("--realm-root") + 1]
    except (ValueError, IndexError):
        # Runtime already diagnosed the invalid invocation. Keep its refusal.
        return result.returncode
    diagnostic = {"realm_root": realm_root}
    try:
        doctor = subprocess.run([
            sys.executable, "-X", "utf8", "-I", "-m", "runtime_protocol", "doctor",
            "--root", realm_root, "--json", "--admission-timeout", "120",
        ], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=125)
        diagnostic["doctor_exit"] = doctor.returncode
        report = json.loads(doctor.stdout)
        if not isinstance(report, dict):
            raise ValueError("doctor report is not a JSON object")
        diagnostic["report"] = report
        if doctor.stderr:
            diagnostic["doctor_stderr"] = doctor.stderr
    except subprocess.TimeoutExpired:
        diagnostic["error"] = "doctor did not finish within its 125-second process limit"
    except (OSError, ValueError) as error:
        diagnostic["error"] = "doctor report unavailable: " + str(error)
    print("astrid-release: Runtime doctor: " + json.dumps(diagnostic, sort_keys=True),
          file=sys.stderr, flush=True)
    # A healthy/failed/unavailable doctor report never changes the attach result.
    return result.returncode


if __name__ == "__main__":
    code = main(sys.argv[1:])
    raise SystemExit(128 - code if code < 0 else code)
