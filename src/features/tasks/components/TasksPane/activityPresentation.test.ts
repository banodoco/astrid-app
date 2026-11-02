import { describe, expect, it } from 'vitest';
import type { Task as RuntimeTask } from '@/integrations/runtime/generated.ts';
import {
  runtimeActionErrorMessage,
  runtimeTaskDetail,
  runtimeTaskLabel,
  runtimeTaskModality,
  runtimeTaskProgress,
  runtimeTaskRelativeTime,
  runtimeTaskStateLabel,
} from './activityPresentation';

function task(overrides: Partial<RuntimeTask> & { progress?: unknown } = {}): RuntimeTask {
  return {
    task_id: 'task-1',
    run_id: 'run-1',
    project_id: 'project-1',
    state: 'running',
    version: 1,
    capability_id: 'generation.generate_video',
    capability_digest: 'sha256:capability',
    idempotency_key: 'admit:task-1',
    created_at: '2026-10-14T00:00:00Z',
    updated_at: '2026-10-14T00:00:01Z',
    runtime_epoch: 1,
    input_object_ids: [],
    spec: { spec: { family: 'generation.generate_video' } },
    ...overrides,
  };
}

describe('activityPresentation', () => {
  it('uses readable task and state labels', () => {
    expect(runtimeTaskLabel(task())).toBe('Video generation');
    expect(runtimeTaskLabel(task({ spec: { spec: { family: 'media.clip_extract' } } }))).toBe('Clip extraction');
    expect(runtimeTaskStateLabel('cancel_requested')).toBe('Stopping');
  });

  it('maps task families to a safe visual modality with a neutral fallback', () => {
    expect(runtimeTaskModality(task({ spec: { spec: { family: 'generation.generate_image' } } }))).toBe('image');
    expect(runtimeTaskModality(task({ spec: { spec: { family: 'generation.generate_video' } } }))).toBe('video');
    expect(runtimeTaskModality(task({ spec: { spec: { family: 'audio.transcribe' } } }))).toBe('audio');
    expect(runtimeTaskModality(task({ spec: { spec: { family: 'rendering.timeline_visualize' } } }))).toBe('render');
    expect(runtimeTaskModality(task({ spec: { spec: { family: 'vendor.unknown_action' } } }))).toBe('neutral');
  });

  it('only accepts bounded progress values supplied by Runtime', () => {
    expect(runtimeTaskProgress(task({ progress: { phase: 'Extracting', percent: 35.5, current: 2, total: 6 } })))
      .toEqual({ phase: 'Extracting', percent: 35.5, current: 2, total: 6 });
    expect(runtimeTaskProgress(task({ progress: { phase: '   ', percent: 50 } }))).toBeNull();
    expect(runtimeTaskProgress(task({ progress: { phase: 'Working', percent: 101 } }))).toBeNull();
    expect(runtimeTaskProgress(task({ progress: { phase: 'x'.repeat(65), percent: 50 } }))).toBeNull();
    expect(runtimeTaskProgress(task({ progress: { phase: 'Working', percent: 50, current: -1, total: 0 } })))
      .toEqual({ phase: 'Working', percent: 50 });
    expect(runtimeTaskProgress(task())).toBeNull();
  });

  it('labels every known capability and falls back without namespace, leading verb or repeats', () => {
    const labelFor = (capability_id: string) => runtimeTaskLabel(task({ capability_id, spec: {} }));
    expect(labelFor('chiptune.sfx')).toBe('Sound effect');
    expect(labelFor('chiptune.midi')).toBe('MIDI to chiptune');
    expect(labelFor('music.level')).toBe('Loudness check');
    expect(labelFor('music.beats')).toBe('Beat detection');
    expect(labelFor('generation.generate_speech')).toBe('Voice');
    expect(labelFor('rendering.render')).toBe('Render');
    expect(labelFor('f2.marker')).toBe('F2 Marker');
    expect(labelFor('generation.generate_foo')).toBe('Foo');
    expect(labelFor('vendor.make_thing_thing')).toBe('Thing');
    expect(labelFor('vendor.do_stuff')).toBe('Do stuff');
  });

  it('picks the most identifying human input and refuses ids, hashes and paths', () => {
    const detail = (capability_id: string, inputs: Record<string, unknown>) =>
      runtimeTaskDetail(task({ capability_id, spec: { spec: { inputs } } }));
    expect(detail('generation.generate_speech', { text: '  Hello   there ' })).toBe('Hello there');
    expect(detail('chiptune.sfx', { kind: 'typewriter_tick', variant: 3 })).toBe('Typewriter tick');
    expect(detail('music.level', { audio: { filename: 'song.mp3' } })).toBe('song.mp3');
    expect(detail('chiptune.compose', { duration_s: 167.4 })).toBe('2:47');
    expect(detail('capture.web_page', { url: 'https://github.com/a/b' })).toBe('github.com');
    expect(detail('rendering.timeline_visualize', { timeline_slug: '01M4GGKMHZ3J8V402C8CWSCE95' })).toBeNull();
    expect(detail('pixel.snap', { image: 'sha256:4a3dfeedbeef1234' })).toBeNull();
    expect(detail('generation.generate_speech', { text: '/private/var/folders/x' })).toBeNull();
  });

  it('formats relative times and plain action errors', () => {
    const now = Date.parse('2026-10-24T12:00:00');
    expect(runtimeTaskRelativeTime('2026-10-24T11:58:00', now)).toBe('2 min ago');
    expect(runtimeTaskRelativeTime('2026-10-24T09:00:00', now)).toBe('3 h ago');
    expect(runtimeTaskRelativeTime('2026-10-23T08:00:00', now)).toBe('Yesterday');
    expect(runtimeActionErrorMessage('export', 'conflict: root is not configured')).toBe("Couldn't export: root is not configured");
    expect(runtimeActionErrorMessage('cancel', 'Workspace task is gone')).toBe("Couldn't stop: Workspace task is gone");
  });
});
