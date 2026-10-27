import { useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/shared/components/ui/button.tsx';
import { cn } from '@/shared/components/ui/contracts/cn.ts';
import { useTimelineEditorOps, useTimelineStoreApi } from '@/tools/video-editor/hooks/timelineStore.ts';
import { useVideoEditorRuntime } from '@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx';

/** A native picker feeding the same import/placement recipe as a Finder drop. */
export function TimelineAddMediaButton({ disabled = false, touch = false }: { disabled?: boolean; touch?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const ops = useTimelineEditorOps();
  const store = useTimelineStoreApi();
  const runtime = useVideoEditorRuntime();
  const readOnly = runtime.timelineEditability?.checkTimeline?.().allowed === false;
  return (
    <>
      <Button type="button" variant="ghost" disabled={disabled || busy || readOnly}
        className={cn('shrink-0 gap-1 px-2 text-xs', touch ? 'h-11 rounded-full border border-border bg-card/95' : 'h-6')}
        onClick={() => input.current?.click()} aria-busy={busy || undefined}>
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        Add media
      </Button>
      {/* No accept filter: the drop recipe owns supported media validation. */}
      <input ref={input} type="file" multiple hidden aria-label="Add media files" onChange={async event => {
        const files = Array.from(event.currentTarget.files ?? []);
        event.currentTarget.value = '';
        if (!files.length) return;
        setBusy(true);
        try { await ops.addMediaFiles(files, store.getState().playback.currentTime); }
        finally { setBusy(false); }
      }} />
    </>
  );
}
