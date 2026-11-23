import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { getDb } from "./db/client.js";
import { partnerWorkerTelemetryHealth } from "@medusa-snus/application/partner-worker-telemetry";
import {
  prepareExactOutboxRuntime,
  type ExactOutboxRuntime,
  type ExactOutboxRuntimeReadiness,
} from "./worker/exact-outbox-runtime.js";

const DEFAULT_EXACT_OUTBOX_WORKER_PORT = 3003;
const EXACT_OUTBOX_CLAIM_LEASE_SECONDS = 300;

type RuntimeEnv = Record<string, string | undefined>;

export type ExactOutboxResolvedRuntimeConfig = {
  pollIntervalMs: number;
  maxActionableAgeSeconds: number;
  maxNoProgressSeconds: number;
  maxBatchRuntimeSeconds: number;
};

type WorkerHealthServer = Pick<FastifyInstance, "addHook" | "listen" | "close">;

export type StartExactOutboxWorkerProcessOptions = {
  db?: Pool;
  workerId?: string;
  port?: number;
  host?: string;
  prepare?: typeof prepareExactOutboxRuntime;
  buildHealthServer?: (
    readiness: () => ExactOutboxRuntimeReadiness,
  ) => Promise<WorkerHealthServer>;
};

export function resolveExactOutboxWorkerPort(
  value: string | number | undefined,
): number {
  const normalized = value === undefined || value === ""
    ? DEFAULT_EXACT_OUTBOX_WORKER_PORT
    : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > 65_535) {
    throw new Error("EXACT_OUTBOX_WORKER_PORT must be an integer between 1 and 65535");
  }
  return normalized;
}

function positiveInteger(
  env: RuntimeEnv,
  name: string,
  fallback: number,
  production: boolean,
): number {
  const raw = String(env[name] ?? "").trim();
  if (!raw) {
    if (production) throw new Error(`${name} is required in production`);
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function resolveExactOutboxRuntimeConfig(
  env: RuntimeEnv = process.env,
): ExactOutboxResolvedRuntimeConfig {
  const production = env.NODE_ENV === "production";
  const config = {
    pollIntervalMs: positiveInteger(
      env,
      "EXACT_OUTBOX_POLL_INTERVAL_MS",
      2_000,
      production,
    ),
    maxActionableAgeSeconds: positiveInteger(
      env,
      "EXACT_OUTBOX_MAX_ACTIONABLE_AGE_SECONDS",
      300,
      production,
    ),
    maxNoProgressSeconds: positiveInteger(
      env,
      "EXACT_OUTBOX_MAX_NO_PROGRESS_SECONDS",
      60,
      production,
    ),
    maxBatchRuntimeSeconds: positiveInteger(
      env,
      "EXACT_OUTBOX_MAX_BATCH_RUNTIME_SECONDS",
      240,
      production,
    ),
  };
  if (config.pollIntervalMs < 100 || config.pollIntervalMs > 300_000) {
    throw new Error("EXACT_OUTBOX_POLL_INTERVAL_MS must be between 100 and 300000");
  }
  if (config.maxBatchRuntimeSeconds >= EXACT_OUTBOX_CLAIM_LEASE_SECONDS) {
    throw new Error(
      "EXACT_OUTBOX_MAX_BATCH_RUNTIME_SECONDS must be less than the 300-second claim lease",
    );
  }
  return config;
}

export async function buildExactOutboxWorkerHealthServer(
  readiness: () => ExactOutboxRuntimeReadiness,
): Promise<FastifyInstance> {
  const server = Fastify({ logger: true, disableRequestLogging: true });

  server.get("/health", async () => ({
    status: "ok",
    service: "exact-outbox-worker",
  }));
  server.get("/ready", async (_request, reply) => {
    const outbox = readiness();
    return reply.status(outbox.ready ? 200 : 503).send({
      status: outbox.ready ? "ok" : "not_ready",
      service: "exact-outbox-worker",
      outbox,
      partnerTelemetry: partnerWorkerTelemetryHealth(),
    });
  });

  return server;
}

export async function startExactOutboxWorkerProcess(
  options: StartExactOutboxWorkerProcessOptions = {},
): Promise<{
  server: WorkerHealthServer;
  runtime: ExactOutboxRuntime;
  port: number;
}> {
  const prepare = options.prepare ?? prepareExactOutboxRuntime;
  const buildHealthServer = options.buildHealthServer ?? buildExactOutboxWorkerHealthServer;
  const port = resolveExactOutboxWorkerPort(
    options.port ?? process.env.EXACT_OUTBOX_WORKER_PORT,
  );
  const runtimeConfig = resolveExactOutboxRuntimeConfig();
  const runtime = await prepare({
    db: options.db ?? getDb(),
    workerId: options.workerId ?? `exact_outbox_${randomUUID()}`,
    ...runtimeConfig,
  });
  const server = await buildHealthServer(runtime.getReadiness);

  server.addHook("onClose", async () => {
    runtime.stop();
    const deadline=Date.now()+runtimeConfig.maxBatchRuntimeSeconds*1000;
    while(runtime.isRunning() && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
    if(runtime.isRunning())throw new Error("Exact outbox shutdown drain exceeded runtime budget");
  });
  await server.listen({ port, host: options.host ?? process.env.EXACT_OUTBOX_WORKER_HOST ?? "0.0.0.0" });
  runtime.start();

  return { server, runtime, port };
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  startExactOutboxWorkerProcess().then(({ port,server }) => {
    let stopping=false;
    const stop=()=>{
      if(stopping)return;stopping=true;
      void server.close().then(()=>process.exit(0),()=>process.exit(1));
    };
    process.once("SIGTERM",stop);process.once("SIGINT",stop);
    console.log(`Exact outbox worker running with health on :${port}`);
  }).catch((error) => {
    const errorClass = error instanceof Error ? error.name : "UnknownError";
    console.error("Exact outbox worker failed to start", { errorClass });
    process.exit(1);
  });
}
