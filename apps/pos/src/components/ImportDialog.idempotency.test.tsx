// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buttonByText, renderTestUi, type TestRender } from "../test/reactTestHarness";

const imports = vi.hoisted(() => ({ previewImport: vi.fn(), applyImport: vi.fn() }));
vi.mock("../api/endpoints", () => imports);
vi.mock("@medusa-snus/ui", async () => {
  const actual = await vi.importActual<typeof import("@medusa-snus/ui")>("@medusa-snus/ui");
  const React = await import("react");
  return {
    PaginatedListFrame: actual.PaginatedListFrame,
    Button: ({ children, ...props }: Record<string, unknown>) => React.createElement("button", props, children as React.ReactNode),
    InlineError: ({ message }: { message: string }) => React.createElement("div", { role: "alert" }, message),
    ListPagination: ({ label }: { label: string }) => React.createElement("div", null, label),
    localListPaginationMeta: (total: number, page: number, pageSize: number) => ({ total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)), totalKind: "exact", hasPrevious: page > 1, hasNext: page * pageSize < total }),
    OperationalTable: () => React.createElement("div", { "data-testid": "operational-table" }),
    StatusPill: ({ label }: { label: string }) => React.createElement("span", null, label),
  };
});

import { ImportDialog } from "./ImportDialog";

let mounted: TestRender | null = null;
afterEach(() => { mounted?.unmount(); mounted = null; vi.clearAllMocks(); });

async function waitFor(assertion: () => void) {
  const deadline = Date.now() + 1000;
  let last: unknown;
  while (Date.now() < deadline) {
    try { assertion(); return; } catch (error) { last = error; }
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
  throw last;
}

async function chooseCsv(input: HTMLInputElement, csv: string) {
  const file = new File([csv], "products.csv", { type: "text/csv" });
  Object.defineProperty(file, "text", { value: vi.fn().mockResolvedValue(csv), configurable: true });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve(); });
}

describe("ImportDialog idempotency contract", () => {
  it("reuses the preview identity after an ambiguous apply failure", async () => {
    const csv = "action,productId,title\r\ncreate,,Retry-safe product\r\n";
    imports.previewImport.mockResolvedValue({ data: {
      importId: "imp_preview_123",
      valid: true,
      summary: { totalRows: 1, validRows: 1, warningRows: 0, errorRows: 0 },
      rows: [{ rowNumber: 2, action: "create", status: "valid", errors: [], warnings: [], normalized: {} }],
    } });
    imports.applyImport
      .mockRejectedValueOnce(new Error("Response lost after commit"))
      .mockResolvedValueOnce({ data: {
        importId: "imp_apply_123", appliedRows: 1, skippedRows: 0, errorRows: 0,
        rows: [{ rowNumber: 2, action: "create", status: "applied", entityId: "prod_1", errors: [] }],
      } });

    mounted = renderTestUi(<ImportDialog open resource="products" onClose={vi.fn()} onSuccess={vi.fn()} />);
    await chooseCsv(mounted.container.querySelector("input[type=file]") as HTMLInputElement, csv);
    await waitFor(() => expect(buttonByText(mounted!.container, "Thực hiện Import").disabled).toBe(false));

    buttonByText(mounted.container, "Thực hiện Import").click();
    await waitFor(() => expect(mounted!.container.querySelector('[role="alert"]')?.textContent).toContain("Response lost"));
    buttonByText(mounted.container, "Thực hiện Import").click();
    await waitFor(() => expect(mounted!.container.textContent).toContain("Import hoàn tất"));

    expect(imports.applyImport).toHaveBeenNthCalledWith(1, "products", csv, "imp_preview_123");
    expect(imports.applyImport).toHaveBeenNthCalledWith(2, "products", csv, "imp_preview_123");
  });
});
