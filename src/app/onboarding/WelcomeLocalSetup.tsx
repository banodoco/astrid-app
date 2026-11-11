import { BackButton, EditorCard, EditorCardFoot } from '@/shared/components/RuntimeConnection/EditorCard.tsx';
import { EditorCardLayer } from '@/shared/components/RuntimeConnection/EditorCardLayer.tsx';
import { detectInstallScenario } from '@/pages/Home/installScenario.ts';
import { LOCAL_SETUP, PINOKIO_INSTALL_COPY, localSetupSteps } from '@/shared/components/RuntimeConnection/copy.ts';
import { SetupBlock } from '@/shared/components/RuntimeConnection/SetupBlock.tsx';
import { CopyCommandRow } from '@/shared/components/RuntimeConnection/CopyInstallCommand.tsx';

export function WelcomeLocalSetup({ onBack, initiallySetUp = false, onContinue }: { readonly onBack: () => void; readonly initiallySetUp?: boolean; readonly onContinue?: () => void }) {
  const steps = localSetupSteps();

  return <main aria-label="Set up Astrid with your agent">
    <EditorCardLayer cardKey="local">
      <EditorCard
        scrollContent
        title="Have your agent set it up"
        sentence={<>Paste these instructions into Claude Code, Codex or another agent. It installs Astrid, gets the editor from <a className="underline underline-offset-4 hover:text-foreground" href={LOCAL_SETUP.repoUrl} target="_blank" rel="noreferrer">GitHub</a> and starts both on your computer.</>}
        topLeft={<BackButton onBack={onBack} />}
        foot={<EditorCardFoot>When it&apos;s done, Astrid opens from your own computer.</EditorCardFoot>}
      >
        <div className="space-y-2">
          <SetupBlock initiallySetUp={initiallySetUp} localSetup localBuild onContinue={onContinue} continueLabel="Continue" />
        </div>
        <section className="min-w-0 space-y-1.5 text-left">
          <p className="text-[13px] font-medium text-muted-foreground">Run it yourself</p>
          <ol className="min-w-0 list-decimal space-y-1.5 pl-5 text-[13px] leading-5 text-muted-foreground marker:text-muted-foreground">
            {steps.map((step, stepIndex) => <li key={stepIndex} className="min-w-0">
              <div className="min-w-0 break-words">
                {step.line}
              </div>
              {step.command && <div className="mt-1 space-y-1">
                <CopyCommandRow
                  command={step.command}
                  label={step.commandLabel ?? 'Copy command'}
                />
                {step.hint && <p className="text-xs leading-4 text-muted-foreground">{step.hint}</p>}
              </div>}
            </li>)}
          </ol>
          {detectInstallScenario() === 'chromium' && <p className="text-[13px] leading-5 text-muted-foreground"><a className="underline underline-offset-4 hover:text-foreground" href={PINOKIO_INSTALL_COPY.installUrl} target="_blank" rel="noreferrer">{PINOKIO_INSTALL_COPY.fullyLocalLabel}</a></p>}
          <p className="text-[13px] leading-5 text-muted-foreground">Ctrl+C stops it. To start again, run npm run dev:local in the astrid-app folder.</p>
        </section>
        <a href="http://127.0.0.1:5180" target="_blank" rel="noreferrer" className="block text-center text-[13px] text-muted-foreground underline underline-offset-4 hover:text-foreground">Open my local editor</a>
      </EditorCard>
    </EditorCardLayer>
  </main>;
}
