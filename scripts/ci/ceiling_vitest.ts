// Additional observation only; the existing skip/result guards remain decisive.
import { closeSync, openSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { Reporter, TestCase, TestModule, TestSpecification, Vitest } from 'vitest/node';

export default class CeilingVitest implements Reporter {
  private root = process.cwd();
  private fd: number | undefined;
  private failures = 0;
  onInit(ctx: Vitest): void { this.root = ctx.config.root; }
  private write(event: Record<string, unknown>): void {
    if (this.fd !== undefined) writeSync(this.fd, `${JSON.stringify(event)}\n`);
  }
  private id(test: TestCase): string {
    return test.id;
  }
  onTestRunStart(_specs: ReadonlyArray<TestSpecification>): void {
    if (!process.env.CEILING_STEP_DIR || process.env.CEILING_REPORTER_ACTIVE) return;
    process.env.CEILING_REPORTER_ACTIVE = String(process.pid);
    this.fd = openSync(path.join(process.env.CEILING_STEP_DIR, `vitest-${process.pid}-${Date.now()}.jsonl`), 'wx');
    this.write({ event: 'start', runner: 'vitest' });
  }
  onTestModuleCollected(module: TestModule): void {
    this.write({ event: 'collection', tests: [...module.children.allTests()].map((test) => ({ native_id: this.id(test), internal_id: test.id })) });
  }
  onTestCaseResult(test: TestCase): void {
    const result = test.result();
    const outcome = test.options.fails && result.state === 'passed' ? 'xfailed' : result.state;
    if (outcome === 'failed') this.failures += 1;
    this.write({ event: 'result', native_id: this.id(test), internal_id: test.id, parameter: null,
      source: { file: path.relative(this.root, test.module.moduleId).split(path.sep).join('/'), name: test.fullName },
      outcome, finished: result.state !== 'pending', stage: 'call',
      diagnostic: result.state === 'failed' ? (result.errors ?? []).map((error) => `${error.name}: ${error.message}`).join('\n')
        : result.state === 'skipped' ? result.note ?? '' : test.options.fails ? 'expected failure' : '' });
  }
  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    const tests = modules.flatMap((module) => [...module.children.allTests()]);
    this.write({ event: 'finish', count: tests.length, pending: tests.filter((test) => test.result().state === 'pending').length,
      exitstatus: this.failures ? 1 : 0 });
    if (this.fd !== undefined) closeSync(this.fd);
  }
}
