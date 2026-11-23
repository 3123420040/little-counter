import { beforeEach, describe, expect, it, vi } from "vitest";

const application = vi.hoisted(() => ({
  createRemoteOrder: vi.fn(),
  listOrders: vi.fn(),
  prepareOrderRecreatePrefill: vi.fn(),
  requireActorPermission: vi.fn(),
  requireChannelPermission: vi.fn(),
  requireMutationScope: vi.fn(),
  requireOperatingReadScope: vi.fn(),
  resolveChannelActor: vi.fn(),
}));

const routeUtils = vi.hoisted(() => ({
  actor: vi.fn(),
  actorWithPermission: vi.fn(),
  body: vi.fn((req: { body?: unknown }) => req.body || {}),
  headers: vi.fn((req: { headers: Record<string, unknown> }) => req.headers),
  query: vi.fn((req: { query?: unknown }) => req.query || {}),
  rateLimit: vi.fn(),
  route: vi.fn(async (res: { json: (body: unknown) => void }, fn: () => Promise<unknown>) => {
    res.json(await fn());
  }),
}));

vi.mock("@medusa-snus/application", () => application);
vi.mock("../../../../src/lib/route-utils", () => routeUtils);

import { GET as listOrders } from "../../../../src/api/orders/route";
import { GET as recreatePrefill } from "../../../../src/api/orders/[id]/recreate-prefill/route";

const operator = {
  operatorId: "operator_impersonated",
  role: "staff",
  organizationId: "org_target",
  actualOperatorId: "operator_platform",
  effectiveOperatorId: "operator_impersonated",
  impersonationSessionId: "imp_read_scope",
  impersonationMode: "read_only",
};
const scope = {
  scopeKind: "operating",
  merchantId: "merchant_target",
  storeId: "store_target",
  stockLocationId: "sloc_target",
};
const response = { json: vi.fn(), status: vi.fn() };

describe("order read routes under read-only impersonation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeUtils.actorWithPermission.mockResolvedValue(operator);
    routeUtils.actor.mockResolvedValue(operator);
    application.requireOperatingReadScope.mockResolvedValue(scope);
    application.listOrders.mockResolvedValue({ data: [] });
    application.prepareOrderRecreatePrefill.mockResolvedValue({ items: [] });
  });

  it("lists only the selected operating store without entering a mutation guard", async () => {
    const request = {
      headers: { authorization: "Bearer impersonation", "x-store-id": scope.storeId },
      query: { limit: "25" },
    };
    await listOrders(request as never, response as never);

    expect(application.requireOperatingReadScope).toHaveBeenCalledWith(operator, request.headers);
    expect(application.requireMutationScope).not.toHaveBeenCalled();
    expect(application.listOrders).toHaveBeenCalledWith({
      limit: "25",
      merchantId: scope.merchantId,
      storeIds: [scope.storeId],
    });
  });

  it("resolves recreate-prefill through the same read-only scope", async () => {
    const request = {
      headers: { authorization: "Bearer impersonation", "x-store-id": scope.storeId },
      params: { id: "order_target" },
    };
    await recreatePrefill(request as never, response as never);

    expect(application.requireOperatingReadScope).toHaveBeenCalledWith(operator, request.headers);
    expect(application.requireMutationScope).not.toHaveBeenCalled();
    expect(application.prepareOrderRecreatePrefill).toHaveBeenCalledWith("order_target", scope);
  });
});
