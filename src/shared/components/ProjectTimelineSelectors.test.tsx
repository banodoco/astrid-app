// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ProjectTimelinePicker } from '@/shared/components/ProjectTimelineSelectors.tsx';

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn();
});

describe('ProjectTimelinePicker', () => {
  it('offers Export only on the current row and pins Import below New timeline', async () => {
    const onExportTimeline = vi.fn();
    const onImportTimeline = vi.fn();
    const onCreateTimeline = vi.fn();
    render(<ProjectTimelinePicker
      projects={[]}
      timelines={[{ id: 'current', name: 'Main Cut' }, { id: 'other', name: 'Alt Cut' }]}
      projectId="project-id"
      timelineId="current"
      onSelectProject={vi.fn()}
      onSelectTimeline={vi.fn()}
      onCreateTimeline={onCreateTimeline}
      onExportTimeline={onExportTimeline}
      onImportTimeline={onImportTimeline}
    />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Select timeline' }));
    const currentRow = await screen.findByRole('option', { name: /Main Cut/ });
    const otherRow = screen.getByRole('option', { name: /Alt Cut/ });
    expect(within(currentRow).getByRole('button', { name: 'Export timeline' })).toBeInTheDocument();
    expect(within(otherRow).queryByRole('button', { name: 'Export timeline' })).toBeNull();
    await user.click(within(currentRow).getByRole('button', { name: 'Export timeline' }));
    expect(onExportTimeline).toHaveBeenCalledWith('current', 'Main Cut');
    expect(onCreateTimeline).not.toHaveBeenCalled();
    const create = screen.getByRole('button', { name: 'New timeline' });
    const importAction = screen.getByRole('button', { name: 'Import timeline…' });
    expect(create.compareDocumentPosition(importAction) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Import timeline archive'), { target: { files: [new File(['zip'], 'timeline.astrid')] } });
    expect(onImportTimeline).toHaveBeenCalledWith(expect.objectContaining({ name: 'timeline.astrid' }));
  });

  it('shows project and timeline names with the primary indicator', async () => {
    render(
      <ProjectTimelinePicker
        projects={[{ id: 'project-id', name: 'Project Name', detail: 'project-slug' }]}
        timelines={[
          { id: 'timeline-id', name: 'Main Cut', detail: 'edited 5 minutes ago', isPrimary: true },
          { id: 'shot-id', name: 'Shot 1', detail: 'shot-001' },
        ]}
        projectId="project-id"
        timelineId="timeline-id"
        onSelectProject={vi.fn()}
        onSelectTimeline={vi.fn()}
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Select project' })).toHaveTextContent('Project Name');
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Select timeline' }));
    const primaryRow = await screen.findByRole('option', { name: /Main Cut/ });
    expect(within(primaryRow).getByRole('img', { name: 'Primary timeline' })).toBeInTheDocument();
    const shotRow = screen.getByRole('option', { name: /Shot 1/ });
    expect(shotRow).toBeInTheDocument();
    expect(within(shotRow).queryByRole('img', { name: 'Primary timeline' })).toBeNull();
  });

  it('offers an explicit direct-to-file Save as action for the selected timeline', async () => {
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: vi.fn() });
    try {
      const onExportTimeline = vi.fn();
      render(<ProjectTimelinePicker projects={[]} timelines={[{ id: 'current', name: 'Main Cut' }]}
        projectId="p" timelineId="current" onSelectProject={vi.fn()} onSelectTimeline={vi.fn()} onExportTimeline={onExportTimeline} />);
      const user = userEvent.setup();
      await user.click(screen.getByRole('combobox', { name: 'Select timeline' }));
      await user.click(screen.getByRole('button', { name: 'Save timeline as… (direct to file)' }));
      expect(onExportTimeline).toHaveBeenCalledWith('current', 'Main Cut', true);
    } finally { Reflect.deleteProperty(window, 'showSaveFilePicker'); }
  });

  it('creates the first timeline from an empty list and disables while creating', async () => {
    const onCreateTimeline = vi.fn();
    const view = render(
      <ProjectTimelinePicker
        projects={[]}
        timelines={[]}
        projectId="project-id"
        timelineId={null}
        onSelectProject={vi.fn()}
        onSelectTimeline={vi.fn()}
        onCreateTimeline={onCreateTimeline}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Select timeline' }));
    expect(await screen.findByText('No timelines yet.')).toBeInTheDocument();
    // With no rows there is no search field to type into.
    expect(screen.queryByPlaceholderText('Search timelines…')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'New timeline' }));
    expect(onCreateTimeline).toHaveBeenCalledTimes(1);
    view.rerender(
      <ProjectTimelinePicker
        projects={[]}
        timelines={[]}
        projectId="project-id"
        timelineId={null}
        onSelectProject={vi.fn()}
        onSelectTimeline={vi.fn()}
        onCreateTimeline={onCreateTimeline}
        creatingTimeline
      />,
    );
    await user.click(screen.getByRole('combobox', { name: 'Select timeline' }));
    expect(await screen.findByRole('button', { name: 'Creating timeline…' })).toBeDisabled();
  });

  it('pins New timeline as a footer action under the timeline list', async () => {
    const onCreateTimeline = vi.fn();
    render(
      <ProjectTimelinePicker
        projects={[]}
        timelines={[
          { id: 'timeline-1', name: 'Intro Cut' },
          { id: 'timeline-2', name: 'Alt Cut' },
        ]}
        projectId="project-id"
        timelineId="timeline-1"
        onSelectProject={vi.fn()}
        onSelectTimeline={vi.fn()}
        onCreateTimeline={onCreateTimeline}
      />,
    );
    // No caption and no second button beside the picker: the combobox names itself.
    expect(screen.queryByRole('button', { name: 'New timeline' })).toBeNull();
    expect(screen.queryByText('Timeline')).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Select timeline' }));
    // Still offered while a search hides every row.
    await user.type(await screen.findByPlaceholderText('Search timelines…'), 'zzz');
    expect(screen.getByText('No timelines found.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New timeline' }));
    expect(onCreateTimeline).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'New timeline' })).toBeNull();
  });

  it('retries discovery and selects canonical primary timeline IDs', async () => {
    const onRetry = vi.fn();
    const onSetPrimaryTimeline = vi.fn();
    render(
      <ProjectTimelinePicker
        projects={[]}
        timelines={[{ id: 'canonical-id', name: 'Alt Cut' }]}
        projectId={null}
        timelineId={null}
        projectsError="Runtime offline"
        onRetry={onRetry}
        onSelectProject={vi.fn()}
        onSelectTimeline={vi.fn()}
        onSetPrimaryTimeline={onSetPrimaryTimeline}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Select project' }));
    await user.click(await screen.findByRole('button', { name: 'Retry connection' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('combobox', { name: 'Select timeline' }));
    await user.click(await screen.findByRole('button', { name: 'Make Alt Cut primary' }));
    expect(onSetPrimaryTimeline).toHaveBeenCalledWith('canonical-id');
  });

  it('renames the selected timeline without selecting it', async () => {
    const onSelectTimeline = vi.fn();
    const onRenameTimeline = vi.fn(async () => undefined);
    render(
      <ProjectTimelinePicker
        projects={[]}
        timelines={[{ id: 'timeline-1', name: 'Intro Cut' }]}
        projectId={null}
        timelineId="timeline-1"
        onSelectProject={vi.fn()}
        onSelectTimeline={onSelectTimeline}
        onRenameTimeline={onRenameTimeline}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Select timeline' }));
    await user.click(await screen.findByRole('button', { name: 'Rename timeline' }));
    const input = await screen.findByRole('textbox', { name: 'Timeline name' });
    fireEvent.change(input, { target: { value: '  Opening Cut  ' } });
    fireEvent.submit(input.closest('form')!);
    expect(onRenameTimeline).toHaveBeenCalledWith('timeline-1', 'Opening Cut');
    expect(onSelectTimeline).not.toHaveBeenCalled();
  });

  it('marks only the primary timeline row with a labelled star on the right', async () => {
    render(
      <ProjectTimelinePicker
        projects={[]}
        timelines={[
          { id: 'main', name: 'Main Cut', isPrimary: true },
          { id: 'alt', name: 'Alt Cut' },
        ]}
        projectId={null}
        timelineId="alt"
        onSelectProject={vi.fn()}
        onSelectTimeline={vi.fn()}
        onSetPrimaryTimeline={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Select timeline' }));
    const primaryRow = await screen.findByRole('option', { name: /Main Cut/ });
    // The star sits in the right-hand action cluster and is always visible (no hover reveal).
    const mark = within(primaryRow).getByRole('img', { name: 'Primary timeline' });
    expect(mark.closest('.ml-auto')).not.toBeNull();
    expect(mark.className).not.toMatch(/opacity-0/);
    // The tick column is present but hidden, since this row is not the current one.
    expect(primaryRow.querySelector('svg.lucide-check')).toHaveClass('opacity-0');

    // The other row has no star, only a hover-revealed "Make Alt Cut primary" button.
    const otherRow = screen.getByRole('option', { name: /Alt Cut/ });
    expect(within(otherRow).queryByRole('img', { name: 'Primary timeline' })).toBeNull();
    expect(within(otherRow).getByRole('button', { name: 'Make Alt Cut primary' })).toBeInTheDocument();
    // The primary row has no "make primary" action of its own.
    expect(within(primaryRow).queryByRole('button', { name: /primary/ })).toBeNull();
  });

  it('shows the selected tick and the primary star together when the selected timeline is primary', async () => {
    const { rerender } = render(
      <ProjectTimelinePicker
        projects={[]}
        timelines={[{ id: 'main', name: 'Main Cut', isPrimary: true }, { id: 'alt', name: 'Alt Cut' }]}
        projectId={null}
        timelineId="main"
        onSelectProject={vi.fn()}
        onSelectTimeline={vi.fn()}
      />,
    );
    // The closed trigger carries the same star for the current primary timeline.
    expect(within(screen.getByRole('combobox', { name: 'Select timeline' })).getByRole('img', { name: 'Primary timeline' })).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Select timeline' }));
    const row = await screen.findByRole('option', { name: /Main Cut/ });
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(row.querySelector('svg.lucide-check')).not.toBeNull();
    expect(within(row).getByRole('img', { name: 'Primary timeline' })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    rerender(
      <ProjectTimelinePicker
        projects={[]}
        timelines={[{ id: 'main', name: 'Main Cut', isPrimary: true }, { id: 'alt', name: 'Alt Cut' }]}
        projectId={null}
        timelineId="alt"
        onSelectProject={vi.fn()}
        onSelectTimeline={vi.fn()}
      />,
    );
    // A non-primary selection shows no star on the trigger.
    expect(within(screen.getByRole('combobox', { name: 'Select timeline' })).queryByRole('img', { name: 'Primary timeline' })).toBeNull();
  });
});
