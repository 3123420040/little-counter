import { describe, expect, it, vi } from "vitest";
import { ORDER_FINANCIAL_FEATURE_UI_DEFAULT_CONFIG_V1 } from "../config/orderFinancialFeature";
import {
  createPartialFinancialDashboardUiTaskV1,
  partialFinancialDashboardPathV1,
} from "./orderFinancialFeatureUiIntegration";

const scope = {
  operatingMerchantId: "merchant-a",
  operatingStoreId: "store-a",
  reportMerchantId: "merchant-a",
  reportStoreIds: ["store-a"],
};

describe("order financial feature-only UI integration", () => {
  it("keeps every canonical surface immutable and selected by default", async () => {
    expect(Object.isFrozen(ORDER_FINANCIAL_FEATURE_UI_DEFAULT_CONFIG_V1)).toBe(true);
    expect(Object.values(ORDER_FINANCIAL_FEATURE_UI_DEFAULT_CONFIG_V1)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    const transport = vi.fn();
    const task = createPartialFinancialDashboardUiTaskV1(transport, {
      from: "2026-08-01",
      to: "2026-08-02",
      nowEpochSeconds: 1,
      requestId: "request-1",
      scope,
    });
    expect(task).toMatchObject({
      enabled: true,
      request: { range: { from: "2026-08-01", to: "2026-08-02" } },
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("builds a scope-bound enabled dashboard task and an additive route URL", () => {
    const transport = vi.fn();
    const task = createPartialFinancialDashboardUiTaskV1(transport, {
      from: "2026-08-01",
      to: "2026-08-02",
      nowEpochSeconds: 1_785_974_400,
      requestId: "request-1",
      scope,
    }, {
      ...ORDER_FINANCIAL_FEATURE_UI_DEFAULT_CONFIG_V1,
      partialFinancialDashboardEnabled: true,
    });
    expect(task).toMatchObject({
      enabled: true,
      request: {
        scope: {
          scopeKind: "report",
          merchantId: "merchant-a",
          storeIds: ["store-a"],
        },
        range: { from: "2026-08-01", to: "2026-08-02", inclusiveDays: 2 },
      },
    });
    if (!task.enabled) throw new Error("expected enabled task");
    expect(partialFinancialDashboardPathV1(task.request)).toBe(
      "/api/platform/admin/dashboard/partial-financial?from=2026-08-01&to=2026-08-02",
    );
  });

  it("fails enabled mode closed when report scope or range is unavailable", () => {
    const enabled = {
      ...ORDER_FINANCIAL_FEATURE_UI_DEFAULT_CONFIG_V1,
      partialFinancialDashboardEnabled: true,
    };
    expect(() => createPartialFinancialDashboardUiTaskV1(vi.fn(), {
      from: "2026-08-02",
      to: "2026-08-01",
      nowEpochSeconds: 1,
      requestId: "request-1",
      scope,
    }, enabled)).toThrow(/active report scope and valid range/);
    expect(() => createPartialFinancialDashboardUiTaskV1(vi.fn(), {
      from: "2026-08-01",
      to: "2026-08-02",
      nowEpochSeconds: 1,
      requestId: "request-1",
      scope: { ...scope, reportMerchantId: "", reportStoreIds: [] },
    }, enabled)).toThrow(/active report scope and valid range/);
  });
});
