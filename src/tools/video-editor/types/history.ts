import type { AssetRegistry, TimelineConfig } from './index.ts';
import type { TimelineData } from '../lib/timeline-data.ts';

export type UndoSnapshot = {
  config: TimelineConfig;
  registry?: AssetRegistry;
  sourceItemsBySchemaRef?: TimelineData['sourceItemsBySchemaRef'];
  signature: string;
};

export type UndoEntry = {
  snapshot: UndoSnapshot;
  timestamp: string;
  label?: string;
  transactionId?: string;
};

export type CheckpointTriggerType =
  | 'session_boundary'
  | 'edit_distance'
  | 'semantic'
  | 'manual';

export type Checkpoint = {
  id: string;
  timelineId: string;
  config: TimelineConfig;
  registry?: AssetRegistry;
  sourceItemsBySchemaRef?: TimelineData['sourceItemsBySchemaRef'];
  createdAt: string;
  triggerType: CheckpointTriggerType;
  label: string;
  editsSinceLastCheckpoint: number;
};
