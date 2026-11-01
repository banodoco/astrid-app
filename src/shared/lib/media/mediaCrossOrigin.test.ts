import { createElement } from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Runtime origin is module state set once per page, so each case loads fresh modules.
type Connection = typeof import('@/integrations/runtime/connection');
type MediaCrossOrigin = typeof import('./mediaCrossOrigin');
let connection: Connection;
let mediaCrossOrigin: MediaCrossOrigin['mediaCrossOrigin'];
let mediaFetchCredentials: MediaCrossOrigin['mediaFetchCredentials'];

const GATEWAY = 'http://127.0.0.1:17340';

beforeEach(async () => {
  vi.resetModules();
  connection = await import('@/integrations/runtime/connection');
  ({ mediaCrossOrigin, mediaFetchCredentials } = await import('./mediaCrossOrigin'));
});

describe('mediaCrossOrigin', () => {
  describe('with a gateway origin configured', () => {
    beforeEach(() => {
      connection.setRuntimeOrigin({ VITE_RUNTIME_ORIGIN: GATEWAY });
    });

    it('keeps gateway media fetches free of browser credentials while preserving other fetch contracts', () => {
      expect(mediaFetchCredentials(`${GATEWAY}/api/astrid/v1/objects/a`, 'include')).toBe('omit');
      expect(mediaFetchCredentials('/api/runtime/v1/objects/a', 'include')).toBe('omit');
      expect(mediaFetchCredentials('https://cloud.example/a?signature=abc', 'include')).toBe('include');
      expect(mediaFetchCredentials('https://cloud.example/a')).toBe('same-origin');
    });

    it("returns 'anonymous' for a gateway URL", () => {
      expect(mediaCrossOrigin(`${GATEWAY}/api/runtime/v1/objects/a`)).toBe('anonymous');
    });

    it.each([
      ['CDN storage', 'https://cdn.example.com/storage/v1/object/public/image_uploads/a.png'],
      ['CDN', 'https://cdn.example.com/a.png'],
      ['another loopback port', 'http://127.0.0.1:17341/a.png'],
      ['data URL', 'data:image/png;base64,AAAA'],
      ['blob URL', 'blob:https://astrid.haus/0b1c'],
      ['empty string', ''],
      ['null', null],
      ['undefined', undefined],
    ])('returns undefined for %s', (_label, url) => {
      expect(mediaCrossOrigin(url)).toBeUndefined();
    });

    it('renders crossorigin on a gateway <img> and omits it elsewhere', () => {
      const gatewaySrc = `${GATEWAY}/api/runtime/v1/objects/a`;
      const otherSrc = 'https://cdn.example.com/a.png';
      const { container } = render(
        createElement('div', null,
          createElement('img', { 'data-testid': 'gateway', alt: '', src: gatewaySrc, crossOrigin: mediaCrossOrigin(gatewaySrc) }),
          createElement('img', { 'data-testid': 'other', alt: '', src: otherSrc, crossOrigin: mediaCrossOrigin(otherSrc) }),
        ),
      );
      expect(container.querySelector('[data-testid="gateway"]')?.getAttribute('crossorigin')).toBe('anonymous');
      expect(container.querySelector('[data-testid="other"]')?.hasAttribute('crossorigin')).toBe(false);
    });
  });

  describe('same-origin build (no gateway origin)', () => {
    beforeEach(() => {
      connection.setRuntimeOrigin({});
    });

    it('recognizes managed object routes without depending on app boot configuration', () => {
      expect(mediaCrossOrigin(`${GATEWAY}/api/runtime/v1/objects/a`)).toBe('anonymous');
      expect(mediaCrossOrigin('/api/runtime/v1/objects/a')).toBe('anonymous');
    });

    it('renders a same-origin managed <img> in anonymous mode', () => {
      const src = '/api/runtime/v1/objects/a';
      const { container } = render(createElement('img', { alt: '', src, crossOrigin: mediaCrossOrigin(src) }));
      expect(container.querySelector('img')?.getAttribute('crossorigin')).toBe('anonymous');
    });

    it.each([
      'blob:http://127.0.0.1:17340/local-object-id',
      'blob:https://astrid.haus/local-object-id',
      'data:audio/wav;base64,AAAA',
      'https://signed.example/media?signature=abc',
      'custom:media-id',
      '//127.0.0.1:17340/media',
      'http://127.0.0.1:17341/media',
    ])('preserves the existing custom media mode for %s', (url) => {
      expect(mediaCrossOrigin(url)).toBeUndefined();
      expect(mediaFetchCredentials(url, 'include')).toBe('include');
    });
  });
});

describe('mediaCrossOrigin with an HTTPS gateway origin', () => {
  const HTTPS_GATEWAY = 'https://runtime.example.test';

  beforeEach(async () => {
    vi.resetModules();
    connection = await import('@/integrations/runtime/connection');
    ({ mediaCrossOrigin, mediaFetchCredentials } = await import('./mediaCrossOrigin'));
    connection.setRuntimeOrigin({ VITE_RUNTIME_ORIGIN: HTTPS_GATEWAY });
  });

  it('uses anonymous CORS and omits browser credentials for a configured HTTPS gateway URL', () => {
    const url = `${HTTPS_GATEWAY}/api/runtime/v1/objects/a/content`;
    expect(mediaCrossOrigin(url)).toBe('anonymous');
    expect(mediaFetchCredentials(url, 'include')).toBe('omit');
  });
});
