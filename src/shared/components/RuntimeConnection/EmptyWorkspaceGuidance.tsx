import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AstridRuntimeClient } from '@/integrations/runtime/client.ts';
import { useRuntimeConnection } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';
import { runtimeApiBase } from '@/integrations/runtime/connection.ts';
import { Button } from '@/shared/components/ui/button.tsx';
import { useIsDesktopEditor } from '@/tools/video-editor/tour/runner/useIsDesktopEditor.ts';
import { startEditorTour } from '@/shared/state/editorTourStore';
import { writeClipboardTextSafe } from '@/shared/lib/browser/clipboard.ts';
import { installCommand, RUNTIME_CONNECTION_COPY } from './copy.ts';

type WorkspaceIdentity = { name: string; realmId: string };

/**
 * The details are for an agent to find the person's work, not for the person to inspect. Each Astrid install keeps its
 * own workspace, so the likely cause is that another Astrid on this computer holds it.
 */
function emptyWorkspaceDiagnostic(identity: WorkspaceIdentity, pageOrigin: string, endpoint: string): string {
  return [
    `The page open at ${pageOrigin} is connected to Astrid on this computer, but there are no projects in its workspace, "${identity.name}" (ID ${identity.realmId}, reached through ${endpoint}). I expected to see my work, so it may be in another Astrid on this computer.`,
    '',
    '1. Find out which Astrid is running now, and the folder it runs from.',
    '2. Look for other install.json files and check whether they contain "owner": "haus.astrid.runtime". Each Astrid install keeps its own workspace.',
    '3. Tell me what you found, and ask me which one holds my work before you change anything.',
    `4. Astrid is already set up, so restart it without asking me to install it again. This command has no changed setup choices: an existing installation keeps its saved choices; a fresh install uses the recommendations (start at sign-in on, \`astrid\` command on, skills on, skill copies off). It uses the Astrid installation saved for sign-in, or the default install folder if none is saved. It keeps the saved workspace; otherwise it checks the default and old workspace locations. It does not select the folder I choose here: ${installCommand('install')}`,
    "   Check that those choices match the Astrid I chose before running it. If they differ, stop and explain what needs to change. Don't reset, replace or delete any existing data. Then I'll reload this page.",
    '',
    'Never create, reset or delete a workspace, project or install to work around this.',
  ].join('\n');
}

/** An empty, healthy workspace can be the wrong one; help people check before creating new work. */
export function EmptyWorkspaceGuidance({ onRefresh, confirmedEmpty = false }: { onRefresh: () => void; confirmedEmpty?: boolean }) {
  const [showDetails, setShowDetails] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [didCopy, setDidCopy] = useState(false);
  const { connectedBefore } = useRuntimeConnection();
  const desktop = useIsDesktopEditor();
  const copiedTimer = useRef<number | null>(null);
  const identity = useQuery({
    queryKey: ['runtime', 'empty-workspace-identity'],
    enabled: showDetails,
    retry: false,
    queryFn: async (): Promise<WorkspaceIdentity> => {
      const session = await new AstridRuntimeClient().ensureSession();
      return {
        name: session.realm.display_name,
        realmId: session.realm.realm_id,
      };
    },
  });
  const diagnostic = identity.data
    ? emptyWorkspaceDiagnostic(identity.data, window.location.origin, runtimeApiBase())
    : '';
  const copy = RUNTIME_CONNECTION_COPY.agent;

  useEffect(() => () => {
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
  }, []);

  const handleCopy = async () => {
    const copied = await writeClipboardTextSafe(diagnostic);
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    setCopyState(copied ? 'copied' : 'failed');
    if (copied) {
      setDidCopy(true);
      copiedTimer.current = window.setTimeout(() => {
        copiedTimer.current = null;
        setCopyState('idle');
      }, 2000);
    }
  };

  const handleCheckAgain = () => {
    if (identity.error) void identity.refetch();
    onRefresh();
  };

  const showTour = confirmedEmpty && desktop;
  // The app only mounts this component after a successful empty project listing.
  // Keep work-recovery guidance for returning users, while allowing a new user to
  // try the in-memory tour before creating any project.
  if (!connectedBefore && !showTour) return null;
  return <div className="space-y-3 text-sm text-muted-foreground">
    {showTour && <Button variant="outline" onClick={startEditorTour}>Take the editor tour</Button>}
    {connectedBefore && <>
      <p>Expected to see your work? It may be in another Astrid folder on this computer.</p>
      <details onToggle={event => setShowDetails(event.currentTarget.open)}>
        <summary className="cursor-pointer text-foreground">Find my work</summary>
        <div className="mt-3 space-y-3">
          {identity.isPending && <p role="status">Reading details…</p>}
          {identity.error && <p role="status">Astrid's details aren't available right now.</p>}
          <div className="flex flex-wrap gap-2">
            {identity.data && <Button variant="outline" onClick={() => void handleCopy()}>
              {copyState === 'copied' ? copy.copied : 'Copy steps for your agent'}
            </Button>}
            <Button variant="outline" onClick={handleCheckAgain}>Check again</Button>
          </div>
          {identity.data && didCopy && <p role="status">{copy.pasteNext}</p>}
          {identity.data && copyState === 'failed' && <div className="space-y-2">
            <p role="status">{copy.copyFailed}</p>
            <textarea aria-label={copy.copyFailed} readOnly value={diagnostic} rows={6} onFocus={event => event.currentTarget.select()} className="w-full rounded-md border border-border bg-background p-2 text-xs text-foreground" />
          </div>}
        </div>
      </details>
    </>}
  </div>;
}
