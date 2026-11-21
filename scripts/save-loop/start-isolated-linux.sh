#!/usr/bin/env bash
# Build and launch the SL-1 disposable Linux stack from this App checkout.
set -Eeuo pipefail
umask 077

APP="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SCRATCH="${SL1_SCRATCH:-${APP}.env}"
ROOT="$SCRATCH/stack"
OMP_REPO="$SCRATCH/omp-source-cache"
OWNERSHIP_MARKER="$ROOT/.sl1-stack-owned"
fail() { echo "STOP: $*" >&2; exit 1; }
[[ "$SCRATCH" == /* ]] || fail 'SL1_SCRATCH must be an absolute path.'
mkdir -p "$SCRATCH"
[[ ! -L "$SCRATCH" && "$(cd -P -- "$SCRATCH" && pwd -P)" == "$SCRATCH" ]] \
  || fail "Scratch path must be canonical and contain no symlink: $SCRATCH"

available_kib="$(df -Pk /home/user | awk 'NR == 2 {print $4}')"
if (( available_kib < 15 * 1024 * 1024 )); then
  fail "only $((available_kib / 1024)) MiB free on /home/user (need at least 15 GiB)."
fi

owned_editor_matches() {
  local pid="$1" args cwd
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null || return 1
  args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  [[ "$args" == *"dev-local-workspace.mjs"* && "$args" == *"$ROOT/data"* && "$cwd" == "$APP" ]]
}

if [[ -e "$ROOT" || -L "$ROOT" ]]; then
  [[ ! -L "$ROOT" && -f "$OWNERSHIP_MARKER" ]] \
    || fail "Refusing to remove an unowned or symlinked stack root: $ROOT"
  [[ "$(cat "$OWNERSHIP_MARKER")" == "astrid-app-sl1-stack-v1 $ROOT" ]] \
    || fail "Stack ownership marker does not match this root: $ROOT"
  if [[ -f "$ROOT/editor.pid" ]]; then
    editor_pid="$(cat "$ROOT/editor.pid")"
    if [[ "$editor_pid" =~ ^[0-9]+$ ]] && kill -0 "$editor_pid" 2>/dev/null; then
      owned_editor_matches "$editor_pid" \
        || fail "Stored editor PID $editor_pid is live but does not match this stack; refusing to stop or remove it."
      kill -TERM "$editor_pid"
      for _ in $(seq 1 20); do kill -0 "$editor_pid" 2>/dev/null || break; sleep 1; done
      kill -0 "$editor_pid" 2>/dev/null && fail "Stored editor PID $editor_pid did not stop cleanly."
      wait "$editor_pid" 2>/dev/null || true
    fi
  fi
  version="$(cat "$ROOT/program/current" 2>/dev/null || true)"
  runtime_cli="$ROOT/program/versions/$version/py/bin/astrid-runtime"
  if [[ -n "$version" && -x "$runtime_cli" ]]; then
    HOME="$ROOT/home" XDG_DATA_HOME="$ROOT/home/.local/share" XDG_STATE_HOME="$ROOT/home/.local/state" \
      "$runtime_cli" down --profile astrid --data-root "$ROOT/data" --json \
      >"$ROOT/logs/runtime-stop.log" 2>&1 || fail "Could not stop this stack's Runtime; see $ROOT/logs/runtime-stop.log"
  fi
  log_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  for entry in \
    'logs/install.log:install-stdout' \
    'home/.local/state/astrid-runtime/logs/install.log:install-details' \
    'logs/npm-ci.log:npm-ci' \
    'logs/editor.log:editor'; do
    source_path="$ROOT/${entry%%:*}"
    log_name="${entry#*:}"
    if [[ -f "$source_path" ]]; then
      prior_log="$SCRATCH/${log_name}-prior-${log_stamp}.log"
      cp "$source_path" "$prior_log"
      chmod 600 "$prior_log"
      echo "Preserved prior $log_name log: $prior_log"
    fi
  done
  echo "Removing this script's previous disposable stack root: $ROOT"
  rm -rf -- "$ROOT"
fi
mkdir -p "$ROOT/home" "$ROOT/tmp" "$ROOT/logs"
chmod 700 "$ROOT" "$ROOT/home" "$ROOT/tmp" "$ROOT/logs"
printf 'astrid-app-sl1-stack-v1 %s' "$ROOT" > "$OWNERSHIP_MARKER"
chmod 600 "$OWNERSHIP_MARKER"

KEEP_STACK=0
cleanup_failed_launch() {
  result=$?
  (( result == 0 || KEEP_STACK == 1 )) && return 0
  if [[ -f "$ROOT/editor.pid" ]]; then
    pid="$(cat "$ROOT/editor.pid")"
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
      if owned_editor_matches "$pid"; then
        kill -TERM "$pid" 2>/dev/null || true
        for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
        wait "$pid" 2>/dev/null || true
      fi
    fi
  fi
  version="$(cat "$ROOT/program/current" 2>/dev/null || true)"
  runtime_cli="$ROOT/program/versions/$version/py/bin/astrid-runtime"
  if [[ -n "$version" && -x "$runtime_cli" ]]; then
    HOME="$ROOT/home" XDG_DATA_HOME="$ROOT/home/.local/share" XDG_STATE_HOME="$ROOT/home/.local/state" \
      "$runtime_cli" down --profile astrid --data-root "$ROOT/data" --json \
      >"$ROOT/logs/runtime-stop-on-failure.log" 2>&1 || true
  fi
}
trap cleanup_failed_launch EXIT

# Match the release runbook's three isolated loopback ports without claiming its protected ports.
pick_port() {
  node --input-type=module - "$1" "$2" <<'NODE'
import net from 'node:net';
const [first, last] = process.argv.slice(2);
const protectedPorts = new Set([17340, 2222, 17336, 17391]);
const probe = (port) => new Promise((resolve) => {
  const server = net.createServer();
  server.once('error', () => resolve(false));
  server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
});
for (let p = Number(first); p <= Number(last); p++) {
  if (protectedPorts.has(p)) continue;
  if (await probe(p)) { console.log(p); process.exit(0); }
}
throw new Error(`No free port in ${first}-${last}`);
NODE
}
EDITOR_PORT="$(pick_port 2400 2499)"
PROXY_PORT="$(pick_port 17500 17599)"
DOOR_PORT="$(pick_port "$((PROXY_PORT + 1))" 17599)"
printf '%s\n' "$EDITOR_PORT,$PROXY_PORT,$DOOR_PORT" > "$ROOT/ports"

mapfile -t source_pins < <(node --input-type=module - "$APP" <<'NODE'
import fs from 'node:fs';
const app = process.argv[2];
const agent = JSON.parse(fs.readFileSync(`${app}/public/install-manifest.json`, 'utf8')).agent?.sha;
const runtime = JSON.parse(fs.readFileSync(`${app}/runtime.lock.json`, 'utf8')).source_commit;
if (!/^[0-9a-f]{40}$/.test(agent ?? '') || !/^[0-9a-f]{40}$/.test(runtime ?? '')) {
  throw new Error('App install manifest and Runtime lock must contain full commit SHAs');
}
console.log(agent);
console.log(runtime);
NODE
)
[[ "${#source_pins[@]}" == 2 ]] || fail 'Could not read the committed App Agent and Runtime pins.'
AGENT_SHA="${source_pins[0]}"
RUNTIME_SHA="${source_pins[1]}"
MANIFEST="$ROOT/install-manifest.json"
node "$APP/scripts/installer/pin.mjs" "$AGENT_SHA" --in "$APP/public/install-manifest.json" --out "$MANIFEST"
node --input-type=module - "$MANIFEST" "$AGENT_SHA" "$RUNTIME_SHA" <<'NODE'
import fs from 'node:fs';
const [file, agent, runtime] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync(file, 'utf8'));
if (m.agent?.sha !== agent || m.runtime?.sha !== runtime) {
  throw new Error(`Pinned manifest mismatch: agent=${m.agent?.sha} runtime=${m.runtime?.sha}`);
}
NODE
omp_pin="$(node --input-type=module - "$MANIFEST" <<'NODE'
import fs from 'node:fs';
const [file] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync(file, 'utf8'));
const source = m.tools?.omp?.source;
if (typeof source === 'string') process.exit(0);
const repo = source?.repo, sha = source?.sha;
if (typeof repo !== 'string' || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/.test(repo)
    || !/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('Derived OMP repo and SHA are not an anchored pinned GitHub source');
console.log(`${repo}\t${sha}`);
NODE
)"
if [[ -n "$omp_pin" ]]; then
  IFS=$'\t' read -r OMP_REMOTE OMP_SHA <<< "$omp_pin"
  mkdir -p "$OMP_REPO"
  [[ ! -L "$OMP_REPO" && ! -L "$OMP_REPO/.git" ]] || fail "OMP source cache must not be symlinked: $OMP_REPO"
  if [[ ! -d "$OMP_REPO/.git" ]]; then
    git -C "$OMP_REPO" init --quiet
    git -C "$OMP_REPO" remote add origin "$OMP_REMOTE"
  fi
  cached_remote="$(git -C "$OMP_REPO" remote get-url origin)"
  cached_remote="${cached_remote%.git}"; cached_remote="${cached_remote%/}"
  normalized_remote="${OMP_REMOTE%.git}"; normalized_remote="${normalized_remote%/}"
  [[ "$cached_remote" == "$normalized_remote" ]] \
    || fail "OMP source cache origin does not match the derived pin: $OMP_REPO"
  if ! git -C "$OMP_REPO" cat-file -e "$OMP_SHA^{commit}" 2>/dev/null; then
    git -C "$OMP_REPO" fetch --no-tags --depth=1 origin "$OMP_SHA"
  fi
  [[ "$(git -C "$OMP_REPO" rev-parse "$OMP_SHA^{commit}")" == "$OMP_SHA" ]] \
    || fail 'Fetched OMP source did not resolve to the derived commit.'
  node --input-type=module - "$MANIFEST" "$OMP_REPO" "$OMP_SHA" <<'NODE'
import fs from 'node:fs';
const [file, repository, sha] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync(file, 'utf8'));
if (m.tools?.omp?.source?.sha !== sha) throw new Error('Derived OMP SHA changed before local source selection');
m.tools.omp.source.repo = repository;
fs.writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
NODE
fi
node --input-type=module - "$MANIFEST" "$AGENT_SHA" "$RUNTIME_SHA" <<'NODE'
import fs from 'node:fs';
const [file, agent, runtime] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync(file, 'utf8'));
if (m.agent?.sha !== agent || m.runtime?.sha !== runtime) {
  throw new Error(`Pinned manifest mismatch: agent=${m.agent?.sha} runtime=${m.runtime?.sha}`);
}
NODE

export HOME="$ROOT/home"
export TMPDIR="$ROOT/tmp"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_STATE_HOME="$HOME/.local/state"
export XDG_CACHE_HOME="$HOME/.cache"
export XDG_CONFIG_HOME="$HOME/.config"

ASTRID_RUNTIME_DOOR_PORT="$DOOR_PORT" sh "$APP/public/install" --root "$ROOT/program" --data-root "$ROOT/data" \
  --yes --autostart off --command off --skills off --skill-copies off --no-browser --manifest "$MANIFEST" \
  2>&1 | tee "$ROOT/logs/install.log"

(cd "$APP" && npm ci 2>&1 | tee "$ROOT/logs/npm-ci.log")

cd "$APP"
nohup env PORT="$EDITOR_PORT" VITE_ASTRID_DYNAMIC_PROXY_PORT="$PROXY_PORT" \
  node "$APP/scripts/dev-local-workspace.mjs" --data-root "$ROOT/data" \
  </dev/null \
  >"$ROOT/logs/editor.log" 2>&1 &
EDITOR_PID=$!
printf '%s\n' "$EDITOR_PID" > "$ROOT/editor.pid"

editor_ready=0
for _ in $(seq 1 180); do
  if curl --silent --fail "http://127.0.0.1:$EDITOR_PORT/tools/video-editor?connect=1" >/dev/null; then editor_ready=1; break; fi
  sleep 1
done
[[ "$editor_ready" == 1 ]] || fail "Editor did not become ready; see $ROOT/logs/editor.log"
kill -0 "$EDITOR_PID" 2>/dev/null || fail "Stored editor PID $EDITOR_PID exited before readiness."
owned_editor_matches "$EDITOR_PID" \
  || fail "Stored editor PID $EDITOR_PID does not identify this stack's dev-local-workspace process."

node --input-type=module - "$EDITOR_PORT" "$ROOT/sandbox.json" <<'NODE'
import fs from 'node:fs';
const [port, output] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}/api/runtime`;
const post = async (path, key, value) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(value),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`POST ${path} returned ${response.status}: ${JSON.stringify(body)}`);
  return body.data;
};
const project = await post('/v1/projects', 'sl1-sandbox-project-v1', {
  name: 'SL-1 Empty Sandbox', slug: 'sl-1-empty-sandbox',
  metadata: { purpose: 'SL-1 isolated save-loop fixture' },
});
const timeline = await post(`/v1/projects/${encodeURIComponent(project.project_id)}/timelines`,
  'sl1-sandbox-timeline-v1', { timeline_id: 'sl-1-empty-timeline', name: 'SL-1 Empty Timeline' });
const result = {
  projectId: project.project_id,
  projectName: project.name,
  timelineId: timeline.timeline_id,
  timelineName: timeline.name,
  timelineHeadRevisionId: timeline.head_revision_id,
};
fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(`Created sandbox project ${result.projectId} with empty timeline ${result.timelineId}`);
NODE

mapfile -t sandbox_ids < <(node --input-type=module - "$ROOT/sandbox.json" <<'NODE'
import fs from 'node:fs';
const sandbox = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (typeof sandbox.projectId !== 'string' || typeof sandbox.timelineId !== 'string') {
  throw new Error('Sandbox manifest is missing project or timeline ID');
}
console.log(sandbox.projectId);
console.log(sandbox.timelineId);
NODE
)
[[ "${#sandbox_ids[@]}" == 2 ]] || fail 'Sandbox manifest did not provide a project and timeline ID.'
PROJECT_ID="${sandbox_ids[0]}"
TIMELINE_ID="${sandbox_ids[1]}"
EDITOR_URL="http://127.0.0.1:$EDITOR_PORT/tools/video-editor?connect=1&project=$PROJECT_ID&timeline=$TIMELINE_ID"
APP_SHA="$(git -C "$APP" rev-parse HEAD)"
printf 'STACK_ROOT=%s\nAPP_SHA=%s\nAGENT_SHA=%s\nRUNTIME_SHA=%s\nEDITOR_PORT=%s\nPROXY_PORT=%s\nDOOR_PORT=%s\nPROJECT_ID=%s\nTIMELINE_ID=%s\nEDITOR_URL=%s\n' \
  "$ROOT" "$APP_SHA" "$AGENT_SHA" "$RUNTIME_SHA" "$EDITOR_PORT" "$PROXY_PORT" "$DOOR_PORT" "$PROJECT_ID" "$TIMELINE_ID" "$EDITOR_URL" \
  | tee "$ROOT/stack-info.txt"
echo "Editor URL: $EDITOR_URL"
echo "Logs: $ROOT/logs"
KEEP_STACK=1
