import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { readPrivateFile } from "./partner-production-config";
import { persistLocalAlert, pruneLocalAlertInbox, type LocalAlertEvent } from "./partner-local-alert-inbox";

export interface AlertRow {
  alert_key: string;
  code: string;
  active: boolean;
  first_seen: string;
  last_seen: string;
}
export function alertDeliveryKey(row: AlertRow, occurrence = 0): string {
  return createHash("sha256")
    .update(
      JSON.stringify([row.alert_key, row.active, row.first_seen, occurrence]),
    )
    .digest("hex");
}
async function main() {
  process.umask(0o077);
  const mode = process.env.PARTNER_ALERT_DELIVERY_MODE ?? "https-webhook";
  const local = mode === "local-inbox";
  const endpoint = new URL(process.env.PARTNER_ALERT_WEBHOOK_URL!);
  if (
    !["https-webhook", "local-inbox"].includes(mode) ||
    (local ? endpoint.href !== "file:///var/lib/partner/alerts/inbox" : endpoint.protocol !== "https:") ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash
  )
    throw Error("Invalid destination");
  const owner = process.env.PARTNER_ALERT_PRIMARY_OWNER,
    backup = process.env.PARTNER_ALERT_BACKUP_OWNER;
  const interval = Number(process.env.PARTNER_ALERT_INTERVAL_MS),
    reminder = Number(process.env.PARTNER_ALERT_REMINDER_SECONDS);
  const port = Number(process.env.PARTNER_ALERT_HEALTH_PORT),
    directory = process.env.PARTNER_ALERT_STATE_DIRECTORY!;
  if (
    !owner ||
    !backup ||
    !Number.isInteger(interval) ||
    interval < 1000 ||
    interval > 60000 ||
    !Number.isInteger(reminder) ||
    reminder < 60 ||
    reminder > 86400 ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    !directory
  )
    throw Error("Missing bounded alert policy");
  const token = local ? "" : readPrivateFile(process.env.PARTNER_ALERT_TOKEN_FILE!).trim();
  if (!local && (token.length < 32 || /\s/.test(token)))
    throw Error("Invalid destination token");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, "delivery-state.json");
  const state: Record<
    string,
    { key: string; deliveredAt: number; occurrence?: number }
  > = existsSync(file) ? JSON.parse(readPrivateFile(file)) : {};
  const pool = new Pool({
    connectionString: process.env.PARTNER_ALERT_DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 1000,
    statement_timeout: 2000,
  });
  pool.on("error", () => undefined);
  let role;
  try {
    role = await pool.query(
      "SELECT NOT(rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls) AND rolname='snus_partner_prod_alerts' allowed FROM pg_roles WHERE rolname=current_user",
    );
  } catch (error) {
    await pool.end();
    throw error;
  }
  if (!role.rows[0]?.allowed) {
    await pool.end();
    throw Error("Unsafe alert role");
  }
  let stopping = false,
    running = false,
    ready = false,
    lastTick = 0,
    failures = 0,
    delivered = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const server = createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/health") {
      res.writeHead(404).end();
      return;
    }
    const healthy =
      ready &&
      !stopping &&
      Date.now() - lastTick < Math.max(15000, interval * 3);
    res
      .writeHead(healthy ? 200 : 503, { "content-type": "application/json" })
      .end(JSON.stringify({ ready: healthy, delivered, failures, deliveryMode: mode, externalPaging: !local }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });
  async function tick() {
    running = true;
    try {
      const rows = await pool.query<AlertRow>(
        "SELECT alert_key,code,active,first_seen::text,last_seen::text FROM observability.partner_alerts WHERE detail->>'environment'='production' ORDER BY alert_key LIMIT 1001",
      );
      if (rows.rows.length > 1000) throw Error("Alert capacity exceeded");
      const keys = new Set(rows.rows.map((row) => row.alert_key));
      if (local) pruneLocalAlertInbox(directory, keys);
      for (const key of Object.keys(state))
        if (!keys.has(key)) delete state[key];
      for (const row of rows.rows) {
        const key = alertDeliveryKey(row),
          prior = state[row.alert_key];
        if (!row.active && !prior) continue;
        if (
          prior?.key === key &&
          (!row.active || Date.now() - prior.deliveredAt < reminder * 1000)
        )
          continue;
        const occurrence = prior?.key === key ? (prior.occurrence ?? 0) + 1 : 0;
        const deliveryKey = alertDeliveryKey(row, occurrence);
        const event: LocalAlertEvent = {
          schema_version: 1,
          environment: "production",
          event: row.active ? "alert" : "recovery",
          delivery_key: deliveryKey,
          alert_key: row.alert_key,
          code: row.code,
          first_seen: row.first_seen,
          last_seen: row.last_seen,
          primary_owner: owner!,
          backup_owner: backup!,
        };
        if (local) persistLocalAlert(directory, event);
        else {
        const response = await fetch(endpoint, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(3000),
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
            "idempotency-key": deliveryKey,
          },
          body: JSON.stringify(event),
        });
        await response.body?.cancel();
        if (!response.ok) throw Error("Alert delivery failed");
        }
        state[row.alert_key] = { key, deliveredAt: Date.now(), occurrence };
        writeFileSync(`${file}.tmp`, JSON.stringify(state), {
          mode: 0o600,
          flush: true,
        });
        renameSync(`${file}.tmp`, file);
        delivered++;
      }
      ready = true;
    } catch {
      ready = false;
      failures++;
      console.error(
        JSON.stringify({
          service: "partner-alert-delivery",
          outcome: "delivery_failed",
        }),
      );
    } finally {
      running = false;
      lastTick = Date.now();
      if (!stopping) timer = setTimeout(tick, interval);
    }
  }
  async function stop() {
    stopping = true;
    clearTimeout(timer);
    server.close();
    while (running) await new Promise((resolve) => setTimeout(resolve, 50));
    await pool.end();
  }
  process.once("SIGTERM", () => {
    void stop();
  });
  process.once("SIGINT", () => {
    void stop();
  });
  await tick();
}
if (process.argv[1]?.endsWith("partner-alert-delivery.ts"))
  void main().catch(() => {
    console.error(
      "Partner alert delivery startup failed; configuration withheld",
    );
    process.exitCode = 1;
  });
