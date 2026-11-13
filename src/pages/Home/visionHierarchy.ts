import type { PublicVisionCharacteristic, PublicVisionContent, PublicVisionGap, PublicVisionProject } from './publicVisionContent';

export type VisionSubject = { kind: 'pillar' | 'principle'; id: string };
export type VisionGapProjects = { gap: PublicVisionGap; projects: PublicVisionProject[] };

/**
 * The public feed is the source of truth: gaps refer to pillar/principle IDs,
 * and project plans refer to gap IDs. Never maintain a second mapping in the UI.
 */
export function currentGapsForSubject(
  content: PublicVisionContent,
  subject: VisionSubject,
): VisionGapProjects[] {
  const subjectRef = subject.kind + ':' + subject.id;
  const projectsByGap = new Map<string, PublicVisionProject[]>();
  for (const project of content.projects) {
    if (project.status === 'done' || project.status === 'cancelled') continue;
    // Secondary gaps remain traceable in the source, but every project is
    // displayed only under its single primary gap.
    const gapId = project.primaryGapId ?? project.gapIds[0];
    if (!gapId) continue;
    const projects = projectsByGap.get(gapId) ?? [];
    projects.push(project);
    projectsByGap.set(gapId, projects);
  }
  return content.gaps
    .filter(gap => gap.assessment !== 'closed' && (gap.primaryAppliesTo ?? gap.appliesTo[0]) === subjectRef)
    .map(gap => ({
      gap,
      projects: (projectsByGap.get(gap.id) ?? []).slice().sort((a, b) => a.priorityOrder - b.priorityOrder),
    }));
}

export type VisionAspirationGaps = {
  aspiration: PublicVisionCharacteristic;
  gaps: VisionGapProjects[];
  hasMeasuredGap: boolean;
};

/** Group only by explicit primary aspiration. Older feeds keep their element-level list. */
export function aspirationsForSubject(content: PublicVisionContent, subject: VisionSubject): {
  aspirations: VisionAspirationGaps[];
  legacyGaps: VisionGapProjects[];
  hasAspirationLinks: boolean;
} {
  const entry = (subject.kind === 'pillar' ? content.pillars : content.principles)
    .find(item => item.id === subject.id);
  const current = currentGapsForSubject(content, subject);
  return {
    aspirations: (entry?.characteristics ?? []).map(aspiration => {
      const ref = subject.kind + ':' + subject.id + '/' + aspiration.id;
      return {
        aspiration,
        gaps: current.filter(({ gap }) => gap.aspiration === ref),
        hasMeasuredGap: content.gaps.some(gap => gap.aspiration === ref),
      };
    }),
    legacyGaps: current.filter(({ gap }) => gap.aspiration === undefined),
    hasAspirationLinks: content.gaps.some(gap => gap.aspiration !== undefined),
  };
}

export function findAspiration(content: PublicVisionContent, reference: string): PublicVisionCharacteristic | undefined {
  const [element, aspirationId] = reference.split('/');
  const [kind, id] = element.split(':');
  const subjects = kind === 'pillar' ? content.pillars : kind === 'principle' ? content.principles : [];
  return subjects.find(subject => subject.id === id)?.characteristics?.find(item => item.id === aspirationId);
}
