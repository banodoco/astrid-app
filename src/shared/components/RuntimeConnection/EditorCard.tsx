import { useState, type HTMLAttributes, type ReactNode } from 'react';
import { ChevronDown, ChevronLeft } from 'lucide-react';
import { Button } from '@/shared/components/ui/button.tsx';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/shared/components/ui/collapsible.tsx';
import { cn } from '@/shared/components/ui/contracts/cn.ts';

const AVATAR_SRC = '/astrid-app-icon-192.png';

/** The optional footer strip at the bottom of an editor card. */
export function EditorCardFoot({ children }: { readonly children: ReactNode }) {
  return <div className="flex min-h-12 shrink-0 items-center justify-center gap-2 border-t border-border/70 bg-muted/40 px-[22px] py-3 text-[13px] text-muted-foreground">{children}</div>;
}

/** A centered onboarding or recovery card with Astrid's icon (unless `icon` is false) and serif heading. */
export function EditorCard({ title, sentence, children, foot, topLeft, scrollContent = false, icon = true }: { readonly title: ReactNode; readonly sentence?: ReactNode; readonly children?: ReactNode; readonly foot?: ReactNode; readonly topLeft?: ReactNode; readonly scrollContent?: boolean; readonly icon?: boolean }) {
  return <div className={cn('relative overflow-hidden rounded-[18px] border border-border bg-card text-center shadow-[0_24px_60px_-24px_rgb(37_36_31/0.45),0_2px_8px_rgb(37_36_31/0.08)]', scrollContent && 'flex max-h-[calc(100dvh-2rem)] flex-col')}>
    {topLeft && <div className="absolute left-3 top-3">{topLeft}</div>}
    <div className={cn('space-y-4 p-[22px] pt-[26px]', scrollContent && 'flex min-h-0 flex-col space-y-3 p-4 pt-5 sm:p-5')}>
      <header className="grid shrink-0 justify-items-center gap-3">
        {/* The icon file carries its own rounded tile and shadow, as the install dialog shows it at this size. */}
        {icon && <img src={AVATAR_SRC} alt="" className="-mb-1.5 h-[76px] w-[76px]" />}
        <div className="space-y-1">
          <h1 className="text-balance font-serif font-theme-heading text-[25px] font-normal leading-tight text-foreground">{title}</h1>
          {sentence != null && <p className="text-balance text-sm leading-6 text-muted-foreground">{sentence}</p>}
        </div>
      </header>
      {scrollContent ? <div className="min-h-0 space-y-3 overflow-y-auto overscroll-contain">{children}</div> : children}
    </div>
    {foot}
  </div>;
}

/** A compact disclosure for optional details within an editor card. */
export function CardDisclosure({ label, openLabel, children }: { readonly label: string; readonly openLabel?: string; readonly children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <Collapsible open={open} onOpenChange={setOpen}>
    <CollapsibleTrigger className="mx-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[13px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {open ? (openLabel ?? label) : label}<ChevronDown aria-hidden="true" className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
    </CollapsibleTrigger>
    <CollapsibleContent className="mt-2 rounded-xl border border-border/70 bg-muted/30 p-3 text-left text-[13px] leading-5 text-muted-foreground">{children}</CollapsibleContent>
  </Collapsible>;
}

/** A paper-colored page frame for recovery cards shown without the editor shell. */
export function EditorCardPage({ children, ...props }: HTMLAttributes<HTMLElement>) {
  return <main {...props} className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
    <div className="w-full max-w-[576px]">{children}</div>
  </main>;
}

/** On a touch screen its hit area grows to 44 px (up and out, so the card's layout does not move). */
export function BackButton({ onBack }: { readonly onBack: () => void }) {
  return <Button type="button" variant="ghost" className="inline-flex h-auto items-center gap-0.5 rounded-md py-1 pl-1 pr-2 text-[13px] text-muted-foreground hover:bg-muted/60 hover:text-foreground [@media(pointer:coarse)]:-mt-2 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:pr-3 [@media(pointer:coarse)]:text-sm" onClick={onBack}><ChevronLeft aria-hidden="true" className="h-4 w-4" />Back</Button>;
}
