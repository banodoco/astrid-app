# Recorded-tuple C4 diagnostic

R14-P61-02, session `r14-P61-02-1`. This is the bounded observation requested by
[Lead 7014756557](https://github.com/banodoco/astrid-dev/issues/796#issuecomment-7014756557)
and [7014842303](https://github.com/banodoco/astrid-dev/issues/796#issuecomment-7014842303).
Lead owns dispatch. This source is a diagnostic submission, not a product fix,
a certification rerun, or evidence that the missing installed cases pass.

## Fixed sources

| Role | Exact source |
| --- | --- |
| Diagnostic parent / installed editor | `67428177b24989e230537ffe363aaa45b60bbd63` |
| Installed editor tree, also reviewed #314's tree | `d6f207b49763782ac9dbf9e3021e629fdb3285f5` |
| Frozen #310 setup, assertions and cleanup | `3c99c7aa7f9a0079b5075351f6271239714c4bc4` |
| Frozen #311 RB-9 startup tool | `d72ee39ded70346e5b22d952fba985c8a137b622` |
| Installed Agent | `ae929cdae7460c36cfbfd95599019a4c45f42e1c` |
| Derived installed Runtime | `2537fed24385ec1c24f48a812e09af4bb63fb794` |
| Release 13 control Agent | `9814193a73f606719e81883a8be197d27dd361d4` |
| Release 13 control Runtime | `6855dfa8df65cf8ae4c002b57134d6505493c17c` |

The single observer commit is on `p61/c4-input-diagnostic`. The workflow checks
its submitted full SHA, actual `GITHUB_SHA`, checkout HEAD and exact parent.
It neither advances nor patches #310/#311. Their separate checkouts must match
the full frozen SHAs and have no tracked changes. The real release tool still
selects its sources normally. Ref checks before setup/start and installed
HEAD/tree/manifest checks refuse a different App, Agent or Runtime tuple.
The plan-61 sync is a separate Lead-owned comparison. If its refs move, this
diagnostic refuses; it does not substitute another source, mirror or pin.

## Failing-before evidence

Original [run 44557257081](https://github.com/banodoco/astrid-app/actions/runs/44557257081),
[Mac job 135676576183](https://github.com/banodoco/astrid-app/actions/runs/44557257081/job/135676576183)
and [artifact 14551411190](https://github.com/banodoco/astrid-app/actions/runs/44557257081/artifacts/14551411190)
remain the failing-before case. The original artifact is 5,685,100 bytes,
SHA-256 `da8f936ca6e0835244be7cba84f0b86c55f7ceeb2e311e4f9815b5e3b2b4f2d3`.
The committed [failing-before receipt](failing-before.json) retains all 34 original
command exits, live hash/DB facts, both timeout occurrences and all 15 missing
installed subcases. [Original trace observations](original-trace-observations.md)
record the separate decoder markers, slider reads, C4 action snapshots and
request inventory, with original trace hashes and explicit observation limits.

C4 returned **exit 1 after 93.283 seconds**. Its unchanged publication predicate
timed out at **60,000 ms**. The before publication was
`txn-0bf5ca36e1e44d82b7b33f659e20d789`; no successful after-edit receipt exists.
`edit-1795104244447-trace.zip` records the requested fill
`P61 copied-realm edit`, followed by Enter and blur. The locator again describes
`value="V1"` at Enter. No mutating timeline request appears. The trace does not
record the native input event, React controlled prop or owner readiness at that
event, so it does not establish which callback or readiness boundary rejected
the edit. The prior original-read error did not recur.

The retained live snapshots before, after the half-built stop and final are
byte-identical: SHA-256
`cbc1ae4ef2dba7f402a03c2b7f19bd03403b0cb267701317ec8f2475391c3cb4`.
Their nine install/config/CAS hashes, PID/start, launchd identity, realm, DB
head/history and boot/epoch facts match. Fresh start had zero failed attempts
(156.380 s); warm pre-edit start also had zero (26.273 s). That warm start is
not a second fresh-root trial. Minimum recorded free disk was 90,873,720 KiB;
no proof or toolchain cuts were recorded.

### Two distinct chat-model timeout kills

The chat log contains no event timestamps. These are separate append-stream
occurrences, not five failures inferred from copied snapshots:

| Occurrence | Final-log byte offset | Last snapshot without occurrence, UTC | First snapshot with occurrence, UTC |
| --- | ---: | --- | --- |
| 1 | 82 | 2026-11-19 16:02:34.6709940 | 2026-11-19 16:04:03.7108950 |
| 2 | 183 | 2026-11-19 16:04:03.7108950 | 2026-11-19 16:05:37.6742460 |

Fresh/warm/failure/final log counts are **0 / 1 / 2 / 2**. Each shorter log is an
exact prefix of the final 243-byte log. Its SHA-256 is
`988c80b9c4e74821c0eb403260232c4c70ddf254f5de5208399c3a732ae74250`.
The timestamps above are observations, not exact kill times. No causal link to
C4, an update, or a persistent-service restart is established.

## What runs

The already-registered `p61-c4-readiness.yml` workflow (ID `423335344`) receives a
manual-only job. Its existing readiness job and all its assertions remain
byte-identical. `.github/workflows/test.yml` is unchanged. No new PR or automatic
certification dispatch is required for this diagnostic branch.

The new Python entry point imports the frozen harness's implementation. Its
separate constructor authorizes only this diagnostic ref while retaining the
macOS, GitHub-hosted, repository, runner-temp, live-control and owned-root guards.
It does not spoof `GITHUB_REF` or change the frozen code. It executes the original
bootstrap, seed, half-built-stop, fresh attach/playback and warm C4 edit prefix.
If C4 passes, its original history-count, restart and edit-survival assertions
still run. C5 onward is outside this diagnostic's phase interface.

The original hosted job has ended; its credential-bearing realm database was
deliberately not uploaded by the frozen harness. A new hosted Mac recreates the
**same real project recipe and V1 edit**, then copies that live realm through the
unchanged public release tool. It uses the same project slug/name (`p61-live-proof`,
`P61 live proof`), fixed timeline UUID `61616161-6161-4161-8161-616161616161`,
`Long-lived timeline`, original V1 still and V2 moving media, and seed history.
Canonical project/realm IDs returned by the public product are retained as
actual new IDs; the old IDs or DB bytes are not fabricated.

## Passive observations

`browser.mjs` preserves the original browser actions, assertions and timing.
Nine marked additions install the observer, mark actions and collect afterward.
Removing them and restoring only the explicit branch-guard literal reproduces
the frozen browser file byte for byte; `check.py` checks this and the original
readiness workflow body. The fill/Enter/blur sequence has no added await, input,
readiness wait, sleep or retry. The 60-second publication predicate, all other
assertion deadlines and the 420-second outer browser-command budget are retained.

Before navigation, `observer.mjs` enables the product's existing
`__timelineSaveDiagnosticsEnabled` opt-in and subscribes to
`timeline:save-diagnostic` and existing `shot-timeline:timing` events. It records:

- Native beforeinput/input/change, Enter keydown/keyup, focus, blur and focusout
  in capture/bubble order, with a post-event microtask observation.
- DOM value, value attribute, default value, disabled/readOnly/focus state,
  field/track identity, and the existing React own-props controlled `value`.
  Reading this own data property never invokes or replaces a React callback.
- Existing owner alias/generation, initialization and handoff milestones,
  invalidation, schedule and capture events. `handoff-ready` is emitted after
  assigning the handoff and ready state. There is no direct mutable-owner read.
- Existing local-commit, debounce-fired and editor-ack timing events where the
  installed build emits them, plus target timeline commit requests/responses,
  failures, body lengths and hashes. No request headers or body contents are
  copied by the observer; no route or transport behavior is intercepted.

DOM values and controlled props are separate observations. Owner readiness is
reported through existing milestones, not a guessed boolean. A capture-resolved
event means capture/append completed; it is not a server commit acknowledgement.
The track-label gesture projects `UNKNOWN` in the existing diagnostic payload;
that is preserved. Missing events, unknown fields, overflows and observer errors
remain explicit. Browser and Node buffers are each bounded at 2,048 records.

Collection occurs after the original assertion, including on failure. A
one-second **collection deadline** bounds an unresponsive observer read; it is
not a product wait or a retry. It cannot replace C4's original exit. Read-only
full process/launchd and candidate DB/boot snapshots bracket the browser process,
outside the fill/Enter/blur sequence. They reuse the frozen census collector and
do not execute or claim C5. The original always-run diagnostics, owned-stack stop,
live-before/after equality assertion and disk recording remain in the workflow.

Source inspection identifies a hypothesis: the default routed canvas can render
the controlled field while shared `applyEdit` rejects a not-yet-ready save owner.
The original trace cannot prove that sequence. The diagnostic must first place
input, controlled-value restoration, owner readiness, capture and commit in order.
Only then can the earliest observed loss support a narrowly scoped product proposal.

## Lead invocation

The submission comment supplies the immutable 40-character diagnostic SHA.
Lead should verify the branch still equals that SHA and that the App/Agent refs
still select the fixed tuple above, then dispatch **once**:

```sh
gh workflow run 423335344 --repo banodoco/astrid-app \
  --ref p61/c4-input-diagnostic \
  -f diagnostic_sha=FULL_SHA_FROM_SUBMISSION
```

The workflow's actual command is
`python3 -B scripts/astrid-release/c4-diagnostic/run.py restart-edit` after its
listed real setup phases. Every original command exit remains in `run-record.md`.
The artifact is `p61-c4-input-diagnostic-<run_id>-<attempt>`, retained for 30 days,
with complete Playwright traces/screenshots, bounded observer JSON, raw sanitized
stack logs, both candidate snapshots, live snapshots, actual installed heads and
manifests, and per-file SHA-256 sums. Raw realm databases and credentials remain
outside the upload directory, following the frozen harness.

## Outcomes still open

The original failing run leaves C4 post-edit history/restart/survival, C5–C7,
remaining C8 fresh-root trials, C9's negative-phase stop, C11, and mistyped-branch,
non-Mac-platform, installed wrong-realm-ID and installed schema-refusal negatives
without outcomes. Its final owned-stack cleanup is a separate observed success.
The 130 native fixture PASS entries do not fill these installed gaps. The accepted
59-ID journey comparison still has 11 unknown base outcomes. Neither this
diagnostic nor the separate plan-61 sync overwrites any of those receipts.
