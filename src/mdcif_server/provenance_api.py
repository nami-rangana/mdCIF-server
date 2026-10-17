"""Provenance: schema, normalisation, YAML text and the /api/provenance endpoints.

The pydantic models follow the layout of mdcif's YAML template (``provenance_to_dict``). They
normalise what comes in: nulls take the defaults, any scalar becomes a stripped string in a
string field, a single string becomes a one-item ``authors`` list, and numbers keep their type
(``300`` stays an int, ``403.65`` a float, ``"1.5e3"`` becomes ``1500.0``), so the file is the
same as ``mdcif build`` with the same YAML. Unknown keys are ignored. The normalised dict always
goes through ``mdcif.provenance.provenance_from_dict`` / ``provenance_to_dict``.
"""

import datetime
import math
import re
from pathlib import Path
from typing import Annotated

import yaml
from fastapi import APIRouter
from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StrictBool,
    StrictStr,
    ValidationError,
    field_validator,
    model_validator,
)
from pydantic_core import PydanticCustomError

from . import __version__
from .common import PDB_ID_RE
from .errors import ApiError, pydantic_fields, validation_error

YAML_HEADER = f"# mdcif provenance, written by mdcif-server {__version__}\n"
PDB_ID_MESSAGE = "must be a 4-character PDB ID; give a reference file as inputs.reference"

HELP = {
    "dataset.title": "Title of the file (default: system name).",
    "dataset.authors": 'Authors, one per entry, as "Last, F.".',
    "dataset.trajectory_doi": "DOI of the full trajectory (e.g. Zenodo).",
    "dataset.trajectory_database": "If there is no DOI: database name (e.g. MDposit) ...",
    "dataset.trajectory_accession": "... and accession in it (e.g. MD-A00142).",
    "system.name": "Name of the simulated system (also the file's data block ID).",
    "system.source_structure": "PDB ID or model the simulation started from.",
    "system.reference_PDB_id": "Experimental PDB entry of the same molecule (entity, citations, "
                               "superposition, RMSD); same as the reference input. Must be "
                               "empty or a PDB ID.",
    "system.composition": "Protein / ligands / membrane / ions.",
    "simulation.engine": "GROMACS, AMBER, OpenMM, NAMD, CHARMM, ...",
    "simulation.engine_version": "Engine version.",
    "simulation.force_field": "e.g. CHARMM36m, ff19SB.",
    "simulation.water_model": "e.g. TIP3P, OPC.",
    "simulation.ensemble": "NVE, NVT, NPT, NPAT.",
    "simulation.temperature_K": "Temperature (K).",
    "simulation.pressure_bar": "Pressure (bar).",
    "simulation.timestep_fs": "Integration time step (fs).",
    "simulation.length_ns": "Simulated time per replica (ns).",
    "simulation.n_replicas": "Number of replicas.",
    "simulation.enhanced_sampling": "none, REMD, metadynamics, GaMD, ...",
    "simulation.save_interval_ps": "Time between saved frames (ps).",
    "simulation.details": "Free text (box, ions, thermostat, ...).",
    "analysis.frames_used": 'e.g. "every 10th frame after 50 ns equilibration".',
    "analysis.alignment_selection": "Atoms used for the alignment (MDAnalysis selection).",
    "clustering.software": "Only for your own labels: the tool that made them.",
    "clustering.method": "e.g. HDBSCAN (built in), or the algorithm behind your labels.",
    "clustering.feature": "What was clustered.",
    "clustering.selection": "Atoms used for clustering (MDAnalysis selection).",
    "clustering.n_clusters": "Filled in by the build.",
    "clustering.cutoff_angstrom": "Clustering cutoff (Å), if any.",
    "clustering.n_models_deposited": "Top clusters kept as models (filled in by the build).",
    "modes.method": "PCA or quasi-harmonic.",
    "modes.selection": "Atoms for the modes; the default of the selection option.",
    "modes.mass_weighted": "Quasi-harmonic (mass-weighted) modes; the default of the "
                           "mass_weighted option.",
    "modes.n_modes": "Essential modes per model; the default of the n_modes option.",
    "modes.per_cluster": "Each model gets the modes of its own cluster.",
}
RECOMMENDED = ["dataset.title", "dataset.authors", "dataset.trajectory_doi", "system.name",
               "simulation.engine", "simulation.force_field", "simulation.water_model",
               "simulation.ensemble", "simulation.temperature_K", "simulation.length_ns"]

_INT_RE = re.compile(r"[+-]?\d+")
_SCALARS = (str, int, float, bool, datetime.date, datetime.datetime)


def _to_str(value):
    if isinstance(value, _SCALARS):
        return str(value).strip()
    raise PydanticCustomError("string_type", "must be a string")


def _to_number(value):
    if value is None:
        return None
    if isinstance(value, str):
        text = value.strip()
        if _INT_RE.fullmatch(text):
            return int(text)
        try:
            value = float(text)
        except ValueError:
            raise PydanticCustomError("number_type", "must be a number") from None
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise PydanticCustomError("number_type", "must be a number")
    if isinstance(value, float) and not math.isfinite(value):
        raise PydanticCustomError("number_type", "must be a finite number")
    return value


def _to_int(value):
    if value is None:
        return None
    try:
        number = _to_number(value)
    except PydanticCustomError:
        raise PydanticCustomError("int_type", "must be an integer") from None
    if isinstance(number, float):
        if not number.is_integer():
            raise PydanticCustomError("int_type", "must be an integer")
        number = int(number)
    return number


def _to_authors(value):
    if isinstance(value, str):
        return [value] if value.strip() else []
    if isinstance(value, list | tuple):
        return list(value)
    raise PydanticCustomError("list_type", "must be a list of strings")


Text = Annotated[str, BeforeValidator(_to_str)]
Number = Annotated[int | float | None, BeforeValidator(_to_number)]
OptionalInt = Annotated[int | None, BeforeValidator(_to_int)]
PositiveInt = Annotated[int, BeforeValidator(_to_int), Field(ge=1)]
Authors = Annotated[list[Text], BeforeValidator(_to_authors)]


def nulls_to_defaults(cls, data):
    """Drop ``None`` values of optional fields whose default is not None (they take it)."""
    if data is None:
        return {}
    if not isinstance(data, dict):
        return data
    fields = cls.model_fields
    return {k: v for k, v in data.items()
            if v is not None or k not in fields or fields[k].is_required()
            or fields[k].default is None}


class _Section(BaseModel):
    model_config = ConfigDict(extra="ignore")

    @model_validator(mode="before")
    @classmethod
    def _nulls(cls, data):
        return nulls_to_defaults(cls, data)


class Dataset(_Section):
    title: Text = ""
    authors: Authors = Field(default_factory=list)
    trajectory_doi: Text = ""
    trajectory_database: Text = ""
    trajectory_accession: Text = ""


class System(_Section):
    name: Text = ""
    source_structure: Text = ""
    reference_PDB_id: Text = ""
    composition: Text = ""


class Simulation(_Section):
    engine: Text = ""
    engine_version: Text = ""
    force_field: Text = ""
    water_model: Text = ""
    ensemble: Text = ""
    temperature_K: Number = None
    pressure_bar: Number = None
    timestep_fs: Number = None
    length_ns: Number = None
    n_replicas: PositiveInt = 1
    enhanced_sampling: Text = "none"
    save_interval_ps: Number = None
    details: Text = ""


class Analysis(_Section):
    frames_used: Text = ""
    alignment_selection: Text = "name CA"


class Clustering(_Section):
    software: Text = ""
    method: Text = ""
    feature: Text = "RMSD"
    selection: Text = "name CA"
    n_clusters: OptionalInt = None
    cutoff_angstrom: Number = None
    n_models_deposited: OptionalInt = None


class Modes(_Section):
    method: Text = "PCA"
    selection: Text = "name CA"
    mass_weighted: StrictBool = False
    n_modes: PositiveInt = 3
    per_cluster: StrictBool = True


class ProvenanceModel(_Section):
    dataset: Dataset = Field(default_factory=Dataset)
    system: System = Field(default_factory=System)
    simulation: Simulation = Field(default_factory=Simulation)
    analysis: Analysis = Field(default_factory=Analysis)
    clustering: Clustering = Field(default_factory=Clustering)
    modes: Modes = Field(default_factory=Modes)


class JobSystem(System):
    @field_validator("reference_PDB_id")
    @classmethod
    def _pdb_id(cls, value):
        if value and not PDB_ID_RE.fullmatch(value):
            raise PydanticCustomError("pdb_id", PDB_ID_MESSAGE)
        return value


class JobProvenance(ProvenanceModel):
    """The provenance of a job request: also rejects a ``reference_PDB_id`` that is no PDB ID."""

    system: JobSystem = Field(default_factory=JobSystem)


SECTIONS = {name: list(model.model_fields) for name, model in
            (("dataset", Dataset), ("system", System), ("simulation", Simulation),
             ("analysis", Analysis), ("clustering", Clustering), ("modes", Modes))}


def normalise(model: ProvenanceModel) -> dict:
    """The normalised provenance dict (all six sections and every field, in template order)."""
    from mdcif.provenance import provenance_from_dict, provenance_to_dict

    return provenance_to_dict(provenance_from_dict(model.model_dump()))


def default_provenance():
    from mdcif.provenance import Provenance, provenance_to_dict

    return provenance_to_dict(Provenance())


def yaml_text(provenance: dict) -> str:
    """The YAML text the server writes (export, and each job's ``provenance.yaml``)."""
    return YAML_HEADER + yaml.safe_dump(provenance, sort_keys=False, allow_unicode=True,
                                        default_flow_style=False)


def template_yaml():
    import mdcif

    path = Path(mdcif.__file__).resolve().parents[2] / "examples" / "provenance_template.yaml"
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return yaml_text(default_provenance())


def unknown_keys(data):
    """``"unknown key <dotted path> ignored"`` for every key outside the template."""
    warnings = []
    for section, value in data.items():
        if section not in SECTIONS:
            warnings.append(f"unknown key {section} ignored")
        elif isinstance(value, dict):
            warnings.extend(f"unknown key {section}.{key} ignored" for key in value
                            if key not in SECTIONS[section])
    return warnings


def float_paths(provenance):
    """Dotted paths of the fields that hold a float: JSON can't tell 300.0
    from 300, and mdcif writes them differently."""
    return [f"{section}.{key}" for section, fields in provenance.items()
            for key, value in fields.items() if isinstance(value, float)]


def parse_yaml(text):
    """``(normalised dict, warnings)`` of a provenance YAML text, else ApiError."""
    try:
        data = yaml.safe_load(text)
    except yaml.MarkedYAMLError as exc:
        mark = exc.problem_mark or exc.context_mark
        problem = exc.problem or exc.context or type(exc).__name__
        where = f" at line {mark.line + 1}, column {mark.column + 1}" if mark else ""
        raise ApiError(400, "invalid_yaml", f"YAML error{where}: {problem}") from None
    except yaml.YAMLError as exc:
        raise ApiError(400, "invalid_yaml", f"YAML error: {' '.join(str(exc).split())}") from None
    if data is None:
        data = {}
    if not isinstance(data, dict):
        raise ApiError(400, "invalid_yaml", "top level must be a mapping of sections")
    for section in SECTIONS:
        if data.get(section) is not None and not isinstance(data[section], dict):
            raise ApiError(400, "invalid_yaml", f"section '{section}' must be a mapping")
    try:
        model = ProvenanceModel.model_validate(data)
    except ValidationError as exc:
        raise validation_error(pydantic_fields(exc.errors(), prefix="provenance")) from None
    provenance = normalise(model)
    warnings = unknown_keys(data)
    pdb_id = provenance["system"]["reference_PDB_id"]
    if pdb_id and not PDB_ID_RE.fullmatch(pdb_id):
        warnings.append("system.reference_PDB_id is not a PDB ID: jobs will reject it")
    return provenance, warnings


class ParseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    yaml: Annotated[StrictStr, Field(max_length=1024 ** 2)]


class YamlRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provenance: ProvenanceModel = Field(default_factory=ProvenanceModel)

    @model_validator(mode="before")
    @classmethod
    def _nulls(cls, data):
        return nulls_to_defaults(cls, data)


def make_router():
    router = APIRouter()

    @router.get("/api/provenance/template")
    def template():
        return {"provenance": default_provenance(), "yaml": template_yaml(), "help": HELP,
                "recommended": RECOMMENDED}

    @router.post("/api/provenance/parse")
    def parse(body: ParseRequest):
        provenance, warnings = parse_yaml(body.yaml)
        return {"provenance": provenance, "floats": float_paths(provenance),
                "warnings": warnings}

    @router.post("/api/provenance/yaml")
    def to_yaml(body: YamlRequest):
        return {"yaml": yaml_text(normalise(body.provenance))}

    return router
