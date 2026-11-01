#!/usr/bin/env bash
# Focused provisional I-AP-02-R1 evidence. This is not I-AP-03/08 tuple acceptance.
set -euo pipefail
cd "$(dirname "$0")/../.."
I_AP_02_R1_OUT=${I_AP_02_R1_OUT:-/workspace/out/I-AP-02-R1}
mkdir -p "$I_AP_02_R1_OUT"
run_check() {
  local label=$1
  shift
  local result=0
  "$@" > "$I_AP_02_R1_OUT/$label.log" 2>&1 || result=$?
  printf '%s\texit=%s\n' "$label" "$result" >> "$I_AP_02_R1_OUT/results.tsv"
  return "$result"
}
printf 'PROVISIONAL Runtime c5991fc501bc8c43c90ef5daf8d15c7f2c5d25fd; rebind at I-AP-07\n' > "$I_AP_02_R1_OUT/provenance.txt"
node --input-type=module -e 'import fs from "node:fs"; const lock=JSON.parse(fs.readFileSync("runtime.lock.json")); if(lock.source_commit!=="c5991fc501bc8c43c90ef5daf8d15c7f2c5d25fd"||!lock.provisional) throw Error("Expected explicitly provisional Runtime source"); console.log(process.version, lock.source_commit, lock.provisional.reason);' >> "$I_AP_02_R1_OUT/provenance.txt"
sha256sum runtime.lock.json public/install-manifest.json package-lock.json src/integrations/runtime/generated.ts src/integrations/runtime/generated-contract-metadata.ts src/integrations/runtime/timeline-commit-types.ts vendor/artifacts/banodoco-timeline-composition-0.0.17.tgz > "$I_AP_02_R1_OUT/hashes.txt"
run_check contract-lock node scripts/vendor-lock.mjs check runtime.lock.json
run_check mounted-guards ./node_modules/.bin/vitest run --config config/testing/vitest.config.ts --maxWorkers=1 \
  src/tools/video-editor/hooks/useTimelineSave.strictUpdate.test.tsx \
  src/tools/video-editor/hooks/useTimelinePersistence.test.tsx \
  src/tools/video-editor/hooks/useEditorBrowserDefaults.test.tsx \
  src/shared/components/RuntimeConnection/UpdateResolutionActions.test.tsx \
  src/shared/components/RuntimeConnection/InstallerUpdateCallers.test.tsx \
  src/shared/lib/updates/updateOperation.test.ts \
  src/tools/video-editor/components/AgentChat/projectChatDraftPersistence.test.ts \
  src/shared/components/RuntimeConnection/AppBuildProvider.test.tsx
run_check restart-replay ./node_modules/.bin/vitest run --config config/testing/vitest.config.ts --maxWorkers=1 \
  src/tools/video-editor/hooks/useTimelineSave.currentContract.test.tsx \
  src/tools/video-editor/hooks/useTimelineSave.mountedRecovery.test.tsx \
  src/tools/video-editor/hooks/useTimelineSave.recovery.persistence.test.tsx
run_check chat-projection ./node_modules/.bin/vitest run --config config/testing/vitest.config.ts --maxWorkers=1 \
  src/tools/video-editor/components/AgentChat/AgentChat.test.tsx \
  src/tools/video-editor/components/AgentChat/AgentChat.hosted.test.tsx \
  src/tools/video-editor/components/AgentChat/AgentChat.projectContract.test.tsx \
  src/tools/video-editor/components/AgentChat/NewChatMenu.test.tsx \
  src/tools/video-editor/data/shotCompositionProjection.test.ts
run_check contract-generation ./node_modules/.bin/vitest run --config config/testing/vitest.config.ts --maxWorkers=1 \
  src/integrations/runtime/vendorLock.test.ts \
  src/integrations/runtime/contract-metadata.test.ts
run_check element-parameters ./node_modules/.bin/vitest run --config config/testing/vitest.config.ts --reporter=default src/tools/video-editor/hooks/useTimelineSave.test.tsx -t "keeps supported browser element saves|forwards parameter gestures" --maxWorkers=1
run_check typecheck ./node_modules/.bin/tsc --project tsconfig.app.json --noEmit --pretty false
