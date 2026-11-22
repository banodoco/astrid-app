#!/usr/bin/env bash
# Opt-in synthetic save-loop run; all generated state stays in a new directory.
set -Eeuo pipefail
umask 077
APP="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
usage='Usage: SAVE_LOOP_CHROME=/absolute/path/to/chrome scripts/save-loop/run.sh [--variant large-shots]

Creates a new isolated stack and synthetic fixture, then stops the stack.
Quick fixtures use the separately prepared product-checkout builder workflow.'
if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then echo "$usage"; exit 0; fi
variant=standard
if [[ $# == 2 && "$1" == --variant && "$2" == large-shots ]]; then variant=large-shots
elif [[ $# != 0 ]]; then echo "$usage" >&2; exit 2; fi
fail() { echo "STOP: $*" >&2; exit 1; }
case "$(uname -s)" in Linux|Darwin) ;; *) fail 'Linux or macOS is required.' ;; esac
for cmd in node npm git curl ffmpeg df; do command -v "$cmd" >/dev/null || fail "$cmd is required."; done
[[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 20 ]] || fail 'Node 20 or newer is required.'
[[ -n "${SAVE_LOOP_CHROME:-}" && "$SAVE_LOOP_CHROME" == /* && -x "$SAVE_LOOP_CHROME" ]] || fail 'Set SAVE_LOOP_CHROME to an absolute executable Chrome/Chromium path.'
[[ -f "$APP/scripts/save-loop/build-fixture.mjs" ]] || fail 'The SL-0 build-fixture.mjs is required.'
[[ -z "$(git -C "$APP" status --porcelain --untracked-files=normal)" ]] || fail 'Use a clean committed App checkout.'
base="${SAVE_LOOP_RUNS_DIR:-${APP}.env/save-loop-runs}"
[[ "$base" == /* ]] || fail 'SAVE_LOOP_RUNS_DIR must be an absolute path.'
mkdir -p "$base"
[[ ! -L "$base" && "$(cd -P -- "$base" && pwd -P)" == "$base" ]] || fail 'SAVE_LOOP_RUNS_DIR must be canonical and contain no symlink.'
available_kib="$(df -Pk "$base" | awk 'NR == 2 {print $4}')"
[[ "$available_kib" =~ ^[0-9]+$ ]] || fail 'Could not determine free disk space.'
(( available_kib >= 25 * 1024 * 1024 )) || fail "At least 25 GiB free is required on $base."
unset SAVE_LOOP_DOCUMENT_BYTES SAVE_LOOP_COMMIT_RATIO SAVE_LOOP_RESULTS SAVE_LOOP_CLIPS
unset SAVE_LOOP_QUICK_FIXTURE SAVE_LOOP_PRODUCT_APP SAVE_LOOP_VERSIONS
run_dir="$(mktemp -d "$base/run.XXXXXXXX")"
echo "Run outputs: $run_dir"
exec env SL1_SCRATCH="$run_dir" SL1_ON_DEMAND=1 SAVE_LOOP_VARIANT="$variant" "$APP/scripts/save-loop/start-isolated-linux.sh"
