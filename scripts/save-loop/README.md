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
document-size or timing target checks before Chrome starts; the failure names
each missed target. The generated
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

By default the fixture includes two deliberately ambiguous `"repeat"` word
declarations for refusal checks. Add `--omit-ambiguous-anchors` to omit those
declarations while retaining their footage clips and the repeated transcript
words. The measurement reports the two unique resolved targets and the number
of intentionally omitted declarations.

The resulting manifest records the accepted Runtime head and generated media. The
fixture imports two distinct images and two distinct videos for same-kind overlay
swaps, and verifies their accepted identities and metadata.
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
621; minimum 23). Media preparation does not create a timeline or prove the film fixture.
It uses the same disk floor as large shots.

The `large-shots` command creates a fresh stack and performs one fixture build and sweep. It retains
all standard 616 parent clips, 46 normal shot occurrences, the document-size
floor and 15x one-clip timing requirements, and all matrix targets. In addition,
three generated 480-second shot occurrences each contain 32 child clips on
visual and audio tracks. The clips use generated 90-second video and audio
sources, with 30-second source windows. No user media or GPU is used. The
variant is optional and does not run as part of the default command.
Each child commit runs in a fresh SDK commit session, so the builder verifies
the two child media selections through the Runtime and stages each
`occurrence.add-media` captured, the same way `t.add()` adds the root clips.

### Fixture size targets

The builder passes when the accepted document has the requested clip count, at
least `SAVE_LOOP_DOCUMENT_BYTES` canonical bytes, and a warm-move median at
least `SAVE_LOOP_COMMIT_RATIO` (default 15) times the one-clip control. The
document default is a floor of 850 bytes per requested clip (523,600 bytes for
616 clips). It guards against a thinner generated shape; it is not the owner
profile.

The Plan 77 profile of the owner's real timeline was 616 clips and about
2.6 MB. Generated clips carry much less per-clip data than that timeline: the
standard 616-clip build measures about 576 to 581 KB (575,879 and 580,654 bytes
in two runs) and the 300-clip build 325,185 bytes: about 800 bytes per added
clip over a fixed 85 KB. Adding clips alone would need roughly 3,000 clips to
reach 2.6 MB. The manifest therefore records
`measurement.profile_document_bytes` (2,600,000) and
`measurement.profile_document_bytes_met`, and the builder prints a note when the
document is smaller. A passing standard fixture reproduces the profile's clip
count, track layout, asset mix and warm commit ratio, not its document size.
To require the profile size anyway, set `SAVE_LOOP_DOCUMENT_BYTES=2600000`;
the standard shape will then fail.

### Direct builds, the 300-clip recipe and expected times

`run.sh` always builds the default shape: it clears `SAVE_LOOP_CLIPS`,
`SAVE_LOOP_DOCUMENT_BYTES` and `SAVE_LOOP_COMMIT_RATIO`. For another size, run
the builder directly against an already owned isolated stack (the same
`SAVE_LOOP_ROOT` and `SAVE_LOOP_BASE_URL` as above; the stack's editor must run
from this App checkout). The standard and `large-shots` variants accept 160 or
more clips (the sweep needs ten video and ten audio targets).

The Release 15 heavy-timeline qualification uses a 300-clip standard fixture:

```sh
SAVE_LOOP_ROOT=/absolute/run/stack SAVE_LOOP_BASE_URL=http://127.0.0.1:2400 \
SAVE_LOOP_SCRATCH=/absolute/run/fixture SAVE_LOOP_CLIPS=300 \
  node scripts/save-loop/build-fixture.mjs
```

With the default floor (300 x 850 = 255,000 bytes) this passes: one run
accepted 300 clips and 46 shots with a 325,185-byte document and a 23.7x
warm-move ratio (14.83 s against 0.625 s), manifest `status: pass` and
`profile_document_bytes_met: false`. The document size is deterministic: an
earlier run produced the same 325,185 bytes (28.9x). An explicit
`SAVE_LOOP_DOCUMENT_BYTES=900000` cannot pass with 300 generated clips; that
earlier run failed only on its document target. Use the printed manifest with the
sweep as above. A 300-clip fixture is the qualification shape for Release 15's
300-clip heavy-timeline journey; it is not the 616-clip standard fixture.

The large nested shots can be added to any size with `--variant large-shots`
(for example `SAVE_LOOP_CLIPS=300 node scripts/save-loop/build-fixture.mjs
--variant large-shots`). They add three 480-second shots, 96 child clips, two
90-second sources and 12 child commits.

Observed build times on one Linux container (single run each; commit time
grows with the document, so larger builds take disproportionately longer):

| Build | Wall time | Document |
| --- | --- | --- |
| Standard, 300 clips | 13 min 21 s and 13 min 40 s (media import about 58 s, clip commits about 520 s, shots 136 to 144 s) | 325,185 bytes |
| Standard, 616 clips (default) | about 67 min | 575,879 to 580,654 bytes |
| `large-shots`, 30 clips (patched-minimum development check, not a fixture) | 5 min 27 s (child commits 232 s) | 133,563 bytes |
| `large-shots`, 616 clips | not yet measured; more than 70 min (children start after about 70 min) | not measured |

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
