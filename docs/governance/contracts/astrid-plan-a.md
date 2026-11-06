# Astrid public boundary

The App selects Astrid's public CLI/diagnostic bundle through the single
`source_commit` in `config/astrid-cli-surface/vendor.lock.json`. The same lock
covers the CLI export and every member of `config/astrid-public-boundary/bundle.json`.
The existing vendor checker verifies the selected bytes; no source-file hash,
C1/C2 digest, or bundle version decides diagnostic compatibility.

Run `npm run check:astrid-conformance` (also included in `check:contracts`).
The dependency-free Node conformance suite runs in the boundary CI job after
the producer checkout and vendored bytes have been verified. To select a new
release, change the lock's commit, check out that immutable commit, then run
`node scripts/vendor-lock.mjs update config/astrid-cli-surface/vendor.lock.json --producer <checkout>`.

`scripts/quality/astrid-public-boundary.test.mjs` replaces the diagnostic freeze
assertions using the pinned producer's fixtures:

| Rule | Conformance test |
|---|---|
| Valid/invalid producer cases | every pinned producer diagnostic fixture conforms, and every invalid case is rejected |
| Closed object shapes, required fields, finite primitive values and field types | projection objects require their declared keys and primitive types |
| Exact ordered command effects; scoped authorization for every effectful suggestion | every public command keeps its exact effect sequence and authorization rule |
| Unknown commands, malformed arguments, duplicate effects, inert redacted placeholders | actions reject unknown commands, malformed arguments, duplicate effects, and redacted executable values |
| Independent observations; unknown value/time stay null with an unavailable reason; observed values need timestamps | all independent facts preserve observed and unavailable semantics |
| Healthy null/null pair, failed non-null pair, closed codes and boundaries | healthy and failure codes are paired and restricted to known values |
| Five-second total helper deadline; event/log/bundle caps; capture within declared limits | deadlines, declared limits, and captured counts or bytes enforce inclusive bounds |
| No collection actions; shared content redaction; inert shared suggestions | diagnostic collection executes no actions and shared output is redacted and inert |
| Digest format remains metadata, without equality admission | digest syntax is checked without admitting a particular contract identity |

The C2 fact projection supersedes C1's nullable references, structured progress,
freshness, and terminal-result fields. Their old shape is historical; the C2
projection validates each observation independently and never infers provider
execution, billing, authorization, or settlement from another healthy fact.

## Historical C1/C2 design record

The manifests `config/contracts/astrid-plan-a-c1.json` and
`config/contracts/astrid-plan-a-c2.json`, their diagnostic schema, and
`tests/fixtures/astrid-plan-a/c2/` remain unchanged as historical evidence.
They are removed from the active contract registry. Their source/client hashes,
pending decisions, acceptance gates, and digest references describe the original
snapshot. The freeze checkers, source-hash tests, and digest refresher have been
removed; the commands in the original record below are historical and unavailable.

### Original contract record

Purpose: give Setup/Lifecycle (SL) and Execution/Worker (EW) one reviewable CF
input, without implementing either lane. The source of truth is
[`C1`](../../../config/contracts/astrid-plan-a-c1.json), a versioned JSON
composition governed by `scripts/quality/check-astrid-contract-freeze.mjs`.
This is a semantic contract awaiting consumer acknowledgement, not an installed
release, an auth service, a Runtime schema replacement, or a passed CF-M1 gate.

## Consume and verify

Run `npm run check:astrid-contract-freeze` or append `-- --json` for the report.
Run `npm run test:astrid-contract-freeze` for the validator's negative cases.
The normal `npm run check:contracts` gate includes this check.

C2 is the immutable-successor diagnostic projection at
`config/contracts/astrid-plan-a-c2.json`. It repairs the C1 diagnostic shape so
a healthy checked scope has paired `problemCode: null` and
`failureBoundary: null`, while an observed failure has both values and an
unobserved independent fact remains explicitly unknown. Run
`npm run check:astrid-contract-c2` and `npm run test:astrid-contract-c2` for its
deterministic source, schema, fixture, bound, redaction and action-effect gates.
C2 rejects undeclared projection fields and malformed primitive fact/action
values, and resolves every suggested action ID against the exact ordered effect
list in C1's `commands` table; unknown commands and effect mismatches fail closed.
C2 does not replace `workspace.v1`, bless installed behavior, or rewrite C1;
Runtime remains the sole request/binding/attempt/settlement authority.

For an optional read-only comparison with the inspected external declarations:

```sh
npm run check:astrid-contract-freeze -- \
  --astrid-root /path/to/Astrid \
  --runtime-root /path/to/astrid-runtime --json
```

The checker reads declaration files only. It does not inspect credential files,
contact services, run parsers, install dependencies, start processes, or mutate
workspace data. Without explicit external roots it reports those sources as
unverified. Passing checks validates the contract and available source bytes;
it does not qualify installed behavior or prove source publication.

`digest` is `sha256:` plus the SHA-256 of UTF-8 JSON with recursively sorted
object keys, array order preserved, no whitespace or trailing newline, and only
the top-level `digest` omitted. No other field is excluded. Source evidence
hashes instead cover each source file's exact bytes. Observed Git HEADs describe
where inspection occurred; dirty working-tree file hashes take precedence and
neither establishes release custody. The immutable C1 digest is the consumer
acknowledgement key. It is not a signature or independent approval.

SL and EW should validate C1, record its revision/digest in their own receipts,
and implement only their owned seams. Do not import this JSON into app boot or
use it to dispatch commands. Proposed command names and safety requirements
describe future adapters over existing authorities. Use the existing
`workspace.v1` OpenAPI/schema/generated clients for Runtime payloads; C1's
normalized facts and diagnostic vocabulary do not replace those wire types.
`validateDiagnostic` checks projection shape, contract binding, collection bounds
and declared action effects. It does not sanitize content, authorize actions or
execute argument strings. SL/EW must prove redaction and validate exact command
arguments at their existing execution boundary before offering an action.

## Frozen decisions

| Boundary | C1 decision |
|---|---|
| Workspace | One Create/Attach workspace becomes selected/default; retain UUID and registered absolute root on repeat/resume. Fresh packaged Create uses Astrid's existing `~/.astrid-data` support-root default. Attach does not copy. Resolve and pass the same root explicitly to the neutral launcher; never silently adopt its different default or cwd. |
| Local auth | Local app + local workspace uses the existing bridge session without Discord or contributor login. Missing Runtime yields degraded local state, not a hosted login gate. |
| Hosted auth | Hosted contexts require verified Discord sessions plus independent workspace/pairing/action grants. Contributor identity and explicit knowledge-write consent remain Hivemind-owned. Mode changes isolate grants/caches and preserve the sole local default. |
| Setup | Preview/check are nonstarting; offline forbids acquisition, not authorized local writes. Successful apply visibly starts Runtime. Failure preserves configured workspace and offers proposed `astrid-runtime up`, never a task retry or another Create. |
| Naming | `astrid auth status` keeps contributor meaning. The transition release atomically assigns top-level `astrid status` to workspace/readiness. Other auth aliases survive the transition and next minor release, subject to documented removal conditions. |
| Execution | Runtime owns admission, idempotency, attempts, fencing, events and settlement. New attempts, Worker relaunch and GPU replacement remain distinct actions. Local stop/lost contact cannot prove remote stop or billing settlement. |
| Observation | Installed/enabled/connected/ready/authorized, task state, progress, freshness and remote uncertainty remain independent. Bounded redacted diagnosis preserves unavailable facts and declares exact next-action effects. |

Source inspection found real migration gaps: `setup` is not reserved before
prompt/dynamic-pack fallback; wrapper and gateway help differ; top-level status
still means contributor auth. `AstridClient.open_from_launcher` can start Runtime
even with `start_pack_host=False`, so current Astrid doctor/task inspection is
not evidence of nonstarting observation. Neutral `astrid-runtime connect` may
provision connection state. These are downstream implementation obligations.

## Composition and unresolved inputs

C1 selects existing `vibecomfy.run`, VibeComfy/ComfyUI `pip_embedded`, the existing
RunPod target kind, local macOS and Linux/CUDA worker platform direction, and the
existing `astrid-beta-current-mac` capability profile. Exact account/pod, worker
architecture/image, workflow/model assets and compatible dependency closure
remain unresolved. No personal RunPod example becomes a default. EW must prove
the selected engine profile is enforced; availability alone does not prove it.

The machine/source Hivemind declaration supersedes the stale older planning pin.
The nineteen moving packs are maintained externally. The bundled `local` and
`comfy_wrap` packs and the managed Linux ComfyUI recipe are retired; user-owned
personal content and attached ComfyUI remain supported. C1 and C2 preserve their
published historical records, including references to the former `comfy_wrap` pack.
C1 explicitly selects
the existing core, Hivemind, VibeComfy and stable timeline skill views for initial
setup. This reconciles a gap between discovery and legacy skill-default logic;
it does not claim today's setup already makes that selection. Compatibility and
prerequisites remain separate, and repeat setup preserves explicit disables.

Every missing input has an ID, kind, owner, deadline and reason in `unresolved`.
Those references cannot be replaced by fabricated hashes or empty “resolved”
records. They cover SL/EW delivery and acknowledgement, worker controls, source
publication/custody and dependency closure, actual workspace inventory and
physical preservation, the hosted-only secure exchange, and the future Rn.
Hosted wire/storage/consent/expiry/deployment decisions must be frozen before
affected Plan B integration; they do not block ordinary local use.

No actual workspace inventory, backup, restore, worker setup, generation or
hosted exchange was performed for C1. Its scenario mapping records future proof
obligations, all unexecuted. Runtime contract/client reconciliation in the
separate imported-media-catalog lane requires a fresh ownership/merge review.

## Revision and acceptance rules

After review/issuance, never rewrite C1 to make changed sources pass. Add a
successor Cn and matching versioned validator contract, obtain both consumers'
acknowledgements and let the parent invalidate affected evidence. Keep C1 as an
audit input. Validate only relevant source snapshots, not unrelated dirty files.

Rn must reference the exact Cn digest and real immutable source, artifact,
environment/dependency/model/profile and acquisition identities. Unresolved
inputs needed by that tuple prohibit installed acceptance. CF-M1 requires the
pending inventories and both consumer acknowledgements; CF-CLOSE additionally
requires final physical disposition and Rn. Parent alone accepts A-10/A-M1.
This foundation neither seals Rn nor claims any of those gates.
