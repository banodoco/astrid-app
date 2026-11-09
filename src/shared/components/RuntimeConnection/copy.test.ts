import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentInstructions, ASTRID_COMMANDS, describeFailure, DIAGNOSTICS_FALLBACK_COPY, healthCheckCommand, installCommand, localSetupInstructions, localSetupSteps, LOCAL_SETUP, refusedAgentInstructions, RUNTIME_CONNECTION_COPY, withOrigin, RECOMMENDED_SETUP_CHOICES } from './copy.ts';

afterEach(() => vi.restoreAllMocks());

describe('install commands', () => {
  it('uses the shared install command in the setup block and not a second local setup line', () => {
    expect(installCommand('install')).toBe('curl -fsSL https://astrid.haus/install | sh -s -- --yes');
    expect(localSetupSteps().some(step => step.command === ASTRID_COMMANDS.macLinux)).toBe(false);
  });

  it.each([
    ['MacIntel', 'Macintosh', 'install', 'curl -fsSL https://astrid.haus/install | sh -s -- --yes'],
    ['Linux x86_64', 'Linux', 'install', 'curl -fsSL https://astrid.haus/install | sh -s -- --yes'],
    ['Win32', 'Windows', 'install', '& ([scriptblock]::Create((irm https://astrid.haus/install.ps1))) --yes'],
    ['MacIntel', 'Macintosh', 'update', 'curl -fsSL https://astrid.haus/install | sh -s -- --update'],
    ['Linux x86_64', 'Linux', 'update', 'curl -fsSL https://astrid.haus/install | sh -s -- --update'],
    ['Win32', 'Windows', 'update', '& ([scriptblock]::Create((irm https://astrid.haus/install.ps1))) --update'],
  ] as const)('%s %s %s command', (platform, os, mode, expected) => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(os);
    expect(installCommand(mode)).toBe(expected);
  });

  it('puts only changed choices after --yes; an existing install (Settings) gets no choice flags', () => {
    const choices = { ...RECOMMENDED_SETUP_CHOICES, autostart: false, skills: false, skillCopies: true };
    expect(installCommand('install', choices)).toBe('curl -fsSL https://astrid.haus/install | sh -s -- --yes --autostart off --skills off --skill-copies on');
    expect(installCommand('install', choices, true)).toBe('curl -fsSL https://astrid.haus/install | sh -s -- --update');
  });

  it('sends updates as the plain command: the Agent applies the saved policy', () => {
    const choices = { ...RECOMMENDED_SETUP_CHOICES, autostart: false, skills: false, skillCopies: true };
    expect(installCommand('update', choices)).toBe('curl -fsSL https://astrid.haus/install | sh -s -- --update');
    const brief = agentInstructions('update', 'https://astrid.haus', false, undefined, { choices });
    expect(brief).toContain(installCommand('update', choices));
    expect(brief).not.toContain('May I update Astrid');
    expect(agentInstructions('update', 'https://astrid.haus', false, undefined, { choices, alreadySetup: true }))
      .not.toContain('May I update Astrid');
  });

  it('briefs a repair with the plain install line, never --update', () => {
    const brief = agentInstructions('update', 'https://astrid.haus', false, undefined, { repair: true });
    expect(brief).toContain('repair my existing Astrid installation');
    expect(brief).toContain(ASTRID_COMMANDS.macLinux);
    expect(brief).not.toContain('--update');
    expect(brief).not.toContain('May I install Astrid');
  });
});

describe('setup consent wording', () => {
  it('asks once for setup with the selected choices and the same runnable command', () => {
    const choices = { ...RECOMMENDED_SETUP_CHOICES, autostart: false, skills: false };
    const text = agentInstructions('install', 'https://astrid.haus', false, undefined, { choices });
    expect(text).toContain('May I install Astrid with these setup choices?');
    expect(text).toContain('Setup choices: start at sign-in off · `astrid` terminal command on · coding-agent skills off · skill copies off.');
    expect(text).toContain('curl -fsSL https://astrid.haus/install | sh -s -- --yes --autostart off --skills off');
  });

  it('uses restart wording without a consent question for an already set up Runtime', () => {
    const text = agentInstructions('install', 'https://astrid.haus', false, undefined, { alreadySetup: true });
    expect(text).toContain('Please restart Astrid on this computer');
    expect(text).not.toContain('May I install');
    expect(text).not.toContain('Setup choices:');
  });
});

describe('offline diagnostics copy', () => {
  it('owns one command for each of the two G1 options', () => {
    expect(DIAGNOSTICS_FALLBACK_COPY.agent).toContain('--doctor');
    expect(DIAGNOSTICS_FALLBACK_COPY.command).toBe('curl -fsSL https://astrid.haus/install | sh -s -- --doctor');
  });
});

describe('update handoff', () => {
  it('offers the installer route on hosted builds and source-checkout guidance only on local builds', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh');
    const text = agentInstructions('update', 'https://astrid.haus', true);
    expect(text).toContain('If you installed Astrid with the installer');
    expect(text).toContain("If you run Astrid from source checkouts: update those checkouts to their main branches and restart Astrid. Don't run the installer over them.");
    expect(text).toContain('running runtime_protocol from a git checkout');
    expect(agentInstructions('install', 'https://astrid.haus')).not.toContain('source checkouts');
    expect(agentInstructions('update', 'https://astrid.haus')).not.toContain('source checkouts');
  });

  it('offers the agent-safe Windows update command in update briefs', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows');
    expect(ASTRID_COMMANDS.windowsAgentUpdate).toBe('powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://astrid.haus/install.ps1))) --update"');
    expect(agentInstructions('update', 'https://astrid.haus')).toContain(ASTRID_COMMANDS.windowsUpdate);
    expect(localSetupInstructions()).toContain('npm run update');
  });
});

describe('update command by surface', () => {
  it("a locally run App updates with npm run update in the Astrid folder, not the curl line", () => {
    expect(installCommand('update', undefined, false, true)).toBe('npm run update');
    const brief = agentInstructions('update', 'http://localhost:5180', true);
    expect(brief).toContain('npm run update');
    expect(brief).not.toContain('--update');
  });

  it('a hosted astrid.haus update keeps the curl --update line', () => {
    expect(installCommand('update', undefined, false, false)).toBe(ASTRID_COMMANDS.macLinuxUpdate);
    const brief = agentInstructions('update', 'https://astrid.haus', false);
    expect(brief).toContain(ASTRID_COMMANDS.macLinuxUpdate);
    expect(brief).not.toContain('npm run update');
  });
});

describe('onboarding instructions', () => {
  it.each(['install', 'update'] as const)('ends %s instructions with the same browser handoff', mode => {
    const text = agentInstructions(mode, 'https://astrid.haus');
    expect(text).toContain('If the installer couldn\'t open a browser, open https://astrid.haus/?connect=1.');
    expect(text).toContain('My astrid.haus tab connects by itself once Astrid answers; if it shows a Connect button, click it.');
    expect(text).toContain('Tell me to choose Allow if Chrome or Edge asks');
    expect(agentInstructions(mode, 'https://preview.example')).toContain('the page at https://preview.example can connect');
    expect(agentInstructions(mode, 'https://preview.example')).toContain('If the installer couldn\'t open a browser, open https://astrid.haus/?connect=1.');
  });

  it('returns the fully local instructions', () => {
    const text = localSetupInstructions();
    expect(text).toContain('Please set up Astrid to run fully on this computer, including the editor so I can change Astrid itself.');
    expect(text).toContain('https://github.com/banodoco/astrid-app');
    expect(text).toContain('npm run dev:local');
    expect(text.match(/npx -y npm@11 ci/g)).toHaveLength(2);
    expect(text).not.toContain('npm ci');
    expect(text).toContain('http://127.0.0.1:5180/tools/video-editor?connect=1');
    expect(text).toContain(LOCAL_SETUP.startCommand);
  });

  it('local setup step five gives one browser address to open', () => {
    const step = localSetupSteps()[3];
    expect(step.line).toBe('Open this address in your browser. The editor opens with your project.');
    expect(step.command).toBe(LOCAL_SETUP.openUrl);
    expect(step.commandLabel).toBe('Copy the address');
  });

  it('local setup start command is defined', () => {
    expect(LOCAL_SETUP.startCommand).not.toMatch(/job X2/i);
    expect(LOCAL_SETUP.startCommand.trim()).not.toBe('');
  });
});

describe('refused card', () => {
  const BASE = 'http://127.0.0.1:17340/api/runtime';

  it('says Astrid is running, names the page, and offers no install', () => {
    const { title, sentence } = RUNTIME_CONNECTION_COPY.refused;
    expect(title).toBe("Astrid is running but won't connect to this page");
    expect(withOrigin(sentence, 'http://localhost:5190')).toBe('Astrid on this computer answered, but refused requests from http://localhost:5190. Open astrid.haus, or update Astrid if this keeps happening.');
    expect(`${title} ${sentence}`).not.toMatch(/isn't|install|curl|irm /i);
  });

  it('briefs an agent on the actual state: answering, refusing this origin, check it, do not reinstall', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh');
    const text = refusedAgentInstructions('http://localhost:5190', BASE);
    expect(text).toContain(`Astrid is running on this computer and answering at ${BASE}, but it refuses requests from the page at http://localhost:5190`);
    expect(text).toContain(`curl -s -H "Origin: http://localhost:5190" ${BASE}/v1/health`);
    expect(text).toContain(`curl -s -H "Origin: https://astrid.haus" ${BASE}/v1/health`);
    expect(text).toContain('do not reinstall it, and do not reset, delete or replace my workspace');
    expect(text).toContain('If the page is https://astrid.haus, this Astrid is probably out of date. Update it with the official installer');
    expect(text).toContain(ASTRID_COMMANDS.macLinuxUpdate);
    expect(text).toContain("http://localhost:5190 isn't an address this Astrid serves");
    // Never the first-install command.
    expect(text).not.toContain(ASTRID_COMMANDS.macLinux + '\n');
    expect(text).not.toMatch(/set up or restart Astrid/);
  });

  it('gives the Windows update commands on Windows', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows');
    const text = refusedAgentInstructions('https://astrid.haus', BASE);
    expect(text).toContain(ASTRID_COMMANDS.windowsUpdate);
    expect(text).toContain(ASTRID_COMMANDS.windowsAgentUpdate);
  });
});

describe('failure diagnostics', () => {
  it('uses one service description with the platform log path and historical exit', () => {
    const service = { name: 'pack-host', state: 'running', reason: 'readiness_timeout', last_exit: 7, restart_count: 2 } as const;
    expect(describeFailure(service, 'windows')).toEqual({
      summary: 'Last stop reason: readiness_timeout',
      lastExit: 7,
      logPath: '%LOCALAPPDATA%\\Astrid Runtime\\logs\\service-pack-host.log',
    });
    expect(describeFailure(service, 'mac').logPath).toBe('~/Library/Logs/Astrid Runtime/service-pack-host.log');
    expect(describeFailure(service, 'linux').logPath).toBe('${XDG_STATE_HOME:-~/.local/state}/astrid-runtime/logs/service-pack-host.log');
  });

  it('keeps ordinary diagnostics available to local recovery and uses PowerShell on Windows', () => {
    expect(describeFailure(new Error('Connection refused.')).summary).toBe('Connection refused.');
    expect(healthCheckCommand('http://127.0.0.1:17340/api/runtime', 'https://astrid.haus', 'windows'))
      .toBe("Invoke-RestMethod -Uri 'http://127.0.0.1:17340/api/runtime/v1/health' -Headers @{ Origin = 'https://astrid.haus' }");
    expect(healthCheckCommand('http://127.0.0.1:17340', undefined, 'windows'))
      .toBe("Invoke-RestMethod -Uri 'http://127.0.0.1:17340/api/runtime/v1/health'");
    expect(healthCheckCommand('http://127.0.0.1:17340/api/runtime/', undefined, 'windows'))
      .toBe("Invoke-RestMethod -Uri 'http://127.0.0.1:17340/api/runtime/v1/health'");
    const brief = agentInstructions('install', 'https://astrid.haus', false, [
      { name: 'pack-host', state: 'restarting', reason: 'readiness_timeout', last_exit: 7, restart_count: 1 },
    ]);
    expect(brief).toContain('pack-host: restarting · Last stop reason: readiness_timeout · Last exit code: 7');
    expect(brief).toContain('service-pack-host.log');

    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows');
    const windowsBrief = agentInstructions('install', 'https://astrid.haus');
    expect(windowsBrief).toContain("Invoke-RestMethod -Uri 'https://astrid.haus/api/runtime/v1/health' -Headers @{ Origin = 'https://astrid.haus' }");
  });
});

describe('diagnostics fallback', () => {
  it('offers the installer --doctor line, never astrid-runtime doctor', () => {
    expect(DIAGNOSTICS_FALLBACK_COPY.command).toContain('--doctor');
    expect(DIAGNOSTICS_FALLBACK_COPY.agent).toContain('--doctor');
    expect(DIAGNOSTICS_FALLBACK_COPY.command).not.toContain('astrid-runtime doctor');
    expect(DIAGNOSTICS_FALLBACK_COPY.agent).not.toContain('astrid-runtime doctor');
  });
});
