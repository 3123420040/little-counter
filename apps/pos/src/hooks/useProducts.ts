import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchProduct, fetchProducts, fetchInventory } from "../api/endpoints";
import {
  ApiError,
  getClientScopeSnapshot,
  SCOPE_CHANGED_EVENT,
} from "../api/client";
import { getBootstrapSnapshot } from "../utils/offlineQueue";
import { buildPartitionedQueryKeyV1 } from "../utils/appAccessSnapshot";
import { useAppAccessSnapshot } from "./useAppAccessSnapshot";

export type ProductQuery = { q?: string; categoryId?: string; categoryHandle?: string; limit?: number };

export function useProducts(query?: ProductQuery, options?: { enabled?: boolean }) {
  const { operatingSnapshot } = useAppAccessSnapshot();

  return useQuery({
    queryKey: operatingSnapshot
      ? buildPartitionedQueryKeyV1(operatingSnapshot, "products", query)
      : ["products", "access-pending", query],
    queryFn: async () => {
      try {
        return await fetchProducts(query);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        const snapshot = await getBootstrapSnapshot(operatingSnapshot);
        if (!snapshot) throw err;
        const term = query?.q?.trim().toLowerCase();
        const categoryId = query?.categoryId;
        const categoryHandle = query?.categoryHandle?.toLowerCase();
        return snapshot.products.filter((product) => {
          const matchesCategory = !categoryId && !categoryHandle
            ? true
            : (product.categories || []).some((category) =>
                (categoryId && category.id === categoryId)
                || (categoryHandle && category.handle?.toLowerCase() === categoryHandle),
              );
          if (!matchesCategory) return false;
          if (!term) return true;
          return product.title.toLowerCase().includes(term)
            || product.variants?.some((variant) => variant.sku?.toLowerCase().includes(term)
              || variant.barcode?.toLowerCase().includes(term));
        });
      }
    },
    enabled: Boolean(operatingSnapshot) && (options?.enabled ?? true),
    staleTime: 20_000,
  });
}

function readClientOperatingScope() {
  return getClientScopeSnapshot();
}

export function useClientOperatingScope() {
  const [scope, setScope] = useState(readClientOperatingScope);

  useEffect(() => {
    const updateScope = () => setScope(readClientOperatingScope());
    updateScope();
    window.addEventListener(SCOPE_CHANGED_EVENT, updateScope);
    window.addEventListener("storage", updateScope);
    return () => {
      window.removeEventListener(SCOPE_CHANGED_EVENT, updateScope);
      window.removeEventListener("storage", updateScope);
    };
  }, []);

  return scope;
}

export function useProduct(id: string) {
  const { operatingSnapshot } = useAppAccessSnapshot();
  return useQuery({
    queryKey: operatingSnapshot
      ? buildPartitionedQueryKeyV1(operatingSnapshot, "product", id)
      : ["product", "access-pending", id],
    queryFn: () => fetchProduct(id),
    enabled: Boolean(operatingSnapshot) && !!id,
  });
}

export function useInventory() {
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
