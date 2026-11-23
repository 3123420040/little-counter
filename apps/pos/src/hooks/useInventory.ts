import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchInventory,
  adjustStock,
  fetchStockMovements,
  createPurchaseOrder,
  fetchPurchaseOrders,
  fetchPurchaseOrderDetail,
  receivePurchaseOrder,
  sendPurchaseOrder,
  cancelPurchaseOrder,
  closeShortPurchaseOrder,
  fetchPurchaseOrderCatalog,
  fetchAiAlerts,
} from "../api/endpoints";
import type { StockMovementFilters } from "../api/client";
import { buildPartitionedQueryKeyV1 } from "../utils/appAccessSnapshot";
import { useAppAccessSnapshot } from "./useAppAccessSnapshot";

export function useInventoryData() {
  const { operatingSnapshot } = useAppAccessSnapshot();
  return useQuery({
    queryKey: operatingSnapshot
      ? buildPartitionedQueryKeyV1(operatingSnapshot, "inventory")
      : ["inventory", "access-pending"],
    queryFn: fetchInventory,
    enabled: Boolean(operatingSnapshot),
    refetchInterval: 30_000,
  });
}

export function useInventoryAlerts() {
  const { operatingSnapshot } = useAppAccessSnapshot();
  return useQuery({
    queryKey: operatingSnapshot
      ? buildPartitionedQueryKeyV1(operatingSnapshot, "aiAlerts")
      : ["aiAlerts", "access-pending"],
    queryFn: fetchAiAlerts,
    enabled: Boolean(operatingSnapshot),
    refetchInterval: 20_000,
  });
}

export function useAdjustStock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: adjustStock,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inventory"] }),
  });
}

export function useStockMovements(filtersOrProductId?: string | StockMovementFilters) {
  return useQuery({
    queryKey: ["stockMovements", filtersOrProductId],
    queryFn: () => fetchStockMovements(filtersOrProductId),
  });
}

export function usePurchaseOrders() {
  return useQuery({
    queryKey: ["purchaseOrders"],
    queryFn: fetchPurchaseOrders,
  });
}

export function usePurchaseOrderCatalog(filters: {
  q?: string;
  limit?: number;
  offset?: number;
  selectedVariantIds?: string[];
}) {
  return useQuery({
    queryKey: [
      "purchaseOrderCatalog",
      filters.q || "",
      filters.limit || 25,
      filters.offset || 0,
      [...(filters.selectedVariantIds || [])].sort().join(","),
    ],
    queryFn: () => fetchPurchaseOrderCatalog(filters),
    staleTime: 20_000,
  });
}

export function usePurchaseOrderDetail(poId?: string, receiptPage = 1, receiptLimit = 10) {
  const receiptOffset = Math.max(0, receiptPage - 1) * receiptLimit;
  return useQuery({
    queryKey: ["purchaseOrder", poId, "receipts", receiptLimit, receiptOffset],
    queryFn: () => fetchPurchaseOrderDetail(poId!, { receiptLimit, receiptOffset }),
    enabled: !!poId,
  });
}

export function useCreatePurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ data, intentKey }: {
      data: Parameters<typeof createPurchaseOrder>[0];
      intentKey: string;
    }) => createPurchaseOrder(data, intentKey),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["purchaseOrders"] }),
  });
}

export function useReceivePurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ poId, data, intentKey }: { poId: string; data: { note?: string; items: Array<{ purchaseOrderItemId: string; receivedQuantity: number }> }; intentKey: string }) =>
      receivePurchaseOrder(poId, data, intentKey),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["purchaseOrders"] });
      qc.invalidateQueries({ queryKey: ["purchaseOrder", variables.poId] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

function invalidatePurchaseOrderMutation(qc: ReturnType<typeof useQueryClient>, poId: string) {
  qc.invalidateQueries({ queryKey: ["purchaseOrders"] });
  qc.invalidateQueries({ queryKey: ["purchaseOrder", poId] });
}

export function useSendPurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ poId, data }: { poId: string; data: { note?: string } }) => sendPurchaseOrder(poId, data),
    onSuccess: (_data, variables) => invalidatePurchaseOrderMutation(qc, variables.poId),
  });
}

export function useCancelPurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ poId, data }: { poId: string; data: { reason: string } }) => cancelPurchaseOrder(poId, data),
    onSuccess: (_data, variables) => invalidatePurchaseOrderMutation(qc, variables.poId),
  });
}

export function useCloseShortPurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ poId, data }: { poId: string; data: { reason: string } }) => closeShortPurchaseOrder(poId, data),
    onSuccess: (_data, variables) => invalidatePurchaseOrderMutation(qc, variables.poId),
  });
}
