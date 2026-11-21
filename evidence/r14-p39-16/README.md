# R14-P39-16 / PT2 evidence

This packet starts from App `da6e7cc8f8ed33b22e4710b161ba2d4995bd0ea1` and targets `release/14/plan-39` from `p39/pt2`. The authority is the [exact packet](https://github.com/banodoco/astrid-dev/blob/a12d9e891d54992fa480515027f464829bdb5e9f/releases/14/packets/R14-P39-16.md), [PT2 row](https://github.com/banodoco/astrid-dev/blob/a12d9e891d54992fa480515027f464829bdb5e9f/plans/39-green-mains/tasks.md#pt2), [Lead dispatch](https://github.com/banodoco/astrid-dev/issues/796#issuecomment-7028163035) and [RS1 ruling](https://github.com/banodoco/astrid-dev/issues/796#issuecomment-6995664680).

## Original native evidence

The initial commit preserves evidence only. It changes no product, test, fixture, selector, guard, browser configuration, workflow, dependency or protected gate. It is a baseline source for diagnosis, not a repaired candidate.

Original App source: `549e335dc766f373a8a40cc0690730db75295153`. [E2E run 44333940900](https://github.com/banodoco/astrid-app/actions/runs/44333940900), attempt 1, completed failure, Node 20.19.0 and Playwright 1.60.0. The authoritative G2 report is git blob `0975f72507ddd06b2bab84a765c4bc7a6a0a4c7a` at dev `7290367c170eb751ae14fd41d7f433f92b0e0e1e`; its gzip SHA256 is `50760681220707845c9bd50e6795a0914fce9f705177359f6300ebc9324be522`.

| Original job | Command | Pass / fail | Inner exit |
| --- | --- | --- | --- |
| 134905409652 timeline | `npm run test:e2e:timeline` | 3 / 36 | 1 |
| 134905409038 Chrome export | `npm run test:e2e:chrome-export` | 0 / 3 | 1 |
| 134905409743 cross-browser | `npm run test:e2e:extension-cross-browser` | 3 / 6 | 1 |
| 134905410062 accessibility | `npm run test:e2e:extension-accessibility` | 6 / 9 | 1 |

All 50 PT2 failed identities and first diagnostics are preserved in `original/pt2-native-cases.json.gz`. Seven mechanisms: inventory 404 (19), mixed inventory/history (15), history 500 (2), resource 500 (2), retired publish 410 (1), real flock marker (10), missing browser (1). The ten flock observations are five titles registered twice by separate entry specs, not retries. Four other original timeline editor-tour failures are separately preserved. Original logs do not serialize the 12 passing IDs individually; the counts do not establish an exact passing-ID census.

The two resource-500 URLs were captured from original Playwright trace network entries and console locations before any guard change:

- GET `/api/runtime/v1/projects/demo-project-id/timelines/audio-reactive-colour-offset-timeline/commits?limit=50` (Chrome export).
- GET `/api/runtime/v1/projects/demo-project-id/timelines/audio-reactive-colour-timeline/commits?limit=50` (timeline).

Both respond 500 `fake_internal`, with `unexpected GET` naming the same path. The trace extracts retain the exact URLs, request and response records. Their original archives match GitHub artifact metadata: Chrome artifact 14440912634, 27,501,955 bytes, SHA256 `429c38586c45e486f6542744aeb654857c6a36b5bc3fc6b8b78a570ebd41f566`; timeline artifact 14441651604, 90,723,182 bytes, SHA256 `19fc87194dd50a3cf02f466c206fbb747166ff368582ed50d0242c084fab5e5c`.

`original/manifest.json` binds every compressed receipt to its exact uncompressed bytes. The four original decoded job logs and all initial failures remain intact.

## Current base attempt

A focused unchanged-source attempt ran `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium PLAYWRIGHT_OUTPUT_DIR=<task-output> npm run test:e2e:timeline -- tests/e2e/timeline/desktop-interaction.spec.ts` on `da6e7cc8`, Node 24.22.3, after `npm ci --legacy-peer-deps --offline --no-audit --no-fund` installed the unchanged lock. The command exited 1 before browser execution because the sandbox denies the tsx launcher's Unix socket bind (`EPERM`, `/tmp/tsx-1000/117.pipe`). A separate task-local socket probe confirmed the same environment refusal. This is NO-RESULT, not a product or test failure and not qualification. The full native log is retained.

## Ownership and remaining proof

Session `r14-P39-16-1` is the sole writer on `p39/pt2`. App #298 is landed. #316 owns its six unit contract files; #321 owns its protected inventory and evidence. This packet does not modify them, protected paths, Plan38/55 tests, the destination branch or the board.

Current-base hosted measurement and repaired-candidate native proof are pending. The flock checks also guard an owner-frozen real-product tuple and exact Node/browser/source bytes; supplying a marker alone cannot satisfy them. These requirements and all original assertions remain in force.

Routes used: Unknown — this session does not have the release model-usage recorder configured; source research was read-only, and the packet session owns engineering and judgment.
