"""The ``mdcif build`` command line equivalent to a job."""

import shlex
from pathlib import Path

from .models import BuildOptions

DEFAULTS = BuildOptions().model_dump()
# options written as "--flag value" when they differ from their default, in this order
VALUE_FLAGS = [("labels_method", "--labels-method"), ("n_pcs", "--n-pcs"),
               ("features", "--features"), ("min_cluster_size", "--min-cluster-size"),
               ("min_samples", "--min-samples"), ("cluster_selection", "--cluster-selection"),
               ("max_models", "--max-models"), ("n_modes", "--n-modes"),
               ("selection", "--selection"), ("deposit_selection", "--deposit-selection"),
               ("start", "--start"), ("stop", "--stop"), ("step", "--step"),
               ("format", "--format")]
EXTENSIONS = {"cif": ["cif"], "bcif": ["bcif"], "both": ["cif", "bcif"]}


def build_command(inputs, options, output_format, stem, job_dir):
    """One line per output file (``.cif`` first); tokens quoted with ``shlex.quote``.

    ``inputs`` are the job's ResolvedInputs, ``options`` its full BuildOptions dict.
    """
    head = ["mdcif", "build", inputs["topology"]["path"],
            *(t["path"] for t in inputs["trajectories"]),
            "--provenance", str(Path(job_dir) / "provenance.yaml")]
    tail = []
    if inputs.get("labels"):
        tail += ["--labels", inputs["labels"]["path"]]
    for key, flag in VALUE_FLAGS:
        if options[key] != DEFAULTS[key]:
            tail += [flag, str(options[key])]
    reference = inputs.get("reference")
    if reference and reference["source"] != "provenance":   # else the CLI reads the YAML
        tail += ["--reference",
                 reference["pdb_id"] if reference["source"] == "pdb_id" else reference["path"]]
    if options["max_projection_points"] != DEFAULTS["max_projection_points"]:
        tail += ["--max-projection-points", str(options["max_projection_points"])]
    if options["mass_weighted"] is not None:
        tail.append("--mass-weighted" if options["mass_weighted"] else "--no-mass-weighted")
    if options["anm"]:
        tail.append("--anm")
    return "\n".join(" ".join(shlex.quote(str(t))
                              for t in head + ["--output", f"{stem}.{ext}"] + tail)
                     for ext in EXTENSIONS[output_format])
