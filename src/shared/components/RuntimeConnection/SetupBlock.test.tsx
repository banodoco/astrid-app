// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SetupBlock } from './SetupBlock.tsx';
import { installCommand } from './copy.ts';

afterEach(() => localStorage.clear());

it('shows the recommended setup, an editable remembered checkbox, and hides Customize when checked', () => {
  render(<SetupBlock initiallySetUp />);
  expect(screen.getByRole('checkbox', { name: "I've already set up Astrid" })).toBeChecked();
  expect(screen.getByText('Start Astrid')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Customize' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox', { name: "I've already set up Astrid" }));
  expect(screen.getByRole('checkbox', { name: "I've already set up Astrid" })).not.toBeChecked();
  expect(screen.getByText('Recommended setup')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Customize' })).toBeInTheDocument();
});

it('customizes choices and shows flags in the frozen order after --yes', () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh');
  render(<SetupBlock />);
  expect(screen.getByRole('code')).toHaveTextContent('curl -fsSL https://astrid.haus/install | sh -s -- --yes');
  fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Start Astrid at sign-in' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Install skills for coding agents' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Use copies for skills' }));
  expect(screen.getByRole('code')).toHaveTextContent('--yes --autostart off --skills off --skill-copies on');
});

it('Settings Setup on an existing install sends no choice flags', () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh');
  render(<SetupBlock explicitChoices />);
  expect(screen.getByRole('code')).toHaveTextContent(/sh -s -- --update$/);
  expect(screen.getByRole('code').textContent).not.toMatch(/--(autostart|command|skills|skill-copies)/);
});

it('keeps changed choices and checked state when Welcome hands off to a new setup surface', () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh');
  const first = render(<SetupBlock />);
  fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Start Astrid at sign-in' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Add the `astrid` terminal command' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Install skills for coding agents' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Use copies for skills' }));
  const command = screen.getByRole('code').textContent;
  expect(command).toContain('--yes --autostart off --command off --skills off --skill-copies on');
  fireEvent.click(screen.getByRole('checkbox', { name: "I've already set up Astrid" }));
  // Set up already: the plain line, with no choice flags (871bb95), not the fresh command that carried the choices.
  expect(command).toContain('--yes --autostart off --command off --skills off --skill-copies on');
  expect(screen.getByRole('code').textContent).toBe(installCommand('install', undefined, false, false, true));
  expect(screen.queryByRole('button', { name: 'Customize' })).not.toBeInTheDocument();

  first.unmount();
  render(<SetupBlock initiallySetUp={false} />);
  expect(screen.getByRole('checkbox', { name: "I've already set up Astrid" })).toBeChecked();
  expect(screen.queryByRole('button', { name: 'Customize' })).not.toBeInTheDocument();
  // Checked as already set up: the plain line, not the fresh command the choices built (871bb95).
  expect(screen.getByRole('code').textContent).toBe(installCommand('install', undefined, false, false, true));
});

it('gives an update no choice controls: the Agent keeps the saved policy', () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh');
  render(<SetupBlock mode="update" />);
  expect(screen.queryByRole('button', { name: 'Customize' })).not.toBeInTheDocument();
  expect(screen.getByRole('code')).toHaveTextContent(/sh -s -- --update$/);
});

it.each([false, true])('a set-up install with stale saved autostart=%s sends the plain install line, no choice flags', (autostart) => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh');
  localStorage.setItem('astrid:pending-setup-v1', JSON.stringify({
    alreadySetUp: true,
    choices: { autostart, command: true, skills: true, skillCopies: false },
  }));
  render(<SetupBlock />);
  expect(screen.getByText('Start Astrid')).toBeInTheDocument();
  expect(screen.getByRole('code').textContent).toBe('curl -fsSL https://astrid.haus/install | sh');
});
