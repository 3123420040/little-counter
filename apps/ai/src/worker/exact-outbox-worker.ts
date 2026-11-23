import type { Pool } from "pg";
import * as applicationNamespace from "@medusa-snus/application";
import { beginPartnerWorkerTrace } from "@medusa-snus/application/partner-worker-telemetry";
import {
  StaleExactOutboxClaimError,
  claimExactOutboxEvents,
  classifyExactOutboxEvent,
  completeExactOutboxClaim,
  failExactOutboxClaim,
  type ExactClaimedOutboxEvent,
  type ExactOutboxFailure,
  type ExactOutboxFailureDecision,
} from "./exact-outbox-primitives.js";

const applicationModule = ((applicationNamespace as unknown as {
  default?: typeof import("@medusa-snus/application");
}).default ?? applicationNamespace) as typeof import("@medusa-snus/application");
const { processExactOutboxEvent } = applicationModule;

export const EXACT_OUTBOX_HANDLER_VERSION = "ai-exact-outbox-v1";

type ProcessableOutboxEvent = {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
};

export type ExactOutboxWorkerPorts = {
  claim: (
    db: Pool,
    workerId: string,
    limit: number,
    leaseSeconds: number,
  ) => Promise<ExactClaimedOutboxEvent[]>;
  classify: typeof classifyExactOutboxEvent;
  process: (event: ProcessableOutboxEvent) => Promise<void>;
  complete: (
    db: Pool,
    workerId: string,
    event: ExactClaimedOutboxEvent,
  ) => Promise<void>;
  fail: (
    db: Pool,
    workerId: string,
    event: ExactClaimedOutboxEvent,
    failure: ExactOutboxFailure,
  ) => Promise<ExactOutboxFailureDecision>;
};

export type ExactOutboxWorkerLogger = {
  error: (
    message: string,
    evidence: { eventId?: string; errorClass: string },
  ) => void;
};

export type ExactOutboxBatchSummary = {
  claimed: number;
  completed: number;
  intentionalNoops: number;
  handlerFailures: number;
  retryScheduled: number;
  deadLettered: number;
  staleClaims: number;
  transitionErrors: number;
  skippedBecauseBusy: boolean;
};

type ExactOutboxBatchOptions = {
  db: Pool;
  workerId: string;
  ports?: ExactOutboxWorkerPorts;
  logger?: ExactOutboxWorkerLogger;
  claimLimit?: number;
  leaseSeconds?: number;
};

type ExactOutboxWorkerOptions = ExactOutboxBatchOptions & {
  pollIntervalMs?: number;
  observer?: ExactOutboxWorkerObserver;
};

export type ExactOutboxWorkerObserver = {
  onBatchCompleted: (summary: ExactOutboxBatchSummary) => void | Promise<void>;
  onBatchFailed: (errorClass: string) => void | Promise<void>;
};

const defaultLogger: ExactOutboxWorkerLogger = {
  error(message, evidence) {
    console.error(message, evidence);
  },
};

const defaultPorts: ExactOutboxWorkerPorts = {
  claim: claimExactOutboxEvents,
  classify: classifyExactOutboxEvent,
  process: processExactOutboxEvent,
  complete: completeExactOutboxClaim,
  fail: failExactOutboxClaim,
};

function emptySummary(skippedBecauseBusy = false): ExactOutboxBatchSummary {
  return {
    claimed: 0,
    completed: 0,
    intentionalNoops: 0,
    handlerFailures: 0,
    retryScheduled: 0,
    deadLettered: 0,
    staleClaims: 0,
    transitionErrors: 0,
    skippedBecauseBusy,
  };
}

function safeErrorClass(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  const name = String(error.name || "").trim().slice(0, 80);
  return /^[A-Za-z0-9._-]+$/.test(name) ? name : "UnknownError";
}

function handlerFailure(): ExactOutboxFailure {
  return {
    errorClass: "UnknownHandlerError",
    errorCode: "unclassified_handler_failure",
    retryable: true,
    handlerVersion: EXACT_OUTBOX_HANDLER_VERSION,
  };
}

function contractFailure(reasonCode: string): ExactOutboxFailure {
  return {
    errorClass: "ExactOutboxContractError",
    errorCode: reasonCode,
    retryable: false,
    handlerVersion: EXACT_OUTBOX_HANDLER_VERSION,
  };
}

function recordFailureDecision(
  summary: ExactOutboxBatchSummary,
  decision: ExactOutboxFailureDecision,
): void {
  if (decision.deadLetter) summary.deadLettered += 1;
  else summary.retryScheduled += 1;
}

function recordTransitionError(
  summary: ExactOutboxBatchSummary,
  logger: ExactOutboxWorkerLogger,
  event: ExactClaimedOutboxEvent,
  error: unknown,
): void {
  if (error instanceof StaleExactOutboxClaimError) {
    summary.staleClaims += 1;
    return;
  }
  summary.transitionErrors += 1;
  logger.error("Exact outbox claim transition failed", {
    eventId: event.id,
    errorClass: safeErrorClass(error),
  });
}

async function completeClaim(
  options: Required<Pick<ExactOutboxBatchOptions, "db" | "workerId">> & {
    ports: ExactOutboxWorkerPorts;
    logger: ExactOutboxWorkerLogger;
  },
  event: ExactClaimedOutboxEvent,
  summary: ExactOutboxBatchSummary,
  intentionalNoop: boolean,
): Promise<void> {
  try {
    await options.ports.complete(options.db, options.workerId, event);
    summary.completed += 1;
    if (intentionalNoop) summary.intentionalNoops += 1;
  } catch (error) {
    recordTransitionError(summary, options.logger, event, error);
  }
}

async function failClaim(
  options: Required<Pick<ExactOutboxBatchOptions, "db" | "workerId">> & {
    ports: ExactOutboxWorkerPorts;
    logger: ExactOutboxWorkerLogger;
  },
  event: ExactClaimedOutboxEvent,
  failure: ExactOutboxFailure,
  summary: ExactOutboxBatchSummary,
): Promise<void> {
  try {
    const decision = await options.ports.fail(options.db, options.workerId, event, failure);
    recordFailureDecision(summary, decision);
  } catch (error) {
    recordTransitionError(summary, options.logger, event, error);
  }
}

export async function processExactOutboxBatch(
  options: ExactOutboxBatchOptions,
): Promise<ExactOutboxBatchSummary> {
  const ports = options.ports ?? defaultPorts;
  const logger = options.logger ?? defaultLogger;
  const claimLimit = options.claimLimit ?? 25;
  const leaseSeconds = options.leaseSeconds ?? 60;
  const claimed = await ports.claim(options.db, options.workerId, claimLimit, leaseSeconds);
  const summary = emptySummary();
  summary.claimed = claimed.length;
  const resolved = { db: options.db, workerId: options.workerId, ports, logger };

  for (const event of claimed) {
    const finishTrace=beginPartnerWorkerTrace(event);
    const before={...summary};
    try {
    const classification = ports.classify(event);
    if (!classification.process) {
      if (classification.reasonCode === "intentional_noop") {
        await completeClaim(resolved, event, summary, true);
      } else {
        await failClaim(resolved, event, contractFailure(classification.reasonCode), summary);
      }
      continue;
    }

    try {
      await ports.process({
        id: event.id,
        eventType: event.eventType,
        payload: event.payload,
      });
    } catch {
      summary.handlerFailures += 1;
      await failClaim(resolved, event, handlerFailure(), summary);
      continue;
    }

    await completeClaim(resolved, event, summary, false);
    } finally {
      finishTrace?.(summary.completed>before.completed ? "completed"
        : summary.staleClaims>before.staleClaims ? "stale_claim"
        : summary.deadLettered>before.deadLettered ? "dead_lettered"
        : summary.retryScheduled>before.retryScheduled ? "retry_scheduled" : "transition_failed");
    }
  }

  return summary;
}

export function createExactOutboxWorker(options: ExactOutboxWorkerOptions) {
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 300_000) {
    throw new Error("Exact outbox poll interval must be between 100 and 300000 milliseconds");
  }

  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function runOnce(): Promise<ExactOutboxBatchSummary> {
    if (running) {
      const skipped = emptySummary(true);
      await options.observer?.onBatchCompleted(skipped);
      return skipped;
    }
    running = true;
    try {
      const summary = await processExactOutboxBatch(options);
      await options.observer?.onBatchCompleted(summary);
      return summary;
    } catch (error) {
      const errorClass = safeErrorClass(error);
      await options.observer?.onBatchFailed(errorClass);
      (options.logger ?? defaultLogger).error("Exact outbox batch failed", {
        errorClass,
      });
      throw error;
    } finally {
      running = false;
    }
  }

  function start(): void {
    if (timer !== null) return;
    timer = setInterval(() => {
      void runOnce().catch(() => undefined);
    }, pollIntervalMs);
  }

  function stop(): void {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  return {
    runOnce,
    start,
    stop,
    isRunning: () => running,
    isStarted: () => timer !== null,
  };
}
