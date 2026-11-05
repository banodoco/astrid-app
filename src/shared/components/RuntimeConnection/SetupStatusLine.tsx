import { CheckCircle2, Loader2, Minus } from 'lucide-react';
import { MinkRunner } from '@/shared/components/MinkRunner/MinkRunner';
import { cn } from '@/shared/components/ui/contracts/cn';

export type CheckState = 'checking' | 'pass' | 'fail' | 'later';

export interface SetupChecks {
  runtime: CheckState;
  workspace: CheckState;
  /** Left out where nothing checks tools (App settings), so no row stands in for an answer that never comes. */
  tools?: CheckState;
  /** Runtime running and workspace readable: enough to start creating. */
  ready: boolean;
}

const CHECKS: ReadonlyArray<{ key: keyof Omit<SetupChecks, 'ready'>; label: string; later?: string }> = [
  { key: 'runtime', label: 'Runtime' },
  { key: 'workspace', label: 'Workspace' },
  { key: 'tools', label: 'Tools', later: 'Checked once you have a project' },
];

/** Pending reads as pending (a spinner), not as a failure, until the check passes. */
function CheckMark({ state }: { state: CheckState }) {
  if (state === 'pass') return <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-500" aria-hidden />;
  if (state === 'later') return <Minus className="h-3.5 w-3.5" aria-hidden />;
  return <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />;
}

function statusMessage(checks: SetupChecks): string {
  if (checks.ready) return 'Astrid is up and running';
  if (checks.runtime === 'checking') return 'Looking for Astrid';
  if (checks.runtime !== 'pass') return 'Waiting for Astrid to start';
  return 'Almost there';
}

/**
 * The same compact check rows in onboarding and App settings. `announce` makes the line its own live status; where a
 * sentence beside it already says the same thing (App settings), the marks stay out of the accessibility tree.
 */
export function SetupStatusLine({ checks, mink = true, announce = true, className }: { checks: SetupChecks; mink?: boolean; announce?: boolean; className?: string }) {
  const live = announce
    ? { role: 'status', 'aria-live': 'polite', 'aria-label': statusMessage(checks) } as const
    : { 'aria-hidden': true } as const;
  return (
    <div className={cn('flex flex-col items-center gap-2 text-xs text-muted-foreground', className)} {...live}>
      {mink && !checks.ready && <MinkRunner className="text-foreground" />}
      <span className="flex items-center gap-4">
        {CHECKS.flatMap(({ key, label, later }) => {
          const state = checks[key];
          if (!state) return [];
          return [(
            <span
              key={key}
              className={`inline-flex items-center gap-1.5 ${state === 'pass' ? 'text-foreground' : ''}`}
              data-check={key}
              data-state={state}
              title={state === 'later' ? later : undefined}
            >
              <CheckMark state={state} />
              {label}
            </span>
          )];
        })}
      </span>
    </div>
  );
}
