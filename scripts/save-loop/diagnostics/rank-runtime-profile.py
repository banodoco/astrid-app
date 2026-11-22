#!/usr/bin/env python3
"""Summarize the active Python stacks from one owned compiled editor open."""

from collections import Counter
from hashlib import sha256
import json
from pathlib import Path
import re
import sys


profile_record = Path(sys.argv[1]).resolve(strict=True)
profile = json.loads(profile_record.read_text())["runtime_profile"]
raw = Path(profile["raw"]).resolve(strict=True)
if raw != profile_record.with_name(profile_record.name + ".py-spy.raw"):
    raise ValueError("Profile trace does not belong to the opening record")

encoded = raw.read_bytes()
self_samples = Counter()
inclusive_samples = Counter()
total = 0
for row in encoded.decode().splitlines():
    stack, count = row.rsplit(" ", 1)
    frames = [re.sub(r":\d+\)$", ")", frame) for frame in stack.split(";")]
    count = int(count)
    total += count
    self_samples[frames[-1]] += count
    inclusive_samples.update({frame: count for frame in set(frames)})

if total != profile["samples"] or total <= 0:
    raise ValueError("Raw profile samples differ from the profiler receipt")


def ranked(samples):
    return [
        {"frame": frame, "samples": count, "percent_of_active_stacks": round(100 * count / total, 2)}
        for frame, count in samples.most_common(25)
    ]


print(json.dumps({
    "samples": total,
    "errors": profile["errors"],
    "rate_hz": profile["rate_hz"],
    "nonblocking": profile["nonblocking"],
    "trace_sha256": sha256(encoded).hexdigest(),
    "top_leaf_frames": ranked(self_samples),
    "top_inclusive_frames": ranked(inclusive_samples),
}, indent=2))
