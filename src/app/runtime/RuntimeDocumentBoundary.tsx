import React, { useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { RuntimeConnectionGate, type RuntimeConnectionPanelExit, type RuntimeConnectionValue } from '@/integrations/runtime/RuntimeConnectionProvider';
import { RuntimeConnectionPanel } from '@/shared/components/RuntimeConnection/RuntimeConnectionPanel';
import { RuntimeConnectionPill } from '@/shared/components/RuntimeConnection/RuntimeConnectionPill';
import { RuntimeAuthorityProvider } from './RuntimeAuthorityProvider';
import { resolveRuntimeAuthority } from './runtimeAuthority';
import { RuntimeDocumentNormalizationGate } from './RuntimeDocumentNormalizationGate';
import { isWorkspaceRoute } from './runtimeDocument';

/**
 * The editor's panel: the same connection step the onboarding shows (the card, Chrome's prompt pointer, the site-settings
 * steps), drawn in place of the editor before it has connected and over the still-mounted editor after. It renders the
 * permission explanation; the connection gate owns explicit installer, landing-page, and onboarding requests. It never navigates.
 */
export function EditorConnectionPanel({ connection, exit }: { connection: RuntimeConnectionValue; exit: RuntimeConnectionPanelExit | null }) {
  return <RuntimeConnectionPanel connection={connection} exit={exit} />;
}

/** Holds data providers until Runtime is connected and the opening document identity is canonical. */
export function RuntimeDocumentBoundary({ children }: { children: React.ReactNode }) {
  const { pathname, search } = useLocation();
  const authority = useMemo(
    () => resolveRuntimeAuthority(search, pathname),
    [pathname, search],
  );
  const content = <RuntimeAuthorityProvider value={authority}>{children}</RuntimeAuthorityProvider>;
  if (!isWorkspaceRoute(pathname)) return content;
  return (
    <RuntimeConnectionGate
      panel={(connection, exit) => <EditorConnectionPanel connection={connection} exit={exit} />}
      pill={(connection) => <RuntimeConnectionPill connection={connection} />}
    >
      <RuntimeDocumentNormalizationGate>{content}</RuntimeDocumentNormalizationGate>
    </RuntimeConnectionGate>
  );
}
