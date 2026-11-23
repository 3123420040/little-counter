import { describe, expect, it, vi } from "vitest";
import { isTrustedOwnOrderCreator, orderCancellationAccessForClient } from "../services/order-cancellation-access-service";

const scope = { scopeKind: "operating" as const, merchantId: "merchant_a", storeId: "store_a", stockLocationId: "sloc_a" };
const creator = { actor_id: "staff_a", actor_type: "staff", merchant_id: "merchant_a", store_id: "store_a" };
describe("trusted cancellation ownership", () => {
  it("does not borrow a manager permission from another store", async () => {
    const actor = { operatorId: "staff_a", role: "manager", organizationId: "org_a", access: {
      actorId: "staff_a", isPlatformAdmin: false, legacyOrganizationId: "org_a", explicitPermissions: [],
      permissionIds: ["order:cancel", "order:cancel_own"],
      memberships: [
        { membershipId: "a", operatorId: "staff_a", scopeType: "store", merchantId: "merchant_a", storeId: "store_a",
          roleKey: "manager", status: "active", permissionIds: ["order:cancel"] },
        { membershipId: "b", operatorId: "staff_a", scopeType: "store", merchantId: "merchant_a", storeId: "store_b",
          roleKey: "staff", status: "active", permissionIds: ["order:cancel_own"] },
      ],
    } };
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ ...creator, store_id: "store_b", actor_id: "other_staff" }] }) };
    const storeB = { ...scope, storeId: "store_b" };
    expect(await orderCancellationAccessForClient(client as never, "order_b", actor as never, storeB))
      .toMatchObject({ allowed: false, reasonCode: "order_not_owned" });
    client.query.mockResolvedValue({ rows: [{ ...creator, store_id: "store_b" }] });
    expect(await orderCancellationAccessForClient(client as never, "order_b", actor as never, storeB))
      .toMatchObject({ allowed: true, mode: "own" });
    expect(await orderCancellationAccessForClient(client as never, "order_a", actor as never, scope))
      .toMatchObject({ allowed: true, mode: "full" });
    expect(await orderCancellationAccessForClient(client as never, "order_a", { ...actor, role: "staff" } as never, scope))
      .toMatchObject({ allowed: false, reasonCode: "forbidden" });
    client.query.mockResolvedValue({ rows: [{ ...creator, store_id: null }] });
    expect(await orderCancellationAccessForClient(client as never, "order_b", actor as never, storeB))
      .toMatchObject({ allowed: false, reasonCode: "order_creator_provenance_unavailable" });
    expect(await orderCancellationAccessForClient(client as never, "order_b", { ...actor, impersonationMode: "read_only" } as never, storeB))
      .toMatchObject({ allowed: false, reasonCode: "impersonation_read_only" });
  });
  it("recognizes the recorded human creator regardless of channel", () => {
    expect(isTrustedOwnOrderCreator([creator], "staff_a", scope)).toBe(true);
  });
  it.each([[], [creator, creator], [{ ...creator, actor_id: "staff_b" }],
    [{ ...creator, actor_type: "partner" }], [{ ...creator, actor_type: "system" }],
    [{ ...creator, merchant_id: "merchant_b" }], [{ ...creator, store_id: "store_b" }],
    [{ ...creator, merchant_id: null }], [{ ...creator, store_id: null }],
  ].map((events) => [events]))("rejects ambiguous, missing, nonhuman or differently scoped provenance %j", (events) => {
    expect(isTrustedOwnOrderCreator(events, "staff_a", scope)).toBe(false);
  });
});
