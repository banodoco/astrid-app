export type Gate5CommitIdentity = Readonly<{
  body: string;
  key: string;
}>;

export type Gate5FaultOrderAction =
  | 'initial'
  | 'stage-automatic-retry'
  | 'forward-dependent-or-recovery'
  | 'reject-early-dependent'
  | 'reject-unexpected-duplicate';

/**
 * Classify only the first exact replay of A as the automatic retry to stage.
 * Different body/key traffic stays observable as a real request, while a
 * second exact replay after recovery is refused instead of being accepted as
 * an arbitrary retry.
 */
export function classifyGate5FaultOrder(input: {
  initial?: Gate5CommitIdentity;
  candidate: Gate5CommitIdentity;
  automaticRetryStaged: boolean;
  recoveryForwarded: boolean;
}): Gate5FaultOrderAction {
  if (!input.initial) return 'initial';
  const exactReplay = input.initial.body === input.candidate.body && input.initial.key === input.candidate.key;
  if (!exactReplay && !input.recoveryForwarded) return 'reject-early-dependent';
  if (!exactReplay) return 'forward-dependent-or-recovery';
  if (!input.automaticRetryStaged) return 'stage-automatic-retry';
  if (!input.recoveryForwarded) return 'forward-dependent-or-recovery';
  return 'reject-unexpected-duplicate';
}

export function sameGate5CommitIdentity(left: Gate5CommitIdentity, right: Gate5CommitIdentity): boolean {
  return left.body === right.body && left.key === right.key;
}
