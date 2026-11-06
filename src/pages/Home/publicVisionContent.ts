import { useCallback, useEffect, useState } from 'react';

// CI publishes this static file from reviewed Astrid Dev main commits.
// The browser uses HTTP caching and never needs an Astrid App content release.
export const PUBLIC_VISION_URL =
  'https://raw.githubusercontent.com/banodoco/astrid-dev/vision-published/vision.json';
export const PUBLIC_VISION_REPO_URL = 'https://github.com/banodoco/astrid-dev';

export interface PublicVisionPillar {
  id: string;
  title: string;
  descriptor: string;
  bodyMarkdown: string;
}
export interface PublicVisionPrinciple {
  id: string;
  title: string;
  bodyMarkdown: string;
}
export interface PublicVisionGap {
  id: string;
  title: string;
  assessment: string;
  assessmentDetail: string;
  appliesTo: string[];
  desiredMarkdown: string;
  currentMarkdown: string;
  missingMarkdown: string;
  closureEvidenceMarkdown: string;
  githubUrl: string;
}
export interface PublicVisionProject {
  id: string;
  title: string;
  goalMarkdown: string;
  status: 'active' | 'queued' | 'blocked' | 'paused' | 'done' | 'cancelled';
  owner: string;
  estimate: string;
  waitingOn: string;
  priorityOrder: number;
  gapIds: string[];
  githubUrl: string;
}
export interface PublicVisionContent {
  schemaVersion: 1;
  source: { repository: string; revision: string };
  vision: { title: string; introMarkdown: string };
  pillars: PublicVisionPillar[];
  principles: PublicVisionPrinciple[];
  gaps: PublicVisionGap[];
  projects: PublicVisionProject[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const validUrl = (value: unknown, prefix: string): boolean =>
  nonempty(value) && value.startsWith(prefix);
const statuses = new Set(['active', 'queued', 'blocked', 'paused', 'done', 'cancelled']);
const assessments = new Set(['open', 'partially evidenced', 'closed', 'needs recheck']);

/** Reject incompatible or partially published data instead of rendering misleading claims. */
export function parsePublicVisionContent(value: unknown): PublicVisionContent {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.source) ||
      value.source.repository !== 'banodoco/astrid-dev' ||
      !nonempty(value.source.revision) || !/^[0-9a-f]{40}$/.test(value.source.revision) ||
      !isRecord(value.vision) || !nonempty(value.vision.title) ||
      !nonempty(value.vision.introMarkdown)) {
    throw new Error('Unsupported or malformed public vision feed');
  }
  const revision = value.source.revision;
  const sourceBlob = PUBLIC_VISION_REPO_URL + '/blob/' + revision + '/';
  const { pillars, principles, gaps, projects } = value;
  if (!Array.isArray(pillars) || pillars.length !== 4 ||
      !pillars.every(p => isRecord(p) && nonempty(p.id) && nonempty(p.title) &&
        nonempty(p.descriptor) && nonempty(p.bodyMarkdown)) ||
      !Array.isArray(principles) || principles.length < 1 ||
      !principles.every(p => isRecord(p) && nonempty(p.id) && nonempty(p.title) && nonempty(p.bodyMarkdown)) ||
      !Array.isArray(gaps) || gaps.length < 1 ||
      !gaps.every(g => isRecord(g) && nonempty(g.id) && nonempty(g.title) &&
        assessments.has(String(g.assessment)) && nonempty(g.desiredMarkdown) &&
        nonempty(g.currentMarkdown) && nonempty(g.missingMarkdown) &&
        nonempty(g.closureEvidenceMarkdown) && nonempty(g.assessmentDetail) &&
        validUrl(g.githubUrl, sourceBlob + 'visions/gaps/') &&
        Array.isArray(g.appliesTo) && g.appliesTo.length > 0 &&
        g.appliesTo.every(nonempty)) ||
      !Array.isArray(projects) || projects.length < 1 ||
      !projects.every((p, index) => isRecord(p) && nonempty(p.id) &&
        nonempty(p.title) && nonempty(p.goalMarkdown) &&
        statuses.has(String(p.status)) && p.priorityOrder === index + 1 &&
        validUrl(p.githubUrl, sourceBlob + 'plans/' + p.id + '/plan.md') &&
        Array.isArray(p.gapIds) && p.gapIds.every(nonempty))) {
    throw new Error('Invalid public vision feed content');
  }
  const unique = (items: Array<{ id: string }>) => new Set(items.map(item => item.id)).size === items.length;
  const ids = new Set(gaps.map(gap => gap.id));
  const subjects = new Set([
    ...pillars.map(pillar => 'pillar:' + pillar.id),
    ...principles.map(principle => 'principle:' + principle.id),
  ]);
  if (!unique(pillars) || !unique(principles) || !unique(gaps) || !unique(projects) ||
      !gaps.every(gap => gap.appliesTo.every(ref => subjects.has(ref))) ||
      !projects.every(project => project.gapIds.every(id => ids.has(id)))) {
    throw new Error('Unresolved or duplicate public vision relationships');
  }
  return value as unknown as PublicVisionContent;
}

// In-memory stale-while-revalidate: returning from Home doesn't flash an empty
// page, and a failed refresh never discards the last validated content.
let lastGood: PublicVisionContent | null = null;

export function usePublicVisionContent() {
  const [content, setContent] = useState<PublicVisionContent | null>(() => lastGood);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt(current => current + 1), []);

  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    setError(false);
    void fetch(PUBLIC_VISION_URL, {
      signal: controller.signal, credentials: 'omit', mode: 'cors', cache: 'default',
    }).then(async response => {
      if (!response.ok) throw new Error('Vision feed unavailable');
      return parsePublicVisionContent(await response.json());
    }).then(next => {
      if (!mounted) return;
      lastGood = next;
      setContent(next);
    }).catch(() => {
      if (mounted) setError(true);
    }).finally(() => {
      window.clearTimeout(timeout);
    });
    return () => {
      mounted = false;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [attempt]);

  return { content, error, retry };
}
