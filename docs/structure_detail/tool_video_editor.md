# Video Editor Tool (Timeline)

> **Path**: `src/tools/video-editor/` | Multi-track timeline editor, extension host, and render pipeline. Largest tool in the repo (~680 TS/TSX files).

**Purpose**: orient a developer in the *timeline surface* — layers, state ownership, gesture systems, and the unwritten contracts that hold them together. The extension platform has its own doc suite (`docs/video-editor/`, start at `extension-author-contract.md`, §11); this doc covers the host.

**Source of Truth**: `hooks/useTimelineState.ts` (state composition) · `hooks/timelineStore.ts` (slice store) · `lib/mobile-interaction-model.ts` (interaction policy) · `lib/timeline-scale.ts` + `lib/coordinate-utils.ts` (geometry).

---

## 0. Daily commands

| Task | Command |
|---|---|
| Fake Runtime alone (when Vite is already running) | `node tests/e2e/fake-runtime/launch.mjs --serve` (port from `FAKE_RUNTIME_PORT`) |
| Run one test file | `npx vitest run <path>` — the root `vitest.config.ts` delegates to `config/testing/`, so the `--config` flag in the package scripts is **not** needed interactively |
| Watch one test file | `npx vitest <path>` |
| Everything in the tool | `npx vitest run src/tools/video-editor` (or a subdir, e.g. `.../lib`) |
| Real-browser device gestures | `npm run test:e2e:timeline` — one command; it boots the dev server *and* the fake Runtime. One-time setup: `npx playwright install chromium`; `preview-scrub-evidence.spec.ts` (Chrome project) also needs ImageMagick 7 (`magick`) and `ffmpeg` on PATH and fails by name in `beforeAll` without them |
| H.264 browser proofs (`@chrome-h264`: the two export renders and `preview-scrub-evidence`) | `npm run test:e2e:chrome-export` — runs only where installed Google Chrome is present (`channel: 'chrome'`); the bundled Chromium can neither encode nor decode H.264, so these cases are excluded from `test:e2e:timeline`. The release gate runs it (`timeline-chrome-export`) |
| Is the extension host wired? | open the editor with `?extensionSmoke=1`; the smoke extension's status contribution should appear |

The conformance suite is the slow one (~45s for the 3-file run) — for the edit
loop, watch the single file you are changing.

### Your local Runtime

See [the repository README](../../README.md) for the local app and deterministic
editor preview launch commands. This guide focuses on the editor surface.

---

## 1. Layer map

Paths below are relative to `src/tools/video-editor/`.

| Layer | File | Owns |
|---|---|---|
| Page | `pages/VideoEditorPage.tsx` | Reads `?timeline` / `?localProject` + `?localTimeline`; picks the data provider; `remountKey` forces a clean remount per timeline |
| Runtime assembly (app) | `contexts/VideoEditorProvider.tsx` | Calls `useTimelineState()`, creates the store, assembles command/agent-tool/live-data registries, extension lifecycle, `ProcessManager` |
| Shared assembly | `contexts/editorRuntimeAssembly.tsx` | `useEditorRuntimeAssembly` / `useEditorRuntimeSync` / `EditorRuntimeScaffold` — the wiring itself (registries, extension lifecycle, proposal runtime, process manager, diagnostics) lives here once, for both hosts |
| Runtime assembly (embed) | `contexts/EditorRuntimeProvider.tsx` via `browser/BrowserVideoEditorProvider.tsx` | The browser/embed host. Owns host-specific ports (console vs toasts, lightbox, stubs, settings persistence) and its own **option set** into the shared assembly (`enableLiveData`, `enableShaderRegistry`, `eagerProposalRetry`, …) |
| Runtime context | `contexts/VideoEditorRuntimeContext.tsx` | `VideoEditorRuntimeContextValue` — the whole runtime (ports, registries, provider, ids). Wrapper is `VideoEditorRuntimeProvider`, accessor is `useVideoEditorRuntime()` |
| Shell | `components/AstridVideoEditorShell.tsx` → `components/TimelineEditorShellCore.tsx` | CSS-grid layout, toolbar (the touch shell's document row), the touch shell's Astrid bar and short-landscape layout, armed-gesture Done, the touch clip sheet, extension slots, activity region, contribution + timeline error boundaries |
| Editor core | `components/TimelineEditor/TimelineEditor.tsx` (re-export) → `components/AstridTimelineEditor.tsx` (shots / shot groups / variants glue) → `components/TimelineEditor/TimelineEditorCore.tsx` | Registers gestures, computes extent, per-clip render, `DropIndicator`. Mounted inside `TimelineErrorBoundary` (§9) |
| Canvas | `components/TimelineEditor/TimelineCanvas.tsx` | Ruler, grid, scroll container, pinch zoom, context menus, footer (+ Video / + Audio, desktop create tools) |
| Rows / clips | `components/TimelineEditor/TrackListRenderer.tsx`, `ClipAction.tsx`, `TrackLabel.tsx`, `ShotGroupOverlay.tsx` | Markup that carries the DOM contract (§4) |

---

## 2. State ownership

`useTimelineState()` composes ~15 sub-hooks (queries, save, history, selection, clip editing, resize, external drop, drag coordinator, playback, render state, track management, ops) into **four slice objects**, then *pushes* them into a vanilla zustand store via `syncSlices()` each render. The store is a distribution mechanism, not the source of truth — the hook composition is.

| Slice | Contains | Read via |
|---|---|---|
| `data` | Resolved config, clips, refs, zoom, device class, interaction mode | `useTimelineEditorData` / `useTimelineDataSelector` |
| `ops` | Mutations (`applyEdit`, `moveClipToRow`, …), selection setters, `commands` | `useTimelineEditorOps` / `useTimelineOpsSelector`, `useTimelineCommands` |
| `chrome` | Panels, zoom setters, shell UI state | `useTimelineChromeContext` / `useTimelineChromeSelector` |
| `playback` | Preview refs, transport | `useTimelinePlaybackContext` / `useTimelinePlaybackSelector` |
| (adapters) | Mutable refs handed to gesture code (`dataRef`, `selectedClipIdsRef`, …) | `useTimelineMutableAdapters` |

**Safe vs non-Safe.** Non-`Safe` hooks throw when no `TimelineStoreProvider` is above them — use them **inside the mounted editor subtree**. `Safe` variants return `null` when there is no provider *or* the editor is not mounted — use them only for consumers that legitimately run with no editor open (e.g. "add to editor" affordances elsewhere in the app), and handle the `null`.

**Pre-sync ops throw.** Every function in the store's *initial* ops slice (`createInitialOpsSlice` in `timelineStore.ts`) throws, not just `commands.validate/dryRun/apply`. `useTimelineState` seeds the store during render, before descendants mount, so the mounted path never reaches them — a call that does means the consumer is rendering outside the editor and should be on a `Safe` hook. Per CLAUDE.md's "Context hooks" rule, that is a crash, not a silent no-op.

---

## 3. Three drag-and-drop systems

They coexist and do not share a mechanism. Match the gesture to its owner before touching anything.

| Gesture | System | Entry point |
|---|---|---|
| Clip move (incl. cross-track), shot-group drag | Custom **document-level pointer machine** | `hooks/useClipDrag.ts` (`document.addEventListener('pointerdown')`), commit logic in `useClipDrag.helpers.ts` |
| Clip trim | Same pointer-machine style, separate hook | `hooks/useClipResizeGesture.ts`, mounted from `TimelineCanvas.tsx` |
| Marquee select | Window-level pointer listeners | `hooks/useMarqueeSelect.ts` |
| Track reorder | **dnd-kit** (`useSortable`/`DragEndEvent`) | `TimelineEditorCore.tsx` sensors → `TrackListRenderer.tsx` / `TrackLabel.tsx` |
| External asset & tool drops | **HTML5 drag-and-drop** | `onTimelineDragOver`/`onTimelineDrop` in `TimelineEditorCore.tsx`; `draggable` sources in `TimelineCanvas.tsx`; `hooks/useExternalDrop.ts` |

`hooks/useDragCoordinator.ts` drives `components/TimelineEditor/DropIndicator.tsx` — a `createPortal`-to-`document.body` imperative indicator **shared by the pointer machine and the HTML5 leg**, styled by the `.drop-indicator-*` classes in `timeline-overrides.css`. Because it is portaled and imperative, it does not appear in the editor's React tree; grep the class names, not the JSX.

HTML5 DnD never fires on touch — any drag-only affordance needs a tap path, or stays off touch (the floating tool cluster is desktop-only). Gallery media's tap path: a tap selects an item (`MediaGalleryItem` takes taps itself in single-click galleries) and "Add selected to timeline" places it; a hosted gallery then closes.

**Keyboard is the pointerless fourth path, and it must not fork the commit.** `hooks/useKeyboardShortcuts.ts` owns the window-level `keydown` map (all built-ins decline before extension keybindings dispatch; `isEditableTarget` gates the whole handler). Arrow keys move the selection on both axes: `ArrowUp`/`ArrowDown` across tracks via `moveSelectedClipsToTrack`, `Alt+ArrowLeft`/`Alt+ArrowRight` along time via `buildKeyboardTimeNudgeMutation` (`lib/keyboard-nudge.ts`) → `applyEdit`, the same builder-plus-`applyEdit` shape as `lib/keyboard-delete.ts` and therefore history-tracked like any other edit. The nudge builder routes through `planMultiDragMoves`/`applyMultiDragMoves` so a keypress lands where the equivalent drag would; it steps `COARSE_TIME_NUDGE_SECONDS` (0.5s), expands a pinned-group member to its group, and clamps a leftward nudge **once for the whole selection** so relative offsets survive at `t=0`. `Alt+Arrow` with no selection seeks like a plain arrow. There is no shortcut help surface in the editor today; adding one means listing these, not inventing a second source of truth.

---

## 4. Stringly DOM contract

The gesture layer's real API is class names and data attributes resolved with `closest()` / `querySelector()`. `lib/timeline-dom.ts` (`TIMELINE_DOM`) names every token below and is the **only** place they may be spelled: it exports the class/attribute constants, the selectors the gesture layer issues, the `dataset` keys it reads back, and one attribute builder per markup site. Import from there on both sides — a rename then breaks the build instead of the gesture.

| Token | Written by | Read by |
|---|---|---|
| `.clip-action` | `ClipAction.tsx` | `useClipDrag.ts`, `useClipDrag.helpers.ts`, `useMarqueeSelect.ts`, `timeline-overrides.css` |
| `.timeline-canvas-edit-area` | `TimelineCanvas.tsx` | `TimelineEditorCore.tsx` (`editAreaRef` + ad-hoc re-queries), `useClipDrag.ts`, `lib/drop-position.ts`, CSS |
| `data-clip-id` | `ClipAction.tsx`, `TrackListRenderer.tsx` | `useClipDrag.ts`, `useMarqueeSelect.ts` |
| `data-row-id` | `ClipAction.tsx`, `TrackListRenderer.tsx` | drag/drop row resolution |
| `data-selected` | `ClipAction.tsx` (`"true"` only when selected) | `tests/e2e/timeline/support.ts`, device probes, DevTools — selection state outside React |
| `data-resize-edge` | `TrackListRenderer.tsx` | `useClipResizeGesture.ts`, trim `touch-action` CSS |
| `data-touch-gesture-mode` | `TimelineCanvas.tsx` (edit area) | `timeline-overrides.css` only — this attribute *is* the touch mechanism |
| `data-shot-group-drag-anchor-clip-id` / `-row-id` | `ShotGroupOverlay.tsx` | `useClipDrag.ts`, `TimelineCanvas.tsx` hit-test exclusions |
| `data-action-id`, `data-track-id` | clip/track markup | hit-test exclusions in `TimelineCanvas.tsx`, `useMarqueeSelect.ts` |
| `data-video-editor-shell-region` | `TimelineEditorShellCore.tsx` | grid-row regression test |

CSS cannot import TypeScript, so `timeline-overrides.css` repeats the tokens as literals; `lib/timeline-dom.test.ts` pins every selector the stylesheet builds from the contract (plus the attribute↔`dataset` key pairs), and fails until the CSS follows a rename. `compositions/` also emits `data-clip-id`, but on the Remotion render surface — a different DOM, not this contract.

---

## 5. Mobile interaction: policy vs mechanism

`lib/mobile-interaction-model.ts` is a **pure policy module**: device class (`desktop|tablet|phone`), input modality, interaction mode (`browse|select|move|trim`), gesture owner, plus predicates (`shouldAllowTouchClipDrag`, `resolveArmedTouchGesture`, `shouldExpandTouchTrimHandles`, `shouldEnableTimelinePinchZoom`, …). `phone` and `tablet` get the same touch editor; the shell lays it out by the screen's shape, so the editor branches on `deviceClass !== 'desktop'`, never on phone vs tablet. Device class is resolved once in `useTimelineState.ts`, which supplies the values `resolveTimelineDeviceClass` decides from.

**Device class inputs.** `useIsMobile` is true for *any* coarse pointer at *any* width, so `isMobile && !isTablet` alone is not a phone test. `resolveTimelineDeviceClass` takes four values — `isMobile`, `isTablet`, `viewportWidth` (`useViewportWidth`), `isTabletHardware` (tablet UA / iPadOS-like, from `shared/hooks/mobile/deviceDetection.ts`) — and applies the owner's rule: **large coarse-pointer screens are desktops unless the hardware is a tablet.** Below `TABLET_MAX_WIDTH` (1200) a coarse pointer still means `phone`; at or above it, tablet hardware keeps `tablet` (an iPad Pro 12.9 in landscape is 1366px, past `computeIsTablet`'s own band) and everything else is `desktop` (a touchscreen monitor gets the desktop editor). The shared signals keep their app-wide semantics — the correction lives at this seam. Pinned by `mobile-interaction-model.test.ts` ("device class").

Policy answers *may this gesture happen*. It cannot make it happen. The **mechanisms** live elsewhere:

| Mechanism | Where |
|---|---|
| `touch-action: none` on the gesture's owner element | `timeline-overrides.css`, selected by `[data-touch-gesture-mode='move']` (clips) / `'trim'` (handles) |
| Expanded trim handles + grip affordance | `TimelineCanvas.tsx` handle width, CSS `::after` |
| Track names only (no hover-revealed rename, reorder, settings) | `TrackLabel.tsx` (`showTrackActions` is desktop-only) |
| Entering and leaving move/trim | `PropertiesPanel/ClipInspectorActions.tsx` Move/Trim (non-desktop; the selected clip's action grid) arm the gesture · `resolveArmedTouchGesture` → Done in `TimelineEditorShellToolbar.tsx`, which restores `getDefaultInteractionMode` (`browse` on touch). No global mode control on any device |
| Touch clip sheet | `TimelineEditorShellCore.tsx` opens `TimelineMobileInspectorDialog.tsx` on a tap on a clip (not while a gesture is armed, not from a control inside the clip); Move/Trim, closing or deleting the clip close it. It opens on the clip's own tab (`getSelectionDefaultClipTab(…, touch)`: Text for a text clip, else Timing — Start and Duration side by side, a number pad on a phone). The action grid leaves out what the clip's type cannot do (no Mute on text) and disables a track move with nowhere to go (`getTrackMoveTargets`) |
| Editor clear of the app's floating pane tabs | Desktop: `TimelineEditorShellCore.tsx` reserves the bands the fixed tabs occupy on the condensed and full `main` (the right tab's 52px as `paddingInlineEnd`, the bottom pill's 56px plus the safe-area inset as `paddingBottom`; private `PANE_TAB_BAND_*_PX` constants) and keeps the sidebar preview's Render clear of the tab. Touch (phone and tablet) reserves nothing and hosts the entry points itself in the shell's bottom bar (gallery, Text, Ask Astrid): Text adds words at the playhead in front of the picture (`handleAddText`: the front video track if free there, else a new front track) and opens them in the clip sheet; while an agent turn runs (`useAgentChatActions().isAgentWorking`) the Ask pill reads "Astrid is working…" and holds `acquirePaneControlsHost()` (`shared/state/paneControlsHost.ts`) while mounted, `PaneControlTab` renders nothing meanwhile, and the bar opens the panes with the `openGenerationsPane` / `openAgentComposer` app events. While hosted, panes are transient on every device (`useSlidingPane`, `usePaneLockPolicyState`): no locks, no push (`LayoutMainContent`), a backdrop, and a tap outside closes them |

**Rule: a new gesture policy is not done until its mechanism ships in the same PR.** A touch that starts on `touch-action: auto` is claimed by the browser for native panning and the pointer stream is cancelled mid-drag; `preventDefault()` on `pointermove` cannot undo that (see the doc comment on `resolveArmedTouchGesture`). jsdom cannot observe this, so unit tests will pass either way.

**Reachability.** Touch has no mode switcher. It rests in `browse` (a drag pans, a tap selects and opens the clip sheet). `move` and `trim` are armed from the selected clip's action grid and released with Done, the only control that leaves them. `select` (the desktop default, with the mouse marquee) is not reachable from any touch control, so touch has no marquee. Desktop is modeless. Pinned by `TimelineEditorShellCore.test.tsx` ("touch editing without a mode switcher", "phone layout"), `ClipInspectorActions.test.tsx` and the conformance suite's "mode reachability" rows.

**Inspector default.** The right-panel dock starts open only at viewport widths of 1024px or more (`INSPECTOR_DEFAULT_OPEN_MIN_VIEWPORT_PX` in `hooks/useEditorPreferences.ts`); in a narrower desktop-class window it would take a third of the timeline (the touch editor mounts no dock at all). It is a default only: a saved choice, including closed, always wins, and a resize never flips it. Only an explicit `setSelectedRightPanelId` writes the selection; the saved record leaves it absent otherwise (and `useEditorSettings` writes nothing until a setter runs), so a window first opened narrow still opens the dock on a later desktop-width load. Pinned by `useEditorPreferences.test.tsx` and `layout-geometry.spec.ts` (`flags.rightPanelOpen`).

**Enforcement.** `lib/mobile-interaction-conformance.test.tsx` renders the canvas and the shell over the whole (device class × interaction mode) matrix and binds every predicate to the markup or stylesheet rule that implements it — plus a coverage gate: a new export of `mobile-interaction-model.ts` fails the suite until it is either bound to a mechanism or listed in that file's `EXCLUSIONS` with a reason of its own. jsdom cannot see a browser claim a touch stream, so the suite asserts DOM/CSS contracts only; the gesture itself is proven by the committed device specs in `tests/e2e/timeline/` (`npm run test:e2e:timeline`, opt-in: its flag makes Playwright boot both the dev server and the fake Runtime).

*Removed*: touch marquee. It once let tablets marquee in `select` mode (with a third `marquee` gesture owner so the edit area carried `touch-action: none`), but no touch control has reached `select` since the mode switcher went, so the touch branch, the `marquee` owner and its CSS were deleted. The mouse marquee (`useMarqueeSelect`) is unchanged and declines touch input.

---

## 6. App mode vs dev Local mode

| | App mode | Local mode (dev only) |
|---|---|---|
| URL | `?timeline=<id>` (+ project selection) | `?localProject=<slug>&localTimeline=<id>` |
| Enabled by | default | `import.meta.env.DEV` + `?localProject`/`?localTimeline` URL params (the legacy `dev.videoEditor.localMode` flag and `DevModeToggle` were retired) |
| Data provider | none: `VideoEditorPage` builds a provider only for `runtime` and `local` modes, so `?timeline=` alone builds none | `RuntimeDataProvider` (`src/integrations/runtime/dataProvider.ts`) → `/api/runtime` on the Vite proxy → the Workspace Runtime at `VITE_WORKSPACE_RUNTIME_URL` (`config/vite/vite.config.ts`). `dev:editor` and the e2e suite point that at the fake Runtime |
| Runtime provider | `contexts/VideoEditorProvider.tsx` (**both modes**) | same |

Only the `dataProvider`, ids, and `remountKey` differ — the provider component and shell are identical. `EditorRuntimeProvider` is *not* the local-mode provider; it is the embed/browser host. `src/app/hooks/useVideoEditorRouteState.ts` must read **both** `timeline` and `localTimeline`, or local mode renders the full-height shell inside the scrolling page layout. Tests/harnesses use `testing/InMemoryDataProvider.ts`; the port contract and its factory-plus-conformance doctrine live in `data/DataProvider.ts` + `data/conformance/`.

---

## 7. Zoom and coordinate semantics

The names mislead. Read this before touching anything width-shaped.

| Name | Meaning | Declared in |
|---|---|---|
| `scale` | **Seconds per ruler division — a constant, not the zoom** (`SCALE_SECONDS = 5`) | `lib/coordinate-utils.ts` |
| `scaleWidth` | **Pixels per division — this is the zoom level** | store `data`/`chrome` slices |
| `pixelsPerSecond` | `scaleWidth / scale` | `createTimelineScale`, `lib/timeline-scale.ts` |
| Bounds / step | `MIN_TIMELINE_SCALE_WIDTH` 40, `MAX_TIMELINE_SCALE_WIDTH` 500, `TIMELINE_ZOOM_STEP` 1.4, `clampTimelineScaleWidth` | `lib/timeline-scale.ts` |
| Layout constants | `ROW_HEIGHT` 36, `getTimelineLabelWidth(deviceClass)` (144 px track-name column, 56 px on touch; also the timeline's `startLeft`) | `lib/coordinate-utils.ts` |
| Extent | `computeTimelineExtent` → `{ scaleCount, totalWidth }`, `maxClipEndSeconds`, `TIMELINE_TRAILING_RUNWAY_SECONDS` 20 | `lib/timeline-scale.ts` (see Key Invariant 4) |
| Time↔frame policy | `snapToFrameGrid` / `secondsToFrames` / `framesToSeconds` / `mediaDurationInFrames` / `resnapTimelineToFps` — seconds stay the stored truth, **every locally committed edit snaps to the current fps' frame grid**; media Sequence durations derive from the trim window | `lib/time-grid.ts` (bound to the commit paths by `lib/time-grid-conformance.test.ts`) |

Both zoom paths route through the constants: toolbar +/- in `TimelineEditorShellCore.tsx` and pinch in `TimelineCanvas.tsx`. Keep it that way — do not reintroduce inline `1.4`/`40`/`500`.

`TimeRuler` takes one presentational switch, `compactLabels`: touch rulers label whole seconds (`m:ss`), pointer rulers hundredths. Ticks, `contentWidth` and the scroll extent are the same either way. On touch the bottom ~5px of the ruler belong to the clip row (touch adjustment snaps a finger there onto the clip), so scrubs land above that strip.

The create buttons (`TimelineCreateTools`, `data-testid="timeline-tool-buttons"`) are desktop only: touch has none, because adding elements is the agent's job there (the thumb bar has Text and "Ask Astrid…"). They sit in the canvas footer row that ends the scroll content, in the layout flow to the right of `+ Video` / `+ Audio` (horizontally sticky just right of the track-name column), so no button ever lies over a track, clip or lane; the footer is one track row (36px) tall, at least 32px (one 24px button plus 4px above and below), and the scroll content height includes it. The effect and animation tools go through `openElementCreationPrompt` with `CREATE_EFFECT_PROMPT` / `CREATE_ANIMATION_PROMPT`. The ruler's time labels sit in their own `z-30` layer (`timeline-ruler-labels`) above the extension ruler overlay (`z-20`), so a marker diamond never covers a label; the layer is clipped to the timeline area (`overflow-hidden` from `startLeft`) so a scrolled label never paints over the overlay's layer legend or pager in the track-name column. `TimelineCanvas.test.tsx` covers the footer height and the label layer; `extension-visual-regression.spec.ts` frames the composed lanes and fails if a lane is under the ruler or a button; `layout-geometry.spec.ts` counts any overlap of the create tools with the ruler, a clip or a pane tab (`toolButtonOverlaps`, always 0; `rects.createTools` is null on touch); it does not scroll a tall timeline.

---

## 8. Extensions

Full platform docs: **`docs/video-editor/`** (`extension-author-contract.md`, `extensions-debugging.md`, migration + release checklist; the trust posture is `docs/extensions/trust-and-security.md`). Extensions import only `@astrid/editor-sdk`, an alias to `src/sdk/index.ts` (`tsconfig.json`, `config/vite/vite.config.ts`), enforced by `src/sdk/boundary.test.ts`.

**`timelineOverlay` is a live, host-rendered surface.** `TimelineExtensionOverlayHost` (mounted by `TimelineCanvas.tsx`) consumes `useVideoEditorTimelineOverlays()` — resolved descriptors only — and portals extension renderer output into content-coordinate roots inside the scroller, with `markerLayer` rendering into a ruler portal root outside the scroller driven by one imperatively updated `translateX(-scrollLeft)` strip. The contribution contract is **required-render**: the manifest declares a non-empty `render` id (no `when` clause), the extension binds the renderer through `ctx.ui.registerRenderer(renderId, renderer)` during `activate()` (SDK: `src/sdk/ui.ts`, `src/sdk/video/families/timelineOverlays.ts`), and the runtime reconciles via `resolveRegisteredRenderers()` (`runtime/extensionRenderSurface.ts`, `runtime/extensionRendererRegistry.ts`). Overlays whose renderer was never registered are omitted — there is no callable/null placeholder. Each renderer renders through React component semantics inside `HostContributionErrorBoundary` (error → claim released → fallback), keyed by both `extensionId` and contribution ID.

The V1 host-owned primitive is `primitives.markerLayer(...)`, **ruler-only** (`placement: 'ruler'` only — no `trackId`, no canvas placement). Markers are controlled input with preview/commit intents; commits snap to the frame grid. Marker data persists via the standard storage-neutral `project-data.write` path and is **never deleted by generic disposal** — clearing is always an explicit user action. Coverage uses inline test extensions (`TimelineExtensionOverlayHost.integration.test.tsx`, `TimelineMarkerLayer.test.tsx`).

**Gesture arbitration.** `lib/mobile-interaction-model.ts` adds the host-internal `'overlay'` gesture owner. Overlay wrappers are `pointer-events: none` until `claimPointer()` succeeds (claimant key `${extensionId}:${contributionId}`); `claimPointer()` returns `false` for any foreign owner or foreign overlay claimant; while `gestureOwner === 'overlay'`, marquee/context-menu ignore the overlay-interactive attribute and pinch refuses to initialize or continue without `preventDefault()` in the declined path. `touch-action: none` is limited to interactive marker hit targets. The release criterion is **"All existing timeline gestures behave identically when no overlay has an active claim"** (clip drag, trim, ruler scrub, marquee, selection, context menus, wheel/native scrolling, auto-scroll, drop/reorder, pinch zoom).

**Canary gate & manager seam.** The host is gated by the provider-owned `timelineOverlaysEnabled` flag (default `false`; plumbed through `VideoEditorRuntimeContext`, `VideoEditorProvider`, `EditorRuntimeProvider`, `BrowserVideoEditorProvider`). The old DEV-only `?timelineOverlayCanary=1` query parameter is **gone**: nothing reads it, and `VideoEditorPage.test.tsx` pins that a canary URL changes nothing. The host mounts when the deployment kill switch (`extensionHostEnabled`) is on and an enabled, reviewed extension contributes a `timelineOverlay`. Maturity promotion to `public-supported` stays deferred until the release criterion passes. Separately, the Extension Manager gained a DEV-only **Local extensions** section: inventory comes from `devLocalExtensions` (via the `devExtensionEnablement.ts` external store), while `extensionRuntime.extensions` determines active status and contribution summaries — disabled local extensions stay visible and re-enableable. Installed packages already have manager enable/disable, settings editing, and persisted enablement (S-160–S-164); installer, bundler, marketplace, discovery, and update tooling remain absent.

---

## 9. Failure containment

| Boundary | Wraps | Recovery |
|---|---|---|
| `runtime/ContributionErrorBoundary.tsx` (`HostContributionErrorBoundary`) | every extension slot / dialog / panel / inspector section | "Retry", bounded + debounced, driven by the lifecycle host's recovery key |
| `components/TimelineEditor/TimelineErrorBoundary.tsx` | the timeline region only, mounted around `<TimelineEditor>` in all three shell layout branches | "Reload editor" bumps a local epoch used as both `recoveryKey` and the subtree `key`, so the children re-mount instead of re-rendering over the state that crashed |

Both refuse to auto-reset on a children-reference change once a recovery key exists — a persistently malformed clip would otherwise crash→recover→crash on every parent render. The timeline boundary is deliberately *narrow*: a throw in `ClipAction`/`TrackListRenderer` must leave the toolbar (and therefore undo), the preview and the inspector mounted. Pinned by `TimelineEditorShellCore.test.tsx` ("timeline error boundary").

---

## Key Invariants

1. **Grid rows == stacked regions.** `gridTemplateRows` in `TimelineEditorShellCore.tsx` must declare one row for every `data-video-editor-shell-region` child. An undeclared row lands in an implicit `auto` track and collapses the preview's `1fr` to zero height. Pinned by `TimelineEditorShellCore.test.tsx` ("declares one grid row for every stacked region").
2. **Every policy-allowed gesture ships its mechanism.** If a predicate in `mobile-interaction-model.ts` permits a touch gesture, some element must carry `touch-action: none` (today: via `data-touch-gesture-mode`) and some rendered control must reach the mode on that device class. Policy without mechanism compiles, unit-tests green, and fails only on a real device. Reachability is owned by the clip sheet's Move/Trim actions (`resolveArmedTouchGesture`). Enforced by `lib/mobile-interaction-conformance.test.tsx`, which walks the device-class × mode matrix against the rendered DOM and the stylesheet text, and refuses to pass on a new policy export that has neither a mechanism binding nor a documented exclusion.
3. **`node:*` is never a static value import.** `runtime/processes/` runs inside the browser bundle; a static import is externalized into a stub that throws at module load. Resolve lazily through `process.getBuiltinModule` (see `loadNodeChildProcess` in `ProcessManager.ts`). Type-only imports are fine. Enforced by the Node-builtin `no-restricted-imports` blocks in `eslint.config.js` (blanket ban under `src/`, plus an `allowTypeImports` carve-out for `runtime/processes/**`) and by `src/app/entry-import.smoke.test.ts`.
4. **Timeline geometry has one owner.** `computeTimelineExtent` in `lib/timeline-scale.ts` is the only place total width / division count is computed. `TimelineEditorCore.tsx` calls it once (default `TIMELINE_TRAILING_RUNWAY_SECONDS` = 20s of drag runway past the last clip) and feeds the result to the canvas (as `minScaleCount` = `maxScaleCount`); `TimelineCanvas.tsx` calls it with an explicit `trailingRunwaySeconds: 0` because the runway is its owner's call, reaching it through those bounds. Ruler width, grid width and scroll-content width must agree — pinned by `timeline-scale.test.ts` ("makes the canvas agree with its owner") and `TimelineEditorCore.test.tsx` ("sizes the ruler and the grid from the shared timeline extent"). A second formula is a bug.
5. **DOM tokens in §4 are load-bearing.** Spell them only through `TIMELINE_DOM` in `lib/timeline-dom.ts`; a literal anywhere else re-opens the silent-rename hole.
6. **The editor stays out of the app's edge gutters.** The app shell parks fixed `PaneControlTab`s at the four viewport edges and this is the only full-bleed page, so its chrome is the only chrome that lands under them. Desktop reserves the right and bottom bands in the shell (§5); touch (phone and tablet) carries the entry points in its own bar and the tabs step aside through `acquirePaneControlsHost` (§5). Never move or restyle the shared tabs — every other tool depends on where they are.
7. **Locally committed clip times sit on the frame grid.** `lib/time-grid.ts` owns timeline-time↔frame semantics: `rowsToConfig` (the `'rows'` commit funnel), the drag `'config'` path (`buildConfigFromDragResult`) and the resize commit all snap `at`/durations to `output.fps`'s grid, so abutting clips are frame-contiguous under the composition's `round()` math (pre-snap: ~24% one-frame gap/overlap at cuts). Remote/accepted data re-enters as configs, never as rows, and is deliberately not re-quantized. Enforced by `lib/time-grid-conformance.test.ts` (coverage-gated like the mobile-interaction suite).
8. **Shared assembly, per-host options.** Registry, extension-lifecycle, proposal-sync and process-manager *wiring* lives once in `contexts/editorRuntimeAssembly.tsx`; edit it there, not in the hosts. What must be threaded through both hosts is the **option set**: a new capability flag added to `useEditorRuntimeAssembly`/`useEditorRuntimeSync` has to be passed at both call sites (`VideoEditorProvider.tsx` and `EditorRuntimeProvider.tsx`) or app mode and embed mode drift. Duplicating wiring into a host is the bug this invariant exists to prevent.

---

## Cross-Cutting References

| Concern | See |
|---|---|
| Extension platform, SDK, trust model | `docs/video-editor/` |
| Timeline patch operations | `docs/video-editor/timeline-patch-operations.md` |
| Frontend architecture, shared hooks | `frontend_architecture.md`, `shared_utilities.md` |
| Context/state audit and fat-context gate | `docs/state_management_context_audit.md` |
| File-size and anti-pattern standards | `docs/code_quality_audit.md` |

## File downloads

Timeline export and newly completed renders use browser-managed Downloads. The render hook requests one automatic download per started render; mounting controls or opening an existing result does not replay it. Runtime media is fetched with CORS before download so the Runtime's Origin check remains intact. Browser downloads are bounded to 1 GiB, including streamed responses without Content-Length. The timeline menu and rendered-film player offer explicit **Save as…** streaming for larger files; those direct writes do not appear in browser Downloads. Sources: `lib/timeline-transfer.ts`, `lib/render-download.ts`, `hooks/useRenderState.ts`, `components/TimelineRenderControls.tsx`.
