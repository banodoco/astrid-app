#!/usr/bin/env node
import { requestLocalUpdate } from './local-update-control.mjs';
import { updateFailureLines } from './local-update-runner.mjs';
try {
  const result = await requestLocalUpdate();
  console.log(result.message);
  // The Agent's receipt decides the exit code (3: not updated); older Agents send none.
  if (Number.isInteger(result.exitCode)) process.exitCode = result.exitCode;
  // A recovery puts back the version before an interrupted update; this run did not update, so it does not exit 0.
  else if (result.status === 'recovered') process.exitCode = 3;
} catch (error) {
  // The Agent's own lines when the run settled (headline first, Next and Details last), each once.
  for (const line of updateFailureLines(error)) console.error(line);
  process.exitCode = Number.isInteger(error.exitCode) && error.exitCode !== 0 ? error.exitCode : 1;
}
