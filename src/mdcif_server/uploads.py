"""Chunked, resumable uploads: ``<data-dir>/uploads/<id>/{upload.json,data}``.

A chunk is streamed from ``request.stream()`` to ``data`` (never held whole in memory): the
file is truncated to ``offset`` and the chunk appended, so re-sending a chunk overwrites it.
One chunk per upload at a time (409 ``upload_busy``); ``upload.json`` is written atomically.
Keys of ``upload.json`` starting with ``_`` are internal (not served).
"""

import re
import secrets
import shutil
import threading
import time
from pathlib import Path

import anyio
from fastapi import APIRouter, Query, Request, Response
from starlette.requests import ClientDisconnect

from .common import UPLOAD_ID_RE, atomic_write_json, iso_utc, read_json
from .errors import ApiError
from .models import UploadCreate

WRITE_BLOCK = 1024 ** 2            # bytes gathered before each write to disk


def sanitise_filename(name):
    """Upload file name -> a safe name for the job's input file."""
    name = re.split(r"[/\\]", name)[-1]
    name = re.sub(r"[^A-Za-z0-9._+-]", "_", name).lstrip(".-")[-128:]
    return name or "file"


def public(meta):
    """The Upload object of the API (internal ``_`` keys left out)."""
    return {k: v for k, v in meta.items() if not k.startswith("_")}


def _not_found():
    return ApiError(404, "not_found", "unknown upload")


class UploadStore:
    def __init__(self, settings):
        self.settings = settings
        self.root = Path(settings.data_dir) / "uploads"
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.busy = set()

    # storage
    def path(self, upload_id):
        if not isinstance(upload_id, str) or not UPLOAD_ID_RE.fullmatch(upload_id):
            raise _not_found()
        return self.root / upload_id

    def get(self, upload_id):
        try:
            return read_json(self.path(upload_id) / "upload.json")
        except (OSError, ValueError):
            raise _not_found() from None

    def data_path(self, upload_id):
        return self.path(upload_id) / "data"

    def _save(self, meta):
        atomic_write_json(self.path(meta["id"]) / "upload.json", meta)

    def acquire(self, upload_id):
        with self.lock:
            if upload_id in self.busy:
                raise ApiError(409, "upload_busy",
                               "another chunk of this upload is being received")
            self.busy.add(upload_id)

    def release(self, upload_id):
        with self.lock:
            self.busy.discard(upload_id)

    # operations
    def create(self, filename, size):
        s = self.settings
        if size == 0:
            raise ApiError(422, "empty_file", "file is empty", {"size": "file is empty"})
        if size > s.max_upload_bytes:
            raise ApiError(413, "upload_too_large",
                           f"file of {size} bytes is larger than the upload limit "
                           f"({s.max_upload_bytes} bytes)", {"size": "too large"})
        free = shutil.disk_usage(self.root).free
        if size > free:
            raise ApiError(507, "insufficient_storage",
                           f"not enough free disk space in the data dir for {size} bytes "
                           f"({free} bytes free)")
        while True:
            upload_id = secrets.token_hex(16)
            try:
                self.path(upload_id).mkdir()
                break
            except FileExistsError:
                continue
        self.data_path(upload_id).touch()
        now = time.time()
        meta = {"id": upload_id, "filename": sanitise_filename(filename), "size": size,
                "received": 0, "complete": False, "created": iso_utc(now),
                "updated": iso_utc(now), "_created_ts": now}
        self._save(meta)
        return meta

    def list(self):
        uploads = []
        for d in self.root.iterdir():
            if UPLOAD_ID_RE.fullmatch(d.name):
                try:
                    uploads.append(read_json(d / "upload.json"))
                except (OSError, ValueError):
                    continue
        uploads.sort(key=lambda u: (u.get("_created_ts") or 0, u["created"], u["id"]),
                     reverse=True)
        return [public(u) for u in uploads]

    def complete(self, upload_id):
        self.get(upload_id)
        self.acquire(upload_id)
        try:
            meta = self.get(upload_id)
            if not meta["complete"]:
                if meta["received"] != meta["size"]:
                    raise ApiError(409, "upload_incomplete",
                                   f"received {meta['received']} of {meta['size']} bytes")
                meta["complete"] = True
                self._save(meta)
            return meta
        finally:
            self.release(upload_id)

    def delete(self, upload_id):
        self.get(upload_id)
        self.acquire(upload_id)
        try:
            shutil.rmtree(self.path(upload_id))
        finally:
            self.release(upload_id)

    async def put(self, upload_id, offset, request):
        meta = self.get(upload_id)
        if meta["complete"]:
            raise ApiError(409, "upload_complete", "upload is already complete")
        self.acquire(upload_id)
        try:
            return await self._put(upload_id, offset, request)
        finally:
            self.release(upload_id)

    async def _put(self, upload_id, offset, request):
        chunk_size = self.settings.chunk_size
        meta = self.get(upload_id)
        if meta["complete"]:
            raise ApiError(409, "upload_complete", "upload is already complete")
        size, received = meta["size"], meta["received"]
        if offset > received:
            raise ApiError(409, "offset_mismatch",
                           f"offset {offset} is past the {received} bytes received so far",
                           {"offset": f"must be at most {received}"})
        too_large = ApiError(413, "chunk_too_large",
                             f"chunk is larger than the chunk size ({chunk_size} bytes)")
        empty = ApiError(400, "empty_chunk", "empty chunk")

        def overflow(end):
            return ApiError(400, "chunk_overflow",
                            f"chunk ends at byte {end}, past the declared size ({size} bytes)")

        length = request.headers.get("content-length")
        if length is not None:
            if not length.isdigit():
                raise ApiError(400, "bad_request", "invalid Content-Length header")
            length = int(length)
            if length > chunk_size:
                raise too_large
            if length == 0:
                raise empty
            if offset + length > size:
                raise overflow(offset + length)

        path = self.data_path(upload_id)
        fh, written, buffer, error = None, 0, bytearray(), None
        try:
            async for piece in request.stream():
                if not piece:
                    continue
                if written + len(piece) > chunk_size:
                    error = too_large
                    break
                if offset + written + len(piece) > size:
                    error = overflow(offset + written + len(piece))
                    break
                if fh is None:
                    fh = open(path, "r+b")      # closed in finally
                    fh.truncate(offset)
                    fh.seek(offset)
                buffer += piece
                written += len(piece)
                if len(buffer) >= WRITE_BLOCK:
                    await anyio.to_thread.run_sync(fh.write, bytes(buffer))
                    buffer.clear()
        except ClientDisconnect:
            pass                                # keep what arrived
        finally:
            if fh is not None:
                if buffer and error is None:
                    fh.write(bytes(buffer))
                if error is not None:
                    fh.truncate(offset)
                fh.close()
        if error is not None:
            if fh is None:                      # limit passed before anything was written
                with open(path, "r+b") as f:
                    f.truncate(offset)
            meta.update(received=offset, updated=iso_utc())
            self._save(meta)
            raise error
        if written == 0:
            raise empty
        meta.update(received=offset + written, updated=iso_utc())
        self._save(meta)
        return meta


def make_router(store: UploadStore):
    router = APIRouter()

    @router.post("/api/uploads", status_code=201)
    def create_upload(body: UploadCreate):
        return public(store.create(body.filename, body.size))

    @router.get("/api/uploads")
    def list_uploads():
        return {"uploads": store.list()}

    @router.get("/api/uploads/{upload_id}")
    def get_upload(upload_id: str):
        return public(store.get(upload_id))

    @router.put("/api/uploads/{upload_id}")
    async def put_chunk(upload_id: str, request: Request, offset: int = Query(ge=0)):
        return public(await store.put(upload_id, offset, request))

    @router.post("/api/uploads/{upload_id}/complete")
    def complete_upload(upload_id: str):
        return public(store.complete(upload_id))

    @router.delete("/api/uploads/{upload_id}", status_code=204)
    def delete_upload(upload_id: str):
        store.delete(upload_id)
        return Response(status_code=204)

    return router
