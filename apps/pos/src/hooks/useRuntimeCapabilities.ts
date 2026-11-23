import { createContext, createElement, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { RuntimeBuildInfoV2 } from "@medusa-snus/contracts/runtime-capabilities";
import { selectPaymentFeeRuntimeBuild } from "../utils/paymentFeeRuntimeBuild";
import {
  selectRuntimeCapabilities,
  type RuntimeCapabilitySelectionV1,
} from "../utils/runtimeCapabilitySelector";

const pendingSelection = selectRuntimeCapabilities({ status: "pending" });
const RuntimeCapabilitiesContext = createContext<RuntimeCapabilitySelectionV1>(pendingSelection);
const PaymentFeeRuntimeContext = createContext<RuntimeBuildInfoV2 | null>(null);

export function RuntimeCapabilitiesProvider({ children }: { children: ReactNode }) {
  const handshake = useQuery({
    queryKey: ["runtimeBuildInfoV1"],
    queryFn: async () => api.get<unknown>("/api/build-info"),
    staleTime: 60_000,
    retry: 1,
  });
  const selection = handshake.isPending
    ? pendingSelection
    : handshake.isError
      ? selectRuntimeCapabilities({ status: "unreachable" })
      : selectRuntimeCapabilities({ status: "received", body: handshake.data });
  const legacy = selection.serverBuild;
  const feeHandshake = useQuery({
    queryKey: ["runtimeBuildInfoV2", legacy?.sourceCommit, legacy?.releaseId, JSON.stringify(legacy?.capabilities)],
    queryFn: async () => api.get<unknown>("/api/build-info/v2"),
    enabled: Boolean(legacy), staleTime: 60_000, retry: false,
  });
  const feeBuild = feeHandshake.isSuccess ? selectPaymentFeeRuntimeBuild(legacy, feeHandshake.data) : null;
  return createElement(
    PaymentFeeRuntimeContext.Provider, { value: feeBuild },
    createElement(RuntimeCapabilitiesContext.Provider, { value: selection }, children),
  );
}

export function useRuntimeCapabilities(): RuntimeCapabilitySelectionV1 {
  return useContext(RuntimeCapabilitiesContext);
}

export function usePaymentFeeRuntimeBuild(): RuntimeBuildInfoV2 | null {
  return useContext(PaymentFeeRuntimeContext);
}
