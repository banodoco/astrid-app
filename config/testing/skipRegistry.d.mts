export interface SkipEntry { name: string; reason: string }
export const SKIP_REGISTRY: Record<string, { skipWhen: string; reason: string; applies: () => boolean | string | null; ci: string[]; manual?: string; requireInLane?: string }>;
export const LANES: Record<string, { what: string; command: string; ci: string[]; manual?: string }>;
export const DECLARED_TAG: RegExp;
export const VITEST_EXPECTED_FAILURES: Array<{ id: string; file: string; title: string; issue: string; owner: string; expiry: string }>;
export function declaredTag(name: string): string;
export function declaredName(reason: unknown): string | null;
export function laneIsRequired(name: string): boolean;
export function classifySkips(entries: SkipEntry[]): { declared: SkipEntry[]; undeclared: SkipEntry[] };
export function formatSkipReport(result: { declared: SkipEntry[]; undeclared: SkipEntry[] }): string;
export function skipReason(name: string): string | null;
