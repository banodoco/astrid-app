import type { ReactNode } from 'react';
import { FileAudio, FileText, Film, Image as ImageIcon } from 'lucide-react';
import { runtimeApiBase } from '@/integrations/runtime/connection.ts';
import { cn } from '@/shared/components/ui/contracts/cn.ts';
import type { ProvenanceOrigin, ProvenanceRecipeFact } from './types.ts';

export function Section({ title, hint, children }: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{title}</h3>
        {hint ? <span className="text-[10.5px] text-muted-foreground/80">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

const ORIGIN_TONE: Record<ProvenanceOrigin, string> = {
  generated: 'border-primary/30 bg-primary/10 text-primary',
  rendered: 'border-border bg-muted text-foreground',
  imported: 'border-border bg-muted text-muted-foreground',
  recorded: 'border-border bg-muted text-foreground',
  unknown: 'border-dashed border-border bg-transparent text-muted-foreground',
};

const ORIGIN_LABEL: Record<ProvenanceOrigin, string> = {
  generated: 'generated',
  rendered: 'rendered',
  imported: 'imported',
  recorded: 'unclassified task',
  unknown: 'no record',
};

export function OriginChip({ origin }: { origin: ProvenanceOrigin }) {
  return (
    <span className={cn('inline-flex h-5 items-center rounded-md border px-1.5 text-[10.5px] font-semibold', ORIGIN_TONE[origin])}>
      {ORIGIN_LABEL[origin]}
    </span>
  );
}

export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex h-5 items-center gap-1 rounded-md border border-border bg-muted px-1.5 text-[10.5px] font-medium text-foreground', className)}>
      {children}
    </span>
  );
}

function iconFor(mediaType: string) {
  if (mediaType.startsWith('image/')) return ImageIcon;
  if (mediaType.startsWith('audio/')) return FileAudio;
  if (mediaType.startsWith('video/')) return Film;
  return FileText;
}

/** Bytes come from the workspace door; a failed load falls back to the type icon. */
export function ObjectThumb({ objectId, mediaType, filename, className }: {
  objectId: string;
  mediaType: string;
  filename: string | null;
  className?: string;
}) {
  const Icon = iconFor(mediaType);
  const isImage = mediaType.startsWith('image/');
  return (
    <div className={cn('relative overflow-hidden rounded-md border border-border bg-muted', className)}>
      <Icon className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 text-muted-foreground/70" aria-hidden="true" />
      {isImage ? (
        <img
          src={`${runtimeApiBase()}/v1/objects/${encodeURIComponent(objectId)}`}
          alt={filename ?? ''}
          loading="lazy"
          className="relative h-full w-full object-cover"
          onError={(event) => { event.currentTarget.style.display = 'none'; }}
        />
      ) : null}
    </div>
  );
}

export function FactGrid({ facts }: { facts: ProvenanceRecipeFact[] }) {
  if (!facts.length) return null;
  return (
    <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]">
      {facts.map(fact => (
        <div key={fact.label} className="contents">
          <dt className="text-muted-foreground">{fact.label}</dt>
          <dd className={cn('truncate', fact.mono && 'font-mono text-[11.5px]')} title={fact.value}>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function MonoId({ label, value }: { label: string; value: string }) {
  return (
    <span className="text-[10.5px] text-muted-foreground">
      {label} <span className="font-mono text-foreground/80">{value}</span>
    </span>
  );
}
