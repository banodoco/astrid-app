import { describe, expect, it, vi } from 'vitest';
import { createPreviewCacheHeadersPlugin, previewCacheControlForPath } from './previewCacheHeaders';

describe('hosted preview cache headers', () => {
  it('keeps HTML routes fresh and caches hashed assets immutably', () => {
    expect(previewCacheControlForPath('/')).toBe('no-cache');
    expect(previewCacheControlForPath('/tools/video-editor', 'text/html')).toBe('no-cache');
    expect(previewCacheControlForPath('/index.html')).toBe('no-cache');
    expect(previewCacheControlForPath('/build.json')).toBe('no-store');
    expect(previewCacheControlForPath('/assets/index-Dx9ab12Z.js'))
      .toBe('public, max-age=31536000, immutable');
    expect(previewCacheControlForPath('/assets/logo.svg')).toBeNull();
  });

  it('sets the request-specific header before Vite Preview serves a response', () => {
    const use = vi.fn();
    const plugin = createPreviewCacheHeadersPlugin();
    plugin.configurePreviewServer?.({ middlewares: { use } } as never);
    const middleware = use.mock.calls[0]?.[0] as (
      request: { url: string; headers: { accept: string } },
      response: { setHeader(name: string, value: string | number | readonly string[]): unknown },
      next: () => void,
    ) => void;
    const headers = new Map<string, string | number | readonly string[]>();
    const response = { setHeader: (name: string, value: string | number | readonly string[]) => headers.set(name, value) };
    const next = vi.fn();

    middleware({ url: '/tools/video-editor', headers: { accept: 'text/html' } }, response, next);
    response.setHeader('Cache-Control', 'public, max-age=0');
    expect(headers.get('Cache-Control')).toBe('no-cache');
    expect(next).toHaveBeenCalledOnce();
  });

  it('leaves non-HTML proxy responses under their existing cache policy', () => {
    const use = vi.fn();
    const plugin = createPreviewCacheHeadersPlugin();
    plugin.configurePreviewServer?.({ middlewares: { use } } as never);
    const middleware = use.mock.calls[0]?.[0] as (
      request: { url: string; headers: { accept: string } },
      response: { setHeader: (name: string, value: string) => void },
      next: () => void,
    ) => void;
    const setHeader = vi.fn();
    const next = vi.fn();
    middleware({ url: '/api/runtime', headers: { accept: 'application/json' } }, { setHeader }, next);
    expect(setHeader).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});
