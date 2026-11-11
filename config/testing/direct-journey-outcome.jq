# Outcome rule for a Direct Journey job. Run as:
#   jq -f config/testing/direct-journey-outcome.jq --arg job <direct|three-products>
#      --slurpfile allow config/testing/direct-journey-expected-failures.json <report.json>
# The allowlist is the single source of truth shared with scripts/quality/check-known-failures.mjs.
# Pass: expected-failed tests are exactly the allowlisted titles for this job (each one failed as expected),
# and nothing is unexpected, flaky or skipped.
($allow[0][$job] // []) as $listed
| [.. | objects | select(has("tests") and has("title")) | . as $s
    | $s.tests[] | select(has("expectedStatus") and has("results"))
    | {title: $s.title, file: $s.file, expectedStatus, status}] as $tests
| ($tests | map(select(.expectedStatus == "failed"))) as $xf
| {
    total: ($tests | length),
    expected_failures: ($xf | length),
    allowlisted: ($listed | length),
    expected_failures_not_listed: [$xf[] | select(. as $t | ($listed | any(.title == $t.title and (.file | endswith($t.file)))) | not) | .title],
    listed_not_expected_failed: [$listed[] | select(. as $l | ($xf | any(. as $x | $x.title == $l.title and ($l.file | endswith($x.file)))) | not) | .title],
    expected_failures_that_did_not_fail: ($xf | map(select(.status != "expected")) | length),
    unexpected: .stats.unexpected,
    flaky: .stats.flaky,
    skipped: .stats.skipped
  }
| . as $r | $r, (
    if $r.total > 0 and $r.expected_failures == $r.allowlisted
       and ($r.expected_failures_not_listed | length) == 0 and ($r.listed_not_expected_failed | length) == 0
       and $r.expected_failures_that_did_not_fail == 0
       and $r.unexpected == 0 and $r.flaky == 0 and $r.skipped == 0
    then empty
    else error("\($job): want cases, exactly the \($r.allowlisted) allowlisted expected failures (config/testing/direct-journey-expected-failures.json), 0 unexpected, 0 flaky, 0 skipped; got \($r)") end)
