"""Populate a film fixture through Runtime's managed media and import routes.

Launched with an existing launcher session. A measurement file is written only
once the imported closure and subsequent anchored commit have been verified.
"""
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from collections.abc import Mapping

from astrid.sdk import AstridClient
from astrid.sdk.authoring_media import _metadata
from astrid.sdk.media_transcript import build_transcript, transcript_document_id
from astrid.sdk.timeline.commit import bundle_from_document
from astrid.sdk.timeline.native_source_inputs import read_verified_transcript
from astrid.sdk.timeline.native_word_anchor import capture_anchor
from astrid.sdk.timeline._shot_word_retime import ShotWordRetimeInputs, require_retime_word_scope
from astrid.core.timeline import moments
from astrid.core.timeline.authoring_bundle import _digest


def data(value):
    if not isinstance(value, Mapping):
        raise RuntimeError('Runtime returned a non-object')
    return dict(value.get('data', value))


def prove_target(retime, selector, child, word, document_id, source, word_id, ambiguous):
    """Check ambiguity in the same authenticated word pool used by retiming."""
    declaration = child.get('app', {}).get('astrid', {}).get('on')
    if declaration != f'"{word}"':
        raise RuntimeError('accepted word declaration differs from target')
    moment = moments.parse(declaration)
    pool, captures = retime.words
    require_retime_word_scope(retime.bundle, captures, moment.line)
    hits = moments.find_words(moment, pool)
    if ambiguous:
        if len(hits) <= 1:
            raise RuntimeError('expected ambiguous word')
        return 'ambiguous'
    if len(hits) != 1:
        raise RuntimeError('expected unique word')
    binding, _, _ = retime.resolve(selector, child, 'on', f'"{word}"')
    if (binding.document_id != document_id or binding.source != source
            or binding.word_ids != (word_id,)):
        raise RuntimeError('unexpected word resolution')
    return 'resolved'


def readback_extents(saved):
    """Extents of an accepted head, in seconds: the end of the last clip and of the last occurrence."""
    content = max([row['at'] + row['hold'] for row in saved['parent']['clips']] or [0])
    occurrence = 0
    for placement in saved['placements']:
        start = placement['placement']['start_ms'] / 1000
        occurrence = max(occurrence, start + placement['duration_ms'] / 1000)
        for row in saved['shots'][placement['shot_id']]['internal_timeline']['clips']:
            content = max(content, start + row['at'] + row['hold'])
    return {'content_extent_seconds': round(content, 3), 'occurrence_extent_seconds': round(occurrence, 3)}


def verify_readback(plan, accepted, tolerance=0.002):
    """Fail unless the accepted head has the planned shots, child/parent counts and extents.

    Individual clip holds are not compared, so the documented short shot-2 children of the
    default build (and the real-extent ones under --content-extent) both pass."""
    problems = []
    for key in ('shots', 'child_clips', 'parent_clips'):
        if accepted[key] != plan[key]:
            problems.append(f'{key}: planned {plan[key]}, accepted {accepted[key]}')
    for key in ('content_extent_seconds', 'occurrence_extent_seconds'):
        if abs(accepted[key] - plan[key]) > tolerance:
            problems.append(f'{key}: planned {plan[key]}, accepted {accepted[key]}')
    if problems:
        raise RuntimeError('accepted head does not match the planned fixture: ' + '; '.join(problems))


def build(cfg, client):
    project, timeline = cfg['project_id'], cfg['timeline_id']
    transport = client._remote._transport
    pins, imports = {}, []
    for kind in ('image', 'video', 'audio'):
        paths = cfg['media'][kind]
        if not paths:
            raise ValueError(f'generated {kind} media is required')
        pins[kind] = []
        for path in paths:
            path = Path(path)
            metadata, payload = _metadata(path), path.read_bytes()
            digest = 'sha256:' + hashlib.sha256(payload).hexdigest()
            if digest != metadata['digest']:
                raise RuntimeError('generated media changed during metadata inspection')
            key = 'film-media-' + hashlib.sha256((project + ':' + digest).encode()).hexdigest()
            response = transport.import_project_media(project, payload, media_type=metadata['media_type'],
                filename=metadata['filename'], expected_digest=digest, idempotency_key=key,
                **{k: metadata[k] for k in ('width', 'height', 'duration_seconds') if k in metadata})
            imported = data(response)
            receipt = response.get('receipt', {})
            if (imported.get('status') != 'completed' or imported.get('asset_id') != digest
                    or not imported.get('generation_id') or not imported.get('variant_id')
                    or not receipt.get('receipt_id')):
                raise RuntimeError('generated media import was not accepted')
            selectors = {'asset': imported['variant_id'], 'generation_id': imported['generation_id'],
                         'variant_id': imported['variant_id']}
            selected = data(transport.get_project_media_selection(project, selectors))
            if (set(selected) != {'asset', 'generation_id', 'variant_id', 'object_id', 'catalog_digest'}
                    or selected['object_id'] != digest or selected['generation_id'] != imported['generation_id']
                    or selected['variant_id'] != imported['variant_id']):
                raise RuntimeError('selected media differs from accepted import')
            verified = data(transport.get_project_verified_media(project, selected))
            if verified.get('selection') != selected:
                raise RuntimeError('verified media selection mismatch')
            required = ('width', 'height') if kind == 'image' else (('width', 'height', 'duration_seconds') if kind == 'video' else ('duration_seconds',))
            for field in required:
                if not isinstance(verified.get(field), (int, float)) or isinstance(verified[field], bool) or verified[field] <= 0 or verified[field] != metadata.get(field):
                    raise RuntimeError(f'Runtime did not verify {kind} {field}')
            selected['metadata'] = {field: verified[field] for field in required}
            pins[kind].append(selected)
            imports.append({'kind': kind, 'selection': selected, 'receipt_id': receipt['receipt_id']})
    shape = cfg['shape']
    max_hold = max(child['hold'] for shot in shape['shots'] for child in shot['children'])
    if shape.get('contentExtent'):
        max_hold = max(max_hold, shape['shots'][1]['duration'])
    if min(p['metadata']['duration_seconds'] for p in pins['video']) < max_hold or pins['audio'][0]['metadata']['duration_seconds'] < shape['shots'][1 if shape.get('ripple') else 0]['duration']:
        raise RuntimeError('generated sources are too short for fixture clips')
    words = [[0.01, 0.04, 'repeat'], [0.05, 0.08, 'repeat'], [0.1, 0.2, 'w0001'], [1.1, 1.2, 'w0002']]
    targets_words = [words[2], words[3], words[0], words[1]]
    # The production fixture ends narration at the last target word. Generic
    # shapes keep their longer narration, so extend its transcript to match.
    if not shape.get('narrationTranscriptEnd'):
        end = int(shape['shots'][1 if shape.get('ripple') else 0]['duration'] * 30) / 30 - 1 / 30
        if end > words[-1][1]:
            words.append([end - 0.1, end, 'ending'])
    content = build_transcript(pins['audio'][0]['object_id'], 'film-line', ' '.join(w[2] for w in words), words)
    document_id = transcript_document_id(project, content['media_id'], content['source_id'])
    pack_path = cfg.get('collection_pack_path')
    if pack_path:
        from film_packs import collection_reference
        collection_element = collection_reference(pack_path)
    else:
        collection_element = None
    omit_ambiguous = cfg.get('omit_ambiguous_anchors', False)
    spec = {'collectionElement': collection_element, 'projectId': project, 'timelineId': timeline, 'shape': shape, 'selections': pins['video'],
            'omitAmbiguousAnchors': omit_ambiguous,
            'legacyWord': {'documentId': document_id, 'text': 'w0001', 'at': 0.1, 'content': content},
            'mediaSize': {'width': pins['video'][0]['metadata']['width'], 'height': pins['video'][0]['metadata']['height']},
            'narration': {'selection': pins['audio'][0], 'image': pins['image'][0],
                          **({'overlayImage': pins['image'][1]} if len(pins['image']) > 1 else {}),
                          'words': [{'text': w[2], 'at': w[0]} for w in targets_words],
                          'splitAt': {'gapStart': 0.2, 'gapEnd': 0.7},
                          **({'end': words[-1][1]} if shape.get('narrationTranscriptEnd') else {})}}
    js = ("const {prepareFilmImport,planFilmImport}=await import(process.argv[1]);let s='';for await(const x of process.stdin)s+=x;"
          "const p=prepareFilmImport(JSON.parse(s));console.log(JSON.stringify({prepared:p,plan:planFilmImport(p)}));")
    planned = json.loads(subprocess.run([cfg['node'], '--input-type=module', '-e', js, cfg['film_import_module']],
        input=json.dumps(spec), text=True, capture_output=True, check=True).stdout)
    prepared, plan = planned['prepared'], planned['plan']
    imported = transport.import_timeline(project, {**prepared, 'source': {'via': 'script'}}, idempotency_key='film-import-' + timeline)
    imported_data = data(imported)
    if imported_data.get('timeline_id') != timeline or not imported.get('receipt', {}).get('receipt_id'):
        raise RuntimeError('Runtime did not receipt the prepared timeline import')
    opened = data(transport.get_project_timeline_verified_head(project, timeline))
    head, document = opened['head'], opened['canonical_document']
    if opened.get('project_id') != project or opened.get('timeline_id') != timeline or head.get('revision_id') != prepared['publication']['parent_revision_id']:
        raise RuntimeError('imported timeline head mismatch')
    bundle = bundle_from_document(document)
    # Import installed the generated transcript. Re-read and verify its pin.
    transcript = data(transport.get_document(project, document_id))
    pin = {'document_id': document_id, 'version': transcript['version'], 'content_digest': _digest(content)}
    capture = read_verified_transcript(transport, project, pin)
    bundle.setdefault('source_mapping', {})['pinned_documents'] = [capture]
    narration_index = 1 if shape.get('ripple') else 0
    choice = {'source': f'occurrence:{timeline}-occ-{narration_index}/clip:narration', 'document': pin,
              'word_ids': [content['segments'][0]['words'][2]['id']]}
    anchor = capture_anchor(bundle, 'parent/clip:element-built-in', 'on', '"w0001"', choice)
    anchor['intent'] = {'anchor': 'follow'}
    result = transport.commit_timeline(project, timeline, {'api_version': 1, 'project_id': project,
        'timeline_id': timeline, 'base_revision_id': head['revision_id'], 'base_publication_id': head['publication_id'],
        'commands': [anchor]}, idempotency_key='film-anchor-' + timeline)
    accepted = data(result)
    revision = accepted.get('accepted_revision_id')
    if not revision or not result.get('receipt', {}).get('receipt_id'):
        raise RuntimeError('anchor commit did not return an accepted receipt')
    reopened = data(transport.get_project_timeline_verified_head(project, timeline))
    closure = reopened['canonical_document']
    if reopened['head']['revision_id'] != revision or pin not in closure['dependency_manifest']['documents']:
        raise RuntimeError('accepted head did not retain the transcript pin')
    packs = None
    if collection_element:
        from film_packs import place_project
        realm = client.documents._identity()['realm_id']
        revision, project_pack = place_project(client, realm, project, timeline, revision)
        reopened = data(transport.get_project_timeline_verified_head(project, timeline))
        closure = reopened['canonical_document']
        if reopened['head']['revision_id'] != revision or pin not in closure['dependency_manifest']['documents']:
            raise RuntimeError('pack placement head or transcript pin mismatch')
        document_pins = closure['dependency_manifest']['documents']
        if not any(row.get('document_id') == project_pack['document_id'] and
                   row.get('version') == project_pack['document_version'] and row.get('content_digest')
                   for row in document_pins):
            raise RuntimeError('project pack admission pin missing from accepted manifest')
        packs = {'project': project_pack, 'collection': {'element': collection_element}}
    saved = bundle_from_document(closure)
    if packs:
        rows = {row['id']: row for row in saved['parent']['clips']}
        for label in ('project', 'collection'):
            row = rows[f'element-{label}-pack']
            if row.get('elementRef') != packs[label]['element']:
                raise RuntimeError(f'{label} element reference was not retained')
    parent_clip = next(row for row in saved['parent']['clips'] if row['id'] == 'element-built-in')
    if parent_clip['app']['astrid']['word_anchors']['on']['document'] != pin:
        raise RuntimeError('accepted parent anchor did not retain the transcript pin')
    saved.setdefault('source_mapping', {})['pinned_documents'] = [capture]
    retime = ShotWordRetimeInputs(saved)
    shot = saved['shots'][f'{timeline}-shot-{narration_index:04d}']['internal_timeline']
    targets = []
    if omit_ambiguous:
        omitted_index = 0 if shape.get('ripple') else narration_index
        omitted_shot = saved['shots'][f'{timeline}-shot-{omitted_index:04d}']['internal_timeline']
        for i in (2, 3):
            child = next(row for row in omitted_shot['clips'] if row['id'] == f'footage-{omitted_index}-{i}')
            if 'on' in child.get('app', {}).get('astrid', {}):
                raise RuntimeError('ambiguous word declaration was not omitted')
    for i, word in enumerate(targets_words[:2] if omit_ambiguous else targets_words):
        target_index = 0 if shape.get('ripple') and i >= 2 else narration_index
        target_shot = saved['shots'][f'{timeline}-shot-{target_index:04d}']['internal_timeline']
        child = next(row for row in target_shot['clips'] if row['id'] == f'footage-{target_index}-{i}')
        selector = (f'{timeline}-occ-{target_index}', f'{timeline}-shot-{target_index:04d}', child['id'])
        source = (f'{timeline}-occ-{narration_index}', f'{timeline}-shot-{narration_index:04d}',
                  'narration-later' if i == 1 else 'narration')
        status = prove_target(retime, selector, child, word[2], document_id, source,
                              content['segments'][0]['words'][i + 2 if i < 2 else i - 2]['id'], i >= 2)
        targets.append({'selector': list(selector), 'kind': 'image' if i == 0 else 'video', 'word': word[2], 'status': status})
    child_count = sum(len(s['internal_timeline']['clips']) for s in saved['shots'].values())
    parent_count = len(saved['parent']['clips'])
    if 'clip_target' in cfg and child_count + parent_count != cfg['clip_target']:
        raise RuntimeError('accepted fixture clip count differs from requested count')
    for i in range(2):
        original = next(row for row in shot['clips'] if row['id'] == f'footage-{narration_index}-{i}')
        overlay = next(row for row in saved['parent']['clips'] if row['id'] == f'overlay-{i}')
        if overlay['at'] != shape['shots'][narration_index]['on'] + original['at'] or overlay['hold'] != original['hold']:
            raise RuntimeError('accepted overlay does not cover its original')
        if len(pins['image']) > 1 and len(pins['video']) > 1:
            original_asset = shot['registry']['assets'][original['asset']]
            overlay_asset = saved['parent']['registry']['assets'][overlay['asset']]
            kind = 'image' if i == 0 else 'video'
            if (original_asset['type'] != kind or overlay_asset['type'] != kind
                    or original_asset['media_id'] == overlay_asset['media_id']):
                raise RuntimeError('accepted overlay is not a distinct same-kind media swap')
            for asset in (original_asset, overlay_asset):
                media_pin = next((p for p in pins[kind] if p['object_id'] == asset['media_id']), None)
                if (not media_pin or asset.get('generationId') != media_pin['generation_id']
                        or asset.get('variantId') != media_pin['variant_id']
                        or asset.get('resolution') != f"{media_pin['metadata']['width']}x{media_pin['metadata']['height']}"
                        or (kind == 'video' and asset.get('duration') != media_pin['metadata']['duration_seconds'])):
                    raise RuntimeError('accepted overlay media identity or metadata differs from import')
    readback = readback_extents(saved)
    verify_readback(plan, {'shots': len(saved['placements']), 'child_clips': child_count, 'parent_clips': parent_count, **readback})
    last = saved['placements'][0 if shape.get('ripple') else -1]
    last_shot = saved['shots'][last['shot_id']]['internal_timeline']
    if not any(row['at'] + row['hold'] > last['duration_ms'] / 1000 for row in last_shot['clips']):
        raise RuntimeError('accepted fixture lacks the historical overrun')
    return {'project_id': project, 'timeline_id': timeline, 'accepted_head': reopened['head'],
            'import_receipt_id': imported['receipt']['receipt_id'], 'anchor_receipt_id': result['receipt']['receipt_id'],
            'media': imports, 'transcript_pin': pin, 'targets': targets,
            **({'omitted_ambiguous_anchors': 2} if omit_ambiguous else {}),
            'ripple_cut': {'start_seconds': shape['shots'][narration_index]['on'] + 0.2, 'end_seconds': shape['shots'][narration_index]['on'] + 0.7,
                           'later_narration_selector': f'occurrence:{timeline}-occ-{narration_index}/clip:narration-later'},
            'measurements': {'shots': len(saved['placements']), 'child_clips': child_count,
                             'parent_clips': parent_count,
                             # duration_seconds is the occurrence extent (about 195.967 s for the default
                             # build), not a 196 s film: the default build's shot-2 children are short.
                             'duration_seconds': readback['occurrence_extent_seconds'],
                             'content_extent_seconds': readback['content_extent_seconds'],
                             'occurrence_extent_seconds': readback['occurrence_extent_seconds']},
            'packs': packs or 'pending: fixture pack elements are not admitted', 'render_verified': False}


def main():
    with open(os.environ['SAVE_LOOP_CONFIG_PATH'], encoding='utf-8') as stream:
        cfg = json.load(stream)
    with AstridClient.open_existing_from_launcher() as client:
        measurement = build(cfg, client)
    Path(os.environ['SAVE_LOOP_MEASUREMENT_PATH']).write_text(json.dumps(measurement, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
