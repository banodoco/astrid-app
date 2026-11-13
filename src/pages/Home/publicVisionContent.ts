import { useCallback, useEffect, useState } from 'react';

// CI publishes this static file from reviewed Astrid Dev main commits.
// The browser uses HTTP caching and never needs an Astrid App content release.
export const PUBLIC_VISION_URL =
  'https://raw.githubusercontent.com/banodoco/astrid-dev/vision-published/vision.json';
export const PUBLIC_VISION_REPO_URL = 'https://github.com/banodoco/astrid-dev';

/** One shared editorial format for pillars and guiding principles.
 * Fields are optional while legacy schema-v1 snapshots remain cached.
 * When present, all three must be present on all eight subjects. */
export interface PublicVisionCharacteristic {
  id: string;
  title: string;
  summary: string;
  detailsMarkdown: string;
}
export interface PublicVisionSubject {
  id: string;
  title: string;
  bodyMarkdown: string;
  statement?: string;
  explanationMarkdown?: string;
  characteristics?: PublicVisionCharacteristic[];
}
export interface PublicVisionPillar extends PublicVisionSubject {
  descriptor: string;
}
export type PublicVisionPrinciple = PublicVisionSubject;
export interface PublicVisionGap {
  id: string;
  title: string;
  assessment: string;
  assessmentDetail: string;
  appliesTo: string[];
  /** Primary relationship is explicit in new feeds; first appliesTo is the legacy fallback. */
  primaryAppliesTo?: string;
  /** Plan 53 refs use <kind>:<element>/<aspiration>; absent in older v1 feeds. */
  aspiration?: string;
  supportingAspirations?: string[];
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
  /** Null for foundational enablers without a gap; first gap is the legacy fallback. */
  primaryGapId?: string | null;
  githubUrl: string;
}
export interface PublicVisionContent {
  schemaVersion: 1;
  source: { repository: string; revision: string };
  vision: { title: string; introMarkdown: string; contributeMarkdown?: string; agentPrompt?: string };
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
      !nonempty(value.vision.introMarkdown) ||
      (value.vision.contributeMarkdown !== undefined && !nonempty(value.vision.contributeMarkdown)) ||
      (value.vision.agentPrompt !== undefined && !nonempty(value.vision.agentPrompt))) {
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
        (validUrl(g.githubUrl, sourceBlob + 'vision/gaps/') ||
         validUrl(g.githubUrl, sourceBlob + 'visions/gaps/')) &&
        Array.isArray(g.appliesTo) && g.appliesTo.length > 0 &&
        g.appliesTo.every(nonempty) &&
        (g.primaryAppliesTo === undefined ||
         (nonempty(g.primaryAppliesTo) && g.primaryAppliesTo === g.appliesTo[0]))) ||
      !Array.isArray(projects) || projects.length < 1 ||
      !projects.every((p, index) => isRecord(p) && nonempty(p.id) &&
        nonempty(p.title) && nonempty(p.goalMarkdown) &&
        statuses.has(String(p.status)) && p.priorityOrder === index + 1 &&
        validUrl(p.githubUrl, sourceBlob + 'plans/' + p.id + '/plan.md') &&
        Array.isArray(p.gapIds) && p.gapIds.every(nonempty) &&
        (p.primaryGapId === undefined ||
         (p.primaryGapId === null ? p.gapIds.length === 0 :
          nonempty(p.primaryGapId) && p.primaryGapId === p.gapIds[0])))) {
    throw new Error('Invalid public vision feed content');
  }
  const subjectsAll = [...pillars, ...principles];
  const anyStructured = subjectsAll.some(p =>
    'statement' in p || 'explanationMarkdown' in p || 'characteristics' in p);
  if (anyStructured && !subjectsAll.every(p =>
    nonempty(p.statement) && nonempty(p.explanationMarkdown) &&
    Array.isArray(p.characteristics) && p.characteristics.length >= 2 &&
    p.characteristics.length <= 6 &&
    p.characteristics.every((c: unknown) => isRecord(c) &&
      typeof c.id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(c.id) &&
      nonempty(c.title) && nonempty(c.summary) && nonempty(c.detailsMarkdown)) &&
    new Set(p.characteristics.map((c: { id: string }) => c.id)).size === p.characteristics.length)) {
    throw new Error('Incomplete or malformed structured vision characteristics');
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
  const aspirationRefs = new Set([
    ...pillars.flatMap(pillar => (pillar.characteristics ?? []).map(
      (item: PublicVisionCharacteristic) => 'pillar:' + pillar.id + '/' + item.id)),
    ...principles.flatMap(principle => (principle.characteristics ?? []).map(
      (item: PublicVisionCharacteristic) => 'principle:' + principle.id + '/' + item.id)),
  ]);
  for (const gap of gaps) {
    if (gap.aspiration === undefined && gap.supportingAspirations === undefined) continue;
    const supporting = gap.supportingAspirations === undefined ? [] : gap.supportingAspirations;
    if (!nonempty(gap.aspiration) || !aspirationRefs.has(gap.aspiration) ||
        !Array.isArray(supporting) || !supporting.every(ref => nonempty(ref) && aspirationRefs.has(ref)) ||
        new Set([gap.aspiration, ...supporting]).size !== supporting.length + 1) {
      throw new Error('Unresolved or duplicate public vision aspirations');
    }
    const elements = [...new Set([gap.aspiration, ...supporting].map(ref => ref.split('/')[0]))];
    if (elements[0] !== (gap.primaryAppliesTo ?? gap.appliesTo[0]) ||
        elements.length !== gap.appliesTo.length ||
        elements.some((ref, index) => ref !== gap.appliesTo[index])) {
      throw new Error('Aspiration relationships disagree with their vision elements');
    }
  }
  return value as unknown as PublicVisionContent;
}

// In-memory stale-while-revalidate: returning from Home doesn't flash an empty
// page, and a failed refresh never discards the last validated content.
let lastGood: PublicVisionContent | null = null;

let preloading = false;

/**
 * Fetches the vision ahead of need (Home calls this once it has settled), so opening the Vision page
 * shows its text at once instead of a loading skeleton. Failures are silent: the page fetches for
 * itself, with its own error state, when it opens.
 */
export function preloadPublicVisionContent() {
  if (lastGood || preloading || typeof fetch !== 'function') return;
  preloading = true;
  void fetch(PUBLIC_VISION_URL, { credentials: 'omit', mode: 'cors', cache: 'default' })
    .then(async response => {
      if (!response.ok) throw new Error('Vision feed unavailable');
      return parsePublicVisionContent(await response.json());
    })
    .then(next => { lastGood ??= next; })
    .catch(() => {})
    .finally(() => { preloading = false; });
}

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
