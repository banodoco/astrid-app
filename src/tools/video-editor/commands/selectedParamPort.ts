import type { DocumentPin } from '@/integrations/runtime/timeline-commit-types.ts';
import type { TimelineCommandBasis, TimelineAcceptedIdentity } from '../data/DataProvider.ts';
import {
  resolveSelectedParamAuthority,
  type SelectedParamAuthorityInput,
} from './selectedParamAuthority.ts';

export type SelectedParamLiveBasis = Readonly<{
  basis: TimelineCommandBasis;
  head: TimelineAcceptedIdentity;
  generation: number;
}>;

export type SelectedParamCapture = Readonly<{
  input: Pick<SelectedParamAuthorityInput, 'select' | 'rawClip'>;
  live: SelectedParamLiveBasis;
}>;

export type SelectedParamPort = Readonly<{
  capture(input: Pick<SelectedParamAuthorityInput, 'select' | 'rawClip'>): SelectedParamCapture;
  resolve(capture: SelectedParamCapture): DocumentPin;
  resolveAsync<T>(capture: SelectedParamCapture, resolve: (input: SelectedParamAuthorityInput) => Promise<T>): Promise<T>;
}>;

const copyInput = (input: Pick<SelectedParamAuthorityInput, 'select' | 'rawClip'>) => ({
  select: input.select,
  rawClip: input.rawClip == null ? input.rawClip : structuredClone(input.rawClip),
});

function sameLiveBasis(left: SelectedParamLiveBasis | undefined, right: SelectedParamLiveBasis): boolean {
  return !!left
    && left.generation === right.generation
    && left.head.revisionId === right.head.revisionId
    && left.head.publicationId === right.head.publicationId
    && left.basis === right.basis;
}

export function createSelectedParamPort(getLiveBasis: () => SelectedParamLiveBasis | undefined): SelectedParamPort {
  const requireCurrent = (capture: SelectedParamCapture): SelectedParamLiveBasis => {
    const current = getLiveBasis();
    if (!current || !sameLiveBasis(current, capture.live)) {
      throw new Error('Selected PARAM authority basis changed; draft preserved');
    }
    return current;
  };

  return {
    capture(input) {
      const live = getLiveBasis();
      if (!live) throw new Error('Selected PARAM authority is unavailable; draft preserved');
      return Object.freeze({ input: Object.freeze(copyInput(input)), live });
    },
    resolve(capture) {
      const live = requireCurrent(capture);
      if (!live.basis.history) throw new Error('Selected PARAM authority is unavailable; draft preserved');
      return resolveSelectedParamAuthority({
        history: live.basis.history,
        head: live.basis.head,
        canonicalDocument: live.basis.canonicalDocument as unknown as Record<string, unknown>,
        graph: live.basis.graph,
        ...capture.input,
      });
    },
    async resolveAsync(capture, resolve) {
      const live = requireCurrent(capture);
      if (!live.basis.history) throw new Error('Selected PARAM authority is unavailable; draft preserved');
      const result = await resolve({
        history: live.basis.history,
        head: live.basis.head,
        canonicalDocument: live.basis.canonicalDocument as unknown as Record<string, unknown>,
        graph: live.basis.graph,
        ...capture.input,
      });
      requireCurrent(capture);
      return result;
    },
  };
}
