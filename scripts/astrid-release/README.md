# astrid-release

Build and start a separate Astrid stack for a release branch. Its program, editor, data, HOME and logs live in `~/astrid-release/<branch with / replaced by ->`. The first realm step takes a one-way, point-in-time copy of the live workspace. [Root layout](astrid-release#L28-L37) · [First-copy guard](astrid-release#L389-L420).

## Commands and requirements

```sh
scripts/astrid-release/astrid-release release/14/plan-59
scripts/astrid-release/astrid-release status release/14/plan-59
scripts/astrid-release/astrid-release update release/14/plan-59
scripts/astrid-release/astrid-release stop release/14/plan-59
```

The first command builds or starts; `status` shows resolved heads, the editor checkout and recorded process state; `update` follows compatible changes or refuses; `stop` ends this stack's recorded/identified processes and keeps its files. Use the editor URL printed at READY or by `status`. These are explicit commands: there is no remote-branch watcher. [Dispatch](astrid-release#L18-L32) · [Status/stop](astrid-release#L130-L155) · [READY output](astrid-release#L551-L562).

Build/start/update require macOS, a live install record at `~/.local/share/astrid/install.json`, and `git`, `sqlite3`, `python3`, `node`, `npm`, `curl`, `lsof`, `shasum` and `awk`. Realm copying requires APFS clone support between source and destination. The launcher prefers the installed program's Node; its engine check compares the major version with the first number in the App's `engines.node`. [Prerequisites](astrid-release#L157-L166) · [Clone probe](realm-snapshot.sh#L99-L119) · [Node check](astrid-release#L370-L379).

Budget about **10 GB in practice** before database copies: roughly 3.6 GB for the program, 3.6 GB for the isolated home/cache and 0.7 GB for the editor, plus headroom. The install enforces **10 GiB plus twice the live realm database size**, rounded to MiB. Later checks require 2 GiB before `npm ci` and 1 GiB plus twice the database byte size before the snapshot. APFS media clones avoid an immediate full media copy; databases, caches and later edits still consume space. [Budget/calculation](astrid-release#L224-L232) · [Install floor](astrid-release#L327-L328) · [npm floor](astrid-release#L380-L384) · [Snapshot floor](astrid-release#L393-L395) · [Snapshot calculation](realm-snapshot.sh#L77-L97).

## Which code runs

| Layer | Selection and supporting code |
| --- | --- |
| App and Agent | Requested branch, then `release/NN/main`, then `main`. Each fallback prints `FELL BACK`. At least one repository must have the requested branch. [Resolution](astrid-release#L39-L63). |
| Runtime | The selected Agent's `runtime.lock.json`. [Reader](../installer/pin.mjs#L50-L57). |
| VibeComfy and runpod-lifecycle | The selected Agent's `astrid/packs/runpod/pins.json`. [Reader](../installer/pin.mjs#L59-L79). |
| timeline-composition | This tool never switches it; the existing App/Agent bundles remain. Its branch-tip lookup is informational. [Diagnostic](astrid-release#L84-L87). |
| Manifest | The tool's own `pin.mjs --in/--out` derives it; `pin.mjs --check` validates the Agent, Runtime, dependency pins and Runtime schema digest. There is no additional promised consistency checker. [Calls](astrid-release#L246-L258) · [Checks](../installer/pin.mjs#L112-L140). |

The installed `version.json` owns the door port. Missing/stale saved ports or an occupied editor port cannot replace that door; an occupied installed door on a stopped stack causes refusal. The live ports 2222, 17340, 17336 and 17391 are excluded. [Protected ports](astrid-release#L37) · [Selection](astrid-release#L191-L222).

## Updates and keeping edits

When the installed manifest and door match, the tool logs **already matches** and runs no installer. A running, unchanged `update` returns without stopping processes or changing the root. App-only changes can be checked out and restarted while retaining the installed program. A normal start after other pins move keeps the program as built and says so. [Comparison/decisions](astrid-release#L274-L309) · [Accepted checkout](astrid-release#L311-L326).

When the derived installed manifest changes, `update` refuses **before any stop, checkout or root write**. It prepares unknown App commits and manifests in a temporary directory outside the root, and checks tracked editor changes without refreshing its Git index. [Read-only preparation](astrid-release#L234-L258) · [Refusal before mutation](astrid-release#L292-L314).

The refusal prints these rebuild steps with actual paths filled in:

1. `astrid-release stop <branch>`.
2. Keep the data: `cp -c -R <root>/data ~/astrid-release/<slug>.data-<date>`.
3. Delete the root and run `astrid-release <branch>` again.

A rebuild takes a fresh copy from live. Old edits remain in the kept clone; carrying them forward requires attaching its realm only when a read-only `SELECT version FROM runtime_schema WHERE id=1` equals `SCHEMA_VERSION` in the new Runtime's `runtime_protocol/store.py`. The tool does not perform that transfer automatically. The installer's `--update` and `astrid-runtime restart`/`down` are not this tool's lifecycle route: it uses its own stop/start because of the isolated-install limitation in [#825](https://github.com/banodoco/astrid-dev/issues/825). [Printed steps/rationale](astrid-release#L292-L304) · [Owned stop](astrid-release#L101-L125) · [Owned start](astrid-release#L449-L457).

Before any realm copy exists, incomplete first installs and retryable installer failures discard **both `program/` and `data/`**. Once `state/realm-id` exists, cleanup refuses; a missing program pointer also refuses before installation. Installer attempts are capped at five, and only the listed network-error strings trigger retries. [Early protection](astrid-release#L187-L189) · [Paired cleanup/retries](astrid-release#L337-L364).

## The realm and isolation

The tool stops its stack, clones `data/` to `data.pre-realm`, then snapshots once. It takes a read-only SQLite backup including committed WAL data, clones allowed media, checks integrity/media and uses the installed Runtime's `workspace attach`. It keeps the old catalog, removes owner records only after stopped-owner checks, and requires both a successful attach exit and `configured_attach`. Failure restores the old catalog; it does not hand-migrate the database. [Caller/backup](astrid-release#L389-L403) · [SQLite backup](realm-snapshot.sh#L137-L152) · [Verification](realm-snapshot.sh#L180-L232) · [Owner guards/attach](realm-snapshot.sh#L294-L368).

The copy omits old owner state, staging contents, SQLite sidecars, caches and `runpod/`, and creates a fresh empty `owner.lock`. The live data root's sibling `runpod/` lies outside the copied realm. There is no copy-back route; the saved realm ID prevents resnapshotting on later starts. [Excluded names](realm-snapshot.sh#L68-L75) · [Traversal](realm-snapshot.sh#L155-L178) · [Destination/marker](astrid-release#L397-L420).

One hand edit remains: the isolated installer record's `realm_id` and `realm_root`, with its stale `foreground` entry removed. The tool then asks the Runtime to inspect the copy. [Record edit/inspect](astrid-release#L409-L427).

Installation uses `--autostart off --command off --skills off --skill-copies off --no-browser`, never `--managed-by`. It asks the installer not to replace the `astrid` command on PATH, which stays the live installation's command. Use **`HOME=<root>/home <root>/program/run-astrid`** for this stack. The stack gets its own HOME/XDG/TMPDIR and data root. Incoming `ASTRID_*`, `VITE_*`, `WORKSPACE_*` and Python environment selectors are filtered; other exported variables are inherited, so this is not a universal secret scrubber. [Environment](astrid-release#L260-L273) · [Installer flags](astrid-release#L329-L350) · [Data-root launch](astrid-release#L450-L456) · [CLI output](astrid-release#L558).

GPU work through that entry uses the stack's own configuration and claims; the snapshot does not import live RunPod claims. **Release any machine claimed by the stack before manually deleting its root.** This is an operator obligation: `stop` stops local processes and keeps files; the script does not release rented machines. [Isolation](astrid-release#L260-L273) · [RunPod exclusion](realm-snapshot.sh#L68-L75) · [Stop](astrid-release#L101-L125).

## Readiness and known limits

READY requires a ready `rendering.render` capability, an answering editor page, Runtime health `ok`, and agreement between the copy's project names and the projects listed through the proxy. It does not render an output. The timeline-count check is weaker: it reports a skip if its query fails. [Readiness](astrid-release#L470-L515) · [Project/timeline checks](astrid-release#L527-L546).

Startup has at most two retries after the initial attempt and retains failed tails in `logs/start-attempt-N.log`. The known first-copy message is “accepted commit inputs changed during verification”. **The current loop retries any readiness failure; it does not yet restrict retries to that message.** That remaining guard/trace work belongs to Plan 61 RB-9, outside this fixture packet. [Loop](astrid-release#L436-L441) · [Failure handling](astrid-release#L517-L523).

The built-in live check compares the launchctl PID/label and plist mtime, plus a warning-only stable-file listing around the copy. It is **not** RB-6's full live-file hash/database-fact proof. Fixture results do not establish a real editor run, an edit surviving restart or an untouched live install. [Recorded values](astrid-release#L324-L325) · [Listing comparison](astrid-release#L401-L407) · [Final comparison](astrid-release#L547-L549).

## Fixture commands

Run from the repository root with Node 20.19.4 (`.nvmrc`):

```sh
bash -n scripts/astrid-release/astrid-release
bash -n scripts/astrid-release/realm-snapshot.sh
node --test scripts/astrid-release/release.test.mjs
node --test scripts/installer/manifest.test.mjs
REALM_TEST_PYTHON=/absolute/path/to/scratch-runtime-venv/bin/python \
  scripts/astrid-release/test-realm-snapshot.sh
```

The shell fixture requires macOS/APFS and `sqlite3`. Install the Runtime and its `packages/python` client into a scratch Python environment from an exact checkout of `public/install-manifest.json`'s Runtime SHA. The added fixture verifies that identity and runs real `workspace create`, `attach` and `inspect`, including wrong-ID/schema refusals and unchanged source hashes. It starts no Runtime daemon. [Native fixture](test-realm-snapshot.sh#L1-L136) · [Runtime fixture](test_realm_attach.py#L1-L220).

For Linux logic proof only, use that Python environment with `-I scripts/astrid-release/test_realm_attach.py --portable`. This explicitly uses filesystem-copy and SQLite-CLI adapters; it is not APFS proof. The Node fixtures explicitly double macOS discovery, installer and Runtime handoff while using real Git and `pin.mjs`; stopped-start cases end at a deliberate Runtime-refusal sentinel. [Adapters/boundaries](test_realm_attach.py#L1-L137) · [Entry-point fixtures](release-fixture.mjs#L1-L177) · [Assertions](release.test.mjs#L1-L173).
