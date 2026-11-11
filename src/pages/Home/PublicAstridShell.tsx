import { Component, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode, type RefCallback } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { retargetMotionTiming, type PublicAstridExperience, type PublicAstridMotionClock, type PublicAstridMotionTiming } from './publicAstridMotion';
import { ACTIVE_PUBLIC_ASTRID_EXAMPLE_METADATA, loadActivePublicAstridExample } from './publicAstridExampleSelection.ts';
import type { PublicAstridMountedEditorProps } from './PublicAstridMountedEditor.tsx';
import { PublicAstridCallouts } from './PublicAstridCallouts.tsx';
import { PublicAstridHeroCta } from './PublicAstridHeroCta.tsx';
import { MinkCircle } from './components/MinkCircle/MinkCircle';
import './PublicAstridShell.css';
import { PublicAstridSocialLinks } from './PublicAstridSocialLinks.tsx';
import { usePublicAstridLayoutGlide } from './usePublicAstridLayoutGlide';
import { usePublicAstridPlayerHeight } from './usePublicAstridPlayerHeight';
import { followInPage, VISION_PATH } from './publicAstridLinks';
import { usePublicAstridEnvironment, type PublicAstridEnvironment, type PublicAstridLifecycle } from './publicAstridLifecycle';
import { readPublicAstridExperience, usePublicAstridNavigation, writePublicAstridExperience } from './publicAstridNavigation';
import {
  createPublicAstridReadiness,
  reducePublicAstridReadiness,
  retryPublicAstridReadiness,
  type PublicAstridReadiness,
  type PublicAstridReadinessEvent,
} from './publicAstridReadiness';
import {
  PUBLIC_ASTRID_SKY_REPLAY_MS,
  PUBLIC_ASTRID_SKY_REPLAY_SETTLE_MS,
  PUBLIC_ASTRID_SKY_REPLAY_TURN_MS,
  PublicAstridSky,
  usePublicAstridSkyControls,
} from './PublicAstridSky.tsx';
import type { PublicAstridSkySession } from './publicAstridSkySession';
import { usePublicAstridSkySession } from './usePublicAstridSkySession';
import { preloadPublicVisionContent } from './publicVisionContent';

const EDITOR_RELOAD_PENDING_KEY = 'astrid-public-editor-reload-pending';
/** The editor stays hidden until its first frame and side panel are ready, so it assembles in one piece. */
const EDITOR_REVEAL_TIMEOUT_MS = 2_500;
const EDITOR_LOADER_RETIRE_TIMEOUT_MS = 850;

async function loadPublicAstridMountedEditor() {
  const [module, example] = await Promise.all([
    import('./PublicAstridMountedEditor.tsx'),
    loadActivePublicAstridExample(),
  ]);
  const MountedEditor = module.PublicAstridMountedEditor;
  return {
    default: (props: Omit<PublicAstridMountedEditorProps, 'example'>) => (
      <MountedEditor {...props} example={example} />
    ),
  };
}

function isDynamicImportFailure(error: Error): boolean {
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Loading chunk|ChunkLoadError|MIME type/i.test(error.message);
}

interface EditorChunkBoundaryProps {
  attempt: number;
  children: ReactNode;
  fallback: ReactNode;
  onChunkFailure: (attempt: number, error: Error) => void;
}

interface EditorChunkBoundaryState {
  attempt: number;
  error: Error | null;
}

/** Keeps a failed editor import inside its reserved stage and can reset for a fresh lazy attempt. */
class EditorChunkBoundary extends Component<EditorChunkBoundaryProps, EditorChunkBoundaryState> {
  constructor(props: EditorChunkBoundaryProps) {
    super(props);
    this.state = { attempt: props.attempt, error: null };
  }

  static getDerivedStateFromProps(
    props: EditorChunkBoundaryProps,
    state: EditorChunkBoundaryState,
  ): Partial<EditorChunkBoundaryState> | null {
    return props.attempt === state.attempt ? null : { attempt: props.attempt, error: null };
  }

  static getDerivedStateFromError(error: Error): Partial<EditorChunkBoundaryState> {
    if (!isDynamicImportFailure(error)) throw error;
    return { error };
  }

  componentDidCatch(error: Error): void {
    this.props.onChunkFailure(this.props.attempt, error);
  }

  render() {
    if (this.state.error && this.state.attempt === this.props.attempt) return this.props.fallback;
    return this.props.children;
  }
}

function EditorChunkReady({ attempt, active, onReady }: { attempt: number; active: boolean; onReady: (attempt: number) => void }) {
  useEffect(() => {
    if (active) onReady(attempt);
  }, [active, attempt, onReady]);
  return null;
}

type ExperienceState = PublicAstridExperience;
type MotionTiming = PublicAstridMotionTiming;

function useInactiveSurface<T extends HTMLElement = HTMLElement>(inactive: boolean): RefCallback<T> {
  return useCallback((surface: T | null) => {
    if (!surface) return;
    if (inactive) surface.setAttribute('inert', '');
    else surface.removeAttribute('inert');
  }, [inactive]);
}


/**
 * Switching audience also switches theme (light App, dark Agent). A root View Transition crossfades the
 * whole page in one piece — the old view stays frozen while the live new one fades in over it — so no
 * element can flash its new colour early. Without View Transitions the flat elements crossfade in CSS.
 */
function drawnAt(element: Element, x: number, y: number) {
  const box = element.getBoundingClientRect();
  return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
}

function routeAnnouncement(state: ExperienceState): string {
  return state.audience === 'app' ? 'App.' : 'Agent.';
}

function HeroSubtitle({ audience, phone, onSwitch }: { audience: ExperienceState['audience']; phone: boolean; onSwitch: (audience: ExperienceState['audience']) => void }) {
  return (
    <div className={phone ? 'astrid-mobile-hero-subtitles' : undefined}>
      <p className="astrid-hero-subtitle">
        <span className="astrid-subtitle-shared">An </span><span className="astrid-subtitle-swap">
          {(['app', 'agent'] as const).map((mode) => (
            <span key={mode} className="astrid-subtitle-variant" data-active={audience === mode} aria-hidden={audience !== mode}>
              <button
                type="button"
                className="astrid-audience-phrase"
                tabIndex={audience === mode ? undefined : -1}
                onClick={() => onSwitch(mode === 'app' ? 'agent' : 'app')}
                aria-label={mode === 'app' ? 'Switch to Agent' : 'Switch to App'}
              >{mode === 'app' ? 'agent-powered' : 'editor-powered'}</button>
              {mode === 'app' ? ' video editor' : ' creative agent'}
            </span>
          ))}
        </span><span className="astrid-subtitle-shared"> built to unlock the artistic potential of open models.</span>
      </p>
    </div>
  );
}

function sameExperience(left: ExperienceState, right: ExperienceState): boolean {
  return left.audience === right.audience;
}

interface PublicAstridShellProps {
  onOpenVision?: () => void;
  lifecycle?: PublicAstridLifecycle;
  environment?: PublicAstridEnvironment;
  navigation?: { experience: ExperienceState; onExperienceChange: (next: ExperienceState) => void };
  skySession?: PublicAstridSkySession;
}

export function PublicAstridShell({ onOpenVision, lifecycle = 'active', environment: suppliedEnvironment, navigation, skySession: suppliedSkySession }: PublicAstridShellProps = {}) {
  const environment = usePublicAstridEnvironment(suppliedEnvironment);
  const { reducedMotion: prefersReducedMotion } = environment;
  const visualActive = lifecycle === 'active' && environment.visible;
  const skySession = usePublicAstridSkySession(suppliedSkySession, environment);
  const skyControls = usePublicAstridSkyControls(skySession, visualActive);
  const sky = skyControls.settings;
  const palette = skyControls.palette;
  const theme = palette.theme;
  const visualActiveRef = useRef(visualActive);
  visualActiveRef.current = visualActive;
  const { run: runLocalNavigation, invalidate: invalidateLocalNavigation } = usePublicAstridNavigation(environment);
  const [localState, setLocalState] = useState<ExperienceState>(readPublicAstridExperience);
  const state = navigation?.experience ?? localState;
  const standalone = navigation === undefined;
  // The rendered intro guard must also match the current audience: callout
  // componentDidUpdate reads layout before our effects can retire this state.
  const [directEntryAudience, setDirectEntryAudience] = useState<ExperienceState['audience'] | null>(() => state.audience);
  const previousAudienceRef = useRef(state.audience);
  useLayoutEffect(() => {
    if (state.audience === previousAudienceRef.current) return;
    previousAudienceRef.current = state.audience;
    setDirectEntryAudience(null);
  }, [state.audience]);
  const [hasViewedAgent, setHasViewedAgent] = useState(() => state.audience === 'agent');
  useEffect(() => {
    if (state.audience === 'agent') setHasViewedAgent(true);
  }, [state.audience]);
  const [transportOutlet, setTransportOutlet] = useState<HTMLDivElement | null>(null);
  const editorStageRef = useRef<HTMLDivElement>(null);
  const editorFailurePanelRef = useRef<HTMLDivElement>(null);
  const editorAttemptRef = useRef(0);
  const editorLoadStatusRef = useRef<'initial' | 'loading' | 'failed' | 'ready'>('initial');
  const editorShellMountedRef = useRef(true);
  const editorReloadPendingRef = useRef(false);
  const [editorAttempt, setEditorAttempt] = useState(0);
  const [editorRetryCount, setEditorRetryCount] = useState(0);
  const [editorLoadStatus, setEditorLoadStatus] = useState<'initial' | 'loading' | 'failed' | 'ready'>('initial');
  const [editorReloadFollowup, setEditorReloadFollowup] = useState(false);
  const [LazyPublicAstridMountedEditor, setLazyPublicAstridMountedEditor] = useState(
    () => lazy(loadPublicAstridMountedEditor),
  );
  const [conversationReady, setConversationReady] = useState(false);
  const [editorRevealed, setEditorRevealed] = useState(false);
  // The loading runner unmounts once the editor has faded in, so nothing keeps animating unseen.
  const [loaderRetired, setLoaderRetired] = useState(false);
  const initialReadiness = useRef(createPublicAstridReadiness(0)).current;
  const readinessRef = useRef<PublicAstridReadiness>(initialReadiness);
  const [readiness, setReadiness] = useState(initialReadiness);
  const [routeStatusMessage, setRouteStatusMessage] = useState('');
  // The page's colours follow the same scene snapshot as the sky renderer, including twilight boundaries.
  const mainRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!visualActive) return undefined;
    return skySession.registerPaletteTarget(mainRef.current, 'home');
  }, [skySession, visualActive]);
  // Easter egg: clicking the mink turns her to face you, then she moves the sky through a whole day by
  // telekinesis (glowing eyes, psychic rings, a slight levitation) before turning back.
  const [minkPose, setMinkPose] = useState<'profile' | 'facing' | 'focus'>('profile');
  const minkTimers = useRef<number[]>([]);
  const minkReplayOwnedRef = useRef(false);
  const replayOperation = useSyncExternalStore(
    visualActive ? skySession.subscribeRaster : () => () => {},
    () => skySession.getSnapshot().replay?.operation ?? null,
    () => skySession.getSnapshot().replay?.operation ?? null,
  );
  useEffect(() => {
    for (const src of ['/astrid-mink-front.png', '/astrid-mink-focus.png', '/astrid-mink-psychic.png', '/astrid-mink-glint.png']) new Image().src = src;
    return () => minkTimers.current.forEach((timer) => window.clearTimeout(timer));
  }, []);
  const endSkyReplay = useCallback(() => {
    minkReplayOwnedRef.current = false;
    skySession.cancelHomeReplay();
    setMinkPose('profile');
  }, [skySession]);
  const playSkyDay = () => {
    if (!visualActive || minkPose !== 'profile') return;
    setMinkPose('facing');
    // With reduced motion she still turns to look, but the sky stays put.
    if (prefersReducedMotion || !sky.enabled) {
      minkTimers.current.push(window.setTimeout(endSkyReplay, 1200));
      return;
    }
    if (!skySession.startHomeReplay(endSkyReplay)) {
      minkTimers.current.push(window.setTimeout(endSkyReplay, 1200));
      return;
    }
    minkReplayOwnedRef.current = true;
    minkTimers.current.push(
      window.setTimeout(() => setMinkPose('focus'), PUBLIC_ASTRID_SKY_REPLAY_TURN_MS),
      window.setTimeout(() => setMinkPose('facing'), PUBLIC_ASTRID_SKY_REPLAY_MS - PUBLIC_ASTRID_SKY_REPLAY_SETTLE_MS),
    );
  };
  const minkSrc = { profile: '/astrid-mink-provisional.webp', facing: '/astrid-mink-front.png', focus: '/astrid-mink-focus.png' }[minkPose];
  const [routeAnnouncementGeneration, setRouteAnnouncementGeneration] = useState(0);
  const stateRef = useRef(state);
  const motionClockRef = useRef<PublicAstridMotionClock>(null);
  const reducedMotionRef = useRef(prefersReducedMotion);
  const landingGridRef = useRef<HTMLElement>(null);
  usePublicAstridLayoutGlide(landingGridRef, prefersReducedMotion, visualActive);
  const routeAnnouncementGenerationRef = useRef(0);
  const pendingRouteAnnouncementRef = useRef<{ generation: number; state: ExperienceState } | null>(null);
  const lastAnnouncedExperienceRef = useRef<ExperienceState | null>(null);
  const initialRouteAnnouncementDoneRef = useRef(false);
  const lastHistoryChangeRef = useRef(0);
  const pendingAudienceFocusRef = useRef<'agent' | 'launcher' | null>(null);
  const [motionTiming, setMotionTiming] = useState<MotionTiming>({
    duration: 720,
    assemblyDelay: 0,
    assemblyDuration: 720,
    surfaceDelay: 0,
    surfaceDuration: 720,
    labelDelay: 504,
    labelDuration: 216,
  });
  const appView = state.audience === 'app';
  const agentView = state.audience === 'agent';
  const playerRef = useInactiveSurface(!appView);
  const transportRef = useInactiveSurface<HTMLDivElement>(!appView);
  const chatRef = useInactiveSurface(!agentView);
  const showTimeline = appView;
  const onConversationReady = useCallback((attempt: number) => {
    if (!editorShellMountedRef.current || attempt !== editorAttemptRef.current) return;
    setConversationReady(true);
  }, []);
  const inspectorRef = useInactiveSurface(!appView);
  const timelineRef = useInactiveSurface(!showTimeline);

  const queueRouteAnnouncement = useCallback((nextState: ExperienceState) => {
    const generation = routeAnnouncementGenerationRef.current + 1;
    routeAnnouncementGenerationRef.current = generation;
    pendingRouteAnnouncementRef.current = { generation, state: nextState };
    setRouteAnnouncementGeneration(generation);
  }, []);

  useEffect(() => {
    if (minkReplayOwnedRef.current && replayOperation === null) {
      minkReplayOwnedRef.current = false;
      minkTimers.current.forEach((timer) => window.clearTimeout(timer));
      minkTimers.current = [];
      setMinkPose('profile');
    }
  }, [replayOperation]);

  useEffect(() => {
    reducedMotionRef.current = prefersReducedMotion;
  }, [prefersReducedMotion]);

  useLayoutEffect(() => {
    if (sameExperience(stateRef.current, state)) return;
    const previous = stateRef.current;
    const startedAt = performance.now();
    const timing = retargetMotionTiming(previous, state, motionClockRef.current, startedAt);
    motionClockRef.current = timing.duration ? { startedAt, duration: timing.duration, from: previous, to: state } : null;
    setMotionTiming(timing);
    stateRef.current = state;
    pendingAudienceFocusRef.current = state.audience === 'agent' ? 'agent' : 'launcher';
    queueRouteAnnouncement(state);
  }, [state, queueRouteAnnouncement]);

  useEffect(() => {
    if (visualActive && !prefersReducedMotion) return;
    minkTimers.current.forEach((timer) => window.clearTimeout(timer));
    minkTimers.current = [];
    endSkyReplay();
    if (!visualActive) {
      pendingAudienceFocusRef.current = null;
      invalidateLocalNavigation();
    }
  }, [visualActive, prefersReducedMotion, endSkyReplay, invalidateLocalNavigation, skySession]);

  useEffect(() => {
    if (!visualActive) return;
    if (!initialRouteAnnouncementDoneRef.current) {
      initialRouteAnnouncementDoneRef.current = true;
      lastAnnouncedExperienceRef.current = state;
      setRouteStatusMessage(routeAnnouncement(state));
      return undefined;
    }

    const pending = pendingRouteAnnouncementRef.current;
    if (!pending || pending.generation !== routeAnnouncementGeneration) return undefined;
    if (!sameExperience(pending.state, state)) return undefined;
    if (lastAnnouncedExperienceRef.current && sameExperience(lastAnnouncedExperienceRef.current, state)) {
      pendingRouteAnnouncementRef.current = null;
      return undefined;
    }

    const generation = pending.generation;
    const preferenceAtSchedule = prefersReducedMotion;
    let active = true;
    let timeout: number | null = null;
    let frame: number | null = null;
    const publish = () => {
      if (!active || !visualActiveRef.current
        || routeAnnouncementGenerationRef.current !== generation
        || reducedMotionRef.current !== preferenceAtSchedule
        || !sameExperience(stateRef.current, pending.state)) return;
      if (lastAnnouncedExperienceRef.current && sameExperience(lastAnnouncedExperienceRef.current, pending.state)) {
        pendingRouteAnnouncementRef.current = null;
        return;
      }
      lastAnnouncedExperienceRef.current = pending.state;
      pendingRouteAnnouncementRef.current = null;
      setRouteStatusMessage(routeAnnouncement(pending.state));
    };

    if (preferenceAtSchedule) frame = window.requestAnimationFrame(publish);
    else timeout = window.setTimeout(publish, motionTiming.duration);
    return () => {
      active = false;
      if (timeout !== null) window.clearTimeout(timeout);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [state, routeAnnouncementGeneration, prefersReducedMotion, motionTiming.duration, visualActive]);

  useEffect(() => {
    try {
      editorReloadPendingRef.current = window.sessionStorage.getItem(EDITOR_RELOAD_PENDING_KEY) === '1';
      window.sessionStorage.removeItem(EDITOR_RELOAD_PENDING_KEY);
    } catch {
      editorReloadPendingRef.current = false;
    }
    editorShellMountedRef.current = true;
    return () => {
      editorShellMountedRef.current = false;
    };
  }, []);

  const applyReadinessEvent = useCallback((event: PublicAstridReadinessEvent, allowRetained = false) => {
    if (!editorShellMountedRef.current || event.attempt !== editorAttemptRef.current) return false;
    if (!allowRetained && !visualActiveRef.current) return false;
    const next = reducePublicAstridReadiness(readinessRef.current, event);
    if (next === readinessRef.current) return false;
    readinessRef.current = next;
    setReadiness(next);
    return true;
  }, []);

  const markEditorSignal = useCallback((type: 'inspector-ready' | 'timeline-ready', attempt: number) => {
    applyReadinessEvent({type, attempt});
  }, [applyReadinessEvent]);

  const onEditorInspectorReady = useCallback((attempt: number) => {
    markEditorSignal('inspector-ready', attempt);
  }, [markEditorSignal]);

  const onEditorTimelineReady = useCallback((attempt: number) => {
    markEditorSignal('timeline-ready', attempt);
  }, [markEditorSignal]);

  useEffect(() => {
    const stage = editorStageRef.current;
    if (!visualActive || !readiness.moduleReady || readiness.phase === 'error' || !stage) return undefined;
    const attempt = readiness.attempt;
    const stageElement: HTMLDivElement = stage;
    let currentVideo: HTMLVideoElement | null = null;
    const markMedia = (fallback: boolean) => {
      if (readinessRef.current.mediaReady) return;
      applyReadinessEvent({type: fallback ? 'media-fallback' : 'media-ready', attempt});
    };
    const inspectMedia = () => {
      if (!visualActiveRef.current || editorAttemptRef.current !== attempt) return;
      const video = stageElement.querySelector<HTMLVideoElement>('.astrid-player-surface video');
      if (video !== currentVideo) {
        currentVideo?.removeEventListener('loadeddata', onMediaReady);
        currentVideo?.removeEventListener('canplay', onMediaReady);
        currentVideo?.removeEventListener('error', onMediaError);
        currentVideo = video;
        currentVideo?.addEventListener('loadeddata', onMediaReady);
        currentVideo?.addEventListener('canplay', onMediaReady);
        currentVideo?.addEventListener('error', onMediaError);
      }
      if (video) {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) markMedia(false);
      } else if (stageElement.querySelector('[data-astrid-preview-frame-ready="true"]')) {
        // The Remotion preview is canvas-backed in the browser; wait for its
        // first frame event rather than revealing the canvas while it still
        // contains the composition's black clear.
        markMedia(false);
      }
    };
    const onMediaReady = () => markMedia(false);
    const onMediaError = () => markMedia(true);
    const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(inspectMedia);
    observer?.observe(stageElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-astrid-preview-frame-ready'],
    });
    inspectMedia();
    return () => {
      observer?.disconnect();
      currentVideo?.removeEventListener('loadeddata', onMediaReady);
      currentVideo?.removeEventListener('canplay', onMediaReady);
      currentVideo?.removeEventListener('error', onMediaError);
    };
  }, [applyReadinessEvent, readiness.attempt, readiness.moduleReady, readiness.phase, state.audience, visualActive]);

  useEffect(() => {
    const stage = editorStageRef.current;
    if (!visualActive || !readiness.moduleReady || readiness.phase === 'error' || !stage) return undefined;
    const attempt = readiness.attempt;
    const revealTimer = window.setTimeout(() => {
      if (!visualActiveRef.current || editorAttemptRef.current !== attempt) return;
      const current = readinessRef.current;
      if (!current.inspectorReady) applyReadinessEvent({type: 'inspector-fallback', attempt});
      if (!current.timelineReady) applyReadinessEvent({type: 'timeline-fallback', attempt});
    }, EDITOR_REVEAL_TIMEOUT_MS);
    return () => window.clearTimeout(revealTimer);
  }, [applyReadinessEvent, readiness.attempt, readiness.moduleReady, readiness.phase, visualActive]);

  useEffect(() => {
    if (!visualActive || readiness.phase !== 'usable') return undefined;
    // The separately loaded conversation determines Agent's mobile card height. Reveal it together
    // with the editor, rather than showing a short loading card that expands after first paint.
    if (state.audience === 'agent' && !conversationReady) return undefined;
    const attempt = readiness.attempt;
    if (applyReadinessEvent({type: 'present', attempt})) setEditorRevealed(true);
    return undefined;
  }, [applyReadinessEvent, readiness.attempt, readiness.phase, visualActive, state.audience, conversationReady]);

  const retireEditorLoader = useCallback((attempt: number) => {
    if (!visualActiveRef.current || editorAttemptRef.current !== attempt || readinessRef.current.phase !== 'presenting') return;
    setLoaderRetired(true);
    applyReadinessEvent({type: 'settled', attempt});
  }, [applyReadinessEvent]);

  useEffect(() => {
    if (!visualActive || readiness.phase !== 'presenting' || loaderRetired) return undefined;
    const attempt = readiness.attempt;
    const timeout = window.setTimeout(() => retireEditorLoader(attempt), EDITOR_LOADER_RETIRE_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [loaderRetired, readiness.attempt, readiness.phase, retireEditorLoader, visualActive]);

  useEffect(() => {
    if (!visualActive || readiness.phase === 'error' || !readiness.moduleReady) return undefined;
    const stage = editorStageRef.current;
    if (!stage) return undefined;
    const checkSurfaceFallbacks = () => {
      const attempt = readinessRef.current.attempt;
      if (editorAttemptRef.current !== attempt || !visualActiveRef.current) return;
      if (!readinessRef.current.inspectorReady
        && stage.querySelector('[data-astrid-inspector-ready="true"], [data-astrid-inspector-ready="error"]')) {
        applyReadinessEvent({type: 'inspector-ready', attempt});
      }
      if (!readinessRef.current.timelineReady && stage.querySelector('.astrid-timeline-surface')) {
        applyReadinessEvent({type: 'timeline-ready', attempt});
      }
    };
    const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(checkSurfaceFallbacks);
    observer?.observe(stage, {childList: true, subtree: true});
    checkSurfaceFallbacks();
    return () => observer?.disconnect();
  }, [applyReadinessEvent, readiness.moduleReady, readiness.phase, visualActive]);

  const onEditorChunkFailure = useCallback((attempt: number, error: Error) => {
    if (!editorShellMountedRef.current || attempt !== editorAttemptRef.current) return;
    const followedReload = editorReloadPendingRef.current;
    editorReloadPendingRef.current = false;
    setEditorReloadFollowup(followedReload);
    editorLoadStatusRef.current = 'failed';
    setEditorLoadStatus('failed');
    setEditorRevealed(false);
    setLoaderRetired(false);
    applyReadinessEvent({type: 'error', attempt, message: error.message}, true);
  }, [applyReadinessEvent]);

  const onEditorChunkReady = useCallback((attempt: number) => {
    if (!editorShellMountedRef.current || attempt !== editorAttemptRef.current || !visualActiveRef.current) return;
    const restoreFocus = editorFailurePanelRef.current?.contains(document.activeElement) ?? false;
    editorReloadPendingRef.current = false;
    setEditorReloadFollowup(false);
    editorLoadStatusRef.current = 'ready';
    setEditorLoadStatus('ready');
    applyReadinessEvent({type: 'module-ready', attempt});
    if (restoreFocus) pendingEditorFocusRef.current = attempt;
  }, [applyReadinessEvent]);
  const pendingEditorFocusRef = useRef<number | null>(null);
  useEffect(() => {
    const attempt = pendingEditorFocusRef.current;
    pendingEditorFocusRef.current = null;
    if (!visualActive || attempt === null) return;
    const frame = window.requestAnimationFrame(() => {
      if (visualActiveRef.current && editorShellMountedRef.current && editorAttemptRef.current === attempt) {
        editorStageRef.current?.focus({preventScroll: true});
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editorLoadStatus, visualActive]);

  const retryEditorChunk = useCallback(() => {
    if (editorLoadStatusRef.current === 'loading') return;
    const nextAttempt = editorAttemptRef.current + 1;
    editorAttemptRef.current = nextAttempt;
    const nextReadiness = retryPublicAstridReadiness(readinessRef.current);
    readinessRef.current = nextReadiness;
    setReadiness(nextReadiness);
    editorLoadStatusRef.current = 'loading';
    setEditorRetryCount((count) => count + 1);
    setEditorLoadStatus('loading');
    setEditorRevealed(false);
    setLoaderRetired(false);
    setConversationReady(false);
    setEditorAttempt(nextAttempt);
    setLazyPublicAstridMountedEditor(() => lazy(loadPublicAstridMountedEditor));
  }, []);

  const reloadEditorPage = useCallback(() => {
    try {
      window.sessionStorage.setItem(EDITOR_RELOAD_PENDING_KEY, '1');
    } catch {
      // The page reload still works when session storage is unavailable.
    }
    window.location.reload();
  }, []);

  // Once the demo has settled, fetch the Vision page's text in the background so it opens without a
  // loading skeleton.
  useEffect(() => {
    if (!visualActive || readiness.phase !== 'settled') return undefined;
    const timer = window.setTimeout(preloadPublicVisionContent, 1_200);
    return () => window.clearTimeout(timer);
  }, [readiness.phase, visualActive]);

  // Before callouts mount, size the preview for readiness. Once revealed, their stage pass owns it.
  usePublicAstridPlayerHeight(editorStageRef, visualActive && !editorRevealed);

  useEffect(() => {
    if (!visualActive) return;
    const focusTarget = pendingAudienceFocusRef.current;
    if (!focusTarget) return;
    if (focusTarget === 'agent' && !conversationReady) return;
    pendingAudienceFocusRef.current = null;
    const frame = window.requestAnimationFrame(() => {
      if (!visualActiveRef.current) return;
      if (focusTarget === 'agent') {
        document.querySelector<HTMLElement>('.astrid-scripted-conversation, .astrid-conversation-load-error')?.focus({ preventScroll: true });
      } else {
        document.querySelector<HTMLButtonElement>('[data-astrid-agent-launcher]')?.focus({ preventScroll: true });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [conversationReady, state.audience, visualActive]);

  useEffect(() => {
    if (!standalone) return;
    const syncFromHistory = () => {
      // Vision & Issues opens over the home page; its history entries carry no App/Agent state.
      if (window.location.pathname === VISION_PATH) return;
      const next = readPublicAstridExperience();
      lastHistoryChangeRef.current = 0;
      runLocalNavigation(() => setLocalState(next));
    };
    window.addEventListener('popstate', syncFromHistory);
    return () => window.removeEventListener('popstate', syncFromHistory);
  }, [standalone, runLocalNavigation]);

  const updateState = (next: Partial<ExperienceState>) => {
    if (!visualActiveRef.current || window.location.pathname === VISION_PATH) return;
    const nextState = { ...stateRef.current, ...next };
    if (navigation) {
      navigation.onExperienceChange(nextState);
      return;
    }
    const current = readPublicAstridExperience();
    const now = Date.now();
    const coalesce = now - lastHistoryChangeRef.current < 350;
    if (!sameExperience(current, nextState)) {
      writePublicAstridExperience(nextState, coalesce);
      lastHistoryChangeRef.current = now;
    }
    runLocalNavigation(() => setLocalState(nextState));
  };

  // In Agent, the editor recedes behind the conversation; clicking that background brings App forward.
  // Keyboard users switch with the App/Agent toggle beside the hero copy.
  // Anywhere on the stage switches back, the receded panels included, except the conversation and the
  // labels. Labels ignore the pointer (clicks fall through to the stage), so test where they are drawn.
  const returnToAppFromStage = (x: number, y: number, target: Element, stage: HTMLElement) => {
    if (stateRef.current.audience !== 'agent') return;
    if (target.closest('.astrid-chat-surface, .astrid-editor-load-failure, button, a')) return;
    if ([...stage.querySelectorAll('.astrid-callout')].some((label) => drawnAt(label, x, y))) return;
    updateState({ audience: 'app' });
  };
  const onStageClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element)) return;
    returnToAppFromStage(event.clientX, event.clientY, event.target, event.currentTarget);
  };
  const returnToAppFromStageRef = useRef(returnToAppFromStage);
  returnToAppFromStageRef.current = returnToAppFromStage;
  // While the side-switch colour fade runs, the browser hit-tests clicks to the document root instead of
  // the stage, so a click on the stage during the switch would otherwise be lost.
  useEffect(() => {
    if (!visualActive) return;
    const onDocumentClick = (event: MouseEvent) => {
      if (event.target !== document.documentElement) return;
      const stage = editorStageRef.current;
      if (!stage || !drawnAt(stage, event.clientX, event.clientY)) return;
      const chat = stage.querySelector('.astrid-chat-surface');
      if (chat && drawnAt(chat, event.clientX, event.clientY)) return;
      returnToAppFromStageRef.current(event.clientX, event.clientY, stage, stage);
    };
    document.addEventListener('click', onDocumentClick);
    return () => document.removeEventListener('click', onDocumentClick);
  }, [visualActive]);

  const openVerifiedResult = () => {
    updateState({ audience: 'app' });
  };

  return (
    <main
      ref={mainRef}
      className="astrid-public-site"
      tabIndex={-1}
      data-astrid-lifecycle={lifecycle}
      data-astrid-visual-active={visualActive}
      data-astrid-public-entry="astrid-public-v1"
      data-astrid-direct-entry={directEntryAudience === state.audience ? directEntryAudience : undefined}
      data-audience={state.audience}
      data-theme={theme}
      data-dusk
      data-sky-frame={sky.enabled && sky.openFrame ? 'open' : 'solid'}
      data-pixel-mono={sky.details.pixelMono || undefined}
      data-pixel-beta={sky.details.pixelBeta || undefined}
      data-motion-duration={motionTiming.duration}
      style={{
        '--astrid-motion-duration': `${motionTiming.duration}ms`,
        '--astrid-assembly-delay': `${motionTiming.assemblyDelay}ms`,
        '--astrid-assembly-duration': `${motionTiming.assemblyDuration}ms`,
        '--astrid-surface-delay': `${motionTiming.surfaceDelay}ms`,
        '--astrid-surface-duration': `${motionTiming.surfaceDuration}ms`,
        '--astrid-label-delay': `${motionTiming.labelDelay}ms`,
        '--astrid-label-duration': `${motionTiming.labelDuration}ms`,
        '--astrid-paper': palette.paper,
        '--astrid-dusk': palette.dusk,
        '--astrid-dusk-ink': palette.ink,
        '--astrid-dusk-firm': palette.firm,
        '--astrid-dusk-ink-page': palette.inkPage,
        ...palette.tokens,
      } as CSSProperties}
    >
      <div
        className="astrid-visually-hidden"
        data-astrid-route-status
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {routeStatusMessage}
      </div>
      {visualActive && <PublicAstridSky
        session={skySession}
        active={visualActive}
        geometryRoot={mainRef}
        geometryOwner="home"
        reducedMotion={prefersReducedMotion}
        quietBehind=".astrid-hero-copy h1, .astrid-hero-subtitle"
      />}
      <section className="astrid-landing-grid" ref={landingGridRef} aria-labelledby="astrid-hero-title">
        <div className="astrid-hero-copy">
          <div className="astrid-brand">
            <button
              type="button"
              className="astrid-brand-mink-button"
              aria-label="Watch a day go by"
              data-pose={minkPose}
              onClick={playSkyDay}
            >
              {minkPose === 'focus' && <span className="astrid-brand-mink-psychic" aria-hidden="true" />}
              <span className="astrid-brand-mink-frame">
                <img className="astrid-brand-mink" src={minkSrc} alt="" />
                {minkPose === 'profile' && <img className="astrid-brand-mink astrid-brand-mink-glint" src="/astrid-mink-glint.png" alt="" />}
              </span>
            </button>
            <span className="astrid-brand-name">Astrid</span>
            <span className="astrid-visually-hidden">(beta)</span>
            {/* The beta stamp doubles as the way into the Vision page: what we're building
                toward, and what's still open, is the natural companion to "this is a beta". */}
            <a className="astrid-beta" href={VISION_PATH} aria-label="Vision" onClick={(event) => followInPage(event, onOpenVision)}>
              <span className="astrid-beta-tag" aria-hidden="true">BETA</span>
              <span className="astrid-beta-link">
                <span className="astrid-beta-link-text">Vision</span>
                <ArrowUpRight size={10} strokeWidth={2.2} aria-hidden="true" />
              </span>
            </a>
          </div>
          <nav className="astrid-audience-switch" aria-label="Explore Astrid">
            <button type="button" data-audience="app" aria-pressed={state.audience === 'app'} onClick={() => updateState({ audience: 'app' })}>
              App
            </button>
            <button type="button" data-audience="agent" aria-pressed={state.audience === 'agent'} onClick={() => updateState({ audience: 'agent' })}>
              Agent
            </button>
          </nav>
          <h1 id="astrid-hero-title">Push local AI to its <span className="astrid-hero-emphasis">creative limits.</span></h1>
          <div className="astrid-hero-detail">
            <HeroSubtitle audience={state.audience} phone={environment.phone} onSwitch={(audience) => updateState({ audience })} />
            <div className="astrid-hero-actions">
              <PublicAstridHeroCta active={visualActive} />
            </div>
          </div>
          <div className="astrid-hero-note">
            <PublicAstridSocialLinks />
          </div>
        </div>

        <section className="astrid-showcase" aria-label={state.audience === 'app' ? 'App' : 'Agent'}>
          <div
            className="astrid-editor-stage"
            ref={editorStageRef}
            data-astrid-surface-owner={ACTIVE_PUBLIC_ASTRID_EXAMPLE_METADATA.id}
            data-editor-load-state={editorLoadStatus}
            data-astrid-readiness={readiness.phase}
            data-astrid-readiness-attempt={readiness.attempt}
            data-astrid-media-ready={readiness.mediaReady}
            data-astrid-inspector-ready={readiness.inspectorReady}
            data-astrid-timeline-ready={readiness.timelineReady}
            data-revealed={editorRevealed}
            data-audience={state.audience}
            role="group"
            aria-label={`${ACTIVE_PUBLIC_ASTRID_EXAMPLE_METADATA.title} editor preview`}
            tabIndex={-1}
            onClick={onStageClick}
          >
            <div
              className="astrid-editor-loading"
              data-audience={state.audience}
              role="status"
              aria-hidden={editorRevealed}
              data-hidden={editorRevealed || editorLoadStatus === 'failed' || editorLoadStatus === 'loading'}
              onTransitionEnd={(event) => {
                if (event.target === event.currentTarget && event.propertyName === 'opacity') {
                  retireEditorLoader(editorAttempt);
                }
              }}
            >
              {!loaderRetired && visualActive && (
                <MinkCircle reducedMotion={prefersReducedMotion} />
              )}
              <span className="astrid-visually-hidden">Loading the shared editor, preview and timeline…</span>
            </div>
            <EditorChunkBoundary
              attempt={editorAttempt}
              onChunkFailure={onEditorChunkFailure}
              fallback={null}
            >
              <Suspense fallback={null}>
                <LazyPublicAstridMountedEditor
                  audience={state.audience}
                  attempt={editorAttempt}
                  active={visualActive}
                  transportOutlet={transportOutlet}
                  onTransportOutletChange={setTransportOutlet}
                  playerRef={playerRef}
                  inspectorRef={inspectorRef}
                  timelineRef={timelineRef}
                  chatRef={chatRef}
                  transportRef={transportRef}
                  onConversationReady={onConversationReady}
                  onInspectorReady={onEditorInspectorReady}
                  onTimelineReady={onEditorTimelineReady}
                  onOpenVerifiedResult={openVerifiedResult}
                  preloadConversation={editorRevealed}
                  conversationActive={visualActive && agentView && editorRevealed}
                />
                <EditorChunkReady attempt={editorAttempt} active={visualActive} onReady={onEditorChunkReady} />
              </Suspense>
            </EditorChunkBoundary>

            {(editorLoadStatus === 'loading' || editorLoadStatus === 'failed') && (
              <div
                className="astrid-editor-load-failure"
                ref={editorFailurePanelRef}
                data-load-state={editorLoadStatus}
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                <img className="astrid-editor-load-failure-poster" src={ACTIVE_PUBLIC_ASTRID_EXAMPLE_METADATA.posterUrl} alt="" />
                <div className="astrid-editor-load-failure-card">
                  <strong>
                    {editorLoadStatus === 'loading' ? 'Loading editor…' : 'Editor preview couldn’t load'}
                  </strong>
                  <span>
                    {editorLoadStatus === 'loading'
                      ? 'The page is still available while the editor reloads.'
                      : editorReloadFollowup
                        ? 'The editor is still unavailable. Please try again later.'
                        : 'The page is still available. Try loading the editor again.'}
                  </span>
                  <button
                    className="astrid-editor-load-retry"
                    type="button"
                    aria-disabled={editorLoadStatus === 'loading'}
                    onClick={retryEditorChunk}
                  >
                    Retry editor
                  </button>
                  {editorLoadStatus === 'failed' && editorRetryCount > 0 && (
                    <button
                      className="astrid-editor-load-reload"
                      type="button"
                      onClick={reloadEditorPage}
                    >
                      Reload page
                    </button>
                  )}
                </div>
              </div>
            )}

            {appView && editorRevealed && (
              <button
                className="astrid-agent-launcher"
                aria-hidden={!appView}
                disabled={!appView}
                type="button"
                data-astrid-agent-launcher
                aria-label={hasViewedAgent ? 'Open Agent' : 'Open Agent — 1 scripted conversation'}
                title="Open Agent conversation"
                onClick={() => updateState({ audience: 'agent' })}
              >
                <img src="/astrid-mink-provisional.webp" alt="" />
                {!hasViewedAgent && <span aria-hidden="true">1</span>}
              </button>
            )}

            {editorRevealed && (
              <PublicAstridCallouts
                stageRef={editorStageRef}
                audience={state.audience}
                reducedMotion={prefersReducedMotion}
                active={visualActive}
              />
            )}
          </div>
        </section>
      </section>
    </main>
  );
}
