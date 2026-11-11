import { useId, useState } from 'react';
import { Download, Loader2, Terminal, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {actionStatus,downloadActionGroupLogs} from './actionGroupLogs';
import { cn } from '@/shared/components/ui/contracts/cn.ts';
import type { ConversationAttachment, ConversationToolCallPair, ConversationTurn } from './contracts.ts';
import { mediaCrossOrigin } from '@/shared/lib/media/mediaCrossOrigin';

const MAX_ATTACHMENT_PREVIEW_COUNT = 4;

type ConversationMessageProps = {
  turn: ConversationTurn;
  onAttachmentClick?: (attachment: ConversationAttachment) => void;
};

type ConversationToolGroupProps = {
  pairs: ConversationToolCallPair[];
  /** Start with the action details showing (the first-run tour's chat); the chat's own groups start collapsed. */
  defaultOpen?: boolean;
};

export type { ConversationAttachment } from './contracts.ts';

function formatAttachmentSummary(attachments: ConversationTurn['attachments']) {
  if (!attachments?.length) {
    return null;
  }

  const imageCount = attachments.filter((item) => item.mediaType === 'image').length;
  const videoCount = attachments.filter((item) => item.mediaType === 'video').length;
  const shotGroups = new Map<string, { count: number; expected: number; images: number; videos: number }>();
  attachments.forEach((item) => {
    if (
      !item.shotId
      || typeof item.shotSelectionClipCount !== 'number'
      || item.shotSelectionClipCount < 1
    ) return;
    const group = shotGroups.get(item.shotId) ?? { count: 0, expected: item.shotSelectionClipCount, images: 0, videos: 0 };
    group.count += 1;
    group.images += item.mediaType === 'image' ? 1 : 0;
    group.videos += item.mediaType === 'video' ? 1 : 0;
    shotGroups.set(item.shotId, group);
  });
  const fullShots = [...shotGroups.values()].filter((group) => group.count === group.expected);
  const fullShotIds = new Set(
    [...shotGroups.entries()]
      .filter(([, group]) => group.count === group.expected)
      .map(([shotId]) => shotId),
  );
  const shotImages = fullShots.reduce((sum, group) => sum + group.images, 0);
  const shotVideos = fullShots.reduce((sum, group) => sum + group.videos, 0);
  const remainingAttachments = attachments.filter(
    (attachment) => !(attachment.shotId && fullShotIds.has(attachment.shotId)),
  );
  const remainingImages = remainingAttachments.filter((item) => item.mediaType === 'image').length;
  const remainingVideos = remainingAttachments.length - remainingImages;
  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
  if (fullShots.length > 0) {
    const inside = [shotImages ? plural(shotImages, 'image') : '', shotVideos ? plural(shotVideos, 'video') : ''].filter(Boolean).join(', ');
    const more = [remainingImages ? plural(remainingImages, 'more image') : '', remainingVideos ? plural(remainingVideos, 'more video') : ''].filter(Boolean).join(', ');
    return `${plural(fullShots.length, 'shot')} (${inside})${more ? ` and ${more}` : ''} attached`;
  }
  return `${[imageCount ? plural(imageCount, 'image') : '', videoCount ? plural(videoCount, 'video') : ''].filter(Boolean).join(', ')} attached`;
}

// `toLocaleTimeString` builds a new Intl formatter on every call (slow on a phone, and a streaming reply renders every
// message every frame): one formatter for the session, and the label of each timestamp is computed once.
let timeFormat: Intl.DateTimeFormat | undefined;
const timestampLabels = new Map<string, string>();

function formatTimestamp(timestamp: string) {
  if (!timestamp) return '';
  const cached = timestampLabels.get(timestamp);
  if (cached !== undefined) return cached;
  const date = new Date(timestamp);
  const label = Number.isNaN(date.getTime())
    ? ''
    : (timeFormat ??= new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' })).format(date);
  if (timestampLabels.size > 500) timestampLabels.clear();
  timestampLabels.set(timestamp, label);
  return label;
}

type ConversationAttachmentStripProps = {
  attachments: readonly ConversationAttachment[];
  isUser: boolean;
  className?: string;
  onAttachmentClick?: (attachment: ConversationAttachment) => void;
  onRemoveAttachment?: (attachment: ConversationAttachment) => void;
  onRemoveShot?: (shotId: string) => void;
  maxPreviewCount?: number | null;
};

type AttachmentGroup =
  | {
    kind: 'shot';
    shotId: string;
    shotName?: string;
    attachments: ConversationAttachment[];
    expectedClipCount: number;
  }
  | {
    kind: 'attachment';
    attachment: ConversationAttachment;
  };

function buildAttachmentGroups(
  attachments: readonly ConversationAttachment[],
): AttachmentGroup[] {
  const shotGroups = new Map<string, {
    attachments: ConversationAttachment[];
    expectedClipCount: number;
    shotName?: string;
  }>();

  attachments.forEach((attachment) => {
    if (
      !attachment.shotId
      || typeof attachment.shotSelectionClipCount !== 'number'
      || attachment.shotSelectionClipCount < 1
    ) {
      return;
    }

    const existing = shotGroups.get(attachment.shotId);
    if (existing) {
      existing.attachments.push(attachment);
      return;
    }

    shotGroups.set(attachment.shotId, {
      attachments: [attachment],
      expectedClipCount: attachment.shotSelectionClipCount,
      shotName: attachment.shotName,
    });
  });

  const fullShotIds = new Set(
    Array.from(shotGroups.entries())
      .filter(([, group]) => group.attachments.length === group.expectedClipCount)
      .map(([shotId]) => shotId),
  );

  const groups: AttachmentGroup[] = [];
  const emittedShotIds = new Set<string>();

  attachments.forEach((attachment) => {
    if (attachment.shotId && fullShotIds.has(attachment.shotId)) {
      if (emittedShotIds.has(attachment.shotId)) {
        return;
      }

      const shotGroup = shotGroups.get(attachment.shotId);
      if (!shotGroup) {
        return;
      }

      groups.push({
        kind: 'shot',
        shotId: attachment.shotId,
        shotName: shotGroup.shotName,
        attachments: shotGroup.attachments,
        expectedClipCount: shotGroup.expectedClipCount,
      });
      emittedShotIds.add(attachment.shotId);
      return;
    }

    groups.push({
      kind: 'attachment',
      attachment,
    });
  });

  return groups;
}

export function ConversationAttachmentStrip({
  attachments,
  isUser,
  className,
  onAttachmentClick,
  onRemoveAttachment,
  onRemoveShot,
  maxPreviewCount = MAX_ATTACHMENT_PREVIEW_COUNT,
}: ConversationAttachmentStripProps) {
  const previewAttachments = maxPreviewCount === null
    ? attachments
    : attachments.slice(0, maxPreviewCount);
  const remainingCount = attachments.length - previewAttachments.length;
  const groups = buildAttachmentGroups(previewAttachments);

  const previewSurfaceClassName = cn(
    'h-10 w-10 overflow-hidden rounded-md border',
    isUser
      ? 'border-primary-foreground/20 bg-primary-foreground/10'
      : 'border-border/70 bg-muted/40',
  );

  const removeButtonClassName = cn(
    'absolute -right-1 -top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full border shadow-sm',
    isUser
      ? 'border-primary-foreground/30 bg-background/95 text-foreground hover:bg-background'
      : 'border-border/80 bg-background/95 text-foreground hover:bg-background',
  );

  const renderPreview = (
    attachment: ConversationAttachment,
    index: number,
    removeLabel: string,
  ) => {
    const isPlaceholder = attachment.isPlaceholder === true;
    const isInteractive = Boolean(onAttachmentClick && attachment.generationId && !isPlaceholder);
    const content = isPlaceholder ? (
      <div
        className="flex h-full w-full flex-col items-center justify-center gap-0.5 bg-muted/50 text-[8px] leading-none text-muted-foreground"
        aria-label={`Loading attached ${attachment.mediaType} ${index + 1}`}
      >
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        <span>Loading…</span>
      </div>
    ) : attachment.mediaType === 'video' ? (
      <video
        src={attachment.url}
        crossOrigin={mediaCrossOrigin(attachment.url)}
        className="h-full w-full object-cover"
        muted
        playsInline
        preload="metadata"
        aria-hidden="true"
      />
    ) : (
      <img
        src={attachment.url}
        crossOrigin={mediaCrossOrigin(attachment.url)}
        alt=""
        className="h-full w-full object-cover"
        loading="lazy"
      />
    );

    return (
      <div
        key={`${attachment.clipId}:${index}`}
        className={cn(
          'relative',
          isInteractive && 'transition-transform hover:scale-[1.03]',
        )}
      >
        <div className={previewSurfaceClassName}>
          {isInteractive ? (
            <button
              type="button"
              className="h-full w-full cursor-pointer"
              onClick={() => onAttachmentClick?.(attachment)}
              aria-label={`Open attached ${attachment.mediaType} ${index + 1}`}
            >
              {content}
            </button>
          ) : (
            <div
              className="h-full w-full"
              aria-label={`Attached ${attachment.mediaType} ${index + 1}`}
            >
              {content}
            </div>
          )}
        </div>
        {onRemoveAttachment && !isPlaceholder && (
          <button
            type="button"
            className={removeButtonClassName}
            aria-label={removeLabel}
            onClick={(event) => {
              event.stopPropagation();
              onRemoveAttachment(attachment);
            }}
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    );
  };

  return (
    <div className={cn('mt-2 flex flex-wrap gap-1.5', className)}>
      {groups.map((group, index) => {
        if (group.kind === 'shot') {
          return (
            <div
              key={`${group.shotId}:${index}`}
              className={cn(
                'relative inline-flex w-fit max-w-full flex-col self-start rounded-lg border p-1.5',
                isUser
                  ? 'border-primary-foreground/30 bg-primary-foreground/5'
                  : 'border-primary/30 bg-primary/5',
              )}
              aria-label={`${group.shotName ?? 'Shot'} group`}
            >
              {onRemoveShot && (
                <button
                  type="button"
                  className={removeButtonClassName}
                  aria-label={`Deselect ${group.shotName ?? 'shot'}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRemoveShot(group.shotId);
                  }}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
              <div
                className="mb-1 max-w-20 truncate px-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground"
                title={group.shotName ?? 'Shot'}
              >
                {group.shotName ?? 'Shot'} ({group.expectedClipCount})
              </div>
              <div className="flex flex-wrap gap-1.5">
                {group.attachments.map((attachment, groupIndex) => (
                  renderPreview(
                    attachment,
                    groupIndex,
                    `Deselect ${attachment.mediaType} ${groupIndex + 1} from ${group.shotName ?? 'shot'}`,
                  )
                ))}
              </div>
            </div>
          );
        }

        return renderPreview(
          group.attachment,
          index,
          `Deselect attached ${group.attachment.mediaType} ${index + 1}`,
        );
      })}
      {remainingCount > 0 && (
        <div
          className={cn(
            'flex h-10 w-10 items-center justify-center rounded-md border text-[10px] font-medium',
            isUser
              ? 'border-primary-foreground/20 bg-primary-foreground/10 text-primary-foreground/80'
              : 'border-border/70 bg-muted/40 text-muted-foreground',
          )}
          aria-label={`${remainingCount} more attachments`}
        >
          +{remainingCount}
        </div>
      )}
    </div>
  );
}

export function ConversationToolGroup({ pairs, defaultOpen = false }: ConversationToolGroupProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const detailsId = useId();
  const count = pairs.length;
  const running = pairs.filter(pair => actionStatus(pair) === 'in_progress').length;
  const stopped = pairs.filter(pair => actionStatus(pair) === 'cancelled').length;
  const unconfirmed = pairs.filter(pair => pair.result?.tool_status === 'unconfirmed').length;
  const failed = pairs.filter(pair => actionStatus(pair) === 'failed').length;
  const label = `[${count} ${count === 1 ? 'action' : 'actions'}]`;
  if (!count) return null;

  return (
    <div className="w-full min-w-0">
      <div className="flex min-w-0 items-center rounded-lg bg-muted/30">
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls={detailsId}
        aria-label={label}
        aria-describedby={`${detailsId}-status`}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-muted-foreground [@media(pointer:coarse)]:min-h-11 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setIsOpen(current => !current)}
      >
        <Terminal className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="min-w-0 font-medium text-foreground">{label}</span>
        <span id={`${detailsId}-status`} aria-live="polite" className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2">
          {failed>0&&<span className="font-medium text-destructive">{failed} failed</span>}
          {running>0&&<span>{running} running</span>}
          {stopped>0&&<span>{stopped} stopped</span>}
          {unconfirmed>0&&<span>{unconfirmed} unconfirmed</span>}
          {!failed&&!running&&!stopped&&!unconfirmed&&<span>Actions finished</span>}
        </span>
      </button>
      <button type="button" aria-label="Download logs for this action group" title="Download action logs"
        className="mr-1 flex h-7 w-7 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={event=>{event.stopPropagation();downloadActionGroupLogs(pairs);}}>
        <Download className="h-3.5 w-3.5" aria-hidden="true"/>
      </button>
      </div>
      {isOpen && (
        <div id={detailsId} role="region" aria-label="Action details" className="mt-1 space-y-2 pl-2">
          {pairs.map((pair, index) => {
            const command = pair.call.tool_args?.command;
            const summary = typeof command === 'string' ? command : pair.call.content || pair.call.tool_name || 'Action';
            return (
              <div key={pair.call.tool_call_id ?? `${pair.call.timestamp}:${index}`} data-agent-tool-call-id={pair.call.tool_call_id}
                className="min-w-0 space-y-1.5 rounded-md border border-border/70 bg-card/60 px-2.5 py-2 text-xs">
                <code className="block whitespace-pre-wrap break-words font-mono text-foreground [overflow-wrap:anywhere]">{summary}</code>
                {pair.call.tool_args && (
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-muted-foreground [overflow-wrap:anywhere]">{JSON.stringify(pair.call.tool_args, null, 2)}</pre>
                )}
                {pair.result?.content && (
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-muted-foreground [overflow-wrap:anywhere]">{pair.result.content}</pre>
                )}
                {!pair.result && <span className="text-muted-foreground">Running…</span>}
                {actionStatus(pair) === 'failed' && <span className="text-destructive">Failed</span>}
                {actionStatus(pair) === 'cancelled' && <span className="text-muted-foreground">Stopped</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ConversationMessage({ turn, onAttachmentClick }: ConversationMessageProps) {
  const timestamp = formatTimestamp(turn.timestamp);
  const isUser = turn.role === 'user';
  const attachmentSummary = formatAttachmentSummary(turn.attachments);
  const hasAttachmentPreviews = Boolean(turn.attachments?.length);
  const renderedContent = isUser ? (
    <div className="whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">
      {turn.content}
    </div>
  ) : (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => <h1 className="mb-2 text-base font-semibold">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-2 text-sm font-semibold">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-1.5 text-sm font-semibold">{children}</h3>,
        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="mb-2 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
        ol: ({ children }) => <ol className="mb-2 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
        li: ({ children }) => <li className="pl-0.5">{children}</li>,
        blockquote: ({ children }) => (
          <blockquote className="mb-2 border-l-2 border-border/80 pl-3 text-muted-foreground last:mb-0">
            {children}
          </blockquote>
        ),
        a: ({ children, href }) => (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-primary"
          >
            {children}
          </a>
        ),
        code: ({ children, className }) => (
          <code className={cn('rounded bg-muted/70 px-1 py-0.5 font-mono text-[0.9em]', className)}>
            {children}
          </code>
        ),
        pre: ({ children }) => (
          <pre className="mb-2 max-w-full overflow-x-auto rounded-lg bg-muted/70 p-3 font-mono text-xs leading-relaxed last:mb-0">
            {children}
          </pre>
        ),
        table: ({ children }) => (
          <div className="mb-2 max-w-full overflow-x-auto last:mb-0">
            <table className="w-full border-collapse text-xs">{children}</table>
          </div>
        ),
        th: ({ children }) => <th className="border border-border/70 bg-muted/50 px-2 py-1 text-left font-semibold">{children}</th>,
        td: ({ children }) => <td className="border border-border/70 px-2 py-1 align-top">{children}</td>,
        hr: () => <hr className="my-3 border-border/70" />,
      }}
    >
      {turn.content}
    </ReactMarkdown>
  );

  return (
    <div className={cn('flex w-full', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'min-w-0 max-w-[85%] rounded-2xl px-4 py-2.5 shadow-sm',
          isUser
            ? 'bg-primary text-primary-foreground'
            : 'border border-border/70 bg-card text-card-foreground',
        )}
      >
        <div className="break-words text-sm leading-relaxed [overflow-wrap:anywhere]">
          {renderedContent}
        </div>
        {hasAttachmentPreviews && turn.attachments && (
          <ConversationAttachmentStrip
            attachments={turn.attachments}
            isUser={isUser}
            onAttachmentClick={onAttachmentClick}
          />
        )}
        {attachmentSummary && (
          <span
            className={cn(
              'mt-1.5 block text-xs',
              isUser ? 'text-primary-foreground/75' : 'text-muted-foreground',
            )}
          >
            {attachmentSummary}
          </span>
        )}
        {timestamp && (
          <div
            className={cn(
              'mt-1.5 text-[10px] uppercase tracking-[0.14em] [@media(pointer:coarse)]:text-xs',
              isUser ? 'text-primary-foreground/70' : 'text-muted-foreground',
            )}
          >
            {timestamp}
          </div>
        )}
      </div>
    </div>
  );
}
