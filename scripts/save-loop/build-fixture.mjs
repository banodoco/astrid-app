#!/usr/bin/env node
/*
 * Plan 77 SL-0: create a generated heavy timeline through Runtime routes and
 * the installed public Timeline SDK. No user media and no authored bundles.
 *
 * After SL-1 hands off an isolated stack:
 *   df -h /home/user
 *   SAVE_LOOP_ROOT=<isolated-root> SAVE_LOOP_BASE_URL=http://127.0.0.1:<editor-port> \
 *     node scripts/save-loop/build-fixture.mjs
 * Use the printed manifest path with the current sweep CLI's --manifest,
 * --results, and --versions options.
 *
 * Repeat the same build and sweep on a second machine with only ffmpeg, Node,
 * and the SL-1 stack. A live stack is required to accept the size and timing
 * measurements; this script retains the manifest and fails below its targets.
 */
import {spawn, spawnSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {filmMediaCommands, parseFixtureOptions} from './film-shape.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const root = process.env.SAVE_LOOP_ROOT;
const baseUrl = process.env.SAVE_LOOP_BASE_URL;
const {variant, clipCount: clipTarget, mediaSize, prepareMedia} = parseFixtureOptions(process.argv.slice(2), process.env);
const largeShots = variant === 'large-shots';
const startedAt = Date.now();
const scratch = path.resolve(process.env.SAVE_LOOP_SCRATCH || `${repo}.env/save-loop`);
const byteTarget = Number(process.env.SAVE_LOOP_DOCUMENT_BYTES || 2_600_000);
const ratioTarget = Number(process.env.SAVE_LOOP_COMMIT_RATIO || 15);
const imageCount = Math.round(clipTarget * 0.25);
const videoCount = Math.round(clipTarget * 0.06);
const audioCount = clipTarget - imageCount - videoCount;
const visualTracks = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6'];
const audioTracks = ['A1', 'A2', 'A3'];
let activeChild;
let stopSignal;

function stop(signal) {
  if (stopSignal) return;
  stopSignal = signal;
  const exitCode = signal === 'SIGINT' ? 130 : 143;
  const child = activeChild;
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    process.exit(exitCode);
  }

  let escalation;
  const finish = () => {
    clearTimeout(escalation);
    process.exit(exitCode);
  };
  child.once('exit', finish);
  child.kill(signal);
  escalation = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    const finalWait = setTimeout(() => {
      console.error(`build-fixture: owned child ${child.pid} did not exit after SIGKILL`);
      process.exit(exitCode);
    }, 2_000);
    child.once('exit', () => clearTimeout(finalWait));
  }, 2_000);
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: 'inherit', ...options});
    activeChild = child;
    let settled = false;
    const stopChild = async (error) => {
      if (settled) return;
      settled = true;
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGTERM');
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2_000))]);
        if (child.exitCode === null && child.signalCode === null) {
          const exitedAfterKill = new Promise(resolve => child.once('exit', resolve));
          child.kill('SIGKILL');
          await Promise.race([exitedAfterKill, new Promise(resolve => setTimeout(resolve, 2_000))]);
        }
      }
      if (activeChild === child) activeChild = null;
      reject(error);
    };
    const diskWatch = setInterval(() => {
      try {
        const free = freeBytes();
        if (free >= 15 * 1024 ** 3 || settled) return;
        void stopChild(new Error(`stopping ${command}: ${(free / 1024 ** 3).toFixed(1)} GB free; Plan 77 floor is 15 GB`));
      } catch (error) {
        void stopChild(error);
      }
    }, 10_000);
    const finish = callback => value => {
      clearInterval(diskWatch);
      if (activeChild === child) activeChild = null;
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
  const result = spawnSync('df', ['-Pk', scratch], {encoding: 'utf8'});
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

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const body = Buffer.concat([name, data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
  return chunk;
}

function stampGeneratedPngs(files) {
  const key = Buffer.concat([Buffer.from('P77Fixture'), Buffer.from([0])]);
  files.forEach((file, index) => {
    const png = fs.readFileSync(file);
    if (png.includes(key)) return;
    let offset = 8;
    while (offset + 12 <= png.length) {
      const length = png.readUInt32BE(offset);
      if (png.toString('ascii', offset + 4, offset + 8) === 'IEND') {
        const tag = Buffer.concat([key, Buffer.from(index.toString().padStart(4, '0'))]);
        const result = Buffer.concat([png.subarray(0, offset), pngChunk('tEXt', tag), png.subarray(offset)]);
        const temporary = `${file}.tmp`;
        fs.writeFileSync(temporary, result);
        fs.renameSync(temporary, file);
        return;
      }
      offset += 12 + length;
    }
    throw new Error(`ffmpeg output is not a complete PNG: ${file}`);
  });
}

async function stampGeneratedVideos(files) {
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    if (fs.readFileSync(file).includes(Buffer.from('P77Fixture'))) continue;
    assertDisk();
    const temporary = file.replace(/\.mp4$/, '.tmp.mp4');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0', '-c', 'copy',
      '-metadata', `comment=P77Fixture-${String(index).padStart(4, '0')}`, '-movflags', '+faststart', '-y', temporary]);
    fs.renameSync(temporary, file);
  }
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

async function get(base, route) {
  const response = await fetch(`${base.replace(/\/$/, '')}/api/runtime${route}`);
  const raw = await response.text();
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error(`${route}: HTTP ${response.status}: ${raw.slice(0, 300)}`); }
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status}: ${JSON.stringify(value).slice(0, 400)}`);
  return value;
}

function stackPorts(root) {
  const portsFile = path.join(root, 'ports');
  const stackInfoFile = path.join(root, 'stack-info.txt');
  const ports = {};
  if (fs.existsSync(portsFile)) {
    const values = fs.readFileSync(portsFile, 'utf8').trim().split(/[\s,]+/);
    if (/^\d+$/.test(values[0] || '')) ports.editor = Number(values[0]);
    if (/^\d+$/.test(values[1] || '')) ports.proxy = Number(values[1]);
    if (/^\d+$/.test(values[2] || '')) ports.door = Number(values[2]);
  }
  if (fs.existsSync(stackInfoFile)) {
    const value = fs.readFileSync(stackInfoFile, 'utf8');
    for (const [key, label] of [['editor', 'EDITOR_PORT'], ['proxy', 'PROXY_PORT'], ['door', 'DOOR_PORT']]) {
      if (ports[key]) continue;
      const match = value.match(new RegExp(`^${label}=(\\d+)$`, 'm'));
      if (match) ports[key] = Number(match[1]);
    }
  }
  if (!ports.editor || !ports.door) throw new Error(`could not resolve editor and Runtime door ports from ${portsFile} or ${stackInfoFile}`);
  return ports;
}

function sha256ObjectId(file) {
  return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function runtimeMediaIds(value, found = new Set()) {
  if (Array.isArray(value)) {
    for (const child of value) runtimeMediaIds(child, found);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'media_id' || key === 'object_id')
          && typeof child === 'string' && /^sha256:[0-9a-f]{64}$/.test(child)) found.add(child);
      runtimeMediaIds(child, found);
    }
  }
  return found;
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
import hashlib, json, os, statistics, time
from collections.abc import Mapping
from pathlib import Path
from astrid.sdk import AstridClient
from astrid.sdk.timeline.api import Timeline
from astrid.core.timeline.track_appearance import stamp_new_track_appearance

cfg = json.load(open(os.environ['SAVE_LOOP_CONFIG_PATH'], encoding='utf-8'))
project = cfg['project_id']
timeline_id = cfg['timeline_id']
control_id = cfg['one_clip_timeline_id']
media = cfg['media']
shots = cfg['shots']
large_shots = cfg['large_shots']
visual, audio = cfg['visual_tracks'], cfg['audio_tracks']
count = cfg['clip_target']
image_n, video_n = round(count * .25), round(count * .06)
audio_n = count - image_n - video_n
expected_object_ids = cfg['expected_object_ids']
expected_object_ids_by_kind = cfg['expected_object_ids_by_kind']
bootstrap_track_ids = {'V1', 'A1'}
canonical_documents = {}
last_results = {}
media_selections = {'image': [], 'video': [], 'audio': []}
media_import_receipts = []

def response_data(response):
    if isinstance(response, Mapping) and isinstance(response.get('data'), Mapping):
        return dict(response['data']), response.get('receipt')
    if isinstance(response, Mapping): return dict(response), None
    raise RuntimeError('Runtime media route returned a non-object response')

def import_media_selections(client):
    from astrid.sdk.authoring_media import _metadata

    workspace = client._remote._transport
    started = time.perf_counter()
    total = sum(len(rows) for rows in media.values())
    complete = 0
    for kind in ('image', 'video', 'audio'):
        for path in media[kind]:
            local_path = Path(path)
            metadata = _metadata(local_path)
            payload = local_path.read_bytes()
            digest = 'sha256:' + hashlib.sha256(payload).hexdigest()
            if digest != metadata['digest']:
                raise RuntimeError(f'generated {kind} media changed during import: {local_path.name}')
            key = 'p77-import-' + hashlib.sha256((project + ':' + digest).encode()).hexdigest()
            response = workspace.import_project_media(
                project, payload, media_type=metadata['media_type'], filename=metadata['filename'],
                expected_digest=digest, idempotency_key=key,
                **{name: metadata[name] for name in ('width', 'height', 'duration_seconds') if name in metadata},
            )
            imported, receipt = response_data(response)
            receipt_id = receipt.get('receipt_id') if isinstance(receipt, Mapping) else None
            if (imported.get('status') != 'completed' or imported.get('asset_id') != digest
                    or not imported.get('generation_id') or not imported.get('variant_id') or not receipt_id):
                raise RuntimeError(f'Runtime did not accept generated media import {local_path.name}')
            selectors = {'asset': imported['variant_id'], 'generation_id': imported['generation_id'],
                         'variant_id': imported['variant_id']}
            selected_response = workspace.get_project_media_selection(project, selectors)
            selected, _ = response_data(selected_response)
            if (set(selected) != {'asset', 'generation_id', 'variant_id', 'object_id', 'catalog_digest'}
                    or selected.get('object_id') != digest
                    or selected.get('generation_id') != imported['generation_id']
                    or selected.get('variant_id') != imported['variant_id']):
                raise RuntimeError(f'Runtime selection did not match imported generated media {local_path.name}')
            media_selections[kind].append(selected)
            media_import_receipts.append({
                'kind': kind, 'object_id': digest, 'generation_id': imported['generation_id'],
                'variant_id': imported['variant_id'],
                'receipt_id': receipt_id,
            })
            complete += 1
            if complete % 50 == 0 or complete == total:
                print(f'accepted media imports {complete}/{total} in {(time.perf_counter() - started) * 1000:.1f} ms receipt={receipt_id}', flush=True)
    return (time.perf_counter() - started) * 1000

def runtime_payload(doc):
    return ((doc.get('parent_revision') or {}).get('payload')
            if isinstance(doc.get('parent_revision'), dict) else None) or {}

def root_clips(doc):
    parent = doc.get('parent') or runtime_payload(doc)
    config = parent.get('config', {}) or {}
    rows = parent.get('clips')
    if not isinstance(rows, list) or not rows: rows = config.get('clips', [])
    return rows if isinstance(rows, list) else []

def root_tracks(doc):
    parent = doc.get('parent') or runtime_payload(doc)
    rows = parent.get('tracks')
    if not isinstance(rows, list): rows = (parent.get('config', {}) or {}).get('tracks', [])
    return rows if isinstance(rows, list) else []

def placement_rows(doc):
    rows = doc.get('placements')
    if not isinstance(rows, list):
        parent = doc.get('parent') or runtime_payload(doc)
        rows = parent.get('occurrences', [])
    return rows if isinstance(rows, list) else []

def registry_assets(doc):
    parent = doc.get('parent') or runtime_payload(doc)
    registry = parent.get('registry', (parent.get('config', {}) or {}).get('registry', {}))
    return registry.get('assets', {}) if isinstance(registry, dict) else {}

def canonical_media_ids(doc):
    found = set()
    def walk(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key in {'media_id', 'object_id'} and isinstance(child, str) and child.startswith('sha256:'):
                    found.add(child)
                walk(child)
        elif isinstance(value, list):
            for child in value: walk(child)
    walk(doc)
    return found

def canonical_document_bytes(doc):
    return len(json.dumps(doc, sort_keys=True, separators=(',', ':'),
                          ensure_ascii=False, allow_nan=False).encode('utf-8'))

batch_size = 12
outbox_root = cfg['outbox_root']
receipts = []

def commit_batch(tl, timeline, label, key, edit, command_count):
    started = time.perf_counter()
    result = tl.commit(edit, label=label, idempotency_key=key)
    elapsed_ms = (time.perf_counter() - started) * 1000
    data = result.get('data', {})
    receipt = result.get('receipt', {})
    row = {'timeline_id': timeline, 'label': label, 'command_count': command_count,
           'status': data.get('status'),
           'receipt_id': receipt.get('receipt_id'),
           'accepted_revision_id': data.get('accepted_revision_id'),
           'elapsed_ms': elapsed_ms}
    if not row['receipt_id'] or not row['accepted_revision_id'] or row['status'] == 'preview':
        raise RuntimeError(f'{label} omitted accepted receipt or revision')
    document = data.get('canonical_document')
    parent_revision = document.get('parent_revision', {}) if isinstance(document, dict) else {}
    if (not isinstance(document, dict) or document.get('project_id') != project
            or document.get('timeline_id') != timeline
            or not isinstance(parent_revision, dict) or parent_revision.get('revision_id') != row['accepted_revision_id']
            or not parent_revision.get('content_digest')):
        raise RuntimeError(f'{label} omitted its matching canonical Runtime document')
    row['content_digest'] = parent_revision['content_digest']
    receipts.append(row)
    canonical_documents[timeline] = document
    last_results[timeline] = row
    print(f"accepted {label}: {command_count} commands elapsed={elapsed_ms:.1f}ms receipt={row['receipt_id']} revision={row['accepted_revision_id']}", flush=True)

def populate(timeline, *, control=False):
    targets = {'video': [], 'audio': [], 'image': []}
    with AstridClient.open_existing_from_launcher() as client:
        tl = Timeline.open(project, timeline, client=client,
                           outbox_path=os.path.join(outbox_root, f'{timeline}.json'))
        initial_tracks = root_tracks(tl.document())
        initial = {row.get('id'): row for row in initial_tracks if isinstance(row, dict)}
        if (len(initial_tracks) != 2 or set(initial) != bootstrap_track_ids
                or initial['V1'].get('kind') != 'visual' or initial['A1'].get('kind') != 'audio'):
            raise RuntimeError(f'expected Runtime bootstrap tracks V1 visual and A1 audio; got {initial_tracks!r}')
        track_rows = [] if control else (
            [(track, 'visual') for track in visual if track not in initial]
            + [(track, 'audio') for track in audio if track not in initial])
        def make_tracks(t):
            for track, kind in track_rows: t.track(track, kind=kind)
        if track_rows:
            commit_batch(tl, timeline, 'Add missing fixture tracks', f'p77-{timeline}-tracks', make_tracks, len(track_rows))
        media_import_elapsed_ms = import_media_selections(client) if not control else 0

        if control:
            clip_rows = [('video', 0, visual[0], 10, 4, 'control-video-0000')]
        else:
            clip_rows = []
            for i in range(count):
                if i < image_n:
                    kind, index = 'image', i
                    track, at, hold = visual[1 + (i % 4)], (i // 4) * 6, 5
                elif i < image_n + video_n:
                    kind, index = 'video', i - image_n
                    track, at, hold = visual[5], (i - image_n) * 5.2, 4
                else:
                    kind, index = 'audio', i - image_n - video_n
                    audio_index = index
                    track, at, hold = audio[audio_index % len(audio)], (audio_index // len(audio)) * 1.4, .8
                clip_rows.append((kind, index, track, at, hold, f'fixture-{kind}-{i:04d}'))

        for start in range(0, len(clip_rows), batch_size):
            batch = clip_rows[start:start + batch_size]
            def make_clips(t, batch=batch):
                for kind, index, track, at, hold, clip_id in batch:
                    try:
                        t.add(media_selections[kind][index], at=at, hold=hold, track=track, id=clip_id)
                    except Exception as error:
                        raise RuntimeError(f'{kind} media {index}, clip {clip_id}, hold {hold}: {error}') from error
                    targets[kind].append(clip_id)
            commit_batch(tl, timeline, f'Add fixture clips {start + 1}-{start + len(batch)}',
                         f'p77-{timeline}-clips-{start}', make_clips, len(batch))
        if not control:
            for start in range(0, len(shots), batch_size):
                batch = list(enumerate(shots))[start:start + batch_size]
                def make_occurrences(t, batch=batch):
                    for i, shot in batch:
                        occurrence_id = f'fixture-occurrence-{i:02d}'
                        t.command({
                            'schema_version': 1, 'op': 'occurrence.create', 'version': '1',
                            'select': 'parent',
                            'args': {'occurrence_id': occurrence_id,
                                     'shot_id': shot['shot_id'], 'name': shot['name'],
                                     'track': visual[0], 'on': shot.get('on', i * 4.25), 'duration': shot.get('duration', 4)},
                            'created': [f"shot:{shot['shot_id']}", f'occurrence:{occurrence_id}'],
                        }, label='Create generated fixture shot occurrence')
                commit_batch(tl, timeline, f'Create fixture shots {start + 1}-{start + len(batch)}',
                             f'p77-{timeline}-shots-{start}', make_occurrences, len(batch))
        if not control and large_shots:
            for i, shot in enumerate(shots[46:], start=46):
                owner = f'occurrence:fixture-occurrence-{i:02d}'
                def child_tracks(t):
                    for track, kind in (('LV', 'visual'), ('LA', 'audio')):
                        row = stamp_new_track_appearance({'id': track, 'kind': kind, 'label': track})
                        t.command({'schema_version': 1, 'op': 'track.create', 'version': '1',
                                   'select': owner, 'args': {'row': row},
                                   'intent': {}}, label='Create child track')
                commit_batch(tl, timeline, f'Add child tracks {i}', f'p77-{timeline}-child-tracks-{i}', child_tracks, 2)
                for start in range(0, 32, 8):
                    def add_children(t, start=start):
                        for j in range(start, start + 8):
                            kind = 'video' if j % 2 == 0 else 'audio'
                            pin = media_selections[kind][-1]
                            row = {'id': f'large-child-{i}-{j:02d}', 'clipType': 'media' if kind == 'video' else 'audio',
                                   'track': 'LV' if kind == 'video' else 'LA', 'asset': pin['asset'],
                                   'at': (j // 2) * 30, 'hold': 30, 'from': 0, 'to': 30, 'speed': 1}
                            t.command({'schema_version': 1, 'op': 'occurrence.add-media', 'version': '1',
                                       'select': owner, 'args': {'row': row, 'media': pin},
                                       'intent': {'ownership': 'occurrence'}}, label='Add generated child media')
                    commit_batch(tl, timeline, f'Add children {i} {start}', f'p77-{timeline}-children-{i}-{start}', add_children, 8)
        document = canonical_documents[timeline]
        actual_tracks = root_tracks(document)
        visual_count = sum(row.get('kind') == 'visual' for row in actual_tracks)
        audio_count = sum(row.get('kind') == 'audio' for row in actual_tracks)
        if not control and (len(actual_tracks) != 9 or visual_count != 6 or audio_count != 3
                            or {row.get('id') for row in actual_tracks} != set(visual + audio)):
            raise RuntimeError(f'expected exactly 9 fixture tracks (6 visual, 3 audio); got {actual_tracks!r}')
        if control and (len(actual_tracks) != 2 or visual_count != 1 or audio_count != 1):
            raise RuntimeError(f'expected two bootstrap control tracks; got {actual_tracks!r}')
        actual_ids = canonical_media_ids(document)
        required_ids = set(expected_object_ids if not control else expected_object_ids_by_kind['video'][:1])
        missing_ids = sorted(required_ids - actual_ids)
        if missing_ids: raise RuntimeError(f'accepted Runtime document is missing {len(missing_ids)} expected media identities')
        unexpected_ids = sorted(actual_ids - required_ids)
        if unexpected_ids: raise RuntimeError(f'accepted Runtime document contains {len(unexpected_ids)} unexpected media identities')
        clip_id = targets['video'][0]
        clip = next((row for row in root_clips(document) if row.get('id') == clip_id), None)
        if clip is None: raise RuntimeError(f'public SDK document has no clip {clip_id}')
        initial = float(clip.get('at', 0))
        warm_times = []
        for i in range(5):
            target = initial + (1 / 30 if i % 2 == 0 else 0)
            def move_clip(t, target=target): t.move(f'parent/clip:{clip_id}', target)
            commit_batch(tl, timeline, 'Warm fixture clip move',
                         f'p77-warm-move-{timeline}-{clip_id}-{i}', move_clip, 1)
            warm_times.append(receipts[-1]['elapsed_ms'])
        document = canonical_documents[timeline]
        actual_staged_track_count = len({row.get('id') for row in root_tracks(document)} - bootstrap_track_ids)
        if actual_staged_track_count != len(track_rows):
            raise RuntimeError(f'staged {len(track_rows)} tracks but Runtime document contains {actual_staged_track_count}')
    return document, targets, warm_times, actual_staged_track_count, actual_tracks, media_import_elapsed_ms

heavy_doc, heavy_targets, heavy_times, created_track_count, heavy_track_rows, media_import_elapsed_ms = populate(timeline_id)
control_doc, control_targets, control_times, _, control_track_rows, _ = populate(control_id, control=True)
doc_bytes = canonical_document_bytes(heavy_doc)
control_bytes = canonical_document_bytes(control_doc)
assets = registry_assets(heavy_doc)
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
if {row['track_id'] for row in occurrences} != {'V1'}:
    raise RuntimeError('fixture shot occurrences do not use reserved placement lane V1')
large_measurement = None
if large_shots:
    per_shot = []
    for i, shot in enumerate(shots[46:], start=46):
        occurrence = next(row for row in placement_rows(heavy_doc) if row.get('occurrence_id') == f'fixture-occurrence-{i:02d}')
        if occurrence.get('duration_ms') != 480000:
            raise RuntimeError(f'large shot {i} occurrence duration differs from 480000 ms')
        shot_revision = next(row for row in heavy_doc['shot_revisions']
                             if row['shot_id'] == shot['shot_id'] and row['revision_id'] == occurrence['shot_revision_id'])
        internal = next(row['payload'] for row in heavy_doc['internal_timeline_revisions']
                        if row['revision_id'] == shot_revision['internal_timeline_revision_id'])
        children = internal.get('clips', [])
        expected = {f'large-child-{i}-{j:02d}' for j in range(32)}
        def matches_child(row):
            j = int(row['id'].rsplit('-', 1)[1])
            kind = 'video' if j % 2 == 0 else 'audio'
            return (row.get('hold') == 30 and row.get('at') == (j // 2) * 30
                    and row.get('from') == 0 and row.get('to') == 30 and row.get('speed') == 1
                    and row.get('track') == ('LV' if kind == 'video' else 'LA')
                    and row.get('asset') == media_selections[kind][-1]['asset'])
        if {row.get('id') for row in children} != expected or not all(matches_child(row) for row in children):
            raise RuntimeError(f'large shot {i} child identities or durations differ')
        if {row.get('id') for row in internal.get('tracks', [])} != {'LV', 'LA'}:
            raise RuntimeError(f'large shot {i} child tracks differ')
        if any(row.get('app', {}).get('scaleAppliesToPositionedClips') is not True
               or type(row.get('app', {}).get('clipPlacementVersion')) is not int
               or row['app']['clipPlacementVersion'] != 1 for row in internal['tracks']):
            raise RuntimeError(f'large shot {i} child track appearance markers differ')
        if canonical_media_ids(internal) != {media_selections[k][-1]['object_id'] for k in ('video', 'audio')}:
            raise RuntimeError(f'large shot {i} media identities differ')
        per_shot.append({'shot_id': shot['shot_id'], 'occurrence_id': occurrence['occurrence_id'],
                         'occurrence_duration_ms': occurrence['duration_ms'],
                         'child_clips': len(children), 'child_tracks': len(internal['tracks']), 'child_hold_seconds': 30})
    large_measurement = {'shots': per_shot, 'child_clip_count': sum(row['child_clips'] for row in per_shot),
                         'child_commit_count': sum('child' in row['label'].lower() for row in receipts),
                         'child_commit_elapsed_ms': sum(row['elapsed_ms'] for row in receipts if 'child' in row['label'].lower())}
measurement = {
    'large_shots': large_measurement,
    'accepted_prefix_asset_counts': {'image': image_n, 'video': video_n, 'audio': audio_n},
    'clip_count': len(root_clips(heavy_doc)), 'document_bytes': doc_bytes,
    'document_bytes_source': 'accepted Runtime response data.canonical_document, canonical JSON',
    'registry_asset_count': len(assets),
    'created_track_count': created_track_count,
    'total_track_count': len(heavy_track_rows),
    'visual_track_count': sum(row.get('kind') == 'visual' for row in heavy_track_rows),
    'audio_track_count': sum(row.get('kind') == 'audio' for row in heavy_track_rows),
    'placement_lane_id': 'V1',
    'sdk_commit_batch_size': batch_size,
    'media_import_count': len(media_import_receipts),
    'media_import_receipt_count': sum(bool(row.get('receipt_id')) for row in media_import_receipts),
    'media_import_elapsed_ms': media_import_elapsed_ms,
    'clip_commit_elapsed_ms': sum(row['elapsed_ms'] for row in receipts if row['timeline_id'] == timeline_id and row['label'].startswith('Add fixture clips')),
    'shot_commit_elapsed_ms': sum(row['elapsed_ms'] for row in receipts if row['timeline_id'] == timeline_id and row['label'].startswith('Create fixture shots')),
    'accepted_commit_receipts': receipts,
    'accepted_heavy_head': last_results[timeline_id],
    'runtime_object_ids': sorted(canonical_media_ids(heavy_doc)),
    'heavy_warm_move_samples_ms': heavy_times,
    'one_clip_warm_move_samples_ms': control_times,
    'heavy_warm_move_median_ms': statistics.median(heavy_times),
    'one_clip_warm_move_median_ms': statistics.median(control_times),
    'warm_move_median_ratio': statistics.median(heavy_times) / statistics.median(control_times),
    'one_clip_document_bytes': control_bytes, 'one_clip_count': len(root_clips(control_doc)),
    'named': {'tracks': [{'id': row['id'], 'label': row.get('label', row['id']),
                          'kind': row['kind'], **({'role': row['role']} if 'role' in row else {})}
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
  if (variant === 'film-shaped') {
    if (!prepareMedia) throw new Error('film-shaped fixture construction is incomplete: word provenance, packs, overlays and legacy overrun are not integrated; use --prepare-media to generate sources only');
    fs.mkdirSync(scratch, {recursive: true});
    assertDisk();
    const dir = fs.mkdtempSync(path.join(scratch, 'film-media-'));
    const video = path.join(dir, 'video.mp4');
    const audio = path.join(dir, 'audio.wav');
    for (const args of filmMediaCommands(mediaSize, video, audio))
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args]);
    const bytes = fs.statSync(video).size + fs.statSync(audio).size;
    if (bytes > 1024 ** 3 || freeBytes() - bytes < 15 * 1024 ** 3)
      throw new Error('generated media exceeds 1 GiB or estimated import would cross the 15 GiB floor');
    console.log(JSON.stringify({variant, status: 'media-only', clip_count: clipTarget, media_size: mediaSize,
      video, audio, object_ids: [sha256ObjectId(video), sha256ObjectId(audio)]}, null, 2));
    return;
  }
  if (!root || !baseUrl) throw new Error('set SAVE_LOOP_ROOT and SAVE_LOOP_BASE_URL for the isolated SL-1 stack');
  const origin = new URL(baseUrl);
  if (!['http:', 'https:'].includes(origin.protocol)) throw new Error('SAVE_LOOP_BASE_URL must use HTTP or HTTPS');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))
    throw new Error('save-loop fixture creation requires the owned local isolated stack');
  if (origin.pathname !== '/' || origin.search || origin.hash) throw new Error('SAVE_LOOP_BASE_URL must be a local origin without a path or query');
  if (!Number.isInteger(clipTarget) || clipTarget < 616) throw new Error('SAVE_LOOP_CLIPS must be an integer >= 616');
  const resolvedRoot = fs.realpathSync(root);
  const marker = path.join(resolvedRoot, '.sl1-stack-owned');
  if (resolvedRoot !== path.resolve(root) || !fs.existsSync(marker)
      || fs.readFileSync(marker, 'utf8') !== `astrid-app-sl1-stack-v1 ${resolvedRoot}`)
    throw new Error('SAVE_LOOP_ROOT must be the exact owned isolated stack');
  const pid = fs.readFileSync(path.join(resolvedRoot, 'editor.pid'), 'utf8').trim();
  if (!/^\d+$/.test(pid)) throw new Error('owned stack editor PID is invalid');
  const ps = spawnSync('ps', ['-p', pid, '-o', 'args='], {encoding: 'utf8'});
  const cwd = process.platform === 'darwin'
    ? spawnSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], {encoding: 'utf8'}).stdout?.split('\n').find(line => line.startsWith('n'))?.slice(1)
    : fs.realpathSync(`/proc/${pid}/cwd`);
  if (ps.status !== 0 || !ps.stdout.includes('dev-local-workspace.mjs')
      || !ps.stdout.includes(path.join(resolvedRoot, 'data')) || cwd !== repo)
    throw new Error('editor process does not match the owned stack and App checkout');
  const ports = stackPorts(root);
  if (Number(origin.port) !== ports.editor) throw new Error(`SAVE_LOOP_BASE_URL port must match this stack's editor port ${ports.editor}`);
  fs.mkdirSync(scratch, {recursive: true});
  assertDisk();
  const diskBefore = freeBytes();
  const mediaRoot = path.join(scratch, 'generated-media');
  const images = await mediaPool({dir: path.join(mediaRoot, 'images'), prefix: 'image-', suffix: '.png', count: imageCount,
    ffmpegArgs: pattern => ['-f', 'lavfi', '-i', `color=c=red:s=1920x1080:r=1:d=${imageCount}`,
      '-vf', "fps=1,hue=h='2*n'", '-frames:v', String(imageCount), '-start_number', '0', '-y', pattern]});
  stampGeneratedPngs(images);
  const videos = await mediaPool({dir: path.join(mediaRoot, 'videos'), prefix: 'video-', suffix: '.mp4', count: videoCount,
    ffmpegArgs: pattern => ['-f', 'lavfi', '-i', `color=c=red:s=1920x1080:r=30:d=${videoCount * 5}`,
      '-vf', "hue=h='2*n'", '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-g', '30', '-force_key_frames', 'expr:gte(t,n_forced*5)', '-f', 'segment', '-segment_time', '5',
      '-segment_format', 'mp4', '-reset_timestamps', '1', '-y', pattern]});
  await stampGeneratedVideos(videos);
  const audios = await mediaPool({dir: path.join(mediaRoot, 'audio'), prefix: 'audio-', suffix: '.wav', count: audioCount,
    ffmpegArgs: pattern => ['-f', 'lavfi', '-i', `aevalsrc=sin(2*PI*(440+floor(t))*t):s=44100:d=${audioCount}`,
      '-f', 'segment', '-segment_time', '1', '-segment_format', 'wav', '-reset_timestamps', '1', '-y', pattern]});
  if (largeShots) {
    const dir = path.join(mediaRoot, 'large');
    fs.mkdirSync(dir, {recursive: true});
    const video = path.join(dir, 'long-video.mp4');
    const audio = path.join(dir, 'long-audio.wav');
    assertDisk();
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'testsrc2=s=1280x720:r=15:d=90', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p', '-y', video]);
    assertDisk();
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'sine=frequency=317:sample_rate=44100:duration=90', '-y', audio]);
    videos.push(video); audios.push(audio);
    const bytes = [...images, ...videos, ...audios].reduce((sum, file) => sum + fs.statSync(file).size, 0);
    if (bytes > 1024 ** 3 || freeBytes() - bytes < 15 * 1024 ** 3)
      throw new Error('generated media exceeds 1 GiB or estimated import would cross the 15 GiB floor');
  }
  assertUniqueAssets(images, 'image');
  assertUniqueAssets(videos, 'video');
  assertUniqueAssets(audios, 'audio');
  const objectIdsByKind = {
    image: images.map(sha256ObjectId),
    video: videos.map(sha256ObjectId),
    audio: audios.map(sha256ObjectId),
  };
  const expectedObjectIds = [...objectIdsByKind.image, ...objectIdsByKind.video, ...objectIdsByKind.audio];
  if (expectedObjectIds.length !== clipTarget + (largeShots ? 2 : 0) || new Set(expectedObjectIds).size !== expectedObjectIds.length)
    throw new Error(`expected ${clipTarget} unique generated media object identities; got ${expectedObjectIds.length}`);
  const dropFiles = images.slice(0, 3);
  const dropObjectIds = dropFiles.map(sha256ObjectId);
  if (dropFiles.length !== 3 || dropObjectIds.some((id, index) => id !== objectIdsByKind.image[index]))
    throw new Error('drop file identities are not paired with their generated Runtime object IDs');
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
  const doorPort = ports.door;
  const createTimeline = async (id, name) => {
    const response = await post(baseUrl, `/v1/projects/${encodeURIComponent(projectId)}/timelines`,
      {timeline_id: id, name}, `p77-${id}`);
    if (findString(response, 'timeline_id') !== id) throw new Error(`Runtime did not confirm timeline id ${id}`);
  };
  await createTimeline(timelineId, 'Generated heavy timeline');
  await createTimeline(oneClipTimelineId, 'One-clip timing control');
  const shots = Array.from({length: 46}, (_, i) => ({
    shot_id: `fixture-shot-${nonce}-${String(i + 1).padStart(2, '0')}`,
    name: `Fixture shot ${String(i + 1).padStart(2, '0')}`,
  }));

  if (largeShots) for (let i = 0; i < 3; i++) shots.push({
    shot_id: `large-shot-${nonce}-${i}`, name: `Large shot ${i + 1}`,
    on: 200 + i * 481, duration: 480,
  });

  const versionsDir = path.resolve(root, 'program/versions');
  const installedVersions = fs.readdirSync(versionsDir).filter(name => name !== 'current'
    && fs.existsSync(path.join(versionsDir, name, 'py/bin/python')));
  if (installedVersions.length !== 1) throw new Error(`expected one pinned SDK Python below ${versionsDir}; found ${installedVersions.length}`);
  const python = path.join(versionsDir, installedVersions[0], 'py/bin/python');
  const runtimeCli = path.join(versionsDir, installedVersions[0], 'py/bin/astrid-runtime');
  const stackTmp = path.resolve(root, 'tmp');
  const xdgData = path.resolve(root, 'home/.local/share');
  const xdgConfig = path.resolve(root, 'home/.config');
  fs.mkdirSync(stackTmp, {recursive: true});
  fs.mkdirSync(xdgData, {recursive: true});
  fs.mkdirSync(xdgConfig, {recursive: true});
  const configPath = path.join(scratch, `config-${nonce}.json`);
  const scriptPath = path.join(scratch, `build-${nonce}.py`);
  const measurementPath = path.join(scratch, `measurement-${nonce}.json`);
  const outboxRoot = path.join(scratch, `outbox-${nonce}`);
  fs.mkdirSync(outboxRoot, {recursive: true});
  const media = {image: images, video: videos, audio: audios};
  const expectedObjectIdsByKind = objectIdsByKind;
  fs.writeFileSync(configPath, JSON.stringify({project_id: projectId, timeline_id: timelineId,
    one_clip_timeline_id: oneClipTimelineId, clip_target: clipTarget, media, shots, large_shots: largeShots,
    visual_tracks: visualTracks, audio_tracks: audioTracks, outbox_root: outboxRoot,
    expected_object_ids: expectedObjectIds, expected_object_ids_by_kind: expectedObjectIdsByKind}));
  fs.writeFileSync(scriptPath, sdkScript, {mode: 0o600});
  try {
    await run(python, ['-I', scriptPath], {env: {...process.env,
      HOME: path.resolve(root, 'home'), TMPDIR: stackTmp, XDG_DATA_HOME: xdgData,
      XDG_CONFIG_HOME: xdgConfig, ASTRID_RUNTIME_DATA_ROOT: path.resolve(root, 'data'),
      ASTRID_RUNTIME_DOOR_PORT: String(doorPort), ASTRID_RUNTIME_CLI: runtimeCli,
      ASTRID_RUNTIME_LAUNCHER: runtimeCli,
      SAVE_LOOP_CONFIG_PATH: configPath, SAVE_LOOP_MEASUREMENT_PATH: measurementPath}});
  } finally {
    fs.rmSync(scriptPath, {force: true});
    fs.rmSync(configPath, {force: true});
  }
  const measurement = JSON.parse(fs.readFileSync(measurementPath, 'utf8'));
  fs.rmSync(measurementPath, {force: true});
  const timelineIndex = await get(baseUrl, `/v1/projects/${encodeURIComponent(projectId)}/timelines`);
  const head = (timelineIndex.items || []).find(row => row.timeline_id === timelineId);
  if (!head?.head_revision_id || !head?.head_publication_id)
    throw new Error('public Runtime timeline index omitted the fixture head revision or publication');
  const headRevisionRoute = `/v1/projects/${encodeURIComponent(projectId)}/timelines/${encodeURIComponent(timelineId)}`
    + `/composition-revisions/${encodeURIComponent(head.head_revision_id)}`;
  const headRevision = await get(baseUrl, headRevisionRoute);
  if (headRevision.revision_id !== head.head_revision_id
      || headRevision.revision_id !== measurement.accepted_heavy_head.accepted_revision_id
      || headRevision.content_digest !== measurement.accepted_heavy_head.content_digest
      || head.head_publication_id !== measurement.accepted_heavy_head.receipt_id)
    throw new Error('public Runtime head does not match the final accepted SDK receipt and canonical document');
  const headObjectIds = [...runtimeMediaIds(headRevision.payload)].sort();
  const parentObjectIds = largeShots ? expectedObjectIds.filter(id => ![objectIdsByKind.video.at(-1), objectIdsByKind.audio.at(-1)].includes(id)) : expectedObjectIds;
  const missingHeadIds = parentObjectIds.filter(objectId => !headObjectIds.includes(objectId));
  const unexpectedHeadIds = headObjectIds.filter(objectId => !parentObjectIds.includes(objectId));
  if (missingHeadIds.length || unexpectedHeadIds.length)
    throw new Error(`public Runtime head media identity set differs (missing ${missingHeadIds.length}, unexpected ${unexpectedHeadIds.length})`);
  measurement.actual_head = {revision_id: headRevision.revision_id,
    publication_id: head.head_publication_id, content_digest: headRevision.content_digest,
    verified_object_id_count: headObjectIds.length, route: `/api/runtime${headRevisionRoute}`};
  assertDisk();
  const {named, ...measuredValues} = measurement;
  const passed = measurement.clip_count >= clipTarget && measurement.document_bytes >= byteTarget
    && measurement.warm_move_median_ratio >= ratioTarget;
  const manifest = {
    schema_version: 1,
    variant,
    project_id: projectId,
    timeline_id: timelineId,
    one_clip_timeline_id: oneClipTimelineId,
    tracks: {
      visual: named.tracks.filter(row => row.kind === 'visual'),
      audio: named.tracks.filter(row => row.kind === 'audio'),
      occurrence_track_id: named.occurrences[0].track_id,
    },
    clips: {
      video: {primary: named.video[0], repeated_delete_and_split: named.video.slice(1, 10)},
      audio: {primary: named.audio[0], additional: named.audio.slice(1, 10)},
      image: named.image[0],
      shot_occurrences: named.occurrences,
    },
    shots,
    media: {synthetic: true, asset_counts: {image: images.length, video: videos.length, audio: audios.length},
      retained_object_ids: parentObjectIds, drop_files: dropFiles,
      drop_object_ids: dropObjectIds},
    measurement: {...measuredValues, targets: {clip_count: clipTarget, document_bytes: byteTarget,
      warm_move_median_ratio: ratioTarget}, status: passed ? 'pass' : 'fail'},
    live_proof: {stack_url: baseUrl, generated_at: new Date().toISOString(), second_machine: 'pending'},
  };
  if (largeShots) Object.assign(manifest.measurement.large_shots, {
    child_object_ids: [objectIdsByKind.video.at(-1), objectIdsByKind.audio.at(-1)],
    generated_media_bytes: [...images, ...videos, ...audios].reduce((n, file) => n + fs.statSync(file).size, 0),
    unique_imported_object_count: expectedObjectIds.length, disk_before_bytes: diskBefore,
    disk_after_bytes: freeBytes(), build_wall_ms: Date.now() - startedAt,
  });
  const manifestPath = path.join(scratch, `manifest-${projectId}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Video target: ${named.video[0].clip_id}`);
  console.log(`Audio target: ${named.audio[0].clip_id}`);
  console.log(JSON.stringify(manifest.measurement, null, 2));
  if (!passed) throw new Error(`measured fixture misses target; use observed size/ratio to set SAVE_LOOP_CLIPS higher; manifest retained at ${manifestPath}`);
}

main().catch(error => { console.error(`build-fixture: ${error.message}`); process.exitCode = 1; });
