import { act, render, waitFor, screen, within } from '@testing-library/react';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { TooltipProvider } from '@/shared/components/ui/tooltip';
import { getEditorTourState, setEditorTourBeat } from '@/shared/state/editorTourStore';
import { finishEditorTour } from '@/tools/video-editor/tour/runner/tourBeats';
import { useTimelineEditorData, useTimelineOpsFromStoreSafe } from '@/tools/video-editor/hooks/timelineStore';
import { useVideoEditorRuntime } from '@/tools/video-editor/contexts/VideoEditorRuntimeContext';
import { TOUR_CLIP_IDS } from '@/tools/video-editor/tour/timeline/tourStages';

let captured: ReturnType<typeof useTimelineEditorData>;
let operations: ReturnType<typeof useTimelineOpsFromStoreSafe>;
let runtime: ReturnType<typeof useVideoEditorRuntime>;
// Keep the actual provider and driver operations. Browser media and layout are outside jsdom: the preview boundary
// records the real resolved composition instead.
vi.mock('@/tools/video-editor/components/PreviewPanel/RemotionPreview.tsx', () => ({ RemotionPreview: () => {
  captured = useTimelineEditorData(); operations = useTimelineOpsFromStoreSafe(); runtime = useVideoEditorRuntime();
  return <div data-testid="captured-preview" />;
} }));
vi.mock('@/tools/video-editor/components/TimelineEditor/TimelineEditorCoreBody.tsx', () => ({ TimelineEditorCoreBody: () => null }));
vi.mock('@/tools/video-editor/tour/runner/EditorTourRunner.tsx', () => ({ EditorTourRunner: () => null }));
import { BrowserTourEditor } from './BrowserTourEditor';
import { EDITOR_TOUR_MEDIA } from '@/tools/video-editor/tour/tourMedia';
const requests: string[] = [];
beforeEach(() => {
  onlineManager.setOnline(true);
  requests.length = 0;
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input); requests.push(url);
    if (!url.startsWith('/astrid/onboarding/lantern-valley-14s-v1/')) throw new Error(`Unexpected workspace request: ${url}`);
    const bytes = readFileSync(`public${url}`);
    return new Response(bytes);
  }));
});
afterEach(() => vi.unstubAllGlobals());
it('applies all three stages as ordinary media clips, with no world, extension or scene iframe', async () => {
  const onFinish = vi.fn();
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><TooltipProvider><MemoryRouter>
    <BrowserTourEditor onFinish={onFinish} />
  </MemoryRouter></TooltipProvider></QueryClientProvider>);
  const pane = screen.getByRole('complementary', { name: 'Task and chat pane' });
  expect(pane).toHaveAttribute('data-tasks-pane', 'true');
  expect(pane).toHaveAttribute('data-pane-side', 'right');
  const main = screen.getByRole('main', { name: 'Lantern Valley guided demo' });
  const header = screen.getByTestId('video-editor-header');
  expect(screen.getByTestId('global-header-slot')).toContainElement(header);
  expect(main.parentElement).toHaveAttribute('data-video-editor-route', 'true');
  expect(within(header).getAllByTestId('editor-project-timeline-selectors')).toHaveLength(1);
  expect(within(header).getAllByRole('combobox')).toHaveLength(1);
  expect(within(header).getByRole('combobox', { name: 'Select project' })).toHaveTextContent('Onboarding project');
  expect(within(header).getByRole('combobox', { name: 'Select project' })).toBeDisabled();
  expect(within(header).queryByRole('combobox', { name: 'Select timeline' })).not.toBeInTheDocument();
  expect(within(header).getByRole('button', { name: 'Project settings' })).toBeDisabled();
  expect(within(header).getByRole('button', { name: 'New project' })).toBeDisabled();
  expect(within(header).getByRole('button', { name: 'Settings' })).toBeDisabled();
  const previewNavigation = within(screen.getByTestId('video-editor-editor-navigation-controls'));
  expect(previewNavigation.getByRole('combobox', { name: 'Select timeline' })).toHaveTextContent('Lantern Valley');
  expect(previewNavigation.getByRole('combobox', { name: 'Select timeline' })).toBeDisabled();
  // The shared app content reserves the same pane width while the fixed Tasks surface stays at the right edge.
  expect(main.parentElement).toHaveStyle({ marginRight: '300px' });
  const extensionsDock = screen.getByTestId('video-editor-right-panel-dock');
  expect(extensionsDock).toHaveAttribute('data-open', 'true');
  expect(within(extensionsDock).getByRole('tab', { name: 'Inspector' })).toHaveAttribute('aria-selected', 'true');
  const chat = pane.querySelector('[data-tasks-pane-chat]')!;
  expect(within(pane).getByRole('textbox')).toHaveAttribute('readonly');
  expect(chat.querySelector('[data-editor-tour="chat-composer"]')).not.toBeNull();
  expect(chat.querySelector('[data-editor-tour="chat-transcript"]')).not.toBeNull();
  expect(chat.querySelector('[data-editor-tour="chat-send"]')).not.toBeNull();
  expect(document.querySelectorAll('[data-editor-tour="chat-composer"]')).toHaveLength(1);
  await waitFor(() => expect(operations).toBeTruthy());
  act(() => setEditorTourBeat(1, 'land', true));
  await waitFor(() => expect(captured.resolvedConfig?.clips.some(clip => clip.id === TOUR_CLIP_IDS.scene)).toBe(true));
  // Step 1 is the bundled guide video: a plain muted media clip, nothing for an extension to render.
  const guide = captured.resolvedConfig!.clips.find(clip => clip.id === TOUR_CLIP_IDS.scene)!;
  expect(guide).toMatchObject({ clipType: 'media', asset: 'tour-guide', from: 0, to: 14, volume: 0, label: 'Lantern Valley Three.js visualization' });
  expect(guide.app).toBeUndefined();
  expect(captured.resolvedConfig!.clips.some(clip => clip.clipType === 'haus.astrid.liveScene')).toBe(false);
  // The right panel stays on the Inspector and shows no World Explorer.
  expect(within(extensionsDock).getByRole('tab', { name: 'Inspector' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.queryByRole('region', { name: 'World Explorer' })).not.toBeInTheDocument();
  expect(document.querySelector('iframe')).toBeNull();
  expect(runtime.provider.persistenceEnabled).toBe(false);
  expect(runtime.livePermissionService).toBeUndefined();
  act(() => setEditorTourBeat(2, 'land', true));
  await waitFor(() => expect(captured.resolvedConfig?.clips.filter(clip => (
    TOUR_CLIP_IDS.stills.includes(clip.id as typeof TOUR_CLIP_IDS.stills[number]) && clip.clipType === 'hold'
  ))).toHaveLength(4));
  act(() => setEditorTourBeat(3, 'land', true));
  await waitFor(() => expect(captured.resolvedConfig?.clips.some(clip => clip.id === TOUR_CLIP_IDS.video && clip.clipType === 'media')).toBe(true));
  expect(requests.every(url => url.startsWith('/astrid/onboarding/'))).toBe(true);
  expect(requests.some(url => url.endsWith('.json'))).toBe(false);
  expect(document.querySelector('iframe')).toBeNull();
  expect(EDITOR_TOUR_MEDIA.video).toBeTruthy();
  // The runner's visual interaction is outside this fixture; the real finish operation must
  // still invoke the callback registered by BrowserTourEditor and stop the tour exactly once.
  expect(onFinish).not.toHaveBeenCalled();
  act(() => finishEditorTour());
  expect(onFinish).toHaveBeenCalledOnce();
  expect(getEditorTourState().status).toBe('idle');
  act(() => finishEditorTour());
  expect(onFinish).toHaveBeenCalledOnce();
});
