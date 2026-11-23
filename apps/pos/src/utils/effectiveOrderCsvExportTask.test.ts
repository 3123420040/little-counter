import { describe, expect, it, vi } from "vitest";
import {
  EffectiveOrderCsvExportTaskErrorV3,
  createEffectiveOrderCsvExportTaskV3,
} from "./effectiveOrderCsvExportTask";

const input = {
  requestId: "export-1",
  scope: {
    scopeKind: "report" as const,
    merchantId: "merchant-a",
    storeIds: ["store-a"],
  },
  filters: {
    search: "  ORD-A  ",
    statusMode: "completed" as const,
    storeWindows: [
      {
        storeId: "store-a",
        startInclusive: "2026-08-04T00:00:00.000Z",
        endExclusive: "2026-08-06T00:00:00.000Z",
      },
    ],
  },
  grain: "order" as const,
  nowEpochSeconds: 1_786_000_000,
};

function response(
  grain: "order" | "effective_line" = "order",
  overrides: Record<string, string> = {},
  body = "schema_version,order_id,vat_minor,unclassified_minor,current_order_gross_value_minor\r\n3,order-a,900,100,12000\r\n",
) {
  const asOf = "2026-08-05T00:00:00.000Z";
  const filename = `orders-effective-${grain}-20260805T000000Z.csv`;
  const bytes = new TextEncoder().encode(body).byteLength;
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(bytes),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Order-Export-Contract": "orders.effective-order.v3",
      "X-Order-Export-Grain": grain,
      "X-Order-Export-As-Of": asOf,
      "X-Order-Export-Revision-SHA256": "a".repeat(64),
      "X-Order-Export-Order-Count": "1",
      "X-Order-Export-Row-Count": "1",
      ...overrides,
    },
  });
}

describe("CSV-04 inactive POS effective-order export task", () => {
  it("is disabled by default before validation and never calls transport", async () => {
    const transport = vi.fn();
    const task = createEffectiveOrderCsvExportTaskV3(
      { transport },
      {
        ...input,
        requestId: "",
      },
    );

    expect(task).toEqual({ enabled: false, status: "disabled" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("normalizes the exact list selection before transport", async () => {
    const transport = vi.fn().mockResolvedValue(response());
    const task = createEffectiveOrderCsvExportTaskV3(
      { config: { enabled: true }, transport },
      input,
    );
    if (!task.enabled) throw new Error("expected enabled export task");

    expect(task.requestKey).toContain("orders.effective-order.v3:");
    await task.execute();
    expect(transport).toHaveBeenCalledWith({
      scope: {
        scopeKind: "report",
        merchantId: "merchant-a",
        storeIds: ["store-a"],
      },
      filters: {
        searchMode: "order_or_customer_identity",
        search: "ord-a",
        statusMode: "completed",
        storeWindows: input.filters.storeWindows,
      },
      grain: "order",
    });
  });

  it("returns a verified v3 Blob without performing a browser download", async () => {
    const task = createEffectiveOrderCsvExportTaskV3(
      {
        config: { enabled: true },
        transport: vi.fn().mockResolvedValue(response()),
      },
      input,
    );
    if (!task.enabled) throw new Error("expected enabled export task");

    const result = await task.execute();
    expect(result).toMatchObject({
      kind: "ready",
      requestId: "export-1",
      filename: "orders-effective-order-20260805T000000Z.csv",
      contractVersion: "orders.effective-order.v3",
      grain: "order",
      asOf: "2026-08-05T00:00:00.000Z",
      revisionSha256: "a".repeat(64),
      orderCount: 1,
      rowCount: 1,
    });
    if (result.kind !== "ready") throw new Error("expected ready export");
    expect(await result.blob.text()).toContain("vat_minor,unclassified_minor");
  });

  it("accepts the same nosniff directive repeated by route and reverse proxy", async () => {
    const task = createEffectiveOrderCsvExportTaskV3(
      {
        config: { enabled: true },
        transport: vi.fn().mockResolvedValue(
          response("order", {
            "X-Content-Type-Options": "nosniff, nosniff",
          }),
        ),
      },
      input,
    );
    if (!task.enabled) throw new Error("expected enabled export task");

    await expect(task.execute()).resolves.toMatchObject({ kind: "ready" });
  });

  it("accepts WebKit's standards-compliant text/csv content-type normalization", async () => {
    const task = createEffectiveOrderCsvExportTaskV3(
      {
        config: { enabled: true },
        transport: vi.fn().mockResolvedValue(
          response("order", {
            "Content-Type": "text/csv",
          }),
        ),
      },
      input,
    );
    if (!task.enabled) throw new Error("expected enabled export task");

    await expect(task.execute()).resolves.toMatchObject({ kind: "ready" });
  });

  it("validates the decoded CSV entity length when an edge proxy compresses the wire response", async () => {
    const body =
      "schema_version,order_id,vat_minor,unclassified_minor,current_order_gross_value_minor\r\n3,order-a,900,100,12000\r\n";
    const entityLength = new TextEncoder().encode(body).byteLength;
    const task = createEffectiveOrderCsvExportTaskV3(
      {
        config: { enabled: true },
        transport: vi.fn().mockResolvedValue(
          response(
            "order",
            {
              "Content-Encoding": "gzip",
              "Content-Length": "41",
              "X-Order-Export-Content-Length": String(entityLength),
            },
            body,
          ),
        ),
      },
      input,
    );
    if (!task.enabled) throw new Error("expected enabled export task");

    await expect(task.execute()).resolves.toMatchObject({ kind: "ready" });
  });

  it("fails closed when the declared decoded CSV entity length does not match the blob", async () => {
    const task = createEffectiveOrderCsvExportTaskV3(
      {
        config: { enabled: true },
        transport: vi.fn().mockResolvedValue(
          response("order", {
            "X-Order-Export-Content-Length": "1",
          }),
        ),
      },
      input,
    );
    if (!task.enabled) throw new Error("expected enabled export task");

    await expect(task.execute()).resolves.toEqual({
      kind: "failed",
      requestId: "export-1",
      message: "Unable to export orders",
    });
  });

  it("accepts response milliseconds in the same client second within bounded clock skew", async () => {
    const asOf = "2026-08-05T00:00:00.219Z";
    const task = createEffectiveOrderCsvExportTaskV3(
      {
        config: { enabled: true },
        transport: vi.fn().mockResolvedValue(
          response("order", {
            "X-Order-Export-As-Of": asOf,
            "Content-Disposition":
              'attachment; filename="orders-effective-order-20260805T000000.219Z.csv"',
          }),
        ),
      },
      {
        ...input,
        nowEpochSeconds: Math.floor(Date.parse(asOf) / 1_000),
      },
    );
    if (!task.enabled) throw new Error("expected enabled export task");

    await expect(task.execute()).resolves.toMatchObject({
      kind: "ready",
      asOf,
    });
  });

  it("supports effective-line grain without changing the normalized selection", async () => {
    const transport = vi.fn().mockResolvedValue(response("effective_line"));
    const task = createEffectiveOrderCsvExportTaskV3(
      { config: { enabled: true }, transport },
      { ...input, grain: "effective_line" },
    );
    if (!task.enabled) throw new Error("expected enabled export task");
    await expect(task.execute()).resolves.toMatchObject({
      kind: "ready",
      grain: "effective_line",
      filename: "orders-effective-effective_line-20260805T000000Z.csv",
    });
  });

  it("fails closed for unsafe or internally inconsistent response metadata", async () => {
    const invalidResponses = [
      response("order", {
        "Content-Disposition": "attachment; filename=../../orders.csv",
      }),
      response("order", { "X-Order-Export-Grain": "effective_line" }),
      response("order", { "X-Order-Export-Revision-SHA256": "weak" }),
      response("order", { "X-Order-Export-Order-Count": "10001" }),
      response("order", { "Content-Length": "1" }),
      response("order", { "Content-Type": "application/csv" }),
      response("order", { "Content-Type": "text/csv; charset=iso-8859-1" }),
      response("order", { "X-Content-Type-Options": "nosniff, unsafe" }),
      response("order", { "X-Order-Export-As-Of": "2027-08-05T00:00:00.000Z" }),
    ];
    for (const invalid of invalidResponses) {
      const task = createEffectiveOrderCsvExportTaskV3(
        {
          config: { enabled: true },
          transport: vi.fn().mockResolvedValue(invalid),
        },
        input,
      );
      if (!task.enabled) throw new Error("expected enabled export task");
      await expect(task.execute()).resolves.toEqual({
        kind: "failed",
        requestId: "export-1",
        message: "Unable to export orders",
      });
    }

    const nonResponse = createEffectiveOrderCsvExportTaskV3(
      {
        config: { enabled: true },
        transport: vi.fn().mockResolvedValue({ body: "merchant-b secret" }),
      } as never,
      input,
    );
    if (!nonResponse.enabled) throw new Error("expected enabled export task");
    await expect(nonResponse.execute()).resolves.toEqual({
      kind: "failed",
      requestId: "export-1",
      message: "Unable to export orders",
    });
  });

  it("maps only an exact oversize contract to async-required", async () => {
    const exact = createEffectiveOrderCsvExportTaskV3(
      {
        config: { enabled: true },
        transport: vi.fn().mockRejectedValue({
          status: 413,
          code: "async_export_required",
          details: { selectedOrderCount: 10_001, maximumOrderCount: 10_000 },
        }),
      },
      input,
    );
    if (!exact.enabled) throw new Error("expected enabled export task");
    await expect(exact.execute()).resolves.toEqual({
      kind: "async_required",
      requestId: "export-1",
      selectedOrderCount: 10_001,
      maximumOrderCount: 10_000,
    });

    const forged = createEffectiveOrderCsvExportTaskV3(
      {
        config: { enabled: true },
        transport: vi.fn().mockRejectedValue({
          status: 413,
          code: "async_export_required",
          details: { selectedOrderCount: 1, maximumOrderCount: 10_000 },
          message: "merchant-b secret",
        }),
      },
      input,
    );
    if (!forged.enabled) throw new Error("expected enabled export task");
    await expect(forged.execute()).resolves.toEqual({
      kind: "failed",
      requestId: "export-1",
      message: "Unable to export orders",
    });
  });

  it("rejects scope/filter/grain/clock drift before transport", () => {
    const transport = vi.fn();
    const invalid = [
      { ...input, scope: { ...input.scope, storeIds: ["store-b"] } },
      { ...input, grain: "page" as never },
      { ...input, nowEpochSeconds: -1 },
    ];
    for (const value of invalid) {
      expect(() =>
        createEffectiveOrderCsvExportTaskV3(
          { config: { enabled: true }, transport },
          value,
        ),
      ).toThrow(EffectiveOrderCsvExportTaskErrorV3);
    }
    expect(transport).not.toHaveBeenCalled();
  });
});
