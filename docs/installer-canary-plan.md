# Installer canary and rollout plan

**Release owner:** Hannah (final go/no-go).

**Operational status:** planning document only. The current release is not approved for freeze, canary, publication, or deployment.

**Scope:** the single integrated release in the merge plan: Release-1 installer/update, Timeline through the accepted scope, and GPU Phase 1 plus the RunPod target, all on one qualified tuple. No line may be dropped to meet a date.

## Release and gate context

This plan follows [MERGE-PLAN.md §3.6, §4 and §6](/home/user/repo/docs/merge-plan/MERGE-PLAN.md), the [task and gate definitions](/home/user/repo/docs/merge-plan/TASKS.md), and the [newest decisions](/home/user/repo/docs/merge-plan/DECISIONS.md). Release scope and gate ownership come from those sources; named release identities and unresolved publication details are tracked in [O-02 IDENTITIES.md](../../../queue/done/O-02/IDENTITIES.md).

The [accepted O-01 rehearsal report](../../../queue/done/O-01/REPORT.md) and [installer freeze checklist](installer-freeze-checklist.md) are preparation evidence only. O-01's R2 dry-run is diagnostic and was rejected by the Agent preservation preflight because explicit VibeComfy identity is absent. It does not establish an I-08 freeze, a completed freeze, a valid installed R2, or authorization to publish. The O-01 lane commit is App `c2588c2b3a8d2911a9b8dc8b202d18939f7ff47b`; its base was round-1b App `7f6f99208100e895efebf39c70bc30af6cee0884`. These are evidence-history identifiers, not the eventual release tuple.

The latest manager status records O-01 accepted as a rehearsal deliverable, O-02 identities accepted, and O-03 review receipts accepted; it also says O-05 is waiting on M-CI's missing C-06 input. The cited [Gate Matrix](/home/user/repo/docs/merge-plan/runpod-evidence/GATE-MATRIX.md) is timestamped 2026-11-01 07:52Z and marks its rows non-green; it is an older evidence snapshot, not a live status feed. The newer O-01 acceptance does not turn release gates green. As of the current manager record, no coherent frozen RC, `int/qualified(RC)`, approved R-38 run sheet, or R-35 go/no-go receipt exists. Re-read the latest manager status, Gate Matrix and decisions before any execution; newer evidence wins.

## Hard entry gates: do not start a canary before all pass

M-QUAL records the evidence and Hannah records the release decision. A missing, stale, prepared-only, failed, wrong-tuple or wrong-artifact receipt is a **no-go**.

1. **Scope and tuple:** the approved combined-release scope is present. M-INT has published a coherent tuple through I-11 in Runtime → Agent → App order, with Pinokio, VibeComfy, composition and generated/effective artifact identities recorded. C-07 freshness and pin checks pass. The tuple, workflow revisions and artifact hashes are immutable and named in the release record.
2. **Freeze:** every F-gate in TASKS is complete; `int/regression-green(T)` is green; I-08 has actually frozen the RC and produced the single approved public manifest and matching stand-in R2. A rehearsal or diagnostic artifact does not satisfy I-08.
3. **Qualification:** all applicable RV reviews and fixes are closed on that RC; R-34 reports `int/qualified(RC)` with the trusted aggregate green and no missing evidence. That includes R-37's nine OS/channel journeys, 12 M4-5 scenarios, all nine M4-6 slots (including six authentic Pinokio slots), populated v31→v33 migration, real-R0 rollback, keep-data uninstall and unsaved-draft browser case, plus C-15 feature evidence: G-08, G-12, T-04, T-11 and I-AP-08. Preserve D9's six Pinokio slots.
4. **Release-specific scope:** verify the Release-1, Timeline and GPU Phase 1 acceptance against the final tuple in §3.6. G-05's advertised-surface audit passes; Wan2GP is gated and direct invocation refused. Do not advertise GPU capability without live evidence on the RC. Continue, masked edit and swap remain unadvertised unless proven.
5. **R-38 run sheet:** M-QUAL has an approved, current run sheet naming the actual publisher and principal, launcher branch/ref, deployment target/ref, canary cohort and size, expected served bootstrap/manifest/artifact hashes, observation windows, stop thresholds, recovery steps, monitoring owner, and evidence location. O-02 currently leaves several of these identities unresolved. No credentials or secret values go in the run sheet or receipts.
6. **R-35 go/no-go:** the required sign-offs below are recorded against the same tuple and run sheet. Hannah explicitly records GO. Until then the state is **NO-GO / HOLD**.

Any code, contract, manifest, installed artifact, workflow or harness change after freeze invokes I-12: create a replacement tuple, invalidate affected receipts and repeat the affected gates before proceeding.

## Staged execution

The numbers below are proposed operating defaults to make the canary bounded. M-QUAL must bind the actual audience, percentages, durations, thresholds and recovery procedure in R-38; Hannah approves them at R-35. They do not authorize publication by themselves. Every promotion is a separate go/no-go on the exact same release identities.

| Stage | Audience and action | Minimum observation | Promote only when |
|---|---|---|---|
| 0. Release rehearsal | On isolated qualification machines, verify the served candidate's clean install and authentic R0 upgrade paths using the approved run sheet. Include the supported launcher paths and retain the installation/update evidence. No public audience. | Complete the approved checks and allow at least 2 hours after the last run for delayed logs and reports. | All checks pass, hashes match, no stop trigger occurs, and M-QUAL confirms the evidence is complete. This stage supplements, never replaces, R-34. |
| 1. Internal canary | Release operators and named internal accounts only; cap at 5 installs. Exercise clean install and upgrade from the supported prior release. | 24 hours after the last install/update. | All installs and updates succeed, users retain data, health signals stay within the approved thresholds, and evidence is reconciled. |
| 2. Limited opt-in | Invite-only cohort, at most 5% of the intended initial audience and no more than 25 installs. Avoid broad/default discovery. | 24 hours after the last cohort member receives the update. | No unresolved stop trigger; every reported failure has an owner and disposition; Hannah approves expansion. |
| 3. Expanded rollout | Up to 25% of intended audience, with rollout rate and target recorded in R-38. | 24 hours after the last expansion step. | Same checks as stage 2, plus M-QUAL and M-VENUE confirm no platform/channel-specific gap; Hannah approves expansion. |
| 4. General rollout | Complete the remaining approved audience in controlled increments. Keep the previous known-good served artifacts and the approved recovery route available. | Continue active monitoring for at least 72 hours after the final increment. | No open release-blocking incident; final receipts and hashes are recorded. Hannah closes the rollout. |

Do not start the next stage while reports from the prior stage are untriaged. If the approved run sheet sets a longer observation window or stricter cohort limit, use it. Shortening a window, increasing a cohort or changing a threshold requires a new Hannah decision in the release record.

## Stop, hold and recovery rules

**Stop promotion immediately** and mark the stage NO-GO for any of these:

- Any confirmed data loss/corruption, failed preservation, failed rollback/recovery, or install/update/bridge failure on a protected journey.
- Served bootstrap, manifest, installed product, launcher, Pinokio, VibeComfy, composition or generated artifact identity/hash differs from the approved R-38 record or frozen tuple.
- Any required journey/evidence is missing, stale, wrong-tuple, wrong-artifact, prepared-only or rejected by the trusted verifier; aggregate qualification is no longer green.
- A security/privacy incident, credential exposure, unauthorized target/ref, or unexpected public exposure.
- Two matching install/update failures in a canary cohort, or a failure rate above the threshold explicitly recorded in R-38. No rate threshold is implied if R-38 has not set one; in that case, any confirmed product failure pauses expansion pending Hannah's decision.
- Missing monitoring, missing evidence collection, or an operator cannot execute the approved recovery route.

On stop: halt cohort expansion and new update offers using only the pre-approved control in R-38; preserve logs and affected artifact hashes; record UTC time, stage, cohort denominator, symptoms and impact; notify Hannah, M-QUAL and M-INT; assign the owning technical lead; and keep the current stage at HOLD. Do not improvise a manifest edit, repin, downgrade, data restore or deployment change. M-QUAL and the owner establish impact and an evidence-backed recovery proposal. Hannah decides whether to resume, replace the tuple, or cancel the rollout. Any changed release input invokes I-12 and requalification of affected evidence. Use only the recovery action and authority written in the approved R-38 run sheet; that run sheet must distinguish stopping new offers from recovery of already-installed clients.

## Go/no-go sign-off

M-QUAL prepares the decision packet; M-INT confirms tuple and served identities; Hannah is the release authority and records the final GO or NO-GO. Required acknowledgements before GO:

- **M-QUAL:** R-34 aggregate and every required receipt are complete, current and bound to the frozen RC; R-38 is complete; the evidence index and stop/recovery instructions are accessible.
- **M-INT:** I-11/I-08 tuple and manifest identity are coherent; no untracked or post-freeze input drift; applicable I-12 invalidation is resolved.
- **M-VENUE:** operator, venue, cohort, workflow revision, monitoring and run control are ready; each receipt identifies the runner/account/target without disclosing credentials.
- **Owning leads:** M-RT, M-AG, M-APP and M-PIN acknowledge their applicable protected paths and recovery contacts; M-GPU acknowledges the scoped live GPU evidence and advertised surface. No unresolved blocker is waived by silence.
- **Hannah:** explicitly approves GO for the named stage and its exact audience, window and release identities. A new GO is required for each cohort expansion and final general rollout.

Record the decision as `GO` or `NO-GO`, UTC time, approver, stage, tuple IDs, manifest/bootstrap hashes, evidence index, outstanding non-blocking issues and next review time. No response, partial sign-off or passed rehearsal means NO-GO.

## Evidence ownership and minimum receipt

| Evidence | Accountable owner | Record in |
|---|---|---|
| Frozen tuple, pin freshness, manifest and installed artifact hashes; invalidation links | M-INT | I-11/I-08 tuple and I-12 replacement record; link from R-38 |
| Gate inventory, trusted aggregate, journey receipts, stage decision packet and final report | M-QUAL | R-34/R-35/R-38 evidence index and Gate Matrix |
| Real-machine/hosted runner execution, dispatch identity, platform, logs and observation timeline | M-VENUE | Per-run receipt linked from the R-38 evidence index |
| Pinokio engine actions and launcher observations | M-PIN with M-VENUE | Per-slot authentic M4-5/M4-6 and canary receipt |
| Runtime migration/rollback and bridge recovery evidence | M-RT with M-QUAL | I-RT-04 and applicable journey/incident receipt |
| Agent installer, identity preservation and VibeComfy effective identity | M-AG with M-QUAL | Installer journey and tuple-bound installed-artifact receipt |
| App update guard, outbox and user-facing report | M-APP with M-QUAL | I-AP-08 and incident/cohort receipt |
| GPU live RC evidence and shipped capability claims | M-GPU with M-QUAL | G-08/G-12, G-05 audit and C-15 evidence |
| Final release risk decision and each promotion authorization | Hannah | Timestamped R-35/run-sheet decision entry |
| Publication and deployment execution | Named publisher in approved R-38; currently unresolved | M-QUAL's publication receipt with exact principal, target/ref, command/action, UTC time and served hashes |

For each stage retain: immutable tuple and workflow revisions; manifest/bootstrap and served artifact hashes before and after; cohort definition/count and timestamps; platform/channel and clean-install or upgrade path; outcome and sanitized decisive logs; health/complaint counts with denominator; failures and their disposition; stop/rollback actions or an explicit “not invoked”; approvers and decision; and links to raw evidence. Never include credentials, personal data beyond the approved minimum, or unsanitized user content.

## Current operator instruction

**HOLD.** No canary, publication, deployment, release-number change, or public exposure is authorized by this plan. O-01's diagnostic R2 remains rejected for missing explicit VibeComfy identity. Begin execution only after current gate status is refreshed, all hard entry gates pass, R-38 is approved with its unresolved identities filled, and Hannah records the applicable R-35 GO.
