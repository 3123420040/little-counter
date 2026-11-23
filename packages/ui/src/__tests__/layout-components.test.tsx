import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import React from "react";
import { AppShell, Sidebar, Topbar, StatusPill, SearchBox, Button } from "../index.js";
import type { NavGroup } from "../layout/Sidebar.js";
import { Store, ShoppingCart, Package, Users } from "lucide-react";

const navGroups: NavGroup[] = [
  {
    label: "Quầy",
    items: [{ id: "pos", label: "Bán hàng", icon: ShoppingCart }],
  },
  {
    label: "Kho",
    items: [
      { id: "inventory", label: "Tồn kho", icon: Package },
      { id: "purchase-orders", label: "Đặt hàng", icon: Users },
    ],
  },
];

describe("AppShell", () => {
  it("renders sidebar + content", () => {
    const h = renderToString(React.createElement(AppShell, {
      sidebar: React.createElement("div", null, "Side"),
      children: React.createElement("div", null, "Main"),
    }));
    expect(h).toContain("Side"); expect(h).toContain("Main"); expect(h).toContain("snus-shell");
    expect(h).toContain('aria-label="Primary navigation"');
  });
  it("renders optional topbar", () => {
    const h = renderToString(React.createElement(AppShell, {
      sidebar: React.createElement("div", null, "S"),
      topbar: React.createElement("div", null, "TB"),
      children: React.createElement("div", null, "M"),
    }));
    expect(h).toContain("TB"); expect(h).toContain("snus-topbar");
  });
});

describe("Sidebar", () => {
  it("renders brand + nav groups with active state", () => {
    const h = renderToString(React.createElement(Sidebar, {
      brand: { label: "Snus Ops", icon: Store },
      groups: navGroups,
      activeId: "pos",
      onSelect: () => {},
    }));
    expect(h).toContain("Snus Ops"); expect(h).toContain("Bán hàng");
    expect(h).toContain("snus-nav-item--active"); expect(h).toContain('aria-current="page"');
    expect(h).toContain("Quầy"); // section label
    expect(h).toContain("Kho"); // section label
  });
  it("shows badge on nav item", () => {
    const h = renderToString(React.createElement(Sidebar, {
      brand: { label: "S", icon: Store },
      groups: [{ label: "Test", items: [{ id: "ai", label: "AI", icon: Store, badge: 3 }] }],
      activeId: "ai",
      onSelect: () => {},
    }));
    expect(h).toContain("snus-nav-badge"); expect(h).toContain("3");
  });
  it("renders footer", () => {
    const h = renderToString(React.createElement(Sidebar, {
      brand: { label: "S", icon: Store },
      groups: navGroups,
      activeId: "pos",
      onSelect: () => {},
      footer: React.createElement("div", null, "Footer"),
    }));
    expect(h).toContain("Footer"); expect(h).toContain("snus-sidebar-footer");
  });
});

describe("Topbar", () => {
  it("renders title", () => {
    const h = renderToString(React.createElement(Topbar, { title: "Bán hàng" }));
    expect(h).toContain("Bán hàng"); expect(h).toContain("<h1");
  });
  it("renders status indicators", () => {
    const h = renderToString(React.createElement(Topbar, {
      title: "Dashboard",
      statusIndicators: React.createElement(React.Fragment, null,
        React.createElement(StatusPill, { key: "1", label: "Online", tone: "success" }),
      ),
    }));
    expect(h).toContain("Online");
  });
  it("renders actions", () => {
    const h = renderToString(React.createElement(Topbar, {
      title: "POS",
      actions: React.createElement(React.Fragment, null,
        React.createElement(SearchBox, { key: "s", placeholder: "Tìm..." }),
        React.createElement(Button, { key: "r", variant: "ghost", children: "Refresh" }),
      ),
    }));
    expect(h).toContain("Tìm..."); expect(h).toContain("Refresh");
  });
});
