import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { RuntimeConnectionValue } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';
import { runtimeApiBase, runtimeOrigin } from '@/integrations/runtime/connection.ts';
import { useAuthSafe } from '@/shared/contexts/AuthContext.tsx';
import { scheduleFocusAndInterval } from './appBuildWatch.ts';
import { pageUpdateOperation } from './updateOperation.ts';
import { installTypeOf } from './resolveUpdate.ts';

export function useInstallerUpdate(connection?: RuntimeConnectionValue | null) {
  const { isAuthenticated, authError } = useAuthSafe();
  const local = import.meta.env.VITE_ASTRID_LOCAL_UPDATE_STATUS === '1';
  const operation = pageUpdateOperation(runtimeApiBase());
  const snapshot = useSyncExternalStore(operation.subscribe, operation.getSnapshot, operation.getSnapshot);
  // Schema incompatibility prevents workspace negotiation, but the provider
  // can still have authenticated health from the same Runtime. In that state
  // only the read-only installer routes are enabled; capability and ownership
  // checks below continue to decide whether an explicit update is offered.
  const updateTransportAvailable = connection?.isConnected === true || connection?.state?.status === 'update_needed';
  const enabled = isAuthenticated && updateTransportAvailable && !local && runtimeOrigin() !== '';
  // An accepted operation outlives the workspace connection. Its read-only
  // status route still authenticates through the connector after a restart.
  // Never turn this permission to observe into permission to POST.
  const disconnected = ['connecting', 'not_running', 'restart'].includes(connection?.state?.status ?? '');
  const monitor = enabled || snapshot.pending && disconnected && !authError && !local && runtimeOrigin() !== '';
  const latest = useRef({ enabled, connection });
  latest.current = { enabled, connection };
  const confirmPermission = connection?.confirmPermission;
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
  const installType = installTypeOf(manager, { managedByPinokio: connection?.managedByPinokio, local, originless: runtimeOrigin() === '' });
  // Missing identity is never evidence of an installer-owned installation. The
  // Runtime performs the full ownership/lock/busy admission on the explicit POST.
  const available = enabled && installType === 'installer' && manager === null
    && typeof snapshot.health?.runtime_instance_id === 'string'
    && snapshot.releaseStatus?.behind === true
    && !snapshot.restartRequired
    && snapshot.fresh && snapshot.status?.available === true && snapshot.status.state !== 'recovery-needed';
  return { ...snapshot, installType, available,
    refresh: async () => { if (enabled) await operation.refresh(true); },
    start: async () => {
      if (!available || !latest.current.enabled) return;
      const current = latest.current.connection;
      if (current?.confirmPermission && !(await current.confirmPermission())) return;
      if (latest.current.enabled) await operation.start();
    },
  };
}

export type InstallerUpdateView = ReturnType<typeof useInstallerUpdate>;
