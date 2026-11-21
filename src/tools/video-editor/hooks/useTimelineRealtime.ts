import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { realtimeEventProcessor } from '@/shared/realtime/RealtimeEventProcessor.ts';
import { assetRegistryQueryKey, timelineQueryKey } from '@/tools/video-editor/hooks/useTimeline.ts';
import { timelineListQueryKey } from '@/tools/video-editor/hooks/useTimelinesList.ts';

/** Keeps the timeline queries fresh when the Runtime announces that this timeline changed. */
export function useTimelineRealtime({ timelineId }: { timelineId: string }) {
  const queryClient = useQueryClient();

  useEffect(() => {
    return realtimeEventProcessor.onEvent((event) => {
      if (event.type !== 'timelines-updated') {
        return;
      }

      const matching = event.timelines.find((timeline) => timeline.id === timelineId);
      if (!matching) {
        return;
      }

      void queryClient.invalidateQueries({ queryKey: timelineQueryKey(timelineId) });
      void queryClient.invalidateQueries({ queryKey: assetRegistryQueryKey(timelineId) });
      void queryClient.invalidateQueries({ queryKey: timelineListQueryKey(matching.projectId) });
    });
  }, [queryClient, timelineId]);
}
