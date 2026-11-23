import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getClientScopeSnapshot, SCOPE_CHANGED_EVENT } from "../api/client";
import { fetchMe } from "../api/settings-endpoints";
import {
  buildAppAccessSnapshotV1,
  isAppAccessPartitionedQueryKeyV1,
  withOperatingScopeAccessSnapshotV1,
} from "../utils/appAccessSnapshot";
import { useAuth } from "./useAuth";
import { useRuntimeCapabilities } from "./useRuntimeCapabilities";

export function useAppAccessSnapshot() {
  const { operator } = useAuth();
  const queryClient = useQueryClient();
  const runtime = useRuntimeCapabilities();
  const [scopeRevision, setScopeRevision] = useState(0);
  const me = useQuery({
    queryKey: ["me", operator?.id],
    queryFn: fetchMe,
    enabled: Boolean(operator?.id),
    staleTime: 60_000,
  });
  useEffect(() => {
    const changed = () => {
      setScopeRevision((value) => value + 1);
      void queryClient.cancelQueries({
        predicate: (query) => isAppAccessPartitionedQueryKeyV1(query.queryKey),
      });
      queryClient.removeQueries({
        predicate: (query) => isAppAccessPartitionedQueryKeyV1(query.queryKey),
      });
    };
    window.addEventListener(SCOPE_CHANGED_EVENT, changed);
    return () => window.removeEventListener(SCOPE_CHANGED_EVENT, changed);
  }, [queryClient]);
  const clientScope = useMemo(() => getClientScopeSnapshot(), [scopeRevision]);
  const snapshot = useMemo(() => {
    if (!me.data) return null;
    return buildAppAccessSnapshotV1(me.data, {
      merchantId: clientScope.reportMerchantId || clientScope.operatingMerchantId,
      storeIds: clientScope.reportStoreIds.length ? clientScope.reportStoreIds : [clientScope.operatingStoreId].filter(Boolean),
      capabilities: runtime.selected,
    });
  }, [clientScope, me.data, runtime.selected]);
  const operatingSnapshot = useMemo(() => snapshot
    ? withOperatingScopeAccessSnapshotV1(snapshot, clientScope, me.data?.stores || [])
    : null, [snapshot, clientScope, me.data?.stores]);
  return { ...me, snapshot, operatingSnapshot, runtime };
}
