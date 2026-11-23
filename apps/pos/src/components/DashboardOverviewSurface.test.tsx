// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { renderTestUi, click, type TestRender } from "../test/reactTestHarness";
import type { DashboardOverviewPresentationV1 } from "../utils/dashboardOverviewPresentation";
import { DashboardOverviewSurface } from "./DashboardOverviewSurface";

let mounted: TestRender | undefined;
afterEach(() => mounted?.unmount());
const unavailable = { status: "unavailable" as const, reason: "Missing dataset" };
function fixture(): DashboardOverviewPresentationV1 {
  return {
    navigationLabel: "Tổng quan", datePresets: [], sectionOrder: [], factorCensus: [],
    context: { merchantId: "synthetic", storeIds: ["synthetic"], localDateRange: { from: "2026-09-01", to: "2026-09-01", inclusiveDays: 1 }, storeTimeWindows: [], reportAsOf: "2026-09-02T00:00:00Z", generatedAt: "2026-09-02T00:00:00Z", freshnessStatus: "fresh" },
    sharedMetricCards: { publishedSkuCount: unavailable, newCustomerCount: unavailable },
    sharedOwnerInsight: { rows: [{ id: "sold_item_quantity", label: "Số sản phẩm đã bán", status: "available", value: 3, unit: "item_count" }] },
    currencyBlocks: [{ currencyCode: "VND", minorUnitExponent: 0,
      metricCards: [{ id: "accounting_gross_profit", label: "Lợi nhuận xác minh được", status: "available", valueMinor: 1234567890, coverage: { covered: 2, total: 3, excluded: 1 } }],
      dailyChart: unavailable, ownerInsight: { rows: [] }, topProducts: unavailable, topProductNarrative: unavailable,
      paymentMix: { status: "available", empty: true, items: ["Cash", "COD", "Bank"].map(label => ({ method: label, label, postedChargeOrderCount: 0, postedNegativeEventCount: 0, grossMinor: 0, negativeMinor: 0, netMinor: 0 })) },
    }],
    operationalRisk: { aiPending: unavailable, lowStock: unavailable, outOfStock: unavailable },
  };
}
function render(presentation: DashboardOverviewPresentationV1 | null, loading = false, error = false) {
  mounted = renderTestUi(<DashboardOverviewSurface presentation={presentation} from="2026-09-01" to="2026-09-01" today="2026-09-05" loading={loading} error={error} stale={false} onFrom={() => undefined} onTo={() => undefined} onPreset={() => undefined} onRetry={() => undefined} />);
  return mounted.container;
}
describe("Overview 2.0 rendered acceptance", () => {
  it("renders one sold item total, all zero methods and full partial money with accessible disclosure", () => {
    const container = render(fixture());
    expect(container.textContent?.match(/Số sản phẩm đã bán/g)).toHaveLength(1);
    expect(container.textContent).toContain("3 sản phẩm");
    expect(container.textContent).not.toContain("Tổng tiền đã ghi nhận thu");
    expect(container.textContent).toContain("1.234.567.890 VND");
    expect(container.textContent).toMatch(/Cash.*COD.*Bank/);
    expect(container.textContent?.match(/0 đơn · 0 VND/g)).toHaveLength(3);
    const summary = [...container.querySelectorAll("summary")].find(s => s.textContent?.includes("2/3 bút toán"))!;
    expect(summary).toBeDefined();
    click(summary);
    expect(summary.closest("details")?.open).toBe(true);
    expect(summary.closest("details")?.textContent).toContain("không phải lợi nhuận toàn kỳ");
  });
  it("unavailable payment and quantity never appear as valid zero", () => {
    const model = fixture(); model.currencyBlocks[0]!.paymentMix = unavailable;
    model.sharedOwnerInsight.rows = [{ id: "sold_item_quantity", label: "Số sản phẩm đã bán", unit: "item_count", ...unavailable }];
    const container = render(model);
    expect(container.textContent).not.toContain("0 đơn");
    expect(container.textContent).not.toContain("0 sản phẩm");
    expect(container.textContent).toContain("Chưa khả dụng");
  });
  it("loading and hard request error do not fabricate metric numbers", () => {
    expect(render(null,true).textContent).toContain("Đang tải Tổng quan");
    mounted!.unmount(); mounted=undefined;
    const error = render(null,false,true);
    expect(error.textContent).toContain("Không thể tải dữ liệu");
    expect(error.textContent).not.toContain("0 VND");
  });
});
