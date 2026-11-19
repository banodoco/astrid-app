#!/usr/bin/env python3
"""Additional Completion refusal: a source DB that cannot be opened mode=ro.

Run only on the hosted Mac. Existing native tests cover wrong identity and schema.
"""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile

assert sys.platform == "darwin" and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
assert os.geteuid() != 0, "Permission refusal requires a normal hosted-runner user"
script = Path(__file__).with_name("realm-snapshot.sh").resolve()
with tempfile.TemporaryDirectory(prefix="p61-unreadable-", dir=os.environ["RUNNER_TEMP"]) as temporary:
    root = Path(temporary).resolve()
    source, destination = root / "live", root / "copy"
    rid = "aaaaaaaa-1111-4222-8333-444444444444"
    realm = source / "runtime/realms" / rid
    (realm / "cas").mkdir(parents=True)
    empty_id = "bbbbbbbb-1111-4222-8333-555555555555"
    empty = destination / "runtime/realms" / empty_id
    empty.mkdir(parents=True)
    (empty / "owner.lock").touch()
    destination_catalog = destination / "runtime/catalog.json"
    destination_catalog.write_text(json.dumps({"version": 1, "selected_realm_id": empty_id,
        "realms": [{"realm_id": empty_id, "data_root": str(empty)}]}))
    catalog_before = destination_catalog.read_bytes()
    database = realm / "realm.sqlite3"
    connection = sqlite3.connect(database)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("CREATE TABLE realm (id TEXT)")
    connection.execute("INSERT INTO realm VALUES (?)", (rid,))
    connection.commit()
    catalog = {"version": 1, "selected_realm_id": rid, "realms": [{"realm_id": rid, "data_root": str(realm)}]}
    (source / "runtime/catalog.json").write_text(json.dumps(catalog))
    before = hashlib.sha256(database.read_bytes()).hexdigest()
    database.chmod(0)
    try:
        command = ["bash", "-uo", "pipefail", "-c",
                   '. "$1"; realm_attach_cmd() { echo "unexpected attach" >&2; return 97; }; realm_snapshot_copy "$2" "$3"',
                   "p61-readonly-probe", str(script), str(source), str(destination)]
        result = subprocess.run(command, capture_output=True, text=True, timeout=60,
                                env={**os.environ, "REALM_FREE_FLOOR_BYTES": "1000000"})
        print("COMMAND", json.dumps(command), flush=True)
        print(result.stdout + result.stderr, flush=True)
        print("EXIT", result.returncode, flush=True)
        assert result.returncode != 0, "Unreadable source was accepted"
        assert "read-only backup of the live database failed" in result.stdout + result.stderr
        assert "snapshot failed; nothing was published" in result.stdout + result.stderr
        assert "unexpected attach" not in result.stdout + result.stderr
        assert destination_catalog.read_bytes() == catalog_before
        assert not (destination / "runtime/realms" / rid).exists()
    finally:
        database.chmod(0o600)
    assert hashlib.sha256(database.read_bytes()).hexdigest() == before
    connection.close()
    print("PASS: mode=ro refusal before attach; source database bytes unchanged.", flush=True)
