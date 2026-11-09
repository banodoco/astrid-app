#!/usr/bin/env node
import { requestLocalUpdate } from './local-update-control.mjs';
try {
  const result = await requestLocalUpdate();
  console.log(result.message);
  // The Agent's receipt decides the exit code (3: not updated); older Agents send none.
  if (Number.isInteger(result.exitCode)) process.exitCode = result.exitCode;
} catch (error) {
  console.error(`Astrid update failed at ${error.step ?? 'connect-launcher'}: ${error.message}`);
  // The Agent's plain lines, Next and Details included, follow the failure line.
  for (const line of error.lines ?? []) console.error(line);
  process.exitCode = Number.isInteger(error.exitCode) && error.exitCode !== 0 ? error.exitCode : 1;
}
