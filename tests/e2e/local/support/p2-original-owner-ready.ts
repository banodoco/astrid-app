import { hasFreshSettledOwner, type SettledOwner } from '../mounted-readiness-safety.ts';

type ScopedOwner = SettledOwner & { scope?: { projectId?: string; timelineId?: string } };

export type OriginalPageReadiness = {
  connected: boolean;
  projectSelected: boolean;
  trackVisible: boolean;
  owners: readonly ScopedOwner[];
  previousOwnerIds: ReadonlySet<string>;
  projectId: string;
  timelineId: string;
};

/** Browser state is supplied by the caller; only the durable owner predicate is production logic. */
export function originalPageOwnerReady(input: OriginalPageReadiness): boolean {
  return input.connected && input.projectSelected && input.trackVisible
    && hasFreshSettledOwner(input.owners.filter((owner) => owner.scope
      && owner.scope.projectId === input.projectId && owner.scope.timelineId === input.timelineId), input.previousOwnerIds);
}
