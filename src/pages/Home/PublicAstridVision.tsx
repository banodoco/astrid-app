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
import './PublicAstridVision.css';

const PILLAR_ART: readonly NorthStarArt[] = [
  NORTH_STAR_ART.art,
  NORTH_STAR_ART.adapt,
  NORTH_STAR_ART.knowledge,
  NORTH_STAR_ART.community,
];
// Only the selection/order belongs to the website; the titles and statements remain in Astrid Dev.
const FEATURED_GAP_IDS = ['AA-001', 'LS-001', 'CI-001', 'F-003', 'CA-001', 'CA-002'];

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

/**
 * The old saying, struck through, and the idean Astrid is built on beneath it. Each part rises in with the
 * page's shared reveal, a beat apart as in the other sections; the strike draws across once the quote
 * is in place.
 */
function ToolsShift() {
  return (
    <figure className="astrid-vision-shift">
      <blockquote className="astrid-vision-shift-old" data-reveal>
        <p><span>“We shape our tools, and thereafter our tools shape&nbsp;us.”</span></p>
      </blockquote>
      {/* The mink comes before the supporting line so, on a phone, that line can wrap around him. */}
      <div className="astrid-vision-shift-grow">
        <p className="astrid-vision-shift-new" data-reveal style={{ '--reveal-delay': '90ms' } as CSSProperties}>Together with our AI, we grow into our tools as we use&nbsp;them.</p>
        <Tinkerer />
        <p className="astrid-vision-shift-support" data-reveal style={{ '--reveal-delay': '180ms' } as CSSProperties}>
          Every part of a tool should be shaped as you work, around the project in front of you.
        </p>
      </div>
    </figure>
  );
}


function useScrollReveal(active: boolean, reducedMotion: boolean, contentRevision: string | undefined, allGapsVisible: boolean) {
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
  }, [active, reducedMotion, contentRevision, allGapsVisible]);
  return ref;
}



function GapPoint({ gap, phone, openProjects }: { gap: PublicVisionGap; phone: boolean; openProjects: PublicVisionProject[] }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const expanded = !phone || open;
  const plans = openProjects.filter(project => project.gapIds.includes(gap.id)).slice(0, 3);
  return (
    <li className="astrid-vision-part" id={'gap-' + gap.id.toLowerCase()} data-reveal data-open={expanded || undefined}>
      <span className="astrid-vision-part-number" aria-hidden="true">{gap.id}</span>
      <h3>{phone ? (
        <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(value => !value)}>
          <span>{gap.title}</span>
          <ChevronDown aria-hidden="true" size={18} strokeWidth={1.75} />
        </button>
      ) : gap.title}</h3>
      <div className="astrid-vision-part-body" id={bodyId} hidden={!expanded || undefined}>
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
    <li className="astrid-vision-project-row" data-reveal>
      <div className="astrid-vision-project-head">
        <span className="astrid-vision-project-status" data-status={project.status}>{project.status}</span>
        <h3>{project.title}</h3>
      </div>
      <MarkdownText value={project.goalMarkdown} />
      <a href={project.githubUrl} target="_blank" rel="noreferrer">Project details on GitHub</a>
    </li>
  );
}


const VISION_QUIET_TEXT = '.astrid-vision-hero-copy, .astrid-vision-section-head, .astrid-vision-standards, .astrid-vision-parts-head, .astrid-vision-part h3, .astrid-vision-part-vision, .astrid-vision-issues-head, .astrid-vision-project-list, .astrid-vision-shift';

export function PublicAstridVision({ onGoHome, environment: suppliedEnvironment, skySession: suppliedSkySession }: { onGoHome?: () => void; environment?: PublicAstridEnvironment; skySession?: PublicAstridSkySession } = {}) {
  const { content, error, retry } = usePublicVisionContent();
  const SOURCE_URL = content ? PUBLIC_VISION_REPO_URL + '/tree/' + content.source.revision : PUBLIC_VISION_REPO_URL;
  const PILLARS = content?.pillars.map((pillar, i) => ({ ...pillar, art: PILLAR_ART[i] })) ?? [];
  const FEATURED_GAPS = FEATURED_GAP_IDS.map(id => content?.gaps.find(gap => gap.id === id))
    .filter((gap): gap is PublicVisionGap => gap !== undefined);
  const OTHER_GAPS = content?.gaps.filter(gap => !FEATURED_GAP_IDS.includes(gap.id)) ?? [];
  const OPEN_PROJECTS = content?.projects.filter(project => project.status !== 'done' && project.status !== 'cancelled') ?? [];
  const environment = usePublicAstridEnvironment(suppliedEnvironment);
  const { visible, reducedMotion, phone } = environment;
  const skySession = usePublicAstridSkySession(suppliedSkySession, environment);
  const skyControls = usePublicAstridSkyControls(skySession, visible);
  const palette = skyControls.palette;
  const [showAllGaps, setShowAllGaps] = useState(false);
  const [showAllProjects, setShowAllProjects] = useState(false);
  // New rows are mounted after the initial fetch. Reobserve when the list grows.
  const pageRef = useScrollReveal(visible, reducedMotion, content?.source.revision, showAllGaps);
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
  const gapsToShow = showAllGaps ? [...FEATURED_GAPS, ...OTHER_GAPS] : FEATURED_GAPS;
  const projectsToShow = showAllProjects ? OPEN_PROJECTS : OPEN_PROJECTS.slice(0, 12);
  return (
    <main className="astrid-vision" ref={pageRef} tabIndex={-1} data-astrid-visual-active={visible} data-dusk style={{
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
      <header className="astrid-vision-bar">
        <a className="astrid-vision-brand" href="/home" aria-label="Astrid home" onClick={(event) => followInPage(event, onGoHome)}>
          <img src="/astrid-mink-provisional.webp" alt="" />
          <span>Astrid</span>
        </a>
      </header>

      <section className="astrid-vision-manifesto" aria-labelledby="astrid-vision-title">
        <div className="astrid-vision-hero">
          <div className="astrid-vision-hero-copy">
            <p className="astrid-vision-eyebrow">Vision &amp; Issues</p>
            <h1 id="astrid-vision-title">{content?.vision.title ?? 'Astrid’s vision'}</h1>
            {content
              ? <MarkdownText className="astrid-vision-lead" value={content.vision.introMarkdown} />
              : <p className="astrid-vision-lead" role={error ? 'alert' : 'status'}>
                  {error ? 'The live vision is temporarily unavailable.' : 'Loading the latest vision…'}
                  {error && <> <button type="button" onClick={retry}>Try again</button> · <a href={PUBLIC_VISION_REPO_URL + '/blob/main/visions/vision.md'} target="_blank" rel="noreferrer">Read on GitHub</a></>}
                </p>}
          </div>
          <Juggler />
        </div>
      </section>

      {content && (<>
      <section className="astrid-vision-north-star" aria-labelledby="astrid-vision-north-star-title">
        <div className="astrid-vision-section-head" data-reveal>
          <p className="astrid-vision-eyebrow">The vision</p>
          <h2 id="astrid-vision-north-star-title">What we're building</h2>
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
            </li>
          ))}
        </ol>
      </section>

      <section className="astrid-vision-standards" aria-labelledby="astrid-vision-standards-title">
        <div className="astrid-vision-section-head" data-reveal>
          <p className="astrid-vision-eyebrow">Operating principles</p>
          <h2 id="astrid-vision-standards-title">How we build it</h2>
        </div>
        <ol className="astrid-vision-standards-list">
          {content.principles.map((principle, index) => (
            <li key={principle.id} data-reveal>
              <span aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
              <div>
                <h3>{principle.title}</h3>
                <MarkdownText value={principle.bodyMarkdown} />
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="astrid-vision-parts" aria-labelledby="astrid-vision-parts-title">
        <div className="astrid-vision-parts-head" data-reveal>
          <div>
            <p className="astrid-vision-eyebrow">The gaps</p>
            <h2 id="astrid-vision-parts-title">What's still missing</h2>
          </div>
          <p>The vision is ambitious. These are the outcomes we haven't fully demonstrated yet, and the evidence we're using to assess progress.</p>
        </div>
        <ol id="astrid-vision-gap-list">{gapsToShow.map(gap => <GapPoint key={gap.id} gap={gap} phone={phone} openProjects={OPEN_PROJECTS} />)}</ol>
        {OTHER_GAPS.length > 0 && (
          <button className="astrid-vision-more-button" type="button"
            aria-expanded={showAllGaps}
            aria-controls="astrid-vision-gap-list"
            onClick={() => setShowAllGaps(value => !value)}>
            {showAllGaps ? 'Show featured gaps only' : 'Show all ' + content.gaps.length + ' gaps'}
          </button>
        )}
      </section>

      <section className="astrid-vision-issues astrid-vision-projects" aria-labelledby="astrid-vision-projects-title">
        <div className="astrid-vision-issues-head" data-reveal>
          <div>
            <p className="astrid-vision-eyebrow">Open projects</p>
            <h2 id="astrid-vision-projects-title">Help us build what's next</h2>
          </div>
          <p>These projects come directly from the <a href={SOURCE_URL + '/plans'} target="_blank" rel="noreferrer">Astrid Dev catalog</a>, in priority order. A project being listed doesn't mean someone has already started it.</p>
        </div>
        <ul className="astrid-vision-issues-list astrid-vision-project-list">
          {projectsToShow.map(project => <ProjectRow key={project.id} project={project} />)}
        </ul>
        {!showAllProjects && OPEN_PROJECTS.length > 12 && (
          <button className="astrid-vision-more-button" type="button" onClick={() => setShowAllProjects(true)}>
            Show all {OPEN_PROJECTS.length} open projects
          </button>
        )}
        <p className="astrid-vision-issues-more" data-reveal>
          <a href={SOURCE_URL + '/plans'} target="_blank" rel="noreferrer">Explore every plan and its technical details on GitHub</a>
        </p>
      </section>

      <div className="astrid-vision-mobile-juggler" aria-hidden="true"><Juggler /></div>
      </>)}
      <ToolsShift />
      {content?.vision.contributeMarkdown && (
        <section className="astrid-vision-contribute" aria-labelledby="astrid-vision-contribute-title" data-reveal>
          <p className="astrid-vision-eyebrow">Get involved</p>
          <h2 id="astrid-vision-contribute-title">Want to help build Astrid?</h2>
          <MarkdownText value={content.vision.contributeMarkdown} />
          <a href={PUBLIC_VISION_REPO_URL + '/blob/' + content.source.revision + '/plans/index.md'}
            target="_blank" rel="noreferrer">Explore projects on GitHub</a>
        </section>
      )}
      <footer className="astrid-vision-footer">
        {error && content && <p className="astrid-vision-content-source" role="status">Showing the last loaded vision; the latest update could not be checked. <button type="button" onClick={retry}>Retry</button></p>}
        <p className="astrid-vision-content-source">Vision, gaps and projects generated from <a href={SOURCE_URL} target="_blank" rel="noreferrer">Astrid Dev</a>. The source records explain what has and hasn't been demonstrated.</p>
        <div className="astrid-vision-end" />
        <PublicAstridSocialLinks className="astrid-vision-social" />
      </footer>
    </main>
  );
}
