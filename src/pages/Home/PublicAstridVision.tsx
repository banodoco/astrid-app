import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import ReactMarkdown from 'react-markdown';
import { ChevronDown } from 'lucide-react';
import { PublicAstridSocialLinks } from './PublicAstridSocialLinks.tsx';
import { PublicAstridSky, usePublicAstridSkyControls } from './PublicAstridSky.tsx';
import type { PublicAstridSkySession } from './publicAstridSkySession';
import { usePublicAstridSkySession } from './usePublicAstridSkySession';
import { followInPage } from './publicAstridLinks';
import { NORTH_STAR_ART, NorthStarMink, type NorthStarArt } from './PublicAstridNorthStarArt.tsx';
import { usePublicAstridEnvironment, type PublicAstridEnvironment } from './publicAstridLifecycle';
import { usePublicVisionContent, PUBLIC_VISION_REPO_URL, type PublicVisionGap, type PublicVisionProject } from './publicVisionContent';
import { VisionDetailDialog } from './VisionDetailDialog';
import { VisionPrincipleSigil } from './VisionPrincipleSigil';
import { VisionSectionNav } from './VisionSectionNav';
import type { VisionSubject } from './visionHierarchy';
import './PublicAstridVision.css';

const PILLAR_ART: readonly NorthStarArt[] = [
  NORTH_STAR_ART.art,
  NORTH_STAR_ART.adapt,
  NORTH_STAR_ART.knowledge,
  NORTH_STAR_ART.community,
];
// The source feed owns every status; the page only decides how to display them.
type GapFilter = 'current' | 'all' | 'open' | 'partially evidenced' | 'needs recheck' | 'closed';
type ProjectFilter = 'current' | 'all' | PublicVisionProject['status'];
const GAP_FILTERS: ReadonlyArray<{ value: GapFilter; label: string }> = [
  { value: 'current', label: 'Current' }, { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' }, { value: 'partially evidenced', label: 'Partially evidenced' },
  { value: 'needs recheck', label: 'Needs recheck' }, { value: 'closed', label: 'Closed' },
];
const PROJECT_FILTERS: ReadonlyArray<{ value: ProjectFilter; label: string }> = [
  { value: 'current', label: 'Current' }, { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' }, { value: 'queued', label: 'Queued' },
  { value: 'blocked', label: 'Blocked' }, { value: 'paused', label: 'Paused' },
  { value: 'done', label: 'Done' }, { value: 'cancelled', label: 'Cancelled' },
];

function MarkdownText({ value, className }: { value: string; className?: string }) {
  return <div className={className ? 'astrid-vision-markdown ' + className : 'astrid-vision-markdown'}>
    <ReactMarkdown>{value}</ReactMarkdown>
  </div>;
}

const JUGGLED_ITEMS = [
  { name: 'reel', x: 20, y: 1 },
  { name: 'chip', x: 1, y: 20 },
  { name: 'brush', x: 49, y: 19 },
] as const;

/**
 * The juggling mink, with the three items as separate sprites so they can drift above its paws. The mink
 * is a strip of hand-finished keyframes: it lifts its head and paws, settles, then dips them, and the items
 * rise and sink a beat behind, as if held up by magic.
 */
function Juggler() {
  return (
    <div className="astrid-vision-juggler" aria-hidden="true">
      <span className="astrid-vision-juggler-mink" />
      {JUGGLED_ITEMS.map((item) => (
        <img
          key={item.name}
          className="astrid-vision-juggled"
          data-item={item.name}
          src={`/astrid-juggler-${item.name}.png`}
          alt=""
          style={{ '--x': item.x, '--y': item.y } as CSSProperties}
        />
      ))}
    </div>
  );
}

/** The mink at its workbench; the sparks are a looping sprite sheet anchored to the soldering iron's tip. */
function Tinkerer() {
  return (
    <div className="astrid-vision-tinkerer" aria-hidden="true" data-reveal style={{ '--reveal-delay': '180ms' } as CSSProperties}>
      <img src="/astrid-mink-tinkering.png" alt="" />
      <span className="astrid-vision-sparks" />
    </div>
  );
}

function useScrollReveal(active: boolean, reducedMotion: boolean, contentRevision: string | undefined, listKey: string) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const targets = [...(ref.current?.querySelectorAll<HTMLElement>('[data-reveal]') ?? [])];
    const show = (element: Element) => element.setAttribute('data-shown', 'true');
    if (reducedMotion || typeof IntersectionObserver !== 'function') { targets.forEach(show); return; }
    if (!active) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        show(entry.target);
        observer.unobserve(entry.target);
      }
    }, { rootMargin: '0px 0px -8% 0px' });
    targets.forEach((target) => observer.observe(target));
    return () => observer.disconnect();
  }, [active, reducedMotion, contentRevision, listKey]);
  return ref;
}



function GapPoint({ gap, openProjects }: { gap: PublicVisionGap; openProjects: PublicVisionProject[] }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const plans = openProjects.filter(project => project.gapIds.includes(gap.id)).slice(0, 3);
  return (
    <li className="astrid-vision-part" id={'gap-' + gap.id.toLowerCase()} data-reveal data-open={open || undefined}>
      <h3>
        <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(value => !value)}>
          <span className="astrid-vision-part-number" aria-hidden="true">{gap.id}</span>
          <span className="astrid-vision-part-title">{gap.title}</span>
          <ChevronDown aria-hidden="true" size={20} strokeWidth={1.75} />
        </button>
      </h3>
      <div className="astrid-vision-part-body" id={bodyId} hidden={!open}>
        <div className="astrid-vision-part-vision">
          <p className="astrid-vision-label">What we're working toward</p>
          <MarkdownText value={gap.desiredMarkdown} />
        </div>
        <div className="astrid-vision-part-issue">
          <p className="astrid-vision-label">Where we stand</p>
          <span className="astrid-vision-gap-state">{gap.assessment}</span>
          <MarkdownText value={gap.currentMarkdown} />
          <p className="astrid-vision-label astrid-vision-gap-missing-label">What's missing</p>
          <MarkdownText value={gap.missingMarkdown} />
          {plans.length > 0 && (
            <div className="astrid-vision-gap-plans">
              <p className="astrid-vision-label">Related projects</p>
              {plans.map(plan => <a key={plan.id} href={plan.githubUrl} target="_blank" rel="noreferrer">{plan.title}</a>)}
            </div>
          )}
          <a className="astrid-vision-source-link" href={gap.githubUrl} target="_blank" rel="noreferrer">Read full gap and evidence on GitHub</a>
        </div>
      </div>
    </li>
  );
}

function ProjectRow({ project }: { project: PublicVisionProject }) {
  return (
    <li className="astrid-vision-project-row">
      <div className="astrid-vision-project-head">
        <span className="astrid-vision-project-status" data-status={project.status}>{project.status}</span>
        <h3>{project.title}</h3>
      </div>
      <MarkdownText value={project.goalMarkdown} />
      <a href={project.githubUrl} target="_blank" rel="noreferrer">Project details on GitHub</a>
    </li>
  );
}


const VISION_QUIET_TEXT = '.astrid-vision-hero-copy, .astrid-vision-section-head, .astrid-vision-standards, .astrid-vision-parts-head, .astrid-vision-part h3, .astrid-vision-part-vision, .astrid-vision-issues-head, .astrid-vision-project-list';

export function PublicAstridVision({ onGoHome, environment: suppliedEnvironment, skySession: suppliedSkySession }: { onGoHome?: () => void; environment?: PublicAstridEnvironment; skySession?: PublicAstridSkySession } = {}) {
  const { content, error, retry } = usePublicVisionContent();
  const SOURCE_URL = content ? PUBLIC_VISION_REPO_URL + '/tree/' + content.source.revision : PUBLIC_VISION_REPO_URL;
  const PILLARS = content?.pillars.map((pillar, i) => ({ ...pillar, art: PILLAR_ART[i] })) ?? [];
  const CURRENT_GAPS = content?.gaps.filter(gap => gap.assessment !== 'closed') ?? [];
  const CURRENT_PROJECTS = content?.projects.filter(project => project.status !== 'done' && project.status !== 'cancelled') ?? [];
  const environment = usePublicAstridEnvironment(suppliedEnvironment);
  const { visible, reducedMotion, phone } = environment;
  const skySession = usePublicAstridSkySession(suppliedSkySession, environment);
  const skyControls = usePublicAstridSkyControls(skySession, visible);
  const palette = skyControls.palette;
  const [gapFilter, setGapFilter] = useState<GapFilter>('current');
  const [projectFilter, setProjectFilter] = useState<ProjectFilter>('current');
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [showAllGaps, setShowAllGaps] = useState(false);
  const [headerCondensed, setHeaderCondensed] = useState(false);
  const [selectedSubject, setSelectedSubject] = useState<VisionSubject | null>(null);
  useEffect(() => {
    if (!visible) return;
    const update = () => setHeaderCondensed(window.scrollY > 72);
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, [visible]);
  const detailTrigger = useRef<HTMLButtonElement | null>(null);
  const detailScrollY = useRef(0);
  // Restore keyboard focus after a dialog, but don't leave touch users with
  // a persistent WebKit focus rectangle around the whole card.
  const lastInteractionWasPointer = useRef(false);
  const detailOpenedByPointer = useRef(false);
  const openSubject = (subject: VisionSubject, trigger: HTMLButtonElement) => {
    detailOpenedByPointer.current = lastInteractionWasPointer.current;
    detailTrigger.current = trigger;
    detailScrollY.current = window.scrollY;
    setSelectedSubject(subject);
  };
  const closeSubject = () => {
    const trigger = detailTrigger.current;
    const previousScrollY = detailScrollY.current;
    setSelectedSubject(null);
    const pointerClose = detailOpenedByPointer.current;
    // Keyboard users get focus back. Touch users don't inherit the large
    // outline caused by Safari restoring focus to a full-card button.
    if (pointerClose) trigger?.blur();
    else trigger?.focus({ preventScroll: true });
    window.requestAnimationFrame(() => {
      if (pointerClose && document.activeElement === trigger) trigger?.blur();
      window.scrollTo(0, previousScrollY);
    });
  };
  const [agentCopyState, setAgentCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const agentCopyTimer = useRef<number>();
  const contributionIntro = content?.vision.contributeMarkdown
    ?.replace(/\n\n\[Give these instructions to your agent\]\([^)]+\)\s*$/, '') ?? '';
  const showAgentCopyStatus = (state: 'copied' | 'failed') => {
    window.clearTimeout(agentCopyTimer.current);
    setAgentCopyState(state);
    // Success is temporary; a failed copy keeps its GitHub fallback visible.
    if (state === 'copied') {
      agentCopyTimer.current = window.setTimeout(() => setAgentCopyState('idle'), 3000);
    }
  };
  const copyAgentInstructions = () => {
    const prompt = content?.vision.agentPrompt;
    if (!prompt || !navigator.clipboard?.writeText) { showAgentCopyStatus('failed'); return; }
    void navigator.clipboard.writeText(prompt)
      .then(() => showAgentCopyStatus('copied'))
      .catch(() => showAgentCopyStatus('failed'));
  };
  useEffect(() => {
    setAgentCopyState('idle');
    window.clearTimeout(agentCopyTimer.current);
    return () => window.clearTimeout(agentCopyTimer.current);
  }, [content?.source.revision]);
  // Newly filtered rows must still receive reveal observation.
  const pageRef = useScrollReveal(visible, reducedMotion, content?.source.revision,
    gapFilter + ':' + showAllGaps + ':' + projectFilter + ':' + showAllProjects);
  useLayoutEffect(() => {
    if (!visible) return undefined;
    return skySession.registerPaletteTarget(pageRef.current, 'vision');
  }, [skySession, visible, pageRef]);
  // A tap plays a card's mink once, for touch screens where there is no hover.
  const [playing, setPlaying] = useState<number | null>(null);
  const playTimer = useRef<number>();
  const play = (index: number) => {
    if (!visible || reducedMotion) return;
    window.clearTimeout(playTimer.current);
    setPlaying(index);
    playTimer.current = window.setTimeout(() => setPlaying(null), 3000);
  };
  useEffect(() => () => window.clearTimeout(playTimer.current), []);
  useEffect(() => {
    if (visible && !reducedMotion) return;
    window.clearTimeout(playTimer.current);
    setPlaying(null);
    setCentred(null);
  }, [visible, reducedMotion]);
  // On a phone there is no hover, so the card crossing the middle of the screen plays as you scroll past.
  const principlesRef = useRef<HTMLOListElement>(null);
  const [centred, setCentred] = useState<number | null>(null);
  useEffect(() => {
    const list = principlesRef.current;
    if (!visible || reducedMotion || !phone || !list || typeof IntersectionObserver !== 'function') { setCentred(null); return undefined; }
    const cards = Array.from(list.children);
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const index = cards.indexOf(entry.target);
        if (entry.isIntersecting) setCentred(index);
        else setCentred((current) => (current === index ? null : current));
      }
    }, { rootMargin: '-45% 0px -45% 0px' });
    cards.forEach((card) => observer.observe(card));
    return () => observer.disconnect();
  }, [phone, visible, reducedMotion, content?.source.revision]);
  // Mirror the pillar minks: each principle's pixel sigil animates as its
  // card crosses the center of the phone viewport, without requiring hover.
  const sigilsRef = useRef<HTMLOListElement>(null);
  const [centeredSigil, setCenteredSigil] = useState<string | null>(null);
  useEffect(() => {
    const list = sigilsRef.current;
    if (!visible || reducedMotion || !phone || !list || typeof IntersectionObserver !== 'function') {
      setCenteredSigil(null);
      return undefined;
    }
    const cards = [...list.querySelectorAll<HTMLElement>('[data-principle]')];
    const observer = new IntersectionObserver(() => {
      const middle = window.innerHeight / 2;
      const match = cards.find(card => {
        const bounds = card.getBoundingClientRect();
        return bounds.top <= middle && bounds.bottom >= middle;
      });
      setCenteredSigil(match?.dataset.principle ?? null);
    }, { rootMargin: '-45% 0px -45% 0px' });
    cards.forEach(card => observer.observe(card));
    return () => observer.disconnect();
  }, [phone, visible, reducedMotion, content?.source.revision]);
  const filteredGaps = (content?.gaps ?? []).filter(gap =>
    gapFilter === 'all' || (gapFilter === 'current' ? gap.assessment !== 'closed' : gap.assessment === gapFilter));
  const gapsToShow = showAllGaps ? filteredGaps : filteredGaps.slice(0, 10);
  const selectedProjects = (content?.projects ?? []).filter(project =>
    projectFilter === 'all' || (projectFilter === 'current'
      ? project.status !== 'done' && project.status !== 'cancelled'
      : project.status === projectFilter));
  const projectsToShow = projectFilter !== 'current' || showAllProjects
    ? selectedProjects : selectedProjects.slice(0, 8);
  return (
    <main className="astrid-vision" ref={pageRef} tabIndex={-1}
      onPointerDownCapture={() => { lastInteractionWasPointer.current = true; }}
      onKeyDownCapture={() => { lastInteractionWasPointer.current = false; }}
      data-astrid-visual-active={visible} data-dusk style={{
      '--astrid-paper': palette.paper,
      '--astrid-dusk': palette.dusk,
      '--astrid-dusk-ink': palette.ink,
      '--astrid-dusk-firm': palette.firm,
      '--astrid-dusk-ink-page': palette.inkPage,
      ...palette.tokens,
    } as CSSProperties}>
      {visible && <PublicAstridSky
        session={skySession}
        active={visible}
        geometryRoot={pageRef}
        geometryOwner="vision"
        reducedMotion={reducedMotion}
        quietBehind={VISION_QUIET_TEXT}
      />}
      <header className="astrid-vision-bar" data-condensed={headerCondensed || undefined}>
        <a className="astrid-vision-brand" href="/home" aria-label="Astrid home" onClick={(event) => followInPage(event, onGoHome)}>
          <img src="/astrid-mink-provisional.webp" alt="" />
          <span className="astrid-vision-brand-name">Astrid</span>
        </a>
        {content && <VisionSectionNav reducedMotion={reducedMotion}
          includeHelp={Boolean(content.vision.contributeMarkdown)} />}
      </header>

      <section id="astrid-vision-manifesto" className="astrid-vision-manifesto" aria-labelledby="astrid-vision-title">
        <div className="astrid-vision-hero">
          <div className="astrid-vision-hero-copy">
            <p className="astrid-vision-eyebrow">Vision &amp; Issues</p>
            {content
              ? <>
                  <h1 id="astrid-vision-title">{content.vision.title}</h1>
                  <MarkdownText className="astrid-vision-lead" value={content.vision.introMarkdown} />
                  <p className="astrid-vision-source-attribution">
                    This vision is drawn from the <a href={PUBLIC_VISION_REPO_URL} target="_blank" rel="noreferrer">Astrid Dev repository</a>.
                  </p>
                </>
              : error
                ? <>
                    <h1 id="astrid-vision-title">Astrid’s vision</h1>
                    <p className="astrid-vision-lead" role="alert">
                      The live vision is temporarily unavailable. <button type="button" onClick={retry}>Try again</button> · <a href={PUBLIC_VISION_REPO_URL + '/blob/main/vision/README.md'} target="_blank" rel="noreferrer">Read on GitHub</a>
                    </p>
                  </>
                : <div className="astrid-vision-skeleton-hero" role="status" aria-label="Loading Astrid's vision">
                    <div className="astrid-vision-skeleton-line" />
                    <div className="astrid-vision-skeleton-line" />
                    <div className="astrid-vision-skeleton-line astrid-vision-skeleton-line-short" />
                  </div>}
          </div>
          <Juggler />
        </div>
      </section>

      {!content && !error && (
        <div className="astrid-vision-loading-sections" aria-hidden="true">
          <section className="astrid-vision-loading-group">
            <div className="astrid-vision-skeleton-line astrid-vision-skeleton-section-title" />
            <div className="astrid-vision-loading-pillars">
              {Array.from({ length: 4 }, (_, i) => <div key={i} className="astrid-vision-loading-pillar">
                <div className="astrid-vision-skeleton-line astrid-vision-skeleton-label" />
                <div className="astrid-vision-skeleton-line" />
                <div className="astrid-vision-skeleton-line astrid-vision-skeleton-line-short" />
              </div>)}
            </div>
          </section>
          <section className="astrid-vision-loading-group">
            <div className="astrid-vision-skeleton-line astrid-vision-skeleton-section-title" />
            <div className="astrid-vision-loading-principles">
              {Array.from({ length: 4 }, (_, i) => <div key={i} className="astrid-vision-loading-principle">
                <div className="astrid-vision-skeleton-line" />
                <div className="astrid-vision-skeleton-line astrid-vision-skeleton-line-short" />
              </div>)}
            </div>
          </section>
          <section className="astrid-vision-loading-group">
            <div className="astrid-vision-skeleton-line astrid-vision-skeleton-section-title" />
            {Array.from({ length: 3 }, (_, i) => <div key={i} className="astrid-vision-loading-row">
              <div className="astrid-vision-skeleton-line" />
            </div>)}
          </section>
          <section className="astrid-vision-loading-group">
            <div className="astrid-vision-skeleton-line astrid-vision-skeleton-section-title" />
            <div className="astrid-vision-loading-projects">
              {Array.from({ length: 9 }, (_, i) => <div key={i} className="astrid-vision-loading-project">
                <div className="astrid-vision-skeleton-line" />
                <div className="astrid-vision-skeleton-line astrid-vision-skeleton-line-short" />
              </div>)}
            </div>
          </section>
        </div>
      )}
      {content && (<>
      <section id="astrid-vision-pillars" className="astrid-vision-north-star" aria-labelledby="astrid-vision-north-star-title">
        <div className="astrid-vision-section-head" data-reveal>
          <p className="astrid-vision-eyebrow">The vision</p>
          <h2 id="astrid-vision-north-star-title">The four pillars of our vision</h2>
        </div>
        <ol className="astrid-vision-principles" ref={principlesRef}>
          {PILLARS.map((pillar, index) => (
            <li key={pillar.id} data-ns-host data-reveal
              data-play={playing === index || centred === index || undefined}
              style={{ '--reveal-delay': (index % 2) * 90 + 'ms' } as CSSProperties}
              onClick={() => play(index)}>
              <span className="astrid-vision-pillar-number" aria-hidden="true">{index + 1}.</span>
              <h3>{pillar.title}</h3>
              <p>{pillar.descriptor}</p>
              <NorthStarMink art={pillar.art} />
              <span className="astrid-vision-pillar-details" aria-hidden="true">
                Details <span className="astrid-vision-card-arrow">↗</span>
              </span>
              <button type="button" className="astrid-vision-card-open"
                aria-label={'Explore ' + pillar.title + ': gaps and projects'}
                onClick={event => openSubject({ kind: 'pillar', id: pillar.id }, event.currentTarget)} />
            </li>
          ))}
        </ol>
      </section>

      <section id="astrid-vision-standards" className="astrid-vision-standards" aria-labelledby="astrid-vision-standards-title">
        <div className="astrid-vision-section-head" data-reveal>
          <p className="astrid-vision-eyebrow">Our aspirations</p>
          <h2 id="astrid-vision-standards-title">The principles that drive us</h2>
        </div>
        <ol className="astrid-vision-standards-list" ref={sigilsRef}>
          {content.principles.map(principle => (
            <li key={principle.id} data-reveal data-principle={principle.id}
              data-sigil-active={centeredSigil === principle.id || undefined}>
              <VisionPrincipleSigil principleId={principle.id} />
              <div>
                <h3>{principle.title}</h3>
                {principle.statement
                  ? <p className="astrid-vision-principle-statement">{principle.statement}</p>
                  : <MarkdownText value={principle.bodyMarkdown} />}
              </div>
              <span className="astrid-vision-principle-corner" aria-hidden="true">
                <span className="astrid-vision-card-arrow">↗</span>
              </span>
              <button type="button" className="astrid-vision-card-open"
                aria-label={'Explore ' + principle.title + ': gaps and projects'}
                onClick={event => openSubject({ kind: 'principle', id: principle.id }, event.currentTarget)} />
            </li>
          ))}
        </ol>
      </section>

      <section id="astrid-vision-parts" className="astrid-vision-parts" aria-labelledby="astrid-vision-parts-title">
        <div className="astrid-vision-section-head astrid-vision-parts-head" data-reveal>
          <p className="astrid-vision-eyebrow">The gaps</p>
          <h2 id="astrid-vision-parts-title">{gapFilter === 'all' ? 'All vision gaps' : gapFilter === 'closed' ? 'Gaps we’ve closed' : "What's still missing"}</h2>
        </div>
        <div className="astrid-vision-context-row">
          <p className="astrid-vision-section-context">These are the gaps between where we are now and where we want to get to, and the evidence we're using to assess our progress. <a href={PUBLIC_VISION_REPO_URL + '/blob/main/docs/contribution-workflow.md#define-or-reassess-a-vision-gap'} target="_blank" rel="noreferrer">What makes a gap?</a></p>
          <div className="astrid-vision-filter-bar">
            <label htmlFor="astrid-vision-gap-filter">Status</label>
            <select id="astrid-vision-gap-filter" aria-label="Filter gaps by status" value={gapFilter}
              onChange={event => { setGapFilter(event.target.value as GapFilter); setShowAllGaps(false); }}>
              {GAP_FILTERS.map(option => <option key={option.value} value={option.value}>
                {option.label} ({option.value === 'current' ? CURRENT_GAPS.length : option.value === 'all'
                  ? content.gaps.length : content.gaps.filter(gap => gap.assessment === option.value).length})
              </option>)}
            </select>
          </div>
        </div>
        <ol id="astrid-vision-gap-list">{gapsToShow.map(gap => <GapPoint key={gap.id} gap={gap} openProjects={CURRENT_PROJECTS} />)}</ol>
        {filteredGaps.length === 0 && <p className="astrid-vision-filter-empty" role="status">No gaps with this status yet.</p>}
        {filteredGaps.length > 10 && (
          <button className="astrid-vision-more-button astrid-vision-gaps-more" type="button"
            aria-expanded={showAllGaps} aria-controls="astrid-vision-gap-list"
            onClick={() => setShowAllGaps(value => !value)}>
            {showAllGaps ? 'Show fewer gaps' : 'Show all gaps'}
          </button>
        )}
      </section>

      <section id="astrid-vision-projects" className="astrid-vision-issues astrid-vision-projects" aria-labelledby="astrid-vision-projects-title">
        <div className="astrid-vision-section-head astrid-vision-issues-head" data-reveal>
          <p className="astrid-vision-eyebrow">Project catalog</p>
          <h2 id="astrid-vision-projects-title">Help us build what's next</h2>
        </div>
        <div className="astrid-vision-context-row">
          <p className="astrid-vision-section-context">These projects come directly from the <a href={SOURCE_URL + '/plans'} target="_blank" rel="noreferrer">Astrid Dev catalog</a>, in priority order. A listing doesn't mean someone has already started work.</p>
          <div className="astrid-vision-filter-bar">
            <label htmlFor="astrid-vision-project-filter">Status</label>
            <select id="astrid-vision-project-filter" aria-label="Filter projects by status" value={projectFilter}
              onChange={event => { setProjectFilter(event.target.value as ProjectFilter); setShowAllProjects(false); }}>
              {PROJECT_FILTERS.map(option => <option key={option.value} value={option.value}>
                {option.label} ({option.value === 'current' ? CURRENT_PROJECTS.length : option.value === 'all'
                  ? content.projects.length : content.projects.filter(project => project.status === option.value).length})
              </option>)}
            </select>
          </div>
        </div>
        <ul className="astrid-vision-issues-list astrid-vision-project-list" id="astrid-vision-project-list">
          {projectsToShow.map(project => <ProjectRow key={project.id} project={project} />)}
          {projectFilter === 'current' && !showAllProjects && CURRENT_PROJECTS.length > 8 && (
            <li className="astrid-vision-project-more">
              <button type="button" aria-expanded="false" aria-controls="astrid-vision-project-list" onClick={() => setShowAllProjects(true)}>
                <span className="astrid-vision-project-more-label">Explore the work</span>
                <strong>View all {CURRENT_PROJECTS.length} current projects</strong>
                <span aria-hidden="true">↗</span>
              </button>
            </li>
          )}
        </ul>
        {selectedProjects.length === 0 && <p className="astrid-vision-filter-empty" role="status">No projects with this status yet.</p>}
        {projectFilter === 'current' && showAllProjects && CURRENT_PROJECTS.length > 8 && (
          <button className="astrid-vision-more-button" type="button" onClick={() => setShowAllProjects(false)}>
            Show fewer projects
          </button>
        )}
        <p className="astrid-vision-issues-more" data-reveal>
          <a href={SOURCE_URL + '/plans'} target="_blank" rel="noreferrer">Explore every plan and its technical details on GitHub</a>
        </p>
      </section>

      </>)}
      {content && selectedSubject && (
        <VisionDetailDialog key={selectedSubject.kind + ':' + selectedSubject.id}
          content={content} subject={selectedSubject} onClose={closeSubject} />
      )}
      {content?.vision.contributeMarkdown && (
        <section className="astrid-vision-contribute" id="astrid-vision-contribute"
          aria-labelledby="astrid-vision-contribute-title" data-reveal>
          <div className="astrid-vision-contribute-copy">
            <p className="astrid-vision-eyebrow">Get involved</p>
            <h2 id="astrid-vision-contribute-title">Want to help build Astrid?</h2>
            <MarkdownText value={contributionIntro} />
            {content.vision.agentPrompt ? (
              <button className="astrid-vision-copy-agent-button" type="button" onClick={copyAgentInstructions} aria-live="polite">
                <span className="astrid-vision-copy-agent-measure" aria-hidden="true">Instructions copied for your agent</span>
                <span>{agentCopyState === 'copied' ? 'Instructions copied for your agent' : 'Copy instructions for agents'}</span>
              </button>
            ) : (
              <a className="astrid-vision-copy-agent-fallback" href={PUBLIC_VISION_REPO_URL + '#want-to-contribute-give-this-to-your-agent'}
                target="_blank" rel="noreferrer">See agent instructions on GitHub</a>
            )}
            {agentCopyState === 'failed' && (
              <p className="astrid-vision-copy-agent-status" role="alert">
                Couldn’t copy. <a href={PUBLIC_VISION_REPO_URL + '#want-to-contribute-give-this-to-your-agent'}
                  target="_blank" rel="noreferrer">Open instructions on GitHub</a>.
              </p>
            )}
          </div>
          <Tinkerer />
        </section>
      )}
      <footer className="astrid-vision-footer">
        {error && content && <p className="astrid-vision-content-source" role="status">Showing the last loaded vision; the latest update could not be checked. <button type="button" onClick={retry}>Retry</button></p>}
        <div className="astrid-vision-end" />
        <PublicAstridSocialLinks className="astrid-vision-social" />
      </footer>
    </main>
  );
}
