// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buttonByText, renderTestUi, type TestRender } from "../test/reactTestHarness";

const downloads = vi.hoisted(() => ({ downloadCsvResource: vi.fn() }));

vi.mock("../api/endpoints", () => downloads);
vi.mock("@medusa-snus/ui", async () => {
  const React = await import("react");
  return {
    Button: ({ children, icon: _icon, variant, size, ...props }: Record<string, unknown>) =>
      React.createElement(
        "button",
        { ...props, "data-variant": variant, "data-size": size },
        children as React.ReactNode,
      ),
  };
});

import { ExportTemplateActions } from "./ExportTemplateActions";

let mounted: TestRender | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.clearAllMocks();
});

describe("ExportTemplateActions", () => {
  it.each(["products", "categories", "inventory", "purchaseOrders"] as const)(
    "downloads the %s export and template through the shared endpoint client",
    async (resource) => {
      downloads.downloadCsvResource.mockResolvedValue(undefined);
      mounted = renderTestUi(<ExportTemplateActions resource={resource} />);

      await act(async () => {
        buttonByText(mounted!.container, "Xuất CSV").click();
        await Promise.resolve();
      });
      await act(async () => {
        buttonByText(mounted!.container, "Tải mẫu CSV").click();
        await Promise.resolve();
      });

      expect(downloads.downloadCsvResource).toHaveBeenNthCalledWith(1, resource, "export");
      expect(downloads.downloadCsvResource).toHaveBeenNthCalledWith(2, resource, "template");
      expect(buttonByText(mounted!.container, "Xuất CSV").dataset.size).toBe("md");
      expect(buttonByText(mounted!.container, "Tải mẫu CSV").dataset.size).toBe("md");
      expect(buttonByText(mounted!.container, "Xuất CSV").dataset.variant).toBe("secondary");
    },
  );
});
