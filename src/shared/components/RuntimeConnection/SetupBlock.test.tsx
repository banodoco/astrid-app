// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SetupBlock } from './SetupBlock.tsx';

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

it('Settings can turn saved off choices back on with explicit values', () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh');
  render(<SetupBlock explicitChoices />);
  expect(screen.getByRole('code')).toHaveTextContent('--yes --autostart on --command on --skills on --skill-copies off');
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
  expect(screen.getByRole('code').textContent).toBe(command);
  expect(screen.queryByRole('button', { name: 'Customize' })).not.toBeInTheDocument();

  first.unmount();
  render(<SetupBlock initiallySetUp={false} />);
  expect(screen.getByRole('checkbox', { name: "I've already set up Astrid" })).toBeChecked();
  expect(screen.queryByRole('button', { name: 'Customize' })).not.toBeInTheDocument();
  expect(screen.getByRole('code').textContent).toBe(command);
});

it('uses the same choices-aware update command and agent handoff', () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh');
  render(<SetupBlock mode="update" />);
  expect(screen.getByRole('button', { name: 'Customize' })).toBeInTheDocument();
  expect(screen.getByRole('code')).toHaveTextContent('--yes --update');
  fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Install skills for coding agents' }));
  expect(screen.getByRole('code')).toHaveTextContent('--yes --update --skills off');
});
