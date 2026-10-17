"""One job in its own process: the stages of ``mdcif build``.

``run_job`` is the target of a ``multiprocessing.get_context("spawn").Process``. Nothing heavy
is imported at module level: the child first sets its BLAS/OpenMP thread counts and the Agg
backend, moves into the job directory, sends fds 1 and 2 to ``job.log`` and starts a watchdog
that exits if the server dies; only then do the stages import numpy, MDAnalysis and mdcif.

The stages repeat ``mdcif.pipeline.build_mdcif`` and ``mdcif.cli.build`` step by step with
the same arguments, so the file is the same as ``mdcif build`` with the same inputs. Outputs
are written by relative name in the job directory (texts then say ``AdK_test.cif: ...``).
While the job runs, only this process writes ``job.json``.
"""

import contextlib
import io
import os
import re
import signal
import sys
import threading
import time
import traceback
import warnings
from pathlib import Path

from . import __version__
from .common import STAGE_NAMES, atomic_write_json, atomic_write_text, iso_utc, one_line, read_json

THREAD_VARS = ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS")
MAX_PROBLEMS = 200


def run_job(job_dir, threads=1, stage_delay=0.0, parent_pid=None):
    """Run the job in ``job_dir`` (a child process; see the module docstring)."""
    for var in THREAD_VARS:
        os.environ[var] = str(threads)
    os.environ["MPLBACKEND"] = "Agg"
    os.environ.pop("MDCIF_SERVER_TOKEN", None)
    os.chdir(job_dir)
    fd = os.open("job.log", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o666)
    os.dup2(fd, 1)
    os.dup2(fd, 2)
    os.close(fd)
    sys.stdout = open(1, "w", encoding="utf-8", errors="replace", buffering=1, closefd=False)
    sys.stderr = open(2, "w", encoding="utf-8", errors="replace", buffering=1, closefd=False)
    signal.signal(signal.SIGINT, signal.SIG_IGN)      # Ctrl-C stops the server, which stops us
    parent = parent_pid or os.getppid()
    threading.Thread(target=_watchdog, args=(parent,), daemon=True,
                     name="mdcif-watchdog").start()
    _Job(stage_delay).run()


def _watchdog(parent):
    """Exit at once if the server process goes away, so no orphan keeps running."""
    while True:
        if os.getppid() != parent:
            os._exit(1)
        time.sleep(0.5)


def log(message):
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}", flush=True)


def read_labels(path):
    """Like ``mdcif.cli._read_labels``: .npy, or text with one integer label per line."""
    import numpy as np

    path = Path(path)
    labels = np.load(path) if path.suffix == ".npy" else np.loadtxt(path, dtype=float)
    labels = np.asarray(labels).ravel()
    if not np.all(labels == np.round(labels)):
        raise ValueError(f"{path}: labels must be integers (-1 = noise)")
    return labels.astype(int)


def without_format_list(text):
    """``text`` without the list of every format MDAnalysis appends to some errors ("The FORMATs
    dict_keys([...]) are implemented ...", "Known FORMATs are: ...") and the advice after it."""
    return re.split(r"\s*(?:The|Known) FORMATs\b", text, maxsplit=1)[0]


def _guess_format(path):
    """The format MDAnalysis reads ``path`` as when none is given (mdcif's guess first, as in
    ``mdcif.trajectory.load_universe``), or None."""
    try:
        from mdcif.trajectory import guess_format

        fmt = guess_format(path)
        if fmt is None:
            from MDAnalysis.lib.util import guess_format as mda_guess_format

            fmt = mda_guess_format(path)
        return str(fmt).upper() if fmt else None
    except Exception:
        return None


def summary_result(summary):
    """The ``result`` object of the Job from a BuildSummary."""
    c = summary.clusters
    total = len(c.labels)
    models = []
    for i in range(summary.n_models):
        ms = summary.mode_sets[i]
        frames = int(c.populations[i])
        models.append({
            "model": i + 1, "frames": frames, "fraction": frames / total,
            "medoid": (summary.frame_labels[i] if summary.frame_labels
                       else f"frame {int(c.representatives[i])}"),
            "precision": float(c.precision[i]),
            "reference_rmsd": (float(summary.reference_rmsd[i]) if summary.reference_rmsd
                               else None),
            "n_modes": 0 if ms is None else int(ms.n_modes),
            "variance": [] if ms is None else [float(v) for v in ms.variance_fraction]})
    g = summary.global_modes
    return {"n_frames": int(summary.n_frames), "n_analysis_atoms": int(summary.n_analysis_atoms),
            "n_deposited_atoms": int(summary.n_deposited_atoms),
            "n_clusters": int(c.n_clusters), "n_models": int(summary.n_models),
            "noise_fraction": float(c.noise_fraction), "clustering": c.details,
            "global_variance": [] if g is None else [float(v) for v in g.variance_fraction],
            "reference": summary.reference_label or None, "models": models,
            "timings": {k: float(v) for k, v in summary.timings.items()}}


class _Job:
    def __init__(self, stage_delay=0.0):
        self.job = read_json("job.json")
        self.stage_delay = stage_delay
        request = self.job["request"]
        self.options = request["options"]
        self.inputs = self.job["inputs"]
        self.stem = self.job["stem"]
        self.extensions = {"cif": ["cif"], "bcif": ["bcif"],
                           "both": ["cif", "bcif"]}[request["output_format"]]
        self.outputs = [f"{self.stem}.{ext}" for ext in self.extensions]
        self.primary = self.outputs[0]
        self.job.setdefault("warnings", [])
        self.job.setdefault("timings", {})

    def save(self):
        atomic_write_json("job.json", self.job)

    def warn(self, text):
        log(f"warning: {text}")
        self.job["warnings"].append(text)

    def run(self):
        stage = None
        try:
            import mdcif

            log(f"mdcif-server {__version__}, mdcif {mdcif.__version__}, job {self.job['id']}, "
                f"{os.environ['OMP_NUM_THREADS']} threads, pid {os.getpid()}")
            for stage in STAGE_NAMES:
                self.job["stage"] = stage
                self.save()
                log(f"stage {stage}")
                if self.stage_delay:
                    time.sleep(self.stage_delay)
                t0 = time.perf_counter()
                getattr(self, f"_{stage}")()
                self.job["timings"][stage] = round(time.perf_counter() - t0, 1)
            now = time.time()
            self.job.update(state="succeeded", finished=iso_utc(now), _finished_ts=now)
            self.save()
            log("succeeded")
        except BaseException as exc:
            traceback.print_exc()
            sys.stderr.flush()
            if stage == "write":
                self.remove_outputs()
            now = time.time()
            text = without_format_list(str(exc))            # never MDAnalysis' list
            self.job.update(state="failed", error=one_line(text if text.strip() else exc),
                            finished=iso_utc(now), _finished_ts=now)
            self.save()
            log(f"failed in stage {stage}: {self.job['error']}")
            if not isinstance(exc, Exception):
                raise

    def remove_outputs(self):
        for name in self.outputs:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(name)

    # stages
    def _prepare(self):
        from mdcif.provenance import provenance_from_dict
        from mdcif.trajectory import guess_format

        self.prov = provenance_from_dict(self.job["request"]["provenance"])
        fmt = self.options["format"]
        for t in self.inputs["trajectories"]:
            guessed = guess_format(t["path"])
            log(f"trajectory {t['path']}: format "
                + (f"{fmt} (given)" if fmt else guessed or "left to MDAnalysis"))
        self.labels = None
        if self.inputs.get("labels"):
            self.labels = read_labels(self.inputs["labels"]["path"])
            log(f"labels: {len(self.labels)} read from {self.inputs['labels']['path']}")
        reference = self.inputs.get("reference")
        pdb_id = None
        if reference is None or reference["source"] == "provenance":
            self.ref = self.prov.reference_PDB_id or None
            pdb_id = self.ref
        elif reference["source"] == "pdb_id":
            self.ref = pdb_id = reference["pdb_id"]
        else:
            self.ref = reference["path"]
        if pdb_id:
            from mdcif.reference import fetch

            try:
                path = fetch(pdb_id)
            except Exception as exc:
                raise RuntimeError(f"could not download PDB entry {pdb_id.upper()} from RCSB: "
                                   f"{one_line(exc)}") from exc
            log(f"reference: PDB {pdb_id.upper()} ({path})")
        elif self.ref:                       # a file: read it now, not after the trajectory
            from mdcif.reference import load_reference

            log(f"reference: {load_reference(self.ref).label} ({self.ref})")

    def _load(self):
        import MDAnalysis  # noqa: F401  (imported first: see the filter below)
        from mdcif.pipeline import load_trajectory

        # importing MDAnalysis makes its own DeprecationWarnings loud (e.g. DCDReader's, on every
        # DCD job); they are for developers, not for the job log
        warnings.filterwarnings("ignore", category=DeprecationWarning)
        o, prov = self.options, self.prov
        t0 = time.perf_counter()
        try:
            self.traj = load_trajectory(
                self.inputs["topology"]["path"],
                [t["path"] for t in self.inputs["trajectories"]],
                selection=o["selection"] or prov.modes.selection or "name CA",
                deposit_selection=o["deposit_selection"], start=o["start"], stop=o["stop"],
                step=o["step"], n_global_modes=max(3, o["n_pcs"]), traj_format=o["format"])
        except Exception as exc:
            message = self.reader_error(exc)
            if message is None:
                raise
            raise RuntimeError(message) from exc
        self.t_read = time.perf_counter() - t0
        traj = self.traj
        log(f"{traj.n_frames} frames, {len(traj.analysis)} analysis atoms, "
            f"{len(traj.deposit)} deposited atoms")

    def label(self, path):
        """How an input file is named in messages: its server path as given, else
        ``"<name> (uploaded)"``."""
        ins = self.inputs
        for item in [ins.get("topology"), *ins.get("trajectories", [])]:
            if item and item.get("path") == path:
                return item.get("server_path") or f"{item.get('name')} (uploaded)"
        return Path(path).name

    def reader_error(self, exc):
        """A readable one-line error for an MDAnalysis failure to open or read an input
        file, naming the file and the format; None for any other exception.

        Three cases: no trajectory reader for the format (MDAnalysis' own message lists every
        format it knows), no topology parser for the file, and a reader that fails on the file
        (a binary file named ``.trj`` otherwise gives a bare "'utf-8' codec can't decode ...").
        """
        chain, seen = [], exc
        while seen is not None and len(chain) < 10:
            chain.append(seen)
            seen = seen.__cause__ or seen.__context__
        texts = " ".join(str(e) for e in chain)
        frames = []                           # (path under MDAnalysis/, function, locals)
        for e in chain:
            tb = e.__traceback__
            while tb is not None:
                name = tb.tb_frame.f_code.co_filename.replace("\\", "/")
                if "/MDAnalysis/" in name:
                    frames.append((name.split("/MDAnalysis/", 1)[1], tb.tb_frame.f_code.co_name,
                                   tb.tb_frame.f_locals))
                tb = tb.tb_next

        def local(where, key):
            for rel, func, loc in frames:
                if (rel, func) in where and isinstance(loc.get(key), str | os.PathLike):
                    return os.fspath(loc[key])
            return None

        advice = "(Advanced options, Trajectory format; e.g. NC, DCD, XTC, TRR, MDCRD)"
        # a topology first: MDAnalysis also tries it as coordinates, so its chain has both texts
        if any(func == "get_parser_for" for _, func, _ in frames):
            where = {("core/_get_readers.py", "get_parser_for")}
            filename = local(where, "filename")
            fmt = local(where, "format")
            label = self.label(filename) if filename else "the topology"
            return (f"could not read the topology {label}: MDAnalysis has no topology reader "
                    f"for the format '{fmt}' (taken from the file name). Give a topology file "
                    "MDAnalysis reads (e.g. PSF, PRMTOP/PARM7, GRO, TPR, PDB).")
        if ("Cannot find an appropriate coordinate reader" in texts
                or "Unknown coordinate trajectory format" in texts):
            where = {("core/universe.py", "load_new"), ("core/_get_readers.py", "get_reader_for")}
            filename = local(where, "filename")
            fmt = local(where, "format")
            if fmt is None:
                m = re.search(r"Unknown coordinate trajectory format '([^']*)'", texts)
                fmt = m.group(1) if m else None
            label = self.label(filename) if filename else "the trajectory"
            if fmt:
                return (f"could not read {label}: MDAnalysis has no trajectory reader for the "
                        f"format '{str(fmt).upper()}'. Leave the format on automatic detection, "
                        f"or choose one MDAnalysis reads {advice}.")
            return (f"could not read {label}: MDAnalysis can't tell its format from the file "
                    f"name; choose it in the format option {advice}.")
        filename = None
        for rel, _, loc in frames:            # the innermost reader frame names the file
            if rel.startswith("coordinates/"):
                me = loc.get("self")
                name = getattr(me, "filename", None) or loc.get("filename")
                if isinstance(name, str | os.PathLike):
                    filename = os.fspath(name)
        if filename is None:
            return None
        label = self.label(filename)
        fmt = self.options["format"] or _guess_format(filename)
        text_file = any(isinstance(e, UnicodeDecodeError) for e in chain)
        what = ("it is not a text file" if text_file
                else one_line(without_format_list(str(exc)), 300).removeprefix("Error: "))
        message = f"could not read {label}" + (f" as {fmt}" if fmt else "") + f": {what}. "
        if fmt:
            message += f"If it is not a {fmt} file, give its format in the format option {advice}."
        else:
            message += f"Give its format in the format option {advice}."
        return message

    def _cluster(self):
        from mdcif.pipeline import cluster

        o, prov = self.options, self.prov
        if self.labels is not None:          # name the tool that made them, as build_mdcif
            method = o["labels_method"] or prov.clustering.method or None
            software = prov.clustering.software or None
        else:
            method, software = o["labels_method"], None
        t0 = time.perf_counter()
        self.clusters = cluster(self.traj, None, labels=self.labels, n_pcs=o["n_pcs"],
                                features=o["features"], method=method, software=software,
                                min_cluster_size=o["min_cluster_size"],
                                min_samples=o["min_samples"],
                                cluster_selection=o["cluster_selection"])
        self.t_cluster = time.perf_counter() - t0
        log(f"clustering: {self.clusters.details}, {self.clusters.n_clusters} clusters")

    def _write(self):
        from mdcif.pipeline import save_mdcif

        o = self.options
        summaries = []
        for name in self.outputs:            # .cif first, then .bcif (same build)
            summary = save_mdcif(name, self.traj, self.clusters, self.prov,
                                 n_modes=o["n_modes"], mass_weighted=o["mass_weighted"],
                                 max_models=o["max_models"], reference=self.ref,
                                 max_projection_points=o["max_projection_points"],
                                 anm=o["anm"])
            summary.timings = {"read+pca": self.t_read, "cluster": self.t_cluster,
                               **summary.timings}
            summaries.append(summary)
            log(f"wrote {name}")
        report = summaries[0].report()
        atomic_write_text("summary.txt", report + "\n")
        print(report, flush=True)
        self.job["summary"] = report
        self.job["result"] = summary_result(summaries[0])

    def _validate(self):
        primary = self.primary
        try:
            from mdcif.validate import MdcifValidationError, validate_mdcif

            try:
                validate_mdcif(primary)
                valid, problems = True, []
                text = f"{primary}: valid (PDBx + IHM + mdcif_ext, mode checks)"
            except MdcifValidationError as exc:
                valid, problems = False, list(exc.problems)
                text = "\n".join([f"{primary}: {len(problems)} problem(s)"]
                                 + [f"  {p}" for p in problems])
        except Exception as exc:
            traceback.print_exc()
            valid, problems = None, []
            text = f"{primary}: validation could not run: {one_line(exc)}"
            self.warn(f"validation could not run: {one_line(exc)}")
        if len(problems) > MAX_PROBLEMS:
            problems = problems[:MAX_PROBLEMS - 1] + [
                f"... and {len(problems) - MAX_PROBLEMS + 1} more (see validate.txt)"]
        try:
            atomic_write_text("validate.txt", text + "\n")
        except Exception as exc:
            self.warn(f"validate.txt not written: {one_line(exc)}")
        log(text.splitlines()[0])
        self.job["validation"] = {"valid": valid, "file": primary, "problems": problems,
                                  "text": text}

    def _report(self):
        primary = self.primary
        try:
            from mdcif.cli import info

            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                info(Path(primary))
            text = out.getvalue()
            atomic_write_text("info.txt", text)
            self.job["info"] = text.rstrip("\n")
        except Exception as exc:
            traceback.print_exc()
            self.warn(f"info failed: {one_line(exc)}")
        self._landscape()

    def _landscape(self):
        tmp = ".landscape.tmp.png"            # the PNG appears only once complete
        try:
            from mdcif.plot import plot_landscape

            try:
                plot_landscape(self.primary, tmp, reference=self.ref)
            except Exception as exc:
                if not self.ref:
                    raise
                traceback.print_exc()
                self.warn(f"landscape without reference: {one_line(exc)}")
                plot_landscape(self.primary, tmp)
            os.replace(tmp, "landscape.png")
            log("wrote landscape.png")
        except Exception as exc:
            traceback.print_exc()
            self.warn(f"landscape not drawn: {one_line(exc)}")
            with contextlib.suppress(OSError):
                os.unlink(tmp)
