// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeRouteError } from '@/integrations/astrid/transport.ts';
import { RUNTIME_CONNECTION_COPY, withCommandShell } from '@/shared/components/RuntimeConnection/copy.ts';
import { BRIDGE_CONTRACT_VERSION_MISMATCH_CODE } from '@/tools/video-editor/data/bridgeContract.ts';

const { connectionRef } = vi.hoisted(() => ({ connectionRef: { current: null as { managedByPinokio: boolean } | null } }));
vi.mock('@/integrations/runtime/RuntimeConnectionProvider.tsx', () => ({ useRuntimeConnectionSafe: () => connectionRef.current }));

import { ChatUpdateNeeded, isChatUpdateError } from './ChatUpdateNeeded.tsx';

afterEach(() => { connectionRef.current = null; });

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('ChatUpdateNeeded', () => {
  it('renders the shared update title and sentence with one See updates action and the raw details', () => {
    const detail = 'bridge reported a contract mismatch while sending chat';
    const copy = RUNTIME_CONNECTION_COPY;

    render(<ChatUpdateNeeded detail={detail} />);

    expect(screen.getByText(copy.chatNeedsUpdate)).toBeInTheDocument();
    expect(screen.getByText(copy.updateNeeded.title)).toBeInTheDocument();
    expect(screen.getByText(withCommandShell(copy.updateNeeded.sentence))).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'See updates' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy instructions for your agent' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.agent.commandCopy })).not.toBeInTheDocument();
    expect(screen.queryByRole('code')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Customize' })).not.toBeInTheDocument();

    const details = screen.getByText('Details').closest('details');
    expect(details).not.toBeNull();
    expect(within(details as HTMLDetailsElement).getByText(detail)).toBeInTheDocument();
  });

  it('opens Settings on Updates when See updates is pressed', () => {
    render(<ChatUpdateNeeded detail="mismatch" />);

    fireEvent.click(screen.getByRole('button', { name: 'See updates' }));

    expect(new URL(window.location.href).searchParams.get('settings')).toBe('updates');
  });

  it('gives a Pinokio Astrid Pinokio’s sentence and the same See updates action', () => {
    connectionRef.current = { managedByPinokio: true };
    render(<ChatUpdateNeeded detail="mismatch" />);

    expect(screen.getByText(RUNTIME_CONNECTION_COPY.updateNeeded.pinokioSentence)).toBeInTheDocument();
    expect(screen.queryByText(withCommandShell(RUNTIME_CONNECTION_COPY.updateNeeded.sentence))).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'See updates' })).toBeInTheDocument();
    expect(screen.queryByRole('code')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: RUNTIME_CONNECTION_COPY.agent.copy })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/install\s*\|\s*sh|install\.ps1/);
  });
});

describe('isChatUpdateError', () => {
  it('classifies a matching version-mismatch BridgeRouteError as an update error', () => {
    const error = new BridgeRouteError('chat', 409, {
      error: BRIDGE_CONTRACT_VERSION_MISMATCH_CODE,
      detail: 'bridge protocol version differs',
    });

    expect(isChatUpdateError(error)).toBe(true);
  });

  it('does not classify an unrelated BridgeRouteError as an update error', () => {
    const error = new BridgeRouteError('chat', 409, {
      error: 'timeline_version_conflict',
      detail: 'the timeline changed elsewhere',
    });

    expect(isChatUpdateError(error)).toBe(false);
  });

  it.each([
    ['a non-Error value', 'bridge_contract_version_mismatch'],
    ['a plain object with the matching code', { code: BRIDGE_CONTRACT_VERSION_MISMATCH_CODE }],
    ['a named BridgeRouteError-shaped object', { name: 'BridgeRouteError', code: BRIDGE_CONTRACT_VERSION_MISMATCH_CODE }],
    ['an Error with the matching code but the wrong class', Object.assign(new Error('forged route error'), { code: BRIDGE_CONTRACT_VERSION_MISMATCH_CODE })],
    ['null', null],
    ['undefined', undefined],
  ] as const)('does not classify %s as an update error', (_description, value) => {
    expect(isChatUpdateError(value)).toBe(false);
  });
});
