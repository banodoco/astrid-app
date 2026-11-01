# C-06-PUBLISH: repo-admin decision proposal

**Status:** decision proposal only; no GitHub publisher or required check is deployed by this document.
**Decision requested:** authorize (or decline) a future GitHub App publisher and staged required-check adoption for C-06.

## Recommendation

Keep the current R1 publication path as the M-INT-committed immutable verdict receipt under `docs/merge-plan/aggregate/`. The newest M-INT relay says C-06 evaluator implementation `afd2d238` is accepted and explicitly says there is no GitHub App publisher for R1. The committed receipt is R1's publication; GitHub check publication is a separate, deferred C-06-PUBLISH follow-up requiring a repository-admin decision.

If approved, introduce a narrowly scoped GitHub App publisher in stages. Preserve the committed verdict receipt as the source of truth. A GitHub check is a discoverable projection of that verdict, never a replacement evaluator, independent verdict, or authority to override the receipt. The acceptance relay is available in this workspace, but the referenced aggregate receipt itself is not. This proposal therefore does not attest to its contents or claim that a GitHub check is already present.

## Current R1 path and future publisher boundary

1. M-CI's accepted C-06 evaluator produces the bounded, explicitly invoked immutable verdict. The 12:08Z speed decision says C-06 is bounded to an explicitly invoked immutable verdict; it does not reopen the evaluator implementation.
2. M-INT commits the verdict receipt under `docs/merge-plan/aggregate/`. For R1, that committed receipt is the publication and authoritative record.
3. A future publisher, only after admin approval, may validate a committed receipt and create/update a GitHub check for the exact evaluated commit. It must not rerun or reinterpret the evaluator, synthesize a verdict from mutable job state, or turn a missing receipt into success.

The aggregate receipt was not present in this documentation checkout when this proposal was prepared. Its schema, hashes, exact target tuple, and verdict fields are not asserted here. Before implementing a publisher, M-INT/M-CI must identify the canonical receipt format and pin its validation rules to the accepted evaluator output.

## Proposed check identity and binding

- **Check name:** `int/regression-green` (the aggregate name already used by the C-06 task and integration plan). The repo admin must confirm this exact context is available and does not collide with another publisher before requiring it.
- **Invocation:** explicit publisher dispatch after the immutable receipt has been committed and accepted. An implementation may use `workflow_dispatch` or an equivalent admin-approved host trigger. It must not publish merely because a mutable branch tip changed or a workflow was scheduled.
- **Target:** exact evaluated commit SHA(s), never a branch name or a moving ref. For the four-repository aggregate (`banodoco/astrid-runtime`, `banodoco/astrid-agent`, `banodoco/astrid-app`, `banodoco/astrid-pinokio`), publish one check run in each repository against that repository's exact SHA in the receipt's evaluated tuple. Do not attach the aggregate result to the receipt-commit SHA unless that is itself the evaluated product commit.
- **Receipt linkage:** check details should link to the immutable receipt commit/path and expose a stable receipt identifier or digest only after its actual format is confirmed. The check summary should identify the evaluated SHA and verdict provenance; include no secrets or RunPod credentials.
- **Check outcome:** `success` only when the accepted immutable receipt validates for the exact target tuple and says the aggregate passed. A valid negative verdict may be reported as failure. Do not create a passing check for partial, prepared, stale, or unbound evidence.

This binding makes the check auditable: a check on a different commit cannot satisfy the evaluated commit's gate, and a later branch movement cannot silently retarget a prior verdict.

## GitHub App and repository permissions

Recommend a dedicated publisher App with no human-user token. Proposed minimum installation permissions:

- **Checks: write** to create/update the named check run.
- **Contents: read** only if the publisher must retrieve the committed receipt from the repository API. If the host supplies a verified receipt and the publisher does not read repository content, omit this permission.
- **Metadata: read** as GitHub's installation baseline.

Install only on the repositories whose exact commits receive this aggregate check, initially the four `banodoco/astrid-{runtime,agent,app,pinokio}` repositories. Use selected-repository installation; do not install organization-wide by default. Grant no Contents write, Actions write, Administration, Pull requests write, or workflow modification permission. Protect the App private key in an approved secret store available only to the deployment principal; do not put it in a repository, workflow log, receipt, or RunPod credential store.

The App name, owning team/account, installation owner, installation ID, and deployment principal are unresolved and must be supplied by the administrators before implementation. Placeholders: **App owner:** `[repo-admin to name]`; **installation account:** `[repo-admin to name]`; **deployment principal:** `[repo-admin to name]`.

## Required-check and branch-protection behavior

Do not make the check required during initial rollout. First verify it on a non-protected test branch and confirm it is emitted by the approved App, has the exact expected name, is bound to each correct SHA, links to the committed receipt, and cannot be satisfied by stale or unrelated check runs.

After that verification and separate repo-admin approval, stage the required check on `int/r1` in the repositories participating in the aggregate. Configure the rule to require the exact `int/regression-green` check from the approved App/source where GitHub supports that binding. Keep existing branch protections (PR required, no force-push, no deletion, enforced for admins) intact. The decision to add this gate to `main` or `release-1` is separate: recommend leaving those branches unchanged until the admin confirms the publisher can reliably provide a fresh, correctly bound verdict for their merge events and explicitly approves the scope. No branch-protection setting is changed by this proposal.

A required check must apply to the commit being merged. If the target SHA changes, the old check is not sufficient; the new SHA needs its own validated receipt and check. Required-check configuration should fail closed when the check is absent or pending, and should not accept a similarly named check from another App or actor.

## Failure, missing, and stale verdict handling

- **Missing receipt, unreadable receipt, invalid digest/schema, or evaluator identity/version not accepted:** do not publish success; report failure or leave the check pending/failing per the approved operational contract, and alert the owner.
- **Receipt targets a different tuple or commit:** fail closed. Never retarget a verdict to a new SHA, infer equivalence from a branch name, or reuse it after the evaluated commit changes.
- **Receipt is stale, superseded, or revoked:** it cannot satisfy the current SHA. Publish a new check only from a newly accepted receipt; retain the prior check and receipt for audit rather than rewriting historical evidence.
- **Publisher outage or API error:** no success is synthesized. The required check remains unsatisfied until retry succeeds for the same verified receipt and SHA, or the repo admin follows an explicitly approved emergency procedure.
- **Negative verdict:** preserve the failure and receipt link. A rerun requires a new explicit evaluator invocation and a new immutable receipt; do not overwrite the old verdict as if it had passed.

Define retry limits, alert route, and any emergency bypass owner before enabling a required rule. Any bypass must be a documented repository-admin action and must not alter the receipt.

## Trust, audit, and rotation ownership

M-INT remains the coordinator and owner of the authoritative committed verdict receipt. M-CI owns the accepted evaluator contract and, if later assigned, publisher implementation. Repository administrators own App approval, installation scope, required-check configuration, and emergency branch-rule changes. A named deployment owner operates the publisher and maintains the credential; these human identities remain unresolved.

Audit records should allow an administrator to connect the check run to the App identity, installation, deployment principal, invocation, exact target SHA(s), receipt commit/path/digest, and publisher version. Log only non-secret identifiers and sanitized verdict metadata. Define private-key rotation and revocation ownership, tested replacement procedure, and recovery contact before enabling protection. Rotation must not change the historical receipt or permit another principal to publish the check.

## Staged rollout and rollback

1. **Admin decision:** resolve the open choices below; approve App owner, installation scope, check name, target branches, and deployment principal in writing.
2. **Design/implementation:** M-CI specifies receipt validation and publisher behavior against the accepted C-06 receipt format. M-INT confirms the receipt is committed and accepted. Do not change the evaluator or frozen contract as part of this proposal.
3. **Non-protected verification:** install only on the approved repositories and test branch. Exercise pass, negative, missing, stale, wrong-SHA, API-error, and retry cases. Verify the check source, exact SHA binding, receipt link, sanitized output, and audit trail.
4. **Observe without gating:** publish checks on intended commits while branch protection remains unchanged. Compare each check to the M-INT receipt; any mismatch stops rollout.
5. **Protected adoption:** after repo-admin review of the verification evidence, require `int/regression-green` on `int/r1` in staged repositories, then expand only by explicit approval. Do not apply to `main`/`release-1` absent separate approval.
6. **Rollback:** repo admin removes the required-check rule or reverts its scope; the publisher owner disables/revokes the App installation or credential. Preserve check runs and committed receipts for audit. R1 publication continues through the M-INT committed receipt throughout any publisher outage or rollback.

## Decisions required from repository administration

1. **App identity and owner:** approve a dedicated App name and owning team/account; name the accountable administrator.
2. **Installation account and scope:** specify the installation account and confirm selected installation on exactly which of the four repositories.
3. **Check name/source:** confirm `int/regression-green` and bind required-check matching to the approved App identity.
4. **Branch rules:** confirm non-protected test branch, whether `int/r1` will require the check, and whether `main` or `release-1` are explicitly out of scope or later candidates. Preserve current PR/no-force-push/no-deletion/admin-enforcement rules.
5. **Deployment principal:** name the non-human publisher runtime identity and its operator/rotation owner; identify the approved secret store and alert route.
6. **Operational policy:** approve failure/pending semantics, retries, outage handling, and the named emergency bypass authority.
7. **Evidence acceptance:** confirm who verifies the first non-protected run and who authorizes the protected-rule change after the receipt-to-check comparison.

Until these decisions and the staged verification are complete, the current R1 publication remains the committed M-INT verdict receipt; no GitHub check is a release gate.

## Source references

These references describe the current authority and boundaries used for this recommendation:

- `/home/user/merge/ws/M-OPS/ORCHESTRATOR.md`, newest 13:15Z relay: C-06-IMPL `afd2d238` accepted; no GitHub App publisher for R1; committed immutable M-INT aggregate receipt is publication. The receipt file itself is not present in the O-05 workspace checkout.
- `/home/user/repo/docs/merge-plan/DECISIONS.md`, 10:13Z: host verdict authoritative; GitHub App/required-check publisher is C-06-PUBLISH requiring repo-admin decision.
- `/home/user/repo/docs/merge-plan/DECISIONS.md`, 12:08Z: C-06 bounded to an explicitly invoked immutable verdict; evaluator work is not reopened.
- `/home/user/repo/docs/merge-plan/TASKS.md`, C-06: always-running aggregate name `int/regression-green`, fail on missing evidence, with synthetic missing/new/renamed/skipped acceptance cases.
- `/home/user/repo/docs/merge-plan/managers/M-CI.md`, C-06 and manager rules: evaluator acceptance and M-INT landing/receipt boundary.
- `/home/user/repo/docs/merge-plan/MERGE-PLAN.md`, §§3.5, 5.2: tuple-scoped verdict semantics and narrow GitHub App check-run concept for the future publisher; RunPod key stays outside GitHub.
- `/home/user/merge/ws/M-OPS/queue/done/O-02/IDENTITIES.md`, CI/required-check publisher row: App identity/installation and publisher principal unresolved; repo admin must identify/approve the App and scope.
- `/home/user/merge/ws/M-OPS/STATUS.md` and `/home/user/repo/docs/merge-plan/managers/M-OPS.md`: O-05 scope and base handoff.
