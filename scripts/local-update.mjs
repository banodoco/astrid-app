#!/usr/bin/env node
import { requestLocalUpdate } from './local-update-control.mjs';
try {
  const result = await requestLocalUpdate();
  console.log(result.message);
  // A recovery puts back the version before an interrupted update; this run did not update, so it does not exit 0.
  if (result.status === 'recovered') process.exitCode = 3;
} catch (error) {
  console.error(`Astrid did NOT update: ${error.message}`);
  console.error(`Details: it stopped at ${error.step ?? 'connect-launcher'}. Settings > Updates > Download diagnostics has the full story.`);
  process.exitCode = 1;
}
