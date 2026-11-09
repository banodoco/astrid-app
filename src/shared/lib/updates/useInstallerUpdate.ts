import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { RuntimeConnectionValue } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';
import { runtimeApiBase, runtimeOrigin } from '@/integrations/runtime/connection.ts';
import { useAuthSafe } from '@/shared/contexts/AuthContext.tsx';
import { scheduleFocusAndInterval } from './appBuildWatch.ts';
import { canStartInstallerUpdate, installerUpdateReasonOf, pageUpdateOperation, type UpdateOperationSnapshot } from './updateOperation.ts';
import { localUpdateStatus, pageInstallType } from './pageUpdateStatus.ts';
import type { InstallType } from './resolveUpdate.ts';

/** The install type the update actions follow: the operation's Runtime identity, else the connection's Pinokio provenance. */
function operationInstallType(snapshot: UpdateOperationSnapshot, managedByPinokio: boolean | null | undefined): InstallType {
  return pageInstallType(snapshot.health?.identity?.managed_by, managedByPinokio);
}

/**
 * The same install type for a surface that only names a path (Settings' status repair), so its words and the update
 * actions can't disagree. It reads the shared operation and starts no polling of its own.
 */
export function useUpdateInstallType(connection?: Pick<RuntimeConnectionValue, 'managedByPinokio'> | null): InstallType {
  const operation = pageUpdateOperation(runtimeApiBase());
  const snapshot = useSyncExternalStore(operation.subscribe, operation.getSnapshot, operation.getSnapshot);
  return operationInstallType(snapshot, connection?.managedByPinokio);
}

export function useInstallerUpdate(connection?: RuntimeConnectionValue | null) {
  const { isAuthenticated, authError } = useAuthSafe();
  const local = localUpdateStatus();
  const operation = pageUpdateOperation(runtimeApiBase());
  const snapshot = useSyncExternalStore(operation.subscribe, operation.getSnapshot, operation.getSnapshot);
  // Schema incompatibility prevents workspace negotiation, but the provider
  // can still have authenticated health from the same Runtime. In that state
  // only the read-only installer routes are enabled; capability and ownership
  // checks below continue to decide whether an explicit update is offered.
  const updateTransportAvailable = connection?.isConnected === true || connection?.state?.status === 'update_needed';
  // The installer routes (status, Update now) are the hosted page's. A fully local page updates through its launcher,
  // but it watches its Astrid the same way, so a finished update shows live there too.
  const hosted = !local && runtimeOrigin() !== '';
  const enabled = isAuthenticated && updateTransportAvailable && hosted;
  const watched = isAuthenticated && updateTransportAvailable && (hosted || local);
  // An accepted operation outlives the workspace connection. Its read-only
  // status route still authenticates through the connector after a restart.
  // Never turn this permission to observe into permission to POST.
  const disconnected = ['connecting', 'not_running', 'restart'].includes(connection?.state?.status ?? '');
  const monitor = watched || snapshot.pending && disconnected && !authError && hosted;
  const latest = useRef({ enabled, connection });
  latest.current = { enabled, connection };
  const confirmPermission = connection?.confirmPermission;
  // A reconnect (Astrid restarted, or came back) re-reads the release at once instead of waiting for the next tick.
  const connected = connection?.isConnected === true;
  const wasConnected = useRef<boolean | null>(null);
  useEffect(() => {
    const before = wasConnected.current;
    wasConnected.current = connected;
    if (before === false && connected && watched) void operation.refresh(true);
  }, [connected, watched, operation]);
  // While any update surface is mounted, a light poll keeps the status live: a new runtime_instance_id or installed
  // release (an update run from a terminal, or by Update now) re-checks the release without a click or a reload.
  useEffect(() => {
    if (!monitor) return;
    let disposed = false;
    const refresh = async () => {
      if (confirmPermission && !(await confirmPermission())) return;
      if (!disposed) await operation.refresh();
    };
    void refresh();
    const unschedule = scheduleFocusAndInterval(() => { void refresh(); }, 3000);
    return () => { disposed = true; unschedule(); };
  }, [monitor, operation, confirmPermission]);
  const manager = snapshot.health?.identity?.managed_by;
  const installType = operationInstallType(snapshot, connection?.managedByPinokio);
  // Missing identity is never evidence of an installer-owned installation. The
  // Runtime performs the full ownership/lock/busy admission on the explicit POST.
  // A recovery whose Runtime refuses it (a busy or policy reason) gets the terminal line, never the in-app Update.
  const recovery = snapshot.status?.state === 'recovery-needed' && canStartInstallerUpdate(snapshot.status);
  // Update now is offered when the installed Astrid reports self_update, and while it is busy, when it is shown disabled.
  // canStartInstallerUpdate gates the start itself.
  const available = enabled && installType === 'installer' && manager === null
    && typeof snapshot.health?.runtime_instance_id === 'string'
    && (recovery || snapshot.releaseStatus?.behind === true)
    && !snapshot.restartRequired
    && snapshot.fresh && (snapshot.status?.self_update === true || snapshot.status?.reason === 'busy');
  return { ...snapshot, installType, available, updateReason: installerUpdateReasonOf(snapshot.status) ?? undefined,
    refresh: async () => { if (watched) await operation.refresh(true); },
    start: async (validateDrafts: () => boolean) => {
      if (!available || !canStartInstallerUpdate(snapshot.status) || !latest.current.enabled) return;
      const current = latest.current.connection;
      if (current?.confirmPermission && !(await current.confirmPermission())) return;
      if (latest.current.enabled) await operation.start(validateDrafts);
    },
  };
}

export type InstallerUpdateView = ReturnType<typeof useInstallerUpdate>;
