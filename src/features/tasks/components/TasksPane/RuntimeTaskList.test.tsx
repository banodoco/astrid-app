import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Task as RuntimeTask } from '@/integrations/runtime/generated.ts';
import { projectRuntimeTasksForTaskPane } from './hooks/useRuntimeTasks';
import { RuntimeTaskList } from './RuntimeTaskList';

function task(
  taskId: string,
  family: string,
  overrides: Partial<RuntimeTask> = {},
  inputs: Record<string, unknown> = {},
): RuntimeTask {
  return {
    task_id: taskId,
    run_id: `run-${taskId}`,
    project_id: 'runtime-project',
    state: 'succeeded',
    version: 2,
    capability_id: family,
    capability_digest: 'sha256:capability',
    idempotency_key: `admit:${taskId}`,
    created_at: '2026-10-14T00:00:00Z',
    updated_at: '2026-10-14T00:01:00Z',
    runtime_epoch: 4,
    input_object_ids: [`sha256:${taskId}`],
    spec: { spec: { inputs } },
    ...overrides,
  };
}

/** n tasks of one capability; later index = newer. */
function run(prefix: string, capability: string, n: number, startMinute = 0): RuntimeTask[] {
  return Array.from({ length: n }, (_, i) => {
    const stamp = `2026-10-14T01:${String(startMinute + i).padStart(2, '0')}:00Z`;
    return task(`${prefix}-${i}`, capability, { created_at: stamp, updated_at: stamp });
  });
}

function renderList(tasks: RuntimeTask[], props: Partial<React.ComponentProps<typeof RuntimeTaskList>> = {}) {
  const handlers = {
    onInspectTask: vi.fn(),
    onCancelTask: vi.fn(),
    onRetryTask: vi.fn(),
    onExportManagedOutput: vi.fn(),
    onDismissActionError: vi.fn(),
  };
  const view = render(
    <RuntimeTaskList
      tasks={tasks}
      isLoading={false}
      error={null}
      actionFailures={{}}
      exportedTo={{}}
      isTaskActionPending={() => false}
      isExportTaskPending={() => false}
      timelineId={null}
      {...handlers}
      {...props}
    />,
  );
  return { ...view, ...handlers };
}

const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-runtime-task-row="true"]'));

describe('RuntimeTaskList', () => {
  it('opens the inspector from the whole row with the row anchor, and from the keyboard', () => {
    const { onInspectTask } = renderList([task('completed-task', 'media.clip_extract')]);
    const row = screen.getByRole('button', { name: 'Clip extraction activity details' });
    expect(screen.queryByText('Inspect')).not.toBeInTheDocument();
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
      top: 150, right: 680, bottom: 200, left: 500, width: 180, height: 50,
      x: 500, y: 150, toJSON: () => ({}),
    });
    fireEvent.click(row);
    expect(onInspectTask).toHaveBeenCalledWith('completed-task', { top: 150, right: 680 });
    expect(row).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onInspectTask).toHaveBeenCalledTimes(2);
  });

  it('shows the complete state, a relative time, and a human detail line', () => {
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    renderList([task('v', 'generation.generate_speech', { updated_at: recent }, { text: 'Well, it was cool.', voice: 'en-US-Andrew' })]);
    expect(screen.getByText('Complete')).toBeVisible();
    expect(screen.getByText('Voice')).toBeInTheDocument();
    expect(screen.getByText('Well, it was cool.')).toBeInTheDocument();
    expect(screen.getByText('5 min ago')).toBeInTheDocument();
  });

  it('never shows ids, hashes or paths as the detail line', () => {
    renderList([task('s', 'pixel.snap', {}, { image: 'sha256:4a3dfeedbeef1234' }), task('c', 'pixel.cutout', {}, { image: { filename: 'media-0a6d9eb54aa9.png' } })]);
    expect(document.body.textContent).not.toMatch(/sha256|media-0a6d/);
  });

  it('collapses consecutive same-label tasks newest first and expands to inspectable members', () => {
    const { onInspectTask } = renderList([
      ...run('level', 'music.level', 6),
      ...run('beat', 'music.beats', 1, 10),
    ]);
    expect(rows()).toHaveLength(2);
    expect(screen.getByText('Beat detection')).toBeInTheDocument();
    const group = screen.getByRole('button', { name: 'Loudness check, 6 tasks' });
    expect(group).toHaveTextContent('×6');
    expect(group).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(group);
    expect(group).toHaveAttribute('aria-expanded', 'true');
    expect(rows()).toHaveLength(8);
    const members = rows().filter((row) => row.dataset.runtimeTaskId?.startsWith('level-'));
    expect(members[1].dataset.runtimeTaskId).toBe('level-5');
    fireEvent.click(within(members[1]).getByText('Loudness check'));
    expect(onInspectTask).toHaveBeenCalledWith('level-5', expect.any(Object));
  });

  it('does not collapse across different labels', () => {
    renderList([
      task('a1', 'music.level', { updated_at: '2026-10-14T01:00:00Z' }),
      task('b', 'music.beats', { updated_at: '2026-10-14T01:01:00Z' }),
      task('a2', 'music.level', { updated_at: '2026-10-14T01:02:00Z' }),
    ]);
    expect(rows().map((row) => row.dataset.runtimeTaskId)).toEqual(['a2', 'b', 'a1']);
  });

  it('collapses failures only with the same label and state, and puts active then failed first', () => {
    renderList([
      ...run('done', 'music.level', 1, 0),
      task('f1', 'music.beats', { state: 'failed', updated_at: '2026-10-14T00:10:00Z' }),
      task('f2', 'music.beats', { state: 'failed', updated_at: '2026-10-14T00:11:00Z' }),
      task('c1', 'music.beats', { state: 'cancelled', updated_at: '2026-10-14T00:12:00Z' }),
      task('run1', 'generation.generate_speech', { state: 'running', updated_at: '2020-01-01T00:00:00Z' }),
    ]);
    const order = rows().map((row) => row.dataset.runtimeTaskId);
    expect(order).toEqual(['run1', 'c1', 'f2', 'done-0']);
    expect(screen.getByRole('button', { name: 'Beat detection, 2 tasks' })).toHaveTextContent('Failed');
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
  });

  it('shows the newest 6 history groups and the rest behind a Show N older toggle', () => {
    const alternating = Array.from({ length: 10 }, (_, i) => task(`t${i}`, i % 2 ? 'music.beats' : 'music.level', {
      updated_at: `2026-10-14T01:${String(i).padStart(2, '0')}:00Z`,
    }));
    renderList(alternating);
    expect(rows()).toHaveLength(6);
    fireEvent.click(screen.getByRole('button', { name: 'Show 4 older' }));
    expect(rows()).toHaveLength(10);
    expect(screen.getByRole('button', { name: 'Hide older' })).toBeInTheDocument();
  });

  it('shows an empty state', () => {
    renderList([]);
    expect(screen.getByText('No tasks yet')).toBeInTheDocument();
  });

  it('keeps the newest exportable render visible even when it is older than 6 groups', () => {
    const render1 = task('old-render', 'rendering.render', { updated_at: '2026-10-14T00:00:00Z' }, { timeline_ref: 'tl-1', output_name: 'cut.mp4' });
    const others = Array.from({ length: 8 }, (_, i) => task(`o${i}`, i % 2 ? 'music.beats' : 'music.level', {
      updated_at: `2026-10-14T01:${String(i).padStart(2, '0')}:00Z`,
    }));
    const { onExportManagedOutput } = renderList([render1, ...others], { timelineId: 'tl-1' });
    expect(rows()).toHaveLength(7);
    expect(screen.getByText('cut.mp4')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Export Render/ }));
    expect(screen.getByText('Export')).toBeInTheDocument();
    expect(screen.queryByText('Export managed output')).not.toBeInTheDocument();
    expect(onExportManagedOutput).toHaveBeenCalledWith('old-render', 'tl-1');
  });

  it('does not offer export for renders of another timeline', () => {
    renderList([task('r', 'rendering.render', {}, { timeline_ref: 'other' })], { timelineId: 'tl-1' });
    expect(screen.queryByText('Export')).not.toBeInTheDocument();
  });

  it('keeps button clicks from opening the inspector', () => {
    const { onCancelTask, onInspectTask } = renderList([task('r', 'music.level', { state: 'running' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Loudness check' }));
    expect(onCancelTask).toHaveBeenCalledWith('r');
    expect(onInspectTask).not.toHaveBeenCalled();
  });

  it('shows an action error on its own row in plain language, and dismisses it', () => {
    const { onDismissActionError, onInspectTask } = renderList([task('r', 'rendering.render'), task('other', 'music.level')], {
      actionFailures: { r: { action: 'export', message: 'conflict: managed-output export root is not configured' } },
    });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("Couldn't export: managed-output export root is not configured");
    expect(alert).not.toHaveTextContent(/conflict:|Runtime task/);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(onDismissActionError).toHaveBeenCalledWith('r');
    expect(onInspectTask).not.toHaveBeenCalled();
  });

  it('shows where an export was saved, with the full location in a tooltip', () => {
    renderList([task('r', 'rendering.render', {}, { timeline_ref: 'tl-1' })], {
      timelineId: 'tl-1',
      exportedTo: { r: { label: 'Astrid exports/cut.mp4', title: '/Users/me/Downloads/Astrid exports/cut.mp4' } },
    });
    const line = screen.getByText('Saved to Astrid exports/cut.mp4');
    expect(line).toHaveAttribute('title', '/Users/me/Downloads/Astrid exports/cut.mp4');
    expect(line.className).toContain('truncate');
  });

  it('keeps a narrow row from wrapping under its buttons', () => {
    renderList([task('r', 'rendering.render', {}, { timeline_ref: 'tl-1', output_name: 'a-very-long-render-name-for-a-narrow-sidebar.mp4' })], { timelineId: 'tl-1' });
    const label = screen.getByText('Render');
    expect(label.className).toContain('truncate');
    expect(label.parentElement!.className).toContain('min-w-0');
    expect(label.parentElement!.className).toContain('flex-1');
    expect(screen.getByRole('button', { name: /^Export Render/ }).parentElement!.className).toContain('shrink-0');
    expect(screen.getByText('a-very-long-render-name-for-a-narrow-sidebar.mp4').className).toContain('truncate');
  });

  it('renders generation tasks and omits media imports by family or capability', () => {
    const mediaImportFamily = task('import-family-id', 'astrid.media-import-worker', { spec: { spec: { family: 'runtime.media.import.v1' } } });
    const mediaImportCapability = task('import-capability-id', 'runtime.media.import.v1');
    renderList(projectRuntimeTasksForTaskPane([
      mediaImportFamily,
      mediaImportCapability,
      task('image-task-id', 'generation.generate_image'),
      task('video-task-id', 'generation.generate_video'),
    ]));
    expect(screen.queryByText('runtime.media.import.v1')).not.toBeInTheDocument();
    expect(screen.getAllByText('Image generation')).toHaveLength(1);
    expect(screen.getByText('Video generation')).toBeInTheDocument();
    expect(screen.queryByText('image-task-id')).not.toBeInTheDocument();
  });
});
