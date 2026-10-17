# mdCIF-server

A small web app for making [mdcif](../mdcif) files from your MD simulations, from the browser.
Give it a topology and one or more trajectories (upload them, or pick files already on
`/blue`), choose the build options, fill in the provenance form, and download a validated
`.cif` / `.bcif` with its summary, landscape plot, 3D view of the models, `provenance.yaml` and
the equivalent `mdcif build` command, which rebuilds exactly the same file with the job's own
`provenance.yaml` (the server tidies a loosely written provenance first: it strips spaces around
text, turns a single author into a list and reads quoted numbers as numbers).

It runs on a HiPerGator compute node and only you can open it: it listens on `127.0.0.1` and
asks for a secret token that is printed when it starts.

## Start it on HiPerGator

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

Files are kept in the data dir (`data/` in this folder for `scripts/start_hpg.sh`):
- `uploads/` holds the uploaded files;
- `jobs/` has one folder per job, with its outputs and its own link to its uploaded inputs.

Delete finished jobs from their page. An upload is deleted from the server when you replace or
clear its file in the form, or use **Clear form**. A job never depends on `uploads/`: it has its
own copy. The files get your usual permissions: whoever can read your other files on `/blue`
(e.g. your group) can read them too. The token protects the web page, not the files.

## Run it elsewhere

On any machine with the `mdcif` conda env (on the login node only for small tests such as AdK):

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

## Requirements

- The `mdcif` conda env (mdcif's `environment.yml`), with the `mdcif` package installed in it
  (`pip install -e . --no-deps` in the mdcif folder).
- `fastapi` and `uvicorn` in the same env: `mamba install -n mdcif -c conda-forge fastapi uvicorn`.
- `scripts/start_hpg.sh` runs `/blue/alberto.perezant/t.desilva/conda/envs/mdcif/bin/python`;
  set `MDCIF_PYTHON` to use the Python of another env.
- The user guide, with screenshots of each step: [docs/USER_GUIDE.md](docs/USER_GUIDE.md).
