import { useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, Loader2 } from 'lucide-react';
import { AstridRuntimeClient } from '@/integrations/runtime/client.ts';
import { useRuntimeConnection } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';
import type { Health, Realm, ServiceStatus } from '@/integrations/runtime/generated.ts';
import { Button } from '@/shared/components/ui/button';
import { SetupStatusLine } from '@/shared/components/RuntimeConnection/SetupStatusLine.tsx';
import { describeFailure, RUNTIME_CONNECTION_COPY } from '@/shared/components/RuntimeConnection/copy.ts';
import { connectionStatus } from './ConnectionSection.tsx';
import { ASTRID_HELP_URL } from '@/integrations/astrid/help.ts';
import { CopyInstallCommand } from '@/shared/components/RuntimeConnection/CopyInstallCommand.tsx';
import { ASTRID_STATUS_COPY as COPY, connectionStatusCopy } from './astridStatusCopy.ts';
import { SettingsDetail, SettingsDisclosureRow, SettingsRow, SettingsSection, SettingsValue } from '../SettingsLayout.tsx';

const POLL_INTERVAL_MS = 5_000;

type RuntimeService = ServiceStatus;
type RuntimeDetails = { health: Health; realm: Realm };

function isRuntimeService(value: unknown): value is RuntimeService {
  if (!value || typeof value !== 'object') return false;
  const service = value as Partial<RuntimeService>;
  return typeof service.name === 'string'
    && ['starting', 'running', 'restarting', 'failed'].includes(String(service.state))
    && (typeof service.last_exit === 'number' || service.last_exit === null)
    && typeof service.restart_count === 'number'
    && (service.reason === undefined || typeof service.reason === 'string' || service.reason === null);
}

function statusIcon(status: string) {
  if (status === 'connected') return <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600 dark:text-green-500" aria-hidden />;
  if (status === 'connecting') return <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />;
  return <CircleAlert className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />;
}

/** `sha256:ec06fbc6…94f6b9`: enough to compare by eye; the full value is the tooltip and is selectable. */
function shortDigest(digest: string): string {
  const colon = digest.indexOf(':') + 1;
  return digest.length - colon > 16 ? `${digest.slice(0, colon + 8)}…${digest.slice(-6)}` : digest;
}

function serviceMetadata(service: RuntimeService): string[] {
  const failure = describeFailure(service);
  return [
    COPY.restartCount(service.restart_count),
    failure.summary,
    failure.lastExit === null ? null : COPY.lastExit(failure.lastExit),
    failure.logPath ? COPY.serviceLog(failure.logPath) : null,
  ].filter((value): value is string => value !== null);
}

export function AstridStatusSection({ isOpen }: { isOpen: boolean }) {
  const connection = useRuntimeConnection();
  const [details, setDetails] = useState<RuntimeDetails | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const connected = connection.state.status === 'connected';

  useEffect(() => {
    if (!isOpen || !connected) {
      setDetails(null);
      setLoadFailed(false);
      return undefined;
    }

    let active = true;
    let reading = false;
    const runtimeClient = new AstridRuntimeClient();
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const current = await runtimeClient.readStatus();
        if (active) {
          setDetails(current);
          setLoadFailed(false);
        }
      } catch {
        if (active) {
          setDetails(null);
          setLoadFailed(true);
        }
      } finally {
        reading = false;
      }
    };
    setDetails(null);
    setLoadFailed(false);
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [isOpen, connected]);

  const summary = connectionStatus(connection);
  const status = connection.state.status;
  const rawServices = details?.health.services;
  const hasServiceDetails = Array.isArray(rawServices) && rawServices.every(isRuntimeService);
  const services = Array.isArray(rawServices) ? rawServices.filter(isRuntimeService) : [];
  const needsRepair = details?.health.status === 'degraded' || services.some((service) => service.state === 'failed');
  const statusText = summary.outOfDate === 'chat'
    ? COPY.chatUpdateNeeded
    : summary.outOfDate
    ? COPY.updateNeeded
    : connected
    ? loadFailed ? COPY.unavailable : needsRepair ? COPY.degraded : details ? COPY.connected : COPY.checking
    : connectionStatusCopy(status);

  const getHelp = <a className="text-muted-foreground underline underline-offset-4" href={ASTRID_HELP_URL} target="_blank" rel="noreferrer">Get help</a>;
  return (
    <SettingsSection title={COPY.title}>
      <SettingsRow
        label={<span className="flex items-center gap-2">
          {statusIcon(summary.outOfDate ? 'update_needed' : connected ? needsRepair ? 'degraded' : 'connected' : status)}
          <span role="status" aria-live="polite">{statusText}</span>
        </span>}
        // An old Astrid is only named here: Settings → Updates is the one place to update it, with the path for this install.
        description={summary.outOfDate ? COPY.outOfDateDetail[summary.outOfDate] : !connected ? summary.detail : undefined}
        action={summary.connect && <Button type="button" variant="retro-secondary" size="retro-sm" onClick={() => connection.connect()}>{RUNTIME_CONNECTION_COPY.permission.connect}</Button>}
      >
        {summary.checks && <SetupStatusLine checks={summary.checks} mink={false} announce={false} className="items-start" />}
        {connected && details && needsRepair && (
          <>
            <CopyInstallCommand
              mode="install"
              services={services.filter((service) => service.state === 'failed' || service.reason || service.last_exit !== null)}
            />
            <p>{getHelp}</p>
          </>
        )}
        {(loadFailed || !connected && status !== 'connecting' && status !== 'needs_permission') && <p>{getHelp}</p>}
      </SettingsRow>

      {connected && details && (
        <SettingsDisclosureRow label={COPY.detailsToggle} description={COPY.description}>
          <SettingsDetail title={COPY.workspace}>
            <dl className="space-y-1.5">
              <SettingsValue label={COPY.workspaceName} value={details.realm.display_name} />
            </dl>
          </SettingsDetail>
          <SettingsDetail title={COPY.connectionDetails}>
            <dl className="space-y-1.5">
              <SettingsValue label={COPY.protocol} value={details.health.protocol} />
              <SettingsValue label={COPY.schema} value={shortDigest(details.health.schema_digest)} title={details.health.schema_digest} />
            </dl>
          </SettingsDetail>
          <SettingsDetail title={COPY.running}>
            {loadFailed || !hasServiceDetails ? (
              <p className="text-muted-foreground">{COPY.detailsUnavailable}</p>
            ) : services.length === 0 ? (
              <p className="text-muted-foreground">{COPY.noServices}</p>
            ) : (
              <ul className="space-y-2">
                {services.map((service) => {
                  const metadata = serviceMetadata(service);
                  return (
                    <li key={service.name} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <span className="font-medium">{COPY.serviceName(service.name)}</span>
                      <span className={service.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>
                        {COPY.serviceStates[service.state]}
                      </span>
                      {metadata.length > 0 && (
                        <span className="basis-full text-xs text-muted-foreground">{metadata.join(' · ')}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </SettingsDetail>
        </SettingsDisclosureRow>
      )}
    </SettingsSection>
  );
}
