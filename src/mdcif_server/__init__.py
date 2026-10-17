"""mdcif-server: a local web server that turns MD trajectories into mdcif files.

The user hands over a topology and trajectories (browser upload or a path on the server),
chooses the ``mdcif build`` options, fills in the provenance, and downloads a validated
``.cif`` / ``.bcif``. Builds run the mdcif pipeline in worker processes.
"""

__version__ = "0.1.0"
