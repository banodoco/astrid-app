# realm-snapshot.sh -- sourced file (no shebang, no top-level side effects).
#
# Snapshot-copies the live Astrid realm into a stack's (stopped) data root and
# repoints that stack's Runtime catalog at the copy. Dependencies: bash, sqlite3,
# python3 (stdlib only, 3.9+), cp -c (APFS clone). Prints no file contents,
# tokens or credentials; only names, sizes and counts.
#
# Public functions:
#   realm_snapshot_copy <live_data_root> <dest_data_root>   (returns 0 / non-0)
#   realm_live_fingerprint <live_data_root>                 (prints sorted listing)
#   realm_live_data_root                                    (prints data_root from install record)
#   realm_required_bytes <live_data_root>                   (prints bytes needed)
# Tunables (env): REALM_INSTALL_JSON, REALM_FREE_FLOOR_BYTES (default 6 GiB),
#   REALM_SQLITE_TIMEOUT_MS (default 5000).

REALM_FREE_FLOOR_DEFAULT=$((6 * 1024 * 1024 * 1024))

_realm_say() { printf 'realm-snapshot: %s\n' "$*"; }
_realm_err() { printf 'realm-snapshot: ERROR: %s\n' "$*" >&2; }

# Print data_root from the live install record (read only). Empty + status 1 if none.
realm_live_data_root() {
  local rec="${REALM_INSTALL_JSON:-$HOME/.local/share/astrid/install.json}"
  [ -f "$rec" ] || return 1
  python3 -I - "$rec" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    v = d.get("data_root")
except Exception:
    sys.exit(1)
if not isinstance(v, str) or not v:
    sys.exit(1)
print(v)
PY
}

# Resolve the live realm: prints "<realm_id>\t<realm_dir>\t<display_name>".
# status 2 = no live install (no catalog); 1 = catalog present but unusable.
_realm_resolve_live() {
  python3 -I - "$1" <<'PY'
import json, os, stat, sys
root = os.path.realpath(sys.argv[1])
cat = os.path.join(root, "runtime", "catalog.json")
if not os.path.isfile(cat):
    sys.exit(2)
try:
    c = json.load(open(cat))
    sel = c["selected_realm_id"]
    ent = [r for r in c["realms"] if r["realm_id"] == sel]
    assert len(ent) == 1
    d = os.path.realpath(ent[0]["data_root"])
    name = ent[0].get("display_name") or "Astrid Workspace"
except Exception as e:
    sys.stderr.write("live catalog unusable: %s\n" % type(e).__name__)
    sys.exit(1)
if not (d == root or d.startswith(root + os.sep)):
    sys.stderr.write("live realm is outside the live data root\n"); sys.exit(1)
db = os.path.join(d, "realm.sqlite3")
if not stat.S_ISREG(os.lstat(db).st_mode):
    sys.stderr.write("live realm database missing\n"); sys.exit(1)
if os.path.basename(d) != sel:
    sys.stderr.write("live realm directory name differs from its id\n"); sys.exit(1)
print("%s\t%s\t%s" % (sel, d, name))
PY
}

# Names never copied, at any depth of the realm (the DB sidecars are handled by backup).
_realm_is_skipped() {  # <basename>
  case "$1" in
    owner.lock|staging|runpod|admission-state.json|cache|caches|renders|render-cache|.DS_Store) return 0 ;;
    *-wal|*-shm|*-journal|realm.sqlite3) return 0 ;;
  esac
  return 1
}

# Print the number of bytes that must be free on the destination volume.
realm_required_bytes() {
  local live="$1" info rdir size
  info="$(_realm_resolve_live "$live")" || return 1
  rdir="$(printf '%s' "$info" | cut -f2)"
  size="$(python3 -I -c 'import os,sys;print(os.stat(sys.argv[1]).st_size)' "$rdir/realm.sqlite3")" || return 1
  python3 -I -c 'import sys;print(int(sys.argv[1])+2*int(sys.argv[2]))' \
    "${REALM_FREE_FLOOR_BYTES:-$REALM_FREE_FLOOR_DEFAULT}" "$size"
}

# 0 if enough free space on the volume holding <dest>; else prints the number and returns 1.
realm_disk_check() {  # <live_data_root> <dest_data_root>
  local need free
  need="$(realm_required_bytes "$1")" || return 1
  free="$(python3 -I -c 'import shutil,sys;print(shutil.disk_usage(sys.argv[1]).free)' "$2")" || return 1
  if [ "$free" -lt "$need" ]; then
    _realm_err "not enough free disk: need $need bytes (floor + 2x realm database), have $free"
    return 1
  fi
  _realm_say "disk ok: need $need bytes, have $free"
}

# Prove APFS cloning works between the live realm's volume and the destination
# (cp -c would silently fall back to a full byte copy; we refuse instead).
realm_clone_supported() {  # <live_realm_dir> <dest_dir>
  python3 -I - "$1" "$2" <<'PY'
import ctypes, ctypes.util, os, sys, tempfile
src_dir, dst_dir = sys.argv[1], sys.argv[2]
if os.stat(src_dir).st_dev != os.stat(dst_dir).st_dev:
    sys.stderr.write("source and destination are on different volumes\n"); sys.exit(1)
libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
if not hasattr(libc, "clonefile"):
    sys.stderr.write("clonefile is not available on this system\n"); sys.exit(1)
with tempfile.TemporaryDirectory(dir=dst_dir, prefix=".clone-probe-") as t:
    a = os.path.join(t, "a"); b = os.path.join(t, "b")
    open(a, "wb").write(b"x" * 4096)
    if libc.clonefile(a.encode(), b.encode(), 0) != 0:
        sys.stderr.write("clonefile failed: %s\n" % os.strerror(ctypes.get_errno())); sys.exit(1)
PY
}

# Sorted "path<TAB>size<TAB>mtime_ns" for every file/dir in the live realm and the
# runtime catalog. Pure stat, never opens contents. Compare before/after to prove
# the live realm was untouched.
realm_live_fingerprint() {  # <live_data_root>
  python3 -I - "$1" <<'PY'
import os, sys
root = os.path.realpath(sys.argv[1])
rows = []
for base, dirs, files in os.walk(root, followlinks=False):
    for n in dirs + files:
        p = os.path.join(base, n)
        try:
            s = os.lstat(p)
        except OSError:
            continue
        rows.append("%s\t%d\t%d" % (os.path.relpath(p, root), s.st_size, s.st_mtime_ns))
print("\n".join(sorted(rows)))
PY
}

# Read-only consistent backup of the live database (never opened read-write).
_realm_backup_db() {  # <live_db> <dest_db>
  local uri
  uri="file:$(python3 -I -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$1")?mode=ro"
  if sqlite3 -cmd ".timeout ${REALM_SQLITE_TIMEOUT_MS:-5000}" "$uri" ".backup '$2'" >/dev/null 2>&1; then return 0; fi
  # A cleanly stopped realm may have no -shm, which a read-only WAL open needs. Only then:
  # clone the DB files to a private scratch dir (live files only read) and back up from that.
  local live_dir; live_dir="$(dirname "$1")"
  if [ -e "$live_dir/realm.sqlite3-shm" ]; then _realm_err "read-only backup of the live database failed"; return 1; fi
  local scratch rc=0; scratch="$(mktemp -d "${TMPDIR:-/tmp}/realm-snap-scratch.XXXXXX")" || return 1
  cp -c "$1" "$scratch/realm.sqlite3" && { [ ! -f "$1-wal" ] || cp -c "$1-wal" "$scratch/realm.sqlite3-wal"; } \
    && sqlite3 "$scratch/realm.sqlite3" ".backup '$2'" >/dev/null || rc=1
  rm -rf "$scratch"
  [ "$rc" = 0 ] || _realm_err "backup via scratch copy failed"
  return $rc
}

# Clone the realm tree (everything except the skip list) with cp -c.
_realm_clone_tree() {  # <live_realm_dir> <dest_realm_dir>
  local src="$1" dst="$2" count=0 rel name skip p
  mkdir -p "$dst"; chmod 700 "$dst"
  # Directories first (modes kept at 0700 like the Runtime), pruning skipped names.
  while IFS= read -r -d '' p; do
    rel="${p#"$src"/}"; skip=0
    IFS=/ read -r -a parts <<<"$rel"
    for name in "${parts[@]}"; do _realm_is_skipped "$name" && { skip=1; break; }; done
    [ "$skip" = 1 ] && continue
    mkdir -p "$dst/$rel"; chmod 700 "$dst/$rel"
  done < <(find "$src" -mindepth 1 -type d -print0)
  # Files (regular only; symlinks and specials are refused).
  while IFS= read -r -d '' p; do
    rel="${p#"$src"/}"; skip=0
    IFS=/ read -r -a parts <<<"$rel"
    for name in "${parts[@]}"; do _realm_is_skipped "$name" && { skip=1; break; }; done
    [ "$skip" = 1 ] && continue
    if [ -L "$p" ] || [ ! -f "$p" ]; then _realm_err "unsafe entry in live realm: $rel"; return 1; fi
    cp -c "$p" "$dst/$rel" || { _realm_err "clone failed: $rel"; return 1; }
    count=$((count + 1))
  done < <(find "$src" -mindepth 1 \( -type f -o -type l -o -type p -o -type s -o -type b -o -type c \) -print0)
  _realm_say "cloned $count files"
}

# Verify the copy against the live realm. Prints only counts.
realm_verify_copy() {  # <live_realm_dir> <dest_realm_dir>
  local live="$1" dest="$2" res
  # The copy is ours (not the live DB). It keeps the WAL header flag but has no -shm, so it must be opened normally.
  res="$(sqlite3 "$dest/realm.sqlite3" 'PRAGMA integrity_check;')" || return 1
  rm -f "$dest/realm.sqlite3-wal" "$dest/realm.sqlite3-shm"
  [ "$res" = "ok" ] || { _realm_err "integrity_check on the copy returned: $res"; return 1; }
  python3 -I - "$live" "$dest" <<'PY'
import hashlib, os, sys
live, dest = sys.argv[1], sys.argv[2]
SKIP_DIRS = {"staging", "runpod", "cache", "caches", "renders", "render-cache"}
SKIP_FILES = {"owner.lock", "admission-state.json", ".DS_Store", "realm.sqlite3"}
def skipped(n, isdir):
    return (n in SKIP_DIRS) if isdir else (n in SKIP_FILES or n.endswith(("-wal", "-shm", "-journal")))
def inventory(root):
    out = {}
    for b, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if not skipped(d, True)]
        for f in files:
            if not skipped(f, False):
                out[os.path.relpath(os.path.join(b, f), root)] = os.path.join(b, f)
    return out
a, b = inventory(live), inventory(dest)
if set(a) != set(b):
    sys.stderr.write("copy file set differs: %d missing, %d extra\n" % (len(set(a) - set(b)), len(set(b) - set(a)))); sys.exit(1)
def digest(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    return h.digest()
total = sum(os.path.getsize(p) for p in a.values())
names = sorted(a)
# Everything is hashed when small (<256 MiB); otherwise sizes for all + hashes for a spread sample of 200.
sample = names if total < 256 * 1024 * 1024 else names[:: max(1, len(names) // 200)]
for n in names:
    if os.path.getsize(a[n]) != os.path.getsize(b[n]):
        sys.stderr.write("size mismatch: %s\n" % n); sys.exit(1)
for n in sample:
    if digest(a[n]) != digest(b[n]):
        sys.stderr.write("content mismatch: %s\n" % n); sys.exit(1)
for b_, dirs, files in os.walk(dest):
    for n in dirs:
        if n == "runpod": sys.stderr.write("runpod present in copy\n"); sys.exit(1)
    for n in files:
        if n == "owner.lock":
            if os.path.getsize(os.path.join(b_, n)) != 0:
                sys.stderr.write("owner.lock in the copy is not the fresh empty one\n"); sys.exit(1)
        elif n.endswith(("-wal", "-shm")) or n == "admission-state.json":
            sys.stderr.write("skipped file present in copy: %s\n" % n); sys.exit(1)
print("realm-snapshot: verified %d media files (%d byte-compared), %d bytes" % (len(names), len(sample), total))
PY
}

# This helper uses the Runtime's existing bootstrap.lock and realm admission/owner
# locks. It leaves them before the external attach command, which locks itself.
_realm_handoff() {
  local directory
  directory="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" || return 1
  python3 -I "$directory/realm-handoff.py" "$@"
}
# The release caller always supplies realm_attach_cmd. Standalone SQLite fixtures
# retain their minimal-catalog path inside the same locked publication helper.
# admission-state.json is not copied: stat fingerprints cannot match a copy, so
# Runtime performs deep admission. owner.lock is freshly created and empty (0600).

realm_snapshot_copy() {  # <live_data_root> <dest_data_root>
  local live="${1:-}" dest="${2:-}" info rc rid rdir name stage final catalog_before mode
  [ -n "$dest" ] || { _realm_err "usage: realm_snapshot_copy <live_data_root> <dest_data_root>"; return 2; }
  if [ -z "$live" ] || [ ! -d "$live" ]; then
    _realm_say "no live Astrid install found; the stack starts on the installer's empty workspace (nothing copied)"
    return 0
  fi
  info="$(_realm_resolve_live "$live")"; rc=$?
  if [ "$rc" = 2 ]; then
    _realm_say "no live Astrid realm found; the stack starts on the installer's empty workspace (nothing copied)"
    return 0
  fi
  [ "$rc" = 0 ] || { _realm_err "live realm could not be resolved"; return 1; }
  rid="$(printf '%s' "$info" | cut -f1)"; rdir="$(printf '%s' "$info" | cut -f2)"; name="$(printf '%s' "$info" | cut -f3)"
  dest="$(cd "$dest" 2>/dev/null && pwd -P)" || { _realm_err "destination data root does not exist"; return 1; }
  python3 -I - "$live" "$dest" <<'PY' || { _realm_err "live/destination isolation could not be established"; return 1; }
import os, sys
live, dest = map(os.path.realpath, sys.argv[1:])
if os.path.commonpath((live, dest)) in (live, dest):
    sys.exit("live data and destination overlap; nothing copied or removed")
PY
  [ -f "$dest/runtime/catalog.json" ] || { _realm_err "destination has no runtime/catalog.json (installer step not done?)"; return 1; }
  final="$dest/runtime/realms/$rid"
  [ ! -e "$final" ] || { _realm_err "destination already has realm $rid; refusing to overwrite"; return 1; }
  # Check both PID records and realm ownership early, then repeat at publication.
  catalog_before="$(_realm_handoff check "$dest")" \
    || { _realm_err "destination owner is not proven stopped"; return 1; }
  realm_disk_check "$live" "$dest" || return 1
  mkdir -p "$dest/runtime/realms" && realm_clone_supported "$rdir" "$dest/runtime/realms" \
    || { _realm_err "APFS cloning is not available between the live realm and the destination; refusing to byte-copy the media"; return 1; }

  stage="$dest/runtime/realms/.$rid.snapshot-$$"
  rm -rf "$stage"
  # Database first, then the media: a live write in between can then only add files the copy does not reference,
  # never leave the copied database pointing at media that was not cloned.
  if ! { mkdir -p "$stage" && chmod 700 "$stage" \
        && _realm_backup_db "$rdir/realm.sqlite3" "$stage/realm.sqlite3" \
        && _realm_clone_tree "$rdir" "$stage" \
        && chmod 600 "$stage/realm.sqlite3" \
        && mkdir -p "$stage/staging" "$stage/cas/sha256" \
        && chmod 700 "$stage/staging" "$stage/cas" "$stage/cas/sha256" \
        && : > "$stage/owner.lock" && chmod 600 "$stage/owner.lock"; }; then
    rm -rf "$stage"; _realm_err "snapshot failed; nothing was published"; return 1
  fi
  # Identity: the copied database must carry the id the live catalog advertised.
  if [ "$(sqlite3 "$stage/realm.sqlite3" 'SELECT id FROM realm;' 2>/dev/null)" != "$rid" ]; then
    rm -rf "$stage"; _realm_err "copied database realm id does not match the live catalog"; return 1
  fi
  realm_verify_copy "$rdir" "$stage" || { rm -rf "$stage"; _realm_err "verification failed; nothing was published"; return 1; }
  mode=legacy
  if declare -F realm_attach_cmd >/dev/null; then mode=attach; fi
  # Publish, back up/unselect the empty catalog, and remove only proven-stale
  # advertisements while holding the launcher's mutex and realm ownership locks.
  if ! _realm_handoff publish "$dest" "$stage" "$final" "$catalog_before" "$mode" "$rid" "$name"; then
    rm -rf "$stage"; _realm_err "publication refused; any existing copy and owner records were retained"; return 1
  fi
  if [ "$mode" = attach ]; then
    # No selected catalog is left for ordinary `up` to launch. Release the mutex
    # before workspace attach, which performs its own serialized selection.
    local attach_out attach_rc=0
    attach_out="$(realm_attach_cmd workspace attach --data-root "$dest" --realm-root "$final" --realm-id "$rid" --json 2>&1)" || attach_rc=$?
    if [ "$attach_rc" -ne 0 ] || ! printf '%s' "$attach_out" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"configured_attach"'; then
      if _realm_handoff rollback "$dest" "$rid" "$final"; then
        _realm_err 'the previous catalog was restored; the published copy was retained'
      else
        _realm_err 'catalog restoration refused because destination ownership/selection changed; inspect the retained backup'
      fi
      _realm_err "workspace attach did not report configured_attach (exit $attach_rc): $(printf '%s' "$attach_out" | tail -c 400)"
      _realm_err "copy retained at $final; a normal retry refuses to overwrite it (see README recovery)"; return 1
    fi
  fi
  _realm_say "done: stack now selects the copied realm $rid (the installer's empty realm directory is left in place, unselected)"
}
