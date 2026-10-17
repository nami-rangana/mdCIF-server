/* The provenance form, built from GET /api/provenance/template:
 * structure and defaults from `provenance`, help texts from `help`, the star marks from
 * `recommended`. Import YAML = parse endpoint, Export YAML = yaml endpoint + a Blob download.
 */

import { post } from "./api.js";
import { clear, field, h, notice, starMark, uid } from "./dom.js";

const SECTIONS = {
  dataset: ["Dataset", "Who made the data and where the full trajectory lives."],
  system: ["System", "What was simulated."],
  simulation: ["Simulation", "How it was simulated."],
  analysis: ["Analysis", "Which frames and atoms the analysis used."],
  clustering: ["Clustering", "How the frames were grouped into models."],
  modes: ["Modes", "Essential dynamics stored with each model."],
};

const LABELS = {
  "dataset.title": "Title", "dataset.authors": "Authors",
  "dataset.trajectory_doi": "Trajectory DOI", "dataset.trajectory_database": "Trajectory database",
  "dataset.trajectory_accession": "Accession in that database",
  "system.name": "System name", "system.source_structure": "Starting structure",
  "system.reference_PDB_id": "Reference PDB ID", "system.composition": "Composition",
  "simulation.engine": "MD engine", "simulation.engine_version": "Engine version",
  "simulation.force_field": "Force field", "simulation.water_model": "Water model",
  "simulation.ensemble": "Ensemble", "simulation.temperature_K": "Temperature (K)",
  "simulation.pressure_bar": "Pressure (bar)", "simulation.timestep_fs": "Time step (fs)",
  "simulation.length_ns": "Length per replica (ns)", "simulation.n_replicas": "Replicas",
  "simulation.enhanced_sampling": "Enhanced sampling",
  "simulation.save_interval_ps": "Save interval (ps)", "simulation.details": "Details",
  "analysis.frames_used": "Frames used", "analysis.alignment_selection": "Alignment atoms",
  "clustering.software": "Software", "clustering.method": "Method", "clustering.feature": "Feature",
  "clustering.selection": "Clustering atoms", "clustering.n_clusters": "Number of clusters",
  "clustering.cutoff_angstrom": "Cutoff (Å)", "clustering.n_models_deposited": "Models deposited",
  "modes.method": "Method", "modes.selection": "Mode atoms", "modes.mass_weighted": "Mass-weighted",
  "modes.n_modes": "Modes per model", "modes.per_cluster": "Modes per cluster",
};

/* integer fields (the template can't tell 3 from 3.0 or null) and their lower bounds */
const INTS = { "simulation.n_replicas": 1, "modes.n_modes": 1,
               "clustering.n_clusters": null, "clustering.n_models_deposited": null };

const SUGGEST = {
  "simulation.engine": ["GROMACS", "AMBER", "OpenMM", "NAMD", "CHARMM", "Desmond", "LAMMPS"],
  "simulation.ensemble": ["NVE", "NVT", "NPT", "NPAT"],
  "simulation.enhanced_sampling": ["none", "REMD", "metadynamics", "GaMD", "umbrella sampling"],
  "modes.method": ["PCA", "quasi-harmonic"],
  "clustering.method": ["HDBSCAN"],
};

const PLACEHOLDER = {
  "clustering.n_clusters": "filled in by the build",
  "clustering.n_models_deposited": "filled in by the build",
  "dataset.authors": "Last, F.\nOther, A. B.",
  "dataset.trajectory_doi": "10.5281/zenodo....",
  "system.reference_PDB_id": "e.g. 4AKE",
};

const PDB_RE = /^[0-9][A-Za-z0-9]{3}$/;
const FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const INT_RE = /^[+-]?\d+$/;

export function createProvenanceForm({ template, errors }) {
  const defaults = template.provenance;
  const help = template.help || {};
  const recommended = new Set(template.recommended || []);
  const inputs = new Map();                  // path -> {kind, el}
  const msgBox = h("div", { class: "prov-msg" });

  const sections = [];
  for (const [sec, fields] of Object.entries(defaults)) {
    const [title, blurb] = SECTIONS[sec] || [sec, ""];
    const grid = h("div", { class: "grid" });
    for (const [name, def] of Object.entries(fields)) {
      const path = `${sec}.${name}`;
      grid.append(makeField(path, def));
    }
    const nRec = Object.keys(fields).filter((n) => recommended.has(`${sec}.${n}`)).length;
    sections.push(h("details", { class: "prov-section", open: ["dataset", "system", "simulation"].includes(sec) },
      h("summary", null, h("span", { class: "summary-title", text: title }),
        h("span", { class: "muted", text: nRec ? ` · ${nRec} recommended` : "" })),
      blurb ? h("p", { class: "help", text: blurb }) : null,
      grid));
  }

  function makeField(path, def) {
    const id = uid("prov");
    const kind = Array.isArray(def) ? "list" : typeof def === "boolean" ? "bool"
      : path in INTS ? "int" : def === null || typeof def === "number" ? "float"
        : path === "simulation.details" ? "text" : "str";
    let control;
    if (kind === "list" || kind === "text") {
      control = h("textarea", { id, rows: 3, spellcheck: kind === "text" ? "true" : "false",
                                placeholder: PLACEHOLDER[path] || null });
    } else if (kind === "bool") {
      control = h("input", { type: "checkbox", id });
    } else {
      const list = SUGGEST[path] ? `${id}-list` : null;
      control = h("input", { type: "text", id, autocomplete: "off", spellcheck: "false",
                             inputmode: kind === "int" ? "numeric" : kind === "float" ? "decimal" : null,
                             list, placeholder: PLACEHOLDER[path] || (kind === "float" || kind === "int" ? "empty = not given" : null),
                             class: kind === "int" || kind === "float" ? "num" : null });
    }
    inputs.set(`provenance.${path}`, { kind, el: control, path });
    let text = help[path] || "";
    if (kind === "list") text = `${text} One per line.`.trim();
    const datalist = SUGGEST[path] ? h("datalist", { id: `${id}-list` },
      SUGGEST[path].map((v) => h("option", { value: v }))) : null;
    if (kind === "bool") {
      const errEl = h("p", { class: "field-error", id: `${id}-err`, hidden: true });
      const helpEl = h("p", { class: "help", id: `${id}-help`, text });
      control.setAttribute("aria-describedby", `${id}-help ${id}-err`);
      const wrap = h("div", { class: "field field-check" },
        h("span", { class: "check" }, control,
          h("label", { for: id }, LABELS[path] || path, recommended.has(path) ? starMark() : null)),
        helpEl, errEl);
      errors.add(`provenance.${path}`, { errEl, input: control, wrapper: wrap });
      return wrap;
    }
    return field({ id, label: LABELS[path] || path.split(".")[1].replace(/_/g, " "), help: text,
                   star: recommended.has(path), control, after: datalist,
                   path: `provenance.${path}`, errors,
                   cls: kind === "text" || kind === "list" || path === "dataset.title" ? "field-wide" : null });
  }

  /* floats: the paths whose value is a float (the parse endpoint's `floats`): JSON numbers
   * can't tell 300.0 from 300, and mdcif writes them differently (300.000 vs 300) */
  function fill(prov, floats) {
    const isFloat = new Set(floats || []);
    for (const { kind, el, path } of inputs.values()) {
      const [sec, name] = path.split(".");
      const v = prov && prov[sec] ? prov[sec][name] : undefined;
      if (v === undefined) continue;
      if (kind === "bool") el.checked = Boolean(v);
      else if (kind === "list") el.value = (Array.isArray(v) ? v : [v]).join("\n");
      else if (typeof v === "number" && isFloat.has(path) && /^-?\d+$/.test(String(v))) {
        el.value = `${v}.0`;
      } else el.value = v == null ? "" : String(v);
    }
  }

  /* -> {value, errors: {path: msg}}. Integer fields are JSON numbers; the other number fields
   * are the text typed (the server reads "300.0" as a float and "300" as an integer) */
  function collect() {
    const value = {};
    const errs = {};
    for (const [full, { kind, el, path }] of inputs) {
      const [sec, name] = path.split(".");
      value[sec] = value[sec] || {};
      let v;
      if (kind === "bool") v = el.checked;
      else if (kind === "list") v = el.value.split("\n").map((s) => s.trim()).filter(Boolean);
      else if (kind === "int" || kind === "float") {
        const s = el.value.trim();
        if (!s) v = null;
        else if (kind === "int" && !INT_RE.test(s)) {
          errs[full] = "Must be a whole number.";
          continue;
        } else if (kind === "float" && !FLOAT_RE.test(s)) {
          errs[full] = "Must be a number.";
          continue;
        } else if (kind === "float") {
          v = s;
        } else {
          v = Number(s);
          const min = INTS[path];
          if (min != null && v < min) {
            errs[full] = `Must be at least ${min}.`;
            continue;
          }
        }
      } else v = el.value.trim();
      if (path === "system.reference_PDB_id" && v && !PDB_RE.test(v)) {
        errs[full] = "Must be empty or a 4-character PDB ID (e.g. 4AKE); give a reference file under Files instead.";
        continue;
      }
      value[sec][name] = v;
    }
    return { value, errors: errs };
  }

  function showMessage(kind, ...children) {
    clear(msgBox).append(notice(kind, ...children));
  }

  /* -- Import / Export */
  const importInput = h("input", { type: "file", id: uid("prov-import"), class: "file-native",
                                   accept: ".yaml,.yml,text/yaml,text/plain" });
  importInput.addEventListener("change", async () => {
    const f = importInput.files && importInput.files[0];
    importInput.value = "";
    if (!f) return;
    clear(msgBox);
    errors.clear();
    let text;
    try {
      text = await f.text();
    } catch {
      showMessage("error", `Could not read ${f.name}.`);
      return;
    }
    try {
      const res = await post("/api/provenance/parse", { yaml: text });
      fill(res.provenance, res.floats);
      const warnings = res.warnings || [];
      if (warnings.length) {
        showMessage("warn", h("p", { text: `Imported ${f.name}, with ${warnings.length} warning(s):` }),
          h("ul", null, warnings.map((w) => h("li", { text: w }))));
      } else {
        showMessage("ok", `Imported ${f.name}.`);
      }
    } catch (e) {
      const unmatched = errors.show(remapYamlFields(e.fields));
      showMessage("error", h("p", { text: `${f.name}: ${e.message}` }),
        unmatched.length ? h("ul", null, unmatched.map(([p, m]) => h("li", { text: `${p}: ${m}` }))) : null);
    }
  });

  async function exportYaml() {
    clear(msgBox);
    errors.clear();
    const { value, errors: errs } = collect();
    if (Object.keys(errs).length) {
      errors.show(errs);
      showMessage("error", "Fix the marked fields first.");
      return;
    }
    try {
      const res = await post("/api/provenance/yaml", { provenance: value });
      const blob = new Blob([res.yaml], { type: "text/yaml" });
      const url = URL.createObjectURL(blob);
      const a = h("a", { href: url, download: "provenance.yaml", hidden: true });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      showMessage("ok", "Saved provenance.yaml.");
    } catch (e) {
      const unmatched = errors.show(e.fields);
      showMessage("error", e.message,
        unmatched.length ? h("ul", null, unmatched.map(([p, m]) => h("li", { text: `${p}: ${m}` }))) : null);
    }
  }

  function reset() {
    fill(defaults);
    clear(msgBox);
  }

  const el = h("div", { class: "prov" },
    h("div", { class: "prov-tools" },
      h("p", { class: "help prov-note" },
        "No field is required: an empty provenance still gives a valid file. Fields marked ",
        h("span", { class: "star", "aria-hidden": "true", text: "★" }),
        " are recommended: they describe your data in the file."),
      h("div", { class: "btn-row" },
        importInput,
        h("label", { for: importInput.id, class: "btn" }, "Import YAML..."),
        h("button", { type: "button", class: "btn", onclick: exportYaml }, "Export YAML"),
        h("button", { type: "button", class: "btn btn-quiet", onclick: reset }, "Reset to defaults"))),
    msgBox, sections);
  fill(defaults);
  return { el, collect, fill, reset };
}

/* parse/yaml answer field paths as provenance.<section>.<field>; keep them as they are, but
 * accept a bare <section>.<field> too */
function remapYamlFields(fields) {
  const out = {};
  for (const [p, m] of Object.entries(fields || {})) {
    out[p.startsWith("provenance.") ? p : `provenance.${p}`] = m;
  }
  return out;
}
