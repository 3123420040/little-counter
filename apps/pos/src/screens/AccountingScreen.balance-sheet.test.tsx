// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderTestUi, type TestRender } from "../test/reactTestHarness";

vi.mock("@medusa-snus/ui", async () => {
  const React = await import("react");
  return {
    Button: ({ children, ...props }: Record<string, unknown>) =>
      React.createElement("button", props, children as React.ReactNode),
  };
});

import { BalanceSheetSummary } from "./AccountingScreen";

let mounted: TestRender | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("balance sheet UI contract", () => {
  it("shows ledger equity, current earnings, total equity, and a balanced equation", () => {
    mounted = renderTestUi(
      <BalanceSheetSummary
        data={{
          totalAssets: 267_000,
          totalLiabilities: 36_546,
          ledgerEquity: 0,
          currentEarnings: 230_454,
          reportedEquity: 230_454,
          totalEquity: 230_454,
          balanceDelta: 0,
        }}
      />,
    );

    expect(mounted.container.textContent).toContain("Vốn theo sổ cái");
    expect(mounted.container.textContent).toContain("Lợi nhuận chưa kết chuyển");
    expect(mounted.container.textContent).toContain("230.454 ₫");
    const equation = mounted.container.querySelector('[data-testid="balance-sheet-equation"]');
    expect(equation?.getAttribute("data-balanced")).toBe("true");
    expect(equation?.textContent).toContain("Đã cân đối");
  });

  it("surfaces a non-zero equation delta", () => {
    mounted = renderTestUi(
      <BalanceSheetSummary
        data={{
          totalAssets: 267_000,
          totalLiabilities: 36_546,
          ledgerEquity: 0,
          currentEarnings: 0,
          reportedEquity: 0,
          totalEquity: 0,
          balanceDelta: 230_454,
        }}
      />,
    );

    const equation = mounted.container.querySelector('[data-testid="balance-sheet-equation"]');
    expect(equation?.getAttribute("data-balanced")).toBe("false");
    expect(equation?.textContent).toContain("230.454 ₫");
  });
});
