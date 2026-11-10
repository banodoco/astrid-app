# Extension Trust and Security

**Status:** Describes the shipped App extension loader at M4-09c
**Last updated:** 2026-11-02

This page describes the security properties of extension code and live world
previews in the shipped App. Admission checks can reject packages before the
installed entry is imported; checks on that entry's exports happen only after
JavaScript module evaluation has begun. Neither path provides isolation for
extension modules.

## Extension code runs with the App's browser privileges

The App has two extension inputs:

- **Direct extensions** are supplied by the host as already-imported extension
  objects.
- **Installed packages** are read from the App's package repository. The
  loader checks package metadata and local integrity, then requires a matching,
  enabled entry in the live Runtime pack inventory before importing the
  package's JavaScript entry from the Runtime asset URL.

For installed packages, `bundleContent` is the local integrity-check input;
the repository wiring can place the builder artifact-manifest JSON in that
content slot, with the installed record's integrity value covering that
carrier. The loader then checks artifact and extension identity, matches the
artifact manifest and entry descriptor against the live Runtime inventory, and
checks the host build's pinned React, React DOM, Remotion, and SDK import-map
bindings before calling `import()` on the Runtime asset URL. These checks
establish that the local carrier and descriptor match the admitted Runtime
inventory and the expected entry URL. The loader does not hash the JavaScript
response bytes returned by that `import()`. The Runtime inventory and asset
server are a separate boundary; these checks do not establish the safety of
the code or its author. See [`extensionLoader.ts`](../../src/tools/video-editor/runtime/extensionLoader.ts)
and [`useExtensionLoaderWiring.ts`](../../src/tools/video-editor/runtime/useExtensionLoaderWiring.ts).

The package, integrity, enablement, Runtime inventory, entry descriptor, and
shared-module checks occur before the installed entry's `import()` call. After
that call resolves, the loader checks that the module's default export is an
activatable extension whose manifest matches the admitted manifest. Module
evaluation runs as part of `import()`: top-level code in the entry and its
imported dependencies may already have executed before that export or identity
check rejects the extension, and a failed evaluation cannot be undone. See
[`extensionLoader.ts`](../../src/tools/video-editor/runtime/extensionLoader.ts)
for the import and subsequent export check, and
[`extensionPackageManifest.ts`](../../src/tools/video-editor/runtime/extensionPackageManifest.ts)
for package validation.

After admission and successful export checks, installed entries run in the
App's browser context. Direct and installed extensions therefore execute as
code in the editor page: they share its JavaScript realm, origin, and main
thread. Extension modules do not run in a Worker or sandboxed iframe. They can
use the DOM and browser APIs available to page scripts, subject to the
browser's normal rules, including same-origin policy and browser permission
prompts. The extension runtime does not mediate general network requests or
provide per-extension DOM, storage, or network isolation.

There is no sandbox for extension code: extension modules run same-thread, in the App's realm and origin, and no Worker or iframe isolates them. The App imports extension modules only from the Runtime's admitted asset URL, after the local integrity and Runtime-inventory checks described in this section. There is no CDN, third-party, or arbitrary remote code loading.

## Trust and admission

Treat every executable extension as trusted code. Review its source and
dependencies before enabling it in a shared project. Runtime admission,
manifest validation, and integrity checks are useful identity and loading
controls; they are not source review, code signing, a safety assessment, or a
user permission prompt. A matching digest proves that the checked local
content matches a recorded digest, not that the imported response bytes are
benign or that the code is safe.

Pre-import checks can refuse a package for invalid metadata, failed local
integrity, disabled state, mismatched Runtime inventory or entry descriptor,
or mismatched host module bindings. The post-import export and identity check
can reject activation after module evaluation. Neither stage sandboxes code
that executes. The implementation is described in
[`extensionLoader.ts`](../../src/tools/video-editor/runtime/extensionLoader.ts).

## Manifest permissions and host services

The manifest's `permissions` field is descriptive metadata for the author's
stated posture and reason. Although it is part of the SDK manifest type, the
runtime manifest validator does not validate that field, and the loader does
not enforce it as a capability grant or use it to block `fetch`, browser APIs,
storage, or other page capabilities. See
[`manifest.ts`](../../src/sdk/manifest.ts) and
[`extensionPackageManifest.ts`](../../src/tools/video-editor/runtime/extensionPackageManifest.ts).

The SDK gives extensions structured host services, and the host controls
those service interfaces. That does not remove the browser privileges of
extension JavaScript executing in the page. Cleanup of host-owned service
registrations on disposal is lifecycle management, not a security boundary.

There is no permission enforcement: manifest permissions are descriptive and the loader does not enforce them. There is no permission broker that mediates extension access to browser capabilities. There is no marketplace, and there is no update enforcement: nothing checks that installed extensions are the latest versions. The loader does enforce dependency version ranges and identity: it checks each declared dependency range against the loaded version, blocks a required dependency whose version does not match, and requires the admitted manifest version to match the pack metadata.

## Failure handling is not isolation

The loader validates manifests, checks API compatibility, resolves declared
dependencies, respects enablement, and records failures per package. The
extension lifecycle captures activation and disposal errors as diagnostics.
React error boundaries can contain some contribution-render failures. These
mechanisms help the editor report and recover from failures; they do not
confine extension code. Errors from event handlers, timers, asynchronous
callbacks, direct DOM work, or other code outside a React render boundary may
still affect the page.

The App does not provide a separate JavaScript realm, Worker isolation, an
extension-specific CSP boundary, a capability broker for general browser
APIs, or code-signing verification. Browser same-origin rules and any
application-wide policy still apply, but they are not per-extension controls.

## World preview iframe

Live world previews use a different execution path from extension modules.
`SceneSurface` sets the iframe sandbox attribute to exactly `allow-scripts`,
without `allow-same-origin`; this allows scene scripts but gives the frame an
opaque origin. The direct journey asserts that exact attribute and tests
blocked parent-document and local-storage reads. See
[`SceneSurface.tsx`](../../vendor/astrid-build-inputs/primary/astrid/packs/rendering/editor/live-scenes/SceneSurface.tsx)
and the assertion in [`direct-journey.spec.ts`](../../tests/e2e/local/direct-journey.spec.ts).

The preview runtime inserts a CSP meta element by replacing a matching
`<head...>` tag in the entry HTML. Scene validation requires nonempty HTML but
does not require a `<head>`, so this insertion is conditional; it does not
establish that every accepted preview document has this CSP. The direct
journey fixture has an explicit `<head>` and its selected Linux Chromium run
observed a fetch to that test Runtime door rejected. That result is bounded to
the explicit-head direct-journey fixture, its tested destination and tested
Runtime; it does not prove that CSP caused the rejection or that all network
requests, preview documents, browsers, or installed-pack flows are blocked.
See [`runtime.ts`](../../vendor/astrid-build-inputs/primary/astrid/packs/rendering/editor/live-scenes/runtime.ts),
[`harness.ts`](../../tests/e2e/local/support/harness.ts), and
[`direct-journey.spec.ts`](../../tests/e2e/local/direct-journey.spec.ts).
The iframe bridge and observed checks are evidence about this selected preview
path, not a universal security guarantee or a general-purpose sandbox for
arbitrary untrusted JavaScript.

This iframe restriction applies to the world preview. It does not change the
execution context or privileges of extension modules loaded by the extension
loader.

## Source references

- [`extensionLoader.ts`](../../src/tools/video-editor/runtime/extensionLoader.ts) — installed package pre-import checks, Runtime admission, import, and post-import export check.
- [`extensionPackageManifest.ts`](../../src/tools/video-editor/runtime/extensionPackageManifest.ts) — direct and installed package manifest validation.
- [`useExtensionLoaderWiring.ts`](../../src/tools/video-editor/runtime/useExtensionLoaderWiring.ts) — installed bundle-content carrier wiring.
- [`manifest.ts`](../../src/sdk/manifest.ts) — public extension and descriptive permission declarations.
- [`SceneSurface.tsx`](../../vendor/astrid-build-inputs/primary/astrid/packs/rendering/editor/live-scenes/SceneSurface.tsx) — world preview iframe sandbox.
- [`runtime.ts`](../../vendor/astrid-build-inputs/primary/astrid/packs/rendering/editor/live-scenes/runtime.ts) — conditional CSP insertion into a matching `<head>`.
- [`harness.ts`](../../tests/e2e/local/support/harness.ts) — explicit-head direct-journey scene fixture.
- [`direct-journey.spec.ts`](../../tests/e2e/local/direct-journey.spec.ts) — selected live Runtime preview regression and its bounded assertions.

## Version history

| Date | Change |
|---|---|
| 2026-11-02 | Replaced stale V1 claims with the shipped M4-09c installed-module admission and import behavior; documented that extension modules remain unsandboxed and distinguished the opaque-origin world preview iframe. |
