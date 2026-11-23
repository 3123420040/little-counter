import { describe, expect, it, vi } from "vitest";
import {
  createDashboardPartialFinancialInitialStateV1,
  reduceDashboardPartialFinancialStateV1,
  type DashboardPartialFinancialStateV1,
} from "./dashboardPartialFinancialState";
import {
  DASHBOARD_PARTIAL_FINANCIAL_CONTROLLER_DEFAULT_CONFIG_V1,
  createDashboardPartialFinancialLoadControllerV1,
} from "./dashboardPartialFinancialController";

const context = {
  schemaVersion: 1 as const,
  normalizedScope: {
    scopeKind: "report" as const,
    merchantId: "merchant-a",
    storeIds: ["store-a"],
  },
  localDateRange: {
    from: "2026-08-05",
    to: "2026-08-05",
    inclusiveDays: 1,
  },
  storeTimeWindows: [{
    storeId: "store-a",
    timeZone: "UTC",
    startInclusive: "2026-08-05T00:00:00.000Z",
    endExclusive: "2026-08-06T00:00:00.000Z",
  }],
  reportAsOf: "2026-08-05T12:00:00.000Z",
  generatedAt: "2026-08-05T12:00:00.250Z",
  metricTimeBasis: {
    recordedGrossCollectionsMinor: "payment_event_at" as const,
    refundsMinor: "payment_event_at" as const,
    reversalsMinor: "payment_event_at" as const,
    chargebacksMinor: "payment_event_at" as const,
    currentOrderGrossValueMinor: "effective_order_created_at" as const,
    commercialOutstandingAsOfMinor: "as_of_effective_order_and_payment_events" as const,
    customerRefundPayableAsOfMinor: "as_of_payment_events" as const,
    revenueExcludingVatMinor: "accounting_source_occurred_at" as const,
    vatLiabilityMinor: "accounting_source_occurred_at" as const,
    cogsRecognizedMinor: "accounting_source_occurred_at" as const,
  },
  freshness: {
    databaseSnapshot: {
      status: "fresh" as const,
      asOf: "2026-08-05T12:00:00.000Z",
    },
  },
};

const presentation = {
  enabled: true as const,
  factorStates: [],
  currencies: [{
    currencyCode: "VND",
    minorUnitExponent: 0,
    validOrderCount: 2,
    commercial: { status: "unavailable" as const },
    headlines: [{
      key: "current_order_value" as const,
      label: "Giá trị đơn hàng hiện tại",
      valueMinor: 420_000,
      help: "commercial",
    }, {
      key: "recorded_gross_collection" as const,
      label: "Tổng tiền đã ghi nhận thu (gồm VAT và các khoản tính thêm)",
      valueMinor: 253_000,
      help: "collection",
    }],
    collectionStateLabel: null,
    collectionBreakdown: null,
    paymentMethods: [],
    unavailable: {
      label: "Chưa khả dụng — chờ hoàn tất chính sách kế toán" as const,
      metricKeys: ["refundsMinor"],
    },
  }],
};

function readyState(): DashboardPartialFinancialStateV1 {
  let state = createDashboardPartialFinancialInitialStateV1(true, "selection-a");
  state = reduceDashboardPartialFinancialStateV1(state, {
    type: "request_started",
    selectionKey: "selection-a",
    requestId: "request-a",
  });
  return reduceDashboardPartialFinancialStateV1(state, {
    type: "request_succeeded",
    selectionKey: "selection-a",
    requestId: "request-a",
    context,
    presentation,
  });
}

describe("DASH-PARTIAL-STATE-01 stale-safe POS state/controller", () => {
  it("uses frozen default-off state and controller before task/transport use", async () => {
    expect(DASHBOARD_PARTIAL_FINANCIAL_CONTROLLER_DEFAULT_CONFIG_V1)
      .toEqual({ enabled: false });
    expect(Object.isFrozen(DASHBOARD_PARTIAL_FINANCIAL_CONTROLLER_DEFAULT_CONFIG_V1)).toBe(true);
    expect(createDashboardPartialFinancialInitialStateV1(false)).toEqual({ status: "disabled" });
    const transport = vi.fn();
    const controller = createDashboardPartialFinancialLoadControllerV1({ transport }, {
      requestId: "",
    } as never);
    expect(controller).toEqual({ enabled: false, status: "disabled" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("clears prior merchant data immediately when selection changes", () => {
    const state = readyState();
    expect(state.status).toBe("ready");

    expect(reduceDashboardPartialFinancialStateV1(state, {
      type: "selection_changed",
      selectionKey: "selection-a",
    })).toBe(state);

    const changed = reduceDashboardPartialFinancialStateV1(state, {
      type: "selection_changed",
      selectionKey: "selection-b",
    });
    expect(changed).toEqual({ status: "idle", selectionKey: "selection-b" });
    expect(changed).not.toHaveProperty("context");
    expect(changed).not.toHaveProperty("presentation");
  });

  it("cannot leave disabled state through selection or request events", () => {
    const disabled = createDashboardPartialFinancialInitialStateV1(false);
    expect(reduceDashboardPartialFinancialStateV1(disabled, {
      type: "selection_changed",
      selectionKey: "selection-a",
    })).toBe(disabled);
    expect(reduceDashboardPartialFinancialStateV1(disabled, {
      type: "request_started",
      selectionKey: "selection-a",
      requestId: "request-a",
    })).toBe(disabled);
  });

  it("ignores stale success/failure after a newer selection or request starts", () => {
    let state = createDashboardPartialFinancialInitialStateV1(true, "selection-a");
    state = reduceDashboardPartialFinancialStateV1(state, {
      type: "request_started",
      selectionKey: "selection-a",
      requestId: "request-a",
    });
    state = reduceDashboardPartialFinancialStateV1(state, {
      type: "selection_changed",
      selectionKey: "selection-b",
    });
    state = reduceDashboardPartialFinancialStateV1(state, {
      type: "request_started",
      selectionKey: "selection-b",
      requestId: "request-b",
    });

    const afterOldSuccess = reduceDashboardPartialFinancialStateV1(state, {
      type: "request_succeeded",
      selectionKey: "selection-a",
      requestId: "request-a",
      context,
      presentation,
    });
    expect(afterOldSuccess).toBe(state);
    const afterOldFailure = reduceDashboardPartialFinancialStateV1(state, {
      type: "request_failed",
      selectionKey: "selection-a",
      requestId: "request-a",
      message: "Không thể tải tổng quan tài chính",
    });
    expect(afterOldFailure).toBe(state);
  });

  it("allows only the latest request for one selection to settle", () => {
    let state = createDashboardPartialFinancialInitialStateV1(true, "selection-a");
    state = reduceDashboardPartialFinancialStateV1(state, {
      type: "request_started",
      selectionKey: "selection-a",
      requestId: "request-a",
    });
    state = reduceDashboardPartialFinancialStateV1(state, {
      type: "request_started",
      selectionKey: "selection-a",
      requestId: "request-b",
    });
    const stale = reduceDashboardPartialFinancialStateV1(state, {
      type: "request_succeeded",
      selectionKey: "selection-a",
      requestId: "request-a",
      context,
      presentation,
    });
    expect(stale).toBe(state);
    const latest = reduceDashboardPartialFinancialStateV1(state, {
      type: "request_succeeded",
      selectionKey: "selection-a",
      requestId: "request-b",
      context,
      presentation,
    });
    expect(latest).toMatchObject({
      status: "ready",
      selectionKey: "selection-a",
      requestId: "request-b",
      context,
      presentation,
    });
  });

  it("maps an enabled query task into matching started and settled events", async () => {
    const execute = vi.fn().mockResolvedValue({
      kind: "ready",
      requestId: "request-a",
      context,
      presentation,
    });
    const createTask = vi.fn(() => ({
      enabled: true as const,
      requestKey: "selection-a",
      request: { scope: context.normalizedScope, range: context.localDateRange },
      execute,
    }));
    const controller = createDashboardPartialFinancialLoadControllerV1({
      transport: vi.fn(),
      createTask: createTask as never,
      config: { enabled: true },
    }, {
      requestId: "request-a",
      scope: context.normalizedScope,
      range: context.localDateRange,
      nowEpochSeconds: 1_786_000_000,
    });
    if (!controller.enabled) throw new Error("expected enabled controller");

    expect(controller.initialEvent).toEqual({
      type: "request_started",
      selectionKey: "selection-a",
      requestId: "request-a",
    });
    await expect(controller.execute()).resolves.toEqual({
      type: "request_succeeded",
      selectionKey: "selection-a",
      requestId: "request-a",
      context,
      presentation,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("maps sanitized query failures without exposing transport text", async () => {
    const createTask = vi.fn(() => ({
      enabled: true as const,
      requestKey: "selection-a",
      request: { scope: context.normalizedScope, range: context.localDateRange },
      execute: vi.fn().mockResolvedValue({
        kind: "failed",
        requestId: "request-a",
        message: "Không thể tải tổng quan tài chính",
      }),
    }));
    const controller = createDashboardPartialFinancialLoadControllerV1({
      transport: vi.fn(),
      createTask: createTask as never,
      config: { enabled: true },
    }, {
      requestId: "request-a",
      scope: context.normalizedScope,
      range: context.localDateRange,
      nowEpochSeconds: 1_786_000_000,
    });
    if (!controller.enabled) throw new Error("expected enabled controller");

    await expect(controller.execute()).resolves.toEqual({
      type: "request_failed",
      selectionKey: "selection-a",
      requestId: "request-a",
      message: "Không thể tải tổng quan tài chính",
    });
  });
});
