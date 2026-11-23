import { beforeEach, describe, expect, it, vi } from "vitest";
import { permissions } from "@medusa-snus/contracts";

const application = vi.hoisted(() => ({
  closeShift: vi.fn(),
  forceCloseShift: vi.fn(),
  getCurrentShift: vi.fn(),
  getMyShiftReport: vi.fn(),
  getShiftPolicy: vi.fn(),
  getShiftReport: vi.fn(),
  listMyShifts: vi.fn(),
  listShifts: vi.fn(),
  previewCloseShift: vi.fn(),
  receiveShiftHandover: vi.fn(),
  recordShiftCashMovement: vi.fn(),
  recordShiftStockCount: vi.fn(),
  reviewShift: vi.fn(),
  startShift: vi.fn(),
  updateShiftPolicy: vi.fn(),
}));

const routeUtils = vi.hoisted(() => ({
  actorWithOperatingScopeAccess: vi.fn(),
  actorWithOperatingScopeMutation: vi.fn(),
  actorWithReadableReportScopeAccess: vi.fn(),
  actorWithReportScope: vi.fn(),
  body: vi.fn((request) => request.body),
  headers: vi.fn((request) => request.headers),
  query: vi.fn((request) => request.query || {}),
  route: vi.fn(async (_response, handler) => handler()),
}));

vi.mock("@medusa-snus/application", () => application);
vi.mock("../../../../src/lib/route-utils", () => routeUtils);

import { GET as getCurrentShiftRoute } from "../../../../src/api/shifts/current/route";
import { POST as startShiftRoute } from "../../../../src/api/shifts/start/route";
import { POST as receiveHandoverRoute } from "../../../../src/api/shifts/handover-acknowledgements/route";
import { POST as cashMovementRoute } from "../../../../src/api/shifts/current/cash-movements/route";
import { POST as stockCountRoute } from "../../../../src/api/shifts/current/stock-counts/route";
import { POST as closePreviewRoute } from "../../../../src/api/shifts/current/close-preview/route";
import { POST as closeShiftRoute } from "../../../../src/api/shifts/current/close/route";
import { GET as getPolicyRoute, PATCH as updatePolicyRoute } from "../../../../src/api/shifts/policy/route";
import { GET as listShiftsRoute } from "../../../../src/api/shifts/route";
import { GET as getReportRoute } from "../../../../src/api/shifts/[id]/report/route";
import { GET as listMyShiftsRoute } from "../../../../src/api/shifts/mine/route";
import { GET as getMyReportRoute } from "../../../../src/api/shifts/mine/[id]/report/route";
import { POST as reviewRoute } from "../../../../src/api/shifts/[id]/review/route";
import { POST as forceCloseRoute } from "../../../../src/api/shifts/[id]/force-close/route";

const actor = { operatorId: "op_manager", role: "manager", displayName: "Manager", organizationId: "org_default" };
const operatingScope = { scopeKind: "operating", merchantId: "merchant_a", storeId: "store_a", stockLocationId: "sloc_a" };
const reportScope = { scopeKind: "report", merchantId: "merchant_a", storeIds: ["store_a"] };
const response = {
  status: vi.fn(() => response),
  json: vi.fn(),
} as never;

function request(body: Record<string, unknown> = {}, params: Record<string, string> = {}, reqQuery: Record<string, string> = {}) {
  return { headers: {}, body, params, query: reqQuery } as never;
}

function forbidden() {
  return Object.assign(new Error("forbidden"), { code: "forbidden" });
}

describe("shift routes enforce explicit scoped authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeUtils.actorWithOperatingScopeAccess.mockResolvedValue({ actor, scope: operatingScope });
    routeUtils.actorWithOperatingScopeMutation.mockResolvedValue({ actor, scope: operatingScope });
    routeUtils.actorWithReadableReportScopeAccess.mockResolvedValue({ actor, scope: reportScope });
    routeUtils.actorWithReportScope.mockResolvedValue({ actor, scope: reportScope });
    application.getCurrentShift.mockResolvedValue({ data: null });
    application.getShiftPolicy.mockResolvedValue({ data: { enabled: false } });
    application.startShift.mockResolvedValue({ statusCode: 201, response: { data: { id: "shift_1" } } });
    application.receiveShiftHandover.mockResolvedValue({ statusCode: 201, response: { data: { id: "ack_1" } } });
    application.recordShiftCashMovement.mockResolvedValue({ statusCode: 201, response: { data: { id: "cash_1" } } });
    application.recordShiftStockCount.mockResolvedValue({ statusCode: 201, response: { data: [] } });
    application.previewCloseShift.mockResolvedValue({ data: { shift: { id: "shift_1" } } });
    application.closeShift.mockResolvedValue({ statusCode: 201, response: { data: { shift: { id: "shift_1" } } } });
    application.updateShiftPolicy.mockResolvedValue({ statusCode: 201, response: { data: { enabled: true } } });
    application.listShifts.mockResolvedValue({ data: [] });
    application.listMyShifts.mockResolvedValue({ data: [] });
    application.getShiftReport.mockResolvedValue({ data: { shift: { id: "shift_1" } } });
    application.getMyShiftReport.mockResolvedValue({ data: { shift: { id: "shift_1" } } });
    application.reviewShift.mockResolvedValue({ statusCode: 201, response: { data: { id: "shift_1" } } });
    application.forceCloseShift.mockResolvedValue({ statusCode: 201, response: { data: { shift: { id: "shift_1" } } } });
  });

  it("reads current shift through shift:read operating scope", async () => {
    await getCurrentShiftRoute(request(), response);

    expect(routeUtils.actorWithOperatingScopeAccess).toHaveBeenCalledWith(expect.anything(), permissions.shiftRead);
    expect(application.getCurrentShift).toHaveBeenCalledWith(operatingScope);
  });

  it("opens shift and acknowledges handover through shift:open mutation scope", async () => {
    await startShiftRoute(request({ openingCashAmount: { currencyCode: "vnd", amountVnd: "1000000" } }), response);
    await receiveHandoverRoute(request({ previousShiftId: "shift_prev" }), response);

    expect(routeUtils.actorWithOperatingScopeMutation).toHaveBeenCalledWith(expect.anything(), permissions.shiftOpen);
    expect(application.startShift).toHaveBeenCalledWith(expect.anything(), expect.anything(), actor, operatingScope);
    expect(application.receiveShiftHandover).toHaveBeenCalledWith(expect.anything(), expect.anything(), actor, operatingScope);
  });

  it("records shift cash movement with shift:cash_adjust", async () => {
    await cashMovementRoute(request({ type: "pay_in", amount: { currencyCode: "vnd", amountVnd: "100000" }, reason: "float" }), response);

    expect(routeUtils.actorWithOperatingScopeMutation).toHaveBeenCalledWith(expect.anything(), permissions.shiftCashAdjust);
    expect(application.recordShiftCashMovement).toHaveBeenCalledWith(expect.anything(), expect.anything(), actor, operatingScope);
  });

  it("uses shift:close for stock count, close preview, and close", async () => {
    await stockCountRoute(request({ items: [{ inventoryItemId: "ii_1", countedQuantity: 10 }] }), response);
    await closePreviewRoute(request({ countedCashAmount: { currencyCode: "vnd", amountVnd: "1200000" } }), response);
    await closeShiftRoute(request({ countedCashAmount: { currencyCode: "vnd", amountVnd: "1200000" } }), response);

    expect(routeUtils.actorWithOperatingScopeMutation).toHaveBeenCalledWith(expect.anything(), permissions.shiftClose);
    expect(routeUtils.actorWithOperatingScopeAccess).toHaveBeenCalledWith(expect.anything(), permissions.shiftClose);
    expect(application.recordShiftStockCount).toHaveBeenCalledWith(expect.anything(), expect.anything(), actor, operatingScope);
    expect(application.previewCloseShift).toHaveBeenCalledWith(expect.anything(), operatingScope);
    expect(application.closeShift).toHaveBeenCalledWith(expect.anything(), expect.anything(), actor, operatingScope);
  });

  it("uses shift:manage for policy mutation and shift:read for policy read", async () => {
    await getPolicyRoute(request(), response);
    await updatePolicyRoute(request({ enabled: true }), response);

    expect(routeUtils.actorWithOperatingScopeAccess).toHaveBeenCalledWith(expect.anything(), permissions.shiftRead);
    expect(routeUtils.actorWithOperatingScopeMutation).toHaveBeenCalledWith(expect.anything(), permissions.shiftManage);
    expect(application.updateShiftPolicy).toHaveBeenCalledWith(expect.anything(), expect.anything(), actor, operatingScope);
  });

  it("uses report scope for manager history and reports", async () => {
    await listShiftsRoute(request({}, {}, { status: "closed" }), response);
    await getReportRoute(request({}, { id: "shift_1" }), response);

    expect(routeUtils.actorWithReportScope).toHaveBeenCalledWith(expect.anything(), "staff", permissions.shiftReport);
    expect(application.listShifts).toHaveBeenCalledWith(reportScope, { status: "closed" });
    expect(application.getShiftReport).toHaveBeenCalledWith("shift_1", reportScope);
  });

  it("uses shift:read report scope for staff self history and reports", async () => {
    await listMyShiftsRoute(request({}, {}, { status: "closed" }), response);
    await getMyReportRoute(request({}, { id: "shift_1" }), response);

    expect(routeUtils.actorWithReadableReportScopeAccess).toHaveBeenCalledWith(expect.anything(), permissions.shiftRead);
    expect(routeUtils.actorWithReportScope).not.toHaveBeenCalledWith(expect.anything(), "staff", permissions.shiftReport);
    expect(application.listMyShifts).toHaveBeenCalledWith(actor, reportScope, { status: "closed" });
    expect(application.getMyShiftReport).toHaveBeenCalledWith("shift_1", actor, reportScope);
  });

  it("uses shift:review and shift:manage for manager mutation routes", async () => {
    await reviewRoute(request({ reviewStatus: "approved" }, { id: "shift_1" }), response);
    await forceCloseRoute(request({ reason: "stale" }, { id: "shift_1" }), response);

    expect(routeUtils.actorWithReportScope).toHaveBeenCalledWith(expect.anything(), "staff", permissions.shiftReview);
    expect(routeUtils.actorWithReportScope).toHaveBeenCalledWith(expect.anything(), "staff", permissions.shiftManage);
    expect(application.reviewShift).toHaveBeenCalledWith(expect.anything(), "shift_1", expect.anything(), actor, reportScope);
    expect(application.forceCloseShift).toHaveBeenCalledWith(expect.anything(), "shift_1", expect.anything(), actor, reportScope);
  });

  it("denies before calling shift services when operating-scope auth fails", async () => {
    routeUtils.actorWithOperatingScopeMutation.mockRejectedValue(forbidden());

    await expect(startShiftRoute(request({}), response)).rejects.toMatchObject({ code: "forbidden" });
    expect(application.startShift).not.toHaveBeenCalled();
  });
});
