// Render-button routing.
//
// Decides whether the user's "Render" click should:
//   * stay in the existing client-side WebCodecs path (`useClientRender`),
//     which handles pure-media + Astrid App-native clipTypes ("text",
//     "effect-layer", "media", "hold").
//   * admit a Runtime `rendering.render` task through the same HC-04 route
//     used by every other local capability.
//
// Decision rule (per sprint brief):
//   * If ANY clip's clipType is in THEME_PACKAGE_REGISTRY → orchestrator.
//   * Mixed timelines (themed + media) → orchestrator (option (a)
//     in the architecture doc; uniform composition end-to-end inside
//     the worker, no cross-task ffmpeg-join).
//   * Pure-Astrid-native timelines → client-side render (untouched).
//
// The router is shape-driven — it inspects the resolved TimelineConfig
// and returns a tagged decision. The caller (UI hook) translates that
// decision into either a `useClientRender` invocation or an
// `enqueueAstridRuntimeRenderTimeline` POST.
//
// We intentionally do NOT inspect `timeline.theme` — a timeline can
// declare a theme but only contain pure-media clips, and the existing
// client renderer can still handle that. The trigger is the clipType
// dispatch, not theme presence.

import type { TimelineRenderRequest } from '@/tools/video-editor/hooks/timeline-state-types.ts';
import type { ResolvedTimelineConfig } from '@/tools/video-editor/types/index.ts';
import type { BridgeTaskAdmissionRequest } from '@/tools/video-editor/data/bridgeContract.ts';
import { AstridLocalClient } from '@/integrations/astrid/client.ts';
import { BridgeRouteError } from '@/integrations/astrid/transport.ts';
import { getRegisteredClipTypeDescriptor } from '@/tools/video-editor/clip-types/runtime.ts';
import { MANAGED_RUNTIME_CLIP_TYPES } from '@/tools/video-editor/runtime/managedRuntimeClipTypes.ts';
import {
  getGeneratedRemotionModuleStatus,
  type GeneratedRemotionModuleBlockReason,
  type GeneratedLaneClipShape,
} from '@/tools/video-editor/lib/generated-lanes.ts';
import { materializeSequenceConfig } from '@/tools/video-editor/sequences/materialize.ts';
import {
  type VisualBoundaryBehavior,
  type VisualSeamParticipant,
  type VisualSeamReport,
  clipLabel,
  formatVisualSeamFinding,
  timecode,
} from '@/tools/video-editor/data/visualSeamContract.ts';
import type { BoundaryCue } from '../../../../vendor/astrid-browser/astrid/packs/local/rendering/elements/boundary';
import { projectOutputTimelineConfig } from '@/tools/video-editor/data/timelineOutputProjection.ts';
import {
  planRender,
  type RenderPlannerMaterialStatus,
  type RenderPlannerInput,
  type RenderPlannerResult,
} from '@/tools/video-editor/runtime/renderPlanner.ts';
import type { ProcessResultAttachRecord } from '@/tools/video-editor/runtime/composition/processResultAttach.ts';
import type {
  CapabilityRequirement,
  CompositionGraph,
  RenderMaterialRef,
  RenderBlockerReason,
} from '@astrid/editor-sdk';
import type { ProcessStatus } from '@/sdk/video/families/processes';
import type { ContributionRenderability } from '@/tools/video-editor/runtime/renderability.ts';
import type { VideoEditorProcessDescriptor } from '@/tools/video-editor/runtime/extensionSurface.ts';

declare const __ASTRID_EDITOR_PACK_REVISIONS__: Record<string, string> | null;

/** Minimal clip shape we need from the resolved timeline. */
export interface RouterClipShape extends GeneratedLaneClipShape {
  clipType?: string;
  elementRef?: {
    id?: unknown;
    kind?: unknown;
    revision?: unknown;
  } | null;
}

/** Minimal timeline shape we need from the resolved config. */
export interface RouterTimelineShape {
  clips?: ReadonlyArray<RouterClipShape> | null;
}

/**
 * Minimal contributed clip record the router needs to check dynamic
 * capability declarations. Consumers pass a subset of
 * ClipTypeRegistryRecord or an equivalent shape extracted from the
 * provider-scoped registry snapshot.
 */
export interface ContributedClipRecord {
  readonly clipTypeId: string;
  readonly renderability: ContributionRenderability;
}

/**
 * Provider-id taxonomy used by the render pipeline +
 * `renderPipeline.ts`. Each route maps 1:1 onto a provider id so middleware
 * can dispatch on the route without a separate lookup table.
 *
 *   * `browser-remotion`  — client-side WebCodecs / Remotion path
 *                          (`useClientRender`, native + media clips).
 *   * `worker-astrid-runtime`   — Runtime `rendering.render` task admission
 *                          (themed + generated-remotion-module clips).
 *   * `preview-only`      — generated remotion_module clips with invalid /
 *                          missing artifact metadata. Cannot be rendered;
 *                          surfaces a hard "render blocked" message.
 *   * `external`          — reserved for future external render providers.
 *                          Reachable from `decideRenderRoute` only when the
 *                          planner selects `sidecar-export`, which requires
 *                          the plan to actually demand that route (see
 *                          `plannerRouteHasDemand`). No provider implements
 *                          it yet, so `renderPipeline` reports "no external
 *                          render provider is registered" — a route the plan
 *                          asked for and the host cannot serve, never a
 *                          silent fallback for a blocked browser/worker plan.
 */
export type RenderRoute =
  | 'browser-remotion'
  | 'worker-astrid-runtime'
  | 'preview-only'
  | 'external';

export type RenderProviderId = RenderRoute;

export const RENDER_PROVIDER_REGISTRY: Readonly<Record<RenderRoute, RenderProviderId>> = {
  'browser-remotion': 'browser-remotion',
  'worker-astrid-runtime': 'worker-astrid-runtime',
  'preview-only': 'preview-only',
  external: 'external',
};

export interface RenderRouteDecision {
  route: RenderRoute;
  /** True iff at least one clip is themed (i.e. uses the registry). */
  hasThemedClip: boolean;
  /** True iff at least one clip is pure-media / Astrid App-native. */
  hasMediaClip: boolean;
  /** True iff at least one clip is a contributed extension clip. */
  hasContributedClip: boolean;
  reason:
    | 'no_clips'
    | 'pure_native_clips'
    | 'themed_only'
    | 'mixed_themed_and_media'
    | 'generated_remotion_module'
    | 'mixed_generated_module_and_other'
    | 'browser_capable_contributed'
    | 'mixed_browser_capable_contributed_and_native'
    | 'contributed_blocked_no_browser_capability'
    | 'contributed_blocked_worker_route_conflict'
    | GeneratedRemotionModuleBlockReason;
}

interface PlannerRouteDecisionContext {
  readonly plannerResult: RenderPlannerResult;
  readonly selectedPlannerRoute: 'preview' | 'browser-export' | 'worker-export' | 'sidecar-export';
}

export interface RenderRouterPlannerInput {
  readonly compositionGraph?: CompositionGraph;
  readonly processes?: readonly VideoEditorProcessDescriptor[];
  readonly processStatuses?: readonly ProcessStatus[];
  readonly processResultAttachRecords?: readonly ProcessResultAttachRecord[];
  readonly materialRefs?: readonly RenderMaterialRef[];
  readonly materialStatuses?: readonly RenderPlannerMaterialStatus[];
}

export interface PlannerBackedRenderRouteDecision extends RenderRouteDecision {
  readonly planner: PlannerRouteDecisionContext;
}

const NATIVE_BUILTIN_CLIP_TYPES: ReadonlySet<string> = new Set([
  'media',
  'text',
  'effect-layer',
  'hold',
  'automation',
  // First-party custom preview, but still rendered by the host's deterministic
  // browser composition. It is not an Astrid worker/theme contribution.
  'audio-reactive-colour',
]);

// `shot` is an editor authoring construct. It is expanded by the managed
// Runtime into child timeline clips before the Astrid worker sees the frozen
// render snapshot; it is not a Remotion component or an extension clip.
const isNativeBuiltinClipType = (value: unknown): boolean => {
  // Treat undefined/null clipType as media-equivalent (pre-clipType
  // legacy clips). They route to the client renderer.
  if (typeof value !== 'string') return true;
  return NATIVE_BUILTIN_CLIP_TYPES.has(value);
};

const isCustomRenderClipType = (value: unknown): boolean => {
  if (typeof value !== 'string') {
    return false;
  }
  if (NATIVE_BUILTIN_CLIP_TYPES.has(value)) {
    return false;
  }
  const descriptor = getRegisteredClipTypeDescriptor(value);
  return descriptor?.renderCapabilities.exportRoute === 'custom';
};

/**
 * Map contributed clip records by clipTypeId for O(1) lookup during the
 * routing loop.
 */
function indexContributedRecords(
  records: ReadonlyArray<ContributedClipRecord> | undefined,
): ReadonlyMap<string, ContributedClipRecord> {
  if (!records || records.length === 0) return new Map();
  const map = new Map<string, ContributedClipRecord>();
  for (const record of records) {
    if (!map.has(record.clipTypeId)) {
      map.set(record.clipTypeId, record);
    }
  }
  return map;
}

/**
 * Check whether a contributed clip record explicitly declares a supported
 * browser-export capability.
 */
function hasBrowserExportCapability(
  record: ContributedClipRecord,
): boolean {
  return record.renderability.capabilities.some(
    (c) => c.route === 'browser-export' && c.status === 'supported',
  );
}

function sourceRefForClip(clipType: string | undefined): CapabilityRequirement['sourceRef'] {
  return typeof clipType === 'string' && clipType.length > 0
    ? { source: 'registry', contributionId: clipType }
    : { source: 'built-in' };
}

function routeRequirement(
  id: string,
  route: CapabilityRequirement['route'],
  clipType: string | undefined,
  options?: {
    readonly blocking?: boolean;
    readonly reason?: RenderBlockerReason;
    readonly message?: string;
    readonly legacyReason?: RenderRouteDecision['reason'];
    readonly requiredCapabilities?: readonly string[];
  },
): CapabilityRequirement {
  const blocking = options?.blocking === true;
  return {
    id,
    sourceRef: sourceRefForClip(clipType),
    route,
    requiredCapabilities: options?.requiredCapabilities ?? [route],
    determinism: route === 'worker-export' ? 'process-dependent' : 'deterministic',
    blocking,
    routeFit: blocking
      ? {
          route,
          fit: 'blocked',
          reason: options?.reason ?? 'route-unsupported',
          message: options?.message ?? `Clip type "${clipType ?? 'legacy'}" cannot render on ${route}.`,
        }
      : {
          route,
          fit: 'supported',
        },
    findings: blocking
      ? [
          {
            id: `${id}.${route}.${options?.reason ?? 'route-unsupported'}`,
            severity: 'error',
            route,
            reason: options?.reason ?? 'route-unsupported',
            message: options?.message ?? `Clip type "${clipType ?? 'legacy'}" cannot render on ${route}.`,
            detail: {
              source: 'render-router',
              clipType,
              legacyReason: options?.legacyReason,
            },
          },
        ]
      : undefined,
  };
}

function requirementsForWorkerOnlyClip(
  clipType: string | undefined,
  id: string,
  reason: RenderRouteDecision['reason'],
): CapabilityRequirement[] {
  return [
    routeRequirement(`${id}.browser-export`, 'browser-export', clipType, {
      blocking: true,
      reason: 'route-unsupported',
      legacyReason: reason,
      message: `Clip type "${clipType ?? 'generated'}" requires worker export.`,
    }),
    routeRequirement(`${id}.worker-export`, 'worker-export', clipType, {
      requiredCapabilities: ['worker-export'],
    }),
  ];
}

function requirementsForBrowserOnlyClip(
  clipType: string | undefined,
  id: string,
  reason: RenderRouteDecision['reason'],
): CapabilityRequirement[] {
  return [
    routeRequirement(`${id}.browser-export`, 'browser-export', clipType),
    routeRequirement(`${id}.worker-export`, 'worker-export', clipType, {
      blocking: true,
      reason: 'route-unsupported',
      legacyReason: reason,
      message: `Clip type "${clipType ?? 'contributed'}" cannot run on worker export.`,
    }),
  ];
}

function requirementsForBlockedClip(
  clipType: string | undefined,
  id: string,
  reason: RenderRouteDecision['reason'],
  blockerReason: RenderBlockerReason,
): CapabilityRequirement[] {
  return [
    routeRequirement(`${id}.browser-export`, 'browser-export', clipType, {
      blocking: true,
      reason: blockerReason,
      legacyReason: reason,
      message: `Clip type "${clipType ?? 'generated'}" cannot be rendered until ${reason} is resolved.`,
    }),
    routeRequirement(`${id}.worker-export`, 'worker-export', clipType, {
      blocking: true,
      reason: blockerReason,
      legacyReason: reason,
      message: `Clip type "${clipType ?? 'generated'}" cannot be rendered until ${reason} is resolved.`,
    }),
  ];
}

/**
 * A route plan is only a real candidate when something in the plan actually
 * targets it. `blocked === false` alone is *vacuously* true for every route
 * nobody asked for: `buildRoutePlan` derives `blocked` from "does this route
 * own a blocker?", so a route with zero requirements, zero output formats,
 * zero process requirements and zero artifact profiles always reports
 * unblocked. Selecting such a route means routing the render at a provider
 * the timeline never demanded — for `sidecar-export` that lands on the
 * `external` provider, which is a registered stub with no implementation.
 *
 * Demand is the union of every input that can put a route into the plan:
 * capability requirements, output formats, process requirements and artifact
 * completion profiles.
 */
function plannerRouteHasDemand(
  result: RenderPlannerResult,
  route: 'preview' | 'browser-export' | 'worker-export' | 'sidecar-export',
): boolean {
  const plan = result.routePlans.find((candidate) => candidate.route === route);
  if (!plan) return false;
  return plan.requiredCapabilities.length > 0
    || plan.outputFormatIds.length > 0
    || plan.processRequirements.length > 0
    || plan.artifactCompletion.requiredProfiles.length > 0;
}

function selectPlannerRoute(result: RenderPlannerResult): PlannerRouteDecisionContext {
  if (result.canBrowserExport) {
    return { plannerResult: result, selectedPlannerRoute: 'browser-export' };
  }
  if (result.canWorkerExport) {
    return { plannerResult: result, selectedPlannerRoute: 'worker-export' };
  }
  // Sidecar is a fallback only when the plan genuinely demands sidecar
  // export. Without this guard a timeline whose browser + worker routes are
  // blocked gets silently re-routed to `external` purely because no blocker
  // happened to name `sidecar-export`.
  if (result.canSidecarExport && plannerRouteHasDemand(result, 'sidecar-export')) {
    return { plannerResult: result, selectedPlannerRoute: 'sidecar-export' };
  }
  return { plannerResult: result, selectedPlannerRoute: 'preview' };
}

/** Pure-decision routing — call this from a hook or test. */
export function decideRenderRoute(
  timeline: RouterTimelineShape | null | undefined,
  contributedClipRecords?: ReadonlyArray<ContributedClipRecord>,
  plannerInput?: RenderRouterPlannerInput,
): PlannerBackedRenderRouteDecision {
  const clips = (timeline?.clips ?? []) as ReadonlyArray<RouterClipShape>;
  const contributedIndex = indexContributedRecords(contributedClipRecords);

  if (clips.length === 0) {
    const emptyPlanner = selectPlannerRoute(planRender({
      requirements: [],
      compositionGraph: plannerInput?.compositionGraph,
      processes: plannerInput?.processes,
      processStatuses: plannerInput?.processStatuses,
      processResultAttachRecords: plannerInput?.processResultAttachRecords,
      materialRefs: plannerInput?.materialRefs,
      materialStatuses: plannerInput?.materialStatuses,
    } satisfies RenderPlannerInput));
    return {
      route: emptyPlanner.selectedPlannerRoute === 'sidecar-export' ? 'external' : 'browser-remotion',
      hasThemedClip: false,
      hasMediaClip: false,
      hasContributedClip: false,
      reason: 'no_clips',
      planner: emptyPlanner,
    };
  }

  const requirements: CapabilityRequirement[] = [];
  let hasThemedClip = false;
  let hasMediaClip = false;
  let hasContributedClip = false;
  let hasBrowserCapableContributedClip = false;
  let hasNativeOrMediaClip = false;
  let hasGeneratedModuleClip = false;
  let hasOtherClip = false;
  let blockedReason: RenderRouteDecision['reason'] | null = null;
  let blockedHasThemedClip = false;
  let blockedHasMediaClip = false;
  let blockedHasContributedClip = false;

  clips.forEach((clip, index) => {
    if (blockedReason) return;
    const requirementId = `router.clip.${index}.${clip.clipType ?? 'legacy'}`;
    if (clip.elementRef?.kind === 'effect' || clip.elementRef?.kind === 'animation') {
      hasThemedClip = true;
      requirements.push(...requirementsForWorkerOnlyClip(
        typeof clip.elementRef.id === 'string' ? clip.elementRef.id : clip.clipType,
        requirementId,
        'generated_remotion_module',
      ));
      return;
    }
    const moduleStatus = getGeneratedRemotionModuleStatus(clip);
    if (moduleStatus.kind === 'blocked_module') {
      requirements.push(...requirementsForBlockedClip(
        clip.clipType,
        requirementId,
        moduleStatus.reason,
        moduleStatus.reason === 'remotion_module_missing_artifact'
          ? 'missing-material'
          : 'materialization-failed',
      ));
      blockedReason = moduleStatus.reason;
      return;
    }
    if (moduleStatus.kind === 'valid_module') {
      hasGeneratedModuleClip = true;
      requirements.push(...requirementsForWorkerOnlyClip(clip.clipType, requirementId, 'generated_remotion_module'));
      return;
    }

    hasOtherClip = true;

    // Check contributed clip records first. Contributed clip
    // code is only allowed in browser-remotion when it explicitly
    // declares browser-export capability. Worker routes are always
    // blocked for contributed code.
    const clipType = clip?.clipType;

    // Managed authoring clips must take the Runtime worker route. Sending a
    // `shot` through browser Remotion would reintroduce the unregistered
    // dynamic clip type that Runtime admission is responsible for expanding.
    if (typeof clipType === 'string' && MANAGED_RUNTIME_CLIP_TYPES.has(clipType)) {
      hasThemedClip = true;
      requirements.push(...requirementsForWorkerOnlyClip(clipType, requirementId, 'themed_only'));
      return;
    }

    if (typeof clipType === 'string') {
      const contributedRecord = contributedIndex.get(clipType);
      if (contributedRecord) {
        hasContributedClip = true;
        if (hasBrowserExportCapability(contributedRecord)) {
          hasBrowserCapableContributedClip = true;
          requirements.push(...requirementsForBrowserOnlyClip(clipType, requirementId, 'browser_capable_contributed'));
        } else {
          // Contributed clip without browser-export capability is
          // immediately blocked — worker routes are out of scope
          // for contributed code and no other route is available.
          requirements.push(...requirementsForBlockedClip(
            clipType,
            requirementId,
            'contributed_blocked_no_browser_capability',
            'route-unsupported',
          ));
          blockedReason = 'contributed_blocked_no_browser_capability';
          blockedHasContributedClip = true;
          return;
        }
        return;
      }
    }

    // Non-contributed clips follow existing routing.
    if (isCustomRenderClipType(clip?.clipType)) {
      hasThemedClip = true;
      // A themed clip mixed with browser-capable contributed clips
      // creates a conflict: themed clips need worker, contributed
      // clips can't go to worker.
      if (hasBrowserCapableContributedClip) {
        requirements.push(...requirementsForBlockedClip(
          clip.clipType,
          requirementId,
          'contributed_blocked_worker_route_conflict',
          'route-unsupported',
        ));
        blockedReason = 'contributed_blocked_worker_route_conflict';
        blockedHasThemedClip = true;
        blockedHasMediaClip = true;
        blockedHasContributedClip = true;
        return;
      }
      requirements.push(...requirementsForWorkerOnlyClip(clip.clipType, requirementId, 'themed_only'));
    } else if (isNativeBuiltinClipType(clip?.clipType)) {
      hasMediaClip = true;
      hasNativeOrMediaClip = true;
      requirements.push(routeRequirement(`${requirementId}.browser-export`, 'browser-export', clip.clipType));
    } else {
      // Unknown clipType (theme package not installed, typo). Treat as
      // media so the existing render path's loud-placeholder fallback
      // surfaces — orchestrator wouldn't be able to render it either
      // without the theme package, and the sprint scopes us to
      // registered themes.
      hasMediaClip = true;
      hasNativeOrMediaClip = true;
      requirements.push(routeRequirement(`${requirementId}.browser-export`, 'browser-export', clip.clipType));
    }
  });

  const planner = selectPlannerRoute(planRender({
    requirements,
    compositionGraph: plannerInput?.compositionGraph,
    processes: plannerInput?.processes,
    processStatuses: plannerInput?.processStatuses,
    processResultAttachRecords: plannerInput?.processResultAttachRecords,
    materialRefs: plannerInput?.materialRefs,
    materialStatuses: plannerInput?.materialStatuses,
  } satisfies RenderPlannerInput));

  if (blockedReason) {
    return {
      route: 'preview-only',
      hasThemedClip: blockedHasThemedClip,
      hasMediaClip: blockedHasMediaClip,
      hasContributedClip: blockedHasContributedClip,
      reason: blockedReason,
      planner,
    };
  }

  // Generated Remotion module clips always go to the worker pool if
  // they survived the blocked_module short-circuit above. Mixed
  // generated + browser-capable contributed clips create an
  // unresolvable conflict because contributed code cannot execute in
  // the worker.
  if (hasGeneratedModuleClip) {
    if (hasBrowserCapableContributedClip) {
      const conflictPlanner = selectPlannerRoute(planRender({
        requirements: [
          ...requirements,
          ...requirementsForBlockedClip(
            'generated-remotion-module',
            'router.generated.contributed-conflict',
            'contributed_blocked_worker_route_conflict',
            'route-unsupported',
          ),
        ],
        compositionGraph: plannerInput?.compositionGraph,
        processes: plannerInput?.processes,
        processStatuses: plannerInput?.processStatuses,
        processResultAttachRecords: plannerInput?.processResultAttachRecords,
        materialRefs: plannerInput?.materialRefs,
        materialStatuses: plannerInput?.materialStatuses,
      } satisfies RenderPlannerInput));
      return {
        route: 'preview-only',
        hasThemedClip,
        hasMediaClip,
        hasContributedClip: true,
        reason: 'contributed_blocked_worker_route_conflict',
        planner: conflictPlanner,
      };
    }
    return {
      route: 'worker-astrid-runtime',
      hasThemedClip,
      hasMediaClip,
      hasContributedClip: false,
      reason: hasOtherClip ? 'mixed_generated_module_and_other' : 'generated_remotion_module',
      planner,
    };
  }

  // Browser-capable contributed clips mixed with themed clips already
  // short-circuit above (contributed_blocked_worker_route_conflict).
  // Here we handle the remaining combinations.

  if (hasBrowserCapableContributedClip) {
    if (hasThemedClip) {
      // Should not reach here (caught above), but defensive.
      return {
        route: 'preview-only',
        hasThemedClip: true,
        hasMediaClip: true,
        hasContributedClip: true,
        reason: 'contributed_blocked_worker_route_conflict',
        planner,
      };
    }
    if (hasNativeOrMediaClip) {
      // Mixed browser-capable contributed + native → browser-remotion
      // handles both, unless sidecar-export is the selected planner route.
      return {
        route: planner.selectedPlannerRoute === 'sidecar-export' ? 'external' : 'browser-remotion',
        hasThemedClip: false,
        hasMediaClip: true,
        hasContributedClip: true,
        reason: 'mixed_browser_capable_contributed_and_native',
        planner,
      };
    }
    // Pure browser-capable contributed clips
    return {
      route: planner.selectedPlannerRoute === 'sidecar-export' ? 'external' : 'browser-remotion',
      hasThemedClip: false,
      hasMediaClip: false,
      hasContributedClip: true,
      reason: 'browser_capable_contributed',
      planner,
    };
  }

  if (hasThemedClip && hasMediaClip) {
    return {
      route: 'worker-astrid-runtime',
      hasThemedClip,
      hasMediaClip,
      hasContributedClip: false,
      reason: 'mixed_themed_and_media',
      planner,
    };
  }
  if (hasThemedClip) {
    return {
      route: 'worker-astrid-runtime',
      hasThemedClip,
      hasMediaClip,
      hasContributedClip: false,
      reason: 'themed_only',
      planner,
    };
  }
  return {
    route: planner.selectedPlannerRoute === 'sidecar-export' ? 'external' : 'browser-remotion',
    hasThemedClip,
    hasMediaClip,
    hasContributedClip: false,
    reason: 'pure_native_clips',
    planner,
  };
}

// ---------------------------------------------------------------------------
// Astrid managed render task admission
// ---------------------------------------------------------------------------

const MANAGED_RENDER_CAPABILITY_ID = 'rendering.render';
const LIVE_SCENE_CLIP_TYPE = 'haus.astrid.liveScene';

/**
 * The renderer the App names, or none. An ordinary timeline names no renderer: the host that claims the task chooses one it
 * can run (Remotion where it is provisioned, else ffmpeg for what ffmpeg supports). Only the live-scene composition is the
 * App's own choice, and only for its supported clip subset.
 */
function managedRenderSelector(timeline: unknown): string | undefined {
  if (!timeline || typeof timeline !== 'object') return undefined;
  const config = timeline as { clips?: unknown; tracks?: unknown };
  if (!Array.isArray(config.clips)
    || !config.clips.some((clip) => clip?.clipType === LIVE_SCENE_CLIP_TYPE)) return undefined;
  const tracks = Array.isArray(config.tracks) ? config.tracks : [];
  const audioTracks = new Set(tracks.filter((track) => track?.kind === 'audio').map((track) => track.id));
  for (const clip of config.clips) {
    const audio = audioTracks.has(clip?.track);
    if (!clip || (audio ? clip.clipType !== 'media' : ![LIVE_SCENE_CLIP_TYPE, 'text'].includes(clip.clipType))
      || clip.effects || clip.transition || clip.animation || (clip.opacity != null && clip.opacity !== 1)) {
      throw new Error('live-scene managed render contains a mixed or unsupported clip; use prepared scenes, supported text, and ordinary audio media');
    }
    if (!audio) {
      const track = tracks.find((value) => value?.id === clip.track);
      if (track?.muted !== true && (Number(clip.volume ?? 0) > 0 || Number(track?.volume ?? 0) > 0)) {
        throw new Error('live-scene visual clips cannot declare audio; use an ordinary audio track');
      }
    }
    if (clip.clipType === 'text') {
      const textKeys = ['content', 'fontSize', 'color', 'align', 'bold'];
      const paramKeys = ['anchor', 'offsetX', 'offsetY', 'textShadow', 'maxWidth', 'weight'];
      if (Object.keys(clip.text ?? {}).some((key) => !textKeys.includes(key))
        || Object.keys(clip.params ?? {}).some((key) => !paramKeys.includes(key))) {
        throw new Error('live-scene managed render contains unsupported text fields');
      }
    }
  }
  return 'rendering.threejs';
}
const RUNTIME_SHA256_ID = /^sha256:[0-9a-f]{64}$/;
const BARE_SHA256 = /^[0-9a-f]{64}$/;
const MAX_MANAGED_RENDER_INPUTS = 256;

export interface AstridRuntimeRenderTimelinePayload {
  timeline_id: string;
  timeline: unknown;
  assets: unknown;
  theme_id: string;
  output_filename: string;
  project_id: string;
  correlation_id: string;
  editor_pack_revisions?: Record<string, string>;
  /** Ordered managed CAS identities from the resolved Runtime registry. */
  input_object_ids?: string[];
}

export interface BuildRenderPayloadInput {
  /**
   * The TimelineRenderRequest the UI/hook composed for this render.
   * `renderRuntime.projectId` and `assetRegistry` are read from here,
   * keeping caller call-sites aligned with the rest of the pipeline.
   */
  request: Pick<TimelineRenderRequest, 'timelineId' | 'assetRegistry' | 'resolvedConfig' | 'renderRuntime'> & {
    outputFilename?: string;
  };
  /** Tests inject a deterministic UUID; production uses crypto.randomUUID. */
  correlationId?: string;
}

const FALLBACK_THEME_ID = '2rp';

function defaultThemeId(config: { theme?: string } | null | undefined): string {
  const value = config?.theme;
  return typeof value === 'string' && value.trim() ? value : FALLBACK_THEME_ID;
}

function defaultOutputFilename(timelineId: string): string {
  // Suggested filename — the worker may suffix with task_id.
  return `timeline-${timelineId}.mp4`;
}

function runtimeObjectId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (RUNTIME_SHA256_ID.test(value)) return value;
  return BARE_SHA256.test(value) ? `sha256:${value}` : null;
}

/**
 * Runtime admission authorizes only the managed objects actually referenced by
 * the resolved timeline. Preserve registry order and de-duplicate aliases
 * without treating a caller URL/path as an object identity. Required
 * references fail closed: silently dropping one would admit a render with a
 * different input set than the editor displayed.
 */
function managedInputObjectIds(config: unknown): { ids: string[]; error?: string } {
  if (!config || typeof config !== 'object') return { ids: [] };
  const record = config as { registry?: unknown; clips?: unknown };
  const registry = record.registry;
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) return { ids: [] };

  const referenced = new Set<string>();
  if (Array.isArray(record.clips)) {
    for (const clip of record.clips) {
      if (!clip || typeof clip !== 'object') continue;
      const asset = (clip as { asset?: unknown }).asset;
      if (typeof asset === 'string' && asset.trim()) referenced.add(asset);
    }
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const assetId of referenced) {
    const entry = (registry as Record<string, unknown>)[assetId];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ids: [], error: `managed render input ${assetId} is missing from the resolved Runtime registry` };
    }
    const value = entry as { media_id?: unknown; content_sha256?: unknown };
    const mediaId = value.media_id;
    const digest = value.content_sha256;
    const normalizedMediaId = mediaId === undefined ? null : runtimeObjectId(mediaId);
    const normalizedDigest = digest === undefined ? null : runtimeObjectId(digest);
    if (mediaId !== undefined && normalizedMediaId === null) {
      return { ids: [], error: `managed render input ${assetId} has an invalid media_id identity` };
    }
    if (digest !== undefined && normalizedDigest === null) {
      return { ids: [], error: `managed render input ${assetId} has an invalid content_sha256 identity` };
    }
    if (normalizedMediaId && normalizedDigest && normalizedMediaId !== normalizedDigest) {
      return { ids: [], error: `managed render input ${assetId} media_id and content_sha256 identities do not match` };
    }
    const id = normalizedMediaId ?? normalizedDigest;
    if (!id) {
      return { ids: [], error: `managed render input ${assetId} has no Runtime-managed object identity` };
    }
    if (!seen.has(id)) {
      if (ids.length >= MAX_MANAGED_RENDER_INPUTS) {
        return { ids: [], error: `managed render input set exceeds the ${MAX_MANAGED_RENDER_INPUTS}-object admission bound` };
      }
      seen.add(id);
      ids.push(id);
    }
  }
  return { ids };
}

function projectRenderAssetRegistry(
  assetRegistry: unknown,
  authoredConfig: ResolvedTimelineConfig,
  excludedClipIds: readonly string[],
): unknown {
  if (!assetRegistry || typeof assetRegistry !== 'object' || Array.isArray(assetRegistry) || excludedClipIds.length === 0) {
    return assetRegistry;
  }
  const assets = (assetRegistry as { assets?: unknown }).assets;
  if (!assets || typeof assets !== 'object' || Array.isArray(assets)) return assetRegistry;
  const excluded = new Set(excludedClipIds);
  const sourceAssetIds = new Set(
    authoredConfig.clips
      .filter((clip) => excluded.has(clip.id))
      .map((clip) => clip.asset)
      .filter((asset): asset is string => typeof asset === 'string' && asset.length > 0),
  );
  const outputAssetIds = new Set(
    authoredConfig.clips
      .filter((clip) => !excluded.has(clip.id))
      .map((clip) => clip.asset)
      .filter((asset): asset is string => typeof asset === 'string' && asset.length > 0),
  );
  if (sourceAssetIds.size === 0) return assetRegistry;
  return {
    ...(assetRegistry as Record<string, unknown>),
    assets: Object.fromEntries(
      Object.entries(assets as Record<string, unknown>)
        .filter(([assetId]) => !sourceAssetIds.has(assetId) || outputAssetIds.has(assetId)),
    ),
  };
}

function newCorrelationId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  // Defensive non-prod fallback (e.g. test envs without the crypto API);
  // the sprint's prod path has crypto everywhere.
  return `corr-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`;
}

export function buildRenderTimelinePayload(
  input: BuildRenderPayloadInput,
): { payload?: AstridRuntimeRenderTimelinePayload; error?: string; seamReport?: VisualSeamReport } {
  const { request } = input;
  if (!request?.timelineId) return { error: 'timelineId is required' };
  if (!request?.renderRuntime?.projectId) return { error: 'projectId is required' };
  if (!request.resolvedConfig) return { error: 'resolved timeline config is required' };

  const outputProjection = projectOutputTimelineConfig(request.resolvedConfig);
  if (request.resolvedConfig.clips.length > 0 && !outputProjection.hasOutputContent) {
    return { error: 'Cannot export: no output content. Source material is available in the editor.' };
  }
  const outputConfig = outputProjection.config;
  const managedInputs = managedInputObjectIds(outputConfig);

  if (managedInputs.error) return { error: managedInputs.error };

  return {
    payload: {
      timeline_id: request.timelineId,
      timeline: materializeSequenceConfig(outputConfig as Parameters<typeof materializeSequenceConfig>[0]),
      assets: projectRenderAssetRegistry(
        request.assetRegistry ?? { assets: {} },
        request.resolvedConfig,
        outputProjection.excludedClipIds,
      ),
      theme_id: defaultThemeId(outputConfig),
      output_filename: request.outputFilename ?? defaultOutputFilename(request.timelineId),
      project_id: request.renderRuntime.projectId,
      correlation_id: input.correlationId ?? newCorrelationId(),
      input_object_ids: managedInputs.ids,
      ...(typeof __ASTRID_EDITOR_PACK_REVISIONS__ !== 'undefined' && __ASTRID_EDITOR_PACK_REVISIONS__ !== null
        ? { editor_pack_revisions: __ASTRID_EDITOR_PACK_REVISIONS__ }
        : {}),
    },
  };
}

export interface EnqueueRenderResult {
  status: 'queued' | 'error';
  task_id?: string;
  correlation_id?: string;
  message: string;
  seamReport?: VisualSeamReport;
}

export type RenderExportDestination = 'download' | 'project-media';

export interface EnqueueRenderOptions {
  /** Injected in tests; production constructs the client from the payload. */
  client?: AstridLocalClient;
  /** Stable identity for one explicit export intent; reuse it for transport retries. */
  operationId?: string;
  idempotencyKey?: string;
  destination?: RenderExportDestination;
}

function renderAdmissionKey(payload: AstridRuntimeRenderTimelinePayload, options: EnqueueRenderOptions): string {
  if (options.idempotencyKey) return options.idempotencyKey;
  const destination = options.destination ?? 'download';
  if (options.operationId) {
    return `astrid.render:v3:${options.operationId}:${payload.timeline_id}:${destination}:${payload.output_filename}`;
  }
  return `astrid.render:v1:${payload.timeline_id}:${destination}:${payload.output_filename}`;
}

function canonicalAdmissionMetadata(timeline: unknown): Record<string, unknown> {
  if (!timeline || typeof timeline !== 'object' || Array.isArray(timeline)) return {};
  const app = (timeline as { app?: unknown }).app;
  if (!app || typeof app !== 'object' || Array.isArray(app)) return {};
  const canonical = (app as { canonicalComposition?: unknown }).canonicalComposition;
  if (!canonical || typeof canonical !== 'object' || Array.isArray(canonical)) return {};
  const value = canonical as Record<string, unknown>;
  return {
    ...(typeof value.projectId === 'string' ? { canonical_project_id: value.projectId } : {}),
    ...(typeof value.parentDocumentId === 'string' ? { canonical_parent_document_id: value.parentDocumentId } : {}),
    ...(typeof value.headRevisionId === 'string' ? { canonical_head_revision_id: value.headRevisionId } : {}),
    ...(Array.isArray(value.occurrenceIds) ? { canonical_occurrence_ids: [...value.occurrenceIds] } : {}),
  };
}

/**
 * Admit a managed render through Runtime's common HC-04 task primitive.
 *
 * The deliberately retained function name keeps older render-pipeline callers
 * source-compatible; there is no Astrid Runtime/orchestrator request behind it.
 * Runtime resolves and snapshots `timeline_ref` at admission, so the browser
 * sends neither timeline document bytes nor registry bytes as a second source
 * of truth. The capability digest and storage estimate are both read from
 * Runtime's ready capability catalog; no browser-side identity is fabricated.
 */
export async function enqueueAstridRuntimeRenderTimeline(
  payload: AstridRuntimeRenderTimelinePayload,
  options: EnqueueRenderOptions = {},
): Promise<EnqueueRenderResult> {
  try {
    const client = options.client ?? new AstridLocalClient({ projectSlug: payload.project_id });
    const capability = await client.catalog.get(MANAGED_RENDER_CAPABILITY_ID);
    const destination = options.destination ?? 'download';
    const selector = managedRenderSelector(payload.timeline);
    const request: BridgeTaskAdmissionRequest = {
      project: payload.project_id,
      capability_id: capability.capability_id,
      capability_digest: capability.definition_digest,
      schema_version: '1',
      // Runtime owns the complete managed manifest. In particular, shot
      // expansion can add child-timeline assets that are not present in the
      // editor's parent registry, so a browser-provided subset must not be
      // treated as the admission authority.
      input_object_ids: [],
      spec: {
        family: MANAGED_RENDER_CAPABILITY_ID,
        params: {
          timeline_ref: payload.timeline_id,
          ...(selector === undefined ? {} : { selector }),
          output_name: payload.output_filename,
          ...(payload.editor_pack_revisions === undefined ? {} : { editor_pack_revisions: payload.editor_pack_revisions }),
          ...canonicalAdmissionMetadata(payload.timeline),
        },
        output_policy: {
          format: 'mp4',
          destination,
          filename: payload.output_filename,
        },
      },
      storage_estimate: {
        scratch_bytes: capability.estimated_scratch_bytes,
        output_bytes: capability.estimated_output_bytes,
      },
      settlement_effect: {},
    };
    const result = await client.tasks.admit(
      request,
      renderAdmissionKey(payload, options),
    );
    const seamReport = readRuntimeVisualSeamReportFromAdmittedTask(result.task, payload.timeline);
    return {
      status: 'queued',
      task_id: result.task.id,
      correlation_id: payload.correlation_id,
      message: 'Render queued in Runtime. Progress and output are read from the common task ledger.',
      ...(seamReport ? { seamReport } : {}),
    };
  } catch (error) {
    const seamReport = readRuntimeVisualSeamReport(error, payload.timeline);
    return {
      status: 'error',
      correlation_id: payload.correlation_id,
      message: `Astrid render admission failed: ${error instanceof Error ? error.message : String(error)}`,
      ...(seamReport ? { seamReport } : {}),
    };
  }
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringPath(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((segment) => typeof segment === 'string')
    ? value as string[]
    : undefined;
}

function seamOwnerIds(path: readonly string[]): {ownerId: string; clipId: string} {
  const occurrenceIndex = path.lastIndexOf('occurrence');
  const clipIndex = path.lastIndexOf('clip');
  return {
    ownerId: occurrenceIndex >= 0 ? path[occurrenceIndex + 1] ?? path[path.length - 1] ?? 'unknown' : path[path.length - 1] ?? 'unknown',
    clipId: clipIndex >= 0 ? path[clipIndex + 1] ?? path[path.length - 1] ?? 'unknown' : path[path.length - 1] ?? 'unknown',
  };
}

const seamCueKinds = new Set(['activation', 'source-reset', 'source-change', 'rate-change', 'motion-start', 'phase-change']);
const seamBehaviors = new Set<VisualBoundaryBehavior>([
  'continues', 'enters', 'exits', 'source-change', 'motion-start', 'phase-change', 'activation', 'source-reset', 'rate-change', 'opaque',
]);

function runtimeCue(value: unknown): BoundaryCue | undefined {
  const candidate = jsonRecord(value);
  const path = stringPath(candidate?.path);
  if (!candidate || !path || typeof candidate.frame !== 'number' || !Number.isFinite(candidate.frame)
    || typeof candidate.id !== 'string' || typeof candidate.kind !== 'string' || !seamCueKinds.has(candidate.kind)) return undefined;
  return {frame: candidate.frame, id: candidate.id, kind: candidate.kind as BoundaryCue['kind'], path: [...path]};
}

function issueText(value: unknown, fps: number, timeline?: unknown): string {
  if (typeof value === 'string') return 'Visual boundary issue';
  const issue = jsonRecord(value);
  if (!issue) return 'Visual boundary issue';
  const timelineRecord = jsonRecord(timeline);
  const tracks = Array.isArray(timelineRecord?.tracks) ? timelineRecord.tracks : [];
  const clips = Array.isArray(timelineRecord?.clips) ? timelineRecord.clips : [];
  const paths = Array.isArray(issue.paths) ? issue.paths : issue.path ? [issue.path] : [];
  const issuePaths = paths.map(stringPath).filter((path): path is readonly string[] => path !== undefined);
  const clipForPath = (path: readonly string[]) => {
    const clipIndex = path.lastIndexOf('clip');
    if (clipIndex < 0 || typeof path[clipIndex + 1] !== 'string') return undefined;
    const pathClipId = path[clipIndex + 1];
    const occurrenceIndex = path.lastIndexOf('occurrence');
    const occurrenceId = occurrenceIndex >= 0 ? path[occurrenceIndex + 1] : undefined;
    const parentIndex = path.lastIndexOf('parent');
    const parentDocumentId = parentIndex >= 0 ? path[parentIndex + 1] : undefined;
    const clipRecords = clips.map(jsonRecord).filter((clip): clip is Record<string, unknown> => clip !== undefined);
    if (occurrenceId && parentDocumentId) {
      return clipRecords.find((clip) => {
        const canonical = jsonRecord(jsonRecord(clip.app)?.canonical);
        return canonical?.occurrenceId === occurrenceId
          && canonical?.parentDocumentId === parentDocumentId
          && (canonical?.sourceClipId === pathClipId || clip.id === `${occurrenceId}:${pathClipId}`);
      });
    }
    return clipRecords.find((clip) => clip.id === pathClipId);
  };
  const clipsForIssue = issuePaths.map(clipForPath);
  const clipRecords = clipsForIssue.filter((clip): clip is Record<string, unknown> => clip !== undefined);
  const labels = clipsForIssue.map((clip) => clip ? clipLabel({
    label: clip.label,
    text: jsonRecord(clip.text),
  }) : 'clip');
  const clipTrackId = typeof clipRecords[0]?.track === 'string' ? clipRecords[0].track : undefined;
  const trackId = typeof issue.track === 'string' ? issue.track : clipTrackId;
  const track = tracks.map(jsonRecord).find((item) => item?.id === trackId);
  const trackLabel = typeof track?.label === 'string' ? track.label : 'Picture';
  const code = typeof issue.code === 'string' ? issue.code : '';
  const frame = typeof issue.frame === 'number' ? issue.frame
    : typeof issue.startFrame === 'number' ? issue.startFrame
    : code === 'boundary/negative-start' && typeof clipRecords[0]?.at === 'number' ? Math.round((clipRecords[0].at as number) * fps)
      : undefined;
  if (frame !== undefined && (code === 'boundary/overlap' || code === 'boundary/gap')) {
    const finding = code === 'boundary/overlap' ? 'overlap' : 'gap';
    return formatVisualSeamFinding(frame, fps, finding, trackLabel, labels.length > 0 ? labels : ['clip', 'clip']);
  }
  const plainCode: Record<string, string> = {
    picture_gap: 'Gap in the full-screen picture',
    'boundary/negative-start': 'A clip starts before the timeline',
    'boundary/owner-overhang': 'A nested picture extends beyond its parent',
    'boundary/invalid-occurrence': 'A nested picture occurrence is invalid',
    'boundary/empty-child-picture': 'A nested picture has no full-screen image',
    'boundary/child-picture-gap': 'A nested picture has a gap in its full-screen image',
  };
  if (plainCode[code]) return `${frame !== undefined ? `${timecode(frame / fps)} · ` : ''}${plainCode[code]}`;
  const range = typeof issue.startFrame === 'number' || typeof issue.endFrame === 'number'
    ? `${timecode((typeof issue.startFrame === 'number' ? issue.startFrame : issue.endFrame as number) / fps)}–${timecode((typeof issue.endFrame === 'number' ? issue.endFrame : issue.startFrame as number) / fps)}`
    : undefined;
  const line = frame !== undefined ? timecode(frame / fps) : range;
  return [line, 'Visual boundary issue'].filter(Boolean).join(' · ');
}

/** Runtime and App use different report schemas. Normalize the Runtime wire report
 * into the UI contract while retaining the original diagnostics for path details. */
export function normalizeRuntimeVisualSeamReport(value: unknown, timeline?: unknown): VisualSeamReport | undefined {
  const raw = jsonRecord(value);
  if (!raw || !Array.isArray(raw.boundaries)) return undefined;
  const fps = typeof raw.fps === 'number' && Number.isFinite(raw.fps) && raw.fps > 0 ? raw.fps : 30;
  const rawIssues = Array.isArray(raw.structuralIssues) ? raw.structuralIssues : [];
  const structuralIssues = rawIssues.map((issue) => issueText(issue, fps, timeline));
  const boundaries = raw.boundaries.flatMap((rawBoundary) => {
    const boundary = jsonRecord(rawBoundary);
    if (!boundary || typeof boundary.frame !== 'number' || !Number.isFinite(boundary.frame)) return [];
    const frame = Math.round(boundary.frame);
    const cues = Array.isArray(boundary.cues)
      ? boundary.cues.map(runtimeCue).filter((cue): cue is BoundaryCue => cue !== undefined)
      : [];
    const ownerPaths = Array.isArray(boundary.ownerPaths)
      ? boundary.ownerPaths.map(stringPath).filter((path): path is readonly string[] => path !== undefined)
      : [];
    const opaquePaths = Array.isArray(boundary.opaquePaths)
      ? boundary.opaquePaths.map(stringPath).filter((path): path is readonly string[] => path !== undefined)
      : [];
    const opaqueKeys = new Set(opaquePaths.map((path) => JSON.stringify(path)));
    const participants = new Map<string, VisualSeamParticipant>();
    for (const path of [...ownerPaths, ...opaquePaths]) {
      const ids = seamOwnerIds(path);
      const opaque = opaqueKeys.has(JSON.stringify(path));
      participants.set(`owner:${JSON.stringify(path)}`, {
        ...ids,
        path,
        behavior: opaque ? 'opaque' : 'continues',
      });
    }
    for (const cue of cues) {
      const ids = seamOwnerIds(cue.path);
      const behavior = seamBehaviors.has(cue.kind as VisualBoundaryBehavior)
        ? cue.kind as VisualBoundaryBehavior
        : 'continues';
      participants.set(`cue:${JSON.stringify([cue.path, cue.kind, cue.id, cue.frame])}`, {...ids, path: cue.path, behavior, cue});
    }
    const boundaryIssues = structuralIssues.filter((issue, index) => {
      const source = jsonRecord(rawIssues[index]);
      if (typeof source?.frame === 'number') return Math.round(source.frame) === frame;
      if (typeof source?.startFrame === 'number' || typeof source?.endFrame === 'number') {
        const start = typeof source.startFrame === 'number' ? source.startFrame : source.endFrame as number;
        const end = typeof source.endFrame === 'number' ? source.endFrame : start;
        return frame >= start && frame <= end;
      }
      return true;
    });
    const requiresIntent = boundary.requiresIntent === true;
    return [Object.freeze({
      frame,
      timeSeconds: frame / fps,
      ...(boundary.intent === 'hard-cut' || boundary.intent === 'transition' || boundary.intent === 'synchronized'
        ? {intent: boundary.intent}
        : {}),
      participants: Object.freeze([...participants.values()]),
      structuralIssues: Object.freeze(boundaryIssues),
      unacknowledgedRisk: requiresIntent || opaquePaths.length > 0 || cues.length > 0,
      requiresIntent,
    })];
  });
  const cues = Array.isArray(raw.cues)
    ? raw.cues.map(runtimeCue).filter((cue): cue is BoundaryCue => cue !== undefined)
    : boundaries.flatMap((boundary) => boundary.participants.flatMap((participant) => participant.cue ? [participant.cue] : []));
  const opaqueElements = Array.isArray(raw.opaqueElements)
    ? raw.opaqueElements.flatMap((item) => {
        const opaque = jsonRecord(item);
        const span = jsonRecord(opaque?.span);
        const path = stringPath(opaque?.path) ?? stringPath(span?.path);
        if (!opaque || !path) return [];
        const ids = seamOwnerIds(path);
        const reasons = Array.isArray(opaque.opaque)
          ? opaque.opaque.filter((reason): reason is string => typeof reason === 'string')
          : undefined;
        const knownReasons = new Set(['custom-clip-type', 'element-ref', 'unsupported-transition', 'unsupported-timing']);
        const reason = reasons?.find((item) => knownReasons.has(item)) as VisualSeamReport['opaqueElements'][number]['reason'] | undefined;
        return [{
          clipId: typeof opaque.clipId === 'string' ? opaque.clipId : ids.clipId,
          clipType: typeof opaque.clipType === 'string' ? opaque.clipType : 'opaque',
          ownerId: typeof opaque.ownerId === 'string' ? opaque.ownerId : ids.ownerId,
          path,
          startFrame: typeof opaque.startFrame === 'number' ? opaque.startFrame : typeof span?.startFrame === 'number' ? span.startFrame : 0,
          endFrame: typeof opaque.endFrame === 'number' ? opaque.endFrame : typeof span?.endFrame === 'number' ? span.endFrame : 0,
          reason: reason ?? 'custom-clip-type' as const,
          ...(reasons ? {opaqueReasons: reasons} : {}),
        }];
      })
    : [];
  const warningCount = typeof raw.warningCount === 'number'
    ? raw.warningCount
    : boundaries.filter((boundary) => boundary.unacknowledgedRisk).length;
  const blocked = typeof raw.blocked === 'boolean'
    ? raw.blocked
    : structuralIssues.length > 0 || boundaries.some((boundary) => boundary.requiresIntent);
  return Object.freeze({
    version: 1,
    fps,
    guardFrames: typeof raw.guardFrames === 'number' ? raw.guardFrames : 2,
    boundaries: Object.freeze(boundaries),
    opaqueElements: Object.freeze(opaqueElements),
    structuralIssues: Object.freeze(structuralIssues),
    cues: Object.freeze(cues),
    warningCount,
    blocked,
    rawDiagnostics: raw,
  });
}

function readRuntimeVisualSeamReport(error: unknown, timeline?: unknown): VisualSeamReport | undefined {
  if (!(error instanceof BridgeRouteError)) return undefined;
  const details = error.envelope?.details;
  return normalizeRuntimeVisualSeamReport(jsonRecord(details)?.report, timeline);
}

function readRuntimeVisualSeamReportFromAdmittedTask(task: unknown, timeline?: unknown): VisualSeamReport | undefined {
  const taskSpec = jsonRecord(jsonRecord(task)?.spec);
  const runtimeSpec = jsonRecord(taskSpec?.spec);
  const inputs = jsonRecord(runtimeSpec?.inputs);
  const timelineAuthority = jsonRecord(inputs?.timeline_authority);
  return normalizeRuntimeVisualSeamReport(timelineAuthority?.visual_seam_report, timeline);
}

/** Cancel a queued/running render through the common fenced task route. */
export async function cancelAstridRenderTask(
  client: AstridLocalClient,
  taskId: string,
): Promise<void> {
  try {
    await client.tasks.cancel(taskId);
    return;
  } catch (error) {
    // Some locally running Astrid bridge builds report an unfenced running
    // cancel as 400, while the canonical Runtime route reports 409. Both
    // mean that the task needs a fresh version fence before retrying.
    if (!(error instanceof BridgeRouteError) || (error.status !== 400 && error.status !== 409)) throw error;
  }

  // Stale-version fence: resync from the task read model and retry once with
  // its current version. The Runtime cancel body carries only
  // `expected_version`; attempt/lease identities are not part of this wire.
  // A task that went terminal between the 409 and this read replays its
  // state idempotently, so a cancelled/succeeded/failed read is success.
  const detail = await client.tasks.get(taskId);
  if (detail.status === 'succeeded' || detail.status === 'failed' || detail.status === 'cancelled') return;
  if (typeof detail.version !== 'number') {
    throw new Error('Astrid returned an active render task without a cancellation version fence');
  }
  await client.tasks.cancel(taskId, { status_version: detail.version });
}
