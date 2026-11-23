import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createAdminProduct,
  fetchAdminProducts,
  fetchProduct,
  updateAdminProduct,
  type ProductMutationInput,
} from "../api/endpoints";
import { refreshBootstrapSnapshot } from "../utils/offlineBootstrapScope";
import { buildPartitionedQueryKeyV1, type AppAccessSnapshotV1 } from "../utils/appAccessSnapshot";
import { useAppAccessSnapshot } from "./useAppAccessSnapshot";

async function invalidateCatalog(qc: ReturnType<typeof useQueryClient>, access: AppAccessSnapshotV1 | null) {
  await Promise.all([
    qc.invalidateQueries({ queryKey: ["adminProducts"] }),
    qc.invalidateQueries({ queryKey: ["product"] }),
    qc.invalidateQueries({ queryKey: ["products"] }),
    qc.invalidateQueries({ queryKey: ["inventory"] }),
    qc.invalidateQueries({ queryKey: ["productCategories"] }),
  ]);
  await refreshBootstrapSnapshot(access);
}

export function useAdminProducts(filters?: { q?: string; status?: string; categoryId?: string; limit?: number; offset?: number }) {
  const { operatingSnapshot } = useAppAccessSnapshot();
  return useQuery({
    queryKey: operatingSnapshot
      ? buildPartitionedQueryKeyV1(operatingSnapshot, "adminProducts", filters)
      : ["adminProducts", "access-pending", filters],
    queryFn: () => fetchAdminProducts(filters),
    enabled: Boolean(operatingSnapshot),
    staleTime: 20_000,
  });
}

export function useAdminProduct(id: string | null) {
  const { operatingSnapshot } = useAppAccessSnapshot();
  return useQuery({
    queryKey: operatingSnapshot
      ? buildPartitionedQueryKeyV1(operatingSnapshot, "product", id)
      : ["product", "access-pending", id],
    queryFn: () => fetchProduct(id!),
    enabled: Boolean(operatingSnapshot) && !!id,
  });
}

export function useCreateAdminProduct() {
  const qc = useQueryClient();
  const { operatingSnapshot } = useAppAccessSnapshot();
  return useMutation({
    mutationFn: (input: ProductMutationInput) => createAdminProduct(input),
    onSuccess: async () => {
      await invalidateCatalog(qc, operatingSnapshot);
    },
  });
}

export function useUpdateAdminProduct() {
  const qc = useQueryClient();
  const { operatingSnapshot } = useAppAccessSnapshot();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ProductMutationInput }) =>
      updateAdminProduct(id, input),
    onSuccess: async () => {
      await invalidateCatalog(qc, operatingSnapshot);
    },
  });
}
