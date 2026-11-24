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
export function prepareFilmFootage({timelineId, shape, selections, legacyWord, narration, omitAmbiguousAnchors = false, mediaSize = {width: 1280, height: 720}}) {
  if (!Number.isSafeInteger(mediaSize?.width) || !Number.isSafeInteger(mediaSize?.height) ||
      mediaSize.width < 2 || mediaSize.height < 2 || mediaSize.width % 2 || mediaSize.height % 2)
    throw new Error('invalid film output dimensions');
  const output = {resolution: `${mediaSize.width}x${mediaSize.height}`, fps: 30, file: 'output.mp4'};
  if (!timelineId || !shape?.shots?.length || !Array.isArray(selections) || !selections.length)
    throw new Error('project, timeline, shape and generated selections are required');
  for (const pin of selections) {
    if (![pin.asset, pin.generation_id, pin.variant_id].every(v => typeof v === 'string' && v)
        || !/^sha256:[a-f0-9]{64}$/.test(pin.object_id)) throw new Error('invalid media selection');
  }
  if (legacyWord && (!legacyWord.documentId || legacyWord.content?.schema !== 'media.transcript/v1' ||
      legacyWord.content?.media_id !== (narration?.selection?.object_id || selections[0].object_id) || typeof legacyWord.content?.source_id !== 'string' ||
      typeof legacyWord.text !== 'string' ||
      !/^[a-zA-Z0-9_-]+$/.test(legacyWord.text) || !Number.isFinite(legacyWord.at) || legacyWord.at < 0))
    throw new Error('invalid legacy word declaration');
  if (narration && (!narration.selection || !narration.image || !Array.isArray(narration.words) || narration.words.length < 4)) throw new Error('invalid narration fixture');
  const id = suffix => `${timelineId}-${suffix}`;
  const binding = (pin, type = 'video') => {
    const metadata = pin.metadata;
    if (metadata !== undefined && (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)))
      throw new Error('invalid media metadata');
    const {width, height, duration_seconds: duration} = metadata || {};
    if ((width !== undefined || height !== undefined)
        && (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0))
      throw new Error('invalid media resolution');
    if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0))
      throw new Error('invalid media duration');
    return {media_id: pin.object_id, type, generationId: pin.generation_id, variantId: pin.variant_id,
      ...(width !== undefined ? {resolution: `${width}x${height}`} : {}),
      ...(duration !== undefined ? {duration} : {})};
  };
  const narrationShot = shape.ripple ? 1 : 0;
  let index = 0;
  const internal = [], shots = [], occurrences = [], used = new Set();
  const original = new Map(), originalPins = new Map();
  for (const shot of shape.shots) {
    const suffix = String(shot.index).padStart(4, '0');
    const shotId = id(`shot-${suffix}`), shotRevision = id(`shot-rev-${suffix}`), internalRevision = id(`internal-rev-${suffix}`);
    const assets = {};
    const clips = shot.children.map(child => {
      const pin = narration && shot.index === narrationShot && child.index === 0 ? narration.image : selections[index++ % selections.length];
      assets[pin.asset] = binding(pin, pin === narration?.image ? 'image' : 'video'); used.add(pin.object_id);
      const row = {id: `footage-${shot.index}-${child.index}`, clipType: 'media', track: `LV${child.track + 1}`,
        asset: pin.asset, at: child.at, hold: child.hold, from: 0, to: child.hold, speed: 1};
      // Occurrence durations are stored in integer milliseconds. Keep child
      // frame ends inside a rounded-down placement; the last placement retains
      // its separately declared historical overrun below.
      if (shot.index !== (shape.ripple ? 0 : shape.shots.length - 1) && row.at + row.hold > Math.round(shot.duration * 1000) / 1000) {
        row.hold -= 1 / 30;
        row.to = row.hold;
      }
      if (narration && shot.index === narrationShot && child.index < 4) {
        row.at = narration.words[child.index].at;
        if (narration.splitAt) row.hold = row.to = 0.1;
        if ((!shape.ripple || child.index < 2) && (!omitAmbiguousAnchors || child.index < 2)) row.app = {astrid: {on: `"${narration.words[child.index].text}"`, for: row.hold}};
      }
      if (legacyWord && !narration && shot.index === narrationShot && child.index === 1) {
        if (legacyWord.at + child.hold > shot.duration) throw new Error('legacy word clip exceeds its shot');
        row.at = legacyWord.at;
        row.app = {astrid: {on: `"${legacyWord.text}"`, for: child.hold}};
      }
      if (shape.ripple && shot.index === 1 && child.index >= 2 && row.at < 0.7) row.at = 0.7;
      if (shape.ripple && narration && shot.index === 0 && (child.index === 2 || child.index === 3)) {
        row.at = child.index === 2 ? 0 : 1 / 30; row.hold = row.to = 3 / 30;
        if (!omitAmbiguousAnchors) row.app = {astrid: {on: '"repeat"', for: row.hold}};
      }
      original.set(`${shot.index}:${child.index}`, row);
      originalPins.set(`${shot.index}:${child.index}`, pin);
      return row;
    });
    const payload = {tracks: Array.from({length: 4}, (_, n) => ({id: `LV${n + 1}`, kind: 'visual', label: `LV${n + 1}`})),
      clips, effects: [], audio: [], layout: {}, registry: {assets}, assets: [], output: {...output}};
    if (narration && shot.index === narrationShot) {
      const pin = narration.selection;
      payload.tracks.push({id: 'LA1', kind: 'audio', label: 'LA1'});
      payload.registry.assets[pin.asset] = binding(pin, 'audio');
      if (narration.splitAt) {
        const {gapStart, gapEnd} = narration.splitAt;
        if (!Number.isFinite(gapStart) || !Number.isFinite(gapEnd) || gapStart <= 0 ||
            gapEnd - gapStart < 0.5 - 1e-9 || gapEnd >= shot.duration)
          throw new Error('invalid narration cut gap');
        payload.clips.push({id: 'narration', clipType: 'audio', track: 'LA1', asset: pin.asset,
          at: 0, hold: gapStart, from: 0, to: gapStart, speed: 1});
        const narrationEnd = narration.end ?? (Math.floor(shot.duration * 30) / 30 - 1 / 30);
        if (!Number.isFinite(narrationEnd) || narrationEnd <= gapEnd || narrationEnd > shot.duration)
          throw new Error('invalid narration end');
        payload.clips.push({id: 'narration-later', clipType: 'audio', track: 'LA1', asset: pin.asset,
          at: gapEnd, hold: narrationEnd - gapEnd, from: gapEnd, to: narrationEnd, speed: 1});
      } else {
        payload.clips.push({id: 'narration', clipType: 'audio', track: 'LA1', asset: pin.asset, at: 0, hold: shot.duration, from: 0, to: shot.duration, speed: 1});
      }
      used.add(pin.object_id);
    }
    if (shape.ripple && narration && shot.index === 0) {
      const pin = narration.selection;
      payload.tracks.push({id: 'LA1', kind: 'audio', label: 'LA1'});
      payload.registry.assets[pin.asset] = binding(pin, 'audio');
      payload.clips.push({id: 'repeat-narration', clipType: 'audio', track: 'LA1', asset: pin.asset,
        at: 0, hold: 3 / 30, from: 0, to: 3 / 30, speed: 1});
      used.add(pin.object_id);
    }
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
  const legacy = shape.ripple ? occurrences[0] : occurrences.at(-1);
  if (legacy.duration_ms <= 100) throw new Error('last occurrence is too short for historical overrun');
  legacy.duration_ms -= 100;
  const parentAssets = {};
  const clips = shape.overlays.map((overlay, n) => {
    const row = original.get(`${overlay.shotIndex}:${overlay.childIndex}`);
    if (!row) throw new Error('overlay references a missing original');
    const originalPin = originalPins.get(`${overlay.shotIndex}:${overlay.childIndex}`);
    const isImage = originalPin === narration?.image;
    const pin = isImage ? (narration.overlayImage || selections[index++ % selections.length]) :
      (selections.find(candidate => candidate.object_id !== originalPin.object_id) || selections[index++ % selections.length]);
    parentAssets[pin.asset] = binding(pin, isImage && narration.overlayImage ? 'image' : 'video'); used.add(pin.object_id);
    return {id: `overlay-${n}`, clipType: 'media', track: `V${n + 2}`, asset: pin.asset,
      at: shape.shots[overlay.shotIndex].on + row.at, hold: row.hold, from: 0, to: row.hold, speed: 1,
      entrance: {type: 'fade', duration: 0.2, params: {easing: n ? 'in' : 'out'}}};
  });
  return {internal, shots, occurrences, clips, parentAssets, used};
}

// Prepare the complete historical import around the reusable footage structure.
export function prepareFilmImport({projectId, timelineId, shape, selections, legacyWord, narration, collectionElement, omitAmbiguousAnchors = false, mediaSize = {width: 1280, height: 720}, name = 'Generated film-shaped timeline'}) {
  if (!projectId) throw new Error('project, timeline, shape and generated selections are required');
  const {internal, shots, occurrences, clips, parentAssets, used} =
    prepareFilmFootage({timelineId, shape, selections, legacyWord, narration, omitAmbiguousAnchors, mediaSize});
  const id = suffix => `${timelineId}-${suffix}`;
  for (const [n, element] of (shape.elements || []).entries()) {
    const collection = element.kind === 'collection-pack' && collectionElement;
    clips.push({id: `element-${element.kind}`, clipType: collection ? collection.id : (n === 0 || collectionElement ? 'text-card' : 'am-discord'),
      track: `V${n + 4}`, at: element.at, hold: element.hold,
      params: collection ? {text: 'Generated fixture'} : (n === 0 || collectionElement ? {content: 'Generated fixture'} : {}),
      ...(collection ? {elementRef: collection} : {})});
  }
  if (collectionElement) {
    const animations = ['fade', 'fade-up', 'scale-in', 'slide-left', 'slide-up', 'type-on'];
    const rows = internal.flatMap(row => row.payload.clips).filter(row => row.clipType === 'media').slice(4, 14);
    if (rows.length !== 10) throw new Error('film fixture needs ten animation clips');
    rows.forEach((row, i) => { row[i === 4 ? 'exit' : 'entrance'] = {type: i < 6 ? animations[i] : 'fade', duration: 0.2,
      ...(i >= 6 ? {params: {easing: ['in', 'out', 'in-out', 'step'][i - 6]}} : {})}; });
    for (const row of internal) row.content_digest = revisionDigest(row.payload);
  }
  const tracks = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6'].map(id => ({id, kind: 'visual', label: id}));
  const config = {output: {resolution: `${mediaSize.width}x${mediaSize.height}`, fps: 30, file: 'output.mp4'}, clips, tracks};
  if (legacyWord) config.bundle = {transcriptReferences: {schema: 'media.transcript.references/v1',
    associations: [{documentId: legacyWord.documentId, mediaId: legacyWord.content.media_id, sourceId: legacyWord.content.source_id}]}};
  const parent = {config, registry: {assets: parentAssets}, clips, tracks, occurrences};
  const publication = {project_id: projectId, timeline_id: timelineId, expected_head: null,
    parent_revision_id: id('parent-rev'), content_digest: revisionDigest(parent), parent_composition: parent,
    internal_timeline_revisions: internal, shot_revisions: shots,
    dependency_manifest: {shots: shots.map(({shot_id, revision_id, internal_timeline_revision_id, content_digest}) =>
      ({shot_id, revision_id, internal_timeline_revision_id, content_digest})),
      internal_timelines: internal.map(({timeline_id, revision_id, content_digest}) => ({timeline_id, revision_id, content_digest})),
      media: [...used].sort().map(media_id => ({media_id, content_digest: media_id}))}};
  const transcripts = legacyWord ? [{document_id: legacyWord.documentId, kind: 'media.transcript', content: legacyWord.content}] : [];
  return {timeline_id: timelineId, name, publication, transcripts, text_bindings: [],
    differences: {missing_effects: [], different_effects: []}};
}
