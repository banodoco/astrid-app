import type { Reporter, TestModule } from 'vitest/node';
import { classifySkips, formatSkipReport, VITEST_EXPECTED_FAILURES } from './skipRegistry.mjs';

/**
 * Fails the run on any skipped, todo or .skip'd test whose skip is not declared in skipRegistry.mjs,
 * and prints every skip by test name. A run where no test passed fails too: all-skipped is never green. Declared skips arrive through `skipWhen`, which calls ctx.skip(note).
 */
export default class SkipGuardReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const entries: Array<{ name: string; reason: string }> = [];
    let passed = 0;
    const expectedFailures = new Set<string>();
    const selectedFiles = new Set<string>();
    const identity = (file: string, title: string) => JSON.stringify([file, title]);
    const registered = new Set(VITEST_EXPECTED_FAILURES.map((entry) => identity(entry.file, entry.title)));
    for (const module of testModules) {
      const file = module.moduleId.replace(`${process.cwd()}/`, '');
      selectedFiles.add(file);
      for (const test of module.children.allTests()) {
        if (!test.options.fails) {
          if (test.result().state === 'passed') passed += 1;
          continue;
        }
        const id = identity(file, test.fullName);
        expectedFailures.add(id);
        if (!registered.has(id)) {
          console.error(`UNDECLARED EXPECTED FAILURE ${file} > ${test.fullName}`);
          process.exitCode = 1;
        }
      }
      for (const test of module.children.allTests('skipped')) {
        const result = test.result();
        entries.push({
          name: `${module.moduleId.replace(`${process.cwd()}/`, '')} > ${test.fullName}`,
          reason: result.state === 'skipped' ? (result.note ?? '') : '',
        });
      }
    }
    for (const entry of VITEST_EXPECTED_FAILURES) {
      if (selectedFiles.has(entry.file) && !expectedFailures.has(identity(entry.file, entry.title))) {
        console.error(`MISSING EXPECTED FAILURE ${entry.file} > ${entry.title}`);
        process.exitCode = 1;
      }
    }
    if (passed === 0) {
      console.error('\nNo test passed in this run: a run where everything was skipped, todo or failed is not a green run.');
      process.exitCode = 1;
    }
    if (!entries.length) return;
    const report = classifySkips(entries);
    console.log(`\n${formatSkipReport(report)}`);
    if (report.undeclared.length) {
      console.error(`\n${report.undeclared.length} undeclared skip(s): declare each in config/testing/skipRegistry.mjs and use skipWhen, or remove it.`);
      process.exitCode = 1;
    }
  }
}
