# App quarantine and result gates

The Tests workflow checks quarantine policy against Git's merge base, rejects
unregistered skips and expected failures, and reconciles actual Vitest results
across XML, the incremental JSONL stream, and the runner summary. A failed step
keeps its failing exit while the other evidence-producing steps still run.

## Trusted policy comparison

The workflow requires an explicit base ref, resolves its merge base with the
checkout, and extracts `scripts/quality/check-quarantine-policy.mjs` from that
commit. It writes the module into a temporary directory outside the checkout
and runs it there with the checkout supplied as an explicit data root.

The parser also comes from the base: the workflow reads the base's
`package-lock.json` and builds an isolated package and lock containing that exact
TypeScript version, resolved URL, and integrity. `npm ci --ignore-scripts`
installs it in the temporary directory. The checker does not resolve TypeScript
through a candidate `scripts/quality/node_modules` directory, candidate lockfile,
or candidate npm project configuration. Cleanup removes the temporary directory.

Policy constants and `VITEST_EXPECTED_FAILURES` must be direct, literal
`export const` declarations. A missing declaration, aliased export, mutable
declaration, or nonliteral value fails; a hidden registry is never interpreted
as an empty registry. Candidate expiry dates are bounded by the current UTC day
plus the base's `MAX_EXPIRY_DAYS`. Entries matching a base issue URL, ID, or
file/title also retain that base entry's expiry limit.

The checker's optional third CLI argument is the repository root. This lets the
trusted module run outside the checkout while reading candidate policy data and
base Git blobs from the intended repository. Running the candidate's local
`npm run check:quarantine-policy` remains a development diagnostic; CI extracts
and executes the base module.

## Empty parameter tables and stored results

The pinned Vitest 4.1.5 runner rejects empty evaluated tables in `test.each`,
`describe.each`, `test.for`, and `describe.for`, including their `it`/`suite`
aliases. These calls otherwise create no task for the reporter to inspect.
The checks run after tagged-template conversion and preserve nonempty rows.
The exact-source installer also retains the completed-task throttle repair;
version or source drift fails before any patched source is written.

The result checker counts actual XML testcases and compares their identities
and outcomes with the collected/completed JSONL records and final runner total.
Incomplete, missing, duplicate, or inconsistent evidence fails. The workflow
uploads XML, JSONL, and logs even when a preceding check failed.

## Known limit: code already executing in the job

The repository's main `npm ci` runs candidate-controlled lifecycle code before
the policy step, including `postinstall`. Such code can tamper with
`node_modules`, alter executables or other files, or append a directory to
`$GITHUB_PATH` so later commands resolve to candidate programs. It can also
modify the runner guards or the result-producing process itself.

Moving the checker and its parser outside the checkout prevents module
shadowing by committed files. Disabling scripts for the isolated parser install
does not undo code that the earlier installation already executed. This gate
is not a sandbox against arbitrary candidate code executing in the same job.
Lifecycle, workflow, and gate-code changes therefore still require review and
the Lead's protected-path/required-check controls. The packet does not change
repository settings or claim to prevent this postinstall tampering.

## One-time introducing-PR bootstrap

App PR [#298](https://github.com/banodoco/astrid-app/pull/298) introduces the base
checker. Its plan base `e5f006907dd3756a1517992d01262b1e410e2ab1` has no checker,
so the trusted step exits with an explicit missing-base-checker error. There is
no candidate fallback, skipped policy step, or successful-exit substitution.

The Lead accepted this one named red step for this introducing PR in
[decision 6974930588](https://github.com/banodoco/astrid-dev/issues/796#issuecomment-6974930588).
Every later PR must execute the checker from its base. Committed-base workflow
injections prove import isolation and candidate-forgery rejection independently
of this one-time bootstrap condition. All other packet proof remains required.
