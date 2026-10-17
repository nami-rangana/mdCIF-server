/* Small DOM and formatting helpers.
 *
 * h() builds elements; every string child becomes a text node, so server text never goes in as
 * HTML. FieldErrors maps the dotted `fields` paths of an API error to
 * inline messages under the matching inputs.
 */

const PROPS = new Set(["value", "checked", "disabled", "hidden", "open", "indeterminate"]);

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  const props = [];
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (PROPS.has(k)) props.push([k, v]);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, ...children);
  for (const [k, v] of props) el[k] = v;        // after the children (a <select>'s value)
  return el;
}

export function append(el, ...children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

let idCounter = 0;
export function uid(prefix = "f") {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ formatting */

export function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return "";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];        // binary multiples (1024)
  let i = 0;
  let x = n;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  return i === 0 ? `${x} B` : `${x.toFixed(x < 10 ? 2 : x < 100 ? 1 : 0)} ${units[i]}`;
}

export function fmtDuration(s) {
  if (s == null || !Number.isFinite(s)) return "";
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(Math.floor(s % 60)).padStart(2, "0")} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

export function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

export function fmtPct(fraction, digits = 1) {
  if (fraction == null || !Number.isFinite(fraction)) return "";
  return `${(100 * fraction).toFixed(digits)}%`;
}

export function fmtNum(x, digits = 2) {
  if (x == null || !Number.isFinite(x)) return "";
  return Number.isInteger(x) ? String(x) : x.toFixed(digits);
}

/* ------------------------------------------------------------------ field errors */

/* A registry of inputs by dotted request path (e.g. "options.step", "inputs.trajectories.1",
 * "provenance.simulation.temperature_K"). show() puts each message under the input whose path is
 * the longest prefix of the error path, and returns the messages that matched no input. */
export class FieldErrors {
  constructor() {
    this.fields = new Map();
  }

  /* entry: {errEl, input, wrapper} or, for composite widgets, also set(msg) and focus() */
  add(path, entry) {
    this.fields.set(path, entry);
  }

  remove(path) {
    this.fields.delete(path);
  }

  removePrefix(prefix) {
    for (const p of [...this.fields.keys()]) if (p === prefix || p.startsWith(`${prefix}.`)) {
      this.fields.delete(p);
    }
  }

  clear() {
    for (const f of this.fields.values()) setError(f, "");
  }

  set(path, message) {
    const f = this.fields.get(path);
    if (f) setError(f, message);
    return Boolean(f);
  }

  /* fields: {path: message}. Returns [[path, message], ...] that could not be placed. */
  show(fields) {
    const unmatched = [];
    let first = null;
    for (const [path, msg] of Object.entries(fields || {})) {
      const f = this.match(path);
      if (!f) {
        unmatched.push([path, msg]);
        continue;
      }
      const prev = f.errEl.textContent;
      setError(f, prev ? `${prev}; ${msg}` : String(msg));
      if (!first) first = f;
    }
    if (first) reveal(first);
    return unmatched;
  }

  match(path) {
    const parts = String(path).split(".");
    while (parts.length) {
      const f = this.fields.get(parts.join("."));
      if (f) return f;
      parts.pop();
    }
    return null;
  }

  firstWithError() {
    for (const f of this.fields.values()) if (f.errEl.textContent) return f;
    return null;
  }
}

function setError(f, message) {
  if (f.set) {
    f.set(message || "");
    return;
  }
  f.errEl.textContent = message || "";
  f.errEl.hidden = !message;
  if (f.wrapper) f.wrapper.classList.toggle("has-error", Boolean(message));
  if (f.input) {
    if (message) f.input.setAttribute("aria-invalid", "true");
    else f.input.removeAttribute("aria-invalid");
  }
}

export function reveal(f) {
  // open collapsed <details> around the field, then bring it into view
  for (let el = f.wrapper || f.input; el; el = el.parentElement) {
    if (el.tagName === "DETAILS") el.open = true;
  }
  const target = f.wrapper || f.input;
  if (target && target.scrollIntoView) target.scrollIntoView({ block: "center" });
  if (f.focus) f.focus();
  else if (f.input && f.input.focus) f.input.focus({ preventScroll: true });
}

/* A labelled form field: <div class="field"><label for>...</label> control help error</div>. */
export function field({ id, label, help, star, control, path, errors, cls, after }) {
  const errEl = h("p", { class: "field-error", id: `${id}-err`, hidden: true });
  const helpEl = help ? h("p", { class: "help", id: `${id}-help`, text: help }) : null;
  const target = control.matches?.("input, select, textarea") ? control
    : control.querySelector?.("input, select, textarea");
  if (target) {
    const ids = [helpEl ? `${id}-help` : null, `${id}-err`].filter(Boolean).join(" ");
    target.setAttribute("aria-describedby", ids);
  }
  const wrapper = h("div", { class: `field ${cls || ""}`.trim() },
    h("label", { for: id }, label, star ? starMark() : null),
    control, after || null, helpEl, errEl);
  if (errors && path) errors.add(path, { errEl, input: target, wrapper });
  return wrapper;
}

export function starMark() {
  return h("span", { class: "star", title: "recommended" },
    h("span", { "aria-hidden": "true", text: " ★" }), h("span", { class: "sr-only", text: " (recommended)" }));
}

export function notice(kind, ...children) {
  return h("div", { class: `notice notice-${kind}`, role: kind === "error" ? "alert" : "status" },
    ...children);
}

export function badge(kind, text) {
  return h("span", { class: `badge badge-${kind}`, text });
}

/* A modal yes/no question (a <dialog>, so headless tests can click it). Resolves to a bool. */
export function confirmDialog({ title, message, confirm = "OK", cancel = "Cancel", danger = false }) {
  return new Promise((resolve) => {
    const id = uid("confirm");
    const yes = h("button", { type: "button", class: `btn ${danger ? "btn-danger" : "btn-primary"}`,
                              text: confirm });
    const no = h("button", { type: "button", class: "btn", text: cancel });
    const dlg = h("dialog", { class: "confirm", "aria-labelledby": `${id}-t`, "aria-describedby": `${id}-m` },
      h("h2", { id: `${id}-t`, text: title }),
      h("p", { id: `${id}-m`, text: message }),
      h("div", { class: "btn-row" }, no, yes));
    const done = (v) => {
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    yes.addEventListener("click", () => done(true));
    no.addEventListener("click", () => done(false));
    dlg.addEventListener("cancel", (ev) => {
      ev.preventDefault();
      done(false);
    });
    document.body.append(dlg);
    dlg.showModal();
    no.focus();
  });
}
