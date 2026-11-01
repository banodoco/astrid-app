import { isGatewayUrl } from '@/integrations/runtime/connection';
import { isManagedObjectUrl } from '@astrid/packs/rendering/shared/managed-media-policy';

function isHttpGatewayUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const { protocol } = new URL(url);
    return (protocol === 'http:' || protocol === 'https:') && isGatewayUrl(url);
  } catch {
    return false;
  }
}

/**
 * `crossOrigin` attribute value for an `<img>`, `<video>` or canvas source.
 *
 * Configured HTTP(S) gateway URLs and managed object routes get `'anonymous'`:
 * the gateway authorizes media by the `Origin` header, which a cross-origin
 * element sends only in CORS mode, and it also lets the canvas stay untainted.
 * Relative object routes use the same policy through the dev proxy; other URLs
 * retain their existing media mode.
 */
export function mediaCrossOrigin(url: string | null | undefined): 'anonymous' | undefined {
  return isHttpGatewayUrl(url) || isManagedObjectUrl(url) ? 'anonymous' : undefined;
}

/** The gateway injects Runtime credentials itself and refuses browser cookies and authorization. */
export function mediaFetchCredentials(url: string, otherwise: RequestCredentials = 'same-origin'): RequestCredentials {
  return isHttpGatewayUrl(url) || isManagedObjectUrl(url) ? 'omit' : otherwise;
}
