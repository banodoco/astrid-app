import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Copy, Download, ShieldCheck } from 'lucide-react';
import { AstridRuntimeClient } from '@/integrations/runtime/client.ts';
import { Button } from '@/shared/components/ui/button.tsx';
import { useCopyToClipboard } from '@/shared/hooks/clipboard/useCopyToClipboard.ts';
import { cn } from '@/shared/components/ui/contracts/cn.ts';
import { formatBytes, formatWhen, receiptJson, shortDigest } from './provenanceModel.ts';
import type { ProvenanceRecord } from './types.ts';
import { Chip, FactGrid, MonoId, ObjectThumb, OriginChip, Section } from './ProvenanceParts.tsx';

const ORIGIN_SENTENCE: Record<ProvenanceRecord['origin'], string> = {
  generated: 'This file was generated inside Astrid.',
  rendered: 'This file was rendered from a timeline.',
  imported: 'This file was imported, so it has no generation behind it.',
  unknown: 'Astrid holds these bytes but has no record of what made them.',
};

function ProducerLine({ record }: { record: ProvenanceRecord }) {
  const { producer } = record;
  if (producer.kind === 'unknown') {
    return <p className="text-[12px] text-muted-foreground">No capability, task or generation is attached to this object.</p>;
  }
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[11.5px] font-medium">{producer.label}</span>
        {producer.status ? <Chip className="uppercase tracking-wide">{producer.status}</Chip> : null}
        {formatWhen(producer.createdAt) ? <span className="text-[11px] text-muted-foreground">{formatWhen(producer.createdAt)}</span> : null}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {producer.taskId ? <MonoId label="task" value={producer.taskId.slice(0, 10)} /> : null}
        {producer.runId ? <MonoId label="run" value={producer.runId.slice(0, 10)} /> : null}
        {producer.attemptId ? <MonoId label="attempt" value={producer.attemptId.slice(0, 10)} /> : null}
        {producer.generationId ? <MonoId label="generation" value={producer.generationId.replace('generation-task-', '').slice(0, 10)} /> : null}
      </div>
    </div>
  );
}

function Integrity({ projectId, record }: { projectId: string | null; record: ProvenanceRecord }) {
  const client = useMemo(() => new AstridRuntimeClient({ readOnly: true }), []);
  const location = useQuery({
    queryKey: ['provenance', 'location', projectId, record.objectId],
    enabled: Boolean(projectId),
    queryFn: () => client.getProjectObjectLocation(projectId as string, record.objectId),
    retry: false,
  });

  return (
    <Section title="Integrity">
      <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
        <p className="break-all font-mono text-[10.5px] leading-relaxed text-foreground/80">{record.digest}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-muted-foreground">
          <span>{location.data?.storage ?? 'runtime CAS'}</span>
          <span>{formatBytes(location.data?.size ?? record.size)} on disk</span>
          {location.data?.verified ? (
            <span className="inline-flex items-center gap-1 text-primary">
              <ShieldCheck className="h-3 w-3" aria-hidden="true" />
              digest matches on read
            </span>
          ) : null}
        </div>
      </div>
    </Section>
  );
}

export function ProvenanceDetail({ record, projectId }: { record: ProvenanceRecord; projectId: string | null }) {
  const receipt = useMemo(() => receiptJson(record), [record]);
  const { copied, handleCopy } = useCopyToClipboard(receipt);
  const prompt = record.prompt;

  const download = () => {
    const blob = new Blob([receipt], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${record.filename.replace(/\.[^.]+$/, '')}.provenance.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const variants = record.variants.length > 1 ? record.variants : [];

  return (
    <article className="flex h-full min-h-0 flex-col" aria-label={`Provenance for ${record.filename}`}>
      <header className="space-y-2 border-b border-border px-5 py-4">
        <div className="flex items-start gap-3">
          <ObjectThumb
            objectId={record.objectId}
            mediaType={record.mediaType}
            filename={record.filename}
            className="h-14 w-20 shrink-0"
          />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[13.5px] font-semibold" title={record.filename}>{record.filename}</h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {record.mediaType} · {formatBytes(record.size)}
              {formatWhen(record.createdAt) ? ` · ${formatWhen(record.createdAt)}` : ''}
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <OriginChip origin={record.origin} />
              <Chip className="font-mono" title={record.digest}>{shortDigest(record.digest)}</Chip>
              {record.uses.length ? <Chip>{record.uses.length} timeline{record.uses.length === 1 ? '' : 's'}</Chip> : null}
            </div>
          </div>
        </div>
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">{ORIGIN_SENTENCE[record.origin]}</p>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-auto px-5 py-4">
        <div className="max-w-[720px] space-y-5">
        <Section title="How it was made">
          <ProducerLine record={record} />
          <FactGrid facts={record.recipe.filter(fact => fact.label !== 'Prompt')} />
          {prompt ? (
            <blockquote className="rounded-md border border-border bg-muted/50 px-3 py-2 text-[11.5px] leading-relaxed text-foreground/90">
              {prompt}
            </blockquote>
          ) : null}
        </Section>

        {record.inputs.length ? (
          <Section title="Inputs" hint={`${record.inputs.length} object${record.inputs.length === 1 ? '' : 's'}`}>
            <div className="flex flex-wrap gap-2">
              {record.inputs.map(input => (
                <div key={input.objectId} className="w-24 space-y-1">
                  <ObjectThumb objectId={input.objectId} mediaType="image/*" filename={input.filename} className="h-14 w-24" />
                  <p className="truncate text-[10.5px] text-muted-foreground" title={input.filename ?? input.objectId}>
                    {input.filename ?? shortDigest(input.objectId)}
                  </p>
                </div>
              ))}
            </div>
          </Section>
        ) : null}

        {variants.length ? (
          <Section title="Same generation" hint={`${variants.length} variants`}>
            <div className="flex flex-wrap gap-2">
              {variants.map(variant => {
                const current = variant.objectId === record.objectId;
                return (
                  <div key={variant.objectId} className="w-24 space-y-1">
                    <ObjectThumb
                      objectId={variant.objectId}
                      mediaType={record.mediaType}
                      filename={null}
                      className={cn('h-14 w-24', current && 'ring-2 ring-primary ring-offset-1 ring-offset-background')}
                    />
                    <p className="truncate text-[10.5px] text-muted-foreground">
                      {current ? 'this asset' : variant.viewedAt ? 'viewed' : 'never viewed'}
                    </p>
                  </div>
                );
              })}
            </div>
          </Section>
        ) : null}

        <Integrity projectId={projectId} record={record} />

        <Section title="Used in">
          {record.uses.length ? (
            <ul className="space-y-1 text-[12px]">
              {record.uses.map(use => (
                <li key={use.timelineId} className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-sm bg-primary" aria-hidden="true" />
                  <span className="truncate">{use.timelineName}</span>
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">{use.timelineId.slice(0, 8)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12px] text-muted-foreground">
              No reference in the timelines Astrid can read. The Runtime has no object→usage query yet.
            </p>
          )}
        </Section>

        {record.gaps.length ? (
          <Section title="What the record does not say">
            <ul className="space-y-1 text-[11.5px] leading-relaxed text-muted-foreground">
              {record.gaps.map(gap => (
                <li key={gap} className="flex gap-2">
                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/50" aria-hidden="true" />
                  <span>{gap}</span>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
        </div>
      </div>

      <footer className="flex items-center gap-2 border-t border-border px-5 py-3">
        <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={handleCopy}>
          {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
          {copied ? 'Receipt copied' : 'Copy receipt'}
        </Button>
        <Button type="button" size="sm" variant="ghost" className="gap-1.5" onClick={download}>
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          .provenance.json
        </Button>
      </footer>
    </article>
  );
}
