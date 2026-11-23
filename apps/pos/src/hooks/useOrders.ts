import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  applyOrderCorrection,
  applyOrderCorrectionFinancialV1,
  previewOrderCorrectionFinancialV1,
  fetchOrderCorrectionFinancialContextV1,
  cancelOrderWithConfirmation,
  confirmManualBankPayment,
  fetchOrderCancellationQuote,
  fetchOrderRecreatePrefill,
  fetchEffectiveOrderFeatureRecreatePrefill,
  fetchEffectiveOrderFeatureRecreatePrefillV3,
  fetchOrders,
  fetchOrderDetail,
  fetchOrderOperationalDetailV1,
  fetchEffectiveOrderFeatureDetail,
  fetchEffectiveOrderFeatureDetailV3,
  fetchEffectiveOrderFeaturePage,
  fetchEffectiveOrderFeaturePageV5,
  fetchOrderCreatorOptions,
  fetchPaymentIntents,
  fetchPaymentIntentsFinancialV1,
  previewOrderCorrection,
  previewOrderShipping,
  refundOrderWithEvidence,
  updateOrder,
  updateOrderCustomer,
  updateOrderShipping,
  type OrderCorrectionInput,
  type OrderCorrectionPreview,
  type OrderShippingAdjustmentInput,
  type RefundOrderWithEvidenceInput,
  type OrderRecreatePrefill,
} from "../api/endpoints";
import { ORDER_FINANCIAL_FEATURE_UI_DEFAULT_CONFIG_V1 } from "../config/orderFinancialFeature";
import { orderFinancialMutationQueryKeys } from "../utils/scopeQueryInvalidation";
import { buildPartitionedQueryKeyV1 } from "../utils/appAccessSnapshot";
import { useAppAccessSnapshot } from "./useAppAccessSnapshot";
import { useClientOperatingScope } from "./useProducts";
import { usePaymentFeeRuntimeBuild } from "./useRuntimeCapabilities";
import type { OrderCorrectionFinancialPreviewV1 } from "@medusa-snus/contracts";

function invalidateOrderFinancialQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  orderId: string,
) {
  return Promise.all(
    orderFinancialMutationQueryKeys(orderId).map((queryKey) =>
      queryClient.invalidateQueries({ queryKey }),
    ),
  );
}

export function useOrders(
  filters?: { dateFrom?: string; dateTo?: string; limit?: number },
  enabled = true,
) {
  const { snapshot } = useAppAccessSnapshot();
  return useQuery({
    queryKey: snapshot ? buildPartitionedQueryKeyV1(snapshot, "orders", filters) : ["orders", "access-pending", filters],
    queryFn: () => fetchOrders(filters),
    refetchInterval: 30_000,
    enabled: enabled && Boolean(snapshot),
  });
}

export function useEffectiveOrderFeaturePage(input: {
  from: string;
  to: string;
  search?: string;
  status: "all" | "completed" | "other";
  creatorOperatorIds?: readonly string[];
  limit?: number;
}) {
  const { snapshot, runtime } = useAppAccessSnapshot();
  const feeBuild = usePaymentFeeRuntimeBuild();
  const feeAware = feeBuild?.paymentFeeCapabilities.ordersRead.includes("v5") === true;
  const namespace = feeAware ? "ordersEffectivePageV5" : "ordersEffectivePageV4";
  const query = useInfiniteQuery({
    queryKey: snapshot
      ? buildPartitionedQueryKeyV1(snapshot, namespace, feeAware && feeBuild ? { ...input, sourceCommit: feeBuild.sourceCommit, releaseId: feeBuild.releaseId } : input)
      : [namespace, "access-pending", input],
    queryFn: async ({ pageParam, signal }) => {
      const request = { ...input, ...(pageParam ? { cursor: pageParam } : {}) };
      if (!feeAware) return fetchEffectiveOrderFeaturePage(request);
      if (!snapshot) throw new Error("Phạm vi xem đơn chưa sẵn sàng.");
      return fetchEffectiveOrderFeaturePageV5(request, { scopeKind: "report", merchantId: snapshot.merchantId, storeIds: [...snapshot.storeIds] }, signal);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.pagination.nextCursor || undefined,
    enabled: Boolean(snapshot) && (feeAware || runtime.surfaces.ordersRead === "v4"),
    refetchInterval: 30_000,
  });
  return { ...query, contractVersion: feeAware ? "v5" as const : "v4" as const };
}

export function useOrderCreatorOptions(enabled = true) {
  const { snapshot, runtime } = useAppAccessSnapshot();
  const feeBuild = usePaymentFeeRuntimeBuild();
  return useQuery({
    queryKey: snapshot
      ? buildPartitionedQueryKeyV1(snapshot, "orderCreatorOptionsV1")
      : ["orderCreatorOptionsV1", "access-pending"],
    queryFn: ({ signal }) => {
      if (!snapshot) throw new Error("Phạm vi cửa hàng chưa sẵn sàng.");
      return fetchOrderCreatorOptions({ scopeKind: "report", merchantId: snapshot.merchantId, storeIds: [...snapshot.storeIds] }, signal);
    },
    enabled: enabled && Boolean(snapshot) && (runtime.surfaces.ordersRead === "v4" || feeBuild?.paymentFeeCapabilities.ordersRead.includes("v5") === true),
    staleTime: 60_000,
  });
}

export function useOrderDetail(id: string | null) {
  const { snapshot } = useAppAccessSnapshot();
  const scope = useClientOperatingScope();
  const feeBuild = usePaymentFeeRuntimeBuild();
  const feeAware = feeBuild?.paymentFeeCapabilities.orderDetail.includes("v3") === true;
  return useQuery({
    queryKey: snapshot ? ["order", id, ...buildPartitionedQueryKeyV1(snapshot, feeAware ? "operationalDetailV1" : "operationalDetail"),
      scope.operatingMerchantId, scope.operatingStoreId, feeBuild?.sourceCommit, feeBuild?.releaseId] : ["order", id, "access-pending"],
    queryFn: ({ signal }) => {
      if (!snapshot) throw new Error("Phạm vi cửa hàng chưa sẵn sàng.");
      return feeAware ? fetchOrderOperationalDetailV1(id!, { merchantId: snapshot.merchantId, storeIds: [...snapshot.storeIds] }, signal)
        : fetchOrderDetail(id!);
    },
    enabled: !!id && Boolean(snapshot),
  });
}

export function useEffectiveOrderFeatureDetail(id: string | null) {
  const { snapshot, runtime } = useAppAccessSnapshot();
  const feeBuild = usePaymentFeeRuntimeBuild();
  const feeAware = feeBuild?.paymentFeeCapabilities.orderDetail.includes("v3") === true;
  const namespace = feeAware ? "orderEffectiveDetailV3" : "orderEffectiveDetailV2";
  const query = useQuery({
    queryKey: snapshot
      ? buildPartitionedQueryKeyV1(snapshot, namespace, feeAware && feeBuild ? { id, sourceCommit: feeBuild.sourceCommit, releaseId: feeBuild.releaseId } : id)
      : [namespace, "access-pending", id],
    queryFn: async () => feeAware ? fetchEffectiveOrderFeatureDetailV3(id!) : fetchEffectiveOrderFeatureDetail(id!),
    enabled: Boolean(snapshot) && (feeAware || runtime.selected.orderDetail === "v2") && !!id,
    staleTime: 0,
  });
  return { ...query, contractVersion: feeAware ? "v3" as const : "v2" as const };
}

export function useManualReviewPaymentIntents(
  enabled = true,
  page: { limit?: number; offset?: number } = {},
) {
  const { snapshot } = useAppAccessSnapshot();
  const feeBuild = usePaymentFeeRuntimeBuild();
  const feeAware = feeBuild?.paymentFeeCapabilities.ordersRead.includes("v5") === true;
  const filters = { status: "manual_review" as const, limit: page.limit || 20, offset: page.offset || 0 };
  return useQuery({
    queryKey: snapshot ? buildPartitionedQueryKeyV1(snapshot, "paymentIntents", { ...filters,
      contract: feeAware ? "financial-v1" : "legacy", sourceCommit: feeBuild?.sourceCommit, releaseId: feeBuild?.releaseId,
    }) : ["paymentIntents", "access-pending", filters],
    queryFn: ({ signal }) => {
      if (!snapshot) throw new Error("Phạm vi cửa hàng chưa sẵn sàng.");
      return feeAware ? fetchPaymentIntentsFinancialV1(filters, { scopeKind: "report", merchantId: snapshot.merchantId, storeIds: [...snapshot.storeIds] }, signal)
        : fetchPaymentIntents(filters);
    },
    refetchInterval: 30_000,
    enabled: enabled && Boolean(snapshot),
  });
}

export function useUpdateOrderCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, customerId }: { orderId: string; customerId: string | null }) =>
      updateOrderCustomer(orderId, customerId),
    onSuccess: (_data, variables) => invalidateOrderFinancialQueries(qc, variables.orderId),
  });
}

export function useUpdateOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, input }: { orderId: string; input: { customerId?: string | null; notes?: string | null; salesChannel?: string | null } }) =>
      updateOrder(orderId, input),
    onSuccess: (_data, variables) => invalidateOrderFinancialQueries(qc, variables.orderId),
  });
}

export function useUpdateOrderShipping() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      orderId,
      input,
    }: {
      orderId: string;
      input: OrderShippingAdjustmentInput & { confirmationToken: string };
    }) => updateOrderShipping(orderId, input),
    onSuccess: (_data, variables) => invalidateOrderFinancialQueries(qc, variables.orderId),
  });
}

export function usePreviewOrderShipping() {
  return useMutation({
    mutationFn: ({ orderId, input }: { orderId: string; input: OrderShippingAdjustmentInput }) =>
      previewOrderShipping(orderId, input),
  });
}

export function useConfirmManualBankPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, input, intentKey }: {
      orderId: string;
      input: { sourceReference: string; confirmedAt: string };
      intentKey: string;
    }) => confirmManualBankPayment(orderId, input, intentKey),
    onSuccess: (_data, variables) => invalidateOrderFinancialQueries(qc, variables.orderId),
  });
}

type CorrectionTransport = { financial: boolean; scope: { merchantId: string; storeId: string } | null };

export function useOrderCorrectionFinancialContext(orderId: string | null, enabled: boolean) {
  const { operatingSnapshot } = useAppAccessSnapshot();
  const build = usePaymentFeeRuntimeBuild();
  const financial = build?.paymentFeeCapabilities.paymentFeeWrite.includes("v1") === true;
  const scope = operatingSnapshot ? { merchantId: operatingSnapshot.merchantId, storeId: operatingSnapshot.storeIds[0]! } : null;
  const queryKey = operatingSnapshot ? buildPartitionedQueryKeyV1(operatingSnapshot, "orderCorrectionContextV1", {
    orderId, sourceCommit: build?.sourceCommit, releaseId: build?.releaseId,
  }) : ["orderCorrectionContextV1", "access-pending"];
  const query = useQuery({ queryKey, enabled: enabled && financial && Boolean(orderId && scope), retry: false, staleTime: 0,
    queryFn: ({ signal }) => {
      if (!orderId || !scope) throw new Error("Chưa có phạm vi cửa hàng để điều chỉnh.");
      return fetchOrderCorrectionFinancialContextV1(orderId, scope, signal);
    },
  });
  return { ...query, financial, scope, partition: JSON.stringify(queryKey) };
}

export function usePreviewOrderCorrection(transport?: CorrectionTransport) {
  return useMutation({
    mutationFn: ({ orderId, input }: { orderId: string; input: OrderCorrectionInput }): Promise<OrderCorrectionPreview | OrderCorrectionFinancialPreviewV1> => {
      if (!transport?.financial) return previewOrderCorrection(orderId, input);
      if (!transport.scope) throw new Error("Chưa có phạm vi cửa hàng để điều chỉnh.");
      return previewOrderCorrectionFinancialV1(orderId, input, transport.scope);
    },
  });
}

export function useApplyOrderCorrection(transport?: CorrectionTransport) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, input, intentKey, confirmation }: { orderId: string; input: OrderCorrectionInput; intentKey?: string; confirmation?: unknown }) => {
      if (!transport?.financial) return applyOrderCorrection(orderId, input);
      if (!transport.scope) throw new Error("Chưa có phạm vi cửa hàng để điều chỉnh.");
      return applyOrderCorrectionFinancialV1(orderId, input, intentKey ?? "", transport.scope, confirmation);
    },
    onSuccess: async (_data, variables) => {
      await Promise.all([
        ...orderFinancialMutationQueryKeys(variables.orderId).map((queryKey) =>
          qc.invalidateQueries({ queryKey }),
        ),
        qc.invalidateQueries({ queryKey: ["inventory"] }),
      ]);
    },
  });
}


export function useCancelOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, reason, quote }: {
      orderId: string;
      reason: string;
      quote: Parameters<typeof cancelOrderWithConfirmation>[2];
    }) => cancelOrderWithConfirmation(orderId, reason, quote),
    onSuccess: async (_data, variables) => {
      // Cancel may change order status, stock and accounting aggregates.
      // Refresh every cache that depends on those facts without refetching
      // unrelated product catalog data.
      await Promise.all([
        ...orderFinancialMutationQueryKeys(variables.orderId).map((queryKey) =>
          qc.invalidateQueries({ queryKey }),
        ),
        qc.invalidateQueries({ queryKey: ["inventory"] }),
        qc.invalidateQueries({ queryKey: ["products"] }),
        qc.invalidateQueries({ queryKey: ["stockMovements"] }),
      ]);
    },
  });
}

export function useRefundOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      orderId,
      input,
      intentKey,
    }: {
      orderId: string;
      input: RefundOrderWithEvidenceInput;
      intentKey: string;
    }) => refundOrderWithEvidence(orderId, input, intentKey),
    onSuccess: async (_data, variables) => {
      // A payout changes canonical payment flow, customer payable, detail/list,
      // dashboard and accounting, but must not restock inventory again.
      await Promise.all([
        ...orderFinancialMutationQueryKeys(variables.orderId).map((queryKey) =>
          qc.invalidateQueries({ queryKey }),
        ),
        qc.invalidateQueries({ queryKey: ["customerRefundPayables"] }),
      ]);
    },
  });
}

export function useOrderCancellationQuote(orderId: string | null, enabled: boolean) {
  const { snapshot } = useAppAccessSnapshot();
  const scope = useClientOperatingScope();
  return useQuery({
    queryKey: snapshot ? ["order", orderId, "cancellation-quote", ...buildPartitionedQueryKeyV1(snapshot, "cancellationQuote"), scope.operatingMerchantId, scope.operatingStoreId] : ["order", orderId, "access-pending"],
    queryFn: () => fetchOrderCancellationQuote(orderId!),
    enabled: enabled && !!orderId && Boolean(snapshot),
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
}

export function useOrderRecreatePrefill(orderId: string | null) {
  const { operatingSnapshot: snapshot, runtime } = useAppAccessSnapshot();
  const feeBuild = usePaymentFeeRuntimeBuild();
  const feeAware = feeBuild?.paymentFeeCapabilities.orderRecreate.includes("v3") === true;
  const namespace = feeAware ? "orderRecreatePrefillV3" : "orderRecreatePrefillV2";
  return useQuery<OrderRecreatePrefill | null>({
    queryKey: snapshot
      ? buildPartitionedQueryKeyV1(snapshot, namespace, feeAware && feeBuild ? { orderId, sourceCommit: feeBuild.sourceCommit, releaseId: feeBuild.releaseId } : orderId)
      : [namespace, "access-pending", orderId],
    queryFn: async ({ signal }) => {
      if (!orderId || !snapshot) return null;
      if (feeAware) return (await fetchEffectiveOrderFeatureRecreatePrefillV3(orderId,
        { merchantId: snapshot.merchantId, storeId: snapshot.storeIds[0]! }, signal)).prefill;
      const result = runtime.surfaces.orderRecreateCustomerPrefill === "enabled"
        ? await fetchEffectiveOrderFeatureRecreatePrefill(orderId)
        : await fetchOrderRecreatePrefill(orderId);
      return result.prefill;
    },
    enabled: Boolean(snapshot) && (feeAware || runtime.surfaces.orderRecreate === "enabled") && !!orderId,
    staleTime: 0,
  });
}
