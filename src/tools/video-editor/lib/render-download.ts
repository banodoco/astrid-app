import { downloadBlobAsFile } from '@/shared/runtime/browserDownloadRuntime.ts';

export const MAX_RENDER_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
export const LARGE_RENDER_MESSAGE = 'This render is too large for a browser download (1 GiB limit). Choose Save as… in the rendered film player to stream it directly to a file.';

/** Fetch with Origin so Runtime admission is preserved, then hand bytes to browser Downloads. */
export async function downloadRenderedFile(url: string, filename: string): Promise<void> {
  const response = await fetch(url, { mode: 'cors' });
  if (!response.ok) throw new Error(`Couldn't download the render (HTTP ${response.status})`);
  const declaredSize = Number(response.headers.get('Content-Length'));
  if (declaredSize > MAX_RENDER_DOWNLOAD_BYTES) {
    await response.body?.cancel();
    throw new Error(LARGE_RENDER_MESSAGE);
  }
  if (!response.body) throw new Error('The render response had no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RENDER_DOWNLOAD_BYTES) {
        await reader.cancel();
        throw new Error(LARGE_RENDER_MESSAGE);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  downloadBlobAsFile(new Blob(chunks as BlobPart[], {
    type: response.headers.get('Content-Type') || 'video/mp4',
  }), filename);
}
