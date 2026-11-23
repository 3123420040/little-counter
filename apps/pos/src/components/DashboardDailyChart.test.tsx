// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { renderTestUi, type TestRender } from "../test/reactTestHarness";
import { DashboardDailyChart } from "./DashboardDailyChart";

let mounted: TestRender | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const points = [
  {
    localDate: "2026-09-03",
    activeOrderCount: 8,
    currentOrderGrossValueMinor: 1_250_000,
    recordedGrossCollectionsMinor: 940_000,
  },
  {
    localDate: "2026-09-04",
    activeOrderCount: 11,
    currentOrderGrossValueMinor: 1_880_000,
    recordedGrossCollectionsMinor: 1_620_000,
  },
];

describe("DashboardDailyChart", () => {
  it("uses canonical daily order value, not recorded collections, on pointer hover", async () => {
    mounted = renderTestUi(
      <DashboardDailyChart
        currencyCode="VND"
        minorUnitExponent={0}
        points={points}
      />,
    );
    const firstDay = mounted.container.querySelector<SVGGElement>(
      '[data-chart-day="2026-09-03"]',
    );
    expect(firstDay).not.toBeNull();
    expect(mounted.container.querySelector('[role="tooltip"]')).toBeNull();

    await act(async () => {
      firstDay!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });

    const tooltip = mounted.container.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toContain("03/09/2026");
    expect(tooltip?.textContent).toContain("8 đơn trong ngày");
    expect(tooltip?.textContent).toContain("Giá trị đơn hàng: 1.250.000 VND");
    expect(tooltip?.textContent).not.toContain("940.000 VND");
    expect(
      mounted.container.querySelectorAll('[data-series="current-order-value"]'),
    ).toHaveLength(2);
    expect(mounted.container.textContent).toContain("Giá trị đơn hàng");
    expect(mounted.container.textContent).toContain("Số đơn");
    expect(mounted.container.textContent).not.toContain("Tiền thực thu");
  });

  it("supports keyboard focus and exposes a Vietnamese chart description", async () => {
    mounted = renderTestUi(
      <DashboardDailyChart
        currencyCode="VND"
        minorUnitExponent={0}
        points={points}
      />,
    );
    const secondDay = mounted.container.querySelector<SVGGElement>(
      '[data-chart-day="2026-09-04"]',
    );
    expect(secondDay).not.toBeNull();
    expect(
      mounted.container.querySelector("svg")?.getAttribute("aria-label"),
    ).toContain("Giá trị đơn hàng và số đơn theo ngày");

    await act(async () => {
      secondDay!.focus();
    });

    expect(
      mounted.container.querySelector('[role="tooltip"]')?.textContent,
    ).toContain("04/09/2026");
  });
  it("opens day details on a click without a preceding hover", async () => {
    mounted = renderTestUi(<DashboardDailyChart currencyCode="VND" minorUnitExponent={0} points={points} />);
    await act(async () => { mounted!.container.querySelector('[data-chart-day="2026-09-03"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(mounted.container.querySelector('[role="tooltip"]')?.textContent).toContain("1.250.000 VND");
  });

});

it("clears selection across date-set, exponent and currency changes but refreshes the same selected day", () => {
  mounted = renderTestUi(<DashboardDailyChart currencyCode="VND" minorUnitExponent={0} points={points} />);
  const select = () => act(() => { mounted!.container.querySelector('[data-chart-day]')!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  select();
  mounted.rerender(<DashboardDailyChart currencyCode="VND" minorUnitExponent={0} points={points.map(p => ({ ...p, currentOrderGrossValueMinor: 690_000 }))} />);
  expect(mounted.container.querySelector('[role="tooltip"]')?.textContent).toContain("690.000 VND");
  mounted.rerender(<DashboardDailyChart currencyCode="VND" minorUnitExponent={0} points={points.slice(0, 1)} />);
  expect(mounted.container.querySelector('[role="tooltip"]')).toBeNull();
  mounted.rerender(<DashboardDailyChart currencyCode="VND" minorUnitExponent={0} points={points} />);
  expect(mounted.container.querySelector('[role="tooltip"]')).toBeNull();
  select();
  mounted.rerender(<DashboardDailyChart currencyCode="VND" minorUnitExponent={2} points={points} />);
  expect(mounted.container.querySelector('[role="tooltip"]')).toBeNull();
  select();
  mounted.rerender(<DashboardDailyChart currencyCode="USD" minorUnitExponent={2} points={points} />);
  expect(mounted.container.querySelector('[role="tooltip"]')).toBeNull();
});

it("renders the literal 690000 order oracle rather than collection-only money in the bar geometry", () => {
  const fixture = [
    { localDate: "2026-09-01", activeOrderCount: 1, currentOrderGrossValueMinor: 690000, recordedGrossCollectionsMinor: 0 },
    { localDate: "2026-09-02", activeOrderCount: 0, currentOrderGrossValueMinor: 0, recordedGrossCollectionsMinor: 990000 },
  ];
  mounted = renderTestUi(<DashboardDailyChart currencyCode="VND" minorUnitExponent={0} points={fixture} />);
  const bars = mounted.container.querySelectorAll('[data-series="current-order-value"]');
  expect(bars[0].getAttribute("y")).toBe("28");
  expect(bars[0].getAttribute("height")).toBe("218");
  expect(bars[1].getAttribute("y")).toBe("246");
  expect(mounted.container.querySelector('polyline')?.getAttribute('points')).toBe("227.5,28 566.5,246");
});
