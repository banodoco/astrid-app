import { useOptionalVideoEditorRuntime } from '@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx';
import type { ComponentProps, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { PreviewAudioFailureProvider } from '@/tools/video-editor/compositions/PreviewMediaFailureContext.tsx';
import { PreviewAudioFailureNotice } from './PreviewAudioFailureNotice.tsx';
import { Button } from '@/shared/components/ui/button.tsx';
import { cn } from '@/shared/components/ui/contracts/cn.ts';
import { projectOutputTimelineConfig, trackRole } from '@/tools/video-editor/data/timelineOutputProjection.ts';
import { TimelineRenderer } from '@/tools/video-editor/compositions/TimelineRenderer.tsx';
import { useEffectDiagnostic, useRenderDiagnostic } from '@/tools/video-editor/hooks/usePerfDiagnostics.ts';
import { getClipDurationInFrames, parseResolution, secondsToFrames } from '@/tools/video-editor/lib/config-utils.ts';
import { VIDEO_EDITOR_THEME_VARS } from '@/tools/video-editor/lib/themeTokens.ts';
import type { ResolvedTimelineConfig } from '@/tools/video-editor/types/index.ts';
import { getAdmittedElementReadiness, refreshAdmittedElements, subscribeAdmittedElementReadiness } from '@/tools/video-editor/runtime/admitted-elements.ts';
import { PreviewLoadingPlaceholder } from './PreviewLoadingPlaceholder.tsx';
import { areShotsSettling } from '@/tools/video-editor/lib/shots-settling.ts';
import { previewRevisionLabel, previewUnavailableLabel, type PreviewRevision } from './previewRevision.ts';
import { isEditableTarget } from '@/tools/video-editor/lib/coordinate-utils.ts';
import { isActivatableTarget } from '@/tools/video-editor/hooks/useKeyboardShortcuts.ts';
import { PreviewTransport } from './PreviewTransport.tsx';
import { PREVIEW_FULLSCREEN_ATTRIBUTE, usePreviewFullscreen } from './usePreviewFullscreen.ts';
import {
  getPreviewPlaybackPreferences,
  setPreviewPlaybackPreferences,
  togglePreviewMuted,
  usePreviewPlaybackPreferences,
} from './previewPlaybackPreferences.ts';

export interface PreviewHandle {
  seek: (time: number) => void;
  play: () => void;
  pause: () => void;
  togglePlayPause: () => void;
  /** Fills the screen with the picture and its own controls, or returns it to the editor. */
  toggleFullscreen: () => void;
  readonly isPlaying: boolean;
}

/** Fullscreen controls fade after this long without a pointer move, tap or key while playing. */
const FULLSCREEN_CHROME_IDLE_MS = 2500;
/** Fullscreen arrow keys: seconds per seek, level per volume step (as video players do). */
const FULLSCREEN_SEEK_SECONDS = 5;
const FULLSCREEN_VOLUME_STEP = 0.05;
// The editor preview flattens every shot's internal audio clip into the
// parent composition. Remotion's shared-tag scheduler is optimized for a
// small number of simultaneously mounted tags and can reuse a tag with the
// wrong clip while a long timeline is being sought. Let each active Sequence
// own its media element instead; this keeps source identity and timing local
// to the clip and avoids a lifetime-fixed shared-pool prop during config swaps.
const PREVIEW_SHARED_AUDIO_TAGS = 0;
const UNKNOWN_PREVIEW_REVISION: PreviewRevision = Object.freeze({ kind: 'unknown' });

/**
 * Keeps the loading surface over a mounted composition until its first frame has pictures:
 * the shots have arrived and the first image or video in view has loaded, or the frame has
 * none. Then it fades once and stays gone for this mount, so seeking and playback never
 * bring it back. The composition's own black ground is render output and stays untouched.
 */
function FirstFrameCover({ settling, children }: { settling: boolean; children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    const root = rootRef.current;
    if (revealed || settling || !root) return undefined;
    const reveal = () => setRevealed(true);
    // Pictures only: audio elements load too, and say nothing about the frame.
    const revealOnPicture = (event: Event) => {
      if (event.target instanceof HTMLImageElement || event.target instanceof HTMLVideoElement) reveal();
    };
    // The clips' media mount in the commit that settles the shots; give it a frame before
    // deciding that the first frame has no media (or that it has already loaded).
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const media = [...root.querySelectorAll<HTMLImageElement | HTMLVideoElement>('img, video')];
        const painted = (element: HTMLImageElement | HTMLVideoElement) => (
          element instanceof HTMLImageElement ? element.complete : element.readyState >= 2
        );
        if (media.length === 0 || media.some(painted)) reveal();
      });
    });
    // Media load events do not bubble; listen in the capture phase. A failed picture
    // also lifts the cover, so the clip's own failure state shows.
    root.addEventListener('load', revealOnPicture, true);
    root.addEventListener('loadeddata', revealOnPicture, true);
    root.addEventListener('error', revealOnPicture, true);
    return () => {
      cancelAnimationFrame(frame);
      root.removeEventListener('load', revealOnPicture, true);
      root.removeEventListener('loadeddata', revealOnPicture, true);
      root.removeEventListener('error', revealOnPicture, true);
    };
  }, [revealed, settling]);
  return (
    <>
      <div ref={rootRef} style={{ position: 'absolute', inset: 0 }}>{children}</div>
      <PreviewLoadingPlaceholder cover revealed={revealed} />
    </>
  );
}

// Both branches use Remotion's composition viewport, so loading occupies the
// exact video bounds at every resolution and stage size without a second fit.
function PreviewComposition({ preparing, settling, previewRevision: _previewRevision, ...props }: ComponentProps<typeof TimelineRenderer> & { preparing: boolean; settling: boolean; previewRevision: PreviewRevision }) {
  if (preparing) return <PreviewLoadingPlaceholder />;
  return (
    <FirstFrameCover settling={settling}>
      <TimelineRenderer {...props} />
    </FirstFrameCover>
  );
}

interface PendingSeek {
  frame: number;
  configGeneration: number;
  time?: number;
}

interface RemotionPreviewProps {
  config: ResolvedTimelineConfig;
  onTimeUpdate: (time: number) => void;
  playerContainerRef: RefObject<HTMLDivElement>;
  compact?: boolean;
  /** Phone/tablet chrome: transport controls grow to touch-sized hit targets. */
  touchChrome?: boolean;
  initialTime?: number;
  /** @deprecated Compatibility only; ignored. Use initialTime or PreviewHandle.seek. */
  currentTime?: number;
  /** Optional host-owned outlet for transport controls (e.g. public shells). */
  transportOutlet?: HTMLElement | null;
  /** Provenance of the config that is allowed to reach the Player. */
  previewRevision?: PreviewRevision;
  /** Volume, speed and fullscreen beside the transport (default). A staged shell that
   *  sizes the transport itself leaves them out. */
  playerControls?: boolean;
}

interface PreviewDelivery {
  config: ResolvedTimelineConfig;
  revision: PreviewRevision;
  generation: number;
}

const RemotionPreviewComponent = forwardRef<PreviewHandle, RemotionPreviewProps>(function RemotionPreview(
  { config, previewRevision = UNKNOWN_PREVIEW_REVISION, onTimeUpdate, playerContainerRef, transportOutlet, compact = false, touchChrome = false, initialTime = 0, playerControls = true },
  ref,
) {
  const runtime = useOptionalVideoEditorRuntime();
  const playerRef = useRef<PlayerRef>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const playbackIntentRef = useRef<'playing' | 'paused'>('paused');
  const activeSeekFrameRef = useRef<number | null>(null);
  const pendingSeekRef = useRef<PendingSeek | null>(null);
  const seekFlushRafRef = useRef<number | null>(null);
  const appliedConfigGenerationRef = useRef(0);
  const configIdentityRef = useRef(config);
  const configGenerationRef = useRef(0);
  if (configIdentityRef.current !== config) {
    configIdentityRef.current = config;
    configGenerationRef.current += 1;
  }
  useRenderDiagnostic('RemotionPreview');
  const markEventsEffect = useEffectDiagnostic('remotionPreview:events');
  // Throttle config updates to the Player to avoid stutter during drag operations.
  // The timeline canvas shows immediate visual feedback; the Player catches up after 150ms idle.
  const [delivery, setDelivery] = useState<PreviewDelivery>({config, revision: previewRevision, generation: 0});
  const deferredConfig = delivery.config;
  const previewRevisionRef = useRef(previewRevision);
  previewRevisionRef.current = previewRevision;
  // Stable identity: reads only the state setter and refs, so effects can depend on it.
  const setDeferredDelivery = useCallback(
    (nextDelivery: PreviewDelivery) => {
      if (nextDelivery.generation !== configGenerationRef.current) return;
      setDelivery(nextDelivery);
    },
    [],
  );
  const deferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Live-edit mailbox: while playing, timeline edits must reach the Player on
  // the next animation frame (live media updates, no pause+restart), but no
  // more than once per frame so rapid commits can't cause renderer jank.
  const latestDeliveryRef = useRef<PreviewDelivery | null>(null);
  const rafRef = useRef<number | null>(null);
  const flushDeferredDelivery = useCallback((nextDelivery: PreviewDelivery, delayMs: number) => {
    // Guard is load-bearing: it narrows `Timeout | null` away (this lib mix
    // rejects null) and resets the ref so a stale timer can't double-fire.
    if (deferTimerRef.current) {
      clearTimeout(deferTimerRef.current);
      deferTimerRef.current = null;
    }
    if (delayMs <= 0) {
      setDeferredDelivery(nextDelivery);
      return;
    }
    deferTimerRef.current = setTimeout(() => {
      deferTimerRef.current = null;
      setDeferredDelivery(nextDelivery);
    }, delayMs);
  }, [setDeferredDelivery]);

  useEffect(() => {
    if (isPlaying) {
      latestDeliveryRef.current = {
        config,
        revision: previewRevisionRef.current,
        generation: configGenerationRef.current,
      };
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          const nextDelivery = latestDeliveryRef.current;
          latestDeliveryRef.current = null;
          if (nextDelivery) {
            setDeferredDelivery(nextDelivery);
          }
        });
      }
    } else {
      // Paused: flush any in-flight live update immediately, then debounce idle edits.
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      // The mailbox only selects flush timing; current props own the newest config.
      const nextDelivery = {
        config,
        revision: previewRevisionRef.current,
        generation: configGenerationRef.current,
      } satisfies PreviewDelivery;
      const delayMs = latestDeliveryRef.current ? 0 : 150;
      latestDeliveryRef.current = null;
      flushDeferredDelivery(nextDelivery, delayMs);
    }
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (deferTimerRef.current) {
        clearTimeout(deferTimerRef.current);
        deferTimerRef.current = null;
      }
    };
  }, [config, isPlaying, previewRevision, flushDeferredDelivery, setDeferredDelivery]);

  const outputProjection = useMemo(() => projectOutputTimelineConfig(deferredConfig), [deferredConfig]);
  // Preserve the ordinary preview identity/mailbox when nothing is excluded.
  const outputConfig = outputProjection.excludedClipIds.length ? outputProjection.config : deferredConfig;
  const admissionReadiness = useSyncExternalStore(subscribeAdmittedElementReadiness, getAdmittedElementReadiness, getAdmittedElementReadiness);
  const projectId = runtime?.project?.projectId;
  const preparing = Boolean(projectId && runtime?.astridElementHost?.isPreviewPreparing?.(projectId, outputConfig.clips));
  const hasMissingPackRef = outputConfig.clips.some(clip => {
    const ref = clip.elementRef;
    return ref?.packId && !runtime?.astridElementHost?.resolveComponent(ref.id, ref.kind, ref.packId, ref.revision);
  });
  const admissionError = hasMissingPackRef && projectId === admissionReadiness.projectId && admissionReadiness.phase === 'error'
    && runtime?.astridElementHost?.isPreviewPreparing ? admissionReadiness.error : null;
  const hasSourceTracks = deferredConfig.tracks.some((track) => trackRole(track) === 'source');
  const hasPlayableOutput = outputProjection.hasOutputContent;
  const shotsSettling = areShotsSettling(runtime?.shots);
  const inputProps = useMemo(() => ({
    config: outputConfig,
    preparing,
    settling: shotsSettling,
    previewRevision: delivery.revision,
    ...(runtime?.astridElementHost ? { astridElementHost: runtime.astridElementHost } : {}),
  }), [delivery.revision, outputConfig, preparing, shotsSettling, runtime?.astridElementHost]);
  const displayedRevisionLabel = previewRevisionLabel(delivery.revision);
  const unavailableTarget = delivery.revision.unavailableTarget;
  const metadata = useMemo(() => {
    const fps = outputConfig.output.fps;
    const { width, height } = parseResolution(outputConfig.output.resolution);

    return {
      fps,
      durationInFrames: Math.max(
        1,
        ...outputConfig.clips.map((clip) => secondsToFrames(clip.at, fps) + getClipDurationInFrames(clip, fps)),
      ),
      compositionWidth: Math.max(1, width),
      compositionHeight: Math.max(1, height),
    };
  }, [outputConfig.clips, outputConfig.output.fps, outputConfig.output.resolution]);

  const metadataRef = useRef(metadata);
  metadataRef.current = metadata;

  useEffect(() => {
    markEventsEffect();
    const player = playerRef.current;
    if (!player) {
      return;
    }

    const onFrameUpdate = (event: { detail: { frame: number } }) => {
      onTimeUpdate(event.detail.frame / metadata.fps);
    };
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);

    player.addEventListener('frameupdate', onFrameUpdate);
    player.addEventListener('play', onPlay);
    player.addEventListener('pause', onPause);

    return () => {
      player.removeEventListener('frameupdate', onFrameUpdate);
      player.removeEventListener('play', onPlay);
      player.removeEventListener('pause', onPause);
    };
  }, [markEventsEffect, metadata.fps, onTimeUpdate]);

  const requestSeek = useCallback((targetFrame: number) => {
    // Player.seekTo is the only authoritative editor seek path. The one-frame
    // command window keeps one active command plus one replaceable latest
    // target; it does not attempt to predict browser decode completion.
    const configGeneration = configGenerationRef.current;
    // A prop update is debounced before it reaches Remotion. Keep imperative
    // seeks queued until the Player is rendering that same config generation;
    // otherwise a seek expressed in the new fps/extent is sent to stale media.
    if (configGeneration !== appliedConfigGenerationRef.current) {
      pendingSeekRef.current = { frame: targetFrame, configGeneration };
      return;
    }
    if (activeSeekFrameRef.current !== null) {
      if (activeSeekFrameRef.current === targetFrame) {
        pendingSeekRef.current = null;
      } else {
        pendingSeekRef.current = { frame: targetFrame, configGeneration };
      }
      return;
    }

    const dispatchSeek = ({ frame: requestedFrame, configGeneration: requestedGeneration }: PendingSeek) => {
      if (requestedGeneration !== configGenerationRef.current) {
        return;
      }
      if (requestedGeneration !== appliedConfigGenerationRef.current) {
        pendingSeekRef.current = { frame: requestedFrame, configGeneration: requestedGeneration };
        return;
      }
      const player = playerRef.current;
      if (!player) {
        return;
      }

      const currentMetadata = metadataRef.current;
      const frame = Math.min(Math.max(0, requestedFrame), Math.max(0, currentMetadata.durationInFrames - 1));
      activeSeekFrameRef.current = frame;
      const lastFrame = currentMetadata.durationInFrames - 1;
      const wasPlaying = player.isPlaying() && playbackIntentRef.current !== 'paused';
      if (wasPlaying) {
        player.pause();
      }
      player.seekTo(frame);
      if (wasPlaying && frame < lastFrame && playbackIntentRef.current !== 'paused') {
        player.play();
      }

      if (seekFlushRafRef.current === null) {
        seekFlushRafRef.current = requestAnimationFrame(() => {
          seekFlushRafRef.current = null;
          activeSeekFrameRef.current = null;
          const pendingSeek = pendingSeekRef.current;
          pendingSeekRef.current = null;
          if (pendingSeek !== null) {
            dispatchSeek(pendingSeek);
          }
        });
      }
    };

    dispatchSeek({ frame: targetFrame, configGeneration });
  }, []);

  useEffect(() => {
    appliedConfigGenerationRef.current = delivery.generation;
    const pendingSeek = pendingSeekRef.current;
    if (pendingSeek?.configGeneration === appliedConfigGenerationRef.current) {
      pendingSeekRef.current = null;
      const frame = pendingSeek.time === undefined
        ? pendingSeek.frame
        : Math.max(0, Math.round(pendingSeek.time * metadataRef.current.fps));
      requestSeek(frame);
    }
  }, [delivery.generation, deferredConfig, requestSeek]);

  // Live edits can shrink the timeline mid-playback; park the playhead on the
  // last frame instead of running past (or looping past) the new end. This
  // correction uses the same authoritative seek dispatcher as editor intent.
  useEffect(() => {
    const player = playerRef.current;
    if (player && player.getCurrentFrame() >= metadata.durationInFrames) {
      requestSeek(Math.max(0, metadata.durationInFrames - 1));
    }
  }, [isPlaying, metadata.durationInFrames, requestSeek]);

  const seek = useCallback((time: number) => {
    const currentMetadata = metadataRef.current;
    const nextFrame = Math.max(0, Math.round(time * currentMetadata.fps));
    if (configGenerationRef.current !== appliedConfigGenerationRef.current) {
      pendingSeekRef.current = {
        frame: nextFrame,
        time,
        configGeneration: configGenerationRef.current,
      };
      return;
    }
    requestSeek(Math.min(nextFrame, Math.max(0, currentMetadata.durationInFrames - 1)));
  }, [requestSeek]);

  const play = useCallback(() => {
    playbackIntentRef.current = 'playing';
    playerRef.current?.play();
  }, []);

  const pause = useCallback(() => {
    playbackIntentRef.current = 'paused';
    playerRef.current?.pause();
  }, []);

  const togglePlayPause = useCallback(() => {
    const player = playerRef.current;
    const currentlyPlaying = player?.isPlaying() ?? isPlaying;
    playbackIntentRef.current = currentlyPlaying ? 'paused' : 'playing';
    player?.toggle();
  }, [isPlaying]);

  // Listening and watching preferences belong to the viewer, not the timeline: they reach only
  // this Player (which scales every clip's own level), never the timeline's levels or an export.
  const playback = usePreviewPlaybackPreferences();
  const [initialAudio] = useState(() => {
    const { volume, muted } = getPreviewPlaybackPreferences();
    return { volume, muted };
  });
  const appliedAudioRef = useRef(initialAudio);
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const applied = appliedAudioRef.current;
    if (applied.volume !== playback.volume) player.setVolume(playback.volume);
    if (applied.muted !== playback.muted) {
      if (playback.muted) player.mute();
      else player.unmute();
    }
    appliedAudioRef.current = { volume: playback.volume, muted: playback.muted };
  }, [playback.muted, playback.volume]);

  const { mode: fullscreenMode, toggle: toggleFullscreen, exit: exitFullscreen } = usePreviewFullscreen(playerContainerRef);
  const fullscreen = fullscreenMode !== 'off';

  // Fullscreen chrome: shown on any pointer move, tap or key, and fades while the film plays
  // untouched. Paused, or with the pointer resting on the controls, it stays.
  const [chromeAwake, setChromeAwake] = useState(true);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);
  const wakeChrome = useCallback(() => {
    setChromeAwake(true);
    clearIdleTimer();
    const settle = () => {
      const controls = playerContainerRef.current?.querySelector('[data-preview-transport]');
      if (controls?.matches(':hover, :focus-within')) {
        idleTimerRef.current = setTimeout(settle, FULLSCREEN_CHROME_IDLE_MS);
        return;
      }
      idleTimerRef.current = null;
      setChromeAwake(false);
    };
    idleTimerRef.current = setTimeout(settle, FULLSCREEN_CHROME_IDLE_MS);
  }, [clearIdleTimer, playerContainerRef]);
  useEffect(() => {
    if (fullscreen) {
      wakeChrome();
      return clearIdleTimer;
    }
    clearIdleTimer();
    setChromeAwake(true);
    return undefined;
  }, [fullscreen, isPlaying, wakeChrome, clearIdleTimer]);
  const chromeIdle = fullscreen && isPlaying && !chromeAwake;

  // Fullscreen takes the keyboard: the focus moves onto the picture, and its keys are a video
  // player's. The editor's shortcuts stand aside while the fullscreen attribute is present.
  // Leaving gives the focus back (the browser drops it to the page when fullscreen ends), so
  // Space and F go on working in the editor.
  useEffect(() => {
    if (!fullscreen) return undefined;
    const container = playerContainerRef.current;
    const previous = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null;
    container?.focus({ preventScroll: true });
    return () => {
      const lost = !document.activeElement || document.activeElement === document.body || document.activeElement === container;
      if (!lost) return;
      const target = previous?.isConnected ? previous : container;
      // After the browser has finished leaving fullscreen, which can move the focus itself.
      requestAnimationFrame(() => {
        if (!document.activeElement || document.activeElement === document.body) target?.focus({ preventScroll: true });
      });
      target?.focus({ preventScroll: true });
    };
  }, [fullscreen, playerContainerRef]);
  useEffect(() => {
    if (!fullscreen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      wakeChrome();
      // The volume and position sliders and the speed list keep their own keys.
      if (isEditableTarget(event.target)) return;
      if ((event.key === ' ' || event.key === 'Enter') && isActivatableTarget(event.target)) return;
      const player = playerRef.current;
      const { fps } = metadataRef.current;
      const step = (seconds: number) => seek(Math.max(0, (player?.getCurrentFrame() ?? 0) / fps + seconds));
      const nudgeVolume = (delta: number) => {
        const { volume, muted } = getPreviewPlaybackPreferences();
        const next = Math.min(1, Math.max(0, (muted ? 0 : volume) + delta));
        setPreviewPlaybackPreferences({ volume: next, muted: next === 0 });
      };
      switch (event.key.length === 1 ? event.key.toLowerCase() : event.key) {
        case 'Escape':
        case 'f':
          exitFullscreen();
          break;
        case ' ':
        case 'k':
          togglePlayPause();
          break;
        case 'm':
          togglePreviewMuted();
          break;
        case 'ArrowLeft':
          step(-FULLSCREEN_SEEK_SECONDS);
          break;
        case 'ArrowRight':
          step(FULLSCREEN_SEEK_SECONDS);
          break;
        case 'ArrowUp':
          nudgeVolume(FULLSCREEN_VOLUME_STEP);
          break;
        case 'ArrowDown':
          nudgeVolume(-FULLSCREEN_VOLUME_STEP);
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [exitFullscreen, fullscreen, seek, togglePlayPause, wakeChrome]);

  // Fullscreen picture: a mouse click plays or pauses (a double click leaves); a tap shows or
  // hides the controls, as phone players do.
  const pointerTypeRef = useRef('mouse');
  const onFullscreenPictureClick = useCallback(() => {
    if (pointerTypeRef.current === 'mouse') {
      togglePlayPause();
      wakeChrome();
      return;
    }
    if (chromeIdle || !isPlaying) {
      wakeChrome();
      return;
    }
    clearIdleTimer();
    setChromeAwake(false);
  }, [chromeIdle, clearIdleTimer, isPlaying, togglePlayPause, wakeChrome]);

  useEffect(() => () => {
    if (seekFlushRafRef.current !== null) {
      cancelAnimationFrame(seekFlushRafRef.current);
      seekFlushRafRef.current = null;
    }
  }, []);

  useEffect(() => {
    const container = playerContainerRef.current;
    if (!container) return undefined;

    let readyFrame: number | null = null;
    const markPreviewFrameReady = () => {
      // A canvas can exist while its media is still fetching (or has failed).
      // Wait for the decoder callback and one paint before exposing the preview.
      container.dataset.astridPreviewFrameReady = 'true';
    };
    const inspectDecodedFrame = () => {
      if (readyFrame === null && container.querySelector('[data-preview-decoded-frame="true"]')) {
        readyFrame = requestAnimationFrame(markPreviewFrameReady);
      }
    };
    const observer = new MutationObserver(inspectDecodedFrame);
    observer.observe(container, {childList: true, subtree: true, attributes: true, attributeFilter: ['data-preview-decoded-frame']});
    inspectDecodedFrame();
    return () => {
      observer.disconnect();
      if (readyFrame !== null) cancelAnimationFrame(readyFrame);
      delete container.dataset.astridPreviewFrameReady;
    };
  }, [playerContainerRef]);

  useImperativeHandle(ref, () => ({
    seek,
    play,
    pause,
    togglePlayPause,
    toggleFullscreen,
    get isPlaying() {
      return playerRef.current?.isPlaying() ?? isPlaying;
    },
  }), [isPlaying, pause, play, seek, toggleFullscreen, togglePlayPause]);

  const transportControls = (
    <PreviewTransport
      playerRef={playerRef}
      fps={metadata.fps}
      durationInFrames={metadata.durationInFrames}
      isPlaying={isPlaying}
      canPlay={hasPlayableOutput}
      compact={compact}
      touchChrome={touchChrome}
      playerControls={playerControls}
      // A mouse in the editor brings the bar up over the preview; touch and a host's outlet keep it in view.
      revealOnHover={!touchChrome && !transportOutlet}
      fullscreen={fullscreen}
      idle={chromeIdle}
      onTogglePlay={togglePlayPause}
      onJumpToStart={() => requestSeek(0)}
      onSeekFrame={requestSeek}
      onToggleFullscreen={toggleFullscreen}
    />
  );

  return (
    <div
      ref={playerContainerRef}
      // Focusable so fullscreen can take the keyboard; never a tab stop.
      tabIndex={-1}
      // The phone sizes its preview to the film, which can be shorter than the
      // desktop floor; there the floor would push the transport out of view.
      className={cn(
        'group/preview relative flex h-full w-full items-center justify-center overflow-hidden rounded-xl bg-transparent outline-none',
        compact && touchChrome ? 'min-h-0' : 'min-h-[220px]',
        fullscreen && 'rounded-none bg-[var(--video-editor-stage-bg)]',
        // Where the browser cannot fullscreen an element (iPhone), the picture covers the window.
        fullscreenMode === 'window' && 'fixed inset-0 z-[100017] h-[100dvh] min-h-0 w-screen',
        chromeIdle && 'cursor-none',
      )}
      style={VIDEO_EDITOR_THEME_VARS}
      onPointerMove={fullscreen ? (event) => { if (event.pointerType === 'mouse') wakeChrome(); } : undefined}
      {...(fullscreen ? { [PREVIEW_FULLSCREEN_ATTRIBUTE]: fullscreenMode } : {})}
    >
      <PreviewAudioFailureNotice />
      {hasSourceTracks && !fullscreen && (
        <div className="pointer-events-none absolute left-3 top-3 z-10 rounded bg-background/90 px-2 py-1 text-xs text-foreground">
          Output · source tracks excluded
        </div>
      )}
      {displayedRevisionLabel && (
        <div
          data-testid="preview-revision-label"
          aria-label={displayedRevisionLabel}
          title={delivery.revision.reason}
          className="pointer-events-none absolute right-3 top-3 z-10 rounded bg-background/90 px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground"
        >
          {displayedRevisionLabel}
        </div>
      )}
      {unavailableTarget && (
        <div
          data-testid="preview-revision-unavailable"
          aria-label={previewUnavailableLabel(unavailableTarget)}
          title={unavailableTarget.reason}
          className="pointer-events-none absolute right-3 top-10 z-10 max-w-[min(75%,24rem)] rounded bg-destructive/90 px-2 py-1 text-[10px] uppercase tracking-[0.08em] text-destructive-foreground"
        >
          {previewUnavailableLabel(unavailableTarget)}
        </div>
      )}
      <div className="h-full w-full">
        <Player
          ref={playerRef}
          component={PreviewComposition}
          inputProps={inputProps}
          durationInFrames={metadata.durationInFrames}
          // Hold the final frame on completion; replay remains an explicit Play action.
          moveToBeginningWhenEnded={false}
          fps={metadata.fps}
          compositionWidth={metadata.compositionWidth}
          compositionHeight={metadata.compositionHeight}
          numberOfSharedAudioTags={PREVIEW_SHARED_AUDIO_TAGS}
          initialFrame={Math.min(Math.max(0, Math.round(initialTime * metadata.fps)), Math.max(0, metadata.durationInFrames - 1))}
          controls={false}
          clickToPlay={false}
          doubleClickToFullscreen={false}
          spaceKeyToPlayOrPause={false}
          showVolumeControls={false}
          acknowledgeRemotionLicense
          bufferStateDelayInMilliseconds={1000}
          renderLoading={() => <PreviewLoadingPlaceholder />}
          style={{ width: '100%', height: '100%' }}
          initialVolume={initialAudio.volume}
          initiallyMuted={initialAudio.muted}
          playbackRate={playback.rate}
        />
      </div>
      {fullscreen && (
        <div
          aria-hidden
          className="absolute inset-0 z-[5]"
          data-testid="preview-fullscreen-picture"
          onPointerDown={(event) => { pointerTypeRef.current = event.pointerType; }}
          onClick={onFullscreenPictureClick}
          onDoubleClick={() => { if (pointerTypeRef.current === 'mouse') exitFullscreen(); }}
        />
      )}
      {admissionError && (
        <div role="alert" className="absolute inset-x-4 bottom-20 z-10 rounded-md border border-destructive/40 bg-background/95 px-3 py-2 text-sm text-foreground">
          <p>Preview pack could not be loaded. {admissionError}</p>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => {
            void refreshAdmittedElements().catch(() => { /* The admission store exposes retry failures above. */ });
          }}>Retry preview</Button>
        </div>
      )}
      {transportOutlet && !fullscreen ? createPortal(transportControls, transportOutlet) : transportControls}
    </div>
  );
});

RemotionPreviewComponent.displayName = 'RemotionPreview';

// Audio failures are reported from inside the composition and shown in this
// component's chrome, so the provider wraps both.
const RemotionPreviewWithAudioFailures = forwardRef<PreviewHandle, RemotionPreviewProps>(
  function RemotionPreviewWithAudioFailures(props, ref) {
    return (
      <PreviewAudioFailureProvider>
        <RemotionPreviewComponent {...props} ref={ref} />
      </PreviewAudioFailureProvider>
    );
  },
);

export const RemotionPreview = memo(RemotionPreviewWithAudioFailures);
