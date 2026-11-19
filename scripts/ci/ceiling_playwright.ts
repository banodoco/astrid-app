// Native identity, attempt and failing-step custody. Never changes a test result.
import { closeSync, openSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';

export default class CeilingPlaywright implements Reporter {
  private fd: number | undefined;
  private all: TestCase[] = [];
  private root = process.cwd();
  private results = new Map<string, TestResult[]>();
  printsToStdio(): boolean { return false; }
  private write(record: Record<string, unknown>): void { if (this.fd !== undefined) writeSync(this.fd, `${JSON.stringify(record)}\n`); }
  private id(test: TestCase): string {
    const title = test.titlePath().slice(3).join(' › ');
    return JSON.stringify([test.parent.project()?.name ?? '',
      path.relative(this.root, test.location.file).split(path.sep).join('/'),
      test.location.line, test.location.column, title, test.repeatEachIndex]);
  }
  onBegin(config: FullConfig, suite: Suite): void {
    this.root = process.cwd();
    this.all = suite.allTests();
    if (!process.env.CEILING_STEP_DIR || process.env.CEILING_REPORTER_ACTIVE) return;
    process.env.CEILING_REPORTER_ACTIVE = String(process.pid);
    this.fd = openSync(path.join(process.env.CEILING_STEP_DIR, `playwright-${process.pid}-${Date.now()}.jsonl`), 'wx');
    this.write({ event: 'start', runner: 'playwright' });
    this.write({ event: 'collection', tests: this.all.map((test) => ({ native_id: this.id(test), internal_id: test.id })) });
  }
  onTestEnd(test: TestCase, result: TestResult): void {
    const attempts = this.results.get(test.id) ?? [];
    attempts.push(result); this.results.set(test.id, attempts);
    // Flush every attempt before final aggregation so a kill leaves evidence.
    this.write({ event: 'attempt', native_id: this.id(test), internal_id: test.id,
      retry: result.retry, status: result.status, errors: result.errors });
  }
  onEnd(result: FullResult): void {
    let pending = 0;
    for (const test of this.all) {
      const attempts = this.results.get(test.id) ?? [];
      if (!attempts.length) { pending += 1; continue; }
      // A later pass never erases an earlier red. Keep flaky attempts visible.
      const selected = attempts.find((item) => item.status !== 'passed' && item.status !== 'skipped') ?? attempts[attempts.length - 1];
      const unfinished = selected.status === 'interrupted' || (selected.status === 'skipped' && !test.annotations.some((a) => a.type === 'skip' || a.type === 'fixme'));
      if (unfinished) pending += 1;
      const relativeFile = path.relative(this.root, test.location.file).split(path.sep).join('/');
      const frames = selected.errors.flatMap((error) => (error.stack ?? '').split('\n')).filter((line) => line.includes(relativeFile + ':'));
      const lastFrame = frames[frames.length - 1]?.match(/:(\d+):(\d+)\)?\s*$/);
      const stage = lastFrame ? `${relativeFile}:${lastFrame[1]}:${lastFrame[2]}` : 'test';
      const unexpectedPass = test.expectedStatus === 'failed' && selected.status === 'passed';
      const outcome = unexpectedPass ? 'failed' : test.expectedStatus === 'failed' && selected.status !== 'passed' ? 'xfailed' : selected.status === 'passed' ? 'passed' : selected.status === 'skipped' ? 'skipped' : 'failed';
      this.write({ event: 'result', native_id: this.id(test), internal_id: test.id,
        parameter: { project: test.parent.project()?.name ?? '', repeat: test.repeatEachIndex },
        stage, outcome, finished: !unfinished,
        diagnostic: unexpectedPass ? 'XPASS: expected failure but the test passed' : selected.errors.map((error) => error.message ?? error.value ?? '').join('\n') || test.annotations.find((a) => a.type === 'skip' || a.type === 'fixme')?.description || '',
        attempts: attempts.map((attempt) => ({ retry: attempt.retry, status: attempt.status, errors: attempt.errors })) });
    }
    this.write({ event: 'finish', count: this.all.length, pending, exitstatus: result.status === 'passed' ? 0 : 1 });
    if (this.fd !== undefined) closeSync(this.fd);
  }
}
