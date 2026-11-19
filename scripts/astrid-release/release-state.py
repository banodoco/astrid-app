"""Read-only release layout checks and explicit first-install ownership, stdlib only."""
import json
import os
from pathlib import Path
import sys
import tempfile


def within(path, root):
    return os.path.commonpath((str(path), str(root))) == str(root)


def layout(root, record):
    root = Path(root).resolve()
    if root == Path('/') or root == Path.home().resolve():
        raise ValueError('Unsafe release root')
    live = None
    if Path(record).exists():
        value = json.loads(Path(record).read_text()).get('data_root')
        if not isinstance(value, str) or not value or not Path(value).is_absolute():
            raise ValueError('Live install has no absolute data_root')
        live = Path(value).resolve()
    paths = [root] + [root / name for name in ('state', 'logs', 'editor', 'program', 'data', 'home', 'tmp', 'data.pre-realm')]
    for path in paths:
        canonical = path.resolve()
        if live is not None and (within(canonical, live) or within(live, canonical)):
            raise ValueError('Configured live data and release paths overlap: ' + str(path))
        if canonical != path:
            raise ValueError('Release destination is redirected outside its own path: ' + str(path))
    return root, live


def ownership(root, branch):
    return {'version': 1, 'branch': branch, 'program_root': str(root / 'program'), 'data_root': str(root / 'data')}


def disposable(root, branch):
    if os.path.lexists(root / 'state/realm-id'):
        raise ValueError('A realm copy exists (state/realm-id); refusing to delete program/ or data/')
    marker = root / 'state/first-install.json'
    if marker.exists():
        if marker.is_symlink() or json.loads(marker.read_text()) != ownership(root, branch):
            raise ValueError('Invalid first-install ownership record; keeping program/ and data/')
        return
    for name in ('program', 'data'):
        path = root / name
        if os.path.lexists(path) and (not path.is_dir() or any(path.iterdir())):
            raise ValueError('Unexplained existing program/ or data/ is not an identified interrupted first install; keeping both')


def main():
    command, root_arg, record, *rest = sys.argv[1:]
    root, live = layout(root_arg, record)
    if command == 'layout':
        print(live or '')
    elif command in ('disposable', 'begin'):
        branch, = rest
        disposable(root, branch)
        if command == 'begin':
            marker = root / 'state/first-install.json'
            fd, temporary = tempfile.mkstemp(prefix='.first-install-', dir=str(marker.parent))
            try:
                with os.fdopen(fd, 'w') as handle:
                    json.dump(ownership(root, branch), handle, sort_keys=True)
                    handle.write('\n')
                os.replace(temporary, marker)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
    elif command == 'scratch':
        # Resolve TMPDIR before mkdir: a create-and-remove inside ROOT changes its metadata.
        for candidate in (os.environ.get('TMPDIR'), '/tmp', '/var/tmp'):
            if not candidate:
                continue
            parent = Path(candidate).resolve()
            if within(parent, root) or (live is not None and within(parent, live)):
                continue
            if not parent.is_dir():
                continue
            try:
                print(tempfile.mkdtemp(prefix='astrid-release-preflight.', dir=str(parent)))
                return
            except OSError:
                continue
        raise ValueError('No writable external temporary parent outside release and live data roots')
    else:
        raise ValueError('Unknown release state operation')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, TypeError, KeyError) as error:
        sys.exit(str(error))
