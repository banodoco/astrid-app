# R14-P39-28 — App native inventory evidence

Plan 39 K2/K3, [activation issue #984](https://github.com/banodoco/astrid-dev/issues/984).
The packet starts from App `da6e7cc8f8ed33b22e4710b161ba2d4995bd0ea1`.
The [packet](https://github.com/banodoco/astrid-dev/blob/30ebfc6c92fcab822deb5fbb077ee929c1f7663b/releases/14/packets/R14-P39-28.md)
limits changes to supported PASS additions and their proof.

This proposal appends **824 rows** to `ci/test-inventory.json.gz`, taking 21,250
rows to **22,074**. Every existing row and every non-row field is unchanged.
No evaluator, collector, adapter, failure ledger, required check, test, source
binding or omission allowance is changed. Full trusted qualification remains
FAIL.

## Preserved inputs

`inputs.json` records the downloaded archive hashes and the exact decoded bytes
preserved in `original-observed.json.gz`, `original-verdict.json.gz`,
`sync-observed.json.gz`, and `sync-verdict.json.gz`.

- [Original official verdict, run 44611474919 / artifact 14575905046](https://github.com/banodoco/astrid-app/actions/runs/44611474919/artifacts/14575905046): FAIL, 855 error entries.
- [Original native run 44611475170](https://github.com/banodoco/astrid-app/actions/runs/44611475170): six complete suites; App 21,143 PASS / 10 FAIL, raw exit 1; SDK 335 PASS; Linux Node 465 PASS / 26 SKIP; installer 21 PASS; boundary 9 PASS; Darwin 66 PASS. All five non-App commands exit 0.
- [Updated sync verdict, run 44616853958 / artifact 14579968624](https://github.com/banodoco/astrid-app/actions/runs/44616853958/artifacts/14579968624): FAIL, the same 855 error entries. Its native run 44616853834 reports App 21,153 PASS, raw exit 0; the other five suites retain their outcomes.

Both verdicts preserve four missing seeded IDs, 850 unseeded observations, and
the first source-binding refusal at `Tests/vitest/app / 2003482884_0_73`.
The original ten App failures and the Linux skip diagnostics remain in these
unaltered input records. A source-binding refusal prevents the evaluator from
certifying the remaining source and outcome checks.

The sealed inventory at `0700e981be5dfbfc229784b8ade69869f62716dd` contains
21,250 rows and has SHA-256
`5d7e92666e59879c65760718e6204515a1e71217eeae7a4d638870c18aadccd0`.
It is byte-identical at this packet's starting head. The comparator, collector,
adapters, failure ledger, and required checks are also unchanged between those
two commits.

## Native receipt verification

The unchanged collector reproduced all three required jobs and all six suites
from archived streams and command receipts, exactly matching both official
observations. Actual checkout/head tree equivalence was independently checked
from Git objects:

| Observation | Requested head | Actual checkout | Equal Git tree |
| --- | --- | --- | --- |
| Original | `1f589e85269fb1aae205399bb9f1b0da4fe2446e` | `6ab05e41d5201ee1c7c722731001b68378a9fc26` | `1c6a9981e64b88f15d268d0f5745abb4205c3ddd` |
| Sync | `75daac1cc8e174258b71b35766712fe5a8204727` | `b94a0a15f2b101fef7a3b5c62ba2f572dc1ec59b` | `1fb3d4df931443f569b999dc2cd80a9a871b1e99` |

| Native lane | Original outcome / raw exit | Sync outcome / raw exit | PASS additions |
| --- | --- | --- | ---: |
| `Tests/vitest/app` | 21,143 PASS, 10 FAIL / **1** | 21,153 PASS / **0** | 263 |
| `Tests/vitest/sdk-boundary` | 335 PASS / 0 | 335 PASS / 0 | 0 |
| `Tests/vitest/release-node` | 21 PASS / 0 | 21 PASS / 0 | 21 |
| `Tests/vitest/node` | 465 PASS, 26 SKIP / 0 | 465 PASS, 26 SKIP / 0 | 465 |
| `Tests/release-tooling-macos` | 66 PASS / 0 | 66 PASS / 0 | 66 |
| `Tests/boundary` | 9 PASS / 0 | 9 PASS / 0 | 9 |

The 824 full added result rows are identical across both observations. Every
projected row in `passing-additions.json.gz` links to both native result line
numbers and its actual source blob. Its lane receipts include command, stream
and artifact hashes, checkout SHA, dependency tuple, run/job/attempt IDs and raw
exit. All 22,075 observed lane identities match across the two runs.
`observed-differences.json.gz` retains the ten original FAIL-to-PASS transitions
with their original diagnostics, plus the timestamp-title change. No original
failure is erased or added to the ceiling. `job-metadata.json.gz` retains the
jobs API responses.

## Measured unchanged-evaluator results

`reconcile.py` exports the trusted policy and evaluator/collector/adapters from
the exact base using `git show`, verifies their bytes against the seal, and
invokes the unchanged evaluator CLI. These are offline policy replays retaining
the original observation heads/tuples, **not native executions at the packet
head**.

| Observation | Sealed policy | Proposed PASS additions |
| --- | --- | --- |
| Original | **FAIL / process exit 1**, 855 findings | **FAIL / process exit 1**, 31 findings |
| Sync | **FAIL / process exit 1**, 855 findings | **FAIL / process exit 1**, 31 findings |

The before findings equal each official verdict as a multiset; unordered set
traversal can change error ordering. Candidate findings preserve **four lost
IDs, 26 unseeded skip observations and the same first aborting refusal**:

```text
native ID source binding changed:
('Tests/vitest/app', '2003482884_0_73', 'null', 'null')
```

A lost-ID finding is accumulated first. The source-binding exception aborts
the per-ID outcome loop after 1,307 PASS rows on the original and 1,299 on the
sync. All other fourteen differing bindings, all 26 skip-allowance checks and
all ten original failing outcomes lie after this boundary. Their presence is
independently accounted for; this stopped verdict does not certify their
acceptance. Final retirement and historical-reconciliation checks are also
unreached, including `complete-native-inventory=unknown`. An empty `unknown`
array does not resolve that entry. Exact commands, exits and unreached checks
are in `reconciliation.json`; verdict files are `*-before.json.gz` and
`*-candidate.json.gz`.

## Four missing identities and fifteen changed bindings

`identity-analysis.json.gz` contains every exact sealed row, original G2 native
record/line, both current observations, source blobs and full relevant diffs.
The historical source is `549e335dc766f373a8a40cc0690730db75295153`,
[run 44295083237 / artifact 14425679839](https://github.com/banodoco/astrid-app/actions/runs/44295083237/artifacts/14425679839),
job `134769934054`. Archive SHA-256:
`19229322f3e70f6ed7276992c44ebaa1147079fa8303fb359b4b1d53359171a9`.
Its stream has 20,894 result records, pending 0 and successful result guard.
All nineteen historical discrepancy rows were native PASS. The App step
succeeded; the job failed at quarantine policy, so its conclusion is not used
to infer an App raw exit.

Every identity below has lane `Tests/vitest/app`, parameter `null`, subtest
`null`. The candidate column is source-correspondence evidence only. **No old
identity is retired, aliased, renamed or rebound.**

| Finding | Protected native ID | Current same-source candidate | Cause |
| --- | --- | --- | --- |
| Missing | `200591529_0_2` | `200591529_1_2` | Earlier asset-plan suite inserted |
| Missing | `200591529_1_3` | `200591529_2_3` | Earlier asset-plan suite inserted |
| Missing | `200591529_1_4` | `200591529_2_4` | Earlier asset-plan suite inserted |
| Missing | `200591529_1_5` | `200591529_2_5` | Earlier asset-plan suite inserted |
| Binding | `200591529_0_0` | `200591529_1_0` | Asset-plan collision |
| Binding | `200591529_0_1` | `200591529_1_1` | Asset-plan collision |
| Binding | `200591529_1_0` | `200591529_2_0` | Asset-plan collision |
| Binding | `200591529_1_1` | `200591529_2_1` | Asset-plan collision |
| Binding | `200591529_1_2` | `200591529_2_2` | Asset-plan collision |
| Binding | `2003482884_0_73` | `2003482884_0_76` | Persistence cases inserted |
| Binding | `2003482884_0_74` | `2003482884_0_77` | Persistence cases inserted |
| Binding | `2003482884_0_75` | `2003482884_0_78` | Persistence cases inserted |
| Binding | `2003482884_0_76` | `2003482884_0_79` | Persistence cases inserted |
| Binding | `2003482884_0_77` | `2003482884_0_80` | Persistence cases inserted |
| Binding | `2003482884_0_78` | `2003482884_0_81` | Persistence cases inserted |
| Binding | `2003482884_0_79` | `2003482884_0_82` | Persistence cases inserted |
| Binding | `2003482884_0_80` | `2003482884_0_83` | Persistence cases inserted |
| Binding | `1999584564_0_70` | No exact old-source match | Timestamp in expanded title |
| Binding | `665265590_0_65` | No exact old-source match | Changed track-label contract |

The historical causes require separate dispositions:

- `timeline-asset-plans.test.ts`: `3d8f45a7` inserted a two-case `describe`
  before the old suites; `8d08b5a0` later added imports and an ending suite
  ([App #294](https://github.com/banodoco/astrid-app/pull/294)). The nine old
  declarations remain a verbatim 3,778-byte substring, but their native IDs
  moved and five collide. Shared titles do not authorize migration.
- `useTimelinePersistence.test.tsx`: `88045a78` added expanded `keep/latest`
  cases; `2c4d14f6` added a reload case
  ([App #295](https://github.com/banodoco/astrid-app/pull/295)). The old suffix
  is 42,054 identical bytes; shared setup and an earlier refusal expectation
  also changed. This is not an unchanged whole-file claim.
- `trackLabelCapture.test.ts`: the complete source blob is unchanged at
  `75dfeb4c388c766614994236e192ba196819cf91`. Line 222 includes `new Date()`
  in an `it.each` `%s` title. G2/original/sync titles contain three timestamps
  while the recorded parameter is null. No timestamp normalization is applied.
- `timelineLocalSaveHandoff.test.ts`: `c66c61ac` in
  [App #292](https://github.com/banodoco/astrid-app/pull/292) changed a rejected
  track-label save with unchanged canonical state into a successful save with
  preserved shot/internal-timeline closures. This is a substantive contract and
  assertion change, separate from positional migration.

All four source files are byte-identical between seal, packet base, original
recorder and updated sync. The drift predates this packet and lies between G2
native source and these later sources. Changed refusal messages and harness
setup are preserved in the full diffs.

## Twenty-six Linux skips

`skip-analysis.json.gz` has every exact Linux identity and Darwin counterpart,
declaration text, registry entry, predicate, source blob, original/sync result
and provenance. Twenty-five cases are in `bounded-command.test.mjs`; one is in
`verify-extension-ship.test.mjs`. Twenty-five use registry ID
`macos-release-process-containment`; one uses `macos-lockf-broker`.

The registered condition is
`process.platform !== 'darwin' || !existsSync('/usr/bin/lockf')`, with coverage
in `release-tooling-macos`. Declarations, registry, predicate and helper are
unchanged at all four later refs. Declaration history `17e1819f`, `42c5361d`
and `1f87f118` is retained as exact patches. Each original/sync Linux command
retains 26 SKIPs/raw0; each Darwin command contains the exact 26 native
counterparts among 66 PASS/raw0. Node IDs embed
`[file,line,column,nesting,title]`; there is no separate source field.

**Lane remains part of identity.** Darwin PASS cannot admit Linux SKIP. New
candidate rows require PASS for that same identity. Skipped outcomes need an
exact `allowed_omission` in the trusted inventory; the seal has zero such rows.
Measured CLI controls trying to append one actual Linux skip are rejected on
both observations with exit 1, `new inventory ID lacks a passing receipt`.
No skip or omission allowance is added.

## Required lanes and loss detection

The three required merge jobs and six commands are unchanged. Per-ID loss
checking in `inventory.tiers.merge` names only App and SDK. The four Node lanes
are required commands but absent from both inventory tier lists.

Synthetic controls change temporary data copies only:

| Control | Measured result |
| --- | --- |
| Remove one proposed PASS receipt per addition lane, keeping selected/executed counts consistent | Five CLI runs FAIL/raw1 with `new inventory ID lacks a passing receipt` |
| Use the proposed inventory as a prospective trusted base; consistently remove an added App ID | FAIL/raw1, additional lost-ID error: 32 findings / five losses |
| Same prospective control for one ID in each of the four Node lanes | Each stays FAIL/raw1 on the original 31 findings; **no per-ID error for the removed Node ID** |
| Append one skipped Linux row against each actual observation | Both FAIL/raw1; missing PASS receipt |

Missing commands/streams and inconsistent collection remain rejected by the
unchanged collector/suite checks. A consistently reduced Node roster is outside
the current per-ID loss loop. These still-failing prospective controls do not
qualify a future run. The tier lists are preserved for Lead disposition.

Unchanged comparator probes pass **27/27**, raw exit 0; unchanged hosted-collector
probes pass **3/3**, raw exit 0. Full logs are in `comparator-probes.txt` and
`collector-probes.txt`; cancelled/nonterminal workflows still reject complete
receipts while completed failures remain eligible as evidence.

## Lead dispositions requested

1. Review the 824 append-only PASS additions with both actual native receipts.
2. Decide trusted identity migration for 17 displaced declarations, preserving
   the historical native/source chain rather than accepting shared titles.
3. Decide the timestamp title and substantive track-label contract separately.
4. Decide all 26 declared Linux skips under trusted omission policy, preserving
   exact Darwin evidence and distinct lane identity.
5. Resolve the absent Node loss-check lanes and complete-native-inventory status
   through authorized trusted policy work. Neither is changed here.

Gate settings, activation, release-only evidence, #316 integration and final
qualification remain Lead/owner work. No Plan 38/55 test, destination or board
was edited. Original FAIL verdicts and failures remain reviewable.

## Reproduction

Fetch the immutable observation/checkout commits above plus base and seal.
Extract the official verdict archives to `INPUTS/original` and `INPUTS/sync`,
retaining `INPUTS/original.zip` and `INPUTS/sync.zip`. Retrieve native jobs API
responses as `INPUTS/jobs-44611475170.json` and `INPUTS/jobs-44616853834.json`
(preserved response objects are also in `job-metadata.json.gz`). Run:

```sh
python3 ci/evidence/p39-28/reconcile.py --inputs INPUTS --output ci/evidence/p39-28
python3 -I scripts/ci/test_failure_ceiling.py -v
python3 -I scripts/ci/test_ceiling_hosted.py -v
```

The generator verifies the submitted inventory equals the derived append-only
candidate. On a base checkout, `--write-inventory` writes that derived inventory.
It never edits the trusted evaluator. Historical identity/skip reports are
retained evidence, not policies applied by the generator.

Routes used: X for implementation and testing. Bounded parallel source/native
extraction informed this evidence; the packet writer verified historical rows,
blobs, declarations and all native suites. Lead owns review and integration.
