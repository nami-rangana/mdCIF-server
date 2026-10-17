"""Jobs: creation, the JobManager queue, and the /api/jobs endpoints.

``<data-dir>/jobs/<id>/job.json`` holds the stored Job fields (``outputs``, ``elapsed`` and
``queue_position`` are computed when serving; keys starting with ``_`` are internal). Writes
are atomic. The manager writes ``job.json`` only while no worker process is alive for that job:
before starting it, after it exited, and when it is cancelled or the server stops; while a job
runs, only its worker writes it.
"""

import contextlib
import logging
import multiprocessing
import os
import re
import secrets
import shutil
import stat
import threading
import time
from pathlib import Path

from fastapi import APIRouter, Query, Response
from fastapi.responses import FileResponse

from .cmdline import build_command
from .common import (
    ACTIVE,
    JOB_ID_RE,
    STAGE_NAMES,
    TERMINAL,
    atomic_write_json,
    atomic_write_text,
    iso_utc,
    parse_iso,
    read_json,
)
from .errors import ApiError, summary_message
from .models import JobRequest
from .paths import PathProblem, check_path, resolve_in_roots
from .provenance_api import normalise, yaml_text
from .worker import run_job

log = logging.getLogger("mdcif_server")

TERMINATE_TIMEOUT = 5.0
POLL_INTERVAL = 0.2
# name -> kind, in the order they are listed (the .cif/.bcif come first, see outputs())
FIXED_OUTPUTS = [("provenance.yaml", "provenance"), ("landscape.png", "landscape"),
                 ("summary.txt", "summary"), ("info.txt", "info"),
                 ("validate.txt", "validation"), ("command.txt", "command"),
                 ("job.log", "log")]
MEDIA_TYPES = {"bcif": "application/octet-stream", "landscape": "image/png"}
TEXT_PLAIN = "text/plain; charset=utf-8"
PATH_MESSAGES = {"relative": "must be an absolute path", "nul": "no such file",
                 "not_found": "no such file", "not_file": "not a regular file",
                 "not_dir": "not a regular file", "permission": "permission denied",
                 "forbidden": "outside the allowed roots"}


def make_stem(name, job_id):
    stem = re.sub(r"[^A-Za-z0-9_-]+", "_", name).strip("_-")[:64]
    return stem or f"mdcif_{job_id}"


def new_job_id():
    return time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3)


def _not_found():
    return ApiError(404, "not_found", "unknown job")


def output_files(job, job_dir):
    """The downloadable files that exist now, in the order they are listed."""
    stem = job["stem"]
    names = []
    if "write" in job.get("timings", {}):            # listed once the write stage finished
        fmt = job["request"]["output_format"]
        if fmt in ("cif", "both"):
            names.append((f"{stem}.cif", "cif"))
        if fmt in ("bcif", "both"):
            names.append((f"{stem}.bcif", "bcif"))
    names += FIXED_OUTPUTS
    out = []
    for name, kind in names:
        try:
            st = os.lstat(Path(job_dir) / name)
        except OSError:
            continue
        if not stat.S_ISREG(st.st_mode):                 # the worker writes regular files only
            continue
        out.append({"name": name, "kind": kind, "size": st.st_size,
                    "url": f"/api/jobs/{job['id']}/files/{name}"})
    return out


class JobManager:
    """Queue (FIFO by creation) and worker processes, up to ``settings.workers`` at a time."""

    def __init__(self, settings):
        self.settings = settings
        self.root = Path(settings.data_dir) / "jobs"
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.cond = threading.Condition(self.lock)
        self.queue = []              # job ids, oldest first
        self.procs = {}              # job id -> running worker Process
        self.cancelling = set()
        self.ctx = multiprocessing.get_context("spawn")
        self.thread = None
        self._stop = False
        self.stopping = False        # the server got its stop signal (set by __main__ at once)

    # storage
    def job_dir(self, job_id):
        if not isinstance(job_id, str) or not JOB_ID_RE.fullmatch(job_id):
            raise _not_found()
        return self.root / job_id

    def read(self, job_id):
        try:
            return read_json(self.job_dir(job_id) / "job.json")
        except (OSError, ValueError):
            raise _not_found() from None

    def write(self, job):
        with self.lock:
            atomic_write_json(self.job_dir(job["id"]) / "job.json", job)

    def _end(self, job, state, error):
        """Terminal state set by the server (no worker alive for this job)."""
        now = time.time()
        if job.get("stage") == "write":              # partial .cif/.bcif of an unfinished write
            ext = {"cif": ["cif"], "bcif": ["bcif"], "both": ["cif", "bcif"]}
            for e in ext[job["request"]["output_format"]]:
                with contextlib.suppress(OSError):
                    os.unlink(self.job_dir(job["id"]) / f"{job['stem']}.{e}")
        job.update(state=state, error=error, finished=iso_utc(now), _finished_ts=now)
        self.write(job)
        log.info("job %s %s: %s", job["id"], state, error)

    # life cycle
    def start(self):
        """Recover the jobs of a previous run, then start the manager thread."""
        queued = []
        with self.lock:
            for d in sorted(self.root.iterdir()):
                if not JOB_ID_RE.fullmatch(d.name):
                    continue
                try:
                    job = read_json(d / "job.json")
                except (OSError, ValueError):
                    continue
                if job.get("state") == "running":
                    self._end(job, "failed", "interrupted (server restarted)")
                elif job.get("state") == "queued":
                    queued.append(job)
            queued.sort(key=lambda j: (j.get("_created_ts") or parse_iso(j["created"]), j["id"]))
            self.queue = [j["id"] for j in queued]
            self._stop = False
        if self.queue:
            log.info("queued again: %s", ", ".join(self.queue))
        self.thread = threading.Thread(target=self._loop, name="mdcif-job-manager", daemon=True)
        self.thread.start()

    def shutdown(self):
        """Stop the manager; running workers are terminated and their jobs fail."""
        with self.cond:
            self.stopping = True
            self._stop = True
            self.cond.notify_all()
        if self.thread is not None:
            self.thread.join()
        with self.lock:
            procs = dict(self.procs)
        for proc in procs.values():
            with contextlib.suppress(Exception):
                proc.terminate()
        for proc in procs.values():
            _stop_process(proc)
        with self.lock:
            for job_id in procs:
                self.procs.pop(job_id, None)
                self.cancelling.discard(job_id)
                with contextlib.suppress(ApiError):
                    job = self.read(job_id)
                    if job["state"] not in TERMINAL:
                        self._end(job, "failed", "interrupted (server stopped)")

    def _loop(self):
        with self.cond:
            while not self._stop:
                try:
                    self._reap()
                    while self.queue and len(self.procs) < self.settings.workers:
                        self._start_job(self.queue.pop(0))
                except Exception:
                    log.exception("job manager")
                self.cond.wait(POLL_INTERVAL)

    def _reap(self):
        for job_id, proc in list(self.procs.items()):
            if job_id in self.cancelling or proc.is_alive():
                continue
            proc.join()
            del self.procs[job_id]
            code = proc.exitcode
            with contextlib.suppress(Exception):
                proc.close()
            try:
                job = self.read(job_id)
            except ApiError:
                continue
            if job["state"] in TERMINAL:
                log.info("job %s %s", job_id, job["state"])
                continue
            if self.stopping:            # srun/Slurm signal the workers along with the server
                error = "interrupted (server stopped)"
            elif code is not None and code < 0:
                error = f"worker process killed by signal {-code}"
                if -code == 9:
                    error += " (out of memory?)"
            else:
                error = f"worker process died (exit code {code})"
            self._end(job, "failed", error)

    def _start_job(self, job_id):
        try:
            job = self.read(job_id)
        except ApiError:
            return
        if job["state"] != "queued":
            return
        now = time.time()
        job.update(state="running", stage=STAGE_NAMES[0], started=iso_utc(now), _started_ts=now)
        self.write(job)
        s = self.settings
        proc = self.ctx.Process(target=run_job, name=f"mdcif-job-{job_id}",
                                args=(str(self.job_dir(job_id)),),
                                kwargs={"threads": s.threads, "stage_delay": s.stage_delay,
                                        "parent_pid": os.getpid()})
        try:
            proc.start()
        except Exception as exc:
            log.exception("cannot start the worker of job %s", job_id)
            self._end(job, "failed", f"could not start the worker process: {exc}")
            return
        self.procs[job_id] = proc
        log.info("job %s started (pid %s)", job_id, proc.pid)

    # API operations
    def submit(self, job):
        """Store and queue a new job; returns its queue position."""
        with self.cond:
            self.write(job)
            self.queue.append(job["id"])
            position = len(self.queue)
            self.cond.notify_all()
        log.info("job %s queued", job["id"])
        return position

    def queue_position(self, job_id):
        with self.lock:
            return self.queue.index(job_id) + 1 if job_id in self.queue else None

    def view(self, job_id):
        with self.lock:
            job = self.read(job_id)
            position = self.queue_position(job_id) if job["state"] == "queued" else None
        return self.serve(job, position)

    def brief(self, job, position=None):
        """The JobBrief fields (jobs list) of a stored job.json, without ``valid``."""
        started, finished = job.get("_started_ts"), job.get("_finished_ts")
        if started is None and job.get("started"):
            started = parse_iso(job["started"])
        if finished is None and job.get("finished"):
            finished = parse_iso(job["finished"])
        elapsed = None
        if started is not None:
            elapsed = round(max(0.0, (finished or time.time()) - started), 1)
        return {"id": job["id"], "name": job["name"], "state": job["state"],
                "stage": job.get("stage"), "queue_position": position,
                "created": job["created"], "started": job.get("started"),
                "finished": job.get("finished"), "elapsed": elapsed, "error": job.get("error")}

    def serve(self, job, position=None):
        """The Job object of the API from a stored job.json."""
        out = self.brief(job, position)
        error = out.pop("error")
        out["timings"] = {k: job["timings"][k] for k in STAGE_NAMES
                          if k in job.get("timings", {})}
        out["error"] = error
        out["warnings"] = list(job.get("warnings", []))
        for key in ("request", "inputs", "stem", "command", "validation", "summary", "info",
                    "result"):
            out[key] = job.get(key)
        out["outputs"] = output_files(job, self.root / job["id"])
        return out

    def list(self):
        with self.lock:
            queue = list(self.queue)
        briefs = []
        for d in self.root.iterdir():
            if not JOB_ID_RE.fullmatch(d.name):
                continue
            try:
                job = read_json(d / "job.json")
            except (OSError, ValueError):
                continue
            position = (queue.index(job["id"]) + 1
                        if job["state"] == "queued" and job["id"] in queue else None)
            brief = self.brief(job, position)
            brief["valid"] = (job.get("validation") or {}).get("valid")
            briefs.append((job.get("_created_ts") or parse_iso(job["created"]), brief))
        briefs.sort(key=lambda x: (x[0], x[1]["id"]), reverse=True)
        return [b for _, b in briefs]

    def cancel(self, job_id):
        with self.cond:
            job = self.read(job_id)
            if job_id in self.cancelling:              # another cancel is stopping the worker
                raise ApiError(409, "job_finished", f"job {job_id} is already being cancelled")
            if job["state"] in TERMINAL:
                raise ApiError(409, "job_finished", f"job {job_id} already ended ({job['state']})")
            if job["state"] == "queued":
                with contextlib.suppress(ValueError):
                    self.queue.remove(job_id)
                job["stage"] = None
                self._end(job, "cancelled", "cancelled by user")
                return self.serve(job)
            proc = self.procs.get(job_id)
            self.cancelling.add(job_id)
        try:
            if proc is not None:                     # the response waits for its end
                proc.terminate()
                _stop_process(proc)
        finally:
            with self.cond:
                self.cancelling.discard(job_id)
                if self.procs.pop(job_id, None) is not None:
                    with contextlib.suppress(Exception):
                        proc.close()
                self.cond.notify_all()
                job = self.read(job_id)
                ended = job["state"] in TERMINAL     # it ended by itself in the meantime
                if not ended:
                    self._end(job, "cancelled", "cancelled by user")
        if ended:
            raise ApiError(409, "job_finished", f"job {job_id} already ended ({job['state']})")
        return self.serve(job)

    def delete(self, job_id):
        with self.lock:
            job = self.read(job_id)
            if job["state"] in ACTIVE:
                raise ApiError(409, "job_active",
                               f"job {job_id} is {job['state']}: cancel it first")
            shutil.rmtree(self.job_dir(job_id))
        log.info("job %s deleted", job_id)


def _stop_process(proc):
    proc.join(TERMINATE_TIMEOUT)
    if proc.is_alive():
        proc.kill()
        proc.join()


# job creation
def _input_items(request: JobRequest):
    """``(field, role, ref)`` for every input, in the order of the error fields."""
    inputs = request.inputs
    items = [("inputs.topology", "topology", inputs.topology)]
    items += [(f"inputs.trajectories.{i}", f"trajectory_{i + 1}", ref)
              for i, ref in enumerate(inputs.trajectories)]
    if inputs.labels is not None:
        items.append(("inputs.labels", "labels", inputs.labels))
    if inputs.reference is not None:
        items.append(("inputs.reference", "reference", inputs.reference))
    return items


def create_job(request: JobRequest, settings, uploads, manager: JobManager):
    roots = settings.allowed_roots
    items = _input_items(request)
    # 2. server paths outside the roots -> 403
    forbidden = {}
    for field, _, ref in items:
        raw = ref.server_path
        if raw is not None and "\0" not in raw and os.path.isabs(raw):
            try:
                resolve_in_roots(raw, roots)
            except PathProblem as problem:
                if problem.kind == "forbidden":
                    forbidden[field] = "outside the allowed roots"
    if forbidden:
        raise ApiError(403, "path_forbidden", summary_message(forbidden), forbidden)
    # 3. inputs that don't resolve -> 422, all at once
    problems, plans = {}, []
    for field, role, ref in items:
        if getattr(ref, "pdb_id", None):
            plans.append((field, role, {"source": "pdb_id", "pdb_id": ref.pdb_id}))
        elif ref.upload_id is not None:
            try:
                meta = uploads.get(ref.upload_id)     # 404 for a malformed id too
            except ApiError:
                meta = None
            if meta is None:
                problems[field] = "unknown upload"
            elif not meta["complete"]:
                problems[field] = (f"upload not complete (received {meta['received']} of "
                                   f"{meta['size']} bytes)")
            else:
                plans.append((field, role, {"source": "upload", "meta": meta}))
        else:
            try:
                path, st = check_path(ref.server_path, roots, kind="file")
            except PathProblem as problem:
                problems[field] = PATH_MESSAGES[problem.kind]
                continue
            if st.st_size == 0:
                problems[field] = "file is empty"
            else:
                plans.append((field, role, {"source": "server_path", "raw": ref.server_path,
                                            "path": str(path), "size": st.st_size}))
    if problems:
        raise ApiError(422, "invalid_input", summary_message(problems), problems)

    # create the job directory, link the uploads
    while True:
        job_id = new_job_id()
        job_dir = manager.root / job_id
        try:
            job_dir.mkdir()
            break
        except FileExistsError:
            continue
    try:
        resolved = {}
        link_problems = {}
        for field, role, plan in plans:
            if plan["source"] == "pdb_id":
                resolved[field] = {"source": "pdb_id", "upload_id": None, "server_path": None,
                                   "pdb_id": plan["pdb_id"], "name": plan["pdb_id"],
                                   "path": None, "size": None}
            elif plan["source"] == "upload":
                meta = plan["meta"]
                target = job_dir / "inputs" / role / meta["filename"]
                target.parent.mkdir(parents=True)
                try:
                    _link_or_copy(uploads.data_path(meta["id"]), target)
                except OSError:
                    link_problems[field] = "unknown upload"
                    continue
                resolved[field] = {"source": "upload", "upload_id": meta["id"],
                                   "server_path": None, "pdb_id": None,
                                   "name": meta["filename"], "path": str(target),
                                   "size": target.stat().st_size}
            else:
                resolved[field] = {"source": "server_path", "upload_id": None,
                                   "server_path": plan["raw"], "pdb_id": None,
                                   "name": Path(plan["path"]).name, "path": plan["path"],
                                   "size": plan["size"]}
        if link_problems:
            raise ApiError(422, "invalid_input", summary_message(link_problems), link_problems)
        inputs = {"topology": resolved["inputs.topology"],
                  "trajectories": [resolved[f"inputs.trajectories.{i}"]
                                   for i in range(len(request.inputs.trajectories))],
                  "labels": resolved.get("inputs.labels"),
                  "reference": resolved.get("inputs.reference")}
        provenance = normalise(request.provenance)
        pdb_id = provenance["system"]["reference_PDB_id"]
        if inputs["reference"] is None and pdb_id:
            inputs["reference"] = {"source": "provenance", "upload_id": None,
                                   "server_path": None, "pdb_id": pdb_id.upper(),
                                   "name": pdb_id.upper(), "path": None, "size": None}
        req = request.model_dump()
        req["inputs"] = {
            "topology": request.inputs.topology.model_dump(exclude_none=True),
            "trajectories": [t.model_dump(exclude_none=True)
                             for t in request.inputs.trajectories],
            "labels": (request.inputs.labels.model_dump(exclude_none=True)
                       if request.inputs.labels else None),
            "reference": (request.inputs.reference.model_dump(exclude_none=True)
                          if request.inputs.reference else None)}
        req["provenance"] = provenance
        stem = make_stem(request.name, job_id)
        command = build_command(inputs, req["options"], request.output_format, stem, job_dir)
        atomic_write_text(job_dir / "provenance.yaml", yaml_text(provenance))
        atomic_write_text(job_dir / "command.txt", command + "\n")
        now = time.time()
        job = {"id": job_id, "name": request.name, "state": "queued", "stage": None,
               "created": iso_utc(now), "started": None, "finished": None, "timings": {},
               "error": None, "warnings": [], "request": req, "inputs": inputs, "stem": stem,
               "command": command, "validation": None, "summary": None, "info": None,
               "result": None, "_created_ts": now}
        position = manager.submit(job)
    except BaseException:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise
    return manager.serve(job, position)


def _link_or_copy(source, target):
    try:
        os.link(source, target)
    except OSError:
        if not Path(source).is_file():
            raise
        shutil.copyfile(source, target)


def make_router(settings, uploads, manager: JobManager):
    router = APIRouter()

    @router.post("/api/jobs", status_code=201)
    def post_job(body: JobRequest, response: Response):
        job = create_job(body, settings, uploads, manager)
        response.headers["Location"] = f"/api/jobs/{job['id']}"
        return job

    @router.get("/api/jobs")
    def list_jobs():
        return {"jobs": manager.list()}

    @router.get("/api/jobs/{job_id}")
    def get_job(job_id: str):
        return manager.view(job_id)

    @router.post("/api/jobs/{job_id}/cancel")
    def cancel_job(job_id: str):
        return manager.cancel(job_id)

    @router.delete("/api/jobs/{job_id}", status_code=204)
    def delete_job(job_id: str):
        manager.delete(job_id)
        return Response(status_code=204)

    @router.get("/api/jobs/{job_id}/log")
    def job_log(job_id: str, offset: int = Query(0, ge=0),
                max_bytes: int = Query(65536, ge=1, le=1048576)):
        job = manager.read(job_id)
        path = manager.job_dir(job_id) / "job.log"
        try:
            with open(path, "rb") as fh:
                size = os.fstat(fh.fileno()).st_size
                if offset > size:
                    data = b""
                else:
                    fh.seek(offset)
                    data = fh.read(min(max_bytes, size - offset))
        except FileNotFoundError:
            size, data = 0, b""
        next_offset = size if offset > size else offset + len(data)
        return {"offset": offset, "next_offset": next_offset, "size": size,
                "state": job["state"], "text": data.decode("utf-8", errors="replace")}

    @router.get("/api/jobs/{job_id}/files/{name}")
    def job_file(job_id: str, name: str, download: str | None = None):
        job = manager.read(job_id)
        job_dir = manager.job_dir(job_id)
        entry = next((o for o in output_files(job, job_dir) if o["name"] == name), None)
        if entry is None:
            raise ApiError(404, "not_found", f"job {job_id} has no file {name!r}")
        disposition = "attachment" if download not in (None, "", "0", "false") else "inline"
        return FileResponse(job_dir / name, media_type=MEDIA_TYPES.get(entry["kind"], TEXT_PLAIN),
                            headers={"Content-Disposition": f'{disposition}; filename="{name}"'})

    return router
