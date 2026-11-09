"""Process-edge driver: real M1 installer, pinned builder and Runtime daemon.

All executable/source/site roots arrive as explicit argv from the test launcher.
No ambient PYTHONPATH, installer journey, provider or GPU is involved.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import urllib.request

root, agent, runtime, site, node, esbuild, lock_file = map(Path, sys.argv[1:])
sys.path[:0] = [str(runtime), str(runtime / 'packages/python'), str(agent), str(site)]
from astrid.core.pack.transaction import collection_write_custody, install_group, read_group, PackInstallError
from runtime_protocol.daemon import RuntimeDaemon
from runtime_protocol.store import RealmStore


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


shared = json.loads(lock_file.read_text())['shared_modules']
toolchain = {
    'node_path': str(node), 'node_version': subprocess.check_output([str(node), '--version'], text=True).strip()[1:],
    'node_sha256': sha(node), 'esbuild_path': str(esbuild), 'esbuild_version': '0.27.7',
    'esbuild_sha256': sha(esbuild), 'lock_sha256': sha(lock_file), 'shared_modules': shared,
}
source = root / 'source'
source.mkdir()
pack = source / 'native_effect'
pack.mkdir()
(pack / 'pack.yaml').write_text('schema_version: 3\nid: native_effect\nname: Native Effect\nversion: 1.0.0\npack_api: "2.3"\ndocumentation: {kind: none, reason: Live browser proof.}\n')
installed = root / 'installed'
realm = root / 'realm'
RealmStore.initialize(realm).close()
daemon = RuntimeDaemon(realm, support_root=root / 'support', installed_pack_root=installed).start()


def refresh(**notification):
    request = urllib.request.Request(daemon.endpoint + '/api/runtime/packs/inventory',
        headers={'Authorization': 'Bearer ' + daemon.token})
    with urllib.request.urlopen(request, timeout=10) as response:
        inventory = json.load(response)
    return {'version': 1, 'accepted': inventory['revision'] == notification['committed_revision'],
            'revision': inventory['revision'], 'reason': ''}


def install(mode):
    version = 'v1' if mode == 'install' else mode
    manifest = {'id': 'com.test.installed-effect', 'version': '1.0.0', 'apiVersion': 2 if mode == 'badApi' else 1,
                'label': 'Installed effect', 'publisher': 'Test Publisher', 'license': 'MIT',
                'settingsSchema': {'version': 1}, 'contributions': [
                    {'id': 'effect', 'kind': 'effect', 'effectId': 'installed-effect'},
                    {'id': 'ping', 'kind': 'command', 'command': 'com.test.installed-effect.ping', 'label': 'Ping'}]}
    exported = {**manifest, 'id': 'com.test.wrong-id'} if mode == 'badIdentity' else manifest
    (pack / 'late.ts').write_text('export const label=' + json.dumps('late-' + version) + ';')
    entry = '''import React from 'react';
import {defineExtension} from '@astrid/editor-sdk';
export default defineExtension({manifest:MANIFEST,activate(ctx){
  ctx.effects.registerComponent('installed-effect',({children})=>React.createElement('div',{
    'data-testid':'installed-effect','data-revision':VERSION,
    style:{position:'absolute',inset:0,background:'rgb(25, 95, 175)'}},'built-'+VERSION,children));
  ctx.commands.registerCommand('com.test.installed-effect.ping',()=>{window.pings=(window.pings||0)+1});
  FAILURE
  window.loadInstalledLazy=()=>import('./late.ts').then(m=>m.label);
}});
'''.replace('MANIFEST', json.dumps(exported)).replace('VERSION', json.dumps(version)).replace(
    'FAILURE', "throw new Error('real activation failed');" if mode == 'activateFail' else '')
    (pack / 'entry.tsx').write_text('export default <broken' if mode == 'compileFail' else entry)
    before = read_group(installed)
    try:
        result = install_group(source=source, packs={'native_effect': 'native_effect'}, packs_root=installed,
            python_packages={}, builds={'native_effect': {'entry': 'entry.tsx', 'extension_manifest': manifest}},
            toolchain=toolchain, refresh=refresh)
    except PackInstallError as exc:
        assert mode == 'compileFail', str(exc)
        after = read_group(installed)
        assert before.admissions == after.admissions and before.revision == after.revision
        return {'failedBuild': True, 'revision': after.revision}
    snapshot = read_group(installed)
    assert not snapshot.refresh_pending
    return {'revision': snapshot.revision, 'admission': snapshot.admissions['native_effect']}


print(json.dumps({'endpoint': daemon.endpoint, 'token': daemon.token}), flush=True)
try:
    for line in sys.stdin:
        try:
            command = json.loads(line)['command']
            if command == 'uninstall':
                install_group(source=source, packs={}, remove=('native_effect',), packs_root=installed, python_packages={})
                result = {'uninstalled': True}
            elif command == 'leases':
                result = len(daemon.service._pack_leases)
            elif command == 'hash':
                snapshot = read_group(installed)
                record = snapshot.admissions['native_effect']
                path = snapshot.paths['native_effect'] / f".build/{record['sourceDigest']}.js"
                # A direct write into the installed collection takes the collection custody every
                # non-transaction writer must hold (LB-TXN r2 PK-14 precondition).
                with collection_write_custody(installed):
                    path.write_bytes(path.read_bytes() + b'// tampered')
                result = {'tampered': True}
            else:
                result = install(command)
            print(json.dumps({'ok': True, 'result': result}), flush=True)
        except Exception as exc:
            print(json.dumps({'ok': False, 'error': type(exc).__name__ + ': ' + str(exc)}), flush=True)
finally:
    daemon.stop()
