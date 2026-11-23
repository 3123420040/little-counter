// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { changeValue, renderTestUi, type TestRender } from "../test/reactTestHarness";
import { ProductImageField, validateProductImageUrl } from "./ProductImageField";

vi.mock("lucide-react", async () => {
  const React = await import("react");
  const icon = (name: string) => (props: Record<string, unknown>) => React.createElement("span", { "data-icon": name, ...props });
  return { ImageOff: icon("image-off"), Package: icon("package") };
});

let mounted: TestRender | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("ProductImageField", () => {
  it("accepts blank or HTTPS URLs and rejects malformed or non-HTTPS values", () => {
    expect(validateProductImageUrl("")).toBeNull();
    expect(validateProductImageUrl("https://example.com/product.jpg")).toBeNull();
    expect(validateProductImageUrl("not-a-url")).toContain("hợp lệ");
    expect(validateProductImageUrl("http://example.com/product.jpg")).toContain("HTTPS");
  });

  it("shows deterministic blank, invalid, broken, and valid preview states", () => {
    const onChange = vi.fn();
    mounted = renderTestUi(<ProductImageField value="" onChange={onChange} />);
    expect(mounted.container.textContent).toContain("Chưa có ảnh");

    mounted.rerender(<ProductImageField value="not-a-url" onChange={onChange} />);
    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toContain("hợp lệ");
    expect(mounted.container.querySelector("img")).toBeNull();

    mounted.rerender(<ProductImageField value="https://example.com/broken.jpg" onChange={onChange} />);
    act(() => mounted?.container.querySelector("img")?.dispatchEvent(new Event("error")));
    expect(mounted.container.textContent).toContain("Không tải được ảnh");
    expect(mounted.container.querySelector("img")).toBeNull();

    mounted.rerender(<ProductImageField value="https://example.com/fixed.jpg" onChange={onChange} />);
    expect(mounted.container.querySelector("img")?.getAttribute("src")).toBe("https://example.com/fixed.jpg");
    expect(mounted.container.textContent).not.toContain("Không tải được ảnh");
  });

  it("reports input changes", () => {
    const onChange = vi.fn();
    mounted = renderTestUi(<ProductImageField value="" onChange={onChange} />);
    changeValue(mounted.container.querySelector("input") as HTMLInputElement, "https://example.com/new.jpg");
    expect(onChange).toHaveBeenCalledWith("https://example.com/new.jpg");
  });
});
