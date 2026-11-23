import { beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeBuildInfoV2Schema, emptyRuntimeCapabilitySetV1, emptyPaymentFeeCapabilitySetV1,
  PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1, PAYMENT_FEE_WRITE_HTTP_HEADER_V1 } from "@medusa-snus/contracts/runtime-capabilities";
const state = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock("@medusa-snus/application", async original => ({ ...await original<typeof import("@medusa-snus/application")>(), getBuildInfoV2: state.build }));
import { assertPaymentFeeWriteHttpContractV1, paymentFeeReadHttpContractV1 } from "../../../../src/lib/payment-fee-http-contract";
// Synthetic readiness is an admission-unit fixture, not a compiled/native release attestation.
const ready = RuntimeBuildInfoV2Schema.parse({ schemaVersion: 2, service: "medusa", sourceCommit: "a".repeat(40), releaseId: "synthetic-fee-http",
  compatibilityFamily: "snus-runtime-v1", capabilities: { ...emptyRuntimeCapabilitySetV1(), checkoutWrite: ["v1"], paymentWrite: ["v1"] },
  paymentFeeCapabilities: { ordersRead: ["v5"], orderDetail: ["v3"], orderRecreate: ["v3"], csvRead: ["v5"], dashboardRead: ["v3"], paymentFeeWrite: ["v1"] } });
const fee = { paymentFeeType: "percent", paymentFeeValue: 2 }, modern = () => ({ [PAYMENT_FEE_WRITE_HTTP_HEADER_V1]: PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1 });
const sale = { items: [{ variantId: "v-a", quantity: 1 }], paymentMethod: "cash", amountReceived: 2000, ...fee, cartConfirmationToken: "a".repeat(64) };
const correction = { baseRevision: 0, reason: "Correct entered quantity", items: [{ variantId: "v-a", quantity: 1 }] };
const response = { status: vi.fn(), json: vi.fn(), send: vi.fn(), setHeader: vi.fn() };
function run(body: unknown, headers: Record<string, string | string[] | undefined> = {}, family: "checkout" | "payment_intent" | "correction" = "checkout") {
  return Promise.resolve().then(() => assertPaymentFeeWriteHttpContractV1({ body, headers }, response as never, family));
}
beforeEach(() => { state.build.mockReset(); state.build.mockReturnValue(ready); response.setHeader.mockClear(); });
describe("server-side fee write negotiation", () => {
  it.each([
    { merchantId: "foreign" }, { subtotal: 1 }, { amountReceived: "1000" }, { extra: true },
    { items: [{ variantId: "v-a", quantity: 1, unitPrice: 1 }] },
    { items: [{ variantId: "v-a", quantity: 1, vision: { scanEventId: "x", candidateSource: "ai_candidate", provider: "test", secret: "x" } }] },
  ])("refuses unknown or wrongly typed negotiated sale inputs without silently stripping them: %j", async patch => {
    await expect(run({ items: [{ variantId: "v-a", quantity: 1 }], paymentMethod: "cash", amountReceived: 2000, ...fee, ...patch }, modern()))
      .rejects.toMatchObject({ code: "validation_error", statusCode: 400 });
  });
  it("preserves fee-free legacy bytes without requesting new build readiness", async () => {
    const body = Object.freeze({ items: [], shippingFee: 0 }), bytes = JSON.stringify(body);
    expect(await run(body)).toBe("legacy"); expect(JSON.stringify(body)).toBe(bytes);
    expect(state.build).not.toHaveBeenCalled(); expect(response.setHeader).not.toHaveBeenCalled();
  });
  it.each([{ paymentFeeType: "percent", paymentFeeValue: 0 }, fee, { paymentFeeValue: 1 }, { paymentFeeMinor: 0 }, { paymentFeeWrite: true }])(
    "denies unnegotiated fee fields %j", async body => {
      await expect(run(body)).rejects.toMatchObject({ code: "unsupported_contract", statusCode: 409 }); expect(state.build).not.toHaveBeenCalled();
    });
  it.each([{ provider: "mock", order: fee }, { provider: "mock", paymentFeeValue: 2, order: {} }])("also checks nested and misplaced intent fee fields: %j", async body => {
    await expect(run(body, {}, "payment_intent")).rejects.toMatchObject({ code: "unsupported_contract" });
  });
  it.each([
    { "x-order-financial-contract": "other.v99" }, { "x-order-financial-contract": "" },
    { "x-order-financial-contract": ["orders.payment-fee.v1"] },
    { "x-order-financial-contract": "orders.payment-fee.v1", "X-Order-Financial-Contract": "orders.payment-fee.v1" },
  ])("rejects ambiguous/unsupported protocol declarations: %j", async headers => {
    await expect(run({}, headers)).rejects.toMatchObject({ code: "unsupported_contract", statusCode: 409 }); expect(state.build).not.toHaveBeenCalled();
  });
  it.each([null, [], {}, { paymentFeeType: "amount" }, { ...fee, paymentFeeValue: 100.01 }, { ...fee, paymentFeeMinor: 20 }, { ...fee, taxMode: "inclusive" }])(
    "rejects malformed negotiated checkout input: %j", async body => {
      await expect(run(body, modern())).rejects.toMatchObject({ code: "validation_error", statusCode: 400 }); expect(state.build).not.toHaveBeenCalled();
    });
  it.each(["checkout", "payment_intent", "correction"] as const)("admits %s only from trusted server readiness without modifying input", async family => {
    const body = Object.freeze(family === "payment_intent" ? { provider: "mock", order: sale } : family === "correction" ? correction : sale);
    const bytes = JSON.stringify(body);
    expect(await run(body, modern(), family)).toBe(PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1);
    expect(JSON.stringify(body)).toBe(bytes); expect(state.build).toHaveBeenCalledExactlyOnceWith("medusa");
    expect(response.setHeader).toHaveBeenCalledWith(PAYMENT_FEE_WRITE_HTTP_HEADER_V1, PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1);
  });
  it("refuses resolved financial context even when a correction retains its stored fee descriptor", async () => {
    await expect(run({ taxMode: "inclusive" }, modern(), "correction")).rejects.toMatchObject({ code: "validation_error", statusCode: 400 });
    await expect(run({ provider: "mock", tax: 0, order: fee }, modern(), "payment_intent")).rejects.toMatchObject({ code: "validation_error", statusCode: 400 });
    expect(state.build).not.toHaveBeenCalled();
  });
  it.each([
    { ...correction, merchantId: "foreign" }, { ...correction, items: [{ variantId: "v-a", quantity: 1, unitPrice: 0 }] },
    { ...correction, baseRevision: "0" }, { ...correction, items: [{ variantId: "v-a", quantity: "1" }] },
    { ...correction, items: [correction.items[0], correction.items[0]] },
    { ...correction, settlement: { method: "cash", amountReceived: "0" } },
    { ...correction, settlement: { method: "cash", amountReceived: 0, force: true } },
    { ...correction, settlement: { method: "card", amountReceived: 0 } },
  ])("rejects malformed correction input before write readiness: %j", async invalid => {
    await expect(run(invalid, modern(), "correction")).rejects.toMatchObject({ code: "validation_error", statusCode: 400 });
    expect(state.build).not.toHaveBeenCalled();
  });
  it.each(["missing", "broken"])("fails closed if runtime readiness is %s", async fault => {
    if (fault === "missing") state.build.mockReturnValue({ ...ready, paymentFeeCapabilities: emptyPaymentFeeCapabilitySetV1() });
    else state.build.mockImplementation(() => { throw new Error("synthetic build failure"); });
    await expect(run(sale, modern())).rejects.toMatchObject({ code: "feature_unavailable", statusCode: 503 });
    expect(response.setHeader).not.toHaveBeenCalledWith(PAYMENT_FEE_WRITE_HTTP_HEADER_V1, PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1);
  });
});

describe("fee-compatible intent read/recovery negotiation", () => {
  it("supports existing intents without requiring admission for new fee writes", () => {
    state.build.mockImplementation(() => { throw new Error("new-write readiness is absent"); });
    expect(paymentFeeReadHttpContractV1({ headers: modern() }, response as never)).toBe(PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1);
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
    expect(response.setHeader).toHaveBeenCalledWith(PAYMENT_FEE_WRITE_HTTP_HEADER_V1, PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1);
    expect(state.build).not.toHaveBeenCalled();
  });
  it("keeps absent negotiation explicitly legacy", () => {
    expect(paymentFeeReadHttpContractV1({ headers: {} }, response as never)).toBe("legacy");
    expect(response.setHeader).not.toHaveBeenCalledWith(PAYMENT_FEE_WRITE_HTTP_HEADER_V1, PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1);
  });
  it.each([
    { "x-order-financial-contract": "other.v99" }, { "x-order-financial-contract": "" },
    { "x-order-financial-contract": ["orders.payment-fee.v1"] },
    { "x-order-financial-contract": "orders.payment-fee.v1", "X-Order-Financial-Contract": "orders.payment-fee.v1" },
  ])("rejects ambiguous or unsupported read protocol: %j", headers => {
    expect(() => paymentFeeReadHttpContractV1({ headers }, response as never)).toThrow("compatible order financial contract");
    expect(state.build).not.toHaveBeenCalled();
  });
});
