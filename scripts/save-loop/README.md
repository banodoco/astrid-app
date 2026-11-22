# Synthetic save-loop sweep

On Linux or macOS, use a clean committed App checkout containing the SL-0
fixture builder and the pinned install manifest and Runtime lock. Install Node
20 or newer, npm, git, curl, Python 3, ffmpeg with libx264, and Chrome or
Chromium. The App's `npm ci` installs Playwright; set `SAVE_LOOP_PLAYWRIGHT` to
an installed Playwright module if needed. Allow at least 25 GiB free on the
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

The older `scripts/save-loop/start-isolated-linux.sh` remains available for a
foreground isolated stack. It uses `SL1_SCRATCH` and replaces only its own
marked previous stack. The on-demand command always uses a new directory.

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
