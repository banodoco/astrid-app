/** A test-only Runtime timeline scope. */
export type TimelineScope = Readonly<{
  projectId: string;
  timelineId: string;
}>;

export type TimelineListItem = Readonly<{
  timeline_id: string;
  is_shot?: boolean;
}>;

export type TimelineListPage = Readonly<{
  items: readonly TimelineListItem[];
}>;

/** Build a Runtime timeline path from the scope chosen by the test. */
export function timelineBase(scope: TimelineScope): string {
  return `/v1/projects/${scope.projectId}/timelines/${scope.timelineId}`;
}

/** Select the exact canonical resource already chosen by the UI. */
export function timelineFromList(page: TimelineListPage, timelineId: string): TimelineListItem | undefined {
  return page.items.find((timeline) => timeline.timeline_id === timelineId);
}
