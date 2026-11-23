"""Create and capture a generated transcript word for the film fixture.

The caller must submit the returned command and verify its accepted canonical
document. This helper does not claim a successful Runtime timeline edit.
"""
from __future__ import annotations

import copy


def create_word_anchor(client, project, bundle, *, media_id, source, target,
                       words, word_index, declaration, key):
    """Create a transcript and capture one parent clip's exact word choice.

    ``source`` is an occurrence clip selector and must refer to the same media
    as ``media_id``. ``words`` contains [start, end, text] in source seconds.
    The source clip must cover the selected word. The caller is responsible for
    staging and submitting the command against the same timeline head.
    """
    from astrid.sdk.media_transcript import build_transcript, transcript_document_id
    from astrid.sdk.timeline.native_source_inputs import read_verified_transcript
    from astrid.sdk.timeline.native_word_anchor import capture_anchor

    if not isinstance(word_index, int) or isinstance(word_index, bool) or not 0 <= word_index < len(words):
        raise ValueError('word_index must select one generated word')
    content = build_transcript(media_id, 'film-line', ' '.join(str(row[2]) for row in words), words)
    document_id = transcript_document_id(project, media_id, content['source_id'])
    created = client.documents.create(kind='media.transcript', content=content,
                                      project=project, document_id=document_id,
                                      idempotency_key=key)
    if not created.ok:
        raise RuntimeError(f'could not create generated transcript: {created.error}')
    document = created.data
    if not isinstance(document, dict) or document.get('document_id') != document_id:
        raise RuntimeError('Runtime did not return the generated transcript identity')
    pin = {name: document.get(name) for name in ('document_id', 'version', 'content_digest')}
    # Read through the verified Runtime route: it checks scope, version, digest,
    # transcript schema and source media instead of trusting local content.
    capture = read_verified_transcript(client._remote._transport, project, pin)
    captured_bundle = copy.deepcopy(bundle)
    captures = captured_bundle.setdefault('source_mapping', {}).setdefault('pinned_documents', [])
    captures[:] = [row for row in captures if row.get('pin') != pin]
    captures.append(capture)
    choice = {'source': source, 'document': pin,
              'word_ids': [content['segments'][0]['words'][word_index]['id']]}
    command = capture_anchor(captured_bundle, target, 'on', declaration, choice)
    command['intent'] = {'anchor': 'follow'}
    return command, capture
