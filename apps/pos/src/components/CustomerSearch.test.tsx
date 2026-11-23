// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { changeValue, click, renderTestUi, type TestRender } from "../test/reactTestHarness";

const hooks = vi.hoisted(() => ({
  customers: [{
    id: "customer-b",
    phone: "0911111111",
    first_name: "Binh",
    last_name: "Tran",
  }],
  create: vi.fn(),
}));

vi.mock("lucide-react", async () => {
  const React = await import("react");
  const Icon = () => React.createElement("span");
  return { Search: Icon, UserPlus: Icon };
});

vi.mock("../hooks/useCustomers", () => ({
  useCustomers: () => ({ data: hooks.customers }),
  useCreateCustomer: () => ({ isPending: false, mutateAsync: hooks.create }),
}));

import { CustomerSearch } from "./CustomerSearch";

let mounted: TestRender | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.useRealTimers();
  hooks.create.mockReset();
});

describe("CustomerSearch attribution state", () => {
  it("clears a stale selected ID as soon as the visible phone diverges", () => {
    const onClear = vi.fn();
    const onDraftChange = vi.fn();
    mounted = renderTestUi(
      <CustomerSearch
        selectedPhone="0900000000"
        onSelect={vi.fn()}
        onClear={onClear}
        onDraftChange={onDraftChange}
      />,
    );

    const input = mounted.container.querySelector('input[aria-label="Customer phone"]') as HTMLInputElement;
    changeValue(input, "0911111111");
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onDraftChange).toHaveBeenLastCalledWith("0911111111");
  });

  it("emits the exact server customer only after an explicit result selection", () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    mounted = renderTestUi(
      <CustomerSearch onSelect={onSelect} onClear={vi.fn()} />,
    );
    const input = mounted.container.querySelector('input[aria-label="Customer phone"]') as HTMLInputElement;
    changeValue(input, "0911111111");
    expect(onSelect).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(301));
    const result = Array.from(mounted.container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("0911111111"));
    if (!result) throw new Error("customer result not rendered");
    click(result);
    expect(onSelect).toHaveBeenCalledWith({
      id: "customer-b",
      phone: "0911111111",
      name: "Tran Binh",
    });
  });
});
