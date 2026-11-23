import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  createExactOutboxWorker,
  processExactOutboxBatch,
  type ExactOutboxWorkerPorts,
} from "../worker/exact-outbox-worker";
import {
  StaleExactOutboxClaimError,
  type ExactClaimedOutboxEvent,
  type ExactOutboxFailureDecision,
} from "../worker/exact-outbox-primitives";

const event: ExactClaimedOutboxEvent = {
  id: "11111111-1111-4111-8111-111111111111",
  claimToken: "22222222-2222-4222-8222-222222222222",
  claimVersion: "3",
  attempts: 1,
  merchantId: "merchant_a",
  storeId: "store_a",
  aggregateType: "order",
  aggregateId: "order_1",
  aggregateSequence: "2",
  predecessorEventId: "33333333-3333-4333-8333-333333333333",
  eventType: "order.corrected",
  eventVersion: 1,
  sourceEventId: "commercial_revision:revision_2",
  sourceOccurredAt: "2026-08-04T16:00:00.000Z",
  retryPolicyKey: "financial-v1",
  payload: { correctionId: "revision_2" },
};

const retryDecision: ExactOutboxFailureDecision = {
  deadLetter: false,
  delaySeconds: 30,
  deadLetterReasonCode: null,
  errorEvidence: "UnknownHandlerError:unclassified_handler_failure",
  failureFingerprint: "a".repeat(64),
};

const deadLetterDecision: ExactOutboxFailureDecision = {
  deadLetter: true,
  delaySeconds: null,
  deadLetterReasonCode: "permanent_failure",
  errorEvidence: "ExactOutboxContractError:unsupported_event_type",
  failureFingerprint: "b".repeat(64),
};

function ports(overrides: Partial<ExactOutboxWorkerPorts> = {}): ExactOutboxWorkerPorts {
  return {
    claim: vi.fn(async () => [event]),
    classify: vi.fn(() => ({ process: true as const })),
    process: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined),
    fail: vi.fn(async () => retryDecision),
    ...overrides,
  };
}

const db = {} as Pool;

describe("exact outbox worker", () => {
  it("processes and completes a handled event through the fenced ports", async () => {
    const workerPorts = ports();

    await expect(processExactOutboxBatch({
      db,
      workerId: "ai_exact_worker_a",
      ports: workerPorts,
    })).resolves.toEqual({
      claimed: 1,
      completed: 1,
      intentionalNoops: 0,
      handlerFailures: 0,
      retryScheduled: 0,
      deadLettered: 0,
      staleClaims: 0,
      transitionErrors: 0,
      skippedBecauseBusy: false,
    });

    expect(workerPorts.process).toHaveBeenCalledWith({
      id: event.id,
      eventType: event.eventType,
      payload: event.payload,
    });
    expect(workerPorts.complete).toHaveBeenCalledWith(db, "ai_exact_worker_a", event);
    expect(workerPorts.fail).not.toHaveBeenCalled();
  });

  it("dead-letters an unsupported contract explicitly instead of processing or completing it", async () => {
    const workerPorts = ports({
      classify: vi.fn(() => ({ process: false as const, reasonCode: "unsupported_event_type" })),
      fail: vi.fn(async (_db, _workerId, _event, failure) => {
        expect(failure).toEqual({
          errorClass: "ExactOutboxContractError",
          errorCode: "unsupported_event_type",
          retryable: false,
          handlerVersion: "ai-exact-outbox-v1",
        });
        return deadLetterDecision;
      }),
    });

    const result = await processExactOutboxBatch({ db, workerId: "ai_exact_worker_a", ports: workerPorts });

    expect(result).toMatchObject({ claimed: 1, deadLettered: 1 });
    expect(workerPorts.process).not.toHaveBeenCalled();
    expect(workerPorts.complete).not.toHaveBeenCalled();
  });

  it("completes an intentional no-op without invoking a business handler", async () => {
    const workerPorts = ports({
      classify: vi.fn(() => ({ process: false as const, reasonCode: "intentional_noop" })),
    });

    const result = await processExactOutboxBatch({ db, workerId: "ai_exact_worker_a", ports: workerPorts });

    expect(result).toMatchObject({ claimed: 1, completed: 1, intentionalNoops: 1 });
    expect(workerPorts.process).not.toHaveBeenCalled();
    expect(workerPorts.complete).toHaveBeenCalledOnce();
    expect(workerPorts.fail).not.toHaveBeenCalled();
  });

  it("classifies an unknown handler error as retryable without persisting its unsafe message", async () => {
    const workerPorts = ports({
      process: vi.fn(async () => {
        throw new Error("secret provider response and customer token");
      }),
      fail: vi.fn(async (_db, _workerId, _event, failure) => {
        expect(failure).toEqual({
          errorClass: "UnknownHandlerError",
          errorCode: "unclassified_handler_failure",
          retryable: true,
          handlerVersion: "ai-exact-outbox-v1",
        });
        expect(JSON.stringify(failure)).not.toContain("secret provider");
        return retryDecision;
      }),
    });

    const result = await processExactOutboxBatch({ db, workerId: "ai_exact_worker_a", ports: workerPorts });

    expect(result).toMatchObject({ claimed: 1, handlerFailures: 1, retryScheduled: 1 });
    expect(workerPorts.complete).not.toHaveBeenCalled();
  });

  it("does not overwrite a newer claim when completion reports a stale token", async () => {
    const nextEvent = { ...event, id: "44444444-4444-4444-8444-444444444444" };
    const workerPorts = ports({
      claim: vi.fn(async () => [event, nextEvent]),
      complete: vi.fn(async (_db, _workerId, claimed) => {
        if (claimed.id === event.id) throw new StaleExactOutboxClaimError(claimed.id);
      }),
    });

    const result = await processExactOutboxBatch({ db, workerId: "ai_exact_worker_a", ports: workerPorts });

    expect(result).toMatchObject({ claimed: 2, completed: 1, staleClaims: 1 });
    expect(workerPorts.fail).not.toHaveBeenCalled();
    expect(workerPorts.process).toHaveBeenCalledTimes(2);
  });

  it("isolates a transition error and continues with the next independent event", async () => {
    const nextEvent = { ...event, id: "44444444-4444-4444-8444-444444444444" };
    const workerPorts = ports({
      claim: vi.fn(async () => [event, nextEvent]),
      complete: vi.fn(async (_db, _workerId, claimed) => {
        if (claimed.id === event.id) throw new Error("database temporarily unavailable");
      }),
    });

    const result = await processExactOutboxBatch({ db, workerId: "ai_exact_worker_a", ports: workerPorts });

    expect(result).toMatchObject({ claimed: 2, completed: 1, transitionErrors: 1 });
    expect(workerPorts.process).toHaveBeenCalledTimes(2);
  });

  it("skips a concurrent run instead of overlapping batches", async () => {
    let releaseClaim!: () => void;
    const claimBlocked = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const workerPorts = ports({
      claim: vi.fn(async () => {
        await claimBlocked;
        return [];
      }),
    });
    const worker = createExactOutboxWorker({
      db,
      workerId: "ai_exact_worker_a",
      ports: workerPorts,
      pollIntervalMs: 2_000,
    });

    const first = worker.runOnce();
    const overlapping = await worker.runOnce();
    expect(overlapping).toMatchObject({ claimed: 0, skippedBecauseBusy: true });
    expect(workerPorts.claim).toHaveBeenCalledOnce();

    releaseClaim();
    await expect(first).resolves.toMatchObject({ claimed: 0, skippedBecauseBusy: false });
  });

  it("awaits readiness observation for direct and busy runs", async () => {
    let releaseClaim!: () => void;
    const claimBlocked = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const observed: boolean[] = [];
    const worker = createExactOutboxWorker({
      db,
      workerId: "ai_exact_worker_observer",
      ports: ports({
        claim: vi.fn(async () => {
          await claimBlocked;
          return [];
        }),
      }),
      observer: {
        onBatchCompleted: vi.fn(async (summary) => {
          await Promise.resolve();
          observed.push(summary.skippedBecauseBusy);
        }),
        onBatchFailed: vi.fn(),
      },
    });

    const first = worker.runOnce();
    await expect(worker.runOnce()).resolves.toMatchObject({ skippedBecauseBusy: true });
    expect(observed).toEqual([true]);

    releaseClaim();
    await expect(first).resolves.toMatchObject({ skippedBecauseBusy: false });
    expect(observed).toEqual([true, false]);
  });
});
