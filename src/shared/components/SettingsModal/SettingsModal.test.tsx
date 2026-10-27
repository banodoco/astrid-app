// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_DIGEST } from '@/integrations/runtime/generated-contract-metadata.ts';
import { RUNTIME_CONNECTION_COPY as COPY, withBrowser } from '@/shared/components/RuntimeConnection/copy.ts';
import { ASTRID_STATUS_COPY as STATUS_COPY } from './sections/astridStatusCopy.ts';

const { connectionMock, readStatusMock } = vi.hoisted(() => ({
  connectionMock: { value: null as unknown },
  readStatusMock: vi.fn(),
}));

vi.mock('@/integrations/runtime/RuntimeConnectionProvider.tsx', () => ({
  useRuntimeConnection: () => connectionMock.value,
}));
vi.mock('@/integrations/runtime/client.ts', () => ({
  AstridRuntimeClient: class {
    readStatus = readStatusMock;
  },
}));
vi.mock('@/shared/hooks/mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/shared/hooks/useModal', () => ({
  useLargeModal: () => ({
    className: '', style: {}, isMobile: false, headerClass: '', scrollClass: '', footerClass: '',
  }),
}));
vi.mock('@/shared/hooks/useScrollFade', () => ({ useScrollFade: () => ({ showFade: false, scrollRef: { current: null } }) }));
vi.mock('./sections/PreferencesSection', () => ({ PreferencesSection: () => <div>Preferences</div> }));

import { SettingsModal } from './SettingsModal';

type Status = 'connected' | 'connecting' | 'needs_permission' | 'blocked' | 'not_running' | 'refused' | 'update_needed';

function connection(status: Status, overrides: Record<string, unknown> = {}) {
  const state = status === 'connected'
    ? { status, realm: { realm_id: 'realm-1', display_name: 'My Studio' } }
    : { status };
  return {
    gated: true,
    state,
    isConnected: status === 'connected',
    connectedBefore: true,
    isBooting: false,
    isChecking: false,
    realmName: status === 'connected' ? 'My Studio' : null,
    schemaDigest: status === 'connected' ? SCHEMA_DIGEST : null,
    connect: vi.fn(),
    ...overrides,
  };
}

function renderSettings() {
  render(
    <SettingsModal
      isOpen
      onOpenChange={vi.fn()}
    />,
  );
  const section = screen.getByRole('region', { name: STATUS_COPY.title });
  expect(screen.getAllByRole('region')[0]).toHaveAccessibleName('Updates');
  expect(screen.getByText('No update has run yet.')).toBeInTheDocument();
  expect(screen.getByText('No update log yet.')).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Connection' })).toBeNull();
  return section;
}

beforeEach(() => {
  connectionMock.value = connection('connected');
  readStatusMock.mockReset().mockResolvedValue({
    health: { status: 'ok', protocol: 'workspace.v1', schema_digest: SCHEMA_DIGEST, services: [] },
    realm: { realm_id: 'realm-1', display_name: 'My Studio', version: 1, created_at: '2026-01-01T00:00:00Z' },
  });
});

describe('SettingsModal Astrid status', () => {
  it('says it is connected, names the workspace and shows the Runtime and Workspace marks only', async () => {
    const section = renderSettings();

    fireEvent.click(await within(section).findByRole('button', { name: 'Details' }));
    expect(await within(section).findByText('My Studio')).toBeInTheDocument();
    expect(within(section).getByRole('status')).toHaveTextContent(STATUS_COPY.connected);
    expect(within(section).getByText(STATUS_COPY.workspaceName).closest('div')).toHaveTextContent('My Studio');
    expect(within(section).getByText('Runtime')).toHaveAttribute('data-state', 'pass');
    expect(section.querySelector('[data-check="workspace"]')).toHaveAttribute('data-state', 'pass');
    expect(readStatusMock).toHaveBeenCalledTimes(2);
    expect(within(section).queryByText('Tools')).toBeNull();
    expect(within(section).queryByText(COPY.updateNeeded.title)).toBeNull();
  });

  it('leads with the update when Astrid on this computer speaks another schema', () => {
    connectionMock.value = connection('update_needed');
    const section = renderSettings();

    expect(within(section).getByRole('status')).toHaveTextContent(STATUS_COPY.updateNeeded);
    expect(within(section).getByText(COPY.updateNeeded.sentence)).toBeTruthy();
    expect(within(section).queryByText(STATUS_COPY.connected)).toBeNull();
    expect(readStatusMock).not.toHaveBeenCalled();
  });

  it('says Astrid is running but refused this page, while the marks keep looking', () => {
    connectionMock.value = connection('refused');
    const section = renderSettings();

    expect(within(section).getByRole('status')).toHaveTextContent(STATUS_COPY.refused);
    expect(STATUS_COPY.refused).toBe('Running, but refused this page');
    expect(within(section).queryByText(STATUS_COPY.notRunning)).toBeNull();
    expect(readStatusMock).not.toHaveBeenCalled();
  });

  it('gives the not-running step while the marks keep looking', () => {
    connectionMock.value = connection('not_running');
    const section = renderSettings();

    expect(within(section).getByRole('status')).toHaveTextContent(STATUS_COPY.notRunning);
    expect(within(section).getByText(COPY.notRunning.sentence)).toBeTruthy();
    for (const name of ['Runtime', 'Workspace']) {
      expect(within(section).getByText(name)).toHaveAttribute('data-state', 'checking');
    }
    expect(readStatusMock).not.toHaveBeenCalled();
  });

  it('offers Connect while the browser has not been asked, and nothing else checks then', () => {
    const value = connection('needs_permission');
    connectionMock.value = value;
    const section = renderSettings();

    expect(within(section).getByRole('status')).toHaveTextContent(COPY.permission.title);
    expect(within(section).getByText(withBrowser(COPY.permission.sentence))).toBeInTheDocument();
    expect(within(section).queryByText('Runtime')).toBeNull();
    fireEvent.click(within(section).getByRole('button', { name: COPY.permission.connect }));
    expect(value.connect).toHaveBeenCalledTimes(1);
    expect(readStatusMock).not.toHaveBeenCalled();
  });

  it('gives the browser steps when it blocks this page', () => {
    connectionMock.value = connection('blocked');
    const section = renderSettings();

    expect(within(section).getByRole('status')).toHaveTextContent(STATUS_COPY.blocked);
    expect(within(section).getByText(COPY.blocked.steps.join(' '))).toBeTruthy();
    expect(within(section).queryByRole('button')).toBeNull();
    expect(readStatusMock).not.toHaveBeenCalled();
  });
});
