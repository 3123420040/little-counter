// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { buttonByText, click, renderTestUi, type TestRender } from "../test/reactTestHarness";
import { StockShortageWarningModal } from "./StockShortageWarningModal";
let mounted: TestRender | undefined;
afterEach(() => { mounted?.unmount(); });
describe("found-stock recovery dialog", () => {
  it("shows a lost-response error inside the active dialog while retaining the retry action", () => {
    const onConfirm = vi.fn();
    mounted = renderTestUi(<StockShortageWarningModal shortages={[{ variantId: "v", productName: "Product", systemStock: 0,
      requestedQuantity: 1, shortageQuantity: 1 }]} errorMessage="Chưa có kết quả, kiểm tra cùng đơn."
      onConfirm={onConfirm} onBack={vi.fn()} />);
    expect(mounted.container.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain("Chưa có kết quả");
    click(buttonByText(mounted.container, "Xác nhận đã tìm thấy hàng"));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
