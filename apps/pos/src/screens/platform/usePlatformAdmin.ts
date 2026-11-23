import { useQuery } from "@tanstack/react-query";
import { fetchMe } from "../../api/settings-endpoints";
import { useAuth } from "../../hooks/useAuth";

export function usePlatformAdmin() {
  const { operator } = useAuth();
  const { data } = useQuery({
    queryKey: ["me", operator?.id],
    queryFn: fetchMe,
    staleTime: 60_000,
    enabled: !!operator?.id,
  });
  const role = operator?.role || "";
  const permissionIds = data?.permissionIds || [];
  const canManageBusiness = data?.canManageMerchantLifecycle === true && !data?.impersonation;
  return {
    operator,
    permissionIds,
    isPlatformAdmin: Boolean(data?.isPlatformAdmin || role === "platform_admin" || role === "admin" || role === "platform"),
    canWritePlatform: permissionIds.includes("platform:write"),
    canManageMerchantLifecycle: canManageBusiness,
    // MCP uses the same fresh platform_admin + platform:write policy; never infer it from a legacy role label.
    canManageMerchantMcp: canManageBusiness,
    canWriteIntegrationConfig: permissionIds.includes("integration_config:write"),
    canReadOperators: permissionIds.includes("platform_operator:read"),
    canResetOperators: permissionIds.includes("platform_operator:reset_password"),
    canSuspendOperators: permissionIds.includes("platform_operator:suspend"),
    canWritePlatformMemberships: permissionIds.includes("platform_membership:write"),
    canStartImpersonation: permissionIds.includes("platform_impersonation:start"),
  };
}
