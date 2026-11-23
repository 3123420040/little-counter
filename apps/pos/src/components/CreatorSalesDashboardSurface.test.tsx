// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreatorSalesDashboardV2Schema } from "@medusa-snus/contracts";
import { creatorSalesDashboardFixture, creatorSalesDashboardV3Fixture } from "../../../../packages/application/src/__tests__/fixtures/creator-sales-dashboard";
import { renderTestUi, click, type TestRender } from "../test/reactTestHarness";
import { CreatorSalesDashboardSurface } from "./CreatorSalesDashboardSurface";
import { OrderCreatorFilter } from "./OrderCreatorFilter";

let mounted: TestRender | undefined;
afterEach(() => { mounted?.unmount(); mounted = undefined; });

describe("creator sales dashboard rendered acceptance", () => {
  it.each(["self", "full"] as const)("renders V3 customer fees and preserves the financial boundary for %s", (audience) => {
    mounted = renderTestUi(<CreatorSalesDashboardSurface dashboard={creatorSalesDashboardV3Fixture(audience)}
      from="2026-10-18" to="2026-10-18" today="2026-10-18" creatorOperatorIds={["staff_a"]}
      loading={false} error={false} onFrom={vi.fn()} onTo={vi.fn()} onPreset={vi.fn()}
      onCreatorOperatorIds={vi.fn()} onRetry={vi.fn()} />);
    const text = mounted.container.textContent!;
    expect(text).toContain("Phụ phí theo đơn (ngày tạo đơn)100 VND");
    expect(text).toContain("Phân bổ phí trong khoản thu (ngày thu)100 VND");
    expect(text).toContain("Số sản phẩm đã bán");
    expect(text).toContain("Toàn cửa hàng");
    expect(text.includes("Doanh thu phí theo đơn chưa VAT91 VND")).toBe(audience === "full");
    expect(text.includes("Doanh thu phí đã ghi sổ (kỳ nguồn)91 VND")).toBe(audience === "full");
    expect(text.includes("Lợi nhuận gộp kế toán400 VND")).toBe(audience === "full");
  });

  it("labels partially verified fee events and journals without claiming missing cost evidence", () => {
    const dashboard = creatorSalesDashboardV3Fixture("full");
    dashboard.feeFinancial!.negatives.currencies = [{ currencyCode: "VND", minorUnitExponent: 0,
      feeRevenueReversedExVatMinor: null, verifiedSubsetFeeRevenueReversedExVatMinor: 41, verifiedSubsetSettlementOnlyMinor: 0,
      coverage: { status: "partial", coveredEventCount: 1, excludedEventCount: 1, totalEventCount: 2,
        coveredNegativeMinor: 545, excludedNegativeMinor: 545, totalNegativeMinor: 1090 }, warnings: ["evidence_unavailable"] }];
    dashboard.feeFinancial!.journals.currencies[0] = { currencyCode: "VND", minorUnitExponent: 0,
      revenueExcludingVatMinor: null, verifiedSubsetRevenueExcludingVatMinor: -41,
      coverage: { status: "partial", totalJournalCount: 2, coveredJournalCount: 1, excludedJournalCount: 1 }, warnings: ["fee_lineage_mismatch"] };
    mounted = renderTestUi(<CreatorSalesDashboardSurface dashboard={dashboard}
      from="2026-10-18" to="2026-10-18" today="2026-10-18" creatorOperatorIds={["staff_a"]}
      loading={false} error={false} onFrom={vi.fn()} onTo={vi.fn()} onPreset={vi.fn()}
      onCreatorOperatorIds={vi.fn()} onRetry={vi.fn()} />);
    const text = mounted.container.textContent!;
    expect(text).toContain("Phí đảo doanh thu khi hoàn chưa VAT — phần xác minh được41 VND");
    expect(text).toContain("Doanh thu phí đã ghi sổ (kỳ nguồn) — phần xác minh được-41 VND");
    expect(text).toContain("Đã xác minh 1/2 sự kiện · Chưa đủ bằng chứng 1 sự kiện");
    expect(text).toContain("Đã xác minh 1/2 bút toán · Chưa đủ bằng chứng 1 bút toán");
    expect(text).not.toContain("Thiếu giá vốn");
    expect(text).toContain("không phải doanh thu phí toàn kỳ");
  });

  it("shows unavailable fee evidence explicitly and retains signed correction allocations", () => {
    const dashboard = creatorSalesDashboardV3Fixture("full");
    Object.assign(dashboard.currencies[0]!, { recordedPaymentFeeMinor: -100, recordedPaymentFeeVatMinor: -9, recordedPaymentFeeCustomerTotalMinor: -100 });
    dashboard.feeFinancial!.currencies[0]!.recordedPaymentFeeRevenueExVatMinor = -91;
    Object.assign(dashboard.feeFinancial!.journals.currencies[0]!, { revenueExcludingVatMinor: null, verifiedSubsetRevenueExcludingVatMinor: 0,
      coverage: { status: "unavailable", totalJournalCount: 1, coveredJournalCount: 0, excludedJournalCount: 1 }, warnings: ["fee_lineage_mismatch"] });
    mounted = renderTestUi(<CreatorSalesDashboardSurface dashboard={dashboard}
      from="2026-10-18" to="2026-10-18" today="2026-10-18" creatorOperatorIds={["staff_a"]}
      loading={false} error={false} onFrom={vi.fn()} onTo={vi.fn()} onPreset={vi.fn()}
      onCreatorOperatorIds={vi.fn()} onRetry={vi.fn()} />);
    const text = mounted.container.textContent!;
    expect(text).toContain("Phân bổ phí trong khoản thu (ngày thu)-100 VND");
    expect(text).toContain("Phí phân bổ trong khoản thu chưa VAT-91 VND");
    expect(text).toContain("Doanh thu phí đã ghi sổ (kỳ nguồn)Chưa khả dụng");
    expect(text).not.toContain("Doanh thu phí đã ghi sổ (kỳ nguồn)0 VND");
  });
  it.each(["loading", "error"] as const)("does not offer a full creator filter before authority is known during %s", (state) => {
    const onChange = vi.fn();
    mounted = renderTestUi(<CreatorSalesDashboardSurface dashboard={null}
      from="2026-10-18" to="2026-10-18" today="2026-10-18" creatorOperatorIds={[]}
      loading={state === "loading"} error={state === "error"} onFrom={vi.fn()} onTo={vi.fn()} onPreset={vi.fn()}
      onCreatorOperatorIds={onChange} onRetry={vi.fn()} />);
    expect(mounted.container.textContent).toContain("Chưa xác định phạm vi người tạo đơn.");
    expect(mounted.container.textContent).not.toContain("Tất cả người tạo");
    expect(mounted.container.querySelector('summary[aria-label="Lọc người tạo đơn"]')).toBeNull();
    expect(mounted.container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps a full selector open and restores focus unless moved elsewhere (%s)", (movedFocus) => {
    const render = (pending: boolean) => <CreatorSalesDashboardSurface dashboard={pending ? null : creatorSalesDashboardFixture("full")}
      from="2026-10-18" to="2026-10-18" today="2026-10-18" creatorOperatorIds={["staff_a"]}
      loading={pending} error={false} onFrom={vi.fn()} onTo={vi.fn()} onPreset={vi.fn()}
      onCreatorOperatorIds={vi.fn()} onRetry={vi.fn()} />;
    mounted = renderTestUi(render(false));
    const selector = mounted.container.querySelector("details")!;
    selector.open = true;
    const choice = selector.querySelector<HTMLInputElement>("input")!;
    choice.focus();
    click(choice);
    mounted.rerender(render(true));
    expect(mounted.container.querySelector("details")).toBe(selector);
    expect(selector.open).toBe(true);
    expect(selector.querySelector("input")).toBeNull();
    const date = mounted.container.querySelector<HTMLInputElement>('input[type="date"]')!;
    if (movedFocus) date.focus();
    mounted.rerender(render(false));
    expect(mounted.container.querySelector("details")).toBe(selector);
    expect(selector.open).toBe(true);
    expect(selector.querySelector("input")).not.toBeNull();
    expect(document.activeElement).toBe(movedFocus ? date : selector.querySelector("input"));
  });

  it.each(["self", "full"] as const)("preserves chart, sales insights, products, payment mix and global context for %s", (audience) => {
    mounted = renderTestUi(<CreatorSalesDashboardSurface dashboard={creatorSalesDashboardFixture(audience)}
      from="2026-10-18" to="2026-10-18" today="2026-10-18" creatorOperatorIds={["staff_a"]}
      loading={false} error={false} onFrom={vi.fn()} onTo={vi.fn()} onPreset={vi.fn()}
      onCreatorOperatorIds={vi.fn()} onRetry={vi.fn()} />);
    const text = mounted.container.textContent!;
    expect(text).toContain("Giá trị đơn hàng và số đơn");
    expect(text).toContain("Số sản phẩm đã bán");
    expect(text).toContain("4 sản phẩm");
    expect(text).toContain("Apple");
    expect(text).toContain("Phương thức thanh toán");
    expect(text).toContain("2 đơn · 420.000 VND");
    expect(text).toContain("Toàn cửa hàng");
    expect(text).toContain("SKU, khách mới và AI tính toàn merchant");
    expect(text).toContain("245");
    expect(text).not.toContain("Giá trị hàng hóa hiện tại chưa VAT");
    expect(text.includes("Lợi nhuận gộp kế toán")).toBe(audience === "full");
    expect(text.includes("Biên lợi nhuận")).toBe(audience === "full");
    expect(mounted.container.querySelectorAll('input[type="checkbox"]').length).toBe(audience === "full" ? 1 : 0);
  });

  it("supports accessible multiple choices, distinguishes duplicate names and clears to all", () => {
    const onChange = vi.fn();
    const options = [
      { operatorId: "a", displayName: "An", status: "active" as const },
      { operatorId: "b", displayName: "An", status: "historical" as const },
    ];
    const render = (selectedIds: string[]) => <OrderCreatorFilter options={options} selectedIds={selectedIds} onChange={onChange} />;
    mounted = renderTestUi(render(["b"]));
    expect(mounted.container.textContent).toContain("An · a");
    expect(mounted.container.textContent).toContain("An · b (lịch sử)");
    const checkbox = mounted.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    click(checkbox);
    expect(onChange).toHaveBeenLastCalledWith(["a", "b"]);
    mounted.rerender(render(["a", "b"]));
    click(mounted.container.querySelector('input[type="checkbox"]')!);
    expect(onChange).toHaveBeenLastCalledWith(["b"]);
    click(mounted.container.querySelector("button")!);
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("rejects accounting and nested cost fields at the self response boundary", () => {
    const self = creatorSalesDashboardFixture();
    expect(CreatorSalesDashboardV2Schema.safeParse({ ...self, financial: creatorSalesDashboardFixture("full").financial }).success).toBe(false);
    expect(CreatorSalesDashboardV2Schema.safeParse({ ...self, currencies: [{ ...self.currencies[0], currentCogsMinor: 123 }] }).success).toBe(false);
    expect(CreatorSalesDashboardV2Schema.safeParse({ ...self, currencies: [{ ...self.currencies[0], topProducts: [{ ...self.currencies[0].topProducts[0], currentCogsMinor: 123 }] }] }).success).toBe(false);
  });
});
