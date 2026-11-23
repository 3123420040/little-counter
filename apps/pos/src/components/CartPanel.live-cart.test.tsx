// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { CartPanel } from "./CartPanel";
import { useCart } from "../hooks/useCart";
import { renderTestUi, buttonByText, click, type TestRender } from "../test/reactTestHarness";
vi.mock("../i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
let mounted: TestRender | null = null;
afterEach(() => { mounted?.unmount(); mounted = null; });
function CartHarness() {
  const cart = useCart();
  const next = cart.items.length + 1;
  return <><button onClick={() => cart.addItem({ variantId: `v-${next}`, productId: `p-${next}`, productName: `Audit product ${next}`, sku: `sku-${next}`, quantity: 1, unitPrice: 1000, stockLevel: 100 })}>Add product</button>
    <div data-selected-index={cart.selectedIndex} />
    <CartPanel {...cart} onSelectItem={cart.selectItem} onUpdateQty={cart.updateQty} onRemove={cart.removeItem} onClear={cart.clearCart} onCheckout={() => {}} adjustment={{ discountType: "amount", discountValue: 0, shippingFee: 0 }} onAdjustmentChange={() => {}} />
  </>;
}
it("contract challenge: newly added live-cart line remains visible to the cashier", () => {
  mounted = renderTestUi(<CartHarness />);
  for (let index = 0; index < 11; index++) click(buttonByText(mounted.container, "Add product"));
  expect(mounted.container.querySelector("[data-selected-index]")?.getAttribute("data-selected-index")).toBe("10");
  const exactLabel = Array.from(mounted.container.querySelectorAll("p,span,div")).some(element => element.childNodes.length === 1 && element.textContent === "Audit product 11");
  expect(mounted.container.querySelector('[aria-label="Phân trang dòng giỏ hàng"]')).toBeNull();
  expect(exactLabel).toBe(true);
});
