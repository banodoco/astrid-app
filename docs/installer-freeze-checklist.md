# Installer freeze preparation

This is an operator checklist for I-08, not an authorization to freeze or publish.
The rehearsal writes only to a new external evidence directory. Its candidate and
stand-in are not published manifests. Never invoke `pin.mjs <sha>` for this
procedure: that CLI writes the App public manifest and performs its own pinning.

1. Confirm every F-gate task is complete, `int/regression-green(T)` holds, and
   I-11 has finalized Runtime, then Agent, then App. Record full committed SHAs,
   generated hashes, Pinokio, effective VibeComfy and composition identities.
   Any upstream change invalidates affected downstream outputs and evidence.
2. Verify clean, exact Runtime and Agent producer checkouts and their locks;
   the Runtime checkout must match App `runtime.lock.json` and Agent's Runtime
   lock. Verify App generated metadata, local and producer vendor-lock checks,
   and the installed artifacts. Resolve the App CLI-surface lock against its own
   pinned producer; don't assume that pin is the current Agent SHA.
3. Capture the immutable commit for the actual published App main baseline and
   verify the checkout has complete history and the trusted published baseline.
   The helper checks both main's historical high-water and the published baseline;
   a one-step increment may be too low and then the helper refuses. Decide any
   `required.release` policy explicitly; this helper leaves it unchanged.
4. With `EVIDENCE` an empty directory outside the App checkout and `MAIN_SHA` the
   full published main commit, review and save the plan before writing a copy:

   ```sh
   node scripts/installer/update-manifest.mjs --runtime-checkout "$RUNTIME" --agent-checkout "$AGENT" --plan
   cp public/install-manifest.json "$EVIDENCE/checkpoint.json"
   node scripts/installer/update-manifest.mjs --runtime-checkout "$RUNTIME" --agent-checkout "$AGENT" --manifest "$EVIDENCE/checkpoint.json" --write
   node scripts/installer/freeze-candidate.mjs "$EVIDENCE/checkpoint.json" "$EVIDENCE/public-candidate.json" "$MAIN_SHA"
   python3 scripts/installer/rebuild-stand-in.py "$EVIDENCE/public-candidate.json" "$EVIDENCE/stand-in-r2.json"
   ```

   `update-manifest.mjs` sets only Agent, Runtime and schema pins; it does not
   increment release. The candidate helper calls the existing `applyReleasePin`
   exactly once and checks the result against main history and the published
   baseline. It refuses an existing output and cannot write in the App checkout.
   Validate candidate Agent/Runtime/schema through `checkManifest`, run the App
   manifest and vendor checks, and record commands, logs and SHA-256 hashes.
5. The R2 helper requires release 1, changes only release and qualification
   marker, emits the Agent installer's sorted JSON encoding, and refuses an
   existing output. It writes a diagnostic artifact before returning failure if
   `vibecomfy` is absent. A successful local construction is not an installed
   identity proof. Run the actual Agent preservation preflight and reconcile the
   authenticated journey fixture/tuple and hash binding with the qualification
   owner. Record and compare the effective installed manifest and artifact hashes
   after every required path, including VibeComfy, not just source JSON equality.
6. Stop if any check, prerequisite or identity comparison fails. On the actual
   freeze only, the coordinator records the authorized candidate bytes and hash
   as the public manifest once, rebuilds and binds the stand-in, and hands the
   exact tuple to qualification. Post-freeze input changes require a replacement
   tuple and explicit evidence invalidation. Publication is a later, separately
   gated operation.
