// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const client = vi.hoisted(() => ({ rawGet: vi.fn() }));
vi.mock("./client", () => ({ api: client }));
import { downloadOrderExportCsv } from "./endpoints";
import { validateEffectiveOrderCsvResponseV4, validateEffectiveOrderCsvResponseV5 } from "../utils/effectiveOrderCsvExportTaskV4";
import { createEffectiveOrderCsvDownloadCoordinatorV5 } from "../utils/effectiveOrderCsvDownloadCoordinatorV4";
const scope = { scopeKind: "report" as const, merchantId: "merchant-a", storeIds: ["store-a"] };
const selection = { mode: "selected", creatorOperatorIds: ["staff-a", "staff-b"] };
const filters = { dateFrom: "2026-10-26", dateTo: "2026-10-26", status: "all" as const, creatorOperatorIds: ["staff-b", "staff-a", "staff-b"] };
function response(patch: Record<string, string> = {}) {
  const body = "contract_version,order_id,payment_methods\r\norders.effective-order.v5,order-a,cash\r\n";
  const asOf = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  return new Response(body, { headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff", "Content-Disposition": `attachment; filename="orders-effective-order-${asOf.replace(/[-:]/g, "").replace(".000", "")}.csv"`,
    "X-Order-Export-Contract": "orders.effective-order.v5", "X-Order-Export-Grain": "order", "X-Order-Export-As-Of": asOf,
    "X-Order-Export-Revision-SHA256": "a".repeat(64), "X-Order-Export-Order-Count": "1", "X-Order-Export-Row-Count": "1",
    "X-Order-Export-Content-Length": String(new TextEncoder().encode(body).byteLength), "X-Order-Export-Scope": JSON.stringify(scope),
    "X-Order-Export-Creator-Selection": JSON.stringify(selection), ...patch } });
}
beforeEach(() => {
  client.rawGet.mockReset(); client.rawGet.mockResolvedValue(response());
  vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:csv-v5"), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("fee-aware CSV download", () => {
  it("captures the scope, sorted creator selection and signal and releases the one download URL", async () => {
    const controller = new AbortController();
    await downloadOrderExportCsv(filters, { scope, signal: controller.signal, feeAware: true });
    expect(client.rawGet).toHaveBeenCalledExactlyOnceWith("/api/platform/admin/orders/export-effective-v5?from=2026-10-26&to=2026-10-26&status=all&creatorOperatorId=staff-a&creatorOperatorId=staff-b&grain=order",
      { "x-report-merchant-id": "merchant-a", "x-report-store-ids": "store-a" }, controller.signal);
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:csv-v5");
  });
  it.each<Record<string, string>>([
    { "X-Order-Export-Contract": "orders.effective-order.v4" }, { "X-Order-Export-Scope": JSON.stringify({ ...scope, merchantId: "foreign" }) },
    { "X-Order-Export-Creator-Selection": JSON.stringify({ mode: "all", creatorOperatorIds: [] }) },
    { "X-Order-Export-Content-Length": "1" }, { "X-Order-Export-Scope": "{}" }, { "X-Order-Export-Row-Count": "2" },
  ])("rejects metadata/version/scope drift and never falls back to V4: %j", async (patch) => {
    client.rawGet.mockResolvedValue(response(patch));
    await expect(downloadOrderExportCsv(filters, { scope, signal: new AbortController().signal, feeAware: true })).rejects.toThrow();
    expect(client.rawGet).toHaveBeenCalledTimes(1); expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it("ignores a successful late response after scope cancellation, even if fetch ignored AbortSignal", async () => {
    let resolve!: (value: Response) => void;
    client.rawGet.mockReturnValue(new Promise<Response>(done => { resolve = done; }));
    const controller = new AbortController();
    const pending = downloadOrderExportCsv(filters, { scope, signal: controller.signal, feeAware: true });
    controller.abort(); resolve(response());
    await expect(pending).rejects.toThrow(/phạm vi/i);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it("also stops after cancellation during Blob consumption", async () => {
    const controller = new AbortController(), value = response();
    const blob = await value.clone().blob();
    vi.spyOn(value, "blob").mockImplementation(async () => { controller.abort(); return blob; });
    client.rawGet.mockResolvedValue(value);
    await expect(downloadOrderExportCsv(filters, { scope, signal: controller.signal, feeAware: true })).rejects.toThrow(/phạm vi/i);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it("fails closed for an impossible canonical snapshot date", async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(validateEffectiveOrderCsvResponseV5(response({ "X-Order-Export-As-Of": "2026-13-27T00:00:00.000Z" }), "order", now, "request-invalid-date"))
      .resolves.toMatchObject({ kind: "failed" });
  });
  it("keeps V4 strict and executes a verified V5 coordinator only once", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await validateEffectiveOrderCsvResponseV4(response(), "order", now, "request-a")).toMatchObject({ kind: "failed" });
    const result = await validateEffectiveOrderCsvResponseV5(response(), "order", now, "request-a");
    expect(result.kind).toBe("ready");
    const triggerDownload = vi.fn();
    const coordinator = createEffectiveOrderCsvDownloadCoordinatorV5({ config: { enabled: true }, createObjectUrl: URL.createObjectURL,
      revokeObjectUrl: URL.revokeObjectURL, triggerDownload }, result);
    if (!coordinator.enabled) throw new Error("Expected enabled coordinator");
    const [a, b] = await Promise.all([coordinator.execute(), coordinator.execute()]);
    expect(a).toEqual(b); expect(a.kind).toBe("downloaded"); expect(triggerDownload).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });
});
