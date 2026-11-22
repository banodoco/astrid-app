# Synthetic save-loop sweep

## Plan 77 quick indicator

For one synthetic fixture, use the owned `quick-backup-cycle.sh restore-run`
entrypoint, which invokes `sweep.mjs --quick` under its shared lock. It writes a JSONL `quick_indicator` row to the
results file and prints a compact table. The current guarded route measures
same-track move (or exact V1 track rename for the empty V1/A1 fixture) once
from a captured pre-open public baseline and again only after the post-open
read returns in under a second. It verifies Undo against the public snapshot
between arms. If the read gate or Undo cannot be verified, the quiet arm is
skipped and reported as unobserved.

Each arm also records two independent durations using the recorder's page
monotonic clock: gesture end to the first scoped timeline commit POST, and
that POST to its own response. The raw arm row stores them as
`quick_save_timing.gesture_to_post_ms` and `quick_save_timing.post_to_response_ms`;
the `quick_indicator` JSON summary and table also print the same fields per
arm. A missing POST, a response not
confirmed, or a request that precedes the measured gesture end has a null
duration and an explicit reason. Setup/verification failures stay unobserved.
An observed save refusal is broken; a genuinely elapsed 60-second wait with
no Saved is broken as well.

```sh
SAVE_LOOP_CHROME=/absolute/path/to/chrome \
scripts/save-loop/quick-backup-cycle.sh restore-run empty \
  /absolute/tooling-checkout.env/quick-indicator/bundles/empty \
  /absolute/tooling-checkout.env/quick-indicator/bundles/empty/versions.json \
  /absolute/tooling-checkout.env/quick-indicator/stack /absolute/tooling-checkout.env/quick-indicator/stack/source-manifest.json \
  /absolute/clean/product-app /absolute/tooling-checkout.env/quick-indicator/stack/results-empty \
  /absolute/tooling-checkout.env/quick-indicator/stack/startup-empty.json
```

The verified restore entry creates a new realm and profile for each invocation.
Use the separately reviewed fixture preparation workflow to supply the exact
manifest and source manifest for each size. Do not reuse result paths.

Usable is works through 5 s, slow through 15 s, then broken. Save is works
through 2 s, slow through 10 s, then broken; a refusal is broken and no Saved
within 60 s is broken. The marker-to-observed-read time is an upper bound that includes unprobed
scheduling time, not proof of continuous service blockage. Its light is works
through 2 s, slow through 30 s,
then broken. Missing evidence is `unobserved`, never a pass. Read the rough
lights rather than decimals: this runs on a shared 4-CPU Linux dev stack, one
stack at a time, and is an indicator rather than a product qualification.

The result categories help distinguish a general problem (red even when
empty), a size/history problem (small green and large red), a save-path problem
(open green and save red), and Runtime startup work (first save red, later
save green). A red large v30 row alone does not show whether the seed history
or clip count caused the result; its label is `heavy seed history, worst case`.

### Four-row offline backup/restore workflow

`quick-backup-cycle.sh` operates on a prepared local stack and does not install
or change product pins. It requires the exact App/Agent/Runtime tuple from the
Round 5 receipts, a matching `.sl1-stack-owned` marker, canonical new output
paths below the sibling `<tooling-checkout>.env/quick-indicator` directory, 25 GiB
free, and an exclusive lock. It refuses a live editor. Runtime backup and
restore commands perform their built-in verification. Each measured run uses
a new restore target, adopted data root, and results directory; the active
workspace is not replaced. The fixture manifest and source version tuple are
copied into each bundle. Each restore-run requires an explicit expected
versions JSON; it must match the owned stack's App/Agent/Runtime tuple and the
clean product App checkout's exact commit. This supports a separately prepared
candidate tuple without inheriting the baseline pins.

Prepare the baseline stack using the separately reviewed fixture preparation
workflow. With the owned stack running and its local editor URL, use this builder
from the tooling checkout for each size, with a fresh scratch directory:

```sh
SAVE_LOOP_ROOT=/absolute/tooling-checkout.env/quick-indicator/stack \
SAVE_LOOP_BASE_URL=http://127.0.0.1:EDITOR_PORT \
SAVE_LOOP_PRODUCT_APP=/absolute/clean/product-app \
SAVE_LOOP_VERSIONS=/absolute/tooling-checkout.env/quick-indicator/versions.json \
SAVE_LOOP_SCRATCH=/absolute/tooling-checkout.env/quick-indicator/fixture-empty \
SAVE_LOOP_QUICK_FIXTURE=1 SAVE_LOOP_CLIPS=0 node scripts/save-loop/build-fixture.mjs
```

Use sizes 0, 10 and 100 and a distinct scratch for each. The versions file
must match the clean product App and owned stack's exact tuple. This creates
synthetic 0, 10 and 100 clip manifests on the owned stack. The empty manifest
has exactly V1/A1 and no clips. Save each manifest and stop its stack through
the owner before making offline backups:

```sh
scripts/save-loop/quick-backup-cycle.sh backup empty \
  /absolute/tooling-checkout.env/quick-indicator/stack \
  /absolute/tooling-checkout.env/quick-indicator/stack/data/realm \
  /absolute/tooling-checkout.env/quick-indicator/support/empty \
  /absolute/tooling-checkout.env/quick-indicator/fixture-empty/manifest-PROJECT.json \
  /absolute/tooling-checkout.env/quick-indicator/bundles/empty
```

Repeat with `10` and `100` and distinct realm, manifest and bundle paths.
For the heavy row, pass the exact approved restored source
`/home/user/codex-run/run/evidence/plan-77/growth-profile/v30-owned-synthetic-restored-realm`
as the realm argument, and a fresh support-root path under the dedicated
`<tooling-checkout>.env/quick-indicator/support` parent. Keep that marker-owned
support directory at the same path across stack cleanup and both restores;
Runtime manages its authentication material. The
command verifies its receipt and database SHA-256, refuses WAL/SHM sidecars,
copies it into marker-owned staging, then uses the installed Runtime's normal
backup command. It never reads the missing old authentication key or changes
the source. Runtime's normal restore verifies each per-run copy. Supply the
verified v30 fixture manifest.

For each bundle, call `restore-run` with a new owned stack root and result
paths. The Runtime restore destination and adopted data root are generated
under that stack. Ports must be unused and owned by this run; Chrome must be
provided through `SAVE_LOOP_CHROME`.

```sh
SAVE_LOOP_CHROME=/absolute/path/to/chrome \
scripts/save-loop/quick-backup-cycle.sh restore-run empty \
  /absolute/tooling-checkout.env/quick-indicator/bundles/empty \
  /absolute/tooling-checkout.env/quick-indicator/bundles/empty/versions.json \
  /absolute/tooling-checkout.env/quick-indicator/new-stack \
  /absolute/tooling-checkout.env/quick-indicator/new-stack/source-manifest.json \
  /home/user/codex-run/wt/astrid-app-p77-quick-baseline-product \
  /absolute/tooling-checkout.env/quick-indicator/new-stack/results-empty /absolute/tooling-checkout.env/quick-indicator/new-stack/startup-empty.json
```

The restore workflow takes ports from the owned `stack-info.txt`; do not supply
ports or a project UUID as the realm ID. It reads the verified realm ID from
the backup receipt, uses the offline sibling `astrid-runtime-protocol` for
backup/restore, and uses the installed `astrid-runtime` only for lifecycle and
workspace adoption. The quick sweep also requires the exact clean product App
checkout, active editor PID/data root, matching Runtime instance and all three
owned ports. It disables hosted App and Runtime origins. A new result directory
and startup file are required for every run.

Run once for each size with distinct bundle, stack and outputs. For the heavy
row only, set `SAVE_LOOP_QUICK_WARM_RELOAD=1` to record an additional same-
profile reload after the immediate and quiet arms have completed and guarded
Undo has verified a clean public head. It does not delay those arms. The startup
probe runs concurrently with the quick sweep from the owned `astrid-runtime
up` process launch. It checks exact project, timeline, head revision and
publication fields through the local App Runtime discovery proxy; that proxy
injects the current Runtime bearer token from its owned discovery record. The
startup duration is a separate `runtime_startup` JSONL record, not the UI
`post_open_blocked_s` value. If the qualifying read arrives before UI
navigation, the aggregate marks the blocked value censored because readiness
may have warmed the cache. A failed or missing metadata answer has a null
duration and an explicit outcome; it is never a pass.

Print a combined, minute-readable four-row summary from the four JSONL files:

```sh
node scripts/save-loop/aggregate-quick.mjs \
  /absolute/tooling-checkout.env/quick-indicator/new-stack/results-empty/results.jsonl \
  /absolute/tooling-checkout.env/quick-indicator/new-stack/results-10/results.jsonl \
  /absolute/tooling-checkout.env/quick-indicator/new-stack/results-100/results.jsonl \
  /absolute/tooling-checkout.env/quick-indicator/new-stack/results-large/results.jsonl
```

This workflow has only harness/static proof in this change; it has not been
run against a Runtime stack or browser. Product/runtime execution remains
unmeasured until an explicitly scheduled local run.

Use a clean committed App checkout on Linux containing the fixture builder and
the pinned install manifest and Runtime lock. The tooling has only been
qualified on Linux; Darwin code paths are not a macOS qualification. Install
Node 20.19.0 or newer, npm, git, curl, Python 3, ffmpeg with libx264, and Chrome
or Chromium. The App's `npm ci` installs Playwright; set `SAVE_LOOP_PLAYWRIGHT`
to an installed Playwright module if needed. Allow at least 25 GiB free on the
run filesystem, plus space for App dependencies. Internet access is needed for
installation from the committed pins.

```sh
SAVE_LOOP_CHROME=/absolute/path/to/chrome scripts/save-loop/run.sh
```

The command prints a new run directory (by default under
`<app-checkout>.env/save-loop-runs`; override its absolute parent with
`SAVE_LOOP_RUNS_DIR`). It starts an isolated Runtime and editor, generates a
synthetic fixture, runs the full sweep in a fresh browser profile, and stops its
stack. It retains installation and editor logs, `fixture.log`, generated
media and manifest, `versions.json`, and `results.jsonl` in the run directory.
The sweep prints a table and exits nonzero on a failed row or setup. Ctrl+C
stops the run. Keep at least 15 GiB free during the run; the fixture and sweep
check this floor. The fixture may take substantial time and space.

This is an explicit, executable full-run command, not a status or dry-run
command. It creates a local isolated Runtime and editor, installs from the
committed pins, creates synthetic media and timelines, and opens Chrome. Its
outputs go under the new run directory, but `npm ci` runs in the App checkout
and replaces that checkout's `node_modules`; use a disposable committed App
checkout, not an active development checkout. Chrome uses a temporary
`/tmp/sl-*` profile that normal browser cleanup removes; forced termination may
leave that temporary directory behind. The build can fail its clip,
document-size or timing target checks before Chrome starts. The generated
fixture uses no owner media and no GPU. Do not point these tools at a hosted or
owner workspace.

The older `scripts/save-loop/start-isolated-linux.sh` remains available for a
foreground isolated stack. It uses `SL1_SCRATCH` and replaces only its own
marked previous stack. The on-demand command always uses a new directory.

An independent optional run exercises large nested shots:

```sh
SAVE_LOOP_CHROME=/absolute/path/to/chrome scripts/save-loop/run.sh --variant large-shots
```

This creates a fresh stack and performs one fixture build and sweep. It retains
all standard 616 parent clips, 46 normal shot occurrences, the 2.6 MB document
and 15x one-clip timing requirements, and all matrix targets. In addition,
three generated 480-second shot occurrences each contain 32 child clips on
visual and audio tracks. The clips use generated 90-second video and audio
sources, with 30-second source windows. No user media or GPU is used. The
variant is optional and does not run as part of the default command.

Each run has its own directory. `status.json`, the manifest's `variant` and
`measurement.large_shots`, and the `run` row in `results.jsonl` identify the
selected run. The extra measurement records child counts, accepted commit
timing, generated media bytes, build time and disk before/after. A successful
fixture must verify accepted child tracks, clips and media identities. The
standard measurement and sweep requirements remain in force for both variants.
`measurement.accepted_prefix_asset_counts` identifies the 616 parent clip IDs
for the opening and sweep oracles; `media.retained_object_ids` covers those
parent clips. The two nested-only object IDs are listed separately in
`measurement.large_shots.child_object_ids`.
`status.json` reports a completed fixture or sweep failure; an interrupted run
may remain `running` and is not a pass.

The larger video is encoded sequentially on CPU. The extra generation can take
substantial wall time and disk space. The initial 25 GiB free-space requirement
and 15 GiB stop floor apply; generated source media is capped at 1 GiB and the
builder checks space for an additional copy before importing it. Actual Runtime
and installation overhead can require more. The default command remains the
standard run; a pass of either variant does not establish a pass for the other.

Opening and CPU evidence is recorded for the standard fixture. The opening
clock starts immediately before navigation. The harness derives the IDs that
start in the first 15 seconds from the standard builder's image/video/audio
placement rules and checks that each control intersects the visible viewport
and clipping ancestors. A real Enter selection also records the manifest
selection target's response. First usable is a no-write affordance milestone:
in one observation the first-15 clip IDs intersect the viewport, the target
clip is selected by the real selection probe, and that fixture track's normal
`Track name` input is enabled and non-read-only. The input shares the editor's
timeline editability policy, including the save-readiness hold. The harness
records elapsed time and the 5-second target comparison; the timestamp is an
observation upper bound. The track-name field normally appears on hover, so
its enabled state is checked without typing, changing focus or making an extra
write. This evidence does not prove the whole 15-second range is visible, that
every clip can be edited, or that any write has been accepted. When an ordinary
matrix row first passes its existing save assertions and guarded content restore,
a separate `first_accepted_scenario` record corroborates an accepted edit; its
CPU and elapsed time remain in that row, outside the cold-open measurement.

The corroborated full-open milestone requires the exact standard clip IDs,
exact nine track IDs, project/timeline URL and Saved to agree in UI samples for
at least 800 ms, plus the same exact public-head IDs and head/publication on
both sides. The result includes an explicit 15-second target comparison and the
lack of an independently exposed rendered head identity. The UI timestamp is
an observation upper bound: public-head verification precedes UI polling and
may take time. If clipping, virtualization or another condition prevents this
oracle, full open is unavailable rather than inferred. The probe waits up to
five minutes for UI observations and retains the existing 15-second stability
wait. Unsupported fixture shapes need their own exact inventory and placement
contract.

CPU collection requires `SAVE_LOOP_ROOT` (set by the on-demand runner), Linux
`/proc` and `getconf CLK_TCK`, or macOS `ps`. The Runtime discovery PID, birth
identity and instance must match the isolated sandbox; a missing or mismatched
identity stops the run. Runtime CPU is the exact owned Runtime daemon process,
not a claim about all Runtime descendants. Browser CPU includes the launched
Chrome root and its observed descendants. Linux uses user plus system ticks;
macOS uses the cumulative `ps` CPU time, with coarse, conservatively reported
one-second resolution and second-resolution start identities. Short intervals
can quantize to zero and same-PID reuse within a second cannot be distinguished
on macOS. CPU may exceed wall time on multiple cores. Counters are sampled at
250 ms with monotonic interval duration and UTC timestamps. Processes that start
and exit between polls, exit before a final sample, or are reparented can lose
CPU. An observed identity gap or exit makes that interval unqualified and its
CPU values null. A lack of observed gaps does not eliminate missed short-lived
processes. No process arguments or environment are inspected. Opening, each
complete recorder row (including its read-only checks), and guarded cleanup are
separate CPU intervals; scenario CPU is not gesture-to-Saved CPU. Compare CPU
and wall time together on the same stack and host.

For the Plan 77 Round 4 opening sample, invoke `sweep.mjs` directly with the
usual manifest, results, versions and environment plus `--reduced-opening`.
This opt-in keeps the same isolated fixture and recorder assertions but runs
only `video-move-same-track`, `audio-move-same-track` and `audio-mute`, three
times each. The ordinary sweep remains the full matrix. The reduced sample
does not complete the 85-scenario matrix; its 255 guarded restores can each
trigger a full Runtime integrity replay.

The reduced mode gives editor readiness, its read retries and both opening
observations a shared 15-minute deadline starting immediately before cold
navigation (browser startup is outside that budget). A provisional cold UI
record is written as soon as exact IDs, tracks and Saved have been stable for
800 ms, before public-head corroboration; it is not a full-open claim. At that
marker the harness begins one-at-a-time, abortable timeline-metadata GETs and
records every attempt and `post_open_blocked_s` for the first successful read
under one second. This measures that route's availability only. Missing marker,
failed and timed-out probes are explicit. It then records a same-profile warm
reload and keeps cold and warm public-head corroboration separate. The normal
15-second cold stability delay remains recorded. First-usable and Saved times
are observation upper bounds, not proof of a successful edit.

Reduced cleanup checks the row's observed head and publication before issuing
Undo and requires an accepted commit receipt, a new head and publication,
Saved, and public content/payload digests and clip/media IDs equal to the
original. It stops on an incomplete or failed row or ambiguous Undo and does
not fall back to restore. The regular matrix and its guarded restore are
unchanged. The reduced run cannot be combined with the deliberate broken
probe flags.

To run that reduced sample, first start and own an isolated stack and use the
synthetic fixture's saved manifest and `versions.json` from that same run. Give
the results file a new path. For example:

```sh
SAVE_LOOP_ROOT=/absolute/run/stack \
SAVE_LOOP_BASE_URL=http://127.0.0.1:2400 \
SAVE_LOOP_CHROME=/absolute/path/to/chrome \
SAVE_LOOP_PLAYWRIGHT=/absolute/app/node_modules/playwright/index.mjs \
SAVE_LOOP_RESULTS=/absolute/run/reduced-results.jsonl \
node scripts/save-loop/sweep.mjs \
  --manifest /absolute/run/fixture/manifest-PROJECT.json \
  --results /absolute/run/reduced-results.jsonl \
  --versions /absolute/run/versions.json \
  --reduced-opening
```

Use the actual editor port and generated project ID in the manifest; the
manifest identifies the heavy timeline, while `versions.json` records the App,
Agent and Runtime pins. The generated fixture also has a separate one-clip
timing-control timeline. This reduced command measures the heavy timeline and
does not itself run that one-clip control. It requires an already-running
isolated stack and does not create or restore a fixture.

The recorded Round 4 and Round 5 reduced observations used a restored partial
fixture with 300 root clips, not the standard 616-root shape. The 152.779-second
Round 4 availability result came from a corrected same-Runtime continuation
with a fresh browser profile; the original fresh Round 4 stopped before a valid
availability result or gesture. The 205.452-second Round 5 result came from a
fresh run. Those times are the first complete post-open metadata reads under
one second after the provisional UI marker. The full 85-scenario matrix has not
completed: repeated guarded cleanup replays history and prevented it from
finishing. No warm gesture-to-Saved result was established. These rounds do
not qualify the standard fixture, a warm save target, or a cross-platform run.
