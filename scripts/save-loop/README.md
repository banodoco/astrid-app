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
`status.json` reports a completed fixture or sweep failure; an interrupted run
may remain `running` and is not a pass.

The larger video is encoded sequentially on CPU. The extra generation can take
substantial wall time and disk space. The initial 25 GiB free-space requirement
and 15 GiB stop floor apply; generated source media is capped at 1 GiB and the
builder checks space for an additional copy before importing it. Actual Runtime
and installation overhead can require more. The default command remains the
standard run; a pass of either variant does not establish a pass for the other.
