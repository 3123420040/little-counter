import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "../db/client";
import { listAccountsForClient } from "../services/accounting-service";

const scope = {
  scopeKind: "report" as const,
  merchantId: "merchant-a",
  storeIds: ["store-b", "store-a"],
};

describe("ACCT-READ-01 scoped account balances", () => {
  it("filters posted journals by exact merchant and authorized shared/store scope", async () => {
    const query = vi.fn(async () => ({
      rows: [{ code: "1111", name: "Cash", type: "asset", balance: "125000" }],
    }));
    const client = { query } as unknown as PoolClient;

    await expect(listAccountsForClient(client, scope)).resolves.toEqual([
      { code: "1111", name: "Cash", type: "asset", balance: "125000" },
    ]);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0]!;
    const normalizedSql = String(sql).toLowerCase().replace(/\s+/g, " ");
    expect(normalizedSql).toContain("je.status = 'posted'");
    expect(normalizedSql).toContain("je.merchant_id = $1");
    expect(normalizedSql).toContain("je.store_id is null or je.store_id = any($2::text[])");
    expect(normalizedSql).not.toContain("je.merchant_id is null");
    expect(params).toEqual(["merchant-a", ["store-a", "store-b"]]);
  });

  it("fails before querying for a missing, empty or duplicate report scope", async () => {
    const query = vi.fn();
    const client = { query } as unknown as PoolClient;

    await expect(listAccountsForClient(client, undefined as never)).rejects.toMatchObject({
      code: "scope_required",
    });
    await expect(listAccountsForClient(client, {
      scopeKind: "report",
      merchantId: "merchant-a",
      storeIds: [],
    })).rejects.toMatchObject({ code: "scope_required" });
    await expect(listAccountsForClient(client, {
      scopeKind: "report",
      merchantId: "merchant-a",
      storeIds: ["store-a", "store-a"],
    })).rejects.toMatchObject({ code: "scope_required" });
    expect(query).not.toHaveBeenCalled();
  });
});
