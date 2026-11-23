# Synthetic save-loop sweep

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

The `film-shaped` builder can create a synthetic timeline on an already owned
isolated SL-1 stack. Set `SAVE_LOOP_ROOT` to the stack root and
`SAVE_LOOP_BASE_URL` to its local editor origin, then run:

```sh
node scripts/save-loop/build-fixture.mjs --variant film-shaped
```

The resulting manifest records the accepted Runtime head and generated media.
Collection and project pack admission and render proof remain pending; this
builder does not establish a successful sweep. Its sources can also be prepared
independently for development:

```sh
node scripts/save-loop/build-fixture.mjs --variant film-shaped --prepare-media
```

This writes a synthetic image and 90-second video and audio to a fresh directory under
`SAVE_LOOP_SCRATCH` (default `<app-checkout>.env/save-loop`) and prints their
paths and object hashes. `--media-size WIDTHxHEIGHT` selects the even image and video
dimensions (default `1280x720`); `--clips` records the requested count (default
621). Media preparation does not create a timeline or prove the film fixture.
It uses the same disk floor as large shots.

The `large-shots` command creates a fresh stack and performs one fixture build and sweep. It retains
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

For the film-shaped pack fixture, set `SAVE_LOOP_COLLECTION_PACK` to the path
of the installed `astrid_motion` fixture pack (for example, the Agent checkout's
`tests/fixtures/packs/astrid_motion`). The Runtime and renderer must also have
that same pack revision available through their normal pack discovery. The
builder resolves the collection revision from that source, admits a generated
project effect, and reports the retained references in the manifest. Pack
admission and rendering require the Runtime's installed Remotion toolchain.

To run `film-animation-contract.test.mjs`, set `SAVE_LOOP_TEST_PYTHON` to a
Python interpreter with the Agent package installed (or importable through
`PYTHONPATH`); it defaults to `python3`.
