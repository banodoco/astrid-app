import type { PublicVisionGoal, PublicVisionContent, PublicVisionGap, PublicVisionProject } from './publicVisionContent';

export type VisionSubject = { kind: 'pillar' | 'principle'; id: string };
export type VisionGapProjects = { gap: PublicVisionGap; projects: PublicVisionProject[] };

/**
 * The public feed is the source of truth: gaps refer to pillar/principle IDs,
 * and project plans refer to gap IDs. Never maintain a second mapping in the UI.
 */
export function currentGapsForSubject(
  content: PublicVisionContent,
  subject: VisionSubject,
  includeCompletedProjects = false,
): VisionGapProjects[] {
  const subjectRef = subject.kind + ':' + subject.id;
  const projectsByGap = new Map<string, PublicVisionProject[]>();
  for (const project of content.projects) {
    if (!includeCompletedProjects && (project.status === 'done' || project.status === 'cancelled')) continue;
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

export type VisionGoalGaps = {
  goal: PublicVisionGoal;
  gaps: VisionGapProjects[];
  hasMeasuredGap: boolean;
};

/** Group only by explicit primary goal. Older feeds keep their element-level list. */
export function goalsForSubject(content: PublicVisionContent, subject: VisionSubject): {
  goals: VisionGoalGaps[];
  legacyGaps: VisionGapProjects[];
  hasGoalLinks: boolean;
} {
  const entry = (subject.kind === 'pillar' ? content.pillars : content.principles)
    .find(item => item.id === subject.id);
  // The new hierarchy counts every primary-linked project, including finished
  // work; project status remains visible. The legacy current-work list stays unchanged.
  const current = currentGapsForSubject(content, subject, true);
  return {
    goals: (entry?.goals ?? []).map(goal => {
      const ref = subject.kind + ':' + subject.id + '/' + goal.id;
      return {
        goal,
        gaps: current.filter(({ gap }) => gap.goal === ref),
        hasMeasuredGap: content.gaps.some(gap => gap.goal === ref),
      };
    }),
    legacyGaps: currentGapsForSubject(content, subject).filter(({ gap }) => gap.goal === undefined),
    hasGoalLinks: content.gaps.some(gap => gap.goal !== undefined),
  };
}

export function findGoal(content: PublicVisionContent, reference: string): PublicVisionGoal | undefined {
  const [element, goalId] = reference.split('/');
  const [kind, id] = element.split(':');
  const subjects = kind === 'pillar' ? content.pillars : kind === 'principle' ? content.principles : [];
  return subjects.find(subject => subject.id === id)?.goals?.find(item => item.id === goalId);
}

/** The template's optional decision lists are a terminal Markdown block.
 * Keep the public feed and authored text intact, separating only their presentation. */
export function splitGoalDetails(markdown: string): {
  explanation: string; guidance: string; label: string;
} {
  const lines = markdown.split(/\r?\n/);
  let fence: { char: string; length: number } | null = null;
  let first = -1;
  const labels: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i].match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = lines[i].match(/^\*\*(We should(?: never)?):\*\*[ \t]*$/);
    if (heading) {
      if (first < 0) first = i;
      labels.push(heading[1]);
    }
  }
  if (first < 0 || !lines.slice(first + 1).some(line => /^[-*] \S/.test(line))) {
    return { explanation: markdown, guidance: '', label: '' };
  }
  return { explanation: lines.slice(0, first).join('\n').trimEnd(),
    guidance: lines.slice(first).join('\n').trim(), label: [...new Set(labels)].join(' / ') };
}
