import { useQuery } from "@tanstack/react-query";
import { fetchLoyaltyTiers } from "../api/endpoints";

export function useLoyaltyTiers() {
  return useQuery({
    queryKey: ["loyaltyTiers"],
    queryFn: fetchLoyaltyTiers,
    staleTime: 300_000,
  });
}
