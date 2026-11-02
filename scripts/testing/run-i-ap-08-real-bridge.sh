#!/usr/bin/env bash
# I-AP-08: exact-candidate-bound browser bridge/outbox proof.
set -euo pipefail

readonly APP_SHA='13e3ae6522074898f47daadf29f24ec1cbe92d0e'
readonly RUNTIME_SHA='8d3e3af4ede6e3579ac673ae77794464f693bf1b'
readonly AGENT_SHA='a09579d8c87e2b3b7b617b65d49b0551ddd6b9cc'
readonly MANIFEST_SHA256='1a1493587859f13f231df325dc15114c1302288873e1e28ff703d49115bdb973'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
app_root="$(cd -- "$script_dir/../.." && pwd)"
task_dir="${I_AP_08_TASK_DIR:-/home/user/merge/ws/M-APP/queue/running/I-AP-08}"
runtime_source="${I_AP_08_RUNTIME_SOURCE:-/home/user/merge/ws/M-APP/repos/astrid-runtime}"
agent_source="${I_AP_08_AGENT_SOURCE:-/home/user/merge/ws/M-APP/repos/astrid-agent}"
app_dist="${I_AP_08_APP_DIST:-$task_dir/sub/2/dist}"
pip_cache="${I_AP_08_PIP_CACHE:-$task_dir/pip-cache}"

for required in "$task_dir" "$runtime_source" "$agent_source"; do
  if [[ "$required" != /* || ! -d "$required" ]]; then
    printf 'I-AP-08 requires an existing absolute directory: %s\n' "$required" >&2
    exit 64
  fi
done

if [[ "$(git -C "$app_root" rev-parse HEAD)" != "$APP_SHA" ]]; then
  printf 'App HEAD is not the published base %s\n' "$APP_SHA" >&2
  exit 65
fi
if [[ "$(git -C "$runtime_source" rev-parse HEAD)" != "$RUNTIME_SHA" ]]; then
  printf 'Runtime HEAD is not the published tuple %s\n' "$RUNTIME_SHA" >&2
  exit 65
fi
if [[ "$(git -C "$agent_source" rev-parse HEAD)" != "$AGENT_SHA" ]]; then
  printf 'Agent HEAD is not the published tuple %s\n' "$AGENT_SHA" >&2
  exit 65
fi
if [[ "$(sha256sum "$app_root/public/install-manifest.json" | awk '{print $1}')" != "$MANIFEST_SHA256" ]]; then
  printf 'App install manifest is not the candidate manifest %s\n' "$MANIFEST_SHA256" >&2
  exit 65
fi

runtime_python="$task_dir/runtime-venv/bin/python"
if [[ ! -x "$runtime_python" ]]; then
  printf 'Task-local Runtime Python is missing: %s\n' "$runtime_python" >&2
  exit 66
fi
if [[ "$app_dist" != /* || ! -f "$app_dist/index.html" ]]; then
  printf 'Task-local hosted App build is missing: %s\n' "$app_dist" >&2
  exit 66
fi

umask 077
mkdir -p "$task_dir/artifacts/bridge-runs" "$pip_cache"
run_dir="$(mktemp -d "$task_dir/artifacts/bridge-runs/run.XXXXXX")"
version_root="$run_dir/installer-root/versions/old"
runtime_fixture="$version_root/runtime"
agent_fixture="$version_root/agent"
mkdir -p "$runtime_fixture" "$agent_fixture" "$run_dir/xdg" "$run_dir/home" "$run_dir/tmp"
# Chromium in this sandbox traps when TMPDIR's lexical path is outside /tmp.
# The link contains no data: it points to the task-local directory above, so
# all resulting files still live under the task root.
tmp_link="/tmp/i-ap-08-${$}-${RANDOM}"
ln -s "$run_dir/tmp" "$tmp_link"
trap 'rm -f -- "$tmp_link"' EXIT
export HOME="$run_dir/home"
export TMPDIR="$tmp_link"
export XDG_DATA_HOME="$run_dir/xdg"
# Match the selected portable install identity before either Runtime start.
# Runtime snapshots these environment fields at owner startup; the record and
# selected version below intentionally carry the same release/management mode.
export ASTRID_INSTALL_RELEASE=3
export ASTRID_INSTALL_MANAGED_BY=

# Archives preserve the exact commits in physical version children, while all
# generated state, venv links, and installer records stay under the task root.
git -C "$runtime_source" archive --format=tar "$RUNTIME_SHA" | tar -xf - -C "$runtime_fixture"
git -C "$agent_source" archive --format=tar "$AGENT_SHA" | tar -xf - -C "$agent_fixture"
ln -s "$task_dir/runtime-venv" "$runtime_fixture/.venv"

# The Runtime venv is task-local. Install the selected Agent wheel from the
# disposable archive so its authoring profile has its normal dependencies; the
# import path below still selects the archived exact source tree first.
"$runtime_python" -m pip install --cache-dir "$pip_cache" "$agent_fixture" >"$run_dir/agent-wheel-install.log" 2>&1

{
  printf 'app_head=%s\n' "$(git -C "$app_root" rev-parse HEAD)"
  printf 'runtime_source_head=%s\n' "$(git -C "$runtime_source" rev-parse HEAD)"
  printf 'agent_source_head=%s\n' "$(git -C "$agent_source" rev-parse HEAD)"
  printf 'manifest_sha256=%s\n' "$MANIFEST_SHA256"
  printf 'runtime_fixture=%s\n' "$runtime_fixture"
  printf 'agent_fixture=%s\n' "$agent_fixture"
  printf 'installer_identity=release:%s,managed_by:%s\n' "$ASTRID_INSTALL_RELEASE" "${ASTRID_INSTALL_MANAGED_BY:-<none>}"
  sha256sum "$app_root/runtime.lock.json" "$app_root/public/install-manifest.json"
  sha256sum "$app_dist/index.html" "$app_dist/install-manifest.json"
  sha256sum "$runtime_fixture/pyproject.toml" "$agent_fixture/pyproject.toml"
} >"$run_dir/tuple-and-inputs.sha256"

export ASTRID_RUNTIME_CHECKOUT="$runtime_fixture"
export ASTRID_CHECKOUT="$agent_fixture"
export ASTRID_RUNTIME_PYTHON="$runtime_python"
export ASTRID_PYTHON="$runtime_python"
export I_AP_08_INSTALL_ROOT="$run_dir/installer-root"
export ASTRID_APP_DIRECT_DIST="$app_dist"
export PLAYWRIGHT_OUTPUT_DIR="$run_dir/playwright-output"
export IAP08_PLAYWRIGHT_JSON="$run_dir/playwright-results.json"

set +e
(cd "$app_root" && ./node_modules/.bin/playwright test --config config/testing/i-ap-08.playwright.config.ts --workers=1) 2>&1 | tee "$run_dir/playwright.verbose.log"
status="${PIPESTATUS[0]}"
set -e
printf '%s\n' "$status" >"$run_dir/playwright.exit"
printf 'I-AP-08 run directory: %s\n' "$run_dir"
exit "$status"
