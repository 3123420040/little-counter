import { useQuery } from "@tanstack/react-query";
import { fetchMe } from "../api/settings-endpoints";

export function usePermission(permissionId: string) {
  const { data } = useQuery({
    queryKey: ["me"],
    queryFn: fetchMe,
    staleTime: 60_000,
  });
  return Boolean(data?.permissionIds?.includes(permissionId));
}
