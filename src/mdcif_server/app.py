"""The FastAPI application: ``create_app(settings)``, with the static routes and the routers."""

import mimetypes
import socket
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool

from . import __version__, files, jobs, provenance_api, uploads
from .auth import AuthMiddleware
from .common import STAGES
from .errors import JSONUTF8Response, install_handlers, plain_response
from .models import BuildOptions
from .settings import Settings

MEDIA_TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
               ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
               ".json": "application/json", ".svg": "image/svg+xml",
               ".txt": "text/plain; charset=utf-8", ".map": "application/json"}


def _media_type(path):
    return (MEDIA_TYPES.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0]
            or "application/octet-stream")


def config(settings: Settings):
    """GET /api/config."""
    import mdcif

    return {"version": __version__, "mdcif_version": mdcif.__version__,
            "hostname": socket.gethostname(), "data_dir": str(settings.data_dir),
            "allowed_roots": [str(r) for r in settings.allowed_roots],
            "max_upload_bytes": settings.max_upload_bytes, "chunk_size": settings.chunk_size,
            "workers": settings.workers, "threads_per_worker": settings.threads,
            "stages": [{"name": n, "label": label} for n, label in STAGES],
            "defaults": {"options": BuildOptions().model_dump(), "output_format": "cif",
                         "provenance": provenance_api.default_provenance()}}


def create_app(settings: Settings) -> FastAPI:
    manager = jobs.JobManager(settings)
    store = uploads.UploadStore(settings)

    @asynccontextmanager
    async def lifespan(app):
        await run_in_threadpool(manager.start)
        try:
            yield
        finally:
            await run_in_threadpool(manager.shutdown)

    app = FastAPI(title="mdcif-server", version=__version__, lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None, redirect_slashes=False,
                  default_response_class=JSONUTF8Response)
    app.state.settings = settings
    app.state.jobs = manager
    app.state.uploads = store
    install_handlers(app)
    app.add_middleware(AuthMiddleware, settings=settings)

    @app.get("/api/config")
    def get_config():
        return config(settings)

    app.include_router(uploads.make_router(store))
    app.include_router(files.make_router(settings))
    app.include_router(provenance_api.make_router())
    app.include_router(jobs.make_router(settings, store, manager))

    @app.get("/")
    def index():
        path = settings.static_dir / "index.html"
        if not path.is_file():
            return plain_response(404, "404 Not Found")
        return FileResponse(path, media_type="text/html; charset=utf-8",
                            headers={"Cache-Control": "no-cache"})

    @app.get("/static/{name:path}")
    def static(name: str):
        root = settings.static_dir.resolve()
        try:
            path = (root / name).resolve()
            ok = path.is_relative_to(root) and path.is_file()
        except (OSError, ValueError):
            ok = False
        if not ok:
            return plain_response(404, "404 Not Found")
        return FileResponse(path, media_type=_media_type(path),
                            headers={"Cache-Control": "no-cache"})

    return app
