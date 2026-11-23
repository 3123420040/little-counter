// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { OfflineSalesReview } from "./OfflineSalesReview";
import { renderTestUi, buttonByText } from "../test/reactTestHarness";
import type { QueuedSale } from "../utils/offlineQueue";
const sale = { id: "queued", status: "needs_review", createdAt: "2026-09-07T00:00:00.000Z", payload: { items: [{ variantId: "a", quantity: 3 }] }, lastError: "Chính sách đã thay đổi" } as QueuedSale;
let cleanup: (()=>void) | undefined;
afterEach(()=>cleanup?.());
it("provides a retry action and keeps a rejected draft visible with its error", async()=>{
  const retry=vi.fn().mockRejectedValue(new Error("Chưa nhận được phản hồi"));
  const ui=renderTestUi(<OfflineSalesReview sales={[sale]} ready={()=>true} onClose={()=>{}} onRetry={retry}/>); cleanup=()=>ui.unmount();
  await act(async()=>buttonByText(ui.container,"Kiểm tra và thử đồng bộ lại").click());
  expect(retry).toHaveBeenCalledWith(sale);
  expect(ui.container.textContent).toContain("Chưa nhận được phản hồi");
  expect(ui.container.textContent).toContain("Chính sách đã thay đổi");
  expect(buttonByText(ui.container,"Kiểm tra và thử đồng bộ lại").disabled).toBe(false);
});
it("prevents retry outside the captured scope",()=>{
  const retry=vi.fn();const ui=renderTestUi(<OfflineSalesReview sales={[sale]} ready={()=>false} onClose={()=>{}} onRetry={retry}/>);cleanup=()=>ui.unmount();
  expect(buttonByText(ui.container,"Kiểm tra và thử đồng bộ lại").disabled).toBe(true);
  expect(retry).not.toHaveBeenCalled();
});
