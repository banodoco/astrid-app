"""Stopped-owner checks and snapshot publication under Runtime's bootstrap mutex.

The external workspace attach command acquires this mutex itself, so publication
leaves the catalog absent and releases the lock before that command is invoked.
"""
from contextlib import contextmanager, ExitStack
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_optional(path):
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return None


def validate_destination(dest):
    for suffix in ('runtime', 'runtime/realms', 'runtime/catalog.json', 'runtime/catalog.json.pre-realm-snapshot', 'runtime/bootstrap.lock', 'runtime/instance.lock', 'runtime/discovery.json'):
        path = dest / suffix
        if path.resolve() != path:
            raise ValueError('destination support path is redirected: ' + str(path))


def lock_fd(path, stack, message):
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    stack.callback(os.close, fd)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        raise ValueError(message) from error
    held, current = os.fstat(fd), os.stat(path, follow_symlinks=False)
    if (held.st_dev, held.st_ino) != (current.st_dev, current.st_ino):
        raise ValueError('destination ownership path changed during inspection')


@contextmanager
def stopped(dest):
    """Read both advertisements, hold admission/owner locks, and recheck records."""
    validate_destination(dest)
    runtime = dest / 'runtime'
    ads = {runtime / name: read_optional(runtime / name) for name in ('instance.lock', 'discovery.json')}
    roots = {path for path in (runtime / 'realms').iterdir() if path.is_dir()}
    catalog = read_optional(runtime / 'catalog.json')
    if catalog is not None:
        for realm in json.loads(catalog).get('realms', []):
            roots.add(Path(realm['data_root']))
    for path, raw in ads.items():
        if raw is None:
            continue
        record = json.loads(raw)
        pid = record.get('pid')
        if type(pid) is not int or pid <= 0:
            raise ValueError('destination advertisement has no valid pid: ' + path.name)
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            pass
        except (OSError, OverflowError) as error:
            raise ValueError('cannot prove destination advertisement pid is dead: ' + path.name) from error
        else:
            raise ValueError('destination ' + path.name + ' pid ' + str(pid) + ' is still alive')
        if record.get('realm_root'):
            roots.add(Path(record['realm_root']))
    if any(not root.is_absolute() for root in roots):
        raise ValueError('destination realm ownership path is not absolute')
    with ExitStack() as locks:
        for root in sorted({path.resolve() for path in roots}):
            if not root.exists():
                continue
            lock_fd(root, locks, 'destination realm admission lock held; stop it first')
            owner = root / 'owner.lock'
            if os.path.lexists(owner):
                lock_fd(owner, locks, 'destination realm owner lock held; stop it first')
        if any(read_optional(path) != raw for path, raw in ads.items()):
            raise ValueError('destination owner advertisement changed during inspection')
        if read_optional(runtime / 'catalog.json') != catalog:
            raise ValueError('destination catalog changed during inspection')
        yield ads, catalog


@contextmanager
def bootstrap_mutex(dest):
    # Same path and flock primitive as astrid_runtime.bootstrap._bootstrap_mutex.
    validate_destination(dest)
    path = dest / 'runtime/bootstrap.lock'
    fd = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(fd, 'a+') as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise ValueError('destination bootstrap lock held; another launcher owns the handoff') from error
        try:
            held, current = os.fstat(handle.fileno()), os.stat(path, follow_symlinks=False)
            if (held.st_dev, held.st_ino) != (current.st_dev, current.st_ino):
                raise ValueError('destination bootstrap lock changed during inspection')
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def write_catalog(path, value):
    fd, temporary = tempfile.mkstemp(prefix='.catalog-', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'w') as handle:
            json.dump(value, handle, indent=2, sort_keys=True)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    command, destination, *args = sys.argv[1:]
    dest = Path(destination).resolve()
    catalog = dest / 'runtime/catalog.json'
    backup = dest / 'runtime/catalog.json.pre-realm-snapshot'
    if command == 'check':
        # Early refusal remains read-only; the publication check is serialized below.
        with stopped(dest) as (_, before):
            if before is None:
                raise ValueError('destination catalog is missing')
            print(digest(before))
        return
    with bootstrap_mutex(dest), stopped(dest) as (ads, before):
        if command == 'publish':
            stage_arg, final_arg, expected_catalog, mode, rid, name = args
            stage, final = Path(stage_arg), Path(final_arg)
            realms = dest / 'runtime/realms'
            if any(path.parent != realms or path.resolve() != path for path in (stage, final)):
                raise ValueError('snapshot publication path is outside the destination realms')
            if before is None or digest(before) != expected_catalog:
                raise ValueError('destination catalog changed while the copy was prepared')
            if final.exists():
                raise ValueError('destination already has realm; refusing to overwrite')
            if mode not in ('attach', 'legacy'):
                raise ValueError('unknown publication mode')
            original = json.loads(before)
            if mode == 'legacy' and (original.get('version') != 1 or len(original.get('realms', [])) != 1):
                raise ValueError('unexpected destination catalog shape; refusing to edit')
            shutil.copy2(catalog, backup)
            os.rename(stage, final)
            # Normal launchers hold bootstrap.lock; direct realm owners are fenced
            # by the admission/owner locks, retained through this destructive handoff.
            if any(read_optional(path) != raw for path, raw in ads.items()):
                raise ValueError('destination owner advertisement changed before removal')
            if mode == 'attach':
                catalog.unlink()
            elif mode == 'legacy':
                old = original['realms'][0]
                original['selected_realm_id'] = rid
                original['realms'] = [{'realm_id': rid, 'display_name': old.get('display_name') or name,
                    'data_root': str(final), 'selection_source': 'attach', 'source_profile': old.get('source_profile', 'astrid')}]
                write_catalog(catalog, original)
            for path, raw in ads.items():
                if raw is not None:
                    path.unlink()
        elif command == 'rollback':
            rid, final_arg = args
            if any(raw is not None for raw in ads.values()):
                raise ValueError('owner advertisements changed after handoff; catalog not restored')
            if before is not None:
                selected = json.loads(before)
                realms = selected.get('realms', [])
                if selected.get('selected_realm_id') != rid or len(realms) != 1 or realms[0].get('data_root') != final_arg:
                    raise ValueError('another workspace selection appeared; catalog not restored')
            shutil.copy2(backup, catalog)
        else:
            raise ValueError('unknown handoff operation')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, TypeError, KeyError) as error:
        sys.exit(str(error))
