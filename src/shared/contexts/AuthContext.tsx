import React, { createContext, useState, useContext, ReactNode, useEffect, useMemo, useCallback, useRef } from 'react';
import { LOCAL_USER_ID, probeBridgeSession } from '@/shared/auth/bridgeSession';
import { queryClient } from '@/app/providers/queryClient';
import { isRuntimeQueryKey } from '@/integrations/runtime/connection';
import { RuntimeConnectionProvider, useRuntimeConnection } from '@/integrations/runtime/RuntimeConnectionProvider';
import { requireContextValue } from './contextGuard';

interface AuthContextType {
  userId: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  authError: Error | null;
  isRetryingAuth: boolean;
  retryAuth: () => Promise<void>;
}
const AuthContext = createContext<AuthContextType | undefined>(undefined);

/** Boot/auth seam: one health probe of the Astrid bridge (`astridBase()`) per boot IS the session
 * (doc 27 §local-trust). A healthy bridge resolves the fixed local user;
 * failure remains unauthenticated and exposes a manual recovery action.
 * The per-boot request token lives at the vite-proxy layer and never
 * reaches browser code.
 *
 * On the hosted build (a Runtime origin is configured) the boot gate owns the probe instead:
 * a readable authenticated health response establishes transport authentication, while workspace
 * features still wait for a successful connection (`RuntimeConnectionProvider`). Permission is
 * checked before anything is sent, and `isLoading` holds until the gate has an answer. */
export const AuthProvider = ({ children }: { children: ReactNode }) => (
  <RuntimeConnectionProvider onConnected={invalidateRuntimeQueries}>
    <AuthSession>{children}</AuthSession>
  </RuntimeConnectionProvider>
);

/** Marks whatever the Runtime queries cached before the connection came up as stale. */
function invalidateRuntimeQueries() {
  void queryClient.invalidateQueries({ predicate: (query) => isRuntimeQueryKey(query.queryKey) });
}

const AuthSession = ({ children }: { children: ReactNode }) => {
  const connection = useRuntimeConnection();
  const gated = connection.gated;
  const [userId, setUserId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(!gated);
  const [authError, setAuthError] = useState<Error | null>(null);
  const [isRetryingAuth, setIsRetryingAuth] = useState(false);
  const requestRef = useRef(0);
  const mountedRef = useRef(false);

  const runBridgeProbe = useCallback(async (manual: boolean) => {
    const request = ++requestRef.current;
    if (manual) setIsRetryingAuth(true);
    else setIsLoading(true);
    try {
      const probe = await probeBridgeSession();
      if (!mountedRef.current || request !== requestRef.current) return;
      setUserId(probe.ok ? probe.userId : null);
      setAuthError(probe.ok ? null : new Error(probe.reason));
    } catch (error) {
      if (!mountedRef.current || request !== requestRef.current) return;
      setUserId(null);
      setAuthError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (mountedRef.current && request === requestRef.current) {
        setIsLoading(false);
        setIsRetryingAuth(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (gated) return () => { mountedRef.current = false; };
    void runBridgeProbe(false);
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, [gated, runBridgeProbe]);

  const retryAuth = useCallback(async () => {
    if (!gated) await runBridgeProbe(true);
  }, [gated, runBridgeProbe]);

  const { isAuthenticated, isBooting } = connection;
  const value = useMemo(
    () => gated
      ? {
          userId: isAuthenticated ? LOCAL_USER_ID : null,
          isAuthenticated,
          isLoading: isBooting,
          authError: null,
          isRetryingAuth: false,
          retryAuth: async () => {},
        }
      : { userId, isAuthenticated: !!userId, isLoading, authError, isRetryingAuth, retryAuth },
    [gated, isAuthenticated, isBooting, userId, isLoading, authError, isRetryingAuth, retryAuth],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => requireContextValue(useContext(AuthContext), 'useAuth', 'AuthProvider');
const NO_AUTH: AuthContextType = Object.freeze({
  userId: null,
  isAuthenticated: false,
  isLoading: false,
  authError: null,
  isRetryingAuth: false,
  retryAuth: async () => {},
});
export const useAuthSafe = (): AuthContextType => useContext(AuthContext) ?? NO_AUTH;
