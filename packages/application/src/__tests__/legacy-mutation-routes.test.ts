import { beforeEach, describe, expect, it, vi } from "vitest";
import { permissions } from "@medusa-snus/contracts";

const application = vi.hoisted(() => ({
  assertOperatingMutationTarget: vi.fn(),
  createCustomer: vi.fn(),
  createJournalEntry: vi.fn(),
  createProduct: vi.fn(),
  deleteCustomer: vi.fn(),
  getCustomer: vi.fn(),
  getCustomerMutationTarget: vi.fn(),
  getJournalEntryMutationTarget: vi.fn(),
  getOrderMutationTarget: vi.fn(),
  mergeCustomers: vi.fn(),
  postJournalEntry: vi.fn(),
  updateCustomer: vi.fn(),
  updateOrder: vi.fn(),
}));

const routeUtils = vi.hoisted(() => ({
  actor: vi.fn(),
  actorWithMerchantTargetAccess: vi.fn(),
  actorWithMerchantTargetMutation: vi.fn(),
  actorWithOperatingScopeMutation: vi.fn(),
  body: vi.fn(),
  headers: vi.fn((request) => request.headers),
  query: vi.fn(),
  route: vi.fn(async (_response, handler) => handler()),
}));

vi.mock("@medusa-snus/application", () => application);
vi.mock("../../../../src/lib/route-utils", () => routeUtils);

import { POST as createProduct } from "../../../../src/api/admin/products/route";
import { POST as mergeCustomers } from "../../../../src/api/customers/merge/route";
import { DELETE as deleteCustomerRoute, GET as getCustomerRoute, PATCH as updateCustomerRoute } from "../../../../src/api/admin/customers/[id]/route";
import { PATCH as updateOrder } from "../../../../src/api/admin/orders/[id]/route";
import { POST as postJournalEntry } from "../../../../src/api/accounting/journal-entries/[id]/post/route";

const actor = { operatorId: "op_owner", role: "owner", displayName: "Owner", organizationId: "org_default" };
const operatingScope = { scopeKind: "operating", merchantId: "merchant_a", storeId: "store_a", stockLocationId: "sloc_a" };
const merchantScope = { scopeKind: "merchant_target", merchantId: "merchant_a" };
const response = {
  status: vi.fn(() => response),
  json: vi.fn(),
} as never;

function request(body: Record<string, unknown> = {}, id = "target_a") {
  return { headers: {}, body, params: { id } } as never;
}

describe("legacy mutation routes use explicit scoped authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeUtils.body.mockImplementation((req) => req.body);
    routeUtils.actorWithMerchantTargetAccess.mockResolvedValue({ actor, scope: merchantScope });
    routeUtils.actorWithOperatingScopeMutation.mockResolvedValue({ actor, scope: operatingScope });
    routeUtils.actorWithMerchantTargetMutation.mockResolvedValue({ actor, scope: merchantScope });
    application.getCustomerMutationTarget.mockResolvedValue({ merchantId: "merchant_a", storeId: null });
    application.getJournalEntryMutationTarget.mockResolvedValue({ merchantId: "merchant_a", storeId: "store_a" });
    application.getOrderMutationTarget.mockResolvedValue({ merchantId: "merchant_a", storeId: "store_a" });
    application.assertOperatingMutationTarget.mockImplementation((scope, target) => {
      if (scope.merchantId !== target.merchantId || (target.storeId && scope.storeId !== target.storeId)) {
        throw Object.assign(new Error("forbidden"), { code: "forbidden" });
      }
    });
    application.createProduct.mockResolvedValue({ statusCode: 201, response: {} });
    application.deleteCustomer.mockResolvedValue({ statusCode: 200, response: { deleted: true, id: "target_a" } });
    application.getCustomer.mockResolvedValue({ customer: { id: "target_a" } });
    application.mergeCustomers.mockResolvedValue({ statusCode: 200, response: {} });
    application.updateCustomer.mockResolvedValue({ statusCode: 200, response: {} });
    application.updateOrder.mockResolvedValue({ statusCode: 200, response: {} });
    application.postJournalEntry.mockResolvedValue({ statusCode: 200, response: {} });
  });

  it("derives catalog creation's merchant target from one validated operating scope", async () => {
    await createProduct(request({ title: "Scoped product" }), response);

    expect(routeUtils.actorWithOperatingScopeMutation).toHaveBeenCalledWith(expect.anything(), permissions.catalogWrite);
    expect(routeUtils.actorWithMerchantTargetMutation).toHaveBeenCalledWith(expect.anything(), permissions.catalogWrite, "merchant_a");
    expect(application.createProduct).toHaveBeenCalledWith({}, { title: "Scoped product" }, actor, merchantScope, operatingScope);
  });

  it("rejects a cross-merchant customer merge before the mutation service is called", async () => {
    application.getCustomerMutationTarget.mockResolvedValue({ merchantId: "merchant_b", storeId: null });
    routeUtils.actorWithMerchantTargetMutation.mockRejectedValue(Object.assign(new Error("forbidden"), { code: "forbidden" }));

    await expect(mergeCustomers(request({ primaryId: "customer_b", duplicateId: "customer_a" }), response)).rejects.toMatchObject({ code: "forbidden" });
    expect(routeUtils.actorWithMerchantTargetMutation).toHaveBeenCalledWith(expect.anything(), permissions.customerWrite, "merchant_b");
    expect(application.mergeCustomers).not.toHaveBeenCalled();
  });

  it("reads a customer detail through customer:read and merchant target access", async () => {
    await getCustomerRoute(request({}, "target_a"), response);

    expect(application.getCustomerMutationTarget).toHaveBeenCalledWith("target_a");
    expect(routeUtils.actorWithMerchantTargetAccess).toHaveBeenCalledWith(expect.anything(), permissions.customerRead, "merchant_a");
    expect(application.getCustomer).toHaveBeenCalledWith("target_a", { merchantId: "merchant_a" });
  });

  it("updates a customer through customer:write and merchant target mutation", async () => {
    await updateCustomerRoute(request({ first_name: "Updated" }, "target_a"), response);

    expect(application.getCustomerMutationTarget).toHaveBeenCalledWith("target_a");
    expect(routeUtils.actorWithMerchantTargetMutation).toHaveBeenCalledWith(expect.anything(), permissions.customerWrite, "merchant_a");
    expect(application.updateCustomer).toHaveBeenCalledWith({}, "target_a", { first_name: "Updated" }, actor, merchantScope);
  });

  it("soft-deletes a customer through customer:write and merchant target mutation", async () => {
    await deleteCustomerRoute(request({}, "target_a"), response);

    expect(application.getCustomerMutationTarget).toHaveBeenCalledWith("target_a");
    expect(routeUtils.actorWithMerchantTargetMutation).toHaveBeenCalledWith(expect.anything(), permissions.customerWrite, "merchant_a");
    expect(application.deleteCustomer).toHaveBeenCalledWith({}, "target_a", actor, merchantScope);
  });

  it.each([{ actorKind: "accountant" }, { actorKind: "platform all/read-only" }])('denies a $actorKind before an order mutation service is called', async () => {
    routeUtils.actorWithOperatingScopeMutation.mockRejectedValue(Object.assign(new Error("forbidden"), { code: "forbidden" }));

    await expect(updateOrder(request({ notes: "nope" }, "order_b"), response)).rejects.toMatchObject({ code: "forbidden" });
    expect(routeUtils.actorWithOperatingScopeMutation).toHaveBeenCalledWith(expect.anything(), permissions.orderWrite);
    expect(application.updateOrder).not.toHaveBeenCalled();
  });

  it("requires one operating store before catalog creation reaches its service", async () => {
    routeUtils.actorWithOperatingScopeMutation.mockRejectedValue(Object.assign(new Error("scope required"), { code: "scope_required" }));

    await expect(createProduct(request({ title: "missing scope" }), response)).rejects.toMatchObject({ code: "scope_required" });
    expect(application.createProduct).not.toHaveBeenCalled();
  });

  it("rejects a wrong-store journal post before the accounting service is called", async () => {
    application.getJournalEntryMutationTarget.mockResolvedValue({ merchantId: "merchant_a", storeId: "store_b" });

    await expect(postJournalEntry(request({}, "journal_b"), response)).rejects.toMatchObject({ code: "forbidden" });
    expect(application.postJournalEntry).not.toHaveBeenCalled();
  });
});
