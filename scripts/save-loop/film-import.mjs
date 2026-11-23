// Draft construction of a prepared Runtime import. This has not been validated
// against a running Runtime; callers must verify the accepted closure and pins.
import {createHash} from 'node:crypto';

// Runtime uses json.dumps(sort_keys=True, separators=(',', ':'), ensure_ascii=False).
// Reject numbers whose JS notation can differ from Python's JSON encoder.
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (value !== 0 && (Math.abs(value) < 0.0001 || Math.abs(value) >= 1e16)))
      throw new Error('number outside canonical fixture range');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  throw new Error('value is not fixture JSON');
}
export function revisionDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

// selections are actual Runtime media selections for generated video objects.
// Every selection needs asset, object_id, generation_id and variant_id. The
// caller must ensure sources are long enough for every requested hold.
export function prepareFilmImport({projectId, timelineId, shape, selections, name = 'Generated film-shaped timeline'}) {
  if (!projectId || !timelineId || !shape?.shots?.length || !Array.isArray(selections) || !selections.length)
    throw new Error('project, timeline, shape and generated selections are required');
  for (const pin of selections) {
    if (![pin.asset, pin.generation_id, pin.variant_id].every(v => typeof v === 'string' && v)
        || !/^sha256:[a-f0-9]{64}$/.test(pin.object_id)) throw new Error('invalid media selection');
  }
  const id = suffix => `${timelineId}-${suffix}`;
  const binding = pin => ({media_id: pin.object_id, type: 'video', generationId: pin.generation_id, variantId: pin.variant_id});
  let index = 0;
  const internal = [], shots = [], occurrences = [], used = new Set();
  const original = new Map();
  for (const shot of shape.shots) {
    const suffix = String(shot.index).padStart(4, '0');
    const shotId = id(`shot-${suffix}`), shotRevision = id(`shot-rev-${suffix}`), internalRevision = id(`internal-rev-${suffix}`);
    const assets = {};
    const clips = shot.children.map(child => {
      const pin = selections[index++ % selections.length];
      assets[pin.asset] = binding(pin); used.add(pin.object_id);
      const row = {id: `footage-${shot.index}-${child.index}`, clipType: 'media', track: `LV${child.track + 1}`,
        asset: pin.asset, at: child.at, hold: child.hold, from: 0, to: child.hold, speed: 1};
      original.set(`${shot.index}:${child.index}`, row);
      return row;
    });
    const payload = {tracks: Array.from({length: 4}, (_, n) => ({id: `LV${n + 1}`, kind: 'visual', label: `LV${n + 1}`})),
      clips, effects: [], audio: [], layout: {}, registry: {assets}, assets: [], output: {fps: 30}};
    const internalDigest = revisionDigest(payload);
    internal.push({timeline_id: timelineId, revision_id: internalRevision, payload, content_digest: internalDigest});
    const shotPayload = {metadata: {title: `Fixture shot ${shot.index + 1}`}, items: [], pools: [], selected_variants: {},
      provenance: {}, generation_inputs: {}, audio_bindings: [], text_bindings: [], internal_timeline_revision_id: internalRevision};
    const shotDigest = revisionDigest(shotPayload);
    shots.push({shot_id: shotId, revision_id: shotRevision, internal_timeline_revision_id: internalRevision,
      payload: shotPayload, content_digest: shotDigest});
    occurrences.push({occurrence_id: id(`occ-${shot.index}`), shot_id: shotId, shot_revision_id: shotRevision,
      placement: {start_ms: Math.round(shot.on * 1000)}, source_offset: 0, duration_ms: Math.round(shot.duration * 1000),
      speed: 1, track: 'V1', transform: {}, gain: 1, muted: false, provenance: {}});
  }
  // Import represents a historical baseline, so shorten one placement rather
  // than introducing an overrun through the normal timeline edit validator.
  const legacy = occurrences.at(-1);
  if (legacy.duration_ms <= 100) throw new Error('last occurrence is too short for historical overrun');
  legacy.duration_ms -= 100;
  const parentAssets = {};
  const clips = shape.overlays.map((overlay, n) => {
    const row = original.get(`${overlay.shotIndex}:${overlay.childIndex}`);
    if (!row) throw new Error('overlay references a missing original');
    const pin = selections[index++ % selections.length];
    parentAssets[pin.asset] = binding(pin); used.add(pin.object_id);
    return {id: `overlay-${n}`, clipType: 'media', track: `V${n + 2}`, asset: pin.asset,
      at: overlay.at, hold: overlay.hold, from: 0, to: overlay.hold, speed: 1,
      entrance: {type: 'fade', duration: 0.2, params: {easing: n ? 'in' : 'out'}}};
  });
  for (const [n, element] of (shape.elements || []).entries()) {
    clips.push({id: `element-${element.kind}`, clipType: n === 0 ? 'text-card' : 'am-discord',
      track: `V${n + 4}`, at: element.at, hold: element.hold,
      params: n === 0 ? {content: 'Generated fixture'} : {}});
  }
  const tracks = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6'].map(id => ({id, kind: 'visual', label: id}));
  const parent = {config: {output: {fps: 30}, clips, tracks}, registry: {assets: parentAssets}, clips, tracks, occurrences};
  const publication = {project_id: projectId, timeline_id: timelineId, expected_head: null,
    parent_revision_id: id('parent-rev'), content_digest: revisionDigest(parent), parent_composition: parent,
    internal_timeline_revisions: internal, shot_revisions: shots,
    dependency_manifest: {shots: shots.map(({shot_id, revision_id, internal_timeline_revision_id, content_digest}) =>
      ({shot_id, revision_id, internal_timeline_revision_id, content_digest})),
      internal_timelines: internal.map(({timeline_id, revision_id, content_digest}) => ({timeline_id, revision_id, content_digest})),
      media: [...used].sort().map(media_id => ({media_id, content_digest: media_id}))}};
  return {timeline_id: timelineId, name, publication, transcripts: [], text_bindings: [],
    differences: {missing_effects: [], different_effects: []}};
}
