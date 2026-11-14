import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/shared/components/ui/button.tsx';
import type { ServiceStatus } from '@/integrations/runtime/generated.ts';
import { detectPlatform } from '@/shared/hooks/platformInstall/platformDetection.ts';
import { agentInstructions, hasPendingSetupState, installCommand, localSetupInstructions, readPendingSetupState, RECOMMENDED_SETUP_CHOICES, RUNTIME_CONNECTION_COPY, SETUP_SKILL_POINTER, UPDATE_ROUTES, writePendingSetupState, type CommandMode, type SetupChoices, withCommandShell } from './copy.ts';
import { CopyCommandRow, CopyFallback, useCopyAction } from './CopyInstallCommand.tsx';

const CHOICE_ROWS = [
  ['autostart', 'Start Astrid at sign-in'],
  ['command', 'Add the `astrid` terminal command'],
  ['skills', 'Install skills for coding agents'],
  ['skillCopies', 'Use copies for skills'],
] as const satisfies readonly (readonly [keyof SetupChoices, string])[];

export interface SetupBlockProps {
  readonly initiallySetUp?: boolean;
  readonly initialChoices?: SetupChoices;
  readonly mode?: CommandMode;
  readonly showCheckbox?: boolean;
  readonly localBuild?: boolean;
  readonly localSetup?: boolean;
  readonly explicitChoices?: boolean;
  readonly onContinue?: () => void;
  readonly continueLabel?: string;
  readonly services?: readonly ServiceStatus[];
}

/** The single setup/repair command surface shared by onboarding, connection recovery and Settings. */
export function SetupBlock({ initiallySetUp, initialChoices, mode = 'install', showCheckbox = true, localBuild = false, localSetup = false, explicitChoices = false, onContinue, continueLabel = 'Continue', services }: SetupBlockProps) {
  const [savedSetup] = useState(readPendingSetupState);
  const [alreadySetUp, setAlreadySetUp] = useState(hasPendingSetupState() ? savedSetup.alreadySetUp : initiallySetUp ?? savedSetup.alreadySetUp);
  const [customize, setCustomize] = useState(false);
  // Existing installs (update, Settings Setup) keep saved choices: the command carries none, so no choice controls.
  const existing = mode === 'update' || explicitChoices;
  const [choices, setChoices] = useState<SetupChoices>(initialChoices ?? savedSetup.choices ?? RECOMMENDED_SETUP_CHOICES);
  const saveState = (nextAlreadySetUp: boolean, nextChoices: SetupChoices) => writePendingSetupState({ alreadySetUp: nextAlreadySetUp, choices: nextChoices });
  useEffect(() => { writePendingSetupState({ alreadySetUp, choices }); }, [alreadySetUp, choices]);
  const command = installCommand(mode, choices, explicitChoices, localBuild, alreadySetUp);
  const instructions = localSetup
    ? localSetupInstructions(choices, alreadySetUp, explicitChoices)
    : agentInstructions(mode, window.location.origin, localBuild, services, { choices, alreadySetup: alreadySetUp, explicitChoices });
  const agentCopy = useCopyAction(instructions);

  return <section aria-label="Astrid setup" className="space-y-3 text-left">
    {showCheckbox && <label className="flex cursor-pointer items-start gap-2 text-sm">
      <input type="checkbox" checked={alreadySetUp} onChange={event => { const checked = event.currentTarget.checked; setAlreadySetUp(checked); saveState(checked, choices); }} className="mt-1 accent-primary" />
      <span>I&apos;ve already set up Astrid</span>
    </label>}
    <div className="rounded-lg border border-border bg-background/60 p-3 text-sm">
      <p className="font-medium">{alreadySetUp ? 'Start Astrid' : 'Recommended setup'}</p>
      <p className="mt-1 text-muted-foreground">{existing ? 'Your saved setup choices are kept.' : <>Start at sign-in · <span className="font-mono">astrid</span> command · skills on · skill copies off</>}</p>
      {alreadySetUp || existing ? null : <>
        <Button type="button" variant="link" className="mt-1 h-auto p-0 text-sm" aria-expanded={customize} onClick={() => setCustomize(open => !open)}>
          {customize ? 'Hide options' : 'Customize'}
        </Button>
        {customize && <fieldset className="mt-3 space-y-2">
          <legend className="sr-only">Customize Astrid setup</legend>
          {CHOICE_ROWS.map(([key, label]) => <label key={key} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={choices[key]} onChange={event => {
              const checked = event.currentTarget.checked;
              const next = { ...choices, [key]: checked };
              setChoices(next);
              saveState(alreadySetUp, next);
            }} className="accent-primary" />
            <span>{label}</span>
          </label>)}
        </fieldset>}
      </>}
    </div>
    <div className="space-y-2">
      {detectPlatform() === 'windows' && <p className="text-xs text-muted-foreground">{RUNTIME_CONNECTION_COPY.windowsBeta}</p>}
      <Button type="button" className="h-11 w-full justify-between rounded-xl px-4 text-sm" onClick={() => void agentCopy.copy()}>
        <span aria-live="polite">{agentCopy.status === 'copied' ? RUNTIME_CONNECTION_COPY.agent.copied : 'Copy instructions for your agent'}</span>
        {agentCopy.status === 'copied' ? <Check aria-hidden="true" className="h-4 w-4" /> : <Copy aria-hidden="true" className="h-4 w-4" />}
      </Button>
      {mode === 'install' && <p className="text-xs text-muted-foreground">{SETUP_SKILL_POINTER}</p>}
      {agentCopy.status === 'failed' && <CopyFallback text={instructions} label={RUNTIME_CONNECTION_COPY.agent.copyFailed} />}
      <p className="text-xs font-medium text-muted-foreground">{mode === 'update' || localBuild && detectPlatform() !== 'windows' ? 'Run it yourself' : withCommandShell(RUNTIME_CONNECTION_COPY.agent.terminalAlternative)}</p>
      {mode === 'update' && <p className="text-xs text-muted-foreground">{withCommandShell(RUNTIME_CONNECTION_COPY.agent.terminalAlternativeUpdate)}</p>}
      {detectPlatform() === 'windows' && mode !== 'update' && <p className="text-xs text-muted-foreground">If pasting gives nothing, select the command and press Ctrl+C.</p>}
      {localBuild && !localSetup && <p className="text-xs text-muted-foreground">In your Astrid clone, start the editor with <code>npm run dev:local</code>. Use the install command below to install or repair Astrid.</p>}
      {mode === 'update' && localBuild && <p className="text-xs text-muted-foreground">{UPDATE_ROUTES.source}</p>}
      <CopyCommandRow command={command} label={RUNTIME_CONNECTION_COPY.agent.commandCopy} copiedLabel={RUNTIME_CONNECTION_COPY.agent.commandCopied} />
    </div>
    {onContinue && <Button type="button" className="h-11 w-full rounded-xl" onClick={onContinue}>{continueLabel}</Button>}
  </section>;
}
