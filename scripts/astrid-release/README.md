# astrid-release

One command builds an isolated Astrid stack on a release branch, with a point-in-time COPY of your live realm, so you can open your existing projects on release code.

```
scripts/astrid-release/astrid-release release/14/plan-59           build and start (or start a stopped stack as built)
scripts/astrid-release/astrid-release status release/14/plan-59    what resolves to what, and whether it runs
scripts/astrid-release/astrid-release stop release/14/plan-59      stop it
scripts/astrid-release/astrid-release update release/14/plan-59    see what moved; refuses to switch programs (see Limits)
```

macOS only. Needs a live Astrid install (`~/.local/share/astrid/install.json`), `sqlite3`, `python3`, and a `node` that meets the App's `engines` (the installed program's own node is used when it ships one). State lives in `~/astrid-release/<branch with / as ->`. To remove a stack: stop it, then delete that folder.

## What it does

1. Resolves only the App and Agent branch heads: the branch, else `release/NN/main`, else `main`, with a loud `FELL BACK` line. Runtime, VibeComfy and runpod-lifecycle come from the Agent's locks. `scripts/installer/pin.mjs --in/--out` derives and checks the manifest. Where a branch tip is not what the locks install, it prints `NOT RUNNING: ... bump its lock on the Agent branch`. If the App's `runtime.lock.json` names another Runtime than the Agent locks install, it prints a `MISMATCH (info)` line.
2. Installs with the real installer (`public/install`), flags `--autostart off --command off --skills off --skill-copies off --no-browser`, never `--managed-by`. It reads `last-run.json` as the verdict and retries up to 4 more times only on network-class errors.
3. Copies the live realm (`realm-snapshot.sh`): read-only SQLite backup of the database first, then APFS clones of the media (no extra disk), skipping `owner.lock`, `staging/` and the sqlite `-wal`/`-shm`. It verifies the copy, repoints the stack's catalog and install record at it, and runs `workspace inspect`. The copy is one-way: edits on it never reach the live realm.
4. Clears the stale Runtime owner records (`instance.lock`, `discovery.json`, only when no process of the stack is alive and the lock's pid is dead) and starts the editor. The first start on a fresh copy can fail once with "accepted commit inputs changed during verification"; the tool retries up to twice and keeps each log tail in `logs/start-attempt-N.log`.
5. Readiness is real: rendering.render ready in the Runtime capability list (nothing is rendered), the editor page answers, Runtime health says ok, and the stack's own API (`/api/runtime/v1/projects`) lists every project of the copied realm. It never falls back to an empty realm silently.
6. Records the live Runtime pid and the live launchd plist mtime before and after, and fails if either changed. It stops only the stack's own processes (recorded pids plus processes whose executable lies under the stack's root).

Open the stack at `http://127.0.0.1:<editor port>/tools/video-editor?entry=editor` (the port is printed at READY and by `status`).

## Safety

- Never touches the live stack (ports 2222, 17340, 17336, 17391 are refused) or the live data root. The live files are only read.
- No live credentials: nothing passes `ASTRID_ENV_FILE` or the other `ASTRID_*` variables into the stack. Jobs started in the stack have no live keys.
- `astrid` on PATH is still the live install. The stack's own entry is `HOME=<root>/home <root>/program/run-astrid`; never run it without that HOME.
- Autostart stays off on purpose: the installer's launchd label (`haus.astrid.runtime`) is the same global name the live service uses.

## Limits (not built)

- **Moving a built stack to new commits** is not supported. The installer's own `--update` fails on this kind of install (it probes the live launchd label and calls the stack's missing plist "malformed"), and reinstalling over kept data needs the retained Runtime source profile rewritten. Starting an existing stack starts it as built and says so when the branch moved; `update` refuses so that edits on the copy are never wiped. To test newer commits today: stop, delete the stack folder (this loses edits made on the copy) and run again.
- timeline-composition is never switched: the App and the Agent each bundle their own tarball. The launcher (astrid-pinokio) and the OMP pin are out of scope (OMP is installed at the App manifest's `tools.omp`).
- The first live-realm copy is a snapshot taken while your live Runtime may be running; the copy can need one extra start (see step 4).
- Not proven here: editing on the copy and keeping the edit across restarts.
