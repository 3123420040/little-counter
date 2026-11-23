import { useQuery } from "@tanstack/react-query";
import { CartPaymentFeePreviewInputV1Schema } from "@medusa-snus/contracts";
import { previewCartPaymentFeeV1 } from "../api/endpoints";
import { buildPartitionedQueryKeyV1 } from "../utils/appAccessSnapshot";
import { useAppAccessSnapshot } from "./useAppAccessSnapshot";
import { usePaymentFeeRuntimeBuild } from "./useRuntimeCapabilities";

export function useCartPaymentFeePreview(input: unknown, enabled = true) {
  const { operatingSnapshot } = useAppAccessSnapshot();
  const build = usePaymentFeeRuntimeBuild();
  const compatible = build?.paymentFeeCapabilities.paymentFeeWrite.includes("v1") === true;
  const parsed = CartPaymentFeePreviewInputV1Schema.safeParse(input);
  const available = enabled && compatible && Boolean(operatingSnapshot) && parsed.success;
  const query = useQuery({
    queryKey: operatingSnapshot ? buildPartitionedQueryKeyV1(operatingSnapshot, "cartPaymentFeePreviewV1", {
      input: parsed.success ? parsed.data : null, compatible, sourceCommit: build?.sourceCommit, releaseId: build?.releaseId,
    }) : ["cartPaymentFeePreviewV1", "access-pending"],
    queryFn: ({ signal }) => {
      if (!operatingSnapshot || !parsed.success || !compatible) throw new Error("Bản tính phụ phí chưa sẵn sàng.");
      return previewCartPaymentFeeV1(parsed.data, { merchantId: operatingSnapshot.merchantId, storeId: operatingSnapshot.storeIds[0]! }, signal);
    },
    enabled: available, staleTime: 0, retry: false,
  });
  return { ...query, compatible, canConfirm: available && query.isSuccess && !query.isFetching,
    inputError: input !== null && !parsed.success ? "Kiểm tra số lượng, giảm giá, giao hàng và phụ phí." : null };
}
