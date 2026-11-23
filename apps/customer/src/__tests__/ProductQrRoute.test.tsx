// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { renderTestUi, buttonByText, click, wait, installMemoryStorage } from "../test/reactTestHarness";
import { ProductQrRoute } from "../routes/ProductQrRoute";
import { __resetCartStoresForTests } from "../scan-go/useScanGoCart";

function renderAt(path: string) {
  return renderTestUi(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/s/:merchantSlug/:storeSlug/p/:qrSlug" element={<ProductQrRoute />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ProductQrRoute — age gate + scan-another loop", () => {
  beforeEach(() => {
    installMemoryStorage();
    __resetCartStoresForTests();
  });

  afterEach(() => {
    __resetCartStoresForTests();
  });

  it("hides product detail behind the age gate until acknowledged", () => {
    const mounted = renderAt("/s/tm/ts/p/sample-berry");
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("Adults only");
    expect(text).not.toContain("Berry Sample");
    expect(text).not.toContain("Add to my Stash");
    mounted.unmount();
  });

  it("reveals the product after ack, adds to stash, and keeps the cart across scanning another tag", async () => {
    const mounted = renderAt("/s/tm/ts/p/sample-berry");

    // Acknowledge the age gate.
    await act(async () => {
      click(buttonByText(mounted.container, "I am 18+"));
    });
    await wait(280);

    // Product detail is now visible; no USD anywhere.
    let text = mounted.container.textContent ?? "";
    expect(text).toContain("Berry Sample");
    expect(text).toContain("Add to my Stash");
    expect(text).not.toContain("USD");
    expect(text).not.toContain("$");

    // Add to stash.
    await act(async () => {
      click(buttonByText(mounted.container, "Add to my Stash"));
    });
    await wait(450);

    // Stash indicator reflects one item.
    expect(
      mounted.container.querySelector('[aria-label^="View your stash: 1 item"]'),
    ).not.toBeNull();

    // Scan another tag (demo) — cart must survive the navigation.
    await act(async () => {
      click(buttonByText(mounted.container, "Mint Sample"));
    });
    await wait(300);

    text = mounted.container.textContent ?? "";
    expect(text).toContain("Mint Sample");
    // Cart preserved across product QR navigation.
    expect(
      mounted.container.querySelector('[aria-label^="View your stash: 1 item"]'),
    ).not.toBeNull();

    mounted.unmount();
  }, 15000);
});
