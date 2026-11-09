import type { PublicVisionContent, PublicVisionGap, PublicVisionProject } from './publicVisionContent';

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
    for (const gapId of project.gapIds) {
      const projects = projectsByGap.get(gapId) ?? [];
      projects.push(project);
      projectsByGap.set(gapId, projects);
    }
  }
  return content.gaps
    .filter(gap => gap.assessment !== 'closed' && gap.appliesTo.includes(subjectRef))
    .map(gap => ({ gap, projects: projectsByGap.get(gap.id) ?? [] }));
}
