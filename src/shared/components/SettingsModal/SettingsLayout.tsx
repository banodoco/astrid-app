import { useId, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { Card } from '@/shared/components/ui/card.tsx';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/shared/components/ui/collapsible.tsx';

/*
 * The one layout every App Settings section uses, so they read as one design. Text sizes, top to bottom:
 *   section title   text-base semibold, above its card
 *   row label       text-sm medium
 *   row description text-sm muted, directly under the label
 *   fine print      text-xs muted (detail headings, paths, check marks)
 * A row's one action sits at its top right; anything bigger goes under the label, full width.
 */

/** A titled group of rows: the title above, the rows in one card divided by rules. */
export function SettingsSection({ id, title, children }: { readonly id?: string; readonly title: string; readonly children: ReactNode }) {
  const titleId = useId();
  return <section id={id} aria-labelledby={titleId} className="space-y-2">
    <h2 id={titleId} className="px-1 text-base font-semibold text-foreground">{title}</h2>
    <Card className="divide-y divide-border text-sm">{children}</Card>
  </section>;
}

interface RowHeaderProps {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
}

function RowHeader({ label, description, action }: RowHeaderProps) {
  return <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
    <div className="min-w-0 flex-1 space-y-1">
      <div className="font-medium text-foreground">{label}</div>
      {description && <div className="space-y-1 text-muted-foreground [overflow-wrap:anywhere]">{description}</div>}
    </div>
    {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
  </div>;
}

/** One setting: a label, an optional description and top-right action, and any content beneath. */
export function SettingsRow({ children, ...header }: RowHeaderProps & { readonly children?: ReactNode }) {
  return <div className="space-y-3 p-4">
    <RowHeader {...header} />
    {children}
  </div>;
}

/**
 * A row whose label opens more detail beneath it. The action stays at the top right, visible while the
 * detail is folded, so the row's main step never waits behind the disclosure; `notice` (such as the
 * action's own failure) shows under the label whether or not the detail is open.
 */
export function SettingsDisclosureRow({ label, description, action, notice, open, onOpenChange, children }: RowHeaderProps & {
  readonly label: string;
  readonly notice?: ReactNode;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly children: ReactNode;
}) {
  const trigger = <CollapsibleTrigger className="group -mx-1 inline-flex items-center gap-1 rounded-sm px-1 font-medium text-foreground hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
    {label}
    <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" aria-hidden />
  </CollapsibleTrigger>;
  return <Collapsible open={open} onOpenChange={onOpenChange ? (next) => onOpenChange(next) : undefined} className="space-y-3 p-4">
    <RowHeader label={trigger} description={description} action={action} />
    {notice}
    <CollapsibleContent className="space-y-4">{children}</CollapsibleContent>
  </Collapsible>;
}

/** A small heading for one group of facts inside a row's detail. */
export function SettingsDetail({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return <div>
    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
    {children}
  </div>;
}

/** A label and value inside a `<dl>`: the facts a row's detail lists. */
export function SettingsValue({ label, value, title }: { readonly label: string; readonly value: string | number; readonly title?: string }) {
  return <div className="flex items-center justify-between gap-4">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="min-w-0 break-all text-right font-medium" title={title}>{value}</dd>
  </div>;
}
