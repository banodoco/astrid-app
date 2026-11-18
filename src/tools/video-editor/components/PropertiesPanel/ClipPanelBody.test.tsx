// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ClipPanelBody, type ClipPanelBodyProps } from './ClipPanelBody.tsx';

vi.mock('./ClipEffectsTab.tsx', () => ({
  ClipEffectsTab: ({ hasActiveAstridElementParams }: { hasActiveAstridElementParams?: boolean }) => (
    <div data-testid="effects-astrid-form-state">{String(Boolean(hasActiveAstridElementParams))}</div>
  ),
}));

function bodyProps(hasActiveAstridElementParams?: boolean): ClipPanelBodyProps {
  return {
    readOnly: false,
    clip: { id: 'clip-1', clipType: 'media', at: 0, track: 'V1' },
    track: { id: 'V1', kind: 'visual', label: 'Video 1' },
    deviceClass: 'desktop',
    interactionMode: 'move',
    hasPredecessor: false,
    onChange: () => undefined,
    onResetPosition: () => undefined,
    onClose: () => undefined,
    onToggleMute: () => undefined,
    onSplitAtPlayhead: () => undefined,
    onMoveTrackUp: () => undefined,
    onMoveTrackDown: () => undefined,
    onSetInteractionMode: () => undefined,
    compositionWidth: 1920,
    compositionHeight: 1080,
    registry: {},
    activeTab: 'effects',
    setActiveTab: () => undefined,
    effectResources: { canCreateEffect: false, canUpdateEffect: false, effects: [] },
    hasActiveAstridElementParams,
  } as unknown as ClipPanelBodyProps;
}

describe('ClipPanelBody Astrid form ownership', () => {
  it('uses the resolved human-readable clip label in the Inspector header', () => {
    render(<ClipPanelBody {...bodyProps()} clip={{
      id: 'clip-1',
      clipType: 'media',
      at: 0,
      track: 'V1',
      asset: 'asset-1',
      label: 'first take.mp4',
      assetEntry: { file: '/opaque-asset-id', src: '/opaque-asset-id', type: 'video/mp4' },
    }} />);
    expect(screen.getByText('first take.mp4')).toBeInTheDocument();
    expect(screen.queryByText('asset-1')).not.toBeInTheDocument();
  });

  it('forwards active form ownership to the effects tab', () => {
    render(<ClipPanelBody {...bodyProps(true)} />);
    expect(screen.getByTestId('effects-astrid-form-state').textContent).toBe('true');
  });

  it('keeps the legacy effects state when no active form owns it', () => {
    render(<ClipPanelBody {...bodyProps()} />);
    expect(screen.getByTestId('effects-astrid-form-state').textContent).toBe('false');
  });
});

describe('ClipPanelBody timing value commits', () => {
  it.each([
    ['Speed', 2, { speed: 2 }],
    ['Source In', 1, { from: 1 }],
  ] as const)('reapplies %s if the controlled clip value resets before blur', (label, value, expectedPatch) => {
    const onChange = vi.fn();
    const initialClip = { id: 'clip-1', clipType: 'media', at: 0, track: 'V1', from: 0, to: 5, speed: 1 };
    const props = {
      ...bodyProps(),
      clip: initialClip,
      activeTab: 'timing' as const,
      onChange,
    };
    const { rerender } = render(<ClipPanelBody {...props} />);
    const input = screen.getByText(label).parentElement?.querySelector('input');
    expect(input).not.toBeNull();

    input!.focus();
    expect(document.activeElement).toBe(input);
    fireEvent.change(input!, { target: { value: String(value) } });
    expect(onChange).toHaveBeenLastCalledWith(expectedPatch);

    // The timeline first adopts the edit, then an external refresh restores the
    // old controlled clip while Base UI still preserves the typed text.
    rerender(<ClipPanelBody {...props} clip={{ ...initialClip, ...expectedPatch }} />);
    expect(document.activeElement).toBe(input);
    rerender(<ClipPanelBody {...props} />);
    expect(document.activeElement).toBe(input);
    fireEvent.blur(input!);

    expect(onChange).toHaveBeenLastCalledWith(expectedPatch);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe('ClipPanelBody media duration', () => {
  it('shows the played length and edits the source out, clamped to the media length', () => {
    const onChange = vi.fn();
    // Source 1s to 4s at 2x plays for 1.5s; the 6s video caps the source out.
    const clip = {
      id: 'clip-1',
      clipType: 'media',
      at: 0,
      track: 'V1',
      from: 1,
      to: 4,
      speed: 2,
      assetEntry: { file: 'clip.mp4', type: 'video/mp4', duration: 6 },
    };
    render(<ClipPanelBody {...bodyProps()} clip={clip} activeTab="timing" onChange={onChange} />);

    const input = screen.getByText('Duration (seconds)').parentElement?.querySelector('input');
    expect(input).not.toBeNull();
    expect(input!.value).toBe('1.5');

    fireEvent.change(input!, { target: { value: '2' } });
    expect(onChange).toHaveBeenLastCalledWith({ to: 5 });

    fireEvent.change(input!, { target: { value: '10' } });
    expect(onChange).toHaveBeenLastCalledWith({ to: 6 });
  });
});


describe('ClipPanelBody touch Inspector', () => {
  it.each(['phone', 'tablet'] as const)('leads with the existing action grid before property tabs on %s', (deviceClass) => {
    const onSetInteractionMode = vi.fn();
    const setActiveTab = vi.fn();
    render(<ClipPanelBody {...bodyProps()} deviceClass={deviceClass} onSetInteractionMode={onSetInteractionMode} setActiveTab={setActiveTab} />);
    const actions = screen.getByRole('group', { name: 'Clip actions' });
    const tabs = screen.getByRole('tablist');
    expect(actions.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    expect(onSetInteractionMode).toHaveBeenCalledWith('move');
    expect(setActiveTab).toHaveBeenCalledWith('timing');
    fireEvent.click(screen.getByRole('button', { name: 'Trim' }));
    expect(onSetInteractionMode).toHaveBeenCalledWith('trim');
  });

  it('says how to reach the Inspector on touch with no clip selected', () => {
    render(<ClipPanelBody {...bodyProps()} deviceClass="phone" clip={null} />);
    expect(screen.getByText("Tap a clip, or a track's name, to edit it.")).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Clip actions' })).toBeNull();
  });
});

describe('clip media placement controls', () => {
  it('shows inherited fit and changes fit and crop independently', () => {
    const onChange = vi.fn();
    const clip = {id: 'clip-fit', clipType: 'media', at: 0, track: 'V1', asset: 'a', cropLeft: 0.2,
      assetEntry: {id: 'a', file: 'a', src: '/a', type: 'image/png', resolution: '1920x800'}};
    render(<ClipPanelBody {...bodyProps()} activeTab="position" clip={clip} track={{id: 'V1', kind: 'visual', label: 'V1', fit: 'cover'}} onChange={onChange} />);
    expect(screen.getByText('Fill (track)')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Fit'), {target: {value: 'contain'}});
    expect(onChange).toHaveBeenLastCalledWith({fit: 'contain'});
    const crop = screen.getByText('Left').querySelector('input');
    expect(crop).not.toBeNull();
    fireEvent.change(crop!, {target: {value: '0.3'}});
    expect(onChange).toHaveBeenLastCalledWith({cropLeft: 0.3});
    fireEvent.change(screen.getByLabelText('Fit'), {target: {value: ''}});
    expect(onChange).toHaveBeenLastCalledWith({fit: undefined});
  });
});


it('disables fit and crop controls in read-only mode', () => {
  const onChange = vi.fn();
  const clip = {id: 'clip-fit', clipType: 'media', at: 0, track: 'V1', asset: 'a', assetEntry: {id: 'a', file: 'a', src: '/a', type: 'image/png', resolution: '1920x800'}};
  render(<ClipPanelBody {...bodyProps()} readOnly activeTab="position" clip={clip} track={{id: 'V1', kind: 'visual', label: 'V1', fit: 'cover'}} onChange={onChange} />);
  expect(screen.getByLabelText('Fit')).toBeDisabled();
  const crop = screen.getByText('Left').querySelector('input');
  expect(crop).toBeDisabled();
  fireEvent.change(crop!, {target: {value: '0.3'}});
  expect(onChange).not.toHaveBeenCalled();
});
