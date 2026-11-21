# Plan 77 SL-0 live attempt notes

All projects below were created by this synthetic fixture builder on the isolated SL-1 stack through its public Runtime routes. The outbox paths are SDK-selected paths below the SL-0 scratch sibling; no outbox contents or credentials were inspected. Public timeline-index responses were read through `GET /api/runtime/v1/projects/{id}/timelines`.

## Original oversized attempt (left intact)

- Project `f5783c9d793a443f93a51f6fd429f673`, slug `save-loop-fixture-48fd849e`.
- Heavy timeline `save-loop-heavy-48fd849e`: version 1, bootstrap head `bootstrap-db2ba4f2491840e5a493ccb10b4bb3a3`.
- SDK flight metadata reported 671 commands / 21,038,381 serialized request bytes: 616 `clip.add-media`, 46 `occurrence.create`, 9 `track.create`. Pinned Runtime timeline request limit is 1,048,576 bytes.
- First SDK failure was `Broken pipe` / `CommitOutcomeUnknown`; one exact same-key SDK reconciliation also failed. Public head remained bootstrap. The manager directed that this synthetic project and flight remain intact; no further attempt targeted it.

## Bounded attempt A: accepted seed, subsequent history verification error

- Project `59f4c5a65e29441db0690d9a5f8e50dd`, slug `save-loop-fixture-5ae4c28a`.
- Heavy timeline `save-loop-heavy-5ae4c28a`.
- SDK explicit outbox path: `<scratch>/outbox-5ae4c28a/save-loop-heavy-5ae4c28a.json`.
- First 9-command track seed returned receipt `txn-e54c7c7371eb420fa7c43a97729050ef`, revision `authoring-parent-revision-4202ad2a01eae08534d3e8be4bd8b71d23aeee1007be37c40f89bb138efeeb59`.
- The next SDK `Timeline.open` failed before staging the first 12-shot batch with `WorkspaceClientError: accepted commit inputs changed during verification` in the public SDK timeline-history fetch.
- Public index confirms version 2, with head revision and publication exactly matching the accepted seed above. No shots or media were submitted. Control timeline remains version 1/bootstrap.

## Bounded attempt B: unknown result on small seed

- Project `9a144b724d1641b1bebefed77edc4bef`, slug `save-loop-fixture-7e07430c`.
- Heavy timeline `save-loop-heavy-7e07430c`.
- SDK explicit outbox path: `<scratch>/outbox-7e07430c/save-loop-heavy-7e07430c.json`.
- The 9-command track seed returned `CommitOutcomeUnknown`, key `p77-save-loop-heavy-7e07430c-tracks`, with `WorkspaceClientError: Timeline commit outcome unavailable; retry the exact request`.
- Public index afterward showed version 2, head revision `authoring-parent-revision-0b8a6aa9bebc926e26df9f360a30ea11087ebdf16679d480c5333922285524f5`, publication `txn-15d67b76b6e143cfa60a17c65ceaf2c1`. This indicates the request likely landed despite the client result. No exact retry or further write was made after the manager's reconciliation-only ruling. Control timeline remains version 1/bootstrap.

## Outcome

The fixture script now specifies 12-command SDK commit batches, opens each timeline once with its unique outbox, commits tracks first, then shot occurrences and media clips, and records each real receipt and accepted revision. The first tranche is not yet proven end to end. No 616-clip manifest, document-size measurement, warm-edit ratio, retained drop proof, or second-machine proof exists. The required live proof needs Runtime history/reconciliation behavior resolved before media staging.
