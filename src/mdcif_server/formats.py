"""Trajectory formats: the ``format`` option, normalised at job creation.

The keys are MDAnalysis' coordinate-reader formats (``MDAnalysis._READERS``) that read a file,
listed statically so that the server process never imports MDAnalysis. Aliases are
case-insensitive and map to one canonical key per reader, so ``netcdf``, ``Amber NetCDF`` and
``ncdf`` all become ``NC``.
"""

import re

# MDAnalysis reader keys that are not files: internal (CHAIN, MEMORY), a live network stream (IMD),
# in-memory converters (PARMED, RDKIT, OPENMM*), and CHEMFILES (its package is not installed)
NOT_FILES = {"CHAIN", "MEMORY", "IMD", "PARMED", "RDKIT", "OPENMMSIMULATION", "OPENMMAPP",
             "CHEMFILES"}

# canonical key -> the other names it accepts (MDAnalysis synonyms of the same reader first)
CANONICAL = {
    "NC": ["NCDF", "NETCDF", "NETCDF3", "AMBER NETCDF", "AMBER NC", "AMBER NCDF"],
    "DCD": ["CHARMM DCD", "NAMD DCD", "OPENMM DCD"],
    "XTC": ["GROMACS XTC"],
    "TRR": ["GROMACS TRR"],
    "TNG": ["GROMACS TNG"],
    # CRD: an Amber ASCII trajectory here (old Amber runs name them .crd); MDAnalysis' CHARMM
    # CRD reader holds a single frame, so it is not offered for trajectories
    "MDCRD": ["TRJ", "CRDBOX", "CRD", "AMBER MDCRD", "AMBER TRJ", "AMBER CRD", "AMBER ASCII"],
    "H5MD": [],
    "LAMMPSDUMP": ["LAMMPS DUMP", "LAMMPSTRJ"],
    "LAMMPS": ["LAMMPS DCD"],
    "DATA": ["LAMMPS DATA"],
    "PDB": ["ENT"],
    "XPDB": [],
    "GRO": ["GROMACS GRO"],
    "XYZ": [],
    "TXYZ": ["ARC", "TINKER XYZ"],
    "INPCRD": ["RESTRT", "RST7", "AMBER RESTART"],
    "NAMDBIN": ["COOR"],
    "FHIAIMS": ["IN"],
    "TRZ": [], "TRC": [], "TPR": [], "MOL2": [], "PDBQT": [], "PQR": [], "DMS": [], "GMS": [],
    "GSD": [], "MMTF": [], "CONFIG": [], "HISTORY": [],
}
FILE_FORMATS = frozenset(CANONICAL)                         # the canonical keys
ALIASES = {alias: key for key, names in CANONICAL.items() for alias in [key, *names]}
REMAPPED = {"CRD": "MDCRD"}           # MDAnalysis keys that deliberately name another reader here

# the formats the form offers, in its order (static/form.js has the same list; a test checks it)
COMMON = ["NC", "DCD", "XTC", "TRR", "TNG", "MDCRD", "H5MD", "LAMMPSDUMP", "PDB", "GRO", "XYZ"]
HINT = ("NC (Amber NetCDF), DCD, XTC, TRR, TNG, MDCRD (Amber ASCII), H5MD, LAMMPSDUMP, PDB, "
        "GRO, XYZ")


class FormatError(ValueError):
    """An unknown trajectory format; the message is the one the API returns."""


def normalise_format(text):
    """The canonical format key of ``text`` (case, spaces, ``-``/``_`` and a leading ``.``
    ignored), None for an empty text, else FormatError."""
    if text is None:
        return None
    key = re.sub(r"[\s_\-/]+", " ", text.strip().lstrip(".")).strip().upper()
    if not key:
        return None
    found = ALIASES.get(key) or ALIASES.get(key.replace(" ", ""))
    if found is None:
        shown = text.strip()
        shown = shown if len(shown) <= 40 else shown[:40] + "..."
        raise FormatError(f"unknown trajectory format '{shown}'. Leave it empty to detect it "
                          f"automatically, or use one of: {HINT} (or another MDAnalysis format)")
    return found
