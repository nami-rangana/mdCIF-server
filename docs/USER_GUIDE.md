# mdcif server: user guide

This guide shows how to turn an MD trajectory into an mdcif file (`.cif` / `.bcif`) from your
browser, with the mdcif server running on a HiPerGator compute node.

The screenshots were taken with a server on the login node, so the page header says
`on login9.ufhpc`; your server shows the name of its compute node there. Steps that have not
been tried yet are marked **not yet tested** (see section 8).

What you get for each job:
- the mdcif file, validated against the PDBx, IHM and mdcif dictionaries;
- the conformational landscape plot, and a 3D view of the deposited models;
- the numbers per model, and the reports (`mdcif info`, validation, build summary);
- your provenance as `provenance.yaml`;
- the `mdcif build` command that makes the same file in a shell.

## 1. Start the server on a compute node

On the login node, in a terminal, from the server folder:

```bash
cd /blue/alberto.perezant/t.desilva/mdcif-server
scripts/start_hpg.sh
```

This asks Slurm for a compute node (by default 8 CPUs, 32 GB, 8 hours). When the node is ready,
it prints something like this (your node, job number, port and token will differ):

```
mdcif-server is starting on compute node c0710a-s15 (Slurm job 46363030).

1. In another terminal on the login node, open the tunnel and leave it running:

     ssh -N -L 8791:127.0.0.1:8791 c0710a-s15

   (VS Code connected to the login node: then forward port 8791 in the Ports panel.)

2. Open this link in your browser (it holds the access token; don't share it):

     http://127.0.0.1:8791/?token=<a long secret>

Stop the server with Ctrl-C here.
...
mdcif-server URL: http://127.0.0.1:8791/?token=<a long secret>
```

Leave this terminal open: the server runs in it.

Useful options (`scripts/start_hpg.sh --help` lists them all):
- `--port 8791`: pick another port if 8765 is taken.
- `--time 02:00:00`: how long the server may run (the default is 8 hours).
- `--workers 2`: run two builds at the same time.
- `--cpus 16 --mem 64gb`: a bigger node.
- `--data-dir /blue/.../my-mdcif-data`: where uploads and results are kept (default: the
  `data/` folder of the server).

Keep the link to yourself: the token in it is the only thing that protects your server.

## 2. Open it in your browser (not yet tested)

The server only listens on the compute node itself. To reach it from your computer, use one of
these two routes. **Neither has been tested yet.**

**Route A, a terminal on the login node:** in a second terminal on the login node, run the ssh
line the script printed, and leave it running (it prints nothing while it works):

```bash
ssh -N -L 8791:127.0.0.1:8791 c0710a-s15
```

It may ask for your HiPerGator password. If you would rather not type it each time, add your
own key to your `~/.ssh/authorized_keys` once (see the README).

**Route B, VS Code connected to the login node:** after starting the tunnel as in route A, open
the **Ports** panel and forward the port (VS Code may do it by itself). If VS Code forwards it
to a different local port, use that port in the link.

Then open the link printed by the script (`http://127.0.0.1:8791/?token=...`) in your browser.
- The address bar changes to `http://127.0.0.1:8791/` and the New job page opens.
- Your browser remembers the login until the server restarts: `http://127.0.0.1:8791/` is then
  enough.

Each time the server starts, it prints a new link. If you keep using an old page after a
restart, you see this message. Open the new link to continue; your jobs are still there:

![Session expired page](img/session-expired.png)

## 3. Make an mdcif file

### 3.1 The New job page

![New job page](img/new-job-top.png)

Give the job a **Name**: it is shown in the jobs list, and it names the files ("AdK test" gives
`AdK_test.cif`).

### 3.2 Files

Each file is either **uploaded** from your computer or given as a **server path** (a file
already on `/blue`).

**Upload.** Press **Choose file...** (or drop the file on the box). The upload starts
at once and shows its progress. Wait for "Uploaded as ..." before you start the build.

![Upload in progress](img/upload-progress.png)

**Server path: use it for large trajectories.** Choose **Server path**, then type the
path, or press **Browse...** to pick the file. Browse starts at the allowed folders
(`/blue/alberto.perezant`); "Go to folder" jumps to a folder you type, and "Last folder" goes
back to where you picked the previous file. Click the file, then **Use this file**.

![Browse dialog](img/browse-dialog.png)

- **Topology:** any topology MDAnalysis reads (PSF, PRMTOP/PARM7, GRO, TPR, PDB, ...).
- **Trajectories:** one file per replica, read one after the other. **Add trajectory** adds a
  replica.
- **Labels (optional):** your own clustering instead of HDBSCAN. Give one integer per analysed
  frame (after start/stop/step), with -1 for noise, as `.npy` or as text with one label per line.
- **Reference structure (optional):** a PDB ID (downloaded from RCSB), or a `.cif` / `.bcif`
  file. The models are superposed on it and their RMSD to it is recorded.

### 3.3 Build options

![Build options](img/build-options.png)

These are the options of `mdcif build`, with its defaults; leave a field empty to keep the
default.
- **First frame / Stop before frame / Step:** which frames to use, e.g. skip equilibration
  with First frame and thin the trajectory with Step.
- **Smallest cluster (frames):** the default is 1% of the frames, at least 25. For short test
  runs (a few hundred frames or fewer) lower it: the 98-frame AdK test needs 5. Otherwise every
  frame ends up as noise and the job fails with a message saying so.
- **Output file:** `.cif`, `.bcif` or both. The 3D view on the job page needs the `.cif`.
- **Advanced options:** atom selections, trajectory format, the other clustering settings, the
  number of modes, mass weighting, ANM comparison, projection points.

**Trajectory format (Advanced options).** Leave it on **Detect automatically
(recommended)**: NetCDF, DCD, XTC and TRR files are recognised by their contents, whatever they
are called (e.g. `meld.nc.001`). The other formats are recognised by the file extension. If
detection fails, choose the format from the list, e.g. **Amber NetCDF (NC)** for Amber `.nc`
files, or **Amber ASCII trajectory (MDCRD)** for `.mdcrd`/`.crd`/`.trj`.

For a format that is not in the list, choose **Other...** and type its MDAnalysis name (e.g.
`TRZ`). Common names are understood: `NetCDF`, `Amber NetCDF` and `ncdf` all mean NC, and `trj`
or `crd` mean MDCRD. A name the server does not know is refused under the field, and nothing is
started:

![Trajectory format: Other... with an unknown name](img/format-select.png)

**Edit and run again** shows an older job's format in the list, even if it was typed by hand
(e.g. `NetCDF` shows as "Amber NetCDF (NC)").

### 3.4 Provenance

![Provenance imported](img/provenance-imported.png)

This describes your simulation inside the file. Fields marked ★ are recommended; none is
required.
- **Import YAML...:** fills the form from an existing `provenance.yaml` (the layout of
  mdcif's `examples/provenance_template.yaml`). Unknown keys are reported, not used.
- **Export YAML:** saves the form as `provenance.yaml`.

Numbers are kept as you wrote them. `300.0` stays `300.0`, in the form and in the file
(`300.000`, as `mdcif build` writes it), and `300` stays `300`. A value such as `1.5e3` is shown
as `1500.0`:

![Provenance numbers after Import YAML](img/provenance-floats.png)

The server tidies a provenance before it builds:
- it strips spaces around text;
- one author given as plain text becomes a one-item list;
- `"300"` written in quotes becomes a number.

The job's own `provenance.yaml` (under Files) holds the tidied version, and the job's command
line uses it. `mdcif build` run on your original YAML gives the same file whenever that YAML is
already tidy, as Export YAML writes it.

### 3.5 Start the build and follow it

Press **Start build** at the bottom of the form. If something is wrong with a file, the message
appears next to that file and nothing is started:

![Error at a file](img/submit-error.png)

Otherwise the job page opens. While the job runs, it shows the six steps of the build and the
live log, updated every 2 seconds:

![Running job](img/job-running.png)

**Cancel job** stops it after a confirmation; files already written are kept.

![Cancel confirmation](img/cancel-dialog.png)

### 3.6 Results

When the job is done, the page shows the following.

The validation result:

![Finished job](img/job-finished-top.png)

The conformational landscape (every frame on the global principal components, coloured by
model):

![Landscape](img/job-landscape.png)

A 3D view of the deposited models, one colour per model as in the landscape. Drag to rotate,
scroll to zoom, and tick models on or off. It loads 3Dmol.js from `cdn.jsdelivr.net`, so your
browser needs internet access; everything else works without it.

![3D view](img/job-viewer.png)

If the job wrote only `.bcif`, the 3D view says so:

![bcif only](img/job-bcif-only.png)

The numbers per model, the reports (summary, `mdcif info`, validation), and the downloads:

![Models](img/job-models.png)

![Files](img/job-files.png)

The command line that makes the same file with the mdcif CLI: running it gives a byte-identical
file.

![Command line](img/job-command.png)

### 3.7 Edit and run again

On any job page, **Edit and run again** opens the New job form filled with that job's files,
options and provenance. Change what you need and press **Start build**.

![Edit and run again](img/edit-and-run-again.png)

Uploaded files are reused as they are: the form checks that each one is still on the server.

**Clear form** deletes the files you uploaded in the form from the server. If you then use
**Edit and run again** on an older job that used them, the form says so at each file, and
**Start build** does nothing until you choose the files again or give their server paths:

![Edit and run again after the uploads were deleted](img/rerun-deleted-upload.png)

Jobs themselves never lose their files: each job keeps its own copy.

Uploads that came back through **Edit and run again** are not deleted by **Clear form**.
They stay in the data folder's `uploads/`.

### 3.8 When a build fails

The job page says which step failed and why, in one line. The full technical details are in the
log below it.

![Failed job](img/job-failed.png)

Common messages:
- "HDBSCAN put every frame in noise; lower min_cluster_size": lower **Smallest cluster**.
- "selection 'name XX' matched no atoms": check the atom selection (Advanced options).
- "The topology and ... trajectory files don't have the same number of atoms": the topology
  is not the one of this trajectory.
- "can't tell the trajectory format of ...": choose the **Trajectory format** (Advanced
  options), e.g. Amber NetCDF (NC).
- "MDAnalysis has no trajectory reader for the format ...": only for jobs made before the format
  list existed. Use **Edit and run again** and leave the format on automatic detection.
- "could not read the topology ...: MDAnalysis has no topology reader for the format ...": the
  topology's file extension is not one MDAnalysis reads; use a PSF, PRMTOP/PARM7, GRO, TPR or PDB
  file.
- "could not read <file> as <format>: ...": the file is not in the format its name (or the
  **Trajectory format** option) says, e.g. "could not read junk.trj (uploaded) as TRJ: it is not
  a text file". Check that it is the right file, or give its real format:

  ![Reader error](img/job-failed-reader.png)
- "need one label per analysed frame (N), got (M,)": the labels file has the wrong length for
  the chosen frames.
- "could not download PDB entry XXXX from RCSB": check the PDB ID.

## 4. The jobs list

**Jobs** lists every job with its state, step, time and validation. Click a job to open it.
Finished jobs can be deleted from their page.

![Jobs list](img/jobs-list.png)

## 5. Stop the server

- **Ctrl-C** in the terminal of `scripts/start_hpg.sh` ends the Slurm job at once.
  - A job that was running is marked failed ("interrupted (server restarted)") the next time
    the server starts.
  - Queued jobs run then.
- To stop it gently, run `scancel --signal=INT <Slurm job id>` from another terminal (the job id
  is in the first line the script printed).
  - A running job is marked failed ("interrupted (server stopped)") at once.
  - Queued jobs wait for the next start.
- When the `--time` limit runs out, Slurm stops the server the same way (not yet tested).

Start it again with `scripts/start_hpg.sh` (the same `--data-dir` if you changed it): your jobs
and uploads are kept, and you get a new link.

## 6. Worked example: GB1 MELD replica

This is the real run of `mdcif/examples/create/1_basic`. All files are on `/blue`, so use
server paths (nothing to upload):
- **Topology:** `/blue/alberto.perezant/t.desilva/mdcif/examples/data/3gb1/meld/3gb1.prmtop`
- **Trajectory:** `/blue/alberto.perezant/t.desilva/mdcif/examples/data/3gb1/meld/meld.nc.001`
  (2 GB)
- **Reference structure:** PDB ID `3GB1`
- **First frame** `25000`, **Step** `10`; everything else default.
- **Provenance:** Import YAML
  `/blue/alberto.perezant/t.desilva/mdcif/examples/create/1_basic/provenance.yaml`.

On an 8-CPU node the build took 10 seconds. It gave a valid file:
- 17683 frames, 56 Cα atoms, 2 models;
- the two models are 2.61 Å and 9.04 Å (Cα RMSD) from PDB 3GB1 model 1;
- its `mdcif info` is identical to that of the tutorial's `gb1_meld_300K.cif`.

## 7. Where your files are

In the data folder (`mdcif-server/data/` unless you gave `--data-dir`):
- `jobs/<job id>/`: the outputs of each job, plus its own copy of the files you uploaded;
- `uploads/`: files uploaded from the form. They are deleted when you replace or clear them in
  the form, or press **Clear form**.

Delete jobs you no longer need from their page.

Files in the data folder can be read by members of the `alberto.perezant` group. The access token
is not stored there.

## 8. Not yet tested

- The SSH tunnel and VS Code port forwarding (section 2), and upload speed through the tunnel.
  Uploads of a 100 MB file took under a second on the node itself.
- In the form: **Add trajectory**, the **Labels** file, typing a reference **PDB ID**, the
  Reference **Server path** and **Reset to defaults**. The server side of each of these, except
  Reset, works.
- The server being stopped by the `--time` limit.
- Browsers on your own computer: the pages were checked in Chrome on the cluster, at 1280 and
  390 pixels wide.
