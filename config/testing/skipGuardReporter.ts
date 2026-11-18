import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { Reporter, TestCase, TestModule, TestSpecification, Vitest } from 'vitest/node';
import { classifySkips, expectedFailureProblems, formatSkipReport, laneIsRequired, skipReason } from './skipRegistry.mjs';
import { inspectTestSource } from '../../scripts/quality/lib/test-source.mjs';

type Skip = { name: string; reason: string; file: string; location: TestCase['location'] };

/** The runtime authority for skips and expected failures; also records finished tests synchronously. */
export default class SkipGuardReporter implements Reporter {
  private root = process.cwd();
  private stream: number | undefined;
  private source = new Map<string, ReturnType<typeof inspectTestSource>>();

  // Explicit opt-in prevents nested guard fixtures inheriting the parent's result
  // path from overwriting the outer run. Main/boundary configs own this option.
  constructor(private readonly options: { resultsFile?: string } = {}) {}

  onInit(ctx: Vitest): void {
    this.root = ctx.config.root;
  }

  private relative(file: string): string {
    return path.relative(this.root, file).split(path.sep).join('/');
  }

  private write(record: Record<string, unknown>): void {
    if (this.stream !== undefined) writeSync(this.stream, `${JSON.stringify(record)}\n`);
  }

  onTestRunStart(specifications: ReadonlyArray<TestSpecification>): void {
    this.source.clear();
    if (this.options.resultsFile) {
      mkdirSync(path.dirname(this.options.resultsFile), { recursive: true });
      this.stream = openSync(this.options.resultsFile, 'w');
      this.write({ event: 'start', version: 1, modules: specifications.map((spec) => this.relative(spec.moduleId)) });
    }
  }

  private identity(test: TestCase) {
    return { id: test.id, file: this.relative(test.module.moduleId), name: test.fullName,
      expectedFailure: Boolean(test.options.fails), mode: test.options.mode };
  }

  onTestModuleCollected(module: TestModule): void {
    this.write({ event: 'collected', file: this.relative(module.moduleId),
      tests: [...module.children.allTests()].map((test) => this.identity(test)) });
  }

  onTestCaseResult(test: TestCase): void {
    const result = test.result();
    this.write({ event: 'result', ...this.identity(test), state: result.state,
      ...(result.state === 'skipped' ? { note: result.note ?? '' } : {}) });
  }

  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const entries: Skip[] = [];
    const expectedFailures: Array<{ file: string; title: string }> = [];
    const selectedFiles = new Set<string>();
    let passed = 0;
    let total = 0;
    let pending = 0;
    let refused = false;
    for (const module of testModules) {
      const file = this.relative(module.moduleId);
      selectedFiles.add(file);
      for (const test of module.children.allTests()) {
        total += 1;
        const result = test.result();
        if (result.state === 'pending') pending += 1;
        if (test.options.fails) {
          expectedFailures.push({ file, title: test.fullName });
        } else if (result.state === 'passed') passed += 1;
        if (result.state === 'skipped') {
          entries.push({ name: `${file} > ${test.fullName}`, reason: result.note ?? '',
            file: module.moduleId, location: test.location });
        }
      }
    }
    for (const problem of expectedFailureProblems(expectedFailures, selectedFiles)) {
      console.error(problem);
      refused = true;
    }
    if (passed === 0) {
      console.error('\nNo test passed in this run: a run where everything was skipped, todo or failed is not a green run.');
      refused = true;
    }
    const report = classifySkips(entries, (entry, declaration) => {
      if (!this.source.has(entry.file)) this.source.set(entry.file, inspectTestSource(entry.file));
      return this.source.get(entry.file)!.declaredSkipsAt(entry.location).includes(declaration)
        && !laneIsRequired(declaration) && skipReason(declaration) !== null;
    });
    if (entries.length) console.log(`\n${formatSkipReport(report)}`);
    if (report.undeclared.length) {
      console.error(`\n${report.undeclared.length} undeclared skip(s): each tag must be bound to this test's skipWhen call in config/testing/skipRegistry.mjs.`);
      refused = true;
    }
    if (pending) {
      console.error(`${pending} test(s) did not finish; partial results are not a complete run.`);
      refused = true;
    }
    if (refused) process.exitCode = 1;
    this.write({ event: 'end', tests: total, pending, guardPassed: !refused });
    if (this.stream !== undefined) {
      closeSync(this.stream);
      this.stream = undefined;
    }
  }
}
