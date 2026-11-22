#!/usr/bin/env bash
# Offline fixture backup and verified per-run restore for Plan 77 quick rows.
set -Eeuo pipefail
umask 077

APP="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SANDBOX="${APP}.env/quick-indicator"
readonly APP SANDBOX
fail() { echo "STOP: $*" >&2; exit 1; }
usage='Usage:
  quick-backup-cycle.sh backup SIZE STACK_ROOT REALM_ROOT SUPPORT_ROOT MANIFEST NEW_BUNDLE
  quick-backup-cycle.sh restore-run SIZE BUNDLE EXPECTED_VERSIONS STACK_ROOT REALM_ID SOURCE_MANIFEST PRODUCT_APP EDITOR_PORT PROXY_PORT DOOR_PORT NEW_RESULTS NEW_STARTUP

SIZE is empty, 10, 100, or large. All generated paths must be new paths inside
the tooling checkout .env/quick-indicator sandbox. `large` makes one verified
Runtime backup from the receipt-verified v30 restored source. See README.'
[[ "${1:-}" == --help || "${1:-}" == -h ]] && { echo "$usage"; exit 0; }
mode="${1:-}"; shift || true
[[ "$mode" == backup || "$mode" == restore-run ]] || fail "$usage"
mkdir -p "$SANDBOX"
[[ ! -L "$SANDBOX" && "$(cd -P -- "$SANDBOX" && pwd -P)" == "$SANDBOX" ]] || fail 'quick sandbox must be canonical and not a symlink'
mkdir -p "$SANDBOX/.locks"
[[ ! -L "$SANDBOX/.locks/one-root.lock" ]] || fail 'quick workflow lock path must not be a symlink'
exec 9>"$SANDBOX/.locks/one-root.lock"
flock -n 9 || fail 'another quick root operation is active'
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
runtime_cli() {
  local root version cli
  root="$1"; version="$(cat "$root/program/current" 2>/dev/null || true)"
  [[ -n "$version" ]] || fail 'installed Runtime current version marker is missing'
  cli="$root/program/versions/$version/py/bin/astrid-runtime"
  [[ -x "$cli" ]] || fail "owned installed Runtime CLI is missing: $cli"
  printf '%s' "$cli"
}
size="${1:-}"; shift || true
case "$size" in empty|10|100|large) ;; *) fail 'size must be empty, 10, 100, or large';; esac

if [[ "$mode" == backup ]]; then
  [[ $# == 5 ]] || fail "$usage"
  stack="$(owned_stack "$1")"; realm="$(canonical "$2")"; support="$(canonical "$3")"; manifest="$(canonical "$4")"; bundle="$(fresh_dir "$5")"
  inside "$stack" "$support" || fail 'support root must be within this owned stack'
  [[ "$size" == large ]] || inside "$stack" "$realm" || fail 'realm must be within this owned stack'
  inside "$SANDBOX" "$manifest" || fail 'fixture source manifest must be inside the tooling quick sandbox'
  [[ -f "$manifest" && ! -L "$manifest" ]] || fail 'fixture source manifest is missing or symlinked'
  cli="$(runtime_cli "$stack")"
  mkdir -p "$(dirname -- "$bundle")"; mkdir -m 700 "$bundle"
  backup_root="$realm"
  if [[ "$size" == large ]]; then
    approved='/home/user/codex-run/run/evidence/plan-77/growth-profile/v30-owned-synthetic-restored-realm'
    receipt='/home/user/codex-run/run/evidence/plan-77/growth-profile/v30-restore-receipt.json'
    [[ "$realm" == "$approved" && -d "$approved" && ! -L "$approved" ]] || fail "large source must be the exact approved restored v30 realm: $approved"
    [[ -f "$receipt" && -f "$realm/realm.sqlite3" && ! -e "$realm/realm.sqlite3-wal" && ! -e "$realm/realm.sqlite3-shm" ]] || fail 'approved v30 source is incomplete or has SQLite sidecars'
    [[ -z "$(find "$realm" -type f \( -iname '*auth*key*' -o -iname '*.key' \) -print -quit)" ]] || fail 'v30 source contains a key file; refusing to copy it'
    node - "$receipt" "$realm/realm.sqlite3" <<'NODE' || fail 'approved v30 realm receipt or database digest does not match'
const fs=require('node:fs'),crypto=require('node:crypto');const r=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const hash=crypto.createHash('sha256').update(fs.readFileSync(process.argv[3])).digest('hex');
if(r.destination!=='/home/user/codex-run/run/evidence/plan-77/growth-profile/v30-owned-synthetic-restored-realm'||r.realm_id!=='201c0486-58d8-4d23-b05d-9220c1762120'||r.verification?.database_sha256!=='c0b27bb02c33d5b1e72699749c07adc769dda0c0eb2ceaceab222b630c6e132d'||hash!==r.verification.database_sha256) process.exit(1);
NODE
    backup_root="$stack/quick-v30-source"
    [[ ! -e "$backup_root" && ! -L "$backup_root" ]] || fail 'owned v30 staging path already exists'
    mkdir -m 700 "$backup_root"; cp -a -- "$realm/." "$backup_root/"
    printf 'p77-quick-v30-staging-v1 %s\n' "$backup_root" >"$backup_root/.p77-quick-staging-owned"; chmod 600 "$backup_root/.p77-quick-staging-owned"
    [[ "$(sha256sum "$backup_root/realm.sqlite3" | awk '{print $1}')" == c0b27bb02c33d5b1e72699749c07adc769dda0c0eb2ceaceab222b630c6e132d && ! -e "$backup_root/realm.sqlite3-wal" && ! -e "$backup_root/realm.sqlite3-shm" ]] || fail 'v30 staging copy did not verify cleanly'
  fi
  if [[ "$size" == large && ! -e "$support" ]]; then mkdir -m 700 "$support"; fi
  [[ -d "$support" && ! -L "$support" ]] || fail 'support root must be an owned directory'
  if [[ -e "$support/.p77-quick-support-owned" ]]; then
    [[ "$(cat "$support/.p77-quick-support-owned")" == "p77-quick-support-v1 $support" ]] || fail 'support root ownership marker mismatch'
  else
    if [[ "$size" == large && -n "$(find "$support" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then fail 'fresh v30 support root must be empty until this workflow marks it'; fi
    printf 'p77-quick-support-v1 %s\n' "$support" >"$support/.p77-quick-support-owned"; chmod 600 "$support/.p77-quick-support-owned"
  fi
  runtime_env=(env HOME="$stack/home" XDG_DATA_HOME="$stack/home/.local/share" XDG_STATE_HOME="$stack/home/.local/state")
  "${runtime_env[@]}" "$cli" down --profile astrid --data-root "$stack/data" --json >"$bundle/down.json" 2>"$bundle/down.stderr" || fail 'owned Runtime stop failed; bundle retained for inspection'
  "${runtime_env[@]}" "$cli" backup --root "$backup_root" --support-root "$support" --destination "$bundle/backup" >"$bundle/backup.json" 2>"$bundle/backup.stderr" || fail 'Runtime backup failed; bundle retained'
  backup_ref="$bundle/backup"
  cp -- "$manifest" "$bundle/fixture-manifest.json"
  node - "$stack/stack-info.txt" "$bundle/versions.json" <<'NODE'
const fs=require('node:fs');const [src,dst]=process.argv.slice(2);const fields=Object.fromEntries(fs.readFileSync(src,'utf8').split(/\r?\n/).filter(x=>/^(APP|AGENT|RUNTIME)_SHA=/.test(x)).map(x=>x.split('=')));
fs.writeFileSync(dst,JSON.stringify({app:fields.APP_SHA,agent:fields.AGENT_SHA,runtime:fields.RUNTIME_SHA},null,2)+'\n',{flag:'wx',mode:0o600});
NODE
  chmod 600 "$bundle"/fixture-manifest.json "$bundle"/versions.json "$bundle"/receipt.json "$bundle"/*.json "$bundle"/*.stderr 2>/dev/null || true
  node - "$bundle" "$size" "$stack" "$manifest" "$backup_ref" <<'NODE'
const fs=require('node:fs'),path=require('node:path');
const [bundle,size,stack,manifest,backupRef]=process.argv.slice(2);
const receipt={schema:'plan77-quick-backup-v1',size,stack_root:stack,fixture_manifest:'fixture-manifest.json',versions:'versions.json',source_manifest_path:manifest,backup_ref:backupRef,
  source_manifest_sha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(bundle,'fixture-manifest.json'))).digest('hex'),
  runtime_backup:'backup',runtime_cli_contract:'installed Runtime backup --root --support-root --destination',created_at:new Date().toISOString()};
fs.writeFileSync(path.join(bundle,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
NODE
  echo "Verified backup bundle: $bundle"
  exit 0
fi

[[ $# == 11 ]] || fail "$usage"
bundle="$(canonical "$1")"; expected_versions="$(canonical "$2")"; stack="$(owned_stack "$3" "$expected_versions")"; realm_id="$4"; source_manifest="$(canonical "$5")"; product_app="$(canonical "$6")"
editor_port="$7"; proxy_port="$8"; door_port="$9"; results="$(fresh_dir "${10}")"; startup="$(fresh_dir "${11}")"
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
if(r.size!==size||r.source_manifest_sha256!==crypto.createHash('sha256').update(fs.readFileSync(path.join(bundle,'fixture-manifest.json'))).digest('hex')||!m.project_id||!m.timeline_id) process.exit(1);
if(size==='large'&&m.variant!=='v30'&&m.label!=='heavy seed history, worst case'&&m.variant_label!=='heavy seed history, worst case'&&m.measurement?.label!=='heavy seed history, worst case') process.exit(1);
NODE
available_kib="$(df -Pk "$SANDBOX" | awk 'NR == 2 {print $4}')"; (( available_kib >= 25 * 1024 * 1024 )) || fail 'at least 25 GiB must remain free before restore'
cli="$(runtime_cli "$stack")"; restored="$stack/quick-restored/$(date -u +%Y%m%dT%H%M%SZ)-$size"; data="$stack/quick-data/$(date -u +%Y%m%dT%H%M%SZ)-$size"
[[ ! -e "$restored" && ! -e "$data" ]] || fail 'restore destinations already exist'
mkdir -p "$(dirname -- "$restored")" "$(dirname -- "$data")" "$results"; chmod 700 "$results"
runtime_env=(env HOME="$stack/home" XDG_DATA_HOME="$stack/home/.local/share" XDG_STATE_HOME="$stack/home/.local/state")
backup_ref="$(node -e 'const r=require(process.argv[1]);process.stdout.write(r.backup_ref)' "$bundle/receipt.json")"
[[ "$backup_ref" == "$bundle/backup" ]] || fail 'backup receipt must point to this bundle’s freshly verified Runtime backup'
[[ -d "$backup_ref" && ! -L "$backup_ref" ]] || fail 'bundle backup reference is missing or symlinked'
"${runtime_env[@]}" "$cli" restore --backup "$backup_ref" --destination "$restored" >"$results/restore.json" 2>"$results/restore.stderr" || fail 'Runtime verified restore failed'
"${runtime_env[@]}" "$cli" workspace adopt --profile astrid --data-root "$data" --source-manifest "$source_manifest" --from "$restored" --realm-id "$realm_id" --door-port "$door_port" --json >"$results/adopt.json" 2>"$results/adopt.stderr" || fail 'workspace adopt failed'
"${runtime_env[@]}" "$cli" down --profile astrid --data-root "$data" --door-port "$door_port" --json >"$results/prestart-down.json" 2>"$results/prestart-down.stderr" || fail 'adopted Runtime did not stop cleanly before measured launch'
  cp -- "$bundle/fixture-manifest.json" "$results/manifest.json"; cp -- "$bundle/receipt.json" "$results/backup-receipt.json"; cp -- "$expected_versions" "$results/versions.json"
chmod 600 "$results"/*
export SAVE_LOOP_CHROME
[[ -n "${SAVE_LOOP_CHROME:-}" && -x "$SAVE_LOOP_CHROME" ]] || fail 'SAVE_LOOP_CHROME must be an executable absolute Chrome path'
  SAVE_LOOP_BASE_URL="http://127.0.0.1:$editor_port" SAVE_LOOP_ROOT="$stack" node "$APP/scripts/save-loop/quick-runtime-cycle.mjs" --runtime-cli "$cli" --data-root "$data" --source-manifest "$source_manifest" \
  --product-app "$product_app" --editor-port "$editor_port" --proxy-port "$proxy_port" --door-port "$door_port" \
  --manifest "$results/manifest.json" --versions "$results/versions.json" --results "$results/results.jsonl" \
  --startup-file "$startup" --stack-root "$stack"
