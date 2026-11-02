#!/usr/bin/env bash
# I-AP-08: exact published-base browser bridge/outbox proof.
set -euo pipefail

readonly RUNTIME_SOURCE_SHA='8d3e3af4ede6e3579ac673ae77794464f693bf1b'
readonly RUNTIME_PRODUCT_SHA='2776ba973b6c8f3555b5629b0840d9691a98d3c2'
readonly AGENT_CANDIDATE_SHA='ab43bad818ef65ca1e929b973a2f61cd9fc4bf61'
readonly AGENT_HARNESS_SHA='ab43bad818ef65ca1e929b973a2f61cd9fc4bf61'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
app_root="$(cd -- "$script_dir/../.." && pwd)"
task_dir="${I_AP_08_TASK_DIR:-/home/user/merge/ws/M-APP/queue/running/I-AP-08}"
runtime_source="${I_AP_08_RUNTIME_SOURCE:-/home/user/merge/ws/M-APP/repos/astrid-runtime}"
agent_source="${I_AP_08_AGENT_SOURCE:-/home/user/merge/ws/M-APP/repos/astrid-agent}"
# A proof must name the exact commit it intends to exercise. Never accept a
# caller-provided build: build from a git archive of that commit below.
APP_SHA="${I_AP_08_APP_SHA:-}"
if [[ ! "$APP_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'I_AP_08_APP_SHA must be the full expected App commit SHA\n' >&2
  exit 64
fi
if [[ -n "${I_AP_08_APP_DIST+x}" || -n "${ASTRID_APP_DIRECT_DIST+x}" ]]; then
  printf 'Caller-supplied App dist is not accepted; the runner builds the exact App commit\n' >&2
  exit 65
fi

for required in "$task_dir" "$runtime_source" "$agent_source"; do
  if [[ "$required" != /* || ! -d "$required" ]]; then
    printf 'I-AP-08 requires an existing absolute directory: %s\n' "$required" >&2
    exit 64
  fi
done

if [[ "$(git -C "$app_root" rev-parse HEAD)" != "$APP_SHA" ]]; then
  printf 'App HEAD does not match expected commit %s\n' "$APP_SHA" >&2
  exit 65
fi
if [[ -n "$(git -C "$app_root" status --porcelain --untracked-files=all)" ]]; then
  printf 'App checkout must be clean for exact-head proof\n' >&2
  exit 65
fi
if [[ "$(git -C "$runtime_source" rev-parse HEAD)" != "$RUNTIME_SOURCE_SHA" ]]; then
  printf 'Runtime source HEAD is not the published source %s\n' "$RUNTIME_SOURCE_SHA" >&2
  exit 65
fi
if ! git -C "$runtime_source" cat-file -e "$RUNTIME_PRODUCT_SHA^{commit}"; then
  printf 'Runtime product is unavailable from the published source: %s\n' "$RUNTIME_PRODUCT_SHA" >&2
  exit 65
fi
if [[ "$(git -C "$agent_source" rev-parse HEAD)" != "$AGENT_HARNESS_SHA" ]]; then
  printf 'Agent harness HEAD is not the published harness %s\n' "$AGENT_HARNESS_SHA" >&2
  exit 65
fi

manifest_tuple="$(node -e 'const manifest = require(process.argv[1]); process.stdout.write(`${manifest.runtime?.sha ?? ""} ${manifest.agent?.sha ?? ""}`)' "$app_root/public/install-manifest.json")"
if [[ "$manifest_tuple" != "$RUNTIME_PRODUCT_SHA $AGENT_CANDIDATE_SHA" ]]; then
  printf 'App manifest does not pin the exact Runtime product and Agent candidate\n' >&2
  exit 65
fi

runtime_python="$task_dir/runtime-venv/bin/python"
if [[ ! -x "$runtime_python" ]]; then
  printf 'Task-local Runtime Python is missing: %s\n' "$runtime_python" >&2
  exit 66
fi

umask 077
mkdir -p "$task_dir/artifacts/bridge-runs"
run_dir="$(mktemp -d "$task_dir/artifacts/bridge-runs/run.XXXXXX")"
version_root="$run_dir/installer-root/versions/old"
runtime_fixture="$version_root/runtime"
agent_fixture="$version_root/agent"
mkdir -p "$runtime_fixture" "$agent_fixture" "$run_dir/xdg" "$run_dir/home" "$run_dir/tmp" "$run_dir/app-source"
# Both build and test code come from the named commit, not from an arbitrary
# dist, installed modules, or ignored files in the checkout.
git -C "$app_root" archive --format=tar "$APP_SHA" | tar -xf - -C "$run_dir/app-source"
app_dist="$run_dir/app-source/dist"
app_tree="$(git -C "$app_root" rev-parse "$APP_SHA^{tree}")"
# Keep the build environment narrow so caller VITE_/ASTRID_ overrides cannot
# silently select a different source. The chosen door port is recorded below.
build_env=(env -i PATH="$PATH" HOME="$run_dir/home" TMPDIR="$run_dir/tmp"
  NPM_CONFIG_USERCONFIG=/dev/null npm_config_cache="${npm_config_cache:-${MERGE_CACHE:-/home/user/merge/cache}/npm}"
  HTTPS_PROXY="${HTTPS_PROXY:-}" HTTP_PROXY="${HTTP_PROXY:-}" NO_PROXY="${NO_PROXY:-}"
  NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-}"
  NODE_OPTIONS=--max-old-space-size=8192
  VITE_APP_BUILD="$APP_SHA" RAILWAY_GIT_COMMIT_SHA="$APP_SHA"
  ASTRID_APP_DIRECT_DOOR_PORT="${ASTRID_APP_DIRECT_DOOR_PORT:-17340}")
(cd "$run_dir/app-source" && "${build_env[@]}" npm ci) >"$run_dir/npm-ci.log" 2>&1
(cd "$run_dir/app-source" && "${build_env[@]}" npm run build:hosted) >"$run_dir/build.log" 2>&1
[[ -f "$app_dist/index.html" ]] || { printf 'Hosted build missing index.html\n' >&2; exit 66; }
node "$run_dir/app-source/scripts/testing/i-ap-08-build-identity.mjs" "$APP_SHA" "$app_dist/build.json"
cmp "$run_dir/app-source/public/install-manifest.json" "$app_dist/install-manifest.json"
if [[ -n "$(find "$app_dist" ! -type d ! -type f -print -quit)" ]]; then
  printf 'Hosted build contains a non-regular entry\n' >&2
  exit 65
fi
(cd "$app_dist" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) >"$run_dir/dist.sha256"
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
git -C "$runtime_source" archive --format=tar "$RUNTIME_PRODUCT_SHA" | tar -xf - -C "$runtime_fixture"
git -C "$agent_source" archive --format=tar "$AGENT_HARNESS_SHA" | tar -xf - -C "$agent_fixture"
ln -s "$task_dir/runtime-venv" "$runtime_fixture/.venv"

# The Runtime venv is task-local.  Install the published Agent wheel from the
# disposable archive so its authoring profile has its normal dependencies; the
# import path below still selects the archived exact source tree first.
"$runtime_python" -m pip install "$agent_fixture" >"$run_dir/agent-wheel-install.log" 2>&1

{
  printf 'app_head=%s\n' "$APP_SHA"
  printf 'app_tree=%s\n' "$app_tree"
  printf 'app_build=git-archive,npm-run-build:hosted\n'
  printf 'app_build_node=%s\n' "$(node --version)"
  printf 'app_build_npm=%s\n' "$(npm --version)"
  printf 'app_build_door_port=%s\n' "${ASTRID_APP_DIRECT_DOOR_PORT:-17340}"
  sha256sum "$run_dir/app-source/package-lock.json" "$run_dir/dist.sha256"
  printf 'runtime_source_head=%s\n' "$(git -C "$runtime_source" rev-parse HEAD)"
  printf 'runtime_product_sha=%s\n' "$RUNTIME_PRODUCT_SHA"
  printf 'agent_candidate_sha=%s\n' "$AGENT_CANDIDATE_SHA"
  printf 'agent_harness_sha=%s\n' "$AGENT_HARNESS_SHA"
  printf 'agent_source_head=%s\n' "$(git -C "$agent_source" rev-parse HEAD)"
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
export I_AP_08_APP_SHA="$APP_SHA"
export I_AP_08_INSTALL_ROOT="$run_dir/installer-root"
export ASTRID_APP_DIRECT_DIST="$app_dist"
export PLAYWRIGHT_OUTPUT_DIR="$run_dir/playwright-output"
export IAP08_PLAYWRIGHT_JSON="$run_dir/playwright-results.json"

set +e
(cd "$run_dir/app-source" && ./node_modules/.bin/playwright test --config config/testing/i-ap-08.playwright.config.ts --workers=1) 2>&1 | tee "$run_dir/playwright.verbose.log"
status="${PIPESTATUS[0]}"
set -e
printf '%s\n' "$status" >"$run_dir/playwright.exit"
if [[ -n "$(find "$app_dist" ! -type d ! -type f -print -quit)" ]]; then
  printf 'Hosted build contains a non-regular entry after the journey\n' >"$run_dir/dist-verify.log"
  status=1
else
  (cd "$app_dist" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) >"$run_dir/dist-after.sha256"
  cmp "$run_dir/dist.sha256" "$run_dir/dist-after.sha256" >"$run_dir/dist-verify.log" 2>&1 || status=1
fi
printf 'I-AP-08 run directory: %s\n' "$run_dir"
exit "$status"
