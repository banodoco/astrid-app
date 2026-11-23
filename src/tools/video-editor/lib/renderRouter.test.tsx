// render-button router tests.
// Mirrors the sprint brief's three cases (pure media, themed, mixed) +
// the orchestrator dispatch shape.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildRenderTimelinePayload,
  cancelAstridRenderTask,
  decideRenderRoute,
  enqueueAstridRuntimeRenderTimeline,
  normalizeRuntimeVisualSeamReport,
} from '@/tools/video-editor/lib/renderRouter';
import { executeRenderPipeline } from '@/tools/video-editor/render/renderPipeline';
import { AstridLocalClient } from '@/integrations/astrid/client.ts';
import { BridgeRouteError } from '@/integrations/astrid/transport.ts';
import { createFakeRuntimeRouter } from '@/test/fakeRuntimeRouter.ts';

const RENDER_CAPABILITY_ID = 'rendering.render';
const RENDER_CAPABILITY_DIGEST = `sha256:${'d'.repeat(64)}`;

const renderCapabilityPage = () => ({
  items: [{
    capability_id: RENDER_CAPABILITY_ID,
    definition_digest: RENDER_CAPABILITY_DIGEST,
    status: 'ready',
    required_resource_keys: [],
    estimated_scratch_bytes: 17,
    estimated_output_bytes: 4096,
  }],
  next_cursor: null,
});

function renderTaskMutationResponse(
  taskId: string,
  body: Record<string, unknown>,
  idempotencyKey = 'astrid.render:test',
) {
  const now = '2026-09-12T00:00:00Z';
  const data = {
    task_id: taskId,
    run_id: 'run-render-42',
    project_id: body.project,
    state: 'queued',
    version: 1,
    capability_id: body.capability_id,
    capability_digest: body.capability_digest,
    schema_version: '1',
    input_object_ids: body.input_object_ids,
    spec: {
      schema_version: '1',
      capability_digest: body.capability_digest,
      input_object_ids: body.input_object_ids,
      spec: body.spec,
    },
    idempotency_key: idempotencyKey,
    created_at: now,
    updated_at: now,
    attempt_id: null,
    runtime_epoch: 1,
  };
  return {
    data,
    receipt: {
      receipt_id: 'receipt-render-42',
      command_kind: 'task.create',
      idempotency_key: idempotencyKey,
      request_hash: `sha256:${'e'.repeat(64)}`,
      project_id: body.project,
      project_seq: [1, 1],
      event_ids: [],
      result: { task_id: taskId },
      created_at: now,
    },
  };
}

function canonicalRenderFetch(taskId = 'task-42') {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    // The default client reaches `/api/astrid` (same-origin) or the door's origin + `/api/astrid`.
    if (!url.pathname.startsWith('/v1/') && !url.pathname.startsWith('/api/astrid/')) {
      throw new Error(`render fixture request outside the Astrid bridge: ${url.pathname}`);
    }
    url.pathname = url.pathname.replace(/^\/api\/astrid/, '');
    if (url.pathname === '/v1/capabilities') {
      return new Response(JSON.stringify(renderCapabilityPage()), { status: 200 });
    }
    if (url.pathname === '/v1/tasks' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const headers = init.headers as Record<string, string>;
      return new Response(
        JSON.stringify(renderTaskMutationResponse(taskId, body, headers['Idempotency-Key'])),
        { status: 201 },
      );
    }
    throw new Error(`unexpected render fixture request: ${url.pathname}`);
  });
}

describe('Sprint 8 render-button router (decideRenderRoute)', () => {
  it('routes a pure-media timeline to the client renderer', () => {
    const decision = decideRenderRoute({
      clips: [
        { clipType: 'media' },
        { clipType: 'text' },
        { clipType: 'effect-layer' },
      ],
    });
    expect(decision.route).toBe('browser-remotion');
    expect(decision.hasThemedClip).toBe(false);
    expect(decision.hasMediaClip).toBe(true);
    expect(decision.reason).toBe('pure_native_clips');
  });

  it('routes a themed-only timeline to banodoco_render_timeline', () => {
    const decision = decideRenderRoute({
      clips: [{ clipType: 'image-jump' }],
    });
    expect(decision.route).toBe('worker-astrid-runtime');
    expect(decision.hasThemedClip).toBe(true);
    expect(decision.hasMediaClip).toBe(false);
    expect(decision.reason).toBe('themed_only');
    expect(decision.planner.selectedPlannerRoute).toBe('worker-export');
    expect(decision.planner.plannerResult.canBrowserExport).toBe(false);
    expect(decision.planner.plannerResult.canWorkerExport).toBe(true);
  });

  it('routes managed shot authoring clips through Runtime worker expansion', () => {
    const decision = decideRenderRoute({
      clips: [{ clipType: 'shot' }],
    });

    expect(decision.route).toBe('worker-astrid-runtime');
    expect(decision.hasThemedClip).toBe(true);
    expect(decision.hasMediaClip).toBe(false);
    expect(decision.reason).toBe('themed_only');
    expect(decision.planner.selectedPlannerRoute).toBe('worker-export');
    expect(decision.planner.plannerResult.canBrowserExport).toBe(false);
    expect(decision.planner.plannerResult.canWorkerExport).toBe(true);
  });

  it('routes Astrid pack effect clips through the Runtime worker path', () => {
    const decision = decideRenderRoute({
      clips: [{ clipType: 'scrolling-guide' }],
    });

    expect(decision.route).toBe('worker-astrid-runtime');
    expect(decision.hasThemedClip).toBe(true);
    expect(decision.hasMediaClip).toBe(false);
    expect(decision.reason).toBe('themed_only');
    expect(decision.planner.selectedPlannerRoute).toBe('worker-export');
    expect(decision.planner.plannerResult.canBrowserExport).toBe(false);
    expect(decision.planner.plannerResult.canWorkerExport).toBe(true);
  });

  it('routes locally-registered title-card timelines to banodoco_render_timeline', () => {
    const decision = decideRenderRoute({
      clips: [{ clipType: 'title-card' }],
    });
    expect(decision.route).toBe('worker-astrid-runtime');
    expect(decision.hasThemedClip).toBe(true);
    expect(decision.hasMediaClip).toBe(false);
    expect(decision.reason).toBe('themed_only');
  });

  it('routes a mixed themed+media timeline to banodoco_render_timeline', () => {
    const decision = decideRenderRoute({
      clips: [
        { clipType: 'media' },
        { clipType: 'image-jump' },
      ],
    });
    expect(decision.route).toBe('worker-astrid-runtime');
    expect(decision.hasThemedClip).toBe(true);
    expect(decision.hasMediaClip).toBe(true);
    expect(decision.reason).toBe('mixed_themed_and_media');
  });

  it('routes mixed local-sequence and media timelines to banodoco_render_timeline', () => {
    const decision = decideRenderRoute({
      clips: [
        { clipType: 'media' },
        { clipType: 'title-card' },
      ],
    });
    expect(decision.route).toBe('worker-astrid-runtime');
    expect(decision.hasThemedClip).toBe(true);
    expect(decision.hasMediaClip).toBe(true);
    expect(decision.reason).toBe('mixed_themed_and_media');
  });

  it('treats legacy clips with undefined clipType as native media', () => {
    const decision = decideRenderRoute({
      clips: [{}, { clipType: undefined }],
    });
    expect(decision.route).toBe('browser-remotion');
    expect(decision.hasThemedClip).toBe(false);
    expect(decision.hasMediaClip).toBe(true);
  });

  it('treats unknown clipTypes as media (loud-placeholder fallback path)', () => {
    const decision = decideRenderRoute({
      clips: [{ clipType: 'theme-package-not-yet-installed' }],
    });
    expect(decision.route).toBe('browser-remotion');
    expect(decision.hasThemedClip).toBe(false);
  });

  it('keeps the first-party audio-reactive colour effect on the browser export path', () => {
    const decision = decideRenderRoute({
      clips: [{ clipType: 'audio-reactive-colour' }],
    });
    expect(decision).toMatchObject({
      route: 'browser-remotion',
      hasThemedClip: false,
      hasMediaClip: true,
      reason: 'pure_native_clips',
    });
  });

  it('routes valid remotion_module clips by lane metadata before clipType fallback', () => {
    const decision = decideRenderRoute({
      clips: [{
        clipType: 'generated-clip-type-not-installed',
        generation: {
          sequence_lane: 'remotion_module',
          artifact_id: 'artifact-1',
        },
      }],
    });

    expect(decision.route).toBe('worker-astrid-runtime');
    expect(decision.reason).toBe('generated_remotion_module');
  });

  it('routes registered theme clipTypes as generated modules when the module lane is present', () => {
    const decision = decideRenderRoute({
      clips: [{
        clipType: 'art-card',
        generation: {
          sequence_lane: 'remotion_module',
          artifact_id: 'artifact-1',
        },
      }],
    });

    expect(decision.route).toBe('worker-astrid-runtime');
    expect(decision.reason).toBe('generated_remotion_module');
  });

  it('routes mixed valid remotion_module timelines to the worker route with a generated reason', () => {
    const decision = decideRenderRoute({
      clips: [
        { clipType: 'media' },
        {
          clipType: 'image-jump',
          generation: {
            sequence_lane: 'remotion_module',
            artifact_id: 'artifact-1',
          },
        },
      ],
    });

    expect(decision.route).toBe('worker-astrid-runtime');
    expect(decision.reason).toBe('mixed_generated_module_and_other');
    expect(decision.hasMediaClip).toBe(true);
  });

  it('blocks remotion_module clips with missing, empty, or non-string artifact ids', () => {
    const missingArtifact = decideRenderRoute({
      clips: [{ clipType: 'media', generation: { sequence_lane: 'remotion_module' } }],
    });
    expect(missingArtifact).toMatchObject({
      route: 'preview-only',
      reason: 'remotion_module_missing_artifact',
    });
    // Nothing in this plan targets sidecar-export, so `canSidecarExport`
    // is only vacuously true and the planner falls through to preview
    // rather than hijacking the render onto an unimplemented provider.
    expect(missingArtifact.planner.selectedPlannerRoute).toBe('preview');
    expect(missingArtifact.planner.plannerResult.canBrowserExport).toBe(false);
    expect(missingArtifact.planner.plannerResult.canWorkerExport).toBe(false);
    expect(missingArtifact.planner.plannerResult.canSidecarExport).toBe(true);

    expect(decideRenderRoute({
      clips: [{ clipType: 'image-jump', generation: { sequence_lane: 'remotion_module', artifact_id: '' } }],
    })).toMatchObject({
      route: 'preview-only',
      reason: 'remotion_module_invalid_artifact',
    });

    expect(decideRenderRoute({
      clips: [{ clipType: 'unknown', generation: { sequence_lane: 'remotion_module', artifact_id: 42 } }],
    })).toMatchObject({
      route: 'preview-only',
      reason: 'remotion_module_invalid_artifact',
    });
  });

  it('does not treat non-module generation lanes as generated Remotion modules', () => {
    for (const sequence_lane of ['trusted_v1', 'schema_sequence', 'unknown_lane', null, undefined]) {
      expect(decideRenderRoute({
        clips: [{
          clipType: 'media',
          generation: { sequence_lane, artifact_id: 'artifact-1' },
        }],
      })).toMatchObject({
        route: 'browser-remotion',
        reason: 'pure_native_clips',
      });
    }
  });

  it('returns no_clips for an empty timeline', () => {
    expect(decideRenderRoute({ clips: [] }).reason).toBe('no_clips');
    expect(decideRenderRoute(null).reason).toBe('no_clips');
    expect(decideRenderRoute(undefined).reason).toBe('no_clips');
  });
});

// ---------------------------------------------------------------------------
// Sidecar-export planner / router selection
// ---------------------------------------------------------------------------

describe('M7b T2 sidecar-export route selection', () => {
  it('does not select sidecar-export when nothing in the plan targets that route', () => {
    // Blocked remotion_module blocks browser + worker but not sidecar —
    // and sidecar is unblocked only because no requirement, output format,
    // process requirement or artifact profile ever named it. A vacuously
    // unblocked route is not a render candidate.
    const decision = decideRenderRoute({
      clips: [{ clipType: 'media', generation: { sequence_lane: 'remotion_module' } }],
    });
    expect(decision.planner.selectedPlannerRoute).toBe('preview');
    expect(decision.planner.plannerResult.canBrowserExport).toBe(false);
    expect(decision.planner.plannerResult.canWorkerExport).toBe(false);
    expect(decision.planner.plannerResult.canSidecarExport).toBe(true);
    const sidecarPlan = decision.planner.plannerResult.routePlans
      .find((plan) => plan.route === 'sidecar-export');
    expect(sidecarPlan?.requiredCapabilities).toEqual([]);
    expect(sidecarPlan?.outputFormatIds).toEqual([]);
    expect(sidecarPlan?.processRequirements).toEqual([]);
    // Clip-level block still forces preview-only for the UI route.
    expect(decision.route).toBe('preview-only');
  });

  it('does not select sidecar-export when browser is available (priority order)', () => {
    const decision = decideRenderRoute({
      clips: [{ clipType: 'media' }],
    });
    // Browser is available, so it should be selected over sidecar.
    expect(decision.planner.selectedPlannerRoute).toBe('browser-export');
    expect(decision.planner.plannerResult.canBrowserExport).toBe(true);
    expect(decision.planner.plannerResult.canSidecarExport).toBe(true);
    expect(decision.route).toBe('browser-remotion');
  });

  it('falls back to preview when all routes including sidecar are blocked', () => {
    // Use a process with blockers that target all export routes including sidecar.
    // When every export route is blocked, the planner selects preview.
    const decision = decideRenderRoute(
      { clips: [{ clipType: 'media' }] },
      undefined,
      {
        processes: [{
          id: 'blocker-process-contrib',
          extensionId: 'ext.blocker',
          processId: 'blocker-process',
          label: 'All-routes blocker',
          spec: {
            id: 'blocker-process',
            label: 'All-routes blocker',
            protocol: 'stdio-jsonrpc',
            spawn: { command: 'node', args: ['blocker.js'] },
            operations: [{
              id: 'blockAll',
              label: 'Block all',
              routes: ['browser-export', 'worker-export', 'sidecar-export'],
            }],
          },
          protocol: 'stdio-jsonrpc',
          operations: [{
            id: 'blockAll',
            label: 'Block all',
            routes: ['browser-export', 'worker-export', 'sidecar-export'],
          }],
          availableRoutes: ['browser-export', 'worker-export', 'sidecar-export'],
          requiredBy: [],
          blockers: [
            {
              id: 'blocker.browser',
              route: 'browser-export',
              reason: 'process-dependent',
              message: 'Browser export blocked by test process.',
            },
            {
              id: 'blocker.worker',
              route: 'worker-export',
              reason: 'process-dependent',
              message: 'Worker export blocked by test process.',
            },
            {
              id: 'blocker.sidecar',
              route: 'sidecar-export',
              reason: 'process-dependent',
              message: 'Sidecar export blocked by test process.',
            },
          ],
          nextActions: [],
        }],
        processStatuses: [{
          processId: 'blocker-process',
          status: 'ready',
          operations: {},
        }],
      },
    );
    expect(decision.planner.plannerResult.canBrowserExport).toBe(false);
    expect(decision.planner.plannerResult.canWorkerExport).toBe(false);
    expect(decision.planner.plannerResult.canSidecarExport).toBe(false);
    expect(decision.planner.selectedPlannerRoute).toBe('preview');
    // Native media clips → browser-remotion is the clip logic fallback,
    // but when all routes are blocked, the planner context shows preview.
    expect(decision.route).toBe('browser-remotion');
  });

  it('keeps native clips on browser-remotion when browser/worker are blocked and nothing demands sidecar', () => {
    // The blocking process only ever declares browser-export and
    // worker-export. sidecar-export is therefore unblocked purely by
    // vacancy, and must not hijack the decision onto `external` — the
    // planner's own blockers (browser/worker) are what the user needs to
    // see, not "no external render provider is registered".
    const decision = decideRenderRoute(
      { clips: [{ clipType: 'media' }] },
      undefined,
      {
        processes: [{
          id: 'browser-worker-blocker-contrib',
          extensionId: 'ext.bwblocker',
          processId: 'bw-blocker-process',
          label: 'Browser + worker blocker',
          spec: {
            id: 'bw-blocker-process',
            label: 'Browser + worker blocker',
            protocol: 'stdio-jsonrpc',
            spawn: { command: 'node', args: ['bw-blocker.js'] },
            operations: [{
              id: 'blockBW',
              label: 'Block browser + worker',
              routes: ['browser-export', 'worker-export'],
            }],
          },
          protocol: 'stdio-jsonrpc',
          operations: [{
            id: 'blockBW',
            label: 'Block browser + worker',
            routes: ['browser-export', 'worker-export'],
          }],
          availableRoutes: ['browser-export', 'worker-export'],
          requiredBy: [],
          blockers: [
            {
              id: 'blocker.browser',
              route: 'browser-export',
              reason: 'process-dependent',
              message: 'Browser export blocked.',
            },
            {
              id: 'blocker.worker',
              route: 'worker-export',
              reason: 'process-dependent',
              message: 'Worker export blocked.',
            },
          ],
          nextActions: [],
        }],
        processStatuses: [{
          processId: 'bw-blocker-process',
          status: 'ready',
          operations: {},
        }],
      },
    );
    expect(decision.planner.plannerResult.canBrowserExport).toBe(false);
    expect(decision.planner.plannerResult.canWorkerExport).toBe(false);
    expect(decision.planner.plannerResult.canSidecarExport).toBe(true);
    expect(decision.planner.selectedPlannerRoute).toBe('preview');
    expect(decision.route).toBe('browser-remotion');
    expect(decision.reason).toBe('pure_native_clips');
    // The blockers the user must act on stay addressable on the decision.
    expect(decision.planner.plannerResult.blockers.map((blocker) => blocker.route))
      .toEqual(['browser-export', 'worker-export']);
  });

  it('maps sidecar-export planner route to external when the plan genuinely demands sidecar-export', () => {
    // Same blocked browser/worker shape, but here a registered process
    // declares sidecar-export, so the sidecar route plan carries real
    // demand (a required capability) and selecting it is honest.
    const decision = decideRenderRoute(
      { clips: [{ clipType: 'media' }] },
      undefined,
      {
        processes: [{
          id: 'sidecar-process-contrib',
          extensionId: 'ext.sidecar',
          processId: 'sidecar-process',
          label: 'Sidecar exporter',
          spec: {
            id: 'sidecar-process',
            label: 'Sidecar exporter',
            protocol: 'stdio-jsonrpc',
            spawn: { command: 'node', args: ['sidecar.js'] },
            operations: [{
              id: 'exportSidecar',
              label: 'Export sidecar',
              routes: ['browser-export', 'worker-export', 'sidecar-export'],
            }],
          },
          protocol: 'stdio-jsonrpc',
          operations: [{
            id: 'exportSidecar',
            label: 'Export sidecar',
            routes: ['browser-export', 'worker-export', 'sidecar-export'],
          }],
          availableRoutes: ['browser-export', 'worker-export', 'sidecar-export'],
          requiredBy: [],
          blockers: [
            {
              id: 'blocker.browser',
              route: 'browser-export',
              reason: 'process-dependent',
              message: 'Browser export blocked.',
            },
            {
              id: 'blocker.worker',
              route: 'worker-export',
              reason: 'process-dependent',
              message: 'Worker export blocked.',
            },
          ],
          nextActions: [],
        }],
        processStatuses: [{
          processId: 'sidecar-process',
          status: 'ready',
          operations: {},
        }],
      },
    );
    const sidecarPlan = decision.planner.plannerResult.routePlans
      .find((plan) => plan.route === 'sidecar-export');
    expect(sidecarPlan?.blocked).toBe(false);
    expect(sidecarPlan?.requiredCapabilities.length).toBeGreaterThan(0);
    expect(decision.planner.selectedPlannerRoute).toBe('sidecar-export');
    expect(decision.route).toBe('external');
    expect(decision.reason).toBe('pure_native_clips');
  });

  it('blocked sidecar-export does not prevent browser export selection', () => {
    // When browser is available and sidecar is blocked, browser should
    // still be selected. This verifies that a blocked sidecar route
    // leaves unrelated browser/worker/preview choices unaffected.
    const decision = decideRenderRoute({
      clips: [{ clipType: 'media' }],
    });
    // With native media, browser is available and should be selected.
    expect(decision.planner.selectedPlannerRoute).toBe('browser-export');
    expect(decision.planner.plannerResult.canBrowserExport).toBe(true);
    expect(decision.route).toBe('browser-remotion');
    // sidecar status does not affect the browser route selection.
    expect(decision.planner.plannerResult.canSidecarExport).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regression: vacuous route unblocking must never select a route
// ---------------------------------------------------------------------------

describe('planner route selection never rides a vacuously unblocked route', () => {
  // `RenderRoutePlan.blocked` answers "does any blocker name this route?".
  // For a route nothing in the plan targets the answer is always "no", so
  // `canSidecarExport` (and any future `can*Export`) reads true for an empty
  // plan. Selecting on that alone routes the render at a provider the
  // timeline never asked for — historically `external`, which is a
  // registered stub with no implementation. The invariant below is the
  // class-level guard: whatever route the planner selects, that route plan
  // must carry demand.
  const timelines: ReadonlyArray<{
    readonly label: string;
    readonly timeline: Parameters<typeof decideRenderRoute>[0];
  }> = [
    { label: 'pure native media', timeline: { clips: [{ clipType: 'media' }] } },
    { label: 'themed only', timeline: { clips: [{ clipType: 'image-jump' }] } },
    {
      label: 'valid generated module',
      timeline: {
        clips: [{
          clipType: 'media',
          generation: { sequence_lane: 'remotion_module', artifact_id: 'artifact-1' },
        }],
      },
    },
    {
      label: 'blocked generated module',
      timeline: {
        clips: [{ clipType: 'media', generation: { sequence_lane: 'remotion_module' } }],
      },
    },
    { label: 'empty timeline', timeline: { clips: [] } },
  ];

  it.each(timelines)('$label — a delegated planner route carries demand', ({ timeline }) => {
    const decision = decideRenderRoute(timeline);
    const { selectedPlannerRoute, plannerResult } = decision.planner;
    // `preview` and `browser-export` are the host's own routes: falling back
    // to them with an empty plan renders in-browser, which is always
    // available. `worker-export` and `sidecar-export` delegate outside the
    // host, so they may only be selected on real demand.
    if (selectedPlannerRoute === 'preview' || selectedPlannerRoute === 'browser-export') return;
    const plan = plannerResult.routePlans.find((candidate) => candidate.route === selectedPlannerRoute);
    expect(plan).toBeDefined();
    const demand = (plan?.requiredCapabilities.length ?? 0)
      + (plan?.outputFormatIds.length ?? 0)
      + (plan?.processRequirements.length ?? 0)
      + (plan?.artifactCompletion.requiredProfiles.length ?? 0);
    expect(demand).toBeGreaterThan(0);
  });

  it('never returns the unimplemented external provider for a plan with no sidecar demand', () => {
    for (const { timeline } of timelines) {
      const decision = decideRenderRoute(timeline);
      const sidecarPlan = decision.planner.plannerResult.routePlans
        .find((plan) => plan.route === 'sidecar-export');
      // Every fixture above leaves sidecar-export empty…
      expect(sidecarPlan?.requiredCapabilities).toEqual([]);
      expect(sidecarPlan?.blocked).toBe(false);
      // …and none of them may therefore route to `external`.
      expect(decision.planner.selectedPlannerRoute).not.toBe('sidecar-export');
      expect(decision.route).not.toBe('external');
    }
  });
});

// ---------------------------------------------------------------------------
// Contributed clip routing via dynamic capability records
// ---------------------------------------------------------------------------

function makeContributedRecord(
  clipTypeId: string,
  capabilities: Array<{ route: string; status: string }>,
) {
  return {
    clipTypeId,
    renderability: {
      capabilities: capabilities.map((c) => ({
        route: c.route,
        status: c.status,
        determinism: 'deterministic' as const,
      })),
      determinism: 'deterministic' as const,
    },
  };
}

const browserCapableRecord = makeContributedRecord('ext-glow', [
  { route: 'browser-export', status: 'supported' },
  { route: 'preview', status: 'supported' },
]);

const previewOnlyRecord = makeContributedRecord('ext-preview-only', [
  { route: 'preview', status: 'supported' },
  { route: 'browser-export', status: 'blocked' },
]);

const workerOnlyRecord = makeContributedRecord('ext-worker-only', [
  { route: 'worker-export', status: 'supported' },
  { route: 'preview', status: 'supported' },
]);

const noCapabilitiesRecord = makeContributedRecord('ext-no-caps', []);

describe('M9 T11 contributed clip routing (decideRenderRoute)', () => {
  it('routes a browser-capable contributed clip to browser-remotion', () => {
    const decision = decideRenderRoute(
      { clips: [{ clipType: 'ext-glow' }] },
      [browserCapableRecord],
    );
    expect(decision.route).toBe('browser-remotion');
    expect(decision.hasContributedClip).toBe(true);
    expect(decision.hasThemedClip).toBe(false);
    expect(decision.reason).toBe('browser_capable_contributed');
  });

  it('routes mixed browser-capable contributed + native clips to browser-remotion', () => {
    const decision = decideRenderRoute(
      {
        clips: [
          { clipType: 'ext-glow' },
          { clipType: 'media' },
        ],
      },
      [browserCapableRecord],
    );
    expect(decision.route).toBe('browser-remotion');
    expect(decision.hasContributedClip).toBe(true);
    expect(decision.hasMediaClip).toBe(true);
    expect(decision.reason).toBe('mixed_browser_capable_contributed_and_native');
  });

  it('blocks a contributed clip without browser-export capability (preview-only route)', () => {
    const decision = decideRenderRoute(
      { clips: [{ clipType: 'ext-preview-only' }] },
      [previewOnlyRecord],
    );
    expect(decision.route).toBe('preview-only');
    expect(decision.hasContributedClip).toBe(true);
    expect(decision.reason).toBe('contributed_blocked_no_browser_capability');
  });

  it('blocks a contributed clip with only worker-export capability (worker routes blocked for contributed code)', () => {
    const decision = decideRenderRoute(
      { clips: [{ clipType: 'ext-worker-only' }] },
      [workerOnlyRecord],
    );
    expect(decision.route).toBe('preview-only');
    expect(decision.hasContributedClip).toBe(true);
    expect(decision.reason).toBe('contributed_blocked_no_browser_capability');
  });

  it('blocks a contributed clip with no capabilities at all', () => {
    const decision = decideRenderRoute(
      { clips: [{ clipType: 'ext-no-caps' }] },
      [noCapabilitiesRecord],
    );
    expect(decision.route).toBe('preview-only');
    expect(decision.hasContributedClip).toBe(true);
    expect(decision.reason).toBe('contributed_blocked_no_browser_capability');
  });

  it('blocks mixed contributed (browser-capable) + themed clips due to worker route conflict', () => {
    const decision = decideRenderRoute(
      {
        clips: [
          { clipType: 'ext-glow' },
          { clipType: 'image-jump' },
        ],
      },
      [browserCapableRecord],
    );
    expect(decision.route).toBe('preview-only');
    expect(decision.hasContributedClip).toBe(true);
    expect(decision.hasThemedClip).toBe(true);
    expect(decision.reason).toBe('contributed_blocked_worker_route_conflict');
  });

  it('blocks contributed clip mixed with generated remotion module due to worker route conflict', () => {
    const decision = decideRenderRoute(
      {
        clips: [
          { clipType: 'ext-glow' },
          {
            clipType: 'image-jump',
            generation: {
              sequence_lane: 'remotion_module',
              artifact_id: 'artifact-1',
            },
          },
        ],
      },
      [browserCapableRecord],
    );
    expect(decision.route).toBe('preview-only');
    expect(decision.hasContributedClip).toBe(true);
    expect(decision.reason).toBe('contributed_blocked_worker_route_conflict');
  });

  it('multiple browser-capable contributed clips all route to browser-remotion', () => {
    const record2 = makeContributedRecord('ext-glow-2', [
      { route: 'browser-export', status: 'supported' },
    ]);
    const decision = decideRenderRoute(
      {
        clips: [
          { clipType: 'ext-glow' },
          { clipType: 'ext-glow-2' },
        ],
      },
      [browserCapableRecord, record2],
    );
    expect(decision.route).toBe('browser-remotion');
    expect(decision.hasContributedClip).toBe(true);
    expect(decision.reason).toBe('browser_capable_contributed');
  });

  it('existing themed routing is unchanged when contributed records are empty', () => {
    const decision = decideRenderRoute(
      { clips: [{ clipType: 'image-jump' }] },
      [],
    );
    expect(decision.route).toBe('worker-astrid-runtime');
    expect(decision.hasThemedClip).toBe(true);
    expect(decision.hasContributedClip).toBe(false);
    expect(decision.reason).toBe('themed_only');
  });

  it('existing native routing is unchanged when contributed records are empty', () => {
    const decision = decideRenderRoute(
      { clips: [{ clipType: 'media' }] },
      [],
    );
    expect(decision.route).toBe('browser-remotion');
    expect(decision.hasContributedClip).toBe(false);
    expect(decision.reason).toBe('pure_native_clips');
  });

  it('existing native routing is unchanged when contributed records are undefined', () => {
    const decision = decideRenderRoute(
      { clips: [{ clipType: 'media' }] },
      undefined,
    );
    expect(decision.route).toBe('browser-remotion');
    expect(decision.hasContributedClip).toBe(false);
    expect(decision.reason).toBe('pure_native_clips');
  });

  it('a contributed record for an unrelated clipType does not affect themed routing', () => {
    const decision = decideRenderRoute(
      { clips: [{ clipType: 'title-card' }] },
      [browserCapableRecord], // ext-glow record, not title-card
    );
    expect(decision.route).toBe('worker-astrid-runtime');
    expect(decision.hasContributedClip).toBe(false);
    expect(decision.hasThemedClip).toBe(true);
    expect(decision.reason).toBe('themed_only');
  });

  it('blocks the first contributed clip without browser capability even when mixed with native clips', () => {
    const decision = decideRenderRoute(
      {
        clips: [
          { clipType: 'media' },
          { clipType: 'ext-preview-only' },
        ],
      },
      [previewOnlyRecord],
    );
    expect(decision.route).toBe('preview-only');
    expect(decision.hasContributedClip).toBe(true);
    expect(decision.reason).toBe('contributed_blocked_no_browser_capability');
  });

  it('no_clips decision reports hasContributedClip false', () => {
    const decision = decideRenderRoute({ clips: [] }, [browserCapableRecord]);
    expect(decision.route).toBe('browser-remotion');
    expect(decision.hasContributedClip).toBe(false);
    expect(decision.reason).toBe('no_clips');
  });

  it('blocked remotion_module short-circuits before contributed record lookup', () => {
    const decision = decideRenderRoute(
      {
        clips: [{
          clipType: 'ext-glow',
          generation: { sequence_lane: 'remotion_module' },
        }],
      },
      [browserCapableRecord], // ext-glow is browser-capable but the module is blocked
    );
    expect(decision.route).toBe('preview-only');
    expect(decision.reason).toBe('remotion_module_missing_artifact');
  });
});

describe('Sprint 8 buildRenderTimelinePayload', () => {
  const baseInput = {
    request: {
      timelineId: '11111111-1111-1111-1111-111111111111',
      assetRegistry: { assets: { a: { url: 'https://cdn/a.mp4' } } },
      resolvedConfig: {
        theme: '2rp',
        clips: [{ clipType: 'art-card' }],
      },
      renderMetadata: null,
      renderRuntime: {
        projectId: '22222222-2222-2222-2222-222222222222',
      },
    },
    correlationId: '33333333-3333-3333-3333-333333333333',
  };

  it('does not block worker admission for an enforced canonical seam with undeclared cues', () => {
    const { payload, error } = buildRenderTimelinePayload({
      ...baseInput,
      request: {
        ...baseInput.request,
        resolvedConfig: {
          output: { resolution: '1920x1080', fps: 30, file: 'unsafe.mp4' },
          tracks: [
            { id: 'video', kind: 'visual', label: 'Picture' },
            { id: 'fx', kind: 'visual', label: 'FX' },
          ],
          clips: [
            { id: 'a', clipType: 'media', track: 'video', at: 0, hold: 2, asset: 'a' },
            { id: 'b', clipType: 'media', track: 'video', at: 2, hold: 2, asset: 'b' },
            {
              id: 'fx',
              clipType: 'custom-fx',
              track: 'fx',
              at: 2,
              hold: 1,
              elementRef: { id: 'fx', kind: 'effect', revision: 'r1' },
            },
          ],
          registry: {
            a: { file: 'a.mp4', media_id: `sha256:${'a'.repeat(64)}`, type: 'video/mp4' },
            b: { file: 'b.mp4', media_id: `sha256:${'b'.repeat(64)}`, type: 'video/mp4' },
          },
          app: { visualSeamContract: { mode: 'enforced' } },
        },
      },
    });
    expect(error).toBeUndefined();
    expect(payload).toBeDefined();
    expect(payload?.timeline.clips).toHaveLength(3);
  });

  it('produces the SD-034-shaped payload from valid input', () => {
    const { payload, error } = buildRenderTimelinePayload(baseInput);
    expect(error).toBeUndefined();
    expect(payload).toBeDefined();
    expect(payload!.timeline_id).toBe(baseInput.request.timelineId);
    expect(payload!.project_id).toBe(baseInput.request.renderRuntime.projectId);
    expect(payload!.correlation_id).toBe(baseInput.correlationId);
    expect(payload!.theme_id).toBe('2rp');
    expect(payload!.output_filename).toContain(baseInput.request.timelineId);
  });

  it('includes editor pack revisions only when supplied by the build', () => {
    const revisions = { local: 'abc123', astrid_motion: 'abc123' };
    try {
      vi.stubGlobal('__ASTRID_EDITOR_PACK_REVISIONS__', revisions);
      expect(buildRenderTimelinePayload(baseInput).payload?.editor_pack_revisions).toEqual(revisions);
      vi.stubGlobal('__ASTRID_EDITOR_PACK_REVISIONS__', null);
      expect(buildRenderTimelinePayload(baseInput).payload).not.toHaveProperty('editor_pack_revisions');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('filters Source tracks from managed payloads and rejects source-only export', () => {
    const resolvedConfig = {
      output: { resolution: '1920x1080', fps: 30, file: 'source-output.mp4' },
      tracks: [
        { id: 'source', kind: 'visual' as const, label: 'Interview', role: 'source' as const },
        { id: 'output', kind: 'visual' as const, label: 'Cut' },
      ],
      clips: [
        { id: 'source-clip', clipType: 'media', track: 'source', at: 0, hold: 90, asset: 'missing-source' },
        { id: 'output-clip', clipType: 'media', track: 'output', at: 0, hold: 10, asset: 'output-asset' },
      ],
      registry: {
        'output-asset': { file: 'output.mp4', media_id: `sha256:${'a'.repeat(64)}`, type: 'video/mp4' },
      },
    };
    const { payload, error } = buildRenderTimelinePayload({
      ...baseInput,
      request: {
        ...baseInput.request,
        assetRegistry: {
          assets: {
            'missing-source': { file: 'interview.mp4' },
            'output-asset': { file: 'cut.mp4' },
          },
        },
        resolvedConfig,
      },
    });
    expect(error).toBeUndefined();
    const projectedTimeline = payload?.timeline as typeof resolvedConfig | undefined;
    expect(projectedTimeline?.clips).toEqual([
      expect.objectContaining({ id: 'output-clip', track: 'output' }),
    ]);
    expect(projectedTimeline?.clips).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'source-clip' }),
    ]));
    expect((payload?.assets as { assets?: Record<string, unknown> }).assets).not.toHaveProperty('missing-source');
    expect((payload?.assets as { assets?: Record<string, unknown> }).assets).toHaveProperty('output-asset');

    const sourceOnly = buildRenderTimelinePayload({
      ...baseInput,
      request: {
        ...baseInput.request,
        resolvedConfig: {
          ...resolvedConfig,
          tracks: [{ id: 'source', kind: 'visual' as const, label: 'Interview', role: 'source' as const }],
          clips: [resolvedConfig.clips[0]],
        },
      },
    });
    expect(sourceOnly.payload).toBeUndefined();
    expect(sourceOnly.error).toContain('no output content');
  });

  it('exports only Output tracks and omits source-only assets from the payload', () => {
    const outputId = `sha256:${'a'.repeat(64)}`;
    const sourceId = `sha256:${'b'.repeat(64)}`;
    const request = {
      ...baseInput.request,
      assetRegistry: { assets: { 'output-asset': { file: 'output.png' }, 'source-asset': { file: 'source.png' } } },
      resolvedConfig: {
        theme: '2rp',
        output: { resolution: '1920x1080', fps: 30, file: 'fixture.mp4' },
        tracks: [
          { id: 'output', kind: 'visual', label: 'Output' },
          { id: 'source', kind: 'visual', label: 'Source', role: 'source' },
        ],
        clips: [
          { id: 'kept', clipType: 'image-jump', track: 'output', at: 0, hold: 2, asset: 'output-asset' },
          { id: 'excluded', clipType: 'image-jump', track: 'source', at: 0, hold: 90, asset: 'source-asset' },
        ],
        registry: {
          'output-asset': { file: 'output.png', media_id: outputId },
          'source-asset': { file: 'source.png', media_id: sourceId },
        },
      },
    };

    const { payload, error } = buildRenderTimelinePayload({ ...baseInput, request });
    expect(error).toBeUndefined();
    expect((payload!.timeline as { clips: Array<{ id: string }> }).clips.map((clip) => clip.id)).toContain('kept');
    expect((payload!.timeline as { clips: Array<{ id: string }> }).clips.map((clip) => clip.id)).not.toContain('excluded');
    expect(payload!.input_object_ids).toEqual([outputId]);
    expect((payload!.assets as { assets: Record<string, unknown> }).assets).not.toHaveProperty('source-asset');
  });

  it('refuses a source-only export with a clear message', () => {
    const { payload, error } = buildRenderTimelinePayload({
      ...baseInput,
      request: {
        ...baseInput.request,
        resolvedConfig: {
          output: { resolution: '1920x1080', fps: 30, file: 'fixture.mp4' },
          tracks: [{ id: 'source', kind: 'visual', label: 'Source', role: 'source' }],
          clips: [{ id: 'reference', clipType: 'image-jump', track: 'source', at: 0, hold: 2 }],
          registry: {},
        },
      },
    });
    expect(payload).toBeUndefined();
    expect(error).toContain('no output content');
  });

  it('keeps explicit caller-owned request inputs for local fixture renders', () => {
    const request = {
      ...baseInput.request,
      timelineId: 'fixture-local-timeline',
      assetRegistry: {
        assets: {
          'fixture-video': {
            file: 'fixtures/local.mp4',
            src: 'file:///tmp/fixtures/local.mp4',
            type: 'video/mp4',
          },
        },
      },
      resolvedConfig: {
        theme: '2rp',
        output: { resolution: '1920x1080', fps: 30, file: 'fixture.mp4' },
        tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
        clips: [{ id: 'clip-fixture', clipType: 'image-jump', track: 'V1', at: 0, hold: 2 }],
        registry: {
          'fixture-video': {
            file: 'fixtures/local.mp4',
            src: 'file:///tmp/fixtures/local.mp4',
            type: 'video/mp4',
          },
        },
      },
    };

    const { payload, error } = buildRenderTimelinePayload({
      ...baseInput,
      request,
      correlationId: 'fixture-correlation',
    });

    expect(error).toBeUndefined();
    expect(payload).toBeDefined();
    expect(payload!.timeline_id).toBe('fixture-local-timeline');
    expect(payload!.project_id).toBe(request.renderRuntime.projectId);
    expect(payload!.correlation_id).toBe('fixture-correlation');
    expect(payload!.assets).toBe(request.assetRegistry);
  });

  it('falls back to 2rp theme when config has no theme field', () => {
    const { payload } = buildRenderTimelinePayload({
      ...baseInput,
      request: {
        ...baseInput.request,
        resolvedConfig: { clips: [{ clipType: 'art-card' }] },
      },
    });
    expect(payload!.theme_id).toBe('2rp');
  });

  it('carries no legacy auth fields for local Astrid admission', () => {
    const { payload, error } = buildRenderTimelinePayload(baseInput);
    expect(payload).toBeDefined();
    expect(error).toBeUndefined();
    expect(payload).not.toHaveProperty('user_jwt');
  });

  it('rejects empty timelineId / projectId', () => {
    expect(buildRenderTimelinePayload({
      ...baseInput,
      request: {
        ...baseInput.request,
        timelineId: '',
      },
    }).error).toBeTruthy();
    expect(buildRenderTimelinePayload({
      ...baseInput,
      request: {
        ...baseInput.request,
        renderRuntime: {
          ...baseInput.request.renderRuntime,
          projectId: '',
        },
      },
    }).error).toBeTruthy();
  });

  it('materializes sequence asset keys for the render payload without mutating persisted params', () => {
    const resolvedConfig = {
      theme: '2rp',
      output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
      tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
      clips: [
        {
          id: 'clip-resource',
          clipType: 'resource-card',
          track: 'V1',
          at: 0,
          hold: 3,
          params: {
            title: 'Resource',
            previewAssetKeys: ['asset-a'],
          },
        },
      ],
      registry: {
        'asset-a': {
          file: 'asset-a.png',
          src: 'https://cdn.example.com/asset-a.png',
          type: 'image',
        },
      },
    };

    const { payload } = buildRenderTimelinePayload({
      ...baseInput,
      request: {
        ...baseInput.request,
        resolvedConfig,
      },
    });

    const clip = (payload!.timeline as typeof resolvedConfig).clips[0];
    expect(clip.params).toMatchObject({
      previewAssetKeys: ['asset-a'],
      previews: ['https://cdn.example.com/asset-a.png'],
    });
    expect(resolvedConfig.clips[0].params).toEqual({
      title: 'Resource',
      previewAssetKeys: ['asset-a'],
    });
  });

  it('authorizes only referenced managed inputs and ignores unrelated registry entries', () => {
    const resolvedConfig = {
      ...baseInput.request.resolvedConfig,
      clips: [{ id: 'clip-a', asset: 'asset-a', clipType: 'media' }],
      registry: {
        'asset-a': { media_id: `sha256:${'a'.repeat(64)}` },
        'unreferenced-invalid': { file: '/tmp/retired.mp4' },
      },
    };

    const { payload, error } = buildRenderTimelinePayload({
      ...baseInput,
      request: { ...baseInput.request, resolvedConfig },
    });

    expect(error).toBeUndefined();
    expect(payload?.input_object_ids).toEqual([`sha256:${'a'.repeat(64)}`]);
  });

  it('refuses a referenced managed input with no Runtime identity', () => {
    const { payload, error } = buildRenderTimelinePayload({
      ...baseInput,
      request: {
        ...baseInput.request,
        resolvedConfig: {
          ...baseInput.request.resolvedConfig,
          clips: [{ id: 'clip-a', asset: 'asset-a', clipType: 'media' }],
          registry: { 'asset-a': { file: 'retired.mp4' } },
        },
      },
    });

    expect(payload).toBeUndefined();
    expect(error).toContain('asset-a has no Runtime-managed object identity');
  });

  it('refuses conflicting media_id and content_sha256 identities for a referenced input', () => {
    const { payload, error } = buildRenderTimelinePayload({
      ...baseInput,
      request: {
        ...baseInput.request,
        resolvedConfig: {
          ...baseInput.request.resolvedConfig,
          clips: [{ id: 'clip-a', asset: 'asset-a', clipType: 'media' }],
          registry: {
            'asset-a': {
              media_id: `sha256:${'a'.repeat(64)}`,
              content_sha256: `sha256:${'b'.repeat(64)}`,
            },
          },
        },
      },
    });

    expect(payload).toBeUndefined();
    expect(error).toContain('asset-a media_id and content_sha256 identities do not match');
  });
});

describe('Sprint 8 enqueueAstridRuntimeRenderTimeline', () => {
  const payload = {
    timeline_id: 't',
    timeline: { clips: [] },
    assets: { assets: {} },
    theme_id: '2rp',
    output_filename: 'render.mp4',
    project_id: 'p',
    correlation_id: 'c',
  };

  it('forwards editor pack revisions to task params only when present', async () => {
    const revisions = { local: 'abc123', astrid_motion: 'abc123' };
    const fetchImpl = canonicalRenderFetch();
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const client = new AstridLocalClient({ projectSlug: 'p', baseUrl: 'http://bridge.fake' });
      expect((await enqueueAstridRuntimeRenderTimeline({ ...payload, editor_pack_revisions: revisions }, { client })).status).toBe('queued');
      const withRevisions = JSON.parse((fetchImpl.mock.calls[1][1] as RequestInit).body as string);
      expect(withRevisions.spec.params.editor_pack_revisions).toEqual(revisions);
      expect((await enqueueAstridRuntimeRenderTimeline(payload, { client })).status).toBe('queued');
      const withoutRevisions = JSON.parse((fetchImpl.mock.calls[3][1] as RequestInit).body as string);
      expect(withoutRevisions.spec.params).not.toHaveProperty('editor_pack_revisions');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  describe.each([
    ['same-origin (dev:local)', {}, '/api/astrid'],
    ['hosted (Runtime door)', { VITE_RUNTIME_ORIGIN: 'http://127.0.0.1:17340' }, 'http://127.0.0.1:17340/api/astrid'],
  ])('render admission on %s', (_name, env, astridPrefix) => {
    it('lists capabilities and admits the task under /api/astrid, never the provider /api/runtime base', async () => {
      vi.resetModules();
      const { setRuntimeOrigin } = await import('@/integrations/runtime/connection.ts');
      setRuntimeOrigin(env);
      const router = await import('@/tools/video-editor/lib/renderRouter');
      const fetchImpl = canonicalRenderFetch();
      vi.stubGlobal('fetch', fetchImpl);
      const result = await router.enqueueAstridRuntimeRenderTimeline(payload, {});
      expect(result.status).toBe('queued');
      const urls = fetchImpl.mock.calls.map(([input]) => String(input instanceof Request ? input.url : input));
      expect(urls.length).toBeGreaterThanOrEqual(2);
      for (const url of urls) {
        expect(url.startsWith(`${astridPrefix}/v1/`)).toBe(true);
        expect(url).not.toContain('/api/runtime');
      }
      expect(urls[0].startsWith(`${astridPrefix}/v1/capabilities`)).toBe(true);
      expect(urls.some((url) => url.startsWith(`${astridPrefix}/v1/tasks`))).toBe(true);
      vi.unstubAllGlobals();
    });
  });

  it('selects the existing Three.js route for saved scenes with ordinary audio', async () => {
    const fetchImpl = canonicalRenderFetch();
    vi.stubGlobal('fetch', fetchImpl);
    const scenePayload = { ...payload, timeline: { tracks: [{ id: 'v', kind: 'visual' }, { id: 'a', kind: 'audio' }], clips: [{ clipType: 'haus.astrid.liveScene', track: 'v' }, { clipType: 'media', track: 'a' }] } };
    const result = await enqueueAstridRuntimeRenderTimeline(scenePayload, { client: new AstridLocalClient({ projectSlug: 'p', baseUrl: 'http://bridge.fake' }) });
    expect(result.status).toBe('queued');
    const body = JSON.parse((fetchImpl.mock.calls[1][1] as RequestInit).body as string);
    expect(body.spec.params).toMatchObject({ selector: 'rendering.threejs', timeline_ref: 't' });
    expect(body.spec.params).not.toHaveProperty('expected_version');
    expect(body.input_object_ids).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('rejects unsupported mixed scene clips before task admission', async () => {
    const fetchImpl = canonicalRenderFetch();
    vi.stubGlobal('fetch', fetchImpl);
    const result = await enqueueAstridRuntimeRenderTimeline({ ...payload, timeline: { clips: [{ clipType: 'haus.astrid.liveScene' }, { clipType: 'media' }] } }, { client: new AstridLocalClient({ projectSlug: 'p', baseUrl: 'http://bridge.fake' }) });
    expect(result.status).toBe('error');
    expect(result.message).toContain('mixed or unsupported');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('preserves a Runtime seam report from admission error details', async () => {
    const seamReport = {
      version: 1,
      fps: 30,
      guardFrames: 2,
      boundaries: [{
        frame: 30,
        ownerPaths: [['parent', 'main', 'occurrence', 'occ-1', 'clip', 'b']],
        cues: [{frame: 30, kind: 'motion-start', id: 'move', path: ['parent', 'main', 'occurrence', 'occ-1', 'clip', 'b']}],
        opaquePaths: [['parent', 'main', 'occurrence', 'occ-2', 'clip', 'plate']],
        requiresIntent: true,
      }],
      opaqueElements: [{
        span: {path: ['parent', 'main', 'occurrence', 'occ-2', 'clip', 'plate'], startFrame: 27, endFrame: 33},
        opaque: ['unsupported-timing'],
        source: 'fixture',
      }],
      structuralIssues: [{code: 'picture_gap', track: 'picture', frame: 30, message: 'picture gap at seam'}],
      blocked: true,
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === '/v1/capabilities') return new Response(JSON.stringify(renderCapabilityPage()), { status: 200 });
      if (url.pathname === '/v1/tasks' && init?.method === 'POST') {
        return new Response(JSON.stringify({
          code: 'visual_seam_admission_blocked',
          message: 'Visual seam admission blocked',
          details: { report: seamReport },
          request_id: 'req-seam',
        }), { status: 422 });
      }
      throw new Error(`unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);

    const result = await enqueueAstridRuntimeRenderTimeline(payload, {
      client: new AstridLocalClient({ projectSlug: 'p', baseUrl: 'http://bridge.fake' }),
    });

    expect(result.status).toBe('error');
    expect(result.seamReport).toMatchObject({
      blocked: true,
      warningCount: 1,
      structuralIssues: ['0:01.0 · Gap in the full-screen picture'],
      boundaries: [{
        frame: 30,
        timeSeconds: 1,
        requiresIntent: true,
        unacknowledgedRisk: true,
        participants: expect.arrayContaining([
          expect.objectContaining({clipId: 'b', ownerId: 'occ-1', behavior: 'motion-start'}),
          expect.objectContaining({clipId: 'plate', ownerId: 'occ-2', behavior: 'opaque'}),
        ]),
      }],
      opaqueElements: [expect.objectContaining({
        clipId: 'plate', ownerId: 'occ-2', clipType: 'opaque', startFrame: 27, endFrame: 33,
        opaqueReasons: ['unsupported-timing'],
      })],
      rawDiagnostics: seamReport,
    });
    vi.unstubAllGlobals();
  });

  it('formats Runtime parent and nested findings with labels and no internal ids', () => {
    const report = normalizeRuntimeVisualSeamReport({
      fps: 30,
      boundaries: [],
      structuralIssues: [
        {code: 'boundary/overlap', frame: 45, paths: [['parent', 'timeline-id', 'clip', 'parent-a'], ['parent', 'timeline-id', 'clip', 'parent-b']]},
        {code: 'boundary/gap', frame: 90, paths: [['parent', 'timeline-id', 'occurrence', 'occ-2', 'clip', 'source-a'], ['parent', 'timeline-id', 'occurrence', 'occ-2', 'clip', 'source-b']]},
      ],
    }, {
      tracks: [{id: 'v1', label: 'Picture'}],
      clips: [
        {id: 'parent-a', track: 'v1', label: 'Opening shot'},
        {id: 'parent-b', track: 'v1', label: 'Second shot'},
        {id: 'occ-1:source-a', track: 'v1', app: {canonical: {parentDocumentId: 'timeline-id', occurrenceId: 'occ-1'}}, label: 'Wrong occurrence'},
        {id: 'occ-2:source-a', track: 'v1', app: {canonical: {parentDocumentId: 'timeline-id', occurrenceId: 'occ-2'}}, label: 'Nested first'},
        {id: 'occ-2:source-b', track: 'v1', app: {canonical: {parentDocumentId: 'timeline-id', occurrenceId: 'occ-2'}}, label: 'Nested second'},
      ],
    });
    expect(report?.structuralIssues).toEqual([
      "0:01.5 · Two full-screen clips overlap on Picture: 'Opening shot' and 'Second shot'",
      "0:03.0 · Gap on Picture between 'Nested first' and 'Nested second'",
    ]);
    expect(report?.structuralIssues.join(' ')).not.toMatch(/parent-a|source-a|occ-1|timeline-id/);
  });

  it('uses safe labels when Runtime paths do not resolve to authored clip names', () => {
    const report = normalizeRuntimeVisualSeamReport({
      fps: 30,
      boundaries: [],
      structuralIssues: [{code: 'boundary/overlap', frame: 1, paths: [['parent', 't', 'clip', 'secret-a'], ['parent', 't', 'clip', 'secret-b']]}],
    }, {tracks: [{id: 'v1', label: 'Picture'}], clips: []});
    expect(report?.structuralIssues).toEqual(["0:00.0 · Two full-screen clips overlap on Picture: 'clip' and 'clip'"]);
    expect(report?.structuralIssues.join(' ')).not.toContain('secret-');
  });

  it('maps remaining Runtime structural codes to plain language and timecode', () => {
    const report = normalizeRuntimeVisualSeamReport({
      fps: 30,
      boundaries: [],
      structuralIssues: [
        {code: 'boundary/negative-start', frame: -15},
        {code: 'boundary/owner-overhang', startFrame: 30},
        {code: 'boundary/invalid-occurrence', startFrame: 60},
        {code: 'boundary/empty-child-picture', startFrame: 90},
        {code: 'boundary/child-picture-gap', startFrame: 120},
      ],
    });
    expect(report?.structuralIssues).toEqual([
      '-0:00.5 · A clip starts before the timeline',
      '0:01.0 · A nested picture extends beyond its parent',
      '0:02.0 · A nested picture occurrence is invalid',
      '0:03.0 · A nested picture has no full-screen image',
      '0:04.0 · A nested picture has a gap in its full-screen image',
    ]);
  });

  it('reads the advisory seam report from the admitted task spec', async () => {
    const seamReport = {
      version: 1,
      fps: 30,
      guardFrames: 2,
      boundaries: [{
        frame: 30,
        ownerPaths: [['parent', 'main', 'occurrence', 'occ-1', 'clip', 'b']],
        cues: [{
          frame: 30,
          kind: 'motion-start',
          id: 'move',
          path: ['parent', 'main', 'occurrence', 'occ-1', 'clip', 'b'],
        }],
        requiresIntent: true,
      }],
      structuralIssues: [],
      warningCount: 1,
      blocked: false,
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === '/v1/capabilities') return new Response(JSON.stringify(renderCapabilityPage()), { status: 200 });
      if (url.pathname === '/v1/tasks' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const headers = init.headers as Record<string, string>;
        const response = renderTaskMutationResponse('task-advisory-seam', body, headers['Idempotency-Key']);
        const outerSpec = response.data.spec as Record<string, unknown>;
        const innerSpec = outerSpec.spec as Record<string, unknown>;
        innerSpec.inputs = { timeline_authority: { visual_seam_report: seamReport } };
        return new Response(JSON.stringify(response), { status: 201 });
      }
      throw new Error(`unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);

    const result = await enqueueAstridRuntimeRenderTimeline(payload, {
      client: new AstridLocalClient({ projectSlug: 'p', baseUrl: 'http://bridge.fake' }),
    });

    expect(result).toMatchObject({ status: 'queued', task_id: 'task-advisory-seam' });
    expect(result.seamReport).toMatchObject({
      blocked: false,
      warningCount: 1,
      boundaries: [{
        frame: 30,
        timeSeconds: 1,
        requiresIntent: true,
        unacknowledgedRisk: true,
        participants: expect.arrayContaining([expect.objectContaining({clipId: 'b', ownerId: 'occ-1', behavior: 'motion-start'})]),
      }],
      rawDiagnostics: seamReport,
    });
    vi.unstubAllGlobals();
  });

  it('POSTs the canonical rendering.render envelope without a redundant timeline version', async () => {
    const fetchImpl = canonicalRenderFetch();
    vi.stubGlobal('fetch', fetchImpl);
    const result = await enqueueAstridRuntimeRenderTimeline(payload, {
      client: new AstridLocalClient({ projectSlug: 'p', baseUrl: 'http://bridge.fake' }),
      destination: 'project-media',
    });
    expect(result.status).toBe('queued');
    expect(result.task_id).toBe('task-42');
    expect(result.correlation_id).toBe('c');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [capabilityUrl] = fetchImpl.mock.calls[0];
    expect(capabilityUrl).toBe('http://bridge.fake/v1/capabilities?limit=50');
    const [url, init] = fetchImpl.mock.calls[1];
    expect(url).toBe('http://bridge.fake/v1/tasks');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('astrid.render:v1:t:project-media:render.mp4');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      project: 'p',
      capability_id: RENDER_CAPABILITY_ID,
      capability_digest: RENDER_CAPABILITY_DIGEST,
      schema_version: '1',
      input_object_ids: [],
      spec: {
        family: RENDER_CAPABILITY_ID,
        params: {
          timeline_ref: 't',
          output_name: 'render.mp4',
        },
        output_policy: {
          format: 'mp4',
          destination: 'project-media',
          filename: 'render.mp4',
        },
      },
      storage_estimate: {
        scratch_bytes: 17,
        output_bytes: 4096,
      },
      settlement_effect: {},
    });
    expect(body).not.toHaveProperty('family');
    expect(body).not.toHaveProperty('input');
    // An ordinary timeline names no renderer: the host that claims the task chooses the one it can run.
    expect(body.spec.params).not.toHaveProperty('selector');
    vi.unstubAllGlobals();
  });

  it('keeps one operation key stable for delivery retries and changes it for a new intent', async () => {
    const keys: string[] = [];
    const submit = async (operationId: string, taskId: string) => {
      const fetchImpl = canonicalRenderFetch(taskId);
      vi.stubGlobal('fetch', fetchImpl);
      await expect(enqueueAstridRuntimeRenderTimeline(payload, {
        client: new AstridLocalClient({ projectSlug: 'p', baseUrl: 'http://bridge.fake' }),
        operationId,
      })).resolves.toMatchObject({ status: 'queued', task_id: taskId });
      keys.push(((fetchImpl.mock.calls[1][1] as RequestInit).headers as Record<string, string>)['Idempotency-Key']);
      vi.unstubAllGlobals();
    };

    await submit('intent-a', 'task-a');
    await submit('intent-a', 'task-a-replay');
    await submit('intent-b', 'task-b');

    expect(keys[0]).toBe('astrid.render:v3:intent-a:t:download:render.mp4');
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toBe('astrid.render:v3:intent-b:t:download:render.mp4');
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('surfaces a rejected Astrid admission as an error result', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_body', detail: 'bad payload' }), { status: 400 }),
    );
    vi.stubGlobal('fetch', fetchImpl);
    const result = await enqueueAstridRuntimeRenderTimeline(payload, {
      client: new AstridLocalClient({ projectSlug: 'p', baseUrl: 'http://bridge.fake' }),
    });
    expect(result.status).toBe('error');
    expect(result.message).toContain('bad payload');
    vi.unstubAllGlobals();
  });

  it('surfaces a network failure as an error result', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('connection refused'));
    vi.stubGlobal('fetch', fetchImpl);
    const result = await enqueueAstridRuntimeRenderTimeline(payload, {
      client: new AstridLocalClient({ projectSlug: 'p', baseUrl: 'http://bridge.fake' }),
    });
    expect(result.status).toBe('error');
    expect(result.message).toContain('connection refused');
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// cancel rides the common fenced task route
// ---------------------------------------------------------------------------

function stubFakeBridge() {
  const router = createFakeRuntimeRouter();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return await router.handle(new Request(`http://bridge.fake${url.pathname}${url.search}`, init));
  }));
  return router;
}

describe('cancelAstridRenderTask rides the common fenced task route', () => {
  const admission = {
    project: 'demo-project',
    capability_id: RENDER_CAPABILITY_ID,
    capability_digest: RENDER_CAPABILITY_DIGEST,
    schema_version: '1' as const,
    input_object_ids: [],
    spec: {
      family: RENDER_CAPABILITY_ID,
      params: {
        timeline_ref: 't',
        selector: 'rendering.remotion',
        output_name: 'render.mp4',
      },
      output_policy: { format: 'mp4', destination: 'download' },
    },
    storage_estimate: { scratch_bytes: 0, output_bytes: 0 },
    settlement_effect: {},
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('cancels a queued render directly through POST /tasks/:id/cancel', async () => {
    const router = stubFakeBridge();
    const client = new AstridLocalClient({ projectSlug: 'demo-project', baseUrl: 'http://bridge.fake' });
    const { task } = await client.tasks.admit(admission, 'astrid.render:cancel-queued');

    await expect(cancelAstridRenderTask(client, task.id)).resolves.toBeUndefined();
    expect(await client.tasks.get(task.id)).toMatchObject({ status: 'cancelled' });
  });

  it('retries a running render cancel with the neutral Runtime version fence', async () => {
    const router = stubFakeBridge();
    const client = new AstridLocalClient({ projectSlug: 'demo-project', baseUrl: 'http://bridge.fake' });
    const { task } = await client.tasks.admit(admission, 'astrid.render:cancel-running');
    const summary = router.state.tasks.get(task.id);
    if (!summary) throw new Error('fixture missing');
    summary.status = 'running';

    await expect(cancelAstridRenderTask(client, task.id)).resolves.toBeUndefined();

    const cancelCalls = vi.mocked(globalThis.fetch).mock.calls.filter(
      ([url, init]) =>
        String(url).includes('/cancel')
        && (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(cancelCalls).toHaveLength(2); // unfenced 409, then the fenced retry
    const fence = JSON.parse((cancelCalls[1][1] as RequestInit).body as string);
    expect(fence).toEqual({ expected_version: 1 });
    expect(await client.tasks.get(task.id)).toMatchObject({ status: 'cancelled' });
  });

  it('recovers when a local bridge reports an unfenced cancel as 400', async () => {
    const cancel = vi.fn()
      .mockRejectedValueOnce(new BridgeRouteError('task cancel', 400, { detail: 'running task requires a version fence' }))
      .mockResolvedValueOnce({ task: { status: 'cancelled' } });
    const get = vi.fn().mockResolvedValue({ status: 'running', version: 3 });
    const client = { tasks: { cancel, get } } as unknown as AstridLocalClient;

    await expect(cancelAstridRenderTask(client, 'render-task-400')).resolves.toBeUndefined();
    expect(get).toHaveBeenCalledWith('render-task-400');
    expect(cancel).toHaveBeenNthCalledWith(2, 'render-task-400', { status_version: 3 });
  });
});

describe('render-as-task journey against the binding stub (B6 smoke)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('admits, polls, completes, and plays the committed MP4 through R9 Range/ETag', async () => {
    const router = stubFakeBridge();
    const client = new AstridLocalClient({ projectSlug: 'demo-project', baseUrl: 'http://bridge.fake' });

    // R1 admission through the common task route.
    const result = await enqueueAstridRuntimeRenderTimeline({
      timeline_id: 't',
      timeline: { clips: [] },
      assets: { assets: {} },
      theme_id: '2rp',
      output_filename: 'journey.mp4',
      project_id: 'demo-project',
      correlation_id: 'c-journey',
    }, { client });
    expect(result).toMatchObject({ status: 'queued', task_id: expect.any(String) });
    const taskId = result.task_id!;

    // Declared poll cadence read model: queued with no attempts yet.
    let detail = await client.tasks.get(taskId);
    expect(detail.status).toBe('queued');
    expect(detail.attempts).toEqual([]);

    // The executor finishes and commits its render output as managed media.
    const mp4Entry = [...router.state.media.entries()].find(([, media]) => media.mime === 'video/mp4');
    if (!mp4Entry) throw new Error('fixture missing managed mp4');
    const outputObjectId = `sha256:${'f'.repeat(64)}`;
    router.state.runtimeObjects.set(outputObjectId, {
      object_id: outputObjectId,
      digest: outputObjectId,
      media_type: 'video/mp4',
      size: mp4Entry[1].bytes.byteLength,
      version: 1,
      created_at: '2026-09-12T00:00:00Z',
      filename: 'journey.mp4',
    });
    router.state.runtimeObjectBodies.set(outputObjectId, mp4Entry[1].bytes);
    router.completeTask(taskId, { role: 'render', media_id: outputObjectId, is_primary: true });

    detail = await client.tasks.get(taskId);
    expect(detail.status).toBe('succeeded');
    const output = (detail.outputs ?? []).find((candidate) => candidate.role === 'render');
    if (!output) throw new Error('completed render has no render-role output');

    // Playback rides the R9 content route: full GET, then a Range seek, then
    // an ETag revalidation — exactly what <video> issues.
    const contentUrl = client.media.contentUrl(output.media_id);
    expect(contentUrl).toBe('http://bridge.fake/v1/objects/' + encodeURIComponent(outputObjectId));
    const full = await fetch(contentUrl);
    expect(full.status).toBe(200);
    expect(full.headers.get('Accept-Ranges')).toBe('bytes');
    const etag = full.headers.get('ETag');
    expect(etag).toBeTruthy();

    const seek = await fetch(contentUrl, { headers: { Range: 'bytes=0-99' } });
    expect(seek.status).toBe(206);
    expect(seek.headers.get('Content-Range')).toBe(`bytes 0-99/${mp4Entry[1].bytes.byteLength}`);

    const revalidated = await fetch(contentUrl, { headers: { 'If-None-Match': etag! } });
    expect(revalidated.status).toBe(304);
  });
});

describe('Sprint 8 router → enqueue integration', () => {
  it('themed timeline decision drives a banodoco-pool enqueue', async () => {
    const config = {
      theme: '2rp',
      clips: [{ clipType: 'image-jump' }, { clipType: 'media' }],
    };

    // Step 1: router decides Astrid Runtime.
    const decision = decideRenderRoute(config);
    expect(decision.route).toBe('worker-astrid-runtime');

    // Step 2: build payload + enqueue.
    const { payload } = buildRenderTimelinePayload({
      request: {
        timelineId: 't',
        assetRegistry: { assets: {} },
        resolvedConfig: config,
        renderMetadata: null,
        renderRuntime: {
          projectId: 'p',
        },
      },
      correlationId: 'corr-x',
    });
    expect(payload).toBeDefined();

    const fetchImpl = canonicalRenderFetch('task-1');
    vi.stubGlobal('fetch', fetchImpl);
    const result = await enqueueAstridRuntimeRenderTimeline(payload!, {
      client: new AstridLocalClient({ projectSlug: 'p', baseUrl: 'http://bridge.fake' }),
    });
    expect(result.status).toBe('queued');

    // Dispatch uses the common Astrid task authority, not a worker pool.
    const body = JSON.parse(fetchImpl.mock.calls[1][1].body as string);
    expect(body).toMatchObject({
      capability_id: RENDER_CAPABILITY_ID,
      capability_digest: RENDER_CAPABILITY_DIGEST,
      spec: {
        family: RENDER_CAPABILITY_ID,
        params: {
          timeline_ref: 't',
          output_name: 'timeline-t.mp4',
        },
      },
    });
    vi.unstubAllGlobals();
  });

  it('pure-media timeline decision skips the orchestrator entirely', () => {
    const config = { clips: [{ clipType: 'media' }, { clipType: 'text' }] };
    const decision = decideRenderRoute(config);
    expect(decision.route).toBe('browser-remotion');
    // The integration assertion: no fetch is made for client-route timelines.
    // Caller should branch on `decision.route` and call useClientRender;
    // we don't test that wiring here (it lives in useClientRender), but
    // make the router contract explicit so future regressions are loud.
  });
});

describe('Sprint 8 render pipeline middleware', () => {
  const runtime = {
    projectId: 'project-1',
  };


  it('renders supported local fixture timelines in the browser path with the local runtime type', async () => {
    const events: Array<{ type: string; request?: unknown; assetCount?: number; providerId?: string }> = [];
    const request = {
      timelineId: 'fixture-browser',
      assetRegistry: {
        assets: {
          'asset-1': {
            src: 'file:///tmp/fixture-browser.mp4',
            file: 'fixture-browser.mp4',
            type: 'video/mp4',
          },
        },
      },
      resolvedConfig: {
        output: { resolution: '1920x1080', fps: 30, file: 'fixture-browser.mp4' },
        tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
        clips: [{ id: 'clip-1', track: 'V1', at: 0, from: 0, to: 2, clipType: 'media', asset: 'asset-1' }],
        registry: {
          'asset-1': {
            src: 'file:///tmp/fixture-browser.mp4',
            file: 'fixture-browser.mp4',
            type: 'video/mp4',
          },
        },
      },
      renderMetadata: null,
      renderRuntime: {
        projectId: 'project-1',
      },
    };
    const startBrowserRender = vi.fn(async () => ({
      status: 'done' as const,
      message: 'Saved fixture-browser.mp4',
    }));

    const result = await executeRenderPipeline({
      decision: decideRenderRoute(request.resolvedConfig),
      request,
      startBrowserRender,
      middlewares: [async (event) => {
        events.push(event);
      }],
    });

    expect(result).toMatchObject({
      status: 'done',
      providerId: 'browser-remotion',
    });
    expect(startBrowserRender).toHaveBeenCalledTimes(1);
    expect(events).toMatchObject([
      { type: 'beforeRender', request },
      { type: 'assetMaterialized', request, assetCount: 1 },
      { type: 'afterRender', request, providerId: 'browser-remotion' },
    ]);
  });

  it('does not block browser export on an enforced seam with an active opaque effect', async () => {
    const startBrowserRender = vi.fn(async () => ({ status: 'done' as const, message: 'unexpected' }));
    const request = {
      timelineId: 'timeline-opaque-seam',
      assetRegistry: null,
      resolvedConfig: {
        output: { resolution: '1920x1080', fps: 30, file: 'seam.mp4' },
        tracks: [
          { id: 'video', kind: 'visual' as const, label: 'Picture' },
          { id: 'fx', kind: 'visual' as const, label: 'FX' },
        ],
        clips: [
          { id: 'a', track: 'video', at: 0, hold: 2, clipType: 'media', asset: 'a' },
          { id: 'b', track: 'video', at: 2, hold: 2, clipType: 'media', asset: 'b' },
          {
            id: 'fx-wipe', track: 'fx', at: 2, hold: 1,
            clipType: 'custom-effect',
            elementRef: { id: 'wipe', kind: 'effect' as const, revision: 'rev-1' },
          },
        ],
        registry: {},
        app: { visualSeamContract: { version: 1, mode: 'enforced' } },
      },
      renderMetadata: null,
      renderRuntime: runtime,
    };

    const result = await executeRenderPipeline({
      decision: decideRenderRoute({ clips: [{ clipType: 'media' }] }),
      request,
      startBrowserRender,
    });

    expect(result).toMatchObject({ status: 'done', providerId: 'browser-remotion' });
    expect(startBrowserRender).toHaveBeenCalledOnce();
  });

  it('emits beforeRender, assetMaterialized, and afterRender through one shared middleware path', async () => {
    const events: string[] = [];
    const middleware = vi.fn(async (event: { type: string }) => {
      events.push(event.type);
    });
    const startBrowserRender = vi.fn(async () => ({
      status: 'done' as const,
      message: 'Saved output.mp4',
    }));

    const result = await executeRenderPipeline({
      decision: decideRenderRoute({ clips: [{ clipType: 'media' }] }),
      request: {
        timelineId: 'timeline-1',
        assetRegistry: { assets: { 'asset-1': { src: 'https://cdn.example.com/asset-1.mp4', file: 'asset-1.mp4', type: 'video/mp4' } } },
        resolvedConfig: {
          output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
          tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
          clips: [{ id: 'clip-1', track: 'V1', at: 0, hold: 1, clipType: 'media' }],
          registry: { 'asset-1': { src: 'https://cdn.example.com/asset-1.mp4', file: 'asset-1.mp4', type: 'video/mp4' } },
        },
        renderMetadata: null,
        renderRuntime: runtime,
      },
      startBrowserRender,
      middlewares: [middleware],
    });

    expect(result).toMatchObject({
      status: 'done',
      providerId: 'browser-remotion',
    });
    expect(startBrowserRender).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['beforeRender', 'assetMaterialized', 'afterRender']);
  });

  it('emits renderFailed for preview-only routes without falling back to the browser renderer', async () => {
    const previewEvents: string[] = [];
    const previewResult = await executeRenderPipeline({
      decision: decideRenderRoute({
        clips: [{ clipType: 'media', generation: { sequence_lane: 'remotion_module' } }],
      }),
      request: {
        timelineId: 'timeline-1',
        assetRegistry: null,
        resolvedConfig: null,
        renderMetadata: null,
        renderRuntime: runtime,
      },
      startBrowserRender: vi.fn(async () => ({ status: 'done' as const, message: 'unexpected' })),
      middlewares: [async (event) => {
        previewEvents.push(event.type);
      }],
    });

    expect(previewResult).toMatchObject({
      status: 'error',
      providerId: 'preview-only',
    });
    expect(previewEvents).toEqual(['beforeRender', 'assetMaterialized', 'renderFailed']);
  });

  it('queues worker-capable routes through Astrid R1 without falling back to the browser renderer', async () => {
    const workerEvents: string[] = [];
    const startBrowserRender = vi.fn(async () => ({ status: 'done' as const, message: 'unexpected' }));
    const fetchImpl = canonicalRenderFetch('task-1');
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fetchImpl);
    const workerRuntime = runtime;
    const request = {
      timelineId: 'timeline-fixture-worker',
      assetRegistry: {
        assets: {
          'asset-1': {
            file: 'asset-1.png',
            src: 'file:///tmp/asset-1.png',
            type: 'image/png',
            media_id: `sha256:${'1'.repeat(64)}`,
          },
        },
      },
      resolvedConfig: {
        theme: '2rp',
        output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
        tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
        clips: [{ id: 'clip-1', track: 'V1', at: 0, hold: 1, clipType: 'image-jump', asset: 'asset-1' }],
        registry: {
          'asset-1': {
            file: 'asset-1.png',
            src: 'file:///tmp/asset-1.png',
            type: 'image/png',
            media_id: `sha256:${'1'.repeat(64)}`,
          },
        },
      },
      renderMetadata: null,
      renderRuntime: workerRuntime,
    };

    const workerResult = await executeRenderPipeline({
      decision: decideRenderRoute({ clips: [{ clipType: 'image-jump' }] }),
      request,
      startBrowserRender,
      middlewares: [async (event) => {
        workerEvents.push(event.type);
      }],
    });

    expect(workerResult).toMatchObject({
      status: 'queued',
      providerId: 'worker-astrid-runtime',
      taskId: 'task-1',
      correlationId: expect.any(String),
    });
    expect(startBrowserRender).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const body = JSON.parse(fetchImpl.mock.calls[1][1].body as string);
    expect(body).toMatchObject({
      capability_id: RENDER_CAPABILITY_ID,
      capability_digest: RENDER_CAPABILITY_DIGEST,
      input_object_ids: [],
      spec: {
        family: RENDER_CAPABILITY_ID,
        params: {
          timeline_ref: 'timeline-fixture-worker',
          output_name: 'timeline-timeline-fixture-worker.mp4',
        },
      },
    });
    expect(workerEvents).toEqual(['beforeRender', 'assetMaterialized', 'afterRender']);

    vi.stubGlobal('fetch', originalFetch);
  });

  it('emits renderFailed when Astrid rejects render admission', async () => {
    const workerEvents: string[] = [];
    const startBrowserRender = vi.fn(async () => ({ status: 'done' as const, message: 'unexpected' }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'capability_unavailable',
      detail: 'Remotion is not installed',
    }), { status: 422 })));
    const workerResult = await executeRenderPipeline({
      decision: decideRenderRoute({ clips: [{ clipType: 'image-jump' }] }),
      request: {
        timelineId: 'timeline-1',
        assetRegistry: null,
        resolvedConfig: {
          theme: '2rp',
          output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
          tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
          clips: [{ id: 'clip-1', track: 'V1', at: 0, hold: 1, clipType: 'image-jump' }],
          registry: {},
        },
        renderMetadata: null,
        renderRuntime: runtime,
      },
      startBrowserRender,
      middlewares: [async (event) => {
        workerEvents.push(event.type);
      }],
    });

    expect(workerResult).toMatchObject({
      status: 'error',
      providerId: 'worker-astrid-runtime',
    });
    expect(workerResult.message).toContain('Remotion is not installed');
    expect(startBrowserRender).not.toHaveBeenCalled();
    expect(workerEvents).toEqual(['beforeRender', 'assetMaterialized', 'renderFailed']);
    vi.unstubAllGlobals();
  });
});
