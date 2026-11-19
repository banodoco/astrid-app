"""Read-only identity selection for the packet's hosted C5 proof.

The complete ps census is evidence. Only declared persistent services are the
unchanged-update invariant; other child commands remain separate observations.
"""
from __future__ import annotations

from pathlib import Path
import re
import shlex


def parse_ps(text):
    rows, unparsed = [], []
    for line in text.splitlines():
        fields = line.split(None, 7)
        if (len(fields) != 8 or not fields[0].isdigit() or not fields[1].isdigit()
                or not re.fullmatch(r"\d{2}:\d{2}:\d{2}", fields[5])
                or not re.fullmatch(r"\d{4}", fields[6])):
            if line.strip():
                unparsed.append(line)
            continue
        rows.append({"pid": int(fields[0]), "ppid": int(fields[1]),
                     "start_time": " ".join(fields[2:7]), "command": fields[7]})
    return rows, unparsed


def service_census(snapshot):
    """Missing or ambiguous identities fail even when absent on both sides."""
    rows = snapshot.get("processes", [])
    by_pid = {row["pid"]: row for row in rows}
    errors = list(snapshot.get("capture_errors", []))
    services, selected = {}, set()

    def check(condition, message):
        if not condition:
            errors.append(message)
        return condition

    def select(role, pids):
        services[role] = []
        for pid in sorted(set(pids)):
            row = by_pid.get(pid)
            if check(row is not None, f"{role}: PID {pid} absent from ps"):
                services[role].append({"pid": pid, "start_time": row["start_time"]})
                selected.add(pid)
        check(bool(services[role]), f"{role}: no live identity")

    recorded = {}
    for line in snapshot.get("recorded_processes", "").splitlines():
        fields = line.split("\t")
        if not check(len(fields) == 3 and fields[1].isdigit(), "Invalid recorded process row"):
            continue
        role, pid, started = fields[0], int(fields[1]), " ".join(fields[2].split())
        check(role not in recorded, f"Duplicate recorded role: {role}")
        recorded[role] = pid
        row = by_pid.get(pid)
        check(row is not None and row["start_time"] == started,
              f"{role}: recorded PID/start time does not identify a live process")

    discovery = snapshot.get("discovery", {})
    runtime_pid = discovery.get("pid")
    check(type(runtime_pid) is int and runtime_pid > 0, "Runtime discovery has no valid PID")
    check(runtime_pid == recorded.get("runtime"), "Runtime discovery differs from recorded Runtime PID")
    check(bool(discovery.get("runtime_instance_id")), "Runtime discovery has no instance identity")
    select("runtime", [runtime_pid] if type(runtime_pid) is int else [])

    editor_pid = recorded.get("editor")
    editor = by_pid.get(editor_pid)
    check(editor is not None and str(Path(snapshot["root"]) / "editor/scripts/dev-local-workspace.mjs") in editor["command"],
          "Recorded editor is not the candidate editor launcher")
    descendants = {editor_pid} if editor is not None else set()
    while True:
        expanded = descendants | {row["pid"] for row in rows if row["ppid"] in descendants}
        if expanded == descendants:
            break
        descendants = expanded

    editor_pids = {editor_pid} if editor is not None else set()
    proxy, vite = [], []
    for pid in descendants - editor_pids:
        row = by_pid[pid]
        try:
            argv = shlex.split(row["command"])
        except ValueError:
            continue  # Full snapshot and other-process observations retain this command.
        if not argv:
            continue
        node = Path(argv[0]).name in {"node", "nodejs"}
        is_proxy = node and any(arg.endswith("/runtime-discovery-proxy.mjs") for arg in argv[1:])
        is_vite = node and any(Path(arg).name in {"vite", "vite.js"} for arg in argv[1:])
        is_connector = any(arg.endswith("/astrid-local-connector.ts") for arg in argv[1:])
        is_esbuild = Path(argv[0]).name == "esbuild" and any(arg.startswith("--service=") for arg in argv[1:])
        if is_proxy:
            proxy.append(pid)
        if is_vite:
            vite.append(pid)
        if is_proxy or is_vite or is_connector or is_esbuild:
            # Include persistent npm/shell wrappers between the server and launcher.
            while pid != editor_pid and pid not in editor_pids:
                editor_pids.add(pid)
                pid = by_pid[pid]["ppid"]
    check(len(proxy) == 1, f"Editor needs exactly one discovery proxy; found {len(proxy)}")
    check(len(vite) == 1, f"Editor needs exactly one Vite server; found {len(vite)}")
    select("editor", editor_pids)

    declarations = snapshot.get("service_declarations", [])
    for name, role in [("pack-host", "agent-host"), ("chat", "chat-service")]:
        specs = [spec for spec in declarations if spec.get("name") == name]
        if not check(len(specs) == 1, f"Expected one installed {name} service declaration"):
            select(role, [])
            continue
        commands = specs[0].get("commands", [])
        matches = [row["pid"] for row in rows
                   if row["ppid"] == runtime_pid and row["command"] in commands]
        check(len(matches) == 1, f"Expected one Runtime-owned {name} service; found {len(matches)}")
        select(role, matches)
        if name == "pack-host":
            host, ready = snapshot.get("agent_host", {}), snapshot.get("agent_ready", {})
            check(matches == [host.get("pid")] == [ready.get("pid")], "Agent host registration/ready PID mismatch")
            check(bool(host.get("process_birth_id")) and host.get("process_birth_id") == ready.get("process_birth_id"),
                  "Agent host registration/ready birth identity mismatch")
            check(host.get("runtime_instance_id") == discovery.get("runtime_instance_id"),
                  "Agent host registration belongs to another Runtime instance")

    launchd = snapshot.get("launchd_entries", {})
    check("haus.astrid.runtime" in launchd, "Live launchd entry is missing")
    for label, job in sorted(launchd.items()):
        role = "launchd:" + label
        pid = job.get("pid")
        if pid is None:
            services[role] = [{"pid": None, "start_time": None}]
        else:
            select(role, [pid])
        if label == "haus.astrid.runtime":
            check(type(pid) is int and job.get("state") == "running", "Live launchd Runtime is not running")
        check(job.get("print_pid") == pid, f"{label}: launchctl list/print PID mismatch")
    check(snapshot.get("candidate_launchd_plist") is False, "Isolated candidate unexpectedly has a launchd plist")

    candidate = {row["pid"] for row in rows if snapshot["root"] + "/" in row["command"]} | descendants
    if type(runtime_pid) is int:
        candidate.add(runtime_pid)
    while True:
        expanded = candidate | {row["pid"] for row in rows if row["ppid"] in candidate}
        if expanded == candidate:
            break
        candidate = expanded
    observations = [row for row in rows if row["pid"] in candidate - selected]
    return {"services": services, "errors": errors, "other_process_observations": observations}


def compare_censuses(before, after):
    old, new = before["census"], after["census"]
    differences = {role: {"before": old["services"].get(role), "after": new["services"].get(role)}
                   for role in sorted(old["services"].keys() | new["services"].keys())
                   if old["services"].get(role) != new["services"].get(role)}
    old_boot = before.get("database", {}).get("runtime")
    new_boot = after.get("database", {}).get("runtime")
    if old_boot != new_boot or not old_boot:
        differences["candidate-runtime-boot"] = {"before": old_boot, "after": new_boot}
    errors = {"before": old["errors"], "after": new["errors"]}
    return {"unchanged": not differences and not any(errors.values()),
            "identity_differences": differences, "errors": errors,
            "other_processes_compared": False,
            "other_process_observations": {"before": old["other_process_observations"],
                                           "after": new["other_process_observations"]}}
