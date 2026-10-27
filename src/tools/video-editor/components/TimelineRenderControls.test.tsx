import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimelineRenderControls } from './TimelineRenderControls';

const mocks = vi.hoisted(() => ({
  useTimelineChromeContext: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/tools/video-editor/hooks/timelineStore.ts', () => ({
  useTimelineChromeContext: mocks.useTimelineChromeContext,
}));

vi.mock('@/shared/components/ui/toast.tsx', () => ({
  toast: { error: mocks.toastError },
}));

const originalSaveFilePickerDescriptor = Object.getOwnPropertyDescriptor(window, 'showSaveFilePicker');
const originalCreateObjectURLDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevokeObjectURLDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');

function chrome(overrides: Record<string, unknown> = {}) {
  return {
    renderDestination: 'download',
    renderStatus: 'done',
    renderDirty: false,
    renderResultUrl: '/api/astrid/v1/objects/render.mp4',
    renderResultFilename: 'render.mp4',
    renderProgress: null,
    activeRenderTaskId: null,
    startRender: vi.fn(),
    cancelRender: vi.fn(),
    setRenderDestination: vi.fn(),
    ...overrides,
  };
}

describe('TimelineRenderControls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalSaveFilePickerDescriptor) {
      Object.defineProperty(window, 'showSaveFilePicker', originalSaveFilePickerDescriptor);
    } else {
      Reflect.deleteProperty(window, 'showSaveFilePicker');
    }
    if (originalCreateObjectURLDescriptor) {
      Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURLDescriptor);
    } else {
      Reflect.deleteProperty(URL, 'createObjectURL');
    }
    if (originalRevokeObjectURLDescriptor) {
      Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURLDescriptor);
    } else {
      Reflect.deleteProperty(URL, 'revokeObjectURL');
    }
  });

  it('shows the render error and lets the close button dismiss it without disabling retry', () => {
    const startRender = vi.fn();
    mocks.useTimelineChromeContext.mockReturnValue(chrome({
      renderStatus: 'error',
      renderLog: 'Render failed: encoder unavailable',
      startRender,
    }));

    render(<TimelineRenderControls previewActionButtonClass="" />);

    expect(screen.getByText('Render failed: encoder unavailable')).toBeTruthy();
    const renderButton = screen.getByRole('button', { name: 'Render' });
    fireEvent.pointerDown(renderButton);
    expect(screen.getByText('Render failed: encoder unavailable')).toBeTruthy();
    fireEvent.click(renderButton);
    expect(startRender).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(document.querySelector('[data-video-editor-render-blocker="true"]')).toBeNull();
    fireEvent.click(renderButton);
    expect(startRender).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-video-editor-render-blocker="true"]')).toBeNull();
  });

  it('exposes the full render diagnostic behind Details', () => {
    mocks.useTimelineChromeContext.mockReturnValue(chrome({ renderStatus: 'error',
      renderLog: 'Export guard: 2 errors\n[missing-resource] Source image is unavailable\n[unknown-effect] Unknown blur effect',
    }));
    render(<TimelineRenderControls previewActionButtonClass="" />);
    fireEvent.click(screen.getByText('Details'));
    expect(screen.getByText(/Source image is unavailable/)).toBeTruthy();
    expect(screen.getByText(/Unknown blur effect/)).toBeTruthy();
  });

  it('dismisses the render error on an outside pointer-down', () => {
    mocks.useTimelineChromeContext.mockReturnValue(chrome({
      renderStatus: 'error',
      renderLog: 'Render failed',
    }));

    render(<TimelineRenderControls previewActionButtonClass="" />);
    expect(document.querySelector('[data-video-editor-render-blocker="true"]')).toBeTruthy();

    fireEvent.pointerDown(document.body);
    expect(document.querySelector('[data-video-editor-render-blocker="true"]')).toBeNull();
  });

  it('dismisses on Escape and shows the same error again after a retry fails', () => {
    const error = 'Render failed: encoder unavailable';
    mocks.useTimelineChromeContext.mockReturnValue(chrome({ renderStatus: 'error', renderLog: error }));
    const { rerender } = render(<TimelineRenderControls previewActionButtonClass="" />);
    expect(screen.getByText(error)).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('[data-video-editor-render-blocker="true"]')).toBeNull();

    mocks.useTimelineChromeContext.mockReturnValue(chrome({ renderStatus: 'rendering', renderLog: null }));
    rerender(<TimelineRenderControls previewActionButtonClass="" />);
    mocks.useTimelineChromeContext.mockReturnValue(chrome({ renderStatus: 'error', renderLog: error }));
    rerender(<TimelineRenderControls previewActionButtonClass="" />);

    expect(screen.getByText(error)).toBeTruthy();
  });

  it('shows an admitted seam warning beside the controls and expands the shared boundary report', () => {
    const seamReport = {
      version: 1 as const,
      fps: 30,
      guardFrames: 2,
      boundaries: [{
        frame: 30,
        timeSeconds: 1,
        participants: [{ownerId: 'b', clipId: 'b', path: ['clip', 'b'], behavior: 'motion-start' as const}],
        structuralIssues: [],
        unacknowledgedRisk: true,
        requiresIntent: true,
      }],
      opaqueElements: [],
      structuralIssues: [],
      cues: [],
      warningCount: 1,
      blocked: false,
    };
    const startRender = vi.fn();
    mocks.useTimelineChromeContext.mockReturnValue(chrome({ visualSeamReport: seamReport, startRender }));

    render(<TimelineRenderControls previewActionButtonClass="" />);

    expect(screen.getByText('Seam warnings')).toBeTruthy();
    expect(document.querySelector('[data-video-editor-render-warning="true"]')?.className).toContain('border-amber');
    expect(document.querySelector<HTMLDetailsElement>('[data-video-editor-render-warning="true"] details')?.open).toBe(false);
    expect(screen.getByRole('button', {name: 'Render'})).not.toBeDisabled();
    fireEvent.click(screen.getByText('Seam warnings'));

    expect(document.querySelector<HTMLDetailsElement>('[data-video-editor-render-warning="true"] details')?.open).toBe(true);
    expect(screen.getByRole('region', {name: 'Visual seam admission report'})).toBeTruthy();
    expect(screen.getByText('Visual boundary report')).toBeTruthy();
    expect(screen.getByText('0:01.0 · Possible visual change at this cut')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: 'Render'}));
    expect(startRender).toHaveBeenCalledOnce();
  });

  it('dismisses seam warnings with ✕, outside click, and Escape', () => {
    const seamReport = {
      version: 1 as const,
      fps: 30,
      guardFrames: 2,
      boundaries: [{
        frame: 30,
        timeSeconds: 1,
        participants: [{ownerId: 'b', clipId: 'b', path: ['clip', 'b'], behavior: 'source-change' as const}],
        structuralIssues: [],
        unacknowledgedRisk: true,
        requiresIntent: true,
      }],
      opaqueElements: [],
      structuralIssues: [],
      cues: [],
      warningCount: 1,
      blocked: false,
    };
    mocks.useTimelineChromeContext.mockReturnValue(chrome({ visualSeamReport: null }));
    const { rerender } = render(<TimelineRenderControls previewActionButtonClass="" />);
    const renderWithReport = () => {
      mocks.useTimelineChromeContext.mockReturnValue(chrome({ visualSeamReport: seamReport }));
      rerender(<TimelineRenderControls previewActionButtonClass="" />);
    };
    const clearReport = () => {
      mocks.useTimelineChromeContext.mockReturnValue(chrome({ visualSeamReport: null }));
      rerender(<TimelineRenderControls previewActionButtonClass="" />);
    };

    renderWithReport();
    fireEvent.click(screen.getByRole('button', {name: 'Dismiss'}));
    expect(document.querySelector('[data-video-editor-render-warning="true"]')).toBeNull();

    clearReport();
    renderWithReport();
    fireEvent.pointerDown(document.body);
    expect(document.querySelector('[data-video-editor-render-warning="true"]')).toBeNull();

    clearReport();
    renderWithReport();
    fireEvent.keyDown(document, {key: 'Escape'});
    expect(document.querySelector('[data-video-editor-render-warning="true"]')).toBeNull();
  });

  it('does not auto-open the player or download for a result that already existed', () => {
    mocks.useTimelineChromeContext.mockReturnValue(chrome({
      renderResultInfo: { revision: 4, completedAt: 1000 },
    }));

    render(<TimelineRenderControls previewActionButtonClass="" />);

    expect(screen.queryByRole('combobox', { name: 'Render destination' })).toBeNull();
    expect(screen.queryByTestId('timeline-render-player')).toBeNull();
    expect(screen.queryByRole('link', { name: /Download/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Play last render/ })).toBeTruthy();
  });

  it('opens a streaming player when a render completes and reopens it from Play last render', () => {
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    mocks.useTimelineChromeContext.mockReturnValue(chrome({
      renderStatus: 'rendering', renderResultUrl: null, renderResultFilename: null, renderResultInfo: null,
    }));
    const { rerender } = render(<TimelineRenderControls previewActionButtonClass="" />);
    expect(screen.queryByTestId('timeline-render-player')).toBeNull();

    mocks.useTimelineChromeContext.mockReturnValue(chrome({
      renderResultInfo: { revision: 7, completedAt: 2000 },
    }));
    rerender(<TimelineRenderControls previewActionButtonClass="" />);

    const video = screen.getByTestId('timeline-render-player') as HTMLVideoElement;
    expect(video.getAttribute('src')).toBe('/api/astrid/v1/objects/render.mp4');
    expect(video.hasAttribute('controls')).toBe(true);
    expect(video.getAttribute('preload')).toBe('metadata');
    expect(screen.getByText(/Timeline version 7/)).toBeTruthy();
    // Download is explicit; nothing was clicked automatically.
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Download/ })).toBeNull();
    expect(anchorClick).not.toHaveBeenCalled();

    act(() => { fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }); });
    fireEvent.click(screen.getByRole('button', { name: /Play last render/ }));
    expect(screen.getByTestId('timeline-render-player')).toBeTruthy();
    anchorClick.mockRestore();
  });

  it('streams directly only when Save as is explicitly chosen', async () => {
    const writable = {} as WritableStream;
    const pipeTo = vi.fn().mockResolvedValue(undefined);
    const createWritable = vi.fn().mockResolvedValue(writable);
    let resolvePicker!: (handle: { createWritable: () => Promise<WritableStream> }) => void;
    const picker = vi.fn(() => new Promise<{ createWritable: () => Promise<WritableStream> }>((resolve) => {
      resolvePicker = resolve;
    }));
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: picker });
    const fetchRender = vi.fn().mockResolvedValue({
      ok: true,
      body: { pipeTo },
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchRender);
    mocks.useTimelineChromeContext.mockReturnValue(chrome({
      renderResultInfo: { revision: 7, completedAt: 2000 },
    }));

    render(<TimelineRenderControls previewActionButtonClass="" />);
    fireEvent.click(screen.getByRole('button', { name: /Play last render/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save as…' }));
    expect(screen.getByRole('button', { name: 'Downloading…' })).toBeDisabled();

    await act(async () => resolvePicker({ createWritable }));

    await waitFor(() => expect(pipeTo).toHaveBeenCalledWith(writable));
    expect(picker).toHaveBeenCalledWith({
      suggestedName: 'render.mp4',
      types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
    });
    expect(fetchRender).toHaveBeenCalledWith('/api/astrid/v1/objects/render.mp4', { mode: 'cors' });
    expect(createWritable).toHaveBeenCalledOnce();
  });

  it('uses browser Downloads even when the save picker is available', async () => {
    const picker = vi.fn();
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: picker });
    const fetchRender = vi.fn().mockResolvedValue(new Response('render bytes', { headers: { 'Content-Type': 'video/mp4' } }));
    const createObjectURL = vi.fn().mockReturnValue('blob:render-result');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    vi.stubGlobal('fetch', fetchRender);
    const clickedDownloads: Array<{ href: string; download: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      if (this.download) clickedDownloads.push({ href: this.href, download: this.download });
    });
    mocks.useTimelineChromeContext.mockReturnValue(chrome({
      renderResultInfo: { revision: 7, completedAt: 2000 },
    }));

    render(<TimelineRenderControls previewActionButtonClass="" />);
    fireEvent.click(screen.getByRole('button', { name: /Play last render/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));

    await waitFor(() => expect(clickedDownloads).toEqual([{ href: 'blob:render-result', download: 'render.mp4' }]));
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:render-result'), { timeout: 2000 });
    expect(fetchRender).toHaveBeenCalledWith('/api/astrid/v1/objects/render.mp4', { mode: 'cors' });
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(picker).not.toHaveBeenCalled();
  });

  it('shows an error for a failed response without saving the response body', async () => {
    const blob = vi.fn();
    const fetchRender = vi.fn().mockResolvedValue({ ok: false, status: 403, blob } as unknown as Response);
    vi.stubGlobal('fetch', fetchRender);
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    mocks.useTimelineChromeContext.mockReturnValue(chrome({
      renderResultInfo: { revision: 7, completedAt: 2000 },
    }));

    render(<TimelineRenderControls previewActionButtonClass="" />);
    fireEvent.click(screen.getByRole('button', { name: /Play last render/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("Couldn't download the render (HTTP 403)"));
    expect(blob).not.toHaveBeenCalled();
    expect(anchorClick).not.toHaveBeenCalled();
  });

  it('quietly ignores a cancelled save picker', async () => {
    const picker = vi.fn().mockRejectedValue(new DOMException('The user cancelled the picker', 'AbortError'));
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: picker });
    const fetchRender = vi.fn();
    vi.stubGlobal('fetch', fetchRender);
    mocks.useTimelineChromeContext.mockReturnValue(chrome({
      renderResultInfo: { revision: 7, completedAt: 2000 },
    }));

    render(<TimelineRenderControls previewActionButtonClass="" />);
    fireEvent.click(screen.getByRole('button', { name: /Play last render/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save as…' }));

    await waitFor(() => expect(picker).toHaveBeenCalledOnce());
    expect(fetchRender).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('keeps cancellation visible for an active render', () => {
    mocks.useTimelineChromeContext.mockReturnValue(chrome({
      renderStatus: 'rendering',
      activeRenderTaskId: 'task-1',
      renderProgress: { current: 4, total: 10, percent: 40, phase: 'render' },
    }));

    render(<TimelineRenderControls previewActionButtonClass="" />);

    expect(screen.getByRole('button', { name: 'Cancel render' })).toBeTruthy();
  });

  it('shows a structured seam report and separate eligible declaration actions', () => {
    const declareHardCuts = vi.fn();
    const acknowledgeCues = vi.fn();
    mocks.useTimelineChromeContext.mockReturnValue(chrome({
      renderStatus: 'error',
      renderLog: 'Visual seam admission blocked: boundary at frame 30 has undeclared visual cues',
      visualSeamReport: {
        version: 1,
        fps: 30,
        guardFrames: 2,
        boundaries: [{
          frame: 30,
          timeSeconds: 1,
          intent: undefined,
          participants: [{
            ownerId: 'clip-b', clipId: 'clip-b', path: ['clip', 'clip-b'], behavior: 'motion-start',
            cue: {frame: 30, kind: 'motion-start', id: 'motion', path: ['clip', 'clip-b']},
          }],
          structuralIssues: [],
          unacknowledgedRisk: true,
          requiresIntent: true,
        }],
        opaqueElements: [],
        structuralIssues: [],
        cues: [],
        warningCount: 1,
        blocked: true,
      },
      canDeclareSeamsAsHardCuts: false,
      declareSeamsAsHardCuts: declareHardCuts,
      canAcknowledgeVisualCues: true,
      acknowledgeVisualCuesAsSynchronized: acknowledgeCues,
    }));

    render(<TimelineRenderControls previewActionButtonClass="" />);

    expect(screen.getByRole('region', {name: 'Visual seam admission report'})).toBeTruthy();
    expect(screen.getByText('0:01.0 · Possible visual change at this cut')).toBeTruthy();
    expect(screen.getByText(/Frame 30 · motion-start/)).toBeTruthy();
    expect(screen.queryByRole('button', {name: 'Declare flagged boundaries as hard cuts'})).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: 'Acknowledge listed cues as synchronized'}));
    expect(acknowledgeCues).toHaveBeenCalledOnce();
    expect(declareHardCuts).not.toHaveBeenCalled();
  });

  it('offers the hard-cut declaration only when the hook marks all flagged boundaries eligible', () => {
    const declareHardCuts = vi.fn();
    mocks.useTimelineChromeContext.mockReturnValue(chrome({
      renderStatus: 'error',
      renderLog: 'Visual seam admission blocked',
      visualSeamReport: {
        version: 1, fps: 30, guardFrames: 2,
        boundaries: [{
          frame: 30, timeSeconds: 1,
          participants: [{ownerId: 'b', clipId: 'b', path: ['clip', 'b'], behavior: 'source-change'}],
          structuralIssues: [], unacknowledgedRisk: true, requiresIntent: true,
        }],
        opaqueElements: [], structuralIssues: [], cues: [], warningCount: 1, blocked: true,
      },
      canDeclareSeamsAsHardCuts: true,
      declareSeamsAsHardCuts: declareHardCuts,
      canAcknowledgeVisualCues: false,
      acknowledgeVisualCuesAsSynchronized: vi.fn(),
    }));

    render(<TimelineRenderControls previewActionButtonClass="" />);

    fireEvent.click(screen.getByRole('button', {name: 'Declare flagged boundaries as hard cuts'}));
    expect(declareHardCuts).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', {name: 'Acknowledge listed cues as synchronized'})).toBeNull();
  });
});


it('places a supplied pane control immediately after Render and before cancellation', () => {
  mocks.useTimelineChromeContext.mockReturnValue(chrome({ renderStatus: 'rendering', activeRenderTaskId: 'task-1' }));
  render(<TimelineRenderControls previewActionButtonClass="" afterRenderControl={<button aria-label="Panel display">Panel</button>} />);
  const renderButton = screen.getByRole('button', { name: 'Render' });
  const panelButton = screen.getByRole('button', { name: 'Panel display' });
  expect(renderButton).toBeDisabled();
  expect(panelButton).not.toBeDisabled();
  expect(renderButton.nextElementSibling).toBe(panelButton);
  expect(panelButton.nextElementSibling).toBe(screen.getByRole('button', { name: 'Cancel render' }));
});

it('keeps only the download icon for Render in a narrow preview row, with its name and tooltip', () => {
  mocks.useTimelineChromeContext.mockReturnValue(chrome({ renderStatus: 'idle', renderResultUrl: null }));
  const { rerender } = render(<TimelineRenderControls previewActionButtonClass="" iconOnly />);
  const iconButton = screen.getByRole('button', { name: 'Render' });
  expect(iconButton.textContent).toBe('');
  expect(iconButton.className).toContain('aspect-square');

  rerender(<TimelineRenderControls previewActionButtonClass="" />);
  const labelButton = screen.getByRole('button', { name: 'Render' });
  expect(labelButton.textContent).toBe('Render');
  expect(labelButton.className).not.toContain('aspect-square');
});
