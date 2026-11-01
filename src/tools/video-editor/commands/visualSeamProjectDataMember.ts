import type { ResolvedTimelineConfig, TimelineConfig } from '@/tools/video-editor/types/index.ts';
import type { TimelinePatch } from '@/sdk/video/timeline/patch.ts';
import { canonicalJsonStringify } from '@/tools/video-editor/data/typed/timelineBundle.ts';

export const VISUAL_SEAM_PROJECT_DATA_TARGET = 'visualSeamContract';
const DERIVED_REPORT_KEY = 'report';

type ConfigWithApp = Pick<TimelineConfig | ResolvedTimelineConfig, 'app'>;
type JsonRecord = Record<string, unknown>;

export class VisualSeamProjectDataRefusal extends Error {
  constructor(message: string) {
    super(`Visual seam project-data patch refused: ${message}`);
    this.name = 'VisualSeamProjectDataRefusal';
  }
}

function record(value: unknown, label: string): JsonRecord | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new VisualSeamProjectDataRefusal(`${label} must be an object or absent`);
  }
  return value as JsonRecord;
}

function seamContract(config: ConfigWithApp, label: string): JsonRecord | undefined {
  return record(config.app?.visualSeamContract, `${label} visualSeamContract`);
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

/**
 * Build the dormant native seam acknowledgement patch.
 *
 * private392's project-data recipe addresses parent.config.app[target][key].
 * Naming the target visualSeamContract therefore retains Main's existing
 * authored location while keeping the derived report out of the patch.
 */
export function buildVisualSeamProjectDataPatch(
  currentConfig: ConfigWithApp,
  acknowledgedConfig: ConfigWithApp,
): TimelinePatch | null {
  const current = seamContract(currentConfig, 'Current');
  const acknowledged = seamContract(acknowledgedConfig, 'Acknowledged');
  if (!acknowledged) {
    throw new VisualSeamProjectDataRefusal('acknowledged authored declarations are missing');
  }

  for (const key of Object.keys(current ?? {})) {
    if (key !== DERIVED_REPORT_KEY && !Object.prototype.hasOwnProperty.call(acknowledged, key)) {
      throw new VisualSeamProjectDataRefusal(
        `authored key ${JSON.stringify(key)} would require unsupported project-data deletion`,
      );
    }
  }

  const operations = Object.keys(acknowledged)
    .filter((key) => key !== DERIVED_REPORT_KEY)
    .filter((key) => !sameValue(current?.[key], acknowledged[key]))
    .map((key, index) => ({
      op: 'project-data.write' as const,
      target: VISUAL_SEAM_PROJECT_DATA_TARGET,
      payload: { key, value: acknowledged[key], mode: 'replace' as const },
      order: index,
    }));

  if (!operations.length) return null;
  return { version: 1, source: 'visual-seam', operations };
}
