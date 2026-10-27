# Fully local update canary

The native canary driver is `scripts/installer/local-update-canary.mjs`. See the [fully local update guide](fully-local-update.md#native-canary-fixture) for the required E1 baseline, isolated installed-backend fixture, environment settings, and Ubuntu, Windows, and macOS commands.

The leg starts from a previously served App commit, invokes its `npm run update`, and verifies the served App build, selected Runtime release and instance, realm, and authenticated product handshake. Real native canary execution is **written, not run**; the Node fixture tests check the driver assertions. The existing served-manifest workflow does not execute this native leg.
