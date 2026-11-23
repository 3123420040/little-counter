import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  EXACT_OUTBOX_MIGRATION_CHECKSUM,
  EXACT_OUTBOX_MIGRATION_FILENAME,
  ExactOutboxRuntimeGuardError,
  assertExactOutboxRuntimeCompatible,
  inspectExactOutboxQueue,
  prepareExactOutboxRuntime,
} from "../worker/exact-outbox-runtime";

type GuardRow = {
  migration_checksum_matches: boolean;
  exact_functions_present: boolean;
  exact_insert_guard_enabled: boolean;
  handler_relations_present: boolean;
  open_legacy_event_count: string;
};

const compatible: GuardRow = {
  migration_checksum_matches: true,
  exact_functions_present: true,
  exact_insert_guard_enabled: true,
  handler_relations_present: true,
  open_legacy_event_count: "0",
};

function dbReturning(row: Partial<GuardRow> = {}): Pool {
  return {
    query: vi.fn(async () => ({ rows: [{ ...compatible, ...row }] })),
  } as unknown as Pool;
}

describe("exact outbox runtime activation", () => {
  it("pins the runtime guard to the current authored migration 027 bytes", () => {
    const migrationPath = fileURLToPath(new URL(
      "../../../../db/migrations/027_outbox_causality_and_claim_fencing.sql",
      import.meta.url,
    ));
    const checksum = createHash("sha256").update(readFileSync(migrationPath)).digest("hex");

    expect(checksum).toBe(EXACT_OUTBOX_MIGRATION_CHECKSUM);
  });

  it("binds startup to the exact migration checksum, catalog functions, insert guard and empty legacy backlog", async () => {
    const db = dbReturning();

    await expect(assertExactOutboxRuntimeCompatible(db)).resolves.toEqual({
      migrationFilename: EXACT_OUTBOX_MIGRATION_FILENAME,
      migrationChecksum: EXACT_OUTBOX_MIGRATION_CHECKSUM,
      openLegacyEventCount: 0,
    });

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("outbox.claim_exact_events"),
      [EXACT_OUTBOX_MIGRATION_FILENAME, EXACT_OUTBOX_MIGRATION_CHECKSUM],
    );
    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("causality_quality = 'legacy_ambiguous'"),
    );
  });

  it.each([
    [{ migration_checksum_matches: false }, "migration_checksum_mismatch"],
    [{ exact_functions_present: false }, "exact_functions_missing"],
    [{ exact_insert_guard_enabled: false }, "exact_insert_guard_missing"],
    [{ handler_relations_present: false }, "handler_schema_missing"],
    [{ open_legacy_event_count: "1" }, "legacy_backlog_open"],
  ] as const)("fails closed when evidence is incompatible: %s", async (row, code) => {
    await expect(assertExactOutboxRuntimeCompatible(dbReturning(row))).rejects.toMatchObject({
      name: "ExactOutboxRuntimeGuardError",
      code,
    });
  });

  it("redacts database diagnostics when the guard query itself fails", async () => {
    const db = {
      query: vi.fn(async () => {
        throw new Error("password=secret internal catalog detail");
      }),
    } as unknown as Pool;

    const failure = await assertExactOutboxRuntimeCompatible(db).catch(error => error);
    expect(failure).toBeInstanceOf(ExactOutboxRuntimeGuardError);
    expect(failure).toMatchObject({ code: "guard_query_failed" });
    expect(String(failure)).not.toContain("secret");
  });

  it("maps a bounded queue snapshot without exposing envelope data", async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [{
          open_exact_event_count: "7",
          actionable_event_count: "3",
          processing_event_count: "2",
          expired_lease_count: "1",
          blocked_exact_event_count: "4",
          dead_blocked_event_count: "1",
          dead_lettered_event_count: "2",
          oldest_open_age_seconds: "91.9",
          oldest_actionable_age_seconds: "31.2",
        }],
      })),
    } as unknown as Pool;

    const snapshot = await inspectExactOutboxQueue(db);
    expect(snapshot).toEqual({
      openExactEventCount: 7,
      actionableEventCount: 3,
      processingEventCount: 2,
      expiredLeaseCount: 1,
      blockedExactEventCount: 4,
      deadBlockedEventCount: 1,
      deadLetteredEventCount: 2,
      oldestOpenAgeSeconds: 91,
      oldestActionableAgeSeconds: 31,
    });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("blocked_exact_events"));
    expect(JSON.stringify(snapshot)).not.toContain("payload");
  });

  it("verifies compatibility before constructing exactly one exact worker", async () => {
    const order: string[] = [];
    const worker = {
      runOnce: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      isRunning: vi.fn(() => false),
      isStarted: vi.fn(() => false),
    };
    const factory = vi.fn(() => {
      order.push("construct");
      return worker;
    });
    const verify = vi.fn(async () => {
      order.push("verify");
      return {
        migrationFilename: EXACT_OUTBOX_MIGRATION_FILENAME,
        migrationChecksum: EXACT_OUTBOX_MIGRATION_CHECKSUM,
        openLegacyEventCount: 0,
      };
    });

    const runtime = await prepareExactOutboxRuntime({
      db: dbReturning(),
      workerId: "ai_exact_worker_test",
      verify,
      factory,
    });

    expect(order).toEqual(["verify", "construct"]);
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({
      workerId: "ai_exact_worker_test",
      claimLimit: 1,
      leaseSeconds: 300,
    }));
    expect(worker.start).not.toHaveBeenCalled();
    expect(runtime.getReadiness()).toMatchObject({ ready: false, state: "prepared" });
  });

  it("keeps the AI API process free of the exact worker runtime", () => {
    const indexPath = fileURLToPath(new URL("../index.ts", import.meta.url));
    const source = readFileSync(indexPath, "utf8");
    const workerPath = fileURLToPath(new URL("../worker/exact-outbox-worker.ts", import.meta.url));
    const workerSource = readFileSync(workerPath, "utf8");

    expect(source).toContain('import type { ExactOutboxRuntimeReadiness }');
    expect(source).not.toContain("outbox-poller");
    expect(source).not.toContain("startOutboxWorker");
    expect(source).not.toContain("running without persistence");
    expect(workerSource).toContain("const { processExactOutboxEvent } = applicationModule");
    expect(workerSource).toContain("process: processExactOutboxEvent");
    expect(workerSource).not.toContain("process: processOutboxEvent");

    expect(source).not.toContain("prepareExactOutboxRuntime(");
    expect(source).not.toContain("exactRuntime.start()");
    expect(source).toContain("await server.listen");
  });

  it("imports runtime values through an explicit ESM-safe contracts subpath", () => {
    const primitivesPath = fileURLToPath(new URL("../worker/exact-outbox-primitives.ts", import.meta.url));
    const primitivesSource = readFileSync(primitivesPath, "utf8");
    const contractsPackagePath = fileURLToPath(new URL(
      "../../../../packages/contracts/package.json",
      import.meta.url,
    ));
    const contractsPackage = JSON.parse(readFileSync(contractsPackagePath, "utf8")) as {
      exports?: Record<string, string>;
    };

    expect(primitivesSource).toContain('from "@medusa-snus/contracts/outbox-runtime"');
    expect(contractsPackage.exports?.["./outbox-runtime"]).toBe("./src/outbox-runtime.ts");
  });
});
