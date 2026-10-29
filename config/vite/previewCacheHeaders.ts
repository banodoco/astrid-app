import type { Plugin } from 'vite';

const HTML_CACHE_CONTROL = 'no-cache';
const HASHED_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export function previewCacheControlForPath(pathname: string, accept = ''): string | null {
  if (pathname === '/build.json') return 'no-store';
  if (/^\/assets\/.+[-.][A-Za-z0-9_-]{8,}\.[^/]+$/.test(pathname)) {
    return HASHED_ASSET_CACHE_CONTROL;
  }
  if (pathname === '/' || pathname === '/sw.js' || pathname.endsWith('.html') || accept.includes('text/html')) {
    return HTML_CACHE_CONTROL;
  }
  return null;
}

/** Vite Preview serves the Railway bundle; override its static handler's header per request. */
export function createPreviewCacheHeadersPlugin(): Plugin {
  return {
    name: 'astrid-preview-cache-headers',
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
        const cacheControl = previewCacheControlForPath(pathname, request.headers.accept ?? '');
        if (!cacheControl) return next();
        const setHeader = response.setHeader.bind(response);
        Object.defineProperty(response, 'setHeader', {
          configurable: true,
          value: (name: string, value: string | number | readonly string[]) =>
            setHeader(name, name.toLowerCase() === 'cache-control' ? cacheControl : value),
        });
        response.setHeader('Cache-Control', cacheControl);
        next();
      });
    },
  };
}
