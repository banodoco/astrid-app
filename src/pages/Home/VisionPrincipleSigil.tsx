import type { ReactNode } from 'react';

/** Stable feed IDs, not display titles: copy edits must not swap the artwork. */
const SIGIL_KIND: Record<string, 'core' | 'open' | 'hand' | 'threads'> = {
  'local-first-cloud-capable': 'core',
  'open-by-design': 'open',
  'in-the-creators-control': 'hand',
  'eliminate-needless-technical-wrangling': 'threads',
  'eliminate-technical-wrangling': 'threads',
};

/** Integer-grid paths keep the marks crisp; only small detail groups animate.
 * No raster background, filters, network assets, or always-running JS loops.
 */
export function VisionPrincipleSigil({ principleId, reducedMotion = false }: {
  principleId: string;
  reducedMotion?: boolean;
}) {
  const kind = SIGIL_KIND[principleId] ?? 'core';
  let drawing: ReactNode;
  switch (kind) {
    case 'core':
      drawing = <>
        <g className="vision-sigil-quiet">
          <path d="M14 3h4v2h-4zM3 14h2v4H3zM27 14h2v4h-2zM14 27h4v2h-4zM7 7h2v2H7zM23 7h2v2h-2zM7 23h2v2H7zM23 23h2v2h-2z" />
          <path d="M15 6h2v4h-2zM6 15h4v2H6zM22 15h4v2h-4zM15 22h2v4h-2z" />
        </g>
        <path fillRule="evenodd" d="M12 10h8v2h2v8h-2v2h-8v-2h-2v-8h2zm2 4v4h4v-4z" />
        <rect className="vision-sigil-core-light" x="15" y="15" width="2" height="2" />
        <g className="vision-sigil-satellite"><path d="M14 1h4v4h-4zm1 1v2h2V2z" fillRule="evenodd" /></g>
      </>;
      break;
    case 'open':
      drawing = <>
        <path d="M12 4h9v2h-9zM8 6h4v2H8zM6 8h2v4H6zM4 12h2v9H4zM6 21h2v4H6zM8 25h4v2H8zM12 27h9v2h-9zM21 25h4v2h-4zM25 21h2v4h-2zM27 13h2v8h-2z" />
        <g className="vision-sigil-ring-halo vision-sigil-quiet">
          <path d="M11 1h11v1H11zM1 11h1v11H1zM11 31h11v1H11zM31 11h1v11h-1z" />
        </g>
        <g className="vision-sigil-orbit"><path d="M24 5h2v2h2v2h-2v2h-2V9h-2V7h2z" /></g>
      </>;
      break;
    case 'hand':
      drawing = <>
        <path d="M2 24h2v-2h2v-2h4v-2h10v2H10v2H6v2H4v4H2zM4 28h4v-2h12v-2h4v-2h2v-4h2v-2h2v6h-2v2h-2v2h-4v2H10v2H4zM18 20h6v2h-6z" />
        <g className="vision-sigil-spark">
          <path d="M16 3h2v4h4v2h-4v4h-2V9h-4V7h4z" />
          <path className="vision-sigil-quiet" d="M8 5h2v2H8zM24 3h2v2h-2zM9 12h2v2H9zM24 12h2v2h-2z" />
        </g>
      </>;
      break;
    case 'threads':
      drawing = <>
        <g className="vision-sigil-thread-tangle">
          <path d="M2 8h6v2h4v4h4v8h4v2h4v2h-6v-2h-4v-8h-4v-4H6v-2H2z" />
          <path className="vision-sigil-quiet" d="M2 25h4v-4h4v-4h10v-6h-4V7h-6V5h8v4h4v10H12v4H8v4H2z" />
          <path d="M6 3h2v2H6zM10 27h2v2h-2z" className="vision-sigil-quiet" />
        </g>
        <path className="vision-sigil-thread-clear" d="M2 17h8v-2h8v2h-8v2H2z" />
        <path d="M18 15h8v-4h2v2h2v2h2v2h-2v2h-2v2h-2v-4h-8z" />
        <rect className="vision-sigil-thread-signal" x="19" y="15" width="2" height="2" />
      </>;
      break;
  }
  return <span className="astrid-vision-principle-sigil" data-sigil={kind}
    data-sigil-motion={reducedMotion ? 'off' : 'ready'} aria-hidden="true">
    <svg viewBox="0 0 32 32" width="48" height="48" fill="currentColor"
      shapeRendering="crispEdges" focusable="false" aria-hidden="true">
      {drawing}
    </svg>
  </span>;
}
