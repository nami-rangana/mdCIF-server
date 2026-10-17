"""Server settings: one object built by the command line or by the tests."""

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_ROOT = "/blue/alberto.perezant"
DEFAULT_DATA_DIR = "./mdcif-server-data"
STATIC_DIR = Path(__file__).resolve().parent / "static"
TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{32,}")
TOKEN_ENV = "MDCIF_SERVER_TOKEN"
JSON_BODY_LIMIT = 1024 ** 2                    # larger JSON bodies -> 413 body_too_large


class SettingsError(ValueError):
    """A setting that makes the server impossible to start (missing root, bad token, ...)."""


def cpus():
    """``$SLURM_CPUS_PER_TASK`` if set, else ``min(4, os.cpu_count())``."""
    value = os.environ.get("SLURM_CPUS_PER_TASK", "")
    if value.isdigit() and int(value) > 0:
        return int(value)
    return min(4, os.cpu_count() or 1)


def default_threads(workers):
    return max(1, cpus() // max(1, workers))


@dataclass
class Settings:
    data_dir: Path
    token: str
    allowed_roots: list = field(default_factory=lambda: [DEFAULT_ROOT])
    port: int = 8765
    workers: int = 1
    threads: int | None = None                 # None: default_threads(workers)
    max_upload_bytes: int = int(20 * 1024 ** 3)
    chunk_size: int = 8 * 1024 ** 2
    log_level: str = "info"
    static_dir: Path = STATIC_DIR
    stage_delay: float = 0.0                   # test hook: the worker sleeps before each stage

    def __post_init__(self):
        if not isinstance(self.token, str) or not TOKEN_RE.fullmatch(self.token):
            raise SettingsError(f"the token must match ^{TOKEN_RE.pattern}$")
        if self.workers < 1:
            raise SettingsError("--workers must be at least 1")
        if self.threads is None:
            self.threads = default_threads(self.workers)
        if self.threads < 1:
            raise SettingsError("--threads must be at least 1")
        if self.chunk_size < 1 or self.max_upload_bytes < 1:
            raise SettingsError("--chunk-mb and --max-upload-gb must be positive")
        roots = []
        for root in self.allowed_roots:
            try:
                path = Path(root).expanduser().resolve(strict=True)
            except (OSError, RuntimeError) as exc:
                raise SettingsError(f"allowed root {root} does not exist") from exc
            if not path.is_dir():
                raise SettingsError(f"allowed root {root} is not a directory")
            if path not in roots:
                roots.append(path)
        if not roots:
            raise SettingsError("give at least one --allow-root")
        self.allowed_roots = roots
        data_dir = Path(self.data_dir).expanduser()
        try:
            data_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise SettingsError(f"cannot create the data dir {data_dir}: {exc}") from exc
        self.data_dir = data_dir.resolve()
        (self.data_dir / "uploads").mkdir(exist_ok=True)
        (self.data_dir / "jobs").mkdir(exist_ok=True)
        self.static_dir = Path(self.static_dir)

    @property
    def cookie_name(self):
        return f"mdcif_token_{self.port}"
