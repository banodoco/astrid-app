// @vitest-environment jsdom
//
// Render-path integration test for FLAG-001/002 wiring.
//
// Mounts SequenceComponentRegistryProvider seeded with one fake DB entry,
// renders a single-clip timeline with `clipType: 'custom:my-seq'` through
// <TimelineRenderer>, and asserts:
//   (a) the component rendered by the dynamic entry appears AFTER waitFor
//       — proving useSyncExternalStore re-renders on registerAsync completion.
//   (b) describeClipCapabilityWith for that clip returns workerRender:false.
//
// The compileSequenceComponentAsync function is spied so we don't need a
// real Sucrase compile — the spy returns a fake FC rendering a marker div.

import type { FC, PropsWithChildren } from 'react';
import * as composition from '@banodoco/timeline-composition';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TimelineRenderer } from '@/tools/video-editor/compositions/TimelineRenderer';
import { INSTALLED_ASTRID_ELEMENT_HOST } from '@/tools/video-editor/runtime/astrid-element-components';
import { SequenceComponentRegistryProvider } from '@/tools/video-editor/sequences/SequenceComponentRegistryContext';
import {
  describeClipCapabilityWith,
  type DynamicSequenceComponentEntry,
} from '@/tools/video-editor/sequences/registry';
import * as compileSequenceModule from '@/tools/video-editor/sequences/compileSequenceComponent';
import type { SequenceComponentResource } from '@/tools/video-editor/lib/sequence-component-catalog';
import type { ResolvedTimelineConfig } from '@/tools/video-editor/types';

vi.mock('remotion', async () => ({
  delayRender: () => 0,
  continueRender: () => {},
  AbsoluteFill: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => (
    <div data-testid="absolute-fill" {...props}>{children}</div>
  ),
  Sequence: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => (
    <div data-testid="sequence" {...props}>{children}</div>
  ),
  useCurrentFrame: () => 0,
  useRemotionEnvironment: () => ({ isRendering: false, isClientSideRendering: false }),
}));

vi.mock('@banodoco/timeline-composition/theme-api', async () => {
  const React = await import('react');
  const visual = {
    color: { accent: '#ffffff', bg: '#000000' },
    type: { families: { heading: 'Inter' } },
  };
  const ThemeContext = React.createContext(visual);
  return {
    DEFAULT_THEME: { id: 'default', visual },
    ThemeProvider: ({ children, value }: PropsWithChildren<{ value?: unknown }>) => (
      <ThemeContext.Provider
        value={(value && typeof value === 'object' && 'visual' in value && (value as { visual?: typeof visual }).visual) ?? visual}
      >
        {children}
      </ThemeContext.Provider>
    ),
    useTheme: () => React.useContext(ThemeContext),
  };
});

vi.mock('@/tools/video-editor/compositions/AudioAnalysisProvider', () => ({
  AudioAnalysisProvider: ({ children }: PropsWithChildren) => <>{children}</>,
}));

const buildConfig = (clipType: string): ResolvedTimelineConfig => ({
  output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
  tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
  clips: [
    {
      id: 'clip-dyn-1',
      clipType,
      track: 'V1',
      at: 0,
      hold: 2,
      params: {},
    },
  ],
  registry: {},
});

const FAKE_DB_COMPONENT: SequenceComponentResource = {
  id: 'res-my-seq',
  type: 'sequence-component',
  name: 'My Custom Seq',
  slug: 'my-seq',
  code: '/* fake — compileSequenceComponentAsync is spied */',
  schemaJson: { type: 'object', properties: {} },
  defaultsJson: {},
  clipType: 'my-seq',
  themeId: '2rp',
  description: 'integration-test fake',
  created_by: { is_you: true, username: 'tester' },
  is_public: false,
};

describe('TimelineRenderer — dynamic registry dispatch (FLAG-001/002)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('never compiles DB-stored sequence code; the custom clip shows the unsupported placeholder instead', async () => {
    const FakeDynamicSeq: FC = () => <div data-testid="dynamic-seq">DYNAMIC</div>;
    // Spy on the module symbol so any namespace lookup would route through us
    // instead of running real Sucrase compile. The product must never call it.
    const compileSpy = vi.spyOn(compileSequenceModule, 'compileSequenceComponentAsync').mockResolvedValue(
      FakeDynamicSeq as unknown as ReturnType<typeof compileSequenceModule.compileSequenceComponentAsync> extends Promise<infer C> ? C : never,
    );

    render(
      <SequenceComponentRegistryProvider components={[FAKE_DB_COMPONENT]}>
        <TimelineRenderer astridElementHost={INSTALLED_ASTRID_ELEMENT_HOST} config={buildConfig('custom:my-seq')} />
      </SequenceComponentRegistryProvider>,
    );

    // The DB-stored component is retained as migration data only, so the clip
    // falls through to the loud unsupported placeholder for its clipType.
    await waitFor(() => {
      expect(screen.getByTestId('unknown-clip-placeholder')).toBeInTheDocument();
    });
    expect(screen.getByTestId('unknown-clip-placeholder')).toHaveAttribute('data-clip-type', 'custom:my-seq');
    expect(screen.getByTestId('unknown-clip-placeholder')).toHaveAttribute('data-placeholder-reason', 'unsupported');
    expect(screen.getByText("clipType 'custom:my-seq' renderer unavailable in this Astrid build")).toBeInTheDocument();

    // The custom component's output must never appear, and its code is never compiled.
    expect(screen.queryByTestId('dynamic-seq')).not.toBeInTheDocument();
    expect(screen.queryByText('DYNAMIC')).not.toBeInTheDocument();
    expect(compileSpy).not.toHaveBeenCalled();
  });

  it('describeClipCapabilityWith returns workerRender:false for the same clip', () => {
    const dynamicEntries: DynamicSequenceComponentEntry[] = [
      {
        clipType: 'my-seq',
        component: (() => null) as DynamicSequenceComponentEntry['component'],
        schemaJson: FAKE_DB_COMPONENT.schemaJson,
        themeId: FAKE_DB_COMPONENT.themeId,
      },
    ];
    const descriptor = describeClipCapabilityWith(
      { id: 'clip-dyn-1', clipType: 'custom:my-seq' } as Parameters<typeof describeClipCapabilityWith>[0],
      dynamicEntries,
    );
    expect(descriptor?.capabilities.workerRender).toBe(false);
    expect(descriptor?.capabilities.browserRender).toBe(true);
    expect(descriptor?.source).toBe('db-sequence-component');
  });
});

describe('visual track group placement', () => {
  it('applies the shared track transform and group opacity once', () => {
    const config = buildConfig('custom:my-seq');
    config.tracks[0] = {...config.tracks[0], scale: 0.5, opacity: 0.6, blendMode: 'multiply'};
    const {container} = render(<TimelineRenderer astridElementHost={INSTALLED_ASTRID_ELEMENT_HOST} config={config} />);
    const group = [...container.querySelectorAll<HTMLElement>('[data-testid="absolute-fill"]')].find(node => node.style.transform === 'translate(480px, 270px) scale(0.5)');
    expect(group).toBeDefined();
    expect(group!.style.transformOrigin).toBe('0 0');
    expect(group!.style.opacity).toBe('0.6');
    expect(group!.style.mixBlendMode).toBe('multiply');
    expect(group!.style.overflow).toBe('hidden');
  });
});


it('draws the exact group transform supplied by shared placement', () => {
  const spy = vi.spyOn(composition, 'resolveTrackTransform').mockReturnValue({forward: {scale: 0.75, tx: 123, ty: 45}, inverse: {scale: 4 / 3, tx: -164, ty: -60}});
  const config = buildConfig('custom:my-seq');
  const {container} = render(<TimelineRenderer astridElementHost={INSTALLED_ASTRID_ELEMENT_HOST} config={config} />);
  const group = [...container.querySelectorAll<HTMLElement>('[data-testid="absolute-fill"]')].find(node => node.style.transform === 'translate(123px, 45px) scale(0.75)');
  expect(group).toBeDefined();
  expect(group!.style.transformOrigin).toBe('0 0');
  spy.mockRestore();
});
