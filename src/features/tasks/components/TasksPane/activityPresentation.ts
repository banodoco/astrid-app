import { asRecord } from '@/shared/lib/typeCoercion';
import type { Task as RuntimeTask } from '@/integrations/runtime/generated.ts';

export interface RuntimeTaskProgress {
  phase: string;
  percent: number;
  current?: number;
  total?: number;
}

export type RuntimeTaskModality = 'image' | 'video' | 'audio' | 'render' | 'neutral';

const TASK_LABELS: Record<string, string> = {
  'rendering.render': 'Render',
  'rendering.timeline_visualize': 'Timeline preview',
  'generation.generate_speech': 'Voice',
  'generation.generate_image': 'Image generation',
  'generation.generate_image_codex': 'Image generation',
  'generation.generate_video': 'Video generation',
  'chiptune.sfx': 'Sound effect',
  'chiptune.compose': 'Chiptune music',
  'chiptune.midi': 'MIDI to chiptune',
  'music.level': 'Loudness check',
  'music.beats': 'Beat detection',
  'pixel.cutout': 'Cutout',
  'pixel.snap': 'Pixel snap',
  'pixel.sprites': 'Sprite sheet',
  'pixel.strip': 'Animation strip',
  'capture.web_page': 'Web capture',
  'media.clip_extract': 'Clip extraction',
  'f2.marker': 'F2 Marker',
};

const LEADING_VERBS = new Set(['generate', 'make', 'create', 'run', 'build']);

function runtimeTaskKey(task: RuntimeTask): string {
  const nested = asRecord(asRecord(task.spec)?.spec) ?? asRecord(task.spec);
  const family = nested?.family;
  return typeof family === 'string' && family.trim() ? family.trim() : task.capability_id;
}

/** "generation.generate_foo" -> "Foo": no namespace, no leading verb, no repeated word. */
function fallbackLabel(key: string): string {
  const parts = key.split('.').pop()?.split(/[_\-\s]+/).filter(Boolean) ?? [];
  if (parts.length > 1 && LEADING_VERBS.has(parts[0].toLowerCase())) parts.shift();
  const words = parts.filter((word, i) => i === 0 || word.toLowerCase() !== parts[i - 1].toLowerCase());
  const text = words.join(' ').toLowerCase();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Task';
}

export function runtimeTaskLabel(task: RuntimeTask): string {
  const key = runtimeTaskKey(task);
  return TASK_LABELS[key] ?? fallbackLabel(key);
}

function taskInputs(task: RuntimeTask): Record<string, unknown> {
  const nested = asRecord(asRecord(task.spec)?.spec) ?? asRecord(task.spec);
  return asRecord(nested?.inputs) ?? asRecord(nested?.params) ?? {};
}

/** Reject anything that reads like an id, hash or path rather than something a person typed or named. */
function humanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text || /sha256:|^\/|[\\/]{2}|[0-9a-f]{12,}/i.test(text)) return null;
  return text;
}

function fileName(value: unknown): string | null {
  const name = humanText(asRecord(value)?.filename);
  return name && !/^media-/i.test(name) ? name : null;
}

function clock(seconds: unknown): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  const whole = Math.round(seconds);
  return whole < 60 ? `${whole}s` : `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function hostOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { return new URL(value).host || null; } catch { return null; }
}

/** One muted line naming the most identifying human input, or null when there is none. */
export function runtimeTaskDetail(task: RuntimeTask): string | null {
  const inputs = taskInputs(task);
  switch (runtimeTaskKey(task)) {
    case 'generation.generate_speech': return humanText(inputs.text);
    case 'generation.generate_image':
    case 'generation.generate_image_codex':
    case 'generation.generate_video': return humanText(inputs.prompt);
    case 'rendering.render': return humanText(inputs.output_name);
    case 'chiptune.sfx': {
      const kind = humanText(inputs.kind)?.replace(/_/g, ' ');
      return kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : clock(inputs.duration_s);
    }
    case 'chiptune.compose': return clock(inputs.duration_s);
    case 'chiptune.midi': return fileName(inputs.midi) ?? clock(inputs.duration_s);
    case 'music.level':
    case 'music.beats': return fileName(inputs.audio);
    case 'pixel.cutout':
    case 'pixel.snap':
    case 'pixel.sprites': return fileName(inputs.image);
    case 'pixel.strip': return fileName(inputs.frame);
    case 'capture.web_page': return hostOf(inputs.url);
    default: return null;
  }
}

/** "2 min ago", "3 h ago", "Yesterday", then a short date. */
export function runtimeTaskRelativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const minutes = Math.floor(Math.max(0, now - then) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} h ago`;
  const dayStart = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);
  const days = Math.round((dayStart(now) - dayStart(then)) / 86_400_000);
  if (days <= 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Plain-language one-liner for a failed row action. */
export function runtimeActionErrorMessage(action: 'cancel' | 'retry' | 'export', message: string): string {
  const reason = message.replace(/^[a-z_]+:\s+/i, '').trim();
  const verb = action === 'cancel' ? 'stop' : action;
  return reason ? `Couldn't ${verb}: ${reason}` : `Couldn't ${verb}`;
}

export function runtimeTaskModality(task: RuntimeTask): RuntimeTaskModality {
  const spec = asRecord(task.spec);
  const nested = asRecord(spec?.spec) ?? spec;
  const family = nested?.family;
  const key = (typeof family === 'string' && family.trim() ? family : task.capability_id).toLowerCase();
  if (/audio|music|speech|voice|foley/.test(key)) return 'audio';
  if (/image|photo|still/.test(key)) return 'image';
  if (/video|clip/.test(key)) return 'video';
  if (/render|visualiz/.test(key)) return 'render';
  return 'neutral';
}

export function runtimeTaskProgress(task: RuntimeTask): RuntimeTaskProgress | null {
  const progress = asRecord((task as RuntimeTask & { progress?: unknown }).progress);
  if (!progress) return null;
  const phase = typeof progress.phase === 'string' ? progress.phase.trim() : '';
  const percent = progress.percent;
  if (!phase || phase.length > 64 || typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    return null;
  }
  const current = progress.current;
  const total = progress.total;
  const hasCurrent = typeof current === 'number' && Number.isFinite(current) && current >= 0;
  const hasTotal = typeof total === 'number' && Number.isFinite(total) && total > 0;
  return {
    phase,
    percent,
    ...(hasCurrent && hasTotal ? { current, total } : {}),
  };
}

export function runtimeTaskStateLabel(state: RuntimeTask['state']): string {
  const labels: Record<string, string> = {
    queued: 'Queued',
    ready: 'Ready',
    running: 'Running',
    cancel_requested: 'Stopping',
    retrying: 'Retrying',
    succeeded: 'Complete',
    failed: 'Failed',
    cancelled: 'Cancelled',
  };
  return labels[state] ?? 'Active';
}
