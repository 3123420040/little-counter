import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import React from "react";
import {
  TableSkeleton, PageHeader, InlineError, ConfirmDialog,
} from "../index.js";

describe("TableSkeleton", () => {
  it("renders the requested number of rows and columns", () => {
    const h = renderToString(React.createElement(TableSkeleton, { rows: 4, cols: 3 }));
    // 4 rows × (3 columns + 1 wrapper) = should have 4 row divs
    const rowCount = (h.match(/animate-pulse/g) || []).length;
    expect(rowCount).toBe(12); // 4 rows × 3 cols
  });

  it("defaults to 6 rows and 4 columns", () => {
    const h = renderToString(React.createElement(TableSkeleton, {}));
    const pulseCount = (h.match(/animate-pulse/g) || []).length;
    expect(pulseCount).toBe(24); // 6 × 4
  });

  it("has aria-busy for screen readers", () => {
    const h = renderToString(React.createElement(TableSkeleton, { rows: 2, cols: 2 }));
    expect(h).toContain('aria-busy="true"');
  });

  it("renders rounded skeleton cells with pulse animation", () => {
    const h = renderToString(React.createElement(TableSkeleton, { rows: 1, cols: 1 }));
    expect(h).toContain("rounded");
    expect(h).toContain("animate-pulse");
  });

  it("applies staggered animation delay per row", () => {
    const h = renderToString(React.createElement(TableSkeleton, { rows: 3, cols: 1 }));
    expect(h).toContain("animation-delay"); // First row has no delay, but others do
  });
});

describe("PageHeader", () => {
  it("renders title as h1", () => {
    const h = renderToString(React.createElement(PageHeader, { title: "Tồn kho" }));
    expect(h).toContain("Tồn kho");
    expect(h).toContain("<h1");
  });

  it("renders action buttons when provided", () => {
    const h = renderToString(React.createElement(PageHeader, {
      title: "Test",
      actions: React.createElement("button", null, "Action"),
    }));
    expect(h).toContain("Action");
  });

  it("uses flex layout for header and actions", () => {
    const h = renderToString(React.createElement(PageHeader, {
      title: "Test",
      actions: React.createElement("button", null, "X"),
    }));
    expect(h).toContain("flex");
    expect(h).toContain("justify-between");
  });
});

describe("InlineError", () => {
  it("renders error message with alert role", () => {
    const h = renderToString(React.createElement(InlineError, {
      message: "Không thể tải sản phẩm",
    }));
    expect(h).toContain("Không thể tải sản phẩm");
    expect(h).toContain('role="alert"');
  });

  it("shows retry button when onRetry provided", () => {
    const h = renderToString(React.createElement(InlineError, {
      message: "Lỗi",
      onRetry: () => {},
    }));
    expect(h).toContain("Thử lại");
  });

  it("shows stale data note when stale=true", () => {
    const h = renderToString(React.createElement(InlineError, {
      message: "Lỗi",
      onRetry: () => {},
      stale: true,
    }));
    expect(h).toContain("Dữ liệu hiển thị có thể cũ");
  });

  it("does not show stale note by default", () => {
    const h = renderToString(React.createElement(InlineError, {
      message: "Lỗi",
    }));
    expect(h).not.toContain("Dữ liệu hiển thị có thể cũ");
  });

  it("uses warning colors for visual prominence", () => {
    const h = renderToString(React.createElement(InlineError, {
      message: "Lỗi",
    }));
    expect(h).toContain("border-status-warning-border");
    expect(h).toContain("bg-status-warning-bg");
  });

  it("uses AlertTriangle icon for error semantics", () => {
    const h = renderToString(React.createElement(InlineError, {
      message: "Lỗi",
    }));
    expect(h).toContain("<svg"); // AlertTriangle renders as SVG
  });
});

describe("ConfirmDialog", () => {
  it("renders when open=true", () => {
    const h = renderToString(React.createElement(ConfirmDialog, {
      open: true,
      title: "Xác nhận?",
      message: "Không thể hoàn tác.",
      confirmLabel: "Đồng ý",
      onConfirm: () => {},
      onCancel: () => {},
    }));
    expect(h).toContain("Xác nhận?");
    expect(h).toContain("Không thể hoàn tác.");
    expect(h).toContain("Đồng ý");
  });

  it("returns empty string when open=false", () => {
    const h = renderToString(React.createElement(ConfirmDialog, {
      open: false,
      title: "X",
      message: "Y",
      confirmLabel: "Z",
      onConfirm: () => {},
      onCancel: () => {},
    }));
    expect(h).toBe("");
  });

  it("uses danger variant for confirm button when danger=true", () => {
    const h = renderToString(React.createElement(ConfirmDialog, {
      open: true,
      title: "Xóa?",
      message: "Không thể hoàn tác.",
      confirmLabel: "Xóa",
      danger: true,
      onConfirm: () => {},
      onCancel: () => {},
    }));
    expect(h).toContain("text-status-danger");
  });

  it("always has a cancel button", () => {
    const h = renderToString(React.createElement(ConfirmDialog, {
      open: true,
      title: "T",
      message: "M",
      confirmLabel: "OK",
      onConfirm: () => {},
      onCancel: () => {},
    }));
    expect(h).toContain("Hủy");
  });

  it("uses modal z-index for overlay", () => {
    const h = renderToString(React.createElement(ConfirmDialog, {
      open: true,
      title: "T",
      message: "M",
      confirmLabel: "OK",
      onConfirm: () => {},
      onCancel: () => {},
    }));
    expect(h).toContain("var(--z-modal)");
  });

  it("animates in with scale-in for visual polish", () => {
    const h = renderToString(React.createElement(ConfirmDialog, {
      open: true,
      title: "T",
      message: "M",
      confirmLabel: "OK",
      onConfirm: () => {},
      onCancel: () => {},
    }));
    expect(h).toContain("animate-scale-in");
  });
});
