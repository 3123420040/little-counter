import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import React from "react";
import {
  MetricCell, StatusPill, Button, Panel, EmptyState, Badge,
  OperationalTable, AppShell, Sidebar,
} from "../index.js";
import { Store, ShoppingCart, Package } from "lucide-react";

describe("Anti-Pattern: No border-left in MetricCell", () => {
  it("uses border-top accent, not border-left", () => {
    const h = renderToString(React.createElement(MetricCell, {
      label: "Test",
      value: "100",
      tone: "success",
    }));
    expect(h).toContain("border-t-[3px]");
    expect(h).not.toContain("border-left");
  });

  it("applies correct tone to border-top", () => {
    const danger = renderToString(React.createElement(MetricCell, {
      label: "X", value: "1", tone: "danger",
    }));
    expect(danger).toContain("border-t-status-danger");

    const warning = renderToString(React.createElement(MetricCell, {
      label: "X", value: "1", tone: "warning",
    }));
    expect(warning).toContain("border-t-status-warning");

    const success = renderToString(React.createElement(MetricCell, {
      label: "X", value: "1", tone: "success",
    }));
    expect(success).toContain("border-t-status-success");
  });

  it("defaults to neutral border-top", () => {
    const h = renderToString(React.createElement(MetricCell, {
      label: "X", value: "1",
    }));
    expect(h).toContain("border-t-border-default");
  });
});

describe("Anti-Pattern: No emoji in tier labels", () => {
  const EMOJI_REGEX = /[\u{1F300}-\u{1F9FF}]/u;

  it("Badge tier: bronze renders as text, not emoji", () => {
    const h = renderToString(React.createElement(Badge, { variant: "tier", value: "bronze" }));
    expect(h).toContain("Đồng");
    expect(EMOJI_REGEX.test(h)).toBe(false);
  });

  it("Badge tier: silver renders as text, not emoji", () => {
    const h = renderToString(React.createElement(Badge, { variant: "tier", value: "silver" }));
    expect(h).toContain("Bạc");
    expect(EMOJI_REGEX.test(h)).toBe(false);
  });

  it("Badge tier: gold renders as text, not emoji", () => {
    const h = renderToString(React.createElement(Badge, { variant: "tier", value: "gold" }));
    expect(h).toContain("Vàng");
    expect(EMOJI_REGEX.test(h)).toBe(false);
  });

  it("Badge tier: platinum renders as text, not emoji", () => {
    const h = renderToString(React.createElement(Badge, { variant: "tier", value: "platinum" }));
    expect(h).toContain("Bạch kim");
    expect(EMOJI_REGEX.test(h)).toBe(false);
  });

  it("All Badge variants are emoji-free", () => {
    const variants = ["risk", "eligibility", "stock", "tier"] as const;
    for (const variant of variants) {
      const h = renderToString(React.createElement(Badge, { variant, value: "low" }));
      expect(EMOJI_REGEX.test(h)).toBe(false);
    }
  });
});

describe("Anti-Pattern: No JS-string CSS exports", () => {
  it("StatusPill has no pillStyles export", async () => {
    const mod = await import("../components/StatusPill.js");
    expect((mod as any).pillStyles).toBeUndefined();
  });

  it("Button has no buttonStyles export", async () => {
    const mod = await import("../components/Button.js");
    expect((mod as any).buttonStyles).toBeUndefined();
  });

  it("Panel has no panelStyles export", async () => {
    const mod = await import("../components/Panel.js");
    expect((mod as any).panelStyles).toBeUndefined();
  });

  it("MetricCell has no metricStyles export", async () => {
    const mod = await import("../components/MetricCell.js");
    expect((mod as any).metricStyles).toBeUndefined();
  });

  it("EmptyState has no emptyStateStyles export", async () => {
    const mod = await import("../components/EmptyState.js");
    expect((mod as any).emptyStateStyles).toBeUndefined();
  });

  it("SearchBox has no searchBoxStyles export", async () => {
    const mod = await import("../components/SearchBox.js");
    expect((mod as any).searchBoxStyles).toBeUndefined();
  });

  it("OperationalTable has no tableStyles export", async () => {
    const mod = await import("../components/OperationalTable.js");
    expect((mod as any).tableStyles).toBeUndefined();
  });

  it("AppShell has no appShellStyles export", async () => {
    const mod = await import("../layout/AppShell.js");
    expect((mod as any).appShellStyles).toBeUndefined();
  });

  it("Sidebar has no sidebarStyles export", async () => {
    const mod = await import("../layout/Sidebar.js");
    expect((mod as any).sidebarStyles).toBeUndefined();
  });

  it("Topbar has no topbarStyles export", async () => {
    const mod = await import("../layout/Topbar.js");
    expect((mod as any).topbarStyles).toBeUndefined();
  });
});

describe("Anti-Pattern: No globalStyles aggregate", () => {
  it("index.ts does not export globalStyles", async () => {
    const mod = await import("../index.js");
    expect((mod as any).globalStyles).toBeUndefined();
  });
});

describe("Design Decision: Teal accent, not emerald", () => {
  it("StatusPill uses text-status-* classes, not hardcoded emerald colors", () => {
    const h = renderToString(React.createElement(StatusPill, {
      label: "Active", tone: "success",
    }));
    expect(h).toContain("text-status-success");
    // Should NOT contain a hardcoded emerald hex
    expect(h).not.toContain("#059669");
    expect(h).not.toContain("#10b981");
  });
});

describe("Design Decision: Sidebar uses groups, not flat items", () => {
  it("Sidebar accepts groups prop and renders section labels", () => {
    const h = renderToString(React.createElement(Sidebar, {
      brand: { label: "Snus Ops", icon: Store },
      groups: [
        { label: "QUẦY", items: [{ id: "pos", label: "Bán hàng", icon: ShoppingCart }] },
        { label: "KHO", items: [{ id: "inventory", label: "Tồn kho", icon: Package }] },
      ],
      activeId: "pos",
      onSelect: () => {},
    }));
    expect(h).toContain("QUẦY");
    expect(h).toContain("KHO");
    expect(h).toContain("snus-nav-section-label");
  });

  it("Sidebar groups prop is required (type-check verifies this)", () => {
    // If groups were still `items`, this test file wouldn't compile
    // because the SidebarProps type now requires `groups`
    const h = renderToString(React.createElement(Sidebar, {
      brand: { label: "S", icon: Store },
      groups: [{ label: "Test", items: [{ id: "x", label: "X", icon: Store }] }],
      activeId: "x",
      onSelect: () => {},
    }));
    expect(h).toContain("X");
  });
});

describe("Design Decision: EmptyState never used as loading state", () => {
  it("EmptyState renders title, not loading text", () => {
    const h = renderToString(React.createElement(EmptyState, {
      title: "Chưa có sản phẩm",
      body: "Tạo sản phẩm đầu tiên.",
    }));
    expect(h).toContain("Chưa có sản phẩm");
    expect(h).not.toContain("Đang tải");
  });
});

describe("Design Decision: Button active:scale for tactile feedback", () => {
  it("Button includes active:scale-[0.97] for press feedback", () => {
    const h = renderToString(React.createElement(Button, {
      variant: "primary",
      children: "Click",
    }));
    expect(h).toContain("active:scale-[0.97]");
  });
});

describe("Design Decision: OperationalTable uses data-clickable not CSS class for clickable rows", () => {
  it("clickable rows have data-clickable='true' attribute", () => {
    const h = renderToString(React.createElement(OperationalTable, {
      columns: ["C1"],
      rows: [["V1"]],
      onRowClick: () => {},
    }));
    expect(h).toContain('data-clickable="true"');
  });

  it("non-clickable table has no data-clickable", () => {
    const h = renderToString(React.createElement(OperationalTable, {
      columns: ["C1"],
      rows: [["V1"]],
    }));
    // Without onRowClick, data-clickable should not be "true"
    expect(h).not.toContain('data-clickable="true"');
  });
});
