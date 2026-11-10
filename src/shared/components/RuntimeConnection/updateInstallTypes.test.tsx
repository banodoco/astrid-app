// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The App's runtime origin ('' = same-origin, a local App) and whether the install is managed by Pinokio (installType 'pinokio').
const harness = vi.hoisted(() => ({ origin: '', pinokio: false }));
vi.mock('@/integrations/runtime/connection.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/integrations/runtime/connection.ts')>()),
  runtimeOrigin: () => harness.origin,
}));

import { CopyInstallCommand } from './CopyInstallCommand.tsx';
import { installCommand, PINOKIO_UPDATE_INSTRUCTION } from './copy.ts';

const HOSTED_APP = 'https://astrid.test';
const INSTALLER_APP = 'http://127.0.0.1:17340';

beforeEach(() => {
  harness.origin = '';
  harness.pinokio = false;
});

describe('the update command for each install type', () => {
  it('(1) hosted astrid.haus: the installer update line', () => {
    harness.origin = HOSTED_APP;
    render(<CopyInstallCommand mode="update" pinokio={harness.pinokio} />);
    expect(screen.getByText(installCommand('update'), { exact: true })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('npm run update');
  });

  it('(2) installer install: the App reaches the Runtime door, so the installer update line', () => {
    harness.origin = INSTALLER_APP;
    render(<CopyInstallCommand mode="update" pinokio={harness.pinokio} />);
    expect(screen.getByText(installCommand('update'), { exact: true })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('npm run update');
  });

  it('(3) developer checkout running npm: npm run update in the Astrid folder', () => {
    harness.origin = '';
    render(<CopyInstallCommand mode="update" pinokio={harness.pinokio} />);
    expect(screen.getByText('npm run update', { exact: true })).toBeInTheDocument();
  });

  it('(4) Pinokio hosted: the Pinokio instruction, never a shell command', () => {
    harness.origin = HOSTED_APP;
    harness.pinokio = true;
    render(<CopyInstallCommand mode="update" pinokio={harness.pinokio} />);
    expect(screen.getByText(PINOKIO_UPDATE_INSTRUCTION)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/curl|irm |npm run update|--update/);
  });

  it('(5) Pinokio fully local (same-origin, managed by Pinokio): the Pinokio instruction, never npm run update', () => {
    harness.origin = '';
    harness.pinokio = true;
    render(<CopyInstallCommand mode="update" pinokio={harness.pinokio} />);
    expect(screen.getByText(PINOKIO_UPDATE_INSTRUCTION)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/curl|irm |npm run update|--update/);
  });
});
