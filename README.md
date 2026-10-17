# mdCIF-server

A small web app for making [mdcif](../mdcif) files from your MD simulations, from the browser.
Give it a topology and one or more trajectories (upload them, or pick files already on the
computer that runs the server), choose the build options, fill in the provenance form, and
download a validated `.cif` / `.bcif` with its summary, landscape plot, 3D view of the models,
`provenance.yaml` and the equivalent `mdcif build` command, which rebuilds exactly the same file
with the job's own
`provenance.yaml` (the server tidies a loosely written provenance first: it strips spaces around
text, turns a single author into a list and reads quoted numbers as numbers).

It runs on your own computer or on a HiPerGator compute node, and only you can open it: it
listens on `127.0.0.1` and asks for a secret token that is printed when it starts.

## Run it on your own computer (Ubuntu, macOS, Windows)

So far the server has only been run on Linux (HiPerGator). The steps are the same on Ubuntu and
macOS; Windows has not been tried yet.

### 1. Install (once)

1. Install **Miniforge** (conda and mamba from conda-forge):
   <https://github.com/conda-forge/miniforge>.
   - Ubuntu / macOS: download the installer for your system, run
     `bash Miniforge3-<your system>.sh`, and open a new terminal.
   - Windows: run the Windows installer, then use the **Miniforge Prompt** from the Start menu
     for every command below.
2. Put the two folders side by side: `mdcif` (the mdcif package) and `mdcif-server` (this
   folder).
3. From the folder that holds them, create the environment and install both packages:

   ```bash
   mamba create -n mdcif -c conda-forge python=3.11 numpy scipy "mdanalysis>=2.8" \
       "scikit-learn>=1.3" "ihm>=2.0" gemmi pyyaml typer matplotlib fastapi uvicorn
   conda activate mdcif
   pip install -e ./mdcif --no-deps
   pip install -e ./mdcif-server --no-deps
   ```

   On Windows, type the `mamba create` command on one line, without the `\`. Always use
   `--no-deps`: conda provides every dependency, and pip must not replace them.

### 2. Start it

```bash
conda activate mdcif
mdcif-server --allow-root ~ --data-dir ~/mdcif-server-data
```

- `--allow-root ~` lets the **Server path** option and its **Browse** dialog use the files in
  your home folder. Give it the folder that holds your trajectories; repeat it to allow
  several. Uploads work from anywhere.
- `--data-dir` is where uploads and results are kept.
- If port 8765 is taken, add `--port 8790` (any free port), or `--port 0` to pick one.

It prints a line like this:

```
mdcif-server URL: http://127.0.0.1:8765/?token=...
```

Open that link in a browser on the same computer; no tunnel is needed. After the first visit
`http://127.0.0.1:8765/` is enough until the server restarts. **Ctrl-C** in the terminal stops
it.

The computer needs internet for three things: the 3D view (3Dmol.js comes from
`cdn.jsdelivr.net`), the first validation (mdcif downloads the PDBx/IHM dictionaries once,
into `~/.cache/mdcif`), and references given as a PDB ID (downloaded from RCSB).

### 3. Try it with test data (optional)

MDAnalysis' test files include a small trajectory of adenylate kinase (AdK, 98 frames):

```bash
mamba install -n mdcif -c conda-forge mdanalysistests
python -c "import MDAnalysisTests.datafiles as d; print(d.PSF); print(d.DCD)"
```

Miniforge installs into your home folder, so with `--allow-root ~` you can give these two paths
as **Server path** (or upload the two files). Use them as topology and trajectory, set
**Smallest cluster** to `5`, and press **Start build**. It takes a few seconds.

## Run it on HiPerGator

1. On the login node, from this folder:

   ```bash
   scripts/start_hpg.sh
   ```

   This asks Slurm for a compute node (8 CPUs, 32 GB, 8 hours by default; see
   `scripts/start_hpg.sh --help` for `--port`, `--workers`, `--data-dir`, `--cpus`, `--mem`,
   `--time`). Once the node is up it prints the **node name** and **Slurm job id**, an **ssh
   command**, and a **link** with the token. Leave this terminal open: the server runs in it.

2. In a second terminal on the login node, run the printed ssh command and leave it open:

   ```bash
   ssh -N -L 8765:127.0.0.1:8765 c0702a-s4      # your node name and port will differ
   ```

   It prints nothing while it works. It may ask for your password. To skip that, add your own
   key to `~/.ssh/authorized_keys` once:
   `cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys`.

   In VS Code (connected to the login node), open the **Ports** panel and forward port `8765`
   (VS Code may do it by itself). If VS Code forwards it to a different local port, use that
   port in the link below.

3. Open the printed link (`http://127.0.0.1:8765/?token=...`) in your browser. After the first
   visit the browser remembers the token, so `http://127.0.0.1:8765/` is enough until the server
   restarts. A restarted server prints a new link. Keep the link private: the token is the only
   protection.

### Stop it

- **Ctrl-C** in the first terminal ends the Slurm job at once. Jobs that were running are
  marked failed ("interrupted (server restarted)") the next time the server starts, and queued
  jobs run again then.
- To stop it gently, so running jobs are marked failed ("interrupted (server stopped)") right
  away: `scancel --signal=INT <Slurm job id>`.
- The same happens when the `--time` limit runs out: Slurm stops the server, which marks its
  running jobs.

## Use it

- **New job:**
  - topology and trajectories (several = replicas, read one after another);
  - optional labels file (your own clustering) and reference structure (PDB ID or mmCIF file);
  - options (frames, selections, clustering, modes, output format);
  - provenance (import or export a YAML file in the layout of mdcif's
    `examples/provenance_template.yaml`).

  Upload small files from your computer; for large trajectories give the **server path** (or
  **Browse** for it).
- **Jobs:**
  - while it runs: progress by stage, live log, cancel;
  - when it is done: validation, the landscape plot, a 3D view of the models, the numbers per
    model, the reports (summary, `mdcif info`, validation), downloads, and the `mdcif build`
    command that makes the same file;
  - **Edit and run again** fills the form with a job's files, options and provenance.

  The 3D view loads 3Dmol.js from `cdn.jsdelivr.net`, so it needs internet in your browser; the
  rest works without.

For short test trajectories (under a few thousand frames) lower **Smallest cluster**
(`min_cluster_size`). The default (1% of the frames, at least 25) finds no clusters in, e.g.,
the 98-frame AdK test run; use 5 there.

Files are kept in the data dir (`--data-dir`; by default `mdcif-server-data/` in the folder you
start the server from, and `data/` in this folder for `scripts/start_hpg.sh`):
- `uploads/` holds the uploaded files;
- `jobs/` has one folder per job, with its outputs and its own link to its uploaded inputs.

Delete finished jobs from their page. An upload is deleted from the server when you replace or
clear its file in the form, or use **Clear form**. A job never depends on `uploads/`: it has its
own copy. The files get your usual permissions: whoever can read your other files on `/blue`
(e.g. your group) can read them too. The token protects the web page, not the files.

## Start it by hand on HiPerGator

On any HiPerGator node with the `mdcif` conda env (on the login node only for small tests such
as AdK):

```bash
PYTHONPATH=src /blue/alberto.perezant/t.desilva/conda/envs/mdcif/bin/python -m mdcif_server \
    --port 8765 --data-dir data --workers 1 [--allow-root /blue/alberto.perezant] [--max-upload-gb 20]
```

- `--port 0` picks a free port.
- The `mdcif-server URL:` line has the link.
- Ctrl-C stops the server and marks its running jobs failed.
- Server paths must be inside an allowed root (default `/blue/alberto.perezant`; repeat
  `--allow-root` for more).
- `--threads` sets threads per build (default: the CPUs Slurm gave you, else 4, divided by
  `--workers`).
- `scripts/start_hpg.sh --here` runs it on the current node, e.g. inside an `salloc` session.

## Requirements on HiPerGator

- The `mdcif` conda env (mdcif's `environment.yml`), with the `mdcif` package installed in it
  (`pip install -e . --no-deps` in the mdcif folder).
- `fastapi` and `uvicorn` in the same env: `mamba install -n mdcif -c conda-forge fastapi uvicorn`.
- `scripts/start_hpg.sh` runs `/blue/alberto.perezant/t.desilva/conda/envs/mdcif/bin/python`;
  set `MDCIF_PYTHON` to use the Python of another env.
- The user guide, with screenshots of each step: [docs/USER_GUIDE.md](docs/USER_GUIDE.md).
