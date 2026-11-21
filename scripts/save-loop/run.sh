#!/usr/bin/env bash
# Opt-in synthetic save-loop run; all generated state stays in a new directory.
set -Eeuo pipefail
umask 077
APP="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
usage='Usage: SAVE_LOOP_CHROME=/absolute/path/to/chrome scripts/save-loop/run.sh

Creates a new isolated stack and synthetic fixture, runs the save-loop matrix,
and stops the stack. Outputs are retained in the printed directory.'
if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then echo "$usage"; exit 0; fi
[[ $# == 0 ]] || { echo "$usage" >&2; exit 2; }
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
unset SAVE_LOOP_CLIPS SAVE_LOOP_DOCUMENT_BYTES SAVE_LOOP_COMMIT_RATIO SAVE_LOOP_RESULTS
run_dir="$(mktemp -d "$base/run.XXXXXXXX")"
echo "Run outputs: $run_dir"
SL1_SCRATCH="$run_dir" SL1_ON_DEMAND=1 "$APP/scripts/save-loop/start-isolated-linux.sh"
