import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { Button } from '@/shared/components/ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/shared/components/ui/dialog.tsx';
import { Input } from '@/shared/components/ui/input.tsx';
import { cn } from '@/shared/components/ui/contracts/cn.ts';
import { ProvenanceDetail } from './ProvenanceDetail.tsx';
import { ObjectThumb, OriginChip } from './ProvenanceParts.tsx';
import { formatBytes } from './provenanceModel.ts';
import { useProvenance } from './useProvenance.ts';
import type { ProvenanceRecord } from './types.ts';

interface ProvenanceOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | null;
  projectName?: string | null;
}

function AssetRow({ record, selected, onSelect }: {
  record: ProvenanceRecord;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md border px-2 py-1.5 text-left transition-colors',
        selected
          ? 'border-primary/40 bg-accent'
          : 'border-transparent hover:border-border hover:bg-muted/60',
      )}
    >
      <ObjectThumb objectId={record.objectId} mediaType={record.mediaType} filename={record.filename} className="h-9 w-12 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11.5px] font-medium" title={record.filename}>{record.filename}</span>
        <span className="mt-0.5 block truncate text-[10.5px] text-muted-foreground">
          {formatBytes(record.size)}
          {record.uses.length ? ` · used in ${record.uses.length}` : ''}
        </span>
      </span>
      {record.origin === 'unknown' ? null : <OriginChip origin={record.origin} />}
    </button>
  );
}

/**
 * Queries live here, and this mounts only while the sheet is open: the header that
 * carries the trigger renders in tests and in other tools without a QueryClient, so
 * an always-mounted panel would take the whole page down.
 */
function ProvenancePanel({ projectId, projectName }: Omit<ProvenanceOverlayProps, 'open' | 'onOpenChange'>) {
  const { records, total, limits, timelinesScanned, isLoading, error, refetch } = useProvenance(projectId, true);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (selectedId && records.some(record => record.objectId === selectedId)) return;
    setSelectedId(records[0]?.objectId ?? null);
  }, [records, selectedId]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return records;
    return records.filter(record =>
      record.filename.toLowerCase().includes(needle)
      || record.mediaType.toLowerCase().includes(needle)
      || record.producer.label.toLowerCase().includes(needle));
  }, [query, records]);

  const selected = filtered.find(record => record.objectId === selectedId) ?? filtered[0] ?? null;

  return (
    <>
      <header className="flex flex-wrap items-center gap-3 border-b border-border py-3 pl-5 pr-12">
          <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold leading-tight">Provenance</h2>
            <p className="text-[10.5px] text-muted-foreground">
              {projectName ? `${projectName} · ` : ''}recorded by the Runtime, not by the pack
            </p>
          </div>
          <div className="relative ml-auto w-56">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Filter assets"
              aria-label="Filter assets"
              className="h-8 pl-7 text-xs focus-visible:ring-1 focus-visible:ring-border"
            />
          </div>
          <Button type="button" size="sm" variant="ghost" className="h-8 gap-1.5 px-2 text-xs" onClick={refetch}>
            <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} aria-hidden="true" />
            Refresh
          </Button>
        </header>

        <div className="grid min-h-0 grid-cols-[288px_minmax(0,1fr)]">
          <div className="flex min-h-0 flex-col border-r border-border">
            <div className="flex items-baseline justify-between px-3 pb-1 pt-2.5">
              <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                Assets
              </span>
              <span className="text-[10.5px] text-muted-foreground">{filtered.length}</span>
            </div>
            <div className="min-h-0 flex-1 space-y-0.5 overflow-auto px-1.5 pb-2">
              {filtered.map(record => (
                <AssetRow
                  key={record.objectId}
                  record={record}
                  selected={record.objectId === selected?.objectId}
                  onSelect={() => setSelectedId(record.objectId)}
                />
              ))}
              {!filtered.length && !isLoading ? (
                <p className="px-2 py-6 text-center text-[11.5px] text-muted-foreground">
                  {records.length ? 'No asset matches that filter.' : 'No managed objects in this project yet.'}
                </p>
              ) : null}
              {isLoading ? <p className="px-2 py-6 text-center text-[11.5px] text-muted-foreground">Reading the workspace…</p> : null}
            </div>
            <p
              className="border-t border-border px-3 py-2 text-[10px] leading-relaxed text-muted-foreground"
              title={limits.length ? limits.join('\n') : undefined}
            >
              {total} object{total === 1 ? '' : 's'}
              {timelinesScanned ? ` · ${timelinesScanned} timeline${timelinesScanned === 1 ? '' : 's'} scanned` : ''}
              {limits.length ? ` · read stopped early (${limits.length})` : ''}
            </p>
          </div>

          <div className="min-h-0">
            {error ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
                <p className="text-[12.5px] font-medium">Could not read this project’s records</p>
                <p className="text-[11.5px] text-muted-foreground">{error.message}</p>
                <Button type="button" size="sm" variant="outline" onClick={refetch}>Try again</Button>
              </div>
            ) : selected ? (
              <ProvenanceDetail record={selected} projectId={projectId} />
            ) : isLoading ? (
              <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">Loading provenance…</div>
            ) : (
              <div className="flex h-full items-center justify-center px-8 text-center text-[12px] text-muted-foreground">
                Select an asset to see where it came from.
              </div>
            )}
          </div>
        </div>
    </>
  );
}

export function ProvenanceOverlay({ open, onOpenChange, projectId, projectName }: ProvenanceOverlayProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="grid h-[84vh] w-[min(1120px,94vw)] max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:rounded-xl"
        aria-label="Asset provenance"
      >
        <DialogTitle className="sr-only">Asset provenance</DialogTitle>
        <DialogDescription className="sr-only">
          Where each asset in this project came from, what produced it, and where it is used.
        </DialogDescription>
        {open ? <ProvenancePanel projectId={projectId} projectName={projectName} /> : null}
      </DialogContent>
    </Dialog>
  );
}
