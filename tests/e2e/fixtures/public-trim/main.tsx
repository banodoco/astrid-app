import { useMemo, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AgentChatProvider, useAgentChatRegistry } from '@/shared/contexts/AgentChatContext';
import { RuntimeDataProvider } from '@/integrations/runtime/dataProvider';
import { BrowserVideoEditor } from '@/tools/video-editor/browser/BrowserVideoEditor';
import { createVideoEditorEffectCatalog } from '@/tools/video-editor/browser-provider';
import type { VideoEditorScopedServices } from '@/tools/video-editor/browser/scopedServices';
import { PUBLIC_TIMELINE_SERVICE_HOOKS } from '@/tools/video-editor/runtime/timelineHostServiceHooks';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FixtureControls } from './FixtureControls';
import '@/index.css';

const params = new URLSearchParams(window.location.search);
const projectId = params.get('project');
const timelineId = params.get('timeline');
if (!projectId || !timelineId) throw new Error('The public trim fixture requires project and timeline query parameters.');

const provider = new RuntimeDataProvider({ projectId });
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function HostServices({ children }: { children: ReactNode }) {
  const registry = useAgentChatRegistry();
  const [owner] = useState(() => Symbol('public-trim-fixture'));
  const services = useMemo<VideoEditorScopedServices>(() => ({
    contract: 'astrid.video-editor.scoped-services.v1',
    scope: { instanceId: 'public-trim-fixture', projectId, projectSlug: projectId, timelineId },
    shots: { shots: [], isLoading: false, error: null, refetchShots() {}, finalVideoMap: new Map(), dismissFinalVideo() {} },
    mediaLightbox: { Lightbox: () => null, loadGenerationForLightbox: async () => null },
    agentChat: {
      registerTimeline: (value) => registry.register({ timelineId: value.timelineId, editorContext: { tool: 'video-editor', ...value } }, owner),
      unregisterTimeline: () => registry.unregister(owner),
      activateTimeline: () => registry.activate(owner),
    },
    toast: { error: () => '', warning: () => '', success: () => '', info: () => '' },
    telemetry: { log() {}, warn() {}, error() {} },
    timelineServices: PUBLIC_TIMELINE_SERVICE_HOOKS,
  }), [owner, registry]);
  return <BrowserVideoEditor dataProvider={provider} timelineId={timelineId} effectCatalog={createVideoEditorEffectCatalog({ effects: [] })} hostServices={services}>
    {children}
  </BrowserVideoEditor>;
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <MemoryRouter>
      <AgentChatProvider>
        <HostServices><FixtureControls /></HostServices>
      </AgentChatProvider>
    </MemoryRouter>
  </QueryClientProvider>,
);
