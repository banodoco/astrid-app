#!/bin/sh
set -eu

# Evidence-preserving adaptation of the approved parent-drop driver. Keep the
# current exact three-path source pins and current App tree guard; do not alter
# the product row or broaden its selectors.

worker_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_runner=/tmp/claude-0/-home-user-repo/7dc61be1-7066-52e0-a5d0-94f90e61430a/scratchpad/orch/design/normal014-app-central.sh
source_common=/tmp/claude-0/-home-user-repo/7dc61be1-7066-52e0-a5d0-94f90e61430a/scratchpad/orch/design/normal014-source-common.sh
expected_app_tree=78f3784287d78fc92677ebe5eb710d162b0f50ae
manual_case_title='M2 real mounted manual video drop: Runtime selection refusal is closed, native ADD recovers exactly, and undo preserves opaque data'

usage() {
  echo "usage: $0 run APP_ROOT | $0 probe" >&2
  exit 2
}

guard_test_run() {
  child_status=$1
  output=$2
  if [ "$child_status" -eq 0 ] && grep -Eiq \
    'No tests found|No test files found|collected[[:space:]]+0 items|Running[[:space:]]+0 tests|0 tests found|Tests[[:space:]]+0 passed[[:space:]]+\(0\)|^[[:space:]]*0 passed([[:space:]]|$)' \
    "$output"; then
    printf '%s\n' 'manual-drop runner refused a zero-test result' >&2
    return 1
  fi
  if [ "$child_status" -eq 0 ] && ! grep -Fq "$manual_case_title" "$output"; then
    printf '%s\n' 'manual-drop runner did not discover the registered manual-drop test' >&2
    return 1
  fi
  return "$child_status"
}

copy_bounded() {
  source=$1
  destination=$2
  limit_bytes=${3:-52428800}
  test -f "$source" || return 0
  size=$(wc -c <"$source")
  if [ "$size" -gt "$limit_bytes" ]; then
    printf '%s\n' "omitted oversized evidence: $source ($size bytes; limit $limit_bytes)" >>"$evidence_dir/retention.log"
    return 0
  fi
  cp -- "$source" "$destination"
}

write_source_identity() {
  app_root=$1
  {
    printf 'app_root=%s\n' "$app_root"
    printf 'head=%s\n' "$(git -C "$app_root" rev-parse HEAD 2>/dev/null || printf unavailable)"
    printf 'tree=%s\n' "$(git -C "$app_root" rev-parse 'HEAD^{tree}' 2>/dev/null || printf unavailable)"
    printf 'status=%s\n' "$(git -C "$app_root" status --porcelain=v1 --untracked-files=all 2>/dev/null | tr '\n' ' ' || printf unavailable)"
    printf 'expected_tree=%s\n' "$expected_app_tree"
    printf 'agent_pin=3c4f6de4fa777323b3386c01c7266b619b86af6d\n'
    printf 'runtime_pin=202074110717146fc7f08af2306a8dd7f695b0b1\n'
    printf 'producer_pin=a0dca16975dfe8f5e762703b99d9791a16cf7fd7\n'
  } >"$evidence_dir/source-identity.txt"
}

extract_sanitized_summary() {
  summary=$1
  output=$2
  if [ ! -f "$summary" ]; then
    printf '%s\n' '{"summary":"three-products-summary.json was not retained by the runner","requests":[],"responses":[],"console":[]}' >"$output"
    return 0
  fi
  SUMMARY="$summary" OUTPUT="$output" node --input-type=module - <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';

const source = JSON.parse(readFileSync(process.env.SUMMARY, 'utf8'));
const secretKey = /token|credential|secret|authorization|password|cookie|set-cookie/i;
const redactString = (value) => value
  .replace(/Bearer\s+[^\s]+/gi, 'Bearer <redacted>')
  .replace(/([?&](?:token|access_token|refresh_token|signature|sig)=)[^&\s]+/gi, '$1<redacted>');
const redact = (value, depth = 0) => {
  if (typeof value === 'string') return redactString(value.slice(0, 2000));
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 160).map((item) => redact(item, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [
    key,
    secretKey.test(key) ? '<redacted>' : redact(item, depth + 1),
  ]));
};
const cases = Array.isArray(source.cases) ? source.cases.map((item) => ({
  name: item.name,
  status: item.status,
  astridCalls: redact(item.astridCalls),
  facts: redact(item.facts),
})) : [];
writeFileSync(process.env.OUTPUT, JSON.stringify(redact({
  revisions: source.revisions,
  sourcesAtStart: source.sourcesAtStart,
  cases,
}), null, 2) + '\n');
JS
}

record_evidence() {
  run_root=$1
  app_root=$2
  status=$3
  evidence_dir=${NORMAL014_RECORD_DIR:-$worker_root/recorded-evidence}
  mkdir -p "$evidence_dir"
  chmod 700 "$evidence_dir"
  write_source_identity "$app_root"
  printf 'runner_status=%s\n' "$status" >"$evidence_dir/result.txt"
  printf 'run_root_cleanup=after-evidence-copy\n' >"$evidence_dir/retention.log"

  browser_output=
  if [ -n "$run_root" ] && [ -d "$run_root/browser-output" ]; then
    browser_output=$run_root/browser-output
  fi
  trace=
  context=
  summary=
  if [ -n "$browser_output" ]; then
    trace=$(find "$browser_output" -type f -name trace.zip -print -quit 2>/dev/null || true)
    context=$(find "$browser_output" -type f -name error-context.md -print -quit 2>/dev/null || true)
    summary=$(find "$browser_output" -type f -name three-products-summary.json -print -quit 2>/dev/null || true)
  fi
  if [ -n "$trace" ]; then copy_bounded "$trace" "$evidence_dir/playwright-trace.zip" 52428800; fi
  if [ -n "$context" ]; then copy_bounded "$context" "$evidence_dir/error-context.md" 1048576; fi
  if [ -f "$summary" ]; then
    extract_sanitized_summary "$summary" "$evidence_dir/bounded-browser-evidence.json"
  else
    extract_sanitized_summary '' "$evidence_dir/bounded-browser-evidence.json"
  fi
  if [ -f "$run_root/runner.log" ]; then
    tail -n 300 "$run_root/runner.log" >"$evidence_dir/runner-tail.log"
  else
    printf '%s\n' 'runner.log was not retained by the runner' >"$evidence_dir/runner-tail.log"
  fi
  cat >"$evidence_dir/evidence-presence.json" <<EOF
{"trace":$( [ -n "$trace" ] && printf true || printf false ),"error_context":$( [ -n "$context" ] && printf true || printf false ),"request_response_console_summary":$( [ -n "$summary" ] && printf true || printf false ),"source_identity":true,"sanitized_summary":"bounded-browser-evidence.json"}
EOF
}

exit_handler() {
  status=$?
  trap - EXIT HUP INT TERM
  set +e
  if [ "${evidence_recorded:-0}" -eq 0 ]; then
    record_evidence "${run_root:-}" "${app_root:-$worker_root}" "$status"
    evidence_recorded=1
  fi
  if [ "${cleanup_run_root:-0}" -eq 1 ] && [ -n "${run_root:-}" ] && [ -d "$run_root" ]; then
    rm -rf -- "$run_root"
  fi
  if [ "${cleanup_runner:-0}" -eq 1 ] && [ -n "${run_copy:-}" ] && [ -f "$run_copy" ]; then
    rm -f -- "$run_copy"
  fi
  exit "$status"
}

run_gate() {
  app_root=$1
  run_root=
  run_copy=
  cleanup_run_root=0
  cleanup_runner=0
  evidence_recorded=0
  evidence_dir=${NORMAL014_RECORD_DIR:-$worker_root/recorded-evidence}
  # Install the evidence-first trap before any preflight or runner operation.
  trap 'exit_handler' EXIT HUP INT TERM

  test -f "$app_root/package.json"
  test -f "$source_runner"
  test -f "$source_common"
  observed_app_head=$(git -C "$app_root" rev-parse HEAD)
  observed_app_tree=$(git -C "$app_root" rev-parse 'HEAD^{tree}')
  observed_app_status=$(git -C "$app_root" status --porcelain=v1 --untracked-files=all)
  test "$observed_app_tree" = "$expected_app_tree"
  test -z "$observed_app_status"
  test "${#observed_app_head}" -eq 40
  case "$observed_app_head" in *[!0123456789abcdef]*) exit 1;; esac

  run_root=$(mktemp -d /tmp/timeline-parent-negative-evidence.XXXXXX)
  run_copy=$(mktemp /tmp/timeline-parent-negative-runner.XXXXXX)
  cleanup_run_root=1
  cleanup_runner=1
  sed \
    -e "s|^\. \"\$HERE/normal014-source-common.sh\"$|. \"$source_common\"|" \
    -e "s/--grep 'M2 real gate 5'/--grep 'M2 real mounted manual video drop'/" \
    -e "/^npm run build:hosted$/i\\
node node_modules/playwright/cli.js test --config playwright.three-products.config.ts --grep 'M2 real mounted manual video drop' --list\\
" \
    "$source_runner" >"$run_copy"
  chmod 700 "$run_copy"

  status=0
  NORMAL014_RUN_ROOT="$run_root" sh "$run_copy" run "$app_root" >"$run_root/runner.log" 2>&1 || status=$?
  guard_test_run "$status" "$run_root/runner.log" || status=$?
  cat "$run_root/runner.log"
  record_evidence "$run_root" "$app_root" "$status"
  evidence_recorded=1
  printf 'retained evidence: %s\n' "$evidence_dir" >&2
  exit "$status"
}

failuretrap_probe() {
  zero_test_output=$(mktemp /tmp/timeline-parent-zero-test-probe.XXXXXX)
  one_test_output=$(mktemp /tmp/timeline-parent-one-test-probe.XXXXXX)
  printf '%s\n' 'No tests found' 'Running 0 tests' >"$zero_test_output"
  if guard_test_run 0 "$zero_test_output"; then
    printf '%s\n' 'zero-test guard probe unexpectedly passed' >&2
    exit 1
  fi
  printf '%s\n' "[chromium] › $manual_case_title" >"$one_test_output"
  guard_test_run 0 "$one_test_output"
  rm -f -- "$zero_test_output" "$one_test_output"

  probe_root=$(mktemp -d /tmp/timeline-parent-negative-failuretrap.XXXXXX)
  probe_evidence=$(mktemp -d /tmp/timeline-parent-negative-failuretrap-record.XXXXXX)
  mkdir -p "$probe_root/browser-output/fake-test"
  printf 'fake trace' >"$probe_root/browser-output/fake-test/trace.zip"
  printf 'fake error context\n' >"$probe_root/browser-output/fake-test/error-context.md"
  printf '%s\n' '{"cases":[{"name":"probe","status":"failed","facts":{"refusedStatus":409,"requests":[{"method":"GET","url":"/media-selection/verified?object_id=<redacted>"}],"responses":[{"status":409}],"console":[{"type":"error","text":"native refusal"}]}}]}' >"$probe_root/browser-output/three-products-summary.json"
  (
    run_root=$probe_root
    app_root=$worker_root
    run_copy=
    cleanup_run_root=1
    cleanup_runner=0
    evidence_recorded=0
    NORMAL014_RECORD_DIR=$probe_evidence
    evidence_dir=$probe_evidence
    trap 'exit_handler' EXIT HUP INT TERM
    exit 97
  ) || probe_status=$?
  test "${probe_status:-0}" -eq 97
  test -s "$probe_evidence/playwright-trace.zip"
  test -s "$probe_evidence/error-context.md"
  test -s "$probe_evidence/bounded-browser-evidence.json"
  test -s "$probe_evidence/source-identity.txt"
  test ! -e "$probe_root"
  rm -rf -- "$probe_evidence"
  printf '%s\n' 'failuretrap probe passed: evidence copied before disposable-root cleanup'
}

case "${1:-}" in
  run) [ "$#" -eq 2 ] || usage; run_gate "$2" ;;
  probe) [ "$#" -eq 1 ] || usage; failuretrap_probe ;;
  *) usage ;;
esac
