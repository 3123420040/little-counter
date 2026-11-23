import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("canonical dashboard legacy-fallback boundary", () => {
  it("routes canonical mode through creator sales before any legacy panel", () => {
    const source = readFileSync(
      new URL("./DashboardScreen.tsx", import.meta.url),
      "utf8",
    );
    const surface = readFileSync(
      new URL("../components/DashboardOverviewSurface.tsx", import.meta.url),
      "utf8",
    );
    const canonicalSelection = source.search(
      /const canonicalFinancialSelected\s*=\s*ORDER_FINANCIAL_FEATURE_UI_DEFAULT_CONFIG_V1\.partialFinancialDashboardEnabled;/,
    );
    const firstLegacyQuery = source.indexOf('queryKey: ["dashboard", from, to]');

    expect(canonicalSelection).toBeGreaterThan(-1);
    expect(firstLegacyQuery).toBeGreaterThan(canonicalSelection);
    expect(source.match(/enabled: !canonicalFinancialSelected,/g)).toHaveLength(3);
    expect(source.indexOf("<CreatorSalesDashboardSurface")).toBeLessThan(
      source.indexOf("if (\n    !canonicalFinancialSelected"),
    );
    expect(source).toContain("buildDashboardOverviewPresentationV1");
    expect(surface).toContain('<PageHeader title="Tổng quan"');
    expect(surface).toContain('"Chỉ số chính"');
    expect(surface).toContain('title="Giá trị đơn hàng và số đơn"');
    expect(surface).not.toContain('title="Tiền thực thu và đơn hàng"');
    expect(surface).toContain('"Góc nhìn chủ cửa hàng"');
    expect(surface).toContain('title="Sản phẩm nổi bật"');
    expect(surface).toContain('title="Phương thức thanh toán"');
    expect(surface).toContain('title="Toàn cửa hàng"');
    expect(surface).toContain('Rủi ro vận hành');
    expect(surface).not.toContain("factorStates");
    expect(surface).not.toContain("internal tab");
  });
});
