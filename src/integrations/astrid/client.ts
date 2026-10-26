/**
 * `AstridLocalClient` — the browser-side client for `astrid serve`'s
 * task, gallery and media routes.
 *
 * It shares ONLY the wire contract (`bridgeContract.ts`) and the transport
 * pipeline (`transport.ts`) with the other bridge consumers: no base class,
 * no abstraction layer. It also exposes the timeline
 * CAS routes so document-native placement works on surfaces
 * outside the editor page; the provider keeps owning editor-session CAS
 * (cached-payload merges, local materialization). The composition point
 * stays `useVideoEditorProviderSelection` (VideoEditorPage).
 */

import { AstridLocalObjectRoutes } from './objectRoutes.ts';
import { AstridLocalCatalogRoutes } from './catalogRoutes.ts';
import { AstridBridgeTransport } from './transport.ts';
import { AstridLocalTaskRoutes } from './taskRoutes.ts';
import { AstridLocalGalleryRoutes } from './galleryRoutes.ts';
import { AstridLocalMediaRoutes } from './mediaRoutes.ts';
import { AstridLocalTimelineRoutes } from './timelineRoutes.ts';
import { AstridLocalProjectRoutes } from './projectRoutes.ts';
import { AstridLocalAcpRoutes } from './acpRoutes.ts';

export type AstridLocalClientOptions = {
  projectSlug: string;
  /** Same-origin base; must travel the per-boot-token-injecting proxy. */
  baseUrl?: string;
  /** Default request deadline. ACP prompt completion has no elapsed-time deadline. */
  timeoutMs?: number;
};

export class AstridLocalClient {
  readonly projects: AstridLocalProjectRoutes;
  readonly objects: AstridLocalObjectRoutes;
  readonly catalog: AstridLocalCatalogRoutes;
  readonly tasks: AstridLocalTaskRoutes;
  readonly gallery: AstridLocalGalleryRoutes;
  readonly media: AstridLocalMediaRoutes;
  readonly timelines: AstridLocalTimelineRoutes;
  readonly acp: AstridLocalAcpRoutes;

  private readonly transport: AstridBridgeTransport;

  constructor(options: AstridLocalClientOptions) {
    this.transport = new AstridBridgeTransport({ baseUrl: options.baseUrl, timeoutMs: options.timeoutMs });
    this.projects = new AstridLocalProjectRoutes(this.transport);
    this.objects = new AstridLocalObjectRoutes(this.transport, options.projectSlug);
    this.catalog = new AstridLocalCatalogRoutes(this.transport);
    const scope = { projectSlug: options.projectSlug };
    this.tasks = new AstridLocalTaskRoutes(this.transport, scope);
    this.gallery = new AstridLocalGalleryRoutes(this.transport, scope);
    this.media = new AstridLocalMediaRoutes(this.transport, scope);
    this.timelines = new AstridLocalTimelineRoutes(this.transport, scope);
    this.acp = new AstridLocalAcpRoutes(this.transport);
  }
}
