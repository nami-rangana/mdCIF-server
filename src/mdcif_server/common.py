"""Helpers shared by the server and the worker process (standard library only).

The worker imports this module before it has set its thread counts, so nothing here may
import numpy, MDAnalysis, mdcif or matplotlib.
"""

import contextlib
import json
import os
import re
import secrets
import threading
import time
from datetime import UTC, datetime
from pathlib import Path

STAGES = [("prepare", "Prepare inputs"),
          ("load", "Read trajectory + global PCA"),
          ("cluster", "Cluster frames"),
          ("write", "Write mdcif file"),
          ("validate", "Validate"),
          ("report", "Info + landscape")]
STAGE_NAMES = [name for name, _ in STAGES]
TERMINAL = ("succeeded", "failed", "cancelled")
ACTIVE = ("queued", "running")

UPLOAD_ID_RE = re.compile(r"[0-9a-f]{32}")
JOB_ID_RE = re.compile(r"\d{8}-\d{6}-[0-9a-f]{6}")
PDB_ID_RE = re.compile(r"[0-9][A-Za-z0-9]{3}")      # = mdcif.reference.PDB_ID
TIME_FORMAT = "%Y-%m-%dT%H:%M:%SZ"


def iso_utc(t=None):
    """ISO 8601 UTC timestamp with second precision and a Z (now if ``t`` is None)."""
    return datetime.fromtimestamp(time.time() if t is None else t, UTC).strftime(TIME_FORMAT)


def parse_iso(text):
    """Seconds since the epoch of a timestamp written by :func:`iso_utc`."""
    return datetime.strptime(text, TIME_FORMAT).replace(tzinfo=UTC).timestamp()


def one_line(exc, limit=500):
    """``str(exc)`` on one line (whitespace runs collapsed), cut to ``limit`` characters."""
    text = " ".join(str(exc).split())[:limit]
    if not text and isinstance(exc, BaseException):
        text = type(exc).__name__
    return text


def atomic_write_bytes(path, data):
    """Write ``data`` to ``path`` through a temporary file in the same directory + os.replace."""
    path = Path(path)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}."
                         f"{secrets.token_hex(4)}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o666)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def atomic_write_text(path, text):
    atomic_write_bytes(path, text.encode("utf-8"))


def atomic_write_json(path, obj):
    atomic_write_text(path, json.dumps(obj, indent=1, ensure_ascii=False) + "\n")


def read_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)
