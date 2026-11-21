#!/usr/bin/env node
/*
 * Plan 77 SL-0: create a generated heavy timeline through Runtime routes and
 * the installed public Timeline SDK. No user media and no authored bundles.
 *
 * After SL-1 hands off an isolated stack:
 *   df -h /home/user
 *   SAVE_LOOP_ROOT=<isolated-root> SAVE_LOOP_BASE_URL=http://127.0.0.1:<editor-port> \
 *     node scripts/save-loop/build-fixture.mjs
 *   SAVE_LOOP_PROJECT=<manifest-project-id> SAVE_LOOP_TIMELINE=<manifest-timeline-id> \
 *     SAVE_LOOP_BASE_URL=http://127.0.0.1:<editor-port> node scripts/save-loop/sweep.mjs \
 *     --video-clip <manifest-video-clip-id> --audio-clip <manifest-audio-clip-id>
 *
 * Repeat the same build and sweep on a second machine with only ffmpeg, Node,
 * and the SL-1 stack. A live stack is required to accept the size and timing
 * measurements; this script retains the manifest and fails below its targets.
 */
import {spawn, spawnSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const root = process.env.SAVE_LOOP_ROOT;
const baseUrl = process.env.SAVE_LOOP_BASE_URL;
const scratch = path.resolve(process.env.SAVE_LOOP_SCRATCH || `${repo}.env/save-loop`);
const clipTarget = Number(process.env.SAVE_LOOP_CLIPS || 616);
const byteTarget = Number(process.env.SAVE_LOOP_DOCUMENT_BYTES || 2_600_000);
const ratioTarget = Number(process.env.SAVE_LOOP_COMMIT_RATIO || 15);
const imageCount = Math.round(clipTarget * 0.25);
const videoCount = Math.round(clipTarget * 0.06);
const audioCount = clipTarget - imageCount - videoCount;
const visualTracks = ['video-1', 'video-2', 'video-3', 'video-4', 'video-5', 'video-6'];
const audioTracks = ['audio-1', 'audio-2', 'audio-3'];
const trackLabel = id => id.replace('-', ' ');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: 'inherit', ...options});
    let settled = false;
    const diskWatch = setInterval(() => {
      try {
        const free = freeBytes();
        if (free >= 15 * 1024 ** 3 || settled) return;
        settled = true;
        child.kill('SIGTERM');
        reject(new Error(`stopping ${command}: ${(free / 1024 ** 3).toFixed(1)} GB free; Plan 77 floor is 15 GB`));
      } catch (error) {
        if (!settled) { settled = true; child.kill('SIGTERM'); reject(error); }
      }
    }, 10_000);
    const finish = callback => value => {
      clearInterval(diskWatch);
      if (settled) return;
      settled = true;
      callback(value);
    };
    child.once('error', finish(reject));
    child.once('exit', finish(code => code === 0 ? resolve() : reject(
      new Error(`${command} failed (${code || 'signal'})`))));
  });
}

function freeBytes() {
  const dir = os.platform() === 'linux' ? '/home/user' : os.homedir();
  const result = spawnSync('df', ['-Pk', dir], {encoding: 'utf8'});
  if (result.status !== 0) throw new Error(result.stderr || 'df failed');
  const availableKb = Number(result.stdout.trim().split(/\r?\n/).at(-1)?.trim().split(/\s+/)[3]);
  if (!Number.isFinite(availableKb)) throw new Error(`cannot parse free space from df: ${result.stdout}`);
  return availableKb * 1024;
}

function assertDisk() {
  const free = freeBytes();
  if (free < 15 * 1024 ** 3) throw new Error(`stopping: ${(free / 1024 ** 3).toFixed(1)} GB free; Plan 77 floor is 15 GB`);
}

function filesIn(dir, prefix, suffix) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => name.startsWith(prefix) && name.endsWith(suffix))
    .sort().map(name => path.join(dir, name));
}

function assertUniqueAssets(files, role) {
  const hashes = new Set(files.map(file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')));
  if (hashes.size !== files.length) throw new Error(`${role} pool has only ${hashes.size}/${files.length} distinct generated assets`);
}

async function mediaPool({dir, prefix, suffix, count, ffmpegArgs}) {
  fs.mkdirSync(dir, {recursive: true});
  let files = filesIn(dir, prefix, suffix);
  if (files.length !== count || files.some(file => fs.statSync(file).size === 0)) {
    fs.rmSync(dir, {recursive: true, force: true});
    fs.mkdirSync(dir, {recursive: true});
    assertDisk();
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...ffmpegArgs(path.join(dir, `${prefix}%04d${suffix}`))]);
    files = filesIn(dir, prefix, suffix);
  }
  if (files.length !== count) throw new Error(`ffmpeg made ${files.length}/${count} ${prefix} assets`);
  return files;
}

async function post(base, route, body, key) {
  const response = await fetch(`${base.replace(/\/$/, '')}/api/runtime${route}`, {
    method: 'POST', headers: {'content-type': 'application/json', 'Idempotency-Key': key},
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error(`${route}: HTTP ${response.status}: ${raw.slice(0, 300)}`); }
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status}: ${JSON.stringify(value).slice(0, 400)}`);
  return value;
}

function findString(value, field) {
  if (!value || typeof value !== 'object') return undefined;
  if (typeof value[field] === 'string' && value[field]) return value[field];
  for (const child of Object.values(value)) {
    const found = findString(child, field);
    if (found) return found;
  }
}

const sdkScript = String.raw`
import json, os, statistics, time
from astrid.sdk.timeline.api import Timeline

cfg = json.load(open(os.environ['SAVE_LOOP_CONFIG_PATH'], encoding='utf-8'))
project = cfg['project_id']
timeline_id = cfg['timeline_id']
control_id = cfg['one_clip_timeline_id']
media = cfg['media']
shots = cfg['shots']
visual, audio = cfg['visual_tracks'], cfg['audio_tracks']
count = cfg['clip_target']
image_n, video_n = round(count * .25), round(count * .06)
audio_n = count - image_n - video_n

def root_clips(doc):
    parent = doc.get('parent', {})
    return parent.get('clips', (parent.get('config', {}) or {}).get('clips', []))

def root_tracks(doc):
    parent = doc.get('parent', {})
    rows = parent.get('tracks')
    if not isinstance(rows, list): rows = (parent.get('config', {}) or {}).get('tracks', [])
    return rows if isinstance(rows, list) else []

def placement_rows(doc):
    rows = doc.get('placements')
    if not isinstance(rows, list):
        rows = (doc.get('parent', {}) or {}).get('occurrences', [])
    return rows if isinstance(rows, list) else []

def populate(tl, timeline, *, control=False):
    targets = {'video': [], 'audio': [], 'image': []}
    def edit(t):
        for track in visual: t.track(track, kind='visual')
        for track in audio: t.track(track, kind='audio')
        if control:
            clip_id = 'control-video-0000'
            t.add(media['video'][0], at=10, hold=5, track=visual[0], id=clip_id)
            targets['video'].append(clip_id)
        else:
            for i in range(count):
                if i % 100 == 0: print(f'heavy fixture: staged {i}/{count}', flush=True)
                if i < image_n:
                    kind, index = 'image', i
                    track, at, hold = visual[i % 5], (i // 5) * 6, 5
                elif i < image_n + video_n:
                    kind, index = 'video', i - image_n
                    track, at, hold = visual[5], index * 5.2, 5
                else:
                    kind, index = 'audio', i - image_n - video_n
                    track, at, hold = audio[index % len(audio)], (index // len(audio)) * 1.4, 1
                clip_id = f'fixture-{kind}-{i:04d}'
                t.add(media[kind][index], at=at, hold=hold, track=track, id=clip_id)
                targets[kind].append(clip_id)
            # These are real SDK-created composition occurrences. Their IDs are
            # resolved from the published SDK document after the commit.
            for i, shot in enumerate(shots):
                t.command({
                    'schema_version': 1, 'op': 'occurrence.create', 'version': '1',
                    'select': 'parent',
                    'args': {'occurrence_id': f'fixture-occurrence-{i:02d}',
                             'shot_id': shot['shot_id'], 'name': shot['name'],
                             'track': visual[i % len(visual)], 'on': i * 4.25, 'duration': 4},
                }, label='Create generated fixture shot occurrence')
    tl.commit(edit, label='Create generated save-loop fixture',
              idempotency_key=f"p77-fixture-{timeline}-{project}")
    return tl.document(), targets

heavy_doc, heavy_targets = populate(Timeline.open(project, timeline_id), timeline_id)
control_doc, control_targets = populate(Timeline.open(project, control_id), control_id, control=True)

def warm_move_samples(timeline, clip_id, samples=5):
    doc = Timeline.open(project, timeline).document()
    clip = next((row for row in root_clips(doc) if row.get('id') == clip_id), None)
    if clip is None: raise RuntimeError(f'public SDK document has no clip {clip_id}')
    initial = float(clip.get('at', 0))
    times = []
    for i in range(samples):
        target = initial + (1 / 30 if i % 2 == 0 else 0)
        tl = Timeline.open(project, timeline)
        started = time.perf_counter()
        tl.move(f'parent/clip:{clip_id}', target)
        tl.commit(label='Warm fixture clip move',
                  idempotency_key=f'p77-warm-move-{timeline}-{clip_id}-{i}')
        times.append((time.perf_counter() - started) * 1000)
    return times

heavy_times = warm_move_samples(timeline_id, heavy_targets['video'][0])
control_times = warm_move_samples(control_id, control_targets['video'][0])
doc_bytes = len(json.dumps(heavy_doc, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode())
control_bytes = len(json.dumps(control_doc, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode())
parent = heavy_doc.get('parent', {})
registry = parent.get('registry', (parent.get('config', {}) or {}).get('registry', {}))
assets = registry.get('assets', {}) if isinstance(registry, dict) else {}
clips = {row.get('id'): row for row in root_clips(heavy_doc) if isinstance(row, dict)}
tracks = {row.get('id'): row for row in root_tracks(heavy_doc) if isinstance(row, dict)}
for wanted in visual + audio:
    row = tracks.get(wanted)
    if row is None: raise RuntimeError(f'published document omitted track {wanted}')
    expected = 'audio' if wanted in audio else 'visual'
    if row.get('kind') != expected: raise RuntimeError(f'published track {wanted} has kind {row.get("kind")}, expected {expected}')
def clip_targets(ids, role):
    found = []
    for clip_id in ids:
        row = clips.get(clip_id)
        if row is None: raise RuntimeError(f'published document omitted clip {clip_id}')
        found.append({'clip_id': row['id'], 'track_id': row.get('track'),
                      'track_role': role, 'at_seconds': row.get('at')})
    return found
occurrences = []
for shot in shots:
    row = next((row for row in placement_rows(heavy_doc)
                if isinstance(row, dict) and row.get('shot_id') == shot['shot_id']), None)
    if row is None: raise RuntimeError(f'published document omitted occurrence for {shot["shot_id"]}')
    occurrences.append({'occurrence_id': row['occurrence_id'], 'shot_id': row['shot_id'],
                        'track_id': row.get('track'), 'track_role': 'visual', 'name': shot['name']})
measurement = {
    'clip_count': len(root_clips(heavy_doc)), 'document_bytes': doc_bytes,
    'registry_asset_count': len(assets),
    'heavy_warm_move_samples_ms': heavy_times,
    'one_clip_warm_move_samples_ms': control_times,
    'heavy_warm_move_median_ms': statistics.median(heavy_times),
    'one_clip_warm_move_median_ms': statistics.median(control_times),
    'warm_move_median_ratio': statistics.median(heavy_times) / statistics.median(control_times),
    'one_clip_document_bytes': control_bytes, 'one_clip_count': len(root_clips(control_doc)),
    'named': {'tracks': [{'id': row['id'], 'label': row.get('label', row['id']),
                          'kind': row['kind'], 'role': row.get('role', 'output')}
                         for row in root_tracks(heavy_doc) if row.get('id') in visual + audio],
              'video': clip_targets(heavy_targets['video'], 'video'),
              'audio': clip_targets(heavy_targets['audio'], 'audio'),
              'image': clip_targets(heavy_targets['image'][:1], 'image'),
              'occurrences': occurrences},
}
with open(os.environ['SAVE_LOOP_MEASUREMENT_PATH'], 'w', encoding='utf-8') as out:
    json.dump(measurement, out)
print(json.dumps(measurement, sort_keys=True))
`;

async function main() {
  if (!root || !baseUrl) throw new Error('set SAVE_LOOP_ROOT and SAVE_LOOP_BASE_URL for the isolated SL-1 stack');
  if (!/^https?:\/\//.test(baseUrl)) throw new Error('SAVE_LOOP_BASE_URL must be the editor origin');
  if (!Number.isInteger(clipTarget) || clipTarget < 616) throw new Error('SAVE_LOOP_CLIPS must be an integer >= 616');
  assertDisk();
  fs.mkdirSync(scratch, {recursive: true});
  const mediaRoot = path.join(scratch, 'generated-media');
  const images = await mediaPool({dir: path.join(mediaRoot, 'images'), prefix: 'image-', suffix: '.png', count: imageCount,
    ffmpegArgs: pattern => ['-f', 'lavfi', '-i', `color=c=red:s=1920x1080:r=1:d=${imageCount}`,
      '-vf', "fps=1,hue=h='2*n'", '-frames:v', String(imageCount), '-start_number', '0', '-y', pattern]});
  const videos = await mediaPool({dir: path.join(mediaRoot, 'videos'), prefix: 'video-', suffix: '.mp4', count: videoCount,
    ffmpegArgs: pattern => ['-f', 'lavfi', '-i', `color=c=red:s=1920x1080:r=30:d=${videoCount * 5}`,
      '-vf', "hue=h='2*n'", '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-g', '30', '-force_key_frames', 'expr:gte(t,n_forced*5)', '-f', 'segment', '-segment_time', '5',
      '-segment_format', 'mp4', '-reset_timestamps', '1', '-y', pattern]});
  const audios = await mediaPool({dir: path.join(mediaRoot, 'audio'), prefix: 'audio-', suffix: '.wav', count: audioCount,
    ffmpegArgs: pattern => ['-f', 'lavfi', '-i', `aevalsrc=sin(2*PI*(440+floor(t))*t):s=44100:d=${audioCount}`,
      '-f', 'segment', '-segment_time', '1', '-segment_format', 'wav', '-reset_timestamps', '1', '-y', pattern]});
  assertUniqueAssets(images, 'image');
  assertUniqueAssets(videos, 'video');
  assertUniqueAssets(audios, 'audio');
  assertDisk();

  const nonce = randomUUID().slice(0, 8);
  const projectReply = await post(baseUrl, '/v1/projects', {
    name: `Save loop fixture ${nonce}`, slug: `save-loop-fixture-${nonce}`,
    metadata: {purpose: 'synthetic Plan 77 save-loop fixture'},
  }, `p77-project-${nonce}`);
  const projectId = findString(projectReply, 'project_id') || findString(projectReply, 'id');
  if (!projectId) throw new Error(`Runtime omitted created project id: ${JSON.stringify(projectReply).slice(0, 400)}`);
  const timelineId = `save-loop-heavy-${nonce}`;
  const oneClipTimelineId = `save-loop-one-${nonce}`;
  const createTimeline = async (id, name) => {
    const response = await post(baseUrl, `/v1/projects/${encodeURIComponent(projectId)}/timelines`,
      {timeline_id: id, name}, `p77-${id}`);
    if (findString(response, 'timeline_id') !== id) throw new Error(`Runtime did not confirm timeline id ${id}`);
  };
  await createTimeline(timelineId, 'Generated heavy timeline');
  await createTimeline(oneClipTimelineId, 'One-clip timing control');
  const shots = [];
  for (let i = 0; i < 46; i++) {
    const name = `Fixture shot ${String(i + 1).padStart(2, '0')}`;
    const response = await post(baseUrl, `/v1/projects/${encodeURIComponent(projectId)}/shots`,
      {name, metadata: {synthetic: true}}, `p77-shot-${nonce}-${i}`);
    const shotId = findString(response, 'shot_id') || findString(response, 'id');
    if (!shotId) throw new Error(`Runtime omitted created shot id: ${JSON.stringify(response).slice(0, 300)}`);
    shots.push({shot_id: shotId, name});
  }

  const versionsDir = path.resolve(root, 'program/versions');
  const installedVersions = fs.readdirSync(versionsDir).filter(name => name !== 'current'
    && fs.existsSync(path.join(versionsDir, name, 'py/bin/python')));
  if (installedVersions.length !== 1) throw new Error(`expected one pinned SDK Python below ${versionsDir}; found ${installedVersions.length}`);
  const python = path.join(versionsDir, installedVersions[0], 'py/bin/python');
  const configPath = path.join(scratch, `config-${nonce}.json`);
  const scriptPath = path.join(scratch, `build-${nonce}.py`);
  const measurementPath = path.join(scratch, `measurement-${nonce}.json`);
  const media = {image: images, video: videos, audio: audios};
  fs.writeFileSync(configPath, JSON.stringify({project_id: projectId, timeline_id: timelineId,
    one_clip_timeline_id: oneClipTimelineId, clip_target: clipTarget, media, shots,
    visual_tracks: visualTracks, audio_tracks: audioTracks}));
  fs.writeFileSync(scriptPath, sdkScript, {mode: 0o600});
  try {
    await run(python, ['-I', scriptPath], {env: {...process.env,
      HOME: path.resolve(root, 'home'), ASTRID_RUNTIME_DATA_ROOT: path.resolve(root, 'data'),
      SAVE_LOOP_CONFIG_PATH: configPath, SAVE_LOOP_MEASUREMENT_PATH: measurementPath}});
  } finally {
    fs.rmSync(scriptPath, {force: true});
    fs.rmSync(configPath, {force: true});
  }
  const measurement = JSON.parse(fs.readFileSync(measurementPath, 'utf8'));
  fs.rmSync(measurementPath, {force: true});
  assertDisk();
  const {named, ...measuredValues} = measurement;
  const registryAssetTarget = 418;
  const passed = measurement.clip_count >= clipTarget && measurement.document_bytes >= byteTarget
    && measurement.registry_asset_count >= registryAssetTarget
    && measurement.warm_move_median_ratio >= ratioTarget;
  const manifest = {
    schema_version: 1,
    project_id: projectId,
    timeline_id: timelineId,
    one_clip_timeline_id: oneClipTimelineId,
    tracks: {
      visual: named.tracks.filter(row => row.kind === 'visual'),
      audio: named.tracks.filter(row => row.kind === 'audio'),
    },
    clips: {
      video: {primary: named.video[0], repeated_delete_and_split: named.video.slice(1, 10)},
      audio: {primary: named.audio[0], additional: named.audio.slice(1, 10)},
      image: named.image[0],
      shot_occurrences: named.occurrences,
    },
    shots,
    media: {synthetic: true, asset_counts: {image: images.length, video: videos.length, audio: audios.length}},
    measurement: {...measuredValues, targets: {clip_count: clipTarget, document_bytes: byteTarget,
      registry_asset_count: registryAssetTarget, warm_move_median_ratio: ratioTarget}, status: passed ? 'pass' : 'fail'},
    live_proof: {stack_url: baseUrl, generated_at: new Date().toISOString(), second_machine: 'pending'},
  };
  const manifestPath = path.join(scratch, `manifest-${projectId}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Video target: ${named.video[0].clip_id}`);
  console.log(`Audio target: ${named.audio[0].clip_id}`);
  const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  console.log(`Sweep command: SAVE_LOOP_PROJECT=${shellQuote(projectId)} SAVE_LOOP_TIMELINE=${shellQuote(timelineId)} SAVE_LOOP_BASE_URL=${shellQuote(baseUrl)} node scripts/save-loop/sweep.mjs --video-clip ${shellQuote(manifest.clips.video.primary.clip_id)} --audio-clip ${shellQuote(manifest.clips.audio.primary.clip_id)}`);
  console.log(JSON.stringify(manifest.measurement, null, 2));
  if (!passed) throw new Error(`measured fixture misses target; use observed size/ratio to set SAVE_LOOP_CLIPS higher; manifest retained at ${manifestPath}`);
}

main().catch(error => { console.error(`build-fixture: ${error.message}`); process.exitCode = 1; });
