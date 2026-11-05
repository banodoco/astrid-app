// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PreferencesSection } from './PreferencesSection';

vi.mock('@/shared/components/TimeOfDay/TimeOfDayControl', () => ({ TimeOfDayControl: () => <div /> }));

describe('PreferencesSection Replay tour', () => {
  it('renders Replay tour as the last item and calls the handler on click', () => {
    const onReplayTour = vi.fn();
    const { container } = render(<PreferencesSection onReplayTour={onReplayTour} />);
    const button = screen.getByRole('button', { name: 'Replay tour' });
    const buttons = container.querySelectorAll('button');
    expect(buttons[buttons.length - 1]).toBe(button);
    fireEvent.click(button);
    expect(onReplayTour).toHaveBeenCalledOnce();
  });

  it('is absent without a handler', () => {
    render(<PreferencesSection />);
    expect(screen.queryByRole('button', { name: 'Replay tour' })).toBeNull();
  });
});

describe('PreferencesSection layout', () => {
  it('titles Appearance and Tour like every other Settings section', () => {
    render(<PreferencesSection onReplayTour={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Appearance' })).toHaveTextContent('Brightness');
    expect(screen.getByRole('region', { name: 'Tour' })).toContainElement(screen.getByRole('button', { name: 'Replay tour' }));
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(['Appearance', 'Tour']);
  });
});
