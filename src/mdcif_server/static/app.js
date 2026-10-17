/* mdcif-server UI: boot, hash router and page frame.
 *
 * Routes: #/new (default), #/jobs, #/jobs/<id>. On every route change <body> gets
 * data-route="new|jobs|job" data-ready="0", and data-ready="1" once that page has rendered its
 * data or an error message (a hook for automated page checks).
 */

import { get, onUnauthorized } from "./api.js";
import { clear, h, notice } from "./dom.js";
import { anyUploadBusy, renderNewJob } from "./form.js";
import { renderJob, renderJobs } from "./jobs.js";

const main = document.getElementById("main");
const body = document.body;
let config = null;
let current = null;                          // {controller, cleanups}
let routeSeq = 0;
let expired = false;

function parseHash() {
  const hash = location.hash || "#/new";
  if (/^#\/jobs\/?$/.test(hash)) return { route: "jobs" };
  const m = /^#\/jobs\/([^/?#]+)\/?$/.exec(hash);
  if (m) {
    let id = m[1];
    try {
      id = decodeURIComponent(id);
    } catch {
      /* keep it as it is */
    }
    return { route: "job", id };
  }
  return { route: "new" };
}

function setNav(route) {
  for (const a of document.querySelectorAll("[data-nav]")) {
    const on = a.dataset.nav === route || (route === "job" && a.dataset.nav === "jobs");
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
}

function leave() {
  if (!current) return;
  current.controller.abort();
  for (const fn of current.cleanups) {
    try {
      fn();
    } catch {
      /* page already gone */
    }
  }
  current = null;
}

async function route() {
  if (expired) return;
  leave();
  const seq = ++routeSeq;
  const { route: name, id } = parseHash();
  body.dataset.route = name;
  body.dataset.ready = "0";
  setNav(name);
  document.title = { new: "New job", jobs: "Jobs", job: "Job" }[name] + " · mdcif server";
  const controller = new AbortController();
  const cleanups = [];
  current = { controller, cleanups };
  const ctx = { config, signal: controller.signal, onCleanup: (fn) => cleanups.push(fn) };
  try {
    if (name === "new") await renderNewJob(main, ctx);
    else if (name === "jobs") await renderJobs(main, ctx);
    else await renderJob(main, ctx, id);
  } catch (e) {
    if (controller.signal.aborted || seq !== routeSeq || expired) return;
    clear(main).append(notice("error", h("p", { class: "strong", text: "Something went wrong on this page." }),
      h("p", { text: e && e.message ? e.message : String(e) })));
    console.error(e);
  }
  if (seq === routeSeq && !expired) {
    body.dataset.ready = "1";
    main.focus({ preventScroll: true });
    if (name !== "new") window.scrollTo(0, 0);
  }
}

function showExpired() {
  if (expired) return;
  expired = true;
  leave();
  for (const d of document.querySelectorAll("dialog[open]")) d.close();
  const box = h("div", { class: "fullpage", role: "alert" },
    h("div", { class: "fullpage-box" },
      h("h1", { text: "Not signed in" }),
      h("p", { class: "strong", text: "Session expired or server restarted: open the link printed by mdcif-server again." }),
      h("p", { class: "muted", text: "It is the line \"mdcif-server URL: ...?token=...\" in the server's output (or in the log of scripts/start_hpg.sh). A restarted server has a new token." })));
  clear(main).append(box);
  body.classList.add("is-expired");
  body.dataset.ready = "1";
}

async function boot() {
  onUnauthorized(showExpired);
  body.dataset.route = parseHash().route;
  body.dataset.ready = "0";
  try {
    config = await get("/api/config");
  } catch (e) {
    if (expired) return;
    clear(main).append(notice("error", h("p", { class: "strong", text: "Could not reach the mdcif server." }),
      h("p", { text: e.message }),
      h("button", { type: "button", class: "btn", onclick: () => location.reload() }, "Try again")));
    body.dataset.ready = "1";
    return;
  }
  const meta = document.getElementById("server-meta");
  clear(meta).append(
    h("span", { text: `mdcif-server ${config.version}` }),
    h("span", { text: `mdcif ${config.mdcif_version}` }),
    h("span", { title: "compute node the server runs on" }, "on ", h("span", { class: "mono", text: config.hostname })));
  window.addEventListener("hashchange", route);
  window.addEventListener("beforeunload", (ev) => {
    if (anyUploadBusy()) {
      ev.preventDefault();
      ev.returnValue = "";
    }
  });
  await route();
}

boot();
