# Plan 61 hosted real-run proof

This is Release 14 packet R14-P61-02's dispatch-only proof entry point. It runs
only on `p61/rb-6`, in a GitHub-hosted macOS runner. It creates all data itself.
It does not connect to the owner's Mac or use an existing personal installation.

Dispatch the registered **Tests** workflow on **p61/rb-6**, with
`p61_real_run=true`. Record the exact dispatched commit and the run URL. The
workflow reads the immutable RB-9 candidate from
[`hosted-proof-inputs.json`](hosted-proof-inputs.json), checks it out separately,
and records both SHAs;
the editor branch under test is `release/14/plan-61`. A PR run alone does not
execute this proof and must not be reported as real-run evidence.

The frozen Release 13 manifest in this checkout supplies the control install:
Agent `9814193a73f606719e81883a8be197d27dd361d4` and Runtime
`6855dfa8df65cf8ae4c002b57134d6505493c17c`. The public installer runs with its
real login service enabled. Public CLI operations create a timeline with the
original still-image clip and a ten-second moving H.264 clip, then three further
durable edits before the control is frozen for comparison. The video is generated
and validated with the live installation's recorded FFmpeg/FFprobe binaries;
their exact paths, versions and hashes are retained. This exercises the real
video-decoder readiness marker without removing the image fixture or weakening
the browser's readiness/playback assertions.

| Completion / negative case | Evidence |
| --- | --- |
| 1. Half-built empty-realm Runtime stops | Real candidate installation, empty head table, PID census, tool `stop`, no remaining root process |
| 2. Fresh start attaches the live copy | Actual captured `workspace attach` JSON, copied realm ID, inspect JSON, READY and launch lines |
| 3. Existing timeline opens and plays | Playwright with no route mocks; rendered frame, advancing playback slider, screenshots and trace |
| 4. One UI edit survives restart | Track-name edit, publication change, read-only history count exactly +1 before and after restart |
| 5. Unchanged update | Exact output, identical process identities and installer log hashes |
| 6. Moved Agent/Runtime pins | Existing native fixture cases always execute; real branch movement is reported as observed or explicitly not exercised |
| 7. Tracked editor dirt | Real tracked README edit, refusal, unchanged bytes/processes, then exact restoration |
| 8. Fresh-start failure | Three fresh program/data roots, per-launch failed-tail archive and retry count; no cause inferred from the message alone |
| 9. Complete stop | Root-specific process census after `stop`, including an always-run cleanup |
| 10. Live install unchanged | Actual `shasum -a 256` set plus read-only schema, head, history, epoch and PID/launchd facts before/after |
| 11. Kept data, deleted root, fresh clone | APFS data clone and hash check, removal of only the runner-owned root, fresh clone of the plan branch and repeat playback |
| Mistyped branch | Real entry point refuses before making the mistyped root |
| Non-Mac | Only `uname` is injected on the hosted Mac; this demonstrates platform refusal, not a Linux stack run |
| Unreadable source DB | Actual mode=ro backup failure on chmod-000 source with a valid stopped destination; no publication/catalog mutation |
| Wrong realm ID | Installed Runtime rejects a real copied realm under a wrong requested ID; facts unchanged |
| Schema mismatch | The App release caller invokes the installed Runtime on a disposable APFS realm clone with schema 999999; exit 1, its bounded read-only doctor report names the exact realm and actual/expected versions, and rejected DB bytes/facts, selection and the normal copy remain unchanged |

Completion 11 records the exact current plan-branch SHA. RB-7 landing belongs to
the Lead; a pre-landing fresh clone does not claim that an unperformed landing
has been validated. The third fresh start exercises that unmodified clone, so
its tool identity can differ from the pinned RB-9 candidate used earlier.

`observe-attach.bash` is an evidence-only Bash DEBUG observer. The existing copy
helper captures and suppresses successful attach JSON; the observer retains
that actual value at the successful return without replacing any command,
result, catalog write, or acceptance rule.

The uploaded artifact contains `run-record.md`, exact commands/results, curated
redacted logs, read-only facts and browser evidence. Credentials, environment
file contents, databases, full kept data and browser caches stay outside the
artifact. Free disk is reported throughout and on failure. No proof item or
runner toolchain is removed to fit the run; a shortage is a failed run requiring
an explicit report. Failures stay failures, with cleanup and artifact upload
still attempted.
