// node:test reporter: lists every skipped test by name and fails the run on any skip not declared in
// config/testing/skipRegistry.mjs. Use alongside a normal reporter:
//   node --test --test-reporter=spec --test-reporter-destination=stdout \
//     --test-reporter=./scripts/quality/node-skip-guard-reporter.mjs --test-reporter-destination=stdout ...
import { observeNodeEvents } from '../ci/ceiling_node.mjs';
import { classifySkips, formatSkipReport } from '../../config/testing/skipRegistry.mjs';

export default async function* nodeSkipGuard(source) {
  const entries = [];
  let passed = 0;
  for await (const event of observeNodeEvents(source)) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const { name, skip, todo, file, details } = event.data;
    if (event.type === 'test:pass' && skip === undefined && todo === undefined && details?.type !== 'suite') passed += 1;
    if (skip === undefined && todo === undefined) continue;
    entries.push({ name: `${file ?? ''} > ${name}`, reason: typeof skip === 'string' ? skip : typeof todo === 'string' ? todo : '' });
  }
  if (passed === 0) {
    yield '\nNo test passed in this run: a run where everything was skipped, todo or failed is not a green run.\n';
    process.exitCode = 1;
  }
  if (!entries.length) return;
  const report = classifySkips(entries);
  yield `\n${formatSkipReport(report)}\n`;
  if (report.undeclared.length) {
    yield `\n${report.undeclared.length} undeclared skip(s): declare each in config/testing/skipRegistry.mjs and use scripts/quality/declared-skip.mjs.\n`;
    process.exitCode = 1;
  }
}
