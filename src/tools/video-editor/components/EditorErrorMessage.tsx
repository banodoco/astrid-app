import { CopyCommandRow } from '@/shared/components/RuntimeConnection/CopyInstallCommand.tsx';

export type EditorErrorParts = { headline: string; detail?: string; fix?: string };

/** Read labeled executor errors while keeping older free-form errors useful. */
export function parseEditorError(message: string, nextAction?: string): EditorErrorParts {
  const labeled = message.trim().match(/^Headline:[ \t]*([^\r\n]+)(?:\r?\nDetail:[ \t]*([\s\S]*?))?(?:\r?\nFix:[ \t]*([\s\S]*))?$/i);
  let headline: string;
  let detail: string | undefined;
  let fix: string | undefined;
  if (labeled) {
    headline = labeled[1].trim();
    detail = labeled[2]?.trim() || undefined;
    fix = labeled[3]?.trim() || undefined;
  } else {
    const next = message.match(/(?:^|\s)Next:\s*([\s\S]+)$/i);
    const body = (next ? message.slice(0, next.index) : message).trim();
    const sentence = body.match(/^(.+?[.!?])(?:\s+|$)/s);
    headline = sentence?.[1].trim() || body.split('\n')[0].trim();
    detail = body.slice(sentence ? sentence[0].length : headline.length).trim() || undefined;
    fix = next?.[1].trim();
  }
  if (!fix && nextAction) fix = nextAction;
  return { headline: headline || 'Something went wrong.', ...(detail ? { detail } : {}), ...(fix ? { fix } : {}) };
}

export function EditorErrorMessage({ message, nextAction, className = '', headlinePrefix = '', fixLabel = 'Fix' }: { message: string; nextAction?: string; className?: string; headlinePrefix?: string; fixLabel?: string }) {
  const error = parseEditorError(message, nextAction);
  const commandMatch = error.fix?.match(/`([^`]+)`/);
  const command = commandMatch?.[1];
  const beforeCommand = commandMatch ? error.fix!.slice(0, commandMatch.index).trim() : error.fix;
  const afterCommand = commandMatch ? error.fix!.slice(commandMatch.index! + commandMatch[0].length).replace(/^\.\s*/, '').trim() : undefined;
  const detailIsLong = (error.detail?.length ?? 0) > 240;
  return <div className={`space-y-1 ${className}`}>
    <p className="font-medium text-red-100">{headlinePrefix}{error.headline}</p>
    {error.detail && (detailIsLong
      ? <details className="text-red-200/90"><summary className="cursor-pointer text-red-300">Technical details</summary><p className="mt-1 whitespace-pre-wrap">{error.detail}</p></details>
      : <p className="whitespace-pre-wrap text-red-200/90">{error.detail}</p>)}
    {error.fix && <div className="space-y-1 pt-1">
      <p className="whitespace-pre-wrap text-red-300">{fixLabel}: {beforeCommand}</p>
      {command && <CopyCommandRow command={command} label="Copy command" copiedLabel="Command copied" />}
      {afterCommand && <p className="text-red-300">{afterCommand}</p>}
    </div>}
  </div>;
}
