#!/usr/bin/env bash
# Fixture tests for realm-snapshot.sh. Touches only a temp dir; starts nothing.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/realm-snapshot.sh"
T="$(mktemp -d "${TMPDIR:-/tmp}/realm-snap-test.XXXXXX")"
WRITER_PID=""
cleanup() { [ -n "$WRITER_PID" ] && kill "$WRITER_PID" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok   $*"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $*"; }
check(){ local d="$1"; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }

# Small floor so the suite runs on a nearly-full disk; the floor test overrides it.
export REALM_FREE_FLOOR_BYTES=1000000
RID=aaaaaaaa-1111-4222-8333-444444444444
FRESH=bbbbbbbb-1111-4222-8333-555555555555
LIVE="$T/live"; DEST="$T/dest"; REALM="$LIVE/runtime/realms/$RID"

# ---- fixture builder: live data root ----------------------------------------
mkdir -p "$REALM/cas/sha256/ab" "$REALM/cas/sha256/cd" "$REALM/staging" "$REALM/runpod" "$REALM/cache" "$LIVE/runtime"
head -c 300000 /dev/urandom > "$REALM/cas/sha256/ab/obj1"
head -c 70000  /dev/urandom > "$REALM/cas/sha256/cd/obj2"
printf 'tiny' > "$REALM/cas/sha256/cd/obj3"
: > "$REALM/owner.lock"; echo junk > "$REALM/staging/partial"
echo '{"claim":"FAKE-NOT-A-SECRET"}' > "$REALM/runpod/claim.json"; echo c > "$REALM/cache/x"
echo '{"stat":[1]}' > "$REALM/admission-state.json"
python3 - "$LIVE" "$RID" <<'PY'
import json, sys
live, rid = sys.argv[1:3]
json.dump({"version":1,"selected_realm_id":rid,"realms":[{"realm_id":rid,"display_name":"Astrid Workspace",
  "data_root":"%s/runtime/realms/%s"%(live,rid),"selection_source":"create","source_profile":"astrid"}],
  "source_profiles":{"astrid":{"profile":"astrid"}}}, open(live+"/runtime/catalog.json","w"))
PY
# A live writer: WAL mode, no auto-checkpoint, an uncheckpointed row, connection kept open.
python3 - "$REALM/realm.sqlite3" "$RID" "$T/writer.ready" <<'PY' &
import sqlite3, sys, time
db, rid, ready = sys.argv[1:4]
c = sqlite3.connect(db, isolation_level=None)
c.execute("PRAGMA journal_mode=WAL"); c.execute("PRAGMA wal_autocheckpoint=0")
c.execute("CREATE TABLE realm(id TEXT)"); c.execute("INSERT INTO realm VALUES (?)", (rid,))
c.execute("CREATE TABLE note(v TEXT)")
c.execute("PRAGMA wal_checkpoint(TRUNCATE)")          # base state is in the main file...
c.execute("INSERT INTO note VALUES ('wal-only-row')")  # ...this row exists only in the WAL
open(ready, "w").write("1")
time.sleep(600)
PY
WRITER_PID=$!
for _ in $(seq 100); do [ -f "$T/writer.ready" ] && break; sleep 0.1; done
touch -t 202501020304 "$REALM/cas/sha256/ab/obj1"   # distinct old mtimes
mkdir -p "$DEST/runtime/realms/$FRESH/cas/sha256" "$DEST/runtime/realms/$FRESH/staging"
: > "$DEST/runtime/realms/$FRESH/owner.lock"
sqlite3 "$DEST/runtime/realms/$FRESH/realm.sqlite3" "create table realm(id text); insert into realm values('$FRESH');"
python3 - "$DEST" "$FRESH" <<'PY'
import json, sys
d, f = sys.argv[1:3]
json.dump({"version":1,"selected_realm_id":f,"realms":[{"realm_id":f,"display_name":"Astrid Workspace",
  "data_root":"%s/runtime/realms/%s"%(d,f),"selection_source":"create","source_profile":"astrid"}],
  "source_profiles":{"astrid":{"profile":"astrid"}}}, open(d+"/runtime/catalog.json","w"))
PY
grep -q 'wal-only-row' "$REALM/realm.sqlite3-wal" 2>/dev/null && ok "fixture: row is only in the live WAL" || bad "fixture: WAL row missing"
[ -f "$REALM/realm.sqlite3-shm" ] && ok "fixture: -shm present" || bad "fixture: -shm missing"

# ---- refusals first (must not change anything) --------------------------------
FPD0="$(realm_live_fingerprint "$DEST")"
echo "== floor refusal"
out="$(REALM_FREE_FLOOR_BYTES=999999999999999 realm_snapshot_copy "$LIVE" "$DEST" 2>&1)"; rc=$?
check "refuses below the free-space floor (rc=$rc)" test $rc -ne 0
check "message names the needed bytes" bash -c "[[ \"\$1\" == *'need 1000000'* ]]" _ "$out"
check "destination untouched after refusal" test "$FPD0" = "$(realm_live_fingerprint "$DEST")"
check "required_bytes = floor + 2x db" test "$(REALM_FREE_FLOOR_BYTES=1000 realm_required_bytes "$LIVE")" = "$((1000 + 2 * $(stat -f %z "$REALM/realm.sqlite3")))"

echo "== non-APFS / clone-unsupported refusal"
out="$( realm_clone_supported() { echo "simulated: not APFS" >&2; return 1; }; realm_snapshot_copy "$LIVE" "$DEST" 2>&1)"; rc=$?
check "refuses when cloning is unsupported (rc=$rc)" test $rc -ne 0
check "message says refusing to byte-copy" bash -c "[[ \"\$1\" == *'refusing to byte-copy'* ]]" _ "$out"
check "destination untouched after refusal" test "$FPD0" = "$(realm_live_fingerprint "$DEST")"
ls "$DEST/runtime/realms" | grep -q "$RID" && bad "partial realm left behind" || ok "no partial realm left behind"

echo "== no live install"
out="$(realm_snapshot_copy "$T/nonexistent" "$DEST" 2>&1)"; rc=$?
check "no live install: success, nothing copied (rc=$rc)" test $rc -eq 0
check "message mentions empty workspace" bash -c "[[ \"\$1\" == *'empty workspace'* ]]" _ "$out"

echo "== real run"
BEFORE_L="$(realm_live_fingerprint "$LIVE")"
SUM_L="$(cd "$LIVE" && find . -type f ! -name '*-shm' ! -name '*-wal' -print0 | sort -z | xargs -0 shasum -a 256)"
out="$(realm_snapshot_copy "$LIVE" "$DEST" 2>&1)"; rc=$?
echo "$out" | sed 's/^/    | /'
check "snapshot returns 0" test $rc -eq 0
C="$DEST/runtime/realms/$RID"
check "no -wal/-shm in the copy" test -z "$(ls "$C" | grep -E -- '-(wal|shm)$')"
check "integrity_check ok on the copy" test "$(sqlite3 "$C/realm.sqlite3" 'pragma integrity_check')" = ok
check "uncheckpointed WAL write present in the copy" test "$(sqlite3 "$C/realm.sqlite3" 'select v from note')" = wal-only-row
check "copy realm id matches" test "$(sqlite3 "$C/realm.sqlite3" 'select id from realm')" = "$RID"
for f in ab/obj1 cd/obj2 cd/obj3; do
  check "media byte-identical: $f" cmp -s "$REALM/cas/sha256/$f" "$C/cas/sha256/$f"
done
check "media is a clone (no extra space; same size)" test "$(stat -f %z "$C/cas/sha256/ab/obj1")" = 300000
check "runpod/ absent" test ! -e "$C/runpod"
check "staging contents absent" test ! -e "$C/staging/partial"
check "cache/ absent" test ! -e "$C/cache"
check "admission-state.json absent (forces deep admission)" test ! -e "$C/admission-state.json"
check "owner.lock is a fresh empty file" test -f "$C/owner.lock" -a ! -s "$C/owner.lock"
check "claim text appears nowhere in the destination" test -z "$(grep -rl FAKE-NOT-A-SECRET "$DEST" 2>/dev/null)"
check "live tree identical by size+mtime before/after" test "$BEFORE_L" = "$(realm_live_fingerprint "$LIVE")"
check "live file contents identical by sha256" test "$SUM_L" = "$(cd "$LIVE" && find . -type f ! -name '*-shm' ! -name '*-wal' -print0 | sort -z | xargs -0 shasum -a 256)"
check "live WAL still holds the row (not checkpointed away)" grep -q wal-only-row "$REALM/realm.sqlite3-wal"
python3 - "$DEST" "$RID" <<'PY' && ok "catalog selects the copied realm" || bad "catalog does not select the copied realm"
import json, sys
d, rid = sys.argv[1:3]
c = json.load(open(d + "/runtime/catalog.json"))
assert c["selected_realm_id"] == rid and len(c["realms"]) == 1
r = c["realms"][0]
import os
assert r["realm_id"] == rid and r["data_root"] == "%s/runtime/realms/%s" % (os.path.realpath(d), rid), r
assert r["selection_source"] == "attach" and r["source_profile"] == "astrid" and c["version"] == 1
assert "astrid" in c["source_profiles"]
PY
check "old catalog kept for rollback" test -f "$DEST/runtime/catalog.json.pre-realm-snapshot"
check "catalog mode 0600" test "$(stat -f %Lp "$DEST/runtime/catalog.json")" = 600

echo "== rerun refuses to overwrite"
out="$(realm_snapshot_copy "$LIVE" "$DEST" 2>&1)"; rc=$?
check "second run refuses (rc=$rc)" test $rc -ne 0

echo "== verify catches corruption"
echo x >> "$C/cas/sha256/cd/obj2"
check "verify fails on a tampered media file" bash -c '. "$1"; ! realm_verify_copy "$2" "$3" >/dev/null 2>&1' _ "$HERE/realm-snapshot.sh" "$REALM" "$C"

echo; echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
