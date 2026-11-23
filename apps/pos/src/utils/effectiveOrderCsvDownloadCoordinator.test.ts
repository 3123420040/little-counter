import { describe, expect, it, vi } from "vitest";
import type { EffectiveOrderCsvExportResultV3 } from "./effectiveOrderCsvExportTask";
import {
  EffectiveOrderCsvDownloadCoordinatorErrorV3,
  createEffectiveOrderCsvDownloadCoordinatorV3,
} from "./effectiveOrderCsvDownloadCoordinator";

function ready(): Extract<EffectiveOrderCsvExportResultV3, { kind: "ready" }> {
  return {
    kind: "ready",
    requestId: "export-1",
    filename: "orders-effective-order-20260805T000000Z.csv",
    blob: new Blob(["contract_version,grain\r\norders.effective-order.v3,order\r\n"], {
      type: "text/csv; charset=utf-8",
    }),
    contractVersion: "orders.effective-order.v3",
    grain: "order",
    asOf: "2026-08-05T00:00:00.000Z",
    revisionSha256: "a".repeat(64),
    orderCount: 1,
    rowCount: 1,
  };
}

function effects() {
  return {
    createObjectUrl: vi.fn(() => "blob:export-1"),
    triggerDownload: vi.fn(),
    revokeObjectUrl: vi.fn(),
  };
}

describe("CSV-05 inactive POS effective-order download coordinator", () => {
  it("is disabled by default before validating result or effects", async () => {
    const task = createEffectiveOrderCsvDownloadCoordinatorV3(
      {} as never,
      { kind: "ready" } as never,
    );

    expect(task).toEqual({ enabled: false, status: "disabled" });
  });

  it("rejects malformed effects and forged ready results before side effects", () => {
    expect(() => createEffectiveOrderCsvDownloadCoordinatorV3(
      { config: { enabled: true } } as never,
      ready(),
    )).toThrow(EffectiveOrderCsvDownloadCoordinatorErrorV3);

    const injected = effects();
    const forged = [
      { ...ready(), requestId: " export-1" },
      { ...ready(), filename: "../../orders.csv" },
      { ...ready(), revisionSha256: "weak" },
      { ...ready(), orderCount: 10_001 },
      { ...ready(), rowCount: 2 },
      { ...ready(), blob: new Blob([]) },
    ];
    for (const result of forged) {
      expect(() => createEffectiveOrderCsvDownloadCoordinatorV3(
        { config: { enabled: true }, ...injected },
        result as never,
      )).toThrow(EffectiveOrderCsvDownloadCoordinatorErrorV3);
    }
    expect(injected.createObjectUrl).not.toHaveBeenCalled();
  });

  it("passes through only exact failed and async-required outcomes without effects", async () => {
    const injected = effects();
    const failed = createEffectiveOrderCsvDownloadCoordinatorV3(
      { config: { enabled: true }, ...injected },
      { kind: "failed", requestId: "export-1", message: "Unable to export orders" },
    );
    const asyncRequired = createEffectiveOrderCsvDownloadCoordinatorV3(
      { config: { enabled: true }, ...injected },
      {
        kind: "async_required",
        requestId: "export-2",
        selectedOrderCount: 10_001,
        maximumOrderCount: 10_000,
      },
    );
    if (!failed.enabled || !asyncRequired.enabled) throw new Error("expected enabled tasks");

    await expect(failed.execute()).resolves.toEqual({
      kind: "failed",
      requestId: "export-1",
      message: "Unable to export orders",
    });
    await expect(asyncRequired.execute()).resolves.toEqual({
      kind: "async_required",
      requestId: "export-2",
      selectedOrderCount: 10_001,
      maximumOrderCount: 10_000,
    });
    expect(injected.createObjectUrl).not.toHaveBeenCalled();
    expect(injected.triggerDownload).not.toHaveBeenCalled();
    expect(injected.revokeObjectUrl).not.toHaveBeenCalled();
  });

  it("downloads exact verified metadata and revokes the object URL after success", async () => {
    const order: string[] = [];
    const injected = {
      createObjectUrl: vi.fn(() => {
        order.push("create");
        return "blob:export-1";
      }),
      triggerDownload: vi.fn(async () => {
        order.push("trigger");
      }),
      revokeObjectUrl: vi.fn(() => {
        order.push("revoke");
      }),
    };
    const result = ready();
    const verifiedFilename = result.filename;
    const task = createEffectiveOrderCsvDownloadCoordinatorV3(
      { config: { enabled: true }, ...injected },
      result,
    );
    if (!task.enabled) throw new Error("expected enabled task");
    result.filename = "mutated-after-validation.csv";

    await expect(task.execute()).resolves.toEqual({
      kind: "downloaded",
      requestId: "export-1",
      filename: verifiedFilename,
      grain: "order",
      asOf: result.asOf,
      revisionSha256: result.revisionSha256,
      orderCount: 1,
      rowCount: 1,
    });
    expect(injected.createObjectUrl).toHaveBeenCalledWith(result.blob);
    expect(injected.triggerDownload).toHaveBeenCalledWith({
      objectUrl: "blob:export-1",
      filename: verifiedFilename,
    });
    expect(injected.revokeObjectUrl).toHaveBeenCalledWith("blob:export-1");
    expect(order).toEqual(["create", "trigger", "revoke"]);
  });

  it("sanitizes a trigger failure and still revokes the object URL", async () => {
    const injected = effects();
    injected.triggerDownload.mockRejectedValue(new Error("merchant-b secret"));
    const task = createEffectiveOrderCsvDownloadCoordinatorV3(
      { config: { enabled: true }, ...injected },
      ready(),
    );
    if (!task.enabled) throw new Error("expected enabled task");

    await expect(task.execute()).resolves.toEqual({
      kind: "failed",
      requestId: "export-1",
      message: "Unable to download orders",
    });
    expect(injected.revokeObjectUrl).toHaveBeenCalledWith("blob:export-1");
  });

  it("fails closed for an invalid URL or revoke failure", async () => {
    const invalidUrl = effects();
    invalidUrl.createObjectUrl.mockReturnValue("https://merchant-b.example/export");
    const invalidTask = createEffectiveOrderCsvDownloadCoordinatorV3(
      { config: { enabled: true }, ...invalidUrl },
      ready(),
    );
    if (!invalidTask.enabled) throw new Error("expected enabled task");
    await expect(invalidTask.execute()).resolves.toMatchObject({
      kind: "failed",
      message: "Unable to download orders",
    });
    expect(invalidUrl.triggerDownload).not.toHaveBeenCalled();

    const revokeFailure = effects();
    revokeFailure.revokeObjectUrl.mockImplementation(() => {
      throw new Error("revoke failed");
    });
    const revokeTask = createEffectiveOrderCsvDownloadCoordinatorV3(
      { config: { enabled: true }, ...revokeFailure },
      ready(),
    );
    if (!revokeTask.enabled) throw new Error("expected enabled task");
    await expect(revokeTask.execute()).resolves.toMatchObject({
      kind: "failed",
      message: "Unable to download orders",
    });
  });

  it("is one-shot across concurrent and repeated execute calls", async () => {
    const injected = effects();
    let release!: () => void;
    injected.triggerDownload.mockImplementation(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const task = createEffectiveOrderCsvDownloadCoordinatorV3(
      { config: { enabled: true }, ...injected },
      ready(),
    );
    if (!task.enabled) throw new Error("expected enabled task");

    const first = task.execute();
    const second = task.execute();
    expect(injected.createObjectUrl).toHaveBeenCalledTimes(1);
    expect(injected.triggerDownload).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    await task.execute();
    expect(injected.createObjectUrl).toHaveBeenCalledTimes(1);
    expect(injected.triggerDownload).toHaveBeenCalledTimes(1);
    expect(injected.revokeObjectUrl).toHaveBeenCalledTimes(1);
  });
});
