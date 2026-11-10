import { useEffect, useRef, useState } from 'react';
import { Button } from '@/shared/components/ui/button.tsx';
import { CardDisclosure, EditorCard } from '@/shared/components/RuntimeConnection/EditorCard.tsx';
import { EditorCardLayer } from '@/shared/components/RuntimeConnection/EditorCardLayer.tsx';
import { setUpGenerationInstructions, RUNTIME_CONNECTION_COPY } from '@/shared/components/RuntimeConnection/copy.ts';
import { useRuntimeRequestWait } from '@/integrations/runtime/useRuntimeRequestWait.ts';
import { prepareStarterProject, type StarterProjectSelection } from './prepareStarterProject.ts';

export const PENDING_STARTER_PROJECT_KEY = 'astrid:onboarding:pending-project-v1';
const LAST_PROJECT_KEY = 'astrid:lastOpenedLocalProjectSlug';
let memoryIntent: string | undefined;

function projectIntent(): string {
  try {
    const previous = localStorage.getItem(PENDING_STARTER_PROJECT_KEY);
    if (previous && /^[a-zA-Z0-9-]{1,80}$/.test(previous)) return previous;
    const id = crypto.randomUUID();
    localStorage.setItem(PENDING_STARTER_PROJECT_KEY, id);
    return id;
  } catch {
    return memoryIntent ??= crypto.randomUUID();
  }
}

function finishIntent(intentId: string): void {
  try {
    if (localStorage.getItem(PENDING_STARTER_PROJECT_KEY) === intentId) localStorage.removeItem(PENDING_STARTER_PROJECT_KEY);
  } catch { /* Runtime discovery still recovers a completed project without browser storage. */ }
  if (memoryIntent === intentId) memoryIntent = undefined;
}

function preferredProject(): string | null {
  try { return localStorage.getItem(LAST_PROJECT_KEY); } catch { return null; }
}

/** Mount only inside the connected Runtime gate. The intent is a retry token, never a project ID. */
export function StarterProjectHandoff({ onReady, onContinueWithoutProject }: {
  onReady: (selection: StarterProjectSelection) => void;
  onContinueWithoutProject?: () => void;
}) {
  const [intentId] = useState(projectIntent);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [generationCopyState, setGenerationCopyState] = useState<'ready' | 'copied' | 'failed'>('ready');
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const pending = useRef<{ controller: AbortController; result: Promise<StarterProjectSelection> } | null>(null);
  const stillWaiting = useRuntimeRequestWait(!error, attempt);
  useEffect(() => {
    let active = true;
    if (!pending.current) {
      const controller = new AbortController();
      pending.current = { controller, result: prepareStarterProject({
        intentId, preferredProjectId: preferredProject(), signal: controller.signal,
      }) };
    }
    const current = pending.current;
    void current.result.then(selection => {
      if (!active || pending.current !== current) return;
      onReadyRef.current(selection);
      finishIntent(intentId);
    }, reason => {
      if (active && pending.current === current) setError(reason instanceof Error ? reason.message : 'Please retry project setup.');
    });
    return () => { active = false; };
  }, [attempt, intentId]);
  const cancelAttempt = () => {
    pending.current?.controller.abort();
    pending.current = null;
  };
  const retry = () => {
    cancelAttempt();
    setError(null);
    setAttempt(value => value + 1);
  };
  const state = error ? 'error' : stillWaiting ? 'waiting' : 'opening';
  const archivedOnly = error === 'Your only project is archived. Unarchive it or create a new one in the editor.';
  const copyGenerationInstructions = async () => {
    try {
      await navigator.clipboard.writeText(setUpGenerationInstructions());
      setGenerationCopyState('copied');
    } catch {
      setGenerationCopyState('failed');
    }
  };
  return <main aria-label="Opening your project">
    <EditorCardLayer cardKey={state}>
      <EditorCard title={error ? "Couldn't open your project" : stillWaiting ? 'Still getting your project ready' : 'Opening your project…'}
        sentence={error ? <span role="alert">{archivedOnly ? error : <>Astrid on this computer couldn&apos;t set it up.</>}</span> : stillWaiting
          ? <span role="status">Astrid on this computer is taking longer than usual. You can keep waiting or try again.</span>
          : <span role="status">Astrid is connected and getting your project ready.</span>}>
        {(error || stillWaiting) && <div className="space-y-3">
          {error && !archivedOnly && <CardDisclosure label="Details"><p className="break-words font-mono text-xs">{error}</p></CardDisclosure>}
          <div className={onContinueWithoutProject ? 'grid gap-2 sm:grid-cols-2' : ''}>
            {!archivedOnly && <Button className="h-11 w-full rounded-xl" onClick={retry}>Try again</Button>}
            {onContinueWithoutProject && <Button className="h-11 w-full rounded-xl" variant="outline" onClick={() => { cancelAttempt(); onContinueWithoutProject(); }}>Open editor</Button>}
          </div>
        </div>}
        <section className="mt-4 rounded-xl border border-border/70 bg-muted/30 p-4 text-left">
          <h2 className="font-medium">Set up image generation</h2>
          <p className="mt-1 text-sm text-muted-foreground">Ask your agent to set up generation on this computer.</p>
          <Button className="mt-3 h-10 w-full rounded-xl" variant="outline" onClick={copyGenerationInstructions}>
            {generationCopyState === 'copied' ? RUNTIME_CONNECTION_COPY.agent.copied : RUNTIME_CONNECTION_COPY.agent.copy}
          </Button>
          {generationCopyState === 'failed' && <p role="status" className="mt-2 text-sm text-muted-foreground">Copying didn&apos;t work. Please copy the setup instructions from the generation skill.</p>}
        </section>
      </EditorCard>
    </EditorCardLayer>
  </main>;
}
