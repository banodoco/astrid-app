import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { compositionPublication, makePng, REPO_ROOT, RUNTIME_CHECKOUT, runtimePython, type DirectHarness } from '../../local/support/harness';
import { generatePlayableVideo, mediaHash, PARITY_FPS, PARITY_HEIGHT, PARITY_WIDTH } from './media';
import { ORIGINAL_640, type ParityCanvas } from './canvas';

export { PARITY_FPS, PARITY_HEIGHT, PARITY_WIDTH } from './media';
export const PARITY_FRAMES = [0, 37, 44, 45, 52, 89, 90, 120, 121, 135, 143, 164] as const;
const exec = promisify(execFile);

interface Revision {
  revision_id: string;
  content_digest: string;
  payload: Record<string, unknown>;
  internal_timeline_revision_id?: string;
  shot_id?: string;
}
interface MediaPin { objectId: string; digest: string }
export interface NativeFrameParitySetup {
  projectId: string;
  timelineId: string;
  head: { revision_id: string; publication_id: string };
  document: {
    parent_revision: Revision;
    shot_revisions: Revision[];
    internal_timeline_revisions: Revision[];
    dependency_manifest: { media: Array<{ media_id: string; content_digest: string }> };
  };
  media: Array<MediaPin & { name: string }>;
  sourceVideoMetadata: Awaited<ReturnType<typeof generatePlayableVideo>>['metadata'];
  sourceAudioMetadata: {
    streams: Array<{ codec_type?: string; codec_name?: string; sample_rate?: string; channels?: number; channel_layout?: string }>;
    format: { duration?: string };
  };
}
const nativeSetupByHarness = new WeakMap<DirectHarness, NativeFrameParitySetup>();
export interface FrameParityFixture {
  projectId: string;
  timelineId: string;
  headRevisionId: string;
  shotId: string;
  occurrenceId: string;
  shotRevisionId: string;
  internalRevisionId: string;
  parent: Revision;
  shot: Revision;
  internal: Revision;
  media: Array<MediaPin & { name?: string }>;
  sourceVideoMediaId: string;
  sourceVideoMetadata: Awaited<ReturnType<typeof generatePlayableVideo>>['metadata'];
  sourceAudioMetadata?: NativeFrameParitySetup['sourceAudioMetadata'];
}

export async function readRuntimeJson<T>(harness: DirectHarness, path: string): Promise<T> {
  const response = await harness.runtimeJson<T>('GET', path);
  assert.equal(response.status, 200, `GET ${path}: ${JSON.stringify(response.body)}`);
  return response.body;
}

export function timelineBase(fixture: Pick<FrameParityFixture, 'projectId' | 'timelineId'>): string {
  return `/v1/projects/${fixture.projectId}/timelines/${fixture.timelineId}`;
}

export async function prepareNativeFrameParityRealm(harness: DirectHarness, canvas: ParityCanvas): Promise<NativeFrameParitySetup> {
  const directory = join(harness.tmp, 'native-frame-parity');
  await mkdir(directory, { recursive: true });
  const imagePath = join(directory, 'gradient.png');
  const audioPath = join(directory, 'tone.wav');
  const image = makePng();
  await writeFile(imagePath, image);
  const source = await generatePlayableVideo(directory);
  await exec('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1',
    '-ac', '2', '-c:a', 'pcm_s16le', '-threads', '1', audioPath]);
  const audio = await readFile(audioPath);
  const { stdout: audioProbe } = await exec('ffprobe', [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', audioPath,
  ]);
  const sourceAudioMetadata = JSON.parse(audioProbe) as NativeFrameParitySetup['sourceAudioMetadata'];
  assert.equal(sourceAudioMetadata.streams.length, 1);
  assert.equal(sourceAudioMetadata.streams[0]?.codec_name, 'pcm_s16le');
  assert.equal(sourceAudioMetadata.streams[0]?.codec_type, 'audio');
  assert.equal(sourceAudioMetadata.streams[0]?.sample_rate, '44100');
  assert.equal(sourceAudioMetadata.streams[0]?.channels, 2);
  assert.equal(Number(sourceAudioMetadata.format.duration), 1);
  const media = [
    { name: 'image', path: imagePath, media_type: 'image/png', original_name: 'gradient.png', bytes: image },
    { name: 'video', path: source.path, media_type: 'video/webm', original_name: 'frame-marked.webm', bytes: source.bytes },
    { name: 'audio', path: audioPath, media_type: 'audio/wav', original_name: 'tone.wav', bytes: audio },
  ].map(({ bytes, ...item }) => ({ ...item, digest: mediaHash(bytes) }));
  const specPath = join(directory, 'native-fixture.json');
  const spec = {
    realm_dir: harness.realmDir,
    project_slug: `frame-parity-${randomUUID().slice(0, 8)}`,
    timeline_id: randomUUID(),
    parent_revision_id: randomUUID(),
    shot_id: 'frame-parity-shot',
    occurrence_id: 'frame-parity-occurrence',
    shot_revision_id: randomUUID(),
    internal_revision_id: randomUUID(),
    width: canvas.width,
    height: canvas.height,
    fps: PARITY_FPS,
    ...('themeCanvas' in canvas ? { theme_canvas: canvas.themeCanvas } : {}),
    media,
  };
  await writeFile(specPath, JSON.stringify(spec));
  const python = runtimePython();
  const agent = process.env.ASTRID_CHECKOUT;
  if (!python || !agent) throw new Error('native frame fixture requires Runtime Python and ASTRID_CHECKOUT');
  const helper = fileURLToPath(new URL('./native-fixture-helper.py', import.meta.url));
  const { stdout } = await exec(python, [helper, specPath], {
    cwd: REPO_ROOT,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1',
      PYTHONPATH: [RUNTIME_CHECKOUT, agent, process.env.PYTHONPATH].filter(Boolean).join(delimiter) },
    maxBuffer: 8 * 1024 * 1024,
  });
  const prepared = JSON.parse(stdout.trim()) as Omit<NativeFrameParitySetup, 'sourceVideoMetadata' | 'sourceAudioMetadata'>;
  const result = { ...prepared, sourceVideoMetadata: source.metadata, sourceAudioMetadata };
  nativeSetupByHarness.set(harness, result);
  return result;
}

export function nativeFrameParitySetup(harness: DirectHarness): NativeFrameParitySetup {
  const setup = nativeSetupByHarness.get(harness);
  if (!setup) throw new Error('native frame parity setup was not prepared before Runtime startup');
  return setup;
}

async function readClosure(harness: DirectHarness, fixture: Pick<FrameParityFixture,
  'projectId' | 'timelineId' | 'headRevisionId' | 'shotId' | 'shotRevisionId' | 'internalRevisionId'>) {
  type PublicRevision = Revision & { project_id: string; timeline_id?: string; shot_id?: string };
  const [parent, shot, internal] = await Promise.all([
    readRuntimeJson<PublicRevision>(harness, `${timelineBase(fixture)}/composition-revisions/${fixture.headRevisionId}`),
    readRuntimeJson<PublicRevision>(harness, `/v1/projects/${fixture.projectId}/shots/${fixture.shotId}/revisions/${fixture.shotRevisionId}`),
    readRuntimeJson<PublicRevision>(harness, `${timelineBase(fixture)}/revisions/${fixture.internalRevisionId}`),
  ]);
  for (const revision of [parent, shot, internal]) assert.equal(revision.project_id, fixture.projectId);
  assert.equal(parent.timeline_id, fixture.timelineId);
  assert.equal(shot.shot_id, fixture.shotId);
  assert.equal(internal.timeline_id, fixture.timelineId);
  // Authoring startup may add a verified baseline manifest to read metadata;
  // compare immutable identity/payload rather than that derived read decoration.
  const immutable = (revision: Revision): Revision => ({
    revision_id: revision.revision_id, content_digest: revision.content_digest, payload: revision.payload,
    ...(revision.internal_timeline_revision_id ? { internal_timeline_revision_id: revision.internal_timeline_revision_id } : {}),
  });
  return { parent: immutable(parent), shot: immutable(shot), internal: immutable(internal) };
}

/** Existing M1 fixture setup before authoring/Render; not an authoring-path proof. */
export async function prepareFrameParityFixture(harness: DirectHarness, canvas: ParityCanvas = ORIGINAL_640,
  nativeSetup?: NativeFrameParitySetup): Promise<FrameParityFixture> {
  if (nativeSetup) {
    const { projectId, timelineId, head, document } = nativeSetup;
    const parent = document.parent_revision;
    const request = {
      api_version: 1,
      project_id: projectId,
      timeline_id: timelineId,
      base_revision_id: head.revision_id,
      base_publication_id: head.publication_id,
      commands: [{ schema_version: 1, op: 'timeline.restore', version: '1', select: null,
        args: { revision_id: parent.revision_id, content_digest: parent.content_digest } }],
    };
    const restored = await harness.runtimeJson<{ data: { accepted_revision_id: string; canonical_document: unknown } }>(
      'POST', `/v1/projects/${projectId}/timelines/${timelineId}/commit`, request);
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.data.accepted_revision_id, parent.revision_id);
    assert.deepEqual(restored.body.data.canonical_document, document);
    const pins = {
      projectId, timelineId, headRevisionId: parent.revision_id,
      shotId: nativeSetup.document.shot_revisions[0].shot_id!,
      occurrenceId: 'frame-parity-occurrence',
      shotRevisionId: nativeSetup.document.shot_revisions[0].revision_id,
      internalRevisionId: nativeSetup.document.internal_timeline_revisions[0].revision_id,
    };
    const closure = await readClosure(harness, pins);
    const fixture = { ...pins, ...closure, media: nativeSetup.media,
      sourceVideoMediaId: nativeSetup.media.find(pin => pin.name === 'video')!.objectId,
      sourceVideoMetadata: nativeSetup.sourceVideoMetadata,
      sourceAudioMetadata: nativeSetup.sourceAudioMetadata };
    await assertPinnedFrameParityFixture(harness, fixture);
    return fixture;
  }
  const directory = await mkdtemp(join(tmpdir(), 'real-frame-parity-'));
  try {
    const source = await generatePlayableVideo(directory);
    const audioPath = join(directory, 'tone.wav');
    await exec('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1',
      '-ac', '2', '-c:a', 'pcm_s16le', '-threads', '1', audioPath]);
    const ingest = async (bytes: Buffer, type: string, filename: string): Promise<MediaPin> => {
      const response = await harness.runtimeFetch(`/v1/projects/${harness.seed.projectId}/objects`, {
        method: 'POST', headers: { 'Content-Type': type, 'Idempotency-Key': randomUUID(), 'X-Original-Name': filename },
        body: new Uint8Array(bytes),
      });
      assert.ok([200, 201].includes(response.status), `ingest ${filename}: ${response.status}`);
      const { data } = await response.json();
      assert.equal(data.digest, mediaHash(bytes));
      assert.equal(data.object_id, data.digest);
      return { objectId: data.object_id, digest: data.digest };
    };
    const video = await ingest(source.bytes, 'video/webm', 'frame-marked.webm');
    const audio = await ingest(await readFile(audioPath), 'audio/wav', 'tone.wav');
    const { projectId, timelineId, headRevisionId: expectedHead, image } = harness.seed;
    const shotId = 'frame-parity-shot';
    const occurrenceId = 'frame-parity-occurrence';
    const shotRevisionId = randomUUID();
    const internalRevisionId = randomUUID();
    const publication = compositionPublication(harness.seed, expectedHead, 'Ordinary media frame parity', PARITY_FPS);
    const asset = (pin: MediaPin, type: string, duration?: number) => ({
      media_id: pin.objectId, content_sha256: pin.digest, type, ...(duration === undefined ? {} : { duration }),
    });
    // One canonical occurrence bounds the picture at 165 exclusive. No
    // transition policy is exercised here; the original c16 fixture is held
    // for the separate incoming-transition requirement, with its expectations.
    const clips = [
      { id: 'parity-image', track: 'V1', at: 0, clipType: 'media', hold: 4, asset: 'still' },
      { id: 'parity-video', track: 'V1', at: 4, clipType: 'media', hold: 1.5, asset: 'video', from: 0, to: 1.5, speed: 1 },
      { id: 'parity-audio', track: 'A1', at: 0.25, clipType: 'media', asset: 'audio', from: 0.05, to: 0.55,
        speed: 1, volume: 0.8, effects: [{ fade_in: 0.1, fade_out: 0.1 }] },
    ];
    Object.assign(publication.parent_composition, {
      config: { output: { resolution: `${canvas.width}x${canvas.height}`, fps: PARITY_FPS, file: 'frame-parity.mp4' },
        tracks: [{ id: 'S1', kind: 'visual', label: 'S1' }], clips: [] },
      occurrences: [{ occurrence_id: occurrenceId, shot_id: shotId, shot_revision_id: shotRevisionId,
        placement: { start_ms: 0 }, source_offset: 0, duration_ms: 5500, speed: 1, track: 'S1',
        transform: {}, gain: 1, muted: false, provenance: {} }],
    });
    Object.assign(publication, {
      internal_timeline_revisions: [{ timeline_id: timelineId, revision_id: internalRevisionId, payload: {
        tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }, { id: 'A1', kind: 'audio', label: 'A1' }],
        clips, effects: [], audio: [], layout: {}, assets: [],
        registry: { assets: { still: asset(image, 'image/png'), video: asset(video, 'video/webm', 1.5), audio: asset(audio, 'audio/wav', 1) } },
      } }],
      shot_revisions: [{ shot_id: shotId, revision_id: shotRevisionId, internal_timeline_revision_id: internalRevisionId,
        payload: { metadata: { title: 'Ordinary media' }, items: [], pools: [], selected_variants: {}, provenance: {},
          generation_inputs: {}, audio_bindings: [], text_bindings: [] } }],
    });
    const response = await harness.runtimeJson<{ data: { new_head: string; content_digests: Record<string, string> } }>('POST',
      `${timelineBase(harness.seed)}/composition-revisions`, publication);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.new_head, publication.parent_revision_id);
    const pins = { projectId, timelineId, headRevisionId: response.body.data.new_head, shotId, occurrenceId, shotRevisionId, internalRevisionId };
    const closure = await readClosure(harness, pins);
    assert.equal(closure.parent.revision_id, pins.headRevisionId);
    assert.equal(closure.shot.revision_id, shotRevisionId);
    assert.equal(closure.internal.revision_id, internalRevisionId);
    assert.equal(closure.shot.internal_timeline_revision_id, internalRevisionId);
    assert.equal(closure.parent.content_digest, response.body.data.content_digests.parent);
    assert.equal(closure.shot.content_digest, response.body.data.content_digests[shotRevisionId]);
    assert.equal(closure.internal.content_digest, response.body.data.content_digests[internalRevisionId]);
    assert.deepEqual(closure.parent.payload.occurrences, publication.parent_composition.occurrences);
    const fixture = { ...pins, ...closure, media: [image, video, audio], sourceVideoMediaId: video.objectId,
      sourceVideoMetadata: source.metadata };
    await assertPinnedFrameParityFixture(harness, fixture);
    return fixture;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Prove the three retained media pins are the canonical closure's actual clips, not just named objects. */
export function assertCanonicalNativeMedia(fixture: FrameParityFixture, canvas: ParityCanvas = ORIGINAL_640): void {
  const internal = fixture.internal.payload as {
    clips: Array<Record<string, unknown>>;
    registry: { assets: Record<string, Record<string, unknown>> };
  };
  const parent = fixture.parent.payload as {
    config: { output: Record<string, unknown> };
    occurrences: Array<Record<string, unknown>>;
  };
  const aliases = internal.registry.assets;
  assert.deepEqual(Object.keys(aliases).sort(), ['audio', 'still', 'video']);
  const pinByName = Object.fromEntries(fixture.media.map(pin => [pin.name, pin]));
  for (const [alias, name, type] of [
    ['still', 'image', 'image/png'], ['video', 'video', 'video/webm'], ['audio', 'audio', 'audio/wav'],
  ] as const) {
    assert.equal(aliases[alias].media_id, pinByName[name].objectId, `${alias} alias media pin`);
    assert.equal(aliases[alias].content_sha256, pinByName[name].digest, `${alias} alias digest`);
    assert.equal(aliases[alias].type, type, `${alias} alias type`);
  }
  const clips = Object.fromEntries(internal.clips.map(clip => [String(clip.id), clip]));
  assert.equal(clips['parity-image'].asset, 'still');
  assert.equal(clips['parity-image'].track, 'V1');
  assert.equal(clips['parity-image'].hold, 4);
  assert.equal(clips['parity-video'].asset, 'video');
  assert.equal(clips['parity-video'].from, 0);
  assert.equal(clips['parity-video'].to, 1.5);
  assert.equal(clips['parity-video'].hold, 1.5);
  assert.equal(clips['parity-audio'].asset, 'audio');
  assert.equal(clips['parity-audio'].track, 'A1');
  assert.equal(clips['parity-audio'].from, 0.05);
  assert.equal(clips['parity-audio'].to, 0.55);
  const sourceAudioMetadata = fixture.sourceAudioMetadata;
  assert.ok(sourceAudioMetadata, 'native fixture must retain probed audio source metadata');
  assert.equal(parent.config.output.resolution,
    `${canvas.width}x${canvas.height}`);
  if ('themeCanvas' in canvas) {
    assert.deepEqual((parent.config as Record<string, unknown>).theme_overrides,
      { visual: { canvas: canvas.themeCanvas } });
  }
  assert.equal(parent.config.output.fps, PARITY_FPS);
  const occurrence = parent.occurrences[0];
  assert.equal(occurrence.duration_ms, 5500);
  assert.equal(Number(occurrence.duration_ms) * PARITY_FPS / 1000, 165, 'canonical occurrence is 165 frames');
  assert.equal(fixture.sourceVideoMetadata.streams[0]?.width, PARITY_WIDTH);
  assert.equal(fixture.sourceVideoMetadata.streams[0]?.height, PARITY_HEIGHT);
  assert.equal(fixture.sourceVideoMetadata.streams[0]?.nb_read_frames, '45');
  assert.equal(Number(fixture.sourceVideoMetadata.format.duration), 1.5);
  assert.equal(sourceAudioMetadata.streams[0]?.codec_type, 'audio');
  assert.equal(sourceAudioMetadata.streams[0]?.channels, 2);
  assert.equal(sourceAudioMetadata.streams[0]?.sample_rate, '44100');
  assert.equal(Number(sourceAudioMetadata.format.duration), 1);
}

export async function assertPinnedFrameParityFixture(harness: DirectHarness, fixture: FrameParityFixture): Promise<void> {
  const head = await readRuntimeJson<{ items: Array<{ revision_id: string; is_current_head: boolean }> }>(harness,
    `${timelineBase(fixture)}/composition-revisions?limit=1`);
  assert.equal(head.items.find(item => item.is_current_head)?.revision_id, fixture.headRevisionId, 'fixture parent head changed');
  assert.deepEqual(await readClosure(harness, fixture), { parent: fixture.parent, shot: fixture.shot, internal: fixture.internal });
  for (const pin of fixture.media) {
    const response = await harness.runtimeFetch(`/v1/objects/${encodeURIComponent(pin.objectId)}`);
    assert.equal(response.status, 200);
    assert.equal(mediaHash(new Uint8Array(await response.arrayBuffer())), pin.digest, 'fixture media bytes changed');
  }
}
