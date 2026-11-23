import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createCustomer, deleteCustomer, fetchCustomer, fetchCustomerLoyalty, fetchCustomers, fetchOrders, mergeCustomers, updateCustomer } from "../api/endpoints";
import { ApiError } from "../api/client";
import { getBootstrapSnapshot } from "../utils/offlineQueue";
import { refreshBootstrapSnapshot } from "../utils/offlineBootstrapScope";
import { buildPartitionedQueryKeyV1, type AppAccessSnapshotV1 } from "../utils/appAccessSnapshot";
import { useAppAccessSnapshot } from "./useAppAccessSnapshot";

async function invalidateCustomers(qc: ReturnType<typeof useQueryClient>, access: AppAccessSnapshotV1 | null) {
  await Promise.all([
    qc.invalidateQueries({ queryKey: ["customers"] }),
    qc.invalidateQueries({ queryKey: ["customer"] }),
    qc.invalidateQueries({ queryKey: ["orders"] }),
    qc.invalidateQueries({ queryKey: ["loyalty"] }),
  ]);
  await refreshBootstrapSnapshot(access);
}

export function useCustomers(query?: string) {
  const { operatingSnapshot } = useAppAccessSnapshot();
  return useQuery({
    queryKey: operatingSnapshot
      ? buildPartitionedQueryKeyV1(operatingSnapshot, "customers", query)
      : ["customers", "access-pending", query],
    queryFn: async () => {
      try {
        return await fetchCustomers(query);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        const snapshot = await getBootstrapSnapshot(operatingSnapshot);
        if (!snapshot) throw err;
        const term = query?.trim().toLowerCase();
        if (!term) return snapshot.customers;
        return snapshot.customers.filter((customer) => (
          customer.phone?.toLowerCase().includes(term)
          || customer.first_name?.toLowerCase().includes(term)
          || customer.last_name?.toLowerCase().includes(term)
          || customer.email?.toLowerCase().includes(term)
        ));
      }
    },
    enabled: Boolean(operatingSnapshot) && ((query?.length ?? 0) >= 3 || !query),
  });
}

export function useCustomer(customerId: string | null) {
  const { operatingSnapshot } = useAppAccessSnapshot();
  return useQuery({
    queryKey: operatingSnapshot
      ? buildPartitionedQueryKeyV1(operatingSnapshot, "customer", customerId)
      : ["customer", "access-pending", customerId],
    queryFn: async () => (await fetchCustomer(customerId!)).customer,
    enabled: Boolean(operatingSnapshot) && !!customerId,
  });
}

export function useCreateCustomer() {
  const qc = useQueryClient();
  const { operatingSnapshot } = useAppAccessSnapshot();
  return useMutation({
    mutationFn: (data: { phone: string; firstName: string; lastName: string; email?: string }) =>
      createCustomer({ phone: data.phone, first_name: data.firstName, last_name: data.lastName, email: data.email }),
    onSuccess: async () => {
      await invalidateCustomers(qc, operatingSnapshot);
    },
  });
}

export function useUpdateCustomer() {
  const qc = useQueryClient();
  const { operatingSnapshot } = useAppAccessSnapshot();
  return useMutation({
    mutationFn: (data: { id: string; phone?: string; firstName?: string; lastName?: string; email?: string }) =>
      updateCustomer(data.id, {
        phone: data.phone,
        first_name: data.firstName,
        last_name: data.lastName,
        email: data.email,
      }),
    onSuccess: async () => {
      await invalidateCustomers(qc, operatingSnapshot);
    },
  });
}

export function useDeleteCustomer() {
  const qc = useQueryClient();
  const { operatingSnapshot } = useAppAccessSnapshot();
  return useMutation({
    mutationFn: (id: string) => deleteCustomer(id),
    onSuccess: async () => {
      await invalidateCustomers(qc, operatingSnapshot);
    },
  });
}

export function useCustomerLoyalty(customerId: string | null) {
  const { operatingSnapshot } = useAppAccessSnapshot();
  return useQuery({
    queryKey: operatingSnapshot
      ? buildPartitionedQueryKeyV1(operatingSnapshot, "loyalty", customerId)
      : ["loyalty", "access-pending", customerId],
    queryFn: () => fetchCustomerLoyalty(customerId!),
    enabled: Boolean(operatingSnapshot) && !!customerId,
  });
}

export function useCustomerOrders(customerId: string | null) {
  const { operatingSnapshot } = useAppAccessSnapshot();
  return useQuery({
    queryKey: operatingSnapshot
      ? buildPartitionedQueryKeyV1(operatingSnapshot, "orders", customerId)
      : ["orders", "access-pending", customerId],
    queryFn: () => fetchOrders({ customerId: customerId!, limit: 20 }),
    enabled: Boolean(operatingSnapshot) && !!customerId,
  });
}

export function useMergeCustomers() {
  const qc = useQueryClient();
  const { operatingSnapshot } = useAppAccessSnapshot();
  return useMutation({
    mutationFn: (data: { primaryId: string; duplicateId: string }) => mergeCustomers(data.primaryId, data.duplicateId),
    onSuccess: async () => {
      await invalidateCustomers(qc, operatingSnapshot);
    },
  });
}
