#!/usr/bin/env python3
"""Build an unpublished M4-5 stand-in; flag installer preservation blockers."""
import hashlib
import json
import sys
from pathlib import Path

MARKER = "M4-5 RELEASE 2 INSTALLABLE STAND-IN — UPDATE LANDED"
ROOT = Path(__file__).resolve().parents[2]


def main():
    if len(sys.argv) != 3:
        raise ValueError("usage: rebuild-stand-in.py <release-1-manifest> <absolute-new-output>")
    source, output = map(Path, sys.argv[1:])
    if not output.is_absolute():
        raise ValueError("output must be absolute")
    parent = output.parent.resolve(strict=True)
    if parent == ROOT or ROOT in parent.parents:
        raise ValueError("output must be outside the App checkout")
    manifest = json.loads(source.read_bytes())
    if manifest.get("release") != 1 or "qualification_marker" in manifest:
        raise ValueError("expected an unmarked release-1 manifest")
    stand_in = dict(manifest, release=2, qualification_marker=MARKER)
    data = (json.dumps(stand_in, indent=2, sort_keys=True) + "\n").encode()
    with (parent / output.name).open("xb") as stream:
        stream.write(data)
    print(f"stand-in sha256: {hashlib.sha256(data).hexdigest()}")
    print("identity comparison: all fields match input except release and qualification_marker")
    if "vibecomfy" not in stand_in:
        raise ValueError("NEEDS: explicit vibecomfy pin; the Agent installer adds it and cannot preserve these bytes")
    print("explicit vibecomfy present; installer canonical JSON encoding reproduced")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TypeError) as error:
        print(f"stand-in preflight refused: {error}", file=sys.stderr)
        sys.exit(1)
