export type TimelineTransitionReference = {
  id?: unknown;
  type?: unknown;
  durationFrames?: unknown;
  duration?: unknown;
};

export const transitionReferenceId = (value: unknown): string | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const reference = value as TimelineTransitionReference;
  if (typeof reference.id === 'string' && reference.id.length > 0) return reference.id;
  return typeof reference.type === 'string' && reference.type.length > 0 ? reference.type : undefined;
};

export const transitionReferenceFrames = (value: unknown, fps: number): number => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
  const reference = value as TimelineTransitionReference;
  if (typeof reference.durationFrames === 'number' && Number.isFinite(reference.durationFrames)) {
    return Math.max(0, reference.durationFrames);
  }
  if (typeof reference.duration === 'number' && Number.isFinite(reference.duration)) {
    return Math.max(0, Math.round(reference.duration * fps));
  }
  return 8;
};
