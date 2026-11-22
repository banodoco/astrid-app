#!/usr/bin/env bash
# Offline fixture backup and verified per-run restore for Plan 77 quick rows.
set -Eeuo pipefail
umask 077

APP="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SANDBOX="${APP}.env/quick-indicator"
readonly APP SANDBOX
fail() { echo "STOP: $*" >&2; exit 1; }
usage='Usage:
  quick-backup-cycle.sh backup empty|10|100 STACK_ROOT REALM_ROOT SUPPORT_ROOT MANIFEST NEW_BUNDLE
  quick-backup-cycle.sh backup large STACK_ROOT REALM_ROOT SUPPORT_ROOT MANIFEST NEW_BUNDLE APPROVED_RESTORE_RECEIPT EXPECTED_REALM_UUID EXPECTED_DB_SHA256
  quick-backup-cycle.sh restore-run SIZE BUNDLE EXPECTED_VERSIONS STACK_ROOT SOURCE_MANIFEST PRODUCT_APP NEW_RESULTS NEW_STARTUP

SIZE is empty, 10, 100, or large. All generated paths must be new paths inside
the sibling tooling checkout.env/quick-indicator sandbox. `large` makes one verified
Runtime backup from the receipt-verified v30 restored source. See README.'
[[ "${1:-}" == --help || "${1:-}" == -h ]] && { echo "$usage"; exit 0; }
mode="${1:-}"; shift || true
[[ "$mode" == backup || "$mode" == restore-run ]] || fail "$usage"
mkdir -p "$SANDBOX"
[[ ! -L "$SANDBOX" && "$(cd -P -- "$SANDBOX" && pwd -P)" == "$SANDBOX" ]] || fail 'quick sandbox must be canonical and not a symlink'
LOCKS="$SANDBOX/.locks"
mkdir -p -- "$LOCKS"
[[ ! -L "$LOCKS" && "$(realpath -- "$LOCKS")" == "$LOCKS" ]] || fail 'quick lock directory must be canonical and not symlinked'
[[ ! -L "$LOCKS/one-root.lock" ]] || fail 'quick lock file must not be a symlink'
exec 9>"$LOCKS/one-root.lock"
flock -n 9 || fail 'another quick root operation is active'
LOCK_DIR="$SANDBOX/.quick-operation-lock"; LOCK_MARKER="$LOCK_DIR/owner"
mkdir -m 700 "$LOCK_DIR" 2>/dev/null || fail 'quick runner owner marker already exists; inspect prior operation'
LOCK_OWNER="p77-quick-lock-v1 $$ $SANDBOX $(date +%s%N)"
printf '%s' "$LOCK_OWNER" >"$LOCK_MARKER"; chmod 600 "$LOCK_MARKER"
release_lock() { if [[ -f "$LOCK_MARKER" ]] && [[ "$(cat "$LOCK_MARKER")" == "$LOCK_OWNER" ]]; then rm -f -- "$LOCK_MARKER"; rmdir -- "$LOCK_DIR" 2>/dev/null || true; fi; }
trap release_lock EXIT INT TERM
available_kib="$(df -Pk "$SANDBOX" | awk 'NR == 2 {print $4}')"
[[ "$available_kib" =~ ^[0-9]+$ ]] && (( available_kib >= 25 * 1024 * 1024 )) || fail 'at least 25 GiB free is required'
canonical() {
  [[ "$1" == /* ]] || fail "path must be absolute: $1"
  local p; p="$(realpath -m -- "$1")"
  [[ "$1" == "$p" ]] || fail "path must already be canonical and symlink-free: $1 (resolves to $p)"
  printf '%s' "$p"
}
inside() { [[ "$2" == "$1"/* ]]; }
fresh_dir() {
  local p; p="$(canonical "$1")"; inside "$SANDBOX" "$p" || fail "new path must be inside $SANDBOX: $p"
  [[ ! -e "$p" && ! -L "$p" ]] || fail "result path already exists: $p"
  printf '%s' "$p"
}
owned_stack() {
  local root marker versions expected_file
  root="$(canonical "$1")"; inside "$SANDBOX" "$root" || fail "stack is outside the owned sandbox: $root"
  marker="$root/.sl1-stack-owned"
  [[ -f "$marker" && ! -L "$marker" ]] || fail "missing exact stack marker: $marker"
  [[ "$(cat "$marker")" == "astrid-app-sl1-stack-v1 $root" ]] || fail 'stack ownership marker does not match canonical root'
  versions="$root/stack-info.txt"
  [[ -f "$versions" ]] || fail 'stack-info.txt is missing'
  expected_file="${2:-}"
  if [[ -z "$expected_file" ]]; then
    local app_sha agent_sha runtime_sha
    app_sha="$(sed -n 's/^APP_SHA=//p' "$versions")"; agent_sha="$(sed -n 's/^AGENT_SHA=//p' "$versions")"; runtime_sha="$(sed -n 's/^RUNTIME_SHA=//p' "$versions")"
    [[ "$app_sha" == be9cc2407306eff06252c0d54be1c7f5afcacf3f && "$agent_sha" == 18adee8034973837a97fcd7392cd67f4566fa992 && "$runtime_sha" == d7be2f0458a55c1f26e1138a125ffefe382f56f4 ]] || fail 'backup source stack does not have the exact approved Round 5 product tuple'
  else
    expected_file="$(canonical "$expected_file")"; [[ -f "$expected_file" && ! -L "$expected_file" ]] || fail 'explicit expected versions JSON is missing or symlinked'
    node - "$versions" "$expected_file" <<'NODE' || fail 'owned stack tuple differs from the explicitly selected versions JSON'
const fs=require('node:fs');const lines=Object.fromEntries(fs.readFileSync(process.argv[2],'utf8').split(/\r?\n/).filter(x=>/^(APP|AGENT|RUNTIME)_SHA=/.test(x)).map(x=>x.split('=')));
const want=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
if(!want.app||!want.agent||!want.runtime||lines.APP_SHA!==want.app||lines.AGENT_SHA!==want.agent||lines.RUNTIME_SHA!==want.runtime)process.exit(1);
NODE
  fi
  [[ ! -f "$root/editor.pid" ]] || { local p; p="$(cat "$root/editor.pid")"; [[ ! "$p" =~ ^[0-9]+$ ]] || ! kill -0 "$p" 2>/dev/null || fail 'editor PID is live; stop only through its owning stack supervisor'; }
  for p in "$(sed -n 's/^EDITOR_PORT=//p' "$versions")" "$(sed -n 's/^PROXY_PORT=//p' "$versions")" "$(sed -n 's/^DOOR_PORT=//p' "$versions")"; do
    [[ "$p" =~ ^[0-9]+$ ]] || fail 'stack-info port is missing or invalid'
    if (exec 8<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then exec 8>&- 8<&-; fail "stack port $p is listening; refusing backup while a service may be live"; fi
  done
  printf '%s' "$root"
}
installed_version_dir() {
  local root="$1" version dir
  version="$(cat "$root/program/current" 2>/dev/null || true)"
  [[ "$version" =~ ^[0-9a-f]{12,40}$ ]] || fail 'installed current version marker is invalid'
  dir="$root/program/versions/$version"
  [[ -d "$dir" && ! -L "$dir" && "$(realpath -- "$dir")" == "$dir" ]] || fail 'installed current version directory must be canonical'
  node - "$root/install-manifest.json" "$root/stack-info.txt" <<'NODE' || fail 'installed manifest does not match owned stack Agent/Runtime tuple'
const fs=require('node:fs');const m=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const f=Object.fromEntries(fs.readFileSync(process.argv[3],'utf8').split(/\r?\n/).filter(x=>/^(AGENT|RUNTIME)_SHA=/.test(x)).map(x=>x.split('=')));
if(![f.AGENT_SHA,f.RUNTIME_SHA].every(x=>typeof x==='string'&&/^[0-9a-f]{40}$/.test(x))||m.agent?.sha!==f.AGENT_SHA||m.runtime?.sha!==f.RUNTIME_SHA)process.exit(1);
NODE
  [[ -x "$dir/py/bin/astrid-runtime" && -x "$dir/py/bin/astrid-runtime-protocol" && ! -L "$dir/py/bin/astrid-runtime" && ! -L "$dir/py/bin/astrid-runtime-protocol" ]] || fail 'matching installed lifecycle and protocol sibling CLIs are required'
  printf '%s' "$dir"
}
runtime_cli() { local dir; dir="$(installed_version_dir "$1")"; printf '%s' "$dir/py/bin/astrid-runtime"; }
protocol_cli() { local dir; dir="$(installed_version_dir "$1")"; printf '%s' "$dir/py/bin/astrid-runtime-protocol"; }
size="${1:-}"; shift || true
case "$size" in empty|10|100|large) ;; *) fail 'size must be empty, 10, 100, or large';; esac

if [[ "$mode" == backup ]]; then
  [[ ( "$size" == large && $# == 8 ) || ( "$size" != large && $# == 5 ) ]] || fail "$usage"
  stack="$(owned_stack "$1")"; realm="$(canonical "$2")"; support="$(canonical "$3")"; manifest="$(canonical "$4")"; bundle="$(fresh_dir "$5")"
  expected_realm_id=''; expected_db_sha256=''
  if [[ "$size" == large ]]; then
    receipt="$(canonical "$6")"; expected_realm_id="$7"; expected_db_sha256="$8"
    [[ -f "$receipt" && ! -L "$receipt" ]] || fail 'approved restore receipt must be an existing canonical regular file'
    [[ "$expected_realm_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || fail 'expected realm UUID must be an explicit lowercase UUID'
    [[ "$expected_db_sha256" =~ ^[0-9a-f]{64}$ ]] || fail 'expected database SHA-256 must be explicit lowercase hexadecimal'
    [[ -d "$realm" && ! -L "$realm" && "$(realpath -- "$realm")" == "$realm" ]] || fail 'large source realm must be an existing canonical owned realm directory'
    [[ -f "$realm/realm.sqlite3" && ! -L "$realm/realm.sqlite3" && ! -e "$realm/realm.sqlite3-wal" && ! -e "$realm/realm.sqlite3-shm" ]] || fail 'v30 source is incomplete or has SQLite sidecars'
    [[ -z "$(find "$realm" \( -type f -o -type l \) \( -iname '*auth*key*' -o -iname '*.key' \) -print -quit)" ]] || fail 'v30 source contains a key file; refusing to copy it'
    node - "$receipt" "$realm" "$expected_realm_id" "$expected_db_sha256" <<'NODE' || fail 'approved v30 restore receipt or source database does not match explicit custody values'
const fs=require('node:fs'),crypto=require('node:crypto');
const [receiptFile,realm,expectedRealm,expectedSha]=process.argv.slice(2);
const r=JSON.parse(fs.readFileSync(receiptFile,'utf8'));
const db=realm+'/realm.sqlite3';
const sha=crypto.createHash('sha256').update(fs.readFileSync(db)).digest('hex');
if(r.destination!==realm||r.realm_id!==expectedRealm||
   r.verification?.database_sha256!==expectedSha||sha!==expectedSha) process.exit(1);
NODE
    node - "$manifest" <<'NODE' || fail 'large source manifest is not the exact approved synthetic v30 fixture shape'
const fs=require('node:fs');const m=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const primary=m.clips?.video?.primary;
if(m.media?.synthetic!==true||m.measurement?.clip_count!==300||m.live_proof?.restored_version!==30||
   typeof m.project_id!=='string'||!m.project_id||typeof m.timeline_id!=='string'||!m.timeline_id||
   primary?.clip_id!=='fixture-video-0154'||primary?.track_id!=='V6'||
   m.clips?.shot_occurrences?.length!==10||
   !Array.isArray(m.tracks?.visual)||!Array.isArray(m.tracks?.audio)||
   m.tracks.visual.length+m.tracks.audio.length!==9) process.exit(1);
NODE
  fi
  support_parent="$SANDBOX/support"
  if [[ ! -e "$support_parent" ]]; then mkdir -m 700 "$support_parent"; printf 'p77-quick-support-parent-v1 %s' "$support_parent" >"$support_parent/.p77-quick-support-parent-owned"; fi
  [[ -d "$support_parent" && ! -L "$support_parent" && "$(realpath -- "$support_parent")" == "$support_parent" && -f "$support_parent/.p77-quick-support-parent-owned" && "$(cat "$support_parent/.p77-quick-support-parent-owned")" == "p77-quick-support-parent-v1 $support_parent" ]] || fail 'support parent must be canonical and marker-owned'
  [[ "$(dirname -- "$support")" == "$support_parent" ]] && ! inside "$stack" "$support" || fail 'support root must be a direct child of the dedicated support parent outside the disposable stack'
  [[ "$size" == large ]] || inside "$stack" "$realm" || fail 'realm must be within this owned stack'
  inside "$SANDBOX" "$manifest" || fail 'fixture source manifest must be inside the tooling quick sandbox'
  [[ -f "$manifest" && ! -L "$manifest" ]] || fail 'fixture source manifest is missing or symlinked'
  cli="$(runtime_cli "$stack")"; backup_cli="$(protocol_cli "$stack")"
  mkdir -p "$(dirname -- "$bundle")"; mkdir -m 700 "$bundle"
  backup_root="$realm"
  if [[ "$size" == large ]]; then
    backup_root="$stack/quick-v30-source"
    [[ ! -e "$backup_root" && ! -L "$backup_root" ]] || fail 'owned v30 staging path already exists'
    mkdir -m 700 "$backup_root"; cp -a -- "$realm/." "$backup_root/"
    printf 'p77-quick-v30-staging-v1 %s\n' "$backup_root" >"$backup_root/.p77-quick-staging-owned"; chmod 600 "$backup_root/.p77-quick-staging-owned"
    [[ -f "$backup_root/realm.sqlite3" && ! -L "$backup_root/realm.sqlite3" && ! -e "$backup_root/realm.sqlite3-wal" && ! -e "$backup_root/realm.sqlite3-shm" ]] || fail 'v30 staging copy is incomplete or has SQLite sidecars'
    [[ -z "$(find "$backup_root" \( -type f -o -type l \) \( -iname '*auth*key*' -o -iname '*.key' \) -print -quit)" ]] || fail 'v30 staging copy contains a key file; refusing backup'
    [[ ! -e "$realm/realm.sqlite3-wal" && ! -e "$realm/realm.sqlite3-shm" ]] || fail 'v30 source acquired SQLite sidecars during staging'
    [[ -z "$(find "$realm" \( -type f -o -type l \) \( -iname '*auth*key*' -o -iname '*.key' \) -print -quit)" ]] || fail 'v30 source acquired a key file during staging'
    [[ "$(sha256sum "$backup_root/realm.sqlite3" | awk '{print $1}')" == "$expected_db_sha256" && "$(sha256sum "$realm/realm.sqlite3" | awk '{print $1}')" == "$expected_db_sha256" ]] || fail 'source or staging database digest changed during staging'
  fi
  if [[ ! -e "$support" ]]; then mkdir -m 700 "$support"; fi
  [[ -d "$support" && ! -L "$support" ]] || fail 'support root must be an owned directory'
  if [[ -e "$support/.p77-quick-support-owned" ]]; then
    [[ "$(cat "$support/.p77-quick-support-owned")" == "p77-quick-support-v1 $support" ]] || fail 'support root ownership marker mismatch'
  else
    if [[ -n "$(find "$support" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then fail 'fresh support root must be empty until this workflow marks it'; fi
    printf 'p77-quick-support-v1 %s\n' "$support" >"$support/.p77-quick-support-owned"; chmod 600 "$support/.p77-quick-support-owned"
  fi
  runtime_env=(env HOME="$stack/home" XDG_DATA_HOME="$stack/home/.local/share" XDG_STATE_HOME="$stack/home/.local/state")
  "${runtime_env[@]}" "$cli" down --profile astrid --data-root "$stack/data" --json >"$bundle/down.json" 2>"$bundle/down.stderr" || fail 'owned Runtime stop failed; bundle retained for inspection'
  "${runtime_env[@]}" "$backup_cli" backup --root "$backup_root" --support-root "$support" --destination "$bundle/backup" >"$bundle/backup.json" 2>"$bundle/backup.stderr" || fail 'Runtime protocol backup failed; bundle retained'
  backup_realm_id="$(node -e 'const x=require(process.argv[1]);const id=x.manifest?.realm?.id;if(typeof id!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))process.exit(1);process.stdout.write(id)' "$bundle/backup.json")" || fail 'verified backup did not report a valid manifest realm ID'
  [[ "$size" != large || "$backup_realm_id" == "$expected_realm_id" ]] || fail 'backup realm does not match the explicit v30 custody UUID'
  node - "$bundle/backup/manifest.json" "$backup_realm_id" <<'NODE' || fail 'published backup manifest realm does not match verified receipt'
const fs=require('node:fs');const manifest=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(manifest.realm?.id!==process.argv[3])process.exit(1);
NODE
  backup_ref="$bundle/backup"
  cp -- "$manifest" "$bundle/fixture-manifest.json"
  node - "$stack/stack-info.txt" "$bundle/versions.json" <<'NODE'
const fs=require('node:fs');const [src,dst]=process.argv.slice(2);const fields=Object.fromEntries(fs.readFileSync(src,'utf8').split(/\r?\n/).filter(x=>/^(APP|AGENT|RUNTIME)_SHA=/.test(x)).map(x=>x.split('=')));
fs.writeFileSync(dst,JSON.stringify({app:fields.APP_SHA,agent:fields.AGENT_SHA,runtime:fields.RUNTIME_SHA},null,2)+'\n',{flag:'wx',mode:0o600});
NODE
  chmod 600 "$bundle"/fixture-manifest.json "$bundle"/versions.json "$bundle"/receipt.json "$bundle"/*.json "$bundle"/*.stderr 2>/dev/null || true
node - "$bundle" "$size" "$stack" "$manifest" "$backup_ref" "$backup_realm_id" "$backup_cli" <<'NODE'
const fs=require('node:fs'),path=require('node:path');
const [bundle,size,stack,manifest,backupRef,realmId,protocolCli]=process.argv.slice(2);
const receipt={schema:'plan77-quick-backup-v1',size,stack_root:stack,fixture_manifest:'fixture-manifest.json',versions:'versions.json',source_manifest_path:manifest,backup_ref:backupRef,
  realm_id:realmId,
  source_manifest_sha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(bundle,'fixture-manifest.json'))).digest('hex'),
  runtime_backup:'backup',runtime_protocol_cli:protocolCli,runtime_cli_contract:'same-version sibling astrid-runtime-protocol backup --root --support-root --destination',created_at:new Date().toISOString()};
fs.writeFileSync(path.join(bundle,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
NODE
  chmod 600 "$bundle"/receipt.json
  echo "Verified backup bundle: $bundle"
  exit 0
fi

[[ $# == 7 ]] || fail "$usage"
bundle="$(canonical "$1")"; expected_versions="$(canonical "$2")"; stack="$(owned_stack "$3" "$expected_versions")"; source_manifest="$(canonical "$4")"; product_app="$(canonical "$5")"
results="$(fresh_dir "$6")"; startup="$(fresh_dir "$7")"
inside "$stack" "$results" && inside "$stack" "$startup" || fail 'results and startup output must be inside the new stack root'
inside "$SANDBOX" "$bundle" || fail 'backup bundle must be inside the tooling checkout quick sandbox'
inside "$stack" "$source_manifest" || fail 'initial source manifest must be inside this owned stack'
[[ "${SAVE_LOOP_QUICK_WARM_RELOAD:-0}" != 1 || "$size" == large ]] || fail 'optional warm reload is available only for the heavy v30 row'
[[ -f "$bundle/receipt.json" && -f "$bundle/fixture-manifest.json" ]] || fail 'backup bundle is incomplete'
[[ -f "$source_manifest" && ! -L "$source_manifest" ]] || fail 'initial source manifest is missing or symlinked'
[[ -e "$product_app/.git" ]] || fail 'product App checkout must be an existing clean checkout'
inside "$SANDBOX" "$expected_versions" || fail 'explicit expected versions JSON must be inside the tooling checkout quick sandbox'
app_sha="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).app)' "$expected_versions")"
[[ "$(git -C "$product_app" rev-parse HEAD)" == "$app_sha" ]] || fail 'clean product App checkout does not match the explicitly selected App revision'
[[ -z "$(git -C "$product_app" status --porcelain --untracked-files=normal)" ]] || fail 'product App checkout must be clean'
node - "$bundle" "$size" <<'NODE' || fail 'bundle size or manifest does not match requested row'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const [bundle,size]=process.argv.slice(2),r=JSON.parse(fs.readFileSync(path.join(bundle,'receipt.json'),'utf8'));
const m=JSON.parse(fs.readFileSync(path.join(bundle,'fixture-manifest.json'),'utf8'));
if(r.size!==size||!r.realm_id||r.source_manifest_sha256!==crypto.createHash('sha256').update(fs.readFileSync(path.join(bundle,'fixture-manifest.json'))).digest('hex')||!m.project_id||!m.timeline_id) process.exit(1);
if(size==='large'&&m.variant!=='v30'&&m.label!=='heavy seed history, worst case'&&m.variant_label!=='heavy seed history, worst case'&&m.measurement?.label!=='heavy seed history, worst case') process.exit(1);
NODE
available_kib="$(df -Pk "$SANDBOX" | awk 'NR == 2 {print $4}')"; (( available_kib >= 25 * 1024 * 1024 )) || fail 'at least 25 GiB must remain free before restore'
cli="$(runtime_cli "$stack")"; restore_cli="$(protocol_cli "$stack")"
editor_port="$(sed -n 's/^EDITOR_PORT=//p' "$stack/stack-info.txt")"; proxy_port="$(sed -n 's/^PROXY_PORT=//p' "$stack/stack-info.txt")"; door_port="$(sed -n 's/^DOOR_PORT=//p' "$stack/stack-info.txt")"
realm_id="$(node -e 'const r=require(process.argv[1]);process.stdout.write(r.realm_id)' "$bundle/receipt.json")"
stamp="$(date -u +%Y%m%dT%H%M%SZ)-$size-$$"
restored="$stack/quick-restored/$stamp"; data="$stack/quick-data/$stamp"
[[ ! -e "$restored" && ! -e "$data" ]] || fail 'restore destinations already exist'
for parent in "$stack/quick-restored" "$stack/quick-data"; do
  if [[ ! -e "$parent" && ! -L "$parent" ]]; then mkdir -m 700 "$parent"; printf 'plan77-quick-restore-root-v1 %s' "$parent" >"$parent/.p77-quick-restore-root-owned"; chmod 600 "$parent/.p77-quick-restore-root-owned"; fi
  [[ -d "$parent" && ! -L "$parent" && "$(realpath -- "$parent")" == "$parent" && -f "$parent/.p77-quick-restore-root-owned" && "$(cat "$parent/.p77-quick-restore-root-owned")" == "plan77-quick-restore-root-v1 $parent" ]] || fail "generated restore parent is not marker-owned: $parent"
done
mkdir -m 700 "$results"; chmod 700 "$results"
runtime_env=(env HOME="$stack/home" XDG_DATA_HOME="$stack/home/.local/share" XDG_STATE_HOME="$stack/home/.local/state")
backup_ref="$(node -e 'const r=require(process.argv[1]);process.stdout.write(r.backup_ref)' "$bundle/receipt.json")"
[[ "$backup_ref" == "$bundle/backup" ]] || fail 'backup receipt must point to this bundle’s freshly verified Runtime backup'
[[ -d "$backup_ref" && ! -L "$backup_ref" ]] || fail 'bundle backup reference is missing or symlinked'
"${runtime_env[@]}" "$restore_cli" restore --backup "$backup_ref" --destination "$restored" >"$results/restore.json" 2>"$results/restore.stderr" || fail 'Runtime protocol verified restore failed'
restored_realm="$(node -e 'const r=require(process.argv[1]);const id=r.realm_id;if(typeof id!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)||r.verification?.realm?.id!==id)process.exit(1);process.stdout.write(id)' "$results/restore.json")" || fail 'verified restore realm identity is invalid or inconsistent'
[[ "$restored_realm" == "$realm_id" ]] || fail 'restored realm ID does not match the verified backup receipt'
"${runtime_env[@]}" "$cli" workspace adopt --profile astrid --data-root "$data" --source-manifest "$source_manifest" --from "$restored" --realm-id "$realm_id" --door-port "$door_port" --json >"$results/adopt.json" 2>"$results/adopt.stderr" || fail 'workspace adopt failed'
"${runtime_env[@]}" "$cli" down --profile astrid --data-root "$data" --door-port "$door_port" --json >"$results/prestart-down.json" 2>"$results/prestart-down.stderr" || fail 'adopted Runtime did not stop cleanly before measured launch'
  cp -- "$bundle/fixture-manifest.json" "$results/manifest.json"; cp -- "$bundle/receipt.json" "$results/backup-receipt.json"; cp -- "$expected_versions" "$results/versions.json"
chmod 600 "$results"/*
export SAVE_LOOP_CHROME
[[ -n "${SAVE_LOOP_CHROME:-}" && -x "$SAVE_LOOP_CHROME" ]] || fail 'SAVE_LOOP_CHROME must be an executable absolute Chrome path'
SAVE_LOOP_BASE_URL="http://127.0.0.1:$editor_port" SAVE_LOOP_ROOT="$stack" SAVE_LOOP_QUICK_LOCK_OWNER="$LOCK_OWNER" node "$APP/scripts/save-loop/quick-runtime-cycle.mjs" --runtime-cli "$cli" --data-root "$data" --source-manifest "$source_manifest" \
  --product-app "$product_app" --editor-port "$editor_port" --proxy-port "$proxy_port" --door-port "$door_port" \
  --manifest "$results/manifest.json" --versions "$results/versions.json" --results "$results/results.jsonl" \
  --startup-file "$startup" --stack-root "$stack"
