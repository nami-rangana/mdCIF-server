/* The Browse dialog of a server-path input, backed by GET /api/files.
 *
 * It opens on the list of allowed roots, never offers "up" above a root (parent is null there),
 * and has a hidden-files toggle. browseServer({title}) resolves to the chosen file's path, or null.
 */

import { get, query } from "./api.js";
import { clear, fmtBytes, fmtTime, h } from "./dom.js";

let dlg = null;
let ui = null;
let lastDir = null;                          // folder of the last chosen file (a shortcut)
let current = { path: null, parent: null };
let selected = null;
let resolveFn = null;
let seq = 0;

function build() {
  ui = {};
  ui.title = h("h2", { id: "browse-title", text: "Choose a file on the server" });
  ui.up = h("button", { type: "button", class: "btn btn-small", onclick: () => go(current.parent) },
    "Up one folder");
  ui.roots = h("button", { type: "button", class: "btn btn-small", onclick: () => go(null) },
    "Allowed roots");
  ui.last = h("button", { type: "button", class: "btn btn-small", hidden: true,
                          onclick: () => go(lastDir) }, "Last folder");
  ui.hidden = h("input", { type: "checkbox", id: "browse-hidden", onchange: () => go(current.path) });
  ui.goInput = h("input", { type: "text", id: "browse-go", autocomplete: "off", spellcheck: "false",
                            placeholder: "/blue/..." });
  ui.where = h("p", { class: "browse-where mono", "aria-live": "polite" });
  ui.msg = h("div", { class: "browse-msg", role: "status" });
  ui.list = h("ul", { class: "browse-list", "aria-labelledby": "browse-title" });
  ui.sel = h("p", { class: "browse-sel", text: "No file selected." });
  ui.choose = h("button", { type: "button", class: "btn btn-primary", disabled: true,
                            onclick: () => finish(selected) }, "Use this file");
  const cancel = h("button", { type: "button", class: "btn", onclick: () => finish(null) }, "Cancel");

  dlg = h("dialog", { class: "browse", "aria-labelledby": "browse-title" },
    h("div", { class: "browse-head" }, ui.title,
      h("button", { type: "button", class: "btn btn-icon", "aria-label": "Close",
                    onclick: () => finish(null) }, "×")),
    h("div", { class: "browse-bar" }, ui.up, ui.roots, ui.last,
      h("span", { class: "check" }, ui.hidden,
        h("label", { for: "browse-hidden", text: "Show hidden files" }))),
    h("form", { class: "browse-go", onsubmit: (ev) => {
      ev.preventDefault();
      const p = ui.goInput.value.trim();
      if (p) go(p);
    } },
      h("label", { for: "browse-go", text: "Go to folder" }), ui.goInput,
      h("button", { type: "submit", class: "btn btn-small" }, "Go")),
    ui.where, ui.msg, ui.list,
    h("div", { class: "browse-foot" }, ui.sel, h("div", { class: "btn-row" }, cancel, ui.choose)));
  dlg.addEventListener("cancel", (ev) => {
    ev.preventDefault();
    finish(null);
  });
  document.body.append(dlg);
}

function finish(path) {
  if (path) {
    const i = path.lastIndexOf("/");
    lastDir = i > 0 ? path.slice(0, i) : lastDir;
  }
  if (dlg.open) dlg.close();
  const r = resolveFn;
  resolveFn = null;
  if (r) r(path);
}

function select(entry, btn) {
  selected = entry ? entry.path : null;
  for (const b of ui.list.querySelectorAll("[aria-pressed]")) b.setAttribute("aria-pressed", "false");
  if (btn) btn.setAttribute("aria-pressed", "true");
  ui.sel.textContent = selected ? `Selected: ${selected}` : "No file selected.";
  ui.choose.disabled = !selected;
}

async function go(path) {
  const mine = ++seq;
  select(null, null);
  ui.msg.className = "browse-msg";
  ui.msg.textContent = "Loading...";
  ui.list.setAttribute("aria-busy", "true");
  let data;
  try {
    data = await get(`/api/files${query({ path: path || null, hidden: ui.hidden.checked ? "true" : null })}`);
  } catch (e) {
    if (mine !== seq) return;
    ui.list.removeAttribute("aria-busy");
    ui.msg.className = "browse-msg notice notice-error";
    clear(ui.msg).append(e.message || "Could not list that folder.");
    if (path) {
      ui.msg.append(" ", h("button", { type: "button", class: "btn btn-small",
                                       onclick: () => go(null) }, "Back to the roots"));
    }
    return;
  }
  if (mine !== seq) return;
  ui.list.removeAttribute("aria-busy");
  current = { path: data.path, parent: data.parent };
  ui.up.hidden = !data.parent;
  ui.roots.hidden = data.path == null;
  ui.last.hidden = !lastDir || lastDir === data.path;
  if (lastDir) ui.last.textContent = "Last folder";
  ui.where.textContent = data.path == null ? "Allowed roots" : data.path;
  ui.goInput.value = data.path || "";
  ui.msg.textContent = "";
  if (data.truncated) {
    ui.msg.className = "browse-msg notice notice-warn";
    ui.msg.textContent = "This folder has more than 5000 entries; only the first 5000 are shown.";
  } else if (!data.entries.length) {
    ui.msg.textContent = "This folder is empty.";
  }
  clear(ui.list);
  for (const e of data.entries) ui.list.append(entryRow(e, data.path == null));
}

function entryRow(e, isRoot) {
  const kind = e.type === "dir" ? "dir" : e.type === "file" ? "file" : "other";
  const btn = h("button", { type: "button", class: `entry entry-${kind}`,
                            disabled: kind === "other",
                            "aria-pressed": kind === "file" ? "false" : null },
    h("span", { class: `ico ico-${kind}`, "aria-hidden": "true" }),
    h("span", { class: "entry-name", text: isRoot ? e.name : e.name + (kind === "dir" ? "/" : "") }),
    e.symlink ? h("span", { class: "entry-tag", text: "link" }) : null,
    h("span", { class: "entry-size", text: kind === "file" ? fmtBytes(e.size) : "" }),
    h("span", { class: "entry-time", text: e.mtime ? fmtTime(e.mtime) : "" }));
  if (kind === "dir") btn.addEventListener("click", () => go(e.path));
  if (kind === "file") {
    btn.addEventListener("click", () => select(e, btn));
    btn.addEventListener("dblclick", () => finish(e.path));
  }
  if (kind === "other") btn.title = "not a regular file or folder (broken link?)";
  return h("li", null, btn);
}

export function browseServer({ title } = {}) {
  if (!dlg) build();
  if (resolveFn) finish(null);
  ui.title.textContent = title || "Choose a file on the server";
  dlg.showModal();
  go(null);
  return new Promise((resolve) => {
    resolveFn = resolve;
  });
}
