#!/usr/bin/env node
import { requestLocalUpdate } from './local-update-control.mjs';
try {
  const result = await requestLocalUpdate();
  console.log(result.message);
  // The Agent's receipt decides the exit code (3: not updated); older Agents send none.
  if (Number.isInteger(result.exitCode)) process.exitCode = result.exitCode;
  // A recovery puts back the version before an interrupted update; this run did not update, so it does not exit 0.
  else if (result.status === 'recovered') process.exitCode = 3;
} catch (error) {
  console.error(`Astrid did NOT update: ${error.message}`);
  // The Agent's plain lines, Next and Details included, follow the failure line.
  const lines = error.lines ?? [];
  for (const line of lines) console.error(line);
  if (!lines.some((line) => /^Details:/.test(line))) {
    console.error(`Details: it stopped at ${error.step ?? 'connect-launcher'}. Settings > Updates > Download diagnostics has the full story.`);
  }
  process.exitCode = Number.isInteger(error.exitCode) && error.exitCode !== 0 ? error.exitCode : 1;
}
