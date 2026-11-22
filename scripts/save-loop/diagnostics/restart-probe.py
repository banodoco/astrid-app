#!/usr/bin/env python3
"""Keep small durable samples while one owned measurement stack is setting up."""
from datetime import datetime, timezone
from pathlib import Path
import json
import os
import re
import subprocess
import sys
import time

if len(sys.argv) != 6:
    raise SystemExit('usage: restart-probe.py ABSOLUTE_OWNED_SANDBOX_BASE STACK STEPS OUTPUT PID|once')
base, stack, steps, output = (Path(value) for value in sys.argv[1:5])
pid = sys.argv[5]
assert pid == 'once' or re.fullmatch(r'[0-9]+', pid)
assert base.is_absolute() and base.resolve() == base
assert stack.is_absolute() and stack.resolve() == stack and stack.name == 'stack'
assert stack.is_relative_to(base) and stack != base
marker = stack / '.sl1-stack-owned'
cgroup_root = Path('/sys/fs/cgroup')
cgroup = cgroup_root / 'unified'
memory_files = ('memory.current', 'memory.peak', 'memory.events')
for row in Path('/proc/self/cgroup').read_text().splitlines():
    _, controllers, group = row.split(':', 2)
    if 'memory' in controllers.split(','):
        cgroup = cgroup_root / 'memory' / group.lstrip('/')
        memory_files = ('memory.usage_in_bytes', 'memory.max_usage_in_bytes', 'memory.oom_control')
        break
    if not controllers and (cgroup / group.lstrip('/') / 'memory.current').is_file():
        cgroup = cgroup / group.lstrip('/')


def value(path):
    try:
        return path.read_text().strip()
    except OSError:
        return None


def collect(command):
    try:
        result = subprocess.run(command, text=True, capture_output=True, timeout=7, check=False)
        return ' '.join(result.stdout.split()) if result.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def disk_size(path):
    return collect(['du', '-sh', '--', str(path)]) if path.exists() else 'absent'


def sample():
    marker_value = value(marker)
    if marker_value is not None:
        assert marker_value == f'astrid-app-sl1-stack-v1 {stack}'
    profiles = list(stack.glob('p77-dispatch-chrome-*'))
    temp_paths = [stack / 'tmp', *Path('/tmp').glob('sl-p77-browser-*')]
    current, peak, events_file = memory_files
    events = value(cgroup / events_file) or ''
    row = {'utc': datetime.now(timezone.utc).isoformat(), 'stack': str(stack),
           'free_m': collect(['free', '-m']), 'load_1m': value(Path('/proc/loadavg')).split()[0],
           'memory_current': value(cgroup / current), 'memory_peak': value(cgroup / peak),
           'memory_limit': value(cgroup / 'memory.limit_in_bytes') or value(cgroup / 'memory.max'),
           'memory_failcnt': value(cgroup / 'memory.failcnt'),
           'memory_events': dict(line.split() for line in events.splitlines()),
           'stack_disk': disk_size(stack) if marker_value else 'awaiting_owned_root',
           'temp_disk': {str(path): disk_size(path) for path in temp_paths} if marker_value else {},
           'profile_disk': {str(path): disk_size(path) for path in profiles},
           'process_count': sum(path.name.isdigit() for path in Path('/proc').iterdir())}
    with output.open('a', encoding='utf-8') as log:
        log.write(json.dumps(row, sort_keys=True)+'\n')
        log.flush()
        os.fsync(log.fileno())


if pid == 'once':
    sample()
else:
    while Path(f'/proc/{pid}').exists():
        if 'Starting browser observation' in (value(steps) or ''):
            break
        start = time.monotonic()
        sample()
        time.sleep(max(0, 30-(time.monotonic()-start)))
