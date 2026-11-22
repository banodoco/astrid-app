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
clock starts immediately before navigation. A real Enter selection on the
manifest target records visibility and selection response; this is only a
selection probe, not proof that the first 15 seconds are rendered or editable,
or that the selection left the public head unchanged. Full open requires the
exact standard clip IDs and nine tracks present with Saved in one UI sample,
and the same exact public-head IDs and head/publication on both sides of that
sample. The editor does not expose the rendered head identity to this harness,
so even that agreement is recorded as corroboration, not a confirmed full-open
claim. The UI timestamp is an observation upper bound: public-head verification
precedes UI polling and may itself take time. If offscreen clips are virtualized this conservative check reports no
full-open milestone; it does not equate a public snapshot with rendered UI.
The approximately 5-second first-usable and 15-second full-open targets are
reported separately from the existing gesture-to-Saved timing. The probe waits
up to five minutes for full UI and retains the existing 15-second stability
wait. Standard IDs derive from the manifest's clip count and prefix asset
counts (or full asset counts), in image/video/audio order; unsupported fixture
shapes must supply a suitable exact inventory before use.

CPU collection requires Linux, `getconf CLK_TCK`, `/proc`, and `SAVE_LOOP_ROOT`
(the on-demand runner sets it). The Runtime discovery PID, birth identity and
instance must match the isolated sandbox; a missing or mismatched identity
stops the run. Runtime CPU is the exact owned Runtime daemon process, not a claim
about all Runtime descendants. Browser CPU includes the launched Chrome root
and its observed descendants. These counters use user plus system ticks at
250 ms polling, with monotonic interval duration and UTC timestamps. CPU can
exceed wall time on multiple cores. Processes that start and exit between polls,
exit before their final sample, or are reparented can lose CPU; observed exits
and gaps are counted, and new descendants contribute their observed cumulative
CPU. Tick resolution is reported with every interval. No process arguments or
environment are read. Opening, each complete recorder row (including its
read-only checks), and guarded cleanup are separate CPU intervals; scenario
CPU is not gesture-to-Saved CPU. Compare CPU and wall time together on the same
stack and host. macOS CPU collection is unavailable; no value is fabricated.
