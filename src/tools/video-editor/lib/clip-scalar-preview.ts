import type { TimelinePatch, TimelineDiffEntry } from '@/sdk/video/timeline/patch.ts';
import { assembleTimelineData, type TimelineData } from './timeline-data.ts';
import type { TimelinePatchCompileResult } from './timeline-patch.ts';
/** Local scalar previews bypass the lossy row serializer; the durable command owns the write. */
export function compileClipScalarPreview(patch: TimelinePatch, data: TimelineData): TimelinePatchCompileResult {
  const entries: TimelineDiffEntry[] = [];
  const clips = data.config.clips.map((clip) => ({ ...clip }));
  for (const [index, op] of patch.operations.entries()) {
    const matches = clips.filter((clip) => clip.id === op.target);
    if (op.op !== 'clip.update' || op.clear === undefined || matches.length !== 1 || op.order !== undefined
      || Object.keys(op.payload ?? {}).some((key) => key !== 'hold')
      || ('hold' in (op.payload ?? {}) && (typeof op.payload!.hold !== 'number'
        || !Number.isFinite(op.payload!.hold) || op.payload!.hold <= 0))) {
      return { valid: false, nextData: null, mutation: null,
        diff: { version: patch.version, entries: [], affectedObjectIds: [] },
        diagnostics: [{ severity: 'error', code: 'timeline-patch/invalid-payload',
          message: 'Scalar preview requires one existing clip and only scalar leaf changes', operationIndex: index }] };
    }
    const clip = matches[0];
    const before = { ...clip };
    Object.assign(clip, op.payload);
    for (const key of op.clear) delete clip[key];
    entries.push({ granularity: 'clip', kind: 'modified', target: op.target, op: op.op, before, after: { ...clip } });
  }
  const resolvedClips = data.resolvedConfig.clips.map((clip) => {
    const next = { ...clip };
    for (const op of patch.operations.filter((operation) => operation.target === clip.id)) {
      Object.assign(next, op.payload);
      for (const key of op.clear!) delete next[key];
      if (op.clear!.includes('asset')) delete next.assetEntry;
    }
    return next;
  });
  const nextData = assembleTimelineData({ ...data, config: { ...data.config, clips },
    resolvedConfig: { ...data.resolvedConfig, clips: resolvedClips } });
  nextData.clipOrder = data.clipOrder;
  return { valid: true, mutation: null, nextData,
    diff: { version: patch.version, entries, affectedObjectIds: [...new Set(entries.map((entry) => entry.target))] },
    diagnostics: [] };
}
