import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadRenderedFile, LARGE_RENDER_MESSAGE, MAX_RENDER_DOWNLOAD_BYTES } from './render-download.ts';

const download = vi.hoisted(() => vi.fn());
vi.mock('@/shared/runtime/browserDownloadRuntime.ts', () => ({ downloadBlobAsFile: download }));
beforeEach(() => download.mockClear());
afterEach(() => vi.unstubAllGlobals());

describe('render browser downloads', () => {
  it('fetches with CORS and downloads the complete MP4 with its filename', async () => {
    const fetcher = vi.fn(async () => new Response('film', { headers: { 'Content-Type': 'video/mp4' } }));
    vi.stubGlobal('fetch', fetcher);
    await downloadRenderedFile('/objects/film', 'my-film.mp4');
    expect(fetcher).toHaveBeenCalledWith('/objects/film', { mode: 'cors' });
    expect(download).toHaveBeenCalledOnce();
    const [blob, name] = download.mock.calls[0];
    expect(name).toBe('my-film.mp4');
    expect(blob.size).toBe(4);
    expect(blob.type).toBe('video/mp4');
  });

  it('rejects a declared oversized response before reading bytes and cancels it', async () => {
    const cancel = vi.fn();
    const getReader = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true,
      headers: new Headers({ 'Content-Length': String(MAX_RENDER_DOWNLOAD_BYTES + 1) }),
      body: { cancel, getReader },
    })));
    await expect(downloadRenderedFile('/film', 'film.mp4')).rejects.toThrow(LARGE_RENDER_MESSAGE);
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(download).not.toHaveBeenCalled();
  });

  it('enforces the byte limit even without a trustworthy Content-Length', async () => {
    // Reuse a chunk to exercise streaming accounting without allocating a GiB.
    const chunk = new Uint8Array(16 * 1024 * 1024);
    const cancel = vi.fn();
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      pull(controller) { reads += 1; controller.enqueue(chunk); }, cancel,
    }))));
    await expect(downloadRenderedFile('/film', 'film.mp4')).rejects.toThrow(LARGE_RENDER_MESSAGE);
    expect(reads).toBeLessThanOrEqual(66);
    expect(cancel).toHaveBeenCalledOnce();
    expect(download).not.toHaveBeenCalled();
  });

  it('never downloads an error body and permits an explicit retry', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('denied', { status: 403 }))
      .mockResolvedValueOnce(new Response('film')));
    await expect(downloadRenderedFile('/film', 'film.mp4')).rejects.toThrow('HTTP 403');
    expect(download).not.toHaveBeenCalled();
    await downloadRenderedFile('/film', 'film.mp4');
    expect(download).toHaveBeenCalledOnce();
  });
});
