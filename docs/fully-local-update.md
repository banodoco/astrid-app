# Fully local App updates

Run a fully local App update from the checkout whose editor is currently running. Open a second terminal in that same checkout and run:

```sh
npm run update
```

The updater checks the App build served by `https://astrid.haus`, prepares that exact App version, preserves unrelated source edits, then restarts and verifies the local App and installed Runtime. It requires the normal local launcher, an already provisioned installer-managed Runtime, and the paired E1 App and Agent updater modules. The first fully local update baseline therefore starts from an installation provisioned with the matching E1 Agent module. Older App checkouts do not have `npm run update`; they are not valid canary baselines and the backend reports that updater capability as unavailable. Source-only checkouts are refused. Pinokio users can keep using its existing **Update** action; that action calls this App updater and retains the Pinokio session owner.

## Native canary fixture

The canary driver is `scripts/installer/local-update-canary.mjs`. It expects a disposable native machine with an isolated installed Runtime and data root, plus a previous served App checkout with dependencies already installed and the paired E1 updater capability. Start the App from that checkout with its normal `npm run dev:local` launcher, then invoke the canary from the update-capable checkout. Do not point it at a personal workspace or Runtime.

Set these values on each native runner:

| Variable | Value |
| --- | --- |
| `ASTRID_CANARY_CHECKOUT` | Absolute path to the prior App checkout |
| `ASTRID_CANARY_PREVIOUS_APP_SHA` | 40 character SHA that was served before the release under test |
| `ASTRID_CANARY_APP_ORIGIN` | Local editor origin, normally `http://127.0.0.1:5180` |
| `ASTRID_CANARY_DISCOVERY` | Absolute path to the selected install's `runtime/discovery.json` |
| `ASTRID_CANARY_RUNTIME_ENDPOINT` | Optional expected Runtime endpoint; if supplied, it must match discovery |
| `ASTRID_CANARY_EXPECTED_MANAGER` | `pinokio` for Pinokio installs, `null` for a regular installed backend |

The discovery file points to the private product credential used for health and handshake checks. Keep that file and token private; do not pass credentials as command-line arguments or print them in logs.

### Ubuntu

In Bash, export the fixture values and run from the update-capable App checkout:

```sh
export ASTRID_CANARY_CHECKOUT=/srv/astrid-canary/previous-app
export ASTRID_CANARY_PREVIOUS_APP_SHA='<previous-served-app-sha>'
export ASTRID_CANARY_APP_ORIGIN=http://127.0.0.1:5180
export ASTRID_CANARY_DISCOVERY=/srv/astrid-canary/data/runtime/discovery.json
export ASTRID_CANARY_EXPECTED_MANAGER=null
node scripts/installer/local-update-canary.mjs
```

### Windows

In PowerShell, set the fixture values and run from the update-capable App checkout:

```powershell
$env:ASTRID_CANARY_CHECKOUT = 'C:\AstridCanary\previous-app'
$env:ASTRID_CANARY_PREVIOUS_APP_SHA = '<previous-served-app-sha>'
$env:ASTRID_CANARY_APP_ORIGIN = 'http://127.0.0.1:5180'
$env:ASTRID_CANARY_DISCOVERY = 'C:\AstridCanary\data\runtime\discovery.json'
$env:ASTRID_CANARY_EXPECTED_MANAGER = 'null'
node scripts/installer/local-update-canary.mjs
```

### macOS

In Terminal, export the fixture values and run from the update-capable App checkout:

```sh
export ASTRID_CANARY_CHECKOUT=/Users/Shared/AstridCanary/previous-app
export ASTRID_CANARY_PREVIOUS_APP_SHA='<previous-served-app-sha>'
export ASTRID_CANARY_APP_ORIGIN=http://127.0.0.1:5180
export ASTRID_CANARY_DISCOVERY=/Users/Shared/AstridCanary/data/runtime/discovery.json
export ASTRID_CANARY_EXPECTED_MANAGER=null
node scripts/installer/local-update-canary.mjs
```

For a Pinokio fixture, use `ASTRID_CANARY_EXPECTED_MANAGER=pinokio`. The driver checks the starting Git SHA, runs `npm run update`, compares local `/build.json` with the served App, and verifies that App config, discovery, Runtime health, and the authenticated product handshake agree on the release and identity. On refusal or recovery failure, retain the journal, preparation directory, and previous build/dependency copies for diagnosis; use the same launcher to retry recovery.

These native Ubuntu, Windows, and macOS execution legs are **written, not run**. The mock-backed Node tests cover the canary assertions. The existing served-manifest workflow checks release manifest coherence; it does not run native local updates. E1 keeps the Settings Update button out of scope; the thin fully local Settings adapter follows F1.
