import { describe, expect, it, beforeEach } from "vitest";
import { createApplication, createEmptyApplicationState, InMemoryStoreAdapter } from "../index.js";
import { seedState } from "./fixtures.js";
import type { RequestContext } from "../index.js";

function makeCtx(idempotencyKey?: string): RequestContext {
  return {
    actor: { type: "staff", id: "op_owner" },
    correlationId: "cor_test",
    idempotencyKey,
  };
}

function makeApp() {
  const state = createEmptyApplicationState();
  seedState(state);
  const store = new InMemoryStoreAdapter(state);
  const app = createApplication({ store });
  return { app, store, state };
}

describe("Loyalty & Customer Flow", () => {
  let app: ReturnType<typeof makeApp>["app"];
  let state: ReturnType<typeof makeApp>["state"];

  beforeEach(() => {
    const result = makeApp();
    app = result.app;
    state = result.state;
  });

  it.each([0,2])("legacy exported in-memory writer rejects unsupported fee=%i without mutation", async(paymentFeeValue)=>{
    const input={items:[{variantId:"var_mint_20",quantity:1}],paymentMethod:"cash",amountReceived:300_000,
      idempotencyKey:`legacy-fee-${paymentFeeValue}`,context:makeCtx(),paymentFeeType:"percent" as const,paymentFeeValue};
    const before=structuredClone(state);
    await expect(app.completeSale(input)).rejects.toMatchObject({code:"validation_error",statusCode:400});
    expect(state).toEqual(before);
  });

  it("awards points on sale with customer", async () => {
    await app.completeSale({
      items: [{ variantId: "var_mint_20", quantity: 1 }],
      customerId: "cus_1",
      paymentMethod: "cash",
      amountReceived: 300000,
      idempotencyKey: "loyalty-001",
      context: makeCtx("loyalty-001"),
    });

    const records = state.loyaltyRecords.filter(r => r.customerId === "cus_1");
    // Should have the new record (90 pre-existing + 25 new)
    const latestRecord = records[records.length - 1];
    expect(latestRecord.pointsEarned).toBe(25);
  });

  it("upgrades customer tier at threshold", async () => {
    // cus_1 has 90 points, needs 100 for silver
    // sale of 250000 VND → 25 points, total 115 → silver
    await app.completeSale({
      items: [{ variantId: "var_mint_20", quantity: 1 }],
      customerId: "cus_1",
      paymentMethod: "cash",
      amountReceived: 300000,
      idempotencyKey: "loyalty-upgrade",
      context: makeCtx("loyalty-upgrade"),
    });

    const profile = await app.getCustomerProfile("cus_1");
    expect(profile.tier).toBe("silver");
    expect(profile.loyaltyPoints).toBe(115);
  });

  it("gets customer loyalty info", async () => {
    const loyalty = await app.getCustomerLoyalty("cus_1");
    expect(loyalty.points).toBe(90); // Initial seed
    expect(loyalty.tier).toBe("bronze");
    expect(loyalty.nextTierPoints).toBe(10); // 100 - 90
  });

  it("gets customer profile with purchase stats", async () => {
    const profile = await app.getCustomerProfile("cus_1");
    expect(profile.customerId).toBe("cus_1");
    expect(profile.totalSpent).toBe(900000);
    expect(profile.orderCount).toBe(3);
    expect(profile.tier).toBe("bronze");
  });

  it("creates a new customer", async () => {
    const customer = await app.createCustomer({
      phone: "0922222222",
      name: "Le Van C",
      context: makeCtx(),
    });

    expect(customer.id).toBeTruthy();
    expect(customer.phone).toBe("0922222222");
    expect(state.customers.find(c => c.phone === "0922222222")).toBeTruthy();
  });

  it("rejects duplicate phone on customer creation", async () => {
    await expect(app.createCustomer({
      phone: "0900000000",
      name: "Duplicate",
      context: makeCtx(),
    })).rejects.toThrow("Customer with this phone already exists");
  });

  it("customer profile updates after purchase", async () => {
    await app.completeSale({
      items: [{ variantId: "var_mint_20", quantity: 1 }],
      customerId: "cus_1",
      paymentMethod: "cash",
      amountReceived: 300000,
      idempotencyKey: "profile-001",
      context: makeCtx("profile-001"),
    });

    const profile = await app.getCustomerProfile("cus_1");
    expect(profile.totalSpent).toBe(1150000); // 900000 + 250000
    expect(profile.orderCount).toBe(4); // 3 + 1
  });
});
