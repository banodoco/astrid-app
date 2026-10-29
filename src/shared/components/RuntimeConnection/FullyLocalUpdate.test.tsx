// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionFor } from './connectionFixture.ts';
import { RUNTIME_CONNECTION_COPY as COPY } from './copy.ts';
import { RuntimeConnectionPanel } from './RuntimeConnectionPanel.tsx';
import { pageLocalUpdate } from '@/shared/lib/updates/updateOperation.ts';

const { connectionMock, localCheckMock, originMock } = vi.hoisted(() => ({
  connectionMock: { value: null as unknown },
  localCheckMock: vi.fn(),
  originMock: { value: '' },
}));
vi.mock('@/integrations/runtime/RuntimeConnectionProvider.tsx', () => ({ useRuntimeConnection: () => connectionMock.value }));
vi.mock('@/integrations/runtime/connection.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/integrations/runtime/connection.ts')>()),
  runtimeOrigin: () => originMock.value,
}));
vi.mock('@/shared/lib/updates/updateStatus.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/lib/updates/updateStatus.ts')>()),
  checkLocalUpdate: localCheckMock,
}));
vi.mock('@/shared/components/RuntimeConnection/AppBuildProvider.tsx', () => ({ usePageStale: () => false }));

import { AstridUpdatesSection } from '@/shared/components/SettingsModal/sections/AstridUpdatesSection.tsx';

/** The hosted installer's two commands: a fully local install must never show either. */
const INSTALLER_COMMAND = /install \| sh|install\.ps1/;
const TARGET = { url: 'http://127.0.0.1:5000/page-update', token: 'cd'.repeat(32) };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
}

function stubFetch(launcher?: () => Response) {
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
    const url = String(input);
    if (url === '/__astrid/local-update-page') return Promise.resolve(json(200, TARGET));
    if (url === TARGET.url && launcher) return Promise.resolve(launcher());
    return Promise.resolve(json(200, { report: 'Astrid diagnostics' }));
  }));
}

beforeEach(() => {
  pageLocalUpdate().reset();
  vi.unstubAllEnvs();
  vi.stubEnv('VITE_ASTRID_LOCAL_UPDATE_STATUS', '1');
  originMock.value = '';
  connectionMock.value = { isConnected: true, managedByPinokio: false };
  localCheckMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fully-local update guidance', () => {
  it('the refusal row copies npm run update and an agent brief that runs it, never the installer', async () => {
    localCheckMock.mockResolvedValue({ release: 3, app: 'local', servedRelease: 4, servedApp: 'served', behind: true, resolution: { installedRelease: 3, servedRelease: 4, releaseBehind: true } });
    stubFetch(() => json(409, { error: 'refused', code: 'dirty', refusal: 'dirty' }));
    const writeText = vi.fn(async (_text: string) => undefined);
    stubClipboard(writeText);
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });

    fireEvent.click(await within(section).findByRole('button', { name: 'Update now' }));
    expect(await within(section).findByRole('alert')).toHaveTextContent(/local edits overlap/);
    expect(section.textContent).not.toMatch(INSTALLER_COMMAND);
    expect(within(section).getByRole('code')).toHaveTextContent('npm run update');

    fireEvent.click(within(section).getByRole('button', { name: COPY.agent.commandCopy }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('npm run update'));

    fireEvent.click(within(section).getByRole('button', { name: COPY.agent.copy }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    const brief = writeText.mock.calls[1]![0];
    expect(brief).toContain('Run `npm run update` in the running Astrid checkout');
    expect(brief).toMatch(/resolve the refusal it names[\s\S]*without discarding my edits/);
    expect(brief).not.toMatch(INSTALLER_COMMAND);
  });

  it('the Settings section for a required fully-local update copies npm run update, never the installer', async () => {
    localCheckMock.mockResolvedValue({ release: 3, app: 'local', servedRelease: 5, servedApp: 'served', behind: true, resolution: { installedRelease: 3, servedRelease: 5, requiredRelease: 4, requiredReason: 'Security fix', releaseBehind: true } });
    stubFetch();
    const writeText = vi.fn(async (_text: string) => undefined);
    stubClipboard(writeText);
    render(<AstridUpdatesSection isOpen />);
    const section = screen.getByRole('region', { name: 'Updates' });

    expect(await within(section).findByText('This update is required: Security fix')).toBeInTheDocument();
    expect(section.textContent).not.toMatch(INSTALLER_COMMAND);
    expect(within(section).getByRole('code')).toHaveTextContent('npm run update');
    fireEvent.click(within(section).getByRole('button', { name: COPY.agent.commandCopy }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('npm run update'));
  });

  it('the fully-local hard card offers Update now through Settings and copies npm run update', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    stubClipboard(writeText);
    render(<RuntimeConnectionPanel connection={connectionFor({ status: 'update_needed' }, { managedByPinokio: false })} />);

    expect(screen.getByRole('button', { name: 'Update now' })).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(INSTALLER_COMMAND);
    expect(screen.getByRole('code')).toHaveTextContent('npm run update');

    fireEvent.click(screen.getByRole('button', { name: 'Update now' }));
    expect(window.location.search).toContain('settings=updates');

    fireEvent.click(screen.getByRole('button', { name: COPY.agent.commandCopy }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('npm run update'));
  });
});
