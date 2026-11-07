import { RUNTIME_CONNECTION_COPY } from '@/shared/components/RuntimeConnection/copy.ts';

/** User-facing copy for the Astrid status section in App Settings. */
export const ASTRID_STATUS_COPY = {
  title: 'Astrid on this computer',
  description: "Your workspace and what's running on this computer.",
  connecting: 'Looking for Astrid…',
  connected: 'Connected',
  degraded: "Part of Astrid isn't working. Give these instructions to your coding agent to restart it.",
  /** Pinokio's Update reruns Astrid's installer and restarts it: the repair the install command is for everyone else. */
  degradedPinokio: "Part of Astrid isn't working. Update it in Pinokio to repair it.",
  checking: 'Reading details…',
  unavailable: "Astrid's details aren't available right now.",
  notRunning: "Astrid isn't answering on this computer",
  refused: 'Running, but refused this page',
  updateNeeded: 'Needs an update',
  chatUpdateNeeded: 'Connected. Chat needs an update',
  /** The line under an old Astrid's status: what is old, and where to update it. No actions of its own. */
  outOfDateDetail: {
    runtime: 'This page needs a newer Astrid. Update it under Updates.',
    chat: 'Chat on this computer is older than this page. Update Astrid under Updates.',
  },
  blocked: "Blocked by your browser's settings",
  detailsToggle: 'Details',
  workspace: 'Workspace',
  workspaceName: 'Name',
  connectionDetails: 'Connection details',
  protocol: 'Protocol',
  schema: 'Schema',
  running: "What's running",
  noServices: 'Nothing else is running with Astrid.',
  detailsUnavailable: "Can't tell what's running right now.",
  serviceStates: {
    starting: 'Starting…',
    running: 'Running',
    restarting: 'Restarting…',
    failed: 'Failed',
  },
  lastExit: (code: number) => `Last exit code: ${code}`,
  serviceLog: (path: string) => `Log: ${path}`,
  serviceName: (name: string) => {
    switch (name) {
      case 'pack-host': return 'Task host';
      case 'chat': return 'Chat';
      default: return name;
    }
  },
  restartCount: (count: number) => count > 0 ? `Restarts: ${count}` : null,
} as const;

export function connectionStatusCopy(status: string): string {
  switch (status) {
    case 'connected': return ASTRID_STATUS_COPY.connected;
    case 'connecting': return ASTRID_STATUS_COPY.connecting;
    case 'needs_permission': return RUNTIME_CONNECTION_COPY.permission.title;
    case 'phone': return RUNTIME_CONNECTION_COPY.phone.title;
    case 'unsupported': return RUNTIME_CONNECTION_COPY.unsupported.title;
    case 'not_running': return ASTRID_STATUS_COPY.notRunning;
    case 'refused': return ASTRID_STATUS_COPY.refused;
    case 'update_needed': return ASTRID_STATUS_COPY.updateNeeded;
    case 'blocked': return ASTRID_STATUS_COPY.blocked;
    default: return ASTRID_STATUS_COPY.unavailable;
  }
}
