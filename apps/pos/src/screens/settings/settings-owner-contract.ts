import type { MeResponse } from "../../api/settings-endpoints";

export function resolveSettingsMerchantId(me: Pick<MeResponse, "merchant"> | undefined): string | null {
  return me?.merchant?.merchantId || null;
}
