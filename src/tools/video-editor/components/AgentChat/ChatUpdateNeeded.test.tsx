// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BridgeRouteError } from '@/integrations/astrid/transport.ts';
import { installCommand, RUNTIME_CONNECTION_COPY, withCommandShell } from '@/shared/components/RuntimeConnection/copy.ts';
import { BRIDGE_CONTRACT_VERSION_MISMATCH_CODE } from '@/tools/video-editor/data/bridgeContract.ts';
import { ChatUpdateNeeded, isChatUpdateError } from './ChatUpdateNeeded.tsx';

describe('ChatUpdateNeeded', () => {
  it('renders the update copy, update command affordances, and raw details', () => {
    const detail = 'bridge reported a contract mismatch while sending chat';
    const copy = RUNTIME_CONNECTION_COPY;

    render(<ChatUpdateNeeded detail={detail} />);

    expect(screen.getByText(copy.chatNeedsUpdate)).toBeInTheDocument();
    expect(screen.getByText(copy.updateNeeded.title)).toBeInTheDocument();
    expect(screen.getByText(withCommandShell(copy.updateNeeded.sentence))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.agent.copy })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.agent.commandCopy })).toBeInTheDocument();
    expect(screen.getByText(installCommand('update'), { exact: true })).toBeInTheDocument();

    const details = screen.getByText('Details').closest('details');
    expect(details).not.toBeNull();
    expect(within(details as HTMLDetailsElement).getByText(detail)).toBeInTheDocument();
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
