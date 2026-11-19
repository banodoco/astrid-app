# R14-P39-28 — App native inventory evidence

Plan 39 K2/K3, [activation issue #984](https://github.com/banodoco/astrid-dev/issues/984).
The packet starts from App `da6e7cc8f8ed33b22e4710b161ba2d4995bd0ea1`.
The [packet](https://github.com/banodoco/astrid-dev/blob/30ebfc6c92fcab822deb5fbb077ee929c1f7663b/releases/14/packets/R14-P39-28.md)
limits changes to supported PASS additions and their proof.

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
