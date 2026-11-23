// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { buttonByText, click, renderTestUi, type TestRender } from "../test/reactTestHarness";

vi.mock("../i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("./CartItemRow", async () => {
  const React = await import("react");
  return {
    CartItemRow: ({ item, onSelect }: { item: { productName: string }; onSelect: () => void }) => React.createElement(
      "button",
      { type: "button", onClick: onSelect },
      item.productName,
    ),
  };
});

import { CartPanel } from "./CartPanel";

let mounted: TestRender | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.clearAllMocks();
});

describe("CartPanel pagination", () => {
  it("keeps the global cart-item index when selecting a row on a later page", () => {
    const onSelectItem = vi.fn();
    const items = Array.from({ length: 11 }, (_, index) => ({
      variantId: `variant-${index}`,
      productId: `product-${index}`,
      productName: `Product ${index}`,
      sku: `SKU-${index}`,
      quantity: 1,
      unitPrice: 10_000,
      stockLevel: 5,
    }));

    mounted = renderTestUi(
      <CartPanel
        paginateItems
        items={items}
        selectedIndex={null}
        subtotal={110_000}
        itemCount={11}
        adjustment={{ discountType: "amount", discountValue: 0, shippingFee: 0 }}
        onAdjustmentChange={vi.fn()}
        onUpdateQty={vi.fn()}
        onRemove={vi.fn()}
        onSelectItem={onSelectItem}
        onClear={vi.fn()}
        onCheckout={vi.fn()}
      />,
    );

    expect(mounted.container.textContent).toContain("Product 0");
    expect(mounted.container.textContent).not.toContain("Product 10");
    click(mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Trang tiếp"]')!);
    click(buttonByText(mounted.container, "Product 10"));

    expect(onSelectItem).toHaveBeenCalledWith(10);
  });
});
