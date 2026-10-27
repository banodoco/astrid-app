import { createRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelFullscreenFrame } from './PanelFullscreenFrame';

afterEach(cleanup);

function renderFrame(onExit = vi.fn()) {
  const bodyRef = createRef<HTMLDivElement>();
  const utils = render(<PanelFullscreenFrame ref={bodyRef} title="World Explorer" onExit={onExit} />);
  return { ...utils, bodyRef, onExit };
}

describe('PanelFullscreenFrame', () => {
  it('is a modal dialog covering the window, with a header naming the panel', () => {
    renderFrame();
    const dialog = screen.getByRole('dialog', { name: 'World Explorer' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('data-panel-fullscreen-frame');
    expect(dialog.className).toContain('fixed');
    expect(dialog.className).toContain('inset-0');
    expect(dialog.parentElement).toBe(document.body);
    expect(screen.getByText('World Explorer')).toBeInTheDocument();
  });

  it('has no drag, resize or fill controls', () => {
    renderFrame();
    expect(document.querySelector('[data-panel-fullscreen-handle]')).toBeNull();
    expect(screen.queryByRole('button', { name: /fill|restore/i })).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('exits from the Back to sidebar button', () => {
    const { onExit } = renderFrame();
    fireEvent.click(screen.getByRole('button', { name: 'Back to sidebar' }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('exits on Escape, but not when a panel already consumed it', () => {
    const { onExit } = renderFrame();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onExit).toHaveBeenCalledTimes(1);

    const consumer = (event: KeyboardEvent) => event.preventDefault();
    window.addEventListener('keydown', consumer, true);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    window.removeEventListener('keydown', consumer, true);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('focuses the [data-autofocus] element once the host fills the body', async () => {
    const { bodyRef } = renderFrame();
    const input = document.createElement('input');
    input.setAttribute('data-autofocus', '');
    bodyRef.current!.append(input);
    await vi.waitFor(() => expect(document.activeElement).toBe(input));
  });

  it('keeps Tab inside the frame', () => {
    const { bodyRef } = renderFrame();
    const input = document.createElement('input');
    bodyRef.current!.append(input);
    const exit = screen.getByRole('button', { name: 'Back to sidebar' });
    // jsdom has no layout, so the visibility filter keeps the active element only.
    input.focus();
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    expect([input, exit]).toContain(document.activeElement);
  });

  it('locks page scroll while open and restores it on unmount', () => {
    document.body.style.overflow = 'auto';
    const { unmount } = renderFrame();
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('auto');
    document.body.style.overflow = '';
  });
});

describe('PanelFullscreenFrame inside the editor shell', () => {
  it('keeps a desktop-width panel in the shell and leaves chat reachable', async () => {
    vi.resetModules();
    const previousWidth = window.innerWidth;
    window.innerWidth = 1440;
    const shell = document.createElement('div');
    document.body.append(shell);
    const chat = document.createElement('textarea');
    document.body.append(chat);
    document.body.style.overflow = 'auto';
    vi.doMock('@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx', () => ({
      useOptionalVideoEditorRuntime: () => ({ shellRootRef: { current: shell } }),
    }));
    vi.doMock('@/shared/hooks/mobile', () => ({
      useIsMobile: () => window.innerWidth < 768,
      useIsTablet: () => window.innerWidth >= 768 && window.innerWidth < 1200,
    }));
    vi.doMock('@/shared/state/paneControlsHost', () => ({ usePaneControlsHosted: () => false }));
    const { PanelFullscreenFrame: Frame } = await import('./PanelFullscreenFrame');
    const onExit = vi.fn();
    const view = render(<Frame title="World Explorer" onExit={onExit} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.parentElement).toBe(shell);
    expect(dialog.className).toContain('absolute');
    expect(dialog).toHaveAttribute('aria-modal', 'false');
    expect(document.body.style.overflow).toBe('auto');

    chat.focus();
    fireEvent.keyDown(chat, { key: 'Escape' });
    expect(onExit).not.toHaveBeenCalled();
    fireEvent.keyDown(shell, { key: 'Escape' });
    expect(onExit).toHaveBeenCalledTimes(1);
    view.unmount();
    vi.doUnmock('@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx');
    vi.doUnmock('@/shared/hooks/mobile');
    vi.doUnmock('@/shared/state/paneControlsHost');
    shell.remove();
    chat.remove();
    document.body.style.overflow = '';
    window.innerWidth = previousWidth;
  });

  it('uses the window host on phone width and keeps focus and scrolling modal', async () => {
    vi.resetModules();
    const previousWidth = window.innerWidth;
    window.innerWidth = 390;
    const shell = document.createElement('div');
    document.body.append(shell);
    const chat = document.createElement('textarea');
    document.body.append(chat);
    document.body.style.overflow = 'auto';
    vi.doMock('@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx', () => ({
      useOptionalVideoEditorRuntime: () => ({ shellRootRef: { current: shell } }),
    }));
    vi.doMock('@/shared/hooks/mobile', () => ({
      useIsMobile: () => window.innerWidth < 768,
      useIsTablet: () => window.innerWidth >= 768 && window.innerWidth < 1200,
    }));
    vi.doMock('@/shared/state/paneControlsHost', () => ({ usePaneControlsHosted: () => false }));
    const { PanelFullscreenFrame: Frame } = await import('./PanelFullscreenFrame');
    const onExit = vi.fn();
    const bodyRef = createRef<HTMLDivElement>();
    const view = render(<Frame ref={bodyRef} title="World Explorer" onExit={onExit} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog.className).toContain('fixed');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(document.body.style.overflow).toBe('hidden');

    const input = document.createElement('input');
    bodyRef.current!.append(input);
    const back = screen.getByRole('button', { name: 'Back to sidebar' });
    Object.defineProperty(back, 'offsetParent', { configurable: true, value: document.body });
    Object.defineProperty(input, 'offsetParent', { configurable: true, value: document.body });
    input.focus();
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(document.activeElement).toBe(back);

    chat.focus();
    fireEvent.keyDown(chat, { key: 'Escape' });
    expect(onExit).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(document.body.style.overflow).toBe('auto');
    vi.doUnmock('@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx');
    vi.doUnmock('@/shared/hooks/mobile');
    vi.doUnmock('@/shared/state/paneControlsHost');
    shell.remove();
    chat.remove();
    document.body.style.overflow = '';
    window.innerWidth = previousWidth;
  });

  it('uses the window host when the page hosts pane controls on desktop', async () => {
    vi.resetModules();
    const previousWidth = window.innerWidth;
    window.innerWidth = 1440;
    const shell = document.createElement('div');
    document.body.append(shell);
    document.body.style.overflow = 'auto';
    vi.doMock('@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx', () => ({
      useOptionalVideoEditorRuntime: () => ({ shellRootRef: { current: shell } }),
    }));
    vi.doMock('@/shared/hooks/mobile', () => ({
      useIsMobile: () => false,
      useIsTablet: () => false,
    }));
    vi.doMock('@/shared/state/paneControlsHost', () => ({ usePaneControlsHosted: () => true }));
    const { PanelFullscreenFrame: Frame } = await import('./PanelFullscreenFrame');
    const view = render(<Frame title="World Explorer" onExit={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog.className).toContain('fixed');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(document.body.style.overflow).toBe('hidden');
    view.unmount();
    expect(document.body.style.overflow).toBe('auto');
    vi.doUnmock('@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx');
    vi.doUnmock('@/shared/hooks/mobile');
    vi.doUnmock('@/shared/state/paneControlsHost');
    shell.remove();
    document.body.style.overflow = '';
    window.innerWidth = previousWidth;
  });
});
