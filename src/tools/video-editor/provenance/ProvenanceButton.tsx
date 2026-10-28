import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@/shared/components/ui/button.tsx';
import { cn } from '@/shared/components/ui/contracts/cn.ts';
import { COARSE_TOUCH_TARGET } from '@/shared/components/ui/contracts/touchTarget.ts';
import { ProvenanceOverlay } from './ProvenanceOverlay.tsx';

/** Sits beside "New project"; reads only, so it stays available while other tools are busy. */
export function ProvenanceButton({ projectId, projectName }: {
  projectId: string | null;
  projectName?: string | null;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn('h-7 shrink-0 gap-1.5 rounded-md border border-border/70 bg-card/80 px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground', COARSE_TOUCH_TARGET)}
        onClick={() => setOpen(true)}
        disabled={!projectId}
        aria-label="Asset provenance"
        title="See where each asset came from"
      >
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
        {/* Phones keep the icon: the caption would push the header onto a second line. */}
        <span className="hidden sm:inline">Provenance</span>
      </Button>
      <ProvenanceOverlay
        open={open}
        onOpenChange={setOpen}
        projectId={projectId}
        projectName={projectName}
      />
    </>
  );
}
