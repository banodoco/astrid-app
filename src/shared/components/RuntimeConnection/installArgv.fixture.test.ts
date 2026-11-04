// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetupBlock } from './SetupBlock.tsx';
import { ASTRID_COMMANDS, installCommand, readPendingSetupState, type SetupChoices } from './copy.ts';
import fixture from './installArgv.fixture.json';

beforeEach(() => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh');
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function fixtureChoices(choices: SetupChoices) {
  return {
    autostart: choices.autostart ? 'on' : 'off',
    command: choices.command ? 'on' : 'off',
    skills: choices.skills ? 'on' : 'off',
    skill_copies: choices.skillCopies ? 'on' : 'off',
  };
}

function builderChoices(choices: typeof fixture.cases[number]['choices']): SetupChoices {
  return {
    autostart: choices.autostart === 'on',
    command: choices.command === 'on',
    skills: choices.skills === 'on',
    skillCopies: choices.skill_copies === 'on',
  };
}

function displayedArgv() {
  const command = screen.getByRole('code').textContent;
  expect(command).toMatch(new RegExp(`^${fixture.install_line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `));
  return command!.slice(fixture.install_line.length + 1).split(' ');
}

describe('shared installer argv fixture', () => {
  it('matches the real macOS/Linux install builder for every saved choice', () => {
    expect(fixture.version).toBe(1);
    expect(fixture.install_line).toBe(`${ASTRID_COMMANDS.macLinux} -s --`);
    expect(new Set(fixture.cases.map(testCase => testCase.id)).size).toBe(fixture.cases.length);
    for (const testCase of fixture.cases) {
      expect(Object.values(testCase.choices).every(value => value === 'on' || value === 'off')).toBe(true);
      const command = installCommand('install', builderChoices(testCase.choices));
      expect(command).toBe([fixture.install_line, ...testCase.argv].join(' '));
    }
  });

  it('covers exactly the Customize controls, each changed alone from the default', () => {
    render(createElement(SetupBlock));
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
    const controls = within(screen.getByRole('group', { name: 'Customize Astrid setup' })).getAllByRole('checkbox');
    const actualIds: string[] = [];
    for (const control of controls) {
      fireEvent.click(control);
      const argv = displayedArgv();
      expect(argv).toHaveLength(3);
      const id = `edit-${argv[1].replace(/^--/, '')}-${argv[2]}`;
      actualIds.push(id);
      const testCase = fixture.cases.find(candidate => candidate.id === id);
      expect(testCase, `missing fixture case for ${id}`).toBeDefined();
      expect(argv).toEqual(testCase!.argv);
      expect(fixtureChoices(readPendingSetupState().choices)).toEqual(testCase!.choices);
      fireEvent.click(control);
    }
    expect(actualIds.sort()).toEqual(fixture.cases.filter(testCase => testCase.id.startsWith('edit-')).map(testCase => testCase.id).sort());
  });

  it('uses only --yes for untouched and already-set-up defaults', () => {
    render(createElement(SetupBlock));
    const untouched = fixture.cases.find(testCase => testCase.id === 'untouched')!;
    const alreadySetUp = fixture.cases.find(testCase => testCase.id === 'already-set-up')!;
    expect(untouched.argv).toEqual(['--yes']);
    expect(alreadySetUp.argv).toEqual(['--yes']);
    expect(displayedArgv()).toEqual(untouched.argv);
    expect(fixtureChoices(readPendingSetupState().choices)).toEqual(untouched.choices);
    fireEvent.click(screen.getByRole('checkbox', { name: "I've already set up Astrid" }));
    expect(screen.getByText('Start Astrid')).toBeInTheDocument();
    expect(displayedArgv()).toEqual(alreadySetUp.argv);
    expect(fixtureChoices(readPendingSetupState().choices)).toEqual(alreadySetUp.choices);
  });
});
