import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { AppFrame } from '@/app/components/AppFrame.tsx';
import { AppMainContent } from '@/app/components/AppMainContent.tsx';
import { TasksPaneSurface, TasksPaneChatSlot } from '@/features/tasks/components/TasksPane/components/TasksPaneSurface';
import { usePanesStore } from '@/shared/state/panesStore';
import { usePaneControlsHosted } from '@/shared/state/paneControlsHost';
import { useDeviceInfo } from '@/shared/hooks/mobile';
import { useEditorTour, startEditorTour, exitEditorTour, type EditorTourBeat } from '@/shared/state/editorTourStore.ts';
import { UI_Z_LAYERS } from '@/shared/lib/uiLayers.ts';
import { cn } from '@/shared/components/ui/contracts/cn.ts';
import { EditorRuntimeProvider } from '@/tools/video-editor/contexts/EditorRuntimeProvider.tsx';
import { PUBLIC_ASTRID_ELEMENT_HOST } from '@/pages/Home/astrid-public-host.tsx';
import { ProjectHeaderControls } from '@/shared/components/ProjectHeaderControls.tsx';
import { ProjectTimelinePicker } from '@/shared/components/ProjectTimelineSelectors.tsx';
import { tourHeaderProps } from '@/tools/video-editor/tour/timeline/tourHeaderProps.ts';
import { PUBLIC_TIMELINE_SERVICE_HOOKS } from '@/tools/video-editor/runtime/timelineHostServiceHooks.ts';
import { PUBLIC_TIMELINE_OBSERVATIONS } from '@/tools/video-editor/runtime/editorHostObservations.ts';
import { createVideoEditorEffectCatalog } from '@/tools/video-editor/lib/effect-catalog.ts';
import { createVideoEditorSequenceComponentCatalog } from '@/tools/video-editor/lib/sequence-component-catalog.ts';
import { createEditorTourDataProvider } from '@/tools/video-editor/tour/timeline/tourDataProvider.ts';
import { EDITOR_TOUR_TIMELINE_ID } from '@/tools/video-editor/tour/timeline/tourStages.ts';
import { EditorTourTimelineDriver } from '@/tools/video-editor/tour/timeline/EditorTourTimelineDriver.tsx';
import { EditorTourRunner } from '@/tools/video-editor/tour/runner/EditorTourRunner.tsx';
import { EDITOR_TOUR_REST_ATTRIBUTE } from '@/tools/video-editor/tour/anchors.ts';
import { TOUR_MOVE_EASE, TOUR_MOVE_MS } from '@/tools/video-editor/tour/runner/useSettledRects.ts';
import { registerBrowserTourFinish, returnToEditorTourEnd } from '@/tools/video-editor/tour/runner/tourBeats.ts';
import { useEditorDeviceClass } from '@/tools/video-editor/tour/runner/useIsDesktopEditor.ts';
import { TourChatPanel } from '@/tools/video-editor/components/AgentChat/TourChatPanel.tsx';
import { TimelineEditorShellCore, type TimelineEditorRenderActions } from '@/tools/video-editor/components/TimelineEditorShellCore.tsx';
import { TimelineEditorCoreBody } from '@/tools/video-editor/components/TimelineEditor/TimelineEditorCoreBody.tsx';
import { useTimelineEditorOps } from '@/tools/video-editor/hooks/timelineStore.ts';
import { HOST_PROPERTIES_PANEL_KEY } from '@/tools/video-editor/components/PropertiesPanel/VideoEditorPanelDisplayControl.tsx';

/** The tour needs no extension: step 1 is an ordinary media clip, so no world renderer is bundled or loaded. */
const NO_EXTENSIONS: readonly never[] = Object.freeze([]);
const EFFECTS = createVideoEditorEffectCatalog();
const SEQUENCES = createVideoEditorSequenceComponentCatalog();
const HEADER = tourHeaderProps();
const noOp = () => undefined;
const inChat = (beat: EditorTourBeat) => beat === 'compose' || beat === 'respond';

const TOUR_PICKER_PROPS = {
  projects: [], timelines: [], ...HEADER,
  onSelectProject: noOp, onSelectTimeline: noOp,
} as const;

/** Stable, so a re-render of the tour's frame never re-renders the editor through a new closure. */
const renderTourTimeline = (actions: TimelineEditorRenderActions) => (
  <TimelineEditorCoreBody hostObservations={PUBLIC_TIMELINE_OBSERVATIONS} {...actions} />
);

function BrowserTourEditorSurface() {
  const ops = useTimelineEditorOps();
  const opsRef = useRef(ops);
  opsRef.current = ops;

  useLayoutEffect(() => {
    // The in-memory demo shows the Inspector throughout. The panel's Compact layout while the tour runs is the shell's
    // own override (`useRightPanelLayout`), not a saved choice.
    opsRef.current.setSelectedRightPanelId(HOST_PROPERTIES_PANEL_KEY);
  }, []);

  return <TimelineEditorShellCore
    timelineId={EDITOR_TOUR_TIMELINE_ID}
    isOnEditorPage
    showHeader={false}
    previewNavigationControls={<ProjectTimelinePicker {...TOUR_PICKER_PROPS} showProjectSelector={false} showProjectLabel={false} />}
    renderTimeline={renderTourTimeline}
  />;
}

function BrowserTourFrame() {
  const tasksPaneWidth = usePanesStore(state => state.tasksPaneWidth);
  const touchPane = usePaneControlsHosted();
  // Two flags, not the beats themselves: the frame (and the editor inside it) re-renders only when the chat comes or goes,
  // not on every step, so nothing heavy runs on the frame where the card and spotlight start to move.
  // A touch chat slides with the step the card and spotlight SHOW (as the tour's Generations pane does): in on the frame
  // they set off for it, out on the frame they leave it, with their duration and easing. One motion, both ways.
  const chatShown = useEditorTour(state => inChat(state.shownBeat));
  // On its way in (the store is on a chat beat the highlight has not set off for yet) or there: the spotlight measures
  // what is inside it where it will rest, so it never has to wait for the slide to end.
  const chatHeadingIn = useEditorTour(state => inChat(state.beat) || inChat(state.shownBeat));
  const reducedMotion = useEditorTour(state => state.reducedMotion);
  // The demo editor is a picture behind the tour: the spotlight already takes every pointer, so keep focus and
  // assistive tech on the card (and the chat's Send) too.
  const touring = useEditorTour(state => state.status === 'running');
  const device = useEditorDeviceClass();
  const phone = device === 'phone';
  // A tablet held upright gets the chat as a sheet from the bottom, under a full-width preview, not a drawer that
  // narrows the editor to a sliver.
  const { orientation } = useDeviceInfo();
  const sheet = device === 'tablet' && orientation === 'portrait';
  const chatVisible = !touchPane || chatShown;
  const tasksPaneReserve = touchPane ? '0px' : `${tasksPaneWidth}px`;
  const surface = useMemo(() => <BrowserTourEditorSurface />, []);
  const contentStyle = { marginRight: tasksPaneReserve, willChange: 'margin, padding' } as CSSProperties;
  const projectControls = <ProjectHeaderControls
    projects={[]}
    projectId={HEADER.projectId}
    projectName={HEADER.projectName}
    onSelectProject={noOp}
    selectedProject={null}
    pickerDisabled={HEADER.disabled}
    actionsDisabled={HEADER.disabled}
    showDialogs={false}
  />;

  return <AppFrame fullEditor>
    <div className="contents" {...(touring ? { inert: '' } : {})}><AppMainContent
      headerContent={projectControls}
      tasksPaneReserve={tasksPaneReserve}
      contentStyle={contentStyle}
      isEditorRoute
      isFullEditorSurface
      navigationMode="tools"
      showProjectControls={false}
      settingsDisabled={HEADER.disabled}
      nonEditorMainClassName=""
      mainLabel="Lantern Valley guided demo"
    >
      {surface}
    </AppMainContent></div>
    <div className="pointer-events-none" style={sheet ? {
      position: 'fixed', left: 0, right: 0, bottom: 0, height: 'min(52dvh, 44rem)',
      zIndex: UI_Z_LAYERS.TASKS_PANE_CONTENT,
    } : {
      position: 'fixed', right: 0, top: 0, bottom: 0,
      // A phone's chat takes the whole screen while it has the spotlight, rather than leaving a sliver of editor.
      width: phone ? '100vw' : touchPane ? 'min(28rem, calc(100vw - 3rem))' : `${tasksPaneWidth}px`,
      zIndex: UI_Z_LAYERS.TASKS_PANE_CONTENT,
    }}>
      <TasksPaneSurface role="complementary" aria-label="Task and chat pane" aria-hidden={!chatVisible}
        {...(!chatVisible ? { inert: '' } : {})}
        {...{ [EDITOR_TOUR_REST_ATTRIBUTE]: !touchPane || chatHeadingIn ? 'in' : 'out' }}
        style={touchPane && !reducedMotion ? { transitionDuration: `${TOUR_MOVE_MS}ms`, transitionTimingFunction: TOUR_MOVE_EASE } : undefined}
        className={cn('absolute right-0 transform transition-transform duration-300 ease-smooth',
          sheet ? cn('bottom-0 rounded-t-2xl border-l-0 border-t', chatVisible ? 'translate-y-0' : 'translate-y-full') : cn('top-0', chatVisible ? 'translate-x-0' : 'translate-x-full'))}>
        <TasksPaneChatSlot><TourChatPanel /></TasksPaneChatSlot>
      </TasksPaneSurface>
    </div>
  </AppFrame>;
}

/**
 * The shared app/editor shell backed by bundled media and in-memory operations. `atEnd` opens it on its last card,
 * for Back from the screen that follows it.
 */
export function BrowserTourEditor({ onFinish, atEnd = false }: { onFinish: () => void; atEnd?: boolean }) {
  const [dataProvider] = useState(createEditorTourDataProvider);
  const [startAtEnd] = useState(atEnd);
  useLayoutEffect(() => {
    const unregister = registerBrowserTourFinish(onFinish);
    startEditorTour();
    if (startAtEnd) returnToEditorTourEnd();
    return () => { exitEditorTour(); unregister(); };
  }, [onFinish, startAtEnd]);
  return <EditorRuntimeProvider astridElementHost={PUBLIC_ASTRID_ELEMENT_HOST}
    dataProvider={dataProvider} timelineId={HEADER.timelineId} timelineName={HEADER.timelineName}
    timelineServices={PUBLIC_TIMELINE_SERVICE_HOOKS} effectCatalog={EFFECTS} sequenceComponentCatalog={SEQUENCES}
    extensions={NO_EXTENSIONS} extensionStateRepository={null}
    runtime={{ assetResolver: dataProvider, exporter: null, hostContext: null }}
    enableMutationServices enableLiveServices={false} enableRenderExport={false}>
    <BrowserTourFrame />
    <EditorTourTimelineDriver />
    <EditorTourRunner />
  </EditorRuntimeProvider>;
}
