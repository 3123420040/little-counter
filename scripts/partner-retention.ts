import { createServer } from "node:http";
import { Pool } from "pg";
import { maintainPartnerRetentionForClient } from "../packages/application/src/partner/maintenance";
import { partnerDatabaseTimeouts, withPartnerTransaction } from "../packages/application/src/partner/transaction";
import { enforceCollectorOutputPermissions } from "./partner-collector-output-permissions";

async function main() {
  const interval = Number(process.env.PARTNER_RETENTION_INTERVAL_MS);
  const batchSize = Number(process.env.PARTNER_RETENTION_BATCH_SIZE);
  const port = Number(process.env.PARTNER_RETENTION_HEALTH_PORT);
  const environment = process.env.PARTNER_ENVIRONMENT;
  if (!Number.isInteger(interval) || interval < 1000 || interval > 60000
    || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500
    || !Number.isInteger(port) || port < 1024 || port > 65535
    || !process.env.PARTNER_MAINTENANCE_DATABASE_URL || !["sandbox", "production"].includes(environment ?? "")) {
    throw new Error("Missing bounded retention config");
  }
  const collectorBackend = process.env.PARTNER_COLLECTOR_BACKEND_DIRECTORY;
  if (environment === "production" &&
      collectorBackend !== "/var/lib/partner/collector-backend") {
    throw new Error("Missing private collector backend mount");
  }
  const pool = new Pool({ connectionString: process.env.PARTNER_MAINTENANCE_DATABASE_URL, max: 1,
    connectionTimeoutMillis: 1000, ...partnerDatabaseTimeouts, application_name: "partner-retention" });
  pool.on("error", () => undefined);
  try {
    const role = await pool.query(`SELECT NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls)
      AND pg_has_role(current_user,'snus_partner_maintenance','MEMBER') AS allowed FROM pg_roles WHERE rolname=current_user`);
    if (!role.rows[0]?.allowed) throw new Error("Unsafe retention role");
  } catch (error) { await pool.end(); throw error; }
  let stopping = false; let running = false; let ready = false;
  let lastTick: string | null = null; let ticks = 0; let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const server = createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/health") { res.writeHead(404).end(); return; }
    const healthy = !stopping && ready && !!lastTick && Date.now() - Date.parse(lastTick) < Math.max(15000, interval * 3);
    res.writeHead(healthy ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ready: healthy, running, last_tick: lastTick, interval_ms: interval, batch_size: batchSize, ticks, failures }));
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, process.env.PARTNER_PRIVATE_BIND_HOST === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1", resolve); });
  } catch (error) { await pool.end(); throw error; }
  async function tick() {
    running = true;
    try {
      const repaired = collectorBackend
        ? enforceCollectorOutputPermissions(collectorBackend)
        : 0;
      const result = await withPartnerTransaction(pool, db => maintainPartnerRetentionForClient(db, batchSize));
      ready = true; ticks++;
      if (repaired > 0) {
        console.log(JSON.stringify({ timestamp: new Date().toISOString(),
          service: "partner-retention", environment,
          outcome: "collector_permissions_repaired", repaired }));
      }
      if (result.tombstones + result.contacts + result.quotes > 0) {
        console.log(JSON.stringify({ timestamp: new Date().toISOString(), service: "partner-retention", environment, ...result }));
      }
    } catch {
      ready = false; failures++;
      console.log(JSON.stringify({ timestamp: new Date().toISOString(), service: "partner-retention", environment, outcome: "dependency_unavailable" }));
    } finally {
      lastTick = new Date().toISOString(); running = false;
      if (!stopping) timer = setTimeout(tick, interval);
    }
  }
  async function stop() {
    if (stopping) return;
    stopping = true; clearTimeout(timer); server.close();
    while (running) await new Promise(resolve => setTimeout(resolve, 50));
    await pool.end();
  }
  process.once("SIGTERM", () => { void stop(); }); process.once("SIGINT", () => { void stop(); });
  console.log(JSON.stringify({ service: "partner-retention", environment, outcome: "started", interval_ms: interval, batch_size: batchSize, health_port: port }));
  await tick();
}
void main().catch(() => { console.error(JSON.stringify({ service: "partner-retention", outcome: "startup_failed" })); process.exitCode = 1; });
