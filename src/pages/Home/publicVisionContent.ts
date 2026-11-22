import { useCallback, useEffect, useState } from 'react';

// CI publishes this static file from reviewed Astrid Dev main commits.
// The browser uses HTTP caching and never needs an Astrid App content release.
export const PUBLIC_VISION_URL =
  'https://raw.githubusercontent.com/banodoco/astrid-dev/vision-published/vision.json';
export const PUBLIC_VISION_REPO_URL = 'https://github.com/banodoco/astrid-dev';

/** One shared editorial format for pillars and guiding principles.
 * Fields are optional while legacy schema-v1 snapshots remain cached.
 * When present, all three must be present on all eight subjects. */
export interface PublicVisionGoal {
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
  goals?: PublicVisionGoal[];
  /** Read only for legacy published schema-v1 snapshots. */
  characteristics?: PublicVisionGoal[];
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
  /** Stable identity: <pillar|principle>:<element>/<goal-slug>. */
  goal?: string;
  supportingGoals?: string[];
  /** Read only for legacy published schema-v1 snapshots. */
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

/** Deprecated TypeScript alias for snapshots produced before the Goals rename. */
export type PublicVisionCharacteristic = PublicVisionGoal;

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
  const rowsFor = (subject: Record<string, unknown>): unknown[] | null => {
    const rows = subject.goals ?? subject.characteristics;
    return Array.isArray(rows) ? rows : null;
  };
  for (const subject of subjectsAll) {
    if (subject.goals !== undefined && subject.characteristics !== undefined &&
        JSON.stringify(subject.goals) !== JSON.stringify(subject.characteristics)) {
      throw new Error('Goal compatibility fields disagree');
    }
  }
  const anyStructured = subjectsAll.some(p =>
    'statement' in p || 'explanationMarkdown' in p || 'goals' in p || 'characteristics' in p);
  if (anyStructured && !subjectsAll.every(p =>
    nonempty(p.statement) && nonempty(p.explanationMarkdown) &&
    rowsFor(p) !== null && rowsFor(p)!.length >= 2 &&
    rowsFor(p)!.length <= 6 &&
    rowsFor(p)!.every((c: unknown) => isRecord(c) &&
      typeof c.id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(c.id) &&
      nonempty(c.title) && nonempty(c.summary) && nonempty(c.detailsMarkdown)) &&
    new Set(rowsFor(p)!.map((c: unknown) => isRecord(c) ? String(c.id) : '')).size === rowsFor(p)!.length)) {
    throw new Error('Incomplete or malformed structured vision goals');
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
  const goalRefs = new Set([
    ...pillars.flatMap(pillar => (pillar.goals ?? pillar.characteristics ?? []).map(
      (item: PublicVisionGoal) => 'pillar:' + pillar.id + '/' + item.id)),
    ...principles.flatMap(principle => (principle.goals ?? principle.characteristics ?? []).map(
      (item: PublicVisionGoal) => 'principle:' + principle.id + '/' + item.id)),
  ]);
  for (const gap of gaps) {
    if ((gap.goal !== undefined && !nonempty(gap.goal)) ||
        (gap.aspiration !== undefined && !nonempty(gap.aspiration)) ||
        (gap.supportingGoals !== undefined && !Array.isArray(gap.supportingGoals)) ||
        (gap.supportingAspirations !== undefined && !Array.isArray(gap.supportingAspirations))) {
      throw new Error('Unresolved or duplicate public vision goals');
    }
    if (gap.goal !== undefined && gap.aspiration !== undefined && gap.goal !== gap.aspiration) {
      throw new Error('Primary goal compatibility fields disagree');
    }
    if (gap.supportingGoals !== undefined && gap.supportingAspirations !== undefined &&
        JSON.stringify(gap.supportingGoals) !== JSON.stringify(gap.supportingAspirations)) {
      throw new Error('Supporting goal compatibility fields disagree');
    }
    const goal = gap.goal ?? gap.aspiration;
    const supporting = gap.supportingGoals ?? gap.supportingAspirations;
    if (goal === undefined && supporting === undefined) continue;
    const references = supporting === undefined ? [] : supporting;
    if (!nonempty(goal) || !goalRefs.has(goal) ||
        !Array.isArray(references) || !references.every(ref => nonempty(ref) && goalRefs.has(ref)) ||
        new Set([goal, ...references]).size !== references.length + 1) {
      throw new Error('Unresolved or duplicate public vision goals');
    }
    const elements = [...new Set([goal, ...references].map(ref => ref.split('/')[0]))];
    if (elements[0] !== (gap.primaryAppliesTo ?? gap.appliesTo[0]) ||
        elements.length !== gap.appliesTo.length ||
        elements.some((ref, index) => ref !== gap.appliesTo[index])) {
      throw new Error('Goal relationships disagree with their vision elements');
    }
  }
  // Normalize both wire representations to one app-facing Goals model. Legacy
  // keys remain available only for old snapshot consumers and cached clients.
  return {
    ...value,
    pillars: pillars.map(subject => ({ ...subject, goals: subject.goals ?? subject.characteristics })),
    principles: principles.map(subject => ({ ...subject, goals: subject.goals ?? subject.characteristics })),
    gaps: gaps.map(gap => ({ ...gap, goal: gap.goal ?? gap.aspiration,
      supportingGoals: gap.supportingGoals ?? gap.supportingAspirations })),
  } as unknown as PublicVisionContent;
}

// One validated snapshot and one request owner for both Home preloading and
// Vision. Joining an in-flight preload must not start a second cold request.
let lastGood: PublicVisionContent | null = null;
let pending: Promise<PublicVisionContent> | null = null;

function requestPublicVisionContent(): Promise<PublicVisionContent> {
  if (pending) return pending;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10_000);
  pending = fetch(PUBLIC_VISION_URL, {
    signal: controller.signal, credentials: 'omit', mode: 'cors', cache: 'default',
  }).then(async response => {
    if (!response.ok) throw new Error('Vision feed unavailable');
    return parsePublicVisionContent(await response.json());
  }).then(next => {
    lastGood = next;
    return next;
  }).finally(() => {
    window.clearTimeout(timeout);
    pending = null;
  });
  return pending;
}

/** Warm the same bounded request the Vision page will join. */
export function preloadPublicVisionContent() {
  if (lastGood || typeof fetch !== 'function') return;
  void requestPublicVisionContent().catch(() => {});
}

export function usePublicVisionContent() {
  const [content, setContent] = useState<PublicVisionContent | null>(() => lastGood);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt(current => current + 1), []);

  useEffect(() => {
    let mounted = true;
    setError(false);
    // The request belongs to the shared cache, not an individual mount. A
    // route change or StrictMode cleanup must not abort another subscriber.
    void requestPublicVisionContent().then(next => {
      if (mounted) setContent(next);
    }).catch(() => {
      if (mounted) setError(true);
    });
    return () => { mounted = false; };
  }, [attempt]);

  return { content, error, retry };
}
