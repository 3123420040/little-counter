import { describe, expect, it, vi } from "vitest";
import { permissions } from "@medusa-snus/contracts";
import { handleEffectiveOrderPageHttpV5 } from "../services/effective-order-page-v4-http-handler";
import { normalizeOrderCursorFiltersV1 } from "../services/order-cursor-service";
const request = { authorization: { permission: permissions.ordersRead, scope: { scopeKind: "report" as const, merchantId: "m-a", storeIds: ["s-a"] } },
  creatorSelection: { mode: "all" as const, creatorOperatorIds: [] }, nowEpochSeconds: 1_800_000_000,
  filters: { ...normalizeOrderCursorFiltersV1({ statusMode: "all",
    storeWindows: [{ storeId: "s-a", startInclusive: "2026-10-26T00:00:00.000Z", endExclusive: "2026-10-27T00:00:00.000Z" }] }), searchMode: "order_or_customer_identity" as const } };
function dependencies() { return { repository: { withRepeatableReadSnapshot: vi.fn(async () => { throw new Error("Unexpected query"); }) },
  keyring: { current: { keyId: "owned", keyBase64Url: Buffer.alloc(32, 21).toString("base64url") } }, config: { enabled: true } }; }
describe("V5 HTTP pre-query gates", () => {
  it.each(["permission", "disabled", "scope", "creators", "keyring"])("refuses %s before reading any rows", async (scenario) => {
    const deps = dependencies(), input = structuredClone(request);
    let statusCode = 400;
    if (scenario === "permission") { input.authorization.permission = "customer:read" as never; statusCode = 403; }
    if (scenario === "disabled") { deps.config.enabled = false; statusCode = 403; }
    if (scenario === "scope") input.authorization.scope.storeIds = ["foreign-store"];
    if (scenario === "creators") input.filters.creatorSelection = { mode: "selected", creatorOperatorIds: ["staff-a"] };
    if (scenario === "keyring") { deps.keyring.current.keyBase64Url = "not-a-valid-key"; statusCode = 503; }
    await expect(handleEffectiveOrderPageHttpV5(deps, input)).rejects.toMatchObject({ statusCode });
    expect(deps.repository.withRepeatableReadSnapshot).not.toHaveBeenCalled();
  });
});
