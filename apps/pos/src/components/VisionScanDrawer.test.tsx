// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { buttonByText, click, renderTestUi, type TestRender } from "../test/reactTestHarness";

vi.mock("@medusa-snus/ui", async () => {
  const React = await import("react");
  return {
    Button: ({ children, icon, variant: _variant, size: _size, ...props }: Record<string, unknown>) => React.createElement("button", props, icon as any, children as any),
    Drawer: ({ open, title, subtitle, children, actions }: Record<string, unknown>) => open
      ? React.createElement("section", null,
        React.createElement("h2", null, title as any),
        subtitle ? React.createElement("p", null, subtitle as any) : null,
        React.createElement("div", null, children as any),
        React.createElement("footer", null, actions as any),
      )
      : null,
    InlineError: ({ message }: { message: string }) => React.createElement("div", { role: "alert" }, message),
  };
});

vi.mock("lucide-react", async () => {
  const React = await import("react");
  const icon = (name: string) => (props: Record<string, unknown>) => React.createElement("span", { "data-icon": name, ...props });
  return {
    Camera: icon("camera"),
    CheckCircle2: icon("check-circle"),
    ImagePlus: icon("image-plus"),
    Loader2: icon("loader"),
    Package: icon("package"),
    Search: icon("search"),
    ShoppingCart: icon("shopping-cart"),
    Trash2: icon("trash"),
    Upload: icon("upload"),
    XCircle: icon("x-circle"),
  };
});

vi.mock("../api/endpoints", () => ({
  recordVisionScanCorrection: vi.fn(),
  scanVisionProducts: vi.fn(),
}));

import { recordVisionScanCorrection, scanVisionProducts } from "../api/endpoints";
import { VisionScanDrawer } from "./VisionScanDrawer";

let mounted: TestRender | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function chooseFiles(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForExpectation(assertion: () => void) {
  const deadline = Date.now() + 1000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }
  if (lastError) throw lastError;
  assertion();
}

describe("VisionScanDrawer capture controls", () => {
  it("uses direct camera capture, library multi-select, and resets selected images without closing the drawer", async () => {
    mounted = renderTestUi(
      <VisionScanDrawer
        open
        onClose={vi.fn()}
        onAcceptCandidate={vi.fn()}
        onManualFallback={vi.fn()}
      />,
    );

    const inputs = Array.from(mounted.container.querySelectorAll("input[type=file]")) as HTMLInputElement[];
    const cameraInput = inputs.find((input) => input.getAttribute("capture") === "environment");
    const libraryInput = inputs.find((input) => input.multiple);
    expect(cameraInput?.accept).toBe("image/*");
    expect(libraryInput?.accept).toBe("image/*");
    expect(buttonByText(mounted.container, "Scan ảnh").disabled).toBe(true);
    expect(mounted.container.textContent).toContain("Chưa chọn ảnh");

    await chooseFiles(cameraInput!, [new File(["fake-image"], "capture.jpg", { type: "image/jpeg" })]);

    await waitForExpectation(() => {
      expect(mounted?.container.querySelector("img")?.getAttribute("alt")).toBe("capture.jpg");
    });
    expect(mounted.container.textContent).toContain("Chụp ảnh");
    expect(mounted.container.textContent).toContain("Thư viện");
    expect(buttonByText(mounted.container, "Scan 1 ảnh").disabled).toBe(false);

    await chooseFiles(libraryInput!, [new File(["second"], "second.jpg", { type: "image/jpeg" })]);
    await waitForExpectation(() => {
      expect(mounted?.container.textContent).toContain("2/4 ảnh");
    });

    click(buttonByText(mounted.container, "Xóa tất cả"));
    expect(mounted.container.querySelector("img")).toBeNull();
    expect(mounted.container.textContent).toContain("Chưa chọn ảnh");
    expect(mounted.container.textContent).not.toContain("Xóa tất cả");
    expect(buttonByText(mounted.container, "Scan ảnh").disabled).toBe(true);
  });

  it("keeps the drawer open after adding a candidate and exposes a cart handoff", async () => {
    vi.mocked(scanVisionProducts).mockResolvedValueOnce({
      data: {
        scanId: "scan_1",
        mode: "single",
        status: "success",
        provider: "google_vision_ocr",
        modelVersion: "google_vision_ocr:text_detection:v1",
        requiresStaffConfirmation: true,
        detections: [{
          detectionId: "det_1",
          objectId: "obj_1",
          source: "vision_provider",
          detectionType: "candidate_match",
          resolvedVariantId: "var_velo",
          confidence: 0.91,
          requiresConfirmation: true,
          decision: "pending",
          warnings: [],
          candidates: [{
            productId: "prod_velo",
            variantId: "var_velo",
            title: "VELO Crispy Peppermint",
            sku: "VEL-CRISPY-PEPPERMINT",
            barcode: "",
            imageUrl: "",
            price: 180000,
            stock: 15,
            confidence: 0.91,
            source: "vision_provider",
            warnings: ["ocr_fuzzy_match"],
          }],
        }],
      },
    });
    vi.mocked(recordVisionScanCorrection).mockResolvedValueOnce({ data: { correctionId: "corr_1" } });
    const onClose = vi.fn();
    const onAcceptCandidate = vi.fn();
    const onViewCart = vi.fn();

    mounted = renderTestUi(
      <VisionScanDrawer
        open
        onClose={onClose}
        onAcceptCandidate={onAcceptCandidate}
        onViewCart={onViewCart}
      />,
    );

    const cameraInput = Array.from(mounted.container.querySelectorAll("input[type=file]"))
      .find((input) => input.getAttribute("capture") === "environment") as HTMLInputElement;
    await chooseFiles(cameraInput, [new File(["fake-image"], "capture.jpg", { type: "image/jpeg" })]);
    await waitForExpectation(() => {
      expect(buttonByText(mounted!.container, "Scan 1 ảnh").disabled).toBe(false);
    });
    click(buttonByText(mounted.container, "Scan 1 ảnh"));

    await waitForExpectation(() => {
      expect(mounted?.container.textContent).toContain("VEL-CRISPY-PEPPERMINT");
    });
    expect(scanVisionProducts).toHaveBeenCalledWith(expect.objectContaining({
      imageBase64List: [expect.stringContaining("data:image")],
    }));
    expect(mounted.container.textContent).not.toContain("ocr_fuzzy_match");

    click(buttonByText(mounted.container, "Thêm"));
    await waitForExpectation(() => {
      expect(onAcceptCandidate).toHaveBeenCalledWith(
        expect.objectContaining({ variantId: "var_velo" }),
        expect.objectContaining({
          scanEventId: "scan_1",
          detectionId: "det_1",
          correctionId: "corr_1",
          objectId: "obj_1",
          candidateSource: "ai_candidate",
          provider: "google_vision_ocr",
          providerCandidateRank: 1,
          providerConfidence: 0.91,
        }),
      );
      expect(mounted?.container.textContent).toContain("Đã thêm 1 sản phẩm vào giỏ.");
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(buttonByText(mounted.container, "Đã thêm").disabled).toBe(true);

    click(buttonByText(mounted.container, "Xem giỏ (1)"));
    expect(onViewCart).toHaveBeenCalledTimes(1);
  });
});
