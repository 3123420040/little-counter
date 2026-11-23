// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { useCart, type CartItemVisionContext } from "./useCart";
import { buttonByText, click, renderTestUi, type TestRender } from "../test/reactTestHarness";

let mounted: TestRender | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

function context(detectionId: string): CartItemVisionContext {
  return {
    scanEventId: "scan_1",
    detectionId,
    correctionId: `corr_${detectionId}`,
    objectId: detectionId.replace("det_", "obj_"),
    candidateSource: "ai_candidate",
    provider: "google_vision_ocr",
    providerConfidence: 0.9,
  };
}

function Harness() {
  const cart = useCart();
  const item = cart.items[0];
  return (
    <div>
      <button
        type="button"
        onClick={() => cart.addItem({
          variantId: "var_velo",
          productId: "prod_velo",
          productName: "VELO",
          sku: "VELO",
          quantity: 1,
          unitPrice: 100000,
          stockLevel: 10,
          visionContexts: [context("det_1")],
        })}
      >
        Add first
      </button>
      <button
        type="button"
        onClick={() => cart.addItem({
          variantId: "var_velo",
          productId: "prod_velo",
          productName: "VELO",
          sku: "VELO",
          quantity: 1,
          unitPrice: 100000,
          stockLevel: 10,
          visionContexts: [context("det_2")],
        })}
      >
        Add second
      </button>
      <button type="button" onClick={() => cart.updateQty("var_velo", 1)}>Qty one</button>
      <output data-testid="quantity">{item?.quantity || 0}</output>
      <output data-testid="contexts">{item?.visionContexts?.map((entry) => entry.detectionId).join(",") || ""}</output>
    </div>
  );
}

describe("useCart vision contexts", () => {
  it("preserves one vision context per detected object when the same variant is merged", () => {
    mounted = renderTestUi(<Harness />);

    click(buttonByText(mounted.container, "Add first"));
    click(buttonByText(mounted.container, "Add second"));

    expect(mounted.container.querySelector("[data-testid=quantity]")?.textContent).toBe("2");
    expect(mounted.container.querySelector("[data-testid=contexts]")?.textContent).toBe("det_1,det_2");

    click(buttonByText(mounted.container, "Qty one"));

    expect(mounted.container.querySelector("[data-testid=quantity]")?.textContent).toBe("1");
    expect(mounted.container.querySelector("[data-testid=contexts]")?.textContent).toBe("det_1");
  });
});
