// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeBuildInfoV2Schema, emptyRuntimeCapabilitySetV1, emptyPaymentFeeCapabilitySetV1 } from "@medusa-snus/contracts/runtime-capabilities";
import { renderTestUi, click, type TestRender } from "../test/reactTestHarness";
const state = vi.hoisted(() => ({ download: vi.fn(), merchantId: "m-a", storeId: "s-a", accessEpoch: "session-a", feeAware: true }));
const build = RuntimeBuildInfoV2Schema.parse({ schemaVersion: 2, service: "medusa", sourceCommit: "a".repeat(40), releaseId: "synthetic-csv-v5",
  compatibilityFamily: "snus-runtime-v1", capabilities: emptyRuntimeCapabilitySetV1(),
  paymentFeeCapabilities: { ...emptyPaymentFeeCapabilitySetV1(), ordersRead: ["v5"], csvRead: ["v5"] } });
vi.mock("../api/endpoints", () => ({ downloadOrderExportCsv: state.download }));
vi.mock("../hooks/useRuntimeCapabilities", () => ({ usePaymentFeeRuntimeBuild: () => state.feeAware ? build : null }));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ operator: { id: "synthetic-manager", role: "manager" } }) }));
vi.mock("../hooks/usePermissions", () => ({ usePermission: () => false }));
vi.mock("../hooks/useProducts", () => ({ useClientOperatingScope: () => ({ operatingMerchantId: state.merchantId, operatingStoreId: state.storeId }) }));
vi.mock("../i18n", () => ({ useI18n: () => ({ t: (value: string) => value }) }));
vi.mock("../hooks/useAppAccessSnapshot", () => ({ useAppAccessSnapshot: () => ({ snapshot: { operatorId: "synthetic-manager", merchantId: state.merchantId,
  storeIds: [state.storeId], permissionIds: ["orders:export"], accessEpoch: state.accessEpoch, capabilityPartition: "synthetic" },
  runtime: { handshakeState: "v2_compatibility", selected: { orderDetail: "v2" }, surfaces: { ordersRead: "v2_compatibility" } } }) }));
vi.mock("../hooks/useOrders", () => ({ useOrders: () => ({}), useEffectiveOrderFeaturePage: () => ({}), useOrderCreatorOptions: () => ({ data: [] }),
  useOrderDetail: () => ({}), useEffectiveOrderFeatureDetail: () => ({}), useManualReviewPaymentIntents: () => ({}),
  useUpdateOrder: () => ({}), useCancelOrder: () => ({}), useRefundOrder: () => ({}), useConfirmManualBankPayment: () => ({}), useOrderCancellationQuote: () => ({}),
}));
vi.mock("../components/CustomerSearch", () => ({ CustomerSearch: () => null }));
vi.mock("../components/OrderCorrectionDrawer", () => ({ OrderCorrectionDrawer: () => null }));
vi.mock("../components/OrderShippingAdjustmentPanel", () => ({ OrderShippingAdjustmentPanel: () => null }));
vi.mock("../components/OrderCancelDialog", () => ({ OrderCancelDialog: () => null }));
vi.mock("../components/OrderRefundDialog", () => ({ OrderRefundDialog: () => null }));
vi.mock("../components/OrderRecreateModal", () => ({ OrderRecreateModal: () => null }));
vi.mock("../components/ManualBankConfirmationDialog", () => ({ ManualBankConfirmationDialog: () => null }));
import OrderHistoryScreen from "./OrderHistoryScreen";
let mounted: TestRender | undefined;
function exportButton() {
  const button = Array.from(mounted!.container.querySelectorAll("button")).find(node => /Xuất CSV/.test(node.textContent || ""));
  if (!button) throw new Error("Export button missing"); return button;
}
afterEach(() => { mounted?.unmount(); mounted = undefined; state.download.mockReset(); state.merchantId = "m-a"; state.storeId = "s-a"; state.accessEpoch = "session-a"; state.feeAware = true; });
describe("mounted fee-aware CSV selection", () => {
  it("captures a V5 request, cancels scope changes and ignores a stale error after a new export", async () => {
    let reject!: (reason: Error) => void;
    state.download.mockReturnValueOnce(new Promise<void>((_, fail) => { reject = fail; })).mockResolvedValueOnce(undefined);
    mounted = renderTestUi(<OrderHistoryScreen />); click(exportButton());
    const options = state.download.mock.calls[0]![1];
    expect(options).toMatchObject({ feeAware: true, scope: { scopeKind: "report", merchantId: "m-a", storeIds: ["s-a"] } });
    expect(options.signal.aborted).toBe(false);
    state.merchantId = "m-b"; state.storeId = "s-b"; mounted.rerender(<OrderHistoryScreen />);
    expect(options.signal.aborted).toBe(true);
    await act(async () => { click(exportButton()); await Promise.resolve(); });
    expect(state.download.mock.calls[1]![1]).toMatchObject({ scope: { merchantId: "m-b", storeIds: ["s-b"] } });
    await act(async () => { reject(new Error("stale export error")); await Promise.resolve(); });
    expect(mounted.container.textContent).not.toContain("stale export error");
  });
  it("cancels an export when the access session changes or the screen unmounts", () => {
    state.download.mockReturnValue(new Promise(() => undefined));
    mounted = renderTestUi(<OrderHistoryScreen />); click(exportButton());
    const first = state.download.mock.calls[0]![1].signal;
    state.accessEpoch = "session-b"; mounted.rerender(<OrderHistoryScreen />);
    expect(first.aborted).toBe(true);
    click(exportButton()); const second = state.download.mock.calls[1]![1].signal;
    mounted.unmount(); mounted = undefined; expect(second.aborted).toBe(true);
  });
});
