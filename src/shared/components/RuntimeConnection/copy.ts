import { runtimeOrigin } from '@/integrations/runtime/connection.ts';
import { RuntimeAuthenticationError, RuntimeCompatibilityError, RuntimeUnavailableError } from '@/integrations/runtime/client.ts';
import type { ServiceStatus } from '@/integrations/runtime/generated.ts';
import { installBrowserName } from '@/pages/Home/installScenario.ts';
import { detectPlatform } from '@/shared/hooks/platformInstall/platformDetection.ts';
import type { Platform } from '@/shared/hooks/platformInstall/types.ts';

/**
 * Every word the hosted build's connection gate shows. The panel, the restart cards,
 * the status container and the disabled compose controls render from this object and nothing else, so the wording is
 * reviewed in one place.
 *
 * Rules for this file:
 * - Screen headings, body text, command lines and Copy labels live here.
 * - Routine recovery text says Astrid; first-run explanation names Runtime so people understand what they are connecting.
 * - Straight apostrophes only: the journey matches card headings exactly.
 * - Gate states name their screens: connecting, needs_permission (permission/pending), blocked, phone, unsupported, not_running, refused,
 *   update_needed and connected.
 *   Permission/pending share a state; device and browser capability are decided by the provider. Polling never adds a checking indicator.
 * - The setup, repair and update screens all show the command that matches the state and OS, and nothing about opening a terminal.
 * - Each phrase the journey looks for (`tests/e2e/local/direct-journey.spec.ts`) appears in one element of its
 *   panel only, so a text locator finds exactly one match.
 * - The browser a card names is a `{browser}` placeholder, filled by `withBrowser` from the landing page's browser detection.
 * - No gateway literal (`127.0.0.1:<port>`, `/api/...`): those live in `connection.ts`.
 */

/** The browser's name goes where a card says `{browser}`: the one the landing page's install dialog detected. */
const BROWSER_PLACEHOLDER = '{browser}';

/** `text` with every `{browser}` filled in (Chrome or Edge); the browser is detected once per call unless given. */
export function withBrowser(text: string, browser: string = installBrowserName()): string {
  return text.split(BROWSER_PLACEHOLDER).join(browser);
}

/** Product install and update commands. */
export const ASTRID_COMMANDS = {
  macLinux: 'curl -fsSL https://astrid.haus/install | sh',
  windows: 'irm https://astrid.haus/install.ps1 | iex',
  /** For an agent in Git Bash or another non-PowerShell shell on Windows. */
  windowsAgent: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astrid.haus/install.ps1 | iex"',
  windowsAgentUpdate: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://astrid.haus/install.ps1))) --update"',
  macLinuxUpdate: 'curl -fsSL https://astrid.haus/install | sh -s -- --update',
  windowsUpdate: '& ([scriptblock]::Create((irm https://astrid.haus/install.ps1))) --update',
} as const;

export const ASTRID_REPO_URL = 'https://github.com/banodoco/astrid-app';
const LOCAL_SETUP_DIRECTORY = 'astrid-app';

/** The fully local setup: the editor's source, how to start it, and where it serves. */
export const LOCAL_SETUP = {
  macLinuxInstaller: ASTRID_COMMANDS.macLinux,
  windowsInstaller: ASTRID_COMMANDS.windows,
  repoUrl: ASTRID_REPO_URL,
  repoDirectory: LOCAL_SETUP_DIRECTORY,
  cloneCommand: `git clone ${ASTRID_REPO_URL}.git`,
  changeDirectoryCommand: `cd ${LOCAL_SETUP_DIRECTORY}`,
  installDependenciesCommand: 'npx -y npm@11 ci',
  startCommand: 'npm run dev:local',
  /** The first-open address resumes at connection: `entryFor` sends `?connect=1` straight there. */
  openUrl: 'http://127.0.0.1:5180/tools/video-editor?connect=1',
} as const;

/** Optional Pinokio route for installing the fully local app. */
export const PINOKIO_INSTALL_COPY = {
  label: 'Or install with Pinokio',
  fullyLocalLabel: 'Or install with Pinokio, then choose Install fully local',
  installUrl: 'https://pinokio.co/item?uri=https://github.com/banodoco/astrid-pinokio',
} as const;

export interface LocalSetupStep {
  readonly line: string;
  readonly command?: string;
  readonly commandLabel?: string;
  readonly hint?: string;
}

/** The concise, human-readable version of the fully local setup, using the same commands as the agent handoff. */
export function localSetupSteps(): readonly LocalSetupStep[] {
  const L = LOCAL_SETUP;
  const windows = detectPlatform() === 'windows';
  return [
    {
      line: `Install Astrid: in ${windows ? 'PowerShell' : 'Terminal'} run`,
      command: windows ? L.windowsInstaller : L.macLinuxInstaller,
      commandLabel: 'Copy the install command',
      ...(windows ? { hint: 'If pasting gives nothing, select the command and press Ctrl+C.' } : {}),
    },
    { line: "Install Git and Node.js 20 (20.19 or newer), if you don't have them." },
    {
      line: 'Get the editor:',
      command: [L.cloneCommand, L.changeDirectoryCommand, L.installDependenciesCommand].join('\n'),
      commandLabel: 'Copy the editor setup commands',
    },
    {
      line: 'Start it, and leave that terminal open:',
      command: L.startCommand,
      commandLabel: 'Copy the start command',
    },
    {
      line: 'Open this address in your browser. The editor opens with your project.',
      command: L.openUrl,
      commandLabel: 'Copy the address',
    },
  ];
}

export type WindowMode = 'app-window' | 'browser-tab';

export function localSetupInstructions(): string {
  const L = LOCAL_SETUP;
  return [
    'Please set up Astrid to run fully on this computer, including the editor, so I can change Astrid itself. Do the work yourself and verify the result.',
    `1. Install or repair Astrid with the official installer. Fetch and read the script before running it. macOS/Linux: \`${L.macLinuxInstaller}\`. Windows PowerShell: \`${L.windowsInstaller}\`. Keep my existing workspace, projects, media, credentials, and agent instructions. The installer may open astrid.haus; finish this setup in the local editor below.`,
    `2. Get the editor's code from ${L.repoUrl}. Install Git and Node.js 20.19 or newer in the Node 20 release line if needed. Clone with \`${L.cloneCommand}\`, then \`${L.changeDirectoryCommand}\` and \`${L.installDependenciesCommand}\`. If a clone already exists, preserve its changes and update it to \`main\` without discarding work; use \`git pull --ff-only origin main\` when it can fast-forward and resolve any divergence before continuing.`,
    `3. In that clone, run \`${L.startCommand}\` in a terminal that stays open. This starts the source editor on port 5180, checks the installed Runtime and selected workspace, and connects through the editor's own server. Keep the existing hosted door for https://astrid.haus; do not change its origin or turn it off. If the launcher reports a problem, diagnose it and repair through the official installer when needed. Do not delete or replace my workspace or credentials.`,
    `4. Open ${L.openUrl} in my browser. The editor opens with my project. This first-open address resumes at connection because I already completed the tour. Verify \`/api/runtime/v1/health\` and \`/api/runtime/v1/realm\` through http://127.0.0.1:5180 and confirm the editor uses my existing Runtime workspace. No browser local-network permission is needed for this route. Do not claim success if any check could not be run; tell me the actual result.`,
    `5. Tell me the absolute path of the clone so you or I can edit it. Source edits appear through Vite's normal development workflow. To start later: \`cd\` to that clone and run \`${L.startCommand}\`, then open the local address it prints. To stop the editor: Ctrl+C in its terminal. That stops the editor and proxy, plus any Runtime it started; a Runtime it attached to keeps running for astrid.haus. To update the editor: stop it, save or commit local source changes, then run \`git pull --ff-only origin main\`, \`${L.installDependenciesCommand}\`, and \`${L.startCommand}\`. To update the Runtime and agent: use \`${ASTRID_COMMANDS.macLinuxUpdate}\` on macOS/Linux, or \`${ASTRID_COMMANDS.windowsAgentUpdate}\` in Windows PowerShell, then restart the editor. Read the update script before running it. The local editor can open offline after its dependencies are installed; online models and providers still need internet.`,
  ].join('\n');
}

export type CommandMode = 'install' | 'update';

export interface FailureDescription {
  readonly summary: string | null;
  readonly lastExit: number | null;
  readonly logPath: string | null;
}

export function runtimeLogDirectory(platform: Platform = detectPlatform()): string {
  switch (platform) {
    case 'windows': return '%LOCALAPPDATA%\\Astrid Runtime\\logs';
    case 'mac': return '~/Library/Logs/Astrid Runtime';
    case 'linux': return '${XDG_STATE_HOME:-~/.local/state}/astrid-runtime/logs';
    default: return 'Astrid Runtime logs';
  }
}

function serviceLogPath(name: string, platform: Platform): string {
  const safeName = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) ? name : 'unknown';
  const separator = platform === 'windows' ? '\\' : '/';
  return `${runtimeLogDirectory(platform)}${separator}service-${safeName}.log`;
}

function serviceStatus(value: unknown): value is ServiceStatus {
  if (!value || typeof value !== 'object') return false;
  const service = value as Partial<ServiceStatus>;
  return typeof service.name === 'string'
    && ['starting', 'running', 'restarting', 'failed'].includes(String(service.state))
    && (typeof service.last_exit === 'number' || service.last_exit === null);
}

/** Classifies known Runtime failures and service history for shared status and recovery displays. */
export function describeFailure(value: unknown, platform: Platform = detectPlatform()): FailureDescription {
  if (serviceStatus(value)) {
    const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
    const lastExit = value.last_exit;
    const summary = reason
      ? `${value.state === 'failed' ? 'Reason' : 'Last stop reason'}: ${reason}`
      : value.state === 'failed' ? "It stopped and isn't running."
        : lastExit !== null ? 'It stopped earlier.' : null;
    return { summary, lastExit, logPath: serviceLogPath(value.name, platform) };
  }
  if (value instanceof RuntimeAuthenticationError) {
    return { summary: "Astrid Runtime didn't accept this editor's credential.", lastExit: null, logPath: null };
  }
  if (value instanceof RuntimeUnavailableError) {
    const summary = value.failureKind === 'storage'
      ? 'Astrid Runtime reported a problem with its storage.'
      : value.failureKind === 'admission'
        ? "Astrid Runtime didn't pass its startup or integrity checks."
        : value.failureKind === 'transport'
          ? "Astrid Runtime didn't respond."
          : 'Astrid Runtime reported that it is unavailable.';
    return { summary, lastExit: null, logPath: null };
  }
  if (value instanceof RuntimeCompatibilityError) {
    return { summary: value.kind === 'schema'
      ? "This Astrid Runtime doesn't support the schema this editor needs."
      : value.kind === 'identity'
        ? 'The connected Astrid Runtime identity changed.'
        : 'This Astrid Runtime does not provide a required capability.', lastExit: null, logPath: null };
  }
  if (value instanceof Error && value.message.trim()) {
    return { summary: value.message.trim(), lastExit: null, logPath: null };
  }
  return { summary: "Couldn't connect to Astrid Runtime.", lastExit: null, logPath: null };
}

export function healthCheckCommand(apiBase: string, origin?: string, platform: Platform = detectPlatform()): string {
  const base = apiBase.replace(/\/+$/, '');
  const runtimeBase = base.endsWith('/api/runtime') ? base : `${base}/api/runtime`;
  const url = `${runtimeBase}/v1/health`;
  if (platform === 'windows') {
    const headers = origin ? ` -Headers @{ Origin = '${origin.replace(/'/g, "''")}' }` : '';
    return `Invoke-RestMethod -Uri '${url.replace(/'/g, "''")}'${headers}`;
  }
  return `curl -s${origin ? ` -H "Origin: ${origin}"` : ''} ${url}`;
}

function serviceBrief(services: readonly ServiceStatus[] | undefined, platform: Platform): string {
  const recorded = services?.map((service) => {
    const failure = describeFailure(service, platform);
    const details = [
      `${service.name}: ${service.state}`,
      failure.summary,
      failure.lastExit === null ? null : `Last exit code: ${failure.lastExit}`,
      failure.logPath ? `Log: ${failure.logPath}` : null,
    ].filter((part): part is string => Boolean(part));
    return details.join(' · ');
  }) ?? [];
  return recorded.length
    ? `Services reported by the Runtime health check:\n${recorded.join('\n')}`
    : `If a service fails, inspect its service-<name>.log under ${runtimeLogDirectory(platform)}.`;
}

export function installCommand(mode: CommandMode): string {
  const windows = detectPlatform() === 'windows';
  if (mode === 'update') return windows ? ASTRID_COMMANDS.windowsUpdate : ASTRID_COMMANDS.macLinuxUpdate;
  return windows ? ASTRID_COMMANDS.windows : ASTRID_COMMANDS.macLinux;
}

const SETUP_GUIDE_URL = 'https://github.com/banodoco/astrid-agent/blob/main/docs/setup/SKILL.md';

/** The two ways to update, since this page can't tell an installer install from source checkouts. */
export const UPDATE_ROUTES = {
  installer: (command: string) => `If you installed Astrid with the installer: ${command}`,
  source: "If you run Astrid from source checkouts: update those checkouts to their main branches and restart Astrid. Don't run the installer over them.",
} as const;

/** A complete handoff: retain an existing workspace and diagnose failures before retrying. */
export function agentInstructions(mode: CommandMode, pageOrigin: string, localBuild = false, services?: readonly ServiceStatus[]): string {
  const platform = detectPlatform();
  const windows = platform === 'windows';
  const command = installCommand(mode);
  return [
    `Please ${mode === 'update' ? 'update my existing Astrid installation' : 'set up or restart Astrid on this computer'} so the page at ${pageOrigin} can connect. Do the work yourself and verify the result.`,
    'First inspect the existing installation, running services, profile, selected workspace and data root. Preserve my projects, media, credentials and agent instructions. Do not reset or delete my workspace, or replace it with an empty one.',
    "Use the current official Astrid installer; read it before running it. The installer adopts an existing workspace itself; don't run workspace or migration commands by hand. Do not bypass ownership guards or overwrite a directory just because the installer refuses it.",
    windows && mode === 'install'
      ? `The command offered by this page, in PowerShell:\n${command}\nFrom Git Bash or another shell:\n${ASTRID_COMMANDS.windowsAgent}\nInstall from Windows, not inside WSL.`
      : windows && mode === 'update'
        ? `The command offered by this page, in PowerShell:\n${command}\nFrom Git Bash or another shell:\n${ASTRID_COMMANDS.windowsAgentUpdate}\nUpdate from Windows, not inside WSL.`
      : `${mode === 'update' ? 'If you installed Astrid with the installer, the command offered by this page is' : 'The command offered by this page is'}:\n${command}${windows ? '\nInstall from Windows, not inside WSL.' : ''}`,
    mode === 'update'
      ? localBuild ? `${UPDATE_ROUTES.source} Before running the installer, check whether this computer runs Astrid from source checkouts (for example, a running runtime_protocol from a git checkout). If it does, update those checkouts instead of running the installer.` : null
      : null,
    'If installation or startup fails, read the log path printed by the installer, diagnose the actual cause and resolve it before retrying. Keep the existing workspace selection and data root connected; do not infer that no installation exists merely because the browser cannot reach it.',
    serviceBrief(services, platform),
    `Check Runtime health: \`${healthCheckCommand(`${runtimeOrigin() || pageOrigin}/api/runtime`, pageOrigin, platform)}\`.`,
    `The installer verifies Astrid and opens astrid.haus. Tell me to choose Allow if Chrome or Edge asks, and confirm Astrid shows Connected. Setup guide: ${SETUP_GUIDE_URL}`,
    "If the installer couldn't open a browser, open https://astrid.haus/?connect=1.",
    'My astrid.haus tab connects by itself once Astrid answers; if it shows a Connect button, click it.',
  ].filter((part): part is string => part !== null).join('\n\n');
}

/**
 * The handoff for a running Astrid that refuses this page's origin: no install, no reset, a check the agent can run,
 * and the one fix there is (update) when the page is astrid.haus.
 */
export function refusedAgentInstructions(pageOrigin: string, apiBase: string): string {
  const platform = detectPlatform();
  const windows = platform === 'windows';
  return [
    `Astrid is running on this computer and answering at ${apiBase}, but it refuses requests from the page at ${pageOrigin}, so that page can't connect. Do the work yourself and verify the result.`,
    `Check it: \`${healthCheckCommand(apiBase, pageOrigin, platform)}\`. A refusal answers 403 with no Access-Control-Allow-Origin header. Compare with \`${healthCheckCommand(apiBase, 'https://astrid.haus', platform)}\`, which should answer with health JSON.`,
    `Service logs are named service-<name>.log under ${runtimeLogDirectory(platform)}.`,
    'Astrid is installed and running: do not reinstall it, and do not reset, delete or replace my workspace, projects, media, credentials or agent instructions.',
    `If the page is https://astrid.haus, this Astrid is probably out of date. Update it with the official installer's update command; read the script before running it. ${windows ? `In PowerShell: ${ASTRID_COMMANDS.windowsUpdate}\nFrom Git Bash or another shell: ${ASTRID_COMMANDS.windowsAgentUpdate}\nUpdate from Windows, not inside WSL.` : `The command: ${ASTRID_COMMANDS.macLinuxUpdate}`} If you run Astrid from source checkouts instead, update those checkouts to their main branches and restart Astrid; don't run the installer over them.`,
    `If the page is not https://astrid.haus, ${pageOrigin} isn't an address this Astrid serves. Tell me to open https://astrid.haus instead; don't change Astrid's allowed origins unless I ask.`,
    'My tab connects by itself once Astrid accepts the page; if it shows a Connect button, click it.',
  ].join('\n\n');
}

/** `{origin}` in a card's text filled with the page's origin. */
export function withOrigin(text: string, origin: string): string {
  return text.split('{origin}').join(origin);
}

/** Names the shell that matches the command shown on setup, repair and recovery cards. */
export function withCommandShell(sentence: string): string {
  return detectPlatform() === 'windows' ? sentence.replace('in a terminal', 'in PowerShell') : sentence;
}

/** A heading and the one sentence under it. */
interface Message {
  readonly title: string;
  readonly sentence: string;
}

export interface RuntimeConnectionCopy {
  readonly commands: typeof ASTRID_COMMANDS;
  /** Accessible name for the panel region. */
  readonly panelLabel: string;
  readonly windowsBeta: string;
  /** The quiet status line along the bottom of a card that waits for something done elsewhere; it becomes `connected`. */
  readonly waiting: string;
  /** While the first probe is in flight (and while Astrid is still starting): the one line under the mark. */
  readonly connecting: { readonly sentence: string };
  /** Permission `prompt`: shown before anything is sent, with the Connect button. */
  readonly permission: Message & {
    readonly connect: string;
    readonly allowTitle: string;
    readonly allowDetails: string;
    readonly installTitle: string;
    /** Connect was pressed and Chrome did not ask or was dismissed: the way on that does not depend on its prompt. */
    readonly unanswered: { readonly lead: string };
    /** The browser's prompt is open: nothing to press, so no button. */
    readonly pending: Message & { readonly pointer: string };
  };
  /** Permission `denied`: two steps in the browser, then the page opens by itself. */
  readonly blocked: Message & {
    readonly steps: readonly [string, string];
    readonly footer: string;
  };
  /** Repeated probes went unanswered with permission granted. */
  readonly notRunning: Message & { readonly retry: string; readonly pinokioHint: string };
  /** Astrid answered the browser but would not let this page read the answer (it serves other origins only). */
  readonly refused: Message & { readonly retry: string };
  readonly updateNeeded: Message & { readonly pinokioSentence: string };
  /** Lead-in above the update screen when a chat reply from this computer's Astrid is out of date. */
  readonly chatNeedsUpdate: string;
  /** A phone can never reach Astrid on a computer: the link goes there instead. */
  readonly phone: Message & { readonly button: string; readonly copied: string };
  /** A desktop browser that cannot request local-network access. */
  readonly unsupported: Message & { readonly button: string; readonly copied: string };
  readonly browserUpdateNeeded: Message;
  readonly connectorFailure: { readonly authentication: string; readonly admission: string; readonly storage: string; readonly unavailable: string };
  /** Screen-reader text of the status container while connected, and the line App settings shows then. */
  readonly connected: { readonly sentence: string };
  /** Connected, and the health check answers too slowly: Astrid is running under load. The card clears itself. */
  readonly busy: Message;
  /** Connected, and the health check stopped answering. The card clears itself when Astrid is back. */
  readonly stopped: Message & { readonly pinokioSentence: string };
  /** Connected, and Astrid restarted (or changed) under the page. */
  readonly restarted: Message & { readonly reload: string };
  /** The timeline (or the engine connection behind it) would not load on the hosted build: replaces every engineer-worded error. */
  readonly loadFailed: Message & { readonly button: string; readonly retrying: string };
  readonly agent: {
    readonly copy: string;
    readonly copied: string;
    readonly pasteNext: string;
    /** Shown with the command in a text box, only when the clipboard write failed. */
    readonly copyFailed: string;
    readonly commandCopy: string;
    readonly commandCopied: string;
    readonly terminalAlternative: string;
    /** Update only, where the installer is one of two routes. */
    readonly terminalAlternativeUpdate: string;
  };
  /** Next to the compose controls the hosted build disables. */
  readonly composeDisabled: string;
}

export const RUNTIME_CONNECTION_COPY: RuntimeConnectionCopy = {
  commands: ASTRID_COMMANDS,

  panelLabel: 'Connect to Astrid',

  windowsBeta: 'Windows support is in beta.',

  waiting: 'Waiting for Astrid on this computer…',

  connecting: {
    sentence: 'Looking for Astrid on this computer…',
  },

  permission: {
    title: 'Connect to Astrid on this computer',
    sentence: '{browser} will ask to let astrid.haus reach Astrid on this computer. Choose Allow.',
    connect: 'Connect',
    allowTitle: 'What does this allow?',
    installTitle: "Don't have Astrid yet?",
    unanswered: { lead: "If {browser} didn't ask, allow it here:" },
    allowDetails: "This page can talk to Astrid running on your computer, and nothing else. Astrid only lets it work with your Astrid projects, media and jobs. It can't open your other files or apps. Chat messages go to your own agent on this computer. Your work never passes through our servers.",
    pending: {
      title: 'Choose Allow in {browser}',
      sentence: 'The prompt is at the top left of this window.',
      /** The word on the arrow that points at the prompt, as the install dialog's says "Up here". */
      pointer: 'Up here',
    },
  },

  blocked: {
    title: 'Allow Astrid in {browser}',
    sentence: '{browser} is blocking this page from reaching Astrid.',
    steps: [
      'Click the icon at the left of the address bar, then Site settings.',
      'Set Local network access to Allow.',
    ],
    footer: 'Come back here and it opens by itself.',
  },

  notRunning: {
    title: "Astrid isn't answering on this computer",
    retry: 'Try again',
    sentence: "Your coding agent can start it, or install it if it isn't there yet.",
    pinokioHint: 'Start Astrid in Pinokio.',
  },

  refused: {
    title: "Astrid is running but won't connect to this page",
    sentence: 'Astrid on this computer answered, but refused requests from {origin}. Open astrid.haus, or update Astrid if this keeps happening.',
    retry: 'Try again',
  },

  updateNeeded: {
    title: 'Update Astrid',
    sentence: 'This page needs a newer Astrid. Give these instructions to your coding agent to update it.',
    pinokioSentence: 'This page needs a newer Astrid. Update in Pinokio.',
  },

  /** Lead-in above the shared update screen when a chat reply from this computer's Astrid is out of date. */
  chatNeedsUpdate: 'Chat on this computer is older than this page.',

  phone: {
    title: 'Open Astrid on your computer',
    sentence: 'Astrid runs on a computer, so open this page there.',
    button: 'Send the link to your computer',
    copied: 'Link copied',
  },

  unsupported: {
    title: 'Open Astrid in Chrome or Edge',
    sentence: 'This browser cannot connect to Astrid on your computer.',
    button: 'Copy link for Chrome or Edge',
    copied: 'Copied. Open it in Chrome or Edge.',
  },

  browserUpdateNeeded: {
    title: 'Update {browser} to connect',
    sentence: "This version of {browser} can't reach Astrid on this computer. Update it, then come back.",
  },

  connectorFailure: {
    authentication: 'Workspace Runtime authentication failed',
    admission: 'Workspace Runtime failed its startup checks',
    storage: 'Workspace Runtime reported a storage failure',
    unavailable: 'Workspace Runtime is unavailable',
  },

  connected: {
    sentence: 'Connected to Astrid',
  },

  busy: {
    title: 'Astrid is busy',
    sentence: "It's still running and will catch up. Your changes are kept.",
  },

  stopped: {
    title: 'Astrid stopped',
    sentence: 'Give these instructions to your coding agent to start Astrid again. Your changes are kept.',
    pinokioSentence: 'Start Astrid in Pinokio. Your changes are kept.',
  },

  restarted: {
    title: 'Astrid restarted',
    sentence: 'Reload to carry on. Your changes are kept.',
    reload: 'Reload',
  },

  loadFailed: {
    title: "Couldn't load this timeline",
    // No promise that it loads by itself: the automatic retries stop after a few tries, and the button is the way on.
    // A stopped Astrid shows the stopped card instead of this one, so the sentence doesn't ask anyone to start it.
    sentence: "Astrid on this computer didn't answer in time.",
    button: 'Try again',
    retrying: 'Trying again…',
  },

  agent: {
    copy: 'Copy for your agent',
    copied: 'Copied. Paste them into your agent.',
    pasteNext: 'Steps copied. Paste them into your agent.',
    copyFailed: "Copying didn't work. Select the text below and copy it.",
    commandCopy: 'Copy command',
    commandCopied: 'Command copied',
    terminalAlternative: 'Or run this yourself in a terminal:',
    terminalAlternativeUpdate: 'No coding agent? Run this in a terminal:',
  },

  composeDisabled: "Making new images isn't on this page yet.",
};

/**
 * The compose line on the hosted build (a gateway origin is configured), `null` same-origin. The one rule
 * the compose controls, their submit handlers and the task-creation library all read, so the composer route,
 * which the gateway does not serve, is never requested from the hosted page.
 */
export function composeDisabledReason(): string | null {
  return runtimeOrigin() !== '' ? RUNTIME_CONNECTION_COPY.composeDisabled : null;
}
