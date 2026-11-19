# astrid-release

Build and start a separate Astrid stack for a release branch. Its program, editor, data, HOME and logs live in `~/astrid-release/<branch with / replaced by ->`. The first realm step takes a one-way, point-in-time copy of the live workspace. Before any mutating command stops a process or writes files, it compares canonical release destinations with the configured live data root and refuses overlap in either direction, including aliases. [Root layout](astrid-release#L28-L37) · [Isolation guard](astrid-release#L149-L155) · [Canonical checks](release-state.py#L9-L30) · [First-copy guard](astrid-release#L432-L454).

## Commands and requirements

```sh
scripts/astrid-release/astrid-release release/14/plan-59
scripts/astrid-release/astrid-release status release/14/plan-59
scripts/astrid-release/astrid-release update release/14/plan-59
scripts/astrid-release/astrid-release stop release/14/plan-59
```

The first command builds or starts; `status` shows resolved heads, the editor checkout and recorded process state; `update` follows compatible changes or refuses; `stop` ends this stack's recorded/identified processes and keeps its files. Use the editor URL printed at READY or by `status`. These are explicit commands: there is no remote-branch watcher. [Dispatch](astrid-release#L18-L32) · [Status/stop](astrid-release#L130-L163) · [READY output](astrid-release#L586-L596).

Build/start/update require macOS, a live install record at `~/.local/share/astrid/install.json`, and `git`, `sqlite3`, `python3`, `node`, `npm`, `curl`, `lsof`, `shasum` and `awk`. Realm copying requires APFS clone support between source and destination. The launcher prefers the installed program's Node; its engine check compares the major version with the first number in the App's `engines.node`. [Prerequisites](astrid-release#L165-L171) · [Clone probe](realm-snapshot.sh#L99-L119) · [Node check](astrid-release#L405-L415).

Budget about **10 GB in practice** before database copies: roughly 3.6 GB for the program, 3.6 GB for the isolated home/cache and 0.7 GB for the editor, plus headroom. The install enforces **10 GiB plus twice the selected live realm database's logical byte size**, rounding the total **up** to MiB. Sparse allocation and unselected realm databases do not change that calculation. A 100 MiB + 1 byte selected database requires 10441 MiB. The diagnostic shows the fixed floor and the additional database allowance. Later checks require 2 GiB before `npm ci` and 1 GiB plus twice the selected database byte size before the snapshot. APFS media clones avoid an immediate full media copy; databases, caches and later edits still consume space. [Budget/calculation](astrid-release#L211-L226) · [Install floor](astrid-release#L337-L340) · [npm floor](astrid-release#L416-L420) · [Snapshot floor](astrid-release#L430-L437) · [Selected logical size](realm-snapshot.sh#L38-L85).

## Which code runs

| Layer | Selection and supporting code |
| --- | --- |
| App and Agent | Requested branch, then `release/NN/main`, then `main`. Each fallback prints `FELL BACK`. At least one repository must have the requested branch. [Resolution](astrid-release#L39-L63). |
| Runtime | The selected Agent's `runtime.lock.json`. [Reader](../installer/pin.mjs#L50-L57). |
| VibeComfy and runpod-lifecycle | The selected Agent's `astrid/packs/runpod/pins.json`. [Reader](../installer/pin.mjs#L59-L79). |
| timeline-composition | This tool never switches it; the existing App/Agent bundles remain. Its branch-tip lookup is informational. [Diagnostic](astrid-release#L84-L87). |
| Manifest | The tool's own `pin.mjs --in/--out` derives it; `pin.mjs --check` validates the Agent, Runtime, dependency pins and Runtime schema digest. There is no additional promised consistency checker. [Calls](astrid-release#L249-L261) · [Checks](../installer/pin.mjs#L112-L140). |

The installed `version.json` owns the door port. Missing/stale saved ports or an occupied editor port cannot replace that door; an occupied installed door on a stopped stack causes refusal when starting. The pointer and door are validated once before comparing manifests; changed-pin updates print their rebuild instructions before checking port availability. The live ports 2222, 17340, 17336 and 17391 are excluded. [Protected ports](astrid-release#L37) · [Structural validation](astrid-release#L199-L209) · [Selection after manifest decision](astrid-release#L278-L336).

## Updates and keeping edits

When the installed manifest and door match, the tool logs **already matches** and runs no installer. A running, unchanged `update` returns without stopping processes or changing the root. App-only changes can be checked out and restarted while retaining the installed program; fetching a prepared shallow checkout updates its shallow boundary explicitly. A normal start after other pins move keeps the program as built and says so. [Comparison/decisions](astrid-release#L278-L310) · [Accepted checkout](astrid-release#L343-L354).

When the derived installed manifest changes, `update` refuses **before any stop, checkout or root write**. It prepares unknown App commits and manifests in a temporary directory outside the root, and checks tracked editor changes without refreshing its Git index. The scratch parent is canonicalized before creation: a `TMPDIR` inside the release or live data root, including a symlink alias, is bypassed for an external parent. The editor destination must be a usable checkout, absent, or genuinely empty; an occupied non-checkout refuses before stopping and cannot receive a nested `editor/editor` clone. [External scratch](release-state.py#L70-L88) · [Destination/preparation](astrid-release#L228-L261) · [Refusal before mutation](astrid-release#L278-L345).

The refusal prints these rebuild steps with actual paths filled in:

1. `astrid-release stop <branch>`.
2. Keep the data: `cp -c -R <root>/data ~/astrid-release/<slug>.data-<date>`.
3. Delete the root and run `astrid-release <branch>` again.

A rebuild takes a fresh copy from live. Old edits remain in the kept clone; carrying them forward requires attaching its realm only when a read-only `SELECT version FROM runtime_schema WHERE id=1` equals `SCHEMA_VERSION` in the new Runtime's `runtime_protocol/store.py`. The tool does not perform that transfer automatically. The installer's `--update` and `astrid-runtime restart`/`down` are not this tool's lifecycle route: it uses its own stop/start because of the isolated-install limitation in [#825](https://github.com/banodoco/astrid-dev/issues/825). [Printed steps/rationale](astrid-release#L294-L305) · [Owned stop](astrid-release#L101-L125) · [Owned start](astrid-release#L484-L496).

Before any realm copy exists, an **identified** incomplete first install or retryable installer failure discards **both `program/` and `data/`**. The tool records `state/first-install.json` before the first installer attempt, binding its version, branch and canonical program/data roots; cleanup requires that exact record or genuinely absent/empty program and data directories. Missing current/realm markers alone do not authorize deletion of unexplained existing data. Isolation and ownership are checked again immediately before paired cleanup. Once `state/realm-id` exists, cleanup refuses; a missing program pointer also refuses before installation. Installer attempts are capped at five, and only the listed network-error strings trigger retries. A successful installer verdict removes the first-install record. [Positive ownership](release-state.py#L33-L69) · [Early protection](astrid-release#L176-L197) · [Paired cleanup/retries](astrid-release#L368-L399).

## The realm and isolation

The tool stops its stack, clones `data/` to `data.pre-realm`, then snapshots once. It takes a read-only SQLite backup including committed WAL data, clones allowed media, checks integrity/media and uses the installed Runtime's `workspace attach`. Snapshot publication checks **both `instance.lock` and `discovery.json`**, realm admission locks and realm owner locks at entry and again under the Runtime's existing `runtime/bootstrap.lock` at the destructive handoff. Catalog ownership paths are canonicalized and deduplicated before locking, so macOS temporary-directory aliases identify the same lock. A live owner or catalog change during copying refuses publication. The catalog backup, publication, unselection and removal of proven-stale records happen while those locks are held. The helper then releases the mutex before calling `workspace attach`, which acquires the same mutex itself; the absent catalog prevents ordinary `up` from launching the previous selection in between. [Caller/backup](astrid-release#L424-L437) · [SQLite backup](realm-snapshot.sh#L138-L153) · [Verification](realm-snapshot.sh#L180-L232) · [Owner checks/mutex](realm-handoff.py#L28-L109) · [Locked publication](realm-handoff.py#L127-L173) · [External attach](realm-snapshot.sh#L295-L318).

Attach succeeds only with **exit 0 and `configured_attach`**. On failure the helper restores the old catalog under the same mutex only if ownership and selection still permit rollback; it refuses to overwrite a new owner's records or a different workspace selection. It never hand-migrates the database. The copied realm remains available for inspection. [Rollback checks](realm-handoff.py#L172-L181) · [Exit/status and recovery diagnostics](realm-snapshot.sh#L305-L315).

When Runtime refuses an attach, the release caller preserves its exit status and output, then uses the same installed Python to run `runtime_protocol doctor --root <copied-realm> --json --admission-timeout 120`. The diagnostic has a 125-second outer process limit and prints the actual report, including observed and expected schema versions when available. A timed-out or unavailable report stays diagnostic only; it cannot authorize an attach. Successful attach JSON is unchanged. This App-side diagnostic covers the generic Runtime refusal tracked in [astrid-dev #935](https://github.com/banodoco/astrid-dev/issues/935). [Caller](workspace-attach.py).

### Recovery after an attach failure

The forced-exit-7 fixture emits `configured_attach` and then exits 7. The command correctly fails, restores the previous catalog, and retains both its catalog backup and the published copy at `data/runtime/realms/<realm-id>`. The caller has not written `state/realm-id`. **An ordinary retry fails with “destination already has realm”**; rollback restores the catalog only and does not delete that copy. The fixture checks those retained bytes and the retry refusal. [Exit-7/retry assertions](test_realm_attach.py#L208-L221) · [Marker after success](astrid-release#L437-L454).

For recovery, stop this release stack and use the explicit stop / keep-data / rebuild procedure above. Preserve the entire `data/` clone (including the published realm and `runtime/catalog.json.pre-realm-snapshot`), `data.pre-realm` and the failure logs before deleting the release root; verify those copies first. The fresh build copies from live again. Carrying edits from a kept realm forward still requires the schema-compatibility check above and an explicit Runtime attach. If restoration itself reports changed ownership or selection, inspect and stop that owner before recovery. Do not treat a successful-looking JSON status as permission to proceed, delete just the failed realm automatically, or change its schema version. [Refusal to overwrite](realm-snapshot.sh#L267-L272) · [Preserving rollback](realm-handoff.py#L172-L181).

The copy omits old owner state, staging contents, SQLite sidecars, caches and `runpod/`, and creates a fresh empty `owner.lock`. The live data root's sibling `runpod/` lies outside the copied realm. There is no copy-back route; the saved realm ID prevents resnapshotting on later starts. [Excluded names](realm-snapshot.sh#L68-L75) · [Traversal](realm-snapshot.sh#L155-L178) · [Destination/marker](astrid-release#L432-L454).

One hand edit remains: the isolated installer record's `realm_id` and `realm_root`, with its stale `foreground` entry removed. The tool then asks the Runtime to inspect the copy. [Record edit/inspect](astrid-release#L444-L462).

Installation uses `--autostart off --command off --skills off --skill-copies off --no-browser`, never `--managed-by`. It asks the installer not to replace the `astrid` command on PATH, which stays the live installation's command. Use **`HOME=<root>/home <root>/program/run-astrid`** for this stack. The stack gets its own HOME/XDG/TMPDIR and data root. Incoming `ASTRID_*`, `VITE_*`, `WORKSPACE_*` and Python environment selectors are filtered; other exported variables are inherited, so this is not a universal secret scrubber. [Environment](astrid-release#L263-L277) · [Installer flags](astrid-release#L360-L385) · [Data-root launch](astrid-release#L485-L491) · [CLI output](astrid-release#L593).

GPU work through that entry uses the stack's own configuration and claims; the snapshot does not import live RunPod claims. **Release any machine claimed by the stack before manually deleting its root.** This is an operator obligation: `stop` stops local processes and keeps files; the script does not release rented machines. [Isolation](astrid-release#L263-L277) · [RunPod exclusion](realm-snapshot.sh#L68-L75) · [Stop](astrid-release#L101-L125).

## Packet hosted proof: unchanged update

R14-P61-02's [hosted proof](hosted-proof.py) runs only on a GitHub-hosted Mac.
Under [Lead decision 6994841405, item 1](https://github.com/banodoco/astrid-dev/issues/796#issuecomment-6994841405),
Completion 5 compares the PID and start time of the persistent Runtime, editor,
agent host, chat service and Astrid launchd entries. Runtime discovery and the
tool's recorded identities anchor the census; installed service declarations
identify Runtime-owned host/chat processes. The editor comparison includes its
proxy, Vite server, persistent wrappers and esbuild service. Relative commands
are found through parent PIDs. Missing, ambiguous or changed identities fail.

`completion-05-before.json` and `completion-05-after.json` retain the complete
parsed process lists, service identities, other child-command observations and
the candidate's read-only database facts, including epoch and boot identity.
The corresponding `-ps.txt` files retain the full untruncated OS census, and
`-launchctl-list.txt` retains the full launchd listing. The after snapshot and
`completion-05-comparison.json` are written even when update fails or times out.
Database bytes, credential files and launchd environment values are not copied.
The candidate is installed with autostart off; the existing live launchd job
must keep its identity, and no candidate launchd plist may appear.

Short-lived child commands are observations, not service identity comparisons.
The raw chat logs and `chat-model-timeouts.json` in each retained log snapshot
record every exact model-command SIGKILL/timeout occurrence and byte offset.
A repeat is reported to Lead without treating it as proof of a service restart.
The [native C5 probes](test_hosted_processes.py) exercise service exits,
replacement PIDs, reused PIDs with changed start times, child churn and missing
evidence; they run in the existing PR macOS step and before the real stack run.

## Readiness and known limits

READY requires a ready `rendering.render` capability, an answering editor page, Runtime health `ok`, and agreement between the copy's project names and the projects listed through the proxy. It does not render an output. The timeline-count check is weaker: it reports a skip if its query fails. [Readiness](astrid-release#L505-L550) · [Project/timeline checks](astrid-release#L562-L581).

Startup retries only the exact known message “accepted commit inputs changed during verification” from the current launch. Each retry prints `WARNING` and its count (`1/2` or `2/2`); an unrelated readiness failure stops after its first attempt. Failed tails remain in `logs/start-attempt-N.log`. A pre-launch cursor excludes historical Runtime log entries, including an old verification error, from both classification and the retained tail. The Runtime error's underlying cause remains unestablished; this guard does not claim to repair it. [Startup loop](astrid-release#L471) · [Current-attempt log boundary and classification](startup-log.py) · [Guard tests](startup.test.mjs).

The built-in live check compares the launchctl PID/label and plist mtime, plus a warning-only stable-file listing around the copy. It is **not** RB-6's full live-file hash/database-fact proof. Fixture results do not establish a real editor run, an edit surviving restart or an untouched live install. [Recorded values](astrid-release#L357-L358) · [Listing comparison](astrid-release#L436-L442) · [Final comparison](astrid-release#L582-L584).

## Fixture commands

Run from the repository root with Node 20.19.4 (`.nvmrc`):

```sh
bash -n scripts/astrid-release/astrid-release
bash -n scripts/astrid-release/realm-snapshot.sh
node --test scripts/astrid-release/release.test.mjs scripts/astrid-release/workflow.test.mjs
node --test scripts/installer/manifest.test.mjs
REALM_TEST_PYTHON=/absolute/path/to/scratch-runtime-venv/bin/python \
  scripts/astrid-release/test-realm-snapshot.sh
```

The shell fixture requires macOS/APFS and `sqlite3`. Install the Runtime and its `packages/python` client into a scratch Python environment from an exact checkout of `public/install-manifest.json`'s Runtime SHA. The added fixture verifies that identity and runs real `workspace create`, `attach` and `inspect`, including wrong-ID/schema refusals, ownership races, mutex contention, exit-7 recovery boundaries and unchanged source hashes. It starts no Runtime daemon. [Native fixture](test-realm-snapshot.sh#L1-L136) · [Runtime fixture](test_realm_attach.py#L1-L327).

Automatic PR CI supplies the native macOS/APFS proof. In the existing macOS job, the original command runs first and unchanged. Python setup follows it only for PRs targeting `release/14/plan-61`; one additional proof step runs the release, workflow and unchanged manifest cases, then the native shell/Runtime fixtures in a private runner scratch root. The added setup/proof do not run on inherited push or dispatch events. Failures propagate normally, with no `continue-on-error` or successful-exit override. A sandbox remote-fetch failure remains a failure locally; hosted CI decides the unchanged manifest suite against real remotes. [Job](../../.github/workflows/test.yml#L124-L167) · [Ordering/scope assertion](workflow.test.mjs#L1-L34).

For Linux logic proof only, use that Python environment with `-I scripts/astrid-release/test_realm_attach.py --portable`. This explicitly uses filesystem-copy and SQLite-CLI adapters; it is not APFS proof. The Node fixtures explicitly double macOS discovery, installer and Runtime handoff while using real Git and `pin.mjs`; stopped-start cases end at a deliberate Runtime-refusal sentinel. [Adapters/boundaries](test_realm_attach.py#L1-L170) · [Entry-point fixtures](release-fixture.mjs#L1-L184) · [Assertions](release.test.mjs#L1-L315).
