/* The Jobs list and the Job page: stepper, log tail, cancel,
 * delete, and the results of a finished build (validation, numbers, landscape, 3D view, models,
 * command line, downloads).
 */

import { del, get, post, query } from "./api.js";
import { append, badge, clear, confirmDialog, fmtBytes, fmtDuration, fmtNum, fmtPct, fmtTime, h,
         notice } from "./dom.js";
import { editJob } from "./form.js";
import { modelColor, mountViewer } from "./viewer.js";

export const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const STATE_TEXT = { queued: "Queued", running: "Running", succeeded: "Succeeded", failed: "Failed",
                     cancelled: "Cancelled" };
const STATE_KIND = { queued: "neutral", running: "info", succeeded: "ok", failed: "err", cancelled: "warn" };
const JOB_POLL_MS = 2000;
const LIST_POLL_MS = 5000;
const LOG_TAIL = 65536;
const LOG_KEEP = 2_000_000;                  // characters kept in the page for very long logs

const KIND_TEXT = {
  cif: "mmCIF file", bcif: "BinaryCIF file", provenance: "Provenance (YAML)",
  landscape: "Landscape plot (PNG)", summary: "Build summary", info: "mdcif info",
  validation: "Validation report", command: "Command line", log: "Job log",
};

export function stateBadge(state) {
  return badge(STATE_KIND[state] || "neutral", STATE_TEXT[state] || state);
}

function validBadge(valid, state) {
  if (valid === true) return badge("ok", "valid");
  if (valid === false) return badge("err", "invalid");
  if (state === "succeeded") return badge("warn", "not validated");
  return h("span", { class: "muted", text: "–" });
}

function stageLabel(config, name) {
  const s = (config.stages || []).find((x) => x.name === name);
  return s ? s.label : name;
}

function stageText(config, j) {
  if (j.state === "queued") {
    return j.queue_position ? `Waiting (number ${j.queue_position} in the queue)` : "Waiting";
  }
  if (j.state === "running") return j.stage ? stageLabel(config, j.stage) : "Starting";
  if (j.state === "succeeded") return "Done";
  const verb = j.state === "failed" ? "Failed" : "Cancelled";
  return j.stage ? `${verb} during: ${stageLabel(config, j.stage)}` : `${verb} before starting`;
}

function jobTitle(j) {
  return j.name || j.id;
}

/* ================================================================== Jobs list */

export async function renderJobs(main, ctx) {
  const { config } = ctx;
  const tbody = h("tbody");
  const status = h("p", { class: "muted list-status", "aria-live": "polite" });
  const msg = h("div");
  const table = h("table", { class: "jobs-table" },
    h("thead", null, h("tr", null,
      ["Job", "State", "Stage", "Created", "Elapsed", "Validation"].map((t) => h("th", { scope: "col", text: t })))),
    tbody);
  const empty = h("div", { class: "empty", hidden: true },
    h("p", { text: "No jobs yet." }), h("a", { href: "#/new", class: "btn btn-primary" }, "Start a new job"));
  const refreshBtn = h("button", { type: "button", class: "btn btn-small", onclick: () => load() }, "Refresh");
  clear(main).append(
    h("div", { class: "page-head" }, h("h1", { text: "Jobs" }),
      h("div", { class: "btn-row" }, refreshBtn, h("a", { href: "#/new", class: "btn btn-primary" }, "New job"))),
    msg, h("section", { class: "card card-flush" }, h("div", { class: "table-wrap" }, table), empty), status);

  let timer = null;
  ctx.onCleanup(() => clearTimeout(timer));

  async function load() {
    clearTimeout(timer);
    let data;
    try {
      data = await get("/api/jobs", { signal: ctx.signal });
    } catch (e) {
      if (ctx.signal.aborted) return;
      clear(msg).append(notice("error", `Could not load the jobs: ${e.message}`));
      timer = setTimeout(load, LIST_POLL_MS);
      return;
    }
    if (ctx.signal.aborted) return;
    clear(msg);
    const jobs = data.jobs || [];
    clear(tbody);
    for (const j of jobs) tbody.append(jobRow(config, j));
    table.hidden = !jobs.length;
    empty.hidden = Boolean(jobs.length);
    const active = jobs.some((j) => !TERMINAL.has(j.state));
    status.textContent = `${jobs.length} job${jobs.length === 1 ? "" : "s"} · updated ${new Date().toLocaleTimeString()}`
      + (active ? " · refreshing every 5 s while jobs run" : "");
    if (active) timer = setTimeout(load, LIST_POLL_MS);
  }
  await load();
}

function jobRow(config, j) {
  const href = `#/jobs/${encodeURIComponent(j.id)}`;
  return h("tr", { class: `state-${j.state}` },
    h("td", { "data-label": "Job", class: "cell-name" },
      h("a", { href, class: "job-link", text: jobTitle(j) }),
      j.name ? h("span", { class: "job-id mono", text: j.id }) : null),
    h("td", { "data-label": "State" }, stateBadge(j.state)),
    h("td", { "data-label": "Stage", text: stageText(config, j) }),
    h("td", { "data-label": "Created" }, h("time", { datetime: j.created, text: fmtTime(j.created) })),
    h("td", { "data-label": "Elapsed", class: "num", text: j.elapsed != null ? fmtDuration(j.elapsed) : "–" }),
    h("td", { "data-label": "Validation" }, validBadge(j.valid, j.state)));
}

/* ================================================================== Job page */

export async function renderJob(main, ctx, id) {
  let job;
  try {
    job = await get(`/api/jobs/${encodeURIComponent(id)}`, { signal: ctx.signal });
  } catch (e) {
    if (ctx.signal.aborted) return;
    clear(main).append(h("div", { class: "page-head" }, h("h1", { text: "Job" })),
      e.code === "not_found"
        ? notice("error", h("p", { text: `There is no job ${id}. It may have been deleted.` }),
          h("a", { href: "#/jobs", class: "btn" }, "All jobs"))
        : notice("error", h("p", { text: `Could not load the job: ${e.message}` }),
          h("button", { type: "button", class: "btn", onclick: () => renderJob(main, ctx, id) }, "Try again")));
    return;
  }
  const pageObj = new JobPage(main, ctx, job);
  await pageObj.start();
}

class JobPage {
  constructor(main, ctx, job) {
    this.main = main;
    this.ctx = ctx;
    this.config = ctx.config;
    this.id = job.id;
    this.job = null;
    this.timer = null;
    this.dead = false;
    this.viewer = null;
    this.resultsShown = false;
    this.outputsKey = "";
    ctx.onCleanup(() => this.destroy());

    this.title = h("h1", { class: "job-title" });
    this.badges = h("div", { class: "badges" });
    this.meta = h("dl", { class: "job-meta" });
    this.cancelBtn = h("button", { type: "button", class: "btn btn-danger-quiet", onclick: () => this.cancel() },
      "Cancel job");
    this.deleteBtn = h("button", { type: "button", class: "btn btn-danger-quiet", onclick: () => this.remove() },
      "Delete job");
    this.rerunBtn = h("button", { type: "button", class: "btn",
                                  title: "Open the New job form with this job's files, options and provenance",
                                  onclick: () => {
                                    editJob(this.job);
                                    location.hash = "#/new";
                                  } }, "Edit and run again");
    this.actionMsg = h("div", { "aria-live": "polite" });
    this.conn = h("div", { "aria-live": "polite" });
    this.stepper = h("ol", { class: "stepper" });
    this.progressInfo = h("div", { class: "progress-info" });
    this.results = h("div", { class: "results" });
    this.downloads = h("div", { class: "downloads" });
    this.log = new LogTail(job.id, ctx);
    this.logSub = h("span", { class: "muted" });
    this.logDetails = h("details", { class: "card log-card", open: true },
      h("summary", null, h("span", { class: "summary-title", text: "Log" }), this.logSub),
      this.log.el);

    this.el = h("div", { class: "job-page" },
      h("a", { href: "#/jobs", class: "back-link" }, "‹ All jobs"),
      h("div", { class: "page-head job-head" },
        h("div", { class: "job-head-main" }, this.title, this.badges),
        h("div", { class: "btn-row" }, this.rerunBtn, this.cancelBtn, this.deleteBtn)),
      this.meta, this.actionMsg, this.conn,
      h("section", { class: "card", "aria-labelledby": "sec-progress" },
        h("h2", { id: "sec-progress", text: "Progress" }), this.stepper, this.progressInfo),
      this.results,
      this.logDetails,
      h("section", { class: "card", "aria-labelledby": "sec-files" },
        h("h2", { id: "sec-files", text: "Files" }), this.downloads),
      commandCard(job),
      inputsCard(job));
    clear(main).append(this.el);
    this.update(job);
  }

  async start() {
    try {
      await this.log.poll();
    } catch (e) {
      this.log.showError(e);
    }
    if (!(TERMINAL.has(this.job.state) && this.log.finished)) this.schedule();
  }

  schedule() {
    clearTimeout(this.timer);
    if (!this.dead) this.timer = setTimeout(() => this.tick(), JOB_POLL_MS);
  }

  async tick() {
    if (this.dead) return;
    let job;
    try {
      job = await get(`/api/jobs/${encodeURIComponent(this.id)}`, { signal: this.ctx.signal });
      clear(this.conn);
    } catch (e) {
      if (this.dead) return;
      if (e.code === "not_found") {
        clear(this.conn).append(notice("error", "This job no longer exists (deleted elsewhere?)."));
        return;
      }
      clear(this.conn).append(notice("warn", `Lost contact with the server (${e.message}); retrying...`));
      this.schedule();
      return;
    }
    if (this.dead) return;
    this.update(job);
    try {
      await this.log.poll();
    } catch (e) {
      if (this.dead) return;
      this.log.showError(e);
    }
    if (TERMINAL.has(job.state) && this.log.finished) return;      // all read: stop polling
    this.schedule();
  }

  update(job) {
    const prev = this.job;
    this.job = job;
    const active = !TERMINAL.has(job.state);
    this.title.textContent = jobTitle(job);
    document.title = `${jobTitle(job)} · mdcif server`;
    append(clear(this.badges), stateBadge(job.state),
      job.validation ? validBadge(job.validation.valid, job.state) : null);
    append(clear(this.meta),
      metaItem("Job id", h("span", { class: "mono", text: job.id })),
      metaItem("Created", h("time", { datetime: job.created, text: fmtTime(job.created) })),
      job.started ? metaItem("Started", h("time", { datetime: job.started, text: fmtTime(job.started) })) : null,
      job.finished ? metaItem("Finished", h("time", { datetime: job.finished, text: fmtTime(job.finished) })) : null,
      job.elapsed != null ? metaItem(active ? "Running for" : "Took", fmtDuration(job.elapsed)) : null);
    this.logSub.textContent = active ? " · job.log, refreshed every 2 s" : " · job.log";
    this.cancelBtn.hidden = !active;
    this.deleteBtn.hidden = active;
    this.renderStepper(job);
    this.renderProgressInfo(job);
    const key = (job.outputs || []).map((o) => `${o.name}:${o.size}`).join("|");
    if (key !== this.outputsKey) {
      this.outputsKey = key;
      renderDownloads(this.downloads, job);
    }
    if (job.state === "succeeded" && !this.resultsShown) {
      this.resultsShown = true;
      this.renderResults(job);
      if (!prev || prev.state === "succeeded") this.logDetails.open = false;
    }
  }

  renderStepper(job) {
    const stages = this.config.stages || [];
    const names = stages.map((s) => s.name);
    const at = job.stage ? names.indexOf(job.stage) : -1;
    const cur = { running: "active", failed: "failed", cancelled: "stopped" }[job.state] || "pending";
    const words = { done: "done", active: "running now", failed: "failed", stopped: "stopped", pending: "not started" };
    clear(this.stepper);
    stages.forEach((s, i) => {
      let st = "pending";
      if (job.state === "succeeded") st = "done";
      else if (at >= 0 && i < at) st = "done";
      else if (at >= 0 && i === at) st = cur;
      const t = job.timings ? job.timings[s.name] : null;
      const sub = st === "done" && t != null ? fmtDuration(t) : st === "pending" ? "" : words[st];
      this.stepper.append(h("li", { class: `step step-${st}`, "aria-current": st === "active" ? "step" : null },
        h("span", { class: "step-dot", "aria-hidden": "true", text: st === "done" ? "" : String(i + 1) }),
        h("span", { class: "step-text" },
          h("span", { class: "step-label", text: s.label }),
          h("span", { class: "sr-only", text: `: ${words[st]}` }),
          h("span", { class: "step-sub", "aria-hidden": "true", text: sub }))));
    });
  }

  renderProgressInfo(job) {
    const box = clear(this.progressInfo);
    if (job.state === "queued") {
      box.append(notice("info", job.queue_position
        ? `Waiting for a free worker: number ${job.queue_position} in the queue (the server runs ${this.config.workers || 1} job${(this.config.workers || 1) > 1 ? "s" : ""} at a time).`
        : "Waiting for a free worker."));
    } else if (job.state === "running") {
      box.append(h("p", { class: "muted", text: `Running: ${stageLabel(this.config, job.stage)}. This page updates every 2 s.` }));
    } else if (job.state === "failed") {
      box.append(notice("error",
        h("p", { class: "strong", text: job.stage ? `Failed during "${stageLabel(this.config, job.stage)}"` : "Failed before starting" }),
        h("p", { class: "error-text", text: job.error || "no error message" }),
        h("p", { class: "muted", text: "The full traceback, if any, is in the log below." })));
    } else if (job.state === "cancelled") {
      box.append(notice("warn",
        h("p", { class: "strong", text: job.stage ? `Cancelled during "${stageLabel(this.config, job.stage)}"` : "Cancelled before it started" }),
        job.error ? h("p", { class: "error-text", text: job.error }) : null));
    }
    if (job.warnings && job.warnings.length) {
      box.append(notice("warn", h("p", { class: "strong", text: `${job.warnings.length} warning${job.warnings.length > 1 ? "s" : ""}` }),
        h("ul", null, job.warnings.map((w) => h("li", { text: w })))));
    }
  }

  renderResults(job) {
    const r = job.result || {};
    const models = r.models || [];
    const landscape = (job.outputs || []).find((o) => o.kind === "landscape");
    const viewerBox = h("div", { class: "viewer" });

    // the pictures first: they are what a structural biologist looks at
    const sections = [validationCard(job.validation)];
    sections.push(h("section", { class: "card", "aria-labelledby": "sec-landscape" },
      h("h2", { id: "sec-landscape", text: "Conformational landscape" }),
      h("figure", { class: "landscape" },
        landscape
          ? h("img", { src: landscape.url, alt: "Conformational landscape: every frame projected on the global principal components, coloured by model" })
          : h("p", { class: "notice notice-warn", text: "No landscape plot (see the warnings above)." }),
        h("figcaption", { class: "help" },
          "Every analysed frame projected on the global principal components, coloured by model (models 1-3 in colour, the others grey, noise light grey). Same plot as mdcif landscape. ",
          landscape ? h("a", { href: landscape.url, target: "_blank", rel: "noopener" }, "Open it full size") : null))));
    sections.push(h("section", { class: "card", "aria-labelledby": "sec-3d" },
      h("h2", { id: "sec-3d", text: "3D view of the deposited models" }), viewerBox));

    sections.push(h("section", { class: "card", "aria-labelledby": "sec-result" },
      h("h2", { id: "sec-result", text: "Result" }),
      h("dl", { class: "stats" },
        stat("Frames analysed", fmtNum(r.n_frames)),
        stat("Analysis atoms", fmtNum(r.n_analysis_atoms)),
        stat("Atoms per model", fmtNum(r.n_deposited_atoms)),
        stat("Clusters", fmtNum(r.n_clusters)),
        stat("Models deposited", fmtNum(r.n_models)),
        stat("Frames in no model", r.noise_fraction != null ? fmtPct(r.noise_fraction) : ""),
        stat("Global PCA variance", (r.global_variance || []).length
          ? `${r.global_variance.map((x) => Math.round(100 * x)).join(" / ")} %` : ""),
        r.reference ? stat("Reference", r.reference) : null),
      r.clustering ? h("p", { class: "help" }, h("span", { class: "strong", text: "Clustering: " }), r.clustering) : null));

    if (models.length) sections.push(modelsCard(models));
    sections.push(reportsCard(job));
    append(clear(this.results), sections);
    this.viewer = mountViewer(viewerBox, job);
  }

  async cancel() {
    const ok = await confirmDialog({ title: "Cancel this job?", confirm: "Cancel job", cancel: "Keep running",
      danger: true, message: "The worker is stopped now. Files already written are kept." });
    if (!ok || this.dead) return;
    this.cancelBtn.disabled = true;
    this.cancelBtn.textContent = "Cancelling...";
    clear(this.actionMsg);
    try {
      const job = await post(`/api/jobs/${encodeURIComponent(this.id)}/cancel`, {});
      this.update(job);
      this.schedule();                       // read the rest of the log
    } catch (e) {
      clear(this.actionMsg).append(notice(e.code === "job_finished" ? "info" : "error", e.message));
      this.schedule();
    } finally {
      this.cancelBtn.disabled = false;
      this.cancelBtn.textContent = "Cancel job";
    }
  }

  async remove() {
    const ok = await confirmDialog({ title: "Delete this job?", confirm: "Delete job", cancel: "Keep it",
      danger: true, message: `${jobTitle(this.job)}: its output files and log are removed for good. Uploaded files are kept.` });
    if (!ok || this.dead) return;
    this.deleteBtn.disabled = true;
    clear(this.actionMsg);
    try {
      await del(`/api/jobs/${encodeURIComponent(this.id)}`);
      location.hash = "#/jobs";
    } catch (e) {
      clear(this.actionMsg).append(notice("error", e.message));
      this.deleteBtn.disabled = false;
    }
  }

  destroy() {
    this.dead = true;
    clearTimeout(this.timer);
    if (this.viewer) this.viewer.destroy();
  }
}

function metaItem(label, value) {
  return h("div", null, h("dt", { text: label }), h("dd", null, value));
}

function stat(label, value) {
  if (value === "" || value == null) return null;
  return h("div", { class: "stat" }, h("dt", { text: label }), h("dd", { text: value }));
}

function validationCard(v) {
  let body;
  if (!v) {
    body = notice("warn", "No validation result.");
  } else if (v.valid === true) {
    body = notice("ok", h("p", { class: "strong", text: `Valid mdcif file: ${v.file}` }),
      h("p", { class: "mono small", text: v.text }));
  } else if (v.valid === false) {
    const n = (v.problems || []).length;
    body = notice("error",
      h("p", { class: "strong", text: `Not valid: ${n} problem${n === 1 ? "" : "s"} in ${v.file}` }),
      h("ol", { class: "problems mono small" }, (v.problems || []).map((p) => h("li", { text: p }))),
      h("p", { class: "muted", text: "The file was still written; validate.txt (under Files) has the full report." }));
  } else {
    body = notice("warn", h("p", { class: "strong", text: `Validation could not run on ${v.file}` }),
      h("p", { class: "mono small", text: v.text }),
      h("p", { class: "muted", text: "The file was written but not checked; run mdcif validate on it later." }));
  }
  return h("section", { class: "card", "aria-labelledby": "sec-valid" },
    h("h2", { id: "sec-valid", text: "Validation" }), body);
}

function modelsCard(models) {
  const anyRef = models.some((m) => m.reference_rmsd != null);
  const head = ["Model", "Frames", "Share", "Medoid", "Precision (Å)"];
  if (anyRef) head.push("RMSD to reference (Å)");
  head.push("Modes", "Mode variance");
  return h("section", { class: "card", "aria-labelledby": "sec-models" },
    h("h2", { id: "sec-models", text: "Deposited models" }),
    h("p", { class: "help", text: "One model per cluster, most populated first. Precision: mean RMSD of the cluster's frames to its medoid." }),
    h("div", { class: "table-wrap" },
      h("table", { class: "models-table" },
        h("thead", null, h("tr", null, head.map((t) => h("th", { scope: "col", text: t })))),
        h("tbody", null, models.map((m, i) => h("tr", null,
          h("th", { scope: "row" }, h("span", { class: "swatch", style: { background: modelColor(i) }, "aria-hidden": "true" }),
            ` ${m.model}`),
          h("td", { class: "num", text: fmtNum(m.frames) }),
          h("td", { class: "num", text: fmtPct(m.fraction) }),
          h("td", { text: m.medoid || "" }),
          h("td", { class: "num", text: fmtNum(m.precision) }),
          anyRef ? h("td", { class: "num", text: m.reference_rmsd != null ? fmtNum(m.reference_rmsd) : "–" }) : null,
          h("td", { class: "num", text: String(m.n_modes ?? "") }),
          h("td", { class: "num", text: (m.variance || []).length
            ? `${m.variance.map((x) => Math.round(100 * x)).join(" / ")} %` : "–" })))))));
}

function reportsCard(job) {
  const blocks = [];
  if (job.summary) {
    blocks.push(h("details", { class: "report", open: true },
      h("summary", { text: "Build summary (summary.txt)" }), h("pre", { class: "text-block", text: job.summary })));
  }
  if (job.info) {
    blocks.push(h("details", { class: "report" },
      h("summary", { text: "mdcif info (info.txt)" }), h("pre", { class: "text-block", text: job.info })));
  }
  if (job.validation && job.validation.text) {
    blocks.push(h("details", { class: "report" },
      h("summary", { text: "Validation report (validate.txt)" }), h("pre", { class: "text-block", text: job.validation.text })));
  }
  if (!blocks.length) return null;
  return h("section", { class: "card", "aria-labelledby": "sec-reports" },
    h("h2", { id: "sec-reports", text: "Reports" }), blocks);
}

function renderDownloads(box, job) {
  const outs = job.outputs || [];
  clear(box);
  if (!outs.length) {
    box.append(h("p", { class: "muted", text: "No files yet." }));
    return;
  }
  box.append(h("ul", { class: "download-list" }, outs.map((o) => h("li", null,
    h("a", { class: `btn download ${o.kind === "cif" || o.kind === "bcif" ? "btn-primary" : ""}`,
             href: `${o.url}?download=1`, download: o.name },
      h("span", { class: "dl-name mono", text: o.name }),
      h("span", { class: "dl-kind", text: `${KIND_TEXT[o.kind] || o.kind} · ${fmtBytes(o.size)}` }))))));
}

function commandCard(job) {
  if (!job.command) return null;
  const pre = h("pre", { class: "command mono", tabindex: "0", "aria-label": "Equivalent mdcif build command", text: job.command });
  const msg = h("span", { class: "copy-msg muted", "aria-live": "polite" });
  const btn = h("button", { type: "button", class: "btn btn-small", onclick: async () => {
    try {
      if (!navigator.clipboard || !window.isSecureContext) throw new Error("no clipboard");
      await navigator.clipboard.writeText(job.command);
      msg.textContent = "Copied.";
    } catch {
      const range = document.createRange();
      range.selectNodeContents(pre);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      let copied = false;
      try {
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      }
      msg.textContent = copied ? "Copied." : "Selected: press Ctrl+C (or Cmd+C) to copy.";
    }
    setTimeout(() => { msg.textContent = ""; }, 4000);
  } }, "Copy");
  return h("section", { class: "card", "aria-labelledby": "sec-cmd" },
    h("div", { class: "card-head" }, h("h2", { id: "sec-cmd", text: "Command line" }), h("div", { class: "btn-row" }, msg, btn)),
    h("p", { class: "help", text: "The same build with the mdcif CLI, e.g. to rerun it in a shell (the output goes to the current folder)." }),
    pre);
}

const SOURCE_TEXT = { upload: "uploaded", server_path: "server path", pdb_id: "PDB ID, from RCSB",
                      provenance: "PDB ID from the provenance" };

function inputsCard(job) {
  const ins = job.inputs || {};
  const rows = [];
  const row = (label, x) => {
    if (!x) return;
    rows.push(h("tr", null,
      h("th", { scope: "row", text: label }),
      h("td", null, h("span", { class: "mono strong", text: x.name }),
        h("span", { class: "muted", text: ` · ${SOURCE_TEXT[x.source] || x.source}${x.size != null ? ` · ${fmtBytes(x.size)}` : ""}` }),
        x.path ? h("span", { class: "in-path mono small", text: x.path }) : null)));
  };
  row("Topology", ins.topology);
  (ins.trajectories || []).forEach((t, i) => row((ins.trajectories.length > 1 ? `Trajectory ${i + 1}` : "Trajectory"), t));
  row("Labels", ins.labels);
  row("Reference", ins.reference);
  if (!rows.length) return null;
  return h("section", { class: "card", "aria-labelledby": "sec-inputs" },
    h("h2", { id: "sec-inputs", text: "Inputs" }),
    h("div", { class: "table-wrap" }, h("table", { class: "inputs-table" }, h("tbody", null, rows))));
}

/* ------------------------------------------------------------------ log tail */

class LogTail {
  constructor(id, ctx) {
    this.id = id;
    this.ctx = ctx;
    this.offset = null;
    this.size = 0;
    this.state = null;
    this.chars = 0;
    this.stick = true;
    this.pre = h("pre", { class: "log mono", tabindex: "0", "aria-label": "Job log" });
    this.note = h("p", { class: "muted small", hidden: true });
    this.empty = h("p", { class: "muted", text: "The log starts when the job runs." });
    this.err = h("div");
    this.el = h("div", { class: "log-wrap" }, this.note, this.empty, this.pre, this.err);
    this.pre.addEventListener("scroll", () => {
      const p = this.pre;
      this.stick = p.scrollTop + p.clientHeight >= p.scrollHeight - 24;
    });
    if (window.ResizeObserver) {              // rewrapped lines (rotation, resize): stay at the end
      this.ro = new ResizeObserver(() => {
        if (this.stick) this.pre.scrollTop = this.pre.scrollHeight;
      });
      this.ro.observe(this.pre);
      ctx.onCleanup(() => this.ro.disconnect());
    }
  }

  get finished() {
    return TERMINAL.has(this.state) && this.offset != null && this.offset >= this.size;
  }

  url(offset, maxBytes) {
    return `/api/jobs/${encodeURIComponent(this.id)}/log${query({ offset, max_bytes: maxBytes })}`;
  }

  async poll() {
    const { signal } = this.ctx;
    if (this.offset == null) {
      const first = await get(this.url(0, 1), { signal });
      this.size = first.size;
      this.state = first.state;
      this.offset = Math.max(0, first.size - LOG_TAIL);
      if (this.offset > 0) {
        this.note.hidden = false;
        this.note.textContent = `Showing the last ${fmtBytes(LOG_TAIL)} of ${fmtBytes(first.size)}; download job.log for all of it.`;
      }
    }
    for (let k = 0; k < 50; k += 1) {
      const r = await get(this.url(this.offset), { signal });
      this.state = r.state;
      this.size = r.size;
      if (r.text) this.append(r.text);
      const moved = r.next_offset !== this.offset;
      this.offset = r.next_offset;
      if (!moved || this.offset >= this.size) break;
    }
    if (!this.chars && TERMINAL.has(this.state)) this.empty.textContent = "No log was written.";
    clear(this.err);
  }

  append(text) {
    const p = this.pre;
    const stick = this.stick;
    this.empty.hidden = true;
    p.append(text);
    this.chars += text.length;
    if (this.chars > LOG_KEEP) {
      const all = p.textContent;
      p.textContent = all.slice(all.length - LOG_KEEP / 2);
      this.chars = p.textContent.length;
      this.note.hidden = false;
      this.note.textContent = "Earlier lines were dropped from this view; download job.log for all of it.";
    }
    if (stick) p.scrollTop = p.scrollHeight;
  }

  showError(e) {
    clear(this.err).append(notice("warn", `Could not read the log: ${e.message}`));
  }
}
