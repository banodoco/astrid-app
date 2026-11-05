import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ ensureSession: vi.fn(), clipboard: vi.fn(), connectedBefore: true, desktop: true, beginTour: vi.fn() }));
vi.mock('@/integrations/runtime/client.ts', () => ({ AstridRuntimeClient: class { ensureSession = mocks.ensureSession; } }));
vi.mock('@/integrations/runtime/connection.ts', () => ({ runtimeApiBase: () => 'http://127.0.0.1:17340/api/runtime' }));
vi.mock('@/integrations/runtime/RuntimeConnectionProvider.tsx', () => ({ useRuntimeConnection: () => ({ connectedBefore: mocks.connectedBefore }) }));
vi.mock('@/shared/lib/browser/clipboard.ts', () => ({ writeClipboardTextSafe: mocks.clipboard }));
vi.mock('@/tools/video-editor/tour/runner/useIsDesktopEditor.ts', () => ({ useIsDesktopEditor: () => mocks.desktop }));
vi.mock('@/shared/state/editorTourStore', () => ({ startEditorTour: mocks.beginTour }));

import { EmptyWorkspaceGuidance } from './EmptyWorkspaceGuidance.tsx';
import { installCommand, RUNTIME_CONNECTION_COPY } from './copy.ts';

function showGuidance(onRefresh = vi.fn(), confirmedEmpty = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={client}><EmptyWorkspaceGuidance onRefresh={onRefresh} confirmedEmpty={confirmedEmpty} /></QueryClientProvider>);
  return onRefresh;
}
function openDetails() {
  const details = screen.getByText('Find my work').closest('details')!;
  details.open = true;
  fireEvent(details, new Event('toggle'));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connectedBefore = true;
  mocks.desktop = true;
  mocks.beginTour.mockReset();
  mocks.ensureSession.mockResolvedValue({
    realm: { realm_id: 'realm-existing', display_name: 'My workspace' },
    health: { runtime_instance_id: 'instance-existing' },
    handshake: { session_id: 'private-session-value', token: 'private-credential-value' },
  });
  mocks.clipboard.mockResolvedValue(true);
});

describe('connected empty workspace guidance', () => {
  it('offers the editor tour only for a confirmed empty workspace on desktop, without creating a project', () => {
    showGuidance();
    fireEvent.click(screen.getByRole('button', { name: 'Take the editor tour' }));
    expect(mocks.beginTour).toHaveBeenCalledOnce();
    expect(mocks.ensureSession).not.toHaveBeenCalled();
  });

  it('shows the tour to a first-time connection without showing returning-user recovery copy', () => {
    mocks.connectedBefore = false;
    showGuidance();
    expect(screen.getByRole('button', { name: 'Take the editor tour' })).toBeInTheDocument();
    expect(screen.queryByText('Expected to see your work? It may be in another Astrid folder on this computer.')).toBeNull();
  });

  it('hides the editor tour while project discovery is unconfirmed or on mobile', () => {
    showGuidance(vi.fn(), false);
    expect(screen.queryByRole('button', { name: 'Take the editor tour' })).toBeNull();

    mocks.desktop = false;
    showGuidance();
    expect(screen.queryByRole('button', { name: 'Take the editor tour' })).toBeNull();
  });

  it('uses plain visible words and keeps workspace identity in the agent copy only', async () => {
    const onRefresh = showGuidance();
    expect(screen.getByText('Expected to see your work? It may be in another Astrid folder on this computer.')).toBeInTheDocument();
    expect(mocks.ensureSession).not.toHaveBeenCalled();

    openDetails();
    expect(await screen.findByRole('button', { name: 'Copy steps for your agent' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
    expect(screen.queryByText('My workspace')).toBeNull();
    expect(screen.queryByText('realm-existing')).toBeNull();
    expect(screen.queryByText('Workspace ID')).toBeNull();
    expect(screen.queryByText('Connection:')).toBeNull();
    expect(document.querySelector('dl')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Copy steps for your agent' }));
    await waitFor(() => expect(screen.getByRole('button', { name: RUNTIME_CONNECTION_COPY.agent.copied })).toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('Steps copied. Paste them into your agent.');
    const copied = mocks.clipboard.mock.calls[0][0];
    expect(copied).toContain('My workspace');
    expect(copied).toContain('realm-existing');
    expect(copied).toContain('http://127.0.0.1:17340/api/runtime');
    expect(copied).toContain('install.json');
    expect(copied).toContain('haus.astrid.runtime');
    expect(copied).toContain(installCommand('install'));
    expect(copied).toContain('uses the Astrid installation saved for sign-in, or the default install folder if none is saved');
    expect(copied).toContain('keeps the saved workspace; otherwise it checks the default and old workspace locations');
    expect(copied).toContain('does not select the folder I choose here');
    expect(copied).toContain('`astrid` command on');
    expect(copied).toContain('Check that those choices match the Astrid I chose before running it');
    expect(copied).toContain('If they differ, stop and explain what needs to change');
    expect(copied).not.toContain('bring that installation up');
    expect(copied).not.toContain('astrid-runtime up');
    expect(copied).not.toContain('<folder>/start');
    expect(copied).not.toContain('Library/Application Support');
    expect(copied).toContain('Never create, reset or delete a workspace, project or install');
    expect(copied).not.toContain('private-session-value');
    expect(copied).not.toContain('private-credential-value');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy steps for your agent' })).toBeInTheDocument(), { timeout: 3000 });

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('uses the shared copy failure wording and keeps the diagnostic available to select', async () => {
    mocks.clipboard.mockResolvedValue(false);
    showGuidance();
    openDetails();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy steps for your agent' }));
    expect(await screen.findByRole('status')).toHaveTextContent(RUNTIME_CONNECTION_COPY.agent.copyFailed);
    expect((await screen.findByRole('textbox', { name: RUNTIME_CONNECTION_COPY.agent.copyFailed }) as HTMLTextAreaElement).value).toContain('realm-existing');
  });

  it('lets Check again retry a failed identity read and the project list', async () => {
    mocks.ensureSession.mockRejectedValueOnce(new Error('connection changed'));
    const onRefresh = showGuidance();
    openDetails();
    expect(await screen.findByText("Astrid's details aren't available right now.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy steps for your agent' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByRole('button', { name: 'Copy steps for your agent' })).toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(mocks.ensureSession).toHaveBeenCalledTimes(2);
  });

  it('does not suggest missing work before this browser has connected to Astrid', () => {
    mocks.connectedBefore = false;
    showGuidance();
    expect(screen.queryByText('Expected to see your work? It may be in another Astrid folder on this computer.')).toBeNull();
  });
});
