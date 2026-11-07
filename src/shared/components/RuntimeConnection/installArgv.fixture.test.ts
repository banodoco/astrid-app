// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetupBlock } from './SetupBlock.tsx';
import { CopyInstallCommand } from './CopyInstallCommand.tsx';
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
  it('matches the real macOS/Linux command builder for every case', () => {
    expect(fixture.version).toBe(1);
    expect(fixture.install_line).toBe(`${ASTRID_COMMANDS.macLinux} -s --`);
    expect(new Set(fixture.cases.map(testCase => testCase.id)).size).toBe(fixture.cases.length);
    for (const testCase of fixture.cases) {
      expect(Object.values(testCase.choices).every(value => value === 'on' || value === 'off')).toBe(true);
      const mode = testCase.id.startsWith('update-') ? 'update' : 'install';
      const command = testCase.id === 'update-legacy-saved-defaults'
        ? installCommand('update')
        : installCommand(mode, builderChoices(testCase.choices), testCase.id.startsWith('settings-'));
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

  it('gives existing-install surfaces no choice flags, and covers every combined setup edit', () => {
    const combinations = Array.from({ length: 16 }, (_, i) => i.toString(2).padStart(4, '0'));
    expect(fixture.cases.filter(testCase => /^(settings|update)-/.test(testCase.id)).map(testCase => testCase.id))
      .toEqual(['update-legacy-saved-defaults']);
    for (const bits of combinations) {
      expect(installCommand('update', builderChoices(Object.fromEntries(
        ['autostart', 'command', 'skills', 'skill_copies'].map((name, i) => [name, bits[i] === '1' ? 'on' : 'off']))), false))
        .toBe(ASTRID_COMMANDS.macLinuxUpdate);
    }
    const combinedBits = combinations.filter(bits => [...bits].filter((bit, i) => bit !== '1110'[i]).length >= 2);
    expect(fixture.cases.filter(testCase => testCase.id.startsWith('combined-')).map(testCase => testCase.id).sort())
      .toEqual(combinedBits.map(bits => `combined-${bits}`).sort());
    for (const testCase of fixture.cases.filter(testCase => /^combined-[01]{4}$/.test(testCase.id))) {
      const bits = testCase.id.slice(-4);
      expect(Object.values(testCase.choices)).toEqual([...bits].map(bit => bit === '1' ? 'on' : 'off'));
    }
  });

  it('shows and saves each combined, Settings, and update selection in SetupBlock', () => {
    const cases = fixture.cases.filter(testCase => /^combined-[01]{4}$/.test(testCase.id));
    for (const testCase of cases) {
      localStorage.clear();
      const mode = testCase.id.startsWith('update-') ? 'update' : 'install';
      const explicitChoices = testCase.id.startsWith('settings-');
      const { unmount } = render(createElement(SetupBlock, { mode, explicitChoices }));
      fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
      const controls = within(screen.getByRole('group', { name: 'Customize Astrid setup' })).getAllByRole('checkbox') as HTMLInputElement[];
      const desired = Object.values(testCase.choices).map(value => value === 'on');
      expect(controls).toHaveLength(desired.length);
      controls.forEach((control, i) => { if (control.checked !== desired[i]) fireEvent.click(control); });
      expect(displayedArgv(), testCase.id).toEqual(testCase.argv);
      expect(fixtureChoices(readPendingSetupState().choices), testCase.id).toEqual(testCase.choices);
      unmount();
    }
  });

  it('shows the legacy update command that preserves existing choices', () => {
    const testCase = fixture.cases.find(candidate => candidate.id === 'update-legacy-saved-defaults')!;
    expect(testCase.argv).toEqual(['--update']);
    render(createElement(CopyInstallCommand, { mode: 'update' }));
    expect(displayedArgv()).toEqual(testCase.argv);
  });

});
