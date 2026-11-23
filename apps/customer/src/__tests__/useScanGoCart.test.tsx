// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderTestUi, click, installMemoryStorage } from "../test/reactTestHarness";
import { useScanGoCart, buildCreateInput, __resetCartStoresForTests, type CartState } from "../scan-go/useScanGoCart";
import { AGE_ACK_STORAGE_KEY, CART_TTL_MS, cartStorageKey } from "../scan-go/config";
import type { ProductPublicDto } from "../scan-go/types";

const PRODUCT: ProductPublicDto = {
  merchantSlug: "tm",
  storeSlug: "ts",
  qrSlug: "sample-berry",
  productId: "prod_1",
  variantId: "variant_1",
  brand: "SAMPLE",
  name: "Berry Sample",
  flavor: "Berry Sample",
  formatTags: ["COOLING", "SLIM"],
  strengthLabel: "6mg/pouch",
  priceVnd: 250000,
  imageUrl: null,
  approvedStory: "",
  availability: "available",
};

function Host({ m, s }: { m: string; s: string }) {
  const cart = useScanGoCart(m, s);
  return (
    <div>
      <span data-testid="qty">{cart.totalQuantity}</span>
      <span data-testid="total">{cart.totalVnd}</span>
      <span data-testid="age">{cart.ageAcknowledgedAt ?? "none"}</span>
      <span data-testid="nick">{cart.customerNickname}</span>
      <button data-testid="add" onClick={() => cart.addLine(PRODUCT)}>
        add
      </button>
      <button data-testid="inc" onClick={() => cart.increment(PRODUCT.variantId)}>
        inc
      </button>
      <button data-testid="dec" onClick={() => cart.decrement(PRODUCT.variantId)}>
        dec
      </button>
      <button data-testid="rm" onClick={() => cart.removeLine(PRODUCT.variantId)}>
        rm
      </button>
      <button data-testid="nickSet" onClick={() => cart.setNickname("Tommy")}>
        nickSet
      </button>
      <ul>
        {cart.lines.map((l) => (
          <li key={l.variantId} data-testid="line">
            {l.quantity}
          </li>
        ))}
      </ul>
    </div>
  );
}

function text(container: HTMLElement, id: string): string {
  return (container.querySelector(`[data-testid="${id}"]`) as HTMLElement).textContent ?? "";
}

describe("useScanGoCart", () => {
  beforeEach(() => {
    installMemoryStorage();
    __resetCartStoresForTests();
  });

  afterEach(() => {
    __resetCartStoresForTests();
  });

  it("adds a line and increments quantity on repeat add", () => {
    const mounted = renderTestUi(<Host m="tm" s="ts" />);
    click(mounted.container.querySelector('[data-testid="add"]') as HTMLButtonElement);
    expect(text(mounted.container, "qty")).toBe("1");
    expect(text(mounted.container, "total")).toBe("250000");
    click(mounted.container.querySelector('[data-testid="add"]') as HTMLButtonElement);
    expect(text(mounted.container, "qty")).toBe("2");
    expect(text(mounted.container, "total")).toBe("500000");
    mounted.unmount();
  });

  it("increments, decrements, and removes", () => {
    const mounted = renderTestUi(<Host m="tm" s="ts" />);
    const c = mounted.container;
    click(c.querySelector('[data-testid="add"]') as HTMLButtonElement);
    click(c.querySelector('[data-testid="inc"]') as HTMLButtonElement);
    expect(text(c, "qty")).toBe("2");
    click(c.querySelector('[data-testid="dec"]') as HTMLButtonElement);
    expect(text(c, "qty")).toBe("1");
    click(c.querySelector('[data-testid="rm"]') as HTMLButtonElement);
    expect(text(c, "qty")).toBe("0");
    expect(c.querySelectorAll('[data-testid="line"]')).toHaveLength(0);
    mounted.unmount();
  });

  it("decrement to zero removes the line (no negative quantity)", () => {
    const mounted = renderTestUi(<Host m="tm" s="ts" />);
    const c = mounted.container;
    click(c.querySelector('[data-testid="add"]') as HTMLButtonElement);
    click(c.querySelector('[data-testid="dec"]') as HTMLButtonElement);
    expect(text(c, "qty")).toBe("0");
    expect(c.querySelectorAll('[data-testid="line"]')).toHaveLength(0);
    mounted.unmount();
  });

  it("persists across a simulated reload within the same session", () => {
    const c1 = renderTestUi(<Host m="tm" s="ts" />);
    click(c1.container.querySelector('[data-testid="add"]') as HTMLButtonElement);
    expect(text(c1.container, "qty")).toBe("1");
    c1.unmount();

    const raw = window.sessionStorage.getItem(cartStorageKey("tm", "ts"));
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).lines).toHaveLength(1);

    // ...and a fresh mount (module cache cleared) reloads it.
    __resetCartStoresForTests();
    const c2 = renderTestUi(<Host m="tm" s="ts" />);
    expect(text(c2.container, "qty")).toBe("1");
    c2.unmount();
  });

  it("switches to the correct store cart when route params change", () => {
    const mounted = renderTestUi(<Host m="tm" s="ts" />);
    click(mounted.container.querySelector('[data-testid="add"]') as HTMLButtonElement);
    expect(text(mounted.container, "qty")).toBe("1");

    mounted.rerender(<Host m="other" s="main" />);
    expect(text(mounted.container, "qty")).toBe("0");

    mounted.rerender(<Host m="tm" s="ts" />);
    expect(text(mounted.container, "qty")).toBe("1");
    mounted.unmount();
  });

  it("drops expired session carts on reload", () => {
    window.sessionStorage.setItem(cartStorageKey("tm", "ts"), JSON.stringify({
      cartId: "sgc_old",
      editSecret: "sge_old",
      merchantSlug: "tm",
      storeSlug: "ts",
      lines: [{ ...PRODUCT, sku: "ICE", title: "SAMPLE Berry", quantity: 1, unitPriceVnd: 250000 }],
      customerNickname: "Tommy",
      customerContact: "+84",
      contactType: "phone",
      ageAcknowledgedAt: "2026-06-25T00:00:00.000Z",
      updatedAt: Date.now() - CART_TTL_MS - 1,
    }));
    __resetCartStoresForTests();

    const mounted = renderTestUi(<Host m="tm" s="ts" />);
    expect(text(mounted.container, "qty")).toBe("0");
    expect(window.sessionStorage.getItem(cartStorageKey("tm", "ts"))).toBeNull();
    mounted.unmount();
  });

  it("captures the age acknowledgement when adding", () => {
    window.sessionStorage.setItem(`${AGE_ACK_STORAGE_KEY}:tm:ts`, new Date().toISOString());
    const mounted = renderTestUi(<Host m="tm" s="ts" />);
    click(mounted.container.querySelector('[data-testid="add"]') as HTMLButtonElement);
    expect(text(mounted.container, "age")).not.toBe("none");
    mounted.unmount();
  });

  it("nickname/contact are optional — empty maps to null in the create input", () => {
    const state: CartState = {
      cartId: null,
      editSecret: null,
      merchantSlug: "tm",
      storeSlug: "ts",
      lines: [],
      customerNickname: "",
      customerContact: "",
      contactType: "whatsapp",
      ageAcknowledgedAt: "2026-06-25T00:00:00.000Z",
      updatedAt: 0,
    };
    const empty = buildCreateInput(state);
    expect(empty.customerNickname).toBeNull();
    expect(empty.customerContact).toBeNull();
    expect(empty.contactType).toBeNull();
  });
});
