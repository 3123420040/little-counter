import { useQuery } from "@tanstack/react-query";
import { fetchMe } from "../../api/settings-endpoints";
import { useAuth } from "../../hooks/useAuth";
import { resolveSettingsMerchantId } from "./settings-owner-contract";

export function useSettingsOwner() {
  const { operator } = useAuth();
  const { data } = useQuery({
    queryKey: ["me", operator?.id],
    queryFn: fetchMe,
    staleTime: 60_000,
    enabled: !!operator?.id,
  });
  const role = operator?.role || "";
  const isOwner = role === "owner";
  const canManageTeam = isOwner || role === "manager" || Boolean(data?.permissionIds?.includes("team:read"));
  const isPlatformAdmin = role === "platform_admin" || role === "admin" || role === "platform";
  const merchantId = resolveSettingsMerchantId(data);
  return {
    operator,
    role,
    merchantId,
    isOwner,
    canManageTeam,
    isPlatformAdmin,
    forbidden: !isOwner && !canManageTeam && !isPlatformAdmin,
  };
}
