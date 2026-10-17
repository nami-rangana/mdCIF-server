"""Request bodies of the upload and job endpoints.

Unknown fields are rejected; ``null`` means "not set" (the field takes its default). Options
are strict (no ``true`` for an integer, no ``"5"`` for a number), as the CLI would be.
"""

from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
    field_validator,
    model_validator,
)
from pydantic_core import PydanticCustomError

from .common import PDB_ID_RE
from .formats import FormatError, normalise_format
from .provenance_api import JobProvenance, nulls_to_defaults

# = mdcif.pipeline.DEFAULT_DEPOSIT_SELECTION (not imported: it would pull numpy into the server)
DEFAULT_DEPOSIT_SELECTION = "protein and not name H* and not resname ACE NME NHE NH2"


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="before")
    @classmethod
    def _nulls(cls, data):
        return nulls_to_defaults(cls, data)


def _strip(value):
    return value.strip() if isinstance(value, str) else value


class UploadCreate(Strict):
    filename: Annotated[StrictStr, Field(min_length=1, max_length=1024)]
    size: Annotated[StrictInt, Field(ge=0)]


class InputRef(Strict):
    upload_id: StrictStr | None = None
    server_path: StrictStr | None = None

    @model_validator(mode="after")
    def _exactly_one(self):
        if (self.upload_id is None) == (self.server_path is None):
            raise PydanticCustomError("input_ref", "give exactly one of upload_id or server_path")
        return self


class ReferenceRef(Strict):
    pdb_id: StrictStr | None = None
    upload_id: StrictStr | None = None
    server_path: StrictStr | None = None

    @field_validator("pdb_id")
    @classmethod
    def _pdb_id(cls, value):
        if value is not None:
            if not PDB_ID_RE.fullmatch(value):
                raise PydanticCustomError("pdb_id", "must be a 4-character PDB ID")
            value = value.upper()
        return value

    @model_validator(mode="after")
    def _exactly_one(self):
        if sum(x is not None for x in (self.pdb_id, self.upload_id, self.server_path)) != 1:
            raise PydanticCustomError("input_ref",
                                      "give exactly one of pdb_id, upload_id or server_path")
        return self


class Inputs(Strict):
    topology: InputRef
    trajectories: Annotated[list[InputRef], Field(min_length=1, max_length=100)]
    labels: InputRef | None = None
    reference: ReferenceRef | None = None


Selection = Annotated[StrictStr, Field(min_length=1, max_length=1000)]


class BuildOptions(Strict):
    start: StrictInt = 0
    stop: StrictInt | None = None
    step: Annotated[StrictInt, Field(ge=1)] = 1
    selection: Selection | None = None
    deposit_selection: Selection = DEFAULT_DEPOSIT_SELECTION
    format: Annotated[StrictStr, Field(max_length=64)] | None = None          # see formats.py
    n_pcs: Annotated[StrictInt, Field(ge=1)] = 3
    features: Literal["pca", "cartesian"] = "pca"
    min_cluster_size: Annotated[StrictInt, Field(ge=2)] | None = None
    min_samples: Annotated[StrictInt, Field(ge=1)] | None = None
    cluster_selection: Literal["eom", "leaf"] = "eom"
    max_models: Annotated[StrictInt, Field(ge=1)] | None = None
    labels_method: Annotated[StrictStr, Field(min_length=1, max_length=200)] | None = None
    n_modes: Annotated[StrictInt, Field(ge=1)] | None = None
    mass_weighted: StrictBool | None = None
    anm: StrictBool = False
    max_projection_points: Annotated[StrictInt, Field(ge=0)] = 5000

    @field_validator("format")
    @classmethod
    def _format(cls, value):
        """An alias (``netcdf``, ``Amber NetCDF``) -> its canonical MDAnalysis key (``NC``);
        an empty text -> None (detected from the file); unknown -> 422 on ``options.format``."""
        try:
            return normalise_format(value)
        except FormatError as exc:
            raise PydanticCustomError("trajectory_format", "{message}",
                                      {"message": str(exc)}) from None


class JobRequest(Strict):
    # Field before BeforeValidator: the limit is checked on the stripped text with pydantic's
    # string message ("at most 100 characters", not "items")
    name: Annotated[StrictStr, Field(max_length=100), BeforeValidator(_strip)] = ""
    inputs: Inputs
    options: BuildOptions = Field(default_factory=BuildOptions)
    provenance: JobProvenance = Field(default_factory=JobProvenance)
    output_format: Literal["cif", "bcif", "both"] = "cif"
