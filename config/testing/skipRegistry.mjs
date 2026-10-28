// The one registry of skips this repo allows ("we shouldn't have invisible skips").
//
// A skip is visible only when ALL hold:
//   1. it is declared here, with a reason and the exact condition;
//   2. the run reports it by test name (vitest: config/testing/skipGuardReporter.ts; Playwright:
//      config/testing/playwrightSkipGuard.ts; node:test: scripts/quality/node-skip-guard-reporter.mjs),
//      and fails on any skip whose reason does not carry a registered `[declared:NAME]` tag;
//   3. some CI job runs the test where the condition holds (`ci`, checked against .github/workflows by
//      scripts/quality/check-skip-registry.mjs). `ci: []` plus `manual` says, in words, that no job does.
//
// Tests never call .skip / .only / .fixme / .todo / skipIf / runIf themselves
// (scripts/quality/check-no-raw-skips.mjs). They use `skipWhen` (src/test/declaredSkip.ts, vitest),
// `skipUnlessLane` (tests/e2e/support/declaredSkip.ts, Playwright) or `declaredSkip` (scripts/quality/declared-skip.mjs, node:test).
// Each entry carries the predicate that decides its skip (`applies`, from skipConditions.mjs); callers pass only the
// name and the helper evaluates it, so no catch-all can turn an unrelated error into a declared skip.
// Share this definition with the Runtime (tests/lanes.py) and Astrid agent repos.

import { ffmpegUnavailableReason, harnessUnavailableReason, isWindows, macosLockfMissing, pwshUnavailableReason, symlinkCreationRefused } from './skipConditions.mjs';

/**
 * Skips reported at run time. `applies` = the predicate (true or a reason string when the skip applies, false when the test runs). `ci` = CI jobs (job ids in .github/workflows) where the skip condition is
 * false, so the test runs. `requireInLane`: in a job that sets ASTRID_REQUIRE_LANES to include this value,
 * the condition is a failure, never a skip (the lane's job provides the dependency).
 */
export const SKIP_REGISTRY = {
  'direct-journey-harness': {
    skipWhen: 'harnessUnavailableReason() !== null: no Runtime venv, no hosted dist/ build, or no openssl',
    reason: 'the direct journey needs a Runtime venv, a production build and openssl on the machine',
    applies: harnessUnavailableReason,
    ci: ['direct-journey'],
    requireInLane: 'direct-journey',
  },
  'direct-journey-ffmpeg': {
    skipWhen: 'ffmpegUnavailableReason() !== null: ffmpeg (with libvpx) is not installed, so stock Chromium cannot decode the fallback MP4',
    reason: 'the video-load case needs ffmpeg to make a decodable clip',
    applies: ffmpegUnavailableReason,
    ci: ['direct-journey'],
    requireInLane: 'direct-journey',
  },
  'posix-owner-only-modes': {
    skipWhen: "process.platform === 'win32'",
    reason: 'owner-only file modes (chmod 0644 refusal) are a POSIX permission model',
    applies: isWindows,
    ci: ['vitest'],
  },
  'macos-lockf-broker': {
    skipWhen: "process.platform !== 'darwin' || !existsSync('/usr/bin/lockf')",
    reason: 'the broker-election reaping case exercises macOS /usr/bin/lockf',
    applies: macosLockfMissing,
    ci: ['release-tooling-macos'],
  },
  'macos-release-process-containment': {
    skipWhen: "process.platform !== 'darwin' || !existsSync('/usr/bin/lockf')",
    reason: 'macOS-only by design: the release tooling (scripts/release bounded-command broker, and the git calls of astrid-release-provenance that go through it) is built and pinned for darwin/arm64 and needs lockf and BSD ps eww; it has no other-platform branch and refuses clearly elsewhere, and its coverage runs in the release-tooling-macos job',
    applies: macosLockfMissing,
    ci: ['release-tooling-macos'],
  },
  'symlink-creation-permitted': {
    skipWhen: 'a probe symlink in a temp dir fails with EPERM/EACCES (no symlink privilege in this environment); any other error fails the test',
    reason: 'the symlink-escape case needs permission to create symlinks',
    applies: symlinkCreationRefused,
    ci: ['vitest'],
  },
  'pwsh-unavailable': {
    skipWhen: 'no pwsh (or ASTRID_TEST_PWSH) on PATH: the PowerShell installer tests spawn it',
    reason: 'the PowerShell installer tests need a PowerShell binary on this machine; CI runs them in installer-powershell, which installs pwsh first',
    applies: pwshUnavailableReason,
    ci: ['installer-powershell'],
  },
  'windows-console-interruption-harness': {
    skipWhen: "process.platform === 'win32'",
    reason: 'the interruption test uses Python pty.fork, which has no Windows console-event support',
    applies: isWindows,
    ci: ['installer-windows'],
  },
};

/**
 * Config-level lanes: specs and tests a config leaves out of the default run (testIgnore, exclude, grep,
 * env-gated projects). They are not "skipped" in a report, so each is declared here with the command that
 * runs it and the CI job that does, or `manual` saying that none does.
 */
export const LANES = {
  'vitest-checkout': {
    what: 'src/tools/video-editor/{data/portableVisualSeamIntent,runtime/astridSceneAuthoring,dev/localExtensions.catalog}.test.ts (config/testing/lanes.ts)',
    command: 'npm run test:checkout',
    ci: ['checkout-lanes'],
  },
  'vitest-astrid-composition': {
    what: 'src/tools/video-editor/runtime/astridSceneComposition.test.tsx',
    command: 'npm run test:astrid-composition',
    ci: ['checkout-lanes'],
  },
  'vitest-sdk-boundary': {
    what: 'src/sdk/__tests__/*.test.{ts,tsx} (vitest.boundary.config.ts)',
    command: 'npm run test:sdk-boundary',
    ci: ['vitest'],
  },
  'playwright-default': {
    what: 'tests/e2e/*.spec.ts (chromium-desktop/condensed/mobile projects)',
    command: 'playwright test --config playwright.config.ts',
    ci: ['playwright-default'],
  },
  'playwright-timeline': {
    what: 'tests/e2e/timeline/*.spec.ts (timeline-devices and timeline-chrome-export projects, PLAYWRIGHT_TIMELINE_DEVICES=1)',
    command: 'npm run test:e2e:timeline',
    ci: ['playwright-timeline', 'playwright-timeline-chrome-export'],
  },
  'playwright-extension-a11y-visual-cross-browser': {
    what: 'tests/e2e/extension-{accessibility,visual-regression,cross-browser}.spec.ts',
    command: 'npm run test:e2e:extension-accessibility | extension-visual | extension-cross-browser',
    ci: ['extension-accessibility', 'extension-visual', 'extension-cross-browser'],
  },
  'playwright-quick-descriptor': {
    what: 'tests/e2e/local/three-products.spec.ts "quick: Astrid edit then App edit" (grepInvert unless ASTRID_QUICK_DESCRIPTOR)',
    command: 'python -m astrid.core.dev.journey --tier quick --reference generated --app-checkout <App>  (Astrid writes the descriptor and runs the case)',
    ci: ['quick-journey'],
  },
  'node-installer-bootstrap': {
    what: 'scripts/installer/bootstrap.test.mjs (POSIX installer; ubuntu and macOS) and bootstrap-powershell.test.mjs (PowerShell 7 on ubuntu; Windows PowerShell 5.1 and PowerShell 7 on Windows; console interruption uses the POSIX PTY harness)',
    command: 'node --test scripts/installer/bootstrap.test.mjs scripts/installer/bootstrap-powershell.test.mjs',
    ci: ['installer-posix', 'installer-powershell', 'installer-windows'],
  },
  'playwright-direct': {
    what: 'tests/e2e/local/{direct-journey,settings-persist}.spec.ts',
    command: 'npm run test:e2e:direct',
    ci: ['direct-journey'],
  },
  'playwright-three-products': {
    what: 'tests/e2e/local/three-products.spec.ts (all but the quick case)',
    command: 'npm run test:e2e:three-products',
    ci: ['three-products'],
  },
};

export const DECLARED_TAG = /\[declared:([a-z0-9-]+)\]/;

export function declaredTag(name) {
  if (!Object.hasOwn(SKIP_REGISTRY, name)) throw new Error(`skip "${name}" is not declared in config/testing/skipRegistry.mjs`);
  return `[declared:${name}] ${SKIP_REGISTRY[name].reason}`;
}

/**
 * Evaluates the declared predicate for `name`: null when the test must run, else the detail of why it skips
 * (a non-empty string). Throws on an unknown name, or when the predicate itself errors.
 */
export function skipReason(name) {
  declaredTag(name);
  const applies = SKIP_REGISTRY[name].applies();
  if (!applies) return null;
  return typeof applies === 'string' ? applies : SKIP_REGISTRY[name].skipWhen;
}

/** The registered name carried by a skip reason, or null when the skip is undeclared. */
export function declaredName(reason) {
  const match = DECLARED_TAG.exec(String(reason ?? ''));
  return match && Object.hasOwn(SKIP_REGISTRY, match[1]) ? match[1] : null;
}

/** True when the job running now provides the lane, so a missing dependency must fail, not skip. */
export function laneIsRequired(name) {
  const lane = SKIP_REGISTRY[name]?.requireInLane;
  return Boolean(lane) && (process.env.ASTRID_REQUIRE_LANES ?? '').split(',').map((part) => part.trim()).includes(lane);
}

/** Splits `{ name, reason }` skip entries into declared and undeclared, and formats the report. */
export function classifySkips(entries) {
  const declared = [];
  const undeclared = [];
  for (const entry of entries) (declaredName(entry.reason) ? declared : undeclared).push(entry);
  return { declared, undeclared };
}

export function formatSkipReport({ declared, undeclared }) {
  const lines = [];
  if (declared.length) {
    lines.push(`declared skips (${declared.length}):`);
    for (const entry of declared) lines.push(`  SKIP ${entry.name}: ${entry.reason}`);
  }
  for (const entry of undeclared) lines.push(`UNDECLARED SKIP ${entry.name}: ${entry.reason || '(no reason)'}`);
  return lines.join('\n');
}
