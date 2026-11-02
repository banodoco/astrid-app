# Extension Trust and Security

**Status:** Describes the shipped App extension loader at M4-09c
**Last updated:** 2026-11-02

This page describes the security properties of extension code and live world
previews in the shipped App. It distinguishes package validation and Runtime
admission from isolation: the former check what may load, while the latter is
not provided for extension modules.

## Extension code runs with the App's browser privileges

The App has two extension inputs:

- **Direct extensions** are supplied by the host as already-imported extension
  objects.
- **Installed packages** are read from the App's package repository. The loader
  validates their package metadata and integrity, then requires a matching,
  enabled entry in the live Runtime pack inventory before importing the
  package's JavaScript entry from the Runtime asset URL.

For an installed package, the browser-side package record is only a carrier;
it does not grant permission to execute code. The loader checks the artifact
manifest and extension identity, verifies the installed content against its
integrity metadata, and matches the live Runtime inventory's pack ID, enabled
state, artifact and source digests, asset URL, and artifact-manifest digest.
It also requires the entry file and the host build's pinned React, React DOM,
Remotion, and SDK import-map bindings to match. Missing or mismatched checks
fail closed. These checks establish which artifact Runtime has admitted and
which bytes the App expects. They do not establish that the code is safe or
that its author is trustworthy.

After admission, the installed entry is loaded with JavaScript `import()` in
the App's browser context. Direct and installed extensions therefore execute
as code in the editor page: they share its JavaScript realm, origin, and main
thread. Extension modules do not run in a Worker or sandboxed iframe. They can
use the DOM and browser APIs available to page scripts, subject to the
browser's normal rules, including same-origin policy and browser permission
prompts. The extension runtime does not mediate general network requests or
provide per-extension DOM, storage, or network isolation.

## Trust and admission

Treat every executable extension as trusted code. Review its source and
dependencies before enabling it in a shared project. Runtime admission,
manifest validation, and integrity checks are useful identity and loading
controls; they are not source review, code signing, a safety assessment, or a
user permission prompt. A matching digest proves that bytes match a recorded
digest, not that those bytes are benign.

The installed loader refuses to execute a package when its metadata is
invalid, its integrity check fails, it is disabled, its artifact does not
match the live Runtime inventory, the required host module bindings do not
match, or the entry does not export the expected activatable extension. These
refusals control activation eligibility. They do not sandbox code that passes
the checks.

## Manifest permissions and host services

The manifest's `permissions` field records the author's stated posture and
reason. The loader validates the declaration, but it does not use it to block
`fetch`, browser APIs, storage, or other page capabilities. It is descriptive
metadata, not an enforced permission grant.

The SDK gives extensions structured host services, and the host controls
those service interfaces. That does not remove the browser privileges of
extension JavaScript executing in the page. Cleanup of host-owned service
registrations on disposal is lifecycle management, not a security boundary.

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
`SceneSurface` renders the preview in an iframe whose sandbox attribute is
exactly `allow-scripts`. The iframe may run the scene's scripts, but it does
not receive `allow-same-origin`; its document therefore has an opaque origin
and cannot use the hosting page's origin privileges. The preview document's
CSP also disallows connections. The direct journey regression verifies the
exact sandbox attribute, successful scene rendering, blocked access to the
parent document and local storage, and blocked network access to the test
Runtime door. The frame includes a narrow `postMessage` rendering bridge and
is designed for this preview path; it is not a general-purpose sandbox for
arbitrary untrusted JavaScript.

This iframe restriction applies to the world preview. It does not change the
execution context or privileges of extension modules loaded by the extension
loader.

## Source references

- [`extensionLoader.ts`](../../src/tools/video-editor/runtime/extensionLoader.ts) — installed package validation, integrity checks, Runtime admission, and module import.
- [`extensionPackageManifest.ts`](../../src/tools/video-editor/runtime/extensionPackageManifest.ts) — direct and installed package manifest validation.
- [`manifest.ts`](../../src/sdk/manifest.ts) — public extension and descriptive permission declarations.
- [`SceneSurface.tsx`](../../vendor/astrid-build-inputs/primary/astrid/packs/rendering/editor/live-scenes/SceneSurface.tsx) — world preview iframe sandbox.
- [`direct-journey.spec.ts`](../../tests/e2e/local/direct-journey.spec.ts) — live Runtime object preview regression.

## Version history

| Date | Change |
|---|---|
| 2026-11-02 | Replaced stale V1 claims with the shipped M4-09c installed-module admission and import behavior; documented that extension modules remain unsandboxed and distinguished the opaque-origin world preview iframe. |
