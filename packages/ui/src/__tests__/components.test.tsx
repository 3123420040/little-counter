import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import React from "react";
import {
  StatusPill, Panel, MetricCell, EmptyState, OperationalTable,
  Button, SearchBox, Badge,
  TableSkeleton, PageHeader, InlineError, ConfirmDialog,
  Drawer, FilterBar, MutationBanner, ResponsiveMetricGrid, ScreenState,
} from "../index.js";

describe("StatusPill", () => {
  const mk = (props: Record<string, unknown>) => renderToString(React.createElement(StatusPill, props));

  it("renders with label", () => { expect(mk({ label: "Active" })).toContain("Active"); });
  it("defaults to neutral tone classes", () => {
    const h = mk({ label: "X" });
    expect(h).toContain("text-text-secondary");
    expect(h).toContain("border-border-default");
  });
  it("renders success tone", () => {
    const h = mk({ label: "OK", tone: "success" });
    expect(h).toContain("text-status-success");
  });
  it("renders warning tone", () => {
    const h = mk({ label: "Warn", tone: "warning" });
    expect(h).toContain("text-status-warning");
  });
  it("renders danger tone", () => {
    const h = mk({ label: "Err", tone: "danger" });
    expect(h).toContain("text-status-danger");
  });
  it("renders info tone", () => {
    const h = mk({ label: "Info", tone: "info" });
    expect(h).toContain("text-status-info");
  });
  it("renders icon when provided", () => {
    const icon = React.createElement("svg", { "data-testid": "icon" });
    expect(renderToString(React.createElement(StatusPill, { label: "X", icon }))).toContain("<svg");
  });
});

describe("Badge", () => {
  it("maps risk low to success Thấp", () => {
    const h = renderToString(React.createElement(Badge, { variant: "risk", value: "low" }));
    expect(h).toContain("Thấp"); expect(h).toContain("text-status-success");
  });
  it("maps risk high to danger Cao", () => {
    const h = renderToString(React.createElement(Badge, { variant: "risk", value: "high" }));
    expect(h).toContain("Cao"); expect(h).toContain("text-status-danger");
  });
  it("maps stock available to success Còn hàng", () => {
    const h = renderToString(React.createElement(Badge, { variant: "stock", value: "available" }));
    expect(h).toContain("Còn hàng");
  });
  it("maps stock out_of_stock to danger Hết hàng", () => {
    const h = renderToString(React.createElement(Badge, { variant: "stock", value: "out_of_stock" }));
    expect(h).toContain("Hết hàng"); expect(h).toContain("text-status-danger");
  });
  it("maps tier with Vietnamese labels", () => {
    expect(renderToString(React.createElement(Badge, { variant: "tier", value: "bronze" }))).toContain("Đồng");
    expect(renderToString(React.createElement(Badge, { variant: "tier", value: "silver" }))).toContain("Bạc");
    expect(renderToString(React.createElement(Badge, { variant: "tier", value: "gold" }))).toContain("Vàng");
    expect(renderToString(React.createElement(Badge, { variant: "tier", value: "platinum" }))).toContain("Bạch kim");
  });
  it("falls back to raw value for unknown variant", () => {
    expect(renderToString(React.createElement(Badge, { variant: "stock", value: "unknown" }))).toContain("unknown");
  });
});

describe("Button", () => {
  it("renders default secondary", () => {
    const h = renderToString(React.createElement(Button, { children: "OK" }));
    expect(h).toContain("OK"); expect(h).toContain("border-border-default");
  });
  it("renders primary variant", () => {
    expect(renderToString(React.createElement(Button, { variant: "primary", children: "Go" }))).toContain("bg-action-primary");
  });
  it("renders danger variant", () => {
    expect(renderToString(React.createElement(Button, { variant: "danger", children: "Del" }))).toContain("text-status-danger");
  });
  it("renders ghost variant", () => {
    expect(renderToString(React.createElement(Button, { variant: "ghost", children: "X" }))).toContain("border-transparent");
  });
  it("renders all sizes", () => {
    expect(renderToString(React.createElement(Button, { size: "sm", children: "S" }))).toContain("h-[var(--button-height-sm)]");
    expect(renderToString(React.createElement(Button, { size: "lg", children: "L" }))).toContain("h-[var(--button-height-lg)]");
  });
  it("renders icon-only button", () => {
    const h = renderToString(React.createElement(Button, { icon: React.createElement("span", null, "+") }));
    expect(h).toContain("w-[var(--button-height-md)]");
  });
  it("passes through HTML attributes", () => {
    const h = renderToString(React.createElement(Button, { disabled: true, type: "submit", children: "Sub" }));
    expect(h).toContain("disabled"); expect(h).toContain('type="submit"');
  });
});

describe("SearchBox", () => {
  it("renders with default placeholder", () => {
    const h = renderToString(React.createElement(SearchBox, {}));
    expect(h).toContain("Tìm kiếm..."); expect(h).toContain('type="search"');
  });
  it("accepts custom placeholder", () => {
    expect(renderToString(React.createElement(SearchBox, { placeholder: "Tìm SP..." }))).toContain("Tìm SP...");
  });
});

describe("Panel", () => {
  it("renders title + children + aria", () => {
    const h = renderToString(React.createElement(Panel, { title: "Test", children: React.createElement("p", null, "Body") }));
    expect(h).toContain("Test"); expect(h).toContain("Body"); expect(h).toContain('aria-label="Test"');
  });
  it("renders action element", () => {
    const h = renderToString(React.createElement(Panel, { title: "P", action: React.createElement("button", null, "Add"), children: React.createElement("span", null, "x") }));
    expect(h).toContain("Add");
  });
});

describe("MetricCell", () => {
  it("renders label + value", () => {
    const h = renderToString(React.createElement(MetricCell, { label: "DT", value: "12M" }));
    expect(h).toContain("DT"); expect(h).toContain("12M");
  });
  it("renders delta", () => {
    const h = renderToString(React.createElement(MetricCell, { label: "R", value: "100", delta: "+15%" }));
    expect(h).toContain("+15%");
  });
  it("renders tone", () => {
    expect(renderToString(React.createElement(MetricCell, { label: "X", value: "1", tone: "success" }))).toContain("border-t-status-success");
  });
  it("uses top-border accent not left-border", () => {
    const h = renderToString(React.createElement(MetricCell, { label: "X", value: "1", tone: "danger" }));
    expect(h).toContain("border-t-[3px]");
    expect(h).not.toContain("border-left");
  });
});

describe("EmptyState", () => {
  it("renders title + body", () => {
    const h = renderToString(React.createElement(EmptyState, { title: "Empty", body: "Nothing" }));
    expect(h).toContain("Empty"); expect(h).toContain("Nothing");
  });
  it("renders icon", () => {
    const h = renderToString(React.createElement(EmptyState, { title: "E", body: "N", icon: React.createElement("svg", null) }));
    expect(h).toContain("<svg");
  });
  it("renders action", () => {
    const h = renderToString(React.createElement(EmptyState, { title: "E", body: "N", action: React.createElement("button", null, "Go") }));
    expect(h).toContain("Go");
  });
});

describe("OperationalTable", () => {
  const cols = ["Mã", "Tên"];
  const rows = [["001", "Product A"], ["002", "Product B"]];
  it("renders headers + data", () => {
    const h = renderToString(React.createElement(OperationalTable, { columns: cols, rows }));
    expect(h).toContain("Mã"); expect(h).toContain("Product A"); expect(h).toContain("snus-table");
  });
  it("renders ReactNode cells", () => {
    const pill = React.createElement(StatusPill, { label: "OK", tone: "success" });
    const h = renderToString(React.createElement(OperationalTable, { columns: cols, rows: [["001", pill]] }));
    expect(h).toContain("OK"); expect(h).toContain("text-status-success");
  });
  it("shows empty state when no rows", () => {
    const h = renderToString(React.createElement(OperationalTable, { columns: cols, rows: [], emptyTitle: "Trống", emptyBody: "Ko có gì" }));
    expect(h).toContain("Trống"); expect(h).not.toContain("snus-table");
  });
  it("renders clickable rows", () => {
    const h = renderToString(React.createElement(OperationalTable, { columns: cols, rows, onRowClick: () => {} }));
    expect(h).toContain('data-clickable="true"');
    expect(h).toContain('role="button"');
    expect(h).toContain('tabindex="0"');
  });
  it("renders selected row and alignment metadata", () => {
    const h = renderToString(React.createElement(OperationalTable, {
      columns: [{ key: "id", label: "Mã" }, { key: "total", label: "Tổng", align: "right", width: 120 }],
      rows: [{ id: "001", total: "100" }],
      selectedRowIndex: 0,
    }));
    expect(h).toContain('data-selected="true"');
    expect(h).toContain('aria-selected="true"');
    expect(h).toContain("text-align:right");
  });
  it("marks left and right identity/action columns sticky on headers and cells", () => {
    const h = renderToString(React.createElement(OperationalTable, {
      columns: [
        { key: "sku", label: "SKU", sticky: "left" },
        { key: "action", label: "", sticky: "right" },
      ],
      rows: [{ sku: "SKU-31", action: React.createElement("button", null, "Nhận dòng") }],
    }));
    expect(h.match(/snus-table-sticky-left/g)).toHaveLength(2);
    expect(h.match(/snus-table-sticky-right/g)).toHaveLength(2);
  });
});

describe("New Components", () => {
  it("TableSkeleton renders rows + cols", () => {
    const h = renderToString(React.createElement(TableSkeleton, { rows: 3, cols: 2 }));
    expect(h).toContain('aria-busy="true"');
  });

  it("PageHeader renders title + actions", () => {
    const h = renderToString(React.createElement(PageHeader, {
      title: "Test",
      subtitle: "Sub",
      status: React.createElement("span", null, "Online"),
      actions: React.createElement("button", null, "Go"),
    }));
    expect(h).toContain("Test"); expect(h).toContain("Sub");
    expect(h).toContain("Online"); expect(h).toContain("Go");
  });

  it("InlineError renders message + retry", () => {
    const h = renderToString(React.createElement(InlineError, {
      message: "Lỗi rồi",
      onRetry: () => {},
      stale: true,
    }));
    expect(h).toContain("Lỗi rồi");
    expect(h).toContain('role="alert"');
    expect(h).toContain("Dữ liệu hiển thị có thể cũ");
  });

  it("InlineError without retry hides button", () => {
    const h = renderToString(React.createElement(InlineError, { message: "Err" }));
    expect(h).not.toContain("Thử lại");
  });

  it("ConfirmDialog renders when open", () => {
    const h = renderToString(React.createElement(ConfirmDialog, {
      open: true,
      title: "Xác nhận?",
      message: "Không thể hoàn tác.",
      confirmLabel: "Đồng ý",
      danger: true,
      onConfirm: () => {},
      onCancel: () => {},
    }));
    expect(h).toContain("Xác nhận?"); expect(h).toContain("Không thể hoàn tác");
    expect(h).toContain("Đồng ý"); expect(h).toContain("text-status-danger");
    expect(h).toContain('role="dialog"');
    expect(h).toContain('aria-modal="true"');
  });

  it("ConfirmDialog returns null when closed", () => {
    const h = renderToString(React.createElement(ConfirmDialog, {
      open: false, title: "X", message: "Y", confirmLabel: "Z",
      onConfirm: () => {}, onCancel: () => {},
    }));
    expect(h).toBe("");
  });

  it("ConfirmDialog renders custom content and pending label", () => {
    const h = renderToString(React.createElement(ConfirmDialog, {
      open: true,
      title: "Receive",
      confirmLabel: "OK",
      pending: true,
      onConfirm: () => {},
      onCancel: () => {},
      children: React.createElement("input", { value: "2", readOnly: true }),
    }));
    expect(h).toContain("Receive");
    expect(h).toContain("Đang xử lý");
    expect(h).toContain("<input");
  });

  it("Drawer renders accessible panel when open", () => {
    const h = renderToString(React.createElement(Drawer, {
      open: true,
      title: "Drawer",
      onClose: () => {},
      children: React.createElement("p", null, "Body"),
    }));
    expect(h).toContain('role="dialog"');
    expect(h).toContain('aria-modal="true"');
    expect(h).toContain("Body");
  });

  it("FilterBar, MutationBanner, ResponsiveMetricGrid and ScreenState render", () => {
    expect(renderToString(React.createElement(FilterBar, {
      children: React.createElement("input", { value: "x", readOnly: true }),
      actions: React.createElement("button", null, "Clear"),
    }))).toContain("Clear");
    expect(renderToString(React.createElement(MutationBanner, {
      tone: "success",
      message: "Done",
    }))).toContain('role="status"');
    expect(renderToString(React.createElement(ResponsiveMetricGrid, {
      children: React.createElement("div", null, "Metric"),
    }))).toContain("md:grid-cols-4");
    expect(renderToString(React.createElement(ScreenState, {
      state: "empty",
      title: "Empty",
    }))).toContain("Empty");
  });
});
