import { ORIGINAL_640, type ParityCanvas } from './canvas';
import type { Task } from '../../../../src/integrations/runtime/generated';

export type RgbFrame = {
  readonly width: number;
  readonly height: number;
  readonly bytes: Buffer;
};

export type FrameComparison = {
  readonly frame: number;
  readonly pixels: number;
  readonly pixelsOutsideBound: number;
  readonly outsideBoundFraction: number;
  readonly maxChannelError: number;
  readonly meanChannelError: number;
};

type DiagnosticRecord = Record<string, unknown>;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
const SAFE_ERROR_TYPE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
// Locations are logical labels only; filesystem-looking paths are refused.
const SAFE_ERROR_LOCATION = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const SAFE_ERROR_CODE = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/;

function record(value: unknown): DiagnosticRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as DiagnosticRecord
    : null;
}

function safeField(value: unknown, pattern: RegExp, fallback: string): string {
  return typeof value === 'string' && pattern.test(value) ? value : fallback;
}

/**
 * Keep terminal task failures useful without copying the executor's message.
 * Runtime task results are extensible, so only these bounded scalar fields are
 * allowed into a comparison failure; arbitrary result/error data stays out.
 */
export function formatTerminalTaskFailure(task: Pick<Task, 'task_id' | 'attempt_id' | 'state' | 'result'>): string | null {
  if (task.state !== 'failed' && task.state !== 'cancelled') return null;
  const error = record(record(task.result)?.error);
  const stateCode = task.state === 'failed' ? 'task_failed' : 'task_cancelled';
  const errorType = safeField(error?.error_type ?? error?.type, SAFE_ERROR_TYPE, 'unknown');
  const errorLocation = safeField(error?.error_location ?? error?.location, SAFE_ERROR_LOCATION, 'unknown');
  const code = safeField(error?.code, SAFE_ERROR_CODE, stateCode);
  const taskId = safeField(task.task_id, SAFE_ID, 'unknown');
  const attemptId = safeField(task.attempt_id, SAFE_ID, 'unknown');
  return `Render task terminal failure: task_id=${taskId} attempt_id=${attemptId} error_type=${errorType} error_location=${errorLocation} code=${code}`;
}

export function compareRgbFrames(expected: RgbFrame, actual: RgbFrame, frame: number, canvas: ParityCanvas = ORIGINAL_640): FrameComparison {
  for (const [host, image] of [['Player', expected], ['export', actual]] as const) {
    if (image.width !== canvas.width || image.height !== canvas.height
      || image.bytes.length !== canvas.width * canvas.height * 3) {
      throw new Error(`frame ${frame}: invalid ${host} RGB frame dimensions/bytes: ${image.width}x${image.height}, ${image.bytes.length} bytes`);
    }
  }
  let pixelsOutsideBound = 0;
  let totalError = 0;
  let maxChannelError = 0;
  for (let offset = 0; offset < expected.bytes.length; offset += 3) {
    let pixelOutsideBound = false;
    for (let channel = 0; channel < 3; channel += 1) {
      const error = Math.abs(expected.bytes[offset + channel] - actual.bytes[offset + channel]);
      maxChannelError = Math.max(maxChannelError, error);
      totalError += error;
      if (error > 2) pixelOutsideBound = true;
    }
    if (pixelOutsideBound) pixelsOutsideBound += 1;
  }
  const pixels = expected.width * expected.height;
  return {
    frame,
    pixels,
    pixelsOutsideBound,
    outsideBoundFraction: pixelsOutsideBound / pixels,
    maxChannelError,
    meanChannelError: totalError / expected.bytes.length,
  };
}

export function assertFrameWithinBound(comparison: FrameComparison, canvas: ParityCanvas = ORIGINAL_640): void {
  if (!Number.isFinite(comparison.outsideBoundFraction) || comparison.pixels !== canvas.width * canvas.height) {
    throw new Error(`frame ${comparison.frame}: invalid comparison`);
  }
  if (comparison.outsideBoundFraction > 0.001) {
    throw new Error(`frame ${comparison.frame}: ${comparison.pixelsOutsideBound}/${comparison.pixels} pixels exceed 2/255; max channel error=${comparison.maxChannelError}/255, mean=${comparison.meanChannelError.toFixed(3)}/255`);
  }
}
