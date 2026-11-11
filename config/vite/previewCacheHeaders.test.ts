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

  it('caches the SHA-named onboarding release files immutably, but not their manifest', () => {
    const release = '/astrid/onboarding/lantern-valley-14s-v1/';
    const digest = '092858dd90f66b0db88233f7ed93aa4aa27c2d064308237f53696ba11e2c518d';
    for (const extension of ['mp4', 'webp', 'png', 'json']) {
      expect(previewCacheControlForPath(`${release}${digest}.${extension}`)).toBe('public, max-age=31536000, immutable');
    }
    // Media elements may ask with any Accept header.
    expect(previewCacheControlForPath(`${release}${digest}.mp4`, 'text/html,*/*')).toBe('public, max-age=31536000, immutable');
    expect(previewCacheControlForPath(`${release}manifest.json`)).toBeNull();
    expect(previewCacheControlForPath(`${release}${digest.slice(1)}.mp4`)).toBeNull();
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
