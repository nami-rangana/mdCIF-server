"""GET /api/files: list a directory inside an allowed root, for the Browse dialog."""

import os
import stat

from fastapi import APIRouter

from .common import iso_utc
from .errors import ApiError
from .paths import PathProblem, check_path

MAX_ENTRIES = 5000


def path_error(problem: PathProblem):
    """The /api/files error for a failed path check."""
    path = problem.path
    kind = problem.kind
    if kind == "relative":
        return ApiError(400, "bad_path", f"path must be absolute: {path}",
                        {"path": "must be an absolute path"})
    if kind == "nul":
        return ApiError(400, "bad_path", "path contains a NUL byte",
                        {"path": "contains a NUL byte"})
    if kind == "forbidden":
        return ApiError(403, "path_forbidden", f"{path} is outside the allowed roots",
                        {"path": "outside the allowed roots"})
    if kind == "not_found":
        return ApiError(404, "path_not_found", f"no such file or directory: {path}",
                        {"path": "no such file or directory"})
    if kind == "not_dir":
        return ApiError(400, "bad_path", "not a directory", {"path": "not a directory"})
    return ApiError(403, "permission_denied", f"permission denied: {path}",
                    {"path": "permission denied"})


def _entry(name, path, is_symlink):
    try:
        st = os.stat(path)
    except (OSError, ValueError):
        return {"name": name, "path": path, "type": "other", "size": None, "mtime": None,
                "symlink": is_symlink}
    kind = ("dir" if stat.S_ISDIR(st.st_mode) else
            "file" if stat.S_ISREG(st.st_mode) else "other")
    return {"name": name, "path": path, "type": kind,
            "size": st.st_size if kind == "file" else None,
            "mtime": iso_utc(st.st_mtime), "symlink": is_symlink}


def _sort_key(item):
    name, is_dir = item[0], item[1]
    return (not is_dir, name.casefold(), name)


def list_directory(raw, roots, hidden=False):
    roots_text = [str(r) for r in roots]
    if not raw:
        items = sorted(((str(r), True) for r in roots), key=_sort_key)
        return {"path": None, "parent": None, "roots": roots_text,
                "entries": [_entry(name, name, False) for name, _ in items],
                "truncated": False}
    try:
        path, _ = check_path(raw, roots, kind="dir")
    except PathProblem as problem:
        raise path_error(problem) from None
    items = []
    try:
        with os.scandir(path) as it:
            for entry in it:
                if not hidden and entry.name.startswith("."):
                    continue
                try:
                    is_dir = entry.is_dir()             # follows symlinks
                    is_symlink = entry.is_symlink()
                except OSError:
                    is_dir, is_symlink = False, False
                items.append((entry.name, is_dir, is_symlink))
    except PermissionError:
        raise path_error(PathProblem("permission", raw)) from None
    except OSError:
        raise path_error(PathProblem("not_found", raw)) from None
    items.sort(key=_sort_key)
    truncated = len(items) > MAX_ENTRIES
    entries = [_entry(name, os.path.join(path, name), is_symlink)
               for name, _, is_symlink in items[:MAX_ENTRIES]]
    return {"path": str(path), "parent": None if path in roots else str(path.parent),
            "roots": roots_text, "entries": entries, "truncated": truncated}


def make_router(settings):
    router = APIRouter()

    @router.get("/api/files")
    def list_files(path: str | None = None, hidden: bool = False):
        return list_directory(path, settings.allowed_roots, hidden)

    return router
