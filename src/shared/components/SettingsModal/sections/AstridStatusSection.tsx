import { useEffect, useState } from 'react';
import { CheckCircle2, ChevronRight, CircleAlert, Loader2 } from 'lucide-react';
import { AstridRuntimeClient } from '@/integrations/runtime/client.ts';
import { useRuntimeConnection } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';
import type { Health, Realm, ServiceStatus } from '@/integrations/runtime/generated.ts';
import { Button } from '@/shared/components/ui/button';
import { SetupStatusLine } from '@/shared/components/RuntimeConnection/SetupStatusLine.tsx';
import { describeFailure, RUNTIME_CONNECTION_COPY, withCommandShell } from '@/shared/components/RuntimeConnection/copy.ts';
import { connectionStatus } from './ConnectionSection.tsx';
import { useInstallerUpdate } from '@/shared/lib/updates/useInstallerUpdate.ts';
import { ASTRID_HELP_URL } from '@/integrations/astrid/help.ts';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/shared/components/ui/collapsible';
import { Card } from '@/shared/components/ui/card';
import { CopyInstallCommand } from '@/shared/components/RuntimeConnection/CopyInstallCommand.tsx';
import { UpdateResolutionActions } from '@/shared/components/RuntimeConnection/UpdateResolutionActions.tsx';
import { ASTRID_STATUS_COPY as COPY, connectionStatusCopy } from './astridStatusCopy.ts';

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
  if (status === 'connected') return <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-500" aria-hidden />;
  if (status === 'connecting') return <Loader2 className="h-4 w-4 animate-spin" aria-hidden />;
  return <CircleAlert className="h-4 w-4 text-muted-foreground" aria-hidden />;
}

/** `sha256:ec06fbc6…94f6b9`: enough to compare by eye; the full value is the tooltip and is selectable. */
function shortDigest(digest: string): string {
  const colon = digest.indexOf(':') + 1;
  return digest.length - colon > 16 ? `${digest.slice(0, colon + 8)}…${digest.slice(-6)}` : digest;
}

function StatusRow({ label, value, title }: { label: string; value: string | number; title?: string }) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all text-right font-medium" title={title}>{value}</dd>
    </div>
  );
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

  // The install type comes from the same identity-based rule as the Settings Updates section and the header notice.
  const { installType } = useInstallerUpdate(connection);
  const summary = connectionStatus(connection, installType);
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

  return (
    <section className="mb-6" aria-labelledby="astrid-status-title">
      <Card className="p-4">
        <div className="flex items-start gap-3">
          {statusIcon(summary.outOfDate ? 'update_needed' : connected ? needsRepair ? 'degraded' : 'connected' : status)}
          <div className="min-w-0 flex-1 space-y-3">
            <div>
              <h2 id="astrid-status-title" className="text-base font-semibold">{COPY.title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{COPY.description}</p>
              <p className="mt-2 text-sm font-medium" role="status" aria-live="polite">{statusText}</p>
            </div>

            {summary.checks && <SetupStatusLine checks={summary.checks} mink={false} announce={false} />}
            {(!connected || summary.outOfDate) && summary.detail && <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{summary.outOfDate ? withCommandShell(summary.detail) : summary.detail}</p>}
            {summary.outOfDate === 'runtime' && summary.updateResolution && <UpdateResolutionActions resolution={summary.updateResolution} />}
            {summary.outOfDate === 'chat' && <CopyInstallCommand mode="update" />}
            {summary.connect && <Button type="button" variant="retro-secondary" size="retro-sm" onClick={() => connection.connect()}>{RUNTIME_CONNECTION_COPY.permission.connect}</Button>}
            {connected && details && needsRepair && (
              <>
                <CopyInstallCommand
                  mode="install"
                  services={services.filter((service) => service.state === 'failed' || service.reason || service.last_exit !== null)}
                />
                <a className="text-sm text-muted-foreground underline underline-offset-4" href={ASTRID_HELP_URL} target="_blank" rel="noreferrer">Get help</a>
              </>
            )}

            {(loadFailed || !connected && status !== 'connecting' && status !== 'needs_permission') && (
              <a className="text-sm text-muted-foreground underline underline-offset-4" href={ASTRID_HELP_URL} target="_blank" rel="noreferrer">Get help</a>
            )}

            {connected && details && (
              <Collapsible className="border-t pt-2">
                <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                  <ChevronRight className="h-3 w-3 transition-transform group-data-[panel-open]:rotate-90" aria-hidden />
                  {COPY.detailsToggle}
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-4 pt-3">
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{COPY.workspace}</h3>
                  <dl className="space-y-1.5">
                    <StatusRow label={COPY.workspaceName} value={details.realm.display_name} />
                  </dl>
                </div>
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{COPY.connectionDetails}</h3>
                  <dl className="space-y-1.5">
                    <StatusRow label={COPY.protocol} value={details.health.protocol} />
                    <StatusRow label={COPY.schema} value={shortDigest(details.health.schema_digest)} title={details.health.schema_digest} />
                  </dl>
                </div>
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{COPY.running}</h3>
                  {loadFailed || !hasServiceDetails ? (
                    <p className="text-sm text-muted-foreground">{COPY.detailsUnavailable}</p>
                  ) : services.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{COPY.noServices}</p>
                  ) : (
                    <ul className="space-y-2">
                      {services.map((service) => {
                        const metadata = serviceMetadata(service);
                        return (
                          <li key={service.name} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm">
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
                </div>
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        </div>
      </Card>
    </section>
  );
}
