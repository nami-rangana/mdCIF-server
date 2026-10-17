/* The HTTP API of mdcif-server: JSON calls and the chunked upload loop.
 *
 * Authentication is the HttpOnly cookie set by the landing link; this code never sees the token.
 * Every error becomes an ApiError carrying the server's {code, message, fields}; any 401 from
 * /api also calls the handler given to onUnauthorized (a full-page message).
 */

import { sleep } from "./dom.js";

export class ApiError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fields = fields && typeof fields === "object" ? fields : {};
  }
}

let unauthorizedHandler = () => {};
export function onUnauthorized(fn) {
  unauthorizedHandler = fn;
}

export function errorFrom(status, data) {
  const e = data && typeof data === "object" ? data.error : null;
  if (e && typeof e.message === "string") {
    return new ApiError(status, String(e.code || "error"), e.message, e.fields);
  }
  if (status === 401) {
    return new ApiError(401, "unauthorized", "missing or invalid token");
  }
  return new ApiError(status, `http_${status}`, `The server answered with HTTP ${status}.`);
}

const NETWORK_MESSAGE = "No answer from the server (connection lost, or the server stopped).";

export async function api(method, path, body, { signal } = {}) {
  const init = { method, headers: { Accept: "application/json" }, credentials: "same-origin",
                 cache: "no-store", signal };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    throw new ApiError(0, "network", NETWORK_MESSAGE);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (res.ok) {
    if (data === null) throw new ApiError(res.status, "bad_response", "Unexpected answer from the server.");
    return data;
  }
  const err = errorFrom(res.status, data);
  if (res.status === 401) unauthorizedHandler(err);
  throw err;
}

export const get = (path, opts) => api("GET", path, undefined, opts);
export const post = (path, body, opts) => api("POST", path, body === undefined ? {} : body, opts);
export const del = (path, opts) => api("DELETE", path, undefined, opts);

export function query(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

/* Fetch a job file as text (the .cif for the viewer). */
export async function getText(url, { signal } = {}) {
  let res;
  try {
    res = await fetch(url, { credentials: "same-origin", cache: "no-store", signal });
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    throw new ApiError(0, "network", NETWORK_MESSAGE);
  }
  if (!res.ok) {
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    const err = errorFrom(res.status, data);
    if (res.status === 401) unauthorizedHandler(err);
    throw err;
  }
  return res.text();
}

/* ------------------------------------------------------------------ uploads */

const MAX_RETRIES = 3;                       // per chunk, then the user gets a Retry button
const BACKOFF_MS = [1000, 2000, 4000];
const SPEED_WINDOW_MS = 5000;

function retryable(e) {
  return e.status === 0 || e.status >= 500 || e.status === 408 || e.status === 429
    || e.code === "upload_busy";
}

/* One file uploaded in chunks: create, PUT ?offset=N one chunk at a time, complete.
 * state: idle | creating | uploading | completing | done | stalled | error | aborted.
 * onUpdate(this) is called on every change; `sent` counts bytes, `speed` is bytes/s. */
export class ChunkedUpload {
  constructor(file, { chunkSize, onUpdate }) {
    this.file = file;
    this.chunkSize = chunkSize;
    this.onUpdate = onUpdate || (() => {});
    this.state = "idle";
    this.upload = null;                      // the server's Upload object
    this.sent = 0;
    this.speed = 0;
    this.error = null;
    this.retries = 0;
    this.xhr = null;
    this.aborted = false;
    this.samples = [];
    this.running = false;
  }

  get id() {
    return this.upload ? this.upload.id : null;
  }

  get done() {
    return this.state === "done";
  }

  get busy() {
    return ["creating", "uploading", "completing"].includes(this.state);
  }

  get fraction() {
    return this.file.size ? Math.min(1, this.sent / this.file.size) : 0;
  }

  start() {
    if (this.running || this.aborted || this.done) return;
    this.run();
  }

  retry() {
    this.error = null;
    this.retries = 0;
    this.start();
  }

  abort() {
    this.aborted = true;
    this.state = "aborted";
    if (this.xhr) this.xhr.abort();
  }

  /* Forget the upload on the server (best effort): used when a file is replaced or removed. */
  discard() {
    const id = this.id;
    this.abort();
    if (id) del(`/api/uploads/${id}`).catch(() => {});
  }

  emit() {
    if (!this.aborted) this.onUpdate(this);
  }

  sample() {
    const now = performance.now();
    const last = this.samples[this.samples.length - 1];
    if (last && this.sent < last.bytes) this.samples = [];          // went back (a retry)
    this.samples.push({ t: now, bytes: this.sent });
    while (this.samples.length > 2 && now - this.samples[0].t > SPEED_WINDOW_MS) this.samples.shift();
    const first = this.samples[0];
    const dt = (now - first.t) / 1000;
    if (dt > 0.2) this.speed = (this.sent - first.bytes) / dt;
  }

  async run() {
    this.running = true;
    try {
      await this.loop();
    } catch (e) {
      if (!this.aborted) {
        this.state = "error";
        this.error = e instanceof ApiError ? e : new ApiError(0, "client", String(e && e.message));
        this.emit();
      }
    } finally {
      this.running = false;
    }
  }

  async loop() {
    const { file } = this;
    if (this.upload) {
      // resume: ask the server how much it has (a 404 means start over)
      try {
        this.upload = await get(`/api/uploads/${this.upload.id}`);
      } catch (e) {
        if (e.code !== "not_found") throw e;
        this.upload = null;
      }
    }
    if (!this.upload) {
      this.state = "creating";
      this.emit();
      this.upload = await post("/api/uploads", { filename: file.name, size: file.size });
    }
    if (this.aborted) return;
    for (;;) {
      if (this.upload.complete) break;
      let offset = this.upload.received;
      this.sent = offset;
      this.samples = [];
      this.state = "uploading";
      this.emit();
      let mismatches = 0;
      while (offset < file.size) {
        if (this.aborted) return;
        const blob = file.slice(offset, Math.min(offset + this.chunkSize, file.size));
        try {
          this.upload = await this.put(offset, blob);
          offset = this.upload.received;
          this.sent = offset;
          this.retries = 0;
          this.emit();
        } catch (e) {
          if (this.aborted) return;
          if (e.code === "offset_mismatch" && mismatches < 5) {
            mismatches += 1;
            this.upload = await get(`/api/uploads/${this.upload.id}`);
            offset = this.upload.received;
            this.sent = offset;
            continue;
          }
          if (e.code === "upload_complete") {
            this.upload = await get(`/api/uploads/${this.upload.id}`);
            break;
          }
          if (!retryable(e)) throw e;
          this.sent = offset;                // what the server has confirmed, not what was sent
          this.samples = [];
          this.speed = 0;
          if (this.retries >= MAX_RETRIES) {
            this.state = "stalled";
            this.error = e;
            this.emit();
            return;
          }
          this.state = "uploading";
          this.error = e;
          this.emit();
          await sleep(BACKOFF_MS[this.retries] || 4000);
          this.retries += 1;
        }
      }
      if (this.aborted) return;
      this.state = "completing";
      this.error = null;
      this.emit();
      try {
        this.upload = await post(`/api/uploads/${this.upload.id}/complete`, {});
      } catch (e) {
        if (e.code !== "upload_incomplete") throw e;
        this.upload = await get(`/api/uploads/${this.upload.id}`);
        continue;                            // send what is missing
      }
      break;
    }
    if (this.aborted) return;
    this.sent = file.size;
    this.state = "done";
    this.error = null;
    this.emit();
  }

  put(offset, blob) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      this.xhr = xhr;
      xhr.open("PUT", `/api/uploads/${this.upload.id}?offset=${offset}`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.setRequestHeader("Accept", "application/json");
      xhr.upload.onprogress = (ev) => {
        this.sent = offset + ev.loaded;
        this.sample();
        this.emit();
      };
      xhr.onload = () => {
        this.xhr = null;
        let data = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          data = null;
        }
        if (xhr.status >= 200 && xhr.status < 300 && data) {
          resolve(data);
          return;
        }
        const err = data ? errorFrom(xhr.status, data)
          : new ApiError(xhr.status || 0, "network", NETWORK_MESSAGE);
        if (xhr.status === 401) unauthorizedHandler(err);
        reject(err);
      };
      xhr.onerror = () => {
        this.xhr = null;
        reject(new ApiError(0, "network", "The connection dropped while sending a chunk."));
      };
      xhr.onabort = () => {
        this.xhr = null;
        reject(new ApiError(0, "aborted", "Upload cancelled."));
      };
      xhr.send(blob);
    });
  }
}
