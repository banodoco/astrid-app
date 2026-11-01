#!/usr/bin/env bash

set -Eeuo pipefail

run_root=$(mktemp -d /tmp/current014-gate3-selection.XXXXXX)
cleanup() {
  find "$run_root" -depth -type f -delete 2>/dev/null || true
  find "$run_root" -depth -type d -empty -delete 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

export PLAYWRIGHT_OUTPUT_DIR="$run_root/results"
export PWTEST_CACHE_DIR="$run_root/pw-cache"
export XDG_CACHE_HOME="$run_root/xdg-cache"
export VITE_CACHE_DIR="$run_root/vite-cache"

full_title='M2 native None single: ordinary default crossfade clears raw mirrors, reloads, retries exactly after restart and undoes through Runtime'
selected="$run_root/selected.log"
npm run test:e2e:three-products -- --grep '^.*M2 native None single:' --list >"$selected" 2>&1
cat "$selected"
test "$(grep -F -c "› $full_title" "$selected")" -eq 1
grep -F 'Total: 1 test in 1 file' "$selected" >/dev/null

zero="$run_root/zero.log"
if npm run test:e2e:three-products -- --grep '^M2 native None single:' --list >"$zero" 2>&1; then
  echo 'old anchored selector unexpectedly listed a test' >&2
  cat "$zero" >&2
  exit 1
fi
cat "$zero"
grep -F 'Error: No tests found' "$zero" >/dev/null
grep -F 'Total: 0 tests in 0 files' "$zero" >/dev/null
