export interface TestSourceInspection {
  expectedFailures: Array<{
    line: number;
    column: number;
    title: string | undefined;
    fullTitle: string | undefined;
    previousLine: string;
    kind: 'vitest' | 'playwright';
  }>;
  declaredSkipsAt(location?: { line: number; column: number } | null): string[];
}

export function inspectTestSource(file: string, text?: string): TestSourceInspection;
