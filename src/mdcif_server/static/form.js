/* The New job page: files, build options, provenance, submit.
 *
 * The form is built once and kept while the user visits other pages, so running uploads go on
 * and the values stay for the next job.
 */

import { get, getText, post } from "./api.js";
import { clear, confirmDialog, FieldErrors, field, h, notice, reveal, uid } from "./dom.js";
import { createFileInput } from "./fileinput.js";
import { createProvenanceForm } from "./provenance.js";

/* Every option of `mdcif build`: type, constraint, help. The values themselves
 * come from config.defaults.options. */
const OPTIONS = {
  start: { label: "First frame", type: "int",
           help: "First frame used (0-based, e.g. to skip equilibration). Negative counts from the end." },
  stop: { label: "Stop before frame", type: "int", nullable: true, placeholder: "default: to the end",
          help: "Stop before this frame (empty = to the end)." },
  step: { label: "Step", type: "int", min: 1, help: "Use every step-th frame." },
  selection: { label: "Analysis atoms", type: "str", nullable: true, max: 1000, wide: true,
               placeholder: "default: from the provenance (name CA)",
               help: "Analysis atoms, as an MDAnalysis selection (default: provenance modes.selection, 'name CA')." },
  deposit_selection: { label: "Deposited atoms", type: "str", max: 1000, wide: true,
                       help: "Atoms written for each model (MDAnalysis selection)." },
  format: { label: "Trajectory format", type: "format", nullable: true,
            help: "Leave on automatic unless detection fails." },
  features: { label: "Clustered features", type: "enum", values: [["pca", "PCA projection"], ["cartesian", "Cartesian coordinates"]],
              hdbscan: true, help: "What HDBSCAN clusters: pca | cartesian." },
  n_pcs: { label: "Global PCs", type: "int", min: 1, hdbscan: true,
           help: "Number of global PCs HDBSCAN clusters on." },
  min_cluster_size: { label: "Smallest cluster (frames)", type: "int", nullable: true, min: 2, hdbscan: true,
                      placeholder: "default: 1% of frames, at least 25",
                      help: "HDBSCAN: smallest cluster, in frames (default: 1% of the frames, at least 25). Short trajectories need a smaller value (the 98-frame AdK test: 5)." },
  min_samples: { label: "Min samples", type: "int", nullable: true, min: 1, hdbscan: true,
                 placeholder: "default: min_cluster_size",
                 help: "HDBSCAN: density smoothing (default: min_cluster_size)." },
  cluster_selection: { label: "Cluster selection", type: "enum", hdbscan: true,
                       values: [["eom", "eom: fewer, larger clusters"], ["leaf", "leaf: finer substates"]],
                       help: "HDBSCAN: eom (fewer, larger clusters) | leaf (finer substates)." },
  max_models: { label: "Most models deposited", type: "int", nullable: true, min: 1,
                placeholder: "default: every cluster",
                help: "Deposit only the N most populated clusters." },
  labels_method: { label: "Labels method", type: "str", nullable: true, max: 200, labelsOnly: true,
                   placeholder: "default: from the provenance",
                   help: "Name of the algorithm behind your labels (default: provenance clustering.method). Used only with a labels file." },
  n_modes: { label: "Modes per model", type: "int", nullable: true, min: 1,
             placeholder: "default: from the provenance (3)",
             help: "Essential modes per model (default: provenance modes.n_modes, 3)." },
  mass_weighted: { label: "Mass-weighted modes", type: "tristate",
                   help: "Quasi-harmonic (mass-weighted) modes (default: provenance modes.mass_weighted)." },
  anm: { label: "Compare with ANM modes", type: "bool",
         help: "Report the cumulative overlap of each cluster's modes with the 10 lowest ANM modes of its medoid." },
  max_projection_points: { label: "Projection points", type: "int", min: 0,
                           help: "Frames stored in _mdcif_projection (regular subsample; 0 = none)." },
};

/* The choices of the format option: common MDAnalysis formats, by the canonical keys of
 * the server's formats.py. "Other..." takes
 * any name; the server normalises aliases (netcdf -> NC) and refuses unknown ones. */
const FORMATS = [
  ["NC", "Amber NetCDF (NC)"],
  ["DCD", "CHARMM / NAMD / OpenMM DCD"],
  ["XTC", "GROMACS XTC"],
  ["TRR", "GROMACS TRR"],
  ["TNG", "GROMACS TNG"],
  ["MDCRD", "Amber ASCII trajectory (MDCRD)"],
  ["H5MD", "H5MD"],
  ["LAMMPSDUMP", "LAMMPS dump (LAMMPSDUMP)"],
  ["PDB", "Multi-model PDB"],
  ["GRO", "GROMACS GRO"],
  ["XYZ", "XYZ"],
];
const OTHER_FORMAT = "other";
/* Other names of the listed formats that an earlier job may hold (e.g. "NetCDF" typed by
 * hand): the same aliases as the server's formats.py. */
const FORMAT_ALIASES = {
  NCDF: "NC", NETCDF: "NC", NETCDF3: "NC", "AMBER NETCDF": "NC", "AMBER NC": "NC", "AMBER NCDF": "NC",
  "CHARMM DCD": "DCD", "NAMD DCD": "DCD", "OPENMM DCD": "DCD",
  "GROMACS XTC": "XTC", "GROMACS TRR": "TRR", "GROMACS TNG": "TNG", "GROMACS GRO": "GRO",
  TRJ: "MDCRD", CRDBOX: "MDCRD", CRD: "MDCRD", "AMBER MDCRD": "MDCRD", "AMBER TRJ": "MDCRD",
  "AMBER CRD": "MDCRD", "AMBER ASCII": "MDCRD",
  "LAMMPS DUMP": "LAMMPSDUMP", LAMMPSTRJ: "LAMMPSDUMP", ENT: "PDB",
};

/* Show a format value in the select (+ the Other box): "" = automatic, a listed format (or one
 * of its aliases, normalised as the server does), else Other... with the text. */
function setFormat(o, v) {
  const text = v == null ? "" : String(v).trim();
  const name = text.replace(/^\.+/, "").replace(/[\s_\-/]+/g, " ").trim().toUpperCase();
  const key = FORMAT_ALIASES[name] || FORMAT_ALIASES[name.replace(/ /g, "")] || name.replace(/ /g, "");
  if (!name) o.el.value = "";
  else if (FORMATS.some(([k]) => k === key)) o.el.value = key;
  else o.el.value = OTHER_FORMAT;
  o.other.value = o.el.value === OTHER_FORMAT ? text : "";
  o.other.hidden = o.el.value !== OTHER_FORMAT;
}

const BASIC = [["Frames", ["start", "stop", "step"]], ["Clustering", ["min_cluster_size"]]];
const ADVANCED = [
  ["Atoms", ["selection", "deposit_selection", "format"]],
  ["Clustering", ["features", "n_pcs", "min_samples", "cluster_selection", "max_models", "labels_method"]],
  ["Modes", ["n_modes", "mass_weighted", "anm"]],
  ["Output", ["max_projection_points"]],
];

const INT_RE = /^[+-]?\d+$/;

let page = null;                             // the form, built once
let pending = null;                          // a job whose settings the form takes next

export async function renderNewJob(main, { config }) {
  if (!page) {
    const template = await get("/api/provenance/template").catch((e) => ({ error: e }));
    page = buildPage(config, template);
  }
  clear(main).append(page.el);
  if (pending) {
    const job = pending;
    pending = null;
    await page.load(job);
  }
  page.refresh();
}

/* "Edit and run again": the next New job page is filled from this Job object (its request). */
export function editJob(job) {
  pending = job;
}

export function anyUploadBusy() {
  return Boolean(page && page.busy());
}

function buildPage(config, template) {
  const errors = new FieldErrors();
  const defaults = (config.defaults && config.defaults.options) || {};
  const optionInputs = new Map();            // key -> {meta, el(s), wrapper}

  /* ---------------------------------------------------------------- job */
  const nameId = uid("name");
  const nameEl = h("input", { type: "text", id: nameId, maxlength: 100, autocomplete: "off",
                              placeholder: "e.g. AdK test" });
  const jobSection = h("section", { class: "card", "aria-labelledby": "sec-job" },
    h("h2", { id: "sec-job", text: "Job" }),
    h("div", { class: "grid" },
      field({ id: nameId, label: "Name", control: nameEl, path: "name", errors, cls: "field-wide",
              help: "Shown in the job list; also names the output files (\"AdK test\" gives AdK_test.cif)." })));

  /* ---------------------------------------------------------------- files */
  let built = false;                         // the labels input fires onChange while it is built
  const onLabelsChange = () => {
    if (built) updateLabelsMode();
  };
  const topology = createFileInput({
    label: "Topology", config, errors, path: "inputs.topology",
    help: "Any topology MDAnalysis reads: PSF, PRMTOP/PARM7, GRO, TPR, PDB, ...",
  });
  const trajRows = [];
  const trajList = h("div", { class: "traj-list" });
  const addTrajBtn = h("button", { type: "button", class: "btn", onclick: () => addTraj(true) },
    "Add trajectory");
  function addTraj(focus) {
    if (trajRows.length >= 100) return;
    const removeBtn = h("button", { type: "button", class: "btn btn-small btn-quiet" }, "Remove");
    const fi = createFileInput({ label: "Trajectory", config, errors, path: null, extraHead: removeBtn,
                                 browseTitle: "Choose a trajectory file" });
    const row = { fi, removeBtn };
    removeBtn.addEventListener("click", () => {
      const i = trajRows.indexOf(row);
      if (i < 0 || trajRows.length === 1) return;
      trajRows.splice(i, 1);
      fi.destroy();
      fi.el.remove();
      renumberTraj();
      (trajRows[Math.min(i, trajRows.length - 1)].removeBtn).focus();
    });
    trajRows.push(row);
    trajList.append(fi.el);
    renumberTraj();
    if (focus) fi.el.querySelector("input[type=radio]:checked")?.focus();
  }
  function renumberTraj() {
    for (const r of trajRows) r.fi.setPath(null);
    trajRows.forEach((r, i) => {
      r.fi.setPath(`inputs.trajectories.${i}`);
      r.fi.el.querySelector(".fi-label").firstChild.textContent = `Trajectory ${i + 1}`;
      r.removeBtn.hidden = trajRows.length === 1;
      r.removeBtn.setAttribute("aria-label", `Remove trajectory ${i + 1}`);
    });
    addTrajBtn.disabled = trajRows.length >= 100;
  }
  addTraj(false);
  const labels = createFileInput({
    label: "Labels", optional: true, config, errors, path: "inputs.labels", onChange: onLabelsChange,
    help: "Your own clustering instead of HDBSCAN: one integer label per analysed frame (after start/stop/step), -1 = noise; .npy, or text with one label per line.",
  });
  const reference = createFileInput({
    label: "Reference structure", optional: true, allowPdb: true, config, errors, path: "inputs.reference",
    help: "Experimental structure of the same molecule: a PDB ID, or a PDBx/mmCIF (.cif) or BinaryCIF (.bcif) file. Its entity, chains, source and citations are reused, the models are superposed on it and their RMSD is recorded. Empty: the provenance's reference PDB ID, if any.",
  });
  const filesSection = h("section", { class: "card", "aria-labelledby": "sec-files" },
    h("h2", { id: "sec-files", text: "Files" }),
    h("p", { class: "help", text: "Upload each file from this computer, or give the path of a file already on the server (/blue). Large trajectories: use the server path." }),
    topology.el,
    h("div", { class: "traj-block" },
      h("h3", { text: "Trajectories" }),
      h("p", { class: "help", text: "One file per replica; they are read back to back, in this order." }),
      trajList, addTrajBtn),
    labels.el, reference.el);

  /* ---------------------------------------------------------------- options */
  function optionField(key) {
    const meta = OPTIONS[key];
    const id = uid(`opt-${key}`);
    const def = defaults[key];
    let control;
    let other = null;
    if (meta.type === "format") {
      control = h("select", { id },
        h("option", { value: "", text: "Detect automatically (recommended)" }),
        FORMATS.map(([v, t]) => h("option", { value: v, text: t })),
        h("option", { value: OTHER_FORMAT, text: "Other..." }));
      other = h("input", { type: "text", id: `${id}-other`, class: "mono format-other", maxlength: 64,
                           autocomplete: "off", spellcheck: "false", hidden: true,
                           "aria-label": "Other trajectory format (MDAnalysis name)",
                           placeholder: "MDAnalysis format name, e.g. TRZ" });
      control.addEventListener("change", () => {
        other.hidden = control.value !== OTHER_FORMAT;
        if (!other.hidden) other.focus();
      });
    } else if (meta.type === "enum") {
      control = h("select", { id, value: def == null ? meta.values[0][0] : def },
        meta.values.map(([v, t]) => h("option", { value: v, text: t })));
    } else if (meta.type === "tristate") {
      control = h("select", { id, value: def == null ? "" : String(def) },
        h("option", { value: "", text: "default: from the provenance" }),
        h("option", { value: "true", text: "yes: quasi-harmonic modes" }),
        h("option", { value: "false", text: "no: plain PCA" }));
    } else if (meta.type === "bool") {
      control = h("input", { type: "checkbox", id, checked: Boolean(def) });
    } else {
      control = h("input", { type: "text", id, autocomplete: "off", spellcheck: "false",
                             inputmode: meta.type === "int" ? "numeric" : null,
                             class: meta.type === "int" ? "num" : "mono",
                             value: def == null ? "" : String(def), placeholder: meta.placeholder || null });
    }
    optionInputs.set(key, { meta, el: control, other, def });
    if (meta.type === "format") setFormat(optionInputs.get(key), def);
    if (meta.type === "bool") {
      const errEl = h("p", { class: "field-error", id: `${id}-err`, hidden: true });
      control.setAttribute("aria-describedby", `${id}-help ${id}-err`);
      const wrap = h("div", { class: "field field-check" },
        h("span", { class: "check" }, control, h("label", { for: id, text: meta.label })),
        h("p", { class: "help", id: `${id}-help`, text: meta.help }), errEl);
      errors.add(`options.${key}`, { errEl, input: control, wrapper: wrap });
      optionInputs.get(key).wrapper = wrap;
      return wrap;
    }
    const wrap = field({ id, label: meta.label, help: meta.help, control, after: other,
                         path: `options.${key}`, errors, cls: meta.wide ? "field-wide" : null });
    optionInputs.get(key).wrapper = wrap;
    return wrap;
  }

  const fmtName = uid("output_format");
  const fmtErr = h("p", { class: "field-error", id: `${fmtName}-err`, hidden: true });
  const fmtRadios = [["cif", ".cif (text mmCIF)"], ["bcif", ".bcif (BinaryCIF)"], ["both", "both"]].map(([v, t]) => {
    const rid = `${fmtName}-${v}`;
    return h("span", { class: "check" },
      h("input", { type: "radio", name: fmtName, id: rid, value: v,
                   checked: v === (config.defaults?.output_format || "cif") }),
      h("label", { for: rid, text: t }));
  });
  const fmtField = h("fieldset", { class: "field radio-group" },
    h("legend", { text: "Output file" }), h("div", { class: "row" }, fmtRadios),
    h("p", { class: "help", text: "Which file(s) to write. The 3D view on the job page needs the .cif." }), fmtErr);
  errors.add("output_format", { errEl: fmtErr, input: fmtRadios[0].querySelector("input"), wrapper: fmtField });

  const labelsNote = h("p", { class: "notice notice-info", hidden: true,
    text: "A labels file is given: the HDBSCAN options below are not used, and Labels method names your algorithm." });
  const group = (title, keys, extra) => h("fieldset", { class: "opt-group" },
    h("legend", { text: title }), h("div", { class: "grid" }, keys.map(optionField), extra || null));
  const basic = h("div", { class: "opt-basic" },
    BASIC.map(([t, keys]) => group(t, keys)), h("div", { class: "opt-group" }, fmtField));
  const advanced = h("details", { class: "advanced", id: "advanced-options" },
    h("summary", null, h("span", { class: "summary-title", text: "Advanced options" }),
      h("span", { class: "muted", text: " · atoms, clustering, modes, output" })),
    ADVANCED.map(([t, keys]) => group(t, keys)));
  const optionsSection = h("section", { class: "card", "aria-labelledby": "sec-options" },
    h("h2", { id: "sec-options", text: "Build options" }),
    h("p", { class: "help", text: "The options of mdcif build, with its defaults. Leave a field empty to use the default it describes." }),
    labelsNote, basic, advanced);

  function updateLabelsMode() {
    const on = labels.hasValue();
    labelsNote.hidden = !on;
    for (const [, o] of optionInputs) {
      if (o.meta.hdbscan) {
        o.el.disabled = on;
        o.wrapper.classList.toggle("is-disabled", on);
        o.wrapper.querySelector(":scope > label").dataset.why = "unused with labels";
      }
      if (o.meta.labelsOnly) {
        o.el.disabled = !on;
        o.wrapper.classList.toggle("is-disabled", !on);
        o.wrapper.querySelector(":scope > label").dataset.why = "needs a labels file";
      }
    }
  }
  built = true;
  updateLabelsMode();

  /* -> {value, errors} with ints for int fields and null for empty nullable ones */
  function collectOptions() {
    const value = {};
    const errs = {};
    for (const [key, { meta, el, other }] of optionInputs) {
      if (el.disabled) continue;             // HDBSCAN without use, or labels_method without labels
      const path = `options.${key}`;
      if (meta.type === "bool") {
        value[key] = el.checked;
        continue;
      }
      if (meta.type === "tristate") {
        value[key] = el.value === "" ? null : el.value === "true";
        continue;
      }
      if (meta.type === "enum") {
        value[key] = el.value;
        continue;
      }
      if (meta.type === "format") {          // null = detect automatically
        if (el.value !== OTHER_FORMAT) {
          value[key] = el.value || null;
        } else if (!other.value.trim()) {
          errs[path] = "Type the format's MDAnalysis name, or choose one from the list.";
        } else {
          value[key] = other.value.trim();
        }
        continue;
      }
      const s = el.value.trim();
      if (!s) {
        if (meta.nullable) value[key] = null;
        else errs[path] = meta.type === "int" ? "Required: give a whole number." : "Required.";
        continue;
      }
      if (meta.type === "int") {
        if (!INT_RE.test(s) || !Number.isSafeInteger(Number(s))) {
          errs[path] = "Must be a whole number.";
          continue;
        }
        const n = Number(s);
        if (meta.min != null && n < meta.min) {
          errs[path] = `Must be at least ${meta.min}.`;
          continue;
        }
        value[key] = n;
        continue;
      }
      if (meta.max && s.length > meta.max) {
        errs[path] = `At most ${meta.max} characters.`;
        continue;
      }
      if (meta.pattern && !meta.pattern.test(s)) {
        errs[path] = meta.patternMsg;
        continue;
      }
      value[key] = s;
    }
    return { value, errors: errs };
  }

  /* ---------------------------------------------------------------- provenance */
  let prov = null;
  let provBody;
  if (template && !template.error) {
    prov = createProvenanceForm({ template, errors });
    provBody = prov.el;
  } else {
    provBody = notice("error", "Could not load the provenance template: ",
      template && template.error ? template.error.message : "unknown error",
      ". Reload the page to try again.");
  }
  const provSection = h("section", { class: "card", "aria-labelledby": "sec-prov" },
    h("h2", { id: "sec-prov", text: "Provenance" }),
    h("p", { class: "help", text: "Describes the simulation in the file (mdcif's provenance YAML). Import an existing provenance.yaml, or fill in what you know." }),
    provBody);

  /* ---------------------------------------------------------------- submit */
  const submitMsg = h("div", { class: "submit-msg", "aria-live": "polite" });
  const submitBtn = h("button", { type: "submit", class: "btn btn-primary btn-big" }, "Start build");
  const clearBtn = h("button", { type: "button", class: "btn btn-quiet", onclick: async () => {
    const ok = await confirmDialog({ title: "Clear the form?", confirm: "Clear", danger: true,
      message: "Files, options and provenance go back to their defaults. Finished uploads are deleted from the server." });
    if (!ok) return;
    topology.destroy();
    labels.destroy();
    reference.destroy();
    for (const r of trajRows) r.fi.destroy();
    page = null;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } }, "Clear form");
  const submitSection = h("section", { class: "card submit-card" },
    submitMsg, h("div", { class: "btn-row" }, submitBtn, clearBtn));
  const loadMsg = h("div", { "aria-live": "polite" });

  const form = h("form", { class: "new-job", novalidate: true, "aria-label": "New job" },
    loadMsg, jobSection, filesSection, optionsSection, provSection, submitSection);

  /* The job's provenance with 300.0 kept apart from 300 (JSON numbers can't): its own
   * provenance.yaml read back through the parse endpoint, whose `floats` says which fields hold
   * a float. Falls back to job.request.provenance. */
  async function exactProvenance(job) {
    const file = (job.outputs || []).find((o) => o.kind === "provenance");
    if (!file) return null;
    try {
      return await post("/api/provenance/parse", { yaml: await getText(file.url) });
    } catch {
      return null;
    }
  }

  /* fill everything from an earlier job's request (Edit and run again) */
  async function load(job) {
    const exact = prov ? await exactProvenance(job) : null;
    const req = job.request || {};
    const ins = req.inputs || {};
    const res = job.inputs || {};
    errors.clear();
    clear(submitMsg);
    nameEl.value = req.name || "";
    topology.setRef(ins.topology || null, res.topology);
    const trajs = ins.trajectories || [];
    const n = Math.max(1, Math.min(100, trajs.length));
    while (trajRows.length < n) addTraj(false);
    while (trajRows.length > n) {
      const row = trajRows.pop();
      row.fi.setRef(null);
      row.fi.destroy();
      row.fi.el.remove();
    }
    renumberTraj();
    trajRows.forEach((r, i) => r.fi.setRef(trajs[i] || null, (res.trajectories || [])[i]));
    labels.setRef(ins.labels || null, res.labels);
    reference.setRef(ins.reference || null, res.reference);
    const opts = req.options || {};
    for (const [key, o] of optionInputs) {
      const { meta, el } = o;
      const v = key in opts ? opts[key] : defaults[key];
      if (meta.type === "format") setFormat(o, v);
      else if (meta.type === "bool") el.checked = Boolean(v);
      else if (meta.type === "tristate") el.value = v == null ? "" : String(v);
      else if (meta.type === "enum") el.value = v == null ? meta.values[0][0] : v;
      else el.value = v == null ? "" : String(v);
    }
    const fmt = form.querySelector(`input[name="${fmtName}"][value="${req.output_format || "cif"}"]`);
    if (fmt) fmt.checked = true;
    if (prov && exact) prov.fill(exact.provenance, exact.floats);
    else if (prov && req.provenance) prov.fill(req.provenance);
    updateLabelsMode();
    clear(loadMsg).append(notice("info",
      h("p", { class: "strong", text: `Settings of job ${job.name || job.id} loaded.` }),
      h("p", { text: "Files, options and provenance are as in that job (uploads are reused). Change what you need, then Start build." })));
  }

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    clear(submitMsg);
    clear(loadMsg);
    errors.clear();
    const errs = {};
    const name = nameEl.value.trim();
    if (name.length > 100) errs.name = "At most 100 characters.";
    const inputs = { trajectories: [] };
    const take = (fi, path, setter) => {
      const r = fi.getRef();
      if (r.error) errs[path] = r.error;
      else setter(r.ref);
    };
    take(topology, "inputs.topology", (r) => { inputs.topology = r; });
    trajRows.forEach((row, i) => take(row.fi, `inputs.trajectories.${i}`, (r) => inputs.trajectories.push(r)));
    take(labels, "inputs.labels", (r) => { inputs.labels = r; });
    take(reference, "inputs.reference", (r) => { inputs.reference = r; });
    const opts = collectOptions();
    Object.assign(errs, opts.errors);
    let provenance = {};
    if (prov) {
      const p = prov.collect();
      Object.assign(errs, p.errors);
      provenance = p.value;
    }
    const fmt = form.querySelector(`input[name="${fmtName}"]:checked`);
    if (Object.keys(errs).length) {
      errors.show(errs);
      const n = Object.keys(errs).length;
      submitMsg.append(notice("error", `Not submitted: ${n} field${n > 1 ? "s need" : " needs"} attention (marked in red).`));
      return;
    }
    const body = { name, inputs, options: opts.value, provenance, output_format: fmt ? fmt.value : "cif" };
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting...";
    try {
      const job = await post("/api/jobs", body);
      location.hash = `#/jobs/${encodeURIComponent(job.id)}`;
    } catch (e) {
      const unmatched = errors.show(e.fields);
      submitMsg.append(notice("error", h("p", { class: "strong", text: e.message }),
        unmatched.length ? h("ul", null, unmatched.map(([p, m]) => h("li", { text: `${p}: ${m}` }))) : null));
      if (!Object.keys(e.fields || {}).length || unmatched.length === Object.keys(e.fields).length) {
        reveal({ wrapper: submitMsg });
      }
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Start build";
    }
  });

  return {
    el: form,
    load,
    refresh: () => updateLabelsMode(),
    busy: () => [topology, labels, reference, ...trajRows.map((r) => r.fi)].some((fi) => fi.busy()),
  };
}
