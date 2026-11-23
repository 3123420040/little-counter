import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createPartnerProductionReadinessHandler } from "../packages/application/src/partner/production-readiness";
import { buildPlatformMcpReplicaReadinessV1 } from "../packages/application/src/partner/platform-mcp-readiness";
import { mkdirSync } from "node:fs";
import { Pool } from "pg";
import { createPartnerRedis } from "../packages/application/src/partner/quota";
import {
  readPrivateFile,
  validateProcessConfig,
  partnerProcessModes,
  type PartnerProcessMode,
} from "./partner-production-config";

async function main() {
  process.umask(0o077);
  const mode = process.argv[2] as PartnerProcessMode;
  if (!partnerProcessModes.includes(mode) || mode === "staff")
    throw Error("Invalid production process");
  const configRaw = readPrivateFile("/run/partner/env.json");
  const config = validateProcessConfig(mode, JSON.parse(configRaw));
  // Only the assigned process's mount is read. Image build identity cannot be
  // overridden through private deployment configuration.
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "TMPDIR",
    "LANG",
    "TZ",
    "BUILD_SOURCE_COMMIT",
    "BUILD_RELEASE_ID",
    "BUILD_ROUTE_CAPABILITIES",
    "BUILD_COMPATIBILITY_FAMILY",
    "NODE_EXTRA_CA_CERTS",
    "PLATFORM_MCP_API_IMAGE",
  ])
    if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, config, {
    NODE_ENV: "production",
    PARTNER_PRIVATE_BIND_HOST: "0.0.0.0",
    // The host bind-mount UID need not exist in the container passwd file.
    // Medusa CLI/configstore must use the writable private tmpfs, not /.
    HOME: "/tmp",
    XDG_CONFIG_HOME: "/tmp/.config",
  });
  if (mode === "retention") {
    const backend = process.env.PARTNER_COLLECTOR_BACKEND_DIRECTORY;
    if (config.PARTNER_ENVIRONMENT === "production" &&
        backend !== "/var/lib/partner/collector-backend")
      throw Error("Missing private collector backend mount");
    if (backend) env.PARTNER_COLLECTOR_BACKEND_DIRECTORY = backend;
  }
  let stopReadiness: (() => Promise<void>) | undefined;
  if (mode === "api") {
    Object.assign(env, {
      MEDUSA_ADMIN_DISABLED: "true",
      PLATFORM_RUNTIME_SCHEMA_BOOTSTRAP_ENABLED: "false",
      RUNTIME_SCHEMA_DDL_ENABLED: "false",
      PLATFORM_DEMO_SEED: "false",
      PUBLIC_SIGNUP_ENABLED: "false",
      SMTP_DISABLED: "true",
      SEPAY_LIVE_ENABLED: "false",
      NOWPAYMENTS_LIVE_ENABLED: "false",
      VISION_FEATURE_ENABLED: "false",
      PRODUCT_RESEARCH_ENABLED: "false",
      PRODUCT_IMAGE_AUTOFILL_ENABLED: "false",
      PARTNER_TELEMETRY_DIRECTORY: "/var/lib/partner/telemetry",
      PARTNER_TELEMETRY_ENDPOINT: "http://partner-collector:4318",
    });
    mkdirSync(env.PARTNER_TELEMETRY_DIRECTORY!, {
      recursive: true,
      mode: 0o700,
    });
    const pool = new Pool({
      connectionString: config.PARTNER_DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 1000,
      statement_timeout: 1000,
    });
    pool.on("error", () => undefined);
    const corePools = [config.DATABASE_URL, config.REPORT_DATABASE_URL].map(
      (connectionString) => {
        const dependency = new Pool({
          connectionString,
          max: 1,
          connectionTimeoutMillis: 1000,
          statement_timeout: 1000,
        });
        dependency.on("error", () => undefined);
        return dependency;
      },
    );
    const redis = createPartnerRedis(config.PARTNER_REDIS_URL);
    void redis.connect().catch(() => undefined);
    const instanceId = randomUUID();
    const server = createServer(createPartnerProductionReadinessHandler({
      apiPool: pool, corePools, redis, jwksUrl: config.PARTNER_OAUTH_JWKS_URL,
      buildMcpReadiness: async () => {
        const schema = await pool.query("SELECT integration.platform_mcp_schema_fingerprint() AS fingerprint");
        return buildPlatformMcpReplicaReadinessV1({ environment: env, instanceId,
          schemaFingerprintSha256: schema.rows[0].fingerprint, configRaw,
          fingerprintsRaw: readPrivateFile(config.PARTNER_FINGERPRINT_KEYS_FILE) });
      },
    }));
    server.requestTimeout = 3000;
    server.headersTimeout = 3000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(9001, "0.0.0.0", resolve);
    });
    stopReadiness = async () => {
      server.close();
      redis.disconnect();
      await Promise.all([
        pool.end(),
        ...corePools.map((dependency) => dependency.end()),
      ]);
    };
  }
  const files: Record<string, string> = {
    reconciler: "partner-control-reconciler.ts",
    retention: "partner-retention.ts",
    observer: "partner-observability-service.ts",
    alerts: "partner-alert-delivery.ts",
  };
  const executable =
    mode === "api" ? "/app/scripts/start-medusa.sh" : process.execPath;
  const args =
    mode === "api"
      ? ["--host", "0.0.0.0", "--port", "9000"]
      : ["--import", "tsx", `/app/scripts/${files[mode]}`];
  const child = spawn(executable, args, { env, cwd: "/app", stdio: "inherit" });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    child.kill("SIGTERM");
    void stopReadiness?.();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  child.once("error", () => {
    void stopReadiness?.();
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    void stopReadiness?.();
    process.exitCode = code ?? 1;
  });
}
void main().catch(() => {
  console.error(
    "Partner production startup failed; private configuration withheld",
  );
  process.exitCode = 1;
});
