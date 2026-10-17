"""Server paths: one check for /api/files and for job inputs.

absolute and no NUL -> ``Path.resolve()`` (symlinks followed, ``..`` removed) -> inside an
allowed root (``is_relative_to`` on resolved paths; the roots are resolved at startup) ->
exists, right type, readable.
"""

import os
import stat
from pathlib import Path


class PathProblem(Exception):
    """``kind``: relative | nul | forbidden | not_found | not_dir | not_file | permission."""

    def __init__(self, kind, path):
        super().__init__(f"{kind}: {path}")
        self.kind = kind
        self.path = path


def resolve_in_roots(raw, roots):
    """The resolved ``Path`` of ``raw`` if it lies in one of ``roots``, else PathProblem."""
    if "\0" in raw:
        raise PathProblem("nul", raw)
    if not os.path.isabs(raw):
        raise PathProblem("relative", raw)
    try:
        path = Path(raw).resolve()
    except (OSError, RuntimeError, ValueError):   # symlink loop and the like
        raise PathProblem("not_found", raw) from None
    if not any(path.is_relative_to(root) for root in roots):
        raise PathProblem("forbidden", raw)
    return path


def check_path(raw, roots, kind="file"):
    """``(resolved path, os.stat_result)`` of an existing readable file (or ``"dir"``)."""
    path = resolve_in_roots(raw, roots)
    try:
        st = os.stat(path)
    except PermissionError:
        raise PathProblem("permission", raw) from None
    except (OSError, ValueError):
        raise PathProblem("not_found", raw) from None
    if kind == "dir":
        if not stat.S_ISDIR(st.st_mode):
            raise PathProblem("not_dir", raw)
        if not os.access(path, os.R_OK | os.X_OK):
            raise PathProblem("permission", raw)
    else:
        if not stat.S_ISREG(st.st_mode):
            raise PathProblem("not_file", raw)
        if not os.access(path, os.R_OK):
            raise PathProblem("permission", raw)
    return path, st
