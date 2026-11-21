"""Keep failed-start evidence and classify only the current launch's output."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import sys


KNOWN_FAILURE = "accepted commit inputs changed during verification"


def mark(runtime_log: Path, cursor: Path) -> None:
    try:
        with runtime_log.open("rb") as stream:
            info = os.fstat(stream.fileno())
            boundary = max(0, info.st_size - 256)
            stream.seek(boundary)
            value = {"device": info.st_dev, "inode": info.st_ino, "offset": info.st_size,
                     "boundary": boundary,
                     "prefix_digest": hashlib.sha256(stream.read(info.st_size - boundary)).hexdigest()}
    except FileNotFoundError:
        value = None
    cursor.write_text(json.dumps(value) + "\n")


def current_runtime(runtime_log: Path, cursor: Path) -> bytes:
    before = json.loads(cursor.read_text())
    try:
        with runtime_log.open("rb") as stream:
            info = os.fstat(stream.fileno())
            offset = 0
            if (before is not None and info.st_dev == before["device"]
                    and info.st_ino == before["inode"] and info.st_size >= before["offset"]):
                # A truncated log can regrow past the old length without changing
                # inode. Check the old boundary before treating it as an append.
                stream.seek(before["boundary"])
                prefix = stream.read(before["offset"] - before["boundary"])
                if hashlib.sha256(prefix).hexdigest() == before["prefix_digest"]:
                    offset = before["offset"]
            stream.seek(offset)
            return stream.read()
    except FileNotFoundError:
        return b""


def retain(editor_log: Path, runtime_log: Path, cursor: Path, output: Path) -> None:
    # The launcher opens editor.log with wb for each attempt. Runtime appends to
    # its service log, so its bytes must be fenced by the pre-launch cursor.
    try:
        editor = editor_log.read_bytes()
    except FileNotFoundError:
        editor = b""
    runtime = current_runtime(runtime_log, cursor)
    sections = [("editor (current attempt)", editor), ("Runtime (current attempt)", runtime)]
    with output.open("w") as stream:
        for label, raw in sections:
            stream.write("--- " + label + " ---\n")
            stream.write("\n".join(raw.decode(errors="replace").splitlines()[-40:]) + "\n")
    lines = (editor + b"\n" + runtime).decode(errors="replace").splitlines()
    # Accept the exact exception message, optionally prefixed by the launcher's
    # or logger's context. Quoted source text and approximate matches do not count.
    lines = [re.sub(r"\x1b\[[0-9;]*m", "", line).strip() for line in lines]
    known = any(line == KNOWN_FAILURE or line.endswith(": " + KNOWN_FAILURE) for line in lines)
    print("known-verification-failure" if known else "unrelated-failure")


if __name__ == "__main__":
    operation, *arguments = sys.argv[1:]
    if operation == "mark" and len(arguments) == 2:
        mark(*map(Path, arguments))
    elif operation == "retain" and len(arguments) == 4:
        retain(*map(Path, arguments))
    else:
        raise SystemExit("usage: startup-log.py mark RUNTIME_LOG CURSOR | retain EDITOR_LOG RUNTIME_LOG CURSOR OUTPUT")
