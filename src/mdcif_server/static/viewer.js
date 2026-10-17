/* 3D view of a job's deposited models (3Dmol.js, loaded on demand from the one allowed CDN).
 *
 * The .cif has one _atom_site block for all models (pdbx_PDB_model_num / ihm_model_id). With
 * 3Dmol's addModels each model becomes its own 3Dmol model; if the count does not match the
 * job's n_models, the rows are split per model here and each is added on its own (as mdcif's
 * view.py does). Colours are mdcif's landscape palette.
 */

import { getText } from "./api.js";
import { clear, fmtPct, h } from "./dom.js";

const SRC = "https://cdn.jsdelivr.net/npm/3dmol@2.5.4/build/3Dmol-min.js";
const SRI = "sha384-aw5iA7iFqZo5E4v4mDoyQO2m9ySnonvy7DIAJCoNdzKYfB5xSzH/gz2LrPWYVg+5";
export const SERIES = ["#2a78d6", "#eb6834", "#1baf7a"];
export const OTHER = "#8c8b86";

export function modelColor(i) {
  return i < SERIES.length ? SERIES[i] : OTHER;
}

let loading = null;

export function load3Dmol(timeoutMs = 30000) {
  if (window.$3Dmol) return Promise.resolve(window.$3Dmol);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    const fail = (msg) => {
      clearTimeout(timer);
      loading = null;
      s.remove();
      reject(new Error(msg));
    };
    const timer = setTimeout(() => fail("timed out"), timeoutMs);
    s.src = SRC;
    s.async = true;
    s.crossOrigin = "anonymous";
    s.integrity = SRI;
    s.referrerPolicy = "no-referrer";
    s.onload = () => {
      clearTimeout(timer);
      if (window.$3Dmol) resolve(window.$3Dmol);
      else fail("it loaded but did not start");
    };
    s.onerror = () => fail("it could not be downloaded");
    document.head.append(s);
  });
  return loading;
}

/* ------------------------------------------------------------------ mmCIF splitting */

const TOKEN_RE = /'(?:[^']|'(?=\S))*'(?=\s|$)|"(?:[^"]|"(?=\S))*"(?=\s|$)|\S+/g;

/* Split the _atom_site loop of an mmCIF text per model -> [{model, text}] (null if no loop). */
export function splitModels(cif) {
  const lines = cif.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !(lines[i].trim() === "loop_" && (lines[i + 1] || "").trim().startsWith("_atom_site."))) {
    i += 1;
  }
  if (i >= lines.length) return null;
  i += 1;
  const cols = [];
  while (i < lines.length && lines[i].trim().startsWith("_atom_site.")) {
    cols.push(lines[i].trim().split(/\s+/)[0]);
    i += 1;
  }
  let key = cols.indexOf("_atom_site.pdbx_PDB_model_num");
  if (key < 0) key = cols.indexOf("_atom_site.ihm_model_id");
  if (key < 0) return null;
  const groups = new Map();
  let tokens = [];
  for (; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (!t) continue;
    if (t.startsWith("#") || t === "loop_" || t.startsWith("_") || t.startsWith("data_")) break;
    tokens = tokens.concat(t.match(TOKEN_RE) || []);
    while (tokens.length >= cols.length) {
      const row = tokens.slice(0, cols.length);
      tokens = tokens.slice(cols.length);
      const m = row[key];
      if (!groups.has(m)) groups.set(m, []);
      groups.get(m).push(row.join(" "));
    }
  }
  const head = `loop_\n${cols.join("\n")}\n`;
  return [...groups.entries()].map(([model, rows]) => ({
    model, text: `data_model_${model}\n${head}${rows.join("\n")}\n#\n`,
  }));
}

/* ------------------------------------------------------------------ the viewer */

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/* Mount the viewer in `container`. job: the Job object (succeeded). Returns {destroy}. */
export function mountViewer(container, job) {
  const state = { viewer: null, destroyed: false, ro: null };
  const cif = (job.outputs || []).find((o) => o.kind === "cif");
  const models = (job.result && job.result.models) || [];
  const nModels = job.result ? job.result.n_models : models.length;
  const status = h("p", { class: "viewer-status muted", role: "status", text: "Loading the 3D viewer..." });
  clear(container).append(status);

  if (!cif) {
    status.className = "notice notice-info";
    status.textContent = "The 3D view needs the .cif output; this job wrote only .bcif. "
      + "Download the .bcif and open it in Mol* or ChimeraX, or run the job again with output .cif or both.";
    container.dataset.viewer = "no-cif";
    return { destroy() {} };
  }

  (async () => {
    let lib;
    let text;
    try {
      [lib, text] = await Promise.all([
        load3Dmol().catch((e) => {
          throw new Error(`3Dmol.js (from cdn.jsdelivr.net) is not available: ${e.message}. `
            + "Without internet access the 3D view can't load; the files below can still be downloaded.");
        }),
        getText(cif.url).catch((e) => {
          throw new Error(`Could not fetch ${cif.name}: ${e.message}`);
        }),
      ]);
    } catch (e) {
      if (state.destroyed) return;
      status.className = "notice notice-warn";
      status.textContent = e.message;
      container.dataset.viewer = "error";
      return;
    }
    if (state.destroyed) return;
    const stage = h("div", { class: "viewer-canvas", role: "img",
                             "aria-label": `3D cartoon of the ${nModels} deposited models` });
    const controls = h("div", { class: "viewer-models" });
    container.classList.add("has-canvas");      // final layout before 3Dmol measures the canvas
    clear(container).append(stage, controls);
    let v;
    try {
      v = lib.createViewer(stage, { backgroundColor: cssVar("--viewer-bg", "#ffffff"), antialias: true });
    } catch (e) {
      container.classList.remove("has-canvas");
      clear(container).append(h("p", { class: "notice notice-warn",
        text: `The 3D viewer could not start (WebGL unavailable?): ${e.message}` }));
      container.dataset.viewer = "error";
      return;
    }
    state.viewer = v;
    let ms = [];
    let how = "3dmol";
    try {
      ms = v.addModels(text, "cif") || [];
    } catch {
      ms = [];
    }
    const ok = ms.length === nModels && ms.every((m) => m.selectedAtoms({}).length > 0);
    if (!ok) {
      v.removeAllModels();
      const parts = splitModels(text) || [];
      ms = parts.map((p) => v.addModel(p.text, "cif"));
      how = "split";
    }
    if (!ms.length) {
      container.classList.remove("has-canvas");
      clear(container).append(h("p", { class: "notice notice-warn",
        text: `No models found in ${cif.name}.` }));
      container.dataset.viewer = "error";
      return;
    }
    container.dataset.models = String(ms.length);
    container.dataset.parsed = how;
    container.dataset.atoms = ms.map((m) => m.selectedAtoms({}).length).join(",");

    const shown = ms.map(() => true);
    const style = (i) => {
      ms[i].setStyle({}, shown[i] ? { cartoon: { color: modelColor(i) } } : {});
    };
    ms.forEach((_, i) => style(i));
    v.zoomTo();
    v.render();

    const boxes = ms.map((_, i) => {
      const info = models[i];
      const id = `viewer-model-${i + 1}`;
      const label = info
        ? `Model ${info.model}: ${info.frames} frames (${fmtPct(info.fraction)})`
        : `Model ${i + 1}`;
      const box = h("input", { type: "checkbox", id, checked: true, onchange: (ev) => {
        shown[i] = ev.target.checked;
        style(i);
        v.render();
      } });
      return h("span", { class: "check model-check" }, box,
        h("label", { for: id }, h("span", { class: "swatch", style: { background: modelColor(i) },
                                            "aria-hidden": "true" }), label));
    });
    const setAll = (on) => {
      ms.forEach((_, i) => {
        shown[i] = on;
        style(i);
      });
      for (const b of controls.querySelectorAll("input[type=checkbox]")) b.checked = on;
      v.render();
    };
    controls.append(
      h("div", { class: "viewer-list" }, boxes),
      h("div", { class: "btn-row" },
        h("button", { type: "button", class: "btn btn-small", onclick: () => setAll(true) }, "Show all"),
        h("button", { type: "button", class: "btn btn-small", onclick: () => setAll(false) }, "Hide all"),
        h("button", { type: "button", class: "btn btn-small", onclick: () => {
          v.zoomTo();
          v.render();
        } }, "Reset view")),
      h("p", { class: "help", text: "Drag to rotate, scroll or pinch to zoom. Colours match the landscape plot." }));
    if (window.ResizeObserver) {
      state.ro = new ResizeObserver(() => {
        if (state.viewer) {
          state.viewer.resize();
          state.viewer.render();
        }
      });
      state.ro.observe(stage);
    }
    container.dataset.viewer = "ready";
  })();

  return {
    destroy() {
      state.destroyed = true;
      if (state.ro) state.ro.disconnect();
      if (state.viewer) {
        try {
          state.viewer.clear();
        } catch {
          /* already gone */
        }
        state.viewer = null;
      }
    },
  };
}
