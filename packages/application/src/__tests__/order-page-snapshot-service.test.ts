import { describe, expect, it } from "vitest";
import type {
  OrderCollectionRevisionVectorV1,
  OrderCursorFiltersV1,
  OrderCursorScopeV1,
} from "@medusa-snus/contracts";
import {
  OrderCursorError,
  normalizeOrderCursorFiltersV1,
  type OrderCursorKeyringV1,
} from "../services/order-cursor-service";
import {
  readOrderPageSnapshotV1,
  type OrderPageIdentityRowV1,
  type OrderPageSnapshotRepositoryV1,
  type OrderPageSnapshotTransactionV1,
} from "../services/order-page-snapshot-service";

const keyring: OrderCursorKeyringV1 = {
  current: {
    keyId: "page-key-current",
    keyBase64Url: Buffer.alloc(32, 11).toString("base64url"),
  },
  previous: {
    keyId: "page-key-previous",
    keyBase64Url: Buffer.alloc(32, 12).toString("base64url"),
  },
};
const scope: OrderCursorScopeV1 = {
  merchantId: "merchant-a",
  storeIds: ["store-a", "store-b"],
};
const filters: OrderCursorFiltersV1 = normalizeOrderCursorFiltersV1({
  statusMode: "completed",
  search: "ORD-",
  storeWindows: [
    {
      storeId: "store-a",
      startInclusive: "2026-08-01T00:00:00.000Z",
      endExclusive: "2026-08-06T00:00:00.000Z",
    },
    {
      storeId: "store-b",
      startInclusive: "2026-08-01T00:00:00.000Z",
      endExclusive: "2026-08-06T00:00:00.000Z",
    },
  ],
});

function tupleCompareDesc(left: OrderPageIdentityRowV1, right: OrderPageIdentityRowV1) {
  const timeDifference = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  if (timeDifference !== 0) return timeDifference;
  return left.orderId === right.orderId ? 0 : left.orderId < right.orderId ? 1 : -1;
}

function isAtOrBelow(row: OrderPageIdentityRowV1, bound: { createdAt: string; id: string }) {
  const rowTime = Date.parse(row.createdAt);
  const boundTime = Date.parse(bound.createdAt);
  return rowTime < boundTime || (rowTime === boundTime && row.orderId <= bound.id);
}

function isStrictlyBelow(row: OrderPageIdentityRowV1, bound: { createdAt: string; id: string }) {
  const rowTime = Date.parse(row.createdAt);
  const boundTime = Date.parse(bound.createdAt);
  return rowTime < boundTime || (rowTime === boundTime && row.orderId < bound.id);
}

class MemorySnapshot implements OrderPageSnapshotTransactionV1 {
  constructor(
    private readonly owner: MemoryRepository,
    private readonly rows: OrderPageIdentityRowV1[],
    private readonly revisions: OrderCollectionRevisionVectorV1,
    private readonly asOf: string,
  ) {}

  async readAsOf() {
    return this.asOf;
  }

  async readStoreRevisionVector() {
    return this.revisions;
  }

  private matching(input: Parameters<OrderPageSnapshotTransactionV1["readRows"]>[0]) {
    const windows = new Map(input.filters.storeWindows.map((window) => [window.storeId, window]));
    return this.rows.filter((row) => {
      if (row.merchantId !== input.scope.merchantId || !input.scope.storeIds.includes(row.storeId)) {
        return false;
      }
      const window = windows.get(row.storeId);
      if (
        !window
        || row.createdAt < window.startInclusive
        || row.createdAt >= window.endExclusive
      ) return false;
      if (input.filters.statusMode === "completed" && row.status !== "completed") return false;
      if (input.filters.statusMode === "other" && row.status === "completed") return false;
      if (input.filters.search) {
        const search = input.filters.search;
        if (!row.orderId.toLowerCase().includes(search)
          && !row.orderNumber.toLowerCase().includes(search)) return false;
      }
      if (input.highWatermark && !isAtOrBelow(row, input.highWatermark)) return false;
      if (input.after && !isStrictlyBelow(row, input.after)) return false;
      return true;
    }).sort(tupleCompareDesc);
  }

  async readRows(input: Parameters<OrderPageSnapshotTransactionV1["readRows"]>[0]) {
    this.owner.readLimits.push(input.limit);
    return this.matching(input).slice(0, input.limit);
  }

  async countRows(input: Parameters<OrderPageSnapshotTransactionV1["countRows"]>[0]) {
    return this.matching({ ...input, limit: Number.MAX_SAFE_INTEGER }).length;
  }
}

class MemoryRepository implements OrderPageSnapshotRepositoryV1 {
  revisionA = 17;
  revisionB = 9;
  transactionCount = 0;
  readLimits: number[] = [];

  constructor(readonly rows: OrderPageIdentityRowV1[]) {}

  async withRepeatableReadSnapshot<T>(
    read: (snapshot: OrderPageSnapshotTransactionV1) => Promise<T>,
  ): Promise<T> {
    this.transactionCount += 1;
    const copiedRows = this.rows.map((row) => ({ ...row }));
    const revisions = [
      { storeId: "store-a", revision: this.revisionA },
      { storeId: "store-b", revision: this.revisionB },
    ];
    return read(new MemorySnapshot(
      this,
      copiedRows,
      revisions,
      new Date(Date.parse("2026-08-05T12:00:00.000Z") + this.transactionCount).toISOString(),
    ));
  }
}

function makeRows(count: number): OrderPageIdentityRowV1[] {
  return Array.from({ length: count }, (_, index) => ({
    merchantId: "merchant-a",
    storeId: index % 2 === 0 ? "store-a" : "store-b",
    orderId: `order-${String(index).padStart(5, "0")}`,
    orderNumber: `ORD-${String(index).padStart(5, "0")}`,
    status: index % 7 === 0 ? "cancelled" : "completed",
    currencyCode: "VND",
    createdAt: new Date(Date.parse("2026-08-01T00:00:00.000Z") + index).toISOString(),
  }));
}

function forgedRepository(rows: OrderPageIdentityRowV1[]): OrderPageSnapshotRepositoryV1 {
  return {
    async withRepeatableReadSnapshot(read) {
      return read({
        async readAsOf() {
          return "2026-08-05T12:00:00.000Z";
        },
        async readStoreRevisionVector() {
          return [
            { storeId: "store-a", revision: 17 },
            { storeId: "store-b", revision: 9 },
          ];
        },
        async readRows() {
          return rows;
        },
        async countRows() {
          return rows.length;
        },
      });
    },
  };
}

describe("PAGE-01B exact order-page snapshot orchestration", () => {
  it("preserves explicit walk-in attribution through snapshot validation", async () => {
    const row = {
      ...makeRows(1)[0]!,
      status: "completed",
      customer: null,
      customerAttribution: "walk_in" as const,
    };
    const page = await readOrderPageSnapshotV1(new MemoryRepository([row]), {
      scope,
      filters,
      limit: 50,
      nowEpochSeconds: 1_800_000_000,
    }, keyring);

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ customer: null, customerAttribution: "walk_in" });
  });

  it("rejects snapshot attribution that contradicts customer linkage", async () => {
    const row = {
      ...makeRows(1)[0]!,
      status: "completed",
      customer: { id: "customer-a", firstName: null, lastName: null, phone: null },
      customerAttribution: "walk_in" as const,
    };

    await expect(readOrderPageSnapshotV1(new MemoryRepository([row]), {
      scope,
      filters,
      limit: 50,
      nowEpochSeconds: 1_800_000_000,
    }, keyring)).rejects.toThrow("customer attribution drift");
  });

  it("traverses 10,000 matching orders exactly once with bounded limit+1 reads", async () => {
    const repository = new MemoryRepository(makeRows(10_000));
    const allFilters = normalizeOrderCursorFiltersV1({
      ...filters,
      statusMode: "all",
    });
    const expected = [...repository.rows]
      .sort(tupleCompareDesc)
      .map((row) => row.orderId);
    const actual: string[] = [];
    let cursor: string | undefined;
    let calls = 0;
    do {
      const page = await readOrderPageSnapshotV1(repository, {
        scope,
        filters: allFilters,
        limit: 137,
        cursor,
        nowEpochSeconds: 1_800_000_000 + calls,
      }, keyring);
      actual.push(...page.rows.map((row) => row.orderId));
      expect(page.totalCount).toBe(expected.length);
      expect(page.pagination.asOf).toBe("2026-08-05T12:00:00.001Z");
      cursor = page.pagination.nextCursor || undefined;
      calls += 1;
    } while (cursor);

    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(actual.length);
    expect(repository.readLimits.every((limit) => limit === 138)).toBe(true);
    expect(repository.transactionCount).toBe(calls);
  }, 15_000);

  it("invalidates the next page when a selected store revision changes", async () => {
    const repository = new MemoryRepository(makeRows(500));
    const first = await readOrderPageSnapshotV1(repository, {
      scope,
      filters,
      limit: 50,
      nowEpochSeconds: 1_800_000_000,
    }, keyring);
    repository.revisionB += 1;

    await expect(readOrderPageSnapshotV1(repository, {
      scope,
      filters,
      limit: 50,
      cursor: first.pagination.nextCursor || undefined,
      nowEpochSeconds: 1_800_000_001,
    }, keyring)).rejects.toMatchObject<OrderCursorError>({ code: "stale_cursor" });
  });

  it("rejects forged repository scope/filter/order and ordering rows", async () => {
    const invalidCases: OrderPageIdentityRowV1[][] = [
      [{ ...makeRows(1)[0]!, status: "completed", merchantId: "merchant-other" }],
      [{ ...makeRows(1)[0]!, status: "completed", orderNumber: "NOT-MATCHING" }],
      [
        { ...makeRows(2)[0]!, status: "completed", createdAt: "2026-08-01T00:00:00.000Z" },
        { ...makeRows(2)[1]!, status: "completed", createdAt: "2026-08-02T00:00:00.000Z" },
      ],
    ];
    for (const rows of invalidCases) {
      await expect(readOrderPageSnapshotV1(forgedRepository(rows), {
        scope,
        filters,
        limit: 50,
        nowEpochSeconds: 1_800_000_000,
      }, keyring)).rejects.toThrow();
    }
  });

  it("returns an empty terminal page without issuing a cursor", async () => {
    const page = await readOrderPageSnapshotV1(new MemoryRepository([]), {
      scope,
      filters,
      limit: 200,
      nowEpochSeconds: 1_800_000_000,
    }, keyring);
    expect(page).toMatchObject({
      rows: [],
      totalCount: 0,
      pagination: { limit: 200, hasMore: false, nextCursor: null },
    });
  });
});
