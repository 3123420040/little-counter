// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { click, renderTestUi, type TestRender } from "../test/reactTestHarness";
import { ProductCard } from "./ProductCard";

vi.mock("lucide-react", async () => {
  const React = await import("react");
  const icon = (name: string) => (props: Record<string, unknown>) => React.createElement("span", { "data-icon": name, ...props });
  return {
    Info: icon("info"),
    X: icon("close"),
    Package: icon("package"),
    ImageOff: icon("image-off"),
  };
});

let mounted: TestRender | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const baseProps = {
  id: "prod_1",
  price: 240000,
  stockLevel: 10,
  variantId: "var_1",
  sku: "SKU-001",
  onSelect: vi.fn(),
};

describe("ProductCard", () => {
  it("renders product image when imageUrl is provided", () => {
    mounted = renderTestUi(
      <ProductCard {...baseProps} title="Mint Pouch" imageUrl="https://example.com/img.jpg" />,
    );
    const img = mounted.container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("https://example.com/img.jpg");
    expect(img?.getAttribute("alt")).toBe("Mint Pouch");
  });

  it("shows fallback when no imageUrl is provided", () => {
    mounted = renderTestUi(
      <ProductCard {...baseProps} title="Mint Pouch" />,
    );
    const img = mounted.container.querySelector("img");
    expect(img).toBeNull();
    expect(mounted.container.textContent).toContain("Chưa có ảnh");
  });

  it("shows broken-image fallback when image fails to load", () => {
    mounted = renderTestUi(
      <ProductCard {...baseProps} title="Mint Pouch" imageUrl="https://example.com/broken.jpg" />,
    );
    const img = mounted.container.querySelector("img");
    expect(img).not.toBeNull();
    act(() => {
      img?.dispatchEvent(new Event("error"));
    });
    expect(mounted.container.textContent).toContain("Ảnh lỗi");
    expect(mounted.container.textContent).not.toContain("Chưa có ảnh");
    expect(mounted.container.querySelectorAll('[data-icon="image-off"]')).toHaveLength(1);
  });

  it("retries rendering when imageUrl changes after a load failure", () => {
    mounted = renderTestUi(
      <ProductCard {...baseProps} title="Mint Pouch" imageUrl="https://example.com/broken.jpg" />,
    );
    act(() => {
      mounted?.container.querySelector("img")?.dispatchEvent(new Event("error"));
    });

    mounted.rerender(
      <ProductCard {...baseProps} title="Mint Pouch" imageUrl="https://example.com/fixed.jpg" />,
    );

    expect(mounted.container.querySelector("img")?.getAttribute("src")).toBe("https://example.com/fixed.jpg");
    expect(mounted.container.textContent).not.toContain("Ảnh lỗi");
  });

  it("renders long product name with title attribute for full access", () => {
    const longName = "Snus Nicotine Pouch Mint Medium Strength 20-Pack Premium Quality Imported From Sweden";
    mounted = renderTestUi(
      <ProductCard {...baseProps} title={longName} imageUrl="https://example.com/img.jpg" />,
    );
    const infoButton = mounted.container.querySelector('button[aria-label^="Xem tên đầy đủ"]') as HTMLButtonElement;
    expect(infoButton).not.toBeNull();
    click(infoButton);
    const dialog = mounted.container.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain(longName);
  });

  it("calls onSelect with variantId when card is clicked", () => {
    const onSelect = vi.fn();
    mounted = renderTestUi(
      <ProductCard {...baseProps} title="Mint Pouch" onSelect={onSelect} />,
    );
    const mainButton = mounted.container.querySelector("button[aria-label]") as HTMLButtonElement;
    mainButton.click();
    expect(onSelect).toHaveBeenCalledWith("var_1");
  });
});
