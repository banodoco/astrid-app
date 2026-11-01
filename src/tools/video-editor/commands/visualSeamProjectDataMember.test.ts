import { describe, expect, it } from 'vitest';
import type { ResolvedTimelineConfig, TimelineConfig } from '@/tools/video-editor/types/index.ts';
import { authoringBundleFromDocument } from './authoringBundle.ts';
import { captureProjectDataMember, executeProjectDataMember } from './projectDataMember.ts';
import { copy } from './clipMovePrimitives.ts';
import { environment } from './__tests__/commitSessionEnvironment.ts';
import {
  buildVisualSeamProjectDataPatch,
  VISUAL_SEAM_PROJECT_DATA_TARGET,
  VisualSeamProjectDataRefusal,
} from './visualSeamProjectDataMember.ts';

const authoredContract = {
  version: 1,
  mode: 'enforced',
  pictureTracks: ['picture'],
  intents: { '90': 'synchronized' },
  customDisclosure: { owner: 'app', retained: true },
};

const baseConfig: TimelineConfig = {
  output: { resolution: '1280x720', fps: 30, file: 'timeline.mp4' },
  tracks: [{ id: 'picture', kind: 'visual', label: 'Picture' }],
  clips: [],
  app: { visualSeamContract: authoredContract },
};

function acknowledgedConfig(contract: Record<string, unknown>): ResolvedTimelineConfig {
  return {
    ...baseConfig,
    tracks: baseConfig.tracks ?? [],
    registry: {},
    app: { ...baseConfig.app, visualSeamContract: contract },
  };
}

async function authoredBundle() {
  const env = await environment();
  return authoringBundleFromDocument(env.initial.canonicalDocument);
}

describe('dormant visual seam project-data member', () => {
  it('maps authored fields to the exact app.visualSeamContract namespace and omits the derived report', () => {
    const acknowledged = acknowledgedConfig({
      ...authoredContract,
      intents: { ...authoredContract.intents, '120': 'hard-cut' },
      report: { version: 1, warningCount: 0, blocked: false },
    });

    const patch = buildVisualSeamProjectDataPatch(baseConfig, acknowledged);

    expect(patch).toEqual({
      version: 1,
      source: 'visual-seam',
      operations: [{
        op: 'project-data.write',
        target: VISUAL_SEAM_PROJECT_DATA_TARGET,
        payload: {
          key: 'intents',
          value: { '90': 'synchronized', '120': 'hard-cut' },
          mode: 'replace',
        },
        order: 0,
      }],
    });
  });

  it('preserves an opaque stored report, authored key order, and inverse basis through native capture', async () => {
    const bundle = await authoredBundle();
    const storedReport = { version: 1, blocked: true, opaque: { source: 'legacy' } };
    const current = copy(baseConfig);
    current.app!.visualSeamContract = {
      report: storedReport,
      version: 1,
      intents: { '90': 'synchronized' },
    };
    const acknowledged = acknowledgedConfig({
      version: 1,
      intents: { '90': 'synchronized', '120': 'hard-cut' },
      report: { version: 1, blocked: false },
    });
    bundle.parent.config.app = {
      visualSeamContract: {
        report: storedReport,
        version: 1,
        intents: { '90': 'synchronized' },
      },
    };

    const patch = buildVisualSeamProjectDataPatch(current, acknowledged)!;
    const captured = captureProjectDataMember(bundle, patch);
    expect(captured.commands).toHaveLength(1);
    expect(captured.commands[0].args).toEqual({
      target: VISUAL_SEAM_PROJECT_DATA_TARGET,
      key: 'intents',
      value: { '90': 'synchronized', '120': 'hard-cut' },
      mode: 'replace',
    });
    expect(captured.bundle.parent.config.app).toEqual({
      visualSeamContract: {
        report: storedReport,
        version: 1,
        intents: { '90': 'synchronized', '120': 'hard-cut' },
      },
    });
    expect(Object.keys(captured.bundle.parent.config.app!.visualSeamContract as object)).toEqual([
      'report', 'version', 'intents',
    ]);

    const replayed = executeProjectDataMember(copy(bundle), captured.commands);
    expect(replayed.bundle).toEqual(captured.bundle);
    expect(replayed.records).toEqual(captured.records);
  });

  it('returns no native work for a report-only change and refuses an unsupported authored deletion', () => {
    const reportOnly = buildVisualSeamProjectDataPatch(
      { ...baseConfig, app: { ...baseConfig.app, visualSeamContract: { ...authoredContract, report: { blocked: true } } } },
      acknowledgedConfig({ ...authoredContract, report: { blocked: false } }),
    );
    expect(reportOnly).toBeNull();

    expect(() => buildVisualSeamProjectDataPatch(
      baseConfig,
      acknowledgedConfig({ version: 1, report: { blocked: false } }),
    )).toThrow(VisualSeamProjectDataRefusal);
  });

  it('refuses missing acknowledged declarations and malformed current namespaces', () => {
    expect(() => buildVisualSeamProjectDataPatch(baseConfig, { ...baseConfig, app: {} }))
      .toThrow(VisualSeamProjectDataRefusal);
    expect(() => buildVisualSeamProjectDataPatch(
      { ...baseConfig, app: { visualSeamContract: ['not-an-object'] } },
      acknowledgedConfig(authoredContract),
    )).toThrow(VisualSeamProjectDataRefusal);
  });
});
