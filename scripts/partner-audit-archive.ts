import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, fsyncSync,
  lstatSync, mkdirSync, renameSync, unlinkSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { readBoundedResponse } from "../packages/application/src/partner/bounded-response";

// Internal scheduled client: only a staff session file, never DB/AS credentials.
// Storage must be provisioned private beforehand. No automatic deletion of audit.
async function main() {
  const base = new URL(process.env.PARTNER_CONTROL_BASE_URL!);
  const directory = resolve(process.env.PARTNER_AUDIT_ARCHIVE_DIRECTORY!);
  const merchant = process.env.PARTNER_AUDIT_MERCHANT_ID!;
  const integration = process.env.PARTNER_AUDIT_INTEGRATION_ID!;
  const interval = Number(process.env.PARTNER_AUDIT_ARCHIVE_INTERVAL_MS);
  const port = Number(process.env.PARTNER_AUDIT_ARCHIVE_HEALTH_PORT);
  const initialFrom = process.env.PARTNER_AUDIT_ARCHIVE_FROM!;
  const validId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  if (!validId.test(merchant) || !validId.test(integration) || !Number.isFinite(Date.parse(initialFrom))
    || !Number.isInteger(interval) || interval < 1000 || interval > 86400000
    || !Number.isInteger(port) || port < 1024 || port > 65535
    || base.username || base.password || base.search || base.hash || base.pathname !== "/"
    || (base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)))) {
    throw new Error("Invalid archive configuration");
  }
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) {
    throw new Error("Private archive directory required");
  }
  const readPrivate = (path: string, maximum: number) => {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > maximum) throw new Error("Unsafe file");
      return readFileSync(fd, "utf8");
    } finally { closeSync(fd); }
  };
  const writePrivate = (path: string, value: string) => {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  };
  const syncDirectory = (path: string) => {
    const fd = openSync(path, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); }
  };
  const lock = join(directory, ".archive.lock");
  writePrivate(lock, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  let stopping = false, running = false, ready = false, ticks = 0, failures = 0;
  let lastTick: string | null = null, timer: ReturnType<typeof setTimeout> | undefined;
  let lastError: string | null = null;
  const statePath = join(directory, "checkpoint.json");
  let from = new Date(initialFrom).toISOString();
  const server = createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/health") { res.writeHead(404).end(); return; }
    const healthy = ready && !stopping && !!lastTick && Date.now() - Date.parse(lastTick) < Math.max(15000, interval * 2);
    res.writeHead(healthy ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ready: healthy, running, ticks, failures, last_tick: lastTick, error_code: lastError }));
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  let stage = "archive_startup_failed";
  try {
    try {
      const state = JSON.parse(readPrivate(statePath, 8192));
      if (state.merchant_id !== merchant || state.integration_id !== integration || state.base_url !== base.href
        || !Number.isFinite(Date.parse(state.to))) throw new Error("Checkpoint scope mismatch");
      from = new Date(state.to).toISOString();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", done); });
    async function tick() {
      running = true;
      let run: string | undefined, published = false;
      // Leave a commit lag and overlap repeated windows. Audit timestamps can
      // precede COMMIT; consumers deduplicate event IDs across manifests.
      const windowFrom = new Date(Math.max(Date.parse(initialFrom), Date.parse(from) - 60000)).toISOString();
      const to = new Date(Math.min(Date.now() - 60000, Date.parse(windowFrom) + 31 * 86400000)).toISOString();
      try {
        stage = "audit_archive_window_invalid";
        if (Date.parse(windowFrom) >= Date.parse(to)) throw new Error("Invalid checkpoint");
        run = join(directory, `run-${randomUUID()}`);
        mkdirSync(run, { mode: 0o700 });
        const pages: Array<{ file: string; sha256: string; rows: number; audit_id: string; request_id: string }> = [];
        let after: string | null = null;
        const cursors = new Set<string>();
        for (let page = 1; page <= 1000; page++) {
          if (stopping) { stage = "audit_archive_interrupted"; throw new Error("Stopping"); }
          stage = "staff_session_invalid";
          const token = readPrivate(process.env.PARTNER_STAFF_TOKEN_FILE!, 8192).trim();
          if (!/^[A-Za-z0-9_.-]{16,8192}$/.test(token)) throw new Error("Invalid session");
          stage = "audit_export_unavailable";
          const response = await fetch(new URL(`/platform/admin/merchants/${encodeURIComponent(merchant)}/partner-audit`, base), {
            method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ integration_id: integration, from: windowFrom, to, limit: 200, ...(after ? { after_id: after } : {}) }),
            signal: AbortSignal.timeout(10000), redirect: "error",
          });
          if (!response.ok) throw new Error("Export rejected");
          stage = "audit_export_integrity_failed";
          const result = JSON.parse(await readBoundedResponse(response, 524288));
          const { data, meta } = result;
          if (typeof data?.content !== "string" || Buffer.byteLength(data.content) > 262144
            || createHash("sha256").update(data.content).digest("hex") !== data.sha256
            || typeof meta?.audit_id !== "string" || typeof meta?.request_id !== "string") throw new Error("Invalid checksum/receipt");
          const content = JSON.parse(data.content);
          if (content.merchant_id !== merchant || content.integration_id !== integration || content.from !== windowFrom || content.to !== to
            || content.after_id !== after || !Array.isArray(content.rows) || content.rows.length !== data.row_count
            || content.next_after_id !== data.next_after_id) throw new Error("Wrong archive scope");
          stage = "audit_archive_storage_failed";
          const file = `page-${String(page).padStart(4, "0")}.json`;
          writePrivate(join(run, file), data.content);
          pages.push({ file, sha256: data.sha256, rows: data.row_count, audit_id: meta.audit_id, request_id: meta.request_id });
          after = data.next_after_id;
          if (after === null) break;
          if (typeof after !== "string" || cursors.has(after) || page === 1000) throw new Error("Page bound exceeded");
          cursors.add(after);
        }
        const manifest = { schema_version: 1, merchant_id: merchant, integration_id: integration, base_url: base.href, from: windowFrom, to,
          completed_at: new Date().toISOString(), pages, retention_lock: false, commit_lag_ms: 60000, overlap_ms: 60000 };
        writePrivate(join(run, "manifest.json"), JSON.stringify(manifest)); syncDirectory(run); published = true;
        const pending = join(directory, `checkpoint-${randomUUID()}.tmp`);
        writePrivate(pending, JSON.stringify({ ...manifest, pages: undefined, run: run.slice(directory.length + 1) }));
        renameSync(pending, statePath); syncDirectory(directory);
        from = to; ready = true; ticks++; lastError = null;
        console.log(JSON.stringify({ service: "partner-audit-archive", outcome: "archived", pages: pages.length,
          rows: pages.reduce((n, page) => n + page.rows, 0) }));
      } catch {
        ready = false; failures++; lastError = stage;
        console.error(JSON.stringify({ service: "partner-audit-archive", outcome: "alert", error_code: stage }));
      } finally {
        // Never accumulate empty/partial runs on every failed scheduled tick.
        // A completed manifest survives a later checkpoint error for recovery.
        if (run && !published) try { rmSync(run, { recursive: true, force: true }); } catch { /* Storage alert remains unhealthy. */ }
        running = false; lastTick = new Date().toISOString();
        if (!stopping) timer = setTimeout(tick, interval);
      }
    }
    await new Promise<void>(done => {
      const stop = async () => {
        if (stopping) return;
        stopping = true; clearTimeout(timer); server.close();
        while (running) await new Promise(resolve => setTimeout(resolve, 50));
        done();
      };
      process.once("SIGTERM", () => { void stop(); }); process.once("SIGINT", () => { void stop(); });
      void tick();
    });
  } finally { server.close(); unlinkSync(lock); }
}
void main().catch(() => {
  console.error(JSON.stringify({ service: "partner-audit-archive", outcome: "startup_failed" })); process.exitCode = 1;
});
