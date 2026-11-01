// @vitest-environment jsdom

import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BulkClipPanelBody, type BulkClipPanelProps } from './BulkClipPanelBody.tsx';
import { NO_TRANSITION } from './clip-panel-primitives.tsx';

vi.mock('@/shared/components/ui/select.tsx', async () => {
  const { createContext, useContext } = await vi.importActual<typeof import('react')>('react');
  const SelectValueContext = createContext<string | null>(null);

  return {
    Select: ({ value, onValueChange, children }: {
      value: string;
      onValueChange: (value: string) => void;
      children?: ReactNode;
    }) => (
      <SelectValueContext.Provider value={value}>
        <select value={value} onChange={(event) => onValueChange(event.currentTarget.value)}>
          <option value="__none__">None</option>
          <option value="crossfade">crossfade</option>
        </select>
        {children}
      </SelectValueContext.Provider>
    ),
    SelectTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    SelectContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    SelectItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    SelectValue: ({ children, placeholder }: { children?: ReactNode; placeholder?: string }) => {
      const value = useContext(SelectValueContext);
      return <span data-testid="bulk-transition-value">{children ?? value ?? placeholder}</span>;
    },
  };
});

vi.mock('@/shared/components/ui/tabs.tsx', () => ({
  Tabs: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
  TabsContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

function bulkProps(
  onChangeDeep: BulkClipPanelProps['onChangeDeep'],
  sharedTransitionType: string | null = NO_TRANSITION,
): BulkClipPanelProps & {
  effectResources: never;
} {
  return {
    clips: [{} as never],
    visibleTabs: ['effects'],
    compositionWidth: 1920,
    compositionHeight: 1080,
    sharedEntrance: null,
    sharedExit: null,
    sharedContinuous: null,
    sharedText: null,
    sharedTransition: null,
    sharedEntranceType: null,
    sharedExitType: null,
    sharedContinuousType: null,
    sharedTransitionType,
    sharedSpeed: null,
    sharedFrom: null,
    sharedTo: null,
    sharedX: null,
    sharedY: null,
    sharedWidth: null,
    sharedHeight: null,
    sharedOpacity: null,
    sharedVolume: null,
    sharedFontSize: null,
    sharedTextColor: null,
    sharedTransitionDuration: null,
    onChange: vi.fn(),
    onChangeDeep,
    onResetPosition: vi.fn(),
    onToggleMute: vi.fn(),
    onClose: vi.fn(),
    activeTab: 'effects',
    setActiveTab: vi.fn(),
    effectResources: {
      data: { entrance: [], exit: [], continuous: [] },
      effects: [],
      entrance: [],
      exit: [],
      continuous: [],
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: vi.fn(async () => undefined),
      canCreateEffect: false,
      canUpdateEffect: false,
      canDeleteEffect: false,
    } as never,
  };
}

describe('BulkClipPanelBody transition selector', () => {
  it('renders None for the native sentinel and preserves the existing clear action', () => {
    const onChangeDeep = vi.fn();
    render(<BulkClipPanelBody {...bulkProps(onChangeDeep)} />);

    const section = screen.getByText('Transition').parentElement!;
    expect(within(section).getByRole('combobox')).toHaveValue(NO_TRANSITION);
    expect(within(section).getByTestId('bulk-transition-value')).toHaveTextContent('None');
    expect(within(section).getByTestId('bulk-transition-value')).not.toHaveTextContent(NO_TRANSITION);

    fireEvent.change(within(section).getByRole('combobox'), { target: { value: NO_TRANSITION } });
    expect(onChangeDeep).toHaveBeenCalledTimes(1);
    expect(onChangeDeep.mock.calls[0][0]({ transition: { type: 'crossfade', duration: 0.5 } })).toEqual({
      transition: undefined,
    });
  });

  it('keeps the current transition label unchanged for non-sentinel choices', () => {
    render(<BulkClipPanelBody {...bulkProps(vi.fn(), 'crossfade')} />);

    const section = screen.getByText('Transition').parentElement!;
    expect(within(section).getByTestId('bulk-transition-value')).toHaveTextContent('crossfade');
    expect(within(section).getByTestId('bulk-transition-value')).not.toHaveTextContent(NO_TRANSITION);
  });
});
