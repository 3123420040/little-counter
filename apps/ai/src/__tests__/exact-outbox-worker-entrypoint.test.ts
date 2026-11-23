import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  buildExactOutboxWorkerHealthServer,
  resolveExactOutboxRuntimeConfig,
  resolveExactOutboxWorkerPort,
  startExactOutboxWorkerProcess,
} from "../exact-outbox-worker-entrypoint";
import {
  EXACT_OUTBOX_MIGRATION_CHECKSUM,
  EXACT_OUTBOX_MIGRATION_FILENAME,
  type ExactOutboxRuntimeReadiness,
} from "../worker/exact-outbox-runtime";

function readiness(
  ready: boolean,
  state: ExactOutboxRuntimeReadiness["state"],
): ExactOutboxRuntimeReadiness {
  return {
    ready,
    mode: "exact_v1",
    state,
    migrationFilename: EXACT_OUTBOX_MIGRATION_FILENAME,
    migrationChecksum: EXACT_OUTBOX_MIGRATION_CHECKSUM,
    lastSuccessfulBatchAt: null,
    lastFailureAt: ready ? null : "2026-08-06T05:00:00.000Z",
    lastFailureClass: ready ? null : "DatabaseError",
    lastQueueCheckAt: null,
    lastProgressAt: null,
    queue: null,
    budgets: {
      maxActionableAgeSeconds: 300,
      maxNoProgressSeconds: 60,
      maxBatchRuntimeSeconds: 240,
    },
  };
}

describe("exact outbox worker-only entrypoint", () => {
  it("serves only stable liveness and fail-closed readiness", async () => {
    let current = readiness(false, "degraded");
    const server = await buildExactOutboxWorkerHealthServer(() => current);
    await server.ready();

    try {
      const live = await server.inject({ method: "GET", url: "/health" });
      expect(live.statusCode).toBe(200);
      expect(JSON.parse(live.body)).toEqual({
        status: "ok",
        service: "exact-outbox-worker",
      });

      const degraded = await server.inject({ method: "GET", url: "/ready" });
      expect(degraded.statusCode).toBe(503);
      expect(JSON.parse(degraded.body)).toMatchObject({
        status: "not_ready",
        service: "exact-outbox-worker",
        outbox: { ready: false, state: "degraded" },
      });

      expect((await server.inject({ method: "POST", url: "/ai/actions" })).statusCode)
        .toBe(404);

      current = readiness(true, "running");
      const recovered = await server.inject({ method: "GET", url: "/ready" });
      expect(recovered.statusCode).toBe(200);
      expect(JSON.parse(recovered.body)).toMatchObject({
        status: "ok",
        outbox: { ready: true, state: "running" },
      });
    } finally {
      await server.close();
    }
  });

  it("guards before listen, starts after listen and stops on close", async () => {
    const order: string[] = [];
    let closeHook: (() => Promise<void>) | undefined;
    const runtime = {
      runOnce: vi.fn(),
      isRunning: vi.fn(() => false),
      isStarted: vi.fn(() => false),
      start: vi.fn(() => order.push("start")),
      stop: vi.fn(() => order.push("stop")),
      getReadiness: vi.fn(() => readiness(false, "prepared")),
    };
    const server = {
      close: vi.fn(async()=>undefined),
      addHook: vi.fn((name: string, hook: () => Promise<void>) => {
        expect(name).toBe("onClose");
        closeHook = hook;
      }),
      listen: vi.fn(async () => {
        order.push("listen");
      }),
    };

    const result = await startExactOutboxWorkerProcess({
      db: {} as Pool,
      workerId: "exact_worker_entrypoint_test",
      port: 3103,
      prepare: vi.fn(async () => {
        order.push("guard");
        return runtime;
      }),
      buildHealthServer: vi.fn(async () => {
        order.push("build-health");
        return server;
      }),
    });

    expect(order).toEqual(["guard", "build-health", "listen", "start"]);
    expect(server.listen).toHaveBeenCalledWith({ port: 3103, host: "0.0.0.0" });
    expect(result).toEqual({ server, runtime, port: 3103 });

    await closeHook?.();
    expect(order).toEqual(["guard", "build-health", "listen", "start", "stop"]);
  });

  it("validates a dedicated worker port without reading AI_PORT", () => {
    expect(resolveExactOutboxWorkerPort(undefined)).toBe(3003);
    expect(resolveExactOutboxWorkerPort("3103")).toBe(3103);
    for (const invalid of ["0", "65536", "3003.5", "not-a-port"]) {
      expect(() => resolveExactOutboxWorkerPort(invalid)).toThrow(
        "EXACT_OUTBOX_WORKER_PORT",
      );
    }
  });

  it("requires explicit production backlog and stall budgets", () => {
    expect(() => resolveExactOutboxRuntimeConfig({ NODE_ENV: "production" })).toThrow(
      "EXACT_OUTBOX_POLL_INTERVAL_MS",
    );

    expect(resolveExactOutboxRuntimeConfig({
      NODE_ENV: "production",
      EXACT_OUTBOX_POLL_INTERVAL_MS: "2000",
      EXACT_OUTBOX_MAX_ACTIONABLE_AGE_SECONDS: "300",
      EXACT_OUTBOX_MAX_NO_PROGRESS_SECONDS: "60",
      EXACT_OUTBOX_MAX_BATCH_RUNTIME_SECONDS: "240",
    })).toEqual({
      pollIntervalMs: 2_000,
      maxActionableAgeSeconds: 300,
      maxNoProgressSeconds: 60,
      maxBatchRuntimeSeconds: 240,
    });

    expect(() => resolveExactOutboxRuntimeConfig({
      NODE_ENV: "production",
      EXACT_OUTBOX_POLL_INTERVAL_MS: "2000",
      EXACT_OUTBOX_MAX_ACTIONABLE_AGE_SECONDS: "300",
      EXACT_OUTBOX_MAX_NO_PROGRESS_SECONDS: "60",
      EXACT_OUTBOX_MAX_BATCH_RUNTIME_SECONDS: "300",
    })).toThrow("must be less than the 300-second claim lease");
  });

  it("is the dedicated production worker topology and is absent from the AI API process", () => {
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    const entrypoint = readFileSync(`${root}/apps/ai/src/exact-outbox-worker-entrypoint.ts`, "utf8");
    const apiEntrypoint = readFileSync(`${root}/apps/ai/src/index.ts`, "utf8");
    const aiPackage = readFileSync(`${root}/apps/ai/package.json`, "utf8");

    expect(entrypoint).not.toContain("registerAiRoutes");
    expect(entrypoint).not.toContain('from "./routes/');
    expect(entrypoint).not.toContain("JWT_SECRET");
    expect(entrypoint).not.toContain("AI_PORT");
    expect(entrypoint).toContain("EXACT_OUTBOX_WORKER_PORT");

    expect(apiEntrypoint).not.toContain("prepareExactOutboxRuntime(");
    expect(aiPackage).not.toContain("exact-outbox-worker-entrypoint");
  });
});
