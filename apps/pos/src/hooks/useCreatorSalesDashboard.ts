import { useQuery } from "@tanstack/react-query";
import type { CreatorSalesDashboardV2, CreatorSalesDashboardV3 } from "@medusa-snus/contracts";
import { fetchCreatorSalesDashboardV2, fetchCreatorSalesDashboardV3 } from "../api/endpoints";
import { buildPartitionedQueryKeyV1 } from "../utils/appAccessSnapshot";
import { useAppAccessSnapshot } from "./useAppAccessSnapshot";
import { usePaymentFeeRuntimeBuild } from "./useRuntimeCapabilities";

export function useCreatorSalesDashboard(input: Parameters<typeof fetchCreatorSalesDashboardV2>[0], enabled: boolean) {
  const { snapshot, runtime } = useAppAccessSnapshot(), build = usePaymentFeeRuntimeBuild();
  const feeAware = build?.paymentFeeCapabilities.dashboardRead.includes("v3") === true;
  const family = feeAware ? "dashboardCreatorSalesV3" : "dashboardCreatorSalesV2";
  const query = useQuery<CreatorSalesDashboardV2 | CreatorSalesDashboardV3>({
    queryKey: snapshot ? buildPartitionedQueryKeyV1(snapshot, family, { ...input,
      ...(feeAware ? { sourceCommit: build.sourceCommit, releaseId: build.releaseId } : {}) }) : [family, "access-pending", input],
    enabled: enabled && Boolean(snapshot) && (feeAware || runtime.selected.dashboardRead === "v2"),
    queryFn: ({ signal }) => {
      if (!snapshot) throw new Error("Dashboard access snapshot is unavailable");
      return feeAware ? fetchCreatorSalesDashboardV3(input, { scopeKind: "report", merchantId: snapshot.merchantId, storeIds: [...snapshot.storeIds] }, snapshot.operatorId, signal)
        : fetchCreatorSalesDashboardV2(input);
    },
    refetchInterval: 60_000,
  });
  return { ...query, feeAware };
}
