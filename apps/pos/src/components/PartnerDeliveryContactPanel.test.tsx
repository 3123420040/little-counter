// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { renderTestUi, buttonByText, type TestRender } from "../test/reactTestHarness";
const http = vi.hoisted(() => ({ get: vi.fn(), store: "store1" }));
vi.mock("../api/client", () => ({
  api: { get: http.get }, ApiError: class extends Error {}, SCOPE_CHANGED_EVENT: "snus:scope-changed",
  getClientScopeSnapshot: () => ({ operatingMerchantId: "merchant1", operatingStoreId: http.store }),
}));
vi.mock("@medusa-snus/ui", async () => {
  const React = await import("react");
  return { Button: ({ children, variant: _v, size: _s, ...props }: Record<string, unknown>) =>
    React.createElement("button", props, children as React.ReactNode) };
});
import { PartnerDeliveryContactPanel } from "./PartnerDeliveryContactPanel";
const contact = { recipient_name: "Synthetic Recipient", phone: "0000000000", address: "Synthetic Address",
  retention_until: "2099-01-01T00:00:00.000Z" };
let view: TestRender;
beforeEach(() => { http.get.mockReset(); http.store = "store1"; });
afterEach(() => { view?.unmount(); vi.useRealTimers(); });
describe("staff partner contact disclosure", () => {
  it("loads only after staff clicks and hides plaintext on request", async () => {
    http.get.mockResolvedValue({ data: contact });
    view = renderTestUi(<PartnerDeliveryContactPanel orderId="order/1" canRead />);
    expect(http.get).not.toHaveBeenCalled();
    await act(async () => buttonByText(view.container, "Xem thông tin").click());
    expect(http.get).toHaveBeenCalledWith("/api/platform/admin/orders/order%2F1/partner-contact");
    expect(view.container.textContent).toContain(contact.address);
    act(() => buttonByText(view.container, "Ẩn thông tin").click());
    expect(view.container.textContent).not.toContain(contact.address);
  });
  it("discards an in-flight response when the operating scope changes", async () => {
    let resolve!: (value: unknown) => void;
    http.get.mockReturnValue(new Promise(done => { resolve = done; }));
    view = renderTestUi(<PartnerDeliveryContactPanel orderId="order1" canRead />);
    act(() => buttonByText(view.container, "Xem thông tin").click());
    act(() => { http.store = "store2"; window.dispatchEvent(new Event("snus:scope-changed")); });
    await act(async () => resolve({ data: contact }));
    expect(view.container.textContent).not.toContain(contact.address);
  });
  it("clears disclosed contact after 90 seconds and when permission is removed", async () => {
    vi.useFakeTimers(); http.get.mockResolvedValue({ data: contact });
    view = renderTestUi(<PartnerDeliveryContactPanel orderId="order1" canRead />);
    await act(async () => buttonByText(view.container, "Xem thông tin").click());
    expect(view.container.textContent).toContain(contact.address);
    act(() => vi.advanceTimersByTime(90000)); expect(view.container.textContent).not.toContain(contact.address);
    await act(async () => buttonByText(view.container, "Xem thông tin").click());
    view.rerender(<PartnerDeliveryContactPanel orderId="order1" canRead={false} />);
    expect(view.container.textContent).not.toContain(contact.address);
  });
  it("discards the previous order's data when a different order is opened", async () => {
    http.get.mockResolvedValue({ data: contact });
    view = renderTestUi(<PartnerDeliveryContactPanel orderId="order1" canRead />);
    await act(async () => buttonByText(view.container, "Xem thông tin").click());
    view.rerender(<PartnerDeliveryContactPanel orderId="order2" canRead />);
    expect(view.container.textContent).not.toContain(contact.address);
  });
});
