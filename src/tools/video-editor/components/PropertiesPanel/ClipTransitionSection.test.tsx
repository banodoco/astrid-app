// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { ClipTransitionSection } from './ClipTransitionSection.tsx';

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
          <option value="custom-transition">custom-transition</option>
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

it('authors the built-in crossfade with the canonical transition id', () => {
  const onChange = vi.fn();
  render(<ClipTransitionSection clip={{} as never} onChange={onChange} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'crossfade' } });
  expect(onChange).toHaveBeenCalledWith({ transition: { type: 'cross-fade', duration: 0.5, params: undefined } });
});

it('opens a legacy transition unchanged and canonicalizes a later duration edit', () => {
  const onChange = vi.fn();
  const transition = { type: 'crossfade', duration: 0.5 };
  render(<ClipTransitionSection clip={{ transition } as never} onChange={onChange} />);
  expect(onChange).not.toHaveBeenCalled();
  expect(transition.type).toBe('crossfade');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '0.75' } });
  fireEvent.blur(screen.getByRole('textbox'));
  expect(onChange).toHaveBeenCalledWith({ transition: { type: 'cross-fade', duration: 0.75 } });
});

it('preserves unrelated transition ids on selection', () => {
  const onChange = vi.fn();
  render(<ClipTransitionSection clip={{} as never} onChange={onChange} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'custom-transition' } });
  expect(onChange).toHaveBeenCalledWith({ transition: { type: 'custom-transition', duration: 0.5, params: undefined } });
});
