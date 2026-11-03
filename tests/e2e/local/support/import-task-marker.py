"""Import the actual task object through Timeline managed media and edit its detached checkout."""
import hashlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace

from astrid.sdk.client import AstridClient
from astrid.sdk.timeline.media_add import _selection
from astrid.sdk.timeline_media_replacement import _plain, _verified
from astrid.sdk.timeline_checkout import Checkout

project, timeline, clip, alias, object_id, output_dir = sys.argv[1:]
expected = 'sha256:c01080f0e3e4ee24ba20829cd21369e59aafd67ee006af6d75b8a3d7bbbc81e2'
assert object_id == expected, (object_id, expected)
with AstridClient.open_from_launcher(start_pack_host=False, client_name='three-products-marker') as client:
    raw = client.media.read_bytes(object_id)
    assert len(raw) == 158 and 'sha256:' + hashlib.sha256(raw).hexdigest() == object_id
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    marker = Path(output_dir) / 'task-marker.png'
    marker.write_bytes(raw)
    checkout = Checkout.draft(project, timeline, client=client)
    transport = client._remote._transport
    session = SimpleNamespace(client=client, project_id=checkout.bundle['project_id'])
    imported, _ = _selection(session, checkout.bundle, str(marker))
    assert imported['object_id'] == object_id
    selection = _plain(transport.get_project_media_selection(session.project_id, {
        'asset': alias, 'generation_id': imported['generation_id'], 'variant_id': imported['variant_id'],
    }))
    selection, verified = _verified(transport, session.project_id, selection)
    assert selection['object_id'] == object_id and verified['selection'] == selection
    checkout.clip(clip).swap_asset({'key': alias, 'media_id': object_id, 'content_sha256': object_id,
        'type': 'image/png', 'filename': 'marker.png', 'resolution': '64x48',
        'generationId': selection['generation_id'], 'variantId': selection['variant_id']})
    checkout.save(quiet=True)
    (Path(output_dir) / 'task-marker-selection.json').write_text(json.dumps(selection, indent=2) + '\n')
    print(json.dumps(selection))
