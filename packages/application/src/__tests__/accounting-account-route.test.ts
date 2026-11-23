import { beforeEach, describe, expect, it, vi } from "vitest";
import { permissions } from "@medusa-snus/contracts";

const application = vi.hoisted(() => ({
  listAccounts: vi.fn(),
}));

const routeUtils = vi.hoisted(() => ({
  actorWithReportScope: vi.fn(),
  route: vi.fn(async (_response, handler) => handler()),
}));

vi.mock("@medusa-snus/application", () => application);
vi.mock("../../../../src/lib/route-utils", () => routeUtils);

import { GET as getAccounts } from "../../../../src/api/accounting/accounts/route";

const actor = {
  operatorId: "operator-a",
  role: "staff",
  displayName: "Staff A",
  organizationId: "org-a",
};
const reportScope = {
  scopeKind: "report",
  merchantId: "merchant-a",
  storeIds: ["store-a"],
};
const response = { status: vi.fn(), json: vi.fn() } as never;
const request = {
  headers: {
    "x-report-merchant-id": "merchant-forged",
    "x-report-store-ids": "store-forged",
  },
} as never;

describe("ACCT-READ-01 account route authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeUtils.actorWithReportScope.mockResolvedValue({ actor, scope: reportScope });
    application.listAccounts.mockResolvedValue({ data: [] });
  });

  it("passes only the actor-derived report scope to the account reader", async () => {
    await getAccounts(request, response);

    expect(routeUtils.actorWithReportScope).toHaveBeenCalledWith(
      request,
      "staff",
      permissions.accountingRead,
    );
    expect(application.listAccounts).toHaveBeenCalledWith(reportScope);
  });

  it("does not read account balances when report-scope authorization fails", async () => {
    routeUtils.actorWithReportScope.mockRejectedValue(
      Object.assign(new Error("forbidden"), { code: "forbidden", statusCode: 403 }),
    );

    await expect(getAccounts(request, response)).rejects.toMatchObject({ code: "forbidden" });
    expect(application.listAccounts).not.toHaveBeenCalled();
  });
});
