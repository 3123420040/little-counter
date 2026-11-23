import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createProductCategory,
  deleteProductCategory,
  fetchProductCategories,
  updateProductCategory,
  type ProductCategoryMutationInput,
} from "../api/endpoints";
import { refreshBootstrapSnapshot } from "../utils/offlineBootstrapScope";
import { buildPartitionedQueryKeyV1, type AppAccessSnapshotV1 } from "../utils/appAccessSnapshot";
import { useAppAccessSnapshot } from "./useAppAccessSnapshot";

async function invalidateCatalog(qc: ReturnType<typeof useQueryClient>, access: AppAccessSnapshotV1 | null) {
  await Promise.all([
    qc.invalidateQueries({ queryKey: ["productCategories"] }),
    qc.invalidateQueries({ queryKey: ["adminProducts"] }),
    qc.invalidateQueries({ queryKey: ["products"] }),
    qc.invalidateQueries({ queryKey: ["inventory"] }),
  ]);
  await refreshBootstrapSnapshot(access);
}

export function useProductCategories(filters?: {
  q?: string;
  status?: string;
  includeProductCounts?: boolean;
  limit?: number;
  offset?: number;
}) {
  const { operatingSnapshot } = useAppAccessSnapshot();
  return useQuery({
    queryKey: operatingSnapshot
      ? buildPartitionedQueryKeyV1(operatingSnapshot, "productCategories", filters)
      : ["productCategories", "access-pending", filters],
    queryFn: () => fetchProductCategories(filters),
    enabled: Boolean(operatingSnapshot),
    staleTime: 20_000,
  });
}

export function useCreateProductCategory() {
  const qc = useQueryClient();
  const { operatingSnapshot } = useAppAccessSnapshot();
  return useMutation({
    mutationFn: (input: ProductCategoryMutationInput) => createProductCategory(input),
    onSuccess: async () => {
      await invalidateCatalog(qc, operatingSnapshot);
    },
  });
}

export function useUpdateProductCategory() {
  const qc = useQueryClient();
  const { operatingSnapshot } = useAppAccessSnapshot();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ProductCategoryMutationInput }) =>
      updateProductCategory(id, input),
    onSuccess: async () => {
      await invalidateCatalog(qc, operatingSnapshot);
    },
  });
}

export function useDeleteProductCategory() {
  const qc = useQueryClient();
  const { operatingSnapshot } = useAppAccessSnapshot();
  return useMutation({
    mutationFn: (id: string) => deleteProductCategory(id),
    onSuccess: async () => {
      await invalidateCatalog(qc, operatingSnapshot);
    },
  });
}
