import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { buildServer } from "../index";
import type { ExactOutboxWorkerObserver } from "../worker/exact-outbox-worker";
import {
  EXACT_OUTBOX_MIGRATION_CHECKSUM,
  EXACT_OUTBOX_MIGRATION_FILENAME,
  prepareExactOutboxRuntime,
  type ExactOutboxQueueSnapshot,
  type ExactOutboxRuntimeReadiness,
} from "../worker/exact-outbox-runtime";

const evidence = {
  migrationFilename: EXACT_OUTBOX_MIGRATION_FILENAME,
  migrationChecksum: EXACT_OUTBOX_MIGRATION_CHECKSUM,
  openLegacyEventCount: 0,
} as const;

const emptySummary = {
  claimed: 0,
  completed: 0,
  intentionalNoops: 0,
  handlerFailures: 0,
  retryScheduled: 0,
  deadLettered: 0,
  staleClaims: 0,
  transitionErrors: 0,
  skippedBecauseBusy: false,
};

const emptyQueue: ExactOutboxQueueSnapshot = {
  openExactEventCount: 0,
  actionableEventCount: 0,
  processingEventCount: 0,
  expiredLeaseCount: 0,
  blockedExactEventCount: 0,
  deadBlockedEventCount: 0,
  deadLetteredEventCount: 0,
  oldestOpenAgeSeconds: null,
  oldestActionableAgeSeconds: null,
};

describe("exact outbox readiness", () => {
  it("stays unready until a clean queue inspection, then reports degraded, recovered and stopped safely", async () => {
    let observer: ExactOutboxWorkerObserver | undefined;
    const worker = {
      runOnce: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      isRunning: vi.fn(() => false),
      isStarted: vi.fn(() => false),
    };
    let currentTime = new Date("2026-08-06T04:22:00.000Z");
    const runtime = await prepareExactOutboxRuntime({
      db: {} as Pool,
      workerId: "ai_exact_worker_test",
      verify: vi.fn(async () => evidence),
      inspect: vi.fn(async () => emptyQueue),
      factory: vi.fn((options) => {
        observer = options.observer;
        return worker;
      }),
      now: () => currentTime,
      maxActionableAgeSeconds: 300,
      maxNoProgressSeconds: 60,
      maxBatchRuntimeSeconds: 240,
    });

    expect(runtime.getReadiness()).toMatchObject({
      ready: false,
      mode: "exact_v1",
      state: "prepared",
      migrationFilename: EXACT_OUTBOX_MIGRATION_FILENAME,
      migrationChecksum: EXACT_OUTBOX_MIGRATION_CHECKSUM,
      lastSuccessfulBatchAt: null,
      lastFailureAt: null,
      lastFailureClass: null,
      lastQueueCheckAt: null,
      lastProgressAt: null,
      queue: null,
    });

    runtime.start();
    expect(worker.start).toHaveBeenCalledOnce();
    expect(runtime.getReadiness()).toMatchObject({ ready: false, state: "prepared" });

    await observer?.onBatchCompleted(emptySummary);
    expect(runtime.getReadiness()).toMatchObject({
      ready: true,
      state: "running",
      lastSuccessfulBatchAt: "2026-08-06T04:22:00.000Z",
      lastQueueCheckAt: "2026-08-06T04:22:00.000Z",
      queue: emptyQueue,
    });

    currentTime = new Date("2026-08-06T04:22:01.000Z");
    await observer?.onBatchFailed("DatabaseError");
    expect(runtime.getReadiness()).toMatchObject({
      ready: false,
      state: "degraded",
      lastFailureAt: "2026-08-06T04:22:01.000Z",
      lastFailureClass: "DatabaseError",
    });
    expect(JSON.stringify(runtime.getReadiness())).not.toContain("secret");

    currentTime = new Date("2026-08-06T04:22:02.000Z");
    await observer?.onBatchCompleted(emptySummary);
    expect(runtime.getReadiness()).toMatchObject({
      ready: true,
      state: "running",
      lastSuccessfulBatchAt: "2026-08-06T04:22:02.000Z",
      lastFailureClass: null,
    });

    currentTime = new Date("2026-08-06T04:22:03.000Z");
    await observer?.onBatchCompleted({ ...emptySummary, transitionErrors: 1 });
    expect(runtime.getReadiness()).toMatchObject({
      ready: false,
      state: "degraded",
      lastFailureAt: "2026-08-06T04:22:03.000Z",
      lastFailureClass: "OutboxTransitionError",
    });

    runtime.stop();
    expect(worker.stop).toHaveBeenCalledOnce();
    expect(runtime.getReadiness()).toMatchObject({ ready: false, state: "stopped" });
  });

  it("fails readiness on blocked chains, expired leases and actionable backlog age, then recovers", async () => {
    let observer: ExactOutboxWorkerObserver | undefined;
    let queue: ExactOutboxQueueSnapshot = {
      ...emptyQueue,
      openExactEventCount: 3,
      actionableEventCount: 3,
      oldestOpenAgeSeconds: 301,
      oldestActionableAgeSeconds: 301,
    };
    const runtime = await prepareExactOutboxRuntime({
      db: {} as Pool,
      workerId: "ai_exact_worker_budget_test",
      verify: vi.fn(async () => evidence),
      inspect: vi.fn(async () => queue),
      factory: vi.fn((options) => {
        observer = options.observer;
        return {
          runOnce: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          isRunning: vi.fn(() => false),
          isStarted: vi.fn(() => false),
        };
      }),
      now: () => new Date("2026-08-06T04:30:00.000Z"),
      maxActionableAgeSeconds: 300,
      maxNoProgressSeconds: 60,
      maxBatchRuntimeSeconds: 240,
    });

    await observer?.onBatchCompleted(emptySummary);
    expect(runtime.getReadiness()).toMatchObject({
      ready: false,
      state: "degraded",
      lastFailureClass: "OutboxBacklogAgeExceeded",
    });

    queue = {
      ...emptyQueue,
      openExactEventCount: 1,
      blockedExactEventCount: 1,
      deadBlockedEventCount: 1,
      deadLetteredEventCount: 1,
      oldestOpenAgeSeconds: 12,
    };
    await observer?.onBatchCompleted(emptySummary);
    expect(runtime.getReadiness()).toMatchObject({
      ready: false,
      lastFailureClass: "OutboxBlockedChain",
    });

    queue = {
      ...emptyQueue,
      openExactEventCount: 1,
      processingEventCount: 1,
      expiredLeaseCount: 1,
      oldestOpenAgeSeconds: 12,
    };
    await observer?.onBatchCompleted(emptySummary);
    expect(runtime.getReadiness()).toMatchObject({
      ready: false,
      lastFailureClass: "OutboxExpiredLease",
    });

    queue = emptyQueue;
    await observer?.onBatchCompleted(emptySummary);
    expect(runtime.getReadiness()).toMatchObject({
      ready: true,
      state: "running",
      lastFailureClass: null,
    });
  });

  it("fails readiness when an actionable queue makes no progress or one batch stays busy past budget", async () => {
    let observer: ExactOutboxWorkerObserver | undefined;
    let currentTime = new Date("2026-08-06T04:40:00.000Z");
    const actionableQueue: ExactOutboxQueueSnapshot = {
      ...emptyQueue,
      openExactEventCount: 2,
      actionableEventCount: 2,
      oldestOpenAgeSeconds: 10,
      oldestActionableAgeSeconds: 10,
    };
    const runtime = await prepareExactOutboxRuntime({
      db: {} as Pool,
      workerId: "ai_exact_worker_progress_test",
      verify: vi.fn(async () => evidence),
      inspect: vi.fn(async () => actionableQueue),
      factory: vi.fn((options) => {
        observer = options.observer;
        return {
          runOnce: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          isRunning: vi.fn(() => false),
          isStarted: vi.fn(() => false),
        };
      }),
      now: () => currentTime,
      maxActionableAgeSeconds: 300,
      maxNoProgressSeconds: 60,
      maxBatchRuntimeSeconds: 240,
    });

    await observer?.onBatchCompleted(emptySummary);
    expect(runtime.getReadiness()).toMatchObject({ ready: true, state: "running" });

    currentTime = new Date("2026-08-06T04:41:01.000Z");
    await observer?.onBatchCompleted(emptySummary);
    expect(runtime.getReadiness()).toMatchObject({
      ready: false,
      state: "degraded",
      lastFailureClass: "OutboxProgressStalled",
    });

    currentTime = new Date("2026-08-06T04:42:00.000Z");
    await observer?.onBatchCompleted({
      ...emptySummary,
      claimed: 1,
      completed: 1,
    });
    expect(runtime.getReadiness()).toMatchObject({
      ready: true,
      state: "running",
      lastProgressAt: "2026-08-06T04:42:00.000Z",
    });

    currentTime = new Date("2026-08-06T04:43:00.000Z");
    await observer?.onBatchCompleted({ ...emptySummary, skippedBecauseBusy: true });
    currentTime = new Date("2026-08-06T04:47:01.000Z");
    await observer?.onBatchCompleted({ ...emptySummary, skippedBecauseBusy: true });
    expect(runtime.getReadiness()).toMatchObject({
      ready: false,
      state: "degraded",
      lastFailureClass: "OutboxBatchStalled",
    });
  });

  it("fails closed when the bounded queue inspection fails", async () => {
    let observer: ExactOutboxWorkerObserver | undefined;
    const runtime = await prepareExactOutboxRuntime({
      db: {} as Pool,
      workerId: "ai_exact_worker_probe_failure_test",
      verify: vi.fn(async () => evidence),
      inspect: vi.fn(async () => {
        throw new Error("password=secret query detail");
      }),
      factory: vi.fn((options) => {
        observer = options.observer;
        return {
          runOnce: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          isRunning: vi.fn(() => false),
          isStarted: vi.fn(() => false),
        };
      }),
      now: () => new Date("2026-08-06T04:50:00.000Z"),
    });

    await observer?.onBatchCompleted(emptySummary);
    expect(runtime.getReadiness()).toMatchObject({
      ready: false,
      state: "degraded",
      lastFailureClass: "OutboxQueueProbeError",
    });
    expect(JSON.stringify(runtime.getReadiness())).not.toContain("secret");
  });

  it("keeps liveness stable while readiness fails closed on exact worker degradation", async () => {
    let readiness: ExactOutboxRuntimeReadiness = {
      ready: false,
      mode: "exact_v1",
      state: "degraded",
      migrationFilename: EXACT_OUTBOX_MIGRATION_FILENAME,
      migrationChecksum: EXACT_OUTBOX_MIGRATION_CHECKSUM,
      lastSuccessfulBatchAt: null,
      lastFailureAt: "2026-08-06T04:22:00.000Z",
      lastFailureClass: "DatabaseError",
      lastQueueCheckAt: null,
      lastProgressAt: null,
      queue: null,
      budgets: {
        maxActionableAgeSeconds: 300,
        maxNoProgressSeconds: 60,
        maxBatchRuntimeSeconds: 240,
      },
    };
    const server = await buildServer({ outboxReadiness: () => readiness });
    await server.ready();

    try {
      const live = await server.inject({ method: "GET", url: "/health" });
      expect(live.statusCode).toBe(200);
      expect(JSON.parse(live.body)).toEqual({ status: "ok", service: "ai-module" });

      const degraded = await server.inject({ method: "GET", url: "/ai/health" });
      expect(degraded.statusCode).toBe(503);
      expect(JSON.parse(degraded.body)).toEqual({
        status: "not_ready",
        service: "ai-module",
        outbox: readiness,
      });

      readiness = { ...readiness, ready: true, state: "running", lastFailureClass: null };
      const recovered = await server.inject({ method: "GET", url: "/ai/health" });
      expect(recovered.statusCode).toBe(200);
      expect(JSON.parse(recovered.body)).toMatchObject({
        status: "ok",
        outbox: { ready: true, state: "running" },
      });
    } finally {
      await server.close();
    }
  });
});
