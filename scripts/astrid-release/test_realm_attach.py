"""RB-3: real Runtime create/attach/inspect on temporary realms; never starts a stack.

Run with a Python environment containing the manifest-pinned Runtime and client.
Default mode requires macOS/APFS and sqlite3. --portable explicitly doubles only
APFS copying and the sqlite3 CLI (using real stdlib SQLite) for logic checks on
Linux; it is not native clone proof. No assertion or Runtime call is skipped.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest

import astrid_runtime
from astrid_runtime.bootstrap import SourceProfile

PORTABLE = "--portable" in sys.argv
if PORTABLE:
    sys.argv.remove("--portable")
SCRIPT = Path(os.environ.get("REALM_SNAPSHOT_UNDER_TEST", Path(__file__).with_name("realm-snapshot.sh"))).resolve()
RID = "aaaaaaaa-1111-4222-8333-444444444444"
FRESH = "bbbbbbbb-1111-4222-8333-555555555555"


def fingerprint(root: Path) -> dict[str, str]:
    return {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(root.rglob("*"))
        if p.is_file() and not p.name.endswith("-shm")
    }


class RealmAttachFixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        checkout = Path(astrid_runtime.__file__).resolve().parents[1]
        expected = json.loads(SCRIPT.parents[2].joinpath("public/install-manifest.json").read_text())["runtime"]["sha"]
        actual = subprocess.run(["git", "-C", str(checkout), "rev-parse", "HEAD"],
                                text=True, capture_output=True, timeout=10)
        if actual.returncode != 0 or actual.stdout.strip() != expected:
            raise AssertionError("Install the manifest-pinned Runtime from its exact scratch checkout in this test Python environment.")
        print(f"RB-3 Runtime: {actual.stdout.strip()}", flush=True)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="realm-attach-fixture-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.live = self.root / "live"
        self.dest = self.root / "dest"
        self.realm = self.live / "runtime" / "realms" / RID
        self.copied = self.dest / "runtime" / "realms" / RID
        self.profile = self.root / "profile.json"
        checkout = Path(astrid_runtime.__file__).resolve().parents[1]
        self.profile.write_text(json.dumps(SourceProfile("astrid", str(checkout), str(checkout)).as_dict()))
        for directory in ("home", "tmp", "bin"):
            (self.root / directory).mkdir()
        self.env = {
            "HOME": str(self.root / "home"),
            "TMPDIR": str(self.root / "tmp"),
            "PATH": os.pathsep.join([str(self.root / "bin"), str(Path(sys.executable).parent), "/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"]),
            "REALM_FREE_FLOOR_BYTES": "1000000",
            "LANG": "C",
            "LC_ALL": "C",
        }
        if PORTABLE:
            self.make_sqlite_adapter()
        elif sys.platform != "darwin" or not shutil.which("sqlite3", path=self.env["PATH"]):
            self.fail("Native fixture requires macOS/APFS and sqlite3; --portable is a separate logic proof.")
        self.cli("create", self.live, self.realm, RID, expected=0)
        self.cli("create", self.dest, self.dest / "runtime" / "realms" / FRESH, FRESH, expected=0)
        media = self.realm / "cas" / "sha256" / "ab" / "fixture-media"
        media.parent.mkdir(parents=True, exist_ok=True)
        media.write_bytes(b"snapshot media\x00" * 100)
        for rel in ("staging/partial", "runpod/claim.json", "cache/item"):
            file = self.realm / rel
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("FAKE-NOT-A-SECRET")
        (self.live / "runpod").mkdir()
        (self.live / "runpod" / "claim.json").write_text("FAKE-NOT-A-SECRET")
        (self.realm / "admission-state.json").write_text("{}")
        (self.dest / "runtime" / "instance.lock").write_text('{"pid":999999999}')
        (self.dest / "runtime" / "discovery.json").write_text('{"pid":999999999,"stale":true}')
        self.writer = sqlite3.connect(self.realm / "realm.sqlite3", isolation_level=None)
        self.addCleanup(self.writer.close)
        self.writer.execute("PRAGMA journal_mode=WAL")
        self.writer.execute("PRAGMA wal_autocheckpoint=0")
        self.writer.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        self.writer.execute("UPDATE realm SET display_name='wal-only-row' WHERE id=?", (RID,))
        self.assertIn(b"wal-only-row", (self.realm / "realm.sqlite3-wal").read_bytes())

    def make_sqlite_adapter(self):
        # Actual SQLite backup/query semantics; only the external CLI is doubled.
        file = self.root / "bin" / "sqlite3"
        file.write_text(f"#!{sys.executable}\n" + r'''
import sqlite3, sys
args = sys.argv[1:]
if args[:1] == ['-cmd']:
    args = args[2:]
db, sql = args
with sqlite3.connect(db, uri=db.startswith('file:')) as source:
    if sql.startswith('.backup '):
        target = sql[len('.backup '):].strip().strip("'")
        with sqlite3.connect(target) as destination:
            source.backup(destination)
    else:
        for row in source.execute(sql):
            print('|'.join('' if item is None else str(item) for item in row))
''')
        file.chmod(0o700)

    def cli(self, command, data, realm, rid, *, expected):
        args = [sys.executable, "-I", "-m", "astrid_runtime", "workspace", command,
                "--data-root", str(data), "--realm-root", str(realm), "--json"]
        if command == "inspect":
            args += ["--expected-realm-id", rid]
        else:
            args += ["--realm-id", rid, "--source-manifest", str(self.profile)]
        result = subprocess.run(args, env=self.env, cwd=self.root, text=True, capture_output=True, timeout=30)
        if expected == 0:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def snapshot(self, *, force_nonzero_attach=False, after_copy="", attach_probe=False):
        script = '. "$1"\n'
        if PORTABLE:
            script += '''
realm_clone_supported() { return 0; }
cp() { if [[ "${1:-}" == -c ]]; then shift; fi; command cp "$@"; }
'''
        attach = (shlex.quote(sys.executable) + ' -I -m astrid_runtime "$@" --source-manifest '
                  + shlex.quote(str(self.profile)) + ' | tee ' + shlex.quote(str(self.root / "attach.json")))
        if attach_probe:
            attach = "printf '%s\\n' '{\"status\":\"configured_attach\"}' | tee " + shlex.quote(str(self.root / "attach.json"))
        script += f'''
_realm_repoint_catalog() {{ echo 'fixture: hand-edited catalog forbidden' >&2; return 97; }}
realm_attach_cmd() {{
  {attach}
  {"return 7" if force_nonzero_attach else "return ${PIPESTATUS[0]}"}
}}
'''
        if after_copy:
            script += '''
eval "$(declare -f _realm_clone_tree | sed '1s/_realm_clone_tree/_fixture_clone_tree/')"
_realm_clone_tree() {
  _fixture_clone_tree "$@" || return
''' + after_copy + '\n}\n'
        script += 'realm_snapshot_copy "$2" "$3"\n'
        return subprocess.run(["bash", "-uo", "pipefail", "-c", script, "fixture", str(SCRIPT), str(self.live), str(self.dest)],
                              env=self.env, cwd=self.root, text=True, capture_output=True, timeout=30)

    def test_snapshot_attaches_with_real_runtime_and_refuses_wrong_id(self):
        before = fingerprint(self.live)
        old_catalog = (self.dest / "runtime" / "catalog.json").read_bytes()
        result = self.snapshot()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        attach = json.loads((self.root / "attach.json").read_text())
        self.assertEqual(attach["status"], "configured_attach")
        self.assertEqual((self.dest / "runtime/catalog.json.pre-realm-snapshot").read_bytes(), old_catalog)
        self.assertFalse((self.dest / "runtime/instance.lock").exists())
        self.assertFalse((self.dest / "runtime/discovery.json").exists())
        with sqlite3.connect(self.copied / "realm.sqlite3") as db:
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(db.execute("SELECT display_name FROM realm WHERE id=?", (RID,)).fetchone()[0], "wal-only-row")
        self.assertEqual((self.copied / "cas/sha256/ab/fixture-media").read_bytes(), (self.realm / "cas/sha256/ab/fixture-media").read_bytes())
        for rel in ("staging/partial", "runpod", "cache", "admission-state.json"):
            self.assertFalse((self.copied / rel).exists(), rel)
        self.assertEqual((self.copied / "owner.lock").read_bytes(), b"")
        self.assertFalse((self.dest / "runpod").exists())
        self.assertFalse(any(b"FAKE-NOT-A-SECRET" in p.read_bytes() for p in self.dest.rglob("*") if p.is_file()))
        inspect = json.loads(self.cli("inspect", self.dest, self.copied, RID, expected=0).stdout)
        self.assertEqual(inspect["realm_id"], RID)
        copied_before = fingerprint(self.dest)
        wrong = self.cli("attach", self.root / "wrong", self.copied, "wrong-id", expected=1)
        self.assertIn("workspace identity mismatch", wrong.stdout + wrong.stderr)
        self.assertFalse((self.root / "wrong/runtime/catalog.json").exists())
        self.assertEqual(fingerprint(self.dest), copied_before)
        self.assertEqual(fingerprint(self.live), before, "source hashes, including WAL, must stay unchanged")

    def test_live_instance_pid_refuses_before_snapshot_or_owner_record_deletion(self):
        (self.dest / "runtime/instance.lock").write_text(json.dumps({"pid": os.getpid()}))
        before = fingerprint(self.dest)
        result = self.snapshot()
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("still alive", result.stdout + result.stderr)
        self.assertEqual(fingerprint(self.dest), before)
        self.assertFalse(self.copied.exists())

    def test_held_owner_lock_refuses_without_mutation(self):
        with (self.dest / "runtime/realms" / FRESH / "owner.lock").open("rb") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            before = fingerprint(self.dest)
            result = self.snapshot()
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("owner lock held", result.stdout + result.stderr)
            self.assertEqual(fingerprint(self.dest), before)

    def test_nonzero_attach_cannot_be_accepted_from_success_text(self):
        old_catalog = (self.dest / "runtime/catalog.json").read_bytes()
        result = self.snapshot(force_nonzero_attach=True)
        self.assertEqual(json.loads((self.root / "attach.json").read_text())["status"], "configured_attach")
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.dest / "runtime/catalog.json").read_bytes(), old_catalog)
        self.assertTrue((self.copied / "realm.sqlite3").is_file())
        self.assertEqual((self.dest / "runtime/catalog.json.pre-realm-snapshot").read_bytes(), old_catalog)
        retained = fingerprint(self.dest)
        retry = self.snapshot()
        self.assertNotEqual(retry.returncode, 0, retry.stdout + retry.stderr)
        self.assertIn("destination already has realm", retry.stdout + retry.stderr)
        self.assertEqual(fingerprint(self.dest), retained, "a retry must not discard the published copy")

    def test_runtime_schema_refusal_restores_catalog_without_migrating(self):
        self.writer.execute("UPDATE runtime_schema SET version=999999 WHERE id=1")
        before = fingerprint(self.live)
        old_catalog = (self.dest / "runtime/catalog.json").read_bytes()
        result = self.snapshot()
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("workspace attach did not report configured_attach", result.stdout + result.stderr)
        self.assertEqual((self.dest / "runtime/catalog.json").read_bytes(), old_catalog)
        self.assertEqual(fingerprint(self.live), before)
        with sqlite3.connect(self.copied / "realm.sqlite3") as db:
            self.assertEqual(db.execute("SELECT version FROM runtime_schema WHERE id=1").fetchone()[0], 999999)

    def test_live_discovery_pid_refuses_even_with_stale_instance_pid(self):
        (self.dest / "runtime/discovery.json").write_text(json.dumps({"pid": os.getpid()}))
        before = fingerprint(self.dest)
        result = self.snapshot()
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("still alive", result.stdout + result.stderr)
        self.assertEqual(fingerprint(self.dest), before)
        self.assertFalse(self.copied.exists())

    def test_owner_appearing_during_copy_is_preserved_at_publication(self):
        advertisement = self.dest / "runtime/instance.lock"
        record = json.dumps({"pid": os.getpid()})
        hook = 'printf %s ' + shlex.quote(record) + ' > ' + shlex.quote(str(advertisement))
        old_catalog = (self.dest / "runtime/catalog.json").read_bytes()
        source = fingerprint(self.live)
        result = self.snapshot(after_copy=hook)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("still alive", result.stdout + result.stderr)
        self.assertEqual(advertisement.read_text(), record)
        self.assertEqual((self.dest / "runtime/catalog.json").read_bytes(), old_catalog)
        self.assertFalse(self.copied.exists())
        self.assertEqual(fingerprint(self.live), source)

    def test_publication_obeys_the_existing_bootstrap_mutex(self):
        with (self.dest / "runtime/bootstrap.lock").open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            before = fingerprint(self.dest)
            result = self.snapshot(attach_probe=True)
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("bootstrap lock held", result.stdout + result.stderr)
            self.assertEqual(fingerprint(self.dest), before)
            self.assertFalse(self.copied.exists())
            self.assertFalse((self.root / "attach.json").exists(), "attach must not run through another launcher's mutex")

    def test_realm_owner_lock_appearing_during_copy_refuses_publication(self):
        start, ready = self.root / "lock-start", self.root / "lock-ready"
        owner = self.dest / "runtime/realms" / FRESH / "owner.lock"
        holder = subprocess.Popen([sys.executable, "-I", "-c", '''
import fcntl, pathlib, sys, time
start, ready, owner = map(pathlib.Path, sys.argv[1:])
deadline = time.monotonic() + 20
while not start.exists():
    if time.monotonic() > deadline:
        sys.exit("fixture owner never received its start signal")
    time.sleep(0.01)
with owner.open("rb") as handle:
    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    ready.touch()
    sys.stdin.read()
''', str(start), str(ready), str(owner)], env=self.env, cwd=self.root, stdin=subprocess.PIPE)
        def stop_holder():
            holder.stdin.close()
            holder.wait(timeout=25)
        self.addCleanup(stop_holder)
        signal = '''
import pathlib, sys, time
start, ready = map(pathlib.Path, sys.argv[1:])
start.touch()
deadline = time.monotonic() + 10
while not ready.exists():
    if time.monotonic() > deadline:
        sys.exit("fixture owner did not acquire the lock")
    time.sleep(0.01)
'''
        hook = ' '.join(map(shlex.quote, [sys.executable, '-I', '-c', signal, str(start), str(ready)]))
        before = fingerprint(self.dest)
        source = fingerprint(self.live)
        result = self.snapshot(after_copy=hook)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("owner lock held", result.stdout + result.stderr)
        self.assertEqual(fingerprint(self.dest), before)
        self.assertEqual(fingerprint(self.live), source)
        self.assertFalse(self.copied.exists())
        self.assertFalse((self.root / "attach.json").exists())


if __name__ == "__main__":
    print("RB-3 mode: " + ("portable logic (APFS and CLI adapters)" if PORTABLE else "native macOS/APFS"), flush=True)
    unittest.main(verbosity=2)
