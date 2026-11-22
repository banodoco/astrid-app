#!/usr/bin/env python3
"""Rank decodable weighted records while retaining acquisition and decode loss separately."""

from collections import Counter
from hashlib import sha256
import json
from pathlib import Path
import re
import sys

record = Path(sys.argv[1]).resolve(strict=True)
profile = json.loads(record.read_text())["runtime_profile"]
raw = Path(profile["raw"]).resolve(strict=True)
if raw != record.with_name(record.name + ".py-spy.raw"):
    raise ValueError("Profile trace does not belong to the opening record")

leaf = Counter()
inclusive = Counter()
raw_hash = sha256()
valid_samples = 0
rejected_samples_with_count = 0
rejected_records = Counter()
normal_frame = re.compile(r":\d+\)$")
bad_controls = re.compile(r"[\x00-\x1f\x7f]")

with raw.open("rb") as stream:
    for row in stream:
        raw_hash.update(row)
        try:
            trace, weight = row.rstrip(b"\n").rsplit(b" ", 1)
            if not weight.isdigit() or not trace:
                raise ValueError("missing weighted stack")
            weight = int(weight)
        except ValueError:
            rejected_records["missing_weight"] += 1
            continue
        try:
            stack = trace.decode("utf-8")
        except UnicodeDecodeError:
            rejected_records["invalid_encoding"] += 1
            rejected_samples_with_count += weight
            continue
        if bad_controls.search(stack) or not stack.rstrip().endswith(")"):
            rejected_records["malformed_stack"] += 1
            rejected_samples_with_count += weight
            continue
        frames = [normal_frame.sub(")", frame) for frame in stack.split(";")]
        valid_samples += weight
        leaf[frames[-1]] += weight
        inclusive.update({frame: weight for frame in set(frames)})

if valid_samples <= 0:
    raise ValueError("Raw profile has no decodable samples")


def ranked(counter):
    return [
        {"frame": frame, "samples": count, "percent_of_decodable_samples": round(100 * count / valid_samples, 2)}
        for frame, count in counter.most_common(25)
    ]


print(json.dumps({
    "sampler_reported_samples": profile["samples"],
    "sampler_reported_errors": profile["errors"],
    "rate_hz": profile["rate_hz"],
    "nonblocking": profile["nonblocking"],
    "raw_size_bytes": raw.stat().st_size,
    "raw_sha256": raw_hash.hexdigest(),
    "decodable_weighted_samples": valid_samples,
    "rejected_weighted_samples_with_recoverable_counts": rejected_samples_with_count,
    "rejected_stack_records": dict(rejected_records),
    "weighted_sample_count_gap": profile["samples"] - valid_samples - rejected_samples_with_count,
    "top_leaf_frames": ranked(leaf),
    "top_inclusive_frames": ranked(inclusive),
}, indent=2))
