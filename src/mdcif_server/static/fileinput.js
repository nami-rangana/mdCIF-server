/* One input file of a job: Upload | Server path (| PDB ID for the reference).
 *
 * Upload starts as soon as a file is chosen (chunked, resumable; api.js). getRef() gives the
 * InputRef of the job request, or an error message for the field.
 */

import { ChunkedUpload, get } from "./api.js";
import { browseServer } from "./browse.js";
import { fmtBytes, h, uid } from "./dom.js";

const PDB_RE = /^[0-9][A-Za-z0-9]{3}$/;

export function createFileInput({ label, help, optional, allowPdb, config, errors, path,
                                  browseTitle, onChange, extraHead }) {
  const id = uid("in");
  const modes = [["upload", "Upload"], ["server", "Server path"]];
  if (allowPdb) modes.push(["pdb", "PDB ID"]);
  let mode = allowPdb ? "pdb" : "upload";
  let upload = null;
  let rejected = "";                         // why the chosen file was refused before uploading
  let currentPath = path;
  const changed = () => onChange && onChange();

  const errEl = h("p", { class: "field-error", id: `${id}-err`, hidden: true });
  const helpEl = help ? h("p", { class: "help", id: `${id}-help`, text: help }) : null;
  const described = [helpEl ? `${id}-help` : null, `${id}-err`].filter(Boolean).join(" ");

  /* -- the mode switch (radio buttons drawn as a segmented control) */
  const seg = h("div", { class: "seg", role: "radiogroup", "aria-labelledby": `${id}-label` });
  for (const [value, text] of modes) {
    const rid = `${id}-mode-${value}`;
    seg.append(
      h("input", { type: "radio", name: `${id}-mode`, id: rid, value, checked: value === mode,
                   onchange: () => setMode(value) }),
      h("label", { for: rid, text }));
  }

  /* -- upload */
  const fileEl = h("input", { type: "file", id: `${id}-file`, class: "file-native",
                              "aria-labelledby": `${id}-label ${id}-choose`,
                              "aria-describedby": described });
  const fileName = h("span", { class: "fi-name", text: "No file chosen" });
  const bar = h("progress", { max: 100, value: 0, "aria-label": `${label} upload progress` });
  const stats = h("span", { class: "fi-stats", "aria-live": "polite" });
  const retryBtn = h("button", { type: "button", class: "btn btn-small", hidden: true,
                                 onclick: () => upload && upload.retry() }, "Retry");
  const progress = h("div", { class: "fi-progress", hidden: true }, bar, stats, retryBtn);
  const clearBtn = h("button", { type: "button", class: "btn btn-small btn-quiet", hidden: true,
                                 "aria-label": "Clear the chosen file",
                                 onclick: () => {
                                   reset();
                                   fileEl.focus();
                                 } }, "Clear");
  const drop = h("div", { class: "fi-drop" },
    fileEl, h("label", { for: `${id}-file`, id: `${id}-choose`, class: "btn" }, "Choose file..."),
    fileName, clearBtn);
  const uploadBody = h("div", { class: "fi-body fi-upload" },
    h("span", { class: "fi-sub", text: "File on this computer (drop it here or choose it)" }),
    drop, progress);
  fileEl.addEventListener("change", () => {
    const f = fileEl.files && fileEl.files[0];
    fileEl.value = "";                        // choosing the same file again fires change again
    if (f) pick(f);
  });
  for (const ev of ["dragenter", "dragover"]) {
    uploadBody.addEventListener(ev, (e) => {
      e.preventDefault();
      uploadBody.classList.add("dragging");
    });
  }
  for (const ev of ["dragleave", "drop"]) {
    uploadBody.addEventListener(ev, () => uploadBody.classList.remove("dragging"));
  }
  uploadBody.addEventListener("drop", (e) => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) pick(f);
  });

  /* -- server path */
  const root = (config.allowed_roots && config.allowed_roots[0]) || "/blue";
  const pathEl = h("input", { type: "text", id: `${id}-path`, class: "mono", autocomplete: "off",
                              spellcheck: "false", placeholder: `${root.replace(/\/$/, "")}/...`,
                              "aria-labelledby": `${id}-label ${id}-pathlabel`,
                              "aria-describedby": described, oninput: changed });
  const browseBtn = h("button", { type: "button", class: "btn", onclick: async () => {
    const p = await browseServer({ title: browseTitle || `Choose the ${label.toLowerCase()}` });
    if (p) {
      pathEl.value = p;
      setError("");
      changed();
    }
    pathEl.focus();
  } }, "Browse...");
  const serverBody = h("div", { class: "fi-body fi-server" },
    h("label", { for: `${id}-path`, id: `${id}-pathlabel`, class: "fi-sub",
                 text: "Absolute path of the file on the server" }),
    h("div", { class: "row" }, pathEl, browseBtn));

  /* -- PDB ID */
  const pdbEl = h("input", { type: "text", id: `${id}-pdb`, class: "mono pdb", maxlength: 4,
                             autocomplete: "off", spellcheck: "false", placeholder: "e.g. 4AKE",
                             "aria-labelledby": `${id}-label ${id}-pdblabel`,
                             "aria-describedby": described, oninput: changed });
  const pdbBody = allowPdb ? h("div", { class: "fi-body fi-pdb" },
    h("label", { for: `${id}-pdb`, id: `${id}-pdblabel`, class: "fi-sub",
                 text: "PDB ID (downloaded from RCSB by the job)" }),
    pdbEl) : null;

  const bodies = { upload: uploadBody, server: serverBody, pdb: pdbBody };
  const el = h("div", { class: "file-input field" },
    h("div", { class: "fi-head" },
      h("span", { class: "fi-label", id: `${id}-label` }, label,
        optional ? h("span", { class: "optional", text: " (optional)" }) : null),
      seg, extraHead || null),
    uploadBody, serverBody, pdbBody, helpEl, errEl);

  function setMode(m) {
    mode = m;
    const radio = seg.querySelector(`input[value="${m}"]`);
    if (radio) radio.checked = true;
    for (const [k, b] of Object.entries(bodies)) if (b) b.hidden = k !== m;
    setError("");
    changed();
  }

  function setError(msg) {
    errEl.textContent = msg || "";
    errEl.hidden = !msg;
    el.classList.toggle("has-error", Boolean(msg));
    for (const input of [fileEl, pathEl, pdbEl]) {
      if (msg) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    }
  }

  function focusTarget() {
    return mode === "upload" ? fileEl : mode === "server" ? pathEl : pdbEl;
  }

  function register(p) {
    if (currentPath) errors.remove(currentPath);
    currentPath = p;
    if (p) {
      errors.add(p, { errEl, wrapper: el, set: setError,
                      focus: () => focusTarget().focus({ preventScroll: true }) });
    }
  }

  /* forget the chosen file (and its upload on the server) */
  function reset() {
    if (upload) upload.discard();
    upload = null;
    rejected = "";
    fileEl.value = "";
    fileName.textContent = "No file chosen";
    progress.hidden = true;
    clearBtn.hidden = true;
    setError("");
    changed();
  }

  function pick(file) {
    if (upload) upload.discard();
    upload = null;
    rejected = "";
    setError("");
    fileName.textContent = `${file.name} (${fmtBytes(file.size)})`;
    progress.hidden = true;
    clearBtn.hidden = false;
    if (file.size === 0) {
      rejected = `${file.name} is empty; choose another file.`;
    } else if (config.max_upload_bytes && file.size > config.max_upload_bytes) {
      rejected = `${file.name} is ${fmtBytes(file.size)}; the server accepts at most `
        + `${fmtBytes(config.max_upload_bytes)} per upload. Give its server path instead.`;
    }
    if (rejected) {
      setError(rejected);
      changed();
      return;
    }
    upload = new ChunkedUpload(file, { chunkSize: config.chunk_size, onUpdate: render });
    progress.hidden = false;
    upload.start();
    render(upload);
    changed();
  }

  function render(u) {
    if (u !== upload) return;
    const pct = Math.floor(100 * u.fraction);
    bar.value = u.done ? 100 : pct;
    retryBtn.hidden = !(u.state === "stalled" || u.state === "error");
    progress.classList.toggle("is-error", u.state === "stalled" || u.state === "error");
    progress.classList.toggle("is-done", u.done);
    const name = u.upload ? u.upload.filename : u.file.name;
    if (u.done) {
      fileName.textContent = `${u.file.name} (${fmtBytes(u.file.size)})`;
      stats.textContent = `Uploaded as ${name}`;
      setError("");
      changed();
    } else if (u.state === "stalled" || u.state === "error") {
      stats.textContent = `Stopped at ${pct}%: ${u.error ? u.error.message : "upload failed"}`;
    } else if (u.state === "creating") {
      stats.textContent = "Starting upload...";
    } else if (u.state === "completing") {
      stats.textContent = "Finishing...";
    } else {
      const speed = u.speed ? ` · ${fmtBytes(u.speed)}/s` : "";
      const retry = u.error ? ` · retrying (${u.error.message})` : "";
      stats.textContent = `${pct}% · ${fmtBytes(u.sent)} of ${fmtBytes(u.file.size)}${speed} · ${name}${retry}`;
    }
  }

  /* Fill from an InputRef of an earlier job's request (info: its ResolvedInput, for the file
   * name). An upload id is reused as it is: uploads stay on the server until deleted. */
  function setRef(ref, info) {
    if (upload && upload.busy) upload.discard();
    upload = null;
    rejected = "";
    fileEl.value = "";
    fileName.textContent = "No file chosen";
    progress.hidden = true;
    clearBtn.hidden = true;
    pathEl.value = "";
    pdbEl.value = "";
    if (ref && ref.server_path != null) {
      pathEl.value = ref.server_path;
      setMode("server");
    } else if (ref && ref.pdb_id != null && allowPdb) {
      pdbEl.value = ref.pdb_id;
      setMode("pdb");
    } else if (ref && ref.upload_id) {
      const name = (info && info.name) || "file uploaded earlier";
      const stub = { id: ref.upload_id, done: true, busy: false, state: "done", checking: true,
                     discard() {}, abort() {} };
      upload = stub;
      fileName.textContent = info && info.size != null ? `${name} (${fmtBytes(info.size)})` : name;
      bar.value = 100;
      retryBtn.hidden = true;
      progress.classList.remove("is-error");
      progress.classList.add("is-done");
      stats.textContent = "Uploaded earlier: checking that it is still on the server...";
      progress.hidden = false;
      clearBtn.hidden = false;
      setMode("upload");
      // Clear form deletes uploads: ask the server before showing this one as ready
      const gone = () => {
        upload = null;
        rejected = `${name} is no longer on the server (Clear form deletes uploads): `
          + "choose the file again, or give its server path.";
        fileName.textContent = `${name} (deleted from the server)`;
        progress.hidden = true;
        setError(rejected);
        changed();
      };
      get(`/api/uploads/${encodeURIComponent(ref.upload_id)}`).then((u) => {
        if (upload !== stub) return;               // replaced or cleared meanwhile
        stub.checking = false;
        if (!u.complete) {
          gone();
          return;
        }
        stats.textContent = "Uploaded earlier (the same upload is reused)";
        changed();
      }, (e) => {
        if (upload !== stub) return;
        stub.checking = false;
        if (e.code === "not_found") gone();
        else stats.textContent = `Uploaded earlier (could not check it: ${e.message})`;
      });
    } else {
      setMode(allowPdb ? "pdb" : "upload");
    }
  }

  function getRef() {
    if (mode === "upload") {
      if (!upload) {
        if (rejected) return { error: rejected };
        return optional ? { ref: null } : { error: "Required: choose a file, or give a server path." };
      }
      if (upload.checking) {
        return { error: "Checking that the file uploaded earlier is still on the server: try again in a moment." };
      }
      if (upload.done) return { ref: { upload_id: upload.id } };
      if (upload.state === "stalled" || upload.state === "error") {
        return { error: "The upload stopped: press Retry, or choose the file again." };
      }
      return { error: `Upload still running (${Math.floor(100 * upload.fraction)}%): wait for it to finish.` };
    }
    if (mode === "server") {
      const p = pathEl.value.trim();
      if (!p) return optional ? { ref: null } : { error: "Required: give the absolute path of the file." };
      if (!p.startsWith("/")) return { error: "Must be an absolute path (starting with /)." };
      return { ref: { server_path: p } };
    }
    const id4 = pdbEl.value.trim();
    if (!id4) return optional ? { ref: null } : { error: "Required." };
    if (!PDB_RE.test(id4)) return { error: "A PDB ID has 4 characters and starts with a digit (e.g. 4AKE)." };
    return { ref: { pdb_id: id4.toUpperCase() } };
  }

  function hasValue() {
    if (mode === "upload") return Boolean(upload);
    if (mode === "server") return Boolean(pathEl.value.trim());
    return Boolean(pdbEl.value.trim());
  }

  function destroy() {
    if (upload) upload.discard();
    if (currentPath) errors.remove(currentPath);
  }

  setMode(mode);
  register(path);
  return {
    el,
    getRef,
    setRef,
    hasValue,
    setError,
    setPath: register,
    busy: () => Boolean(upload && upload.busy),
    destroy,
  };
}
