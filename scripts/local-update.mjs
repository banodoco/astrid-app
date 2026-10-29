#!/usr/bin/env node
import { requestLocalUpdate } from './local-update-control.mjs';
try {
  const result = await requestLocalUpdate();
  console.log(result.message);
} catch (error) {
  console.error(`Astrid update failed at ${error.step ?? 'connect-launcher'}: ${error.message}`);
  process.exitCode = 1;
}
